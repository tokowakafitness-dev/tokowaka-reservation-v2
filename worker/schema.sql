-- TOKOWAKA 予約・契約 D1 スキーマ
--   第1段階：D1は「写し」。真実はスプレッドシート（契約）とGoogleカレンダー（予約）。
--             GASが押し出し、Workerは読むだけ。synced_at で鮮度を持つ。
--   第2段階以降：契約はこのD1が真実になり、スプレッドシートへ書き出す向きが逆転する。
--
-- 適用: wrangler d1 execute tokowaka --remote --file=worker/schema.sql

-- ★外部キー制約は置かない（2026-09-28）
--   第1段階のD1は写しであり、真実はスプレッドシートとカレンダーにある。
--   元データに歯抜け（担当トレーナー未設定など）があっても、それを理由に
--   顧客や予約を丸ごと落としてはいけない。整合は元データ側で正す。

-- ============================================================
-- トレーナー
-- ============================================================
CREATE TABLE IF NOT EXISTS trainers (
  trainer_id    TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  name_en       TEXT,
  calendar_id   TEXT,                       -- Googleカレンダー（第2段階で使う）
  line_user_id  TEXT UNIQUE,                -- LIFFのID Tokenで照合する相手
  role          TEXT NOT NULL DEFAULT 'trainer',   -- trainer | owner
  active        INTEGER NOT NULL DEFAULT 1,
  hidden        INTEGER NOT NULL DEFAULT 0,        -- 顧客の担当選択に出さない（オーナー等）
  synced_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_trainers_line ON trainers(line_user_id);

-- ============================================================
-- 顧客マスタ
--   ※ 個人情報を持つ。Workerは役割を確かめた上でしか返さない（perms.js）。
-- ============================================================
CREATE TABLE IF NOT EXISTS customers (
  customer_id        TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  kana               TEXT,
  phone              TEXT,
  email              TEXT,
  birthday           TEXT,                  -- YYYY-MM-DD
  line_user_id       TEXT UNIQUE,
  default_trainer_id TEXT,
  contract_status    TEXT,                  -- 在籍 / 休会 / 退会
  lang               TEXT DEFAULT 'ja',
  goal               TEXT,
  note               TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  synced_at          INTEGER
);
CREATE INDEX IF NOT EXISTS idx_customers_line    ON customers(line_user_id);
CREATE INDEX IF NOT EXISTS idx_customers_trainer ON customers(default_trainer_id);
CREATE INDEX IF NOT EXISTS idx_customers_name    ON customers(name);

-- ============================================================
-- 契約（積み上げ式・上書きしない）
--   1行＝1つの契約期間。更新は必ず新しい行を足す。
--   過去の予約がどの契約で消化されたかが、後から契約を直しても変わらないようにするため。
-- ============================================================
CREATE TABLE IF NOT EXISTS contracts (
  contract_id    TEXT PRIMARY KEY,
  customer_id    TEXT NOT NULL,
  course         TEXT NOT NULL,             -- フルサポート / 通常 / レンタル / モニター
  mode           TEXT NOT NULL,             -- monthly | ticket
  freq           INTEGER,                   -- mode=monthly：月あたりの回数
  tickets        INTEGER,                   -- mode=ticket：枚数
  unit_price     INTEGER NOT NULL,          -- 1回あたりの単価（円・税込）
  monthly_price  INTEGER,                   -- mode=monthly：月額（表示・請求用）
  pair           INTEGER NOT NULL DEFAULT 0,
  rental         INTEGER NOT NULL DEFAULT 0,
  start_date     TEXT NOT NULL,             -- YYYY-MM-DD
  end_date       TEXT NOT NULL,             -- YYYY-MM-DD（必ず月末日。入力画面が保証する）
  carry_cap      INTEGER,                   -- 繰越上限。NULLなら頻度テーブル（LB_CARRY_CAP_TABLE）
  trainer_id     TEXT,
  reward_rate    INTEGER NOT NULL DEFAULT 35,
  join_fee       INTEGER NOT NULL DEFAULT 0,
  -- 承認フロー：粗利率が下限を割る条件はトレーナーが出してオーナーが承認する
  status         TEXT NOT NULL DEFAULT 'active',    -- active | pending_approval | rejected | ended
  created_by     TEXT NOT NULL,             -- trainer_id
  created_at     INTEGER NOT NULL,
  approved_by    TEXT,
  approved_at    INTEGER,
  source         TEXT NOT NULL DEFAULT 'console',   -- console | sheet（第1段階はsheet＝写し）
  sheet_row      INTEGER,                   -- 写しのとき、請求ブックの行番号
  synced_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_contracts_cust   ON contracts(customer_id, start_date);
CREATE INDEX IF NOT EXISTS idx_contracts_status ON contracts(status);

-- ============================================================
-- 予約
--   第1段階：カレンダーからの写し。第2段階でここが真実になる。
--   ★ consumption_* を予約行に持たせる＝「どの契約のどの枠で消化したか」を確定させる。
--     いまのGASは毎回計算し直すため、契約を後から直すと過去の予約の消化先が遡って変わる
--     （2026-09-26 Codexレビュー指摘②）。D1へ移す最大の設計上の利得がこれ。
-- ============================================================
CREATE TABLE IF NOT EXISTS reservations (
  reservation_id     TEXT PRIMARY KEY,
  customer_id        TEXT,                  -- 未紐付け（体験の飛び込み等）はNULL
  customer_name      TEXT,                  -- 未紐付けのときの表示名
  trainer_id         TEXT NOT NULL,
  start_at           INTEGER NOT NULL,      -- epoch ms
  end_at             INTEGER NOT NULL,
  kind               TEXT NOT NULL,         -- normal | trial | transfer | block
  attendee_count     INTEGER NOT NULL DEFAULT 1,
  status             TEXT NOT NULL DEFAULT 'booked',   -- booked | cancelled | done
  -- 消化先の確定（第2段階で書き込む）
  consumption_kind   TEXT,                  -- monthly | ticket | transfer | none
  consumption_month  TEXT,                  -- YYYY-MM（monthlyのとき、どの月の枠か）
  consumption_contract_id TEXT,             -- どの契約行から引いたか
  calendar_event_id  TEXT,                  -- Googleカレンダー側のID（双方向同期の鍵）
  channel            TEXT,                  -- line | web | admin | salonboard
  created_by         TEXT,
  created_at         INTEGER NOT NULL,
  cancelled_at       INTEGER,
  synced_at          INTEGER
);
CREATE INDEX IF NOT EXISTS idx_resv_trainer ON reservations(trainer_id, start_at);
CREATE INDEX IF NOT EXISTS idx_resv_cust    ON reservations(customer_id, start_at);
CREATE INDEX IF NOT EXISTS idx_resv_cal     ON reservations(calendar_event_id);
CREATE INDEX IF NOT EXISTS idx_resv_start   ON reservations(start_at);

-- ============================================================
-- 固定枠（毎週この曜日・この時刻）
-- ============================================================
CREATE TABLE IF NOT EXISTS recurring_patterns (
  pattern_id   TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL,
  trainer_id   TEXT NOT NULL,
  weekday      INTEGER NOT NULL,            -- 0=日 〜 6=土
  time         TEXT NOT NULL,               -- HH:MM
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recur_cust ON recurring_patterns(customer_id);

-- ============================================================
-- InBody・体重（カルテ）
-- ============================================================
CREATE TABLE IF NOT EXISTS body_records (
  record_id     TEXT PRIMARY KEY,
  customer_id   TEXT NOT NULL,
  measured_at   INTEGER NOT NULL,
  weight_kg     REAL,
  body_fat_pct  REAL,
  muscle_kg     REAL,
  note          TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_body_cust ON body_records(customer_id, measured_at);

-- ============================================================
-- 同期の記録（どこまで取り込んだか・鮮度の監視用）
-- ============================================================
CREATE TABLE IF NOT EXISTS sync_state (
  key         TEXT PRIMARY KEY,             -- contracts | reservations | customers | trainers
  synced_at   INTEGER NOT NULL,
  rows        INTEGER,
  ok          INTEGER NOT NULL DEFAULT 1,
  message     TEXT
);

-- ============================================================
-- 写しの置き場（GASが計算した結果をそのまま持つ）
--   2026-09-28：当初KVに置く設計だったが、KVの書き込みは1日1,000回までで
--   会員40名を15分ごとに更新すると超える。D1は1日10万回まで無料。
--   加えて、このD1はAPACにあるため日本からはKVより近い。
--   「一人ひとり違うものはD1」という当初の方針にも、こちらのほうが合う。
-- ============================================================

-- 残数（Allocate.js の計算結果）。第2段階で計算そのものをWorkerへ移したら不要になる。
CREATE TABLE IF NOT EXISTS member_home (
  customer_id  TEXT PRIMARY KEY,
  payload      TEXT NOT NULL,          -- _lbBuildHome の戻りをそのままJSONで
  computed_at  INTEGER NOT NULL,
  synced_at    INTEGER
);

-- 空き枠（吸着方式でGASが作ったもの）
CREATE TABLE IF NOT EXISTS slots_cache (
  trainer_id   TEXT PRIMARY KEY,
  payload      TEXT NOT NULL,          -- { slots: [...], rules: {...} }
  computed_at  INTEGER NOT NULL,
  synced_at    INTEGER
);
