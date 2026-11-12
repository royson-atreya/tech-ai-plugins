#!/usr/bin/env node
// /tech-plugin:document helpers.
//
//   node doc.mjs facts   <module> --home HOME     build the module's fact pack:
//                                                 modules/<id>/_facts.md + _facts.json
//   node doc.mjs status  <module> --home HOME     JSON: needs-first, critical/deep, and per
//                                                 document (spec, brd, prd): missing |
//                                                 up-to-date | facts-changed | input-changed,
//                                                 status and sign-offs; `next` = what to write
//   node doc.mjs prepare <module> <spec|brd|prd> --home HOME
//                                                 JSON for the writer agent: paths, the stamp
//                                                 to put on top, the IDs to keep; saves the
//                                                 previous version
//
// Scripts only: the same code gives the same fact pack, at no token cost.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bodyHash, splitDoc } from '../lib/frontmatter.mjs';
import { toYaml } from '../lib/yaml.mjs';
import { redact } from '../lib/redact.mjs';
import { makeReader } from '../lib/stacks.mjs';
import { listFiles, normUri, shapeOf, sourceCache, uniq } from '../lib/readers/common.mjs';
import { bladeLabels, genericMessages, laravelBehaviour, loadLang } from '../lib/readers/behaviour.mjs';
import { PLUGIN_ROOT, docsDir, fail, isSecretFor, parseArgs, readJson, real, today, writeDocs } from '../breakdown/common.mjs';
import { loadLinks, loadSystem } from '../breakdown/load.mjs';
import { loadExisting } from '../breakdown/modules.mjs';
import { loadState, status as breakdownStatus } from '../breakdown/state.mjs';

export const DOCS_ORDER = ['spec', 'brd', 'prd'];
export const NEEDS = { spec: [], brd: ['spec'], prd: ['spec', 'brd'] };
export const DEEP_FLAGS = ['money', 'security', 'clinical'];
const TITLES = { spec: 'how it works', brd: 'business requirements', prd: 'product requirements' };

export const docRel = (id, doc) => path.join('modules', id, `${doc}.md`);
export const prevRel = (id, doc) => path.join('_state', 'docs', id, `${doc}.prev.md`);
export const factsRelOf = (id) => path.join('modules', id, '_facts.json');
export const decisionsRel = (id) => path.join('modules', id, 'checks', 'decisions.md');

export function moduleOf(home, id) {
  const my = loadExisting(home);
  const st = loadState(home);
  if (!my || !Array.isArray(my.modules) || !st || !st.stages || !st.stages['5'] || st.stages['5'].status !== 'done') {
    fail('no approved module list yet: run /tech-plugin:breakdown first (document needs an approved modules.yaml)');
  }
  const m = my.modules.find((x) => x.id === id);
  if (!m) fail(`unknown module "${id}". Modules: ${my.modules.map((x) => x.id).join(', ')}`);
  return { my, m };
}

export const isDeep = (m) => (m.risk || []).some((r) => DEEP_FLAGS.includes(r.flag));

// ------------------------------------------------------------------ fact pack

