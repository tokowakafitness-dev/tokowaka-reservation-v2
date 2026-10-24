-- 到達の計測に「獲得元」を足し、フォーム到達も数える（2026-10-24）
--
-- なぜ作り直すか：page_hits の主キーは (hour_key,page,campaign,content) で、
-- あとから source を足しても主キーに入らず、別の獲得元が同じ行に混ざってしまう。
-- SQLite は主キーを変えられないので、新しい表にする。
--
-- 古い表（10/22〜10/24の記録）は page_hits_v1 として残す。読み出しには使わない。
ALTER TABLE page_hits RENAME TO page_hits_v1;

CREATE TABLE IF NOT EXISTS page_hits (
  hour_key TEXT NOT NULL,     -- 'YYYY-MM-DDTHH'（JST・サーバが決める）
  page     TEXT NOT NULL,     -- 'lp' / 'apply' / 'cta:hero' など（許可一覧）
  source   TEXT NOT NULL,     -- utm_source（紹介ならトレーナー）。許可形のみ
  campaign TEXT NOT NULL,     -- utm_campaign。許可一覧
  content  TEXT NOT NULL,     -- utm_content（広告CR・貼り先）
  hits     INTEGER NOT NULL,
  PRIMARY KEY (hour_key, page, source, campaign, content)
);
