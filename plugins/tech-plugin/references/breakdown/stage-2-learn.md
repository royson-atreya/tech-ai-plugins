# breakdown stage 2: learn each repo

Goal: the stack, entry points and commands of every app, written to `sdlc-docs/profile.md`, which the user confirms.

`<home>` is the home repo from the status (or from stage 1). The repos are the ones in the status `repos` list.

## 1. Detect

For each repo (with `--refresh`, only the changed ones), run:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/breakdown/detect.mjs" "<repo path>" --write
```

Each run prints one summary line and writes `<repo>/sdlc-docs/_map/<repo>/stack.json`. Show the summary lines as they are. If a repo has no `sdlc-docs/` yet, go back to stage 1, step 4.

## 2. Architecture notes (one agent per app)

For every app that is not empty and not `kind: workspace`, start the `tech-plugin:stack-detector` agent. Run them in parallel when there are several. Give each one:
- the repo path
- the app folder (`root`)
- the path of its `stack.json`
- the app `id`

Write each agent's answer, unchanged, to `<repo>/sdlc-docs/_map/<repo>/architecture-<slug>.md`. Here `<slug>` is `root` for the app at the repo root; otherwise it is the app folder with `/` replaced by `-`.

Skip this step for apps whose notes file already exists and whose repo did not change.

## 3. Draft the profile

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/breakdown/write.mjs" profile --home "<home>"
```

This writes `profile.md` as a Draft and prints a short table. Show the table to the user and ask: "Is this right? Confirm, or tell me what to correct."

Also say:
- Commands are **found, not run**. The guard does not run programs in a repo before a work item is approved. The user can run a command themselves and tell you it works.
- If the table ends with secret files committed to git, repeat that line.

## 4. Corrections

If the user corrects something, add it to `<home>/sdlc-docs/_state/profile-corrections.json`, a JSON list of `{ "app": "<app id or repo name>", "text": "<the correction in the user's words>" }`. Create the file if needed and keep the earlier entries. Then run the `profile` step again and show the new table. Corrections are shown in the profile and override the detected facts. Never edit `stack.json` by hand.

## 5. Confirm

When the user confirms, run:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/breakdown/write.mjs" confirm --home "<home>"
```

It records "Confirmed in chat by <git user name> on <date>" and marks stage 2 done. Only do this after an explicit yes from the user.

Then go straight on to stage 3, unless every repo is empty.

A manifest change (a new framework or a version bump) sends a repo back to stage 2, and the profile needs confirming again. A plain code change does not: it only re-runs stage 3 for that repo.
