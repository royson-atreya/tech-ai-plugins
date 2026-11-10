// Guard tests: feed PreToolUse JSON to the real hook command (node guard.mjs ||
// exit 2) and check the decision: 'pass', 'ask' or 'block:<rule>'.
//
//   node --test tests/                  (from plugins/tech-plugin)
//   node --test tests/guard-tests.mjs
//
// Fixture repos (tests/fixture.mjs):
//   main   branch main,         W-1 active + APPROVED   -> writes blocked (protected branch)
//   feat   branch feature/W-1,  W-1 active + APPROVED   -> writes allowed; config adds a
//          blocked host, a secret pattern and a narrower artisan list
//   unap   feature/W-2, W-2 active, not approved
//   noact  no .active          rel  release/1.0 (protected by its config)
//   det    detached HEAD       trav .active = "../W-1"     two  .active names two items
//   symap  work/S-1 is a symlink to a folder holding APPROVED
//   bad    sdlc-docs/config.json is not valid JSON

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFixture, PLUGIN, runGuard } from './fixture.mjs';

const F = buildFixture();
const { W, HOME, OUT, R } = F;
const FOLD = process.platform === 'darwin' || process.platform === 'win32';
const TMP = fs.realpathSync(os.tmpdir());
const ENV = { HOME, USERPROFILE: HOME };

after(() => fs.rmSync(W, { recursive: true, force: true }));

const groups = new Map();
function add(group, expect, label, input, env = {}) {
  if (!groups.has(group)) groups.set(group, []);
  groups.get(group).push({ expect, label, input, env });
}
const short = (p) => String(p).split(W).join('W').split(PLUGIN).join('PLUGIN');
const bash = (g, expect, cwd, command, env) => add(g, expect, `Bash[${short(cwd)}] ${short(command)}`, { tool_name: 'Bash', cwd, tool_input: { command } }, env);
const file = (g, expect, tool, p, cwd = W) => add(g, expect, `${tool} ${short(p)}`, { tool_name: tool, cwd, tool_input: { file_path: p, content: 'x', old_string: 'a', new_string: 'b' } });
const grep = (g, expect, p, extra = {}) => add(g, expect, `Grep ${short(p)} ${JSON.stringify(extra)}`, { tool_name: 'Grep', cwd: W, tool_input: { pattern: 'x', path: p, ...extra } });
const glob = (g, expect, pattern, cwd = R.feat) => add(g, expect, `Glob ${pattern}`, { tool_name: 'Glob', cwd, tool_input: { pattern } });
const tool = (g, expect, name, input, cwd = R.feat) => add(g, expect, `${name} ${short(JSON.stringify(input))}`, { tool_name: name, cwd, tool_input: input });
const raw = (g, expect, label, text, env) => add(g, expect, `raw input: ${label}`, text, env);

const M = R.main;
const FE = R.feat;