const WORD_STOP = new Set(['fetch', 'return', 'apply', 'order', 'orders', 'json', 'rule', 'rules', 'label', 'labels', 'page', 'pages', 'deleted', 'failed', 'unable', 'successfully', 'category', 'categories', 'check', 'verify', 'send', 'sent', 'request', 'requests', 'response', 'change', 'changes', 'view', 'views', 'form', 'forms', 'question', 'questions', 'answer', 'answers', 'detail', 'record', 'records', 'count', 'summary', 'filter', 'filters', 'export', 'import', 'print', 'share', 'invoice', 'invoices', 'coupon', 'coupons', 'checkout', 'billing', 'subscription', 'subscriptions', 'patient', 'patients', 'doctor', 'doctors', 'admin', 'user', 'users', 'data', 'list', 'details', 'save', 'update', 'delete', 'edit', 'view', 'page', 'name', 'type', 'types', 'status', 'report', 'reports', 'get', 'post', 'add', 'new', 'all', 'search', 'submit', 'cancel', 'close', 'back', 'next', 'login', 'logout', 'select', 'enter', 'date', 'time', 'email', 'phone', 'mobile', 'number', 'address', 'password', 'yes', 'no', 'and', 'the', 'for', 'with', 'from', 'your', 'this', 'that', 'please', 'here', 'more', 'show', 'create', 'remove', 'download', 'upload', 'file', 'files', 'image', 'images', 'home', 'dashboard', 'settings', 'profile', 'account', 'help', 'about', 'contact', 'total', 'amount', 'price', 'payment', 'payments', 'plan', 'plans', 'api', 'v1', 'v2', 'v3', 'id', 'index', 'store', 'show', 'destroy', 'info', 'error', 'success', 'message', 'messages', 'value', 'values', 'item', 'items', 'option', 'options', 'action', 'actions']);

function domainWords(texts, glossary) {
  const count = new Map();
  for (const t of texts) {
    for (const w of String(t).replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^A-Za-zऀ-ॿ]+/)) {
      const x = w.toLowerCase();
      if (x.length < 4 || WORD_STOP.has(x)) continue;
      count.set(x, (count.get(x) || 0) + 1);
    }
  }
  return [...count.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([w, n]) => ({ word: w, count: n, inGlossary: glossary.has(w) }));
}

export function glossaryTerms(home) {
  const f = path.join(docsDir(home), 'glossary.md');
  const set = new Set();
  if (!fs.existsSync(f)) return set;
  for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = /^\|\s*([^|]+?)\s*\|/.exec(l);
    if (m && !/^(term|-+)$/i.test(m[1])) set.add(m[1].toLowerCase());
  }
  return set;
}

