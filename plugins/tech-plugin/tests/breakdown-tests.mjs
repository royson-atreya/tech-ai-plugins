// breakdown stages 1-2: detection on the golden fixtures, repo finding, the
// YAML reader/writer, the full stage flow through the scripts (as the skill
// runs them), saved progress and "already up to date", and that the scripts
// never read secret files or write outside sdlc-docs/.
//
//   node --test tests/breakdown-tests.mjs

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildGolden, SECRET_MARKER, setCommit } from './golden.mjs';
import { PLUGIN, runGuard } from './fixture.mjs';
import { detectRepo, makeReader } from '../scripts/lib/stacks.mjs';
import { secretTester } from '../scripts/lib/secretnames.mjs';
import { parseYaml, toYaml, YamlError } from '../scripts/lib/yaml.mjs';

const G = buildGolden();
after(() => fs.rmSync(G.W, { recursive: true, force: true }));

const BD = path.join(PLUGIN, 'scripts', 'breakdown');
const ENV = { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN };
function run(script, args, opts = {}) {
  const r = spawnSync(process.execPath, [path.join(BD, script), ...args], { encoding: 'utf8', env: ENV, timeout: 60000, ...opts });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}
const json = (r) => {
  assert.equal(r.code, 0, r.err);
  return JSON.parse(r.out);
};
const detect = (repo) => detectRepo(repo, secretTester(PLUGIN, repo));
const app = (info, id) => info.apps.find((a) => a.id === id);
const names = (a) => a.stack.map((s) => s.name);
const cmds = (a) => a.commands.map((c) => c.cmd);

// Every file in a folder, except .git and sdlc-docs (to prove nothing else changes).
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'sdlc-docs') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

// ================================================================ detection: golden repos
describe('golden 1: Laravel + Flutter system', () => {
  const be = detect(G.backend);
  const wb = detect(G.web);
  const mo = detect(G.mobile);
  const a = app(be, 'backend');

  test('backend is one backend app on Laravel ^10.10, cited to its line', () => {
    assert.equal(be.apps.length, 1);
    assert.equal(a.kind, 'backend');
    const lv = a.stack.find((s) => s.name === 'Laravel');
    assert.deepEqual([lv.version, lv.evidence, lv.class], ['^10.10', 'composer.json:5', 'Verified']);
    assert.ok(names(a).includes('Laravel Sanctum'));
  });
  test('backend entry points and route files', () => {
    assert.deepEqual(a.entryPoints.map((e) => e.path), ['artisan', 'public/index.php']);
    assert.deepEqual(a.routes.map((r) => r.path), ['routes/api.php', 'routes/web.php']);
  });
  test('backend commands: scripts are Verified, conventions Inferred, none run', () => {
    assert.ok(cmds(a).includes('composer test') && cmds(a).includes('php artisan test') && cmds(a).includes('make test') && cmds(a).includes('npm run build'));
    assert.equal(a.commands.find((c) => c.cmd === 'php artisan test').class, 'Inferred');
    assert.equal(a.commands.find((c) => c.cmd === 'composer test').class, 'Verified');
    assert.ok(a.commands.every((c) => c.status === 'found, not run'));
    assert.ok(!cmds(a).some((c) => /post-autoload-dump/.test(c)), 'composer hooks are not commands');
  });
  test('backend tests, migrations, database engine, services', () => {
    assert.deepEqual(a.tests.map((t) => t.tool), ['PHPUnit']);
    assert.equal(a.database.find((d) => d.what === 'Laravel migrations').count, 3);
    assert.ok(a.database.some((d) => /mysql/.test(d.what)));
    assert.deepEqual(a.services.map((s) => s.name).sort(), ['Firebase', 'Razorpay']);
    assert.equal(a.services.find((s) => s.name === 'Razorpay').evidence, 'composer.json:7');
  });
  test('backend env vars: names only, values only for safe settings', () => {
    assert.ok(a.envVars.names.includes('RAZORPAY_KEY') && a.envVars.names.includes('APP_KEY'));
    assert.deepEqual(a.envVars.safeValues, { APP_ENV: 'local', DB_CONNECTION: 'mysql' });
  });
  test('backend repo facts: CI, Docker services, commit, committed secrets', () => {
    assert.deepEqual(be.ci.map((c) => c.system), ['GitHub Actions']);
    assert.deepEqual(be.docker.find((d) => d.kind === 'Compose').services, ['app', 'mysql', 'redis']);
    assert.equal(be.commit, 'a'.repeat(40));
    assert.equal(be.branch, 'main');
    assert.deepEqual(be.secretsTracked.sort(), ['.env', 'storage/oauth-private.pem']);
  });
  test('web dashboard is Laravel + Blade (backend + web) with Livewire', () => {
    const w = app(wb, 'web');
    assert.equal(w.kind, 'backend + web');
    assert.ok(names(w).includes('Livewire'));
    assert.match(w.stack.find((s) => s.name === 'Blade').evidence, /12 templates/);
  });
  test('mobile is one Flutter app: android/ and ios/ are not separate apps', () => {
    assert.equal(mo.apps.length, 1);
    const m = app(mo, 'mobile');
    assert.equal(m.kind, 'mobile');
    assert.deepEqual(names(m).slice(0, 2), ['Flutter', 'Dart']);
    assert.ok(names(m).includes('Dio') && names(m).includes('Provider'));
    assert.deepEqual(m.platforms, ['android', 'ios']);
  });
  test('mobile flavors, commands and tests', () => {
    const m = app(mo, 'mobile');
    assert.deepEqual(m.entryPoints.map((e) => e.path), ['lib/main.dart', 'lib/main_staging.dart']);
    assert.ok(cmds(m).includes('flutter run --flavor staging -t lib/main_staging.dart'));
    assert.ok(cmds(m).includes('flutter test') && cmds(m).includes('flutter build apk') && cmds(m).includes('flutter build ios'));
    assert.match(m.tests[0].evidence, /1 test files/);
  });
  test('mobile services, CI, committed secrets (names only), branch', () => {
    const m = app(mo, 'mobile');
    assert.deepEqual(m.services.map((s) => s.name).sort(), ['Firebase', 'Razorpay']);
    assert.deepEqual(mo.ci.map((c) => c.system), ['Codemagic']);
    assert.deepEqual(mo.secretsTracked.sort(), ['android/app/google-services.json', 'android/app/upload.jks', 'ios/Runner/GoogleService-Info.plist']);
    assert.equal(mo.branch, 'develop');
  });
});

