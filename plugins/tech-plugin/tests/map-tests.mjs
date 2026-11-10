// breakdown stages 3-6: the stack readers on the golden repos (exact facts),
// URL resolution and route matching, the module rules, the graphify wrapper
// (with a fake graphify, plus the real one when installed), the full six-stage
// flow through the scripts, reruns ("already up to date", refresh without a
// new approval, new routes asking again), and that nothing outside sdlc-docs/
// changes and no secret is ever read.
//
//   node --test tests/map-tests.mjs

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildMapGolden } from './golden-map.mjs';
import { SECRET_MARKER } from './golden.mjs';
import { PLUGIN, runGuard } from './fixture.mjs';
import { makeReader } from '../scripts/lib/stacks.mjs';
import { secretTester } from '../scripts/lib/secretnames.mjs';
import { listFiles, maskSource, normUri, shapeOf, sourceCache } from '../scripts/lib/readers/common.mjs';
import { readLaravel } from '../scripts/lib/readers/laravel.mjs';
import { collectConsts, readCalls, resolveUrl, urlParts } from '../scripts/lib/readers/calls.mjs';
import { buildGraph, communities, findGraphify } from '../scripts/lib/graph.mjs';
import { expand, globToRegex, handlerMatches } from '../scripts/lib/modules.mjs';
import { matchCall } from '../scripts/breakdown/link.mjs';
import { parseYaml } from '../scripts/lib/yaml.mjs';

const G = buildMapGolden();
after(() => fs.rmSync(G.W, { recursive: true, force: true }));

const FAKE = path.join(PLUGIN, 'tests', 'fake-graphify.mjs');
fs.chmodSync(FAKE, 0o755);
const LOG = path.join(G.W, 'graphify.log');
const BD = path.join(PLUGIN, 'scripts', 'breakdown');
const ENV = { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN, TECH_PLUGIN_GRAPHIFY: FAKE, FAKE_GRAPHIFY_LOG: LOG };
function run(script, args, env = {}) {
  const r = spawnSync(process.execPath, [path.join(BD, script), ...args], { encoding: 'utf8', env: { ...ENV, ...env }, timeout: 120000 });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}
const ok = (r) => {
  assert.equal(r.code, 0, r.err || r.out);
  return r.out;
};
const status = (cwd) => JSON.parse(ok(run('state.mjs', ['status', '--cwd', cwd])));
const docs = (repo, f) => path.join(repo, 'sdlc-docs', f);
const readJ = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const facts = (repo) => readJ(docs(repo, `_map/${path.basename(repo)}/facts.json`));

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
function allText(dir) {
  let t = '';
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else t += fs.readFileSync(p, 'utf8');
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return t;
}
function put(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// a scratch repo for one reader, read in-process
function tmpRepo(files) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(G.W, 'r-')));
  for (const [f, t] of Object.entries(files)) put(path.join(d, f), t);
  const reader = makeReader(d, secretTester(PLUGIN, d));
  return { d, reader, files: listFiles(reader, '.'), src: sourceCache(reader) };
}

// ================================================================ stages 1-2 for every golden system (scripts, as the skill runs them)
function stage12(home, repos, configs = {}) {
  const input = path.join(G.W, `in-${path.basename(home)}.json`);
  fs.writeFileSync(input, JSON.stringify({ system: path.basename(home), home, repos: repos.map((r) => ({ path: r.path, role: r.role })), business: { product: 'Pulse reports for clinics', roles: ['Doctor', 'Patient'], environments: [{ name: 'production', url: 'https://api.example.com', production: true }] } }));
  ok(run('write.mjs', ['system', '--input', input]));
  for (const [repo, cfg] of Object.entries(configs)) fs.writeFileSync(docs(repo, 'config.json'), JSON.stringify(cfg));
  for (const r of repos) ok(run('detect.mjs', [r.path, '--write']));
  ok(run('write.mjs', ['profile', '--home', home]));
  ok(run('write.mjs', ['confirm', '--home', home, '--by', 'Test Person']));
}

const before = { backend: snapshot(G.backend), web: snapshot(G.web), mobile: snapshot(G.mobile), shop: snapshot(G.shop), py: snapshot(G.py), go: snapshot(G.go) };
const H = G.backend;
stage12(H, [{ path: G.backend, role: 'backend' }, { path: G.web, role: 'web' }, { path: G.mobile, role: 'mobile' }], { [G.backend]: { secretPatterns: ['*BridgeController.php'] }, [G.mobile]: { secretPatterns: ['keys_config.dart'] } });

