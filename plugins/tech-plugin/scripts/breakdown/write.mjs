#!/usr/bin/env node
// breakdown writers. Every file goes below a repo's sdlc-docs/ and nowhere else.
//
//   node write.mjs system  --input FILE      stage 1: system.yaml, glossary seed, README index,
//                                             pointers in the other repos, progress
//   node write.mjs profile --home REPO       stage 2: profile.md as a Draft from every repo's
//                                             stack.json + architecture notes + corrections
//   node write.mjs confirm --home REPO       stage 2: the person confirmed the profile in chat
//   node write.mjs summary --home REPO       short Markdown table for the chat
//
// The input FILE for "system" is JSON written by Claude from the person's answers:
//   { "system": "Name", "home": "/abs/repo", "repos": [{ "path": "/abs/repo", "role": "backend" }],
//     "business": { "product": "", "users": "", "keyFlows": [], "roles": [], "environments": [{ "name": "", "url": "", "production": false }] },
//     "docs": ["/abs/folder"], "tracker": "zoho-sprints" | "plain-text" }

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { YamlError, parseYaml, toYaml } from '../lib/yaml.mjs';
import { redactUrl } from '../lib/stacks.mjs';
import { DOCS, docsDir, fail, isSecretFor, parseArgs, readJson, real, rel, today, writeDocs } from './common.mjs';
import { loadState, saveState } from './state.mjs';

const nonEmpty = (v) => v !== undefined && v !== null && !(typeof v === 'string' && !v.trim()) && !(Array.isArray(v) && !v.length);

function docsSummary(folder) {
  const isSecret = isSecretFor(null);
  const types = {};
  let files = 0;
  const stack = [folder];
  while (stack.length && files < 5000) {
    const d = stack.pop();
    let ents = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) stack.push(path.join(d, e.name));
      else if (e.isFile() && !isSecret(e.name)) {
        files++;
        const ext = e.name.includes('.') ? e.name.split('.').pop().toLowerCase() : '(none)';
        types[ext] = (types[ext] || 0) + 1;
      }
    }
  }
  return { files, types: Object.fromEntries(Object.entries(types).sort((a, b) => b[1] - a[1])) };
}

// ------------------------------------------------------------------ stage 1

