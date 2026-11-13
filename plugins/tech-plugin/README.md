# tech-plugin

An SDLC/STLC toolbox for Claude Code that takes any software project from "understand what we have" to "release it safely", with a person approving every important step. Commands are `/tech-plugin:<command>`; each product repo gets its own notebook folder, `<repo>/sdlc-docs/`.

**Status: 0.5.1, build step 6 of 11.** This version contains the safety guard, the session banner, `doctor`, `breakdown`, `document`, `validate`, `diagram` and `sync`. The other commands come in later steps (see `docs/PLAN.md` in the marketplace repo).

## Install from the local marketplace

The marketplace `tech-ai-plugins` lives at the root of this repo. In Claude Code:

```
/plugin marketplace add ~/Atreya/tech-ai-plugins
/plugin install tech-plugin@tech-ai-plugins
```

Restart Claude Code. The first line of each session should read something like:

```
tech-plugin v0.1.0 | repo my-app | sdlc-docs: not set up | guard on
```

After pulling changes to this repo, run `/plugin marketplace update tech-ai-plugins` and restart.

## Try it without installing

From the marketplace repo root, in a separate terminal:

```
claude --plugin-dir plugins/tech-plugin
```

Then run `/tech-plugin:doctor`. Don't load the plugin into a session you are using to edit the plugin: its guard blocks edits to its own files, by design.

## Commands

| Command | What it does |
| --- | --- |
| `/tech-plugin:doctor` | Checks Claude Code, node, git, Python, uv, graphify, the LSP plugin for each language it finds, the effort setting and the Zoho Sprints connection, then lists the commands. It never installs anything; it prints the commands for you to run. `doctor --ci` is coming in a later step. |
| `/tech-plugin:breakdown` | Breaks a system into business modules. It finds the repos, asks 5 business questions, and detects each app's stack (`profile.md`, which you confirm). Then it reads the code and links screens to APIs across apps. It proposes modules (`modules.yaml`, which you approve) and writes the module catalogue, scope cards and module map. |
| `/tech-plugin:document <module>` | Writes the module's functional spec, BRD and PRD, in that order, from the code facts. Each has an "In short" box, a people layer in plain words, and an evidence appendix in which every statement cites the code. |
| `/tech-plugin:validate <module>` | Runs the checks, an independent doc-checker that re-reads every cited line, and a readability reviewer. The writer fixes what they find. Then it records who approved each layer: the owner or PO for the people layer, a developer for the technical one. |
| `/tech-plugin:diagram <module>` | Draws a module's flowchart (screens in business words), a sequence diagram per PRD requirement that calls an API, and an ER diagram. `diagram system` draws the system block diagram and the key journeys. |
| `/tech-plugin:sync` | Lists the documents and diagrams that no longer match the code, refreshes the ones you pick, picks up new business documents, and rebuilds the docs portal (`sdlc-docs/portal/index.html`). |

All the commands run on Haiku at low effort and are manual-only (`disable-model-invocation`), so they add nothing to the context until you run them. The steps that need judgement go to agents:
- **Grouping code into modules:** `module-proposer`, Opus at high effort.
- **Writing:** `doc-writer`, Sonnet at medium effort; `doc-writer-deep`, Opus at high effort, for modules flagged money, security or clinical.
- **Checking:** `doc-checker`, with `doc-checker-deep` for those modules; and `readability-reviewer`.
- **Screen names for diagrams:** `diagram-labeller`, Sonnet at low effort.

## breakdown

Run it in a repo, in a workspace folder that holds several repos, or with paths:

```
/tech-plugin:breakdown                       # this repo, or every repo in this workspace
/tech-plugin:breakdown ../backend ../mobile  # these folders
/tech-plugin:breakdown --docs ~/Docs/specs   # also list a folder of business documents
/tech-plugin:breakdown --only 3              # re-run one stage (1-6)
/tech-plugin:breakdown --refresh             # re-read what changed
```

