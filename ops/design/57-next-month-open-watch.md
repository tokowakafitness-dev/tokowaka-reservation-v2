# 設計57　翌月の空き枠の見張り（日次点検）

2026-11-25・CTO（CEO 決定・オーナー「12月の予約が問題なく開放されているか」）

## 目的（1行）
毎月25日以降、翌月の空き枠が開いていない（翌月の出勤の入れ忘れ・枠の作り直しの失敗）ことに、日次点検で翌朝気づけるようにする。

## 事実（読んだもの）
- 予約できる最終日は GAS `_lbBookingHorizonEnd`（gas/LineBooking.js）と Worker `slotsRange`（worker/src/routes/slots.js）。25日0時から翌月末。
- 空き枠は `buildAvailableSlots`（gas/コード.js）＝出勤（`isShiftEvent` の予定）−予約・休憩・ブロック・B1。
  `buildAndCacheSlots` が10分ごと（warmupCache・pushToEdgeSlots）に作り、同じ枠を
  キャッシュ・公開シート（`writeToSpreadsheet`：`slots` タブ全部の書き直し＋`meta!A1` に書き終えた時刻）・D1（slots_cache）へ出す。
- 日次点検 `dailyHealthCheck`（7時）には段「翌月の解放」（25日の案内を送れなかった人＝nudge_open_miss）がある。
  ここは**契約**の見張りで、**枠**は誰も見ていなかった。

## 比べた手段
| 手段 | 重さ | 変える面積 | 判断 |
|---|---|---|---|
| A. 日次点検で `buildAvailableSlots` を呼び直す | カレンダー4本×約5週・枠の計算（押し出しの実測は全体で約43秒） | 小 | ✕ 重い（10/10 に557秒で落ちた実績） |
| B. 公開シートの2列＋meta を読み、出勤は翌月の範囲だけカレンダーを読む | 下の見積り（数秒） | 小・読むだけ | ◎ 採用 |
| C. 枠を作るたびに月ごとの日数を Script Property に残す | ほぼ0 | 予約の経路（10分ごとの作り直し）に書き込みを足す・Property を1つ増やす | ✕ 顧客の経路を触る |
| D. Worker の slots_cache を読む新しい窓口 | 小 | Worker に op を足す | ✕ 新しい op を足さない |

## 何をするか
段「翌月の解放」の最後に `lbNextMonthOpenCheck(now, 点検の経過時間)` を呼ぶ。
1. `_lbNextMonthRange(now)`：`_lbBookingHorizonEnd(now)` が今月末なら **null＝何も読まない**（24日まで）。翌月なら翌月1日0時〜末日23:59:59。
2. `_lbNextMonthOpenRead`：公開シート（`PUBLIC_SLOTS_SPREADSHEET_ID`、無ければ従来の SS）の `slots` の5〜8列目（startISO〜trainerId）と `meta!A1`、
   `CALENDAR_IDS.TRAINERS` の各カレンダーの翌月ぶんの予定（`isShiftEvent` だけ・開始時刻だけ持つ）。
3. 判定
   - 顧客向け（`hidden` でない）トレーナーの翌月の枠のある日が **0日 → `next_month_slots_none`**（warn・件数1）。
     詳細＝出勤のある日数（記号ごと：`A(非表示):n・B:n・C:n`）・枠のある日（全体／顧客向け）・写しの古さ。
     facts＝`no_shift`（出勤も0日＝入れ忘れの見込み）／`not_covered`（出勤はあるのに枠0＝予定名・作り直し）。
   - 1日以上 → `next_month_open`（info・件数＝顧客向けの日数）。案件にしない。
   - **判定できない → `next_month_slots_unknown`**（warn・0日とは言わない）：写しが25日0時より前（地平が伸びる前に作った＝翌月を覆っていない）／3時間より古い／meta が無い・壊れている／`slots` タブが無い（`stale`・`unreadable`）／日次点検が既に4分を超えた（`no_time`・読まない）。
   - ★**書き直しの途中 → unknown（`rewriting`）**（関門② 2026-11-25）：公開シートは原子的に差し替えられない
     （`writeToSpreadsheet`：slots を全消去→見出し→全行を1回の setValues→最後に meta!A1）。途中に読むと slots は空なのに
     meta は前回の新しい時刻のまま。だから meta!A1 を slots の**前と後で2回**読み、違えば書き直し中。slots の全体（今月を含む）が0行も書き直し中とみなす
     （全行は1回の setValues で書くので「部分の行」は起きない想定＝残る状態は0行か全部）。
   - ★**顧客向けトレーナーのカレンダーが1本でも読めない → unknown（`cal_unreadable`）**（関門②）：出勤なし／枠なしの原因を確定できない。非表示（オーナー）だけ読めないなら判定する。
   - 点検そのものが例外 → `next_month_check_fail`（AB・例外の文は出さない・段に完走の印を付けない）。