function writeSystem(inputFile) {
  const input = readJson(inputFile);
  if (!input) fail(`cannot read ${inputFile} as JSON`);
  if (!input.home || !Array.isArray(input.repos) || !input.repos.length) fail('input needs "home" and a non-empty "repos" list');
  const home = real(input.home);
  const repos = input.repos.map((r) => ({ ...r, path: real(r.path) }));
  if (!repos.some((r) => r.path === home)) fail('the home repo must be one of the repos');
  for (const r of repos) if (!fs.existsSync(r.path)) fail(`repo folder not found: ${r.path}`);

  const sysFile = path.join(docsDir(home), 'system.yaml');
  let existing = {};
  if (fs.existsSync(sysFile)) {
    try {
      existing = parseYaml(fs.readFileSync(sysFile, 'utf8')) || {};
    } catch (e) {
      if (e instanceof YamlError) fail(`sdlc-docs/system.yaml could not be read (${e.message}); fix it by hand, then run stage 1 again`);
      throw e;
    }
  }
  const b = input.business || {};
  const oldB = existing.business || {};
  const business = { ...oldB };
  for (const [k, yk] of [['product', 'product'], ['users', 'users'], ['keyFlows', 'key_flows'], ['roles', 'roles'], ['environments', 'environments']]) {
    if (nonEmpty(b[k])) business[yk] = b[k];
    else if (!(yk in business)) business[yk] = Array.isArray(b[k]) || ['key_flows', 'roles', 'environments'].includes(yk) ? [] : null;
  }
  if (Array.isArray(business.environments)) {
    business.environments = business.environments.map((e) => (typeof e === 'object' && e ? { name: e.name || null, url: e.url ? redactUrl(e.url) : null, production: !!e.production } : e));
  }
  const oldRepos = Array.isArray(existing.repos) ? existing.repos : [];
  const sysRepos = repos.map((r) => {
    const old = oldRepos.find((o) => o && o.name === path.basename(r.path)) || {};
    const git = spawnSync('git', ['-C', r.path, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 5000 });
    return {
      ...old,
      name: path.basename(r.path),
      path: rel(home, r.path),
      role: r.role || old.role || null,
      url: git.status === 0 && git.stdout.trim() ? redactUrl(git.stdout.trim()) : old.url || null,
      home: r.path === home,
    };
  });
  const docs = (input.docs || []).map((d) => {
    const abs = real(d);
    return { path: abs, ...(fs.existsSync(abs) ? docsSummary(abs) : { files: 0, missing: true }), converted: false };
  });
  const system = {
    ...existing,
    system: { ...(existing.system || {}), name: input.system || (existing.system && existing.system.name) || path.basename(home), home_repo: path.basename(home) },
    business,
    repos: sysRepos,
    docs: docs.length ? docs : existing.docs || [],
    connectors: { ...(existing.connectors || {}), tracker: input.tracker || (existing.connectors && existing.connectors.tracker) || 'plain-text' },
  };
  const header = 'tech-plugin system manifest. Written by /tech-plugin:breakdown (stage 1).\nEdit it freely: running stage 1 again keeps your edits and only adds what you answer.';
  writeDocs(home, 'system.yaml', toYaml(system, header));

  writeGlossary(home, system);
  writeIndex(home, system);
  for (const r of repos.filter((x) => x.path !== home)) {
    writeDocs(r.path, 'home.json', JSON.stringify({ home: rel(r.path, home), system: system.system.name, note: 'The system docs live in the home repo; this repo keeps its own _map/.' }, null, 2) + '\n');
    writeDocs(r.path, 'README.md', `# ${path.basename(r.path)}: docs\n\nThe docs for **${system.system.name}** live in the home repo: \`${rel(r.path, path.join(home, DOCS))}/README.md\`.\nThis folder holds this repo's own facts (\`_map/\`), written by /tech-plugin:breakdown.\n`);
  }

  const st = loadState(home) || { schema: 1, stages: {} };
  st.system = system.system.name;
  st.repos = repos.map((r) => {
    const old = (st.repos || []).find((o) => o.name === path.basename(r.path)) || {};
    return { ...old, name: path.basename(r.path), path: rel(home, r.path), role: r.role || old.role || null };
  });
  st.stages = { ...(st.stages || {}), 1: { status: 'done', at: new Date().toISOString() } };
  saveState(home, st);
  process.stdout.write(`stage 1 saved: ${repos.length} repo(s), home ${path.basename(home)}; wrote sdlc-docs/system.yaml, glossary.md, README.md${repos.length > 1 ? ' and pointers in ' + repos.filter((x) => x.path !== home).map((x) => path.basename(x.path)).join(', ') : ''}\n`);
}

function writeGlossary(home, system) {
  const file = path.join(docsDir(home), 'glossary.md');
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const have = new Set((old || '').split('\n').map((l) => (/^\|\s*([^|]+?)\s*\|/.exec(l) || [])[1]).filter(Boolean).map((t) => t.toLowerCase()));
  const rows = [];
  const add = (term, meaning, source) => {
    if (!term || have.has(term.toLowerCase()) || term.toLowerCase() === 'term') return;
    have.add(term.toLowerCase());
    rows.push(`| ${term.replace(/\|/g, '/')} | ${meaning.replace(/\|/g, '/')} | ${source} |`);
  };
  const b = system.business || {};
  if (system.system && system.system.name) add(system.system.name, b.product ? String(b.product).split('\n')[0].slice(0, 200) : 'The product (meaning to be filled in)', 'breakdown stage 1 (product)');
  for (const r of Array.isArray(b.roles) ? b.roles : []) add(String(r), 'A user role (meaning to be filled in)', 'breakdown stage 1 (roles)');
  for (const e of Array.isArray(b.environments) ? b.environments : []) if (e && e.name) add(String(e.name), `Environment${e.production ? ' (production)' : ''}${e.url ? ' at ' + e.url : ''}`, 'breakdown stage 1 (environments)');
  if (old === null) {
    writeDocs(home, 'glossary.md', `# Glossary\n\nBusiness terms in plain words. Breakdown seeds it from your answers; later commands add terms found in the code. Edit the meanings freely.\n\n| Term | Meaning | Source |\n|---|---|---|\n${rows.join('\n')}${rows.length ? '\n' : ''}`);
  } else if (rows.length) {
    writeDocs(home, 'glossary.md', old.replace(/\n*$/, '\n') + rows.join('\n') + '\n');
  }
}

