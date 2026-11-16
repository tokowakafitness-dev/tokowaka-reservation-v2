# 設計45 予約・取消の待ち時間を縮める：写しの送信を応答の後ろへ回し、古い写しは Worker が答えない

> 2026-11-16・CTO（CEO玄から受けた）。設計43 A の実測（本番 `LB_WRITE_PERF`・11/14〜15・7件）を受けた続き。
> 版の印：GAS `LB_HEALTH_BUILD`・`LB_EDGE_BUILD` を `2026-11-1Xa`（実装日）に。Worker `WORKER_BUILD` も同じ日付。
> 戻し方：Script Property `LB_EDGE_DEFER`（既定オフ＝`'1'` のときだけ後ろへ回す）。オフなら GAS は今と1文字も同じ動き。

## 目的（1行）
会員の予約・取消の応答を待たせている最大の段「写しの送信（edgeSend・中央 5.9〜6.2秒・最大 8.9秒）」を応答の後ろへ回し、そのあいだ古い写しを顧客に出さないことを Worker が自分で判定する。

## 実測（設計43 A の記録・段の中央値・秒）
| 段 | 予約 makeReservationLine（4件） | 取消 cancelReservation（3件） |
|---|---|---|
| auth | 0.5 | （小） |
| pre | 2.9 | 1.0 |
| lock | 0.1 | （小） |
| remain | 1.7 | — |
| calread | 0.7 | — |
| cal | 0.9 | 1.4 |
| sheet | 0.5 | 0.6 |
| notify | 3.7 | 2.2 |
| edgeQ | 1.5 | 1.4 |
| **edgeSend** | **5.9** | **6.2（最大 8.9）** |
| other | 0.4 | （小） |
| total | 17.9 | 13.5（最大 18.1） |

LIFF の書き込みの待ち切りは 20秒（`liff/index.html` `_rawApi` の `limit`）。決定0139：取消が20秒に近いうちはキャンセル理由（`CXL_DEFAULT_ON`）を全員に出さない。

## 段の中身（コードで確かめた事実・推測ではない）
- **auth**：`handleLineGet` の `verifyLineIdToken`（5分のキャッシュ・外れたら api.line.me へ1往復）。
- **pre**（予約）：`_lbDispatch` → `makeReservationLine` の `getCustomerByLine`（会員名簿 13列を全行読む）・`_lbContractTypeOf`（契約の1時間キャッシュ・外れたら請求ブックを全部読む）→ `_lbReserveCoreImpl` の `_lbBookingGate`（Properties・オンボード中なら棚卸しと名簿も読む）・受付締め切り・予約できる最終日。
  **pre**（取消）：`getCustomerByLine`・`getTrainerByLine`（トレーナー名簿）・台帳の行数・`_lbCnReady`（cancel_notes の見出し）。
- **remain**：`getBookableRemaining` ＝ 契約を**毎回読み直す**（`_lbContractRowsAll(..., fresh=true)`・M2：取消直後の古いキャッシュを避けるため＝意図的）・`_lbPhoneByCustomerId`（名簿をもう一度全行）・`_lbResvSessions`（台帳を全行）・`_lbMemberOpeningWithFloor`（棚卸しの表と名簿）・割当の計算。
- **notify**（予約）：`_lbNotifyReservation` ＝ 会員へ LINE 1通 → `getTrainerLineId`（トレーナー名簿）→ `_lbTrainerRemainText`（`_lbBuildHome`＝残数の計算をもう一度）→ トレーナーへ LINE 1通。★ロックの中。
  **notify**（取消）：`_lbCxlAfter` ＝ その枠のトレーナーへ直接 → （理由があれば）担当 → 会員（言語の検索つき）→ cancel_notes の印と掃除 → booking_metrics。予算 4秒（設計36）。ロックの外。
- **edgeQ**：`edgeAfterWrite` の入口から `lbDwEnqueue` の後まで ＝ `_lbScheduleCalSync`（`getProjectTriggers`・同名の削除・一回限りトリガーの作成）・会員の特定（予約は応答に会員IDが無いので `getCustomerByLine` をもう一度）・氏名（取消は `_edgeNameByCustomerId` で名簿をもう一度）・`lbDwEnqueue`（ScriptLock＋Properties 2〜3回）。
- **edgeSend**：`_edgeSendAfterWrite` ＝ `pushToEdgeHomeFor`（`_edgeHomeRows`＝当月と翌月の残数の計算・Worker へ POST 1回）＋ `_edgePushReservationsFor`（`_edgeReservations`＝台帳全行と名寄せ・Worker へ POST 1回）。直列。

★1回の予約で、会員名簿を最大4回・台帳を3回・残数の計算を4回（判定1・トレーナー宛1・写し2）読む／行っている。

## なぜ edgeSend が応答の前にあるか（いまの不変条件）
1. 写し（`member_home`）と書き込みの印（`dirtySeq`）は**同じ batch** で D1 に入る（`pushToEdgeHomeFor` → ingest `dirtyStatement`）。だから「D1 の残数は作り直しが追いつくまで `behind_write` で答えない → 写しへ落ちる」とき、**落ちる先の写しは必ず書き込みの後のもの**になっている。
2. 写しにしか無い値（振替権 `transferCredits`・MODEL §5）は、D1 が答えるときも写しから補う。
3. 予約一覧の写し（`reservations`）は D1 では鮮度の門を通らない（`fresh.js` は残数の計算だけ）。応答の前に送っているから、別の端末・トレーナーの画面も応答の時点で新しい。
4. 画面（`?wl=1`）が残数・予約一覧を Worker に戻す印 `edgeSyncedExceptSlots` は、写しと予約一覧を送れたことが条件（設計43 B・I78）。

→ edgeSend をただ後ろへ回すと、1 と 3 が崩れて**書き込み前の残数・予約一覧が顧客に出る**（MODEL §0 違反）。後ろへ回すなら、Worker が「写しが書き込みより古い」と判定できる印を先に作る必要がある。

## 比べた手段

前提：GAS の doGet/doPost は返事の後に処理を続けられない。トリガーは定期18本（日次点検 11/14）で上限20。

| 手段 | 縮む見込み（予約／取消） | 変える面積 | 戻せるか | オーナー操作 | 静かに壊れる経路 |
|---|---|---|---|---|---|
| **M1** 応答の前のまま軽くする（2つの POST を `fetchAll` で並べる・同じ表の読み直しを実行内で覚える・残数の計算の重複を除く） | edgeSend の内訳が未計測のため**言えない**（POST と計算の割合が分からない）。表の覚え直しは書き込みの後の読みと食い違うと**誤った残数**になる | GAS だけ・広い（読む関数が多い） | コードを戻して反映 | GAS 反映1 | 覚えた値が書き込みの後で古い → 写しが古いのに「同期済み」。検査で全部の書き手を見つけないと塞げない |
| **M2（推奨）** 写しの送信を、既にある一回限りトリガー `_lbCalSyncAfterWrite` の先頭へ回す。応答の前は「書き込みの印」だけを Worker に送る。Worker は写しが印より古ければ答えない | 予約 **17.9 → 12.0＋m 秒**／取消 **13.5 → 7.3＋m 秒**（最大 **18.1 → 9.2＋m 秒**）。m＝印の送信1回（未計測・下の「見込みの計算」） | GAS（出口と一回限りトリガー・定期の写しに番号）＋Worker（列2つ・門2つ）＋migration 1 | `LB_EDGE_DEFER` を消す＝今と同じ（Worker の門は残っても今と同じ答え：下の I79） | GAS 反映1・push 1（Worker と migration）・スイッチ1 | トリガーが動かない／遅い → その会員は Worker が答えず GAS（遅いが正しい）。5分ごとの同期が拾い、日次点検で数える |
| **M3** 通知（notify）を応答の後ろへ（同じ一回限りトリガー、または通知の積み込み） | 予約 最大 −3.7 秒／取消 最大 −2.2 秒（送り先の業務規則しだい） | GAS | 同 | GAS 反映1 | トリガー遅れ＝確認の LINE が数十秒遅れる。**誰へ即時に送るべきかは業務の規則**＝この設計では決めない（オーナーへの質問1） |

**推奨は M2。** 理由：いちばん大きい段を、業務の規則を変えずに、新しいトリガーを作らずに外せる。正しさは「応答の前に送ったから新しい」という時刻の前提から、「印と写しの番号を Worker が比べる」という判定に移る＝別の端末・写しの送信の失敗にも効く（いまある穴も1つ塞ぐ：下の「いまある穴」）。M1 は内訳の実測（下の A3）を見てから、M3 はオーナーの答えを見てから、別の設計で扱う。

## M2 の中身

