#!/usr/bin/env node
// /tech-plugin:release. A release is a folder, releases/<version>/:
//   checklist.md      ready-to-go lines worked out by script (✅ ⚠️ ❌) plus manual ones
//   release-notes.md  what is new and fixed, in plain words (written by ops-writer)
//   runbook.md        deploy steps, rollback steps (ops-writer, from the flags below)
//   smoke.md          quick checks a person does by hand on production after deploying
//   go-no-go.md       release-reviewer's recommendation
//   release.json      the items, the flags, the state
//
//   node release.mjs status  --home HOME
//         tested work items not released yet, the releases so far, the last tag
//   node release.mjs check   [version] [W-001 …] --home HOME [--ref main]
//         the checklist: every item tested on its current cases with no open
//         blocking defect, its branch merged into the release branch (or its
//         files equal there after a squash merge), and the flags its changes
//         raise: migrations, settings, dependencies, documents out of date.
//         Writes checklist.md, smoke.md and release.json. Version: the next
//         one after the last tag (patch for bug fixes only, minor otherwise)
//   node release.mjs prepare <version> --home HOME    JSON for ops-writer
//   node release.mjs check-docs <version> --home HOME notes and runbook checks (exit 1 on FAIL)
//   node release.mjs save-review <version> --input FILE --home HOME
//         saves go-no-go.md; "Go" is refused while the checklist has a ❌
//   node release.mjs finish  <version> --home HOME
//         marks the items released and gives the tag commands for the person
//
// Never deploys, tags, pushes or touches production: a person does.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { joinDoc, splitDoc } from '../lib/frontmatter.mjs';
import { scanText } from '../lib/redact.mjs';
import { pluginUpdate } from '../lib/version.mjs';
import { PLUGIN_ROOT, docsDir, fail, parseArgs, readJson, real, today, writeDocs } from '../breakdown/common.mjs';
import { loadState, status as breakdownStatus } from '../breakdown/state.mjs';
import { list as workItems, loadItem, readWorkDoc, refresh, workRel } from '../work/work.mjs';
import { parseCases, target as testTarget, testState } from '../test/tests.mjs';

const SCRIPTS = path.join(PLUGIN_ROOT, 'scripts');
const relRel = (v, f = '') => path.join('releases', v, f);
export const MIGRATION_RE = /(^|\/)(database\/migrations|migrations|alembic\/versions|prisma\/migrations|db\/migrate)\/|\.sql$/i;
export const SETTINGS_RE = /(^|\/)\.env\.(example|sample|dist)$|(^|\/)config\/[^/]+\.(php|js|ts|json|ya?ml)$|(^|\/)settings\.py$|(^|\/)application\.(ya?ml|properties)$/i;
export const DEPS_RE = /(^|\/)(composer\.json|composer\.lock|package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|pubspec\.yaml|pubspec\.lock|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|Gemfile|Gemfile\.lock|go\.mod|pom\.xml|build\.gradle(\.kts)?)$/i;
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

const git = (abs, args) => spawnSync('git', ['-C', abs, ...args], { encoding: 'utf8' });

function systemRepos(home) {
  const st = loadState(home);
  return new Map(((st && st.repos) || []).map((r) => [r.name, path.resolve(home, r.path)]));
}

export function releasesDone(home) {
  const d = path.join(docsDir(home), 'releases');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).map((v) => ({ version: v, ...(readJson(path.join(d, v, 'release.json')) || {}) })).filter((r) => r.items);
}

function lastTag(abs) {
  const r = git(abs, ['describe', '--tags', '--abbrev=0']);
  return r.status === 0 ? r.stdout.trim() : null;
}