// ================================================================ a. secrets
{
  const g = 'a. secrets';
  for (const f of ['.env', '.env.local', 'keys/release.jks', 'keys/upload.keystore', 'certs/server.pem', 'certs/client.p12', 'deploy/id_rsa', 'config/firebase-adminsdk.json', 'android/app/google-services.json', 'ios/Runner/GoogleService-Info.plist']) {
    file(g, 'block:secrets', 'Read', path.join(FE, f));
  }
  file(g, 'pass', 'Read', path.join(FE, '.env.example'));
  file(g, 'pass', 'Read', path.join(FE, 'app/x.php'));
  file(g, 'block:secrets', 'Read', path.join(FE, 'app/api.secret')); // pattern from feat's config
  file(g, 'pass', 'Read', path.join(OUT, 'x.secret')); // no project config there
  file(g, 'block:secrets', 'Read', path.join(FE, '.ENV')); // case trick
  file(g, 'block:secrets', 'Read', path.join(FE, 'app/../.env')); // ../ trick
  file(g, 'block:secrets', 'Read', path.join(OUT, 'innocent.txt')); // symlink to feat/.env
  file(g, 'block:secrets', 'Edit', path.join(OUT, 'innocent.txt'));
  file(g, 'block:secrets', 'Write', path.join(OUT, '.env'));
  grep(g, 'block:secrets', path.join(FE, '.env'), { output_mode: 'content' });
  grep(g, 'block:secrets', FE, { output_mode: 'content' });
  grep(g, 'pass', FE, {});
  grep(g, 'pass', FE, { output_mode: 'files_with_matches' });
  grep(g, 'pass', FE, { output_mode: 'count' });
  grep(g, 'pass', FE, { output_mode: 'content', glob: '*.php' });
  grep(g, 'pass', FE, { output_mode: 'content', type: 'php' });
  grep(g, 'block:secrets', FE, { output_mode: 'content', type: 'json' });
  grep(g, 'block:secrets', FE, { output_mode: 'content', glob: '*.{php,json}' });
  grep(g, 'block:secrets', FE, { output_mode: 'content', glob: '!*.md' });
  grep(g, 'pass', path.join(FE, 'src-clean'), { output_mode: 'content' });
  grep(g, 'block:secrets', FE, { glob: '.env*' });
  grep(g, 'block:secrets', HOME, { output_mode: 'content' }); // too broad
  glob(g, 'block:secrets', '**/.env*');
  glob(g, 'block:secrets', '**/*.pem');
  glob(g, 'pass', '**/.env.example');
  glob(g, 'pass', '**/*.php');
  bash(g, 'block:secrets', FE, 'cat .env');
  bash(g, 'pass', FE, 'cat .env.example');
  bash(g, 'block:secrets', FE, 'cat config/*');
  bash(g, 'block:secrets', FE, 'cat .e*');
  bash(g, 'block:secrets', FE, 'grep -rn APP_KEY .');
  bash(g, 'pass', FE, 'grep -rl APP_KEY .');
  bash(g, 'pass', FE, "grep -rn 'Route::post' routes src-clean");
  bash(g, 'block:secrets', FE, "grep -rn 'Route::post' app"); // app/api.secret: a secret by feat's config
  bash(g, 'block:secrets', FE, 'rg APP_KEY');
  bash(g, 'pass', FE, 'rg -l APP_KEY');
  bash(g, 'block:secrets', FE, 'find . -type f -exec cat {} \\;');
  bash(g, 'pass', FE, "find . -name '*.php'");
  bash(g, 'block:secrets', FE, "find . -name '*.php' | xargs grep foo");
  bash(g, 'block:secrets', FE, "bash -c 'cat .env'");
  bash(g, 'block:secrets', FE, 'echo "$(head -1 .env)"');
  bash(g, 'block:secrets', FE, 'git show HEAD:.env');
  bash(g, 'block:secrets', FE, "cat $'\\x2eenv'"); // ANSI-C escapes
  bash(g, 'block:secrets', FE, 'cat .e"n"v'); // quote splitting
  bash(g, 'block:secrets', FE, 'cat .e\\nv'); // backslash splitting
  bash(g, 'block:secrets', FE, 'cat .{env,x}'); // brace expansion
  bash(g, 'block:secrets', FE, 'F=.e; cat ${F}nv'); // variable concatenation
  bash(g, 'block:secrets', FE, 'cat $UNKNOWN_VAR'); // path the guard cannot see
  bash(g, 'block:secrets', FE, 'cat < .env');
  bash(g, 'block:secrets', FE, `cat ${OUT}/innocent.txt`); // symlink
  bash(g, 'block:secrets', FE, 'cp .env /tmp/x');
  bash(g, 'block:secrets', FE, 'tar czf /tmp/tp-a.tgz .'); // archiving secrets
  bash(g, 'block:secrets', FE, 'base64 < .env.local');
  bash(g, 'block:secrets', FE, 'cat ANDROID/APP/GOOGLE-SERVICES.JSON');
  bash(g, 'block:secrets', FE, "node -e \"require('fs').readFileSync('.env')\"");
  bash(g, 'block:secrets', FE, 'grep -rn x ~');
  bash(g, 'block:secrets', FE, 'git grep APP');
  bash(g, 'pass', FE, 'git grep -l APP');
  bash(g, 'block:secrets', FE, 'git diff'); // .env changed after staging
  bash(g, 'pass', FE, 'git diff -- app');
  bash(g, 'pass', FE, 'git diff --stat');
  bash(g, 'block:secrets', FE, 'while read f; do cat "$f"; done < files.txt');
  bash(g, 'pass', FE, 'for f in app/*.php; do cat "$f"; done');
  bash(g, 'block:secrets', FE, 'for f in config/*; do cat "$f"; done');
}

