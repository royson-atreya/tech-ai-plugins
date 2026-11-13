# Work items

Each piece of new work has a folder in the home repo: `sdlc-docs/work/<ID>/`.

| File | Written by |
|---|---|
| `request.md` | `work.mjs new`, from the Zoho Sprints item or the person's words |
| `status.json` | every command: level, modules, each document's state, the next step |
| `impact.md`, `impact-report.html` | /tech-plugin:impact |
| `requirement.md` | /tech-plugin:requirement |
| `design.md` | /tech-plugin:design |
| `decisions.md` | `work.mjs decide`: answers to open questions |

- **ID:** the Zoho Sprints item number when there is one (`NT-I42`), otherwise the next `W-001`. Letters, digits, `.`, `_` and `-`.
- **Starting one:** write the request to `<home>/sdlc-docs/_state/request-in.md` with the Write tool. Its first line is `# <a short title>`, then the request as given. Then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/work/work.mjs" new --request-file <that file> --home <home> [--id <Zoho ID> --source zoho]`. The script refuses a request holding a phone number, email or key: ask the person to send it without.
- **Zoho Sprints** is only read here. If a Zoho Sprints tool is available, read the item (title and description) with its "get item details" tool. Never create or update anything in Zoho.
- **Status:** `work.mjs status <ID> --home <home>` returns each document's `state` (missing, up-to-date, stale, with `reasons`), `status` (Draft or Approved), its open questions, and `next`.
- **Answers to open questions:** write the answer to `<home>/sdlc-docs/_state/answer-in.md`, then `work.mjs decide <ID> --doc <doc> --q Q1 --answer-file <that file> --by "<name>" --role <role> --home <home>`.
- **Approval:** only when the person says so, with their name and role: `work.mjs approve <ID> <requirement|design> --by "<name>" --role <role> --home <home>`. The requirements are approved by the owner, PO or BA; the design by a developer or tech lead. The script refuses while a check fails, an open question has no answer, or the document is out of date. A changed document needs approving again.
- **Level:** `work.mjs level <ID> <Quick|Standard|Full> --by "<name>" --home <home>` when the person changes the level the impact proposed. A Quick item needs no design.
- These commands never write `work/.active` or an `APPROVED` file: those come with /tech-plugin:task.
