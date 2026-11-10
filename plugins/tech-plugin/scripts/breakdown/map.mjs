#!/usr/bin/env node
// breakdown stage 3: read the code of one repo.
//
//   node map.mjs --repo REPO [--home HOME] [--no-graph] [--force]
//
// Runs the stack readers for every app found in stage 2 (routes, handlers,
// screens, API calls, tables, external services) and builds the graphify code
// graph. Writes, in the repo's own sdlc-docs/:
//   _map/<repo>/facts.json            all facts, with path:line citations
//   _map/<repo>/facts.md              short readable summary
//   _map/graphify/<repo>/…            the code graph (see lib/graph.mjs)
// Prints one summary line. Skips the work when the code has not changed since
// the last run (commit + code fingerprint), unless --force.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGraph, fileCommunities, findGraphify, loadGraph } from '../lib/graph.mjs';
import { emptyFacts, sourceCache, uniq } from '../lib/readers/common.mjs';
import { readCalls } from '../lib/readers/calls.mjs';
import { readExternals } from '../lib/readers/externals.mjs';
import { readFlutter } from '../lib/readers/flutter.mjs';
import { readGeneric } from '../lib/readers/generic.mjs';
import { readLaravel } from '../lib/readers/laravel.mjs';
import { readNode } from '../lib/readers/node.mjs';
import { readPython } from '../lib/readers/python.mjs';
import { readSpring } from '../lib/readers/spring.mjs';
import { readWeb } from '../lib/readers/web.mjs';
import { commitOf, docsDir, fail, parseArgs, readJson, real, writeDocs } from './common.mjs';
import { READERS_VERSION, baseRegex, codeTree, factsRel, loadOverrides, loadSystemYaml, ownHosts } from './load.mjs';
import { findHome, loadState, saveState } from './state.mjs';

const NODE_BACKENDS = ['Express', 'NestJS', 'Fastify', 'Koa', 'hapi'];
const WEB = ['Next.js', 'Nuxt', 'SvelteKit', 'Remix', 'React', 'Vue', 'Angular', 'Svelte', 'React Native', 'Expo'];
const PY = ['Django', 'FastAPI', 'Flask', 'Starlette', 'Django REST framework'];

function merge(into, part) {
  for (const k of ['routes', 'handlers', 'screens', 'models', 'unparsed', 'notes', 'groups']) if (part[k]) into[k].push(...part[k]);
  for (const t of part.tables || []) {
    const old = into.tables.find((x) => x.name === t.name);
    if (old) old.models = uniq(old.models.concat(t.models));
    else into.tables.push(t);
  }
}