export function nextVersion(home, kinds) {
  const tags = [...systemRepos(home).values()].map(lastTag).filter(Boolean).map((t) => t.replace(/^v/, '')).filter((t) => VERSION_RE.test(t));
  const known = [...tags, ...releasesDone(home).map((r) => r.version)].filter((v) => VERSION_RE.test(v));
  const cmp = (a, b) => a.split(/[.-]/).slice(0, 3).map(Number).reduce((s, x, i) => s || x - b.split(/[.-]/).slice(0, 3).map(Number)[i], 0);
  const last = known.sort(cmp).pop() || '0.0.0';
  const [ma, mi, pa] = last.split(/[.-]/).slice(0, 3).map(Number);
  return { last, next: kinds.every((k) => k === 'bug') && kinds.length ? `${ma}.${mi}.${pa + 1}` : `${ma}.${mi + 1}.0` };
}

export function releaseStatus(home) {
  const items = workItems(home).items;
  const released = new Set(releasesDone(home).filter((r) => r.state === 'released').flatMap((r) => r.items.map((i) => i.id)));
  const ready = items.filter((i) => i.next === 'tested' && !released.has(i.id));
  return { ready: ready.map((i) => ({ id: i.id, title: i.title, kind: i.kind || 'feature' })), releases: releasesDone(home).map((r) => ({ version: r.version, state: r.state, items: r.items.map((i) => i.id), date: r.date })) };
}

// ------------------------------------------------------------------ check

