# test-run: the flow

`T` = `${CLAUDE_PLUGIN_ROOT}/scripts/test/tests.mjs`. Runners write their results to `resultsDir`; you never write results yourself.

1. **Select:** `node T select <target> --home <home> [--sanity|--regression] [--env <name>]`.
   - No `--env` and there are `api` or `ui` cases: ask which test environment (the names in `system.yaml`); never production. It refuses production itself.
   - Say: `counts` per group, and each `skipped` case with its reason.
2. **Repo tests** (`automated` not empty):
   - A work item: `node T gate <ID> --open --home <home>`. `open` is false: show `message`; list each automated case's `**Command:**` for the person to run in their own terminal, and ask them for a JUnit results file (`node T junit <target> <run> --file <it> --home <home>`) or their pass/fail per case (record it, step 5).
   - A module: always the person runs them, as above.
   - Open: start `tech-plugin:test-runner` with the `automated` cases, `repos`, `resultsDir` and "Read `${CLAUDE_PLUGIN_ROOT}/references/test/tester-rules.md` first; run each case and write its result file."
3. **API cases:** start `tech-plugin:test-runner` with the `api` cases, the environment's `env.url` and `resultsDir`. Start it in parallel with step 2's runner when both are needed.
4. **UI cases:** start `tech-plugin:ui-tester` with the `ui` cases, `env.url` and `resultsDir`.
5. **Manual cases:** for each, show its steps and expected result and ask "pass, fail or skip?". Write the person's answer and any note to `<resultsDir>/<case>.md` as `RESULT: <answer>` then the note.
6. **Record:** `node T ingest <target> <run> --dir <resultsDir> --home <home>`. Show `problems` if any. Cases left without a result stay "not run".
7. **Close the gate:** a work item whose gate was opened: `node T gate <ID> --close --home <home>`. Always, even when a step above failed.
8. **Defects:** when cases failed or were blocked, start `tech-plugin:defect-triager` with the failed cases, their output files (`work/<ID>/tests/runs/<run>/`), the template `${CLAUDE_PLUGIN_ROOT}/references/test/defect-template.md`, and the file to write: `<home>/sdlc-docs/_state/defects-in.md`. Then `node T defects <target> <run> --input <that file> --home <home>`.
   - **Zoho Sprints:** only if a Zoho Sprints tool is available, ask once: "Create these N defects in Zoho Sprints? (yes/no)". Only on yes create each (the guard asks too) and record its number: `node T defect <DEF> --zoho <number> --home <home>`.
9. **Report:** `node T report <target> <run> --home <home>`. Show: `verdict`, the counts, open defects (blocking first), `fixedNow`, whether the traceability is complete, `promoted.moved` and `promoted.waiting`, and the paths of the report and `rtm.md`.
10. **Next:** failed: "Fix a defect with /tech-plugin:task <DEF-ID>" (a bug work item; record the link with `node T defect <DEF> --status in-fix --work <new ID>`). Passed: the item is tested; next comes `/tech-plugin:release` (build step 10).
