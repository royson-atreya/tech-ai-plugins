#!/usr/bin/env node
// breakdown stage 5: propose modules.
//
//   node modules.mjs candidates --home HOME     writes _map/candidates.md: the compact
//                                               material the module-proposer agent reads
//   node modules.mjs routes --home HOME --app APP [--handler X] [--prefix P] [--unclaimed] [--limit N]
//                                               lists routes for a question, never the whole file
//   node modules.mjs preview --home HOME [--from FILE] [--allow-remove a,b]
//                                               expands _map/module-proposal.yaml; prints the table,
//                                               coverage, conflicts and errors; writes nothing
//   node modules.mjs write --home HOME [--from FILE] [--allow-remove a,b] [--by NAME]
//                                               after the person's yes: writes modules.yaml
//   node modules.mjs reopen --home HOME         copies the approved definitions back into
//                                               _map/module-proposal.yaml for changes
//   node modules.mjs diff --home HOME           what changed in the code since approval (JSON)

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { communities, loadGraph } from '../lib/graph.mjs';
import { definitionOf, expand, previewText, toModulesYaml } from '../lib/modules.mjs';
import { parseYaml, toYaml, YamlError } from '../lib/yaml.mjs';
import { docsDir, fail, parseArgs, real, today, writeDocs } from './common.mjs';
import { factsStamps, loadLinks, loadSystem } from './load.mjs';
import { loadState, saveState } from './state.mjs';
import { writeIndexFromYaml } from './write.mjs';

const PROPOSAL = path.join('_map', 'module-proposal.yaml');
const MODULES = 'modules.yaml';

function readYamlFile(p, what) {
  if (!fs.existsSync(p)) return null;
  try {
    return parseYaml(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    if (e instanceof YamlError) fail(`${what} could not be read (${e.message}); fix it and run again`);
    throw e;
  }
}

export function loadExisting(home) {
  return readYamlFile(path.join(docsDir(home), MODULES), 'sdlc-docs/modules.yaml');
}

const hashOf = (t) => crypto.createHash('sha1').update(t).digest('hex').slice(0, 16);

// ------------------------------------------------------------------ candidates

const STOP = new Set(['api', 'v1', 'v2', 'v3', 'get', 'post', 'put', 'delete', 'update', 'create', 'store', 'index', 'show', 'edit', 'list', 'all', 'id', 'data', 'details', 'detail', 'admin', 'user', 'users', 'app', 'lib', 'src', 'screen', 'screens', 'page', 'pages', 'view', 'views', 'controller', 'controllers', 'model', 'models', 'service', 'services', 'common', 'utils', 'util', 'helpers', 'widgets', 'components', 'http', 'new', 'by', 'and', 'the', 'for', 'with', 'from', 'to', 'of', 'in', 'on', 'add', 'remove', 'save', 'check', 'status', 'type', 'types', 'info', 'table', 'tables', 'created', 'at', 'updated', 'name', 'resources', 'routes', 'route', 'features', 'feature', 'modules', 'module', 'core', 'base', 'main', 'test', 'tests']);

function terms(texts) {
  const count = new Map();
  for (const t of texts) {
    for (const w of String(t).replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^A-Za-z]+/)) {
      const x = w.toLowerCase();
      if (x.length < 4 || STOP.has(x)) continue;
      count.set(x, (count.get(x) || 0) + 1);
    }
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
}

