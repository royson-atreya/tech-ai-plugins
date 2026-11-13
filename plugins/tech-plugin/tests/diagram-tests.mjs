// diagram and sync: screen names (from the spec, checked for plain words),
// the flowchart, sequence and ER diagrams, the system block diagram and key
// journeys, freshness stamps, the sync status table, business documents,
// the docs portal (escaping, folds, links, rebuild only on change), the
// review checklist, the skill and agent definitions, and the guard.
//
//   node --test tests/diagram-tests.mjs

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildDocSystem, runScript } from './golden-doc.mjs';
import { SECRET_MARKER } from './golden.mjs';
import { PLUGIN, runGuard } from './fixture.mjs';
import { parseYaml, toYaml } from '../scripts/lib/yaml.mjs';
import { bodyHash, joinDoc, splitDoc } from '../scripts/lib/frontmatter.mjs';
import { labelProblem, parts, requirementsOf } from '../scripts/diagram/diagram.mjs';
import { parseStep } from '../scripts/diagram/system.mjs';
import { citesIn, idRegistry } from '../scripts/diagram/mermaid.mjs';
import { mermaidBlocks, parseFlowchart, parseSequence, toDrawio } from '../scripts/diagram/drawio.mjs';
import { buildFacts, docFreshness } from '../scripts/document/doc.mjs';
import { statePath } from '../scripts/breakdown/state.mjs';
import { MERMAID_URL, renderMarkdown } from '../scripts/sync/portal.mjs';
import { codeIn } from '../scripts/document/plain.mjs';

const D = buildDocSystem();
const { G, H } = D;
after(() => fs.rmSync(G.W, { recursive: true, force: true }));

const put = (f, t) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, t);
};
// links between screens, for the flowchart: patient list -> patient page -> sign-in
fs.appendFileSync(path.join(G.web, 'resources/views/patients/index.blade.php'), '<a href="{{ route(\'patients.show\', 1) }}">Open</a>\n');
fs.appendFileSync(path.join(G.web, 'resources/views/patients/show.blade.php'), '<a href="{{ route(\'login\') }}">Sign in again</a>\n');
spawnSync('git', ['-C', G.web, 'add', '-A']);

const S = (p) => path.join(H, 'sdlc-docs', p);
const read = (p) => fs.readFileSync(S(p), 'utf8');
const dg = (args) => runScript('diagram', 'diagram.mjs', [...args, '--home', H]);
const sy = (args) => runScript('sync', 'sync.mjs', [...args, '--home', H]);
const ok = (r) => {
  assert.equal(r.code, 0, r.err || r.out);
  return r.out;
};
const json = (r) => JSON.parse(ok(r));

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'sdlc-docs') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

function setLabels(id, fn) {
  const f = S(`modules/${id}/diagrams/labels.yaml`);
  const y = parseYaml(fs.readFileSync(f, 'utf8'));
  y.screens = y.screens.map(fn);
  fs.writeFileSync(f, toYaml(y));
}

const SPEC = `# Patients: how it works

> **In short**
> - **What it does:** Doctors see their patients and ask for a pulse report.
> - **Who uses it:** Doctors.
> - **Key rules:** A report request needs a name.
> - **Open questions:** 0

## 1. Who uses it

- Doctors. [E1]

## 2. What people can do

### Ask for a report

1. The doctor opens the patient list. [E2]

## 3. Screens

| Screen | What it shows | What you can do there | Evidence |
|---|---|---|---|
| Patient list | Each patient's name | Open a patient | [E2] |
| Pages of the module | Many things | Many things | [E3] |

## 4. Rules

- A report request needs a name. [E4]

## 5. When something goes wrong

| Situation | What the person sees | Evidence |
|---|---|---|
| Not found | "Patient not found" | [E4] |

## 6. Open questions

None.

## Appendix A. Evidence

| ID | Statement | Source | Class |
|---|---|---|---|
| E1 | Signed-in users | \`web:routes/web.php:8\` | Verified |
| E2 | The patient list page | \`web:resources/views/patients/index.blade.php:3\` | Verified |
| E3 | Two pages | \`web:resources/views/patients/index.blade.php:1\` \`web:resources/views/patients/show.blade.php:1\` | Verified |
| E4 | Rules | \`web:app/Http/Controllers/PatientPageController.php:20-24\` | Verified |

## Appendix B. Technical detail

None.

## Document control

Draft.
`;
const BRD = `# Patients: business requirements

> **In short**
> - **What it does:** Reports for patients.

## Appendix A. Evidence

| ID | Statement | Source | Class |
|---|---|---|---|
| E1 | Report request | spec E4 | Verified |
`;
const PRD = `# Patients: product requirements

> **In short**
> - **What it does:** Doctors ask for reports.

## 4. Requirements

### PATIENTS-R01: Ask for a report

The doctor asks for a report for a patient.

**Evidence:** [E1] [E2]

### PATIENTS-R02: See the patient list

The doctor sees the list.

**Evidence:** [E3]

### PATIENTS-R03: Speak plainly

Words only.

**Evidence:** [E4]

## Appendix A. Evidence

| ID | Statement | Source | Class |
|---|---|---|---|
| E1 | Success message | \`web:app/Http/Controllers/PatientPageController.php:25\` | Verified |
| E2 | Rules | brd E1 | Verified |
| E3 | The list page asks the backend | \`web:app/Http/Controllers/PatientPageController.php:11\` | Verified |
| E4 | Purpose | modules.yaml | Verified |

## Document control

Draft.
`;
function writeDoc(doc, body, id = 'patients') {
  const pr = JSON.parse(ok(runScript('document', 'doc.mjs', ['prepare', id, doc, '--home', H])));
  fs.writeFileSync(pr.out, pr.stamp + '\n' + body);
}

// ================================================================ order
describe('needs first', () => {
  test('before the breakdown is finished, diagram stops and says why', () => {
    const r = json(dg(['status', 'patients']));
    assert.equal(r.next, 'breakdown');
    assert.match(r.message, /^Run \/tech-plugin:breakdown first/);
  });
  test('(the breakdown is finished for the rest of the tests)', () => D.finishBreakdown());
});

