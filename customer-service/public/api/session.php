<?php
declare(strict_types=1);
require dirname(__DIR__, 2) . '/src/bootstrap.php';
realponto_endpoint(function (\Realponto\Http $http): array {
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') throw new \Realponto\Problem(405, 'Método não permitido.');
    return $http->state();
});
