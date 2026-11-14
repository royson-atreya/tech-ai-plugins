#!/usr/bin/env node
// /tech-plugin:impact helpers.
//
//   node impact.mjs candidates <ID> --home HOME
//         JSON: every module, ranked by the words of the request it shares
//         (name, purpose, screens, routes, tables); rare words count more
//   node impact.mjs pack <ID> --modules a,b --home HOME
//         writes the impact pack (_state/work/<ID>/impact-pack.md) for the
//         modules the analyst chose and returns what the analyst needs to
//         write impact.md: file, stamp, template, inputs, checks
//   node impact.mjs report <ID> --home HOME
//         writes work/<ID>/impact-report.html from impact.md
//
// The pack is built by script from the code map: routes and screens of each
// module, other apps that call its routes, tables other modules' code uses,
// risk flags, documents that would lose their approval, and (Inferred) code
// the graphify graph groups with it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitDoc } from '../lib/frontmatter.mjs';
import { fileCommunities, loadGraph } from '../lib/graph.mjs';
import { pluginUpdate } from '../lib/version.mjs';
import { PLUGIN_ROOT, docsDir, fail, parseArgs, real, today, writeDocs } from '../breakdown/common.mjs';
import { loadLinks, loadSystem } from '../breakdown/load.mjs';
import { loadExisting } from '../breakdown/modules.mjs';
import { status as breakdownStatus } from '../breakdown/state.mjs';
import { DOCS_ORDER, docInfo, writeFacts } from '../document/doc.mjs';
import { CSS, MERMAID_URL, esc, renderMarkdown } from '../sync/portal.mjs';
import { loadItem, readWorkDoc, refresh, refreshModules, stampFor, stampText, workRel } from './work.mjs';

const STOP = new Set('the and for with from that this into when then than have has had are was were will would should could can not but its their there them they what which who whom how why where all any each every some more most other such only own same very just also about over under after before again once here able want wants need needs make makes made like using use used get gets new old add adds edit show shows see let lets one two way ways page pages screen screens list lists item items data user users people person please thing things part parts work able per via'.split(' '));
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length >= 3 && !STOP.has(w));
// a light stem, so "reports" meets "report" and "booking" meets "book"
const stem = (w) => w.replace(/(ies)$/, 'y').replace(/(ing|ed|es|s)$/, '') || w;
const stems = (s) => new Set(words(s).map(stem));

// ------------------------------------------------------------------ candidates

export function candidates(home, id) {
  const item = loadItem(home, id);
  const req = fs.readFileSync(path.join(item.dir, 'request.md'), 'utf8');
  return { work: id, title: item.title, ...rankModules(home, req) };
}

// Every module, ranked by the words of a text it shares (name, purpose,
// screens, routes, tables); rare words count more. Also used by incidents.
export function rankModules(home, text) {
  const asked = stems(text);
  const my = loadExisting(home) || { modules: [] };
  const fieldsOf = (m) => ({
    name: stems(`${m.id} ${m.name}`),
    purpose: stems(m.purpose),
    screens: stems((m.screens || []).map((k) => k.split('|')[1]).join(' ')),
    routes: stems([...(m.routes || []), ...(m.web_routes || [])].map((k) => k.split('|')[1].replace(/^\w+ /, '')).join(' ')),
    tables: stems((m.tables || []).join(' ')),
  });
  const all = my.modules.map((m) => ({ m, f: fieldsOf(m) }));
  // a word most modules share ("patient", "doctor") says little about which one is meant
  const df = new Map();
  for (const { f } of all) for (const w of new Set(Object.values(f).flatMap((x) => [...x]))) df.set(w, (df.get(w) || 0) + 1);
  const idf = (w) => Math.log((all.length + 1) / ((df.get(w) || 0) + 0.5));
  const weight = { name: 4, purpose: 2, screens: 1, routes: 1, tables: 1 };
  const rows = all.map(({ m, f }) => {
    const matched = {};
    let score = 0;
    for (const [k, set] of Object.entries(f)) {
      const hit = [...asked].filter((w) => set.has(w));
      if (hit.length) matched[k] = hit;
      score += weight[k] * hit.reduce((n, w) => n + idf(w), 0);
    }
    return { id: m.id, name: m.name, purpose: m.purpose || null, risk: (m.risk || []).map((r) => r.flag), score: Math.round(score * 10) / 10, matched };
  });
  rows.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return { likely: rows.filter((r) => r.score > 0 && Object.keys(r.matched).length).slice(0, 8), all: rows.map(({ id: i, name, purpose, risk }) => ({ id: i, name, purpose, risk })) };
}

