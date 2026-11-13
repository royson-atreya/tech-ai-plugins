// draw.io copies of the diagrams. Every diagram is written as Mermaid first
// (it renders on GitHub and in the portal); this file turns that Mermaid into
// a .drawio file beside it, so both always show the same boxes and arrows.
// It reads only the Mermaid the plugin's own scripts write: flowcharts
// (flowchart LR), sequence diagrams and ER diagrams. Each ```mermaid block
// becomes one page, named after the "## " heading above it.
//
// draw.io does not arrange boxes by itself, so the layout is done here:
//   flowchart  columns left to right, by the longest path from a start box
//   sequence   one lifeline per participant (the person's in bold), the
//              messages top to bottom
//   ER         one box per table listing its columns, four tables a row
//
// A .drawio file someone rearranged is never overwritten: _drawio.json in the
// same folder records the hash of what the plugin wrote, and when the file on
// disk differs, the new drawing goes to <name>.new.drawio instead.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { docsDir, readJson, writeDocs } from '../breakdown/common.mjs';

export const DRAWIO_STORE = '_drawio.json';

const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// A Mermaid label as the HTML value of a draw.io cell: "<br/>" is a line break,
// everything else is text.
const htmlValue = (s) =>
  String(s)
    .split(/<br\s*\/?>/i)
    .map((p) => p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
    .join('<br>');
const lines = (s) => String(s).split(/<br\s*\/?>/i);

// ------------------------------------------------------------------ Mermaid blocks

export function mermaidBlocks(md) {
  const out = [];
  let doc = null;
  let title = null;
  let cur = null;
  for (const l of String(md).split('\n')) {
    if (cur) {
      if (l.trim() === '```') {
        out.push(cur);
        cur = null;
      } else cur.lines.push(l);
      continue;
    }
    if (/^# /.test(l) && !doc) doc = l.slice(2).trim();
    else if (/^## /.test(l)) title = l.slice(3).trim();
    else if (l.trim() === '```mermaid') cur = { title: title || doc || 'Diagram', lines: [] };
  }
  return out;
}

const kindOf = (blockLines) => {
  const first = blockLines.map((l) => l.trim()).find(Boolean) || '';
  if (/^(flowchart|graph)\b/.test(first)) return 'flowchart';
  if (/^sequenceDiagram\b/.test(first)) return 'sequence';
  if (/^erDiagram\b/.test(first)) return 'er';
  return null;
};

// ------------------------------------------------------------------ cells

const vertex = (id, value, style, x, y, w, h, parent = '1') => `<mxCell id="${xmlEsc(id)}" value="${xmlEsc(value)}" style="${style}" vertex="1" parent="${xmlEsc(parent)}"><mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/></mxCell>`;
const edge = (id, value, style, source, target) => `<mxCell id="${xmlEsc(id)}" value="${xmlEsc(value)}" style="${style}" edge="1" parent="1" source="${xmlEsc(source)}" target="${xmlEsc(target)}"><mxGeometry relative="1" as="geometry"/></mxCell>`;
const freeEdge = (id, value, style, x1, y1, x2, y2, points = []) =>
  `<mxCell id="${xmlEsc(id)}" value="${xmlEsc(value)}" style="${style}" edge="1" parent="1"><mxGeometry relative="1" as="geometry"><mxPoint x="${x1}" y="${y1}" as="sourcePoint"/><mxPoint x="${x2}" y="${y2}" as="targetPoint"/>${points.length ? `<Array as="points">${points.map(([x, y]) => `<mxPoint x="${x}" y="${y}"/>`).join('')}</Array>` : ''}</mxGeometry></mxCell>`;

// ------------------------------------------------------------------ flowchart

const OPENERS = [
  ['[[', ']]', 'critical'],
  ['[(', ')]', 'cylinder'],
  ['([', '])', 'stadium'],
  ['((', '))', 'circle'],
  ['[', ']', 'box'],
  ['(', ')', 'rounded'],
];

export function parseFlowchart(blockLines) {
  const nodes = new Map();
  const edges = [];
  const dashedClass = new Map();
  const dashedNodes = new Set();
  for (const raw of blockLines) {
    const l = raw.trim();
    if (!l || /^(flowchart|graph)\b/.test(l)) continue;
    let m;
    if ((m = /^classDef\s+(\w+)\s+(.*)$/.exec(l))) {
      dashedClass.set(m[1], /stroke-dasharray/.test(m[2]));
      continue;
    }
    if ((m = /^class\s+([\w,]+)\s+(\w+)$/.exec(l))) {
      if (dashedClass.get(m[2])) for (const id of m[1].split(',')) dashedNodes.add(id);
      continue;
    }
    if ((m = /^(\w+)\s+(-->|-\.->|==>)\s*(?:\|"([^"]*)"\|\s*)?(\w+)$/.exec(l))) {
      edges.push({ from: m[1], to: m[4], dashed: m[2] === '-.->', label: m[3] || '' });
      continue;
    }
    if ((m = /^(\w+)(\[\[|\[\(|\(\[|\(\(|\[|\()"(.*)"(\]\]|\)\]|\]\)|\)\)|\]|\))$/.exec(l))) {
      const shape = OPENERS.find(([o, c]) => o === m[2] && c === m[4]);
      nodes.set(m[1], { id: m[1], label: m[3], shape: shape ? shape[2] : 'box' });
    }
  }
  for (const e of edges) for (const k of [e.from, e.to]) if (!nodes.has(k)) nodes.set(k, { id: k, label: k, shape: 'box' });
  for (const id of dashedNodes) if (nodes.has(id)) nodes.get(id).dashed = true;
  return { nodes, edges };
}

// Column of each box: the longest path to it from a box with no arrow in,
// ignoring the arrows that close a loop.
function columns(nodes, edges) {
  const ids = [...nodes.keys()];
  const out = new Map(ids.map((i) => [i, []]));
  const hasIn = new Set();
  for (const e of edges) {
    if (e.from === e.to) continue;
    out.get(e.from).push(e.to);
    hasIn.add(e.to);
  }
  const seen = new Map();
  const back = new Set();
  const order = [];
  const visit = (start) => {
    // iterative depth-first search: back edges close a loop
    const stack = [[start, 0]];
    seen.set(start, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const [u, i] = top;
      const next = out.get(u)[i];
      if (next === undefined) {
        seen.set(u, 2);
        order.push(u);
        stack.pop();
        continue;
      }
      top[1]++;
      if (seen.get(next) === 1) back.add(`${u}>${next}`);
      else if (!seen.get(next)) {
        seen.set(next, 1);
        stack.push([next, 0]);
      }
    }
  };
  for (const id of ids) if (!hasIn.has(id) && !seen.get(id)) visit(id);
  for (const id of ids) if (!seen.get(id)) visit(id);
  const col = new Map(ids.map((i) => [i, 0]));
  for (const u of order.reverse()) for (const v of out.get(u)) if (!back.has(`${u}>${v}`)) col.set(v, Math.max(col.get(v), col.get(u) + 1));
  return col;
}

const SHAPE_STYLE = {
  box: 'rounded=1;whiteSpace=wrap;html=1;',
  rounded: 'rounded=1;whiteSpace=wrap;html=1;',
  critical: 'rounded=1;whiteSpace=wrap;html=1;strokeWidth=3;',
  stadium: 'rounded=1;arcSize=50;whiteSpace=wrap;html=1;',
  circle: 'ellipse;whiteSpace=wrap;html=1;',
  cylinder: 'shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;size=10;',
};

function sizeOf(n) {
  const wrapped = lines(n.label).reduce((a, p) => a + Math.max(1, Math.ceil(p.length / 24)), 0);
  if (n.shape === 'circle') {
    const d = Math.max(60, Math.min(140, 30 + 9 * Math.max(...lines(n.label).map((p) => p.length))));
    return [d, d];
  }
  return [180, Math.max(50, 18 * wrapped + 24)];
}

function flowchartCells(blockLines) {
  const { nodes, edges } = parseFlowchart(blockLines);
  const col = columns(nodes, edges);
  const byCol = new Map();
  for (const id of nodes.keys()) {
    const c = col.get(id);
    if (!byCol.has(c)) byCol.set(c, []);
    byCol.get(c).push(id);
  }
  // order each column by where the boxes pointing at it sit, to cross fewer arrows
  const rowOf = new Map();
  const cols = [...byCol.keys()].sort((a, b) => a - b);
  for (const c of cols) {
    const list = byCol.get(c);
    const key = (id) => {
      const from = edges.filter((e) => e.to === id && rowOf.has(e.from)).map((e) => rowOf.get(e.from));
      return from.length ? from.reduce((a, b) => a + b, 0) / from.length : Infinity;
    };
    const def = new Map(list.map((id, i) => [id, i]));
    list.sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      return ka === kb ? def.get(a) - def.get(b) : ka === Infinity ? 1 : kb === Infinity ? -1 : ka - kb;
    });
    list.forEach((id, i) => rowOf.set(id, i));
  }
  const cells = [];
  let width = 0;
  let height = 0;
  cols.forEach((c, ci) => {
    let y = 40;
    const x = 40 + ci * 280;
    for (const id of byCol.get(c)) {
      const n = nodes.get(id);
      const [w, h] = sizeOf(n);
      const style = SHAPE_STYLE[n.shape] + (n.dashed ? 'dashed=1;' : '');
      cells.push(vertex(`n_${id}`, htmlValue(n.label), style, x + (180 - w) / 2, y, w, h));
      y += h + 50;
      height = Math.max(height, y);
    }
    width = x + 240;
  });
  // an arrow to a later column leaves a box on its right and enters the next on
  // its left, so it runs in the gap between the columns, not through a box
  const forward = (e) => col.get(e.to) > col.get(e.from);
  edges.forEach((e, i) => cells.push(edge(`e${i + 1}`, e.label, `edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;html=1;labelBackgroundColor=default;endArrow=block;endFill=1;${forward(e) ? 'exitX=1;exitY=0.5;exitDx=0;exitDy=0;entryX=0;entryY=0.5;entryDx=0;entryDy=0;' : ''}${e.dashed ? 'dashed=1;' : ''}`, `n_${e.from}`, `n_${e.to}`)));
  return { cells, width, height, boxes: nodes.size, arrows: edges.length };
}

// ------------------------------------------------------------------ sequence

export function parseSequence(blockLines) {
  const parts = new Map();
  const steps = [];
  const add = (id, as = id, kind = 'participant') => {
    if (!parts.has(id)) parts.set(id, { id, label: as, actor: kind === 'actor' });
  };
  for (const raw of blockLines) {
    const l = raw.trim();
    if (!l || /^sequenceDiagram\b/.test(l)) continue;
    let m;
    if ((m = /^(participant|actor)\s+(\w+)(?:\s+as\s+(.+))?$/.exec(l))) add(m[2], m[3] || m[2], m[1]);
    else if ((m = /^(\w+)\s*(-->>|->>|-->|->)\s*(\w+)\s*:\s*(.*)$/.exec(l))) {
      add(m[1]);
      add(m[3]);
      steps.push({ kind: 'message', from: m[1], to: m[3], text: m[4], reply: m[2].startsWith('--') });
    } else if ((m = /^Note\s+(?:over|left of|right of)\s+([\w,]+)\s*:\s*(.*)$/i.exec(l))) {
      const over = m[1].split(',');
      for (const o of over) add(o);
      steps.push({ kind: 'note', over, text: m[2] });
    }
  }
  return { parts: [...parts.values()], steps };
}

function sequenceCells(blockLines) {
  const { parts, steps } = parseSequence(blockLines);
  const COL = 200;
  const TOP = 20;
  const HEAD = 40;
  const ROW = 44;
  const x0 = (i) => 20 + i * COL;
  const cx = new Map(parts.map((p, i) => [p.id, x0(i) + 80]));
  const height = HEAD + 30 + steps.length * ROW + 30;
  const cells = parts.map((p, i) => vertex(`p_${p.id}`, htmlValue(p.label), `shape=umlLifeline;perimeter=lifelinePerimeter;whiteSpace=wrap;html=1;container=0;collapsible=0;recursiveResize=0;outlineConnect=0;size=${HEAD};${p.actor ? 'rounded=1;fontStyle=1;' : ''}`, x0(i), TOP, 160, height));
  steps.forEach((s, i) => {
    const y = TOP + HEAD + 30 + i * ROW;
    if (s.kind === 'note') {
      const xs = s.over.map((o) => cx.get(o));
      const left = Math.min(...xs) - 70;
      const w = Math.max(...xs) - Math.min(...xs) + 140;
      cells.push(vertex(`s${i + 1}`, htmlValue(s.text), 'shape=note;whiteSpace=wrap;html=1;size=10;fillColor=#fff2cc;strokeColor=#d6b656;', left, y - 16, w, 32));
      return;
    }
    const style = `html=1;verticalAlign=bottom;labelBackgroundColor=default;${s.reply ? 'dashed=1;endArrow=open;endFill=0;' : 'endArrow=block;endFill=1;'}`;
    const a = cx.get(s.from);
    const b = cx.get(s.to);
    if (a === b) cells.push(freeEdge(`s${i + 1}`, htmlValue(s.text), style, a, y - 10, a, y + 10, [[a + 50, y - 10], [a + 50, y + 10]]));
    else cells.push(freeEdge(`s${i + 1}`, htmlValue(s.text), style, a, y, b, y));
  });
  return { cells, width: x0(parts.length) + 20, height: TOP + height + 20, boxes: parts.length, arrows: steps.filter((s) => s.kind === 'message').length };
}

// ------------------------------------------------------------------ ER

export function parseEr(blockLines) {
  const tables = new Map();
  const rels = [];
  let cur = null;
  for (const raw of blockLines) {
    const l = raw.trim();
    if (!l || /^erDiagram\b/.test(l)) continue;
    let m;
    if (cur) {
      if (l === '}') cur = null;
      else if ((m = /^(\S+)\s+(\S+)(?:\s+(PK|FK|UK))?/.exec(l))) cur.columns.push({ name: m[2], key: m[3] || null });
      continue;
    }
    if ((m = /^(\S+)\s*\{$/.exec(l))) {
      cur = { id: m[1], columns: [] };
      tables.set(m[1], cur);
    } else if ((m = /^(\S+)\s+([|o}{]{2})(--|\.\.)([|o}{]{2})\s+(\S+)\s*:\s*"?([^"]*)"?$/.exec(l))) {
      rels.push({ one: m[1], many: m[5], label: m[6], dashed: m[3] === '..' });
      for (const t of [m[1], m[5]]) if (!tables.has(t)) tables.set(t, { id: t, columns: [] });
    }
  }
  return { tables: [...tables.values()], rels };
}

function erCells(blockLines) {
  const { tables, rels } = parseEr(blockLines);
  const PER_ROW = 4;
  const W = 220;
  const HEAD = 26;
  const ROW = 22;
  const cells = [];
  let y = 40;
  let width = 0;
  for (let r = 0; r * PER_ROW < tables.length; r++) {
    const row = tables.slice(r * PER_ROW, (r + 1) * PER_ROW);
    let tall = 0;
    row.forEach((t, i) => {
      const x = 40 + i * (W + 80);
      const h = HEAD + Math.max(1, t.columns.length) * ROW;
      cells.push(vertex(`t_${t.id}`, t.id, 'swimlane;fontStyle=1;childLayout=stackLayout;horizontal=1;startSize=26;horizontalStack=0;resizeParent=1;resizeParentMax=0;resizeLast=0;collapsible=1;marginBottom=0;html=1;', x, y, W, h));
      t.columns.forEach((c, k) => cells.push(vertex(`t_${t.id}_c${k + 1}`, `${c.name}${c.key ? ` (${c.key})` : ''}`, `text;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;spacingLeft=4;spacingRight=4;overflow=hidden;rotatable=0;html=1;${c.key === 'PK' ? 'fontStyle=1;' : ''}`, 0, HEAD + k * ROW, W, ROW, `t_${t.id}`)));
      tall = Math.max(tall, h);
      width = Math.max(width, x + W + 40);
    });
    y += tall + 60;
  }
  rels.forEach((r, i) => cells.push(edge(`r${i + 1}`, r.label, `edgeStyle=entityRelationEdgeStyle;html=1;labelBackgroundColor=default;startArrow=ERmandOne;startFill=0;endArrow=ERzeroToMany;endFill=0;${r.dashed ? 'dashed=1;' : ''}`, `t_${r.one}`, `t_${r.many}`)));
  return { cells, width, height: y, boxes: tables.length, arrows: rels.length };
}

// ------------------------------------------------------------------ file

function pageXml(name, n, d) {
  const w = Math.max(1100, Math.ceil(d.width / 10) * 10);
  const h = Math.max(850, Math.ceil(d.height / 10) * 10);
  return [
    `  <diagram id="page-${n}" name="${xmlEsc(name)}">`,
    `    <mxGraphModel grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="${w}" pageHeight="${h}" math="0" shadow="0">`,
    '      <root>',
    '        <mxCell id="0"/>',
    '        <mxCell id="1" parent="0"/>',
    ...d.cells.map((c) => `        ${c}`),
    '      </root>',
    '    </mxGraphModel>',
    '  </diagram>',
  ].join('\n');
}

// The .drawio text for a diagram's Markdown, or null when it holds no Mermaid.
// The same Markdown always gives the same text.
export function toDrawio(md) {
  const blocks = mermaidBlocks(md);
  if (!blocks.length) return null;
  const names = new Map();
  const pages = blocks.map((b, i) => {
    const kind = kindOf(b.lines);
    const d = kind === 'flowchart' ? flowchartCells(b.lines) : kind === 'sequence' ? sequenceCells(b.lines) : kind === 'er' ? erCells(b.lines) : { cells: [vertex('note', 'This diagram type is shown only in the Markdown file.', 'text;html=1;', 40, 40, 400, 40)], width: 480, height: 120 };
    let name = b.title.length > 60 ? `${b.title.slice(0, 57)}...` : b.title;
    const seen = names.get(name) || 0;
    names.set(name, seen + 1);
    if (seen) name = `${name} (${seen + 1})`;
    return pageXml(name, i + 1, d);
  });
  return `<mxfile host="tech-plugin">\n${pages.join('\n')}\n</mxfile>\n`;
}

// Writes <name>.drawio beside the Markdown diagram <relMd> (a path inside
// sdlc-docs/). Returns { file, written, kept, newFile, removed }:
//   kept     someone changed <name>.drawio since the plugin wrote it, so it is
//            left alone and the new drawing is in newFile (<name>.new.drawio)
//   removed  the diagram has no Mermaid any more, and the plugin's own
//            unchanged .drawio was deleted
export function writeDrawio(home, relMd, md) {
  const D = docsDir(home);
  const dir = path.dirname(relMd);
  const base = path.basename(relMd, '.md');
  const name = `${base}.drawio`;
  const rel = path.join(dir, name);
  const relNew = path.join(dir, `${base}.new.drawio`);
  const storeRel = path.join(dir, DRAWIO_STORE);
  const store = readJson(path.join(D, storeRel)) || {};
  const f = path.join(D, rel);
  const existing = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
  const edited = existing !== null && sha(existing) !== store[name];
  const xml = toDrawio(md);
  const out = { file: rel, written: false, kept: false, newFile: null, removed: false };
  if (!xml) {
    if (existing !== null && !edited) {
      fs.rmSync(f, { force: true });
      out.removed = true;
    }
    if (!edited) delete store[name];
  } else if (edited && existing !== xml) {
    writeDocs(home, relNew, xml);
    out.kept = true;
    out.newFile = relNew;
  } else {
    if (existing !== xml) writeDocs(home, rel, xml);
    store[name] = sha(xml);
    out.written = true;
    fs.rmSync(path.join(D, relNew), { force: true });
  }
  writeDocs(home, storeRel, JSON.stringify(store, null, 1) + '\n');
  return out;
}

// Whether a diagram's Markdown has Mermaid but no .drawio beside it.
export function drawioMissing(home, relMd) {
  const f = path.join(docsDir(home), relMd);
  if (!fs.existsSync(f) || !fs.readFileSync(f, 'utf8').includes('```mermaid')) return false;
  return !fs.existsSync(f.replace(/\.md$/, '.drawio'));
}
