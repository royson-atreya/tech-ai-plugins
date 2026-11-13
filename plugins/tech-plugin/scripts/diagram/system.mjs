// System diagrams, drawn by script from the approved modules, the links
// between the apps and system.yaml:
//   system/diagrams/block.md     apps, database, backend outside the breakdown,
//                                external services, and what asks what for data
//   system/diagrams/journeys.md  the key flows from system.yaml, step by step;
//                                an arrow the code does not confirm is dashed
// The module map stays with breakdown (system/diagrams/module-map.md); its
// draw.io copy is refreshed here too. Every diagram gets a .drawio copy
// (drawio.mjs).

import fs from 'node:fs';
import path from 'node:path';
import { docsDir, fail, readJson, today, writeDocs } from '../breakdown/common.mjs';
import { factsStamps, loadLinks, loadSystem } from '../breakdown/load.mjs';
import { loadExisting } from '../breakdown/modules.mjs';
import { idRegistry, label, nid, sha } from './mermaid.mjs';
import { drawioMissing, writeDrawio } from './drawio.mjs';

export const SYSTEM_RENDERER = 2;
export const SYSTEM_FILES = ['block.md', 'journeys.md'];
const rel = (f) => path.join('system', 'diagrams', f);

function inputs(home) {
  const sys = loadSystem(home);
  const links = loadLinks(home) || { calls: [], routes: [] };
  const b = sys.system.business || {};
  // only what the drawings use: recording a sign-off (doc_status) or an owner
  // in modules.yaml does not make them stale
  const my = loadExisting(home) || { modules: [] };
  const drawn = (my.modules || []).map((m) => ({ id: m.id, name: m.name, purpose: m.purpose || null, depends_on: m.depends_on || [], depends_evidence: m.depends_evidence || {} }));
  return {
    sys,
    links,
    stamp: {
      modules: sha(JSON.stringify(drawn)),
      links: sha(JSON.stringify({ calls: links.calls, routes: links.routes })),
      facts: sha(JSON.stringify(factsStamps(sys.repos))),
      business: sha(JSON.stringify({ users: b.users || null, roles: b.roles || [], key_flows: b.key_flows || [], name: (sys.system.system || {}).name || null })),
      renderer: SYSTEM_RENDERER,
    },
  };
}

const REASONS = { modules: 'the module list changed', links: 'the links between the apps changed', facts: 'the code facts changed', business: 'the key flows, users or roles in system.yaml changed', renderer: 'tech-plugin draws diagrams differently now' };

export function systemState(home) {
  const D = docsDir(home);
  const st = readJson(path.join(D, rel('_stamp.json')));
  if (!st) return { state: 'missing', reasons: [], drawnAt: null };
  const now = inputs(home).stamp;
  const reasons = Object.keys(REASONS).filter((k) => (st.inputs || {})[k] !== now[k]).map((k) => REASONS[k]);
  if (SYSTEM_FILES.some((f) => !fs.existsSync(path.join(D, rel(f))))) reasons.push('a diagram file is missing');
  else if ([...SYSTEM_FILES, 'module-map.md'].some((f) => drawioMissing(home, rel(f)))) reasons.push('a draw.io file is missing');
  return { state: reasons.length ? 'stale' : 'up-to-date', reasons, drawnAt: st.drawnAt || null };
}

export function appKindLabel(kind) {
  const k = String(kind || '');
  if (/mobile/.test(k)) return 'Mobile app';
  if (/web/.test(k)) return 'Website';
  if (/backend|api/.test(k)) return 'Server';
  if (/desktop/.test(k)) return 'Desktop app';
  return 'App';
}

