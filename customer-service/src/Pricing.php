<?php
declare(strict_types=1);
namespace Realponto;

/** A mesma tabela alimenta o cálculo do servidor e a consulta pública. */
final class Pricing {
    private const PRICE_KEYS = ['baseCents', 'perScheduleCents', 'perEmployeeCents', 'bankHoursPercent', 'workScalePercent', 'secullumPercent'];
    private const SYSTEMS = ['secullum-offline' => true, 'secullum-rh' => true, 'rhid' => false, 'iponto' => false];
    private function __construct(public readonly array $catalog, public readonly string $version) {}

    public static function load(?string $filename = null): self {
        $raw = @file_get_contents($filename ?? dirname(__DIR__) . '/pricing.json', false, null, 0, 100001);
        if ($raw === false || strlen($raw) > 100000) throw new \RuntimeException('Tabela de preços indisponível.');
        return self::fromJson($raw);
    }
    public static function fromJson(string $raw): self {
        if (strlen($raw) > 100000) throw new \RuntimeException('Tabela de preços inválida.');
        $data = json_decode($raw, true, 32, JSON_THROW_ON_ERROR);
        if (!is_array($data) || array_is_list($data)) throw new \RuntimeException('Tabela de preços inválida.');
        $pricing = self::record($data['pricing'] ?? null);
        if (count($pricing) !== count(self::PRICE_KEYS) || array_diff(self::PRICE_KEYS, array_keys($pricing))) throw new \RuntimeException('Campos de preço inválidos.');
        $cleanPricing = [];
        foreach (self::PRICE_KEYS as $key) $cleanPricing[$key] = self::integer($pricing[$key], str_ends_with($key, 'Percent') ? 100 : 100000000);
        $campaign = self::record($data['campaign'] ?? null);
        $date = $campaign['deadlineISO'] ?? null;
        if (!is_string($date) || !preg_match('/^\d{4}-\d{2}-\d{2}$/D', $date)) throw new \RuntimeException('Prazo inválido.');
        $parsed = \DateTimeImmutable::createFromFormat('!Y-m-d', $date, new \DateTimeZone('UTC'));
        if (!$parsed || $parsed->format('Y-m-d') !== $date || ($campaign['deadlineLabel'] ?? null) !== $parsed->format('d/m/Y') || ($campaign['timeZone'] ?? null) !== 'America/Sao_Paulo') throw new \RuntimeException('Campanha inválida.');
        $cleanCampaign = ['discountPercent' => self::integer($campaign['discountPercent'] ?? null, 100), 'deadlineISO' => $date, 'deadlineLabel' => $campaign['deadlineLabel'], 'timeZone' => $campaign['timeZone']];
        $systems = $data['systems'] ?? null;
        if (!is_array($systems) || !array_is_list($systems) || count($systems) !== count(self::SYSTEMS)) throw new \RuntimeException('Sistemas inválidos.');
        $cleanSystems = []; $seen = [];
        foreach ($systems as $system) {
            $id = is_array($system) ? ($system['id'] ?? null) : null;
            $name = is_array($system) ? ($system['name'] ?? null) : null;
            if (!is_string($id) || !array_key_exists($id, self::SYSTEMS) || isset($seen[$id]) || ($system['secullum'] ?? null) !== self::SYSTEMS[$id] || !is_string($name) || trim($name) === '' || strlen($name) > 480 || !preg_match('//u', $name) || preg_match_all('/./us', $name) > 120 || preg_match('/[\x00-\x1f\x7f]/u', $name)) throw new \RuntimeException('Sistema inválido.');
            $seen[$id] = true; $cleanSystems[] = ['id' => $id, 'name' => $name, 'secullum' => $system['secullum']];
        }
        return new self(['pricing' => $cleanPricing, 'campaign' => $cleanCampaign, 'schedules' => self::quantities($data['schedules'] ?? null), 'employees' => self::quantities($data['employees'] ?? null), 'systems' => $cleanSystems], hash('sha256', $raw));
    }
    private static function record(mixed $value): array {
        if (!is_array($value) || array_is_list($value)) throw new \RuntimeException('Tabela de preços inválida.');
        return $value;
    }
    private static function integer(mixed $value, int $maximum): int {
        if (!is_int($value) || $value < 0 || $value > $maximum) throw new \RuntimeException('Valor de preço inválido.');
        return $value;
    }
    private static function quantities(mixed $values): array {
        if (!is_array($values) || !array_is_list($values) || count($values) === 0 || count($values) > 100) throw new \RuntimeException('Faixas inválidas.');
        $last = 0;
        foreach ($values as $value) {
            if (!is_int($value) || $value <= $last || $value > 100000) throw new \RuntimeException('Faixa inválida.');
            $last = $value;
        }
        return $values;
    }
    public function snapshot(): array {
        // Lista explícita: nenhum outro dado adicionado ao arquivo privado é publicado.
        return ['schemaVersion' => 1, 'version' => $this->version, 'catalog' => array_intersect_key($this->catalog, array_flip(['pricing', 'campaign', 'schedules', 'employees']))];
    }
    public static function endpoint(): never {
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        header('Access-Control-Allow-Origin: *');
        header('X-Content-Type-Options: nosniff');
        header('Referrer-Policy: no-referrer');
        header("Content-Security-Policy: default-src 'none'; frame-ancestors 'none'");
        header('X-Frame-Options: DENY');
        $method = $_SERVER['REQUEST_METHOD'] ?? '';
        if (!in_array($method, ['GET', 'HEAD'], true)) {
            header('Allow: GET, HEAD'); http_response_code(405);
            echo json_encode(['ok' => false, 'message' => 'Método não permitido.'], JSON_UNESCAPED_UNICODE); exit;
        }
        try {
            $body = json_encode(self::load()->snapshot(), JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
        } catch (\Throwable $error) {
            error_log('Realponto pricing: unavailable (' . get_class($error) . ').');
            http_response_code(503);
            $body = json_encode(['ok' => false, 'message' => 'Tabela de preços temporariamente indisponível.'], JSON_UNESCAPED_UNICODE);
        }
        if ($method !== 'HEAD') echo $body;
        exit;
    }
}
