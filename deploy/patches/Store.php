<?php
declare(strict_types=1);
namespace Realponto;

final class Store {
    public readonly \PDO $db;
    public function __construct(private readonly Config $config) {
        $this->db = new \PDO('sqlite:' . rtrim($config->get('dataDirectory'), '/\\') . '/contacts.sqlite', null, null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION, \PDO::ATTR_DEFAULT_FETCH_MODE => \PDO::FETCH_ASSOC]);
        $this->db->exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
        $this->db->exec('CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, key_hash TEXT NOT NULL UNIQUE, input_hash TEXT NOT NULL, payload TEXT NOT NULL, note TEXT NOT NULL, received_at TEXT NOT NULL, handled INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1, mail_status TEXT NOT NULL, mail_attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0, mail_error TEXT, mailed_at TEXT); CREATE TABLE IF NOT EXISTS rate_limits (bucket TEXT PRIMARY KEY, counter INTEGER NOT NULL, expires INTEGER NOT NULL);');
        @chmod(rtrim($config->get('dataDirectory'), '/\\') . '/contacts.sqlite', 0600);
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
    public function create(array $request, string $idempotencyKey): array {
        if (!preg_match('/^[a-zA-Z0-9_-]{20,80}$/D', str_replace('-', '_', $idempotencyKey))) throw new Problem(422, 'Identificador de envio inválido.');
        $keyHash = hash_hmac('sha256', $idempotencyKey, $this->config->key);
        // Sem timestamp, estimativa ou rótulos: uma repetição mantém o primeiro registro.
        $inputHash = hash_hmac('sha256', json_encode([$request['contact'], $request['configuration'], $request['payment']['method'], $request['consent']], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE), $this->config->key);
        $id = 'RP-' . strtoupper(bin2hex(random_bytes(12)));
        $status = $this->config->mailConfigured() ? 'pending' : 'disabled';
        $statement = $this->db->prepare('INSERT INTO requests(id,key_hash,input_hash,payload,note,received_at,mail_status) VALUES (?,?,?,?,?,?,?) ON CONFLICT(key_hash) DO NOTHING');
        $statement->execute([$id, $keyHash, $inputHash, $this->encrypt(json_encode($request, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE)), $this->encrypt(''), $request['createdAt'], $status]);
        $created = $statement->rowCount() > 0;
        $find = $this->db->prepare('SELECT id,received_at,mail_status,input_hash FROM requests WHERE key_hash=?'); $find->execute([$keyHash]); $row = $find->fetch();
        if (!$row || !hash_equals($row['input_hash'], $inputHash)) throw new Problem(409, 'Esse envio já foi utilizado com outros dados. Atualize a página para uma nova solicitação.');
        return ['ok' => true, 'id' => $row['id'], 'receivedAt' => $row['received_at'], 'mailStatus' => $row['mail_status'], 'created' => $created];
    }
    public function item(array $row): array {
        return ['id' => $row['id'], 'receivedAt' => $row['received_at'], 'handled' => (bool)$row['handled'], 'note' => $this->decrypt($row['note']), 'version' => (int)$row['version'], 'mailStatus' => $row['mail_status'], 'mailAttempts' => (int)$row['mail_attempts'], 'request' => json_decode($this->decrypt($row['payload']), true, 32, JSON_THROW_ON_ERROR)];
    }
    public function listing(int $page, string $status): array {
        if ($page < 1 || $page > 100000 || !in_array($status, ['all', 'pending', 'handled'], true)) throw new Problem(422, 'Filtro inválido.');
        $where = $status === 'all' ? '' : (' WHERE handled=' . ($status === 'handled' ? '1' : '0'));
        $total = (int)$this->db->query('SELECT COUNT(*) FROM requests' . $where)->fetchColumn();
        $statement = $this->db->prepare('SELECT * FROM requests' . $where . ' ORDER BY received_at DESC,id DESC LIMIT 25 OFFSET ?');
        $statement->bindValue(1, ($page - 1) * 25, \PDO::PARAM_INT); $statement->execute();
        return ['ok' => true, 'items' => array_map(fn(array $row) => $this->item($row), $statement->fetchAll()), 'page' => $page, 'total' => $total, 'totalPages' => max(1, (int)ceil($total / 25))];
    }
    public function update(array $input): array {
        if (!is_string($input['id'] ?? null) || !preg_match('/^RP-[A-F0-9]{24}$/D', $input['id']) || !is_bool($input['handled'] ?? null) || !is_int($input['version'] ?? null) || $input['version'] < 1) throw new Problem(422, 'Atualização inválida.');
        $note = Domain::note($input['note'] ?? null);
        $statement = $this->db->prepare('UPDATE requests SET handled=?,note=?,version=version+1 WHERE id=? AND version=?');
        $statement->execute([(int)$input['handled'], $this->encrypt($note), $input['id'], $input['version']]);
        if ($statement->rowCount() !== 1) throw new Problem(409, 'Essa solicitação foi alterada. Atualize a lista antes de salvar.');
        $find = $this->db->prepare('SELECT * FROM requests WHERE id=?'); $find->execute([$input['id']]);
        return ['ok' => true, 'item' => $this->item($find->fetch())];
    }
}