describe('golden 2: Node/React monorepo', () => {
  const s = detect(G.shop);
  test('three apps: the Turborepo workspace, the API and the web app', () => {
    assert.deepEqual(s.apps.map((a) => [a.id, a.kind]), [['shop', 'workspace'], ['shop/apps/api', 'backend'], ['shop/apps/web', 'web']]);
    assert.equal(app(s, 'shop').workspace.tool, 'Turborepo');
  });
  test('node_modules is never an app', () => assert.ok(!s.apps.some((a) => a.root.includes('node_modules'))));
  test('web: Next.js 14.0.3 with React, Playwright, app/ routes', () => {
    const w = app(s, 'shop/apps/web');
    assert.equal(w.stack.find((x) => x.name === 'Next.js').version, '14.0.3');
    assert.ok(names(w).includes('React'));
    assert.deepEqual(w.tests.map((t) => t.tool), ['Playwright']);
    assert.deepEqual(w.entryPoints.map((e) => e.path), ['apps/web/app']);
    assert.ok(cmds(w).includes('npm run dev') && cmds(w).includes('npm start') && cmds(w).includes('npm test'));
  });
  test('api: Express + Prisma + Jest, entry from package.json main', () => {
    const api = app(s, 'shop/apps/api');
    assert.ok(names(api).includes('Express') && names(api).includes('Prisma'));
    assert.equal(api.language, 'TypeScript');
    assert.ok(api.database.some((d) => d.what === 'Prisma schema'));
    assert.equal(api.entryPoints[0].path, 'apps/api/src/index.ts');
    assert.deepEqual(api.services.map((x) => x.name), ['Stripe']);
  });
  test('committed secrets in sub-apps are found by name', () => assert.deepEqual(s.secretsTracked.sort(), ['apps/api/.env', 'apps/web/.env.local']));
});

