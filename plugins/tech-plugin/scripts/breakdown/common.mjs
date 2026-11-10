// Shared helpers for the breakdown scripts.
//
// WHY the write helper: the guard trusts the plugin's own scripts, so these
// scripts must hold themselves to the same rule: in a product repo they write
// only below <repo>/sdlc-docs/.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { secretTester } from '../lib/secretnames.mjs';
import { findApps, gitInfo, makeReader } from '../lib/stacks.mjs';

export const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DOCS = 'sdlc-docs';

export function fail(msg, code = 1) {
  process.stderr.write(`tech-plugin breakdown: ${msg}\n`);
  process.exit(code);
}

// Minimal argument parser: positional values and --flags (--x value | --x=value | --flag).
export function parseArgs(argv, booleans = []) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      if (v !== undefined) out[k] = v;
      else if (booleans.includes(k)) out[k] = true;
      else out[k] = argv[++i];
    } else out._.push(a);
  }
  return out;
}

export function real(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// Nearest folder at or above `dir` holding .git, or null.
export function repoRoot(dir) {
  let d = real(dir);
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

export function docsDir(repo) {
  return path.join(repo, DOCS);
}

// Writes <repo>/sdlc-docs/<rel>. Refuses anything that would land elsewhere.
export function writeDocs(repo, rel, content) {
  const base = docsDir(repo);
  const p = path.resolve(base, rel);
  if (p !== base && !p.startsWith(base + path.sep)) fail(`refusing to write outside ${base}: ${rel}`);
  if (fs.existsSync(base) && fs.lstatSync(base).isSymbolicLink()) fail(`${base} is a symlink; refusing to write through it`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

export function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function isSecretFor(repo) {
  return secretTester(PLUGIN_ROOT, repo);
}

// A cheap fingerprint of a repo's app manifests (names, sizes, times), so a
// change shows up even in a repo without commits.
export function fingerprint(repo) {
  const reader = makeReader(repo, isSecretFor(repo));
  const h = crypto.createHash('sha1');
  for (const c of findApps(reader)) {
    for (const m of c.manifests) {
      try {
        const st = fs.statSync(path.join(repo, c.root, m));
        h.update(`${c.root}/${m}:${st.size}:${Math.round(st.mtimeMs)}\n`);
      } catch {
        h.update(`${c.root}/${m}:missing\n`);
      }
    }
  }
  return h.digest('hex').slice(0, 16);
}

export function commitOf(repo) {
  return gitInfo(repo).commit;
}

export function rel(from, to) {
  const r = path.relative(from, to);
  return r === '' ? '.' : r.split(path.sep).join('/');
}

export function today(d = new Date()) {
  return d.toISOString().slice(0, 10);
}
