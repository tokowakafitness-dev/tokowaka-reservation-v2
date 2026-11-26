-- 設計62 段2：過去のまとめ（期間のブロック・会員に複数）・2026-11-26
--   ★CREATE … IF NOT EXISTS だけ（既存の表に ALTER しない＝途中で失敗しても次の実行で同じファイルがそのまま通る・I65 と同じ考え方）
--   ★まとめは表示の層。原本（日ごとの記録・社内メモ）を置き換えない。消しても直しても原本は変わらない（設計62 P0）
--   ★会員の応答・k_summary には出さない（I-M3）。健康の記述は入れない（I55・取り込みは体の注意の節を入れない）
CREATE TABLE IF NOT EXISTS karte_history_digest (
  digest_id   TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  period_from TEXT NOT NULL CHECK (length(period_from) = 7 AND period_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND substr(period_from, 6, 2) BETWEEN '01' AND '12'),
  period_to   TEXT NOT NULL CHECK (length(period_to) = 7 AND period_to GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND substr(period_to, 6, 2) BETWEEN '01' AND '12'),
  body        TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  origin      TEXT NOT NULL CHECK (origin IN ('import', 'trainer')),
  rev         INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_by  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER,
  CHECK (period_from <= period_to)
);
CREATE INDEX IF NOT EXISTS idx_karte_history_cust ON karte_history_digest (customer_id, period_to);
