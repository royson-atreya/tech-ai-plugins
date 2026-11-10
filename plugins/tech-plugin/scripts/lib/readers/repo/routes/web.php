<?php
Route::view('/', 'welcome');
Route::get('/patients', [App\Http\Controllers\PatientController::class, 'page']);
