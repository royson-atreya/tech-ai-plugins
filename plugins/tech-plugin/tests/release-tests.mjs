// Tests for build step 10: /tech-plugin:release, /tech-plugin:incident,
// /tech-plugin:status and /tech-plugin:doctor --ci (scripts/release/,
// scripts/status.mjs, scripts/ci/ci.mjs), on the Laravel + Flutter fixtures
// with real commits. A bug goes from tested to released; production breaks
// and is resolved; a pull request is checked.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildDocSystem, runScript } from './golden-doc.mjs';
import { SECRET_MARKER } from './golden.mjs';
import { PLUGIN, runGuard } from './fixture.mjs';
import { parseYaml, toYaml } from '../scripts/lib/yaml.mjs';

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
{
  const f = path.join(H, 'sdlc-docs', 'system.yaml');
  const y = parseYaml(fs.readFileSync(f, 'utf8'));
  y.business.environments = [{ name: 'staging', url: 'https://staging.example.invalid', production: false }];
  fs.writeFileSync(f, toYaml(y));
}

const S = (p) => path.join(H, 'sdlc-docs', p);
const read = (p) => fs.readFileSync(S(p), 'utf8');
const ok = (r) => {
  assert.equal(r.code, 0, r.err || r.out);
  return r.out;
};
const json = (r) => JSON.parse(ok(r));
const RL = (args) => runScript('release', 'release.mjs', [...args, '--home', H]);
const IN = (args) => runScript('release', 'incident.mjs', [...args, '--home', H]);
const T = (args) => runScript('test', 'tests.mjs', [...args, '--home', H]);
const W = (args) => runScript('work', 'work.mjs', [...args, '--home', H]);
const B = (args) => runScript('work', 'build.mjs', [...args, '--home', H]);
const NX = (extra = []) => json(runScript('', 'next.mjs', ['--cwd', H, ...extra]));
const put = (p, t) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, t);
  return p;
};
const env = { HOME: path.join(G.W, 'home') };

