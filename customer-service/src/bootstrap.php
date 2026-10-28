<?php
declare(strict_types=1);
ini_set('display_errors', '0');
require_once __DIR__ . '/Config.php';
require_once __DIR__ . '/Domain.php';
require_once __DIR__ . '/Store.php';
require_once __DIR__ . '/Http.php';
require_once __DIR__ . '/Mail.php';

function realponto_endpoint(callable $handler): never {
    \Realponto\Http::headers();
    try {
        $config = \Realponto\Config::load();
        $http = new \Realponto\Http($config, new \Realponto\Store($config));
        $http->secureRequest(); $http->startSession();
        $response = $handler($http);
        echo json_encode($response, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
    } catch (\Realponto\Problem $error) {
        http_response_code($error->status);
        echo json_encode(['ok' => false, 'message' => $error->getMessage()], JSON_UNESCAPED_UNICODE);
    } catch (\Throwable $error) {
        // Nunca registrar dados pessoais, senhas, corpo ou detalhes de SMTP.
        error_log('Realponto contacts: internal failure (' . get_class($error) . ').');
        http_response_code(503);
        echo json_encode(['ok' => false, 'message' => 'O serviço está temporariamente indisponível. Tente novamente mais tarde.'], JSON_UNESCAPED_UNICODE);
    }
    exit;
}
