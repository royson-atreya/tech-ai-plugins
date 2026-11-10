# breakdown stage 1: find the repos

Goal: know which repos and apps make up the system, choose the home repo, and record the user's business answers in `sdlc-docs/system.yaml`.

## 1. Find the repos

Run, passing any paths or URLs from the arguments (not the `--` options):

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/breakdown/find-repos.mjs" [paths or URLs]
```

It prints JSON:
- `mode`: `repo`, `workspace`, `paths`, `urls`, `folder` or `empty-folder`
- `repos`: each with `name`, `path`, `role`, `apps`, `empty` and `pointer`
- `urls`: each with a clone `command`
- `homeGuess`, `missing` and `notes`

- **`urls` not empty:** show each `command` and ask the user to run them, for example in a terminal or with `!`. Then stop. When they come back, run the command again with the folder paths.
- **`missing` not empty:** say which paths were not found and ask for the right ones.
- **`empty-folder`, or a single repo with `empty: true`:** say "No code yet: no stack detected. A later command (`requirement`) helps start a new project." Still offer to record the business answers (steps 3–5), then stop after stage 1.
- **A repo with a `pointer`:** it belongs to a system whose home repo is at that path. Suggest running breakdown from there instead.

## 2. Show what was found

Show one short table: repo, role, apps (kind and main stack). If there are several repos, propose `homeGuess` as the home repo and explain it in one line: the home repo holds the system docs, and the other repos get a pointer and their own `_map/`. The user may pick another repo or drop repos.

## 3. Ask the 5 business questions

Ask all five in **one** message. The user may answer any of them or say "skip":

1. What does the product do, in a sentence or two?
2. Who uses it? (patients, doctors, admins…)
3. What are the 3–5 most important things people do with it?
4. Which user roles exist?
5. Which environments are there (name and URL), and which of them are production?

If `--docs <folder>` was given, also confirm that folder. Its files are only listed now; converting them to Markdown comes in a later version.

## 4. Ask before creating sdlc-docs/

In the same message, ask: "Create `sdlc-docs/` in <repo list>? It holds the system docs; you decide later whether it goes into git." Wait for a yes.

## 5. Write

Write the answers as JSON to `<home>/sdlc-docs/_state/stage1-input.json` with the Write tool. Use this shape, with absolute paths, empty strings or lists for skipped answers, and `tracker` set to `"zoho-sprints"` only if a tool with `ZohoSprints` in its name is available to you:

```json
{
  "system": "Short product name",
  "home": "/abs/path/to/home-repo",
  "repos": [{ "path": "/abs/path/to/repo", "role": "backend" }],
  "business": {
    "product": "…", "users": "…", "keyFlows": ["…"], "roles": ["…"],
    "environments": [{ "name": "staging", "url": "https://…", "production": false }]
  },
  "docs": ["/abs/path/to/docs-folder"],
  "tracker": "plain-text"
}
```

Then run:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/breakdown/write.mjs" system --input "<home>/sdlc-docs/_state/stage1-input.json"
```

It merges with any existing `system.yaml`, so the user's own edits are kept. It also seeds `glossary.md`, writes the `README.md` index and pointer files in the other repos, and records stage 1 as done.

## 6. Production hosts

If the user named production URLs, offer to add their hosts to `blockedHosts` in `<home>/sdlc-docs/config.json`, so the guard keeps browser, fetch and network tools away from them. Create or merge the file with the Edit or Write tool, keeping any keys already there. The guard asks the user to confirm the change; that is expected. Skip this if they say no.
