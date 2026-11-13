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
//        (checks/<doc>-known.md); they do not stop Checked
//   node signoff.mjs save-review <module> <doc> --input FILE --home HOME
//        saves the readability review as checks/<doc>-readability.md
//   node signoff.mjs decide <module> --doc D --q Q3 --answer TEXT --by NAME --role ROLE --home HOME
//        records a person's answer to an open question in checks/decisions.md
//        (optional: nothing waits for an answer)
//   node signoff.mjs checklist <module> --home HOME     marks, then writes checks/review-checklist.md
//   node signoff.mjs sync <module> --home HOME          marks, then sets doc_status in modules.yaml
//   node signoff.mjs status <module> --home HOME        JSON per document
//
// Marking (after save-check, save-review, known, checklist and sync): a
// document is Checked once its last doc-checker pass is on its current text
// and clean (or its leftovers are recorded as known issues), with enough
// passes this round, a readability review, and check-doc and plain passing.
// Nobody signs off. A Checked document that changed is a Draft again.
//
// WHY the hash: a check report and the Checked record apply to one exact
// text. When the document changes afterwards, they no longer count.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bodyHash, joinDoc, splitDoc } from '../lib/frontmatter.mjs';
import { docsDir, fail, parseArgs, readJson, real, today, writeDocs } from '../breakdown/common.mjs';
import { DOCS_ORDER, NEEDS, buildFacts, checkedRel, decisionsRel, docInfo, docRel, factsRelOf, isDeep, knownRel, moduleOf, readRound } from './doc.mjs';
import { diagRel, diagramState } from '../diagram/diagram.mjs';
import { checkDoc } from './check-doc.mjs';
import { plainCheck } from './plain.mjs';

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
  if (r.passes >= r.limit && !extra) fail(`not saved: ${doc}.md already has ${r.passes} doc-checker passes this round (the limit is ${r.limit}). Record what the last pass left as known issues (signoff.mjs known ${id} ${doc}). A rewrite with /tech-plugin:document starts a new round.`);
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
    `What doc-checker pass ${last.n} left open after the last allowed pass. They stay visible here and do not stop the document being Checked. The next /tech-plugin:document run of ${doc} gets this list and fixes them.`,
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
  const head = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : `# Decisions: ${id}\n\nAnswers people gave to open questions, recorded by /tech-plugin:validate when someone answers. The next /tech-plugin:document run cites them as "decision D<n>". Never edit an existing row; add a new decision instead.\n\n| ID | Document | Question | Asked | Answer | Decided by | Date |\n|---|---|---|---|---|---|---|\n`;
  const cell = (s) => String(s).replace(/\|/g, '/').replace(/\n/g, ' ');
  writeDocs(home, decisionsRel(id), head.replace(/\n*$/, '\n') + `| ${next} | ${doc} | ${q} | ${cell(qq.text)} | ${cell(answer)} | ${cell(`${by} (${role})`)} | ${today()} |\n`);
  return next;
}

// ------------------------------------------------------------------ Checked

export function docState(home, id, doc) {
  const d = readDoc(home, id, doc);
  if (!d) return { exists: false };
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
  const info = docInfo(home, id, doc);
  return {
    exists: true,
    status: info.status || 'Draft',
    hash: d.hash,
    checked: info.checked || null,
    checkerPasses: checks.length,
    round,
    lastCheck: lc,
    known,
    settled,
    readability,
    openQuestions: qs.map((x) => ({ ...x, decision: (decisions.filter((y) => y.q === x.q).pop() || null) })),
  };
}

// Sets each document's status from its checks: Checked or Draft. A document
// Approved by the old two-layer sign-off, for its current text, is left alone.
export function markChecked(home, id) {
  const out = {};
  for (const doc of DOCS_ORDER) {
    const d = readDoc(home, id, doc);
    if (!d) continue;
    const info = docInfo(home, id, doc);
    if (info.broken) continue;
    if (info.status === 'Approved') {
      out[doc] = 'Approved';
      continue;
    }
    const st = docState(home, id, doc);
    let ready = st.settled && st.readability;
    if (ready) ready = !checkDoc(d.f, home).some((r) => r.level === 'FAIL') && !plainCheck(d.f, home).some((r) => r.level === 'FAIL');
    const front = { ...d.front };
    if (ready) {
      out[doc] = 'Checked';
      if (info.status === 'Checked') continue;
      delete front.approvals;
      front.status = 'Checked';
      front.checked = { on: today(), hash: d.hash, pass: st.lastCheck.pass, ...(st.known && st.known.current ? { known: st.known.items } : {}) };
    } else {
      out[doc] = 'Draft';
      if ((front.status || 'Draft') === 'Draft') continue;
      delete front.approvals;
      front.status = 'Draft';
      front.checked = null;
    }
    fs.writeFileSync(d.f, joinDoc(front, d.body));
  }
  syncDocStatus(home, id);
  return out;
}

