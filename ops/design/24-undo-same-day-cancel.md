# 設計24：間違えた当日キャンセルを、オーナーが1回の操作で無料キャンセルに直す

2026-10-30 ／ オーナー：「トレーナー画面に『当日キャンセルを取り消す』ボタン。オーナー権限のみでいい」

## 0. 倒れる向き
直してよいか判定できないとき（行が特定できない・振替権が使われている・締めた月）は**何も書かずに止める**。途中まで書いて止めない。

## 1. 事実（2026-10-30 に手で直したときに確かめたこと）
- 当日キャンセル（`cancelReservationLine`・gas/LineBooking.js:7734〜）は3か所を書く：
  1. 台帳 `line_reservations`：G列 status `confirmed`→`consumed`、I列 備考 `予約ID|当日消化取消`
  2. B1カレンダー：その予定のタイトルを `[消化] …` に変える（`_lbConsumeReservationEvents`。予定のIDは変わらない）。トレーナーのカレンダーの予定は削除
  3. `transfer_credits`：`[customer_id, granted_at, expires_at, used_at(空), source_reservation_id]` を1行足す（`_lbGrantTransferCredit`）
- 残数の正本は台帳（`_lbResvValsToSessions` は confirmed/consumed だけを数える・gas/Allocate.js:551〜）。カレンダーの `[消化]` は精算（カレンダー経路・LB_CUTOVER_MONTH 未設定）が読む。
- 台帳 13列目 `calendar_event_id` は **B1 の予定のID**（`recordReservationLine`・`calendarEventId: capEvId`）。
- 手で直したとき：G列を `cancelled` にすると残数は戻るが、D1 の計算入力に旧行が残った（差分の送り直しは外れた行を消さない）。書き込みの入口から `edgeAfterWrite` を通れば、`lbDwEnqueue(cid)` がその会員を作り直す（無料キャンセルと同じ後始末）。
- オーナーの判定は `_lbIsOwnerRole(getTrainerByLine(lineUserId))`（role が owner/admin）。LIFF の導線は `state._isOwner`。

## 2. 変更
### GAS（gas/LineBooking.js）
1. `listSameDayCancels(lineUserId)`（読み取り）— オーナー以外は FORBIDDEN
   - 台帳から「status=consumed かつ 備考が `/^(.+)\|当日消化取消$/`」の行で、予約日時が**今月1日（JST）以降**のものを返す
   - 返す項目：reservationId・dateLabel・customerName・customerId・trainerName・transferUsed（その予約の振替権が使われたか）
2. `undoSameDayCancel(lineUserId, reservationId)`（書き込み）— オーナー以外は FORBIDDEN。スクリプトロックの中で：
   1. 備考が `reservationId + '|当日消化取消'` に完全一致する行を探す。0件→NOT_FOUND／2件以上→AMBIGUOUS（何も書かない）
   2. status が `consumed` でなければ ALREADY
   3. 予約日時が今月1日（JST）より前なら CLOSED_MONTH（締めた月の精算と食い違うため）
   4. `transfer_credits` で E列＝reservationId の行を集める。1つでも used_at が入っていれば TRANSFER_USED（何も書かない）
   5. ここまで通ったら書く：振替権の行を下から削除 → G列 `cancelled` → I列 `reservationId|当日消化取消→無料取消（オーナー訂正 yyyy/MM/dd HH:mm）`
   6. B1 の `[消化]` 予定を消す：13列目のIDで `getEventById`、タイトルが `[消化]` で始まるときだけ削除。IDが空・見つからないときは、予約時刻〜+セッション分の `[消化]` で始まり顧客名を含む予定（`_lbConsumeReservationEvents` と同じ照合）。**消せなかったら calendarDeleted:0 を返す**（画面に「カレンダーの [消化] は手で消してください」と出す）
   7. 返り値 `{ success:true, customerId, calendarDeleted, creditsRemoved }`（customerId は二重書きの会員特定に必須・entry-customer-id の規則）
   - お客様への LINE 通知は送らない（対外発信はオーナーの判断。必要ならオーナーが連絡する）
   - トレーナーのカレンダーの予定は戻さない（同じ時間に受けるなら代行予約で取り直す＝締め切りの対象外）
