# release: the flow

`R` = `${CLAUDE_PLUGIN_ROOT}/scripts/release/release.mjs`. The person who deploys decides; nothing is signed off. Never deploy, tag, push or run anything against production.

1. **What is ready:** `node R status --home <home>`. No `ready` item and none named: say "Nothing is ready to release: an item is ready when its test run passed (/tech-plugin:status)" and stop. A release in `releases` that is `ready` but not `released`: offer to continue it (step 5).
2. **Check:** `node R check [<version>] [<IDs>] --home <home> [--ref <branch>]`. Without a version it proposes one (`proposed.next`, after `proposed.last`): say it and ask "Use <next>? (yes, or give another)"; run the check again with the chosen version if it differs.
   Show the checklist lines (✅ ⚠️ ❌), the flags and the `checklist` path. `ready` is false: say what to fix; the notes are still written, but the release cannot be finished.
3. **Notes and runbook:** `node R prepare <version> --home <home>`, then start `tech-plugin:ops-writer` with the JSON: "Job: release. Read the rules first; write the release notes and the runbook; run both checks until they pass." Run both `checks` yourself; one retry with the failing lines, then show them and stop.
4. **Go or no go:** start `tech-plugin:release-reviewer` with the paths of `checklist.md`, `release-notes.md`, `runbook.md` and the items' handoffs and test reports. Write its reply to `<home>/sdlc-docs/_state/report.md`, then `node R save-review <version> --input <that file> --home <home>`. Show the recommendation and its reasons.
5. **Deploy is the person's:** say "Deploy with the runbook (`releases/<version>/runbook.md`), do the smoke checks (`smoke.md`), then run /tech-plugin:release <version> again to finish it." Stop.
6. **Finish** (the person says it is deployed and the smoke checks passed): `node R finish <version> --home <home>`. Show `message`: the tag commands they run themselves. The items are now released.
