// Module expansion (breakdown stage 5), deterministic.
//
// A module DEFINITION says which code belongs to it, per app:
//   handlers        controller classes, handler files or folders, Class names
//   paths           files or folders (screens, services, the calls in them)
//   screens         screen ids, when a folder is too coarse
//   extra_routes    single routes from another handler ("METHOD uri")
//   exclude_routes  routes of a listed handler that belong elsewhere
//   groups          code-graph group ids (generic stacks)
// expand() turns it into the full module: routes, screens, calls, tables,
// external services, files, depends_on and size, and checks the rule of the
// gate: every live route of every backend app is in exactly one module or
// matched by an `unassigned` entry that gives a reason.

import { uniq } from './readers/common.mjs';

export const RISK_FLAGS = ['money', 'security', 'clinical', 'personal-data'];
const arr = (v) => (v === null || v === undefined ? [] : Array.isArray(v) ? v.map((x) => String(x)) : [String(v)]);
const lc = (s) => String(s || '').toLowerCase();
export const under = (file, p) => {
  if (!file || !p) return false;
  const q = String(p).replace(/\/+$/, '');
  return file === q || file.startsWith(q + '/');
};
const citeFile = (cite) => (cite ? cite.replace(/:\d+$/, '') : null);

export function handlerMatches(route, h) {
  const x = lc(h).replace(/\\\\/g, '\\');
  if (!x) return false;
  const ctl = lc(route.controller);
  if (ctl && (ctl === x || ctl.split('\\').pop() === x)) return true;
  const hd = lc(route.handler);
  if (hd === x) return true;
  if (/^[\w$]+\.[\w$]+$/.test(route.handler || '') && hd.split('.')[0] === x) return true;
  const hf = lc(route.handlerFile);
  if (hf && (hf === x || hf.startsWith(x.replace(/\/+$/, '') + '/'))) return true;
  if (hd.startsWith(x + '#')) return true;
  return false;
}

function handlerKnown(app, h) {
  const x = lc(h);
  return app.handlers.some((k) => lc(k.id) === x || lc(k.name) === x || lc(k.id).split('\\').pop() === x || lc(k.file) === x || lc(k.file).startsWith(x.replace(/\/+$/, '') + '/'));
}

export function globToRegex(pattern) {
  const t = String(pattern).trim();
  const m = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ANY|WS|\*)\s+(.+)$/i.exec(t);
  const method = m ? m[1].toUpperCase() : '*';
  const uri = (m ? m[2] : t).replace(/^\/+/, '') || '/';
  const re = uri
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return { method, re: new RegExp(`^${re}$`) };
}

function sizeOf(n) {
  return n < 10 ? 'S' : n < 40 ? 'M' : 'L';
}