### 番号の考え方（1つだけ）
- 書き込みの通し番号 `seq`（`lbDwEnqueue`・全体で1本・減らない・設計20）を基準にする。
- **写しが番号 C を「含む」** ＝ 写しを作るために台帳・契約を読み始める**前**に、いまの番号 C を読んだ（`_lbDwCurrentSeqInLock` と同じ読み・ロックなし）。番号は台帳を書き終えた後に発行されるので、C 以下の書き込みは必ず読んだ台帳に入っている（逆は保守的に外れるだけ）。
- D1 の `customer_sync_version` に2列を足す：`home_covers_seq`（その会員の写し `member_home` が含む番号）・`resv_covers_seq`（その会員の予約一覧の写しが含む番号）。
- **写しの行と covers は同じ batch で書く。後から書いた方で両方とも置き換わる（MAX にしない）。** 定期の押し出しが書き込みより前に読んだ古い写しを後から書いた場合、covers も下がる＝門が閉じる（遅いが正しい）。

### I79（新しい不変条件）
**会員 X が「閉じている」＝ `dirty_seq > 0` かつ（covers が NULL か `dirty_seq > covers`）。home の covers で閉じた会員には、Worker は残数（D1 から作った値も写しも・振替権も）を答えない。resv の covers で閉じた会員について、予約から作った値（予約一覧・今後の件数・次回予約・次回予約なし）を答えない。** 単独の会員を返す入口は `success:false`（FALLBACK）で返し、画面は GAS に聞く（`_edgeTry`：`success !== true` は GAS）。
- **NULL は閉じる側**（MODEL §8「NULL のとき答えない」）。`dirty_seq = 0`（一度も書き込みの印が無い会員）は開いている。
- D1 の残数が新しい（`fresh.js` が ok）ときも、写しにしか無い値（振替権）を写しから補うので、home の門は同じく閉じる。

### Worker
1. migration `0034_write_covers.sql`：`ALTER TABLE customer_sync_version ADD COLUMN home_covers_seq INTEGER; ADD COLUMN resv_covers_seq INTEGER;`。**初期化しない（NULL のまま＝閉じる）**。既定値は入れない（MODEL §8）。
   - 理由（関門① 中1）：「いまは写しと印を同じ batch で送っているから covers＝dirty」は、写しの送信だけ失敗した会員・振替権が読めず写しを作れなかった回（`_edgeHomeRows` 489〜506行）・打ち切り（909〜930行）で嘘になり、定期の写しは成功の期限ではないので「最大30分で直る」も保証できない。だから**証明できた会員だけ開く**：初期化の後、GAS の番号つきの押し出し（home 30分・予約一覧 15分）が成功した会員から順に開く。
   - その間（Worker push から最大30分＋失敗の再試行）、書き込みの印を持つ会員（`dirty_seq > 0`）の残数・予約一覧は GAS に落ちる（遅いが正しい）。Worker push の直前に GAS の反映を済ませ、push の後に `pushToEdgeHome`・`pushToEdgeLight` を作業依頼か手動で1回ずつ走らせると窓が縮む（作業依頼で走らせられるかは未確認）。
2. ingest（`worker/src/routes/ingest.js`）：本文の `coversSeq`（正の安全な整数だけ・それ以外は 400 `BAD_COVERS_SEQ`）を受ける。
   - `kind:'home'`：書いた会員（行の customer_id）ごとに `home_covers_seq = coversSeq` を行と同じ batch に積む（行の無い会員は触らない＝作れなかった会員は閉じたまま）。
   - `kind:'reservations'`：covers を立てる会員は**送り手が明示する**（関門① 高2）。会員別の送信は `customerId`。定期・完全同期の全体送信（`scope:'all'`）は本文の `coveredCustomers`（その回に台帳を走査した会員IDの全部・予約0件の会員を含む・最大 MAX_ROWS）を載せ、その全員に `resv_covers_seq = coversSeq`。★変わっていない行を書かずに飛ばしても covers は立てる＝中身は同じ。`coveredCustomers` の無い全体送信は covers を触らない。
   - `coversSeq` が無い送信は covers を触らない（古い GAS・印だけの送信）。
   - covers は行と同じ batch・**後から書いた方で置き換える（MAX にしない）**。
   - `customer_sync_version` に行が無い会員は作らない（dirty も 0 なので門は開いている）。
3. 門：`worker/src/lib/write-covers.js` に `coversGate(env, customerIds)` を1つ置き、`{ homeBlocked:Set, resvBlocked:Set, readFailed }` を返す（1文で読む）。**読めなければ全員閉じる**（MODEL §0）。
   - **読む前と読んだ後の2回見る（関門① 3周目 高）**：門を見てから値（写し・予約）を読むまでの間に印だけの送信が入ると、開いていると判定した後に古い値を読んで返し得る。→ 各経路は「門（前）→ 値を読む → 門（後）」とし、**後の門で閉じていれば読んだ値を捨てて、閉じたときの扱い（FALLBACK・`'unknown'`・確認中）にする**。前の門は無駄な読みを省くためだけ。読み取りを `env.DB.batch` で同じ1回にまとめられる経路は、値の文の**後ろ**に門の文を置けば同じ意味になる。
   - 後の門より後に印が届いた場合に返る値は「GAS で書き込みが済み、印がまだ D1 に届いていない」間の値で、これはどの作りでも残る窓（今も、書き込みから応答の前の送信が D1 に届くまでの数秒は古い値が返る）。後の門はこの窓を広げない。
   - 検査：身代わりの D1 で「前の門の後・値の読みの前に dirty だけの batch を入れる」順序を作り、捨てて閉じた扱いになることを確かめる（経路の表の全行）。
   - **残数**：`readHome`（`boot.js` 73行）の**最初**、`readHomeDiag` を呼ぶ前に home の門（関門① 中2）。閉じていれば `null`（status `covers_behind`）を返し、写しも D1 も読まない。振替権も出ない。
   - **予約から作った値（関門① 高1で漏れていた経路を含む全部）**：
     | 経路 | 返すもの | 閉じたとき |
     |---|---|---|
     | `routeBoot` 会員（boot.js 213〜237） | home・reservations | 会員が閉じていれば全体 FALLBACK（home は上の門で null になるが予約一覧が残るため） |
     | `routeBoot` トレーナー／オーナー（boot.js 240〜264） | 顧客ごとの `upcoming` | 閲覧範囲の顧客に1人でも閉じた会員がいれば全体 FALLBACK |
     | compat の会員の予約・顧客カード・トレーナーの予約（compat.js 173〜202 ほか） | 予約一覧 | 単独の会員はその会員で、トレーナーは**閲覧範囲の顧客集合全体**を門に渡す（返った行の会員ではない＝追加の予約が写しに無い会員を見逃さない・関門① 中3）→ 1人でも閉じていれば FALLBACK |
     | `customer.js` の予約を読む経路 | 予約一覧・件数 | 同上 |
     | karte 概要の次回予約（karte.js 1248〜1283） | `nextReservation` | ★FALLBACK にしない（カルテの `kRead` は GAS に逃げず `success:false` で概要ごとエラーになる＝liff/karte.js 690〜693・関門① 2周目 高1）。新しい画面が要求に `nextUnknownOk:true` を載せたときは `nextReservation:null, nextReservationUnknown:true` を返し、画面（liff/karte.js 642）は「次回の予約：確認中」と出す（今の画面は null を「次回の予約なし」と出すので、印なしで null を返してはいけない）。印の無い要求（反映前に開いていた古い画面）だけは概要ごと `success:false`（再読み込みで直る・数える） |
     | karte board（karte.js 1430〜1466） | `noNextBooking` | 閉じた会員だけ `'unknown'`（既にある値・画面は扱える） |
     | `remain-from-d1.js` の件数（359〜369） | — | 門を足さない（読む前に `readSyncVersionForRemain` が `built_covers_seq >= dirty_seq` を確かめる＝I31・関門① 低1で確認済み） |
     ★オーナーの閲覧範囲は全顧客なので、誰か1人の書き込みの後、写しが届くまで（下の見込み）オーナーの顧客一覧・トレーナーの予約一覧は GAS に落ちる。正しさを優先した代償として受け入れ、`covers_resv` の回数で数える。
   - 検査：Worker のソースから `reservations` を `FROM`／`JOIN` で読む SQL を**全部機械で取り出し**、門を通る関数か許可した例外（remain-from-d1・ingest・quota 系の内部）の一覧に入っているかを確かめる（記憶「リストの複製を直す前に全部数える」）。
