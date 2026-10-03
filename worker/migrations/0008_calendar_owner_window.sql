-- 2026-10-03：固定枠の設定（OWNER_SLOT_WINDOW）をD1に持たせる。
--
--   Worker側にこの設定が無かったため、calendar_events から空き枠を計算すると
--   固定枠の持ち主（hidden なトレーナー）の枠が、本来出ない曜日・時間帯にも出てしまう。
--   GAS が /calsync の payload に ownerWindow を乗せ、世代ごとに保存する。
--
--   NULL＝制限なし（設定していない）。'{}'＝どの曜日にもルールが無い＝1枠も出さない。
--   この2つは意味が違うので、既存の世代は NULL のまま（＝現行どおり制限なし）で構わない。
--   次の押し出しで正しい値が入る。
ALTER TABLE calendar_snapshot ADD COLUMN owner_window TEXT;
