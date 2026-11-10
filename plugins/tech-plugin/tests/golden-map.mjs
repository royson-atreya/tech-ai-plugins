// Golden fixtures for breakdown stages 3-6: the step-3 golden repos (see
// golden.mjs) with real code added, so routes, screens, calls, tables and
// links can be checked exactly.
//
//   nadi/backend  Laravel API: 19 api routes (groups, prefixes, apiResource,
//                 a closure, a commented-out route), the welcome closure,
//                 controllers, models, migrations, Razorpay, and a controller
//                 that is secret by the project's own rule
//   nadi/web      Laravel + Blade dashboard calling the backend with Http::
//   nadi/mobile   Flutter: GoRouter tree, Dio calls through a base-URL getter
//                 and a StringsConst-style constant, one call to a route that
//                 does not exist, one URL known only at run time
//   shop          Express API (routers mounted under /api) + Next.js web
//   pyapp         FastAPI with routers included under /api, SQLAlchemy models
//   goapp         a Gin service: no dedicated reader, the generic one

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SECRET_MARKER, buildGolden } from './golden.mjs';

const S = SECRET_MARKER;

function put(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function gitAdd(dir) {
  spawnSync('git', ['-C', dir, 'add', '-A'], { encoding: 'utf8' });
}

export function buildMapGolden() {
  const G = buildGolden();
  const B = G.backend;
  put(path.join(B, 'routes/api.php'), `<?php

use App\\Http\\Controllers\\AuthController;
use App\\Http\\Controllers\\PatientController;
use App\\Http\\Controllers\\ReportController;
use App\\Http\\Controllers\\PaymentController;
use App\\Http\\Controllers\\AppointmentController;
use App\\Http\\Controllers\\SamvitBridgeController;

Route::post('login', [AuthController::class, 'login']);
Route::post('otp/verify', [AuthController::class, 'verifyOtp']);

Route::middleware('auth:sanctum')->group(function () {
    Route::get('me', [AuthController::class, 'me']);
    Route::post('logout', [AuthController::class, 'logout']);
    Route::apiResource('patients', PatientController::class);
    Route::prefix('reports')->group(function () {
        Route::get('{report}', [ReportController::class, 'show']);
        Route::get('{report}/pdf', [ReportController::class, 'pdf']);
        Route::post('/', [ReportController::class, 'store']);
    });
    Route::get('appointments', [AppointmentController::class, 'index']);
    Route::post('appointments', [AppointmentController::class, 'book']);
    Route::post('payments/order', [PaymentController::class, 'createOrder']);
    Route::post('payments/verify', [PaymentController::class, 'verify']);
});

Route::post('webhooks/razorpay', [PaymentController::class, 'webhook']);
Route::post('samvit/sync', [SamvitBridgeController::class, 'sync']);
Route::get('debug/phpinfo', function () {
    return phpinfo();
});
// Route::get('old/patients', [PatientController::class, 'old']);
`);
  const ctl = (name, body) => put(path.join(B, `app/Http/Controllers/${name}.php`), `<?php\n\nnamespace App\\Http\\Controllers;\n\nuse App\\Models\\Patient;\nuse App\\Models\\Report;\nuse App\\Models\\Appointment;\nuse App\\Models\\Payment;\nuse Illuminate\\Support\\Facades\\DB;\n\nclass ${name} extends Controller\n{\n${body}\n}\n`);
  ctl('AuthController', `    public function login(Request $r) { return DB::table('otp_logs')->insert([]); }\n    public function verifyOtp() { return 1; }\n    public function me() { return auth()->user(); }\n    public function logout() { return 1; }`);
  ctl('PatientController', `    public function index() { return Patient::all(); }\n    public function store() { return Patient::create([]); }\n    public function show(Patient $patient) { return $patient; }\n    public function update(Patient $patient) { return $patient; }\n    public function destroy(Patient $patient) { return 1; }`);
  ctl('ReportController', `    public function show($id) { return Report::find($id); }\n    public function pdf($id) { return Report::find($id); }\n    public function store() { return Report::create([]); }`);
  ctl('AppointmentController', `    public function index() { return Appointment::all(); }\n    public function book() { return Appointment::create([]); }`);
  ctl('PaymentController', `    public function createOrder() { $api = new \\Razorpay\\Api\\Api(config('services.razorpay.key'), ''); return Payment::create([]); }\n    public function verify() { return Payment::where('x', 1)->first(); }\n    public function webhook() { return Payment::first(); }`);
  put(path.join(B, 'app/Http/Controllers/SamvitBridgeController.php'), `<?php\n// ${S}\nclass SamvitBridgeController {}\n`);
  for (const [m, t] of [['Patient', null], ['Report', 'pulse_reports'], ['Appointment', null], ['Payment', null]]) put(path.join(B, `app/Models/${m}.php`), `<?php\n\nnamespace App\\Models;\n\nclass ${m} extends Model\n{\n${t ? `    protected $table = '${t}';\n` : ''}    public function patient() { return $this->belongsTo(Patient::class); }\n}\n`);
  for (const [i, t, cols] of [[4, 'patients', ['name', 'phone']], [5, 'pulse_reports', ['patient_id', 'pdf_path']], [6, 'appointments', ['patient_id', 'slot']], [7, 'payments', ['order_id', 'amount']], [8, 'otp_logs', ['phone']]]) {
    put(path.join(B, `database/migrations/2024_01_0${i}_000000_create_${t}_table.php`), `<?php\nreturn new class extends Migration {\n    public function up() {\n        Schema::create('${t}', function (Blueprint $table) {\n            $table->id();\n${cols.map((c) => `            $table->string('${c}');`).join('\n')}\n            $table->timestamps();\n        });\n    }\n};\n`);
  }
  put(path.join(B, 'config/services.php'), `<?php\nreturn ['razorpay' => ['key' => env('RAZORPAY_KEY')], 'samvit' => ['url' => 'https://samvit.partner-api.in/api']];\n`);
  gitAdd(B);

  // ---- web dashboard
  const W = G.web;
  put(path.join(W, 'routes/web.php'), `<?php

use App\\Http\\Controllers\\DashboardController;
use App\\Http\\Controllers\\PatientPageController;

Route::view('/', 'welcome');
Route::get('login', [DashboardController::class, 'loginPage'])->name('login');
Route::middleware('auth')->group(function () {
    Route::get('dashboard', [DashboardController::class, 'index'])->name('dashboard');
    Route::get('patients', [PatientPageController::class, 'index'])->name('patients.index');
    Route::get('patients/{id}', [PatientPageController::class, 'show'])->name('patients.show');
    Route::post('patients/{id}/report', [PatientPageController::class, 'requestReport'])->name('patients.report');
});
`);
  put(path.join(W, 'routes/api.php'), '<?php\n');
  put(path.join(W, 'app/Http/Controllers/DashboardController.php'), `<?php\n\nnamespace App\\Http\\Controllers;\n\nuse Illuminate\\Support\\Facades\\Http;\n\nclass DashboardController extends Controller\n{\n    public function loginPage() { return view('auth.login'); }\n    public function index() {\n        $stats = Http::get(config('app.backend_url') . '/api/legacy/stats');\n        return view('dashboard', ['stats' => $stats]);\n    }\n}\n`);
  put(path.join(W, 'app/Http/Controllers/PatientPageController.php'), `<?php\n\nnamespace App\\Http\\Controllers;\n\nuse Illuminate\\Support\\Facades\\Http;\n\nclass PatientPageController extends Controller\n{\n    protected $baseUrl;\n    public function index() {\n        $list = Http::withToken(session('t'))->get(config('app.backend_url') . '/api/patients');\n        return view('patients.index', ['list' => $list]);\n    }\n    public function show($id) {\n        $p = Http::get($this->baseUrl . "/api/patients/{$id}");\n        return view('patients.show', ['p' => $p]);\n    }\n    public function requestReport($id) {\n        Http::post(config('app.backend_url') . '/api/reports', ['patient' => $id]);\n        return redirect()->route('patients.show', $id);\n    }\n}\n`);
  put(path.join(W, 'resources/views/layouts/app.blade.php'), '<html>@yield("content")</html>\n');
  put(path.join(W, 'resources/views/welcome.blade.php'), '<a href="{{ route(\'login\') }}">Sign in</a>\n');
  put(path.join(W, 'resources/views/auth/login.blade.php'), '<form action="/login" method="post"></form>\n');
  put(path.join(W, 'resources/views/dashboard.blade.php'), '@extends("layouts.app") <a href="{{ route(\'patients.index\') }}">Patients</a>\n');
  put(path.join(W, 'resources/views/patients/index.blade.php'), '@extends("layouts.app")\n<script>\n$.ajax({ url: "{{ route(\'patients.report\', 1) }}", type: "POST" });\n</script>\n');
  put(path.join(W, 'resources/views/patients/show.blade.php'), '@extends("layouts.app")\n');
  gitAdd(W);

  // ---- Flutter app
  const M = G.mobile;
  put(path.join(M, 'lib/main.dart'), `import 'package:go_router/go_router.dart';

final router = GoRouter(routes: [
  GoRoute(path: '/', builder: (c, s) => const LoginScreen()),
  GoRoute(path: '/home', builder: (c, s) => const HomeScreen(), routes: [
    GoRoute(path: 'patients/:id', builder: (c, s) => PatientScreen(id: s.pathParameters['id']!)),
    GoRoute(path: 'book', name: 'book', builder: (c, s) => const BookingScreen()),
  ]),
  GoRoute(path: '/pay', builder: (c, s) => const PaymentScreen()),
]);

void main() {}
`);
  put(path.join(M, 'lib/config/env.dart'), `class AppEnvironment {\n  static String flavor = 'prod';\n  static String get baseUrl => flavor == 'staging' ? 'https://staging-api.example.com/api' : 'https://api.example.com/api';\n}\n`);
  put(path.join(M, 'lib/config/keys_config.dart'),`// ${S}\nconst razorpayKey = '${S}';\n`);
  put(path.join(M, 'lib/constants/strings_const.dart'), `import '../config/env.dart';\n\nclass StringsConst {\n  String get login => "\${AppEnvironment.baseUrl}/login";\n  String get verifyOtp => "\${AppEnvironment.baseUrl}/otp/verify";\n}\n`);
  put(path.join(M, 'lib/services/api_service.dart'), `import 'package:dio/dio.dart';
import '../config/env.dart';
import '../constants/strings_const.dart';

class ApiService {
  final Dio dio = Dio();
  Future login(String phone) => dio.post(StringsConst().login, data: {'phone': phone});
  Future verify(String otp) => dio.post(StringsConst().verifyOtp, data: {'otp': otp});
  Future patient(int id) => dio.get('\${AppEnvironment.baseUrl}/patients/$id');
  Future book(Map b) => dio.post('\${AppEnvironment.baseUrl}/appointments', data: b);
  Future order() => dio.post('\${AppEnvironment.baseUrl}/payments/order');
  Future feedback() => dio.post('\${AppEnvironment.baseUrl}/feedback');
  Future anything(String url) => dio.get(url);
}
`);
  const widget = (file, cls, body = '') => put(path.join(M, file), `import 'package:flutter/material.dart';\n\nclass ${cls} extends StatelessWidget {\n  const ${cls}({super.key});\n  @override\n  Widget build(BuildContext context) {\n${body}\n    return const Placeholder();\n  }\n}\n`);
  widget('lib/screens/login_screen.dart', 'LoginScreen', "    context.go('/home');");
  widget('lib/screens/home_screen.dart', 'HomeScreen', "    context.goNamed('book');");
  widget('lib/screens/patient_screen.dart', 'PatientScreen');
  widget('lib/screens/booking_screen.dart', 'BookingScreen');
  widget('lib/screens/payment_screen.dart', 'PaymentScreen', "    Dio().post('\${AppEnvironment.baseUrl}/payments/verify');");
  put(path.join(M, 'lib/db/cache.dart'), "const sql = 'CREATE TABLE IF NOT EXISTS cached_reports (id INTEGER PRIMARY KEY)';\n");
  gitAdd(M);

  // ---- shop: Express API + Next.js web
  const A = path.join(G.shop, 'apps/api');
  put(path.join(A, 'src/index.ts'), `import express from "express"\nimport productsRouter from './routes/products'\nimport ordersRouter from './routes/orders'\n\nconst app = express()\napp.use('/api/products', productsRouter)\napp.use('/api/orders', ordersRouter)\napp.get('/health', (req, res) => res.send('ok'))\napp.listen(3001)\n`);
  put(path.join(A, 'src/routes/products.ts'), `import { Router } from 'express'\nimport { listProducts, getProduct } from '../controllers/products'\n\nconst router = Router()\nrouter.get('/', listProducts)\nrouter.get('/:id', getProduct)\nexport default router\n`);
  put(path.join(A, 'src/routes/orders.ts'), `import { Router } from 'express'\nimport { auth } from '../middleware/auth'\nimport * as orders from '../controllers/orders'\n\nconst router = Router()\nrouter.post('/', auth, orders.createOrder)\nrouter.get('/:id', auth, orders.getOrder)\nrouter.post('/:id/pay', auth, orders.payOrder)\nexport default router\n`);
  put(path.join(A, 'src/controllers/products.ts'), `import { prisma } from '../db'\nexport const listProducts = async (req, res) => res.json(await prisma.product.findMany())\nexport const getProduct = async (req, res) => res.json(await prisma.product.findUnique({ where: { id: req.params.id } }))\n`);
  put(path.join(A, 'src/controllers/orders.ts'), `import { prisma } from '../db'\nimport Stripe from 'stripe'\nconst stripe = new Stripe('')\nexport const createOrder = async (req, res) => res.json(await prisma.order.create({ data: {} }))\nexport const getOrder = async (req, res) => res.json(await prisma.order.findUnique({}))\nexport const payOrder = async (req, res) => res.json(await stripe.paymentIntents.create({}))\n`);
  put(path.join(A, 'src/middleware/auth.ts'), 'export const auth = (req, res, next) => next()\n');
  put(path.join(A, 'src/db.ts'), "import { PrismaClient } from '@prisma/client'\nexport const prisma = new PrismaClient()\n");
  put(path.join(A, 'prisma/schema.prisma'), 'model Product {\n  id    Int    @id\n  name  String\n}\n\nmodel Order {\n  id    Int    @id\n  total Int\n  @@map("orders")\n}\n');
  const WEBD = path.join(G.shop, 'apps/web');
  put(path.join(WEBD, 'lib/api.ts'), "const API = process.env.NEXT_PUBLIC_API_URL\nexport const getProducts = () => fetch(`${API}/api/products`).then((r) => r.json())\nexport const getProduct = (id: string) => fetch(`${API}/api/products/${id}`).then((r) => r.json())\n");
  put(path.join(WEBD, 'app/products/page.tsx'), "import { getProducts } from '../../lib/api'\nexport default async function Products() { await getProducts(); return null }\n");
  put(path.join(WEBD, 'app/products/[id]/page.tsx'), "import { getProduct } from '../../../lib/api'\nexport default async function Product({ params }) { await getProduct(params.id); return null }\n");
  put(path.join(WEBD, 'app/cart/page.tsx'), "'use client'\nconst API = process.env.NEXT_PUBLIC_API_URL\nexport default function Cart() {\n  const buy = () => fetch(`${API}/api/orders`, { method: 'POST', body: '{}' })\n  return null\n}\n");
  put(path.join(WEBD, 'app/api/revalidate/route.ts'), 'export async function POST(req: Request) { return new Response(null) }\n');
  gitAdd(G.shop);

  // ---- pyapp: FastAPI
  const P = G.py;
  put(path.join(P, 'app/main.py'), 'from fastapi import FastAPI\nfrom app.routers import users, items\n\napi = FastAPI(title="pyapp")\napi.include_router(users.router, prefix="/api")\napi.include_router(items.router, prefix="/api")\n\n\n@api.get("/health")\ndef health():\n    return {}\n');
  put(path.join(P, 'app/routers/__init__.py'), '');
  put(path.join(P, 'app/routers/users.py'), 'from fastapi import APIRouter\nfrom app.models import User\n\nrouter = APIRouter(prefix="/users")\n\n\n@router.get("/")\ndef list_users():\n    return User\n\n\n@router.get("/{user_id}")\nasync def get_user(user_id: int):\n    return User\n\n\n@router.post("/")\ndef create_user():\n    return User\n');
  put(path.join(P, 'app/routers/items.py'), 'from fastapi import APIRouter\nfrom app.models import Item\n\nrouter = APIRouter(prefix="/items", tags=["items"])\n\n\n@router.get("/")\ndef list_items():\n    return Item\n\n\n@router.api_route("/{item_id}", methods=["PUT", "DELETE"])\ndef change_item(item_id: int):\n    return Item\n');
  put(path.join(P, 'app/models.py'), 'from sqlalchemy.orm import DeclarativeBase\n\n\nclass Base(DeclarativeBase):\n    pass\n\n\nclass User(Base):\n    __tablename__ = "users"\n\n\nclass Item(Base):\n    __tablename__ = "items"\n');
  gitAdd(P);

  // ---- goapp: no dedicated reader
  const GO = path.join(G.W, 'goapp');
  put(path.join(GO, 'go.mod'), 'module example.com/goapp\n\ngo 1.21\n\nrequire github.com/gin-gonic/gin v1.9.1\n');
  put(path.join(GO, 'main.go'), 'package main\n\nimport "github.com/gin-gonic/gin"\n\nfunc main() {\n\tr := gin.Default()\n\tv1 := r.Group("/v1")\n\tv1.GET("/orders", listOrders)\n\tv1.POST("/orders", createOrder)\n\tr.GET("/health", health)\n\tr.Run()\n}\n');
  put(path.join(GO, 'orders/handlers.go'), 'package orders\n\nfunc listOrders() {}\nfunc createOrder() {}\n');
  spawnSync('git', ['init', '-q', '-b', 'main', GO], { encoding: 'utf8' });
  gitAdd(GO);
  put(path.join(GO, '.git/refs/heads/main'), '9'.repeat(40) + '\n');

  return { ...G, go: GO };
}
