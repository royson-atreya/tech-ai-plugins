#!/usr/bin/env node
// tech-plugin SessionStart banner: one line for the person via "systemMessage".
// WHY systemMessage: it is shown to the person but not added to Claude's
// context, so it costs no tokens. A banner must never block anything: on any
// error it still prints a line (with "?" for what it could not read) and exits 0.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function line() {
  const root = process.env.CLAUDE_PLUGIN_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  let ver = '?';
  try {
    ver = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version || '?';
  } catch {
    /* keep "?" */
  }
  let cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    if (input && typeof input.cwd === 'string' && input.cwd) cwd = input.cwd;
  } catch {
    /* no input: use the folder we were started in */
  }
  let repo = null;
  for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) {
      repo = d;
      break;
    }
    if (path.dirname(d) === d) break;
  }
  const base = repo || cwd;
  let docs = fs.existsSync(path.join(base, 'sdlc-docs')) ? 'found' : 'not set up';
  if (docs === 'found' && fs.existsSync(path.join(base, 'sdlc-docs', 'config.json'))) {
    try {
      JSON.parse(fs.readFileSync(path.join(base, 'sdlc-docs', 'config.json'), 'utf8'));
    } catch {
      docs = 'found (config.json is broken: the guard blocks until it is fixed)';
    }
  }
  return `tech-plugin v${ver} | repo ${repo ? path.basename(repo) : 'none'} | sdlc-docs: ${docs} | guard on | next: /tech-plugin:next`;
}

let msg;
try {
  msg = line();
} catch {
  msg = 'tech-plugin v? | repo ? | sdlc-docs: ? | guard on | next: /tech-plugin:next';
}
try {
  fs.writeSync(1, JSON.stringify({ systemMessage: msg }) + '\n');
} catch {
  /* never fail */
}
process.exit(0);
