-- 2026-09-28：写しの表から外部キー制約を外す
--   元データ（スプレッドシート）に歯抜けがあると、顧客・予約・固定枠が
--   まるごと取り込めなくなっていた（HTTP 500 / error 1101）。
--   第1段階のD1は写しなので、整合は元データ側で正す。ここでは弾かない。
--
--   SQLiteは制約だけを外せないため、作り直して中身を移す。
--   何度流しても中身が失われない書き方にしてある。

PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS customers_nofk (
  customer_id        TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  kana               TEXT,
  phone              TEXT,
  email              TEXT,
  birthday           TEXT,
  line_user_id       TEXT UNIQUE,
  default_trainer_id TEXT,
  contract_status    TEXT,
  lang               TEXT DEFAULT 'ja',
  goal               TEXT,
  note               TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  synced_at          INTEGER
);
INSERT OR IGNORE INTO customers_nofk SELECT * FROM customers;
DROP TABLE customers;
ALTER TABLE customers_nofk RENAME TO customers;

CREATE TABLE IF NOT EXISTS reservations_nofk (
  reservation_id     TEXT PRIMARY KEY,
  customer_id        TEXT,
  customer_name      TEXT,
  trainer_id         TEXT NOT NULL,
  start_at           INTEGER NOT NULL,
  end_at             INTEGER NOT NULL,
  kind               TEXT NOT NULL,
  attendee_count     INTEGER NOT NULL DEFAULT 1,
  status             TEXT NOT NULL DEFAULT 'booked',
  consumption_kind   TEXT,
  consumption_month  TEXT,
  consumption_contract_id TEXT,
  calendar_event_id  TEXT,
  channel            TEXT,
  created_by         TEXT,
  created_at         INTEGER NOT NULL,
  cancelled_at       INTEGER,
  synced_at          INTEGER
);
INSERT OR IGNORE INTO reservations_nofk SELECT * FROM reservations;
DROP TABLE reservations;
ALTER TABLE reservations_nofk RENAME TO reservations;

CREATE TABLE IF NOT EXISTS recurring_nofk (
  pattern_id   TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL,
  trainer_id   TEXT NOT NULL,
  weekday      INTEGER NOT NULL,
  time         TEXT NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  synced_at    INTEGER
);
INSERT OR IGNORE INTO recurring_nofk SELECT * FROM recurring_patterns;
DROP TABLE recurring_patterns;
ALTER TABLE recurring_nofk RENAME TO recurring_patterns;

CREATE TABLE IF NOT EXISTS contracts_nofk (
  contract_id    TEXT PRIMARY KEY,
  customer_id    TEXT NOT NULL,
  course         TEXT NOT NULL,
  mode           TEXT NOT NULL,
  freq           INTEGER,
  tickets        INTEGER,
  unit_price     INTEGER NOT NULL,
  monthly_price  INTEGER,
  pair           INTEGER NOT NULL DEFAULT 0,
  rental         INTEGER NOT NULL DEFAULT 0,
  start_date     TEXT NOT NULL,
  end_date       TEXT NOT NULL,
  carry_cap      INTEGER,
  trainer_id     TEXT,
  reward_rate    INTEGER NOT NULL DEFAULT 35,
  join_fee       INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'active',
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  approved_by    TEXT,
  approved_at    INTEGER,
  source         TEXT NOT NULL DEFAULT 'console',
  sheet_row      INTEGER,
  synced_at      INTEGER
);
INSERT OR IGNORE INTO contracts_nofk SELECT * FROM contracts;
DROP TABLE contracts;
ALTER TABLE contracts_nofk RENAME TO contracts;

CREATE TABLE IF NOT EXISTS body_nofk (
  record_id     TEXT PRIMARY KEY,
  customer_id   TEXT NOT NULL,
  measured_at   INTEGER NOT NULL,
  weight_kg     REAL,
  body_fat_pct  REAL,
  muscle_kg     REAL,
  note          TEXT,
  created_at    INTEGER NOT NULL
);
INSERT OR IGNORE INTO body_nofk SELECT * FROM body_records;
DROP TABLE body_records;
ALTER TABLE body_nofk RENAME TO body_records;
