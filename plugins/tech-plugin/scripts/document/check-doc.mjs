#!/usr/bin/env node
// Mechanical checks of a module document (spec, brd or prd). The doc-checker
// agent then checks meaning; plain.mjs checks the wording.
//
//   node check-doc.mjs <doc.md> --home HOME
//
//  1. the stamp parses and has every field; status is Draft or Checked, and
//     Checked only with a check record (validate writes it); a change after
//     that is a warning: the document counts as a Draft again
//  2. the ## headings are exactly the template's, in order
//  3. "In short" has its four lines; its open-question count matches
//  4. every open question has a number and a role
//  5. every fact line of the people layer carries an [E#] or [Q#] tag
//  6. every tag resolves: E# in Appendix A with a source and a class, Q# in
//     Open questions; Assumption/Unknown point at a question
//  7. IDs: PRD <MODULE>-Rnn unique, each with acceptance criteria and evidence;
//     BRD BR-nn unique; no ID of the previous version lost
//  8. every cited repo:path:line exists, is not a secret file, and the line is
//     not blank
//  9. no key-like strings and no personal data
// 10. the document was written from the current fact pack and input documents
// Prints PASS / FAIL / WARN lines; exits 1 if any FAIL.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bodyHash, splitDoc } from '../lib/frontmatter.mjs';
import { scanText } from '../lib/redact.mjs';
import { makeReader } from '../lib/stacks.mjs';
import { PLUGIN_ROOT, docsDir, fail, isSecretFor, parseArgs, readJson, real } from '../breakdown/common.mjs';
import { loadState } from '../breakdown/state.mjs';
import { NEEDS, docRel, factsRelOf, idsIn, prevRel } from './doc.mjs';

const CLASSES = ['Verified', 'Inferred', 'Assumption', 'Unknown'];
export const ROLE_RE = /^(owner|product owner|po|ba|business analyst|developer|dev|tech lead|architect|qa|tester|designer|admin|support|ops|operations|doctor|clinic|legal|finance|security)$/i;

