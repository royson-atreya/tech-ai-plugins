#!/usr/bin/env node
// /tech-plugin:validate records: check reports, decisions and sign-offs.
//
//   node signoff.mjs save-check  <module> <doc> --input FILE --home HOME
//        saves a doc-checker report as modules/<id>/checks/<doc>-check-<n>.md,
//        stamped with the text it checked (hash) and its counts
//   node signoff.mjs save-review <module> <doc> --input FILE --home HOME
//        saves the readability review as checks/<doc>-readability.md
//   node signoff.mjs decide <module> --doc D --q Q3 --answer TEXT --by NAME --role ROLE --home HOME
//        records a person's decision on an open question in checks/decisions.md
//   node signoff.mjs approve <module> <doc> --layer people|technical --by NAME --role ROLE --home HOME
//        records a sign-off, after the checks pass. people layer: owner, PO or BA;
//        technical layer: developer. Draft -> Reviewed (people) -> Approved (both;
//        a critical module also needs a decision on every open question)
//   node signoff.mjs checklist <module> --home HOME     writes checks/review-checklist.md
//   node signoff.mjs sync <module> --home HOME          sets doc_status in modules.yaml
//   node signoff.mjs status <module> --home HOME        JSON per document
//
// WHY the hash: a sign-off and a check report apply to one exact text. When
// the document changes afterwards, they no longer count.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bodyHash, joinDoc, splitDoc } from '../lib/frontmatter.mjs';
import { docsDir, fail, parseArgs, real, today, writeDocs } from '../breakdown/common.mjs';
import { DOCS_ORDER, decisionsRel, docRel, isDeep, moduleOf } from './doc.mjs';
import { checkDoc } from './check-doc.mjs';
import { plainCheck } from './plain.mjs';

const PEOPLE_ROLES = /^(owner|product owner|po|ba|business analyst)$/i;
const TECH_ROLES = /^(developer|dev|tech lead|engineer|architect)$/i;
const checksDir = (id) => path.join('modules', id, 'checks');

function readDoc(home, id, doc) {
  const f = path.join(docsDir(home), docRel(id, doc));
  if (!fs.existsSync(f)) return null;
  const text = fs.readFileSync(f, 'utf8');
  const p = splitDoc(text);
  return { f, text, front: p.front || {}, body: p.body, hash: bodyHash(p.body) };
}

function questions(body) {
  return [...body.matchAll(/^- \*\*Q(\d+)\*\*\s*\((?:for\s+)?([^)]+)\):\s*(.+)$/gm)].map((m) => ({ q: `Q${m[1]}`, role: m[2].trim(), text: m[3].trim() }));
}

// ------------------------------------------------------------------ reports

function counts(text) {
  const n = (re) => {
    const m = re.exec(text);
    return m ? Number(m[1]) : null;
  };
  return {
    claims: n(/(\d+)\s+claims?/i),
    verified: n(/(\d+)\s+verified/i),
    mismatch: n(/(\d+)\s+mismatch/i),
    notProvable: n(/(\d+)\s+not provable/i),
    risk: n(/(\d+)\s+(?:secret|personal|risk)/i),
  };
}

export function listChecks(home, id, doc) {
  const d = path.join(docsDir(home), checksDir(id));
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .map((f) => /^(\w+)-check-(\d+)\.md$/.exec(f))
    .filter((m) => m && m[1] === doc)
    .map((m) => {
      const t = fs.readFileSync(path.join(d, m[0]), 'utf8');
      const h = /^> \*\*Checked text:\*\* `([0-9a-f]+)`/m.exec(t);
      return { n: Number(m[2]), file: path.join(d, m[0]), hash: h ? h[1] : null, ...counts((/^Summary:.*$/m.exec(t) || [''])[0]) };
    })
    .sort((a, b) => a.n - b.n);
}