// sys: { apps: Map(appId -> app facts with .repo) }, links: links.json or null,
// existing: parsed modules.yaml or null
export function expand(def, sys, { links = null, existing = null, allowRemove = [] } = {}) {
  const errors = [];
  const warnings = [];
  const backends = arr(def && def.backends);
  if (!def || typeof def !== 'object') return { errors: ['the proposal is empty'], warnings, modules: [], coverage: [], conflicts: [], unassigned: [] };
  for (const b of backends) if (!sys.apps.has(b)) errors.push(`unknown backend app "${b}" (apps: ${[...sys.apps.keys()].join(', ')})`);
  if (!backends.length) warnings.push('no backends listed: route coverage is not checked');
  const defs = Array.isArray(def.modules) ? def.modules : [];
  if (!defs.length) errors.push('no modules in the proposal');
  const ids = defs.map((m) => m && m.id);
  for (const id of ids) if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(String(id || ''))) errors.push(`bad module id "${id}" (use kebab-case: letters, digits, dashes)`);
  for (const id of uniq(ids.filter((x, i) => ids.indexOf(x) !== i))) errors.push(`duplicate module id "${id}"`);

  const modules = [];
  const claims = new Map(); // "app|key" -> [module ids]
  for (const m of defs) {
    if (!m || typeof m !== 'object') continue;
    if (!m.name || !String(m.name).trim()) errors.push(`module ${m.id}: needs a plain-language name`);
    if (!m.purpose) warnings.push(`module ${m.id}: no purpose sentence`);
    const risk = [];
    for (const r of Array.isArray(m.risk) ? m.risk : arr(m.risk)) {
      const flag = typeof r === 'object' && r ? r.flag : r;
      const reason = typeof r === 'object' && r ? r.reason : null;
      if (!RISK_FLAGS.includes(String(flag))) errors.push(`module ${m.id}: unknown risk flag "${flag}" (use ${RISK_FLAGS.join(', ')})`);
      else if (!reason || !String(reason).trim()) errors.push(`module ${m.id}: risk flag ${flag} needs a reason`);
      else risk.push({ flag: String(flag), reason: String(reason) });
    }
    const out = { id: String(m.id), name: String(m.name || ''), purpose: m.purpose ? String(m.purpose) : null, risk, critical: risk.length > 0 || m.critical === true, parts: [], routes: [], webRoutes: [], screens: [], calls: [], tables: [], externals: [], files: [], handlers: [] };
    for (const p of Array.isArray(m.parts) ? m.parts : []) {
      const appId = String((p && p.app) || '');
      const a = sys.apps.get(appId);
      const part = { app: appId, handlers: arr(p && p.handlers), paths: arr(p && p.paths), screens: arr(p && p.screens), extra_routes: arr(p && p.extra_routes), exclude_routes: arr(p && p.exclude_routes), groups: arr(p && p.groups), tables: arr(p && p.tables) };
      out.parts.push(part);
      if (!a) {
        errors.push(`module ${m.id}: unknown app "${appId}"`);
        continue;
      }
      const live = a.routes.filter((r) => !r.shadowed);
      const keys = new Set(live.map((r) => r.key));
      for (const h of part.handlers) if (!live.some((r) => handlerMatches(r, h)) && !handlerKnown(a, h)) errors.push(`module ${m.id}: unknown handler "${h}" in ${appId}`);
      for (const k of part.extra_routes.concat(part.exclude_routes)) if (!keys.has(k)) errors.push(`module ${m.id}: unknown route "${k}" in ${appId}`);
      for (const s of part.screens) if (!a.screens.some((x) => x.id === s)) errors.push(`module ${m.id}: unknown screen "${s}" in ${appId}`);
      for (const g of part.groups) if (!a.groups.some((x) => x.id === g)) errors.push(`module ${m.id}: unknown code group "${g}" in ${appId}`);
      const groupFiles = a.groups.filter((g) => part.groups.includes(g.id)).flatMap((g) => g.files);
      const inPaths = (f) => part.paths.some((pp) => under(f, pp)) || groupFiles.includes(f);
      const picked = live.filter((r) => part.handlers.some((h) => handlerMatches(r, h)) || inPaths(r.handlerFile) || inPaths(citeFile(r.cite)));
      const mine = new Set(picked.map((r) => r.key).concat(part.extra_routes));
      for (const k of part.exclude_routes) mine.delete(k);
      const myRoutes = live.filter((r) => mine.has(r.key));
      for (const k of mine) {
        const ck = `${appId}|${k}`;
        if (!claims.has(ck)) claims.set(ck, []);
        if (!claims.get(ck).includes(out.id)) claims.get(ck).push(out.id);
      }
      const handlerIds = new Set(myRoutes.map((r) => r.handler).filter(Boolean));
      for (const h of part.handlers) for (const k of a.handlers) if (lc(k.id) === lc(h) || lc(k.name) === lc(h) || lc(k.id).split('\\').pop() === lc(h)) for (const mt of k.methods || []) handlerIds.add(`${k.id}@${mt.name}`);
      const tables = [];
      for (const r of myRoutes) {
        const hk = a.handlers.find((x) => (r.controller && x.id === r.controller) || x.file === r.handlerFile);
        if (!hk) continue;
        const mt = (hk.methods || []).find((x) => x.name === r.action);
        tables.push(...(mt ? mt.tables || [] : []), ...(hk.tables || []));
      }
      for (const md of a.models || []) if (inPaths(md.file)) tables.push(md.table);
      tables.push(...part.tables);
      const screens = a.screens.filter((s) => !s.partial && ((s.file && inPaths(s.file)) || part.screens.includes(s.id) || (s.renderedBy || []).some((rb) => handlerIds.has(rb))));
      const calls = a.calls.filter((c) => inPaths(c.file) || (c.handler && handlerIds.has(c.handler)) || (c.screen && screens.some((s) => s.id === c.screen)));
      const files = uniq([...myRoutes.map((r) => r.handlerFile), ...screens.map((s) => s.file), ...part.paths, ...groupFiles].filter(Boolean));
      const externals = (a.externals ? a.externals.systems : []).filter((sy) => sy.files.some((f) => files.some((mf) => under(f.file, mf)))).map((sy) => sy.system);
      const isBackend = backends.includes(appId);
      for (const r of myRoutes) (isBackend ? out.routes : out.webRoutes).push({ app: appId, key: r.key, handler: r.handler, cite: r.cite });
      out.screens.push(...screens.map((s) => ({ app: appId, id: s.id, path: s.path || null, file: s.file || null, cite: s.cite })));
      out.calls.push(...calls.map((c) => ({ app: appId, cite: c.cite, method: c.method, uri: c.uri || c.routeName || null })));
      out.tables.push(...tables);
      out.externals.push(...externals);
      out.files.push(...files.map((f) => `${a.repo}:${f}`));
      out.handlers.push(...[...handlerIds].map((h) => `${appId}:${h}`));
    }
    out.tables = uniq(out.tables).sort();
    out.externals = uniq(out.externals).sort();
    out.files = uniq(out.files);
    out.handlers = uniq(out.handlers);
    out.size = sizeOf(out.routes.length + out.webRoutes.length + out.screens.length);
    modules.push(out);
  }

  // coverage of the backend apps
  const unassigned = [];
  const entries = (Array.isArray(def.unassigned) ? def.unassigned : []).map((u, i) => {
    const match = typeof u === 'object' && u ? u.match || u.route : u;
    const reason = typeof u === 'object' && u ? u.reason : null;
    if (!match) errors.push(`unassigned entry ${i + 1}: needs "match"`);
    if (!reason || !String(reason).trim()) errors.push(`unassigned entry ${i + 1} (${match}): needs a reason`);
    return { match: String(match || ''), reason: String(reason || ''), app: typeof u === 'object' && u && u.app ? String(u.app) : null, g: globToRegex(match || ''), hits: 0 };
  });
  const coverage = [];
  const conflicts = [];
  for (const b of backends) {
    const a = sys.apps.get(b);
    if (!a) continue;
    const live = uniq(a.routes.filter((r) => !r.shadowed).map((r) => r.key));
    let assigned = 0;
    let explained = 0;
    const uncovered = [];
    for (const k of live) {
      const c = claims.get(`${b}|${k}`) || [];
      if (c.length > 1) conflicts.push({ app: b, route: k, modules: c });
      if (c.length) {
        assigned++;
        continue;
      }
      const [method, uri] = [k.split(' ')[0], k.slice(k.indexOf(' ') + 1)];
      const e = entries.find((x) => (!x.app || x.app === b) && (x.g.method === '*' || x.g.method === method) && x.g.re.test(uri));
      if (e) {
        e.hits++;
        explained++;
        unassigned.push({ app: b, route: k, reason: e.reason, match: e.match });
      } else uncovered.push(k);
    }
    coverage.push({ app: b, routes: live.length, assigned, explained, uncovered });
    if (uncovered.length) errors.push(`${b}: ${uncovered.length} route(s) are in no module and not explained (first: ${uncovered.slice(0, 5).join(', ')})`);
  }
  for (const c of conflicts) errors.push(`${c.app}: route "${c.route}" is claimed by ${c.modules.join(' and ')}`);
  for (const e of entries) if (!e.hits) warnings.push(`unassigned entry "${e.match}" matches no unclaimed route`);

  // modules people approved before must not vanish without a yes
  const removed = [];
  for (const old of (existing && Array.isArray(existing.modules) ? existing.modules : [])) {
    if (old && old.id && !modules.some((x) => x.id === old.id)) {
      removed.push(old.id);
      if (!allowRemove.includes(old.id)) errors.push(`module ${old.id} was approved before and is missing from the proposal (keep it, or pass --allow-remove ${old.id} after the person agrees)`);
    }
  }

  // depends_on: a module's calls that land on another module's routes
  const owner = new Map();
  for (const [ck, ms] of claims) if (ms.length === 1) owner.set(ck, ms[0]);
  if (links && Array.isArray(links.calls)) {
    const byCite = new Map(links.calls.filter((c) => c.route && (c.status === 'matched' || c.status === 'method-mismatch')).map((c) => [`${c.app}|${c.cite}`, c]));
    for (const mo of modules) {
      const dep = new Map();
      for (const c of mo.calls) {
        const l = byCite.get(`${c.app}|${c.cite}`);
        if (!l) continue;
        const o = owner.get(`${l.route.app}|${l.route.key}`);
        if (o && o !== mo.id) {
          if (!dep.has(o)) dep.set(o, []);
          if (dep.get(o).length < 3) dep.get(o).push(`${c.cite} -> ${l.route.key}`);
        }
      }
      mo.dependsOn = [...dep.keys()].sort();
      mo.dependsEvidence = Object.fromEntries(dep);
    }
  } else for (const mo of modules) {
    mo.dependsOn = [];
    mo.dependsEvidence = {};
  }
  return { backends, modules, coverage, conflicts, unassigned, errors, warnings, removed };
}

