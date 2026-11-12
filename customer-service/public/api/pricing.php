<?php
declare(strict_types=1);
require dirname(__DIR__, 2) . '/src/bootstrap.php';
// Consulta pública isolada: não abre sessão, banco ou configuração de contatos.
\Realponto\Pricing::endpoint();