**Stage 1: find the repos.**
- It lists the repos and apps it found. With several repos, it proposes the backend/API repo as the **home repo**.
- It asks five business questions, and you can skip any: what the product does, who uses it, key flows, roles, environments.
- It asks before creating `sdlc-docs/` in any repo.
- If you name production URLs, it offers to add them to the guard's `blockedHosts`, and the guard asks you to confirm.
- A git URL is never cloned for you: breakdown shows the `git clone` command for you to run.

**Stage 2: learn each repo.** A script reads manifests, lock files, CI and Docker files, migrations, test configs and `.env.example`. From `.env.example` it takes only variable names, plus a few harmless settings such as `DB_CONNECTION`. Every fact cites `repo:path:line`.
- **Stacks recognised:** Laravel, Blade, Livewire, Flutter, React, Next.js, Vue, Angular, Svelte, Express, NestJS, Django, FastAPI, Flask, Spring Boot, Android, Go, Rails, .NET and Rust. Anything else gets a generic reading marked Inferred.
- **Monorepos:** npm, pnpm, Turborepo or Nx workspaces get one section per app. A Flutter app's `android/` and `ios/` folders are part of that app, not separate apps.
- **Architecture notes:** a read-only agent (`stack-detector`, Haiku) reads a handful of real files and adds notes on layout and conventions.
- **Commands are found, not run.** The guard does not run programs in a repo before a work item is approved. Run them yourself and tell breakdown when they work.
- **Your confirmation:** you confirm or correct the short table it shows. Corrections are kept in the profile, and confirming records "Confirmed in chat by <your git name>".

**What it writes.** In the home repo's `sdlc-docs/`: `system.yaml`, `profile.md`, `glossary.md` and `README.md`, plus `_state/` for progress. In every repo's own `sdlc-docs/`: `_map/<repo>/stack.json`, and in the other repos a `home.json` pointer to the home repo. Nothing outside `sdlc-docs/` is touched, and secret files are never opened; committed ones are listed by name so you can take them out of git.

**Stage 3: read the code.** Scripts read every app with the reader for its stack. Each reader produces the same kind of facts: routes, handlers, screens, API calls, tables and external services, each cited `path:line`.
- **Laravel / Lumen:** all route forms, including groups, prefixes, resources, closures, named routes, included route files and Laravel 11 `bootstrap/app.php`. Also controllers, models, migrations and Blade views.
- **Flutter:** GoRouter, MaterialApp, GetX and auto_route routes; Dio and `http` calls.
- **Node:** Express, Fastify, Koa, hapi and NestJS, with mount prefixes followed across files. Tables from Prisma, TypeORM, Sequelize, Mongoose, Knex and Drizzle.
- **Web:** Next.js (pages and app routers), Nuxt, SvelteKit, Remix, and React, Vue and Angular route tables.
- **Python:** FastAPI, Flask and Django, including DRF routers. Tables from SQLAlchemy, Django models and Alembic.
- **Spring:** Java and Kotlin controllers, Feign clients, and JPA or Flyway tables.
- **Anything else:** a generic reader finds Go and Rails routes and groups code by the graphify graph. Everything it finds is marked Inferred.

API calls are worked out without running anything, for example `"${AppEnvironment.baseUrl}/patients/$id"` becomes `patients/{}`, even through a constant defined in another file. A call whose URL only exists at run time is listed with its file:line, never guessed. External services are recorded as file and line only, so no key or URL text from the code is stored.

**The code graph.** graphify runs offline and code-only, with no AI labels, on a temporary copy of the repo's code. The copy uses the guard's secret rules, so files a project marks as secret never reach graphify. The repo itself is never written to. The graph is kept in `sdlc-docs/_map/graphify/<repo>/`, stamped with the commit, and rebuilt only when the code changes. Without graphify the stage still runs and says so; with `"strict": true` in `sdlc-docs/config.json` it stops.

**Stage 4: link the apps.** Every call is matched to the route that serves it, then to the handler and its tables, across web, mobile and backend. `_map/links.md` lists three things for a developer to look at:
- calls with no matching route, which are likely bugs or removed endpoints;
- routes no app calls, which are possibly unused, or called from outside;
- calls that need a person.

Matches found only by the end of the path are marked Inferred. You can fix what scripts cannot see in `_map/overrides.yaml`, which is your file: base-URL names, extra services, and links by hand.