function writeIndex(home, system) {
  const d = docsDir(home);
  const st = loadState(home);
  const prof = fs.existsSync(path.join(d, 'profile.md')) ? (st && st.stages && st.stages['2'] && st.stages['2'].status === 'done' ? 'Confirmed' : 'Draft') : 'not written yet (stage 2)';
  const others = (system.repos || []).filter((r) => !r.home);
  const lines = [
    `# ${system.system.name}: docs`,
    '',
    'Start here. tech-plugin writes everything in this folder; the people layer is meant for anyone, the `_map/` facts for developers and later commands.',
    '',
    '| File | What it holds | Status |',
    '|---|---|---|',
    '| `system.yaml` | Repos, your business answers, environments, connectors | stage 1 |',
    `| \`profile.md\` | Stack, entry points and commands for each app | ${prof} |`,
    '| `glossary.md` | Business terms in plain words | seeded in stage 1 |',
  ];
  const s5 = st && st.stages && st.stages['5'];
  if (fs.existsSync(path.join(d, 'modules.yaml'))) lines.push(`| \`modules.yaml\` | The module list: boundaries you approved | ${s5 && s5.approvedBy ? `approved by ${s5.approvedBy}` : 'stage 5'} |`);
  if (fs.existsSync(path.join(d, 'modules', 'README.md'))) lines.push('| `modules/README.md` | Module catalogue and suggested next steps: read this first | stage 6, Draft |');
  if (fs.existsSync(path.join(d, 'system', 'overview.md'))) lines.push('| `system/overview.md` | The whole system on one page, with the module map | stage 6, Draft |');
  if (fs.existsSync(path.join(d, '_map', 'links.md'))) lines.push('| `_map/links.md` | Which screen calls which API; calls with no route; routes nothing calls | stage 4 |');
  lines.push('| `_map/` | Raw facts from scripts. Regenerated; never edit by hand (except `overrides.yaml`, which is yours) | stages 2-4 |', '| `_state/` | Progress of /tech-plugin:breakdown | |');
  if (fs.existsSync(path.join(d, 'config.json'))) lines.push('| `config.json` | Guard settings for this project (blocked hosts, secret patterns, branches) | yours |');
  if (others.length) lines.push('', `Other repos in this system: ${others.map((r) => `${r.name} (\`${r.path}/${DOCS}\`)`).join(', ')}.`);
  writeDocs(home, 'README.md', lines.join('\n') + '\n');
}

// ------------------------------------------------------------------ stage 2: profile

const slug = (root) => (root === '.' ? 'root' : root.replace(/[\\/]/g, '-'));
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

function loadRepos(home) {
  const st = loadState(home);
  if (!st) fail(`no progress file in ${home}; run stage 1 first`);
  return {
    st,
    repos: (st.repos || []).map((r) => {
      const abs = path.resolve(home, r.path);
      const stack = readJson(path.join(docsDir(abs), '_map', r.name, 'stack.json'));
      return { ...r, abs, stack };
    }),
  };
}

function appSection(r, app, corrections) {
  const cite = (e) => (e ? `${r.name}:${e}` : '');
  const L = [];
  L.push(`## ${app.id} (${app.kind})`, '');
  if (app.root !== '.') L.push(`Folder: \`${app.root}\` in ${r.name}.`, '');
  if (!app.stack.length) L.push('No known framework found. The facts below come from the generic reader and are **Inferred**.', '');
  L.push('**Stack**', '', '| Part | Kind | Version | Evidence | Class |', '|---|---|---|---|---|');
  if (app.language) L.push(`| ${esc(app.language)} | language |  |  | Verified |`);
  for (const s of app.stack) L.push(`| ${esc(s.name)} | ${s.kind} | ${esc(s.version || '')} | ${esc(cite(s.evidence))} | ${s.class} |`);
  L.push('');
  if (app.workspace) L.push(`Workspace tool: ${app.workspace.tool} (${cite(app.workspace.evidence)}).`, '');
  if (app.platforms.length) L.push(`Platforms: ${app.platforms.join(', ')}.`, '');
  if (app.entryPoints.length) {
    L.push('**Entry points**', '');
    for (const e of app.entryPoints) L.push(`- \`${e.path}\`: ${e.why} (${cite(e.path)})`);
    L.push('');
  }
  if (app.routes.length) L.push(`**Route files:** ${app.routes.map((x) => `\`${x.path}\``).join(', ')}`, '');
  L.push('**Commands** (found, not run: the guard does not run programs in a repo before a work item is approved; tell breakdown when you have run one and it works)', '');
  if (app.commands.length) {
    L.push('| Kind | Command | Where it comes from | Class |', '|---|---|---|---|');
    for (const c of app.commands) L.push(`| ${c.kind} | \`${esc(c.cmd)}\` | ${esc(c.class === 'Verified' ? cite(c.source) : c.source)} | ${c.class} |`);
  } else L.push('None found.');
  L.push('');
  L.push(`**Tests:** ${app.tests.length ? app.tests.map((t) => `${t.tool} (${cite(t.evidence)})`).join('; ') : 'none found'}`, '');
  if (app.database.length) L.push(`**Database:** ${app.database.map((d) => `${d.what}${d.count ? ` (${d.count})` : ''}, ${cite(d.path)} [${d.class}]`).join('; ')}`, '');
  if (app.services.length) L.push(`**External services** (declared dependencies; use not yet confirmed): ${app.services.map((s) => `${s.name} (${cite(s.evidence)})`).join('; ')}`, '');
  if (app.envVars) {
    const vals = Object.entries(app.envVars.safeValues || {}).map(([k, v]) => `${k}=${v}`);
    L.push(`**Environment variables** (names from \`${app.envVars.source}\`; values are never copied${vals.length ? ' except these settings: ' + vals.join(', ') : ''}): ${app.envVars.names.map((n) => `\`${n}\``).join(', ') || 'none'}`, '');
  }
  if (app.notes.length) L.push(`**Notes:** ${app.notes.join('; ')}`, '');
  const notesFile = path.join(docsDir(r.abs), '_map', r.name, `architecture-${slug(app.root)}.md`);
  L.push('**Architecture and conventions**', '');
  L.push(fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8').trim() : '_Not described yet._', '');
  const mine = corrections.filter((c) => c.app === app.id || c.app === r.name);
  if (mine.length) {
    L.push('**Corrections from people** (these override anything above)', '');
    for (const c of mine) L.push(`- ${c.text}${c.by ? ` (${c.by})` : ''}`);
    L.push('');
  }
  return L;
}

function renderProfile(home, { confirmedBy = null } = {}) {
  const { st, repos } = loadRepos(home);
  const missing = repos.filter((r) => !r.stack);
  if (missing.length) fail(`no stack facts yet for: ${missing.map((r) => r.name).join(', ')} (run detect.mjs --write for each repo)`);
  const corrections = readJson(path.join(docsDir(home), '_state', 'profile-corrections.json')) || [];
  const date = today();
  const status = confirmedBy ? `Confirmed in chat by ${confirmedBy} on ${date}` : 'Draft, waiting for your confirmation';
  const L = [];
  L.push('# Project profile', '');
  L.push(`> **Status:** ${status}  `);
  L.push(`> **Written by:** /tech-plugin:breakdown stage 2 on ${date}  `);
  L.push(`> **Commits:** ${repos.map((r) => `${r.name} ${r.stack.commit ? r.stack.commit.slice(0, 7) : '(no commits)'}`).join(' · ')}`, '');
  L.push('How to read this: **Verified** facts were read from a file, cited as `repo:path:line`. **Inferred** facts follow the usual convention of the stack and were not seen in a file. Commands were found, not run.', '');
  L.push('## Apps at a glance', '', '| App | Repo | Kind | Main stack | Language |', '|---|---|---|---|---|');
  for (const r of repos) {
    if (r.stack.empty) L.push(`| ${r.name} | ${r.name} | empty | no code yet | |`);
    for (const a of r.stack.apps) {
      const main = a.stack.filter((s) => ['backend', 'web', 'mobile', 'desktop'].includes(s.kind)).map((s) => s.name).join(', ');
      L.push(`| ${esc(a.id)} | ${r.name} | ${a.kind} | ${esc(main || '(none recognised)')} | ${esc(a.language || '')} |`);
    }
  }
  L.push('');
  for (const r of repos) {
    if (r.stack.empty) {
      L.push(`## ${r.name}: no code yet`, '', 'No stack detected. For a new project, a later command (`requirement`) proposes stack options and records the choice.', '');
      continue;
    }
    for (const a of r.stack.apps) L.push(...appSection(r, a, corrections));
  }
  L.push('## Repo facts', '', '| Repo | Branch | Commit | Tracked files | Languages | CI | Docker |', '|---|---|---|---|---|---|---|');
  for (const r of repos) {
    const s = r.stack;
    L.push(`| ${r.name} | ${esc(s.branch || '')} | ${s.commit ? s.commit.slice(0, 7) : ''} | ${s.files.count} | ${esc(s.languages.slice(0, 4).map((l) => `${l.name} ${l.files}`).join(', '))} | ${esc([...new Set(s.ci.map((c) => c.system))].join(', ') || 'none')} | ${esc(s.docker.map((d) => (d.services && d.services.length ? `${d.path}: ${d.services.join(', ')}` : d.path)).join('; ') || 'none')} |`);
  }
  L.push('');
  const tracked = repos.filter((r) => r.stack.secretsTracked.length);
  if (tracked.length) {
    L.push('**Secret files committed to git** (names only; the guard never opens them, and they should probably leave git):', '');
    for (const r of tracked) L.push(`- ${r.name}: ${r.stack.secretsTracked.map((f) => `\`${f}\``).join(', ')}`);
    L.push('');
  }
  writeDocs(home, 'profile.md', L.join('\n'));

  // record what this profile was built from, for "already up to date"
  st.repos = (st.repos || []).map((x) => {
    const r = repos.find((y) => y.name === x.name);
    return { ...x, detectedCommit: r.stack.commit, fingerprint: r.stack.fingerprint };
  });
  st.stages = st.stages || {};
  st.stages['2'] = confirmedBy
    ? { status: 'done', at: new Date().toISOString(), confirmedBy, confirmedAt: new Date().toISOString() }
    : { status: 'awaiting-confirmation', at: new Date().toISOString() };
  saveState(home, st);
  writeIndexFromYaml(home);
  return repos;
}

export function writeIndexFromYaml(home) {
  try {
    const system = parseYaml(fs.readFileSync(path.join(docsDir(home), 'system.yaml'), 'utf8'));
    if (system && system.system) writeIndex(home, system);
  } catch {
    /* the index is a convenience; never fail the stage over it */
  }
}

function gitUser(home) {
  const r = spawnSync('git', ['-C', home, 'config', 'user.name'], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

function summary(home) {
  const { repos } = loadRepos(home);
  const L = ['| App | Kind | Stack | Entry points | Commands (found, not run) | Tests | CI |', '|---|---|---|---|---|---|---|'];
  for (const r of repos) {
    if (!r.stack) {
      L.push(`| ${r.name} | ? | not detected yet | | | | |`);
      continue;
    }
    if (r.stack.empty) L.push(`| ${r.name} | empty | no code yet | | | | |`);
    for (const a of r.stack.apps) {
      const main = a.stack.filter((s) => s.kind !== 'test').slice(0, 5).map((s) => (s.version ? `${s.name} ${String(s.version).replace(/^[\^~>=v ]+/, '')}` : s.name)).join(', ');
      const cmds = a.commands.filter((c) => ['run', 'test', 'build'].includes(c.kind)).slice(0, 4).map((c) => `\`${c.cmd}\``).join(', ');
      L.push(`| ${esc(a.id)} | ${a.kind} | ${esc(main)} | ${esc(a.entryPoints.slice(0, 3).map((e) => e.path).join(', '))} | ${esc(cmds)} | ${esc([...new Set(a.tests.map((t) => t.tool))].join(', ') || 'none')} | ${esc([...new Set(r.stack.ci.map((c) => c.system))].join(', ') || 'none')} |`);
    }
  }
  const secrets = repos.filter((r) => r.stack && r.stack.secretsTracked.length).map((r) => `${r.name}: ${r.stack.secretsTracked.length}`);
  if (secrets.length) L.push('', `Secret files committed to git (names only): ${secrets.join(', ')}.`);
  return L.join('\n');
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = parseArgs(rest);
  if (cmd === 'system') {
    if (!a.input) fail('usage: write.mjs system --input FILE');
    return writeSystem(a.input);
  }
  if (!a.home) fail(`usage: write.mjs ${cmd || '<system|profile|confirm|summary>'} --home REPO`);
  const home = real(a.home);
  if (!fs.existsSync(docsDir(home))) fail(`${home} has no sdlc-docs/; run stage 1 first`);
  if (cmd === 'profile') {
    renderProfile(home);
    process.stdout.write(`wrote sdlc-docs/profile.md (Draft)\n${summary(home)}\n`);
    return;
  }
  if (cmd === 'confirm') {
    const who = a.by || gitUser(home) || 'the user';
    renderProfile(home, { confirmedBy: who });
    process.stdout.write(`profile confirmed by ${who}; stage 2 done\n`);
    return;
  }
  if (cmd === 'summary') {
    process.stdout.write(summary(home) + '\n');
    return;
  }
  fail('usage: write.mjs system --input FILE | profile --home REPO | confirm --home REPO [--by NAME] | summary --home REPO');
}

if (process.argv[1] && path.basename(process.argv[1]) === 'write.mjs') main();
