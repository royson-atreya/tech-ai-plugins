#!/usr/bin/env node
// Testing: /tech-plugin:test-cases and /tech-plugin:test-run. A target is a
// work item (W-001, NT-I42) or a module (patients). Its tests live in
// work/<ID>/tests/ or modules/<id>/tests/:
//   test-cases.md   the cases, each tied to a requirement (written by test-designer)
//   runs/run-NNN/   one folder per run: run.json and one output file per case
//   defects.md      defects drafted from failures (DEF-<X>-NN)
//   test-report.md  the report of the latest run;  rtm.md  the traceability matrix
//
//   node tests.mjs prepare  <target> --home HOME          JSON for test-designer
//   node tests.mjs check    <test-cases.md> --home HOME   the mechanical checks (exit 1 on FAIL)
//   node tests.mjs select   <target> --home HOME [--sanity|--regression] [--env NAME]
//         starts a run: the cases to run, grouped by how they run; refuses a
//         production environment; records each repo's commit
//   node tests.mjs gate     <ID> --open|--close --home HOME
//         a work item's repo tests need the guard's gate: --open writes .active
//         again only when APPROVED still matches the plan and the repo is on a
//         feature branch; --close removes it
//   node tests.mjs ingest   <target> <run> --dir DIR --home HOME
//         reads the result files the runners wrote (DIR/<case>.md, first line
//         "RESULT: pass|fail|skip|blocked"), saves them with keys hidden
//   node tests.mjs record   <target> <run> <case> --result R --input FILE --home HOME   one result
//   node tests.mjs junit    <target> <run> --file results.xml --home HOME
//         results of tests the person ran themselves, matched by each case's **Test:**
//   node tests.mjs defects  <target> <run> --input FILE --home HOME   adds triaged defects
//   node tests.mjs defect   <DEF> --home HOME [--status open|in-fix|fixed|wont-fix|duplicate] [--work ID] [--zoho ID] [--request]
//         --request writes the request of a bug work item that fixes it
//   node tests.mjs report   <target> <run> --home HOME
//         writes test-report.md and rtm.md; a passing run of a work item copies
//         its regression cases into the suites of its modules
//   node tests.mjs status   <target> --home HOME
//
// Never runs a case itself: runners run them through Bash or the browser,
// where the guard sees every call. Never writes to Zoho.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bodyHash, joinDoc, splitDoc } from '../lib/frontmatter.mjs';
import { redact, scanText } from '../lib/redact.mjs';
import { pluginUpdate } from '../lib/version.mjs';
import { PLUGIN_ROOT, commitOf, docsDir, fail, isSecretFor, parseArgs, readJson, real, today, writeDocs } from '../breakdown/common.mjs';
import { loadState } from '../breakdown/state.mjs';
import { loadExisting } from '../breakdown/modules.mjs';
import { loadSystem, loadSystemYaml } from '../breakdown/load.mjs';
import { ROLE_RE, checkCitations, layers } from '../document/check-doc.mjs';
import { docRel, writeFacts } from '../document/doc.mjs';
import { inShort, loadItem, readWorkDoc, reEsc, refresh, workRel } from '../work/work.mjs';
import { GIT_WRITE_RE, INSTALL_RE, TEST_FILE_RE, safeCommandBlocked } from '../work/patterns.mjs';
import { approval } from '../work/build.mjs';

export const TYPES = ['automated', 'api', 'ui', 'manual', 'perf', 'mobile'];
export const RESULTS = ['pass', 'fail', 'skip', 'blocked'];
const DEFECT_STATUS = ['open', 'in-fix', 'fixed', 'wont-fix', 'duplicate'];
const SEVERITY = ['blocking', 'major', 'minor'];
const TOOLS = { perf: 'k6', mobile: 'maestro' };
const SCRIPTS = path.join(PLUGIN_ROOT, 'scripts');

// ------------------------------------------------------------------ targets

export function target(home, name) {
  const n = String(name || '');
  if (!n) fail('name a work item (W-001) or a module (patients)');
  const D = docsDir(home);
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(n) && fs.existsSync(path.join(D, workRel(n, 'request.md')))) {
    const item = loadItem(home, n);
    return { kind: 'work', id: n, dir: workRel(n), title: item.title, prefix: `TC-${n}`, defectPrefix: `DEF-${n}`, modules: item.modules || [], bug: item.kind === 'bug' };
  }
  const my = loadExisting(home);
  const m = my && (my.modules || []).find((x) => x.id === n);
  if (m) return { kind: 'module', id: m.id, dir: path.join('modules', m.id), title: m.name, prefix: `TC-${m.id.toUpperCase()}`, defectPrefix: `DEF-${m.id.toUpperCase()}`, modules: [m.id], bug: false };
  fail(`"${n}" is neither a work item nor a module of this system`);
}

const testsRel = (t, f = '') => path.join(t.dir, 'tests', f);
const runRel = (t, run, f = '') => path.join(t.dir, 'tests', 'runs', run, f);

// The requirements a target's cases cover: [{ id, title }]
export function requirementsOf(home, t) {
  const removed = (s) => /^\s*Removed\b/i.test(s);
  if (t.kind === 'work') {
    if (t.bug) return [{ id: 'the bug', title: 'The bug no longer happens' }];
    const r = readWorkDoc(home, t.id, 'requirement');
    if (!r) return [];
    return [...r.body.matchAll(new RegExp(`^### (${reEsc(t.id)}-R\\d{2,}):(.*)$`, 'gm'))].filter((m) => !removed(m[2])).map((m) => ({ id: m[1], title: m[2].trim() }));
  }
  const f = path.join(docsDir(home), docRel(t.id, 'prd'));
  if (!fs.existsSync(f)) return [];
  const body = fs.readFileSync(f, 'utf8');
  return [...body.matchAll(new RegExp(`^### (${reEsc(t.id.toUpperCase())}-R\\d{2,}):(.*)$`, 'gm'))].filter((m) => !removed(m[2])).map((m) => ({ id: m[1], title: m[2].trim() }));
}

// ------------------------------------------------------------------ cases

