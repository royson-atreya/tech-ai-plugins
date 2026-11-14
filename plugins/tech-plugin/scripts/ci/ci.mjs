#!/usr/bin/env node
// Checks on every pull request (/tech-plugin:doctor --ci).
//
//   node ci.mjs workflow --repo DIR [--marketplace owner/repo]
//         writes DIR/sdlc-docs/ci/tech-plugin.yml (the person copies it into
//         .github/workflows/: Claude writes only inside sdlc-docs/)
//   node ci.mjs pr --home DIR --base SHA [--head REF] [--gitleaks FILE] [--out FILE] [--patch FILE]
//         the PR comment: the modules the changed files belong to, their risk,
//         the documents that cite those files, files in no module, secret files
//         changed, and the gitleaks findings (rule, file and line; never the
//         value). Runs in GitHub Actions without Claude; read only. --patch
//         also writes the diff (secret files left out) for the optional AI review
//   node ci.mjs ai-comment --input REVIEW --home DIR
//         the optional AI review as a comment, in sdlc-docs/_state/ci/ai-comment.md
//         (refused if it quotes a key or personal data); the workflow posts it
//
// Never pushes, never writes outside sdlc-docs/ and the --out/--patch files.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { redact, scanText } from '../lib/redact.mjs';
import { PLUGIN_ROOT, docsDir, fail, isSecretFor, parseArgs, readJson, real, writeDocs } from '../breakdown/common.mjs';
import { loadState } from '../breakdown/state.mjs';
import { loadExisting } from '../breakdown/modules.mjs';
import { loadSystem } from '../breakdown/load.mjs';
import { moduleFiles } from '../work/impact.mjs';

