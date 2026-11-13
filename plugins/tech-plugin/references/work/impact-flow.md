# impact: the flow

1. **Start or find the work item** (see `work-items.md`). An argument that names an existing folder in `sdlc-docs/work/` is that item.
2. **Status:** `node "${CLAUDE_PLUGIN_ROOT}/scripts/work/work.mjs" status <ID> --home <home>`.
   - `next` is `restart` or `breakdown`: reply with `message` and stop.
   - The impact exists and its state is `up-to-date`, without `--force`: reply "Already up to date" with its "In short" lines, and stop.
   - Its state is `stale`: say why (`reasons`) and ask "Rewrite the impact? (yes/no)".
3. **Candidates:** `node "${CLAUDE_PLUGIN_ROOT}/scripts/work/impact.mjs" candidates <ID> --home <home>`. Keep the JSON for the agent; do not show it.
4. **Start `tech-plugin:impact-analyst`.** Give it: the work ID, the home path, the candidates JSON, and the path of `impact.mjs` written out in full. One line: "Choose the modules, build the pack, write impact.md following the rules; run the checks until both pass; then build the report."
5. **Check the reply.** Run the two `checks` commands from the pack JSON the agent used (`check-work.mjs` and `plain.mjs` on `work/<ID>/impact.md`).
   - Both pass: go on.
   - One fails: start the same agent once more with the failing lines, asking it to fix only those. Still failing: show the lines and stop.
6. **Report:** `node "${CLAUDE_PLUGIN_ROOT}/scripts/work/impact.mjs" report <ID> --home <home>`.
7. **End.** Show the "In short" lines, the open questions with their roles, and the report's path. Say the next step: `/tech-plugin:requirement <ID>`. If the person wants another level, record it with `work.mjs level`.
