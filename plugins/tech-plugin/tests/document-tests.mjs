// document and validate: the fact pack (behaviour, labels, redaction), the
// status and freshness rules, check-doc and plain on good and broken sample
// documents, ID stability, sign-off rules (roles, order, check reports tied to
// the exact text, two passes and decisions for critical modules), the
// glossary tool, redaction, the skill and agent definitions, and the guard.
//
//   node --test tests/document-tests.mjs

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildDocSystem, runScript } from './golden-doc.mjs';
import { SECRET_MARKER } from './golden.mjs';
import { PLUGIN, runGuard } from './fixture.mjs';
import { parseYaml } from '../scripts/lib/yaml.mjs';
import { redact, scanText } from '../scripts/lib/redact.mjs';
import { bodyHash, joinDoc, splitDoc } from '../scripts/lib/frontmatter.mjs';
import { bladeLabels } from '../scripts/lib/readers/behaviour.mjs';
import { pluginUpdate, runningVersion } from '../scripts/lib/version.mjs';

const D = buildDocSystem();
const { G, H } = D;
after(() => fs.rmSync(G.W, { recursive: true, force: true }));

const run = (script, args, env) => runScript('document', script, args, env);
const ok = (r) => {
  assert.equal(r.code, 0, r.err || r.out);
  return r.out;
};
const S = (p) => path.join(H, 'sdlc-docs', p);
const json = (r) => JSON.parse(ok(r));

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

describe('needs first', () => {
  test('before the module list is approved, document stops and says why', () => {
    const r = run('doc.mjs', ['status', 'patients', '--home', H]);
    assert.equal(r.code, 1);
    assert.match(r.err, /no approved module list yet: run \/tech-plugin:breakdown first/);
  });
  test('(the breakdown is finished for the rest of the tests)', () => D.finishBreakdown());
  test('an unknown module lists the real ones', () => {
    const r = run('doc.mjs', ['status', 'nope', '--home', H]);
    assert.equal(r.code, 1);
    assert.match(r.err, /unknown module "nope"\. Modules: auth, patients, reports, appointments, payments, partner-sync/);
  });
});

const before = { backend: null, web: null, mobile: null };
describe('the fact pack', () => {
  let p;
  let md;
  test('doc.mjs facts writes _facts.md and _facts.json', () => {
    before.backend = snapshot(G.backend);
    before.web = snapshot(G.web);
    before.mobile = snapshot(G.mobile);
    assert.match(ok(run('doc.mjs', ['facts', 'patients', '--home', H])), /wrote modules\/patients\/_facts\.md: 11 routes, 3 screens, 1 tables/);
    p = JSON.parse(fs.readFileSync(S('modules/patients/_facts.json'), 'utf8'));
    md = fs.readFileSync(S('modules/patients/_facts.md'), 'utf8');
  });
  const route = (k) => p.routes.find((r) => r.key === k);
  test('validation rules, with citations', () => {
    assert.deepEqual(route('POST patients/{id}/report').rules.map((r) => [r.field, r.rule, r.cite]), [['mobile', 'required|digits:10', 'web:app/Http/Controllers/PatientPageController.php:20'], ['name', 'required|max:80', 'web:app/Http/Controllers/PatientPageController.php:21']]);
  });
  test('messages: abort, and a flash message translated from the language file', () => {
    const m = route('POST patients/{id}/report').messages.map((x) => [x.kind, x.status || null, x.text]);
    assert.deepEqual(m, [['error', 404, 'Patient not found'], ['success', null, 'Your report request was sent']]);
  });
  test('what the page asks the backend for', () => assert.deepEqual(route('POST patients/{id}/report').asksBackend.map((x) => [x.method, x.uri, x.route && x.route.key]), [['POST', 'api/reports', 'POST api/reports']]));
  test('screen labels, translated, from the Blade page', () => {
    const s = p.screens.find((x) => x.id === 'patients.index');
    assert.deepEqual(s.labels.map((l) => `${l.kind}:${l.text}`), ['title:Patient list', 'label:Mobile number', 'button:Add patient', 'column:Prakruti', 'column:Name', 'field:Enter 10-digit mobile']);
    assert.ok(s.calls.some((c) => c.uri === 'patients.report' && c.route.key === 'POST patients/{id}/report'));
  });
  test('pages people open are not "unused"; API routes nothing calls are', () => {
    assert.ok(!p.notCalled.includes('web|GET patients'));
    assert.ok(p.notCalled.includes('backend|DELETE api/patients/{patient}'));
  });
  test('a form on a page posts to a route: it is in use, and the pack says which page', () => {
    assert.deepEqual(route('POST patients/export').linkedFrom, ['patients.show']);
    assert.ok(!p.notCalled.includes('web|POST patients/export'));
  });
  test('the status says whether the breakdown is current', () => assert.equal(json(run('doc.mjs', ['status', 'patients', '--home', H])).breakdown.upToDate, true));
  test('a phone number in a code message is redacted', () => {
    assert.ok(!md.includes('9876543210'));
    assert.ok(!JSON.stringify(p).includes('9876543210'));
  });
  test('no secret content', () => assert.ok(!md.includes(SECRET_MARKER)));
  test('writer tier: personal-data alone is standard; money is deep', () => {
    const a = json(run('doc.mjs', ['status', 'patients', '--home', H]));
    assert.deepEqual([a.deep, a.writer, a.checker, a.checkerPasses], [false, 'tech-plugin:doc-writer', 'tech-plugin:doc-checker', 1]);
    const b = json(run('doc.mjs', ['status', 'payments', '--home', H]));
    assert.deepEqual([b.deep, b.writer, b.checker, b.checkerPasses], [true, 'tech-plugin:doc-writer-deep', 'tech-plugin:doc-checker-deep', 2]);
  });
});

