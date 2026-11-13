---
name: validate
description: Validate a module's spec, BRD and PRD. Runs the mechanical and plain-language checks, an independent doc-checker that re-reads every cited line (twice for critical modules) and a readability reviewer, has the writer fix what they find, then records who approved each layer (owner/PO for the people layer, developer for the technical layer). Run as /tech-plugin:validate <module> [spec|brd|prd].
argument-hint: "<module> [spec|brd|prd]"
disable-model-invocation: true
model: haiku
effort: low
allowed-tools: Bash(node:*), Read, Write, Agent
---

# /tech-plugin:validate

Arguments: `$ARGUMENTS`. Scripts: `${CLAUDE_PLUGIN_ROOT}/scripts/document/`.

## Rules

- **A person approves; you never approve for them.** Record a sign-off or a decision only after an explicit yes or answer from the user in this chat, naming who they are and their role.
- **Who approves what:** the people layer is approved by the owner, PO or BA, and the technical layer by a developer. If the user is neither, ask who will review, and stop.
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

   Then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/document/signoff.mjs" status <module> --home <home>` for each document's round, last check and known issues.
2. **Check each document** in the order spec, BRD, PRD (or the one given) by following `${CLAUDE_PLUGIN_ROOT}/references/document/validate-flow.md`. Skip a document that is already settled and unchanged.
   - **At most 3 code-check passes per round.** When none is left, record the leftovers as known issues. Never ask the user for more passes.
3. **Ask for sign-off.** Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/document/signoff.mjs" checklist <module> --home <home>`. Then show the user:
   - each document's "In short" box (read the first lines of the file);
   - its open questions with their roles;
   - its known issues, one line each, if any;
   - the path of `sdlc-docs/modules/<module>/checks/review-checklist.md`, which also links the business flowchart when it is drawn.

   Ask the owner or PO to read the people layer, and a developer to check the appendices. Record each yes as the flow describes.
4. **End.** Give each document's status: Draft, Reviewed or Approved. List who is still to approve or decide.
