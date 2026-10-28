<?php
declare(strict_types=1);
require dirname(__DIR__, 2) . '/src/bootstrap.php';
realponto_endpoint(function (\Realponto\Http $http): array {
    if (($_SERVER['REQUEST_METHOD'] ?? '') === 'GET') {
        $http->requireAuthentication();
        $page = filter_var($_GET['page'] ?? '1', FILTER_VALIDATE_INT);
        $status = $_GET['status'] ?? 'all';
        if ($page === false || !is_string($status)) throw new \Realponto\Problem(422, 'Filtro inválido.');
        return $http->store->listing($page, $status);
    }
    $response = $http->submit($http->post());
    http_response_code($response['created'] ? 201 : 200); unset($response['created']); return $response;
});
