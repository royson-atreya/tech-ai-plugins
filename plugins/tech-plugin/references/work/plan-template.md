<!-- Template for work/<ID>/plan.md. The stamp from build.mjs prepare goes first, unchanged. Keep every "## " heading, in this order. -->
# <Title of the work item>: plan

> **In short**
> - **What changes:** <one or two plain sentences: what people will notice>
> - **Steps:** <number>
> - **Repos:** <the repos the steps change, e.g. web, backend>
> - **Risk:** <Low, Medium, High or Critical>
> - **Open questions:** <number>

## 1. What will change

<For the owner and PO, in plain words: what people will see or notice when it is done, and what stays the same. No code names here.>

## 2. Cause of the bug

<A bug: how to show it, then why it happens.

To show it:

1. <a step a tester follows>
2. <what they see, and what they should see instead>

The cause, in plain words. [E1]

A feature: "Not a bug.">

## 3. Risks and how to undo it

<What could go wrong and who would notice; data that changes and how to put it back; packages to install (the person installs them); how to undo the change (revert the commit, roll back a migration).>

## 4. Open questions

- **Q1** (for developer): <a question>?

## Appendix A. Evidence

| ID | Statement | Source | Class |
|---|---|---|---|
| E1 | <short statement> | `repo:path:line` | Verified |

## Appendix B. Steps

### <ID>-T01: <short title>

**Covers:** <ID>-R01 <or "the bug">

**Files:**

- `repo:path/to/file` (change)
- `repo:path/to/new_file` (new)

**Do:** <what to change, precisely enough for a developer who has not read the rest: the function, the rule, the field>

**Check:** `<the command that proves it, from profile.md>` <or "by hand: …">

## Document control

Draft, written by /tech-plugin:task. A person approves it by creating the APPROVED file that /tech-plugin:task prints, and switching to a feature branch.
