-- 0034 写しが「書き込みの印」を含んでいるか（設計45・I79）
--
-- ★なぜ要るのか
--   予約・取消の応答の前にあった写しの送信を、応答の後ろ（一回限りトリガー）へ回す（スイッチ LB_EDGE_DEFER）。
--   応答の前には書き込みの印（dirty_seq）だけを送るので、その間 member_home と予約一覧の写しは書き込みより古い。
--   Worker が「写しが印を含むか」を比べて、含まなければ答えない（GAS へ）ために、写しが含む番号を持つ。
--
-- ★列
--   home_covers_seq     その会員の member_home を作るために台帳を読む前に読んだ通し番号（写しと同じ batch で置き換え）
--   resv_covers_seq     その会員の予約一覧の写しについて同じ
--   home_blocked_since  home が閉じた（dirty_seq > home_covers_seq）最初の時刻。開いたら NULL。見張り用
--   resv_blocked_since  resv について同じ
--
-- ★既定値も初期化も入れない（NULL＝閉じる）。
--   「いまは写しと印を同じ batch で送っているから covers＝dirty」は、写しの送信だけ失敗した会員などで嘘になる
--   （設計45 関門① 1周目 中1）。番号つきの押し出しが成功した会員から順に開く。
--   閉じていても答えないだけ（画面は GAS に聞く）＝遅いが正しい。dirty_seq = 0 の会員は開いている。

ALTER TABLE customer_sync_version ADD COLUMN home_covers_seq INTEGER;
ALTER TABLE customer_sync_version ADD COLUMN resv_covers_seq INTEGER;
ALTER TABLE customer_sync_version ADD COLUMN home_blocked_since INTEGER;
ALTER TABLE customer_sync_version ADD COLUMN resv_blocked_since INTEGER;
