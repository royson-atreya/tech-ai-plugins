---
name: doctor
description: Check the tech-plugin setup (Claude Code, node, git, uv, graphify, LSP plugins, Zoho Sprints, effort settings) and list the commands. Never installs anything.
argument-hint: "[--ci]"
disable-model-invocation: true
model: haiku
effort: low
allowed-tools: Bash(node:*)
---

# tech-plugin doctor

Setup check output:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" $ARGUMENTS`

Show the output above to the user exactly as it is, with two changes:
- replace `ZOHO_STATUS` in the "Zoho Sprints MCP" row with `✅ connected` if any tool available to you has `ZohoSprints` in its name, or `⚠️ not connected (tickets will be plain text in sdlc-docs/work/)` otherwise;
- replace `BROWSER_STATUS` in the "Browser tools (UI tests)" row with `✅ available` if any tool available to you has `playwright` and `browser_navigate` in its name, or `⚠️ not available (UI test cases are blocked; install the Playwright plugin or MCP)` otherwise.

If the block above is empty or shows an error instead of a table, run
`node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" $ARGUMENTS` once with Bash and show its output.

Do not run anything else and do not install anything: doctor only prints the
commands for the user to run. Add no commentary after the table.
