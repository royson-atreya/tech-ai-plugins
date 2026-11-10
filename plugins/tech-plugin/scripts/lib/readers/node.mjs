// Node backend reader: Express, Fastify, Koa (koa-router), hapi, Hono and
// NestJS routes, with mount prefixes followed across files (app.use('/api',
// router), fastify.register(plugin, { prefix }), Nest @Controller('x') and
// setGlobalPrefix). Tables from Prisma, TypeORM, Sequelize, Mongoose, Knex
// and Drizzle. Handlers are the files (and functions) routes point to.

import { closing, isTestFile, isVendored, J, joinUri, makeRoute, markShadowed, splitArgs, tableGuess, uniq } from './common.mjs';

const JS_EXT = /\.(m?js|cjs|ts|mts|cts|jsx|tsx)$/;
const VERBS = 'get|post|put|patch|delete|del|all|options|head';

export function resolveImport(fromFile, spec, files) {
  if (!spec || !spec.startsWith('.')) return null;
  const dir = fromFile.split('/').slice(0, -1);
  const parts = [...dir];
  for (const p of spec.split('/')) {
    if (p === '..') parts.pop();
    else if (p !== '.') parts.push(p);
  }
  const base = parts.join('/');
  const set = files instanceof Set ? files : new Set(files);
  const cands = [base, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'].map((e) => base + e), ...['ts', 'tsx', 'js', 'jsx', 'mjs'].map((e) => `${base}/index.${e}`)];
  if (/\.js$/.test(base)) cands.push(base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'));
  return cands.find((c) => set.has(c)) || null;
}

// local name -> { file, name } for one file's imports
export function importsOf(file, code, files) {
  const map = new Map();
  for (const m of code.matchAll(/import\s+(?:type\s+)?([\w$]+)?\s*,?\s*(?:\{([^}]*)\})?\s*(?:\*\s+as\s+([\w$]+))?\s*from\s*['"]([^'"]+)['"]/g)) {
    const f = resolveImport(file, m[4], files);
    if (m[1]) map.set(m[1], { file: f, name: 'default', spec: m[4] });
    if (m[3]) map.set(m[3], { file: f, name: '*', spec: m[4] });
    if (m[2]) for (const part of m[2].split(',')) {
      const [a, b] = part.trim().split(/\s+as\s+/);
      if (a) map.set((b || a).trim(), { file: f, name: a.trim(), spec: m[4] });
    }
  }
  for (const m of code.matchAll(/(?:const|let|var)\s+(?:([\w$]+)|\{([^}]*)\})\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const f = resolveImport(file, m[3], files);
    if (m[1]) map.set(m[1], { file: f, name: 'default', spec: m[3] });
    if (m[2]) for (const part of m[2].split(',')) {
      const [a, b] = part.trim().split(/\s*:\s*/);
      if (a) map.set((b || a).trim(), { file: f, name: a.trim(), spec: m[3] });
    }
  }
  for (const m of code.matchAll(/(?:const|let|var)\s+([\w$]+)\s*=\s*(?:React\.)?lazy\(\s*\(\)\s*=>\s*import\(\s*['"]([^'"]+)['"]\s*\)/g)) map.set(m[1], { file: resolveImport(file, m[2], files), name: 'default', spec: m[2] });
  return map;
}

export function readNode({ root, files, src }) {
  const all = new Set(files);
  const js = files.filter((f) => JS_EXT.test(f) && !/\.d\.ts$/.test(f) && !isTestFile(f) && !isVendored(f));
  const sites = [];
  const mounts = [];
  const appVars = new Map(); // file -> Set(var) of root apps
  const routerVars = new Map(); // file -> Map(var -> own prefix)
  const nest = [];
  let globalPrefix = '';
  const handlerFiles = new Map();

  for (const f of js) {
    const s = src(f);
    if (!s) continue;
    const { code, mask } = s;
    if (!/express|fastify|koa|hapi|hono|@nestjs|Router\(|\.route\(/.test(code)) continue;
    const imps = importsOf(f, code, all);
    const apps = new Set();
    const routers = new Map();
    for (const m of code.matchAll(/(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:await\s+)?(express\s*\(\s*\)|(?:express\.)?Router\s*\(([^)]*)\)|new\s+(?:Koa)?Router\s*\(([^)]*)\)|(?:Fastify|fastify)\s*\(|new\s+Koa\s*\(|new\s+Hono\s*\(|Hapi\.server\s*\(|new\s+Hapi\.Server\s*\()/g)) {
      const ownPre = /prefix\s*:\s*['"]([^'"]*)['"]/.exec(m[3] || m[4] || '');
      if (/^(express\s*\(|Fastify|fastify|new\s+Koa|new\s+Hono|Hapi)/.test(m[2])) apps.add(m[1]);
      else routers.set(m[1], ownPre ? ownPre[1] : '');
    }
    // fastify / koa / hapi plugins: (fastify, opts) => { fastify.get(...) }
    for (const m of code.matchAll(/(?:async\s+)?(?:function\s*\w*\s*)?\(\s*(fastify|app|server|router|instance)\s*[,:)]/g)) if (!apps.has(m[1]) && !routers.has(m[1])) routers.set(m[1], '');
    appVars.set(f, apps);
    routerVars.set(f, routers);
    const isRouter = (v) => apps.has(v) || routers.has(v);
    // verb routes
    const re = new RegExp(`(?<![\\w$.])([\\w$]+)\\s*\\.\\s*(${VERBS})\\s*\\(`, 'g');
    let m;
    while ((m = re.exec(mask))) {
      if (!isRouter(m[1])) continue;
      const open = m.index + m[0].length - 1;
      const close = closing(mask, open);
      if (close === -1) continue;
      const args = splitArgs(mask, open + 1, close);
      if (args.length < 2) continue;
      const p = /^\s*(['"`])([^'"`$]*)\1\s*$/.exec(code.slice(args[0].start, args[0].end));
      if (!p) continue;
      const h = code.slice(args[args.length - 1].start, args[args.length - 1].end).trim();
      sites.push({ file: f, line: s.lineAt(m.index), v: m[1], method: m[2] === 'del' ? 'DELETE' : m[2] === 'all' ? 'ANY' : m[2].toUpperCase(), path: p[2], handler: h, imps, mw: args.slice(1, -1).map((a) => code.slice(a.start, a.end).trim()).filter((x) => /^[\w$.]+$/.test(x)) });
    }
    // router.route('/x').get(h).post(h)
    for (const rm of code.matchAll(/(?<![\w$.])([\w$]+)\s*\.\s*route\s*\(\s*(['"`])([^'"`]+)\2\s*\)/g)) {
      if (!isRouter(rm[1])) continue;
      let k = rm.index + rm[0].length;
      const end = mask.indexOf(';', k) === -1 ? mask.length : mask.indexOf(';', k);
      const chain = new RegExp(`\\.\\s*(${VERBS})\\s*\\(`, 'g');
      chain.lastIndex = k;
      let cm;
      while ((cm = chain.exec(mask)) && cm.index < end) {
        const open = cm.index + cm[0].length - 1;
        const close = closing(mask, open);
        if (close === -1) break;
        const args = splitArgs(mask, open + 1, close);
        const h = args.length ? code.slice(args[args.length - 1].start, args[args.length - 1].end).trim() : '';
        sites.push({ file: f, line: s.lineAt(rm.index), v: rm[1], method: cm[1] === 'all' ? 'ANY' : cm[1].toUpperCase(), path: rm[3], handler: h, imps, mw: [] });
        chain.lastIndex = close;
      }
    }
    // object routes: fastify.route({ method, url, handler }) / server.route([{ method, path, handler }])
    for (const om of mask.matchAll(/(?<![\w$.])([\w$]+)\s*\.\s*route\s*\(\s*[[{]/g)) {
      if (!isRouter(om[1])) continue;
      const open = mask.indexOf('(', om.index);
      const close = closing(mask, open);
      if (close === -1) continue;
      const body = code.slice(open, close);
      for (const obj of body.split(/\}\s*,\s*\{/)) {
        const meth = /method\s*:\s*(\[[^\]]*\]|['"]\w+['"])/.exec(obj);
        const url = /(?:url|path)\s*:\s*['"]([^'"]+)['"]/.exec(obj);
        const h = /handler\s*:\s*([\w$.]+)/.exec(obj);
        if (!meth || !url) continue;
        for (const mm of meth[1].matchAll(/['"](\w+)['"]/g)) sites.push({ file: f, line: s.lineAt(om.index), v: om[1], method: mm[1] === '*' ? 'ANY' : mm[1].toUpperCase(), path: url[1], handler: h ? h[1] : '<inline>', imps, mw: [] });
      }
    }
    // mounts: x.use('/p', target) / x.register(target, { prefix: '/p' })
    for (const um of mask.matchAll(/(?<![\w$.])([\w$]+)\s*\.\s*(use|register|route)\s*\(/g)) {
      if (!isRouter(um[1])) continue;
      const open = um.index + um[0].length - 1;
      const close = closing(mask, open);
      if (close === -1) continue;
      const args = splitArgs(mask, open + 1, close);
      if (!args.length) continue;
      const a0 = code.slice(args[0].start, args[0].end).trim();
      if (um[2] === 'use' || um[2] === 'route') {
        const p = /^(['"`])([^'"`$]*)\1$/.exec(a0);
        if (!p || args.length < 2) continue;
        for (const a of args.slice(1)) {
          const t = code.slice(a.start, a.end).trim();
          const req = /^require\(\s*['"]([^'"]+)['"]\s*\)(?:\.\w+)?$/.exec(t);
          if (req) mounts.push({ file: f, v: um[1], prefix: p[2], targetFile: resolveImport(f, req[1], all) });
          else if (/^[\w$.]+$/.test(t)) mounts.push({ file: f, v: um[1], prefix: p[2], target: t, imps });
        }
      } else {
        const pre = args[1] ? /prefix\s*:\s*['"]([^'"]*)['"]/.exec(code.slice(args[1].start, args[1].end)) : null;
        const req = /^(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/.exec(a0);
        if (req) mounts.push({ file: f, v: um[1], prefix: pre ? pre[1] : '', targetFile: resolveImport(f, req[1], all) });
        else if (/^[\w$.]+$/.test(a0)) mounts.push({ file: f, v: um[1], prefix: pre ? pre[1] : '', target: a0, imps });
      }
    }
    // NestJS
    const gp = /setGlobalPrefix\(\s*['"]([^'"]*)['"]/.exec(code);
    if (gp) globalPrefix = gp[1];
    for (const cm of mask.matchAll(/@Controller\s*\(/g)) {
      const open = cm.index + cm[0].length - 1;
      const close = closing(mask, open);
      const argT = code.slice(open + 1, close);
      const p = /^\s*['"]([^'"]*)['"]/.exec(argT) || /path\s*:\s*['"]([^'"]*)['"]/.exec(argT);
      const cls = /class\s+(\w+)/.exec(code.slice(close));
      if (!cls) continue;
      const clsStart = close + cls.index;
      const bodyOpen = mask.indexOf('{', clsStart);
      const bodyClose = closing(mask, bodyOpen);
      const body = { start: bodyOpen, end: bodyClose === -1 ? mask.length : bodyClose };
      for (const dm of mask.slice(body.start, body.end).matchAll(/@(Get|Post|Put|Patch|Delete|All|Options|Head)\s*\(/g)) {
        const dOpen = body.start + dm.index + dm[0].length - 1;
        const dClose = closing(mask, dOpen);
        const dp = /^\s*['"]([^'"]*)['"]/.exec(code.slice(dOpen + 1, dClose));
        const after = code.slice(dClose + 1, dClose + 400).replace(/@\w+\s*\([^)]*\)\s*/g, '').replace(/@\w+\s*/g, '');
        const mn = /^\s*(?:public\s+|private\s+|protected\s+)?(?:async\s+)?([\w$]+)\s*\(/.exec(after);
        nest.push({ file: f, line: s.lineAt(body.start + dm.index), method: dm[1] === 'All' ? 'ANY' : dm[1].toUpperCase(), path: joinUri(p ? p[1] : '', dp ? dp[1] : ''), handler: `${cls[1]}.${mn ? mn[1] : '?'}` });
      }
    }
  }

  // prefixes: follow mounts until nothing changes
  const varPrefix = new Map(); // "file#var" -> prefix
  const filePrefix = new Map();
  const prefixFor = (file, v) => {
    if (varPrefix.has(`${file}#${v}`)) return varPrefix.get(`${file}#${v}`);
    if (appVars.get(file) && appVars.get(file).has(v)) return '';
    if (filePrefix.has(file)) return filePrefix.get(file);
    return '';
  };
  for (let round = 0; round < 8; round++) {
    let changed = false;
    for (const mo of mounts) {
      const parent = prefixFor(mo.file, mo.v);
      const p = joinUri(parent, mo.prefix);
      if (mo.targetFile) {
        if (filePrefix.get(mo.targetFile) !== p) {
          filePrefix.set(mo.targetFile, p);
          changed = true;
        }
        continue;
      }
      const root0 = mo.target.split('.')[0];
      if (routerVars.get(mo.file) && routerVars.get(mo.file).has(root0)) {
        if (varPrefix.get(`${mo.file}#${root0}`) !== p) {
          varPrefix.set(`${mo.file}#${root0}`, p);
          changed = true;
        }
      } else if (mo.imps && mo.imps.has(root0) && mo.imps.get(root0).file) {
        const tf = mo.imps.get(root0).file;
        if (filePrefix.get(tf) !== p) {
          filePrefix.set(tf, p);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  const routes = [];
  for (const st of sites) {
    const own = (routerVars.get(st.file) && routerVars.get(st.file).get(st.v)) || '';
    const prefix = joinUri(prefixFor(st.file, st.v), own);
    const hroot = st.handler.split('.')[0].replace(/\(.*$/, '');
    let hfile = st.file;
    let hname = st.handler;
    if (/^(async\s+)?(function\b|\(|[\w$]+\s*=>)/.test(st.handler)) hname = '<inline>';
    else if (st.imps.has(hroot) && st.imps.get(hroot).file) hfile = st.imps.get(hroot).file;
    if (hname.length > 60) hname = hname.slice(0, 60);
    const handler = hname === '<inline>' ? `${st.file}#${st.method.toLowerCase()} ${st.path}` : `${hfile}#${hname.split('.').pop()}`;
    handlerFiles.set(hfile, true);
    routes.push(makeRoute({ method: st.method, uri: joinUri(prefix, st.path), handler, handlerFile: hfile, action: hname, middleware: st.mw, file: st.file, line: st.line, kind: hname === '<inline>' ? 'closure' : 'route' }));
  }
  for (const n of nest) {
    handlerFiles.set(n.file, true);
    routes.push(makeRoute({ method: n.method, uri: joinUri(globalPrefix, n.path), handler: n.handler, handlerFile: n.file, action: n.handler.split('.').pop(), file: n.file, line: n.line }));
  }
  markShadowed(routes);

  const { tables, models } = readJsTables(root, files, src);
  const handlers = handlerTables([...handlerFiles.keys()], src, models);
  return { routes, handlers, screens: [], models, tables, unparsed: [], notes: mounts.length ? [`${mounts.length} router mount(s) followed for URL prefixes`] : [], skipSites: new Set(sites.map((x) => `${x.file}:${x.line}`)) };
}

// Tables and models from the JS ORMs.
export function readJsTables(root, files, src) {
  const tables = [];
  const models = [];
  const add = (name, cite, source, model, columns = [], cls = 'Verified') => {
    if (tables.some((t) => t.name === name)) {
      if (model) tables.find((t) => t.name === name).models.push(model);
      return;
    }
    tables.push({ name, cite, source, columns, models: model ? [model] : [], class: cls });
    if (model) models.push({ name: model, table: name, file: cite.split(':')[0], cite, relations: [] });
  };
  for (const f of files) {
    if (/\.prisma$/.test(f)) {
      const s = src(f);
      if (!s) continue;
      for (const m of s.text.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
        const map = /@@map\(\s*["']([^"']+)["']\s*\)/.exec(m[2]);
        const cols = [...m[2].matchAll(/^\s+(\w+)\s+[\w[\]?]+/gm)].map((c) => c[1]);
        add(map ? map[1] : m[1], `${f}:${s.lineAt(m.index)}`, 'Prisma schema', m[1], cols);
      }
      continue;
    }
    if (!JS_EXT.test(f) || isTestFile(f) || isVendored(f)) continue;
    const s = src(f);
    if (!s || !/Entity|define\(|\.init\(|model\(|createTable|Table\(/.test(s.code)) continue;
    for (const m of s.code.matchAll(/@Entity\s*\(\s*(?:['"](\w+)['"]|\{[^}]*name\s*:\s*['"](\w+)['"][^}]*\})?\s*\)\s*(?:@\w+\([^)]*\)\s*)*(?:export\s+)?(?:default\s+)?class\s+(\w+)/g)) {
      const body = s.code.slice(m.index, m.index + 5000);
      const cols = [...body.matchAll(/@(?:Column|PrimaryGeneratedColumn|PrimaryColumn|CreateDateColumn|UpdateDateColumn|DeleteDateColumn)\s*\([^)]*\)\s*(\w+)/g)].map((c) => c[1]);
      add(m[1] || m[2] || tableGuess(m[3]), `${f}:${s.lineAt(m.index)}`, 'TypeORM entity', m[3], cols, m[1] || m[2] ? 'Verified' : 'Inferred');
    }
    for (const m of s.code.matchAll(/\.define\(\s*['"](\w+)['"]/g)) add(tableGuess(m[1]).toLowerCase(), `${f}:${s.lineAt(m.index)}`, 'Sequelize model', m[1], [], 'Inferred');
    for (const m of s.code.matchAll(/(\w+)\.init\(\s*\{[\s\S]{0,4000}?tableName\s*:\s*['"](\w+)['"]/g)) add(m[2], `${f}:${s.lineAt(m.index)}`, 'Sequelize model', m[1]);
    for (const m of s.code.matchAll(/mongoose\.model\(\s*['"](\w+)['"]|\bmodel\(\s*['"](\w+)['"]\s*,\s*\w+Schema/g)) add(tableGuess(m[1] || m[2]).toLowerCase(), `${f}:${s.lineAt(m.index)}`, 'Mongoose model (collection)', m[1] || m[2], [], 'Inferred');
    for (const m of s.code.matchAll(/createTable\(\s*['"](\w+)['"]/g)) add(m[1], `${f}:${s.lineAt(m.index)}`, 'Knex migration', null);
    for (const m of s.code.matchAll(/(?:export\s+const\s+(\w+)\s*=\s*)?(?:pg|mysql|sqlite)Table\(\s*['"](\w+)['"]/g)) add(m[2], `${f}:${s.lineAt(m.index)}`, 'Drizzle table', m[1] || null);
  }
  return { tables, models };
}

// Which tables a handler file touches (by the model names it mentions). Inferred.
export function handlerTables(hfiles, src, models) {
  const out = [];
  for (const f of hfiles) {
    const s = src(f);
    if (!s) continue;
    const t = [];
    for (const m of models) {
      const camel = m.name.charAt(0).toLowerCase() + m.name.slice(1);
      if (new RegExp(`\\b${m.name}\\b|prisma\\.${camel}\\b`).test(s.code)) t.push(m.table);
    }
    out.push({ id: f, name: f.split('/').pop(), file: f, cite: `${f}:1`, methods: [], tables: uniq(t), class: 'Inferred' });
  }
  return out;
}

export { J };
