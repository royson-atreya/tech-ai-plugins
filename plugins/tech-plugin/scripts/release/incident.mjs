#!/usr/bin/env node
// /tech-plugin:incident. When production breaks: one folder per incident,
// incidents/<date>-<slug>/:
//   incident.md     what is broken, its impact, the timeline, the analysis
//                   (incident-investigator), the way out (rollback or hotfix)
//   evidence.md     what the person pasted (errors, log lines), keys and
//                   personal data masked
//   postmortem.md   written when it is resolved (ops-writer); blameless
//
//   node incident.mjs new      --input FILE --home HOME [--severity S1..S4]
//         the file's first line "# <what is broken>", then what people see
//   node incident.mjs list     --home HOME
//   node incident.mjs evidence <name> --input FILE --home HOME
//   node incident.mjs suspects <name> --home HOME
//         for incident-investigator: the modules its words point at, the
//         changes to their code since the last release tag (git log, read
//         only), the last releases and their rollback steps
//   node incident.mjs save     <name> --input FILE --home HOME
//         the analysis: "Confidence: High|Medium|Low" and
//         "Way out: Rollback|Hotfix|Rollback, then hotfix|Watch"
//   node incident.mjs hotfix   <name> --home HOME
//         writes the request of a bug work item (/tech-plugin:task) and the
//         branch command from the release tag
//   node incident.mjs link     <name> --work ID --home HOME
//   node incident.mjs resolve  <name> --home HOME     JSON for the postmortem writer
//   node incident.mjs check-postmortem <name> --home HOME
//
// Never connects to production and never deploys or rolls back: a person does.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { joinDoc, splitDoc } from '../lib/frontmatter.mjs';
import { redact, scanText } from '../lib/redact.mjs';
import { pluginUpdate } from '../lib/version.mjs';
import { PLUGIN_ROOT, docsDir, fail, parseArgs, real, today, writeDocs } from '../breakdown/common.mjs';
import { loadState } from '../breakdown/state.mjs';
import { loadExisting } from '../breakdown/modules.mjs';
import { loadSystem } from '../breakdown/load.mjs';
import { moduleFiles, rankModules } from '../work/impact.mjs';
import { releasesDone } from './release.mjs';

