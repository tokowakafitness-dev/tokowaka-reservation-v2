-- 設計62 段3（改訂8 §16-1）：過去メモの【体の注意】を日付つきで残す（健康情報の同意のある会員だけ）・2026-11-26
--   ★CREATE … IF NOT EXISTS だけ（既存の表に ALTER しない）
--   ★健康情報（I48）：書くのは k_importDay の health だけ（同意の見張りと書く文の両方に条件）・読むのは k_safety の同意の JOIN の中だけ
--     撤回（k_saveConsent・m_saveConsent）は同じ batch で行ごと消す。deleted_at・rev を持たない＝消したら中身は残らない（控えにも写さない）
--   ★会員の応答・k_summary には出さない（I-M3）
CREATE TABLE IF NOT EXISTS karte_health_notes (
  hnote_id    TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  note_date   TEXT NOT NULL CHECK (length(note_date) = 10 AND note_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  body        TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  origin      TEXT NOT NULL CHECK (origin IN ('import')),
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_karte_health_notes_cust ON karte_health_notes (customer_id, note_date);
