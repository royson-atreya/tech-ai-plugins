<?php
Schema::create('patient_master', function (Blueprint $table) { $table->id(); $table->string('name'); $table->foreignId('user_id'); $table->timestamps(); });