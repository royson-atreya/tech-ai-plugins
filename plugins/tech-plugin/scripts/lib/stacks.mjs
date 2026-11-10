// Stack detection: reads a repo's manifests, lock files, CI and Docker files,
// migrations and test configs, and returns facts in one common format. Every
// fact cites the file (and line, where there is one) it came from.
//
// It never opens a secret file (same name rules as the guard), never follows a
// symlink out of the repo, and never runs anything except read-only git
// (ls-files, rev-parse via HEAD files, remote URL).
//
// Fact classes: Verified = read directly from a file; Inferred = a convention
// for the detected stack (for example "php artisan test"), not seen in a file.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Folders that hold dependencies, build output or tool caches: never app roots,
// never counted. sdlc-docs is ours.
export const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'vendor', 'pods', '.venv', 'venv', '__pycache__', '.gradle', '.dart_tool', '.pub-cache',
  'build', 'dist', 'out', 'target', '.next', '.nuxt', '.svelte-kit', 'coverage', '.idea', '.vscode', 'storage',
  '.terraform', 'obj', '.expo', 'sdlc-docs', 'graphify-out', '.cache', '.turbo', 'bower_components', 'jspm_packages',
]);

// ------------------------------------------------------------------ safe reading

export function makeReader(repo, isSecret) {
  const realRepo = fs.realpathSync(repo);
  const safe = (rel) => {
    if (isSecret(rel)) return null;
    const p = path.join(repo, rel);
    let real;
    try {
      real = fs.realpathSync(p);
    } catch {
      return null;
    }
    if (isSecret(real)) return null;
    if (real !== realRepo && !real.startsWith(realRepo + path.sep)) return null; // symlink out of the repo
    return p;
  };
  return {
    repo,
    isSecret,
    text(rel, max = 512 * 1024) {
      const p = safe(rel);
      if (!p) return null;
      try {
        const st = fs.statSync(p);
        if (!st.isFile() || st.size > max) return null;
        return fs.readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    },
    json(rel) {
      const t = this.text(rel);
      if (t === null) return null;
      try {
        return { data: JSON.parse(t), text: t };
      } catch {
        return { data: null, text: t, error: 'not valid JSON' };
      }
    },
    exists(rel) {
      return !isSecret(rel) && fs.existsSync(path.join(repo, rel));
    },
    isDir(rel) {
      try {
        return fs.statSync(path.join(repo, rel)).isDirectory();
      } catch {
        return false;
      }
    },
    list(rel) {
      try {
        return fs.readdirSync(path.join(repo, rel), { withFileTypes: true });
      } catch {
        return [];
      }
    },
  };
}

const J = (...p) => path.posix.join(...p.filter((x) => x && x !== '.')) || '.';

export function lineOf(text, needle) {
  if (text == null) return null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (needle instanceof RegExp ? needle.test(lines[i]) : lines[i].includes(needle)) return i + 1;
  }
  return null;
}

const cite = (file, line) => (line ? `${file}:${line}` : file);

// Files below `rel` (relative paths), skipping dependency folders. Capped.
function walkFiles(reader, rel, { maxDepth = 6, max = 5000, match = () => true } = {}) {
  const out = [];
  const stack = [[rel, 0]];
  while (stack.length && out.length < max) {
    const [d, depth] = stack.pop();
    for (const e of reader.list(d)) {
      const r = J(d, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIRS.has(e.name.toLowerCase())) stack.push([r, depth + 1]);
      } else if (e.isFile() && !reader.isSecret(e.name) && match(e.name, r)) {
        out.push(r);
        if (out.length >= max) break;
      }
    }
  }
  return out.sort();
}

// ------------------------------------------------------------------ git (read-only)

export function gitInfo(repo) {
  const out = { isGit: false, branch: null, commit: null, remote: null };
  const g = path.join(repo, '.git');
  let gd = null;
  try {
    const st = fs.statSync(g);
    out.isGit = true;
    if (st.isDirectory()) gd = g;
    else {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(g, 'utf8'));
      if (m) gd = path.resolve(repo, m[1]);
    }
  } catch {
    return out;
  }
  if (!gd) return out;
  try {
    const head = fs.readFileSync(path.join(gd, 'HEAD'), 'utf8').trim();
    const m = /^ref:\s*(refs\/heads\/(.+))$/.exec(head);
    if (!m) out.commit = /^[0-9a-f]{40,64}$/.test(head) ? head : null;
    else {
      out.branch = m[2];
      out.commit = readRef(gd, m[1]);
    }
  } catch {
    /* unreadable */
  }
  try {
    const cfg = fs.readFileSync(path.join(gd, 'config'), 'utf8');
    const m = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(cfg);
    if (m) out.remote = redactUrl(m[1]);
  } catch {
    /* no config */
  }
  return out;
}

function readRef(gd, ref) {
  try {
    return fs.readFileSync(path.join(gd, ref), 'utf8').trim();
  } catch {
    /* maybe packed */
  }
  try {
    const packed = fs.readFileSync(path.join(gd, 'packed-refs'), 'utf8');
    const line = packed.split('\n').find((l) => l.endsWith(' ' + ref));
    return line ? line.split(' ')[0] : null;
  } catch {
    return null;
  }
}

// https://user:token@host/x -> https://host/x
export function redactUrl(u) {
  return String(u).replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i, '$1');
}

// Tracked files (names only). Falls back to a capped walk outside git.
function trackedFiles(repo, reader) {
  const r = spawnSync('git', ['-C', repo, 'ls-files', '-z'], { encoding: 'utf8', timeout: 8000, maxBuffer: 64 * 1024 * 1024 });
  if (!r.error && r.status === 0) return { files: r.stdout.split('\0').filter(Boolean), source: 'git ls-files' };
  return { files: walkFiles(reader, '.', { maxDepth: 12, max: 50000 }), source: 'folder walk' };
}

// ------------------------------------------------------------------ languages

const EXT_LANG = {
  php: 'PHP', dart: 'Dart', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', ts: 'TypeScript',
  tsx: 'TypeScript', vue: 'Vue', svelte: 'Svelte', py: 'Python', go: 'Go', java: 'Java', kt: 'Kotlin', kts: 'Kotlin',
  swift: 'Swift', rb: 'Ruby', cs: 'C#', rs: 'Rust', c: 'C', h: 'C/C++ header', cpp: 'C++', cc: 'C++', m: 'Objective-C',
  mm: 'Objective-C', html: 'HTML', css: 'CSS', scss: 'SCSS', sql: 'SQL', sh: 'Shell',
};