function saveCheck(home, id, doc, input, checker) {
  const d = readDoc(home, id, doc);
  if (!d) fail(`modules/${id}/${doc}.md does not exist`);
  const raw = fs.readFileSync(input, 'utf8');
  const c = counts((/^Summary:.*$/m.exec(raw) || [''])[0]);
  if (c.mismatch === null || c.notProvable === null) fail('the report has no "Summary: N claims · V verified · M mismatch · P not provable · S risk" line');
  const n = (listChecks(home, id, doc).pop() || { n: 0 }).n + 1;
  const rel = path.join(checksDir(id), `${doc}-check-${n}.md`);
  writeDocs(home, rel, `> **Checked text:** \`${d.hash}\` · **Date:** ${today()} · **Checker:** ${checker || 'doc-checker'} · **Pass:** ${n}\n\n${raw.trim()}\n`);
  fs.rmSync(input, { force: true });
  return { rel, n, ...c, clean: c.mismatch === 0 && c.notProvable === 0 && !c.risk };
}

function saveReview(home, id, doc, input) {
  const d = readDoc(home, id, doc);
  if (!d) fail(`modules/${id}/${doc}.md does not exist`);
  const raw = fs.readFileSync(input, 'utf8');
  const m = /could not follow:\s*(\d+)/i.exec(raw);
  const rel = path.join(checksDir(id), `${doc}-readability.md`);
  writeDocs(home, rel, `> **Reviewed text:** \`${d.hash}\` · **Date:** ${today()} · **Reviewer:** readability-reviewer\n\n${raw.trim()}\n`);
  fs.rmSync(input, { force: true });
  return { rel, unclear: m ? Number(m[1]) : null };
}

// ------------------------------------------------------------------ decisions

export function readDecisions(home, id) {
  const f = path.join(docsDir(home), decisionsRel(id));
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .map((l) => /^\|\s*(D\d+)\s*\|\s*(\w+)\s*\|\s*(Q\d+)\s*\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|/.exec(l))
    .filter(Boolean)
    .map((m) => ({ id: m[1], doc: m[2], q: m[3], question: m[4].trim(), answer: m[5].trim(), by: m[6].trim(), on: m[7].trim() }));
}

function decide(home, id, { doc, q, answer, by, role }) {
  if (!doc || !q || !answer || !by || !role) fail('usage: decide <module> --doc D --q Q3 --answer TEXT --by NAME --role ROLE');
  const d = readDoc(home, id, doc);
  if (!d) fail(`modules/${id}/${doc}.md does not exist`);
  const qq = questions(d.body).find((x) => x.q === q);
  if (!qq) fail(`${q} is not an open question in ${doc}.md`);
  const all = readDecisions(home, id);
  const next = `D${all.length + 1}`;
  const f = path.join(docsDir(home), decisionsRel(id));
  const head = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : `# Decisions: ${id}\n\nAnswers people gave to open questions, recorded by /tech-plugin:validate. The next /tech-plugin:document run cites them as "decision D<n>". Never edit an existing row; add a new decision instead.\n\n| ID | Document | Question | Asked | Answer | Decided by | Date |\n|---|---|---|---|---|---|---|\n`;
  const cell = (s) => String(s).replace(/\|/g, '/').replace(/\n/g, ' ');
  writeDocs(home, decisionsRel(id), head.replace(/\n*$/, '\n') + `| ${next} | ${doc} | ${q} | ${cell(qq.text)} | ${cell(answer)} | ${cell(`${by} (${role})`)} | ${today()} |\n`);
  // both layers already approved and this was the last open decision: Approved
  const st = docState(home, id, doc);
  if (st.people && st.technical && st.status !== 'Approved' && st.openQuestions.every((x) => x.decision)) {
    fs.writeFileSync(d.f, joinDoc({ ...d.front, status: 'Approved' }, d.body));
    syncDocStatus(home, id);
  }
  return next;
}

// ------------------------------------------------------------------ approvals

export function docState(home, id, doc) {
  const d = readDoc(home, id, doc);
  if (!d) return { exists: false };
  const ap = d.front.approvals || {};
  const ok = (x) => !!(x && x.by && x.hash === d.hash);
  const checks = listChecks(home, id, doc);
  const last = checks[checks.length - 1];
  const decisions = readDecisions(home, id).filter((x) => x.doc === doc);
  const qs = questions(d.body);
  return {
    exists: true,
    status: d.front.status || 'Draft',
    hash: d.hash,
    people: ok(ap.people) ? ap.people : null,
    technical: ok(ap.technical) ? ap.technical : null,
    checkerPasses: checks.length,
    lastCheck: last ? { pass: last.n, current: last.hash === d.hash, mismatch: last.mismatch, notProvable: last.notProvable, risk: last.risk } : null,
    readability: fs.existsSync(path.join(docsDir(home), checksDir(id), `${doc}-readability.md`)),
    openQuestions: qs.map((x) => ({ ...x, decision: (decisions.filter((y) => y.q === x.q).pop() || null) })),
  };
}

