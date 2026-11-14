# Changelog

All notable changes to tech-plugin. Versions follow semantic versioning; the version is set only in `.claude-plugin/plugin.json`.

## 0.9.0 (2026-11-14)

Build step 10 of 11: `release`, `incident`, `status` and `doctor --ci`.

### Added

- **`/tech-plugin:release [version] [IDs]`** writes `releases/<version>/`:
  - **checklist.md**, worked out by script:
    - ❌ when an item is not tested on its current cases, has an open blocking defect, has nothing committed, or is not merged (a squash merge counts);
    - ⚠️ for known issues, migrations, new settings, changed dependencies, and documents that may not match the merged code;
  - **release notes** and a **runbook** with deploy and rollback steps (`ops-writer`), checked for every item, known issue and flag;
  - **smoke.md**: checks a person does by hand on production;
  - **go-no-go.md**, a recommendation from `release-reviewer` (Opus); "Go" is refused while there is a ❌.

  The version is proposed from the last tag. `finish` marks the items released and gives the tag commands. **The plugin never deploys, tags or pushes, and nothing is signed off.**
- **`/tech-plugin:incident`** writes `incidents/<date>-<name>/`:
  - the evidence you paste, with keys and personal data masked;
  - the likely cause from the modules, the commits since the last tag and the last releases (`incident-investigator`, Opus), with a confidence and a way out: rollback (the last runbook) or hotfix (a bug work item from the release tag);
  - when resolved, a blameless postmortem with actions for roles.

  It never connects to production. `/tech-plugin:next` puts an open incident first.
- **`/tech-plugin:status [ID]`** shows where every work item (by phase), defect, incident, release and module stands. With an ID, it continues that item (`next.mjs --item`).
- **`/tech-plugin:doctor --ci`** writes a GitHub Actions workflow to `sdlc-docs/ci/tech-plugin.yml`, for you to copy into `.github/workflows/`. On each PR it posts one comment: the parts of the product touched, their risk, the documents citing the changed files, secret files changed, and a gitleaks scan with values never shown. It runs by script, without Claude. An AI security review (`anthropics/claude-code-action@v1` with tech-plugin, `/tech-plugin:ci-check`) is optional.
- **Work items** end with `tested → released`. `/tech-plugin:next` offers a release for tested items, ahead of a new breakdown.
- **Tests:** `tests/release-tests.mjs` (24 tests); 939 in all.

### Changed

- `impact.mjs`: `rankModules` and `moduleFiles` are shared with incidents and CI. The handoff records each repo's branch, for the release's merge check.

## 0.8.0 (2026-11-14)

Build step 9 of 11: `test-cases` and `test-run`.

### Added

- **`/tech-plugin:test-cases <ID | module>`**: `test-designer` writes `tests/test-cases.md`, for a work item from its requirements and plan, or a module's regression suite from its PRD.
  - Each case covers a requirement and has a type (automated, api, ui, manual, perf, mobile), tags (sanity, regression), steps or a command, and what to expect, with made-up test data.
  - `tests.mjs check`: every requirement has a case, API routes exist, no installs or git in commands, no framework command the guard blocks, no personal data.
- **`/tech-plugin:test-run <ID | module> [--sanity|--regression] [--env <name>]`**:
  - runs repo tests (`test-runner`), API calls with curl, browser steps with the Playwright tools (`ui-tester`) and manual cases you answer, against a test environment;
  - **never production**: environments marked production in `system.yaml` are refused;
  - skips, with the reason, what cannot run (no environment URL; k6 or Maestro missing);
  - repo tests of a work item reopen its gate only when `APPROVED` still matches the plan on a feature branch, and close it after. Otherwise you run them, and a JUnit results file is read;
  - failures become defects (`defect-triager`, `DEF-<X>-NN`) in `tests/defects.md`, sent to Zoho Sprints only after your yes; `/tech-plugin:task DEF-…` makes a linked bug work item;
  - writes `test-report.md` (Passed, Failed or Incomplete) and `rtm.md` (requirement → cases → result → defects). No QA sign-off;
  - a defect whose cases pass is marked fixed;
  - a passing work item's regression cases join its modules' suites when they map to a module requirement.
