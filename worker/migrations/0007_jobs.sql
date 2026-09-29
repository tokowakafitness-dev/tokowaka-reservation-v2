-- 2026-09-29：開発中の点検を、オーナーの手を借りずに実行するための受け渡し表。
CREATE TABLE IF NOT EXISTS jobs (
  request_id   TEXT PRIMARY KEY,
  op           TEXT NOT NULL,
  args         TEXT,
  status       TEXT NOT NULL,
  enqueued_at  INTEGER NOT NULL,
  claimed_at   INTEGER,
  finished_at  INTEGER,
  result       TEXT,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, enqueued_at);
