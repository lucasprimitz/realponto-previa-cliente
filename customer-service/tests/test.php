<?php
declare(strict_types=1);
require dirname(__DIR__) . '/src/bootstrap.php';
use Realponto\{Config, Domain, Store, Mail, Problem};

$checks = 0;
function check(bool $valid, string $message): void { global $checks; if (!$valid) throw new RuntimeException($message); $checks++; }
function problem(callable $fn, int $status): void { try { $fn(); } catch (Problem $e) { check($e->status === $status, 'Código de erro inesperado.'); return; } throw new RuntimeException('A operação inválida foi aceita.'); }
$testDirectory = sys_get_temp_dir() . '/realponto-contacts-test-' . bin2hex(random_bytes(8));
$settings = ['origin' => 'http://127.0.0.1:8999', 'dataDirectory' => $testDirectory, 'encryptionKey' => base64_encode(random_bytes(32)), 'passwordHash' => password_hash(bin2hex(random_bytes(16)), PASSWORD_DEFAULT), 'submissionsEnabled' => true, 'developmentLoopback' => true, 'mail' => ['enabled' => false]];
$config = new Config($settings); $store = new Store($config); $domain = Domain::load();
$input = ['schemaVersion' => 1, 'createdAt' => '1900-01-01', 'contact' => ['name' => 'Cliente de Teste', 'company' => 'Empresa de Teste', 'email' => 'teste@example.invalid', 'phone' => '(11) 99999-9999', 'taxId' => '123.456.789-09'], 'configuration' => ['system' => 'iponto', 'schedules' => 10, 'employees' => 40, 'bankHours' => true, 'workScale' => false], 'payment' => ['method' => 'pix', 'label' => 'forged'], 'estimate' => ['totalCents' => 1], 'consent' => true];
$catalog = json_decode(file_get_contents(dirname(__DIR__) . '/pricing.json'), true, 64, JSON_THROW_ON_ERROR);
$now = new DateTimeImmutable($catalog['campaign']['deadlineISO'] . 'T12:00:00-03:00');
$request = $domain->normalize($input, $now);
$pricing = $catalog['pricing'];
$base = $pricing['baseCents'] + 10 * $pricing['perScheduleCents'] + 40 * $pricing['perEmployeeCents'];
$withBank = $base + (int)round($base * $pricing['bankHoursPercent'] / 100);
$expectedTotal = $withBank - (int)round($withBank * $catalog['campaign']['discountPercent'] / 100);
check($request['estimate']['totalCents'] === $expectedTotal, 'O preço do navegador não pode ser confiado.');
check($request['createdAt'] === $now->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d\TH:i:s\Z'), 'O servidor deve definir a data.');
check($request['payment']['label'] === Domain::PAYMENTS['pix'], 'Rótulo de pagamento deve vir do servidor.');
check($request['contact']['taxId'] === '12345678909', 'Documento deve ser normalizado.');
foreach (['email' => "a@example.invalid\r\nBcc: evil@example.invalid", 'phone' => 'telefone', 'taxId' => '123', 'name' => str_repeat('a', 121)] as $key => $value) { $bad = $input; $bad['contact'][$key] = $value; problem(fn() => $domain->normalize($bad), 422); }
$bad = $input; $bad['configuration']['bankHours'] = 'false'; problem(fn() => $domain->normalize($bad), 422);
$bad = $input; $bad['configuration']['schedules'] = 11; problem(fn() => $domain->normalize($bad), 422);
$bad = $input; $bad['configuration']['system'] = 'x'; problem(fn() => $domain->normalize($bad), 422);
$bad = $input; $bad['consent'] = false; problem(fn() => $domain->normalize($bad), 422);
$created = $store->create($request, str_repeat('a', 32));
check($created['created'] === true && $created['mailStatus'] === 'disabled', 'Recebimento sem e-mail configurado deve ser persistido.');
$repeat = $store->create($domain->normalize($input, $now->modify('+1 hour')), str_repeat('a', 32));
check(!$repeat['created'] && $repeat['id'] === $created['id'], 'Repetição deve reutilizar o registro.');
$other = $request; $other['contact']['name'] = 'Outro Cliente'; problem(fn() => $store->create($other, str_repeat('a', 32)), 409);
$raw = $store->db->query('SELECT * FROM requests')->fetch();
check(!str_contains($raw['payload'], 'Cliente') && !str_contains($raw['payload'], '12345678909'), 'Dados pessoais não podem ficar legíveis no banco.');
check($store->decrypt($raw['payload']) === json_encode($request, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE), 'Criptografia deve preservar o registro.');
$tampered = base64_decode($raw['payload']); $tampered[30] = chr(ord($tampered[30]) ^ 1);
try { $store->decrypt(base64_encode($tampered)); throw new RuntimeException('Dado adulterado foi aceito.'); } catch (RuntimeException $e) { check($e->getMessage() === 'Não foi possível abrir o registro.', 'Cifra adulterada deve falhar.'); }
$update = $store->update(['id' => $created['id'], 'handled' => true, 'note' => 'Encaminhado para Ana', 'version' => 1]);
check($update['item']['handled'] && $update['item']['note'] === 'Encaminhado para Ana' && $update['item']['version'] === 2, 'Atualização deve persistir.');
problem(fn() => $store->update(['id' => $created['id'], 'handled' => false, 'note' => '', 'version' => 1]), 409);
check(!str_contains((string)$store->db->query('SELECT note FROM requests')->fetchColumn(), 'Ana'), 'Observação também deve ser criptografada.');
check($store->listing(1, 'pending')['total'] === 0 && $store->listing(1, 'handled')['total'] === 1, 'Filtros de acompanhamento.');
$store->rate('test', 'identity', 2, 60, 100); $store->rate('test', 'identity', 2, 60, 100); problem(fn() => $store->rate('test', 'identity', 2, 60, 100), 429); $store->rate('test', 'identity', 2, 60, 161);
check((new Mail($config, $store))->drain()['skipped'] === 'not-configured', 'Não deve enviar sem configuração.');
$mailSettings = $settings; $mailSettings['mail'] = ['enabled' => true, 'host' => 'smtp.example.invalid', 'from' => 'noreply@example.invalid', 'recipient' => 'ti@example.invalid'];
$mail = new Mail(new Config($mailSettings), $store);
$failed = $mail->drain(20, static function () { throw new RuntimeException('Falha de entrega simulada'); }, 1000);
check($failed['failed'] === 1 && $store->listing(1, 'all')['total'] === 1, 'Falha de e-mail não pode perder o contato.');
check($mail->drain(20, static function () { throw new RuntimeException('Não deve tentar imediatamente'); }, 1001)['failed'] === 0, 'Fila deve respeitar intervalo.');
$sent = $mail->drain(20, static function (array $item) { check(str_contains(Mail::body($item), 'CPF / CNPJ: 12345678909'), 'Cópia deve incluir os dados da solicitação.'); }, 1201);
check($sent['sent'] === 1 && $store->listing(1, 'all')['items'][0]['mailStatus'] === 'sent', 'Fila deve recuperar entrega após configuração.');
check($mail->drain(20, static function () { throw new RuntimeException('Não reenviar'); }, 1400)['sent'] === 0, 'Não reenviar e-mails confirmados.');
$fixtures = json_decode(file_get_contents(__DIR__ . '/pricing-fixtures.json'), true, 64, JSON_THROW_ON_ERROR);
foreach ($fixtures as $fixture) {
    $actual = $domain->normalize($fixture['input'], new DateTimeImmutable($fixture['now']))['estimate']; $expected = $fixture['expected'];
    check($actual['status'] === $expected['status'], 'Status divergente entre PHP e JS.');
    check($actual['totalCents'] === ($expected['cents'] ?? null), 'Preço divergente entre PHP e JS.');
    check($actual['campaignDiscountApplied'] === ($expected['discountApplied'] ?? false), 'Campanha divergente entre PHP e JS.');
}
echo "OK: {$checks} verificações; " . count($fixtures) . " cenários de preço; nenhum e-mail real enviado.\n";
// Arquivos temporários exclusivos do teste, sem remoção recursiva de caminhos externos.
$store = null; unset($mail); gc_collect_cycles();
foreach (['contacts.sqlite', 'contacts.sqlite-wal', 'contacts.sqlite-shm', 'mail-worker.lock'] as $name) @unlink($testDirectory . '/' . $name);
@rmdir($testDirectory);
