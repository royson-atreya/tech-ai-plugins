# Tester rules

For `tech-plugin:test-designer`, `test-runner`, `ui-tester` and `defect-triager`. These add to `references/document/writing-rules.md` (plain words above Appendix A, the evidence classes).

## Always

- **Made-up data only.** Names like "Test Doctor", "Test Patient One"; mobile numbers only from 9000000000 to 9000000999 (any other number fails the check as possible personal data); emails at example.com. Never a real person's data, never data copied from production, even if you see it.
- **Never production.** Run only against the environment you were given; it is never production. If a URL looks like production, stop and say so.
- **Never open secret files,** never print keys or tokens, never run git beyond `git status`/`diff`/`log`, never install anything (reply `needs install: <command>`).
- **Never change the product's code** while testing. A test that needs a code change is a defect, not something to fix.

## Writing cases (test-designer)

1. Read the requirements (or the PRD), their acceptance criteria, the plan and the fact packs. Each acceptance criterion becomes at least one case; add the cases a tester would add: empty and wrong input, someone without the right role, two at once.
2. Pick the type that proves it most cheaply:
   - **automated:** a test in the repo. Use one that exists (`testFiles`) or one the plan added; give its `**Repo:**`, `**Command:**` (from `testCommands` or `profile.md`, narrowed to that test) and `**Test:**` (its class or name). Call the test runner directly (`vendor/bin/phpunit`, `vendor/bin/pest`, `pytest`, `npx jest`, `flutter test`): the guard blocks `php artisan test`, `python manage.py test` and `rails test`.
   - **api:** one request to a route that exists (`routes`), with what the answer must hold.
   - **ui:** the screen steps a person takes in a browser.
   - **manual:** what cannot be automated (a printed report, a phone notification).
   - **perf** (k6) and **mobile** (Maestro): only when the requirement asks for speed or a mobile flow.
3. Tag `sanity` on the few cases that prove the main path works (3 to 5), `regression` on cases worth repeating in every release.
4. Keep every ID in `keepIds`; a dropped case stays, titled `Removed (reason)`.
5. Run both `checks` and fix every FAIL.

Reply in at most 6 lines: the number of cases by type, sanity and regression counts, requirements covered, open questions, and the last line of each check.

## Running cases (test-runner, ui-tester)

You get the run's cases (JSON), the environment's URL and `resultsDir`. For **each** case, write `<resultsDir>/<case ID>.md`:

```
RESULT: pass | fail | skip | blocked
<what you did: the command or request, or the screens>
<the evidence: the last 30 lines of output, the status and the part of the answer that matters, or what the screen showed>
```

- **automated, perf, mobile:** run `**Command:**` in its repo (`repos` gives the path). `pass` only when it exits 0.
- **api:** send `**Request:**` to the environment's URL with curl (`-sS -w '\n%{http_code}'`), with the steps' data; compare with `**Expected:**`. Never send real credentials; if the route needs sign-in and no test account was given, `blocked`.
- **ui:** follow the steps with the browser tools; take a screenshot only of what proves the result.
- `blocked`: the case could not run (no test account, environment down, a step before it failed); say why. `skip`: the case says it does not apply.

Reply in one line per case: ID and result.

## Triaging failures (defect-triager)

You get the failed and blocked cases with their output files. Group failures with one cause into one defect. Write the defects to the file you were given, in the format of `defect-template.md`, and reply with one line per defect: title, severity, cases.
