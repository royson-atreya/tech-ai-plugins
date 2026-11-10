// Tokenizer for sh / bash / zsh command lines (port of the atreya awk tokenizer).
//
// Produces:
//   { t:'word', v, m }      v = text after quote removal; m = per-character mask,
//                           'q' quoted (no glob/brace/tilde meaning) or 'u' unquoted.
//                           Variables appear as VO+NAME+VC; unknown expansions
//                           ($(...), $1, ${x:-y}, `...`) as VO+'?'+VC.
//   { t:'op', v }           ; && || | & ( ) and newline
//   { t:'redir', dir }      dir: 'w' (> >> >| >! &> &>>), 'r' (<), 'rw' (<>),
//                           'heredoc' (body, subs), 'herestring' (next word is data)
//   { t:'sub', body }       the text of $( ), ` `, <( ), >( ): run as commands
//
// Anything it cannot read with confidence (unbalanced quotes, a here-document
// without its end marker...) throws Block('parse'), which blocks the call.

import { Block, checkDeadline } from './core.mjs';

export const VO = '\u0001';
export const VC = '\u0002';
export const UNKNOWN = VO + '?' + VC;

function pfail(msg) {
  throw new Block('parse', `${msg}; the guard cannot check this command`);
}

const ANSI = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };

export function tokenize(src) {
  if (src.length > 100000) pfail('the command is too long');
  return scanner(src).all();
}

// Command substitutions inside an unquoted here-document body.
export function heredocSubs(text) {
  return scanner(text).subsInText();
}

