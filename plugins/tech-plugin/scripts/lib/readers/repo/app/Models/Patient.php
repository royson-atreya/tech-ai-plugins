<?php
namespace App\Models;
class Patient extends Model { protected $table = 'patient_master'; public function reports() { return $this->hasMany(Report::class); } }