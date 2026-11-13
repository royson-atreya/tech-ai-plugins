#!/usr/bin/env node
// /tech-plugin:next: the one next step for this project, worked out from the
// files in sdlc-docs/, so it is the same every time.
//
//   node next.mjs --cwd DIR
//        JSON { next, skill, args, command, why, progress, hint, home }
//
// In this order, the first that applies:
//   restart     a newer tech-plugin is installed than this session runs
//   build       a work item being built (implement, review) comes before a
//               new breakdown: the build itself changes the code
//   breakdown   no breakdown yet, one half done, or the code changed since
//   sync        documents or diagrams no longer match the code, or new
//               business documents arrived
//   work item   a work item waits for its requirements, design, plan, approval,
//               build or review
//   diagram     the system diagrams are not drawn yet
//   document    the first module, in the suggested order, whose documents
//               are not all Checked or whose diagrams are not drawn
//   sync        the docs website is missing or older than the documents
//   done        everything is documented, checked and current

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_ROOT, docsDir, fail, parseArgs, real } from './breakdown/common.mjs';
import { status as breakdownStatus } from './breakdown/state.mjs';
import { loadExisting } from './breakdown/modules.mjs';
import { suggestedOrder } from './breakdown/catalogue.mjs';
import { pluginUpdate } from './lib/version.mjs';
import { DOCS_ORDER, docInfo } from './document/doc.mjs';
import { diagRel } from './diagram/diagram.mjs';
import { status as syncStatus } from './sync/sync.mjs';
import { list as workItems } from './work/work.mjs';

const step = (next, skill, args, why, extra = {}) => ({ next, skill, args, command: skill ? `/tech-plugin:${skill}${args ? ` ${args}` : ''}` : null, why, ...extra });

const WORK = {
  impact: ['impact', 'its impact'],
  requirement: ['requirement', 'its requirements'],
  'approve-requirement': ['requirement', 'approval of its requirements by the owner, PO or BA'],
  design: ['design', 'its design'],
  'approve-design': ['design', 'approval of its design by a developer or tech lead'],
  task: ['task', 'its plan'],
  'approve-plan': ['task', 'your approval of its plan (an APPROVED file and a feature branch: /tech-plugin:task prints both commands)'],
  implement: ['implement', 'its code to be built'],
  review: ['review', 'its review and handoff'],
};

// What a module still needs: null when its documents are all Checked (or
// Approved before 0.6) and its diagrams are drawn.
export function moduleNeeds(home, id) {
  const docs = DOCS_ORDER.map((d) => docInfo(home, id, d));
  if (!docs.some((d) => d.exists)) return 'It has no documents yet.';
  if (!docs.every((d) => d.exists)) return `Its ${DOCS_ORDER.filter((d, i) => !docs[i].exists).join(' and ')} ${docs.filter((d) => !d.exists).length > 1 ? 'are' : 'is'} not written yet.`;
  if (!docs.every((d) => d.status === 'Checked' || d.status === 'Approved')) return 'Its documents are written but not all checked yet.';
  if (!fs.existsSync(path.join(docsDir(home), diagRel(id, '_stamp.json')))) return 'Its diagrams are not drawn yet.';
  return null;
}

export function nextStep(cwd) {
  const upd = pluginUpdate(PLUGIN_ROOT);
  if (upd) return step('restart', null, null, upd.message);
  const bd = breakdownStatus(cwd);
  if (!bd.found) return step('breakdown', 'breakdown', null, 'First the plugin reads your code and splits it into business modules. It stops twice for you: to confirm the tech stack and to approve the module list.', { home: bd.home || null });
  const home = bd.home;
  const wasDone = bd.stages && bd.stages['6'] && bd.stages['6'].status === 'done';
  // a build in progress changes the code: finish it before breaking down again
  if (bd.next !== 'up-to-date' && wasDone && loadExisting(home)) {
    const building = workItems(home).items.find((i) => i.next === 'implement' || i.next === 'review');
    if (building) {
      const [skill, what] = WORK[building.next];
      return step(building.next, skill, building.id, `Work item ${building.id} "${building.title}" is being built and is waiting for ${what}. Break the code down again after it is merged.`, { home });
    }
  }
  if (bd.next !== 'up-to-date') return step('breakdown', 'breakdown', wasDone ? '--refresh' : null, wasDone ? `The code changed since the breakdown: ${bd.message}` : `The breakdown is not finished: ${bd.message}`, { home });
  const my = loadExisting(home);
  if (!my || !Array.isArray(my.modules)) return step('breakdown', 'breakdown', null, 'There is no approved module list yet.', { home });

  const sy = syncStatus(home);
  if (sy.next === 'choose') return step('sync', 'sync', null, `${sy.rows.length} item(s) no longer match the code or are new: ${sy.rows.slice(0, 3).map((r) => `${r.module === '-' ? '' : `${r.module} `}${r.item}`).join(', ')}${sy.rows.length > 3 ? ', …' : ''}.`, { home });

  const open = workItems(home).items.filter((i) => WORK[i.next]);
  if (open.length) {
    const it = open[0];
    const [skill, what] = WORK[it.next];
    return step(it.next.startsWith('approve') ? 'approve' : skill, skill, it.id, `Work item ${it.id} "${it.title}" is waiting for ${what}.`, { home, progress: open.length > 1 ? `${open.length} work items in progress` : null });
  }

  if (!fs.existsSync(path.join(docsDir(home), 'system', 'diagrams', '_stamp.json'))) return step('diagram', 'diagram', 'system', 'Draw the whole system on one page: the apps, their databases and services, and the key journeys. It takes a few seconds and no writing.', { home });

  const order = suggestedOrder(my.modules);
  let done = 0;
  let todo = null;
  for (const m of order) {
    const needs = moduleNeeds(home, m.id);
    if (!needs) done++;
    else if (!todo) todo = { m, needs };
  }
  const progress = `${done} of ${order.length} modules documented and checked`;
  if (todo) return step('document', 'document', todo.m.id, `Next module: ${todo.m.name}${todo.m.critical ? ' (critical: money, security or clinical)' : ''}. ${todo.needs}`, { home, progress });

  if (sy.portal && sy.portal.state !== 'up-to-date') return step('sync', 'sync', '--portal', 'Build the docs website, so everyone can read the documents in a browser.', { home, progress });
  return step('done', null, null, 'Everything is documented, checked and up to date.', { home, progress, hint: 'For new work: /tech-plugin:impact "what you want to change"' });
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const cwd = real(a.cwd || process.cwd());
  if (!fs.existsSync(cwd)) fail(`no such folder: ${cwd}`);
  process.stdout.write(JSON.stringify(nextStep(cwd), null, 2) + '\n');
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) main();