// ================================================================ sample documents
const prep = (doc, id = 'patients') => json(run('doc.mjs', ['prepare', id, doc, '--home', H]));
const SPEC_BODY = `# Patients: how it works

> **In short**
> - **What it does:** Doctors see their patients and ask for a pulse report for one patient.
> - **Who uses it:** Doctors.
> - **Key rules:** A report request needs the patient's name; it needs a ten-digit mobile number.
> - **Open questions:** 1

## 1. Who uses it

- Doctors open the patient list after they sign in. [E1]

## 2. What people can do

### Ask for a report

1. The doctor opens the patient list. [E2]
2. The doctor asks for a report for one patient. [E3]

## 3. Screens

| Screen | What it shows | What you can do there | Evidence |
|---|---|---|---|
| Patient list | Each patient's name | Add a patient | [E2] |

## 4. Rules

- A report request needs the patient's name and a ten-digit mobile number. [E4]

## 5. When something goes wrong

| Situation | What the person sees | Evidence |
|---|---|---|
| The patient cannot be found | "Patient not found" | [E5] |

## 6. Open questions

- **Q1** (for PO): Can a doctor change a patient's details from the mobile app?

## Appendix A. Evidence

| ID | Statement | Source | Class |
|---|---|---|---|
| E1 | The patient pages need a signed-in user | \`web:routes/web.php:8\` | Verified |
| E2 | The patient list page and its title | \`web:resources/views/patients/index.blade.php:3\` | Verified |
| E3 | The report request route | \`web:routes/web.php:12\` | Verified |
| E4 | mobile is required with 10 digits; name is required | \`web:app/Http/Controllers/PatientPageController.php:20-21\` | Verified |
| E5 | The not-found message | \`web:app/Http/Controllers/PatientPageController.php:24\` | Verified |

## Appendix B. Technical detail

| Route | Handler | Source |
|---|---|---|
| POST patients/{id}/report | PatientPageController@requestReport | \`web:routes/web.php:12\` |

## Document control

Draft written by /tech-plugin:document.
`;
const BRD_BODY = `# Patients: business requirements

> **In short**
> - **What it does:** Doctors keep a list of patients and ask for reports.
> - **Who uses it:** Doctors.
> - **Key rules:** A report request needs a name and a mobile number.
> - **Open questions:** 2

## 1. Purpose

Doctors keep their patients in one list and ask for a report for any of them. [E1]

## 2. Business objectives

- What should the patient list help the clinic achieve? [Q1]

## 3. People and roles

| Role | What they need from it | Evidence |
|---|---|---|
| Doctor | Find a patient and ask for a report | [E1] |

## 4. Scope

### In scope

- Asking for a report from the patient list. [E2]

### Out of scope

- Removing a patient: the system has it, but no screen uses it. [E3]

## 5. How it works today

1. The doctor opens the patient list and asks for a report. [E2]

## 6. Business rules

- A report request needs the patient's name and mobile number. [E4]

## 7. Business requirements

| ID | Requirement | Evidence |
|---|---|---|
| BR-01 | A doctor can ask for a report for a patient. | [E2] |
| BR-02 | A report request needs a name and a mobile number. | [E4] |

## 8. Dependencies

- The report itself is made by the reports part of the system. [E5]

## 9. Assumptions and constraints

- Only signed-in doctors reach the patient list. [E6]

## 10. Success measures

- How will the owner know the list saves time? [Q2]

## 11. Open questions

- **Q1** (for owner): What should the patient list help the clinic achieve?
- **Q2** (for owner): How will you measure that it saves doctors time?

## Appendix A. Evidence

| ID | Statement | Source | Class |
|---|---|---|---|
| E1 | Purpose of the module | modules.yaml | Verified |
| E2 | Report request | spec E3 | Verified |
| E3 | Delete route with no caller | \`backend:routes/api.php:16\` | Verified |
| E4 | Report request rules | spec E4 | Verified |
| E5 | The page asks the reports API | \`web:app/Http/Controllers/PatientPageController.php:23\` | Verified |
| E6 | Signed-in users only | \`web:routes/web.php:8\` | Verified |

## Document control

Draft written by /tech-plugin:document.
`;
const PRD_BODY = `# Patients: product requirements

> **In short**
> - **What it does:** Doctors see their patients and ask for reports.
> - **Who uses it:** Doctors.
> - **Key rules:** A report request needs a name and a mobile number.
> - **Open questions:** 0

## 1. Overview

Doctors see their patients and ask for a report for one of them. [E1]

## 2. Users and permissions

| Who | What they can do | Evidence |
|---|---|---|
| Signed-in doctor | Open the list and ask for reports | [E2] |

## 3. User journeys

### Ask for a report

1. The doctor opens the patient list and chooses a patient. [E1]

## 4. Requirements

### PATIENTS-R01: Ask for a report

The doctor can ask for a report for a patient from the patient list.

**Business requirement:** BR-01

**Acceptance criteria**

- Given a signed-in doctor, when they ask for a report with a name and mobile number, then they see "Your report request was sent".
- Given a mobile number that is not ten digits, when they ask, then the request is refused.

**Evidence:** [E3] [E4]

## 5. Screens

| Screen | Who sees it | What it is for | Evidence |
|---|---|---|---|
| Patient list | Doctor | Find a patient and ask for a report | [E1] |

## 6. Messages and errors

| Situation | Message shown | Evidence |
|---|---|---|
| The report was asked for | "Your report request was sent" | [E3] |

## 7. Quality needs

- Only signed-in users can reach these pages. [E2]

## 8. Open questions

None.

## Appendix A. Evidence

| ID | Statement | Source | Class |
|---|---|---|---|
| E1 | Patient list page | \`web:resources/views/patients/index.blade.php:3\` | Verified |
| E2 | auth group | \`web:routes/web.php:8\` | Verified |
| E3 | Success message | \`web:app/Http/Controllers/PatientPageController.php:25\` | Verified |
| E4 | Rules | BR-02 | Verified |

## Appendix B. Technical detail

| Requirement | Route | Validation | Source |
|---|---|---|---|
| PATIENTS-R01 | POST patients/{id}/report | mobile required, 10 digits | \`web:app/Http/Controllers/PatientPageController.php:20\` |

## Document control

Draft written by /tech-plugin:document.
`;
const BODIES = { spec: SPEC_BODY, brd: BRD_BODY, prd: PRD_BODY };
function writeDoc(doc, body = BODIES[doc], id = 'patients') {
  const pr = prep(doc, id);
  fs.writeFileSync(pr.out, pr.stamp + '\n' + body);
  return pr;
}
const check = (file) => run('check-doc.mjs', [file, '--home', H]);
const plain = (file) => run('plain.mjs', [file, '--home', H]);