function defaultRef(abs) {
  const h = git(abs, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (h.status === 0 && h.stdout.trim()) return h.stdout.trim();
  for (const b of ['main', 'master']) if (git(abs, ['rev-parse', '--verify', '--quiet', b]).status === 0) return b;
  return 'HEAD';
}

function mergedState(abs, branch, files, ref, base) {
  if (!branch) return { ok: null, why: 'the branch it was built on is not recorded' };
  const tip = git(abs, ['rev-parse', '--verify', '--quiet', `${branch}^{commit}`]);
  if (tip.status !== 0) return { ok: null, why: `branch ${branch} is gone (deleted after the merge?): confirm by hand that it is in ${ref}` };
  if (base && tip.stdout.trim() === base) return { ok: false, why: `nothing is committed on ${branch} yet: commit the change (the handoff has the commands), merge it, then check again` };
  if (git(abs, ['merge-base', '--is-ancestor', branch, ref]).status === 0) return { ok: true, why: `merged into ${ref}` };
  if (files.length && git(abs, ['diff', '--quiet', branch, ref, '--', ...files]).status === 0) return { ok: true, why: `its files in ${ref} are the same as on ${branch} (squash merge)` };
  return { ok: false, why: `${branch} is not merged into ${ref}` };
}

export function check(home, { version = null, items = [], ref = null } = {}) {
  const st = releaseStatus(home);
  const all = workItems(home).items;
  const pick = items.length ? items : st.ready.map((i) => i.id);
  if (!pick.length) fail('no work item is ready to release: an item is ready when /tech-plugin:test-run reports it Passed (status "tested")');
  const repos = systemRepos(home);
  const released = new Set(releasesDone(home).filter((r) => r.state === 'released').flatMap((r) => r.items.map((i) => i.id)));
  const lines = [];
  const add = (mark, text, item = null) => lines.push({ mark, text, item });
  const out = [];
  const flags = { migrations: [], settings: [], dependencies: [] };
  const touched = new Set();
  for (const id of pick) {
    const it = all.find((x) => x.id === id);
    if (!it) fail(`no work item ${id}`);
    const item = loadItem(home, id);
    const r = refresh(home, id);
    const ts = r.testState;
    const ho = readWorkDoc(home, id, 'handoff');
    const ch = readJson(path.join(docsDir(home), '_state', 'work', id, 'changes.json'));
    const files = (ch && ch.files) || [];
    for (const f of files) {
      touched.add(f.repo);
      const k = `${f.repo}:${f.path}`;
      if (MIGRATION_RE.test(f.path)) flags.migrations.push({ item: id, file: k });
      if (SETTINGS_RE.test(f.path)) flags.settings.push({ item: id, file: k });
      if (DEPS_RE.test(f.path)) flags.dependencies.push({ item: id, file: k });
    }
    if (released.has(id)) add('❌', `${id} is already in a release`, id);
    if (!ho) add('❌', `${id} has no handoff: build and review it first (${r.nextText})`, id);
    if (!ts || !ts.report) add('❌', `${id} has no test report: /tech-plugin:test-run ${id}`, id);
    else if (!ts.report.current) add('❌', `${id}: the test report is not for its current test cases, or not a full run: /tech-plugin:test-run ${id}`, id);
    else if (ts.report.verdict !== 'Passed') add('❌', `${id}: the last full test run is ${ts.report.verdict}`, id);
    else add('✅', `${id} tested: the last full run passed`, id);
    const open = ts ? ts.openDefects : [];
    const blocking = open.filter((d) => d.severity === 'blocking');
    if (blocking.length) add('❌', `${id}: open blocking defect(s) ${blocking.map((d) => d.id).join(', ')}`, id);
    else if (open.length) add('⚠️', `${id}: known issue(s) ${open.map((d) => `${d.id} (${d.severity})`).join(', ')} go out with this release`, id);
    for (const repo of new Set(files.map((f) => f.repo))) {
      const abs = repos.get(repo);
      if (!abs) continue;
      const rf = ref || defaultRef(abs);
      const plan = readWorkDoc(home, id, 'plan');
      const base = plan && plan.front.repos && plan.front.repos[repo] ? plan.front.repos[repo].base : null;
      const m = mergedState(abs, ho && ho.front.branches ? ho.front.branches[repo] : null, files.filter((f) => f.repo === repo && f.status !== 'deleted').map((f) => f.path), rf, base);
      add(m.ok === true ? '✅' : m.ok === false ? '❌' : '⚠️', `${id} in ${repo}: ${m.why}`, id);
    }
    out.push({ id, title: item.title, kind: item.kind || 'feature', level: item.level || null, modules: item.modules || [], files: files.length, handoff: ho ? path.join(docsDir(home), workRel(id, 'handoff.md')) : null, report: ts && ts.report ? path.join(docsDir(home), workRel(id, 'tests/test-report.md')) : null, openDefects: open });
  }
  if (flags.migrations.length) add('⚠️', `database changes: ${flags.migrations.map((f) => `\`${f.file}\``).join(', ')}. Back up the database before deploying; the runbook has the migration and its rollback`);
  if (flags.settings.length) add('⚠️', `new or changed settings: ${flags.settings.map((f) => `\`${f.file}\``).join(', ')}. Set them on the server before deploying`);
  if (flags.dependencies.length) add('⚠️', `dependencies changed: ${flags.dependencies.map((f) => `\`${f.file}\``).join(', ')}. The runbook installs them on the server`);
  const bd = breakdownStatus(home);
  if (bd.next !== 'up-to-date') add('⚠️', 'the documents may not match the merged code yet: run /tech-plugin:breakdown --refresh, then /tech-plugin:sync');
  const kinds = out.map((i) => i.kind);
  const nv = nextVersion(home, kinds);
  const v = version || nv.next;
  if (!VERSION_RE.test(v)) fail(`"${v}" is not a version like 1.4.0`);
  const prev = readJson(path.join(docsDir(home), relRel(v, 'release.json')));
  if (prev && prev.state === 'released') fail(`release ${v} is already finished; give a new version`);
  const ready = !lines.some((l) => l.mark === '❌');
  // smoke: the sanity cases of the items and their modules, done by hand on production
  const smoke = [];
  const seen = new Set();
  for (const it of out) {
    for (const t of [it.id, ...it.modules]) {
      if (seen.has(t)) continue;
      seen.add(t);
      let tt;
      try {
        tt = testTarget(home, t);
      } catch {
        continue;
      }
      const f = path.join(docsDir(home), tt.dir, 'tests', 'test-cases.md');
      if (!fs.existsSync(f)) continue;
      for (const c of parseCases(splitDoc(fs.readFileSync(f, 'utf8')).body, tt.prefix).filter((c) => !c.removed && c.tags.includes('sanity') && ['ui', 'manual', 'api'].includes(c.type))) smoke.push({ id: c.id, title: c.title, steps: c.steps, expected: c.expected });
    }
  }
  const rel = { schema: 1, version: v, date: today(), state: ready ? 'ready' : 'not ready', ref: ref || null, items: out, flags, lines };
  writeDocs(home, relRel(v, 'release.json'), JSON.stringify(rel, null, 1) + '\n');
  const C = [`# Release ${v}: ready to go?`, '', `> **${ready ? 'Ready' : 'Not ready'}.** Worked out by /tech-plugin:release on ${today()}. ❌ stops the release; ⚠️ needs care. Nobody signs this off: the person who deploys decides.`, '', '## Checked by the plugin', '', ...lines.map((l) => `- ${l.mark} ${l.text}`), '', '## Before you deploy', '', '- [ ] The release notes are read by the owner or PO.', ...(flags.migrations.length ? ['- [ ] A backup of the production database is taken, and you know how to restore it.'] : []), ...(flags.settings.length ? ['- [ ] The new settings are set on the server.'] : []), '- [ ] You know the rollback steps in the runbook.', '', '## After you deploy', '', '- [ ] The smoke checks in [smoke.md](smoke.md) pass.', '- [ ] Run /tech-plugin:release ' + v + ' again and finish it.', ''];
  writeDocs(home, relRel(v, 'checklist.md'), C.join('\n'));
  const SM = [`# Release ${v}: smoke checks`, '', 'Quick checks **you** do by hand on production right after deploying. Only look and click through: never create, change or delete real data, and never type real people\'s data. tech-plugin never tests production itself.', ''];
  if (!smoke.length) SM.push('No sanity cases to take them from. Open the main screens and check they load.', '');
  for (const s of smoke) SM.push(`## ${s.title} (${s.id})`, '', ...s.steps.map((x, i) => `${i + 1}. ${x}`), '', `Expected: ${s.expected || '-'}`, '', '- [ ] passes', '');
  writeDocs(home, relRel(v, 'smoke.md'), SM.join('\n'));
  const D = docsDir(home);
  return { version: v, proposed: nv, ready, items: out.map((i) => i.id), lines, flags, smoke: smoke.length, checklist: path.join(D, relRel(v, 'checklist.md')), smokeFile: path.join(D, relRel(v, 'smoke.md')) };
}