// [{ id, title, n, removed, covers: [..], type, tags: [..], repo, command, test, request: { method, path }, steps: [..], expected }]
export function parseCases(body, prefix) {
  const lines = String(body).split('\n');
  const head = new RegExp(`^### (${reEsc(prefix)}-\\d{2,}):(.*)$`);
  const out = [];
  lines.forEach((l, i) => {
    const m = head.exec(l);
    if (!m) return;
    let j = i + 1;
    while (j < lines.length && !/^#{2,3} /.test(lines[j])) j++;
    const text = lines.slice(i + 1, j).join('\n');
    const field = (k) => {
      const f = new RegExp(`^\\*\\*${k}:\\*\\*[ \\t]*(.*)$`, 'm').exec(text);
      return f ? f[1].trim() : null;
    };
    const code = (v) => (v && /^`([^`]+)`/.exec(v) ? /^`([^`]+)`/.exec(v)[1] : null);
    const req = code(field('Request'));
    const rm = req ? /^([A-Z]+)\s+(\S+)/.exec(req) : null;
    const si = text.indexOf('**Steps:**');
    const steps = [];
    if (si !== -1) for (const sl of text.slice(si).split('\n').slice(1)) {
      if (/^\*\*\w/.test(sl.trim())) break;
      const sm = /^\s*\d+\.\s+(.*)$/.exec(sl);
      if (sm) steps.push(sm[1].trim());
    }
    const covers = String(field('Covers') || '').split(/\s*,\s*|\s+and\s+/).map((s) => s.trim()).filter(Boolean);
    const tags = String(field('Tags') || '').toLowerCase().split(/[\s,]+/).filter((x) => x && x !== 'none');
    out.push({ id: m[1], title: m[2].trim(), n: i, removed: /^\s*Removed\b/i.test(m[2]), covers, type: (field('Type') || '').toLowerCase(), tags, repo: field('Repo'), command: code(field('Command')), test: field('Test'), request: rm ? { method: rm[1], path: rm[2] } : null, steps, expected: field('Expected') });
  });
  return out;
}

const live = (cases) => cases.filter((c) => !c.removed);

function casesDoc(home, t) {
  const f = path.join(docsDir(home), testsRel(t, 'test-cases.md'));
  if (!fs.existsSync(f)) return null;
  const text = fs.readFileSync(f, 'utf8');
  const p = splitDoc(text);
  return { f, text, front: p.front || {}, body: p.body, hash: bodyHash(p.body), cases: parseCases(p.body, t.prefix) };
}

function systemRepos(home) {
  const st = loadState(home);
  return new Map(((st && st.repos) || []).map((r) => [r.name, path.resolve(home, r.path)]));
}

function routesOf(home) {
  const out = [];
  try {
    for (const [, a] of loadSystem(home).apps) for (const r of a.routes || []) if (!r.shadowed && r.uri) out.push({ app: a.id, repo: a.repo, method: String(r.method || 'GET').toUpperCase(), uri: String(r.uri).replace(/^\/+/, '') });
  } catch {
    /* no facts: routes are not checked */
  }
  return out;
}

const routeRe = (uri) => new RegExp(`^${uri.split('/').map((s) => (/^\{.*\}$/.test(s) ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')}$`);
const routeMatch = (routes, method, p) => {
  const clean = String(p).split('?')[0].replace(/^https?:\/\/[^/]+/, '').replace(/^\/+/, '').replace(/\/+$/, '');
  return routes.find((r) => (r.method === method || (r.method === 'ANY')) && routeRe(r.uri.replace(/\/+$/, '')).test(clean));
};

// ------------------------------------------------------------------ prepare

function testFiles(repos) {
  const out = {};
  for (const [name, abs] of repos) {
    const g = spawnSync('git', ['-C', abs, 'ls-files'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (g.status !== 0) continue;
    const secret = isSecretFor(abs);
    const files = g.stdout.split('\n').filter((f) => f && TEST_FILE_RE.test(f) && !secret(f) && !/(^|\/)(node_modules|vendor|Pods|\.dart_tool)\//.test(f));
    if (files.length) out[name] = files.slice(0, 200);
  }
  return out;
}

export function environments(home) {
  const b = (loadSystemYaml(home).business || {});
  return (Array.isArray(b.environments) ? b.environments : []).filter((e) => e && e.name).map((e) => ({ name: String(e.name), url: e.url ? String(e.url) : null, production: !!e.production }));
}

export function prepare(home, name) {
  const t = target(home, name);
  const D = docsDir(home);
  const inputs = {};
  const warn = [];
  if (t.kind === 'work') {
    for (const d of ['request', 'requirement', 'design', 'plan', 'handoff']) if (fs.existsSync(path.join(D, workRel(t.id, `${d}.md`)))) inputs[d] = path.join(D, workRel(t.id, `${d}.md`));
    if (!t.bug && !inputs.requirement) fail(`write the requirements first: /tech-plugin:requirement ${t.id}`);
    if (!t.bug) {
      const st = refresh(home, t.id).states.requirement;
      if (!st.approved) warn.push('the requirements are not approved yet: the cases may change with them');
    }
  } else {
    for (const d of ['spec', 'prd']) if (fs.existsSync(path.join(D, docRel(t.id, d)))) inputs[d] = path.join(D, docRel(t.id, d));
    if (!inputs.prd) fail(`a module's cases come from its PRD: write it first with /tech-plugin:document ${t.id}`);
  }
  const out = path.join(D, testsRel(t, 'test-cases.md'));
  const prev = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  if (prev) writeDocs(home, path.join('_state', 'tests', t.id, 'test-cases.prev.md'), prev);
  const reqs = requirementsOf(home, t);
  const front = { target: t.id, scope: t.kind, doc: 'test-cases', title: t.title, status: 'Draft', date: today(), inputs: Object.fromEntries(Object.entries(inputs).map(([k, f]) => [k, bodyHash(fs.readFileSync(f, 'utf8'))])) };
  const modules = {};
  for (const m of t.modules) {
    writeFacts(home, m);
    modules[m] = { facts: path.join(D, 'modules', m, '_facts.md'), suite: fs.existsSync(path.join(D, 'modules', m, 'tests', 'test-cases.md')) ? path.join(D, 'modules', m, 'tests', 'test-cases.md') : null };
  }
  const repos = systemRepos(home);
  const routes = routesOf(home);
  const stack = {};
  for (const [name2, abs] of repos) {
    const s = readJson(path.join(docsDir(abs), '_map', name2, 'stack.json'));
    const cmds = ((s && s.apps) || []).flatMap((a) => (a.commands || []).filter((c) => c.kind === 'test').map((c) => c.cmd));
    if (cmds.length) stack[name2] = cmds;
  }
  const keepIds = [...new Set([...prev.matchAll(new RegExp(`^### (${reEsc(t.prefix)}-\\d{2,}):`, 'gm'))].map((m) => m[1]))];
  const checks = [`node "${path.join(SCRIPTS, 'test', 'tests.mjs')}" check "${out}" --home "${home}"`, `node "${path.join(SCRIPTS, 'document', 'plain.mjs')}" "${out}" --home "${home}"`];
  return {
    target: t.id,
    scope: t.kind,
    bug: t.bug,
    out,
    stamp: joinDoc(front, '').trimEnd(),
    template: path.join(PLUGIN_ROOT, 'references', 'test', 'test-cases-template.md'),
    rules: [path.join(PLUGIN_ROOT, 'references', 'document', 'writing-rules.md'), path.join(PLUGIN_ROOT, 'references', 'test', 'tester-rules.md')],
    inputs,
    requirements: reqs,
    modules,
    routes: routes.slice(0, 300),
    testFiles: testFiles(repos),
    testCommands: stack,
    environments: environments(home).filter((e) => !e.production).map((e) => e.name),
    profile: fs.existsSync(path.join(D, 'profile.md')) ? path.join(D, 'profile.md') : null,
    glossary: path.join(D, 'glossary.md'),
    idPrefix: `${t.prefix}-`,
    keepIds,
    checks,
    warn,
  };
}

// ------------------------------------------------------------------ check

export function templateHeadings() {
  return fs.readFileSync(path.join(PLUGIN_ROOT, 'references', 'test', 'test-cases-template.md'), 'utf8').split('\n').filter((l) => /^## /.test(l)).map((l) => l.trim());
}

export function checkCases(file, home) {
  const R = [];
  const add = (level, name, details = []) => R.push({ level, name, details });
  const text = fs.readFileSync(file, 'utf8');
  let parts;
  try {
    parts = splitDoc(text);
  } catch (e) {
    add('FAIL', 'the stamp parses', [e.message]);
    return R;
  }
  const front = parts.front;
  if (!front) {
    add('FAIL', 'the stamp parses', ['no --- stamp at the top: copy it from the prepare JSON']);
    return R;
  }
  add('PASS', 'the stamp parses');
  const missing = ['target', 'scope', 'doc', 'title', 'status', 'date', 'inputs'].filter((k) => !(k in front));
  add(missing.length ? 'FAIL' : 'PASS', 'stamp fields present', missing.length ? [`missing: ${missing.join(', ')}`] : []);
  if (front.doc !== 'test-cases') {
    add('FAIL', 'stamp doc is test-cases', [`got: ${front.doc}`]);
    return R;
  }
  add(front.status === 'Draft' ? 'PASS' : 'FAIL', 'status is Draft', front.status === 'Draft' ? [] : ['test cases are never approved: the test report shows how they ran']);
  const t = target(home, front.target);
  const off = parts.frontLines;
  const at = (k) => `line ${k + 1 + off}`;
  const want = templateHeadings();
  const got = parts.body.split('\n').filter((l) => /^## /.test(l)).map((l) => l.trim());
  const same = want.length === got.length && want.every((w, i) => w === got[i]);
  add(same ? 'PASS' : 'FAIL', `headings match the test-cases template (${want.length} sections)`, same ? [] : [...want.filter((w) => !got.includes(w)).map((w) => `missing: ${w}`), ...got.filter((g) => !want.includes(g)).map((g) => `not in template: ${g}`)]);
  const { lines, start, end } = layers(parts.body);
  const cases = parseCases(parts.body, t.prefix);
  const lc = live(cases);
  const reqs = requirementsOf(home, t);
  // questions
  const qs = [];
  const qBad = [];
  const qi = lines.findIndex((l) => /^## \d+\. Open questions$/.test(l.trim()));
  for (let k = qi + 1; qi !== -1 && k < lines.length && !/^## /.test(lines[k]); k++) {
    const l = lines[k].trim();
    if (!l || /^none\.?$/i.test(l)) continue;
    const m = /^- \*\*Q(\d+)\*\*\s*\((?:for\s+)?([^)]+)\):\s*\S/.exec(l);
    if (!m) qBad.push(`${at(k)}: write questions as "- **Q1** (for QA): …?"`);
    else if (!m[2].split(/\s*(?:,|\/|\band\b|\bor\b)\s*/).every((r) => ROLE_RE.test(r.trim()))) qBad.push(`${at(k)}: Q${m[1]} names no known role`);
    else qs.push(Number(m[1]));
  }
  add(qBad.length ? 'FAIL' : 'PASS', 'every open question has a number and a role', qBad);
  // In short
  const box = [];
  for (let k = start + 1; k < end && (/^>/.test(lines[k]) || !lines[k].trim()); k++) if (/^>/.test(lines[k])) box.push(lines[k]);
  const val = (key) => {
    const m = new RegExp(`\\*\\*${key}:\\*\\*\\s*(.*)$`).exec(box.find((b) => b.includes(`**${key}:**`)) || '');
    return m ? m[1].trim() : null;
  };
  const boxBad = [];
  for (const k of ['Cases', 'Covers', 'Sanity', 'Regression', 'Open questions']) if (val(k) === null) boxBad.push(`missing: **${k}:**`);
  const num = (k, n) => {
    if (val(k) !== null && parseInt(val(k), 10) !== n) boxBad.push(`In short says ${k} ${val(k)}, the document has ${n}`);
  };
  num('Cases', lc.length);
  num('Sanity', lc.filter((c) => c.tags.includes('sanity')).length);
  num('Regression', lc.filter((c) => c.tags.includes('regression')).length);
  num('Open questions', qs.length);
  add(boxBad.length ? 'FAIL' : 'PASS', '"In short" box complete', boxBad);
  // cases
  const repos = systemRepos(home);
  const routes = routesOf(home);
  const bad = [];
  const ids = cases.map((c) => c.id);
  for (const d of ids.filter((x, i) => ids.indexOf(x) !== i)) bad.push(`${d} is defined twice`);
  const reqIds = new Set(reqs.map((r) => r.id));
  for (const c of lc) {
    if (!TYPES.includes(c.type)) bad.push(`${c.id}: **Type:** is one of ${TYPES.join(', ')}`);
    if (!c.covers.length) bad.push(`${c.id}: needs **Covers:** with the requirement it tests${t.bug ? ' ("the bug")' : ''}`);
    for (const r of c.covers) if (!reqIds.has(r)) bad.push(`${c.id}: covers "${r}", which is not a requirement of ${t.id}`);
    if (!c.expected) bad.push(`${c.id}: needs **Expected:**`);
    for (const g of c.tags) if (!['sanity', 'regression'].includes(g)) bad.push(`${c.id}: tag "${g}": tags are sanity and regression`);
    if (['automated', 'perf', 'mobile'].includes(c.type)) {
      if (!c.repo || !repos.has(c.repo)) bad.push(`${c.id}: **Repo:** names a repo of this system (${[...repos.keys()].join(', ')})`);
      if (!c.command) bad.push(`${c.id}: needs **Command:** in backticks`);
      if (c.command && INSTALL_RE.test(c.command)) bad.push(`${c.id}: the command installs packages; the guard blocks that`);
      if (c.command && GIT_WRITE_RE.test(c.command)) bad.push(`${c.id}: the command runs git`);
      if (c.command && safeCommandBlocked(c.command, PLUGIN_ROOT)) bad.push(`${c.id}: ${safeCommandBlocked(c.command, PLUGIN_ROOT)}`);
      if (c.type === 'perf' && c.command && !/\bk6\b/.test(c.command)) bad.push(`${c.id}: a perf case runs k6`);
      if (c.type === 'mobile' && c.command && !/\bmaestro\b/.test(c.command)) bad.push(`${c.id}: a mobile case runs maestro`);
    }
    if (c.type === 'api') {
      if (!c.request) bad.push(`${c.id}: needs **Request:** \`METHOD /path\``);
      else if (routes.length && !routeMatch(routes, c.request.method, c.request.path)) bad.push(`${c.id}: ${c.request.method} ${c.request.path} is not a route of this system`);
    }
    if (['ui', 'manual', 'api'].includes(c.type) && !c.steps.length) bad.push(`${c.id}: needs **Steps:** as a numbered list`);
  }
  if (!lc.length) add('FAIL', `cases ${t.prefix}-NN present`, [`no "### ${t.prefix}-01: …" headings in Appendix B`]);
  else add(bad.length ? 'FAIL' : 'PASS', `${lc.length} case(s): each with what it covers, its type, its steps or command, and what to expect`, bad);
  const covered = new Set(lc.flatMap((c) => c.covers));
  const uncovered = reqs.filter((r) => !covered.has(r.id)).map((r) => `${r.id} has no case`);
  add(!reqs.length ? 'FAIL' : uncovered.length ? 'FAIL' : 'PASS', `every requirement has a case (${reqs.length})`, reqs.length ? uncovered : [t.kind === 'module' ? 'the PRD has no requirements' : 'no requirements found']);
  if (!lc.some((c) => c.tags.includes('sanity'))) add('WARN', 'a sanity case', ['tag the few cases that prove the main path works: sanity']);
  // previous IDs
  const prevF = path.join(docsDir(home), '_state', 'tests', t.id, 'test-cases.prev.md');
  if (fs.existsSync(prevF)) {
    const lost = [...fs.readFileSync(prevF, 'utf8').matchAll(new RegExp(`^### (${reEsc(t.prefix)}-\\d{2,}):`, 'gm'))].map((m) => m[1]).filter((x) => !ids.includes(x));
    add(lost.length ? 'FAIL' : 'PASS', 'no case ID of the previous version lost', lost.map((x) => `${x} is gone: keep it, or mark it "Removed (reason)"`));
  }
  const cc = checkCitations(lines, home);
  add(cc.bad.length ? 'FAIL' : 'PASS', `all ${cc.count} code citations exist`, cc.bad.slice(0, 20));
  const risks = scanText(text, { skipLines: new Set(Array.from({ length: off }, (_, i) => i + 1)) });
  add(risks.length ? 'FAIL' : 'PASS', 'no key-like strings and no personal data (test data is made up)', risks.map((r) => `line ${r.line}: ${r.type} (value not shown)`));
  return R;
}

// ------------------------------------------------------------------ runs

function listRuns(home, t) {
  const d = path.join(docsDir(home), testsRel(t, 'runs'));
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => /^run-\d{3,}$/.test(f)).sort() : [];
}
const readRun = (home, t, run) => {
  const r = readJson(path.join(docsDir(home), runRel(t, run, 'run.json')));
  if (!r) fail(`no run ${run} for ${t.id}`);
  return r;
};
const saveRun = (home, t, r) => writeDocs(home, runRel(t, r.id, 'run.json'), JSON.stringify(r, null, 1) + '\n');
const has = (tool) => spawnSync('which', [tool], { encoding: 'utf8' }).status === 0;

export function select(home, name, { sanity = false, regression = false, env = null } = {}) {
  const t = target(home, name);
  if (sanity && regression) fail('choose --sanity or --regression, not both');
  const doc = casesDoc(home, t);
  if (!doc) fail(`write the test cases first: /tech-plugin:test-cases ${t.id}`);
  const fails = checkCases(doc.f, home).filter((r) => r.level === 'FAIL');
  if (fails.length) fail(`test-cases.md of ${t.id} does not pass its checks (${fails.map((f) => f.name).join('; ')}): fix it with /tech-plugin:test-cases ${t.id}`);
  const envs = environments(home);
  let e = null;
  if (env) {
    e = envs.find((x) => x.name.toLowerCase() === String(env).toLowerCase());
    if (!e) fail(`no environment "${env}" in system.yaml (${envs.map((x) => x.name).join(', ') || 'none listed'})`);
    if (e.production) fail(`${e.name} is production: tests never run there. Use ${envs.filter((x) => !x.production).map((x) => x.name).join(' or ') || 'a test environment (add one to system.yaml)'}`);
  }
  // the cases: this target's, and for --regression the suites of its modules
  const picked = [];
  const pick = (cases, from) => {
    for (const c of live(cases)) if (!sanity || c.tags.includes('sanity')) if (!regression || c.tags.includes('regression') || from === t.id) picked.push({ ...c, from });
  };
  pick(doc.cases, t.id);
  if (regression && t.kind === 'work') {
    for (const m of t.modules) {
      const mt = target(home, m);
      const md = casesDoc(home, mt);
      if (md) pick(md.cases, m);
    }
  }
  if (!picked.length) fail(`no case matches${sanity ? ' --sanity' : ''}${regression ? ' --regression' : ''}`);
  const n = listRuns(home, t).length + 1;
  const id = `run-${String(n).padStart(3, '0')}`;
  const repos = systemRepos(home);
  const commits = Object.fromEntries([...repos].map(([k, abs]) => [k, commitOf(abs) || null]));
  const groups = { automated: [], api: [], ui: [], manual: [], skipped: [] };
  for (const c of picked) {
    const brief = { id: c.id, title: c.title, from: c.from, type: c.type, covers: c.covers, repo: c.repo, command: c.command, test: c.test, request: c.request, steps: c.steps, expected: c.expected };
    if (['perf', 'mobile'].includes(c.type) && !has(TOOLS[c.type])) groups.skipped.push({ ...brief, why: `${TOOLS[c.type]} is not installed` });
    else if (['api', 'ui'].includes(c.type) && !(e && e.url)) groups.skipped.push({ ...brief, why: e ? `${e.name} has no URL in system.yaml` : 'no environment given (--env)' });
    else groups[['perf', 'mobile'].includes(c.type) ? 'automated' : c.type].push(brief);
  }
  const run = { schema: 1, id, target: t.id, scope: t.kind, filter: sanity ? 'sanity' : regression ? 'regression' : 'all', env: e ? { name: e.name, url: e.url } : null, started: new Date().toISOString(), cases: doc.hash, commits, planned: picked.map((c) => c.id), results: {} };
  for (const s of groups.skipped) run.results[s.id] = { result: 'skip', why: s.why, at: run.started };
  saveRun(home, t, run);
  const D = docsDir(home);
  const resultsDir = path.join(D, '_state', 'test-results', t.id, id);
  fs.mkdirSync(resultsDir, { recursive: true });
  return { target: t.id, scope: t.kind, run: id, env: run.env, filter: run.filter, resultsDir, repos: Object.fromEntries(repos), counts: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])), ...groups };
}

// ------------------------------------------------------------------ the gate for repo tests

export function gate(home, id, { open = false, close = false } = {}) {
  if (open === close) fail('--open or --close');
  const t = target(home, id);
  if (t.kind !== 'work') fail('the gate belongs to a work item; a module\'s repo tests are run by the person');
  if (close) {
    const closed = [];
    for (const [name, abs] of systemRepos(home)) {
      const f = path.join(abs, 'sdlc-docs', 'work', '.active');
      if (fs.existsSync(f) && fs.readFileSync(f, 'utf8').trim() === id) {
        fs.rmSync(f);
        closed.push(name);
      }
    }
    return { work: id, open: false, closed };
  }
  const a0 = approval(home, id);
  const blockers = a0.repos.filter((r) => !r.planMatches || r.protectedBranch).map((r) => `${r.repo}: ${!r.planMatches ? 'APPROVED does not match the plan' : `on protected branch ${r.branch}`}`);
  if (blockers.length) return { work: id, open: false, blockers, message: `The repo tests of ${id} cannot run here (${blockers.join('; ')}). Run them yourself: the commands are listed, and \`tests.mjs junit\` reads a JUnit results file.` };
  const a = approval(home, id, { activate: true });
  return { work: id, open: a.ok, repos: a.repos.map((r) => r.repo), message: a.ok ? `Repo tests may run in ${a.repos.map((r) => r.repo).join(', ')} until the run ends.` : a.message };
}

// ------------------------------------------------------------------ results

export function record(home, name, runId, caseId, { result, input }) {
  const t = target(home, name);
  const run = readRun(home, t, runId);
  if (!RESULTS.includes(result)) fail(`--result is ${RESULTS.join(', ')}`);
  if (!run.planned.includes(caseId)) fail(`${caseId} is not a case of ${runId}`);
  const raw = input && fs.existsSync(input) ? fs.readFileSync(input, 'utf8') : '';
  if (input) fs.rmSync(input, { force: true });
  const rel = runRel(t, runId, `${caseId}.md`);
  writeDocs(home, rel, `> **Case:** ${caseId} · **Result:** ${result} · **Run:** ${runId} · **Date:** ${today()}\n\n${redact(raw).trim()}\n`);
  run.results[caseId] = { result, at: new Date().toISOString(), file: rel };
  saveRun(home, t, run);
  const left = run.planned.filter((c) => !run.results[c]);
  return { case: caseId, result, file: rel, left: left.length };
}

export function ingest(home, name, runId, { dir }) {
  if (!dir || !fs.existsSync(dir)) fail('--dir DIR is required: the folder the runners wrote their results to');
  const t = target(home, name);
  const run = readRun(home, t, runId);
  const done = [];
  const problems = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
    const caseId = f.replace(/\.md$/, '');
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const m = /^\s*RESULT:\s*(pass|fail|skip|blocked)\b/i.exec(text);
    if (!run.planned.includes(caseId)) {
      problems.push(`${f}: not a case of ${runId}`);
      continue;
    }
    if (!m) {
      problems.push(`${f}: the first line is not "RESULT: pass|fail|skip|blocked"`);
      continue;
    }
    record(home, name, runId, caseId, { result: m[1].toLowerCase(), input: path.join(dir, f) });
    done.push(`${caseId} ${m[1].toLowerCase()}`);
  }
  const r = readRun(home, t, runId);
  return { run: runId, recorded: done, problems, left: r.planned.filter((c) => !r.results[c]) };
}

// JUnit XML from tests the person ran: a case matches when its **Test:** names the testcase or its class.
export function junit(home, name, runId, { file }) {
  if (!file || !fs.existsSync(file)) fail('--file results.xml is required');
  const t = target(home, name);
  const run = readRun(home, t, runId);
  const xml = fs.readFileSync(file, 'utf8');
  const tcs = [...xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)].map((m) => {
    const attr = (k) => (new RegExp(`\\b${k}="([^"]*)"`).exec(m[1]) || [])[1] || '';
    const inner = m[3] || '';
    return { name: attr('name'), cls: attr('classname') || attr('class'), result: /<(failure|error)\b/.test(inner) ? 'fail' : /<skipped\b/.test(inner) ? 'skip' : 'pass', text: inner.replace(/<[^>]+>/g, '').trim().slice(0, 2000) };
  });
  const all = [casesDoc(home, t), ...(run.filter === 'regression' && t.kind === 'work' ? t.modules.map((m) => casesDoc(home, target(home, m))) : [])].filter(Boolean).flatMap((d) => live(d.cases));
  const done = [];
  const unmatched = [];
  for (const c of all.filter((x) => run.planned.includes(x.id) && x.test)) {
    const hits = tcs.filter((x) => [x.name, x.cls, `${x.cls}.${x.name}`, `${x.cls}::${x.name}`].some((s) => s && (s === c.test || s.endsWith(c.test) || c.test.endsWith(s))));
    if (!hits.length) {
      unmatched.push(c.id);
      continue;
    }
    const result = hits.some((h) => h.result === 'fail') ? 'fail' : hits.every((h) => h.result === 'skip') ? 'skip' : 'pass';
    const tmp = path.join(docsDir(home), '_state', `junit-${c.id}.md`);
    fs.writeFileSync(tmp, `From ${path.basename(file)}: ${hits.map((h) => `${h.cls ? `${h.cls}.` : ''}${h.name} ${h.result}`).join(', ')}\n\n${hits.filter((h) => h.result === 'fail').map((h) => h.text).join('\n\n')}`);
    record(home, name, runId, c.id, { result, input: tmp });
    done.push(`${c.id} ${result}`);
  }
  return { run: runId, testcases: tcs.length, recorded: done, unmatched };
}