function readDecisions(home, id) {
  const f = path.join(docsDir(home), decisionsRel(id));
  if (!fs.existsSync(f)) return [];
  const out = [];
  for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = /^\|\s*(D\d+)\s*\|\s*(\w+)\s*\|\s*(Q\d+)\s*\|\s*([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|/.exec(l);
    if (m) out.push({ id: m[1], doc: m[2], q: m[3], question: m[4].trim(), answer: m[5].trim(), by: m[6].trim(), on: m[7].trim() });
  }
  return out;
}

export function buildFacts(home, id) {
  const { my, m } = moduleOf(home, id);
  const sys = loadSystem(home);
  const links = loadLinks(home) || { calls: [], routes: [] };
  const glossary = glossaryTerms(home);
  const routeKeys = new Set([...(m.routes || []), ...(m.web_routes || [])]);
  const screenKeys = new Set(m.screens || []);
  const apps = [...new Set([...(m.parts || []).map((p) => p.app), ...[...routeKeys].map((k) => k.split('|')[0]), ...[...screenKeys].map((k) => k.split('|')[0])])];
  const callersOf = new Map(links.routes.map((r) => [`${r.app}|${r.key}`, r]));
  const pack = { schema: 1, module: { id: m.id, name: m.name, purpose: m.purpose, risk: m.risk || [], critical: !!m.critical, deep: isDeep(m), size: m.size, depends_on: m.depends_on || [], used_by: my.modules.filter((x) => (x.depends_on || []).includes(m.id)).map((x) => x.id), parts: m.parts || [], external_systems: m.external_systems || [] }, commits: my.commits || {}, roles: [], screens: [], routes: [], tables: [], externals: [], notCalled: [], unresolved: [], words: [], decisions: readDecisions(home, id) };
  const sysRoles = (sys.system.business && sys.system.business.roles) || [];
  const allTexts = [];
  for (const appId of apps) {
    const a = sys.apps.get(appId);
    if (!a) continue;
    const repo = sys.repos.find((r) => r.name === a.repo);
    const reader = makeReader(repo.abs, isSecretFor(repo.abs));
    const files = listFiles(reader, a.root);
    const src = sourceCache(reader);
    const lang = loadLang(files, src);
    const isLaravel = a.readers.includes('laravel');
    const beh = isLaravel ? laravelBehaviour({ files, src, handlers: a.handlers, lang }) : new Map();
    const generic = isLaravel ? [] : genericMessages({ files: [...new Set(a.routes.map((r) => r.handlerFile).filter(Boolean))], src });
    const cite = (c) => (c ? `${a.repo}:${c}` : null);
    // routes
    for (const r of a.routes.filter((x) => !x.shadowed && routeKeys.has(`${appId}|${x.key}`))) {
      const b = beh.get(r.handler) || { rules: [], messages: [] };
      const asks = a.calls.filter((c) => c.handler && c.handler === r.handler).map((c) => {
        const l = links.calls.find((x) => x.app === appId && x.cite === c.cite && x.method === c.method && (x.uri || x.routeName) === (c.uri || c.routeName));
        return { method: c.method, uri: c.uri || c.routeName || null, status: l ? l.status : null, route: l && l.route ? l.route : null, reason: c.reason || null, cite: cite(c.cite) };
      });
      const usage = callersOf.get(`${appId}|${r.key}`);
      pack.routes.push({
        app: appId,
        key: r.key,
        method: r.method,
        uri: r.uri,
        name: r.name || null,
        handler: r.handler,
        middleware: r.middleware || [],
        kind: r.kind,
        surface: r.surface || null,
        cite: cite(r.cite),
        handlerCite: r.controller && a.handlers.find((h) => h.id === r.controller) ? (() => {
          const h = a.handlers.find((x) => x.id === r.controller);
          const mt = (h.methods || []).find((x) => x.name === r.action);
          return cite(`${h.file}:${mt ? mt.line : 1}`);
        })() : r.handlerFile ? cite(`${r.handlerFile}:1`) : null,
        calledBy: usage ? usage.count || 0 : 0,
        rules: b.rules.map((x) => ({ ...x, cite: cite(x.cite) })),
        messages: b.messages.map((x) => ({ ...x, cite: cite(x.cite) })).concat(generic.filter((g) => g.file === r.handlerFile).map((g) => ({ kind: g.kind, status: g.status, text: g.text, cite: cite(g.cite) }))),
        asksBackend: asks,
      });
      // a page people open in the browser is in use even when no code calls it
      const page = (usage && usage.page) || (r.method === 'GET' && (r.surface === 'page' || r.kind === 'view' || a.screens.some((s) => (s.renderedBy || []).includes(r.handler))));
      const linkedFrom = a.screens.filter((s) => (s.links || []).some((l) => (l.kind === 'route-name' && r.name && l.target === r.name) || (l.kind === 'url' && shapeOf(normUri(l.target)) === r.shape && (!l.method || l.method === r.method)))).map((s) => s.id);
      pack.routes[pack.routes.length - 1].linkedFrom = linkedFrom.slice(0, 10);
      if (linkedFrom.length) allTexts.push(r.uri);
      if ((!usage || !usage.count) && !page && !linkedFrom.length) pack.notCalled.push(`${appId}|${r.key}`);
      allTexts.push(r.uri);
    }
    // screens
    for (const s of a.screens.filter((x) => screenKeys.has(`${appId}|${x.id}`))) {
      const text = s.file ? (src(s.file) || {}).text : null;
      const labels = s.kind === 'blade' ? bladeLabels(text, lang) : [];
      const calls = links.calls.filter((c) => c.app === appId && c.screen === s.id).map((c) => ({ method: c.method, uri: c.uri || c.routeName, status: c.status, route: c.route || null, cite: cite(c.cite) }));
      pack.screens.push({ app: appId, id: s.id, path: s.path || null, kind: s.kind, file: s.file, cite: cite(s.cite), labels, links: s.links || [], renderedBy: s.renderedBy || [], calls });
      allTexts.push(s.id);
    }
    for (const c of a.calls.filter((x) => !x.resolved && (pack.screens.some((s) => s.app === appId && s.id === x.screen) || pack.routes.some((r) => r.app === appId && r.handler === x.handler)))) pack.unresolved.push({ cite: cite(c.cite), method: c.method, reason: c.reason });
    for (const t of a.tables.filter((x) => (m.tables || []).includes(x.name))) pack.tables.push({ app: appId, name: t.name, columns: t.columns, models: t.models, source: t.source, cite: cite(t.cite), class: t.class });
    for (const sy of a.externals.systems.filter((x) => (m.external_systems || []).includes(x.system))) {
      const mine = sy.files.filter((f) => pack.routes.some((r) => r.handlerCite && r.handlerCite.startsWith(`${a.repo}:${f.file}`)) || pack.screens.some((s) => s.file === f.file));
      pack.externals.push({ system: sy.system, where: (mine.length ? mine : sy.files).slice(0, 5).map((f) => cite(`${f.file}:${f.lines[0]}`)) });
    }
    const mw = new Map();
    for (const r of pack.routes.filter((x) => x.app === appId)) for (const x of r.middleware) mw.set(x, (mw.get(x) || 0) + 1);
    pack.roles.push({ app: appId, middleware: [...mw.entries()].map(([name, routes]) => ({ name, routes })), publicRoutes: pack.routes.filter((x) => x.app === appId && !x.middleware.length).length });
    allTexts.push(...a.tables.map((t) => t.name));
  }
  pack.systemRoles = sysRoles;
  pack.words = domainWords(allTexts, glossary);
  const hash = crypto.createHash('sha1').update(JSON.stringify(pack)).digest('hex').slice(0, 16);
  pack.hash = hash;
  pack.builtAt = new Date().toISOString();
  return pack;
}

const esc = (s) => redact(String(s ?? '')).replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function factsMd(p) {
  const L = [`# Fact pack: ${p.module.name} (\`${p.module.id}\`)`, '', `Built ${p.builtAt.slice(0, 10)} by /tech-plugin:document from the code facts and the approved modules.yaml; facts hash \`${p.hash}\`. Scripts only, regenerated on every run: never edit. Every line cites \`repo:path:line\`; quote these citations in the documents.`, ''];
  const mm = p.module;
  L.push('## The module', '', `- **Purpose (approved, Draft wording):** ${esc(mm.purpose || 'not written')}`, `- **Risk:** ${mm.risk.length ? mm.risk.map((r) => `${r.flag} (${esc(r.reason)})`).join('; ') : 'none'}`, `- **Writer tier:** ${mm.deep ? 'deep (money, security or clinical)' : 'standard'} · **Size:** ${mm.size}`, `- **Uses:** ${mm.depends_on.join(', ') || 'no other module'} · **Used by:** ${mm.used_by.join(', ') || 'no other module'}`, `- **Commits:** ${Object.entries(p.commits).map(([r, c]) => `${r} ${String(c || '').slice(0, 10)}`).join(', ')}`, '');
  L.push('## People and access', '', `- **Roles named by the business (system.yaml):** ${p.systemRoles.join(', ') || 'none given'}`);
  for (const r of p.roles) L.push(`- **${r.app}:** ${r.publicRoutes} route(s) with no access check; ${r.middleware.map((x) => `\`${x.name}\` on ${x.routes}`).join(', ') || 'no middleware'}`);
  L.push('');
  L.push(`## Screens (${p.screens.length})`, '');
  for (const s of p.screens) {
    L.push(`### ${s.id} (${s.app}${s.path ? `, opens at \`${s.path}\`` : ''}) \`${s.cite}\``);
    if (s.labels.length) L.push(`- **Shows:** ${s.labels.map((l) => `${l.kind} "${esc(l.text)}"`).join('; ')}`);
    if (s.links.length) L.push(`- **Goes to:** ${s.links.map((l) => `${l.kind} \`${esc(l.target)}\``).join(', ')}`);
    if (s.calls.length) L.push(`- **Asks for data:** ${s.calls.slice(0, 20).map((c) => `${c.method} \`${esc(c.uri)}\` (${c.status}${c.route ? ` -> ${c.route.key}` : ''}) \`${c.cite}\``).join('; ')}`);
    L.push('');
  }
  L.push(`## Routes (${p.routes.length})`, '', '| Method | Path | Handler | Access | Called by apps | Opened from pages | Source |', '|---|---|---|---|---|---|---|');
  for (const r of p.routes) L.push(`| ${r.method} | \`${esc(r.uri)}\` | ${esc((r.handler || '').split('\\').pop())} | ${esc(r.middleware.join(', ') || 'none')} | ${r.calledBy} | ${esc((r.linkedFrom || []).join(', '))} | \`${r.cite}\` |`);
  L.push('');
  const withBeh = p.routes.filter((r) => r.rules.length || r.messages.length || r.asksBackend.length);
  if (withBeh.length) {
    L.push('## What each route checks, says and asks', '');
    for (const r of withBeh) {
      L.push(`### ${r.method} ${esc(r.uri)}: ${esc((r.handler || '').split('\\').pop())} \`${r.handlerCite || r.cite}\``);
      for (const x of r.rules) L.push(`- **Rule:** \`${esc(x.field)}\` ${esc(x.rule)} \`${x.cite}\``);
      for (const x of r.messages) L.push(`- **Message (${x.kind}${x.status ? `, ${x.status}` : ''}):** "${esc(x.text)}" \`${x.cite}\``);
      for (const x of r.asksBackend) L.push(`- **Asks ${x.status === 'outside-system' ? 'the backend (outside this breakdown)' : x.route ? `route ${x.route.key}` : 'a service'}:** ${x.method} \`${esc(x.uri || x.reason)}\` \`${x.cite}\``);
      L.push('');
    }
  }
  if (p.tables.length) {
    L.push(`## Tables (${p.tables.length})`, '', '| Table | Columns | Models | Source |', '|---|---|---|---|');
    for (const t of p.tables) L.push(`| \`${t.name}\` | ${esc(t.columns.join(', '))} | ${esc(t.models.join(', '))} | \`${t.cite}\` (${t.class}) |`);
    L.push('');
  }
  if (p.externals.length) L.push('## External services', '', ...p.externals.map((e) => `- ${e.system}: ${e.where.map((w) => `\`${w}\``).join(', ')}`), '');
  if (p.notCalled.length) L.push(`## Routes no app in the breakdown calls (${p.notCalled.length})`, '', 'State them as such and ask about them; never describe them as live features.', '', p.notCalled.map((k) => `\`${k.split('|')[1]}\``).join(', '), '');
  if (p.unresolved.length) L.push('## Calls whose URL is only known at run time', '', ...p.unresolved.map((u) => `- \`${u.cite}\` ${u.method}: ${esc(u.reason)}`), '');
  if (p.decisions.length) L.push('## Decisions people made (cite as "decision D<n>")', '', ...p.decisions.map((d) => `- **${d.id}** (${d.doc} ${d.q}, ${esc(d.by)}, ${d.on}): ${esc(d.answer)}`), '');
  L.push('## Domain words seen in this module', '', p.words.map((w) => `${w.word}${w.inGlossary ? '' : ' (not in glossary)'}`).join(', ') || 'none', '');
  return L.join('\n');
}

