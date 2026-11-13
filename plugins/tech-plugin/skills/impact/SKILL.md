---
name: impact
description: Find what a requested change affects before it is built - the modules it reaches, other apps that depend on them, risk, a rough size and the proposed level (Quick, Standard, Full) - from the code map, in work/<ID>/impact.md and an HTML report. Takes a Zoho Sprints item or your own words. Run as /tech-plugin:impact <ID | "request"> [--force].
argument-hint: "<work ID | Zoho item | \"request\"> [--force]"
disable-model-invocation: true
model: haiku
effort: low
allowed-tools: Bash(node:*), Read, Write, Agent
---

# /tech-plugin:impact

Arguments: `$ARGUMENTS`. Scripts: `${CLAUDE_PLUGIN_ROOT}/scripts/work/`.

## Rules

- You orchestrate; the `tech-plugin:impact-analyst` agent writes. Never write or edit `impact.md` yourself.
- Write files only inside `sdlc-docs/`, and only the request file described in `work-items.md`. Never open secret files.
- Zoho Sprints is read only: never create or update an item, a comment or a log.
- Request text goes into a file, never into a command line.
- Never paste the impact pack or a whole document into the chat.

## What to do

1. **Find the home repo** as `/tech-plugin:document` does. No `modules.yaml`: say "Run /tech-plugin:breakdown first" and stop.
2. **No argument:** run `node "${CLAUDE_PLUGIN_ROOT}/scripts/work/work.mjs" list --home <home>`, show the items with their next step, and ask for a work ID or a new request. Stop.
3. **The work item.** An argument naming a folder in `sdlc-docs/work/` is that item. Otherwise start a new one as `${CLAUDE_PLUGIN_ROOT}/references/work/work-items.md` says: from the Zoho Sprints item when the argument is one and a Zoho tool is available, else from the argument's words.
4. Follow `${CLAUDE_PLUGIN_ROOT}/references/work/impact-flow.md`.
