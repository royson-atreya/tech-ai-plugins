# Writing rules for work-item documents

These add to `references/document/writing-rules.md`, which still applies: the people layer in plain words, sentences under 25 words, no code names, paths or HTTP codes above Appendix A, glossary terms, and the evidence classes Verified, Inferred, Assumption and Unknown.

## All three documents

- **Copy the stamp** from the prepare JSON to the very top, unchanged. Never set `status` or `approval`: only `work.mjs approve` does.
- **Keep the template's `## ` headings**, exactly and in order. A section with nothing in it says "None.".
- **Sources in Appendix A** may be: a code citation `` `repo:path:line` ``; `request.md`; `decision D2` (an answer recorded for this work item); `impact E3` or `requirement E1` (a row of an earlier document); a module requirement such as `PATIENTS-R02`; `glossary.md`, `modules.yaml` or `system.yaml`.
- **Open questions** are written `- **Q1** (for PO): …?`, each for a role: owner, PO, BA, developer, tech lead, QA or designer. Ask only what the code, the module documents and the decisions cannot answer.
- **No personal data, ever.** Write roles ("a doctor", "the patient"), never a real name, phone number, email or ID, even from the request. The checks fail a document that holds one.
- **IDs are never renumbered or reused.** Keep every ID in `keepIds`. A dropped one stays, titled `Removed (reason)`.
- **Read only what you need:** the pack or the prepare JSON's inputs, the module documents' "In short" box and the sections you use. At most 15 code files, one at a time. Never open secret files.

## impact.md

- Section 1 to 4: every statement about the product as it is today carries `[E#]` (or `[Q#]` when it is not known).
- **Section 2** has one row per part of the product: `changed` when the work is done there, `affected` when that part only feels it (it calls what changes, uses the same tables, or its documents describe it).
- **Risk:** Critical when it changes how money, security or health findings work; High when it touches a critical module or what other apps call; Medium when it touches several modules or shared tables; Low otherwise. Name each reason.
- **Size:** S (hours to a day), M (a few days), L (one to two weeks), XL (more; say how to split it). Base it on the screens, behind-the-scenes steps and stored data that change, and the number of apps. In the part everyone reads, say "behind-the-scenes step" and "stored data", not server, API or table.
- **Level:** Quick (bug fix or small change: no design), Standard (a feature) or Full (a new module or product). A person may change it.
- **Appendix B** lists, with citations: what changes, the other apps that call it, documents that would go back to Draft, and code the graph groups with it (Inferred).

## requirement.md

- **One requirement per behaviour,** testable, in plain words: what the product does, not how it is built (no tables, server actions or screens' code).
- **`**Changes:**`** says `new`, or names the module requirement it changes (`PATIENTS-R02`) when that module has a PRD.
- **Acceptance criteria** are `- Given …, when …, then ….` lines a tester can follow.
- **`**Source:**`** tags where the requirement comes from: the request (`request.md`), a decision, the impact.
- **Section 2** lists each gap in the request with the question that settles it (`[Q1]`).
- **Stories** (`<ID>-S01`): "As a <role>, I want <something>, so that <a reason>.", a `**Covers:**` line naming the requirements, and acceptance criteria. Every requirement is covered by at least one story. Keep stories small enough for one person to build in a few days.

## design.md

- **Section 1 and 2 are for the owner and PO:** what people will see and which parts of the product change, in plain words. A Mermaid flowchart may show new screens or steps; its labels are business words in quotes (`a["Download the report"]`).
- **Decisions** (Appendix B, `<ID>-D01`): the context, at least two real options with their trade-offs, the decision and its consequences. Record a decision wherever a developer could reasonably have chosen otherwise.
- **API changes** (Appendix C): method and path, who calls it, request fields, the answer and errors; cite the existing route it changes.
- **Data changes** (Appendix D): tables and columns, the migration, data to move, and personal data it stores. An `erDiagram` of only what changes.
- **Coverage** (Appendix E): one row per requirement, saying where the design covers it.