// ================================================================ b. repo-write
{
  const g = 'b. repo-write';
  file(g, 'block:repo-write', 'Edit', path.join(M, 'app/x.php')); // protected branch main
  file(g, 'pass', 'Edit', path.join(FE, 'app/x.php')); // approved + feature branch
  file(g, 'block:repo-write', 'Write', path.join(R.unap, 'app/x.php')); // not approved
  file(g, 'block:repo-write', 'Write', path.join(R.noact, 'app/x.php')); // no .active
  file(g, 'block:repo-write', 'Write', path.join(R.rel, 'app/x.php')); // release/* from config
  file(g, 'block:repo-write', 'Write', path.join(R.det, 'app/x.php')); // detached HEAD
  file(g, 'block:repo-write', 'Write', path.join(R.trav, 'app/x.php')); // .active = ../W-1
  file(g, 'block:repo-write', 'Write', path.join(R.two, 'app/x.php')); // .active names two
  file(g, 'block:repo-write', 'Write', path.join(R.symap, 'app/x.php')); // symlinked approval
  file(g, 'block:repo-write', 'MultiEdit', path.join(M, 'app/x.php'));
  add(g, 'block:repo-write', 'NotebookEdit main/n.ipynb', { tool_name: 'NotebookEdit', cwd: W, tool_input: { notebook_path: path.join(M, 'n.ipynb'), new_source: 'x' } });
  file(g, 'pass', 'Write', path.join(M, 'sdlc-docs/notes.md'));
  file(g, 'pass', 'Write', path.join(R.unap, 'sdlc-docs/work/W-2/plan.md'));
  file(g, FOLD ? 'pass' : 'block:repo-write', 'Write', path.join(M, 'SDLC-DOCS/notes.md')); // case-insensitive FS
  file(g, 'block:repo-write', 'Write', path.join(M, 'sdlc-docs/../app/x.php'));
  file(g, 'block:repo-write', 'Write', path.join(R.unap, 'sdlc-docs/innocent')); // symlink into app/
  file(g, 'block:repo-write', 'Write', path.join(OUT, 'link-to-unap/app/x.php')); // dir symlink
  file(g, 'pass', 'Write', path.join(OUT, 'notes.txt'));
  file(g, 'pass', 'Write', path.join(TMP, 'tp-guard-out.txt'));
  bash(g, 'block:repo-write', M, 'echo x > app/x.php');
  bash(g, 'pass', FE, 'echo x > app/x.php');
  bash(g, 'block:repo-write', M, 'echo x >> app/x.php');
  bash(g, 'block:repo-write', M, 'echo x | tee app/y.php');
  bash(g, 'block:repo-write', M, "sed -i '' 's/a/b/' app/x.php");
  bash(g, 'pass', FE, "sed -i '' 's/a/b/' app/x.php");
  bash(g, 'pass', M, 'sed -n 1p app/x.php');
  bash(g, 'block:repo-write', M, 'mv app/x.php app/z.php');
  bash(g, 'block:repo-write', M, 'cp routes/web.php app/');
  bash(g, 'block:repo-write', M, 'rm app/x.php');
  bash(g, 'block:repo-write', M, 'touch app/new.php');
  bash(g, 'block:repo-write', M, 'mkdir app/new');
  bash(g, 'block:repo-write', W, 'rm -rf main/app');
  bash(g, 'block:repo-write', M, 'cd app && echo x > y.php'); // cd then write
  bash(g, 'pass', M, 'cd sdlc-docs && echo x > notes.md');
  bash(g, 'pass', M, 'cd /tmp && echo x > tp-guard-y.txt');
  bash(g, 'block:repo-write', M, '(cd /tmp); echo x > app/x.php'); // subshell cd does not stick
  bash(g, 'block:repo-write', M, 'cd /no-such-dir-tp || echo x > app/x.php'); // failed cd
  bash(g, 'block:repo-write', M, 'cd /tmp | echo x > app/x.php'); // cd in a pipeline
  bash(g, 'block:repo-write', M, 'curl -o app/x.html https://staging.example.com');
  bash(g, 'pass', M, 'ls > /tmp/tp-guard-ls.txt');
  bash(g, 'pass', M, 'ls app 2>/dev/null');
  bash(g, 'pass', M, 'echo hi > sdlc-docs/notes.md');
  bash(g, 'pass', M, 'php artisan route:list --json > sdlc-docs/routes.json');
  bash(g, 'block:repo-write', M, 'npm test'); // unknown effect, not approved
  bash(g, 'pass', FE, 'npm test'); // approved work item, feature branch
  bash(g, 'block:repo-write', R.unap, 'make build');
  bash(g, 'block:repo-write', M, 'python3 /tmp/tp-script.py'); // session is in the repo
  bash(g, 'block:repo-write', M, 'python3 -c "print(1)"');
  bash(g, 'pass', FE, 'python3 -c "print(1)"');
  bash(g, 'pass', OUT, 'node -e "console.log(1)"'); // no repo involved
  bash(g, 'block:repo-write', OUT, `python3 -c "open('${R.unap}/app/x.php','w')"`); // repo path in code
  bash(g, 'block:repo-write', M, 'echo x > "$OUT_FILE"'); // target not fixed
  bash(g, 'block:repo-write', M, 'echo x > app/*.php'); // glob target
  bash(g, 'block:repo-write', M, './gradlew build');
  bash(g, 'block:repo-write', M, 'X=app; echo y > $X/x.php'); // known variable
  bash(g, 'block:repo-write', M, 'ln -s /etc/hosts app/hosts');
  bash(g, 'block:repo-write', M, 'dd if=/dev/zero of=app/x.php count=1');
  bash(g, 'block:repo-write', M, "perl -pi -e 's/a/b/' app/x.php");
  bash(g, 'block:self-protection', M, 'unzip /tmp/tp-a.zip'); // into the repo root: could write .git/hooks
  bash(g, 'block:repo-write', M, 'tar xf /tmp/tp-a.tar -C app');
  bash(g, 'block:self-protection', M, 'patch -p1 < /tmp/tp-x.diff'); // same: patch could touch .git
  bash(g, 'block:repo-write', M, 'patch app/x.php /tmp/tp-x.diff');
  bash(g, 'block:repo-write', M, 'rsync -a /tmp/tp-x/ app/');
  bash(g, 'block:repo-write', M, 'ls app | xargs rm');
  bash(g, 'block:repo-write', M, "env FOO=1 sh -c 'echo x > app/x.php'");
  bash(g, 'block:repo-write', M, "bash <<'EOF'\necho x > app/x.php\nEOF");
  bash(g, 'block:repo-write', OUT, `bash ${OUT}/evil.sh`); // script is read and checked
  bash(g, 'pass', OUT, `bash ${OUT}/nice.sh`);
  bash(g, 'block:repo-write', M, 'echo x > app/x.php && git status');
  bash(g, 'block:repo-write', M, 'true; echo `echo hi` > app/x.php');
  bash(g, 'block:repo-write', M, 'sed -n "w app/out.txt" app/x.php'); // sed w command
  bash(g, 'block:repo-write', M, "awk '{print > \"app/out.txt\"}' app/x.php"); // awk redirection
}

