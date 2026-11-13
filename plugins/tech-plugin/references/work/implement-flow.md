# implement: the flow

`B` = `${CLAUDE_PLUGIN_ROOT}/scripts/work/build.mjs`. `R` = `<home>/sdlc-docs/_state/report.md`.

1. **Status:** `node "${CLAUDE_PLUGIN_ROOT}/scripts/work/work.mjs" status <ID> --home <home>`.
   - `next` is `restart` or `breakdown`: reply with `message` and stop.
   - `next` is `task`: say "Write the plan first: /tech-plugin:task <ID>" and stop.
   - `next` is `review` or `done`: say so and stop.
2. **The gate:** `node B approval <ID> --home <home> --activate`.
   - `ok` is false: show `message` (the commands the person runs) and stop. If a repo has `approvedOtherPlan`, say the plan changed after it was approved.
   - The plan has open questions without an answer: list them and ask "Build anyway? (yes/no)".
3. **Progress:** `node B progress <ID> --home <home>`. Say "N of M steps done". `planChanged` is true: say the plan changed since the last build; steps already done stay done.
4. **For each step** that is not done, in order (`next`):
   1. `node B tier <ID> implement --step <step> --home <home>`. `stop` is true: show `message` and stop.
   2. Start the agent in `agent` with: "Job: step. Read `${CLAUDE_PLUGIN_ROOT}/references/work/worker-rules.md` first. Plan: `<home>/sdlc-docs/work/<ID>/plan.md`. Step: <step>. Profile: `<home>/sdlc-docs/profile.md`."
   3. Write its reply, unchanged, to `R`. Run `node B record <ID> <step> --result pass|fail --input "R" --tier <tier> --home <home>`, with the result from the reply's `RESULT:` line (no such line: `fail`).
   4. **The reply says `needs install:`**: show the command for the person to run themselves, and stop. They run `/tech-plugin:implement <ID>` again afterwards.
   5. **fail:** go back to 4.1 for the same step: the tier climbs after two failures, and stops at the top.
   6. **pass:** say one line ("T02 done: …") and go on with the next step.
5. **End:** all steps done: "Built: N steps. Next: /tech-plugin:review <ID>." Never commit.
