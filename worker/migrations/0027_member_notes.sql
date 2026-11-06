-- 設計35 会員画面 C2：会員に見せる文（トレーナーが書く）・2026-11-06
--   ★社内の指導メモ（karte_notes）とは別の表。会員の画面（c_myKarte）が読むのはこちらだけ（I-M4）
--   ★トレーニング1回（session）に1枚。トレーニングを付けない日は session_id = NULL（改訂1-3）
--   ★req_id 列は持たない。冪等の正本は karte_requests の (trainer_id, action, client_req_id)（改訂2-5）
--   ★枚の顧客・日付と参照先の session の一致は、書く batch の中の見張り（karte_guard）で守る（改訂2-4）。
--     トリガーは使わない（トリガーは引当の4本だけ＝MODEL §2-4）
--   中身の検査の正本は Worker（前後の空白・空要素・件数・字数）。ここでは字数・件数・JSON の形だけを二重に守る

CREATE TABLE IF NOT EXISTS karte_member_notes (
  mnote_id          TEXT PRIMARY KEY,                -- Worker が作る
  customer_id       TEXT NOT NULL,
  session_id        TEXT REFERENCES karte_tr_sessions(session_id),
  session_date      TEXT NOT NULL,                   -- YYYY-MM-DD
  message           TEXT CHECK (message IS NULL OR (length(message) BETWEEN 1 AND 400)),
  todo_json         TEXT CHECK (todo_json IS NULL OR (json_valid(todo_json) AND json_type(todo_json) = 'array'
                                                      AND json_array_length(todo_json) BETWEEN 1 AND 3)),
  tags_json         TEXT CHECK (tags_json IS NULL OR (json_valid(tags_json) AND json_type(tags_json) = 'array'
                                                      AND json_array_length(tags_json) BETWEEN 1 AND 6)),
  author_trainer_id TEXT NOT NULL,
  rev               INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  updated_by        TEXT,
  deleted_at        INTEGER,
  deleted_by        TEXT
);
-- 生きた枚は1つの session に1枚だけ（消した後は同じ session に作り直せる）
CREATE UNIQUE INDEX IF NOT EXISTS uq_karte_mnote_session
  ON karte_member_notes (session_id) WHERE session_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_karte_mnote_cust ON karte_member_notes (customer_id, session_date);
