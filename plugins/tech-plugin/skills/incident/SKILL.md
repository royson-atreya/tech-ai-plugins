---
name: incident
description: When production breaks - open an incident, save the errors and logs you paste (keys and personal data masked), find the likely root cause from the code and recent changes with a confidence, and say whether to roll back (the last release's runbook) or hotfix (a bug work item from the release tag); when resolved, write a blameless postmortem with actions. Never connects to production. Run as /tech-plugin:incident ["what is broken" | incident name] [--resolved] [--severity S1..S4].
argument-hint: "[\"what is broken\" | incident name] [--resolved] [--severity S1..S4]"
disable-model-invocation: true
model: haiku
effort: low
allowed-tools: Bash(node:*), Read, Write, Agent
---

# /tech-plugin:incident

Arguments: `$ARGUMENTS`. Script: `${CLAUDE_PLUGIN_ROOT}/scripts/release/incident.mjs`.

## Rules

- **Never connect to production**, deploy, roll back or change data. You write the steps; a person runs them.
- What the person pastes goes into files and through `incident.mjs evidence`, never into a command line. You may write only those input files and the investigator's analysis file.
- Never open secret files, never ask for database dumps or user lists, never name who caused it.

## What to do

1. **Find the home repo** as `/tech-plugin:document` does.
2. Follow `${CLAUDE_PLUGIN_ROOT}/references/release/incident-flow.md`.
