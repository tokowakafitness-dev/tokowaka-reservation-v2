# 設計47 定期の押し出しが ScriptLock を握り続け、予約・取消・変更がロック待ちで落ちる

> 2026-11-20・CTO（CEO玄から受けた）。**第4版（関門①第4周で条件付き通過・条件3点を反映済み。第2版＝第1周、第3版＝第2周、第4版＝第3周の差し戻しへの対処）**。実装・push・GAS 反映はしていない。
> 第1版の推奨（押し出し同士の排他をリースへ移す＝手段A）は、**共通の ScriptLock が「書きかけの名簿を写さない」守りになっている**ことが確かめられたため不採用（§6）。
> 2段に分ける：**段1＝押し出しと書き込みのロックの関係は変えずに測る＋ロック待ちの案内を正しくする＋`_edgeLocked` の入れ子の扱いを直す（今回の反映）**／**段2＝構造を直す（段1の実測の後に別の設計）**。
> 版の印：実装時に GAS `LB_HEALTH_BUILD`・`LB_EDGE_BUILD` を実装日に。

## 目的（1行）
押し出しが ScriptLock を握る時間と、そのせいで書き込みがロック待ちで落ちる回数を毎日数えられるようにし、落ちたときに顧客へ「その枠は取れない」という誤った案内を出さないようにする（構造の直しは実測の後）。

---

## 1. 事実の確認（コードの該当行・推測は「未確認」と書く）

### 1-1 起きたこと（実測・本番 `LB_WRITE_PERF`・版 2026-11-18a）
- 11/19 12:01:22・12:01:49・12:02:18 の `changeReservation` が3回続けて `THROW`。最後の印は `preType`、その後の時間（`other` に入る）が 10,079〜10,167ms、`lock`=0。
- `changeReservationLine`（gas/LineBooking.js 9331〜9335）は `_lbWpMark('preType')` の直後に `LockService.getScriptLock().waitLock(10000)`。`waitLock` は取れなければ**例外を投げる**（`tryLock` と違い false を返さない）。印が `preType` のまま約10秒で例外＝**このロック待ちの時間切れと読むのが筋**。例外の文そのものは記録しない（I77）ため、**文言による確認はできない（未確認）**。
- 3回は約66秒にまたがる。各回の待ちは10秒なので、**12:01:12ごろ〜12:02:28ごろの少なくとも約76秒、ScriptLock がほぼ切れ目なく誰かに握られていた**（1つの実行が握り続けたのか、複数が続けて握ったのかは**未確認**）。

### 1-2 押し出しは ScriptLock を握ったまま重い処理をしている（該当行）
| 入口（トリガー） | ロック | ロックの中でしていること |
|---|---|---|
| `pushToEdgeLight`（15分ごと・gas/PushToEdge.js 2041）→ `pushToEdgeAll(false)`（1542〜1546） | `_edgeLocked(…, null, 'all')`＝**ScriptLock**・待ち5秒（1530〜1540） | `_pushToEdgeAllImpl`（1555〜）**全体**：名簿 `_edgeCustomers`（1567）・trainers／customers（1569〜1570）／reservations（台帳全行）／recurring（deleteStale 常時）／body／計算入力を読み、それぞれ Worker へ POST。所要時間はコメントで「約43秒」（1526・1684行・2026-10-11＝いまの実測ではない） |
| `pushToEdgeHome`（30分ごと・2042）→ `_edgeLocked(_pushToEdgeHomeImpl)`（1824） | ScriptLock・待ち5秒 | `_edgePushHome`（913〜）：会員全員の残数の計算と POST。打ち切り `EDGE.BUDGET_MS`＝**4分**（22行）。所要時間の記録は無い |
| `pushToEdgeSlots`（10分ごと・2040）→ `_edgeLocked(…, 90000, 'slots')`（1688） | ScriptLock・**待ち90秒** | 作り直しはロックの外（1640〜1680）。中は送るだけ（1647行のコメントで約2秒） |
| `pushToEdgeFullSync`（毎日4時・2043）→ `_edgeLocked(…, null, 'fullSync')`（1552） | ScriptLock・待ち5秒 | 全部＋残数＋消えた行の削除 |
| 作業依頼（`edgeJobPoll`→ EdgeJob.js 262〜264 が書き込みの作業で ScriptLock を `tryLock(30000)`）→ 作業の中から押し出し（例 `pushToEdgeAllText`） | 作業の間ずっと ScriptLock | 押し出しの `_edgeLocked` は同じ実行の中なので取れる |

書き込みで ScriptLock を `waitLock(10000)`（取れなければ**例外**）で取るのは LineBooking.js の10か所：
| 行 | 関数 | 呼ばれ方 |
|---|---|---|
| 687〜688 | `verifyMembership` | 旧 LIFF（gas/LiffApp.html 166）の会員登録 |
| 772〜773 | `selfRegister` | 会員の自己登録（liff/index.html 1787） |
| 3451 | `mergeMemberLink` | エディタの保守関数（3443） |
| 6112〜6114 | `_lbReserveCoreImpl` | 予約の芯。変更から呼ばれるときは既に持っている（`hasLock`）ので取らない |
| 6499 | `addOfflineMember` | エディタの保守関数（6484） |
| 8646〜8647 | `cancelReservationLine` | 会員・トレーナーの取消・オーナーの無料取消 |
| 9202〜9203 | `undoSameDayCancel` | 当日取消を無料に直す（トレーナー画面 1987） |
| 9334〜9335 | `changeReservationLine` | 変更・オーナーの無料変更 |
| 9600 | `_lbAddRecurPattern` | 固定枠の追加（3405） |
| 9679 | `deleteRecurringPattern` | 固定枠の削除（3383） |
ほかに `waitLock` は `closeAllocationMonth`（7005・30秒・月締めの保守）と web 体験予約 `makeReservation`（gas/コード.js 630）にある。まとめて予約（9979〜9980）は既に `tryLock(20000)`＋`BUSY`。

★過去にも同じ根の症状：通知の送り直しの取り分け（LineBooking.js 4862〜4864）「押し出し（_edgeLocked）が作業中ずっとロックを持つため毎回取り損ね（2026-10-13）」。カレンダー同期は同じ理由で UserLock にしている（PushToEdge.js 2450〜2457）。

### 1-3 押し出しが ScriptLock を必要とする理由（第2版で訂正・第3版で入れ子の扱いを追記）
- コードに書かれた理由は「押し出し同士の重複防止＝後着の巻き戻しを防ぐ」（1500〜1501）。
- **それに加えて、共通の ScriptLock は「書きかけの表を写さない」実質の守りになっている（第1版の U2 は反証された・CEO 確認）**：
  - `verifyMembership` は ScriptLock の中で名簿の同じ行の複数のセル（LINE ID・認証の状態・紐付けた時刻・番号の無効化）を順に `setValue` する（LineBooking.js 714〜718）。押し出しも ScriptLock の中で `customers` を読む（PushToEdge.js 1567〜1570）。ロックが別なら、「LINE ID は入ったが状態はまだ」の行を写しに載せうる。
  - `mergeMemberLink`（3451〜）の名簿の付け替え、固定枠の追加・削除と `recurring` の deleteStale（常時・`allowEmpty`）も同じ。
  - covers・世代の門（I79・I31・枠の世代）は残数・予約一覧・枠を守るが、名簿・固定枠などの門の外の表は**このロックだけ**が守っている。