const before = {};
describe('screen names', () => {
  test('status: no diagrams yet; the next step is the names', () => {
    for (const r of [G.backend, G.web, G.mobile]) before[r] = snapshot(r);
    const s = json(dg(['status', 'patients']));
    assert.deepEqual([s.next, s.state, s.screens, s.split, s.spec, s.prd], ['labels', 'missing', 3, false, false, false]);
  });
  test('without a spec, every screen waits for the labeller, with hints from the page', () => {
    const r = json(dg(['labels', 'patients']));
    assert.deepEqual([r.total, r.fromSpec, r.todo, r.agent], [3, 0, 3, 'tech-plugin:diagram-labeller']);
    assert.deepEqual(r.screens.find((s) => s.screen === 'web|patients.index').titles, ['Patient list']);
    assert.match(read('modules/patients/diagrams/labels.yaml'), /# Screen names for the diagrams of Patients\. Yours to edit/);
  });
  test('check-labels fails, and draw refuses, while a screen has no name', () => {
    const c = dg(['check-labels', 'patients']);
    assert.equal(c.code, 1);
    assert.match(c.out, /labels: FAIL \(3 of 3\)\n {2}web\|patients\.index: no name yet/);
    const d = dg(['draw', 'patients']);
    assert.equal(d.code, 1);
    assert.match(d.err, /the screen names are not ready \(3\)/);
    assert.ok(!fs.existsSync(S('modules/patients/diagrams/flowchart.md')));
  });
  test('(spec, BRD and PRD are written)', () => {
    writeDoc('spec', SPEC);
    writeDoc('brd', BRD);
    writeDoc('prd', PRD);
  });
  test('a spec Screens row whose evidence names exactly one screen names it; a row about two screens names none', () => {
    const r = json(dg(['labels', 'patients']));
    assert.deepEqual([r.fromSpec, r.todo], [1, 2]);
    const y = parseYaml(read('modules/patients/diagrams/labels.yaml'));
    assert.deepEqual(y.screens.find((s) => s.screen === 'web|patients.index'), { screen: 'web|patients.index', label: 'Patient list', from: 'spec', page: 'patients' });
    assert.equal(y.screens.find((s) => s.screen === 'web|patients.show').label, null);
  });
  test('the plain-name check', () => {
    assert.equal(labelProblem('Patient list'), null);
    assert.equal(labelProblem('Vikruti (Current Imbalance)'), null);
    assert.equal(labelProblem(''), 'no name yet');
    assert.match(labelProblem('patients_index'), /looks like code: a code name in snake_case/);
    assert.match(labelProblem('PatientScreen page'), /looks like code: a code name in PascalCase/);
    assert.match(labelProblem('patientList'), /looks like code: a code name in camelCase/);
    assert.match(labelProblem('Open patients.show'), /looks like code: a dotted code name/);
    assert.equal(labelProblem('Send it on WhatsApp'), null);
    assert.match(labelProblem('GET patients/list'), /looks like code/);
    assert.match(labelProblem('The "best" page'), /character the diagrams cannot show/);
    assert.match(labelProblem('one two three four five six seven eight nine'), /more than 8 words/);
  });
  test('names with code fail the check, line by line', () => {
    setLabels('patients', (s) => (s.label ? s : { ...s, label: s.screen.endsWith('show') ? 'patients.show' : 'PatientScreen', from: 'agent' }));
    const c = dg(['check-labels', 'patients']);
    assert.equal(c.code, 1);
    assert.match(c.out, /web\|patients\.show: looks like code/);
    assert.match(c.out, /mobile\|PatientScreen: looks like code: a code name in PascalCase \("PatientScreen"\)\n/);
  });
  test('the labeller fills the names; the check passes', () => {
    setLabels('patients', (s) => (s.from === 'agent' ? { ...s, label: s.screen.endsWith('show') ? 'Patient details' : 'Patient on the phone' } : s));
    assert.match(ok(dg(['check-labels', 'patients'])), /labels: PASS \(3 screen\(s\) named in plain words\)/);
  });
  test('running labels again keeps the names people and the labeller wrote', () => {
    const r = json(dg(['labels', 'patients']));
    assert.deepEqual([r.fromSpec, r.kept, r.todo], [1, 2, 0]);
  });
});

describe('module diagrams', () => {
  let out;
  let flow;
  test('draw writes the flowchart, sequences, ER and a stamp', () => {
    out = json(dg(['draw', 'patients']));
    assert.deepEqual([out.screens, out.parts, out.sequences, out.withoutApi], [3, 1, 2, ['PATIENTS-R03']]);
    for (const f of ['flowchart.md', 'sequences.md', 'er.md', '_stamp.json']) assert.ok(fs.existsSync(S(`modules/patients/diagrams/${f}`)), f);
    flow = read('modules/patients/diagrams/flowchart.md');
  });
  test('flowchart: business names, arrows from links, other modules as their own box', () => {
    assert.match(flow, /s_web_patients_index\["Patient list"\]/);
    assert.match(flow, /s_web_patients_show\["Patient details"\]/);
    assert.match(flow, /start --> s_web_patients_index/);
    assert.match(flow, /s_web_patients_index --> s_web_patients_show/);
    assert.match(flow, /m_auth\(\["Sign-in"\]\)/);
    assert.match(flow, /s_web_patients_show --> m_auth/);
    assert.ok(!/start --> s_web_patients_show/.test(flow), 'a screen with an arrow into it is not a start');
    assert.match(flow, /- Patient list → Patient details: `patients\.index links to route patients\.show \(GET patients\/\{id\}, web:routes\/web\.php:\d+\)`/);
    assert.match(flow, /- Patient details → Sign-in: `patients\.show links to route login \(GET login, web:routes\/web\.php:\d+\)`/);
  });
  test('flowchart: the people part has no code outside the diagram source', () => {
    const people = flow.split('## For developers')[0].replace(/```mermaid[\s\S]*?```/g, '');
    for (const l of people.split('\n')) assert.equal(codeIn(l.replace(/`[^`]*`/g, 'x')), null, l);
    for (const m of flow.matchAll(/\["([^"]+)"\]/g)) assert.equal(labelProblem(m[1]), null, m[1]);
  });
  test('sequences: one per requirement reaching an API, through the page, the app, the backend and its tables', () => {
    const s = read('modules/patients/diagrams/sequences.md');
    const r01 = s.split('## PATIENTS-R01')[1].split('## ')[0];
    assert.match(r01, /sequenceDiagram/);
    assert.match(r01, /participant A_web as web/);
    assert.match(r01, /participant A_backend as backend/);
    assert.match(r01, /participant S_web_patients_index as patients\.index/);
    assert.match(r01, /S_web_patients_index->>A_web: POST patients\/\{id\}\/report/);
    assert.match(r01, /Note over A_web: checks auth/);
    assert.match(r01, /A_web->>A_backend: POST api\/reports/);
    assert.match(r01, /A_backend->>DB: reads or writes pulse_reports/);
    assert.match(r01, /\| \d+ \| A_web->>A_backend: POST api\/reports \| `web:app\/Http\/Controllers\/PatientPageController\.php:23` \|/);
    assert.match(s, /## PATIENTS-R02: See the patient list[\s\S]*GET api\/patients/);
    assert.match(s, /## Requirements with no API call in their evidence\n\n- PATIENTS-R03: Speak plainly/);
  });
  test('the evidence chain is followed one step ("brd E1" -> "spec E4")', () => {
    assert.deepEqual(citesIn('`web:a/b.php:11-12,20` and `x:y.dart:3`'), [{ repo: 'web', file: 'a/b.php', ranges: [[11, 12], [20, 20]] }, { repo: 'x', file: 'y.dart', ranges: [[3, 3]] }]);
  });
  test('ER: the tables, links between tables Inferred from *_id columns', () => {
    assert.match(read('modules/patients/diagrams/er.md'), /patients \{\n {4}col id PK\n {4}col name/);
    ok(dg(['labels', 'reports']));
    const r = json(dg(['draw', 'reports']));
    assert.deepEqual([r.screens, r.tables, r.tableLinks], [0, 1, 1]);
    const er = read('modules/reports/diagrams/er.md');
    assert.match(er, /patients \|\|--o\{ pulse_reports : "patient_id"/);
    assert.match(er, /col patient_id FK/);
    assert.match(er, /`pulse_reports\.patient_id` → `patients` \(a table of another module\)/);
    assert.match(read('modules/reports/diagrams/sequences.md'), /No PRD yet/);
    assert.match(read('modules/reports/diagrams/flowchart.md'), /has no screens of its own/);
  });
  test('a module with more than 25 screens is drawn in parts of at most 25, grouped by folder', () => {
    const sc = [...Array(31).keys()].map((i) => ({ app: 'web', id: `${i < 20 ? 'stock' : 'admin'}.page${i}`, file: 'x' }));
    const p = parts(sc);
    assert.deepEqual(p.map((x) => x.length), [11, 20]);
    assert.ok(p[1].every((s) => s.id.startsWith('stock.')));
    assert.deepEqual(parts(sc.concat(sc.map((s) => ({ ...s, id: `stock.more${s.id}` })))).every((x) => x.length <= 25), true);
  });
});

describe('freshness', () => {
  test('no change: already up to date', () => {
    const s = json(dg(['status', 'patients']));
    assert.equal(s.next, 'up-to-date');
    assert.match(s.message, /Already up to date: the diagrams of patients match/);
  });
  test('a person edits a name: the diagrams are stale until redrawn', () => {
    setLabels('patients', (s) => (s.screen.endsWith('show') ? { ...s, label: 'One patient', from: 'you' } : s));
    const s = json(dg(['status', 'patients']));
    assert.deepEqual([s.next, s.reasons], ['labels', ['screen names in labels.yaml changed']]);
    const r = json(dg(['labels', 'patients']));
    assert.equal(parseYaml(read('modules/patients/diagrams/labels.yaml')).screens.find((x) => x.screen.endsWith('show')).label, 'One patient');
    assert.equal(r.todo, 0);
    ok(dg(['draw', 'patients']));
    assert.match(read('modules/patients/diagrams/flowchart.md'), /\["One patient"\]/);
    assert.equal(json(dg(['status', 'patients'])).next, 'up-to-date');
  });
  test('the PRD changes: the sequence diagrams are stale', () => {
    writeDoc('prd', PRD.replace('The doctor sees the list.', 'The doctor sees every patient.'));
    assert.deepEqual(json(dg(['status', 'patients'])).reasons, ['the PRD changed (sequence diagrams follow its requirements)']);
  });
  test('the spec renames a screen: names taken from the spec follow it; names people wrote stay', () => {
    writeDoc('spec', SPEC.replace('| Patient list |', '| List of patients |').replace('| Pages of the module |', '| Patient details |').replace('`web:resources/views/patients/index.blade.php:1` `web:resources/views/patients/show.blade.php:1`', '`web:resources/views/patients/show.blade.php:1`'));
    const s = json(dg(['status', 'patients']));
    assert.ok(s.reasons.includes('the spec changed (screen names may come from it)'));
    json(dg(['labels', 'patients']));
    const y = parseYaml(read('modules/patients/diagrams/labels.yaml'));
    assert.equal(y.screens.find((x) => x.screen === 'web|patients.index').label, 'List of patients');
    assert.deepEqual(y.screens.find((x) => x.screen.endsWith('show')), { screen: 'web|patients.show', label: 'One patient', from: 'you', page: 'patients/{id}' });
    // the BRD and PRD follow the new spec
    writeDoc('brd', BRD);
    writeDoc('prd', PRD);
    ok(dg(['draw', 'patients']));
  });
});

describe('system diagrams', () => {
  test('block diagram: apps in business words, databases, services, who asks whom', () => {
    assert.equal(json(dg(['status', 'system'])).next, 'draw');
    const r = json(dg(['draw', 'system']));
    assert.equal(r.apps, 3);
    const b = read('system/diagrams/block.md');
    assert.match(b, /app_web\["Website<br\/>web"\]/);
    assert.match(b, /app_backend\["Server<br\/>backend"\]/);
    assert.match(b, /app_mobile\["Mobile app<br\/>mobile"\]/);
    assert.match(b, /db_backend\[\("Database of backend"\)\]/);
    assert.match(b, /db_mobile\[\("Data kept on the device"\)\]/);
    assert.match(b, /app_web -->\|"asks for data"\| app_backend/);
    assert.match(b, /app_backend -.-> ext_Razorpay/);
    assert.match(b, /people\(\("Doctor, Patient"\)\)/);
    assert.match(b, /- web → backend: \d+ call\(s\) linked to its routes, e\.g\. `web:/);
  });
  test('journeys: with no key flows, an example to add to system.yaml', () => {
    assert.match(read('system/diagrams/journeys.md'), /No key flows are given yet\. Add them to `system\.yaml`/);
    assert.equal(json(dg(['status', 'system'])).next, 'up-to-date');
  });
  test('journeys: steps the code confirms are solid, the rest dashed', () => {
    const f = S('system.yaml');
    const y = parseYaml(fs.readFileSync(f, 'utf8'));
    y.business.key_flows = ['Book a consultation', { name: 'Ask for a pulse report', steps: [{ patients: 'The doctor opens the patient list' }, { module: 'patients', does: 'The doctor asks for a report' }, { payments: 'The clinic is paid' }, { nope: 'Something' }, 'A report arrives'] }];
    fs.writeFileSync(f, toYaml(y));
    const s = json(dg(['status', 'system']));
    assert.deepEqual(s.reasons, ['the key flows, users or roles in system.yaml changed']);
    const r = json(dg(['draw', 'system']));
    const j = read('system/diagrams/journeys.md');
    const pay = parseYaml(read('modules.yaml')).modules.find((m) => m.id === 'patients').depends_on.includes('payments');
    assert.match(j, /j2_1\["The doctor opens the patient list<br\/>Patients"\]/);
    assert.match(j, /j2_1 --> j2_2/);
    assert.match(j, new RegExp(`j2_2 ${pay ? '-->' : '-\\.->'} j2_3`));
    assert.match(j, /j2_3 -\.-> j2_4/);
    assert.match(j, /j2_4\["Something<br\/>part not found"\]/);
    assert.match(j, /Not a module of this system: nope/);
    assert.match(j, /## Book a consultation\n\nNo steps are given for this journey yet/);
    assert.equal(r.journeys, 2);
    assert.deepEqual(parseStep('x'), { module: null, text: 'x' });
  });
});

// Well-formed XML: every tag closes in order, attributes are quoted, no bare "&" or "<".
function wellFormed(xml) {
  const stack = [];
  const body = xml.replace(/^<\?xml[^>]*\?>/, '');
  for (const m of body.matchAll(/<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>|<|&(?!(?:amp|lt|gt|quot|apos|#\d+);)/g)) {
    if (!m[2]) return `bad character at ${m.index}: ${body.slice(m.index, m.index + 30)}`;
    if (m[1]) {
      if (stack.pop() !== m[2]) return `</${m[2]}> closes the wrong tag at ${m.index}`;
    } else if (!m[4]) stack.push(m[2]);
  }
  return stack.length ? `unclosed: ${stack.join(', ')}` : null;
}
const pagesOf = (xml) => [...xml.matchAll(/<diagram id="[^"]+" name="([^"]*)">([\s\S]*?)<\/diagram>/g)].map((m) => ({ name: m[1], body: m[2] }));
const countOf = (s, re) => (s.match(re) || []).length;

describe('draw.io copies', () => {
  test('every module diagram with Mermaid gets a .drawio beside it, well formed', () => {
    for (const f of ['flowchart', 'sequences', 'er']) {
      const x = read(`modules/patients/diagrams/${f}.drawio`);
      assert.equal(wellFormed(x), null, f);
      assert.match(x, /^<mxfile host="tech-plugin">\n {2}<diagram id="page-1" name="/);
    }
    assert.ok(fs.existsSync(S('modules/patients/diagrams/_drawio.json')));
    assert.match(read('modules/patients/diagrams/flowchart.md'), /Also saved as `flowchart\.drawio`/);
  });
  test('the same boxes and arrows as the Mermaid', () => {
    const md = read('modules/patients/diagrams/flowchart.md');
    const block = mermaidBlocks(md)[0];
    const { nodes, edges } = parseFlowchart(block.lines);
    const [p] = pagesOf(read('modules/patients/diagrams/flowchart.drawio'));
    assert.equal(countOf(p.body, /vertex="1"/g), nodes.size);
    assert.equal(countOf(p.body, /edge="1"/g), edges.length);
    assert.match(p.body, /value="List of patients"/);
    assert.match(p.body, /id="n_m_auth" value="Sign-in" style="rounded=1;arcSize=50;whiteSpace=wrap;html=1;dashed=1;"/);
    assert.match(p.body, /source="n_s_web_patients_index" target="n_s_web_patients_show"/);
  });
  test('sequences: one page per requirement, a lifeline per participant, a message per arrow', () => {
    const md = read('modules/patients/diagrams/sequences.md');
    const pages = pagesOf(read('modules/patients/diagrams/sequences.drawio'));
    const blocks = mermaidBlocks(md);
    assert.equal(pages.length, blocks.length);
    assert.match(pages[0].name, /^PATIENTS-R01: /);
    const sq = parseSequence(blocks[0].lines);
    assert.equal(countOf(pages[0].body, /shape=umlLifeline/g), sq.parts.length);
    assert.equal(countOf(pages[0].body, /edge="1"/g), sq.steps.filter((s) => s.kind === 'message').length);
    assert.match(pages[0].body, /value="Person" style="shape=umlLifeline;[^"]*rounded=1;fontStyle=1;"/);
    assert.match(pages[0].body, /value="POST api\/reports"/);
    assert.match(pages[0].body, /shape=note/);
  });
  test('ER: a box per table listing its columns; links from one to many', () => {
    const x = read('modules/reports/diagrams/er.drawio');
    assert.match(x, /id="t_pulse_reports" value="pulse_reports" style="swimlane;/);
    assert.match(x, /value="patient_id \(FK\)"[^>]*parent="t_pulse_reports"/);
    assert.match(x, /startArrow=ERmandOne;startFill=0;endArrow=ERzeroToMany;[^"]*" edge="1" parent="1" source="t_patients" target="t_pulse_reports"/);
    assert.ok(!fs.existsSync(S('modules/reports/diagrams/flowchart.drawio')), 'no screens: no Mermaid, no .drawio');
  });
  test('system: block, journeys and the module map; line breaks and dashed arrows carried over', () => {
    for (const f of ['block', 'journeys', 'module-map']) assert.equal(wellFormed(read(`system/diagrams/${f}.drawio`)), null, f);
    const b = read('system/diagrams/block.drawio');
    assert.match(b, /value="Website&lt;br&gt;web"/);
    assert.match(b, /id="n_db_backend" value="Database of backend" style="shape=cylinder3;/);
    assert.match(b, /value="asks for data" style="edgeStyle=orthogonalEdgeStyle[^"]*" edge="1" parent="1" source="n_app_web" target="n_app_backend"/);
    assert.match(b, /endArrow=block;endFill=1;exitX=1;[^"]*dashed=1;" edge="1" parent="1" source="n_app_backend" target="n_ext_Razorpay"/);
    assert.equal(pagesOf(read('system/diagrams/journeys.drawio')).length, 1);
  });
  test('drawing again gives the same file', () => {
    const before = read('modules/patients/diagrams/flowchart.drawio');
    ok(dg(['draw', 'patients']));
    assert.equal(read('modules/patients/diagrams/flowchart.drawio'), before);
  });
  test('a .drawio someone rearranged is never overwritten: the new drawing goes beside it', () => {
    const f = S('modules/patients/diagrams/flowchart.drawio');
    const mine = read('modules/patients/diagrams/flowchart.drawio').replace('value="Start"', 'value="Begin here"');
    assert.match(mine, /Begin here/);
    fs.writeFileSync(f, mine);
    setLabels('patients', (s) => (s.screen.endsWith('index') ? { ...s, label: 'All patients', from: 'you' } : s));
    const r = json(dg(['draw', 'patients']));
    assert.equal(fs.readFileSync(f, 'utf8'), mine);
    assert.deepEqual(r.keptDrawio, [{ file: path.join('modules', 'patients', 'diagrams', 'flowchart.drawio'), newFile: path.join('modules', 'patients', 'diagrams', 'flowchart.new.drawio') }]);
    assert.match(read('modules/patients/diagrams/flowchart.new.drawio'), /value="All patients"/);
    // once the person removes their copy, the plugin writes it again and tidies up
    fs.rmSync(f);
    assert.deepEqual(json(dg(['status', 'patients'])).reasons, ['a draw.io file is missing']);
    assert.deepEqual(json(dg(['draw', 'patients'])).keptDrawio, []);
    assert.match(fs.readFileSync(f, 'utf8'), /value="All patients"/);
    assert.ok(!fs.existsSync(S('modules/patients/diagrams/flowchart.new.drawio')));
    assert.equal(json(dg(['status', 'patients'])).next, 'up-to-date');
  });
  test('layout: columns follow the arrows, loops do not hang, every shape is drawn', () => {
    const md = ['# T', '', '```mermaid', 'flowchart LR', '  a["A"]', '  b[["Critical"]]', '  c[("Store")]', '  d(("Ext"))', '  e(["Other"])', '  a --> b', '  b --> c', '  c --> a', '  b -.-> d', '  c -->|"asks"| e', '  classDef other stroke-dasharray: 4 3', '  class e other', '```', ''].join('\n');
    const x = toDrawio(md);
    assert.equal(wellFormed(x), null);
    const xOf = (id) => Number(new RegExp(`id="n_${id}"[^>]*><mxGeometry x="([\\d.]+)"`).exec(x)[1]);
    assert.ok(xOf('a') < xOf('b') && xOf('b') < xOf('c'), 'a, b, c left to right despite the loop back to a');
    assert.match(x, /id="n_b" value="Critical" style="rounded=1;whiteSpace=wrap;html=1;strokeWidth=3;"/);
    assert.match(x, /id="n_d" value="Ext" style="ellipse;/);
    assert.match(x, /id="n_e" value="Other" style="rounded=1;arcSize=50;whiteSpace=wrap;html=1;dashed=1;"/);
    assert.equal(toDrawio('# No diagram here\n'), null);
    assert.match(toDrawio('```mermaid\nflowchart LR\n  a["Tom & Jerry <b>"]\n```\n'), /value="Tom &amp;amp; Jerry &amp;lt;b&amp;gt;"/);
  });
});

describe('the review checklist', () => {
  test('the business flowchart is shown with the documents; no sign-off', () => {
    ok(runScript('document', 'signoff.mjs', ['checklist', 'patients', '--home', H]));
    const c = read('modules/patients/checks/review-checklist.md');
    assert.match(c, /## Business flowchart\n\n- \[The flowchart\]\(\.\.\/diagrams\/flowchart\.md\) shows how people move through the screens/);
    assert.match(c, /it matches the code and the documents\./);
    ok(runScript('document', 'signoff.mjs', ['checklist', 'auth', '--home', H]));
    assert.match(read('modules/auth/checks/review-checklist.md'), /Not drawn yet: `\/tech-plugin:diagram auth`/);
  });
});

// ================================================================ sync
describe('sync status', () => {
  test('everything current: up to date; the portal not built yet', () => {
    const s = json(sy(['status']));
    assert.deepEqual([s.next, s.rows.length, s.portal.state], ['up-to-date', 0, 'missing']);
    assert.ok(s.current.includes('patients spec') && s.current.includes('patients diagrams') && s.current.includes('system diagrams'));
    assert.ok(s.notStarted.includes('auth'));
  });
  test('a Checked document whose code facts changed: a row, with the warning that it becomes a Draft', () => {
    const f = S('modules/patients/spec.md');
    const keep = fs.readFileSync(f, 'utf8');
    const p = splitDoc(keep);
    fs.writeFileSync(f, joinDoc({ ...p.front, status: 'Checked', checked: { on: '2026-11-13', hash: bodyHash(p.body), pass: 1 }, facts: '0000000000000000' }, p.body));
    try {
      const s = json(sy(['status']));
      const spec = s.rows.find((r) => r.module === 'patients' && r.item === 'spec');
      assert.deepEqual([spec.state, spec.action, spec.status], ['facts-changed', 'rewrite', 'Checked']);
      assert.match(spec.warn, /spec is Checked: rewriting makes it a Draft again, until \/tech-plugin:validate patients checks it/);
      assert.equal(s.rows.find((r) => r.item === 'brd'), undefined, 'the BRD is still written from the same spec text');
    } finally {
      fs.writeFileSync(f, keep);
    }
  });
  test('a spec rewritten after the BRD and PRD: both are listed, written from an older spec', () => {
    const f = S('modules/patients/spec.md');
    const keep = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, keep.replace('- Doctors. [E1]', '- Doctors, after they sign in. [E1]'));
    try {
      const s = json(sy(['status']));
      assert.deepEqual(s.rows.map((r) => [r.item, r.state, r.why]), [['brd', 'input-changed', 'spec changed since it was written'], ['prd', 'input-changed', 'spec changed since it was written'], ['diagrams', 'stale', 'the spec changed (screen names may come from it)']]);
    } finally {
      fs.writeFileSync(f, keep);
    }
  });
  test('diagrams drawn from other screen names: a redraw row with the reason', () => {
    setLabels('patients', (s) => (s.screen.endsWith('show') ? { ...s, label: 'A patient' } : s));
    const s = json(sy(['status']));
    assert.deepEqual(s.rows.map((r) => [r.n, r.module, r.item, r.action, r.why]), [[1, 'patients', 'diagrams', 'redraw', 'screen names in labels.yaml changed']]);
    ok(dg(['draw', 'patients']));
    assert.equal(json(sy(['status'])).next, 'up-to-date');
  });
});

describe('business documents', () => {
  const biz = path.join(G.W, 'biz');
  test('new files in the folders listed in system.yaml: copied, or a conversion command; secrets skipped', () => {
    put(path.join(biz, 'vision.md'), '# Vision\n');
    put(path.join(biz, 'notes/meeting.txt'), 'notes\n');
    put(path.join(biz, 'contract.pdf'), '%PDF-1.4\n');
    put(path.join(biz, 'server.pem'), `${SECRET_MARKER}\n`);
    put(path.join(biz, '.hidden.md'), 'x\n');
    const f = S('system.yaml');
    const y = parseYaml(fs.readFileSync(f, 'utf8'));
    y.docs = [{ path: biz, files: 3, converted: false }, { path: path.join(G.W, 'gone') }];
    fs.writeFileSync(f, toYaml(y));
    const s = json(sy(['status']));
    const row = s.rows.find((r) => r.item === 'business documents');
    assert.equal(row.why, `2 new, 1 to convert to Markdown, folder not found: ${path.join(G.W, 'gone')}`);
    const r = json(sy(['sources']));
    assert.deepEqual(r.copied.sort(), ['biz/notes/meeting.txt', 'biz/vision.md']);
    assert.deepEqual(r.toConvert, [{ file: 'biz/contract.pdf', command: `uvx markitdown '${path.join(biz, 'contract.pdf')}' -o '${S('sources/biz/contract.pdf.md')}'` }]);
    assert.equal(read('sources/biz/vision.md'), '# Vision\n');
    assert.ok(!fs.existsSync(S('sources/biz/server.pem')) && !fs.existsSync(S('sources/biz/.hidden.md')));
    assert.ok(!JSON.stringify(r).includes('server.pem'));
  });
  test('after the person converts the file, sync picks it up; files put straight into sources/ too', () => {
    put(S('sources/biz/contract.pdf.md'), '# Contract\n');
    put(S('sources/extra.md'), '# Extra\n');
    const r = json(sy(['sources']));
    assert.deepEqual([r.copied, r.pickedUp.sort(), r.toConvert], [[], ['biz/contract.pdf', 'sources/extra.md'], []]);
    const y = parseYaml(read('system.yaml'));
    y.docs = [{ path: biz }];
    fs.writeFileSync(S('system.yaml'), toYaml(y));
    assert.deepEqual(json(sy(['status'])).rows, []);
  });
  test('a changed business document shows up again', () => {
    fs.appendFileSync(path.join(biz, 'vision.md'), 'More.\n');
    assert.equal(json(sy(['status'])).rows[0].why, '1 changed');
    assert.deepEqual(json(sy(['sources'])).copied, ['biz/vision.md']);
  });
});

describe('the docs portal', () => {
  let r;
  test('(a note with HTML in a scope card)', () => {
    const f = S('modules/patients/module.md');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('_Add your notes here. This block is kept when breakdown rewrites the card._', 'Ask <script>alert(1)</script> and <img src=x onerror=alert(2)> [bad](javascript:alert(3))'));
  });
  test('built from the Markdown people read; never from _state, _map or the fact packs', () => {
    r = json(sy(['portal']));
    assert.equal(r.built, true);
    const files = fs.readdirSync(S('portal'), { recursive: true }).filter((f) => f.endsWith('.html'));
    assert.ok(files.includes('index.html') && files.includes(path.join('modules', 'patients', 'spec.html')) && files.includes(path.join('modules', 'patients', 'diagrams', 'flowchart.html')));
    assert.ok(files.every((f) => !/_state|_map|_facts|checks|labels/.test(f)), files.join(' '));
    const all = files.map((f) => fs.readFileSync(S(`portal/${f}`), 'utf8')).join('\n');
    assert.ok(!all.includes('Fact pack'));
    assert.ok(!all.includes(SECRET_MARKER));
  });
  test('raw HTML in a document is escaped; javascript links are dropped', () => {
    const h = fs.readFileSync(S('portal/modules/patients/module.html'), 'utf8');
    assert.match(h, /Ask &lt;script&gt;alert\(1\)&lt;\/script&gt; and &lt;img src=x onerror=alert\(2\)&gt; bad/);
    assert.ok(!/<script>alert|<img|href="javascript/i.test(h));
  });
  test('links between pages point at the pages; links to files outside the portal become text', () => {
    const cat = fs.readFileSync(S('portal/modules/README.html'), 'utf8');
    assert.match(cat, /<a href="patients\/module\.html">Patients<\/a>/);
    assert.match(cat, /<a href="\.\.\/system\/overview\.html">system overview<\/a>/);
    assert.ok(!cat.includes('links.md'));
    const card = fs.readFileSync(S('portal/modules/patients/module.html'), 'utf8');
    assert.match(card, /<a href="spec\.html">How it works \(functional spec\)<\/a>/);
    assert.match(card, /<details class="dev"><summary>For developers: technical diagrams<\/summary>/);
  });
  test('documents: status line, people layer open, appendices in the "For developers" fold', () => {
    const h = fs.readFileSync(S('portal/modules/patients/spec.html'), 'utf8');
    assert.match(h, /<\/h1>\n<p class="status">Status: Draft, not checked yet · written \d{4}-\d{2}-\d{2}<\/p>/);
    const [people, rest] = h.split('<details class="dev"><summary>For developers: evidence and technical detail</summary>');
    assert.match(people, /<blockquote><p><strong>In short<\/strong><\/p>\n<ul><li><strong>What it does:<\/strong>/);
    assert.ok(!people.includes('Appendix A'));
    assert.match(rest, /<h2 id="appendix-a-evidence">Appendix A\. Evidence<\/h2>/);
    assert.match(rest, /<\/details>[\s\S]*Document control/);
  });
  test('diagrams: Mermaid from one pinned URL, with the text shown when offline', () => {
    assert.match(MERMAID_URL, /^https:\/\/cdn\.jsdelivr\.net\/npm\/mermaid@\d+\.\d+\.\d+\/dist\/mermaid\.min\.js$/);
    const h = fs.readFileSync(S('portal/modules/patients/diagrams/flowchart.html'), 'utf8');
    assert.ok(h.includes(`<script src="${MERMAID_URL}"></script>`));
    assert.match(h, /<pre class="mermaid">flowchart LR\n {2}start\(\(&quot;Start&quot;\)\)/);
    assert.match(h, /className\+=' offline'/);
    assert.match(h, /<details class="dev"><summary>For developers: sources and evidence<\/summary>/);
    assert.ok(!fs.readFileSync(S('portal/glossary.html'), 'utf8').includes('mermaid.min.js'), 'pages without diagrams load nothing');
  });
  test('the home page lists every module, with its documents and diagrams', () => {
    const h = fs.readFileSync(S('portal/index.html'), 'utf8');
    assert.match(h, /<h1>Nadi: documentation<\/h1>/);
    assert.match(h, /<a href="modules\/patients\/module\.html">Patients<\/a><\/td><td>Keeps the list of patients and their details\.<\/td><td>SPEC Draft, BRD Draft, PRD Draft<\/td><td>yes<\/td>/);
    assert.match(h, /Sign-in<\/a><\/td><td>[^<]*<\/td><td>scope card only<\/td><td>not drawn yet<\/td>/);
  });
  test('rebuilt only when what it shows changed; pages no longer made are removed', () => {
    const again = json(sy(['portal']));
    assert.deepEqual([again.built, again.message], [false, 'Portal already up to date: nothing it shows has changed.']);
    assert.equal(json(sy(['status'])).portal.state, 'up-to-date');
    fs.rmSync(S('modules/reports/diagrams/er.md'));
    assert.equal(json(sy(['status'])).portal.state, 'stale');
    assert.equal(json(sy(['portal'])).built, true);
    assert.ok(!fs.existsSync(S('portal/modules/reports/diagrams/er.html')));
    assert.equal(json(sy(['portal', '--force'])).built, true);
  });
  test('the Markdown renderer: tables with escaped bars, nested lists, code', () => {
    const { html } = renderMarkdown('| A | B |\n|---|---|\n| x \\| y | `<b>` |\n\n- one\n  - two\n- three\n\n1. a\n2. b\n\n```js\nif (a < b) {}\n```');
    assert.match(html, /<td>x \| y<\/td><td><code>&lt;b&gt;<\/code><\/td>/);
    assert.match(html, /<ul><li>one<ul><li>two<\/li><\/ul><\/li><li>three<\/li><\/ul>/);
    assert.match(html, /<ol><li>a<\/li><li>b<\/li><\/ol>/);
    assert.match(html, /<pre><code>if \(a &lt; b\) \{\}<\/code><\/pre>/);
  });
});

// ================================================================ definitions and guard
describe('skills, agent and the guard', () => {
  const file = (f) => fs.readFileSync(path.join(PLUGIN, f), 'utf8');
  test('diagram and sync: manual-only, Haiku, low effort, short; details in references', () => {
    for (const s of ['diagram', 'sync']) {
      const t = file(`skills/${s}/SKILL.md`);
      assert.match(t, /^disable-model-invocation: true$/m);
      assert.match(t, /^model: haiku$/m);
      assert.match(t, /^effort: low$/m);
      assert.ok(t.split('\n').length < 60, s);
    }
    assert.ok(fs.existsSync(path.join(PLUGIN, 'references/diagram/diagram-flow.md')));
    assert.ok(fs.existsSync(path.join(PLUGIN, 'references/sync/sync-flow.md')));
    assert.match(file('skills/sync/SKILL.md'), /Never run a conversion command or install anything/);
  });
  test('the labeller: Sonnet, low effort, reads and edits labels.yaml only', () => {
    const t = file('agents/diagram-labeller.md');
    assert.match(t, /^model: sonnet$/m);
    assert.match(t, /^effort: low$/m);
    assert.match(t, /^tools: Read, Edit$/m);
    assert.match(t, /Never change a name that is already there/);
  });
  test('doctor lists the new commands', () => {
    const r = spawnSync(process.execPath, [path.join(PLUGIN, 'scripts/doctor.mjs'), '--dir', G.W], { encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN }, timeout: 60000 });
    for (const c of ['diagram', 'sync']) assert.match(r.stdout, new RegExp(`\`/tech-plugin:${c}\``));
  });
  const env = { HOME: path.join(G.W, 'home') };
  test('the scripts run in a repo on main; the labeller may edit labels.yaml but not code', () => {
    for (const c of [`node "$CLAUDE_PLUGIN_ROOT/scripts/diagram/diagram.mjs" status patients --home "${H}"`, `node "$CLAUDE_PLUGIN_ROOT/scripts/diagram/diagram.mjs" draw system --home "${H}"`, `node "$CLAUDE_PLUGIN_ROOT/scripts/sync/sync.mjs" status --home "${H}"`, `node "$CLAUDE_PLUGIN_ROOT/scripts/sync/sync.mjs" portal --home "${H}"`]) assert.equal(runGuard({ tool_name: 'Bash', cwd: H, tool_input: { command: c } }, { env }).decision, 'pass', c);
    const e = (p) => runGuard({ tool_name: 'Edit', cwd: H, tool_input: { file_path: p, old_string: 'a', new_string: 'b' } }, { env }).decision;
    assert.equal(e(S('modules/patients/diagrams/labels.yaml')), 'pass');
    assert.equal(e(path.join(H, 'app/Http/Controllers/PatientController.php')), 'block:repo-write');
  });
  test('nothing outside sdlc-docs changed; no secret anywhere in sdlc-docs', () => {
    for (const r of [G.backend, G.web, G.mobile]) assert.deepEqual(snapshot(r), before[r]);
    const all = (d) => fs.readdirSync(d, { recursive: true }).filter((f) => fs.statSync(path.join(d, f)).isFile()).map((f) => fs.readFileSync(path.join(d, f), 'utf8')).join('');
    assert.ok(!all(path.join(H, 'sdlc-docs')).includes(SECRET_MARKER));
  });
});

// ================================================================ 0.5.1 fixes
describe('fixes from the 0.5.0 review', () => {
  // edits a file for one check, then puts it back
  const withFile = (f, change, fn) => {
    const keep = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, change(keep));
    try {
      return fn();
    } finally {
      fs.writeFileSync(f, keep);
    }
  };
  const reasons = () => json(dg(['status', 'patients'])).reasons;
  test('(the patients diagrams are up to date)', () => assert.equal(json(dg(['status', 'patients'])).next, 'up-to-date'));

  test('Mermaid ids: two names that would read the same get different ids; the same name keeps its id', () => {
    const id = idRegistry();
    assert.deepEqual([id('s', 'web|admin.users'), id('s', 'web|admin_users'), id('s', 'web|admin.users'), id('m', 'web|admin.users')], ['s_web_admin_users', 's_web_admin_users_2', 's_web_admin_users', 'm_web_admin_users']);
    assert.equal(id('s', 'web|admin_users_2'), 's_web_admin_users_2_2');
  });

  test('PRD requirements: only this module\'s IDs; one marked Removed is not drawn', () => {
    const prd = '# P\n\n### PATIENTS-R01: Ask\nx\n### PATIENTS-R02: Removed (merged into R01)\n### OTHER-R01: Not ours\n### PATIENTS-R03: Show removed patients\ny\n';
    assert.deepEqual(requirementsOf(prd, 'patients').map((r) => [r.id, r.title]), [['PATIENTS-R01', 'Ask'], ['PATIENTS-R03', 'Show removed patients']]);
    assert.deepEqual(requirementsOf('### A.B-R01: Dotted id\n### AXB-R01: Not it\n', 'a.b').map((r) => r.id), ['A.B-R01']);
  });

  test('the diagrams are stale when the BRD changes (PRD evidence points into it)', () => {
    withFile(S('modules/patients/brd.md'), (t) => t.replace('Reports for patients.', 'Reports for every patient.'), () => assert.deepEqual(reasons(), ['the BRD changed (PRD evidence may point into it)']));
    assert.deepEqual(reasons(), []);
  });

  test('the diagrams are stale when another module is renamed or its screens move', () => {
    withFile(S('modules.yaml'), (t) => t.replace(/name: Sign-in/, 'name: Signing in'), () => assert.deepEqual(reasons(), ['the module list changed (a module was renamed, or screens or routes moved)']));
    assert.deepEqual(reasons(), []);
  });

  test('the diagrams are stale when the code map was linked again', () => {
    withFile(statePath(H), (t) => {
      const st = JSON.parse(t);
      st.stages['4'].at = '2001-01-01T00:00:00.000Z';
      return JSON.stringify(st, null, 1);
    }, () => assert.deepEqual(reasons(), ['the code map was read or linked again']));
    assert.deepEqual(reasons(), []);
  });

  test('a stamp from an older renderer gives one reason, not one per new input', () => {
    withFile(S('modules/patients/diagrams/_stamp.json'), (t) => {
      const st = JSON.parse(t);
      st.inputs = { facts: st.inputs.facts, spec: st.inputs.spec, prd: st.inputs.prd, labels: st.inputs.labels, renderer: 1 };
      return JSON.stringify(st);
    }, () => assert.deepEqual(reasons(), ['tech-plugin draws diagrams differently now']));
  });

  test('labels: every screen without a name goes to the labeller, past 80', () => {
    const extra = [...Array(90).keys()].map((i) => ({ app: 'web', id: `extra.page${i}`, file: null, cite: 'web:x:1', labels: [] }));
    withFile(S('modules/patients/diagrams/labels.yaml'), (t) => t, () =>
      withFile(S('modules/patients/_facts.json'), (t) => {
        const p = JSON.parse(t);
        p.screens.push(...extra);
        return JSON.stringify(p);
      }, () => {
        const r = json(dg(['labels', 'patients']));
        assert.deepEqual([r.todo, r.screens.length], [90, 90]);
      }));
  });

  test('the review checklist reads the diagram state even before the fact pack is written', () => {
    const f = S('modules/patients/_facts.json');
    const keep = fs.readFileSync(f, 'utf8');
    fs.rmSync(f);
    try {
      ok(runScript('document', 'signoff.mjs', ['checklist', 'patients', '--home', H]));
      assert.match(read('modules/patients/checks/review-checklist.md'), /it matches the code and the documents\./);
    } finally {
      fs.writeFileSync(f, keep);
    }
  });

  test('document status and sync use the same freshness rule', () => {
    const st = JSON.parse(ok(runScript('document', 'doc.mjs', ['status', 'patients', '--home', H])));
    const pack = buildFacts(H, 'patients');
    for (const doc of ['spec', 'brd', 'prd']) assert.equal(docFreshness(H, 'patients', doc, pack).state, st.docs[doc].state, doc);
    assert.equal(docFreshness(H, 'auth', 'spec', buildFacts(H, 'auth')).state, 'missing');
  });

  test('business documents: two folders with the same name do not overwrite each other', () => {
    const one = path.join(G.W, 'team1', 'plans');
    const two = path.join(G.W, 'team2', 'plans');
    put(path.join(one, 'plan.md'), '# Plan one\n');
    put(path.join(two, 'plan.md'), '# Plan two\n');
    const y = parseYaml(read('system.yaml'));
    y.docs = [{ path: one }, { path: two }, { path: one }];
    fs.writeFileSync(S('system.yaml'), toYaml(y));
    const r = json(sy(['sources']));
    assert.deepEqual(r.copied.sort(), ['team1-plans/plan.md', 'team2-plans/plan.md']);
    assert.deepEqual([read('sources/team1-plans/plan.md'), read('sources/team2-plans/plan.md')], ['# Plan one\n', '# Plan two\n']);
  });

  test('business documents: the conversion command quotes file names, so the shell runs nothing in them', () => {
    const dir = path.join(G.W, 'odd');
    const name = "it's $(touch PWNED) `touch PWNED2`.pdf";
    put(path.join(dir, name), '%PDF-1.4\n');
    const y = parseYaml(read('system.yaml'));
    y.docs = [{ path: dir }];
    fs.writeFileSync(S('system.yaml'), toYaml(y));
    const r = json(sy(['sources']));
    assert.equal(r.toConvert.length, 1);
    const cmd = r.toConvert[0].command;
    assert.ok(cmd.startsWith('uvx markitdown '), cmd);
    // the same words, printed instead of converted
    const p = spawnSync('sh', ['-c', cmd.replace(/^uvx markitdown /, "printf '%s\\n' ")], { cwd: G.W, encoding: 'utf8' });
    assert.deepEqual(p.stdout.split('\n'), [path.join(dir, name), '-o', S(`sources/odd/${name}.md`), '']);
    assert.ok(!fs.existsSync(path.join(G.W, 'PWNED')) && !fs.existsSync(path.join(G.W, 'PWNED2')));
  });
});

describe('code changed since the breakdown', () => {
  test('sync and diagram stop and ask for a breakdown refresh', () => {
    fs.appendFileSync(path.join(G.web, 'app/Http/Controllers/PatientPageController.php'), '// changed\n');
    const s = json(sy(['status']));
    assert.equal(s.next, 'breakdown');
    assert.match(s.message, /^Run \/tech-plugin:breakdown --refresh first: Code changed since stage 3 in: web\./);
    assert.equal(json(dg(['status', 'patients'])).next, 'breakdown');
  });
});
