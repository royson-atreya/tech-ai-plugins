#!/usr/bin/env node
// breakdown stage 4: link the apps.
//
//   node link.mjs --home HOME
//
// Joins every API call (from any app) to the route that serves it:
//   screen -> METHOD + path -> route -> handler -> tables
// across web, mobile and backend. Writes, in the home repo's sdlc-docs/:
//   _map/links.json   every call with its match, and every route with its callers
//   _map/links.md     counts, calls with no matching route (likely bugs or
//                     removed endpoints), routes nothing calls (possibly unused,
//                     or called from outside), and calls that need a person
// Matching is static: method + path shape ({} for parameters). A call without
// the base URL may match a route by its tail (e.g. "patients/{}" ->
// "api/patients/{patient}"); such matches are marked Inferred. Fixes from
// _map/overrides.yaml (links:) win over the scripts.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { docsDir, fail, parseArgs, real, writeDocs } from './common.mjs';
import { factsStamps, loadSystem, ownHosts } from './load.mjs';
import { loadState, saveState } from './state.mjs';

const segs = (shape) => (shape === '/' || !shape ? [] : shape.split('/'));

function segScore(c, r) {
  if (c === r) return c === '{}' ? 2 : 3;
  if (r === '{}') return 1;
  if (c === '{}') return 0.5; // a dynamic call part against a fixed route part
  return -1;
}

function alignScore(cs, rs) {
  if (cs.length !== rs.length) return -1;
  let s = 0;
  for (let i = 0; i < cs.length; i++) {
    const v = segScore(cs[i], rs[i]);
    if (v < 0) return -1;
    s += v;
  }
  return s;
}

// Best route for a call: exact shape first, then by tail (call lacks a base
// path) or by head trimmed (call has a prefix the route lacks).
export function matchCall(call, routes) {
  const cs = segs(call.shape);
  const found = [];
  for (const r of routes) {
    const shapes = [segs(r.shape)];
    if (/\?\}$/.test(r.uri)) shapes.push(segs(r.shape).slice(0, -1));
    for (const rs of shapes) {
      let sc = alignScore(cs, rs);
      let how = 'exact';
      if (sc < 0 && rs.length > cs.length && rs.length - cs.length <= 3 && cs.length) {
        sc = alignScore(cs, rs.slice(rs.length - cs.length));
        if (sc >= 0) {
          sc -= 1.5 * (rs.length - cs.length);
          how = 'tail';
        }
      }
      if (sc < 0 && cs.length > rs.length && cs.length - rs.length <= 2 && rs.length) {
        sc = alignScore(cs.slice(cs.length - rs.length), rs);
        if (sc >= 0) {
          sc -= 2 * (cs.length - rs.length);
          how = 'head-trimmed';
        }
      }
      if (sc < 0) continue;
      // a web page route of another app is rarely what an API client calls
      if (r.surface === 'page' && call.app && r.app !== call.app) sc -= 4;
      found.push({ r, sc, how, methodOk: r.method === call.method || r.method === 'ANY' || (call.method === 'GET' && r.method === 'HEAD') });
    }
  }
  if (!found.length) return null;
  found.sort((a, b) => Number(b.methodOk) - Number(a.methodOk) || b.sc - a.sc);
  const best = found[0];
  const ties = found.filter((f) => f.methodOk === best.methodOk && f.sc === best.sc && (f.r.app !== best.r.app || f.r.key !== best.r.key));
  return { best, ties };
}