const SEVERITIES = ['S1', 'S2', 'S3', 'S4'];
const WAYS = ['Rollback, then hotfix', 'Rollback', 'Hotfix', 'Watch'];
const SCRIPTS = path.join(PLUGIN_ROOT, 'scripts');
const incRel = (name, f = '') => path.join('incidents', name, f);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'incident';
const git = (abs, args) => spawnSync('git', ['-C', abs, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

function readIncident(home, name) {
  const f = path.join(docsDir(home), incRel(name, 'incident.md'));
  if (!/^[\w.-]+$/.test(String(name || '')) || !fs.existsSync(f)) fail(`no incident "${name}" (see incident.mjs list)`);
  const text = fs.readFileSync(f, 'utf8');
  const p = splitDoc(text);
  return { f, text, front: p.front || {}, body: p.body };
}
const saveIncident = (home, name, front, body) => writeDocs(home, incRel(name, 'incident.md'), joinDoc(front, body));

function setSection(body, heading, text) {
  const lines = body.split('\n');
  const i = lines.findIndex((l) => l.trim() === heading);
  if (i === -1) return `${body.replace(/\n*$/, '\n\n')}${heading}\n\n${text.trim()}\n`;
  let j = i + 1;
  while (j < lines.length && !/^## /.test(lines[j])) j++;
  return [...lines.slice(0, i + 1), '', text.trim(), '', ...lines.slice(j)].join('\n');
}

function addTimeline(body, line) {
  const lines = body.split('\n');
  const i = lines.findIndex((l) => l.trim() === '## 3. Timeline');
  if (i === -1) return body;
  let j = i + 1;
  while (j < lines.length && !/^## /.test(lines[j])) j++;
  while (j > i + 1 && !lines[j - 1].trim()) j--;
  lines.splice(j, 0, `- ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC: ${line}`);
  return lines.join('\n');
}

// ------------------------------------------------------------------ new, list, evidence

export function newIncident(home, { input, severity = null }) {
  if (!input || !fs.existsSync(input)) fail('--input FILE is required: "# <what is broken>", then what people see');
  if (severity && !SEVERITIES.includes(severity)) fail(`--severity is ${SEVERITIES.join(', ')} (S1: everyone is stopped … S4: a small annoyance)`);
  const raw = redact(fs.readFileSync(input, 'utf8').replace(/\r\n?/g, '\n'));
  fs.rmSync(input, { force: true });
  const head = /^\s*#\s+(.+)\n/.exec(raw);
  if (!head) fail('the file starts with "# <what is broken>"');
  const title = head[1].trim().slice(0, 120);
  const text = raw.slice(head[0].length).trim();
  let name = `${today()}-${slug(title)}`;
  for (let n = 2; fs.existsSync(path.join(docsDir(home), incRel(name))); n++) name = `${today()}-${slug(title)}-${n}`;
  const ranked = rankModules(home, `${title}\n${text}`).likely.slice(0, 5);
  const front = { incident: name, title, status: 'open', severity: severity || null, started: new Date().toISOString(), resolved: null, modules: ranked.map((r) => r.id), hotfix: [] };
  const body = [`# ${title}`, '', '> **In short**', `> - **Status:** open`, `> - **Severity:** ${severity || 'not set'}`, `> - **Likely parts of the product:** ${ranked.map((r) => r.name).join(', ') || 'not found from the words'}`, '', '## 1. What is broken', '', text || 'Not described yet.', '', '## 2. Who is affected', '', 'Not known yet.', '', '## 3. Timeline', '', `- ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC: incident opened`, '', '## 4. Analysis', '', 'Not done yet: /tech-plugin:incident ' + name, '', '## 5. Way out', '', 'Not decided yet.', ''].join('\n');
  saveIncident(home, name, front, body);
  writeDocs(home, incRel(name, 'evidence.md'), `# Evidence: ${title}\n\nWhat people pasted: errors, log lines, screenshots described. Keys and personal data are masked when saved. Never paste whole production databases or user lists.\n`);
  return { incident: name, title, modules: ranked.map((r) => r.id), file: path.join(docsDir(home), incRel(name, 'incident.md')) };
}

export function listIncidents(home) {
  const d = path.join(docsDir(home), 'incidents');
  if (!fs.existsSync(d)) return { open: [], resolved: [] };
  const all = fs.readdirSync(d).filter((n) => fs.existsSync(path.join(d, n, 'incident.md'))).sort().map((n) => {
    const f = splitDoc(fs.readFileSync(path.join(d, n, 'incident.md'), 'utf8')).front || {};
    return { incident: n, title: f.title, status: f.status, severity: f.severity, started: f.started, resolved: f.resolved, hotfix: f.hotfix || [], postmortem: fs.existsSync(path.join(d, n, 'postmortem.md')) };
  });
  return { open: all.filter((i) => i.status !== 'resolved'), resolved: all.filter((i) => i.status === 'resolved') };
}

export function evidence(home, name, { input }) {
  const inc = readIncident(home, name);
  if (!input || !fs.existsSync(input)) fail('--input FILE is required');
  const raw = fs.readFileSync(input, 'utf8');
  fs.rmSync(input, { force: true });
  const masked = redact(raw);
  const n = (masked.match(/\[REDACTED [^\]]+\]/g) || []).length;
  const f = path.join(docsDir(home), incRel(name, 'evidence.md'));
  writeDocs(home, incRel(name, 'evidence.md'), `${fs.readFileSync(f, 'utf8').replace(/\n*$/, '\n\n')}## ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC\n\n\`\`\`text\n${masked.trim().replace(/```/g, "'''")}\n\`\`\`\n`);
  saveIncident(home, name, inc.front, addTimeline(inc.body, `evidence added${n ? ` (${n} value(s) masked)` : ''}`));
  return { incident: name, masked: n };
}

// ------------------------------------------------------------------ suspects

export function suspects(home, name) {
  const inc = readIncident(home, name);
  const ev = fs.existsSync(path.join(docsDir(home), incRel(name, 'evidence.md'))) ? fs.readFileSync(path.join(docsDir(home), incRel(name, 'evidence.md')), 'utf8') : '';
  const ranked = rankModules(home, `${inc.front.title}\n${inc.body}\n${ev}`).likely.slice(0, 5);
  const mods = [...new Set([...(inc.front.modules || []), ...ranked.map((r) => r.id)])].slice(0, 6);
  const st = loadState(home);
  const repos = new Map(((st && st.repos) || []).map((r) => [r.name, path.resolve(home, r.path)]));
  let files = new Map();
  try {
    files = moduleFiles(loadSystem(home), loadExisting(home));
  } catch {
    /* no code map */
  }
  const byRepo = new Map();
  for (const m of mods) for (const f of files.get(m) || []) {
    const [repo, p] = [f.slice(0, f.indexOf(':')), f.slice(f.indexOf(':') + 1)];
    if (!byRepo.has(repo)) byRepo.set(repo, new Map());
    byRepo.get(repo).set(p, m);
  }
  const commits = [];
  for (const [repo, abs] of repos) {
    const tag = git(abs, ['describe', '--tags', '--abbrev=0']);
    const range = tag.status === 0 ? [`${tag.stdout.trim()}~5..HEAD`] : ['-n', '30'];
    const log = git(abs, ['log', '--no-merges', '--format=@@%h|%ad|%s', '--date=short', '--name-only', ...range]);
    if (log.status !== 0) continue;
    for (const block of log.stdout.split('@@').filter(Boolean)) {
      const [head, ...fl] = block.trim().split('\n');
      const [hash, date, subject] = head.split('|');
      const own = byRepo.get(repo) || new Map();
      const hit = fl.filter((f) => own.has(f));
      commits.push({ repo, commit: hash, date, subject: redact(subject || ''), files: fl.length, touches: [...new Set(hit.map((f) => own.get(f)))], since: tag.status === 0 ? tag.stdout.trim() : null });
    }
  }
  const rel = releasesDone(home).sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 3).map((r) => ({ version: r.version, state: r.state, date: r.date, items: (r.items || []).map((i) => i.id), runbook: path.join(docsDir(home), 'releases', r.version, 'runbook.md') }));
  return {
    incident: name,
    title: inc.front.title,
    modules: mods.map((m) => ({ id: m, facts: path.join(docsDir(home), 'modules', m, '_facts.md'), card: path.join(docsDir(home), 'modules', m, 'module.md') })),
    commits: commits.filter((c) => c.touches.length).concat(commits.filter((c) => !c.touches.length).slice(0, 10)),
    releases: rel,
    file: inc.f,
    evidence: path.join(docsDir(home), incRel(name, 'evidence.md')),
    rules: path.join(PLUGIN_ROOT, 'references', 'release', 'ops-rules.md'),
  };
}

