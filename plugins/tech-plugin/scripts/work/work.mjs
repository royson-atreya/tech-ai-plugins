#!/usr/bin/env node
// Work items: one folder per piece of new work, <home>/sdlc-docs/work/<ID>/,
// for /tech-plugin:impact, /tech-plugin:requirement and /tech-plugin:design.
//
//   node work.mjs new       --request-file F --home HOME [--id ID] [--source zoho|person]
//         creates work/<ID>/request.md and status.json. The file's first line,
//         "# <title>", is the title. ID: the tracker's item number, or the next
//         W-001. The file is read, checked for keys and personal data, and deleted
//         (text goes through files, never through a shell command line)
//   node work.mjs status    <ID> --home HOME     JSON: each document's state, the next step
//   node work.mjs list      --home HOME          JSON: every work item and its next step
//   node work.mjs prepare   <ID> <requirement|design> --home HOME [--modules a,b] [--force]
//         JSON for the writer agents: file, stamp, template, inputs, IDs to keep
//         (the impact is prepared by impact.mjs pack)
//   node work.mjs decide    <ID> --doc D --q Q1 --answer-file F --by NAME --role ROLE --home HOME
//   node work.mjs approve   <ID> <requirement|design> --by NAME --role ROLE --home HOME
//         requirement: owner, PO or BA; design: developer or tech lead
//   node work.mjs level     <ID> <Quick|Standard|Full> --by NAME --home HOME
//   node work.mjs decisions --home HOME          rewrites sdlc-docs/decisions/README.md
//
// Never writes work/.active or an APPROVED file: those belong to /tech-plugin:task
// and to people. Writes only below <home>/sdlc-docs/.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bodyHash, joinDoc, splitDoc } from '../lib/frontmatter.mjs';
import { scanText } from '../lib/redact.mjs';
import { pluginUpdate } from '../lib/version.mjs';
import { PLUGIN_ROOT, docsDir, fail, parseArgs, readJson, real, today, writeDocs } from '../breakdown/common.mjs';
import { loadExisting } from '../breakdown/modules.mjs';
import { status as breakdownStatus } from '../breakdown/state.mjs';
import { DOCS_ORDER, buildFacts, docRel, writeFacts } from '../document/doc.mjs';

export const WORK_DOCS = ['impact', 'requirement', 'design'];
// the documents each one is written from (besides the request)
export const INPUTS = { impact: [], requirement: ['impact'], design: ['impact', 'requirement'] };
export const LEVELS = ['Quick', 'Standard', 'Full'];
export const APPROVERS = {
  requirement: { re: /^(owner|product owner|po|ba|business analyst)$/i, who: 'the owner, PO or BA' },
  design: { re: /^(developer|dev|tech lead|engineer|architect)$/i, who: 'a developer or tech lead' },
};
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
export const workRel = (id, f = '') => path.join('work', id, f);
export const prevWorkRel = (id, doc) => path.join('_state', 'work', id, `${doc}.prev.md`);
const SCRIPTS = path.join(PLUGIN_ROOT, 'scripts');

export const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ------------------------------------------------------------------ items

export function checkId(id) {
  if (!ID_RE.test(String(id || '')) || /\.\.|\.$/.test(id)) fail(`"${String(id).slice(0, 40)}" is not a valid work item ID: letters, digits, ".", "_" and "-", at most 40, starting with a letter or digit`);
  return String(id);
}

export function nextLocalId(home) {
  const d = path.join(docsDir(home), 'work');
  const nums = fs.existsSync(d) ? fs.readdirSync(d).map((f) => /^W-(\d+)$/.exec(f)).filter(Boolean).map((m) => Number(m[1])) : [];
  return `W-${String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3, '0')}`;
}

function requireModules(home) {
  const my = loadExisting(home);
  if (!my || !Array.isArray(my.modules)) fail('no approved modules.yaml yet: run /tech-plugin:breakdown first');
  return my;
}