export function mapRepo(repoArg, { home = null, graph = true, force = false } = {}) {
  const repo = real(repoArg);
  const name = path.basename(repo);
  if (!fs.existsSync(docsDir(repo))) fail(`${repo}/sdlc-docs does not exist yet; run stage 1 first`);
  const stack = readJson(path.join(docsDir(repo), '_map', name, 'stack.json'));
  if (!stack) fail(`no stack facts for ${name}; run stage 2 first (detect.mjs --write)`);
  home = home ? real(home) : findHome(repo) || repo;
  const overrides = loadOverrides(home, { create: true });
  const system = loadSystemYaml(home);
  const { files, reader, tree } = codeTree(repo);
  const commit = commitOf(repo);
  const old = readJson(path.join(docsDir(repo), factsRel(name)));
  const graphNowAvailable = graph && old && old.graph && old.graph.status === 'missing' && findGraphify();
  if (!force && old && old.commit === commit && old.tree === tree && old.schema === 1 && old.readers === READERS_VERSION && !graphNowAvailable) {
    recordState(home, name, { commit, tree, readers: READERS_VERSION });
    return { upToDate: true, line: `${name}: already mapped at ${commit ? commit.slice(0, 7) : 'no commit'}; no code change` };
  }

  // the code graph first: the generic reader groups code by its communities
  const outRel = path.join('_map', 'graphify', name);
  let g = { status: 'skipped', message: 'skipped (--no-graph)' };
  if (graph && !stack.empty) {
    g = buildGraph({
      repo,
      name,
      files,
      outRel,
      stamp: { commit, tree },
      force,
      bin: findGraphify(),
      write: (rel, content) => writeDocs(repo, rel, content),
      readStamp: () => readJson(path.join(docsDir(repo), outRel, 'stamp.json')),
    });
  }
  const cfg = readJson(path.join(docsDir(home), 'config.json')) || {};
  if (g.status === 'missing' && cfg.strict === true) fail('graphify is not installed and this project is strict ("strict": true in sdlc-docs/config.json): install it first (see /tech-plugin:doctor)');
  const graphData = ['built', 'up-to-date'].includes(g.status) ? loadGraph(path.join(docsDir(repo), outRel, 'graph.json')) : null;
  const fileComm = graphData ? fileCommunities(graphData) : new Map();

  const src = sourceCache(reader);
  const baseRe = baseRegex(overrides.base_url_names);
  const roots = stack.apps.map((a) => a.root);
  const apps = [];
  for (const app of stack.apps) {
    const inApp = (f) => app.root === '.' || f === app.root || f.startsWith(app.root + '/');
    const nested = roots.filter((r) => r !== app.root && (app.root === '.' || r.startsWith(app.root + '/')));
    const appFiles = files.filter((f) => inApp(f) && !nested.some((r) => f.startsWith(r + '/')));
    const facts = emptyFacts(app);
    const names = app.stack.map((s) => s.name);
    const ctx = { reader, root: app.root, files: appFiles, src, stack: names };
    let laravel = null;
    let skip = new Set();
    let extraCalls = [];
    if (names.includes('Laravel') || names.includes('Lumen')) {
      laravel = readLaravel(ctx);
      merge(facts, laravel);
      facts.readers.push('laravel');
      facts.meta = { ...(facts.meta || {}), ...laravel.meta };
    }
    if (names.includes('Flutter') || (app.language === 'Dart' && appFiles.some((f) => f.endsWith('.dart')))) {
      const r = readFlutter(ctx);
      merge(facts, r);
      facts.screenRoutes = r.screenRoutes;
      facts.readers.push('flutter');
    }
    if (names.some((n) => NODE_BACKENDS.includes(n))) {
      const r = readNode(ctx);
      merge(facts, r);
      skip = r.skipSites;
      facts.readers.push('node');
    }
    if (names.some((n) => WEB.includes(n))) {
      const r = readWeb(ctx);
      merge(facts, r);
      facts.readers.push('web');
    }
    if (names.some((n) => PY.includes(n))) {
      merge(facts, readPython(ctx));
      facts.readers.push('python');
    }
    if (names.includes('Spring Boot') || (/Java|Kotlin/.test(app.language || '') && appFiles.some((f) => /\.(java|kt)$/.test(f) && /@(Rest)?Controller\b/.test((src(f) || {}).code || '')))) {
      const r = readSpring(ctx);
      merge(facts, r);
      extraCalls = r.calls;
      facts.readers.push('spring');
    }
    if (!facts.routes.length && !facts.screens.length) {
      const groups = [];
      const byComm = new Map();
      for (const f of appFiles) {
        const c = fileComm.get(f);
        if (!c) continue;
        if (!byComm.has(c)) byComm.set(c, []);
        byComm.get(c).push(f);
      }
      for (const [id, fl] of [...byComm.entries()].sort((a, b) => b[1].length - a[1].length)) {
        const folders = new Map();
        for (const f of fl) {
          const d = f.split('/').slice(0, -1).slice(0, 3).join('/') || '.';
          folders.set(d, (folders.get(d) || 0) + 1);
        }
        groups.push({ id, label: [...folders.entries()].sort((a, b) => b[1] - a[1])[0][0], files: fl.slice(0, 40), fileCount: fl.length });
      }
      merge(facts, readGeneric({ ...ctx, graphGroups: groups }));
      facts.readers.push('generic');
      if (!graphData) facts.notes.push('no code graph (graphify not available): the generic reader found only route-like registrations');
    }
    const screenFiles = new Map(facts.screens.filter((s) => s.file && !s.partial).map((s) => [s.file, s.id]));
    // a page's own script (loaded by exactly one page) counts as that page;
    // a script several pages load is credited to none of them
    const loadedBy = new Map();
    for (const s of facts.screens) for (const js of s.scripts || []) {
      if (!loadedBy.has(js)) loadedBy.set(js, new Set());
      loadedBy.get(js).add(s.partial ? '*partial*' : s.id);
    }
    for (const [js, by] of loadedBy) if (by.size === 1 && !by.has('*partial*') && !screenFiles.has(js)) screenFiles.set(js, [...by][0]);
    const { calls } = readCalls({ files: appFiles, src, baseRe, skip, screenFiles });
    if (laravel) {
      for (const c of calls) {
        const m = laravel.methodAt(c.file, c.line);
        if (!m) continue;
        c.handler = m.handler;
        const views = m.views.filter((v) => facts.screens.some((s) => s.id === v && !s.partial));
        if (!c.screen && views.length) c.screen = views[0];
      }
    }
    facts.calls = calls.concat(extraCalls);
    facts.externals = readExternals({ files: appFiles, src, extra: overrides.externals, ownHosts: ownHosts(system) });
    if (graphData) for (const h of facts.handlers) h.group = fileComm.get(h.file) || null;
    if (graphData) for (const s of facts.screens) s.group = s.file ? fileComm.get(s.file) || null : null;
    facts.counts = counts(facts);
    apps.push(facts);
  }
  const facts = {
    schema: 1,
    readers: READERS_VERSION,
    repo: name,
    commit,
    tree,
    mappedAt: new Date().toISOString(),
    empty: !!stack.empty,
    graph: { status: g.status, message: g.message || null, nodes: g.nodes || null, communities: g.communities || null, commit: g.commit || null },
    apps,
  };
  writeDocs(repo, factsRel(name), JSON.stringify(facts, null, 1) + '\n');
  writeDocs(repo, path.join('_map', name, 'facts.md'), factsMd(facts));
  recordState(home, name, { commit, tree, readers: READERS_VERSION });
  return { upToDate: false, line: summaryLine(facts), facts };
}

