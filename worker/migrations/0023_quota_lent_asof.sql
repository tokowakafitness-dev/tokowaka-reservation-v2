-- 0023：翌月に前借りされた回数（lent）と、作った時点の月（as_of_month）を monthly_quota に持つ（2026-10-27・設計22）
--
-- ★既定値を入れない（NULL のまま）。
--   既存の行を 0 で埋めると「まだ作り直していない行」が「前借りなし・今の月で作った」ように見え、
--   読む側の検査をすり抜ける（0012 の coverage と同じ罠）。NULL の行は読む側が答えず写しへ倒す。
--   作り直し（予約ごと・/quota/behind の巡回・作業依頼の全体作り直し）で入る。
ALTER TABLE monthly_quota ADD COLUMN lent INTEGER;
ALTER TABLE monthly_quota ADD COLUMN as_of_month TEXT;
