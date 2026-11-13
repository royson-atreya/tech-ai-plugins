#!/usr/bin/env node
// breakdown stage 6: write the breakdown, from the approved modules.yaml and
// the code facts. Scripts only: the same input gives the same documents.
//
//   node catalogue.mjs --home HOME
//
// Writes in the home repo's sdlc-docs/:
//   modules/README.md               module catalogue + suggested order of next steps
//   modules/<id>/module.md          scope card per module (a "Notes" block you write is kept)
//   system/overview.md              the whole system on one page
//   system/diagrams/module-map.md   Mermaid module map; every arrow listed with its evidence
//                                   (+ module-map.drawio, the same map for draw.io)
// and adds the domain words found in code to glossary.md (meaning to be confirmed).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { docsDir, fail, parseArgs, real, today, writeDocs } from './common.mjs';
import { factsStamps, loadLinks, loadSystem } from './load.mjs';
import { loadExisting } from './modules.mjs';
import { loadState, saveState } from './state.mjs';
import { writeIndexFromYaml } from './write.mjs';
import { writeDrawio } from '../diagram/drawio.mjs';

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const NOTES_START = '<!-- notes:start (yours: kept on every rewrite) -->';
const NOTES_END = '<!-- notes:end -->';

function keepNotes(file) {
  if (!fs.existsSync(file)) return '_Add your notes here. This block is kept when breakdown rewrites the card._';
  const t = fs.readFileSync(file, 'utf8');
  const a = t.indexOf(NOTES_START);
  const b = t.indexOf(NOTES_END);
  return a !== -1 && b > a ? t.slice(a + NOTES_START.length, b).trim() : '_Add your notes here. This block is kept when breakdown rewrites the card._';
}

// Modules others depend on come first, then critical ones, then bigger ones.
export function suggestedOrder(modules) {
  const used = new Map(modules.map((m) => [m.id, 0]));
  for (const m of modules) for (const d of m.depends_on || []) used.set(d, (used.get(d) || 0) + 1);
  const size = { L: 3, M: 2, S: 1 };
  return [...modules].sort((a, b) => (used.get(b.id) || 0) - (used.get(a.id) || 0) || Number(b.critical) - Number(a.critical) || (size[b.size] || 0) - (size[a.size] || 0) || a.id.localeCompare(b.id));
}