function approve(home, id, doc, { layer, by, role }) {
  const { m } = moduleOf(home, id);
  if (!['people', 'technical'].includes(layer)) fail('--layer must be people or technical');
  if (!by || !role) fail('--by NAME and --role ROLE are required: record who approved');
  if (layer === 'people' && !PEOPLE_ROLES.test(role)) fail(`the people layer is approved by the owner, PO or BA (a non-technical reader), not "${role}"`);
  if (layer === 'technical' && !TECH_ROLES.test(role)) fail(`the technical layer is approved by a developer, not "${role}"`);
  const d = readDoc(home, id, doc);
  if (!d) fail(`modules/${id}/${doc}.md does not exist`);
  const problems = [];
  const cd = checkDoc(d.f, home).filter((r) => r.level === 'FAIL').map((r) => `check-doc: ${r.name}`);
  const pl = plainCheck(d.f, home).filter((r) => r.level === 'FAIL').map((r) => `plain: ${r.name}`);
  problems.push(...cd, ...pl);
  const st = docState(home, id, doc);
  const deep = isDeep(m);
  if (!st.lastCheck) problems.push('no doc-checker report yet: run the doc-checker first');
  else if (!st.lastCheck.current) problems.push('the document changed after the last doc-checker pass: check it again');
  else if (st.lastCheck.mismatch || st.lastCheck.notProvable || st.lastCheck.risk) problems.push(`the last doc-checker pass found ${st.lastCheck.mismatch} mismatch, ${st.lastCheck.notProvable} not provable, ${st.lastCheck.risk || 0} risk: fix them and check again`);
  if (deep && st.checkerPasses < 2) problems.push('a critical module needs two doc-checker passes');
  if (!st.readability) problems.push('no readability review yet');
  if (layer === 'technical' && !st.people) problems.push('the people layer is approved first (owner or PO), then the technical layer');
  if (problems.length) fail(`not approved: ${doc}.md\n  - ${problems.join('\n  - ')}`);
  const front = { ...d.front, approvals: { ...(d.front.approvals || {}), [layer]: { by, role, on: today(), hash: d.hash } } };
  const after = { ...st, [layer]: front.approvals[layer] };
  const undecided = st.openQuestions.filter((q) => !q.decision);
  if (after.people && after.technical && (!deep || !undecided.length)) front.status = 'Approved';
  else if (after.people) front.status = 'Reviewed';
  fs.writeFileSync(d.f, joinDoc(front, d.body));
  syncDocStatus(home, id);
  return { status: front.status, waiting: deep && after.people && after.technical && undecided.length ? undecided.map((q) => q.q) : [] };
}

// modules.yaml doc_status: none -> draft -> reviewed -> approved
export function syncDocStatus(home, id) {
  const states = DOCS_ORDER.map((doc) => docState(home, id, doc));
  let v = 'none';
  if (states.some((s) => s.exists)) v = 'draft';
  if (states.every((s) => s.exists && ['Reviewed', 'Approved'].includes(s.status) && s.people)) v = 'reviewed';
  if (states.every((s) => s.exists && s.status === 'Approved' && s.people && s.technical)) v = 'approved';
  const f = path.join(docsDir(home), 'modules.yaml');
  const t = fs.readFileSync(f, 'utf8');
  const lines = t.split('\n');
  const i = lines.findIndex((l) => l === `  - id: ${id}` || l === `  - id: "${id}"`);
  if (i === -1) return v;
  for (let k = i + 1; k < lines.length && !/^ {2}- id:/.test(lines[k]) && !/^\S/.test(lines[k]); k++) {
    if (/^ {4}doc_status:/.test(lines[k])) {
      if (lines[k] !== `    doc_status: ${v}`) {
        lines[k] = `    doc_status: ${v}`;
        writeDocs(home, 'modules.yaml', lines.join('\n'));
      }
      break;
    }
  }
  return v;
}