- ★したがって押し出しのロックを書き込みと別にする変更（リース・UserLock 等）は、**この守りを別の形で用意しない限り取れない**。段2の候補はすべてこの1行に答える（§4）。
- **既存の不具合の可能性（第3版・段1で直す）**：作業依頼（EdgeJob.js 262〜264）が ScriptLock を持ったまま押し出しを呼ぶと、`_edgeLocked`（1530〜1540）は `tryLock` で取り直し、`finally` の `releaseLock()`（1539）で**作業依頼のロックまで外しうる**。GAS のロックが入れ子を数えるかは**未確認**。外していれば、作業依頼の残り（押し出しの後の書き換え）は排他なしで走り、§1-3 の守りがそこだけ欠ける。
  未確認の仕様に頼らないよう、段1で `_edgeLocked` を**所有権方式**に直す（3-1a）。`_lbReserveCoreImpl`（6112〜6115：`hasLock()` が真なら取らず、自分で取ったときだけ放す）と同じ型。

---

## 2. 影響の見積もり

### 2-1 1時間のうち書き込みが落ちうる秒数（★推定・実測ではない）
書き込みは ScriptLock を10秒待つ。1回 H 秒握る押し出しに対して、書き込みが落ちる「到着の窓」は max(0, H−10) 秒。
| 押し出し | 回/時 | 1回に握る秒数 H の出所 | 落ちうる秒/時 |
|---|---|---|---|
| slots | 6 | 約2秒（1647行コメント） | 0 |
| light（`pushToEdgeAll(false)`） | 4 | 約43秒（1526・1684行コメント・2026-10-11）／**11/19 の実測から下限76秒**（1-1・1つの実行と仮定した場合） | 132（43秒）〜264（76秒） |
| home | 2 | 下限 約10秒（LbBatch.js 20「9.7秒」・過去）／上限 4分＋送信（`EDGE.BUDGET_MS`） | 0〜約480 |
| 合計（昼間） | | | **およそ130〜750秒/時（2〜21%）** |

- 4時の完全同期（全部＋残数）は1日1回。深夜で書き込みは少ないが、握る時間は最大（全部＋4分）。
- **3本が毎時0分・30分に重なるかは未確認**。GAS の `everyMinutes(N)` は作成時の位相で動き、時計の0分に揃う保証は無い。重なった場合、light と home は待ち5秒で見送る（`LB_EDGE_LOCK_SKIPS`）ので**握る時間は延びにくい**。延びるのは slots（90秒待つ）が直後に続く分（約2秒）。
- GAS のロックの待ち行列が先着順かは**未確認**（待っていた slots と書き込みのどちらが先に取るか分からない）。
- 書き込みのロックを取れた後も、`edgeAfterWrite` の `lbDwEnqueue`（`_lbDwLocked`・ScriptLock を15秒待つ・3929〜3932）が押し出しと当たれば応答が最大15秒延び、画面の20秒の待ち切り（`liff/index.html` 1084）を越えうる（**コードからの推定・未計測**。`edgeQ` の実測中央は 1.5秒）。

### 2-2 落ちたとき顧客の画面に何が出るか（コードで確認）
1. `waitLock` の例外 → `handleLineGet` の catch（LineBooking.js 262〜267）が記録して**投げ直す** → `doGet` の catch（gas/コード.js 70〜72）が `{ error: <例外の文> }` を返す（`success`・`code`・`message` が無い）。
2. 会員の予約・変更の確定（`liff/index.html` 4166〜4200）：`res.success` が無い → `errEl.textContent = res.message || t('book_fail')` → **「この時間は予約できませんでした。別の枠をお選びください。」**（476行）。
   ＝**実際は混んでいただけなのに「その枠は取れない」と読める誤った案内**。11/19 は3回押し直されている。
3. 書き込みは何もされていない（ロックの前で止まる）。変更は元の予約がそのまま残る＝**データの害は無い**。予約は二重にならない。
4. トレーナー画面の取消（2548〜2551）：「キャンセルに失敗しました（不明）。」
5. 会員の取消（3637〜）：`!res.success` の分岐で「判定が変わった」等の文を選ぶ。`{error}` のときの文言は**未確認**（関門①で画面を通して確かめる）。

---

## 3. 段1（今回の反映）：ロックの関係は変えずに測る＋ロック待ちの案内を正しくする＋入れ子の扱いを直す

### 3-0 比べた手段（段1の範囲）
| | 手段 | 変える面積 | 戻せるか | オーナー操作 | 不変条件 |
|---|---|---|---|---|---|
| 採用 | **`_edgeLocked` の所有権方式（3-1a）＋記録（3-1・3-2）＋ A2（3-3）** | `_edgeLocked` の取り方・放し方と計測・書き込み10か所のロックの取り方・記録の出口・画面の失敗表示8か所 | コードを戻す反映 | GAS 反映1回（他の束と同梱可）＋画面は main へのマージ | 押し出しと書き込みのロックの関係は**変えない**（§1-3 の守りを残す）。所有権方式は作業依頼の排他を外さないための修正 |
| 不採用 | 書き込みの待ちを延ばす（20秒以上） | 10か所 | 容易 | 反映1回 | 画面の待ち切り20秒（`liff/index.html` 1084）を越え照合へ落ちる。押し出しが76秒〜4分握れば届かない |
| 不採用 | トリガーの位相・間隔を変える | トリガーの作り直し | 可 | オーナー操作 | 実測（3-1）を見る前に決めない。段2の候補に回す |
| 不採用（第1版） | 押し出しの排他をリースへ | `_edgeLocked` | スイッチ | 反映1回＋関数1回 | **§1-3 の守りを外す**（関門①で差し戻し） |