// ================================================================ c. git
{
  const g = 'c. git';
  for (const c of ['git status', 'git diff --stat', 'git log --oneline -3', 'git log', 'git log --stat', 'git show --stat HEAD', 'git blame app/x.php', 'git branch', 'git branch --list', 'git branch -a', 'git branch --show-current', 'git rev-parse HEAD', 'git ls-files', 'git grep -l APP', 'git remote -v', 'git remote', 'git --version', `git -C ${FE} status`, 'git status && git log --oneline']) {
    bash(g, 'pass', FE, c);
  }
  for (const c of ['git commit -m x', 'git push', 'git pull', 'git fetch', 'git checkout -b x', 'git switch x', 'git branch newbranch', 'git branch -D x', 'git stash', 'git reset --hard', 'git add .', 'git -c core.pager=less log', 'git diff --output=/tmp/x HEAD', 'git remote add x y', 'git clone https://example.com/r.git', 'git init', 'git merge x', 'git rebase main', 'git tag v1', 'git cherry-pick abc', 'git revert abc', 'git restore app/x.php', 'git rm app/x.php', 'git mv a b', 'git apply x.diff', 'git clean -fd', 'git config user.name x', 'git worktree add ../x', 'git submodule update', 'git update-ref HEAD x', 'git status && git commit -m x', 'echo $(git commit -m x)', 'GIT_EXTERNAL_DIFF=x git diff', 'PATH=/tmp:$PATH git status', 'alias git=ls; git status', 'git diff --ext-diff', 'git log | git commit -F -']) {
    bash(g, 'block:git', FE, c);
  }
  bash(g, 'block', M, 'GIT commit -m x'); // case trick: git on a case-insensitive disk
  bash(g, 'block:repo-write', M, './git status'); // a local "git" is an unknown program
  bash(g, 'pass', OUT, 'git status'); // outside any repo
  bash(g, 'block:git', OUT, 'git commit -m x'); // git writes are blocked everywhere
  file(g, 'block:git', 'Write', path.join(FE, '.git/hooks/pre-commit')); // .git even when approved
  bash(g, 'block:git', FE, 'echo x > .git/config');
}

