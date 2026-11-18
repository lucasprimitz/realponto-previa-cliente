<?php
declare(strict_types=1);
namespace Realponto;

final class Store {
    private const ASSIGNEES = ['JANAINA', 'HENRIQUE', 'L. FERREIRA', 'NATHAN', 'DANILO', 'V. NEVES', 'MARIA EDUARDA'];
    private const REQUESTS_WITH_ASSIGNMENT = 'SELECT r.*, a.assignee, a.handled_at FROM requests r LEFT JOIN request_assignments a ON a.request_id=r.id';
    public readonly \PDO $db;
    public readonly Activity $activity;
    public function __construct(private readonly Config $config) {
        $this->db = new \PDO('sqlite:' . rtrim($config->get('dataDirectory'), '/\\') . '/contacts.sqlite', null, null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION, \PDO::ATTR_DEFAULT_FETCH_MODE => \PDO::FETCH_ASSOC]);
        $this->db->exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
        $this->db->exec('CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, key_hash TEXT NOT NULL UNIQUE, input_hash TEXT NOT NULL, payload TEXT NOT NULL, note TEXT NOT NULL, received_at TEXT NOT NULL, handled INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1, mail_status TEXT NOT NULL, mail_attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0, mail_error TEXT, mailed_at TEXT, archived INTEGER NOT NULL DEFAULT 0, archived_at TEXT); CREATE TABLE IF NOT EXISTS rate_limits (bucket TEXT PRIMARY KEY, counter INTEGER NOT NULL, expires INTEGER NOT NULL);');
        // Legacy databases are upgraded once; recheck under a write lock for concurrent requests.
        $columns = array_column($this->db->query('PRAGMA table_info(requests)')->fetchAll(), 'name');
        if (!in_array('archived', $columns, true) || !in_array('archived_at', $columns, true)) {
            $this->db->exec('BEGIN IMMEDIATE');
            try {
                $columns = array_column($this->db->query('PRAGMA table_info(requests)')->fetchAll(), 'name');
                if (!in_array('archived', $columns, true)) $this->db->exec('ALTER TABLE requests ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
                if (!in_array('archived_at', $columns, true)) $this->db->exec('ALTER TABLE requests ADD COLUMN archived_at TEXT');
                $this->db->exec('COMMIT');
            } catch (\Throwable $error) { $this->db->exec('ROLLBACK'); throw $error; }
        }
        $this->initializeAssignments();
        $this->activity = new Activity($this->db, $config->key);
        @chmod(rtrim($config->get('dataDirectory'), '/\\') . '/contacts.sqlite', 0600);
    }
    private function initializeAssignments(): void {
        $exists = "SELECT 1 FROM sqlite_master WHERE type='table' AND name='assignment_rotation'";
        if ($this->db->query($exists)->fetchColumn()) return;
        $this->db->exec('BEGIN IMMEDIATE');
        try {
            if (!$this->db->query($exists)->fetchColumn()) {
                $this->db->exec('CREATE TABLE request_assignments (request_id TEXT PRIMARY KEY REFERENCES requests(id) ON DELETE CASCADE, assignee TEXT, handled_at TEXT);
                    CREATE TABLE assignment_rotation (id INTEGER PRIMARY KEY CHECK(id=1), last_assignee TEXT, revision INTEGER NOT NULL DEFAULT 0)');
                $insert = $this->db->prepare('INSERT INTO request_assignments(request_id,assignee) VALUES (?,?)');
                $historicalOwners = [];
                $rows = $this->db->query('SELECT id,note,handled FROM requests');
                foreach ($rows as $row) {
                    // Only an exact name in the former combined field identifies an owner.
                    $name = strtoupper(strtr(trim($this->decrypt($row['note'])), ['í' => 'I', 'Í' => 'I']));
                    if ($name === 'VINICIUS NEVES') $name = 'V. NEVES';
                    $known = in_array($name, self::ASSIGNEES, true);
                    if ($known) $insert->execute([$row['id'], $this->encrypt($name)]);
                    if ($row['handled']) $historicalOwners[$known ? $name : ''] = true;
                }
                $rows->closeCursor();
                // With no historical timestamps the last owner is known only if every transfer agrees.
                $last = count($historicalOwners) === 1 ? array_key_first($historicalOwners) : null;
                $this->db->prepare('INSERT INTO assignment_rotation(id,last_assignee) VALUES (1,?)')
                    ->execute([$last ? $this->encrypt($last) : null]);
            }
            $this->db->exec('COMMIT');
        } catch (\Throwable $error) { $this->db->exec('ROLLBACK'); throw $error; }
    }
    private function assignment(): array {
        $rotation = $this->db->query('SELECT last_assignee,revision FROM assignment_rotation WHERE id=1')->fetch();
        $index = $rotation['last_assignee'] === null ? -1 : array_search($this->decrypt($rotation['last_assignee']), self::ASSIGNEES, true);
        if ($index === false) throw new \RuntimeException('Responsável do rodízio desconhecido.');
        return ['names' => self::ASSIGNEES, 'next' => self::ASSIGNEES[($index + 1) % count(self::ASSIGNEES)], 'revision' => (int)$rotation['revision']];
    }
    public function encrypt(string $plain): string {
        $nonce = random_bytes(SODIUM_CRYPTO_SECRETBOX_NONCEBYTES);
        return base64_encode($nonce . sodium_crypto_secretbox($plain, $nonce, $this->config->key));
    }
    public function decrypt(string $value): string {
        $raw = base64_decode($value, true);
        if ($raw === false || strlen($raw) < SODIUM_CRYPTO_SECRETBOX_NONCEBYTES + SODIUM_CRYPTO_SECRETBOX_MACBYTES) throw new \RuntimeException('Registro criptografado inválido.');
        $plain = sodium_crypto_secretbox_open(substr($raw, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES), substr($raw, 0, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES), $this->config->key);
        if ($plain === false) throw new \RuntimeException('Não foi possível abrir o registro.');
        return $plain;
    }
    public function rate(string $category, string $identity, int $maximum, int $window, ?int $now = null): void {
        $now ??= time();
        $bucket = hash_hmac('sha256', $category . ':' . $identity, $this->config->key);
        $this->db->exec('BEGIN IMMEDIATE');
        try {
            $this->db->prepare('DELETE FROM rate_limits WHERE expires <= ?')->execute([$now]);
            // SQLite 3.34.1 não possui RETURNING. O BEGIN IMMEDIATE acima
            // mantém o incremento e a leitura dentro da mesma transação exclusiva.
            $statement = $this->db->prepare('INSERT INTO rate_limits(bucket,counter,expires) VALUES (?,1,?) ON CONFLICT(bucket) DO UPDATE SET counter=counter+1');
            $statement->execute([$bucket, $now + $window]);
            $statement->closeCursor();
            $statement = $this->db->prepare('SELECT counter FROM rate_limits WHERE bucket=?');
            $statement->execute([$bucket]);
            $count = (int)$statement->fetchColumn();
            $statement->closeCursor();
            $this->db->exec('COMMIT');
        } catch (\Throwable $error) { $this->db->exec('ROLLBACK'); throw $error; }
        if ($count > $maximum) throw new Problem(429, 'Muitas tentativas. Aguarde alguns minutos e tente novamente.');
    }
    public function create(array $request, string $idempotencyKey, ?array $activityIdentity = null, array $access = []): array {
        if (!preg_match('/^[a-zA-Z0-9_-]{20,80}$/D', $idempotencyKey)) throw new Problem(422, 'Identificador de envio inválido.');
        $keyHash = hash_hmac('sha256', $idempotencyKey, $this->config->key);
        $inputHash = hash_hmac('sha256', json_encode([$request['contact'], $request['configuration'], $request['payment']['method'], $request['consent']], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE), $this->config->key);
        $this->db->exec('BEGIN IMMEDIATE');
        try {
            $find = $this->db->prepare('SELECT id,received_at,mail_status,input_hash FROM requests WHERE key_hash=?');
            $find->execute([$keyHash]);
            $row = $find->fetch();
            $find->closeCursor();
            if (!$row && $activityIdentity !== null) $row = $this->activity->linkedRequest($activityIdentity);
            $created = !$row;
            if ($created) {
                $row = [
                    'id' => 'RP-' . strtoupper(bin2hex(random_bytes(12))), 'received_at' => $request['createdAt'],
                    'mail_status' => $this->config->mailConfigured() ? 'pending' : 'disabled',
                ];
                $insert = $this->db->prepare('INSERT INTO requests(id,key_hash,input_hash,payload,note,received_at,mail_status) VALUES (?,?,?,?,?,?,?)');
                $insert->execute([$row['id'], $keyHash, $inputHash, $this->encrypt(json_encode($request, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE)),
                    $this->encrypt(''), $row['received_at'], $row['mail_status']]);
                if ($activityIdentity !== null) $this->activity->link($activityIdentity, $row['id'], $request, $access);
            } elseif (!hash_equals($row['input_hash'], $inputHash)) {
                throw new Problem(409, 'Esse envio já foi utilizado com outros dados. Inicie uma nova simulação.');
            }
            $this->db->exec('COMMIT');
        } catch (\Throwable $error) {
            $this->db->exec('ROLLBACK');
            throw $error;
        }
        return ['ok' => true, 'id' => $row['id'], 'receivedAt' => $row['received_at'], 'mailStatus' => $row['mail_status'], 'created' => $created];
    }
    public function item(array $row): array {
        return ['id' => $row['id'], 'receivedAt' => $row['received_at'], 'handled' => (bool)$row['handled'],
            'assignee' => isset($row['assignee']) ? $this->decrypt($row['assignee']) : null, 'handledAt' => $row['handled_at'] ?? null,
            'archived' => (bool)$row['archived'], 'archivedAt' => $row['archived_at'], 'note' => $this->decrypt($row['note']), 'version' => (int)$row['version'], 'mailStatus' => $row['mail_status'], 'mailAttempts' => (int)$row['mail_attempts'], 'request' => json_decode($this->decrypt($row['payload']), true, 32, JSON_THROW_ON_ERROR)];
    }
    public function listing(int $page, string $status): array {
        if ($page < 1 || $page > 100000 || !in_array($status, ['all', 'pending', 'handled', 'archived'], true)) throw new Problem(422, 'Filtro inválido.');
        $where = $status === 'archived' ? ' WHERE archived=1' : ' WHERE archived=0';
        if (in_array($status, ['pending', 'handled'], true)) $where .= ' AND handled=' . ($status === 'handled' ? '1' : '0');
        $total = (int)$this->db->query('SELECT COUNT(*) FROM requests' . $where)->fetchColumn();
        $statement = $this->db->prepare(self::REQUESTS_WITH_ASSIGNMENT . $where . ' ORDER BY received_at DESC,id DESC LIMIT 25 OFFSET ?');
        $statement->bindValue(1, ($page - 1) * 25, \PDO::PARAM_INT); $statement->execute();
        return ['ok' => true, 'items' => array_map(fn(array $row) => $this->item($row), $statement->fetchAll()), 'page' => $page, 'total' => $total, 'totalPages' => max(1, (int)ceil($total / 25)), 'assignment' => $this->assignment()];
    }
    /** Aggregate the stored estimates, without exposing contacts or recalculating prices. */
    public function reports(int $year): array {
        if ($year < 2000 || $year > 2100) throw new Problem(422, 'Selecione um ano entre 2000 e 2100.');
        $zone = new \DateTimeZone('America/Sao_Paulo');
        $utc = new \DateTimeZone('UTC');
        $start = new \DateTimeImmutable(sprintf('%04d-01-01 00:00:00', $year), $zone);
        $end = $start->modify('+1 year');
        $empty = ['count' => 0, 'pricedCount' => 0, 'consultationCount' => 0, 'totalCents' => 0, 'handledCount' => 0];
        $months = [];
        for ($month = 1; $month <= 12; $month++) $months[] = ['month' => sprintf('%04d-%02d', $year, $month)] + $empty;
        $total = $empty;
        $portfolio = [];
        foreach (self::ASSIGNEES as $name) {
            $portfolio[$name] = ['assignee' => $name, 'count' => 0, 'estimatedCents' => 0, 'consultCount' => 0];
        }
        // A single snapshot covers the selected year and all currently assigned requests.
        $statement = $this->db->prepare('SELECT r.received_at,r.handled,r.payload,a.assignee,
                (r.received_at >= :start AND r.received_at < :end) AS in_year
            FROM requests r LEFT JOIN request_assignments a ON r.id=a.request_id
            WHERE r.archived=0 AND (r.handled=1 OR (r.received_at >= :start AND r.received_at < :end))');
        $statement->execute(['start' => $start->setTimezone($utc)->format('Y-m-d\TH:i:s\Z'), 'end' => $end->setTimezone($utc)->format('Y-m-d\TH:i:s\Z')]);
        while ($row = $statement->fetch()) {
            $request = json_decode($this->decrypt($row['payload']), true, 32, JSON_THROW_ON_ERROR);
            $estimate = $request['estimate'] ?? [];
            $method = $request['payment']['method'] ?? null;
            $cents = $method === 'pix' ? ($estimate['pixCents'] ?? null) : ($estimate['totalCents'] ?? null);
            $priced = ($estimate['status'] ?? '') === 'priced' && in_array($method, ['pix', 'boleto', 'credit-card'], true) && is_int($cents) && $cents >= 0;
            if ($row['handled']) {
                $name = $row['assignee'] === null ? '' : $this->decrypt($row['assignee']);
                $portfolio[$name] ??= ['assignee' => null, 'count' => 0, 'estimatedCents' => 0, 'consultCount' => 0];
                $portfolio[$name]['count']++;
                if ($priced) $portfolio[$name]['estimatedCents'] = self::sumCents($portfolio[$name]['estimatedCents'], $cents);
                else $portfolio[$name]['consultCount']++;
            }
            if (!$row['in_year']) continue;
            $monthIndex = (int)(new \DateTimeImmutable($row['received_at']))->setTimezone($zone)->format('n') - 1;
            foreach ([&$months[$monthIndex], &$total] as &$bucket) {
                $bucket['count']++;
                if ((bool)$row['handled']) $bucket['handledCount']++;
                if ($priced) {
                    $bucket['pricedCount']++;
                    $bucket['totalCents'] = self::sumCents($bucket['totalCents'], $cents);
                } else $bucket['consultationCount']++;
            }
            unset($bucket);
        }
        $statement->closeCursor();
        return ['ok' => true, 'year' => $year, 'timeZone' => 'America/Sao_Paulo', 'months' => $months, 'total' => $total,
            'assignmentTotals' => array_values($portfolio)];
    }
    private static function sumCents(int $total, int $cents): int {
        // Browser totals must remain exact even for large historical portfolios.
        if ($cents > 9007199254740991 - $total) throw new Problem(500, 'Não foi possível calcular o relatório com segurança.');
        return $total + $cents;
    }
    public function archive(array $input): array {
        if (!is_string($input['id'] ?? null) || !preg_match('/^RP-[A-F0-9]{24}$/D', $input['id']) || !is_bool($input['archived'] ?? null) || !is_int($input['version'] ?? null) || $input['version'] < 1) throw new Problem(422, 'Atualização inválida.');
        $statement = $this->db->prepare('UPDATE requests SET archived=?,archived_at=?,version=version+1 WHERE id=? AND version=? AND archived<>?');
        $statement->execute([(int)$input['archived'], $input['archived'] ? gmdate('Y-m-d\TH:i:s\Z') : null, $input['id'], $input['version'], (int)$input['archived']]);
        if ($statement->rowCount() !== 1) throw new Problem(409, 'Essa solicitação foi alterada. Atualize a lista antes de tentar novamente.');
        $find = $this->db->prepare(self::REQUESTS_WITH_ASSIGNMENT . ' WHERE r.id=?'); $find->execute([$input['id']]);
        return ['ok' => true, 'item' => $this->item($find->fetch())];
    }
    public function update(array $input): array {
        if (!is_string($input['id'] ?? null) || !preg_match('/^RP-[A-F0-9]{24}$/D', $input['id']) || !is_bool($input['handled'] ?? null) || !is_int($input['version'] ?? null) || $input['version'] < 1) throw new Problem(422, 'Atualização inválida.');
        $note = Domain::note($input['note'] ?? null);
        $hasSelection = array_key_exists('assignee', $input);
        if (isset($input['assignee']) && !in_array($input['assignee'], self::ASSIGNEES, true)) throw new Problem(422, 'Selecione um responsável da lista.');
        $this->db->exec('BEGIN IMMEDIATE');
        try {
            $find = $this->db->prepare(self::REQUESTS_WITH_ASSIGNMENT . ' WHERE r.id=?');
            $find->execute([$input['id']]); $current = $find->fetch(); $find->closeCursor();
            if (!$current || $current['archived'] || (int)$current['version'] !== $input['version']) throw new Problem(409, 'Essa solicitação foi alterada. Atualize a lista antes de salvar.');
            $previous = $current['assignee'] === null ? null : $this->decrypt($current['assignee']);
            $name = $hasSelection ? $input['assignee'] : $previous;
            $forwarded = $input['handled'] && (!$current['handled'] || $name !== $previous);
            if ($forwarded && $hasSelection && $name === null) throw new Problem(422, 'Escolha o responsável para confirmar o encaminhamento.');
            $handledAt = $input['handled'] ? $current['handled_at'] : null;
            if ($forwarded) $handledAt = gmdate('Y-m-d\TH:i:s\Z');
            $owner = $name !== null ? $this->encrypt($name) : null;
            $this->db->prepare('UPDATE requests SET handled=?,note=?,version=version+1 WHERE id=?')
                ->execute([(int)$input['handled'], $this->encrypt($note), $input['id']]);
            $this->db->prepare('INSERT INTO request_assignments(request_id,assignee,handled_at) VALUES (?,?,?)
                ON CONFLICT(request_id) DO UPDATE SET assignee=excluded.assignee,handled_at=excluded.handled_at')
                ->execute([$input['id'], $owner, $handledAt]);
            if ($forwarded && $name !== null) {
                $this->db->prepare('UPDATE assignment_rotation SET last_assignee=?,revision=revision+1 WHERE id=1')
                    ->execute([$this->encrypt($name)]);
            }
            $find->execute([$input['id']]); $item = $this->item($find->fetch()); $find->closeCursor();
            $assignment = $this->assignment();
            $this->db->exec('COMMIT');
        } catch (\Throwable $error) { $this->db->exec('ROLLBACK'); throw $error; }
        return ['ok' => true, 'item' => $item, 'assignment' => $assignment];
    }
}