// The modules.yaml object: definition fields, derived fields, and the fields
// people own (kept from the existing file).
export function toModulesYaml(def, res, { existing = null, commits = {}, approvedBy = null, date }) {
  const prev = new Map(((existing && existing.modules) || []).filter(Boolean).map((m) => [m.id, m]));
  return {
    version: 1,
    generated: date,
    approved: { by: approvedBy, on: date },
    backends: res.backends,
    commits,
    modules: res.modules.map((m) => {
      const p = prev.get(m.id) || {};
      return {
        id: m.id,
        name: m.name,
        purpose: m.purpose,
        risk: m.risk,
        critical: m.critical,
        size: m.size,
        owner: p.owner || 'TBD',
        doc_status: p.doc_status || 'none',
        in_use: p.in_use || { dev: 'TBD', staging: 'TBD', production: 'TBD' },
        parts: m.parts.map((x) => {
          const o = { app: x.app };
          for (const k of ['handlers', 'paths', 'screens', 'extra_routes', 'exclude_routes', 'groups', 'tables']) if (x[k].length) o[k] = x[k];
          return o;
        }),
        depends_on: m.dependsOn,
        depends_evidence: m.dependsEvidence,
        routes: m.routes.map((r) => `${r.app}|${r.key}`),
        web_routes: m.webRoutes.map((r) => `${r.app}|${r.key}`),
        screens: m.screens.map((s) => `${s.app}|${s.id}`),
        tables: m.tables,
        external_systems: m.externals,
      };
    }),
    unassigned: groupUnassigned(res.unassigned),
  };
}

