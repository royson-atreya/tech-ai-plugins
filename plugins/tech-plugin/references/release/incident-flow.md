# incident: the flow

`I` = `${CLAUDE_PLUGIN_ROOT}/scripts/release/incident.mjs`. Never connect to production, deploy, roll back or change data: a person does; you write what to do.

1. **No argument:** `node I list --home <home>`. Open incidents: list them and ask which to continue, or what is broken now. Stop.
2. **A new incident** (the argument is what is broken, not an incident name): write `# <what is broken>` and what people see to `<home>/sdlc-docs/_state/incident-in.md` with the Write tool, then `node I new --input <that file> --home <home> [--severity S1..S4]`. Ask how bad it is if not said: S1 everyone is stopped, S2 a main flow is broken, S3 a part is broken with a way round, S4 small.
3. **Evidence:** ask for error messages, log lines or what the screen shows. Write each answer to `<home>/sdlc-docs/_state/evidence-in.md` and run `node I evidence <name> --input <that file> --home <home>` (keys and personal data are masked). Never ask for production database dumps or user lists. If a Sentry or Grafana tool is available, you may read from it (read only) and save what matters the same way.
4. **Analysis:** `node I suspects <name> --home <home>`, then start `tech-plugin:incident-investigator` with that JSON and the file to write: `<home>/sdlc-docs/_state/analysis.md`. Then `node I save <name> --input <that file> --home <home>`. If it is refused, start the investigator once more with the message.
5. **The way out:** show the likely cause, the confidence and the way out.
   - **Rollback:** point at the last release's runbook, section "Rollback". The person runs it.
   - **Hotfix:** `node I hotfix <name> --home <home>` writes the request; then `node "${CLAUDE_PLUGIN_ROOT}/scripts/work/work.mjs" new --request-file <request> --kind bug --home <home>` and `node I link <name> --work <ID> --home <home>`. Say the branch command from `message` (the person runs it), and continue with /tech-plugin:task <ID>: the normal plan, approval, build, review and test, as a Quick item.
6. **Resolved** (the person says it is fixed, or `--resolved` was given): `node I resolve <name> --home <home>`, then start `tech-plugin:ops-writer` with the JSON: "Job: postmortem. Read the rules first; write the postmortem; run both checks until they pass." Run both `checks` yourself. Show the root cause and the actions, and offer to start a work item for each action (/tech-plugin:impact).
