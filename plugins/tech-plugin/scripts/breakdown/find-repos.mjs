#!/usr/bin/env node
// breakdown stage 1: which repos and apps make up this system?
//
//   node find-repos.mjs [--cwd DIR] [path | git-url ...]
//
// No arguments: the repo the folder is in, or every git repo one or two levels
// below a workspace folder. Paths: those folders. Git URLs: never cloned here
// (the guard keeps git read-only); the output gives the clone command for the
// person to run. Read-only: prints JSON, writes nothing.

import fs from 'node:fs';
import path from 'node:path';
import { detectRepo, SKIP_DIRS } from '../lib/stacks.mjs';
import { DOCS, isSecretFor, parseArgs, readJson, real, repoRoot } from './common.mjs';

const URL_RE = /^(https?:\/\/|ssh:\/\/|git@|git:\/\/)/i;

function role(info) {
  const kinds = info.apps.map((a) => a.kind);
  if (info.empty) return 'empty';
  if (kinds.some((k) => k.startsWith('backend'))) return 'backend';
  if (kinds.includes('mobile')) return 'mobile';
  if (kinds.includes('web')) return 'web';
  if (kinds.includes('workspace')) return 'monorepo';
  return 'other';
}

function describe(dir) {
  const info = detectRepo(dir, isSecretFor(dir));
  const pointer = readJson(path.join(dir, DOCS, 'home.json'));
  return {
    name: path.basename(dir),
    path: dir,
    isGit: info.isGit,
    branch: info.branch,
    commit: info.commit,
    remote: info.remote,
    empty: info.empty,
    hasDocs: fs.existsSync(path.join(dir, DOCS)),
    hasState: fs.existsSync(path.join(dir, DOCS, '_state', 'breakdown.json')),
    pointer: pointer && pointer.home ? path.resolve(dir, pointer.home) : null,
    role: role(info),
    apps: info.apps.map((a) => ({ root: a.root, kind: a.kind, stack: a.stack.filter((s) => s.kind !== 'test').map((s) => s.name).slice(0, 6) })),
  };
}

// git repos one or two levels below `dir` (never deeper, never dependency folders)
function subRepos(dir) {
  const out = [];
  const visit = (d, depth) => {
    let ents = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name.toLowerCase())) continue;
      const p = path.join(d, e.name);
      if (fs.existsSync(path.join(p, '.git'))) out.push(p);
      else if (depth < 2) visit(p, depth + 1);
    }
  };
  visit(dir, 1);
  return out.sort();
}

function homeGuess(repos) {
  const backends = repos.filter((r) => r.role === 'backend');
  const named = backends.find((r) => /(api|backend|server|core)/i.test(r.name));
  return (named || backends[0] || repos.find((r) => !r.empty) || repos[0] || {}).path || null;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const cwd = real(a.cwd || process.cwd());
  const out = { mode: null, cwd, repos: [], urls: [], missing: [], homeGuess: null, notes: [] };
  const urls = a._.filter((x) => URL_RE.test(x));
  const paths = a._.filter((x) => !URL_RE.test(x));

  for (const u of urls) {
    const name = u.replace(/\/+$/, '').split(/[/:]/).pop().replace(/\.git$/, '');
    const dest = path.join(cwd, name);
    out.urls.push({ url: u, dest, exists: fs.existsSync(dest), command: `git clone ${u} "${dest}"` });
  }

  let dirs = [];
  if (paths.length) {
    out.mode = 'paths';
    for (const p of paths) {
      const abs = path.resolve(cwd, p.replace(/^~(?=$|\/)/, process.env.HOME || ''));
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) out.missing.push(p);
      else dirs.push(repoRoot(abs) || real(abs));
    }
  } else if (urls.length) {
    out.mode = 'urls';
  } else {
    const r = repoRoot(cwd);
    if (r) {
      out.mode = 'repo';
      dirs = [r];
      // a repo that already points to a home repo: include the whole system
      const ptr = readJson(path.join(r, DOCS, 'home.json'));
      if (ptr && ptr.home) out.notes.push(`This repo's system docs live in ${path.resolve(r, ptr.home)}.`);
    } else {
      const subs = subRepos(cwd);
      if (subs.length) {
        out.mode = 'workspace';
        dirs = subs;
      } else {
        const ents = fs.readdirSync(cwd).filter((n) => !n.startsWith('.'));
        out.mode = ents.length ? 'folder' : 'empty-folder';
        dirs = [cwd];
        if (!ents.length) out.notes.push('Empty folder: no code yet. A later command (requirement) helps start a new project.');
        else out.notes.push('This folder is not a git repo; its files are read as one project.');
      }
    }
  }
  dirs = [...new Set(dirs)];
  out.repos = dirs.map(describe);
  out.homeGuess = homeGuess(out.repos);
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

main();
