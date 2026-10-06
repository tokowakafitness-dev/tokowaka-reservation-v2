-- 0009 予約の正本をD1へ移す（段階3-a の土台）
--
--   設計：ops/design/04-booking-to-d1.md（第3版）
--   決定：0062（正本をD1へ）／0068（超過は見せる）／0069（カレンダーは出力）
--
--   ★この移行では「枠を直接UPDATEして確保する」書き方をしない。
--     残数の条件は引当のINSERTに1回だけ書き、枠の増減はトリガーに任せる。
--     理由：条件付きUPDATEは条件不成立でも0行を返すだけでSQLエラーにならないため、
--     後続の文がそのまま実行されてコミットされる。残数の条件を2箇所に書くと、
--     2つの条件は必ずどこかでずれる（used = quota でずれた・Codex関門①）。
--
--   不変条件：**枠（monthly_quota.used / ticket_packs.used）を触るのはトリガーだけ。**
--     アプリ側のSQLにこれらへの UPDATE が現れたら、それは設計からの逸脱。

-- ============================================================
-- 1. 枠（会員×月）
-- ============================================================
CREATE TABLE IF NOT EXISTS monthly_quota (
  customer_id TEXT    NOT NULL,
  month_key   TEXT    NOT NULL,          -- 'YYYY-MM'
  quota       INTEGER NOT NULL,          -- 頻度＋繰越（契約から計算して入れる）
  used        INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (customer_id, month_key),
  CHECK (quota >= 0),
  -- used は quota を超えうる。支払い前の仮押さえが超過として記録されるため（決定0068）。
  -- 負にはならない。
  CHECK (used >= 0)
);

-- ============================================================
-- 2. チケット（買った単位ごと）
-- ============================================================
CREATE TABLE IF NOT EXISTS ticket_packs (
  pack_id     TEXT PRIMARY KEY,
  customer_id TEXT    NOT NULL,
  kind        TEXT    NOT NULL,          -- 'normal' | 'pair'
  total       INTEGER NOT NULL,
  used        INTEGER NOT NULL DEFAULT 0,
  valid_from  INTEGER NOT NULL,
  valid_to    INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  CHECK (kind IN ('normal','pair')),
  CHECK (total >= 0),
  CHECK (used >= 0),
  CHECK (valid_from <= valid_to)
);
CREATE INDEX IF NOT EXISTS idx_packs_customer ON ticket_packs(customer_id, valid_to);

-- ============================================================
-- 3. 引当（★これが「消化先の固定」の正体であり、確保そのもの）
-- ============================================================
CREATE TABLE IF NOT EXISTS reservation_allocations (
  reservation_id TEXT PRIMARY KEY,
  customer_id    TEXT    NOT NULL,
  source         TEXT    NOT NULL,       -- 'monthly' | 'ticket' | 'pair' | 'transfer'
  month_key      TEXT,                   -- monthly のとき、どの月の枠か
  pack_id        TEXT,                   -- ticket/pair のとき、どのパックか
  units          INTEGER NOT NULL DEFAULT 1,
  decided_at     INTEGER NOT NULL,

  CHECK (source IN ('monthly','ticket','pair','transfer')),

  -- ★units に制約が無いと、負の値が上限の条件（used + units <= total）を素通りしたうえ、
  --   消費のトリガーが used を**減らす**＝予約するたびに残数が増える（Codex関門①）。
  CHECK (units > 0),
  -- ★ペアは 1 も正当。ペア契約の方が1名で来店する運用があり、ペアpackから1枚だけ引く
  --   （差額を請求する）。gas/Allocate.js:366「ペア＝常にpack（1名来店でも）」
  --   gas/Allocate.js:837「消化枚数（ペア2名=2・1名=1）」
  CHECK ((source = 'pair' AND units IN (1,2)) OR (source <> 'pair' AND units = 1)),

  -- source ごとに、どちらの親を指すかを固定する
  CHECK ((source = 'monthly'            AND month_key IS NOT NULL AND pack_id IS NULL)
      OR (source IN ('ticket','pair')   AND pack_id   IS NOT NULL AND month_key IS NULL)
      OR (source = 'transfer'           AND pack_id   IS NULL     AND month_key IS NULL)),

  -- 親が無い引当を作らせない（別経路からの直接INSERTを塞ぐ）
  FOREIGN KEY (customer_id, month_key) REFERENCES monthly_quota(customer_id, month_key),
  FOREIGN KEY (pack_id)                REFERENCES ticket_packs(pack_id)
);
CREATE INDEX IF NOT EXISTS idx_alloc_customer ON reservation_allocations(customer_id, decided_at);
CREATE INDEX IF NOT EXISTS idx_alloc_month    ON reservation_allocations(customer_id, month_key);
CREATE INDEX IF NOT EXISTS idx_alloc_pack     ON reservation_allocations(pack_id);

