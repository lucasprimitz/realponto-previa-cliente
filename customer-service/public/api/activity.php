<?php
declare(strict_types=1);
require dirname(__DIR__, 2) . '/src/bootstrap.php';

realponto_endpoint(function (\Realponto\Http $http): array {
    if ($_SERVER['REQUEST_METHOD'] === 'POST') return $http->recordActivity($http->post());
    $http->requireAuthentication();
    if ($_SERVER['REQUEST_METHOD'] !== 'GET') throw new \Realponto\Problem(405, 'Método não permitido.');
    $page = filter_var($_GET['page'] ?? '1', FILTER_VALIDATE_INT);
    if ($page === false) throw new \Realponto\Problem(422, 'Página inválida.');
    return $http->store->activity->listing($page, $_GET['month'] ?? null);
});
