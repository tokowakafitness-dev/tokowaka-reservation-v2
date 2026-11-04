# 設計30 計算の材料が届いていなければ D1 で答えない（2026-11-04）

## なぜ
Codex 関門③（全員を D1 から答える前）の指摘1：GAS の契約送信（_edgeCalcContracts）が throw すると、
その回の材料は1件も届かず、D1 の世代も進まない。D1 は古い契約のまま「新しい」と名乗り、写しに倒れる経路が無い。
日次点検の contract_push_stalled（26時間）は通知であって、誤表示を止めない。

## 事実（確認済み）
- GAS は15分ごと（pushToEdgeLight→pushToEdgeAll(false)）に、計算の材料4つを**全件**・scope:'all'・同じ batchId で順に送る（gas/PushToEdge.js step('計算入力')）
- Worker は final かつ scope:'all' のたびに sync_state を押す（ingest.js sweptAll→stampSync）。完全同期でなくても押す
- 本番 11/4 12:00 ごろ：4つとも同じ batchId・8分前（/health で確認）

## 設計
- decideHome（remain-read-on.js）で、reviewRequired の判定の直後・D1 を読む前に、4つの印を読む
  - 欠け・数でない（null/空/文字/0/負/小数/Infinity）・未来5分超 → copy:calc_input_unknown
  - 4つの batchId が違う（途中で止まった回） → copy:calc_input_split
  - 45分以上前（15分周期×3・境界は倒す側） → copy:calc_input_stale
- 顧客向け6入口はすべて readHome→decideHome を通る（Codex 確認）。数え方は既存の countSource に乗る
- /quota/rebuild は全体の印を押さない（1名の成功は全員の材料の証拠ではない）。止まっている間はその会員も写し＝安全側

## 受け入れた幅
送信が止まってから最大45分（＋時計のずれ5分）は、D1 が古い材料で答えうる。
チケット補充など書き込みの出口を通る操作は dirtySeq で即座に写しへ倒れる。残るのは契約フォームの直接編集。

## 記録しないもの
- D1 全面障害時は countSource も失敗するので、倒れた回数は数えられない（顧客の応答は写しで守られる）

## 関門
- ① Codex：calcContracts 単独では calcMeta/calcReservations/opening の停止を見逃す → 4つ・同じ batchId に変更して通過
- 検査：read-on.test.js ⑧（門を外すと6件、split 判定を壊すと2件落ちることを確認）

## 関連
- 厳密IDモード（LB_STRICT_ID_MODE）は **on にしない**。addTicketRefill が顧客IDを書かないため、on にすると migrationGap で全員の契約送信が止まる（Codex 関門③ 指摘2）
