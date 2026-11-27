-- 設計67：数字の無い種目（実施のみ）のメモ（2026-11-26）
--   ★既存の表に ALTER しない。CREATE … IF NOT EXISTS だけ＝何度流しても同じ結果（0029 と同じ）
--   ★数字の無い種目（karte_tr_exercises.done_only = 1）だけに付く。数字のある種目のメモはセットのメモ（karte_tr_sets.note・設計66）
--   ★書くのは Worker の trainingRows だけ（k_addTraining・k_editTraining・k_importDay）。読むのは k_training（生きた session の id を通して）
--   ★会員のカルテ（member-karte.js）は読まない（I-M3）
--   ★外部キーは書いてあるが D1 で効いているかは未確認。一致は Worker の見張り（trShape の n_notes・note_without_done_only）で守る
CREATE TABLE IF NOT EXISTS karte_tr_ex_notes (
  session_id TEXT NOT NULL,
  ord        INTEGER NOT NULL CHECK (ord BETWEEN 1 AND 20),
  note       TEXT NOT NULL CHECK (length(note) BETWEEN 1 AND 200 AND note = trim(note)),
  PRIMARY KEY (session_id, ord),
  FOREIGN KEY (session_id, ord) REFERENCES karte_tr_exercises(session_id, ord)
);
