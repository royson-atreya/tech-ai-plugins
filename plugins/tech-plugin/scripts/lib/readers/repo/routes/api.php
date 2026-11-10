<?php
use App\Http\Controllers\AuthController;
use App\Http\Controllers\PatientController;
use App\Http\Controllers\Admin\ReportController as Rep;
// Route::get('old', [AuthController::class, 'old']);
Route::post('login', [AuthController::class, 'login'])->name('login');
Route::middleware('auth:sanctum')->group(function () {
    Route::get('/me', [AuthController::class, 'me']);
    Route::apiResource('patients', PatientController::class);
    Route::prefix('reports')->name('reports.')->group(function () {
        Route::get('{report}/pdf', [Rep::class, 'pdf'])->name('pdf');
        Route::match(['get', 'post'], 'search', [Rep::class, 'search']);
    });
    Route::get('ping', function () {
        return 'pong; Route::get("fake")';
    })->name('ping');
});
Route::group(['prefix' => 'v1', 'namespace' => 'Legacy'], function () {
    Route::get('items', 'ItemController@index');
});
Route::controller(AuthController::class)->group(function () {
    Route::post('logout', 'logout');
});
Route::get('dup', [AuthController::class, 'a']);
Route::get('dup', [AuthController::class, 'b']);
Route::weird('x');
require __DIR__.'/extra.php';