export function writeCatalogue(home) {
  const my = loadExisting(home);
  if (!my || !Array.isArray(my.modules)) fail('no approved modules.yaml yet; run stage 5 first');
  const sys = loadSystem(home);
  const links = loadLinks(home);
  const D = docsDir(home);
  const date = today();
  const commits = Object.entries(my.commits || {}).map(([r, c]) => `${r} ${c ? String(c).slice(0, 7) : '(no commits)'}`).join(' · ');
  const routeOf = new Map();
  for (const [id, a] of sys.apps) for (const r of a.routes) if (!r.shadowed) routeOf.set(`${id}|${r.key}`, r);
  const screenOf = new Map();
  for (const [id, a] of sys.apps) for (const s of a.screens) screenOf.set(`${id}|${s.id}`, s);
  const tableOf = new Map();
  for (const [id, a] of sys.apps) for (const t of a.tables) if (!tableOf.has(t.name)) tableOf.set(t.name, { ...t, app: id, repo: a.repo });
  const callersOf = new Map();
  if (links) for (const r of links.routes) callersOf.set(`${r.app}|${r.key}`, r.count || 0);
  const usedBy = new Map(my.modules.map((m) => [m.id, []]));
  for (const m of my.modules) for (const d of m.depends_on || []) if (usedBy.has(d)) usedBy.get(d).push(m.id);
  const cite = (app, c) => {
    const a = sys.apps.get(app);
    return a && c ? `${a.repo}:${c}` : c || '';
  };
  const stamp = (status) => [`> **Status:** ${status}  `, `> **Written by:** /tech-plugin:breakdown stage 6 on ${date}  `, `> **Modules approved by:** ${(my.approved && my.approved.by) || 'unknown'} on ${(my.approved && my.approved.on) || '?'}  `, `> **Commits:** ${commits}`, ''];
  const files = [];

  // ---- module cards
  for (const m of my.modules) {
    const rel = path.join('modules', m.id, 'module.md');
    const notes = keepNotes(path.join(D, rel));
    const L = [`# ${m.name}`, '', ...stamp('Draft (scope card: boundaries approved, details from code)'), `**Module id:** \`${m.id}\` · **Size:** ${m.size} · **Critical:** ${m.critical ? 'yes' : 'no'} · **Owner:** ${m.owner} · **Docs:** ${m.doc_status}`, ''];
    L.push('## Purpose', '', m.purpose ? `${m.purpose} _(Draft wording, to be confirmed by the owner.)_` : '_Not written yet._', '');
    if (m.risk && m.risk.length) {
      L.push('## Risk', '', ...m.risk.map((r) => `- **${r.flag}:** ${r.reason}`), '', 'Critical modules get two doc-checker passes, and every open question waits for a decision.', '');
    }
    L.push('## In use', '', `| Environment | In use |`, '|---|---|', ...Object.entries(m.in_use || {}).map(([e, v]) => `| ${e} | ${v} |`), '');
    const scr = (m.screens || []).map((k) => [k, screenOf.get(k)]).filter(([, s]) => s);
    L.push(`## Screens (${scr.length})`, '');
    if (scr.length) {
      L.push('| App | Screen | Path | Source |', '|---|---|---|---|');
      for (const [k, s] of scr) L.push(`| ${k.split('|')[0]} | ${esc(s.name || s.id)} | ${s.path ? `\`${esc(s.path)}\`` : ''} | ${s.cite ? `\`${cite(k.split('|')[0], s.cite)}\`` : ''} |`);
    } else L.push('None.');
    L.push('');
    const rts = (m.routes || []).map((k) => [k, routeOf.get(k)]).filter(([, r]) => r);
    L.push(`## APIs (${rts.length})`, '');
    if (rts.length) {
      L.push('| Method | Path | Handler | Called by apps | Source |', '|---|---|---|---|---|');
      for (const [k, r] of rts) L.push(`| ${r.method} | \`${esc(r.uri)}\` | ${esc((r.handler || '').split('\\').pop())} | ${callersOf.get(k) || 0} | \`${cite(k.split('|')[0], r.cite)}\` |`);
    } else L.push('None.');
    L.push('');
    const web = (m.web_routes || []).map((k) => [k, routeOf.get(k)]).filter(([, r]) => r);
    if (web.length) {
      L.push(`## Web routes of other apps (${web.length})`, '', '| App | Method | Path | Handler | Source |', '|---|---|---|---|---|');
      for (const [k, r] of web) L.push(`| ${k.split('|')[0]} | ${r.method} | \`${esc(r.uri)}\` | ${esc((r.handler || '').split('\\').pop())} | \`${cite(k.split('|')[0], r.cite)}\` |`);
      L.push('');
    }
    L.push(`## Tables (${(m.tables || []).length})`, '');
    if ((m.tables || []).length) {
      L.push('| Table | Where defined | Columns |', '|---|---|---|');
      for (const t of m.tables) {
        const x = tableOf.get(t);
        L.push(`| \`${esc(t)}\` | ${x ? `\`${x.repo}:${x.cite}\`${x.class === 'Inferred' ? ' (Inferred)' : ''}` : 'not found in migrations or models'} | ${x && x.columns.length ? x.columns.length : ''} |`);
      }
    } else L.push('None found.');
    L.push('');
    if ((m.external_systems || []).length) L.push('## External services', '', ...m.external_systems.map((e) => `- ${e}`), '');
    L.push('## Connections', '');
    L.push(`- **Uses:** ${(m.depends_on || []).length ? m.depends_on.map((d) => `[${d}](../${d}/module.md)`).join(', ') : 'no other module'}`);
    L.push(`- **Used by:** ${usedBy.get(m.id).length ? usedBy.get(m.id).map((d) => `[${d}](../${d}/module.md)`).join(', ') : 'no other module'}`, '');
    L.push('## Where the code is', '', ...(m.parts || []).map((p) => `- **${p.app}:** ${[...(p.handlers || []).map((h) => `handler \`${h}\``), ...(p.paths || []).map((x) => `\`${x}\``), ...(p.screens || []).map((x) => `screen ${x}`), ...(p.groups || []).map((x) => `code group ${x}`)].join(', ') || 'single routes only'}`), '');
    L.push('## Next steps', '', `- \`/tech-plugin:document ${m.id}\`: spec, BRD and PRD for this module`, `- \`/tech-plugin:diagram ${m.id}\`: flowchart, ER and sequence diagrams`, '');
    L.push('## Notes', '', NOTES_START, notes, NOTES_END, '');
    writeDocs(home, rel, L.join('\n'));
    files.push(rel);
  }

  // ---- catalogue
  const order = suggestedOrder(my.modules);
  const C = ['# Modules', '', ...stamp('Draft (boundaries approved; purposes to be confirmed)'), 'Read this first. One row per business module; each links to its scope card.', ''];
  C.push('| Module | Purpose | Size | Risk | APIs | Screens | Tables | Uses | Docs |', '|---|---|---|---|---|---|---|---|---|');
  for (const m of my.modules) C.push(`| [${esc(m.name)}](${m.id}/module.md) \`${m.id}\` | ${esc(m.purpose || '')} | ${m.size} | ${(m.risk || []).map((r) => r.flag).join(', ') || '-'} | ${(m.routes || []).length} | ${(m.screens || []).length} | ${(m.tables || []).length} | ${(m.depends_on || []).join(', ')} | ${m.doc_status} |`);
  C.push('');
  for (const b of my.backends || []) {
    const a = sys.apps.get(b);
    if (!a) continue;
    const total = new Set(a.routes.filter((r) => !r.shadowed).map((r) => r.key)).size;
    const inMods = my.modules.reduce((n, m) => n + (m.routes || []).filter((k) => k.startsWith(`${b}|`)).length, 0);
    const un = (my.unassigned || []).filter((u) => u.app === b).reduce((n, u) => n + (u.routes || []).length, 0);
    C.push(`**Coverage (${b}):** ${inMods} of ${total} routes in a module; ${un} unassigned with a reason.`);
  }
  if ((my.unassigned || []).length) {
    C.push('', '**Unassigned routes, with the reason:**', '');
    for (const u of my.unassigned) C.push(`- ${u.app}: \`${u.match}\` (${(u.routes || []).length}): ${u.reason}`);
  }
  C.push('', '## Suggested order of next steps', '', 'Modules other modules depend on first, then critical ones, then the bigger ones.', '');
  order.slice(0, 8).forEach((m, i) => C.push(`${i + 1}. \`/tech-plugin:document ${m.id}\`: ${m.name}${m.critical ? ' (critical)' : ''}`));
  C.push('', 'Also: [system overview](../system/overview.md) · [module map](../system/diagrams/module-map.md) · [API links](../_map/links.md)', '');
  writeDocs(home, path.join('modules', 'README.md'), C.join('\n'));
  files.push('modules/README.md');

  // ---- module map (Mermaid) with evidence
  const id = (s) => s.replace(/[^A-Za-z0-9_]/g, '_');
  const M = ['# Module map', '', ...stamp('Draft'), 'Boxes are modules (thick border: critical); an arrow means the first module calls an API of the second. External services hang off the modules that use them. Every arrow is listed below with its evidence.', '', `Also saved as \`module-map.drawio\`, the same diagram to open and rearrange in draw.io or diagrams.net. A redraw never overwrites a copy you changed: it writes \`module-map.new.drawio\` instead.`, '', '```mermaid', 'flowchart LR'];
  for (const m of my.modules) M.push(`  ${id(m.id)}${m.critical ? '[["' : '["'}${m.name.replace(/"/g, "'")}${m.critical ? '"]]' : '"]'}`);
  const ext = [...new Set(my.modules.flatMap((m) => m.external_systems || []))];
  for (const e of ext) M.push(`  ext_${id(e)}(("${e.replace(/"/g, "'")}"))`);
  for (const m of my.modules) for (const d of m.depends_on || []) M.push(`  ${id(m.id)} --> ${id(d)}`);
  for (const m of my.modules) for (const e of m.external_systems || []) M.push(`  ${id(m.id)} -.-> ext_${id(e)}`);
  M.push('```', '', '## Arrows and their evidence', '');
  const ev = [];
  for (const m of my.modules) for (const d of m.depends_on || []) {
    const e = (m.depends_evidence && m.depends_evidence[d]) || [];
    ev.push(`- ${m.id} → ${d}${e.length ? `: ${e.map((x) => `\`${x.split(' -> ')[0]}\` calls \`${x.split(' -> ')[1]}\``).join('; ')}` : ''}`);
  }
  M.push(...(ev.length ? ev : ['No calls between modules were found.']), '');
  writeDocs(home, path.join('system', 'diagrams', 'module-map.md'), M.join('\n'));
  writeDrawio(home, path.join('system', 'diagrams', 'module-map.md'), M.join('\n'));
  files.push('system/diagrams/module-map.md');

  // ---- system overview
  const s = sys.system;
  const b = s.business || {};
  const O = [`# ${(s.system && s.system.name) || path.basename(home)}: the system on one page`, '', ...stamp('Draft'), '## What it is', ''];
  O.push(b.product ? String(b.product) : '_Product description not given yet (stage 1 question 1)._', '');
  if (b.users) O.push(`**Users:** ${b.users}`, '');
  if (Array.isArray(b.roles) && b.roles.length) O.push(`**Roles:** ${b.roles.join(', ')}`, '');
  if (Array.isArray(b.key_flows) && b.key_flows.length) O.push('**Key flows:**', '', ...b.key_flows.map((f) => `- ${f}`), '');
  O.push('## Apps', '', '| App | Repo | Kind | Main stack | Routes | Screens | API calls |', '|---|---|---|---|---|---|---|');
  for (const r of sys.repos) for (const a of (r.stack && r.stack.apps) || []) {
    const f = sys.apps.get(a.id);
    const main = a.stack.filter((x) => ['backend', 'web', 'mobile', 'desktop'].includes(x.kind)).map((x) => x.name).join(', ');
    O.push(`| ${a.id} | ${r.name} | ${a.kind} | ${esc(main)} | ${f ? f.counts.uniqueRoutes : ''} | ${f ? f.counts.screens : ''} | ${f ? f.counts.calls : ''} |`);
  }
  O.push('', `## Modules (${my.modules.length})`, '', ...my.modules.map((m) => `- [${m.name}](../modules/${m.id}/module.md)${m.critical ? ' (critical)' : ''}${m.purpose ? `: ${m.purpose}` : ''}`), '');
  const extAll = [...new Set([...sys.apps.values()].flatMap((a) => a.externals.systems.map((x) => x.system)))];
  if (extAll.length) O.push('## External services', '', ...extAll.map((e) => `- ${e}: used by ${my.modules.filter((m) => (m.external_systems || []).includes(e)).map((m) => m.id).join(', ') || 'no module yet'}`), '');
  if (Array.isArray(b.environments) && b.environments.length) O.push('## Environments', '', ...b.environments.map((e) => `- ${e.name}${e.production ? ' (production)' : ''}${e.url ? `: ${e.url}` : ''}`), '');
  O.push('See the [module map](diagrams/module-map.md) and the [module catalogue](../modules/README.md).', '');
  writeDocs(home, path.join('system', 'overview.md'), O.join('\n'));
  files.push('system/overview.md');

  // ---- glossary: domain words from the code, meaning to be confirmed
  addGlossaryTerms(home, sys);

  const st = loadState(home);
  const modulesHash = crypto.createHash('sha1').update(fs.readFileSync(path.join(D, 'modules.yaml'), 'utf8')).digest('hex').slice(0, 16);
  st.stages = { ...(st.stages || {}), 6: { status: 'done', at: new Date().toISOString(), modules: modulesHash, inputs: factsStamps(sys.repos) } };
  saveState(home, st);
  writeIndexFromYaml(home);
  return { files, order: order.map((m) => m.id) };
}

function addGlossaryTerms(home, sys) {
  const file = path.join(docsDir(home), 'glossary.md');
  if (!fs.existsSync(file)) return;
  const old = fs.readFileSync(file, 'utf8');
  const have = new Set(old.split('\n').map((l) => (/^\|\s*([^|]+?)\s*\|/.exec(l) || [])[1]).filter(Boolean).map((t) => t.toLowerCase()));
  const seen = new Map();
  for (const [, a] of sys.apps) {
    for (const t of a.tables) if (!t.local) seen.set(t.name.toLowerCase(), seen.get(t.name.toLowerCase()) || `${a.repo}:${t.cite}`);
    for (const m of a.models) if (!a.tables.some((t) => t.name === m.table)) seen.set(m.name.toLowerCase(), seen.get(m.name.toLowerCase()) || `${a.repo}:${m.cite}`);
  }
  const rows = [];
  for (const [term, where] of [...seen.entries()].slice(0, 60)) {
    if (have.has(term) || term.length < 4 || /^(users?|password_resets?|failed_jobs|migrations|personal_access_tokens|jobs|sessions|cache|cache_locks|job_batches|password_reset_tokens|notifications)$/.test(term)) continue;
    have.add(term);
    rows.push(`| ${term} | To be confirmed (found in code) | \`${where}\` |`);
  }
  if (rows.length) writeDocs(home, 'glossary.md', old.replace(/\n*$/, '\n') + rows.join('\n') + '\n');
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.home) fail('usage: catalogue.mjs --home HOME');
  const r = writeCatalogue(real(a.home));
  process.stdout.write(`wrote ${r.files.length} files: modules/README.md, ${r.files.length - 3} module cards, system/overview.md, system/diagrams/module-map.md\nsuggested order: ${r.order.slice(0, 5).join(', ')}\n`);
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) main();
