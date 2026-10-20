-- 0020 書き込みの通し番号で「作り直しが追いついたか」を判定する（設計20・決定0091）
--
-- ★なぜ要るのか
--   書き込みの直後、写し（member_home）はその場で新しくなるが、D1 の枠・引当は後追い（1秒〜15分）で作り直す。
--   その間、D1 は古いのに source_version === built_version のまま＝「新しい」と名乗れた。
--   さらに、走っている後追い処理が古い台帳で作り直すと、その後も名乗り続けた（10/18 の食い違い）。
--
-- ★列
--   dirty_seq        この会員に書き込みがあった最新の通し番号（GAS の LB_DW_SEQ）。写しの送信と同じ batch で MAX 更新
--   built_covers_seq /quota/rebuild が作り直したとき、その台帳を読む前に読んだ通し番号。ほかの作り直しは変えない
--   dirty_since      built_covers_seq >= dirty_seq から外れた最初の時刻（追いついたら NULL）。取り残しを数える
--
-- ★新しいと名乗る条件（worker/src/lib/fresh.js の1か所だけで定義する）
--   source_version = built_version AND built_version > 0 AND built_covers_seq >= dirty_seq
--
-- ★既定値 0 / 0 ＝ 判定はいまと同じ（後方互換）。GAS が番号を送り始めるまで何も変わらない

ALTER TABLE customer_sync_version ADD COLUMN dirty_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE customer_sync_version ADD COLUMN built_covers_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE customer_sync_version ADD COLUMN dirty_since INTEGER;
