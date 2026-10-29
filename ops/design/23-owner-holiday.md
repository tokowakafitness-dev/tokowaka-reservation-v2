# 設計23：中野（hidden）の固定客向け枠を、祝日は曜日に関係なく開ける

2026-10-29 ／ オーナー：「オーナーの祝日の日程はフルで開放するような設定はできるか」

## 0. 倒れる向き
祝日かどうか判定できない・設定が読めないときは、**今の曜日のルール**で答える（枠を広げる側に倒さない）。

## 1. 事実
- 枠の絞り込みは Script Property `OWNER_SLOT_WINDOW`（曜日'0'〜'6'→ `{from,to}` | `'all'`、キー無し＝非表示、未設定＝制限なし）。
- 判定は2か所で同じ答えを出す必要がある：
  - GAS `_lbInOwnerWindow(st, win)`（gas/LineBooking.js）… `buildAvailableSlots`（gas/コード.js:421, 465-468）で hidden の枠だけ絞る
  - Worker `inOwnerWindow(startMs, win)`（worker/src/lib/calslots.js:111）… calsync で受けた owner_window を D1 に保存し、枠を作るときに絞る
- GAS は `_lbOwnerSlotWindow()` の生の値を calsync の payload に載せる（gas/PushToEdge.js:1845 等）。Worker は `normalizeOwnerWindow`（worker/src/routes/calsync.js:129）で**曜日以外のキーを拒否**し、拒否すると公開しない（7分で鮮度切れ→GASへ落ちる＝顧客に害なし）。
- 祝日の扱いはコードのどこにも無い。
- gas/ にファイルを増やせない（gas-deploy.yml の許可一覧・私は書けない）。

## 2. 変更
1. **祝日の判定を計算で持つ**（外部APIや Google の祝日カレンダーは使わない）
   - 根拠：祝日法の規則で決まる。固定日／ハッピーマンデー（成人・海・敬老・スポーツ）／春分・秋分（1980〜2099年の近似式）／振替休日（日曜の祝日→次の祝日でない日）／国民の休日（祝日に挟まれた平日）。
   - Google の祝日カレンダーは「行事」（節分など祝日でない日）を含むようになっており、Worker からは読めない。
   - 臨時の祝日（2019年の即位の日・2020/2021年の五輪の移動）は計算できない。将来出たら一覧に足す（例外表 `extra`／`removed`）。
   - `_lbJpHoliday(y, m, d)`（m は1〜12）を **gas/BookingRules.js** に置き export。Worker は **worker/src/lib/holiday.js** に同じ関数。
   - 2026〜2035年の全日で両者が同じ答えを出すことを検査（allocate-drift と同じ考え方）。2026・2027年は内閣府の公表一覧と突き合わせる。
2. **設定に祝日のキー `'h'` を足す**
   - `OWNER_SLOT_WINDOW` に `"h": "all"`（または `{from,to}`）。**祝日なら曜日のルールより優先**。`'h'` が無ければ従来どおり（祝日も曜日のルール）。
   - GAS `_lbInOwnerWindow`：`win.h` があり、st の JST 日付が祝日なら `win.h` で判定。
   - Worker `normalizeOwnerWindow`：キー `'h'` を受ける（値の規則は曜日と同じ）。`inOwnerWindow`：同じ優先順位。
   - 設定関数：`runOpenOwnerHolidays()` → `setOwnerSlotDay('h', 'all')`（既存の1キー差し替えを `'h'` も受けるよう拡張・未設定／壊れた値は書かない）。
3. **反映の順序**（逆にすると公開が止まる）
   1. Worker を push（worker/ の push で自動反映）→ `'h'` を受けられる状態に
   2. GAS 反映（オーナー）
   3. GAS エディタで `runOpenOwnerHolidays` を1回（オーナー）
   - 1より先に3が起きても、Worker が拒否→公開されない→GASへ落ちる（顧客に害なし・⛔ログ）。

## 3. 境界
- 祝日の判定はその枠の**開始時刻の JST 日付**。24時をまたぐ枠は開始日で決まる（曜日と同じ）。
- `'h'` の祝日に出るのは、カレンダー上の中野の出勤枠だけ（出勤が無ければ何も出ない）。
- 固定枠の自動予約・担当なし均等割当は hidden を除外したまま（変更しない）。
- 年末年始（12/29〜1/3）は祝日ではない（1/1だけ祝日）。開けたい場合は別の話。

## 4. 検査
- 祝日の計算：2026・2027年の公表一覧と全一致。振替（2026-05-06）・国民の休日（2026-09-22）を含む。
- GAS と Worker が 2026〜2035 年の全日で一致。
- 入口から：GAS `_lbInOwnerWindow` と Worker `inOwnerWindow` が、祝日の月曜9時（`h:'all'`・月曜は17時〜）で true、翌日の平日9時で false、`'h'` なしなら祝日でも曜日のルール。
- Worker `normalizeOwnerWindow`：`'h'` を受ける／`'x'` は拒否のまま。キーの並びが安定（`'h'` を含めても順序で中身の印が揺れない）。
- 設定関数：`'h'` だけ差し替え・他は本番の値のまま・未設定なら書かない。
- 壊して落ちることを確かめる。

## 5. 関門①の指摘（2026-10-29 Codex・実装前に反映する）— ⏸ オーナー指示で保留中
1. 「逆順でも害なし」は不正確：旧 Worker が 'h' を拒否すると公開中の世代→slots_cache（20分）→GAS の順に落ちる。過剰開放には倒れないが、**祝日枠が最大20分ほど出ない**ことがある。
2. calcompare（worker/src/routes/calcompare.js:302,380,445）も ownerWindow を直接使う＝検査対象に含める。
3. `_lbOwnerWindowWithDay` は day を Number 化している＝'h' を受けられない。'h' か整数0〜6として扱う。既存値の全体検査も `^(?:[0-6]|h)$` に。旧 GAS は 'h' 入りの値に別曜日を足そうとすると UNREADABLE で止まる（表示は曜日どおり）。
4. `parseOwnerWindow`（calread.js:257）が 'h' を保持するテスト。
5. 祝日関数：保証年を 2020〜2099 に固定し範囲外は「祝日でない」に倒す。基礎祝日→国民の休日→振替休日の適用順を明示（振替は「次の祝日でない日」まで繰り越す）。返り値は真偽値のみ。extra/removed の形式を固定。月またぎの振替・連続祝日後の振替・9月の国民の休日・範囲の端を単体検査。春分・秋分は近似式で、法的には前年2月の官報で確定する。
6. `setOwnerSlotWindow` はキーも値も検証しない入口＝'h' 対応時に揃える。
7. 反映確認：設定後に /calsync 成功と D1 の owner_window に "h" が入ったことを確かめてから完了（今は読む経路が無い→作業依頼に足す）。
