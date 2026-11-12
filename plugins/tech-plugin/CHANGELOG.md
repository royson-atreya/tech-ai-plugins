# Changelog

All notable changes to tech-plugin. Versions follow semantic versioning; the version is set only in `.claude-plugin/plugin.json`.

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