export function templateHeadings(doc) {
  const t = fs.readFileSync(path.join(PLUGIN_ROOT, 'references', 'document', `${doc}-template.md`), 'utf8');
  return t.split('\n').filter((l) => /^## /.test(l)).map((l) => l.trim());
}

// people layer = after the title, up to the first "## Appendix" (or Document control)
export function layers(body) {
  const lines = body.split('\n');
  let start = lines.findIndex((l) => /^# /.test(l));
  if (start === -1) start = 0;
  let end = lines.findIndex((l, i) => i > start && /^## (Appendix|Document control)/.test(l));
  if (end === -1) end = lines.length;
  return { lines, start, end };
}

function section(lines, title) {
  const i = lines.findIndex((l) => l.trim() === title);
  if (i === -1) return [];
  const out = [];
  for (let k = i + 1; k < lines.length && !/^## /.test(lines[k]); k++) out.push({ n: k, t: lines[k] });
  return out;
}

// Every `repo:path:lines` citation in the lines: the repo is one of the
// system's, the file exists and is not secret, and each cited line is there
// and not blank. Shared with check-work.mjs.
export function checkCitations(lines, home) {
  const st = loadState(home);
  const repos = new Map(((st && st.repos) || []).map((r) => [r.name, path.resolve(home, r.path)]));
  const cites = new Map();
  lines.forEach((l, k) => {
    for (const m of l.matchAll(/`([A-Za-z0-9_.-]+):([^`\s:]+(?:\.[A-Za-z0-9]+)?)(?::(\d+(?:[-,]\d+)*))?`/g)) if (repos.has(m[1])) cites.set(`${m[1]}:${m[2]}${m[3] ? ':' + m[3] : ''}`, { repo: m[1], p: m[2], lines: m[3], n: k });
  });
  const bad = [];
  const readers = new Map();
  for (const [c, x] of cites) {
    if (!readers.has(x.repo)) readers.set(x.repo, makeReader(repos.get(x.repo), isSecretFor(repos.get(x.repo))));
    const rd = readers.get(x.repo);
    if (rd.isSecret(x.p)) {
      bad.push(`${c}: cites a secret file`);
      continue;
    }
    const t = rd.text(x.p, 8 * 1024 * 1024);
    if (t === null) {
      bad.push(`${c}: file not found`);
      continue;
    }
    if (!x.lines) continue;
    const fl = t.split('\n');
    for (const part of x.lines.split(',')) {
      const [a, b = a] = part.split('-').map(Number);
      if (b < a) bad.push(`${c}: range runs backwards`);
      else if (b > fl.length) bad.push(`${c}: the file has ${fl.length} lines`);
      else if (!fl[a - 1] || !fl[a - 1].trim()) bad.push(`${c}: line ${a} is blank`);
    }
  }
  return { count: cites.size, bad };
}

export function checkDoc(file, home) {
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
    add('FAIL', 'the stamp parses', ['no --- stamp at the top: copy it from doc.mjs prepare']);
    return R;
  }
  add('PASS', 'the stamp parses');
  const off = parts.frontLines; // line numbers in reports are file lines
  const missing = ['module', 'doc', 'title', 'status', 'date', 'commits', 'facts', 'inputs'].filter((k) => !(k in front));
  add(missing.length ? 'FAIL' : 'PASS', 'stamp fields present', missing.length ? [`missing: ${missing.join(', ')}`] : []);
  const doc = front.doc;
  const id = front.module;
  if (!['spec', 'brd', 'prd'].includes(doc)) {
    add('FAIL', 'stamp doc is spec, brd or prd', [`got: ${doc}`]);
    return R;
  }
  const hash = bodyHash(parts.body);
  const ap = front.approvals || {};
  const valid = (x) => x && x.by && x.hash === hash;
  const again = ['it counts as a Draft until /tech-plugin:validate checks it again'];
  if (front.status === 'Draft') add('PASS', 'status is Draft');
  else if (front.status === 'Checked') {
    if (!front.checked || !front.checked.hash) add('FAIL', 'status Checked has a check record', ['only /tech-plugin:validate sets Checked, once the checks pass']);
    else if (front.checked.hash !== hash) add('WARN', 'changed since it was checked', again);
    else add('PASS', 'status is Checked');
  } else if (front.status === 'Reviewed' || front.status === 'Approved') {
    // the two-layer sign-off of tech-plugin 0.5 and earlier
    if (!valid(ap.people) && !valid(ap.technical) && !(ap.people && ap.people.by) && !(ap.technical && ap.technical.by)) add('FAIL', `status ${front.status} has a recorded sign-off`, ['only /tech-plugin:validate sets a status, and it sets Checked']);
    else if (!valid(ap.people) || (front.status === 'Approved' && !valid(ap.technical))) add('WARN', 'changed since it was approved', again);
    else add('PASS', `status is ${front.status} (signed off before tech-plugin 0.6)`);
  } else add('FAIL', 'status is Draft or Checked', [`got: ${front.status}`]);

  // 2. headings
  const want = templateHeadings(doc);
  const got = parts.body.split('\n').filter((l) => /^## /.test(l)).map((l) => l.trim());
  const same = want.length === got.length && want.every((w, i) => w === got[i]);
  add(same ? 'PASS' : 'FAIL', `headings match the ${doc} template (${want.length} sections)`, same ? [] : [...want.filter((w) => !got.includes(w)).map((w) => `missing: ${w}`), ...got.filter((g) => !want.includes(g)).map((g) => `not in template: ${g}`), ...(want.filter((w) => got.includes(w)).join() !== got.filter((g) => want.includes(g)).join() ? ['out of order'] : [])]);

  const { lines, start, end } = layers(parts.body);
  const people = lines.slice(start, end);
  // 3. In short
  const box = [];
  for (let k = start + 1; k < end && (/^>/.test(lines[k]) || !lines[k].trim()); k++) if (/^>/.test(lines[k])) box.push(lines[k]);
  const boxText = box.join('\n');
  const needBox = ['**In short**', '**What it does:**', '**Who uses it:**', '**Key rules:**', '**Open questions:**'].filter((x) => !boxText.includes(x));
  const oq = lines.findIndex((l) => /^## \d+\. Open questions$/.test(l.trim()));
  const qs = [];
  const qProblems = [];
  if (oq !== -1) {
    for (const { n, t } of section(lines, lines[oq].trim())) {
      if (!t.trim() || /^none\.?$/i.test(t.trim()) || /^<!--/.test(t.trim())) continue;
      const m = /^- \*\*Q(\d+)\*\*\s*\((?:for\s+)?([^)]+)\):\s*\S/.exec(t);
      if (!m) {
        qProblems.push(`line ${n + 1 + off}: write questions as "- **Q1** (for PO): …?"`);
        continue;
      }
      const roles = m[2].split(/\s*(?:,|\/|\band\b|\bor\b)\s*/);
      if (!roles.every((r) => ROLE_RE.test(r.trim()) || (front.roles || []).includes(r.trim()))) qProblems.push(`line ${n + 1 + off}: Q${m[1]} names no known role (${m[2]}): owner, PO, BA, developer, QA, designer…`);
      if (qs.includes(Number(m[1]))) qProblems.push(`line ${n + 1 + off}: Q${m[1]} is defined twice`);
      qs.push(Number(m[1]));
    }
  }
  const boxN = /\*\*Open questions:\*\*\s*(\d+)/.exec(boxText);
  if (needBox.length) add('FAIL', '"In short" box with its four lines', [`missing: ${needBox.join(', ')}`]);
  else if (!boxN || Number(boxN[1]) !== qs.length) add('FAIL', '"In short" open-question count matches', [`In short says ${boxN ? boxN[1] : '?'}, the Open questions section has ${qs.length}`]);
  else add('PASS', `"In short" box complete (${qs.length} open questions)`);
  add(qProblems.length ? 'FAIL' : 'PASS', 'every open question has a number and a role', qProblems);

  // 5. tags on fact lines
  const untagged = [];
  const reqSection = doc === 'prd' ? lines.findIndex((l) => l.trim() === '## 4. Requirements') : -1;
  let inBlock = false;
  for (let k = start + 1; k < end; k++) {
    const t = lines[k].trim();
    if (/^## /.test(lines[k])) {
      inBlock = false;
      continue;
    }
    if (reqSection !== -1 && k > reqSection && /^### /.test(lines[k])) {
      inBlock = true;
      continue;
    }
    if (inBlock) continue; // requirement blocks are checked below
    if (!t || /^>/.test(t) || /^#{1,6} /.test(t) || /^<!--/.test(t) || /^\|?\s*:?-{3,}/.test(t) || /^none( yet)?\.?$/i.test(t) || /^\*\*[^*]+\*\*:?$/.test(t)) continue;
    if (oq !== -1 && k > oq && !lines.slice(oq + 1, k).some((x) => /^## /.test(x))) continue; // the questions themselves
    if (/^\|/.test(t) && lines[k + 1] && /^\|?\s*:?-{3,}/.test(lines[k + 1].trim())) continue; // table header
    if (!/\[(?:(?:spec|brd) )?(E|Q)\d+\]/.test(t)) untagged.push(`line ${k + 1 + off}: ${t.slice(0, 80)}`);
  }
  add(untagged.length ? 'FAIL' : 'PASS', 'every fact in the people layer has an [E#] or [Q#] tag', untagged.slice(0, 15).concat(untagged.length > 15 ? [`… and ${untagged.length - 15} more`] : []));

  // 6. tags resolve
  const appA = section(lines, '## Appendix A. Evidence');
  const defs = new Map();
  const defProblems = [];
  for (const { n, t } of appA) {
    if (!/^\|\s*E\d+\s*\|/.test(t)) continue;
    const cells = t.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
    const [eid, statement, source, cls] = cells;
    if (defs.has(eid)) defProblems.push(`line ${n + 1 + off}: ${eid} is defined twice`);
    defs.set(eid, { statement, source, cls, n });
    if (!CLASSES.includes(cls)) defProblems.push(`line ${n + 1 + off}: ${eid} class "${cls}" is not one of ${CLASSES.join(', ')}`);
    else if ((cls === 'Verified' || cls === 'Inferred') && !/`[^`]+`|glossary\.md|system\.yaml|modules\.yaml|decision D\d+|\b(spec|brd|prd) E\d+|\bBR-\d+|\b[A-Z][A-Z-]*-R\d+/.test(source || '')) defProblems.push(`line ${n + 1 + off}: ${eid} is ${cls} but has no source`);
    else if ((cls === 'Assumption' || cls === 'Unknown') && !/\bQ\d+\b/.test(source || '')) defProblems.push(`line ${n + 1 + off}: ${eid} is ${cls}: its source must be the question that asks about it (Q#)`);
  }
  const usedE = new Set();
  const usedQ = new Set();
  lines.forEach((l, k) => {
    if (appA.some((x) => x.n === k)) return;
    for (const m of l.matchAll(/\[(E|Q)(\d+)\]/g)) (m[1] === 'E' ? usedE : usedQ).add(`${m[1]}${m[2]}`);
  });
  for (const d of defs.values()) for (const m of (d.source || '').matchAll(/\bQ(\d+)\b/g)) usedQ.add(`Q${m[1]}`);
  // [spec Q6] / [brd Q2]: a question asked once, in an earlier document
  const crossBad = [];
  for (const m of parts.body.matchAll(/\[(spec|brd) (Q|E)(\d+)\]/g)) {
    const f = path.join(docsDir(home), docRel(id, m[1]));
    const t = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    const there = m[2] === 'Q' ? new RegExp(`^- \\*\\*Q${m[3]}\\*\\*`, 'm').test(t) : new RegExp(`^\\|\\s*E${m[3]}\\s*\\|`, 'm').test(t);
    if (!there && !crossBad.includes(m[0])) crossBad.push(m[0]);
  }
  const undefinedE = [...usedE].filter((e) => !defs.has(e));
  const undefinedQ = [...usedQ].filter((q) => !qs.includes(Number(q.slice(1))));
  const unusedE = [...defs.keys()].filter((e) => !usedE.has(e));
  const tagProblems = [...defProblems, ...undefinedE.map((e) => `${e} is used but not in Appendix A`), ...undefinedQ.map((q) => `${q} is used but not in Open questions`), ...crossBad.map((x) => `${x} points at nothing in that document`)];
  add(tagProblems.length ? 'FAIL' : 'PASS', `every tag resolves (${defs.size} evidence rows, ${qs.length} questions)`, tagProblems.slice(0, 20));
  if (unusedE.length) add('WARN', 'evidence rows no statement uses', [unusedE.join(', ')]);

  // 7. IDs
  if (doc === 'prd') {
    const P = String(id).toUpperCase();
    const heads = [...parts.body.matchAll(new RegExp(`^### (${P}-R\\d{2,}):(.*)$`, 'gm'))];
    const ids = heads.map((h) => h[1]);
    const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
    const bad = [];
    const bodyLines = parts.body.split('\n');
    for (const h of heads) {
      if (/Removed/i.test(h[2])) continue;
      const i = bodyLines.findIndex((l) => l.startsWith(`### ${h[1]}:`));
      const blk = [];
      for (let k = i + 1; k < bodyLines.length && !/^#{2,3} /.test(bodyLines[k]); k++) blk.push(bodyLines[k]);
      const b = blk.join('\n');
      if (!/\*\*Acceptance criteria\*\*/.test(b) || !/^- (Given|When)\b/im.test(b)) bad.push(`${h[1]}: needs **Acceptance criteria** with Given/when/then lines`);
      if (!/\*\*Evidence:\*\*.*\[(?:(?:spec|brd) )?(E|Q)\d+\]/.test(b)) bad.push(`${h[1]}: needs an **Evidence:** line with tags`);
    }
    if (!ids.length) add('FAIL', `requirements ${P}-Rnn present`, ['no "### ' + P + '-R01: …" headings']);
    else add(dup.length || bad.length ? 'FAIL' : 'PASS', `${ids.length} requirements ${P}-Rnn: unique, each with acceptance criteria and evidence`, [...dup.map((d) => `${d} is defined twice`), ...bad]);
    const brdFile = path.join(docsDir(home), docRel(id, 'brd'));
    if (fs.existsSync(brdFile)) {
      const brIds = idsIn(fs.readFileSync(brdFile, 'utf8'), 'brd', id);
      const refs = [...new Set([...parts.body.matchAll(/\bBR-\d{2,}\b/g)].map((m) => m[0]))];
      const unknown = refs.filter((r) => !brIds.includes(r));
      if (unknown.length) add('FAIL', 'linked business requirements exist in the BRD', unknown.map((u) => `${u} is not in brd.md`));
    }
  }
  if (doc === 'brd') {
    const rows = [...parts.body.matchAll(/^\|\s*(BR-\d{2,})\s*\|/gm)].map((m) => m[1]);
    const dup = rows.filter((x, i) => rows.indexOf(x) !== i);
    add(!rows.length || dup.length ? 'FAIL' : 'PASS', `${rows.length} business requirements BR-nn, each defined once`, rows.length ? dup.map((d) => `${d} is defined twice`) : ['no "| BR-01 | … |" rows in section 7']);
  }
  const prevFile = path.join(docsDir(home), prevRel(id, doc));
  if (fs.existsSync(prevFile) && doc !== 'spec') {
    const lost = idsIn(fs.readFileSync(prevFile, 'utf8'), doc, id).filter((x) => !new RegExp(doc === 'prd' ? `^### ${x}:` : `^\\|\\s*${x}\\s*\\|`, 'm').test(parts.body));
    add(lost.length ? 'FAIL' : 'PASS', 'no ID of the previous version lost', lost.map((x) => `${x} is gone: keep it, or mark it "Removed (reason)"`));
  }

  // 8. citations
  const cc = checkCitations(lines, home);
  add(cc.bad.length ? 'FAIL' : 'PASS', `all ${cc.count} code citations exist`, cc.bad.slice(0, 20));

  // 9. secrets and personal data (the stamp is skipped: it holds commit ids)
  const skip = new Set(Array.from({ length: off }, (_, i) => i + 1));
  const risks = scanText(text, { skipLines: skip });
  add(risks.length ? 'FAIL' : 'PASS', 'no key-like strings and no personal data', risks.map((r) => `line ${r.line}: ${r.type} (value not shown)`));

  // 10. freshness
  const facts = readJson(path.join(docsDir(home), factsRelOf(id)));
  if (!facts) add('WARN', 'fact pack found', ['no _facts.json: run doc.mjs facts']);
  else if (facts.hash !== front.facts) add('FAIL', 'written from the current fact pack', [`the code facts changed since this was written (stamp ${front.facts}, now ${facts.hash}): run /tech-plugin:document ${id} ${doc}`]);
  else add('PASS', 'written from the current fact pack');
  const stale = [];
  for (const n of NEEDS[doc]) {
    const f = path.join(docsDir(home), docRel(id, n));
    if (!fs.existsSync(f)) stale.push(`${n}.md is missing`);
    else if (!front.inputs || front.inputs[n] !== bodyHash(splitDoc(fs.readFileSync(f, 'utf8')).body)) stale.push(`${n}.md changed since this was written`);
  }
  if (NEEDS[doc].length) add(stale.length ? 'FAIL' : 'PASS', 'written from the current input documents', stale);
  return R;
}

export function report(R, file) {
  const L = [];
  for (const r of R) {
    L.push(`${r.level.padEnd(5)} ${r.name}`);
    for (const d of r.details) L.push(`        ${d}`);
  }
  const fails = R.filter((r) => r.level === 'FAIL').length;
  L.push(fails ? `check-doc: ${fails} check(s) failed (${file})` : `check-doc: PASS (${file})`);
  return { text: L.join('\n'), ok: !fails };
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const file = a._[0];
  if (!file || !a.home) fail('usage: check-doc.mjs <doc.md> --home HOME');
  if (!fs.existsSync(file)) fail(`${file} not found`);
  const r = report(checkDoc(real(file), real(a.home)), path.basename(path.dirname(file)) + '/' + path.basename(file));
  process.stdout.write(r.text + '\n');
  process.exitCode = r.ok ? 0 : 1;
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) main();
