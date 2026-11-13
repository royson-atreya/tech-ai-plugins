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

You do these steps yourself:

1. Create an empty file `sdlc-docs/work/W-001/APPROVED`.
2. Put `W-001` in `sdlc-docs/work/.active`.
3. Switch to a feature branch (not `main` or `master`).

Delete `APPROVED` to close the gate again.

## Something went wrong?

| You see | Do this |
| --- | --- |
| "Run /tech-plugin:breakdown first" | Run `/tech-plugin:breakdown` in the project. |
| "A newer tech-plugin is installed" | Restart Claude Code. |
| "Already up to date" | Nothing changed. Add `--force` to redo it anyway. |
| A command is blocked | Read the rule in the message. See "What it will never do". |
| Not sure what to do next | Run `/tech-plugin:next`. |
| Anything else | Run `/tech-plugin:doctor`. |

## More detail

- [REFERENCE.md](REFERENCE.md): every stage, check and guard rule, project settings, tests and file layout.
- [CHANGELOG.md](CHANGELOG.md): what changed in each version.
