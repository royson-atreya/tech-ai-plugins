// Python reader: FastAPI / Starlette / Flask routes (decorators, APIRouter
// and Blueprint prefixes, include_router / register_blueprint followed across
// modules), Django URLconfs (path, re_path, include, DRF routers, function
// and class-based views, templates rendered), and tables from SQLAlchemy,
// SQLModel, Django models and Alembic migrations.

import { closing, isTestFile, J, joinUri, makeRoute, markShadowed, normUri, splitArgs, uniq } from './common.mjs';

function modFile(fromFile, mod, files, root) {
  const set = files;
  if (mod.startsWith('.')) {
    const dots = /^\.+/.exec(mod)[0].length;
    const dir = fromFile.split('/').slice(0, -1);
    for (let i = 1; i < dots; i++) dir.pop();
    const rest = mod.slice(dots).split('.').filter(Boolean);
    const base = [...dir, ...rest].join('/');
    return [`${base}.py`, `${base}/__init__.py`].find((c) => set.has(c)) || null;
  }
  const p = mod.split('.').join('/');
  for (const pre of [root, J(root, 'src'), J(root, 'app'), '.']) {
    const c = [J(pre, p) + '.py', J(pre, p, '__init__.py')].find((x) => set.has(x));
    if (c) return c;
  }
  // last resort: any file ending with the module path
  return [...set].find((x) => x.endsWith(`/${p}.py`)) || null;
}

// local name -> { file, attr }
function pyImports(file, code, files, root) {
  const map = new Map();
  for (const m of code.matchAll(/^\s*from\s+([\w.]+)\s+import\s+\(?([\w\s,]+?)\)?\s*$/gm)) {
    for (const part of m[2].split(',')) {
      const [a, b] = part.trim().split(/\s+as\s+/);
      if (!a) continue;
      const asModule = modFile(file, m[1].endsWith('.') ? m[1] + a : `${m[1]}.${a}`, files, root);
      map.set((b || a).trim(), asModule ? { file: asModule, attr: null } : { file: modFile(file, m[1], files, root), attr: a });
    }
  }
  for (const m of code.matchAll(/^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?\s*$/gm)) map.set(m[2] || m[1].split('.')[0], { file: modFile(file, m[1], files, root), attr: null });
  return map;
}

