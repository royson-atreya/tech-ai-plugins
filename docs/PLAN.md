# SDLC/STLC Claude Code Plugin — Final Plan for Review

Nov 10, 2026 · @Atreya Innovations Pvt Ltd · Status: Draft for review

## Decisions taken on 10 Nov 2026

These override anything below that says otherwise.

- **Name:** `tech-plugin`. Commands are `/tech-plugin:<command>`; wherever this plan says `sdlc` as the plugin name, read `tech-plugin`. The per-project docs folder keeps the name `sdlc-docs/`.
- **Marketplace:** local only for now (`~/tech-ai-plugins`); GitHub later.
- **Tracker:** Zoho Sprints only, with plain-text tickets when Zoho isn't connected.
- **Docs location:** inside each product repo, at `<repo>/sdlc-docs/`. In a multi-repo system, the system-level files (system.yaml, modules.yaml, `system/`, `modules/`) live in one home repo chosen during `breakdown` (default: the backend/API repo); each other repo's `sdlc-docs/` holds its own `_map/` and a pointer to the home repo. The guard allows writes inside `sdlc-docs/` and blocks the rest of the repo unless the work item is approved. The plugin never commits; you decide whether `sdlc-docs/` goes into Git.

## Decisions taken on 13 Nov 2026

These override anything below that says otherwise.

- **No sign-off for module documents.** `validate` checks the spec, BRD and PRD and ends there. A document goes **Draft → Checked**: it is Checked when its last doc-checker pass is on the current text, the readability review is done and no key or personal data is left. Nobody approves it.
  - Gone: the owner/PO sign-off of the people layer, the developer sign-off of the technical layer, the Reviewed and Approved statuses, and "a critical module waits for a decision on every open question".
  - Kept: every check (script checks, readability review, 1–3 doc-checker passes, two for critical modules). Leftovers after the last pass are listed as known issues; they do not stop Checked, and the next rewrite fixes them.
  - Open questions stay in the document. An answer is recorded as a decision only when someone gives one; nothing waits for it.
  - `modules.yaml` `doc_status` is `none`, `draft` or `checked`. Documents already Approved under the old flow keep that status until they are rewritten.
  - Approvals stay where they protect the code: the requirement and design of a work item, and the `APPROVED` file before any code is edited.
- **Mermaid and draw.io are both default outputs of `diagram`.** Every diagram is written twice from the same script data: Mermaid (renders on GitHub and in the portal) and a `.drawio` file beside it that people can open and rearrange in draw.io or diagrams.net. Scripts write both; `sync` treats both as stale together. The step-6 build drew Mermaid only; draw.io is added to it.
- **Easier to use.** A new command, `next`, is the one command to remember: it works out the next step from `sdlc-docs/` and runs it after a yes. `document <module>` now writes, checks (what `validate` does) and draws (what `diagram` does) in one run; `validate` and `diagram` stay for redoing one part. The session banner points at `next`, and `doctor` starts with a short "How to use". The README is a short guide for users; the detail moved to REFERENCE.md.

## Remember: initial graphify setup (build it in from day one)

