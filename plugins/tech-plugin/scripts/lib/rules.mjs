// The guard's rules, shared by every tool handler (file tools, Grep/Glob, Bash,
// MCP tools) so they all behave the same.
//
//   a secrets          b repo-write      c git (see bash.mjs)   d installs (bash.mjs)
//   e prod-hosts       f zoho            g self-protection      h personal data (TODO)
//
// Every rule only ADDS restrictions; none grants what another denies, so their
// order does not matter. The guard never answers "allow": a pass leaves the call
// to Claude Code's normal permissions.

import fs from 'node:fs';
import path from 'node:path';
import { Block, checkDeadline } from './core.mjs';
import { loadDefaults, loadProject, merge } from './config.mjs';
import {
  cmpForm, currentBranch, disp, findRepo, fold, homeDir, resolvePath, samePath, under, IS_WIN,
} from './paths.mjs';

// TODO(rule h, personal data): built in a later step together with database
// access: masked columns, synthetic test data, and a check that no patient or
// personal data goes into prompts, documents, tickets or test data.

// ------------------------------------------------------------------ context

export function makeCtx(input, pluginRoot) {
  const home = homeDir();
  const cwd = typeof input.cwd === 'string' && input.cwd ? resolvePath(input.cwd, '/') : process.cwd();
  const pd = process.env.CLAUDE_PROJECT_DIR ? resolvePath(process.env.CLAUDE_PROJECT_DIR, cwd) : cwd;
  const ctx = {
    input,
    tool: input.tool_name,
    pluginRoot,
    home,
    cwd,
    projectDir: pd,
    defaults: loadDefaults(pluginRoot),
    asks: [],
    vars: new Map(),
    taint: null,
    netish: false,
    cfgCache: new Map(),
  };
  // Repos the session works in: their configs apply to every check.
  ctx.baseRepos = [...new Set([findRepo(cwd), findRepo(pd)].filter(Boolean))];
  ctx.baseErrors = ctx.baseRepos
    .map((r) => ({ repo: r, error: loadProject(r).error }))
    .filter((x) => x.error);
  ctx.cfgFor = (repo) => cfgFor(ctx, repo);
  ctx.ask = (msg) => ctx.asks.push(msg);
  return ctx;
}

function cfgFor(ctx, repo) {
  const key = repo || '';
  if (ctx.cfgCache.has(key)) return ctx.cfgCache.get(key);
  const repos = [...ctx.baseRepos];
  if (repo && !repos.includes(repo)) repos.push(repo);
  const projects = [];
  for (const r of repos) {
    const { cfg, error } = loadProject(r);
    if (error) throw new Block('config', `${error} (repo ${path.basename(r)}); fix that file by hand`);
    projects.push(cfg);
  }
  const m = merge(ctx.defaults, projects);
  m.secretRes = m.secretPatterns.map(globToRegex);
  m.secretExc = new Set(m.secretExceptions.map((x) => x.toLowerCase()));
  m.secretTokens = secretTokens(m.secretPatterns);
  m.branchRes = m.protectedBranches.map((b) => globToRegex(b, true));
  ctx.cfgCache.set(key, m);
  return m;
}

// ------------------------------------------------------------------ globs

// Basename glob -> case-insensitive RegExp. `anyChar` lets * cross "/" (branch names).
export function globToRegex(g, anyChar = false) {
  const star = anyChar ? '.*' : '[^/]*';
  let re = '^';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') re += star;
    else if (c === '?') re += anyChar ? '.' : '[^/]';
    else if (c === '[') {
      const j = g.indexOf(']', i + 2);
      if (j > i) {
        let cls = g.slice(i + 1, j).replace(/\\/g, '\\\\');
        if (cls[0] === '!') cls = '^' + cls.slice(1);
        re += `[${cls}]`;
        i = j;
      } else re += '\\[';
    } else re += c.replace(/[.+^${}()|\\/\]]/g, '\\$&');
  }
  return new RegExp(re + '$', 'i');
}

// Literal chunks of each secret pattern (".env", ".jks", "firebase-"...), used to
// tell whether a search pattern is aimed at secret files.
function secretTokens(patterns) {
  const out = new Set();
  for (const p of patterns) {
    const chunks = p.toLowerCase().split(/[*?[\]]+/).filter((c) => c.length >= 3);
    if (chunks.length) out.add(chunks.sort((a, b) => b.length - a.length)[0]);
  }
  return [...out];
}