4. 数える：門で答えなかった回を `remain_source_daily` の entry `covers_home` / `covers_resv`（`ctx.waitUntil`・1日500件まで・既存の表と上限）。日次点検は残数の出どころと混ぜない別の行に出す。
5. 見張り（関門① 中5・2周目 中1）：migration にさらに `home_blocked_since`・`resv_blocked_since`（INTEGER・NULL）を足す。**閉じた瞬間の時刻を持ち、開いたら NULL に戻す**（既存の `dirty_since` は D1 の作り直しが追いつくと NULL になるので、covers だけ遅れている会員の経過を測れない＝0020 migration 11行）。dirty の文と covers の文の両方で `CASE`（閉じた かつ since が NULL → いま／開いた → NULL／それ以外 → そのまま）。migration の直後は NULL＝閉じているが since も NULL なので、見張りは「since が NULL の閉じた会員」を別の数（移行の残り）として出す。
   `/quota/status`（共有の合言葉で守られた既存の窓口・quota.js 255・521行）に「閉じている会員の数（home／resv 別）・移行の残りの数・最も古い since からの経過分」を足す（会員IDは出さず数だけ）。**退会の会員（`customers.contract_status = '退会'`）は数えない**：定期の写しは退会の会員を作らない（PushToEdge.js 904行）ので home は閉じたまま＝門は効いたまま（GAS・遅いが正しい）だが、見張りを汚さない（関門① 2周目 中2）。GAS の日次点検はこれを読み、**10分より長く閉じている会員がいれば warn・60分なら high・移行の残りが Worker push から2時間を過ぎて0でなければ warn**。GAS 側の待ちが消えても、Worker 側の事実で気づける。
6. 文の順序（関門① 2周目 中3）：1回の送信の batch の中で、**covers と since の文は dirty の文（`dirtyStatement`・ingest.js 407〜420行）の後ろ**に積む。行の無い会員は dirty の INSERT が行を作ってから covers が入る＝スイッチがオフの書き込み直後の送信は「閉じずに開いたまま」（今と同じ答え）。dirty の無い送信（定期）で行の無い会員は covers の UPDATE が0行＝dirty も0なので開いている。検査で順序を固定する。
7. `coveredCustomers` の上限（関門① 2周目 低1）：2,000件を超えたら Worker は 400 `COVERED_TOO_MANY` で**その送信を断る**（行も covers も書かない・中途半端に立てない）。GAS は失敗として記録し、見張りの数で見える（いまの会員数は数十名）。

### GAS
6. 定期の写しに番号を載せる：`pushToEdgeHome`（30分）・`pushToEdgeLight` の予約一覧（15分）・`pushToEdgeFullSync`・`pushToEdgeHomeFor`・`_edgePushReservationsFor` は、**台帳・契約を読み始める前**に `C = _lbDwCurrentSeqInLock()` を読み、`_edgePushRows` の本文に `coversSeq: C` を載せる（C が 0・読めない＝載せない）。打ち切り方式の押し出しは「その回の読み始め」の C を使う。全体の予約一覧の送信（PushToEdge.js 1280行の `_edgeReservations()`）は、`_edgeCustomers()`（1276行）の全会員IDを `coveredCustomers` として載せる（予約0件の会員も covers が進む＝関門① 高2）。複数の batch に分かれる送信では、最後の batch（`final:true`）にだけ載せ、Worker は final の batch でだけ covers を立てる（途中の batch で立てると、まだ送っていない行の会員を開いてしまう）。
   ★これはスイッチに関係なく入る（covers が書き込みのたびに正しく進むため）。スイッチがオフでも、書き込みの直後の送信は今どおり印と写しを同じ batch で送り、covers＝その番号（以上）になる＝門は開いたまま＝今と同じ答え。
7. 出口 `edgeAfterWrite`：`LB_EDGE_DEFER === '1'` で、操作が `EDGE_DEFER_OPS`（予約・代行予約・まとめて予約・代行まとめて予約・振替予約・取消・変更・オーナーの無料取消・無料変更＝`EDGE_SLOTS_ONLY_LAG` と同じ9つ。カレンダー同期の一回限りトリガーが必ず作られる操作だけ）にあり、**`_lbScheduleCalSync()` が true を返した**（一回限りトリガーを作れた）ときだけ、後ろへ回す：
   1. `lbDwEnqueue(cid)` で番号 `seq` を得る（今と同じ）。得られなければ今の経路（応答の前に送る）。
   2. 待ち `LB_EDGE_PENDING`（Script Property・`{cid: {seq, at}}`・同じ会員は seq の大きい方・最大30名・6KB）に足す。`_lbDwLocked` の中で読み書き（待ち行列と同じロック）。足せなければ今の経路。
   3. **印だけを送る**：`_edgePost({kind:'reservations', rows:[], final:true, scope:'partial', customerId: cid, dirtySeq: seq})`（既にある形・予約0件の会員で使っている。covers は載せない）。これで D1 は `dirty_seq = seq` を知り、I79 の門が閉じる。**送れなければ今の経路**（応答の前に写しと予約一覧を送る）。今の経路も落ちれば今と同じ `_lbNoteBothFail`。
   4. 応答は `edgeSynced = false`、`edgeSyncedExceptSlots` は付けない（写しを送っていない）＝画面は今と同じ35分 GAS（WL がオンでも）。
   - 会員の特定は書き込みの関数が既に持つ値を使う：`_lbReserveCoreImpl`・`cancelReservationLine`・`changeReservationLine` が実行ごとの変数 `_LB_WRITE_CUST = {id}`（会員IDだけ・氏名は持たない）を立て、`handleLineGet` の入口で null に戻す。`edgeAfterWrite` は `res.customerId` → `_LB_WRITE_CUST.id` → `getCustomerByLine` の順に使う。応答には何も足さない。後ろへ回すときは氏名を引かない（写しを作るのはトリガー）。
8. 一回限りトリガー `_lbCalSyncAfterWrite`：**先頭で** `_lbEdgePendingDrain('AFTER')` を呼ぶ（同期・二重書き・枠より前＝写しをいちばん早く届ける）。
   - 待ちを読み、会員ごとに `C = _lbDwCurrentSeqInLock()` を読んでから氏名を引き、`_edgeSendAfterWrite(cid, nm, seq)`（写しと予約一覧・どちらにも `dirtySeq: seq` と `coversSeq: C`）。
   - 両方送れた会員だけ、待ちから外す（その間に seq が上がっていたら外さない＝`_lbDwDone` と同じ考え方）。片方でも落ちたら残す。
   - 時間の上限 60秒（同期と枠の押し出しの前なので短く）。残りは次へ。
   - **並んだ実行の競合（関門① 中4）**：(a) いまは AFTER の末尾 `_lbCleanCalSyncAfterTriggers`（2223行）が**同名のトリガーを全部消す**ので、A の実行中に B の書き込みが作った B のトリガーを A が消し得る。→ `_lbCalSyncAfterWrite(e)` が第1引数のイベント（時間主導トリガーはイベントを渡す・記憶 env_gas_trigger_passes_event_arg）を受け、末尾の掃除は **`e.triggerUid` と `trigger.getUniqueId()` が完全一致するものだけ**を消す。`e` が無い・`triggerUid` が文字列でない（手で実行した等）ときは今のまま全部消す（B の待ちは TICK が拾う）。`e` を真偽で判定しない（`typeof e === 'object' && e && typeof e.triggerUid === 'string'` だけ）。書き込み側の `_lbScheduleCalSync`（作る前に未実行の同名を消して1本にまとめる）は変えない＝待ちは共有なので1本で全員を送れる。(b) A が古い番号 C=10 で送り終えるのが、B の実行が C=11 で送った後になると、写しも covers も 10 に戻る（後から書いた方で置き換え）＝門が閉じる＝正しいが遅い。B の待ちは既に外れているので、開くのは次の定期の押し出し（予約一覧 15分・写し 30分）か次の書き込み。巻き戻しで**古い値が出る順序は無い**（covers も一緒に下がるため）。この遅い戻りの回数は見張り（Worker 5）の「10分より長く閉じている会員」で数える。
9. 受け皿：5分ごとの `lbCalSyncTick` の先頭で、`at` が90秒より古い待ちだけ `_lbEdgePendingDrain('TICK')`（トリガーが消えた・遅れた・時間切れ）。新しいトリガーは作らない。★90秒は「拾う対象」の条件で、拾える時刻は5分ごとなので、トリガーが失われた回の最悪は書き込みから約6分半。
   - 待ち `LB_EDGE_PENDING` は会員ID（氏名・電話・LINE ID は持たない）と番号・時刻だけの運用の状態（計測の記録ではない）。送れたら消す。壊れていたら中身を別の Property に写さず時刻だけ印を立てて作り直す（待っていた会員は Worker 5 の見張りと定期の押し出しで回復する）。ログ・日次点検・応答には会員IDを出さない（数だけ）。24時間より古い項目は捨てて数える（定期の押し出しが回復させている）。
