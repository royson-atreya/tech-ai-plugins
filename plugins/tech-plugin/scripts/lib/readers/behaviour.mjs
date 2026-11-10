// Behaviour facts for documents (document stage): what a handler checks and
// what it tells people, and what a screen shows.
//   Laravel   validation rules ($request->validate, Validator::make,
//             $this->validate, FormRequest rules()), custom messages, abort(),
//             flash messages (->with('error', ...)), withErrors, JSON messages
//   Blade     page titles, headings, labels, buttons, table headers and
//             placeholders, with __('key') / @lang / trans() resolved from the
//             English language files
//   Others    JS res.status(4xx).json({ message }), Python HTTPException(detail=)
// Every text taken from code passes the redaction filter; nothing else from
// string literals is kept.

import { closing, J, uniq } from './common.mjs';
import { phpMethods } from './laravel.mjs';
import { redact } from '../redact.mjs';

const MAX = 30;
const lit = (t) => {
  const m = /^\s*(["'])((?:\\.|(?!\1).)*)\1\s*$/.exec(t);
  return m ? m[2].replace(/\\(['"])/g, '$1') : null;
};
const clean = (t) => redact(String(t).replace(/\s+/g, ' ').trim()).slice(0, 160);

// ------------------------------------------------------------------ language files

export function loadLang(files, src) {
  const map = new Map();
  const set = (k, v) => {
    if (typeof v === 'string' && !map.has(k)) map.set(k, v);
  };
  const flatten = (obj, pre = '') => {
    for (const [k, v] of Object.entries(obj || {})) {
      if (v && typeof v === 'object') flatten(v, pre ? `${pre}.${k}` : k);
      else set(pre ? `${pre}.${k}` : k, v);
    }
  };
  for (const f of files) {
    if (!/(^|\/)(lang|locales?|i18n|translations)\//i.test(f)) continue;
    if (/(^|\/)en([_-][\w-]+)?\.json$/i.test(f)) {
      const s = src(f);
      if (!s) continue;
      try {
        flatten(JSON.parse(s.text));
      } catch {
        /* not JSON */
      }
    } else if (/(^|\/)en\/([\w-]+)\.php$/i.test(f)) {
      const s = src(f);
      if (!s) continue;
      const group = /\/en\/([\w-]+)\.php$/i.exec(f)[1];
      for (const m of s.text.matchAll(/(["'])([\w.-]+)\1\s*=>\s*(["'])((?:\\.|(?!\3).)*)\3/g)) set(`${group}.${m[2]}`, m[4]);
    }
  }
  return map;
}

// ------------------------------------------------------------------ Laravel handlers

function arrayEntries(code, mask, open) {
  const close = closing(mask, open);
  if (close === -1) return { entries: [], close: open };
  const body = code.slice(open + 1, close);
  const entries = [];
  for (const m of body.matchAll(/(["'])([\w.*-]+)\1\s*=>\s*(\[[^\]]*\]|(["'])(?:\\.|(?!\4).)*\4)/g)) {
    const v = m[3].startsWith('[') ? [...m[3].matchAll(/(["'])((?:\\.|(?!\1).)*)\1/g)].map((x) => x[2]).join('|') : lit(m[3]);
    if (v !== null) entries.push({ key: m[2], value: v, offset: open + 1 + m.index });
  }
  return { entries, close };
}

function rulesIn(s, from, to, file, out) {
  const re = /(?:->validate\s*\(\s*(?:\$\w+\s*,\s*)?|Validator::make\s*\([^,]+,\s*|\$this->validate\s*\(\s*\$\w+\s*,\s*|\breturn\s+)\[/g;
  re.lastIndex = from;
  let m;
  while ((m = re.exec(s.mask)) && m.index < to) {
    const open = m.index + m[0].length - 1;
    const { entries, close } = arrayEntries(s.code, s.mask, open);
    const isMessages = entries.length && entries.every((e) => e.key.includes('.') && !/\|/.test(e.value) && /\s/.test(e.value));
    for (const e of entries) {
      if (out.rules.length >= MAX && out.messages.length >= MAX) break;
      if (isMessages) out.messages.push({ kind: 'validation', field: e.key, text: clean(e.value), cite: `${file}:${s.lineAt(e.offset)}` });
      else if (/^(required|nullable|sometimes|string|integer|numeric|email|max|min|in|date|boolean|array|file|image|mimes|unique|exists|regex|digits|size|between|confirmed|same|different|after|before|url|accepted|present)/.test(e.value) || /\|/.test(e.value)) out.rules.push({ field: e.key, rule: clean(e.value), cite: `${file}:${s.lineAt(e.offset)}` });
    }
    // Validator::make(..., rules, messages): the third argument
    const after = s.mask.slice(close + 1, close + 40);
    const m2 = /^\s*,\s*\[/.exec(after);
    if (m2 && /Validator::make/.test(m[0])) {
      const { entries: msgs } = arrayEntries(s.code, s.mask, close + 1 + m2[0].length - 1);
      for (const e of msgs) out.messages.push({ kind: 'validation', field: e.key, text: clean(e.value), cite: `${file}:${s.lineAt(e.offset)}` });
    }
    re.lastIndex = close;
  }
}

function messagesIn(s, from, to, file, lang, out) {
  const body = s.code.slice(from, to);
  const at = (i) => `${file}:${s.lineAt(from + i)}`;
  const tr = (t) => {
    const k = /^__\(\s*(["'])([^"']+)\1/.exec(t);
    return k ? lang.get(k[2]) || null : null;
  };
  const push = (o) => {
    if (out.messages.length < MAX && o.text) out.messages.push({ ...o, text: clean(o.text) });
  };
  for (const m of body.matchAll(/abort\(\s*(\d{3})\s*,\s*(["'])((?:\\.|(?!\2).)*)\2/g)) push({ kind: 'error', status: Number(m[1]), text: m[3], cite: at(m.index) });
  for (const m of body.matchAll(/->with\(\s*(["'])(error|success|message|warning|info|status|danger)\1\s*,\s*((["'])(?:\\.|(?!\4).)*\4|__\([^)]*\))/g)) push({ kind: m[2] === 'success' || m[2] === 'status' ? 'success' : m[2] === 'info' || m[2] === 'message' ? 'info' : 'error', text: lit(m[3]) || tr(m[3]), cite: at(m.index) });
  for (const m of body.matchAll(/withErrors\(\s*\[\s*(["'])[\w.]+\1\s*=>\s*(["'])((?:\\.|(?!\2).)*)\2/g)) push({ kind: 'error', text: m[3], cite: at(m.index) });
  for (const m of body.matchAll(/(["'])(message|msg|error|errors)\1\s*=>\s*((["'])(?:\\.|(?!\4).)*\4|__\([^)]*\))/g)) {
    const tail = body.slice(m.index, m.index + 600);
    const st = /\]\s*,\s*(\d{3})\s*\)/.exec(tail);
    push({ kind: st && Number(st[1]) >= 400 ? 'error' : 'info', status: st ? Number(st[1]) : null, text: lit(m[3]) || tr(m[3]), cite: at(m.index) });
  }
}

export function laravelBehaviour({ files, src, handlers, lang }) {
  const byHandler = new Map();
  const requests = new Map();
  for (const f of files.filter((x) => /\/Requests\/.*\.php$/.test(x))) requests.set(f.split('/').pop().replace(/\.php$/, ''), f);
  for (const h of handlers) {
    const s = src(h.file);
    if (!s) continue;
    const methods = phpMethods(s);
    for (const mt of methods) {
      const out = { rules: [], messages: [] };
      rulesIn(s, mt.bodyStart, mt.bodyEnd, h.file, out);
      messagesIn(s, mt.bodyStart, mt.bodyEnd, h.file, lang, out);
      // FormRequest type-hinted in the parameters
      for (const pm of mt.params.matchAll(/\b(\w+Request)\s+\$\w+/g)) {
        if (pm[1] === 'Request' || !requests.has(pm[1])) continue;
        const rf = requests.get(pm[1]);
        const rs = src(rf);
        if (!rs) continue;
        for (const rm of phpMethods(rs).filter((x) => x.name === 'rules' || x.name === 'messages')) rulesIn(rs, rm.bodyStart, rm.bodyEnd, rf, out);
      }
      if (out.rules.length || out.messages.length) byHandler.set(`${h.id}@${mt.name}`, out);
    }
  }
  return byHandler;
}

// ------------------------------------------------------------------ Blade labels

export function bladeLabels(text, lang) {
  if (!text) return [];
  let t = text.replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/\{\{--[\s\S]*?--\}\}/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  // Blade directives with balanced parentheses: @foreach(array_keys($a['x'][0]) as $k)
  const dropDirectives = (s) => {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const m = /^@[A-Za-z]+/.exec(s.slice(i, i + 40));
      if (!m) {
        out += s[i];
        continue;
      }
      i += m[0].length;
      if (s[i] === '(') {
        let d = 0;
        for (; i < s.length; i++) {
          if (s[i] === '(') d++;
          else if (s[i] === ')' && --d === 0) break;
        }
      } else i--;
      out += ' ';
    }
    return out;
  };
  const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", times: '×', rsaquo: '›', lsaquo: '‹', raquo: '»', laquo: '«', hellip: '…', ndash: '–', mdash: '—', copy: '©', rarr: '→', larr: '←' };
  const tr = (s) =>
    dropDirectives(
      s
        .replace(/\{\{\s*(?:__|trans|@lang)\(\s*(["'])([^"']+)\1[^}]*\}\}/g, (_, q, k) => lang.get(k) || '')
        .replace(/@lang\(\s*(["'])([^"']+)\1\s*\)/g, (_, q, k) => lang.get(k) || '')
        .replace(/\{!![\s\S]*?!!\}|\{\{[\s\S]*?\}\}/g, ' '),
    )
      .replace(/<[^>]+>/g, ' ')
      .replace(/&(#\d+|[a-z]+);/gi, (m, e) => (e[0] === '#' ? String.fromCharCode(Number(e.slice(1))) : ENT[e.toLowerCase()] ?? ' '))
      .replace(/\s+/g, ' ')
      .trim();
  const out = [];
  const add = (kind, raw) => {
    const v = tr(raw);
    // at least two letters, and no code left over
    if (!v || v.length < 2 || !/[A-Za-zऀ-ॿ]{2}/.test(v) || /^[\W\d_]+$/.test(v) || /[$]|\w\(|\)\s*as\s|=>|::/.test(v)) return;
    const val = clean(v).slice(0, 80);
    if (!out.some((x) => x.text === val)) out.push({ kind, text: val });
  };
  for (const m of t.matchAll(/<title[^>]*>([\s\S]*?)<\/title>/gi)) add('title', m[1]);
  for (const m of t.matchAll(/<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi)) add('heading', m[2]);
  for (const m of t.matchAll(/<label[^>]*>([\s\S]*?)<\/label>/gi)) add('label', m[1]);
  for (const m of t.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/gi)) add('button', m[1]);
  for (const m of t.matchAll(/<a\b[^>]*class=["'][^"']*\bbtn\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)) add('button', m[1]);
  for (const m of t.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)) add('column', m[1]);
  for (const m of t.matchAll(/placeholder\s*=\s*"([^"]*)"/gi)) add('field', m[1]);
  return out.slice(0, 25);
}

// ------------------------------------------------------------------ other stacks (messages only)

export function genericMessages({ files, src }) {
  const out = [];
  for (const f of files) {
    if (!/\.(m?js|ts|py)$/.test(f)) continue;
    const s = src(f);
    if (!s) continue;
    for (const m of s.code.matchAll(/res\.status\(\s*(\d{3})\s*\)\s*\.json\(\s*\{[^}]*?(?:message|error)\s*:\s*(["'`])((?:\\.|(?!\2).)*)\2/g)) out.push({ file: f, kind: Number(m[1]) >= 400 ? 'error' : 'info', status: Number(m[1]), text: clean(m[3]), cite: `${f}:${s.lineAt(m.index)}` });
    for (const m of s.code.matchAll(/HTTPException\(\s*status_code\s*=\s*(\d{3})\s*,\s*detail\s*=\s*(["'])((?:\\.|(?!\2).)*)\2/g)) out.push({ file: f, kind: 'error', status: Number(m[1]), text: clean(m[3]), cite: `${f}:${s.lineAt(m.index)}` });
  }
  return out.slice(0, 200);
}

export { J, uniq };
