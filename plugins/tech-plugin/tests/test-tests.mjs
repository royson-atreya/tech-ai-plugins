// Tests for build step 9: /tech-plugin:test-cases and /tech-plugin:test-run
// (scripts/test/tests.mjs and the test steps of work items), on the
// Laravel + Flutter fixtures with real commits: a module's regression suite,
// a bug from its handoff to "tested", the gate for repo tests against the
// real guard, defects, the report and traceability, and regression cases
// moving into a module's suite.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildDocSystem, runScript } from './golden-doc.mjs';
import { SECRET_MARKER } from './golden.mjs';
import { PLUGIN, runGuard } from './fixture.mjs';
import { parseYaml, toYaml } from '../scripts/lib/yaml.mjs';
import { splitDoc } from '../scripts/lib/frontmatter.mjs';

const D = buildDocSystem();
const { G, H } = D;
after(() => fs.rmSync(G.W, { recursive: true, force: true }));

const gitT = (dir, ...args) => spawnSync('git', ['-C', dir, '-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', ...args], { encoding: 'utf8' });
for (const [dir, branch] of [[G.backend, 'main'], [G.web, 'main'], [G.mobile, 'develop']]) {
  fs.rmSync(path.join(dir, '.git', 'refs', 'heads', branch), { force: true });
  gitT(dir, 'add', '-A');
  gitT(dir, 'commit', '-qm', 'base', '--allow-empty');
}
D.finishBreakdown();
// environments: one to test against, one production
{
  const f = path.join(H, 'sdlc-docs', 'system.yaml');
  const y = parseYaml(fs.readFileSync(f, 'utf8'));
  y.business.environments = [{ name: 'staging', url: 'https://staging.example.invalid', production: false }, { name: 'live', url: 'https://app.example.invalid', production: true }];
  fs.writeFileSync(f, toYaml(y));
}

const S = (p) => path.join(H, 'sdlc-docs', p);
const read = (p) => fs.readFileSync(S(p), 'utf8');
const ok = (r) => {
  assert.equal(r.code, 0, r.err || r.out);
  return r.out;
};
const json = (r) => JSON.parse(ok(r));
const T = (args, env) => runScript('test', 'tests.mjs', [...args, '--home', H], env);
const W = (args) => runScript('work', 'work.mjs', [...args, '--home', H]);
const B = (args) => runScript('work', 'build.mjs', [...args, '--home', H]);
const put = (p, t) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, t);
  return p;
};
const env = { HOME: path.join(G.W, 'home') };
const guardWrite = (p) => runGuard({ tool_name: 'Write', cwd: G.web, tool_input: { file_path: p, content: 'x' } }, { env }).decision;

const box = (n, sanity, reg, cov) => `> **In short**\n> - **Cases:** ${n}\n> - **Covers:** ${cov} requirements\n> - **Sanity:** ${sanity}\n> - **Regression:** ${reg}\n> - **Open questions:** 0\n`;
const casesDocText = (stamp, title, cases, { sanity, regression, covers, n = null }) => `${stamp}
# ${title}: test cases

${box(n ?? cases.length, sanity, regression, covers)}
## 1. What is tested

The cases go through the patient list and one patient's page.

## 2. Test data

A test doctor and the patient Test One, mobile 9000000001.

## 3. Open questions

None.

## Appendix A. Evidence

| ID | Statement | Source | Class |
|---|---|---|---|

## Appendix B. Test cases

${cases.join('\n')}
## Document control

Draft, written by /tech-plugin:test-cases.
`;

