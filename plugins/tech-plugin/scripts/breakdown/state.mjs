#!/usr/bin/env node
// breakdown progress, saved after every stage in the home repo:
// <home>/sdlc-docs/_state/breakdown.json
//
//   node state.mjs status [--cwd DIR]
//       JSON: where the run stands, which repos changed since stage 2,
//       and the next stage to run ("up-to-date" when nothing changed).
//   node state.mjs set --home REPO --stage 2 --status awaiting-confirmation
//
// Costs almost no tokens: Claude reads one small JSON answer.

import fs from 'node:fs';
import path from 'node:path';
import { DOCS, commitOf, fail, fingerprint, parseArgs, readJson, real, repoRoot, writeDocs } from './common.mjs';
import { READERS_VERSION, codeTree } from './load.mjs';
import { pluginUpdate } from '../lib/version.mjs';
import { PLUGIN_ROOT } from './common.mjs';

export const STATE_REL = path.join('_state', 'breakdown.json');

export function statePath(home) {
  return path.join(home, DOCS, STATE_REL);
}

export function loadState(home) {
  return readJson(statePath(home));
}

export function saveState(home, state) {
  writeDocs(home, STATE_REL, JSON.stringify(state, null, 2) + '\n');
}

// Finds the home repo for a folder: the repo itself, the repo its home.json
// points to, or (in a workspace folder) the one sub-repo that holds the state.
export function findHome(cwd) {
  const r = repoRoot(cwd);
  const candidates = [];
  if (r) candidates.push(r);
  else candidates.push(real(cwd));
  for (const c of candidates) {
    const ptr = readJson(path.join(c, DOCS, 'home.json'));
    if (ptr && ptr.home) {
      const h = path.resolve(c, ptr.home);
      if (fs.existsSync(statePath(h))) return h;
    }
    if (fs.existsSync(statePath(c))) return c;
  }
  if (!r) {
    // workspace folder: look one and two levels down
    const found = [];
    const visit = (d, depth) => {
      let ents = [];
      try {
        ents = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of ents) {
        if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'vendor') continue;
        const p = path.join(d, e.name);
        if (fs.existsSync(statePath(p))) found.push(p);
        else if (depth < 2) visit(p, depth + 1);
      }
    };
    visit(real(cwd), 1);
    if (found.length === 1) return found[0];
  }
  return null;
}

export const stampKey = (m) => (m ? `${m.commit || 'none'}:${m.tree}:r${m.readers || 1}` : null);
const same = (a, b) => JSON.stringify(a || {}) === JSON.stringify(b || {});

// Where the run stands and what to do next. Cheap: reads the progress file,
// each repo's HEAD and a fingerprint of its files; never the facts themselves.
//   changed      the repo's manifests changed since stage 2 (profile is stale)
//   codeChanged  the repo's code changed since stage 3 read it
export function status(cwd) {
  const upd = pluginUpdate(PLUGIN_ROOT);
  if (upd) return { found: null, next: 'restart', pluginUpdate: upd, message: upd.message };
  const home = findHome(cwd);
  if (!home) return { found: false, next: 1, message: 'No breakdown yet: start with stage 1.' };
  const st = loadState(home);
  if (!st) return { found: false, next: 1, home, message: 'The progress file could not be read; start again from stage 1.' };
  const repos = (st.repos || []).map((r) => {
    const p = path.resolve(home, r.path);
    const exists = fs.existsSync(p);
    const commit = exists ? commitOf(p) : null;
    const fp = exists ? fingerprint(p) : null;
    const tree = exists ? codeTree(p).tree : null;
    const changed = !exists || (r.detectedCommit !== undefined && r.fingerprint !== fp);
    const codeChanged = !exists || !r.mapped || r.mapped.commit !== commit || r.mapped.tree !== tree || (r.mapped.readers || 1) !== READERS_VERSION;
    const readersOutdated = !!r.mapped && (r.mapped.readers || 1) !== READERS_VERSION;
    return { name: r.name, path: p, role: r.role || null, exists, readersOutdated, detectedCommit: r.detectedCommit ?? null, currentCommit: commit, changed, codeChanged, detected: r.detectedCommit !== undefined, mapped: !!r.mapped };
  });
  const S = st.stages || {};
  const stage = (n) => S[String(n)] || {};
  const stamps = Object.fromEntries((st.repos || []).map((r) => [r.name, stampKey(r.mapped)]));
  const names = (list) => list.map((r) => r.name).join(', ');
  let next;
  let message;
  if (stage(1).status !== 'done') [next, message] = [1, 'Stage 1 (find the repos) is not finished.'];
  else if (repos.some((r) => !r.exists)) [next, message] = [1, `Missing repo folder(s): ${names(repos.filter((r) => !r.exists))}.`];
  else if (stage(2).status !== 'done') [next, message] = [2, stage(2).status === 'awaiting-confirmation' ? 'Stage 2 is waiting for your confirmation of the profile.' : 'Stage 2 (learn each repo) is not finished.'];
  else if (repos.some((r) => r.changed || !r.detected)) [next, message] = [2, `Manifests changed since the profile was confirmed in: ${names(repos.filter((r) => r.changed || !r.detected))}.`];
  else if (repos.some((r) => r.codeChanged)) [next, message] = [3, repos.every((r) => !r.mapped) ? 'Stage 3 (read the code) has not run yet.' : repos.some((r) => r.readersOutdated) ? `tech-plugin's code readers were improved since stage 3 ran: reading again ${names(repos.filter((r) => r.codeChanged))}.` : `Code changed since stage 3 in: ${names(repos.filter((r) => r.codeChanged))}.`];
  else if (stage(4).status !== 'done' || !same(stage(4).inputs, stamps)) [next, message] = [4, 'Stage 4 (link the apps) needs to run.'];
  else if (stage(5).status !== 'done') [next, message] = [5, stage(5).status === 'awaiting-approval' ? 'Stage 5 is waiting for your approval of the module list.' : 'Stage 5 (propose modules) has not run yet.'];
  else if (!same(stage(5).inputs, stamps)) [next, message] = [5, 'Code changed since the modules were approved: checking whether any route or screen moved.'];
  else if (stage(6).status !== 'done' || !same(stage(6).inputs, stamps) || stage(6).modules !== stage(5).modules) [next, message] = [6, 'Stage 6 (write the breakdown) needs to run.'];
  else [next, message] = ['up-to-date', 'Already up to date: no code changed since the breakdown was written.'];
  return { found: true, home, system: st.system || null, stages: S, repos, next, message };
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = parseArgs(rest);
  if (cmd === 'status') {
    process.stdout.write(JSON.stringify(status(a.cwd || process.cwd()), null, 2) + '\n');
    return;
  }
  if (cmd === 'set') {
    if (!a.home || !a.stage || !a.status) fail('usage: state.mjs set --home REPO --stage N --status STATUS');
    const home = real(a.home);
    const st = loadState(home);
    if (!st) fail(`no progress file in ${home}; run stage 1 first`);
    st.stages = st.stages || {};
    st.stages[a.stage] = { ...(st.stages[a.stage] || {}), status: a.status, at: new Date().toISOString() };
    saveState(home, st);
    process.stdout.write(`stage ${a.stage}: ${a.status}\n`);
    return;
  }
  fail('usage: state.mjs status [--cwd DIR] | set --home REPO --stage N --status STATUS');
}

if (process.argv[1] && path.basename(process.argv[1]) === 'state.mjs') main();
