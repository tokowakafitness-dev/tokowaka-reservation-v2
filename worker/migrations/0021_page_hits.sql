-- LP到達とCTAクリックを1時間ごとに数える（2026-10-22）
--
-- なぜ必要か：即日で見えるのは応募台帳の受付日時（分子）だけで、
-- 「何人がLPに来たか」（分母）が無い。GA4は翌日まで出ず、件数が少ないと
-- しきい値で隠れるので即日の配信判断に使えない。
--
-- ★個人を一切記録しない。件数だけ。識別子・IP・UA・参照元は入れない。
-- ★表を2つに分ける理由（関門② 2026-10-22）：
--   上限の判定を「1時間ぶんを合計する」形にすると、上限に当たったあとも
--   リクエストのたびに最大60行を読むことになる。認証なしの口なので、
--   攻撃で読み取り枠（5M/日）を使い切られ、**予約系の読み取りが止まる**。
--   合計を1行で持てば、判定は主キー1行の読みで済む。
CREATE TABLE IF NOT EXISTS page_hits_hour (
  hour_key TEXT PRIMARY KEY,   -- 'YYYY-MM-DDTHH'（JST・サーバが決める）
  hits     INTEGER NOT NULL    -- その時間に数えた合計。上限の門番はこの1行だけを見る
);

CREATE TABLE IF NOT EXISTS page_hits (
  hour_key TEXT NOT NULL,
  page     TEXT NOT NULL,      -- 'lp' / 'cta:hero' など（許可一覧）
  campaign TEXT NOT NULL,      -- 許可一覧。未知は 'other'
  content  TEXT NOT NULL,      -- cr1〜cr999 と決まった名前だけ。未知は 'other'
  hits     INTEGER NOT NULL,
  PRIMARY KEY (hour_key, page, campaign, content)
);
