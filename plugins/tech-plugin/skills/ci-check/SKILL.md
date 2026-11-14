---
name: ci-check
description: The optional AI security review of a pull request, run headless in GitHub Actions by the workflow /tech-plugin:doctor --ci writes. Collects the PR's changes (secret files left out), has the security reviewer read them, and writes the comment the workflow posts. Read only. Run as /tech-plugin:ci-check <base SHA>.
argument-hint: "<base SHA>"
disable-model-invocation: true
model: haiku
effort: low
allowed-tools: Bash(node:*), Read, Grep, Glob, Write, Agent
---

# /tech-plugin:ci-check

Arguments: `$ARGUMENTS` (the pull request's base commit). Script: `${CLAUDE_PLUGIN_ROOT}/scripts/ci/ci.mjs`. You run in GitHub Actions, in the checked-out repo.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/ci/ci.mjs" pr --home . --base <base SHA> --patch sdlc-docs/_state/ci/changes.patch`. It writes the diff without secret files. (Create `sdlc-docs/_state/ci/` first with the Write tool if the script says it is missing.)
2. Start `tech-plugin:security-reviewer` with the patch, the `modules` from the JSON (with their risk) and "Round 1. There is no plan or requirement: review the change on its own."
3. Write its reply, unchanged, to `sdlc-docs/_state/ci/review.md`, then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/ci/ci.mjs" ai-comment --input sdlc-docs/_state/ci/review.md --home .`. The workflow posts the comment.

Never push, never change code, never post anything yourself.