10. 記録（個人情報なし・数と時刻だけ）：`LB_EDGE_DEFER_COUNT` に日ごと `{deferred, inline_noTrigger, inline_markFail, inline_pendFail, sentAfter, sentTick, sendFail, maxAgeMs}`（直近3日・壊れていたら退避して作り直す＝設計42 `LB_CALSLOTS_COUNT` と同じ作り）。`maxAgeMs`＝書き込みから写しを送り終えるまでの最大。
11. 日次点検：`LB_EDGE_DEFER === '1'` のとき、昨日の `sendFail > 0`・`maxAgeMs > 10分`・待ちに10分より古い会員がいる・`inline_*` が `deferred` の2割を超える → warn。待ちが壊れている → high。スイッチがオフなら数えるだけ。
12. 段の印：`LB_WP.STAGES` の後ろに `member`（会員名簿の読み）・`edgeMark`（待ちへの追加と印の送信）を**足す**（並びの途中に入れない）。`_lbWpValidRow` は旧い長さ（17）と新しい長さ（19）の両方を通す（反映の前の記録を壊れた扱いにしない）。`getCustomerByLine` の直後に `member`。edgeSend は「今の経路で送った時間」のまま。

### 見込みの計算（実測の段から）
- 予約：17.9 − edgeSend 5.9 ＋ m ＝ **12.0＋m 秒**。edgeQ の `getCustomerByLine`（名簿1回）も省けるが未計測なので数に入れない。
- 取消：13.5 − 6.2 ＋ m ＝ **7.3＋m 秒**。最大の回：18.1 − 8.9 ＋ m ＝ **9.2＋m 秒**。
- m（印の送信1回）は未計測。GAS → Worker の1往復＋ingest の処理（customers の1行確認・dirty の1文に加え、ingest は送信のたびに対象の表の全行を SELECT して比べる＝`ingest.js` 297〜320行。行0件でも `reservations` 表の全行を読む）。**m が分かるまで上の目標は保証しない。**反映後に `edgeMark` の段で数える。m が 2秒を超えたら、印専用の小さい窓口（表を読まない）を別に検討する。
- 写しが届くまでの時間（＝その会員が Worker から答えてもらえない時間）は、一回限りトリガーの起動の遅れ（設計42 は約30秒と書いたが本番の分布は未計測）＋写しの送信 約6秒。`maxAgeMs` で数える。

### 判定できないとき（倒れる向き）
| 起きたこと | 顧客に出るもの |
|---|---|
| スイッチがオフ・古い GAS | 今と同じ |
| 一回限りトリガーを作れない・番号を積めない・待ちに足せない・印を送れない | 今の経路（応答の前に写しと予約一覧）＝今と同じ遅さ・今と同じ正しさ |
| 印は届いたが写しがまだ（トリガーの遅れ・失敗） | その会員の残数・予約一覧は Worker が答えず GAS（遅いが新しい） |
| 門の列が読めない | 全員 GAS（遅いが正しい） |
| covers が NULL（migration の直後・番号つきの押し出しがまだ成功していない会員） | その会員は GAS（遅いが正しい）。見張りの NULL の数で見える |
| 写しを作れない会員（振替権が読めない・計算の失敗・打ち切り） | covers が進まず閉じたまま＝GAS。10分で warn・60分で high |
| 定期の押し出しが書き込みより前に読んだ写しを後から書いた | covers が下がる → GAS → 次の押し出しか待ちの送信で戻る |
| 書き込みをした端末 | 今と同じ35分 GAS（WL がオンでも `edgeSyncedExceptSlots` が来ない） |

### 設計43 B（WL）・I77・I78・35分の印との関係
- **I78 は変えない。** 枠の判定（`slotsAfter`・`readStartAt`）はそのまま。後ろへ回した書き込みでは `edgeSyncedExceptSlots` を付けないので、WL がオンの端末も35分 GAS（今の既定と同じ）。WL を全員に広げる（関門③）前に、後ろへ回すことと両立させる形（例：画面は印を待たず Worker に聞き、I79 の門が閉じていれば GAS）を別の設計で決める。**スイッチ `LB_EDGE_DEFER` と `WL_DEFAULT_ON` は同時にオンにしない**（両方オンでも正しさは崩れないが、WL の効果が消える）。
- **35分の `_edgeMarkStale` は変えない。** 書き込みをした端末は今と同じく35分 GAS。
- **I77 は段を2つ足すだけ**（数と固定の文字のまま）。
- **I8・I53（D1 の残数の鮮度）は変えない。** I79 はその手前に足す門（閉じる向きだけ）。

### いまある穴（この設計で塞がるもの）
- 写しの送信だけ落ちて予約一覧が届いた回、D1 は `behind_write` で写しへ落ちるが、**落ちる先の写しは書き込みの前**（ingest は予約一覧の送信でも dirty を立てる・`readHome` は dirty を見ない）。I79 の home の門で GAS へ倒れるようになる。

## 変えないもの
- 書き込みの中身・判定・通知の相手と順序・通知の予算（設計36）
- 枠の写しと I78・`edgeSynced` の意味・35分の印
- D1 の残数の計算と鮮度の判定（`fresh.js`）
- スイッチがオフのときの GAS の応答と送信の順序（covers を載せる欄が1つ増えるだけ）

## main に入ると本番で起きること／戻し方（段階）
**順序は「GAS 反映 → Worker push（migration 込み）」。** 逆にすると、古い GAS は covers を送らないので、Worker の後に書き込みのあった会員から順に dirty が covers を追い越し、門が閉じて GAS に落ちる（正しいが遅くなる会員が増える）。
1. **GAS 反映**（オーナー1回・他の反映待ちと同じ回にまとめる）：スイッチがオフなので応答は今と同じ。本文に `coversSeq` が載り始める。古い Worker は知らない欄を読まない（ingest は `body.kind`・`scope`・`rows`・`dirtySeq` 等を名前で読むだけ＝`ingest.js` 223〜285行で確認）。
2. **Worker push**（オーナー1回）：migration で列を足す（NULL＝閉じる）→ 門のコード。push の直後から、書き込みの印を持つ会員は番号つきの押し出しが届くまで GAS（最大30分＋失敗の再試行・上の Worker 1）。★migration がコードより先に入ること（列が無いまま門のコードが動くと「読めない＝全員閉じる」で全員 GAS）。いまの反映の流れで migration とコードのどちらが先に入るかは**未確認**＝関門①・実装で確かめる。
3. Worker push の後、作業依頼で「`home_covers_seq < dirty_seq` の会員数」と `covers_*` の回数を見て、0 に近いことを確かめる（スイッチ前の門の誤閉じの確認）。
4. **関門③の後にスイッチ** `LB_EDGE_DEFER='1'`（作業依頼で立てられるかは未確認＝立てられなければオーナー操作1回）。全員に効く＝**関門③の後**。
5. 戻すのは `LB_EDGE_DEFER` を消す（反映不要）。門だけを外すなら Worker を戻す（push）。

## 反映後に確かめること（効果の数字・いつ）
1. スイッチ前：`remaining {writePerf:true}` で `member`・`edgeMark` が出ること・版。
2. スイッチの翌日：予約・取消の total の中央値と最大（目標：予約 ≦ 13.5秒・取消 最大 ≦ 11秒）、`edgeMark`（m）、`LB_EDGE_DEFER_COUNT`（maxAgeMs・inline の割合）、`covers_*` の回数。
3. 取消の最大が 12秒以下で1週間続いたら、決定0139 の条件（キャンセル理由の全員化）を CEO が判断する材料にする。

## 記録（実装と同じ変更で）
- MODEL.md §3 に I79 を足し、守る検査（`write-covers.test.js`・`gas-edge-defer.test.js`・`liff-karte` の次回予約の確認中）を紐付ける（`model-doc.test.js` が空欄を落とす・関門① 2周目 低2）。§2-3 の `customer_sync_version` の列、§5 の `readHome` の null の理由（`covers_behind`）、§6 の書き込み直後の説明、§7（トリガーは増やさない）も同じ変更で直す。ROADMAP に設計45 の位置を足す。

## 検査（実装のときに先に書く）
- `write-covers.test.js`（Worker）：migration を本物の SQLite に流し、NULL で閉じる（dirty=0 は開く）ことを確かめる／covers の書き込みが行と同じ batch・MAX にしない・`coveredCustomers` は final の batch だけ／`coversSeq` の型／門（閉じる・開く・NULL・読めない＝全員閉じる）／`FROM`・`JOIN reservations` の全経路の一覧と、経路の表どおりの扱い（トレーナーは閲覧範囲全体を門へ）／`readHome` が `readHomeDiag` より前に null（振替権が出ない）／`/quota/status` の閉じている数が会員IDを出さない。
- `gas-edge-defer.test.js`（GAS を node で動かす）：スイッチオフで今と1文字も同じ送信／トリガーを作れない・番号なし・待ち満杯・印の失敗で今の経路／トリガーで写しを送った会員だけ外す（seq が上がったら外さない）／TICK の受け皿は90秒より古いものだけ／定期の押し出しが読み始めの番号を載せる（台帳を読む前に読む順序を、呼ばれた順で確かめる）。
- 1行ずつ壊して落ちることを確かめる（門の条件・covers の MAX 化・順序）。

