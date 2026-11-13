#!/usr/bin/env node
// /tech-plugin:sync helpers.
//
//   node sync.mjs status  --home HOME           JSON: stops with "run breakdown --refresh"
//                                               when the code map is stale; otherwise one row
//                                               per out-of-date document, diagram set or batch
//                                               of business documents, and the portal state
//   node sync.mjs sources --home HOME           business documents from the folders listed in
//                                               system.yaml (docs:): .md and .txt are copied
//                                               to sdlc-docs/sources/; for other files it
//                                               prints the conversion command (never runs it);
//                                               hashes go to _state/sources.json
//   node sync.mjs portal  --home HOME [--force] rebuilds sdlc-docs/portal/ when what it shows
//                                               changed
//
// Writes only below <home>/sdlc-docs/. Reads nothing secret.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginUpdate } from '../lib/version.mjs';
import { PLUGIN_ROOT, docsDir, fail, isSecretFor, parseArgs, readJson, real, writeDocs } from '../breakdown/common.mjs';
import { loadSystemYaml } from '../breakdown/load.mjs';
import { loadExisting } from '../breakdown/modules.mjs';
import { status as breakdownStatus } from '../breakdown/state.mjs';
import { DOCS_ORDER, NEEDS, buildFacts, docInfo } from '../document/doc.mjs';
import { diagRel, diagramState } from '../diagram/diagram.mjs';
import { systemState } from '../diagram/system.mjs';
import { buildPortal, portalState } from './portal.mjs';

const SOURCES_STATE = path.join('_state', 'sources.json');
const TEXT = /\.(md|markdown|txt)$/i;
const MAX_FILES = 5000;

// ------------------------------------------------------------------ business documents

function walk(dir, isSecret) {
  const out = [];
  const stack = [''];
  while (stack.length && out.length < MAX_FILES) {
    const r = stack.pop();
    let ents = [];
    try {
      ents = fs.readdirSync(path.join(dir, r), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const rel = r ? `${r}/${e.name}` : e.name;
      if (e.isDirectory()) stack.push(rel);
      else if (e.isFile() && !isSecret(e.name)) out.push(rel);
    }
  }
  return out.sort();
}

const fileHash = (p) => crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex').slice(0, 16);
const mtime = (p) => {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return -1;
  }
};

export function scanSources(home) {
  const D = docsDir(home);
  const st = readJson(path.join(D, SOURCES_STATE)) || { files: {} };
  const isSecret = isSecretFor(null);
  const y = loadSystemYaml(home);
  const folders = (Array.isArray(y.docs) ? y.docs : []).map((d) => (d && typeof d === 'object' ? d.path : d)).filter(Boolean).map(String);
  const items = [];
  const missing = [];
  const targets = new Set();
  for (const folder of folders) {
    const abs = path.resolve(home, folder);
    if (!fs.existsSync(abs)) {
      missing.push(folder);
      continue;
    }
    const name = path.basename(abs);
    for (const rel of walk(abs, isSecret)) {
      const src = path.join(abs, rel);
      const key = `${name}/${rel}`;
      const text = TEXT.test(rel);
      const target = path.posix.join('sources', name, text ? rel : `${rel}.md`);
      targets.add(target);
      const hash = fileHash(src);
      const prev = st.files[key];
      let state;
      if (text) state = !prev ? 'new' : prev.hash !== hash || !fs.existsSync(path.join(D, target)) ? 'changed' : 'current';
      else if (mtime(path.join(D, target)) < mtime(src)) state = 'to-convert';
      else state = !prev || prev.hash !== hash ? 'converted' : 'current';
      items.push({ key, src, target, hash, text, state });
    }
  }
  // files people put straight into sdlc-docs/sources/
  const own = path.join(D, 'sources');
  if (fs.existsSync(own)) {
    for (const rel of walk(own, isSecret)) {
      const target = `sources/${rel}`;
      if (targets.has(target)) continue;
      const key = `sources/${rel}`;
      const hash = fileHash(path.join(own, rel));
      const prev = st.files[key];
      items.push({ key, src: path.join(own, rel), target, hash, text: TEXT.test(rel), own: true, state: !prev ? 'new' : prev.hash !== hash ? 'changed' : 'current' });
    }
  }
  const count = (s) => items.filter((x) => x.state === s).length;
  return { folders, missing, items, counts: { new: count('new'), changed: count('changed'), toConvert: count('to-convert'), converted: count('converted'), current: count('current') }, state: st };
}

export function syncSources(home) {
  const D = docsDir(home);
  const scan = scanSources(home);
  const files = { ...scan.state.files };
  const copied = [];
  const toConvert = [];
  const pickedUp = [];
  for (const x of scan.items) {
    if (x.state === 'current') continue;
    if (x.state === 'to-convert') {
      fs.mkdirSync(path.dirname(path.join(D, x.target)), { recursive: true });
      toConvert.push({ file: x.key, command: `uvx markitdown "${x.src}" -o "${path.join(D, x.target)}"` });
      continue;
    }
    if (x.text && !x.own) {
      writeDocs(home, x.target, fs.readFileSync(x.src));
      copied.push(x.key);
    } else pickedUp.push(x.key);
    files[x.key] = { hash: x.hash, target: x.target, at: new Date().toISOString() };
  }
  writeDocs(home, SOURCES_STATE, JSON.stringify({ schema: 1, files }, null, 1) + '\n');
  return { folders: scan.folders.length, missing: scan.missing, copied, pickedUp, toConvert, unchanged: scan.counts.current };
}