### 3-1a `_edgeLocked` を所有権方式に（段1の正しさの修正）
```
function _edgeLocked(fn, waitMs, label):
  lock = getScriptLock()
  kind = _edgeKindOf(label)                 // 許可リスト { slots, all, home, fullSync }・外は OTHER
  owned = false; nested = false
  if lock.hasLock():                        // 呼び出し元が既に持っている＝取り直さない
     nested = true
  else:
     t = now(); owned = lock.tryLock(wait); waitMs = now() − t
     if !owned:
        _edgeTallySkip(kind)                // メモリに溜める（ロックは持っていない）
        _edgePushFlushIfOwner()             // 外側が無ければここで書く（best-effort）
        return                              // 今と同じ（undefined＝見送り）
  t0 = now(); r = undefined; err = null; threw = false
  try {
     try { r = fn() }
     catch (e) { err = e; threw = true }
     finally {
        // ★内側の finally：本体が戻っても投げても、ここで終了時刻と記録項目をメモリに確定する
        _edgeTallyRun(kind, nested, now() − t0, waitMs, threw)   // 数だけ（固定の kind・数値・真偽値）
     }
  } finally {
     if (owned) lock.releaseLock()          // ★自分で取ったときだけ放す
  }
  if (owned) _edgePushFlush()               // ★解放の後に best-effort（例外は握りつぶす）。nested はここで書かない（3-1b）
  if (threw) throw err                      // 元の例外をそのまま投げ直す（包まない）
  return r                                  // 元の戻り値をそのまま
```
- `_lbReserveCoreImpl`（6112〜6115 の `hasLock` と `_lbOwnedLock`）と同じ型。
- ★`pushToEdgeHome` はいま `_edgeLocked(_pushToEdgeHomeImpl)` で label を渡していない（PushToEdge.js 1824）。**実装で `'home'` を渡す**（渡さないと `OTHER` に入る）。検査⑧で home の鍵に入り `OTHER` に入らないことを固定。
- GAS のロックが入れ子を数えるかに頼らない。外側が取ったロックは外側が放す。
- 押し出し同士・押し出しと書き込みの関係は変わらない（ScriptLock 1つのまま）。作業依頼の中から呼んだ押し出しも、作業依頼のロックの中で走る（今の意図どおり）。
- 本体の例外の扱いは今と同じ（今の `_edgeLocked` も `try { return fn(); } finally { releaseLock }` で例外を外へ出す・1539）。変わるのは、例外の回も記録に残ることだけ。

### 3-1 押し出しの記録：`LB_EDGE_PUSH_COUNT`
```
{ 'yyyy-MM-dd': { <kind>: { n, thrown, skip, holdMax, holdSum, over10Sum, waitMax } } }   直近3日
kind ＝ 許可リスト { slots, all, home, fullSync, OTHER }
       ＋ 呼び出し元が既に ScriptLock を持っていた回（nested）：
           作業依頼の実行中（edgeJobPoll が立てるメモリの印 _EJ_IN_RUN が真）なら 'job_' ＋ kind
           それ以外なら 'nested_' ＋ kind（いまのコードには無い経路。出たら日次点検が warn）
       ＋ jobHold（edgeJobPoll が書き込みの作業でロックを持った時間：n・thrown・holdMax・holdSum・over10Sum）
```
- `_edgeLocked` の中で測る：`waitMs`＝`tryLock` にかかった時間、`holdMs`＝本体の時間（例外で終わった回も含む）、`over10Sum`＝Σmax(0, holdMs−10,000)（**書き込みが落ちうる到着の窓の秒数＝2-1 の推定を実測に置き換える**）。`n`＝本体を走らせた回（例外の回を含む）、`thrown`＝そのうち本体が例外を投げた回、`skip`＝見送った回（既存の `LB_EDGE_LOCK_SKIPS` は累計のまま残す）。
- ★**記録はロックの中で書かない。** 順序は「本体が終わる（戻る／投げる）→ 内側の finally で計測値をメモリに確定 → `releaseLock()`（自分で取ったときだけ）→ 記録を best-effort で書く（例外は握りつぶす）→ 元の戻り値を返す／元の例外を投げ直す」。ロックを持たずに読み・足し・書くので、同時に終わった2つの片方が落ちうる＝点検では**下限**と表示。
- **nested の分類の根拠（第4版で grep した `_edgeLocked` の全呼び出し元）**：
  | 呼び出し元 | 経路 | 外側の ScriptLock |
  |---|---|---|
  | `pushToEdgeAll`（1545） | トリガー `pushToEdgeLight`（1785）・`pushToEdgeAllText`（1635）＝エディタか作業依頼 `pushAll`（EdgeJob.js 205）・MemberMerge.js 207 の案内（エディタで手動） | **作業依頼 `pushAll` のときだけ持つ**（`pushAll` は書き込みの作業＝worker/src/routes/jobs.js 18 `WRITE_OPS`、EdgeJob.js 262〜264 でロック） |
  | `pushToEdgeFullSync`（1552） | トリガーだけ | 持たない |
  | `pushToEdgeSlots`（1688） | トリガー・カレンダー同期の後ろ `_lbCalSlotsAfter`（2762・UserLock を放した後）・切り替え関数 `_lbConsecSwitch`（LineBooking.js 4189・4199＝エディタ） | 持たない |
  | `pushToEdgeHome`（1824） | トリガーだけ | 持たない |
  作業依頼のもう1つの書き込みの作業 `quotaBuild`（EdgeJob.js 204 → `quotaBuildText` 3577〜3852）は押し出しを呼ばない（grep）。
  ＝いまのコードで nested になるのは作業依頼 `pushAll` だけ。ただし「`hasLock()` が真＝作業依頼」と決め打たず、作業依頼の印で分ける（将来ほかの外側ロックの経路が増えても `job_` に混ざらない）。
- 第2版の `jobLockLost`（数えるだけ）はやめた。所有権方式で原因を取り除く（3-1a）。

### 3-1b 作業依頼の中の押し出しの記録（専用の flush）
- `edgeJobPoll` は `_ejRun` を呼ぶ前にメモリの印 `_EJ_IN_RUN = true` を立て（★解除 `_EJ_IN_RUN = false` は `_ejRun` の try/catch/finally を包む**専用の外側の finally** に置く＝成功・例外・flush の例外のどれでも必ず偽に戻る）、溜めの器 `_EDGE_PUSH_TALLY` を空にしておく。nested の `_edgeLocked` は記録を**溜めるだけ**で書かない（作業依頼のロックの中で setProperty しない）。
- **`edgeJobPoll` のロックの解放（EdgeJob.js 280〜281 の `finally { lock.releaseLock() }`）の直後に専用の flush を置く**：`_EJ_IN_RUN = false` → `jobHold` を溜めに足す → `_edgePushFlush()`（best-effort）。この flush は `_ejPost`（報告）より前でも後でもよいが、報告の `ok`／`error`／`result` を作り終えた値に触らない。
- 規定：
  1. `_ejRun` が押し出しの**後**に例外を投げても flush する（flush は `finally` の外側の、解放の後に必ず通る位置＝`try { _ejRun } catch { err } finally { release }` の次の文。catch が例外を飲むので必ず到達する）。
  2. 1回の作業依頼で押し出しを複数回呼んだら、**全部**溜めに足す（kind ごとに n・holdSum 等を加算）。
  3. flush の後は溜めを空にする（同じ実行で二度書かない）。flush が失敗しても溜めは空にする（次の実行へ持ち越さない＝GAS の実行ごとに器は消えるが、同じ実行の中の二重記録を防ぐ）。
  4. setProperty は必ずロックの解放の後。
  5. 記録の例外は `ok`／`error`／`result` を変えない（flush は try/catch で握りつぶす）。
