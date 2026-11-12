# validate: one document

`S` = `${CLAUDE_PLUGIN_ROOT}/scripts/document`. `R` = `<home>/sdlc-docs/_state/report.md`.

From the `doc.mjs status` JSON you need:
- `writer`: the writer agent;
- `checker`: the checker agent;
- `checkerPasses`: 2 for a critical module, 1 otherwise.

From `node "S/signoff.mjs" status <module> --home <home>`, per document you need:
- `round`: the doc-checker passes since the document was written (`passes`, `full`, `limit`);
- `lastCheck`: the last pass, and whether it is on the `current` text;
- `known`: leftovers recorded as known issues;
- `settled`: the last pass is on the current text, enough passes were run, and it is clean or its leftovers are recorded.

## Order: spec, then BRD, then PRD

Finish the spec before the BRD, and the BRD before the PRD. A later document is checked only once the documents it is written from are settled. `save-check` refuses otherwise.

## 0. Refresh after an input changed (`input-changed`)

The spec or BRD changed after this document was written, for example because validate fixed it.

1. Run `node "S/doc.mjs" changes <module> <doc> --home <home>`. It writes `_state/docs/<module>/<doc>.changes.md`, with the input's changed lines and the IDs they mention.
2. Start the `writer` with the changes file. Tell it: "Update only the lines of <doc> that depend on these changes (the same rule, `spec E#`, `[spec Q#]`, a BR). Change nothing else. If nothing depends on them, change nothing."
3. Run `node "S/doc.mjs" restamp <module> <doc> --home <home>`.
4. Run step 1. If the writer changed nothing, the earlier checks still count. Otherwise the next pass is focused (step 3).

## 1. Script checks

```
node "S/check-doc.mjs" <doc file> --home <home>
node "S/plain.mjs" <doc file> --home <home>
```

If either fails, start the `writer` with the failing lines and ask it to fix only those. Run both again. If one still fails, stop and show the lines.

## 2. Readability (once per round)

Skip this when `signoff.mjs status` shows `readability: true`: the review is already done for this round.

1. Start `tech-plugin:readability-reviewer` with the document path and `<home>/sdlc-docs/glossary.md`.
2. Write its reply, unchanged, to `R`, then save it:

   ```
   node "S/signoff.mjs" save-review <module> <doc> --input "R" --home <home>
   ```

3. If the count is above 0, start the `writer` in fix mode with the saved review (`modules/<module>/checks/<doc>-readability.md`). Then run step 1 again.

## 3. Doc-checker

At most 3 passes per round. A round starts when `/tech-plugin:document` writes the document.

1. **Pick the mode.**
   - **Full:** the first pass of a round. A critical module also uses full for its second pass when the first was clean.
   - **Focused:** every other pass. Before it, run `node "S/doc.mjs" changes <module> <doc> --home <home>`.
2. **Start the `checker`** in a fresh context. Give it:
   - the document path;
   - the home path;
   - the fact pack, `modules/<module>/_facts.md`;
   - the repo folders from the status `repos`;
   - for a focused pass, also: "Focused pass", the previous report (`modules/<module>/checks/<doc>-check-<n>.md`) and the changes file.
3. **Save the report.** Write the reply, unchanged, to `R`, then run:

   ```
   node "S/signoff.mjs" save-check <module> <doc> --input "R" --home <home> --checker <checker> --mode full|focused
   ```

   It says how many passes are left this round.
4. **Not clean** (mismatch, not provable or risk above 0) **and a pass is left:**
   1. Start the `writer` in fix mode with the saved report.
   2. Run step 1.
   3. Run a focused pass.
5. **Clean:** the document is settled once it has `checkerPasses` passes this round.
6. **No pass left and not clean:** run `node "S/signoff.mjs" known <module> <doc> --home <home>`. Say in one line per item what is left, and that the developer accepts these at sign-off. Do not ask the user for more passes.

   A risk item (a key or personal data) is never accepted. Have the writer remove it. If it is still there, stop and show the line.

## 4. A later check finds a problem in an earlier document

For example, a BRD check shows the spec says something the code does not do.

1. Finish the current document's fix.
2. Start the `writer` for the earlier document with only those lines to fix.
3. Run step 1 on the earlier document, then one focused pass on it. A settled document gets one focused pass for each later change, even past the limit.
4. Run step 0 for each document written from it.

## 5. Decisions (critical modules, before Approved)

For each open question, ask the person in the question's role, one message with all the questions. Record each answer:

```
node "S/signoff.mjs" decide <module> --doc <doc> --q Q3 --answer "<their words>" --by "<name>" --role <role> --home <home>
```

Answers do not make a document out of date. They are cited as `decision D<n>` the next time the document is written.

## 6. Sign-off (only after an explicit yes in chat)

```
node "S/signoff.mjs" approve <module> <doc> --layer people --by "<name>" --role PO --home <home>
node "S/signoff.mjs" approve <module> <doc> --layer technical --by "<name>" --role developer --home <home>
```

The script refuses when a check is missing, older than the text, or not clean with no known issues recorded. Show its message as it is.

- The people layer comes first; the status becomes Reviewed.
- Before the developer says yes, show them `checks/<doc>-known.md` if it exists. Approving the technical layer accepts those items until the next rewrite.
- With both layers approved, the status becomes Approved. A critical module also needs a decision on every open question first.
