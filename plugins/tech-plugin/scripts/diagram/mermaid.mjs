// Small helpers shared by the diagram scripts: Mermaid ids and labels that
// cannot break a diagram, the evidence tables of the documents, and the
// "repo:path:lines" citations in them.

import crypto from 'node:crypto';
import { splitDoc } from '../lib/frontmatter.mjs';

// A Mermaid node id from any text.
export const nid = (prefix, s) => `${prefix}_${String(s).replace(/[^A-Za-z0-9_]/g, '_')}`;

// Node ids for one diagram: the same text always gets the same id, and two
// texts that nid() would merge ("admin.users", "admin_users") get different
// ones (the later one gets "_2"). Register in a fixed order for stable ids.
export function idRegistry(make = nid) {
  const byKey = new Map();
  const used = new Set();
  return (prefix, s) => {
    const k = `${prefix}\u0000${s}`;
    if (byKey.has(k)) return byKey.get(k);
    const base = make(prefix, s);
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}_${n}`;
    used.add(id);
    byKey.set(k, id);
    return id;
  };
}

// Text inside ["..."]: no double quotes, no markup.
export const label = (s) =>
  String(s ?? '')
    .replace(/"/g, "'")
    .replace(/[<>{}[\]|#;`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// Text after ":" in a sequence message or an ER relation.
export const msg = (s) =>
  String(s ?? '')
    .replace(/[;#"`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);

// Cells of one Markdown table row, honouring "\|".
export function cells(line) {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return t.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

// The lines of one "## " section, by its heading prefix.
export function section(body, headingStart) {
  const lines = body.split('\n');
  const i = lines.findIndex((l) => l.startsWith(`## ${headingStart}`));
  if (i === -1) return [];
  let j = i + 1;
  while (j < lines.length && !/^## /.test(lines[j])) j++;
  return lines.slice(i + 1, j);
}

// Appendix A of a document: E<n> -> source cell.
export function evidenceOf(text) {
  const body = splitDoc(text).body;
  const out = new Map();
  for (const l of section(body, 'Appendix A')) {
    if (!/^\|\s*E\d+\s*\|/.test(l)) continue;
    const c = cells(l);
    out.set(c[0], c[2] || '');
  }
  return out;
}

// `repo:path:12-14,20` citations in a text -> [{ repo, file, ranges: [[a, b]] }].
export function citesIn(text) {
  const out = [];
  for (const m of String(text).matchAll(/`([^`\s:]+):([^`\s:]+):([\d,\s-]+)`/g)) {
    const ranges = m[3]
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => {
        const [a, b] = x.split('-').map(Number);
        return [a, Number.isFinite(b) ? b : a];
      })
      .filter(([a]) => Number.isFinite(a));
    out.push({ repo: m[1], file: m[2], ranges });
  }
  return out;
}

// The citations behind evidence tags, following "spec E3" / "brd E4" one step.
export function resolveTags(tags, ev, others = {}) {
  const out = [];
  for (const t of tags) {
    const src = ev.get(t);
    if (!src) continue;
    out.push(...citesIn(src));
    for (const m of src.matchAll(/\b(spec|brd) (E\d+)\b/g)) {
      const o = others[m[1]];
      if (o && o.get(m[2])) out.push(...citesIn(o.get(m[2])));
    }
  }
  return out;
}

export const tagsIn = (text) => [...new Set([...String(text).matchAll(/\[(E\d+)\]/g)].map((m) => m[1]))];

// "repo:path:line" (one line) -> { repo, file, line }.
export function oneCite(c) {
  const m = /^([^:]+):(.+):(\d+)$/.exec(String(c || ''));
  return m ? { repo: m[1], file: m[2], line: Number(m[3]) } : null;
}

export const hits = (cite, repo, file, from, to) => cite.repo === repo && cite.file === file && cite.ranges.some(([a, b]) => a <= to && b >= from);
