// A small YAML reader/writer with no dependencies, for the files tech-plugin
// writes and people then edit (system.yaml). It handles block maps and lists,
// lists of maps, quoted and plain scalars, comments, "|" / ">" block text and
// short flow lists ([a, b]). Anchors, tags and multi-document files are not
// supported: parseYaml throws a YamlError naming the line, so the caller can
// ask the person to fix the file instead of guessing.

export class YamlError extends Error {}

// ------------------------------------------------------------------ writer

const RESERVED = /^(true|false|null|yes|no|on|off|~|-?\d+(\.\d+)?([eE][-+]?\d+)?|0x[0-9a-f]+|\.inf|\.nan)$/i;

function scalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  if (s === '' || RESERVED.test(s) || /^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(s) || /[:#]\s|:$|\s$|\n|\t/.test(s) || /[\u0000-\u001f]/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

function key(k) {
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(k) ? k : JSON.stringify(String(k));
}

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function emit(v, indent) {
  const pad = ' '.repeat(indent);
  const out = [];
  if (Array.isArray(v)) {
    for (const item of v) {
      if (isMap(item) && Object.keys(item).length) {
        const lines = emit(item, indent + 2);
        out.push(pad + '- ' + lines[0].slice(indent + 2), ...lines.slice(1));
      } else if (Array.isArray(item) && item.length) {
        out.push(pad + '-', ...emit(item, indent + 2));
      } else out.push(pad + '- ' + inline(item));
    }
    return out;
  }
  for (const [k, val] of Object.entries(v)) {
    if ((isMap(val) && Object.keys(val).length) || (Array.isArray(val) && val.length)) {
      out.push(`${pad}${key(k)}:`, ...emit(val, indent + 2));
    } else out.push(`${pad}${key(k)}: ${inline(val)}`);
  }
  return out;
}

function inline(v) {
  if (Array.isArray(v)) return '[]';
  if (isMap(v)) return '{}';
  return scalar(v);
}

// header: optional comment lines placed at the top.
export function toYaml(value, header = '') {
  const head = header ? header.split('\n').map((l) => (l ? `# ${l}` : '#')).join('\n') + '\n' : '';
  return head + emit(value, 0).join('\n') + '\n';
}

// ------------------------------------------------------------------ reader

function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '\\' && q === '"') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      if (i === 0 || /[\s:[,{-]/.test(s[i - 1])) q = c;
    } else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
  }
  return s.trimEnd();
}

function splitFlow(body, n) {
  const items = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (q) {
      cur += c;
      if (c === '\\' && q === '"') cur += body[++i] || '';
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      q = c;
      cur += c;
    } else if (c === '[' || c === '{') throw new YamlError(`line ${n}: nested flow collections are not supported`);
    else if (c === ',') {
      items.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  if (q) throw new YamlError(`line ${n}: unclosed quote`);
  if (cur.trim()) items.push(cur.trim());
  return items;
}

function parseScalar(raw, n) {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (s.startsWith('"')) {
    if (!s.endsWith('"') || s.length < 2) throw new YamlError(`line ${n}: unclosed double quote`);
    try {
      return JSON.parse(s);
    } catch {
      throw new YamlError(`line ${n}: bad double-quoted text`);
    }
  }
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) throw new YamlError(`line ${n}: unclosed single quote`);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) throw new YamlError(`line ${n}: unclosed [`);
    return splitFlow(s.slice(1, -1), n).map((x) => parseScalar(x, n));
  }
  if (s === '{}') return {};
  if (s.startsWith('{')) throw new YamlError(`line ${n}: flow maps {…} are not supported; use one "key: value" per line`);
  if (/^[&*!]/.test(s)) throw new YamlError(`line ${n}: anchors, aliases and tags are not supported`);
  if (/^(true|yes|on)$/i.test(s)) return true;
  if (/^(false|no|off)$/i.test(s)) return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

const KEY_RE = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#\-?:][^:#]*?|-[^\s:][^:#]*?)\s*:(?:\s+(.*)|$)/;

