-- 録音の文字起こしの AI 下書き（設計39・I76）・2026-11-12
--   ★新しい表を作るだけ（CREATE … IF NOT EXISTS・既存の表に ALTER しない＝途中で失敗しても次の実行でそのまま通る）
--   ★中身（文字起こし・AI の出力）を入れる列は持たない。customer_id も持たない（監査は karte_access_log）

-- 1日（JST）の呼び出しの回数・店全体。API を呼ぶ前に1文で数える（n < 上限 のときだけ +1・changes=1 が成功）
CREATE TABLE IF NOT EXISTS karte_ai_usage (
  day TEXT PRIMARY KEY,
  n   INTEGER NOT NULL
);

-- 1回ごとの記録（失敗も）。回数・時間・文字数・トークン数・モデル・結果・版の印だけ
CREATE TABLE IF NOT EXISTS karte_ai_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           INTEGER NOT NULL,
  trainer_id   TEXT,
  model        TEXT,
  chars_in     INTEGER,
  ms           INTEGER,
  result       TEXT NOT NULL CHECK (result IN ('ok', 'off', 'no_key', 'too_long', 'bad_request', 'not_found', 'daily_limit',
                                               'unavailable', 'timeout', 'http_error', 'refused', 'truncated', 'bad_output', 'error')),
  in_tokens    INTEGER,
  out_tokens   INTEGER,
  n_ex         INTEGER,
  n_unverified INTEGER,
  build        TEXT
);
CREATE INDEX IF NOT EXISTS idx_karte_ai_log_at ON karte_ai_log (at);
