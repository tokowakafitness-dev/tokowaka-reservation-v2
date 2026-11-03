-- 設計28：トレーナー用の顧客カルテ（段1）・2026-11-03
--   カルテ固有のデータと体の記録は D1 が唯一の正本。Worker（k_ の操作・/body/write）だけが書く。
--   ★健康情報（karte_safety）は同意の記録があるときだけ書ける・読める（1文の条件つき・設計28 3-3）。

-- ---------- ② 目標・動機（1会員1行）----------
CREATE TABLE IF NOT EXISTS karte_profile (
  customer_id   TEXT PRIMARY KEY,
  goal_text     TEXT,
  goal_value    REAL,
  goal_unit     TEXT,
  goal_deadline TEXT,                -- YYYY-MM-DD
  motive        TEXT,
  history       TEXT,                -- 過去のジム経験と続かなかった理由
  rev           INTEGER NOT NULL DEFAULT 1,
  updated_by    TEXT NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- ---------- 同意（今の状態＋履歴）----------
CREATE TABLE IF NOT EXISTS karte_consent (
  customer_id TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('health')),
  state       TEXT NOT NULL CHECK (state IN ('agreed', 'revoked')),
  changed_at  INTEGER NOT NULL,
  method      TEXT CHECK (method IN ('paper', 'line')),
  recorded_by TEXT NOT NULL,
  PRIMARY KEY (customer_id, kind)
);
CREATE TABLE IF NOT EXISTS karte_consent_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id TEXT NOT NULL,
  kind        TEXT NOT NULL,
  state       TEXT NOT NULL,
  at          INTEGER NOT NULL,
  method      TEXT,
  recorded_by TEXT NOT NULL
);

-- ---------- ③ 安全面（要配慮個人情報）----------
CREATE TABLE IF NOT EXISTS karte_safety (
  customer_id  TEXT PRIMARY KEY,
  conditions   TEXT,
  injuries     TEXT,
  pain_sites   TEXT,
  medication   TEXT,
  restrictions TEXT,
  source       TEXT NOT NULL DEFAULT 'trainer' CHECK (source IN ('trainer', 'form')),
  rev          INTEGER NOT NULL DEFAULT 1,
  updated_by   TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- ---------- ⑧ セッションメモ ----------
CREATE TABLE IF NOT EXISTS karte_notes (
  note_id           TEXT PRIMARY KEY,   -- Worker が作る（応答を書き込みの前に決めるため）
  customer_id       TEXT NOT NULL,
  session_date      TEXT NOT NULL,     -- YYYY-MM-DD
  condition         TEXT CHECK (condition IN ('good', 'normal', 'bad')),
  body              TEXT,
  next_plan         TEXT,
  author_trainer_id TEXT NOT NULL,
  rev               INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL,
  edited_at         INTEGER,
  edited_by         TEXT,
  deleted_at        INTEGER,
  deleted_by        TEXT
);
CREATE INDEX IF NOT EXISTS idx_karte_notes_cust ON karte_notes (customer_id, session_date);

-- ---------- ⑦ トレーニング（親＝その日・子＝1行1セット）----------
CREATE TABLE IF NOT EXISTS karte_tr_sessions (
  session_id        TEXT PRIMARY KEY,   -- Worker が作る
  customer_id       TEXT NOT NULL,
  session_date      TEXT NOT NULL,
  author_trainer_id TEXT NOT NULL,
  rev               INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL,
  deleted_at        INTEGER,
  deleted_by        TEXT
);
CREATE INDEX IF NOT EXISTS idx_karte_tr_cust ON karte_tr_sessions (customer_id, session_date);
CREATE TABLE IF NOT EXISTS karte_tr_sets (
  set_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES karte_tr_sessions(session_id),
  exercise   TEXT NOT NULL,
  set_no     INTEGER NOT NULL CHECK (set_no BETWEEN 1 AND 10),
  weight_kg  REAL NOT NULL CHECK (weight_kg >= 0 AND weight_kg <= 500),
  reps       INTEGER NOT NULL CHECK (reps BETWEEN 1 AND 100),
  note       TEXT
);
CREATE INDEX IF NOT EXISTS idx_karte_sets_session ON karte_tr_sets (session_id);

-- ---------- 編集・削除の前の中身（追記だけ。安全面の中身は入れない）----------
CREATE TABLE IF NOT EXISTS karte_revisions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name  TEXT NOT NULL,
  row_id      TEXT NOT NULL,
  rev         INTEGER NOT NULL,
  before_json TEXT,
  changed_by  TEXT NOT NULL,
  changed_at  INTEGER NOT NULL,
  reason      TEXT
);