// ------------------------------------------------------------------ notes and runbook

function readRelease(home, v) {
  const r = readJson(path.join(docsDir(home), relRel(v, 'release.json')));
  if (!r) fail(`no release ${v} yet: run the check first (release.mjs check ${v})`);
  return r;
}

export function prepare(home, v) {
  const r = readRelease(home, v);
  const D = docsDir(home);
  const items = r.items.map((i) => ({ ...i, request: path.join(D, workRel(i.id, 'request.md')), requirement: fs.existsSync(path.join(D, workRel(i.id, 'requirement.md'))) ? path.join(D, workRel(i.id, 'requirement.md')) : null, plan: path.join(D, workRel(i.id, 'plan.md')) }));
  const out = { notes: path.join(D, relRel(v, 'release-notes.md')), runbook: path.join(D, relRel(v, 'runbook.md')) };
  return {
    version: v,
    state: r.state,
    items,
    flags: r.flags,
    checklist: path.join(D, relRel(v, 'checklist.md')),
    profile: fs.existsSync(path.join(D, 'profile.md')) ? path.join(D, 'profile.md') : null,
    repos: Object.fromEntries(systemRepos(home)),
    templates: { notes: path.join(PLUGIN_ROOT, 'references', 'release', 'release-notes-template.md'), runbook: path.join(PLUGIN_ROOT, 'references', 'release', 'runbook-template.md') },
    rules: [path.join(PLUGIN_ROOT, 'references', 'document', 'writing-rules.md'), path.join(PLUGIN_ROOT, 'references', 'release', 'ops-rules.md')],
    out,
    checks: [`node "${path.join(SCRIPTS, 'release', 'release.mjs')}" check-docs ${v} --home "${home}"`, `node "${path.join(SCRIPTS, 'document', 'plain.mjs')}" "${out.notes}" --home "${home}"`],
  };
}

