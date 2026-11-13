# document: writing one document

For each document to write, in the order spec → brd → prd:

1. **Prepare.**

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/document/doc.mjs" prepare <module> <doc> --home <home>
   ```

   It prints JSON for the writer. It also saves the previous version, so that IDs and wording can be kept.
2. **Start the writer agent** named in the status (`writer`):
   - `tech-plugin:doc-writer` for a standard module;
   - `tech-plugin:doc-writer-deep` for a critical one (money, security or clinical).

   Give it:
   - the prepare JSON, unchanged;
   - the glossary tool's path, `${CLAUDE_PLUGIN_ROOT}/scripts/document/glossary.mjs`, written out as the real path;
   - one line: "Write <doc> for <module> following the rules file; run the two checks until both pass."
3. **Check the reply.** Run the two commands in the JSON's `checks` yourself:
   - **Both pass:** go on to the next document.
   - **One fails:** start the same agent once more, with the failing lines, and ask it to fix only those.
   - **Still failing:** stop and show the failing lines to the user.
4. **After the last document,** say in one line per document: its requirement or rule count, open questions and check results. Then go on with the checks (step 5 of `/tech-plugin:document`).

## Sizes

- **Over 40 routes or 40 screens:** tell the user before starting that the documents will be long. Offer to write only the spec first.
- **Writer replies past its limits:** if a writer says it ran out of room, run `prepare` again and ask for the document in two passes. Ask for the people layer first, then the appendices, writing the same file.