- 書き込みの作業でない（`isWrite` が偽で）ロックを取らない作業依頼から押し出しが呼ばれた場合は、`_edgeLocked` が自分で取る（owned）＝通常の記録の経路（作業依頼の印が立っていても nested ではないので `job_` にしない）。いまのコードでは `pushAll` は書き込みの作業なので起きない。

### 3-2 書き込みの記録：`LB_WRITE_LOCK_COUNT`
```
{ 'yyyy-MM-dd': { <op>: { n, busy, waitMax } } }   直近3日
op ＝ 許可リスト { reserve, cancel, change, undoSdc, recurAdd, recurDel, verify, selfReg, merge, offline, OTHER }
```
- 3-3 の共通関数がロックを取りに行くたびに数える：`n`＝ロックを取りに行った回（母数）、`busy`＝取れずに `BUSY` を返した回、`waitMax`＝取れた回の待ちの最大。既に持っていて取らなかった回（`owned:false`）は数えない。
- 数は要求の中ではメモリ（`_LB_LOCK_TALLY`）に溜め、**要求のすべての出口で1回だけ**ロック無しで書く（flush）。flush 自身の例外は握りつぶす。flush した後は溜めを空にする（二重に書かない）。出口の一覧：
  | 入口 | 出口 | 対象 |
  |---|---|---|
  | `doGet` → `handleLineGet`（LineBooking.js 248〜） | 正常の末尾（`_lbWpFinish` の後）と、例外を投げ直す catch（262〜267）の両方＝`try/finally` 相当 | LIFF の8操作 |
  | `doPost`（148〜・旧経路だが公開 Web App で到達可能＝170〜174 のコメント） | 1つの出口（`_res` を返す直前）と例外の経路 | `verifyMembership`（177） |
  | `liffApi`（207〜） | 返す直前と例外の経路 | `verifyMembership`（217） |
  | エディタの保守関数 `mergeMemberLink`・`addOfflineMember` | 関数の `finally` | merge・offline |
  入口の数は実装の前に `_lbTakeWriteLock` を呼ぶ10関数の呼び出し元を全部たどって確かめ、上の表に足す（検査①が3入口を通す）。
- 母数は「対象10操作がロックを取りに行った回」で、**全書き込みのロックではない**（3-8 の表示にも明記）。
- `LB_WRITE_PERF` のリング（標本・I77）は今のまま。`BUSY` の行が残り、最後の印は `lock`。

### 3-1・3-2 に共通の決まり
- **記録の関数の引数は「固定の文字（kind／op の許可リストの値）と数」だけ。** 例外の文・customerId・reservationId・氏名・LINE ID を引数に取らない（取れない形にする）。許可リストに無い名前は `OTHER`。★これを**構文の検査で固定する**（検査⑪：記録の関数の呼び出しの引数が、文字列リテラル（許可リストの値）と数値の式（ローカルで測ったミリ秒・定数）だけであること）。
- 書く前に値を JSON にして **UTF-8 のバイト数を測る**。8,000バイトを超えたら古い日から落として測り直す。今日1日だけで超えたら書かず、`LB_LOCK_COUNT_BAD` に鍵の名前と時刻だけを残す（日次点検が high）。読めない・壊れた値は上書きせず同じく時刻だけ（中身は写さない）。
- **記録の失敗で押し出し・書き込みの結果を変えない**：記録の関数が例外を投げても、本体の戻り値・本体の例外・ロックの解放が変わらない（検査⑫の fault injection で固定）。

### 3-3 A2：ロック待ちの時間切れは `BUSY` で返す
- **対象は §1-2 の10か所すべて**（除外なし）。理由：どれも `waitLock` の例外が `doGet` で `{error}` になり、画面は意味の分からない失敗の文を出す。保守関数（`mergeMemberLink`・`addOfflineMember`）もエディタで例外より `BUSY` の方が分かりやすい。
- 共通関数 `_lbTakeWriteLock(op)`：`getScriptLock()` → 既に持っていれば `{ got:true, owned:false }`（6114 の `hasLock` の扱いを引き継ぐ）→ `tryLock(10000)` → 取れなければ `{ got:false }`。
- **`tryLock` が偽のときだけ `BUSY` を返す。ロックを取った後の例外は今のまま**（`BUSY` に変えない＝別の失敗を「混んでいる」に見せない）。
- 返す形：LIFF から呼ばれる8つは `{ success:false, code:'BUSY', message:'ただいま混み合っています。少し時間をおいてもう一度お試しください（まだ何も変更されていません）。' }`。`mergeMemberLink` はその関数の形 `{ ok:false, code:'BUSY' }`、`addOfflineMember` は `{ success:false, code:'BUSY', message }`。
- ★返す前に `_lbWpMark('lock')`（記録の最後の印を `lock` にする）。変更 9335 は `try` の前＝何も書いていない（補償は要らない）。取消・当日取消の戻し・固定枠も、ロックの前に書き込みは無い（実装時に各関数で確かめ、検査⑤で固定）。
- `closeAllocationMonth`（30秒・保守）と web 体験予約（gas/コード.js 630）は**対象外**：前者は保守者が結果を見る月締めで待ちも長い、後者は別の画面で本件の観測（LIFF の書き込み）と関係しない。検査④の許可リストに理由つきで載せる。

### 3-4 画面：`BUSY` の専用の表示
新しい文言の鍵 `busy_retry`（ja・en・zh・zh-Hant）＝「ただいま混み合っています。少し時間をおいてもう一度お試しください（まだ何も変更されていません）。」
| 画面 | 行 | いま | 変えたあと |
|---|---|---|---|
| 会員の予約・変更の確定 | `liff/index.html` 4189 | `res.message \|\| book_fail` | 変えない（`res.message` が出る）。`BUSY` は SLOT_TAKEN の封鎖をしない＝押し直せる（検査⑥で固定） |
| 会員の自己登録 | 1790 | `res.message \|\| reg_fail` | 変えない（`res.message`） |
| 会員の取消 | 3653（文言 469 `err_cancel`） | 「キャンセルに失敗しました（コード：BUSY）」 | `res.code==='BUSY'` → `t('busy_retry')`。入力（理由）は残す |
| 会員の取消（旧経路 `_cancelReservationLegacy`・`CXL_ON` が偽のとき 3538〜3540 から） | 3520〜3525 | 「キャンセルに失敗しました（コード：BUSY）」 | `BUSY` → `t('busy_retry')`。到達不能の証明はしない（`CXL_ON` は戻し方として残っている）ので分岐を足し、検査⑥で通す |
| トレーナーの取消 | 2548〜2551 | 「キャンセルに失敗しました（BUSY）」 | `BUSY` → `t('busy_retry')` |
| オーナーの無料取消 | 2557〜2560 | 「無料での取り消しに失敗しました（BUSY）」 | 同上 |
| 当日取消を無料に直す | 1987〜1991 | `res.message` を alert | `BUSY` → `t('busy_retry')`（明示する） |
| 固定枠の追加・削除 | 3407／3386 | `recur_add_fail`／`err_cancel` にコード | `BUSY` → `t('busy_retry')` |
| 旧 LIFF の会員登録 | gas/LiffApp.html 168 | `res.message` | 変えない |