export function loadItem(home, id) {
  checkId(id);
  const dir = path.join(docsDir(home), workRel(id));
  if (!fs.existsSync(path.join(dir, 'request.md'))) fail(`no work item ${id} (sdlc-docs/work/${id}/request.md is missing): start it with /tech-plugin:impact`);
  const st = readJson(path.join(dir, 'status.json')) || {};
  return { id, dir, ...st };
}

export function newItem(home, { id, requestFile, source = 'person' }) {
  requireModules(home);
  if (!requestFile) fail('usage: new --request-file F --home HOME [--id ID] [--source zoho|person]');
  if (!fs.existsSync(requestFile)) fail(`${requestFile} not found`);
  const raw = fs.readFileSync(requestFile, 'utf8').replace(/\r\n?/g, '\n');
  fs.rmSync(requestFile, { force: true });
  const head = /^\s*#\s+(.+)\n/.exec(raw);
  if (!head) fail('the request file starts with "# <title>": a short title, then the request');
  const title = head[1];
  const text = raw.slice(head[0].length);
  if (!text.trim()) fail('the request is empty: write what is asked under the title');
  // the request may be pasted from a ticket: no keys, no patient data
  const risks = scanText(raw);
  if (risks.length) fail(`not saved: the request holds ${risks.map((r) => `${r.type} (line ${r.line})`).join(', ')}. Remove it and send the request again; values are not shown`);
  const wid = id ? checkId(id) : nextLocalId(home);
  if (fs.existsSync(path.join(docsDir(home), workRel(wid)))) fail(`work item ${wid} already exists: continue it with /tech-plugin:requirement ${wid}, or give another ID`);
  if (!['zoho', 'person'].includes(source)) fail('--source must be zoho or person');
  const oneLine = String(title).replace(/\s+/g, ' ').trim().slice(0, 120);
  writeDocs(home, workRel(wid, 'request.md'), `# ${oneLine}\n\n> **Work item:** ${wid} · **From:** ${source === 'zoho' ? 'Zoho Sprints' : 'a person'} · **Date:** ${today()}\n\n${text.trim()}\n`);
  writeDocs(home, workRel(wid, 'status.json'), JSON.stringify({ schema: 1, id: wid, title: oneLine, source, created: new Date().toISOString(), level: null, levelBy: null, modules: [] }, null, 1) + '\n');
  return refresh(home, wid);
}

// ------------------------------------------------------------------ documents

export function readWorkDoc(home, id, doc) {
  const f = path.join(docsDir(home), workRel(id, `${doc}.md`));
  if (!fs.existsSync(f)) return null;
  const text = fs.readFileSync(f, 'utf8');
  try {
    const p = splitDoc(text);
    return { f, text, front: p.front || {}, body: p.body, hash: bodyHash(p.body) };
  } catch (e) {
    return { f, text, broken: e.message, front: {}, body: text, hash: bodyHash(text) };
  }
}

export function questionsOf(body) {
  return [...String(body).matchAll(/^- \*\*Q(\d+)\*\*\s*\((?:for\s+)?([^)]+)\):\s*(.+)$/gm)].map((m) => ({ q: `Q${m[1]}`, role: m[2].trim(), text: m[3].trim() }));
}

// "> - **Risk:** High" -> "High"
export function inShort(body, key) {
  const m = new RegExp(`^>\\s*-\\s*\\*\\*${reEsc(key)}:\\*\\*\\s*(.+?)\\s*$`, 'm').exec(body);
  return m ? m[1] : null;
}

const requestHash = (home, id) => {
  const f = path.join(docsDir(home), workRel(id, 'request.md'));
  return fs.existsSync(f) ? bodyHash(fs.readFileSync(f, 'utf8')) : null;
};

export function currentInputs(home, id) {
  const out = { request: requestHash(home, id) };
  for (const d of WORK_DOCS) {
    const x = readWorkDoc(home, id, d);
    out[d] = x ? x.hash : null;
  }
  return out;
}