// a bug, built, reviewed and tested
let BUG;
function bugTested() {
  BUG = json(W(['new', '--request-file', put(S('_state/request-in.md'), '# The export button does nothing\n\nOn a patient page the export button does nothing.\n'), '--kind', 'bug'])).id;
  const p = json(B(['prepare', BUG, '--modules', 'patients']));
  put(S(`work/${BUG}/plan.md`), `${p.stamp}\n# The export button does nothing: plan\n\n> **In short**\n> - **What changes:** The export button works again.\n> - **Steps:** 1\n> - **Repos:** web\n> - **Risk:** Low\n> - **Open questions:** 0\n\n## 1. What will change\n\nThe export button works again.\n\n## 2. Cause of the bug\n\nTo show it:\n\n1. Open a patient's page.\n2. Press export: nothing happens.\n\nThe button sends the request to a step that is gone. [E1]\n\n## 3. Risks and how to undo it\n\nRevert the commit.\n\n## 4. Open questions\n\nNone.\n\n## Appendix A. Evidence\n\n| ID | Statement | Source | Class |\n|---|---|---|---|\n| E1 | The page controller | \`web:app/Http/Controllers/PatientPageController.php:10\` | Verified |\n\n## Appendix B. Steps\n\n### ${BUG}-T01: A test and the fix\n\n**Covers:** the bug\n\n**Files:**\n\n- \`web:tests/Feature/ExportTest.php\` (new)\n- \`web:app/Http/Controllers/PatientPageController.php\` (change)\n\n**Do:** Add the test, then the export action.\n\n**Check:** \`vendor/bin/phpunit tests/Feature/ExportTest.php\`\n\n## Document control\n\nDraft.\n`);
  ok(runScript('work', 'check-work.mjs', [S(`work/${BUG}/plan.md`), '--home', H]));
  const a = json(B(['approval', BUG, '--activate']));
  put(path.join(G.web, `sdlc-docs/work/${BUG}/APPROVED`), `plan ${a.plan}\nby Asha\n`);
  gitT(G.web, 'switch', '-qc', 'feature/export');
  ok(B(['record', BUG, `${BUG}-T01`, '--result', 'pass', '--tier', 'standard', '--input', put(S('_state/r.md'), 'RESULT: pass')]));
  put(path.join(G.web, 'tests/Feature/ExportTest.php'), '<?php\n');
  fs.appendFileSync(path.join(G.web, 'app/Http/Controllers/PatientPageController.php'), '// export\n');
  put(path.join(G.web, 'database/migrations/2026_11_14_000000_add_export_flag.php'), '<?php\n// adds a column\n');
  put(path.join(G.web, '.env.example'), 'EXPORT_QUEUE=\n');
  json(B(['changes', BUG]));
  for (const k of ['code', 'security']) json(B(['save-review', BUG, '--kind', k, '--input', put(S('_state/rv.md'), 'Summary: 0 findings · 0 blocking\n')]));
  json(B(['handoff', BUG]));
  const tp = json(T(['prepare', BUG]));
  put(S(`work/${BUG}/tests/test-cases.md`), `${tp.stamp}\n# The export button does nothing: test cases\n\n> **In short**\n> - **Cases:** 1\n> - **Covers:** 1 requirements\n> - **Sanity:** 1\n> - **Regression:** 0\n> - **Open questions:** 0\n\n## 1. What is tested\n\nThe export.\n\n## 2. Test data\n\nA test doctor.\n\n## 3. Open questions\n\nNone.\n\n## Appendix A. Evidence\n\n| ID | Statement | Source | Class |\n|---|---|---|---|\n\n## Appendix B. Test cases\n\n### TC-${BUG}-01: Export starts\n\n**Covers:** the bug\n**Type:** manual\n**Tags:** sanity\n**Steps:**\n\n1. Open Test One's page.\n2. Press export.\n\n**Expected:** the export starts.\n\n## Document control\n\nDraft.\n`);
  ok(T(['check', S(`work/${BUG}/tests/test-cases.md`)]));
  const r = json(T(['select', BUG]));
  put(path.join(r.resultsDir, `TC-${BUG}-01.md`), 'RESULT: pass\n');
  ok(T(['ingest', BUG, r.run, '--dir', r.resultsDir]));
  assert.equal(json(T(['report', BUG, r.run])).verdict, 'Passed');
}

// ================================================================ release
const NOTES = (v, id, extra = '') => `# Release ${v}\n\n> **In short**\n> - **What is new:** The export button works again.\n> - **Fixed:** 1\n> - **Known issues:** 0\n> - **Date:** not set\n\n## 1. What is new\n\nNothing new.\n\n## 2. What is fixed\n\nThe export button on a patient's page starts the export again. (${id})\n\n## 3. Known issues\n\nNone.\n\n## 4. What people need to do\n\nNothing.\n${extra}\n## Appendix A. Work items\n\n| Item | Title | Kind | Requirements | Test report |\n|---|---|---|---|---|\n| ${id} | The export button does nothing | bug | the bug | Passed |\n\n## Document control\n\nWritten by /tech-plugin:release.\n`;
const RUNBOOK = (v, { migration = true } = {}) => `# Release ${v}: runbook\n\n> **In short**\n> - **Repos:** web\n> - **Database changes:** yes\n> - **New settings:** yes\n> - **Downtime:** none expected\n\n## 1. Before you deploy\n\n1. Tag the release.\n${migration ? '2. Take a backup of the production database and check it restores.\n' : ''}\n## 2. Deploy\n\n1. Deploy web as usual.\n${migration ? '2. Run the migration: php artisan migrate --force.\n' : ''}3. Set the setting EXPORT_QUEUE in the .env file.\n\n## 3. Check\n\n1. Do the smoke checks in smoke.md.\n\n## 4. Rollback\n\n1. Deploy the previous tag again.\n${migration ? '2. Roll back the migration: php artisan migrate:rollback --step=1 (the export flag column is lost).\n' : ''}\n## Document control\n\nWritten by /tech-plugin:release.\n`;