**Stage 5: propose modules.** The `module-proposer` agent (Opus) reads a compact summary and proposes business modules. Each has a plain name, a one-line purpose and risk flags: `money`, `security`, `clinical` or `personal-data`. A script expands the proposal and enforces the rule: **every backend route is in exactly one module, or unassigned with a reason**. You see the table and can rename, merge or split modules. `modules.yaml` is written only after your yes, and records who approved it. Module ids never change once approved.

**Stage 6: write the breakdown.** Scripts write all of these in the home repo's `sdlc-docs/`, so the same input gives the same documents:
- `modules/README.md`: the catalogue and a suggested order of next steps;
- `modules/<id>/module.md`: one scope card per module, with screens, APIs, tables, services and connections. Your notes block is kept on every rewrite.
- `system/overview.md`;
- `system/diagrams/module-map.md`: a Mermaid map, with every arrow listed with its evidence.

**What it writes.**
- **In the home repo's `sdlc-docs/`:** `system.yaml`, `profile.md`, `glossary.md`, `modules.yaml`, `modules/`, `system/`, `README.md`, `_map/links.*`, `_map/candidates.md`, `_map/overrides.yaml`, and `_state/` for progress.
- **In every repo's own `sdlc-docs/_map/`:** `stack.json`, `<repo>/facts.json` and `facts.md`, and `graphify/<repo>/`.

Nothing outside `sdlc-docs/` is touched, and secret files are never opened.

**Running it again.** If nothing changed, it answers "Already up to date" at almost no token cost. Otherwise only what changed is redone:

| What changed | What runs again |
|---|---|
| A manifest | Stage 2 for that repo, and you confirm the profile again |
| Code only | Stage 3 for that repo, then the links. If no route or screen moved, the module list stays as approved without asking, and the documents are rewritten. |
| New, moved or removed routes | You are shown them and asked again. The agent keeps every approved id, name and boundary and only places the new items. |

Edits you make to `system.yaml` are kept.

## document and validate

```
/tech-plugin:document reports          # spec, then BRD, then PRD
/tech-plugin:document reports prd      # one document
/tech-plugin:validate reports          # checks, reviews, then your sign-off
```

**Two layers in every document.**
- **People layer:** comes first and is for an owner, PO, QA tester or client who never opens the code. It has an "In short" box (what it does, who uses it, 3–5 key rules, how many questions are open), journeys, rules, and what happens when something goes wrong. It's written in plain words with no code names, and each statement carries a short tag like `[E4]`.
- **Evidence and technical layer:** in the appendices.
  - Appendix A turns each tag into `repo:path:line` and a class: Verified, Inferred, Assumption or Unknown.
  - Appendix B holds the routes, the backend endpoints each page calls, validations and data.
- **Questions instead of guesses.** Anything the code cannot prove becomes an open question for a named role. Business objectives and success measures are always questions for the owner.

**The fact pack.** Before writing, a script collects everything about the module into `modules/<id>/_facts.md`, with every fact cited:
- routes and access checks;
- validation rules, and the error and success messages (Laravel);
- page titles, labels and buttons (Blade, with translations resolved from the language files);
- what each page asks the backend for, tables and services;
- routes nothing uses;
- decisions already made.

Text from code is redacted for keys and personal data. The writer works from the fact pack and opens at most 15 source files.

**Checks.**
- **`check-doc.mjs`:** stamp; template headings; "In short"; every fact tagged and every tag resolved; IDs (`BR-01`, `<MODULE>-R01`) unique and never lost; every cited line exists and is not a secret file; no key-like strings or personal data; written from the current code.
- **`plain.mjs`:** code names, paths, HTTP codes or SQL in the people layer fail. Long sentences, jargon and domain words missing from the glossary are warnings.
- **The agents:** the doc-checker re-reads every cited line (twice for critical modules); the readability reviewer lists what a non-technical reader could not follow.

