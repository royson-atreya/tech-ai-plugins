// Secret file names, shared by the guard and by every script that reads a repo.
// The guard decides what Claude may touch; scripts use the same rules so they
// never open a secret file themselves (they only ever learn its name).

import path from 'node:path';
import { loadDefaults, loadProject, merge } from './config.mjs';

// Basename glob -> case-insensitive RegExp. `anyChar` lets * cross "/" (branch names).
export function globToRegex(g, anyChar = false) {
  const star = anyChar ? '.*' : '[^/]*';
  let re = '^';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') re += star;
    else if (c === '?') re += anyChar ? '.' : '[^/]';
    else if (c === '[') {
      const j = g.indexOf(']', i + 2);
      if (j > i) {
        let cls = g.slice(i + 1, j).replace(/\\/g, '\\\\');
        if (cls[0] === '!') cls = '^' + cls.slice(1);
        re += `[${cls}]`;
        i = j;
      } else re += '\\[';
    } else re += c.replace(/[.+^${}()|\\/\]]/g, '\\$&');
  }
  return new RegExp(re + '$', 'i');
}

// Adds compiled matchers to a merged config.
export function compileSecrets(cfg) {
  cfg.secretRes = cfg.secretPatterns.map((p) => globToRegex(p));
  cfg.secretExc = new Set(cfg.secretExceptions.map((x) => x.toLowerCase()));
  return cfg;
}

export function nameIsSecret(cfg, name) {
  const b = String(name).split(/[\\/]/).pop().toLowerCase();
  if (!b || cfg.secretExc.has(b)) return false;
  return cfg.secretRes.some((re) => re.test(b));
}

// For scripts: a name test for files in `repo` (plugin defaults + that repo's
// sdlc-docs/config.json). A broken project config falls back to the defaults
// plus nothing; the guard already blocks work in such a repo.
export function secretTester(pluginRoot, repo) {
  const defaults = loadDefaults(pluginRoot);
  const proj = repo ? loadProject(repo).cfg : null;
  const cfg = compileSecrets(merge(defaults, [proj]));
  return (name) => nameIsSecret(cfg, path.basename(String(name)));
}