// ================================================================ a module's suite
const PRD = `# Patients: product requirements\n\n## 4. Requirements\n\n### PATIENTS-R01: See the patient list\n\nText.\n\n### PATIENTS-R02: See one patient\n\nText.\n`;
let mstamp;
const mcases = [
  `### TC-PATIENTS-01: The patient list answers\n\n**Covers:** PATIENTS-R01\n**Type:** api\n**Tags:** sanity, regression\n**Request:** \`GET /api/patients\`\n**Steps:**\n\n1. Sign in as the test doctor.\n2. Ask for the list.\n\n**Expected:** status 200 and a list.\n`,
  `### TC-PATIENTS-02: One patient's page\n\n**Covers:** PATIENTS-R02\n**Type:** ui\n**Tags:** regression\n**Steps:**\n\n1. Open the list.\n2. Open Test One.\n\n**Expected:** the page shows Test One.\n`,
  `### TC-PATIENTS-03: The page prints\n\n**Covers:** PATIENTS-R02\n**Type:** manual\n**Tags:** none\n**Steps:**\n\n1. Print the page.\n\n**Expected:** one clean page.\n`,
  `### TC-PATIENTS-04: The list loads fast\n\n**Covers:** PATIENTS-R01\n**Type:** perf\n**Tags:** none\n**Repo:** backend\n**Command:** \`k6 run perf/patients.js\`\n**Expected:** 95% under 500 ms.\n`,
];
const mfile = () => S('modules/patients/tests/test-cases.md');
const writeM = (cases = mcases, counts = { sanity: 1, regression: 2, covers: 2 }) => put(mfile(), casesDocText(mstamp, 'Patients', cases, counts));

describe('test-cases for a module', () => {
  test('a module\'s cases come from its PRD', () => {
    const r = T(['prepare', 'patients']);
    assert.equal(r.code, 1);
    assert.match(r.err, /a module's cases come from its PRD: write it first with \/tech-plugin:document patients/);
  });
  test('prepare: requirements, routes, test environments (never production), the case prefix', () => {
    put(S('modules/patients/prd.md'), PRD);
    const p = json(T(['prepare', 'patients']));
    assert.deepEqual(p.requirements.map((r) => r.id), ['PATIENTS-R01', 'PATIENTS-R02']);
    assert.deepEqual(p.environments, ['staging']);
    assert.equal(p.idPrefix, 'TC-PATIENTS-');
    assert.ok(p.routes.some((r) => r.method === 'GET' && r.uri === 'api/patients'));
    assert.equal(p.template, path.join(PLUGIN, 'references', 'test', 'test-cases-template.md'));
    mstamp = p.stamp;
  });
  test('good cases pass the checks, made-up mobile numbers included', () => {
    writeM();
    assert.match(ok(T(['check', mfile()])), /check-tests: PASS/);
    assert.match(ok(runScript('document', 'plain.mjs', [mfile(), '--home', H])), /plain: PASS/);
  });
  const fails = (cases, re, counts) => {
    writeM(cases, counts);
    const r = T(['check', mfile()]);
    writeM();
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, re);
  };
  test('a requirement without a case', () => fails(mcases.filter((c) => !c.includes('PATIENTS-R02')), /PATIENTS-R02 has no case/, { sanity: 1, regression: 1, covers: 2 }));
  test('an API case on a route that does not exist', () => fails(mcases.map((c) => c.replace('GET /api/patients`', 'GET /api/nope`')), /GET \/api\/nope is not a route of this system/));
  test('a real-looking phone number', () => fails(mcases.map((c) => c.replace('Open Test One.', 'Call 9876543210.')), /phone number \(value not shown\)/));
  test('an install in a command', () => fails(mcases.map((c) => c.replace('`k6 run perf/patients.js`', '`npm install k6 && k6 run x.js`')), /the command installs packages/));
  test('a framework test command the guard blocks', () => fails([...mcases, '### TC-PATIENTS-05: Unit\n\n**Covers:** PATIENTS-R01\n**Type:** automated\n**Tags:** none\n**Repo:** backend\n**Command:** `php artisan test`\n**Expected:** passes.\n'], /the guard allows "php artisan" only with route:list, list, about; run the tests with vendor\/bin\/phpunit or vendor\/bin\/pest/));
  test('an unknown type, a count that does not match', () => {
    fails(mcases.map((c) => c.replace('**Type:** manual', '**Type:** visual')), /\*\*Type:\*\* is one of automated, api, ui, manual, perf, mobile/);
    fails(mcases, /In short says Cases 9, the document has 4/, { sanity: 1, regression: 2, covers: 2, n: 9 });
  });
});

