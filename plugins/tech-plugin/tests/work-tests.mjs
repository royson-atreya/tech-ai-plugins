// impact, requirement and design: work items (IDs, the request, status.json),
// module candidates, the impact pack and report, the checks of each
// document, freshness, decisions and approvals, the decisions index, the
// skill and agent definitions, and the guard.
//
//   node --test tests/work-tests.mjs

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildDocSystem, runScript } from './golden-doc.mjs';
import { PLUGIN, runGuard } from './fixture.mjs';
import { joinDoc, splitDoc } from '../scripts/lib/frontmatter.mjs';

const D = buildDocSystem();
const { G, H } = D;
after(() => fs.rmSync(G.W, { recursive: true, force: true }));

const S = (p) => path.join(H, 'sdlc-docs', p);
const read = (p) => fs.readFileSync(S(p), 'utf8');
const put = (f, t) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, t);
};
const wk = (args) => runScript('work', 'work.mjs', [...args, '--home', H]);
const im = (args) => runScript('work', 'impact.mjs', [...args, '--home', H]);
const ok = (r) => {
  assert.equal(r.code, 0, r.err || r.out);
  return r.out;
};
const json = (r) => JSON.parse(ok(r));
const check = (f, part) => runScript('work', 'check-work.mjs', [f, '--home', H, ...(part ? ['--part', part] : [])]);
const plain = (f) => runScript('document', 'plain.mjs', [f, '--home', H]);
const request = (text) => {
  const f = S('_state/request-in.md');
  put(f, text);
  return f;
};
// writes a document: the stamp from the prepare JSON, then the body
const writeWith = (pr, body) => fs.writeFileSync(pr.out, `${pr.stamp}\n${body}`);
// changes a document's body, keeping its stamp
const edit = (f, fn) => {
  const p = splitDoc(fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(f, joinDoc(p.front, fn(p.body)));
};
const withFile = (f, change, fn) => {
  const keep = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, change(keep));
  try {
    return fn();
  } finally {
    fs.writeFileSync(f, keep);
  }
};
const fails = (r, re) => {
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, re);
};

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'sdlc-docs') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

const IMPACT = `# Download pulse report from patient page: impact

> **In short**
> - **The change:** Doctors download a patient's pulse report from the patient page.
> - **Who notices:** Doctors.
> - **Risk:** High
> - **Size:** M
> - **Level:** Standard
> - **Open questions:** 1

## 1. What is asked

Doctors want to download a pulse report from the patient page. [E1]

## 2. Parts of the product it touches

| Part of the product | How | What changes for it | Evidence |
|---|---|---|---|
| Pulse reports | changed | Reports can be downloaded from another page | [E2] |
| Patients | changed | The patient page gets a download button | [E3] |

## 3. Who notices the change

- Doctors: they see a new button on the patient page. [E3]

## 4. Risk

High: pulse reports carry health findings. [E2]
The website already asks for reports in the background. [E4]

## 5. Size

Medium: one button and one behind-the-scenes step.

## 6. Proposed level

Standard: a feature on two existing parts of the product.

## 7. Open questions

- **Q1** (for PO): Should patients see the button too?

## Appendix A. Evidence

| ID | Statement | Source | Class |
|---|---|---|---|
| E1 | The request | request.md | Verified |
| E2 | The report file route | \`backend:routes/api.php:19\` | Verified |
| E3 | The patient page | \`web:resources/views/patients/show.blade.php:1\` | Verified |
| E4 | The website asks for reports | \`web:app/Http/Controllers/PatientPageController.php:23\` | Verified |

## Appendix B. Technical detail

- backend GET api/reports/{report}/pdf \`backend:routes/api.php:19\`, called from no screen today.

## Document control

Draft.
`;

