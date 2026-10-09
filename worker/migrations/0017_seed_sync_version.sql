-- 0017 世代の初期値を入れる（2026-10-09）
--
--   ★解く問題
--     0014 で customer_sync_version を足したが、**行が1つも無い**。
--     世代が進むのは ingest が「実際に書いた行」の会員ぶんだけ（設計11）。
--     ところが押し出しは差分同期で、**変わっていない行は書かない**。
--       実測：契約88件中0件を書込（88件は変更なし）／予約285件中0件を書込
--     ＝入力を押し直しても source_version は 0 のまま。
--     作り直しは「いまの source ＝ 自分が読んだ世代」のときだけ印を進めるので、
--     source が 0 なら built も 0 ＝ **永久に「まだ作り直していない」**。
--     照合は全員を飛ばす（VERSION_NOT_BUILT 40名・2026-10-09 に実測）。
--
--   ★なぜ 1 を入れてよいのか
--     「入力が1回押されている」は**事実**（計算入力の行がD1に88件ある）。
--     嘘を書いていない。built_version は 0 のまま＝「まだ作り直していない」も事実。
--     次の作り直しで built=1 になり、source と一致して初めて答えられるようになる。
--
--   ★なぜ既定値ではなく明示の初期化なのか
--     列の既定値にすると、将来新しく入る会員も自動で 1 になる。
--     それでは「入力が押されたか」を表さなくなる。ここは**一度だけの初期化**。
--
--   ★対象は「計算入力の契約行がある会員」だけ。
--     行が無い会員に入れると、作り直しの対象でないのに「追いついている」ことになる。
--
--   ★基準として信用できる根拠（2026-10-09 の実測）
--     計算入力は D1 に 契約88件・予約285件・棚卸し39件。
--     照合の「D1にだけ残った行」は 枠0・チケット0・引当0 ＝**取り残しが無い**。
--     だから「いまのD1の計算入力」を基準世代1として採ってよい。
--   ★1 の意味は「押された回数」ではなく、**世代管理を入れたときの基準**。
--
--   ★seed の直後は必ず source=1 / built=0 ＝ **答えない**（built > 0 が要る）。
--     顧客に古い値を出す方向には一切動かない。

--   ★★DO NOTHING では解決しない（2026-10-09・Codex の指摘）。
--     **最初の作り直しが、すでに 0/0 の行を作っている。**
--     作り直しは行が無ければ 0/0 を読み、markBuiltStatement の VALUES が
--     そのまま INSERT される（CONFLICT 側に行かない）。
--     実測の証拠：照合の理由が VERSION_NO_ROW ではなく **VERSION_NOT_BUILT**
--     （= 行は在るが built が 0）だった。目の前に証拠があったのに見落とした。
--   → 0/0 の行だけを 1/0 に直す。すでに世代が動いている行には触らない。

INSERT INTO customer_sync_version
  (customer_id, source_version, built_version, source_at, updated_at)
SELECT customer_id, 1, 0, NULL, NULL
  FROM calc_contract_rows
 WHERE customer_id IS NOT NULL AND customer_id <> ''
 GROUP BY customer_id
ON CONFLICT(customer_id) DO UPDATE SET
  source_version = 1
 WHERE customer_sync_version.source_version = 0
   AND customer_sync_version.built_version = 0;
