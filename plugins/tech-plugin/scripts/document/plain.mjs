#!/usr/bin/env node
// Plain-language check of a document's people layer (everything above
// "## Appendix A"), the way PLAN.md asks: a non-technical reader must
// understand it without opening the code.
//
//   node plain.mjs <doc.md> --home HOME
//
// FAIL: code in the people layer: backticks, file paths, class, function or
//       table names (camelCase, snake_case, Foo::bar, Foo@bar, *Controller…),
//       HTTP methods with paths, HTTP status codes, SQL, URLs
// WARN: sentences over 25 words; words from references/document/jargon.txt;
//       domain words from the module's code that are not in glossary.md
// Text people see on screen, quoted "like this", is not checked for code.
// Exits 1 if any FAIL.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitDoc } from '../lib/frontmatter.mjs';
import { PLUGIN_ROOT, docsDir, fail, parseArgs, readJson, real } from '../breakdown/common.mjs';
import { factsRelOf, glossaryTerms } from './doc.mjs';
import { layers } from './check-doc.mjs';

const CODE = [
  ['code in backticks', /`[^`]+`/],
  ['a file path', /\b[\w.-]+\/[\w./-]*\.(php|js|mjs|ts|tsx|jsx|dart|py|java|kt|vue|svelte|json|sql|html|yaml|yml)\b|\b(app|resources|routes|lib|src|public|database|config|storage)\/[\w.-]+\//],
  ['a class or method name', /\b\w+::\w+|->\w+|\b[A-Z]\w+@\w+|\b[A-Z][a-z]+(?:[A-Z][a-z0-9]+)*(Controller|Service|Repository|Request|Provider|Bloc|Cubit|Middleware|Helper|Model)\b/],
  ['a code name in camelCase', /\b[a-z]+[A-Z][a-z0-9]+[A-Za-z0-9]*\b/],
  ['a code name in snake_case', /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/],
  ['an HTTP method with a path', /\b(GET|POST|PUT|PATCH|DELETE)\s+\/?[a-z{][\w/{}.-]*/],
  ['an HTTP status code', /\bHTTP\s*\d{3}\b|\bstatus(?: code)?\s+[1-5]\d\d\b|\b[1-5]\d\d\s+(?:error|response|status)\b/i],
  ['SQL', /\b(SELECT\s+.+\s+FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i],
  ['a URL', /\bhttps?:\/\/|\bwww\.[a-z0-9-]+\./i],
  ['words about the documentation tools (write about the product, not the scan)', /\b(fact pack|(?:the|automatic|code) scan|scanner|the scripts?|tech-plugin|modules\.yaml|_facts|approved purpose|code facts)\b/i],
];
const ALLOWED_CAMEL = /^(iPhone|iPad|iOS|macOS|eSign|eKYC|mPIN|WhatsApp|YouTube|LinkedIn|PayPal|JavaScript|TypeScript|GitHub|PhonePe|OneSignal)$/;

function jargon() {
  return fs
    .readFileSync(path.join(PLUGIN_ROOT, 'references', 'document', 'jargon.txt'), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

export function plainCheck(file, home) {
  const R = [];
  const add = (level, name, details = []) => R.push({ level, name, details });
  const text = fs.readFileSync(file, 'utf8');
  const parts = splitDoc(text);
  const off = parts.frontLines;
  const { lines, start, end } = layers(parts.body);
  const codeHits = [];
  const longs = [];
  const jar = new Map();
  const jlist = jargon();
  const front = parts.front || {};
  const facts = front.module ? readJson(path.join(docsDir(home), factsRelOf(front.module))) : null;
  const glossary = glossaryTerms(home);
  const words = facts ? facts.words.map((w) => w.word).filter((w) => !glossary.has(w)) : [];
  const missingTerms = new Map();
  for (let k = start; k < end; k++) {
    const raw = lines[k];
    if (/^<!--/.test(raw.trim()) || /^\|?\s*:?-{3,}/.test(raw.trim())) continue;
    const t = raw
      .replace(/\[(?:(?:spec|brd) )?(E|Q)\d+\]/g, '')
      .replace(/^#{1,6}\s+/, '')
      .replace(/^>\s?/, '')
      .replace(/\*\*/g, '')
      .replace(/\b(BR-\d{2,}|[A-Z][A-Z0-9-]*-R\d{2,}|Q\d+|E\d+|D\d+)\b/g, 'ID');
    const outsideQuotes = t.replace(/"[^"]*"|“[^”]*”/g, ' ');
    for (const [name, re] of CODE) {
      const m = re.exec(outsideQuotes);
      if (!m) continue;
      if (name === 'a code name in camelCase' && ALLOWED_CAMEL.test(m[0])) continue;
      codeHits.push(`line ${k + 1 + off}: ${name} ("${m[0].slice(0, 40)}")`);
      break;
    }
    const cells = t.includes('|') ? t.split('|') : [t];
    for (const c of cells) {
      for (const s of c.split(/(?<=[.!?])\s+/)) {
        const n = s.replace(/"[^"]*"/g, 'quote').split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
        if (n > 25) longs.push(`line ${k + 1 + off}: ${n} words: "${s.trim().slice(0, 60)}…"`);
      }
    }
    for (const j of jlist) {
      const re = new RegExp(`(^|[^A-Za-z])${j.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z]|$)`, j === j.toUpperCase() ? '' : 'i');
      if (re.test(outsideQuotes)) jar.set(j, (jar.get(j) || []).concat(k + 1 + off));
    }
    for (const w of words) if (new RegExp(`\\b${w}\\b`, 'i').test(t)) missingTerms.set(w, (missingTerms.get(w) || []).concat(k + 1 + off));
  }
  add(codeHits.length ? 'FAIL' : 'PASS', 'no code in the people layer', codeHits.slice(0, 20).concat(codeHits.length > 20 ? [`… and ${codeHits.length - 20} more`] : []));
  add(longs.length ? 'WARN' : 'PASS', 'sentences of 25 words or fewer', longs.slice(0, 15));
  add(jar.size ? 'WARN' : 'PASS', 'no jargon', [...jar.entries()].map(([j, ls]) => `"${j}" on line ${ls.slice(0, 5).join(', ')}: say it in plain words`));
  add(missingTerms.size ? 'WARN' : 'PASS', 'domain terms are in the glossary', [...missingTerms.entries()].map(([w, ls]) => `"${w}" (line ${ls.slice(0, 3).join(', ')}): add it with glossary.mjs`));
  return R;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const file = a._[0];
  if (!file || !a.home) fail('usage: plain.mjs <doc.md> --home HOME');
  if (!fs.existsSync(file)) fail(`${file} not found`);
  const R = plainCheck(real(file), real(a.home));
  const L = [];
  for (const r of R) {
    L.push(`${r.level.padEnd(5)} ${r.name}`);
    for (const d of r.details) L.push(`        ${d}`);
  }
  const fails = R.filter((r) => r.level === 'FAIL').length;
  L.push(fails ? `plain: ${fails} check(s) failed` : `plain: PASS (${R.filter((r) => r.level === 'WARN').length} warning(s))`);
  process.stdout.write(L.join('\n') + '\n');
  process.exitCode = fails ? 1 : 0;
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) main();
