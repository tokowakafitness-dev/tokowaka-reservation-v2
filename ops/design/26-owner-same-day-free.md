# 設計26：オーナーだけが、当日（前日17時以降）の予約を無料で取り消す・変更できる

2026-10-31 ／ オーナー：「オーナーの当日無料変更・取り消し権限を新しく作成して欲しい」

## 0. 倒れる向き
オーナー権限を**明示して頼んだとき**だけ無料にする。権限が確かめられない・頼まれていないときは、今と同じ（当日消化／変更不可）。オーナー以外が頼んだら**黙って通常処理にせず FORBIDDEN**（取り違えに気づけるように）。

## 1. 事実（gas/LineBooking.js）
- 無料の期限 `_lbIsFreeCancelWindow(start)`＝前日17時より前（7683）
- キャンセル `cancelReservationLine(lineUserId, reservationId)`（7756〜）
  - 操作できる人：本人／その予約の担当トレーナー／オーナー（`_lbIsOwnerRole`）
  - 期限後は**誰が操作しても**：B1 を [消化] 化・トレーナー予定削除・G=consumed・I=`resId|当日消化取消`・振替権を付与（振替予約は除く）・お客様に「当日取消のため1回分の消化」
  - 期限前：両方の予定を削除・G=cancelled・I=`resId|無料取消`・お客様に「前日17時までのため無料」
- 変更 `changeReservationLine(lineUserId, reservationId, newStartISO)`（8003〜）
  - 期限後は**誰が操作しても** SAME_DAY で止める（オーナーも）
  - 新しい枠は `_lbReserveCore(..., 'change')` → 3時間前の締め切り（TOO_SOON）がかかる。画面の空き枠も締め切り済みは出さない（コード.js 466）
- 画面（liff/index.html 1905〜）：トレーナー管理の予約一覧。`r.freeCancel` が偽（期限後）だと「時間を変更」を出さない。オーナーは全予約に「キャンセル」が出る（`state._isOwner`）
- 書き込みは Worker を通らず GAS へ直接（EDGE_WRITE_ACTIONS → null）。cancel/change は EDGE_AFTER_WRITE 済み（D1 の作り直しは既存の経路）

## 2. 変更
### GAS
1. `cancelReservationLine(lineUserId, reservationId, ownerFree)`
   - `ownerFree === true`（振り分けで `params.ownerFree === '1' || === true` を真偽値にする）のとき、操作者が `_lbIsOwnerRole` でなければ **FORBIDDEN**（何も書かない）
   - オーナーかつ期限後 → **期限前と同じ無料の処理**（両方の予定を削除・G=cancelled・振替権なし）。I=`resId|無料取消（オーナー権限 yyyy/MM/dd HH:mm）`
   - お客様への通知：新しい文言 `push_cancel_owner_free`（「今回は無料でのお取り消しとなります」）。トレーナー通知は「（無料取消・オーナー権限）」
   - 期限前に ownerFree が来ても通常の無料（文言も通常）
   - 振替予約（channel transfer）も同じ無料の処理（期限前の無料取消と同じ扱い）
2. `changeReservationLine(lineUserId, reservationId, newStartISO, ownerFree)`
   - 同じく、オーナー以外が頼んだら FORBIDDEN
   - オーナーかつ期限後 → SAME_DAY で止めずに進める（以降は通常の変更と同じ）
   - **新しい枠の3時間前の締め切りは変えない**（画面にも締め切り済みの枠は出ない＝今回の範囲外。必要なら別途）
   - 振替予約の変更不可（NO_TRANSFER_CHANGE）はそのまま
3. 振り分け：`line_cancelReservation` / `line_changeReservation` に `params.ownerFree` を渡す
4. 戻り値に `ownerFree: true`（無料にしたときだけ）を足す。customerId は今までどおり
### LIFF
5. トレーナー管理の予約一覧で、`state._isOwner` かつ `!r.freeCancel` の行だけ：
   - 「時間を変更（オーナー・無料）」→ 変更画面へ（state.ownerFree=true、送信に ownerFree:'1'）
   - 「無料で取り消す（オーナー）」を「キャンセル（当日消化）」と並べて出す。確認文に「消化にせず、残数を戻します。振替権は付きません」
   - state.ownerFree は変更の完了・戻る・別の操作の開始で false に戻す
6. お客様の画面は変えない

## 3. 検査（入口から）
- キャンセル：オーナー＋期限後＋ownerFree → cancelled・予定2つ削除・振替権なし・I の記録・通知文
- オーナー＋期限後＋ownerFree なし → 今までどおり consumed・振替権あり
- トレーナー／本人が ownerFree → FORBIDDEN・何も書かない
- 期限前＋ownerFree → 通常の無料（文言も通常）
- 変更：オーナー＋期限後＋ownerFree → SAME_DAY で止まらず予約の本体へ／ownerFree なし → SAME_DAY／オーナー以外 → FORBIDDEN
- 振り分けが params.ownerFree を渡している（配線）
- 画面：ボタンが `_isOwner && !freeCancel` の内側
- 壊して落ちることを確かめる

## 4. 反映
GAS 反映（オーナー）。LIFF が先に出てもボタンを押すと旧 GAS は ownerFree を無視して**今までどおりの当日消化**になる → **危ない**（無料のつもりで消化される）。
→ LIFF は **GAS 反映の後**に push する（GAS を先に push・反映 → 版の印を確かめてから LIFF を push）。

## 5. 関門①（Codex・2026-10-31）の指摘と対処
| 指摘 | 対処 |
|---|---|
| 変更で SAME_DAY だけ外すと、記録・通知・penalty が「当日消化」のまま | `free = 期限前 || オーナー適用` に統一し、記録・通知・戻り値すべてで使う。記録は「無料変更（オーナー権限 …）」、お客様へ `push_change_owner_free` |
| オーナーが他の担当の予約を変えると、画面は自分の空き枠を出す（既存の不具合） | `startTrainerChange` で `state.trainerId = r.trainerId`（名前は _allTrainers から）。通常の変更にも効く |
| 反映の順序に頼るより専用の入口が安全 | **`line_ownerFreeCancel` / `line_ownerFreeChange` を新設**（普通の入口に ownerFree を渡さない）。古い GAS では UNKNOWN_ACTION で止まり、当日消化に流れない → **LIFF と GAS の順序を気にしなくてよい**（§4 は不要になった） |
| `_lbIsOwnerRole` は owner と admin を許す | 既存の「オーナー権限」と同じ扱い（設計24と同じ）で受容 |
| 台帳 confirmed のままカレンダーだけ [消化] の不整合では、無料取消しても [消化] が残る（_lbDeleteReservationEvents は [消化] を消さない） | 受容。通常経路では起きない（期限後の取消は行も consumed になる）。既に consumed の訂正は設計24のボタンの役目で、この機能では代替しない |
| 認可の正本 | `_lbTrainerMaySeeCustomer` もオーナーの経路で通す（例外を増やさない・名簿に無い顧客は止める） |
| 変更先の3時間前の締め切り | 変えない（画面にも締め切り済みの枠は出ない）。今回の範囲外 |
