// Tests for build step 8: /tech-plugin:task, /tech-plugin:implement and
// /tech-plugin:review (scripts/work/build.mjs, the plan checks in
// check-work.mjs, the next steps in work.mjs and next.mjs), on the
// Laravel + Flutter fixtures document-tests use. A bug goes from its words to
// a handoff; the approval gate is checked against the real guard.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildDocSystem, runScript } from './golden-doc.mjs';
import { SECRET_MARKER } from './golden.mjs';
import { PLUGIN, runGuard } from './fixture.mjs';
import { splitDoc } from '../scripts/lib/frontmatter.mjs';

const D = buildDocSystem();
const { G, H } = D;
after(() => fs.rmSync(G.W, { recursive: true, force: true }));

// real commits, so review can diff against them (the fixtures use made-up commit ids)
const gitT = (dir, ...args) => spawnSync('git', ['-C', dir, '-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', ...args], { encoding: 'utf8' });
for (const [dir, branch] of [[G.backend, 'main'], [G.web, 'main'], [G.mobile, 'develop']]) {
  fs.rmSync(path.join(dir, '.git', 'refs', 'heads', branch), { force: true });
  gitT(dir, 'add', '-A');
  const r = gitT(dir, 'commit', '-qm', 'base', '--allow-empty');
  if (r.status !== 0) throw new Error(r.stderr);
}
D.finishBreakdown();

const S = (p) => path.join(H, 'sdlc-docs', p);
const read = (p) => fs.readFileSync(S(p), 'utf8');
const ok = (r) => {
  assert.equal(r.code, 0, r.err || r.out);
  return r.out;
};
const json = (r) => JSON.parse(ok(r));
const B = (args) => runScript('work', 'build.mjs', [...args, '--home', H]);
const W = (args) => runScript('work', 'work.mjs', [...args, '--home', H]);
const check = (f) => runScript('work', 'check-work.mjs', [f, '--home', H]);
const plain = (f) => runScript('document', 'plain.mjs', [f, '--home', H]);
const report = (txt) => {
  const f = S('_state/report.md');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, txt);
  return f;
};
const env = { HOME: path.join(G.W, 'home') };
const guardWrite = (p) => runGuard({ tool_name: 'Write', cwd: G.web, tool_input: { file_path: p, content: 'x' } }, { env }).decision;

function newItem(title, text, kind = null) {
  const f = S('_state/request-in.md');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `# ${title}\n\n${text}\n`);
  return json(W(['new', '--request-file', f, ...(kind ? ['--kind', kind] : [])])).id;
}

const CTRL = 'web:app/Http/Controllers/PatientPageController.php';
const bugBody = (id, { risk = 'Low', t01File = '`web:tests/Feature/ExportTest.php` (new)', t01Check = '`vendor/bin/phpunit tests/Feature/ExportTest.php`', steps = 2 } = {}) => `# The export button does nothing: plan

> **In short**
> - **What changes:** The export button on a patient's page starts the export again.
> - **Steps:** ${steps}
> - **Repos:** web
> - **Risk:** ${risk}
> - **Open questions:** 0

## 1. What will change

Doctors press the export button on a patient's page and get the export, as before. Nothing else changes.

## 2. Cause of the bug

To show it:

1. Open a patient's page.
2. Press the export button: nothing happens. It should start the export.

The button sends the request to a step that does not exist any more. [E1]

## 3. Risks and how to undo it

Only the export changes. To undo it, revert the commit.

## 4. Open questions

None.

## Appendix A. Evidence

| ID | Statement | Source | Class |
|---|---|---|---|
| E1 | The page controller handles the patient pages | \`${CTRL}:10\` | Verified |

## Appendix B. Steps

### ${id}-T01: A test that shows the bug

**Covers:** the bug

**Files:**

- ${t01File}

**Do:** Add a feature test that presses export on a patient's page and expects the export to start.

**Check:** ${t01Check}
${steps > 1 ? `
### ${id}-T02: Point the button at the export step

**Covers:** the bug

**Files:**

- \`${CTRL}\` (change)

**Do:** Add the export action the button calls.

**Check:** \`vendor/bin/phpunit tests/Feature/ExportTest.php\`
` : ''}
## Document control