// ------------------------------------------------------------------ pack

const repoPath = (a, f) => path.posix.normalize(path.posix.join(a.root || '.', f));

// files of every module (route handlers, screens), per repo
export function moduleFiles(sys, my) {
  const out = new Map();
  for (const m of my.modules) {
    const files = new Set();
    for (const k of [...(m.routes || []), ...(m.web_routes || [])]) {
      const [app, key] = [k.slice(0, k.indexOf('|')), k.slice(k.indexOf('|') + 1)];
      const a = sys.apps.get(app);
      const r = a && a.routes.find((x) => x.key === key);
      if (r && r.handlerFile) files.add(`${a.repo}:${repoPath(a, r.handlerFile)}`);
    }
    for (const k of m.screens || []) {
      const [app, sid] = [k.slice(0, k.indexOf('|')), k.slice(k.indexOf('|') + 1)];
      const a = sys.apps.get(app);
      const s = a && a.screens.find((x) => x.id === sid);
      if (s && s.file) files.add(`${a.repo}:${repoPath(a, s.file)}`);
    }
    out.set(m.id, files);
  }
  return out;
}

// tables each module's code reads or writes (from its handlers' methods)
function tablesUsed(sys, my) {
  const out = new Map();
  for (const m of my.modules) {
    const t = new Set();
    for (const k of [...(m.routes || []), ...(m.web_routes || [])]) {
      const app = k.slice(0, k.indexOf('|'));
      const a = sys.apps.get(app);
      const r = a && a.routes.find((x) => x.key === k.slice(k.indexOf('|') + 1));
      if (!r || !r.handler || !r.handler.includes('@')) continue;
      const [ctl, action] = r.handler.split('@');
      const h = a.handlers.find((x) => x.id === ctl);
      const mt = h && (h.methods || []).find((x) => x.name === action);
      for (const x of (mt && mt.tables) || []) t.add(x);
    }
    out.set(m.id, t);
  }
  return out;
}

// modules whose code the graphify graph groups with the chosen modules' code
function graphNeighbours(sys, my, chosen, files) {
  const near = new Map();
  // a file most modules share (a routes file) says nothing about closeness
  const owners = new Map();
  for (const fs_ of files.values()) for (const f of fs_) owners.set(f, (owners.get(f) || 0) + 1);
  const own = (f) => owners.get(f) <= 2;
  for (const r of sys.repos) {
    const g = loadGraph(path.join(docsDir(r.abs), '_map', 'graphify', r.name, 'graph.json'));
    if (!g) continue;
    const fc = fileCommunities(g);
    const comm = (key) => (key.startsWith(`${r.name}:`) ? fc.get(key.slice(r.name.length + 1)) : null);
    const mine = new Set();
    for (const c of chosen) for (const f of files.get(c) || []) if (own(f) && comm(f)) mine.add(comm(f));
    if (!mine.size) continue;
    for (const m of my.modules) {
      if (chosen.includes(m.id)) continue;
      const shared = [...(files.get(m.id) || [])].filter((f) => own(f) && mine.has(comm(f)));
      if (shared.length) near.set(m.id, (near.get(m.id) || []).concat(shared));
    }
  }
  return [...near.entries()].map(([id, f]) => ({ module: id, files: f.slice(0, 5), count: f.length })).sort((a, b) => b.count - a.count || a.module.localeCompare(b.module)).slice(0, 5);
}

