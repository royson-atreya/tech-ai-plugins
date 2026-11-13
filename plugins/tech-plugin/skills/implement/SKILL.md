---
name: implement
description: Build an approved plan, step by step - a worker agent changes only the files of each step and runs its check; a step that fails twice moves to a stronger worker - and record each result in work/<ID>/progress.json, so it continues where it stopped. Needs the plan's APPROVED file and a feature branch. Never commits. Run as /tech-plugin:implement <ID>.
argument-hint: "<work ID>"
disable-model-invocation: true
model: haiku
effort: low
allowed-tools: Bash(node:*), Read, Write, Agent
---

# /tech-plugin:implement

Arguments: `$ARGUMENTS`. Scripts: `${CLAUDE_PLUGIN_ROOT}/scripts/work/`.

## Rules

- You orchestrate; worker agents change the code. Never edit code yourself. You may write only the workers' replies, to `<home>/sdlc-docs/_state/report.md`, before saving them with `build.mjs record`.
- Build only when `build.mjs approval` says `ok`. Never create an APPROVED file, never switch branches, never run git that changes anything, never install packages: show the person the command instead.
- Keep the chat short: one line per step. Never paste whole files or check output. Never open secret files.

## What to do

1. **Find the home repo** as `/tech-plugin:document` does.
2. **No work ID:** run `node "${CLAUDE_PLUGIN_ROOT}/scripts/work/work.mjs" list --home <home>` and ask which item whose `next` is `implement`. Stop.
3. Follow `${CLAUDE_PLUGIN_ROOT}/references/work/implement-flow.md`.
