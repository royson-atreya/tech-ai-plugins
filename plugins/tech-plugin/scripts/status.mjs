#!/usr/bin/env node
// /tech-plugin:status: where everything stands, in one place.
//
//   node status.mjs --cwd DIR      JSON: work items and their next step, open
//                                  defects, open incidents, releases, modules
//
// Read only, apart from each work item's status.json, which it refreshes.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { docsDir, fail, parseArgs, real } from './breakdown/common.mjs';
import { status as breakdownStatus } from './breakdown/state.mjs';
import { loadExisting } from './breakdown/modules.mjs';
import { DOCS_ORDER, docInfo } from './document/doc.mjs';
import { list as workItems, refresh } from './work/work.mjs';
import { listIncidents } from './release/incident.mjs';
import { releaseStatus } from './release/release.mjs';

const PHASE = {
  impact: 'planning', requirement: 'planning', 'approve-requirement': 'planning', design: 'planning', 'approve-design': 'planning',
  task: 'planning', 'approve-plan': 'waiting for your approval', implement: 'building', review: 'building',
  'test-cases': 'testing', 'test-run': 'testing', 'fix-defects': 'fixing defects', tested: 'ready to release', released: 'released', done: 'built',
};

export function overview(cwd) {
  const bd = breakdownStatus(cwd);
  if (!bd.found) return { found: false, message: 'No breakdown here yet: /tech-plugin:next starts it.' };
  const home = bd.home;
  const my = loadExisting(home);
  const items = my ? workItems(home).items.map((i) => {
    const r = refresh(home, i.id);
    const ts = r.testState;
    return { id: i.id, title: i.title, kind: r.kind || 'feature', level: r.level, phase: PHASE[r.next] || r.next, next: r.next, nextText: r.nextText, openDefects: ts ? ts.openDefects.length : 0, released: r.released ? r.released.version : null };
  }) : [];
  const D = docsDir(home);
  const mods = my ? my.modules.map((m) => {
    const docs = DOCS_ORDER.map((d) => docInfo(home, m.id, d));
    return { id: m.id, documented: docs.every((d) => d.exists), checked: docs.every((d) => ['Checked', 'Approved'].includes(d.status)), diagrams: fs.existsSync(path.join(D, 'modules', m.id, 'diagrams', '_stamp.json')), suite: fs.existsSync(path.join(D, 'modules', m.id, 'tests', 'test-cases.md')) };
  }) : [];
  const inc = listIncidents(home);
  const rel = releaseStatus(home);
  const count = (k) => mods.filter((m) => m[k]).length;
  return {
    found: true,
    home,
    breakdown: bd.next === 'up-to-date' ? 'up to date' : bd.message,
    items: items.filter((i) => i.next !== 'released'),
    released: items.filter((i) => i.next === 'released').map((i) => `${i.id} (${i.released})`),
    incidents: inc.open,
    releases: rel.releases.slice(-3),
    readyToRelease: rel.ready.map((i) => i.id),
    modules: { total: mods.length, documented: count('documented'), checked: count('checked'), diagrams: count('diagrams'), suites: count('suite') },
  };
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const cwd = real(a.cwd || process.cwd());
  if (!fs.existsSync(cwd)) fail(`no such folder: ${cwd}`);
  process.stdout.write(JSON.stringify(overview(cwd), null, 2) + '\n');
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) main();
