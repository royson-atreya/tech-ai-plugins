// Loading helpers shared by breakdown stages 3-6: the system's repos and
// their facts, links, the person's overrides, and the code fingerprint used
// for "already up to date".

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from '../lib/yaml.mjs';
import { makeReader } from '../lib/stacks.mjs';
import { listFiles } from '../lib/readers/common.mjs';
import { commitOf, docsDir, fail, isSecretFor, readJson, writeDocs } from './common.mjs';
import { loadState } from './state.mjs';

export const factsRel = (name) => path.join('_map', name, 'facts.json');
export const OVERRIDES_REL = path.join('_map', 'overrides.yaml');

// Code files of a repo (secrets and dependency folders left out) and a
// fingerprint of them: path, size and modification time. Catches changes in
// repos without commits and uncommitted edits.
export function codeTree(repo) {
  const reader = makeReader(repo, isSecretFor(repo));
  const files = listFiles(reader, '.');
  const h = crypto.createHash('sha1');
  for (const f of files) {
    try {
      const st = fs.statSync(path.join(repo, f));
      h.update(`${f}:${st.size}:${Math.round(st.mtimeMs)}\n`);
    } catch {
      h.update(`${f}:gone\n`);
    }
  }
  return { files, reader, tree: h.digest('hex').slice(0, 16) };
}

export function stampOf(repo) {
  return { commit: commitOf(repo), tree: codeTree(repo).tree };
}

const OVERRIDES_TEMPLATE = `# overrides.yaml: your fixes for what the scripts cannot work out.
# You own this file: /tech-plugin:breakdown reads it on every run and never changes it.
#
# base_url_names: extra names that hold the backend's base URL in client code
#   (names like baseUrl, apiUrl, backend_url, API_HOST are known already), e.g.
#   - "AppEnvironment.baseUrl"
# externals: extra external services to look for, e.g.
#   - name: "Samvit Chakra"
#     pattern: "samvit"
# links: fixes for calls the scripts cannot link; "source" is the call site exactly as
#   listed in _map/links.md, "route" is "METHOD uri" exactly as in the backend's facts, e.g.
#   - source: "lib/services/api.dart:120"
#     route: "POST api/login"
#   - source: "public/js/old.js:14"
#     ignore: "dead code"
base_url_names: []
externals: []
links: []
`;

export function loadOverrides(home, { create = false } = {}) {
  const p = path.join(docsDir(home), OVERRIDES_REL);
  if (!fs.existsSync(p)) {
    if (create && fs.existsSync(docsDir(home))) writeDocs(home, OVERRIDES_REL, OVERRIDES_TEMPLATE);
    return { base_url_names: [], externals: [], links: [] };
  }
  try {
    const y = parseYaml(fs.readFileSync(p, 'utf8')) || {};
    return { base_url_names: y.base_url_names || [], externals: y.externals || [], links: y.links || [] };
  } catch (e) {
    fail(`sdlc-docs/_map/overrides.yaml could not be read (${e.message}); fix it by hand and run again`);
  }
}

export function baseRegex(names) {
  const list = (names || []).map((n) => String(n).trim()).filter(Boolean);
  if (!list.length) return null;
  return new RegExp(`(^|[^\\w$])(${list.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\./g, '(?:\\.|\\(\\)\\.)')).join('|')})([^\\w$]|$)`);
}

export function loadSystemYaml(home) {
  try {
    return parseYaml(fs.readFileSync(path.join(docsDir(home), 'system.yaml'), 'utf8')) || {};
  } catch {
    return {};
  }
}

export function ownHosts(system) {
  const out = [];
  for (const e of (system.business && system.business.environments) || []) {
    const m = e && e.url ? /^[a-z]+:\/\/([^/:]+)/i.exec(String(e.url)) : null;
    if (m) out.push(m[1].toLowerCase());
  }
  return out;
}

// The repos of the system with their facts (stage 3 output).
export function loadSystem(home, { needFacts = true } = {}) {
  const st = loadState(home);
  if (!st) fail(`no progress file in ${home}; run stage 1 first`);
  const repos = (st.repos || []).map((r) => {
    const abs = path.resolve(home, r.path);
    return { ...r, abs, facts: readJson(path.join(docsDir(abs), factsRel(r.name))), stack: readJson(path.join(docsDir(abs), '_map', r.name, 'stack.json')) };
  });
  if (needFacts) {
    const missing = repos.filter((r) => !r.facts && !(r.stack && r.stack.empty));
    if (missing.length) fail(`no code facts yet for: ${missing.map((r) => r.name).join(', ')} (run stage 3: map.mjs for each repo)`);
  }
  const apps = new Map();
  for (const r of repos) for (const a of (r.facts && r.facts.apps) || []) apps.set(a.id, { ...a, repo: r.name, repoRole: r.role || null });
  return { st, repos, apps, system: loadSystemYaml(home), overrides: loadOverrides(home) };
}

export function loadLinks(home) {
  return readJson(path.join(docsDir(home), '_map', 'links.json'));
}

export function factsStamps(repos) {
  return Object.fromEntries(repos.map((r) => [r.name, r.facts ? `${r.facts.commit || 'none'}:${r.facts.tree}` : 'empty']));
}
