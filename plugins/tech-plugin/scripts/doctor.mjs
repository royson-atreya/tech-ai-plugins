#!/usr/bin/env node
// tech-plugin doctor: checks the setup and prints a Markdown table.
// It never installs or changes anything; it prints the commands for the person
// to run. Usage: node doctor.mjs [--ci] [--dir <folder>]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectLanguages, effortWarning, installCommand, installedPlugins } from './lib/detect.mjs';

const ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';

export const GRAPHIFY_NOTE = "Don't run `graphify install`; tech-plugin reads the graph itself";
export const GRAPHIFY_INSTALL = 'uv tool install graphifyy';

function args() {
  const a = process.argv.slice(2);
  const out = { ci: a.includes('--ci'), dir: process.cwd() };
  const i = a.indexOf('--dir');
  if (i >= 0 && a[i + 1]) out.dir = path.resolve(a[i + 1]);
  return out;
}

// First line of `<cmd> <args>`, or null when it is missing or fails.
export function version(cmd, argv = ['--version']) {
  try {
    const r = spawnSync(cmd, argv, { encoding: 'utf8', timeout: 5000, shell: IS_WIN, windowsHide: true });
    if (r.error || r.status !== 0) return null;
    const text = `${r.stdout || ''}${r.stderr || ''}`.trim();
    return text.split('\n')[0].trim() || null;
  } catch {
    return null;
  }
}

function pluginVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version;
  } catch {
    return '?';
  }
}

function commands() {
  const dir = path.join(ROOT, 'skills');
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(dir).sort();
  } catch {
    return out;
  }
  for (const n of names) {
    const f = path.join(dir, n, 'SKILL.md');
    if (!fs.existsSync(f)) continue;
    const text = fs.readFileSync(f, 'utf8');
    const m = /^description:\s*(.+)$/m.exec(text);
    out.push({ name: `/tech-plugin:${n}`, description: m ? m[1].replace(/^["']|["']$/g, '').trim() : '' });
  }
  return out;
}

// Runs the real guard on a harmless fake call (reading a .env file that does
// not exist) and expects it to block.
function guardSelfTest() {
  try {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'guard.mjs')], {
      input: JSON.stringify({ tool_name: 'Read', cwd: os.tmpdir(), tool_input: { file_path: path.join(os.tmpdir(), 'tech-plugin-doctor', '.env') } }),
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT },
    });
    return r.status === 2 && /BLOCKED \[secrets\]/.test(r.stderr) ? null : `exit ${r.status}: ${(r.stderr || '').trim().slice(0, 120)}`;
  } catch (e) {
    return e.message;
  }
}

const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function report({ dir, env = process.env, home = os.homedir() } = {}) {
  const rows = [];
  const notes = [];
  const add = (check, ok, status, details = '') => rows.push([check, `${ok === true ? '✅' : ok === false ? '❌' : '⚠️'} ${status}`, details]);

  const cc = version('claude');
  add('Claude Code', !!cc, cc || 'not found on PATH', cc ? '' : 'Install: https://code.claude.com/docs (then reopen the terminal)');
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add('node', nodeMajor >= 18, process.version, nodeMajor >= 18 ? 'runs the guard, banner and doctor' : 'tech-plugin needs Node.js 18 or newer');
  const git = version('git');
  add('git', !!git, git || 'not found', git ? '' : 'Install git (https://git-scm.com/downloads)');
  const py = version(IS_WIN ? 'python' : 'python3');
  add('Python', py ? true : null, py || 'not found', py ? 'needed by graphify' : 'graphify needs Python 3.10+ (https://www.python.org/downloads/)');
  const uv = version('uv');
  add('uv', uv ? true : null, uv || 'not found', uv ? 'installs graphify' : IS_WIN ? 'Install: powershell -c "irm https://astral.sh/uv/install.ps1 | iex"' : 'Install: curl -LsSf https://astral.sh/uv/install.sh | sh  (or: brew install uv)');
  const gf = version('graphify');
  add('graphify', gf ? true : null, gf || 'not found', gf ? GRAPHIFY_NOTE : `Install: \`${GRAPHIFY_INSTALL}\` (needs Python + uv). ${GRAPHIFY_NOTE}`);

  const installed = installedPlugins(home);
  const langs = detectLanguages(dir);
  if (!langs.length) add('LSP plugins', null, 'no manifest found here', `looked for composer.json, package.json, tsconfig.json, pyproject.toml, requirements*.txt, go.mod, pom.xml, build.gradle(.kts), pubspec.yaml in ${dir}`);
  for (const l of langs) {
    const ev = `(${l.evidence.join(', ')})`;
    if (!l.plugin) {
      add(`LSP: ${l.lang}`, null, 'no official plugin', `${l.note} ${ev}`);
      continue;
    }
    const has = [...installed].some((id) => id.startsWith(`${l.plugin}@`));
    add(`LSP: ${l.lang}`, has ? true : null, has ? `${l.plugin} installed` : `${l.plugin} not installed`, has ? ev : `${installCommand(l.plugin)} ${ev}`);
  }

  const ew = effortWarning(env);
  add('Effort setting', ew ? null : true, ew ? 'CLAUDE_CODE_EFFORT_LEVEL is set' : 'not overridden', ew || 'each command uses its own effort');

  add('Zoho Sprints MCP', null, 'ZOHO_STATUS', 'Claude fills this in from the tools it can see');

  let repo = null;
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) {
      repo = d;
      break;
    }
    if (path.dirname(d) === d) break;
  }
  const docs = path.join(repo || dir, 'sdlc-docs');
  add('Project', null, repo ? `repo ${path.basename(repo)}` : 'not in a git repo', fs.existsSync(docs) ? 'sdlc-docs/ found' : 'sdlc-docs/ not set up yet (a later command creates it)');

  const g = guardSelfTest();
  add('Safety guard', !g, g ? 'NOT working' : 'working', g ? `self-test failed (${g}); every tool call may be blocked` : 'blocked a test read of a .env file');

  const lines = [];
  lines.push(`**tech-plugin v${pluginVersion()} doctor** (${dir})`, '');
  lines.push('| Check | Status | Details / fix |', '|---|---|---|');
  for (const r of rows) lines.push(`| ${r.map(esc).join(' | ')} |`);
  lines.push('', '**Commands**', '');
  for (const c of commands()) lines.push(`- \`${c.name}\` ${c.description}`);
  lines.push('', 'doctor never installs anything: run the commands above yourself.');
  if (notes.length) lines.push('', ...notes);
  return lines.join('\n');
}

function main() {
  const a = args();
  if (a.ci) {
    process.stdout.write('doctor --ci: coming in a later step (it will add a check that runs on every pull request).\n');
    return;
  }
  process.stdout.write(report({ dir: a.dir }) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
