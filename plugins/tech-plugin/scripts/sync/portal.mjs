// The docs portal: static HTML pages in <home>/sdlc-docs/portal/, opened
// straight from disk (file://). Built from the Markdown that people read: the
// system overview and diagrams, the module catalogue, each module's scope
// card, documents and diagrams, and the glossary. Never from _state/, _map/
// or the fact packs.
//
// WHY its own Markdown renderer: no dependencies to install, and every raw
// HTML character in a document is escaped, so a document cannot inject a
// script into the page. Mermaid comes from one pinned CDN URL; offline, the
// diagram's source text is shown instead.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { bodyHash, splitDoc } from '../lib/frontmatter.mjs';
import { docsDir, readJson, today, writeDocs } from '../breakdown/common.mjs';
import { loadSystemYaml } from '../breakdown/load.mjs';
import { loadExisting } from '../breakdown/modules.mjs';
import { cells } from '../diagram/mermaid.mjs';

export const PORTAL_VERSION = 1;
export const MERMAID_URL = 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js';
const STATE = path.join('_state', 'portal.json');
const OUT = 'portal';
const DOCS = ['spec', 'brd', 'prd'];
const DOC_TITLES = { spec: 'How it works (functional spec)', brd: 'Business requirements (BRD)', prd: 'Product requirements (PRD)' };
const TECH = new Set(['sequences.md', 'er.md', 'profile.md']);

