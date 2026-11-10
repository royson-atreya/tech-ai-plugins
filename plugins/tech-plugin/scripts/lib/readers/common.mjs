// Shared pieces of the code readers (breakdown stage 3).
//
// Every reader fills ONE common fact format per app, whatever the stack:
//   routes    { key, method, uri, shape, handler, handlerFile, action, middleware, name, kind, cite, class, shadowed }
//   handlers  { id, file, cite, methods: [{ name, line, views, models, tables }] }
//   screens   { id, name, file, cite, path, kind, renderedBy, links, partial, class }
//   calls     { method, uri, shape, file, line, cite, via, host, resolved, reason, viaConst, screen, area, class }
//   tables    { name, cite, source, columns, models, class }
//   models    { name, table, file, cite, relations }
//   groups    { id, label, files, class }        (generic reader only: code groups from the graph)
//   unparsed  { cite, text }
// Facts cite `path:line` relative to the repo; the repo name is added when
// documents are written. Class: Verified = read from code; Inferred = a guess
// from conventions or names.
//
// WHY masking: route and call patterns are matched on a copy of the source in
// which comments are blanked and string contents replaced, so a commented-out
// route or a URL inside a log message never counts. Offsets stay identical, so
// values are read from the real text at the same positions.

import path from 'node:path';
import { SKIP_DIRS } from '../stacks.mjs';

export const J = (...p) => path.posix.join(...p.filter((x) => x && x !== '.')) || '.';

// ------------------------------------------------------------------ masking

// Returns { code, mask, comments }: `code` = text with comments blanked,
// `mask` = code with string contents replaced by 'x'. Both keep every newline
// and the original length. `comments` = [{ start, end }].
//   opts.hash: '#' starts a line comment (PHP, Python, shell)
//   opts.slash: '//' and '/* */' comments (C-like languages, PHP)
//   opts.triple: Python ''' and """ strings
//   opts.backtick: ` strings (JS templates, Go raw strings)
export function maskSource(text, { hash = false, slash = true, triple = false, backtick = true, multiline = false } = {}) {
  const n = text.length;
  const code = text.split('');
  const mask = text.split('');
  const comments = [];
  let i = 0;
  const blank = (a, b, arr) => {
    for (let k = a; k < b; k++) if (arr[k] !== '\n') arr[k] = ' ';
  };
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (slash && c === '/' && d === '/') {
      const e = text.indexOf('\n', i);
      const end = e === -1 ? n : e;
      blank(i, end, code);
      blank(i, end, mask);
      comments.push({ start: i, end });
      i = end;
      continue;
    }
    if (slash && c === '/' && d === '*') {
      const e = text.indexOf('*/', i + 2);
      const end = e === -1 ? n : e + 2;
      blank(i, end, code);
      blank(i, end, mask);
      comments.push({ start: i, end });
      i = end;
      continue;
    }
    if (hash && c === '#' && !(text[i + 1] === '[')) {
      const e = text.indexOf('\n', i);
      const end = e === -1 ? n : e;
      blank(i, end, code);
      blank(i, end, mask);
      comments.push({ start: i, end });
      i = end;
      continue;
    }
    if (triple && (text.startsWith('"""', i) || text.startsWith("'''", i))) {
      const q = text.slice(i, i + 3);
      const e = text.indexOf(q, i + 3);
      const end = e === -1 ? n : e + 3;
      for (let k = i + 3; k < end - 3; k++) if (mask[k] !== '\n') mask[k] = 'x';
      i = end;
      continue;
    }
    if (c === '"' || c === "'" || (backtick && c === '`')) {
      let k = i + 1;
      while (k < n) {
        if (text[k] === '\\') {
          k += 2;
          continue;
        }
        if (text[k] === c) break;
        if (text[k] === '\n' && c !== '`' && !multiline) break; // unterminated: stop at the line end
        k++;
      }
      for (let m = i + 1; m < Math.min(k, n); m++) if (mask[m] !== '\n') mask[m] = 'x';
      i = k + 1;
      continue;
    }
    i++;
  }
  return { code: code.join(''), mask: mask.join(''), comments };
}

