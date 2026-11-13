#!/usr/bin/env node
// /tech-plugin:diagram helpers. Scripts draw every diagram from the code facts
// and the documents; the only words a model writes are screen names
// (labels.yaml), and a script checks them.
//
//   node diagram.mjs status       <module|system> --home HOME [--force]
//         JSON: whether the diagrams match the code facts, the spec, the PRD
//         and the screen names; rebuilds the module's fact pack first
//   node diagram.mjs labels       <module> --home HOME
//         writes modules/<id>/diagrams/labels.yaml: one plain name per screen,
//         taken from the spec's Screens table where it names exactly one
//         screen, keeping names people or the labeller wrote; JSON lists the
//         screens still without a name, for the diagram-labeller agent
//   node diagram.mjs check-labels <module> --home HOME
//         every screen named, in plain words (exit 1 if not)
//   node diagram.mjs draw         <module|system> --home HOME
//         module: flowchart.md (people layer), sequences.md and er.md
//         (technical layer), _stamp.json
//         system: system/diagrams/block.md and journeys.md, _stamp.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitDoc } from '../lib/frontmatter.mjs';
import { parseYaml, toYaml } from '../lib/yaml.mjs';
import { pluginUpdate } from '../lib/version.mjs';
import { normUri, shapeOf } from '../lib/readers/common.mjs';
import { PLUGIN_ROOT, docsDir, fail, parseArgs, readJson, real, today, writeDocs } from '../breakdown/common.mjs';
import { loadSystem } from '../breakdown/load.mjs';
import { loadState, stampKey, status as breakdownStatus } from '../breakdown/state.mjs';
import { loadExisting } from '../breakdown/modules.mjs';
import { docInfo, docRel, factsRelOf, moduleOf, writeFacts } from '../document/doc.mjs';
import { ALLOWED_CAMEL, codeIn } from '../document/plain.mjs';
import { cells, evidenceOf, hits, idRegistry, label, msg, oneCite, resolveTags, section, sha, tagsIn } from './mermaid.mjs';
import { drawSystem, systemState } from './system.mjs';

// Bump when the drawings change for the same input: every diagram is then stale.
export const RENDERER = 2;
export const MAX_SCREENS = 25;
const MAX_WORDS = 8;
export const diagRel = (id, f) => path.join('modules', id, 'diagrams', f);
export const MODULE_FILES = ['flowchart.md', 'sequences.md', 'er.md'];
const LABELS_HEADER = (name) => `Screen names for the diagrams of ${name}. Yours to edit: /tech-plugin:diagram keeps them.
One plain name per screen, in the words people see (at most ${MAX_WORDS} words, no code names).
from: spec = taken from the spec's Screens table, refreshed when the spec changes;
      agent = written by the diagram labeller; you = written by a person.
If you change a name, set its "from" to you. Empty a name to have it written again.`;

// ------------------------------------------------------------------ inputs

function loadPack(home, id) {
  return readJson(path.join(docsDir(home), factsRelOf(id))) || writeFacts(home, id).pack;
}

const repoOfCite = (c) => String(c || '').split(':')[0];
const keyOf = (s) => `${s.app}|${s.id}`;

export function readLabels(home, id) {
  const f = path.join(docsDir(home), diagRel(id, 'labels.yaml'));
  if (!fs.existsSync(f)) return { exists: false, screens: [], text: null };
  const text = fs.readFileSync(f, 'utf8');
  try {
    const y = parseYaml(text) || {};
    return { exists: true, screens: (Array.isArray(y.screens) ? y.screens : []).filter((s) => s && s.screen), text };
  } catch (e) {
    return { exists: true, broken: e.message, screens: [], text };
  }
}

