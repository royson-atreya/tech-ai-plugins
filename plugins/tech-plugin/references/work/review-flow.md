# review: the flow

`B` = `${CLAUDE_PLUGIN_ROOT}/scripts/work/build.mjs`. `R` = `<home>/sdlc-docs/_state/report.md`. At most two review rounds.

1. **Status:** `node "${CLAUDE_PLUGIN_ROOT}/scripts/work/work.mjs" status <ID> --home <home>`.
   - `next` is `restart` or `breakdown`: reply with `message` and stop.
   - `next` is `task`, `approve-plan` or `implement`: say "Build it first: <nextText>" and stop.
   - `next` is `done`: say the handoff is written (`work/<ID>/handoff.md`) and stop.
2. **Collect the changes:** `node B changes <ID> --home <home>`. Say in one line: files changed, `+added −removed`, and any `unplanned` files or `skippedSecrets`.
3. **Review, both at once:** start `tech-plugin:code-reviewer` and `tech-plugin:security-reviewer` in parallel, each with:
   - the patch (`patch`) and the summary (`json`);
   - `<home>/sdlc-docs/work/<ID>/plan.md`, and `requirement.md` when it exists;
   - the check reports in `<home>/sdlc-docs/work/<ID>/checks/`;
   - the round number, and for round 2 the round-1 review file.

   Write each reply, unchanged, to `R` and save it right away: `node B save-review <ID> --kind code|security --input "R" --home <home>`.
4. **Blocking findings** (either review's `blocking` above 0) **and this was round 1:**
   1. `node B tier <ID> fix --home <home>`, then start that agent with: "Job: fix. Read `${CLAUDE_PLUGIN_ROOT}/references/work/worker-rules.md` first. Plan: …/plan.md. Reviews: <the saved review files>."
   2. Write its reply to `R`, then `node B record <ID> fix-1 --result pass|fail --input "R" --tier <tier> --home <home>`.
   3. Go back to step 2 for round 2.
5. **Handoff:** `node B handoff <ID> --home <home>`. It writes `work/<ID>/handoff.md` and the commit message, and closes the gate (no more code edits for this item). Show:
   - files changed, the checks, and the review result (blocking findings left, if any);
   - `unplanned` files, if any;
   - the `commands` for the person to commit and push in their own terminal, and the path of `handoff.md`;
   - "After the merge, run /tech-plugin:sync: the documents of the modules it changed will be out of date."

   Never commit, push or open a pull request yourself.
