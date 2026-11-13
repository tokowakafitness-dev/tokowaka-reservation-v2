# 設計43 予約・取消・変更の遅さを測る／書き込みの後35分 GAS に落ちるのを、枠だけ・追いつくまでに縮める

> 2026-11-13・CTO（CEO玄から受けた）。オーナーの訴え「予約の変更・キャンセルが目をみはるほど遅い／画面を開くのも遅い気がする」。
> 版の印：GAS `LB_HEALTH_BUILD`・`LB_EDGE_BUILD`・`LB_JOB_BUILD` を `2026-11-13c` に。LIFF は既定オフのスイッチ `WL_DEFAULT_ON=false`（`?wl=1`）。

## 目的（1行）
A. 書き込みの段ごとの所要時間を本番で数える（個人情報なし）。B. 書き込みの後、残数・予約一覧は Worker に戻し、空き枠だけを「D1 の枠が書き込みの後のカレンダーから作られた」と確かめられるまで GAS に聞く。C. 応答の前から外せる処理の候補を挙げる（実測の前に組み替えない）。

## 現状（コードで確認した事実）
1. 画面（`liff/index.html` `_edgeTry`）は書き込みを送るときに `_edgeMarkStale()`＝**35分間**、`EDGE_HOME_ACTIONS`（会員状態・ホーム・予約の選択肢・空き枠・自分の予約・トレーナーの予約・まとめ取得2つ・固定枠）を GAS へ送る。応答の `edgeSynced === true` のときだけ解除（`_apiSend`）。
2. GAS `edgeAfterWrite`（`gas/PushToEdge.js`）は、枠を変える操作（`EDGE_CALSYNC_AFTER`：予約・取消・変更ほか）では枠を同期で送らない（2026-10-11 関門②：古いキャッシュで巻き戻すため）。だから `_syncedSlots=false` で **edgeSynced は常に false**。予約・取消・変更をした端末は、その後35分すべての読み取りが GAS（1回2〜5秒・ROADMAP「軽量化」の実測）になる。
3. 残数（`member_home`）と予約一覧は `_edgeSendAfterWrite` で応答の前に送り終えている（`_syncedHome`・`_syncedResv`）。通し番号 `_seq`（`lbDwEnqueue`）を載せるので、D1 の残数は作り直しが追いつくまで `behind_write` で答えず写しへ落ちる（設計20・MODEL §5）。
4. 枠の写し（`slots_cache`）は `pushToEdgeSlots` が送る。payload の `builtAt` は「カレンダーを**読み終えた**時刻」（`buildAndCacheSlots`）。読み始めの時刻は持っていない。書き込みの後の更新は、予約直後の一回限りトリガー `_lbCalSyncAfterWrite` → 同期が patched → `_lbCalSlotsAfter` → `pushToEdgeSlots`（設計42・約30秒）か、10分ごとの `pushToEdgeSlots`。
5. 取消（`cancelReservationLine`）の応答の前：認証 → 会員検索・トレーナー検索・cancel_notes の見出し確認 → `ScriptLock.waitLock(10000)`（裏の押し出しと同じロック）→ 台帳の読み → カレンダーの削除/消化 → 台帳の書き込み・振替権・cancel_notes → ロックを離す → `_lbCxlAfter`（通知・予算4秒）→ `edgeAfterWrite`（積む・写し・予約一覧）。変更（`changeReservationLine`）は台帳全体の読み（ロックの外）→ ロック → `_lbReserveCore`（残数の判定・カレンダーの読み・作成・台帳）→ 旧予定の削除 → ロックを離す → 言語の検索 → 会員への通知 → `_lbTrainerRemainText`（残数の計算）→ トレーナーへの通知。予約（`_lbReserveCore`）は**ロックの中で通知を送っている**。
6. 段ごとの所要時間は本番で一度も数えていない（`[perf]` は Logger だけ＝誰も読めない）。

## A. 計測（GAS・個人情報なし）

