<!-- How defect-triager writes defects for tests.mjs defects. One block per defect; the script gives the ID and the status. -->
### <short title: what goes wrong, in plain words>

**Severity:** <blocking (a requirement cannot be met, or data is lost or exposed), major (it works wrongly but there is a way round) or minor>
**Case:** <the failed case IDs, comma-separated>
**Requirement:** <the requirement IDs those cases cover>
**Steps:**

1. <how to make it happen, from the case>

**Expected:** <what should happen>
**Actual:** <what happened, from the case output; no keys, no personal data>
**Likely cause:** <where in the code, cited `repo:path:line`, marked Inferred unless the output proves it>
