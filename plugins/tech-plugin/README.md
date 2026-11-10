# tech-plugin

An SDLC/STLC toolbox for Claude Code that takes any software project from "understand what we have" to "release it safely", with a person approving every important step. Commands are `/tech-plugin:<command>`; each product repo gets its own notebook folder, `<repo>/sdlc-docs/`.

**Status: 0.1.0, build step 2 of 11.** This version contains the skeleton, the safety guard, the session banner and `doctor`. The other commands come in later steps (see `docs/PLAN.md` in the marketplace repo).

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

`doctor` runs on Haiku at low effort and is manual-only (`disable-model-invocation`), so it adds nothing to the context until you run it.

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
skills/doctor/SKILL.md       the doctor command
config/defaults.json         secret patterns, protected branches, safe-command lists, blocked hosts
agents/  references/         empty until later steps
tests/                       guard and doctor tests (node --test tests/)
```