**How validate settles.**
- **Spec first.** The BRD is checked only once the spec is settled, and the PRD once the BRD is. A settled document has a clean last check on its current text, or its leftovers recorded as known issues.
- **At most 3 code checks per document per round.** A round starts when `/tech-plugin:document` writes the document. The first check reads everything. Later checks are *focused*: they look only at the items the last check raised and the lines changed since (`doc.mjs changes`).
- **Known issues instead of endless passes.** What is left after the last pass goes to `checks/<doc>-known.md`. The developer who approves the technical layer accepts them, and the next rewrite fixes them. A key or personal data is never accepted.
- **A spec fix doesn't mean rewriting the BRD and PRD.** The writer updates only the lines that depend on the changed spec lines, then `doc.mjs restamp` records the new spec. If nothing depended on the change, the earlier checks still count. A settled document that changes later gets one focused check.

**Sign-off.** Only a person approves, by role:
- the owner, PO or BA approves the people layer (Draft → Reviewed);
- a developer approves the technical layer (→ Approved).

A critical module also needs a recorded decision on every open question. Answers never make a document out of date; the next rewrite cites them. A sign-off applies to one exact text: when the document changes, it no longer counts. `modules.yaml` `doc_status` follows: none → draft → reviewed → approved. Everything is listed in `modules/<id>/checks/review-checklist.md`.

**Running it again.** If the code and the input documents are unchanged, it answers "Already up to date". If the code changed, it rebuilds the document and says what changed. If the spec changed after the BRD or PRD was written, it asks before rebuilding them. IDs and the person's decisions are kept.

**graphify.** If graphify is missing, doctor prints `uv tool install graphifyy` (it needs Python and uv). Don't run `graphify install`: that adds graphify's own Claude skill, and tech-plugin reads the graph itself.

**LSP plugins.** doctor reads the manifests in the current folder and recommends the official plugin for each language:

| Manifest | Plugin |
| --- | --- |
| `composer.json` | `php-lsp` |
| `package.json`, `tsconfig.json` | `typescript-lsp` |
| `pyproject.toml`, `requirements*.txt` | `pyright-lsp` |
| `go.mod` | `gopls-lsp` |
| `pom.xml`, `build.gradle` | `jdtls-lsp` (Java) or `kotlin-lsp` (Kotlin builds) |
| `pubspec.yaml` | no official Dart LSP plugin; consider `serena` |

Install one with `/plugin install <name>@claude-plugins-official`.

## diagram and sync

```
/tech-plugin:diagram reports           # flowchart, sequences, ER for one module
/tech-plugin:diagram system            # block diagram and key journeys
/tech-plugin:sync                      # what is out of date; refresh what you pick; rebuild the portal
/tech-plugin:sync --portal             # rebuild the portal only
```

**Scripts draw; only screen names are written.** Every diagram is Mermaid, drawn by a script from the code facts and the documents, so the same input gives the same diagram. Each box and arrow is listed with its source under "For developers".

**A module's diagrams** go in `modules/<id>/diagrams/`:
- **`flowchart.md`** is for everyone, and part of the people layer. Boxes are screens in business words. An arrow means a link, button or form takes people from one screen to the next. Other modules appear as their own box. A module with more than 25 screens is drawn in parts, grouped by folder, with an overview.
- **`sequences.md`** is technical: one diagram per PRD requirement whose evidence reaches an API. It goes from the page to the app, the backend and its tables. A requirement whose evidence calls no API is listed.
- **`er.md`** is technical: the module's tables and columns. Links between tables are **Inferred** from columns ending in `_id`, for a developer to confirm.
- **`labels.yaml`** holds the screen names, and you can edit it. A name comes from the spec's Screens table when a row points at exactly one screen. The `diagram-labeller` agent writes the rest from the page titles. A script checks each name: at most 8 words, and no code names, paths or symbols. Names you or the labeller wrote are kept on every run. Set `from: you` when you change one.
- **`_stamp.json`** records what they were drawn from. With no change, the command answers "Already up to date". It redraws when the code facts, the spec, the BRD, the PRD or a name change, when a module is renamed or its screens or routes move, or when the code map is read or linked again.

The flowchart has no sign-off of its own. The owner or PO reads it with the documents: `validate` adds it to `checks/review-checklist.md`.