// ================================================================ d. installs
{
  const g = 'd. installs';
  for (const c of ['npm install', 'npm i lodash', 'npm ci', 'yarn', 'yarn add x', 'pnpm add x', 'composer require foo/bar', 'composer install', 'pip install requests', 'pip3 install -r requirements.txt', 'python3 -m pip install x', 'poetry add x', 'uv add x', 'uv pip install x', 'flutter pub get', 'dart pub add x', 'gem install x', 'bundle install', 'go get example.com/x', 'go mod tidy', 'cargo add serde', 'npm audit fix']) {
    bash(g, 'block:installs', M, c);
  }
  bash(g, 'block:installs', path.join(M, 'ios'), 'pod install');
  bash(g, 'block:installs', FE, 'npm install'); // even with an approved work item
  bash(g, 'block:installs', OUT, `npm --prefix ${M} install`);
  bash(g, 'pass', OUT, 'npm install'); // not a repo
  bash(g, 'pass', M, 'npm install -g some-cli'); // global
  for (const c of ['npm ls', 'composer show', 'pip list', 'flutter pub outdated', 'go version']) bash(g, 'pass', M, c);
  bash(g, 'block:repo-write', M, 'npx playwright install chromium'); // runs a package: unknown effect
  bash(g, 'pass', OUT, 'npx playwright install chromium');
}

// ================================================================ e. prod-hosts (feat's config blocks prod.example.com)
{
  const g = 'e. prod-hosts';
  bash(g, 'block:prod-hosts', FE, 'curl https://prod.example.com/login');
  bash(g, 'block:prod-hosts', FE, 'wget -qO- https://api.prod.example.com/health'); // subdomain
  bash(g, 'block:prod-hosts', FE, 'curl -s https://PROD.EXAMPLE.COM'); // case
  bash(g, 'block:prod-hosts', FE, 'curl https://prod.example.com./x'); // trailing dot
  bash(g, 'block:prod-hosts', FE, 'H=prod.example.com; curl https://$H/'); // variable
  bash(g, 'block:prod-hosts', FE, 'curl https://pr\\od.example.com'); // backslash
  bash(g, 'pass', FE, 'curl -s https://staging-prod.example.com/login'); // sibling host
  bash(g, 'pass', FE, 'curl -s https://prod.example.com.evil.test'); // different host
  bash(g, 'pass', FE, 'grep -rn prod.example.com routes'); // code search only
  bash(g, 'pass', M, 'curl -s https://prod.example.com'); // main has no blocked hosts
  tool(g, 'block:prod-hosts', 'WebFetch', { url: 'https://prod.example.com/', prompt: 'x' });
  tool(g, 'pass', 'WebFetch', { url: 'https://staging.example.com/', prompt: 'x' });
  tool(g, 'block:prod-hosts', 'mcp__plugin_playwright_playwright__browser_navigate', { url: 'https://prod.example.com/login' });
  tool(g, 'pass', 'mcp__plugin_playwright_playwright__browser_navigate', { url: 'https://staging.example.com/login' });
  tool(g, 'block:prod-hosts', 'mcp__claude_ai_Playwright__browser_run_code', { code: 'await page.goto("https://prod.example.com")' });
}

