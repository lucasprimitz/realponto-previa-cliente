<?php
declare(strict_types=1);
namespace Realponto;

final class Mail {
    public function __construct(private readonly Config $config, private readonly Store $store) {}
    public static function money(?int $cents): string { return $cents === null ? 'Sob consulta' : 'R$ ' . number_format($cents / 100, 2, ',', '.'); }
    private static function escape(string $value): string { return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); }
    private static function date(string $value, bool $withTime = false): string {
        if ($value === '') return 'Não informada';
        try {
            $date = new \DateTimeImmutable($value);
            if ($withTime) $date = $date->setTimezone(new \DateTimeZone('America/Sao_Paulo'));
            return $date->format($withTime ? 'd/m/Y \à\s H:i' : 'd/m/Y');
        } catch (\Throwable) { return 'Não informada'; }
    }
    private static function telephone(string $value): string {
        $digits = preg_replace('/\D/', '', $value);
        $prefix = '';
        if (in_array(strlen($digits), [12, 13], true) && str_starts_with($digits, '55')) { $prefix = '+55 '; $digits = substr($digits, 2); }
        if (!in_array(strlen($digits), [10, 11], true)) return $value;
        return $prefix . '(' . substr($digits, 0, 2) . ') ' . substr($digits, 2, -4) . '-' . substr($digits, -4);
    }
    private static function document(?string $value): string {
        if ($value === null || trim($value) === '') return 'Não informado';
        $normalized = strtoupper(preg_replace('~[.\/\-\s]~u', '', $value));
        if (preg_match('/^\d{11}$/D', $normalized)) return substr($normalized, 0, 3) . '.' . substr($normalized, 3, 3) . '.' . substr($normalized, 6, 3) . '-' . substr($normalized, 9);
        if (preg_match('/^[A-Z0-9]{12}\d{2}$/D', $normalized)) return substr($normalized, 0, 2) . '.' . substr($normalized, 2, 3) . '.' . substr($normalized, 5, 3) . '/' . substr($normalized, 8, 4) . '-' . substr($normalized, 12);
        return $value;
    }
    private static function details(array $item): array {
        $r = $item['request']; $c = $r['configuration']; $p = $r['contact'];
        $systems = ['secullum-offline' => 'Secullum Offline', 'secullum-rh' => 'Secullum RH', 'rhid' => 'RHID', 'iponto' => 'iPonto'];
        $quantity = static fn(mixed $value, string $noun, int $limit): string => $value === 'consultar'
            ? 'Acima de ' . number_format($limit, 0, ',', '.') . ' ' . $noun . ' — sob consulta'
            : 'Até ' . number_format((int)$value, 0, ',', '.') . ' ' . $noun;
        return [
            'contact' => ['Nome' => $p['name'], 'Empresa' => $p['company'], 'E-mail' => $p['email'], 'Telefone / WhatsApp' => self::telephone($p['phone']), 'CPF / CNPJ' => self::document($p['taxId'] ?? null)],
            'configuration' => ['Sistema' => $systems[$c['system']] ?? $c['system'], 'Horários' => $quantity($c['schedules'], 'horários', 100), 'Funcionários' => $quantity($c['employees'], 'funcionários', 1000), 'Banco de horas' => $c['bankHours'] ? 'Sim' : 'Não', 'Escalas' => $c['workScale'] ? 'Sim' : 'Não', 'Inativação dos horários antigos' => $c['system'] === 'secullum-offline' ? 'Não contemplada para Secullum Offline' : 'Contemplada'],
        ];
    }
    private static function paymentOptions(array $estimate): array {
        $priced = ($estimate['totalCents'] ?? null) !== null;
        $installment = static fn(string $key, int $count): string => $priced && isset($estimate[$key]) ? $count . 'x de ' . self::money($estimate[$key]) : 'Sob consulta';
        return [
            'pix' => ['title' => 'Pix', 'amount' => $priced ? self::money($estimate['pixCents'] ?? null) : 'Sob consulta', 'condition' => 'À vista · 5% de desconto extra'],
            'boleto' => ['title' => 'Boleto', 'amount' => $installment('boletoInstallmentCents', 6), 'condition' => '6 parcelas · sob consulta e análise do cliente'],
            'credit-card' => ['title' => 'Cartão de crédito', 'amount' => $installment('cardInstallmentCents', 10), 'condition' => '10 parcelas sem juros'],
        ];
    }
    public static function body(array $item): string {
        $r = $item['request']; $e = $r['estimate']; $details = self::details($item);
        $priced = ($e['totalCents'] ?? null) !== null;
        $lines = ['REALPONTO | NOVA SOLICITAÇÃO DE PROPOSTA', 'Protocolo: ' . $item['id'], 'Recebida em: ' . self::date((string)($item['receivedAt'] ?? ''), true), '', 'INVESTIMENTO ESTIMADO', 'Estimativa da parametrização: ' . self::money($e['totalCents'] ?? null)];
        if ($priced && !empty($e['campaignDiscountApplied'])) {
            $lines[] = 'Total sem desconto da campanha: ' . self::money($e['totalBeforeDiscountCents'] ?? null);
            $lines[] = 'Economia da campanha: ' . self::money($e['discountCents'] ?? null);
            $lines[] = 'Campanha: condição para aprovação até ' . self::date((string)($e['campaignDeadline'] ?? ''));
        } elseif ($priced) $lines[] = 'Sem desconto de antecipação.';
        else $lines[] = 'As quantidades solicitadas precisam de avaliação para uma proposta personalizada.';
        foreach (['contact' => 'DADOS DO CLIENTE', 'configuration' => 'CONFIGURAÇÃO SOLICITADA'] as $key => $title) {
            $lines[] = ''; $lines[] = $title;
            foreach ($details[$key] as $label => $value) $lines[] = $label . ': ' . $value;
        }
        $lines[] = ''; $lines[] = 'PAGAMENTO'; $lines[] = 'Pagamento desejado: ' . $r['payment']['label'];
        foreach (self::paymentOptions($e) as $key => $option) {
            $selection = $r['payment']['method'] === $key ? '[ESCOLHIDO PELO CLIENTE] ' : '';
            $lines[] = $selection . $option['title'] . ': ' . $option['amount'] . ' — ' . $option['condition'];
        }
        $lines[] = 'Parcelas aproximadas por arredondamento; condições confirmadas na proposta.';
        $lines[] = ''; $lines[] = 'SOBRE A SOLICITAÇÃO';
        $lines[] = 'O preenchimento do formulário não equivale a uma proposta nem à sua aprovação.';
        $lines[] = 'Confirme os dados com o cliente, envie a proposta e solicite a aprovação antes de iniciar a configuração.';
        $lines[] = 'O cliente autorizou contato para esta solicitação.';
        return implode("\n", $lines) . "\n";
    }
    private static function rows(array $rows): string {
        $html = '';
        foreach ($rows as $label => $value) {
            $html .= '<tr><td width="39%" valign="top" style="padding:8px 12px 8px 0;border-bottom:1px solid #e7e7f1;color:#63637a;font-size:14px;line-height:21px;">' . self::escape((string)$label) . '</td><td valign="top" style="padding:8px 0;border-bottom:1px solid #e7e7f1;color:#25253f;font-size:15px;line-height:22px;font-weight:600;word-break:break-word;overflow-wrap:anywhere;">' . self::escape((string)$value) . '</td></tr>';
        }
        return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;table-layout:fixed;">' . $html . '</table>';
    }
    private static function section(string $title, string $content): string {
        return '<tr><td style="padding:0 24px 18px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:100%;background-color:#ffffff;border:1px solid #dedfee;border-radius:12px;"><tr><td style="padding:22px 22px 10px;color:#292578;font-size:18px;line-height:25px;font-weight:700;">' . self::escape($title) . '</td></tr><tr><td style="padding:0 22px 20px;">' . $content . '</td></tr></table></td></tr>';
    }
    public static function html(array $item): string {
        $r = $item['request']; $e = $r['estimate']; $details = self::details($item);
        $priced = ($e['totalCents'] ?? null) !== null;
        $campaign = $priced && !empty($e['campaignDiscountApplied']);
        $protocol = self::escape((string)$item['id']);
        $received = self::escape(self::date((string)($item['receivedAt'] ?? ''), true));
        $company = self::escape($r['contact']['company']);
        $total = self::escape(self::money($e['totalCents'] ?? null));
        $priceLabel = $campaign ? 'Total com desconto da campanha' : 'Total da parametrização';
        if (!$priced) $priceLabel = 'Proposta personalizada';
        $priceNote = $campaign ? 'Aprovação até ' . self::date((string)($e['campaignDeadline'] ?? '')) : ($priced ? 'Sem desconto de antecipação' : 'As quantidades solicitadas precisam de avaliação da equipe.');
        $priceNote = self::escape($priceNote);
        $campaignRow = '';
        if ($campaign) {
            $before = self::escape(self::money($e['totalBeforeDiscountCents'] ?? null));
            $saving = self::escape(self::money($e['discountCents'] ?? null));
            $campaignRow = '<tr><td style="padding:16px 22px;background-color:#faf5f8;border-top:1px solid #e4deee;color:#59596f;font-size:14px;line-height:22px;">Total sem desconto: <span style="text-decoration:line-through;">' . $before . '</span><br><strong style="color:#c9003d;font-size:16px;">Economia da campanha: ' . $saving . '</strong></td></tr>';
        }
        $summary = '<tr><td style="padding:0 24px 18px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#292578" style="width:100%;background-color:#292578;border-radius:12px;"><tr><td style="padding:23px 22px 21px;color:#ffffff;"><p style="margin:0 0 7px;font-size:13px;line-height:19px;font-weight:700;letter-spacing:.7px;color:#e2dff7;">INVESTIMENTO ESTIMADO</p><p style="margin:0 0 8px;font-size:15px;line-height:22px;color:#ffffff;">' . $priceLabel . '</p><p style="margin:0 0 10px;font-size:34px;line-height:42px;font-weight:700;color:#ffffff;">' . $total . '</p><p style="margin:0;font-size:14px;line-height:21px;color:#eceafa;">' . $priceNote . '</p></td></tr>' . $campaignRow . '</table></td></tr>';
        $contact = self::section('Dados do cliente', self::rows($details['contact']));
        $configuration = self::section('Configuração solicitada', self::rows($details['configuration']));
        $payment = '<p style="margin:3px 0 16px;font-size:15px;line-height:23px;color:#55556e;">Preferência informada pelo cliente: <strong style="color:#292578;">' . self::escape($r['payment']['label']) . '</strong></p>';
        $payment .= '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;table-layout:fixed;"><tr>';
        foreach (self::paymentOptions($e) as $key => $option) {
            $selected = $r['payment']['method'] === $key;
            $background = $selected ? '#fff1f5' : '#f3f4f8';
            $border = $selected ? '#c9003d' : '#dfe1eb';
            $borderWidth = $selected ? '2px' : '1px';
            $accent = $selected ? '#c9003d' : '#292578';
            $badge = $selected ? '<span style="display:inline-block;padding:4px 7px;border-radius:4px;background-color:#c9003d;font-size:10px;line-height:14px;font-weight:700;color:#ffffff;">ESCOLHIDO PELO CLIENTE</span>' : '<span style="font-size:10px;line-height:17px;color:#6c6c82;">OUTRA OPÇÃO</span>';
            $payment .= '<td class="payment-column" width="33.33%" valign="top" style="width:33.33%;padding:0 4px 10px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="' . $background . '" style="width:100%;background-color:' . $background . ';border:' . $borderWidth . ' solid ' . $border . ';border-radius:9px;"><tr><td height="152" valign="top" style="padding:14px 11px;"><p style="margin:0 0 4px;font-size:14px;line-height:20px;font-weight:700;color:#292578;">' . self::escape($option['title']) . '</p><p style="margin:0 0 10px;line-height:17px;">' . $badge . '</p><p style="margin:0 0 8px;font-size:18px;line-height:24px;font-weight:700;color:' . $accent . ';">' . self::escape($option['amount']) . '</p><p style="margin:0;font-size:12px;line-height:18px;color:#626279;">' . self::escape($option['condition']) . '</p></td></tr></table></td>';
        }
        $payment .= '</tr></table><p style="margin:4px 0 0;font-size:12px;line-height:19px;color:#6c6c82;">Parcelas aproximadas por arredondamento. As condições serão confirmadas na proposta.</p>';
        $payment = self::section('Forma de pagamento', $payment);
        $next = self::section('Sobre a solicitação', '<p style="margin:3px 0 12px;font-size:15px;line-height:23px;color:#292578;font-weight:700;">O preenchimento do formulário não equivale a uma proposta nem à sua aprovação.</p><p style="margin:0 0 12px;font-size:15px;line-height:23px;color:#41415b;">Confirme os dados com o cliente, envie a proposta e solicite a aprovação antes de iniciar a configuração.</p><p style="margin:0;font-size:12px;line-height:19px;color:#6c6c82;">O cliente autorizou contato para esta solicitação.</p>');
        return <<<HTML
<!doctype html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>Nova solicitação de proposta — Realponto</title><style>@media only screen and (max-width:480px){.payment-column{display:block!important;width:100%!important;padding:0 0 10px!important;}.payment-column td{height:auto!important;}}</style></head>
<body style="margin:0;padding:0;background-color:#f2f3f9;color:#25253f;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;">
<div style="display:none;font-size:1px;line-height:1px;color:#f2f3f9;max-height:0;max-width:0;overflow:hidden;mso-hide:all;">Nova solicitação de {$company}. Confira a configuração e a preferência de pagamento.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f2f3f9" style="width:100%;background-color:#f2f3f9;"><tr><td align="center" style="padding:24px 10px;">
<!--[if mso]><table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:640px;">
<tr><td style="padding:0 24px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-left:4px solid #c9003d;padding-left:13px;font-size:22px;line-height:29px;font-weight:700;letter-spacing:.5px;color:#292578;">REALPONTO<br><span style="font-size:11px;line-height:18px;letter-spacing:1px;color:#73738c;">REDUÇÃO DE JORNADA</span></td></tr></table></td></tr>
<tr><td style="padding:0 24px 22px;"><h1 style="margin:0 0 10px;font-size:25px;line-height:32px;font-weight:700;color:#25253f;">Nova solicitação de proposta</h1><p style="margin:0 0 14px;font-size:16px;line-height:24px;color:#55556e;">{$company}</p><p style="margin:0;font-size:12px;line-height:20px;color:#74748b;word-break:break-word;overflow-wrap:anywhere;">Protocolo: <strong style="color:#50506b;">{$protocol}</strong><br>Recebida em {$received}</p></td></tr>
{$summary}
{$contact}
{$configuration}
{$payment}
{$next}
<tr><td align="center" style="padding:4px 24px 12px;font-size:12px;line-height:19px;color:#77778c;">Realponto · Solicitação recebida para análise<br>Informações destinadas à equipe de atendimento.</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
</body>
</html>
HTML;
    }
    private function send(array $item): void {
        $autoload = dirname(__DIR__) . '/vendor/autoload.php';
        if (!is_file($autoload)) throw new \RuntimeException('SMTP dependency unavailable');
        require_once $autoload;
        $settings = $this->config->get('mail', []);
        $encryption = $settings['encryption'] ?? 'tls';
        if (!in_array($encryption, ['tls', 'ssl'], true)) throw new \RuntimeException('SMTP encryption required');
        $mailer = new \PHPMailer\PHPMailer\PHPMailer(true);
        $mailer->isSMTP(); $mailer->Host = (string)$settings['host']; $mailer->Port = (int)($settings['port'] ?? 587);
        if ($mailer->Port < 1 || $mailer->Port > 65535) throw new \RuntimeException('Invalid SMTP port');
        $mailer->SMTPAuth = (bool)($settings['authentication'] ?? true);
        $mailer->Username = (string)($settings['username'] ?? ''); $mailer->Password = (string)($settings['password'] ?? '');
        $mailer->SMTPSecure = $encryption; $mailer->SMTPAutoTLS = true;
        $mailer->Timeout = 20; $mailer->Timelimit = 30; $mailer->SMTPDebug = 0; $mailer->CharSet = 'UTF-8';
        $mailer->setFrom((string)$settings['from'], 'Realponto'); $mailer->addAddress((string)$settings['recipient']);
        $mailer->addReplyTo($item['request']['contact']['email'], $item['request']['contact']['name']);
        $mailer->Subject = 'Solicitação de proposta — ' . $item['id'];
        $mailer->isHTML(true); $mailer->Body = self::html($item); $mailer->AltBody = self::body($item); $mailer->send();
    }
    /** Callable exists only for local tests; production CLI never accepts a transport argument. */
    public function drain(int $limit = 20, ?callable $transport = null, ?int $now = null): array {
        $now ??= time(); $limit = max(1, min(100, $limit));
        if (!$this->config->mailConfigured()) return ['sent' => 0, 'failed' => 0, 'skipped' => 'not-configured'];
        $lock = fopen(rtrim($this->config->get('dataDirectory'), '/\\') . '/mail-worker.lock', 'c');
        if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) return ['sent' => 0, 'failed' => 0, 'skipped' => 'busy'];
        try {
            $query = $this->store->db->prepare("SELECT * FROM requests WHERE mail_status IN ('pending','disabled') AND mail_attempts<5 AND next_attempt<=? ORDER BY received_at LIMIT ?");
            $query->bindValue(1, $now, \PDO::PARAM_INT); $query->bindValue(2, $limit, \PDO::PARAM_INT); $query->execute(); $rows = $query->fetchAll();
            $result = ['sent' => 0, 'failed' => 0];
            foreach ($rows as $row) {
                $attempt = (int)$row['mail_attempts'] + 1;
                // Um processo interrompido não dispara novamente de imediato; a próxima execução retoma a fila.
                $this->store->db->prepare("UPDATE requests SET mail_status='pending',mail_attempts=?,next_attempt=? WHERE id=?")->execute([$attempt, $now + 300, $row['id']]);
                try {
                    $item = $this->store->item($row);
                    if ($transport) $transport($item); else $this->send($item);
                    $this->store->db->prepare("UPDATE requests SET mail_status='sent',mail_error=NULL,mailed_at=? WHERE id=?")->execute([gmdate('Y-m-d\TH:i:s\Z', $now), $row['id']]); $result['sent']++;
                } catch (\Throwable) {
                    $this->store->db->prepare('UPDATE requests SET mail_status=?,mail_error=?,next_attempt=? WHERE id=?')->execute([$attempt >= 5 ? 'failed' : 'pending', 'delivery-failed', $now + min(86400, 60 * (2 ** $attempt)), $row['id']]); $result['failed']++;
                }
            }
            // Uma queda após a quinta tentativa fica visível como falha para revisão manual.
            $this->store->db->prepare("UPDATE requests SET mail_status='failed',mail_error='delivery-unconfirmed' WHERE mail_status='pending' AND mail_attempts>=5 AND next_attempt<=?")->execute([$now]);
            return $result;
        } finally { flock($lock, LOCK_UN); fclose($lock); }
    }
    public function retryFailed(): int {
        return $this->store->db->exec("UPDATE requests SET mail_status='pending',mail_attempts=0,next_attempt=0,mail_error=NULL WHERE mail_status='failed'");
    }
}
