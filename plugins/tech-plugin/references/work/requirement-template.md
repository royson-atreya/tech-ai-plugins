<!-- Template for work/<ID>/requirement.md. The stamp from work.mjs prepare goes first, unchanged. Keep every "## " heading, in this order. -->
# <Title of the work item>: requirements

> **In short**
> - **What it adds:** <one sentence>
> - **Who uses it:** <roles>
> - **Requirements:** <number>
> - **Stories:** <number>
> - **Open questions:** <number>

## 1. The request

<The request in plain words, as the person asked it. [E1]>

## 2. What is unclear

<Each gap in the request, in one line, with the question that settles it: "- How long a shared link stays open. [Q1]". Write "None." when nothing is unclear.>

## 3. Requirements

### <ID>-R01: <short title>

<What the product must do, in plain words. One requirement, testable.>

**Changes:** <new, or the module requirement it changes, such as PATIENTS-R02>

**Acceptance criteria**

- Given <a situation>, when <someone does something>, then <what they see>.

**Source:** [E1]

## 4. User stories

### <ID>-S01: <short title>

As a <role>, I want <something>, so that <a reason>.

**Covers:** <ID>-R01

**Acceptance criteria**

- Given <a situation>, when <someone does something>, then <what they see>.

## 5. Out of scope

- <what this work does not do>. [E1]

## 6. Open questions

- **Q1** (for PO): <a question>?

## Appendix A. Evidence

| ID | Statement | Source | Class |
|---|---|---|---|
| E1 | The request | request.md | Verified |

## Document control

Draft, written by /tech-plugin:requirement. The owner, PO or BA approves it.
