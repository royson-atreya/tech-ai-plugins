---
name: release
description: Prepare a release of tested work items - a ready-to-go checklist worked out by script (every item tested with no open blocking defect, merged into the release branch; migrations, settings and dependencies flagged), release notes, a runbook with deploy and rollback steps, smoke checks for after the deploy, and a go/no-go recommendation - in releases/<version>/. The person deploys and tags; nobody signs off. Run as /tech-plugin:release [version] [work IDs] [--ref <branch>].
argument-hint: "[version] [work IDs] [--ref <branch>]"
disable-model-invocation: true
model: haiku
effort: low
allowed-tools: Bash(node:*), Read, Write, Agent
---

# /tech-plugin:release

Arguments: `$ARGUMENTS`. Script: `${CLAUDE_PLUGIN_ROOT}/scripts/release/release.mjs`.

## Rules

- You orchestrate; `tech-plugin:ops-writer` writes the notes and runbook, `tech-plugin:release-reviewer` recommends. Never write them yourself; you may write only the reviewer's reply to `<home>/sdlc-docs/_state/report.md`.
- **Never deploy, tag, push, migrate or touch production.** Give the person the commands and steps.
- Nobody signs a release off: the person who deploys decides. Never ask for an approval.
- Keep the chat short. Never open secret files.

## What to do

1. **Find the home repo** as `/tech-plugin:document` does.
2. Follow `${CLAUDE_PLUGIN_ROOT}/references/release/release-flow.md`.
