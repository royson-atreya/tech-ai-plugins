---
name: document
description: Document a module in one go. Writes its plain-language functional spec, BRD and PRD (in that order) from the code facts, each with an "In short" box, a people layer for non-technical readers and an evidence appendix where every statement cites the code; then checks them (what /tech-plugin:validate does) and draws the module's diagrams (Mermaid and draw.io). Ends with each document Checked or Draft; nobody signs off. Run as /tech-plugin:document <module> [spec|brd|prd] [--write-only] [--force].
argument-hint: "<module> [spec|brd|prd] [--write-only] [--force]"
disable-model-invocation: true
model: haiku
effort: low
allowed-tools: Bash(node:*), Read, Write, Agent
---

# /tech-plugin:document

Arguments: `$ARGUMENTS`. Scripts: `${CLAUDE_PLUGIN_ROOT}/scripts/document/`.

## Rules

- You orchestrate; agents write. Never write or edit a document or a diagram yourself. You may write only the agents' reports, to `<home>/sdlc-docs/_state/report.md`, before saving them with the scripts.
- Documents are written only inside `sdlc-docs/modules/<module>/`. Never open secret files.
- Never paste `_facts.json`, `_facts.md`, a whole document or a report into the chat. Use the scripts' and agents' short replies.
- **No sign-off.** The scripts set each document's status: Checked once its checks pass, Draft otherwise. Never set a status, never ask anyone to approve a document, and never ask who the user is.

## What to do

The run has three parts: **write**, **check**, **draw**. With `--write-only`, do only the first. With `spec`, `brd` or `prd`, write and check only that document, and do not draw.

1. **Find the home repo.** It is the repo whose `sdlc-docs/` holds `modules.yaml`: the current repo, or the one named in `sdlc-docs/home.json`. If there is no `modules.yaml`, say "Run /tech-plugin:breakdown first: document needs an approved module list" and stop.
2. **No module given:** list the suggested order from `sdlc-docs/modules/README.md` (the "Suggested order" lines only) and ask which module to document. Stop. (Or suggest `/tech-plugin:next`, which picks it.)
3. **Status.**

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/document/doc.mjs" status <module> --home <home> [--force]
   ```

   It rebuilds the fact pack and returns, per document (`spec`, `brd`, `prd`), the `state` (missing, up-to-date, facts-changed, input-changed), the `next` document, and the `writer` agent.
   - **`next` is `restart`:** reply with `message` and stop. A newer tech-plugin is installed than this session runs.
   - **`breakdown.upToDate` is false:** the code facts are older than the code or the plugin. Say "Run /tech-plugin:breakdown first (`breakdown.message`)" and stop.
   - **`next` is `up-to-date` and no `--force`:** say in one line that the documents match the code, and go straight to step 5 (check).
   - **`facts-changed`:** say in one line what changed (`facts.changes`), then rebuild that document.
   - **`input-changed`:** the spec or BRD changed after this document was written. Ask: "Update the BRD/PRD from the new spec? (yes/no)". Rebuild only after a yes.
4. **Write.** Follow `${CLAUDE_PLUGIN_ROOT}/references/document/document-flow.md` for each document to write. With a `spec`, `brd` or `prd` argument, write only that one; the script refuses if its inputs are missing.
5. **Check** (not with `--write-only`). Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/document/signoff.mjs" status <module> --home <home>`. Then, in the order spec, BRD, PRD (or only the one given), follow `${CLAUDE_PLUGIN_ROOT}/references/document/validate-flow.md`. Skip a document that is already Checked.
   - **At most 3 code-check passes per round.** When none is left, record the leftovers as known issues. Never ask the user for more passes.
   - Open questions stay in the documents. Do not ask the user to answer them; if they give an answer anyway, record it as step 5 of that flow says.
6. **Draw** (not with `--write-only`, and not when one document was given). Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/diagram/diagram.mjs" status <module> --home <home>`.
   - **`next` is `up-to-date`:** skip drawing.
   - **`next` is `restart` or `breakdown`:** say `message` and skip drawing.
   - Otherwise follow `${CLAUDE_PLUGIN_ROOT}/references/diagram/diagram-flow.md`.
7. **End.** Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/document/signoff.mjs" checklist <module> --home <home>`. Show:
   - a table: document, status (Checked or Draft), open questions, known issues;
   - the diagram files written, `.drawio` copies included, in one line;
   - for a document still a Draft, one line on why;
   - what comes next: `/tech-plugin:next`.

   With `--write-only`, list the files written and say: "Check them with /tech-plugin:validate <module>."
