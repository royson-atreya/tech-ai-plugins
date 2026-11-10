#!/usr/bin/env node
// breakdown stage 2: stack facts for one repo.
//
//   node detect.mjs <repo> [--write]
//
// Prints one summary line. With --write it also saves the facts to
// <repo>/sdlc-docs/_map/<repo>/stack.json (sdlc-docs/ must exist: stage 1
// creates it after asking). Never opens secret files; never runs build or
// test commands (they are recorded as "found, not run").

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectRepo } from '../lib/stacks.mjs';
import { docsDir, fail, fingerprint, isSecretFor, parseArgs, real, writeDocs } from './common.mjs';

export function summaryLine(info) {
  if (info.empty) return `${info.repo}: no code yet, no stack detected`;
  const apps = info.apps.map((a) => {
    const main = a.stack.filter((s) => ['backend', 'web', 'mobile', 'desktop'].includes(s.kind)).map((s) => (s.version ? `${s.name} ${String(s.version).replace(/^[\^~>=v ]+/, '')}` : s.name));
    return `${a.id} (${a.kind}${main.length ? ': ' + main.join(', ') : ''})`;
  });
  const cmds = info.apps.reduce((n, a) => n + a.commands.length, 0);
  const tests = [...new Set(info.apps.flatMap((a) => a.tests.map((t) => t.tool)))];
  const parts = [
    `${info.repo}: ${info.apps.length} app${info.apps.length === 1 ? '' : 's'}: ${apps.join('; ')}`,
    `${cmds} commands found (not run)`,
    tests.length ? `tests: ${tests.join(', ')}` : 'no tests found',
    info.ci.length ? `CI: ${[...new Set(info.ci.map((c) => c.system))].join(', ')}` : 'no CI',
  ];
  if (info.secretsTracked.length) parts.push(`${info.secretsTracked.length} secret file(s) committed to git (names only, never opened)`);
  return parts.join(' | ');
}

function main() {
  const a = parseArgs(process.argv.slice(2), ['write']);
  if (!a._[0]) fail('usage: detect.mjs <repo> [--write]');
  const repo = real(a._[0]);
  if (!fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) fail(`${a._[0]} is not a folder`);
  const info = detectRepo(repo, isSecretFor(repo));
  info.fingerprint = fingerprint(repo);
  if (a.write) {
    if (!fs.existsSync(docsDir(repo))) fail(`${repo}/sdlc-docs does not exist yet; run stage 1 first (it asks before creating it)`);
    const p = writeDocs(repo, path.join('_map', info.repo, 'stack.json'), JSON.stringify(info, null, 2) + '\n');
    process.stdout.write(`${summaryLine(info)}\nwrote ${path.relative(repo, p)}\n`);
  } else {
    process.stdout.write(summaryLine(info) + '\n');
  }
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) main();
