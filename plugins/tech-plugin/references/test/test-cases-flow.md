# test-cases: the flow

`T` = `${CLAUDE_PLUGIN_ROOT}/scripts/test/tests.mjs`.

1. **Status:** `node T status <target> --home <home>`. Test cases that exist and still match their inputs: say so with the counts and stop, unless the person asked to write them again.
2. **Prepare:** `node T prepare <target> --home <home>`. Show any `warn` lines. It refuses when a feature has no requirements, or a module no PRD: show its message and stop.
3. **Write:** start `tech-plugin:test-designer` with the prepare JSON, unchanged: "Write the test cases; read the tester rules first; run both checks until they pass." Then run both `checks` yourself. One retry with the failing lines; if it still fails, show them and stop.
4. **Open questions:** show them with their roles; record answers the person gives (see `references/work/work-items.md`, with `--doc` left as the work item's requirement when it is about a requirement). Never answer one yourself.
5. **End:** the counts by type, sanity and regression, the requirements covered, and the next step: `/tech-plugin:test-run <target> --env <a test environment>`.
