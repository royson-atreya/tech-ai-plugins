#!/usr/bin/env node
// Adds a term to sdlc-docs/glossary.md, once.
//
//   node glossary.mjs add --home HOME --term T --meaning M --source S
//
// The meaning stays "To be confirmed" unless the product itself says it (a
// label, a help text), and then the source says where. Existing rows are never
// changed: people own the meanings.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact } from '../lib/redact.mjs';
import { docsDir, fail, parseArgs, real, writeDocs } from '../breakdown/common.mjs';
import { glossaryTerms } from './doc.mjs';

export function addTerm(home, term, meaning, source) {
  const t = String(term || '').trim();
  if (!t) fail('--term is required');
  if (glossaryTerms(home).has(t.toLowerCase())) return false;
  const f = path.join(docsDir(home), 'glossary.md');
  const cell = (s) => redact(String(s || '').replace(/\|/g, '/').replace(/\n/g, ' ').trim());
  const head = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '# Glossary\n\nBusiness terms in plain words. Edit the meanings freely.\n\n| Term | Meaning | Source |\n|---|---|---|\n';
  writeDocs(home, 'glossary.md', head.replace(/\n*$/, '\n') + `| ${cell(t)} | ${cell(meaning) || 'To be confirmed'} | ${cell(source) || 'found by /tech-plugin:document'} |\n`);
  return true;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = parseArgs(rest);
  if (cmd !== 'add' || !a.home) fail('usage: glossary.mjs add --home HOME --term T [--meaning M] [--source S]');
  const added = addTerm(real(a.home), a.term, a.meaning, a.source);
  process.stdout.write(added ? `added "${a.term}" to glossary.md\n` : `"${a.term}" is already in glossary.md\n`);
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) main();