export const MARKER = '<!-- tech-plugin-ci -->';
const git = (abs, args) => spawnSync('git', ['-C', abs, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// ------------------------------------------------------------------ workflow

export function marketplaceRepo() {
  const f = path.join(os.homedir(), '.claude', 'plugins', 'known_marketplaces.json');
  const k = readJson(f) || {};
  const m = k['tech-ai-plugins'];
  return m && m.source === 'github' && m.repo ? m.repo : null;
}

export function workflow(repo, { marketplace = null } = {}) {
  const mk = marketplace || marketplaceRepo() || '<owner>/<marketplace-repo>';
  const tpl = fs.readFileSync(path.join(PLUGIN_ROOT, 'references', 'release', 'ci-workflow.yml'), 'utf8');
  const text = tpl.replaceAll('{{MARKETPLACE}}', mk);
  const rel = path.join('ci', 'tech-plugin.yml');
  const file = writeDocs(repo, rel, text);
  return {
    file,
    marketplace: mk,
    known: mk !== '<owner>/<marketplace-repo>',
    commands: [`mkdir -p '${path.join(repo, '.github', 'workflows')}' && cp '${file}' '${path.join(repo, '.github', 'workflows', 'tech-plugin.yml')}'`],
    secrets: [
      'TECH_PLUGIN_TOKEN (only if the marketplace repo is private): a GitHub token that can read it',
      'ANTHROPIC_API_KEY (only for the optional AI review): set the repo variable TECH_PLUGIN_AI_REVIEW to true to turn it on; each PR uses API credit',
    ],
  };
}

// ------------------------------------------------------------------ pr

function homeRepoName(home) {
  const st = loadState(home);
  const me = ((st && st.repos) || []).find((r) => path.resolve(home, r.path) === path.resolve(home));
  return me ? me.name : null;
}

function docsCiting(home, repo, files) {
  const out = new Map();
  const d = path.join(docsDir(home), 'modules');
  if (!fs.existsSync(d)) return out;
  for (const m of fs.readdirSync(d)) {
    for (const f of ['spec.md', 'brd.md', 'prd.md', 'module.md']) {
      const p = path.join(d, m, f);
      if (!fs.existsSync(p)) continue;
      const t = fs.readFileSync(p, 'utf8');
      const hits = files.filter((x) => t.includes(`${repo}:${x}`));
      if (hits.length) out.set(`modules/${m}/${f}`, hits);
    }
  }
  return out;
}

function gitleaksFindings(file) {
  if (!file) return null;
  if (!fs.existsSync(file)) return { ran: false };
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8') || '[]');
    return { ran: true, findings: (Array.isArray(j) ? j : []).map((x) => ({ rule: x.RuleID || x.Description || 'secret', file: x.File, line: x.StartLine })) };
  } catch {
    return { ran: false };
  }
}

export function pr(home, { base, head = 'HEAD', gitleaks = null, out = null, patch = null }) {
  if (!base) fail('--base SHA is required: the base commit of the pull request');
  const names = git(home, ['diff', '--name-status', '--no-renames', `${base}...${head}`]);
  if (names.status !== 0) fail(`git diff ${base}...${head} failed: ${(names.stderr || '').trim().split('\n')[0]}`);
  const changed = names.stdout.split('\n').filter(Boolean).map((l) => {
    const [st, f] = l.split('\t');
    return { status: st, path: f };
  }).filter((f) => !f.path.startsWith('sdlc-docs/'));
  const secret = isSecretFor(home);
  const secretFiles = changed.filter((f) => secret(f.path)).map((f) => f.path);
  const my = fs.existsSync(path.join(docsDir(home), 'modules.yaml')) ? loadExisting(home) : null;
  const repo = my ? homeRepoName(home) : null;
  const modules = [];
  let unmapped = changed.map((f) => f.path);
  if (my && repo) {
    let files = new Map();
    try {
      files = moduleFiles(loadSystem(home), my);
    } catch {
      /* no code map in the repo */
    }
    const owner = new Map();
    for (const [m, set] of files) for (const k of set) if (k.startsWith(`${repo}:`)) owner.set(k.slice(repo.length + 1), [...(owner.get(k.slice(repo.length + 1)) || []), m]);
    const per = new Map();
    for (const f of changed) for (const m of owner.get(f.path) || []) per.set(m, [...(per.get(m) || []), f.path]);
    unmapped = changed.map((f) => f.path).filter((p) => !owner.has(p));
    const cites = docsCiting(home, repo, changed.map((f) => f.path));
    for (const [m, fl] of per) {
      const mod = my.modules.find((x) => x.id === m);
      modules.push({ id: m, name: mod ? mod.name : m, critical: !!(mod && mod.critical), risk: mod ? (mod.risk || []).map((r) => r.flag) : [], files: fl, docs: [...cites].filter(([d]) => d.startsWith(`modules/${m}/`)).map(([d]) => d) });
    }
    modules.sort((a, b) => Number(b.critical) - Number(a.critical) || b.files.length - a.files.length);
  }
  const gl = gitleaksFindings(gitleaks);
  const L = [MARKER, '### tech-plugin check', ''];
  if (!my) L.push(`No \`sdlc-docs/modules.yaml\` in this repo${fs.existsSync(path.join(docsDir(home), 'home.json')) ? ' (its documents live in another repo)' : ''}: the parts of the product are not shown. ${changed.length} file(s) changed.`, '');
  else {
    L.push(`**${changed.length} file(s) changed** in ${modules.length} part(s) of the product${unmapped.length ? `, and ${unmapped.length} file(s) in none` : ''}.`, '');
    if (modules.length) {
      L.push('| Part of the product | Risk | Files | Documents that may need a refresh |', '|---|---|---|---|');
      for (const m of modules) L.push(`| ${m.name} (\`${m.id}\`) | ${m.critical ? `**critical** (${m.risk.join(', ')})` : m.risk.join(', ') || '-'} | ${m.files.length} | ${m.docs.map((d) => `\`${d}\``).join(', ') || '-'} |`);
      L.push('');
    }
    if (unmapped.length) L.push(`<details><summary>Files in no part of the product (${unmapped.length})</summary>`, '', ...unmapped.slice(0, 30).map((f) => `- \`${f}\``), unmapped.length > 30 ? `- … and ${unmapped.length - 30} more` : '', '</details>', '');
  }
  if (secretFiles.length) L.push(`**Secret files changed:** ${secretFiles.map((f) => `\`${f}\``).join(', ')}. Make sure no real key is committed.`, '');
  if (!gl) L.push('**Secret scan:** not run.', '');
  else if (!gl.ran) L.push('**Secret scan:** gitleaks did not produce a report.', '');
  else if (!gl.findings.length) L.push('**Secret scan:** gitleaks found nothing.', '');
  else L.push(`**Secret scan:** gitleaks found ${gl.findings.length} possible secret(s). Remove them and rotate the keys:`, '', ...gl.findings.slice(0, 20).map((x) => `- ${x.rule} in \`${x.file}\` line ${x.line}`), '');
  if (modules.some((m) => m.docs.length)) L.push('_After the merge, `/tech-plugin:sync` refreshes the documents._', '');
  const body = L.filter((x, i, a) => !(x === '' && a[i - 1] === '')).join('\n');
  if (out) fs.writeFileSync(out, body + '\n');
  if (patch) {
    const d = git(home, ['diff', '--no-color', '--no-ext-diff', '--no-renames', `${base}...${head}`, '--', '.', ':(exclude)sdlc-docs']);
    const chunks = d.stdout.split(/^(?=diff --git )/m).filter((c) => {
      const m = /^diff --git a\/(\S+) b\//.exec(c);
      return m && !secret(m[1]);
    });
    fs.writeFileSync(patch, redact(chunks.join('')).slice(0, 600 * 1024));
  }
  return { changed: changed.length, modules, unmapped: unmapped.length, secretFiles, gitleaks: gl ? (gl.ran ? gl.findings.length : 'no report') : 'not run', comment: out || null, body: out ? undefined : body };
}

