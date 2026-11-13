---
name: validate
description: Validate a module's spec, BRD and PRD. Runs the mechanical and plain-language checks, an independent doc-checker that re-reads every cited line (twice for critical modules) and a readability reviewer, and has the writer fix what they find. A document that passes becomes Checked; nobody signs off. Run as /tech-plugin:validate <module> [spec|brd|prd].
argument-hint: "<module> [spec|brd|prd]"
disable-model-invocation: true
model: haiku
effort: low
allowed-tools: Bash(node:*), Read, Write, Agent
---

# /tech-plugin:validate

Arguments: `$ARGUMENTS`. Scripts: `${CLAUDE_PLUGIN_ROOT}/scripts/document/`.

## Rules

- **No sign-off.** The scripts set each document's status: Checked once its checks pass, Draft otherwise. Never ask anyone to approve a document, and never ask who the user is or their role.
- **Agents do the reading.** You never edit a document yourself; the writer agent fixes it. You may write only the agents' reports, to `<home>/sdlc-docs/_state/report.md`, before saving them with the scripts.
- **Keep the chat short.** Never paste whole documents or reports. Never open secret files.

## What to do

1. **Status.** Find the home repo as `/tech-plugin:document` does, then run:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/document/doc.mjs" status <module> --home <home>
   ```

   - **`next` is `restart`:** reply with `message` and stop. A newer tech-plugin is installed than this session runs.
   - **A document is `missing`:** say "Write it first: /tech-plugin:document <module>" and stop.
   - **A document is `facts-changed`:** the code changed. Say "Rewrite it first: /tech-plugin:document <module>" and stop.
   - **A document is `input-changed`:** refresh it (step 0 of the flow), do not rewrite it.

   Then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/document/signoff.mjs" status <module> --home <home>` for each document's status, round, last check and known issues.
2. **Check each document** in the order spec, BRD, PRD (or the one given) by following `${CLAUDE_PLUGIN_ROOT}/references/document/validate-flow.md`. Skip a document that is already Checked.
   - **At most 3 code-check passes per round.** When none is left, record the leftovers as known issues. Never ask the user for more passes.
3. **End.** Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/document/signoff.mjs" checklist <module> --home <home>`. Its last line gives each document's status. Show a short table: document, status (Checked or Draft), open questions, known issues. Give the path of `sdlc-docs/modules/<module>/checks/review-checklist.md`. If a document is still a Draft, say in one line why (from the flow).

   Open questions stay in the documents. Do not ask the user to answer them. If the user gives an answer anyway, record it as step 5 of the flow describes.