## オーナーへの質問（業務の規則・この設計では決めない）
1. **予約・取消の確認の LINE を、応答の後（目安は数十秒後・本番の分布は未計測）に送ってよいか。** 対象：予約の会員宛とトレーナー宛（残数つき）、取消の会員宛と契約上の担当宛。取消の「その枠のトレーナー」は今どおり応答の前（設計36）。よければ M3 として別の設計で、予約で最大 −3.7 秒・取消で最大 −2.2 秒。

## 関門① 1周目（Codex スレッド 01a1e350-ce7a-7263-8601-f791114c9412・2026-11-16）
判定：差し戻し（高2・中5・低3）。指摘は全部、該当行を読んで裏を取った。

| # | 指摘 | 対処 |
|---|---|---|
| 高1 | 門の対象から漏れた経路：会員 boot の予約一覧（boot.js 213〜234）・トレーナー boot の `upcoming`（240〜259）・karte 概要の次回予約（1248〜1283）・karte board の `noNextBooking`（1430〜1466 は全体の sync_state だけで判定） | 直した。経路の表を作り、複数の会員を返す入口の扱いを決めた。検査は `FROM`／`JOIN reservations` の SQL を機械で全部取り出す |
| 高2 | 予約0件の会員は、全体送信の本文に現れないので resv の covers が回復しない | 直した。全体送信に `coveredCustomers`（走査した全会員）を載せ、final の batch で全員の covers を立てる |
| 中1 | 初期化 covers=dirty は片側失敗・写しを作れない会員で嘘になり、「最大30分」も保証されない。NULL を通すのも MODEL §8 と逆 | 直した。初期化しない・NULL は閉じる。番号つきの押し出しが成功した会員から開く（移行の直後は GAS に落ちる会員が増える＝遅いが正しい） |
| 中2 | readHome の門は readHomeDiag の前に置く必要（振替権を写しから返すため） | 直した。readHome の最初・写しも D1 も読む前と明記、検査で固定 |
| 中3 | トレーナーの一覧は返った行ではなく閲覧範囲の顧客全体を門に渡す必要（追加の予約が写しに無い会員を見逃す） | 直した。オーナーは全顧客＝1人の書き込みで一覧が GAS に落ちる代償を明記 |
| 中4 | AFTER の末尾の掃除が別の書き込みのトリガーを消す・古い番号の送信が新しい写しを置き換える | 直した。末尾の掃除は自分の triggerUid だけ。置き換えは covers も一緒に下がる＝古い値は出ないが戻りが遅い → 見張りで数える。TICK の最悪は約6分半と明記 |
| 中5 | GAS の待ちの見張りでは、待ちが消えた会員の閉じっぱなしに気づけない | 直した。Worker 側の事実（閉じている会員の数・NULL・最古の経過）を `/quota/status` に足し、日次点検で 10分 warn・60分 high |
| 低1 | remain-from-d1 の件数に門を足さない判断は正しい（I31 が先に守る） | そのまま（確認として記録） |
| 低2 | m を「小さい batch」と言えない（ingest は表の全行を SELECT） | 直した。m が分かるまで目標を保証しないと明記 |
| 低3 | 待ちに会員IDが新しく保存される | 直した。運用の状態であること・消す条件・壊れたときに写さない・ログに出さないを明記 |

## 関門① 2周目（Codex スレッド 01a1e356-0648-7c01-8a51-379e48871e9c）
判定：差し戻し（高1・中3・低2）。1周目の10件は「設計上は反映済み」（中5 を除く）。karte board の `'unknown'` は画面が扱える（liff/karte.js 3713・3750・3768）、`/quota/status` は合言葉で守られ新しい個人情報の出口にならない、と確認された。指摘はすべて該当行を読んで裏を取った。

| # | 指摘 | 対処 |
|---|---|---|
| 高1 | karte 概要を FALLBACK にすると、カルテは GAS に逃げず概要ごとエラー（karte.js 690〜693） | 直した。新しい画面は印 `nextUnknownOk` を載せ、`nextReservationUnknown` で「確認中」。null を「予約なし」と出す古い画面には null を返さない |
| 中1 | 閉じてからの経過を測る時刻が無い（dirty_since は作り直しで消える） | 直した。`home_blocked_since`・`resv_blocked_since` を足す。移行の残りは別に数える |
| 中2 | 退会の会員は定期の写しの対象外（PushToEdge.js 904）で home が永久に閉じ、見張りを汚す | 直した。門は効いたまま（GAS）、見張りの数からは外す |
| 中3 | 行の無い会員で covers の文が dirty の文より先だと不要に閉じる | 直した。covers と since の文は dirty の文の後ろ。検査で固定 |
| 低1 | coveredCustomers の上限超えの扱い | 直した。2,000件超えは送信ごと断る |
| 低2 | I79 を MODEL §3 に足す作業が無い | 直した（「記録」の節） |

## 関門① 3周目（Codex スレッド 01a1e359-63f0-7513-ad18-c2ba3af04e07）
判定：差し戻し（高1・中0・低0）。2周目の6件は直っている（blocked_since の遷移・古い画面・退会・順序・上限・MODEL）、個人情報の新しい出口なし、と確認された。
| # | 指摘 | 対処 |
|---|---|---|
| 高 | 門と値の読みが別の SQL なので、門を見た後・値を読む前に印が入ると古い値を返す（karte.js 1252・1262 ほか） | 直した。門は値を読んだ後にもう一度見て、閉じていれば捨てる（batch にまとめられる経路は値の文の後ろに門の文）。検査に割り込みの順序を入れる |

## 関門① 4周目（Codex スレッド 01a1e35f-71fb-75e1-afcc-0bce8d46e5d4）
判定：**通過**（高・中・低とも指摘なし）。後の門の読み取り失敗＝全員閉じる、readHome（写し → decideHome）の後に後の門、boot・compat の並列取得は完了後に門で全体 FALLBACK／null、karte 概要は確認中・board は `'unknown'` に置き換え、で誤った値・静かな破損・個人情報の新しい出口は無いと確認された。
**実装の通過条件**：後の門は「値の読み取りが全部終わった後・応答を組み立てる前」に置く。

