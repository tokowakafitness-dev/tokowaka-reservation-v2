-- 2026-09-28：body_records に synced_at が無く、InBodyの記録を取り込めなかった。
--   取り込み口は全ての表に synced_at を書く。0001 で作り直したときにも入れ忘れていた。
--   （同じ見落としが recurring_patterns でも起きたため、以後は機械で照合する）
ALTER TABLE body_records ADD COLUMN synced_at INTEGER;