export const AI_MARKER = '<!-- tech-plugin-ai-review -->';

export function aiComment(home, { input }) {
  if (!input || !fs.existsSync(input)) fail('--input FILE is required: the security reviewer\'s reply');
  const raw = fs.readFileSync(input, 'utf8').trim();
  const s = /Summary:\s*(\d+)\s+findings?\s*·\s*(\d+)\s+blocking/i.exec(raw);
  if (!s) fail('the review has no "Summary: N findings · B blocking" line');
  const risks = scanText(raw);
  if (risks.length) fail(`not written: the review quotes ${risks.map((r) => r.type).join(', ')} (value not shown)`);
  const body = `${AI_MARKER}\n### tech-plugin AI security review\n\n${raw}\n\n_An AI review: a person decides what to change._\n`;
  const file = writeDocs(home, path.join('_state', 'ci', 'ai-comment.md'), body);
  fs.rmSync(input, { force: true });
  return { file, findings: Number(s[1]), blocking: Number(s[2]) };
}

// ------------------------------------------------------------------ main

function main() {
  const [cmd] = process.argv.slice(2);
  const a = parseArgs(process.argv.slice(3));
  const out = (v) => process.stdout.write(JSON.stringify(v, null, 2) + '\n');
  if (cmd === 'workflow') {
    if (!a.repo) fail('usage: ci.mjs workflow --repo DIR [--marketplace owner/repo]');
    return out(workflow(real(a.repo), { marketplace: a.marketplace || null }));
  }
  if (cmd === 'pr') {
    if (!a.home) fail('usage: ci.mjs pr --home DIR --base SHA [--head REF] [--gitleaks FILE] [--out FILE] [--patch FILE]');
    return out(pr(real(a.home), { base: a.base, head: a.head || 'HEAD', gitleaks: a.gitleaks || null, out: a.out || null, patch: a.patch || null }));
  }
  if (cmd === 'ai-comment') {
    if (!a.home) fail('usage: ci.mjs ai-comment --input REVIEW --home DIR');
    return out(aiComment(real(a.home), { input: a.input ? real(a.input) : null }));
  }
  fail('usage: ci.mjs <workflow|pr|ai-comment> …');
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) main();
