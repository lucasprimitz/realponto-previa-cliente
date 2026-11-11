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
function checkAccessContext(Config $config): void {
    $path = dirname(__DIR__) . '/geo/br-regions.db';
    check(is_file($path), 'A base regional de referência acompanha o serviço.');
    $db = new PDO('sqlite:' . $path);
    $find = $db->prepare("SELECT first,last,region FROM ranges WHERE family=? AND region='São Paulo, Brasil' LIMIT 1");
    $original = $_SERVER;
    try {
        foreach ([4, 6] as $family) {
            $find->execute([$family]);
            $range = $find->fetch(PDO::FETCH_ASSOC);
            check((bool)$range, 'Há faixas públicas brasileiras de IPv' . $family);
            foreach (['first','last'] as $bound) {
                $_SERVER = ['REMOTE_ADDR' => inet_ntop($range[$bound]), 'HTTP_USER_AGENT' => 'Mozilla/5.0 (iPhone) Mobile Safari'];
                check(\Realponto\AccessContext::fromServer($config) === ['device' => 'mobile','region' => $range['region']], 'Extremo da faixa IPv' . $family);
            }
            $_SERVER['HTTP_X_FORWARDED_FOR'] = '198.51.100.1';
            check(\Realponto\AccessContext::fromServer($config)['region'] === null, 'Proxy de origem incerta não recebe a região da borda.');
        }
        $_SERVER = ['REMOTE_ADDR' => '127.0.0.1', 'HTTP_X_FORWARDED_FOR' => inet_ntop($range['first'])];
        check(\Realponto\AccessContext::fromServer($config) === ['device' => 'unknown','region' => null], 'IP privado e cabeçalho de origem injetado não indicam região.');
    } finally {
        $_SERVER = $original;
    }
}
checkAccessContext($config);
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
foreach ([
    [null, null], ['', null], ['   ', null],
    ['123', '123'], ['12345678900', '12345678900'], ['123456789012345', '123456789012345'],
    ['12.abc.345/01de-67', '12ABC34501DE67'], ['12.abc.345/01de-ab', '12ABC34501DEAB'],
    [' nao informado ', 'NAOINFORMADO'], ['123?abc', '123?ABC'], ['...', '...'],
    [str_repeat('a', 40), str_repeat('A', 40)],
] as [$document, $expectedDocument]) {
    $sample = $input; $sample['contact']['taxId'] = $document;
    check($domain->normalize($sample, $now)['contact']['taxId'] === $expectedDocument, 'Documento opcional, incompleto ou malformado deve ser aceito sem apagar o dado.');
}
foreach ([str_repeat('a', 41), "123\n456", "123\0abc", "\xFF", 123, ['123']] as $document) {
    $bad = $input; $bad['contact']['taxId'] = $document;
    problem(fn() => $domain->normalize($bad), 422);
}
foreach (['', '123', 'telefone', null] as $phone) {
    $bad = $input; $bad['contact']['phone'] = $phone;
    problem(fn() => $domain->normalize($bad), 422);
}
$withoutDocument = $input; unset($withoutDocument['contact']['taxId']);
check($domain->normalize($withoutDocument, $now)['contact']['taxId'] === null, 'Documento ausente não pode impedir o envio.');
foreach (['email' => "a@example.invalid\r\nBcc: evil@example.invalid", 'name' => str_repeat('a', 121)] as $key => $value) { $bad = $input; $bad['contact'][$key] = $value; problem(fn() => $domain->normalize($bad), 422); }
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
$sent = $mail->drain(20, static function (array $item) { check(str_contains(Mail::body($item), 'CPF / CNPJ: 123.456.789-09'), 'Cópia deve incluir os dados da solicitação.'); }, 1201);
check($sent['sent'] === 1 && $store->listing(1, 'all')['items'][0]['mailStatus'] === 'sent', 'Fila deve recuperar entrega após configuração.');
check($mail->drain(20, static function () { throw new RuntimeException('Não reenviar'); }, 1400)['sent'] === 0, 'Não reenviar e-mails confirmados.');
$fixtures = json_decode(file_get_contents(__DIR__ . '/pricing-fixtures.json'), true, 64, JSON_THROW_ON_ERROR);
foreach ($fixtures as $fixture) {
    $actual = $domain->normalize($fixture['input'], new DateTimeImmutable($fixture['now']))['estimate']; $expected = $fixture['expected'];
    check($actual['status'] === $expected['status'], 'Status divergente entre PHP e JS.');
    check($actual['totalCents'] === ($expected['cents'] ?? null), 'Preço divergente entre PHP e JS.');
    check($actual['campaignDiscountApplied'] === ($expected['discountApplied'] ?? false), 'Campanha divergente entre PHP e JS.');
}