// ================================================================ stage 3: readers on the golden repos
describe('stage 3: map.mjs on the Laravel + Flutter system', () => {
  const lines = {};
  test('maps each repo and prints one summary line', () => {
    for (const r of [G.backend, G.web, G.mobile]) lines[path.basename(r)] = ok(run('map.mjs', ['--repo', r, '--home', H]));
    assert.match(lines.backend, /^backend: backend \[laravel\]: 21 routes \(2 closures\), 5 handlers/);
    assert.match(lines.web, /^web: web \[laravel\]: 6 routes, 3 handlers, 17 screens, 5 API calls/);
    assert.match(lines.mobile, /^mobile: mobile \[flutter\]: 5 screens, 8 API calls \(1 unresolved\), 1 tables/);
    for (const l of Object.values(lines)) assert.match(l, /\| graph \d+ nodes, \d+ groups/);
  });
  test('backend: every route, with prefixes from groups, apiResource and the Laravel default', () => {
    const a = facts(G.backend).apps[0];
    assert.deepEqual(a.routes.map((r) => r.key).sort(), [
      'DELETE api/patients/{patient}', 'GET /', 'GET api/appointments', 'GET api/debug/phpinfo', 'GET api/me', 'GET api/patients', 'GET api/patients/{patient}', 'GET api/reports/{report}', 'GET api/reports/{report}/pdf',
      'PATCH api/patients/{patient}', 'POST api/appointments', 'POST api/login', 'POST api/logout', 'POST api/otp/verify', 'POST api/patients', 'POST api/payments/order', 'POST api/payments/verify', 'POST api/reports',
      'POST api/samvit/sync', 'POST api/webhooks/razorpay', 'PUT api/patients/{patient}',
    ].sort());
  });
  test('backend: handlers, middleware, citations and kinds', () => {
    const r = (k) => facts(G.backend).apps[0].routes.find((x) => x.key === k);
    assert.equal(r('POST api/login').handler, 'App\\Http\\Controllers\\AuthController@login');
    assert.equal(r('POST api/login').cite, 'routes/api.php:10');
    assert.deepEqual(r('GET api/me').middleware, ['auth:sanctum']);
    assert.deepEqual(r('POST api/login').middleware, []);
    assert.equal(r('GET api/patients/{patient}').action, 'show');
    assert.equal(r('GET api/patients/{patient}').kind, 'resource');
    assert.equal(r('GET api/debug/phpinfo').kind, 'closure');
    assert.equal(r('GET /').surface, 'page');
    assert.equal(r('POST api/login').surface, 'api');
  });
  test('backend: the commented-out route is not a route, and is counted', () => {
    const a = facts(G.backend).apps[0];
    assert.ok(!a.routes.some((x) => x.uri.includes('old')));
    assert.ok(a.notes.some((n) => /1 commented-out route line/.test(n)));
  });
  test('backend: a controller that is secret by the project rule is never opened, its route still listed', () => {
    const a = facts(G.backend).apps[0];
    const r = a.routes.find((x) => x.key === 'POST api/samvit/sync');
    assert.equal(r.controllerStatus, 'guarded');
    assert.ok(!a.handlers.some((h) => /Samvit/.test(h.id)));
    assert.ok(a.notes.some((n) => /never opened.*SamvitBridgeController/.test(n)));
  });
  test('backend: tables from migrations with columns, models with declared tables, handler method tables', () => {
    const a = facts(G.backend).apps[0];
    const t = (n) => a.tables.find((x) => x.name === n);
    assert.deepEqual(t('patients').columns, ['id', 'name', 'phone', 'created_at', 'updated_at']);
    assert.deepEqual(t('pulse_reports').models, ['Report']);
    assert.equal(t('pulse_reports').cite, 'database/migrations/2024_01_05_000000_create_pulse_reports_table.php:4');
    const pc = a.handlers.find((h) => h.name === 'PatientController');
    assert.deepEqual(pc.methods.find((m) => m.name === 'index').tables, ['patients']);
    assert.deepEqual(a.handlers.find((h) => h.name === 'AuthController').methods.find((m) => m.name === 'login').tables, ['otp_logs']);
  });
  test('backend: external services by file and line only', () => {
    const a = facts(G.backend).apps[0];
    const rz = a.externals.systems.find((s) => s.system === 'Razorpay');
    assert.ok(rz.files.some((f) => f.file === 'app/Http/Controllers/PaymentController.php' && f.lines.length));
    assert.ok(a.externals.otherHosts.some((h) => h.host === 'samvit.partner-api.in'));
  });
  test('web: Blade screens, partials, the views controllers render, and the route that reaches them', () => {
    const a = facts(G.web).apps[0];
    const s = (id) => a.screens.find((x) => x.id === id);
    assert.equal(s('layouts.app').partial, true);
    assert.deepEqual(s('patients.index').renderedBy, ['App\\Http\\Controllers\\PatientPageController@index']);
    assert.equal(s('patients.show').path, 'patients/{id}');
    assert.equal(s('welcome').path, '/');
    assert.deepEqual(s('dashboard').links, [{ kind: 'route-name', target: 'patients.index' }]);
  });
  test('web: Http:: calls resolved through config() and $this->baseUrl, credited to the view their method renders', () => {
    const c = facts(G.web).apps[0].calls;
    const by = (u) => c.find((x) => x.uri === u);
    assert.deepEqual([by('api/patients').method, by('api/patients').screen, by('api/patients').handler], ['GET', 'patients.index', 'App\\Http\\Controllers\\PatientPageController@index']);
    assert.equal(by('api/patients/{}').screen, 'patients.show');
    assert.equal(by('api/reports').method, 'POST');
    assert.equal(by('api/legacy/stats').screen, 'dashboard');
    const ajax = c.find((x) => x.routeName === 'patients.report');
    assert.deepEqual([ajax.method, ajax.screen], ['POST', 'patients.index']);
  });
  test('mobile: GoRouter screens with nested paths, navigation, local tables', () => {
    const a = facts(G.mobile).apps[0];
    assert.deepEqual(Object.fromEntries(a.screens.map((s) => [s.id, s.path])), { LoginScreen: '/', HomeScreen: 'home', PatientScreen: 'home/patients/{id}', BookingScreen: 'home/book', PaymentScreen: 'pay' });
    assert.deepEqual(a.screens.find((s) => s.id === 'LoginScreen').links, [{ kind: 'path', target: 'home' }]);
    assert.deepEqual(a.screens.find((s) => s.id === 'HomeScreen').links, [{ kind: 'route-name', target: 'book' }]);
    assert.deepEqual(a.tables.map((t) => [t.name, t.local]), [['cached_reports', true]]);
  });
  test('mobile: Dio calls through a base-URL getter and a StringsConst-style constant', () => {
    const c = facts(G.mobile).apps[0].calls;
    const got = c.filter((x) => x.resolved).map((x) => `${x.method} ${x.uri}`).sort();
    assert.deepEqual(got, ['GET patients/{}', 'POST appointments', 'POST feedback', 'POST login', 'POST otp/verify', 'POST payments/order', 'POST payments/verify'].sort());
    const login = c.find((x) => x.uri === 'login');
    assert.equal(login.viaConst, 'lib/constants/strings_const.dart:4');
    assert.equal(c.find((x) => x.uri === 'payments/verify').screen, 'PaymentScreen');
    const un = c.find((x) => !x.resolved);
    assert.equal(un.cite, 'lib/services/api_service.dart:13');
    assert.match(un.reason, /built at run time/);
  });
  test('no secret content anywhere in sdlc-docs/ (facts, graph, links)', () => {
    for (const r of [G.backend, G.web, G.mobile]) assert.ok(!allText(path.join(r, 'sdlc-docs')).includes(SECRET_MARKER), r);
  });
  test('facts.md is short and lists what needs a person', () => {
    const md = fs.readFileSync(docs(G.mobile, '_map/mobile/facts.md'), 'utf8');
    assert.match(md, /API calls whose URL is only known at run time/);
    assert.ok(md.split('\n').length < 80);
    assert.match(fs.readFileSync(docs(G.backend, '_map/backend/facts.md'), 'utf8'), /\| `routes\/api.php` \| `api` \| Laravel default \|/);
  });
});

