-- 設計54 S1a：予約の確定を Worker でも判定して比べる（計測だけ・write-shadow）
--   ★新しい表を作るだけ（CREATE … IF NOT EXISTS・既存の表に ALTER しない＝I65 と同じ作法）。
--   ★顧客ID・予約ID・予定ID・氏名・予定名の列を作らない（I84・write-shadow.test.js ④ が列の名前を固定する）。
--     tid（トレーナーID）と時刻は M2 の窓の重なりを数えるために要る。n は送る側が作る8桁の乱数（行の鍵）。
--   ★14日／30日で消す（status の呼び出しのたびに1回50行まで）。

CREATE TABLE IF NOT EXISTS write_shadow_log (
  n          TEXT PRIMARY KEY CHECK (length(n) BETWEEN 6 AND 16),
  day        TEXT NOT NULL,                                   -- JST の yyyy-MM-dd（判定の時刻 t）
  hour       INTEGER NOT NULL CHECK (hour BETWEEN 0 AND 23),
  op         TEXT NOT NULL CHECK (op IN ('reserve','proxy','batch','transfer','change','autobook','recurring','other')),
  gas_ok     INTEGER NOT NULL CHECK (gas_ok IN (0, 1)),
  gas_at     TEXT NOT NULL,
  verdict    TEXT NOT NULL CHECK (verdict IN (
               'match_ok','match_ng',
               'diff_b1','diff_shift','diff_busy','diff_remain','diff_ng_reason',
               'w_stale',
               'u_cal_stale','u_cal_read','u_self_id','u_remain_kind','u_remain_input','u_stale_unsent','u_bad',
               'x_scope','x_f1','x_consec','x_busy','x_too_long')),
  side       TEXT CHECK (side IS NULL OR side IN ('gas_ok_worker_ng','gas_ng_worker_ok')),
  reason     TEXT,                                            -- 固定の語だけ（readCalendar の理由・鮮度の状態）
  tid        TEXT,
  s          INTEGER,
  e          INTEGER,
  t          INTEGER,
  lag_ms     INTEGER,
  cal_age_ms INTEGER,
  d1_ms      INTEGER,
  alloc_ms   INTEGER,
  total_ms   INTEGER,
  drain      TEXT CHECK (drain IS NULL OR drain IN ('AFTER','TICK','JOB')),
  build      TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wsl_day ON write_shadow_log (day);
CREATE INDEX IF NOT EXISTS idx_wsl_tid ON write_shadow_log (tid, s);

-- 送る側（GAS）が報告する数（ロックが取れなかった・書き換えの競合・期限で顧客IDを消した ほか）。日×種類
CREATE TABLE IF NOT EXISTS write_shadow_stat (
  day  TEXT NOT NULL,
  key  TEXT NOT NULL CHECK (key IN ('lock_miss','write_conflict','write_skip','stale','record_fail','cursor_reset','scan_more','too_long','unparsed')),
  n    INTEGER NOT NULL DEFAULT 0 CHECK (n >= 0),
  PRIMARY KEY (day, key)
);

-- M2：直接入れた予定が D1 に届くまでの遅れ（30日で消す）
CREATE TABLE IF NOT EXISTS calendar_arrival_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  day         TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('add','change','remove')),
  cls         TEXT NOT NULL CHECK (cls IN ('break','block','shift')),
  tid         TEXT,
  s           INTEGER,
  e           INTEGER,
  delay_ms    INTEGER,
  window_hits INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cal_arrival_day ON calendar_arrival_log (day);

-- M3：契約の入力が D1 に届くまでの時間（新しくない状態が続いた長さ・30日で消す）
CREATE TABLE IF NOT EXISTS fresh_delay_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  day        TEXT NOT NULL,
  cause      TEXT NOT NULL CHECK (cause IN ('dirty','source')),
  delay_ms   INTEGER NOT NULL CHECK (delay_ms >= 0),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fresh_delay_day ON fresh_delay_log (day);