## 実装で確かめた事実・決めたこと（2026-11-16）
- **migration はコードより先に入る**：本番の反映（`.github/workflows/worker-deploy.yml`）は「schema.sql → migrations/*.sql を未適用のものだけ → schema.sql → `wrangler deploy`」の順（78〜111行）。列が無いまま門のコードが動く窓は無い。
- **`LB_EDGE_DEFER` は作業依頼では立てられない**：`gas/EdgeJob.js` の op（audit・verify・remaining・quotaBuild・pushAll 等）に Script Property を書く窓口は無い。op を足すと許可一覧の変更になるので足さない＝**オーナーが GAS エディタのスクリプト プロパティで `LB_EDGE_DEFER` = `1` を立てる（1回）**。戻すときは消す。
  移行の窓を縮める押し出しは既存の作業依頼 `pushAll`（`pushToEdgeAll`＝予約一覧と残数を番号つきで送る）で走らせられる。
- トレーナー・オーナーの一覧（`compatTrainerReservations`・`routeBoot` の今後の件数）は、閲覧範囲ではなく**誰か1人でも**閉じていれば FALLBACK にした（範囲の外の会員がそのトレーナーで取った予約も一覧に出るため。閉じる向きに広い）。
- 移行の残り（covers も since も NULL）は日次点検で warn（Worker の反映の時刻を GAS は知らないので「2時間後から」は数えない。点検は朝7時に1回）。
- 段の記録：`member`・`edgeMark` を後ろに足し、古い長さ（段11個）の行も読む（読み出しは行ごとの並びで名前を付け、古い行に「（旧い並び）」）。
- 版の印：GAS `LB_EDGE_BUILD`・`LB_HEALTH_BUILD` = `2026-11-16a`（`worker/test/expected-builds.json` も）、Worker `WORKER_BUILD` = `2026-11-16a`、LIFF `LIFF_BUILD`・`KARTE_BUILD`・`karte.js?v=` = `2026-11-16a`。
- 検査：`worker/test/write-covers.test.js`（Worker・本物の SQLite）・`worker/test/gas-edge-defer.test.js`（GAS）・`karte.test.js` 11・`liff-karte.test.js` 11-9〜11-10・`read-on.test.js` ①-3b〜c。既存の検査の身代わり（門の表を読めるように `all()` を足す・新しい関数の身代わり）を直した。

## 関門② 1周目（Codex スレッド 01a1e37f-1bc3-7eb1-9439-464f55d81871・コミット 8e7912d）
判定：**通過**（高0・中0・低1）。顧客に古い値が出る経路なし（全経路で後の門が値の読み取りの後・組み立ての前）、ingest の検証・同じ batch・MAX にしない・blocked_since の CASE、GAS のスイッチオフで今と同じ・番号を台帳の前に読む・新しいトリガーなし・個人情報の新しい出口なし、と確認された。
| # | 指摘 | 対処 |
|---|---|---|
| 低 | `trigger-args.test.js` に足した許可の正規表現がプロパティ名を `[A-Za-z]+` にしていて、任意の文字列の欄を型検査すれば通ってしまう | 直した（aa79f85）。`triggerUid` に固定。別の欄で確かめる形に壊すと落ちることを確かめた |

## 関門② 2周目（Codex スレッド 01a1e387-ac21-7890-9f93-0d5903db7bf4・コミット aa79f85）
判定：**通過**（指摘なし）。修正で指摘が解消し、ほかの引数つきトリガー（dailyHealthCheck・weeklyPaceReport・lbNudgeDaily）の判定は変わらないと確認された。

---

# 設計45b（M3）予約・取消の LINE 通知を応答の後ろへ回す

> 2026-11-16・CTO。オーナー承認（2026-11-16）：「予約の会員宛とトレーナー宛、取消の会員宛と契約上の担当宛の LINE を、応答の後（数十秒後）に送ってよい。取消の『その枠のトレーナー』宛は今どおり応答の前」。
> 版の印：GAS `LB_HEALTH_BUILD` を `2026-11-16b`（`expected-builds.json` も）。M2 と同じ反映にまとめる（M2 は未 push）。
> 戻し方：Script Property `LB_NOTIFY_DEFER`（既定オフ＝`'1'` のときだけ）。**`LB_EDGE_DEFER` とは別**＝片方だけ戻せる。オフなら送る相手・文・順序・時刻は今と同じ（段の印が2つ増えるだけ）。

## 目的（1行）
会員の予約・取消の応答を待たせている段 notify（予約の中央 3.7秒・取消 2.2秒）のうち、**LINE を送る通信だけ**を応答の後ろへ回す。文面は書き込みの時点で作って固定する。

## 対象（コードで確かめた事実）
| 操作（`handleLineGet` の action） | 後ろへ回す通知 | 応答の前に残す |
|---|---|---|
| `line_makeReservationLine`・`line_makeReservationLineProxy`（代行）・`line_makeTransferReservation`（振替） | `_lbNotifyReservation` の会員宛 `booking_customer`・トレーナー宛 `booking_trainer` | — |
| `line_cancelReservation`・`line_ownerFreeCancel` | `_lbCxlAfter` の担当宛（`send('owner')`）・会員宛（`send('customer')`）＝どちらも `cancel_*` | その枠のトレーナー（`send('slot', …, direct=true)`） |
- 対象外（今のまま）：変更（`change_*`）・まとめて予約・固定枠の自動予約（どれも `suppressNotify` で `_lbNotifyReservation` を通らない）・手動の紐付け（`booking_customer` 7679行）・リマインド・旧経路 doPost／liffApi（`handleLineGet` を通らない）。
- 判定は「要求の入口で対象の操作か」だけ（`LB_NOTIFY_DEFER_OPS`）。トリガー・作業依頼から呼ばれた `_lbNotifyReservation` は今のまま送る。

## 文面の固定（条件「残数・日時は書き込みの時点」）
- **文面は今と同じ場所・同じ順序で、応答の前に作る。** `_lbNotifyReservation` の会員宛の文、`getTrainerLineId`、`_lbTrainerRemainText`（ロックの中・台帳に書いた直後＝今と同じ値）、取消の `trText()`・`_lbMemberLang`・`_lbTrainerNameLang`。後ろへ回すのは `_lbPush(to, text, purpose, ctx, opts)` の**呼び出しだけ**。だから届く文は今と1文字も同じ。
- 代償：予約の notify のうち残数の計算（`_lbTrainerRemainText`＝`_lbBuildHome`）は応答の前に残る。**どれだけ縮むかは LINE の通信の時間しだいで、今の記録では分けられない**（段 notify は通信と計算の合計）。→ 段 `notifyCalc`（`_lbTrainerRemainText` だけ）を足し、**スイッチがオフのまま**反映の翌日に通信と計算の割合が分かるようにする。
- 見込み（推測を含む）：LINE の push 1回は数百ms＋送り間隔の 260ms（`LB_PUSH_MIN_GAP_MS`）。予約は2通、取消は会員の1通（担当は理由・ひとことがあるときだけ）。縮むのは予約で「notify − notifyCalc − 名簿の読み」、取消で会員の1通ぶん。**目標の数字は notifyCalc を測るまで言わない。**

## 流れ
1. 入口 `handleLineGet`：`_LB_NOTIFY_HOLD = null`・`_LB_CAL_SCHEDULED = false` に戻す。action が `LB_NOTIFY_DEFER_OPS` にあり、`LB_NOTIFY_DEFER === '1'` かつ `_calsyncAutoOn()`（一回限りトリガーを作れる設定）のときだけ `_LB_NOTIFY_HOLD = []`。
2. 書き込みの中：`_lbPushOrHold(to, text, purpose, ctx, opts)` ＝ `_LB_NOTIFY_HOLD` が配列で `to` があれば `{to, text, p, c, nr}` を足して `'held'`、それ以外は今の `_lbPush`。
   - 取消の `send()`：`direct` でなく保留できるときは、時間予算（`over()`）より先に保留する（`st[name] = 'held'`）。`relayed`・`notified`（`st !== 'unsent'`）は今の `'deferred'` と同じ扱い。`CXL_NOTIFY_SLOW` の `deferred` には数えない。
3. 書き込みが返った後・`edgeAfterWrite` の**前**：`_lbNotifyHoldPersist()` が保留を待ち `LB_NOTIFY_PENDING` に足す（ScriptLock・待ち3秒）。**トリガーを作る前に待ちへ入れる**のは、1秒後のトリガーが先に動いて待ちが空のまま終わるのを避けるため。足せなければ保留はメモリに残る。
4. `edgeAfterWrite`（`_lbScheduleCalSync` が作れたら `_LB_CAL_SCHEDULED = true`）。
5. `_lbNotifyHoldSettle()`：
   - 待ちに足せた かつ `_LB_CAL_SCHEDULED === true` → 何もしない（数える `held`）。
   - 待ちに足せたがトリガーを作れなかった → 足した ID だけを取り戻して（取り分けと同じ排他）**今の `_lbPush` で送る**（`inline_noTrigger`）。既に別の実行が取っていた分はその実行が送る。
   - 足せなかった → メモリの保留を今の `_lbPush` で送る（`inline_pendFail`）。
   - `_lbDispatch` が例外を投げたとき（`handleLineGet` の catch）も、投げ直す前にメモリの保留を送る（`inline_throw`）。
6. 送る側（`_lbNotifyDeferDrain(who, budgetMs, minAgeMs)`・新しいトリガー0本）：
   - `AFTER`：一回限りトリガー `_lbCalSyncAfterWrite` の**最初**（写しの待ちより前。通知は数秒で終わる）。年齢の下限 0。
   - `TICK`：5分ごとの `lbCalSyncTick` の最初。90秒より古いものだけ。
   - `WARM`：10分ごとの `warmupCache` の末尾（`lbNotifyRetryTick` の後）。5分より古いものだけ。★`lbCalSyncTick` は `LB_CALSYNC_ON='0'` でも走るが、トリガーごと外されると止まる。`warmupCache` はスイッチで止まらない（設計17 が相乗りした理由と同じ）＝2つ目の受け皿。
   - 最悪（トリガーが失われた）：TICK で書き込みから約6分半、TICK も止まっていれば WARM で約15分。
7. 順序を守る（取消・変更の直前に古い保留を先に出す）：`_lbNotifyDeferFlushRes(resId)` を `_lbCxlAfter` の最初（その枠のトレーナーより前）と、`changeReservationLine` の変更の通知の前（旧予約ID）で呼ぶ。待ちにその予約IDの項目があれば、取り分けて今すぐ送る（`sentFlush`）。無ければ Property を1回読むだけ。★これが無いと「予約してすぐ取消」で、トレーナーに【予約キャンセル】（応答の前）が【新規予約】（後ろ）より先に届く。

## 待ち `LB_NOTIFY_PENDING`（Script Property・個人情報を含む）
- 形：配列 `[{id, at, to, text, p, c:{resId, customerId, startMs}, nr, li, lu}]`。`id` は UUID、`li`/`lu` は取り分けの印と期限（5分）。
- **個人情報**：`to`（LINE ID）と `text`（トレーナー宛は会員の氏名を含む・取消のひとことを含みうる）。入れる理由：送る瞬間に作り直すと「書き込みの時点で固定」が崩れる。最小にするため、ほかの欄（氏名・電話・言語）は持たない。
- **消す条件**：送る試みをしたら必ず消す（成否は問わない。失敗は `_lbPush` → `_lbNqOnFail` が設計17 の `notify_retry` に積む＝今と同じ）。30分より古い項目は送らずに `notify_retry` へ `pending`（送る前に I17 の台帳確認が走る・本文は30日で空になる既存の扱い）で移して消す（`handover`）。期限の切れた取り分け（送ったか分からない）は `notify_retry` へ `alert`（`delivery_unknown`・オーナーへメール・送り直さない）で移して消す（`leaseLost`）。★だから Script Properties に残るのは通常数十秒・最長30分（受け皿が全部止まったときを除く）。
- 上限：16件・UTF-8 で 8,000 バイト（1つの Property の上限 9KB）。超えるなら足さない＝今の経路。
- 壊れていたら（JSON が読めない・形が違う）：**書き換えない**（中身を消すと誰にも届かず知らせもしない）。時刻だけ `LB_NOTIFY_PENDING_BAD` に立て、新しい保留は今の経路で送る。日次点検で high。中身はログ・点検・応答に出さない。
- ログ・日次点検・作業依頼の結果には数だけを出す（LINE ID・本文・会員ID を出さない）。

## 設計17（届かなかった通知の積み直し・I17）と二重送信・取りこぼし
| 起きること | 二重送信 | 取りこぼし |
|---|---|---|
| 送る | 取り分け（ScriptLock の中で `li`/`lu` を書く）が唯一の排他。AFTER・TICK・WARM・取り戻し・FLUSH は同じ関数を通る | — |
| LINE が失敗 | `_lbPush` が今と同じく `notify_retry` に1行積む。待ちからは消す＝積むのは1回 | 送り直し（I17）が拾う |
| 送った後、待ちから消す書き込みでロックが取れない | 送り直さない：期限切れの取り分けは「送ったか分からない」＝`notify_retry` に `alert`（送らずオーナーへ・設計17 の `uncertain` と同じ） | オーナーのメールで気づく（届いていた場合は誤報＝安全側） |
| 実行が途中で死ぬ | 同上 | 同上 |
| 30分より古い | `notify_retry` の `pending` へ移し、送る前に台帳で確かめる（取消・変更済み・開始後なら送らない） | — |
- 冪等の鍵が書き換えるもの：待ちの項目の `li`/`lu`（取り分け）と、項目の削除（`id` かつ `li` が自分のときだけ）。`notify_retry` の行は `_lbPush` 失敗時に新しい `N`+UUID で作られ、待ちの `id` とは独立（同じ通知が2行になるのは「待ちから消せず、かつ LINE も失敗した」場合で、そのとき alert と pending が1行ずつ＝送り直しは pending の1回だけ）。
- 引き渡しの書き込み（handover・leaseLost の `notify_retry` 追記）は**取り分けのロックの中**で行い、追記できた項目だけ待ちから消す（追記してから消す＝途中で死んでも待ちに残る→次の回にもう一度引き渡す。追記の重複は alert が2行になるだけで送らない／pending の重複は I17 が送る前に確かめるが**2通になりうる**→ pending の引き渡しは追記の直後に同じロックの中で消すので、重複は「追記の後・消す前に死ぬ」だけ）。

## 記録と見張り
- `LB_NOTIFY_DEFER_COUNT`（日ごと・直近3日・数とミリ秒だけ）：`held`・`inline_noTrigger`・`inline_pendFail`・`inline_throw`（通数）・`sentAfter`・`sentTick`・`sentWarm`・`sentFlush`・`sendFail`（`_lbPush` が false）・`leaseLost`・`handover`・`maxAgeMs`（書き込み→送る試み）・`sendMsMax`・`sendMsSum`・`sendN`（後ろへ回した通信の時間＝段 notify から抜けた分）。壊れていたら退避して作り直す（M2 の `LB_EDGE_DEFER_COUNT` と同じ作り）。
- 段の印：`LB_WP.STAGES` の後ろに `notifyCalc`（予約のトレーナー宛の残数の文）・`notifyQ`（待ちへの追加と取り戻し）を足す。M2 の `member`・`edgeMark` は未反映なので並びは 15 にまとめ、旧い並び（11）も読む。
- `writePerfText`（作業依頼 `remaining {writePerf:true}`）に昨日と今日の `LB_NOTIFY_DEFER_COUNT` を数だけ1行で出す。
- 日次点検 `lbNotifyDeferDailyCheck`：待ちが壊れている → high（スイッチに関係なく）／待ちに10分より古い項目 → warn（同）／昨日 `leaseLost > 0`・`handover > 0`・`maxAgeMs > 10分` → warn／`inline_*` が `held` の2割超 → warn（スイッチがオンのときだけ）。

## 判定できないとき（倒れる向き）
| 起きたこと | 顧客に起きること |
|---|---|
| スイッチがオフ・対象外の操作・トリガー経路・calsync が止まっている | 今と同じ |
| 待ちに足せない（ロック・上限・壊れている）・トリガーを作れない・振り分けが例外 | 今の `_lbPush` で応答の前に送る（今と同じ文・少し後ろ＝写しの後） |
| トリガーが遅い・失われた | 確認の LINE が遅れる（TICK 最悪6分半・WARM 最悪15分）。数える（maxAgeMs・待ちの古さ） |
| 送ったか分からない | 送らずオーナーへメール（設計17 と同じ） |

## 変えないもの
送る相手・文・順序（同じ要求の中の）・設計17 の送り直しの規則・設計36 の時間予算（保留できないときは今どおり）・その枠のトレーナーの即時送信・変更の通知。

## 検査（実装の前に書く）`worker/test/gas-notify-defer.test.js`
入口 `handleLineGet` から、本物の `_lbNotifyReservation`・`_lbCxlAfter`・`_lbPush`（`_lbPushOnce` は身代わり）・待ちの関数を通す。
1. スイッチオフ：送る相手・文・順序・`_lbPush` の引数が今と同じ／待ちを作らない。
2. スイッチオン：応答の前に `_lbPush` を呼ばない（予約2通・取消の会員）／その枠のトレーナーは応答の前／待ちの中の文が今の文と1文字も同じ／保留はトリガーを作る前に待ちへ入る。
3. 今の経路に倒れる：トリガーを作れない（取り戻して送る）・ロック失敗・上限超え・壊れた待ち（書き換えない）・振り分けの例外。
4. 送る側：AFTER は全部・TICK は90秒・WARM は5分より古いものだけ／送った項目を消す／失敗は `notify_retry` に1行（`_lbNqOnFail`）で待ちから消える／二重に取らない（2つの実行）／期限切れの取り分けは alert で送らない／30分より古いものは pending で引き渡す。
5. FLUSH：取消の前に同じ予約IDの保留を先に送る（トレーナーに【新規予約】→【予約キャンセル】の順）。
6. 新しいトリガー0本・`_lbCalSyncAfterWrite`・`lbCalSyncTick`・`warmupCache` の配線。
7. 日次点検と記録（数だけ・LINE ID と本文を出さない）。
8. 1行ずつ壊して落ちることを確かめる（保留の条件・取り分けの排他・消す条件・FLUSH の位置）。

## 45b 関門① 1周目（Codex スレッド 01a1e3b1-688d-7683-936f-f4499309d9a2）
判定：差し戻し（高2・中3・低2）。指摘は全部、該当行を読んで裏を取った（取消は台帳更新・ロック解放の後に `_lbCxlAfter`＝8183〜8190行、送り直しの書き戻しの既知の制約＝5238行、`notify_retry` の id は毎回新しい UUID＝4948行）。

| # | 指摘 | 対処（この節が上の本文より優先） |
|---|---|---|
| 高1 | 送る側が取り分けて LINE を送っている最中は FLUSH が取れず、取消の通知が先に出る | **FLUSH は待つ。** 同じ予約IDの項目が取り分け中（期限内の `li`）なら 300ms ごとに読み直し、消えるまで最大6秒待つ。取り分けていない項目は自分で取り分けて送る。送る側は**1通送るごとにその項目を消す**（まとめて消さない＝待ちが1通ぶんで済む）。6秒で消えなければ先へ進み `flushTimeout` に数える（順序が逆になりうる回を数える・日次 warn）。待つのは取消・変更の直前に同じ予約の保留があったときだけ |
| 高2 | 30分超の引き渡し（追記してから待ちから消す）の間に死ぬと `notify_retry` に2行＝2通 | **引き渡しを冪等にする。** `notify_retry` の行の id を `'D' + 待ちの id` にし、追記の前に id 列を読んで同じ id の行があれば追記しない（消すだけ）。leaseLost の alert も同じ id の作り。id 列の読みは引き渡しのときだけ（まれ） |
| 中1 | 個人情報の保持が「受け皿が全部止まれば」無期限・壊れた値も無期限 | 日次点検（`dailyHealthCheck`・別のトリガー）も30分超の項目を引き渡す＝送る側が全部止まっても**最長およそ1日**で Script Properties から消え、`notify_retry` の既存の扱い（本文30日で空）に移る。壊れた値は 24時間は残し（オーナーが確かめられる）、その後に日次点検が**中身を出さずに消す**（時刻と長さだけ記録）。どちらも日次点検で high |
| 中2 | 要求の中で ScriptLock を持つ区間が増え、他の予約の待ちに効く | ロックの中は Property の読み1回・書き1回だけ（文の組み立て・バイト数の計算はロックの外で先に済ませ、ロックの中では結合と上限の確認だけ）。持った時間の最大 `lockMsMax` と取れなかった回 `inline_pendFail` を数え、日次点検で `lockMsMax > 1秒` を warn |
| 中3 | 待ちに入れた後に実行が強制終了すると、TICK も WARM も止まっていれば送られない | 受け皿は3つ（TICK・WARM・日次点検の引き渡し）。待ちの件数と最古の経過分を作業依頼 `remaining {writePerf:true}` の結果にも出す（数だけ）＝ CEO がトリガーと独立に読める |
| 低1 | 文面を drain 側で作らないことをソースの順序でも固定 | 検査に入れる（`_lbPushOrHold` の引数は完成した文・drain は `text` を組み立てない） |
| 低2 | 30分の根拠 | 根拠：TICK 5分×3回・WARM 10分×2回の受け皿をすべて逃した＝通常の遅れ（数十秒）の60倍。ここより遅い確認は取消・変更されている可能性があるので、送る前に台帳を確かめる設計17 へ渡す |

## 45b 関門① 2周目（Codex スレッド 01a1e3b4-01ad-70e3-b4d9-771776f57ff1）
判定：差し戻し（高2・中2・低1）。1周目の高2（引き渡しの冪等）と文面の固定は確認された。指摘は該当行で裏を取った（受付の起点 8077行・予算 8219行・本文を空にするのは sent/stale/closed だけ＝5152行）。

| # | 指摘 | 対処（この節が上の本文・1周目の表より優先） |
|---|---|---|
| 高1・高2 | FLUSH の6秒待ちは順序を保証できず（通信が6秒を超えれば逆転）、しかも取消の受付12秒の予算を食う | **FLUSH の意味を変える：待ちの中のその予約の通知は、送らずに捨てる（stale）。** 取消・変更の時点でその予約はもう `confirmed` ではない＝設計17 の I17 が送り直しで捨てる条件（`booking_*` は `confirmed` のときだけ送る・`_lbNqValidate` 5089〜5091行）と同じ判断。会員には取消／変更の通知（変更は終了時刻・場所まで載る＝8833〜8841行）が届く。送らないので取消の応答に通信の時間を足さない。捨てた通数を `staleDropped` に数える。★取り分け中（期限内の `li`）のその予約の項目だけは止められない：**ロックを持たずに** 250ms ごとに Property を1回読み、消えるまで待つ。待つ上限は `min(2秒, 12秒 − (いま − t0) − 2秒)`（0以下なら待たない）。上限で消えなければ先へ進み `flushTimeout` に数える（日次 warn）＝順序の逆転は「同じ予約の確定の通知を送っている最中の数百ms に取消が通知の段へ入った」ときだけ残り、数で見える。★順序は努力目標で、不変条件は「二重に送らない・黙って落とさない」（下の I80） |
| 中1 | 引き渡した先の `notify_retry` でも、送り直しが止まっていれば `pending`／`alert` の本文は消えない | `notify_retry` の扱いは既存のまま（失敗した通知も同じ）。送り直しが止まったことは既存の見張り（`LB_NOTIFY_RETRY_COMPLETED` が1時間より古い → 日次点検）で気づける。この設計は**待ちから出す期限（最長およそ1日）まで**を受け持ち、`notify_retry` の保持期間は変えない（残る危険として MODEL に書く） |
| 中2 | 引き渡しの id 列の読みと追記を ScriptLock の中で行うと予約を待たせる | **ロックの外で行う。** 引き渡す項目はまず通常どおり取り分ける（ロックの中は Property の読み書きだけ）→ ロックの外で `notify_retry` の**末尾200行**の id 列を読み、`'D'+id` が無ければ追記 → ロックの中でその項目を消す。取り分けの期限（5分）の間は他の実行が触らないので、確認と追記はロックが無くても1つの実行だけが行う（5分を超えて死んだときだけ、次の実行が id で重複を見つけて追記しない）。追記は末尾＝`lbNotifyRetryTick` の範囲書き込み（読んだ行数ぶん・5160行）と `_lbNqWriteBack`（lo〜hi）の外。既存の `_lbNqOnFail` も同じくロックの外で追記している。1回に引き渡すのは5件まで。送る側の各ロックの保持時間の最大も `lockMsMax` に入れる |
| 低1 | FLUSH の待ちの間にロックを持たない | 上のとおり。検査で「sleep の間・LINE の通信の間にロックを持っていない」を固定する |

## 45b 関門① 3周目（Codex スレッド 01a1e3b6-3717-7e30-8f45-aa149c71a2dc）
判定：**通過**（高0・中0・低1）。FLUSH は取消・変更が台帳を確定し成立した後だけ呼ばれる（取消 8148・8183・8190行、変更の失敗は旧行を confirmed に戻して return＝8815・8826行）、`undoSameDayCancel` は confirmed に戻さない（8717行）、取り直しは別の予約ID（6334・6342行）＝確定の通知を誤って捨てない、と確認された。
| # | 指摘 | 対処 |
|---|---|---|
| 低 | FLUSH の境界（取消・変更の失敗では捨てない／新しい予約IDの通知は捨てない）と `staleDropped`・`flushTimeout` の配線を検査に固定 | 検査 5 に入れる。捨てるのは `booking_*` の項目だけ（取消・変更の通知は捨てない） |
**実装の通過条件**：FLUSH は台帳の確定と成立の後・ロックの外。待ちの間と LINE の通信の間に ScriptLock を持たない。

### I80（新しい不変条件・MODEL §3）
**後ろへ回した LINE 通知は、二重に送らず黙って落とさない。** 待ち `LB_NOTIFY_PENDING` の項目は、取り分け（ScriptLock の中で `li`/`lu`）をした1つの実行だけが送る試みをし、試みたら消す（失敗は `_lbPush` が `notify_retry` に1回積む）。期限切れの取り分けは送らずに `notify_retry` の alert（id `'D'+待ちのid`・重複は追記しない）、30分超は pending で引き渡す。待ちが壊れていたら書き換えずに今の経路で送る。文面は書き込みの時点で作った完成文（送る側で組み立てない）。取消・変更の後、その予約の確定の通知（`booking_*`）は待ちから捨てる（I17 と同じ判断）。

## 45b 実装で確かめた事実・決めたこと（2026-11-16）
- M2（設計45）は既に origin/main に入っていた（GAS は未反映）。段の並びは 15（`notifyCalc`・`notifyQ` を後ろに）にし、M2 だけが先に反映された場合の段13個の行も `STAGES_V2` で読む（旧い並び 11 も読む）。
- 日次点検の手入れ（引き渡し・壊れた値の掃除）は試し実行（`dryRun`）では行わない。
- 取消・変更の FLUSH は待ちが空なら Property を1回読むだけ（スイッチがオフでも呼ばれる＝スイッチを切った後に残った待ちにも効く）。
- 検査：`worker/test/gas-notify-defer.test.js`（84件）。既存の検査の身代わり（`owner-same-day-free`・`write-perf`）に新しい関数の身代わりを足した。壊して確かめた：保留しない／取り分けの排他を外す／送った後に消さない／期限切れを送り直す／FLUSH を呼ばない／FLUSH が取り分け中も捨てる／FLUSH が cancel_* も捨てる／引き渡しの重複を見ない／トリガーの成否を見ない／待ちへ入れるのをトリガーの後に、の10通りすべてで該当の検査が落ちた。
