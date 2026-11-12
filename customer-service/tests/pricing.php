<?php
declare(strict_types=1);
require dirname(__DIR__) . '/src/Config.php';
require dirname(__DIR__) . '/src/Pricing.php';
require dirname(__DIR__) . '/src/Domain.php';
use Realponto\{Pricing, Domain};

$checks = 0;
function pricingCheck(bool $condition, string $message): void { global $checks; if (!$condition) throw new RuntimeException($message); $checks++; }
function pricingReject(array $catalog): void {
    try { Pricing::fromJson(json_encode($catalog, JSON_THROW_ON_ERROR)); }
    catch (Throwable) { pricingCheck(true, 'Catálogo inválido rejeitado.'); return; }
    throw new RuntimeException('Catálogo inválido aceito.');
}
$raw = file_get_contents(dirname(__DIR__) . '/pricing.json');
$catalog = json_decode($raw, true, 32, JSON_THROW_ON_ERROR);
$pricing = Pricing::load();
$snapshot = $pricing->snapshot();
pricingCheck($snapshot['version'] === hash('sha256', $raw), 'A versão deve identificar os bytes canônicos.');
pricingCheck(array_keys($snapshot) === ['schemaVersion', 'version', 'catalog'], 'Envelope público inesperado.');
pricingCheck(array_keys($snapshot['catalog']) === ['pricing', 'campaign', 'schedules', 'employees'], 'O endpoint deve publicar somente campos comerciais permitidos.');
pricingCheck($snapshot['catalog']['pricing'] == $catalog['pricing'], 'Os valores públicos devem vir do catálogo canônico.');
$withPrivateFields = $catalog; $withPrivateFields['smtpPassword'] = 'must-never-be-published'; $withPrivateFields['campaign']['internalNote'] = 'must-never-be-published';
pricingCheck(!str_contains(json_encode(Pricing::fromJson(json_encode($withPrivateFields))->snapshot()), 'must-never-be-published'), 'Campos privados não podem aparecer na resposta.');

foreach ([
    static function (&$c) { $c['pricing']['baseCents'] = -1; },
    static function (&$c) { $c['pricing']['baseCents'] = 1.5; },
    static function (&$c) { $c['pricing']['baseCents'] = '80000'; },
    static function (&$c) { $c['pricing']['baseCents'] = 100000001; },
    static function (&$c) { $c['pricing']['bankHoursPercent'] = 101; },
    static function (&$c) { $c['pricing']['unknown'] = 1; },
    static function (&$c) { unset($c['pricing']['baseCents']); },
    static function (&$c) { $c['campaign']['deadlineISO'] = '2026-02-30'; },
    static function (&$c) { $c['campaign']['deadlineLabel'] = 'inválido'; },
    static function (&$c) { $c['campaign']['discountPercent'] = -1; },
    static function (&$c) { $c['campaign']['timeZone'] = 'UTC'; },
    static function (&$c) { $c['schedules'] = [20, 10]; },
    static function (&$c) { $c['employees'] = [20, 20]; },
    static function (&$c) { $c['employees'] = []; },
    static function (&$c) { $c['employees'] = [0]; },
    static function (&$c) { $c['employees'] = [100001]; },
    static function (&$c) { $c['systems'][0]['secullum'] = false; },
    static function (&$c) { $c['systems'][0]['name'] = "bad\nname"; },
    static function (&$c) { $c['systems'][0]['name'] = ''; },
    static function (&$c) { $c['systems'][0]['name'] = str_repeat('a', 121); },
    static function (&$c) { $c['systems'][1] = $c['systems'][0]; },
    static function (&$c) { array_pop($c['systems']); },
] as $mutate) { $invalid = $catalog; $mutate($invalid); pricingReject($invalid); }
foreach (['not json', 'null', '[]', str_repeat(' ', 100001)] as $invalid) {
    try { Pricing::fromJson($invalid); throw new LogicException('JSON inválido aceito.'); }
    catch (LogicException $e) { throw $e; }
    catch (Throwable) { pricingCheck(true, 'JSON inválido rejeitado.'); }
}

// Uma mudança somente na tabela precisa alcançar o cálculo PHP e o endpoint.
$modified = $catalog; $modified['pricing']['baseCents'] = ($catalog['pricing']['baseCents'] + 1234) % 100000001;
$modified['campaign']['discountPercent'] = 0;
$changed = Pricing::fromJson(json_encode($modified, JSON_THROW_ON_ERROR));
$domain = new Domain($changed->catalog, $changed->version);
$input = ['schemaVersion' => 1, 'contact' => ['name' => 'Teste Preços', 'company' => 'Empresa Teste', 'email' => 'precos@example.invalid', 'phone' => '11999999999'], 'configuration' => ['system' => 'rhid', 'schedules' => $modified['schedules'][0], 'employees' => $modified['employees'][0], 'bankHours' => false, 'workScale' => false], 'payment' => ['method' => 'pix'], 'consent' => true];
$estimate = $domain->normalize($input, new DateTimeImmutable($modified['campaign']['deadlineISO'] . 'T12:00:00-03:00'))['estimate'];
$expected = $modified['pricing']['baseCents'] + $modified['schedules'][0] * $modified['pricing']['perScheduleCents'] + $modified['employees'][0] * $modified['pricing']['perEmployeeCents'];
pricingCheck($estimate['totalCents'] === $expected, 'O cálculo PHP deve usar o valor alterado no catálogo.');
pricingCheck($estimate['pricingVersion'] === $changed->snapshot()['version'], 'Servidor e consulta pública devem identificar a mesma versão.');
pricingCheck($changed->snapshot()['catalog']['pricing']['baseCents'] === $modified['pricing']['baseCents'], 'Consulta pública deve refletir a alteração canônica.');
$input['pricingVersion'] = $changed->version;
pricingCheck($domain->normalize($input)['estimate']['pricingVersion'] === $changed->version, 'A versão confirmada deve ser aceita no envio.');
foreach ([$pricing->version, null, 123, str_repeat('x', 64)] as $staleVersion) {
    $input['pricingVersion'] = $staleVersion;
    try { $domain->normalize($input); throw new LogicException('Versão desatualizada foi aceita.'); }
    catch (\Realponto\Problem $error) { pricingCheck($error->status === 409, 'Versão desatualizada deve pedir nova conferência.'); }
}
echo "OK: {$checks} verificações do catálogo compartilhado e cálculo PHP.\n";
