<?php
declare(strict_types=1);
// Roteador exclusivo da conferência local com php -S e document root em public/.
if (PHP_SAPI !== 'cli-server') { http_response_code(404); exit; }
$path = rawurldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?: '/');
$routes = [
    '/' => 'index.html', '/index.html' => 'index.html', '/preview.css' => 'preview.css',
    '/app.mjs' => 'app.mjs', '/customer-model.mjs' => 'customer-model.mjs',
    '/customer-request.mjs' => 'customer-request.mjs', '/request-transport.mjs' => 'request-transport.mjs',
    '/quote.mjs' => 'quote.mjs', '/assets/realponto-30-anos.png' => 'assets/realponto-30-anos.png',
    '/contatos/' => 'contatos/index.html', '/contatos/index.html' => 'contatos/index.html',
    '/contatos/panel.css' => 'contatos/panel.css', '/contatos/panel.mjs' => 'contatos/panel.mjs',
];
foreach (['session', 'requests', 'login', 'logout', 'request-update'] as $endpoint) {
    if ($path === '/api/' . $endpoint . '.php') return false;
}
header('Cache-Control: no-store'); header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer'); header('X-Frame-Options: DENY');
header("Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
if (!in_array($_SERVER['REQUEST_METHOD'], ['GET', 'HEAD'], true)) { http_response_code(405); exit; }
if ($path === '/contatos') { header('Location: /contatos/', true, 302); exit; }
if (!isset($routes[$path])) { http_response_code(404); exit; }
$file = rtrim($_SERVER['DOCUMENT_ROOT'], '/\\') . '/' . $routes[$path];
$mime = ['html' => 'text/html; charset=utf-8', 'mjs' => 'text/javascript; charset=utf-8', 'css' => 'text/css; charset=utf-8', 'png' => 'image/png'];
header('Content-Type: ' . $mime[pathinfo($file, PATHINFO_EXTENSION)]);
if ($_SERVER['REQUEST_METHOD'] !== 'HEAD') readfile($file);
