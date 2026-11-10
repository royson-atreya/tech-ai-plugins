// Laravel (and Lumen) reader: routes, controllers, models, migrations, Blade
// views. Ported from the atreya plugin's routes.sh / controllers.sh /
// models.sh / screens.sh (static parse; no PHP, no database).
//
// Routes understood: Route::get/post/put/patch/delete/options/any/match/
// resource(s)/apiResource(s)/singleton/view/redirect, Route::group([...]),
// Route::prefix()/middleware()/name()/controller()/namespace()->group(),
// nested groups, closures, [X::class, 'm'], 'X@m', ['uses' => 'X@m'], invokable
// controllers, ->name(), ->middleware(), ->only()/->except(), route files
// pulled in with require or ->group(base_path(...)), Lumen's $router->get().
// URL prefix per file: RouteServiceProvider, bootstrap/app.php (Laravel 11),
// or the Laravel default (routes/api.php -> api). Lines it cannot understand
// are listed as unparsed with file:line.

import { closing, J, joinUri, makeRoute, markShadowed, singular, splitArgs, tableGuess, uniq } from './common.mjs';

const VERBS = 'get|post|put|patch|delete|options|any|match|resource|apiResource|resources|apiResources|singleton|apiSingleton|view|redirect|permanentRedirect';
const VERB_RE = new RegExp(`(?:Route::|->)\\s*(${VERBS})\\s*\\(`);
const IGNORE_RE = /^(?:Route::|\$router->)\s*(pattern|patterns|bind|model|fallback|macro|middlewareGroup|aliasMiddleware|auth|feeds|mixin|substituteBindings|current|has|is|currentRouteName|getRoutes|resourceParameters|resourceVerbs)\b/;