export function writeFacts(home, id) {
  const p = buildFacts(home, id);
  const old = readJson(path.join(docsDir(home), factsRelOf(id)));
  writeDocs(home, factsRelOf(id), JSON.stringify(p, null, 1) + '\n');
  writeDocs(home, path.join('modules', id, '_facts.md'), factsMd(p));
  return { pack: p, changed: old ? old.hash !== p.hash : null, old };
}

// ------------------------------------------------------------------ status

function docInfo(home, id, doc) {
  const f = path.join(docsDir(home), docRel(id, doc));
  if (!fs.existsSync(f)) return { exists: false };
  const text = fs.readFileSync(f, 'utf8');
  let parts;
  try {
    parts = splitDoc(text);
  } catch (e) {
    return { exists: true, broken: `the stamp could not be read: ${e.message}` };
  }
  const front = parts.front || {};
  const hash = bodyHash(parts.body);
  const ap = front.approvals || {};
  const valid = (x) => x && x.by && x.hash === hash;
  return { exists: true, front, hash, status: front.status || 'Draft', approvals: { people: valid(ap.people) ? ap.people : null, technical: valid(ap.technical) ? ap.technical : null }, changedSinceApproval: !!((ap.people && ap.people.hash !== hash) || (ap.technical && ap.technical.hash !== hash)) };
}

