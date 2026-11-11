<?php
declare(strict_types=1);
namespace Realponto;

final class AccessContext {
    public static function fromServer(Config $config): array {
        return [
            'device' => self::device($_SERVER['HTTP_USER_AGENT'] ?? '', $_SERVER['HTTP_SEC_CH_UA_MOBILE'] ?? ''),
            'region' => self::region($config),
        ];
    }

    private static function device(string $agent, string $mobileHint): string {
        $agent = substr($agent, 0, 1024);
        if (preg_match('/bot\b|crawler|spider|headless|preview\b|curl\/|wget\//i', $agent)) return 'unknown';
        if (preg_match('/iPad|Tablet|Kindle|Silk\//i', $agent)) return 'tablet';
        if (preg_match('/iPhone|iPod|Windows Phone|Android.+Mobile/i', $agent) || $mobileHint === '?1') return 'mobile';
        if (stripos($agent, 'Android') !== false) return 'tablet';
        if (preg_match('/Mozilla\/.*(?:Windows NT|Macintosh|X11|CrOS)/i', $agent)) return 'desktop';
        return 'unknown';
    }

    private static function region(Config $config): ?string {
        $address = $_SERVER['REMOTE_ADDR'] ?? '';
        if (str_starts_with(strtolower($address), '::ffff:') && filter_var(substr($address, 7), FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
            $address = substr($address, 7);
        }
        if (!filter_var($address, FILTER_VALIDATE_IP, FILTER_FLAG_GLOBAL_RANGE)) return null;
        $packed = inet_pton($address);
        if ($packed === false) return null;

        // Forwarding headers never supply the lookup address. With an unverified proxy we omit the region.
        if ($config->get('activityRemoteAddrVerified', false) !== true) {
            foreach (['HTTP_FORWARDED', 'HTTP_VIA', 'HTTP_CF_CONNECTING_IP', 'HTTP_X_FORWARDED_FOR', 'HTTP_X_REAL_IP'] as $header) {
                if (!empty($_SERVER[$header]) && trim($_SERVER[$header]) !== $address) return null;
            }
        }

        $file = dirname(__DIR__) . '/geo/br-regions.db';
        if (!is_file($file)) return null;
        try {
            // PHP 8.4 introduced driver-specific PDO names. The hosting also supports PHP 8.2.
            $options = class_exists(\Pdo\Sqlite::class)
                ? [\Pdo\Sqlite::ATTR_OPEN_FLAGS => \Pdo\Sqlite::OPEN_READONLY]
                : [\PDO::SQLITE_ATTR_OPEN_FLAGS => \PDO::SQLITE_OPEN_READONLY];
            $options[\PDO::ATTR_ERRMODE] = \PDO::ERRMODE_EXCEPTION;
            $db = new \PDO('sqlite:' . $file, null, null, $options);
            $find = $db->prepare('SELECT last, region FROM ranges WHERE family = ? AND first <= ? ORDER BY first DESC LIMIT 1');
            $find->bindValue(1, strlen($packed) === 4 ? 4 : 6, \PDO::PARAM_INT);
            $find->bindValue(2, $packed, \PDO::PARAM_LOB);
            $find->execute();
            $row = $find->fetch(\PDO::FETCH_ASSOC);
            return $row && strcmp($packed, $row['last']) <= 0 ? $row['region'] : null;
        } catch (\PDOException) {
            // A missing or unreadable reference catalog must never interrupt a proposal.
            return null;
        }
    }
}
