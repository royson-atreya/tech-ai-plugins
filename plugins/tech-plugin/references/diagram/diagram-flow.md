# diagram: drawing one module

1. **Screen names.**

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/diagram/diagram.mjs" labels <module> --home <home>
   ```

   It writes `modules/<module>/diagrams/labels.yaml`, one name per screen. Names come from the spec's Screens table where a row names exactly one screen. Names people or the labeller wrote earlier are kept. The JSON gives `todo`, the number of screens still without a name.
2. **`todo` is more than 0:** start the agent named in `agent` (`tech-plugin:diagram-labeller`). Give it:
   - the `labels` path, the `facts` path, the `spec` path (or "none") and the `glossary` path;
   - the `screens` list from the JSON, unchanged;
   - one line: "Write a plain name for every screen without one in labels.yaml."
3. **Check the names.** Run the `check` command from the JSON.
   - **PASS:** go on.
   - **FAIL:** start the labeller once more with the failing lines, and ask it to fix only those. If it still fails, show the failing lines to the user and stop.
4. **Draw.**

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/diagram/diagram.mjs" draw <module> --home <home>
   ```

   It writes, in `modules/<module>/diagrams/`:
   - `flowchart.md`: the people layer, screens in business words, in parts when there are more than 25 screens;
   - `sequences.md`: the technical layer, one sequence diagram per PRD requirement whose evidence reaches an API;
   - `er.md`: the technical layer, the module's tables, with links between tables marked Inferred;
   - beside each one with a diagram in it, a `.drawio` copy (`flowchart.drawio`, `sequences.drawio`, `er.drawio`) to open and rearrange in draw.io or diagrams.net;
   - `_stamp.json`: what they were drawn from, so later runs say "Already up to date".
5. **Report** from the JSON, in at most 5 lines:
   - screens, arrows and parts;
   - sequence diagrams drawn, and the requirements with no API call (`withoutApi`);
   - tables and the inferred links between them;
   - for each `keptDrawio` entry: "<file> was changed by someone, so it was kept; the new drawing is in <newFile>."

   With no PRD there are no sequence diagrams: suggest `/tech-plugin:document <module>`.