// Modelos de e-mail: dados seguros, estimativas condicionais e alternativa em texto.
$mailItem = ['id' => 'RP-EXEMPLO-20261030', 'receivedAt' => '2026-10-30T18:39:49Z', 'request' => $request];
$html = Mail::html($mailItem);
check(str_contains($html, 'Cliente de Teste') && str_contains($html, 'Empresa de Teste'), 'E-mail HTML deve preservar o contato.');
check(str_contains($html, Mail::money($request['estimate']['totalCents'])), 'E-mail deve usar a estimativa registrada.');
check(str_contains($html, '30/10/2026') && str_contains($html, '15:39'), 'Recebimento deve ser legível no horário de São Paulo.');
check(!str_contains($html, '/contatos/') && !str_contains($html, 'Abrir painel') && !str_contains(Mail::body($mailItem), 'painel protegido'), 'E-mail encaminhável não deve incluir acesso ao painel.');
check(!str_contains($html, '<script') && !str_contains($html, '<iframe'), 'E-mail não pode conter conteúdo ativo.');
$unsafeItem = $mailItem;
$unsafeItem['id'] = '<script>alert(1)</script>';
$unsafeItem['request']['contact']['name'] = '<img src=x onerror="alert(1)">';
$unsafeItem['request']['contact']['company'] = 'Empresa & Filhos <b>Teste</b>';
$unsafeItem['request']['payment']['label'] = '<iframe src="https://example.invalid"></iframe>';
$escaped = Mail::html($unsafeItem);
foreach (['<script', '<img src=x', '<b>Teste</b>', '<iframe'] as $payload) check(!str_contains($escaped, $payload), 'Dados do formulário precisam ser escapados no HTML.');
check(str_contains($escaped, '&lt;') && str_contains($escaped, '&amp;'), 'HTML deve exibir os dados como texto.');
foreach (['boleto' => [6, 'boletoInstallmentCents', 'Boleto em 6 parcelas — sob consulta', 'Boleto em até 6 parcelas — sob consulta'],
          'credit-card' => [10, 'cardInstallmentCents', 'Cartão de crédito em 10 parcelas sem juros', 'Cartão de crédito em até 10 parcelas sem juros']] as $method => [$limit, $amountField, $oldLabel, $newLabel]) {
    $legacyItem = $mailItem;
    $legacyItem['request']['payment'] = ['method' => $method, 'label' => $oldLabel];
    foreach ([Mail::body($legacyItem), Mail::html($legacyItem)] as $message) {
        check(str_contains($message, $newLabel) && !str_contains($message, $oldLabel), 'O e-mail deve exibir o limite de parcelas também nas solicitações anteriores.');
        check(str_contains($message, 'Ex.: ' . $limit . 'x de ' . Mail::money($legacyItem['request']['estimate'][$amountField])), 'A parcela apresentada deve ser um exemplo calculado para o prazo máximo.');
    }
}
foreach (['secullum-offline', 'secullum-rh', 'rhid', 'iponto'] as $system) {
    foreach (array_keys(Domain::PAYMENTS) as $method) {
        foreach ([10, 'consultar'] as $schedules) {
            $sample = $input;
            $sample['configuration']['system'] = $system;
            $sample['configuration']['schedules'] = $schedules;
            $sample['payment']['method'] = $method;
            $sample['contact']['taxId'] = null;
            $renderItem = $mailItem;
            $renderItem['request'] = $domain->normalize($sample, $now);
            $rendered = Mail::html($renderItem);
            $plain = Mail::body($renderItem);
            check(str_contains($rendered, htmlspecialchars(Domain::PAYMENTS[$method], ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8')), 'Forma escolhida deve acompanhar a solicitação.');
            check(str_contains($plain, Domain::PAYMENTS[$method]), 'Alternativa de texto deve manter a forma escolhida.');
            check(str_contains($rendered, 'Não informado'), 'Documento opcional ausente deve ficar legível.');
            if ($schedules === 'consultar') {
                check(str_contains($rendered, 'Sob consulta') && !str_contains($rendered, 'R$ 0,00'), 'Consulta personalizada não pode inventar preço zero.');
                check(!str_contains($plain, '6x de Sob consulta') && !str_contains($plain, '10x de Sob consulta'), 'Consulta personalizada não pode simular parcelas inexistentes.');
            } else {
                $amountField = ['pix' => 'pixCents', 'boleto' => 'boletoInstallmentCents', 'credit-card' => 'cardInstallmentCents'][$method];
                $chosenAmount = Mail::money($renderItem['request']['estimate'][$amountField]);
                check(str_contains($rendered, $chosenAmount) && str_contains($plain, $chosenAmount), 'Pagamento escolhido deve usar os centavos calculados pelo servidor.');
            }
            foreach (['pix' => 'Pix', 'boleto' => 'Boleto', 'credit-card' => 'Cartão de crédito'] as $otherMethod => $otherTitle) {
                check(str_contains($rendered, $otherTitle) && str_contains($plain, $otherTitle), 'E-mail deve manter as alternativas de pagamento para consulta.');
                if ($otherMethod === $method) check(str_contains($plain, '[ESCOLHIDO PELO CLIENTE] ' . $otherTitle . ':'), 'Alternativa em texto deve identificar a escolha do cliente.');
            }
            check(substr_count($rendered, 'ESCOLHIDO PELO CLIENTE') === 1 && substr_count($plain, '[ESCOLHIDO PELO CLIENTE]') === 1, 'Somente uma opção deve ser destacada.');
            check(str_contains($rendered, $system === 'secullum-offline' ? 'Não contemplada' : 'Contemplada'), 'Escopo deve respeitar o sistema escolhido.');
        }
    }
}
$expiredItem = $mailItem;
$expiredItem['request'] = $domain->normalize($input, $now->modify('+1 day'));
check(str_contains(Mail::html($expiredItem), Mail::money($expiredItem['request']['estimate']['totalCents'])), 'Campanha encerrada deve apresentar o total do registro.');
$invalidDateItem = $mailItem; $invalidDateItem['receivedAt'] = 'data-invalida';
check(Mail::html($invalidDateItem) !== '' && Mail::body($invalidDateItem) !== '', 'Registro com data inesperada não pode interromper a entrega.');

foreach ([
    [null, 'Não informado'], ['', 'Não informado'], ['   ', 'Não informado'],
    ['12345678909', '123.456.789-09'], ['123.456.789-09', '123.456.789-09'],
    ['12345678000190', '12.345.678/0001-90'], ['12.345.678/0001-90', '12.345.678/0001-90'],
    ['12abc34501de67', '12.ABC.345/01DE-67'], ['12.abc.345/01de-67', '12.ABC.345/01DE-67'],
    ['123', '123'], ['12ABC34501DEAB', '12ABC34501DEAB'], ['123?ABC', '123?ABC'], ['...', '...'],
    ['12<script>alert("x")</script>', '12<script>alert("x")</script>'],
] as [$document, $displayDocument]) {
    $documentItem = $mailItem; $documentItem['request']['contact']['taxId'] = $document;
    $documentHtml = Mail::html($documentItem); $documentBody = Mail::body($documentItem);
    check(str_contains($documentBody, 'CPF / CNPJ: ' . $displayDocument), 'E-mail em texto deve formatar apenas documento completo e preservar entrada malformada.');
    check(str_contains($documentHtml, htmlspecialchars($displayDocument, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8')), 'E-mail HTML deve exibir documento formatado ou entrada malformada com escape.');
    if (str_contains($displayDocument, '<')) check(!str_contains($documentHtml, $displayDocument), 'Documento inválido não pode inserir HTML no e-mail.');
}

$malformedInput = $input; $malformedInput['contact']['taxId'] = '123?abc';
$malformedRequest = $domain->normalize($malformedInput, $now);
$malformedReceipt = $store->create($malformedRequest, str_repeat('b', 32));
$storedDocument = $store->db->prepare('SELECT payload FROM requests WHERE id = ?');
$storedDocument->execute([$malformedReceipt['id']]);
$savedRequest = json_decode($store->decrypt($storedDocument->fetchColumn()), true, 64, JSON_THROW_ON_ERROR);
check($savedRequest['contact']['taxId'] === '123?ABC', 'Persistência criptografada deve preservar documento malformado informado.');
$malformedMail = ['id' => $malformedReceipt['id'], 'receivedAt' => $now->format(DATE_ATOM), 'request' => $savedRequest];
check(str_contains(Mail::body($malformedMail), 'CPF / CNPJ: 123?ABC') && str_contains(Mail::html($malformedMail), '123?ABC'), 'Documento malformado deve acompanhar os dados no e-mail.');
$storedDocument = null;


// Relatórios: consideram todo o ano, fuso de São Paulo e valor histórico da opção escolhida.
$reportSettings = $settings; $reportSettings['dataDirectory'] = $testDirectory . '/reports';
$reportStore = new Store(new Config($reportSettings));
$reportSequence = 0;
$reportInsert = function (string $received, string $method, ?int $total = 10000, ?int $pix = 9500, string $status = 'priced') use ($reportStore, $request, &$reportSequence): array {
    $sample = $request; $sample['createdAt'] = $received; $sample['payment']['method'] = $method;
    $sample['estimate'] = ['status' => $status, 'totalCents' => $total, 'pixCents' => $pix, 'boletoInstallmentCents' => 1667, 'cardInstallmentCents' => 1000];
    return $reportStore->create($sample, str_pad('report-' . ++$reportSequence, 32, 'x'));
};
for ($i = 0; $i < 28; $i++) {
    $receipt = $reportInsert('2031-01-15T12:00:00Z', $i % 2 === 0 ? 'pix' : 'boleto');
    if ($i < 3) $reportStore->update(['id' => $receipt['id'], 'handled' => true, 'note' => 'Observação privada', 'version' => 1]);
}
$reportInsert('2031-01-01T02:59:59Z', 'boleto', 1100); // Ainda dezembro de 2030 no Brasil.
$reportInsert('2031-01-01T03:00:00Z', 'boleto', 500);
$reportInsert('2031-02-01T02:59:59Z', 'pix', 700, 665); // Ainda janeiro no Brasil.
$reportInsert('2031-02-01T03:00:00Z', 'credit-card', 800);
$reportInsert('2032-01-01T02:59:59Z', 'boleto', 900); // Ainda dezembro de 2031 no Brasil.
$reportInsert('2032-01-01T03:00:00Z', 'boleto', 1200);
$reportInsert('2031-03-10T12:00:00Z', 'boleto', null, null, 'consultation');
$reportInsert('2031-04-10T12:00:00Z', 'pix', 10000, null); // Sem estimativa Pix, não inventar valor.
$reportInsert('2031-05-10T12:00:00Z', 'credit-card', 0, 0);
$report = $reportStore->reports(2031);
check($report['year'] === 2031 && $report['timeZone'] === 'America/Sao_Paulo' && count($report['months']) === 12, 'Relatório deve identificar ano e fuso e preencher os doze meses.');
check(count($reportStore->listing(1, 'all')['items']) === 25 && $report['total']['count'] === 35, 'Relatório deve incluir registros de todas as páginas, sem filtros da lista.');
check($report['months'][0] === ['month' => '2031-01', 'count' => 30, 'pricedCount' => 30, 'consultationCount' => 0, 'totalCents' => 274165, 'handledCount' => 3], 'Janeiro deve respeitar limites locais e somar Pix líquido e boleto sem arredondar parcelas.');
check($report['months'][1]['count'] === 1 && $report['months'][1]['totalCents'] === 800 && $report['months'][11]['totalCents'] === 900, 'Viradas de mês e ano devem usar São Paulo.');
check($report['months'][2]['consultationCount'] === 1 && $report['months'][3]['consultationCount'] === 1, 'Solicitações sob consulta ou sem valor disponível não entram no total monetário.');
check($report['months'][4]['pricedCount'] === 1 && $report['months'][4]['totalCents'] === 0, 'Zero gravado é uma estimativa válida, diferente de valor desconhecido.');
check($report['total'] === ['count' => 35, 'pricedCount' => 33, 'consultationCount' => 2, 'totalCents' => 275865, 'handledCount' => 3], 'Total anual deve reconciliar com os meses e não multiplicar parcelas arredondadas.');
check($report['months'][5]['count'] === 0 && $report['months'][5]['totalCents'] === 0, 'Mês vazio deve continuar visível.');
$emptyReport = $reportStore->reports(2029);
check($emptyReport['total']['count'] === 0 && count($emptyReport['months']) === 12, 'Ano sem solicitações deve retornar relatório vazio estruturado.');
$reportJson = json_encode($report, JSON_THROW_ON_ERROR);
foreach (['Cliente de Teste', 'Empresa de Teste', 'teste@example.invalid', '12345678909', 'Observação privada', 'RP-'] as $privateValue) check(!str_contains($reportJson, $privateValue), 'Relatório agregado não pode expor contatos, protocolos ou observações.');
foreach ([1999, 2101] as $invalidYear) problem(fn() => $reportStore->reports($invalidYear), 422);
unset($reportInsert, $reportStore); gc_collect_cycles();
foreach (['contacts.sqlite', 'contacts.sqlite-wal', 'contacts.sqlite-shm'] as $name) @unlink($reportSettings['dataDirectory'] . '/' . $name);
@rmdir($reportSettings['dataDirectory']);


// Inativação reversível: exclui listas e relatórios, preservando o registro e a entrega.
$archiveSettings = $settings; $archiveSettings['dataDirectory'] = $testDirectory . '/archive';
$archiveStore = new Store(new Config($archiveSettings));
$archiveRows = [];
for ($i = 0; $i < 29; $i++) {
    $sample = $request; $sample['createdAt'] = '2031-06-10T12:00:00Z';
    if ($i === 1) { $sample['estimate']['status'] = 'consultation'; $sample['estimate']['totalCents'] = null; $sample['estimate']['pixCents'] = null; }
    $receipt = $archiveStore->create($sample, str_pad('archive-' . $i, 32, 'x'));
    $archiveRows[] = $receipt['id'];
}
$firstArchive = $archiveStore->update(['id' => $archiveRows[0], 'handled' => true, 'note' => 'Encaminhado antes de inativar', 'version' => 1])['item'];
$beforeRaw = $archiveStore->db->query("SELECT * FROM requests WHERE id='" . $archiveRows[0] . "'")->fetch();
$beforeReport = $archiveStore->reports(2031);
check($firstArchive['archived'] === false && $firstArchive['archivedAt'] === null, 'Novos registros começam ativos.');
check($archiveStore->listing(1, 'all')['totalPages'] === 2, 'Registros ativos devem paginar.');
foreach ([['archived' => 'true'], ['archived' => 1], ['version' => '2'], ['version' => 0], ['id' => 'invalid']] as $invalid) problem(fn() => $archiveStore->archive(array_replace(['id' => $archiveRows[0], 'version' => 2, 'archived' => true], $invalid)), 422);
problem(fn() => $archiveStore->archive(['id' => $archiveRows[0], 'version' => 1, 'archived' => true]), 409);
$archived = $archiveStore->archive(['id' => $archiveRows[0], 'version' => 2, 'archived' => true])['item'];
check($archived['archived'] === true && $archived['version'] === 3 && preg_match('/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$/D', $archived['archivedAt']) === 1, 'Inativação deve registrar estado, data UTC e versão.');
check($archived['request'] === $firstArchive['request'] && $archived['note'] === $firstArchive['note'] && $archived['handled'], 'Inativação preserva escopo, valores, contato e encaminhamento.');
$afterRaw = $archiveStore->db->query("SELECT * FROM requests WHERE id='" . $archiveRows[0] . "'")->fetch();
foreach (['payload', 'note', 'mail_status', 'mail_attempts', 'mailed_at', 'next_attempt', 'mail_error', 'received_at', 'input_hash', 'key_hash'] as $field) check($afterRaw[$field] === $beforeRaw[$field], 'Inativação não altera dados nem estado da fila de e-mail.');
check($archiveStore->listing(1, 'handled')['total'] === 0 && $archiveStore->listing(1, 'pending')['total'] === 28, 'Filtros ativos não incluem solicitações inativas.');
check($archiveStore->listing(1, 'archived')['total'] === 1 && $archiveStore->listing(1, 'archived')['items'][0]['id'] === $archiveRows[0], 'Inativos têm filtro próprio.');
$afterReport = $archiveStore->reports(2031);
check($afterReport['total']['count'] === $beforeReport['total']['count'] - 1 && $afterReport['total']['handledCount'] === 0 && $afterReport['total']['totalCents'] === $beforeReport['total']['totalCents'] - $firstArchive['request']['estimate']['pixCents'], 'Relatório deve retirar contagem e valor Pix histórico da solicitação inativa.');
problem(fn() => $archiveStore->update(['id' => $archiveRows[0], 'handled' => false, 'note' => 'Não alterar', 'version' => 3]), 409);
problem(fn() => $archiveStore->archive(['id' => $archiveRows[0], 'version' => 2, 'archived' => false]), 409);
problem(fn() => $archiveStore->archive(['id' => $archiveRows[0], 'version' => 3, 'archived' => true]), 409);
$restored = $archiveStore->archive(['id' => $archiveRows[0], 'version' => 3, 'archived' => false])['item'];
check(!$restored['archived'] && $restored['archivedAt'] === null && $restored['version'] === 4, 'Restauração reativa e avança a versão.');
check($archiveStore->reports(2031) === $beforeReport && $archiveStore->listing(1, 'handled')['total'] === 1, 'Restauração recupera exatamente relatório e encaminhamento anteriores.');
for ($i = 0; $i < 26; $i++) $archiveStore->archive(['id' => $archiveRows[$i], 'version' => $i === 0 ? 4 : 1, 'archived' => true]);
check($archiveStore->listing(1, 'all')['total'] === 3 && $archiveStore->listing(1, 'all')['totalPages'] === 1 && $archiveStore->listing(2, 'all')['items'] === [], 'Paginação ativa deve refletir inativações, inclusive remoção da última página.');
check($archiveStore->listing(1, 'archived')['total'] === 26 && count($archiveStore->listing(1, 'archived')['items']) === 25 && count($archiveStore->listing(2, 'archived')['items']) === 1, 'Inativos devem paginar separadamente.');
check($archiveStore->reports(2031)['total']['count'] === 3 && $archiveStore->reports(2031)['total']['consultationCount'] === 0, 'Inativação também retira solicitações sob consulta do relatório.');
problem(fn() => $archiveStore->listing(1, 'deleted'), 422);
problem(fn() => $archiveStore->archive(['id' => 'RP-' . str_repeat('0', 24), 'version' => 1, 'archived' => true]), 409);

// Banco legado sem colunas novas: migração preserva dados criptografados e é repetível.
$legacySettings = $settings; $legacySettings['dataDirectory'] = $testDirectory . '/legacy';
$legacyConfig = new Config($legacySettings);
$legacyDb = new PDO('sqlite:' . $legacySettings['dataDirectory'] . '/contacts.sqlite', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$legacyDb->exec('CREATE TABLE requests (id TEXT PRIMARY KEY, key_hash TEXT NOT NULL UNIQUE, input_hash TEXT NOT NULL, payload TEXT NOT NULL, note TEXT NOT NULL, received_at TEXT NOT NULL, handled INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1, mail_status TEXT NOT NULL, mail_attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0, mail_error TEXT, mailed_at TEXT)');
$legacyRow = $beforeRaw; unset($legacyRow['archived'], $legacyRow['archived_at']);
$legacyDb->prepare('INSERT INTO requests (' . implode(',', array_keys($legacyRow)) . ') VALUES (' . implode(',', array_fill(0, count($legacyRow), '?')) . ')')->execute(array_values($legacyRow));
$legacyDb = null;
$legacyStore = new Store($legacyConfig);
$migrated = $legacyStore->listing(1, 'all');
check($migrated['total'] === 1 && $migrated['items'][0]['archived'] === false && $migrated['items'][0]['archivedAt'] === null, 'Migração inicia registros legados como ativos.');
check($migrated['items'][0]['request'] === $firstArchive['request'] && $migrated['items'][0]['note'] === $firstArchive['note'] && $migrated['items'][0]['version'] === 2, 'Migração preserva conteúdo e versão.');
$legacyStore->archive(['id' => $legacyRow['id'], 'version' => 2, 'archived' => true]);
$legacyStore = null;
$legacyStore = new Store($legacyConfig);
check($legacyStore->listing(1, 'all')['total'] === 0 && $legacyStore->listing(1, 'archived')['total'] === 1 && $legacyStore->reports(2031)['total']['count'] === 0, 'Reabertura não reativa registros nem repete colunas da migração.');

// Cada envio tem seu próprio rascunho, mas a mesma pessoa pode enviar várias propostas e voltar em outro dia.
$trafficConfig = new Config(array_replace($settings, ['dataDirectory' => $testDirectory . '/traffic']));
$trafficStore = new Store($trafficConfig);
$visits = [
    ['2024-02-28T12:00:00Z', 1], ['2024-02-28T12:50:00Z', 1], ['2024-02-28T13:05:00Z', 1],
    ['2024-02-29T12:20:00Z', 1], ['2024-02-29T12:30:00Z', 2], ['2024-03-01T02:59:59Z', 1],
    ['2024-03-01T03:00:00Z', 2],
];
foreach ($visits as $index => [$receivedAt, $browser]) {
    $sample = array_replace($request, ['createdAt' => $receivedAt]);
    $identity = $trafficStore->activity->identity([
        'browserId' => sprintf('00000000-0000-4000-8000-%012d', $browser),
        'simulationId' => sprintf('00000000-0000-4000-8001-%012d', $index),
    ]);
    $key = 'traffic-fixture-request-' . $index;
    $trafficStore->create($sample, $key, $identity);
    $trafficStore->create($sample, $key, $identity);
}
$february = $trafficStore->activity->listing(1, '2024-02');
check($february['total'] === 0 && $february['summary']['browsers'] === 2, 'Envios entram no total mensal de navegadores e saem das simulações em aberto.');
$expectedDays = [];
for ($day = 1; $day <= 29; $day++) {
    $expectedDays[] = ['date' => sprintf('2024-02-%02d', $day), 'browsers' => [28 => 1, 29 => 2][$day] ?? 0];
}
check($february['traffic']['days'] === $expectedDays, 'No mês bissexto, cada navegador conta uma vez por dia mesmo com várias horas, rascunhos e reenvios.');
$expectedHours = array_replace(array_fill(0, 24, 0), [9 => 3, 10 => 1, 23 => 1]);
check($february['traffic']['hours'] === $expectedHours, 'O pico soma navegadores distintos em cada dia das 9h às 9h59, incluindo dias diferentes.');
$march = $trafficStore->activity->listing(1, '2024-03')['traffic'];
check($march['days'][0] === ['date' => '2024-03-01', 'browsers' => 1] && $march['hours'] === array_replace(array_fill(0, 24, 0), [0 => 1]), 'A virada do mês segue a meia-noite local.');
$firstFullMonth = (new DateTimeImmutable($march['trackingStartedAt']))->setTimezone(new DateTimeZone($march['timeZone']))->modify('first day of next month')->format('Y-m');
check(!$trafficStore->activity->listing(1, $firstFullMonth)['traffic']['partialHistory'], 'Meses inteiros após o início da coleta têm cobertura detalhada.');
$trafficStore = null; $legacyStore = null; $archiveStore = null; gc_collect_cycles();
foreach ([$archiveSettings['dataDirectory'], $legacySettings['dataDirectory'], $trafficConfig->get('dataDirectory')] as $directory) {
    foreach (['contacts.sqlite', 'contacts.sqlite-wal', 'contacts.sqlite-shm'] as $name) @unlink($directory . '/' . $name);
    @rmdir($directory);
}

echo "OK: {$checks} verificações; " . count($fixtures) . " cenários de preço; nenhum e-mail real enviado.\n";
// Arquivos temporários exclusivos do teste, sem remoção recursiva de caminhos externos.
$store = null; unset($mail); gc_collect_cycles();
foreach (['contacts.sqlite', 'contacts.sqlite-wal', 'contacts.sqlite-shm', 'mail-worker.lock'] as $name) @unlink($testDirectory . '/' . $name);
@rmdir($testDirectory);