describe('prepare and check-doc on a good spec', () => {
  let pr;
  test('prepare gives the writer everything, and a Draft stamp', () => {
    pr = writeDoc('spec');
    assert.equal(pr.writer, 'tech-plugin:doc-writer');
    assert.ok(pr.out.endsWith('sdlc-docs/modules/patients/spec.md'));
    for (const k of ['factsMd', 'template', 'rules', 'glossary']) assert.ok(fs.existsSync(pr[k]), k);
    const f = parseYaml(pr.stamp.replace(/^---\n|---\n$/g, ''));
    assert.deepEqual([f.module, f.doc, f.status, f.checked], ['patients', 'spec', 'Draft', null]);
    assert.equal(f.commits.web, 'b'.repeat(40));
  });
  test('check-doc passes', () => assert.match(ok(check(pr.out)), /check-doc: PASS/));
  test('plain passes, with a warning for a domain word', () => assert.match(ok(plain(pr.out)), /plain: PASS/));
  test('prd is refused before spec and brd exist', () => {
    const r = run('doc.mjs', ['prepare', 'patients', 'prd', '--home', H]);
    assert.equal(r.code, 1);
    assert.match(r.err, /prd is written from spec and brd, which does not exist yet: write brd first|which does not exist yet/);
  });
});

describe('check-doc catches broken documents', () => {
  const spec = () => S('modules/patients/spec.md');
  const original = () => fs.readFileSync(spec(), 'utf8');
  let keep;
  const mutate = (fn) => {
    keep = keep || original();
    fs.writeFileSync(spec(), fn(keep));
    const r = check(spec());
    fs.writeFileSync(spec(), keep);
    return r;
  };
  const fails = (fn, re) => {
    const r = mutate(fn);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, re);
  };
  test('a missing heading', () => fails((t) => t.replace('## 5. When something goes wrong', '## 5. Errors'), /FAIL  headings match the spec template[\s\S]*missing: ## 5\. When something goes wrong/));
  test('a fact without a tag', () => fails((t) => t.replace('asks for a report for one patient. [E3]', 'asks for a report for one patient.'), /FAIL  every fact in the people layer has an \[E#\] or \[Q#\] tag[\s\S]*The doctor asks for a report/));
  test('a tag with no evidence row', () => fails((t) => t.replace('[E5]', '[E9]'), /E9 is used but not in Appendix A/));
  test('a citation past the end of the file', () => fails((t) => t.replace('web.php:12` | Verified', 'web.php:999` | Verified'), /web:routes\/web\.php:999: the file has \d+ lines/));
  test('a citation of a blank line', () => fails((t) => t.replace('web.php:8` | Verified', 'web.php:2` | Verified'), /web:routes\/web\.php:2: line 2 is blank/));
  test('a citation of a secret file', () => fails((t) => t.replace('`web:routes/web.php:8`', '`backend:storage/oauth-private.pem:1`'), /backend:storage\/oauth-private\.pem:1: cites a secret file/));
  test('a phone number', () => fails((t) => t.replace('Doctors open the patient list', 'Call 9876543210; doctors open the patient list'), /FAIL  no key-like strings and no personal data[\s\S]*phone number \(value not shown\)/));
  test('a key-like string', () => fails((t) => t.replace('Draft written', 'password = hunter2hunter2 Draft written'), /password or secret value/));
  test('a question without a role', () => fails((t) => t.replace('(for PO)', '(for Ramesh)'), /Q1 names no known role/));
  test('"In short" count that does not match', () => fails((t) => t.replace('**Open questions:** 1', '**Open questions:** 3'), /In short says 3, the Open questions section has 1/));
  test('Assumption without a question', () => fails((t) => t.replace('| `web:routes/web.php:12` | Verified |', '| `web:routes/web.php:12` | Assumption |'), /E3 is Assumption: its source must be the question/));
  test('a writer setting Checked itself', () => fails((t) => t.replace('status: Draft', 'status: Checked'), /status Checked has a check record/));
  test('a writer setting Approved itself', () => fails((t) => t.replace('status: Draft', 'status: Approved'), /status Approved has a recorded sign-off/));
  test('any other status', () => fails((t) => t.replace('status: Draft', 'status: Reviewed by me'), /status is Draft or Checked/));
  test('code that changed after writing: the stamp is stale', () => {
    const f = path.join(G.web, 'app/Http/Controllers/PatientPageController.php');
    const t = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, t.replace("'required|digits:10'", "'required|digits:11'"));
    try {
      ok(runScript('breakdown', 'map.mjs', ['--repo', G.web, '--home', H]));
      ok(run('doc.mjs', ['facts', 'patients', '--home', H]));
      const r = check(spec());
      assert.equal(r.code, 1);
      assert.match(r.out, /the code facts changed since this was written/);
      const st = json(run('doc.mjs', ['status', 'patients', '--home', H]));
      assert.equal(st.docs.spec.state, 'facts-changed');
      assert.equal(st.breakdown.upToDate, false);
      assert.match(st.facts.changes.join(), /details changed/);
    } finally {
      fs.writeFileSync(f, t);
      ok(runScript('breakdown', 'map.mjs', ['--repo', G.web, '--home', H]));
      ok(run('doc.mjs', ['facts', 'patients', '--home', H]));
    }
    assert.match(ok(check(spec())), /check-doc: PASS/);
  });
});

describe('plain-language check', () => {
  const spec = () => S('modules/patients/spec.md');
  const tryPlain = (fn) => {
    const keep = fs.readFileSync(spec(), 'utf8');
    fs.writeFileSync(spec(), fn(keep));
    const r = plain(spec());
    fs.writeFileSync(spec(), keep);
    return r;
  };
  for (const [name, from, to, re] of [
    ['a function name', 'The doctor opens the patient list. [E2]', 'The doctor calls requestReport. [E2]', /code name in camelCase \("requestReport"\)/],
    ['a file path', 'The doctor opens the patient list. [E2]', 'The doctor opens resources/views/patients/index.blade.php. [E2]', /a file path/],
    ['a table name', 'The doctor opens the patient list. [E2]', 'The doctor opens patient_master. [E2]', /snake_case/],
    ['an HTTP code', '| The patient cannot be found |', '| HTTP 404 |', /an HTTP status code/],
    ['a method and path', 'The doctor opens the patient list. [E2]', 'The doctor sends POST patients/1/report. [E2]', /HTTP method with a path/],
    ['backticks', 'The doctor opens the patient list. [E2]', 'The doctor opens `patients`. [E2]', /code in backticks/],
    ['words about the tools', 'The doctor opens the patient list. [E2]', 'The scan found the patient list. [E2]', /words about the documentation tools/],
  ]) test(`fails on ${name}`, () => {
    const r = tryPlain((t) => t.replace(from, to));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, re);
  });
  test('quoted text people see is not checked for code', () => assert.equal(tryPlain((t) => t.replace('"Patient not found"', '"Error: user_id missing"')).code, 0));
  test('long sentences and jargon are warnings', () => {
    const r = tryPlain((t) => t.replace('Doctors open the patient list after they sign in. [E1]', 'Doctors open the patient list after they sign in and then they look through every row of it to find the patient they want and then they open the backend page. [E1]'));
    assert.equal(r.code, 0);
    assert.match(r.out, /WARN  sentences of 25 words or fewer/);
    assert.match(r.out, /"backend" on line/);
  });
});

describe('BRD and PRD: IDs and links', () => {
  test('a good BRD and PRD pass', () => {
    const b = writeDoc('brd');
    assert.match(ok(check(b.out)), /check-doc: PASS/);
    assert.match(ok(plain(b.out)), /plain: PASS/);
    const p = writeDoc('prd');
    assert.match(ok(check(p.out)), /2 business requirements BR-nn|1 requirements PATIENTS-Rnn|check-doc: PASS/);
    assert.match(ok(check(p.out)), /check-doc: PASS/);
    assert.match(ok(plain(p.out)), /plain: PASS/);
  });
  test('a requirement without acceptance criteria fails', () => {
    const f = S('modules/patients/prd.md');
    const keep = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, keep.replace(/\*\*Acceptance criteria\*\*[\s\S]*?\*\*Evidence:\*\*/, '**Evidence:**'));
    const r = check(f);
    fs.writeFileSync(f, keep);
    assert.match(r.out, /PATIENTS-R01: needs \*\*Acceptance criteria\*\*/);
  });
  test('a link to a business requirement that does not exist fails', () => {
    const f = S('modules/patients/prd.md');
    const keep = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, keep.replace('**Business requirement:** BR-01', '**Business requirement:** BR-07'));
    const r = check(f);
    fs.writeFileSync(f, keep);
    assert.match(r.out, /BR-07 is not in brd\.md/);
  });
  test('a rewrite that loses an ID fails; marking it Removed passes', () => {
    const pr = prep('prd');
    assert.deepEqual(pr.keepIds, ['PATIENTS-R01']);
    fs.writeFileSync(pr.out, pr.stamp + '\n' + PRD_BODY.replace('### PATIENTS-R01: Ask for a report', '### PATIENTS-R02: Ask for a report'));
    assert.match(check(pr.out).out, /PATIENTS-R01 is gone: keep it, or mark it "Removed \(reason\)"/);
    fs.writeFileSync(pr.out, pr.stamp + '\n' + PRD_BODY);
    assert.match(ok(check(pr.out)), /check-doc: PASS/);
  });
  test('a question asked once in the spec can be pointed at, not copied: [spec Q1]', () => {
    const f = S('modules/patients/brd.md');
    const keep = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, keep.replace('Only signed-in doctors reach the patient list. [E6]', 'Only signed-in doctors reach the patient list. [E6] [spec Q1]'));
    assert.match(ok(check(f)), /check-doc: PASS/);
    fs.writeFileSync(f, keep.replace('Only signed-in doctors reach the patient list. [E6]', 'Only signed-in doctors reach the patient list. [spec Q9]'));
    assert.match(check(f).out, /\[spec Q9\] points at nothing in that document/);
    fs.writeFileSync(f, keep);
  });
  test('a duplicate BR id fails', () => {
    const f = S('modules/patients/brd.md');
    const keep = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, keep.replace('| BR-02 |', '| BR-01 |'));
    const r = check(f);
    fs.writeFileSync(f, keep);
    assert.match(r.out, /BR-01 is defined twice/);
  });
});

