// Bash command analysis for the guard.
//
// The command is tokenized (shell.mjs), split into simple commands
// ("segments") at ; && || | & ( ) and newlines, and each segment is checked
// with the folder it would run in. $( ), backticks, <( ), bash -c strings,
// here-documents fed to a shell, and shell scripts are checked the same way.
//
// Each segment is put in one group:
//   cd/pushd/popd     changes the folder later segments run in
//   git               rule c: read-only allow-list
//   package managers  rule d: installs blocked inside repos; read-only subcommands pass
//   safe-commands     php artisan & co: only the configured subcommands
//   search / find     rule a: recursive content reads must not reach secret files
//   write verbs       rm, mv, cp, tee, sed -i, curl -o...: every target goes through checkWrite
//   read-only verbs   ls, cat, wc...: secret checks only
//   everything else   "unknown": it could write anywhere, so inside a repo it
//                     needs an approved work item on a feature branch
// Anything the guard cannot read with confidence blocks.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Block, checkDeadline, timeLeft } from './core.mjs';
import { tokenize, VO, VC } from './shell.mjs';
import {
  disp, exists, findRepo, fold, isDir, resolvePath, under, IS_WIN,
} from './paths.mjs';
import {
  baseName, checkWrite, gate, hostHit, isSecretName, isSecretPath, secretsUnder,
} from './rules.mjs';

const pfail = (msg) => {
  throw new Block('parse', `${msg}; the guard cannot check this command`);
};

// Variables whose change can make a later, harmless-looking command run
// something else (PATH lookups, startup files, preloads, git helpers).
const TAINT_VARS = /^(PATH|BASH_ENV|ENV|ZDOTDIR|CDPATH|IFS|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_[A-Z_]*|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|PERL5OPT|PERL5LIB|PERLLIB|RUBYOPT|RUBYLIB|GIT_[A-Z_]*|PAGER|EDITOR|VISUAL|PROMPT_COMMAND|SHELLOPTS|BASHOPTS|FPATH)$/;
const GIT_ENV = /^(GIT_[A-Z_]*|PAGER|EDITOR|VISUAL|LESS[A-Z_]*)$/;

const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', '{', '}', 'esac', 'noglob', 'nocorrect', '-', 'builtin']);

const NAME_ONLY = new Set(('ls dir tree pwd echo printf true false test [ [[ ]] : sleep date cal whoami id groups uname hostname '
  + 'uptime which type whereis printenv locale tput stty clear basename dirname realpath readlink pathchk stat file du df '
  + 'seq expr bc dc factor ps pgrep pkill kill killall lsof w who last jobs wait disown shift return exit break continue '
  + 'let getopts logger say pbpaste pbcopy tty nproc sw_vers arch set unset tr').split(' '));

const CONTENT_READERS = new Set(('cat head tail less more nl tac rev strings xxd od hexdump base64 base32 sum cksum md5 '
  + 'md5sum shasum sha1sum sha224sum sha256sum sha384sum sha512sum b2sum wc cut paste join fold fmt column expand '
  + 'unexpand comm cmp diff sdiff colordiff jq yq plutil').split(' '));

// value-taking flags of content readers, so "head -n $N file" is read right
const READER_VALUES = {
  head: 'nc', tail: 'nc', cut: 'dfcb', xxd: 'lscgo', od: 'AtNj', base64: 'iob', column: 'sct', fold: 'w', fmt: 'w',
  diff: 'UCIxX', jq: 'f', plutil: 'o', nl: 'bdfhilnsvw', paste: 'd', join: '12jote', comm: '', tr: '',
};

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'mksh', 'yash', 'csh', 'tcsh']);
const INTERPRETERS = new Set(['python', 'python3', 'python2', 'node', 'nodejs', 'ruby', 'perl', 'php', 'deno', 'osascript', 'rscript', 'lua', 'tclsh', 'pwsh', 'powershell', 'groovy', 'jshell']);
const SEARCH = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'ggrep']);
const AWKS = new Set(['awk', 'gawk', 'mawk', 'nawk']);
const NET = new Set(['ssh', 'nc', 'ncat', 'netcat', 'telnet', 'ping', 'dig', 'nslookup', 'host', 'traceroute', 'open', 'xdg-open', 'lynx', 'links', 'w3m', 'http', 'https', 'xh', 'httpie', 'aria2c', 'ftp', 'sftp']);
const TAINTING = new Set(['alias', 'unalias', 'shopt', 'setopt', 'unsetopt', 'hash', 'enable', 'bindkey', 'autoload', 'zmodload', 'emulate', 'functions']);

export function checkBash(cmd, ctx) {
  if (typeof cmd !== 'string' || !cmd.trim()) throw new Block('parse', 'Bash call without a command');
  ctx.nested = 0;
  ctx.allWords = [];
  ctx.dirStack = [];
  rawSecretScan(cmd, ctx);
  analyze(cmd, ctx, [ctx.cwd], 0);
  const h = hostHit(cmd + ' ' + ctx.allWords.join(' '), ctx);
  if (h && ctx.netish) throw new Block('prod-hosts', `this command can reach production host ${h}; use staging`);
}