3. 振り分け：`line_listSameDayCancels` / `line_undoSameDayCancel`
### GAS（gas/PushToEdge.js）
4. `EDGE_AFTER_WRITE` と `EDGE_CALSYNC_AFTER` に `line_undoSameDayCancel`
### LIFF（liff/index.html）
5. トレーナー管理の顧客一覧の、`state._isOwner` のときだけ出す並び（「システム状態を見る」の隣）に「↩️ 当日キャンセルを取り消す」
6. 一覧画面：各行に「無料キャンセルに直す」ボタン。押すと確認（顧客名・日時・「残数が1回戻り、振替権が消えます」）→ 実行 → 結果（カレンダーを消せなかったときはその旨）。振替権が使われた行はボタンを出さず理由を出す
7. `EDGE_WRITE_ACTIONS` と `_NO_RETRY` に `undoSameDayCancel`（書き込み＝写しを信用しない印・再試行しない）

## 3. 反映の順序
LIFF は main への push で即公開。GAS は反映（オーナー）。先に LIFF が出てもボタンはオーナーにしか出ず、押すと UNKNOWN_ACTION（何も書かれない）。

## 4. 検査
- 入口から（vm・身代わりのシート／カレンダー）：成功で3か所が直る／オーナー以外は FORBIDDEN／普通に消化した行（備考が当日消化取消でない）は対象外／振替権が使われていたら何も書かない／先月は CLOSED_MONTH／2回目は ALREADY／ID一致の予定だけ消す（同じ時刻の別の顧客の `[消化]` は消さない）／IDが空なら名前と時刻で探す
- 一覧：対象の行だけ返す・オーナー以外は FORBIDDEN
- 配線：振り分けの case・EDGE_AFTER_WRITE・EDGE_CALSYNC_AFTER・LIFF の EDGE_WRITE_ACTIONS と _NO_RETRY・ボタンが `state._isOwner` の内側
- 壊して落ちることを確かめる

## 5. 関門①（Codex・2026-10-30）の指摘と対処
| 指摘 | 対処 |
|---|---|
| 備考の完全一致で探すと2回目が NOT_FOUND | 行は備考の resId 部分で探す。分類：元の完全一致＋consumed＝実行／訂正済み＋cancelled＝ALREADY／それ以外＝STATE_MISMATCH |
| 旧ID重複への防御 | 全行で resId 部分の一致を数え、2件以上は AMBIGUOUS |
| 「今月以降」は締めの実態と違う | 締めの記録（`_lbFindClosedManifest`）がある月は CLOSED_MONTH。運用として先月以前は PAST_MONTH（精算はカレンダー経路で月初に締めるため）。コードを分けた |
| 振替権の物理削除は途中失敗に弱い | 行は消さない。期限を1分前に書き換え、6列目に「無効化（元の期限）」の履歴。全ての読み手（予約の入口・残数の写し・声かけ）が「期限切れ＝使えない」と読む（検査④） |
| 書く順序 | 台帳を先（G〜Iを1回）→振替権→カレンダー。振替権で失敗しても「残数が戻らず振替権だけ消える」にはならない。失敗は creditError で画面に出す |
| 振替権は会員も照合 | 同じ予約IDで別の会員の行があれば CREDIT_MISMATCH（何も書かない） |
| カレンダーの代替照合 | ID一致でも時刻・顧客名・[消化] を確かめる。ID が無いときは候補がちょうど1件のときだけ消す |
| D1 の作り直しは保証ではない | 無料キャンセルと同じ経路（edgeAfterWrite→lbDwEnqueue）。積めなかったときは既存の [dw] ログと毎朝4時の完全同期・照合で拾う（既存の性質と同じ・却下ではなく受容） |
| 一覧に顧客IDは不要 | 返さない（検査⑤-4）。ログは会員IDの下4桁だけ |
| 「振替権が消えます」は不正確 | 「付与済みの振替権があれば無効になります」 |
| 権限 | 関数の先頭で `_lbIsOwnerRole`。加えて認可の正本 `_lbTrainerMaySeeCustomer(_tr, _lbCustOwnerOf(cid))` も通す（例外を増やさない・名簿に無い顧客は止める） |