// ================================================================ f. zoho
{
  const g = 'f. zoho';
  tool(g, 'pass', 'mcp__claude_ai_Zoho_MCP_Atreya__ZohoSprints_GetItems', {});
  tool(g, 'pass', 'mcp__other_name__ZohoSprints_GetItemDetails', {});
  tool(g, 'pass', 'mcp__zoho-sprints__list_projects', {});
  tool(g, 'ask', 'mcp__claude_ai_Zoho_MCP_Atreya__ZohoSprints_CreateItem', {});
  tool(g, 'ask', 'mcp__claude_ai_Zoho_MCP_Atreya__ZohoSprints_UpdateItem', {});
  tool(g, 'ask', 'mcp__other_name__ZohoSprints_MoveItem', {});
  tool(g, 'ask', 'mcp__other_name__ZohoSprints_DeleteItem', {});
  tool(g, 'ask', 'mcp__other_name__ZohoSprints_StartSprint', {});
  tool(g, 'ask', 'mcp__zoho-sprints__create_item', {});
  tool(g, 'block:zoho', 'mcp__zoho_crm__ZohoCRM_CreateRecord', {});
  tool(g, 'pass', 'mcp__zoho_crm__ZohoCRM_GetRecords', {});
}

// ================================================================ g. self-protection
{
  const g = 'g. self-protection';
  const D = path.join(FE, 'sdlc-docs');
  file(g, 'block:self-protection', 'Write', path.join(D, 'work/W-2/APPROVED'));
  file(g, 'block:self-protection', 'Edit', path.join(D, 'work/W-1/APPROVED'));
  file(g, 'block:self-protection', 'Write', path.join(D, 'work/W-2/approved'));
  bash(g, 'block:self-protection', FE, 'touch sdlc-docs/work/W-2/APPROVED');
  bash(g, 'block:self-protection', FE, 'rm sdlc-docs/work/W-1/APPROVED');
  bash(g, 'block:self-protection', FE, 'mv sdlc-docs/work/W-1/APPROVED /tmp/x');
  bash(g, 'block:self-protection', FE, 'cp /tmp/APPROVED sdlc-docs/work/W-2/');
  bash(g, 'block:self-protection', FE, 'cp -r sdlc-docs/work/W-1 sdlc-docs/work/W-9');
  bash(g, 'block:self-protection', FE, 'rm -rf sdlc-docs/work');
  bash(g, 'block:self-protection', FE, 'ln -s /tmp/x sdlc-docs/work/W-2/APPROVED');
  bash(g, 'block:self-protection', FE, 'echo yes > sdlc-docs/work/W-2/APPROVED');
  bash(g, 'block:self-protection', FE, 'tar xf /tmp/tp-a.tar -C sdlc-docs');
  bash(g, 'block:self-protection', FE, 'unzip /tmp/tp-a.zip -d sdlc-docs/work/W-2');
  bash(g, 'pass', FE, 'rm -rf sdlc-docs/old');
  file(g, 'pass', 'Write', path.join(D, 'work/.active'));
  file(g, 'block:self-protection', 'Edit', path.join(PLUGIN, 'scripts/guard.mjs'));
  file(g, 'block:self-protection', 'Write', path.join(PLUGIN, 'config/defaults.json'));
  file(g, 'block:self-protection', 'Write', path.join(PLUGIN, 'hooks/hooks.json'));
  bash(g, 'block:self-protection', OUT, `rm -rf ${PLUGIN}`);
  bash(g, 'block:self-protection', OUT, `mv ${PLUGIN} /tmp/tp-x`);
  file(g, 'block:self-protection', 'Write', path.join(HOME, '.claude/settings.json'));
  file(g, 'block:self-protection', 'Write', path.join(FE, '.claude/settings.local.json'));
  file(g, 'block:self-protection', 'Write', path.join(OUT, '.claude/settings.json'));
  file(g, 'block:self-protection', 'Write', path.join(HOME, '.claude.json'));
  file(g, 'block:self-protection', 'Write', path.join(HOME, '.claude/plugins/x.json'));
  file(g, 'block:self-protection', 'Write', path.join(HOME, '.zshrc'));
  bash(g, 'block:self-protection', OUT, "echo 'alias git=ls' >> ~/.zshenv");
  bash(g, 'block:self-protection', OUT, 'rm -rf ~');
  bash(g, 'block:self-protection', OUT, 'rm -rf ~/.claude');
  add(g, 'ask', 'Write feat/sdlc-docs/config.json', { tool_name: 'Write', cwd: FE, tool_input: { file_path: path.join(D, 'config.json'), content: '{}' } });
  bash(g, 'ask', FE, 'echo {} > sdlc-docs/config.json');
}

