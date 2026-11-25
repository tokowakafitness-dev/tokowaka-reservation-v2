# 設計60 代行のトレーナー選びで、その顧客の担当を先頭に出す

最終更新：2026-11-25（初版・CTO）

## 目的（オーナー指示 2026-11-25・案A）
トレーナーの「＋ 予約を代行」で、その顧客の担当を一覧の一番上に「担当」の印で出し、ほかのトレーナーは下に並べる（選べるまま・直行しない）。

## 現状（コードで確認）
- `renderCustomerDetail` の「＋ 予約を代行」は `startProxyReservation(_cId, name)`（第3引数なし）。
  `startProxyReservation` は `state.defaultTrainerId = defaultTrainerId || state.defaultTrainerId || ''`＝前の顧客の値が残る。
  しかも `state.defaultTrainerId` は会員本人の直行の判定（設計59）にも使う値。
- 顧客一覧は `line_getTrainerReservations` の `customers`。経路は Worker `compatTrainerReservations`（起動のまとめ `c_boot` の `trainerReservations` も同じ関数）、答えられないとき GAS `getTrainerReservations`。どちらも `{customerId, name}` だけで担当を持たない。
- D1 `customers.default_trainer_id` は customer_line_map の E列 trainer_id の写し（`gas/PushToEdge.js` 254行 `MAP_COL.TRAINER_ID`）。閲覧範囲（`perms.js` customerScopeSql）・会員の担当（`auth.js`）にも既に使っている。

## 比べた手段
| 案 | GAS の反映 | 担当の正しさ | 結論 |
|---|---|---|---|
| A. Worker の顧客一覧に `defaultTrainerId`（D1 の写し）を足し、画面が代行の第3引数に渡す | 不要（Worker は main で自動反映） | E列の写し。顧客の写しが古い（30分超・記録なし）ときは鍵ごと載せない | **採用** |
| B. GAS の `_lbAllVerifiedCustomers`・担当顧客にも trainer_id を足す | 要る（1回） | E列そのもの | Worker が答えないときだけ効く。今回は見送り（そのときは印なし） |
| C. 既存の予約の trainerId から推定 | 不要 | 担当と違いうる | 不可 |

## 変更
- Worker `compatTrainerReservations`：顧客の SELECT に `default_trainer_id`。`listTooOld(env,'customers')` が偽のときだけ各顧客に `defaultTrainerId`（担当なしは `''`）。古い・記録なしは鍵ごと載せない。予約一覧の答え方（鮮度・_fallback）は変えない。
- LIFF：`_proxyDefaultOf(customerId)` が `state._trainerCustomers` から `defaultTrainerId` を引く（文字でなければ `''`＝分からない）。代行の押下で第3引数に渡す。
  `startProxyReservation` は代行専用の `state.proxyDefaultTrainerId` に入れ、**`state.defaultTrainerId`（会員本人）を触らない・前の値を引き継がない**。
  `renderTrainers` は代行なら `proxyDefaultTrainerId`、会員なら `defaultTrainerId` を使い、`String()` で比べる。並びは担当を先頭、ほかは元の順（安定な sort）。

## 判定できないとき
- GAS の応答・顧客の写しが古い・担当なし・担当が一覧に居ない（hidden のオーナー等）→ 印なし・元の順。誤った人を担当と出さない。

## 個人情報
- 新しく画面に届くのはトレーナーの ID（顧客ごとの担当）だけ。届け先は閲覧範囲を通ったトレーナー・オーナーの画面。送る値・記録は増えない。

## 戻し方
- revert（Worker は main で自動反映。GAS は触らない）。
