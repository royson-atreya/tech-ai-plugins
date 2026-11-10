# tech-plugin

An SDLC/STLC toolbox for Claude Code that takes any software project from "understand what we have" to "release it safely", with a person approving every important step. Commands are `/tech-plugin:<command>`; each product repo gets its own notebook folder, `<repo>/sdlc-docs/`.

**Status: 0.2.0, build step 3 of 11.** This version contains the safety guard, the session banner, `doctor`, and stages 1–2 of `breakdown`. The other commands come in later steps (see `docs/PLAN.md` in the marketplace repo).

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
| `/tech-plugin:breakdown` | Finds the repos and apps of a system, asks 5 business questions, detects each app's stack, and writes `system.yaml` and `profile.md` for you to confirm. Stages 1–2 of 6 in this version. |

Both commands run on Haiku at low effort and are manual-only (`disable-model-invocation`), so they add nothing to the context until you run them.

## breakdown (stages 1–2)

Run it in a repo, in a workspace folder that holds several repos, or with paths:

```
/tech-plugin:breakdown                       # this repo, or every repo in this workspace
/tech-plugin:breakdown ../backend ../mobile  # these folders
/tech-plugin:breakdown --docs ~/Docs/specs   # also list a folder of business documents
/tech-plugin:breakdown --only 2              # re-run one stage
/tech-plugin:breakdown --refresh             # re-detect after code changes
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

**Running it again.** If no repo changed since you confirmed the profile, it answers "Already up to date" at almost no token cost. A new commit, or a changed manifest, re-runs stage 2 for that repo only. Edits you make to `system.yaml` are kept when stage 1 runs again.

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
scripts/breakdown/           find-repos, detect, state, write (used by /tech-plugin:breakdown)
scripts/lib/stacks.mjs       stack detection; lib/yaml.mjs small YAML reader/writer; lib/secretnames.mjs
skills/doctor/SKILL.md       the doctor command
skills/breakdown/SKILL.md    the breakdown command; stage details in references/breakdown/
agents/stack-detector.md     read-only architecture notes for one app (Haiku)
config/defaults.json         secret patterns, protected branches, safe-command lists, blocked hosts
tests/                       guard, doctor and breakdown tests (node --test tests/)
```