describe('golden 3: Python FastAPI app', () => {
  const p = detect(G.py);
  const a = p.apps[0];
  test('one FastAPI backend with its version and citation', () => {
    assert.equal(p.apps.length, 1);
    assert.equal(a.kind, 'backend');
    const f = a.stack.find((x) => x.name === 'FastAPI');
    assert.deepEqual([f.version, f.evidence], ['0.104.0', 'pyproject.toml:4']);
  });
  test('entry point found by reading the code: app/main.py, object "api"', () => {
    assert.equal(a.entryPoints[0].path, 'app/main.py');
    assert.ok(cmds(a).includes('uvicorn app.main:api --reload'));
  });
  test('Alembic migrations, pytest, AWS, safe env values', () => {
    assert.equal(a.database.find((d) => d.what === 'Alembic migrations').count, 2);
    assert.ok(cmds(a).includes('pytest'));
    assert.deepEqual(a.services.map((x) => x.name), ['AWS']);
    assert.deepEqual(a.envVars.safeValues, { APP_ENV: 'dev' });
  });
});

describe('golden 4: empty folder', () => {
  test('empty git repo: no code yet, no apps', () => {
    const b = detect(G.blank);
    assert.equal(b.empty, true);
    assert.deepEqual(b.apps, []);
    assert.deepEqual(b.notes, ['No code yet: no stack detected.']);
  });
  test('empty plain folder: no code yet', () => assert.equal(detect(G.newfolder).empty, true));
});

describe('secret files are never read', () => {
  test('no secret file is opened while detecting any golden repo', () => {
    const opened = [];
    const orig = fs.readFileSync;
    fs.readFileSync = function (p, ...rest) {
      opened.push(String(p));
      return orig.call(this, p, ...rest);
    };
    let out;
    try {
      out = [G.backend, G.web, G.mobile, G.shop, G.py].map(detect);
    } finally {
      fs.readFileSync = orig;
    }
    const isSecret = secretTester(PLUGIN, null);
    const bad = opened.filter((p) => isSecret(p));
    assert.deepEqual(bad, []);
    assert.ok(opened.some((p) => p.endsWith('.env.example')), 'the example file is read');
    assert.ok(!JSON.stringify(out).includes(SECRET_MARKER), 'no secret content in the facts');
  });
  test('the reader refuses a symlink that leaves the repo, and one that points to a secret', () => {
    fs.symlinkSync(path.join(G.py, 'pyproject.toml'), path.join(G.backend, 'linked-out.toml'));
    fs.symlinkSync(path.join(G.backend, '.env'), path.join(G.backend, 'innocent.txt'));
    const r = makeReader(G.backend, secretTester(PLUGIN, G.backend));
    assert.equal(r.text('linked-out.toml'), null);
    assert.equal(r.text('innocent.txt'), null);
    assert.ok(r.text('composer.json'));
    fs.unlinkSync(path.join(G.backend, 'linked-out.toml'));
    fs.unlinkSync(path.join(G.backend, 'innocent.txt'));
  });
});