Draft, written by /tech-plugin:task. A person approves it by creating the APPROVED file that /tech-plugin:task prints, and switching to a feature branch.
`;

let BUG;
let pack;
const planFile = () => S(`work/${BUG}/plan.md`);
const writePlan = (body) => fs.writeFileSync(planFile(), `${pack.stamp}\n${body}`);

describe('task: a bug from its words to a plan', () => {
  test('a bug goes straight to the plan: no impact, requirements or design', () => {
    BUG = newItem('The export button does nothing', 'On a patient page the export button does nothing when pressed.', 'bug');
    const s = json(W(['status', BUG]));
    assert.deepEqual([s.kind, s.level, s.next], ['bug', 'Quick', 'task']);
    assert.match(read(`work/${BUG}/request.md`), /\*\*Work item:\*\* W-\d+ \(bug\)/);
  });
  test('prepare: the stamp records each repo\'s commit; the planner\'s tier; the rules include the worker rules', () => {
    pack = json(B(['prepare', BUG, '--modules', 'patients']));
    const f = splitDoc(`${pack.stamp}\n`).front;
    assert.deepEqual([f.doc, f.kind, f.status, 'approval' in f], ['plan', 'bug', 'Draft', false]);
    const head = gitT(G.web, 'rev-parse', 'HEAD').stdout.trim();
    assert.deepEqual(f.repos.web, { base: head, branch: 'main' });
    assert.equal(pack.tier.agent, 'tech-plugin:worker-standard');
    assert.ok(pack.rules.some((r) => r.endsWith('worker-rules.md')));
    assert.equal(pack.template, path.join(PLUGIN, 'references', 'work', 'plan-template.md'));
    assert.equal(pack.stepPrefix, `${BUG}-T`);
    assert.deepEqual(pack.dirty, []);
  });
  test('a bug with no modules named gets the ones its words point at', () => {
    const id = newItem('Patient list is slow', 'The patient list takes long to open.', 'bug');
    const p = json(B(['prepare', id]));
    assert.equal(p.modulesGuessed, true);
    assert.ok(splitDoc(`${p.stamp}\n`).front.modules.includes('patients'));
    fs.rmSync(S(`work/${id}`), { recursive: true });
  });
  test('a feature is planned only after its requirements are approved', () => {
    const id = newItem('Download the report', 'Doctors want to download the pulse report.');
    const r = B(['prepare', id, '--modules', 'patients']);
    assert.equal(r.code, 1);
    assert.match(r.err, /plan after the requirements are approved: \/tech-plugin:requirement W-\d+/);
    fs.rmSync(S(`work/${id}`), { recursive: true });
  });
  test('a good plan passes both checks', () => {
    writePlan(bugBody(BUG));
    assert.match(ok(check(planFile())), /check-work: PASS/);
    assert.match(ok(plain(planFile())), /plain: PASS/);
    assert.equal(json(W(['status', BUG])).next, 'approve-plan');
  });
});

describe('the plan checks', () => {
  const fails = (body, re) => {
    writePlan(body);
    const r = check(planFile());
    writePlan(bugBody(BUG));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, re);
  };
  test('a bug\'s first step is a failing test', () => fails(bugBody(BUG, { t01File: `\`${CTRL}\` (change)` }), /the first step of a bug adds a test that fails because of the bug/));
  test('a check that installs packages', () => fails(bugBody(BUG, { t01Check: '`composer install && vendor/bin/phpunit`' }), /the check installs packages; the guard blocks that/));
  test('a check that runs git', () => fails(bugBody(BUG, { t01Check: '`git commit -am wip`' }), /the check runs git/));
  test('a check the guard\'s safe-command list blocks', () => fails(bugBody(BUG, { t01Check: '`php artisan test`' }), /the guard allows "php artisan" only with/));
  test('a file that does not exist and is not marked new', () => fails(bugBody(BUG, { t01File: '`web:tests/Feature/Nope.php` (change)' }), /does not exist; mark it "\(new\)"/));
  test('a secret file', () => fails(bugBody(BUG, { t01File: '`web:.env` (change)' }), /is a secret file: never change it in a plan/));
  test('a repo that is not in the system', () => fails(bugBody(BUG, { t01File: '`shop:tests/a.test.js` (new)' }), /shop is not a repo of this system/));
  test('a step count that does not match', () => fails(bugBody(BUG).replace('**Steps:** 2', '**Steps:** 5'), /In short says Steps 5, the document has 2/));
  test('a plan marked Approved in its stamp', () => {
    fs.writeFileSync(planFile(), `${pack.stamp.replace('status: Draft', 'status: Approved')}\n${bugBody(BUG)}`);
    const r = check(planFile());
    writePlan(bugBody(BUG));
    assert.equal(r.code, 1);
    assert.match(r.out, /a plan is a Draft[\s\S]*approves a plan with its APPROVED file/);
  });
  test('no way to show the bug', () => fails(bugBody(BUG).replace('1. Open a patient\'s page.\n2. Press', '- Open a patient\'s page.\n- Press'), /give the steps that show the bug as a numbered list/));
});

