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

export function status(cwd) {
  const home = findHome(cwd);
  if (!home) return { found: false, next: 1, message: 'No breakdown yet: start with stage 1.' };
  const st = loadState(home);
  if (!st) return { found: false, next: 1, home, message: 'The progress file could not be read; start again from stage 1.' };
  const repos = (st.repos || []).map((r) => {
    const p = path.resolve(home, r.path);
    const exists = fs.existsSync(p);
    const commit = exists ? commitOf(p) : null;
    const fp = exists ? fingerprint(p) : null;
    const changed = !exists || (r.detectedCommit !== undefined && (r.detectedCommit !== commit || r.fingerprint !== fp));
    return { name: r.name, path: p, exists, detectedCommit: r.detectedCommit ?? null, currentCommit: commit, changed, detected: r.detectedCommit !== undefined };
  });
  const s1 = (st.stages && st.stages['1']) || {};
  const s2 = (st.stages && st.stages['2']) || {};
  let next;
  let message;
  if (s1.status !== 'done') {
    next = 1;
    message = 'Stage 1 (find the repos) is not finished.';
  } else if (repos.some((r) => !r.exists)) {
    next = 1;
    message = `Missing repo folder(s): ${repos.filter((r) => !r.exists).map((r) => r.name).join(', ')}.`;
  } else if (s2.status !== 'done') {
    next = 2;
    message = s2.status === 'awaiting-confirmation' ? 'Stage 2 is waiting for your confirmation of the profile.' : 'Stage 2 (learn each repo) is not finished.';
  } else if (repos.some((r) => r.changed || !r.detected)) {
    next = 2;
    message = `Code changed since stage 2 in: ${repos.filter((r) => r.changed || !r.detected).map((r) => r.name).join(', ')}.`;
  } else {
    next = 'up-to-date';
    message = 'Already up to date: no repo changed since the profile was confirmed.';
  }
  return { found: true, home, system: st.system || null, stages: st.stages || {}, repos, next, message };
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