const REQ_TOP = `# Download pulse report: requirements

> **In short**
> - **What it adds:** A download button for pulse reports on the patient page.
> - **Who uses it:** Doctors.
> - **Requirements:** 2
> - **Stories:** STORIES
> - **Open questions:** 1

## 1. The request

Doctors want to download a pulse report from the patient page. [E1]

## 2. What is unclear

- Whether patients may download it too. [Q1]

## 3. Requirements

### W-001-R01: Download the report

The patient page offers the latest pulse report as a file to save.

**Changes:** CHANGES

**Acceptance criteria**

- Given a patient with a report, when the doctor presses "Download report", then the report is saved.

**Source:** [E1]

### W-001-R02: No report yet

The patient page says when a patient has no report.

**Changes:** new

**Acceptance criteria**

- Given a patient without a report, when the doctor opens the patient page, then the button says "No report yet".

**Source:** [E1]

## 4. User stories

`;
const STORIES = `### W-001-S01: Download from the patient page

As a doctor, I want to download the pulse report from the patient page, so that I can give it to the patient.

**Covers:** W-001-R01, W-001-R02

**Acceptance criteria**

- Given a patient with a report, when the doctor presses "Download report", then the report is saved.
`;
const REQ_END = `
## 5. Out of scope

- Sending the report by message. [E1]

## 6. Open questions

- **Q1** (for PO): May patients download the report too?

## Appendix A. Evidence

| ID | Statement | Source | Class |
|---|---|---|---|
| E1 | The request | request.md | Verified |

## Document control

Draft.
`;
const requirement = ({ stories = STORIES, n = 1, changes = 'new' } = {}) => REQ_TOP.replace('STORIES', String(n)).replace('CHANGES', changes) + (stories || 'Written after the open questions are answered.\n') + REQ_END;

const DESIGN = `# Download pulse report: design

> **In short**
> - **Approach:** A download button on the patient page passes on the report file the system already makes.
> - **Changes:** one screen, one behind-the-scenes step, no stored data
> - **Decisions:** 1
> - **Open questions:** 0

## 1. Approach

The patient page gets a "Download report" button. The website fetches the latest report file and passes it on.

## 2. Screen changes

SCREENS

## 3. Open questions

None.

## Appendix A. Evidence

| ID | Statement | Source | Class |
|---|---|---|---|
| E1 | The report file route | \`backend:routes/api.php:19\` | Verified |

## Appendix B. Decisions

### W-001-D01: Where the file comes from

**Context:** The server already makes report files. [E1]

**Options:**

- Reuse the server's file: no new code on the server.
OPTION2
**Decision:** Reuse the server's file.

**Consequences:** The website needs one new route that passes the file on.

## Appendix C. API changes

APIS

## Appendix D. Data changes

None.

## Appendix E. Requirement coverage

COVERAGE

## Document control

Draft.
`;
const SCREENS = '```mermaid\nflowchart LR\n  a["Patient page"] --> b["Download report"]\n```';
const COVER = '| Requirement | Covered by |\n|---|---|\n| W-001-R01 | Section 2; Appendix C |\n| W-001-R02 | Section 2 |';
const design = ({ screens = SCREENS, apis = '- web GET patients/{id}/report: new; calls `backend:routes/api.php:19`.', cover = COVER, option2 = '- Build the file in the website: more code, two copies of the layout.\n' } = {}) =>
  DESIGN.replace('SCREENS', screens).replace('APIS', apis).replace('COVERAGE', cover).replace('OPTION2', option2);

// ================================================================ needs first
describe('needs first', () => {
  test('before the breakdown is approved, a work item cannot start', () => {
    const r = wk(['new', '--request-file', request('# A title\n\nSomething.\n')]);
    assert.equal(r.code, 1);
    assert.match(r.err, /run \/tech-plugin:breakdown first/);
  });
  test('(the breakdown is finished for the rest of the tests)', () => D.finishBreakdown());
});

