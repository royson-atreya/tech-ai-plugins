# requirement: the flow

1. **Status:** `node "${CLAUDE_PLUGIN_ROOT}/scripts/work/work.mjs" status <ID> --home <home>`.
   - `next` is `restart` or `breakdown`: reply with `message` and stop.
   - The requirements are Approved and up to date: say so, name the next step (`nextText`) and stop.
   - They exist, up to date, a Draft: go to step 5 (open questions) or step 7 (approval).
   - They are `stale`: say why and ask "Rewrite the requirements? (yes/no)". An Approved one becomes a Draft again.
2. **No impact yet:** say "There is no impact analysis yet: the requirements will not know the risk or the parts of the product it touches. Continue without it? (yes/no)". On yes, run `impact.mjs candidates <ID> --home <home>`, show the likely modules (name and why), and ask which ones the work touches.
3. **Prepare:** `work.mjs prepare <ID> requirement --home <home> [--modules a,b]` (modules only when there is no impact). Show any `warn` lines.
4. **Start `tech-plugin:requirement-analyst`** with the prepare JSON, unchanged, and one line: "Write the requirements, without the stories; run the first-part check and plain.mjs until both pass." Then run `firstPartCheck` and the `plain.mjs` command yourself; one retry with the failing lines, then stop.
5. **Open questions.** If the document has any, show them, each with its role, and ask the person for the answers they can give now. Record each answer (see `work-items.md`, "Answers"). Unanswered ones stay open; the person can come back later. When answers were recorded, run `prepare` again and start the analyst with: "Update the requirements with the new decisions; keep the IDs."
6. **Stories:** run `prepare` again, then start `tech-plugin:story-writer` with the prepare JSON and "Write the user stories; run the checks until both pass." Run both `checks` yourself; one retry, then stop.
7. **Approval.** Show the "In short" lines and the requirement titles. Ask: "Approve the requirements? Give your name and your role (owner, PO or BA)." Only on an explicit yes with a name and role: `work.mjs approve <ID> requirement --by "<name>" --role <role> --home <home>`. If it refuses, show why.
8. **End.** List the requirements and stories, the open questions, and the next step from `status` (`/tech-plugin:design <ID>`, or `/tech-plugin:task <ID>` for a Quick change).