const headingsOf = (f) => fs.readFileSync(f, 'utf8').split('\n').filter((l) => /^## /.test(l)).map((l) => l.trim());

export function checkDocs(home, v) {
  const r = readRelease(home, v);
  const R = [];
  const add = (level, name, details = []) => R.push({ level, name, details });
  const D = docsDir(home);
  for (const [doc, tpl] of [['release-notes', 'release-notes-template.md'], ['runbook', 'runbook-template.md']]) {
    const f = path.join(D, relRel(v, `${doc}.md`));
    if (!fs.existsSync(f)) {
      add('FAIL', `${doc}.md written`, [`missing: ${f}`]);
      continue;
    }
    const text = fs.readFileSync(f, 'utf8');
    const want = headingsOf(path.join(PLUGIN_ROOT, 'references', 'release', tpl));
    const got = text.split('\n').filter((l) => /^## /.test(l)).map((l) => l.trim());
    const same = want.length === got.length && want.every((w, i) => w === got[i]);
    add(same ? 'PASS' : 'FAIL', `${doc}: headings match the template`, same ? [] : [...want.filter((w) => !got.includes(w)).map((w) => `missing: ${w}`), ...got.filter((g) => !want.includes(g)).map((g) => `not in template: ${g}`)]);
    const risks = scanText(text);
    add(risks.length ? 'FAIL' : 'PASS', `${doc}: no key-like strings and no personal data`, risks.map((x) => `line ${x.line}: ${x.type} (value not shown)`));
    if (doc === 'release-notes') {
      const missing = r.items.filter((i) => !text.includes(i.id)).map((i) => `${i.id} is not mentioned`);
      add(missing.length ? 'FAIL' : 'PASS', `release notes mention every item (${r.items.length})`, missing);
      const known = r.items.flatMap((i) => i.openDefects || []).filter((d) => !text.includes(d.id)).map((d) => `${d.id} is a known issue: list it`);
      add(known.length ? 'FAIL' : 'PASS', 'every known issue is listed', known);
    } else {
      const low = text.toLowerCase();
      const need = [];
      if (!/^## \d+\. Rollback/m.test(text) || !/^\s*\d+\.\s+\S/m.test(text.split(/^## \d+\. Rollback/m)[1] || '')) need.push('the rollback section has numbered steps');
      if (r.flags.migrations.length && !(low.includes('backup') && low.includes('migrat'))) need.push('database changes: a backup step, the migration and how to roll it back');
      if (r.flags.dependencies.length && !/install/.test(low)) need.push('dependencies changed: the install step on the server');
      if (r.flags.settings.length && !/setting|\.env|config/.test(low)) need.push('settings changed: which settings to set');
      if (/\b(prod|production)\b[^\n]*\b(drop|truncate|delete from)\b/i.test(text)) need.push('never drop, truncate or delete production data in a runbook');
      add(need.length ? 'FAIL' : 'PASS', 'runbook covers rollback and every flag of this release', need);
    }
  }
  return R;
}

// ------------------------------------------------------------------ go / no go

export function saveReview(home, v, { input }) {
  if (!input || !fs.existsSync(input)) fail('--input FILE is required');
  const r = readRelease(home, v);
  const raw = fs.readFileSync(input, 'utf8');
  const m = /^Recommendation:\s*(Go with conditions|No go|Go)\b/im.exec(raw);
  if (!m) fail('the review has no "Recommendation: Go | Go with conditions | No go" line');
  if (r.state !== 'ready' && m[1] !== 'No go') fail(`not saved: the checklist of ${v} has ❌ lines, so the recommendation can only be "No go"`);
  const risks = scanText(raw);
  if (risks.length) fail(`not saved: the review holds ${risks.map((x) => x.type).join(', ')} (value not shown)`);
  fs.rmSync(input, { force: true });
  writeDocs(home, relRel(v, 'go-no-go.md'), `> **Release:** ${v} · **Date:** ${today()} · **By:** release-reviewer (a recommendation; the person who deploys decides)\n\n${raw.trim()}\n`);
  return { version: v, recommendation: m[1], file: path.join(docsDir(home), relRel(v, 'go-no-go.md')) };
}

// ------------------------------------------------------------------ finish

export function finish(home, v) {
  const r = readRelease(home, v);
  if (r.state === 'released') fail(`release ${v} is already finished`);
  if (r.state !== 'ready') fail(`release ${v} is not ready (its checklist has ❌ lines): fix them and run the check again`);
  const fails = checkDocs(home, v).filter((x) => x.level === 'FAIL');
  if (fails.length) fail(`the release notes or runbook of ${v} do not pass their checks: ${fails.map((x) => x.name).join('; ')}`);
  const repos = systemRepos(home);
  const used = [...new Set(r.items.flatMap((i) => {
    const ch = readJson(path.join(docsDir(home), '_state', 'work', i.id, 'changes.json'));
    return ((ch && ch.files) || []).map((f) => f.repo);
  }))];
  const commands = used.filter((n) => repos.has(n)).map((n) => {
    const abs = repos.get(n);
    const ref = r.ref || defaultRef(abs);
    return `git -C '${abs}' tag -a v${v} -m "Release ${v}" ${ref} && git -C '${abs}' push origin v${v}`;
  });
  for (const i of r.items) {
    const f = path.join(docsDir(home), workRel(i.id, 'status.json'));
    const st = readJson(f) || {};
    writeDocs(home, workRel(i.id, 'status.json'), JSON.stringify({ ...st, released: { version: v, date: today() } }, null, 1) + '\n');
    refresh(home, i.id);
  }
  const done = { ...r, state: 'released', finished: today() };
  writeDocs(home, relRel(v, 'release.json'), JSON.stringify(done, null, 1) + '\n');
  return { version: v, items: r.items.map((i) => i.id), commands, message: `Release ${v} is recorded. Tag it yourself (tech-plugin never tags or pushes):\n${commands.map((c) => `  ${c}`).join('\n')}` };
}

// ------------------------------------------------------------------ main

function main() {
  const [cmd] = process.argv.slice(2);
  const a = parseArgs(process.argv.slice(3));
  const usage = 'usage: release.mjs <status|check|prepare|check-docs|save-review|finish> [version] [items…] --home HOME';
  if (!a.home) fail(usage);
  const home = real(a.home);
  if (!fs.existsSync(docsDir(home))) fail(`${home} has no sdlc-docs/; run /tech-plugin:breakdown first`);
  const out = (v) => process.stdout.write(JSON.stringify(v, null, 2) + '\n');
  if (cmd === 'status') return out(releaseStatus(home));
  if (cmd === 'check-docs') {
    const R = checkDocs(home, a._[0]);
    const L = [];
    for (const r of R) {
      L.push(`${r.level.padEnd(5)} ${r.name}`);
      for (const d of r.details) L.push(`        ${d}`);
    }
    const fails = R.filter((r) => r.level === 'FAIL').length;
    L.push(fails ? `check-release: ${fails} check(s) failed` : 'check-release: PASS');
    process.stdout.write(L.join('\n') + '\n');
    process.exitCode = fails ? 1 : 0;
    return;
  }
  const upd = pluginUpdate(PLUGIN_ROOT);
  if (upd) fail(upd.message);
  if (cmd === 'check') {
    const [first, ...rest] = a._;
    const version = first && VERSION_RE.test(first) ? first : null;
    const items = version ? rest : a._;
    return out(check(home, { version, items, ref: a.ref || null }));
  }
  if (cmd === 'prepare') return out(prepare(home, a._[0]));
  if (cmd === 'save-review') return out(saveReview(home, a._[0], { input: a.input ? real(a.input) : null }));
  if (cmd === 'finish') return out(finish(home, a._[0]));
  fail(usage);
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) main();