function languages(files) {
  const counts = {};
  for (const f of files) {
    if (f.split('/').some((s) => SKIP_DIRS.has(s.toLowerCase()))) continue;
    const b = f.split('/').pop().toLowerCase();
    const lang = b.endsWith('.blade.php') ? 'Blade' : EXT_LANG[b.includes('.') ? b.slice(b.lastIndexOf('.') + 1) : ''];
    if (lang) counts[lang] = (counts[lang] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([name, files]) => ({ name, files }));
}

// ------------------------------------------------------------------ app roots

const MANIFEST_NAMES = ['composer.json', 'package.json', 'pubspec.yaml', 'pyproject.toml', 'requirements.txt', 'setup.py', 'pipfile', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'gemfile', 'manage.py', 'cargo.toml'];
const isManifest = (name) => {
  const n = name.toLowerCase();
  return MANIFEST_NAMES.includes(n) || /^requirements[-_.].*\.txt$/.test(n) || n.endsWith('.csproj');
};

// Folders (relative, '.' for the root) that are separate apps.
export function findApps(reader) {
  const cands = [];
  const stack = [['.', 0]];
  while (stack.length) {
    const [d, depth] = stack.pop();
    const ents = reader.list(d);
    const manifests = ents.filter((e) => e.isFile() && isManifest(e.name)).map((e) => e.name);
    const xcode = ents.some((e) => e.isDirectory() && e.name.endsWith('.xcodeproj'));
    if (manifests.length || xcode) cands.push({ root: d, manifests: manifests.sort(), xcode });
    if (depth < 3) {
      for (const e of ents) {
        if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name.toLowerCase()) && !e.name.endsWith('.xcodeproj')) {
          stack.push([J(d, e.name), depth + 1]);
        }
      }
    }
  }
  cands.sort((a, b) => a.root.split('/').length - b.root.split('/').length || a.root.localeCompare(b.root));
  const excluded = [];
  const apps = [];
  for (const c of cands) {
    if (excluded.some((x) => c.root === x || c.root.startsWith(x + '/'))) continue;
    apps.push(c);
    const pub = c.manifests.includes('pubspec.yaml') ? reader.text(J(c.root, 'pubspec.yaml')) : null;
    if (pub && /sdk:\s*flutter/.test(pub)) {
      // a Flutter app owns its platform folders
      for (const sub of ['android', 'ios', 'web', 'macos', 'linux', 'windows']) excluded.push(J(c.root, sub));
    }
    if (c.manifests.some((m) => /^build\.gradle/.test(m)) && (reader.exists(J(c.root, 'settings.gradle')) || reader.exists(J(c.root, 'settings.gradle.kts')))) {
      // a Gradle build owns its sub-projects
      excluded.push(...cands.filter((x) => x.root !== c.root && x.root.startsWith(J(c.root) === '.' ? '' : J(c.root) + '/') && x.manifests.every((m) => /^build\.gradle/.test(m))).map((x) => x.root));
    }
    if (c.xcode && !c.manifests.length) excluded.push(...cands.filter((x) => x.root.startsWith(J(c.root, '')) && x !== c).map((x) => x.root));
  }
  return apps;
}

// ------------------------------------------------------------------ dependency tables

