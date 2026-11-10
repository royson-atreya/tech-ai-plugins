# Writing rules for module documents

These rules apply to every spec, BRD and PRD. `check-doc.mjs` and `plain.mjs` check the mechanical ones; the doc-checker and the readability reviewer check the rest.

## Who reads what

Each document has two layers.

- **The people layer** runs from the title to `## Appendix A`. It is for an owner, product owner, QA tester, new joiner or client who never opens the code. Write it so they understand it on a first reading.
- **The evidence and technical layer** runs from `## Appendix A` to the end. It is for developers, QA and later commands, and it must be precise and complete.

## Never invent: cite or ask

- **Every fact in the people layer ends with a tag:** `[E4]` for evidence, or `[Q2]` for an open question.
  - Each `E` tag has one row in Appendix A: `| E4 | short restatement | source | class |`.
  - Each `Q` tag has one entry in Open questions.
- **Sources:**
  - code, written `repo:path:line`, copied from the fact pack;
  - `glossary.md`;
  - `system.yaml` (the business answers);
  - `modules.yaml` (the approved purpose and risk);
  - `decision D<n>` (a decision recorded by `/tech-plugin:validate`);
  - an ID in an earlier document (`spec E3`, `BR-02`).
- **Classes:**
  - **Verified:** the cited line shows it.
  - **Inferred:** it follows from what is cited, so say how in the statement.
  - **Assumption:** the source must be a `Q` tag.
  - **Unknown:** the source must be a `Q` tag.
- **Anything you cannot cite becomes an open question.** It goes under Open questions, phrased as a question for a role. The roles are owner, PO, BA, developer, QA, designer, or a role named in `system.yaml`. Business objectives and success measures are almost never in code, so ask the owner.
- **Describe behaviour, not intent.** "The page shows 'Mobile number is required' when the number is empty" is provable. "This keeps data clean" is not.
- **Routes listed under "Routes no app in the breakdown calls"** are stated as such and asked about. Never describe them as live features.
- **Calls to the backend outside this breakdown:** describe them in plain words, for example "the page asks the system for the patient's visits". List the endpoint in Appendix B. They are not bugs.

## People-layer writing

- **Plain words.** Sentences under 25 words. One idea per sentence.
- **No code in the people layer.** That means:
  - no class, function, file or table names;
  - no paths, URLs or HTTP methods or codes;
  - no SQL;
  - no backticks.

  Name screens by what they show ("the patient list"), not by their file name.
- **Use the product's own words.** Take the words from the screen labels in the fact pack ("Shows: …"), and quote messages exactly as people see them.
- **Domain terms.** Every domain term you use (Prakruti, Nadi, Rutucharya…) must be in `glossary.md`. If it isn't, add it with:

  ```
  node "<scripts>/document/glossary.mjs" add --home <home> --term <term> --meaning "To be confirmed" --source "<repo:path:line where seen>"
  ```

  Never guess a meaning as fact. A meaning shown in the product itself, such as a label or help text, may be cited.
- **Examples.** Use real-sounding examples ("a doctor books a 30-minute slot"). Never use a real person's name, number or email.
- **In short.** Keep its four lines. **Open questions: N** must equal the number of questions in the Open questions section.

## IDs

- **BRD:** business requirements `BR-01`, `BR-02`, … in the section 7 table.
- **PRD:** functional requirements `### <MODULE>-R01: Title`, where `<MODULE>` is the module id in capitals (`nadi-assessment` becomes `NADI-ASSESSMENT-R01`).
  - Each one has `**Acceptance criteria**` (Given / when / then) and an `**Evidence:**` line with tags.
  - Each one links its `**Business requirement:** BR-nn` where there is one.
- **IDs are never reused or renumbered.** When a document is rewritten, keep every ID in `keepIds` with its meaning. Add new ones after the highest number. Mark a dropped one `### X-R07: Removed (reason)`.

## Secrets and personal data

- **Never copy a key, token, password, email address, phone number or ID number** into a document, even from code. Write "[REDACTED]" and give the line in the source column.
- **The fact pack is already redacted.** Do not undo it by opening the file to get the value.
- **Never open secret files:** `.env`, keys and keystores, or anything the guard blocks.

## How much to read

- Write from the fact pack. Read at most 15 source files, and only where the fact pack is not enough, for example to see the order of steps on a page.
- Read one file or a narrow folder at a time. Never read `facts.json` or `links.json` whole.
- Open the documents this one is written from (`inputs`) and stay consistent with them. Reuse their wording for the same rule, and link `spec E3` or `BR-02` instead of re-proving.