export function status(home, id, { force = false } = {}) {
  const { m } = moduleOf(home, id);
  const { pack, changed, old } = writeFacts(home, id);
  const docs = {};
  for (const doc of DOCS_ORDER) {
    const d = docInfo(home, id, doc);
    let state;
    if (!d.exists) state = 'missing';
    else if (d.broken) state = 'broken';
    else if (force) state = 'forced';
    else if (d.front.facts !== pack.hash) state = 'facts-changed';
    else if (NEEDS[doc].some((n) => {
      const nd = docInfo(home, id, n);
      return nd.exists && d.front.inputs && d.front.inputs[n] !== nd.hash;
    })) state = 'input-changed';
    else state = 'up-to-date';
    docs[doc] = { state, status: d.status || null, approvals: d.approvals || null, changedSinceApproval: !!d.changedSinceApproval, broken: d.broken || null };
  }
  const next = DOCS_ORDER.find((d) => docs[d].state !== 'up-to-date') || 'up-to-date';
  const firstStale = DOCS_ORDER.find((d) => docs[d].state === 'facts-changed');
  const was = firstStale ? readJson(path.join(docsDir(home), '_state', 'docs', id, `${firstStale}.facts.json`)) : null;
  const factsChanges = was ? summarizeChange(was, pack) : old && changed ? summarizeChange(old, pack) : [];
  const bd = breakdownStatus(home);
  const stx = loadState(home);
  const repos = Object.fromEntries(((stx && stx.repos) || []).map((r) => [r.name, path.resolve(home, r.path)]));
  return { module: id, name: m.name, breakdown: { upToDate: bd.next === 'up-to-date', next: bd.next, message: bd.message }, critical: !!m.critical, deep: pack.module.deep, repos, scripts: path.join(PLUGIN_ROOT, 'scripts', 'document'), writer: pack.module.deep ? 'tech-plugin:doc-writer-deep' : 'tech-plugin:doc-writer', checker: pack.module.deep ? 'tech-plugin:doc-checker-deep' : 'tech-plugin:doc-checker', checkerPasses: pack.module.deep ? 2 : 1, facts: { hash: pack.hash, md: path.join(docsDir(home), 'modules', id, '_facts.md'), routes: pack.routes.length, screens: pack.screens.length, changes: factsChanges }, docs, next, message: next === 'up-to-date' ? `Already up to date: spec, BRD and PRD of ${id} match the code.` : `${next}: ${docs[next].state}` };
}