const factsCache = new Map();
export function factsOf(home, modules) {
  const out = {};
  for (const m of modules) {
    const k = `${home}|${m}`;
    if (!factsCache.has(k)) factsCache.set(k, buildFacts(home, m).hash);
    out[m] = factsCache.get(k);
  }
  return out;
}

export function stampFor(home, id, doc, modules) {
  const item = loadItem(home, id);
  const now = currentInputs(home, id);
  const inputs = { request: now.request };
  for (const n of INPUTS[doc]) inputs[n] = now[n];
  return { work: id, doc, title: item.title, status: 'Draft', date: today(), level: item.level || null, modules, facts: factsOf(home, modules), inputs, approval: null };
}

export const stampText = (front) => joinDoc(front, '').trimEnd();

// Whether a document still matches the request, the documents it was written
// from and the code of its modules; and whether its approval is for this text.
export function docState(home, id, doc) {
  const d = readWorkDoc(home, id, doc);
  if (!d) return { exists: false, state: 'missing', reasons: [] };
  if (d.broken) return { exists: true, state: 'broken', reasons: [`the stamp could not be read: ${d.broken}`], status: null };
  const f = d.front;
  const now = currentInputs(home, id);
  const reasons = [];
  const was = f.inputs || {};
  if (was.request !== now.request) reasons.push('the request changed');
  for (const n of INPUTS[doc]) {
    if ((was[n] ?? null) === (now[n] ?? null)) continue;
    reasons.push(!was[n] ? `${n}.md was written since` : !now[n] ? `${n}.md was removed` : `${n}.md changed since it was written`);
  }
  const mods = Array.isArray(f.modules) ? f.modules : [];
  const known = new Set(((loadExisting(home) || {}).modules || []).map((m) => m.id));
  for (const m of mods) {
    if (!known.has(m)) reasons.push(`module ${m} is no longer in modules.yaml`);
    else if ((f.facts || {})[m] !== factsOf(home, [m])[m]) reasons.push(`the code of ${m} changed`);
  }
  const ap = f.approval && f.approval.by ? f.approval : null;
  const qs = questionsOf(d.body);
  const dec = readDecisions(home, id).filter((x) => x.doc === doc);
  return {
    exists: true,
    state: reasons.length ? 'stale' : 'up-to-date',
    reasons,
    status: f.status || 'Draft',
    hash: d.hash,
    modules: mods,
    approved: ap && ap.hash === d.hash ? ap : null,
    changedSinceApproval: !!(ap && ap.hash !== d.hash),
    openQuestions: qs.map((q) => ({ ...q, decision: (dec.find((x) => x.q === q.q) || {}).id || null })),
    ...(doc === 'impact' ? { risk: inShort(d.body, 'Risk'), size: inShort(d.body, 'Size'), level: inShort(d.body, 'Level') } : {}),
  };
}

// ------------------------------------------------------------------ status

export function nextStep(level, s) {
  const { impact, requirement, design } = s;
  if (!impact.exists && !requirement.exists) return 'impact';
  if (!requirement.exists) return 'requirement';
  if (requirement.state !== 'up-to-date') return 'requirement';
  if (!requirement.approved) return 'approve-requirement';
  if (level === 'Quick' && !design.exists) return 'task';
  if (!design.exists || design.state !== 'up-to-date') return 'design';
  if (!design.approved) return 'approve-design';
  return 'task';
}

const NEXT_TEXT = {
  impact: (id) => `/tech-plugin:impact ${id}`,
  requirement: (id) => `/tech-plugin:requirement ${id}`,
  'approve-requirement': (id) => `the owner, PO or BA approves the requirements (/tech-plugin:requirement ${id})`,
  design: (id) => `/tech-plugin:design ${id}`,
  'approve-design': (id) => `a developer or tech lead approves the design (/tech-plugin:design ${id})`,
  task: (id) => `/tech-plugin:task ${id} (build step 8)`,
};

