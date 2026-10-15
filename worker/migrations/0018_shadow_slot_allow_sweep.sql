-- 0018 shadow の枠の表を、入口 'sweep' を許す新しい表に替える（2026-10-15）
--
--   ★解く問題
--     設計19で入口 'sweep' を足したが、0015 の remain_shadow_slot に
--     CHECK (entry IN ('boot','compat_member','compat_home')) があり、**枠を取る INSERT が全部弾かれた**。
--     10/15 朝の初回は 41名×3回＝123回 すべて slot_failed、比べ終わった 0名。
--     テストは D1 を身代わりにしていて、本物の表の制約を検査していなかった（関門①②でも見つからなかった）。
--
--   ★消して作り直さない（関門②・Codex）。SQLite は CHECK だけを変えられないが、
--     「新しい表 → 移す → 古い表を消す → 名前を戻す」は、途中で失敗すると表が無い状態で止まり、
--     コピーの後に入った行は静かに消える。D1 の --file がまとめて取り消すかの確証も無い。
--     だから**新しい表を足すだけ**にし、コードの参照先を remain_shadow_slot2 に替える（定数 SLOT_TABLE）。
--     古い表は 10/14 までの記録として残す（消さない）。
--   ★移すのは記録を続けて読むため。古い表は残るので、移しそこねても何も失われない（再実行しても同じ）。
--     移した後〜コードが切り替わるまでの数分に古い表へ入った枠は、新しい表に無い。その日の上限が
--     少し緩むほか、**切り替えた日は「新しい表に無い比較の完了」が数えられて incomplete が負になりうる**
--     （安全側：負なら合格の条件を満たさない）。だから**合格の期間（from）は切り替えた翌日（10/16）から数える**。
--     観測の仕組みなので、顧客に返す値は変わらない。

CREATE TABLE IF NOT EXISTS remain_shadow_slot2 (
  day         TEXT NOT NULL,          -- 'YYYY-MM-DD'（JST）
  customer_id TEXT NOT NULL,
  entry       TEXT NOT NULL,          -- 'boot' | 'compat_member' | 'compat_home' | 'sweep'
  sample_key  TEXT NOT NULL,          -- 'time:00-07' | 'time:08-15' | 'time:16-23'
                                      -- 'ver:<source_version>:<built_version>'
  claimed_at  INTEGER NOT NULL,
  PRIMARY KEY (day, customer_id, entry, sample_key),
  CHECK (entry IN ('boot', 'compat_member', 'compat_home', 'sweep'))
);

INSERT INTO remain_shadow_slot2 (day, customer_id, entry, sample_key, claimed_at)
  SELECT s.day, s.customer_id, s.entry, s.sample_key, s.claimed_at FROM remain_shadow_slot s
   WHERE NOT EXISTS (SELECT 1 FROM remain_shadow_slot2 t
                      WHERE t.day = s.day AND t.customer_id = s.customer_id
                        AND t.entry = s.entry AND t.sample_key = s.sample_key);
