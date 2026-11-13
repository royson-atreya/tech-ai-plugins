# task: the flow

`W` = `${CLAUDE_PLUGIN_ROOT}/scripts/work/work.mjs`, `B` = `${CLAUDE_PLUGIN_ROOT}/scripts/work/build.mjs`.

1. **A bug given in words or as a Zoho bug** (not an existing work ID): start a work item as `work-items.md` says, with `--kind bug` added to `work.mjs new`. Use the ID it returns from here on.
   **A defect ID** (`DEF-W-001-02`): run `node "${CLAUDE_PLUGIN_ROOT}/scripts/test/tests.mjs" defect <DEF> --request --home <home>`; it writes the request file. Then `node W new --request-file <that file> --kind bug --home <home>`, and link them: `tests.mjs defect <DEF> --status in-fix --work <new ID> --home <home>`. Go on with the new ID.
2. **Status:** `node W status <ID> --home <home>`.
   - `next` is `restart` or `breakdown`: reply with `message` and stop.
   - `next` is `impact`, `requirement`, `approve-requirement`, `design` or `approve-design`: say "Plan after that: <nextText>" and stop.
   - `next` is `approve-plan`: the plan is written. Go to step 6.
   - `next` is `implement`, `review` or `done`: say so with `nextText` and stop. To plan again anyway, the person runs `/tech-plugin:task <ID> --force`.
   - `next` is `task` and a plan exists: say why it is out of date (`states`/`buildState.plan.reasons`) and ask "Write the plan again? (yes/no)".
3. **Prepare:** `node B prepare <ID> --home <home> [--modules a,b]`.
   - It refuses when the requirements (or the design, for a Standard or Full item) are not approved: show its message and stop.
   - `modulesGuessed` is true: say which modules it took from the bug's words, and that the person can name others.
   - `dirty` is not empty: say "These repos have uncommitted changes; review will count them as part of this work: …" and ask "Go on? (yes/no)".
4. **Write the plan.** Start the agent in `tier.agent` with the prepare JSON, unchanged, and: "Job: plan. Read `${CLAUDE_PLUGIN_ROOT}/references/work/worker-rules.md` first. Write the plan; run both checks until they pass." Then run both `checks` yourself. If one fails, start the same agent once more with the failing lines; if it still fails, show them and stop.
5. **Open questions.** Show them with their roles and ask for the answers the person can give now. Record each with `work.mjs decide <ID> --doc plan …` (see `work-items.md`). When answers were recorded, run `prepare` again and start the agent with "Job: plan. Update the plan with the new decisions; keep the IDs."
6. **Approval.** Run `node B approval <ID> --home <home> --activate`. It writes `sdlc-docs/work/.active` in each repo the plan changes. Show:
   - the "In short" lines and the step titles (ID and title);
   - `message`: the commands the person runs in their own terminal (a feature branch, and the APPROVED line with the plan's version). Claude can never run them.

   Say: "Run them, then /tech-plugin:implement <ID>." Never create an APPROVED file and never switch branches yourself.