export function linkSystem(home) {
  const { st, repos, apps, system, overrides } = loadSystem(home);
  const roleOf = new Map(repos.map((r) => [r.name, r.role || '']));
  const routes = [];
  for (const [id, a] of apps) for (const r of a.routes) if (!r.shadowed) routes.push({ ...r, app: id, repo: a.repo });
  const byName = new Map();
  for (const r of routes) if (r.name) byName.set(`${r.app}|${r.name}`, r);
  const own = ownHosts(system);
  const ov = new Map((overrides.links || []).filter((o) => o && o.source).map((o) => [String(o.source), o]));
  const usedOv = new Set();
  const out = [];
  for (const [id, a] of apps) {
    for (const c of a.calls) {
      const base = { app: id, repo: a.repo, cite: c.cite, method: c.method, uri: c.uri, routeName: c.routeName, screen: c.screen, area: c.area, handler: c.handler || null, via: c.via, host: c.host };
      const o = ov.get(c.cite);
      if (o) {
        usedOv.add(c.cite);
        if (o.ignore) {
          out.push({ ...base, status: 'ignored', reason: String(o.ignore) });
          continue;
        }
        const [rApp, rKey] = String(o.route || '').includes('|') ? String(o.route).split('|') : [o.app || null, String(o.route || '')];
        const r = routes.find((x) => x.key === rKey && (!rApp || x.app === rApp));
        if (r) {
          out.push({ ...base, status: 'matched', route: { app: r.app, key: r.key }, how: 'override', class: 'Verified' });
          continue;
        }
        out.push({ ...base, status: 'no-route', reason: `override names a route that does not exist: ${o.route}` });
        continue;
      }
      if (c.routeName) {
        const r = byName.get(`${id}|${c.routeName}`) || routes.find((x) => x.name === c.routeName);
        if (r) out.push({ ...base, status: r.method === c.method || r.method === 'ANY' ? 'matched' : 'method-mismatch', route: { app: r.app, key: r.key }, how: 'route-name', class: 'Verified' });
        else out.push({ ...base, status: 'no-route', reason: `no route named ${c.routeName}` });
        continue;
      }
      if (!c.resolved) {
        out.push({ ...base, status: 'unresolved', reason: c.reason });
        continue;
      }
      const m = matchCall({ ...c, app: id }, routes);
      const external = c.host && !own.some((h) => c.host === h || c.host.endsWith('.' + h));
      if (!m) {
        out.push({ ...base, status: external ? 'external' : 'no-route' });
        continue;
      }
      let best = m.best;
      if (m.ties.length) {
        // prefer a route in a backend repo, then one in another repo than the caller
        const cands = [m.best, ...m.ties];
        const pick = cands.filter((x) => /back|api|server/i.test(roleOf.get(x.r.repo) || ''));
        const other = cands.filter((x) => x.r.repo !== a.repo);
        if (pick.length === 1) best = pick[0];
        else if (other.length === 1) best = other[0];
        else {
          out.push({ ...base, status: 'ambiguous', candidates: cands.slice(0, 5).map((x) => ({ app: x.r.app, key: x.r.key })) });
          continue;
        }
      }
      if (external && best.how !== 'exact') {
        out.push({ ...base, status: 'external' });
        continue;
      }
      out.push({ ...base, status: best.methodOk ? 'matched' : 'method-mismatch', route: { app: best.r.app, key: best.r.key }, how: best.how, class: best.how === 'exact' && c.class === 'Verified' ? 'Verified' : 'Inferred' });
    }
  }
  // route usage
  const usage = new Map(routes.map((r) => [`${r.app}|${r.key}`, { app: r.app, key: r.key, handler: r.handler, cite: r.cite, callers: [] }]));
  for (const c of out) if (c.route && (c.status === 'matched' || c.status === 'method-mismatch')) {
    const u = usage.get(`${c.route.app}|${c.route.key}`);
    if (u && u.callers.length < 25) u.callers.push({ app: c.app, cite: c.cite, screen: c.screen || null });
    if (u) u.count = (u.count || 0) + 1;
  }
  const unusedOverrides = [...ov.keys()].filter((k) => !usedOv.has(k));
  const links = { schema: 1, linkedAt: new Date().toISOString(), inputs: factsStamps(repos), calls: out, routes: [...usage.values()].map((u) => ({ ...u, count: u.count || 0 })), unusedOverrides };
  writeDocs(home, path.join('_map', 'links.json'), JSON.stringify(links, null, 1) + '\n');
  writeDocs(home, path.join('_map', 'links.md'), linksMd(links, apps));
  const s = loadState(home);
  s.stages = { ...(s.stages || {}), 4: { status: 'done', at: new Date().toISOString(), inputs: links.inputs } };
  saveState(home, s);
  return { links, lines: summaryLines(links, apps) };
}

function tally(calls) {
  const t = { calls: calls.length };
  for (const c of calls) t[c.status] = (t[c.status] || 0) + 1;
  t.withScreen = calls.filter((c) => c.status === 'matched' && c.screen).length;
  return t;
}

export function summaryLines(links, apps) {
  const L = [];
  for (const [id] of apps) {
    const calls = links.calls.filter((c) => c.app === id);
    if (!calls.length) continue;
    const t = tally(calls);
    L.push(`${id}: ${t.calls} calls: ${t.matched || 0} matched (${t.withScreen} with a screen), ${t['method-mismatch'] || 0} method mismatch, ${t['no-route'] || 0} no route, ${t.unresolved || 0} unresolved, ${t.ambiguous || 0} ambiguous, ${t.external || 0} external${t.ignored ? `, ${t.ignored} ignored` : ''}`);
  }
  for (const [id, a] of apps) {
    const rs = links.routes.filter((r) => r.app === id);
    if (!rs.length) continue;
    L.push(`${id}: ${rs.length} routes: ${rs.filter((r) => r.count).length} called by an app, ${rs.filter((r) => !r.count).length} not called by any app in this system`);
  }
  if (links.unusedOverrides.length) L.push(`overrides that match no call: ${links.unusedOverrides.join(', ')}`);
  return L;
}

