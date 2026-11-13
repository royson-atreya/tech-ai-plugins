---
name: design
description: Decide how a work item is built - the approach, decisions recorded as ADRs with their options, and the screen, API and data changes, with every requirement covered - in work/<ID>/design.md; a developer or tech lead approves it. Needs /tech-plugin:requirement first. Run as /tech-plugin:design <ID> [--force].
argument-hint: "<work ID> [--force]"
disable-model-invocation: true
model: haiku
effort: low
allowed-tools: Bash(node:*), Read, Write, Agent
---

# /tech-plugin:design

Arguments: `$ARGUMENTS`. Scripts: `${CLAUDE_PLUGIN_ROOT}/scripts/work/`.

## Rules

- You orchestrate; `tech-plugin:design-architect` writes the approach and decisions, `tech-plugin:design-writer` the details. Never write or edit `design.md` yourself.
- Never answer an open question yourself, and never change a requirement here.
- Record an approval only when the person says yes and gives their name and role. Never approve on their behalf.
- Answers go into a file, never into a command line (see `work-items.md`). Never open secret files.

## What to do

1. **Find the home repo** as `/tech-plugin:document` does. No `modules.yaml`: say "Run /tech-plugin:breakdown first" and stop.
2. **No work ID:** run `node "${CLAUDE_PLUGIN_ROOT}/scripts/work/work.mjs" list --home <home>` and ask which item. Stop.
3. Follow `${CLAUDE_PLUGIN_ROOT}/references/work/design-flow.md`, with `${CLAUDE_PLUGIN_ROOT}/references/work/work-items.md` for answers and approvals.