### 比べた手段
| 手段 | 判定 |
|---|---|
| Logger の `[perf]` を読む | ✗ 誰も読めない（現状） |
| 新しいシートに1行ずつ | ✗ appendRow は1回 0.3〜1秒・応答の前に足すと遅くする。シートを作るにはオーナーの操作 |
| **Script Properties に直近60件のリング（1つの鍵・JSON）** | ◎ 読み書き各1回。作業依頼 `remaining` の新しい arg で読める＝許可一覧も op も変えない |

### 変えるもの（gas/LineBooking.js）
- `handleLineGet` の入口で、計測の対象の操作（下の表）だけ記録器を始める。GAS の実行は要求ごとに独立なので、記録器はグローバル変数1つ（`_LB_WP`）。
- 段の印 `_lbWpMark(stage)`：**処理を終えた直後に、終えた処理の段の名前で付ける**（関門① 指摘5）。「前の印からいままで」をその段に**足す**（同じ段を2回付けたら合計）。ロック待ちは `waitLock` の**直前**に `pre`、**直後**に `lock`。記録器が無ければ何もしない（裏の処理・テストで呼ばれても無害）。
- 段（固定・この順で保存）：`auth`（ID トークンの確認）・`pre`（ロック前の会員検索・入力の確認・台帳の読み）・`lock`（ロック待ち）・`remain`（残数の判定・トレーナー宛の残数の文）・`calread`（カレンダーの読み・空きの照合）・`cal`（カレンダーの作成・削除・消化）・`sheet`（台帳・cancel_notes・振替権の読み書き）・`notify`（LINE 通知・言語の検索）・`edgeQ`（二重書きの積み込み）・`edgeSend`（写しと予約一覧の送信）・`other`（印の無い残り）・`total`。
- 印を置く場所：`handleLineGet`（auth・edgeQ/edgeSend の後の other）・`cancelReservationLine`（pre・lock・sheet・cal・sheet・notify）・`changeReservationLine`（pre・lock・sheet・cal・sheet・notify・remain・notify）・`_lbReserveCoreImpl`（既存の `_lap` に相乗り：pre・lock・remain・calread・cal・sheet・notify）・`edgeAfterWrite`（edgeQ・edgeSend）。
  ★変更の `_lbTrainerRemainText` は `_lbPush` の引数の中で評価されていた。先に変数へ取り出して `remain` に数える（評価の順は変わらない：引数は呼ぶ前に評価される）。
- 例外の扱い（関門① 指摘8）：`handleLineGet` の中で認証（`verifyLineIdToken`）か `_lbDispatch` が外へ投げた例外だけ（関門① 2周目 低）、記録してから**同じ例外を投げ直す**。`edgeAfterWrite` の中など、元々握りつぶしている例外は外へ出さない（今と同じ）。
- 終わり `_lbWpFinish(res, err)`：`[時刻, 操作, 成否(1/0), コード, 版, 最後の印, 段のms…]` を `LB_WRITE_PERF` の先頭に足し、60件・8,000バイトを超えた古いものから落とす。**例外の回も記録してから投げ直す**（ふるまいは変えない）。
  - 操作は `line_` を外した**固定の集合の名前だけ**。コードは**既知のコードの許可リスト（`LB_WP_CODES`）に完全一致したものだけ**、それ以外は `OTHER`（関門① 指摘6：正規表現では予約IDの形を通し得る）。例外は `THROW` だけを書き、例外の文は持たない。氏名・電話・LINE ID・予約ID・本文は**持たない**（数と固定の文字だけ）。
  - 記録の失敗は握りつぶす（予約の結果を変えない）。読めない・壊れた記録は `LB_WRITE_PERF_BAD`（時刻だけ）を立てて作り直す。
  - ★ロックは取らない（裏の押し出しと同じ ScriptLock を取ると、計測が遅さを作る）。だから**同時に終わった2件のうち1件が落ちることがある＝標本であって全数ではない**。全数は既存の booking_metrics（`_lbLogOutcome`）が持つ。
  - 記録そのものが応答に足す時間は Properties の読み書き各1回（未計測。反映後に `total` と画面の `?perf` の差で見る）。
- 対象の操作：`makeReservationLine`・`makeReservationLineProxy`・`makeBatchReservation`・`makeBatchReservationProxy`・`makeTransferReservation`・`cancelReservation`・`changeReservation`・`ownerFreeCancel`・`ownerFreeChange`（すべて `line_` つき）。`liffApi`（旧経路）は対象外。

