# breakdown stage 3: read the code

Goal: the facts of every repo (routes, handlers, screens, API calls, tables, external services) and its code graph, written by scripts to each repo's own `sdlc-docs/_map/`.

`<home>` is the home repo from the status. The repos are the status `repos` list. Run only the repos whose `codeChanged` is true (all of them the first time, or with `--refresh`).

## 1. Read each repo

Run one repo at a time, with a Bash timeout of 600000 ms, because the code graph can take minutes on a big repo:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/breakdown/map.mjs" --repo "<repo path>" --home "<home>"
```

Each run prints one summary line. Show the lines as they are.

- **The line ends with `graph missing`:** graphify is not installed. Say once: "The code graph was skipped. Routes, screens and links still work; module grouping has less to go on. `/tech-plugin:doctor` shows the install command." If `sdlc-docs/config.json` has `"strict": true`, stop here instead.
- **The line ends with `graph failed`:** show the message and carry on. The graph is optional for this stage.
- **`already mapped`:** nothing changed in that repo. That's fine.

## 2. Point out what needs a person

Read only each repo's `sdlc-docs/_map/<repo>/facts.md`. It is short; never open `facts.json`. Then mention, in at most 5 bullets in total:
- lines the readers could not understand (the unparsed count, and the first 3 with file:line);
- controller files not found, or never opened because they are secret by name;
- API calls whose URL is only known at run time (the count);
- an app where the readers found nothing. Its facts come from the generic reader and are Inferred.

Then go straight on to stage 4.
