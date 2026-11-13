# Worker rules

For `tech-plugin:worker-light`, `worker-standard` and `worker-deep`. The person who started you named one job: **plan**, **step** or **fix**. Read this file, then do only that job.

## Always

- **Read only what the job needs.** The files the prompt names, the plan, and the code files a step lists, at most 20 files, one at a time. Use the code map and the fact packs to find code; do not read whole folders.
- **Never open secret files** (`.env`, keys, keystores, service-account files). If a step needs a secret value, stop and say so.
- **Never run git** beyond `git diff`, `git status` and `git log`. A person commits, branches and pushes.
- **Never install anything** (npm, composer, pip, flutter pub, pod…). The guard blocks it. If a step needs a package, stop and reply `needs install: <the exact command>`.
- **Never touch** `sdlc-docs/work/.active`, any `APPROVED` file, Claude settings or the plugin. In a repo, change only the files the step lists.
- **No personal data, ever:** no real names, phone numbers, emails or ID numbers in code, tests, fixtures or seeds. Use made-up data (`Test Patient`, `9000000000`).
- **Follow the project's ways:** the conventions in `profile.md` and in the files around the one you change: naming, folders, error handling, how tests are written. Keep the change as small as the step allows.
- **If the plan is wrong** (a file is not where it says, the step cannot work), stop and say what is wrong. Do not invent another plan.

## Job: plan (write work/<ID>/plan.md)

You get the JSON from `build.mjs prepare`: `out`, `stamp`, `template`, `rules`, `inputs`, `modules`, `profile`, `testCommands`, `repos`, `kind`, `stepPrefix`, `keepIds`, `checks`.

1. Read `work-rules.md` and `writing-rules.md` (in `rules`), the template, the inputs (request; for a feature: requirements and design), and the fact packs.
2. Find the files to change with the fact packs (routes, handlers, screens, tables, each cited) and, when you need more, the code itself. Cite what you rely on in Appendix A.
3. Write `out`: the stamp first, unchanged, then the template's sections.
   - **Steps** (`<stepPrefix>01`, `02`…): small, in the order to build them, each one testable. Each names what it covers (requirement IDs, or "the bug"), its files as `` `repo:path` `` with `(change)`, `(new)` or `(delete)`, what to do, and its check: a test command from `testCommands` or `profile.md` (in backticks), or "by hand: …" when there is no test to run. Add `**Tier:** light` to a purely mechanical step (a rename, a text change). Run tests with the runner directly (`vendor/bin/phpunit`, `vendor/bin/pest`, `pytest`, `npx jest`, `flutter test`): the guard blocks `php artisan test`, `python manage.py test` and `rails test`.
   - **Every requirement** of a feature is covered by at least one step.
   - **A bug:** section 2 says how to show it (a numbered list) and the cause, with evidence. The first step adds a test that fails because of the bug; its check runs that test.
   - Keep every ID in `keepIds`; a dropped step stays, titled `Removed (reason)`.
4. Run both `checks` commands and fix every FAIL until both pass.

Reply in at most 6 lines: the steps (ID and title), the repos, the risk, the open questions, and the last line of each check.

## Job: step (build one step of the plan)

You get the plan path, the step ID and `profile.md`.

1. Read the step, the files it lists and what they use. Read the requirements it covers.
2. Make the change. Only the listed files; a new file only where the step says `(new)`.
3. Run the step's check exactly as written (it may be "by hand": then say what you checked). If it fails, fix your change and run it again, at most three times.

Reply, starting with one line `RESULT: pass` or `RESULT: fail`, then: the files you changed, what you did in two or three lines, the check command and the last 30 lines of its output, and anything the reviewer should know. Never paste a secret value from the output.

## Job: fix (fix review findings)

You get the review files and the plan. Fix only the findings marked **blocking**, in the files they name, then run the checks of the steps whose files you changed.

Reply, starting with `RESULT: pass` or `RESULT: fail`, then, per finding: fixed or not and why, and the check output (last 30 lines).
