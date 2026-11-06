<?php
declare(strict_types=1);
namespace Realponto;

final class Domain {
    public const PAYMENTS = ['pix' => 'Pix — 5% de desconto', 'boleto' => 'Boleto em 6 parcelas — sob consulta', 'credit-card' => 'Cartão de crédito em 10 parcelas sem juros'];
    public function __construct(private readonly array $catalog, private readonly string $pricingVersion) {}
    public static function load(): self {
        $raw = file_get_contents(dirname(__DIR__) . '/pricing.json');
        if ($raw === false) throw new \RuntimeException('Tabela de preços indisponível.');
        $data = json_decode($raw, true, 32, JSON_THROW_ON_ERROR);
        foreach (['pricing', 'campaign', 'schedules', 'employees', 'systems'] as $key) if (!isset($data[$key]) || !is_array($data[$key])) throw new \RuntimeException('Tabela de preços inválida.');
        return new self($data, hash('sha256', $raw));
    }
    private static function text(mixed $value, string $label, int $min, int $max): string {
        if (!is_string($value) || strlen($value) > $max * 4 || !preg_match('//u', $value) || preg_match('/[\x00-\x1f\x7f]/u', $value)) throw new Problem(422, "Confira o campo {$label}.");
        $value = trim($value); $length = preg_match_all('/./us', $value);
        if ($length < $min || $length > $max) throw new Problem(422, "Confira o campo {$label}.");
        return $value;
    }
    public function normalize(array $input, ?\DateTimeImmutable $now = null): array {
        $now ??= new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
        if (($input['schemaVersion'] ?? null) !== 1 || ($input['consent'] ?? null) !== true) throw new Problem(422, 'Confira a autorização de contato e os dados enviados.');
        $contact = $input['contact'] ?? null; $configuration = $input['configuration'] ?? null; $payment = $input['payment'] ?? null;
        if (!is_array($contact) || !is_array($configuration) || !is_array($payment)) throw new Problem(422, 'Solicitação inválida.');
        $email = self::text($contact['email'] ?? null, 'e-mail', 3, 254);
        if (filter_var($email, FILTER_VALIDATE_EMAIL) === false) throw new Problem(422, 'Informe um e-mail válido.');
        $phone = self::text($contact['phone'] ?? null, 'telefone', 10, 32);
        if (!preg_match('/^[+()0-9 .-]+$/D', $phone) || strlen(preg_replace('/\D/', '', $phone)) < 10 || strlen(preg_replace('/\D/', '', $phone)) > 13) throw new Problem(422, 'Informe um telefone válido com DDD.');
        $taxId = $contact['taxId'] ?? null;
        if ($taxId !== null) {
            $taxId = self::text($taxId, 'CPF / CNPJ', 0, 40);
            if ($taxId === '') $taxId = null;
            else {
                // Documento é uma referência opcional: formato incorreto não impede o contato.
                $normalizedTaxId = strtoupper(preg_replace('~[.\/\-\s]~u', '', $taxId));
                $taxId = $normalizedTaxId !== '' ? $normalizedTaxId : $taxId;
            }
        }
        $clean = $this->configuration($configuration);
        $method = $payment['method'] ?? null;
        if (!is_string($method) || !isset(self::PAYMENTS[$method])) throw new Problem(422, 'Selecione uma forma de pagamento válida.');
        return [
            'schemaVersion' => 1, 'createdAt' => $now->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d\TH:i:s\Z'),
            'contact' => ['name' => self::text($contact['name'] ?? null, 'nome', 2, 120), 'company' => self::text($contact['company'] ?? null, 'empresa', 2, 180), 'email' => $email, 'phone' => $phone, 'taxId' => $taxId],
            'configuration' => $clean, 'payment' => ['method' => $method, 'label' => self::PAYMENTS[$method]],
            'estimate' => $this->configurationEstimate($clean, $now), 'consent' => true,
        ];
    }
    /** Only the simulator's fixed options are accepted here, including false answers. */
    public function configuration(array $input, bool $partial = false): array {
        $keys = ['system', 'schedules', 'employees', 'bankHours', 'workScale'];
        if ($partial && array_diff(array_keys($input), $keys)) throw new Problem(422, 'Opção de simulação inválida.');
        $clean = [];
        foreach ($keys as $key) {
            $value = $input[$key] ?? null;
            if ($value === null && $partial) {
                $clean[$key] = null;
                continue;
            }
            $valid = match ($key) {
                'system' => in_array($value, array_column($this->catalog['systems'], 'id'), true),
                'schedules', 'employees' => $value === 'consultar' || (is_int($value) && in_array($value, $this->catalog[$key], true)),
                default => is_bool($value),
            };
            if (!$valid) throw new Problem(422, 'Confira as opções selecionadas para a configuração.');
            $clean[$key] = $value;
        }
        return $clean;
    }
    public function configurationEstimate(array $configuration, \DateTimeImmutable $now): array {
        $systems = array_column($this->catalog['systems'], 'secullum', 'id');
        return $this->quote($configuration, (bool)$systems[$configuration['system']], $now);
    }
    private static function percent(int $cents, int $percent): int { return intdiv($cents * $percent + 50, 100); }
    private function quote(array $configuration, bool $secullum, \DateTimeImmutable $now): array {
        $campaign = $this->catalog['campaign'];
        $base = ['status' => 'consultation', 'totalCents' => null, 'campaignDiscountApplied' => false, 'campaignDeadline' => $campaign['deadlineISO'], 'pricingVersion' => $this->pricingVersion];
        if ($configuration['schedules'] === 'consultar' || $configuration['employees'] === 'consultar') return $base;
        $p = $this->catalog['pricing'];
        $subtotal = $p['baseCents'] + $configuration['schedules'] * $p['perScheduleCents'] + $configuration['employees'] * $p['perEmployeeCents'];
        $total = $subtotal + ($configuration['bankHours'] ? self::percent($subtotal, $p['bankHoursPercent']) : 0) + ($configuration['workScale'] ? self::percent($subtotal, $p['workScalePercent']) : 0);
        if ($secullum) $total += self::percent($total, $p['secullumPercent']);
        $active = $now->setTimezone(new \DateTimeZone($campaign['timeZone']))->format('Y-m-d') <= $campaign['deadlineISO'];
        $discount = $active ? self::percent($total, $campaign['discountPercent']) : 0;
        $final = $total - $discount;
        return array_merge($base, ['status' => 'priced', 'totalCents' => $final, 'totalBeforeDiscountCents' => $total, 'discountCents' => $discount, 'campaignDiscountApplied' => $active, 'pixCents' => self::percent($final, 95), 'boletoInstallmentCents' => intdiv($final + 3, 6), 'cardInstallmentCents' => intdiv($final + 5, 10)]);
    }
    public static function note(mixed $value): string { return self::text($value, 'responsável / observação', 0, 160); }
}
