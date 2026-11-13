---
name: requirement
description: Turn a work item's request into clear, testable requirements with acceptance criteria and user stories, asking the owner or PO about every gap, in work/<ID>/requirement.md; the owner, PO or BA approves it. Better after /tech-plugin:impact. Run as /tech-plugin:requirement <ID> [--force].
argument-hint: "<work ID> [--force]"
disable-model-invocation: true
model: haiku
effort: low
allowed-tools: Bash(node:*), Read, Write, Agent
---

# /tech-plugin:requirement

Arguments: `$ARGUMENTS`. Scripts: `${CLAUDE_PLUGIN_ROOT}/scripts/work/`.

## Rules

- You orchestrate; `tech-plugin:requirement-analyst` writes the requirements and `tech-plugin:story-writer` the stories. Never write or edit `requirement.md` yourself.
- Never answer an open question yourself: only the person does, and you record what they say.
- Record an approval only when the person says yes and gives their name and role. Never approve on their behalf.
- Answers go into a file, never into a command line (see `work-items.md`). Never open secret files.

## What to do

1. **Find the home repo** as `/tech-plugin:document` does. No `modules.yaml`: say "Run /tech-plugin:breakdown first" and stop.
2. **No work ID:** run `node "${CLAUDE_PLUGIN_ROOT}/scripts/work/work.mjs" list --home <home>` and ask which item. If there is none, say "Start with /tech-plugin:impact \"<the request>\"" and stop.
3. Follow `${CLAUDE_PLUGIN_ROOT}/references/work/requirement-flow.md`, with `${CLAUDE_PLUGIN_ROOT}/references/work/work-items.md` for answers and approvals.
