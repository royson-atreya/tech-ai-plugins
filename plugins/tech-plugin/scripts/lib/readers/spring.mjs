// Spring (Java and Kotlin) reader: @RestController / @Controller classes with
// class-level @RequestMapping prefixes and @Get/Post/Put/Patch/Delete/
// RequestMapping methods; Feign clients (as API calls); JPA entities
// (@Entity / @Table) and Flyway or Liquibase SQL tables.

import { closing, isTestFile, J, joinUri, makeRoute, markShadowed, normUri, shapeOf, uniq } from './common.mjs';

const MAP_RE = /@(Get|Post|Put|Patch|Delete|Request)Mapping\b\s*(\()?/g;

function mappingPaths(args) {
  if (args === null) return [''];
  const v = /(?:value|path)\s*=\s*(\{[^}]*\}|"[^"]*")/.exec(args) || /^\s*(\{[^}]*\}|"[^"]*")/.exec(args);
  if (!v) return [''];
  const list = [...v[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  return list.length ? list : [''];
}

function requestMethods(kind, args) {
  if (kind !== 'Request') return [kind.toUpperCase()];
  const m = args && /method\s*=\s*(\{[^}]*\}|[\w.]+)/.exec(args);
  if (!m) return ['ANY'];
  return [...m[1].matchAll(/(?:RequestMethod\.)?(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)/g)].map((x) => x[1]);
}

export function readSpring({ root, files, src }) {
  const code = files.filter((f) => /\.(java|kt)$/.test(f) && !isTestFile(f));
  const routes = [];
  const calls = [];
  const handlerFiles = new Set();
  const tables = [];
  const models = [];
  for (const f of code) {
    const s = src(f);
    if (!s) continue;
    const isCtl = /@(Rest)?Controller\b/.test(s.code);
    const feign = /@FeignClient\b/.test(s.code);
    if (isCtl || feign) {
      const cls = /(?:class|interface)\s+(\w+)/.exec(s.mask);
      if (!cls) continue;
      const head = s.code.slice(0, cls.index);
      const cm = /@RequestMapping\s*\(([^)]*)\)\s*$/m.exec(head) || /@RequestMapping\s*\(([^)]*)\)/.exec(head);
      const prefix = cm ? mappingPaths(cm[1])[0] : '';
      MAP_RE.lastIndex = cls.index;
      let m;
      while ((m = MAP_RE.exec(s.mask))) {
        let args = null;
        let after = m.index + m[0].length;
        if (m[2]) {
          const close = closing(s.mask, after - 1);
          args = s.code.slice(after, close);
          after = close + 1;
        }
        const rest = s.code.slice(after, after + 600).replace(/@\w+(\s*\([^)]*\))?/g, '');
        const mn = /\bfun\s+(\w+)\s*\(/.exec(rest) || /\b(\w+)\s*\([^)]*\)\s*(?:throws[^{]*)?\{|\b(\w+)\s*\([^)]*\)\s*;/.exec(rest);
        const name = mn ? mn[1] || mn[2] : '?';
        const line = s.lineAt(m.index);
        for (const p of mappingPaths(args)) {
          for (const me of requestMethods(m[1], args)) {
            if (feign) {
              const u = normUri(joinUri(prefix, p));
              calls.push({ method: me === 'ANY' ? 'GET' : me, uri: u, shape: shapeOf(u), routeName: null, file: f, line, cite: `${f}:${line}`, via: 'Feign client', host: null, resolved: true, reason: null, viaConst: null, screen: null, area: J(...f.split('/').slice(0, -1).slice(0, 3)), class: 'Verified' });
            } else {
              handlerFiles.add(f);
              routes.push(makeRoute({ method: me, uri: joinUri(prefix, p), handler: `${cls[1]}.${name}`, handlerFile: f, action: name, file: f, line }));
            }
          }
        }
      }
    }
    if (/@Entity\b/.test(s.code)) {
      const cls = /@Entity\b[\s\S]{0,400}?(?:class)\s+(\w+)/.exec(s.code);
      if (cls) {
        const t = /@Table\s*\(\s*(?:name\s*=\s*)?"(\w+)"/.exec(s.code);
        const name = t ? t[1] : cls[1].replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
        tables.push({ name, cite: `${f}:${s.lineAt(cls.index)}`, source: 'JPA entity', columns: [], models: [cls[1]], class: t ? 'Verified' : 'Inferred' });
        models.push({ name: cls[1], table: name, file: f, cite: `${f}:${s.lineAt(cls.index)}`, relations: [] });
      }
    }
  }
  for (const f of files.filter((x) => /db\/(migration|changelog)\/.*\.sql$/i.test(x))) {
    const s = src(f);
    if (!s) continue;
    for (const m of s.text.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?(\w+)/gi)) if (!tables.some((t) => t.name === m[1])) tables.push({ name: m[1], cite: `${f}:${s.lineAt(m.index)}`, source: 'SQL migration', columns: [], models: [], class: 'Verified' });
  }
  markShadowed(routes);
  const handlers = [...handlerFiles].map((f) => {
    const s = src(f);
    const t = s ? models.filter((m) => new RegExp(`\\b${m.name}\\b`).test(s.code)).map((m) => m.table) : [];
    return { id: f, name: f.split('/').pop(), file: f, cite: `${f}:1`, methods: [], tables: uniq(t), class: 'Inferred' };
  });
  return { routes, handlers, screens: [], models, tables, unparsed: [], notes: [], calls };
}