function summarizeChange(a, b) {
  const out = [];
  const keys = (x, f) => new Set((x || []).map(f));
  for (const [name, f] of [['routes', (r) => `${r.app}|${r.key}`], ['screens', (s) => `${s.app}|${s.id}`], ['tables', (t) => t.name]]) {
    const A = keys(a[name], f);
    const B = keys(b[name], f);
    const add = [...B].filter((k) => !A.has(k));
    const del = [...A].filter((k) => !B.has(k));
    if (add.length) out.push(`new ${name}: ${add.slice(0, 8).join(', ')}`);
    if (del.length) out.push(`removed ${name}: ${del.slice(0, 8).join(', ')}`);
  }
  if (!out.length) out.push('details changed (rules, messages, labels or calls)');
  return out;
}

// ------------------------------------------------------------------ prepare (for the writer)

export function idsIn(text, doc, id) {
  if (doc === 'prd') return uniq([...text.matchAll(new RegExp(`^### (${id.toUpperCase()}-R\\d{2,})\\b`, 'gm'))].map((m) => m[1]));
  if (doc === 'brd') return uniq([...text.matchAll(/^\|\s*(BR-\d{2,})\s*\|/gm)].map((m) => m[1]));
  return [];
}

export function prepare(home, id, doc) {
  if (!DOCS_ORDER.includes(doc)) fail(`unknown document "${doc}" (spec, brd or prd)`);
  const st = status(home, id, { force: true });
  const missing = NEEDS[doc].filter((n) => st.docs[n].state === 'missing');
  if (missing.length) fail(`${doc} is written from ${missing.join(' and ')}, which does not exist yet: write ${missing.join(', then ')} first`);
  const { my } = moduleOf(home, id);
  const D = docsDir(home);
  const out = path.join(D, docRel(id, doc));
  let prevIds = [];
  if (fs.existsSync(out)) {
    const t = fs.readFileSync(out, 'utf8');
    writeDocs(home, prevRel(id, doc), t);
    prevIds = idsIn(t, doc, id);
  }
  const inputs = {};
  for (const n of NEEDS[doc]) inputs[n] = docInfo(home, id, n).hash;
  // the fact pack this document is written from, to say later what changed
  writeDocs(home, path.join('_state', 'docs', id, `${doc}.facts.json`), fs.readFileSync(path.join(D, factsRelOf(id)), 'utf8'));
  const front = {
    module: id,
    doc,
    title: `${my.modules.find((x) => x.id === id).name}: ${TITLES[doc]}`,
    status: 'Draft',
    date: today(),
    commits: my.commits || {},
    facts: st.facts.hash,
    inputs,
    writer: st.writer,
    approvals: { people: null, technical: null },
  };
  const stampText = `---\n${toYaml(front).trimEnd()}\n---\n`;
  return {
    module: id,
    doc,
    deep: st.deep,
    writer: st.writer,
    out,
    factsMd: st.facts.md,
    template: path.join(PLUGIN_ROOT, 'references', 'document', `${doc}-template.md`),
    rules: path.join(PLUGIN_ROOT, 'references', 'document', 'writing-rules.md'),
    inputs: NEEDS[doc].map((n) => path.join(D, docRel(id, n))),
    glossary: path.join(D, 'glossary.md'),
    stamp: stampText,
    keepIds: prevIds,
    idPrefix: doc === 'prd' ? `${id.toUpperCase()}-R` : doc === 'brd' ? 'BR-' : null,
    checks: [`node "${path.join(PLUGIN_ROOT, 'scripts', 'document', 'check-doc.mjs')}" "${out}" --home "${home}"`, `node "${path.join(PLUGIN_ROOT, 'scripts', 'document', 'plain.mjs')}" "${out}" --home "${home}"`],
  };
}

function main() {
  const [cmd, id, third] = process.argv.slice(2);
  const a = parseArgs(process.argv.slice(3), ['force']);
  if (!a.home || !id) fail('usage: doc.mjs <facts|status|prepare> <module> [spec|brd|prd] --home HOME [--force]');
  const home = real(a.home);
  if (cmd === 'facts') {
    const r = writeFacts(home, id);
    process.stdout.write(`wrote modules/${id}/_facts.md: ${r.pack.routes.length} routes, ${r.pack.screens.length} screens, ${r.pack.tables.length} tables (facts ${r.pack.hash})\n`);
  } else if (cmd === 'status') process.stdout.write(JSON.stringify(status(home, id, { force: !!a.force }), null, 2) + '\n');
  else if (cmd === 'prepare') process.stdout.write(JSON.stringify(prepare(home, id, third), null, 2) + '\n');
  else fail('usage: doc.mjs <facts|status|prepare> <module> [spec|brd|prd] --home HOME');
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) main();
