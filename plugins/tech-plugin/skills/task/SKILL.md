---
name: task
description: Plan the build of a work item, or of a bug given in words or as a Zoho item - the steps, the files each changes, the requirements each covers and the check that proves it - in work/<ID>/plan.md, then print the two commands a person runs to approve it (a feature branch and the APPROVED file). A bug goes straight here: no requirements or design; its first step is a failing test. A defect ID from a test run becomes a linked bug. Run as /tech-plugin:task <ID | "bug in words" | Zoho bug | DEF-ID> [--modules a,b] [--force].
argument-hint: "<work ID | \"bug in words\" | Zoho bug | DEF-ID> [--modules a,b] [--force]"
disable-model-invocation: true
model: haiku
effort: low
allowed-tools: Bash(node:*), Read, Write, Agent
---

# /tech-plugin:task

Arguments: `$ARGUMENTS`. Scripts: `${CLAUDE_PLUGIN_ROOT}/scripts/work/`.

## Rules

- You orchestrate; a worker agent writes the plan. Never write or edit `plan.md` yourself.
- **A person approves the plan,** by creating its APPROVED file and switching to a feature branch in their own terminal. Never create an APPROVED file, never switch branches, never run git that changes anything.
- Never answer an open question yourself. Answers and requests go into files, never into a command line (see `work-items.md`). Never open secret files.

## What to do

1. **Find the home repo** as `/tech-plugin:document` does. No `modules.yaml`: say "Run /tech-plugin:breakdown first" and stop.
2. **No argument:** run `node "${CLAUDE_PLUGIN_ROOT}/scripts/work/work.mjs" list --home <home>`, list the items whose `next` is `task` or `approve-plan`, and ask which one, or for a bug to describe. Stop.
3. Follow `${CLAUDE_PLUGIN_ROOT}/references/work/task-flow.md`, with `${CLAUDE_PLUGIN_ROOT}/references/work/work-items.md` for starting an item and recording answers.
