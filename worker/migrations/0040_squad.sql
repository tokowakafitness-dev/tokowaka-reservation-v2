-- 保全部隊が予約システムの要約を読む口（会社の設計 maintenance-squad-read-endpoint.md・決定0208・2026-11-27）
--   ★CREATE … IF NOT EXISTS だけ＝何度流しても同じ結果。既存の表に触れない
--   ★入るのは許可リストで組み直した要約だけ（氏名・会員番号・自由文は入らない・I-SQ1）
--   書く：/squad/digest（GAS・合言葉）・/squad/status の加算（部隊の鍵が合った後だけ）・/squad/report（部隊・SQUAD_REPORT=on のときだけ）
--   読む：/squad/status（部隊）・/quota/status?squad=1（GAS の日次点検・squad_quiet）

-- 要約（digest）と心拍（beat）を1種類1行で上書きする。履歴は持たない
CREATE TABLE IF NOT EXISTS squad_digest (
  kind        TEXT PRIMARY KEY CHECK (kind IN ('digest', 'beat')),
  received_at INTEGER NOT NULL,             -- Worker の時計（ms）。古さの判定に使う。丸めない
  snap_at     INTEGER NOT NULL,             -- GAS が印を読んだ時刻（ms）。要約と心拍の新旧はこれで比べる
  check_id    INTEGER,                      -- digest のみ。前進のみ（I-SQ7）
  gas_build   TEXT,
  body        TEXT NOT NULL,                -- 組み直した JSON（固定のキー順）。受け取った文字列をそのまま置かない
  rejected    INTEGER NOT NULL DEFAULT 0    -- 拒否した要求の数（理由は分けない）
);

-- 部隊が読んだ回数（鍵が合った読み取りだけ・JST の日付ごと）。上限 200 は条件付き UPSERT で原子的に（I-SQ4）
CREATE TABLE IF NOT EXISTS squad_reads (
  day          TEXT PRIMARY KEY,
  n            INTEGER NOT NULL,
  last_read_at INTEGER
);

-- 部隊の報告（④・最新の1件だけ）。GAS が心拍の応答で受け取り、固定の文でオーナーへ LINE（失敗ならメール）
CREATE TABLE IF NOT EXISTS squad_report (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  run_id      INTEGER NOT NULL,             -- 部隊の起動の時刻（ms）＝報告の番号
  body        TEXT NOT NULL,                -- 組み直した JSON（列挙と件数だけ）
  received_at INTEGER NOT NULL,
  handed_at   INTEGER,                      -- GAS に渡した時刻
  hand_n      INTEGER NOT NULL DEFAULT 0,   -- 渡した回数（ack が無いまま2時間たてば渡し直す・3回まで＝関門② 中1）
  ack_at      INTEGER,
  ack_code    TEXT CHECK (ack_code IS NULL OR ack_code IN ('line_ok', 'mail_ok', 'failed')),
  day         TEXT NOT NULL,                -- JST の日付（1日の上限を数える）
  n_today     INTEGER NOT NULL
);