describe('the code graph (graphify wrapper)', () => {
  const log = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  test('graphify ran offline and code-only, on a temp copy, then clustered without AI labels', () => {
    const ex = log().filter((x) => x.cmd === 'extract');
    assert.equal(ex.length, 3);
    for (const e of ex) {
      assert.equal(e.backend, 'none');
      assert.equal(e.codeOnly, true);
      assert.ok(e.cwd.startsWith(fs.realpathSync(os.tmpdir())) || e.cwd.includes('tp-graph-'), e.cwd);
    }
    assert.deepEqual(log().find((x) => x.cmd === 'cluster-only').flags, ['--no-viz', '--no-label']);
  });
  test('secret files (guard defaults and project rules) never reach graphify', () => {
    for (const e of log().filter((x) => x.cmd === 'extract')) {
      assert.ok(!e.contents.includes(SECRET_MARKER));
      assert.ok(!e.files.some((f) => /SamvitBridge|keys_config|\.env|\.pem|\.jks|google-services/.test(f)), e.files.join(','));
    }
  });
  test('only code files go to graphify; vendor and node_modules never', () => {
    const files = log().filter((x) => x.cmd === 'extract').flatMap((e) => e.files);
    assert.ok(files.every((f) => /\.(php|dart|js|ts|tsx|py|go|kt|java)$/.test(f)), files.filter((f) => !/\.(php|dart)$/.test(f)).join(','));
    assert.ok(!files.some((f) => /node_modules|vendor\//.test(f)));
  });
  test('the graph is kept in sdlc-docs with a stamp; temp copies are gone', () => {
    const d = docs(G.backend, '_map/graphify/backend');
    for (const f of ['graph.json', 'GRAPH_REPORT.md', 'communities.json', 'stamp.json']) assert.ok(fs.existsSync(path.join(d, f)), f);
    assert.equal(readJ(path.join(d, 'stamp.json')).commit, 'a'.repeat(40));
    assert.ok(!fs.readFileSync(path.join(d, 'GRAPH_REPORT.md'), 'utf8').includes('tp-graph-'));
  });
  test('a second run with no code change builds nothing', () => {
    const n = log().length;
    assert.match(ok(run('map.mjs', ['--repo', G.backend, '--home', H])), /already mapped at aaaaaaa; no code change/);
    assert.equal(log().length, n);
  });
  test('graphify missing: the stage goes on without the graph and says so', () => {
    const t = tmpRepo({ 'main.py': 'x = 1\n' });
    const r = buildGraph({ repo: t.d, name: 'x', files: t.files, outRel: 'g', stamp: { commit: null, tree: '1' }, bin: null, write: () => assert.fail('no write'), readStamp: () => null });
    assert.equal(r.status, 'missing');
    assert.match(r.message, /graphify is not installed/);
  });
  test('graphify failing: a clean message, no temp paths, nothing written', () => {
    const t = tmpRepo({ 'main.py': 'x = 1\n' });
    process.env.FAKE_GRAPHIFY_FAIL = '1';
    try {
      const r = buildGraph({ repo: t.d, name: 'x', files: t.files, outRel: 'g', stamp: { commit: null, tree: '1' }, bin: FAKE, write: () => assert.fail('no write'), readStamp: () => null });
      assert.equal(r.status, 'failed');
      assert.match(r.message, /graphify extract failed: boom in <temp copy>/);
    } finally {
      delete process.env.FAKE_GRAPHIFY_FAIL;
    }
  });
  test('communities: size, main folder and hubs', () => {
    const c = communities({ nodes: [{ id: 'a', label: 'AuthController', source_file: 'app/Http/A.php', community: 0 }, { id: 'b', label: 'x', source_file: 'app/Http/B.php', community: 0 }, { id: 'c', label: 'Z', source_file: 'lib/z.dart', community: 1 }], links: [{ source: 'a', target: 'b' }] });
    assert.deepEqual(c.map((x) => [x.id, x.size, x.folder]), [['c0', 2, 'app/Http'], ['c1', 1, 'lib']]);
    assert.equal(c[0].hubs[0], 'AuthController');
  });
  const real = findGraphify({ PATH: process.env.PATH });
  test('the real graphify, when installed: builds a graph of a copy and leaves the repo untouched', { skip: real ? false : 'graphify not installed' }, () => {
    const t = tmpRepo({ 'app/main.py': 'def a():\n    return b()\n\ndef b():\n    return 1\n', '.env': `X=${SECRET_MARKER}\n` });
    const beforeT = snapshot(t.d);
    const written = {};
    const r = buildGraph({ repo: t.d, name: 'x', files: t.files, outRel: 'g', stamp: { commit: null, tree: '1' }, bin: real, write: (rel, c) => (written[rel] = c), readStamp: () => null, timeoutMs: 120000 });
    assert.equal(r.status, 'built', r.message);
    assert.ok(r.nodes > 0);
    assert.ok(!Object.values(written).join('').includes(SECRET_MARKER));
    assert.deepEqual(snapshot(t.d), beforeT);
  });
});

// ================================================================ readers: edge cases (in-process)
describe('Laravel route parser edge cases', () => {
  const t = tmpRepo({
    'composer.json': '{"autoload":{"psr-4":{"App\\\\":"app/"}}}',
    'bootstrap/app.php': "<?php\nreturn Application::configure()->withRouting(\n    web: __DIR__.'/../routes/web.php',\n    api: __DIR__.'/../routes/api.php',\n    apiPrefix: 'api/v2',\n)->create();\n",
    'routes/api.php': `<?php
use App\\Http\\Controllers\\UserController as Users;
Route::group(['prefix' => 'admin', 'middleware' => ['auth', 'admin'], 'as' => 'admin.', 'namespace' => 'Admin'], function () {
    Route::get('stats', 'StatsController@index')->name('stats');
    Route::resource('photos.comments', CommentController::class)->only(['index', 'store']);
});
Route::controller(Users::class)->group(function () {
    Route::get('users', 'index');
});
Route::match(['get', 'post'], 'search', [Users::class, 'search']);
Route::resource('posts', \\App\\Http\\Controllers\\PostController::class)->except(['create', 'edit', 'destroy']);
Route::redirect('old', 'new');
Route::get('ping', function () {
    $s = "Route::get('fake', 'x')";
    return 1;
})->name('ping');
Route::get('dup', [Users::class, 'a']);
Route::get('dup', [Users::class, 'b']);
Route::middleware('throttle')->prefix('v')->group(base_path('routes/extra.php'));
Route::bogus('x');
Route::pattern('id', '[0-9]+');
`,
    'routes/extra.php': "<?php\nRoute::post('hook', [App\\Http\\Controllers\\HookController::class, 'handle']);\n",
    'routes/web.php': "<?php\nRoute::view('/', 'welcome');\n",
    'app/Http/Controllers/UserController.php': '<?php class UserController {}\n',
  });
  const r = readLaravel({ reader: t.reader, root: '.', files: t.files, src: t.src });
  const k = (key) => r.routes.find((x) => x.key === key && !x.shadowed);
  test('Laravel 11 apiPrefix from bootstrap/app.php', () => assert.ok(k('GET api/v2/users')));
  test('array groups: prefix, middleware, name prefix and legacy namespace', () => {
    const s = k('GET api/v2/admin/stats');
    assert.equal(s.handler, 'App\\Http\\Controllers\\Admin\\StatsController@index');
    assert.deepEqual(s.middleware, ['auth', 'admin']);
    assert.equal(s.name, 'admin.stats');
  });
  test('nested resource with only()', () => {
    assert.ok(k('GET api/v2/admin/photos/{photo}/comments'));
    assert.ok(k('POST api/v2/admin/photos/{photo}/comments'));
    assert.equal(r.routes.filter((x) => x.uri.includes('comments')).length, 2);
  });
  test('resource with except() and a fully qualified controller', () => {
    assert.deepEqual(r.routes.filter((x) => x.uri.startsWith('api/v2/posts')).map((x) => x.action).sort(), ['index', 'show', 'store', 'update', 'update']);
  });
  test('controller groups, match(), use-aliases', () => {
    assert.equal(k('GET api/v2/users').handler, 'App\\Http\\Controllers\\UserController@index');
    assert.ok(k('GET api/v2/search') && k('POST api/v2/search'));
  });
  test('closures: a string that looks like a route is not a route; the name after the closure is kept', () => {
    assert.equal(k('GET api/v2/ping').name, 'ping');
    assert.ok(!r.routes.some((x) => x.uri.endsWith('fake')));
  });
  test('shadowed duplicates: the later one wins', () => {
    assert.equal(k('GET api/v2/dup').action, 'b');
    assert.equal(r.routes.filter((x) => x.key === 'GET api/v2/dup' && x.shadowed).length, 1);
  });
  test('->group(base_path(...)) includes a file under the group prefix and middleware', () => {
    const h = k('POST api/v2/v/hook');
    assert.ok(h);
    assert.deepEqual(h.middleware, ['throttle']);
    assert.equal(h.cite, 'routes/extra.php:2');
  });
  test('Route::view and redirect; unknown Route:: lines are unparsed, known helpers ignored', () => {
    assert.equal(k('GET /').view, 'welcome');
    assert.equal(k('GET api/v2/old').action, 'redirect');
    assert.deepEqual(r.unparsed.map((u) => u.text), ["Route::bogus('x')"]);
  });
  test('controller file status: found or missing', () => {
    assert.equal(k('GET api/v2/users').controllerStatus, 'found');
    assert.equal(k('GET api/v2/admin/stats').controllerStatus, 'missing');
  });
});

describe('masking and URL resolution', () => {
  test('masking blanks comments and string contents, keeps offsets and lines', () => {
    const src = "a(); // b('x')\n/* c() */ d('y#z');";
    const m = maskSource(src, { hash: true });
    assert.equal(m.mask.length, src.length);
    assert.equal(m.mask.split('\n').length, 2);
    assert.ok(!m.mask.includes('b('));
    assert.ok(m.mask.includes("d('xxx')"));
  });
  test('normUri and shapeOf: one form for every framework', () => {
    assert.equal(normUri('/users/:id/'), 'users/{id}');
    assert.equal(normUri('items/<int:pk>'), 'items/{pk}');
    assert.equal(normUri('[slug]/x?a=1'), '{slug}/x');
    assert.equal(normUri('https://h.com/api/x'), 'api/x');
    assert.equal(normUri(''), '/');
    assert.equal(shapeOf('a/{id}/b/{x?}'), 'a/{}/b/{}');
  });
  const res = (code, lang, consts = new Map()) => {
    const m = maskSource(code, lang === 'php' ? { hash: true, multiline: true, backtick: false } : lang === 'py' ? { hash: true, slash: false, triple: true, backtick: false } : {});
    return resolveUrl(urlParts(code, m.mask, 0, code.length, lang), consts, null);
  };
  test('PHP concatenation with config() and interpolation', () => {
    assert.equal(res("config('app.backend_url') . '/api/x/' . $id", 'php').uri, 'api/x/{}');
    assert.equal(res('$this->apiUrl . "/v1/{$user->id}/items"', 'php').uri, 'v1/{}/items');
  });
  test('Dart and JS interpolation, query strings dropped', () => {
    assert.equal(res("'${Env.baseUrl}/orders/$id?page=2'", 'dart').uri, 'orders/{}');
    assert.equal(res('`${API_URL}/carts/${c.id}/items?x=${y}`', 'js').uri, 'carts/{}/items');
  });
  test('Python f-strings and format()', () => {
    assert.equal(res('f"{BASE_URL}/users/{uid}"', 'py').uri, 'users/{}');
    assert.equal(res('"/users/{}".format(uid)', 'py').uri, 'users/{}');
  });
  test('absolute URLs keep only the host name', () => {
    const r = res("'https://api.partner.com/v2/charge?key=SECRET'", 'js');
    assert.deepEqual([r.uri, r.host], ['v2/charge', 'api.partner.com']);
  });
  test('a bare variable is unresolved, with the variable name, never guessed', () => {
    const r = res('url', 'js');
    assert.equal(r.resolved, false);
    assert.match(r.reason, /built at run time from url/);
  });
  test('Laravel route() helpers and Blade {{ route() }} become route names', () => {
    assert.equal(res("route('patients.show')", 'php').routeName, 'patients.show');
    assert.equal(res('"{{ route(\'a.b\', 1) }}"', 'js').routeName, 'a.b');
  });
  test('constants are followed across files; a base-URL alias is dropped', () => {
    const t = tmpRepo({ 'src/api.ts': "const API = process.env.NEXT_PUBLIC_API_URL\nexport const ROUTES = { orders: '/orders' }\nexport const getOrders = () => fetch(`${API}${ROUTES.orders}`)\n" });
    const { calls } = readCalls({ files: t.files, src: t.src });
    assert.deepEqual(calls.map((c) => [c.method, c.uri]), [['GET', 'orders']]);
  });
  test('map.get(key), decorators and router definitions are not calls', () => {
    const t = tmpRepo({ 'a.ts': "const v = map.get('/x')\nrouter.get('/users', (req, res) => res.json([]))\n", 'b.py': '@app.get("/health")\ndef h():\n    return d.get("/a")\n' });
    assert.deepEqual(readCalls({ files: t.files, src: t.src }).calls, []);
  });
  test('extra base-URL names from overrides.yaml', () => {
    const t = tmpRepo({ 'lib/a.dart': "final r = dio.get('${Cfg.host}/x');\n" });
    const re = /(^|[^\w$])(Cfg\.host)([^\w$]|$)/;
    const { calls } = readCalls({ files: t.files, src: t.src, baseRe: re });
    assert.deepEqual([calls[0].uri, calls[0].class], ['x', 'Verified']);
    void collectConsts;
  });
});

describe('route matching (stage 4)', () => {
  const R = (key, app = 'b', extra = {}) => {
    const [method, uri] = key.split(' ');
    return { key, method, uri, shape: shapeOf(uri), app, ...extra };
  };
  const routes = [R('GET api/patients/{patient}'), R('GET api/patients/export'), R('POST api/patients'), R('GET patients/{id}', 'web', { surface: 'page' }), R('ANY api/hook')];
  const call = (method, uri, app = 'm') => ({ method, uri, shape: shapeOf(uri), app });
  test('exact shape', () => assert.equal(matchCall(call('GET', 'api/patients/{}'), routes).best.r.key, 'GET api/patients/{patient}'));
  test('a fixed part beats a parameter', () => assert.equal(matchCall(call('GET', 'api/patients/export'), routes).best.r.key, 'GET api/patients/export'));
  test('tail match when the call has no base path; marked as tail', () => {
    const m = matchCall(call('POST', 'patients'), routes).best;
    assert.deepEqual([m.r.key, m.how], ['POST api/patients', 'tail']);
  });
  test("another app's web page loses to an API route", () => assert.equal(matchCall(call('GET', 'patients/{}'), routes).best.r.key, 'GET api/patients/{patient}'));
  test('method mismatch is reported, ANY accepts every method', () => {
    assert.equal(matchCall(call('DELETE', 'api/patients'), routes).best.methodOk, false);
    assert.equal(matchCall(call('PUT', 'api/hook'), routes).best.methodOk, true);
  });
  test('no match at all', () => assert.equal(matchCall(call('GET', 'nothing/here'), routes), null));
});

describe('module rules (stage 5, deterministic)', () => {
  const app = {
    repo: 'b',
    routes: [
      { key: 'GET a/x', uri: 'a/x', handler: 'App\\Http\\Controllers\\AController@x', controller: 'App\\Http\\Controllers\\AController', handlerFile: 'app/Http/Controllers/AController.php', action: 'x', cite: 'routes/api.php:1', shadowed: false },
      { key: 'GET a/y', uri: 'a/y', handler: 'App\\Http\\Controllers\\AController@y', controller: 'App\\Http\\Controllers\\AController', handlerFile: 'app/Http/Controllers/AController.php', action: 'y', cite: 'routes/api.php:2', shadowed: false },
      { key: 'GET debug/z', uri: 'debug/z', handler: 'Closure', handlerFile: 'routes/api.php', action: 'Closure', cite: 'routes/api.php:3', shadowed: false },
    ],
    handlers: [{ id: 'App\\Http\\Controllers\\AController', name: 'AController', file: 'app/Http/Controllers/AController.php', methods: [] }],
    screens: [],
    calls: [],
    models: [],
    groups: [],
    externals: { systems: [] },
  };
  const sys = { apps: new Map([['b', app]]) };
  const base = (over = {}) => ({ backends: ['b'], modules: [{ id: 'aa', name: 'A', purpose: 'p', parts: [{ app: 'b', handlers: ['AController'] }] }], unassigned: [{ match: 'GET debug/*', reason: 'debug' }], ...over });
  test('a clean proposal: every route in one module or explained', () => {
    const r = expand(base(), sys);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.coverage, [{ app: 'b', routes: 3, assigned: 2, explained: 1, uncovered: [] }]);
  });
  test('an unexplained route blocks', () => assert.match(expand(base({ unassigned: [] }), sys).errors.join(), /1 route\(s\) are in no module and not explained \(first: GET debug\/z\)/));
  test('a route in two modules is a conflict', () => {
    const d = base();
    d.modules.push({ id: 'bb', name: 'B', parts: [{ app: 'b', extra_routes: ['GET a/x'] }] });
    assert.match(expand(d, sys).errors.join(), /claimed by aa and bb/);
  });
  test('exclude_routes moves a route out of a handler', () => {
    const d = base();
    d.modules[0].parts[0].exclude_routes = ['GET a/y'];
    d.modules.push({ id: 'bb', name: 'B', parts: [{ app: 'b', extra_routes: ['GET a/y'] }] });
    const r = expand(d, sys);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.modules[1].routes.map((x) => x.key), ['GET a/y']);
  });
  test('bad ids, duplicates, unknown handler/route/app, risk without reason, unassigned without reason', () => {
    const d = { backends: ['b', 'zz'], modules: [{ id: 'Bad_Id', name: 'x', parts: [{ app: 'b', handlers: ['Nope'], extra_routes: ['GET none'] }] }, { id: 'aa', name: 'A', risk: [{ flag: 'money' }, { flag: 'fun', reason: 'r' }], parts: [{ app: 'q' }] }, { id: 'aa', name: 'A2', parts: [] }], unassigned: [{ match: 'GET a/*' }] };
    const e = expand(d, sys).errors.join('\n');
    for (const re of [/bad module id "Bad_Id"/, /duplicate module id "aa"/, /unknown handler "Nope"/, /unknown route "GET none"/, /unknown app "q"/, /unknown backend app "zz"/, /risk flag money needs a reason/, /unknown risk flag "fun"/, /needs a reason/]) assert.match(e, re);
  });
  test('an approved module cannot vanish without --allow-remove', () => {
    const existing = { modules: [{ id: 'aa' }, { id: 'gone' }] };
    assert.match(expand(base(), sys, { existing }).errors.join(), /module gone was approved before/);
    assert.deepEqual(expand(base(), sys, { existing, allowRemove: ['gone'] }).errors, []);
  });
  test('risk flags make a module critical; size from routes and screens', () => {
    const d = base();
    d.modules[0].risk = [{ flag: 'money', reason: 'pays' }];
    const m = expand(d, sys).modules[0];
    assert.deepEqual([m.critical, m.size], [true, 'S']);
  });
  test('handler names: short, full, file, folder, Class (Nest/Spring)', () => {
    const r = app.routes[0];
    for (const h of ['AController', 'acontroller', 'App\\Http\\Controllers\\AController', 'app/Http/Controllers/AController.php', 'app/Http/Controllers']) assert.ok(handlerMatches(r, h), h);
    assert.ok(handlerMatches({ handler: 'UsersController.findOne', handlerFile: 'src/u.ts' }, 'UsersController'));
    assert.ok(!handlerMatches(r, 'BController'));
  });
  test('unassigned matches: method and * globs', () => {
    const g = globToRegex('GET api/debug/*');
    assert.deepEqual([g.method, g.re.test('api/debug/phpinfo'), g.re.test('api/x')], ['GET', true, false]);
    assert.equal(globToRegex('webhooks/*').method, '*');
  });
});

