# 設計25：予約できる最終日より先の予約を、サーバーで止める（本人の操作だけ）

2026-10-31 ／ オーナー：「先も表示してよいが、予約が出来ないようになってればいい」→ 画面は灰色で押せない（repo 3d1b336）。サーバー側も止める。

## 0. 倒れる向き
本人の操作で、開始時刻が最終日（`_lbBookingHorizonEnd(now)`）より後なら**作らない**。印が無い経路（トレーナー・自動処理）は今と同じ。

## 1. 事実
- `_lbReserveCoreImpl`（gas/LineBooking.js 5259〜）は、過去・400日先・締め切り（TOO_SOON）・残数・空きを見ているが、最終日は見ていない。画面に枠が出ないことで止まっているだけ
- 同じ `_lbReserveCore` を通る経路と channel：
  | 経路 | 関数 | channel | 本人の操作 |
  |---|---|---|---|
  | 単発 | makeReservationLine | line | ○ |
  | まとめて（本人） | makeBatchReservationLine→_lbBatchReserve | line | ○ |
  | 繰り返し（最大8週） | 5455〜 | line | 1回目だけ画面で選ぶ・2回目以降は自動で先へ |
  | 振替 | makeTransferReservationLine | （同ファイル 5579） | ○ |
  | 変更（本人／トレーナー） | changeReservationLine | change | 本人のときだけ（`consecRule` と同じ判定） |
  | 代行（単発・まとめて） | makeReservationLineProxy ほか | trainer_manual | ×（締め切りも対象外） |
  | 固定枠の自動予約 | autoBookRecurring | line | ×（_lbCustInfoById） |
  | 計測 | perf | perf_test | × |
- channel だけでは本人と自動処理を分けられない（自動予約も 'line'）。channel は台帳・通知・集計に残るので変えない

## 2. 変更（gas/LineBooking.js のみ）
1. `_lbReserveCoreImpl`：締め切りの直後に
   `if (custInfo.enforceHorizon === true && start.getTime() > _lbBookingHorizonEnd(new Date()).getTime())` → `{ success:false, code:'NOT_OPEN_YET', message:'M月D日以降のご予約は、M月25日から受け付けます。' }`（その月の前月25日）
   - 印は**サーバーが組み立てる custInfo** にだけ付ける（body はクライアントの値なので見ない）
2. 印を付ける：単発・まとめて（本人）・振替・本人の変更（`String(r[3]) === String(lineUserId)`）
3. 繰り返し：**ループの前に1回目を `_lbHorizonGate` で確かめ**、先なら1件も作らない。各回には印を付けない（2回目以降は今までどおり最大8週先まで作る＝既存機能を壊さない・関門①）
4. 代行・自動予約・計測：付けない
- 画面は灰色で押せないので、通常の利用でこの関門に当たることは無い。当たるのは画面を通さない送信と、25日をまたいで画面を開きっぱなしにした場合（最終日は広がる向きにしか動かないので後者でも当たらない）

## 3. 検査（入口から）
- 単発・まとめて・振替・本人の変更：最終日の翌日0時は NOT_OPEN_YET（予約は作られない）／最終日の23時は通る
- 繰り返し：1回目が最終日より先なら止める／1回目が範囲内なら2回目以降は先でも作る
- 代行・トレーナーの変更・自動予約：先でも通る
- body に enforceHorizon:false を入れても外せない
- 壊して落ちることを確かめる

## 4. 反映
GAS 反映（オーナー）。次の反映にまとめる。先に反映されなくても顧客に害は無い（今と同じ状態が続くだけ）。

## 5. 関門①（Codex・2026-10-31）の指摘と対処
| 指摘 | 対処 |
|---|---|
| 繰り返しで「1回目だけ印」だと、1回目が止まっても2回目以降が作られる（ループは失敗を skipped に積んで続ける） | ループの前に1回目を `_lbHorizonGate` で確かめ、先なら1件も作らずに返す。2回目以降は印なし（検査③） |
| まとめて予約で先の日が混ざると、通知・画面は汎用の「取れなかった」になる | 受容。画面からは先の日を選べない（灰色・押せない）＝画面を通さない送信でしか起きない。整合（残数・振替権を使わない）は保たれる |
| 振替の channel 欄の誤記 | channel は 'transfer'。権利を使う前にも `_lbHorizonGate` で止める（検査④） |
| Worker 側に予約を作る経路は無い（書き込みは当面 GAS） | 確認のみ |