### 3-5 判定できないとき
| 状況 | 返すもの |
|---|---|
| 書き込みがロックを取れない | `BUSY`（何も書かない） |
| ロックを取った後の例外 | 今のまま例外（`THROW` として記録） |
| 記録が読めない・壊れている・8,000バイトを超える | 書かない・`LB_LOCK_COUNT_BAD` に時刻・点検 high。押し出しと書き込みの結果は変えない |
| 押し出しの kind／書き込みの op が許可リストに無い | `OTHER` に数える |

### 3-6 戻し方
- コードを戻す GAS の反映（スイッチは付けない：記録は結果を変えず、A2 は誤った案内を正す変更、3-1a は作業依頼の排他を外さないための修正で、どれもオフに戻す理由が無い）。画面は main を戻す。
- 記録の Script Property は残っても害が無い（読む側が無くなるだけ）。

### 3-7 天井・個人情報
- Script Property が3つ増える（`LB_EDGE_PUSH_COUNT`・`LB_WRITE_LOCK_COUNT`・`LB_LOCK_COUNT_BAD`）。コードが書く（画面から足さない・MODEL.md §7）。値は8,000バイト以下を書く前に確かめる。トリガー0本増。
- 個人情報：記録は固定の名前と数だけ。関数の引数の形で、ID・例外の文を渡せないようにする。

### 3-8 日次点検（`dailyHealthCheck`）と作業依頼 `remaining {writePerf:true}` に載せる表
| 行 | 出すもの | 重さ |
|---|---|---|
| **対象10操作のロック競合**（全書き込みのロックではない） | op ごとの `busy/n`（下限）・`waitMax` | `busy` ≥1 で warn |
| 押し出しが握った時間 | kind ごとの `n・thrown・holdMax・平均・over10Sum`・`skip`（`job_`・`nested_`・`jobHold` は別の行・下限） | `over10Sum` > 0 で warn（書き込みが落ちうる窓の秒数）／`thrown` ≥1 で warn |
| 長すぎる押し出し | `holdMax` > 300秒（6分の制限に近い） | warn |
| 想定外の入れ子 | `nested_*`（作業依頼の外で、呼び出し元が ScriptLock を持ったまま押し出しを呼んだ回） | ≥1 で warn |
| 記録が壊れた／大きすぎた | `LB_LOCK_COUNT_BAD` | high |
| 昨日の押し出しの記録が無い | — | high（押し出しが走った証拠が無い） |