[graphify](https://github.com/safishamsi/graphify) builds a map of the whole codebase (files, functions, who calls whom, groups of related code) that the plugin queries instead of reading many files. It is free (Apache-2.0) and parses code locally. It goes in the first build steps, not later.

- [ ] **Install check:** `doctor` checks `graphify` is installed and, if not, prints the install command (`uv tool install graphifyy`; needs Python and uv)
- [ ] **No duplicate skill:** don't run `graphify install`, which adds graphify's own Claude skill; the plugin queries the graph itself, so that skill would only add context cost
- [ ] **Build during `breakdown` (stage 3):** for each repo, run graphify in code-only, offline mode, as in your earlier setup (`GRAPHIFY_BACKEND=none`, `graphify extract . --code-only`, then `graphify cluster-only .`)
- [ ] **Keep repos untouched:** graphify writes a `graphify-out/` folder; move it to `sdlc-docs/_map/graphify/<repo>/` straight after, or use an output-folder option if the current version has one (check in build step 2); skip secret files, vendor and build folders
- [ ] **Rebuild only when needed:** stamp each graph with its repo's commit; rebuild only the repos whose code changed
- [ ] **Who reads it:** `breakdown` (groups of related code become module proposals), `diagram` (module map and call flows), `impact` (what is connected), `task` and `implement` (finding the right files), `incident` (tracing a failure); scripts query the graph, it is never pasted into the chat whole
- [ ] **Fallback for unfamiliar stacks:** the generic reader uses the graph; facts found this way are marked Inferred
- [ ] **LSP alongside it:** `doctor` recommends the official LSP plugin for each detected language; Dart/Flutter has no official LSP plugin, so check Serena's Dart support

**graphify and LSP do different jobs.** graphify answers big-picture questions: which parts belong together, how the system connects, what a change might touch. LSP (Serena or the official LSP plugins) answers exact ones: where something is defined, who uses a function, type errors after an edit. Understand-and-document commands lean on graphify; build and review commands lean on LSP. The plugin's own stack scripts cover framework rules that neither fully understands, such as Laravel routes to controllers.

## The plan at a glance

**One toolbox for Claude Code that helps one person or a whole team take any software project from "understand what we have" to "release it safely", with a human approving every important step.**

It is made of three things:

1. **The plugin:** the toolbox with all the commands (`/sdlc:<command>`).
2. **A project folder it creates** (`sdlc-docs/`): the project's notebook, where everything it learns and produces is saved.
3. **Outside tools it connects to:** graphify, LSP, GitHub, Zoho, Playwright, draw.io and others.

In the tables, **Needs first** means the command stops and names the step to run; **(better with …)** means it warns you and asks whether to continue with a reduced result. With `strict: true` in the project config, every "better with" becomes "needs first".

The plugin has **19 commands plus 1 optional**, down from 45 (`next` was added on 13 Nov): each one now does a complete job, and the steps it absorbed run inside it (see How the commands were trimmed).

### Part 1: Set up (3 commands)

| Command | What it does | Needs first |
| --- | --- | --- |
| `breakdown` | Goes through the entire repo (or all connected repos), works out the stack, maps the code with graphify, and breaks it into business modules you approve | — |
| `next` | The one command to remember: works out the next step from what is already done and runs it after a yes | — |
| `doctor` | Checks setup (graphify, LSP, connectors, settings), says how to use the plugin and lists the commands; `doctor --ci` sets up checks on every pull request | — |

#### The breakdown command

Run `/sdlc:breakdown` once per system: in the current repo, on every repo in the workspace, or on paths and Git URLs you give it. It runs six stages and stops twice for your approval.

| # | Stage | What it does | Your part |
| --- | --- | --- | --- |
| 1 | Find the repos | Uses the current folder, the workspace, or the paths/URLs given (URLs copied read-only); takes document folders with `--docs`; asks 5 quick business questions | Answer or skip |
| 2 | Learn each repo | Stack, entry points, build and test commands | **Approve the stack summary** |
| 3 | Read the code | Scripts list every screen, API, table and external service; graphify builds the code graph | — |
| 4 | Link the apps | Screen → API → backend → table across web, mobile and backend | — |
| 5 | Propose modules | Business modules with plain names: purpose, screens, APIs, tables, depends on, risk flag (money, security, clinical), size; every API in exactly one module or listed as unassigned with a reason | **Rename, merge, split or approve** |
| 6 | Write the breakdown | Module catalogue, one folder and scope card per module, module map diagram, suggested order of next steps | — |

- **Run again, nothing changed:** "Already up to date", at almost no token cost.
- **Run again, code changed:** it re-reads only the changed repos, shows new, moved and removed items, and asks before updating the module list. Your names and boundaries are kept and module IDs never change.
- **Long runs:** progress is saved after every stage; an interrupted run continues where it stopped.
- **Options:** `--refresh` re-checks after code changes; `--only <stage>` re-runs one stage; `--docs <folder>` adds business documents.

### Part 2: Document what exists (4 commands)

| Command | What it does | Needs first |
| --- | --- | --- |
| `document` | Writes a module's plain-language spec, BRD and PRD, in that order, then checks them and draws its diagrams, in one run; `document <module> brd` writes and checks one | `breakdown` |
| `diagram` | Module flowcharts, journeys across apps, ER and sequence diagrams, each as Mermaid and as a draw.io file; `diagram system` for the whole-system map | `breakdown` (better with `document`, for business labels and sequences) |
| `validate` | Checker and readability review; a document that passes becomes Checked (no sign-off) | `document` |
| `sync` | Finds out-of-date docs and diagrams after code changes, refreshes the ones you approve, picks up new files in `sources/`, rebuilds the docs portal | `breakdown` |

### Part 3: Plan new work (3 commands)

| Command | What it does | Needs first |
| --- | --- | --- |
| `impact` | What a change affects, how risky it is, and a rough size for planning | `breakdown` (better with `document`) |
| `requirement` | Turns a request into clear requirements, user stories and acceptance criteria | `breakdown` (better with `impact`) |
| `design` | How to build it: architecture, API, database and screen changes; decisions recorded as ADRs | `requirement` (better with `impact`) |

### Part 4: Build (3 commands)

| Command | What it does | Needs first |
| --- | --- | --- |
| `task` | Picks up a task or bug (reproduces a bug first) and prepares the plan for your approval | `breakdown` (better with `impact`, `design`) |
| `implement` | Writes the code on a feature branch | `task` + your approval |
| `review` | Checks for mistakes and security issues, then writes the handoff showing exactly what changed; you push | `implement` |

### Part 5: Test (2 commands)

| Command | What it does | Needs first |
| --- | --- | --- |
| `test-cases` | Test plan and test cases, each linked to a requirement | `requirement` or `document` (PRD) |
| `test-run` | Runs the tests (`--sanity`, `--regression`, `--perf`), logs defects after you confirm, writes the test report | `test-cases` |

### Part 6: Release and run (2 commands)

| Command | What it does | Needs first |
| --- | --- | --- |
| `release` | Release notes, a "ready to go?" checklist, and deploy and rollback steps | a `test-run` report for every item in the release |
| `incident` | When production breaks: finds the cause, gives a hotfix path, writes the postmortem | `breakdown` (better with `document`) |

### Part 7: Track work (1 command + 1 optional)

| Command | What it does | Needs first |
| --- | --- | --- |
| `status` | Lists work in progress; `status <ID>` continues an item where it stopped, even in a fresh session | — |
| `standup` (optional) | Drafts your daily update | — |

### Parts working in the background

- **Part 8, safety guard (always on):** never reads secrets; never commits, pushes or pulls; edits code only after your approval and on a feature branch; never touches production; keeps patient and personal data out.
- **Part 9, helpers:** agents (small workers such as the checker that re-reads code to confirm every document), scripts that read code the same way every time, templates for every document.
- **Part 10, cost control:** one module at a time, progress saved to files, nothing unnecessary loaded; Haiku for simple jobs, Sonnet for writing and coding, Opus for hard decisions.
- **Part 11, tool connections:** graphify, LSP, Playwright, Mermaid, draw.io, Semgrep by default; Zoho, GitHub, Jira, Figma or Penpot and mobile testing tools when a project turns them on.

### How every command behaves

1. **Checks what it needs first** (the tables above). If something is missing, it stops and offers: run the missing step, continue with a reduced result, or cancel.
2. **Checks whether its output is already up to date.** It compares the output's stamp with the module's current code, using a quick script with almost no tokens:
   - nothing exists yet → it builds it;
   - exists and nothing changed → "Already up to date", and it stops (`--force` rebuilds);
   - some files changed → it rebuilds only the affected parts and lists them;
   - an input changed (e.g. the BRD) → it asks before rebuilding what depends on it.
3. **Writes only into its own folder**, e.g. `/sdlc:diagram login` writes only to `modules/login/diagrams/`, and creates that folder the first time.
4. **Saves progress** to `work/<ID>/status.json`, so `status <ID>` can continue after a break or a fresh session.

### How a normal piece of work flows

**Once per system:** `breakdown` → `document` for each module (it writes, checks and draws). Or just run `next` again and again: it picks each step.

**Then for every change:** `impact` → `requirement` → `design` → `task` → **you approve** → `implement` → `review` → `test-cases` → `test-run` → `release` → **you push and deploy**

Each command ends by naming the next one, and `status` shows where every item stands.

### Final folder structure

**What each project gets.** `breakdown` creates this folder after asking you. Every command writes only into its own place; the command that fills each item is in brackets.

```
<workspace>/
├── repos/                          product repos, read-only by default
└── sdlc-docs/
    ├── README.md                   start here: index of everything below
    ├── system.yaml                 repos, document sources, environments, connectors   (breakdown)
    ├── profile.md                  stack, commands, conventions per app                (breakdown)
    ├── config.json                 tracker, protected branches, blocked hosts, strict mode, model tiers
    ├── modules.yaml                module list; boundaries owned by people           (breakdown)
    ├── glossary.md                 business terms in plain words                      (breakdown, document)
    ├── sources/                    business documents converted to Markdown           (breakdown, sync)
    ├── _map/                       raw facts, regenerated by scripts, never edited    (breakdown)
    │   ├── <repo>/                 routes, screens, tables, api-links
    │   └── graphify/<repo>/        code knowledge graph, stamped with the repo commit
    ├── system/
    │   ├── overview.md             the whole system on one page                      (breakdown)
    │   └── diagrams/               module map, block diagram, cross-app journeys      (breakdown, diagram)
    ├── modules/
    │   ├── README.md               module catalogue: read this first                  (breakdown)
    │   └── <module>/               one folder per module, e.g. login/, appointments/
    │       ├── module.md           scope card: purpose, screens, APIs, tables, risk  (breakdown)
    │       ├── spec.md  brd.md  prd.md                                             (document)
    │       ├── diagrams/           flowchart, journey, ER, sequences (.md + .drawio) + stamp files (diagram)
    │       ├── tests/              module test cases and regression suite             (test-cases, test-run)
    │       └── checks/             checker, readability and known-issue reports       (validate)
    ├── work/
    │   └── <ID>/                   one folder per task, bug or feature
    │       ├── status.json         current phase, approvals, next step               (every command)
    │       ├── impact.md  impact-report.html                                       (impact)
    │       ├── requirement.md  design.md                                           (requirement, design)
    │       ├── plan.md  APPROVED  handoff.md                                       (task, you, review)
    │       ├── tests/  test-report.md                                              (test-run)
    │       └── release-notes.md                                                    (release)
    ├── releases/<version>/         checklist, runbook, smoke results                  (release)
    ├── incidents/<date-name>/      root cause and postmortem                          (incident)
    ├── standups/<date>.md          daily update drafts                                (standup, optional)
    └── portal/                     the docs website                                   (sync)
```

A single-repo project can keep `sdlc-docs/` inside the repo; you decide whether it is committed to Git.

**What the plugin itself contains**

```
sdlc/
├── .claude-plugin/plugin.json      name, version, your settings (workspace, tracker login)
├── skills/<command>/SKILL.md       one folder per command in Parts 1–7
├── agents/                         checker, readability reviewer, code reviewers, 3 worker tiers
├── hooks/hooks.json                safety guard, session banner, output filters
├── scripts/
│   ├── check-needs                 "needs first" check for every command
│   ├── freshness                   "already up to date?" check
│   ├── extract/ and adapters/<stack>/   code readers per stack + generic fallback
│   └── render/ and check/          diagrams, reports, plain-language and citation checks
├── references/
│   ├── templates/                  spec, BRD, PRD, ADR, test case, RTM, runbook, release notes…
│   ├── dependencies.json           the "needs first" table in one file
│   └── rules/ and stacks/          writing rules, safety rules, stack guides
├── .mcp.json                       optional connectors, started only when used
└── tests/                          guard tests, script tests, evals on sample repos
```

## Summary

We build one stand-alone Claude Code plugin (working name `sdlc`, commands `/sdlc:<skill>`) that takes any project, in any tech stack, from understanding the existing code through requirements, design, build, test and release. A single person can drive every phase, or a team can split the phases between them.

It ships as **one complete release** with every phase included. Inside that release, the understand-and-document skills come first in the workflow: they write the validated, plain-language documentation that every later phase (requirements, design, build, test, release) reads instead of re-reading the code. The build itself goes in gated steps so each part is tested before the next is added.

The plan combines four inputs:

- your requirements;
- the owner's feedback on the first assignment;
- the best practices from the existing `atreya` plugin (smohinii25/atreya-ai-plugins v0.2.0);
- a check of current open-source tools and of Claude Code's model, effort and token controls.

## Goals and design principles

Every design choice below traces back to one of these requirements.

| # | Requirement | Source | How the plan meets it |
| --- | --- | --- | --- |
| 1 | Cover the whole SDLC and STLC, from requirement gathering to deployment | You | Skills for every phase, all in one release |
| 2 | One person can do all the work; not split by team | You | One plugin; commands for every phase; any person can continue a work item with status |
| 3 | Stand-alone; works in any project, existing or new | You | Nothing project-specific in the plugin; `breakdown` generates the project's own config |
| 4 | Any tech stack, discovered from the code | You | Stack detection, a stack-neutral fact format, per-stack readers with a generic fallback |
| 5 | Point at any Git repo or documentation and get block diagrams, flowcharts and functional specs for human validation | Owner | The understand-and-document skills; every statement cites its source and is marked Verified, Inferred or Needs confirmation |
| 6 | Business and functional view, not only technical docs | Owner | Business-context intake; every document written for non-technical readers first (Documents people can read) |
| 7 | The full picture across all connected apps (web, mobile, backend) | Owner | A system manifest; cross-app links from screen to API to backend to table |
| 8 | Favour working over perfect; no over-engineering | Owner | One release, built in gated steps; each step works before the next starts |
| 9 | Docs exist so AI can later change, test and deploy accurately and cheaply | Owner | Docs structured for AI: one index, stable IDs, one file per module |
| 10 | Serve everyone in the org | You | A role map (Tools and connectors) and per-role entry points |
| 11 | Use the latest open-source tools and connectors | You | Tools and connectors: open-source default set plus optional connectors |
| 12 | Use tokens efficiently | You | Token management |
| 13 | Right model and effort for each task | You | Model and effort routing |
| 14 | Never commit, push or edit a repo without human approval | You | Guard hook plus the approval gate (Safety and guardrails) |

**Principles**

- **Scripts extract the facts; Claude writes the prose.** The same commit always gives the same map.
- **Never invent.** Cite the code, a ticket or a human document, or ask the question.
- **Scripts and checkers verify; a human approves only what changes the code.** Module documents become Checked when the checks pass. A person approves a work item's requirement and design, and creates the `APPROVED` file before code is edited.
- **Process depth matches task size**: Quick, Standard or Full.
- **Every tool is optional.** A skill says what is missing and falls back to a weaker method; it never fakes a result.

## Scope

Everything below ships together in one release. The order of the rows is the order work flows through the plugin, not a release schedule.

| Area | What is included |
| --- | --- |
| Understand and document | Connect a system (repos and documents), map the code across apps, plain-language functional specs, BRD and PRD, diagrams, automatic validation, keeping docs in sync, impact analysis |
| Requirements and design | Requirements for new work, user stories, architecture and ADRs, API contracts, data model, UI flows and design handoff |
| Build | Pick up a task or bug, plan, implement behind an approval gate, review, handoff |
| Test (STLC) | Test plan, test cases with traceability, web, API and mobile runs, sanity and regression, defects, test reports |
| Release | Release notes, readiness check, deployment and rollback runbook, smoke test |
| Flow and team | Work tracking and continuing with status, tracker sync, size estimates from impact, optional daily standup drafts |
| Operate | CI/headless mode on pull requests, docs portal website, incident and RCA, performance testing, learning mode |

**Done when:** a real multi-app product is documented and checked, and one feature goes from requirement to release with every approval gate respected.

**Out of scope**

- Pushing, merging or deploying to production without a person.
- Storing or processing real patient or personal data.

## Architecture

One plugin in an org-owned marketplace. Inside it: skills (what people run), agents (workers in a fresh context), hooks (guards that run on every tool call), scripts (deterministic extractors) and references (templates and rules loaded only when needed). Each project gets its own `sdlc-docs/` folder; the plugin itself holds nothing project-specific.

&#91;embedded content: plugin architecture · 4 parts inside the plugin, 3 outside\]

A person runs a skill; skills hand work to agents and scripts; the guard checks each of their tool calls. Product repos are only read, project docs are written, and tools are called on demand.

**Why one plugin and not several**

- One person may run every phase, so splitting by team adds friction.
- Context cost is not a reason to split. Every phase skill is manual-only (`disable-model-invocation: true`), so its description stays out of context until someone runs it.

The full folder structure of the plugin and of each project is in **The plan at a glance → Final folder structure**.

## How the commands were trimmed

The earlier 45 commands are now 19 plus 1 optional. Nothing was dropped: each absorbed step still runs, inside the command that needs it, and advanced users can re-run a single stage with `--only <stage>`.

| Part | Command | Absorbs these earlier commands or steps |
| --- | --- | --- |
| Set up | `breakdown` | connect, start, map, merge, link-apis, intake, building the graphify graph |
| Set up | `next` | — (added 13 Nov) |
| Set up | `doctor` | help, ci-setup, the feedback link |
| Document | `document` | spec, brd, prd; also runs the checks and the diagrams |
| Document | `diagram` | — |
| Document | `validate` | the readability review |
| Document | `sync` | portal, picking up new business documents |
| Plan | `impact` | estimate |
| Plan | `requirement` | stories |
| Plan | `design` | api-contract, data-model, ui-flow |
| Build | `task` | bug |
| Build | `implement` | — |
| Build | `review` | handoff |
| Test | `test-cases` | test-plan |
| Test | `test-run` | regression, perf-test, defect, test-report |
| Release | `release` | release-notes, release-check, runbook |
| Release | `incident` | — |
| Track | `status` | resume, feature |
| Track | `standup` (optional) | — |

Two background skills are never typed; Claude loads them itself when relevant: `stack-knowledge` (stack guides for detected stacks) and `project-knowledge` (answers questions about the project from its docs; this replaces the earlier explain command).

## Understand and document in detail

This stage turns a set of repos and business documents into validated, business-language documentation of the whole system. Steps 1–5 run inside one command, breakdown; steps 6–7 are the document, diagram and validate commands.

1. **Connect.** List the repos (local paths or Git URLs) and document sources, answer 5 quick business questions (what the product does, who uses it, key flows, roles, environments). Output: `system.yaml`, a glossary seed.
2. **Start.** Detect each app's stack, entry points, build and test commands. A person confirms `profile.md`.
3. **Map and merge.** Scripts extract facts per repo into a common format. Claude proposes module boundaries across all apps; every backend route lands in exactly one module or in an explained "unassigned" list. A person approves `modules.yaml`.
4. **Link.** Screen → API call → route → handler → tables, across web, mobile and backend. Calls with no route (likely bugs) and routes no screen calls (possibly unused) are listed for review.
5. **Intake.** Business documents become Markdown sources; each fact taken from them is cited by file and section.
6. **Write.** Per module: a functional spec, BRD and PRD in business language, plus diagrams (below). A separate doc-checker agent, in a fresh context, re-reads every cited line.
7. **Validate.** The checker and readability reviewer read each document; the writer fixes what they find. A document that passes becomes Checked. Its open questions stay listed, each addressed to a role (owner, PO, developer); answers are recorded when given. No sign-off.

**Diagrams it produces**

- **System block diagram:** apps, backend, database, external services and what calls what.
- **Module flowcharts:** the user journey through each module's screens.
- **Cross-app business flows:** one journey end to end across web, mobile and backend.
- **ER diagram** per module, and a **sequence diagram** per requirement that calls an API. Every diagram is written as Mermaid (renders on GitHub and in the portal) and as a draw.io file people can open and rearrange. Both come from the same script data. Every box and arrow cites its source.

**Evidence rules** (taken from the `atreya` plugin)

- Every statement cites `Repo:path:line`, a ticket or a human document. Anything else goes to Needs confirmation, phrased as a question for a named role.
- Every statement carries one class: Verified, Inferred, Assumption, Unknown or Not affected.
- Every document carries a stamp: module, date, the commit of each repo, and status. Claude writes Draft; `validate` sets Checked when the checks pass.
- IDs never change: `BR-01` for business requirements, `<MODULE>-R01` for functional requirements. Test cases and defects link to them.
- Critical modules (money, security, core clinical flow) get two doc-checker passes, by a deeper writer and checker.

**Built for AI as well as people** One index file, one folder per module, stable IDs and cross-links. Every later phase reads these files instead of re-reading the code, which is where the accuracy and cost savings the owner asked for come from.

## Documents people can read

Every document is written for a non-technical reader first: an owner, PO, BA, designer, QA tester, new joiner or client should understand it without opening the code. Technical detail still exists, but in a separate layer below the readable part, so it never gets in the way.

| Layer | Who reads it | What it holds | Writing rules |
| --- | --- | --- | --- |
| **People layer** (the main body of every document, and the docs portal) | Owner, PO, BA, designer, QA, new joiners, clients | An "In short" box, who uses it, user journeys step by step, business rules, what happens when something goes wrong, flowcharts with business labels | Plain words; sentences under 25 words; no code names, file paths, SQL or HTTP codes; every domain term in the glossary; real examples ("a doctor books a 30-minute slot") |
| **Evidence and technical layer** (an appendix per document, and the `_map/` files) | Developers, QA, the AI in later phases | Citations (`Repo:path:line`), routes, tables, API calls, ER and sequence diagrams | Precise and complete; linked from the people layer by requirement ID |

**How the plugin keeps documents readable**

- **"In short" at the top of every document:** what the module does, who uses it, its 3–5 key rules, and how many questions are still open.
- **Citations move out of the sentence.** They sit in an Evidence column or a footnote, so the text reads cleanly while reviewers can still check every claim.
- **Business labels on business diagrams.** Flowcharts and the system block diagram say "Doctor books appointment", not `AppointmentController@store`. ER and sequence diagrams go in the technical appendix.
- **A plain-language check** runs on every document, like the citation check. It flags long sentences, code names or paths in the people layer, terms missing from the glossary, and words on a jargon list.
- **A readability reviewer agent** reads each document as a non-technical person would and lists what it could not follow; the writer fixes those before human review.
- **Optional translated copies** of the people layer for readers who prefer Hindi, Marathi or another language.

## Any stack, any project

The plugin learns each project from its code instead of being built for one stack. The `atreya` plugin's parsers only read Laravel, Blade and Flutter, which is the main thing this plugin changes.

**How detection works**

1. A script reads facts: manifests and lock files (`package.json`, `composer.json`, `pubspec.yaml`, `pom.xml`, `build.gradle`, `go.mod`, `pyproject.toml`, `*.csproj`, `Gemfile`), CI files, Docker files, migrations and test configs.
2. The detector agent reads real code to learn the architecture, conventions and folder layout. With permission, it runs the build and test commands to confirm they work.
3. It writes `profile.md`. A person confirms it before any other skill uses it. A monorepo gets one profile per app.

**How extraction stays stack-neutral**

- One common fact format: routes, handlers, screens, API calls, tables, external systems, events.
- Per-stack readers fill it. Planned first: Laravel, Flutter, Node/Express/Nest, React/Next, Django/FastAPI, Spring.
- A generic fallback (tree-sitter, the graphify code graph, LSP lookups, Claude reading) fills it for any other stack. Facts found this way are marked Inferred.

**Existing versus new projects**

- **Existing:** breakdown → document (writes, checks and draws each module), as in Understand and document in detail; `next` picks each step.
- **New or empty:** requirements first. The plugin then proposes 2–3 stack options with trade-offs, records the choice as an ADR, scaffolds the project and creates the profile.

**Process depth matches the task**

| Level | Used for | Phases run |
| --- | --- | --- |
| Quick | Bug fix or small change | ticket → impact (light) → fix → targeted test → handoff |
| Standard | A feature | story with acceptance criteria → short design note → implement → test cases → run → report |
| Full | New module or product | BRD → PRD → design and ADRs → stories → build → full STLC → release |

The plugin proposes a level from the request and the impact analysis; the person can change it.

## Using it on a repo

Yes: the plugin works on any Git repo, whether it is one repo on your machine, several connected repos, or a repo you only have a URL for. It installs once per person, then runs from whichever folder Claude Code is opened in.

| Situation | How it works |
| --- | --- |
| One repo on your machine | Open Claude Code in the repo folder and run `/sdlc:breakdown`. It asks before creating `sdlc-docs/`, either inside the repo or in a folder beside it. |
| Several connected repos (web, mobile, backend) | Use a workspace folder with `repos/` and `sdlc-docs/`. `breakdown` lists each repo and links them into one system. |
| A GitHub or GitLab URL | `breakdown` clones it read-only into `repos/` using your own Git credentials. |
| Everyone who works in a repo should have it | Commit `.claude/settings.json` in that repo with the marketplace and the enabled plugin (project scope). Teammates are offered the install when they trust the folder. |
| Run automatically on the repo | `doctor --ci` adds a GitHub Actions workflow that runs Claude Code headless on each pull request: docs sync check, impact analysis and security scans, posted as a PR comment. This needs an API key or token stored as a repo secret. |
| Browser sessions (claude.ai/code) | Cloud sessions do not load plugins from your local settings. Declaring the plugin in the repo's `.claude/settings.json` should make it available there; the pilot will confirm this. |

**What it never does to a repo**

- It never commits, pushes, pulls or creates branches; a person does all Git writes.
- It edits code only after a human-created approval exists for the work item, and only on a feature branch.
- It never installs packages in the product repo.
- If `sdlc-docs/` lives inside the repo, you decide whether it is committed (so docs travel with the code) or kept out of Git.

## Safety and guardrails

A fail-closed guard hook checks every tool call before it runs: if the guard crashes or cannot read a call, the call is blocked. This is the `atreya` guard (158 of 158 tests passing), made cross-platform and driven by each project's config instead of hard-coded names.

| Rule | Default | Per-project setting |
| --- | --- | --- |
| Secret files | Never read: `.env*` (not `.env.example`), keystores, Firebase and Google service files, private keys | Extra file names and patterns |
| Repo writes | Read-only, unless a human-created `APPROVED` file exists for the active work item **and** the repo is on a feature branch | Protected branch names |
| Git | Read-only commands only; a person commits, branches, pulls and pushes | None (cannot be loosened) |
| Package installs | Blocked inside product repos | Allowed folders |
| Risky commands | Framework commands limited to a safe list (e.g. `php artisan route:list`) | Allow-list per stack |
| Production hosts | Blocked for browser tools, web fetch and network commands | Host list |
| Tracker writes | Read freely; every create or update asks first | Tracker type |
| Self-protection | Claude cannot edit the plugin, its hooks, Claude Code settings or any `APPROVED` file | None |

**Keeping secrets and personal data out of documents**

- Script output that copies text from code passes a redaction filter for keys, tokens and passwords.
- A check fails any document containing a key-like string.
- **New: a personal-data guard.** Patient or personal data never goes into prompts, documents, tickets or test data. Database tools run read-only with masked columns, and test data is synthetic. This matters because Nadi Tarangini handles health data, and India's DPDP Act 2023 applies to personal data.

**Approvals and audit trail** Every gate (requirement, design, the `APPROVED` file, QA sign-off, release) records who approved, when, and which version of the document. Together with stable IDs this gives traceability from requirement to test to release.

## Tools and connectors

The default set is open source, runs offline and needs no account; connectors are switched on per project. Tools are launched with `npx`/`uvx` rather than copied into the plugin, so licences stay clean, and `doctor` reports what is missing. Checked against each tool's repo on 6 Nov 2026.

| Area | Default (built in) | Optional connectors |
| --- | --- | --- |
| Code understanding | [graphify](https://github.com/safishamsi/graphify) code graph (code parsed locally) · [Serena](https://github.com/oraios/serena) + official LSP plugins · [tree-sitter](https://github.com/tree-sitter/tree-sitter) / [ast-grep](https://github.com/ast-grep/ast-grep) · [Repomix](https://github.com/yamadashy/repomix) | [code-graph-rag](https://github.com/vitali87/code-graph-rag) or [CodeGraphContext](https://github.com/CodeGraphContext/CodeGraphContext) as MCP servers |
| Business documents | [MarkItDown MCP](https://github.com/microsoft/markitdown) · [Docling MCP](https://github.com/docling-project/docling-mcp) | Google Drive, Confluence |
| Diagrams | [Mermaid](https://github.com/mermaid-js/mermaid-cli) · [draw.io](https://github.com/jgraph/drawio) files written by scripts | [draw.io MCP](https://github.com/jgraph/drawio-mcp), PlantUML, D2 |
| Tracking | Markdown tickets in `work/` | [GitHub MCP](https://github.com/github/github-mcp-server) · [Zoho MCP](https://help.zoho.com/portal/en/kb/zoho-sprints/zoho-sprints-mcp-server/articles/zoho-sprints-mcp-server) · Jira ([mcp-atlassian](https://github.com/sooperset/mcp-atlassian)) · [Plane](https://github.com/makeplane/plane-mcp-server) · GitLab · Linear |
| Design | Mermaid flows and wireframes | [Penpot MCP](https://github.com/penpot/penpot) · Figma MCP |
| Database | [DBHub](https://github.com/bytebase/dbhub), read-only | MCP Toolbox for Databases |
| Build and review | Official plugins: feature-dev, pr-review-toolkit / code-review, security-guidance, code-simplifier | Context7 (library docs), framework plugins such as laravel-boost |
| Security | [Semgrep CE](https://github.com/semgrep/semgrep) · [gitleaks](https://github.com/gitleaks/gitleaks) · [Trivy](https://github.com/aquasecurity/trivy) · [OSV-Scanner](https://github.com/google/osv-scanner) | SonarQube, CodeQL |
| Web testing | [Playwright MCP](https://github.com/microsoft/playwright-mcp) + [Test Agents](https://playwright.dev/docs/test-agents) · [axe-core](https://github.com/dequelabs/axe-core) · [Lighthouse](https://github.com/GoogleChrome/lighthouse) | Chrome DevTools MCP |
| API testing | [Schemathesis](https://github.com/schemathesis/schemathesis) · [Bruno CLI](https://github.com/usebruno/bruno) | Postman |
| Mobile testing | None | [Maestro](https://github.com/mobile-dev-inc/maestro) · [Appium MCP](https://github.com/appium/appium-mcp) · [mobile-mcp](https://github.com/mobile-next/mobile-mcp) |
| Performance | None | k6 + [mcp-k6](https://github.com/grafana/mcp-k6) |
| Release and monitoring | GitHub Actions via the GitHub MCP | Docker MCP Gateway, Kubernetes MCP, Grafana MCP, Sentry MCP |

**Licence cautions**

- Not open source: SonarQube MCP, Sentry MCP (FSL) and the CodeQL CLI. These stay optional.
- Copyleft: Serena (GPL) and k6 (AGPL). The plugin calls them and never bundles them.
- Use the current homes, not the old ones: Semgrep's MCP is now inside the semgrep binary, and Penpot's MCP moved into the main penpot repo.

**Who uses what**

| Person | Main commands and outputs |
| --- | --- |
| Owner, PO, BA | `breakdown` (business questions, module approval), `document`, `validate`, `requirement`, impact reports |
| Designer | `design` (screen changes), `diagram`, screen lists in module cards |
| Developer | `impact`, `task`, `implement`, `review` |
| QA | `test-cases`, `test-run` |
| DevOps | `release`, `incident`, `doctor --ci` |
| Tech lead / one-person team | All of them, plus `status` |
| Non-technical readers | The docs portal, rebuilt by `sync` |

## Token management

Token cost grows with how much context Claude carries, so the plugin keeps context small by design rather than leaving it to each person ([Anthropic: manage costs](https://code.claude.com/docs/en/costs.md)).

| Lever | What the plugin does |
| --- | --- |
| Small always-on footprint | Phase skills are manual-only, so their descriptions stay out of context. SKILL.md files stay short; templates and rules load from `references/` only when a step needs them. The project's CLAUDE.md stays under 200 lines. The session banner is shown to the user but costs no tokens. |
| Scripts read, Claude reads summaries | Extractors write small per-module fact files; large JSON is queried, never pasted. Symbol lookups go through LSP or the code graph instead of grep and many file reads. |
| Hooks filter noise | Test output is cut to failures; logs to error lines. |
| State on disk, not in chat | Every phase writes its result and a handoff note to `work/<ID>/`. `status <ID>` reads that file, so a fresh session (`/clear`) between phases loses nothing. This is the biggest single saving. |
| Subagents for noisy work | Test runs, scans and the doc-checker run in a subagent; only the summary returns. |
| Bounded work | One module at a time. Each skill has a file-read budget and asks before going over it. |
| Small edits | Updates change only the affected sections of a document instead of rewriting it, cutting output tokens. |
| Compaction rules | The project profile tells compaction to keep IDs, file paths and decisions. |
| Connectors | A CLI is used where one exists (`gh`, `semgrep`, `trivy`), since CLIs add no tool listing to context. Each project enables only the connectors it needs; `doctor` flags unused ones. Tool and plugin sets stay stable mid-session so the prompt cache holds. |
| Measurement | `/usage` shows usage by skill, subagent, plugin and MCP server; `/context` shows what fills the window. Plugin evals record tokens per skill on test repos, and a large rise fails the check. On a Team plan, OpenTelemetry exports usage per person. |

## Model and effort routing

The model decides who does the work; effort decides how hard it thinks. Judgment, ambiguity and risk go to Opus 5.5; structured writing and code to Sonnet 5.5; mechanical work and summaries to Haiku 5.5; deterministic extraction to scripts with no model. List prices per million input/output tokens: Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50 up to 100k-token prompts, Fable 5.1 $10/$50 (not a default).

| Part | Command or step | Model | Effort |
| --- | --- | --- | --- |
| Set up | `doctor`, `status`, `standup` | Haiku | low |
| Set up | `breakdown` stages 1–4 (scripts, graphify, scanning) | Haiku | low |
| Set up | `breakdown` stage 5 (grouping into modules) | Opus | high |
| Set up | `breakdown` stage 6 (module cards and catalogue) | Sonnet | medium |
| Document | `document` (spec, BRD, PRD) | Sonnet | medium; Opus high for critical modules |
| Document | `diagram` (scripts draw; labels written) | Haiku / Sonnet | low |
| Document | `validate` (checker and readability reviewer) | Sonnet | medium; Opus high for critical modules |
| Document | `sync` (incl. portal rebuild) | Haiku | low |
| Plan | `impact` | Opus | high |
| Plan | `requirement`: gaps and requirements / stories | Opus / Sonnet | high / medium |
| Plan | `design`: architecture and ADRs / API, data and screen sections | Opus / Sonnet | high (xhigh for a new product) / medium |
| Build | `task` (plan; bug reproduction) | Sonnet | medium |
| Build | `implement` | Sonnet; Opus when impact is High or Critical | high |
| Build | `review`: code checks / security part | Sonnet / Opus | high |
| Test | `test-cases` | Sonnet | medium |
| Test | `test-run`: runner and report / defect triage | Haiku / Sonnet | low / medium |
| Release | `release`: notes, checklist, runbook / go-no-go decision | Sonnet / Opus | medium |
| Release | `incident` (root cause) | Opus | high |
| Support | scanner and explorer agents | Haiku | low |

The two background skills only load short reference text into whichever command is running, so they add no model choice of their own.

**Routing that adapts**

- **Three worker tiers:** `worker-light` (Haiku, low), `worker-standard` (Sonnet, medium), `worker-deep` (Opus, high). Skills hand steps to a tier, and a project can re-map tiers in `config.json` without editing the plugin. Tiers are needed because a subagent's effort can only be set in its own definition file.
- **Escalate on risk:** a High or Critical impact moves implement and review to the deep tier.
- **Escalate on failure:** if the checker fails the same work twice, or a bug's cause is still unknown after one attempt, the step moves up one tier.
- **Scale by level:** Quick tasks never use Opus; Full work uses Opus for planning and design only.
- **Developers' main session:** the `opusplan` model setting, which uses Opus in plan mode and Sonnet for execution.

**Pitfalls the plugin checks for**

- The `CLAUDE_CODE_EFFORT_LEVEL` environment variable overrides every other effort setting; `doctor` warns when it is set.
- Users have reported cases where a skill's model and effort settings were not applied. An eval checks which model each step actually ran on.
- An organisation can cap effort with `maxEffortLevel`, which is useful on a shared account.

## Quality, rollout and governance

The plugin is tested like a product, because a bug in it reaches all 15 people at once.

**Testing**

- Guard tests for every safety rule, including attempts to get around it (the `atreya` suite is the starting point).
- Script tests on small fake repos for each stack reader.
- Evals on golden repos: one Laravel + Flutter multi-app system, one Node/React app, one Python app and one empty folder. Each eval measures accuracy (doc-checker Verified rate, human corrections), tokens per skill, and which model actually ran.
- `claude plugin validate` before every push.

**Release**

- An org-owned private marketplace repo with named code owners and a licence.
- Semantic versions, a CHANGELOG, and releases tagged with `claude plugin tag`.
- Two channels: `beta` for the pilot group and `stable` for everyone.
- Rollout: each product repo commits `.claude/settings.json` with the marketplace and the enabled plugin. On a Team or Enterprise plan, managed settings can also allow only this marketplace and force-install the plugin.

**Feedback loop**

- `doctor` shows a link to file an issue on the plugin repo, with the command, version and context filled in.
- A monthly review of `/usage` attribution, eval results and feedback decides what to fix next.

**Working habits it supports**

- `standup` (optional) drafts the daily update; the person checks and sends it.
- `review` produces the submission summary (the handoff): a line-by-line diff, test evidence and ticket link.

## Step-by-step build plan

We build in eleven steps, one at a time; each ends with a gate you approve before the next starts. Every step follows the same loop: build → `claude plugin validate` → tests and evals → one pilot user → tagged release. Dates are left for you to set after review.

1. **Charter sign-off.** Approve this plan; settle the name, trackers and docs location (Risks and decisions). *Gate: decisions recorded.*
2. **Skeleton, guard and graphify setup.** Marketplace repo, manifest, the cross-platform guard with its tests, the banner, `doctor` with the graphify and LSP checks. *Gate: all guard tests pass on macOS and Windows; `doctor` finds or installs graphify.*
3. **`breakdown` stages 1–2.** Find the repos, business questions, stack detection and profiles. *Gate: correct profiles on the four golden repos, including the empty folder.*
4. **`breakdown` stages 3–6.** Stack readers (porting the `atreya` scripts), the graphify graph, the generic fallback, cross-app linking, module proposal, catalogue and module cards. *Gate: every backend route assigned or explained on the Nadi Tarangini repos; a non-Laravel repo broken down; a second run with no code change says "Already up to date".*
5. **`document` and `validate`.** Templates, the doc-checker, the plain-language check, the readability reviewer. *Gate: two modules documented; a non-technical reader understands them.* (13 Nov: the sign-off part was removed; documents end at Checked.)
6. **`diagram` and `sync`.** Module and system diagrams in Mermaid and draw.io, staleness detection, the docs portal. *Gate: a full system documented and browsable in the portal.*
7. **`impact`, `requirement`, `design`.** *Gate: one real feature specified and approved.*
8. **`task`, `implement`, `review`** and the three worker tiers. *Gate: that feature built with every approval gate respected.*
9. **`test-cases`, `test-run`.** *Gate: that feature tested and its traceability matrix complete.*
10. **`release`, `incident`, `status`, `doctor --ci`.** *Gate: a second feature goes from requirement to release.*
11. **Pilot and release.** Beta to 3 people on one product, then stable to the whole team. *Gate: two weeks of beta use with no blocking issues.*

The team gets the plugin once, complete, after step 11. Steps 1–10 are internal builds tested on the pilot project.

## Risks and decisions needed

**Decisions for the reviewer**

- [ ] Plugin name (commands appear as `/name:skill`; working name `sdlc`)
- [ ] Trackers to support: Zoho only, or Zoho + GitHub Issues + Jira, with plain-text tickets as the fallback
- [ ] Where docs live: a separate `sdlc-docs` folder per system (proposed), or inside each product repo, and whether they are committed to Git
- [ ] Strict mode on by default (every "better with" step becomes "needs first")?
- [ ] Add the industry-practice extras: threat modelling, SBOM and licence checks, live security testing, feature flags, gradual releases, monitoring and SLOs, contract and mutation tests, migration checks, AI feature evaluation
- [ ] Audience: private to the org, or written so it could be published later
- [ ] Claude accounts: individual Team seats (needed for per-person usage, managed rollout and ticket attribution) or the current shared account
- [ ] Plugin owner and code owners; who reviews pull requests to the plugin
- [ ] The pilot system (proposed: Nadi Tarangini web, mobile and backend) and the pilot users
- [ ] Confirm with the owner that one complete release is acceptable instead of a documentation-only first version
- [ ] Approve the proposed targets: under 10% of statements corrected at review; two weeks of beta before stable

**Risks**

| Risk | Effect | Mitigation |
| --- | --- | --- |
| Stack detection or the generic fallback is wrong on an unfamiliar stack | Wrong maps and specs | A person confirms the profile; fallback facts are marked Inferred; the doc-checker re-reads cited code |
| One complete release instead of the owner's documentation-first version | Longer before anyone uses it; goes against the owner's "functional first" guidance | Gated steps; documentation skills built and piloted first; agree the approach with the owner before step 2 |
| Token cost grows with large repos | Hitting usage limits on a shared account | One module per run, state on disk, model tiers, a per-skill token check in the evals |
| Claude Code changes settings or behaviour | Skills or routing break silently | Evals run on every release and after Claude Code updates; minimum version pinned in the docs |
| Secrets or personal data leak into docs or prompts | Security and legal exposure | Fail-closed guard, redaction, a key check on every doc, the personal-data guard, read-only masked database access |
| A single maintainer | Plugin stalls | Named code owners, tests, CHANGELOG, contribution guide |
| Copyleft or non-open tools bundled by mistake | Licence issues | Tools launched via npx/uvx, never vendored; licence check in review |

## Sources

- Existing plugin reviewed: [smohinii25/atreya-ai-plugins](https://github.com/smohinii25/atreya-ai-plugins) (v0.2.0, read 6 Nov 2026)
- [Claude Code: plugins overview](https://code.claude.com/docs/en/plugins/overview.md) · [plugin dependencies](https://code.claude.com/docs/en/plugin-dependencies.md) · [manage costs](https://code.claude.com/docs/en/costs.md) · [model configuration](https://code.claude.com/docs/en/model-config.md)
- [Claude Code plugins for teams](https://www.developersdigest.tech/blog/claude-code-plugins-for-teams-2026) (Developers Digest)
- Skill invocation control: [Claude Code Playbook](https://claude-code-playbook.pages.dev/en/docs/level-4/custom-skills)
- Effort settings: [model vs effort](https://claudefa.st/blog/guide/development/model-vs-effort) · [maxEffortLevel](https://claudelog.com/faqs/what-is-max-effort-level-in-claude-code/) · [skill effort issue](https://claudeissues.com/issue/69267-bug-skill-effort-frontmatter-is-documented-but-has-no-runtime-effect) · [skill model routing issue](https://claudeissues.com/issue/84262-bug-skill-frontmatter-model-effort-fields-are-parsed-but-not-applied-to-api-rout)
- Model prices: [Opus 5.5](https://letsdatascience.com/news/anthropic-launches-claude-opus-55-with-safeguards-5d52f322) · [Haiku 5.5](https://techenclave.com/news/items/claude-haiku-5-5-launches-with-0-10-input-pricing-for-shorter-prompts) · [Opus vs Sonnet vs Haiku 5.5](https://tech-insider.org/claude-opus-vs-sonnet-vs-haiku-5-5-2026/) · [Fable 5.1](https://betanews.com/article/claude-opus-5-5-launch-price-cut/)
- Spec-driven patterns: [GitHub Spec Kit](https://github.com/github/spec-kit) · [OpenSpec](https://github.com/Fission-AI/OpenSpec) · [BMAD Method](https://github.com/bmad-code-org/BMAD-METHOD) · [Superpowers](https://github.com/obra/superpowers)
- Tool links are in Tools and connectors.
