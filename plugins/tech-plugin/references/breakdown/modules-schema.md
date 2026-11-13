# modules.yaml

`sdlc-docs/modules.yaml` is the single source of truth for module boundaries. `/tech-plugin:breakdown` writes it in stage 5, after the user approves. Later commands (`document`, `diagram`, `impact`, `task`) read it.

## Who owns what

| Fields | Owner | On every rewrite |
|---|---|---|
| `id` | fixed once approved | never changes. Requirement ids derive from it (`PATIENTS-R01`) |
| `name`, `purpose`, `risk`, `parts` | the definition: the user approves it | taken from the approved proposal |
| `owner`, `doc_status`, `in_use` | people | kept as they are |
| `critical`, `size`, `depends_on`, `depends_evidence`, `routes`, `web_routes`, `screens`, `tables`, `external_systems`, `commits`, `unassigned[].routes` | derived from code | recomputed |

To change boundaries:
1. Run `node <scripts>/breakdown/modules.mjs reopen --home <home>`.
2. Edit `_map/module-proposal.yaml`.
3. Run `preview`, then `write` after approval.

Editing the derived lists by hand has no effect; they are recomputed.

## Format

- It uses a strict YAML subset: 2-space indents, no tabs, no anchors, no `{a: b}` maps.
- Routes are written `app|METHOD uri`, exactly as in the app's `facts.json`, for example `backend|GET api/patients/{patient}`.
- Screens are written `app|screen id`.

```yaml
version: 1
generated: 2026-11-11
approved:
  by: Asha Rao
  on: 2026-11-11
backends:
  - backend
commits:
  backend: 0b9c…
modules:
  - id: patients
    name: Patients
    purpose: Keeps the list of patients and their details for doctors.
    risk:
      - flag: personal-data           # money | security | clinical | personal-data
        reason: names and phone numbers
    critical: true                    # derived: any risk flag
    size: M                           # derived: S < 10 routes+screens <= M < 40 <= L
    owner: TBD
    doc_status: none                  # none | draft | checked (approved: signed off before 0.6)
    in_use:
      dev: TBD
      staging: TBD
      production: TBD
    parts:                            # the definition
      - app: backend
        handlers:
          - PatientController
      - app: mobile
        screens:
          - PatientScreen
    depends_on:
      - reports
    depends_evidence:
      reports:
        - "app/Http/Controllers/PatientPageController.php:19 -> POST api/reports"
    routes:
      - backend|GET api/patients
    web_routes: []
    screens:
      - mobile|PatientScreen
    tables:
      - patients
    external_systems: []
unassigned:
  - app: backend
    match: GET api/debug/*
    reason: debug page; should be removed before release
    routes:
      - GET api/debug/phpinfo
```

**Coverage rule:** every live route of every app listed under `backends` appears in exactly one module's `routes`, or under `unassigned` with a reason. Shadowed duplicates don't count. `modules.mjs preview` checks this and refuses to write until it holds.