// Recomputes status.json from the documents.
export function refresh(home, id) {
  const item = loadItem(home, id);
  const s = Object.fromEntries(WORK_DOCS.map((d) => [d, docState(home, id, d)]));
  const fromImpact = s.impact.level && LEVELS.includes(s.impact.level) ? s.impact.level : null;
  const level = item.levelBy ? item.level : fromImpact || item.level || null;
  const modules = (s.impact.exists && s.impact.modules.length ? s.impact.modules : null) || (s.requirement.exists && s.requirement.modules.length ? s.requirement.modules : null) || item.modules || [];
  const next = nextStep(level, s);
  const st = {
    schema: 1,
    id,
    title: item.title,
    source: item.source || 'person',
    created: item.created || null,
    level,
    levelBy: item.levelBy || null,
    modules,
    docs: Object.fromEntries(WORK_DOCS.map((d) => [d, s[d].exists ? { status: s[d].status, state: s[d].state, approvedBy: s[d].approved ? `${s[d].approved.by} (${s[d].approved.role})` : null } : null])),
    next,
    updatedAt: new Date().toISOString(),
  };
  writeDocs(home, workRel(id, 'status.json'), JSON.stringify(st, null, 1) + '\n');
  return { ...st, states: s, nextText: NEXT_TEXT[next](id), dir: path.join(docsDir(home), workRel(id)) };
}

function needsBreakdown(home) {
  const upd = pluginUpdate(PLUGIN_ROOT);
  if (upd) return { next: 'restart', message: upd.message };
  const bd = breakdownStatus(home);
  if (bd.next !== 'up-to-date') return { next: 'breakdown', message: `Run /tech-plugin:breakdown first: ${bd.message}` };
  if (!loadExisting(home)) return { next: 'breakdown', message: 'Run /tech-plugin:breakdown first: there is no approved module list.' };
  return null;
}

export function status(home, id) {
  const stop = needsBreakdown(home);
  if (stop) return { id, ...stop };
  const r = refresh(home, id);
  const msg = (d) => {
    const x = r.states[d];
    if (!x.exists) return `${d}: not written`;
    return `${d}: ${x.status}${x.approved ? ` (approved by ${x.approved.by})` : x.changedSinceApproval ? ' (changed since it was approved)' : ''}${x.state === 'stale' ? `; out of date: ${x.reasons.join('; ')}` : ''}`;
  };
  return { ...r, message: `${id} "${r.title}": ${WORK_DOCS.map(msg).join(' · ')}. Next: ${r.nextText}.` };
}

export function list(home) {
  const d = path.join(docsDir(home), 'work');
  const ids = fs.existsSync(d) ? fs.readdirSync(d).filter((f) => ID_RE.test(f) && fs.existsSync(path.join(d, f, 'request.md'))).sort() : [];
  return { items: ids.map((id) => {
    const r = refresh(home, id);
    return { id, title: r.title, level: r.level, modules: r.modules, next: r.next };
  }) };
}

// ------------------------------------------------------------------ prepare

export function idsOf(text, id, kind) {
  return [...new Set([...String(text).matchAll(new RegExp(`^### (${reEsc(id)}-${kind}\\d{2,}):`, 'gm'))].map((m) => m[1]))];
}