function blockMd(sys, links, my) {
  const s = sys.system;
  const b = s.business || {};
  const name = (s.system && s.system.name) || 'The system';
  const people = b.users ? String(b.users) : Array.isArray(b.roles) && b.roles.length ? b.roles.join(', ') : 'People';
  const M = ['```mermaid', 'flowchart LR', `  people(("${label(people)}"))`];
  const id = idRegistry();
  const ev = [];
  const apps = [...sys.apps.values()];
  for (const a of apps) M.push(`  ${id('app', a.id)}["${label(appKindLabel(a.kind))}<br/>${label(a.id)}"]`);
  const counts = new Map();
  const outside = new Map();
  for (const c of links.calls || []) {
    if (c.route && c.route.app && c.route.app !== c.app && (c.status === 'matched' || c.status === 'method-mismatch')) {
      const k = `${c.app}>${c.route.app}`;
      if (!counts.has(k)) counts.set(k, { n: 0, cite: `${c.repo}:${c.cite}` });
      counts.get(k).n++;
    } else if (c.status === 'outside-system') {
      if (!outside.has(c.app)) outside.set(c.app, { n: 0, cite: `${c.repo}:${c.cite}` });
      outside.get(c.app).n++;
    }
  }
  if (outside.size) M.push('  outside["Server outside this breakdown"]');
  const withDb = apps.filter((a) => (a.tables || []).length);
  const onDevice = (a) => a.tables.every((t) => t.local);
  for (const a of withDb) M.push(`  ${id('db', a.id)}[("${onDevice(a) ? `Data kept on the device` : `Database of ${label(a.id)}`}")]`);
  const ext = [...new Set(apps.flatMap((a) => (a.externals && a.externals.systems ? a.externals.systems.map((x) => x.system) : [])))];
  for (const e of ext) M.push(`  ${id('ext', e)}(("${label(e)}"))`);
  const front = apps.filter((a) => (a.screens || []).length);
  for (const a of front) {
    M.push(`  people --> ${id('app', a.id)}`);
    ev.push(`- People → ${a.id}: ${a.screens.length} screen(s), e.g. \`${a.repo}:${a.screens[0].cite}\``);
  }
  for (const [k, v] of counts) {
    const [x, y] = k.split('>');
    M.push(`  ${id('app', x)} -->|"asks for data"| ${id('app', y)}`);
    ev.push(`- ${x} → ${y}: ${v.n} call(s) linked to its routes, e.g. \`${v.cite}\``);
  }
  for (const [x, v] of outside) {
    M.push(`  ${id('app', x)} -->|"asks for data"| outside`);
    ev.push(`- ${x} → server outside this breakdown: ${v.n} call(s), e.g. \`${v.cite}\``);
  }
  for (const a of withDb) {
    M.push(`  ${id('app', a.id)} --> ${id('db', a.id)}`);
    ev.push(`- ${a.id} → its database: ${a.tables.length} table(s), e.g. \`${a.repo}:${a.tables[0].cite}\``);
  }
  for (const a of apps) for (const x of (a.externals && a.externals.systems) || []) {
    M.push(`  ${id('app', a.id)} -.-> ${id('ext', x.system)}`);
    const f = x.files[0];
    ev.push(`- ${a.id} → ${x.system}: used in ${x.files.length} file(s), e.g. \`${a.repo}:${f.file}:${f.lines[0]}\``);
  }
  M.push('```', '');
  const L = [`# ${name}: the system at a glance`, '', `> **Status:** Draft, drawn on ${today()} from the code of every app in the system.`, '', `Also saved as \`block.drawio\`, the same diagram to open and rearrange in draw.io or diagrams.net. A redraw never overwrites a copy you changed: it writes \`block.new.drawio\` instead.`, ''];
  L.push('How to read it: square boxes are the apps people use or that serve them. Cylinders are databases. Circles are services run by other companies; a dashed arrow means an app uses that service. "Asks for data" means one app sends requests to the other.', '', ...M);
  L.push('## For developers', '', '| App | Kind | Repo | Screens | Routes | Tables |', '|---|---|---|---|---|---|');
  for (const a of apps) L.push(`| ${a.id} | ${a.kind} | ${a.repo} | ${(a.screens || []).length} | ${(a.routes || []).filter((r) => !r.shadowed).length} | ${(a.tables || []).length} |`);
  L.push('', '**Arrows and their evidence**', '', ...(ev.length ? ev : ['No arrows: the apps do not call each other or any service.']), '', `Module boundaries are in the [module map](module-map.md) (${my.modules.length} modules).`, '');
  return L.join('\n');
}

// A step of a key flow: "text", { module, does } or { <module id>: text }.
export function parseStep(x) {
  if (typeof x === 'string') return { module: null, text: x };
  if (x && typeof x === 'object') {
    if (x.module || x.does || x.step) return { module: x.module ? String(x.module) : null, text: String(x.does || x.step || '') };
    const ks = Object.keys(x);
    if (ks.length === 1) return { module: ks[0], text: String(x[ks[0]] ?? '') };
  }
  return { module: null, text: String(x ?? '') };
}