// ------------------------------------------------------------------ status

function docState(home, id, doc, pack) {
  const d = docInfo(home, id, doc);
  if (!d.exists) return null;
  if (d.broken) return { state: 'broken', status: null, why: d.broken };
  if (d.front.facts !== pack.hash) return { state: 'facts-changed', status: d.status, why: 'the code facts changed' };
  const stale = NEEDS[doc].filter((n) => {
    const nd = docInfo(home, id, n);
    return nd.exists && d.front.inputs && d.front.inputs[n] !== nd.hash;
  });
  if (stale.length) return { state: 'input-changed', status: d.status, why: `${stale.join(' and ')} changed since it was written` };
  return { state: 'up-to-date', status: d.status };
}

export function status(home) {
  const upd = pluginUpdate(PLUGIN_ROOT);
  if (upd) return { next: 'restart', message: upd.message };
  const bd = breakdownStatus(home);
  if (bd.next !== 'up-to-date') return { next: 'breakdown', message: `Run /tech-plugin:breakdown --refresh first: ${bd.message} Documents and diagrams are refreshed from the code map, so it must be current.` };
  const my = loadExisting(home);
  if (!my || !Array.isArray(my.modules)) fail('no approved modules.yaml yet: run /tech-plugin:breakdown first');
  const D = docsDir(home);
  const rows = [];
  const current = [];
  const idle = [];
  const add = (r) => rows.push({ n: rows.length + 1, ...r });
  for (const m of my.modules) {
    const docs = DOCS_ORDER.filter((d) => docInfo(home, m.id, d).exists);
    const drawn = fs.existsSync(path.join(D, diagRel(m.id, '_stamp.json')));
    if (!docs.length && !drawn) {
      idle.push(m.id);
      continue;
    }
    const pack = buildFacts(home, m.id);
    for (const doc of docs) {
      const s = docState(home, m.id, doc, pack);
      if (s.state === 'up-to-date') {
        current.push(`${m.id} ${doc}`);
        continue;
      }
      const signed = s.status === 'Approved' || s.status === 'Reviewed';
      add({ module: m.id, item: doc, state: s.state, why: s.why, status: s.status, action: s.state === 'broken' ? 'fix the stamp by hand' : 'rewrite', warn: signed ? `${doc} is ${s.status}: rewriting makes it a Draft again, to be approved again with /tech-plugin:validate ${m.id}` : null });
    }
    if (drawn) {
      const s = diagramState(home, m.id, pack.hash);
      if (s.state === 'up-to-date') current.push(`${m.id} diagrams`);
      else add({ module: m.id, item: 'diagrams', state: s.state, why: s.reasons.join('; '), status: null, action: 'redraw', warn: null });
    }
  }
  if (fs.existsSync(path.join(D, 'system', 'diagrams', '_stamp.json'))) {
    const s = systemState(home);
    if (s.state === 'up-to-date') current.push('system diagrams');
    else add({ module: 'system', item: 'diagrams', state: s.state, why: s.reasons.join('; '), status: null, action: 'redraw', warn: null });
  }
  const src = scanSources(home);
  const c = src.counts;
  if (c.new || c.changed || c.toConvert || c.converted || src.missing.length) {
    add({ module: '-', item: 'business documents', state: 'new or changed', why: [c.new && `${c.new} new`, c.changed && `${c.changed} changed`, c.converted && `${c.converted} converted`, c.toConvert && `${c.toConvert} to convert to Markdown`, src.missing.length && `folder not found: ${src.missing.join(', ')}`].filter(Boolean).join(', '), status: null, action: 'pick up', warn: null });
  }
  const portal = portalState(home);
  return {
    next: rows.length ? 'choose' : 'up-to-date',
    rows,
    current,
    notStarted: idle,
    portal,
    message: rows.length ? `${rows.length} item(s) out of date.` : `Already up to date: every document and diagram matches the code${portal.state === 'up-to-date' ? ', and the portal is current' : `; the portal is ${portal.state}`}.`,
  };
}

function main() {
  const [cmd] = process.argv.slice(2);
  const a = parseArgs(process.argv.slice(3), ['force']);
  if (!a.home) fail('usage: sync.mjs <status|sources|portal> --home HOME [--force]');
  const home = real(a.home);
  if (!fs.existsSync(docsDir(home))) fail(`${home} has no sdlc-docs/; run /tech-plugin:breakdown first`);
  const out = (x) => process.stdout.write(JSON.stringify(x, null, 2) + '\n');
  if (cmd === 'status') return out(status(home));
  const upd = pluginUpdate(PLUGIN_ROOT);
  if (upd) fail(upd.message);
  if (cmd === 'sources') return out(syncSources(home));
  if (cmd === 'portal') return out(buildPortal(home, { force: !!a.force }));
  fail('usage: sync.mjs <status|sources|portal> --home HOME [--force]');
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) main();
