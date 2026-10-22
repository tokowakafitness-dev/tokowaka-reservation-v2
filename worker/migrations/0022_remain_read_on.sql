-- 0022 残数を D1 から顧客に出す（設計21・決定0092）
--
-- remain_d1_allow       D1 から読ませる会員の許可表（段階1は1名）。★会員 ID を公開のリポジトリに書かないため、ここに置く。
--                       足す・外すのは合言葉つきの POST /quota/remain-allow だけ（作業依頼は下4桁）
-- remain_source_daily   選ばれた会員の読み取りの出どころを日×入口×理由で数える（倒れたままを隠さない）。
--                       ★値の CHECK は付けない（2026-10-15、CHECK が新しい値を弾いて sweep が全員失敗した）。
--                         値の集合はコードの定数1か所（worker/src/lib/remain-read-on.js）＋検査で固定する
--                       ★日×入口の合計で 500 まで（1文で原子的に数える）。超えたら '_dropped' を1回だけ

CREATE TABLE IF NOT EXISTS remain_d1_allow (
  customer_id TEXT PRIMARY KEY,
  added_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS remain_source_daily (
  day    TEXT NOT NULL,
  entry  TEXT NOT NULL,
  source TEXT NOT NULL,
  n      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, entry, source)
);
