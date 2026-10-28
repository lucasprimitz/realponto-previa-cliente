<?php
declare(strict_types=1);
namespace Realponto;

final class Problem extends \RuntimeException {
    public function __construct(public readonly int $status, string $message) { parent::__construct($message); }
}

final class Config {
    public readonly string $key;
    public function __construct(public readonly array $values) {
        if (PHP_VERSION_ID < 80200 || !extension_loaded('sodium') || !extension_loaded('pdo_sqlite')) {
            throw new \RuntimeException('PHP 8.2+, sodium e pdo_sqlite são necessários.');
        }
        $decoded = base64_decode((string)($values['encryptionKey'] ?? ''), true);
        if ($decoded === false || strlen($decoded) !== SODIUM_CRYPTO_SECRETBOX_KEYBYTES) throw new \RuntimeException('Configure uma chave de criptografia de 32 bytes em base64.');
        $this->key = $decoded;
        $hash = (string)($values['passwordHash'] ?? '');
        if ((password_get_info($hash)['algoName'] ?? 'unknown') === 'unknown') throw new \RuntimeException('Configure o hash da senha de acesso.');
        $origin = (string)($values['origin'] ?? '');
        $parts = parse_url($origin);
        if (!$parts || !isset($parts['scheme'], $parts['host']) || isset($parts['user']) || isset($parts['pass']) || isset($parts['query']) || isset($parts['fragment']) || !in_array($parts['path'] ?? '', ['', '/'], true) || rtrim($origin, '/') !== $origin) throw new \RuntimeException('Configure a origem sem caminho ou barra final.');
        if ($parts['scheme'] !== 'https' && !($parts['scheme'] === 'http' && !empty($values['developmentLoopback']) && in_array($parts['host'], ['localhost', '127.0.0.1', '[::1]'], true))) throw new \RuntimeException('A origem deve utilizar HTTPS.');
        $dir = (string)($values['dataDirectory'] ?? '');
        if (!$dir || !self::absolute($dir)) throw new \RuntimeException('Configure uma pasta absoluta de dados privados.');
        if (!is_dir($dir) && !mkdir($dir, 0700, true)) throw new \RuntimeException('Não foi possível criar a pasta privada.');
        $private = realpath($dir);
        foreach (array_filter([realpath(dirname(__DIR__) . '/public'), empty($_SERVER['DOCUMENT_ROOT']) ? false : realpath($_SERVER['DOCUMENT_ROOT'])]) as $public) {
            if (self::inside((string)$private, (string)$public)) throw new \RuntimeException('Os dados devem ficar fora da pasta pública.');
        }
        if (!is_writable($dir)) throw new \RuntimeException('A pasta privada precisa permitir gravação ao serviço PHP.');
        $cookiePath = $values['cookiePath'] ?? '/';
        if (!is_string($cookiePath) || !preg_match('~^/[A-Za-z0-9/_-]*$~D', $cookiePath)) throw new \RuntimeException('Caminho de cookie inválido.');
    }
    public static function absolute(string $path): bool { return str_starts_with($path, '/') || (bool)preg_match('~^[A-Za-z]:[/\\\\]~', $path); }
    public static function inside(string $path, string $directory): bool {
        $path = strtolower(str_replace('\\', '/', $path)); $directory = rtrim(strtolower(str_replace('\\', '/', $directory)), '/');
        return $path === $directory || str_starts_with($path, $directory . '/');
    }
    public function get(string $key, mixed $default = null): mixed { return $this->values[$key] ?? $default; }
    public function mailConfigured(): bool {
        $mail = $this->get('mail', []);
        return !empty($mail['enabled']) && !empty($mail['host']) && filter_var($mail['from'] ?? '', FILTER_VALIDATE_EMAIL) !== false && filter_var($mail['recipient'] ?? '', FILTER_VALIDATE_EMAIL) !== false;
    }
    public static function load(): self {
        $file = getenv('CONTACTS_CONFIG_FILE') ?: '';
        if (!self::absolute($file) || !is_file($file)) throw new \RuntimeException('Configure CONTACTS_CONFIG_FILE fora da pasta pública.');
        $real = realpath($file);
        foreach (array_filter([realpath(dirname(__DIR__) . '/public'), empty($_SERVER['DOCUMENT_ROOT']) ? false : realpath($_SERVER['DOCUMENT_ROOT'])]) as $public) {
            if (self::inside((string)$real, (string)$public)) throw new \RuntimeException('A configuração deve ficar fora da pasta pública.');
        }
        $values = require $file;
        if (!is_array($values)) throw new \RuntimeException('Configuração inválida.');
        if (getenv('CONTACTS_SUBMISSIONS_ENABLED') !== false) $values['submissionsEnabled'] = getenv('CONTACTS_SUBMISSIONS_ENABLED') === '1';
        return new self($values);
    }
}
