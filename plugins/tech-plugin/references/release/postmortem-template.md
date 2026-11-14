<!-- Template for incidents/<name>/postmortem.md. Keep every "## " heading, in this order. Blameless: about what happened and why, never who. Roles, not names. -->
# Postmortem: <what was broken>

> **In short**
> - **What happened:** <one sentence>
> - **Impact:** <who was affected, how, for how long>
> - **Root cause:** <one sentence>
> - **Actions:** <number>

## 1. Summary

<What broke, who noticed, how it was fixed, in plain words.>

## 2. Timeline

- <time UTC>: <what happened or was done>

## 3. Root cause

<Why it happened, with evidence: the change, the code (`repo:path:line`), the condition. Then why that was possible: the check that did not catch it.>

## 4. What went well

- <a thing that helped>

## 5. What went badly

- <a thing that made it worse or slower>

## 6. Actions

| Action | Role | Work item |
|---|---|---|
| <what to change so it does not happen again> | developer | <W-012, or "to start"> |

## Document control

Written by /tech-plugin:incident when it was resolved.
