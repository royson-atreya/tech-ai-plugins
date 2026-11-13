# tech-plugin

A Claude Code plugin that reads your code, writes plain-language documents and diagrams for it, and helps plan new work. It never commits, never reads secrets, and only edits code after a person approves.

Every command starts with `/tech-plugin:`. Everything it writes goes into one folder in your repo: `sdlc-docs/`.

## Install

In Claude Code:

```
/plugin marketplace add royson-atreya/tech-ai-plugins
/plugin install tech-plugin@tech-ai-plugins
```

Restart Claude Code. The first line of each session shows the plugin is on:

```
tech-plugin v0.6.0 | repo my-app | sdlc-docs: not set up | guard on | next: /tech-plugin:next
```

**Update to a new version:**

```
/plugin marketplace update tech-ai-plugins
/plugin update tech-plugin@tech-ai-plugins
```

Then restart Claude Code.

**Check your setup:** `/tech-plugin:doctor`. It lists anything missing and the command to install it, and ends with how to use the plugin.

## How to use it

### The one command to remember

```
/tech-plugin:next
```

It looks at what is already done in this project, tells you the next step in one line, and runs it after your **yes**:

```
Next module: Patients. It has no documents yet.
3 of 16 modules documented and checked
It will run /tech-plugin:document patients. Start? (yes/no)
```

Run it again whenever you come back. It goes through everything in order: reading the code, the system diagram, each module, refreshing what changed, and any new work you started. Add `yes` to skip the question: `/tech-plugin:next yes`.

### What it runs for you (you can also type these yourself)

**1. Once per project: understand the code**

```
/tech-plugin:breakdown
```

It reads the code and splits it into business modules (for example *Patients*, *Reports*, *Billing*). It stops twice for you: to confirm the tech stack, and to approve the module list.

**2. For each module: documents and diagrams in one go**

```
/tech-plugin:document patients
```

It writes the spec, BRD and PRD, checks every line of code they cite and fixes what is wrong, then draws the diagrams. A document that passes is marked **Checked**. No sign-off is needed.

