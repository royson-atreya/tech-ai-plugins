<!-- Template for releases/<version>/runbook.md. Keep every "## " heading, in this order. Numbered steps a person follows; tech-plugin never runs them. -->
# Release <version>: runbook

> **In short**
> - **Repos:** <the repos this release changes>
> - **Database changes:** <yes or no>
> - **New settings:** <yes or no>
> - **Downtime:** <expected, or "none expected">

## 1. Before you deploy

1. <Tag the release (the commands from /tech-plugin:release). Take a backup of the production database when there are database changes, and check it can be restored.>

## 2. Deploy

1. <The project's own deploy steps, from profile.md, per repo, in order: backend first when the apps call it. Install dependencies when they changed. Run the migrations when there are any. Set the new settings.>

## 3. Check

1. <The smoke checks in smoke.md, by hand, on production. Only look and click; never change real data.>

## 4. Rollback

1. <How to go back to the last release: deploy its tag again; roll back each migration (the command and what data it loses); restore the backup if a migration cannot be rolled back; undo the settings.>

## Document control

Written by /tech-plugin:release. A person runs every step.
