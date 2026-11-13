#!/usr/bin/env node
// Mechanical checks of a work-item document (impact, requirement, design or plan).
// plain.mjs then checks the wording of the part everyone reads.
//
//   node check-work.mjs <work/ID/doc.md> --home HOME [--part requirements|architecture]
//
//  1. the stamp parses and has every field; an impact is a Draft; Approved
//     only with an approval recorded for this exact text
//  2. the ## headings are exactly the template's, in order
//  3. "In short" has its lines, with allowed values and matching counts
//  4. every open question has a number and a role
//  5. impact: every statement in sections 1-4 carries an [E#] or [Q#] tag;
//     requirement: every gap in section 2 points at a question
//  6. every tag resolves: E# in Appendix A with a source and a class, Q# in
//     the open questions
//  7. IDs. requirement: <ID>-Rnn unique, each with acceptance criteria and a
//     source; module requirements it changes exist; stories <ID>-Snn, each
//     "As a …, I want …, so that …", covering only known requirements, and
//     every requirement covered. design: <ID>-Dnn with context, two or more
//     options, the decision and its consequences; every requirement in the
//     coverage table. No ID of the previous version lost
//  8. every cited repo:path:line exists, is not a secret file, and is not blank
//  9. no key-like strings and no personal data
// 10. written from the current request, documents and code of its modules
// plan: a Draft (APPROVED approves it, never the stamp); steps <ID>-Tnn, each
// with what it covers, its files (`repo:path` (change|new|delete), existing
// unless new, never a secret file), what to do and a check (a command in
// backticks or "by hand: …"; never an install or a git command that changes
// anything); every requirement covered; a bug's first step adds a test and
// section 2 says how to reproduce it, with evidence
// --part requirements: before the stories are written (story checks skipped);
// --part architecture: before the API, data and coverage sections are written.
// Prints PASS / FAIL / WARN lines; exits 1 if any FAIL.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bodyHash, splitDoc } from '../lib/frontmatter.mjs';
import { scanText } from '../lib/redact.mjs';
import { PLUGIN_ROOT, docsDir, fail, parseArgs, real } from '../breakdown/common.mjs';
import { loadExisting } from '../breakdown/modules.mjs';
import { docRel } from '../document/doc.mjs';
import { ROLE_RE, checkCitations, layers } from '../document/check-doc.mjs';
import { LEVELS, WORK_DOCS, docState, idsOf, prevWorkRel, reEsc, readWorkDoc } from './work.mjs';
import { parseSteps } from './build.mjs';
import { isSecretFor } from '../breakdown/common.mjs';
import { loadState } from '../breakdown/state.mjs';

const INSTALL_RE = /\b(npm|pnpm|yarn|bun)\s+(i|install|add|ci|update|upgrade)\b|\bcomposer\s+(install|require|update)\b|\bpip3?\s+install\b|\b(poetry|pipenv|uv)\s+(add|install|sync)\b|\b(flutter|dart)\s+pub\s+(get|add|upgrade)\b|\bpod\s+install\b|\bgem\s+install\b|\bbundle\s+install\b|\bgo\s+(get|mod\s+download)\b|\bcargo\s+(add|install)\b/i;
const GIT_WRITE_RE = /\bgit\s+(?!(diff|status|log|show|grep|blame|ls-files|rev-parse)\b)\w+/i;
const TEST_FILE_RE = /(^|\/)(tests?|spec|specs|__tests__|test_driver|integration_test)\/|[._-](test|spec)\.[a-z]+$|Test\.(php|java|kt)$|_test\.(go|dart|py)$/i;