export function checklist(home, id) {
  const { m } = moduleOf(home, id);
  const deep = isDeep(m);
  const L = [`# Review checklist: ${m.name}`, '', `Written by /tech-plugin:validate on ${today()}. ${deep ? '**Critical module** (money, security or clinical): two doc-checker passes, and a decision on every open question before Approved.' : 'Standard module: one doc-checker pass.'}`, ''];
  L.push('| Document | Status | Doc-checker (last pass) | Readability | People layer (owner/PO) | Technical layer (developer) |', '|---|---|---|---|---|---|');
  for (const doc of DOCS_ORDER) {
    const s = docState(home, id, doc);
    if (!s.exists) {
      L.push(`| ${doc} | not written | | | | |`);
      continue;
    }
    const lc = s.lastCheck ? `pass ${s.lastCheck.pass}: ${s.lastCheck.mismatch} mismatch, ${s.lastCheck.notProvable} not provable${s.lastCheck.current ? '' : ' (older text)'}` : 'not run';
    L.push(`| [${doc}](../${doc}.md) | ${s.status} | ${lc} | ${s.readability ? 'done' : 'not run'} | ${s.people ? `${s.people.by} (${s.people.role}), ${s.people.on}` : 'waiting'} | ${s.technical ? `${s.technical.by} (${s.technical.role}), ${s.technical.on}` : 'waiting'} |`);
  }
  L.push('', '## What each reviewer does', '', '- **Owner or PO (people layer):** read everything above "Appendix A". Is it right, and can someone outside the team follow it? Answer the open questions addressed to you.', '- **Developer (technical layer):** check Appendix A and B: do the cited lines show what the statements say? Answer the open questions addressed to you.', '');
  L.push('## Open questions', '');
  let any = false;
  for (const doc of DOCS_ORDER) {
    const s = docState(home, id, doc);
    if (!s.exists || !s.openQuestions.length) continue;
    any = true;
    L.push(`### ${doc}`, '', '| Question | For | Decision |', '|---|---|---|');
    for (const q of s.openQuestions) L.push(`| **${q.q}** ${q.text.replace(/\|/g, '/')} | ${q.role} | ${q.decision ? `${q.decision.id}: ${q.decision.answer.replace(/\|/g, '/')} (${q.decision.by})` : 'waiting'} |`);
    L.push('');
  }
  if (!any) L.push('None.', '');
  writeDocs(home, path.join(checksDir(id), 'review-checklist.md'), L.join('\n'));
  syncDocStatus(home, id);
}

function main() {
  const [cmd, id, third] = process.argv.slice(2);
  const a = parseArgs(process.argv.slice(3));
  if (!a.home || !id) fail('usage: signoff.mjs <save-check|save-review|decide|approve|checklist|sync|status> <module> … --home HOME');
  const home = real(a.home);
  moduleOf(home, id);
  if (cmd === 'save-check') {
    if (!a.input) fail('--input FILE is required');
    const r = saveCheck(home, id, third, real(a.input), a.checker);
    process.stdout.write(`saved ${r.rel}: ${r.mismatch} mismatch, ${r.notProvable} not provable, ${r.risk || 0} risk${r.clean ? ' (clean)' : ''}\n`);
  } else if (cmd === 'save-review') {
    if (!a.input) fail('--input FILE is required');
    const r = saveReview(home, id, third, real(a.input));
    process.stdout.write(`saved ${r.rel}${r.unclear !== null ? `: ${r.unclear} thing(s) a non-technical reader could not follow` : ''}\n`);
  } else if (cmd === 'decide') process.stdout.write(`recorded ${decide(home, id, a)} in modules/${id}/checks/decisions.md\n`);
  else if (cmd === 'approve') {
    const r = approve(home, id, third, a);
    checklist(home, id);
    process.stdout.write(`${third}.md: ${a.layer} layer approved by ${a.by} (${a.role}); status ${r.status}${r.waiting.length ? `; Approved after a decision on ${r.waiting.join(', ')}` : ''}\n`);
  } else if (cmd === 'checklist') {
    checklist(home, id);
    process.stdout.write(`wrote modules/${id}/checks/review-checklist.md\n`);
  } else if (cmd === 'sync') process.stdout.write(`doc_status of ${id}: ${syncDocStatus(home, id)}\n`);
  else if (cmd === 'status') process.stdout.write(JSON.stringify(Object.fromEntries(DOCS_ORDER.map((d) => [d, docState(home, id, d)])), null, 2) + '\n');
  else fail('unknown command');
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) main();
