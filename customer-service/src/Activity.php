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
        $this->initializeAccessContext();
        $this->initializeTrafficHistory();
        $this->db->exec('CREATE INDEX IF NOT EXISTS requests_activity_received ON requests(received_at)');
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

    private function hasTable(string $name): bool {
        $find = $this->db->prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?");
        $find->execute([$name]);
        return (bool)$find->fetchColumn();
    }

    private static function localTime(string $instant): \DateTimeImmutable {
        return (new \DateTimeImmutable($instant))->setTimezone(new \DateTimeZone(self::TIME_ZONE));
    }

    private function initializeMonthlyHistory(): void {
        if ($this->hasTable('simulation_activity_months')) return;
        $this->db->exec('BEGIN IMMEDIATE');
        try {
            if (!$this->hasTable('simulation_activity_months')) {
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

    private function missingAccessColumns(): array {
        $context = ['device' => "TEXT NOT NULL DEFAULT 'unknown'", 'region' => 'TEXT'];
        $schemas = [
            'simulation_activity' => $context,
            'simulation_activity_months' => $context,
        ];
        $missing = [];
        foreach ($schemas as $table => $required) {
            $columns = $this->db->query("PRAGMA table_info($table)")->fetchAll(\PDO::FETCH_COLUMN, 1);
            $absent = array_diff_key($required, array_flip($columns));
            if ($absent) $missing[$table] = $absent;
        }
        return $missing;
    }

    private function initializeAccessContext(): void {
        if (!$this->missingAccessColumns()) return;
        $this->db->exec('BEGIN IMMEDIATE');
        try {
            // Recheck under the write lock when two requests initialize the same database.
            $missing = $this->missingAccessColumns();
            foreach ($missing as $table => $columns) {
                foreach ($columns as $name => $definition) {
                    $this->db->exec("ALTER TABLE $table ADD COLUMN $name $definition");
                }
            }
            $this->db->exec('COMMIT');
        } catch (\Throwable $error) {
            $this->db->exec('ROLLBACK');
            throw $error;
        }
    }

    private function initializeTrafficHistory(): void {
        if ($this->hasTable('simulation_traffic_tracking')) return;
        $this->db->exec('BEGIN IMMEDIATE');
        try {
            if (!$this->hasTable('simulation_traffic_tracking')) {
                $this->db->exec("CREATE TABLE simulation_traffic_tracking (
                    id INTEGER PRIMARY KEY CHECK(id=1), started_at TEXT NOT NULL
                );
                CREATE TABLE simulation_activity_hours (
                    local_day TEXT NOT NULL, local_hour INTEGER NOT NULL CHECK(local_hour BETWEEN 0 AND 23),
                    browser_key TEXT NOT NULL, PRIMARY KEY(local_day,local_hour,browser_key)
                ) WITHOUT ROWID");
                $this->db->prepare('INSERT INTO simulation_traffic_tracking(id,started_at) VALUES (1,?)')
                    ->execute([gmdate('Y-m-d\TH:i:s\Z')]);
                // Snapshots prove presence at their timestamps only. Never fill the hours between them.
                $history = $this->db->query('SELECT browser_key, first_seen AS seen_at FROM simulation_activity
                    UNION ALL SELECT browser_key, last_seen FROM simulation_activity
                    UNION ALL SELECT browser_key, last_seen FROM simulation_activity_months');
                $insert = $this->trafficInsert();
                foreach ($history as $row) {
                    $this->savePresence($row['browser_key'], $row['seen_at'], $insert);
                }
            }
            $this->db->exec('COMMIT');
        } catch (\Throwable $error) {
            $this->db->exec('ROLLBACK');
            throw $error;
        }
    }

    private function trafficInsert(): \PDOStatement {
        return $this->db->prepare('INSERT INTO simulation_activity_hours(local_day,local_hour,browser_key) VALUES (?,?,?)
            ON CONFLICT(local_day,local_hour,browser_key) DO NOTHING');
    }

    private function savePresence(string $browser, string $timestamp, ?\PDOStatement $insert = null): void {
        $local = self::localTime($timestamp);
        ($insert ?? $this->trafficInsert())->execute([$local->format('Y-m-d'), (int)$local->format('G'), $browser]);
    }

    private function saveMonth(string $draft, string $lastSeen): void {
        $columns = self::SNAPSHOT_COLUMNS . ',device,region';
        $save = $this->db->prepare("INSERT INTO simulation_activity_months (month,$columns)
            SELECT ?, $columns FROM simulation_activity WHERE draft_key=?
            ON CONFLICT(month,draft_key) DO UPDATE SET
                last_seen=excluded.last_seen, step=excluded.step, max_step=excluded.max_step, started=excluded.started,
                choices=excluded.choices, payment=excluded.payment, quote=excluded.quote, request_id=excluded.request_id,
                device=excluded.device, region=excluded.region");
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

    public function record(array $input, Domain $domain, array $access = []): array {
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
                    // Reordered events can add a missed milestone, but cannot replace the newest access context.
                    $device = $access['device'] ?? 'unknown';
                    $update = $this->db->prepare('UPDATE simulation_activity SET revision=?,step=?,max_step=?,started=?,
                        choices=?,payment=?,quote=?,quote_revision=?,last_seen=?,device=?,region=? WHERE draft_key=?');
                    $update->execute([max($revision, (int)$row['revision']), $fresh ? $step : $row['step'], $nextStep, (int)$started,
                        json_encode($saved, JSON_THROW_ON_ERROR), $fresh && array_key_exists('paymentMethod', $input) ? $payment : $row['payment'],
                        $quote, $newQuote ? $revision : $row['quote_revision'], $now,
                        $fresh ? $device : $row['device'], $fresh ? ($access['region'] ?? null) : $row['region'], $identity['draft']]);
                    $this->saveMonth($identity['draft'], $now);
                    if ($fresh) $this->savePresence($identity['browser'], $now);
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
    public function link(array $identity, string $requestId, array $request, array $access = []): void {
        $row = $this->openRow($identity, $request['createdAt']);
        if ($row['request_id'] === $requestId) return;
        if ($row['request_id'] !== null) throw new Problem(409, 'Esta simulação já foi enviada. Inicie uma nova simulação.');
        $device = $access['device'] ?? 'unknown';
        $update = $this->db->prepare('UPDATE simulation_activity SET request_id=?, step=4,max_step=4,started=1,
            choices=?,payment=?,last_seen=?,device=?,region=? WHERE draft_key=? AND request_id IS NULL');
        $update->execute([$requestId, json_encode($request['configuration'], JSON_THROW_ON_ERROR),
            $request['payment']['method'], $request['createdAt'], $device, $access['region'] ?? null, $identity['draft']]);
        $this->saveMonth($identity['draft'], $request['createdAt']);
        $this->savePresence($identity['browser'], $request['createdAt']);
    }

    private function visitorsByDevice(string $month): array {
        // Choose one snapshot per browser before filtering: a reassessment cannot count a browser twice.
        $query = $this->db->prepare("SELECT device, COUNT(*) AS total FROM (
                SELECT device, ROW_NUMBER() OVER (
                    PARTITION BY browser_key ORDER BY last_seen DESC, rowid DESC
                ) AS visit_rank FROM simulation_activity_months WHERE month=?
            ) WHERE visit_rank=1 AND device IN ('mobile','desktop') GROUP BY device");
        $query->execute([$month]);
        $counts = ['mobile' => 0, 'desktop' => 0];
        foreach ($query as $row) $counts[$row['device']] = (int)$row['total'];
        return $counts;
    }

    private function monthlyTraffic(string $month, \DateTimeImmutable $now): array {
        $start = new \DateTimeImmutable($month . '-01 00:00:00', new \DateTimeZone(self::TIME_ZONE));
        $bounds = [$start->format('Y-m-d'), $start->format('Y-m-t')];
        $daily = $this->db->prepare('SELECT local_day, COUNT(DISTINCT browser_key)
            FROM simulation_activity_hours WHERE local_day BETWEEN ? AND ? GROUP BY local_day');
        $daily->execute($bounds);
        $counts = $daily->fetchAll(\PDO::FETCH_KEY_PAIR);
        $days = [];
        $lastDay = (int)$start->format('t');
        for ($day = 1; $day <= $lastDay; $day++) {
            $date = sprintf('%s-%02d', $month, $day);
            $days[] = ['date' => $date, 'browsers' => (int)($counts[$date] ?? 0)];
        }
        // Each stored row is one browser in one concrete local date/hour.
        $hourly = $this->db->prepare('SELECT local_hour, COUNT(*) AS total
            FROM simulation_activity_hours WHERE local_day BETWEEN ? AND ? GROUP BY local_hour');
        $hourly->execute($bounds);
        $hours = array_fill(0, 24, 0);
        foreach ($hourly as $row) $hours[(int)$row['local_hour']] = (int)$row['total'];
        $started = $this->db->query('SELECT started_at FROM simulation_traffic_tracking WHERE id=1')->fetchColumn();
        return ['timeZone' => self::TIME_ZONE, 'trackingStartedAt' => $started, 'asOf' => $now->format('Y-m-d\TH:i:s\Z'),
            'partialHistory' => $start < new \DateTimeImmutable($started), 'days' => $days, 'hours' => $hours];
    }

    public function listing(int $page, mixed $month = null): array {
        if ($page < 1 || $page > 100000) throw new Problem(422, 'Página inválida.');
        $now = new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
        $currentMonth = $now->setTimezone(new \DateTimeZone(self::TIME_ZONE))->format('Y-m');
        $month ??= $currentMonth;
        if (!is_string($month) || !preg_match('/^(?!0000)[0-9]{4}-(0[1-9]|1[0-2])$/D', $month)) {
            throw new Problem(422, 'Mês inválido.');
        }
        $this->db->beginTransaction();
        try {
            $firstMonth = $this->db->query('SELECT MIN(month) FROM simulation_activity_months')->fetchColumn() ?: $currentMonth;
            $firstRequest = $this->db->query('SELECT MIN(received_at) FROM requests')->fetchColumn();
            if ($firstRequest) $firstMonth = min($firstMonth, self::localTime($firstRequest)->format('Y-m'));
            // A submission in a later month closes this draft in the list, but not other drafts from the same browser.
            $openDraft = 'm.request_id IS NULL AND NOT EXISTS (SELECT 1 FROM simulation_activity a
                WHERE a.draft_key=m.draft_key AND a.request_id IS NOT NULL)';
            $count = $this->db->prepare("SELECT COUNT(CASE WHEN $openDraft THEN 1 END) AS total, COUNT(DISTINCT browser_key) AS browsers,
                COALESCE(SUM(started),0) AS started, COUNT(quote) AS viewed
                FROM simulation_activity_months m WHERE month=?");
            $count->execute([$month]);
            $totals = array_map('intval', $count->fetch());
            $totals['visitorsByDevice'] = $this->visitorsByDevice($month);
            $traffic = $this->monthlyTraffic($month, $now);
            $read = $this->db->prepare("SELECT last_seen,step,max_step,started,choices,payment,quote,request_id,device,region
                FROM simulation_activity_months m WHERE month=? AND $openDraft ORDER BY last_seen DESC,draft_key LIMIT 25 OFFSET ?");
            $read->bindValue(1, $month);
            $read->bindValue(2, ($page - 1) * 25, \PDO::PARAM_INT);
            $read->execute();
            $items = [];
            foreach ($read as $row) {
                $items[] = [
                    'device' => $row['device'], 'region' => $row['region'],
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
            'month' => $month, 'currentMonth' => $currentMonth, 'firstMonth' => $firstMonth,
            'summary' => $totals, 'traffic' => $traffic, 'items' => $items];
    }
}