// ================================================================ safe-commands
{
  const g = 'safe-commands';
  for (const c of ['php artisan route:list', 'php artisan list', 'php artisan about', 'php artisan', 'python manage.py check']) bash(g, 'pass', M, c);
  for (const c of ['php artisan migrate', 'php artisan db:wipe --force', 'php artisan tinker', './artisan migrate', 'python manage.py migrate', 'rails db:migrate']) bash(g, 'block:safe-commands', M, c);
  bash(g, 'pass', FE, 'php artisan about'); // feat narrows the list to route:list, about
  bash(g, 'block:safe-commands', FE, 'php artisan list');
}

// ================================================================ fail-closed and parsing
{
  const g = 'fail-closed';
  raw(g, 'block:parse', 'not JSON', 'hello');
  raw(g, 'block:parse', 'empty', '');
  raw(g, 'block:parse', 'no tool_name', '{"tool_input":{}}');
  raw(g, 'block:parse', 'tool_input is a list', '{"tool_name":"Read","tool_input":[]}');
  raw(g, 'block', 'node missing (|| exit 2)', JSON.stringify({ tool_name: 'Read', cwd: W, tool_input: { file_path: path.join(OUT, 'notes.txt') } }), { PATH: path.join(W, 'no-bin') });
  add(g, 'block:config', 'plugin defaults missing', { tool_name: 'Read', cwd: OUT, tool_input: { file_path: path.join(OUT, 'notes.txt') } }, { CLAUDE_PLUGIN_ROOT: path.join(W, 'empty-plugin') });
  bash(g, 'block:parse', W, 'echo "unterminated');
  bash(g, 'block:parse', M, 'cat <<EOF\nno end marker');
  bash(g, 'block:parse', W, 'eval rm -rf x');
  bash(g, 'block:parse', M, 'bash -c "$CMD"');
  bash(g, 'block:parse', M, '$CMD app/x.php');
  bash(g, 'block:parse', M, 'cd "$X" && rm y');
  bash(g, 'block:parse', M, "echo 'rm app/x.php' | bash");
  bash(g, 'block:parse', M, 'env -S "rm app/x.php"');
  bash(g, 'block:repo-write', M, 'f() { echo hi; }; f');
  bash(g, 'pass', M, "echo \"routes: $(grep -c 'Route::post(' routes/web.php)\"");
  bash(g, 'block:secrets', M, "echo \"$(grep -c 'x(' .env)\"");
  bash(g, 'block:parse', M, 'echo ' + 'a'.repeat(110000));
  tool(g, 'block:parse', 'PowerShell', { command: 'Remove-Item app/x.php' });
  add(g, 'block:config', 'broken project config: Read', { tool_name: 'Read', cwd: R.bad, tool_input: { file_path: path.join(R.bad, 'app/x.php') } });
  add(g, 'pass', 'broken project config: Read config.json', { tool_name: 'Read', cwd: R.bad, tool_input: { file_path: path.join(R.bad, 'sdlc-docs/config.json') } });
  add(g, 'ask', 'broken project config: fix config.json', { tool_name: 'Write', cwd: R.bad, tool_input: { file_path: path.join(R.bad, 'sdlc-docs/config.json'), content: '{}' } });
  tool(g, 'pass', 'TodoWrite', { todos: [{ content: 'x', status: 'pending' }] });
  tool(g, 'pass', 'Agent', { prompt: 'never read .env files', description: 'x' });
  tool(g, 'block:secrets', 'LSP', { operation: 'hover', filePath: path.join(FE, '.env') });
  tool(g, 'block:repo-write', 'mcp__serena__replace_symbol_body', { relative_path: 'app/x.php', body: 'x' }, M);
  tool(g, 'pass', 'mcp__serena__find_symbol', { relative_path: 'app/x.php', name_path: 'x' }, M);
}

