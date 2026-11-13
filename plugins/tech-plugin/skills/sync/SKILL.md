---
name: sync
description: Find the documents and diagrams that no longer match the code, refresh the ones you pick (documents through the document flow, diagrams by script), pick up new business documents from the folders in system.yaml, and rebuild the docs portal (sdlc-docs/portal/index.html). Run as /tech-plugin:sync [--portal].
argument-hint: "[--portal]"
disable-model-invocation: true
model: haiku
effort: low
allowed-tools: Bash(node:*), Read, Agent
---

# /tech-plugin:sync

Arguments: `$ARGUMENTS`. Script: `${CLAUDE_PLUGIN_ROOT}/scripts/sync/sync.mjs`.

## Rules

- You orchestrate; scripts and agents write. Never edit a document, a diagram or a portal page yourself.
- Refresh only what the user picks. Never approve anything: only `/tech-plugin:validate` records approvals.
- Never run a conversion command or install anything: show the commands for the user to run.
- Never paste whole documents, `_facts` files or `_state/` files into the chat.

## What to do

1. **Find the home repo** as `/tech-plugin:document` does.
2. **`--portal`:** go to step 5.
3. **Status.** Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/sync/sync.mjs" status --home <home>`.
   - **`next` is `restart` or `breakdown`:** reply with `message` and stop.
   - **`next` is `up-to-date`:** say so, then go to step 5.
   - **Otherwise** follow `${CLAUDE_PLUGIN_ROOT}/references/sync/sync-flow.md`.
4. **Refresh** what the user picked, as the flow says.
5. **Portal.** Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/sync/sync.mjs" portal --home <home>`. It rebuilds only when what it shows has changed.
6. **End.** List what was refreshed, what was left, and the portal path (`index` in the JSON). Remind the user that a refreshed document is a Draft until `/tech-plugin:validate <module>` records the approvals again.
