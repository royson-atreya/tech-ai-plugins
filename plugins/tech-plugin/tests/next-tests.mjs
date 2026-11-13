// Tests for /tech-plugin:next (scripts/next.mjs): the one next step, worked
// out from the files, on the Laravel + Flutter fixtures that document-tests
// use. Also the skill definition, the banner hint and doctor's "How to use".

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildDocSystem, runScript } from './golden-doc.mjs';
import { PLUGIN } from './fixture.mjs';
import { bodyHash, joinDoc } from '../scripts/lib/frontmatter.mjs';
import { parseYaml } from '../scripts/lib/yaml.mjs';

const D = buildDocSystem();
const { G, H } = D;
after(() => fs.rmSync(G.W, { recursive: true, force: true }));

const S = (p) => path.join(H, 'sdlc-docs', p);
const run = (cwd, env = {}) => runScript('', 'next.mjs', ['--cwd', cwd], env);
const next = (cwd = H, env) => {
  const r = run(cwd, env);
  assert.equal(r.code, 0, r.err || r.out);
  return JSON.parse(r.out);
};
const modules = () => parseYaml(fs.readFileSync(S('modules.yaml'), 'utf8')).modules;

// A document whose stamp matches the current fact pack and inputs, with a status.
function putDoc(id, doc, status, facts, inputs = {}) {
  const body = `# ${id} ${doc}\n\nText.\n`;
  const front = { module: id, doc, title: `${id} ${doc}`, status, date: '2026-11-13', commits: {}, facts, inputs, checked: status === 'Checked' ? { on: '2026-11-13', hash: bodyHash(body), pass: 1 } : null };
  fs.mkdirSync(S(`modules/${id}`), { recursive: true });
  fs.writeFileSync(S(`modules/${id}/${doc}.md`), joinDoc(front, body));
  return bodyHash(body);
}
function putDocs(id, status) {
  const r = runScript('document', 'doc.mjs', ['facts', id, '--home', H]);
  assert.equal(r.code, 0, r.err);
  const facts = JSON.parse(fs.readFileSync(S(`modules/${id}/_facts.json`), 'utf8')).hash;
  const spec = putDoc(id, 'spec', status, facts);
  const brd = putDoc(id, 'brd', status, facts, { spec });
  putDoc(id, 'prd', status, facts, { spec, brd });
}

describe('next: the one next step', () => {
  test('an empty folder: break the code down first', () => {
    const n = next(fs.mkdtempSync(path.join(os.tmpdir(), 'next-empty-')));
    assert.deepEqual([n.next, n.command], ['breakdown', '/tech-plugin:breakdown']);
    assert.match(n.why, /reads your code and splits it into business modules/);
  });
  test('a newer plugin installed: restart first', () => {
    const h = path.join(G.W, 'home-new');
    fs.mkdirSync(path.join(h, '.claude', 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(h, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'tech-plugin@tech-ai-plugins': [{ scope: 'user', version: '99.0.0' }] } }));
    const n = next(H, { HOME: h });
    assert.deepEqual([n.next, n.command], ['restart', null]);
    assert.match(n.why, /start a new session/);
  });
  test('a breakdown that is not finished: finish it', () => {
    const n = next();
    assert.deepEqual([n.next, n.command], ['breakdown', '/tech-plugin:breakdown']);
    assert.match(n.why, /^The breakdown is not finished: /);
  });
  test('(the breakdown is finished for the rest of the tests)', () => D.finishBreakdown());
  test('broken down, nothing drawn: the system diagrams, which need no writing', () => {
    const n = next();
    assert.deepEqual([n.next, n.command], ['diagram', '/tech-plugin:diagram system']);
  });
  test('then the first module in the suggested order, with the progress', () => {
    assert.equal(runScript('diagram', 'diagram.mjs', ['draw', 'system', '--home', H]).code, 0);
    const n = next();
    assert.equal(n.next, 'document');
    const first = n.args;
    assert.equal(n.command, `/tech-plugin:document ${first}`);
    assert.match(n.why, /It has no documents yet\./);
    assert.equal(n.progress, `0 of ${modules().length} modules documented and checked`);
    assert.equal(n.skill, 'document');
  });
  test('documents written but not checked: the same module, saying why', () => {
    const first = next().args;
    putDocs(first, 'Draft');
    const n = next();
    assert.deepEqual([n.next, n.args], ['document', first]);
    assert.match(n.why, /written but not all checked yet/);
  });
  test('documents Checked, no diagrams yet: still that module', () => {
    const first = next().args;
    putDocs(first, 'Checked');
    const n = next();
    assert.deepEqual([n.next, n.args], ['document', first]);
    assert.match(n.why, /Its diagrams are not drawn yet\./);
  });
  test('the code facts changed under a document: sync comes first', () => {
    const first = next().args;
    const f = S(`modules/${first}/spec.md`);
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^facts: .*$/m, 'facts: 0000000000000000'));
    const n = next();
    assert.deepEqual([n.next, n.command], ['sync', '/tech-plugin:sync']);
    assert.match(n.why, new RegExp(`${first} spec`));
    putDocs(first, 'Checked');
  });
  test('a work item waiting for its requirements comes before the next module', () => {
    const req = path.join(G.W, 'request.txt');
    fs.writeFileSync(req, '# Download the pulse report\n\nDoctors want to download the pulse report from the patient page.\n');
    const r = runScript('work', 'work.mjs', ['new', '--request-file', req, '--home', H]);
    assert.equal(r.code, 0, r.err);
    const id = JSON.parse(r.out).id;
    const n = next();
    assert.deepEqual([n.next, n.command], ['impact', `/tech-plugin:impact ${id}`]);
    assert.match(n.why, new RegExp(`Work item ${id} .* is waiting for its impact\\.`));
    fs.rmSync(S(`work/${id}`), { recursive: true, force: true });
  });
  test('the CLI refuses a folder that does not exist', () => {
    const r = run(path.join(G.W, 'nope'));
    assert.equal(r.code, 1);
    assert.match(r.err, /no such folder/);
  });
});