// ================================================================ find-repos
describe('stage 1: finding the repos', () => {
  test('workspace folder: three repos, backend proposed as home', () => {
    const r = json(run('find-repos.mjs', ['--cwd', G.nadi]));
    assert.equal(r.mode, 'workspace');
    assert.deepEqual(r.repos.map((x) => [x.name, x.role]), [['backend', 'backend'], ['mobile', 'mobile'], ['web', 'backend']]);
    assert.equal(r.homeGuess, G.backend);
  });
  test('inside a repo (from a subfolder): that repo only', () => {
    const r = json(run('find-repos.mjs', ['--cwd', path.join(G.backend, 'app/Http')]));
    assert.equal(r.mode, 'repo');
    assert.deepEqual(r.repos.map((x) => x.name), ['backend']);
  });
  test('paths given: those repos', () => {
    const r = json(run('find-repos.mjs', ['--cwd', G.W, 'shop', 'pyapp']));
    assert.equal(r.mode, 'paths');
    assert.deepEqual(r.repos.map((x) => [x.name, x.role]), [['shop', 'backend'], ['pyapp', 'backend']]);
  });
  test('a git URL is never cloned: the clone command is returned for the person', () => {
    const r = json(run('find-repos.mjs', ['--cwd', G.W, 'https://user:tok@example.com/acme/billing.git']));
    assert.equal(r.mode, 'urls');
    assert.equal(r.urls[0].command, `git clone https://user:tok@example.com/acme/billing.git "${path.join(G.W, 'billing')}"`);
    assert.equal(fs.existsSync(path.join(G.W, 'billing')), false);
  });
  test('missing path is reported', () => assert.deepEqual(json(run('find-repos.mjs', ['--cwd', G.W, 'nope'])).missing, ['nope']));
  test('empty plain folder', () => {
    const r = json(run('find-repos.mjs', ['--cwd', G.newfolder]));
    assert.equal(r.mode, 'empty-folder');
    assert.equal(r.repos[0].empty, true);
  });
  test('empty git repo', () => {
    const r = json(run('find-repos.mjs', ['--cwd', G.blank]));
    assert.deepEqual([r.mode, r.repos[0].empty, r.repos[0].role], ['repo', true, 'empty']);
  });
  test('finding repos writes nothing', () => {
    const before = snapshot(G.W);
    run('find-repos.mjs', ['--cwd', G.nadi]);
    assert.deepEqual(snapshot(G.W), before);
  });
});

// ================================================================ YAML
describe('system.yaml reader and writer', () => {
  const sample = {
    system: { name: 'Nadi Tarangini', home_repo: 'backend' },
    business: { product: 'Helps doctors: fast pulse reports', users: null, key_flows: ['Book a slot', 'Pay'], roles: [], environments: [{ name: 'prod', url: 'https://app.example.com', production: true }] },
    repos: [{ name: 'backend', path: '.', home: true }, { name: 'mobile', path: '../mobile', home: false }],
    connectors: {},
    odd: ['yes', '123', '', '- dash', '#hash', 'a: b'],
  };
  test('round trip keeps every value', () => assert.deepEqual(parseYaml(toYaml(sample, 'header line')), sample));
  test('reads what people write: comments, block text, flow lists, quotes', () => {
    const y = 'system:\n  name: "Nadi"   # the product\n# a comment\nbusiness:\n  product: |\n    Line one\n    Line two\n  roles: [Doctor, "Front desk", Patient]\n  users: \'Clinic staff\'\nrepos:\n- name: backend\n  path: .\n';
    assert.deepEqual(parseYaml(y), { system: { name: 'Nadi' }, business: { product: 'Line one\nLine two\n', roles: ['Doctor', 'Front desk', 'Patient'], users: 'Clinic staff' }, repos: [{ name: 'backend', path: '.' }] });
  });
  test('URLs stay plain strings', () => assert.deepEqual(parseYaml('url: https://a.example.com:8443/x\n'), { url: 'https://a.example.com:8443/x' }));
  test('bad indentation names the line', () => assert.throws(() => parseYaml('a:\n  b: 1\n    c: 2\n'), (e) => e instanceof YamlError && /line 3/.test(e.message)));
  test('anchors are refused, not guessed', () => assert.throws(() => parseYaml('a: &x 1\nb: *x\n'), YamlError));
  test('duplicate keys are refused', () => assert.throws(() => parseYaml('a: 1\na: 2\n'), /duplicate key/));
  test('tabs are refused', () => assert.throws(() => parseYaml('a:\n\tb: 1\n'), /tabs/));
});

