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