// modules.yaml doc_status: none -> draft -> checked (approved: all three
// signed off under the old flow and unchanged since)
export function syncDocStatus(home, id) {
  const infos = DOCS_ORDER.map((doc) => docInfo(home, id, doc));
  let v = 'none';
  if (infos.some((s) => s.exists)) v = 'draft';
  if (infos.every((s) => s.exists && ['Checked', 'Approved'].includes(s.status))) v = infos.every((s) => s.status === 'Approved') ? 'approved' : 'checked';
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

// The business flowchart is shown with the documents; it has no status of its own.
function flowchartLines(home, id) {
  const L = ['## Business flowchart', ''];
  const D = docsDir(home);
  if (!fs.existsSync(path.join(D, diagRel(id, 'flowchart.md')))) return [...L, `Not drawn yet: \`/tech-plugin:diagram ${id}\`.`, ''];
  const facts = readJson(path.join(D, factsRelOf(id)));
  const s = diagramState(home, id, facts ? facts.hash : buildFacts(home, id).hash);
  const when = s.drawnAt ? s.drawnAt.slice(0, 10) : '?';
  L.push(`- [The flowchart](../diagrams/flowchart.md) shows how people move through the screens. Drawn on ${when}${s.state === 'up-to-date' ? '; it matches the code and the documents.' : `; **out of date** (${s.reasons.join('; ')}): redraw it with \`/tech-plugin:diagram ${id}\` first.`}`, '- To change a screen name, edit `diagrams/labels.yaml` (set `from: you`), then redraw.', '');
  return L;
}

export function checklist(home, id) {
  const { m } = moduleOf(home, id);
  const deep = isDeep(m);
  const marked = markChecked(home, id);
  const L = [`# Checks: ${m.name}`, '', `Written by /tech-plugin:validate on ${today()}. ${deep ? '**Critical module** (money, security or clinical): two doc-checker passes.' : 'Standard module: one doc-checker pass.'} A document is Checked when its last pass is on its current text and clean (or what is left is listed as known issues) and the readability review is done. No sign-off is needed.`, ''];
  L.push('| Document | Status | Doc-checker (last pass) | Readability |', '|---|---|---|---|');
  for (const doc of DOCS_ORDER) {
    const s = docState(home, id, doc);
    if (!s.exists) {
      L.push(`| ${doc} | not written | | |`);
      continue;
    }
    const lc = s.lastCheck ? `pass ${s.lastCheck.pass}${s.lastCheck.mode === 'focused' ? ' (focused)' : ''}: ${s.lastCheck.mismatch} mismatch, ${s.lastCheck.notProvable} not provable${s.lastCheck.current ? '' : ' (older text)'}${s.known && s.known.current ? `; [${s.known.items} known issue(s)](${doc}-known.md)` : ''}` : 'not run';
    L.push(`| [${doc}](../${doc}.md) | ${s.status} | ${lc} | ${s.readability ? 'done' : 'not run'} |`);
  }
  L.push('', ...flowchartLines(home, id));
  L.push('## Open questions', '', 'They stay in the documents. Answering is optional; an answer is used the next time the document is written.', '');
  let any = false;
  for (const doc of DOCS_ORDER) {
    const s = docState(home, id, doc);
    if (!s.exists || !s.openQuestions.length) continue;
    any = true;
    L.push(`### ${doc}`, '', '| Question | For | Answer |', '|---|---|---|');
    for (const q of s.openQuestions) L.push(`| **${q.q}** ${q.text.replace(/\|/g, '/')} | ${q.role} | ${q.decision ? `${q.decision.id}: ${q.decision.answer.replace(/\|/g, '/')} (${q.decision.by})` : 'open'} |`);
    L.push('');
  }
  if (!any) L.push('None.', '');
  writeDocs(home, path.join(checksDir(id), 'review-checklist.md'), L.join('\n'));
  return marked;
}

const statusText = (r) => DOCS_ORDER.filter((d) => r[d]).map((d) => `${d} ${r[d]}`).join(', ');

function main() {
  const [cmd, id, third] = process.argv.slice(2);
  const a = parseArgs(process.argv.slice(3));
  if (!a.home || !id) fail('usage: signoff.mjs <save-check|save-review|known|decide|checklist|sync|status> <module> … --home HOME');
  const home = real(a.home);
  moduleOf(home, id);
  if (cmd === 'save-check') {
    if (!a.input) fail('--input FILE is required');
    const r = saveCheck(home, id, third, real(a.input), a.checker, a.mode || 'full');
    process.stdout.write(`saved ${r.rel}: ${r.mismatch} mismatch, ${r.notProvable} not provable, ${r.risk || 0} risk${r.clean ? ' (clean)' : ''}; ${r.left > 0 ? `${r.left} more pass(es) allowed this round` : 'no more passes this round'}\nstatus: ${statusText(markChecked(home, id))}\n`);
  } else if (cmd === 'known') {
    const r = recordKnown(home, id, third);
    process.stdout.write(`recorded ${r.items} known issue(s) in ${r.rel}: ${r.mismatch} mismatch, ${r.notProvable} not provable\nstatus: ${statusText(markChecked(home, id))}\n`);
  } else if (cmd === 'save-review') {
    if (!a.input) fail('--input FILE is required');
    const r = saveReview(home, id, third, real(a.input));
    process.stdout.write(`saved ${r.rel}${r.unclear !== null ? `: ${r.unclear} thing(s) a non-technical reader could not follow` : ''}\nstatus: ${statusText(markChecked(home, id))}\n`);
  } else if (cmd === 'decide') process.stdout.write(`recorded ${decide(home, id, a)} in modules/${id}/checks/decisions.md\n`);
  else if (cmd === 'checklist') {
    const r = checklist(home, id);
    process.stdout.write(`wrote modules/${id}/checks/review-checklist.md\nstatus: ${statusText(r)}\n`);
  } else if (cmd === 'sync') {
    markChecked(home, id);
    process.stdout.write(`doc_status of ${id}: ${syncDocStatus(home, id)}\n`);
  }
  else if (cmd === 'status') process.stdout.write(JSON.stringify(Object.fromEntries(DOCS_ORDER.map((d) => [d, docState(home, id, d)])), null, 2) + '\n');
  else fail('unknown command');
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) main();
