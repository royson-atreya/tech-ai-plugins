// Throwaway workspace for the guard tests, built under the OS temp folder:
// fake repos with fake secrets, sdlc-docs/ folders, approved and unapproved
// work items, and symlinks for bypass attempts. It never touches a real repo.
// Repos are created with `git init -b <branch>` and `git add` (no commits).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function put(file, text = 'x\n') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr}`);
}

// A repo with the usual secret files and an sdlc-docs/ folder.
function mkrepo(dir, branch, { active = null, approved = [], items = [], config = null, add = false } = {}) {
  put(path.join(dir, 'app/x.php'), '<?php // x\n');
  put(path.join(dir, 'routes/web.php'), "<?php Route::post('a', 'B');\n");
  put(path.join(dir, '.env'), 'APP_KEY=dummy\n');
  put(path.join(dir, '.env.example'), 'APP_KEY=\n');
  put(path.join(dir, '.env.local'), 'X=1\n');
  put(path.join(dir, 'config/firebase-adminsdk.json'), '{}\n');
  put(path.join(dir, 'android/app/google-services.json'), '{}\n');
  put(path.join(dir, 'ios/Runner/GoogleService-Info.plist'), 'k\n');
  put(path.join(dir, 'keys/release.jks'), 'k\n');
  put(path.join(dir, 'keys/upload.keystore'), 'k\n');
  put(path.join(dir, 'certs/server.pem'), 'k\n');
  put(path.join(dir, 'certs/client.p12'), 'k\n');
  put(path.join(dir, 'deploy/id_rsa'), 'k\n');
  put(path.join(dir, 'lib/a.dart'), '// a\n');
  put(path.join(dir, 'src-clean/a.php'), '<?php // clean\n');
  put(path.join(dir, 'composer.json'), '{}\n');
  put(path.join(dir, 'sdlc-docs/README.md'), '# docs\n');
  put(path.join(dir, 'sdlc-docs/old/x.md'), 'old\n');
  fs.mkdirSync(path.join(dir, 'sdlc-docs/work'), { recursive: true });
  for (const id of items) fs.mkdirSync(path.join(dir, 'sdlc-docs/work', id), { recursive: true });
  for (const id of approved) put(path.join(dir, 'sdlc-docs/work', id, 'APPROVED'), 'approved by a person\n');
  if (active !== null) put(path.join(dir, 'sdlc-docs/work/.active'), active);
  if (config !== null) put(path.join(dir, 'sdlc-docs/config.json'), typeof config === 'string' ? config : JSON.stringify(config, null, 2));
  git(dir, 'init', '-q', '-b', branch);
  if (add) {
    git(dir, 'add', '-A');
    // change a tracked secret after staging, so "git diff" would print it
    fs.writeFileSync(path.join(dir, '.env'), 'APP_KEY=changed\n');
  }
  return dir;
}

