<?php
declare(strict_types=1);
namespace Realponto;

final class Http {
    public function __construct(public readonly Config $config, public readonly Store $store) {}
    public static function headers(): void {
        header('Content-Type: application/json; charset=utf-8'); header('Cache-Control: no-store, private'); header('Pragma: no-cache');
        header('X-Content-Type-Options: nosniff'); header('Referrer-Policy: no-referrer'); header("Content-Security-Policy: default-src 'none'; frame-ancestors 'none'");
        header('X-Frame-Options: DENY');
    }
    public function secureRequest(): void {
        $https = ($_SERVER['HTTPS'] ?? '') === 'on' || ($_SERVER['HTTPS'] ?? '') === '1';
        $local = !empty($this->config->values['developmentLoopback']) && in_array($_SERVER['REMOTE_ADDR'] ?? '', ['127.0.0.1', '::1'], true) && in_array(parse_url($this->config->get('origin'), PHP_URL_HOST), ['localhost', '127.0.0.1', '[::1]'], true);
        if (!$https && !$local) throw new Problem(403, 'Utilize uma conexão HTTPS para acessar este serviço.');
        // O proxy deve configurar HTTPS no servidor; cabeçalhos enviados pelo navegador não são confiados.
        $host = $_SERVER['HTTP_HOST'] ?? '';
        $expected = parse_url($this->config->get('origin'), PHP_URL_HOST) . (parse_url($this->config->get('origin'), PHP_URL_PORT) ? ':' . parse_url($this->config->get('origin'), PHP_URL_PORT) : '');
        if (!hash_equals(strtolower($expected), strtolower($host))) throw new Problem(403, 'Endereço de acesso não permitido.');
        if (isset($_SERVER['HTTP_ORIGIN']) && !hash_equals($this->config->get('origin'), $_SERVER['HTTP_ORIGIN'])) throw new Problem(403, 'Origem de acesso não permitida.');
        if (($_SERVER['HTTP_SEC_FETCH_SITE'] ?? '') === 'cross-site') throw new Problem(403, 'Origem de acesso não permitida.');
    }
    public function startSession(): void {
        $sessionDir = rtrim($this->config->get('dataDirectory'), '/\\') . '/sessions';
        if (!is_dir($sessionDir)) mkdir($sessionDir, 0700, true);
        ini_set('session.use_strict_mode', '1'); ini_set('session.use_only_cookies', '1'); ini_set('session.use_trans_sid', '0'); ini_set('session.gc_maxlifetime', '28800');
        session_save_path($sessionDir); session_name('RP_CONTACTS_SESSION'); session_cache_limiter('');
        session_set_cookie_params(['lifetime' => 0, 'path' => $this->config->get('cookiePath', '/'), 'secure' => str_starts_with($this->config->get('origin'), 'https://'), 'httponly' => true, 'samesite' => 'Strict']);
        session_start();
        if (!isset($_SESSION['csrf'])) $_SESSION['csrf'] = bin2hex(random_bytes(32));
        if (isset($_SESSION['authenticated']) && !$this->authenticated(false)) $this->clearAuthentication();
    }
    private function passwordVersion(): string { return hash_hmac('sha256', $this->config->get('passwordHash'), $this->config->key); }
    public function authenticated(bool $touch = true): bool {
        $valid = ($_SESSION['authenticated'] ?? false) === true && isset($_SESSION['loginAt'], $_SESSION['lastActivity'], $_SESSION['passwordVersion']) && hash_equals($this->passwordVersion(), (string)$_SESSION['passwordVersion']) && time() - $_SESSION['lastActivity'] <= 900 && time() - $_SESSION['loginAt'] <= 28800;
        if ($valid && $touch) $_SESSION['lastActivity'] = time();
        return $valid;
    }
    public function requireAuthentication(): void { if (!$this->authenticated()) throw new Problem(401, 'Entre com a senha para acessar as solicitações.'); }
    public function state(): array { return ['ok' => true, 'authenticated' => $this->authenticated(false), 'csrfToken' => $_SESSION['csrf'], 'submissionEnabled' => $this->config->get('submissionsEnabled', false) === true, 'mailConfigured' => $this->config->mailConfigured()]; }
    public function post(): array {
        if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') throw new Problem(405, 'Método não permitido.');
        if (!isset($_SERVER['HTTP_ORIGIN']) || !hash_equals($this->config->get('origin'), $_SERVER['HTTP_ORIGIN'])) throw new Problem(403, 'Origem de acesso não permitida.');
        if (strtolower(trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0])) !== 'application/json') throw new Problem(415, 'Envie os dados no formato esperado.');
        $token = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
        if (!$token || !hash_equals($_SESSION['csrf'], $token)) throw new Problem(403, 'Sua sessão expirou. Atualize a página e tente novamente.');
        if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0) > 16384) throw new Problem(413, 'Solicitação muito grande.');
        $body = file_get_contents('php://input', false, null, 0, 16385);
        if ($body === false || strlen($body) > 16384) throw new Problem(413, 'Solicitação muito grande.');
        try { $input = json_decode($body, true, 16, JSON_THROW_ON_ERROR); } catch (\JsonException) { throw new Problem(400, 'Solicitação inválida.'); }
        if (!is_array($input) || !str_starts_with(ltrim($body), '{')) throw new Problem(400, 'Solicitação inválida.');
        return $input;
    }
    public function login(array $input): array {
        $this->store->rate('login', $_SERVER['REMOTE_ADDR'] ?? '', 5, 900);
        $this->store->rate('login-global', 'all', 100, 900);
        $password = $input['password'] ?? null;
        if (!is_string($password) || strlen($password) > 1024 || !password_verify($password, $this->config->get('passwordHash'))) throw new Problem(401, 'Senha inválida.');
        session_regenerate_id(true);
        $_SESSION = ['csrf' => bin2hex(random_bytes(32)), 'authenticated' => true, 'loginAt' => time(), 'lastActivity' => time(), 'passwordVersion' => $this->passwordVersion()];
        return $this->state();
    }
    public function clearAuthentication(): void { $_SESSION = ['csrf' => bin2hex(random_bytes(32))]; session_regenerate_id(true); }
    public function logout(): array { $this->clearAuthentication(); return $this->state(); }
    public function submit(array $input): array {
        if ($this->config->get('submissionsEnabled', false) !== true) throw new Problem(503, 'O recebimento de solicitações ainda não está disponível.');
        $this->store->rate('submit', $_SERVER['REMOTE_ADDR'] ?? '', 10, 3600);
        $this->store->rate('submit-global', 'all', 300, 3600);
        return $this->store->create(Domain::load()->normalize($input), (string)($_SERVER['HTTP_IDEMPOTENCY_KEY'] ?? ''));
    }
}