describe('tiers by risk', () => {
  test('High risk: the deep tier, but never for a Quick item', () => {
    const id = newItem('Payments fail', 'Card payments fail at checkout.', 'bug');
    const p = json(B(['prepare', id, '--modules', 'patients']));
    fs.writeFileSync(S(`work/${id}/plan.md`), `${p.stamp}\n${bugBody(id, { risk: 'High' })}`);
    assert.equal(json(B(['tier', id, 'plan'])).tier, 'standard');
    ok(W(['level', id, 'Full', '--by', 'Asha']));
    const t = json(B(['tier', id, 'implement', '--step', `${id}-T01`]));
    assert.deepEqual([t.tier, t.why], ['deep', 'risk High']);
    fs.rmSync(S(`work/${id}`), { recursive: true });
  });
});

describe('approval: the person opens the gate', () => {
  test('before approval the guard blocks code edits in the repo', () => {
    assert.equal(guardWrite(path.join(G.web, 'app/x.php')), 'block:repo-write');
  });
  test('not approved: the commands for the person, with the plan\'s version', () => {
    const a = json(B(['approval', BUG]));
    const hash = splitDoc(fs.readFileSync(planFile(), 'utf8')).body && a.plan;
    assert.equal(a.ok, false);
    assert.deepEqual(a.repos.map((r) => r.repo), ['web']);
    assert.match(a.message, /run in your own terminal \(Claude cannot\)/);
    assert.ok(a.commands.some((c) => /git -C '.*web' switch -c feature\/w-\d+-the-export-button-does-nothing/.test(c)), a.commands.join('\n'));
    assert.ok(a.commands.some((c) => c.startsWith(`printf 'plan %s\\nby %s\\n' ${hash} "<your name>" > '`) && c.endsWith(`/sdlc-docs/work/${BUG}/APPROVED'`)), a.commands.join('\n'));
  });
  test('--activate writes .active in the repo the plan changes, never APPROVED', () => {
    json(B(['approval', BUG, '--activate']));
    assert.equal(fs.readFileSync(path.join(G.web, 'sdlc-docs/work/.active'), 'utf8').trim(), BUG);
    assert.ok(fs.existsSync(path.join(G.web, `sdlc-docs/work/${BUG}/README.md`)));
    assert.ok(!fs.existsSync(path.join(G.web, `sdlc-docs/work/${BUG}/APPROVED`)));
  });
  test('APPROVED for another version of the plan does not count', () => {
    fs.writeFileSync(path.join(G.web, `sdlc-docs/work/${BUG}/APPROVED`), 'plan 0123456789abcdef\nby Asha\n');
    const a = json(B(['approval', BUG]));
    assert.deepEqual([a.ok, a.repos[0].approvedOtherPlan], [false, true]);
    assert.match(a.message, /APPROVED names an older plan/);
  });
  test('the right version, but still on main: not yet', () => {
    const a0 = json(B(['approval', BUG]));
    fs.writeFileSync(path.join(G.web, `sdlc-docs/work/${BUG}/APPROVED`), `plan ${a0.plan}\nby Asha\n`);
    const a = json(B(['approval', BUG]));
    assert.deepEqual([a.ok, a.repos[0].planMatches, a.repos[0].protectedBranch], [false, true, true]);
    assert.match(a.repos[0].gate, /protected branch main/);
    assert.equal(json(runScript('', 'next.mjs', ['--cwd', H])).command, `/tech-plugin:task ${BUG}`);
  });
  test('on a feature branch: approved, and the guard lets code be written', () => {
    assert.equal(gitT(G.web, 'switch', '-qc', 'feature/export').status, 0);
    const a = json(B(['approval', BUG]));
    assert.equal(a.ok, true, a.message);
    assert.equal(guardWrite(path.join(G.web, 'app/x.php')), 'pass');
    const s = json(W(['status', BUG]));
    assert.deepEqual([s.next, s.build.approved, s.build.steps], ['implement', true, '0/2']);
    assert.equal(json(runScript('', 'next.mjs', ['--cwd', H])).command, `/tech-plugin:implement ${BUG}`);
  });
});

