<!-- tech-plugin PRD template. The ## headings are checked by check-doc.mjs:
     keep them exactly, in this order. Everything above "## Appendix A" is the
     people layer. -->
---
(the stamp from `doc.mjs prepare`, unchanged)
---
# <Module name>: product requirements

> **In short**
> - **What it does:** <one or two plain sentences>
> - **Who uses it:** <roles>
> - **Key rules:** <3 to 5 rules, separated by semicolons>
> - **Open questions:** <N>

## 1. Overview

<What the module covers, in 3 to 5 plain sentences.> [E1]

## 2. Users and permissions

| Who | What they can do | Evidence |
|---|---|---|
| <Role> | <actions> | [E2] |

## 3. User journeys

### <Journey name>

1. <Step.> [E3]

## 4. Requirements

### <MODULE>-R01: <Short title in plain words>

<What the product does, in one or two plain sentences.>

**Business requirement:** BR-01

**Acceptance criteria**

- Given <situation>, when <action>, then <result>.

**Evidence:** [E4] [E5]

## 5. Screens

| Screen | Who sees it | What it is for | Evidence |
|---|---|---|---|
| <Plain name> | <role> | <purpose> | [E6] |

## 6. Messages and errors

| Situation | Message shown | Evidence |
|---|---|---|
| <case> | "<text>" | [E7] |

## 7. Quality needs

- <Access, languages, speed: only what the code shows; the rest are questions.> [E8]

## 8. Open questions

- **Q1** (for developer): <question?>

## Appendix A. Evidence

| ID | Statement | Source | Class |
|---|---|---|---|
| E1 | <short restatement> | `<repo>:<path>:<line>` | Verified |

## Appendix B. Technical detail

<Per requirement: routes (method, path, handler, access checks), the backend
endpoints called, validations (field, rule), data and external services, every
row cited from the fact pack.>

## Document control

Written by /tech-plugin:document as a Draft. /tech-plugin:validate marks it
Checked once the checks pass (the date is in the stamp). No sign-off is needed.