// [package, display name, kind]   kind: backend | web | mobile | desktop | tool | db | test | service | auth | state | http | lang
const JS = [
  ['next', 'Next.js', 'web'], ['nuxt', 'Nuxt', 'web'], ['@angular/core', 'Angular', 'web'], ['@sveltejs/kit', 'SvelteKit', 'web'],
  ['svelte', 'Svelte', 'web'], ['vue', 'Vue', 'web'], ['@remix-run/react', 'Remix', 'web'], ['react-native', 'React Native', 'mobile'],
  ['expo', 'Expo', 'mobile'], ['react', 'React', 'web'], ['@nestjs/core', 'NestJS', 'backend'], ['express', 'Express', 'backend'],
  ['fastify', 'Fastify', 'backend'], ['koa', 'Koa', 'backend'], ['@hapi/hapi', 'hapi', 'backend'], ['electron', 'Electron', 'desktop'],
  ['vite', 'Vite', 'tool'], ['typescript', 'TypeScript', 'lang'], ['prisma', 'Prisma', 'db'], ['@prisma/client', 'Prisma', 'db'],
  ['mongoose', 'MongoDB (Mongoose)', 'db'], ['sequelize', 'Sequelize', 'db'], ['typeorm', 'TypeORM', 'db'], ['knex', 'Knex', 'db'],
  ['drizzle-orm', 'Drizzle', 'db'], ['pg', 'PostgreSQL client', 'db'], ['mysql2', 'MySQL client', 'db'], ['jest', 'Jest', 'test'],
  ['vitest', 'Vitest', 'test'], ['mocha', 'Mocha', 'test'], ['@playwright/test', 'Playwright', 'test'], ['cypress', 'Cypress', 'test'],
  ['karma', 'Karma', 'test'], ['axios', 'axios', 'http'], ['redux', 'Redux', 'state'], ['@reduxjs/toolkit', 'Redux Toolkit', 'state'],
  ['zustand', 'Zustand', 'state'], ['pinia', 'Pinia', 'state'], ['next-auth', 'NextAuth', 'auth'], ['passport', 'Passport', 'auth'],
  ['jsonwebtoken', 'JWT', 'auth'],
];
const PHP = [
  ['laravel/framework', 'Laravel', 'backend'], ['laravel/lumen-framework', 'Lumen', 'backend'], ['symfony/framework-bundle', 'Symfony', 'backend'],
  ['codeigniter4/framework', 'CodeIgniter', 'backend'], ['slim/slim', 'Slim', 'backend'], ['cakephp/cakephp', 'CakePHP', 'backend'],
  ['yiisoft/yii2', 'Yii', 'backend'], ['livewire/livewire', 'Livewire', 'web'], ['inertiajs/inertia-laravel', 'Inertia', 'web'],
  ['laravel/sanctum', 'Laravel Sanctum', 'auth'], ['laravel/passport', 'Laravel Passport', 'auth'], ['tymon/jwt-auth', 'JWT (tymon)', 'auth'],
  ['spatie/laravel-permission', 'spatie/laravel-permission', 'auth'], ['phpunit/phpunit', 'PHPUnit', 'test'], ['pestphp/pest', 'Pest', 'test'],
  ['doctrine/orm', 'Doctrine', 'db'],
];
const DART = [
  ['dio', 'Dio', 'http'], ['http', 'http', 'http'], ['provider', 'Provider', 'state'], ['flutter_bloc', 'BLoC', 'state'],
  ['bloc', 'BLoC', 'state'], ['flutter_riverpod', 'Riverpod', 'state'], ['riverpod', 'Riverpod', 'state'], ['get', 'GetX', 'state'],
  ['mobx', 'MobX', 'state'], ['go_router', 'go_router', 'tool'], ['auto_route', 'auto_route', 'tool'], ['sqflite', 'sqflite', 'db'],
  ['drift', 'Drift', 'db'], ['hive', 'Hive', 'db'], ['isar', 'Isar', 'db'], ['shared_preferences', 'shared_preferences', 'db'],
  ['integration_test', 'integration_test', 'test'], ['mockito', 'mockito', 'test'],
];
const PY = [
  ['django', 'Django', 'backend'], ['fastapi', 'FastAPI', 'backend'], ['flask', 'Flask', 'backend'], ['starlette', 'Starlette', 'backend'],
  ['tornado', 'Tornado', 'backend'], ['aiohttp', 'aiohttp', 'backend'], ['djangorestframework', 'Django REST framework', 'backend'],
  ['sqlalchemy', 'SQLAlchemy', 'db'], ['alembic', 'Alembic', 'db'], ['psycopg2', 'PostgreSQL client', 'db'], ['psycopg', 'PostgreSQL client', 'db'],
  ['pymysql', 'MySQL client', 'db'], ['mysqlclient', 'MySQL client', 'db'], ['pymongo', 'MongoDB client', 'db'], ['celery', 'Celery', 'tool'],
  ['pytest', 'pytest', 'test'], ['uvicorn', 'Uvicorn', 'tool'], ['gunicorn', 'Gunicorn', 'tool'], ['pydantic', 'Pydantic', 'tool'],
];
const GO = [
  ['github.com/gin-gonic/gin', 'Gin', 'backend'], ['github.com/labstack/echo', 'Echo', 'backend'], ['github.com/gofiber/fiber', 'Fiber', 'backend'],
  ['github.com/gorilla/mux', 'gorilla/mux', 'backend'], ['github.com/go-chi/chi', 'chi', 'backend'], ['gorm.io/gorm', 'GORM', 'db'],
];
const JVM = [
  ['spring-boot', 'Spring Boot', 'backend'], ['com.android.application', 'Android app', 'mobile'], ['com.android.library', 'Android library', 'tool'],
  ['org.jetbrains.kotlin', 'Kotlin', 'lang'], ['kotlin-android', 'Kotlin', 'lang'], ['junit', 'JUnit', 'test'], ['hibernate', 'Hibernate', 'db'],
  ['flyway', 'Flyway', 'db'], ['liquibase', 'Liquibase', 'db'],
];
const RUBY = [['rails', 'Rails', 'backend'], ['sinatra', 'Sinatra', 'backend'], ['rspec-rails', 'RSpec', 'test'], ['rspec', 'RSpec', 'test'], ['sidekiq', 'Sidekiq', 'tool'], ['pg', 'PostgreSQL client', 'db']];
const RUST = [['actix-web', 'Actix Web', 'backend'], ['axum', 'Axum', 'backend'], ['rocket', 'Rocket', 'backend'], ['diesel', 'Diesel', 'db'], ['sqlx', 'SQLx', 'db']];

// External services, matched against every dependency name.
const SERVICES = [
  [/razorpay/i, 'Razorpay'], [/stripe/i, 'Stripe'], [/paypal/i, 'PayPal'], [/twilio/i, 'Twilio'], [/^(firebase|@firebase\/|firebase[-_]|kreait\/)/i, 'Firebase'],
  [/(aws-sdk|@aws-sdk\/|^boto3$|^aws\/aws-sdk-php)/i, 'AWS'], [/sentry/i, 'Sentry'], [/pusher/i, 'Pusher'], [/onesignal/i, 'OneSignal'],
  [/sendgrid/i, 'SendGrid'], [/mailgun/i, 'Mailgun'], [/(google_maps|googlemaps|@googlemaps)/i, 'Google Maps'], [/agora/i, 'Agora'],
  [/socket\.io/i, 'Socket.IO'], [/(^redis$|predis|ioredis|^redis-py$)/i, 'Redis'], [/elasticsearch/i, 'Elasticsearch'], [/algolia/i, 'Algolia'],
  [/^openai$/i, 'OpenAI'], [/^@?anthropic/i, 'Anthropic'], [/(zoho)/i, 'Zoho'], [/(msg91|textlocal|fast2sms)/i, 'SMS gateway'], [/(paytm|phonepe|cashfree|ccavenue)/i, 'Payment gateway'],
];

function depFacts(table, deps, file, text, kindFilter = null) {
  const out = [];
  for (const [pkg, name, kind] of table) {
    if (kindFilter && !kindFilter.includes(kind)) continue;
    const hit = deps.find((d) => d.name.toLowerCase() === pkg.toLowerCase() || (pkg.includes('.') && d.name.toLowerCase().startsWith(pkg.toLowerCase())));
    if (!hit) continue;
    if (out.some((f) => f.name === name)) continue;
    out.push({ name, kind, version: hit.version || null, evidence: cite(file, hit.line || lineOf(text, pkg)), class: 'Verified' });
  }
  return out;
}

// ------------------------------------------------------------------ per-ecosystem readers

function jsDeps(pkgJson, text) {
  const deps = [];
  for (const sec of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, version] of Object.entries((pkgJson && pkgJson[sec]) || {})) {
      deps.push({ name, version: String(version), line: lineOf(text, `"${name}"`), dev: sec === 'devDependencies' });
    }
  }
  return deps;
}