describe('implement: steps, results and tiers', () => {
  test('progress: two steps to do, T01 first', () => {
    const p = json(B(['progress', BUG]));
    assert.deepEqual([p.done, p.total, p.next], [0, 2, `${BUG}-T01`]);
  });
  test('a Quick item stays on the standard tier and stops after two failures there', () => {
    const t = (step) => json(B(['tier', BUG, 'implement', '--step', step]));
    assert.equal(t(`${BUG}-T01`).agent, 'tech-plugin:worker-standard');
    for (let i = 0; i < 2; i++) ok(B(['record', BUG, `${BUG}-T01`, '--result', 'fail', '--tier', 'standard', '--input', report('RESULT: fail\nthe test did not run')]));
    const s = t(`${BUG}-T01`);
    assert.deepEqual([s.tier, s.stop], ['standard', true]);
    assert.match(s.message, /failed twice on the standard tier, the highest allowed/);
  });
  test('a Standard item climbs to the deep tier after two failures', () => {
    ok(W(['level', BUG, 'Standard', '--by', 'Asha']));
    const s = json(B(['tier', BUG, 'implement', '--step', `${BUG}-T01`]));
    assert.deepEqual([s.tier, s.agent, s.stop], ['deep', 'tech-plugin:worker-deep', false]);
    assert.match(s.why, /failed twice on the standard tier/);
  });
  test('the project may map a tier to another agent', () => {
    fs.writeFileSync(S('config.json'), JSON.stringify({ tiers: { deep: 'my-plugin:senior-dev' } }));
    assert.equal(json(B(['tier', BUG, 'implement', '--step', `${BUG}-T01`])).agent, 'my-plugin:senior-dev');
    fs.rmSync(S('config.json'));
    ok(W(['level', BUG, 'Quick', '--by', 'Asha']));
  });
  test('record: the report is saved, keys in it are hidden, the step is done', () => {
    const r = json(B(['record', BUG, `${BUG}-T01`, '--result', 'pass', '--tier', 'standard', '--input', report('RESULT: pass\nTests: 1 passed\npassword = hunter2hunter2hunter2\n')]));
    assert.deepEqual([r.attempt, r.done, r.next], [3, 1, `${BUG}-T02`]);
    const saved = read(`work/${BUG}/checks/${BUG}-T01-3.md`);
    assert.match(saved, /\*\*Result:\*\* pass/);
    assert.ok(!saved.includes('hunter2hunter2hunter2'));
    ok(B(['record', BUG, `${BUG}-T02`, '--result', 'pass', '--tier', 'standard', '--input', report('RESULT: pass')]));
    assert.equal(json(W(['status', BUG])).next, 'review');
  });
  test('record refuses a step the plan does not have', () => {
    const r = B(['record', BUG, `${BUG}-T09`, '--result', 'pass', '--input', report('x')]);
    assert.equal(r.code, 1);
    assert.match(r.err, /is not a step of the plan/);
  });
});