-- ---------- 二重送信を弾く（k_ の書き込み）----------
CREATE TABLE IF NOT EXISTS karte_requests (
  trainer_id    TEXT NOT NULL,
  action        TEXT NOT NULL,
  client_req_id TEXT NOT NULL,
  payload_hash  TEXT NOT NULL,
  http_status   INTEGER NOT NULL,
  result_code   TEXT NOT NULL,
  result_json   TEXT,
  done_at       INTEGER NOT NULL,
  PRIMARY KEY (trainer_id, action, client_req_id)
);

-- ---------- 誰がいつ開いた・書いた（中身は書かない・保存1年）----------
CREATE TABLE IF NOT EXISTS karte_access_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  trainer_id  TEXT,
  role        TEXT,
  customer_id TEXT,
  section     TEXT,
  action      TEXT NOT NULL,
  result      TEXT NOT NULL CHECK (result IN ('ok', 'denied', 'not_found', 'conflict', 'no_consent', 'rate_limited', 'error')),
  req_id      TEXT
);
CREATE INDEX IF NOT EXISTS idx_karte_access_at ON karte_access_log (at);

-- ---------- 書き込みの回数（10分の区切りごと）----------
CREATE TABLE IF NOT EXISTS karte_rate (
  trainer_id   TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  n            INTEGER NOT NULL,
  PRIMARY KEY (trainer_id, window_start)
);

