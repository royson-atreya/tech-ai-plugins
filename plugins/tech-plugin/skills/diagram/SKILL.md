---
name: diagram
description: Draw a module's diagrams (a flowchart of its screens in business words, sequence diagrams for the PRD requirements that call an API, an ER diagram of its tables) or, with "system", the system block diagram and the key journeys. Scripts draw from the code facts; only screen names are written by an agent and checked by a script. Run as /tech-plugin:diagram <module|system> [--force].
argument-hint: "<module> | system [--force]"
disable-model-invocation: true
model: haiku
effort: low
allowed-tools: Bash(node:*), Read, Agent
---

# /tech-plugin:diagram

Arguments: `$ARGUMENTS`. Script: `${CLAUDE_PLUGIN_ROOT}/scripts/diagram/diagram.mjs`.

## Rules

- Scripts draw every diagram. You never write or edit a diagram, and you never write screen names yourself: the `tech-plugin:diagram-labeller` agent does.
- Everything is written inside `sdlc-docs/`. Never open secret files.
- Never paste `_facts.json`, `_facts.md` or a whole diagram into the chat.

## What to do

1. **Find the home repo** as `/tech-plugin:document` does (the repo whose `sdlc-docs/` holds `modules.yaml`, or the one named in `sdlc-docs/home.json`). No `modules.yaml`: say "Run /tech-plugin:breakdown first" and stop.
2. **No argument:** list the module ids from `sdlc-docs/modules/README.md` and `system`, and ask which to draw. Stop.
3. **Status.** Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/diagram/diagram.mjs" status <module|system> --home <home> [--force]`.
   - **`next` is `restart` or `breakdown`:** reply with `message` and stop.
   - **`next` is `up-to-date`:** reply with `message` and stop.
4. **System:** run `… diagram.mjs draw system --home <home>` and go to step 6.
5. **Module:** follow `${CLAUDE_PLUGIN_ROOT}/references/diagram/diagram-flow.md`.
6. **End.** List the files written, in one line each. Then say:
   - the flowchart is reviewed with the people layer: `/tech-plugin:validate <module>` puts it on the review checklist;
   - `/tech-plugin:sync` rebuilds the docs portal.