describe('freshness: already up to date, inputs that changed', () => {
  test('all three written and current: up to date', () => {
    const st = json(run('doc.mjs', ['status', 'patients', '--home', H]));
    assert.deepEqual(Object.values(st.docs).map((d) => d.state), ['up-to-date', 'up-to-date', 'up-to-date']);
    assert.equal(st.next, 'up-to-date');
    assert.match(st.message, /Already up to date/);
  });
  test('the spec changed after the BRD was written: the BRD and PRD say so', () => {
    const f = S('modules/patients/spec.md');
    const keep = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, keep.replace('Doctors open the patient list after they sign in.', 'Doctors open the patient list once they sign in.'));
    const st = json(run('doc.mjs', ['status', 'patients', '--home', H]));
    assert.deepEqual([st.docs.spec.state, st.docs.brd.state, st.docs.prd.state, st.next], ['up-to-date', 'input-changed', 'input-changed', 'brd']);
    assert.match(check(S('modules/patients/brd.md')).out, /spec\.md changed since this was written/);
    fs.writeFileSync(f, keep);
  });
  test('--force rebuilds anyway', () => assert.equal(json(run('doc.mjs', ['status', 'patients', '--home', H, '--force'])).next, 'spec'));
  test('modules.yaml doc_status follows: draft once documents exist', () => {
    assert.match(ok(run('signoff.mjs', ['sync', 'patients', '--home', H])), /doc_status of patients: draft/);
    assert.equal(parseYaml(fs.readFileSync(S('modules.yaml'), 'utf8')).modules.find((m) => m.id === 'patients').doc_status, 'draft');
  });
});

// ================================================================ Checked (no sign-off)
const report = (txt) => {
  const f = S('_state/report.md');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, txt);
  return f;
};
const CLEAN = '# Doc check\nSummary: 12 claims · 12 verified · 0 mismatch · 0 not provable · 0 risk\n\n## Mismatch\nNone.\n';
const DIRTY = '# Doc check\nSummary: 12 claims · 10 verified · 1 mismatch · 1 not provable · 0 risk\n';
const REVIEW = '# Readability review\nCould not follow: 0\n';
const front = (id, doc) => splitDoc(fs.readFileSync(S(`modules/${id}/${doc}.md`), 'utf8')).front;
const docStatus = (id) => parseYaml(fs.readFileSync(S('modules.yaml'), 'utf8')).modules.find((m) => m.id === id).doc_status;

