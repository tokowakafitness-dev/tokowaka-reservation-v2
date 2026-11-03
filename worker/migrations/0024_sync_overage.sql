-- 設計27：支払い待ちの件数を世代の行に持たせる（2026-11-03）
--   月額の枠の行にしか持っていなかったため、チケットだけの会員は D1 で常に 0 になっていた。
--   形：{"asOf":"YYYY-MM","m":{"YYYY-MM":n,...}}（作った範囲の全月を0も含めて）。
--   NULL ＝ 新しい作り直しを通っていない／競合で倒した ＝ 読む側は答えない。
ALTER TABLE customer_sync_version ADD COLUMN built_overage_json TEXT;

-- 作り直しのたびに必ず1つ進む番号（設計27 関門②）。
--   同じ世代のまま作り直されても（計算には今の時刻も入る）、読む前後でこれが違えば答えない。
ALTER TABLE customer_sync_version ADD COLUMN built_rev INTEGER NOT NULL DEFAULT 0;