// ================================================================ stage flow, as the skill runs it
describe('stages 1-2 end to end (nadi workspace)', () => {
  const H = G.backend;
  const docs = (repo, f) => path.join(repo, 'sdlc-docs', f);
  const before = { backend: snapshot(G.backend), web: snapshot(G.web), mobile: snapshot(G.mobile) };
  const input = path.join(G.W, 'stage1-input.json');

  test('before stage 1: no progress, next is stage 1', () => {
    const s = json(run('state.mjs', ['status', '--cwd', G.nadi]));
    assert.deepEqual([s.found, s.next], [false, 1]);
  });
  test('detect --write refuses when sdlc-docs/ does not exist yet', () => {
    const r = run('detect.mjs', [G.backend, '--write']);
    assert.equal(r.code, 1);
    assert.match(r.err, /run stage 1 first/);
    assert.equal(fs.existsSync(docs(G.backend, '')), false);
  });
  test('stage 1 writes system.yaml, glossary, index, pointers and progress', () => {
    fs.writeFileSync(input, JSON.stringify({
      system: 'Nadi Tarangini',
      home: H,
      repos: [{ path: G.backend, role: 'backend' }, { path: G.web, role: 'web' }, { path: G.mobile, role: 'mobile' }],
      business: { product: 'Pulse-based health reports for clinics', users: 'Doctors and patients', keyFlows: ['Book a consultation', 'Read a report'], roles: ['Doctor', 'Patient', 'Admin'], environments: [{ name: 'staging', url: 'https://staging.example.com', production: false }, { name: 'production', url: 'https://app.example.com', production: true }] },
      docs: [],
      tracker: 'plain-text',
    }));
    const r = run('write.mjs', ['system', '--input', input]);
    assert.equal(r.code, 0, r.err);
    for (const f of ['system.yaml', 'glossary.md', 'README.md', '_state/breakdown.json']) assert.ok(fs.existsSync(docs(H, f)), f);
    for (const repo of [G.web, G.mobile]) assert.deepEqual(JSON.parse(fs.readFileSync(docs(repo, 'home.json'), 'utf8')).home, '../backend');
  });
  test('system.yaml holds the answers, relative repo paths and the tracker', () => {
    const y = parseYaml(fs.readFileSync(docs(H, 'system.yaml'), 'utf8'));
    assert.equal(y.system.name, 'Nadi Tarangini');
    assert.equal(y.business.product, 'Pulse-based health reports for clinics');
    assert.deepEqual(y.business.roles, ['Doctor', 'Patient', 'Admin']);
    assert.deepEqual(y.repos.map((r) => [r.name, r.path, r.home]), [['backend', '.', true], ['web', '../web', false], ['mobile', '../mobile', false]]);
    assert.equal(y.connectors.tracker, 'plain-text');
    assert.equal(y.business.environments[1].production, true);
  });
  test('the glossary is seeded from the answers', () => {
    const g = fs.readFileSync(docs(H, 'glossary.md'), 'utf8');
    for (const t of ['| Nadi Tarangini |', '| Doctor |', '| Patient |', '| production |']) assert.ok(g.includes(t), t);
  });
  test('after stage 1: next is stage 2', () => assert.equal(json(run('state.mjs', ['status', '--cwd', G.nadi])).next, 2));
  test('stage 2 detect --write saves stack.json in each repo\'s own sdlc-docs', () => {
    for (const [repo, name] of [[G.backend, 'backend'], [G.web, 'web'], [G.mobile, 'mobile']]) {
      const r = run('detect.mjs', [repo, '--write']);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, new RegExp(`^${name}: 1 app`));
      assert.ok(fs.existsSync(docs(repo, `_map/${name}/stack.json`)));
    }
  });
  test('profile draft: apps table, citations, commands found not run, waiting for confirmation', () => {
    fs.writeFileSync(docs(G.mobile, '_map/mobile/architecture-root.md'), '### Layout\n- lib/screens holds screens [mobile:lib/screens/login_screen.dart:1, Verified]\n');
    const r = run('write.mjs', ['profile', '--home', H]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /\| backend \| backend \| Laravel 10\.10/);
    const p = fs.readFileSync(docs(H, 'profile.md'), 'utf8');
    assert.match(p, /Status:\*\* Draft, waiting for your confirmation/);
    assert.match(p, /backend:composer\.json:5/);
    assert.match(p, /found, not run/);
    assert.match(p, /lib\/screens holds screens/);
    assert.match(p, /Secret files committed to git/);
    assert.ok(!p.includes(SECRET_MARKER));
    const s = json(run('state.mjs', ['status', '--cwd', H]));
    assert.equal(s.next, 2);
    assert.match(s.message, /waiting for your confirmation/);
  });
  test('corrections from the person appear in the profile', () => {
    fs.writeFileSync(docs(H, '_state/profile-corrections.json'), JSON.stringify([{ app: 'web', text: 'The web dashboard is for clinic admins only' }]));
    run('write.mjs', ['profile', '--home', H]);
    assert.match(fs.readFileSync(docs(H, 'profile.md'), 'utf8'), /Corrections from people[\s\S]*clinic admins only/);
  });
  test('confirm records who confirmed and marks stage 2 done', () => {
    const r = run('write.mjs', ['confirm', '--home', H, '--by', 'Test Person']);
    assert.equal(r.code, 0, r.err);
    assert.match(fs.readFileSync(docs(H, 'profile.md'), 'utf8'), /Confirmed in chat by Test Person on \d{4}-\d{2}-\d{2}/);
    assert.match(fs.readFileSync(docs(H, 'README.md'), 'utf8'), /profile\.md` \| Stack, entry points and commands for each app \| Confirmed/);
  });
  test('second run with no code change: already up to date (from any repo or the workspace)', () => {
    for (const cwd of [G.nadi, H, G.mobile, path.join(G.web, 'routes')]) {
      const s = json(run('state.mjs', ['status', '--cwd', cwd]));
      assert.deepEqual([s.found, s.home, s.next], [true, H, 'up-to-date'], cwd);
      assert.match(s.message, /Already up to date/);
    }
  });
  test('a new commit in one repo: stage 2 again, only that repo changed', () => {
    setCommit(G.mobile, 'develop', 'f'.repeat(40));
    const s = json(run('state.mjs', ['status', '--cwd', G.nadi]));
    assert.equal(s.next, 2);
    assert.deepEqual(s.repos.filter((r) => r.changed).map((r) => r.name), ['mobile']);
    setCommit(G.mobile, 'develop', 'c'.repeat(40));
  });
  test('a manifest change without a commit is noticed too', () => {
    const f = path.join(G.web, 'composer.json');
    const t = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, t.replace('^10.10', '^11.0'));
    assert.deepEqual(json(run('state.mjs', ['status', '--cwd', G.nadi])).repos.filter((r) => r.changed).map((r) => r.name), ['web']);
    fs.writeFileSync(f, t);
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(f, old, old);
  });
  test('running stage 1 again keeps the person\'s own edits and earlier answers', () => {
    const y = docs(H, 'system.yaml');
    fs.writeFileSync(y, fs.readFileSync(y, 'utf8') + 'owner_notes: keep me\n');
    fs.writeFileSync(input, JSON.stringify({ system: 'Nadi Tarangini', home: H, repos: [{ path: G.backend }, { path: G.web }, { path: G.mobile }], business: { roles: ['Doctor', 'Receptionist'] } }));
    assert.equal(run('write.mjs', ['system', '--input', input]).code, 0);
    const v = parseYaml(fs.readFileSync(y, 'utf8'));
    assert.equal(v.owner_notes, 'keep me');
    assert.equal(v.business.product, 'Pulse-based health reports for clinics');
    assert.deepEqual(v.business.roles, ['Doctor', 'Receptionist']);
    const g = fs.readFileSync(docs(H, 'glossary.md'), 'utf8');
    assert.equal(g.split('| Doctor |').length, 2, 'no duplicate terms');
    assert.ok(g.includes('| Receptionist |'));
  });
  test('a broken system.yaml stops stage 1 with the line number', () => {
    const y = docs(H, 'system.yaml');
    const keep = fs.readFileSync(y, 'utf8');
    fs.writeFileSync(y, 'system:\n  name: x\n    bad: 1\n');
    const r = run('write.mjs', ['system', '--input', input]);
    assert.equal(r.code, 1);
    assert.match(r.err, /line 3/);
    fs.writeFileSync(y, keep);
  });
  test('nothing outside sdlc-docs/ changed in any repo', () => {
    assert.deepEqual(snapshot(G.backend), before.backend);
    assert.deepEqual(snapshot(G.web), before.web);
    assert.deepEqual(snapshot(G.mobile), before.mobile);
  });
  test('the scripts refuse to write outside sdlc-docs/', () => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import { writeDocs } from ${JSON.stringify(path.join(BD, 'common.mjs'))}; writeDocs(${JSON.stringify(G.py)}, '../escape.txt', 'x');`], { encoding: 'utf8', env: ENV });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /refusing to write outside/);
    assert.equal(fs.existsSync(path.join(G.py, 'escape.txt')), false);
  });
});