### 3-9 入口から通す検査（`worker/test/gas-write-lock.test.js`・`gas-push-count.test.js`・`gas-lock-syntax.test.js`・`liff-busy.test.js` 案）
LockService の身代わりは**再入を許さない**（GAS の未確認の仕様を真にしない）：実行ごとに別の lock オブジェクト。`tryLock` は「他の実行が持っていれば偽、持っていなければ取る」、`hasLock` は「この実行が持っているか」、`releaseLock` は「この実行のロックを外す（入れ子を数えない）」。同じ実行の中で既に持っているときの `tryLock` は**例外を投げる**（呼んだら検査が落ちる＝取り直しをしていないことの確かめ）。
| # | 通すもの | 確かめること | 壊して落ちることの確かめ方 |
|---|---|---|---|
| ① | 別の実行が ScriptLock を持った状態で、入口から10関数すべてを呼ぶ：`doGet`→`handleLineGet` から変更・取消・予約・当日取消の戻し・固定枠の追加/削除・自己登録／`verifyMembership` は **`doGet`・`doPost`・`liffApi` の3入口**／`mergeMemberLink`・`addOfflineMember` は関数を直接 | 応答が `BUSY`（各関数の形）・台帳と名簿に1セルも書いていない・`LB_WRITE_PERF` の行のコードが `BUSY`（対象の op）・`LB_WRITE_LOCK_COUNT` の `busy` が入口ごとに1増える（flush が全出口で走る） | どれか1か所を `waitLock(10000)` に戻す → `{error}` か例外になり落ちる。`doPost`・`liffApi` の flush を消す → その入口の `busy` が増えず落ちる |
| ② | ロックを取った後に台帳の読みで例外を投げる身代わり（`handleLineGet` の catch 262〜267 を通る） | `BUSY` ではなく例外のまま（`THROW`）・`n` は1増え flush も走る | 共通関数で例外を全部 `BUSY` にする → 落ちる。catch の側の flush を消す → 落ちる |
| ③ | 変更から予約の芯（既にロックを持つ） | 芯は取り直さず（`tryLock` が呼ばれない＝身代わりが例外を投げない）・`n` を二重に数えない・変更の終わりまでロックを持つ | `hasLock` の確認を消す → 身代わりの例外で落ちる |
| ④ | **構文の固定**：gas/*.js を、コメント・文字列・正規表現リテラルを取り除く小さな字句解析を通し、`getScriptLock()` を受けた識別子（または `getScriptLock()` の直後）への `.waitLock(` の呼び出しを集める | 集合が許可リスト（`closeAllocationMonth`・web 体験予約の2つ）と完全一致。`_lbTakeWriteLock('<op>')` を呼ぶ関数の集合が対象10関数と完全一致。**増えたら落ちる** | **陽性 fixture**：反映前の版（いまの HEAD の gas/）を入力にすると既存の**12か所**（10＋7005＋コード.js 630）を全部拾う。**陰性 fixture**：コメントの中・文字列の中・`getUserLock()` や別のオブジェクトの `waitLock` を拾わない。新しい関数に `getScriptLock().waitLock(10000)` を足すと落ちる |
| ⑤ | ①の各関数で、ロックの前に台帳・名簿へ書く文が無いこと | 身代わりのシートへの書き込みが0回 | ロックの前に1セル書く行を足す → 落ちる |
| ⑥ | 画面（jsdom・`liff/index.html`）：確定・会員の取消（新しい経路）・**旧取消経路 `_cancelReservationLegacy`（`CXL_ON` が偽のとき・3520〜3525／3538〜3540）**・トレーナーの取消・無料取消・当日取消の戻し・固定枠の追加/削除に応答 `{success:false, code:'BUSY', message}` | `busy_retry` の文（確定と自己登録は `res.message`）が出る・ボタンが押せる・SLOT_TAKEN の封鎖をしない・会員の取消は理由の入力が残る。4言語に鍵がある | 1画面の `BUSY` の分岐を消す → 「コード：BUSY」の文になり落ちる |
| ⑦ | **所有権方式**：(a) 外側の実行がロックを取得 → `_edgeLocked` を通す（作業依頼から `pushToEdgeAllText` と同じ形）→ 戻った後も外側の `hasLock()===true`。(b) 外側が持たないとき `_edgeLocked` は取り、終わったら放す（`hasLock()===false`）。(c) 別の実行が持つとき見送り | (a)(b)(c) のとおり・(a) で `tryLock` が呼ばれない | `finally` の `if (owned)` を外す → (a) で外側のロックが外れて落ちる。入口の `hasLock()` を消す → 身代わりの例外で落ちる |
| ⑧ | 押し出しの記録：`pushToEdgeLight`／`pushToEdgeSlots`／`pushToEdgeHome` を身代わりの時計で走らせる（本体 15秒・2秒・0秒）・見送り・**押し出しの本体が例外を投げた回**（本体 12秒の後に投げる身代わり） | `n・holdMax・over10Sum`（15秒→5,000）・`skip`。★`pushToEdgeHome` の回は `home` の鍵に入り `OTHER` に入らない。例外の回も `n`・`thrown`・`holdMax`（12秒）・`over10Sum`（2,000）が記録され、**解放の後に元の例外が同じオブジェクトのまま投げ直される**（`===` で比べる）。★呼ばれた順が「本体の終わり → releaseLock → setProperty」（身代わりが呼び出しの順を記録し、`LB_EDGE_PUSH_COUNT` の setProperty がロックを持たない間に呼ばれたことを確かめる）。例外の回も同じ順 | `over10Sum` の 10,000 を 0 にする → 落ちる。記録を `releaseLock()` の前へ移す → 順序の確かめで落ちる。内側の finally を外して記録を `fn()` の後ろに置く → 例外の回が記録されず落ちる。例外を包んで投げ直す → `===` で落ちる |
| ⑨ | 記録の大きさ：大きな過去の日を入れた状態で書く | 書いた値が 8,000バイト以下・古い日から落ちる・今日だけで超えたら書かず `LB_LOCK_COUNT_BAD` | バイト数の確認を文字数にする（多バイト文字を混ぜた身代わりで落ちる）・確認を消す |
| ⑩ | 個人情報：①⑧の後の全 Script Property の値 | 会員ID（`C`+数字）・`U`+32桁・予約ID の形・例外の文が無い（正規表現で全数） | 記録の関数に reservationId を渡す行を足す → 落ちる（⑪でも落ちる） |
| ⑪ | **記録の API の引数の構文検査**：④と同じ字句解析で、記録の関数（押し出しの記録・書き込みの記録・flush）の呼び出しをすべて集め、引数が文字列リテラル（許可リストの値）・数値リテラル・計測用のローカル変数（数値と真偽値・名前の許可リスト。例 `holdMs`・`waitMs`・`threw`・`got`）だけであること | 全呼び出しが条件を満たす・呼び出しが0件でない | 引数に `customerId`・`e.message`・`reservationId` を渡す行を足す → 落ちる。陽性 fixture（いまの許された呼び出しを全部拾う）・陰性 fixture（コメントの中の呼び出しを数えない） |
| ⑫ | **fault injection**：記録の関数（`PropertiesService` の `getProperty`/`setProperty`）が例外を投げる身代わりで、①②⑦⑧を流し直す | 本体の戻り値（`BUSY`・成功）・本体の例外（②）・ロックの解放（⑦⑧の `hasLock`）が、記録が成功したときと同じ | 記録の呼び出しから try/catch を外す → 戻り値か解放が変わり落ちる |
| ⑬ | トリガーの集合 | 0本増（`gas-edge-defer.test.js` ⑦ と同じ集合） | — |
| ⑭ | **作業依頼の中の押し出し**（`edgeJobPoll` を身代わりの Worker と一緒に入口から）：(a) `pushAll` の押し出しが成功した後、`_ejRun` の後続が例外を投げる (b) 1回の作業依頼で押し出しを2回呼ぶ (c) flush の setProperty が例外を投げる | 3つとも、作業依頼のロックを**放した後**に `LB_EDGE_PUSH_COUNT` の setProperty が**一度だけ**呼ばれ、溜めた全部（(b) は `job_all` の n=2）と `jobHold` が入る。作業依頼のロックの中では setProperty が0回。報告 `_ejPost` の `ok`／`error`／`result` は記録が無い場合と同じ（(a) は ok:false と同じ error・(c) は ok:true と同じ result）。nested の分類は `job_all`（`nested_all` ではない）。★`_ejRun` の成功・例外・flush の例外のすべてで、`edgeJobPoll` が戻った後 `_EJ_IN_RUN===false`。続けて同じ実行の中で（印なしで）外側がロックを取って `pushToEdgeAll` を呼ぶと `nested_all` に入る | flush を `finally` の中（解放の前）へ移す → 順序で落ちる。flush の後に溜めを空にしない → 二度書いて落ちる。flush の try/catch を外す → (c) で報告が変わり落ちる。作業依頼の印を見ずに nested を全部 `job_` にする → (d) で落ちる |
| ⑮ | **nested の分類**：(d) 作業依頼の印を立てずに、外側でロックを取ってから `pushToEdgeAll` を呼ぶ | `nested_all` に入り `job_all` に入らない・日次点検が warn を出す | 分類を `hasLock()` だけにする → 落ちる |

★文字列の有無で合否を決めない（コメントに当たって素通りする）。入口から通して返る値・身代わりのシートとロックの状態・呼ばれた順で見る。④⑪は構文を見るが、コメント・文字列を落としてから数え、陽性・陰性の fixture で字句解析そのものを確かめる。

---

## 4. 段2（構造を直す）：段1の実測の後に別の設計で。候補だけ
各候補が「書きかけを写さない（U2）」と「押し出し同士の後着の巻き戻し（1500行）」をどう守るか。
| 候補 | 書きかけを写さない（U2） | 後着の巻き戻し |
|---|---|---|
| ① ロックの中では**読みだけ**（シートを一度に読んで手元に一貫した写しを取る）、計算と送信はロックの外 | 読みはロックの中＝今と同じ | ロックの中で進める押し出しの通し番号を送信に載せ、古い番号を捨てる（枠の世代 `LB_SLOTS_LAST_PUSHED_BUILT_AT` と同じ型） |
| ② 押し出しの**頻度・中身を減らす**（light の中で変わっていない表を送らない・計算入力を差分に） | 変えない（ロックの中のまま） | 変えない（ロックで直列） |
| ③ 重い **home の残数計算を分ける**（読みだけ①の型でロックの中、計算はロックの外／会員を小分けにして1回の保持を短く） | 読みはロックの中 | 会員ごとの covers（I79）は置き換え＝古い送信は閉じる側。値は①の番号で捨てる |
| ④ 書き込み側が**書きかけを作らない**（名簿の1行を `setValues` 1回で書く・固定枠の削除を1回の書き込みに）うえで、押し出しのロックを書き込みと別にする | 1回の書き込みが他の実行から途中で見えないこと（GAS の範囲の書き込みが原子的かは**未確認**）が前提。書きかけを作る書き込みが今後増えない検査も要る | 押し出し同士は別のロック（リース等）。第1版の関門①の指摘（§6・期限切れでの後着・取得順の循環）に答える必要 |
| ⑤ トリガーの位相・間隔を変える | 変えない | 変えない |
どれを取るかは段1の kind ごとの `over10Sum`・`holdMax` と `busy/n` で決める。

---

## 5. 段取り（WBS）
| # | 作業 | 依存 | 完了の条件 |
|---|---|---|---|
| 1 | 関門①第4周：第4版＋MODEL.md を Codex に | — | §6 に対処を残す |
| 2 | 検査を先に書く（3-9 ①〜⑮） | 1 | 今のコードで ①③④⑥⑦⑧⑪⑭⑮ が落ちる（赤）ことを確かめる（④⑪は陽性・陰性 fixture が通ることも） |
| 3 | 実装：3-1a（本体の例外も記録）・3-1・3-1b（作業依頼の専用 flush）・3-2（全出口の flush）・3-3・3-4・3-8 | 2 | `bash worker/test/run-all.sh` 全部通る・3-9 の壊し方で落ちた記録 |
| 4 | 関門②（とくに「この変更が新しく持ち込んだ不具合」・個人情報・ロックの区間を延ばしていないか） | 3 | — |
| 5 | 関門③（既定オフのスイッチが無い＝全員に出る）：「BUSY の文が出て困る場面は無いか」「BUSY のはずが例外に／例外のはずが BUSY に化ける経路は無いか」 | 4 | — |
| 6 | GAS 反映1回（★オーナー・他の束と同梱可）＋画面は main へ（オーナーのマージ） | 5 | 版の印・作業依頼で `LB_EDGE_PUSH_COUNT` が増えている |
| 7 | 数日、kind ごとの `over10Sum`・`holdMax`・`jobHold`・対象10操作の `busy/n` を読み、§2 の推定を実測で置き換える | 6 | 本書に実測を追記・段2の設計を起こすかを決める |
| 8 | MODEL.md（I77 の隣に「ロック待ちは BUSY・記録の鍵と出口」、§1-3 の守りと `_edgeLocked` の所有権方式を不変条件として、§7 天井）・ROADMAP を更新 | 3 | model-doc.test.js が通る |
オーナーにしかできない操作：GAS 反映1回（6）・main へのマージ。

---

## 6. 関門①の指摘と対処

### 第1周（第1版・手段A リース）— 差し戻し
| 指摘 | 対処 |
|---|---|
| U2 は反証：`verifyMembership`（714〜718）が ScriptLock の中で名簿の同じ行を複数セルに分けて書き、押し出し（1567〜1570）も ScriptLock の中で customers を読む＝共通のロックが書きかけを写さない守り。`mergeMemberLink`・recurring の deleteStale も同じ（CEO 確認） | 手段Aを不採用。§1-3 を訂正。段2の候補は全部この守りへの答えを1行ずつ持つ（§4）。MODEL.md に不変条件として足す（WBS 8） |
| 完全同期とリースの取得順が循環しうる（ScriptLock→リースとリース→ScriptLock） | 手段Aを外したので**消えた**（第2版はリースを持たない。ロックは ScriptLock 1つのまま） |
| リースの期限切れで、まだ走っている押し出しを奪い、後着の巻き戻しが起きうる | **消えた**（リースが無い。押し出し同士は今どおり ScriptLock で直列）。段2で候補④を選ぶならこの指摘に答える |
| スイッチを切る瞬間にリースの押し出しと ScriptLock の押し出しが重なる | **消えた**（スイッチが無い） |

### 第2周（第2版）— 差し戻し
| 指摘 | 対処 |
|---|---|
| `LB_EDGE_PUSH_COUNT` をロックの中で書くと、ロックを持つ時間を記録の分だけ延ばす | 計測値をメモリで確定 → `releaseLock()` → 記録を best-effort（例外は握りつぶす・下限と表示）に変えた（3-1）。順序を検査⑧で固定 |
| 入れ子のロックを「数えるだけ」（`jobLockLost`）では、作業依頼の残りが排他なしで走りうる既存の不具合を放置する | `_edgeLocked` を所有権方式に直す（3-1a・`_lbReserveCoreImpl` 6112〜6115 と同じ型）。既存の不具合の可能性として §1-3 に明記。`jobLockLost` は廃止 |
| 検査⑦の「再入できる身代わり」は GAS の未確認の仕様を真にしてしまう | 身代わりは再入を許さず、同じ実行で取り直すと例外を投げる形にした（3-9 冒頭）。外側で取得 → `_edgeLocked` → 戻った後も外側が `hasLock()===true` を検査⑦(a)で固定 |
| `LB_WRITE_LOCK_COUNT` の flush が `handleLineGet` の末尾だけで、`doPost`・`liffApi`（`verifyMembership` は LineBooking.js 177・217 から到達）とロック取得後の例外で投げ直す経路（263〜267）で書かれない | 全出口で finally 相当の flush にし、flush 自身は握りつぶす（3-2 の出口の表）。検査①が3入口、検査②が例外の経路を通す |
| 旧取消経路 `_cancelReservationLegacy`（3520〜3525・`CXL_ON` が偽で 3538〜3540）に `BUSY` の分岐が無い | 到達不能を証明しないので分岐を足す（3-4 の表）。検査⑥に入れた |
| 検査①に `verifyMembership`・`mergeMemberLink`・`addOfflineMember` が無い／`verifyMembership` の3入口／④の字句解析の陽性・陰性 fixture／記録の関数が例外を投げたときの fault injection／⑥に旧取消経路 | ①を10関数すべて・`verifyMembership` は `doGet`・`doPost`・`liffApi` の3入口に。④に陽性 fixture（既存12か所を拾う）と陰性 fixture（コメント・文字列・別オブジェクトの `waitLock` を拾わない）。⑫ fault injection を新設。⑥に旧取消経路 |
| 点検の表示が全書き込みのロックに見える | 「対象10操作のロック競合」と明記（3-2・3-8） |
| 記録の API の引数が固定値と数値だけであることを構文で固定していない | 検査⑪を新設（引数は文字列リテラル・数値リテラル・計測用のローカル変数の許可リストだけ・陽性/陰性 fixture つき） |

### 第3周（第3版）— 差し戻し（第2周の7点は十分・残り3点）
| 指摘 | 対処 |
|---|---|
| `_edgeLocked` の本体が例外を投げた回は記録に届かない（第3版の擬似コード） | 内側の finally で終了時刻と記録項目をメモリに確定 → 自分で取ったロックを解放 → 解放後に best-effort で flush → 元の戻り値を返す／元の例外をそのまま投げ直す、に直した（3-1a）。`thrown` を数える。検査⑧に「本体が例外を投げた回」（n・holdMax・over10Sum が入る・解放後に同じ例外オブジェクトが投げ直される・順序）を足した |
| 作業依頼の中で溜めた記録をいつどう書くかが本文に無い | `edgeJobPoll` のロック解放（EdgeJob.js 280〜281）の直後に専用の flush を置くと明記（3-1b）。`_ejRun` が押し出しの後で例外でも書く／複数回の押し出しは全部溜める／書いたら空にする／setProperty は解放の後／記録の例外は ok・error・result を変えない、を規定。検査⑭(a)(b)(c) を新設 |
| `owned:false` を `job_` と呼ぶのは「呼び出し元が既に ScriptLock を持つ経路」と同値でない | `_edgeLocked` の全呼び出し元を grep でたどった表を 3-1 に載せた（いまは作業依頼 `pushAll` だけが外側のロックを持つ）。分類は作業依頼の印 `_EJ_IN_RUN` と `hasLock()` の両方で決め、印が無い入れ子は `nested_` に入れて日次点検が warn（3-1・3-8）。検査⑮を新設 |

### 第4周（第4版）— 条件付き通過（条件3点を反映して実装へ）
| 条件 | 対処 |
|---|---|
| 3-1a の擬似コードで `threw` を `_edgeTallyRun` に渡していない／検査⑪の許可引数に真偽値が無い | `_edgeTallyRun(kind, nested, holdMs, waitMs, threw)` に直した。⑪の許可に真偽値の計測用ローカル変数（`threw`・`got`）を含めた |
| `pushToEdgeHome` は label を渡していない（PushToEdge.js 1824）＝`OTHER` に入る | 実装で `'home'` を渡すと 3-1a に明記。検査⑧で home の鍵に入り `OTHER` に入らないことを固定 |
| `_EJ_IN_RUN` の解除の位置が決まっていない | 専用の外側の finally に置くと 3-1b に明記。検査⑭に「成功・例外・flush の例外のすべてで `_EJ_IN_RUN===false`」「続けて印なしの入れ子が `nested_` になる」を足した |

---

## 7. 固定枠の自動予約が BUSY に当たったとき（2026-11-20 実装の後に追加・CEO 裁定）

### 7-1 なぜ要るか
`autoBookRecurringPatterns`（毎月25日6時・月1回のトリガー）は外側でロックを持たずに予約の芯を呼ぶ。A2 の前は、ロックが取れないと `waitLock` の例外で**その回の全体が止まっていた**。A2 の後に何もしないと、BUSY をほかの失敗と同じく skipped に入れ、冪等マーク（LAST_MONTH）を付ける＝**二度と取られず、会員に「お取りできませんでした」と案内する**。どちらも不可（CEO 裁定）。

### 7-2 決めたこと
1. BUSY なら、その枠を3秒・6秒・10秒の間隔で最大3回取り直す。1回の取り直しはロック待ち10秒＋間隔なので1枠で最悪およそ1分。GAS の1実行は6分なので、**走り始めから4分を過ぎたら取り直さず、残りの会員は保留**にする。
2. それでも BUSY の会員は**保留**：その会員の残りの枠はこの実行では取らない／冪等マークを付けない／お知らせを送らない（BUSY を skipped に載せない）／25日のお知らせの件数（`LB_AUTOBOOK_RESULT_*`）に足さない。新しく取れた予約は写しへ積む（`lbDwEnqueue`）。
   - ★お知らせは「取り終えた実行で1回」にした。保留の実行で取れた分を先に送ると、再実行で同じ枠（本人の予約として見分けた `already`）をもう一度送ることになるため。取り終えた実行のお知らせには、前に取れていた分も入る。
3. 再実行で二重に取らない：冪等マークが無いので同じ会員の行をもう一度処理するが、前に取れた予約は既存の「本人の予約の見分け」（`_lbResvSessions` → `mine` → 同じ日・1時間以内の対応＝`_hitOf`）で `already` になり、予約の芯を呼ばない（検査③-1〜③-3）。月の回数の上限も、取れていた分を `_have` に数える。
4. 保留の人数を `LB_AUTOBOOK_HELD`（`{m: 対象月, n, at, tries, sched}`・会員IDなし）に残し、日次点検で warn「固定枠の自動予約を混雑で保留した会員 n 名・手動で autoBookRecurringPatterns を再実行」。

### 7-3 再実行の手段（比べて決めた）
| | 案 | トリガー | オーナー操作 | 取りこぼし |
|---|---|---|---|---|
| **採用** | **一回限りトリガー `lbAutoBookRetry`（15分後）で自分を取り直す**＋日次点検の warn | 保留があるときだけ一時的に1本（いま定期18本＋一回限りの最大数本＝20の内）。取り直しの入口で自分の予約を消す。月の定期とは別の名前なので、掃除で月の定期を消さない | 0（作れなかったとき・4回で解けないときだけ手動） | 同じ朝のうちに取れる（混雑は押し出しの重なり＝数十秒〜数分） |
| 不採用 | 日次点検の warn だけ | 0本 | 毎回オーナーかCEOが手で実行（CEO はエディタの関数を走らせられない＝オーナー操作） | 翌朝7時の点検まで気づかない。会員が先に予約を入れると枠が埋まる |
| 不採用 | 既存の定期（warmupCache・日次点検）に相乗り | 0本 | 0 | 自動予約は重い（全会員の台帳・カレンダー）。相乗り先の6分の枠を食う（日次点検は 557秒の前歴あり） |
- 取り直しは1つの月に4回まで（`tries`）。5回目は予約せず保留を残し、点検が「次の自動の取り直しはありません」と出す。作れなかった（上限20本など）ときも同じ。
- `lbAutoBookRetry` は別の月の保留・保留0なら何もしない（月が変わった後に古い保留で翌々月を取らない）。

### 7-4 検査（`gas-autobook-busy.test.js`・入口＝`autoBookRecurringPatterns`／`lbAutoBookRetry`）
①1回で解ける→取れる・マーク・お知らせに BUSY なし ②続く→3回取り直して保留・マークなし・お知らせなし・件数なし・ほかの会員は今どおり・保留の人数・トリガー1つ ③取り直し→前に取れた枠を二重に取らない・お知らせ1回・取り直しのトリガーだけ消す ④別の月・保留0・4回の上限・作れないとき ⑤4分を過ぎたら ⑥日次点検。トリガーの集合の検査（`gas-lock-syntax` ⑩・`gas-edge-defer` ⑦・`trigger-args` ③）に `lbAutoBookRetry` を一回限りとして足した。

---

## 8. 別件（この設計では扱わない・記録だけ）
- ScriptLock を長く握る処理はほかにもある：声かけ `lbNudgeDaily`（毎日10時・ロックの中で LINE を送る・Nudge.js 1152〜）、作業依頼の書き込み（EdgeJob.js 262・作業の間ずっと）、毎月25日の固定枠の自動予約。段1の記録では作業依頼だけ `jobHold` で数える。ほかの時刻に `busy` が出たらここを疑う。
- I79 の前提として、書き込みの台帳への書き込みが番号を進める（`lbDwEnqueue`）前に他の実行から見えるか（`SpreadsheetApp.flush()`）は全経路を確かめていない（第1版の U1）。今の ScriptLock でも防げていない（書き込みはロックを放してから番号を進める）ため本件と独立。段2の候補①③を設計するときに確かめる。