describe('review: changes, reviews and the handoff', () => {
  let ch;
  test('changes: planned and unplanned files, new files included, secret files left out', () => {
    fs.appendFileSync(path.join(G.web, 'app/Http/Controllers/PatientPageController.php'), '// export\n');
    fs.mkdirSync(path.join(G.web, 'tests/Feature'), { recursive: true });
    fs.writeFileSync(path.join(G.web, 'tests/Feature/ExportTest.php'), '<?php\n// presses export\n');
    fs.appendFileSync(path.join(G.web, 'routes/web.php'), '// touched\n');
    fs.writeFileSync(path.join(G.web, '.env.production'), `APP_KEY=${SECRET_MARKER}\n`);
    ch = json(B(['changes', BUG]));
    const names = ch.files.map((f) => `${f.repo}:${f.path}`).sort();
    assert.deepEqual(names, ['web:app/Http/Controllers/PatientPageController.php', 'web:routes/web.php', 'web:tests/Feature/ExportTest.php']);
    assert.deepEqual(ch.unplanned, ['web:routes/web.php']);
    assert.deepEqual(ch.skippedSecrets, ['web:.env.production']);
    const patch = fs.readFileSync(ch.patch, 'utf8');
    assert.ok(!patch.includes(SECRET_MARKER));
    assert.match(patch, /\+\+\+ b\/tests\/Feature\/ExportTest\.php\n@@ -0,0 \+1,2 @@\n\+<\?php/);
    assert.ok(!patch.includes('sdlc-docs/'), 'sdlc-docs is left out');
  });
  test('the build changed the code: still review next, not a new breakdown', () => {
    assert.equal(json(runScript('breakdown', 'state.mjs', ['status', '--cwd', H])).next, 3);
    assert.equal(json(W(['status', BUG])).next, 'review');
    const n = json(runScript('', 'next.mjs', ['--cwd', H]));
    assert.deepEqual([n.next, n.command], ['review', `/tech-plugin:review ${BUG}`]);
    assert.match(n.why, /is being built/);
  });
  test('a review must end with its summary line, and never quote a key', () => {
    let r = B(['save-review', BUG, '--kind', 'code', '--input', report('Looks fine.')]);
    assert.match(r.err, /no "Summary: N findings · B blocking" line/);
    r = B(['save-review', BUG, '--kind', 'security', '--input', report('Summary: 1 findings · 1 blocking\nThe key password = hunter2hunter2hunter2 is in the code.')]);
    assert.match(r.err, /not saved: the review quotes/);
  });
  test('round 1: one blocking finding; round 2 after the fix: none', () => {
    const r1 = json(B(['save-review', BUG, '--kind', 'code', '--input', report('# Code review (round 1)\n\nSummary: 2 findings · 1 blocking\n')]));
    assert.deepEqual([r1.round, r1.blocking], [1, 1]);
    json(B(['save-review', BUG, '--kind', 'security', '--input', report('# Security review (round 1)\n\nSummary: 0 findings · 0 blocking\n')]));
    ok(B(['record', BUG, 'fix-1', '--result', 'pass', '--tier', 'standard', '--input', report('RESULT: pass\nfixed 1')]));
    json(B(['changes', BUG]));
    const r2 = json(B(['save-review', BUG, '--kind', 'code', '--input', report('# Code review (round 2)\n\nSummary: 1 findings · 0 blocking\n')]));
    assert.deepEqual([r2.round, r2.blocking], [2, 0]);
    json(B(['save-review', BUG, '--kind', 'security', '--input', report('Summary: 0 findings · 0 blocking\n')]));
  });
  let h;
  test('handoff: what changed, how to check it, open points, a ready commit; the gate closes', () => {
    h = json(B(['handoff', BUG]));
    const t = fs.readFileSync(h.file, 'utf8');
    assert.match(t, /> - \*\*Files:\*\* 3 changed \(\+\d+ −0\) in web/);
    assert.match(t, /> - \*\*Checks:\*\* 2 of 2 steps passed their check/);
    assert.match(t, /> - \*\*Review:\*\* code: 1 finding\(s\), 0 blocking; security: 0 finding\(s\), 0 blocking/);
    assert.match(t, /Follow the steps that showed the bug\. It should not happen any more:\n\nTo show it:\n\n1\. Open a patient's page\./);
    assert.match(t, /- `web:routes\/web\.php` changed, but no step of the plan names it\./);
    assert.match(t, /- 1 secret file\(s\) changed and were not shown to the reviewers: `web:\.env\.production`/);
    assert.match(t, /\| W-\d+-T01 A test that shows the bug \| the bug \| `web:tests\/Feature\/ExportTest\.php` \| `vendor\/bin\/phpunit tests\/Feature\/ExportTest\.php` \| \[pass, attempt 3, standard\]\(checks\/W-\d+-T01-3\.md\) \|/);
    assert.match(fs.readFileSync(h.commitMessage, 'utf8'), new RegExp(`^${BUG}: The export button does nothing\\n\\nThe export button on a patient's page starts the export again\\.\\n\\nSteps: ${BUG}-T01, ${BUG}-T02\\n$`));
    assert.match(h.commands[0], /^git -C '.*web' add -A && git -C '.*web' commit -F '.*commit-message\.txt' && git -C '.*web' push -u origin feature\/export$/);
    assert.deepEqual(h.closed, ['web']);
    assert.ok(!fs.existsSync(path.join(G.web, 'sdlc-docs/work/.active')));
  });
  test('after the handoff the guard blocks code edits again, and the item is done', () => {
    assert.equal(guardWrite(path.join(G.web, 'app/x.php')), 'block:repo-write');
    const s = json(W(['status', BUG]));
    assert.equal(s.next, 'test-cases', 'the build\'s own code changes do not send it back to the breakdown; testing comes next');
    assert.match(s.message, /plan: up-to-date, approved, 2\/2 steps done, handed off/);
    assert.equal(json(runScript('', 'next.mjs', ['--cwd', H])).command, `/tech-plugin:test-cases ${BUG}`, 'testing comes before a new breakdown');
  });
  test('no commit, no push, no branch made by the plugin: only the person\'s branch', () => {
    assert.equal(gitT(G.web, 'rev-list', '--count', 'HEAD').stdout.trim(), '1');
    assert.equal(gitT(G.web, 'branch', '--show-current').stdout.trim(), 'feature/export');
  });
});

describe('skills, agents and the guard', () => {
  const R = (p) => fs.readFileSync(path.join(PLUGIN, p), 'utf8');
  test('three worker tiers with the planned models and efforts', () => {
    for (const [n, m, e] of [['light', 'haiku', 'low'], ['standard', 'sonnet', 'medium'], ['deep', 'opus', 'high']]) {
      const t = R(`agents/worker-${n}.md`);
      assert.match(t, new RegExp(`^name: worker-${n}$`, 'm'));
      assert.match(t, new RegExp(`^model: ${m}$`, 'm'));
      assert.match(t, new RegExp(`^effort: ${e}$`, 'm'));
      assert.match(t, /references\/work\/worker-rules\.md/);
    }
  });
  test('the reviewers only read', () => {
    for (const [n, m] of [['code-reviewer', 'sonnet'], ['security-reviewer', 'opus']]) {
      const t = R(`agents/${n}.md`);
      assert.match(t, /^tools: Read, Grep, Glob$/m);
      assert.match(t, new RegExp(`^model: ${m}$`, 'm'));
      assert.match(t, /Summary: <F> findings · <B> blocking/);
    }
  });
  test('the skills never approve, branch, commit or push for the person', () => {
    for (const s of ['task', 'implement', 'review']) {
      const t = R(`skills/${s}/SKILL.md`);
      assert.match(t, /^disable-model-invocation: true$/m);
      assert.match(t, new RegExp(`references/work/${s}-flow\\.md`));
    }
    assert.match(R('skills/task/SKILL.md'), /Never create an APPROVED file, never switch branches/);
    assert.match(R('skills/review/SKILL.md'), /The person commits and pushes/);
    assert.match(R('references/work/worker-rules.md'), /Never install anything/);
  });
  test('the build scripts run in a repo on main', () => {
    for (const c of [`node "$CLAUDE_PLUGIN_ROOT/scripts/work/build.mjs" progress ${BUG} --home "${H}"`, `node "$CLAUDE_PLUGIN_ROOT/scripts/work/build.mjs" changes ${BUG} --home "${H}"`]) {
      assert.equal(runGuard({ tool_name: 'Bash', cwd: H, tool_input: { command: c } }, { env }).decision, 'pass', c);
    }
  });
  test('Claude can never write an APPROVED file', () => {
    assert.equal(runGuard({ tool_name: 'Write', cwd: H, tool_input: { file_path: path.join(H, `sdlc-docs/work/${BUG}/APPROVED`), content: 'plan x' } }, { env }).decision, 'block:self-protection');
  });
});