★全体ではなく**顧客向け**で数える理由：オーナー（hidden）の枠は曜日×時間帯で固定客にだけ出る。オーナーの出勤が入っていると、
　スタッフの出勤が丸ごと抜けても「全体」は0日にならず、見張りが黙る。詳細には全体の日数も並べる。

件数を1に固定するので、悪化のメールは**最初の日だけ**（同じ状態が続いても毎日は送らない＝既存の悪化の規則）。台帳（incidents）には B で開き、直った次の点検で閉じる。

## 振り分け（I-H10・同じ変更で足した）
| key | 区分 |
|---|---|
| next_month_slots_none | B（手当ては出勤の入力の確認＝顧客の枠に直結） |
| next_month_slots_unknown | B |
| next_month_check_fail | AB（`LB_FACT_EXCEPTION_KEYS` にも足した） |
| next_month_open | 記録（info） |

## 重さの見積り（★未計測）
25日〜末日だけ（月に最大7回）。24日までは0。
- `SpreadsheetApp.openById` 1回：約1秒
- `slots` の4列×行数（翌月末までの枠。3名×約5週で 1,000〜2,000行の見込み）の `getValues` 1回：約1秒
- `meta!A1` 1セル×2回（前後）：0.5秒未満
- カレンダー3本×1か月の `getEvents`：1本1〜3秒
- 合計の見込み **4〜12秒**。6分の制限に対し、点検が既に4分を超えていたら読まない（`no_time`）。
- 実測は次の25日の `LB_HEALTH_STEP`（段の経過 ms：`翌月の解放=…` と次の段 `二重書き=…` の差）で確かめる。

## 判定できないとき顧客に何が出るか
何も変わらない（読むだけ・顧客の画面・予約・通知・D1 に触れない）。点検の出力が unknown になるだけ。

## 個人情報
出すのは日数・トレーナーの記号（A/B/C。氏名ではない）・写しの古さ（分）だけ。予定名（顧客名が入りうる）は読んだ直後に開始時刻だけへ落とし、詳細に出さない（検査 ⑥-6）。

## 不変条件
MODEL.md §3 **I86**（検査 `worker/test/next-month-open.test.js` ①〜⑦）。I-H10 の数を 94 に。

## 反映と戻し方
- GAS の変更（`gas/LineBooking.js`）＝**オーナーの GAS 反映が要る**（まとめて1回）。版の印 `LB_HEALTH_BUILD` 2026-11-25b（関門②の直し）。
  反映後、点検のログ「dailyHealthCheck 版: 2026-11-25b」で入ったと分かる。今月は 11/26 7時の点検から 12月を見る。
- 戻し方：段の中の try ブロックを消す（ほかの段は触っていない）。新しいトリガー・Property・op は無い。

## 確かめていないこと
- 公開シートの実際の行数と読みの時間（上の見積り）。
- `meta!A1` がシートで日付型に変わるか（文字列・日付型の両方を読む作りにした）。
- 本番の CALENDAR_IDS の各カレンダーが点検の実行者で読めるか（読めないトレーナーは「読めない」と書き、0日とは数えない）。
