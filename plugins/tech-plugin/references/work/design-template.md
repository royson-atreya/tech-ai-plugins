<!-- Template for work/<ID>/design.md. The stamp from work.mjs prepare goes first, unchanged. Keep every "## " heading, in this order. -->
# <Title of the work item>: design

> **In short**
> - **Approach:** <one sentence>
> - **Changes:** <how many screens, behind-the-scenes steps and kinds of stored data change>
> - **Decisions:** <number>
> - **Open questions:** <number>

## 1. Approach

<How it will be built, in plain words for the owner and PO: what people will see, which parts of the product change, and in what order. No code names here.>

## 2. Screen changes

<What changes on each screen, in plain words. A flowchart with business labels when screens or steps are added.>

## 3. Open questions

- **Q1** (for developer): <a question>?

## Appendix A. Evidence

| ID | Statement | Source | Class |
|---|---|---|---|
| E1 | <short statement> | `repo:path:line` | Verified |

## Appendix B. Decisions

### <ID>-D01: <short title>

**Context:** <why a choice is needed> [E1]

**Options:**

- <option 1>: <its trade-off>
- <option 2>: <its trade-off>

**Decision:** <the option chosen, and why>

**Consequences:** <what follows from it>

## Appendix C. API changes

<For each new or changed server action: method and path, who calls it, request fields, answer, errors, and the existing route it changes (cited). "None." if there are none.>

## Appendix D. Data changes

<New or changed tables and columns, migrations, and data to move, with an ER diagram of only what changes. "None." if there are none.>

## Appendix E. Requirement coverage

| Requirement | Covered by |
|---|---|
| <ID>-R01 | Section 2; Appendix C (POST …) |

## Document control

Draft, written by /tech-plugin:design. A developer or tech lead approves it.