export function labelProblem(s) {
  const t = s === null || s === undefined ? '' : String(s).trim();
  if (!t) return 'no name yet';
  if (t.split(/\s+/).length > MAX_WORDS) return `more than ${MAX_WORDS} words`;
  if (t.length > 60) return 'longer than 60 characters';
  const bad = /["`<>{}[\]|#;]/.exec(t);
  if (bad) return `has a character the diagrams cannot show (${bad[0]})`;
  const code = codeIn(t);
  if (code) return `looks like code: ${code}`;
  const joined = /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/.exec(t);
  if (joined && !ALLOWED_CAMEL.test(joined[0])) return `looks like code: a code name in PascalCase ("${joined[0]}")`;
  const dotted = /\b[a-z][a-z0-9]+\.[a-z_][a-z0-9_]+\b/i.exec(t);
  return dotted ? `looks like code: a dotted code name ("${dotted[0]}")` : null;
}

// Screen names from the spec's "3. Screens" table: a row whose evidence
// points at exactly one screen file names that screen.
export function specLabels(home, id, pack) {
  const f = path.join(docsDir(home), docRel(id, 'spec'));
  const out = new Map();
  if (!fs.existsSync(f)) return out;
  const text = fs.readFileSync(f, 'utf8');
  const ev = evidenceOf(text);
  for (const l of section(splitDoc(text).body, '3. Screens')) {
    if (!/^\|/.test(l.trim()) || /^\|\s*:?-{3,}/.test(l.trim())) continue;
    const c = cells(l);
    if (/^screen$/i.test(c[0])) continue;
    const name = c[0].replace(/\*\*/g, '').replace(/\[[^\]]*\]/g, '').replace(/"/g, '').trim();
    const cites = resolveTags(tagsIn(l), ev);
    const hit = pack.screens.filter((s) => s.file && cites.some((ct) => ct.repo === repoOfCite(s.cite) && ct.file === s.file));
    if (hit.length !== 1 || out.has(keyOf(hit[0])) || labelProblem(name)) continue;
    out.set(keyOf(hit[0]), name);
  }
  return out;
}

const screenHints = (s) => ({
  titles: (s.labels || []).filter((l) => /title|heading/.test(l.kind)).map((l) => l.text).slice(0, 3),
  shows: (s.labels || []).filter((l) => !/title|heading/.test(l.kind)).map((l) => l.text).slice(0, 6),
});

export function prepareLabels(home, id) {
  const { m } = moduleOf(home, id);
  const pack = loadPack(home, id);
  const old = readLabels(home, id);
  if (old.broken) fail(`modules/${id}/diagrams/labels.yaml could not be read (${old.broken}); fix it by hand and run again`);
  const prev = new Map(old.screens.map((s) => [String(s.screen), s]));
  const fromSpec = specLabels(home, id, pack);
  const screens = pack.screens.map((s) => {
    const k = keyOf(s);
    const p = prev.get(k);
    const kept = p && p.label !== null && p.label !== undefined && String(p.label).trim();
    if (kept && p.from !== 'spec') return { screen: k, label: String(p.label).trim(), from: p.from || 'you', page: s.path || s.file || null };
    if (fromSpec.has(k)) return { screen: k, label: fromSpec.get(k), from: 'spec', page: s.path || s.file || null };
    if (kept) return { screen: k, label: String(p.label).trim(), from: 'spec', page: s.path || s.file || null };
    return { screen: k, label: null, from: null, page: s.path || s.file || null };
  });
  writeDocs(home, diagRel(id, 'labels.yaml'), toYaml({ module: id, screens }, LABELS_HEADER(m.name)));
  const D = docsDir(home);
  const todo = screens.filter((s) => !s.label).map((s) => ({ screen: s.screen, page: s.page, ...screenHints(pack.screens.find((x) => keyOf(x) === s.screen)) }));
  return {
    module: id,
    labels: path.join(D, diagRel(id, 'labels.yaml')),
    total: screens.length,
    fromSpec: screens.filter((s) => s.from === 'spec').length,
    kept: screens.filter((s) => s.label && s.from !== 'spec').length,
    todo: todo.length,
    agent: todo.length ? 'tech-plugin:diagram-labeller' : null,
    facts: path.join(D, 'modules', id, '_facts.md'),
    spec: fs.existsSync(path.join(D, docRel(id, 'spec'))) ? path.join(D, docRel(id, 'spec')) : null,
    glossary: path.join(D, 'glossary.md'),
    screens: todo,
    check: `node "${path.join(PLUGIN_ROOT, 'scripts', 'diagram', 'diagram.mjs')}" check-labels ${id} --home "${home}"`,
  };
}

export function checkLabels(home, id) {
  const pack = loadPack(home, id);
  const L = readLabels(home, id);
  if (!L.exists) return { ok: false, total: pack.screens.length, problems: ['labels.yaml does not exist yet: run "diagram.mjs labels" first'] };
  if (L.broken) return { ok: false, total: pack.screens.length, problems: [`labels.yaml could not be read: ${L.broken}`] };
  const have = new Map(L.screens.map((s) => [String(s.screen), s]));
  const problems = [];
  for (const s of pack.screens) {
    const x = have.get(keyOf(s));
    if (!x) problems.push(`${keyOf(s)}: not in labels.yaml (run "diagram.mjs labels" again)`);
    else {
      const p = labelProblem(x.label);
      if (p) problems.push(`${keyOf(s)}: ${p}${x.label && !p.includes(String(x.label)) ? ` ("${String(x.label).slice(0, 60)}")` : ''}`);
    }
  }
  return { ok: !problems.length, total: pack.screens.length, problems };
}

// ------------------------------------------------------------------ freshness

export function inputsOf(home, id, factsHash) {
  const f = path.join(docsDir(home), diagRel(id, 'labels.yaml'));
  const docHash = (doc) => {
    const d = docInfo(home, id, doc);
    return d.exists ? d.hash || null : null;
  };
  // the flowchart draws other modules' screens and routes as their boxes; the
  // sequences and the ER read every app's routes, handlers and tables
  const my = loadExisting(home) || { modules: [] };
  const index = (my.modules || []).map((m) => [m.id, m.name, m.screens || [], m.routes || [], m.web_routes || []]);
  const st = loadState(home) || {};
  const codeMap = { repos: Object.fromEntries((st.repos || []).map((r) => [r.name, stampKey(r.mapped)])), linked: ((st.stages || {})['4'] || {}).at || null };
  return {
    facts: factsHash,
    spec: docHash('spec'),
    brd: docHash('brd'),
    prd: docHash('prd'),
    labels: fs.existsSync(f) ? sha(fs.readFileSync(f, 'utf8')) : null,
    modules: sha(JSON.stringify(index)),
    codeMap: sha(JSON.stringify(codeMap)),
    renderer: RENDERER,
  };
}

const REASONS = {
  facts: 'the code facts changed',
  spec: 'the spec changed (screen names may come from it)',
  brd: 'the BRD changed (PRD evidence may point into it)',
  prd: 'the PRD changed (sequence diagrams follow its requirements)',
  labels: 'screen names in labels.yaml changed',
  modules: 'the module list changed (a module was renamed, or screens or routes moved)',
  codeMap: 'the code map was read or linked again',
  renderer: 'tech-plugin draws diagrams differently now',
};

export function diagramState(home, id, factsHash) {
  const D = docsDir(home);
  const st = readJson(path.join(D, diagRel(id, '_stamp.json')));
  if (!st) return { state: 'missing', reasons: [], drawnAt: null };
  const now = inputsOf(home, id, factsHash);
  let changed = Object.keys(REASONS).filter((k) => (st.inputs || {})[k] !== now[k]);
  // a new renderer redraws everything; its other inputs are not news
  if (changed.includes('renderer')) changed = ['renderer'];
  const reasons = changed.map((k) => REASONS[k]);
  if (MODULE_FILES.some((f) => !fs.existsSync(path.join(D, diagRel(id, f))))) reasons.push('a diagram file is missing');
  return { state: reasons.length ? 'stale' : 'up-to-date', reasons, drawnAt: st.drawnAt || null };
}

export function status(home, id, { force = false } = {}) {
  const upd = pluginUpdate(PLUGIN_ROOT);
  if (upd) return { module: id, next: 'restart', message: upd.message };
  const bd = breakdownStatus(home);
  if (bd.next !== 'up-to-date') return { module: id, next: 'breakdown', breakdown: { upToDate: false, message: bd.message }, message: `Run /tech-plugin:breakdown first: ${bd.message}` };
  if (id === 'system') {
    const s = systemState(home);
    const next = force || s.state !== 'up-to-date' ? 'draw' : 'up-to-date';
    return { module: 'system', next, ...s, message: next === 'up-to-date' ? 'Already up to date: the system diagrams match the modules, the links and system.yaml.' : `system diagrams: ${s.state}${s.reasons.length ? ` (${s.reasons.join('; ')})` : ''}` };
  }
  const { m } = moduleOf(home, id);
  const { pack } = writeFacts(home, id);
  const s = diagramState(home, id, pack.hash);
  const L = readLabels(home, id);
  const next = force || s.state !== 'up-to-date' ? 'labels' : 'up-to-date';
  const D = docsDir(home);
  return {
    module: id,
    name: m.name,
    next,
    state: s.state,
    reasons: s.reasons,
    drawnAt: s.drawnAt,
    screens: pack.screens.length,
    split: pack.screens.length > MAX_SCREENS,
    labelled: L.screens.filter((x) => !labelProblem(x.label)).length,
    spec: fs.existsSync(path.join(D, docRel(id, 'spec'))),
    prd: fs.existsSync(path.join(D, docRel(id, 'prd'))),
    tables: pack.tables.length,
    labeller: 'tech-plugin:diagram-labeller',
    message: next === 'up-to-date' ? `Already up to date: the diagrams of ${id} match the code, the documents and the screen names.` : `${id} diagrams: ${s.state}${s.reasons.length ? ` (${s.reasons.join('; ')})` : ''}`,
  };
}

// ------------------------------------------------------------------ flowchart (people layer)

function moduleIndex(my) {
  const screenOwner = new Map();
  const routeOwner = new Map();
  for (const mm of my.modules) {
    for (const k of mm.screens || []) if (!screenOwner.has(k)) screenOwner.set(k, mm);
    for (const k of [...(mm.routes || []), ...(mm.web_routes || [])]) if (!routeOwner.has(k)) routeOwner.set(k, mm);
  }
  return { screenOwner, routeOwner };
}

// Arrows between screens: a screen links (link, button, form) to a route whose
// handler renders the next screen. Arrows from and to other modules' screens
// end on that module's box.
export function screenGraph(pack, sys, my, id) {
  const mine = new Map(pack.screens.map((s) => [keyOf(s), s]));
  const { screenOwner, routeOwner } = moduleIndex(my);
  const edges = new Map();
  const add = (from, to, why) => {
    if (from === to) return;
    const k = `${from}>${to}`;
    if (!edges.has(k)) edges.set(k, { from, to, why: [] });
    if (edges.get(k).why.length < 3) edges.get(k).why.push(why);
  };
  const endOf = (app, screenId) => {
    const k = `${app}|${screenId}`;
    if (mine.has(k)) return { kind: 'screen', key: k };
    const o = screenOwner.get(k);
    return o && o.id !== id ? { kind: 'module', key: o.id, name: o.name } : null;
  };
  const rendered = (app, handler) => {
    const a = sys.apps.get(app);
    return a && handler ? a.screens.filter((s) => (s.renderedBy || []).includes(handler)) : [];
  };
  const routesFor = (app, l) => {
    const a = sys.apps.get(app);
    if (!a) return [];
    const live = a.routes.filter((r) => !r.shadowed);
    if (l.kind === 'route-name') return live.filter((r) => r.name && r.name === l.target);
    if (l.kind === 'url') {
      const u = normUri(l.target);
      if (!u) return [];
      const sh = shapeOf(u.replace(/^\/+/, '')) || '/';
      return live.filter((r) => (r.shape === sh || r.shape === '/' + sh) && (!l.method || l.method === r.method));
    }
    return [];
  };
  const ends = new Map();
  const mark = (e) => {
    if (e) ends.set(e.kind === 'screen' ? `s:${e.key}` : `m:${e.key}`, e);
    return e;
  };
  for (const s of pack.screens) {
    const from = mark(endOf(s.app, s.id));
    for (const l of s.links || []) {
      for (const r of routesFor(s.app, l)) {
        const why = `${s.id} ${l.kind === 'route-name' ? `links to route ${l.target}` : `opens ${l.target}`} (${r.method} ${r.uri}, ${sys.apps.get(s.app).repo}:${r.cite})`;
        const targets = rendered(s.app, r.handler);
        if (targets.length) for (const t of targets) {
          const to = mark(endOf(s.app, t.id));
          if (to) add(nodeKey(from), nodeKey(to), why);
        }
        else {
          const o = routeOwner.get(`${s.app}|${r.key}`);
          if (o && o.id !== id) add(nodeKey(from), nodeKey(mark({ kind: 'module', key: o.id, name: o.name })), why);
        }
      }
    }
  }
  // routes of this module opened from pages of other modules
  for (const r of pack.routes) {
    for (const sid of r.linkedFrom || []) {
      const from = endOf(r.app, sid);
      if (!from || from.kind === 'screen') continue;
      for (const t of rendered(r.app, r.handler)) {
        const to = endOf(r.app, t.id);
        if (to && to.kind === 'screen') add(nodeKey(mark(from)), nodeKey(mark(to)), `${sid} opens ${r.method} ${r.uri} (${r.cite})`);
      }
    }
  }
  return { mine, edges: [...edges.values()], ends };
}

const nodeKey = (e) => (e.kind === 'screen' ? `s:${e.key}` : `m:${e.key}`);

// Screens grouped into parts of at most MAX_SCREENS, by folder.
export function parts(screens) {
  if (screens.length <= MAX_SCREENS) return [screens];
  const groupOf = (s) => (s.id.includes('.') ? s.id.split('.').slice(0, -1).join('.') : s.file ? path.dirname(s.file) : s.app);
  const groups = new Map();
  for (const s of [...screens].sort((a, b) => groupOf(a).localeCompare(groupOf(b)) || a.id.localeCompare(b.id))) {
    if (!groups.has(groupOf(s))) groups.set(groupOf(s), []);
    groups.get(groupOf(s)).push(s);
  }
  const out = [];
  let cur = [];
  for (const g of groups.values()) {
    for (let i = 0; i < g.length; i += MAX_SCREENS) {
      const chunk = g.slice(i, i + MAX_SCREENS);
      if (cur.length + chunk.length > MAX_SCREENS && cur.length) {
        out.push(cur);
        cur = [];
      }
      cur.push(...chunk);
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

function flowchartMd(m, pack, graph, labels, counts) {
  const nameOf = (k) => labels.get(k) || 'Screen not named yet';
  const reg = idRegistry();
  for (const s of pack.screens) reg('s', keyOf(s));
  const node = (k) => reg(k.startsWith('s:') ? 's' : 'm', k.slice(2));
  const incoming = new Set(graph.edges.map((e) => e.to));
  const P = parts(pack.screens);
  const partOf = new Map();
  P.forEach((p, i) => p.forEach((s) => partOf.set(`s:${keyOf(s)}`, i)));
  const L = [`# ${m.name}: how people move through the screens`, '', `> **Status:** Draft, drawn on ${today()} from the product's screens and the links between them. It is reviewed with the people layer of the documents.  `, `> **Screen names:** ${counts.spec} from the spec, ${counts.agent} written for this diagram, ${counts.you} written by people.`, ''];
  L.push('How to read it: each box is a screen. An arrow means people go from one screen to the next, with a link, a button or a form. "Start" points at the screens people open first. Rounded boxes with a dashed border are other parts of the product.', '');
  if (!pack.screens.length) L.push('This part of the product has no screens of its own.', '');
  const draw = (screens, idx) => {
    const set = new Set(screens.map((s) => `s:${keyOf(s)}`));
    const starts = screens.filter((s) => !incoming.has(`s:${keyOf(s)}`));
    const M = ['```mermaid', 'flowchart LR', ...(starts.length ? ['  start(("Start"))'] : [])];
    const others = new Map();
    for (const s of screens) M.push(`  ${node(`s:${keyOf(s)}`)}["${label(nameOf(keyOf(s)))}"]`);
    const out = [];
    for (const e of graph.edges) {
      if (!set.has(e.from) && !set.has(e.to)) continue;
      for (const end of [e.from, e.to]) {
        if (set.has(end) || others.has(end)) continue;
        if (end.startsWith('m:')) others.set(end, label(graph.ends.get(end).name));
        else others.set(end, label(`${nameOf(end.slice(2))}, see part ${partOf.get(end) + 1}`));
      }
      out.push(`  ${node(e.from)} --> ${node(e.to)}`);
    }
    for (const [k, v] of others) M.push(`  ${node(k)}(["${v}"])`);
    for (const s of starts) M.push(`  start --> ${node(`s:${keyOf(s)}`)}`);
    M.push(...out);
    if (others.size) M.push('  classDef other stroke-dasharray: 4 3', `  class ${[...others.keys()].map(node).join(',')} other`);
    M.push('```', '');
    return M;
  };
  if (P.length > 1) {
    L.push(`There are ${pack.screens.length} screens, so the diagram is drawn in ${P.length} parts.`, '', '## Overview', '', '```mermaid', 'flowchart LR');
    P.forEach((p, i) => L.push(`  part${i + 1}["Part ${i + 1}: ${label(p.slice(0, 3).map((s) => nameOf(keyOf(s))).join(', '))}${p.length > 3 ? ' and more' : ''}"]`));
    const between = new Set();
    for (const e of graph.edges) {
      const a = partOf.get(e.from);
      const b = partOf.get(e.to);
      if (a !== undefined && b !== undefined && a !== b) between.add(`  part${a + 1} --> part${b + 1}`);
    }
    L.push(...between, '```', '');
    P.forEach((p, i) => L.push(`## Part ${i + 1}`, '', ...draw(p, i)));
  } else if (pack.screens.length) L.push(...draw(pack.screens, 0));
  L.push('## For developers', '', '| Screen name | Screen | Opens at | Source |', '|---|---|---|---|');
  for (const s of pack.screens) L.push(`| ${nameOf(keyOf(s)).replace(/\|/g, '/')} | \`${s.id}\` (${s.app}) | ${s.path ? `\`${s.path}\`` : ''} | \`${s.cite}\` |`);
  L.push('', '**Arrows and their evidence**', '');
  const show = (k) => (k.startsWith('s:') ? nameOf(k.slice(2)) : graph.ends.get(k).name);
  if (!graph.edges.length) L.push('No links between these screens were found.');
  for (const e of graph.edges) L.push(`- ${show(e.from)} → ${show(e.to)}: ${e.why.map((w) => `\`${w}\``).join('; ')}`);
  L.push('');
  return L.join('\n');
}

// ------------------------------------------------------------------ sequences (technical layer)

function methodRange(sys, r) {
  const a = sys.apps.get(r.app);
  if (!a || !r.handler || !r.handler.includes('@')) return null;
  const [ctl, action] = r.handler.split('@');
  const h = a.handlers.find((x) => x.id === ctl);
  const mt = h && (h.methods || []).find((x) => x.name === action);
  return mt ? { repo: a.repo, file: h.file, from: mt.line, to: mt.endLine || mt.line, tables: mt.tables || [] } : null;
}

function routeTables(sys, appId, key) {
  const a = sys.apps.get(appId);
  const r = a && a.routes.find((x) => x.key === key);
  const mr = r ? methodRange(sys, { ...r, app: appId }) : null;
  return mr ? mr.tables : [];
}

function readDocText(home, id, doc) {
  const f = path.join(docsDir(home), docRel(id, doc));
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
}

// The PRD's requirements, "### <MODULE>-Rnn: title", as check-doc reads them;
// a requirement marked "Removed (reason)" is not drawn.
const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function requirementsOf(text, id) {
  const body = splitDoc(text).body;
  const lines = body.split('\n');
  const out = [];
  const head = new RegExp(`^### (${reEsc(String(id).toUpperCase())}-R\\d{2,}):\\s*(.+)$`);
  for (let i = 0; i < lines.length; i++) {
    const m = head.exec(lines[i]);
    if (!m || /^Removed\b/i.test(m[2].trim())) continue;
    let j = i + 1;
    while (j < lines.length && !/^#{2,3} /.test(lines[j])) j++;
    out.push({ id: m[1], title: m[2].trim(), text: lines.slice(i, j).join('\n') });
  }
  return out;
}

function sequenceFor(req, pack, sys, cites) {
  const routeHit = (r) => {
    const rc = oneCite(r.cite);
    const mr = methodRange(sys, r);
    return cites.some((c) => (rc && hits(c, rc.repo, rc.file, rc.line, rc.line)) || (mr && hits(c, mr.repo, mr.file, mr.from, mr.to)) || r.asksBackend.some((x) => {
      const oc = oneCite(x.cite);
      return oc && hits(c, oc.repo, oc.file, oc.line, oc.line);
    }));
  };
  const routes = pack.routes.filter(routeHit);
  const calls = [];
  for (const s of pack.screens) for (const c of s.calls || []) {
    const oc = oneCite(c.cite);
    if (oc && cites.some((x) => hits(x, oc.repo, oc.file, oc.line, oc.line)) && !routes.some((r) => r.asksBackend.some((a) => a.cite === c.cite))) calls.push({ screen: s, call: c });
  }
  if (!routes.length && !calls.length) return null;
  const parts = new Map();
  const reg = idRegistry();
  const P = (id, as, kind = 'participant') => {
    if (!parts.has(id)) parts.set(id, `  ${kind} ${id} as ${msg(as)}`);
    return id;
  };
  const steps = [];
  const step = (line, source) => steps.push({ line, source });
  const person = P('P', 'Person', 'actor');
  const tablesStep = (who, tables, source) => {
    if (tables.length) step(`  ${who}->>${P('DB', 'Database')}: reads or writes ${msg(tables.join(', '))}`, source);
  };
  for (const r of routes) {
    const app = P(reg('A', r.app), r.app);
    const pageId = (r.linkedFrom || [])[0];
    if (pageId) {
      const page = P(reg('S', `${r.app}|${pageId}`), pageId);
      step(`  ${person}->>${page}: uses the page`, null);
      step(`  ${page}->>${app}: ${msg(`${r.method} ${r.uri}`)}`, r.cite);
    } else step(`  ${person}->>${app}: ${msg(`${r.method} ${r.uri}`)}`, r.cite);
    if ((r.middleware || []).length) step(`  Note over ${app}: checks ${msg(r.middleware.join(', '))}`, r.cite);
    for (const x of r.asksBackend) {
      if (x.route && x.route.app && x.route.app !== r.app) {
        const be = P(reg('A', x.route.app), x.route.app);
        step(`  ${app}->>${be}: ${msg(`${x.method} ${x.uri || x.reason || ''}`)}`, x.cite);
        tablesStep(be, routeTables(sys, x.route.app, x.route.key), x.cite);
        step(`  ${be}-->>${app}: answer`, null);
      } else {
        const be = P('OUT', 'Backend (outside this breakdown)');
        step(`  ${app}->>${be}: ${msg(`${x.method} ${x.uri || x.reason || 'URL known only at run time'}`)}`, x.cite);
        step(`  ${be}-->>${app}: answer`, null);
      }
    }
    const mr = methodRange(sys, r);
    tablesStep(app, mr ? mr.tables : [], r.handlerCite);
    const shown = pack.screens.filter((s) => s.app === r.app && (s.renderedBy || []).includes(r.handler));
    step(`  ${app}-->>${person}: ${shown.length ? `shows ${msg(shown.map((s) => s.id).join(', '))}` : 'answer'}`, r.handlerCite);
  }
  for (const { screen, call } of calls) {
    const page = P(reg('S', keyOf(screen)), screen.id);
    step(`  ${person}->>${page}: uses the screen`, screen.cite);
    if (call.route && call.route.app) {
      const be = P(reg('A', call.route.app), call.route.app);
      step(`  ${page}->>${be}: ${msg(`${call.method} ${call.uri || ''}`)}`, call.cite);
      tablesStep(be, routeTables(sys, call.route.app, call.route.key), call.cite);
      step(`  ${be}-->>${page}: answer`, null);
    } else {
      const be = P('OUT', 'Backend (outside this breakdown)');
      step(`  ${page}->>${be}: ${msg(`${call.method} ${call.uri || ''}`)}`, call.cite);
      step(`  ${be}-->>${page}: answer`, null);
    }
  }
  const order = ['P', ...[...parts.keys()].filter((k) => k.startsWith('S_')), ...[...parts.keys()].filter((k) => k.startsWith('A_')), 'OUT', 'DB'];
  const M = ['```mermaid', 'sequenceDiagram', ...order.filter((k) => parts.has(k)).map((k) => parts.get(k)), ...steps.map((s) => s.line), '```', ''];
  const T = ['| # | Step | Source |', '|---|---|---|'];
  steps.forEach((s, i) => T.push(`| ${i + 1} | ${s.line.trim().replace(/\|/g, '/')} | ${s.source ? `\`${s.source}\`` : ''} |`));
  return { routes: routes.length, calls: calls.length, lines: [...M, ...T, ''] };
}

function sequencesMd(home, id, m, pack, sys) {
  const L = [`# ${m.name}: sequence diagrams`, '', `> **Status:** Draft, drawn on ${today()}. Technical layer: one diagram per PRD requirement whose evidence reaches an API.`, ''];
  const prd = readDocText(home, id, 'prd');
  if (!prd) {
    L.push(`No PRD yet, so there are no requirements to draw. Write it with \`/tech-plugin:document ${id} prd\`, then run \`/tech-plugin:diagram ${id}\` again.`, '');
    return { text: L.join('\n'), drawn: 0, without: [] };
  }
  const ev = evidenceOf(prd);
  const others = {};
  for (const d of ['spec', 'brd']) {
    const t = readDocText(home, id, d);
    if (t) others[d] = evidenceOf(t);
  }
  L.push('Each diagram follows the routes and API calls that the requirement\'s evidence cites. The table under it gives the source of each step.', '');
  let drawn = 0;
  const without = [];
  for (const r of requirementsOf(prd, id)) {
    const cites = resolveTags(tagsIn(r.text), ev, others);
    const s = sequenceFor(r, pack, sys, cites);
    if (!s) {
      without.push(r);
      continue;
    }
    drawn++;
    L.push(`## ${r.id}: ${r.title}`, '', ...s.lines);
  }
  if (without.length) L.push('## Requirements with no API call in their evidence', '', ...without.map((r) => `- ${r.id}: ${r.title}`), '');
  return { text: L.join('\n'), drawn, without: without.map((r) => r.id) };
}

// ------------------------------------------------------------------ ER (technical layer)

const ent = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_');

function erMd(m, pack, sys) {
  const L = [`# ${m.name}: data`, '', `> **Status:** Draft, drawn on ${today()}. Technical layer.`, ''];
  const reg = idRegistry((_, s) => ent(s));
  const e = (s) => reg('', s);
  if (!pack.tables.length) {
    L.push('This module keeps no tables of its own in this system: its data lives in a service outside the breakdown, or in tables of other modules.', '');
    return { text: L.join('\n'), tables: 0, links: 0 };
  }
  const all = new Map();
  for (const [, a] of sys.apps) for (const t of a.tables) if (!all.has(t.name)) all.set(t.name, t);
  const mineT = new Set(pack.tables.map((t) => t.name));
  const find = (base) => {
    const c = [base, `${base}s`, `${base}es`, base.replace(/y$/, 'ies')];
    return c.find((x) => mineT.has(x)) || c.find((x) => all.has(x)) || null;
  };
  const rels = [];
  for (const t of pack.tables) for (const c of t.columns || []) {
    const mm = /^(\w+)_id$/.exec(c);
    if (!mm) continue;
    const to = find(mm[1]);
    if (to && to !== t.name) rels.push({ from: t.name, col: c, to });
  }
  L.push('Columns come from the migrations and models; their types are not read. Links between tables are **Inferred** from column names ending in `_id`: the code does not declare them, so a developer should confirm each one.', '', '```mermaid', 'erDiagram');
  for (const t of pack.tables) {
    L.push(`  ${e(t.name)} {`);
    const fks = new Set(rels.filter((r) => r.from === t.name).map((r) => r.col));
    for (const c of t.columns || []) L.push(`    col ${ent(c)}${c === 'id' ? ' PK' : fks.has(c) ? ' FK' : ''}`);
    L.push('  }');
  }
  for (const r of rels) L.push(`  ${e(r.to)} ||--o{ ${e(r.from)} : "${msg(r.col)}"`);
  L.push('```', '', '## Tables', '', '| Table | Columns | Models | Source | Class |', '|---|---|---|---|---|');
  for (const t of pack.tables) L.push(`| \`${t.name}\` | ${(t.columns || []).length} | ${(t.models || []).join(', ')} | \`${t.cite}\` | ${t.class || ''} |`);
  L.push('', '## Links between tables (Inferred)', '');
  if (!rels.length) L.push('No column ending in `_id` points at a known table.');
  for (const r of rels) L.push(`- \`${r.from}.${r.col}\` → \`${r.to}\`${mineT.has(r.to) ? '' : ' (a table of another module)'}`);
  L.push('');
  return { text: L.join('\n'), tables: pack.tables.length, links: rels.length };
}

// ------------------------------------------------------------------ draw

export function drawModule(home, id) {
  const upd = pluginUpdate(PLUGIN_ROOT);
  if (upd) fail(upd.message);
  const { my, m } = moduleOf(home, id);
  const pack = loadPack(home, id);
  const chk = checkLabels(home, id);
  if (!chk.ok) fail(`the screen names are not ready (${chk.problems.length}):\n  ${chk.problems.slice(0, 20).join('\n  ')}\nRun "diagram.mjs labels ${id}", have the labeller fill the empty names, then "check-labels".`);
  const sys = loadSystem(home);
  const L = readLabels(home, id);
  const labels = new Map(L.screens.map((s) => [String(s.screen), String(s.label).trim()]));
  const counts = { spec: 0, agent: 0, you: 0 };
  for (const s of L.screens) if (pack.screens.some((x) => keyOf(x) === String(s.screen))) counts[s.from === 'spec' ? 'spec' : s.from === 'agent' ? 'agent' : 'you']++;
  const graph = screenGraph(pack, sys, my, id);
  writeDocs(home, diagRel(id, 'flowchart.md'), flowchartMd(m, pack, graph, labels, counts));
  const seq = sequencesMd(home, id, m, pack, sys);
  writeDocs(home, diagRel(id, 'sequences.md'), seq.text);
  const er = erMd(m, pack, sys);
  writeDocs(home, diagRel(id, 'er.md'), er.text);
  writeDocs(home, diagRel(id, '_stamp.json'), JSON.stringify({ schema: 1, module: id, drawnAt: new Date().toISOString(), inputs: inputsOf(home, id, pack.hash) }, null, 1) + '\n');
  return { module: id, files: MODULE_FILES.map((f) => path.join(docsDir(home), diagRel(id, f))), screens: pack.screens.length, parts: parts(pack.screens).length, arrows: graph.edges.length, sequences: seq.drawn, withoutApi: seq.without, tables: er.tables, tableLinks: er.links };
}

function main() {
  const [cmd, id] = process.argv.slice(2);
  const a = parseArgs(process.argv.slice(3), ['force']);
  if (!a.home || !id) fail('usage: diagram.mjs <status|labels|check-labels|draw> <module|system> --home HOME [--force]');
  const home = real(a.home);
  const out = (x) => process.stdout.write(JSON.stringify(x, null, 2) + '\n');
  if (cmd === 'status') return out(status(home, id, { force: !!a.force }));
  if (id === 'system') {
    if (cmd !== 'draw') fail('for the system diagrams use: diagram.mjs status|draw system --home HOME');
    const upd = pluginUpdate(PLUGIN_ROOT);
    if (upd) fail(upd.message);
    return out(drawSystem(home));
  }
  if (cmd === 'labels') return out(prepareLabels(home, id));
  if (cmd === 'check-labels') {
    moduleOf(home, id);
    const r = checkLabels(home, id);
    process.stdout.write(r.ok ? `labels: PASS (${r.total} screen(s) named in plain words)\n` : `labels: FAIL (${r.problems.length} of ${r.total})\n  ${r.problems.join('\n  ')}\n`);
    process.exitCode = r.ok ? 0 : 1;
    return;
  }
  if (cmd === 'draw') return out(drawModule(home, id));
  fail('usage: diagram.mjs <status|labels|check-labels|draw> <module|system> --home HOME [--force]');
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) main();