function counts(f) {
  const live = f.routes.filter((r) => !r.shadowed);
  return {
    routes: f.routes.length,
    uniqueRoutes: new Set(live.map((r) => r.key)).size,
    closures: f.routes.filter((r) => r.kind === 'closure').length,
    shadowed: f.routes.length - live.length,
    unparsed: f.unparsed.length,
    handlers: f.handlers.length,
    screens: f.screens.filter((s) => !s.partial).length,
    partials: f.screens.filter((s) => s.partial).length,
    calls: f.calls.length,
    unresolvedCalls: f.calls.filter((c) => !c.resolved).length,
    tables: f.tables.length,
    groups: f.groups.length,
  };
}

export function summaryLine(facts) {
  if (facts.empty) return `${facts.repo}: no code yet, nothing to read`;
  const parts = facts.apps.map((a) => {
    const c = a.counts;
    const bits = [];
    if (c.routes) bits.push(`${c.uniqueRoutes} routes${c.closures ? ` (${c.closures} closures)` : ''}${c.unparsed ? `, ${c.unparsed} unparsed` : ''}${c.shadowed ? `, ${c.shadowed} shadowed` : ''}`);
    if (c.handlers) bits.push(`${c.handlers} handlers`);
    if (c.screens) bits.push(`${c.screens} screens`);
    if (c.calls) bits.push(`${c.calls} API calls${c.unresolvedCalls ? ` (${c.unresolvedCalls} unresolved)` : ''}`);
    if (c.tables) bits.push(`${c.tables} tables`);
    if (c.groups) bits.push(`${c.groups} code groups`);
    const ext = [...new Set(a.externals.systems.map((s) => s.system.split(' ')[0]))];
    if (ext.length) bits.push(`services: ${ext.slice(0, 5).join(', ')}${ext.length > 5 ? '…' : ''}`);
    return `${a.id} [${a.readers.join('+')}]: ${bits.join(', ') || 'nothing found'}`;
  });
  const g = facts.graph;
  const gl = g.status === 'built' || g.status === 'up-to-date' ? `graph ${g.nodes} nodes, ${g.communities} groups` : `graph ${g.status}`;
  return `${facts.repo}: ${parts.join('; ')} | ${gl}`;
}