const before = {};
describe('work items', () => {
  test('(snapshot of the repos)', () => {
    for (const r of [G.backend, G.web, G.mobile]) before[r] = snapshot(r);
  });
  test('a new item from a request file: the next W- ID, request.md, status.json; the file is deleted', () => {
    const f = request("# Download pulse report from patient page\n\nDoctors want to download a patient's pulse report as a PDF from the patient page.\n");
    const r = json(wk(['new', '--request-file', f]));
    assert.deepEqual([r.id, r.title, r.next, r.level], ['W-001', 'Download pulse report from patient page', 'impact', null]);
    assert.ok(!fs.existsSync(f));
    assert.match(read('work/W-001/request.md'), /^# Download pulse report from patient page\n\n> \*\*Work item:\*\* W-001 · \*\*From:\*\* a person · \*\*Date:\*\* \d{4}-\d\d-\d\d\n\nDoctors want/);
    assert.equal(JSON.parse(read('work/W-001/status.json')).next, 'impact');
  });
  test('a Zoho Sprints item keeps its own ID', () => {
    const r = json(wk(['new', '--request-file', request('# Export the patient list\n\nThe clinic wants the patient list as a spreadsheet.\n'), '--id', 'NT-I42', '--source', 'zoho']));
    assert.equal(r.id, 'NT-I42');
    assert.match(read('work/NT-I42/request.md'), /\*\*From:\*\* Zoho Sprints/);
  });
  test('refused: a bad or taken ID, no title, personal data in the request (file deleted, value not shown)', () => {
    for (const [args, re] of [
      [['--id', '../x'], /not a valid work item ID/],
      [['--id', 'NT-I42'], /already exists/],
    ]) {
      const r = wk(['new', '--request-file', request('# T\n\nx\n'), ...args]);
      assert.equal(r.code, 1);
      assert.match(r.err, re);
    }
    let r = wk(['new', '--request-file', request('No title here\n')]);
    assert.match(r.err, /starts with "# <title>"/);
    const f = request('# Call back\n\nCall the patient on 9876543210 about the report.\n');
    r = wk(['new', '--request-file', f]);
    assert.equal(r.code, 1);
    assert.match(r.err, /phone number \(line 3\)/);
    assert.ok(!r.err.includes('9876543210') && !fs.existsSync(f));
    assert.ok(!fs.existsSync(S('work/W-002')));
  });
  test('list: every item with its next step', () => {
    assert.deepEqual(json(wk(['list'])).items.map((x) => [x.id, x.next]), [['NT-I42', 'impact'], ['W-001', 'impact']]);
  });
});

// ================================================================ impact
describe('impact', () => {
  let pk;
  test('candidates: modules ranked by the words they share with the request', () => {
    const c = json(im(['candidates', 'W-001']));
    assert.deepEqual(c.likely.slice(0, 2).map((x) => x.id), ['reports', 'patients']);
    assert.deepEqual(c.likely[0].matched.name, ['pulse', 'report']);
    assert.ok(c.likely[0].matched.purpose.includes('pdf'));
    assert.equal(c.all.length, 6);
    // a word every module shares counts less than a rare one
    assert.ok(c.likely[0].score > c.likely[1].score);
  });
  test('pack: refused for an unknown module', () => {
    const r = im(['pack', 'W-001', '--modules', 'reports,billing']);
    assert.equal(r.code, 1);
    assert.match(r.err, /not a module of this system: billing/);
  });
  test('pack: routes, screens, tables, other apps that call them, risk, documents and the code graph', () => {
    pk = json(im(['pack', 'W-001', '--modules', 'reports,patients']));
    assert.deepEqual(pk.counts, { routes: 14, screens: 3, tables: 2, callers: 4, asks: 3, neighbours: 4 });
    assert.equal(pk.out, S('work/W-001/impact.md'));
    const st = splitDoc(pk.stamp + '\n').front;
    assert.deepEqual([st.work, st.doc, st.status, st.modules, Object.keys(st.facts), Object.keys(st.inputs), st.approval], ['W-001', 'impact', 'Draft', ['reports', 'patients'], ['reports', 'patients'], ['request'], null]);
    const md = fs.readFileSync(pk.pack, 'utf8');
    assert.match(md, /- Risk flags: clinical \(health findings shown to doctors\) · critical module/);
    assert.match(md, /- web \(module patients\) calls backend\|POST api\/reports `web:app\/Http\/Controllers\/PatientPageController\.php:23`/);
    assert.match(md, /- mobile calls backend\|GET api\/patients\/\{patient\} `mobile:lib\/services\/api_service\.dart:9`/);
    assert.match(md, /- Documents: none written yet/);
    assert.match(md, /### What its routes ask other servers for \(3\)\n\n[^#]*- web POST patients\/\{id\}\/report → POST api\/reports \(app backend\) `web:app\/Http\/Controllers\/PatientPageController\.php:23`/);
    assert.match(md, /## Code the graph groups with it \(Inferred\)\n\n- auth: /);
    assert.deepEqual(JSON.parse(read('work/W-001/status.json')).modules, ['reports', 'patients']);
  });
  test('a written impact passes both checks', () => {
    writeWith(pk, IMPACT);
    ok(check(pk.out));
    ok(plain(pk.out));
  });
  test('the checks fail: a risk outside the scale, an untagged statement, an unknown tag, a bad citation, a phone number, an approved impact', () => {
    const f = pk.out;
    const cases = [
      [(b) => b.replace('**Risk:** High', '**Risk:** Huge'), /Risk is "Huge": write one of Low, Medium, High, Critical/],
      [(b) => b.replace('High: pulse reports carry health findings. [E2]', 'High: pulse reports carry health findings.'), /every statement about the product today has an \[E#\] or \[Q#\] tag\n {8}line \d+: High: pulse reports/],
      [(b) => b.replace('patient page. [E3]', 'patient page. [E9]'), /E9 is used but not in Appendix A/],
      [(b) => b.replace('`backend:routes/api.php:19` | Verified', '`backend:routes/api.php:999` | Verified'), /backend:routes\/api\.php:999: the file has \d+ lines/],
      [(b) => b.replace('Draft.', 'Call 9876543210 today.'), /no key-like strings and no personal data\n {8}line \d+: phone number/],
      [(b) => b.replace('**Open questions:** 1', '**Open questions:** 2'), /In short says Open questions 2, the document has 1/],
    ];
    for (const [fn, re] of cases) withFile(f, (t) => t.replace(/\n# [\s\S]*$/, (body) => fn(body)), () => fails(check(f), re));
    withFile(f, (t) => t.replace('status: Draft', 'status: Approved'), () => fails(check(f), /an impact is never approved/));
  });
  test('the report: the people part open, the evidence in a fold, HTML in the document escaped', () => {
    withFile(pk.out, (t) => t.replace('## 5. Size', '<script>alert(1)</script>\n\n## 5. Size'), () => {
      const r = json(im(['report', 'W-001']));
      const h = fs.readFileSync(r.report, 'utf8');
      assert.match(h, /<p class="status">Work item W-001 · Draft · written \d{4}-\d\d-\d\d<\/p>/);
      assert.match(h, /<details class="dev"><summary>For developers: evidence and technical detail<\/summary>\n<h2 id="appendix-a-evidence">/);
      assert.ok(h.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !h.includes('<script>alert'));
    });
  });
  test('status: the level comes from the impact; next, the requirements', () => {
    const s = json(wk(['status', 'W-001']));
    assert.deepEqual([s.level, s.next, s.states.impact.risk, s.states.impact.state], ['Standard', 'requirement', 'High', 'up-to-date']);
    assert.match(s.message, /^W-001 "Download pulse report from patient page": impact: Draft · requirement: not written · design: not written\. Next: \/tech-plugin:requirement W-001\.$/);
  });
  test('stale when the request or the code of a module changes', () => {
    withFile(S('work/W-001/request.md'), (t) => t + 'Also on the phone app.\n', () => assert.deepEqual(json(wk(['status', 'W-001'])).states.impact.reasons, ['the request changed']));
    withFile(pk.out, (t) => t.replace(/reports: [0-9a-f]{16}/, 'reports: 0000000000000000'), () => {
      assert.deepEqual(json(wk(['status', 'W-001'])).states.impact.reasons, ['the code of reports changed']);
      fails(check(pk.out), /written from the current request, documents and code\n {8}the code of reports changed/);
    });
  });
});

// ================================================================ requirement
describe('requirement', () => {
  let pr;
  test('prepare: modules from the impact; the impact is an input; the first-part check', () => {
    pr = json(wk(['prepare', 'W-001', 'requirement']));
    assert.deepEqual(pr.warn, []);
    assert.deepEqual(Object.keys(pr.modules), ['reports', 'patients']);
    assert.ok(pr.inputs.impact && pr.inputs.request);
    assert.equal(splitDoc(pr.stamp + '\n').front.inputs.impact, json(wk(['status', 'W-001'])).states.impact.hash);
    assert.equal(pr.idPrefix, 'W-001-');
    assert.match(pr.firstPartCheck, /check-work\.mjs" ".*requirement\.md" --home ".*" --part requirements$/);
  });
  test('without an impact: name the modules, and a warning', () => {
    let r = wk(['prepare', 'NT-I42', 'requirement']);
    assert.equal(r.code, 1);
    assert.match(r.err, /no modules for NT-I42 yet: run \/tech-plugin:impact NT-I42, or name them/);
    r = json(wk(['prepare', 'NT-I42', 'requirement', '--modules', 'patients']));
    assert.match(r.warn[0], /there is no impact analysis yet/);
  });
  test('before the stories: the first-part check passes, the full one does not', () => {
    writeWith(pr, requirement({ stories: null, n: 0 }));
    ok(check(pr.out, 'requirements'));
    fails(check(pr.out), /no "### W-001-S01: …" headings/);
  });
  test('with the stories: both checks pass', () => {
    writeWith(pr, requirement());
    ok(check(pr.out));
    ok(plain(pr.out));
  });
  test('the checks fail: a requirement no story covers, a story covering nothing known, a changed module requirement that does not exist', () => {
    const f = pr.out;
    withFile(f, (t) => t.replace('**Covers:** W-001-R01, W-001-R02', '**Covers:** W-001-R01'), () => fails(check(f), /W-001-R02 is covered by no story/));
    withFile(f, (t) => t.replace('**Covers:** W-001-R01, W-001-R02', '**Covers:** W-001-R01, W-001-R02, W-001-R07'), () => fails(check(f), /W-001-S01: covers W-001-R07, which is not a requirement here/));
    withFile(f, (t) => t.replace('As a doctor, I want', 'Doctors want'), () => fails(check(f), /write it as "As a <role>, I want <something>, so that <a reason>\."/));
    withFile(f, (t) => t.replace('**Changes:** new', '**Changes:** BILLING-R01'), () => fails(check(f), /W-001-R01: BILLING-R01: there is no module "billing"/));
    withFile(f, (t) => t.replace('**Changes:** new', '**Changes:** PATIENTS-R04'), () => {
      const r = check(f);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /WARN  module requirements checked\n {8}W-001-R01: PATIENTS-R04: patients has no PRD yet/);
    });
    withFile(f, (t) => t.replace('- Whether patients may download it too. [Q1]', '- Whether patients may download it too.'), () => fails(check(f), /every gap points at the question that settles it/));
  });
  test('approval: only the owner, PO or BA; not while a question is open', () => {
    let r = wk(['approve', 'W-001', 'requirement', '--by', 'Ravi', '--role', 'developer']);
    assert.match(r.err, /the requirement is approved by the owner, PO or BA, not "developer"/);
    r = wk(['approve', 'W-001', 'requirement', '--by', 'Asha', '--role', 'PO']);
    assert.match(r.err, /open questions without an answer: Q1 \(for PO\)/);
  });
  test('an answer is recorded from a file, as a decision', () => {
    const f = S('_state/answer-in.md');
    put(f, 'No: only doctors download reports for now.\n');
    const r = json(wk(['decide', 'W-001', '--doc', 'requirement', '--q', 'Q1', '--answer-file', f, '--by', 'Asha', '--role', 'PO']));
    assert.deepEqual(r, { id: 'D1', open: [] });
    assert.ok(!fs.existsSync(f));
    assert.match(read('work/W-001/decisions.md'), /\| D1 \| requirement \| Q1 \| May patients download the report too\? \| No: only doctors download reports for now\. \| Asha \(PO\) \| \d{4}-\d\d-\d\d \|/);
  });
  test('approved by the PO: Approved, for this text; next, the design', () => {
    const r = json(wk(['approve', 'W-001', 'requirement', '--by', 'Asha', '--role', 'PO']));
    assert.deepEqual([r.status, r.next], ['Approved', 'design']);
    const f = splitDoc(read('work/W-001/requirement.md')).front;
    assert.deepEqual([f.status, f.approval.by, f.approval.role], ['Approved', 'Asha', 'PO']);
    ok(check(pr.out));
    assert.equal(JSON.parse(read('work/W-001/status.json')).docs.requirement.approvedBy, 'Asha (PO)');
  });
  test('changed after approval: no longer approved, and the check says so', () => {
    withFile(pr.out, (t) => t.replace('as a file to save', 'as a file to keep'), () => {
      const s = json(wk(['status', 'W-001'])).states.requirement;
      assert.deepEqual([s.approved, s.changedSinceApproval], [null, true]);
      fails(check(pr.out), /changed since it was approved/);
      assert.equal(json(wk(['status', 'W-001'])).next, 'approve-requirement');
    });
  });
  test('an ID of the previous version may not be lost', () => {
    const keep = fs.readFileSync(pr.out, 'utf8');
    const p2 = json(wk(['prepare', 'W-001', 'requirement']));
    assert.deepEqual(p2.keepIds, ['W-001-R01', 'W-001-R02', 'W-001-S01']);
    writeWith(p2, requirement().replace(/### W-001-R02[\s\S]*?(?=## 4)/, '').replace('**Requirements:** 2', '**Requirements:** 1').replace('W-001-R01, W-001-R02', 'W-001-R01'));
    fails(check(p2.out), /W-001-R02 is gone: keep it, or mark it "Removed \(reason\)"/);
    fs.writeFileSync(pr.out, keep);
    fs.rmSync(S('_state/work/W-001/requirement.prev.md'));
  });
  test('the impact changes after the requirements: they are out of date', () => {
    withFile(S('work/W-001/impact.md'), (t) => t.replace('Medium: one button', 'Medium: just one button'), () => {
      assert.deepEqual(json(wk(['status', 'W-001'])).states.requirement.reasons, ['impact.md changed since it was written']);
    });
  });
});

// ================================================================ design
describe('design', () => {
  let pd;
  test('needs the requirements first', () => {
    const r = wk(['prepare', 'NT-I42', 'design']);
    assert.match(r.err, /write the requirements first: \/tech-plugin:requirement NT-I42/);
  });
  test('a Quick item needs no design', () => {
    const s = json(wk(['level', 'W-001', 'Quick', '--by', 'Asha']));
    assert.deepEqual([s.level, s.next], ['Quick', 'task']);
    const r = json(wk(['prepare', 'W-001', 'design']));
    assert.equal(r.quick, true);
    assert.match(r.message, /W-001 is a Quick change: it needs no design/);
    assert.equal(json(wk(['level', 'W-001', 'Standard', '--by', 'Asha'])).next, 'design');
  });
  test('prepare: the requirements and the impact are inputs', () => {
    pd = json(wk(['prepare', 'W-001', 'design']));
    assert.deepEqual(pd.warn, []);
    assert.deepEqual(Object.keys(splitDoc(pd.stamp + '\n').front.inputs), ['request', 'impact', 'requirement']);
    assert.match(pd.firstPartCheck, /--part architecture$/);
  });
  test('approach and decisions first: the architecture check passes, the full one does not', () => {
    writeWith(pd, design({ screens: 'Written next.', apis: 'Written next.', cover: 'Written next.' }));
    ok(check(pd.out, 'architecture'));
    fails(check(pd.out), /W-001-R01 is not in the coverage table/);
  });
  test('the full design passes both checks; Mermaid labels are read for code', () => {
    writeWith(pd, design());
    ok(check(pd.out));
    ok(plain(pd.out));
    withFile(pd.out, (t) => t.replace('b["Download report"]', 'b["PatientPageController@report"]'), () => fails(plain(pd.out), /diagram label "PatientPageController@report": a class or method name/));
  });
  test('the checks fail: one option only, a requirement not covered, an unknown requirement', () => {
    const f = pd.out;
    withFile(f, (t) => t.replace('- Build the file in the website: more code, two copies of the layout.\n', ''), () => fails(check(f), /W-001-D01: list at least two options/));
    withFile(f, (t) => t.replace('| W-001-R02 | Section 2 |', '| W-001-R02 |  |'), () => fails(check(f), /W-001-R02: say where the design covers it/));
    withFile(f, (t) => t.replace('| W-001-R02 | Section 2 |', '| W-001-R02 | Section 2 |\n| W-001-R09 | Section 2 |'), () => fails(check(f), /W-001-R09 is not a requirement of W-001/));
  });
  test('approved by a developer, not the PO; the decision becomes Accepted in the index', () => {
    let r = wk(['approve', 'W-001', 'design', '--by', 'Asha', '--role', 'PO']);
    assert.match(r.err, /the design is approved by a developer or tech lead, not "PO"/);
    r = json(wk(['approve', 'W-001', 'design', '--by', 'Ravi', '--role', 'tech lead']));
    assert.deepEqual([r.status, r.next], ['Approved', 'task']);
    assert.match(read('decisions/README.md'), /\| W-001-D01 \| Where the file comes from \| Accepted \| \[W-001\]\(\.\.\/work\/W-001\/design\.md\) \|/);
  });
  test('the requirements change after the design: it is out of date', () => {
    withFile(S('work/W-001/requirement.md'), (t) => t.replace('as a file to save', 'as a file to keep'), () => {
      const s = json(wk(['status', 'W-001']));
      assert.deepEqual(s.states.design.reasons, ['requirement.md changed since it was written']);
      assert.equal(s.next, 'approve-requirement');
    });
  });
});

// ================================================================ definitions and guard
describe('skills, agents and the guard', () => {
  const file = (f) => fs.readFileSync(path.join(PLUGIN, f), 'utf8');
  test('impact, requirement, design: manual-only, Haiku, low effort, short; details in references', () => {
    for (const s of ['impact', 'requirement', 'design']) {
      const t = file(`skills/${s}/SKILL.md`);
      assert.match(t, /^disable-model-invocation: true$/m);
      assert.match(t, /^model: haiku$/m);
      assert.match(t, /^effort: low$/m);
      assert.match(t, /^allowed-tools: Bash\(node:\*\), Read, Write, Agent$/m);
      assert.ok(t.split('\n').length < 40, s);
      assert.ok(fs.existsSync(path.join(PLUGIN, `references/work/${s}-flow.md`)), s);
      assert.ok(fs.existsSync(path.join(PLUGIN, `references/work/${s}-template.md`)), s);
    }
    assert.match(file('skills/impact/SKILL.md'), /Zoho Sprints is read only/);
    for (const s of ['requirement', 'design']) assert.match(file(`skills/${s}/SKILL.md`), /Never approve on their behalf/);
  });
  test('agents: Opus for judgment, Sonnet for writing (PLAN.md routing)', () => {
    for (const [a, model, effort] of [['impact-analyst', 'opus', 'high'], ['requirement-analyst', 'opus', 'high'], ['story-writer', 'sonnet', 'medium'], ['design-architect', 'opus', 'high'], ['design-writer', 'sonnet', 'medium']]) {
      const t = file(`agents/${a}.md`);
      assert.match(t, new RegExp(`^name: ${a}$`, 'm'));
      assert.match(t, new RegExp(`^model: ${model}$`, 'm'), a);
      assert.match(t, new RegExp(`^effort: ${effort}$`, 'm'), a);
    }
    assert.match(file('agents/story-writer.md'), /^tools: Read, Bash, Edit$/m);
  });
  test('doctor lists the new commands', () => {
    const r = spawnSync(process.execPath, [path.join(PLUGIN, 'scripts/doctor.mjs'), '--dir', G.W], { encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN }, timeout: 60000 });
    for (const c of ['impact', 'requirement', 'design']) assert.match(r.stdout, new RegExp(`\`/tech-plugin:${c}\``));
  });
  const env = { HOME: path.join(G.W, 'home') };
  test('the scripts run in a repo on main; agents write work documents, never an APPROVED file', () => {
    for (const c of [`node "$CLAUDE_PLUGIN_ROOT/scripts/work/work.mjs" status W-001 --home "${H}"`, `node "$CLAUDE_PLUGIN_ROOT/scripts/work/impact.mjs" candidates W-001 --home "${H}"`, `node "$CLAUDE_PLUGIN_ROOT/scripts/work/check-work.mjs" "${S('work/W-001/design.md')}" --home "${H}"`]) assert.equal(runGuard({ tool_name: 'Bash', cwd: H, tool_input: { command: c } }, { env }).decision, 'pass', c);
    const w = (p) => runGuard({ tool_name: 'Write', cwd: H, tool_input: { file_path: p, content: 'x' } }, { env }).decision;
    assert.equal(w(S('work/W-001/impact.md')), 'pass');
    assert.equal(w(S('_state/request-in.md')), 'pass');
    assert.equal(w(S('work/W-001/APPROVED')), 'block:self-protection');
    assert.equal(w(path.join(H, 'app/Http/Controllers/PatientController.php')), 'block:repo-write');
  });
  test('nothing outside sdlc-docs changed; no APPROVED or .active file was written', () => {
    for (const r of [G.backend, G.web, G.mobile]) assert.deepEqual(snapshot(r), before[r]);
    const all = fs.readdirSync(S('work'), { recursive: true }).map(String);
    assert.ok(!all.some((f) => /(^|\/)(APPROVED|\.active)$/.test(f)), all.join(', '));
  });
});