-- ============================================================
-- 4. 枠の増減（★アプリからは触らない。ここだけが触る）
-- ============================================================

-- 引当ができたら枠が減る。「引当がある」と「枠が減っている」を同じ出来事にする。
CREATE TRIGGER IF NOT EXISTS trg_alloc_consume_monthly
AFTER INSERT ON reservation_allocations
WHEN NEW.source = 'monthly'
BEGIN
  UPDATE monthly_quota
     SET used = used + NEW.units, updated_at = NEW.decided_at
   WHERE customer_id = NEW.customer_id AND month_key = NEW.month_key;
END;

-- ★'ticket' と 'pair' の両方を対象にする。片方だけにするとペアの枠が減らない。
CREATE TRIGGER IF NOT EXISTS trg_alloc_consume_pack
AFTER INSERT ON reservation_allocations
WHEN NEW.source IN ('ticket','pair')
BEGIN
  UPDATE ticket_packs
     SET used = used + NEW.units, updated_at = NEW.decided_at
   WHERE pack_id = NEW.pack_id;
END;

-- 返却も同じ場所で。手動のUPDATEと併用すると二重に戻り、取り消すたびに残数が増える。
CREATE TRIGGER IF NOT EXISTS trg_alloc_return_monthly
AFTER DELETE ON reservation_allocations
WHEN OLD.source = 'monthly'
BEGIN
  UPDATE monthly_quota
     SET used = used - OLD.units, updated_at = OLD.decided_at
   WHERE customer_id = OLD.customer_id AND month_key = OLD.month_key
     AND used >= OLD.units;             -- 負の残数を作らない
END;

CREATE TRIGGER IF NOT EXISTS trg_alloc_return_pack
AFTER DELETE ON reservation_allocations
WHEN OLD.source IN ('ticket','pair')
BEGIN
  UPDATE ticket_packs
     SET used = used - OLD.units, updated_at = OLD.decided_at
   WHERE pack_id = OLD.pack_id
     AND used >= OLD.units;
END;

-- ============================================================
-- 5. 操作の記録（★最後の砦）
-- ============================================================
--   予約が作れていなければ、下のサブクエリが NULL を返し、
--   reservation_id の NOT NULL 違反で**バッチ全体がロールバックする**。
--
--     INSERT INTO op_log (op_id, reservation_id, created_at)
--     VALUES (:opid, (SELECT reservation_id FROM reservations WHERE reservation_id = :rid), :now);
--
--   ★この NOT NULL がバッチの成否を決めている。外すと「予約が無いのに残数だけ減る」
--     壊れ方が静かに戻ってくる。
CREATE TABLE IF NOT EXISTS op_log (
  op_id          TEXT PRIMARY KEY,
  reservation_id TEXT    NOT NULL,       -- ★NOT NULL がこの設計の要。外さない
  result         TEXT,                   -- 再送に同じ応答を返すための控え
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oplog_resv ON op_log(reservation_id);

-- ============================================================
-- 6. 予約に「占有の2軸」と「支払いの状態」を足す
-- ============================================================
--   施設とトレーナーは別々に埋まる（決定0069）。
--     通常・体験      地下 ✅ / トレーナー ✅
--     オンライン      地下 ❌ / トレーナー ✅   ← いまは1Fカレンダーに置いて表現している
--   既定は「両方を占有する・残数を使う・支払い済み」＝いまの通常の予約と同じ振る舞い。
--
--   ★SQLite は既存テーブルに CHECK を後から足せない。
--     ここでは列だけ足し、値の正しさはアプリ側と第10節の検査で守る。
--     正本の移行（3-c）でテーブルを作り直すときに CHECK を付ける。
ALTER TABLE reservations ADD COLUMN occupies_facility INTEGER NOT NULL DEFAULT 1;
ALTER TABLE reservations ADD COLUMN occupies_trainer  INTEGER NOT NULL DEFAULT 1;
ALTER TABLE reservations ADD COLUMN consumes_quota    INTEGER NOT NULL DEFAULT 1;
-- ★payment_status をクライアントから受け取ってはならない。入口に応じてサーバが決める。
--   顧客が 'unpaid' を送れると、残数の検査を迂回して無制限に予約できる。
ALTER TABLE reservations ADD COLUMN payment_status    TEXT    NOT NULL DEFAULT 'paid';

-- 重なりの検査が使う索引（施設・トレーナーで別々に引く）
CREATE INDEX IF NOT EXISTS idx_resv_facility_window
  ON reservations(start_at, end_at) WHERE status = 'booked' AND occupies_facility = 1;
CREATE INDEX IF NOT EXISTS idx_resv_trainer_window
  ON reservations(trainer_id, start_at, end_at) WHERE status = 'booked' AND occupies_trainer = 1;
