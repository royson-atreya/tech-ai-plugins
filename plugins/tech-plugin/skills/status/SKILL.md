---
name: status
description: Where everything stands - every work item and its next step (planning, waiting for approval, building, testing, fixing defects, ready to release, released), open defects, open incidents, the last releases, and how many modules are documented, checked and have a regression suite. With a work ID, continues that item where it stopped, even in a fresh session. Run as /tech-plugin:status [work ID].
argument-hint: "[work ID]"
disable-model-invocation: true
model: haiku
effort: low
allowed-tools: Bash(node:*), Read, Write, Edit, Agent
---

# /tech-plugin:status

Arguments: `$ARGUMENTS`. Plugin folder: `${CLAUDE_PLUGIN_ROOT}`.

## What to do

1. **No work ID:** run `node "${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs" --cwd "<the current folder>"` and show, briefly:
   - open incidents first (they come before everything);
   - a table of work items: ID, title, phase, next step (`nextText`), open defects;
   - ready to release, and the last releases;
   - modules: documented, checked, diagrams, regression suites (of the total);
   - the breakdown, when it is not up to date.
   End with: "Continue one with /tech-plugin:status <ID>, or let /tech-plugin:next pick."
2. **A work ID:** run `node "${CLAUDE_PLUGIN_ROOT}/scripts/next.mjs" --cwd "<the current folder>" --item <ID>`. Say `why` and the command, and ask "Continue? (yes/no)". On yes, read `${CLAUDE_PLUGIN_ROOT}/skills/<skill>/SKILL.md` and follow it from its "What to do", with `args` as its arguments, exactly as `/tech-plugin:next` does. `next` is `done`, `tested` or `released`: say so and stop.