function scanner(src) {
  const n = src.length;
  const toks = [];
  const pending = [];
  let w = null;

  const start = () => {
    if (!w) w = { v: '', m: '' };
  };
  const put = (s, q) => {
    start();
    w.v += s;
    w.m += (q ? 'q' : 'u').repeat(s.length);
  };
  const flush = () => {
    if (w) toks.push({ t: 'word', v: w.v, m: w.m });
    w = null;
  };
  // "2>" : a bare number right before a redirect is a file descriptor, not a word.
  const flushFd = () => {
    if (w && /^[0-9]+$/.test(w.v) && !w.m.includes('q')) w = null;
    else flush();
  };
  const op = (v) => {
    flush();
    toks.push({ t: 'op', v });
  };
  const redir = (dir) => {
    flush();
    toks.push({ t: 'redir', dir });
  };
  const sub = (body) => toks.push({ t: 'sub', body });

  function closeBacktick(j) {
    while (j < n) {
      if (src[j] === '\\') {
        j += 2;
        continue;
      }
      if (src[j] === '`') return j;
      j++;
    }
    return pfail('unbalanced backtick');
  }
  function closeDq(j) {
    while (j < n) {
      const c = src[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '"') return j;
      if (c === '$' && src[j + 1] === '(') {
        j = closeParen(j + 2) + 1;
        continue;
      }
      if (c === '`') {
        j = closeBacktick(j + 1) + 1;
        continue;
      }
      j++;
    }
    return pfail('unbalanced double quote');
  }
  // index of the ")" that closes a "(" whose body starts at j
  function closeParen(j) {
    let depth = 1;
    while (j < n) {
      checkDeadline();
      const c = src[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === "'") {
        const k = src.indexOf("'", j + 1);
        if (k < 0) pfail('unbalanced quote');
        j = k + 1;
        continue;
      }
      if (c === '"') {
        j = closeDq(j + 1) + 1;
        continue;
      }
      if (c === '`') {
        j = closeBacktick(j + 1) + 1;
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) return j;
      }
      j++;
    }
    return pfail('unbalanced $( ) or ( )');
  }
  function closeBrace(j) {
    let depth = 1;
    while (j < n) {
      const c = src[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return j;
      }
      j++;
    }
    return pfail('unbalanced ${ }');
  }
  const unBacktick = (b) => b.replace(/\\([\\`$])/g, '$1');

  // src[i] === '$'. q = inside double quotes. Returns the next index.
  function dollar(i, q) {
    const c = src[i + 1];
    if (c === '(') {
      if (src[i + 2] === '(') {
        // $(( arithmetic )): no commands allowed inside
        const end = closeParen(i + 2);
        const body = src.slice(i + 2, end);
        if (body.includes('$(') || body.includes('`')) pfail('command inside $(( ))');
        put(UNKNOWN, q);
        return end + 1;
      }
      const end = closeParen(i + 2);
      sub(src.slice(i + 2, end));
      put(UNKNOWN, q);
      return end + 1;
    }
    if (c === '{') {
      const end = closeBrace(i + 2);
      const inner = src.slice(i + 2, end);
      if (inner.includes('$(') || inner.includes('`')) pfail('command inside ${ }');
      put(/^[A-Za-z_][A-Za-z0-9_]*$/.test(inner) ? VO + inner + VC : UNKNOWN, q);
      return end + 1;
    }
    if (c !== undefined && /[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      put(VO + src.slice(i + 1, j) + VC, q);
      return j;
    }
    if (c !== undefined && /[0-9@*#?$!-]/.test(c)) {
      put(UNKNOWN, q);
      return i + 2;
    }
    if (c === "'" && !q) {
      // $'...' ANSI-C quoting: decode escapes so "\x2eenv" is seen as ".env"
      let j = i + 2;
      let v = '';
      while (j < n && src[j] !== "'") {
        if (src[j] === '\\' && j + 1 < n) {
          const e = src[j + 1];
          let m;
          if (e === 'x' && (m = /^[0-9a-fA-F]{1,2}/.exec(src.slice(j + 2)))) {
            v += String.fromCharCode(parseInt(m[0], 16));
            j += 2 + m[0].length;
            continue;
          }
          if ((e === 'u' || e === 'U') && (m = /^[0-9a-fA-F]{1,8}/.exec(src.slice(j + 2)))) {
            try {
              v += String.fromCodePoint(parseInt(m[0], 16));
            } catch {
              pfail('bad \\u escape');
            }
            j += 2 + m[0].length;
            continue;
          }
          if ((m = /^[0-7]{1,3}/.exec(src.slice(j + 1)))) {
            v += String.fromCharCode(parseInt(m[0], 8));
            j += 1 + m[0].length;
            continue;
          }
          if (e === 'c') pfail('\\c escape');
          v += e in ANSI ? ANSI[e] : '\\' + e;
          j += 2;
          continue;
        }
        v += src[j];
        j++;
      }
      if (j >= n) pfail('unbalanced quote');
      put(v, true);
      return j + 1;
    }
    if (c === '"' && !q) return i + 1; // $"..." (locale string) reads like "..."
    put('$', q);
    return i + 1;
  }

  // Double-quoted text from j up to (not including) the closing quote, or to the
  // end of the text when inHeredoc. Returns the index of the closing quote.
  function dq(j, inHeredoc) {
    start();
    for (;;) {
      checkDeadline();
      if (j >= n) {
        if (inHeredoc) return j;
        pfail('unbalanced double quote');
      }
      const d = src[j];
      if (d === '"' && !inHeredoc) return j;
      if (d === '\\') {
        const e = src[j + 1];
        if (e === '\n') {
          j += 2;
          continue;
        }
        if (e !== undefined && '$`"\\'.includes(e) && !(inHeredoc && e === '"')) {
          put(e, true);
          j += 2;
          continue;
        }
        put('\\', true);
        j++;
        continue;
      }
      if (d === '$') {
        j = dollar(j, true);
        continue;
      }
      if (d === '`') {
        const k = closeBacktick(j + 1);
        sub(unBacktick(src.slice(j + 1, k)));
        put(UNKNOWN, true);
        j = k + 1;
        continue;
      }
      put(d, true);
      j++;
    }
  }

  function readHeredocs(i) {
    while (pending.length) {
      const h = pending.shift();
      const lines = [];
      let found = false;
      while (i < n) {
        const e = src.indexOf('\n', i);
        let line = e < 0 ? src.slice(i) : src.slice(i, e);
        i = e < 0 ? n : e + 1;
        line = line.replace(/\r$/, '');
        const t = h.strip ? line.replace(/^\t+/, '') : line;
        if (t === h.d) {
          found = true;
          break;
        }
        lines.push(t);
      }
      if (!found) pfail('here-document without its end marker');
      h.r.body = lines.join('\n');
      h.r.subs = h.quoted ? [] : heredocSubs(h.r.body);
    }
    return i;
  }

  function all() {
    let i = 0;
    while (i < n) {
      checkDeadline();
      const c = src[i];
      const nx = src[i + 1];
      if (c === '\\') {
        if (nx === '\n') {
          i += 2;
          continue;
        }
        if (i + 1 >= n) {
          put('\\', true);
          i++;
          continue;
        }
        put(nx, true);
        i += 2;
        continue;
      }
      if (c === "'") {
        const k = src.indexOf("'", i + 1);
        if (k < 0) pfail('unbalanced quote');
        put(src.slice(i + 1, k), true);
        i = k + 1;
        continue;
      }
      if (c === '"') {
        i = dq(i + 1, false) + 1;
        continue;
      }
      if (c === '$') {
        i = dollar(i, false);
        continue;
      }
      if (c === '`') {
        const k = closeBacktick(i + 1);
        sub(unBacktick(src.slice(i + 1, k)));
        put(UNKNOWN, false);
        i = k + 1;
        continue;
      }
      if (c === ' ' || c === '\t' || c === '\r') {
        flush();
        i++;
        continue;
      }
      if (c === '\n') {
        op('\n');
        i = readHeredocs(i + 1);
        continue;
      }
      if (c === '#' && !w) {
        while (i < n && src[i] !== '\n') i++;
        continue;
      }
      if (c === ';') {
        op(';');
        i++;
        if (src[i] === ';') i++;
        if (src[i] === '&') i++;
        continue;
      }
      if (c === '&') {
        if (nx === '&') {
          op('&&');
          i += 2;
          continue;
        }
        if (nx === '>') {
          i += 2;
          if (src[i] === '>') i++;
          redir('w');
          continue;
        }
        op('&');
        i += nx === '|' || nx === '!' ? 2 : 1;
        continue;
      }
      if (c === '|') {
        if (nx === '|') {
          op('||');
          i += 2;
          continue;
        }
        op('|');
        i += nx === '&' ? 2 : 1;
        continue;
      }
      if (c === '(' || c === ')') {
        op(c);
        i++;
        continue;
      }
      if (c === '<') {
        if (nx === '(') {
          flush();
          const end = closeParen(i + 2);
          sub(src.slice(i + 2, end));
          put(UNKNOWN, false);
          i = end + 1;
          continue;
        }
        flushFd();
        if (nx === '<') {
          if (src[i + 2] === '<') {
            toks.push({ t: 'redir', dir: 'herestring' });
            i += 3;
            continue;
          }
          let j = i + 2;
          let strip = false;
          if (src[j] === '-') {
            strip = true;
            j++;
          }
          while (src[j] === ' ' || src[j] === '\t') j++;
          let d = '';
          let quoted = false;
          while (j < n && !/[\s;|&<>()]/.test(src[j])) {
            const ch = src[j];
            if (ch === "'" || ch === '"') {
              quoted = true;
              j++;
              continue;
            }
            if (ch === '\\') {
              quoted = true;
              j++;
              if (j < n) d += src[j];
              j++;
              continue;
            }
            d += ch;
            j++;
          }
          if (!d) pfail('here-document without a delimiter');
          const r = { t: 'redir', dir: 'heredoc', body: null, subs: [] };
          toks.push(r);
          pending.push({ r, d, strip, quoted });
          i = j;
          continue;
        }
        if (nx === '&') {
          i += 2;
          while (i < n && /[0-9-]/.test(src[i])) i++;
          continue;
        }
        if (nx === '>') {
          i += 2;
          redir('rw');
          continue;
        }
        i++;
        redir('r');
        continue;
      }
      if (c === '>') {
        if (nx === '(') {
          flush();
          const end = closeParen(i + 2);
          sub(src.slice(i + 2, end));
          put(UNKNOWN, false);
          i = end + 1;
          continue;
        }
        flushFd();
        let j = i + 1;
        if (src[j] === '>' || src[j] === '|' || src[j] === '!') j++;
        if (src[j] === '&') {
          if (/[0-9-]/.test(src[j + 1] || '')) {
            j++;
            while (j < n && /[0-9-]/.test(src[j])) j++;
            i = j;
            continue;
          }
          j++;
        }
        i = j;
        redir('w');
        continue;
      }
      put(c, false);
      i++;
    }
    flush();
    if (pending.length) pfail('here-document without its end marker');
    return toks;
  }

  function subsInText() {
    dq(0, true);
    return toks.filter((t) => t.t === 'sub').map((t) => t.body);
  }

  return { all, subsInText };
}
