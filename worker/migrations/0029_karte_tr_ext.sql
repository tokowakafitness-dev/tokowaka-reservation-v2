-- 設計38：種目の並び・数字の無い種目・補助・無理やり・ドロップ（2026-11-07）
--   ★既存の表に ALTER しない。CREATE … IF NOT EXISTS だけ＝何度流しても同じ結果
--     （worker-deploy.yml は「実行」と「記録」の二操作。記録が失敗しても次の実行でそのまま通る＝F11）
--   ★NOT NULL を付けない列は「印が無い＝NULL」。既定値は入れない（MODEL §8）
--   ★ドロップは karte_tr_sets に置かない（古い読み手が本セットと数えないため）
--   ★書くのは Worker の k_addTraining だけ。読むのは k_training・buildMemberKarte（生きた session の id を通して）
--   ★外部キーは書いてあるが D1 で効いているかは未確認。一致は Worker の見張り（trShape）で守る

CREATE TABLE IF NOT EXISTS karte_tr_exercises (          -- その回の種目の並び（新しい形の回だけ・全種目）
  session_id TEXT NOT NULL REFERENCES karte_tr_sessions(session_id),
  ord        INTEGER NOT NULL CHECK (ord BETWEEN 1 AND 20),
  exercise   TEXT NOT NULL CHECK (length(exercise) BETWEEN 1 AND 50 AND exercise = trim(exercise)),
  done_only  INTEGER CHECK (done_only IS NULL OR done_only = 1),   -- 1＝数字の無い種目（本セット0行）
  PRIMARY KEY (session_id, ord)
);

CREATE TABLE IF NOT EXISTS karte_tr_set_ext (            -- 本セット（karte_tr_sets の行）1つに1行
  --   ★型は INT（INTEGER にしない）。INTEGER PRIMARY KEY は rowid の別名になり、NULL を入れると
  --     エラーにならず新しい番号が振られる＝MAX(set_id) が NULL のとき黙って誤った親を指す（設計38 改訂2・実測）
  set_id      INT NOT NULL PRIMARY KEY REFERENCES karte_tr_sets(set_id),
  session_id  TEXT NOT NULL REFERENCES karte_tr_sessions(session_id),
  ord         INTEGER NOT NULL CHECK (ord BETWEEN 1 AND 20),
  assist_reps INTEGER CHECK (assist_reps IS NULL OR (assist_reps BETWEEN 1 AND 100)),
  forced      INTEGER CHECK (forced IS NULL OR forced = 1)
);
CREATE INDEX IF NOT EXISTS idx_karte_set_ext_session ON karte_tr_set_ext (session_id, ord);

CREATE TABLE IF NOT EXISTS karte_tr_drops (              -- ドロップの段（本セットの続き）
  set_id      INTEGER NOT NULL REFERENCES karte_tr_sets(set_id),   -- 親の本セット（複合主キー＝rowid の別名ではない）
  drop_seq    INTEGER NOT NULL CHECK (drop_seq BETWEEN 1 AND 3),
  weight_kg   REAL NOT NULL CHECK (weight_kg >= 0 AND weight_kg <= 500),
  reps        INTEGER NOT NULL CHECK (reps BETWEEN 1 AND 100),
  assist_reps INTEGER CHECK (assist_reps IS NULL OR (assist_reps BETWEEN 1 AND 100)),
  forced      INTEGER CHECK (forced IS NULL OR forced = 1),
  PRIMARY KEY (set_id, drop_seq)
);
