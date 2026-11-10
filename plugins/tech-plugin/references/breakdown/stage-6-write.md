# breakdown stage 6: write the breakdown

Goal: write the documents people read, from the approved `modules.yaml` and the code facts. Scripts write them, so the same input gives the same documents.

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/breakdown/catalogue.mjs" --home "<home>"
```

It writes, in the home repo's `sdlc-docs/`:
- `modules/README.md`: the module catalogue, coverage, unassigned routes, and the suggested order of next steps
- `modules/<id>/module.md`: one scope card per module, with screens, APIs, tables, external services, connections and where the code is. The user's notes block is kept on every rewrite.
- `system/overview.md`: the system on one page
- `system/diagrams/module-map.md`: a Mermaid module map, with every arrow listed with its evidence
- `glossary.md`: domain words from the code, added with the meaning "to be confirmed"

It also updates the `README.md` index.

Then tell the user, in at most 6 lines:
- the files written, and that everything is a Draft: boundaries approved, purposes to be confirmed by each module's owner;
- the suggested order the script printed, as next commands, e.g. `/tech-plugin:document reports`;
- that running `/tech-plugin:breakdown` again with no code change answers "Already up to date";
- that tech-plugin never commits: whether `sdlc-docs/` goes into git is their call.
