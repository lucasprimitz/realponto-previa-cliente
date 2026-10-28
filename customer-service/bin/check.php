<?php
declare(strict_types=1);
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require dirname(__DIR__) . '/src/bootstrap.php';
try {
    $config = \Realponto\Config::load(); \Realponto\Domain::load(); new \Realponto\Store($config);
    if ($config->mailConfigured() && !is_file(dirname(__DIR__) . '/vendor/autoload.php')) throw new \RuntimeException('Execute composer install --no-dev.');
    echo 'Configuração e armazenamento OK. Recebimento: ' . ($config->get('submissionsEnabled', false) ? 'ativado' : 'desativado') . '. E-mail: ' . ($config->mailConfigured() ? 'configurado (entrega ainda precisa ser testada)' : 'aguardando configuração') . '.' . PHP_EOL;
} catch (\Throwable $error) { fwrite(STDERR, $error->getMessage() . PHP_EOL); exit(1); }