### 読み方（gas/EdgeJob.js）
- `remaining` に `args.writePerf`（真）を足す。`writePerfText()` が操作ごとに 件数・成功数・各段の中央値/90%/最大、直近10件の生の行（時刻・操作・成否・コード・版・段）を返す。`_ejScrub` を通す。
- 新しい op は足さない（`ops/job.json` の許可一覧の変更は要らない）。

## B. 書き込みの後の GAS 落ちを、枠だけ・追いつくまでに縮める

### 比べた手段
| 手段 | 速さ | 正しさ | 判定 |
|---|---|---|---|
| B1. 35分を短く（例 5分） | 5分は GAS | ✗ 5分以内に枠が追いつく保証が無い（設計42 の予算超え・ロック見送り・トリガー遅れ）。自分が取った枠が空いて見える事故（2026-10-03）を再発させ得る | ✗ |
| B2. edgeAfterWrite で枠も同期で送る | すぐ Worker | ✗ 押し出しは24.5秒（設計42 実測）。応答をさらに25秒遅くする。2026-10-11 に巻き戻しで外した経路 | ✗ |
| B3. 書き込みの通し番号を枠の写しに持たせる | 追いつけば Worker | △ 枠は全トレーナーをまとめて作る。番号ではなく「カレンダーをいつ読み始めたか」が本質 | △ |
| **B4. 残数・予約一覧は応答の印で即解除。枠だけ「書き込みの時刻 ≦ 枠を読み始めた時刻」を Worker が確かめたときに Worker から出す** | 残数・一覧は即 Worker／枠は追いつき次第（約30秒〜10分）Worker | ◎ 枠の比較は GAS の時計どうし（端末の時計を使わない）。確かめられなければ GAS | ◎ 採用 |

### B4 の中身

**GAS**
1. `buildAndCacheSlots`（gas/コード.js）：`buildAvailableSlots()` を呼ぶ**直前**の時刻を `LB_SLOTS_READ_START_LOCAL` に残す（実行ごとの変数・builtAt と同じ作り）。
2. `pushToEdgeSlots`：自分で作り直せたとき（`builtSlots` がある）だけ、その実行の読み始めの時刻を `_edgeSendSlots` → `_edgeSlotRows` に渡し、payload に `readStartAt` として載せる。作り直せなかった（前のキャッシュ）・キャッシュから読む経路は**載せない**（＝Worker は確かめられない＝GAS へ）。巻き戻し防止（`builtAt` の比較）は変えない。
3. `edgeAfterWrite`：入口で `_writeAt = Date.now()`（書き込みの処理が返った後＝カレンダーの変更は済んでいる）。次の全部が成り立つときだけ `res.edgeSyncedExceptSlots = true` と `res.edgeWriteAt = _writeAt` を応答に載せる。
   - 操作が `EDGE_SLOTS_ONLY_LAG`（予約・代行予約・まとめて予約・代行まとめて予約・振替予約・取消・変更・オーナーの無料取消・無料変更）にある。固定枠の追加・削除・ブロック・未登録枠は**入れない**（固定枠の写し・トレーナーの枠一覧は送っていないため）
   - `_syncedHome && _syncedResv`（残数と予約一覧を送れた）
   - `typeof _seq === 'number'`（通し番号を積めた＝D1 の残数は作り直しが追いつくまで答えない）
   既存の `edgeSynced` は変えない。

**Worker（`worker/src/routes/compat.js` `compatTrainerSlots`・`slots.js`）**
4. `readCache` は payload の `readStartAt`（正の有限数だけ・それ以外は null）を返し、`routeSlots` の cache の答えに `readStartAt` を足す。
5. `body.slotsAfter` があるとき（数として読めない・範囲外なら答えない）：
   - 写し（cache）以外の経路（カレンダーから計算した①）は答えない（`calendar_path`）
   - `readStartAt` が無い → 答えない（`no_read_start`：古い GAS・前のキャッシュ）
   - `readStartAt < slotsAfter + 2000`（時計の差の余裕2秒）→ 答えない（`behind`）
   - それ以外は今までどおりの判定（古い・連続ルール等）を通したうえで、応答に `slotsAfterOk: slotsAfter` を載せる
   - 答えた／答えなかった理由を `remain_source_daily` の entry `slots_after` に数える（`ctx.waitUntil`・1日500件まで・既存の表と同じ上限）。★GAS の日次点検は entry `slots_after` を「写しに落ちた」に混ぜず、別の行に出す。
   - `slotsAfter` が無いときは今と1文字も同じ。