// ------------------------------------------------------------------ Markdown

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/&[a-z#0-9]+;/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80);

// link(href) -> a safe href, or null to show the text without a link
function inline(text, link) {
  const codes = [];
  let t = String(text).replace(/`([^`]+)`/g, (_, c) => {
    codes.push(`<code>${esc(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  t = esc(t);
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (all, txt, href) => {
    const h = link(href.replace(/&amp;/g, '&'));
    return h ? `<a href="${esc(h)}"${/^https?:/i.test(h) ? ' rel="noopener noreferrer"' : ''}>${txt}</a>` : txt;
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>');
  t = t.replace(/(^|[^\w])_([^_\s][^_]*?)_(?!\w)/g, '$1<em>$2</em>');
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
}

export function renderMarkdown(md, link = () => null) {
  const lines = String(md).replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const out = [];
  let para = [];
  let mermaid = false;
  const flush = () => {
    if (!para.length) return;
    out.push(`<p>${para.map((l, i) => inline(l.trim(), link) + (i < para.length - 1 && / {2,}$/.test(l) ? '<br>' : '')).join('\n')}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const fence = /^\s*```\s*([\w-]*)\s*$/.exec(l);
    if (fence) {
      flush();
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      if (fence[1] === 'mermaid') {
        mermaid = true;
        out.push(`<pre class="mermaid">${esc(body.join('\n'))}</pre>`);
      } else out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    if (h) {
      flush();
      const n = h[1].length;
      out.push(`<h${n} id="${slug(h[2])}">${inline(h[2], link)}</h${n}>`);
      continue;
    }
    if (/^\s*\|/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      flush();
      const head = cells(l);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      i--;
      out.push(`<div class="table"><table><thead><tr>${head.map((c) => `<th>${inline(c, link)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c, link)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^\s*>/.test(l)) {
      flush();
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      i--;
      const inner = renderMarkdown(q.join('\n'), link);
      out.push(`<blockquote>${inner.html}</blockquote>`);
      mermaid = mermaid || inner.mermaid;
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
      flush();
      const items = [];
      while (i < lines.length && (/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (m) items.push({ indent: m[1].length, ordered: /\d/.test(m[2]), text: m[3] });
        else items[items.length - 1].text += ' ' + lines[i].trim();
        i++;
      }
      i--;
      out.push(listHtml(items, link));
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) {
      flush();
      out.push('<hr>');
      continue;
    }
    if (!l.trim()) {
      flush();
      continue;
    }
    para.push(l);
  }
  flush();
  return { html: out.join('\n'), mermaid };
}

function listHtml(items, link) {
  let html = '';
  const stack = [];
  for (const it of items) {
    while (stack.length && it.indent < stack[stack.length - 1].indent) html += `</li></${stack.pop().tag}>`;
    const top = stack[stack.length - 1];
    if (!top || it.indent > top.indent) {
      const tag = it.ordered ? 'ol' : 'ul';
      stack.push({ indent: it.indent, tag });
      html += `<${tag}><li>`;
    } else html += '</li><li>';
    html += inline(it.text, link);
  }
  while (stack.length) html += `</li></${stack.pop().tag}>`;
  return html;
}

// ------------------------------------------------------------------ inputs

export function portalInputs(home) {
  const D = docsDir(home);
  const my = loadExisting(home);
  const mods = (my && my.modules) || [];
  const list = [];
  const add = (rel, kind, extra = {}) => {
    if (fs.existsSync(path.join(D, rel))) list.push({ rel: rel.split(path.sep).join('/'), kind, ...extra });
  };
  add('system/overview.md', 'page');
  for (const f of ['module-map.md', 'block.md', 'journeys.md']) add(`system/diagrams/${f}`, 'diagram');
  add('modules/README.md', 'page');
  for (const m of mods) {
    add(`modules/${m.id}/module.md`, 'module', { module: m.id });
    for (const d of DOCS) add(`modules/${m.id}/${d}.md`, 'doc', { module: m.id, doc: d });
    add(`modules/${m.id}/diagrams/flowchart.md`, 'diagram', { module: m.id });
    for (const f of ['sequences.md', 'er.md']) add(`modules/${m.id}/diagrams/${f}`, 'tech', { module: m.id });
  }
  add('glossary.md', 'page');
  add('profile.md', 'tech');
  return list;
}

export function portalHash(home, inputs = portalInputs(home)) {
  const D = docsDir(home);
  const h = crypto.createHash('sha1').update(`v${PORTAL_VERSION}\n`);
  // only what the pages show from modules.yaml and system.yaml
  const my = loadExisting(home);
  const sys = loadSystemYaml(home);
  h.update(JSON.stringify({ modules: ((my && my.modules) || []).map((m) => [m.id, m.name, m.purpose || null]), name: (sys.system && sys.system.name) || null, product: (sys.business && sys.business.product) || null }) + '\n');
  for (const x of inputs) h.update(`${x.rel}\n`).update(fs.readFileSync(path.join(D, x.rel)));
  return h.digest('hex').slice(0, 16);
}

export function portalState(home) {
  const st = readJson(path.join(docsDir(home), STATE));
  if (!st) return { state: 'missing', builtAt: null };
  const ok = st.hash === portalHash(home) && (st.files || []).every((f) => fs.existsSync(path.join(docsDir(home), OUT, f)));
  return { state: ok ? 'up-to-date' : 'stale', builtAt: st.builtAt || null };
}

// ------------------------------------------------------------------ pages

const htmlOf = (rel) => rel.replace(/\.md$/, '.html');
const relFrom = (fromRel, toRel) => {
  const r = path.posix.relative(path.posix.dirname(fromRel), toRel);
  return r || path.posix.basename(toRel);
};

function linker(fromMd, known) {
  return (href) => {
    if (/^https?:\/\//i.test(href)) return href;
    if (/^#[\w-]*$/.test(href)) return href;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
    const [p, anchor] = href.split('#');
    if (!p) return null;
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(fromMd), p));
    if (!known.has(target)) return null;
    return relFrom(htmlOf(fromMd), htmlOf(target)) + (anchor ? `#${anchor}` : '');
  };
}

function statusLine(text) {
  const p = splitDoc(text);
  const f = p.front;
  if (!f) return null;
  const hash = bodyHash(p.body);
  const ck = f.checked && f.checked.hash === hash ? f.checked : null;
  const ap = f.approvals || {};
  let s = 'Draft, not checked yet';
  if (f.status === 'Checked' && ck) s = `Checked on ${ck.on}${ck.known ? ` · ${ck.known} known issue(s)` : ''}`;
  // signed off by the two-layer sign-off of tech-plugin 0.5 and earlier
  else if (f.status === 'Approved' && [ap.people, ap.technical].every((x) => x && x.by && x.hash === hash)) s = `Approved by ${ap.people.by} (${ap.people.role}) and ${ap.technical.by} (${ap.technical.role})`;
  return `Status: ${s}${f.date ? ` · written ${f.date}` : ''}`;
}

// Splits a body into what everyone reads and the "For developers" fold.
function segments(body, x) {
  if (x.kind === 'tech') return [{ md: body, fold: false }];
  const lines = body.split('\n');
  const at = (re) => lines.findIndex((l) => re.test(l));
  if (x.kind === 'doc') {
    const a = at(/^## Appendix A\b/);
    if (a === -1) return [{ md: body, fold: false }];
    let c = at(/^## Document control\b/);
    if (c < a) c = lines.length;
    return [
      { md: lines.slice(0, a).join('\n'), fold: false },
      { md: lines.slice(a, c).join('\n'), fold: true, summary: 'For developers: evidence and technical detail' },
      { md: lines.slice(c).join('\n'), fold: false },
    ];
  }
  const d = at(/^## (For developers|Arrows and their evidence)\b/);
  if (d === -1) return [{ md: body, fold: false }];
  return [
    { md: lines.slice(0, d).join('\n'), fold: false },
    { md: lines.slice(d + 1).join('\n'), fold: true, summary: 'For developers: sources and evidence' },
  ];
}

export const CSS = `:root{--bg:#fbfbf9;--fg:#1d2329;--muted:#5d6670;--line:#dfe2e6;--card:#ffffff;--accent:#1f6f8b;--accent-bg:#e8f2f5;--code:#f1f2f4}
@media (prefers-color-scheme: dark){:root{--bg:#15191d;--fg:#e4e7ea;--muted:#9aa3ad;--line:#2d343b;--card:#1c2126;--accent:#7cc4dc;--accent-bg:#1d3038;--code:#232a31}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.wrap{display:flex;min-height:100vh}
nav{width:260px;flex:none;border-right:1px solid var(--line);padding:20px 16px;font-size:14px;position:sticky;top:0;height:100vh;overflow:auto;background:var(--card)}
nav h2{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:18px 0 6px}
nav a{display:block;color:var(--fg);text-decoration:none;padding:3px 6px;border-radius:6px}nav a:hover,nav a.here{background:var(--accent-bg);color:var(--accent)}
nav .home{font-weight:600;font-size:15px}
main{flex:1;min-width:0;padding:28px 40px;max-width:1000px}
a{color:var(--accent)}h1{font-size:28px;line-height:1.25;margin:0 0 16px}h2{margin-top:32px;font-size:21px}h3{font-size:17px}
.status{display:inline-block;background:var(--accent-bg);color:var(--accent);border-radius:6px;padding:4px 10px;font-size:13px;margin-bottom:12px}
blockquote{margin:16px 0;padding:10px 16px;border-left:4px solid var(--accent);background:var(--card);border-radius:0 8px 8px 0}
blockquote p{margin:6px 0}
.table{overflow-x:auto;margin:12px 0}table{border-collapse:collapse;width:100%;font-size:14px}th,td{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{background:var(--card)}
code{background:var(--code);padding:1px 5px;border-radius:4px;font-size:.88em;word-break:break-word}pre{background:var(--code);padding:12px;border-radius:8px;overflow-x:auto}pre code{background:none;padding:0}
pre.mermaid{background:var(--card);border:1px solid var(--line);text-align:center}
.offline pre.mermaid{text-align:left;white-space:pre-wrap;font-size:13px}.offline pre.mermaid::before{content:"This diagram needs an internet connection to be drawn. Its text is shown instead.";display:block;font-family:inherit;color:var(--muted);margin-bottom:8px}
details.dev{margin:24px 0;border:1px solid var(--line);border-radius:8px;padding:8px 16px;background:var(--card)}details.dev>summary{cursor:pointer;font-weight:600;color:var(--muted)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin:16px 0}.card{border:1px solid var(--line);border-radius:8px;padding:12px 14px;background:var(--card)}.card a{font-weight:600}
footer{margin-top:40px;color:var(--muted);font-size:13px}
@media (max-width:760px){.wrap{display:block}nav{width:auto;height:auto;position:static;border-right:0;border-bottom:1px solid var(--line)}main{padding:20px 16px}}`;

function navHtml(here, inputs, mods, sysName) {
  const known = new Map(inputs.map((x) => [x.rel, x]));
  const a = (rel, text) => (rel === 'index.md' || known.has(rel) ? `<a href="${esc(relFrom(htmlOf(here), htmlOf(rel)))}"${rel === here ? ' class="here"' : ''}>${esc(text)}</a>` : '');
  const L = [`<a class="home" href="${esc(relFrom(htmlOf(here), 'index.html'))}">${esc(sysName)}</a>`, '<h2>The system</h2>', a('system/overview.md', 'Overview'), a('system/diagrams/block.md', 'Apps and services'), a('system/diagrams/journeys.md', 'Key journeys'), a('system/diagrams/module-map.md', 'Module map'), a('glossary.md', 'Glossary'), '<h2>Modules</h2>', a('modules/README.md', 'All modules')];
  for (const m of mods) L.push(a(`modules/${m.id}/module.md`, m.name));
  L.push('<h2>For developers</h2>', a('profile.md', 'Project profile'));
  return L.filter(Boolean).join('\n');
}

function page({ title, here, body, mermaid, inputs, mods, sysName }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
<nav>${navHtml(here, inputs, mods, sysName)}</nav>
<main>
${body}
<footer>Built by tech-plugin on ${today()} from the files in sdlc-docs/. Edit the Markdown files, not these pages: they are rebuilt.</footer>
</main>
</div>
${mermaid ? `<script src="${MERMAID_URL}"></script>
<script>(function(){var dark=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches;if(window.mermaid){window.mermaid.initialize({startOnLoad:true,securityLevel:'strict',theme:dark?'dark':'default'});}else{document.documentElement.className+=' offline';}})();</script>` : ''}
</body>
</html>
`;
}

function modulePanel(home, m, inputs, fromRel) {
  const D = docsDir(home);
  const have = new Set(inputs.map((x) => x.rel));
  const card = (rel, title, note) => (have.has(rel) ? `<div class="card"><a href="${esc(relFrom(htmlOf(fromRel), htmlOf(rel)))}">${esc(title)}</a><br><small>${esc(note)}</small></div>` : '');
  const main = [];
  for (const d of DOCS) {
    const rel = `modules/${m.id}/${d}.md`;
    if (!have.has(rel)) continue;
    const f = splitDoc(fs.readFileSync(path.join(D, rel), 'utf8')).front || {};
    main.push(card(rel, DOC_TITLES[d], f.status || 'Draft'));
  }
  main.push(card(`modules/${m.id}/diagrams/flowchart.md`, 'How people move through the screens', 'Diagram'));
  const dev = [card(`modules/${m.id}/diagrams/sequences.md`, 'Sequence diagrams', 'Technical'), card(`modules/${m.id}/diagrams/er.md`, 'Data (ER diagram)', 'Technical')].filter(Boolean);
  const L = ['<h2 id="documents-and-diagrams">Documents and diagrams</h2>'];
  if (main.some(Boolean)) L.push('<div class="cards">', ...main.filter(Boolean), '</div>');
  else L.push('<p>No documents or diagrams yet for this module: only its scope card, above.</p>');
  if (dev.length) L.push('<details class="dev"><summary>For developers: technical diagrams</summary><div class="cards">', ...dev, '</div></details>');
  return L.join('\n');
}

function indexBody(home, inputs, mods, sysName, system) {
  const D = docsDir(home);
  const have = new Set(inputs.map((x) => x.rel));
  const b = system.business || {};
  const card = (rel, title, note) => (have.has(rel) ? `<div class="card"><a href="${esc(htmlOf(rel))}">${esc(title)}</a><br><small>${esc(note)}</small></div>` : '');
  const L = [`<h1>${esc(sysName)}: documentation</h1>`];
  if (b.product) L.push(`<p>${esc(b.product)}</p>`);
  L.push('<p>Start with the overview, then open a module. Each module has a short scope card; the documented ones also have a spec, a BRD, a PRD and diagrams. Technical detail sits in the folds marked "For developers".</p>');
  L.push('<div class="cards">', card('system/overview.md', 'The system on one page', 'Overview'), card('system/diagrams/block.md', 'Apps and services', 'Diagram'), card('system/diagrams/journeys.md', 'Key journeys', 'Diagram'), card('system/diagrams/module-map.md', 'Module map', 'Diagram'), card('glossary.md', 'Glossary', 'Words and their meaning'), '</div>');
  L.push('<h2 id="modules">Modules</h2>', '<div class="table"><table><thead><tr><th>Module</th><th>What it does</th><th>Documents</th><th>Diagrams</th></tr></thead><tbody>');
  for (const m of mods) {
    const docs = DOCS.filter((d) => have.has(`modules/${m.id}/${d}.md`)).map((d) => `${d.toUpperCase()} ${(splitDoc(fs.readFileSync(path.join(D, `modules/${m.id}/${d}.md`), 'utf8')).front || {}).status || 'Draft'}`);
    const rel = `modules/${m.id}/module.md`;
    L.push(`<tr><td>${have.has(rel) ? `<a href="${esc(htmlOf(rel))}">${esc(m.name)}</a>` : esc(m.name)}</td><td>${esc(m.purpose || '')}</td><td>${esc(docs.join(', ') || 'scope card only')}</td><td>${have.has(`modules/${m.id}/diagrams/flowchart.md`) ? 'yes' : 'not drawn yet'}</td></tr>`);
  }
  L.push('</tbody></table></div>');
  return L.join('\n');
}

export function buildPortal(home, { force = false } = {}) {
  const D = docsDir(home);
  const inputs = portalInputs(home);
  const hash = portalHash(home, inputs);
  const st = readJson(path.join(D, STATE));
  const index = path.join(D, OUT, 'index.html');
  if (!force && st && st.hash === hash && (st.files || []).every((f) => fs.existsSync(path.join(D, OUT, f)))) return { built: false, pages: (st.files || []).length, index, message: 'Portal already up to date: nothing it shows has changed.' };
  const my = loadExisting(home);
  const mods = (my && my.modules) || [];
  const system = loadSystemYaml(home);
  const sysName = (system.system && system.system.name) || path.basename(home);
  const known = new Set(inputs.map((x) => x.rel));
  const files = [];
  for (const x of inputs) {
    const text = fs.readFileSync(path.join(D, x.rel), 'utf8');
    const p = splitDoc(text);
    const link = linker(x.rel, known);
    const parts = [];
    let mermaid = false;
    const badge = x.kind === 'doc' ? statusLine(text) : x.kind === 'tech' ? 'For developers: technical page' : null;
    for (const s of segments(p.body, x)) {
      const r = renderMarkdown(s.md, link);
      mermaid = mermaid || r.mermaid;
      if (!r.html.trim()) continue;
      parts.push(s.fold ? `<details class="dev"><summary>${esc(s.summary)}</summary>\n${r.html}\n</details>` : r.html);
    }
    if (x.kind === 'module') parts.push(modulePanel(home, mods.find((m) => m.id === x.module), inputs, x.rel));
    let body = parts.join('\n');
    if (badge) body = body.includes('</h1>') ? body.replace('</h1>', `</h1>\n<p class="status">${esc(badge)}</p>`) : `<p class="status">${esc(badge)}</p>\n${body}`;
    const title = (/^#\s+(.+)$/m.exec(p.body) || [null, x.rel])[1].replace(/[`*_]/g, '');
    const out = htmlOf(x.rel);
    writeDocs(home, path.join(OUT, out), page({ title: `${title} · ${sysName}`, here: x.rel, body, mermaid, inputs, mods, sysName }));
    files.push(out);
  }
  writeDocs(home, path.join(OUT, 'index.html'), page({ title: `${sysName}: documentation`, here: 'index.md', body: indexBody(home, inputs, mods, sysName, system), mermaid: false, inputs, mods, sysName }));
  files.push('index.html');
  // pages this build no longer makes (a module renamed, a document removed)
  const base = path.join(D, OUT);
  for (const f of (st && st.files) || []) {
    if (files.includes(f)) continue;
    const p = path.resolve(base, f);
    if (p.startsWith(base + path.sep) && fs.existsSync(p)) fs.rmSync(p);
  }
  writeDocs(home, STATE, JSON.stringify({ schema: 1, version: PORTAL_VERSION, hash, builtAt: new Date().toISOString(), files }, null, 1) + '\n');
  return { built: true, pages: files.length, index, message: `Portal built: ${files.length} pages. Open ${index} in a browser.` };
}