export function writerPack(home, id, doc, modules) {
  const D = docsDir(home);
  const out = path.join(D, workRel(id, `${doc}.md`));
  if (fs.existsSync(out)) writeDocs(home, prevWorkRel(id, doc), fs.readFileSync(out, 'utf8'));
  const prev = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  const front = stampFor(home, id, doc, modules);
  const inputs = { request: path.join(D, workRel(id, 'request.md')) };
  for (const n of INPUTS[doc]) if (fs.existsSync(path.join(D, workRel(id, `${n}.md`)))) inputs[n] = path.join(D, workRel(id, `${n}.md`));
  const moduleDocs = {};
  for (const m of modules) {
    writeFacts(home, m);
    moduleDocs[m] = { card: path.join(D, 'modules', m, 'module.md'), facts: path.join(D, 'modules', m, '_facts.md') };
    for (const x of DOCS_ORDER) if (fs.existsSync(path.join(D, docRel(m, x)))) moduleDocs[m][x] = path.join(D, docRel(m, x));
  }
  const keepIds = doc === 'requirement' ? [...idsOf(prev, id, 'R'), ...idsOf(prev, id, 'S')] : doc === 'design' ? idsOf(prev, id, 'D') : [];
  const check = (part) => `node "${path.join(SCRIPTS, 'work', 'check-work.mjs')}" "${out}" --home "${home}"${part ? ` --part ${part}` : ''}`;
  return {
    work: id,
    doc,
    out,
    stamp: stampText(front),
    template: path.join(PLUGIN_ROOT, 'references', 'work', `${doc}-template.md`),
    rules: [path.join(PLUGIN_ROOT, 'references', 'document', 'writing-rules.md'), path.join(PLUGIN_ROOT, 'references', 'work', 'work-rules.md')],
    inputs,
    modules: moduleDocs,
    glossary: path.join(D, 'glossary.md'),
    glossaryTool: path.join(SCRIPTS, 'document', 'glossary.mjs'),
    decisions: readDecisions(home, id),
    idPrefix: `${id}-`,
    keepIds,
    checks: [check(null), `node "${path.join(SCRIPTS, 'document', 'plain.mjs')}" "${out}" --home "${home}"`],
    firstPartCheck: doc === 'requirement' ? check('requirements') : doc === 'design' ? check('architecture') : null,
  };
}

function moduleList(home, given) {
  const known = new Map(requireModules(home).modules.map((m) => [m.id, m]));
  const mods = [...new Set(String(given).split(/[\s,]+/).filter(Boolean))];
  const bad = mods.filter((m) => !known.has(m));
  if (bad.length) fail(`not a module of this system: ${bad.join(', ')}. Use ids from sdlc-docs/modules.yaml`);
  if (!mods.length) fail('name at least one module');
  return mods;
}

export function prepare(home, id, doc, { modules = null, force = false } = {}) {
  if (!['requirement', 'design'].includes(doc)) fail('prepare: requirement or design (the impact is prepared by impact.mjs pack)');
  const stop = needsBreakdown(home);
  if (stop) fail(stop.message);
  const item = refresh(home, id);
  const s = item.states;
  const warn = [];
  if (doc === 'requirement' && !s.impact.exists) warn.push(`there is no impact analysis yet (/tech-plugin:impact ${id}): the requirements will not know the risk and the parts of the product it touches`);
  if (doc === 'design') {
    if (!s.requirement.exists) fail(`write the requirements first: /tech-plugin:requirement ${id}`);
    if (s.requirement.state !== 'up-to-date') fail(`requirement.md is out of date (${s.requirement.reasons.join('; ')}): refresh it with /tech-plugin:requirement ${id} first`);
    if (!s.requirement.approved) warn.push('the requirements are not approved yet: the design may have to change with them');
    if (item.level === 'Quick' && !force) return { work: id, doc, quick: true, message: `${id} is a Quick change: it needs no design. Next: /tech-plugin:task ${id} (build step 8). To write one anyway, run /tech-plugin:design ${id} --force.` };
  }
  const mods = modules ? moduleList(home, modules) : item.modules.length ? item.modules : null;
  if (!mods) fail(`no modules for ${id} yet: run /tech-plugin:impact ${id}, or name them (--modules a,b)`);
  const pack = writerPack(home, id, doc, mods);
  refreshModules(home, id, mods);
  return { ...pack, warn };
}

export function refreshModules(home, id, mods) {
  const item = loadItem(home, id);
  const { dir, ...st } = item;
  writeDocs(home, workRel(id, 'status.json'), JSON.stringify({ ...st, modules: mods }, null, 1) + '\n');
}

// ------------------------------------------------------------------ decisions on open questions

const decisionsRelW = (id) => workRel(id, 'decisions.md');