function textDeps(text, names, file) {
  // names: package names to look for in a text manifest (requirements, pyproject, go.mod, gradle...)
  const deps = [];
  if (!text) return deps;
  for (const n of names) {
    const esc = n.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    const re = new RegExp(`(^|["'\\s:(=,/])${esc}(["'\\s<>=~!\\[;:,)/@]|$)`, 'im');
    const line = lineOf(text, re);
    if (line) {
      const lineText = text.split('\n')[line - 1];
      const v = /(?:==|>=|~=|\^|~|\s|:|@)\s*v?(\d+(?:\.\d+){0,2})/.exec(lineText.slice(lineText.toLowerCase().indexOf(n.toLowerCase()) + n.length));
      deps.push({ name: n, version: v ? v[1] : null, line, file });
    }
  }
  return deps;
}

function pubspecDeps(text) {
  const deps = [];
  if (!text) return deps;
  const lines = text.split('\n');
  let sec = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const top = /^([A-Za-z_]+):\s*$/.exec(l);
    if (top) {
      sec = ['dependencies', 'dev_dependencies'].includes(top[1]) ? top[1] : null;
      continue;
    }
    if (/^\S/.test(l)) {
      sec = null;
      continue;
    }
    if (!sec) continue;
    const m = /^ {2}([A-Za-z0-9_]+):\s*(.*)$/.exec(l);
    if (m) deps.push({ name: m[1], version: m[2].replace(/["']/g, '').trim() || null, line: i + 1, dev: sec === 'dev_dependencies' });
  }
  return deps;
}

function scriptsToCommands(scripts, runner, file, text) {
  const out = [];
  for (const [name, body] of Object.entries(scripts || {})) {
    const kind = /^(test|tests|e2e|test:.*|.*:test|coverage)$/.test(name) ? 'test'
      : /^(build|build:.*|compile|prod|production)$/.test(name) ? 'build'
        : /^(dev|start|serve|watch|develop|start:.*|dev:.*)$/.test(name) ? 'run'
          : /^(lint|lint:.*|format|typecheck|type-check|check)$/.test(name) ? 'check' : 'other';
    const cmd = runner === 'composer' ? `composer ${name}` : runner === 'npm' ? (name === 'test' || name === 'start' ? `npm ${name}` : `npm run ${name}`) : `${runner} ${name}`;
    out.push({ kind, cmd, runs: String(body).slice(0, 120), source: cite(file, lineOf(text, `"${name}"`)), class: 'Verified', status: 'found, not run' });
  }
  return out;
}

const conv = (kind, cmd, why) => ({ kind, cmd, runs: null, source: why, class: 'Inferred', status: 'found, not run' });

function makeTargets(reader, root) {
  const file = J(root, 'Makefile');
  const t = reader.text(file);
  if (!t) return [];
  const out = [];
  t.split('\n').forEach((l, i) => {
    const m = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?!=)/.exec(l);
    if (m && !out.some((o) => o.cmd === `make ${m[1]}`) && m[1] !== 'PHONY') {
      const n = m[1];
      const kind = /test/.test(n) ? 'test' : /build|compile/.test(n) ? 'build' : /run|serve|start|dev/.test(n) ? 'run' : /lint|check|fmt|format/.test(n) ? 'check' : 'other';
      out.push({ kind, cmd: `make ${n}`, runs: null, source: cite(file, i + 1), class: 'Verified', status: 'found, not run' });
    }
  });
  return out.slice(0, 30);
}

function countFiles(reader, rel, re, maxDepth = 6) {
  if (!reader.isDir(rel)) return 0;
  return walkFiles(reader, rel, { maxDepth, max: 20000, match: (n) => re.test(n) }).length;
}

function firstExisting(reader, root, rels) {
  return rels.map((r) => J(root, r)).filter((r) => reader.exists(r));
}

// Finds `pattern` in small source files below root; returns { file, line }.
function findInSources(reader, root, nameRe, pattern, maxFiles = 300) {
  const files = walkFiles(reader, root, { maxDepth: 4, max: maxFiles, match: (n) => nameRe.test(n) });
  for (const f of files) {
    const t = reader.text(f, 200 * 1024);
    const line = lineOf(t, pattern);
    if (line) return { file: f, line, text: t.split('\n')[line - 1] };
  }
  return null;
}

// ------------------------------------------------------------------ one app

export function analyzeApp(reader, cand, repoName, appCount) {
  const root = cand.root;
  const app = {
    id: root === '.' ? repoName : `${repoName}/${root}`,
    root,
    kind: 'unknown',
    language: null,
    stack: [],
    entryPoints: [],
    routes: [],
    commands: [],
    tests: [],
    database: [],
    services: [],
    envVars: null,
    platforms: [],
    notes: [],
  };
  const has = (m) => cand.manifests.map((x) => x.toLowerCase()).includes(m);
  const ep = (p, why) => {
    if (!app.entryPoints.some((e) => e.path === p)) app.entryPoints.push({ path: p, why, class: 'Verified' });
  };
  let allDeps = [];

  // --- PHP
  if (has('composer.json')) {
    const f = J(root, 'composer.json');
    const c = reader.json(f);
    if (c && c.data) {
      const deps = [];
      for (const sec of ['require', 'require-dev']) for (const [name, version] of Object.entries(c.data[sec] || {})) deps.push({ name, version, line: lineOf(c.text, `"${name}"`) });
      allDeps = allDeps.concat(deps.map((d) => ({ ...d, file: f })));
      app.stack.push(...depFacts(PHP, deps, f, c.text));
      app.language = app.language || 'PHP';
      app.commands.push(...scriptsToCommands(Object.fromEntries(Object.entries(c.data.scripts || {}).filter(([k]) => !/^(post|pre)-/.test(k))), 'composer', f, c.text));
      if (app.stack.some((s) => s.name === 'Laravel')) {
        for (const p of firstExisting(reader, root, ['artisan', 'public/index.php'])) ep(p, p.endsWith('artisan') ? 'Laravel console' : 'Laravel front controller');
        const routeFiles = reader.list(J(root, 'routes')).filter((e) => e.isFile() && e.name.endsWith('.php')).map((e) => J(root, 'routes', e.name)).sort();
        app.routes.push(...routeFiles.map((p) => ({ path: p, class: 'Verified' })));
        const blade = countFiles(reader, J(root, 'resources/views'), /\.blade\.php$/i);
        if (blade) app.stack.push({ name: 'Blade', kind: blade >= 5 ? 'web' : 'tool', version: null, evidence: `${J(root, 'resources/views')} (${blade} templates)`, class: 'Verified' });
        const migs = countFiles(reader, J(root, 'database/migrations'), /\.php$/i, 2);
        if (migs) app.database.push({ what: 'Laravel migrations', path: J(root, 'database/migrations'), count: migs, class: 'Verified' });
        const models = countFiles(reader, J(root, 'app/Models'), /\.php$/i);
        if (models) app.notes.push(`${models} Eloquent models in ${J(root, 'app/Models')}`);
        const ctrls = countFiles(reader, J(root, 'app/Http/Controllers'), /\.php$/i);
        if (ctrls) app.notes.push(`${ctrls} controllers in ${J(root, 'app/Http/Controllers')}`);
        app.commands.push(conv('run', 'php artisan serve', 'Laravel convention'));
        if (reader.isDir(J(root, 'tests'))) app.commands.push(conv('test', 'php artisan test', 'Laravel convention (tests/ exists)'));
      }
    } else if (c) app.notes.push(`${f} is not valid JSON`);
    for (const t of firstExisting(reader, root, ['phpunit.xml', 'phpunit.xml.dist'])) app.tests.push({ tool: 'PHPUnit', evidence: t, class: 'Verified' });
  }

  // --- JavaScript / TypeScript
  if (has('package.json')) {
    const f = J(root, 'package.json');
    const p = reader.json(f);
    if (p && p.data) {
      const deps = jsDeps(p.data, p.text);
      allDeps = allDeps.concat(deps.map((d) => ({ ...d, file: f })));
      const facts = depFacts(JS, deps, f, p.text);
      const isLaravelAssets = app.stack.some((s) => s.name === 'Laravel');
      // In a Laravel app, package.json usually only builds assets: keep its tools, not as a separate stack.
      app.stack.push(...facts.filter((x) => !isLaravelAssets || ['web', 'tool', 'lang', 'test'].includes(x.kind)));
      app.language = app.language || (deps.some((d) => d.name === 'typescript') || reader.exists(J(root, 'tsconfig.json')) ? 'TypeScript' : 'JavaScript');
      const lock = (n) => reader.exists(J(root, n)) || reader.exists(n);
      const runner = lock('pnpm-lock.yaml') ? 'pnpm' : lock('yarn.lock') ? 'yarn' : lock('bun.lockb') || lock('bun.lock') ? 'bun' : 'npm';
      app.commands.push(...scriptsToCommands(p.data.scripts, runner, f, p.text));
      if (p.data.workspaces || reader.exists(J(root, 'pnpm-workspace.yaml')) || reader.exists(J(root, 'turbo.json')) || reader.exists(J(root, 'nx.json')) || reader.exists(J(root, 'lerna.json'))) {
        app.workspace = { tool: reader.exists(J(root, 'turbo.json')) ? 'Turborepo' : reader.exists(J(root, 'nx.json')) ? 'Nx' : reader.exists(J(root, 'pnpm-workspace.yaml')) ? 'pnpm workspaces' : reader.exists(J(root, 'lerna.json')) ? 'Lerna' : 'npm/yarn workspaces', evidence: f };
      }
      if (typeof p.data.main === 'string' && reader.exists(J(root, p.data.main))) ep(J(root, p.data.main), 'package.json "main"');
      const names = facts.map((x) => x.name);
      if (names.includes('Next.js')) for (const d of ['app', 'pages', 'src/app', 'src/pages']) if (reader.isDir(J(root, d))) ep(J(root, d), 'Next.js routes');
      if (names.includes('NestJS')) for (const e of firstExisting(reader, root, ['src/main.ts'])) ep(e, 'NestJS bootstrap');
      if (names.some((n) => ['React', 'Vue', 'Svelte'].includes(n)) && !names.includes('Next.js')) {
        for (const e of firstExisting(reader, root, ['src/main.tsx', 'src/main.jsx', 'src/main.ts', 'src/main.js', 'src/index.tsx', 'src/index.jsx', 'src/index.js', 'index.html'])) ep(e, 'web app entry');
      }
      if (names.some((n) => ['Express', 'Fastify', 'Koa', 'hapi'].includes(n))) {
        for (const e of firstExisting(reader, root, ['src/index.ts', 'src/index.js', 'src/server.ts', 'src/server.js', 'src/app.ts', 'src/app.js', 'server.js', 'server.ts', 'app.js', 'index.js'])) ep(e, 'server entry');
      }
      if (names.includes('Expo') || names.includes('React Native')) for (const e of firstExisting(reader, root, ['App.tsx', 'App.js', 'index.js'])) ep(e, 'mobile app entry');
      if (reader.exists(J(root, 'prisma/schema.prisma'))) app.database.push({ what: 'Prisma schema', path: J(root, 'prisma/schema.prisma'), count: null, class: 'Verified' });
      for (const t of firstExisting(reader, root, ['jest.config.js', 'jest.config.ts', 'vitest.config.ts', 'vitest.config.js', 'playwright.config.ts', 'playwright.config.js', 'cypress.config.ts', 'cypress.config.js'])) {
        app.tests.push({ tool: /jest/.test(t) ? 'Jest' : /vitest/.test(t) ? 'Vitest' : /playwright/.test(t) ? 'Playwright' : 'Cypress', evidence: t, class: 'Verified' });
      }
    } else if (p) app.notes.push(`${f} is not valid JSON`);
  }

  // --- Dart / Flutter
  if (has('pubspec.yaml')) {
    const f = J(root, 'pubspec.yaml');
    const t = reader.text(f);
    const deps = pubspecDeps(t);
    allDeps = allDeps.concat(deps.map((d) => ({ ...d, file: f })));
    const flutterLine = lineOf(t, /sdk:\s*flutter/);
    if (flutterLine) {
      const env = /flutter:\s*["']?([^"'\n]+)/.exec((t.split('environment:')[1] || '').split('\n\n')[0] || '');
      app.stack.push({ name: 'Flutter', kind: 'mobile', version: env ? env[1].trim() : null, evidence: cite(f, flutterLine), class: 'Verified' });
    }
    const sdk = /sdk:\s*["']?([^"'\n]+)/.exec((t || '').split('environment:')[1] || '');
    app.stack.push({ name: 'Dart', kind: 'lang', version: sdk ? sdk[1].trim() : null, evidence: cite(f, lineOf(t, 'environment:')), class: 'Verified' });
    app.stack.push(...depFacts(DART, deps, f, t));
    app.language = app.language || 'Dart';
    const mains = reader.list(J(root, 'lib')).filter((e) => e.isFile() && /^main(_[a-z0-9]+)?\.dart$/i.test(e.name)).map((e) => e.name).sort();
    for (const m of mains) ep(J(root, 'lib', m), m === 'main.dart' ? 'Flutter entry' : `Flutter entry for flavor "${m.slice(5, -5)}"`);
    for (const pl of ['android', 'ios', 'web', 'macos', 'linux', 'windows']) if (reader.isDir(J(root, pl))) app.platforms.push(pl);
    if (flutterLine) {
      app.commands.push(conv('run', 'flutter run', 'Flutter convention'));
      for (const m of mains.filter((x) => x !== 'main.dart')) {
        const fl = m.slice(5, -5);
        app.commands.push(conv('run', `flutter run --flavor ${fl} -t lib/${m}`, `Flutter flavor convention (lib/${m})`));
      }
      if (reader.isDir(J(root, 'test'))) app.commands.push(conv('test', 'flutter test', 'Flutter convention (test/ exists)'));
      if (app.platforms.includes('android')) app.commands.push(conv('build', 'flutter build apk', 'Flutter convention (android/ exists)'));
      if (app.platforms.includes('ios')) app.commands.push(conv('build', 'flutter build ios', 'Flutter convention (ios/ exists)'));
      const tc = countFiles(reader, J(root, 'test'), /_test\.dart$/);
      if (tc) app.tests.push({ tool: 'flutter_test', evidence: `${J(root, 'test')} (${tc} test files)`, class: 'Verified' });
      if (reader.exists(J(root, 'android/app/build.gradle')) || reader.exists(J(root, 'android/app/build.gradle.kts'))) {
        app.notes.push('Android build files in android/app/');
      }
    }
  }

  // --- Python
  const pyFiles = cand.manifests.filter((m) => /^(pyproject\.toml|requirements.*\.txt|setup\.py|pipfile)$/i.test(m) || m === 'manage.py');
  if (pyFiles.length) {
    const deps = [];
    for (const m of pyFiles.filter((x) => x !== 'manage.py')) {
      const f = J(root, m);
      const t = reader.text(f);
      for (const d of textDeps(t, PY.map((x) => x[0]).concat(['boto3', 'stripe', 'razorpay', 'firebase-admin', 'sentry-sdk', 'openai', 'anthropic', 'redis', 'twilio']), f)) if (!deps.some((x) => x.name === d.name)) deps.push(d);
    }
    allDeps = allDeps.concat(deps);
    for (const d of deps) {
      const row = PY.find((x) => x[0] === d.name);
      if (row && !app.stack.some((s) => s.name === row[1])) app.stack.push({ name: row[1], kind: row[2], version: d.version, evidence: cite(d.file, d.line), class: 'Verified' });
    }
    app.language = app.language || 'Python';
    const names = app.stack.map((s) => s.name);
    if (has('manage.py')) {
      ep(J(root, 'manage.py'), 'Django management entry');
      if (!names.includes('Django')) app.stack.push({ name: 'Django', kind: 'backend', version: null, evidence: J(root, 'manage.py'), class: 'Inferred' });
      app.commands.push(conv('run', 'python manage.py runserver', 'Django convention'), conv('test', 'python manage.py test', 'Django convention'));
      const settings = walkFiles(reader, root, { maxDepth: 2, max: 5, match: (n) => n === 'settings.py' });
      for (const s of settings) ep(s, 'Django settings');
      const migs = walkFiles(reader, root, { maxDepth: 4, max: 5000, match: (n, r) => /\/migrations\/\d{4}_.*\.py$/.test('/' + r) });
      if (migs.length) app.database.push({ what: 'Django migrations', path: '*/migrations/', count: migs.length, class: 'Verified' });
    }
    for (const [fw, re] of [['FastAPI', /\b(\w+)\s*=\s*FastAPI\(/], ['Flask', /\b(\w+)\s*=\s*Flask\(/]]) {
      if (!names.includes(fw)) continue;
      const hit = findInSources(reader, root, /\.py$/, re);
      if (hit) {
        ep(hit.file, `${fw} app object (line ${hit.line})`);
        const mod = hit.file.replace(/\.py$/, '').split('/').slice(root === '.' ? 0 : root.split('/').length).join('.');
        const v = re.exec(hit.text)[1];
        if (fw === 'FastAPI') app.commands.push(conv('run', `uvicorn ${mod}:${v} --reload`, `FastAPI convention (${hit.file}:${hit.line})`));
        else app.commands.push(conv('run', `flask --app ${mod} run`, `Flask convention (${hit.file}:${hit.line})`));
      }
    }
    if (names.includes('pytest') || reader.exists(J(root, 'pytest.ini')) || reader.exists(J(root, 'conftest.py')) || reader.isDir(J(root, 'tests'))) {
      app.commands.push(conv('test', 'pytest', 'pytest convention'));
      for (const t of firstExisting(reader, root, ['pytest.ini', 'conftest.py', 'tests'])) app.tests.push({ tool: 'pytest', evidence: t, class: 'Verified' });
    }
    const alembic = countFiles(reader, J(root, 'alembic/versions'), /\.py$/, 1) || countFiles(reader, J(root, 'migrations/versions'), /\.py$/, 1);
    if (alembic) app.database.push({ what: 'Alembic migrations', path: reader.isDir(J(root, 'alembic/versions')) ? J(root, 'alembic/versions') : J(root, 'migrations/versions'), count: alembic, class: 'Verified' });
  }

  // --- Go
  if (has('go.mod')) {
    const f = J(root, 'go.mod');
    const t = reader.text(f);
    const mod = /^module\s+(\S+)/m.exec(t || '');
    const gv = /^go\s+(\S+)/m.exec(t || '');
    app.stack.push({ name: 'Go', kind: 'lang', version: gv ? gv[1] : null, evidence: cite(f, lineOf(t, /^go\s/)), class: 'Verified' });
    const deps = textDeps(t, GO.map((x) => x[0]), f);
    allDeps = allDeps.concat(deps);
    app.stack.push(...depFacts(GO, deps, f, t));
    app.language = app.language || 'Go';
    if (mod) app.notes.push(`Go module ${mod[1]}`);
    for (const e of firstExisting(reader, root, ['main.go'])) ep(e, 'Go main package');
    for (const e of reader.list(J(root, 'cmd')).filter((x) => x.isDirectory())) if (reader.exists(J(root, 'cmd', e.name, 'main.go'))) ep(J(root, 'cmd', e.name, 'main.go'), `Go command "${e.name}"`);
    app.commands.push(conv('build', 'go build ./...', 'Go convention'), conv('test', 'go test ./...', 'Go convention'));
  }

  // --- JVM (Maven / Gradle / Android)
  const jvm = cand.manifests.filter((m) => /^(pom\.xml|build\.gradle(\.kts)?)$/.test(m));
  if (jvm.length) {
    for (const m of jvm) {
      const f = J(root, m);
      let t = reader.text(f) || '';
      // Android apps keep the plugin line in app/build.gradle
      for (const sub of ['app/build.gradle', 'app/build.gradle.kts']) if (reader.exists(J(root, sub))) t += '\n' + (reader.text(J(root, sub)) || '');
      const deps = textDeps(t, JVM.map((x) => x[0]), f);
      allDeps = allDeps.concat(deps);
      for (const fct of depFacts(JVM, deps, f, t)) if (!app.stack.some((s) => s.name === fct.name)) app.stack.push(fct);
    }
    app.language = app.language || (app.stack.some((s) => s.name === 'Kotlin') || jvm.some((m) => m.endsWith('.kts')) ? 'Kotlin' : 'Java');
    const gradle = jvm.some((m) => m.startsWith('build.gradle'));
    const gw = reader.exists(J(root, 'gradlew')) ? './gradlew' : 'gradle';
    if (app.stack.some((s) => s.name === 'Spring Boot')) {
      const hit = findInSources(reader, J(root, 'src/main'), /\.(java|kt)$/, /@SpringBootApplication/);
      if (hit) ep(hit.file, `Spring Boot application (line ${hit.line})`);
      app.commands.push(gradle ? conv('run', `${gw} bootRun`, 'Spring Boot convention') : conv('run', 'mvn spring-boot:run', 'Spring Boot convention'));
    }
    if (app.stack.some((s) => s.name === 'Android app')) {
      for (const e of firstExisting(reader, root, ['app/src/main/AndroidManifest.xml', 'src/main/AndroidManifest.xml'])) ep(e, 'Android manifest');
      app.commands.push(conv('build', `${gw} assembleDebug`, 'Android convention'));
    }
    app.commands.push(gradle ? conv('test', `${gw} test`, 'Gradle convention') : conv('test', 'mvn test', 'Maven convention'));
    app.commands.push(gradle ? conv('build', `${gw} build`, 'Gradle convention') : conv('build', 'mvn package', 'Maven convention'));
  }

  // --- Ruby
  if (has('gemfile')) {
    const f = J(root, cand.manifests.find((m) => m.toLowerCase() === 'gemfile'));
    const t = reader.text(f);
    const deps = textDeps(t, RUBY.map((x) => x[0]).concat(['stripe', 'razorpay', 'twilio-ruby', 'sentry-ruby', 'redis']), f);
    allDeps = allDeps.concat(deps);
    app.stack.push(...depFacts(RUBY, deps, f, t));
    app.language = app.language || 'Ruby';
    if (app.stack.some((s) => s.name === 'Rails')) {
      for (const e of firstExisting(reader, root, ['config/routes.rb', 'config.ru'])) ep(e, e.endsWith('routes.rb') ? 'Rails routes' : 'Rack entry');
      app.commands.push(conv('run', 'bin/rails server', 'Rails convention'), conv('test', app.stack.some((s) => s.name === 'RSpec') ? 'bundle exec rspec' : 'bin/rails test', 'Rails convention'));
      const migs = countFiles(reader, J(root, 'db/migrate'), /\.rb$/, 1);
      if (migs) app.database.push({ what: 'Rails migrations', path: J(root, 'db/migrate'), count: migs, class: 'Verified' });
    }
  }

  // --- .NET
  for (const m of cand.manifests.filter((x) => x.endsWith('.csproj'))) {
    const f = J(root, m);
    const t = reader.text(f) || '';
    const web = lineOf(t, /Sdk="Microsoft\.NET\.Sdk\.Web"/);
    app.stack.push({ name: web ? 'ASP.NET Core' : '.NET', kind: web ? 'backend' : 'lang', version: (/<TargetFramework>([^<]+)</.exec(t) || [])[1] || null, evidence: cite(f, web || lineOf(t, 'TargetFramework')), class: 'Verified' });
    if (lineOf(t, 'EntityFrameworkCore')) app.stack.push({ name: 'Entity Framework Core', kind: 'db', version: null, evidence: cite(f, lineOf(t, 'EntityFrameworkCore')), class: 'Verified' });
    app.language = app.language || 'C#';
    for (const e of firstExisting(reader, root, ['Program.cs'])) ep(e, '.NET entry');
    app.commands.push(conv('run', 'dotnet run', '.NET convention'), conv('test', 'dotnet test', '.NET convention'), conv('build', 'dotnet build', '.NET convention'));
  }

  // --- Rust
  if (has('cargo.toml')) {
    const f = J(root, 'Cargo.toml');
    const t = reader.text(f);
    const deps = textDeps(t, RUST.map((x) => x[0]), f);
    allDeps = allDeps.concat(deps);
    app.stack.push({ name: 'Rust', kind: 'lang', version: null, evidence: f, class: 'Verified' }, ...depFacts(RUST, deps, f, t));
    app.language = app.language || 'Rust';
    for (const e of firstExisting(reader, root, ['src/main.rs'])) ep(e, 'Rust binary');
    app.commands.push(conv('build', 'cargo build', 'Cargo convention'), conv('test', 'cargo test', 'Cargo convention'));
  }

  // --- native iOS
  if (cand.xcode && !app.stack.some((s) => s.name === 'Flutter')) {
    app.stack.push({ name: 'iOS (Xcode project)', kind: 'mobile', version: null, evidence: root, class: 'Verified' });
    app.language = app.language || 'Swift';
    app.commands.push(conv('build', 'xcodebuild build', 'Xcode convention'));
  }

  // --- shared
  app.commands.push(...makeTargets(reader, root));
  // external services: any declared dependency that names one, cited to its manifest line
  for (const d of allDeps) {
    for (const [re, name] of SERVICES) {
      if (re.test(d.name) && !app.services.some((s) => s.name === name)) app.services.push({ name, evidence: cite(d.file, d.line), class: 'Verified (declared dependency)' });
    }
  }
  const envFile = J(root, '.env.example');
  const envText = reader.text(envFile);
  if (envText) {
    const SAFE_VALUE_KEYS = /^(DB_CONNECTION|APP_ENV|CACHE_DRIVER|CACHE_STORE|QUEUE_CONNECTION|BROADCAST_DRIVER|SESSION_DRIVER|MAIL_MAILER|FILESYSTEM_DISK|LOG_CHANNEL|DATABASE_ENGINE)$/;
    const names = [];
    const values = {};
    for (const l of envText.split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(l);
      if (!m) continue;
      names.push(m[1]);
      const v = m[2].replace(/^["']|["']$/g, '').trim();
      if (SAFE_VALUE_KEYS.test(m[1]) && /^[a-z0-9_-]{1,20}$/i.test(v)) values[m[1]] = v;
    }
    app.envVars = { source: envFile, names, safeValues: values, class: 'Verified' };
    if (values.DB_CONNECTION) app.database.push({ what: `database engine "${values.DB_CONNECTION}"`, path: cite(envFile, lineOf(envText, 'DB_CONNECTION')), count: null, class: 'Inferred (from .env.example)' });
  }

  // --- kind
  const kinds = new Set(app.stack.map((s) => s.kind));
  if (app.workspace && !kinds.has('backend') && !kinds.has('web') && !kinds.has('mobile')) app.kind = 'workspace';
  else if (kinds.has('mobile')) app.kind = 'mobile';
  else if (kinds.has('backend') && kinds.has('web')) app.kind = 'backend + web';
  else if (kinds.has('backend')) app.kind = 'backend';
  else if (kinds.has('web')) app.kind = 'web';
  else if (kinds.has('desktop')) app.kind = 'desktop';
  else if (app.language) app.kind = 'library';
  if (!app.stack.some((s) => ['backend', 'web', 'mobile', 'desktop'].includes(s.kind)) && app.kind !== 'workspace') {
    app.notes.push('No known app framework found: facts come from the generic reader and are Inferred.');
  }
  // dedupe commands by cmd
  const seen = new Set();
  app.commands = app.commands.filter((c) => (seen.has(c.cmd) ? false : seen.add(c.cmd)));
  void appCount;
  return app;
}

// ------------------------------------------------------------------ repo level

function ciFacts(reader) {
  const out = [];
  for (const e of reader.list('.github/workflows')) if (e.isFile() && /\.ya?ml$/.test(e.name)) out.push({ system: 'GitHub Actions', path: J('.github/workflows', e.name) });
  const singles = [['.gitlab-ci.yml', 'GitLab CI'], ['bitbucket-pipelines.yml', 'Bitbucket Pipelines'], ['Jenkinsfile', 'Jenkins'], ['.circleci/config.yml', 'CircleCI'], ['azure-pipelines.yml', 'Azure Pipelines'], ['codemagic.yaml', 'Codemagic'], ['.travis.yml', 'Travis CI'], ['appveyor.yml', 'AppVeyor'], ['fastlane/Fastfile', 'fastlane']];
  for (const [p, s] of singles) if (reader.exists(p)) out.push({ system: s, path: p });
  return out;
}

function dockerFacts(reader) {
  const out = [];
  for (const e of reader.list('.')) {
    if (!e.isFile()) continue;
    if (/^dockerfile/i.test(e.name)) out.push({ path: e.name, kind: 'Dockerfile' });
    if (/^(docker-)?compose.*\.ya?ml$/i.test(e.name)) {
      const t = reader.text(e.name) || '';
      const services = [];
      let inServices = false;
      t.split('\n').forEach((l) => {
        if (/^services:\s*$/.test(l)) inServices = true;
        else if (/^\S/.test(l)) inServices = false;
        else if (inServices) {
          const m = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(l);
          if (m) services.push(m[1]);
        }
      });
      out.push({ path: e.name, kind: 'Compose', services });
    }
  }
  return out;
}

// Everything detect.mjs writes to stack.json for one repo.
export function detectRepo(repo, isSecret, { now = new Date() } = {}) {
  const reader = makeReader(repo, isSecret);
  const name = path.basename(repo);
  const git = gitInfo(repo);
  const tracked = trackedFiles(repo, reader);
  const visible = tracked.files.filter((f) => !/(^|\/)\.git(\/|$)/.test(f));
  // committed secret files (names only); third-party dependency folders are not the project's secrets
  const DEP_DIRS = new Set(['node_modules', 'vendor', 'pods', '.venv', 'venv', '.dart_tool', '.pub-cache', 'bower_components']);
  const secretsTracked = visible.filter((f) => isSecret(f) && !f.split('/').some((s) => DEP_DIRS.has(s.toLowerCase())) && !f.startsWith('sdlc-docs/'));
  const meaningful = visible.filter((f) => !/^(readme(\..*)?|license(\..*)?|\.gitignore|\.gitattributes|\.editorconfig)$/i.test(f) && !f.startsWith('sdlc-docs/'));
  const cands = findApps(reader);
  const apps = cands.map((c) => analyzeApp(reader, c, name, cands.length));
  const empty = meaningful.length === 0 && apps.length === 0;
  return {
    schema: 1,
    repo: name,
    path: repo,
    commit: git.commit,
    branch: git.branch,
    remote: git.remote,
    isGit: git.isGit,
    detectedAt: now.toISOString(),
    empty,
    files: { count: visible.length, source: tracked.source },
    languages: languages(visible),
    apps,
    ci: ciFacts(reader),
    docker: dockerFacts(reader),
    secretsTracked: git.isGit && tracked.source === 'git ls-files' ? secretsTracked : [],
    secretsSeen: secretsTracked.length,
    notes: empty ? ['No code yet: no stack detected.'] : [],
  };
}