export const PHP_MASK = { hash: true, slash: true, backtick: false, multiline: true };
export const PY_MASK = { hash: true, slash: false, triple: true, backtick: false };
export const C_MASK = { hash: false, slash: true, backtick: true };

// Line number (1-based) of an offset, using a cached table of line starts.
export function lineFinder(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (off) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

// Index of the bracket that closes the one at `open` (in a masked text), or -1.
export function closing(mask, open) {
  const o = mask[open];
  const c = { '(': ')', '[': ']', '{': '}' }[o];
  let depth = 0;
  for (let i = open; i < mask.length; i++) {
    if (mask[i] === o) depth++;
    else if (mask[i] === c) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Splits an argument list (text between brackets) at top-level commas.
// Works on the mask; returns [{ start, end }] offsets relative to `from`.
export function splitArgs(mask, from, to) {
  const out = [];
  let depth = 0;
  let s = from;
  for (let i = from; i < to; i++) {
    const ch = mask[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      out.push({ start: s, end: i });
      s = i + 1;
    }
  }
  if (to > s && /\S/.test(mask.slice(s, to))) out.push({ start: s, end: to });
  return out;
}

// The value of a plain string literal in `code` between start and end, or null.
export function literal(code, start = 0, end = code.length) {
  const t = code.slice(start, end).trim();
  const m = /^(?:[rbuf]{0,2})(["'`])([\s\S]*)\1$/i.exec(t);
  if (!m) return null;
  if (m[1] === '`' && m[2].includes('${')) return null;
  return m[2];
}

// ------------------------------------------------------------------ paths

// Route or call path in one form: no leading or trailing slash, no query,
// parameters written {name}. ':id', '<int:id>', '[id]', '[...slug]' and
// '{id?}' all become {id} / {slug} / {id?}.
export function normUri(u) {
  if (u === null || u === undefined) return null;
  let s = String(u).trim();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
  s = s.replace(/[?#].*$/, '');
  s = s.replace(/\/+/g, '/');
  s = s
    .split('/')
    .map((seg) => {
      if (!seg) return seg;
      let m;
      if ((m = /^:([A-Za-z_][\w-]*)(\?)?(\(.*\))?$/.exec(seg))) return `{${m[1]}${m[2] || ''}}`;
      if ((m = /^<(?:[a-z_]+:)?([A-Za-z_]\w*)>$/.exec(seg))) return `{${m[1]}}`;
      if ((m = /^\[\[?(?:\.\.\.)?([A-Za-z_]\w*)\]?\]$/.exec(seg))) return `{${m[1]}}`;
      if ((m = /^\(\?P<([A-Za-z_]\w*)>[^)]*\)$/.exec(seg))) return `{${m[1]}}`;
      if (seg === '*' || seg === '**') return '{*}';
      return seg;
    })
    .join('/');
  s = s.replace(/^\/+|\/+$/g, '');
  return s === '' ? '/' : s;
}

// The comparable shape: every {param} becomes {}.
export function shapeOf(uri) {
  if (uri === '/') return '/';
  return uri
    .split('/')
    .map((seg) => (/\{[^}]*\}/.test(seg) || seg === '{}' ? '{}' : seg))
    .join('/');
}

export function joinUri(...parts) {
  const s = parts
    .filter((p) => p !== null && p !== undefined && p !== '' && p !== '/')
    .map((p) => String(p).replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return s === '' ? '/' : s;
}

export function routeKey(method, uri) {
  return `${method} ${uri}`;
}

export function makeRoute({ method, uri, handler = null, handlerFile = null, action = null, middleware = [], name = null, kind = 'route', file, line, cls = 'Verified', extra = {} }) {
  const u = normUri(uri);
  return {
    key: routeKey(method, u),
    method,
    uri: u,
    shape: shapeOf(u),
    handler,
    handlerFile,
    action,
    middleware,
    name,
    kind,
    cite: `${file}:${line}`,
    class: cls,
    shadowed: false,
    ...extra,
  };
}

// Later registrations of the same METHOD + URI win in most frameworks; the
// earlier ones are marked shadowed (never reachable).
export function markShadowed(routes) {
  const last = new Map();
  routes.forEach((r, i) => last.set(r.key, i));
  routes.forEach((r, i) => {
    r.shadowed = last.get(r.key) !== i;
  });
  return routes;
}

// ------------------------------------------------------------------ files

const TEST_RE = /(^|\/)(tests?|__tests__|spec|specs|e2e|integration_test|test_driver|cypress|playwright)\/|\.(test|spec)\.[a-z]+$|_test\.(dart|go|py)$|(^|\/)test_[^/]*\.py$|Test\.(php|java|kt)$/i;
export const isTestFile = (f) => TEST_RE.test(f);
const VENDORED_RE = /(^|\/)(public\/(vendor|plugins|assets\/vendor|libs?|build|js\/vendor)|static\/vendor|assets\/vendor)\/|\.min\.(js|css)$|\.bundle\.js$|\.map$/i;
export const isVendored = (f) => VENDORED_RE.test(f);

// Every file under `root` (relative to the repo), skipping dependency and
// build folders, secrets and the folders of other apps. Sorted, capped.
export function listFiles(reader, root, { exclude = [], max = 40000, maxDepth = 14 } = {}) {
  const out = [];
  const stack = [[root, 0]];
  const ex = new Set(exclude.filter((x) => x !== root));
  while (stack.length && out.length < max) {
    const [d, depth] = stack.pop();
    for (const e of reader.list(d)) {
      const r = J(d, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIRS.has(e.name.toLowerCase()) && !e.name.startsWith('.') && !ex.has(r)) stack.push([r, depth + 1]);
      } else if (e.isFile() && !reader.isSecret(r) && !reader.isSecret(e.name)) {
        out.push(r);
        if (out.length >= max) break;
      }
    }
  }
  return out.sort();
}

// Reads a file through the safe reader and masks it once; cached per run.
export function sourceCache(reader) {
  const cache = new Map();
  return (file) => {
    if (cache.has(file)) return cache.get(file);
    const text = reader.text(file, 2 * 1024 * 1024);
    let v = null;
    if (text !== null) {
      const ext = file.split('.').pop().toLowerCase();
      const opts = ext === 'php' ? PHP_MASK : ext === 'py' ? PY_MASK : ['rb', 'sh', 'yml', 'yaml'].includes(ext) ? { hash: true, slash: false, backtick: false } : ext === 'dart' ? { ...C_MASK, backtick: false } : C_MASK;
      const m = maskSource(text, opts);
      v = { text, ...m, lineAt: lineFinder(text) };
    }
    cache.set(file, v);
    return v;
  };
}

export function emptyFacts(app) {
  return {
    id: app.id,
    root: app.root,
    kind: app.kind,
    stack: app.stack.map((s) => s.name),
    readers: [],
    routes: [],
    handlers: [],
    screens: [],
    calls: [],
    tables: [],
    models: [],
    groups: [],
    unparsed: [],
    notes: [],
  };
}

// snake_case plural of a class name, the way Laravel and Rails guess a table.
export function tableGuess(cls) {
  const snake = cls.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  if (/[^aeiou]y$/.test(snake)) return snake.slice(0, -1) + 'ies';
  if (/(s|x|z|ch|sh)$/.test(snake)) return snake + 'es';
  return snake + 's';
}

export function singular(word) {
  if (/ies$/.test(word)) return word.slice(0, -3) + 'y';
  if (/(ss|us)$/.test(word)) return word;
  if (/(xes|ches|shes|sses)$/.test(word)) return word.slice(0, -2);
  if (/s$/.test(word)) return word.slice(0, -1);
  return word;
}

export function uniq(arr) {
  return [...new Set(arr)];
}
