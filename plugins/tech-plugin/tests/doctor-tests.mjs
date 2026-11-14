// doctor and banner tests: language/LSP detection, installed-plugin lookup,
// the effort warning, the graphify messages, --ci, and the session banner.
//
//   node --test tests/doctor-tests.mjs

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { detectLanguages, effortWarning, installCommand, installedPlugins, jvmPlugin } from '../scripts/lib/detect.mjs';
import { PLUGIN } from './fixture.mjs';

const VERSION = JSON.parse(fs.readFileSync(path.join(PLUGIN, '.claude-plugin/plugin.json'), 'utf8')).version;
const V = VERSION.replace(/\./g, '\\.');

const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tp-doctor-')));
after(() => fs.rmSync(T, { recursive: true, force: true }));

function folder(name, files) {
  const d = path.join(T, name);
  fs.mkdirSync(d, { recursive: true });
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
    fs.writeFileSync(path.join(d, f), text);
  }
  return d;
}
const plugins = (d) => detectLanguages(d).map((l) => l.plugin);

describe('LSP detection from manifests', () => {
  test('composer.json -> php-lsp', () => assert.deepEqual(plugins(folder('php', { 'composer.json': '{}' })), ['php-lsp']));
  test('package.json -> typescript-lsp', () => assert.deepEqual(plugins(folder('node', { 'package.json': '{}' })), ['typescript-lsp']));
  test('tsconfig.json alone -> typescript-lsp', () => assert.deepEqual(plugins(folder('ts', { 'tsconfig.json': '{}' })), ['typescript-lsp']));
  test('pyproject.toml -> pyright-lsp', () => assert.deepEqual(plugins(folder('py1', { 'pyproject.toml': '' })), ['pyright-lsp']));
  test('requirements.txt -> pyright-lsp', () => assert.deepEqual(plugins(folder('py2', { 'requirements.txt': '' })), ['pyright-lsp']));
  test('requirements-dev.txt -> pyright-lsp', () => assert.deepEqual(plugins(folder('py3', { 'requirements-dev.txt': '' })), ['pyright-lsp']));
  test('go.mod -> gopls-lsp', () => assert.deepEqual(plugins(folder('go', { 'go.mod': 'module x' })), ['gopls-lsp']));
  test('pom.xml -> jdtls-lsp', () => assert.deepEqual(plugins(folder('mvn', { 'pom.xml': '<project/>' })), ['jdtls-lsp']));
  test('build.gradle (Java) -> jdtls-lsp', () => assert.deepEqual(plugins(folder('gj', { 'build.gradle': "apply plugin: 'java'" })), ['jdtls-lsp']));
  test('build.gradle.kts -> kotlin-lsp', () => assert.deepEqual(plugins(folder('gk', { 'build.gradle.kts': '' })), ['kotlin-lsp']));
  test('build.gradle using Kotlin -> kotlin-lsp', () => assert.deepEqual(plugins(folder('gk2', { 'build.gradle': "apply plugin: 'kotlin-android'" })), ['kotlin-lsp']));
  test('pubspec.yaml -> no official plugin, Serena note', () => {
    const l = detectLanguages(folder('dart', { 'pubspec.yaml': 'name: x' }));
    assert.equal(l.length, 1);
    assert.equal(l[0].plugin, null);
    assert.match(l[0].note, /no official Dart LSP plugin; consider Serena/);
  });
  test('empty folder -> nothing', () => assert.deepEqual(detectLanguages(folder('empty', {})), []));
  test('missing folder -> nothing', () => assert.deepEqual(detectLanguages(path.join(T, 'nope')), []));
  test('several manifests -> several plugins', () => {
    assert.deepEqual(plugins(folder('multi', { 'composer.json': '{}', 'package.json': '{}', 'pubspec.yaml': '' })), ['php-lsp', 'typescript-lsp', null]);
  });
  test('manifest names are matched case-insensitively', () => assert.deepEqual(plugins(folder('case', { 'Composer.JSON': '{}' })), ['php-lsp']));
  test('only the folder itself is read, not subfolders', () => assert.deepEqual(plugins(folder('deep', { 'sub/composer.json': '{}' })), []));
  test('evidence lists the manifests found', () => assert.deepEqual(detectLanguages(folder('ev', { 'package.json': '{}', 'tsconfig.json': '{}' }))[0].evidence.sort(), ['package.json', 'tsconfig.json']));
  test('jvmPlugin prefers Kotlin when settings.gradle.kts exists', () => assert.equal(jvmPlugin(T, ['settings.gradle.kts', 'build.gradle']), 'kotlin-lsp'));
  test('install command uses the official marketplace', () => assert.equal(installCommand('php-lsp'), '/plugin install php-lsp@claude-plugins-official'));
});

