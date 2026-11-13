---
name: next
description: The one command to remember. Works out the next step for this project from what is already in sdlc-docs/ (break down the code, document a module, refresh what no longer matches the code, continue a work item) and runs it after a yes. Run as /tech-plugin:next [yes].
argument-hint: "[yes]"
disable-model-invocation: true
model: haiku
effort: low
allowed-tools: Bash(node:*), Read, Write, Edit, Agent
---

# /tech-plugin:next

Arguments: `$ARGUMENTS`. Plugin folder: `${CLAUDE_PLUGIN_ROOT}`.

## Rules

- You only pick the step; the step's own instructions do the work. Every rule in them applies: their stops, the person's approvals, what they may write.
- Keep the chat short: at most two lines before the question.

## What to do

1. Run:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/next.mjs" --cwd "<the current folder>"
   ```

2. **`next` is `restart`:** reply with `why` and stop.
   **`next` is `done`:** reply with `why`, then `hint`, and stop.
3. Otherwise say `why`, then `progress` if there is one, then the command it will run (`command`). Ask "Start? (yes/no)". If the arguments are `yes`, do not ask: start.
4. **Yes:** read `${CLAUDE_PLUGIN_ROOT}/skills/<skill>/SKILL.md` (`skill` from the JSON) and follow it from its "What to do", as if the person had typed `command`:
   - its `$ARGUMENTS` are `args` from the JSON (none when `args` is null);
   - `${CLAUDE_PLUGIN_ROOT}` in it is the plugin folder given above.
5. **No:** stop, and say they can run `command` themselves later.