// ================================================================ stages 4-6 end to end (nadi)
describe('stages 4-6 end to end (Laravel + Flutter system)', () => {
  const S = (p) => path.join(H, 'sdlc-docs', p);
  test('after stage 3: next is stage 4', () => assert.equal(status(G.nadi).next, 4));
  test('stage 4 links: summary lines per app and per backend', () => {
    const out = ok(run('link.mjs', ['--home', H]));
    assert.match(out, /^web: 5 calls: 4 matched \(3 with a screen\), 0 method mismatch, 1 no route, 0 unresolved/m);
    assert.match(out, /^mobile: 8 calls: 6 matched \(1 with a screen\), 0 method mismatch, 1 no route, 1 unresolved/m);
    assert.match(out, /^backend: 21 routes: 8 called by an app, 1 pages people open directly, 12 not called by any app in this system$/m);
  });
  test('links: mobile calls without the base path reach the API routes (Inferred), not the web pages', () => {
    const L = readJ(S('_map/links.json'));
    const c = (cite) => L.calls.find((x) => x.cite === cite);
    assert.deepEqual([c('lib/services/api_service.dart:9').route, c('lib/services/api_service.dart:9').how, c('lib/services/api_service.dart:9').class], [{ app: 'backend', key: 'GET api/patients/{patient}' }, 'tail', 'Inferred']);
    assert.deepEqual(c('lib/services/api_service.dart:7').route, { app: 'backend', key: 'POST api/login' });
    assert.equal(L.calls.find((x) => x.routeName === 'patients.report').route.key, 'POST patients/{id}/report');
  });
  test('links.md lists calls with no route (likely bugs) and routes nothing calls', () => {
    const md = fs.readFileSync(S('_map/links.md'), 'utf8');
    assert.match(md, /## Calls with no matching route \(2\)[\s\S]*DashboardController\.php:11` \(web\) GET `api\/legacy\/stats`[\s\S]*api_service\.dart:12` \(mobile\) POST `feedback`/);
    assert.match(md, /## Routes in backend that no app in this system calls \(12\)/);
  });
  test('overrides.yaml was created for the person, with an explanation, and is never rewritten', () => {
    const t = fs.readFileSync(S('_map/overrides.yaml'), 'utf8');
    assert.match(t, /You own this file/);
    assert.deepEqual(parseYaml(t), { base_url_names: [], externals: [], links: [] });
  });
  test('stage 5 candidates: compact material for the agent', () => {
    ok(run('modules.mjs', ['candidates', '--home', H]));
    const c = fs.readFileSync(S('_map/candidates.md'), 'utf8');
    assert.match(c, /\*\*Backend apps \(routes must all be covered\):\*\* backend$/m);
    assert.match(c, /\| PatientController \| 6 \| api\/patients \(6\) \| auth:sanctum \| patients \|  \| web, mobile \|/);
    assert.match(c, /\| `resources\/views\/patients` \| patients\.index, patients\.show \|/);
    assert.ok(c.split('\n').length < 200);
    assert.ok(!c.includes(SECRET_MARKER));
  });
  test('routes query: narrow answers for the agent', () => {
    const out = ok(run('modules.mjs', ['routes', '--home', H, '--app', 'backend', '--handler', 'Payment']));
    assert.match(out, /POST api\/payments\/order\tApp\\Http\\Controllers\\PaymentController@createOrder\troutes\/api\.php:\d+/);
    assert.match(out, /\(3 route\(s\)\)/);
  });
  const proposal = fs.readFileSync(path.join(PLUGIN, 'tests', 'fixtures', 'nadi-proposal.yaml'), 'utf8');
  test('preview of an incomplete proposal fails and names the unexplained routes', () => {
    fs.writeFileSync(S('_map/module-proposal.yaml'), proposal.replace(/unassigned:[\s\S]*$/, 'unassigned: []\n'));
    const r = run('modules.mjs', ['preview', '--home', H]);
    assert.equal(r.code, 1);
    assert.match(r.out, /backend: 2 route\(s\) are in no module and not explained/);
    assert.ok(!fs.existsSync(S('modules.yaml')));
  });
  test('preview of the full proposal: table, coverage, reasons; writes nothing; stage 5 awaits approval', () => {
    fs.writeFileSync(S('_map/module-proposal.yaml'), proposal);
    const out = ok(run('modules.mjs', ['preview', '--home', H]));
    assert.match(out, /\| patients \| Patients \| backend: 1 handlers; web: 1 handlers; mobile: 1 screens \| 6 \| 3 \| 3 \| 1 \| personal-data \| M \|/);
    assert.match(out, /Coverage \(backend\): 19 of 21 routes in a module, 2 unassigned with a reason, 0 neither\./);
    assert.match(out, /backend: GET api\/debug\/\* \(1\): debug page/);
    assert.ok(!fs.existsSync(S('modules.yaml')));
    assert.equal(status(H).next, 5);
    assert.match(status(H).message, /waiting for your approval/);
  });
  test('write after the yes: modules.yaml with the approver, derived lists and depends_on evidence', () => {
    assert.match(ok(run('modules.mjs', ['write', '--home', H, '--by', 'Asha Rao'])), /wrote sdlc-docs\/modules\.yaml: 6 modules, approved by Asha Rao/);
    const y = parseYaml(fs.readFileSync(S('modules.yaml'), 'utf8'));
    assert.equal(y.approved.by, 'Asha Rao');
    const p = y.modules.find((m) => m.id === 'patients');
    assert.deepEqual(p.depends_on, ['reports']);
    assert.deepEqual(p.depends_evidence.reports, ['app/Http/Controllers/PatientPageController.php:19 -> POST api/reports']);
    assert.deepEqual(p.screens, ['web|patients.index', 'web|patients.show', 'mobile|PatientScreen']);
    assert.deepEqual(p.tables, ['patients']);
    assert.equal(y.modules.find((m) => m.id === 'payments').external_systems[0], 'Razorpay');
    assert.deepEqual(y.unassigned.map((u) => u.routes), [['GET api/debug/phpinfo'], ['GET /']]);
    assert.equal(status(H).next, 6);
  });
  test('stage 6 writes the catalogue, cards, overview and module map', () => {
    assert.match(ok(run('catalogue.mjs', ['--home', H])), /wrote 9 files[\s\S]*suggested order: reports, patients/);
    const cat = fs.readFileSync(S('modules/README.md'), 'utf8');
    assert.match(cat, /\*\*Coverage \(backend\):\*\* 19 of 21 routes in a module; 2 unassigned with a reason\./);
    assert.match(cat, /1\. `\/tech-plugin:document reports`: Pulse reports \(critical\)/);
    const card = fs.readFileSync(S('modules/patients/module.md'), 'utf8');
    assert.match(card, /\| GET \| `api\/patients` \| PatientController@index \| 1 \| `backend:routes\/api\.php:16` \|/);
    assert.match(card, /\| mobile \| PatientScreen \| `home\/patients\/\{id\}` \|/);
    assert.match(card, /\*\*Uses:\*\* \[reports\]\(\.\.\/reports\/module\.md\)/);
    const map = fs.readFileSync(S('system/diagrams/module-map.md'), 'utf8');
    assert.match(map, /```mermaid\nflowchart LR/);
    assert.match(map, /patients --> reports/);
    assert.match(map, /- patients → reports: `app\/Http\/Controllers\/PatientPageController\.php:19` calls `POST api\/reports`/);
    assert.match(fs.readFileSync(S('system/overview.md'), 'utf8'), /Pulse reports for clinics/);
    assert.match(fs.readFileSync(S('glossary.md'), 'utf8'), /\| pulse_reports \| To be confirmed \(found in code\) \|/);
    assert.match(fs.readFileSync(S('README.md'), 'utf8'), /`modules\/README\.md` \| Module catalogue/);
  });
  test('second run with no code change: already up to date, from any repo or the workspace', () => {
    for (const cwd of [G.nadi, H, G.mobile]) {
      const s = status(cwd);
      assert.equal(s.next, 'up-to-date', cwd);
      assert.match(s.message, /Already up to date/);
    }
  });
  test('a code change with no route change: stage 3 for that repo only, then a refresh needs no approval', () => {
    fs.appendFileSync(path.join(G.mobile, 'lib/screens/home_screen.dart'), '\n// tweak\n');
    const s = status(G.nadi);
    assert.deepEqual([s.next, s.repos.filter((r) => r.codeChanged).map((r) => r.name), s.repos.filter((r) => r.changed).length], [3, ['mobile'], 0]);
    ok(run('map.mjs', ['--repo', G.mobile, '--home', H]));
    ok(run('link.mjs', ['--home', H]));
    assert.equal(status(H).next, 5);
    assert.match(ok(run('modules.mjs', ['refresh', '--home', H])), /refreshed: no module changes/);
    assert.equal(status(H).next, 6);
    ok(run('catalogue.mjs', ['--home', H]));
    assert.equal(status(H).next, 'up-to-date');
  });
  test('the person\'s notes in a card survive a rewrite', () => {
    const f = S('modules/auth/module.md');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/_Add your notes here[^\n]*_/, 'OTP provider is MSG91.'));
    ok(run('catalogue.mjs', ['--home', H]));
    assert.match(fs.readFileSync(f, 'utf8'), /<!-- notes:start[^\n]*-->\nOTP provider is MSG91\.\n<!-- notes:end -->/);
  });
  test('new routes: the diff shows them and the refresh asks for approval again', () => {
    fs.appendFileSync(path.join(G.backend, 'routes/api.php'), "Route::get('patients/{patient}/history', [PatientController::class, 'history']);\nRoute::get('stats', [App\\Http\\Controllers\\StatsController::class, 'index']);\n");
    ok(run('map.mjs', ['--repo', G.backend, '--home', H]));
    ok(run('link.mjs', ['--home', H]));
    const r = run('modules.mjs', ['refresh', '--home', H]);
    assert.equal(r.code, 1);
    const d = JSON.parse(r.out.slice(0, r.out.lastIndexOf('}') + 1));
    assert.deepEqual(d.added, ['backend|GET api/patients/{patient}/history', 'backend|GET api/stats']);
    assert.deepEqual(d.unexplained, ['backend|GET api/stats']);
    assert.equal(status(H).next, 5);
  });
  test('reopen keeps ids and names; after placing the new route the new approval goes through', () => {
    ok(run('modules.mjs', ['reopen', '--home', H]));
    const p = fs.readFileSync(S('_map/module-proposal.yaml'), 'utf8');
    assert.deepEqual(parseYaml(p).modules.map((m) => m.id), ['auth', 'patients', 'reports', 'appointments', 'payments', 'partner-sync']);
    fs.writeFileSync(S('_map/module-proposal.yaml'), p.replace('unassigned:', 'unassigned:\n  - match: "GET api/stats"\n    reason: internal dashboard numbers'));
    ok(run('modules.mjs', ['preview', '--home', H]));
    ok(run('modules.mjs', ['write', '--home', H, '--by', 'Asha Rao']));
    assert.ok(parseYaml(fs.readFileSync(S('modules.yaml'), 'utf8')).modules.find((m) => m.id === 'patients').routes.includes('backend|GET api/patients/{patient}/history'));
    ok(run('catalogue.mjs', ['--home', H]));
    assert.equal(status(H).next, 'up-to-date');
    assert.ok(fs.existsSync(S('_map/modules.yaml.prev')));
  });
  test('dropping an approved module needs --allow-remove', () => {
    ok(run('modules.mjs', ['reopen', '--home', H]));
    const y = parseYaml(fs.readFileSync(S('_map/module-proposal.yaml'), 'utf8'));
    const p = fs.readFileSync(S('_map/module-proposal.yaml'), 'utf8').replace(/  - id: partner-sync[\s\S]*?(?=unassigned:)/, '');
    fs.writeFileSync(S('_map/module-proposal.yaml'), p.replace('unassigned:', 'unassigned:\n  - match: "POST api/samvit/*"\n    reason: partner calls, no module yet'));
    assert.equal(y.modules.length, 6);
    const r = run('modules.mjs', ['preview', '--home', H]);
    assert.equal(r.code, 1);
    assert.match(r.out, /module partner-sync was approved before and is missing/);
    ok(run('modules.mjs', ['preview', '--home', H, '--allow-remove', 'partner-sync']));
  });
  test('overrides.yaml links: ignore a call or point it at a route', () => {
    const o = S('_map/overrides.yaml');
    const keep = fs.readFileSync(o, 'utf8');
    fs.writeFileSync(o, keep.replace('links: []', 'links:\n  - source: "lib/services/api_service.dart:13"\n    ignore: "debug helper"\n  - source: "lib/services/api_service.dart:12"\n    route: "POST api/reports"\n  - source: "nowhere.dart:1"\n    ignore: "x"'));
    const out = ok(run('link.mjs', ['--home', H]));
    assert.match(out, /mobile: 8 calls: 7 matched .* 0 no route, 0 unresolved.*1 ignored/);
    assert.match(out, /overrides that match no call: nowhere\.dart:1/);
    fs.writeFileSync(o, keep);
    ok(run('link.mjs', ['--home', H]));
  });
  test('nothing outside sdlc-docs/ changed in any repo, except the files the test itself edited', () => {
    const b = snapshot(G.backend);
    delete b['routes/api.php'];
    const bb = { ...before.backend };
    delete bb['routes/api.php'];
    assert.deepEqual(b, bb);
    assert.deepEqual(snapshot(G.web), before.web);
    const m = snapshot(G.mobile);
    delete m['lib/screens/home_screen.dart'];
    const mb = { ...before.mobile };
    delete mb['lib/screens/home_screen.dart'];
    assert.deepEqual(m, mb);
  });
  test('no secret content anywhere in any sdlc-docs/', () => {
    for (const r of [G.backend, G.web, G.mobile]) assert.ok(!allText(path.join(r, 'sdlc-docs')).includes(SECRET_MARKER), r);
  });
});

// ================================================================ non-Laravel systems, broken down to stage 6
describe('non-Laravel systems: Express + Next.js monorepo, FastAPI, and Go (generic reader)', () => {
  const flow = (repo, proposal) => {
    stage12(repo, [{ path: repo, role: 'backend' }]);
    const line = ok(run('map.mjs', ['--repo', repo, '--home', repo]));
    const links = ok(run('link.mjs', ['--home', repo]));
    ok(run('modules.mjs', ['candidates', '--home', repo]));
    fs.writeFileSync(docs(repo, '_map/module-proposal.yaml'), proposal);
    const pv = run('modules.mjs', ['preview', '--home', repo]);
    assert.equal(pv.code, 0, pv.out);
    ok(run('modules.mjs', ['write', '--home', repo, '--by', 'T']));
    ok(run('catalogue.mjs', ['--home', repo]));
    return { line, links, preview: pv.out };
  };
  test('shop: Express routes under their mounts, Next pages and API route, web calls linked to the API', () => {
    const r = flow(G.shop, 'backends:\n  - shop/apps/api\nmodules:\n  - id: catalogue\n    name: Product catalogue\n    purpose: Lists products.\n    parts:\n      - app: shop/apps/api\n        handlers: [apps/api/src/controllers/products.ts]\n      - app: shop/apps/web\n        paths: [apps/web/app/products, apps/web/lib]\n  - id: orders\n    name: Orders\n    purpose: Takes orders and payments.\n    risk:\n      - flag: money\n        reason: Stripe payments\n    parts:\n      - app: shop/apps/api\n        handlers: [apps/api/src/controllers/orders.ts]\n      - app: shop/apps/web\n        paths: [apps/web/app/cart]\nunassigned:\n  - match: "GET health"\n    reason: health check for the load balancer\n');
    assert.match(r.line, /shop\/apps\/api \[node\]: 6 routes \(1 closures\), 3 handlers, 2 tables, services: Stripe/);
    assert.match(r.line, /shop\/apps\/web \[web\]: 1 routes, 1 handlers, 4 screens, 3 API calls/);
    const api = facts(G.shop).apps.find((a) => a.id === 'shop/apps/api');
    assert.deepEqual(api.routes.map((x) => x.key).sort(), ['GET api/orders/{id}', 'GET api/products', 'GET api/products/{id}', 'GET health', 'POST api/orders', 'POST api/orders/{id}/pay']);
    assert.equal(api.routes.find((x) => x.key === 'POST api/orders').handler, 'apps/api/src/controllers/orders.ts#createOrder');
    assert.deepEqual(api.routes.find((x) => x.key === 'POST api/orders').middleware, ['auth']);
    assert.deepEqual(api.tables.map((t) => t.name).sort(), ['Product', 'orders']);
    assert.deepEqual(api.handlers.find((h) => h.file.endsWith('orders.ts')).tables, ['orders']);
    const web = facts(G.shop).apps.find((a) => a.id === 'shop/apps/web');
    assert.deepEqual(web.screens.map((s) => s.path).sort(), ['/', 'cart', 'products', 'products/{id}']);
    assert.equal(web.routes[0].key, 'POST api/revalidate');
    assert.match(r.links, /shop\/apps\/web: 3 calls: 3 matched \(1 with a screen\)/);
    assert.match(r.preview, /Coverage \(shop\/apps\/api\): 5 of 6 routes in a module, 1 unassigned with a reason, 0 neither\./);
    const y = parseYaml(fs.readFileSync(docs(G.shop, 'modules.yaml'), 'utf8'));
    assert.deepEqual(y.modules.find((m) => m.id === 'catalogue').screens.sort(), ['shop/apps/web|products', 'shop/apps/web|products/{id}']);
    assert.deepEqual(y.modules.find((m) => m.id === 'orders').external_systems, ['Stripe']);
    assert.equal(status(G.shop).next, 'up-to-date');
  });
  test('pyapp: FastAPI routes with include_router prefixes, api_route methods, SQLAlchemy tables', () => {
    const r = flow(G.py, 'backends:\n  - pyapp\nmodules:\n  - id: users\n    name: Users\n    purpose: Manages users.\n    parts:\n      - app: pyapp\n        handlers: [app/routers/users.py]\n  - id: items\n    name: Items\n    purpose: Manages items.\n    parts:\n      - app: pyapp\n        handlers: [app/routers/items.py]\nunassigned:\n  - match: "GET health"\n    reason: health check\n');
    assert.match(r.line, /pyapp \[python\]: 7 routes, 3 handlers, 2 tables/);
    const a = facts(G.py).apps[0];
    assert.deepEqual(a.routes.map((x) => x.key).sort(), ['DELETE api/items/{item_id}', 'GET api/items', 'GET api/users', 'GET api/users/{user_id}', 'GET health', 'POST api/users', 'PUT api/items/{item_id}']);
    assert.equal(a.routes.find((x) => x.key === 'GET api/users/{user_id}').handler, 'app/routers/users.py#get_user');
    assert.deepEqual(a.calls, []);
    assert.deepEqual(a.handlers.find((h) => h.file === 'app/routers/users.py').tables, ['users']);
    assert.equal(status(G.py).next, 'up-to-date');
  });
  test('goapp: no dedicated reader; the generic one finds Gin routes (Inferred) and graph groups', () => {
    const r = flow(G.go, 'backends:\n  - goapp\nmodules:\n  - id: orders\n    name: Orders\n    purpose: Orders API.\n    parts:\n      - app: goapp\n        handlers: [main.go]\n        groups: [c1]\n');
    assert.match(r.line, /goapp \[generic\]: 3 routes, 1 handlers, 2 code groups/);
    const a = facts(G.go).apps[0];
    assert.deepEqual(a.routes.map((x) => [x.key, x.class]), [['GET v1/orders', 'Inferred'], ['POST v1/orders', 'Inferred'], ['GET health', 'Inferred']]);
    assert.deepEqual(a.groups.map((g) => g.label).sort(), ['.', 'orders']);
    assert.equal(status(G.go).next, 'up-to-date');
  });
  test('nothing outside sdlc-docs/ changed in these repos', () => {
    assert.deepEqual(snapshot(G.shop), before.shop);
    assert.deepEqual(snapshot(G.py), before.py);
    assert.deepEqual(snapshot(G.go), before.go);
  });
});

describe('empty repo: stage 3 has nothing to read', () => {
  test('map.mjs on an empty repo says so and records the stamp', () => {
    const input = path.join(G.W, 'blank3.json');
    fs.writeFileSync(input, JSON.stringify({ system: 'New', home: G.blank, repos: [{ path: G.blank }], business: {} }));
    ok(run('write.mjs', ['system', '--input', input]));
    ok(run('detect.mjs', [G.blank, '--write']));
    ok(run('write.mjs', ['confirm', '--home', G.blank, '--by', 'T']));
    assert.match(ok(run('map.mjs', ['--repo', G.blank, '--home', G.blank])), /^blank: no code yet, nothing to read$/m);
  });
  test('strict projects stop when graphify is missing', () => {
    const t = path.join(G.W, 'strictrepo');
    put(path.join(t, 'main.py'), 'from fastapi import FastAPI\napp = FastAPI()\n');
    put(path.join(t, 'pyproject.toml'), '[project]\nname="s"\ndependencies=["fastapi"]\n');
    spawnSync('git', ['init', '-q', t]);
    const input = path.join(G.W, 'strict.json');
    fs.writeFileSync(input, JSON.stringify({ system: 'S', home: t, repos: [{ path: t }], business: {} }));
    ok(run('write.mjs', ['system', '--input', input]));
    fs.writeFileSync(docs(t, 'config.json'), '{"strict": true}');
    ok(run('detect.mjs', [t, '--write']));
    const r = run('map.mjs', ['--repo', t, '--home', t], { TECH_PLUGIN_GRAPHIFY: path.join(G.W, 'no-such-graphify') });
    assert.equal(r.code, 1);
    assert.match(r.err, /graphify is not installed and this project is strict/);
  });
});

// ================================================================ guard wiring and definitions
describe('stages 3-6 under the guard', () => {
  const env = { HOME: path.join(G.W, 'home') };
  const bash = (cwd, command) => runGuard({ tool_name: 'Bash', cwd, tool_input: { command } }, { env }).decision;
  test('the stage 3-6 scripts run in a repo on main (trusted plugin scripts)', () => {
    for (const c of [`node "$CLAUDE_PLUGIN_ROOT/scripts/breakdown/map.mjs" --repo "${G.backend}" --home "${H}"`, `node "$CLAUDE_PLUGIN_ROOT/scripts/breakdown/link.mjs" --home "${H}"`, `node "$CLAUDE_PLUGIN_ROOT/scripts/breakdown/modules.mjs" preview --home "${H}"`, `node "$CLAUDE_PLUGIN_ROOT/scripts/breakdown/catalogue.mjs" --home "${H}"`]) assert.equal(bash(G.backend, c), 'pass', c);
  });
  test('the agent may write the proposal and the person may edit overrides inside sdlc-docs/', () => {
    const w = (p) => runGuard({ tool_name: 'Write', cwd: G.backend, tool_input: { file_path: p, content: 'x' } }, { env }).decision;
    assert.equal(w(path.join(G.backend, 'sdlc-docs/_map/module-proposal.yaml')), 'pass');
    assert.equal(w(path.join(G.backend, 'sdlc-docs/_map/overrides.yaml')), 'pass');
    assert.equal(w(path.join(G.backend, 'app/Http/Controllers/X.php')), 'block:repo-write');
  });
  test('running graphify by hand inside a repo is still blocked (only the plugin script may)', () => {
    assert.match(bash(G.backend, 'graphify extract . --code-only'), /^block:/);
  });
});

describe('module-proposer agent and stage guides', () => {
  const agent = fs.readFileSync(path.join(PLUGIN, 'agents/module-proposer.md'), 'utf8');
  test('Opus, high effort (stage 5 is judgement), never writes modules.yaml itself', () => {
    assert.match(agent, /^model: opus$/m);
    assert.match(agent, /^effort: high$/m);
    assert.match(agent, /^tools: Read, Grep, Glob, Bash, Write$/m);
    assert.match(agent, /never writes modules\.yaml/);
    assert.match(agent, /Never read whole `facts\.json`/);
  });
  test('the stage guides exist and the approval stays with the person', () => {
    for (const n of ['stage-3-read.md', 'stage-4-link.md', 'stage-5-modules.md', 'stage-6-write.md', 'modules-schema.md']) assert.ok(fs.existsSync(path.join(PLUGIN, 'references/breakdown', n)), n);
    assert.match(fs.readFileSync(path.join(PLUGIN, 'references/breakdown/stage-5-modules.md'), 'utf8'), /Never run `write` without the user's yes/);
  });
});

// ================================================================ fixes from the first real run (a Laravel web app with its backend outside the system)
describe('real-run fixes: a Laravel web app whose backend is not in the system', () => {
  const R = path.join(G.W, 'webonly');
  put(path.join(R, 'composer.json'), JSON.stringify({ require: { 'laravel/framework': '^10.0' }, autoload: { 'psr-4': { 'App\\': 'app/' } } }));
  put(path.join(R, 'artisan'), '#!/usr/bin/env php\n');
  put(path.join(R, 'routes/web.php'), `<?php
use App\\Http\\Controllers\\PatientController;
use App\\Http\\Controllers\\PlanController;
Route::get('patients', [PatientController::class, 'index']);
Route::post('patient/addClient', [PatientController::class, 'add']);
Route::delete('deleteReport/{medicalId}/{patientId}', [PatientController::class, 'deleteReport']);
Route::post('verify-login-otp', [PatientController::class, 'otp']);
Route::post('verify-email-login-otp', [PatientController::class, 'emailOtp']);
Route::post('getPlanStatus', [PlanController::class, 'status'])->name('getPlanStatus');
Route::get('medical-assessment-v3', [PatientController::class, 'assessment']);
Route::get('/', [PatientController::class, 'home']);
`);
  put(path.join(R, 'app/Http/Controllers/PatientController.php'), `<?php
namespace App\\Http\\Controllers;
use Illuminate\\Support\\Facades\\Http;
class PatientController extends Controller
{
    protected $apiUrl;
    public function __construct() { $this->apiUrl = config('app.backend_url'); }
    public function index() {
        $list = Http::post(config('app.backend_url') . '/patients');
        return view('patients.index', ['list' => $list]);
    }
    public function add() {
        $apiUrl = config('app.backend_url') . 'patient/addClient';
        return Http::post($apiUrl, ['x' => 1]);
    }
    public function deleteReport() { return Http::post($this->apiUrl . '/custom-data/getContentTypesWiseData'); }
    public function home() { return Http::asJson()->post($this->backendTourUrl('/welcome-tour/complete')); }
    public function otp() { return Http::get($dummyUrls['x'] . '?key=abc123'); }
    private function backendTourUrl(string $path): string { return rtrim(config('app.backend_url'), '/') . $path; }
}
`);
  put(path.join(R, 'app/Http/Controllers/PlanController.php'), '<?php\nnamespace App\\Http\\Controllers;\nclass PlanController extends Controller {}\n');
  put(path.join(R, 'resources/views/patients/index.blade.php'), `@extends('layouts.main')
<script src="{{ asset('js/patients.js') }}"></script>
<script>
  window.planStatusUrl = "{{ route('getPlanStatus') }}";
  var requestUrl = '/medical-assessment-v3' + buildStateQuery({ tab: 1 });
  $.ajax({ url: requestUrl, type: 'GET' });
</script>
`);
  put(path.join(R, 'resources/views/layouts/main.blade.php'), '<script src="{{ asset(\'js/common.js\') }}"></script>@yield("content")\n');
  put(path.join(R, 'resources/views/other.blade.php'), '@extends("layouts.main")\n');
  put(path.join(R, 'public/js/patients.js'), `function login(isPhone) {
  let url = isPhone ? '/verify-login-otp' : '/verify-email-login-otp';
  $.ajax({ url: url, type: 'POST' });
}
function plan() { $.post(window.planStatusUrl); }
function check(event) {
  const dropdown = event?.currentTarget || event?.target;
  changeTimes.delete(dropdown);
}
fetch('https://x123.lambda-url.ap-south-1.on.aws/', { method: 'POST' });
$.getJSON('../json/states.json');
`);
  put(path.join(R, 'public/js/common.js'), "const cfg = { target: '/medical-assessment-v3' };\n$.post('/getPlanStatus');\n");
  put(path.join(R, 'public/js/jquery-dataTables.js'), "var s = 'stripe'; $.ajax({ url: '/vendor-call' });\n// https://jsperf.com/x\n");
  spawnSync('git', ['init', '-q', '-b', 'main', R]);
  spawnSync('git', ['-C', R, 'add', '-A']);
  let calls;
  let links;
  test('stages 1-4 run on a single web repo', () => {
    stage12(R, [{ path: R, role: 'web' }]);
    ok(run('map.mjs', ['--repo', R, '--home', R, '--no-graph']));
    ok(run('link.mjs', ['--home', R]));
    calls = facts(R).apps[0].calls;
    links = readJ(docs(R, '_map/links.json')).calls;
  });
  const by = (re) => calls.filter((c) => re.test(c.cite));
  const st = (cite) => links.find((c) => c.cite === cite);
  test('server-side calls never match the app\'s own routes; with no backend in the system they are "outside this system"', () => {
    const c = by(/PatientController\.php:9$/)[0];
    assert.deepEqual([c.uri, c.side, c.base], ['patients', 'server', true]);
    assert.equal(st(c.cite).status, 'outside-system');
    assert.equal(st(by(/PatientController\.php:14$/)[0].cite).status, 'outside-system');
    assert.ok(!links.some((l) => l.status === 'method-mismatch' && /Controllers/.test(l.cite)));
    assert.match(fs.readFileSync(docs(R, '_map/links.md'), 'utf8'), /## Calls to a backend that is not in this system \(\d+\)/);
  });
  test('a local variable assigned in the same function is followed ($apiUrl = config() . "x")', () => assert.equal(by(/PatientController\.php:14$/)[0].uri, 'patient/addClient'));
  test('a property set in the constructor is followed ($this->apiUrl)', () => assert.equal(by(/PatientController\.php:16$/)[0].uri, 'custom-data/getContentTypesWiseData'));
  test('a URL helper with a literal path resolves ($this->backendTourUrl("/x"))', () => assert.equal(by(/PatientController\.php:17$/)[0].uri, 'welcome-tour/complete'));
  test('reasons never copy code text', () => {
    const u = by(/PatientController\.php:18$/)[0];
    assert.equal(u.resolved, false);
    assert.ok(!/abc123|['"]/.test(u.reason), u.reason);
  });
  test('a ternary in a local variable gives one call per branch, each linked', () => {
    const two = by(/patients\.js:3$/).map((c) => c.uri).sort();
    assert.deepEqual(two, ['verify-email-login-otp', 'verify-login-otp']);
    assert.ok(links.filter((l) => /patients\.js:3$/.test(l.cite)).every((l) => l.status === 'matched'));
  });
  test('window globals set in Blade from route() resolve in page scripts', () => {
    const c = by(/patients\.js:5$/)[0];
    assert.equal(c.routeName, 'getPlanStatus');
    assert.deepEqual(st(c.cite).route.key, 'POST getPlanStatus');
  });
  test('a query-string variable ends the path ("/medical-assessment-v3" + buildStateQuery(...))', () => {
    const c = by(/index\.blade\.php:6$/);
    assert.deepEqual(c.map((x) => x.uri), ['medical-assessment-v3']);
  });
  test('a Blade $.ajax is counted once', () => assert.equal(calls.filter((c) => /index\.blade\.php/.test(c.file)).length, 1));
  test('Map.delete(event.target) is not a call; constants are not matched by a stray last word', () => assert.deepEqual(by(/patients\.js:8$/), []));
  test('an outside host never matches the app\'s own routes', () => assert.equal(st(by(/patients\.js:10$/)[0].cite).status, 'external'));
  test('relative static files are not API calls', () => assert.deepEqual(by(/patients\.js:11$/), []));
  test('vendored libraries are skipped by name (calls, services, hosts)', () => {
    const a = facts(R).apps[0];
    assert.ok(!a.calls.some((c) => /jquery/.test(c.file)));
    assert.ok(!a.externals.systems.some((s) => s.system === 'Stripe'));
    assert.ok(!a.externals.otherHosts.some((h) => h.host === 'jsperf.com'));
  });
  test('a script loaded by exactly one page is credited to that page; one the layout loads, to none', () => {
    assert.deepEqual(facts(R).apps[0].screens.find((s) => s.id === 'patients.index').scripts, ['public/js/patients.js']);
    assert.equal(by(/patients\.js:3$/)[0].screen, 'patients.index');
    assert.equal(by(/common\.js:2$/)[0].screen, null);
  });
  test('a parameter-only route does not match an unrelated call by its tail', () => {
    const rt = [{ key: 'DELETE deleteReport/{a}/{b}', method: 'DELETE', uri: 'deleteReport/{a}/{b}', shape: 'deleteReport/{}/{}', app: 'x' }];
    assert.equal(matchCall({ method: 'POST', uri: 'custom-data/getX', shape: 'custom-data/getX', app: 'y' }, rt), null);
    assert.ok(matchCall({ method: 'DELETE', uri: 'deleteReport/{}/{}', shape: 'deleteReport/{}/{}', app: 'y' }, rt));
  });
  test('after a reader upgrade the code is read again, then links, a refresh and the documents follow', () => {
    const sf = docs(R, '_state/breakdown.json');
    const s0 = readJ(sf);
    s0.repos[0].mapped.readers = 1;
    // stamps as a run before the version stamp wrote them: "commit:tree"
    s0.stages['4'].inputs = Object.fromEntries(Object.entries(s0.stages['4'].inputs).map(([k, v]) => [k, v.replace(/:r\d+$/, '')]));
    fs.writeFileSync(sf, JSON.stringify(s0));
    const ff = docs(R, '_map/webonly/facts.json');
    const f0 = readJ(ff);
    delete f0.readers; // facts written by a reader before the version stamp existed
    fs.writeFileSync(ff, JSON.stringify(f0));
    const s = status(R);
    assert.equal(s.next, 3);
    assert.match(s.message, /code readers were improved/);
    assert.match(ok(run('map.mjs', ['--repo', R, '--home', R, '--no-graph'])), /webonly \[laravel\]/);
    assert.equal(status(R).next, 4);
  });
});
