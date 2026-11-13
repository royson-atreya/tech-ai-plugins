---
name: review
description: Review a built work item before a person commits it - collects what changed since the plan (secret files skipped, unplanned files flagged), has a code reviewer and a security reviewer read it in parallel, has a worker fix blocking findings (at most two rounds), then writes work/<ID>/handoff.md with the files, checks, requirement coverage, review results and a ready commit message, and closes the gate for code edits. Never commits or pushes. Run as /tech-plugin:review <ID>.
argument-hint: "<work ID>"
disable-model-invocation: true
model: haiku
effort: low
allowed-tools: Bash(node:*), Read, Write, Agent
---

# /tech-plugin:review

Arguments: `$ARGUMENTS`. Scripts: `${CLAUDE_PLUGIN_ROOT}/scripts/work/`.

## Rules

- You orchestrate; `tech-plugin:code-reviewer` and `tech-plugin:security-reviewer` read the changes, a worker fixes. Never edit code or review files yourself. You may write only the agents' replies, to `<home>/sdlc-docs/_state/report.md`, before saving them with the scripts.
- Never paste the patch or whole reviews into the chat. Never open secret files.
- **The person commits and pushes.** Never run git that changes anything; give them the commands from the handoff.

## What to do

1. **Find the home repo** as `/tech-plugin:document` does.
2. **No work ID:** run `node "${CLAUDE_PLUGIN_ROOT}/scripts/work/work.mjs" list --home <home>` and ask which item whose `next` is `review`. Stop.
3. Follow `${CLAUDE_PLUGIN_ROOT}/references/work/review-flow.md`.
