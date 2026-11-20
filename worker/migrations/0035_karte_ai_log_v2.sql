-- 設計49（2026-11-20）：AI の下書き v2 の計測（別表）
--   ★新しい表を作るだけ（CREATE … IF NOT EXISTS・既存の表に ALTER しない＝途中で失敗しても・適用済みの印だけ書けなくても、次の実行でそのまま通る）
--   ★中身（文字起こし・AI の文）・customer_id を入れる列は持たない（I76-3）。監査は karte_access_log
--   ★v1・v2 とも1回ごとの基本の記録は今の karte_ai_log（12列のまま）。この表は v2 の呼び出しのときだけ1行足す（best effort）
CREATE TABLE IF NOT EXISTS karte_ai_log_v2 (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  at              INTEGER NOT NULL,
  result          TEXT NOT NULL,
  effort          TEXT,
  client_req_id   TEXT,
  ms              INTEGER,
  n_sets          INTEGER,
  n_inferred      INTEGER,
  n_nobasis       INTEGER,
  n_health_hidden INTEGER,
  n_unclear       INTEGER,
  n_summary       INTEGER,
  stream_events   INTEGER,
  stream_bytes    INTEGER,
  build           TEXT
);
CREATE INDEX IF NOT EXISTS idx_karte_ai_log_v2_at ON karte_ai_log_v2 (at);