export function candidates(home) {
  const sys = loadSystem(home);
  const links = loadLinks(home);
  const existing = loadExisting(home);
  const L = ['# Module candidates', '', `Material for proposing modules, from /tech-plugin:breakdown stages 3-4 on ${today()}. Raw grouping only: modules are decided in \`module-proposal.yaml\` and approved into \`modules.yaml\`.`, ''];
  const name = (sys.system.system && sys.system.system.name) || path.basename(home);
  const b = sys.system.business || {};
  L.push(`**System:** ${name}. ${b.product ? `Product: ${b.product}. ` : ''}${b.users ? `Users: ${b.users}. ` : ''}${Array.isArray(b.roles) && b.roles.length ? `Roles: ${b.roles.join(', ')}. ` : ''}${Array.isArray(b.key_flows) && b.key_flows.length ? `Key flows: ${b.key_flows.join('; ')}.` : ''}`, '');
  L.push('| App | Repo | Kind | Readers | Routes | Screens | Calls | Tables | Code groups |', '|---|---|---|---|---|---|---|---|---|');
  for (const [id, a] of sys.apps) L.push(`| ${id} | ${a.repo} | ${a.kind} | ${a.readers.join(', ')} | ${a.counts.uniqueRoutes} | ${a.counts.screens} | ${a.counts.calls} | ${a.counts.tables} | ${a.counts.groups} |`);
  L.push('');
  const withRoutes = [...sys.apps.values()].filter((a) => a.counts.uniqueRoutes > 0);
  const byRole = withRoutes.filter((a) => /backend|api|server/i.test(a.repoRole || ''));
  const backendGuess = (byRole.length ? byRole : withRoutes.filter((a) => /backend/i.test(a.kind))).map((a) => a.id);
  L.push(`**Backend apps (routes must all be covered):** ${backendGuess.join(', ') || 'none found; list the apps whose routes matter under backends:'}`, '');
  const callers = new Map();
  if (links) for (const c of links.calls) if (c.route && c.status === 'matched') {
    const k = `${c.route.app}|${c.route.key}`;
    if (!callers.has(k)) callers.set(k, new Set());
    callers.get(k).add(c.app);
  }
  for (const [id, a] of sys.apps) {
    const live = a.routes.filter((r) => !r.shadowed);
    if (live.length) {
      L.push(`## ${id}: routes by handler (${live.length})`, '');
      L.push('| Handler | Routes | URI prefixes | Middleware | Tables | Screens rendered | Called by | Graph group |', '|---|---|---|---|---|---|---|---|');
      const by = new Map();
      for (const r of live) {
        const h = r.controller ? r.controller.split('\\').pop() : r.kind === 'closure' ? '(closures)' : r.handlerFile || r.handler || '(none)';
        if (!by.has(h)) by.set(h, []);
        by.get(h).push(r);
      }
      const rows = [...by.entries()].sort((x, y) => y[1].length - x[1].length);
      for (const [h, rs] of rows.slice(0, 200)) {
        const pre = new Map();
        for (const r of rs) {
          const p = r.uri.split('/').slice(0, 2).join('/');
          pre.set(p, (pre.get(p) || 0) + 1);
        }
        const hk = a.handlers.find((x) => x.name === h || x.file === h || x.id === h);
        const tables = hk ? [...new Set([...(hk.tables || []), ...(hk.methods || []).flatMap((m) => m.tables || [])])] : [];
        const views = hk ? [...new Set((hk.methods || []).flatMap((m) => m.views || []))] : [];
        const by2 = new Set();
        for (const r of rs) for (const x of callers.get(`${id}|${r.key}`) || []) by2.add(x);
        L.push(`| ${h} | ${rs.length} | ${[...pre.entries()].map(([p, n]) => `${p} (${n})`).slice(0, 4).join(', ')} | ${[...new Set(rs.flatMap((r) => r.middleware))].slice(0, 4).join(', ')} | ${tables.slice(0, 6).join(', ')} | ${views.slice(0, 4).join(', ')} | ${[...by2].join(', ')} | ${hk && hk.group ? hk.group : ''} |`);
      }
      if (rows.length > 200) L.push(`| … ${rows.length - 200} more handlers: use \`modules.mjs routes\` | | | | | | | |`);
      L.push('');
    }
    const scr = a.screens.filter((s) => !s.partial);
    if (scr.length) {
      L.push(`## ${id}: screens by folder (${scr.length})`, '');
      L.push('| Folder | Screens | Their API calls land on (handler, count) | Graph group |', '|---|---|---|---|');
      const by = new Map();
      for (const s of scr) {
        const f = s.file ? s.file.split('/').slice(0, -1).slice(0, 4).join('/') : '(no file)';
        if (!by.has(f)) by.set(f, []);
        by.get(f).push(s);
      }
      for (const [f, ss] of [...by.entries()].sort((x, y) => y[1].length - x[1].length).slice(0, 150)) {
        const hits = new Map();
        if (links) for (const c of links.calls) if (c.app === id && c.route && (ss.some((s) => s.id === c.screen) || (c.area && f.startsWith(c.area)))) {
          const r = sys.apps.get(c.route.app) && sys.apps.get(c.route.app).routes.find((x) => x.key === c.route.key);
          const h = r ? (r.controller ? r.controller.split('\\').pop() : r.handlerFile) : c.route.key;
          hits.set(h, (hits.get(h) || 0) + 1);
        }
        L.push(`| \`${f}\` | ${ss.slice(0, 8).map((s) => s.id).join(', ')}${ss.length > 8 ? ` (+${ss.length - 8})` : ''} | ${[...hits.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4).map(([h, n]) => `${h} (${n})`).join(', ')} | ${[...new Set(ss.map((s) => s.group).filter(Boolean))].join(', ')} |`);
      }
      L.push('');
    }
    if (a.groups.length) {
      L.push(`## ${id}: code groups from the graph (${a.groups.length})`, '', '| Group | Files | Main folder | Example files |', '|---|---|---|---|');
      for (const g of a.groups.slice(0, 60)) L.push(`| ${g.id} | ${g.fileCount} | \`${g.label}\` | ${g.files.slice(0, 4).map((f) => `\`${f}\``).join(', ')} |`);
      L.push('');
    }
  }
  for (const r of sys.repos) {
    const g = loadGraph(path.join(docsDir(r.abs), '_map', 'graphify', r.name, 'graph.json'));
    if (!g) continue;
    const cs = communities(g).slice(0, 25);
    L.push(`## ${r.name}: biggest code-graph groups`, '', '| Group | Symbols | Files | Main folder | Hubs |', '|---|---|---|---|---|');
    for (const c of cs) L.push(`| c${c.id.replace(/^c/, '')} | ${c.size} | ${c.fileCount} | \`${c.folder}\` | ${c.hubs.slice(0, 5).join(', ')} |`);
    L.push('');
  }
  const words = terms([...sys.apps.values()].flatMap((a) => [...a.routes.map((r) => r.uri), ...a.tables.map((t) => t.name), ...a.screens.map((s) => s.id)]));
  if (words.length) L.push('## Domain words seen in routes, tables and screens', '', words.map(([w, n]) => `${w} (${n})`).join(', '), '');
  if (existing && Array.isArray(existing.modules)) {
    L.push('## Approved modules (keep their ids, names and boundaries)', '', '| id | name | parts |', '|---|---|---|');
    for (const m of existing.modules) L.push(`| ${m.id} | ${m.name} | ${(m.parts || []).map((p) => `${p.app}: ${[...(p.handlers || []), ...(p.paths || [])].slice(0, 6).join(', ')}`).join('; ')} |`);
    L.push('');
  }
  writeDocs(home, path.join('_map', 'candidates.md'), L.join('\n'));
  return { lines: L.length, apps: sys.apps.size };
}