**画面（`liff/index.html`）**
6. スイッチ `WL_DEFAULT_ON = false`。`?wl=1` で `lb_wl=1` を保存、`?wl=0` で消す。オフのときは今と同じ（新しい応答の印を読まない）。
7. 書き込みの数（`_edgeWritesInFlight`）を `_apiSend` で送る前に+1、成功・失敗・例外のどれでも応答の後に−1（関門① 指摘4）。書き込みの応答で、オンで、`success === true` かつ `edgeSyncedExceptSlots === true` かつ `edgeWriteAt` が正の整数で、**自分を除く書き込みの数が0**のとき：
   - 枠待ちの印 `lb_edge_slots = <端末の時刻+35分>|<edgeWriteAt>` を書く（既にあれば edgeWriteAt は大きい方）。**それから**全体の印（`lb_edge_stale`）を消す。
8. `_edgeTry`：全体の印があれば今と同じ（GAS）。全体の印が無く枠待ちの印があるとき、`getTrainerSlots` だけ Worker へ `slotsAfter=<edgeWriteAt>` を付けて聞く。応答の `slotsAfterOk` が送った値と**一致したときだけ**使い、枠待ちの印を消す（その間に別の書き込みで値が上がっていたら消さない）。一致しない・無い（古い Worker）・失敗 → GAS。ほかの読み取り（会員状態・予約一覧・残数・予約の選択肢・まとめ取得）は Worker へ。
9. 枠待ちの印は35分で自然に切れる（今の上限と同じ）。

### 判定できないとき（倒れる向き）
| 起きたこと | 画面に出るもの |
|---|---|
| 古い GAS（印を載せない）・写しの送信失敗・番号を積めない・対象外の操作 | 今と同じ（35分 GAS） |
| 枠の写しに読み始めの時刻が無い・書き込みより前・①の経路・古い Worker | 枠だけ GAS（遅いが新しい） |
| 端末に保存できない（localStorage が使えない） | メモリの値で同じ動き（再読み込みで消える＝今と同じ弱さ。今も `_edgeStaleMem`） |
| スイッチがオフ | 今と同じ |

### 不変条件（MODEL.md に足す）
- I77：書き込みの計測は数と固定の文字だけ（個人情報なし）。記録の失敗で予約の結果を変えない。例外の回も記録してから投げ直す。ロックを取らない（標本）。検査 `write-perf.test.js`
- I78：書き込みの後、Worker が空き枠を答えてよいのは「`slots_cache` の `readStartAt`（その写しがカレンダーを**読み始めた**時刻）≧ 書き込みの時刻＋2秒」を Worker が比べ、`slotsAfterOk` を返したときだけ。比べるのは GAS の時計どうし。画面は一致を確かめてから使う。残数・予約一覧の解除は、写しと予約一覧を送れて通し番号を積めた操作（枠以外に遅れる写しが無い操作）だけ。検査 `write-latency.test.js`・`liff-write-latency.test.js`

