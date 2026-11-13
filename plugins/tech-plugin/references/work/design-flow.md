# design: the flow

1. **Status:** `node "${CLAUDE_PLUGIN_ROOT}/scripts/work/work.mjs" status <ID> --home <home>`.
   - `next` is `restart` or `breakdown`: reply with `message` and stop.
   - No requirements yet: say "Write the requirements first: /tech-plugin:requirement <ID>" and stop.
   - The design is Approved and up to date: say so with the next step and stop.
   - It exists, up to date, a Draft: go to step 5 (open questions) or step 6 (approval).
   - It is `stale`: say why and ask "Rewrite the design? (yes/no)".
2. **Prepare:** `work.mjs prepare <ID> design --home <home> [--force]`.
   - `quick` is true: reply with `message` and stop, unless the person asked for `--force`.
   - Show any `warn` lines. If the requirements are not approved, ask "Design before the requirements are approved? (yes/no)".
3. **Start `tech-plugin:design-architect`** with the prepare JSON, unchanged: "Write the approach, the decisions and the open questions; run the first-part check and plain.mjs until both pass." Run `firstPartCheck` and `plain.mjs` yourself; one retry with the failing lines, then stop.
4. **Details:** run `prepare` again, then start `tech-plugin:design-writer` with the JSON: "Write the screen changes, API changes, data changes and coverage; run the checks until both pass." Run both `checks` yourself; one retry, then stop.
5. **Open questions.** Show them with their roles and ask for the answers the person can give now. Record each (see `work-items.md`). When answers were recorded, run `prepare` again and start the architect with "Update the design with the new decisions; keep the IDs", then the writer if the details change.
6. **Approval.** Show the "In short" lines and the decision titles. Ask: "Approve the design? Give your name and role (developer or tech lead)." Only on an explicit yes with a name and role: `work.mjs approve <ID> design --by "<name>" --role <role> --home <home>`. It also updates `sdlc-docs/decisions/README.md`.
7. **End.** List the decisions, the changes (screens, server actions, tables), the open questions, and the next step from `status`.
