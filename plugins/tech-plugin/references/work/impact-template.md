<!-- Template for work/<ID>/impact.md. The stamp from impact.mjs pack goes first, unchanged. Keep every "## " heading, in this order. -->
# <Title of the work item>: impact

> **In short**
> - **The change:** <one sentence: what is asked, in plain words>
> - **Who notices:** <the people whose screens or results change>
> - **Risk:** <Low | Medium | High | Critical>
> - **Size:** <S | M | L | XL>
> - **Level:** <Quick | Standard | Full>
> - **Open questions:** <number>

## 1. What is asked

<The request in plain words, two to four sentences. Tag every statement about the product as it is today with [E#].>

## 2. Parts of the product it touches

<One row per part of the product the change reaches. "How" says whether the change is made there (changed) or whether that part only feels it (affected).>

| Part of the product | How | What changes for it | Evidence |
|---|---|---|---|
| <module name> | changed | <plain words> | [E1] |

## 3. Who notices the change

- <a role>: <what they see differently>. [E2]

## 4. Risk

<The risk level and why: money, security, health findings, personal data, other apps that depend on what changes, checked documents that would need checking again. Tag each reason.>

## 5. Size

<The size and why: how many screens, behind-the-scenes steps and kinds of stored data change, and in how many apps. S: a few hours to a day. M: a few days. L: one to two weeks. XL: more than two weeks; split it.>

## 6. Proposed level

<Quick (a bug fix or small change: no design), Standard (a feature: requirements and a short design) or Full (a new module or product: requirements, design and decisions). Say why in one or two sentences. A person may change it.>

## 7. Open questions

- **Q1** (for PO): <a question a person must answer before the requirements>?

## Appendix A. Evidence

| ID | Statement | Source | Class |
|---|---|---|---|
| E1 | <short statement> | `repo:path:line` | Verified |

## Appendix B. Technical detail

<For developers: the routes, screens, tables and calls that change, with citations; other apps that call them; documents that would go back to Draft; what the code graph suggests might also be touched (Inferred).>

## Document control

Draft, written by /tech-plugin:impact. An impact has no sign-off: it informs the requirements.
