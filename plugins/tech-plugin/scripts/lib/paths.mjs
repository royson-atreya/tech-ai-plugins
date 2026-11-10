// Path helpers: resolve symlinks and "../" the way the kernel does, compare
// paths case-insensitively where the file system is (macOS, Windows), and find
// the git repo a path belongs to without starting git.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Block } from './core.mjs';

export const IS_WIN = process.platform === 'win32';
// WHY: the default macOS and Windows file systems ignore case, so
// "SDLC-DOCS/../App/X.php" and ".ENV" must match their lower-case forms.
export const FOLD = process.platform === 'darwin' || IS_WIN;

export function homeDir() {
  return os.homedir();
}

export function fold(s) {
  return FOLD ? String(s).toLowerCase() : String(s);
}

// Normal form for comparing two paths: forward slashes, no trailing slash, folded.
export function cmpForm(p) {
  let s = String(p).replace(/\\/g, '/');
  while (s.length > 1 && s.endsWith('/') && !/^[A-Za-z]:\/$/.test(s)) s = s.slice(0, -1);
  return fold(s);
}

export function samePath(a, b) {
  return cmpForm(a) === cmpForm(b);
}

// true if p is dir or inside it.
export function under(p, dir) {
  if (!p || !dir) return false;
  const a = cmpForm(p);
  const d = cmpForm(dir);
  if (a === d) return true;
  return a.startsWith(d.endsWith('/') ? d : d + '/');
}

export function expandTilde(p) {
  if (p === '~') return homeDir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(homeDir(), p.slice(2));
  return p;
}

// Git Bash on Windows writes C:\x as /c/x.
function fromGitBash(p) {
  if (!IS_WIN) return p;
  const m = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(p);
  return m ? `${m[1].toUpperCase()}:\\${(m[2] || '').replace(/\//g, '\\')}` : p;
}

let hops = 0;

// Physical absolute path. Symlinks are followed component by component, so
// "link/../x" lands where the kernel would put it; components that do not
// exist yet (a new file) are appended as text.
export function resolvePath(p, base) {
  hops = 0;
  let b = base && path.isAbsolute(fromGitBash(base)) ? fromGitBash(base) : process.cwd();
  return resolveInner(String(p), b, 0);
}

function resolveInner(p, base, depth) {
  if (depth > 16 || ++hops > 64) throw new Block('parse', `too many symlinks while resolving ${p}`);
  p = fromGitBash(expandTilde(p));
  const abs = path.isAbsolute(p) ? p : (base.endsWith(path.sep) ? base : base + path.sep) + p;
  const root = path.parse(abs).root || path.sep;
  const parts = abs.slice(root.length).split(/[\\/]+/);
  let cur = root;
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      cur = path.dirname(cur);
      continue;
    }
    const nxt = path.join(cur, part);
    let st = null;
    try {
      st = fs.lstatSync(nxt);
    } catch {
      st = null;
    }
    if (st && st.isSymbolicLink()) {
      let target;
      try {
        target = fs.readlinkSync(nxt);
      } catch {
        throw new Block('parse', `cannot read symlink ${nxt}`);
      }
      cur = resolveInner(target, cur, depth + 1);
    } else {
      cur = nxt;
    }
  }
  return cur;
}

export function exists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Nearest folder at or above `abs` that holds a .git entry, or null.
const repoCache = new Map();
export function findRepo(abs) {
  if (!abs) return null;
  let cur = abs;
  const seen = [];
  for (;;) {
    const key = cmpForm(cur);
    if (repoCache.has(key)) {
      const r = repoCache.get(key);
      for (const s of seen) repoCache.set(s, r);
      return r;
    }
    seen.push(key);
    if (exists(path.join(cur, '.git'))) {
      for (const s of seen) repoCache.set(s, cur);
      return cur;
    }
    const up = path.dirname(cur);
    if (up === cur) {
      for (const s of seen) repoCache.set(s, null);
      return null;
    }
    cur = up;
  }
}

export function gitDirOf(repo) {
  const g = path.join(repo, '.git');
  try {
    const st = fs.statSync(g);
    if (st.isDirectory()) return g;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(g, 'utf8'));
    if (!m) return null;
    return path.isAbsolute(m[1]) ? m[1] : path.resolve(repo, m[1]);
  } catch {
    return null;
  }
}

// Current branch name read straight from HEAD (no git process), or null when
// HEAD is detached or unreadable.
export function currentBranch(repo) {
  const gd = gitDirOf(repo);
  if (!gd) return null;
  try {
    const head = fs.readFileSync(path.join(gd, 'HEAD'), 'utf8').trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// Short path for messages.
export function disp(p) {
  const h = homeDir();
  return under(p, h) && !samePath(p, h) ? '~' + String(p).slice(h.length) : String(p);
}
