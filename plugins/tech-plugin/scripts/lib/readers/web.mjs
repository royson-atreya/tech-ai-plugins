// Web front-end reader: screens (pages) and the API routes a web framework
// serves itself.
//   Next.js   pages/ (pages router, pages/api/*) and app/ (page.tsx, route.ts)
//   Nuxt      pages/*.vue, server/api/*
//   SvelteKit src/routes/**/+page.svelte, +server.ts
//   Remix     app/routes/*
//   React Router (<Route path element> and route objects), Vue Router and
//   Angular route tables ({ path, component }), with nested children.
// Without any router, files in src/pages|views|screens are listed as screens
// (Inferred).

import { closing, isTestFile, J, joinUri, makeRoute, markShadowed, normUri } from './common.mjs';
import { importsOf } from './node.mjs';

const PAGE_EXT = /\.(tsx|jsx|ts|js|mdx|vue|svelte)$/;
const HTTP = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

function segPath(segs) {
  return normUri(
    segs
      .filter((x) => !/^\(.*\)$/.test(x) && !x.startsWith('@') && x !== 'index' && x !== '_index')
      .map((x) => x.replace(/^\$(\w+)$/, '[$1]').replace(/^\[\[?\.\.\.(\w+)\]?\]$/, '[$1]'))
      .join('/'),
  );
}

function exportedMethods(code) {
  const out = new Set();
  for (const m of code.matchAll(/export\s+(?:async\s+)?(?:function|const|let)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)) out.add(m[1]);
  return [...out];
}