Every diagram comes twice: as Mermaid (shown on GitHub and in the docs website) and as a `.drawio` file you can open and rearrange in [draw.io](https://www.drawio.com) or diagrams.net. If you rearrange a `.drawio` file, a later redraw never overwrites it: it writes `<name>.new.drawio` beside it.

**3. When the code changes: refresh**

```
/tech-plugin:sync
```

It lists the documents and diagrams that no longer match the code, refreshes the ones you pick, and rebuilds the docs website. Open `sdlc-docs/portal/index.html` in a browser to read everything.

**4. For new work: plan it**

```
/tech-plugin:impact "Doctors want to download the pulse report"   # starts work item W-001
/tech-plugin:requirement W-001                                     # requirements and user stories
/tech-plugin:design W-001                                          # how to build it
```

- `impact` shows which modules the change touches, the risk and a rough size.
- `requirement` asks you about any gaps. The owner, PO or BA approves it.
- `design` writes the approach. A developer or tech lead approves it.

With a Zoho Sprints item, give its number instead of the words: `/tech-plugin:impact NT-I42`.

**5. Build it: plan, code, review**

```
/tech-plugin:task W-001         # the plan: steps, the files each changes, the test for each
/tech-plugin:implement W-001    # writes the code step by step and runs each step's test
/tech-plugin:review W-001       # code and security review, fixes, then handoff.md
```

`task` ends by printing two commands **you** run in your own terminal to approve the plan. Claude can never run them:

```
git -C ~/Atreya/web switch -c feature/w-001-download-the-report
printf 'plan %s\nby %s\n' 3f9a01c2b4d5e6f7 "Royson" > ~/Atreya/web/sdlc-docs/work/W-001/APPROVED
```

If the plan changes after you approve it, `implement` stops and gives you the new line. `review` ends with `handoff.md`: what changed, how to check it by hand, the review results and a ready commit message. You commit and push; after the merge, run `/tech-plugin:sync`.

**A bug** skips requirements and design. Describe it, or give its Zoho number:

```
/tech-plugin:task "The export button on the patient page does nothing"
```

The plan's first step is a test that fails because of the bug, so the fix is proven.

**6. Test it**

```
/tech-plugin:test-cases W-001                    # test cases, each tied to a requirement
/tech-plugin:test-run W-001 --env staging        # runs them, drafts defects, writes the report
/tech-plugin:test-run W-001 --sanity --env staging       # only the few critical cases
/tech-plugin:test-run W-001 --regression --env staging   # plus the modules' regression suites
```

- Cases are repo tests, API calls, browser steps (Playwright), or manual steps you answer pass/fail. Test data is always made up.
- It never runs against an environment marked production in `system.yaml`.
- A failure becomes a defect (`DEF-W-001-01`) in `tests/defects.md`. Fix it with `/tech-plugin:task DEF-W-001-01`, then run the tests again. Zoho Sprints items are created only after your yes.
- `tests/test-report.md` and `tests/rtm.md` (requirement → cases → result → defects) are rebuilt on every run. Nobody signs them off.
- A module gets a regression suite with `/tech-plugin:test-cases patients`. Passing work items add their regression cases to it.

## All commands

| Command | Example | What you get |
| --- | --- | --- |
| `next` | `/tech-plugin:next` | The next step, run after your yes |
| `doctor` | `/tech-plugin:doctor` | Setup check and how to use |
| `breakdown` | `/tech-plugin:breakdown` | Module list, module cards, system map |
| `document` | `/tech-plugin:document patients` | `modules/patients/spec.md`, `brd.md`, `prd.md`, checked, and its diagrams |
| `validate` | `/tech-plugin:validate patients` | Only the checks: documents marked Checked |
| `diagram` | `/tech-plugin:diagram patients` | Only the diagrams: `modules/patients/diagrams/` (`.md` and `.drawio`) |
| `diagram system` | `/tech-plugin:diagram system` | Whole-system block diagram and journeys |
| `sync` | `/tech-plugin:sync` | Refreshed docs and the portal website |
| `impact` | `/tech-plugin:impact "request"` | `work/W-001/impact.md` and an HTML report |
| `requirement` | `/tech-plugin:requirement W-001` | `work/W-001/requirement.md` |
| `design` | `/tech-plugin:design W-001` | `work/W-001/design.md` |
| `task` | `/tech-plugin:task W-001` or `/tech-plugin:task "bug in words"` | `work/W-001/plan.md` and the 2 commands to approve it |
| `implement` | `/tech-plugin:implement W-001` | The code, step by step, each step's test run |
| `review` | `/tech-plugin:review W-001` | Reviews, fixes, `work/W-001/handoff.md` and a ready commit message |
| `test-cases` | `/tech-plugin:test-cases W-001` or `patients` | `tests/test-cases.md`: cases tied to requirements |
| `test-run` | `/tech-plugin:test-run W-001 --env staging` | Results, defects, `tests/test-report.md` and `tests/rtm.md` |

All paths are inside `sdlc-docs/`.

**Useful options**

```
/tech-plugin:next yes                         # run the next step without asking
/tech-plugin:breakdown ../backend ../mobile   # break down these repos together
/tech-plugin:breakdown --docs ~/Docs/specs    # also read business documents
/tech-plugin:breakdown --refresh              # re-read after code changes
/tech-plugin:document patients brd            # write and check only the BRD
/tech-plugin:document patients --write-only   # write, but leave checking and drawing for later
/tech-plugin:document patients --force        # rewrite even if up to date
/tech-plugin:validate patients prd            # check only the PRD
/tech-plugin:sync --portal                    # only rebuild the website
```

Running a command again when nothing has changed just says **"Already up to date"**.

## What it will never do

- **Read secrets:** `.env` files, keys and keystores are blocked.
- **Use git to change anything:** it only reads (`status`, `diff`, `log`). You commit and push.
- **Edit your code without approval:** it writes only inside `sdlc-docs/` until a person approves a work item.
- **Install packages** inside your repo.

If it blocks something, the message says which rule and why:

```
tech-plugin: BLOCKED [git] git commit is not on the read-only list (status, diff, log, …); a person runs git writes
```

### Letting it edit code (for one work item)

Code is edited only when all three are true, in each repo the plan changes:

1. `sdlc-docs/work/.active` names the work item (`/tech-plugin:task` writes it);
2. `sdlc-docs/work/W-001/APPROVED` exists: **you** create it, with the line `/tech-plugin:task` prints;
3. the repo is on a feature branch (not `main` or `master`): **you** switch to it.

`/tech-plugin:review` closes the gate again when it writes the handoff. To close it earlier, delete `sdlc-docs/work/.active`.

## Something went wrong?

| You see | Do this |
| --- | --- |
| "Run /tech-plugin:breakdown first" | Run `/tech-plugin:breakdown` in the project. |
| "A newer tech-plugin is installed" | Restart Claude Code. |
| "Already up to date" | Nothing changed. Add `--force` to redo it anyway. |
| A command is blocked | Read the rule in the message. See "What it will never do". |
| "needs install: …" during implement | Run that install yourself, then `/tech-plugin:implement W-001` again. |
| UI test cases "blocked" | Install the Playwright plugin; `/tech-plugin:doctor` shows the test tools. |
| "the guard allows php artisan only with …" | Run tests with `vendor/bin/phpunit` or `vendor/bin/pest`; the guard limits `php artisan`. |
| Not sure what to do next | Run `/tech-plugin:next`. |
| Anything else | Run `/tech-plugin:doctor`. |

## More detail

- [REFERENCE.md](REFERENCE.md): every stage, check and guard rule, project settings, tests and file layout.
- [CHANGELOG.md](CHANGELOG.md): what changed in each version.