const lits = (code, a, b) => [...code.slice(a, b).matchAll(/(["'])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]);
const lit1 = (code, a, b) => {
  const t = code.slice(a, b).trim();
  const m = /^(["'])((?:\\.|(?!\1).)*)\1$/.exec(t);
  return m ? m[2] : null;
};

// The first argument span of a chained call `name(` in a statement, or null.
function chainArg(code, mask, from, to, name) {
  const re = new RegExp(`(?:::|->)\\s*${name}\\s*\\(`, 'g');
  re.lastIndex = from;
  const m = re.exec(mask);
  if (!m || m.index >= to) return null;
  const open = m.index + m[0].length - 1;
  const close = closing(mask, open);
  if (close === -1) return null;
  const args = splitArgs(mask, open + 1, close);
  return { open, close, args };
}

function psr4Map(reader, root) {
  const c = reader.json(J(root, 'composer.json'));
  const map = [];
  const a = c && c.data && c.data.autoload && c.data.autoload['psr-4'];
  if (a) for (const [ns, dir] of Object.entries(a)) map.push([ns.replace(/\\+$/, ''), (Array.isArray(dir) ? dir[0] : dir).replace(/\/+$/, '')]);
  if (!map.length) map.push(['App', 'app']);
  return map.sort((x, y) => y[0].length - x[0].length);
}

function classFile(psr4, root, fqcn) {
  for (const [ns, dir] of psr4) {
    if (fqcn === ns || fqcn.startsWith(ns + '\\')) return J(root, dir, fqcn.slice(ns.length + 1).replace(/\\/g, '/') + '.php');
  }
  return null;
}

function usesOf(code) {
  const uses = new Map();
  for (const m of code.matchAll(/^\s*use\s+\\?([\w\\]+)(?:\s+as\s+(\w+))?\s*;/gm)) {
    const fq = m[1];
    uses.set(m[2] || fq.split('\\').pop(), fq);
  }
  return uses;
}

// ------------------------------------------------------------------ route prefixes

function filePrefixes(reader, root, src) {
  const pre = new Map();
  const rsp = src(J(root, 'app/Providers/RouteServiceProvider.php'));
  if (rsp) {
    for (const stmt of rsp.code.split(';')) {
      const f = /routes\/([\w.\/-]+\.php)/.exec(stmt);
      if (!f || !/Route::|->group\(/.test(stmt)) continue;
      const p = /prefix\(\s*['"]([^'"]*)['"]/.exec(stmt);
      pre.set(J(root, 'routes', f[1]), { prefix: p ? p[1] : '', source: 'RouteServiceProvider', mw: lits(stmt, 0, stmt.length).length && /middleware\(/.test(stmt) ? (/middleware\(\s*([^)]*)\)/.exec(stmt) || [])[1] : null });
    }
  }
  const boot = src(J(root, 'bootstrap/app.php'));
  if (boot && /withRouting\s*\(/.test(boot.code)) {
    const ap = /apiPrefix\s*:\s*['"]([^'"]*)['"]/.exec(boot.code);
    for (const m of boot.code.matchAll(/\b(web|api)\s*:\s*__DIR__\s*\.\s*['"]\/\.\.\/routes\/([\w.\/-]+\.php)['"]/g)) {
      pre.set(J(root, 'routes', m[2]), { prefix: m[1] === 'api' ? (ap ? ap[1] : 'api') : '', source: 'bootstrap/app.php' });
    }
  }
  return (file) => {
    if (pre.has(file)) return pre.get(file);
    return file === J(root, 'routes/api.php') ? { prefix: 'api', source: 'Laravel default' } : { prefix: '', source: 'Laravel default' };
  };
}

// ------------------------------------------------------------------ routes

function readRoutes(reader, root, files, src, psr4) {
  const routeFiles = files.filter((f) => f.startsWith(J(root, 'routes') + '/') && f.endsWith('.php') && !/\/(channels|console)\.php$/.test(f));
  const prefixOf = filePrefixes(reader, root, src);
  const routes = [];
  const unparsed = [];
  const notes = [];
  const fileMeta = [];
  let commented = 0;
  const included = new Set();
  const ctlStatus = new Map();

  const ctlInfo = (fq) => {
    if (ctlStatus.has(fq)) return ctlStatus.get(fq);
    const file = classFile(psr4, root, fq);
    let status = 'missing';
    if (file) {
      if (reader.isSecret(file)) status = 'guarded';
      else if (reader.exists(file)) status = 'found';
    }
    const v = { file, status };
    ctlStatus.set(fq, v);
    return v;
  };

  const parseFile = (file, base, depthGuard = 0) => {
    const s = src(file);
    if (!s || depthGuard > 5) return;
    const { code, mask, lineAt } = s;
    for (const c of s.comments) {
      const t = s.text.slice(c.start, c.end);
      commented += (t.match(/Route::\w+\s*\(/g) || []).length;
    }
    if (/\bAuth::routes\s*\(/.test(code)) notes.push(`${file}:${lineAt(code.indexOf('Auth::routes'))}: Auth::routes() adds the standard login, register and password routes (not listed one by one)`);
    const uses = usesOf(code);
    const groups = [];
    let depth = 0;
    const ctx = () => {
      const all = [base, ...groups];
      return {
        prefix: joinUri(...all.map((g) => g.prefix || '')),
        mw: all.flatMap((g) => g.mw || []),
        ctl: [...all].reverse().find((g) => g.ctl) ? [...all].reverse().find((g) => g.ctl).ctl : null,
        ns: all.map((g) => g.ns).filter(Boolean).join('\\'),
        as: all.map((g) => g.as || '').join(''),
      };
    };
    const count = (a, b) => {
      for (let k = a; k < b; k++) {
        if (mask[k] === '{') depth++;
        else if (mask[k] === '}') {
          depth--;
          while (groups.length && depth < groups[groups.length - 1].level) groups.pop();
        }
      }
    };
    const fq = (c, ns) => {
      let x = c.replace(/^\\/, '');
      const first = x.split('\\')[0];
      if (uses.has(first)) return uses.get(first) + x.slice(first.length);
      if (/^App\\/.test(x)) return x;
      return ['App\\Http\\Controllers', ns, x].filter(Boolean).join('\\');
    };
    const START = /(Route::|\$router->|\$app->router->|\brequire(?:_once)?\b|\binclude(?:_once)?\b)/g;
    let i = 0;
    for (;;) {
      START.lastIndex = i;
      const m = START.exec(mask);
      if (!m) {
        count(i, mask.length);
        break;
      }
      count(i, m.index);
      const s0 = m.index;
      const semi = mask.indexOf(';', s0);
      if (/^(require|include)/.test(m[1])) {
        const end = semi === -1 ? mask.length : semi;
        const stmt = code.slice(s0, end);
        const inc = incPath(stmt, file, root);
        if (inc && files.includes(inc)) {
          included.add(inc);
          parseFile(inc, ctx(), depthGuard + 1);
        }
        i = end + 1;
        continue;
      }
      const OPEN = /(?:function|fn)\s*\([^)]*\)\s*(?:use\s*\([^)]*\)\s*)?(?::\s*[\w\\?]+\s*)?\{/g;
      OPEN.lastIndex = s0;
      const op = OPEN.exec(mask);
      let end;
      let opener = false;
      if (op && (semi === -1 || op.index + op[0].length - 1 < semi)) {
        end = op.index + op[0].length - 1;
        opener = true;
      } else end = semi === -1 ? mask.length : semi;
      const line = lineAt(s0);
      const stmtMask = mask.slice(s0, end);
      if (/(?:Route::group|->group)\s*\(/.test(stmtMask) && !VERB_RE.test(stmtMask.replace(/->group[\s\S]*$/, ''))) {
        const g = groupOf(code, mask, s0, end);
        if (opener) {
          g.level = depth + 1;
          groups.push(g);
        } else {
          // ->group(base_path('routes/x.php')) or ->group(__DIR__.'/x.php')
          const inc = incPath(code.slice(s0, end), file, root);
          if (inc && files.includes(inc)) {
            included.add(inc);
            groups.push({ ...g, level: Infinity });
            parseFile(inc, ctx(), depthGuard + 1);
            groups.pop();
          } else unparsed.push({ cite: `${file}:${line}`, text: oneLine(code.slice(s0, end)) });
        }
      } else if (VERB_RE.test(stmtMask)) {
        const ok = routeOf(code, mask, s0, end, file, line, ctx(), fq, ctlInfo, routes);
        if (!ok) unparsed.push({ cite: `${file}:${line}`, text: oneLine(code.slice(s0, end)) });
      } else if (!IGNORE_RE.test(code.slice(s0, end).trimStart())) {
        unparsed.push({ cite: `${file}:${line}`, text: oneLine(code.slice(s0, end)) });
      }
      count(s0, end + 1);
      i = end + 1;
    }
  };

  // included files first, so they are not parsed twice at top level
  for (const f of routeFiles) {
    const s = src(f);
    if (!s) continue;
    for (const m of s.code.matchAll(/(?:require|include)(?:_once)?\s*\(?\s*([^;]+);|->group\(\s*(base_path\([^)]*\)|__DIR__[^)]*)\)/g)) {
      const inc = incPath(m[0], f, root);
      if (inc) included.add(inc);
    }
  }
  for (const f of routeFiles) {
    if (included.has(f)) continue;
    const p = prefixOf(f);
    fileMeta.push({ file: f, prefix: p.prefix, source: p.source });
    parseFile(f, { prefix: p.prefix, mw: [], ctl: null, ns: '', as: '' });
  }
  markShadowed(routes);
  return { routes, unparsed, notes, fileMeta, commented, ctlStatus };
}

function incPath(stmt, file, root) {
  let m = /base_path\(\s*['"]([^'"]+)['"]\s*\)/.exec(stmt);
  if (m) return J(root, m[1]);
  m = /__DIR__\s*\.\s*['"]\/?([^'"]+)['"]/.exec(stmt);
  if (m) {
    const dir = file.split('/').slice(0, -1).join('/');
    const parts = J(dir, m[1]).split('/');
    const out = [];
    for (const p of parts) {
      if (p === '..') out.pop();
      else if (p !== '.') out.push(p);
    }
    return out.join('/');
  }
  return null;
}

const oneLine = (t) => t.replace(/\s+/g, ' ').trim().slice(0, 140);

function groupOf(code, mask, s0, end) {
  const g = { prefix: '', mw: [], ctl: null, ns: '', as: '' };
  const pre = chainArg(code, mask, s0, end, 'prefix');
  if (pre && pre.args[0]) g.prefix = lit1(code, pre.args[0].start, pre.args[0].end) || '';
  const mw = chainArg(code, mask, s0, end, 'middleware');
  if (mw && mw.args.length) g.mw = lits(code, mw.args[0].start, mw.close);
  const nm = chainArg(code, mask, s0, end, 'name');
  if (nm && nm.args[0]) g.as = lit1(code, nm.args[0].start, nm.args[0].end) || '';
  const ns = chainArg(code, mask, s0, end, 'namespace');
  if (ns && ns.args[0]) g.ns = (lit1(code, ns.args[0].start, ns.args[0].end) || '').replace(/^\\/, '');
  const ct = chainArg(code, mask, s0, end, 'controller');
  if (ct && ct.args[0]) {
    const t = code.slice(ct.args[0].start, ct.args[0].end).trim();
    const m = /^\\?([\w\\]+)::class$/.exec(t) || /^['"]([\w\\]+)['"]$/.exec(t);
    if (m) g.ctl = m[1];
  }
  const gr = chainArg(code, mask, s0, end + 1, 'group');
  if (gr && gr.args[0] && code.slice(gr.args[0].start, gr.args[0].end).trim().startsWith('[')) {
    const a = gr.args[0];
    const t = code.slice(a.start, a.end);
    const kv = (k) => {
      const m = new RegExp(`['"]${k}['"]\\s*=>\\s*(\\[[^\\]]*\\]|['"][^'"]*['"])`).exec(t);
      return m ? lits(m[1], 0, m[1].length) : null;
    };
    if (kv('prefix')) g.prefix = kv('prefix')[0] || '';
    if (kv('middleware')) g.mw = kv('middleware');
    if (kv('as')) g.as = kv('as')[0] || '';
    if (kv('namespace')) g.ns = (kv('namespace')[0] || '').replace(/^\\/, '');
  }
  return g;
}

function parseAction(t, c) {
  t = t.trim();
  let m;
  if ((m = /^\[\s*\\?([\w\\]+)::class\s*,\s*['"](\w+)['"]\s*\]$/.exec(t))) return { ctl: m[1], act: m[2] };
  if ((m = /^['"]([\w\\]+)@(\w+)['"]$/.exec(t))) return { ctl: m[1], act: m[2] };
  if (/^(static\s+)?(function|fn)\b/.test(t)) return { ctl: null, act: 'Closure', kind: 'closure' };
  if ((m = /^['"](\w+)['"]$/.exec(t)) && c.ctl) return { ctl: c.ctl, act: m[1] };
  if ((m = /^\\?([\w\\]+)::class$/.exec(t))) return { ctl: m[1], act: '__invoke', invokable: true };
  if ((m = /^\[[\s\S]*['"]uses['"]\s*=>\s*['"]([\w\\]+)@(\w+)['"][\s\S]*\]$/.exec(t))) {
    const as = /['"]as['"]\s*=>\s*['"]([^'"]+)['"]/.exec(t);
    return { ctl: m[1], act: m[2], name: as ? as[1] : null };
  }
  if ((m = /^\[[\s\S]*['"]as['"]\s*=>\s*['"]([^'"]+)['"][\s\S]*(function|fn)\b/.exec(t))) return { ctl: null, act: 'Closure', kind: 'closure', name: m[1] };
  return null;
}

function routeOf(code, mask, s0, end, file, line, c, fq, ctlInfo, out) {
  const stmtMask = mask.slice(s0, end);
  const vm = VERB_RE.exec(stmtMask);
  const verb = vm[1];
  const open = s0 + vm.index + vm[0].length - 1;
  const close = closing(mask, open);
  if (close === -1) return false;
  const args = splitArgs(mask, open + 1, close);
  const before = { s: s0, e: s0 + vm.index };
  const semiAfter = mask.indexOf(';', close);
  const after = { s: close + 1, e: semiAfter === -1 ? Math.max(end, close + 1) : semiAfter };
  // middleware chained before or after the verb, name after
  let mw = [...c.mw];
  for (const r of [before, after]) {
    const x = chainArg(code, mask, r.s, r.e, 'middleware');
    if (x && x.args.length) mw = mw.concat(lits(code, x.args[0].start, x.close));
  }
  const nmA = chainArg(code, mask, after.s, after.e, 'name');
  let name = nmA && nmA.args[0] ? c.as + (lit1(code, nmA.args[0].start, nmA.args[0].end) || '') : null;
  const prefixBefore = chainArg(code, mask, before.s, before.e, 'prefix');
  const localPrefix = prefixBefore && prefixBefore.args[0] ? lit1(code, prefixBefore.args[0].start, prefixBefore.args[0].end) || '' : '';
  const ctlBefore = chainArg(code, mask, before.s, before.e, 'controller');
  if (ctlBefore && ctlBefore.args[0]) {
    const m = /^\\?([\w\\]+)::class$/.exec(code.slice(ctlBefore.args[0].start, ctlBefore.args[0].end).trim());
    if (m) c = { ...c, ctl: m[1] };
  }
  const prefix = joinUri(c.prefix, localPrefix);
  const emit = (method, uri, a, kind, extra = {}) => {
    const fqcn = a.ctl ? fq(a.ctl, c.ns) : null;
    const info = fqcn ? ctlInfo(fqcn) : null;
    out.push(
      makeRoute({
        method,
        uri: joinUri(prefix, uri),
        handler: fqcn ? `${fqcn}@${a.act}` : a.act,
        handlerFile: info ? info.file : file,
        action: a.act,
        middleware: uniq(mw),
        name: extra.name !== undefined ? extra.name : name,
        kind,
        file,
        line,
        extra: { controller: fqcn, controllerStatus: info ? info.status : null, surface: /(^|\/)routes\/web\.php$/.test(file) || mw.includes('web') ? 'page' : 'api', ...(extra.view ? { view: extra.view } : {}) },
      }),
    );
  };
  if (/^(resource|apiResource|resources|apiResources|singleton|apiSingleton)$/.test(verb)) {
    const list = [];
    if (/resources$/i.test(verb)) {
      if (!args[0]) return false;
      for (const m of code.slice(args[0].start, args[0].end).matchAll(/['"]([\w.\/-]+)['"]\s*=>\s*\\?([\w\\]+)::class/g)) list.push([m[1], m[2]]);
    } else {
      if (args.length < 2) return false;
      const n = lit1(code, args[0].start, args[0].end);
      const cm = /^\\?([\w\\]+)::class$/.exec(code.slice(args[1].start, args[1].end).trim()) || /^['"]([\w\\]+)['"]$/.exec(code.slice(args[1].start, args[1].end).trim());
      if (n === null || !cm) return false;
      list.push([n, cm[1]]);
    }
    const only = chainArg(code, mask, after.s, after.e, 'only');
    const except = chainArg(code, mask, after.s, after.e, 'except');
    const onlyL = only ? lits(code, only.open, only.close) : null;
    const exceptL = except ? lits(code, except.open, except.close) : [];
    const api = /^api/.test(verb);
    for (const [rname, ctl] of list) {
      const segs = rname.split('.');
      let base = '';
      segs.forEach((sgm, k) => {
        base = joinUri(base, sgm);
        if (k < segs.length - 1) base = joinUri(base, `{${singular(sgm.split('/').pop()).replace(/-/g, '_')}}`);
      });
      const p = `{${singular(segs[segs.length - 1].split('/').pop()).replace(/-/g, '_')}}`;
      const acts = /singleton/i.test(verb)
        ? [['show', 'GET', ''], ['edit', 'GET', '/edit'], ['update', 'PUT', ''], ['update', 'PATCH', '']]
        : [['index', 'GET', ''], ['create', 'GET', '/create'], ['store', 'POST', ''], ['show', 'GET', `/${p}`], ['edit', 'GET', `/${p}/edit`], ['update', 'PUT', `/${p}`], ['update', 'PATCH', `/${p}`], ['destroy', 'DELETE', `/${p}`]];
      for (const [act, method, suffix] of acts) {
        if (api && (act === 'create' || act === 'edit')) continue;
        if (onlyL && !onlyL.includes(act)) continue;
        if (exceptL.includes(act)) continue;
        emit(method, base + suffix, { ctl, act }, 'resource', { name: `${c.as}${rname}.${act}` });
      }
    }
    return true;
  }
  let methods;
  let ai = 1;
  let ui = 0;
  if (verb === 'match') {
    if (!args[0]) return false;
    methods = lits(code, args[0].start, args[0].end).map((x) => x.toUpperCase());
    ui = 1;
    ai = 2;
  } else if (verb === 'any') methods = ['ANY'];
  else if (verb === 'view' || /redirect/i.test(verb)) methods = ['GET'];
  else methods = [verb.toUpperCase()];
  if (!args[ui]) return false;
  const uri = lit1(code, args[ui].start, args[ui].end);
  if (uri === null) return false;
  if (verb === 'view') {
    const v = args[1] ? lit1(code, args[1].start, args[1].end) : null;
    for (const me of methods) emit(me, uri, { ctl: null, act: 'view' }, 'view', { view: v });
    return true;
  }
  if (/redirect/i.test(verb)) {
    for (const me of methods) emit(me, uri, { ctl: null, act: 'redirect' }, 'redirect');
    return true;
  }
  if (!args[ai]) {
    if (c.ctl) return false;
    return false;
  }
  const a = parseAction(code.slice(args[ai].start, args[ai].end), c);
  if (!a) return false;
  if (a.name && !name) name = c.as + a.name;
  for (const me of methods) emit(me, uri, a, a.kind || 'route');
  return true;
}

// ------------------------------------------------------------------ classes

function phpMethods(s) {
  const out = [];
  const re = /\bfunction\s+(\w+)\s*\(/g;
  let m;
  while ((m = re.exec(s.mask))) {
    const pOpen = m.index + m[0].length - 1;
    const pClose = closing(s.mask, pOpen);
    if (pClose === -1) continue;
    const rest = s.mask.slice(pClose + 1, pClose + 200);
    const b = /^[^;{]*\{/.exec(rest);
    if (!b) continue;
    const bOpen = pClose + 1 + b[0].length - 1;
    const bClose = closing(s.mask, bOpen);
    if (bClose === -1) continue;
    out.push({ name: m[1], start: m.index, params: s.code.slice(pOpen + 1, pClose), bodyStart: bOpen, bodyEnd: bClose, line: s.lineAt(m.index), endLine: s.lineAt(bClose) });
  }
  return out;
}

function readModels(files, root, src) {
  const models = [];
  const modelFiles = files.filter((f) => f.endsWith('.php') && (f.startsWith(J(root, 'app/Models') + '/') || (f.startsWith(J(root, 'app') + '/') && f.split('/').length === J(root, 'app').split('/').length + 1)));
  for (const f of modelFiles) {
    const s = src(f);
    if (!s) continue;
    const cm = /\bclass\s+(\w+)\s+extends\s+([\w\\]+)/.exec(s.code);
    if (!cm) continue;
    if (!f.includes('/Models/') && !/(Model|Authenticatable|Pivot)$/.test(cm[2])) continue;
    const ns = (/^\s*namespace\s+([\w\\]+)\s*;/m.exec(s.code) || [])[1] || '';
    const t = /\$table\s*=\s*['"]([\w.]+)['"]/.exec(s.code);
    const relations = [];
    for (const r of s.code.matchAll(/\$this->(hasOne|hasMany|belongsTo|belongsToMany|morphTo|morphMany|morphOne|morphToMany|hasManyThrough|hasOneThrough)\(\s*\\?([\w\\]+)::class/g)) relations.push({ type: r[1], target: r[2].split('\\').pop() });
    models.push({ name: cm[1], fqcn: ns ? `${ns}\\${cm[1]}` : cm[1], table: t ? t[1] : tableGuess(cm[1]), tableDeclared: !!t, file: f, cite: `${f}:${s.lineAt(cm.index)}`, relations });
  }
  return models;
}

function readMigrations(files, root, src) {
  const tables = new Map();
  const migs = files.filter((f) => f.startsWith(J(root, 'database/migrations') + '/') && f.endsWith('.php')).sort();
  for (const f of migs) {
    const s = src(f);
    if (!s) continue;
    const re = /Schema::(create|table|drop|dropIfExists|rename)\s*\(/g;
    let m;
    while ((m = re.exec(s.mask))) {
      const open = m.index + m[0].length - 1;
      const close = closing(s.mask, open);
      const args = splitArgs(s.mask, open + 1, close === -1 ? s.mask.length : close);
      if (!args[0]) continue;
      const name = lit1(s.code, args[0].start, args[0].end);
      if (!name) continue;
      const cite = `${f}:${s.lineAt(m.index)}`;
      if (m[1] === 'drop' || m[1] === 'dropIfExists') {
        if (tables.has(name)) tables.get(name).dropped = cite;
        continue;
      }
      if (m[1] === 'rename') continue;
      const t = tables.get(name) || { name, cite, source: 'migration', columns: [], models: [], class: 'Verified' };
      if (m[1] === 'create') {
        t.cite = cite;
        delete t.dropped;
      }
      const body = s.code.slice(open, close === -1 ? s.code.length : close);
      for (const c of body.matchAll(/\$table->(\w+)\(\s*['"](\w+)['"]/g)) {
        if (/^(index|unique|primary|foreign|dropColumn|dropForeign|dropIndex|dropUnique|renameColumn|spatialIndex|fullText)$/.test(c[1])) continue;
        if (!t.columns.includes(c[2])) t.columns.push(c[2]);
      }
      if (/\$table->(id|bigIncrements|increments)\(\s*\)/.test(body) && !t.columns.includes('id')) t.columns.unshift('id');
      if (/\$table->timestamps\(\s*\)/.test(body)) for (const c of ['created_at', 'updated_at']) if (!t.columns.includes(c)) t.columns.push(c);
      if (/\$table->softDeletes\(\s*\)/.test(body) && !t.columns.includes('deleted_at')) t.columns.push('deleted_at');
      tables.set(name, t);
    }
  }
  return [...tables.values()];
}

function readControllers(files, root, src, modelNames) {
  const handlers = [];
  const ctlFiles = files.filter((f) => f.startsWith(J(root, 'app/Http/Controllers') + '/') && f.endsWith('.php'));
  for (const f of ctlFiles) {
    const s = src(f);
    if (!s) continue;
    const ns = (/^\s*namespace\s+([\w\\]+)\s*;/m.exec(s.code) || [])[1] || '';
    const cm = /\bclass\s+(\w+)/.exec(s.code);
    if (!cm) continue;
    const uses = usesOf(s.code);
    const localModels = new Set();
    for (const [short, fq] of uses) if (modelNames.has(short) || /\\Models\\/.test(fq)) localModels.add(short);
    for (const n of modelNames) if (new RegExp(`\\b${n}::`).test(s.code)) localModels.add(n);
    const methods = phpMethods(s).map((mt) => {
      const body = s.code.slice(mt.bodyStart, mt.bodyEnd);
      const views = uniq([...body.matchAll(/(?:\bview|View::make|->view|View::first)\(\s*\[?\s*['"]([\w.:\/-]+)['"]/g)].map((x) => x[1].replace(/\//g, '.')));
      const inertia = [...body.matchAll(/Inertia::render\(\s*['"]([\w.\/-]+)['"]/g)].map((x) => x[1]);
      const models = [...localModels].filter((n) => new RegExp(`\\b${n}\\s*::|\\bnew\\s+${n}\\b|\\b${n}\\s+\\$`).test(body) || new RegExp(`\\b${n}\\s+\\$`).test(mt.params));
      const tables = uniq([...body.matchAll(/DB::table\(\s*['"](\w+)['"]/g)].map((x) => x[1]));
      return { name: mt.name, line: mt.line, endLine: mt.endLine, views: views.concat(inertia), models, tables };
    });
    handlers.push({ id: ns ? `${ns}\\${cm[1]}` : cm[1], name: cm[1], file: f, cite: `${f}:${s.lineAt(cm.index)}`, methods });
  }
  return handlers;
}

function readBlade(files, root, src, handlers, routes) {
  const vroot = J(root, 'resources/views') + '/';
  const screens = [];
  const rendered = new Map();
  for (const h of handlers) for (const m of h.methods) for (const v of m.views) {
    if (!rendered.has(v)) rendered.set(v, []);
    rendered.get(v).push(`${h.id}@${m.name}`);
  }
  for (const f of files.filter((x) => x.startsWith(vroot) && x.endsWith('.blade.php'))) {
    const id = f.slice(vroot.length, -'.blade.php'.length).replace(/\//g, '.');
    const s = src(f);
    const links = [];
    const scripts = [];
    if (s) {
      // page JS: <script src="{{ asset('js/x.js') }}"> or src="/js/x.js"
      for (const m of s.text.matchAll(/<script\b[^>]*\bsrc\s*=\s*["'](?:\{\{\s*(?:asset|url|mix|secure_asset)\(\s*['"]\/?([^'"]+?)['"][^}]*\}\}|\/([^"'{}]+?))(?:\?[^"']*)?["']/gi)) scripts.push(J(root, 'public', (m[1] || m[2]).replace(/^public\//, '')));
      for (const m of s.text.matchAll(/route\(\s*['"]([\w.:-]+)['"]/g)) links.push({ kind: 'route-name', target: m[1] });
      for (const m of s.text.matchAll(/(?:url\(\s*|href=|action=)['"](\/[\w\/{}.-]*)['"]/g)) links.push({ kind: 'url', target: m[1] });
    }
    const by = rendered.get(id) || [];
    const viaRoutes = routes.filter((r) => !r.shadowed && ((r.view && r.view === id) || (r.controller && by.includes(r.handler))));
    const getRoute = viaRoutes.find((r) => r.method === 'GET') || viaRoutes[0];
    const partial = /(^|\.)(layouts?|partials?|components?|includes?|emails?|mail|vendor|errors|pdf)(\.|$)/i.test(id) || /(^|\.)_[^.]*$/.test(id);
    screens.push({ id, name: id, file: f, cite: `${f}:1`, path: getRoute ? getRoute.uri : null, kind: 'blade', renderedBy: by, links: uniqBy(links), scripts: [...new Set(scripts)], partial, class: 'Verified' });
  }
  return screens;
}

const uniqBy = (arr) => {
  const seen = new Set();
  return arr.filter((x) => {
    const k = JSON.stringify(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

// ------------------------------------------------------------------ entry

export function readLaravel({ reader, root, files, src }) {
  const psr4 = psr4Map(reader, root);
  const r = readRoutes(reader, root, files, src, psr4);
  const models = readModels(files, root, src);
  const tables = readMigrations(files, root, src);
  const byName = new Map(tables.map((t) => [t.name, t]));
  for (const m of models) {
    if (!byName.has(m.table)) {
      const t = { name: m.table, cite: m.cite, source: 'model', columns: [], models: [], class: m.tableDeclared ? 'Verified' : 'Inferred' };
      tables.push(t);
      byName.set(m.table, t);
    }
    byName.get(m.table).models.push(m.name);
  }
  const modelTable = new Map(models.map((m) => [m.name, m.table]));
  const handlers = readControllers(files, root, src, new Set(models.map((m) => m.name)));
  for (const h of handlers) for (const mt of h.methods) mt.tables = uniq(mt.tables.concat(mt.models.map((n) => modelTable.get(n)).filter(Boolean)));
  const screens = readBlade(files, root, src, handlers, r.routes);
  const missing = [...r.ctlStatus.entries()].filter(([, v]) => v.status === 'missing').map(([k]) => k);
  const guarded = [...r.ctlStatus.entries()].filter(([, v]) => v.status === 'guarded').map(([k]) => k);
  const notes = [...r.notes];
  if (r.commented) notes.push(`${r.commented} commented-out route line(s) ignored`);
  if (missing.length) notes.push(`controller file not found for: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ` and ${missing.length - 10} more` : ''}`);
  if (guarded.length) notes.push(`controller files never opened (secret by name): ${guarded.join(', ')}`);
  return {
    routes: r.routes,
    handlers,
    screens,
    models,
    tables,
    unparsed: r.unparsed,
    notes,
    meta: { routeFiles: r.fileMeta, commentedRoutes: r.commented, controllersMissing: missing.length, controllersGuarded: guarded.length },
    // the controller method a line of a controller file belongs to (for calls)
    methodAt(file, line) {
      const h = handlers.find((x) => x.file === file);
      if (!h) return null;
      const m = h.methods.find((x) => line >= x.line && line <= x.endLine);
      return m ? { handler: `${h.id}@${m.name}`, views: m.views } : null;
    },
  };
}