-- ---------- 退会後3年の起算日（追記だけ）----------
CREATE TABLE IF NOT EXISTS karte_membership_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id     TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('withdrawn', 'rejoined', 'cancel')),
  effective_date  TEXT,
  target_event_id INTEGER,
  recorded_by     TEXT NOT NULL,
  recorded_at     INTEGER NOT NULL,
  reason          TEXT,
  CHECK ((kind = 'cancel' AND effective_date IS NULL AND target_event_id IS NOT NULL AND reason IS NOT NULL)
      OR (kind <> 'cancel' AND effective_date IS NOT NULL AND target_event_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_karte_member_cust ON karte_membership_events (customer_id);

-- ---------- ⑤ 体の記録（唯一の正本）----------
CREATE TABLE IF NOT EXISTS body_measurements (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id        TEXT NOT NULL,
  measured_date      TEXT NOT NULL,                 -- YYYY-MM-DD
  source_raw         TEXT NOT NULL,                 -- 測定元（'inbody' を含めば InBody）
  origin             TEXT NOT NULL CHECK (origin IN ('sheet', 'd1')),
  origin_key         TEXT UNIQUE,                   -- sheet のとき <freeze_id>:<シート名>:<順番>
  sheet_order        INTEGER,
  weight_kg          REAL CHECK (weight_kg IS NULL OR (weight_kg BETWEEN 20 AND 250)),
  body_fat_pct       REAL CHECK (body_fat_pct IS NULL OR (body_fat_pct BETWEEN 3 AND 60)),
  lean_kg            REAL CHECK (lean_kg IS NULL OR (lean_kg BETWEEN 10 AND 150)),
  body_water_l       REAL CHECK (body_water_l IS NULL OR (body_water_l BETWEEN 5 AND 100)),
  visceral_fat       REAL CHECK (visceral_fat IS NULL OR (visceral_fat BETWEEN 1 AND 30)),
  skeletal_muscle_kg REAL CHECK (skeletal_muscle_kg IS NULL OR (skeletal_muscle_kg BETWEEN 5 AND 80)),
  chest_cm           REAL CHECK (chest_cm IS NULL OR (chest_cm BETWEEN 50 AND 180)),
  arm_cm             REAL CHECK (arm_cm IS NULL OR (arm_cm BETWEEN 15 AND 70)),
  waist_cm           REAL CHECK (waist_cm IS NULL OR (waist_cm BETWEEN 40 AND 180)),
  hip_cm             REAL CHECK (hip_cm IS NULL OR (hip_cm BETWEEN 50 AND 180)),
  thigh_cm           REAL CHECK (thigh_cm IS NULL OR (thigh_cm BETWEEN 25 AND 100)),
  entered_by         TEXT,
  client_req_id      TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  deleted_at         INTEGER,
  deleted_by         TEXT,
  rev                INTEGER NOT NULL DEFAULT 1,
  CHECK ((origin = 'sheet' AND origin_key IS NOT NULL AND sheet_order IS NOT NULL) OR origin = 'd1')
);
CREATE INDEX IF NOT EXISTS idx_body_meas_cust ON body_measurements (customer_id, measured_date);

-- ---------- 目標線 ----------
CREATE TABLE IF NOT EXISTS body_goals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id  TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('meal_goal', 'phase')),
  phase_no     INTEGER,
  state        TEXT,
  start_date   TEXT,
  end_date     TEXT,
  start_weight REAL,
  target_weight REAL,
  origin       TEXT NOT NULL CHECK (origin IN ('sheet', 'd1')),
  origin_key   TEXT UNIQUE,
  sheet_order  INTEGER,
  rev          INTEGER NOT NULL DEFAULT 1,
  updated_by   TEXT,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_body_goals_cust ON body_goals (customer_id);

-- ---------- 凍結と写しの状態 ----------
CREATE TABLE IF NOT EXISTS body_freeze (
  freeze_id     TEXT PRIMARY KEY,
  state         TEXT NOT NULL CHECK (state IN ('frozen', 'copying', 'copied', 'verified', 'failed')),
  counts_json   TEXT NOT NULL,      -- {sheet: 行数}
  hashes_json   TEXT NOT NULL,      -- {sheet: ハッシュ}
  copied_json   TEXT,               -- {sheet: 写した位置}
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  note          TEXT
);

-- ---------- /body/write の二重送信を弾く ----------
CREATE TABLE IF NOT EXISTS body_requests (
  channel       TEXT NOT NULL CHECK (channel IN ('line', 'liff', 'gas_inbody', 'karte')),
  client_req_id TEXT NOT NULL,
  payload_hash  TEXT NOT NULL,
  http_status   INTEGER NOT NULL,
  result_code   TEXT NOT NULL,
  result_json   TEXT,
  done_at       INTEGER NOT NULL,
  PRIMARY KEY (channel, client_req_id)
);

-- ---------- 見張り（条件に反したら CHECK 違反で batch 全体を巻き戻す）----------
--   行は1つも入らない（入ろうとした瞬間に違反）。制約の名前で理由を見分ける（設計28 4-5）。
CREATE TABLE IF NOT EXISTS karte_guard (
  rate    INTEGER CONSTRAINT KARTE_GUARD_RATE    CHECK (rate IS NULL),
  target  INTEGER CONSTRAINT KARTE_GUARD_TARGET  CHECK (target IS NULL),
  perm    INTEGER CONSTRAINT KARTE_GUARD_OWNER   CHECK (perm IS NULL),
  consent INTEGER CONSTRAINT KARTE_GUARD_CONSENT CHECK (consent IS NULL),
  rev     INTEGER CONSTRAINT KARTE_GUARD_REV     CHECK (rev IS NULL),
  state   INTEGER CONSTRAINT KARTE_GUARD_STATE   CHECK (state IS NULL),
  ready   INTEGER CONSTRAINT KARTE_GUARD_READY   CHECK (ready IS NULL)
);