describe('stages 1-2 on the empty repo', () => {
  test('profile says no code yet', () => {
    const input = path.join(G.W, 'blank-input.json');
    fs.writeFileSync(input, JSON.stringify({ system: 'New thing', home: G.blank, repos: [{ path: G.blank }], business: {} }));
    assert.equal(run('write.mjs', ['system', '--input', input]).code, 0);
    assert.match(run('detect.mjs', [G.blank, '--write']).out, /no code yet/);
    assert.equal(run('write.mjs', ['profile', '--home', G.blank]).code, 0);
    assert.match(fs.readFileSync(path.join(G.blank, 'sdlc-docs/profile.md'), 'utf8'), /## blank: no code yet/);
  });
});

// ================================================================ guard and skill wiring
describe('breakdown under the guard', () => {
  const env = { HOME: path.join(G.W, 'home') };
  const bash = (cwd, command) => runGuard({ tool_name: 'Bash', cwd, tool_input: { command } }, { env }).decision;
  test('the plugin\'s breakdown scripts run in a repo on main (trusted scripts)', () => {
    assert.equal(bash(G.backend, `node "$CLAUDE_PLUGIN_ROOT/scripts/breakdown/detect.mjs" "${G.backend}" --write`), 'pass');
    assert.equal(bash(G.backend, 'node "$CLAUDE_PLUGIN_ROOT/scripts/breakdown/state.mjs" status'), 'pass');
  });
  test('Claude may write the stage-1 input and corrections inside sdlc-docs/', () => {
    const w = (p) => runGuard({ tool_name: 'Write', cwd: G.backend, tool_input: { file_path: p, content: '{}' } }, { env }).decision;
    assert.equal(w(path.join(G.backend, 'sdlc-docs/_state/stage1-input.json')), 'pass');
    assert.equal(w(path.join(G.backend, 'sdlc-docs/_state/profile-corrections.json')), 'pass');
  });
  test('adding production hosts to config.json asks the person', () => {
    assert.equal(runGuard({ tool_name: 'Write', cwd: G.backend, tool_input: { file_path: path.join(G.backend, 'sdlc-docs/config.json'), content: '{"blockedHosts":["app.example.com"]}' } }, { env }).decision, 'ask');
  });
  test('running a repo\'s build or test command is still blocked before approval', () => {
    assert.equal(bash(G.backend, 'php artisan test'), 'block:safe-commands');
    assert.equal(bash(G.mobile, 'flutter test'), 'block:repo-write');
    assert.equal(bash(G.backend, 'git clone https://example.com/x.git'), 'block:git');
  });
});

describe('breakdown skill and agent definitions', () => {
  const skill = fs.readFileSync(path.join(PLUGIN, 'skills/breakdown/SKILL.md'), 'utf8');
  const agent = fs.readFileSync(path.join(PLUGIN, 'agents/stack-detector.md'), 'utf8');
  test('breakdown is manual-only, Haiku, low effort', () => {
    assert.match(skill, /^disable-model-invocation: true$/m);
    assert.match(skill, /^model: haiku$/m);
    assert.match(skill, /^effort: low$/m);
  });
  test('the skill stays short; stage details load from references', () => {
    assert.ok(skill.split('\n').length < 60);
    for (const f of ['references/breakdown/stage-1-find.md', 'references/breakdown/stage-2-learn.md']) assert.ok(fs.existsSync(path.join(PLUGIN, f)), f);
  });
  test('the stack-detector agent is read-only Haiku', () => {
    assert.match(agent, /^tools: Read, Grep, Glob$/m);
    assert.match(agent, /^model: haiku$/m);
  });
  test('doctor lists breakdown', () => {
    const r = spawnSync(process.execPath, [path.join(PLUGIN, 'scripts/doctor.mjs'), '--dir', G.W], { encoding: 'utf8', env: ENV, timeout: 60000 });
    assert.match(r.stdout, /`\/tech-plugin:breakdown`/);
  });
});
