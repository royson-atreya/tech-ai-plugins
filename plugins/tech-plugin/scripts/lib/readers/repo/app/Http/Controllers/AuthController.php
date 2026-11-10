<?php
namespace App\Http\Controllers;
use App\Models\User;
class AuthController extends Controller {
  public function login(Request $r) { $u = User::where('x',1)->first(); return response()->json($u); }
  public function me() { return DB::table('sessions')->get(); }
}