## C. 応答の前から外せる処理の候補（★実測の後に決める・この設計では組み替えない）
| 候補 | 今 | 外す方法 | 壊してはいけないもの |
|---|---|---|---|
| C1 予約の通知がロックの中 | `_lbReserveCoreImpl` の `_lbNotifyReservation` がロックを持ったまま LINE を送る（429 の再試行込み）。ほかの書き込みと裏の押し出しを待たせる | ロックを離した後に送る（予約は台帳に書き終わっている） | 通知の失敗の積み込み（設計17）・変更は suppressNotify |
| C2 変更の通知2通（再試行あり） | `changeReservationLine` は予算なしで2通・`_lbTrainerRemainText`（残数の計算） | 取消と同じ予算（設計36）を当てる・会員宛を積む | トレーナー宛は必ず送る（取消と同じ考え方） |
| C3 取消の通知 | 予算4秒・その枠のトレーナーは必ず直接 | 会員宛を既存の通知の積み込み（`_lbNqDefer`・設計17）へ永続化し、予約直後の一回限りトリガー（`_lbCalSyncAfterWrite`）の実行の中で取り出す（★今の `_lbCalSyncAfterWrite` は通知を扱わない＝取り出しを足す設計が要る・関門① 指摘7） | その枠のトレーナーは応答の前のまま（設計36）。トリガーが作れなければ今と同じ |
| C4 edgeAfterWrite の氏名の引き直し | 取消・変更は氏名を返さない（意図的）ので `_edgeNameByCustomerId` が名簿シートを読む | 写しの計算に氏名が要るかを調べる（要らなければ読まない） | 応答に氏名を載せない（2026-10-08 関門②） |
| C5 ロック待ち | 裏の押し出し（すぐ押し出し約16秒・枠の押し出し約2.5秒）と同じ ScriptLock | 実測の lock の分布を見てから（押し出し側のロックの持ち方を細かくする） | 二重予約の防止 |

## 変えないもの
- 書き込みの中身・判定・通知の相手と順序（印を足すだけ。変更の `_lbTrainerRemainText` を変数に取り出すのは評価の順が同じ）
- `edgeSynced` の意味・`_edgeSendSlots` の巻き戻し防止・枠を送る経路・Worker の枠の計算
- `slotsAfter` が無いときの Worker の答え

## main に入ると本番で起きること／戻し方
- LIFF：スイッチがオフなので何も変わらない。`?wl=1` を付けた端末だけ新しい動き。戻すのは `?wl=0`。
- Worker：`slotsAfter` を送るのはオンの端末だけ。送られなければ今と同じ。`readStartAt` を返す欄が1つ増える（数だけ）。
- GAS：オーナーの反映1回（設計42 の反映待ちと同じ回にまとめられる）。反映するまで LIFF がオンでも今と同じ（印が来ない）。戻すのはコードを戻して反映。
- 全員へ広げる（`WL_DEFAULT_ON=true`）は単独の PR で関門③。

## 反映後に確かめること
1. 作業依頼 `remaining {writePerf:true}` で、取消・変更・予約の段の分布（どこが遅いか）。版が `2026-11-13c` で記録されていること。
2. `?wl=1` の端末で取消 → 画面の `?perf` に `edge:getMyReservations` 等が出る（GAS に落ちていない）・枠は `edgeNG…（書き込みより前）` の後に `edge:getTrainerSlots` へ戻る。
3. `/quota/status` の `slots_after` の行（ok／behind／no_read_start の回数）。

## 関門① 1周目（Codex スレッド 01a1d44d-54d8-72a2-8750-92ce0ce5336c・2026-11-13）
判定：差し戻し（高2・中4・低2）。対処：

