// Golden system for the document tests: the nadi workspace from golden-map.mjs
// with behaviour added to the web dashboard (validation rules, an abort
// message, a translated flash message, page labels from a language file),
// broken down through all six stages with the fixture module proposal.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildMapGolden } from './golden-map.mjs';
import { PLUGIN } from './fixture.mjs';

function put(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

export function runScript(dir, script, args, env = {}) {
  const r = spawnSync(process.execPath, [path.join(PLUGIN, 'scripts', dir, script), ...args], { encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN, TECH_PLUGIN_GRAPHIFY: path.join(PLUGIN, 'tests', 'fake-graphify.mjs'), ...env }, timeout: 120000 });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

export function buildDocSystem() {
  const G = buildMapGolden();
  fs.chmodSync(path.join(PLUGIN, 'tests', 'fake-graphify.mjs'), 0o755);
  // line numbers below are cited by the sample documents in document-tests.mjs
  put(path.join(G.web, 'app/Http/Controllers/PatientPageController.php'), `<?php

namespace App\\Http\\Controllers;

use Illuminate\\Support\\Facades\\Http;

class PatientPageController extends Controller
{
    protected $baseUrl;
    public function index() {
        $list = Http::withToken(session('t'))->get(config('app.backend_url') . '/api/patients');
        return view('patients.index', ['list' => $list]);
    }
    public function show($id) {
        $p = Http::get($this->baseUrl . "/api/patients/{$id}");
        return view('patients.show', ['p' => $p]);
    }
    public function requestReport(Request $request, $id) {
        $request->validate([
            'mobile' => 'required|digits:10',
            'name' => ['required', 'max:80'],
        ]);
        Http::post(config('app.backend_url') . '/api/reports', ['patient' => $id]);
        if (!$id) { abort(404, 'Patient not found'); }
        return redirect()->route('patients.show', $id)->with('success', __('reportRequested'));
    }
    public function help() { return back()->with('info', 'Call the clinic on 9876543210'); }
}
`);
  put(path.join(G.web, 'resources/lang/en_patient.json'), JSON.stringify({ patientListTitle: 'Patient list', addPatient: 'Add patient', reportRequested: 'Your report request was sent' }));
  put(path.join(G.web, 'resources/views/patients/index.blade.php'), `@extends("layouts.app")
<title>{{ __('patientListTitle') }}</title>
<h1>{{ __('patientListTitle') }}</h1>
<button class="btn">{{ __('addPatient') }}</button>
<label>Mobile number</label><input placeholder="Enter 10-digit mobile">
<th>Prakruti</th><th>Name</th>
<script>
$.ajax({ url: "{{ route('patients.report', 1) }}", type: "POST" });
</script>
`);
  fs.appendFileSync(path.join(G.web, 'routes/web.php'), "Route::get('patients-help', [PatientPageController::class, 'help']);\n");
  spawnSync('git', ['-C', G.web, 'add', '-A']);
  const H = G.backend;
  const input = path.join(G.W, 'doc-in.json');
  fs.writeFileSync(input, JSON.stringify({ system: 'Nadi', home: H, repos: [{ path: G.backend, role: 'backend' }, { path: G.web, role: 'web' }, { path: G.mobile, role: 'mobile' }], business: { product: 'Pulse reports for clinics', roles: ['Doctor', 'Patient'] } }));
  const must = (r) => {
    if (r.code !== 0) throw new Error(r.err || r.out);
    return r.out;
  };
  must(runScript('breakdown', 'write.mjs', ['system', '--input', input]));
  return {
    G,
    H,
    finishBreakdown() {
      for (const r of [G.backend, G.web, G.mobile]) must(runScript('breakdown', 'detect.mjs', [r, '--write']));
      must(runScript('breakdown', 'write.mjs', ['confirm', '--home', H, '--by', 'T']));
      for (const r of [G.backend, G.web, G.mobile]) must(runScript('breakdown', 'map.mjs', ['--repo', r, '--home', H]));
      must(runScript('breakdown', 'link.mjs', ['--home', H]));
      fs.copyFileSync(path.join(PLUGIN, 'tests', 'fixtures', 'nadi-proposal.yaml'), path.join(H, 'sdlc-docs', '_map', 'module-proposal.yaml'));
      must(runScript('breakdown', 'modules.mjs', ['write', '--home', H, '--by', 'Asha Rao']));
      must(runScript('breakdown', 'catalogue.mjs', ['--home', H]));
    },
  };
}
