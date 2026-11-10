// API calls an app makes (stage 3), for linking screens to backend routes in
// stage 4. Works on JS/TS, Dart, PHP (and Blade), Python, Java/Kotlin and Go.
//
// The URL of a call is worked out from the code without running anything:
//   "${AppEnvironment.baseUrl}/patients/$id"       -> patients/{}
//   config('app.backend_url') . '/login'           -> login
//   `${API}/orders?page=${p}`                      -> orders
//   StringsConst().login  (getter "${base}/login") -> login   (through a constant)
// A leading base-URL part is dropped (names like baseUrl, apiUrl, backend_url,
// API_HOST, or ones listed in _map/overrides.yaml). Dynamic parts become {}.
// Query strings are dropped. When the path cannot be worked out, the call is
// listed as unresolved with file:line and the reason.
//
// WHY no literal text is stored: a URL string in code can carry a key in its
// query string. Calls keep only the computed path, the host name and the names
// of the variables involved.

import { closing, isTestFile, isVendored, J, normUri, shapeOf, splitArgs } from './common.mjs';

const DEFAULT_BASE = /(^|[^a-z])(base_?ur[li]|api_?(base_?)?ur[li]|backend_?ur[li]|server_?ur[li]|api_?host|api_?root|api_?endpoint|host_?url|app_?url|api_?domain|root_?url|api_?prefix|base_?path|api_?path)([^a-z]|$)/i;
const ASSET = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|map|woff2?|ttf|eot|html?|pdf|mp4|mp3|txt|xml)$/i;
const HTTPISH = /^(fetch|axios|\$http|http|https|dio|_dio|client|_client|api|_api|apiclient|httpclient|request|requests|httpx|session|ky|got|superagent|\$|jquery|instance|service|apiservice|network|_network|_http|this\.http|this\.client|this\.api|self\.session|self\.client)$/i;
const NOT_HTTP_RECEIVERS = new Set(['map', 'params', 'searchparams', 'headers', 'cache', 'localstorage', 'sessionstorage', 'formdata', 'store', 'object', 'reflect', 'window', 'document', 'cookies', 'req', 'res', 'prefs', 'box', 'storage', 'get', 'getit', 'locator', 'sl', 'context', 'navigator', 'json', 'data', 'response', 'router', 'route', 'app', 'express', 'fastify', 'server', 'r', 'e', 'g', 'mux', 'environ', 'os', 'dict', 'config', 'settings', 'kwargs', 'args', 'query', 'body', 'state', 'props', 'map_', 'redis', 'memcache', 'collect', 'arr', 'list', 'set', 'model', 'form', 'values']);

// ------------------------------------------------------------------ URL expressions

