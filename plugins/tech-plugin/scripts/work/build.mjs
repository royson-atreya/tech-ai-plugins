#!/usr/bin/env node
// Building a work item: /tech-plugin:task (the plan), /tech-plugin:implement
// (the code, step by step) and /tech-plugin:review (checks and the handoff).
//
//   node build.mjs prepare  <ID> --home HOME [--modules a,b]
//         JSON for the worker that writes work/<ID>/plan.md: the stamp (with
//         the commit each repo is at), template, rules, inputs, fact packs,
//         profile.md, the test commands breakdown found, repos with uncommitted
//         changes, the tier. A feature needs approved requirements (and design,
//         unless Quick); a bug needs nothing. A bug with no modules gets the
//         ones its request names most (impact.mjs candidates)
//   node build.mjs approval <ID> --home HOME [--activate]
//         per repo the plan changes: is the guard's gate open (the same gate()
//         the guard runs: .active, APPROVED, a feature branch) and does
//         APPROVED name this plan's hash; the commands the person runs to open
//         it. --activate writes sdlc-docs/work/.active in those repos
//   node build.mjs progress <ID> --home HOME     the plan's steps: todo, done or failed
//   node build.mjs tier     <ID> <plan|implement|fix> --home HOME [--step T01]
//         the worker agent for the job, climbing a tier after two failures
//   node build.mjs record   <ID> <T01|fix-1> --result pass|fail --input FILE --home HOME [--tier T]
//   node build.mjs changes  <ID> --home HOME
//         what changed in each repo since the plan's base commits (sdlc-docs/
//         left out, new files included, secret files skipped), with the files
//         no step names; _state/work/<ID>/changes.patch and changes.json
//   node build.mjs save-review <ID> --kind code|security --input FILE --home HOME
//   node build.mjs handoff  <ID> --home HOME
//         writes work/<ID>/handoff.md and the commit message, then closes the
//         gate: removes .active where it names this item
//
// The plugin never runs a plan's commands itself: workers run them through
// Bash, where the guard sees every one. Never writes APPROVED (people do) and
// never runs a git command that changes anything.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bodyHash, joinDoc } from '../lib/frontmatter.mjs';
import { redact, scanText } from '../lib/redact.mjs';
import { pluginUpdate } from '../lib/version.mjs';
import { currentBranch } from '../lib/paths.mjs';
import { gate, makeCtx } from '../lib/rules.mjs';
import { PLUGIN_ROOT, docsDir, fail, isSecretFor, parseArgs, readJson, real, today, writeDocs } from '../breakdown/common.mjs';
import { loadState } from '../breakdown/state.mjs';
import { inShort, loadItem, moduleList, needsBreakdown, readWorkDoc, reEsc, refresh, refreshModules, workRel, writerPack, docState } from './work.mjs';

export const TIERS = ['light', 'standard', 'deep'];
const STEP_RE = (id) => new RegExp(`^### (${reEsc(id)}-T\\d{2,}):(.*)$`);
const stateRel = (id, f) => path.join('_state', 'work', id, f);
const MAX_PATCH = 600 * 1024;
const MAX_NEW_FILE = 200 * 1024;

// ------------------------------------------------------------------ plan