describe('next: skill, banner and doctor', () => {
  const read = (p) => fs.readFileSync(path.join(PLUGIN, p), 'utf8');
  test('the skill runs the script, asks once, then follows the chosen command\'s own instructions', () => {
    const t = read('skills/next/SKILL.md');
    assert.match(t, /^name: next$/m);
    assert.match(t, /^disable-model-invocation: true$/m);
    assert.match(t, /^model: haiku$/m);
    assert.match(t, /scripts\/next\.mjs" --cwd/);
    assert.match(t, /Start\? \(yes\/no\)/);
    assert.match(t, /skills\/<skill>\/SKILL\.md/);
    assert.match(t, /Every rule in them applies/);
  });
  test('the banner points at /tech-plugin:next', () => {
    const r = spawnSync(process.execPath, [path.join(PLUGIN, 'scripts', 'banner.mjs')], { input: JSON.stringify({ cwd: H }), encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN } });
    assert.match(JSON.parse(r.stdout).systemMessage, / \| guard on \| next: \/tech-plugin:next$/);
  });
  test('doctor starts its command list with "How to use"', () => {
    const r = spawnSync(process.execPath, [path.join(PLUGIN, 'scripts', 'doctor.mjs'), '--dir', H], { encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN }, timeout: 120000 });
    assert.match(r.stdout, /\*\*How to use\*\*\n\n1\. Run `\/tech-plugin:next`\./);
    assert.ok(r.stdout.indexOf('**How to use**') < r.stdout.indexOf('**Commands**'));
    assert.match(r.stdout, /- `\/tech-plugin:next` The one command to remember\./);
  });
  test('document writes, checks and draws in one go; --write-only stops after writing', () => {
    const t = read('skills/document/SKILL.md');
    assert.match(t, /three parts: \*\*write\*\*, \*\*check\*\*, \*\*draw\*\*/);
    assert.match(t, /references\/document\/validate-flow\.md/);
    assert.match(t, /references\/diagram\/diagram-flow\.md/);
    assert.match(t, /^argument-hint: "<module> \[spec\|brd\|prd\] \[--write-only\] \[--force\]"$/m);
    assert.match(t, /^allowed-tools: Bash\(node:\*\), Read, Write, Agent$/m);
    assert.doesNotMatch(t, /signoff\.mjs" approve|--layer|Reviewed/);
  });
});