export function readDecisions(home, id) {
  const f = path.join(docsDir(home), decisionsRelW(id));
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .map((l) => /^\|\s*(D\d+)\s*\|\s*(\w+)\s*\|\s*(Q\d+)\s*\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|/.exec(l))
    .filter(Boolean)
    .map((m) => ({ id: m[1], doc: m[2], q: m[3], question: m[4].trim(), answer: m[5].trim(), by: m[6].trim(), on: m[7].trim() }));
}

export function decide(home, id, { doc, q, answer, answerFile, by, role }) {
  if (answerFile) {
    if (!fs.existsSync(answerFile)) fail(`${answerFile} not found`);
    answer = fs.readFileSync(answerFile, 'utf8').trim();
    fs.rmSync(answerFile, { force: true });
  }
  if (!doc || !q || !answer || !by || !role) fail('usage: decide <ID> --doc D --q Q1 --answer-file F --by NAME --role ROLE --home HOME');
  if (!WORK_DOCS.includes(doc)) fail('--doc must be impact, requirement or design');
  const d = readWorkDoc(home, id, doc);
  if (!d) fail(`work/${id}/${doc}.md does not exist`);
  const qq = questionsOf(d.body).find((x) => x.q === q);
  if (!qq) fail(`${q} is not an open question in ${doc}.md`);
  const risks = scanText(String(answer));
  if (risks.length) fail(`not recorded: the answer holds ${risks.map((r) => r.type).join(', ')} (value not shown)`);
  const all = readDecisions(home, id);
  const next = `D${all.length + 1}`;
  const f = path.join(docsDir(home), decisionsRelW(id));
  const head = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : `# Decisions: ${id}\n\nAnswers people gave to the open questions of this work item. The next rewrite cites them as "decision D<n>". Never edit a row; add a new decision instead.\n\n| ID | Document | Question | Asked | Answer | Decided by | Date |\n|---|---|---|---|---|---|---|\n`;
  const cell = (s) => String(s).replace(/\|/g, '/').replace(/\n/g, ' ');
  writeDocs(home, decisionsRelW(id), head.replace(/\n*$/, '\n') + `| ${next} | ${doc} | ${q} | ${cell(qq.text)} | ${cell(answer)} | ${cell(`${by} (${role})`)} | ${today()} |\n`);
  refresh(home, id);
  return { id: next, open: docState(home, id, doc).openQuestions.filter((x) => !x.decision).map((x) => x.q) };
}

// ------------------------------------------------------------------ approval

export async function approve(home, id, doc, { by, role }) {
  if (!APPROVERS[doc]) fail('approve: requirement or design (an impact informs; it is not approved)');
  if (!by || !role) fail('--by NAME and --role ROLE are required: record who approved');
  if (!APPROVERS[doc].re.test(role)) fail(`the ${doc} is approved by ${APPROVERS[doc].who}, not "${role}"`);
  const d = readWorkDoc(home, id, doc);
  if (!d) fail(`work/${id}/${doc}.md does not exist`);
  const { checkWork } = await import('./check-work.mjs');
  const { plainCheck } = await import('../document/plain.mjs');
  const problems = [...checkWork(d.f, home).filter((r) => r.level === 'FAIL' && r.name !== 'status matches its approval').map((r) => `check-work: ${r.name}${r.details.length ? ` (${r.details.slice(0, 3).join('; ')})` : ''}`), ...plainCheck(d.f, home).filter((r) => r.level === 'FAIL').map((r) => `plain: ${r.name}`)];
  const st = docState(home, id, doc);
  if (st.state !== 'up-to-date') problems.push(`written from older inputs (${st.reasons.join('; ')}): rewrite it first`);
  const open = st.openQuestions.filter((q) => !q.decision);
  if (open.length) problems.push(`open questions without an answer: ${open.map((q) => `${q.q} (for ${q.role})`).join(', ')}. Record each answer first (work.mjs decide), then rewrite the ${doc} with it`);
  if (doc === 'design') {
    const r = docState(home, id, 'requirement');
    if (!r.approved) problems.push('the requirements are approved first');
  }
  if (problems.length) fail(`not approved: ${doc}.md of ${id}\n  - ${problems.join('\n  - ')}`);
  fs.writeFileSync(d.f, joinDoc({ ...d.front, status: 'Approved', approval: { by, role, on: today(), hash: d.hash } }, d.body));
  if (doc === 'design') decisionsIndex(home);
  const r = refresh(home, id);
  return { status: 'Approved', next: r.next, nextText: r.nextText };
}

