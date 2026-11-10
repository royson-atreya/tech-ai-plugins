# validate: one document

`S` = `${CLAUDE_PLUGIN_ROOT}/scripts/document`. `R` = `<home>/sdlc-docs/_state/report.md`.

The status JSON names three things you need:
- `writer`: the writer agent;
- `checker`: the checker agent;
- `checkerPasses`: 2 for a critical module, 1 otherwise.

## 1. Script checks

```
node "S/check-doc.mjs" <doc file> --home <home>
node "S/plain.mjs" <doc file> --home <home>
```

If either fails, start the `writer` with the failing lines and ask it to fix only those. Run both again. If one still fails, stop and show the lines.

## 2. Readability

1. Start `tech-plugin:readability-reviewer` with the document path and `<home>/sdlc-docs/glossary.md`.
2. Write its reply, unchanged, to `R`, then save it:

   ```
   node "S/signoff.mjs" save-review <module> <doc> --input "R" --home <home>
   ```

3. If the count is above 0, start the `writer` with the saved review (`modules/<module>/checks/<doc>-readability.md`) and ask it to fix those items. Then run step 1 again.

## 3. Doc-checker (last, so it checks the final text)

1. Start the `checker` agent in a fresh context. Give it:
   - the document path;
   - the home path;
   - the fact pack `modules/<module>/_facts.md`;
   - the repo folders from the status `repos`.
2. Write its reply, unchanged, to `R`, then save it:

   ```
   node "S/signoff.mjs" save-check <module> <doc> --input "R" --home <home> --checker <checker>
   ```

3. **If the pass is not clean** (mismatch, not provable or risk above 0):
   1. Start the `writer` with the saved report and ask it to fix every item. It either corrects the statement or moves it to Open questions.
   2. Run step 1 again.
   3. Run the checker again.
4. **Critical module:** always run a second checker pass, even if the first was clean.
5. **Still not clean after 3 checker passes:** stop and show the remaining items to the user.

## 4. Decisions (critical modules, before Approved)

For each open question, ask the person in the question's role, one message with all the questions. Record each answer:

```
node "S/signoff.mjs" decide <module> --doc <doc> --q Q3 --answer "<their words>" --by "<name>" --role <role> --home <home>
```

Decisions are cited as `decision D<n>` the next time the document is written.

## 5. Sign-off (only after an explicit yes in chat)

```
node "S/signoff.mjs" approve <module> <doc> --layer people --by "<name>" --role PO --home <home>
node "S/signoff.mjs" approve <module> <doc> --layer technical --by "<name>" --role developer --home <home>
```

The script refuses when a check is missing, failing, or older than the text. Show its message as it is.

- The people layer comes first; the status becomes Reviewed.
- With both layers approved, the status becomes Approved. A critical module also needs a decision on every open question first.