// ================================================================ bypass attempts (repo main: every write must block)
{
  const g = 'bypass attempts';
  const blocked = [
    'echo x >app/x.php', 'echo x>app/x.php', '>app/x.php', 'echo x 1>app/x.php', '>| app/x.php', '&> app/x.php', '&>> app/x.php',
    'exec 3>app/x.php', '{ echo x; } > app/x.php', 'if true; then echo x > app/x.php; fi', 'echo x > app/x.php &',
    "cat <<EOF > app/x.php\nhi\nEOF", 'echo hi | tee >(cat > app/x.php)', "echo hi > ap''p/x.php", 'echo hi > ./app/./x.php',
    'cp /dev/null app/x.php', 'install -m 644 /tmp/x app/x.php', 'tee -a app/x.php < /dev/null', 'cat app/x.php | sponge app/x.php',
    'truncate -s0 app/x.php', 'chmod 777 app/x.php', 'cp -t app /tmp/x', 'mv -t app /tmp/x', 'ln -sf /tmp/x app/x.php',
    'ln app/x.php /tmp/tp-hard', 'cp -l app/x.php /tmp/tp-hard2', 'printf x | dd of=app/x.php', 'scp host:file app/',
    'wget -P app https://x.test/y', 'curl https://x.test > app/x', 'curl -sSLo app/x https://x.test', 'curl -O https://x.test/y',
    "sed -i.bak 's/a/b/' app/x.php", "sed --in-place=.bak 's/a/b/' app/x.php", "awk -i inplace '{print}' app/x.php",
    "nohup sh -c 'rm app/x.php' &", 'time rm app/x.php', 'command rm app/x.php', '\\rm app/x.php', "'rm' app/x.php", "r''m app/x.php",
    'sudo rm app/x.php', 'env rm app/x.php', 'exec rm app/x.php', "zsh -c 'rm app/x.php'", 'a=rm; $a app/x.php',
    'cd app; cd ..; rm app/x.php', 'pushd app && rm x.php && popd', 'builtin cd app && rm x.php', 'cd -P app && rm x.php',
    'xargs -a /tmp/list rm', 'xargs -I{} rm {} <<< app/x.php', 'find app -delete', 'find . -name x -exec rm {} +',
    "python3 - <<'EOF'\nopen('app/x.php','w')\nEOF", "vim -c 'wq' app/x.php", 'python3 -m http.server',
    "osascript -e 'do shell script \"rm x\"'", 'bash -c "$(echo rm) app/x.php"', '$(echo rm) app/x.php',
    'NODE_OPTIONS=--require=/tmp/x.js node "$CLAUDE_PLUGIN_ROOT/scripts/doctor.mjs"',
    'node "$CLAUDE_PLUGIN_ROOT/scripts/../../../../../tmp/x.mjs"', 'git log --format=%H > app/x', 'git show HEAD:app/x.php > app/y',
  ];
  for (const c of blocked) bash(g, 'block', M, c);
  file(g, 'block:repo-write', 'Write', path.join(OUT, 'hardlink.php')); // existing hard link to unap/app/x.php
  for (const c of ['ls -la', 'pwd && ls app && wc -l app/x.php', 'cat app/x.php | head -5', 'echo $HOME', 'jq . composer.json', 'grep -n x app/x.php', 'find . -maxdepth 1', 'diff app/x.php routes/web.php', 'node --version', 'python3 --version', 'date +%s', 'which node', 'git log --oneline -5 | cat', 'ls | sort | uniq -c', 'echo hi > ~/tp-x', 'node "$CLAUDE_PLUGIN_ROOT/scripts/doctor.mjs" --ci']) {
    bash(g, 'pass', M, c);
  }
}

// ================================================================ run
for (const [g, cases] of groups) {
  describe(`${g} (${cases.length})`, () => {
    for (const c of cases) {
      test(`${c.expect.padEnd(22)} ${c.label.slice(0, 160)}`, () => {
        const r = runGuard(c.input, { env: { ...ENV, ...c.env } });
        const ok = c.expect === 'block' ? r.decision.startsWith('block') : r.decision === c.expect;
        assert.ok(ok, `expected ${c.expect}, got ${r.decision}\n${r.stderr}${r.stdout}`);
      });
    }
  });
}

describe('guard speed', () => {
  test('a typical call is decided in well under 1 s', () => {
    const t0 = Date.now();
    const r = runGuard({ tool_name: 'Grep', cwd: FE, tool_input: { pattern: 'x', path: FE, output_mode: 'content', glob: '*.php' } }, { env: ENV });
    assert.equal(r.decision, 'pass');
    assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
  });
  test('every block message names its rule', () => {
    const r = runGuard({ tool_name: 'Read', cwd: FE, tool_input: { file_path: path.join(FE, '.env') } }, { env: ENV });
    assert.match(r.stderr, /^tech-plugin: BLOCKED \[secrets\] /);
  });
});

export const CASE_COUNTS = Object.fromEntries([...groups].map(([g, c]) => [g, c.length]));
