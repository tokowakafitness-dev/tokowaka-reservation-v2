-- 会員ごとの世代（2026-10-09・段階3-b 手順1／設計 10-stage-3b-read-from-d1.md）
--
--   ★なぜ要るのか
--     3-b で顧客の残数をD1の行から作る。そのとき「この行は、いまの入力から
--     作り直したものか」を判定しなければならない。**いまのD1には比べられる時刻が無い。**
--       monthly_quota.updated_at  … 取消のトリガーで過去に戻る（0009:109）
--       *.synced_at               … 内容が変わった時刻ではない（差分同期は同じ行を書かない）
--       decided_at                … 比べたい対象そのもの
--
--   ★仕組み
--     GASが計算の入力を書き込むたび  source_version を1つ増やす
--     枠と引当を作り直したとき       そのとき読んだ source_version を built_version に書く
--     顧客に答えるのは               source_version === built_version のときだけ
--
--     作り直している最中に入力が来れば source が進み、built が追いつかない＝答えない。
--     答えないときは写し（member_home）へ落とす。止まる側ではなく、古い側に倒れない。

CREATE TABLE IF NOT EXISTS customer_sync_version (
  customer_id     TEXT PRIMARY KEY,
  source_version  INTEGER NOT NULL DEFAULT 0,  -- 入力が書かれた回数
  built_version   INTEGER NOT NULL DEFAULT 0,  -- 作り直しが取り込んだ source_version
  source_at       INTEGER,                     -- 最後に入力が書かれた時刻（ミリ秒）
  built_at        INTEGER,                     -- 最後に作り直した時刻（ミリ秒）
  updated_at      INTEGER
);

-- 遅れている会員を一覧するための索引（source > built の行を探す）
CREATE INDEX IF NOT EXISTS idx_csv_stale ON customer_sync_version (source_version, built_version);