function factsMd(f) {
  const L = [`# Code facts: ${f.repo}`, '', `Read by /tech-plugin:breakdown stage 3 on ${f.mappedAt.slice(0, 10)} at commit \`${f.commit ? f.commit.slice(0, 10) : 'none'}\`. Regenerated on every run; never edit by hand. Full data: \`facts.json\`.`, ''];
  L.push('| App | Readers | Routes | Handlers | Screens | API calls (unresolved) | Tables | Unparsed |', '|---|---|---|---|---|---|---|---|');
  for (const a of f.apps) {
    const c = a.counts;
    L.push(`| ${a.id} | ${a.readers.join(', ')} | ${c.uniqueRoutes} | ${c.handlers} | ${c.screens} | ${c.calls} (${c.unresolvedCalls}) | ${c.tables} | ${c.unparsed} |`);
  }
  L.push('', `**Code graph:** ${f.graph.status}${f.graph.message ? `: ${f.graph.message}` : ''}${f.graph.nodes ? ` (${f.graph.nodes} nodes, ${f.graph.communities} groups)` : ''}`, '');
  for (const a of f.apps) {
    L.push(`## ${a.id}`, '');
    if (a.meta && a.meta.routeFiles) {
      L.push('| Route file | URL prefix | Prefix from |', '|---|---|---|');
      for (const r of a.meta.routeFiles) L.push(`| \`${r.file}\` | \`${r.prefix}\` | ${r.source} |`);
      L.push('');
    }
    if (a.notes.length) L.push(`**Notes:** ${a.notes.join('; ')}`, '');
    if (a.unparsed.length) {
      L.push('**Lines the readers could not understand** (check them by hand):', '');
      for (const u of a.unparsed.slice(0, 30)) L.push(`- \`${u.cite}\` ${u.text.replace(/`/g, "'")}`);
      if (a.unparsed.length > 30) L.push(`- … and ${a.unparsed.length - 30} more in facts.json`);
      L.push('');
    }
    const un = a.calls.filter((c) => !c.resolved);
    if (un.length) {
      L.push('**API calls whose URL is only known at run time:**', '');
      for (const c of un.slice(0, 20)) L.push(`- \`${c.cite}\` ${c.method}: ${c.reason}`);
      if (un.length > 20) L.push(`- … and ${un.length - 20} more`);
      L.push('');
    }
    if (a.externals.systems.length) {
      L.push('**External services in code** (file and line only):', '');
      for (const s of a.externals.systems) L.push(`- ${s.system}: ${s.files.length} file(s), e.g. \`${s.files[0].file}:${s.files[0].lines[0]}\``);
      L.push('');
    }
    if (a.externals.otherHosts.length) L.push(`**Other hosts in code:** ${a.externals.otherHosts.slice(0, 10).map((h) => `${h.host} (${h.count})`).join(', ')}`, '');
  }
  return L.join('\n');
}

function recordState(home, name, stamp) {
  const st = loadState(home);
  if (!st) return;
  st.repos = (st.repos || []).map((r) => (r.name === name ? { ...r, mapped: { ...stamp, at: new Date().toISOString() } } : r));
  saveState(home, st);
}

function main() {
  const a = parseArgs(process.argv.slice(2), ['no-graph', 'force']);
  const repo = a.repo || a._[0];
  if (!repo) fail('usage: map.mjs --repo REPO [--home HOME] [--no-graph] [--force]');
  const r = mapRepo(repo, { home: a.home || null, graph: !a['no-graph'], force: !!a.force });
  process.stdout.write(r.line + '\n');
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) main();