// ------------------------------------------------------------------ rule a: secrets

export function baseName(p) {
  return String(p).split(/[\\/]/).pop();
}

// true if the file NAME is a secret (.env, keystores, Firebase/Google files...).
export function isSecretName(name, ctx, repo = null) {
  const b = baseName(name).toLowerCase();
  if (!b) return false;
  const cfg = ctx.cfgFor(repo);
  if (cfg.secretExc.has(b)) return false;
  return cfg.secretRes.some((re) => re.test(b));
}

// Secret check for a resolved absolute path (also applies the path's own repo config).
export function isSecretPath(abs, ctx) {
  return isSecretName(abs, ctx, findRepo(abs));
}

// true if a search/glob pattern text names secret files (".env*", "**/*.pem").
export function textNamesSecret(text, ctx) {
  const cfg = ctx.cfgFor(null);
  let t = String(text).toLowerCase();
  for (const e of cfg.secretExc) t = t.split(e).join('');
  for (const alt of braceAlternatives(t)) {
    if (cfg.secretTokens.some((tok) => alt.includes(tok))) return true;
  }
  return false;
}

// "a{b,c}d" -> ["abd", "acd"] (simple, for pattern text only).
export function braceAlternatives(t, depth = 0) {
  const s = t.indexOf('{');
  if (s < 0 || depth > 6) return [t];
  let d = 0;
  let e = -1;
  const commas = [];
  for (let k = s; k < t.length; k++) {
    if (t[k] === '{') d++;
    else if (t[k] === '}') {
      d--;
      if (d === 0) {
        e = k;
        break;
      }
    } else if (t[k] === ',' && d === 1) commas.push(k);
  }
  if (e < 0 || !commas.length) return [t];
  const parts = [];
  let st = s + 1;
  for (const c of [...commas, e]) {
    parts.push(t.slice(st, c));
    st = c + 1;
  }
  return parts.flatMap((p) => braceAlternatives(t.slice(0, s) + p + t.slice(e + 1), depth + 1)).slice(0, 64);
}

// WHY: a content search over $HOME or "/" would take far too long to check,
// and a hook that times out lets the call through.
export function tooBroad(dir, ctx) {
  const d = cmpForm(dir);
  if (d === '/' || /^[a-z]:\/?$/i.test(d)) return true;
  return under(ctx.home, dir);
}

// Dependency folders hold third-party files, can be huge, and are not the
// project's secrets; they are not scanned (documented in the README).
const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor', 'pods', '.venv', 'venv', '__pycache__', '.gradle', '.dart_tool', '.pub-cache']);
const SCAN_MS = 700;
const SCAN_MAX = 150000;

// Secret files below `dir` (names only; contents are never opened).
export function secretsUnder(dir, ctx, { follow = false, firstOnly = false } = {}) {
  const found = [];
  let st;
  try {
    st = fs.statSync(dir);
  } catch {
    return found;
  }
  if (!st.isDirectory()) return isSecretPath(dir, ctx) ? [dir] : found;
  if (tooBroad(dir, ctx)) {
    throw new Block('secrets', `a content search over ${disp(dir)} is too broad to check for secret files; narrow the path`);
  }
  const repo = findRepo(dir);
  const t0 = Date.now();
  let count = 0;
  const stack = [dir];
  const seen = new Set();
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (++count > SCAN_MAX || (count % 512 === 0 && Date.now() - t0 > SCAN_MS)) {
        throw new Block('secrets', `${disp(dir)} is too large to check for secret files quickly; narrow the path or use a names-only search`);
      }
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name.toLowerCase())) stack.push(full);
        continue;
      }
      if (e.isSymbolicLink()) {
        let real = null;
        try {
          real = fs.realpathSync(full);
        } catch {
          real = null;
        }
        if (isSecretName(e.name, ctx, repo) || (real && isSecretPath(real, ctx))) {
          found.push(full);
          if (firstOnly) return found;
          continue;
        }
        if (real && follow && !seen.has(real)) {
          try {
            if (fs.statSync(real).isDirectory() && !tooBroad(real, ctx)) {
              seen.add(real);
              stack.push(real);
            }
          } catch {
            /* dangling link */
          }
        }
        continue;
      }
      if (isSecretName(e.name, ctx, repo)) {
        found.push(full);
        if (firstOnly) return found;
      }
    }
  }
  return found;
}

