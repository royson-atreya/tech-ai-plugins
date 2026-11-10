#!/usr/bin/env node
// A stand-in for graphify in the tests (fast, offline, checkable).
//   extract <src> --code-only --out <out>   one node per file, grouped by top folder
//   cluster-only <out> --no-viz --no-label  writes GRAPH_REPORT.md
//   --version
// Every file it was given, the working folder and GRAPHIFY_BACKEND are
// appended to $FAKE_GRAPHIFY_LOG, so a test can check what graphify saw.

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const log = (o) => process.env.FAKE_GRAPHIFY_LOG && fs.appendFileSync(process.env.FAKE_GRAPHIFY_LOG, JSON.stringify(o) + '\n');

if (args[0] === '--version') {
  process.stdout.write('graphify 0.0.0-fake\n');
  process.exit(0);
}
if (args[0] === 'extract') {
  const src = args[1];
  const out = args[args.indexOf('--out') + 1];
  if (process.env.FAKE_GRAPHIFY_FAIL) {
    process.stderr.write(`boom in ${src}\n`);
    process.exit(3);
  }
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(path.relative(src, p).split(path.sep).join('/'));
    }
  };
  walk(src);
  files.sort();
  const tops = [...new Set(files.map((f) => f.split('/').slice(0, 2).join('/')))];
  const nodes = files.map((f) => ({ id: f.replace(/\W/g, '_'), label: path.basename(f).replace(/\.\w+$/, ''), source_file: f, community: tops.indexOf(f.split('/').slice(0, 2).join('/')) }));
  const links = [];
  for (let i = 1; i < nodes.length; i++) if (nodes[i].community === nodes[i - 1].community) links.push({ source: nodes[i - 1].id, target: nodes[i].id, relation: 'calls' });
  fs.mkdirSync(path.join(out, 'graphify-out'), { recursive: true });
  fs.writeFileSync(path.join(out, 'graphify-out', 'graph.json'), JSON.stringify({ directed: true, nodes, links }));
  log({ cmd: 'extract', cwd: process.cwd(), backend: process.env.GRAPHIFY_BACKEND || null, codeOnly: args.includes('--code-only'), files, contents: files.map((f) => fs.readFileSync(path.join(src, f), 'utf8')).join('\n') });
  process.exit(0);
}
if (args[0] === 'cluster-only') {
  const out = args[1];
  fs.writeFileSync(path.join(out, 'graphify-out', 'GRAPH_REPORT.md'), `# Graph Report\nfrom ${out}\n`);
  log({ cmd: 'cluster-only', flags: args.slice(2) });
  process.exit(0);
}
process.stderr.write('fake graphify: unknown command\n');
process.exit(2);
