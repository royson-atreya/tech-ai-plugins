# breakdown stage 5: propose modules

Goal: an approved `sdlc-docs/modules.yaml`. Every backend route must be in exactly one module, or on the `unassigned` list with a reason. The `module-proposer` agent (Opus) decides the boundaries, scripts expand them, and the user approves.

`S` = `${CLAUDE_PLUGIN_ROOT}/scripts/breakdown`.

## A. Modules were approved before (status says "Code changed since the modules were approved")

```
node "S/modules.mjs" refresh --home "<home>"
```

- **"refreshed: no module changes":** say "The code changed, but no route or screen moved: the module list stays as approved." Go to stage 6. No approval is needed.
- **Otherwise** it prints the JSON diff. Show the user what is `added`, `removed`, `moved` and `unexplained`, in at most 10 lines. Then continue with B, telling the agent that this is a second pass and passing the diff.

## B. Propose

1. Run `node "S/modules.mjs" candidates --home "<home>"`. It writes `_map/candidates.md`. Don't read that file yourself.
2. Start the `tech-plugin:module-proposer` agent. Give it:
   - the home repo path;
   - the scripts folder `S` with `${CLAUDE_PLUGIN_ROOT}` written out as the real path;
   - any user corrections or the diff from A.

   The agent writes `_map/module-proposal.yaml`, runs the preview until it is clean, and replies with the preview.
3. If the agent's preview still shows ERRORS, start it once more with the errors. If that fails too, show the errors to the user and stop.

## C. Ask for approval (always)

Show the user:
- the preview table, the coverage line(s) and the unassigned routes with their reasons;
- the agent's judgement calls, in at most 8 lines.

Then ask: **"Approve this module list? You can also rename, merge or split modules, or move routes."**

- **Simple changes** (a rename, merging two modules, a purpose sentence, a risk flag): edit `_map/module-proposal.yaml` yourself, run `node "S/modules.mjs" preview --home "<home>"`, and show the table again.
- **Splits and moving routes:** start the agent again with the user's words.
- **A module approved before is missing:** the preview says so. Ask the user whether to drop it. Only after an explicit yes, add `--allow-remove <id>` to the write command.

## D. After an explicit yes

```
node "S/modules.mjs" write --home "<home>"
```

It writes `modules.yaml` with the approver (the git user name) and the date, and marks stage 5 done. **Never run `write` without the user's yes.** Then go straight on to stage 6.
