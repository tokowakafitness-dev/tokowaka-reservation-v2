-- 2026-09-29：残数計算をWorkerへ移すための「入力の写し」を追加する。
--   契約と予約は列に変換せず、行のまま持つ。GASとWorkerで同じ関数に同じ形を渡すため。
CREATE TABLE IF NOT EXISTS calc_contract_rows (
  row_key      TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL,
  idx          INTEGER NOT NULL,
  row_json     TEXT NOT NULL,
  start_ms     INTEGER,
  end_ms       INTEGER,
  synced_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ccr_cust ON calc_contract_rows(customer_id, idx);

CREATE TABLE IF NOT EXISTS calc_reservation_rows (
  row_key      TEXT PRIMARY KEY,
  customer_id  TEXT,
  row_json     TEXT NOT NULL,
  synced_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_crr_cust ON calc_reservation_rows(customer_id);

CREATE TABLE IF NOT EXISTS member_opening (
  customer_id  TEXT PRIMARY KEY,
  payload      TEXT NOT NULL,
  synced_at    INTEGER
);

CREATE TABLE IF NOT EXISTS calc_meta (
  key          TEXT PRIMARY KEY,
  payload      TEXT NOT NULL,
  synced_at    INTEGER
);
