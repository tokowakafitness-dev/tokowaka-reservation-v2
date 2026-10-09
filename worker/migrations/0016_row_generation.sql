-- 0016 枠とチケットの行に「作った世代」を持たせる（2026-10-09）
--   設計：ops/design/13-stale-rows.md（第4版・関門①を4回目で通過）
--
--   ★解く問題
--     枠（monthly_quota）とチケット（ticket_packs）は UPSERT だけで書いており、
--     **いまの計算から消えた行を消していない**（引当は「消してから入れる」になっている）。
--     契約を変えてチケットの行が消えると古いパックが残り、読み取りをD1へ向けたとき
--     hasTicket / ticketTotal / ticketExpireMs / ticketRemaining / type が全部誤る。
--     type が誤ると、月額だけの会員に**チケットの案内が出る**（顧客に見える）。
--
--   ★なぜ「消す」のではなく「読まない」のか
--     消すには3つの危険を同時に踏む。
--       ① used はトリガーだけが触る（0009 の不変条件）。消して入れ直すと 0 に戻る
--       ② 引当から外部キーで参照されている
--       ③ 引当の削除範囲は連続していない（recordsFrom〜fromMonth の間は残る）
--     「読まない」なら、そのどれにも触らない。間違えても古い行が読まれないだけ。

ALTER TABLE monthly_quota ADD COLUMN built_version INTEGER;
ALTER TABLE ticket_packs  ADD COLUMN built_version INTEGER;

--   ★行数を世代と一緒に持つ。**2つに分ける。**
--     1つの合計にすると「枠が1行足りず、パックが1行多い」が打ち消し合って通る。
--
--   ★なぜ行数が要るのか（第1版の重大な誤り）
--     「世代を書き忘れた行は読まれない＝写しへ落ちる」は**成立しない**。
--     読む側は、枠0行・パック0行でも「契約が無い会員」として正常に答える。
--     ＝書き忘れると**月額会員の画面から残数が消える**。間違った側に倒れる。
--     読めた行数がこれと一致しないときだけ「答えない」にすれば、本当に安全側へ倒れる。
ALTER TABLE customer_sync_version ADD COLUMN built_quota_rows INTEGER;
ALTER TABLE customer_sync_version ADD COLUMN built_pack_rows  INTEGER;

--   ★「どの範囲で作ったか」も保存する（2026-10-09・関門②の指摘）。
--     照合（quota-verify）で主キーの集合を突き合わせるには、
--     **作り直しと同じ範囲**を知らなければならない。
--     範囲は会員ごと・実行ごとに違う：
--       全員ぶんの作り直し … 当月〜翌月（既定）
--       二重書きの会員1人 … recordsFrom 〜 当月+2か月（または最も先の予約月）
--     保存しないと、照合側が範囲を**推測するしかなく**、
--     正しいD1の行を「欠けている／余っている」と誤って判定する。
ALTER TABLE customer_sync_version ADD COLUMN built_from_month TEXT;
ALTER TABLE customer_sync_version ADD COLUMN built_to_month   TEXT;

--   世代で絞って読むための索引（いまは (customer_id, valid_to) だけ）
CREATE INDEX IF NOT EXISTS idx_packs_built ON ticket_packs (customer_id, built_version);
CREATE INDEX IF NOT EXISTS idx_quota_built ON monthly_quota (customer_id, built_version);
