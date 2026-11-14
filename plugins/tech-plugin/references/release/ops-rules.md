# Release and incident rules

For `tech-plugin:ops-writer`, `release-reviewer` and `incident-investigator`. These add to `references/document/writing-rules.md`.

## Always

- **Never touch production.** No commands against production hosts or databases, no deploys, no rollbacks, no tags, no pushes. Write the steps; a person runs them.
- **No secrets, no personal data.** Never copy a key, token, password, real name, phone number, email or ID number, even from evidence or logs. Say "an API key", "a patient's phone number".
- **Cite what you rely on:** `repo:path:line`, a commit (`web@3f9a01c`), a work item (W-001), a defect (DEF-W-001-02), a release (v1.4.0).
- **Roles, not names**, for who does what.

## Release notes and runbook (ops-writer, job: release)

You get the JSON from `release.mjs prepare`: `items` (their request, requirements, plan, handoff and test report), `flags` (migrations, settings, dependencies), `checklist`, `profile`, `repos`, `templates`, `out`, `checks`.

- **Release notes:** for users, the owner and support. Section 1 has the features, section 2 the bug fixes, section 3 every open defect in `items[].openDefects` (as a known issue, with what to do until it is fixed). Mention every item ID. Plain words above Appendix A.
- **Runbook:** numbered steps. Take the project's deploy and install commands from `profile.md`; where it has none, write "the usual deploy of <repo>" and say so in your reply. For every flag:
  - **migrations:** a backup step before, the migration command, and in Rollback how to roll it back and what data that loses (or "restore the backup" when it cannot be rolled back);
  - **dependencies:** the install step on the server (composer install --no-dev, npm ci, …);
  - **settings:** which settings to set, by name only, never with a value.
- Run both `checks` and fix every FAIL. Reply in at most 5 lines.

## Go or no go (release-reviewer)

Read `checklist.md`, the release notes, the runbook and the items' test reports and handoffs (their open points). Reply:

```
Recommendation: Go | Go with conditions | No go

<3 to 8 lines: the reasons, the conditions (what must be true before deploying), and the biggest risk with how to watch it after the deploy>
```

Any ❌ in the checklist is "No go". Unresolved blocking findings in a handoff, a migration without a rollback, or a critical module changed without a passing test are "No go" or "Go with conditions".

## Incident analysis (incident-investigator)

You get the JSON from `incident.mjs suspects`: the incident, the evidence (masked), the modules its words point at (fact packs), recent commits (those touching the modules first), the last releases and their runbooks.

1. Read the incident and the evidence. Match error messages and screens to code (fact packs, then the code; at most 20 files; never secret files).
2. Check the suspects: a recent commit or release that changed that code is the first place to look.
3. Write the analysis to the file you were given:

```
Confidence: High | Medium | Low
Way out: Rollback, then hotfix | Rollback | Hotfix | Watch

**Likely cause:** <plain words>, with evidence: `repo:path:line`, the commit, the release.
**Why now:** <what changed>.
**Rollback:** <is rolling back to the last release safe? data written since, migrations>.
**Hotfix:** <the smallest change that fixes it, the files>.
**To confirm:** <what the person can check to be sure, without touching production data>.
```

Reply in at most 5 lines. Never say who caused it.

## Postmortem (ops-writer, job: postmortem)

You get the JSON from `incident.mjs resolve`. Write `out` from the template: the timeline from the incident, the root cause from the analysis and the hotfix handoff, what went well and badly, and actions (one row each, with a role). Blameless. Run both `checks` until they pass.
