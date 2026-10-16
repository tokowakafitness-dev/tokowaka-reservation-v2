-- メールのリンクが踏まれたことを1人ずつ記録する（2026-10-16）
--
-- なぜ必要か：選考通過メールのリンクは5通とも同じURLで、
-- 「8回踏まれた」としか分からなかった。誰が踏んで誰が踏んでいないかが
-- 区別できず、未予約の方へ送るべき文面を決められなかった。
--
-- ★ここに個人を特定できる値は入れない。token は意味を持たない乱数で、
--   誰のものかは応募台帳（Google側）でしか分からない。
--
-- ★1 token = 1行。クリックのたびに行を増やさない（関門②の指摘1）。
--   この口は認証なしで公開するため、行が無制限に増えると
--   D1の書き込み上限を使い切られ、**予約系の書き込みが止まる**。
CREATE TABLE IF NOT EXISTS mail_clicks (
  token     TEXT PRIMARY KEY,       -- 受信者ごとの乱数。氏名・メール・応募IDは入れない
  kind      TEXT NOT NULL,          -- 何のメールか（許可一覧で縛る）
  first_at  INTEGER NOT NULL,       -- 最初に踏んだ時刻（epoch ミリ秒）
  last_at   INTEGER NOT NULL,       -- 最後に踏んだ時刻
  times     INTEGER NOT NULL        -- 踏んだ回数
);

CREATE INDEX IF NOT EXISTS idx_mail_clicks_first ON mail_clicks(first_at);