// Parses an expression into parts: { lit } for literal text, { dyn } for a
// variable or call (its source text), { route } for Laravel route('name').
export function urlParts(code, mask, start, end, lang) {
  const parts = [];
  let i = start;
  const ws = () => {
    while (i < end && /\s/.test(code[i])) i++;
  };
  while (i < end) {
    ws();
    if (i >= end) break;
    const ch = mask[i];
    const pyPrefix = lang === 'py' && /[fFrRbBuU]/.test(code[i]) && /["']/.test(mask[i + 1] || '') ? 1 : lang === 'py' && /^[fFrR]{2}["']/.test(code.slice(i, i + 3)) ? 2 : 0;
    if (ch === '"' || ch === "'" || ch === '`' || pyPrefix) {
      const isF = pyPrefix && /f/i.test(code.slice(i, i + pyPrefix));
      const q = i + pyPrefix;
      const quote = mask[q];
      let j = q + 1;
      while (j < end && mask[j] !== quote) j++;
      const raw = code.slice(q + 1, j);
      parts.push(...interpolate(raw, lang, quote, isF));
      i = j + 1;
      // a method chained onto a string literal ('x/{}'.format(a), '/a'.concat(b)): skip it
      ws();
      if (lang !== 'php') {
        while (i < end && code[i] === '.') {
          const m = /^\.\s*[A-Za-z_]\w*\s*/.exec(code.slice(i, end));
          if (!m) break;
          i += m[0].length;
          if (mask[i] === '(') {
            const c = closing(mask, i);
            i = c === -1 ? end : c + 1;
          }
          ws();
        }
      }
      continue;
    }
    if (ch === '+' || (lang === 'php' && ch === '.' && mask[i + 1] !== '.')) {
      i++;
      continue;
    }
    // a token up to the next top-level concatenation operator
    let depth = 0;
    const s = i;
    while (i < end) {
      const c = mask[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (depth === 0 && (c === '+' || (lang === 'php' && c === '.' && mask[i - 1] !== '-' && !/\d/.test(mask[i + 1] || '')))) break;
      else if (depth === 0 && (c === '"' || c === "'" || c === '`')) break;
      i++;
    }
    const tok = code.slice(s, i).trim();
    if (tok) parts.push(...unwrap(tok, lang));
  }
  return parts;
}

// Uri.parse(x), URI.create(x), new URL(x), url(x), Uri.https(host, path)…
function unwrap(tok, lang) {
  let m;
  if ((m = /^route\(\s*(["'])([\w.:-]+)\1/.exec(tok))) return [{ route: m[2] }];
  if ((m = /^(?:Uri\.parse|Uri\.tryParse|URI\.create|URI|URL|new\s+URL|url|Url|parse|java\.net\.URI\.create|URI\.parse)\s*\(([\s\S]*)\)\s*(?:\.\w+\(\))?$/.exec(tok))) {
    const inner = m[1];
    const masked = maskLite(inner);
    const args = splitArgs(masked, 0, inner.length);
    if (args.length) return urlParts(inner, masked, args[0].start, args[0].end, lang);
  }
  // a project helper that builds a backend URL from a path: backendUrl('/x'), $this->apiUrl('/x')
  if ((m = /^(?:\$this->|self::|static::|this\.|[A-Z]\w*::)?([A-Za-z_]\w*)\s*\(\s*(['"])(\/?[\w\/{}.-]+)\2\s*\)$/.exec(tok)) && /(url|uri|endpoint|api|path)/i.test(m[1]) && !/^(asset|mix|secure_asset|public_path|storage_path|base_path|app_path|resource_path)$/.test(m[1])) {
    return [{ dyn: m[1], base: true }, { lit: m[3].startsWith('/') ? m[3] : '/' + m[3] }];
  }
  if ((m = /^Uri\.(https?)\s*\(([\s\S]*)\)$/.exec(tok))) {
    const inner = m[2];
    const masked = maskLite(inner);
    const args = splitArgs(masked, 0, inner.length);
    if (args.length >= 2) {
      const host = urlParts(inner, masked, args[0].start, args[0].end, lang);
      const p = urlParts(inner, masked, args[1].start, args[1].end, lang);
      const h = host.length === 1 && host[0].lit ? [{ lit: `${m[1]}://${host[0].lit}/` }] : [{ dyn: 'host' }];
      return [...h, ...p];
    }
  }
  return [{ dyn: tok }];
}

// String masking for a small snippet (no comments inside an argument).
function maskLite(s) {
  let out = '';
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '\\') {
        out += 'xx';
        i++;
        continue;
      }
      if (c === q) {
        q = null;
        out += c;
      } else out += c === '\n' ? '\n' : 'x';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') q = c;
    out += c;
  }
  return out;
}

function interpolate(raw, lang, quote, pyF) {
  const parts = [];
  let buf = '';
  const flush = () => {
    if (buf) parts.push({ lit: buf });
    buf = '';
  };
  // Blade/Laravel helpers inside a JS string: "{{ route('x') }}", "{{ url('/x') }}"
  const blade = /\{\{\s*(route|url)\(\s*(["'])([^"']*)\2[^}]*\}\}/g;
  if (blade.test(raw)) {
    blade.lastIndex = 0;
    let last = 0;
    let m;
    while ((m = blade.exec(raw))) {
      buf += raw.slice(last, m.index);
      flush();
      if (m[1] === 'route') parts.push({ route: m[3] });
      else parts.push({ lit: m[3] });
      last = m.index + m[0].length;
    }
    buf += raw.slice(last);
    flush();
    return parts;
  }
  const dollarVars = lang === 'dart' || lang === 'kt' || (lang === 'php' && quote === '"');
  const braceExpr = (quote === '`' && lang === 'js') || lang === 'dart' || lang === 'kt';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\\' && i + 1 < raw.length) {
      buf += raw[i + 1];
      i++;
      continue;
    }
    if (braceExpr && c === '$' && raw[i + 1] === '{') {
      const e = matchBrace(raw, i + 1);
      flush();
      parts.push({ dyn: raw.slice(i + 2, e).trim() });
      i = e;
      continue;
    }
    if (lang === 'php' && quote === '"' && c === '{' && raw[i + 1] === '$') {
      const e = matchBrace(raw, i);
      flush();
      parts.push({ dyn: raw.slice(i + 1, e).trim() });
      i = e;
      continue;
    }
    if (dollarVars && c === '$' && /[A-Za-z_]/.test(raw[i + 1] || '')) {
      const m = /^\$[A-Za-z_]\w*((->|\.)[A-Za-z_]\w*)*/.exec(raw.slice(i));
      flush();
      parts.push({ dyn: m[0].slice(lang === 'php' ? 0 : 1) });
      i += m[0].length - 1;
      continue;
    }
    if (lang === 'py' && c === '{' && raw[i + 1] !== '{') {
      const e = matchBrace(raw, i);
      flush();
      parts.push({ dyn: pyF ? raw.slice(i + 1, e).trim() || '{}' : '{}' });
      i = e;
      continue;
    }
    if (lang === 'py' && c === '%' && /[sd]/.test(raw[i + 1] || '')) {
      flush();
      parts.push({ dyn: '%' });
      i++;
      continue;
    }
    buf += c;
  }
  flush();
  return parts;
}

function matchBrace(s, open) {
  let d = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') d++;
    else if (s[i] === '}') {
      d--;
      if (d === 0) return i;
    }
  }
  return s.length - 1;
}

// A constant by its full name (StringsConst.login), or by its last word when
// the chain starts at a constants holder (a Class, ALL_CAPS, config(), window,
// this). Never `event.target` -> some unrelated `target` constant.
function lookupConst(consts, dyn) {
  if (/[\s=|&!?<>]/.test(dyn.replace(/\?\./g, '.'))) return null;
  const k = constKey(dyn);
  if (consts.has(k)) return consts.get(k);
  const segs = k.split('.');
  if (segs.length === 1) return null;
  const root = segs[0];
  if (/^[A-Z]/.test(root) || /^(config|window|this|self|static|env|constants?|routes?|urls?|endpoints?|api)$/i.test(root)) return consts.get(segs[segs.length - 1]) || null;
  return null;
}

const QUERYISH = /(^|[^A-Za-z]|[a-z](?=[A-Z]))(query|Query|params|Params|qs|QS|queryString|QueryString|search|Search|filters?|Filters?)$/;
const queryish = (dyn) => QUERYISH.test(String(dyn).replace(/\([\s\S]*\)$/, '').replace(/^\$/, ''));

const constKey = (dyn) =>
  dyn
    .replace(/^(this|self|widget|static|self::|static::)(\.|->|::)/, '')
    .replace(/^\$this->/, '')
    .replace(/\(\)/g, '')
    .replace(/::|->/g, '.')
    .replace(/^\$/, '')
    .trim();

// Expands constants, drops the base, builds the path.
export function resolveUrl(parts, consts, baseRe, depth = 0) {
  const names = [];
  let viaConst = null;
  let expanded = [];
  for (const p of parts) {
    if (p.dyn !== undefined && depth < 4) {
      const c = lookupConst(consts, p.dyn);
      if (c && !isBase(p.dyn, baseRe) && !c.base) {
        expanded.push(...c.parts.map((x) => ({ ...x })));
        viaConst = viaConst || c.cite;
        continue;
      }
      if (c && c.base) {
        expanded.push({ dyn: p.dyn, base: true, baseParts: c.parts });
        continue;
      }
    }
    expanded.push(p);
  }
  if (depth < 4 && expanded.some((p) => p.dyn !== undefined && !p.base && lookupConst(consts, p.dyn))) {
    const r = resolveUrl(expanded, consts, baseRe, depth + 1);
    return { ...r, viaConst: r.viaConst || viaConst };
  }
  // leading base
  let idx = 0;
  let base = false;
  let baseGuessed = false;
  let host = null;
  let basePath = '';
  while (idx < expanded.length && expanded[idx].dyn !== undefined && (expanded[idx].base || isBase(expanded[idx].dyn, baseRe))) {
    const b = expanded[idx];
    if (b.baseParts && b.baseParts.length && b.baseParts.every((x) => x.lit !== undefined)) {
      const t = b.baseParts.map((x) => x.lit).join('');
      const m = /^[a-z]+:\/\/([^/]+)(\/.*)?$/i.exec(t);
      if (m) {
        host = m[1].toLowerCase();
        basePath = m[2] || '';
      }
    }
    base = true;
    idx++;
  }
  if (idx < expanded.length && expanded[idx].dyn !== undefined && !expanded[idx].route && expanded[idx + 1] && expanded[idx + 1].lit !== undefined && expanded[idx + 1].lit.startsWith('/')) {
    names.push(expanded[idx].dyn);
    idx++;
    base = true;
    baseGuessed = true;
  }
  const rest = expanded.slice(idx);
  if (rest.length === 1 && rest[0].route) return { routeName: rest[0].route, resolved: true, base, viaConst };
  let text = basePath;
  for (const p of rest) {
    if (p.lit !== undefined) text += p.lit;
    else if (p.route) text += `{route:${p.route}}`;
    else if (queryish(p.dyn)) {
      text += '?';
      break;
    } else {
      text += '{}';
      if (p.dyn && p.dyn !== '%' && p.dyn !== '{}') names.push(p.dyn);
    }
  }
  let m;
  if ((m = /^([a-z]+:)?\/\/([^/?#]+)(.*)$/i.exec(text))) {
    host = m[2].toLowerCase();
    text = m[3] || '/';
  }
  text = text.replace(/[?#].*$/, '');
  const hasLiteral = /[A-Za-z0-9_-]/.test(text.replace(/\{[^}]*\}/g, ''));
  if (!hasLiteral && !(text === '/' && (base || host))) {
    return { resolved: false, reason: rest.length ? `URL built at run time from ${shortNames(names) || 'a variable'}` : 'no path after the base URL', names, base, host };
  }
  const uri = normUri(
    text
      .split('/')
      .map((seg) => (/\{\}/.test(seg) ? '{}' : seg))
      .join('/'),
  );
  return { resolved: true, uri, host, base, baseGuessed, viaConst, names };
}

const shortNames = (names) =>
  names
    .map((n) => n.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '…').replace(/\s+/g, ' ').slice(0, 40))
    .slice(0, 3)
    .join(', ');

export function isBase(dyn, baseRe) {
  if (!dyn) return false;
  if (DEFAULT_BASE.test(dyn)) return true;
  if (baseRe && baseRe.test(dyn)) return true;
  return false;
}

// ------------------------------------------------------------------ constants

const CONST_PATTERNS = {
  js: [/\bwindow\.([A-Za-z_$][\w$]*)\s*=(?!=)\s*/g, /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[\w<>[\]| ]+)?=\s*/g, /(?:^|[{,\s])([A-Za-z_$][\w$]*)\s*:\s*(?=["'`])/g, /\bstatic\s+(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*(?::\s*\w+)?=\s*/g],
  dart: [/\b(?:static\s+)?(?:const|final)\s+(?:String\s+)?([A-Za-z_]\w*)\s*=\s*/g, /\bString\s+get\s+([A-Za-z_]\w*)\s*=>\s*/g, /\b(?:static\s+)?String\s+([A-Za-z_]\w*)\s*=\s*/g],
  php: [/\bconst\s+([A-Za-z_]\w*)\s*=\s*/g, /\b(?:public|protected|private)\s+(?:static\s+)?(?:string\s+)?\$([A-Za-z_]\w*)\s*=\s*/g, /\bdefine\s*\(\s*['"](\w+)['"]\s*,\s*/g],
  py: [/^[ \t]*([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*str\s*)?=\s*/gm],
  java: [/\bstatic\s+final\s+String\s+([A-Za-z_]\w*)\s*=\s*/g, /\bconst\s+val\s+([A-Za-z_]\w*)\s*=\s*/g, /\bval\s+([A-Za-z_]\w*)\s*=\s*/g],
};

const langOf = (file) => {
  const ext = file.split('.').pop().toLowerCase();
  if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'vue', 'svelte'].includes(ext)) return 'js';
  if (ext === 'dart') return 'dart';
  if (ext === 'php') return 'php';
  if (ext === 'py') return 'py';
  if (['java', 'kt', 'kts', 'scala'].includes(ext)) return ext === 'java' ? 'java' : 'kt';
  if (ext === 'go') return 'go';
  return null;
};
export { langOf };

// Name of the class or object an offset sits in (for Class.name keys).
function ownerName(code, mask, pos) {
  let d = 0;
  for (let i = pos; i >= 0; i--) {
    const c = mask[i];
    if (c === '}') d++;
    else if (c === '{') {
      if (d === 0) {
        const before = code.slice(Math.max(0, i - 200), i);
        const m = /(?:class|object|enum|interface|mixin|extension)\s+([A-Za-z_]\w*)[^{;]*$/.exec(before) || /(?:const|let|var|final|static)\s+(?:\w+\s+)?([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*$/.exec(before);
        return m ? m[1] : null;
      }
      d--;
    }
  }
  return null;
}

export function collectConsts(files, src, baseRe) {
  const consts = new Map();
  const dup = new Set();
  const add = (key, entry) => {
    if (!key) return;
    if (consts.has(key)) {
      const old = consts.get(key);
      if (JSON.stringify(old.parts) !== JSON.stringify(entry.parts)) dup.add(key);
      return;
    }
    consts.set(key, entry);
  };
  for (const file of files) {
    const page = /\.(blade\.php|html?|vue|svelte)$/i.test(file);
    const lang = page ? 'js' : langOf(file);
    const pats = lang === 'kt' ? CONST_PATTERNS.java : CONST_PATTERNS[lang];
    if (!pats) continue;
    const s = src(file);
    if (!s) continue;
    if (!/['"`]/.test(s.text) || !/\/|https?:|route\(/.test(s.text)) continue;
    for (const re of pats) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(s.mask))) {
        const name = s.code.slice(m.index, m.index + m[0].length).match(re.source.includes('define') ? /['"](\w+)['"]/ : /([A-Za-z_$][\w$]*)\s*(?::[^=]*)?(?:=>|=|:)\s*$/);
        const nm = name ? name[1] : m[1];
        const vs = m.index + m[0].length;
        // value ends at ; or newline or , or } at depth 0
        let depth = 0;
        let e = vs;
        for (; e < s.mask.length; e++) {
          const c = s.mask[e];
          if (c === '(' || c === '[' || c === '{') depth++;
          else if (c === ')' || c === ']' || c === '}') {
            if (depth === 0) break;
            depth--;
          } else if (depth === 0 && (c === ';' || c === '\n' || c === ',')) break;
        }
        const parts = urlParts(s.code, s.mask, vs, e, lang);
        if (!parts.length || parts.length > 12) continue;
        const text = parts.map((p) => p.lit || '').join('');
        const absolute = /^[a-z]+:\/\//i.test(text);
        const alias = parts.length === 1 && parts[0].dyn !== undefined && isBase(parts[0].dyn, baseRe);
        const urlish = alias || parts.some((p) => p.route) || absolute || (parts.some((p) => p.lit !== undefined && p.lit.includes('/')) && !ASSET.test(text.replace(/[?#].*$/, ''))) || (parts.some((p) => p.dyn !== undefined && isBase(p.dyn, baseRe)) && parts.length > 1);
        if (!urlish) continue;
        const base = alias || (absolute && parts.length === 1 && /^[a-z]+:\/\/[^/]+\/?[^/]*\/?$/i.test(text)) || (isBase(nm, baseRe) && !parts.some((p) => p.lit && /^\/[a-z]/i.test(p.lit) && parts.indexOf(p) > 0));
        const entry = { parts, cite: `${file}:${s.lineAt(m.index)}`, base };
        const owner = ownerName(s.code, s.mask, m.index);
        if (owner) add(`${owner}.${nm}`, entry);
        add(nm, entry);
      }
    }
  }
  for (const k of dup) consts.delete(k);
  return consts;
}

// ------------------------------------------------------------------ call sites

function methodFrom(code, mask, start, end) {
  const t = code.slice(start, end);
  const m = /\b(method|type|requestType|httpMethod|verb)\s*[:=]\s*(?:(["'])([A-Za-z]+)\2|[\w.]*?\.?([A-Za-z]+)\b)/.exec(t);
  if (!m) return null;
  const v = (m[3] || m[4] || '').toUpperCase();
  return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(v) ? v : null;
}

function enclosingOpen(mask, pos) {
  let d = 0;
  for (let i = pos - 1; i >= 0; i--) {
    const c = mask[i];
    if (c === ')' || c === '}' || c === ']') d++;
    else if (c === '(' || c === '{' || c === '[') {
      if (d === 0) return i;
      d--;
    }
  }
  return -1;
}

function statementStart(mask, pos) {
  for (let i = pos - 1; i >= 0; i--) if (mask[i] === ';' || mask[i] === '{' || mask[i] === '}') return i + 1;
  return 0;
}

// Finds the call sites in one file. Returns raw sites:
// { method, start, end (url expression offsets), line, via, receiver, httpish }
function sitesIn(s, lang, alsoJs = false) {
  const out = [];
  const { code, mask } = s;
  let curLang = lang;
  const push = (o) => out.push({ lang: curLang, ...o });
  const args = (open) => {
    const c = closing(mask, open);
    return c === -1 ? null : { list: splitArgs(mask, open + 1, c), close: c };
  };
  let m;
  const jsl = alsoJs ? 'js' : lang;
  if (lang === 'js' || lang === 'php' || lang === 'dart') {
    // fetch(url, { method })
    const reFetch = /(?<![\w$.])(fetch|\$fetch|useFetch|useSWR|ky)\s*\(/g;
    while ((m = reFetch.exec(mask))) {
      const a = args(m.index + m[0].length - 1);
      if (!a || !a.list.length) continue;
      const method = (a.list[1] && methodFrom(code, mask, a.list[1].start, a.list[1].end)) || 'GET';
      push({ method, start: a.list[0].start, end: a.list[0].end, pos: m.index, via: m[1], receiver: m[1], httpish: true });
    }
  }
  if (lang === 'js' || lang === 'dart' || alsoJs) {
    curLang = jsl;
    // x.get(url) / x.post(url, body) / $.get / $.post
    const re = /(?<![\w$@])((?:this\.)?[A-Za-z_$][\w$]*(?:\(\s*\))?)\s*\.\s*(get|post|put|patch|delete|head|getJSON)\s*(?:<[^>()]*>)?\s*\(/g;
    while ((m = re.exec(mask))) {
      const recv = m[1].replace(/\(\s*\)$/, '');
      if (NOT_HTTP_RECEIVERS.has(recv.replace(/^this\./, '').toLowerCase())) continue;
      const a = args(m.index + m[0].length - 1);
      if (!a || !a.list.length) continue;
      const method = m[2] === 'getJSON' ? 'GET' : m[2].toUpperCase();
      push({ method, start: a.list[0].start, end: a.list[0].end, pos: m.index, via: `${recv}.${m[2]}`, receiver: recv, httpish: HTTPISH.test(recv), argc: a.list.length, args: a.list });
    }
    // x.request(url, { method }) / axios({ url, method }) / $.ajax({ url, type })
    const reCfg = /(?<![\w$])((?:this\.)?[A-Za-z_$][\w$]*(?:\s*\.\s*(?:request|ajax|fetch))?)\s*\(\s*\{/g;
    while ((m = reCfg.exec(mask))) {
      const head = m[1].replace(/\s+/g, '');
      if (!/^(axios|\$\.ajax|jQuery\.ajax|.*\.request|.*\.fetch|request|ajax)$/i.test(head)) continue;
      const open = m.index + m[0].length - 1;
      const close = closing(mask, open);
      if (close === -1) continue;
      const k = /(?:^|[{,\s])url\s*:\s*/.exec(mask.slice(open, close));
      if (!k) continue;
      const vs = open + k.index + k[0].length;
      let e = vs;
      let depth = 0;
      for (; e < close; e++) {
        const c = mask[e];
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') depth--;
        else if (c === ',' && depth === 0) break;
      }
      push({ method: methodFrom(code, mask, open, close) || 'GET', start: vs, end: e, pos: m.index, via: head, receiver: head, httpish: true, methodGuessed: !methodFrom(code, mask, open, close) });
    }
    // Dio-style request(url, options: Options(method: 'POST'))
    const reReq = /(?<![\w$])((?:this\.)?[A-Za-z_$][\w$]*)\s*\.\s*request\s*(?:<[^>()]*>)?\s*\(\s*(?!\{)/g;
    while ((m = reReq.exec(mask))) {
      const open = mask.indexOf('(', m.index + m[1].length);
      const a = args(open);
      if (!a || !a.list.length) continue;
      const method = methodFrom(code, mask, open, a.close);
      push({ method: method || 'GET', methodGuessed: !method, start: a.list[0].start, end: a.list[0].end, pos: m.index, via: `${m[1]}.request`, receiver: m[1], httpish: true });
    }
    // named arguments: someApi.call(url: X, method: MethodType.post)
    const reNamed = /(?<![\w$.'"])(url|endpoint|apiUrl|api_url|path)\s*:\s*(?![\s/])/g;
    while ((m = reNamed.exec(mask))) {
      if ((lang === 'js' || alsoJs) && m[1] === 'path') continue;
      const open = enclosingOpen(mask, m.index);
      if (open === -1 || mask[open] !== '(' && lang === 'dart') continue;
      const head = code.slice(Math.max(0, open - 60), open).replace(/[\s(]*$/, '').match(/([A-Za-z_$][\w$.]*)$/);
      const headName = head ? head[1] : '';
      if (/^(GoRoute|Route|path|RouteConfig|NetworkImage|Image\.network|CachedNetworkImage|launchUrl|WebView|Link)$/.test(headName.split('.').pop())) continue;
      if ((lang === 'js' || alsoJs) && /^(axios|\$\.ajax|jQuery\.ajax|ajax|request|[\w$]+\.request|[\w$]+\.fetch)$/i.test(headName.replace(/\s+/g, ''))) continue; // handled above
      const close = closing(mask, open);
      if (close === -1) continue;
      const vs = m.index + m[0].length;
      let e = vs;
      let depth = 0;
      for (; e < close; e++) {
        const c = mask[e];
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') depth--;
        else if (c === ',' && depth === 0) break;
      }
      const method = methodFrom(code, mask, open, close);
      push({ method: method || 'GET', methodGuessed: !method, start: vs, end: e, pos: m.index, via: headName ? `${headName}(${m[1]}:)` : `${m[1]}:`, receiver: headName, httpish: /ajax|axios|request|fetch|http|api|dio|call|send|network|service|client/i.test(headName) });
    }
  }
  curLang = lang;
  if (lang === 'php') {
    const re = /(->|::)\s*(get|post|put|patch|delete|head)\s*\(/g;
    while ((m = re.exec(mask))) {
      const st = statementStart(mask, m.index);
      const stmt = code.slice(st, m.index + m[0].length);
      const recv = (/(\$[\w>-]+|[A-Z]\w*)\s*$/.exec(code.slice(st, m.index).replace(/\s+$/, '')) || [])[1] || '';
      const httpish = /\bHttp::|\bGuzzle|\$(client|http|guzzle|api)\b|->(client|http|api)\b/i.test(stmt);
      if (!httpish) continue;
      const a = args(m.index + m[0].length - 1);
      if (!a || !a.list.length) continue;
      push({ method: m[2].toUpperCase(), start: a.list[0].start, end: a.list[0].end, pos: m.index, via: 'Http/Guzzle', receiver: recv, httpish: true });
    }
    const reGz = /->\s*request\s*\(\s*(['"])(GET|POST|PUT|PATCH|DELETE)\1\s*,/gi;
    while ((m = reGz.exec(code))) {
      const a = args(m.index + m[0].indexOf('('));
      if (!a || a.list.length < 2) continue;
      push({ method: m[2].toUpperCase(), start: a.list[1].start, end: a.list[1].end, pos: m.index, via: 'Guzzle request', receiver: 'client', httpish: true });
    }
    const reCurl = /curl_setopt\s*\(\s*\$\w+\s*,\s*CURLOPT_URL\s*,/g;
    while ((m = reCurl.exec(mask))) {
      const a = args(m.index + m[0].indexOf('('));
      if (!a || a.list.length < 3) continue;
      push({ method: 'GET', methodGuessed: true, start: a.list[2].start, end: a.list[2].end, pos: m.index, via: 'curl', receiver: 'curl', httpish: true });
    }
  }
  if (lang === 'py') {
    const re = /(?<![\w.@])((?:self\.)?[A-Za-z_]\w*)\s*\.\s*(get|post|put|patch|delete|head|request)\s*\(/g;
    while ((m = re.exec(mask))) {
      const recv = m[1];
      if (!/^(requests|httpx|session|sess|s|client|http|api|self\.(session|client|http|api|_session|_client))$|client$|session$|api$|http$/i.test(recv)) continue;
      if (/^(test_?client|self\.client)$/i.test(recv)) continue; // test clients call the app itself
      const a = args(m.index + m[0].length - 1);
      if (!a || !a.list.length) continue;
      if (m[2] === 'request') {
        if (a.list.length < 2) continue;
        const meth = (/["'](\w+)["']/.exec(code.slice(a.list[0].start, a.list[0].end)) || [])[1];
        push({ method: (meth || 'GET').toUpperCase(), start: a.list[1].start, end: a.list[1].end, pos: m.index, via: `${recv}.request`, receiver: recv, httpish: true });
      } else push({ method: m[2].toUpperCase(), start: a.list[0].start, end: a.list[0].end, pos: m.index, via: `${recv}.${m[2]}`, receiver: recv, httpish: true });
    }
  }
  if (lang === 'java' || lang === 'kt') {
    const re = /\b\w*[rR]est[tT]emplate\s*\.\s*(getForObject|getForEntity|postForObject|postForEntity|postForLocation|put|delete|patchForObject|exchange)\s*\(/g;
    while ((m = re.exec(mask))) {
      const a = args(m.index + m[0].length - 1);
      if (!a || !a.list.length) continue;
      let method = m[1].startsWith('get') ? 'GET' : m[1].startsWith('post') ? 'POST' : m[1].startsWith('patch') ? 'PATCH' : m[1].toUpperCase();
      if (m[1] === 'exchange') method = ((/HttpMethod\.(\w+)/.exec(code.slice(a.list[1] ? a.list[1].start : 0, a.list[1] ? a.list[1].end : 0)) || [])[1] || 'GET').toUpperCase();
      push({ method, start: a.list[0].start, end: a.list[0].end, pos: m.index, via: `RestTemplate.${m[1]}`, receiver: 'restTemplate', httpish: true });
    }
    const reWc = /\.\s*(get|post|put|patch|delete)\s*\(\s*\)\s*\.\s*uri\s*\(/g;
    while ((m = reWc.exec(mask))) {
      const a = args(m.index + m[0].length - 1);
      if (!a || !a.list.length) continue;
      push({ method: m[1].toUpperCase(), start: a.list[0].start, end: a.list[0].end, pos: m.index, via: 'WebClient', receiver: 'webClient', httpish: true });
    }
  }
  if (lang === 'go') {
    const re = /\bhttp\s*\.\s*(Get|Post|Head)\s*\(/g;
    while ((m = re.exec(mask))) {
      const a = args(m.index + m[0].length - 1);
      if (!a || !a.list.length) continue;
      push({ method: m[1].toUpperCase(), start: a.list[0].start, end: a.list[0].end, pos: m.index, via: `http.${m[1]}`, receiver: 'http', httpish: true });
    }
    const reNr = /\bhttp\s*\.\s*NewRequest(?:WithContext)?\s*\(/g;
    while ((m = reNr.exec(mask))) {
      const a = args(m.index + m[0].length - 1);
      if (!a) continue;
      const list = /WithContext/.test(m[0]) ? a.list.slice(1) : a.list;
      if (list.length < 2) continue;
      const meth = (/"(\w+)"|http\.Method(\w+)/.exec(code.slice(list[0].start, list[0].end)) || []).slice(1).find(Boolean);
      push({ method: (meth || 'GET').toUpperCase(), start: list[1].start, end: list[1].end, pos: m.index, via: 'http.NewRequest', receiver: 'http', httpish: true });
    }
  }
  return out;
}

// ------------------------------------------------------------------ local variables

// End of an assigned value: ; or , or a line end at depth 0, unless the line
// continues with a concatenation operator.
function valueEnd(mask, vs) {
  let depth = 0;
  for (let e = vs; e < mask.length; e++) {
    const c = mask[e];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return e;
      depth--;
    } else if (depth === 0 && (c === ';' || c === ',')) return e;
    else if (depth === 0 && c === '\n') {
      const before = mask.slice(Math.max(vs, e - 40), e).trimEnd();
      const after = mask.slice(e + 1, e + 40).trimStart();
      if (/[.+(]$/.test(before) || /^[.+]/.test(after)) continue;
      return e;
    }
  }
  return mask.length;
}

// The value most recently assigned to a variable before `pos`, in the same
// function: $url = config('app.backend_url') . '/x'; (then $url .= '/y').
// `$this->prop` is looked up anywhere in the file (constructors set it).
function localValue(s, lang, name, pos) {
  const prop = /^\$this->(\w+)$/.exec(name) || /^this\.(\w+)$/.exec(name);
  let from = prop ? 0 : Math.max(0, pos - 8000);
  if (!prop) {
    const fnRe = lang === 'py' ? /\n[ \t]*(?:async\s+)?def\s/g : lang === 'php' ? /\bfunction\s+\w+\s*\(/g : lang === 'js' ? /\bfunction\b|=>\s*\{/g : null;
    if (fnRe) {
      fnRe.lastIndex = from;
      let m;
      let last = -1;
      while ((m = fnRe.exec(s.mask)) && m.index < pos) last = m.index;
      if (last >= 0) from = last;
    }
  }
  const target = prop ? (lang === 'php' ? `\\$this->${prop[1]}` : `this\\.${prop[1]}`) : name.replace(/\$/g, '\\$');
  const re = new RegExp(`(?:^|[^\\w$>.])(?:(?:const|let|var|final|String|string)\\s+)?${target}\\s*(?::\\s*[\\w<>?\\[\\]]+\\s*)?(\\.=|\\+=|=)(?![=>])\\s*`, 'g');
  re.lastIndex = from;
  const hits = [];
  let m;
  while ((m = re.exec(s.mask))) {
    if (!prop && m.index >= pos) break;
    hits.push({ op: m[1], vs: m.index + m[0].length, at: m.index });
    if (prop && m[1] === '=') break; // the first plain assignment of a property
  }
  let start = -1;
  for (let i = hits.length - 1; i >= 0; i--) if (hits[i].op === '=') {
    start = i;
    break;
  }
  if (start === -1) return null;
  let alts = [[]];
  for (const h of hits.slice(start)) {
    const ve = valueEnd(s.mask, h.vs);
    const opts = branches(s.mask, h.vs, ve).map(([a, b]) => urlParts(s.code, s.mask, a, b, lang));
    alts = h.op === '=' ? opts : alts.flatMap((x) => opts.map((o) => x.concat(o))).slice(0, 4);
  }
  return { alts, at: hits[start].at };
}

// Replaces simple variables by the values assigned to them. Returns a list of
// alternatives (a ternary gives two), at most 4.
function expandLocals(parts, s, lang, pos, depth = 0) {
  if (depth > 2) return [parts];
  const simple = lang === 'php' ? /^\$(?:this->)?[A-Za-z_]\w*$/ : /^(?:this\.)?[A-Za-z_$][\w$]*$/;
  let alts = [[]];
  for (const p of parts) {
    let opts = [[p]];
    if (p.dyn !== undefined && !p.base && simple.test(p.dyn) && p.dyn !== '$this' && p.dyn !== 'this' && !queryish(p.dyn)) {
      const v = localValue(s, lang, p.dyn, pos);
      if (v && v.alts.length && v.alts.every((a) => a.length && a.length <= 12) && !(v.alts.length === 1 && v.alts[0].length === 1 && v.alts[0][0].dyn === p.dyn)) {
        opts = v.alts.flatMap((a) => expandLocals(a, s, lang, v.at, depth + 1));
      }
    }
    alts = alts.flatMap((x) => opts.map((o) => x.concat(o))).slice(0, 4);
  }
  return alts;
}

// `cond ? '/a' : '/b'` gives two calls, one per branch.
function branches(mask, start, end) {
  let depth = 0;
  let q = -1;
  for (let i = start; i < end; i++) {
    const c = mask[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && c === '?' && mask[i + 1] !== '.' && mask[i + 1] !== '?' && mask[i - 1] !== '?') {
      q = i;
      break;
    }
  }
  if (q === -1) return [[start, end]];
  depth = 0;
  for (let i = q + 1; i < end; i++) {
    const c = mask[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && c === ':' && mask[i + 1] !== ':' && mask[i - 1] !== ':') return [[q + 1, i], [i + 1, end]];
  }
  return [[start, end]];
}

// All calls of one app. `skip` = Set of "file:line" route definitions (a
// router.get('/x', handler) is a route, not a call). `screenFiles` = Set of
// files that are screens (a call in a screen file is credited to it).
export function readCalls({ files, src, baseRe = null, consts = null, skip = new Set(), screenFiles = new Map() }) {
  const codeFiles = files.filter((f) => langOf(f) && !isTestFile(f) && !isVendored(f));
  const C = consts || collectConsts(codeFiles, src, baseRe);
  const calls = [];
  for (const file of codeFiles) {
    const lang = langOf(file);
    const s = src(file);
    if (!s) continue;
    if (!/get|post|put|patch|delete|fetch|ajax|request|url|endpoint|curl|http|uri/i.test(s.text)) continue;
    const seen = new Set();
    for (const site of sitesIn(s, lang, /\.(blade\.php|vue|svelte|html?)$/i.test(file))) {
      const line = s.lineAt(site.pos);
      if (skip.has(`${file}:${line}`)) continue;
      if (site.end <= site.start) continue;
      // a backend route definition: x.get('/path', handler…) with a function argument
      if (site.args && site.args.length >= 2 && (lang === 'js' || lang === 'dart')) {
        const last = s.code.slice(site.args[site.args.length - 1].start, site.args[site.args.length - 1].end).trim();
        if (/^(async\s+)?(function\b|\(?[\w\s,{}:]*\)?\s*=>)/.test(last) && !/^\{/.test(last)) continue;
      }
      const alternatives = branches(s.mask, site.start, site.end).flatMap(([bs, be]) => expandLocals(urlParts(s.code, s.mask, bs, be, site.lang || lang), s, site.lang || lang, site.pos)).slice(0, 4);
      for (const parts of alternatives) {
      if (!parts.length) continue;
      const r = resolveUrl(parts, C, baseRe);
      const literalPath = parts.some((p) => p.lit !== undefined && (p.lit.includes('/') || /^[a-z]+:/i.test(p.lit)));
      const slashless = parts.length === 1 && parts[0].lit !== undefined && /^[a-z][\w-]*(\/|$)/i.test(parts[0].lit);
      if (r.resolved) {
        if (r.uri && (ASSET.test(r.uri) || /(^|\/)\.\.?(\/|$)/.test(r.uri) || /\.json$/i.test(r.uri))) continue;
        if (!(r.base || r.host || r.viaConst || r.routeName || literalPath || (slashless && site.httpish))) continue;
        if (!site.httpish && !r.base && !r.host && !r.viaConst && !r.routeName && !(r.uri || '').includes('/') && parts.length === 1) continue;
      } else if (!site.httpish) continue;
      const key = `${line}:${site.method}:${r.uri || r.routeName || r.reason}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const dir = file.split('/').slice(0, -1);
      const call = {
        method: site.method,
        uri: r.resolved && r.uri ? r.uri : null,
        shape: r.resolved && r.uri ? shapeOf(r.uri) : null,
        routeName: r.routeName || null,
        file,
        line,
        cite: `${file}:${line}`,
        via: site.via.slice(0, 60),
        host: r.host || null,
        resolved: !!r.resolved,
        reason: r.resolved ? null : r.reason,
        viaConst: r.viaConst || null,
        screen: screenFiles.get(file) || null,
        area: J(...dir.slice(0, Math.min(dir.length, 3))),
        base: !!r.base,
        side: ['php', 'py', 'java', 'kt', 'go'].includes(lang) && !/\.(blade\.php|vue|svelte|html?)$/i.test(file) ? 'server' : 'client',
        class: r.resolved && !r.baseGuessed && !site.methodGuessed ? 'Verified' : 'Inferred',
      };
      calls.push(call);
      }
    }
  }
  return { calls, consts: C };
}