// ------------------------------------------------------------------ rule b: repo-write gate

// null when writing inside `repo` (outside sdlc-docs/) is allowed, else the reason.
export function gate(repo, ctx) {
  const name = path.basename(repo);
  const docs = path.join(repo, 'sdlc-docs');
  const work = path.join(docs, 'work');
  const activeFile = path.join(work, '.active');
  let text;
  try {
    text = fs.readFileSync(activeFile, 'utf8');
  } catch {
    return `no work item is active (sdlc-docs/work/.active is missing in ${name})`;
  }
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (lines.length !== 1) return 'sdlc-docs/work/.active must name exactly one work item';
  const id = lines[0];
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === '.' || id === '..') {
    return `sdlc-docs/work/.active names "${id.slice(0, 40)}", which is not a valid work item ID`;
  }
  for (const p of [docs, work, path.join(work, id)]) {
    try {
      if (fs.lstatSync(p).isSymbolicLink()) return `${disp(p)} is a symlink; approvals must be real files in the repo`;
    } catch {
      return `work item ${id} has no folder sdlc-docs/work/${id}`;
    }
  }
  let st;
  try {
    st = fs.lstatSync(path.join(work, id, 'APPROVED'));
  } catch {
    return `work item ${id} is not approved (no sdlc-docs/work/${id}/APPROVED)`;
  }
  if (!st.isFile()) return `sdlc-docs/work/${id}/APPROVED is not a regular file`;
  const br = currentBranch(repo);
  if (!br) return `cannot read the current branch of ${name} (detached HEAD?)`;
  const cfg = ctx.cfgFor(repo);
  if (cfg.branchRes.some((re) => re.test(br))) return `${name} is on protected branch ${br}; work on a feature branch`;
  return null;
}

// ------------------------------------------------------------------ rule g: self-protection

const SHELL_STARTUP = new Set(['.zshenv', '.zshrc', '.zprofile', '.zlogin', '.zlogout', '.bashrc', '.bash_profile', '.bash_login', '.profile', '.bash_logout']);

let pathDirs = null;
function onPathDirs() {
  if (pathDirs) return pathDirs;
  pathDirs = [];
  for (const d of (process.env.PATH || '').split(IS_WIN ? ';' : ':')) {
    if (!d || !path.isAbsolute(d)) continue;
    try {
      pathDirs.push(resolvePath(d, '/'));
    } catch {
      /* ignore */
    }
  }
  return pathDirs;
}

// Reason string if `p` itself must never be created, changed, moved or deleted.
export function protectedPath(p, ctx) {
  const b = fold(baseName(p));
  if (b === 'approved') return 'APPROVED files are created by people only';
  if (under(p, ctx.pluginRoot)) return "the plugin's own files";
  if (under(p, path.join(ctx.home, '.claude', 'plugins'))) return 'installed Claude Code plugins';
  if (samePath(path.dirname(p), ctx.home) && /^\.claude\.json/i.test(baseName(p))) return 'Claude Code configuration (~/.claude.json)';
  if (/^settings.*\.json$/i.test(baseName(p)) && fold(baseName(path.dirname(p))) === '.claude') {
    return 'Claude Code settings (they could switch this guard off)';
  }
  if (samePath(path.dirname(p), ctx.home) && SHELL_STARTUP.has(b)) return 'a shell startup file (it could change how commands run)';
  if (onPathDirs().some((d) => samePath(path.dirname(p), d))) return 'a folder on PATH (a file there could stand in for a trusted command)';
  return null;
}

// Reason string if deleting/moving the folder `p` would take a protected thing with it.
export function protectedInside(p, ctx) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch {
    return null;
  }
  if (!st.isDirectory()) return null;
  if (under(ctx.pluginRoot, p)) return 'it contains the plugin';
  if (under(ctx.home, p)) return 'it contains your home folder';
  if (under(path.join(ctx.home, '.claude', 'plugins'), p)) return 'it contains the installed Claude Code plugins';
  const t0 = Date.now();
  let count = 0;
  const stack = [p];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (++count > SCAN_MAX || (count % 512 === 0 && Date.now() - t0 > SCAN_MS)) {
        return 'it is too large to check for APPROVED files and git repos';
      }
      const lower = e.name.toLowerCase();
      if (lower === 'approved') return `it contains ${disp(path.join(d, e.name))}`;
      if (lower === '.git') return `it contains a git repository (${disp(d)})`;
      if (/^settings.*\.json$/.test(lower) && fold(path.basename(d)) === '.claude') return `it contains Claude Code settings (${disp(path.join(d, e.name))})`;
      if (e.isDirectory()) stack.push(path.join(d, e.name));
    }
  }
  return null;
}

