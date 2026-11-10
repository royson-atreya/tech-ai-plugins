# breakdown stage 4: link the apps

Goal: link every screen to the APIs it calls, then to the backend route, its handler and its tables, across web, mobile and backend. The result is `sdlc-docs/_map/links.json` and `links.md` in the home repo.

## 1. Link

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/breakdown/link.mjs" --home "<home>"
```

It prints one line per app: calls matched, method mismatches, calls with no route, unresolved, ambiguous, external. It also prints one line per backend: routes called and routes not called. Show the lines as they are.

## 2. What to tell the user (at most 6 bullets)

- **Calls with no matching route:** likely bugs or removed endpoints. Show at most 5 from `links.md`, with file:line.
- **Calls whose URL is only known at run time:** the count. If many are in one file, the app probably builds URLs from a base-URL name the scripts don't know. Ask the user for that name and add it to `<home>/sdlc-docs/_map/overrides.yaml` under `base_url_names:`. That file is the user's: append to it, never rewrite it. Then run steps 1 and 2 of stage 3 again for that repo, and this step.
- **Ambiguous calls:** the count. A `links:` entry in `overrides.yaml` fixes one; let the user decide.
- **Routes no app calls:** the count per backend. Say that these are possibly unused, or called from outside the system (partners, webhooks, cron).

Point to `sdlc-docs/_map/links.md` for the full lists. Don't paste it.

Then go straight on to stage 5.