describe('Checked: standard module', () => {
  test('a Draft until a checker pass and a readability review', () => {
    const s = json(run('signoff.mjs', ['status', 'patients', '--home', H]));
    assert.deepEqual([s.spec.status, s.spec.checked, s.spec.readability, s.spec.lastCheck], ['Draft', null, false, null]);
    assert.match(ok(run('signoff.mjs', ['checklist', 'patients', '--home', H])), /status: spec Draft, brd Draft, prd Draft/);
  });
  test('a pass with mismatches leaves it a Draft; the report is saved with the text it checked', () => {
    assert.match(ok(run('signoff.mjs', ['save-review', 'patients', 'spec', '--input', report(REVIEW), '--home', H])), /0 thing\(s\) a non-technical reader could not follow\nstatus: spec Draft/);
    assert.match(ok(run('signoff.mjs', ['save-check', 'patients', 'spec', '--input', report(DIRTY), '--home', H])), /spec-check-1\.md: 1 mismatch, 1 not provable[\s\S]*status: spec Draft/);
    const head = fs.readFileSync(S('modules/patients/checks/spec-check-1.md'), 'utf8').split('\n')[0];
    assert.match(head, /Checked text:\*\* `[0-9a-f]{16}`/);
  });
  test('a report without the summary line is refused', () => {
    const r = run('signoff.mjs', ['save-check', 'patients', 'spec', '--input', report('looks fine to me'), '--home', H]);
    assert.equal(r.code, 1);
    assert.match(r.err, /no "Summary:/);
  });
  test('a clean pass: Checked, with nobody asked to approve', () => {
    assert.match(ok(run('signoff.mjs', ['save-check', 'patients', 'spec', '--input', report(CLEAN), '--home', H])), /\(clean\)[\s\S]*status: spec Checked, brd Draft, prd Draft/);
    const f = S('modules/patients/spec.md');
    const p = splitDoc(fs.readFileSync(f, 'utf8'));
    assert.deepEqual([p.front.status, p.front.checked.hash, p.front.checked.pass, 'approvals' in p.front], ['Checked', bodyHash(p.body), 2, false]);
    assert.match(ok(check(f)), /PASS  status is Checked/);
  });
  test('the checklist lists status, checks and the open questions, with no approvers', () => {
    ok(run('signoff.mjs', ['checklist', 'patients', '--home', H]));
    const c = fs.readFileSync(S('modules/patients/checks/review-checklist.md'), 'utf8');
    assert.match(c, /\| \[spec\]\(\.\.\/spec\.md\) \| Checked \| pass 2: 0 mismatch, 0 not provable \| done \|\n/);
    assert.match(c, /\| \*\*Q1\*\* Can a doctor change a patient's details from the mobile app\? \| PO \| open \|/);
    assert.match(c, /No sign-off is needed\./);
    assert.doesNotMatch(c, /Owner or PO|developer\)|waiting/);
  });
  test('changing the text after it was checked: a Draft again', () => {
    const f = S('modules/patients/spec.md');
    const keep = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, keep.replace('Doctors open the patient list after they sign in.', 'Doctors open the list after they sign in.'));
    const r = check(f);
    assert.match(r.out, /WARN  changed since it was checked[\s\S]*counts as a Draft until \/tech-plugin:validate checks it again/);
    assert.doesNotMatch(r.out, /FAIL  status/);
    const s = json(run('signoff.mjs', ['status', 'patients', '--home', H]));
    assert.deepEqual([s.spec.status, s.spec.checked], ['Draft', null]);
    assert.match(ok(run('signoff.mjs', ['sync', 'patients', '--home', H])), /doc_status of patients: draft/);
    assert.deepEqual([front('patients', 'spec').status, front('patients', 'spec').checked], ['Draft', null]);
    fs.writeFileSync(f, keep);
  });
  test('doc_status becomes checked when all three documents are Checked', () => {
    for (const doc of ['brd', 'prd']) {
      ok(run('signoff.mjs', ['save-review', 'patients', doc, '--input', report(REVIEW), '--home', H]));
      ok(run('signoff.mjs', ['save-check', 'patients', doc, '--input', report(CLEAN), '--home', H]));
    }
    assert.equal(docStatus('patients'), 'checked');
  });
  test('a document Approved by the old sign-off keeps its status until it changes', () => {
    const f = S('modules/patients/spec.md');
    const keep = fs.readFileSync(f, 'utf8');
    const p = splitDoc(keep);
    const signed = { by: 'Asha Rao', role: 'PO', on: '2026-11-12', hash: bodyHash(p.body) };
    const fr = { ...p.front, status: 'Approved', approvals: { people: signed, technical: { ...signed, by: 'Ravi K', role: 'developer' } } };
    delete fr.checked;
    fs.writeFileSync(f, joinDoc(fr, p.body));
    assert.match(ok(check(f)), /PASS  status is Approved \(signed off before tech-plugin 0\.6\)/);
    assert.match(ok(run('signoff.mjs', ['checklist', 'patients', '--home', H])), /status: spec Approved, brd Checked, prd Checked/);
    assert.equal(front('patients', 'spec').status, 'Approved');
    assert.equal(docStatus('patients'), 'checked');
    fs.writeFileSync(f, joinDoc(fr, p.body.replace('Doctors open the patient list after they sign in.', 'Doctors open the list after they sign in.')));
    assert.match(check(f).out, /WARN  changed since it was approved/);
    assert.equal(json(run('signoff.mjs', ['status', 'patients', '--home', H])).spec.status, 'Draft');
    fs.writeFileSync(f, keep);
    ok(run('signoff.mjs', ['sync', 'patients', '--home', H]));
    assert.equal(front('patients', 'spec').status, 'Checked');
  });
});

