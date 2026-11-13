#!/usr/bin/env node
// /tech-plugin:validate records: check reports, decisions and sign-offs.
//
//   node signoff.mjs save-check  <module> <doc> --input FILE --home HOME [--mode full|focused]
//        saves a doc-checker report as modules/<id>/checks/<doc>-check-<n>.md,
//        stamped with the text it checked (hash) and its counts. Refuses past
//        the round's pass limit (3), a focused pass before a full one, and a
//        BRD or PRD pass while a document it is written from is not settled
//   node signoff.mjs known <module> <doc> --home HOME
//        records what the last pass left open as known issues
//        (checks/<doc>-known.md); a developer accepts them at sign-off
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
import { docsDir, fail, parseArgs, readJson, real, today, writeDocs } from '../breakdown/common.mjs';
import { DOCS_ORDER, NEEDS, buildFacts, checkedRel, decisionsRel, docRel, factsRelOf, isDeep, knownRel, moduleOf, readRound } from './doc.mjs';
import { diagRel, diagramState } from '../diagram/diagram.mjs';
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
      const mode = /\*\*Mode:\*\* (focused|full)/.exec(t.split('\n')[0]);
      return { n: Number(m[2]), file: path.join(d, m[0]), hash: h ? h[1] : null, mode: mode ? mode[1] : 'full', ...counts((/^Summary:.*$/m.exec(t) || [''])[0]) };
    })
    .sort((a, b) => a.n - b.n);
}

// the passes of the current round (since the document was last written)
function roundOf(home, id, doc) {
  const r = readRound(home, id, doc);
  const passes = listChecks(home, id, doc).filter((c) => c.n > r.fromPass);
  return { passes: passes.length, full: passes.filter((c) => c.mode === 'full').length, limit: r.limit, startedAt: r.startedAt };
}

function saveCheck(home, id, doc, input, checker, mode = 'full') {
  const { m } = moduleOf(home, id);
  const d = readDoc(home, id, doc);
  if (!d) fail(`modules/${id}/${doc}.md does not exist`);
  if (!['full', 'focused'].includes(mode)) fail('--mode must be full or focused');
  const raw = fs.readFileSync(input, 'utf8');
  const c = counts((/^Summary:.*$/m.exec(raw) || [''])[0]);
  if (c.mismatch === null || c.notProvable === null) fail('the report has no "Summary: N claims · V verified · M mismatch · P not provable · S risk" line');
  // spec first: a BRD or PRD is checked only against settled inputs
  for (const n of NEEDS[doc]) {
    const ns = docState(home, id, n);
    if (!ns.exists) continue;
    if (!d.front.inputs || d.front.inputs[n] !== ns.hash) fail(`not saved: ${doc}.md was written from an older ${n}.md. Refresh it first: doc.mjs changes ${id} ${doc}, the writer updates the lines that depend on the change, then doc.mjs restamp ${id} ${doc}`);
    if (!ns.settled) fail(`not saved: finish ${n}.md first. Its last doc-checker pass must be on its current text, with ${isDeep(m) ? 'two passes this round' : 'one pass'}, and clean (or what is left recorded as known issues)`);
  }
  const r = roundOf(home, id, doc);
  // a document that had settled (clean, or its leftovers recorded) gets one
  // focused pass for each later change, e.g. a fix a BRD check asked for
  const last = listChecks(home, id, doc).pop();
  const known = readKnown(home, id, doc);
  const wasSettled = !!(last && last.hash !== d.hash && !last.risk && (!(last.mismatch || last.notProvable) || (known && known.hash === last.hash)) && r.passes >= (isDeep(m) ? 2 : 1));
  const extra = r.passes >= r.limit && wasSettled && mode === 'focused';
  if (r.passes >= r.limit && wasSettled && mode !== 'focused') fail(`not saved: ${doc}.md had settled; a change after that gets one focused pass (--mode focused) on the changed lines.`);
  if (r.passes >= r.limit && !extra) fail(`not saved: ${doc}.md already has ${r.passes} doc-checker passes this round (the limit is ${r.limit}). Record what the last pass left as known issues (signoff.mjs known ${id} ${doc}); a developer accepts them at sign-off. A rewrite with /tech-plugin:document starts a new round.`);
  if (mode === 'focused' && !r.full) fail('not saved: the first pass of a round reads the whole document. Run a full pass first.');
  const n = (listChecks(home, id, doc).pop() || { n: 0 }).n + 1;
  const rel = path.join(checksDir(id), `${doc}-check-${n}.md`);
  writeDocs(home, rel, `> **Checked text:** \`${d.hash}\` · **Date:** ${today()} · **Checker:** ${checker || 'doc-checker'} · **Pass:** ${n} · **Mode:** ${mode}\n\n${raw.trim()}\n`);
  // the checked text, so the next pass can see what changed
  writeDocs(home, checkedRel(id, doc), d.text);
  fs.rmSync(input, { force: true });
  return { rel, n, ...c, clean: c.mismatch === 0 && c.notProvable === 0 && !c.risk, left: extra ? 0 : r.limit - r.passes - 1 };
}