export function buildPack(home, id, chosen) {
  const my = loadExisting(home);
  const byId = new Map(my.modules.map((m) => [m.id, m]));
  const sys = loadSystem(home);
  const links = loadLinks(home) || { calls: [], routes: [] };
  const files = moduleFiles(sys, my);
  const used = tablesUsed(sys, my);
  const ownerOfScreen = new Map();
  for (const m of my.modules) for (const k of m.screens || []) ownerOfScreen.set(k, m.id);
  const ownerOfRoute = new Map();
  for (const m of my.modules) for (const k of [...(m.routes || []), ...(m.web_routes || [])]) ownerOfRoute.set(k, m.id);
  // the module of the code that makes a call: its screen's, else its handler's
  const callerModule = (c) => {
    if (c.screen && ownerOfScreen.has(`${c.app}|${c.screen}`)) return ownerOfScreen.get(`${c.app}|${c.screen}`);
    const call = (links.calls || []).find((x) => x.app === c.app && x.cite === c.cite);
    const a = sys.apps.get(c.app);
    const r = call && call.handler && a ? a.routes.find((x) => x.handler === call.handler) : null;
    return r ? ownerOfRoute.get(`${c.app}|${r.key}`) || null : null;
  };
  const out = { work: id, builtAt: new Date().toISOString(), modules: [], neighbours: [] };
  for (const mid of chosen) {
    const m = byId.get(mid);
    const { pack } = writeFacts(home, mid);
    const mine = new Set([...(m.routes || []), ...(m.web_routes || [])]);
    const callers = [];
    for (const r of links.routes || []) {
      if (!mine.has(`${r.app}|${r.key}`)) continue;
      for (const c of r.callers || []) {
        if (c.app === r.app) continue;
        callers.push({ route: `${r.app}|${r.key}`, app: c.app, cite: `${sys.apps.get(c.app) ? sys.apps.get(c.app).repo : c.app}:${c.cite}`, screen: c.screen || null, module: callerModule(c) });
      }
    }
    const shared = [];
    for (const t of m.tables || []) {
      const others = my.modules.filter((x) => x.id !== mid && ((x.tables || []).includes(t) || (used.get(x.id) || new Set()).has(t))).map((x) => x.id);
      if (others.length) shared.push({ table: t, alsoUsedBy: others });
    }
    const usesOthers = [...(used.get(mid) || [])].filter((t) => !(m.tables || []).includes(t)).map((t) => ({ table: t, ownedBy: my.modules.filter((x) => (x.tables || []).includes(t)).map((x) => x.id) }));
    const docs = DOCS_ORDER.map((d) => {
      const x = docInfo(home, mid, d);
      return x.exists ? { doc: d, status: x.status, checked: x.status === 'Checked' || x.status === 'Approved' } : null;
    }).filter(Boolean);
    out.modules.push({
      id: mid,
      name: m.name,
      purpose: m.purpose || null,
      risk: m.risk || [],
      critical: !!m.critical,
      size: m.size || null,
      owner: m.owner || null,
      dependsOn: m.depends_on || [],
      usedBy: my.modules.filter((x) => (x.depends_on || []).includes(mid)).map((x) => x.id),
      docs,
      routes: pack.routes.map((r) => ({ app: r.app, method: r.method, uri: r.uri, cite: r.cite, calledBy: r.calledBy })),
      screens: pack.screens.map((s) => ({ app: s.app, id: s.id, path: s.path, cite: s.cite })),
      tables: pack.tables.map((t) => ({ name: t.name, cite: t.cite })),
      externals: pack.externals,
      // what its routes ask other servers for: inside the breakdown (another
      // app) or outside it
      asks: pack.routes.flatMap((r) => (r.asksBackend || []).map((x) => ({ from: `${r.app} ${r.method} ${r.uri}`, method: x.method, uri: x.uri || x.reason || 'known only at run time', to: x.route && x.route.app ? x.route.app : null, cite: x.cite }))),
      callers,
      sharedTables: shared,
      usesTablesOf: usesOthers,
      factsMd: path.join(docsDir(home), 'modules', mid, '_facts.md'),
    });
  }
  out.neighbours = graphNeighbours(sys, my, chosen, files);
  return out;
}

