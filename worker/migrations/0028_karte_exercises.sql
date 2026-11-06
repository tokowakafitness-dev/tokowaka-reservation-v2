-- 種目の一覧（全トレーナー・全顧客で共有）と部位の分類・2026-11-06
--   ★書くのは Worker の k_saveExercise だけ（追加・部位の変更）。読むのは k_exercises
--   ★part の鍵は worker/src/lib/karte-exercises.js の EXERCISE_PARTS と同じ（検査で一致を確かめる）
--   ★name は前後の空白を落とした 1〜50字（Worker で正規化してから入れる。ここでは字数だけを二重に守る）
--   ★既存の karte_tr_sets.exercise（自由文）は変えない。表に無い名前は k_exercises が part=null で返す
--   ★種目名は健康の言葉を書く場所ではない（I55）

CREATE TABLE IF NOT EXISTS karte_exercises (
  name       TEXT PRIMARY KEY CHECK (length(name) BETWEEN 1 AND 50 AND name = trim(name)),
  part       TEXT NOT NULL CHECK (part IN ('chest', 'legs', 'back', 'shoulder', 'arm', 'core', 'other')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_by TEXT,
  updated_at INTEGER,
  deleted_at INTEGER
);
