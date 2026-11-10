<?php
namespace App\Http\Controllers;
use App\Models\Patient;
class PatientController {
  public function index() { return Patient::all(); }
  public function page() { $r = Http::get(config('app.backend_url') . '/api/patients/' . $id); return view('patients.index', ['r'=>$r]); }
}