// Flutter reader: screens (widget classes named *Screen / *Page / *View and
// every widget a route builds), routes (GoRouter GoRoute trees, MaterialApp
// route maps, GetX GetPage, auto_route AutoRoute), navigation between screens,
// and local database tables (sqflite CREATE TABLE, Drift tables).
// API calls (Dio, http, project helpers) come from calls.mjs.

import { closing, J, joinUri, normUri, tableGuess, uniq } from './common.mjs';

const WRAPPERS = new Set(['MaterialPage', 'CupertinoPage', 'CustomTransitionPage', 'NoTransitionPage', 'Scaffold', 'BlocProvider', 'MultiBlocProvider', 'ChangeNotifierProvider', 'MultiProvider', 'Provider', 'ProviderScope', 'Consumer', 'Builder', 'Text', 'Center', 'SizedBox', 'Container', 'Key', 'ValueKey', 'GlobalKey', 'UniqueKey', 'GoRoute', 'ShellRoute', 'StatefulShellRoute', 'Uri', 'RouteSettings', 'BlocBuilder', 'Obx', 'GetPage', 'MaterialPageRoute', 'CupertinoPageRoute', 'PageRouteBuilder']);

export function readFlutter({ root, files, src }) {
  const lib = J(root, 'lib') + '/';
  const dart = files.filter((f) => f.startsWith(lib) && f.endsWith('.dart') && !/\.(g|freezed|gr|mocks|config)\.dart$/.test(f));
  const widgets = new Map();
  for (const f of dart) {
    const s = src(f);
    if (!s) continue;
    for (const m of s.mask.matchAll(/\bclass\s+([A-Z]\w*)\s+extends\s+(StatelessWidget|StatefulWidget|ConsumerWidget|ConsumerStatefulWidget|HookWidget|HookConsumerWidget|GetView\s*<[^>]*>|GetWidget\s*<[^>]*>|StatelessWidget|BaseScreen\w*|Base\w*(?:Screen|Page|View|Widget)\w*)/g)) {
      widgets.set(m[1], { file: f, line: s.lineAt(m.index) });
    }
  }
  const routes = [];
  const addRoute = (path, screen, name, file, line, kind) => routes.push({ path: path === null ? null : normUri(path), screen, name, cite: `${file}:${line}`, kind });

  for (const f of dart) {
    const s = src(f);
    if (!s) continue;
    const { code, mask } = s;
    // GoRoute trees
    const spans = [];
    for (const m of mask.matchAll(/\b(GoRoute|ShellRoute)\s*\(/g)) {
      const open = m.index + m[0].length - 1;
      const close = closing(mask, open);
      if (close !== -1) spans.push({ kind: m[1], start: open, end: close, at: m.index });
    }
    // the text of a route without the routes nested in it
    const ownText = (sp0) => {
      const inner = spans.filter((o) => o !== sp0 && o.start > sp0.start && o.end < sp0.end);
      let t = '';
      let k = sp0.start;
      for (const o of inner.sort((a, b) => a.at - b.at)) {
        if (o.at < k) continue;
        t += code.slice(k, o.at) + ' '.repeat(o.end + 1 - o.at);
        k = o.end + 1;
      }
      return t + code.slice(k, sp0.end);
    };
    for (const sp of spans) {
      if (sp.kind !== 'GoRoute') continue;
      const text = ownText(sp);
      const p = /\bpath\s*:\s*(['"])([^'"]*)\1/.exec(text);
      const n = /\bname\s*:\s*(['"])([^'"]*)\1/.exec(text) || /\bname\s*:\s*([\w.]+)/.exec(text);
      let screen = null;
      for (const c of text.matchAll(/\b([A-Z]\w*)\s*(?:<[^>]*>)?\s*\(/g)) {
        if (WRAPPERS.has(c[1])) continue;
        if (widgets.has(c[1])) {
          screen = c[1];
          break;
        }
        if (!screen && /(Screen|Page|View)$/.test(c[1])) screen = c[1];
      }
      // parent paths
      const parents = spans.filter((o) => o.kind === 'GoRoute' && o !== sp && o.start < sp.start && o.end > sp.end).sort((a, b) => a.start - b.start);
      let full = '';
      for (const par of [...parents, sp]) {
        const pt = /\bpath\s*:\s*(['"])([^'"]*)\1/.exec(ownText(par));
        const seg = par === sp ? (p ? p[2] : '') : pt ? pt[2] : '';
        full = seg.startsWith('/') ? seg : joinUri(full, seg);
      }
      addRoute(p ? full : null, screen, n ? n[2] || n[1] : null, f, s.lineAt(sp.at), 'go_router');
    }
    // MaterialApp routes: { '/x': (context) => XScreen() }
    for (const m of code.matchAll(/(['"])(\/[^'"]*)\1\s*:\s*\([^)]*\)\s*=>\s*(?:const\s+)?([A-Z]\w*)/g)) addRoute(m[2], m[3], null, f, s.lineAt(m.index), 'routes-map');
    // GetX
    for (const m of code.matchAll(/GetPage\s*\(\s*name\s*:\s*(['"])([^'"]*)\1\s*,\s*page\s*:\s*\(\)\s*=>\s*(?:const\s+)?([A-Z]\w*)/g)) addRoute(m[2], m[3], null, f, s.lineAt(m.index), 'getx');
    // auto_route
    for (const m of code.matchAll(/AutoRoute\s*\(([^)]*)\)/g)) {
      const pg = /page\s*:\s*([A-Z]\w*?)(?:Route)?(?:\.page)?\b/.exec(m[1]);
      const pt = /path\s*:\s*(['"])([^'"]*)\1/.exec(m[1]);
      if (pg) addRoute(pt ? pt[2] : null, [...widgets.keys()].find((w) => w === pg[1] || w === pg[1] + 'Screen' || w === pg[1] + 'Page') || pg[1], null, f, s.lineAt(m.index), 'auto_route');
    }
  }

  // screens: named like screens, or built by a route
  const routed = new Set(routes.map((r) => r.screen).filter(Boolean));
  const screens = [];
  for (const [name, w] of widgets) {
    if (!/(Screen|Page|View)$/.test(name) && !routed.has(name)) continue;
    const rs = routes.filter((r) => r.screen === name);
    screens.push({ id: name, name, file: w.file, cite: `${w.file}:${w.line}`, path: rs.length && rs[0].path ? rs[0].path : null, routeName: rs.length ? rs[0].name : null, kind: 'flutter', renderedBy: [], links: [], partial: false, class: 'Verified' });
  }
  for (const r of routes) if (r.screen && !widgets.has(r.screen)) screens.push({ id: r.screen, name: r.screen, file: null, cite: r.cite, path: r.path, kind: 'flutter', renderedBy: [], links: [], partial: false, class: 'Inferred', note: 'class file not found' });

  // navigation per file -> links of the screens in that file
  const byFile = new Map();
  for (const sc of screens) if (sc.file) byFile.set(sc.file, (byFile.get(sc.file) || []).concat(sc));
  for (const f of dart) {
    const s = src(f);
    if (!s || !byFile.has(f)) continue;
    const links = [];
    for (const m of s.code.matchAll(/(?:context|GoRouter\.of\(context\)|router|Get)\s*\.\s*(go|push|pushReplacement|replace|toNamed|offNamed|offAllNamed)\s*\(\s*(['"])([^'"]+)\2/g)) links.push({ kind: 'path', target: normUri(m[3]) });
    for (const m of s.code.matchAll(/\.\s*(goNamed|pushNamed|pushReplacementNamed)\s*\(\s*(?:context\s*,\s*)?(['"])([^'"]+)\2/g)) links.push({ kind: m[3].startsWith('/') ? 'path' : 'route-name', target: m[3].startsWith('/') ? normUri(m[3]) : m[3] });
    for (const m of s.code.matchAll(/(?:MaterialPageRoute|CupertinoPageRoute)\s*\(\s*builder\s*:\s*\([^)]*\)\s*=>\s*(?:const\s+)?([A-Z]\w*)/g)) links.push({ kind: 'screen', target: m[1] });
    const seen = new Set();
    const ul = links.filter((l) => !seen.has(l.kind + l.target) && seen.add(l.kind + l.target));
    for (const sc of byFile.get(f)) sc.links = ul;
  }

  // local tables
  const tables = [];
  for (const f of dart) {
    const s = src(f);
    if (!s) continue;
    for (const m of s.text.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?(\w+)/gi)) tables.push({ name: m[1], cite: `${f}:${s.lineAt(m.index)}`, source: 'local database (sqflite)', columns: [], models: [], class: 'Verified', local: true });
    for (const m of s.mask.matchAll(/\bclass\s+([A-Z]\w*)\s+extends\s+Table\b/g)) tables.push({ name: tableGuess(m[1]).replace(/s$/, '') === m[1].toLowerCase() ? m[1].toLowerCase() : tableGuess(m[1]), cite: `${f}:${s.lineAt(m.index)}`, source: 'local database (Drift)', columns: [], models: [m[1]], class: 'Inferred', local: true });
  }

  const unresolvedRoutes = routes.filter((r) => !r.screen);
  return {
    routes: [],
    screenRoutes: routes,
    handlers: [],
    screens,
    models: [],
    tables: uniqTables(tables),
    unparsed: unresolvedRoutes.map((r) => ({ cite: r.cite, text: `${r.kind} route ${r.path || ''} without a screen class` })),
    notes: [`${widgets.size} widget classes, ${screens.length} screens, ${routes.length} routes`],
  };
}

function uniqTables(t) {
  const seen = new Map();
  for (const x of t) if (!seen.has(x.name)) seen.set(x.name, x);
  return [...seen.values()];
}

export { uniq };