- **Work items** continue after the handoff: `test-cases → test-run → fix-defects → tested`. `/tech-plugin:next` follows them, keeps an item in testing ahead of a new breakdown, and finally suggests a regression suite for each documented module.
- **`/tech-plugin:doctor`** shows the test tools: browser tools for UI tests, k6, Maestro.
- **Tests:** `tests/test-tests.mjs` (28 tests), and a plan check for blocked framework commands in `build-tests.mjs`; 915 in all.

### Changed

- **Plans and test cases flag framework test commands the guard blocks** (`php artisan test`, `python manage.py test`, `rails test`) and name the runner to use instead (`vendor/bin/phpunit`, `vendor/bin/pest`, `pytest`). The guard's rules are unchanged.
- **The personal-data check** now catches a phone number at the end of a sentence ("call 9876543210."). Numbers 9000000000–9000000999 are kept for made-up test data.
- Shared command patterns moved to `scripts/work/patterns.mjs`.

## 0.7.0 (2026-11-14)

Build step 8 of 11: `task`, `implement`, `review` and the three worker tiers.

### Added

- **`/tech-plugin:task <ID | "bug in words" | Zoho bug>`** plans the build in `work/<ID>/plan.md` (`references/work/plan-template.md`).
  - Steps `<ID>-T01…`, each with what it covers, its files (`repo:path` change, new or delete), what to do and the check that proves it.
  - Plus what will change, risks and how to undo it, and open questions.
  - A feature is planned after its requirements are approved (and its design, unless Quick).
  - **A bug skips impact, requirements and design**, is Quick, and its plan's first step is a test that fails because of the bug.
  - `task` writes `sdlc-docs/work/.active` and prints the two commands the person runs in their own terminal: a feature branch, and `APPROVED` holding the plan's hash.
- **`/tech-plugin:implement <ID>`** builds an approved plan step by step.
  - A worker changes only the step's files and runs its check through Bash, where the guard sees it.
  - Results go to `work/<ID>/checks/` (keys hidden) and `progress.json`, so a later run continues.
  - It stops with the install command when a step needs a package.
  - **A plan changed after approval is not approved**: implement stops and prints the new `APPROVED` line.
- **`/tech-plugin:review <ID>`**:
  - collects what changed since the plan's base commits (`sdlc-docs/` left out, new files included, secret files skipped and listed, unplanned files flagged);
  - has `code-reviewer` (Sonnet, high) and `security-reviewer` (Opus, high) read it in parallel;
  - has a worker fix blocking findings (at most two rounds);
  - writes `work/<ID>/handoff.md` (what changed, how to check it by hand, open points, files, steps and checks, reviews) and a ready commit message with the commands for the person;
  - closes the gate by removing `.active`.
- **Worker tiers:** `worker-light` (Haiku, low), `worker-standard` (Sonnet, medium) and `worker-deep` (Opus, high), with the rules for each job in `references/work/worker-rules.md`.
  - `build.mjs tier` picks one: standard by default; deep for High or Critical risk; never deep for a Quick item; up one tier after two failures; it stops at the top.
  - `sdlc-docs/config.json` may map a tier to another agent (`"tiers"`).