| # | 指摘 | 対処 |
|---|---|---|
| 高1 | 読み始めが後でも、別実行の `getEvents` が直前の `createEvent/deleteEvent` を見る保証が未確認。2秒は時計の余裕でしかない | **一部却下（理由つき）・文言を直す**。二重予約の防止（`_lbReserveCoreImpl` の `calB1.getEvents` と `_lbCheckTrainerAvailable`）は、**別実行の直前の `createEvent` が次の `getEvents` に見えること**に既に依存している（同じ前提が崩れれば今でも二重予約になる）。GAS に落ちた枠（今の35分）も同じ `buildAvailableSlots` の `getEvents` で作るので、GAS 経路の正しさも同じ前提の上にある＝B4 は新しい前提を足さない。I78 の「確かめた」を「読み始めの時刻を比べた」に直した。全員へ広げる前（関門③）に、オーナーの端末で予約→取消→枠の見え方を確かめる（スイッチは既定オフ）。イベントIDを枠の作り直しで照合する案は、取消（不在の証明）を枠の出力から判定できず、`buildAvailableSlots` の中身を変えることになるので採らない |
| 高2 | 変更で旧予定の削除失敗を握りつぶして成功を返す。書き込みの時刻でカレンダーの変更が済んだとは言えない | **却下（理由つき）**。削除の失敗（`_lbDeleteReservationEvents` は例外を Logger に流して続ける）で残った予定は**カレンダーそのものに残っている**。GAS の枠もカレンダーから作るので同じく埋まって見える＝Worker と GAS で見え方は変わらない（B4 が扱うのは「写しが古い」差だけ）。カレンダーへの書き込みはすべて応答の前に同期で終わる（予約・まとめて予約・振替＝`createEvent`、取消＝削除/消化、変更＝作成と旧の削除）。応答の後に回すカレンダー操作は無い |
| 中3 | 巻き戻し防止は `builtAt`（読み終え）だけ。長い古い作り直しが新しいものの後に送られ得る | **既存の穴として記録・この設計では直さない**。`slotsAfter` を付けた読み取りは行ごとの `readStartAt` で拒否できる（B4 は守られる）。通常の端末に対する順序の穴は今もある（設計42 以前から）。直すなら `_edgeSendSlots` の比較に読み始めを足す別の変更（関門①から）。同じ押し出しの全トレーナーの行が同じ `builtAt`・`readStartAt` を持つことは検査で固定する |
| 中4 | 並行する書き込みの数え方が未定義 | 直した（B4 の7）。古い応答が後から来ても `edgeWriteAt` は大きい方を残し、新しい枠待ちの印を消さない（8）。検査に入れる |
| 中5 | 段の印の付け方が曖昧 | 直した（「終えた直後に終えた段の名前で」・ロック待ちの前後） |
| 中6 | コードを正規表現で通すと予約IDの形も通る | 直した（許可リストに完全一致） |
| 低7 | C3 の書き方が事実と違う | 直した |
| 低8 | 投げ直す範囲 | 直した（`_lbDispatch` の例外だけ） |

## 関門① 2周目（Codex スレッド 01a1d451-d8f0-7353-b18b-4edd41a93eae）
1周目の却下・範囲外3件は「該当行から成り立つ」。残り低1件（認証の例外が計測から漏れる）→ 認証の例外も記録して投げ直すと直した。これで関門①は通過とする（残りは低の文言1件のみで、直した内容は指摘の直し方そのまま）。

## 関門② 1周目（Codex スレッド 01a1d464-2fca-7182-8fba-64d77431c100）
判定：差し戻し（高0・中3・低1）。予約・取消・変更の結果を計測が変える経路、B で古い枠を採る経路は無し。
| # | 指摘 | 対処 |
|---|---|---|
| 中1 | 公開の `slots`／`mySlots`（routeSlots を直に返す）の答えに `readStartAt` が増える | 直した。`routeSlots` に `internal` を足し、`{ readStartAt: true }` のときだけ載せる。渡すのは `compatTrainerSlots` が比べるときだけ。index.js は渡さない（`write-latency.test.js` ③-18・③-19） |
| 中2 | `WORKER_BUILD` が古い | 直した（`2026-11-13c`） |
| 中3 | JSON としては読めるが中身が外れた記録を作業依頼に出せる | 直した。`_lbWpValidRow`（操作9つ・許可リストのコード・版の形・最後の印・非負整数）を書くときも読むときも通す。外れた行が1つでもあれば印を立てて作り直す。読み出しは外れた行を出さず数だけ。段の名前は記録の中を信用しない（`write-perf.test.js` ④-7〜④-9） |
| 低1 | まとめて予約のロック待ちが pre に入る | 直した。`_lbBatchReserve` の `tryLock` の前後に pre／lock（⑤-10） |
自分で見つけて直したもの：書けないのに読める端末で枠待ちの印が残らないまま全体の印を外す穴 → 印を読み直して確かめてから外す（`liff-write-latency.test.js` 3-15）。

## 関門② 2周目（Codex スレッド 01a1d46b-560e-70d1-bb6f-d6d17db8421f）
判定：**通過**。1周目の4件は直っている・新しい不具合・I77/I78 違反・個人情報の出口は無し。
