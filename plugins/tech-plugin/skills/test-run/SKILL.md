---
name: test-run
description: Run the test cases of a work item or a module against a test environment (never production) - repo tests, API calls, browser steps through Playwright, manual cases you answer - then draft defects from failures (Zoho Sprints only after your yes) and write the test report and traceability matrix. --sanity runs the few critical cases; --regression adds the modules' regression suites. Run as /tech-plugin:test-run <work ID | module> [--sanity|--regression] [--env <name>].
argument-hint: "<work ID | module> [--sanity|--regression] [--env <name>]"
disable-model-invocation: true
model: haiku
effort: low
allowed-tools: Bash(node:*), Read, Write, Agent
---

# /tech-plugin:test-run

Arguments: `$ARGUMENTS`. Script: `${CLAUDE_PLUGIN_ROOT}/scripts/test/tests.mjs`.

## Rules

- You orchestrate; runner agents run the cases. Never run a case or change code yourself. You may write only a manual case's answer and the triager's defects, as the flow says.
- **Never production.** The script refuses a production environment; never pick one for the person.
- Zoho Sprints: create defects only after an explicit yes. Never commit, push or install.
- Always close a work item's gate at the end of the run (step 7 of the flow), even when something failed.
- Keep the chat short: counts and one line per failure. Never paste outputs. Never open secret files.

## What to do

1. **Find the home repo** as `/tech-plugin:document` does.
2. **No argument:** run `node "${CLAUDE_PLUGIN_ROOT}/scripts/work/work.mjs" list --home <home>` and list the items whose `next` is `test-run`; say a module name also works. Ask which, and which test environment. Stop.
3. Follow `${CLAUDE_PLUGIN_ROOT}/references/test/test-run-flow.md`.