function groupUnassigned(list) {
  const by = new Map();
  for (const u of list) {
    const k = `${u.app}|${u.match}`;
    if (!by.has(k)) by.set(k, { app: u.app, match: u.match, reason: u.reason, routes: [] });
    by.get(k).routes.push(u.route);
  }
  return [...by.values()];
}

// The definition part of a modules.yaml, as a proposal to edit.
export function definitionOf(modulesYaml) {
  return {
    backends: modulesYaml.backends || [],
    modules: (modulesYaml.modules || []).map((m) => ({ id: m.id, name: m.name, purpose: m.purpose, ...(m.risk && m.risk.length ? { risk: m.risk } : {}), parts: m.parts || [] })),
    unassigned: (modulesYaml.unassigned || []).map((u) => ({ ...(u.app ? { app: u.app } : {}), match: u.match, reason: u.reason })),
  };
}

export function previewText(res) {
  const L = ['| id | name | parts | backend routes | other routes | screens | tables | risk | size |', '|---|---|---|---|---|---|---|---|---|'];
  for (const m of res.modules) {
    const parts = m.parts.map((p) => `${p.app}: ${[p.handlers.length && `${p.handlers.length} handlers`, p.paths.length && `${p.paths.length} paths`, p.screens.length && `${p.screens.length} screens`, p.groups.length && `${p.groups.length} groups`].filter(Boolean).join(', ') || 'routes only'}`).join('; ');
    L.push(`| ${m.id} | ${m.name} | ${parts} | ${m.routes.length} | ${m.webRoutes.length} | ${m.screens.length} | ${m.tables.length} | ${m.risk.map((r) => r.flag).join(', ') || '-'} | ${m.size} |`);
  }
  L.push('');
  for (const c of res.coverage) L.push(`Coverage (${c.app}): ${c.assigned} of ${c.routes} routes in a module, ${c.explained} unassigned with a reason, ${c.uncovered.length} neither.`);
  const groups = groupUnassigned(res.unassigned);
  if (groups.length) {
    L.push('Unassigned, with reasons:');
    for (const g of groups) L.push(`  ${g.app}: ${g.match} (${g.routes.length}): ${g.reason}`);
  }
  L.push(res.conflicts.length ? `CONFLICTS: ${res.conflicts.length}` : 'Conflicts: none.');
  if (res.errors.length) L.push('ERRORS:', ...res.errors.map((e) => `  ${e}`));
  if (res.warnings.length) L.push('Warnings:', ...res.warnings.map((e) => `  ${e}`));
  return L.join('\n');
}