// ------------------------------------------------------------------ rule b + g: one write

// Blocks unless writing the resolved path `p` is allowed.
//   destructive: p may be removed/moved (rm, mv source, rsync --delete...)
//   extract:     an archive/patch is unpacked into p
export function checkWrite(p, ctx, { destructive = false, extract = false, verb = '' } = {}) {
  checkDeadline();
  const what = verb ? `${verb} ${disp(p)}` : disp(p);
  const prot = protectedPath(p, ctx);
  if (prot) throw new Block('self-protection', `${what}: ${prot}`);
  if (isSecretPath(p, ctx)) throw new Block('secrets', `${what}: secret files are never read or changed`);
  if (destructive) {
    const inside = protectedInside(p, ctx);
    if (inside) throw new Block('self-protection', `${what}: ${inside}`);
  }
  // A file with several hard links can be a second name for a repo file.
  try {
    const st = fs.lstatSync(p);
    if (st.isFile() && st.nlink > 1) {
      throw new Block('repo-write', `${what} has ${st.nlink} hard links; the guard cannot tell where the other names are`);
    }
  } catch (e) {
    if (e instanceof Block) throw e;
  }
  const repo = findRepo(p);
  if (!repo) return;
  if (under(p, path.join(repo, '.git'))) throw new Block('git', `${what}: files inside .git are git state; only people change it`);
  const docs = path.join(repo, 'sdlc-docs');
  if (under(p, docs) && !samePath(p, docs)) {
    const work = path.join(docs, 'work');
    if (extract && (under(work, p) || under(p, work))) {
      throw new Block('self-protection', `${what}: unpacking into sdlc-docs/work could create an APPROVED file`);
    }
    if (samePath(p, path.join(docs, 'config.json'))) {
      ctx.ask(`tech-plugin: sdlc-docs/config.json holds this project's guard settings (blocked hosts, secret patterns, protected branches). Confirm this change to ${disp(p)}.`);
    }
    return;
  }
  if (samePath(p, docs) && !destructive && !extract) return; // mkdir sdlc-docs
  const why = gate(repo, ctx);
  if (why) throw new Block('repo-write', `${what} is in repo ${path.basename(repo)} outside sdlc-docs/: ${why}`);
}

// ------------------------------------------------------------------ rule e: production hosts

export function hostHit(text, ctx) {
  const hosts = ctx.cfgFor(null).blockedHosts;
  if (!hosts.length) return null;
  const t = String(text).toLowerCase();
  for (const h of hosts) {
    const esc = h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // exact host or any subdomain; a trailing dot ("host.") is the same host.
    const re = new RegExp(`(^|[^a-z0-9.-])([a-z0-9-]+\\.)*${esc}\\.?([^a-z0-9.-]|$)`);
    if (re.test(t)) return h;
  }
  return null;
}

// ------------------------------------------------------------------ rule f: Zoho

const READ_ACTION = /^(get|list|search|fetch|read|view|find|describe|show|query|count|lookup|check)/i;

// 'pass' | 'ask' | {block} for a Zoho tool, or null if the tool is not Zoho.
export function zohoDecision(tool) {
  if (!/zoho/i.test(tool)) return null;
  let action = tool.includes('__') ? tool.slice(tool.lastIndexOf('__') + 2) : tool;
  action = action.replace(/^zoho[_-]?sprints?[_-]?/i, '').replace(/^zoho[a-z]*[_-]/i, '');
  const isRead = READ_ACTION.test(action);
  if (/zoho[_ -]?sprints?/i.test(tool)) return isRead ? 'pass' : 'ask';
  // Other Zoho apps are not part of this workflow: reads pass, writes are blocked.
  return isRead ? 'pass' : 'block';
}
