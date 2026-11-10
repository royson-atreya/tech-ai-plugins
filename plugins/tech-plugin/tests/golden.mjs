// Golden fixtures for the breakdown tests, built in the OS temp folder:
//   1. "nadi" workspace: Laravel API backend, Laravel + Blade web dashboard, Flutter mobile app
//   2. "shop": a Node monorepo (Turborepo): Next.js web + Express/Prisma API
//   3. "pyapp": a FastAPI service with Alembic and pytest
//   4. "blank": an empty git repo, and "newfolder": an empty plain folder
// Each repo holds fake secret files whose contents are a marker string, so a
// test can prove the scripts never read them. Repos get `git init` and
// `git add` (no commits); a fake commit id is written straight to the ref.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const SECRET_MARKER = 'SECRET-MARKER-7f3a';

function put(file, text = 'x\n') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function gitRepo(dir, branch, { add = true, commit = null } = {}) {
  const r = spawnSync('git', ['init', '-q', '-b', branch, dir], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  if (add) spawnSync('git', ['-C', dir, 'add', '-A'], { encoding: 'utf8' });
  if (commit) put(path.join(dir, '.git/refs/heads', branch), commit + '\n');
}

export function setCommit(dir, branch, commit) {
  put(path.join(dir, '.git/refs/heads', branch), commit + '\n');
}

const S = SECRET_MARKER;

function laravel(dir, { blade = 1, extraRequire = {} } = {}) {
  put(path.join(dir, 'composer.json'), JSON.stringify({
    name: 'acme/app',
    require: { php: '^8.1', 'laravel/framework': '^10.10', 'laravel/sanctum': '^3.2', 'razorpay/razorpay': '^2.8', 'kreait/laravel-firebase': '^5.0', ...extraRequire },
    'require-dev': { 'phpunit/phpunit': '^10.1' },
    scripts: { 'post-autoload-dump': ['@php artisan package:discover'], test: 'php artisan test' },
  }, null, 4));
  put(path.join(dir, 'package.json'), JSON.stringify({ private: true, scripts: { dev: 'vite', build: 'vite build' }, devDependencies: { vite: '^4.0.0', axios: '^1.1.2' } }, null, 2));
  put(path.join(dir, 'artisan'), '#!/usr/bin/env php\n<?php\n');
  put(path.join(dir, 'public/index.php'), '<?php\n');
  put(path.join(dir, 'routes/web.php'), "<?php\nRoute::get('/', fn () => view('welcome'));\n");
  put(path.join(dir, 'routes/api.php'), "<?php\nRoute::post('/patients', [PatientController::class, 'store']);\n");
  put(path.join(dir, 'app/Http/Controllers/PatientController.php'), '<?php\nclass PatientController {}\n');
  put(path.join(dir, 'app/Models/Patient.php'), '<?php\nclass Patient {}\n');
  for (let i = 1; i <= 3; i++) put(path.join(dir, `database/migrations/2024_01_0${i}_000000_create_t${i}_table.php`), '<?php\n');
  for (let i = 0; i < blade; i++) put(path.join(dir, `resources/views/page${i}.blade.php`), '<div></div>\n');
  put(path.join(dir, 'phpunit.xml'), '<phpunit/>\n');
  put(path.join(dir, 'tests/Feature/ExampleTest.php'), '<?php\n');
  put(path.join(dir, '.env'), `APP_KEY=${S}\nDB_PASSWORD=${S}\n`);
  put(path.join(dir, '.env.example'), 'APP_NAME=Laravel\nAPP_ENV=local\nAPP_KEY=\nDB_CONNECTION=mysql\nDB_PASSWORD=\nRAZORPAY_KEY=\n');
  put(path.join(dir, 'storage/oauth-private.pem'), S);
}

export function buildGolden() {
  const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tp-golden-')));

  // 1. nadi workspace
  const nadi = path.join(W, 'nadi');
  const backend = path.join(nadi, 'backend');
  laravel(backend);
  put(path.join(backend, '.github/workflows/ci.yml'), 'on: push\n');
  put(path.join(backend, 'Dockerfile'), 'FROM php:8.2\n');
  put(path.join(backend, 'docker-compose.yml'), 'services:\n  app:\n    build: .\n  mysql:\n    image: mysql:8\n  redis:\n    image: redis\nvolumes:\n  db:\n');
  put(path.join(backend, 'Makefile'), 'test:\n\tphp artisan test\ndeploy:\n\t./deploy.sh\n');
  gitRepo(backend, 'main', { commit: 'a'.repeat(40) });

  const web = path.join(nadi, 'web');
  laravel(web, { blade: 12, extraRequire: { 'livewire/livewire': '^3.0' } });
  gitRepo(web, 'main', { commit: 'b'.repeat(40) });

  const mobile = path.join(nadi, 'mobile');
  put(path.join(mobile, 'pubspec.yaml'), [
    'name: nadi_app', 'description: Patient app', 'version: 1.2.0+12', '', 'environment:', '  sdk: ">=3.0.0 <4.0.0"', '', 'dependencies:',
    '  flutter:', '    sdk: flutter', '  dio: ^5.3.0', '  provider: ^6.0.5', '  firebase_core: ^2.15.0', '  razorpay_flutter: ^1.3.5', '  shared_preferences: ^2.2.0', '',
    'dev_dependencies:', '  flutter_test:', '    sdk: flutter', '  flutter_lints: ^2.0.0', '', 'flutter:', '  uses-material-design: true', '',
  ].join('\n'));
  put(path.join(mobile, 'lib/main.dart'), 'void main() {}\n');
  put(path.join(mobile, 'lib/main_staging.dart'), 'void main() {}\n');
  put(path.join(mobile, 'lib/screens/login_screen.dart'), 'class LoginScreen {}\n');
  put(path.join(mobile, 'android/app/build.gradle'), "apply plugin: 'com.android.application'\napply plugin: 'kotlin-android'\n");
  put(path.join(mobile, 'android/build.gradle'), 'buildscript {}\n');
  put(path.join(mobile, 'android/settings.gradle'), "include ':app'\n");
  put(path.join(mobile, 'android/app/google-services.json'), S);
  put(path.join(mobile, 'ios/Runner/GoogleService-Info.plist'), S);
  put(path.join(mobile, 'ios/Runner.xcodeproj/project.pbxproj'), 'x\n');
  put(path.join(mobile, 'test/widget_test.dart'), 'void main() {}\n');
  put(path.join(mobile, 'codemagic.yaml'), 'workflows: {}\n');
  put(path.join(mobile, 'android/app/upload.jks'), S);
  gitRepo(mobile, 'develop', { commit: 'c'.repeat(40) });

  // 2. shop monorepo
  const shop = path.join(W, 'shop');
  put(path.join(shop, 'package.json'), JSON.stringify({ name: 'shop', private: true, workspaces: ['apps/*'], scripts: { build: 'turbo run build', test: 'turbo run test' }, devDependencies: { turbo: '^1.10.0', typescript: '^5.2.0' } }, null, 2));
  put(path.join(shop, 'turbo.json'), '{}\n');
  put(path.join(shop, 'package-lock.json'), '{}\n');
  put(path.join(shop, 'apps/web/package.json'), JSON.stringify({ name: 'web', scripts: { dev: 'next dev', build: 'next build', start: 'next start', test: 'playwright test' }, dependencies: { next: '14.0.3', react: '18.2.0', 'react-dom': '18.2.0', '@stripe/stripe-js': '^2.1.0' }, devDependencies: { '@playwright/test': '^1.40.0', typescript: '^5.2.0' } }, null, 2));
  put(path.join(shop, 'apps/web/tsconfig.json'), '{}\n');
  put(path.join(shop, 'apps/web/app/page.tsx'), 'export default function Page() { return null }\n');
  put(path.join(shop, 'apps/web/playwright.config.ts'), 'export default {}\n');
  put(path.join(shop, 'apps/web/.env.local'), `NEXT_PUBLIC_KEY=${S}\n`);
  put(path.join(shop, 'apps/api/package.json'), JSON.stringify({ name: 'api', main: 'src/index.ts', scripts: { dev: 'ts-node src/index.ts', build: 'tsc', test: 'jest' }, dependencies: { express: '^4.18.2', '@prisma/client': '^5.6.0', stripe: '^14.0.0' }, devDependencies: { jest: '^29.7.0', prisma: '^5.6.0', typescript: '^5.2.0' } }, null, 2));
  put(path.join(shop, 'apps/api/src/index.ts'), 'import express from "express"\n');
  put(path.join(shop, 'apps/api/prisma/schema.prisma'), 'model User { id Int @id }\n');
  put(path.join(shop, 'apps/api/jest.config.js'), 'module.exports = {}\n');
  put(path.join(shop, 'apps/api/.env'), `DATABASE_URL=${S}\n`);
  put(path.join(shop, 'node_modules/left-pad/package.json'), '{"name":"left-pad"}\n');
  put(path.join(shop, '.github/workflows/ci.yml'), 'on: push\n');
  gitRepo(shop, 'main', { commit: 'd'.repeat(40) });

  // 3. python FastAPI app
  const py = path.join(W, 'pyapp');
  put(path.join(py, 'pyproject.toml'), '[project]\nname = "pyapp"\ndependencies = [\n  "fastapi>=0.104.0",\n  "sqlalchemy>=2.0",\n  "alembic>=1.12",\n  "uvicorn[standard]>=0.24",\n  "boto3>=1.28",\n]\n\n[project.optional-dependencies]\ndev = ["pytest>=7.4"]\n');
  put(path.join(py, 'requirements-dev.txt'), 'pytest==7.4.3\nhttpx==0.25.0\n');
  put(path.join(py, 'app/__init__.py'), '');
  put(path.join(py, 'app/main.py'), 'from fastapi import FastAPI\n\napi = FastAPI(title="pyapp")\n');
  put(path.join(py, 'alembic/versions/001_init.py'), '# init\n');
  put(path.join(py, 'alembic/versions/002_users.py'), '# users\n');
  put(path.join(py, 'tests/test_main.py'), 'def test_x(): pass\n');
  put(path.join(py, '.env'), `SECRET=${S}\n`);
  put(path.join(py, '.env.example'), 'SECRET=\nAPP_ENV=dev\n');
  gitRepo(py, 'main', { commit: 'e'.repeat(40) });

  // 4. empty repo and empty folder
  const blank = path.join(W, 'blank');
  fs.mkdirSync(blank);
  gitRepo(blank, 'main', { add: false });
  const newfolder = path.join(W, 'newfolder');
  fs.mkdirSync(newfolder);

  return { W, nadi, backend, web, mobile, shop, py, blank, newfolder };
}