const CLASSES = ['Verified', 'Inferred', 'Assumption', 'Unknown'];
const SOURCE_RE = /`[^`]+`|request\.md|glossary\.md|system\.yaml|modules\.yaml|decision D\d+|\b(spec|brd|prd|impact|requirement) E\d+|\bBR-\d+|\b[A-Za-z0-9][\w.-]*-[RSD]\d{2,}\b/;
const BOX = {
  impact: ['The change', 'Who notices', 'Risk', 'Size', 'Level', 'Open questions'],
  requirement: ['What it adds', 'Who uses it', 'Requirements', 'Stories', 'Open questions'],
  design: ['Approach', 'Changes', 'Decisions', 'Open questions'],
  plan: ['What changes', 'Steps', 'Repos', 'Risk', 'Open questions'],
};
const ALLOWED = { Risk: ['Low', 'Medium', 'High', 'Critical'], Size: ['S', 'M', 'L', 'XL'], Level: LEVELS };

export function templateHeadings(doc) {
  const t = fs.readFileSync(path.join(PLUGIN_ROOT, 'references', 'work', `${doc}-template.md`), 'utf8');
  return t.split('\n').filter((l) => /^## /.test(l)).map((l) => l.trim());
}

// lines of one "## " section, with their index
function sectionOf(lines, re) {
  const i = lines.findIndex((l) => re.test(l.trim()));
  if (i === -1) return [];
  const out = [];
  for (let k = i + 1; k < lines.length && !/^## /.test(lines[k]); k++) out.push({ n: k, t: lines[k] });
  return out;
}

// "### X: title" blocks of a section: [{ id, title, n, text }]
function blocks(lines, headRe) {
  const out = [];
  lines.forEach((l, i) => {
    const m = headRe.exec(l);
    if (!m) return;
    let j = i + 1;
    while (j < lines.length && !/^#{2,3} /.test(lines[j])) j++;
    out.push({ id: m[1], title: m[2].trim(), n: i, text: lines.slice(i + 1, j).join('\n') });
  });
  return out;
}

const removed = (b) => /^Removed\b/i.test(b.title);

export function checkWork(file, home, { part = null } = {}) {
  const R = [];
  const add = (level, name, details = []) => R.push({ level, name, details });
  const text = fs.readFileSync(file, 'utf8');
  let parts;
  try {
    parts = splitDoc(text);
  } catch (e) {
    add('FAIL', 'the stamp parses', [e.message]);
    return R;
  }
  const front = parts.front;
  if (!front) {
    add('FAIL', 'the stamp parses', ['no --- stamp at the top: copy it from the prepare JSON']);
    return R;
  }
  add('PASS', 'the stamp parses');
  const off = parts.frontLines;
  const at = (k) => `line ${k + 1 + off}`;
  const missing = (front.doc === 'plan' ? ['work', 'doc', 'title', 'status', 'date', 'modules', 'facts', 'inputs', 'kind', 'repos'] : ['work', 'doc', 'title', 'status', 'date', 'modules', 'facts', 'inputs', 'approval']).filter((k) => !(k in front));
  add(missing.length ? 'FAIL' : 'PASS', 'stamp fields present', missing.length ? [`missing: ${missing.join(', ')}`] : []);
  const doc = front.doc;
  const id = String(front.work || '');
  if (![...WORK_DOCS, 'plan'].includes(doc)) {
    add('FAIL', 'stamp doc is impact, requirement, design or plan', [`got: ${doc}`]);
    return R;
  }
  const hash = bodyHash(parts.body);
  const ap = front.approval;
  if (doc === 'plan' && front.status !== 'Draft') add('FAIL', 'a plan is a Draft', ['a person approves a plan with its APPROVED file (/tech-plugin:task prints the command), never in the stamp']);
  else if (doc === 'plan') add('PASS', 'status is Draft');
  else if (!['Draft', 'Approved'].includes(front.status)) add('FAIL', 'status is Draft or Approved', [`got: ${front.status}`]);
  else if (front.status === 'Approved' && doc === 'impact') add('FAIL', 'status matches its approval', ['an impact is never approved: it stays a Draft']);
  else if (front.status === 'Approved' && !(ap && ap.by && ap.hash === hash)) add('FAIL', 'status matches its approval', [ap && ap.by ? 'changed since it was approved: set it back to Draft and approve it again' : 'only work.mjs approve sets Approved']);
  else add('PASS', `status is ${front.status}`);

  // 2. headings
  const want = templateHeadings(doc);
  const got = parts.body.split('\n').filter((l) => /^## /.test(l)).map((l) => l.trim());
  const same = want.length === got.length && want.every((w, i) => w === got[i]);
  add(same ? 'PASS' : 'FAIL', `headings match the ${doc} template (${want.length} sections)`, same ? [] : [...want.filter((w) => !got.includes(w)).map((w) => `missing: ${w}`), ...got.filter((g) => !want.includes(g)).map((g) => `not in template: ${g}`), ...(want.filter((w) => got.includes(w)).join() !== got.filter((g) => want.includes(g)).join() ? ['out of order'] : [])]);

  const { lines, start, end } = layers(parts.body);
  // 4. questions
  const qs = [];
  const qProblems = [];
  for (const { n, t } of sectionOf(lines, /^## \d+\. Open questions$/)) {
    if (!t.trim() || /^none\.?$/i.test(t.trim()) || /^<!--/.test(t.trim())) continue;
    const m = /^- \*\*Q(\d+)\*\*\s*\((?:for\s+)?([^)]+)\):\s*\S/.exec(t);
    if (!m) {
      qProblems.push(`${at(n)}: write questions as "- **Q1** (for PO): …?"`);
      continue;
    }
    const roles = m[2].split(/\s*(?:,|\/|\band\b|\bor\b)\s*/);
    if (!roles.every((r) => ROLE_RE.test(r.trim()))) qProblems.push(`${at(n)}: Q${m[1]} names no known role (${m[2]}): owner, PO, BA, developer, tech lead, QA, designer…`);
    if (qs.includes(Number(m[1]))) qProblems.push(`${at(n)}: Q${m[1]} is defined twice`);
    qs.push(Number(m[1]));
  }

  // IDs (needed for the In short counts)
  const P = reEsc(id);
  const reqs = blocks(lines, new RegExp(`^### (${P}-R\\d{2,}):(.*)$`));
  const stories = blocks(lines, new RegExp(`^### (${P}-S\\d{2,}):(.*)$`));
  const decisions = blocks(lines, new RegExp(`^### (${P}-D\\d{2,}):(.*)$`));
  const steps = doc === 'plan' ? parseSteps(parts.body, id) : [];

  // 3. In short
  const box = [];
  for (let k = start + 1; k < end && (/^>/.test(lines[k]) || !lines[k].trim()); k++) if (/^>/.test(lines[k])) box.push(lines[k]);
  const val = (key) => {
    const m = new RegExp(`\\*\\*${key}:\\*\\*\\s*(.*)$`).exec(box.find((b) => b.includes(`**${key}:**`)) || '');
    return m ? m[1].trim() : null;
  };
  const boxProblems = [];
  if (!box.some((b) => b.includes('**In short**'))) boxProblems.push('missing: **In short**');
  for (const k of BOX[doc]) if (val(k) === null || /^<.*>$/.test(val(k))) boxProblems.push(`missing: **${k}:**`);
  for (const [k, allowed] of Object.entries(ALLOWED)) if (BOX[doc].includes(k) && val(k) !== null && !allowed.includes(val(k))) boxProblems.push(`${k} is "${val(k)}": write one of ${allowed.join(', ')}`);
  const count = (k, n) => {
    if (val(k) !== null && Number(val(k)) !== n) boxProblems.push(`In short says ${k} ${val(k)}, the document has ${n}`);
  };
  count('Open questions', qs.length);
  if (doc === 'requirement') {
    count('Requirements', reqs.filter((b) => !removed(b)).length);
    if (part !== 'requirements') count('Stories', stories.filter((b) => !removed(b)).length);
  }
  if (doc === 'design') count('Decisions', decisions.filter((b) => !removed(b)).length);
  if (doc === 'plan') count('Steps', steps.filter((s) => !s.removed).length);
  add(boxProblems.length ? 'FAIL' : 'PASS', `"In short" box complete (${qs.length} open questions)`, boxProblems);
  add(qProblems.length ? 'FAIL' : 'PASS', 'every open question has a number and a role', qProblems);

  // 5. tags where the template asks for them
  const untagged = [];
  const skip = (t, k) => !t || /^>/.test(t) || /^#{1,6} /.test(t) || /^<!--/.test(t) || /^\|?\s*:?-{3,}/.test(t) || /^none\.?$/i.test(t) || /^\*\*[^*]+\*\*:?$/.test(t) || (/^\|/.test(t) && lines[k + 1] && /^\|?\s*:?-{3,}/.test(lines[k + 1].trim()));
  if (doc === 'impact') {
    for (const re of [/^## 1\. /, /^## 2\. /, /^## 3\. /, /^## 4\. /]) {
      for (const { n, t } of sectionOf(lines, re)) if (!skip(t.trim(), n) && !/\[(E|Q)\d+\]/.test(t)) untagged.push(`${at(n)}: ${t.trim().slice(0, 80)}`);
    }
    add(untagged.length ? 'FAIL' : 'PASS', 'every statement about the product today has an [E#] or [Q#] tag', untagged.slice(0, 15));
    const rows = sectionOf(lines, /^## 2\. /).filter(({ t }) => /^\|/.test(t.trim()) && !/^\|?\s*:?-{3,}/.test(t.trim()) && !/^\|\s*Part of the product\s*\|/i.test(t.trim()));
    add(rows.length ? 'PASS' : 'FAIL', `${rows.length} part(s) of the product listed`, rows.length ? [] : ['section 2 needs one table row per part of the product the change reaches']);
  }
  if (doc === 'requirement') {
    for (const { n, t } of sectionOf(lines, /^## 2\. What is unclear$/)) if (!skip(t.trim(), n) && !/\[Q\d+\]/.test(t)) untagged.push(`${at(n)}: ${t.trim().slice(0, 80)}`);
    add(untagged.length ? 'FAIL' : 'PASS', 'every gap points at the question that settles it ([Q#])', untagged);
  }

  // 6. tags resolve
  const appA = sectionOf(lines, /^## Appendix A\. Evidence$/);
  const defs = new Map();
  const defProblems = [];
  for (const { n, t } of appA) {
    if (!/^\|\s*E\d+\s*\|/.test(t)) continue;
    const [eid, , source, cls] = t.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
    if (defs.has(eid)) defProblems.push(`${at(n)}: ${eid} is defined twice`);
    defs.set(eid, { source, cls });
    if (!CLASSES.includes(cls)) defProblems.push(`${at(n)}: ${eid} class "${cls}" is not one of ${CLASSES.join(', ')}`);
    else if ((cls === 'Verified' || cls === 'Inferred') && !SOURCE_RE.test(source || '')) defProblems.push(`${at(n)}: ${eid} is ${cls} but has no source`);
    else if ((cls === 'Assumption' || cls === 'Unknown') && !/\bQ\d+\b/.test(source || '')) defProblems.push(`${at(n)}: ${eid} is ${cls}: its source must be the question that asks about it (Q#)`);
  }
  const usedE = new Set();
  const usedQ = new Set();
  lines.forEach((l, k) => {
    if (appA.some((x) => x.n === k)) return;
    for (const m of l.matchAll(/\[(E|Q)(\d+)\]/g)) (m[1] === 'E' ? usedE : usedQ).add(`${m[1]}${m[2]}`);
  });
  for (const d of defs.values()) for (const m of (d.source || '').matchAll(/\bQ(\d+)\b/g)) usedQ.add(`Q${m[1]}`);
  const tagProblems = [...defProblems, ...[...usedE].filter((e) => !defs.has(e)).map((e) => `${e} is used but not in Appendix A`), ...[...usedQ].filter((q) => !qs.includes(Number(q.slice(1)))).map((q) => `${q} is used but not in Open questions`)];
  add(tagProblems.length ? 'FAIL' : 'PASS', `every tag resolves (${defs.size} evidence rows, ${qs.length} questions)`, tagProblems.slice(0, 20));
  const unused = [...defs.keys()].filter((e) => !usedE.has(e));
  if (unused.length) add('WARN', 'evidence rows no statement uses', [unused.join(', ')]);

  // 7. IDs
  const dup = (list) => list.map((b) => b.id).filter((x, i, a) => a.indexOf(x) !== i);
  if (doc === 'requirement') {
    const bad = [];
    const my = loadExisting(home) || { modules: [] };
    const modIds = new Map(my.modules.map((m) => [m.id.toUpperCase(), m.id]));
    const refProblems = [];
    const refWarn = [];
    for (const b of reqs) {
      if (removed(b)) continue;
      if (!/\*\*Acceptance criteria\*\*/.test(b.text) || !/^- (Given|When)\b/im.test(b.text)) bad.push(`${b.id}: needs **Acceptance criteria** with Given/when/then lines`);
      if (!/\*\*Source:\*\*.*\[(E|Q)\d+\]/.test(b.text)) bad.push(`${b.id}: needs a **Source:** line with tags`);
      if (!/\*\*Changes:\*\*\s*\S/.test(b.text)) bad.push(`${b.id}: needs a **Changes:** line (new, or the module requirement it changes)`);
      const ch = (/\*\*Changes:\*\*(.*)$/m.exec(b.text) || ['', ''])[1];
      for (const m of ch.matchAll(/\b([A-Z][A-Z0-9-]*?)-R\d{2,}\b/g)) {
        const mod = modIds.get(m[1]);
        if (!mod) {
          refProblems.push(`${b.id}: ${m[0]}: there is no module "${m[1].toLowerCase()}"`);
          continue;
        }
        const f = path.join(docsDir(home), docRel(mod, 'prd'));
        if (!fs.existsSync(f)) refWarn.push(`${b.id}: ${m[0]}: ${mod} has no PRD yet, so it cannot be checked`);
        else if (!new RegExp(`^### ${reEsc(m[0])}:`, 'm').test(fs.readFileSync(f, 'utf8'))) refProblems.push(`${b.id}: ${m[0]} is not in modules/${mod}/prd.md`);
      }
    }
    if (!reqs.length) add('FAIL', `requirements ${id}-Rnn present`, [`no "### ${id}-R01: …" headings`]);
    else add(dup(reqs).length || bad.length ? 'FAIL' : 'PASS', `${reqs.length} requirement(s) ${id}-Rnn: unique, each with acceptance criteria, a source and what it changes`, [...dup(reqs).map((d) => `${d} is defined twice`), ...bad]);
    add(refProblems.length ? 'FAIL' : 'PASS', 'the module requirements it changes exist', refProblems);
    if (refWarn.length) add('WARN', 'module requirements checked', refWarn);
    if (part !== 'requirements') {
      const ids = new Set(reqs.map((b) => b.id));
      const covered = new Set();
      const sBad = [];
      for (const b of stories) {
        if (removed(b)) continue;
        if (!/^As an? .+, I want .+, so that .+/im.test(b.text)) sBad.push(`${b.id}: write it as "As a <role>, I want <something>, so that <a reason>."`);
        const cov = [...((/\*\*Covers:\*\*(.*)$/m.exec(b.text) || ['', ''])[1]).matchAll(new RegExp(`${P}-R\\d{2,}`, 'g'))].map((m) => m[0]);
        if (!cov.length) sBad.push(`${b.id}: needs a **Covers:** line naming its requirements`);
        for (const c of cov) (ids.has(c) ? covered.add(c) : sBad.push(`${b.id}: covers ${c}, which is not a requirement here`));
        if (!/\*\*Acceptance criteria\*\*/.test(b.text) || !/^- (Given|When)\b/im.test(b.text)) sBad.push(`${b.id}: needs **Acceptance criteria** with Given/when/then lines`);
      }
      const open = reqs.filter((b) => !removed(b) && !covered.has(b.id)).map((b) => `${b.id} is covered by no story`);
      if (!stories.length) add('FAIL', `user stories ${id}-Snn present`, [`no "### ${id}-S01: …" headings`]);
      else add(dup(stories).length || sBad.length || open.length ? 'FAIL' : 'PASS', `${stories.length} story(ies): unique, each covering known requirements; every requirement covered`, [...dup(stories).map((d) => `${d} is defined twice`), ...sBad, ...open]);
    }
  }
  if (doc === 'design') {
    const bad = [];
    for (const b of decisions) {
      if (removed(b)) continue;
      for (const k of ['Context', 'Options', 'Decision', 'Consequences']) if (!new RegExp(`\\*\\*${k}:\\*\\*`).test(b.text)) bad.push(`${b.id}: needs **${k}:**`);
      const opts = (/\*\*Options:\*\*([\s\S]*?)(?=\*\*Decision:\*\*|$)/.exec(b.text) || ['', ''])[1];
      if ((opts.match(/^- \S/gm) || []).length < 2) bad.push(`${b.id}: list at least two options under **Options:**`);
    }
    add(dup(decisions).length || bad.length ? 'FAIL' : 'PASS', `${decisions.length} decision(s) ${id}-Dnn: each with context, options, the decision and its consequences`, [...dup(decisions).map((d) => `${d} is defined twice`), ...bad]);
    if (part !== 'architecture') {
      const rq = readWorkDoc(home, id, 'requirement');
      const want = rq ? blocks(rq.body.split('\n'), new RegExp(`^### (${P}-R\\d{2,}):(.*)$`)).filter((b) => !removed(b)).map((b) => b.id) : [];
      const rows = new Map();
      for (const { t } of sectionOf(lines, /^## Appendix E\. Requirement coverage$/)) {
        const m = new RegExp(`^\\|\\s*(${P}-R\\d{2,})\\s*\\|([^|]*)\\|`).exec(t.trim());
        if (m) rows.set(m[1], m[2].trim());
      }
      const cov = [...want.filter((r) => !rows.has(r)).map((r) => `${r} is not in the coverage table`), ...want.filter((r) => rows.has(r) && !rows.get(r)).map((r) => `${r}: say where the design covers it`), ...[...rows.keys()].filter((r) => !want.includes(r)).map((r) => `${r} is not a requirement of ${id}`)];
      if (!rq) add('FAIL', 'every requirement is covered by the design', ['requirement.md is missing']);
      else add(cov.length ? 'FAIL' : 'PASS', `every requirement is covered by the design (${want.length})`, cov);
    }
  }
  if (doc === 'plan') {
    const st = loadState(home);
    const repos = new Map(((st && st.repos) || []).map((r) => [r.name, path.resolve(home, r.path)]));
    const liveSteps = steps.filter((s) => !s.removed);
    const bad = [];
    for (const s of liveSteps) {
      if (!s.covers) bad.push(`${s.id}: needs a **Covers:** line (the requirements it builds, or "the bug")`);
      if (!s.files.length) bad.push(`${s.id}: needs **Files:** with lines like "- \`repo:path/to/file\` (change)"`);
      if (!s.do) bad.push(`${s.id}: needs a **Do:** line saying what to change`);
      if (!s.check) bad.push(`${s.id}: needs a **Check:** line: a command in backticks, or "by hand: …"`);
      else if (!s.command && !s.byHand) bad.push(`${s.id}: the check starts with a command in backticks, or with "by hand:"`);
      if (s.command && INSTALL_RE.test(s.command)) bad.push(`${s.id}: the check installs packages; the guard blocks that. Put the install under "Risks and how to undo it" for the person to run`);
      if (s.command && GIT_WRITE_RE.test(s.command)) bad.push(`${s.id}: the check runs git; a person does every git change`);
      for (const f of s.files) {
        const abs = repos.get(f.repo);
        if (!abs) {
          bad.push(`${s.id}: \`${f.repo}:${f.path}\`: ${f.repo} is not a repo of this system (${[...repos.keys()].join(', ')})`);
          continue;
        }
        if (isSecretFor(abs)(f.path)) bad.push(`${s.id}: \`${f.repo}:${f.path}\` is a secret file: never change it in a plan`);
        const exists = fs.existsSync(path.join(abs, f.path));
        if (f.kind !== 'new' && !exists) bad.push(`${s.id}: \`${f.repo}:${f.path}\` does not exist; mark it "(new)" if the step creates it`);
      }
    }
    if (!liveSteps.length) add('FAIL', `steps ${id}-Tnn present`, [`no "### ${id}-T01: …" headings in Appendix B`]);
    else add(dup(steps).length || bad.length ? 'FAIL' : 'PASS', `${liveSteps.length} step(s) ${id}-Tnn: each with what it covers, its files, what to do and a check`, [...dup(steps).map((d) => `${d} is defined twice`), ...bad]);
    if (front.kind === 'bug') {
      const first = liveSteps[0];
      const bugBad = [];
      if (first && !first.files.some((f) => TEST_FILE_RE.test(f.path))) bugBad.push(`${first.id}: the first step of a bug adds a test that fails because of the bug (a file under tests/ or named *test*/*spec*)`);
      if (first && !first.command) bugBad.push(`${first.id}: its check is the command that runs that test`);
      const cause = sectionOf(lines, /^## 2\. Cause of the bug$/).map((x) => x.t);
      if (!cause.some((l) => /^\s*1\.\s+\S/.test(l))) bugBad.push('section 2: give the steps that show the bug as a numbered list ("1. …")');
      if (!cause.some((l) => /\[E\d+\]/.test(l))) bugBad.push('section 2: the cause carries evidence tags ([E#])');
      add(bugBad.length ? 'FAIL' : 'PASS', 'a bug: how to show it, its cause, and a failing test first', bugBad);
    } else {
      const rq = readWorkDoc(home, id, 'requirement');
      const want = rq ? blocks(rq.body.split('\n'), new RegExp(`^### (${P}-R\\d{2,}):(.*)$`)).filter((b) => !removed(b)).map((b) => b.id) : [];
      const covered = new Set(liveSteps.flatMap((s) => [...String(s.covers || '').matchAll(new RegExp(`${P}-R\\d{2,}`, 'g'))].map((m) => m[0])));
      const cov = [...want.filter((r) => !covered.has(r)).map((r) => `${r} is covered by no step`), ...[...covered].filter((r) => !want.includes(r)).map((r) => `${r} is not a requirement of ${id}`)];
      if (!rq) add('FAIL', 'every requirement is covered by a step', ['requirement.md is missing']);
      else add(cov.length ? 'FAIL' : 'PASS', `every requirement is covered by a step (${want.length})`, cov);
    }
  }
  const prevFile = path.join(docsDir(home), prevWorkRel(id, doc));
  if (fs.existsSync(prevFile) && doc !== 'impact') {
    const prev = fs.readFileSync(prevFile, 'utf8');
    const kinds = doc === 'requirement' ? ['R', 'S'] : doc === 'plan' ? ['T'] : ['D'];
    const lost = kinds.flatMap((k) => idsOf(prev, id, k)).filter((x) => !new RegExp(`^### ${reEsc(x)}:`, 'm').test(parts.body));
    add(lost.length ? 'FAIL' : 'PASS', 'no ID of the previous version lost', lost.map((x) => `${x} is gone: keep it, or mark it "Removed (reason)"`));
  }

  // 8. citations
  // a file a step creates does not exist yet: its line is not a citation
  const cc = checkCitations(doc === 'plan' ? lines.map((l) => (/^\s*-\s*`[^`]+`\s*\(new\)/.test(l) ? '' : l)) : lines, home);
  add(cc.bad.length ? 'FAIL' : 'PASS', `all ${cc.count} code citations exist`, cc.bad.slice(0, 20));

  // 9. secrets and personal data (the stamp holds hashes and is skipped)
  const risks = scanText(text, { skipLines: new Set(Array.from({ length: off }, (_, i) => i + 1)) });
  add(risks.length ? 'FAIL' : 'PASS', 'no key-like strings and no personal data', risks.map((r) => `line ${r.line}: ${r.type} (value not shown)`));

  // 10. freshness
  if (front.work && readWorkDoc(home, id, doc) && real(readWorkDoc(home, id, doc).f) === real(file)) {
    const st = docState(home, id, doc);
    add(st.state === 'up-to-date' ? 'PASS' : 'FAIL', 'written from the current request, documents and code', st.state === 'up-to-date' ? [] : st.reasons);
  } else add('WARN', 'written from the current request, documents and code', [`not checked: the file is not sdlc-docs/work/${id}/${doc}.md`]);
  return R;
}

export function report(R, file) {
  const L = [];
  for (const r of R) {
    L.push(`${r.level.padEnd(5)} ${r.name}`);
    for (const d of r.details) L.push(`        ${d}`);
  }
  const fails = R.filter((r) => r.level === 'FAIL').length;
  L.push(fails ? `check-work: ${fails} check(s) failed (${file})` : `check-work: PASS (${file})`);
  return { text: L.join('\n'), ok: !fails };
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const file = a._[0];
  if (!file || !a.home) fail('usage: check-work.mjs <work/ID/doc.md> --home HOME [--part requirements|architecture]');
  if (!fs.existsSync(file)) fail(`${file} not found`);
  if (a.part && !['requirements', 'architecture'].includes(a.part)) fail('--part is requirements or architecture');
  const r = report(checkWork(real(file), real(a.home), { part: a.part || null }), path.basename(path.dirname(file)) + '/' + path.basename(file));
  process.stdout.write(r.text + '\n');
  process.exitCode = r.ok ? 0 : 1;
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) main();
