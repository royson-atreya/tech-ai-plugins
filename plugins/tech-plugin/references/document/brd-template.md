<!-- tech-plugin BRD template. The ## headings are checked by check-doc.mjs:
     keep them exactly, in this order. Everything above "## Appendix A" is the
     people layer. -->
---
(the stamp from `doc.mjs prepare`, unchanged)
---
# <Module name>: business requirements

> **In short**
> - **What it does:** <one or two plain sentences>
> - **Who uses it:** <roles>
> - **Key rules:** <3 to 5 business rules, separated by semicolons>
> - **Open questions:** <N>

## 1. Purpose

<What this part of the product lets people do, and why it matters to them.> [E1]

## 2. Business objectives

- <Objectives are almost never in code: write them as questions.> [Q1]

## 3. People and roles

| Role | What they need from it | Evidence |
|---|---|---|
| <Role> | <need> | [E2] |

## 4. Scope

### In scope

- <Capability that exists in the product today.> [E3]

### Out of scope

- <What belongs to another module, or exists in code but nothing uses.> [E4]

## 5. How it works today

1. <The main journey in plain steps.> [E5]

## 6. Business rules

- <Rule in business words.> [E6]

## 7. Business requirements

| ID | Requirement | Evidence |
|---|---|---|
| BR-01 | <The business needs …> | [E7] |

## 8. Dependencies

- <Other modules and outside services, by plain name.> [E8]

## 9. Assumptions and constraints

- <Only provable ones; the rest go to Open questions.> [E9]

## 10. Success measures

- <How the owner will know it works: questions for the owner.> [Q2]

## 11. Open questions

- **Q1** (for owner): <question?>
- **Q2** (for owner): <question?>

## Appendix A. Evidence

| ID | Statement | Source | Class |
|---|---|---|---|
| E1 | <short restatement> | `<repo>:<path>:<line>` | Verified |

## Document control

Written by /tech-plugin:document as a Draft. Only a person moves it to Reviewed
or Approved.