export function parseYaml(text) {
  const raw = String(text).replace(/\r\n?/g, '\n').split('\n');
  if (raw.some((l) => /^(---|\.\.\.)\s*$/.test(l)) && raw.filter((l) => /^---\s*$/.test(l)).length > 1) {
    throw new YamlError('multiple YAML documents are not supported');
  }
  const lines = []; // { n, indent, text } for meaningful lines
  for (let i = 0; i < raw.length; i++) {
    const l = raw[i];
    if (/^(---|\.\.\.)\s*$/.test(l)) continue;
    if (/\t/.test(l.match(/^\s*/)[0])) throw new YamlError(`line ${i + 1}: tabs are not allowed for indentation`);
    const t = l.trim();
    if (!t || t.startsWith('#')) {
      lines.push({ n: i + 1, indent: -1, text: '', raw: l });
      continue;
    }
    lines.push({ n: i + 1, indent: l.length - l.trimStart().length, text: l.trim(), raw: l });
  }
  let p = 0;
  const skip = () => {
    while (p < lines.length && lines[p].indent < 0) p++;
  };
  const peek = () => {
    skip();
    return lines[p];
  };
  const isSeq = (t) => t === '-' || t.startsWith('- ');

  function blockText(style, parentIndent) {
    const out = [];
    let ind = null;
    while (p < lines.length) {
      const l = lines[p];
      if (l.indent >= 0 && l.indent <= parentIndent) break;
      if (l.indent < 0) {
        out.push('');
        p++;
        continue;
      }
      if (ind === null) ind = l.indent;
      out.push(l.raw.slice(Math.min(ind, l.indent)));
      p++;
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    return style === '|' ? out.join('\n') + '\n' : out.join(' ').replace(/\s+\n/g, '\n') + '\n';
  }

  function value(rest, indent, n) {
    const r = stripComment(rest || '');
    if (r === '|' || r === '>' || /^[|>][-+]?$/.test(r)) {
      const v = blockText(r[0], indent);
      return r.endsWith('-') ? v.replace(/\n$/, '') : v;
    }
    if (r !== '') return parseScalar(r, n);
    const nx = peek();
    if (!nx) return null;
    if (nx.indent > indent) return block(nx.indent);
    if (nx.indent === indent && isSeq(nx.text)) return block(indent); // "key:\n- a" at the same indent
    return null;
  }

  function block(indent) {
    const first = peek();
    if (!first) return null;
    if (isSeq(first.text)) {
      const arr = [];
      while (peek() && peek().indent === indent && isSeq(peek().text)) {
        const l = peek();
        const rest = l.text === '-' ? '' : l.text.slice(2);
        const restTrim = stripComment(rest).trim();
        const childIndent = indent + 2 + (rest.length - rest.trimStart().length);
        if (restTrim === '') {
          p++;
          const nx = peek();
          arr.push(nx && nx.indent > indent ? block(nx.indent) : null);
        } else if (KEY_RE.test(restTrim) && !/^["'[]/.test(restTrim) || /^("|')[^]*\1\s*:/.test(restTrim)) {
          // "- key: value" starts a map: treat the rest as a line at the deeper indent
          lines[p] = { n: l.n, indent: childIndent, text: rest.trim(), raw: ' '.repeat(childIndent) + rest.trim() };
          arr.push(block(childIndent));
        } else {
          p++;
          arr.push(parseScalar(stripComment(rest), l.n));
        }
      }
      const after = peek();
      if (after && after.indent > indent) throw new YamlError(`line ${after.n}: unexpected indentation`);
      return arr;
    }
    const obj = {};
    while (peek() && peek().indent === indent) {
      const l = peek();
      if (isSeq(l.text)) throw new YamlError(`line ${l.n}: a list item where a "key: value" line was expected`);
      const m = KEY_RE.exec(stripComment(l.text));
      if (!m) throw new YamlError(`line ${l.n}: expected "key: value"`);
      const k = m[1].startsWith('"') ? JSON.parse(m[1]) : m[1].startsWith("'") ? m[1].slice(1, -1).replace(/''/g, "'") : m[1].trim();
      if (Object.hasOwn(obj, k)) throw new YamlError(`line ${l.n}: duplicate key "${k}"`);
      p++;
      obj[k] = value(m[2], indent, l.n);
    }
    const after = peek();
    if (after && after.indent > indent) throw new YamlError(`line ${after.n}: unexpected indentation`);
    return obj;
  }

  const f = peek();
  if (!f) return null;
  if (f.indent !== 0) throw new YamlError(`line ${f.n}: the file must start at column 1`);
  if (!isSeq(f.text) && !KEY_RE.test(stripComment(f.text))) {
    const v = parseScalar(stripComment(f.text), f.n);
    p++;
    if (peek()) throw new YamlError(`line ${peek().n}: unexpected content`);
    return v;
  }
  const v = block(0);
  if (peek()) throw new YamlError(`line ${peek().n}: unexpected content (check the indentation)`);
  return v;
}
