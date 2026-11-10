// Guard configuration: plugin defaults plus each repo's sdlc-docs/config.json.
//
// A project config may only ADD restrictions:
//   secretPatterns, protectedBranches, blockedHosts  -> combined with the defaults
//   secretExceptions, readOnlySubcommands            -> can only shrink
//   safeCommands                                     -> existing lists can only shrink;
//                                                       a new tool adds a new restriction
// Git and self-protection rules are code, not config, so nothing here can loosen them.
// Other keys (tracker, strict mode, model tiers...) belong to later commands and are ignored.

import fs from 'node:fs';
import path from 'node:path';
import { Block } from './core.mjs';

const LIST_KEYS = ['secretPatterns', 'secretExceptions', 'protectedBranches', 'blockedHosts'];
const MAP_KEYS = ['safeCommands', 'readOnlySubcommands'];

function isStrList(v) {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function checkShape(cfg, file) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(`${file} is not a JSON object`);
  for (const k of LIST_KEYS) {
    if (k in cfg && !isStrList(cfg[k])) throw new Error(`${file}: "${k}" must be a list of strings`);
  }
  for (const k of MAP_KEYS) {
    if (!(k in cfg)) continue;
    const m = cfg[k];
    if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error(`${file}: "${k}" must be an object`);
    for (const [tool, list] of Object.entries(m)) {
      if (tool.startsWith('_')) continue;
      if (!isStrList(list)) throw new Error(`${file}: "${k}.${tool}" must be a list of strings`);
    }
  }
}

export function loadDefaults(pluginRoot) {
  const f = path.join(pluginRoot, 'config', 'defaults.json');
  let d;
  try {
    d = JSON.parse(fs.readFileSync(f, 'utf8'));
    checkShape(d, f);
  } catch (e) {
    throw new Block('config', `cannot load the guard defaults (${e.message})`);
  }
  for (const k of LIST_KEYS) d[k] = d[k] || [];
  for (const k of MAP_KEYS) d[k] = stripMeta(d[k] || {});
  return d;
}

function stripMeta(m) {
  const out = {};
  for (const [k, v] of Object.entries(m)) if (!k.startsWith('_')) out[k] = v;
  return out;
}

export function projectConfigPath(repo) {
  return path.join(repo, 'sdlc-docs', 'config.json');
}

// { cfg, error } for one repo; cfg is null when the repo has no config file.
const projCache = new Map();
export function loadProject(repo) {
  if (projCache.has(repo)) return projCache.get(repo);
  const f = projectConfigPath(repo);
  let res;
  let text = null;
  try {
    text = fs.readFileSync(f, 'utf8');
  } catch (e) {
    res = e.code === 'ENOENT' || e.code === 'ENOTDIR' ? { cfg: null, error: null } : { cfg: null, error: `cannot read ${f}: ${e.code}` };
  }
  if (text !== null) {
    try {
      const c = JSON.parse(text);
      checkShape(c, 'sdlc-docs/config.json');
      res = { cfg: c, error: null };
    } catch (e) {
      res = { cfg: null, error: `sdlc-docs/config.json is not valid (${e.message})` };
    }
  }
  projCache.set(repo, res);
  return res;
}

const lc = (s) => s.toLowerCase();

export function merge(defaults, projects) {
  const m = {
    secretPatterns: [...defaults.secretPatterns],
    secretExceptions: [...defaults.secretExceptions],
    protectedBranches: [...defaults.protectedBranches],
    blockedHosts: defaults.blockedHosts.map(lc),
    safeCommands: Object.fromEntries(Object.entries(defaults.safeCommands).map(([k, v]) => [k, [...v]])),
    readOnlySubcommands: Object.fromEntries(Object.entries(defaults.readOnlySubcommands).map(([k, v]) => [k, [...v]])),
  };
  for (const p of projects) {
    if (!p) continue;
    if (p.secretPatterns) m.secretPatterns.push(...p.secretPatterns);
    if (p.protectedBranches) m.protectedBranches.push(...p.protectedBranches);
    if (p.blockedHosts) m.blockedHosts.push(...p.blockedHosts.map(lc));
    if (p.secretExceptions) {
      const keep = new Set(p.secretExceptions.map(lc));
      m.secretExceptions = m.secretExceptions.filter((x) => keep.has(lc(x)));
    }
    for (const [tool, list] of Object.entries(stripMeta(p.safeCommands || {}))) {
      m.safeCommands[tool] = tool in m.safeCommands ? m.safeCommands[tool].filter((x) => list.includes(x)) : [...list];
    }
    for (const [tool, list] of Object.entries(stripMeta(p.readOnlySubcommands || {}))) {
      if (tool in m.readOnlySubcommands) m.readOnlySubcommands[tool] = m.readOnlySubcommands[tool].filter((x) => list.includes(x));
    }
  }
  m.blockedHosts = [...new Set(m.blockedHosts.map((h) => h.trim().replace(/\.$/, '')).filter(Boolean))];
  return m;
}
