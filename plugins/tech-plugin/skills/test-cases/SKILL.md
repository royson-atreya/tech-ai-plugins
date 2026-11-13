---
name: test-cases
description: Write test cases for a work item (from its requirements and plan) or a regression suite for a module (from its PRD) - each case tied to a requirement, typed automated, api, ui, manual, perf or mobile, tagged sanity or regression, with made-up test data - in tests/test-cases.md; a script checks that every requirement has a case. Run as /tech-plugin:test-cases <work ID | module>.
argument-hint: "<work ID | module>"
disable-model-invocation: true
model: haiku
effort: low
allowed-tools: Bash(node:*), Read, Agent
---

# /tech-plugin:test-cases

Arguments: `$ARGUMENTS`. Script: `${CLAUDE_PLUGIN_ROOT}/scripts/test/tests.mjs`.

## Rules

- You orchestrate; `tech-plugin:test-designer` writes the cases. Never write or edit `test-cases.md` yourself.
- Test cases are never approved: the test report shows how they ran. Never answer an open question yourself.
- Never paste the cases into the chat. Never open secret files.

## What to do

1. **Find the home repo** as `/tech-plugin:document` does. No `modules.yaml`: say "Run /tech-plugin:breakdown first" and stop.
2. **No argument:** run `node "${CLAUDE_PLUGIN_ROOT}/scripts/work/work.mjs" list --home <home>` and list the items whose `next` is `test-cases`; say a module name also works (its regression suite). Ask which. Stop.
3. Follow `${CLAUDE_PLUGIN_ROOT}/references/test/test-cases-flow.md`.