export function readWeb({ root, files, src, stack }) {
  const screens = [];
  const routes = [];
  const all = new Set(files);
  const under = (dir) => files.filter((f) => f.startsWith(J(root, dir) + '/'));
  const addScreen = (id, file, path, kind, cls = 'Verified') => {
    if (screens.some((s) => s.file === file && s.path === path && file)) return;
    screens.push({ id, name: id, file, cite: file ? `${file}:1` : null, path, kind, renderedBy: [], links: [], partial: false, class: cls });
  };
  const has = (n) => stack.includes(n);

  if (has('Next.js')) {
    for (const dir of ['pages', 'src/pages']) {
      const base = J(root, dir) + '/';
      for (const f of under(dir).filter((x) => PAGE_EXT.test(x))) {
        const rel = f.slice(base.length).replace(PAGE_EXT, '');
        const segs = rel.split('/');
        if (/^_(app|document|error)$/.test(segs[segs.length - 1]) || segs[segs.length - 1] === '404' || segs[segs.length - 1] === '500') continue;
        if (segs[0] === 'api') {
          const s = src(f);
          const meths = s ? [...new Set([...s.code.matchAll(/req\.method\s*===?\s*['"](\w+)['"]|case\s+['"](GET|POST|PUT|PATCH|DELETE)['"]/g)].map((m) => (m[1] || m[2]).toUpperCase()))] : [];
          for (const me of meths.length ? meths : ['ANY']) routes.push(makeRoute({ method: me, uri: segPath(segs), handler: `${f}#handler`, handlerFile: f, action: 'handler', file: f, line: 1, kind: 'api-route', cls: meths.length ? 'Verified' : 'Inferred' }));
        } else addScreen(segPath(segs), f, segPath(segs), 'next-page');
      }
    }
    for (const dir of ['app', 'src/app']) {
      const base = J(root, dir) + '/';
      for (const f of under(dir)) {
        const rel = f.slice(base.length);
        const segs = rel.split('/');
        const leaf = segs.pop();
        if (/^page\.(tsx|jsx|js|ts|mdx)$/.test(leaf)) addScreen(segPath(segs), f, segPath(segs), 'next-page');
        else if (/^route\.(ts|js)$/.test(leaf)) {
          const s = src(f);
          const meths = s ? exportedMethods(s.code) : [];
          for (const me of meths.length ? meths : ['ANY']) routes.push(makeRoute({ method: me, uri: segPath(segs), handler: `${f}#${me}`, handlerFile: f, action: me, file: f, line: s ? s.lineAt(Math.max(0, s.code.indexOf(me))) : 1, kind: 'api-route' }));
        }
      }
    }
  }
  if (has('Nuxt')) {
    for (const f of under('pages').filter((x) => x.endsWith('.vue'))) {
      const segs = f.slice(J(root, 'pages').length + 1).replace(/\.vue$/, '').split('/');
      addScreen(segPath(segs), f, segPath(segs), 'nuxt-page');
    }
    for (const f of under('server/api').filter((x) => /\.(ts|js)$/.test(x))) {
      const rel = f.slice(J(root, 'server').length + 1).replace(/\.(ts|js)$/, '');
      const m = /\.(get|post|put|patch|delete)$/.exec(rel);
      routes.push(makeRoute({ method: m ? m[1].toUpperCase() : 'ANY', uri: segPath(rel.replace(/\.(get|post|put|patch|delete)$/, '').split('/')), handler: `${f}#default`, handlerFile: f, action: 'default', file: f, line: 1, kind: 'api-route' }));
    }
  }
  if (has('SvelteKit')) {
    const base = J(root, 'src/routes') + '/';
    for (const f of under('src/routes')) {
      const segs = f.slice(base.length).split('/');
      const leaf = segs.pop();
      if (/^\+page\.svelte$/.test(leaf)) addScreen(segPath(segs), f, segPath(segs), 'svelte-page');
      else if (/^\+server\.(ts|js)$/.test(leaf)) {
        const s = src(f);
        for (const me of (s ? exportedMethods(s.code) : []).concat(s && exportedMethods(s.code).length ? [] : ['ANY'])) routes.push(makeRoute({ method: me, uri: segPath(segs), handler: `${f}#${me}`, handlerFile: f, action: me, file: f, line: 1, kind: 'api-route' }));
      }
    }
  }
  if (has('Remix')) {
    for (const f of under('app/routes').filter((x) => PAGE_EXT.test(x))) {
      const name = f.slice(J(root, 'app/routes').length + 1).replace(PAGE_EXT, '').replace(/\/route$/, '');
      const segs = name.split(/[./]/).map((x) => x.replace(/^_+|_+$/g, '')).filter(Boolean);
      addScreen(segPath(segs), f, segPath(segs), 'remix-route');
    }
  }

  // route tables in code: React Router, Vue Router, Angular
  const codeFiles = files.filter((f) => /\.(tsx|jsx|ts|js|vue)$/.test(f) && !isTestFile(f));
  for (const f of codeFiles) {
    const s = src(f);
    if (!s || !/\bpath\s*[:=]/.test(s.code)) continue;
    if (!/<Route\b|createBrowserRouter|createRouter|RouterModule|Routes\s*=|routes\s*[:=]\s*\[|useRoutes|createHashRouter|VueRouter|RouteObject/.test(s.code)) continue;
    const imps = importsOf(f, s.code, all);
    const fileOf = (name) => (imps.has(name) && imps.get(name).file) || null;
    // JSX <Route path="x" element={<X />} />, nested by tag depth
    const stack = [];
    for (const m of s.code.matchAll(/<Route\b([^>]*?)(\/?)>|<\/Route>/g)) {
      if (m[0] === '</Route>') {
        stack.pop();
        continue;
      }
      const attrs = m[1];
      const p = /\bpath\s*=\s*["'{]\s*["'`]?([^"'`}]*)/.exec(attrs);
      const el = /\belement\s*=\s*\{\s*<\s*([A-Z][\w.]*)/.exec(attrs) || /\bcomponent\s*=\s*\{\s*([A-Z][\w.]*)/.exec(attrs) || /\bComponent\s*=\s*\{\s*([A-Z][\w.]*)/.exec(attrs);
      const parent = stack.length ? stack[stack.length - 1] : '';
      const full = p ? (p[1].startsWith('/') ? p[1] : joinUri(parent, p[1])) : parent;
      if (el) addScreen(el[1], fileOf(el[1]) || f, normUri(full), 'react-route', fileOf(el[1]) ? 'Verified' : 'Inferred');
      if (!m[2]) stack.push(full);
    }
    // { path: 'x', element: <X/> | component: X | loadComponent | children: [...] }
    const objs = [];
    for (const m of s.mask.matchAll(/\{\s*path\s*:\s*['"`]/g)) {
      const close = closing(s.mask, m.index);
      if (close === -1) continue;
      objs.push({ start: m.index, end: close });
    }
    for (const o of objs) {
      const inner = objs.filter((x) => x !== o && x.start > o.start && x.end < o.end);
      let text = s.code.slice(o.start, o.end);
      for (const x of inner) text = text.slice(0, x.start - o.start) + ' '.repeat(x.end - x.start) + text.slice(x.end - o.start);
      const p = /path\s*:\s*['"`]([^'"`]*)['"`]/.exec(text);
      const parents = objs.filter((x) => x !== o && x.start < o.start && x.end > o.end).sort((a, b) => a.start - b.start);
      let full = '';
      for (const par of [...parents, o]) {
        const pt = /path\s*:\s*['"`]([^'"`]*)['"`]/.exec(s.code.slice(par.start, par.end));
        const seg = pt ? pt[1] : '';
        full = seg.startsWith('/') ? seg : joinUri(full, seg);
      }
      const el = /\belement\s*:\s*<\s*([A-Z][\w.]*)/.exec(text) || /\b(?:component|Component)\s*:\s*([A-Z][\w.]*)/.exec(text);
      const lazy = /(?:loadComponent|component|lazy)\s*:\s*\(\)\s*=>\s*import\(\s*['"]([^'"]+)['"]\s*\)(?:\.then\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\.(\w+)\))?/.exec(text);
      if (!p) continue;
      if (lazy) {
        const lf = resolveFrom(f, lazy[1], all);
        addScreen(lazy[2] || (lf ? lf.split('/').pop().replace(/\.\w+$/, '') : lazy[1]), lf, normUri(full), 'route-table', lf ? 'Verified' : 'Inferred');
      } else if (el) addScreen(el[1], fileOf(el[1]) || f, normUri(full), 'route-table', fileOf(el[1]) ? 'Verified' : 'Inferred');
    }
  }

  if (!screens.length) {
    for (const f of files.filter((x) => /\/(pages|views|screens|routes)\//.test(x) && /\.(tsx|jsx|vue|svelte)$/.test(x) && !isTestFile(x))) {
      const name = f.split('/').pop().replace(/\.\w+$/, '');
      addScreen(name, f, null, 'component', 'Inferred');
    }
  }
  markShadowed(routes);
  return { routes, handlers: routes.map((r) => ({ id: r.handlerFile, name: r.handlerFile.split('/').pop(), file: r.handlerFile, cite: `${r.handlerFile}:1`, methods: [], tables: [] })).filter((h, i, a) => a.findIndex((x) => x.id === h.id) === i), screens, models: [], tables: [], unparsed: [], notes: [] };
}

function resolveFrom(from, spec, all) {
  if (!spec.startsWith('.') && !spec.startsWith('@/') && !spec.startsWith('~/')) return null;
  if (!spec.startsWith('.')) {
    const rest = spec.slice(2);
    const roots = [...all].filter((x) => x.includes('/src/') || x.startsWith('src/'));
    const srcRoot = roots.length ? roots[0].slice(0, roots[0].indexOf('src/') + 3) : 'src';
    return [J(srcRoot, rest), ...['.ts', '.tsx', '.js', '.jsx', '.vue'].map((e) => J(srcRoot, rest) + e)].find((c) => all.has(c)) || null;
  }
  const dir = from.split('/').slice(0, -1);
  for (const p of spec.split('/')) {
    if (p === '..') dir.pop();
    else if (p !== '.') dir.push(p);
  }
  const base = dir.join('/');
  return [base, ...['.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte'].map((e) => base + e), ...['ts', 'tsx', 'js', 'jsx'].map((e) => `${base}/index.${e}`)].find((c) => all.has(c)) || null;
}

export const HTTP_METHODS = HTTP;