export function setLevel(home, id, level, { by }) {
  if (!LEVELS.includes(level)) fail(`the level is ${LEVELS.join(', ')}`);
  if (!by) fail('--by NAME is required: record who chose the level');
  const { dir, ...st } = loadItem(home, id);
  writeDocs(home, workRel(id, 'status.json'), JSON.stringify({ ...st, level, levelBy: `${by} (${today()})` }, null, 1) + '\n');
  return refresh(home, id);
}

// ------------------------------------------------------------------ decisions index (ADRs)

export function decisionsIndex(home) {
  const D = docsDir(home);
  const wd = path.join(D, 'work');
  const rows = [];
  for (const id of fs.existsSync(wd) ? fs.readdirSync(wd).filter((f) => ID_RE.test(f)).sort() : []) {
    const d = readWorkDoc(home, id, 'design');
    if (!d || d.broken) continue;
    const accepted = d.front.status === 'Approved' && d.front.approval && d.front.approval.hash === d.hash;
    for (const m of d.body.matchAll(new RegExp(`^### (${reEsc(id)}-D\\d{2,}):\\s*(.+)$`, 'gm'))) {
      rows.push(`| ${m[1]} | ${m[2].replace(/\|/g, '/').trim()} | ${/^Removed\b/i.test(m[2].trim()) ? 'Withdrawn' : accepted ? 'Accepted' : 'Proposed'} | [${id}](../work/${id}/design.md) |`);
    }
  }
  const L = ['# Decisions', '', `Every design decision of every work item, rebuilt by /tech-plugin:design on ${today()}. A decision is Accepted when its design is approved. Read the design for the options and the reasons.`, '', '| Decision | Title | Status | Work item |', '|---|---|---|---|', ...rows, ''];
  if (!rows.length) L.splice(L.length - 1, 0, '', 'No decisions yet.');
  writeDocs(home, path.join('decisions', 'README.md'), L.join('\n'));
  return { decisions: rows.length, file: path.join(D, 'decisions', 'README.md') };
}

// ------------------------------------------------------------------ main

async function main() {
  const [cmd] = process.argv.slice(2);
  const a = parseArgs(process.argv.slice(3), ['force']);
  const usage = 'usage: work.mjs <new|status|list|prepare|decide|approve|level|decisions> … --home HOME';
  if (!a.home) fail(usage);
  const home = real(a.home);
  if (!fs.existsSync(docsDir(home))) fail(`${home} has no sdlc-docs/; run /tech-plugin:breakdown first`);
  const out = (x) => process.stdout.write(JSON.stringify(x, null, 2) + '\n');
  const [id, x] = a._;
  if (cmd === 'new') return out(newItem(home, { id: a.id, requestFile: a['request-file'], source: a.source || 'person' }));
  if (cmd === 'list') return out(list(home));
  if (cmd === 'decisions') return out(decisionsIndex(home));
  if (!id) fail(usage);
  if (cmd === 'status') return out(status(home, id));
  const upd = pluginUpdate(PLUGIN_ROOT);
  if (upd) fail(upd.message);
  if (cmd === 'prepare') return out(prepare(home, id, x, { modules: a.modules || null, force: !!a.force }));
  if (cmd === 'decide') return out(decide(home, id, { doc: a.doc, q: a.q, answer: a.answer, answerFile: a['answer-file'], by: a.by, role: a.role }));
  if (cmd === 'approve') return out(await approve(home, id, x, { by: a.by, role: a.role }));
  if (cmd === 'level') return out(setLevel(home, id, x, { by: a.by }));
  fail(usage);
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) main();
