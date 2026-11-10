---
name: breakdown
description: Break a system (this repo, every repo in this workspace, or the paths/URLs given) into business modules. Finds the repos, detects each app's stack (profile.md to confirm), reads the code (routes, screens, API calls, tables, code graph), links screens to APIs across apps, proposes modules for your approval (modules.yaml), and writes the module catalogue, scope cards and module map.
argument-hint: "[paths | git URLs] [--docs <folder>] [--only 1-6] [--refresh]"
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
- Never paste `stack.json`, `facts.json`, `links.json` or other `_map/` data into the chat. Use the scripts' summary lines and the short `.md` files they write.
- Two approvals are the user's and never yours: the profile (stage 2) and the module list (stage 5). Wait for an explicit yes.
- Keep your messages short: one question block per stage, one table per approval.

## What to do

1. **Pick the stage.**
   - **`--only N`:** run stage N.
   - **Otherwise:** use `next` from the status above, then carry on stage after stage.
   - **`next` is `up-to-date` and there is no `--refresh`:** reply with the status `message`, point to `sdlc-docs/modules/README.md`, and stop.
   - **`--refresh`:** re-run stage 2 for repos whose `changed` is true, and stage 3 for repos whose `codeChanged` is true, then the later stages.
2. **Follow the guide for the stage.** Each guide is in `${CLAUDE_PLUGIN_ROOT}/references/breakdown/`, and you read only the one you need:
   - stage 1, find the repos: `stage-1-find.md`
   - stage 2, learn each repo: `stage-2-learn.md`
   - stage 3, read the code: `stage-3-read.md`
   - stage 4, link the apps: `stage-4-link.md`
   - stage 5, propose modules: `stage-5-modules.md`
   - stage 6, write the breakdown: `stage-6-write.md`
3. **When to stop between stages:**
   - after stage 2, wait for the user to confirm the profile;
   - after stage 5's preview, wait for approval;
   - in an empty repo or folder, stop after stage 2: there is no code to read.
4. **End.** List the files written. Say what comes next: the suggested `/tech-plugin:document <module>` from stage 6, or the approval you are waiting for.