export function readPython({ root, files, src, stack }) {
  const all = new Set(files);
  const py = files.filter((f) => f.endsWith('.py') && !isTestFile(f));
  const routes = [];
  const unparsed = [];
  const notes = [];
  const handlerFiles = new Set();

  // ---- FastAPI / Flask / Starlette
  const own = new Map(); // "file#var" -> { prefix, isApp }
  const decos = [];
  const mounts = [];
  for (const f of py) {
    const s = src(f);
    if (!s || !/FastAPI|APIRouter|Flask|Blueprint|Starlette|\.route\(|include_router|register_blueprint/.test(s.code)) continue;
    const imps = pyImports(f, s.code, all, root);
    for (const m of s.code.matchAll(/^(\w+)\s*(?::\s*\w+\s*)?=\s*(FastAPI|APIRouter|Flask|Blueprint|Starlette|Sanic)\s*\(/gm)) {
      const open = s.code.indexOf('(', m.index + m[0].length - 1);
      const close = closing(s.mask, open);
      const args = s.code.slice(open, close);
      const pre = /(?:url_)?prefix\s*=\s*['"]([^'"]*)['"]/.exec(args);
      own.set(`${f}#${m[1]}`, { prefix: pre ? pre[1] : '', isApp: /FastAPI|Flask|Starlette|Sanic/.test(m[2]) });
    }
    for (const m of s.mask.matchAll(/^[ \t]*@(\w+)\.(get|post|put|patch|delete|options|head|route|api_route|websocket)\s*\(/gm)) {
      const open = m.index + m[0].length - 1;
      const close = closing(s.mask, open);
      const args = splitArgs(s.mask, open + 1, close);
      const p = args[0] ? /^\s*[rbuf]?(['"])(.*)\1\s*$/.exec(s.code.slice(args[0].start, args[0].end)) : null;
      const line = s.lineAt(m.index);
      const def = /\n[ \t]*(?:async\s+)?def\s+(\w+)/.exec(s.code.slice(close));
      if (!p) {
        unparsed.push({ cite: `${f}:${line}`, text: s.code.slice(m.index, close + 1).trim().slice(0, 140) });
        continue;
      }
      let methods = [m[2].toUpperCase()];
      if (m[2] === 'route' || m[2] === 'api_route') {
        const mm = /methods\s*=\s*\[([^\]]*)\]/.exec(s.code.slice(open, close));
        methods = mm ? [...mm[1].matchAll(/['"](\w+)['"]/g)].map((x) => x[1].toUpperCase()) : ['GET'];
      }
      if (m[2] === 'websocket') methods = ['WS'];
      decos.push({ file: f, v: m[1], path: p[2], methods, handler: def ? def[1] : '?', line });
    }
    for (const m of s.code.matchAll(/(\w+)\.(include_router|register_blueprint|mount)\(\s*([\w.]+)(?:\s*\(\s*\))?([^)]*)\)/g)) {
      const pre = /(?:url_)?prefix\s*=\s*['"]([^'"]*)['"]/.exec(m[4]) || (m[2] === 'mount' ? null : null);
      let target = m[3];
      let tf = null;
      let tv = null;
      if (target.includes('.')) {
        const [a, b] = target.split('.');
        if (imps.has(a) && imps.get(a).file) {
          tf = imps.get(a).file;
          tv = b;
        }
      } else if (imps.has(target)) {
        const i = imps.get(target);
        tf = i.file;
        tv = i.attr || target;
      } else {
        tf = f;
        tv = target;
      }
      mounts.push({ file: f, v: m[1], tf, tv, prefix: pre ? pre[1] : '' });
    }
  }
  const total = new Map();
  for (const [k, v] of own) if (v.isApp) total.set(k, v.prefix);
  for (let round = 0; round < 8; round++) {
    let changed = false;
    for (const mo of mounts) {
      const parentKey = `${mo.file}#${mo.v}`;
      const parent = total.has(parentKey) ? total.get(parentKey) : own.has(parentKey) ? own.get(parentKey).prefix : '';
      if (!mo.tf) continue;
      const k = `${mo.tf}#${mo.tv}`;
      const p = joinUri(parent, mo.prefix, own.has(k) ? own.get(k).prefix : '');
      if (total.get(k) !== p) {
        total.set(k, p);
        changed = true;
      }
    }
    if (!changed) break;
  }
  for (const d of decos) {
    const k = `${d.file}#${d.v}`;
    const prefix = total.has(k) ? total.get(k) : own.has(k) ? own.get(k).prefix : '';
    handlerFiles.add(d.file);
    for (const me of d.methods) routes.push(makeRoute({ method: me, uri: joinUri(prefix, d.path), handler: `${d.file}#${d.handler}`, handlerFile: d.file, action: d.handler, file: d.file, line: d.line, cls: own.has(k) || total.has(k) ? 'Verified' : 'Inferred' }));
  }

  // ---- Django
  const screens = [];
  if (stack.includes('Django')) {
    const settings = py.find((f) => /settings(\/[\w]+)?\.py$/.test(f) && /ROOT_URLCONF/.test((src(f) || {}).code || ''));
    const rootConf = settings ? (/ROOT_URLCONF\s*=\s*['"]([\w.]+)['"]/.exec(src(settings).code) || [])[1] : null;
    const urlFiles = py.filter((f) => /(^|\/)urls\.py$/.test(f) || /(^|\/)urls\/[\w]+\.py$/.test(f));
    const start = rootConf ? modFile(J(root, 'x.py'), rootConf, all, root) : null;
    const seen = new Set();
    const viewsCache = new Map();
    const parseConf = (file, prefix, depth) => {
      if (!file || seen.has(`${file}|${prefix}`) || depth > 6) return;
      seen.add(`${file}|${prefix}`);
      const s = src(file);
      if (!s) return;
      const imps = pyImports(file, s.code, all, root);
      const drf = new Map();
      for (const m of s.code.matchAll(/(\w+)\.register\(\s*r?['"]([^'"]*)['"]\s*,\s*([\w.]+)/g)) {
        if (!drf.has(m[1])) drf.set(m[1], []);
        drf.get(m[1]).push({ path: m[2], view: m[3], line: s.lineAt(m.index) });
      }
      for (const m of s.mask.matchAll(/\b(path|re_path|url)\s*\(/g)) {
        const open = m.index + m[0].length - 1;
        const close = closing(s.mask, open);
        const args = splitArgs(s.mask, open + 1, close);
        if (args.length < 2) continue;
        const line = s.lineAt(m.index);
        const rawP = /^\s*r?(['"])(.*)\1\s*$/.exec(s.code.slice(args[0].start, args[0].end));
        if (!rawP) {
          unparsed.push({ cite: `${file}:${line}`, text: s.code.slice(m.index, close + 1).trim().slice(0, 140) });
          continue;
        }
        let p = rawP[2];
        if (m[1] !== 'path') p = p.replace(/^\^/, '').replace(/\$$/, '').replace(/\(\?P<(\w+)>[^)]*\)/g, '{$1}');
        const full = joinUri(prefix, p);
        const target = s.code.slice(args[1].start, args[1].end).trim();
        const inc = /^include\(\s*(?:\(\s*)?(?:['"]([\w.]+)['"]|([\w.]+))/.exec(target);
        if (inc) {
          if (inc[1]) parseConf(modFile(file, inc[1], all, root), full, depth + 1);
          else if (inc[2] && /\.urls$/.test(inc[2]) && drf.has(inc[2].split('.')[0])) {
            for (const r of drf.get(inc[2].split('.')[0])) for (const [me, suffix, act] of [['GET', '', 'list'], ['POST', '', 'create'], ['GET', '/{pk}', 'retrieve'], ['PUT', '/{pk}', 'update'], ['PATCH', '/{pk}', 'partial_update'], ['DELETE', '/{pk}', 'destroy']]) {
              const vf = viewFile(file, r.view, imps);
              if (vf && !viewsetHas(vf, r.view, act)) continue;
              if (vf) handlerFiles.add(vf);
              routes.push(makeRoute({ method: me, uri: joinUri(full, r.path) + suffix, handler: `${vf || file}#${r.view.split('.').pop()}.${act}`, handlerFile: vf || file, action: act, file, line: r.line, kind: 'viewset', cls: vf ? 'Verified' : 'Inferred' }));
            }
          } else if (inc[2]) {
            const i = imps.get(inc[2].split('.')[0]);
            parseConf(i && i.file, full, depth + 1);
          }
          continue;
        }
        const name = (/name\s*=\s*['"]([^'"]+)['"]/.exec(s.code.slice(open, close)) || [])[1] || null;
        const view = target.replace(/\.as_view\([\s\S]*\)$/, '');
        const vf = viewFile(file, view, imps);
        if (vf) handlerFiles.add(vf);
        const meths = vf ? viewMethods(vf, view.split('.').pop(), /as_view/.test(target)) : [];
        for (const me of meths.length ? meths : ['ANY']) routes.push(makeRoute({ method: me, uri: full, handler: `${vf || file}#${view.split('.').pop()}`, handlerFile: vf || file, action: view.split('.').pop(), name, file, line, cls: meths.length ? 'Verified' : 'Inferred' }));
      }
    };
    const viewFile = (file, view, imps) => {
      const head = view.split('.')[0];
      if (imps.has(head)) {
        const i = imps.get(head);
        return i.file;
      }
      return null;
    };
    const viewsetHas = (vf, view, act) => {
      const s = src(vf);
      if (!s) return true;
      const cls = view.split('.').pop();
      const m = new RegExp(`class\\s+${cls}\\s*\\(([^)]*)\\)`).exec(s.code);
      if (!m) return true;
      if (/ReadOnlyModelViewSet/.test(m[1])) return act === 'list' || act === 'retrieve';
      if (/ModelViewSet/.test(m[1])) return true;
      return new RegExp(`def\\s+${act}\\s*\\(`).test(s.code);
    };
    const viewMethods = (vf, name, cbv) => {
      const key = `${vf}#${name}`;
      if (viewsCache.has(key)) return viewsCache.get(key);
      const s = src(vf);
      let out = [];
      if (s) {
        if (cbv) {
          const m = new RegExp(`class\\s+${name}\\s*\\([^)]*\\)\\s*:`).exec(s.code);
          if (m) {
            const body = s.code.slice(m.index, m.index + 20000).split(/\nclass\s/)[0];
            out = [...body.matchAll(/def\s+(get|post|put|patch|delete)\s*\(\s*self/g)].map((x) => x[1].toUpperCase());
          }
        } else {
          const m = new RegExp(`((?:@[^\\n]+\\n\\s*)*)def\\s+${name}\\s*\\(`).exec(s.code);
          if (m) {
            const dec = m[1];
            const api = /@(?:api_view|require_http_methods)\(\s*\[([^\]]*)\]/.exec(dec);
            if (api) out = [...api[1].matchAll(/['"](\w+)['"]/g)].map((x) => x[1].toUpperCase());
            else if (/@require_GET/.test(dec)) out = ['GET'];
            else if (/@require_POST/.test(dec)) out = ['POST'];
          }
        }
      }
      out = uniq(out);
      viewsCache.set(key, out);
      return out;
    };
    if (start) parseConf(start, '', 0);
    else for (const f of urlFiles) parseConf(f, '', 0);
    if (!start && urlFiles.length > 1) notes.push('ROOT_URLCONF not found; every urls.py was read from the root (prefixes from include() may be missing)');
    // templates rendered by views
    const tpl = files.filter((f) => /\/templates\//.test(f) && /\.html?$/.test(f));
    for (const f of [...handlerFiles]) {
      const s = src(f);
      if (!s) continue;
      for (const m of s.code.matchAll(/render\(\s*request\s*,\s*['"]([\w\/.-]+)['"]/g)) {
        const tf = tpl.find((t) => t.endsWith(`/templates/${m[1]}`));
        if (!screens.some((x) => x.id === m[1])) screens.push({ id: m[1], name: m[1], file: tf || null, cite: tf ? `${tf}:1` : `${f}:${s.lineAt(m.index)}`, path: null, kind: 'django-template', renderedBy: [f], links: [], partial: false, class: tf ? 'Verified' : 'Inferred' });
      }
    }
  }
  markShadowed(routes);

  // ---- tables
  const tables = [];
  const models = [];
  const addT = (name, cite, source, model, cls = 'Verified') => {
    const t = tables.find((x) => x.name === name);
    if (t) {
      if (model && !t.models.includes(model)) t.models.push(model);
      return;
    }
    tables.push({ name, cite, source, columns: [], models: model ? [model] : [], class: cls });
    if (model) models.push({ name: model, table: name, file: cite.split(':')[0], cite, relations: [] });
  };
  for (const f of files.filter((x) => x.endsWith('.py'))) {
    const s = src(f);
    if (!s || !/__tablename__|Table\(|models\.Model|create_table|SQLModel/.test(s.code)) continue;
    for (const m of s.code.matchAll(/class\s+(\w+)\s*\(([^)]*)\)\s*:(?:(?!\nclass\s)[\s\S]){0,3000}?__tablename__\s*=\s*['"](\w+)['"]/g)) addT(m[3], `${f}:${s.lineAt(m.index)}`, 'SQLAlchemy model', m[1]);
    for (const m of s.code.matchAll(/\bTable\(\s*['"](\w+)['"]\s*,\s*\w*metadata/gi)) addT(m[1], `${f}:${s.lineAt(m.index)}`, 'SQLAlchemy table', null);
    for (const m of s.code.matchAll(/class\s+(\w+)\s*\([^)]*SQLModel[^)]*table\s*=\s*True[^)]*\)/g)) addT(m[1].toLowerCase(), `${f}:${s.lineAt(m.index)}`, 'SQLModel', m[1], 'Inferred');
    if (/(^|\/)models(\.py|\/)/.test(f)) {
      const app = f.split('/').filter((x) => x !== 'models' && x !== 'models.py').slice(-1)[0] || 'app';
      for (const m of s.code.matchAll(/class\s+(\w+)\s*\(\s*(?:models\.)?Model\s*\)\s*:/g)) {
        const body = s.code.slice(m.index, m.index + 5000).split(/\nclass\s/)[0];
        const dbt = /db_table\s*=\s*['"](\w+)['"]/.exec(body);
        addT(dbt ? dbt[1] : `${app}_${m[1].toLowerCase()}`, `${f}:${s.lineAt(m.index)}`, 'Django model', m[1], dbt ? 'Verified' : 'Inferred');
      }
    }
    for (const m of s.code.matchAll(/op\.create_table\(\s*['"](\w+)['"]/g)) addT(m[1], `${f}:${s.lineAt(m.index)}`, 'Alembic migration', null);
  }
  const handlers = [...handlerFiles].map((f) => {
    const s = src(f);
    const t = s ? models.filter((m) => new RegExp(`\\b${m.name}\\b`).test(s.code)).map((m) => m.table) : [];
    return { id: f, name: f.split('/').pop(), file: f, cite: `${f}:1`, methods: [], tables: uniq(t), class: 'Inferred' };
  });
  return { routes, handlers, screens, models, tables, unparsed, notes };
}

export { normUri };
