<?php
declare(strict_types=1);
namespace Realponto;

final class Activity {
    private const TIME_ZONE = 'America/Sao_Paulo';
    private const SNAPSHOT_COLUMNS = 'draft_key,browser_key,last_seen,step,max_step,started,choices,payment,quote,request_id';
    public function __construct(private readonly \PDO $db, private readonly string $key) {
        $db->exec("CREATE TABLE IF NOT EXISTS simulation_activity (
            draft_key TEXT PRIMARY KEY, browser_key TEXT NOT NULL,
            first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
            revision INTEGER NOT NULL DEFAULT 0, step INTEGER NOT NULL DEFAULT 1,
            max_step INTEGER NOT NULL DEFAULT 1, started INTEGER NOT NULL DEFAULT 0,
            choices TEXT NOT NULL DEFAULT '{}', payment TEXT, quote TEXT, quote_revision INTEGER NOT NULL DEFAULT 0,
            request_id TEXT UNIQUE REFERENCES requests(id)
        )");
        $db->exec('CREATE INDEX IF NOT EXISTS simulation_activity_seen ON simulation_activity(last_seen DESC, draft_key)');
        $this->initializeMonthlyHistory();
    }

    /** Public identifiers are capabilities. Neither the raw IDs nor the hashes are listed in the panel. */
    public function identity(mixed $value): ?array {
        if (!is_array($value)) return null;
        foreach (['browserId', 'simulationId'] as $key) {
            if (!is_string($value[$key] ?? null) ||
                !preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iD', $value[$key])) return null;
        }
        $browser = strtolower($value['browserId']);
        return [
            'browser' => hash_hmac('sha256', 'activity-browser:' . $browser, $this->key),
            'draft' => hash_hmac('sha256', 'activity-draft:' . $browser . ':' . strtolower($value['simulationId']), $this->key),
        ];
    }

    private function hasMonthlyHistory(): bool {
        return (bool)$this->db->query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='simulation_activity_months'")->fetchColumn();
    }

    private static function localTime(string $instant): \DateTimeImmutable {
        return (new \DateTimeImmutable($instant))->setTimezone(new \DateTimeZone(self::TIME_ZONE));
    }

    private function initializeMonthlyHistory(): void {
        if ($this->hasMonthlyHistory()) return;
        $this->db->exec('BEGIN IMMEDIATE');
        try {
            if (!$this->hasMonthlyHistory()) {
                $this->db->exec("CREATE TABLE simulation_activity_months (
                    month TEXT NOT NULL, draft_key TEXT NOT NULL, browser_key TEXT NOT NULL, last_seen TEXT NOT NULL,
                    step INTEGER NOT NULL, max_step INTEGER NOT NULL, started INTEGER NOT NULL, choices TEXT NOT NULL,
                    payment TEXT, quote TEXT, request_id TEXT REFERENCES requests(id), PRIMARY KEY(month,draft_key)
                );
                CREATE INDEX simulation_months_seen ON simulation_activity_months(month,last_seen DESC,draft_key)");
                // Legacy records tell us when the draft opened and its final observed state, but no intervening steps.
                $columns = self::SNAPSHOT_COLUMNS;
                $latest = $this->db->prepare("INSERT INTO simulation_activity_months (month,$columns)
                    SELECT ?, $columns FROM simulation_activity WHERE draft_key=?");
                $visit = $this->db->prepare("INSERT INTO simulation_activity_months
                    (month,draft_key,browser_key,last_seen,step,max_step,started,choices) VALUES (?,?,?,?,1,1,0,'{}')");
                $legacy = $this->db->query('SELECT draft_key,browser_key,first_seen,last_seen FROM simulation_activity');
                foreach ($legacy as $row) {
                    $firstMonth = self::localTime($row['first_seen'])->format('Y-m');
                    $lastMonth = self::localTime($row['last_seen'])->format('Y-m');
                    if ($firstMonth !== $lastMonth) {
                        $visit->execute([$firstMonth, $row['draft_key'], $row['browser_key'], $row['first_seen']]);
                    }
                    $latest->execute([$lastMonth, $row['draft_key']]);
                }
            }
            $this->db->exec('COMMIT');
        } catch (\Throwable $error) {
            $this->db->exec('ROLLBACK');
            throw $error;
        }
    }

    // Called only after a state change and within the same transaction as the source record.
    private function saveMonth(string $draft, string $lastSeen): void {
        $columns = self::SNAPSHOT_COLUMNS;
        $save = $this->db->prepare("INSERT OR REPLACE INTO simulation_activity_months (month,$columns)
            SELECT ?, $columns FROM simulation_activity WHERE draft_key=?");
        $save->execute([self::localTime($lastSeen)->format('Y-m'), $draft]);
    }

    private function openRow(array $identity, string $now): array {
        $this->db->prepare('INSERT INTO simulation_activity(draft_key,browser_key,first_seen,last_seen)
            VALUES (?,?,?,?) ON CONFLICT(draft_key) DO NOTHING')->execute([$identity['draft'], $identity['browser'], $now, $now]);
        $get = $this->db->prepare('SELECT * FROM simulation_activity WHERE draft_key=?');
        $get->execute([$identity['draft']]);
        return $get->fetch();
    }

    /** Keep the amount actually rendered even across a campaign or catalog change.
     * This snapshot is for the activity panel. Proposal pricing always comes from Domain.
     */
    private function viewedQuote(array $input, array $choices, Domain $domain, \DateTimeImmutable $instant): string {
        $calculated = $domain->configurationEstimate($choices, $instant);
        $shown = array_key_exists('displayedTotalCents', $input) ? $input['displayedTotalCents'] : $calculated['totalCents'];
        if ($shown === null && $calculated['status'] !== 'consultation') throw new Problem(422, 'Valor exibido inválido.');
        if ($shown !== null && ($calculated['status'] !== 'priced' || !is_int($shown) || $shown < 0 || $shown > 9007199254740991)) {
            throw new Problem(422, 'Valor exibido inválido.');
        }
        return json_encode(['status' => $calculated['status'], 'totalCents' => $shown,
            'matchesCatalog' => $shown === $calculated['totalCents']], JSON_THROW_ON_ERROR);
    }

    public function record(array $input, Domain $domain): array {
        $allowed = ['browserId','simulationId','revision','step','estimateViewed','configuration','paymentMethod','displayedTotalCents'];
        $identity = $this->identity($input);
        $revision = $input['revision'] ?? null;
        $step = $input['step'] ?? null;
        $viewed = $input['estimateViewed'] ?? null;
        $configuration = $input['configuration'] ?? [];
        $payment = $input['paymentMethod'] ?? null;
        if (array_diff(array_keys($input), $allowed) || !$identity || !is_int($revision) || $revision < 1 ||
            $revision > 9007199254740991 || !is_int($step) || $step < 1 || $step > 4 || !is_bool($viewed) ||
            !is_array($configuration) || ($payment !== null && (!is_string($payment) || !isset(Domain::PAYMENTS[$payment])))) {
            throw new Problem(422, 'Atividade inválida.');
        }
        $choices = $domain->configuration($configuration, true);
        $selected = array_filter($choices, static fn($v) => $v !== null);
        if ($viewed && ($step !== 4 || count($selected) !== count($choices))) throw new Problem(422, 'Orçamento incompleto.');
        if (!$viewed && array_key_exists('displayedTotalCents', $input)) throw new Problem(422, 'A estimativa requer visualização.');
        $instant = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
        $now = $instant->format('Y-m-d\TH:i:s\Z');
        $visibleQuote = $viewed ? $this->viewedQuote($input, $choices, $domain, $instant) : null;
        $this->db->exec('BEGIN IMMEDIATE');
        try {
            $row = $this->openRow($identity, $now);
            if ($row['request_id'] !== null && $viewed && $revision > (int)$row['quote_revision']) {
                // A fast form submission may reach PHP before the queued quote-view event.
                $update = $this->db->prepare('UPDATE simulation_activity SET quote=?,quote_revision=? WHERE draft_key=?');
                $update->execute([$visibleQuote, $revision, $identity['draft']]);
                $this->saveMonth($identity['draft'], $row['last_seen']);
            } elseif ($row['request_id'] === null && $revision !== (int)$row['revision']) {
                $fresh = $revision > (int)$row['revision'];
                $newQuote = $viewed && $revision > (int)$row['quote_revision'];
                $nextStep = max($step, (int)$row['max_step']);
                $started = (bool)$row['started'] || count($selected) > 0;
                if ($fresh || $newQuote || $nextStep > (int)$row['max_step'] || ($started && !(bool)$row['started'])) {
                    $saved = json_decode($row['choices'], true, 16, JSON_THROW_ON_ERROR);
                    if ($fresh) $saved = array_replace($saved, array_intersect_key($choices, $configuration));
                    $quote = $newQuote ? $visibleQuote : $row['quote'];
                    $update = $this->db->prepare('UPDATE simulation_activity SET revision=?,step=?,max_step=?,started=?,
                        choices=?,payment=?,quote=?,quote_revision=?,last_seen=? WHERE draft_key=?');
                    $update->execute([max($revision, (int)$row['revision']), $fresh ? $step : $row['step'], $nextStep, (int)$started,
                        json_encode($saved, JSON_THROW_ON_ERROR), $fresh && array_key_exists('paymentMethod', $input) ? $payment : $row['payment'],
                        $quote, $newQuote ? $revision : $row['quote_revision'], $now, $identity['draft']]);
                    $this->saveMonth($identity['draft'], $now);
                }
            }
            $this->db->exec('COMMIT');
        } catch (\Throwable $error) {
            $this->db->exec('ROLLBACK');
            throw $error;
        }
        return ['ok' => true];
    }

    /** Called inside the same write transaction as the real proposal. */
    public function linkedRequest(array $identity): ?array {
        $find = $this->db->prepare('SELECT r.id,r.input_hash,r.received_at,r.mail_status FROM simulation_activity a
            JOIN requests r ON r.id=a.request_id WHERE a.draft_key=?');
        $find->execute([$identity['draft']]);
        return $find->fetch() ?: null;
    }
    public function link(array $identity, string $requestId, array $request): void {
        $row = $this->openRow($identity, $request['createdAt']);
        if ($row['request_id'] === $requestId) return;
        if ($row['request_id'] !== null) throw new Problem(409, 'Esta simulação já foi enviada. Inicie uma nova simulação.');
        $update = $this->db->prepare('UPDATE simulation_activity SET request_id=?, step=4,max_step=4,started=1,
            choices=?,payment=?,last_seen=? WHERE draft_key=? AND request_id IS NULL');
        $update->execute([$requestId, json_encode($request['configuration'], JSON_THROW_ON_ERROR),
            $request['payment']['method'], $request['createdAt'], $identity['draft']]);
        $this->saveMonth($identity['draft'], $request['createdAt']);
    }

    public function listing(int $page, mixed $month = null): array {
        if ($page < 1 || $page > 100000) throw new Problem(422, 'Página inválida.');
        $currentMonth = self::localTime('now')->format('Y-m');
        $month ??= $currentMonth;
        if (!is_string($month) || !preg_match('/^(?!0000)[0-9]{4}-(0[1-9]|1[0-2])$/D', $month)) {
            throw new Problem(422, 'Mês inválido.');
        }
        $this->db->beginTransaction();
        try {
            $firstMonth = $this->db->query('SELECT MIN(month) FROM simulation_activity_months')->fetchColumn() ?: $currentMonth;
            $count = $this->db->prepare('SELECT COUNT(*) AS total, COUNT(DISTINCT browser_key) AS browsers,
                COALESCE(SUM(started),0) AS started, COUNT(quote) AS viewed, COUNT(request_id) AS submitted
                FROM simulation_activity_months WHERE month=?');
            $count->execute([$month]);
            $totals = array_map('intval', $count->fetch());
            $read = $this->db->prepare('SELECT last_seen,step,max_step,started,choices,payment,quote,request_id
                FROM simulation_activity_months WHERE month=? ORDER BY last_seen DESC,draft_key LIMIT 25 OFFSET ?');
            $read->bindValue(1, $month);
            $read->bindValue(2, ($page - 1) * 25, \PDO::PARAM_INT);
            $read->execute();
            $items = [];
            foreach ($read as $row) {
                $items[] = [
                    'lastActivityAt' => $row['last_seen'], 'step' => (int)$row['step'], 'maxStep' => (int)$row['max_step'],
                    'started' => (bool)$row['started'], 'configuration' => (object)json_decode($row['choices'], true, 16, JSON_THROW_ON_ERROR),
                    'paymentMethod' => $row['payment'], 'estimateViewed' => $row['quote'] !== null,
                    'estimate' => $row['quote'] !== null ? json_decode($row['quote'], true, 16, JSON_THROW_ON_ERROR) : null,
                    'requestId' => $row['request_id'],
                ];
            }
            $this->db->commit();
        } catch (\Throwable $error) {
            $this->db->rollBack();
            throw $error;
        }
        $total = $totals['total'];
        unset($totals['total']);
        return ['ok' => true, 'page' => $page, 'total' => $total, 'totalPages' => max(1, (int)ceil($total / 25)),
            'month' => $month, 'currentMonth' => $currentMonth, 'firstMonth' => $firstMonth, 'summary' => $totals, 'items' => $items];
    }
}