**The system diagrams** go in `system/diagrams/`. The module map stays with `breakdown`.
- **`block.md`** shows the apps in plain words (website, server, mobile app), their databases, a backend outside the breakdown, and external services. Arrows show which app asks which for data.
- **`journeys.md`** draws the key flows from `system.yaml`. Give each flow its steps, each with the module that does it:

  ```yaml
  key_flows:
    - name: Ask for a pulse report
      steps:
        - patients: The doctor opens the patient list
        - reports: The report is made
  ```

  An arrow is solid when the code shows the two modules working together, and dashed when it does not, so someone can check it. A flow with no steps gets the example above.

**sync.**
- **It checks the code map first.** If the code changed since the breakdown, it says "run `/tech-plugin:breakdown --refresh` first" and stops.
- **A table of what is out of date.** Each row is a document whose code facts or input document changed, a module's diagrams, the system diagrams, or new business documents. You pick the rows.
- **Documents are rewritten through the normal document flow.** Rewriting an Approved or Reviewed document makes it a Draft again, and the table warns about that first.
- **Diagrams are redrawn by script.**
- **Business documents** come from the folders listed under `docs:` in `system.yaml`. `.md` and `.txt` files are copied to `sdlc-docs/sources/<folder>/`; two folders with the same name get their path instead (`docs-business`, `client-business`). For PDF, Word and other files, sync prints a `uvx markitdown '<file>' -o '<target>.md'` command for you to run, with the paths quoted so nothing in a file name runs; it never runs one itself. Files you put straight into `sources/` are picked up too. Hashes are kept in `_state/sources.json`, so only new and changed files show up.

**The docs portal** is `sdlc-docs/portal/index.html`, static pages you open from disk:
- **What it shows:** the system overview and diagrams, the module catalogue, every module's scope card, and its documents and diagrams when they exist, plus the glossary. Never `_state/`, `_map/` or the fact packs.
- **Folds:** appendices and evidence sit in a closed "For developers" fold, and a document's page shows its status and who approved it.
- **Safe to open:** it has its own Markdown renderer, and raw HTML in a document is escaped.
- **Diagrams:** Mermaid comes from one pinned jsDelivr URL. Offline, a diagram's text is shown instead.
- **Rebuilds:** only when what it shows has changed.

## The safety guard

A fail-closed `PreToolUse` hook (`scripts/guard.mjs`, Node.js, no dependencies) checks **every** tool call before it runs. If the guard crashes, runs out of time (it has its own 2.5 s budget) or cannot understand a call, the call is blocked. It is run as `node guard.mjs || exit 2`, so a missing `node` also blocks. It never answers "allow": a call it passes still goes through Claude Code's normal permission prompts. Every block names its rule, for example:

```
tech-plugin: BLOCKED [repo-write] /…/my-app/app/x.php is in repo my-app outside sdlc-docs/: work item W-12 is not approved (no sdlc-docs/work/W-12/APPROVED)
```