// rule a: any word of the raw text (also inside quotes, KEY=path, REV:path,
// @file, URLs) that is a secret file name blocks. Crude on purpose.
function rawSecretScan(cmd, ctx) {
  for (const piece of cmd.split(/[\s;|&<>()`"'=:@,{}[\]\\$]+/)) {
    if (piece && isSecretName(piece, ctx)) {
      throw new Block('secrets', `the command names secret file '${baseName(piece)}'; secret files are never read, searched or changed (.env.example is fine)`);
    }
  }
}

function analyze(src, ctx, dirs, depth) {
  if (depth > 8) pfail('commands are nested too deeply');
  if (++ctx.nested > 80) pfail('too many nested commands');
  const units = buildUnits(tokenize(src));
  run(units, ctx, dirs, depth);
}

function buildUnits(toks) {
  const units = [];
  let seg = { words: [], redirs: [], subs: [] };
  let expect = null;
  const close = () => {
    units.push({ k: 'seg', seg });
    seg = { words: [], redirs: [], subs: [] };
  };
  for (const t of toks) {
    if (t.t === 'sub') {
      seg.subs.push(t.body);
      continue;
    }
    if (t.t === 'word') {
      if (expect) {
        seg.redirs.push({ ...expect, target: t });
        expect = null;
      } else seg.words.push(t);
      continue;
    }
    if (t.t === 'redir') {
      if (expect) pfail('redirect without a target');
      if (t.dir === 'heredoc') seg.redirs.push(t);
      else expect = t;
      continue;
    }
    if (expect) pfail('redirect without a target');
    close();
    units.push({ k: 'op', v: t.v });
  }
  if (expect) pfail('redirect without a target');
  close();
  return units;
}

function run(units, ctx, dirs, depth) {
  let cur = dirs;
  const stack = [];
  const opAt = (i) => (units[i] && units[i].k === 'op' ? units[i].v : null);
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (u.k === 'op') {
      if (u.v === '(') stack.push(cur);
      else if (u.v === ')') {
        if (!stack.length) pfail('unbalanced )');
        cur = stack.pop();
      }
      continue;
    }
    const seg = u.seg;
    if (!seg.words.length && !seg.redirs.length && !seg.subs.length) continue;
    // "name() { ...; }" defines a function: later calls could run anything.
    if (seg.words.length === 1 && !seg.redirs.length && opAt(i + 1) === '(' && opAt(i + 2) === ')') {
      ctx.taint = ctx.taint || 'a shell function is defined';
      i += 2;
      continue;
    }
    const prev = opAt(i - 1);
    const next = opAt(i + 1);
    // Parts of a pipeline or a background job run in a subshell: their cd does not stick.
    const piped = prev === '|' || next === '|' || next === '&';
    const res = analyzeSegment(seg, ctx, cur, depth, { piped, pipedIn: prev === '|' });
    if (res && res.cd && !piped) cur = res.cd;
  }
  if (stack.length) pfail('unbalanced (');
}

// ------------------------------------------------------------------ word expansion

function lookupVar(name, ctx, dir) {
  if (ctx.vars.has(name)) return ctx.vars.get(name);
  switch (name) {
    case 'HOME': return [ctx.home];
    case 'PWD': return [dir];
    case 'CLAUDE_PLUGIN_ROOT': return [ctx.pluginRoot];
    case 'CLAUDE_PROJECT_DIR': return [ctx.projectDir];
    case 'TMPDIR': return process.env.TMPDIR ? [process.env.TMPDIR] : null;
    case 'USER': case 'LOGNAME': return process.env[name] ? [process.env[name]] : null;
    default: return null;
  }
}

// One token -> list of { v, m, dyn, glob, disp }. Unknown expansions are left out
// of v (so "$X/.env" still shows ".env") and make the word dyn.
function expandWord(tok, ctx, dir, { braces = true } = {}) {
  let alts = [{ v: '', m: '', dyn: false, d: '' }];
  const { v, m } = tok;
  for (let i = 0; i < v.length;) {
    if (v[i] === VO) {
      const j = v.indexOf(VC, i);
      const name = v.slice(i + 1, j);
      const vals = name === '?' ? null : lookupVar(name, ctx, dir);
      if (!vals) {
        for (const a of alts) {
          a.dyn = true;
          a.d += name === '?' ? '$(…)' : '$' + name;
        }
      } else {
        const next = [];
        for (const a of alts) for (const val of vals) next.push({ v: a.v + val, m: a.m + 'q'.repeat(val.length), dyn: a.dyn, d: a.d + val });
        alts = next.slice(0, 64);
        if (next.length > 64) alts.forEach((a) => (a.dyn = true));
      }
      i = j + 1;
      continue;
    }
    for (const a of alts) {
      a.v += v[i];
      a.m += m[i];
      a.d += v[i];
    }
    i++;
  }
  const out = [];
  for (const a of alts) {
    if (a.v[0] === '~' && a.m[0] === 'u') {
      if (a.v.length === 1 || a.v[1] === '/') {
        a.v = ctx.home + a.v.slice(1);
        a.m = 'q'.repeat(ctx.home.length) + a.m.slice(1);
      } else if (/^~[A-Za-z_]/.test(a.v)) a.dyn = true; // ~user
    }
    const list = braces ? braceExpand(a.v, a.m, 0) : [{ v: a.v, m: a.m }];
    for (const b of list) {
      out.push({ v: b.v, m: b.m, dyn: a.dyn, glob: hasGlob(b.v, b.m), disp: list.length > 1 ? b.v : a.d });
      if (out.length > 256) {
        out.forEach((o) => (o.dyn = true));
        return out;
      }
    }
  }
  return out;
}

function hasGlob(v, m) {
  for (let i = 0; i < v.length; i++) if (m[i] === 'u' && (v[i] === '*' || v[i] === '?' || v[i] === '[')) return true;
  return false;
}

function braceExpand(v, m, depth) {
  if (depth > 8) return [{ v, m }];
  for (let s = 0; s < v.length; s++) {
    if (v[s] !== '{' || m[s] !== 'u') continue;
    let d = 0;
    let e = -1;
    const commas = [];
    for (let k = s; k < v.length; k++) {
      if (m[k] !== 'u') continue;
      if (v[k] === '{') d++;
      else if (v[k] === '}') {
        d--;
        if (d === 0) {
          e = k;
          break;
        }
      } else if (v[k] === ',' && d === 1) commas.push(k);
    }
    if (e < 0) return [{ v, m }];
    let parts;
    if (commas.length) {
      parts = [];
      let st = s + 1;
      for (const c of [...commas, e]) {
        parts.push([v.slice(st, c), m.slice(st, c)]);
        st = c + 1;
      }
    } else {
      const r = rangeExpand(v.slice(s + 1, e));
      if (!r) continue;
      parts = r.map((x) => [x, 'q'.repeat(x.length)]);
    }
    const out = [];
    for (const [pv, pm] of parts) {
      for (const x of braceExpand(v.slice(0, s) + pv + v.slice(e + 1), m.slice(0, s) + pm + m.slice(e + 1), depth + 1)) {
        out.push(x);
        if (out.length > 256) return out;
      }
    }
    return out;
  }
  return [{ v, m }];
}

function rangeExpand(inner) {
  let mm = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/.exec(inner);
  if (mm) {
    const a = +mm[1];
    const b = +mm[2];
    const st = Math.abs(+(mm[3] || 1)) || 1;
    const out = [];
    for (let x = a; a <= b ? x <= b : x >= b; x += a <= b ? st : -st) {
      out.push(String(x));
      if (out.length > 256) break;
    }
    return out;
  }
  mm = /^([A-Za-z])\.\.([A-Za-z])$/.exec(inner);
  if (mm) {
    const a = mm[1].charCodeAt(0);
    const b = mm[2].charCodeAt(0);
    const out = [];
    for (let x = a; a <= b ? x <= b : x >= b; x += a <= b ? 1 : -1) out.push(String.fromCharCode(x));
    return out;
  }
  return null;
}

// Files a glob word matches in `dir` (case-insensitive, to be safe). "**" recurses.
function expandGlob(w, dir) {
  const abs = w.v.startsWith('/') || /^[A-Za-z]:[\\/]/.test(w.v);
  const segs = [];
  let cur = { v: '', m: '' };
  for (let i = 0; i < w.v.length; i++) {
    if (w.v[i] === '/' || (IS_WIN && w.v[i] === '\\')) {
      segs.push(cur);
      cur = { v: '', m: '' };
    } else {
      cur.v += w.v[i];
      cur.m += w.m[i];
    }
  }
  segs.push(cur);
  let bases = [abs ? (IS_WIN ? w.v.slice(0, 3) : '/') : dir];
  if (abs) segs.shift();
  const t0 = Date.now();
  for (const s of segs) {
    if (!s.v) continue;
    const next = [];
    if (!hasGlob(s.v, s.m)) {
      for (const b of bases) next.push(path.join(b, s.v));
    } else if (s.v === '**' && s.m === 'uu') {
      for (const b of bases) walk(b, next, t0);
    } else {
      const re = segRegex(s);
      for (const b of bases) {
        let ents = [];
        try {
          ents = fs.readdirSync(b);
        } catch {
          /* missing */
        }
        for (const e of ents) if (re.test(e) && (e[0] !== '.' || s.v[0] === '.')) next.push(path.join(b, e));
      }
    }
    bases = next.slice(0, 5000);
    if (Date.now() - t0 > 700) throw new Block('secrets', `the pattern '${w.v}' matches too many files to check`);
  }
  return bases.filter((p) => exists(p));
}

function walk(b, out, t0) {
  const stack = [b];
  while (stack.length) {
    const d = stack.pop();
    out.push(d);
    if (out.length > 5000 || Date.now() - t0 > 700) throw new Block('secrets', 'a ** pattern matches too many files to check');
    let ents = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      /* ignore */
    }
    for (const e of ents) if (e.isDirectory() && e.name !== '.git') stack.push(path.join(d, e.name));
  }
}

function segRegex(s) {
  let re = '^';
  for (let i = 0; i < s.v.length; i++) {
    const c = s.v[i];
    const q = s.m[i] !== 'u';
    if (!q && c === '*') re += '.*';
    else if (!q && c === '?') re += '.';
    else if (!q && c === '[') {
      const j = s.v.indexOf(']', i + 2);
      if (j > i) {
        let cls = s.v.slice(i + 1, j).replace(/\\/g, '\\\\');
        if (cls[0] === '!' || cls[0] === '^') cls = '^' + cls.slice(1);
        re += `[${cls}]`;
        i = j;
      } else re += '\\[';
    } else re += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  return new RegExp(re + '$', 'i');
}

// ------------------------------------------------------------------ assignments

function parseAssign(tok, ctx, dir) {
  const mm = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=/.exec(tok.v);
  if (!mm || tok.m.slice(0, mm[0].length).includes('q')) return null;
  const val = { v: tok.v.slice(mm[0].length), m: tok.m.slice(mm[0].length) };
  const ex = expandWord(val, ctx, dir, { braces: false });
  const one = ex.length === 1 && !ex[0].dyn && !mm[2] ? ex[0].v : null;
  return { name: mm[1], value: one, raw: tok.v };
}

function setVar(ctx, a) {
  ctx.vars.set(a.name, a.value === null ? null : [a.value]);
  if (TAINT_VARS.test(a.name)) ctx.taint = ctx.taint || `${a.name} was changed`;
}

// ------------------------------------------------------------------ segments

function analyzeSegment(seg, ctx, dirs, depth, pipe) {
  checkDeadline();
  for (const body of seg.subs) analyze(body, ctx, dirs, depth + 1);
  for (const r of seg.redirs) if (r.dir === 'heredoc') for (const b of r.subs) analyze(b, ctx, dirs, depth + 1);

  let k = 0;
  const assigns = [];
  while (k < seg.words.length) {
    const a = parseAssign(seg.words[k], ctx, dirs[0]);
    if (!a) break;
    assigns.push(a);
    k++;
  }
  const words = [];
  for (let j = k; j < seg.words.length; j++) words.push(...expandWord(seg.words[j], ctx, dirs[0]));
  ctx.allWords.push(...words.map((w) => w.v), ...assigns.map((a) => a.raw));

  checkRedirs(seg.redirs, ctx, dirs);
  if (!words.length) {
    for (const a of assigns) setVar(ctx, a);
    return null;
  }
  const info = { seg, pipe, env: assigns, depth, taint: null };
  for (const a of assigns) if (TAINT_VARS.test(a.name)) info.taint = `${a.name} is set for this command`;
  return dispatch(words, ctx, dirs, info);
}

function checkRedirs(redirs, ctx, dirs) {
  for (const r of redirs) {
    if (r.dir === 'heredoc' || r.dir === 'herestring') continue;
    for (const w of expandWord(r.target, ctx, dirs[0])) {
      if (!w.dyn && /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/.test(w.v)) continue;
      if (r.dir === 'r') {
        if (w.dyn) throw new Block('secrets', `input redirect from '${w.disp}' is not a fixed path; cannot check it for secret files`);
        for (const d of dirs) {
          const p = resolvePath(w.v, d);
          if (isSecretName(w.v, ctx) || isSecretPath(p, ctx)) throw new Block('secrets', `input redirect from secret file ${disp(p)}`);
        }
        continue;
      }
      if (w.dyn || w.glob) throw new Block('repo-write', `redirect target '${w.disp}' is not a fixed path; cannot check it`);
      for (const d of dirs) checkWrite(resolvePath(w.v, d), ctx, { verb: 'redirect to' });
    }
  }
}

function stdinText(info) {
  for (const r of info.seg.redirs) {
    if (r.dir === 'heredoc') return r.body;
    if (r.dir === 'herestring') return r.target.v;
  }
  return null;
}

// rule a for arguments: names, symlinks to secrets, and globs that match secrets.
function argSecrets(words, ctx, dirs) {
  for (const w of words) {
    if (!w.v) continue;
    for (const piece of w.v.split(/[=:@,]/)) {
      if (piece && isSecretName(piece, ctx)) throw new Block('secrets', `the command names secret file '${baseName(piece)}'`);
    }
    if (w.dyn) continue;
    if (w.glob) {
      for (const d of dirs) {
        for (const p of expandGlob(w, d)) {
          if (isSecretPath(p, ctx) || isSecretSymlink(p, ctx)) throw new Block('secrets', `'${w.v}' matches secret file ${disp(p)}`);
        }
      }
      continue;
    }
    const cands = w.v.startsWith('-') ? (w.v.includes('=') ? [w.v.slice(w.v.indexOf('=') + 1)] : []) : [w.v];
    for (const c of cands) {
      if (!c || /^[a-z][a-z0-9+.-]*:\/\//i.test(c)) continue;
      for (const d of dirs) {
        const p = resolvePath(c, d);
        if (exists(p) && isSecretPath(p, ctx)) throw new Block('secrets', `'${c}' points to secret file ${disp(p)}`);
      }
    }
  }
}

function isSecretSymlink(p, ctx) {
  try {
    return fs.lstatSync(p).isSymbolicLink() && isSecretPath(fs.realpathSync(p), ctx);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ dispatch

function dispatch(words, ctx, dirs, info) {
  let i = 0;
  let viaXargs = false;
  let segDirs = dirs;
  for (;;) {
    if (i >= words.length) return null;
    const w = words[i];
    const name = w.dyn ? null : w.v;
    if (name !== null && KEYWORDS.has(name)) {
      i++;
      continue;
    }
    if (name === 'time') {
      i++;
      while (words[i] && words[i].v === '-p') i++;
      continue;
    }
    if (name === 'for' || name === 'select') return forLoop(words.slice(i + 1), ctx, segDirs);
    if (name === 'case' || name === 'in') return null;
    if (name === 'function') {
      ctx.taint = ctx.taint || 'a shell function is defined';
      return null;
    }
    if (name === 'sudo' || name === 'doas') {
      i = skipFlags(words, i + 1, ['-u', '-g', '-C', '-h', '-p', '-r', '-t', '-U', '-D', '-R', '-T', '--user', '--group', '--prompt', '--chdir']);
      continue;
    }
    if (name === 'exec') {
      i = skipFlags(words, i + 1, ['-a']);
      continue;
    }
    if (name === 'command') {
      if (words[i + 1] && /^-[vV]+$/.test(words[i + 1].v)) return null;
      i = skipFlags(words, i + 1, []);
      continue;
    }
    if (name === 'nohup' || name === 'unbuffer') {
      i++;
      continue;
    }
    if (name === 'nice' || name === 'renice') {
      i = skipFlags(words, i + 1, ['-n']);
      continue;
    }
    if (name === 'timeout' || name === 'gtimeout') {
      i = skipFlags(words, i + 1, ['-s', '-k', '--signal', '--kill-after']) + 1;
      continue;
    }
    if (name === 'stdbuf') {
      i = skipFlags(words, i + 1, ['-i', '-o', '-e']);
      continue;
    }
    if (name === 'caffeinate') {
      i = skipFlags(words, i + 1, ['-w', '-t']);
      continue;
    }
    if (name === 'ionice' || name === 'chrt' || name === 'taskset') {
      i = skipFlags(words, i + 1, ['-c', '-n', '-p']);
      while (words[i] && /^\d/.test(words[i].v)) i++;
      continue;
    }
    if (name === 'env') {
      i++;
      while (i < words.length) {
        const a = words[i].v;
        if (a === '-S' || a.startsWith('--split-string')) pfail('env -S runs a command string');
        if (a === '-C' || a === '--chdir') {
          const t = words[i + 1];
          if (!t || t.dyn) pfail('env -C without a fixed folder');
          segDirs = segDirs.map((d) => resolvePath(t.v, d));
          i += 2;
          continue;
        }
        if (a === '-u' || a === '--unset' || a === '-P') {
          if (a === '-P') info.taint = 'env -P changes where commands are found';
          i += 2;
          continue;
        }
        if (a === '-i' || a === '-0' || a === '--' || a === '-' || /^-[iv0]+$/.test(a) || a === '--ignore-environment') {
          i++;
          continue;
        }
        const mm = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(a);
        if (mm) {
          if (TAINT_VARS.test(mm[1])) info.taint = `${mm[1]} is set for this command`;
          info.env.push({ name: mm[1], value: null, raw: a });
          i++;
          continue;
        }
        break;
      }
      continue;
    }
    if (name === 'xargs') {
      viaXargs = true;
      i++;
      while (i < words.length) {
        const a = words[i].v;
        if (['-I', '-n', '-P', '-L', '-d', '-s', '-E', '-a', '-J', '-R', '-S', '--max-args', '--max-procs', '--delimiter', '--arg-file', '--replace'].includes(a)) i += 2;
        else if (a.startsWith('-')) i++;
        else break;
      }
      continue;
    }
    if (name === 'watch') {
      i = skipFlags(words, i + 1, ['-n', '-d', '--interval']);
      const rest = words.slice(i);
      if (rest.some((x) => x.dyn)) pfail('watch with a command that is not fixed');
      analyze(rest.map((x) => x.v).join(' '), ctx, segDirs, info.depth + 1);
      return null;
    }
    if (name === 'flock') {
      i = skipFlags(words, i + 1, ['-w', '-E']);
      if (words[i + 1] && (words[i + 1].v === '-c' || words[i + 1].v === '--command')) {
        const s = words[i + 2];
        if (!s || s.dyn) pfail('flock -c without a fixed command');
        analyze(s.v, ctx, segDirs, info.depth + 1);
        return null;
      }
      i++;
      continue;
    }
    break;
  }

  const cw = words[i];
  const args = words.slice(i + 1);
  argSecrets(words.slice(i), ctx, segDirs);
  if (cw.dyn) throw new Block('parse', `the command name '${cw.disp}' is not fixed; the guard cannot check it`);

  const taint = info.taint || ctx.taint;
  const isPathExec = /[\\/]/.test(cw.v);
  let lname = fold(isPathExec ? baseName(cw.v) : cw.v);
  if (IS_WIN) lname = lname.replace(/\.(exe|cmd|bat)$/, '');

  if (taint) {
    if (lname === 'git') throw new Block('git', `git cannot be trusted after ${taint}`);
    return unknownRun(ctx, segDirs, { cmd: cw.v, args, why: taint });
  }

  if (viaXargs) return xargsCheck(lname, cw, args, ctx, segDirs);

  if (isPathExec) {
    const p = resolvePath(cw.v, segDirs[0]);
    if (under(p, ctx.pluginRoot)) return null; // the plugin's own, tested scripts
    if (lname === 'artisan') return stackCheck('php artisan', args, ctx, segDirs);
    if (lname === 'manage.py') return stackCheck('python manage.py', args, ctx, segDirs);
    if (lname === 'rails' || lname === 'rake') return stackCheck(lname, args, ctx, segDirs);
    if (lname === 'gradlew') return pkgCheck('gradle', args, ctx, segDirs, info);
    if (lname === 'mvnw') return pkgCheck('mvn', args, ctx, segDirs, info);
    return unknownRun(ctx, segDirs, { cmd: cw.v, args, script: p });
  }

  const cfg = ctx.cfgFor(findRepo(segDirs[0]));
  if (cfg.safeCommands[lname]) return stackCheck(lname, args, ctx, segDirs);

  if (lname === 'cd' || lname === 'pushd' || lname === 'popd' || lname === 'chdir') return cdCheck(lname, args, ctx, segDirs);
  if (lname === 'eval') throw new Block('parse', 'eval cannot be checked; run the command directly');
  if (lname === 'source' || lname === '.') return sourceCheck(args, ctx, segDirs, info);
  if (lname === 'git') return gitCheck(args, ctx, segDirs, info);
  if (SHELLS.has(lname)) return shellCheck(lname, args, ctx, segDirs, info);
  if (INTERPRETERS.has(lname) || /^python3\.\d+$/.test(lname)) return interpCheck(lname, args, ctx, segDirs, info);
  if (Object.hasOwn(PKG, lname)) return pkgCheck(lname, args, ctx, segDirs, info);
  if (SEARCH.has(lname)) return searchCheck(lname, args, ctx, segDirs);
  if (lname === 'find' || lname === 'gfind') return findCheck(args, ctx, segDirs, info);
  if (lname === 'sed' || lname === 'gsed') return sedCheck(args, ctx, segDirs);
  if (AWKS.has(lname)) return awkCheck(args, ctx, segDirs);
  if (WRITE[lname]) return writeCheck(lname, args, ctx, segDirs);
  if (lname === 'export' || lname === 'declare' || lname === 'typeset' || lname === 'local' || lname === 'readonly') {
    for (const a of args) {
      const mm = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(a.v);
      if (mm) setVar(ctx, { name: mm[1], value: a.dyn ? null : mm[2], raw: a.v });
      else if (a.v === '-f' || a.v === '-F') ctx.taint = ctx.taint || 'shell functions were changed';
    }
    return null;
  }
  if (lname === 'read' || lname === 'mapfile' || lname === 'readarray' || lname === 'printf') {
    for (let j = 0; j < args.length; j++) {
      const a = args[j].v;
      if (lname === 'printf' && a === '-v' && args[j + 1]) ctx.vars.set(args[j + 1].v, null);
      if (lname !== 'printf' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(a)) ctx.vars.set(a, null);
    }
    return null;
  }
  if (lname === 'trap') {
    if (args[0] && !args[0].v.startsWith('-') && args[0].v) {
      if (args[0].dyn) pfail('trap with a command that is not fixed');
      analyze(args[0].v, ctx, segDirs, info.depth + 1);
    }
    return null;
  }
  if (TAINTING.has(lname)) {
    ctx.taint = ctx.taint || `${lname} changed how later commands run`;
    return null;
  }
  if (NAME_ONLY.has(lname)) return null;
  if (CONTENT_READERS.has(lname)) return readerCheck(lname, args, ctx, segDirs);
  if (NET.has(lname)) {
    ctx.netish = true;
    return null;
  }
  return unknownRun(ctx, segDirs, { cmd: cw.v, args });
}

function skipFlags(words, i, valued) {
  while (i < words.length && words[i].v.startsWith('-') && words[i].v !== '-') {
    if (words[i].v === '--') return i + 1;
    i += valued.includes(words[i].v) ? 2 : 1;
  }
  return i;
}

function nonFlags(args) {
  return args.filter((a) => !a.v.startsWith('-') || a.v === '-');
}

// ------------------------------------------------------------------ unknown commands

// Something whose effect the guard cannot see (a script, a build tool, inline
// code). It needs an open gate in every repo it could touch: the folder it runs
// in, the session's repo, repos named in its arguments or in its code text.
function unknownRun(ctx, dirs, { cmd, args = [], script = null, codeText = '', why = '' }) {
  ctx.netish = true;
  const repos = new Map();
  const add = (p, reason) => {
    const r = findRepo(p);
    if (r && !repos.has(r)) repos.set(r, reason);
  };
  for (const d of dirs) add(d, 'it would run inside the repo');
  add(ctx.cwd, 'this session works in the repo');
  add(ctx.projectDir, 'this session works in the repo');
  for (const w of args) {
    if (w.dyn) continue;
    const c = w.v.startsWith('-') ? (w.v.includes('=') ? w.v.slice(w.v.indexOf('=') + 1) : '') : w.v;
    if (!c || /^[a-z][a-z0-9+.-]*:\/\//i.test(c)) continue;
    for (const d of dirs) {
      const p = resolvePath(c, d);
      if (c.includes('/') || exists(p)) add(p, `it is given ${c}`);
    }
  }
  if (script) {
    add(script, 'the script lives in the repo');
    codeText += readSmall(script);
  }
  if (codeText) {
    const lits = codeText.match(/(?:~|\.\.?)?\/[A-Za-z0-9._@+\-/~]+/g) || [];
    for (const c of lits.slice(0, 200)) for (const d of dirs) add(resolvePath(c, d), `its code mentions ${c}`);
  }
  for (const [r, reason] of repos) {
    const g = gate(r, ctx);
    if (g) {
      throw new Block('repo-write', `the guard cannot tell what '${cmd}' changes${why ? ` (${why})` : ''}, and ${reason} (${path.basename(r)}): ${g}`);
    }
  }
  return null;
}

function readSmall(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > 256 * 1024) return '';
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

// ------------------------------------------------------------------ cd

function cdCheck(lname, args, ctx, dirs) {
  if (lname === 'popd') {
    if (!ctx.dirStack.length) pfail('popd without pushd');
    return { cd: ctx.dirStack.pop() };
  }
  const target = args.find((w) => !/^-[LPe@qs]$/.test(w.v));
  if (!target) {
    if (lname === 'pushd') pfail('pushd without a folder');
    return { cd: [ctx.home] };
  }
  if (target.dyn || target.glob || target.v === '-') {
    throw new Block('parse', `cd to '${target.disp}' cannot be checked (not a fixed folder)`);
  }
  const out = [];
  const cdpath = (process.env.CDPATH || '').split(':').filter((x) => x && path.isAbsolute(x));
  for (const d of dirs) {
    const p = resolvePath(target.v, d);
    // A cd that fails leaves the old folder: keep both when the target is missing.
    if (isDir(p)) out.push(p);
    else out.push(p, d);
    if (!/^[./~]/.test(target.v)) for (const c of cdpath) out.push(resolvePath(target.v, c));
  }
  if (lname === 'pushd') ctx.dirStack.push(dirs);
  return { cd: [...new Set(out)].slice(0, 8) };
}

function forLoop(rest, ctx, dirs) {
  const name = rest[0] && rest[0].v;
  if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
  if (!rest[1] || rest[1].v !== 'in') {
    ctx.vars.set(name, null);
    return null;
  }
  const vals = [];
  let known = true;
  for (const w of rest.slice(2)) {
    if (w.dyn) known = false;
    else if (w.glob) {
      const m = expandGlob(w, dirs[0]);
      if (m.length) vals.push(...m.map((p) => (path.isAbsolute(w.v) ? p : path.relative(dirs[0], p))));
      else vals.push(w.v);
    } else vals.push(w.v);
  }
  argSecrets(rest.slice(2), ctx, dirs);
  ctx.vars.set(name, known && vals.length && vals.length <= 64 ? vals : null);
  return null;
}

// ------------------------------------------------------------------ rule c: git

function gitCheck(args, ctx, dirs, info) {
  for (const a of info.env) {
    if (GIT_ENV.test(a.name)) throw new Block('git', `${a.name}=… can make git run other programs`);
  }
  let gd = dirs;
  let j = 0;
  while (j < args.length) {
    const a = args[j].v;
    if (a === '-C') {
      const t = args[j + 1];
      if (!t) throw new Block('git', 'git -C without a folder');
      if (t.dyn) throw new Block('git', 'git -C folder is not fixed');
      gd = gd.map((d) => resolvePath(t.v, d));
      j += 2;
      continue;
    }
    if (['--no-pager', '--no-optional-locks', '-P', '--paginate', '-p', '--literal-pathspecs', '--no-replace-objects', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs'].includes(a) || /^--(git-dir|work-tree|namespace)=/.test(a)) {
      j++;
      continue;
    }
    if (a === '--version' || a === '--help' || a === '-h') return null;
    if (a.startsWith('-c') || a.startsWith('--config-env') || a.startsWith('--exec-path')) {
      throw new Block('git', `git ${a} can make git run other programs`);
    }
    if (a.startsWith('-')) throw new Block('git', `unknown git option ${a}`);
    break;
  }
  const subW = args[j];
  if (!subW) return null;
  if (subW.dyn) throw new Block('git', 'the git subcommand is not fixed');
  const sub = subW.v;
  const R = args.slice(j + 1);
  if (sub === 'version' || sub === 'help') return null;
  for (const w of R) {
    const a = w.v;
    if (a === '--output' || a.startsWith('--output=')) throw new Block('git', '--output writes a file');
    if (['--ext-diff', '--no-index', '--textconv'].includes(a)) throw new Block('git', `${a} is not allowed (it runs other tools or reads outside git)`);
    if (sub === 'grep' && (/^-O/.test(a) || a.startsWith('--open-files-in-pager'))) throw new Block('git', 'git grep -O runs a pager command');
  }
  switch (sub) {
    case 'status':
    case 'rev-parse':
    case 'ls-files':
      return null;
    case 'remote':
      for (const w of R) if (w.v !== '-v' && w.v !== '--verbose') throw new Block('git', "only 'git remote' and 'git remote -v' are allowed");
      return null;
    case 'branch':
      return branchCheck(R);
    case 'log':
    case 'show':
    case 'diff':
    case 'grep':
    case 'blame':
      return gitContentCheck(sub, R, gd, ctx);
    default:
      throw new Block('git', `git ${sub} is not on the read-only list (status, diff, log, show, blame, branch listing, rev-parse, ls-files, grep, remote -v); a person runs git writes`);
  }
}

function branchCheck(R) {
  const listing = R.some((w) => /^(--list|-l|--contains|--no-contains|--merged|--no-merged|--points-at|--sort=|--format=)/.test(w.v));
  for (const w of R) {
    const a = w.v;
    if (/^(-a|-r|-v|-vv|--all|--remotes|--verbose|--show-current|--no-color|--color(=.*)?|--list|-l|-i|--ignore-case|--no-column|--column.*|--abbrev.*|--no-abbrev)$/.test(a)) continue;
    if (/^(--contains|--no-contains|--merged|--no-merged|--points-at|--sort=|--format=)/.test(a)) continue;
    if (a.startsWith('-')) {
      if (/^-[arvl]+$/.test(a)) continue;
      throw new Block('git', `git branch ${a} changes branches`);
    }
    if (!listing) throw new Block('git', "git branch <name> creates a branch; use 'git branch --list <pattern>' to list");
  }
  return null;
}

const PATCH_FLAG = /^(-p|-u|--patch|-U\d*|--unified.*|--patch-with-stat|--patch-with-raw|--cc|--full-diff|-W|--function-context|-L.*|-c|--combined-all-paths)$/;
const SUMMARY_FLAG = /^(--stat.*|--numstat|--shortstat|--name-only|--name-status|--summary|--dirstat.*|-s|--no-patch|--raw|--quiet|--compact-summary)$/;

// log/show/diff/grep/blame can print file contents; secrets may be committed.
function gitContentCheck(sub, R, gd, ctx) {
  let patch = false;
  let summary = false;
  let names = false;
  let dd = false;
  let revpath = 0;
  let other = 0;
  const ps = [];
  for (const w of R) {
    const a = w.v;
    if (w.dyn) throw new Block('secrets', `git ${sub} argument '${w.disp}' is not fixed; cannot check it for secret files`);
    if (dd) {
      ps.push(a);
      continue;
    }
    if (a === '--') dd = true;
    else if (SUMMARY_FLAG.test(a)) summary = true;
    else if (PATCH_FLAG.test(a) && !(sub === 'grep' && a === '-c')) patch = true;
    else if (sub === 'grep' && /^(-l|-L|-c|--count|--files-with-matches|--name-only|--files-without-match|-q|--quiet)$/.test(a)) names = true;
    else if (sub === 'grep' && /^-[a-zA-Z]+$/.test(a) && /[lLcq]/.test(a)) names = true;
    else if (a.startsWith('-')) continue;
    else if (a.includes(':')) {
      const f = a.slice(a.lastIndexOf(':') + 1);
      if (isSecretName(f, ctx)) throw new Block('secrets', `git ${sub} of secret file ${f}`);
      revpath++;
    } else other++;
  }
  if (sub === 'blame') return null; // file names were checked by the argument checks
  let content = true;
  if (sub === 'log' && !patch) content = false;
  if ((sub === 'show' || sub === 'diff') && summary && !patch) content = false;
  if (sub === 'grep' && names) content = false;
  if (!content) return null;
  if (sub === 'show' && revpath > 0 && other === 0 && !ps.length) return null;
  // Ask git which files the command would print (names only), then check them.
  const keep = R.map((w) => w.v).filter((a) => !PATCH_FLAG.test(a) && !SUMMARY_FLAG.test(a) && !/^--(pretty|format)/.test(a));
  const argv = sub === 'grep' ? ['grep', '-l', ...keep] : sub === 'diff' ? ['diff', '--name-only', ...keep] : [sub, '--name-only', '--pretty=format:', ...keep];
  for (const d of gd) {
    const res = spawnSync('git', ['-C', d, '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '--no-pager', ...argv], {
      encoding: 'utf8',
      timeout: Math.max(200, Math.min(1500, timeLeft() - 300)),
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_PAGER: 'cat', GIT_EXTERNAL_DIFF: '', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    });
    const ok = !res.error && (res.status === 0 || (sub === 'grep' && res.status === 1));
    if (!ok) throw new Block('secrets', `cannot check which files git ${sub} would print (add '-- <path>' to narrow it)`);
    for (const line of res.stdout.split('\n')) {
      const f = line.trim();
      if (f && isSecretName(f, ctx)) {
        throw new Block('secrets', `git ${sub} would print secret file ${f}; narrow it with '-- <path>' or exclude it with ':!${f}'`);
      }
    }
  }
  return null;
}

// ------------------------------------------------------------------ shells and scripts

function shellCheck(lname, args, ctx, dirs, info) {
  ctx.netish = true;
  let j = 0;
  while (j < args.length) {
    const a = args[j].v;
    if (a === '--') {
      j++;
      break;
    }
    if (!/^[-+]/.test(a) || a === '-' || a === '+') break;
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(a)) {
      const s = args[j + 1];
      if (!s) pfail(`${lname} -c without a command`);
      if (s.dyn) pfail(`${lname} -c with a command that is not fixed`);
      analyze(s.v, ctx, dirs, info.depth + 1);
      return null;
    }
    j += a === '-o' || a === '+o' ? 2 : 1;
  }
  const script = args[j];
  if (script && script.v !== '-') {
    if (script.dyn) pfail(`${lname} script path is not fixed`);
    return runScript(resolvePath(script.v, dirs[0]), ctx, dirs, info, lname);
  }
  const text = stdinText(info);
  if (text !== null) {
    analyze(text, ctx, dirs, info.depth + 1);
    return null;
  }
  if (info.pipe.pipedIn) pfail(`commands piped into ${lname}`);
  pfail(`an interactive ${lname}`);
  return null;
}

function sourceCheck(args, ctx, dirs, info) {
  const s = args[0];
  if (!s) pfail('source without a file');
  if (s.dyn) pfail('source of a file that is not fixed');
  return runScript(resolvePath(s.v, dirs[0]), ctx, dirs, info, 'source');
}

// A shell script is read and checked like typed commands.
function runScript(p, ctx, dirs, info, how) {
  if (under(p, ctx.pluginRoot)) return null;
  if (isSecretPath(p, ctx)) throw new Block('secrets', `${how} of secret file ${disp(p)}`);
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return unknownRun(ctx, dirs, { cmd: `${how} ${disp(p)}`, script: p });
  }
  if (!st.isFile() || st.size > 256 * 1024) return unknownRun(ctx, dirs, { cmd: `${how} ${disp(p)}`, script: p });
  analyze(fs.readFileSync(p, 'utf8'), ctx, dirs, info.depth + 1);
  return null;
}

const INTERP = {
  python: { inline: 'c', module: 'm', values: 'WXQ', longInline: [], version: ['--version', '-V', '-VV', '--help', '-h'] },
  node: { inline: 'ep', values: '', longInline: ['--eval', '--print'], require: ['-r', '--require', '--import', '--loader', '--experimental-loader'], longValues: ['--input-type', '--title', '--env-file'], version: ['--version', '-v', '--help', '-h'] },
  ruby: { inline: 'e', values: 'ICr', version: ['--version', '-v'] },
  perl: { inline: 'eE', values: 'IMmx', version: ['--version', '-v'] },
  php: { inline: 'rRBEF', values: 'cdtz', file: 'f', version: ['--version', '-v', '-i', '-m'] },
  deno: { inline: '', values: '', version: ['--version', '-V'] },
  osascript: { inline: 'e', values: 'l', version: [] },
  rscript: { inline: 'e', values: '', version: ['--version'] },
  lua: { inline: 'el', values: '', version: ['-v'] },
};

function interpCheck(lname, args, ctx, dirs, info) {
  ctx.netish = true;
  const key = /^python/.test(lname) ? 'python' : lname === 'nodejs' ? 'node' : lname;
  const spec = INTERP[key];
  if (!spec) {
    // pwsh, powershell, groovy...: the guard cannot read their code.
    return unknownRun(ctx, dirs, { cmd: lname, args, codeText: args.map((a) => a.v).join(' ') });
  }
  if (args.length && args.every((a) => spec.version.includes(a.v))) return null;
  if (key === 'deno') {
    const sub = args[0] && args[0].v;
    if (sub === 'eval') return unknownRun(ctx, dirs, { cmd: 'deno eval', codeText: args.slice(1).map((a) => a.v).join(' ') });
    if (['add', 'install', 'remove', 'uninstall'].includes(sub)) return pkgCheck('deno', args, ctx, dirs, info);
  }
  let inline = null;
  let module = null;
  let script = null;
  let inplace = false;
  let rest = [];
  const requires = [];
  for (let j = 0; j < args.length; j++) {
    const a = args[j].v;
    if (a === '--') {
      script = args[j + 1] || null;
      rest = args.slice(j + 2);
      break;
    }
    if (a.startsWith('--')) {
      const nm = a.split('=')[0];
      if ((spec.longInline || []).includes(nm)) {
        inline = a.includes('=') ? a.slice(a.indexOf('=') + 1) : (args[++j] || { v: '' }).v;
        rest = args.slice(j + 1);
        break;
      }
      if ((spec.require || []).includes(nm)) {
        requires.push(a.includes('=') ? a.slice(a.indexOf('=') + 1) : (args[++j] || { v: '' }).v);
        continue;
      }
      if ((spec.longValues || []).includes(nm) && !a.includes('=')) j++;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      if ((spec.require || []).includes(a)) {
        requires.push((args[++j] || { v: '' }).v);
        continue;
      }
      const cl = a.slice(1);
      let done = false;
      for (let c = 0; c < cl.length; c++) {
        const ch = cl[c];
        if (key === 'perl' && ch === 'i') {
          inplace = true;
          break; // -i[ext]
        }
        if (spec.inline.includes(ch)) {
          inline = c < cl.length - 1 ? cl.slice(c + 1) : (args[++j] || { v: '' }).v;
          if (key !== 'perl') {
            rest = args.slice(j + 1);
            done = true;
          }
          break;
        }
        if (spec.module && spec.module.includes(ch)) {
          module = c < cl.length - 1 ? cl.slice(c + 1) : (args[++j] || { v: '' }).v;
          rest = args.slice(j + 1);
          done = true;
          break;
        }
        if (spec.file && spec.file.includes(ch)) {
          script = args[++j] || null;
          rest = args.slice(j + 1);
          done = true;
          break;
        }
        if (spec.values.includes(ch)) {
          if (c === cl.length - 1) j++;
          break;
        }
      }
      if (done) break;
      continue;
    }
    if (key === 'perl' && inline !== null) {
      rest = args.slice(j);
      break;
    }
    script = args[j];
    rest = args.slice(j + 1);
    break;
  }
  if (module === 'pip' || module === 'pip3') return pkgCheck('pip', rest, ctx, dirs, info);
  if (module !== null) return unknownRun(ctx, dirs, { cmd: `${lname} -m ${module}`, args: rest });
  for (const r of requires) {
    const p = resolvePath(r, dirs[0]);
    if (!under(p, ctx.pluginRoot)) unknownRun(ctx, dirs, { cmd: `${lname} ${r}`, script: exists(p) ? p : null });
  }
  if (inplace) {
    for (const w of nonFlags(rest)) targetsWrite([w], ctx, dirs, { verb: 'perl -i' });
  }
  if (inline !== null) return unknownRun(ctx, dirs, { cmd: `${lname} (inline code)`, args: rest, codeText: inline });
  if (script) {
    if (script.dyn) pfail(`${lname} script path is not fixed`);
    const p = resolvePath(script.v, dirs[0]);
    if (key === 'php' && baseName(p) === 'artisan') return stackCheck('php artisan', rest, ctx, dirs);
    if (key === 'python' && baseName(p) === 'manage.py') return stackCheck('python manage.py', rest, ctx, dirs);
    if (under(p, ctx.pluginRoot) && !requires.length) return null; // the plugin's own, tested scripts
    return unknownRun(ctx, dirs, { cmd: `${lname} ${script.v}`, args: rest, script: p });
  }
  const text = stdinText(info);
  return unknownRun(ctx, dirs, { cmd: `${lname} (code from stdin)`, codeText: text || '' });
}

// ------------------------------------------------------------------ rule d: installs

const PKG = {
  npm: 'install i ci add update up upgrade uninstall remove rm r un unlink link ln dedupe ddp prune rebuild rb install-test it install-ci-test cit',
  yarn: '<none> install add remove upgrade up upgrade-interactive dedupe link unlink import',
  pnpm: 'install i add remove rm uninstall un update up upgrade prune link ln unlink import rebuild rb dedupe fetch',
  bun: 'install i add a remove rm update upgrade link unlink',
  composer: 'install i require r update u upgrade remove rm uninstall create-project reinstall bump dump-autoload dumpautoload',
  pip: 'install uninstall download wheel',
  pip3: 'install uninstall download wheel',
  poetry: 'add install update remove lock sync',
  pipenv: 'install uninstall update lock sync clean',
  uv: 'add remove sync lock venv',
  conda: 'install update remove uninstall create',
  mamba: 'install update remove uninstall create',
  pod: 'install update deintegrate',
  gem: 'install update uninstall',
  bundle: '<none> install update add remove lock',
  go: 'get install',
  cargo: 'add install remove rm update fetch generate-lockfile',
  flutter: '',
  dart: '',
  deno: 'add install remove uninstall',
  dotnet: 'restore',
  gradle: '',
  mvn: '',
};
const PKG_DIR_FLAGS = ['--prefix', '--dir', '--cwd', '--working-dir', '--project-directory', '--directory', '--target', '--manifest-path', '--project', '--root'];

function pkgCheck(pm, args, ctx, dirs, info) {
  let explicit = [];
  let sub = '';
  let sub2 = '';
  let global = false;
  for (let j = 0; j < args.length; j++) {
    const w = args[j];
    const a = w.v;
    const nm = a.split('=')[0];
    if (PKG_DIR_FLAGS.includes(nm) || (a === '-C' && ['pnpm', 'npm', 'poetry'].includes(pm)) || (a === '-d' && pm === 'composer') || (a === '-t' && pm.startsWith('pip'))) {
      const val = a.includes('=') ? a.slice(a.indexOf('=') + 1) : (args[++j] || { v: '' }).v;
      if (w.dyn || (args[j] && args[j].dyn)) pfail(`${pm} folder option is not fixed`);
      explicit = explicit.concat(dirs.map((d) => resolvePath(val, d)));
      continue;
    }
    if (/^(-g|--global|--user|--location=global)$/.test(a)) {
      global = true;
      continue;
    }
    if (a.startsWith('-')) {
      if (!sub && /^(--version|-v|-V|--help|-h)$/.test(a)) sub = a;
      continue;
    }
    if (!sub || sub.startsWith('-')) sub = a;
    else if (!sub2) sub2 = a;
  }
  if (pm === 'composer' && sub === 'global') global = true;
  const list = (PKG[pm] || '').split(' ');
  let install = list.includes(sub) || (sub === '' && list.includes('<none>'));
  if (pm === 'npm' && sub === 'audit' && sub2 === 'fix') install = true;
  if (pm === 'go' && sub === 'mod' && ['tidy', 'download', 'vendor', 'init', 'edit'].includes(sub2)) install = true;
  if (pm === 'go' && sub === 'work' && ['sync', 'use', 'init'].includes(sub2)) install = true;
  if (pm === 'uv' && sub === 'pip' && ['install', 'uninstall', 'sync'].includes(sub2)) install = true;
  if (pm === 'uv' && sub === 'tool' && sub2 === 'install') global = true;
  if ((pm === 'flutter' || pm === 'dart') && (sub === 'pub' || sub === 'packages') && ['get', 'upgrade', 'add', 'remove', 'downgrade'].includes(sub2)) install = true;
  if (pm === 'dotnet' && sub === 'add' && sub2 === 'package') install = true;
  if (install) {
    ctx.netish = true;
    if (global) return null; // a global tool install does not touch the repo
    for (const d of [...dirs, ...explicit]) {
      const r = findRepo(d);
      if (r) {
        throw new Block('installs', `${pm} ${sub || ''}${sub2 ? ' ' + sub2 : ''} inside repo ${path.basename(r)} is blocked (even with an approved work item); a person installs packages`);
      }
    }
    return null;
  }
  const ro = ctx.cfgFor(findRepo(dirs[0])).readOnlySubcommands[pm] || [];
  if (ro.includes(sub) && !explicit.length) return null;
  if (pm === 'flutter' || pm === 'dart') {
    if ((sub === 'pub' || sub === 'packages') && ['outdated', 'deps'].includes(sub2)) return null;
  }
  return unknownRun(ctx, dirs, { cmd: `${pm} ${sub}`.trim(), args });
}

// ------------------------------------------------------------------ safe-commands

function stackCheck(key, args, ctx, dirs) {
  const list = ctx.cfgFor(findRepo(dirs[0])).safeCommands[key];
  const subW = args.find((a) => !a.v.startsWith('-'));
  if (subW && subW.dyn) throw new Block('safe-commands', `${key} subcommand is not fixed`);
  const sub = subW ? subW.v : '';
  if (!list) return unknownRun(ctx, dirs, { cmd: key, args });
  if (!subW && args.every((a) => list.includes(a.v) || /^(-q|--quiet|--no-ansi|--ansi|-n|--no-interaction|-v+|--help|-h|--version|-V)$/.test(a.v))) {
    return null; // bare "php artisan" lists commands
  }
  if (!list.includes(sub)) {
    throw new Block('safe-commands', `${key} ${sub || args.map((a) => a.v).join(' ')} is not on the safe list (${list.join(', ') || 'none'})`);
  }
  return null;
}

// ------------------------------------------------------------------ rule a: searches and readers

const GREP_VALUES = 'efABCmdD';
const RG_VALUES = 'efgtTmABCjMErd';

function searchCheck(tool, args, ctx, dirs) {
  const isGrep = tool === 'grep' || tool === 'egrep' || tool === 'fgrep' || tool === 'ggrep';
  let rec = !isGrep;
  let names = false;
  let haspat = false;
  let follow = false;
  const ops = [];
  const vals = isGrep ? GREP_VALUES : tool === 'rg' ? RG_VALUES : '';
  for (let j = 0; j < args.length; j++) {
    const w = args[j];
    const a = w.v;
    if (a === '--') {
      ops.push(...args.slice(j + 1));
      break;
    }
    if (a === '--pre' || a.startsWith('--pre=') || a.startsWith('--pre-glob')) throw new Block('secrets', 'rg --pre runs a command on every file');
    if (/^(--recursive|--dereference-recursive|--directories=recurse)$/.test(a)) {
      rec = true;
      if (a === '--dereference-recursive') follow = true;
      continue;
    }
    if (a === '--follow') follow = true;
    if (/^(--files-with-matches|--files-without-match|--count|--count-matches|--quiet|--silent|--files)$/.test(a)) {
      names = true;
      continue;
    }
    if (/^--(regexp|file)=/.test(a)) {
      haspat = true;
      continue;
    }
    if (a === '--regexp' || a === '--file') {
      haspat = true;
      j++;
      continue;
    }
    if (a === '--directories' || a === '-d') {
      if (args[j + 1] && args[j + 1].v === 'recurse' && isGrep) rec = true;
      j++;
      continue;
    }
    if (/^--(include|exclude|exclude-dir|context|max-count|after-context|before-context|label|devices|binary-files|glob|iglob|type|type-not|threads|max-columns|encoding|type-add|type-clear|sort|sortr|max-depth|colors|path-separator|replace|max-filesize|ignore-file|engine)$/.test(a)) {
      j++;
      continue;
    }
    if (a.startsWith('--')) continue;
    if (a.startsWith('-') && a.length > 1) {
      const cl = a.slice(1);
      for (let k = 0; k < cl.length; k++) {
        const ch = cl[k];
        if (vals.includes(ch)) {
          if (ch === 'e' || ch === 'f') haspat = true;
          if (k === cl.length - 1) {
            if (ch === 'd' && isGrep && args[j + 1] && args[j + 1].v === 'recurse') rec = true;
            j++;
          }
          break;
        }
        if ((ch === 'r' || ch === 'R') && isGrep) rec = true;
        if (ch === 'R' && isGrep) follow = true;
        if (ch === 'L' && tool === 'rg') follow = true;
        if ('lLcq'.includes(ch) && !(ch === 'L' && tool === 'rg')) names = true;
      }
      continue;
    }
    ops.push(w);
  }
  const files = haspat ? ops : ops.slice(1);
  if (names) return null;
  for (const f of files) {
    if (f.dyn) throw new Block('secrets', `search path '${f.disp}' is not fixed; cannot check it for secret files`);
  }
  if (!rec) return null;
  const targets = files.length ? files.map((f) => f.v) : ['.'];
  for (const t of targets) {
    for (const d of dirs) {
      const p = resolvePath(t, d);
      if (!isDir(p)) continue;
      const s = secretsUnder(p, ctx, { follow, firstOnly: true });
      if (s.length) {
        throw new Block('secrets', `a recursive content search of ${disp(p)} would read secret file ${disp(s[0])}; use 'grep -rl' / 'rg -l' (names only), a narrower folder, or the Grep tool with a glob/type that leaves it out`);
      }
    }
  }
  return null;
}

function readerCheck(lname, args, ctx, dirs) {
  const vals = READER_VALUES[lname] || '';
  let skipFirst = lname === 'jq' || lname === 'tr';
  let recursive = false;
  const files = [];
  for (let j = 0; j < args.length; j++) {
    const w = args[j];
    const a = w.v;
    if (a === '--') {
      files.push(...args.slice(j + 1));
      break;
    }
    if (lname === 'jq' && /^--(arg|argjson|slurpfile|rawfile)$/.test(a)) {
      if (/file$/.test(a) && args[j + 2]) files.push(args[j + 2]);
      j += 2;
      continue;
    }
    if (lname === 'jq' && (a === '-f' || a === '--from-file')) skipFirst = false;
    if (lname === 'base64' && (a === '-o' || a === '--output')) {
      if (args[j + 1]) targetsWrite([args[j + 1]], ctx, dirs, { verb: 'base64 -o' });
      j++;
      continue;
    }
    if (/^(-r|-R|--recursive)$/.test(a) && (lname === 'diff' || lname === 'colordiff')) recursive = true;
    if (a.startsWith('-') && a.length > 1 && !a.startsWith('--')) {
      const last = a[a.length - 1];
      if (vals.includes(last) && a.length === 2) j++;
      continue;
    }
    if (a.startsWith('--')) continue;
    files.push(w);
  }
  const operands = skipFirst ? files.slice(1) : files;
  for (const f of operands) {
    if (f.dyn) throw new Block('secrets', `${lname} argument '${f.disp}' is not a fixed path; cannot check it for secret files`);
  }
  if (recursive) {
    for (const f of operands) for (const d of dirs) {
      const p = resolvePath(f.v, d);
      if (isDir(p)) {
        const s = secretsUnder(p, ctx, { firstOnly: true });
        if (s.length) throw new Block('secrets', `${lname} -r over ${disp(p)} would read secret file ${disp(s[0])}`);
      }
    }
  }
  return null;
}

function sedCheck(args, ctx, dirs) {
  let inplace = false;
  let hasExpr = false;
  const scripts = [];
  const ops = [];
  for (let j = 0; j < args.length; j++) {
    const a = args[j].v;
    if (a === '--') {
      ops.push(...args.slice(j + 1));
      break;
    }
    if (a === '-i' || a === '-I') {
      inplace = true;
      // BSD sed: "-i ''" or "-i .bak" takes a suffix argument
      const nx = args[j + 1];
      if (nx && (nx.v === '' || /^\.[A-Za-z0-9_~-]*$/.test(nx.v))) j++;
      continue;
    }
    if (/^--in-place(=.*)?$/.test(a) || /^-i\S+$/.test(a)) {
      inplace = true;
      continue;
    }
    if (a === '-e' || a === '--expression' || a === '-f' || a === '--file') {
      hasExpr = true;
      if (args[j + 1]) scripts.push(a === '-f' || a === '--file' ? readSmall(resolvePath(args[j + 1].v, dirs[0])) : args[j + 1].v);
      j++;
      continue;
    }
    if (/^--(expression|file)=/.test(a)) {
      hasExpr = true;
      scripts.push(a.slice(a.indexOf('=') + 1));
      continue;
    }
    if (a === '-l') {
      j++;
      continue;
    }
    if (/^-[a-zA-Z]+$/.test(a)) {
      if (a.includes('i')) inplace = true;
      if (/[ef]$/.test(a)) {
        hasExpr = true;
        if (args[j + 1]) scripts.push(args[j + 1].v);
        j++;
      }
      continue;
    }
    if (a.startsWith('--')) continue;
    ops.push(args[j]);
  }
  if (!hasExpr && ops.length) scripts.push(ops.shift().v);
  // sed's own w/W (write file) and e (execute) commands
  const script = scripts.join('\n');
  if (/(^|[;\n{}])\s*(\d+|\$|\/[^/]*\/)?\s*[wWe](\s|$)/.test(script) || /s(.)(?:(?!\1).|\\.)*\1(?:(?!\1).|\\.)*\1[gpiImM0-9]*[we]/.test(script)) {
    unknownRun(ctx, dirs, { cmd: 'sed (writes or runs commands)', args: ops, codeText: script });
  }
  if (inplace) return targetsWrite(ops, ctx, dirs, { verb: 'sed -i' });
  for (const f of ops) if (f.dyn) throw new Block('secrets', `sed argument '${f.disp}' is not a fixed path; cannot check it for secret files`);
  return null;
}

function awkCheck(args, ctx, dirs) {
  let prog = null;
  let progFile = null;
  let inplace = false;
  const ops = [];
  for (let j = 0; j < args.length; j++) {
    const a = args[j].v;
    if (a === '-F' || a === '-v' || a === '--assign' || a === '--field-separator') {
      j++;
      continue;
    }
    if (a === '-f' || a === '--file') {
      progFile = resolvePath((args[++j] || { v: '' }).v, dirs[0]);
      continue;
    }
    if (a === '-e' || a === '--source') {
      prog = (args[++j] || { v: '' }).v;
      continue;
    }
    if (a === '-i' || a === '--include') {
      if (args[j + 1] && args[j + 1].v === 'inplace') inplace = true;
      j++;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) continue;
    if (prog === null && progFile === null) prog = a;
    else ops.push(args[j]);
  }
  const code = prog || '';
  if (progFile || inplace || /system\s*\(|\|\s*getline|\|&|(?:print|printf)\b[^;{}]*[>|]|close\s*\(/.test(code)) {
    unknownRun(ctx, dirs, { cmd: 'awk (writes or runs commands)', args: ops, script: progFile, codeText: code });
  }
  if (inplace) return targetsWrite(ops.filter((o) => !/^[A-Za-z_]\w*=/.test(o.v)), ctx, dirs, { verb: 'awk -i inplace' });
  for (const f of ops) if (f.dyn) throw new Block('secrets', `awk argument '${f.disp}' is not a fixed path; cannot check it for secret files`);
  return null;
}

// ------------------------------------------------------------------ find and xargs

const NAME_ONLY_EXEC = new Set(['ls', 'stat', 'echo', 'basename', 'dirname', 'file', 'du', 'printf', 'realpath', 'readlink', 'test', '[']);

function findCheck(args, ctx, dirs, info) {
  let j = 0;
  const starts = [];
  while (j < args.length && !/^[-(!)]/.test(args[j].v)) starts.push(args[j++]);
  if (args.length && /^-[HLP]$/.test(args[0].v)) {
    // find -L path ...
    j = 0;
    while (j < args.length && /^-[HLP]$/.test(args[j].v)) j++;
    while (j < args.length && !/^[-(!)]/.test(args[j].v)) starts.push(args[j++]);
  }
  if (!starts.length) starts.push({ v: '.', dyn: false });
  const execs = [];
  let del = false;
  for (; j < args.length; j++) {
    const a = args[j].v;
    if (/^-(exec|execdir|ok|okdir)$/.test(a)) {
      const cmd = [];
      j++;
      while (j < args.length && args[j].v !== ';' && args[j].v !== '+') cmd.push(args[j++]);
      if (!cmd.length) pfail('find -exec without a command');
      execs.push(cmd);
    } else if (a === '-delete') del = true;
    else if (/^-(fprint|fprint0|fprintf|fls)$/.test(a)) {
      targetsWrite([args[j + 1]], ctx, dirs, { verb: `find ${a}` });
      j++;
    }
  }
  for (const s of starts) {
    if (s.dyn) {
      if (del || execs.length) pfail(`find start folder '${s.disp}' is not fixed`);
      continue;
    }
    for (const d of dirs) {
      const p = resolvePath(s.v, d);
      if (del) checkWrite(p, ctx, { destructive: true, verb: 'find -delete in' });
      for (const cmd of execs) {
        const c = cmd[0];
        if (c.dyn) pfail('find -exec command is not fixed');
        const ec = fold(baseName(c.v));
        if (NAME_ONLY_EXEC.has(ec)) continue;
        if (WRITE[ec]) {
          checkWrite(p, ctx, { destructive: true, verb: `find -exec ${ec} in` });
          continue;
        }
        if (isDir(p)) {
          const sec = secretsUnder(p, ctx, { firstOnly: true });
          if (sec.length) throw new Block('secrets', `find -exec ${ec} over ${disp(p)} would reach secret file ${disp(sec[0])}`);
        }
        if (!CONTENT_READERS.has(ec) && !SEARCH.has(ec)) {
          unknownRun(ctx, dirs, { cmd: `find -exec ${c.v}`, args: [s, ...cmd.slice(1)] });
        }
      }
    }
  }
  void info;
  return null;
}

function xargsCheck(lname, cw, args, ctx, dirs) {
  if (lname === 'git') throw new Block('git', 'git through xargs cannot be checked');
  if (NAME_ONLY_EXEC.has(lname) || lname === 'wc') return null;
  if (SEARCH.has(lname) && args.some((a) => /^(-[a-zA-Z]*[lLcq][a-zA-Z]*|--files-with-matches|--count|--files-without-match|--quiet)$/.test(a.v))) return null;
  if (CONTENT_READERS.has(lname) || SEARCH.has(lname) || AWKS.has(lname) || lname === 'sed') {
    throw new Block('secrets', `xargs ${lname} reads files named on stdin, which the guard cannot see; run it on explicit paths`);
  }
  if (WRITE[lname]) throw new Block('repo-write', `xargs ${lname} takes its targets from stdin, which the guard cannot check; name the files directly`);
  return unknownRun(ctx, dirs, { cmd: `xargs ${cw.v}`, args });
}

// ------------------------------------------------------------------ write verbs

// For each verb: short flags that take a value, long flags that take a value,
// and how to find the paths it writes (TG) and reads as sources (SRC).
const WRITE = {
  tee: { s: '', t: (o) => ({ tg: o.ops }) },
  rm: { s: '', t: (o) => ({ tg: o.ops }), destructive: true },
  rmdir: { s: '', t: (o) => ({ tg: o.ops }), destructive: true },
  unlink: { s: '', t: (o) => ({ tg: o.ops }), destructive: true },
  shred: { s: 'ns', t: (o) => ({ tg: o.ops }), destructive: true },
  trash: { s: '', t: (o) => ({ tg: o.ops }), destructive: true },
  srm: { s: '', t: (o) => ({ tg: o.ops }), destructive: true },
  touch: { s: 'tdrA', t: (o) => ({ tg: o.ops }) },
  mkdir: { s: 'm', t: (o) => ({ tg: o.ops }) },
  mktemp: { s: 'tp', l: ['--tmpdir', '--suffix'], t: (o) => ({ tg: [...o.ops.filter((x) => /[\\/]/.test(x.v)), ...o.vals('p')] }) },
  truncate: { s: 'sr', t: (o) => ({ tg: o.ops }), destructive: true },
  gzip: { s: 'S', t: (o) => ({ tg: o.ops }), destructive: true },
  gunzip: { s: 'S', t: (o) => ({ tg: o.ops }), destructive: true },
  bzip2: { s: '', t: (o) => ({ tg: o.ops }), destructive: true },
  bunzip2: { s: '', t: (o) => ({ tg: o.ops }), destructive: true },
  xz: { s: '', t: (o) => ({ tg: o.ops }), destructive: true },
  unxz: { s: '', t: (o) => ({ tg: o.ops }), destructive: true },
  zstd: { s: 'o', t: (o) => ({ tg: [...o.ops, ...o.vals('o')] }), destructive: true },
  chmod: { s: '', l: ['--reference'], t: (o) => ({ tg: o.has('--reference') ? o.ops : o.ops.slice(1) }), destructive: true },
  chown: { s: '', l: ['--reference'], t: (o) => ({ tg: o.has('--reference') ? o.ops : o.ops.slice(1) }), destructive: true },
  chgrp: { s: '', l: ['--reference'], t: (o) => ({ tg: o.has('--reference') ? o.ops : o.ops.slice(1) }), destructive: true },
  chflags: { s: '', t: (o) => ({ tg: o.ops.slice(1) }), destructive: true },
  xattr: { s: '', t: (o) => ({ tg: o.ops }) },
  mv: { s: 'tS', l: ['--target-directory', '--suffix'], t: (o) => ({ tg: [...o.ops, ...o.vals('t', '--target-directory')] }), destructive: true },
  cp: { s: 'tS', l: ['--target-directory', '--suffix'], t: copyTargets },
  install: { s: 'tSmogb', l: ['--target-directory', '--mode', '--owner', '--group', '--suffix'], t: (o) => (o.has('d') ? { tg: o.ops } : copyTargets(o)) },
  ditto: { s: '', t: copyTargets },
  ln: { s: 'tS', l: ['--target-directory', '--suffix'], t: lnTargets },
  // a hard link is a second name for the same file: writing it later changes the source
  link: { s: '', t: (o) => ({ tg: o.ops, src: o.ops.slice(0, 1) }) },
  rsync: { s: 'efTB', l: ['--rsh', '--filter', '--exclude', '--include', '--exclude-from', '--include-from', '--files-from', '--log-file', '--temp-dir', '--partial-dir', '--chmod', '--backup-dir', '--suffix', '--compare-dest', '--copy-dest', '--link-dest'], t: remoteCopy, destructive: (o) => o.longs.some((l) => /^--(delete|remove-source-files)/.test(l)) },
  scp: { s: 'iPoFclSJ', t: remoteCopy },
  dd: { s: '', t: (o) => ({ tg: o.ops.filter((x) => x.v.startsWith('of=')).map((x) => ({ ...x, v: x.v.slice(3) })) }) },
  curl: { s: 'odHXuAebcTKmwxFrCEDUYyzQtP', l: ['--output', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--header', '--request', '--user', '--user-agent', '--referer', '--cookie', '--cookie-jar', '--upload-file', '--config', '--max-time', '--write-out', '--proxy', '--form', '--connect-timeout', '--range', '--retry', '--cert', '--key', '--cacert', '--output-dir', '--dump-header', '--trace', '--trace-ascii', '--libcurl', '--stderr', '--url'], t: curlTargets, net: true },
  wget: { s: 'OPoaieUtTwQ', l: ['--output-document', '--directory-prefix', '--output-file', '--append-output', '--input-file', '--user-agent', '--header', '--tries', '--timeout', '--wait', '--quota', '--post-file', '--body-file'], t: wgetTargets, net: true },
  unzip: { s: 'dx', t: (o) => (o.has('l') || o.has('p') || o.has('t') || o.has('Z') ? {} : { tg: o.vals('d').length ? o.vals('d') : [o.here()], extract: true }), destructive: true },
  tar: { s: 'fCTXb', l: ['--file', '--directory', '--exclude', '--files-from', '--exclude-from'], t: tarTargets, destructive: true },
  bsdtar: { s: 'fCTXb', l: ['--file', '--directory', '--exclude', '--files-from', '--exclude-from'], t: tarTargets, destructive: true },
  // "patch file.php fix.diff" changes that file; without a file it may change any file named in the diff
  patch: { s: 'dioprBzDFV', l: ['--directory', '--input', '--output', '--strip', '--reject-file', '--prefix', '--suffix'], t: (o) => (o.ops.length ? { tg: [o.ops[0], ...o.vals('o', '--output')] } : { tg: [...(o.vals('d', '--directory').length ? o.vals('d', '--directory') : [o.here()]), ...o.vals('o', '--output')], extract: true }), destructive: (o) => !o.ops.length },
  zip: { s: 'xibntP', t: zipTargets },
  sort: { s: 'oktTS', l: ['--output', '--key', '--field-separator', '--temporary-directory', '--buffer-size'], t: (o) => ({ tg: o.vals('o', '--output'), read: o.ops }) },
  uniq: { s: 'fsw', t: (o) => ({ tg: o.ops.slice(1, 2), read: o.ops.slice(0, 1) }) },
  iconv: { s: 'fto', l: ['--from-code', '--to-code', '--output'], t: (o) => ({ tg: o.vals('o', '--output'), read: o.ops }) },
  sponge: { s: '', t: (o) => ({ tg: o.ops }) },
};

function copyTargets(o) {
  const dest = o.vals('t', '--target-directory');
  let r;
  if (dest.length) r = { tg: dest, src: o.ops };
  else if (o.ops.length >= 2) r = { tg: [o.ops[o.ops.length - 1]], src: o.ops.slice(0, -1) };
  else r = { tg: [], src: o.ops };
  // cp -l makes hard links: the sources become writable through the copies
  if (o.has('l') || o.has('--link')) r.tg = [...r.tg, ...r.src];
  return r;
}

function lnTargets(o) {
  const dest = o.vals('t', '--target-directory');
  let r;
  if (dest.length) r = { tg: dest, src: o.ops };
  else if (o.ops.length >= 2) r = { tg: [o.ops[o.ops.length - 1]], src: o.ops.slice(0, -1) };
  else if (o.ops.length === 1) r = { tg: [{ ...o.ops[0], v: baseName(o.ops[0].v) }], src: o.ops };
  else return {};
  // without -s, ln makes hard links: writing the link later changes the source
  if (!o.has('s') && !o.has('--symbolic')) r.tg = [...r.tg, ...r.src];
  return r;
}

const isRemote = (v) => /^[^/\\]*[^/\\:]:/.test(v) && !/^[A-Za-z]:[\\/]/.test(v);

function remoteCopy(o) {
  if (!o.ops.length) return {};
  const dest = o.ops[o.ops.length - 1];
  const src = o.ops.slice(0, -1).filter((x) => !isRemote(x.v));
  if (isRemote(dest.v)) return { src, upload: src };
  return { tg: [dest], src };
}

function curlTargets(o) {
  const tg = [...o.vals('o', '--output'), ...o.vals('c', '--cookie-jar'), ...o.vals('D', '--dump-header'), ...o.vals('--trace'), ...o.vals('--trace-ascii'), ...o.vals('--libcurl'), ...o.vals('--stderr')].filter((x) => x.v !== '-');
  if (o.has('O') || o.has('--remote-name') || o.has('--remote-name-all') || o.has('J') || o.has('--remote-header-name')) {
    tg.push(...(o.vals('--output-dir').length ? o.vals('--output-dir') : [o.here()]));
  }
  if (o.vals('K', '--config').length) return { tg, unknown: 'curl -K reads options from a file' };
  return { tg };
}

function wgetTargets(o) {
  const tg = [...o.vals('o', '--output-file'), ...o.vals('a', '--append-output')];
  const out = o.vals('O', '--output-document');
  if (out.length) tg.push(...out.filter((x) => x.v !== '-'));
  else if (!o.has('--spider')) tg.push(...(o.vals('P', '--directory-prefix').length ? o.vals('P', '--directory-prefix') : [o.here()]));
  return { tg };
}

function tarTargets(o) {
  let mode = '';
  for (const f of o.flags) {
    if (mode) break;
    if (f === 'x') mode = 'x';
    else if (f === 't') mode = 't';
    else if ('cru'.includes(f)) mode = 'c';
  }
  if (o.has('--extract') || o.has('--get')) mode = 'x';
  if (o.has('--create') || o.has('--append') || o.has('--update')) mode = 'c';
  if (o.has('--list')) mode = 't';
  let ops = o.ops;
  let archive = o.vals('f', '--file');
  if (!mode && ops.length && /^[A-Za-z]+$/.test(ops[0].v)) {
    // old style: "tar xzf file.tgz"
    const k = ops[0].v;
    mode = k.includes('x') ? 'x' : k.includes('t') ? 't' : /[cru]/.test(k) ? 'c' : '';
    if (k.includes('f') && ops[1]) {
      archive = [ops[1]];
      ops = ops.slice(2);
    } else ops = ops.slice(1);
  }
  if (mode === 'x') {
    if (o.has('O') || o.has('--to-stdout')) return {};
    return { tg: o.vals('C', '--directory').length ? o.vals('C', '--directory') : [o.here()], extract: true };
  }
  if (mode === 'c') return { tg: archive.filter((x) => x.v !== '-'), upload: ops };
  return {};
}

function zipTargets(o) {
  if (!o.ops.length) return {};
  return { tg: [o.ops[0]], upload: o.ops.slice(1) };
}

function parseOpts(verb, args, spec, dirs) {
  const shortVals = spec.s || '';
  const longVals = spec.l || [];
  const ops = [];
  const flags = [];
  const longs = [];
  const values = [];
  for (let j = 0; j < args.length; j++) {
    const w = args[j];
    const a = w.v;
    if (a === '--') {
      ops.push(...args.slice(j + 1));
      break;
    }
    if (verb === 'dd') {
      ops.push(w);
      continue;
    }
    if (a.startsWith('--') && a.length > 2) {
      const nm = a.split('=')[0];
      longs.push(nm);
      if (a.includes('=')) values.push([nm, { ...w, v: a.slice(a.indexOf('=') + 1) }]);
      else if (longVals.includes(nm)) {
        values.push([nm, args[j + 1] || { v: '', dyn: false }]);
        j++;
      }
      continue;
    }
    if (a.startsWith('-') && a.length > 1 && !(verb === 'chmod' && /^-[rwxXst]/.test(a))) {
      const cl = a.slice(1);
      for (let k = 0; k < cl.length; k++) {
        const ch = cl[k];
        flags.push(ch);
        if (shortVals.includes(ch)) {
          if (k < cl.length - 1) values.push([ch, { ...w, v: cl.slice(k + 1) }]);
          else {
            values.push([ch, args[j + 1] || { v: '', dyn: false }]);
            j++;
          }
          break;
        }
      }
      continue;
    }
    ops.push(w);
  }
  return {
    ops,
    flags,
    longs,
    has: (f) => (f.startsWith('--') ? longs.includes(f) : flags.includes(f)),
    vals: (...names) => values.filter(([n]) => names.includes(n)).map(([, v]) => v),
    here: () => ({ v: dirs[0], dyn: false, glob: false, disp: dirs[0] }),
  };
}

function writeCheck(verb, args, ctx, dirs) {
  const spec = WRITE[verb];
  const o = parseOpts(verb, args, spec, dirs);
  const r = spec.t(o);
  if (spec.net) ctx.netish = true;
  if (r.unknown) unknownRun(ctx, dirs, { cmd: verb, args, why: r.unknown });
  const destructive = typeof spec.destructive === 'function' ? spec.destructive(o) : !!spec.destructive;
  // A source that is, or holds, an APPROVED file would plant a fake approval.
  for (const s of r.src || []) {
    if (s.dyn) continue;
    for (const d of dirs) {
      const p = resolvePath(s.v, d);
      if (fold(baseName(p)) === 'approved') throw new Block('self-protection', `${verb} of an APPROVED file is not allowed`);
      if (isDir(p) && containsApproved(p)) throw new Block('self-protection', `${verb} ${disp(p)}: it contains an APPROVED file`);
    }
  }
  // Archives and uploads read whole folders: they must not take secret files along.
  for (const s of r.upload || []) {
    if (s.dyn) throw new Block('secrets', `${verb} source '${s.disp}' is not fixed; cannot check it for secret files`);
    for (const d of dirs) {
      const p = resolvePath(s.v, d);
      if (isDir(p)) {
        const sec = secretsUnder(p, ctx, { firstOnly: true });
        if (sec.length) throw new Block('secrets', `${verb} of ${disp(p)} would include secret file ${disp(sec[0])}`);
      }
    }
  }
  for (const s of r.read || []) {
    if (s.dyn) throw new Block('secrets', `${verb} argument '${s.disp}' is not a fixed path; cannot check it for secret files`);
  }
  targetsWrite(r.tg || [], ctx, dirs, { verb, destructive, extract: !!r.extract });
  return null;
}

function containsApproved(dir) {
  const t0 = Date.now();
  const stack = [dir];
  let n = 0;
  while (stack.length) {
    const d = stack.pop();
    let ents = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (++n > 100000 || Date.now() - t0 > 700) return true; // too big to check: treat as yes
      if (e.name.toLowerCase() === 'approved') return true;
      if (e.isDirectory()) stack.push(path.join(d, e.name));
    }
  }
  return false;
}

// Every target path of a write goes through checkWrite (rules a, b, g).
function targetsWrite(targets, ctx, dirs, { verb, destructive = false, extract = false }) {
  for (const t of targets) {
    if (!t) continue;
    if (t.dyn) throw new Block('repo-write', `${verb} target '${t.disp}' is not a fixed path; cannot check it`);
    if (t.v === '') continue;
    for (const d of dirs) {
      const list = t.glob ? expandGlob(t, d) : [];
      const paths = list.length ? list : [resolvePath(t.v, d)];
      for (const p of paths) checkWrite(p, ctx, { destructive, extract, verb });
    }
  }
  return null;
}