function journeysMd(sys, my) {
  const s = sys.system;
  const b = s.business || {};
  const name = (s.system && s.system.name) || 'The system';
  const flows = Array.isArray(b.key_flows) ? b.key_flows : [];
  const byId = new Map(my.modules.map((m) => [m.id, m]));
  const linked = (a, z) => {
    if (!a || !z || !byId.has(a) || !byId.has(z)) return null;
    if (a === z) return 'the same module';
    for (const [x, y] of [[a, z], [z, a]]) {
      const m = byId.get(x);
      if ((m.depends_on || []).includes(y)) {
        const e = ((m.depends_evidence || {})[y] || [])[0];
        return `${x} calls ${y}${e ? `: \`${e.split(' -> ')[0]}\` calls \`${e.split(' -> ')[1]}\`` : ''}`;
      }
    }
    return null;
  };
  const L = [`# ${name}: key journeys`, '', `> **Status:** Draft, drawn on ${today()} from the key flows in system.yaml and the links found in the code.`, '', `Also saved as \`journeys.drawio\`, the same diagram to open and rearrange in draw.io or diagrams.net. A redraw never overwrites a copy you changed: it writes \`journeys.new.drawio\` instead.`, ''];
  L.push('How to read it: each box is a step and names the part of the product that does it. A solid arrow means the code shows these two parts working together. A dashed arrow means the code does not confirm it: someone who knows the product should check that step.', '');
  if (!flows.length) {
    L.push('No key flows are given yet. Add them to `system.yaml` under `business:` → `key_flows:`, for example:', '', '```yaml', 'key_flows:', '  - name: Book a consultation', '    steps:', `      - ${my.modules[0] ? my.modules[0].id : 'auth'}: The patient signs in`, '      - The patient picks a time', '```', '');
    return { text: L.join('\n'), flows: 0, dashed: 0 };
  }
  const dev = ['## For developers', '', '| Journey | Arrow | Confirmed by |', '|---|---|---|'];
  let dashed = 0;
  flows.forEach((f, i) => {
    const title = typeof f === 'string' ? f : String((f && (f.name || f.flow)) || `Journey ${i + 1}`);
    const steps = f && typeof f === 'object' && Array.isArray(f.steps) ? f.steps.map(parseStep) : [];
    L.push(`## ${title}`, '');
    if (!steps.length) {
      const words = title.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
      const maybe = my.modules.filter((m) => words.some((w) => `${m.id} ${m.name} ${m.purpose || ''}`.toLowerCase().includes(w)));
      L.push('No steps are given for this journey yet, so it cannot be drawn. Give its steps in `system.yaml`, each with the module that does it, for example `- patients: The doctor opens the patient list`.', '');
      if (maybe.length) L.push(`Parts of the product whose name or purpose shares a word with it (not confirmed): ${maybe.map((m) => m.name).join(', ')}.`, '');
      return;
    }
    const M = ['```mermaid', 'flowchart LR'];
    steps.forEach((st, n) => {
      const m = st.module && byId.get(st.module);
      M.push(`  ${nid(`j${i + 1}`, n + 1)}["${label(st.text || 'Step')}${m ? `<br/>${label(m.name)}` : st.module ? '<br/>part not found' : ''}"]`);
    });
    const unsure = [];
    for (let n = 1; n < steps.length; n++) {
      const why = linked(steps[n - 1].module, steps[n].module);
      M.push(`  ${nid(`j${i + 1}`, n)} ${why ? '-->' : '-.->'} ${nid(`j${i + 1}`, n + 1)}`);
      if (!why) {
        dashed++;
        unsure.push(n);
      }
      dev.push(`| ${title.replace(/\|/g, '/')} | step ${n} → ${n + 1} (${steps[n - 1].module || 'no module'} → ${steps[n].module || 'no module'}) | ${why || 'not confirmed'} |`);
    }
    M.push('```', '');
    L.push(...M);
    const unknown = steps.filter((st) => st.module && !byId.has(st.module)).map((st) => st.module);
    if (unknown.length) L.push(`Not a module of this system: ${[...new Set(unknown)].join(', ')}. Use a module id from the module catalogue.`, '');
    if (unsure.length) L.push(`To check: ${unsure.map((n) => `step ${n} to step ${n + 1}`).join(', ')}.`, '');
  });
  if (dev.length > 4) L.push(...dev, '');
  return { text: L.join('\n'), flows: flows.length, dashed };
}

export function drawSystem(home) {
  const my = loadExisting(home);
  if (!my || !Array.isArray(my.modules)) fail('no approved modules.yaml yet: run /tech-plugin:breakdown first');
  const { sys, links, stamp } = inputs(home);
  const block = blockMd(sys, links, my);
  const j = journeysMd(sys, my);
  const drawio = [];
  for (const [f, text] of [['block.md', block], ['journeys.md', j.text]]) {
    writeDocs(home, rel(f), text);
    drawio.push(writeDrawio(home, rel(f), text));
  }
  const mapFile = path.join(docsDir(home), rel('module-map.md'));
  if (fs.existsSync(mapFile)) drawio.push(writeDrawio(home, rel('module-map.md'), fs.readFileSync(mapFile, 'utf8')));
  writeDocs(home, rel('_stamp.json'), JSON.stringify({ schema: 1, drawnAt: new Date().toISOString(), inputs: stamp }, null, 1) + '\n');
  const D = docsDir(home);
  return { module: 'system', files: [...SYSTEM_FILES.map((f) => path.join(D, rel(f))), ...drawio.filter((d) => d.written).map((d) => path.join(D, d.file))], keptDrawio: drawio.filter((d) => d.kept).map((d) => ({ file: d.file, newFile: d.newFile })), apps: sys.apps.size, journeys: j.flows, dashedArrows: j.dashed };
}