describe('installed plugins and settings', () => {
  test('reads installed_plugins.json', () => {
    const h = folder('home1', { '.claude/plugins/installed_plugins.json': JSON.stringify({ version: 2, plugins: { 'php-lsp@claude-plugins-official': [] } }) });
    assert.ok(installedPlugins(h).has('php-lsp@claude-plugins-official'));
  });
  test('missing or broken file -> empty set', () => {
    assert.equal(installedPlugins(path.join(T, 'nohome')).size, 0);
    assert.equal(installedPlugins(folder('home2', { '.claude/plugins/installed_plugins.json': '{oops' })).size, 0);
  });
  test('CLAUDE_CODE_EFFORT_LEVEL set -> warning', () => assert.match(effortWarning({ CLAUDE_CODE_EFFORT_LEVEL: 'high' }), /overrides the effort of every tech-plugin command/));
  test('CLAUDE_CODE_EFFORT_LEVEL unset -> no warning', () => assert.equal(effortWarning({}), null));
});

const DOCTOR = path.join(PLUGIN, 'scripts', 'doctor.mjs');
function doctor(args, env = {}) {
  return spawnSync(process.execPath, [DOCTOR, ...args], { encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN, ...env }, timeout: 60000 });
}

describe('doctor script', () => {
  const proj = folder('proj', { 'composer.json': '{}', 'pubspec.yaml': '' });
  const home = folder('dhome', { '.claude/plugins/installed_plugins.json': '{"version":2,"plugins":{}}' });
  const full = doctor(['--dir', proj], { HOME: home, CLAUDE_CODE_EFFORT_LEVEL: '' });

  test('prints a table and exits 0', () => {
    assert.equal(full.status, 0, full.stderr);
    assert.match(full.stdout, /\| Check \| Status \| Details \/ fix \|/);
  });
  test('always says not to run graphify install', () => assert.match(full.stdout, /Don't run `graphify install`; tech-plugin reads the graph itself/));
  test('shows the LSP install command for PHP', () => assert.match(full.stdout, /\/plugin install php-lsp@claude-plugins-official/));
  test('shows the Serena note for Dart', () => assert.match(full.stdout, /no official Dart LSP plugin; consider Serena/));
  test('leaves the Zoho row for Claude to fill in', () => assert.match(full.stdout, /\| Zoho Sprints MCP \| ⚠️ ZOHO_STATUS \|/));
  test('lists the doctor command', () => assert.match(full.stdout, /`\/tech-plugin:doctor`/));
  test('guard self-test passes', () => assert.match(full.stdout, /Safety guard \| ✅ working/));
  test('no effort warning when unset', () => assert.match(full.stdout, /Effort setting \| ✅ not overridden/));

  test('warns when CLAUDE_CODE_EFFORT_LEVEL is set', () => {
    const r = doctor(['--dir', proj], { HOME: home, CLAUDE_CODE_EFFORT_LEVEL: 'max' });
    assert.match(r.stdout, /CLAUDE_CODE_EFFORT_LEVEL=max is set/);
  });
  test('graphify missing -> install command, needs Python + uv', () => {
    const r = doctor(['--dir', proj], { HOME: home, PATH: path.join(T, 'empty-bin') });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\| graphify \| ⚠️ not found \| Install: `uv tool install graphifyy` \(needs Python \+ uv\)\. Don't run `graphify install`/);
    assert.match(r.stdout, /\| uv \| ⚠️ not found/);
  });
  test('shows an installed LSP plugin as installed', () => {
    const h = folder('dhome2', { '.claude/plugins/installed_plugins.json': JSON.stringify({ version: 2, plugins: { 'php-lsp@claude-plugins-official': [] } }) });
    const r = doctor(['--dir', proj], { HOME: h });
    assert.match(r.stdout, /LSP: PHP \| ✅ php-lsp installed/);
  });
  test('no manifest -> says so', () => {
    const r = doctor(['--dir', folder('bare', {})], { HOME: home });
    assert.match(r.stdout, /LSP plugins \| ⚠️ no manifest found here/);
  });
  test('--ci outside a git repo: says where to run it, writes nothing', () => {
    const dir = folder('ci-norepo', {});
    const r = doctor(['--ci', '--dir', dir]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /run it inside the git repo whose pull requests should be checked/);
    assert.doesNotMatch(r.stdout, /\| Check \|/);
    assert.ok(!fs.existsSync(path.join(dir, 'sdlc-docs')));
  });
  test('doctor never runs an install (no install verbs executed)', () => {
    const src = fs.readFileSync(DOCTOR, 'utf8');
    const spawned = [...src.matchAll(/version\('([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(spawned.sort(), ['claude', 'git', 'graphify', 'k6', 'maestro', 'uv'].sort());
    assert.match(src, /version\('k6', \['version'\]\)/, 'k6 is only asked for its version');
  });
});

describe('session banner', () => {
  const BANNER = path.join(PLUGIN, 'scripts', 'banner.mjs');
  const banner = (input, env = {}) => spawnSync(process.execPath, [BANNER], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN, CLAUDE_PROJECT_DIR: '', ...env } });
  const repo = folder('brepo', { 'sdlc-docs/README.md': '#' });
  fs.mkdirSync(path.join(repo, '.git'));
  const norepo = folder('bnorepo', {});

  test('repo with sdlc-docs', () => {
    const r = banner(JSON.stringify({ cwd: path.join(repo, 'sdlc-docs') }));
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(r.stdout), { systemMessage: `tech-plugin v${VERSION} | repo brepo | sdlc-docs: found | guard on | next: /tech-plugin:next` });
  });
  test('no repo, no sdlc-docs', () => {
    const r = banner(JSON.stringify({ cwd: norepo }));
    assert.equal(JSON.parse(r.stdout).systemMessage, `tech-plugin v${VERSION} | repo none | sdlc-docs: not set up | guard on | next: /tech-plugin:next`);
  });
  test('broken input still prints a line and exits 0', () => {
    const r = banner('{not json');
    assert.equal(r.status, 0);
    assert.match(JSON.parse(r.stdout).systemMessage, new RegExp(`^tech-plugin v${V} \\| repo .* \\| guard on \\| next: /tech-plugin:next$`));
  });
  test('missing plugin.json still prints a line', () => {
    const r = banner('{}', { CLAUDE_PLUGIN_ROOT: path.join(T, 'nowhere') });
    assert.equal(r.status, 0);
    assert.match(JSON.parse(r.stdout).systemMessage, /^tech-plugin v\? \|/);
  });
  test('broken config.json is mentioned', () => {
    const b = folder('bbad', { 'sdlc-docs/config.json': '{x' });
    fs.mkdirSync(path.join(b, '.git'));
    const r = banner(JSON.stringify({ cwd: b }));
    assert.match(JSON.parse(r.stdout).systemMessage, /config\.json is broken/);
  });
});