- **`scripts/work/build.mjs`:** `prepare`, `approval` (the guard's own `gate()` plus the plan hash), `progress`, `tier`, `record`, `changes`, `save-review`, `handoff`.
- **Tests:** `tests/build-tests.mjs` (39 tests): a bug from its words to the handoff, with the gate checked against the real guard. 886 tests in all.

### Changed

- **Work items** have a kind (`work.mjs new --kind bug`). The next step after planning runs `task → approve-plan → implement → review → done`. `work.mjs decide` accepts `--doc plan`.
- **A build's own code changes** no longer send it back to the breakdown or the plan. `/tech-plugin:next` continues a build in progress before suggesting a new breakdown.
- `check-work.mjs` checks plans too.

## 0.6.0 (2026-11-13)

Build step 7 of 11: `impact`, `requirement` and `design`. Also: easier to use (`/tech-plugin:next`, `document` in one go), draw.io files for every diagram, no sign-off for module documents, and a shorter README.

### Added: `/tech-plugin:next`, the one command to remember

- **`/tech-plugin:next`** works out the next step from the files in `sdlc-docs/` and runs it after a yes (`/tech-plugin:next yes` skips the question). In order: restart after a plugin update; the breakdown (missing, half done, or the code changed); `sync` when documents or diagrams no longer match the code; a work item waiting for its impact, requirements or design; the system diagrams; the next module in the suggested order whose documents are not all Checked or whose diagrams are not drawn, with "N of M modules documented and checked"; the docs website; then "Everything is up to date". It follows the chosen command's own instructions, so their rules and approvals apply.
- `scripts/next.mjs` makes the choice, so it is the same every time.
- **The session banner** ends with `next: /tech-plugin:next`. **`/tech-plugin:doctor`** shows a short "How to use" before the command list.

### Changed: `document` does the whole module in one go

- **`/tech-plugin:document <module>`** writes the spec, BRD and PRD, then checks them (what `validate` does) and draws the diagrams (what `diagram` does), and ends with each document Checked or Draft. When the documents already match the code it goes straight to the checks.
- `--write-only` stops after writing. With `spec`, `brd` or `prd` it writes and checks that one document and does not draw.
- `validate` and `diagram` stay, for redoing one part.

### Added: draw.io files for every diagram

- **Every diagram is written twice:** Mermaid, as before, and a `.drawio` file beside it, converted from that Mermaid by `scripts/diagram/drawio.mjs`. That covers the module flowchart, sequences and ER, the system block diagram and journeys, and the module map. Each Mermaid block is one page. Open the files in the draw.io app or diagrams.net.
- **Layout by script**, as draw.io does not place boxes itself: flowcharts in columns left to right (by the longest path from a start box, loops ignored), arrows to the next column running between the columns; sequence diagrams as lifelines with the messages in order and notes; tables as boxes listing their columns, with one-to-many links.
- **A `.drawio` you rearranged is never overwritten.** `_drawio.json` records what the plugin wrote; a redraw that finds a different file writes `<name>.new.drawio` beside it and says so. Delete your copy to get the plugin's back.
- A missing `.drawio` makes the diagrams stale. The diagram renderers moved on (module 3, system 2), so every diagram is redrawn once, by script, with no model cost; screen names are kept.
- Checked with the draw.io app's own export: the flowchart, sequence and ER pages open and draw.

### Changed: no sign-off for module documents

- **`/tech-plugin:validate` ends at Checked.** The checks are the same: script checks, the readability review, 1–3 doc-checker passes (two for critical modules), and the writer's fixes. A document becomes **Checked** by itself once its last pass is on its current text and clean (or the leftovers are recorded as known issues), the readability review is done, and `check-doc.mjs` and `plain.mjs` pass. The stamp records `checked: {on, hash, pass, known}`. A Checked document that changes counts as a Draft again until validate checks it.
- **Removed:** `signoff.mjs approve`, the owner/PO sign-off of the people layer and the developer sign-off of the technical layer, the Reviewed status, and "a critical module waits for a decision on every open question". Validate never asks who you are or for a yes.
- **Known issues** no longer need a developer to accept them: they are listed in `checks/<doc>-known.md` and the next rewrite fixes them. A key or personal data is still never accepted.
- **Open questions** stay in the documents. `signoff.mjs decide` records an answer only when someone gives one; nothing waits for it.
- **`modules.yaml` `doc_status`** is `none`, `draft` or `checked`.
- **Documents Approved before 0.6** keep their status, and still pass `check-doc.mjs`, until their text changes. Then they become Drafts, and validate can mark them Checked.
- `check-doc.mjs`: status is Draft or Checked; Checked needs a check record, so a writer cannot set it. A change after the check is a warning, not a failure, so the writer's fixes still pass.
- `review-checklist.md` lists each document's status, checks and open questions, with no approver columns. The portal shows "Checked on <date>" or "Draft, not checked yet". `sync` and the impact pack say "Checked" instead of "approved".
- Tests: the sign-off tests are replaced by Checked tests. With `tests/next-tests.mjs` and the draw.io tests, 847 tests in all.

### Changed: README

- **`README.md` is a short guide for people using the plugin:** install, the four ways to use it with the exact commands, every command with an example, what it never does, and what to do when something goes wrong.
- **`REFERENCE.md`** keeps the full detail (stages, checks, guard rules, settings, tests, layout) for people who build or troubleshoot the plugin.

### Added

- **Work items:** one folder per piece of new work, `sdlc-docs/work/<ID>/`, with `request.md`, `status.json` (level, modules, each document's state, the next step) and `decisions.md`.
  - The ID is the Zoho Sprints item number when there is one, otherwise `W-001`, `W-002`…
  - Zoho Sprints is only read.
  - Request text and answers go through files, never through a command line. A request holding a phone number, email or key is refused.
- **`/tech-plugin:impact <ID | "request">`** writes `impact.md` and `impact-report.html`.
  - A script ranks modules by the words they share with the request; rare words count more.
  - The new `impact-analyst` agent (Opus, high) chooses the modules. A script builds the impact pack for them: routes, screens, what they ask other servers for, other apps that call them, tables shared with other modules, risk flags, approved documents that would go back to Draft, and code the graphify graph groups with them (Inferred).
  - The document gives the parts it touches, who notices, risk (Low to Critical), size (S to XL), the proposed level (Quick, Standard or Full) and open questions, with every statement cited.
- **`/tech-plugin:requirement <ID>`** writes `requirement.md`.
  - `requirement-analyst` (Opus, high) writes requirements `<ID>-Rnn`: Given/When/Then criteria, a source, and the module requirement each changes or "new". Every gap becomes a question for a role.
  - The person's answers are recorded as decisions, and the requirements are updated.
  - `story-writer` (Sonnet, medium) adds user stories `<ID>-Snn`, covering every requirement.
  - The owner, PO or BA approves.
- **`/tech-plugin:design <ID>`** writes `design.md`.
  - `design-architect` (Opus, high) writes the approach and the decisions `<ID>-Dnn` (ADRs: context, options, decision, consequences).
  - `design-writer` (Sonnet, medium) writes the screen changes, API and data changes, and the requirement coverage.
  - A developer or tech lead approves. A Quick item needs no design.
  - `sdlc-docs/decisions/README.md` lists every decision; it is Accepted once its design is approved.
- **`check-work.mjs`** checks each document: template headings, "In short" values and counts, tags, citations, IDs and coverage, keys and personal data, and freshness. Approval is refused while a check fails, a question has no answer, or the document is out of date. An approval holds only for the exact text approved.
- **Tests:** `tests/work-tests.mjs` (39 tests).

### Changed

- **`plain.mjs`** reads only the labels of a Mermaid diagram in the people layer, and treats work-item IDs (`W-001-R01`) as IDs.
- **Open questions** may be addressed to a tech lead or architect.
- The citation check is shared: `checkCitations` in `check-doc.mjs`.
- The portal's stylesheet is exported for the impact report.

## 0.5.1 (2026-11-13)

Fixes from a code review of 0.5.0.

### Fixed

- **`sync` conversion commands quote file paths with single quotes.** A business document named with `$(...)`, backticks or quotes could run a command when you pasted the `uvx markitdown` line into a shell.
- **Two `docs:` folders with the same name no longer overwrite each other** in `sdlc-docs/sources/`. When names clash, each folder is stored under its path (`docs/business` → `docs-business`). A folder listed twice is read once.
- **Diagrams go stale when more of what they draw from changes:** the BRD (PRD evidence can point into it), the module list (another module renamed, or screens or routes moved between modules), and the code map (read or linked again). Before, they could stay "Already up to date" while showing old boxes or tables.
- **Mermaid node ids are unique.** Screens such as `admin.users` and `admin_users` were drawn as one box. The second now gets its own id. The block and ER diagrams use the same rule.
- **Sequence-diagram participants are keyed by app and screen** (`S_web_patients_index`), so two apps with a screen of the same name stay apart.
- **Sequence diagrams read only this module's requirements** (`<MODULE>-Rnn`, as `validate` does) and skip any marked `Removed (reason)`.
- **`diagram labels` sends every unnamed screen to the labeller.** Before, only the first 80 were sent.
- **The review checklist** gave the business flowchart as out of date when the module's fact pack had not been written yet. It now computes the facts.

### Changed

- **Every module diagram is redrawn once** after this update: the drawing changed (node ids, participants). `diagram` and `sync` give one reason, "tech-plugin draws diagrams differently now".
- `document status` and `sync` share one rule for whether a document is current (`docFreshness` in `doc.mjs`). The portal reads tables with the diagram scripts' table reader.
- **Tests:** 12 more in `tests/diagram-tests.mjs` (60 in all).

## 0.5.0 (2026-11-13)

Build step 6 of 11: `diagram` and `sync`.

### Added

- **`/tech-plugin:diagram <module>`** draws, in `modules/<id>/diagrams/`:
  - `flowchart.md`, in the people layer: screens in business words, arrows from links, buttons and forms, and other modules as their own box. A module with more than 25 screens is drawn in parts, grouped by folder.
  - `sequences.md`, technical: one sequence diagram per PRD requirement whose evidence reaches an API. It runs from the page to the app, the backend and its tables, with a source for every step.
  - `er.md`, technical: the module's tables. Links between tables are Inferred from `*_id` columns.
  - `labels.yaml`: the screen names, which people can edit. Names come from the spec's Screens table where a row points at one screen; the new `diagram-labeller` agent (Sonnet, low) writes the rest. A script checks every name for plain words.
  - `_stamp.json`: "Already up to date" until the code facts, the spec, the PRD or a name change.
- **`/tech-plugin:diagram system`** draws `system/diagrams/block.md` and `journeys.md`.
  - The block diagram shows apps, databases, a backend outside the breakdown, external services, and who asks whom for data.
  - The journeys are the key flows in `system.yaml`. A step between two modules the code does not link is drawn dashed.
- **`/tech-plugin:sync`**:
  - stops with "run `/tech-plugin:breakdown --refresh` first" when the code map is stale;
  - lists out-of-date documents and diagrams, and refreshes the ones you pick. Documents go through the document flow, with a warning first that an Approved one becomes a Draft. Diagrams are redrawn by script;
  - picks up business documents from the `docs:` folders in `system.yaml`. `.md` and `.txt` files are copied to `sdlc-docs/sources/`; for other files it prints a `uvx markitdown` command for you to run;
  - rebuilds the portal.
- **The docs portal**, `sdlc-docs/portal/index.html`: static pages that open from disk.
  - It has its own Markdown renderer, which escapes raw HTML, and loads Mermaid from a pinned jsDelivr URL, showing the diagram text offline.
  - Appendices sit in a "For developers" fold. It never includes `_state/`, `_map/` or the fact packs.
  - It is rebuilt only when what it shows has changed.
- **Tests:** `tests/diagram-tests.mjs` (48 tests).

### Changed

- **The review checklist** (`checks/review-checklist.md`) now includes the business flowchart: the owner or PO reads it with the people layer. It has no separate sign-off.

### Fixed

- **README:** the commands table had a blank line in it, which cut it short.

## 0.4.3 (2026-11-12)

Fixes from validating the Frontend's `reports` module, which took 23 deep code checks (spec 9, BRD 8, PRD 6) and never settled on its own.

### Changed

- **`validate` settles.**
  - **At most 3 code checks per document per round.** `save-check` refuses a 4th. A round starts when `/tech-plugin:document` writes the document.
  - **Later checks are focused.** The first check of a round reads everything. Later ones re-check only the last report's items and the lines changed since (`--mode focused`). The checker agents have a focused mode.
  - **Known issues.** When no pass is left, `signoff.mjs known` records the leftovers in `checks/<doc>-known.md`. Approval accepts them, the developer is shown them, and the next rewrite gets them to fix. Risk items (keys, personal data) are never accepted.
  - **Spec first.** A BRD or PRD check is refused until the documents it is written from are settled and it is stamped from their current text.
  - **A settled document that changes later** (for example, a spec fix found by a BRD check) gets one focused check per change, even past the limit.
- **`input-changed` no longer means a rewrite in `validate`.**
  - New `doc.mjs changes` lists this document's changed lines since its last check, and the input's changed lines since it was stamped, with the IDs they mention.
  - The writer updates only the dependent lines.
  - New `doc.mjs restamp` records the input's new version. If the text didn't change, its checks still count.
- **Writers in fix mode** state a code value's meaning (a status of 1, a flag) as fact only when the product shows it. Otherwise they say "probably" or ask. This was the main source of new findings on every pass.
- **The readability review runs once per round.**

### Fixed

- **Recording a decision no longer makes every document "facts-changed".** Before, the next `validate` session stopped before sign-off once any question had been answered. Decisions still ride in the fact pack for the next rewrite. Hashes of fact packs without decisions are unchanged, so current documents stay current.

## 0.4.2 (2026-11-12)

### Added

- **`breakdown`, `document` and `validate` stop when a newer tech-plugin is installed than the session runs.** After `/plugin update` in an open session, Claude Code keeps running the old copy, and a command can quietly give old results ("already up to date"). They now say "Quit Claude Code and start a new session" instead (`scripts/lib/version.mjs`).

## 0.4.1 (2026-11-11)

Fixes from reviewing the first real documents (the Frontend's `reports` module).

### Fixed

- **Pages that open a route through a form or link** (`<form action="{{ url('report/viewVisitReport') }}" method="POST">`, `href`, `route()`) now count as using it. Before, those routes were reported as used by nothing, and the documents repeated that. On the Frontend, routes nothing uses went from 217 to 35, and 103 are opened from a page.
  - `links.md` counts these routes separately.
  - The fact pack names the page that opens each route.
  - The reader version is now 3, so `/tech-plugin:breakdown` re-reads the code once.

### Changed

- **Questions are asked once across spec, BRD and PRD.** A later document points back with `[spec Q6]` or `[brd Q2]` (checked by `check-doc`). The aim is at most 10 questions per document.
- **The people layer may not mention the documentation tools** ("the scan", "fact pack", "approved purpose"…). `plain.mjs` fails on them.
- **Clearer writing rules** for the "In short" key rules (full plain sentences), for certainty ("probably", never "(Inferred)"), and for plain verbs.
- **`/tech-plugin:document` stops when the breakdown is not current**, so documents are never written from outdated code facts.

## 0.4.0 (2026-11-11)

Build step 5 of 11: `document` and `validate`.

### Added

- **`/tech-plugin:document <module> [spec|brd|prd]`** writes the functional spec, BRD and PRD, in that order. Each document has two layers:
  - **People layer:** an "In short" box, plain words, and a tag on every statement.
  - **Evidence and technical layer:** Appendix A gives each tag its source as `repo:path:line` and its class; Appendix B holds the technical detail.

  Anything not provable becomes a question for a named role. Requirement IDs (`BR-01`, `<MODULE>-R01`) are never renumbered or lost.
- **Fact pack** (`scripts/document/doc.mjs facts`): the module's routes, access checks, validation rules, messages, page labels (translations resolved), backend calls, tables, services, unused routes and recorded decisions. Every fact is cited, and code text is redacted for keys and personal data.
- **Freshness:** "Already up to date" when nothing changed; a rebuild, with what changed, when the code changed; a question before rebuilding a BRD or PRD after the spec changed.
- **`/tech-plugin:validate <module>`** runs:
  - `check-doc.mjs` (structure, tags, IDs, citations, secrets, personal data, staleness);
  - `plain.mjs` (no code in the people layer; warnings for long sentences, jargon and missing glossary terms);
  - the readability reviewer, then the doc-checker. The writer fixes what they find.

  It then records sign-offs. The owner, PO or BA approves the people layer (Reviewed), and a developer approves the technical layer (Approved). A critical module needs two checker passes and a decision on every open question. Check reports and sign-offs apply to one exact text.
- **Agents:**
  - `doc-writer` (Sonnet, medium) and `doc-writer-deep` (Opus, high, for money, security or clinical modules);
  - `doc-checker` and `doc-checker-deep` (read-only);
  - `readability-reviewer` (read-only).
- **Supporting tools:** `scripts/document/glossary.mjs` adds terms once. `scripts/lib/redact.mjs` covers keys and personal data (emails, phone numbers, Aadhaar- and PAN-like numbers), and `scripts/lib/frontmatter.mjs` reads and writes document stamps.
- **Tests:** `tests/document-tests.mjs` (69 tests).

### Changed

- **`links.md`** counts pages people open directly (GET page routes, routes that render a page) apart from routes nothing calls.
- **Error prefix:** script errors start with "tech-plugin:".

## 0.3.2 (2026-11-11)

### Changed

- Calls to a backend outside the breakdown are reported as information only. Each repo's breakdown is complete on its own, and breakdown no longer suggests adding other repos.

## 0.3.1 (2026-11-11)

Fixes from the first real run, on a Laravel web app whose backend was not part of the breakdown.

### Fixed

- **Server code no longer links to its own app's routes.** A PHP controller calling `config('app.backend_url') . '/patients'` had been matched to the app's own `GET patients` page, which gave hundreds of false matches and method mismatches.
  - Server-side calls are now matched only against other apps.
  - When no app in the system serves them, they are reported as "calls to a backend that is not in this system", not as likely bugs.
- **Tighter route matching.** A route made of parameters (`deleteReport/{a}/{b}`) no longer matches an unrelated call by its tail: a partial match needs at least one fixed word in common.
- **Calls to an outside host** (for example an AWS Lambda URL) never match the app's own routes.
- **Constant lookup.** A constant is matched by its last word only for constants holders (`StringsConst.login`, `ROUTES.x`, `config()`, `window`). `event.target` no longer matches an unrelated `target` constant, so `Map.delete(...)` is no longer counted as an API call.
- **Blade `$.ajax` calls** are counted once instead of twice.
- **Vendored libraries** copied into `public/js` (`jquery-*.js`, `bundle.js`, `external/`, `cdn/`…) are skipped by name. This drops their false services (Stripe) and hosts.
- **Reasons for unresolved calls** no longer copy any code text.

### Added

- **More URLs worked out:**
  - local variables assigned earlier in the same function (`$apiUrl = config(...) . '/x'`);
  - properties set in a constructor (`$this->apiUrl`);
  - project URL helpers called with a literal path (`$this->backendUrl('/x')`);
  - ternaries, one call per branch;
  - `window.x = "{{ route('name') }}"` and `const x = "{{ route() }}"` set in Blade;
  - query-string variables, which now end the path (`'/page' + buildQuery(...)`).
- **Page scripts:** a script loaded by exactly one Blade page (`<script src="{{ asset('js/x.js') }}">`) credits its calls to that page.
- **Reader version stamp:** facts read by an older reader are read again after a plugin upgrade. The links, the module refresh (no new approval when no route moved) and the documents follow, so "Already up to date" never hides results from an older reader.

## 0.3.0 (2026-11-11)

Build step 4 of 11: `breakdown` stages 3–6.

### Added

- **Stage 3, read the code** (`scripts/breakdown/map.mjs`): one common fact format per app (routes, handlers, screens, API calls, tables, external services), every fact cited `path:line` and marked Verified or Inferred. Readers in `scripts/lib/readers/`:
  - **Laravel / Lumen:** a port of the atreya route parser, extended with Laravel 11 `bootstrap/app.php`, included route files, `only`/`except` and nested resources. Also controllers, models, migrations and Blade.
  - **Flutter:** GoRouter, MaterialApp, GetX and auto_route.
  - **Node:** Express, Fastify, Koa, hapi and NestJS, with mount prefixes followed across files, plus the JS ORMs.
  - **Web:** Next.js (both routers), Nuxt, SvelteKit, Remix, and React, Vue and Angular route tables.
  - **Python:** FastAPI, Flask, Django and DRF, with SQLAlchemy, Django models and Alembic.
  - **Spring:** controllers, Feign clients and JPA.
  - **Generic fallback:** Go and Rails routes, and graph groups.
  - **API calls:** worked out statically through base-URL names and constants across files; anything left over is listed as unresolved.
  - **External services:** file and line only.
- **The graphify code graph** (`scripts/lib/graph.mjs`): built offline and code-only on a temporary copy of the repo, with secret files left out by the guard's rules. It is kept in `sdlc-docs/_map/graphify/<repo>/` with a commit stamp and rebuilt only when the code changes.
- **Stage 4, link the apps** (`link.mjs`): screen → API → route → handler → tables across apps. `links.md` lists calls with no route, routes nothing calls, and calls that need a person. Your fixes go in `_map/overrides.yaml`, which scripts never rewrite.
- **Stage 5, propose modules** (`modules.mjs`, the `module-proposer` agent on Opus with high effort): plain names, a one-line purpose and risk flags.
  - **Coverage rule:** a script enforces that every backend route is in exactly one module or unassigned with a reason.
  - **Approval:** `modules.yaml` is written only after the person's yes and records who approved it.
  - **Stable ids:** ids never change, and dropping an approved module needs `--allow-remove`.
- **Stage 6, write the breakdown** (`catalogue.mjs`, scripts only): the module catalogue with the suggested order of next steps, one scope card per module (your notes block is kept), the system overview, and the Mermaid module map with evidence for every arrow. Domain words found in code are added to the glossary as "to be confirmed".
- **Tests:** `tests/map-tests.mjs` (89 tests) on fixtures with real code, including a Go service; `tests/fake-graphify.mjs`; and a real-graphify test that is skipped when graphify isn't installed.

### Changed

- **Reruns.** A manifest change sends a repo back to stage 2. A code change re-runs stage 3 for that repo only, and the module list is refreshed without asking if no route or screen moved. "Already up to date" now covers all six stages.
- **`sdlc-docs/README.md`** lists the new files.

## 0.2.0 (2026-11-10)

Build step 3 of 11: `breakdown` stages 1–2.

### Added

- **`/tech-plugin:breakdown`** (stages 1–2 of 6; Haiku, low effort, manual-only):
  - **Stage 1** finds the repos and apps. It asks five business questions, proposes the home repo, asks before creating `sdlc-docs/`, and writes `system.yaml`, a glossary seed, a `README.md` index and pointer files in the other repos. Git URLs get a clone command for the person to run.
  - **Stage 2** detects each app's stack, entry points, commands, tests, database, external services, CI and Docker. The facts go to `_map/<repo>/stack.json` with `repo:path:line` citations, and `profile.md` is written for the person to confirm or correct.
- **`stack-detector` agent:** read-only, Haiku. It writes architecture and convention notes per app, with citations.
- **Saved progress** in `sdlc-docs/_state/breakdown.json`. A rerun with no code change answers "Already up to date"; a new commit or a changed manifest re-runs stage 2 for that repo only. Options: `--only`, `--refresh`, `--docs`.
- **New scripts:**
  - `scripts/lib/stacks.mjs`: stack detection for about 20 frameworks plus a generic fallback;
  - `scripts/lib/yaml.mjs`: a small YAML reader and writer;
  - `scripts/lib/secretnames.mjs`: secret-name rules, now shared by the guard and the scripts.
- **Tests:** four golden fixtures and 63 breakdown tests, covering detection, the stage flow, never reading secrets, and never writing outside `sdlc-docs/`.

### Changed

- The guard's secret-name matching moved to `scripts/lib/secretnames.mjs`. Its behaviour is unchanged, and all guard tests still pass.

## 0.1.0 (2026-11-10)

Build step 2 of 11: skeleton, safety guard, session banner and `doctor`.

### Added

- Local marketplace `tech-ai-plugins` at the repo root with one plugin, `tech-plugin`.
- **Safety guard** (`scripts/guard.mjs`): a fail-closed `PreToolUse` hook on every tool call, in Node.js with no dependencies, ported from the atreya guard and driven by config instead of project names. Rules:
  - `secrets`: secret files are never read, searched or edited.
  - `repo-write`: repos are writable only under `sdlc-docs/` until a work item is approved on a feature branch.
  - `git`: git is limited to read-only commands.
  - `installs`: package installs are blocked inside repos.
  - `prod-hosts`: blocked hosts can't be reached.
  - `zoho`: every Zoho Sprints write asks first.
  - `self-protection`: covers APPROVED files, the plugin, Claude Code settings, shell startup files and PATH folders.
  - `safe-commands`: framework commands run from a safe list only.
  - Personal-data guard: marked TODO for a later step.
- Bash analysis covers chains, substitutions, redirections, here-documents, wrappers (`env`, `sudo`, `xargs`, `nohup`…), `bash -c`, scripts, variables, brace expansion, `cd` tracking, symlinks, hard links and case tricks.
- **Project settings**: `<repo>/sdlc-docs/config.json` merged over `config/defaults.json`. It can only add restrictions.
- **Session banner** (`scripts/banner.mjs`): one `systemMessage` line with the version, repo, sdlc-docs status and guard status. It never blocks.
- **`/tech-plugin:doctor`**: Haiku, low effort, manual-only. It checks:
  - Claude Code, node, git, Python, uv and graphify, with the install command when graphify is missing and a reminder not to run `graphify install`;
  - LSP plugins per detected language;
  - whether `CLAUDE_CODE_EFFORT_LEVEL` is set;
  - Zoho Sprints;
  - the guard, with a self-test.

  It also lists the commands. `doctor --ci` is a placeholder.
- Tests: `node --test tests/`. The guard tests run 420 cases through the real hook command, plus speed and message-format checks. The doctor tests cover detection and the banner.
