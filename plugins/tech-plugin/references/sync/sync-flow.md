# sync: choosing and refreshing

## Show the table

One table, from `rows` in the status JSON:

| # | Module | What | State | Why | Refreshing does |
|---|---|---|---|---|---|

- Under the table, repeat each row's `warn` line. A Checked (or Approved) document becomes a Draft again when it is rewritten.
- Then one line: how many items are current (`current`), and how many modules have no documents or diagrams yet (`notStarted`).

Ask: "Which rows should I refresh? (numbers, `all`, or `none`)". Wait for the answer.

## Refresh each chosen row, in table order

- **A document (`spec`, `brd`, `prd`):** run `node "${CLAUDE_PLUGIN_ROOT}/scripts/document/doc.mjs" status <module> --home <home>`. Then follow `${CLAUDE_PLUGIN_ROOT}/references/document/document-flow.md` for that document, with the writer named in `writer`. Do the spec before the BRD, and the BRD before the PRD. At the end, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/document/signoff.mjs" sync <module> --home <home>`.
- **A module's diagrams:** follow `${CLAUDE_PLUGIN_ROOT}/references/diagram/diagram-flow.md` for that module. Redraw after its documents, because the screen names and the sequence diagrams come from them.
- **The system diagrams:** run `node "${CLAUDE_PLUGIN_ROOT}/scripts/diagram/diagram.mjs" draw system --home <home>`.
- **Business documents:** run `node "${CLAUDE_PLUGIN_ROOT}/scripts/sync/sync.mjs" sources --home <home>`.
  - Report how many files were copied (`copied`) and picked up (`pickedUp`).
  - If `toConvert` is not empty, show its commands in one code block, for the user to run in their own terminal. They need `uv` (no install: `uvx` fetches markitdown for the run). After that, `/tech-plugin:sync` picks the converted files up.
  - If `missing` is not empty, say which folders listed in `system.yaml` were not found.

A refresh that fails: stop that row, say which step failed in one line, and go on with the next row.
