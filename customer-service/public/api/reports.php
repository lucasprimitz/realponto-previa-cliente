<?php
declare(strict_types=1);
require dirname(__DIR__, 2) . '/src/bootstrap.php';
realponto_endpoint(function (\Realponto\Http $http): array {
    $http->requireAuthentication();
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') throw new \Realponto\Problem(405, 'Método não permitido.');
    $currentYear = (new \DateTimeImmutable('now', new \DateTimeZone('America/Sao_Paulo')))->format('Y');
    $year = $_GET['year'] ?? $currentYear;
    if (!is_string($year) || !preg_match('/^[0-9]{4}$/D', $year)) throw new \Realponto\Problem(422, 'Selecione um ano válido.');
    return $http->store->reports((int)$year);
});