describe('test-run for a module', () => {
  let run;
  test('production is refused; an unknown environment too', () => {
    assert.match(T(['select', 'patients', '--env', 'live']).err, /live is production: tests never run there\. Use staging/);
    assert.match(T(['select', 'patients', '--env', 'qa']).err, /no environment "qa" in system\.yaml \(staging, live\)/);
  });
  test('no environment: API and UI cases are skipped, with the reason; k6 missing skips perf', () => {
    const s = json(T(['select', 'patients'], { PATH: '/usr/bin:/bin' }));
    assert.deepEqual(s.counts, { automated: 0, api: 0, ui: 0, manual: 1, skipped: 3 });
    assert.deepEqual(s.skipped.map((x) => `${x.id}: ${x.why}`), ['TC-PATIENTS-01: no environment given (--env)', 'TC-PATIENTS-02: no environment given (--env)', 'TC-PATIENTS-04: k6 is not installed']);
  });
  test('--sanity picks only the sanity cases', () => {
    const s = json(T(['select', 'patients', '--sanity', '--env', 'staging']));
    assert.deepEqual([s.counts.api, s.counts.ui, s.counts.manual, s.filter], [1, 0, 0, 'sanity']);
  });
  test('a full run on staging; the runners\' files are read, keys hidden, bad files reported', () => {
    run = json(T(['select', 'patients', '--env', 'staging'], { PATH: '/usr/bin:/bin' }));
    assert.equal(run.env.url, 'https://staging.example.invalid');
    put(path.join(run.resultsDir, 'TC-PATIENTS-01.md'), `RESULT: fail\ncurl -sS https://staging.example.invalid/api/patients\n500\npassword = hunter2hunter2hunter2 ${SECRET_MARKER}\n`);
    put(path.join(run.resultsDir, 'TC-PATIENTS-02.md'), 'RESULT: pass\nThe page shows Test One.\n');
    put(path.join(run.resultsDir, 'TC-PATIENTS-99.md'), 'RESULT: pass\n');
    put(path.join(run.resultsDir, 'TC-PATIENTS-03.md'), 'looks fine\n');
    const g = json(T(['ingest', 'patients', run.run, '--dir', run.resultsDir]));
    assert.deepEqual(g.recorded, ['TC-PATIENTS-01 fail', 'TC-PATIENTS-02 pass']);
    assert.deepEqual(g.problems, ['TC-PATIENTS-03.md: the first line is not "RESULT: pass|fail|skip|blocked"', `TC-PATIENTS-99.md: not a case of ${run.run}`]);
    assert.deepEqual(g.left, ['TC-PATIENTS-03']);
    assert.ok(!read(`modules/patients/tests/runs/${run.run}/TC-PATIENTS-01.md`).includes('hunter2hunter2hunter2'));
    ok(T(['record', 'patients', run.run, 'TC-PATIENTS-03', '--result', 'pass', '--input', put(S('_state/m.md'), 'The person printed it: one clean page.')]));
  });
  test('defects: from failed cases only, never with personal data; IDs given by the script', () => {
    const inF = () => S('_state/defects-in.md');
    put(inF(), '### The list fails\n\n**Severity:** blocking\n**Case:** TC-PATIENTS-02\n**Requirement:** PATIENTS-R01\n**Steps:**\n\n1. Ask.\n\n**Expected:** 200\n**Actual:** 500\n');
    assert.match(T(['defects', 'patients', run.run, '--input', inF()]).err, new RegExp(`names cases that failed in ${run.run}`));
    put(inF(), '### The list fails\n\n**Severity:** blocking\n**Case:** TC-PATIENTS-01\n**Requirement:** PATIENTS-R01\n**Steps:**\n\n1. Ask.\n\n**Expected:** 200\n**Actual:** 500 for doctor 9876543210\n');
    assert.match(T(['defects', 'patients', run.run, '--input', inF()]).err, /not saved: the defects hold phone number/);
    put(inF(), '### The list fails\n\n**Severity:** blocking\n**Case:** TC-PATIENTS-01\n**Requirement:** PATIENTS-R01\n**Steps:**\n\n1. Ask for the list.\n\n**Expected:** status 200\n**Actual:** status 500\n**Likely cause:** the list query (Inferred)\n');
    assert.deepEqual(json(T(['defects', 'patients', run.run, '--input', inF()])).added, ['DEF-PATIENTS-01']);
    assert.match(read('modules/patients/tests/defects.md'), new RegExp(`### DEF-PATIENTS-01: The list fails\\n\\n\\*\\*Status:\\*\\* open\\n\\*\\*Found in:\\*\\* ${run.run} on staging`));
  });
  test('the report: Failed, the requirement failing, the defect open; traceability complete', () => {
    const r = json(T(['report', 'patients', run.run]));
    assert.deepEqual([r.verdict, r.passed, r.failed, r.skipped, r.openDefects, r.blockingDefects, r.rtmComplete], ['Failed', 2, 1, 1, 1, 1, true]);
    const rep = read('modules/patients/tests/test-report.md');
    assert.match(rep, /> - \*\*Result:\*\* Failed/);
    assert.match(rep, /\| PATIENTS-R01: See the patient list \| TC-PATIENTS-01 fail<br>TC-PATIENTS-04 skip \| failing \| DEF-PATIENTS-01 \(open\) \|/);
    assert.match(rep, /- TC-PATIENTS-04 \(perf\): skip: k6 is not installed/);
    assert.match(read('modules/patients/tests/rtm.md'), /Complete: every requirement has a case, and every case a result\./);
  });
  test('the next run passes: the defect is fixed by it', () => {
    const r2 = json(T(['select', 'patients', '--env', 'staging'], { PATH: '/usr/bin:/bin' }));
    for (const c of ['TC-PATIENTS-01', 'TC-PATIENTS-02', 'TC-PATIENTS-03']) put(path.join(r2.resultsDir, `${c}.md`), 'RESULT: pass\n');
    ok(T(['ingest', 'patients', r2.run, '--dir', r2.resultsDir]));
    const r = json(T(['report', 'patients', r2.run]));
    assert.deepEqual([r.verdict, r.fixedNow, r.openDefects], ['Passed', ['DEF-PATIENTS-01'], 0]);
    assert.match(read('modules/patients/tests/defects.md'), /### DEF-PATIENTS-01: The list fails\n\n\*\*Status:\*\* fixed/);
  });
  test('JUnit results the person ran are matched by each case\'s **Test:**', () => {
    writeM([...mcases, `### TC-PATIENTS-05: The list query\n\n**Covers:** PATIENTS-R01\n**Type:** automated\n**Tags:** regression\n**Repo:** backend\n**Command:** \`vendor/bin/phpunit --filter=PatientListTest\`\n**Test:** PatientListTest\n**Expected:** passes.\n`], { sanity: 1, regression: 3, covers: 2 });
    ok(T(['check', mfile()]));
    const r = json(T(['select', 'patients', '--env', 'staging'], { PATH: '/usr/bin:/bin' }));
    assert.equal(r.counts.automated, 1);
    const xml = put(path.join(G.W, 'junit.xml'), '<testsuite><testcase classname="Tests\\Feature\\PatientListTest" name="test_list"><failure>expected 200</failure></testcase><testcase classname="Other" name="x"/></testsuite>');
    const j = json(T(['junit', 'patients', r.run, '--file', xml]));
    assert.deepEqual([j.testcases, j.recorded], [2, ['TC-PATIENTS-05 fail']]);
    writeM();
  });
});

// ================================================================ a bug, after its handoff
let BUG;
function bugThroughHandoff() {
  const rf = put(S('_state/request-in.md'), '# The export button does nothing\n\nOn a patient page the export button does nothing.\n');
  BUG = json(W(['new', '--request-file', rf, '--kind', 'bug'])).id;
  const p = json(B(['prepare', BUG, '--modules', 'patients']));
  const body = `# The export button does nothing: plan\n\n> **In short**\n> - **What changes:** The export button works again.\n> - **Steps:** 1\n> - **Repos:** web\n> - **Risk:** Low\n> - **Open questions:** 0\n\n## 1. What will change\n\nThe export button works again.\n\n## 2. Cause of the bug\n\nTo show it:\n\n1. Open a patient's page.\n2. Press export: nothing happens.\n\nThe button sends the request to a step that is gone. [E1]\n\n## 3. Risks and how to undo it\n\nRevert the commit.\n\n## 4. Open questions\n\nNone.\n\n## Appendix A. Evidence\n\n| ID | Statement | Source | Class |\n|---|---|---|---|\n| E1 | The page controller | \`web:app/Http/Controllers/PatientPageController.php:10\` | Verified |\n\n## Appendix B. Steps\n\n### ${BUG}-T01: A test and the fix\n\n**Covers:** the bug\n\n**Files:**\n\n- \`web:tests/Feature/ExportTest.php\` (new)\n- \`web:app/Http/Controllers/PatientPageController.php\` (change)\n\n**Do:** Add the test, then the export action.\n\n**Check:** \`vendor/bin/phpunit tests/Feature/ExportTest.php\`\n\n## Document control\n\nDraft.\n`;
  put(S(`work/${BUG}/plan.md`), `${p.stamp}\n${body}`);
  ok(runScript('work', 'check-work.mjs', [S(`work/${BUG}/plan.md`), '--home', H]));
  const a = json(B(['approval', BUG, '--activate']));
  put(path.join(G.web, `sdlc-docs/work/${BUG}/APPROVED`), `plan ${a.plan}\nby Asha\n`);
  gitT(G.web, 'switch', '-qc', 'feature/export');
  ok(B(['record', BUG, `${BUG}-T01`, '--result', 'pass', '--tier', 'standard', '--input', put(S('_state/r.md'), 'RESULT: pass')]));
  put(path.join(G.web, 'tests/Feature/ExportTest.php'), '<?php\n');
  fs.appendFileSync(path.join(G.web, 'app/Http/Controllers/PatientPageController.php'), '// export\n');
  json(B(['changes', BUG]));
  for (const k of ['code', 'security']) json(B(['save-review', BUG, '--kind', k, '--input', put(S('_state/rv.md'), 'Summary: 0 findings · 0 blocking\n')]));
  json(B(['handoff', BUG]));
}

describe('a bug: from its handoff to tested', () => {
  let bstamp;
  const bcase = (id) => `### TC-${id}-01: Export starts\n\n**Covers:** the bug\n**Type:** automated\n**Tags:** sanity, regression\n**Repo:** web\n**Command:** \`vendor/bin/phpunit tests/Feature/ExportTest.php\`\n**Test:** ExportTest\n**Expected:** the test passes.\n`;
  test('after the handoff, the next step is its test cases', () => {
    bugThroughHandoff();
    assert.equal(json(W(['status', BUG])).next, 'test-cases');
    const n = json(runScript('', 'next.mjs', ['--cwd', H]));
    assert.equal(n.command, `/tech-plugin:test-cases ${BUG}`);
  });
  test('a bug\'s cases cover "the bug"', () => {
    const p = json(T(['prepare', BUG]));
    assert.deepEqual(p.requirements, [{ id: 'the bug', title: 'The bug no longer happens' }]);
    bstamp = p.stamp;
    put(S(`work/${BUG}/tests/test-cases.md`), casesDocText(bstamp, 'The export button does nothing', [bcase(BUG)], { sanity: 1, regression: 1, covers: 1 }));
    assert.match(ok(T(['check', S(`work/${BUG}/tests/test-cases.md`)])), /check-tests: PASS/);
    assert.equal(json(W(['status', BUG])).next, 'test-run');
  });
  test('the gate for repo tests: closed after the handoff, opened again only with the approval on the feature branch', () => {
    assert.equal(guardWrite(path.join(G.web, 'app/x.php')), 'block:repo-write');
    gitT(G.web, 'switch', '-q', 'main');
    const g0 = json(T(['gate', BUG, '--open']));
    assert.equal(g0.open, false);
    assert.match(g0.blockers.join(), /web: on protected branch main/);
    gitT(G.web, 'switch', '-q', 'feature/export');
    const g = json(T(['gate', BUG, '--open']));
    assert.equal(g.open, true, g.message);
    assert.equal(runGuard({ tool_name: 'Bash', cwd: G.web, tool_input: { command: 'vendor/bin/phpunit tests/Feature/ExportTest.php' } }, { env }).decision, 'pass');
    assert.deepEqual(json(T(['gate', BUG, '--close'])).closed, ['web']);
    assert.equal(guardWrite(path.join(G.web, 'app/x.php')), 'block:repo-write');
    assert.ok(fs.existsSync(path.join(G.web, `sdlc-docs/work/${BUG}/APPROVED`)), 'APPROVED is never touched');
  });
  test('a failing run: a defect, and the next step is fixing it as a bug work item', () => {
    const r = json(T(['select', BUG]));
    put(path.join(r.resultsDir, `TC-${BUG}-01.md`), 'RESULT: fail\n1 failed\n');
    ok(T(['ingest', BUG, r.run, '--dir', r.resultsDir]));
    put(S('_state/defects-in.md'), `### Export still does nothing\n\n**Severity:** blocking\n**Case:** TC-${BUG}-01\n**Requirement:** the bug\n**Steps:**\n\n1. Run the test.\n\n**Expected:** passes\n**Actual:** fails\n`);
    ok(T(['defects', BUG, r.run, '--input', S('_state/defects-in.md')]));
    assert.equal(json(T(['report', BUG, r.run])).verdict, 'Failed');
    assert.equal(json(W(['status', BUG])).next, 'fix-defects');
    const n = json(runScript('', 'next.mjs', ['--cwd', H]));
    assert.deepEqual([n.next, n.command], ['fix-defects', `/tech-plugin:task DEF-${BUG}-01`]);
  });
  test('the defect becomes a linked bug work item', () => {
    const q = json(T(['defect', `DEF-${BUG}-01`, '--request']));
    assert.match(fs.readFileSync(q.request, 'utf8'), new RegExp(`^# Export still does nothing\\n\\nDefect DEF-${BUG}-01 of ${BUG}\\.`));
    const fix = json(W(['new', '--request-file', q.request, '--kind', 'bug'])).id;
    assert.equal(json(T(['defect', `DEF-${BUG}-01`, '--status', 'in-fix', '--work', fix])).work, fix);
    const n = json(runScript('', 'next.mjs', ['--cwd', H]));
    assert.notEqual(n.command, `/tech-plugin:task DEF-${BUG}-01`);
    fs.rmSync(S(`work/${fix}`), { recursive: true });
  });
  test('once it passes: tested', () => {
    const r = json(T(['select', BUG]));
    put(path.join(r.resultsDir, `TC-${BUG}-01.md`), 'RESULT: pass\n1 passed\n');
    ok(T(['ingest', BUG, r.run, '--dir', r.resultsDir]));
    const rep = json(T(['report', BUG, r.run]));
    assert.deepEqual([rep.verdict, rep.fixedNow], ['Passed', [`DEF-${BUG}-01`]]);
    const s = json(W(['status', BUG]));
    assert.equal(s.next, 'tested');
    assert.match(s.message, /tests: 1 cases, last report Passed/);
    assert.deepEqual(rep.promoted, { moved: [], waiting: [] }, 'a bug has no module requirement to join');
  });
});

describe('a feature\'s regression cases join the module suite', () => {
  test('the case for a changed module requirement moves; the case for a new one waits', () => {
    const rf = put(S('_state/request-in.md'), '# Show the age\n\nShow each patient\'s age.\n');
    const id = json(W(['new', '--request-file', rf])).id;
    // impact or requirement would name the modules; here they are set directly
    const sf = S(`work/${id}/status.json`);
    fs.writeFileSync(sf, JSON.stringify({ ...JSON.parse(fs.readFileSync(sf, 'utf8')), modules: ['patients'] }));
    put(S(`work/${id}/requirement.md`), `# Show the age: requirements\n\n## 3. Requirements\n\n### ${id}-R01: The list shows the age\n\n**Changes:** PATIENTS-R01\n\n### ${id}-R02: The age is exported\n\n**Changes:** new\n`);
    const p = json(T(['prepare', id]));
    assert.match(p.warn.join(), /requirements are not approved yet/);
    const c = (n, r) => `### TC-${id}-0${n}: Case ${n}\n\n**Covers:** ${r}\n**Type:** manual\n**Tags:** regression\n**Steps:**\n\n1. Look.\n\n**Expected:** the age.\n`;
    put(S(`work/${id}/tests/test-cases.md`), casesDocText(p.stamp, 'Show the age', [c(1, `${id}-R01`), c(2, `${id}-R02`)], { sanity: 0, regression: 2, covers: 2 }));
    ok(T(['check', S(`work/${id}/tests/test-cases.md`)]));
    ok(W(['level', id, 'Quick', '--by', 'Asha']));
    const before = (read('modules/patients/tests/test-cases.md').match(/^### TC-PATIENTS-\d+/gm) || []).length;
    const r = json(T(['select', id]));
    for (const n of [1, 2]) put(path.join(r.resultsDir, `TC-${id}-0${n}.md`), 'RESULT: pass\n');
    ok(T(['ingest', id, r.run, '--dir', r.resultsDir]));
    const rep = json(T(['report', id, r.run]));
    assert.deepEqual(rep.promoted.moved, [`TC-${id}-01 → TC-PATIENTS-0${before + 1}`]);
    assert.match(rep.promoted.waiting.join(), new RegExp(`TC-${id}-02 \\(patients\\): its requirement is new`));
    const suite = read('modules/patients/tests/test-cases.md');
    assert.match(suite, new RegExp(`### TC-PATIENTS-0${before + 1}: Case 1\\n\\n\\*\\*From:\\*\\* TC-${id}-01 \\(${id}\\)\\n\\*\\*Covers:\\*\\* PATIENTS-R01`));
    assert.match(suite, new RegExp(`> - \\*\\*Cases:\\*\\* ${before + 1}`));
    assert.match(ok(T(['check', mfile()])), /check-tests: PASS/);
    assert.deepEqual(json(T(['report', id, r.run])).promoted.moved, [], 'moved once only');
  });
});

describe('test definitions and the guard', () => {
  const R = (p) => fs.readFileSync(path.join(PLUGIN, p), 'utf8');
  test('agents: the planned models; the runners never fix code; the UI tester gets the browser tools', () => {
    for (const [n, m, e] of [['test-designer', 'sonnet', 'medium'], ['test-runner', 'haiku', 'low'], ['ui-tester', 'sonnet', 'medium'], ['defect-triager', 'sonnet', 'medium']]) {
      const t = R(`agents/${n}.md`);
      assert.match(t, new RegExp(`^model: ${m}$`, 'm'), n);
      assert.match(t, new RegExp(`^effort: ${e}$`, 'm'), n);
    }
    assert.doesNotMatch(R('agents/ui-tester.md'), /^tools:/m);
    assert.match(R('agents/test-runner.md'), /Never fix code or tests to make a case pass/);
    assert.match(R('agents/defect-triager.md'), /^tools: Read, Grep, Glob, Write$/m);
  });
  test('skills: never production, Zoho only after a yes, the gate always closed', () => {
    const t = R('skills/test-run/SKILL.md');
    assert.match(t, /\*\*Never production\.\*\*/);
    assert.match(t, /create defects only after an explicit yes/);
    assert.match(t, /Always close a work item's gate/);
    assert.match(R('references/test/test-run-flow.md'), /node T gate <ID> --close/);
    assert.match(R('skills/test-cases/SKILL.md'), /^disable-model-invocation: true$/m);
  });
  test('the test script runs in a repo on main', () => {
    assert.equal(runGuard({ tool_name: 'Bash', cwd: H, tool_input: { command: `node "$CLAUDE_PLUGIN_ROOT/scripts/test/tests.mjs" status patients --home "${H}"` } }, { env }).decision, 'pass');
  });
  test('the reserved test mobile numbers are not personal data; others still are', async () => {
    const { scanText } = await import('../scripts/lib/redact.mjs');
    assert.deepEqual(scanText('mobile 9000000001 and +91 9000000999'), []);
    assert.equal(scanText('mobile 9876543210')[0].type, 'phone number');
  });
});