// ------------------------------------------------------------------ defects

const defectsRel = (t) => testsRel(t, 'defects.md');

export function readDefects(home, t) {
  const f = path.join(docsDir(home), defectsRel(t));
  if (!fs.existsSync(f)) return [];
  const text = fs.readFileSync(f, 'utf8');
  const lines = text.split('\n');
  const out = [];
  lines.forEach((l, i) => {
    const m = new RegExp(`^### (${reEsc(t.defectPrefix)}-\\d{2,}):(.*)$`).exec(l);
    if (!m) return;
    let j = i + 1;
    while (j < lines.length && !/^#{2,3} /.test(lines[j])) j++;
    const block = lines.slice(i + 1, j).join('\n');
    const field = (k) => (new RegExp(`^\\*\\*${k}:\\*\\*[ \\t]*(.*)$`, 'm').exec(block) || [])[1] || null;
    out.push({ id: m[1], title: m[2].trim(), status: (field('Status') || 'open').toLowerCase().split(/\s/)[0], severity: (field('Severity') || '').toLowerCase(), case: field('Case'), covers: field('Requirement'), work: field('Fix'), zoho: field('Zoho'), block, start: i, end: j });
  });
  return out;
}

export function addDefects(home, name, runId, { input }) {
  if (!input || !fs.existsSync(input)) fail('--input FILE is required: the triaged defects');
  const t = target(home, name);
  const run = readRun(home, t, runId);
  const raw = fs.readFileSync(input, 'utf8').replace(/\r\n?/g, '\n');
  const risks = scanText(raw);
  if (risks.length) fail(`not saved: the defects hold ${risks.map((r) => r.type).join(', ')} (value not shown). Describe them without the value`);
  const failed = new Set(Object.entries(run.results).filter(([, v]) => v.result === 'fail' || v.result === 'blocked').map(([k]) => k));
  const blocks = raw.split(/\n(?=### )/).filter((b) => /^### /.test(b.trim()));
  if (!blocks.length) fail('no defects in the file: each starts with "### <title>"');
  const have = readDefects(home, t);
  let n = have.reduce((mx, d) => Math.max(mx, Number(d.id.split('-').pop())), 0);
  const added = [];
  const bad = [];
  const out = [];
  for (const b of blocks) {
    const title = /^###\s+(?:DEF-[\w.-]+-\d+:\s*)?(.+)$/m.exec(b.trim())[1].trim();
    const field = (k) => (new RegExp(`^\\*\\*${k}:\\*\\*[ \\t]*(.*)$`, 'm').exec(b) || [])[1] || null;
    const cases = String(field('Case') || '').split(/[\s,]+/).filter(Boolean);
    const sev = String(field('Severity') || '').toLowerCase();
    const p = [];
    if (!cases.length || !cases.every((c) => failed.has(c))) p.push(`"${title}": **Case:** names cases that failed in ${runId}`);
    if (!SEVERITY.includes(sev)) p.push(`"${title}": **Severity:** is ${SEVERITY.join(', ')}`);
    for (const k of ['Requirement', 'Steps', 'Expected', 'Actual']) if (!new RegExp(`^\\*\\*${k}:\\*\\*`, 'm').test(b)) p.push(`"${title}": needs **${k}:**`);
    if (p.length) {
      bad.push(...p);
      continue;
    }
    n++;
    const id = `${t.defectPrefix}-${String(n).padStart(2, '0')}`;
    const body = b.trim().split('\n').slice(1).join('\n').replace(/^\*\*Status:\*\*.*\n?/m, '').trim();
    out.push(`### ${id}: ${title}\n\n**Status:** open\n**Found in:** ${runId}${run.env ? ` on ${run.env.name}` : ''}, ${today()}\n${body}\n`);
    added.push(id);
  }
  if (bad.length) fail(`not saved:\n  - ${bad.join('\n  - ')}`);
  const f = path.join(docsDir(home), defectsRel(t));
  const head = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').replace(/\n*$/, '\n\n') : `# Defects: ${t.title}\n\nDrafted by /tech-plugin:test-run from failed cases. A defect is fixed through a bug work item (/tech-plugin:task <DEF-ID>) and closed when its case passes again. Zoho Sprints items are created only after a person says yes.\n\n`;
  writeDocs(home, defectsRel(t), head + out.join('\n'));
  fs.rmSync(input, { force: true });
  return { added, file: path.join(docsDir(home), defectsRel(t)) };
}

// DEF-W-001-03 -> its target name
export function defectTarget(home, def) {
  const m = /^DEF-(.+)-(\d{2,})$/.exec(String(def));
  if (!m) fail(`"${def}" is not a defect ID (DEF-W-001-01, DEF-PATIENTS-02)`);
  const D = docsDir(home);
  if (fs.existsSync(path.join(D, workRel(m[1], 'request.md')))) return m[1];
  const my = loadExisting(home);
  const mod = my && (my.modules || []).find((x) => x.id.toUpperCase() === m[1]);
  if (mod) return mod.id;
  fail(`no work item or module for ${def}`);
}

export function setDefect(home, name, def, { status = null, work = null, zoho = null, request = false } = {}) {
  const t = target(home, name);
  const all = readDefects(home, t);
  const d = all.find((x) => x.id === def);
  if (!d) fail(`${def} is not in ${t.dir}/tests/defects.md`);
  if (request) {
    // the request of the bug work item that fixes it
    const body = d.block.replace(/^\*\*(Status|Fix|Zoho|Found in):\*\*.*\n?/gm, '').trim();
    writeDocs(home, path.join('_state', 'request-in.md'), `# ${d.title}\n\nDefect ${d.id} of ${t.id}.\n\n${body}\n`);
    return { defect: def, request: path.join(docsDir(home), '_state', 'request-in.md') };
  }
  if (status && !DEFECT_STATUS.includes(status)) fail(`--status is ${DEFECT_STATUS.join(', ')}`);
  const f = path.join(docsDir(home), defectsRel(t));
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  const block = lines.slice(d.start + 1, d.end);
  const set = (k, v) => {
    const i = block.findIndex((l) => new RegExp(`^\\*\\*${k}:\\*\\*`).test(l));
    if (i === -1) block.splice(block.findIndex((l) => /^\*\*Status:\*\*/.test(l)) + 1, 0, `**${k}:** ${v}`);
    else block[i] = `**${k}:** ${v}`;
  };
  if (status) set('Status', status);
  if (work) set('Fix', work);
  if (zoho) set('Zoho', zoho);
  lines.splice(d.start + 1, d.end - d.start - 1, ...block);
  writeDocs(home, defectsRel(t), lines.join('\n'));
  return { defect: def, status: status || d.status, work: work || d.work, zoho: zoho || d.zoho };
}

// ------------------------------------------------------------------ report and RTM

function allCases(home, t, run) {
  const docs = [casesDoc(home, t), ...(run.filter === 'regression' && t.kind === 'work' ? t.modules.map((m) => casesDoc(home, target(home, m))) : [])].filter(Boolean);
  return docs.flatMap((d) => live(d.cases)).filter((c) => run.planned.includes(c.id));
}

export function report(home, name, runId) {
  const t = target(home, name);
  const run = readRun(home, t, runId);
  const cases = allCases(home, t, run);
  const res = (c) => (run.results[c.id] || {}).result || 'not run';
  const count = (r) => cases.filter((c) => res(c) === r).length;
  // a defect whose cases all pass in this run is fixed
  const fixedNow = [];
  for (const d of readDefects(home, t)) {
    if (['fixed', 'wont-fix', 'duplicate'].includes(d.status)) continue;
    const cs = String(d.case || '').split(/[\s,]+/).filter(Boolean);
    if (cs.length && cs.every((c) => run.results[c] && run.results[c].result === 'pass')) {
      setDefect(home, t.id, d.id, { status: 'fixed' });
      fixedNow.push(d.id);
    }
  }
  const defects = readDefects(home, t);
  const open = defects.filter((d) => ['open', 'in-fix'].includes(d.status));
  const blocking = open.filter((d) => d.severity === 'blocking');
  const reqs = requirementsOf(home, t);
  const verdict = count('fail') ? 'Failed' : count('blocked') || count('not run') ? 'Incomplete' : 'Passed';
  const rtmRows = reqs.map((r) => {
    const cs = cases.filter((c) => c.covers.includes(r.id));
    const st = !cs.length ? 'no case run' : cs.some((c) => res(c) === 'fail') ? 'failing' : cs.every((c) => res(c) === 'pass') ? 'passing' : cs.some((c) => res(c) === 'pass') ? 'partly tested' : 'not tested';
    const ds = defects.filter((d) => String(d.covers || '').includes(r.id) || cs.some((c) => String(d.case || '').includes(c.id)));
    return { id: r.id, title: r.title, cases: cs.map((c) => `${c.id} ${res(c)}`), status: st, defects: ds.map((d) => `${d.id} (${d.status})`) };
  });
  const passingReqs = rtmRows.filter((r) => r.status === 'passing').length;
  const commits = Object.entries(run.commits || {}).filter(([, v]) => v).map(([k, v]) => `${k} ${String(v).slice(0, 8)}`).join(', ');
  const stamp = { target: t.id, scope: t.kind, doc: 'test-report', run: run.id, filter: run.filter, env: run.env ? run.env.name : null, date: today(), cases: run.cases, verdict };
  const L = [`# ${t.title}: test report`, '', '> **In short**', `> - **Result:** ${verdict}`, `> - **Cases:** ${cases.length} (${run.filter}): ${count('pass')} passed, ${count('fail')} failed, ${count('skip')} skipped, ${count('blocked')} blocked, ${count('not run')} not run`, `> - **Requirements:** ${passingReqs} of ${reqs.length} passing`, `> - **Defects:** ${open.length} open (${blocking.length} blocking)${fixedNow.length ? `; fixed by this run: ${fixedNow.join(', ')}` : ''}`, `> - **Where:** ${run.env ? `${run.env.name}${run.env.url ? ` (${run.env.url})` : ''}` : 'no environment'}; ${commits || 'commit unknown'}`, ''];
  L.push('## 1. Summary', '');
  L.push(verdict === 'Passed' ? 'Every case that ran passed.' : verdict === 'Failed' ? `${count('fail')} case(s) failed. The defects below say what goes wrong and where.` : 'Some cases did not run or were blocked; see section 4.', '');
  L.push('## 2. Requirements', '', '| Requirement | Cases | Status | Defects |', '|---|---|---|---|');
  for (const r of rtmRows) L.push(`| ${r.id}: ${r.title.replace(/\|/g, '/')} | ${r.cases.join('<br>') || '-'} | ${r.status} | ${r.defects.join(', ') || '-'} |`);
  L.push('', '## 3. Defects', '');
  L.push(...(open.length ? open.map((d) => `- **${d.id}** (${d.severity || '?'}, ${d.status}${d.work ? `, fix: ${d.work}` : ''}${d.zoho ? `, Zoho ${d.zoho}` : ''}): ${d.title}`) : ['None open.']), '');
  L.push('## 4. Not run, and why', '');
  const notRun = cases.filter((c) => ['skip', 'blocked', 'not run'].includes(res(c)));
  L.push(...(notRun.length ? notRun.map((c) => `- ${c.id} (${c.type}): ${res(c)}${(run.results[c.id] || {}).why ? `: ${run.results[c.id].why}` : ''}`) : ['Nothing.']), '');
  L.push('## Appendix A. Results per case', '', '| Case | Type | Tags | Covers | Result | Output |', '|---|---|---|---|---|---|');
  for (const c of cases) {
    const r = run.results[c.id] || {};
    L.push(`| ${c.id}: ${c.title.replace(/\|/g, '/')} | ${c.type} | ${c.tags.join(', ') || '-'} | ${c.covers.join(', ')} | ${res(c)} | ${r.file ? `[output](${path.relative(testsRel(t), r.file)})` : '-'} |`);
  }
  writeDocs(home, testsRel(t, 'test-report.md'), joinDoc(stamp, L.join('\n') + '\n'));
  const complete = rtmRows.every((r) => r.cases.length) && cases.every((c) => res(c) !== 'not run');
  const M = [`# ${t.title}: traceability`, '', `Requirement → test cases → result (${run.id}, ${today()}) → defects. Rebuilt by /tech-plugin:test-run. ${complete ? 'Complete: every requirement has a case, and every case a result.' : 'Not complete: some requirements have no case run, or some cases have no result.'}`, '', '| Requirement | Cases | Status | Defects |', '|---|---|---|---|', ...rtmRows.map((r) => `| ${r.id}: ${r.title.replace(/\|/g, '/')} | ${r.cases.join('<br>') || '-'} | ${r.status} | ${r.defects.join(', ') || '-'} |`), ''];
  writeDocs(home, testsRel(t, 'rtm.md'), M.join('\n'));
  run.finished = new Date().toISOString();
  run.verdict = verdict;
  saveRun(home, t, run);
  const promoted = verdict === 'Passed' && t.kind === 'work' && run.filter === 'all' ? promote(home, t, cases) : { moved: [], waiting: [] };
  if (t.kind === 'work') refresh(home, t.id);
  const D = docsDir(home);
  return { target: t.id, run: run.id, verdict, passed: count('pass'), failed: count('fail'), skipped: count('skip'), blocked: count('blocked'), notRun: count('not run'), openDefects: open.length, blockingDefects: blocking.length, fixedNow, rtmComplete: complete, promoted, report: path.join(D, testsRel(t, 'test-report.md')), rtm: path.join(D, testsRel(t, 'rtm.md')) };
}

// A passing work item's regression cases join its modules' suites. A suite
// covers module requirements, so a case moves only when the requirement it
// covers names the module requirement it changes ("**Changes:** PATIENTS-R02");
// a case for a new requirement waits until the PRD has it. Only modules that
// already have a suite; the case keeps a note of where it came from.
function promote(home, t, cases) {
  const out = { moved: [], waiting: [] };
  const doc = casesDoc(home, t);
  const ran = new Set(cases.map((c) => c.id));
  const reg = live(doc.cases).filter((c) => c.tags.includes('regression') && ran.has(c.id));
  if (!reg.length || t.bug) return out;
  const rq = readWorkDoc(home, t.id, 'requirement');
  const changes = new Map();
  if (rq) for (const m of rq.body.matchAll(new RegExp(`^### (${reEsc(t.id)}-R\\d{2,}):[\\s\\S]*?(?=^### |^## |(?![\\s\\S]))`, 'gm'))) {
    const ch = (/^\*\*Changes:\*\*(.*)$/m.exec(m[0]) || ['', ''])[1];
    changes.set(m[1], [...ch.matchAll(/\b([A-Z][A-Z0-9-]*?-R\d{2,})\b/g)].map((x) => x[1]));
  }
  for (const m of t.modules) {
    const mt = target(home, m);
    const md = casesDoc(home, mt);
    if (!md) continue;
    const modReqs = new Set(requirementsOf(home, mt).map((r) => r.id));
    const already = new Set([...md.text.matchAll(/^\*\*From:\*\* (TC-[\w.-]+)/gm)].map((x) => x[1]));
    let n = md.cases.reduce((mx, c) => Math.max(mx, Number(c.id.split('-').pop())), 0);
    const add = [];
    const lines = doc.body.split('\n');
    for (const c of reg) {
      if (already.has(c.id)) continue;
      const covers = [...new Set(c.covers.flatMap((r) => changes.get(r) || []))].filter((r) => modReqs.has(r));
      if (!covers.length) {
        out.waiting.push(`${c.id} (${m}): its requirement is new, or not a requirement of ${m}'s PRD yet; add it to the PRD (/tech-plugin:sync after the merge), then run the item's tests again`);
        continue;
      }
      let j = c.n + 1;
      while (j < lines.length && !/^#{2,3} /.test(lines[j])) j++;
      n++;
      const nid = `${mt.prefix}-${String(n).padStart(2, '0')}`;
      const block = lines.slice(c.n + 1, j).join('\n').replace(/^\*\*Covers:\*\*.*$/m, `**Covers:** ${covers.join(', ')}`).trim();
      add.push(`### ${nid}: ${c.title}\n\n**From:** ${c.id} (${t.id})\n${block}\n`);
      out.moved.push(`${c.id} → ${nid}`);
    }
    if (!add.length) continue;
    let text = md.text.replace(/\n*$/, '\n');
    const at = text.indexOf('\n## Document control');
    text = at === -1 ? `${text}\n${add.join('\n')}` : `${text.slice(0, at).replace(/\n*$/, '\n\n')}${add.join('\n')}${text.slice(at)}`;
    const p = splitDoc(text);
    const lc = live(parseCases(p.body, mt.prefix));
    const body = p.body.replace(/^(>\s*-\s*\*\*Cases:\*\*\s*)\d+/m, `$1${lc.length}`).replace(/^(>\s*-\s*\*\*Regression:\*\*\s*)\d+/m, `$1${lc.filter((c) => c.tags.includes('regression')).length}`).replace(/^(>\s*-\s*\*\*Sanity:\*\*\s*)\d+/m, `$1${lc.filter((c) => c.tags.includes('sanity')).length}`);
    writeDocs(home, testsRel(mt, 'test-cases.md'), joinDoc(p.front, body));
  }
  return out;
}

// ------------------------------------------------------------------ status

export function testState(home, name) {
  const t = target(home, name);
  const doc = casesDoc(home, t);
  const runs = listRuns(home, t);
  const last = runs.length ? readJson(path.join(docsDir(home), runRel(t, runs[runs.length - 1], 'run.json'))) : null;
  const rep = fs.existsSync(path.join(docsDir(home), testsRel(t, 'test-report.md'))) ? splitDoc(fs.readFileSync(path.join(docsDir(home), testsRel(t, 'test-report.md')), 'utf8')).front : null;
  const defects = readDefects(home, t);
  const open = defects.filter((d) => ['open', 'in-fix'].includes(d.status));
  const reportCurrent = !!(rep && doc && rep.cases === doc.hash && last && rep.run === last.id && rep.filter === 'all');
  return {
    target: t.id,
    cases: doc ? { exists: true, count: live(doc.cases).length, hash: doc.hash } : { exists: false },
    lastRun: last ? { id: last.id, filter: last.filter, env: last.env ? last.env.name : null, verdict: last.verdict || null, finished: !!last.finished } : null,
    report: rep ? { run: rep.run, verdict: rep.verdict, current: reportCurrent } : null,
    openDefects: open.map((d) => ({ id: d.id, severity: d.severity, status: d.status, work: d.work })),
  };
}

// ------------------------------------------------------------------ main

function main() {
  const [cmd] = process.argv.slice(2);
  const a = parseArgs(process.argv.slice(3), ['sanity', 'regression', 'open', 'close', 'request']);
  const usage = 'usage: tests.mjs <prepare|check|select|gate|ingest|record|junit|defects|defect|report|status> … --home HOME';
  if (!a.home) fail(usage);
  const home = real(a.home);
  if (!fs.existsSync(docsDir(home))) fail(`${home} has no sdlc-docs/; run /tech-plugin:breakdown first`);
  const out = (v) => process.stdout.write(JSON.stringify(v, null, 2) + '\n');
  const [x, y, z] = a._;
  if (cmd === 'check') {
    if (!x || !fs.existsSync(x)) fail('usage: tests.mjs check <test-cases.md> --home HOME');
    const R = checkCases(real(x), home);
    const L = [];
    for (const r of R) {
      L.push(`${r.level.padEnd(5)} ${r.name}`);
      for (const d of r.details) L.push(`        ${d}`);
    }
    const fails = R.filter((r) => r.level === 'FAIL').length;
    L.push(fails ? `check-tests: ${fails} check(s) failed` : 'check-tests: PASS');
    process.stdout.write(L.join('\n') + '\n');
    process.exitCode = fails ? 1 : 0;
    return;
  }
  if (cmd === 'status') return out(testState(home, x));
  const upd = pluginUpdate(PLUGIN_ROOT);
  if (upd) fail(upd.message);
  if (cmd === 'prepare') return out(prepare(home, x));
  if (cmd === 'select') return out(select(home, x, { sanity: !!a.sanity, regression: !!a.regression, env: a.env || null }));
  if (cmd === 'gate') return out(gate(home, x, { open: !!a.open, close: !!a.close }));
  if (cmd === 'ingest') return out(ingest(home, x, y, { dir: a.dir ? real(a.dir) : null }));
  if (cmd === 'record') return out(record(home, x, y, z, { result: a.result, input: a.input ? real(a.input) : null }));
  if (cmd === 'junit') return out(junit(home, x, y, { file: a.file ? real(a.file) : null }));
  if (cmd === 'defects') return out(addDefects(home, x, y, { input: a.input ? real(a.input) : null }));
  if (cmd === 'defect') return out(setDefect(home, defectTarget(home, x), x, { status: a.status || null, work: a.work || null, zoho: a.zoho || null, request: !!a.request }));
  if (cmd === 'report') return out(report(home, x, y));
  fail(usage);
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) main();