describe('Checked: critical module (money)', () => {
  const PAY = SPEC_BODY.replace(/^# Patients/m, '# Payments')
    .replace('`web:routes/web.php:8`', '`backend:routes/api.php:13`')
    .replace('`web:resources/views/patients/index.blade.php:3`', '`backend:routes/api.php:24`')
    .replace(/`web:routes\/web\.php:12`/g, '`backend:routes/api.php:25`')
    .replace('`web:app/Http/Controllers/PatientPageController.php:20-21`', '`backend:app/Http/Controllers/PaymentController.php:13`')
    .replace('`web:app/Http/Controllers/PatientPageController.php:24`', '`backend:app/Http/Controllers/PaymentController.php:14`');
  test('a payments spec passes the checks', () => {
    const pr = writeDoc('spec', PAY, 'payments');
    assert.equal(pr.writer, 'tech-plugin:doc-writer-deep');
    assert.match(ok(check(pr.out)), /check-doc: PASS/);
  });
  test('one clean checker pass is not enough', () => {
    ok(run('signoff.mjs', ['save-review', 'payments', 'spec', '--input', report(REVIEW), '--home', H]));
    assert.match(ok(run('signoff.mjs', ['save-check', 'payments', 'spec', '--input', report(CLEAN), '--home', H, '--checker', 'doc-checker-deep'])), /status: spec Draft/);
  });
  test('two clean passes: Checked, with Q1 still open; nothing waits for an answer', () => {
    assert.match(ok(run('signoff.mjs', ['save-check', 'payments', 'spec', '--input', report(CLEAN), '--home', H])), /status: spec Checked/);
    assert.equal(json(run('signoff.mjs', ['status', 'payments', '--home', H])).spec.openQuestions[0].decision, null);
  });
  test('an answer, when someone gives one, is recorded and carried by the fact pack; the status stays', () => {
    assert.match(ok(run('signoff.mjs', ['decide', 'payments', '--doc', 'spec', '--q', 'Q1', '--answer', 'No, only from the web dashboard', '--by', 'Asha Rao', '--role', 'PO', '--home', H])), /recorded D1/);
    assert.equal(front('payments', 'spec').status, 'Checked');
    ok(run('doc.mjs', ['facts', 'payments', '--home', H]));
    assert.match(fs.readFileSync(S('modules/payments/_facts.md'), 'utf8'), /\*\*D1\*\* \(spec Q1, Asha Rao \(PO\), \d{4}-\d{2}-\d{2}\): No, only from the web dashboard/);
    // an answer is not a code change: the spec is not "facts-changed" and still passes
    assert.equal(json(run('doc.mjs', ['status', 'payments', '--home', H])).docs.spec.state, 'up-to-date');
    assert.match(ok(check(S('modules/payments/spec.md'))), /check-doc: PASS/);
  });
  test('a decision on a question that does not exist is refused', () => {
    const r = run('signoff.mjs', ['decide', 'payments', '--doc', 'spec', '--q', 'Q9', '--answer', 'x', '--by', 'A', '--role', 'PO', '--home', H]);
    assert.equal(r.code, 1);
    assert.match(r.err, /Q9 is not an open question in spec\.md/);
  });
  test('approve is gone', () => {
    const r = run('signoff.mjs', ['approve', 'payments', 'spec', '--layer', 'people', '--by', 'A', '--role', 'PO', '--home', H]);
    assert.equal(r.code, 1);
    assert.match(r.err, /unknown command/);
  });
});

describe('validate rounds: pass limit, focused passes, spec first, known issues, changes, restamp', () => {
  const LEFT = '# Doc check\nSummary: 30 claims · 28 verified · 1 mismatch · 1 not provable · 0 risk\n\n## Mismatch\n| # | Doc line | Claim (short quote) | What the source shows | Source |\n|---|---|---|---|---|\n| 1 | 12 | "only" | too strong | `backend:routes/api.php:13` |\n\n## Not provable\n| # | Doc line | Claim | Why | Suggested fix |\n|---|---|---|---|---|\n| 1 | 20 | "tab title" | not cited | cite it |\n\n## Risk\nNone.\n';
  const RISKY = '# Doc check\nSummary: 30 claims · 29 verified · 0 mismatch · 0 not provable · 1 risk\n';
  const save = (doc, txt, mode = 'full') => run('signoff.mjs', ['save-check', 'payments', doc, '--input', report(txt), '--home', H, '--mode', mode]);
  const st = () => json(run('signoff.mjs', ['status', 'payments', '--home', H]));
  const specF = () => S('modules/payments/spec.md');
  test('the third pass is the last; a fourth is refused and points to known issues', () => {
    assert.match(ok(save('spec', LEFT)), /spec-check-3\.md: 1 mismatch, 1 not provable, 0 risk; no more passes this round/);
    const r = save('spec', CLEAN);
    assert.equal(r.code, 1);
    assert.match(r.err, /already has 3 doc-checker passes this round \(the limit is 3\)[\s\S]*signoff\.mjs known payments spec/);
    assert.equal(st().spec.status, 'Draft');
  });
  test('known issues: the leftovers are recorded with the text, and do not stop Checked', () => {
    assert.match(ok(run('signoff.mjs', ['known', 'payments', 'spec', '--home', H])), /recorded 2 known issue\(s\) in modules\/payments\/checks\/spec-known\.md: 1 mismatch, 1 not provable\nstatus: spec Checked/);
    const k = fs.readFileSync(S('modules/payments/checks/spec-known.md'), 'utf8');
    assert.match(k, /\| 1 \| 12 \| "only" \| too strong \|/);
    assert.match(k, /\| 1 \| 20 \| "tab title" \| not cited \|/);
    assert.equal(st().spec.settled, true);
    assert.equal(front('payments', 'spec').checked.known, 2);
    ok(run('signoff.mjs', ['checklist', 'payments', '--home', H]));
    assert.match(fs.readFileSync(S('modules/payments/checks/review-checklist.md'), 'utf8'), /pass 3: 1 mismatch, 1 not provable; \[2 known issue\(s\)\]\(spec-known\.md\)/);
  });
  test('a clean last pass has nothing to record', () => {
    const r = run('signoff.mjs', ['known', 'patients', 'spec', '--home', H]);
    assert.equal(r.code, 1);
    assert.match(r.err, /the last pass is clean: there is nothing to record/);
  });
  let brd;
  test('the BRD is stamped from the spec; a spec change makes its pass wait for a refresh', () => {
    brd = writeDoc('brd', BRD_BODY.replace(/^# Patients/m, '# Payments'), 'payments');
    fs.writeFileSync(specF(), fs.readFileSync(specF(), 'utf8').replace('Doctors open the patient list after they sign in. [E1]', 'Doctors open the patient list once they sign in. [E1]'));
    const r = save('brd', CLEAN);
    assert.equal(r.code, 1);
    assert.match(r.err, /brd\.md was written from an older spec\.md\. Refresh it first: doc\.mjs changes payments brd/);
    assert.equal(json(run('doc.mjs', ['status', 'payments', '--home', H])).docs.brd.state, 'input-changed');
  });
  test('restamp is refused until the changes were looked at', () => {
    const r = run('doc.mjs', ['restamp', 'payments', 'brd', '--home', H]);
    assert.equal(r.code, 1);
    assert.match(r.err, /run "doc\.mjs changes payments brd" first, and have the writer update the lines of brd\.md that depend on what changed in spec\.md/);
    assert.match(run('doc.mjs', ['restamp', 'payments', 'spec', '--home', H]).err, /written from the code only/);
  });
  test('changes: the spec lines that changed since the BRD was stamped, with their IDs', () => {
    const c = json(run('doc.mjs', ['changes', 'payments', 'brd', '--home', H]));
    assert.equal(c.sinceCheck, null);
    assert.deepEqual([c.inputs.spec.changed, c.inputs.spec.hunks, c.inputs.spec.ids], [true, 1, ['E1']]);
    const md = fs.readFileSync(c.file, 'utf8');
    const line = fs.readFileSync(specF(), 'utf8').split('\n').indexOf('- Doctors open the patient list once they sign in. [E1]') + 1;
    assert.match(md, new RegExp(`### spec lines ${line} \\(was ${line}\\) · E1`));
    assert.match(md, /Before:\n\n```text\n- Doctors open the patient list after they sign in\. \[E1\]\n```\n\nAfter:\n\n```text\n- Doctors open the patient list once they sign in\. \[E1\]/);
  });
  test('restamp records the current spec without touching the BRD text', () => {
    const before = bodyHash(splitDoc(fs.readFileSync(brd.out, 'utf8')).body);
    assert.match(json(run('doc.mjs', ['restamp', 'payments', 'brd', '--home', H])).message, /brd\.md is now stamped from the current spec\.md/);
    assert.equal(bodyHash(splitDoc(fs.readFileSync(brd.out, 'utf8')).body), before);
    assert.equal(json(run('doc.mjs', ['status', 'payments', '--home', H])).docs.brd.state, 'up-to-date');
    assert.doesNotMatch(check(brd.out).out, /spec\.md changed since this was written/);
    assert.equal(json(run('doc.mjs', ['restamp', 'payments', 'brd', '--home', H])).restamped, false);
  });
  test('spec first: the BRD waits while the changed spec is unchecked', () => {
    const r = save('brd', CLEAN);
    assert.equal(r.code, 1);
    assert.match(r.err, /finish spec\.md first/);
  });
  test('a settled document that changes gets one focused pass, even past the limit', () => {
    assert.match(save('spec', CLEAN).err, /had settled; a change after that gets one focused pass/);
    const c = json(run('doc.mjs', ['changes', 'payments', 'spec', '--home', H]));
    assert.equal(c.sinceCheck.hunks, 1);
    assert.match(ok(save('spec', CLEAN, 'focused')), /spec-check-4\.md: 0 mismatch, 0 not provable, 0 risk \(clean\)/);
    assert.match(fs.readFileSync(S('modules/payments/checks/spec-check-4.md'), 'utf8').split('\n')[0], /\*\*Pass:\*\* 4 · \*\*Mode:\*\* focused/);
    assert.equal(st().spec.settled, true);
    assert.equal(save('spec', CLEAN, 'focused').code, 1);
  });
  test('the first pass of a round reads everything; later ones may be focused on the changes', () => {
    assert.match(save('brd', CLEAN, 'focused').err, /the first pass of a round reads the whole document/);
    assert.match(ok(save('brd', LEFT)), /brd-check-1\.md: 1 mismatch, 1 not provable, 0 risk; 2 more pass\(es\) allowed this round/);
    fs.writeFileSync(brd.out, fs.readFileSync(brd.out, 'utf8').replace('Only signed-in doctors reach the patient list. [E6]', 'Only doctors who signed in reach the patient list. [E6]'));
    const c = json(run('doc.mjs', ['changes', 'payments', 'brd', '--home', H]));
    const line = fs.readFileSync(brd.out, 'utf8').split('\n').indexOf('- Only doctors who signed in reach the patient list. [E6]') + 1;
    assert.deepEqual([c.sinceCheck.pass, c.sinceCheck.lines], [1, [[line, line]]]);
    assert.equal(c.inputs.spec.changed, false);
    ok(save('brd', CLEAN, 'focused'));
    assert.deepEqual([st().brd.round.passes, st().brd.round.full, st().brd.settled], [2, 1, true]);
  });
  test('a risk item is never accepted as a known issue', () => {
    const p = writeDoc('prd', PRD_BODY.replace(/^# Patients/m, '# Payments'), 'payments');
    assert.ok(p.out.endsWith('payments/prd.md'));
    ok(save('prd', RISKY));
    ok(save('prd', LEFT));
    ok(save('prd', RISKY));
    const r = run('signoff.mjs', ['known', 'payments', 'prd', '--home', H]);
    assert.equal(r.code, 1);
    assert.match(r.err, /risk item\(s\) \(a key or personal data\): those are never accepted/);
  });
  test('a rewrite starts a new round, hands the writer the known issues, and needs a new readability review', () => {
    ok(run('signoff.mjs', ['save-review', 'payments', 'spec', '--input', report(REVIEW), '--home', H]));
    assert.equal(st().spec.readability, true);
    const pr = prep('spec', 'payments');
    assert.equal(pr.knownIssues, S('modules/payments/checks/spec-known.md'));
    const s = st().spec;
    assert.deepEqual([s.round.passes, s.round.limit, s.readability, s.settled], [0, 3, false, false]);
  });
});

describe('a newer plugin installed than the session runs', () => {
  const fakeHome = (v) => {
    const h = path.join(G.W, `home-${v}`);
    fs.mkdirSync(path.join(h, '.claude', 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(h, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'tech-plugin@tech-ai-plugins': [{ scope: 'user', version: v }] } }));
    return h;
  };
  const cur = runningVersion(PLUGIN);
  test('same or older installed: nothing to say', () => {
    assert.equal(pluginUpdate(PLUGIN, fakeHome(cur)), null);
    assert.equal(pluginUpdate(PLUGIN, fakeHome('0.0.1')), null);
    assert.equal(pluginUpdate(PLUGIN, path.join(G.W, 'no-home')), null);
  });
  test('newer installed: breakdown, document and prepare stop and ask for a new session', () => {
    const h = fakeHome('99.0.0');
    assert.match(pluginUpdate(PLUGIN, h).message, new RegExp(`tech-plugin v99\\.0\\.0 is installed, but this session still runs v${cur.replace(/\./g, '\\.')}\\. Quit Claude Code and start a new session`));
    const b = JSON.parse(ok(runScript('breakdown', 'state.mjs', ['status', '--cwd', H], { HOME: h })));
    assert.equal(b.next, 'restart');
    assert.equal(json(run('doc.mjs', ['status', 'patients', '--home', H], { HOME: h })).next, 'restart');
    const p = run('doc.mjs', ['prepare', 'patients', 'spec', '--home', H], { HOME: h });
    assert.equal(p.code, 1);
    assert.match(p.err, /start a new session/);
  });
});

describe('Blade labels from real-world markup', () => {
  test('entities decoded, directives with nested brackets and leftover code dropped', () => {
    const html = "<button>&times;</button><button>Save &amp; close</button><th>@foreach(array_keys($allRules['all_rules'][0]) as $key)</th><th>{{ $key }}</th><h2>Plan&nbsp;details</h2><label>{{ __('k') }}</label>";
    assert.deepEqual(bladeLabels(html, new Map([['k', 'Mobile number']])).map((l) => `${l.kind}:${l.text}`), ['heading:Plan details', 'label:Mobile number', 'button:Save & close']);
  });
});

describe('glossary and redaction', () => {
  test('glossary.mjs adds a term once, never twice', () => {
    assert.match(ok(run('glossary.mjs', ['add', '--home', H, '--term', 'Prakruti', '--source', 'web:resources/views/patients/index.blade.php:6'])), /added "Prakruti"/);
    assert.match(ok(run('glossary.mjs', ['add', '--home', H, '--term', 'prakruti'])), /already in glossary/);
    assert.match(fs.readFileSync(S('glossary.md'), 'utf8'), /\| Prakruti \| To be confirmed \| web:resources\/views\/patients\/index\.blade\.php:6 \|/);
  });
  test('scanText finds keys and personal data, never repeats them, and ignores examples and commit ids', () => {
    const t = 'AKIAABCDEFGHIJKLMNOP\nmail me at ravi.k@gmail.com\nuse admin@example.com\n9876543210\n1234 5678 9012 \nABCPE1234F\n' + 'a'.repeat(40);
    const r = scanText(t);
    assert.deepEqual(r.map((x) => `${x.line}:${x.type}`), ['1:AWS access key', '2:email address', '4:phone number', '6:PAN-like number']);
    assert.ok(!JSON.stringify(r).includes('ravi'));
    assert.equal(redact('call 9876543210 now'), 'call [REDACTED phone number] now');
  });
  test('the stamp round-trips and the body hash ignores it', () => {
    const t = joinDoc({ module: 'x', status: 'Draft' }, '# Hi\n\ntext\n');
    const p = splitDoc(t);
    assert.deepEqual(p.front, { module: 'x', status: 'Draft' });
    assert.equal(bodyHash(p.body), bodyHash(splitDoc(joinDoc({ module: 'x', status: 'Approved' }, '# Hi\n\ntext\n')).body));
  });
});

describe('skills, agents and the guard', () => {
  const read = (f) => fs.readFileSync(path.join(PLUGIN, f), 'utf8');
  test('document and validate: manual-only, Haiku, low effort, short; details in references', () => {
    for (const s of ['document', 'validate']) {
      const t = read(`skills/${s}/SKILL.md`);
      assert.match(t, /^disable-model-invocation: true$/m);
      assert.match(t, /^model: haiku$/m);
      assert.match(t, /^effort: low$/m);
      assert.ok(t.split('\n').length < 60, s);
    }
    for (const f of ['writing-rules.md', 'spec-template.md', 'brd-template.md', 'prd-template.md', 'jargon.txt', 'document-flow.md', 'validate-flow.md']) assert.ok(fs.existsSync(path.join(PLUGIN, 'references/document', f)), f);
  });
  test('writers: Sonnet medium, Opus high for critical; they never set the status', () => {
    for (const [f, model, effort] of [['doc-writer', 'sonnet', 'medium'], ['doc-writer-deep', 'opus', 'high']]) {
      const t = read(`agents/${f}.md`);
      assert.match(t, new RegExp(`^model: ${model}$`, 'm'));
      assert.match(t, new RegExp(`^effort: ${effort}$`, 'm'));
      assert.match(t, /Never change `status`, `checked` or `approvals` in the stamp/);
    }
  });
  test('validate asks nobody to sign off', () => {
    const t = read('skills/validate/SKILL.md') + read('references/document/validate-flow.md');
    assert.doesNotMatch(t, /signoff\.mjs" approve|--layer|Reviewed|explicit yes/);
    assert.match(read('skills/validate/SKILL.md'), /Never ask anyone to approve a document/);
  });
  test('checker and readability reviewer are read-only', () => {
    for (const [f, model, tools] of [['doc-checker', 'sonnet', 'Read, Grep, Glob'], ['doc-checker-deep', 'opus', 'Read, Grep, Glob'], ['readability-reviewer', 'sonnet', 'Read']]) {
      const t = read(`agents/${f}.md`);
      assert.match(t, new RegExp(`^model: ${model}$`, 'm'));
      assert.match(t, new RegExp(`^tools: ${tools}$`, 'm'));
    }
    assert.match(read('agents/doc-checker.md'), /Summary: N claims · V verified · M mismatch · P not provable · S risk/);
    for (const f of ['doc-checker', 'doc-checker-deep']) assert.match(read(`agents/${f}.md`), /\*\*Focused pass\*\*[\s\S]*Do not re-check other lines/);
    for (const f of ['doc-writer', 'doc-writer-deep']) assert.match(read(`agents/${f}.md`), /For a refresh:[\s\S]*A code value's meaning/);
    assert.match(read('agents/readability-reviewer.md'), /Could not follow: N/);
  });
  test('doctor lists the new commands', () => {
    const r = spawnSync(process.execPath, [path.join(PLUGIN, 'scripts/doctor.mjs'), '--dir', G.W], { encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN }, timeout: 60000 });
    for (const c of ['document', 'validate']) assert.match(r.stdout, new RegExp(`\`/tech-plugin:${c}\``));
  });
  const env = { HOME: path.join(G.W, 'home') };
  test('the document scripts run in a repo on main; the writer may write only inside sdlc-docs', () => {
    for (const c of [`node "$CLAUDE_PLUGIN_ROOT/scripts/document/doc.mjs" status patients --home "${H}"`, `node "$CLAUDE_PLUGIN_ROOT/scripts/document/check-doc.mjs" "${S('modules/patients/spec.md')}" --home "${H}"`, `node "$CLAUDE_PLUGIN_ROOT/scripts/document/signoff.mjs" checklist patients --home "${H}"`]) assert.equal(runGuard({ tool_name: 'Bash', cwd: H, tool_input: { command: c } }, { env }).decision, 'pass', c);
    const w = (p) => runGuard({ tool_name: 'Write', cwd: H, tool_input: { file_path: p, content: 'x' } }, { env }).decision;
    assert.equal(w(S('modules/patients/spec.md')), 'pass');
    assert.equal(w(path.join(H, 'app/Http/Controllers/PatientController.php')), 'block:repo-write');
  });
  test('nothing outside sdlc-docs changed; no secret anywhere in sdlc-docs', () => {
    assert.deepEqual(snapshot(G.backend), before.backend);
    assert.deepEqual(snapshot(G.web), before.web);
    assert.deepEqual(snapshot(G.mobile), before.mobile);
    const all = (d) => fs.readdirSync(d, { recursive: true }).filter((f) => fs.statSync(path.join(d, f)).isFile()).map((f) => fs.readFileSync(path.join(d, f), 'utf8')).join('');
    assert.ok(!all(path.join(H, 'sdlc-docs')).includes(SECRET_MARKER));
  });
});