// ------------------------------------------------------------------ analysis and the way out

export function save(home, name, { input }) {
  const inc = readIncident(home, name);
  if (!input || !fs.existsSync(input)) fail('--input FILE is required: the analysis');
  const raw = fs.readFileSync(input, 'utf8');
  const conf = /^\**Confidence:?\**:?\s*(High|Medium|Low)\b/im.exec(raw);
  const way = new RegExp(`^\\**Way out:?\\**:?\\s*(${WAYS.map((w) => w.replace(/,/g, ',')).join('|')})\\b`, 'im').exec(raw);
  const bad = [];
  if (!conf) bad.push('a line "Confidence: High | Medium | Low"');
  if (!way) bad.push(`a line "Way out: ${WAYS.join(' | ')}"`);
  if (!/`[^`]+:[^`]+`/.test(raw)) bad.push('evidence: at least one `repo:path:line` or a commit');
  const risks = scanText(raw);
  if (risks.length) bad.push(`no keys or personal data (found ${risks.map((r) => r.type).join(', ')}, value not shown)`);
  if (bad.length) fail(`not saved; the analysis needs:\n  - ${bad.join('\n  - ')}`);
  fs.rmSync(input, { force: true });
  let body = setSection(inc.body, '## 4. Analysis', raw);
  body = setSection(body, '## 5. Way out', `${way[1]}. ${way[1].startsWith('Rollback') ? 'Roll back with the rollback steps of the last release\'s runbook; a person runs them. ' : ''}${/hotfix/i.test(way[1]) ? `A hotfix is a bug work item: /tech-plugin:incident ${name} makes its request.` : ''}`);
  body = addTimeline(body, `analysis: ${way[1].toLowerCase()} (confidence ${conf[1].toLowerCase()})`);
  saveIncident(home, name, inc.front, body);
  return { incident: name, confidence: conf[1], way: way[1] };
}