// The steps of a plan: [{ id, title, covers, files: [{ repo, path, kind }], do, check, tier, removed }]
export function parseSteps(body, id) {
  const lines = String(body).split('\n');
  const out = [];
  lines.forEach((l, i) => {
    const m = STEP_RE(id).exec(l);
    if (!m) return;
    let j = i + 1;
    while (j < lines.length && !/^#{2,3} /.test(lines[j])) j++;
    const text = lines.slice(i + 1, j).join('\n');
    const field = (k) => {
      const f = new RegExp(`^\\*\\*${k}:\\*\\*[ \\t]*(.*)$`, 'm').exec(text);
      return f ? f[1].trim() : null;
    };
    const files = [];
    const fi = text.indexOf('**Files:**');
    if (fi !== -1) {
      for (const fl of text.slice(fi).split('\n').slice(1)) {
        if (/^\*\*\w/.test(fl.trim())) break;
        const fm = /^\s*-\s*`([A-Za-z0-9_.-]+):([^`\s]+)`\s*(?:\((new|change|delete)\))?/.exec(fl);
        if (fm) files.push({ repo: fm[1], path: fm[2].replace(/:\d[\d,-]*$/, ''), kind: fm[3] || 'change', line: i + 1 + text.slice(0, fi).split('\n').length + files.length });
      }
    }
    const check = field('Check');
    const cm = check ? /^`([^`]+)`/.exec(check) : null;
    const tier = (field('Tier') || '').toLowerCase();
    out.push({ id: m[1], title: m[2].trim(), n: i, removed: /^Removed\b/i.test(m[2].trim()), covers: field('Covers'), files, do: field('Do'), check, command: cm ? cm[1] : null, byHand: !!(check && /^by hand\b/i.test(check)), tier: TIERS.includes(tier) ? tier : null });
  });
  return out;
}

const live = (steps) => steps.filter((s) => !s.removed);

function systemRepos(home) {
  const st = loadState(home);
  return new Map(((st && st.repos) || []).map((r) => [r.name, { name: r.name, abs: path.resolve(home, r.path) }]));
}

function planOf(home, id) {
  const p = readWorkDoc(home, id, 'plan');
  if (!p) fail(`no plan for ${id} yet: run /tech-plugin:task ${id}`);
  if (p.broken) fail(`the stamp of work/${id}/plan.md could not be read: ${p.broken}`);
  return { ...p, steps: parseSteps(p.body, id) };
}

// ------------------------------------------------------------------ prepare (task)

function testCommands(home, repos) {
  const out = {};
  for (const r of repos.values()) {
    const s = readJson(path.join(docsDir(r.abs), '_map', r.name, 'stack.json'));
    const cmds = ((s && s.apps) || []).flatMap((a) => (a.commands || []).filter((c) => c.kind === 'test').map((c) => ({ app: a.id || a.root || '.', cmd: c.cmd, class: c.class || null })));
    if (cmds.length) out[r.name] = cmds;
  }
  return out;
}

// Uncommitted changes outside sdlc-docs/: they would show up as part of this work at review.
function dirtyRepos(repos) {
  const out = [];
  for (const r of repos.values()) {
    const g = spawnSync('git', ['-C', r.abs, 'status', '--porcelain', '--', '.', ':(exclude)sdlc-docs'], { encoding: 'utf8' });
    if (g.status === 0 && g.stdout.trim()) out.push({ repo: r.name, files: g.stdout.trim().split('\n').length });
  }
  return out;
}

export async function prepare(home, id, { modules = null } = {}) {
  const stop = needsBreakdown(home);
  if (stop) fail(stop.message);
  const item = refresh(home, id);
  const kind = item.kind || 'feature';
  if (kind !== 'bug') {
    const s = item.states;
    if (!s.requirement.exists || !s.requirement.approved || s.requirement.state !== 'up-to-date') fail(`plan after the requirements are approved: /tech-plugin:requirement ${id}`);
    if (item.level !== 'Quick' && (!s.design.exists || !s.design.approved || s.design.state !== 'up-to-date')) fail(`plan after the design is approved: /tech-plugin:design ${id} (or set the level to Quick: work.mjs level ${id} Quick)`);
  }
  let mods = modules ? moduleList(home, modules) : item.modules.length ? item.modules : null;
  let guessed = false;
  if (!mods && kind === 'bug') {
    const { candidates } = await import('./impact.mjs');
    mods = candidates(home, id).likely.slice(0, 3).map((r) => r.id);
    guessed = mods.length > 0;
  }
  if (!mods || !mods.length) fail(`no modules for ${id}: name the parts of the product it touches (--modules a,b)`);
  refreshModules(home, id, mods);
  const pack = writerPack(home, id, 'plan', mods);
  const repos = systemRepos(home);
  const D = docsDir(home);
  return {
    ...pack,
    kind,
    level: item.level || null,
    modulesGuessed: guessed,
    profile: fs.existsSync(path.join(D, 'profile.md')) ? path.join(D, 'profile.md') : null,
    repos: Object.fromEntries([...repos.values()].map((r) => [r.name, r.abs])),
    testCommands: testCommands(home, repos),
    dirty: dirtyRepos(repos),
    stepPrefix: `${id}-T`,
    tier: tier(home, id, 'plan'),
  };
}

// ------------------------------------------------------------------ approval

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function approvedHash(file) {
  try {
    const m = /^plan\s+([0-9a-f]{8,})\b/m.exec(fs.readFileSync(file, 'utf8'));
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function writeActive(home, repo, id) {
  const f = path.join(repo.abs, 'sdlc-docs', 'work', '.active');
  const now = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : '';
  if (now && now !== id && fs.existsSync(path.join(repo.abs, 'sdlc-docs', 'work', now))) return `${repo.name}: .active names ${now}, another work item; finish or close it first (delete sdlc-docs/work/.active)`;
  if (repo.abs !== home && !fs.existsSync(path.join(repo.abs, 'sdlc-docs', 'work', id, 'README.md'))) {
    writeDocs(repo.abs, workRel(id, 'README.md'), `# ${id}\n\nThis work item lives in ${path.basename(home)}: sdlc-docs/work/${id}/. This folder holds only its APPROVED file for this repo, which a person creates.\n`);
  }
  writeDocs(repo.abs, path.join('work', '.active'), `${id}\n`);
  return null;
}

export function approval(home, id, { activate = false } = {}) {
  const plan = planOf(home, id);
  const repos = systemRepos(home);
  const used = [...new Set(live(plan.steps).flatMap((s) => s.files.map((f) => f.repo)))].filter((r) => repos.has(r));
  if (!used.length) fail(`plan.md of ${id} names no file in a repo of this system: rewrite it with /tech-plugin:task ${id}`);
  const item = loadItem(home, id);
  const problems = [];
  if (activate) for (const r of used) {
    const p = writeActive(home, repos.get(r), id);
    if (p) problems.push(p);
  }
  const ctx = makeCtx({ cwd: home, tool_name: 'Write' }, PLUGIN_ROOT);
  const branchName = `feature/${slug(id)}-${slug(item.title)}`.replace(/-$/, '');
  const rows = used.map((name) => {
    const r = repos.get(name);
    const file = path.join(r.abs, 'sdlc-docs', 'work', id, 'APPROVED');
    const branch = currentBranch(r.abs);
    let protectedBranch = false;
    try {
      protectedBranch = !branch || ctx.cfgFor(r.abs).branchRes.some((re) => re.test(branch));
    } catch {
      protectedBranch = true;
    }
    let gateMsg;
    try {
      gateMsg = gate(r.abs, ctx);
    } catch (e) {
      gateMsg = e.message;
    }
    const has = fs.existsSync(file);
    const hash = has ? approvedHash(file) : null;
    const planMatches = hash === plan.hash;
    const commands = [];
    if (protectedBranch) commands.push(`git -C ${sh(r.abs)} switch -c ${branchName}`);
    if (!planMatches) commands.push(`printf 'plan %s\\nby %s\\n' ${plan.hash} "<your name>" > ${sh(file)}`);
    return { repo: name, path: r.abs, branch, protectedBranch, active: !/no work item is active|names "/.test(gateMsg || '') , approvedFile: has, planMatches, approvedOtherPlan: has && !planMatches, gate: gateMsg, ok: !gateMsg && planMatches, commands };
  });
  const ok = rows.every((r) => r.ok) && !problems.length;
  const commands = rows.flatMap((r) => r.commands);
  const message = ok
    ? `The plan of ${id} is approved and every repo it changes is on a feature branch: /tech-plugin:implement ${id}.`
    : `To approve the plan of ${id}, run in your own terminal (Claude cannot):\n${commands.map((c) => `  ${c}`).join('\n')}${rows.some((r) => r.approvedOtherPlan) ? `\nAPPROVED names an older plan: the plan changed after it was approved.` : ''}${problems.length ? `\n${problems.join('\n')}` : ''}`;
  return { work: id, plan: plan.hash, ok, repos: rows, commands, problems, message };
}

// For status: the same, without writing and without the commands.
function quickApproved(home, id, plan) {
  const repos = systemRepos(home);
  const used = [...new Set(live(plan.steps).flatMap((s) => s.files.map((f) => f.repo)))].filter((r) => repos.has(r));
  if (!used.length) return false;
  const ctx = makeCtx({ cwd: home, tool_name: 'Write' }, PLUGIN_ROOT);
  return used.every((name) => {
    const r = repos.get(name);
    try {
      return !gate(r.abs, ctx) && approvedHash(path.join(r.abs, 'sdlc-docs', 'work', id, 'APPROVED')) === plan.hash;
    } catch {
      return false;
    }
  });
}

// ------------------------------------------------------------------ progress

const progressRel = (id) => workRel(id, 'progress.json');

function readProgress(home, id) {
  return readJson(path.join(docsDir(home), progressRel(id))) || { schema: 1, plan: null, steps: {} };
}

export function progress(home, id) {
  const plan = planOf(home, id);
  const p = readProgress(home, id);
  const steps = live(plan.steps).map((s) => {
    const r = p.steps[s.id] || { status: 'todo', attempts: [] };
    return { id: s.id, title: s.title, status: r.status, attempts: r.attempts.length, files: s.files.map((f) => `${f.repo}:${f.path}`), check: s.check };
  });
  const next = steps.find((s) => s.status !== 'done') || null;
  return { work: id, plan: plan.hash, planChanged: !!(p.plan && p.plan !== plan.hash), done: steps.filter((s) => s.status === 'done').length, total: steps.length, next: next ? next.id : null, steps };
}

export function record(home, id, step, { result, input, tierName = null }) {
  if (!['pass', 'fail'].includes(result)) fail('--result is pass or fail');
  if (!input || !fs.existsSync(input)) fail('--input FILE is required: the worker\'s report and the check output');
  const plan = planOf(home, id);
  const isStep = live(plan.steps).some((s) => s.id === step);
  if (!isStep && !/^fix-\d+$/.test(step)) fail(`${step} is not a step of the plan of ${id} (or fix-<round>)`);
  const raw = redact(fs.readFileSync(input, 'utf8'));
  fs.rmSync(input, { force: true });
  const p = readProgress(home, id);
  const r = p.steps[step] || { status: 'todo', attempts: [] };
  const n = r.attempts.length + 1;
  const rel = workRel(id, path.join('checks', `${step}-${n}.md`));
  writeDocs(home, rel, `> **Step:** ${step} · **Attempt:** ${n} · **Result:** ${result} · **Tier:** ${tierName || '?'} · **Date:** ${today()} · **Plan:** \`${plan.hash}\`\n\n${raw.trim()}\n`);
  r.attempts.push({ n, result, tier: tierName, at: new Date().toISOString(), file: rel });
  r.status = result === 'pass' ? 'done' : 'failed';
  p.steps[step] = r;
  p.plan = plan.hash;
  writeDocs(home, progressRel(id), JSON.stringify(p, null, 1) + '\n');
  const pr = progress(home, id);
  return { step, attempt: n, result, file: rel, done: pr.done, total: pr.total, next: pr.next };
}

// ------------------------------------------------------------------ tiers

function projectTiers(home) {
  const c = readJson(path.join(docsDir(home), 'config.json'));
  return (c && c.tiers && typeof c.tiers === 'object') ? c.tiers : {};
}

function riskOf(home, id) {
  const p = readWorkDoc(home, id, 'plan');
  const fromPlan = p ? inShort(p.body, 'Risk') : null;
  if (fromPlan) return fromPlan;
  const i = readWorkDoc(home, id, 'impact');
  return i ? inShort(i.body, 'Risk') : null;
}

// Which worker does a job: plan and implement on the standard tier; High or
// Critical risk on the deep tier; a Quick item never on the deep tier (no
// Opus); a step that failed twice on a tier moves up one; failing twice at
// the top tier stops and asks the person.
export function tier(home, id, job, { step = null } = {}) {
  if (!['plan', 'implement', 'fix'].includes(job)) fail('the job is plan, implement or fix');
  const item = loadItem(home, id);
  const quick = (item.level || (item.kind === 'bug' ? 'Quick' : null)) === 'Quick';
  const risk = riskOf(home, id);
  const cap = quick ? 'standard' : 'deep';
  const why = [];
  let base = 'standard';
  if (job === 'implement' && step) {
    const s = readWorkDoc(home, id, 'plan') ? live(parseSteps(readWorkDoc(home, id, 'plan').body, id)).find((x) => x.id === step) : null;
    if (!s) fail(`${step} is not a step of the plan of ${id}`);
    if (s.tier) {
      base = s.tier;
      why.push(`the plan asks for ${s.tier}`);
    }
  }
  if (['High', 'Critical'].includes(risk)) {
    base = 'deep';
    why.push(`risk ${risk}`);
  }
  if (TIERS.indexOf(base) > TIERS.indexOf(cap)) {
    base = cap;
    why.push('a Quick item never uses the deep tier');
  }
  const attempts = step ? ((readProgress(home, id).steps[step] || {}).attempts || []) : [];
  let t = base;
  let stop = false;
  for (;;) {
    const fails = attempts.filter((a) => a.result === 'fail' && a.tier === t).length;
    if (fails < 2) break;
    if (t === cap) {
      stop = true;
      why.push(`${step} failed twice on the ${t} tier, the highest allowed`);
      break;
    }
    why.push(`${step} failed twice on the ${t} tier`);
    t = TIERS[TIERS.indexOf(t) + 1];
  }
  const map = projectTiers(home);
  const agent = typeof map[t] === 'string' && map[t].trim() ? map[t].trim() : `tech-plugin:worker-${t}`;
  return { job, step, tier: t, agent, stop, why: why.join('; ') || 'the default', message: stop ? `Stopped: ${why[why.length - 1]}. Look at the last check (work/${id}/checks/) and fix the plan or the code by hand, then run /tech-plugin:implement ${id} again.` : null };
}

// ------------------------------------------------------------------ changes

function git(abs, args) {
  const r = spawnSync('git', ['-C', abs, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) fail(`git ${args[0]} failed in ${path.basename(abs)}: ${(r.stderr || '').trim().split('\n')[0]}`);
  return r.stdout;
}

export function changes(home, id) {
  const plan = planOf(home, id);
  const repos = systemRepos(home);
  const bases = plan.front.repos || {};
  const planned = new Set(live(plan.steps).flatMap((s) => s.files.map((f) => `${f.repo}:${f.path}`)));
  const files = [];
  const chunks = [];
  const skipped = [];
  const warnings = [];
  for (const [name, b] of Object.entries(bases)) {
    const r = repos.get(name);
    if (!r || !b || !fs.existsSync(r.abs)) continue;
    if (!b.base || spawnSync('git', ['-C', r.abs, 'rev-parse', '--verify', '--quiet', `${b.base}^{commit}`]).status !== 0) {
      if (planned.size && [...planned].some((p) => p.startsWith(`${name}:`))) warnings.push(`${name}: the commit the plan started from (${b.base || 'none'}) is not in this repo, so its changes cannot be shown`);
      continue;
    }
    const secret = isSecretFor(r.abs);
    const spec = ['--', '.', ':(exclude)sdlc-docs'];
    for (const l of git(r.abs, ['diff', '--numstat', '--no-renames', b.base, ...spec]).split('\n').filter(Boolean)) {
      const [a, d, f] = l.split('\t');
      if (secret(f)) {
        skipped.push(`${name}:${f}`);
        continue;
      }
      files.push({ repo: name, path: f, added: a === '-' ? null : Number(a), removed: d === '-' ? null : Number(d), status: 'changed', planned: planned.has(`${name}:${f}`) });
    }
    const diff = git(r.abs, ['diff', '--no-color', '--no-ext-diff', '--no-renames', b.base, ...spec]);
    for (const c of diff.split(/^(?=diff --git )/m).filter(Boolean)) {
      const m = /^diff --git a\/(\S+) b\//.exec(c);
      if (m && !secret(m[1])) chunks.push(`# repo ${name}\n${c}`);
    }
    for (const f of git(r.abs, ['ls-files', '--others', '--exclude-standard', ...spec]).split('\n').filter(Boolean)) {
      if (secret(f)) {
        skipped.push(`${name}:${f}`);
        continue;
      }
      const abs = path.join(r.abs, f);
      let text = null;
      try {
        if (fs.statSync(abs).size <= MAX_NEW_FILE) {
          const buf = fs.readFileSync(abs);
          if (!buf.includes(0)) text = buf.toString('utf8');
        }
      } catch {
        /* unreadable: listed only */
      }
      const ls = text === null ? [] : text.replace(/\n$/, '').split('\n');
      files.push({ repo: name, path: f, added: text === null ? null : ls.length, removed: 0, status: 'new', planned: planned.has(`${name}:${f}`) });
      chunks.push(`# repo ${name}\ndiff --git a/${f} b/${f}\nnew file\n--- /dev/null\n+++ b/${f}\n${text === null ? '(binary or larger than 200 KB: not shown)\n' : `@@ -0,0 +1,${ls.length} @@\n${ls.map((x) => `+${x}`).join('\n')}\n`}`);
    }
  }
  let patch = redact(chunks.join('\n'));
  let truncated = false;
  if (patch.length > MAX_PATCH) {
    patch = `${patch.slice(0, MAX_PATCH)}\n\n(… cut at ${MAX_PATCH / 1024} KB: read the rest of the files directly)\n`;
    truncated = true;
  }
  const hash = bodyHash(patch);
  const unplanned = files.filter((f) => !f.planned).map((f) => `${f.repo}:${f.path}`);
  const notTouched = [...planned].filter((p) => !files.some((f) => `${f.repo}:${f.path}` === p));
  const summary = { work: id, plan: plan.hash, hash, at: new Date().toISOString(), files, unplanned, notTouched, skippedSecrets: skipped, warnings, truncated, added: files.reduce((n, f) => n + (f.added || 0), 0), removed: files.reduce((n, f) => n + (f.removed || 0), 0) };
  writeDocs(home, stateRel(id, 'changes.patch'), patch);
  writeDocs(home, stateRel(id, 'changes.json'), JSON.stringify(summary, null, 1) + '\n');
  const D = docsDir(home);
  return { ...summary, patch: path.join(D, stateRel(id, 'changes.patch')), json: path.join(D, stateRel(id, 'changes.json')) };
}

// ------------------------------------------------------------------ reviews

const reviewRel = (id, kind, n) => workRel(id, path.join('review', `${kind}-${n}.md`));

function listReviews(home, id, kind) {
  const d = path.join(docsDir(home), workRel(id, 'review'));
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .map((f) => new RegExp(`^${kind}-(\\d+)\\.md$`).exec(f))
    .filter(Boolean)
    .map((m) => {
      const t = fs.readFileSync(path.join(d, m[0]), 'utf8');
      const s = /Summary:\s*(\d+)\s+findings?\s*·\s*(\d+)\s+blocking/i.exec(t);
      const h = /\*\*Reviewed changes:\*\* `([0-9a-f]+)`/.exec(t);
      return { n: Number(m[1]), file: path.join(d, m[0]), findings: s ? Number(s[1]) : null, blocking: s ? Number(s[2]) : null, changes: h ? h[1] : null };
    })
    .sort((a, b) => a.n - b.n);
}

export function saveReview(home, id, { kind, input }) {
  if (!['code', 'security'].includes(kind)) fail('--kind is code or security');
  if (!input || !fs.existsSync(input)) fail('--input FILE is required');
  const ch = readJson(path.join(docsDir(home), stateRel(id, 'changes.json')));
  if (!ch) fail(`collect the changes first: build.mjs changes ${id}`);
  const raw = fs.readFileSync(input, 'utf8');
  const s = /Summary:\s*(\d+)\s+findings?\s*·\s*(\d+)\s+blocking/i.exec(raw);
  if (!s) fail('the review has no "Summary: N findings · B blocking" line');
  const risks = scanText(raw);
  if (risks.length) fail(`not saved: the review quotes ${risks.map((r) => r.type).join(', ')} (value not shown). Ask the reviewer to describe it without the value`);
  fs.rmSync(input, { force: true });
  const n = (listReviews(home, id, kind).pop() || { n: 0 }).n + 1;
  const rel = reviewRel(id, kind, n);
  writeDocs(home, rel, `> **Reviewed changes:** \`${ch.hash}\` · **Round:** ${n} · **Date:** ${today()}\n\n${raw.trim()}\n`);
  return { kind, round: n, file: rel, findings: Number(s[1]), blocking: Number(s[2]) };
}

// ------------------------------------------------------------------ handoff

function sectionText(body, re) {
  const lines = String(body).split('\n');
  const i = lines.findIndex((l) => re.test(l));
  if (i === -1) return '';
  let j = i + 1;
  while (j < lines.length && !/^## /.test(lines[j])) j++;
  return lines.slice(i + 1, j).join('\n').replace(/\s*\[(E|Q)\d+\]/g, '').trim();
}

export function handoff(home, id) {
  const plan = planOf(home, id);
  const item = loadItem(home, id);
  const pr = progress(home, id);
  if (pr.done < pr.total) fail(`${pr.total - pr.done} step(s) of the plan are not done: /tech-plugin:implement ${id}`);
  const ch = readJson(path.join(docsDir(home), stateRel(id, 'changes.json')));
  if (!ch || ch.plan !== plan.hash) fail(`collect the changes first: build.mjs changes ${id}`);
  const rv = Object.fromEntries(['code', 'security'].map((k) => [k, listReviews(home, id, k).filter((r) => r.changes === ch.hash).pop() || null]));
  const repos = systemRepos(home);
  const used = [...new Set(ch.files.map((f) => f.repo))];
  const steps = live(plan.steps);
  const req = readWorkDoc(home, id, 'requirement');
  const what = inShort(plan.body, 'What changes') || item.title;
  const left = ['code', 'security'].map((k) => (rv[k] ? rv[k].blocking : null));
  const reviewLine = ['code', 'security'].map((k, i) => (rv[k] ? `${k}: ${rv[k].findings} finding(s), ${left[i]} blocking` : `${k}: not reviewed`)).join('; ');
  const P = ['# ' + `${item.title}: handoff`, '', '> **In short**', `> - **What changed:** ${what}`, `> - **Files:** ${ch.files.length} changed (+${ch.added} −${ch.removed}) in ${used.join(', ') || 'no repo'}`, `> - **Checks:** ${pr.done} of ${pr.total} steps passed their check`, `> - **Review:** ${reviewLine}`, ''];
  P.push('## 1. What changed', '', sectionText(plan.body, /^## 1\. /) || what, '');
  P.push('## 2. How to check it by hand', '');
  if (item.kind === 'bug') P.push('Follow the steps that showed the bug. It should not happen any more:', '', sectionText(plan.body, /^## 2\. /), '');
  const covered = new Set(steps.flatMap((s) => [...String(s.covers || '').matchAll(new RegExp(`${reEsc(id)}-R\\d{2,}`, 'g'))].map((m) => m[0])));
  if (req) {
    for (const m of req.body.matchAll(new RegExp(`^### (${reEsc(id)}-R\\d{2,}):(.*)$`, 'gm'))) {
      if (!covered.has(m[1]) || /^\s*Removed\b/i.test(m[2])) continue;
      const block = req.body.slice(m.index).split(/\n(?=###? )/)[0];
      const ac = block.split('\n').filter((l) => /^- (Given|When)\b/i.test(l.trim()));
      P.push(`**${m[1]}:${m[2]}**`, '', ...(ac.length ? ac : ['- (no acceptance criteria written)']), '');
    }
  }
  const byHand = steps.filter((s) => s.byHand);
  if (byHand.length) P.push('Checks done by hand in the plan:', '', ...byHand.map((s) => `- ${s.id}: ${s.check.replace(/^by hand:?\s*/i, '')}`), '');
  P.push('## 3. Open points', '');
  const open = [];
  for (const k of ['code', 'security']) if (rv[k] && rv[k].blocking) open.push(`- ${rv[k].blocking} blocking ${k} finding(s) left after the last round: [${k} review](review/${path.basename(rv[k].file)}).`);
  for (const k of ['code', 'security']) if (!rv[k]) open.push(`- No ${k} review of these changes.`);
  for (const u of ch.unplanned) open.push(`- \`${u}\` changed, but no step of the plan names it.`);
  for (const u of ch.notTouched) open.push(`- \`${u}\` is in the plan, but did not change.`);
  if (ch.skippedSecrets.length) open.push(`- ${ch.skippedSecrets.length} secret file(s) changed and were not shown to the reviewers: ${ch.skippedSecrets.map((s) => `\`${s}\``).join(', ')}. Check them yourself.`);
  if (ch.truncated) open.push('- The changes were too large to show the reviewers in full.');
  for (const w of ch.warnings || []) open.push(`- ${w}.`);
  P.push(...(open.length ? open : ['None.']), '');
  P.push('## Appendix A. Files changed', '', '| Repo | File | + | − | In the plan |', '|---|---|---|---|---|');
  for (const f of ch.files) P.push(`| ${f.repo} | \`${f.path}\` | ${f.added ?? 'binary'} | ${f.removed ?? ''} | ${f.planned ? steps.filter((s) => s.files.some((x) => x.repo === f.repo && x.path === f.path)).map((s) => s.id).join(', ') : 'no'} |`);
  P.push('', '## Appendix B. Steps, requirements and checks', '', '| Step | Covers | Files | Check | Result |', '|---|---|---|---|---|');
  for (const s of pr.steps) {
    const ps = steps.find((x) => x.id === s.id);
    const last = (readProgress(home, id).steps[s.id] || { attempts: [] }).attempts.slice(-1)[0];
    P.push(`| ${s.id} ${s.title.replace(/\|/g, '/')} | ${(ps.covers || '').replace(/\|/g, '/')} | ${s.files.map((f) => `\`${f}\``).join(' ')} | ${(s.check || '').replace(/\|/g, '/')} | ${last ? `[${last.result}, attempt ${last.n}, ${last.tier || '?'}](${path.relative(workRel(id), last.file)})` : s.status} |`);
  }
  P.push('', '## Appendix C. Reviews', '');
  for (const k of ['code', 'security']) P.push(rv[k] ? `- ${k}: round ${rv[k].n}, ${rv[k].findings} finding(s), ${rv[k].blocking} blocking: [review/${path.basename(rv[k].file)}](review/${path.basename(rv[k].file)})` : `- ${k}: none`);
  const D = docsDir(home);
  const msgRel = stateRel(id, 'commit-message.txt');
  const reqIds = [...covered].sort();
  const msg = `${id}: ${item.title}\n\n${what}\n\nSteps: ${steps.map((s) => s.id).join(', ')}${reqIds.length ? `\nRequirements: ${reqIds.join(', ')}` : ''}\n`;
  writeDocs(home, msgRel, msg);
  const commands = used.map((name) => {
    const r = repos.get(name);
    const br = currentBranch(r.abs);
    return `git -C ${sh(r.abs)} add -A && git -C ${sh(r.abs)} commit -F ${sh(path.join(D, msgRel))} && git -C ${sh(r.abs)} push -u origin ${br}`;
  });
  P.push('', '## Commit', '', 'You commit and push; tech-plugin never does. The message is ready:', '', '```text', msg.trimEnd(), '```', '', 'In your own terminal, after looking at `git status` (`add -A` also adds `sdlc-docs/` if you keep it in Git):', '', '```sh', ...commands, '```', '', 'After the merge, run `/tech-plugin:sync`: the documents of the modules it changed will be out of date.', '');
  const front = { work: id, doc: 'handoff', title: item.title, date: today(), plan: plan.hash, changes: ch.hash };
  writeDocs(home, workRel(id, 'handoff.md'), joinDoc(front, P.join('\n') + '\n'));
  // close the gate: no more code edits for this item
  const closed = [];
  for (const name of new Set([...used, ...live(steps).flatMap((s) => s.files.map((f) => f.repo))])) {
    const r = repos.get(name);
    if (!r) continue;
    const f = path.join(r.abs, 'sdlc-docs', 'work', '.active');
    if (fs.existsSync(f) && fs.readFileSync(f, 'utf8').trim() === id) {
      fs.rmSync(f);
      closed.push(name);
    }
  }
  refresh(home, id);
  return { work: id, file: path.join(D, workRel(id, 'handoff.md')), commitMessage: path.join(D, msgRel), commands, closed, blockingLeft: left.reduce((a, b) => a + (b || 0), 0), unplanned: ch.unplanned };
}

// ------------------------------------------------------------------ status (for work.mjs)

// started: the plan is approved, or a step has run. From then on the build's
// own code changes do not make the plan out of date (a change to the request
// or the documents it was written from still does).
export function buildState(home, id) {
  const none = { plan: { exists: false, state: 'missing', reasons: [] }, approved: false, done: 0, total: 0, handedOff: false, started: false };
  const p = readWorkDoc(home, id, 'plan');
  if (!p) return none;
  const st = docState(home, id, 'plan');
  if (p.broken) return { ...none, plan: st };
  const steps = live(parseSteps(p.body, id));
  const pr = readProgress(home, id);
  const done = steps.filter((s) => (pr.steps[s.id] || {}).status === 'done').length;
  const h = readWorkDoc(home, id, 'handoff');
  const handedOff = !!(h && h.front && h.front.plan === p.hash);
  const approved = handedOff ? true : quickApproved(home, id, { ...p, steps });
  const started = approved || handedOff || (pr.plan === p.hash && Object.keys(pr.steps).length > 0);
  let plan = st;
  if (started && st.state === 'stale') {
    const reasons = st.reasons.filter((r) => !/^the code of /.test(r));
    plan = { ...st, reasons, state: reasons.length ? 'stale' : 'up-to-date' };
  }
  return { plan, approved, done, total: steps.length, handedOff, started };
}

// ------------------------------------------------------------------ main

async function main() {
  const [cmd] = process.argv.slice(2);
  const a = parseArgs(process.argv.slice(3), ['activate']);
  const usage = 'usage: build.mjs <prepare|approval|progress|tier|record|changes|save-review|handoff> <ID> … --home HOME';
  if (!a.home) fail(usage);
  const home = real(a.home);
  if (!fs.existsSync(docsDir(home))) fail(`${home} has no sdlc-docs/; run /tech-plugin:breakdown first`);
  const [id, x] = a._;
  if (!id) fail(usage);
  const out = (v) => process.stdout.write(JSON.stringify(v, null, 2) + '\n');
  const upd = pluginUpdate(PLUGIN_ROOT);
  if (upd) fail(upd.message);
  if (cmd === 'prepare') return out(await prepare(home, id, { modules: a.modules || null }));
  if (cmd === 'approval') return out(approval(home, id, { activate: !!a.activate }));
  if (cmd === 'progress') return out(progress(home, id));
  if (cmd === 'tier') return out(tier(home, id, x, { step: a.step || null }));
  if (cmd === 'record') return out(record(home, id, x, { result: a.result, input: a.input ? real(a.input) : null, tierName: a.tier || null }));
  if (cmd === 'changes') return out(changes(home, id));
  if (cmd === 'save-review') return out(saveReview(home, id, { kind: a.kind, input: a.input ? real(a.input) : null }));
  if (cmd === 'handoff') return out(handoff(home, id));
  fail(usage);
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) main();