const LIMIT = 40;
export function packMd(p, title) {
  const L = [`# Impact pack: ${p.work} "${title}"`, '', `Built by impact.mjs on ${p.builtAt.slice(0, 10)} from the code map. Facts only: the analyst decides what the change does to them.`, ''];
  for (const m of p.modules) {
    L.push(`## ${m.id}: ${m.name}`, '', `- Purpose: ${m.purpose || 'not given'}`, `- Risk flags: ${m.risk.length ? m.risk.map((r) => `${r.flag} (${r.reason})`).join('; ') : 'none'}${m.critical ? ' · critical module' : ''}`, `- Size: ${m.size || '?'} · owner: ${m.owner || 'TBD'}`, `- Depends on: ${m.dependsOn.join(', ') || 'nothing'} · used by: ${m.usedBy.join(', ') || 'nothing'}`);
    L.push(`- Documents: ${m.docs.length ? m.docs.map((d) => `${d.doc} ${d.status}${d.checked ? ' (a change makes it a Draft again)' : ''}`).join(', ') : 'none written yet'}`, `- Full facts: ${m.factsMd}`, '');
    L.push(`### Routes (${m.routes.length})`, '', ...m.routes.slice(0, LIMIT).map((r) => `- ${r.app} ${r.method} ${r.uri} \`${r.cite}\`${r.calledBy ? ` · called from ${r.calledBy} place(s)` : ''}`), ...(m.routes.length > LIMIT ? [`- … ${m.routes.length - LIMIT} more in the full facts`] : []), '');
    L.push(`### Screens (${m.screens.length})`, '', ...m.screens.slice(0, LIMIT).map((s) => `- ${s.app} ${s.id}${s.path ? ` (opens at ${s.path})` : ''} \`${s.cite}\``), ...(m.screens.length > LIMIT ? [`- … ${m.screens.length - LIMIT} more`] : []), '');
    L.push(`### Tables (${m.tables.length})`, '', ...m.tables.map((t) => `- ${t.name} \`${t.cite}\``), '');
    if (m.callers.length) L.push('### Other apps that call these routes', '', ...m.callers.slice(0, LIMIT).map((c) => `- ${c.app}${c.screen ? ` screen ${c.screen}` : ''}${c.module ? ` (module ${c.module})` : ''} calls ${c.route} \`${c.cite}\``), '');
    if (m.sharedTables.length) L.push('### Tables other modules also use', '', ...m.sharedTables.map((t) => `- ${t.table}: ${t.alsoUsedBy.join(', ')}`), '');
    if (m.usesTablesOf.length) L.push('### Tables of other modules its code uses', '', ...m.usesTablesOf.map((t) => `- ${t.table}${t.ownedBy.length ? ` (${t.ownedBy.join(', ')})` : ''}`), '');
    if (m.asks.length) L.push(`### What its routes ask other servers for (${m.asks.length})`, '', ...m.asks.slice(0, LIMIT).map((x) => `- ${x.from} → ${x.method} ${x.uri} (${x.to ? `app ${x.to}` : 'a server outside this breakdown'}) \`${x.cite}\``), ...(m.asks.length > LIMIT ? [`- … ${m.asks.length - LIMIT} more in the full facts`] : []), '');
    if (m.externals.length) L.push('### Outside services', '', ...m.externals.map((x) => `- ${x.system}: ${x.where.map((w) => `\`${w}\``).join(' ')}`), '');
  }
  L.push('## Code the graph groups with it (Inferred)', '');
  if (!p.neighbours.length) L.push('Nothing outside the chosen modules, or no code graph.');
  for (const n of p.neighbours) L.push(`- ${n.module}: ${n.count} file(s), e.g. ${n.files.map((f) => `\`${f}\``).join(' ')}`);
  L.push('');
  return L.join('\n');
}

export function makePack(home, id, modulesArg) {
  const upd = pluginUpdate(PLUGIN_ROOT);
  if (upd) fail(upd.message);
  const bd = breakdownStatus(home);
  if (bd.next !== 'up-to-date') fail(`Run /tech-plugin:breakdown first: ${bd.message}`);
  const item = loadItem(home, id);
  const known = new Set((loadExisting(home) || { modules: [] }).modules.map((m) => m.id));
  const chosen = [...new Set(String(modulesArg || '').split(/[\s,]+/).filter(Boolean))];
  if (!chosen.length) fail('name the modules the change reaches: --modules a,b');
  const bad = chosen.filter((m) => !known.has(m));
  if (bad.length) fail(`not a module of this system: ${bad.join(', ')}`);
  const p = buildPack(home, id, chosen);
  const D = docsDir(home);
  const mdRel = path.join('_state', 'work', id, 'impact-pack.md');
  writeDocs(home, mdRel, packMd(p, item.title));
  writeDocs(home, path.join('_state', 'work', id, 'impact-pack.json'), JSON.stringify(p, null, 1) + '\n');
  refreshModules(home, id, chosen);
  const out = path.join(D, workRel(id, 'impact.md'));
  const S = path.join(PLUGIN_ROOT, 'scripts');
  return {
    work: id,
    doc: 'impact',
    out,
    stamp: stampText(stampFor(home, id, 'impact', chosen)),
    template: path.join(PLUGIN_ROOT, 'references', 'work', 'impact-template.md'),
    rules: [path.join(PLUGIN_ROOT, 'references', 'document', 'writing-rules.md'), path.join(PLUGIN_ROOT, 'references', 'work', 'work-rules.md')],
    request: path.join(D, workRel(id, 'request.md')),
    pack: path.join(D, mdRel),
    modules: Object.fromEntries(chosen.map((m) => [m, { card: path.join(D, 'modules', m, 'module.md'), ...Object.fromEntries(DOCS_ORDER.filter((d) => fs.existsSync(path.join(D, 'modules', m, `${d}.md`))).map((d) => [d, path.join(D, 'modules', m, `${d}.md`)])) }])),
    glossary: path.join(D, 'glossary.md'),
    glossaryTool: path.join(S, 'document', 'glossary.mjs'),
    counts: { routes: p.modules.reduce((n, m) => n + m.routes.length, 0), screens: p.modules.reduce((n, m) => n + m.screens.length, 0), tables: p.modules.reduce((n, m) => n + m.tables.length, 0), callers: p.modules.reduce((n, m) => n + m.callers.length, 0), asks: p.modules.reduce((n, m) => n + m.asks.length, 0), neighbours: p.neighbours.length },
    checks: [`node "${path.join(S, 'work', 'check-work.mjs')}" "${out}" --home "${home}"`, `node "${path.join(S, 'document', 'plain.mjs')}" "${out}" --home "${home}"`],
    report: `node "${path.join(S, 'work', 'impact.mjs')}" report ${id} --home "${home}"`,
  };
}

// ------------------------------------------------------------------ report

export function writeReport(home, id) {
  const d = readWorkDoc(home, id, 'impact');
  if (!d) fail(`work/${id}/impact.md does not exist: run /tech-plugin:impact ${id}`);
  const body = splitDoc(d.text).body;
  const lines = body.split('\n');
  const a = lines.findIndex((l) => /^## Appendix A\b/.test(l));
  const c = lines.findIndex((l) => /^## Document control\b/.test(l));
  const people = renderMarkdown(lines.slice(0, a === -1 ? lines.length : a).join('\n'));
  const dev = a === -1 ? null : renderMarkdown(lines.slice(a, c > a ? c : lines.length).join('\n'));
  const control = c > a && a !== -1 ? renderMarkdown(lines.slice(c).join('\n')) : null;
  const title = (/^#\s+(.+)$/m.exec(body) || [null, `${id}: impact`])[1].replace(/[`*_]/g, '');
  const mermaid = people.mermaid || (dev && dev.mermaid);
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
<main>
${people.html.replace('</h1>', `</h1>\n<p class="status">${esc(`Work item ${id} · ${d.front.status || 'Draft'} · written ${d.front.date || ''}`)}</p>`)}
${dev ? `<details class="dev"><summary>For developers: evidence and technical detail</summary>\n${dev.html}\n</details>` : ''}
${control ? control.html : ''}
<footer>Built by tech-plugin on ${today()} from sdlc-docs/work/${esc(id)}/impact.md. Edit the Markdown, not this page: it is rebuilt.</footer>
</main>
</div>
${mermaid ? `<script src="${MERMAID_URL}"></script>
<script>(function(){var dark=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches;if(window.mermaid){window.mermaid.initialize({startOnLoad:true,securityLevel:'strict',theme:dark?'dark':'default'});}else{document.documentElement.className+=' offline';}})();</script>` : ''}
</body>
</html>
`;
  const f = writeDocs(home, workRel(id, 'impact-report.html'), html);
  refresh(home, id);
  return { work: id, report: f };
}

function main() {
  const [cmd, id] = process.argv.slice(2);
  const a = parseArgs(process.argv.slice(4));
  if (!a.home || !id) fail('usage: impact.mjs <candidates|pack|report> <ID> --home HOME [--modules a,b]');
  const home = real(a.home);
  if (!fs.existsSync(docsDir(home))) fail(`${home} has no sdlc-docs/; run /tech-plugin:breakdown first`);
  const out = (x) => process.stdout.write(JSON.stringify(x, null, 2) + '\n');
  if (cmd === 'candidates') return out(candidates(home, id));
  if (cmd === 'pack') return out(makePack(home, id, a.modules));
  if (cmd === 'report') return out(writeReport(home, id));
  fail('usage: impact.mjs <candidates|pack|report> <ID> --home HOME [--modules a,b]');
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) main();