export function hotfix(home, name) {
  const inc = readIncident(home, name);
  const an = (/## 4\. Analysis\n([\s\S]*?)(?=\n## )/.exec(inc.body) || ['', ''])[1].trim();
  writeDocs(home, path.join('_state', 'request-in.md'), `# Hotfix: ${inc.front.title}\n\nIncident ${name}.\n\n${(/## 1\. What is broken\n([\s\S]*?)(?=\n## )/.exec(inc.body) || ['', ''])[1].trim()}\n\nAnalysis:\n\n${an}\n`);
  const last = releasesDone(home).filter((r) => r.state === 'released').sort((a, b) => String(b.finished || b.date).localeCompare(String(a.finished || a.date)))[0];
  return { incident: name, request: path.join(docsDir(home), '_state', 'request-in.md'), branchFrom: last ? `v${last.version}` : null, message: last ? `Build the hotfix on a branch from the release tag: git switch -c hotfix/<ID> v${last.version} (you run it, in each repo the plan changes).` : 'No release is recorded: branch the hotfix from what is in production.' };
}

export function link(home, name, { work }) {
  const inc = readIncident(home, name);
  if (!work) fail('--work ID is required');
  const front = { ...inc.front, hotfix: [...new Set([...(inc.front.hotfix || []), work])] };
  saveIncident(home, name, front, addTimeline(inc.body, `hotfix work item ${work} started`));
  return { incident: name, hotfix: front.hotfix };
}

// ------------------------------------------------------------------ resolve and postmortem

export function resolve(home, name) {
  const inc = readIncident(home, name);
  const front = { ...inc.front, status: 'resolved', resolved: inc.front.resolved || new Date().toISOString() };
  let body = inc.body.replace(/^> - \*\*Status:\*\* .*$/m, '> - **Status:** resolved');
  if (inc.front.status !== 'resolved') body = addTimeline(body, 'resolved');
  saveIncident(home, name, front, body);
  const D = docsDir(home);
  const out = path.join(D, incRel(name, 'postmortem.md'));
  return {
    incident: name,
    out,
    template: path.join(PLUGIN_ROOT, 'references', 'release', 'postmortem-template.md'),
    rules: [path.join(PLUGIN_ROOT, 'references', 'document', 'writing-rules.md'), path.join(PLUGIN_ROOT, 'references', 'release', 'ops-rules.md')],
    inputs: { incident: inc.f, evidence: path.join(D, incRel(name, 'evidence.md')), hotfix: (front.hotfix || []).map((w) => path.join(D, 'work', w, 'handoff.md')).filter((f) => fs.existsSync(f)) },
    checks: [`node "${path.join(SCRIPTS, 'release', 'incident.mjs')}" check-postmortem ${name} --home "${home}"`, `node "${path.join(SCRIPTS, 'document', 'plain.mjs')}" "${out}" --home "${home}"`],
  };
}

export function checkPostmortem(home, name) {
  readIncident(home, name);
  const R = [];
  const add = (level, n, d = []) => R.push({ level, name: n, details: d });
  const f = path.join(docsDir(home), incRel(name, 'postmortem.md'));
  if (!fs.existsSync(f)) return [{ level: 'FAIL', name: 'postmortem.md written', details: [f] }];
  const text = fs.readFileSync(f, 'utf8');
  const want = fs.readFileSync(path.join(PLUGIN_ROOT, 'references', 'release', 'postmortem-template.md'), 'utf8').split('\n').filter((l) => /^## /.test(l)).map((l) => l.trim());
  const got = text.split('\n').filter((l) => /^## /.test(l)).map((l) => l.trim());
  const same = want.length === got.length && want.every((w, i) => w === got[i]);
  add(same ? 'PASS' : 'FAIL', 'headings match the postmortem template', same ? [] : want.filter((w) => !got.includes(w)).map((w) => `missing: ${w}`));
  const tl = (/## 2\. Timeline\n([\s\S]*?)(?=\n## )/.exec(text) || ['', ''])[1];
  add((tl.match(/^- /gm) || []).length >= 2 ? 'PASS' : 'FAIL', 'a timeline with at least two entries');
  const act = (/## 6\. Actions\n([\s\S]*?)(?=\n## |$)/.exec(text) || ['', ''])[1];
  const rows = act.split('\n').filter((l) => /^\|/.test(l.trim()) && !/^\|\s*-/.test(l.trim()) && !/^\|\s*Action\s*\|/i.test(l.trim()));
  const badRows = rows.filter((r) => r.split('|').length < 4 || !/\b(owner|po|ba|developer|dev|tech lead|qa|ops|devops|designer|support)\b/i.test(r)).map((r) => `${r.trim().slice(0, 60)}: give the action a role, not a person's name`);
  add(rows.length && !badRows.length ? 'PASS' : 'FAIL', `actions, each with a role (${rows.length})`, rows.length ? badRows : ['no actions: add at least one thing to change so it does not happen again']);
  const blame = /\b(fault of|blame[ds]?|careless|should have known|incompetent)\b/i.exec(text);
  add(blame ? 'FAIL' : 'PASS', 'blameless: about what happened, not who', blame ? [`"${blame[0]}"`] : []);
  const risks = scanText(text);
  add(risks.length ? 'FAIL' : 'PASS', 'no key-like strings and no personal data', risks.map((r) => `line ${r.line}: ${r.type} (value not shown)`));
  return R;
}

// ------------------------------------------------------------------ main

function main() {
  const [cmd] = process.argv.slice(2);
  const a = parseArgs(process.argv.slice(3));
  const usage = 'usage: incident.mjs <new|list|evidence|suspects|save|hotfix|link|resolve|check-postmortem> [name] --home HOME';
  if (!a.home) fail(usage);
  const home = real(a.home);
  if (!fs.existsSync(docsDir(home))) fail(`${home} has no sdlc-docs/; run /tech-plugin:breakdown first`);
  const out = (v) => process.stdout.write(JSON.stringify(v, null, 2) + '\n');
  const name = a._[0];
  if (cmd === 'list') return out(listIncidents(home));
  if (cmd === 'check-postmortem') {
    const R = checkPostmortem(home, name);
    const L = [];
    for (const r of R) {
      L.push(`${r.level.padEnd(5)} ${r.name}`);
      for (const d of r.details) L.push(`        ${d}`);
    }
    const fails = R.filter((r) => r.level === 'FAIL').length;
    L.push(fails ? `check-postmortem: ${fails} check(s) failed` : 'check-postmortem: PASS');
    process.stdout.write(L.join('\n') + '\n');
    process.exitCode = fails ? 1 : 0;
    return;
  }
  const upd = pluginUpdate(PLUGIN_ROOT);
  if (upd) fail(upd.message);
  if (cmd === 'new') return out(newIncident(home, { input: a.input ? real(a.input) : null, severity: a.severity || null }));
  if (cmd === 'evidence') return out(evidence(home, name, { input: a.input ? real(a.input) : null }));
  if (cmd === 'suspects') return out(suspects(home, name));
  if (cmd === 'save') return out(save(home, name, { input: a.input ? real(a.input) : null }));
  if (cmd === 'hotfix') return out(hotfix(home, name));
  if (cmd === 'link') return out(link(home, name, { work: a.work || null }));
  if (cmd === 'resolve') return out(resolve(home, name));
  fail(usage);
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) main();
