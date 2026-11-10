---
name: breakdown
description: Break a system (this repo, every repo in this workspace, or the paths/URLs given) into its repos and apps, detect each app's stack, and write sdlc-docs/system.yaml and profile.md for you to confirm. Stages 1-2 of 6 in this version.
argument-hint: "[paths | git URLs] [--docs <folder>] [--only 1|2] [--refresh]"
disable-model-invocation: true
model: haiku
effort: low
allowed-tools: Bash(node:*), Read, Write, Edit, Agent
---

# /tech-plugin:breakdown

Arguments: `$ARGUMENTS`

Scripts live in `${CLAUDE_PLUGIN_ROOT}/scripts/breakdown/`. Run them with
`node "${CLAUDE_PLUGIN_ROOT}/scripts/breakdown/<script>" …`.

Where the run stands:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/breakdown/state.mjs" status`

## Rules for the whole command

- Write only inside each repo's `sdlc-docs/`. Before creating `sdlc-docs/` in any repo for the first time, ask the user and wait for a yes.
- Never open secret files. Never run a repo's build, test or install commands; they are recorded as "found, not run".
- Never run `git clone`. For a git URL, show the clone command from `find-repos.mjs` and stop until the user has run it.
- Never paste `stack.json` or other `_map/` files into the chat. Use the scripts' one-line summaries and the `summary` table.
- Keep your messages short: one question block per stage, one table per approval.

## What to do

1. **Pick the stage.**
   - With `--only 1` or `--only 2`, run that stage.
   - Without `--only`, use `next` from the status above.
   - If `next` is `up-to-date` and there is no `--refresh`, reply with the status `message`, list the files in `sdlc-docs/`, and stop.
   - With `--refresh`, run stage 2 for the repos whose `changed` is true, or for every repo if none changed.
2. **Stage 1 (find the repos):** read `${CLAUDE_PLUGIN_ROOT}/references/breakdown/stage-1-find.md` and follow it.
3. **Stage 2 (learn each repo):** read `${CLAUDE_PLUGIN_ROOT}/references/breakdown/stage-2-learn.md` and follow it. Stage 2 runs straight after stage 1 unless the repo is empty.
4. **End.** List the files written and say what comes next: "Stages 3–6 (read the code, link the apps, propose modules, write the breakdown) come in the next tech-plugin version."