| Rule | What it blocks |
| --- | --- |
| `secrets` | Reading, searching or editing `.env` and `.env.*` (not `.env.example`), `*.jks`, `*.keystore`, `*.p12`, `*.pem`, `id_rsa*`, `firebase-*.json`, `google-services.json`, `GoogleService-Info.plist`, plus project patterns. A content search over a folder that holds a secret file is blocked; names-only searches (Grep's default mode, `grep -l`, Glob) are allowed. A command that names a secret file is blocked even if it only lists it (`ls .env`). |
| `repo-write` | Inside a git repo, writes are allowed only under `<repo>/sdlc-docs/`. Anywhere else in the repo needs **all** of: `sdlc-docs/work/.active` names one work item, `sdlc-docs/work/<ID>/APPROVED` exists, and the branch is not protected (`main`, `master`, `production` plus the project's list). Programs whose effect the guard cannot see (`npm test`, `make`, scripts, `python -c …`) count as writes. |
| `git` | Only read-only git runs: `status`, `diff`, `log`, `show`, `blame`, branch listing, `rev-parse`, `ls-files`, `grep`, `remote -v`. Everything else is blocked everywhere, and so is writing inside `.git/`. `git diff`/`show`/`log -p`/`grep` are also checked for printing secret files. |
| `installs` | Package installs and updates (npm, yarn, pnpm, bun, composer, pip, poetry, pipenv, uv, conda, flutter/dart pub, pod, gem, bundle, go get/mod, cargo, deno, dotnet) inside a repo, even with an approved work item. |
| `prod-hosts` | Hosts in `blockedHosts` and their subdomains, for WebFetch, browser and Playwright tools, and for network commands such as `curl` and `wget`. The default list is empty. |
| `zoho` | Zoho Sprints read tools pass; every create, update, delete or move asks you first. Writes to other Zoho apps are blocked. |
| `self-protection` | Creating, editing, moving or deleting any file named `APPROVED`, the plugin's own files, `.claude/settings*.json`, `~/.claude.json`, `~/.claude/plugins/`, your shell startup files, or files in folders on `PATH` (they could stand in for commands the guard trusts). Unpacking archives into `sdlc-docs/work/` is blocked too. |
| `safe-commands` | Framework commands that can touch data run only from a safe list, for example `php artisan` with only `route:list`, `list` and `about`. |
| personal data | Not built yet (marked TODO in the code); it comes with database access in a later step. |

The Bash check understands chains (`&&`, `||`, `;`, `|`), `$( )` and backticks, redirections, here-documents, `tee`, `sed -i`, `mv`, `cp`, `rm`, `touch`, `mkdir`, `env`/`sudo`/`xargs` prefixes, `bash -c`, scripts run with `bash`, variables, brace expansion and `cd` followed by a write. Paths are resolved through symlinks and `../`, and compared without case on macOS and Windows. `eval`, commands piped into a shell, and anything else it cannot read with confidence are blocked.

### Approving work

A person, not Claude, opens the gate for one work item:

1. Write the work item ID into `sdlc-docs/work/.active` (Claude may do this).
2. Create `sdlc-docs/work/<ID>/APPROVED` yourself. Claude can never create, change or delete a file named `APPROVED`.
3. Switch to a feature branch yourself (Claude cannot run `git checkout`/`switch`).

Remove `APPROVED` or switch back to `main` to close the gate again.

### Project settings

A repo can add `sdlc-docs/config.json`. It may only **add** restrictions:

```json
{
  "blockedHosts": ["api.example.com", "dashboard.example.com"],
  "secretPatterns": ["flavor_config.dart", "*PaymentBridgeController.php"],
  "protectedBranches": ["release/*", "staging"],
  "safeCommands": { "php artisan": ["route:list"] }
}
```

- `secretPatterns`, `protectedBranches`, `blockedHosts` are added to the defaults.
- `safeCommands` and `readOnlySubcommands` lists can only get shorter; a new tool in `safeCommands` restricts that tool too.
- Git and self-protection rules are code, not settings, and cannot be changed.
- Claude must ask you before it edits this file. If the file is not valid JSON, the guard blocks work in that repo until you fix it.

The plugin defaults are in `config/defaults.json`.

### Limits

The guard is a guardrail, not a sandbox. Know where it stops:

- **Programs it cannot read.** A program it cannot read, started from outside any repo, that works out a repo path at run time (rather than naming it) is not seen. Inside a repo session, every such program needs an approved work item.
- **Dependency folders are not scanned for secrets.** These are `node_modules`, `vendor`, `Pods`, `.venv`, `.gradle` and `.dart_tool`; they hold third-party files and would make every search slow.
- **Strict about what it can't read.** Commands it cannot read with confidence are blocked even when harmless. This includes `case … esac` in one-liners, `grep "\.env"`, `cat "$f"` with an unknown `$f`, and the PowerShell tool.
- **Environment variables.** It does not stop printing environment variables (`printenv`).
- **Tested on macOS only so far.** The code handles Windows paths, but the tests have not yet been run on Windows.

## Tests

```
cd plugins/tech-plugin
node --test tests/
```

- `tests/guard-tests.mjs` builds a throwaway workspace in the temp folder: fake repos with fake secrets, `sdlc-docs/` folders, `main`, feature and release branches, approved and unapproved work items, and symlinks and hard links for bypass attempts. It runs the real hook command for every case.
- `tests/doctor-tests.mjs` covers language detection, the LSP recommendations, the graphify and effort messages, `--ci`, and the session banner.
- `tests/breakdown-tests.mjs` builds four golden fixtures (`tests/golden.mjs`):
  1. a Laravel API, a Laravel + Blade dashboard and a Flutter app as one workspace
  2. a Next.js + Express monorepo
  3. a FastAPI app
  4. an empty folder

  It checks detection fact by fact, runs stages 1–2 through the scripts the way the command does, and proves that no secret file is opened and nothing outside `sdlc-docs/` changes.
- `tests/document-tests.mjs` builds the Laravel + Flutter fixtures through `breakdown` (`tests/golden-doc.mjs`). It checks the fact pack, the status and freshness rules, both checks on good and broken sample documents, ID stability, every sign-off rule, redaction, the definitions and the guard.
- `tests/diagram-tests.mjs` runs the same fixtures through `diagram` and `sync`. It checks screen names (from the spec, and the plain-name check), the flowchart, sequence and ER diagrams, the system diagrams, freshness, the sync table, business documents, and the portal (escaping, folds, links, rebuilds). It also checks the review checklist, the definitions, the guard, and that nothing outside `sdlc-docs/` changes.
- `tests/map-tests.mjs` adds real code to those fixtures (`tests/golden-map.mjs`) plus a Go service. It checks:
  - every reader against exact routes, screens, calls and tables, and the Laravel parser on edge cases;
  - URL resolution, route matching and the module rules;
  - the graphify wrapper, with a fake graphify (`tests/fake-graphify.mjs`) that records what it was given, and with the real one when installed;
  - the six stages end to end, including reruns, overrides, guard wiring, and that no secret is read and nothing outside `sdlc-docs/` changes.

To validate the plugin and the marketplace:

```
claude plugin validate plugins/tech-plugin
claude plugin validate .
```

## Layout

```
.claude-plugin/plugin.json   name, version, description
hooks/hooks.json             guard (PreToolUse "*") and banner (SessionStart)
scripts/guard.mjs            the guard; lib/ holds paths, config, shell tokenizer, Bash checks, rules
scripts/banner.mjs           one-line session banner (systemMessage: costs no tokens)
scripts/doctor.mjs           setup check used by /tech-plugin:doctor
scripts/breakdown/           find-repos, detect, write (stages 1-2), map (3), link (4), modules (5), catalogue (6), state, load
scripts/lib/stacks.mjs       stack detection; lib/yaml.mjs small YAML reader/writer; lib/secretnames.mjs
scripts/lib/readers/         code readers: laravel, flutter, node, web, python, spring, generic, calls, externals
scripts/lib/graph.mjs        graphify wrapper and graph queries; lib/modules.mjs module expansion and coverage
scripts/document/            doc (fact pack, status, prepare), check-doc, plain, signoff, glossary
scripts/diagram/             diagram (labels, module diagrams, freshness), system (block diagram, journeys), mermaid helpers
scripts/sync/                sync (status table, business documents), portal (Markdown renderer, static pages)
scripts/lib/readers/behaviour.mjs  validation rules, messages, page labels; lib/redact.mjs keys and personal data
skills/doctor/SKILL.md       the doctor command
skills/breakdown/SKILL.md    the breakdown command; stage details in references/breakdown/
agents/stack-detector.md     read-only architecture notes for one app (Haiku)
agents/module-proposer.md    proposes module boundaries for approval (Opus, high effort)
agents/doc-writer*.md        writes one document (Sonnet; Opus for critical modules)
agents/doc-checker*.md       re-reads every cited line (read-only; Opus for critical modules)
agents/readability-reviewer.md  reads the people layer as a non-technical person (read-only)
agents/diagram-labeller.md   writes plain screen names into labels.yaml (Sonnet, low effort)
skills/diagram, skills/sync  the diagram and sync commands; flows in references/diagram/ and references/sync/
references/document/         writing rules, spec/BRD/PRD templates, jargon list, flows
config/defaults.json         secret patterns, protected branches, safe-command lists, blocked hosts
tests/                       guard, doctor and breakdown tests (node --test tests/)
```
