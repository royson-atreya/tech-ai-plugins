---
name: document
description: Write a module's plain-language functional spec, BRD and PRD (in that order) from the code facts, each with an "In short" box, a people layer for non-technical readers and an evidence appendix where every statement cites the code. Run as /tech-plugin:document <module> [spec|brd|prd] [--force].
argument-hint: "<module> [spec|brd|prd] [--force]"
disable-model-invocation: true
model: haiku
effort: low
allowed-tools: Bash(node:*), Read, Agent
---

# /tech-plugin:document

Arguments: `$ARGUMENTS`. Scripts: `${CLAUDE_PLUGIN_ROOT}/scripts/document/`.

## Rules

- You orchestrate; agents write. Never write or edit a document yourself.
- Documents are written only inside `sdlc-docs/modules/<module>/`. Never open secret files.
- Never paste `_facts.json`, `_facts.md` or a whole document into the chat. Use the scripts' and agents' short replies.
- Only a person approves a document, through `/tech-plugin:validate`. Never set Reviewed or Approved.

## What to do

1. **Find the home repo.** It is the repo whose `sdlc-docs/` holds `modules.yaml`: the current repo, or the one named in `sdlc-docs/home.json`. If there is no `modules.yaml`, say "Run /tech-plugin:breakdown first: document needs an approved module list" and stop.
2. **No module given:** list the suggested order from `sdlc-docs/modules/README.md` (the "Suggested order" lines only) and ask which module to document. Stop.
3. **Status.**

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/document/doc.mjs" status <module> --home <home> [--force]
   ```

   It rebuilds the fact pack and returns, per document (`spec`, `brd`, `prd`), the `state` (missing, up-to-date, facts-changed, input-changed), the `next` document, and the `writer` agent.
   - **`next` is `restart`:** reply with `message` and stop. A newer tech-plugin is installed than this session runs.
   - **`breakdown.upToDate` is false:** the code facts are older than the code or the plugin. Say "Run /tech-plugin:breakdown first (`breakdown.message`)" and stop.
   - **`next` is `up-to-date` and no `--force`:** reply with `message` and stop.
   - **`facts-changed`:** say in one line what changed (`facts.changes`), then rebuild that document.
   - **`input-changed`:** the spec or BRD changed after this document was written. Ask: "Update the BRD/PRD from the new spec? (yes/no)". Rebuild only after a yes.
4. **Write.** Follow `${CLAUDE_PLUGIN_ROOT}/references/document/document-flow.md` for each document to write. With a `spec`, `brd` or `prd` argument, write only that one; the script refuses if its inputs are missing.
5. **End.** Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/document/signoff.mjs" sync <module> --home <home>`. List the files written, with each one's last check line and its open-question count. Say what comes next: `/tech-plugin:validate <module>`.
