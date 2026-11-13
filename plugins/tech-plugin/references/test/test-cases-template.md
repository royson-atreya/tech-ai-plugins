<!-- Template for tests/test-cases.md (a work item's, or a module's regression suite). The stamp from tests.mjs prepare goes first, unchanged. Keep every "## " heading, in this order. -->
# <Title>: test cases

> **In short**
> - **Cases:** <number>
> - **Covers:** <number> requirements
> - **Sanity:** <number of cases tagged sanity>
> - **Regression:** <number of cases tagged regression>
> - **Open questions:** <number>

## 1. What is tested

<For the owner, PO and testers, in plain words: what these cases prove, which parts of the product they go through, and what is not tested and why.>

## 2. Test data

<The made-up data the cases use: "a test doctor", "patient Test One, mobile 9000000001" (mobile numbers only from 9000000000 to 9000000999). Never real people's data, never data copied from production.>

## 3. Open questions

- **Q1** (for QA): <a question>?

## Appendix A. Evidence

| ID | Statement | Source | Class |
|---|---|---|---|
| E1 | <short statement> | `repo:path:line` | Verified |

## Appendix B. Test cases

### <prefix>-01: <short title>

**Covers:** <requirement ID, or "the bug">
**Type:** <automated, api, ui, manual, perf or mobile>
**Tags:** <sanity, regression, or none>
**Repo:** <automated, perf, mobile: the repo the command runs in>
**Command:** `<automated, perf, mobile: the command>`
**Test:** <automated: the test class or name, so a JUnit results file can be matched>
**Request:** `<api: METHOD /path>`
**Steps:**

1. <a step>

**Expected:** <what passes: the screen, the answer and its status, the number>

## Document control

Draft, written by /tech-plugin:test-cases. /tech-plugin:test-run runs the cases and writes the report; nobody signs them off.
