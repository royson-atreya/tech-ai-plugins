<!-- tech-plugin functional spec template. The ## headings are checked by
     check-doc.mjs: keep them exactly, in this order. Everything above
     "## Appendix A" is the people layer (plain words, no code); everything
     from it down is the evidence and technical layer. -->
---
(the stamp from `doc.mjs prepare`, unchanged)
---
# <Module name>: how it works

> **In short**
> - **What it does:** <one or two plain sentences>
> - **Who uses it:** <roles>
> - **Key rules:** <3 to 5 rules, separated by semicolons>
> - **Open questions:** <N>

## 1. Who uses it

- <Role>: what they use it for. [E1]

## 2. What people can do

### <Journey name, e.g. "Add a new patient">

1. <Step, in the words of the screen.> [E2]
2. <Next step.> [E3]

## 3. Screens

| Screen | What it shows | What you can do there | Evidence |
|---|---|---|---|
| <Plain screen name> | <what it shows> | <actions> | [E4] |

## 4. Rules

- <A rule, in plain words: "A patient must have a name and a mobile number."> [E5]

## 5. When something goes wrong

| Situation | What the person sees | Evidence |
|---|---|---|
| <e.g. the mobile number is already registered> | "<message as shown>" | [E6] |

## 6. Open questions

- **Q1** (for PO): <a question that needs a person's answer?>

## Appendix A. Evidence

| ID | Statement | Source | Class |
|---|---|---|---|
| E1 | <short restatement> | `<repo>:<path>:<line>` | Verified |

## Appendix B. Technical detail

<Screens with files and routes, routes with handlers and access checks, the
backend endpoints each page calls, data, validations, external services: tables
taken from the fact pack, every row cited.>

## Document control

Written by /tech-plugin:document as a Draft. Only a person moves it to Reviewed
or Approved (/tech-plugin:validate records who and when in the stamp).
