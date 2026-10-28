<?php
declare(strict_types=1);
require dirname(__DIR__, 2) . '/src/bootstrap.php';
realponto_endpoint(fn(\Realponto\Http $http): array => $http->login($http->post()));