export function buildFixture() {
  const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tp-guard-')));
  const HOME = path.join(W, 'home');
  put(path.join(HOME, '.claude/settings.json'), '{}\n');
  put(path.join(HOME, '.claude.json'), '{}\n');
  put(path.join(HOME, '.claude/plugins/installed_plugins.json'), '{"version":2,"plugins":{}}\n');
  put(path.join(HOME, '.zshrc'), '# rc\n');
  put(path.join(HOME, 'notes/n.txt'), 'n\n');

  const R = {
    main: mkrepo(path.join(W, 'main'), 'main', { active: 'W-1\n', approved: ['W-1'], items: ['W-1'] }),
    feat: mkrepo(path.join(W, 'feat'), 'feature/W-1', {
      active: 'W-1\n',
      approved: ['W-1'],
      items: ['W-1', 'W-2'],
      add: true,
      config: {
        blockedHosts: ['prod.example.com'],
        secretPatterns: ['*.secret'],
        safeCommands: { 'php artisan': ['route:list', 'about'] },
        tracker: 'zoho',
      },
    }),
    unap: mkrepo(path.join(W, 'unap'), 'feature/W-2', { active: 'W-2\n', items: ['W-2'] }),
    noact: mkrepo(path.join(W, 'noact'), 'feature/x', {}),
    rel: mkrepo(path.join(W, 'rel'), 'release/1.0', { active: 'W-1', approved: ['W-1'], items: ['W-1'], config: { protectedBranches: ['release/*'] } }),
    det: mkrepo(path.join(W, 'det'), 'feature/d', { active: 'W-1', approved: ['W-1'], items: ['W-1'] }),
    trav: mkrepo(path.join(W, 'trav'), 'feature/t', { active: '../W-1\n', approved: ['W-1'], items: ['W-1'] }),
    two: mkrepo(path.join(W, 'two'), 'feature/two', { active: 'W-1\nW-2\n', approved: ['W-1', 'W-2'], items: ['W-1', 'W-2'] }),
    symap: mkrepo(path.join(W, 'symap'), 'feature/s', { active: 'S-1\n' }),
    bad: mkrepo(path.join(W, 'bad'), 'feature/b', { active: 'W-1', approved: ['W-1'], items: ['W-1'], config: '{ not json' }),
  };
  put(path.join(R.feat, 'app/api.secret'), 'k\n');
  // detached HEAD
  fs.writeFileSync(path.join(R.det, '.git/HEAD'), '0123456789abcdef0123456789abcdef01234567\n');
  // an approval planted through a symlinked work folder
  const OUT = path.join(W, 'outside');
  put(path.join(OUT, 'fake-S-1/APPROVED'), 'fake\n');
  fs.symlinkSync(path.join(OUT, 'fake-S-1'), path.join(R.symap, 'sdlc-docs/work/S-1'));
  // bypass helpers
  put(path.join(OUT, 'notes.txt'), 'notes\n');
  put(path.join(OUT, 'x.secret'), 'not a secret here: no project config\n');
  fs.symlinkSync(path.join(R.feat, '.env'), path.join(OUT, 'innocent.txt'));
  fs.symlinkSync(R.unap, path.join(OUT, 'link-to-unap'));
  fs.symlinkSync('../app/x.php', path.join(R.unap, 'sdlc-docs/innocent'));
  fs.linkSync(path.join(R.unap, 'app/x.php'), path.join(OUT, 'hardlink.php')); // second name for a repo file
  put(path.join(OUT, 'evil.sh'), `echo pwned > "${path.join(R.main, 'app/x.php')}"\n`);
  put(path.join(OUT, 'nice.sh'), 'echo hello > /dev/null\nls\n');
  return { W, HOME, OUT, R };
}

// The PreToolUse command exactly as hooks.json declares it.
export function hookCommand(pluginRoot = PLUGIN) {
  const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks/hooks.json'), 'utf8'));
  return hooks.hooks.PreToolUse[0].hooks[0].command.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot);
}

// Runs the guard as Claude Code would. Returns 'pass' | 'ask' | 'block:<rule>'.
export function runGuard(input, { env = {}, pluginRoot = PLUGIN } = {}) {
  const r = spawnSync(hookCommand(pluginRoot), {
    shell: true,
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PROJECT_DIR: '', ...env },
    timeout: 20000,
  });
  let decision;
  if (r.status === 2) {
    const m = /BLOCKED \[([a-z-]+)\]/.exec(r.stderr || '');
    decision = m ? `block:${m[1]}` : 'block';
  } else if (r.status === 0 && /"permissionDecision":"ask"/.test(r.stdout || '')) decision = 'ask';
  else if (r.status === 0 && !(r.stdout || '').trim()) decision = 'pass';
  else decision = `exit${r.status}:${(r.stdout || '').slice(0, 80)}`;
  return { decision, stderr: r.stderr || '', stdout: r.stdout || '', status: r.status };
}