// ------------------------------------------------------------------ known issues

function reportRows(text, heading) {
  const m = new RegExp(`^## ${heading}\\s*\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(text);
  if (!m) return [];
  return m[1].split('\n').filter((l) => /^\|\s*\d+\s*\|/.test(l));
}

export function readKnown(home, id, doc) {
  const f = path.join(docsDir(home), knownRel(id, doc));
  if (!fs.existsSync(f)) return null;
  const t = fs.readFileSync(f, 'utf8');
  const h = /^> \*\*Known issues for text:\*\* `([0-9a-f]+)`/m.exec(t);
  const items = (/\*\*Items:\*\* (\d+)/.exec(t) || [0, 0])[1];
  return { rel: knownRel(id, doc), hash: h ? h[1] : null, items: Number(items) };
}

function recordKnown(home, id, doc) {
  const { m } = moduleOf(home, id);
  const st = docState(home, id, doc);
  if (!st.exists) fail(`modules/${id}/${doc}.md does not exist`);
  const need = isDeep(m) ? 2 : 1;
  if (!st.lastCheck) fail('no doc-checker pass yet: run one first');
  if (!st.lastCheck.current) fail(`${doc}.md changed after its last doc-checker pass: check the change first`);
  if (st.lastCheck.risk) fail(`the last pass found ${st.lastCheck.risk} risk item(s) (a key or personal data): those are never accepted. Remove them and check again`);
  if (!st.lastCheck.mismatch && !st.lastCheck.notProvable) fail('the last pass is clean: there is nothing to record');
  if (st.round.passes < need) fail(`a ${need === 2 ? 'critical module needs two passes' : 'document needs one pass'} this round before what is left can be recorded`);
  const last = listChecks(home, id, doc).pop();
  const t = fs.readFileSync(last.file, 'utf8');
  const mis = reportRows(t, 'Mismatch');
  const np = reportRows(t, 'Not provable');
  const items = mis.length + np.length || st.lastCheck.mismatch + st.lastCheck.notProvable;
  const L = [
    `> **Known issues for text:** \`${st.hash}\` · **Date:** ${today()} · **From pass:** ${last.n} · **Items:** ${items}`,
    '',
    `# Known issues: ${doc}.md of ${id}`,
    '',
    `What doc-checker pass ${last.n} left open after the last allowed pass. They stay visible here: the reviewers read them before signing off, and the developer who approves the technical layer accepts them. The next /tech-plugin:document run of ${doc} gets this list and fixes them.`,
    '',
    `## Mismatch (${st.lastCheck.mismatch})`,
    '',
    ...(mis.length ? ['| # | Doc line | Claim (short quote) | What the source shows | Source |', '|---|---|---|---|---|', ...mis] : [st.lastCheck.mismatch ? `See ${path.basename(last.file)}.` : 'None.']),
    '',
    `## Not provable (${st.lastCheck.notProvable})`,
    '',
    ...(np.length ? ['| # | Doc line | Claim | Why | Suggested fix |', '|---|---|---|---|---|', ...np] : [st.lastCheck.notProvable ? `See ${path.basename(last.file)}.` : 'None.']),
    '',
  ];
  writeDocs(home, knownRel(id, doc), L.join('\n'));
  return { rel: knownRel(id, doc), items, mismatch: st.lastCheck.mismatch, notProvable: st.lastCheck.notProvable };
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
  const round = roundOf(home, id, doc);
  const k = readKnown(home, id, doc);
  const known = k ? { ...k, current: k.hash === d.hash } : null;
  const rf = path.join(docsDir(home), checksDir(id), `${doc}-readability.md`);
  // a review written before this round started is about an older text
  const readability = fs.existsSync(rf) && (!round.startedAt || fs.statSync(rf).mtimeMs >= Date.parse(round.startedAt));
  const deep = isDeep(moduleOf(home, id).m);
  const lc = last ? { pass: last.n, mode: last.mode, current: last.hash === d.hash, mismatch: last.mismatch, notProvable: last.notProvable, risk: last.risk } : null;
  const clean = !!(lc && lc.current && !lc.mismatch && !lc.notProvable && !lc.risk);
  const settled = !!(lc && lc.current && !lc.risk && (clean || (known && known.current)) && round.passes >= (deep ? 2 : 1) && round.full >= 1);
  return {
    exists: true,
    status: d.front.status || 'Draft',
    hash: d.hash,
    people: ok(ap.people) ? ap.people : null,
    technical: ok(ap.technical) ? ap.technical : null,
    checkerPasses: checks.length,
    round,
    lastCheck: lc,
    known,
    settled,
    readability,
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
  const accepted = !!(st.lastCheck && st.lastCheck.current && !st.lastCheck.risk && (st.lastCheck.mismatch || st.lastCheck.notProvable) && st.known && st.known.current);
  if (!st.lastCheck) problems.push('no doc-checker report yet: run the doc-checker first');
  else if (!st.lastCheck.current) problems.push('the document changed after the last doc-checker pass: check it again');
  else if (st.lastCheck.risk) problems.push(`the last doc-checker pass found ${st.lastCheck.risk} risk item(s): remove them and check again`);
  else if ((st.lastCheck.mismatch || st.lastCheck.notProvable) && !accepted) problems.push(`the last doc-checker pass found ${st.lastCheck.mismatch} mismatch, ${st.lastCheck.notProvable} not provable: fix them and check again, or once the pass limit is reached record them as known issues (signoff.mjs known)`);
  if (deep && st.round.passes < 2) problems.push('a critical module needs two doc-checker passes');
  if (st.lastCheck && !st.round.full) problems.push('no full doc-checker pass since the document was written: run one');
  if (!st.readability) problems.push('no readability review yet');
  if (layer === 'technical' && !st.people) problems.push('the people layer is approved first (owner or PO), then the technical layer');
  if (problems.length) fail(`not approved: ${doc}.md\n  - ${problems.join('\n  - ')}`);
  const front = { ...d.front, approvals: { ...(d.front.approvals || {}), [layer]: { by, role, on: today(), hash: d.hash, ...(accepted ? { known: st.known.items } : {}) } } };
  const after = { ...st, [layer]: front.approvals[layer] };
  const undecided = st.openQuestions.filter((q) => !q.decision);
  if (after.people && after.technical && (!deep || !undecided.length)) front.status = 'Approved';
  else if (after.people) front.status = 'Reviewed';
  fs.writeFileSync(d.f, joinDoc(front, d.body));
  syncDocStatus(home, id);
  return { status: front.status, known: accepted ? st.known : null, waiting: deep && after.people && after.technical && undecided.length ? undecided.map((q) => q.q) : [] };
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

// The business flowchart is part of the people layer: it has no sign-off of
// its own; the owner or PO reads it with the documents.
function flowchartLines(home, id) {
  const L = ['## Business flowchart', ''];
  const D = docsDir(home);
  if (!fs.existsSync(path.join(D, diagRel(id, 'flowchart.md')))) return [...L, `Not drawn yet: \`/tech-plugin:diagram ${id}\`. Once drawn, the owner or PO reads it with the people layer.`, ''];
  const facts = readJson(path.join(D, factsRelOf(id)));
  const s = diagramState(home, id, facts ? facts.hash : buildFacts(home, id).hash);
  const when = s.drawnAt ? s.drawnAt.slice(0, 10) : '?';
  L.push(`- [ ] **Owner or PO:** does [the flowchart](../diagrams/flowchart.md) show how people move through the screens, with the names they use? Drawn on ${when}${s.state === 'up-to-date' ? '; it matches the code and the documents.' : `; **out of date** (${s.reasons.join('; ')}): redraw it with \`/tech-plugin:diagram ${id}\` first.`}`, '- To change a screen name, edit `diagrams/labels.yaml` (set `from: you`), then redraw.', '');
  return L;
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
    const lc = s.lastCheck ? `pass ${s.lastCheck.pass}${s.lastCheck.mode === 'focused' ? ' (focused)' : ''}: ${s.lastCheck.mismatch} mismatch, ${s.lastCheck.notProvable} not provable${s.lastCheck.current ? '' : ' (older text)'}${s.known && s.known.current ? `; [${s.known.items} known issue(s)](${doc}-known.md)` : ''}` : 'not run';
    L.push(`| [${doc}](../${doc}.md) | ${s.status} | ${lc} | ${s.readability ? 'done' : 'not run'} | ${s.people ? `${s.people.by} (${s.people.role}), ${s.people.on}` : 'waiting'} | ${s.technical ? `${s.technical.by} (${s.technical.role}), ${s.technical.on}` : 'waiting'} |`);
  }
  L.push('', ...flowchartLines(home, id));
  L.push('', '## What each reviewer does', '', '- **Owner or PO (people layer):** read everything above "Appendix A", and the business flowchart. Is it right, and can someone outside the team follow it? Answer the open questions addressed to you.', '- **Developer (technical layer):** check Appendix A and B: do the cited lines show what the statements say? Answer the open questions addressed to you. Where a document lists known issues, read them: approving the technical layer accepts them until the next rewrite.', '');
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
  if (!a.home || !id) fail('usage: signoff.mjs <save-check|save-review|known|decide|approve|checklist|sync|status> <module> … --home HOME');
  const home = real(a.home);
  moduleOf(home, id);
  if (cmd === 'save-check') {
    if (!a.input) fail('--input FILE is required');
    const r = saveCheck(home, id, third, real(a.input), a.checker, a.mode || 'full');
    process.stdout.write(`saved ${r.rel}: ${r.mismatch} mismatch, ${r.notProvable} not provable, ${r.risk || 0} risk${r.clean ? ' (clean)' : ''}; ${r.left > 0 ? `${r.left} more pass(es) allowed this round` : 'no more passes this round'}\n`);
  } else if (cmd === 'known') {
    const r = recordKnown(home, id, third);
    checklist(home, id);
    process.stdout.write(`recorded ${r.items} known issue(s) in ${r.rel}: ${r.mismatch} mismatch, ${r.notProvable} not provable\n`);
  } else if (cmd === 'save-review') {
    if (!a.input) fail('--input FILE is required');
    const r = saveReview(home, id, third, real(a.input));
    process.stdout.write(`saved ${r.rel}${r.unclear !== null ? `: ${r.unclear} thing(s) a non-technical reader could not follow` : ''}\n`);
  } else if (cmd === 'decide') process.stdout.write(`recorded ${decide(home, id, a)} in modules/${id}/checks/decisions.md\n`);
  else if (cmd === 'approve') {
    const r = approve(home, id, third, a);
    checklist(home, id);
    process.stdout.write(`${third}.md: ${a.layer} layer approved by ${a.by} (${a.role}); status ${r.status}${r.known ? `; accepted ${r.known.items} known issue(s) (${r.known.rel})` : ''}${r.waiting.length ? `; Approved after a decision on ${r.waiting.join(', ')}` : ''}\n`);
  } else if (cmd === 'checklist') {
    checklist(home, id);
    process.stdout.write(`wrote modules/${id}/checks/review-checklist.md\n`);
  } else if (cmd === 'sync') process.stdout.write(`doc_status of ${id}: ${syncDocStatus(home, id)}\n`);
  else if (cmd === 'status') process.stdout.write(JSON.stringify(Object.fromEntries(DOCS_ORDER.map((d) => [d, docState(home, id, d)])), null, 2) + '\n');
  else fail('unknown command');
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) main();
