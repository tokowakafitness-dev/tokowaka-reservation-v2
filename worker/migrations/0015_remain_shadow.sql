-- 0015 shadow（写しとD1を比べて食い違いを数える）
--   設計：ops/design/12-shadow-compare.md（第5版・関門①通過）
--
--   ★3つの表には役割がある。混ぜてはいけない。
--       remain_shadow_slot    ** 排他の鍵 **（1日に何回比べるかを原子的に決める）
--       remain_shadow         日次の集計（食い違った鍵・終わった回数・弾いた理由）
--       remain_shadow_sample  値の組ごとの標本（原因を追うため）

-- ============================================================
-- 1. 比較枠（★これが attempted の実体）
-- ============================================================
--   ★なぜ別の表なのか
--     集計の数（_completed 等）と排他の鍵を同じ行に押し込むと、
--     「時間帯の枠」と「世代の枠」がどちらの意味か分からなくなる。
--
--   ★なぜ _attempted を集計表に書かないのか
--     枠を取ってから結果を書くまでの間に処理が消えると（isolate の終了・D1の障害）、
--     枠だけ増えて結果が何も残らない。_attempted を別に書いていると
--     incomplete = 0 − 0 − 0 = 0 になり、**いちばん検知したい状態が静かに消える。**
--     この表の COUNT(*) を attempted とすれば、枠を取った瞬間が必ず残る。
CREATE TABLE IF NOT EXISTS remain_shadow_slot (
  day         TEXT NOT NULL,          -- 'YYYY-MM-DD'（JST）
  customer_id TEXT NOT NULL,
  entry       TEXT NOT NULL,          -- 'boot' | 'compat_member' | 'compat_home'
  sample_key  TEXT NOT NULL,          -- 'time:00-07' | 'time:08-15' | 'time:16-23'
                                      -- 'ver:<source_version>:<built_version>'
  claimed_at  INTEGER NOT NULL,
  PRIMARY KEY (day, customer_id, entry, sample_key),
  CHECK (entry IN ('boot', 'compat_member', 'compat_home'))
);

-- ============================================================
-- 2. 日次の集計
-- ============================================================
CREATE TABLE IF NOT EXISTS remain_shadow (
  day         TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  entry       TEXT NOT NULL,          -- ★入口だけ。枠の鍵は入れない
  field       TEXT NOT NULL,          -- 食い違った鍵の名前、または
                                      --   '_completed' / '_failed'
                                      --   '_pre:<理由>'  枠を取る前に弾いた
                                      --   '_post:<理由>' 枠を取ったあとに弾いた
                                      --   '_one_sided'   片方だけが答えた
                                      --   '_age:<帯>'    写しの鮮度の分布
  first_value TEXT,                   -- 写しとD1の値の組（最初に見たもの）
  last_value  TEXT,                   -- 同じ（最後に見たもの）
  n           INTEGER NOT NULL DEFAULT 0,
  first_at    INTEGER NOT NULL,
  last_at     INTEGER NOT NULL,
  PRIMARY KEY (day, customer_id, entry, field)
);

-- ============================================================
-- 3. 値の組ごとの標本
-- ============================================================
--   ★同じ組は指紋（fp）で原子的に弾く。前回の値を読んでから書く形にしない
--     （読む→書く の間で競合して重複する）。
--     揺れの順序は失うが、この規模では組の種類が分かれば足りる。
CREATE TABLE IF NOT EXISTS remain_shadow_sample (
  day              TEXT NOT NULL,
  customer_id      TEXT NOT NULL,
  entry            TEXT NOT NULL,
  field            TEXT NOT NULL,
  fp               TEXT NOT NULL,     -- 正規化した「写しの値＋D1の値」の指紋
  requested_month  TEXT,              -- 求められた月
  copy_month       TEXT,              -- 写しが返した月
  d1_month         TEXT,              -- D1が計算した月
  copy_computed_at INTEGER,           -- 写しの計算時刻
  source_version   INTEGER,
  built_version    INTEGER,
  d1_status        TEXT,              -- 'ok' / 'not_built' / 'behind' / … 
  copy_value       TEXT,
  d1_value         TEXT,
  at               INTEGER NOT NULL,
  PRIMARY KEY (day, customer_id, entry, field, fp)
);

CREATE INDEX IF NOT EXISTS idx_shadow_day ON remain_shadow (day, field);
CREATE INDEX IF NOT EXISTS idx_shadow_sample_day ON remain_shadow_sample (day, field);