describe('release', () => {
  test('nothing tested: nothing to release', () => {
    assert.match(RL(['check']).err, /no work item is ready to release/);
  });
  test('a tested bug is ready; next suggests the release', () => {
    bugTested();
    assert.equal(json(W(['status', BUG])).next, 'tested');
    assert.deepEqual(json(RL(['status'])).ready.map((i) => i.id), [BUG]);
    assert.deepEqual([NX().next, NX().command], ['release', '/tech-plugin:release']);
  });
  test('nothing committed on its branch: not ready; "Go" is refused', () => {
    const c = json(RL(['check']));
    assert.equal(c.ready, false);
    assert.equal(c.version, '0.0.1', 'a bug-only release after no tag: 0.0.1');
    assert.ok(c.lines.some((l) => l.mark === '❌' && /nothing is committed on feature\/export yet/.test(l.text)), JSON.stringify(c.lines));
    assert.match(read('releases/0.0.1/checklist.md'), /> \*\*Not ready\.\*\*/);
    assert.match(RL(['save-review', '0.0.1', '--input', put(S('_state/report.md'), 'Recommendation: Go\n\nAll good.\n')]).err, /can only be "No go"/);
    assert.match(RL(['finish', '0.0.1']).err, /is not ready/);
  });
  test('committed but not merged: not ready', () => {
    gitT(G.web, 'add', '-A');
    gitT(G.web, 'commit', '-qm', `${BUG}: export`);
    const c = json(RL(['check', '0.0.1']));
    assert.ok(c.lines.some((l) => l.mark === '❌' && /feature\/export is not merged into main/.test(l.text)));
  });
  test('an open blocking defect stops it; known issues do not', () => {
    put(S(`work/${BUG}/tests/defects.md`), `# Defects\n\n### DEF-${BUG}-01: Export is slow\n\n**Status:** open\n**Severity:** blocking\n**Case:** TC-${BUG}-01\n**Requirement:** the bug\n`);
    assert.equal(json(W(['status', BUG])).next, 'fix-defects');
    let c = json(RL(['check', '0.0.1', BUG]));
    assert.ok(c.lines.some((l) => l.mark === '❌' && new RegExp(`open blocking defect\\(s\\) DEF-${BUG}-01`).test(l.text)));
    fs.writeFileSync(S(`work/${BUG}/tests/defects.md`), read(`work/${BUG}/tests/defects.md`).replace('**Severity:** blocking', '**Severity:** minor'));
    c = json(RL(['check', '0.0.1', BUG]));
    assert.ok(c.lines.some((l) => l.mark === '⚠️' && /known issue\(s\) DEF-W-\d+-01 \(minor\) go out with this release/.test(l.text)));
    ok(T(['defect', `DEF-${BUG}-01`, '--status', 'wont-fix']));
    assert.equal(json(W(['status', BUG])).next, 'tested');
  });
  let c;
  test('merged: ready, with the migration, settings and smoke checks flagged', () => {
    gitT(G.web, 'switch', '-q', 'main');
    assert.equal(gitT(G.web, 'merge', '-q', '--no-ff', '-m', 'merge', 'feature/export').status, 0);
    c = json(RL(['check', '0.0.1']));
    assert.equal(c.ready, true, JSON.stringify(c.lines, null, 1));
    assert.ok(c.lines.some((l) => l.mark === '✅' && /in web: merged into main/.test(l.text)));
    assert.deepEqual(c.flags.migrations.map((f) => f.file), ['web:database/migrations/2026_11_14_000000_add_export_flag.php']);
    assert.deepEqual(c.flags.settings.map((f) => f.file), ['web:.env.example']);
    assert.ok(c.lines.some((l) => /Back up the database before deploying/.test(l.text)));
    const sm = read('releases/0.0.1/smoke.md');
    assert.match(sm, /Quick checks \*\*you\*\* do by hand on production/);
    assert.match(sm, new RegExp(`## Export starts \\(TC-${BUG}-01\\)\\n\\n1\\. Open Test One's page\\.`));
  });
  test('notes and runbook: every item, every known issue, and a rollback for the migration', () => {
    const p = json(RL(['prepare', '0.0.1']));
    assert.equal(p.items[0].id, BUG);
    assert.ok(p.rules.some((r) => r.endsWith('ops-rules.md')));
    put(p.out.notes, NOTES('0.0.1', 'W-999'));
    put(p.out.runbook, RUNBOOK('0.0.1', { migration: false }));
    const bad = RL(['check-docs', '0.0.1']);
    assert.equal(bad.code, 1);
    assert.match(bad.out, new RegExp(`${BUG} is not mentioned`));
    assert.match(bad.out, /database changes: a backup step, the migration and how to roll it back/);
    put(p.out.notes, NOTES('0.0.1', BUG));
    put(p.out.runbook, RUNBOOK('0.0.1'));
    assert.match(ok(RL(['check-docs', '0.0.1'])), /check-release: PASS/);
    assert.match(ok(runScript('document', 'plain.mjs', [p.out.notes, '--home', H])), /plain: PASS/);
  });
  test('go / no go is a recommendation, saved with the release', () => {
    assert.match(RL(['save-review', '0.0.1', '--input', put(S('_state/report.md'), 'Looks fine.')]).err, /no "Recommendation:/);
    const r = json(RL(['save-review', '0.0.1', '--input', put(S('_state/report.md'), 'Recommendation: Go with conditions\n\nTake the backup first.\n')]));
    assert.equal(r.recommendation, 'Go with conditions');
    assert.match(read('releases/0.0.1/go-no-go.md'), /a recommendation; the person who deploys decides/);
  });
  test('finish: the items are released; the person tags', () => {
    const f = json(RL(['finish', '0.0.1']));
    assert.deepEqual(f.items, [BUG]);
    assert.match(f.commands[0], /^git -C '.*web' tag -a v0\.0\.1 -m "Release 0\.0\.1" main && git -C '.*web' push origin v0\.0\.1$/);
    assert.equal(json(W(['status', BUG])).next, 'released');
    assert.deepEqual(json(RL(['status'])).ready, []);
    assert.notEqual(NX().next, 'release');
    assert.match(RL(['finish', '0.0.1']).err, /already finished/);
    assert.match(RL(['check', '0.0.1', BUG]).err, /already finished/);
    assert.equal(gitT(G.web, 'tag').stdout.trim(), '', 'the plugin never tags');
  });
});

// ================================================================ incident
let INC;
describe('incident', () => {
  test('a new incident: keys and phone numbers masked; it comes first in next', () => {
    const r = json(IN(['new', '--severity', 'S2', '--input', put(S('_state/incident-in.md'), `# The patient list shows an error\n\nDoctors see an error on the patient list. Doctor at 9876543210 reported it. password = hunter2hunter2hunter2 ${SECRET_MARKER}\n`)]));
    INC = r.incident;
    assert.match(INC, /^\d{4}-\d{2}-\d{2}-the-patient-list-shows-an-error$/);
    assert.ok(r.modules.includes('patients'));
    const t = read(`incidents/${INC}/incident.md`);
    assert.ok(!t.includes('9876543210') && !t.includes('hunter2hunter2hunter2'));
    assert.deepEqual([NX().next, NX().command], ['incident', `/tech-plugin:incident ${INC}`]);
    assert.equal(json(IN(['list'])).open[0].severity, 'S2');
  });
  test('evidence is masked and counted', () => {
    const e = json(IN(['evidence', INC, '--input', put(S('_state/evidence-in.md'), 'ERROR SQLSTATE[42S22] column export_flag not found; user asha.r@clinic.in\n')]));
    assert.equal(e.masked, 1);
    assert.ok(!read(`incidents/${INC}/evidence.md`).includes('asha.r@clinic.in'));
    assert.match(read(`incidents/${INC}/incident.md`), /evidence added \(1 value\(s\) masked\)/);
  });
  test('suspects: the module, the recent commit that touched it, the last release', () => {
    const s = json(IN(['suspects', INC]));
    assert.ok(s.modules.some((m) => m.id === 'patients'));
    const hit = s.commits.find((c) => c.repo === 'web' && c.touches.includes('patients'));
    assert.ok(hit, JSON.stringify(s.commits.slice(0, 5)));
    assert.match(hit.subject, /export/);
    assert.equal(s.releases[0].version, '0.0.1');
  });
  test('the analysis needs a confidence, a way out and evidence', () => {
    assert.match(IN(['save', INC, '--input', put(S('_state/analysis.md'), 'It is the database.')]).err, /Confidence: High \| Medium \| Low[\s\S]*Way out/);
    const r = json(IN(['save', INC, '--input', put(S('_state/analysis.md'), 'Confidence: High\nWay out: Rollback, then hotfix\n\n**Likely cause:** the export column is read before its migration ran, `web:app/Http/Controllers/PatientPageController.php:10`.\n')]));
    assert.deepEqual([r.confidence, r.way], ['High', 'Rollback, then hotfix']);
    const t = read(`incidents/${INC}/incident.md`);
    assert.match(t, /## 4\. Analysis\n\nConfidence: High/);
    assert.match(t, /## 5\. Way out\n\nRollback, then hotfix\. Roll back with the rollback steps/);
  });
  test('a hotfix is a bug work item from the release tag', () => {
    const h = json(IN(['hotfix', INC]));
    assert.match(fs.readFileSync(h.request, 'utf8'), new RegExp(`^# Hotfix: The patient list shows an error\\n\\nIncident ${INC}\\.`));
    assert.equal(h.branchFrom, 'v0.0.1');
    const id = json(W(['new', '--request-file', h.request, '--kind', 'bug'])).id;
    assert.deepEqual(json(IN(['link', INC, '--work', id])).hotfix, [id]);
    fs.rmSync(S(`work/${id}`), { recursive: true });
  });
  test('resolved: a blameless postmortem with actions for roles; then next moves on', () => {
    const p = json(IN(['resolve', INC]));
    const pm = (blame, role) => `# Postmortem: the patient list showed an error\n\n> **In short**\n> - **What happened:** the list failed.\n> - **Impact:** doctors could not open the list for 20 minutes.\n> - **Root cause:** a migration ran late.\n> - **Actions:** 1\n\n## 1. Summary\n\nThe list failed${blame ? ' because the developer was careless' : ''}.\n\n## 2. Timeline\n\n- 10:00 UTC: the error started\n- 10:20 UTC: rolled back\n\n## 3. Root cause\n\nThe migration ran after the code. \`web:app/Http/Controllers/PatientPageController.php:10\`\n\n## 4. What went well\n\n- The rollback steps worked.\n\n## 5. What went badly\n\n- Nobody noticed for 10 minutes.\n\n## 6. Actions\n\n| Action | Role | Work item |\n|---|---|---|\n| Run migrations before the code | ${role} | to start |\n\n## Document control\n\nWritten by /tech-plugin:incident.\n`;
    put(p.out, pm(true, 'Ravi'));
    const bad = IN(['check-postmortem', INC]);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /give the action a role, not a person's name/);
    assert.match(bad.out, /blameless: about what happened, not who[\s\S]*"careless"/);
    put(p.out, pm(false, 'developer'));
    assert.match(ok(IN(['check-postmortem', INC])), /check-postmortem: PASS/);
    assert.equal(json(IN(['list'])).open.length, 0);
    assert.notEqual(NX().next, 'incident');
  });
});

// ================================================================ status
describe('status', () => {
  test('everything in one place; a work item continues from where it stopped', () => {
    const s = json(runScript('', 'status.mjs', ['--cwd', H]));
    assert.equal(s.found, true);
    assert.deepEqual(s.released, [`${BUG} (0.0.1)`]);
    assert.equal(s.releases[0].version, '0.0.1');
    assert.equal(s.modules.total, 6);
    const id = json(W(['new', '--request-file', put(S('_state/request-in.md'), '# Show the age\n\nShow the age.\n')])).id;
    const s2 = json(runScript('', 'status.mjs', ['--cwd', H]));
    assert.deepEqual(s2.items.map((i) => [i.id, i.phase]), [[id, 'planning']]);
    const n = NX(['--item', id]);
    assert.deepEqual([n.next, n.command], ['impact', `/tech-plugin:impact ${id}`]);
    assert.equal(NX(['--item', BUG]).next, 'released');
    fs.rmSync(S(`work/${id}`), { recursive: true });
  });
});

// ================================================================ CI
describe('doctor --ci and the pull-request check', () => {
  test('the workflow: read-only rights, pinned actions, the marketplace, never a push', () => {
    const w = json(runScript('ci', 'ci.mjs', ['workflow', '--repo', H, '--marketplace', 'acme/tech-ai-plugins']));
    assert.equal(w.file, S('ci/tech-plugin.yml'));
    const y = read('ci/tech-plugin.yml');
    assert.match(y, /permissions:\n {2}contents: read\n {2}pull-requests: write/);
    assert.match(y, /repository: acme\/tech-ai-plugins/);
    assert.match(y, /https:\/\/github\.com\/acme\/tech-ai-plugins\.git/);
    assert.match(y, /uses: anthropics\/claude-code-action@v1/);
    assert.match(y, /zricethezav\/gitleaks:v8\.18\.4 .*\n.*\n.*--redact/);
    assert.match(y, /if: vars\.TECH_PLUGIN_AI_REVIEW == 'true'/);
    assert.doesNotMatch(y, /git push|contents: write/);
    assert.match(w.commands[0], /mkdir -p '.*\.github\/workflows' && cp '.*sdlc-docs\/ci\/tech-plugin\.yml'/);
  });
  test('doctor --ci writes it inside sdlc-docs and says how to put it in place', () => {
    const home = path.join(G.W, 'home-ci');
    fs.mkdirSync(home, { recursive: true });
    const r = spawnSync(process.execPath, [path.join(PLUGIN, 'scripts', 'doctor.mjs'), '--ci', '--dir', H], { encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN, HOME: home } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Wrote `sdlc-docs\/ci\/tech-plugin\.yml`/);
    assert.match(r.stdout, /Replace <owner>\/<marketplace-repo>/);
    assert.match(r.stdout, /Claude writes only inside sdlc-docs\/, so put it in place yourself/);
    assert.ok(!fs.existsSync(path.join(H, '.github', 'workflows', 'tech-plugin.yml')), 'never writes .github itself');
  });
  test('a pull request: its module and risk, the documents citing the files, secrets never shown', () => {
    put(S('modules/patients/spec.md'), '# Patients\n\n| E1 | list | `backend:app/Http/Controllers/PatientController.php:10` | Verified |\n');
    const base = gitT(H, 'rev-parse', 'HEAD').stdout.trim();
    gitT(H, 'switch', '-qc', 'feature/pr');
    fs.appendFileSync(path.join(H, 'app/Http/Controllers/PatientController.php'), '// change\n');
    put(path.join(H, 'notes/readme.txt'), 'x\n');
    put(path.join(H, '.env.staging'), `KEY=${SECRET_MARKER}\n`);
    gitT(H, 'add', '-A');
    gitT(H, 'commit', '-qm', 'pr');
    const gl = put(path.join(G.W, 'gitleaks.json'), JSON.stringify([{ RuleID: 'generic-api-key', File: 'config/x.php', StartLine: 3, Secret: 'abcd-THE-VALUE' }]));
    const out = path.join(G.W, 'comment.md');
    const patch = path.join(G.W, 'changes.patch');
    const r = json(runScript('ci', 'ci.mjs', ['pr', '--home', H, '--base', base, '--gitleaks', gl, '--out', out, '--patch', patch]));
    assert.ok(r.modules.some((m) => m.id === 'patients' && m.docs.includes('modules/patients/spec.md')), JSON.stringify(r.modules));
    assert.deepEqual(r.secretFiles, ['.env.staging']);
    const c = fs.readFileSync(out, 'utf8');
    assert.match(c, /^<!-- tech-plugin-ci -->\n### tech-plugin check/);
    assert.match(c, /\| Patients \(`patients`\) \| .* \| 1 \| `modules\/patients\/spec\.md` \|/);
    assert.match(c, /- generic-api-key in `config\/x\.php` line 3/);
    assert.ok(!c.includes('abcd-THE-VALUE') && !c.includes(SECRET_MARKER));
    assert.ok(!fs.readFileSync(patch, 'utf8').includes(SECRET_MARKER), 'the patch for the AI review leaves secret files out');
    gitT(H, 'switch', '-q', 'main');
  });
  test('the AI review comment needs its summary and never quotes a key', () => {
    assert.match(runScript('ci', 'ci.mjs', ['ai-comment', '--home', H, '--input', put(path.join(G.W, 'rv.md'), 'fine')]).err, /no "Summary:/);
    assert.match(runScript('ci', 'ci.mjs', ['ai-comment', '--home', H, '--input', put(path.join(G.W, 'rv.md'), 'Summary: 1 findings · 1 blocking\npassword = hunter2hunter2hunter2')]).err, /not written: the review quotes/);
    const r = json(runScript('ci', 'ci.mjs', ['ai-comment', '--home', H, '--input', put(path.join(G.W, 'rv.md'), '# Security review (round 1)\n\nSummary: 0 findings · 0 blocking\n')]));
    assert.match(fs.readFileSync(r.file, 'utf8'), /^<!-- tech-plugin-ai-review -->/);
    assert.equal(r.file, S('_state/ci/ai-comment.md'));
  });
});

describe('step 10 definitions and the guard', () => {
  const R = (p) => fs.readFileSync(path.join(PLUGIN, p), 'utf8');
  test('agents: the planned models; the reviewer only reads', () => {
    for (const [n, m, e] of [['ops-writer', 'sonnet', 'medium'], ['release-reviewer', 'opus', 'high'], ['incident-investigator', 'opus', 'high']]) {
      const t = R(`agents/${n}.md`);
      assert.match(t, new RegExp(`^model: ${m}$`, 'm'), n);
      assert.match(t, new RegExp(`^effort: ${e}$`, 'm'), n);
    }
    assert.match(R('agents/release-reviewer.md'), /^tools: Read, Grep, Glob$/m);
  });
  test('skills: never deploy, tag, push or touch production', () => {
    assert.match(R('skills/release/SKILL.md'), /\*\*Never deploy, tag, push, migrate or touch production\.\*\*/);
    assert.match(R('skills/incident/SKILL.md'), /\*\*Never connect to production\*\*/);
    assert.match(R('skills/ci-check/SKILL.md'), /Never push, never change code, never post anything yourself/);
    for (const s of ['release', 'incident', 'status', 'ci-check']) assert.match(R(`skills/${s}/SKILL.md`), /^disable-model-invocation: true$/m, s);
  });
  test('the scripts run in a repo on main', () => {
    for (const c of [`node "$CLAUDE_PLUGIN_ROOT/scripts/release/release.mjs" status --home "${H}"`, `node "$CLAUDE_PLUGIN_ROOT/scripts/status.mjs" --cwd "${H}"`]) assert.equal(runGuard({ tool_name: 'Bash', cwd: H, tool_input: { command: c } }, { env }).decision, 'pass', c);
  });
  test('Claude cannot write the workflow into .github itself', () => {
    assert.equal(runGuard({ tool_name: 'Write', cwd: H, tool_input: { file_path: path.join(H, '.github/workflows/tech-plugin.yml'), content: 'x' } }, { env }).decision, 'block:repo-write');
  });
});