function linksMd(links, apps) {
  const L = ['# API links', '', `Written by /tech-plugin:breakdown stage 4 on ${links.linkedAt.slice(0, 10)}. Regenerated on every run; fix links by hand in \`overrides.yaml\` (links:), never here.`, ''];
  L.push('Every API call found in the code, matched to the route that serves it by method and path. **Inferred** matches found the route by the end of its path (the call has no base path) or after trimming; check them when it matters.', '');
  L.push(...summaryLines(links, apps).map((l) => `- ${l}`), '');
  const sec = (title, why, list, fmt, max = 100) => {
    if (!list.length) return;
    L.push(`## ${title} (${list.length})`, '', why, '');
    for (const c of list.slice(0, max)) L.push(`- ${fmt(c)}`);
    if (list.length > max) L.push(`- … and ${list.length - max} more in links.json`);
    L.push('');
  };
  const C = links.calls;
  sec('Calls with no matching route', 'Likely bugs, removed endpoints, or a route the readers could not parse. Each is a question for a developer.', C.filter((c) => c.status === 'no-route'), (c) => `\`${c.cite}\` (${c.app}) ${c.method} \`${c.uri || c.routeName || ''}\`${c.reason ? `: ${c.reason}` : ''}`);
  sec('Method mismatch', 'The path matches a route but the method differs.', C.filter((c) => c.status === 'method-mismatch'), (c) => `\`${c.cite}\` (${c.app}) ${c.method} \`${c.uri || c.routeName}\` -> route \`${c.route.key}\` in ${c.route.app}`);
  sec('Ambiguous calls', 'More than one route fits; add a links: fix to overrides.yaml.', C.filter((c) => c.status === 'ambiguous'), (c) => `\`${c.cite}\` (${c.app}) ${c.method} \`${c.uri}\` -> ${c.candidates.map((x) => `\`${x.key}\` (${x.app})`).join(' or ')}`);
  sec('Calls whose URL is only known at run time', 'The scripts cannot work out the path without running the app. Add the base-URL name to overrides.yaml (base_url_names:) or a links: fix.', C.filter((c) => c.status === 'unresolved'), (c) => `\`${c.cite}\` (${c.app}) ${c.method}: ${c.reason}`);
  sec('Calls to outside services', 'Calls to hosts that are not this system.', C.filter((c) => c.status === 'external'), (c) => `\`${c.cite}\` (${c.app}) ${c.method} ${c.host || ''}/${c.uri || ''}`, 40);
  sec('Calls with a route but no screen', 'Matched, but the call sits in a service or helper file rather than a screen; the folder (area) is shown.', C.filter((c) => c.status === 'matched' && !c.screen), (c) => `\`${c.cite}\` (${c.app}, ${c.area}) ${c.method} \`${c.uri || c.routeName}\` -> \`${c.route.key}\``, 60);
  for (const [id] of apps) {
    const rs = links.routes.filter((r) => r.app === id && !r.count);
    if (!rs.length) continue;
    const groups = new Map();
    for (const r of rs) {
      const g = r.key.split(' ')[1].split('/').slice(0, 2).join('/');
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(r);
    }
    L.push(`## Routes in ${id} that no app in this system calls (${rs.length})`, '', 'Possibly unused, or called from outside this system (other products, partners, webhooks, cron).', '');
    for (const [g, list] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) L.push(`- \`${g}\` (${list.length}): ${list.slice(0, 8).map((r) => `\`${r.key}\``).join(', ')}${list.length > 8 ? ', …' : ''}`);
    L.push('');
  }
  if (links.unusedOverrides.length) L.push('## Overrides that match no call', '', ...links.unusedOverrides.map((o) => `- \`${o}\``), '');
  return L.join('\n');
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.home) fail('usage: link.mjs --home HOME');
  const home = real(a.home);
  if (!docsDir(home)) fail('no sdlc-docs');
  const r = linkSystem(home);
  process.stdout.write(r.lines.join('\n') + `\nwrote sdlc-docs/_map/links.json and links.md\n`);
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) main();
