<?php
declare(strict_types=1);
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require dirname(__DIR__) . '/src/bootstrap.php';
try {
    $config = \Realponto\Config::load(); $store = new \Realponto\Store($config); $mail = new \Realponto\Mail($config, $store);
    if (($argv[1] ?? '') === '--retry-failed') echo 'Reagendados: ' . $mail->retryFailed() . PHP_EOL;
    elseif (isset($argv[1])) throw new \RuntimeException('Opção inválida.');
    echo json_encode($mail->drain(), JSON_THROW_ON_ERROR) . PHP_EOL;
} catch (\Throwable $error) { fwrite(STDERR, 'Falha na fila de e-mails. Revise a configuração privada e as dependências.' . PHP_EOL); exit(1); }