// ------------------------------------------------------------------ preview / write

function loadProposal(home, from) {
  const p = from ? real(from) : path.join(docsDir(home), PROPOSAL);
  const def = readYamlFile(p, from || 'sdlc-docs/_map/module-proposal.yaml');
  if (!def) fail(`no proposal at ${p}; the module-proposer agent writes it`);
  return { def, text: fs.readFileSync(p, 'utf8') };
}

function run(home, { from = null, allowRemove = [] } = {}) {
  const sys = loadSystem(home);
  const { def, text } = loadProposal(home, from);
  const existing = loadExisting(home);
  const res = expand(def, sys, { links: loadLinks(home), existing, allowRemove });
  return { sys, def, text, existing, res };
}

export function preview(home, opts) {
  const { res, text } = run(home, opts);
  const ok = !res.errors.length;
  if (ok) {
    const st = loadState(home);
    st.stages = { ...(st.stages || {}), 5: { ...((st.stages || {})['5'] || {}), status: 'awaiting-approval', at: new Date().toISOString(), proposal: hashOf(text) } };
    saveState(home, st);
  }
  return { ok, text: previewText(res), res };
}

function gitUser(home) {
  const r = spawnSync('git', ['-C', home, 'config', 'user.name'], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

export function writeModules(home, { from = null, allowRemove = [], by = null } = {}) {
  const { sys, def, res, existing } = run(home, { from, allowRemove });
  if (res.errors.length) return { ok: false, text: previewText(res) };
  const who = by || gitUser(home) || 'the user';
  const commits = Object.fromEntries(sys.repos.map((r) => [r.name, r.facts ? r.facts.commit : null]));
  const obj = toModulesYaml(def, res, { existing, commits, approvedBy: who, date: today() });
  const header = 'tech-plugin modules: the single source of truth for module boundaries.\nWritten by /tech-plugin:breakdown stage 5 after approval. Module ids never change.\nYou own: owner, doc_status, in_use, and the definition fields (name, purpose, risk, parts).\nEverything else is derived from the code and rewritten on every approval.';
  const text = toYaml(obj, header);
  const prevFile = path.join(docsDir(home), MODULES);
  if (fs.existsSync(prevFile)) writeDocs(home, path.join('_map', 'modules.yaml.prev'), fs.readFileSync(prevFile, 'utf8'));
  writeDocs(home, MODULES, text);
  const st = loadState(home);
  st.stages = { ...(st.stages || {}), 5: { status: 'done', at: new Date().toISOString(), approvedBy: who, inputs: factsStamps(sys.repos), modules: hashOf(text) } };
  saveState(home, st);
  writeIndexFromYaml(home);
  return { ok: true, text: previewText(res), who, count: res.modules.length };
}

export function reopen(home) {
  const existing = loadExisting(home);
  if (!existing) fail('no modules.yaml yet; nothing to reopen');
  writeDocs(home, PROPOSAL, toYaml(definitionOf(existing), 'Module proposal, copied from the approved modules.yaml. Change it, then run modules.mjs preview.'));
}

// What changed since approval: routes that are new, gone, or now land in
// another module. No change -> nothing for the person to approve.
export function diff(home) {
  const existing = loadExisting(home);
  if (!existing) return { approved: false, changed: true, reason: 'no modules.yaml yet' };
  const sys = loadSystem(home);
  const res = expand(definitionOf(existing), sys, { links: loadLinks(home), existing });
  const before = new Map();
  for (const m of existing.modules || []) for (const r of m.routes || []) before.set(r, m.id);
  const beforeUn = new Set((existing.unassigned || []).flatMap((u) => (u.routes || []).map((r) => `${u.app}|${r}`)));
  const now = new Map();
  for (const m of res.modules) for (const r of m.routes) now.set(`${r.app}|${r.key}`, m.id);
  const nowUn = new Set(res.unassigned.map((u) => `${u.app}|${u.route}`));
  const current = new Set();
  for (const b of res.backends) for (const r of (sys.apps.get(b) || { routes: [] }).routes) if (!r.shadowed) current.add(`${b}|${r.key}`);
  const added = [...current].filter((k) => !before.has(k) && !beforeUn.has(k));
  const removed = [...before.keys(), ...beforeUn].filter((k) => !current.has(k));
  const moved = [...now.entries()].filter(([k, id]) => before.has(k) && before.get(k) !== id).map(([k, id]) => ({ route: k, from: before.get(k), to: id }));
  const newScreens = [];
  const knownScreens = new Set((existing.modules || []).flatMap((m) => m.screens || []));
  for (const m of res.modules) for (const s of m.screens) if (!knownScreens.has(`${s.app}|${s.id}`)) newScreens.push(`${s.app}|${s.id}`);
  const unexplained = res.coverage.flatMap((c) => c.uncovered.map((k) => `${c.app}|${k}`));
  void nowUn;
  return { approved: true, changed: !!(added.length || removed.length || moved.length || unexplained.length), added, removed, moved, newScreens, unexplained, errors: res.errors };
}

// After a code change with no module change: refresh modules.yaml's derived
// fields without asking again (the definitions stay exactly as approved).
export function refresh(home) {
  const existing = loadExisting(home);
  const d = diff(home);
  if (d.changed) return { ok: false, diff: d };
  const tmp = path.join(docsDir(home), '_state', 'modules-refresh.yaml');
  writeDocs(home, path.join('_state', 'modules-refresh.yaml'), toYaml(definitionOf(existing)));
  const r = writeModules(home, { from: tmp, by: existing.approved && existing.approved.by ? existing.approved.by : null });
  fs.rmSync(tmp, { force: true });
  return { ok: r.ok, diff: d };
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = parseArgs(rest, ['unclaimed']);
  if (!a.home) fail('usage: modules.mjs <candidates|routes|preview|write|reopen|diff|refresh> --home HOME');
  const home = real(a.home);
  const allowRemove = a['allow-remove'] ? String(a['allow-remove']).split(',').map((x) => x.trim()) : [];
  if (cmd === 'candidates') {
    const r = candidates(home);
    process.stdout.write(`wrote sdlc-docs/_map/candidates.md (${r.lines} lines, ${r.apps} apps)\n`);
  } else if (cmd === 'routes') {
    const sys = loadSystem(home);
    const app = sys.apps.get(a.app);
    if (!app) fail(`unknown app ${a.app} (apps: ${[...sys.apps.keys()].join(', ')})`);
    let rs = app.routes.filter((r) => !r.shadowed);
    if (a.handler) rs = rs.filter((r) => (r.handler || '').toLowerCase().includes(String(a.handler).toLowerCase()) || (r.handlerFile || '').toLowerCase().includes(String(a.handler).toLowerCase()));
    if (a.prefix) rs = rs.filter((r) => r.uri.startsWith(String(a.prefix).replace(/^\/+/, '')));
    if (a.unclaimed) {
      const p = fs.existsSync(path.join(docsDir(home), PROPOSAL)) ? loadProposal(home).def : { backends: [a.app], modules: [] };
      const res = expand({ ...p, backends: [a.app] }, sys, {});
      const un = new Set((res.coverage[0] || { uncovered: [] }).uncovered);
      rs = rs.filter((r) => un.has(r.key));
    }
    const limit = Number(a.limit || 200);
    process.stdout.write(rs.slice(0, limit).map((r) => `${r.key}\t${r.handler || ''}\t${r.cite}`).join('\n') + `\n(${rs.length} route(s)${rs.length > limit ? `, first ${limit} shown` : ''})\n`);
  } else if (cmd === 'preview') {
    const r = preview(home, { from: a.from || null, allowRemove });
    process.stdout.write(r.text + `\n${r.ok ? 'preview only (nothing written). Show it to the person and ask for approval.' : 'not ready: fix the errors above in module-proposal.yaml'}\n`);
    process.exitCode = r.ok ? 0 : 1;
  } else if (cmd === 'write') {
    const r = writeModules(home, { from: a.from || null, allowRemove, by: a.by || null });
    process.stdout.write(r.ok ? `wrote sdlc-docs/modules.yaml: ${r.count} modules, approved by ${r.who}\n` : `${r.text}\nnot written: fix the errors above\n`);
    process.exitCode = r.ok ? 0 : 1;
  } else if (cmd === 'reopen') {
    reopen(home);
    process.stdout.write('wrote sdlc-docs/_map/module-proposal.yaml from modules.yaml\n');
  } else if (cmd === 'diff') {
    process.stdout.write(JSON.stringify(diff(home), null, 2) + '\n');
  } else if (cmd === 'refresh') {
    const r = refresh(home);
    process.stdout.write(r.ok ? 'modules.yaml refreshed: no module changes\n' : `${JSON.stringify(r.diff, null, 2)}\nchanges need the person's approval: run stage 5\n`);
    process.exitCode = r.ok ? 0 : 1;
  } else fail('usage: modules.mjs <candidates|routes|preview|write|reopen|diff|refresh> --home HOME');
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) main();
