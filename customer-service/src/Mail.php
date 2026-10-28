<?php
declare(strict_types=1);
namespace Realponto;

final class Mail {
    public function __construct(private readonly Config $config, private readonly Store $store) {}
    public static function money(?int $cents): string { return $cents === null ? 'Sob consulta' : 'R$ ' . number_format($cents / 100, 2, ',', '.'); }
    public static function body(array $item): string {
        $r = $item['request']; $c = $r['configuration']; $p = $r['contact']; $e = $r['estimate'];
        $systems = ['secullum-offline' => 'Secullum Offline', 'secullum-rh' => 'Secullum RH', 'rhid' => 'RHID', 'iponto' => 'iPonto'];
        $quantity = static fn(mixed $value, string $noun) => $value === 'consultar' ? 'Acima do pacote padrão — sob consulta' : 'Até ' . $value . ' ' . $noun;
        return implode("\n", [
            'Nova solicitação de proposta — Realponto', 'Protocolo: ' . $item['id'], 'Recebida em: ' . $item['receivedAt'] . ' (UTC)', '',
            'Nome: ' . $p['name'], 'Empresa: ' . $p['company'], 'E-mail: ' . $p['email'], 'Telefone / WhatsApp: ' . $p['phone'], 'CPF / CNPJ: ' . ($p['taxId'] ?? 'Não informado'), '',
            'Sistema: ' . ($systems[$c['system']] ?? $c['system']), 'Horários: ' . $quantity($c['schedules'], 'horários'), 'Funcionários: ' . $quantity($c['employees'], 'funcionários'),
            'Banco de horas: ' . ($c['bankHours'] ? 'Sim' : 'Não'), 'Escalas: ' . ($c['workScale'] ? 'Sim' : 'Não'),
            'Inativação dos horários antigos: ' . ($c['system'] === 'secullum-offline' ? 'Não contemplada para Secullum Offline' : 'Contemplada'), '',
            'Pagamento desejado: ' . $r['payment']['label'], 'Estimativa da parametrização: ' . self::money($e['totalCents']),
            'Total sem desconto da campanha: ' . self::money($e['totalBeforeDiscountCents'] ?? null),
            'Economia da campanha: ' . self::money($e['discountCents'] ?? null),
            'Estimativa no Pix: ' . self::money($e['pixCents'] ?? null),
            'Boleto: 6x de ' . self::money($e['boletoInstallmentCents'] ?? null) . ' — sob consulta',
            'Cartão de crédito: 10x de ' . self::money($e['cardInstallmentCents'] ?? null) . ' — sem juros',
            'Parcelas aproximadas por arredondamento; condições confirmadas na proposta.',
            'Campanha: ' . ($e['campaignDiscountApplied'] ? 'Condição para aprovação até ' . (new \DateTimeImmutable($e['campaignDeadline']))->format('d/m/Y') : 'Sem desconto de antecipação'),
            '', 'Solicitação recebida para análise. O preenchimento não equivale à aprovação da proposta.',
            'O cliente autorizou contato para esta solicitação. Confira e acompanhe o registro no painel protegido.',
        ]) . "\n";
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
        $mailer->Body = self::body($item); $mailer->isHTML(false); $mailer->send();
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
