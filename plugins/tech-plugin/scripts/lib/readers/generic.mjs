// Generic fallback for stacks without a dedicated reader. Everything it finds
// is marked Inferred.
//   - route-like registrations that look the same in many languages:
//     Go (net/http, gin, echo, chi, fiber, gorilla/mux) and Rails config/routes.rb
//   - code groups: the graphify communities of the app's files, so stage 5
//     still has something to group into modules.

import { isTestFile, J, joinUri, makeRoute, markShadowed } from './common.mjs';

export function readGeneric({ root, files, src, graphGroups = [] }) {
  const routes = [];
  const unparsed = [];
  const go = files.filter((f) => f.endsWith('.go') && !isTestFile(f));
  for (const f of go) {
    const s = src(f);
    if (!s || !/HandleFunc|\.GET\(|\.Get\(|\.POST\(|\.Post\(|\.Handle\(|\.Group\(|\.Route\(/.test(s.code)) continue;
    const groupPrefix = new Map();
    for (const m of s.code.matchAll(/(\w+)\s*:?=\s*(\w+)\.Group\(\s*"([^"]*)"/g)) groupPrefix.set(m[1], joinUri(groupPrefix.get(m[2]) || '', m[3]));
    for (const m of s.code.matchAll(/\b(\w+)\.(GET|POST|PUT|PATCH|DELETE|Any|Get|Post|Put|Patch|Delete|HandleFunc|Handle|Method)\(\s*"([^"]*)"\s*,\s*([^)\n]*)/g)) {
      let method = m[2].toUpperCase();
      let path = m[3];
      if (/^(HANDLEFUNC|HANDLE)$/.test(method)) {
        const g = /^(GET|POST|PUT|PATCH|DELETE)\s+(\/.*)$/.exec(path);
        if (g) {
          method = g[1];
          path = g[2];
        } else method = 'ANY';
      }
      if (method === 'METHOD') continue;
      const h = m[4].split(',').pop().trim().replace(/\)+$/, '');
      routes.push(makeRoute({ method, uri: joinUri(groupPrefix.get(m[1]) || '', path), handler: `${f}#${h}`, handlerFile: f, action: h, file: f, line: s.lineAt(m.index), cls: 'Inferred' }));
    }
  }
  const rr = J(root, 'config/routes.rb');
  const rs = files.includes(rr) ? src(rr) : null;
  if (rs) {
    const stack = [];
    const lines = rs.code.split('\n');
    lines.forEach((l, i) => {
      const line = i + 1;
      let m;
      if ((m = /^\s*(?:namespace|scope)\s+(?::(\w+)|['"]\/?([\w\/]+)['"])[^\n]*\bdo\b/.exec(l))) {
        stack.push(m[1] || m[2]);
        return;
      }
      if (/^\s*end\b/.test(l)) {
        stack.pop();
        return;
      }
      if (/\bdo\b\s*(\|.*\|)?\s*$/.test(l)) stack.push('');
      const pre = joinUri(...stack);
      if ((m = /^\s*(get|post|put|patch|delete|match)\s+['"]([^'"]+)['"](?:.*?to:\s*['"](\w+)#(\w+)['"])?/.exec(l))) {
        routes.push(makeRoute({ method: m[1] === 'match' ? 'ANY' : m[1].toUpperCase(), uri: joinUri(pre, m[2]), handler: m[3] ? `${m[3]}#${m[4]}` : null, handlerFile: m[3] ? J(root, 'app/controllers', ...stack.filter(Boolean), `${m[3]}_controller.rb`) : rr, action: m[4] || null, file: rr, line, cls: 'Inferred' }));
      } else if ((m = /^\s*resources?\s+:(\w+)(.*)$/.exec(l))) {
        const only = /only:\s*\[([^\]]*)\]/.exec(m[2]);
        const keep = only ? [...only[1].matchAll(/:(\w+)/g)].map((x) => x[1]) : null;
        const single = /^\s*resource\s/.test(l);
        const acts = single
          ? [['show', 'GET', ''], ['create', 'POST', ''], ['update', 'PATCH', ''], ['update', 'PUT', ''], ['destroy', 'DELETE', '']]
          : [['index', 'GET', ''], ['create', 'POST', ''], ['new', 'GET', '/new'], ['show', 'GET', '/{id}'], ['edit', 'GET', '/{id}/edit'], ['update', 'PATCH', '/{id}'], ['update', 'PUT', '/{id}'], ['destroy', 'DELETE', '/{id}']];
        for (const [a, me, suf] of acts) {
          if (keep && !keep.includes(a)) continue;
          routes.push(makeRoute({ method: me, uri: joinUri(pre, m[1]) + suf, handler: `${m[1]}#${a}`, handlerFile: J(root, 'app/controllers', ...stack.filter(Boolean), `${m[1]}_controller.rb`), action: a, file: rr, line, kind: 'resource', cls: 'Inferred' }));
        }
      }
    });
  }
  markShadowed(routes);
  const groups = graphGroups.map((g) => ({ ...g, class: 'Inferred' }));
  const handlers = [...new Set(routes.map((r) => r.handlerFile))].map((f) => ({ id: f, name: f.split('/').pop(), file: f, cite: `${f}:1`, methods: [], tables: [], class: 'Inferred' }));
  return { routes, handlers, screens: [], models: [], tables: [], unparsed, notes: routes.length ? ['routes found by the generic reader (Inferred)'] : [], groups };
}
