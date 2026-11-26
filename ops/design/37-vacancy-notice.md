# 37 空き枠のお知らせ（3日前以降に空いた枠を、過去の予約者へ）【改訂5＝決定0216・2026-11-26】

> ★**優先の順は 改訂5 ＞ 改訂4 ＞ 改訂3 ＞ 改訂2 ＞ 改訂1 ＞ 本文。** 改訂5 は決定0216（オーナー 2026-11-26）で前提が変わったため、
> 本文〜改訂4 を**置き換える**（下に経緯として残す）。改訂5 に書いていないことで本文〜改訂4 と食い違うものは、改訂5 の方針（最小の面積）に従う。

## 改訂5（2026-11-26・CTO）

### 5-0 何が変わったか（決定0216）
| | 設計37（〜改訂4） | 改訂5 |
|---|---|---|
| 送る相手 | 自分で登録した会員（オプトイン画面） | **登録なし**。同じ曜日・前後1時間に直近8週で2回以上来た会員で残数かチケットがある人。1件のキャンセルにつき最大3名 |
| 文面 | 「空き」「キャンセル」「先着」を書かない | **「空きました」と書く**。誰がキャンセルしたかは出さない |
| 対象のキャンセル | 前々日0時〜前日 | **3日前の0時以降**（当日は対象外のまま・§5-19-1） |
| 0歩目（件数の計測） | 先に数える | **飛ばす**。`list`（送らずに記録）を2週回して実数にする |
| 段 | list → trainer → on | **off → list → on**（trainer 段は作らない §5-1） |
| 受け取らない | 画面のスイッチ | **お知らせのボタン「今後このお知らせを受け取らない」**（LINE の postback）＝ `vacancy_optout` に記録 |

★事実の訂正（決定0216 の「材料の cancel_notes が貯まらない」）：`cancel_notes` は**すべての取消**で1行を書く（`cancelReservationLine`・会員/トレーナー/オーナー・理由が無くても）。
GAS 反映と `setupCancelNotesSheet` は 11/7 に済み（ROADMAP）。貯まらないのは **理由（reason_key）とひとこと** だけ（新しい取消画面 CXL_DEFAULT_ON=false のため）。
この機能に要る `cancelled_at`・`start_at`・`trainer_id`・`customer_id`・`actor`・`outcome` は 11/7 から貯まっている。

### 5-1 比べた手段（オーナー操作数・戻せるか・変える面積）
| 手段 | オーナー操作 | 戻し | 面積 | 判定 |
|---|---|---|---|---|
| A 設計37（改訂4）のまま：登録画面・送る直前に予約確定の入口の3段を共通の関数に切り出す・状態機械＋lease | GAS 反映1回＋LIFF の公開 | スイッチ | **大**（予約確定 `_lbReserveCoreImpl` と `getTrainerSlots` を切り出す＝予約の経路そのものを触る・LIFF の画面） | 採らない：決定0216 で登録画面が要らなくなった。予約の経路を触る危険が、得るもの（送る直前の数秒の競合を消す）より大きい |
| B トレーナーに候補だけ知らせ、連絡は人が行う（設計37 の段2） | 同上 | 同上 | 中 | 採らない：決定は「自動で会員へ」。段を増やすと on までが遠くなる |
| **C（採用）** 自動・登録なし・**判定は既存の入口の関数を呼ぶだけ**（`getTrainerSlots`・`getBookingOptions`・`_lbBookingDeadlineMs`・`_lbCheckTrainerAvailable`）・**予約確定の経路と LIFF は触らない**・受け取らないは LINE のボタン | **GAS 反映1回だけ**（setup 関数なし・トリガーを足さない・Script Properties を画面で足さない） | スイッチ1つ（`LB_VACANCY_MODE` を消す） | 小（Nudge.js に1区画・warmupCache に1行・webhook の postback に1分岐・`_lbPushOnce` に Flex を渡す引数） | ✅ |

C で残る危険：送ってから会員が押すまでの間に枠が埋まる（数秒〜数分）。**予約そのものは予約確定の入口が最後に確かめる**（`_lbReserveCoreImpl` はロックの中で残数・B1・トレーナー・1F を見る）＝**取れない予約が作られることはない**。害は「押したら埋まっていた」の落胆だけ。文面の「ご予約の状況により、お取りいただけない場合がございます」で受ける。

### 5-2 範囲
- 作る：キャンセルを見つけて相手を選ぶ tick（10分ごとの `warmupCache` の末尾に相乗り）／お知らせの送信（Flex：本文・［予約画面を開く］・［今後このお知らせを受け取らない］）／受け取らないの postback／記録 `vacancy_notice`・`vacancy_optout`／作業依頼の読み取りとスイッチ（list・off だけ）／日次点検の見張り1つ（`vacancy_stale`）
- **やらない（第2段の候補）**：当日のキャンセル／時間変更（`changeReservationLine`）で空いた旧枠／オーナー（hidden）の枠／トレーナーへの候補の知らせ／LIFF で枠を指定して開く（`?vac=`・未確認の `liff.state` を避ける）／登録画面
- **触らない**：予約確定（`_lbReserveCoreImpl`）・`getTrainerSlots`・`getBookingOptions`・取消（`cancelReservationLine`）の中身・LIFF（`liff/index.html`）・Worker

### 5-3 倒れる向き
```
送ってよいか判定できない（枠・残数・担当・上限・受け取らない・記録が読めない・何通目か）→ 送らない。
間違ったお知らせ（取れない枠・予約できない人・2通目・夜）は、届かないより悪い（設計17）。
届いたか分からない（通信の例外）→ 送った扱い。二度と送らない。
倒れた回数は vacancy_notice の skip（理由ごとの人数）と state で数える（母数＝対象のキャンセルの件数）。
```

### 5-4 対象のキャンセル（cancel_notes の1行）
```
S = 開始（start_at・ms）。D0 = S の日の 0:00（JST）。deadline = _lbBookingDeadlineMs(S)（予約の締め切り・入口と同じ関数）
MARGIN = 2時間（設計37 §4-2 の推奨。オーナーが決めていない＝安全側の既定 §5-19）
対象 ＝ 次の全部
  actor = customer、または actor が trainer/owner で trainer_reason = customer_proxy（改訂1-5。第2段の理由の欄はまだ無い＝いまは会員本人の取消だけ）
  outcome = free か consumed（どちらも枠は空く。owner_free はオーナーの操作＝上の actor で外れる）
  D0 − 3日 ≦ cancelled_at < D0             （3日前の0時〜前日。当日は対象外）
  cancelled_at < deadline − MARGIN
  res_id・cancelled_at・start_at・trainer_id・customer_id が読める（数でない・空・未来の cancelled_at は対象外）
  同じ res_id の行が1つだけ（2つ以上は対象外＝取り違えない）
```
- 見る範囲：cancel_notes の末尾から最大300行のうち `start_at > いま` かつ `cancelled_at ≥ いま − 4日` の行。
- 送る時点でも `いま < deadline − MARGIN` を確かめ直す（夜の保留から明けたとき・時間がかかったとき）。過ぎていれば `too_late`。
- 例：金10:00 の枠 → 締め切り＝木22:00（午前枠）→ 対象＝月0:00〜木20:00 のキャンセル。木20:00 以降は too_late。

### 5-5 送る相手（全部を満たす人を、回数の多い順→最後に来た日が新しい順→顧客IDの順に最大3名）
| # | 条件 | 正本・関数 | 読めないとき |
|---|---|---|---|
| 1 | verified・契約 active・LINE の ID がある | 名簿（`_lbNudgeMembers`・Nudge の `_lbNudgeEligible` と同じ条件） | 名簿が読めない→その tick は誰にも送らない |
| 2 | キャンセルした本人でない | cancel_notes の customer_id | — |
| 3 | ★名簿の担当（E列）がその枠のトレーナー、または担当が空 | 名簿 | — |
| 4 | 直近8週（いま−56日〜いま）に、S と同じ曜日・開始が S の前後60分以内の**来店が2回以上**（担当は問わない） | 台帳の `confirmed` で開始が過去の行（来店＝Nudge・残数の「消化」と同じ。consumed は当日キャンセルが主なので数えない） | 台帳が読めない→送らない |
| 5 | D0 の日に予約（confirmed か consumed）が無い | 台帳（改訂2-5） | 同上 |
| 6 | 受け取らないを押していない | `vacancy_optout` | 読めない→送らない |
| 7 | 上限に当たらない（§5-6） | `nudge_log` | 読めない→送らない |
| 8 | **その枠を予約できる**：`getBookingOptions(会員の lineUserId, S)` が success で、`hasNormalRoute === true` か `pairRemaining > 0` | 予約画面が選択肢を出すのと同じ関数（残数・チケット・契約） | success でない・例外→その人は外す |

- ★3 は設計59（会員の予約は担当の週の表へ直行・main に入っている）のため。担当が別のトレーナーの会員にお知らせすると、画面からはその枠を取れない（公式LINEの案内に回る）。**決定0216 に無い条件＝オーナーに確かめる（§5-19-2）**。それまでは送らない側（この条件あり）で出す。
- 8 は人ごとに重い（契約の行を読む）。1〜7 で絞った順に呼び、**1枠につき最大6回**。3名に届いたら止める。
- 連続ルールは枠の段で効く（`getTrainerSlots` が会員には consecOk の枠だけ返す・I21〜I24。いま連続ルールは off）。

#### 枠の段（相手を選ぶ前・全部を満たさなければ誰にも送らない）
| 確かめること | 関数 | だめなとき |
|---|---|---|
| トレーナーが一覧にいて hidden でない | `_lbTrainerById` | `skip_trainer`（終わり） |
| 台帳に、同じトレーナーで S と重なる confirmed の予約が無い | 台帳（読む1回） | `filled`（終わり） |
| **会員に見える枠に S ちょうどがある** | `getTrainerSlots({trainerId}, '')`（lineUserId 空＝会員として扱う＝会員の画面と同じ答え。締め切り済みは `_lbDropClosedSlots` で落ちる） | `wait`（次の tick で見直す・6回で `not_offered`）。失敗の答え→`wait`（判定できない・6回で `unknown`） |
| トレーナーのカレンダーで今も空いている（出勤の中・予約/休憩/ブロックが無い） | `_lbCheckTrainerAvailable(trainer, S, S+60分)`（予約確定の入口と同じ関数） | false→`filled`（終わり）・例外→`wait` |
- ★キャッシュの枠（最大660秒）がキャンセルを映すまでは「S が無い」になる＝`wait` で次の tick に回す（6回＝約1時間）。

### 5-6 上限と時間帯（安全側の既定。オーナーが決めていない §5-19-3）
| | 既定 | 数えるもの（nudge_log） |
|---|---|---|
| 1日 | **その日に声かけ・お知らせ（`nudge_` の全種別）を1通でも受け取った人には送らない**＝お知らせは1日1通まで・声かけとも合わせて1日1通 | sent・sending（暦日 JST） |
| 1週 | お知らせは直近7日で **2通まで** | `nudge_vacancy` の sent・sending |
| 同じ枠 | 同じ人に二度送らない | 鍵 `vac|{trainerId}|{S}` の sent・sending・**failed**（改訂4-1） |
| 1枠 | 最大3名 | 鍵 `vac|{trainerId}|{S}` の sent・sending（全員分） |
| 時間帯 | **9:00〜20:00（JST）だけ送る**。外れたら `wait`（夜の保留）→ 次に時間帯に入った最初の tick で最初から確かめ直す | — |
| 声かけの後 | `LB_REMIND_ON='1'`（声かけが有効）の日は、**その日の声かけが終わった印**（`LB_NUDGE_DAILY_DONE`＝今日の日付）が出るまで送らない（改訂3-4）。印は lbNudgeDaily が一覧を作り送り終えた後に書く（ロック取れず・記録が読めない・記録に書けない、では書かない） | — |
- 既存の決まりに合わせた：声かけ（Nudge）は 10時・1人1日1通・sending は送った扱い／前日リマインド（12時）は予約に紐づく連絡なので数えない（nudge_log に載らない）。
- 声かけの側でも、今日のお知らせを1日1通に数える（`LB_NUDGE_DAILY_CAP_KINDS`＝`LB_NUDGE_ORDER`＋`nudge_vacancy`・改訂1-3）。声かけの優先順位（`LB_NUDGE_ORDER`）には足さない。お知らせは声かけの後にしか出ないので普段は効かないが、追いかけ送信（`lbNudgeCatchUpSend`）と重なったときの砦。

### 5-7 流れ（`warmupCache` の末尾・新しいトリガーは作らない）
```
warmupCache
  ├ _warmupCacheBody（枠の作り直し・今のまま）
  ├ lbNotifyRetryTick（今のまま）／_lbNotifyDeferDrain（今のまま）
  └ lbVacancyTick(_wcStart)   ← 1行足す（例外を外に出さない）
       ・mode を読む（'list' か 'on' だけ。それ以外は何も読まずに終わる）
       ・LB_VACANCY_LAST に {at, result} を残す（見張り）
       ・warmupCache の開始から 3分30秒 を過ぎていたら何もしない（result=late）
       ・同時に1本だけ：LB_VACANCY_LEASE（期限2分）をロック（tryLock 3秒）の中で取る。取れなければ終わり
       ・使ってよい時間 45秒。1回に扱う枠は最大3つ
       1. cancel_notes の末尾を読み、§5-4 の対象と、vacancy_notice の終わっていない行を拾う
       2. 安い判定から：時間帯・声かけの印・締め切り−MARGIN → だめなら wait か too_late（重い読み取りをしない）
       3. 枠の段（§5-5）
       4. 相手を選ぶ（名簿・台帳・受け取らない・nudge_log は tick に1回だけ読む）
       5. list：送らずに「送るはずだった相手（顧客IDの下4桁）と外した理由」を vacancy_notice に書く → listed
          on  ：§5-8 で1人ずつ送る → sent（だれにも送れなければ no_target）
       6. vacancy_notice に結果（state・人数・理由ごとの人数・かかった時間・版の印）を書く
       ・最後に LEASE を放す
```

### 5-8 送り方（on のときだけ・1人ずつ）
```
① 残り時間が5秒未満なら止める（sending を書く前）。枠は wait のまま次の tick へ
② ScriptLock（tryLock 5秒。取れなければその人は次の tick へ）
     nudge_log の先頭（LB_NUDGE_LOG_SCAN 行）・vacancy_optout を読み直す
     その人を再判定：今日1通・週2通・同じ枠（failed も）・1枠3名・受け取らない
     通れば nudge_log の2行目に 'sending'（種別 nudge_vacancy・鍵 vac|T|S）→ flush
   ロックを放す（書けなければ送らない）
③ _lbPushOnce(to, 代わりの文, { messages:[Flex], noInlineRetry:true, purpose:'nudge_vacancy' })   ← ロックの外（I19）
④ ScriptLock（tryLock 5秒）：先頭50行から「種別・顧客ID・鍵・sending」の行を探して sent／failed に書き換える
     見つからない・ロックが取れない → sending のまま（送った扱い＝再送しない）
     通信の例外（uncertain）→ sending のまま
```
- `_lbPush`（送り直しの列に積む）は使わない＝`nudge_` は `_lbNqPolicy` で none（I18）。429 は failed（その枠では送り直さない・1日1通に数えない）。
- 二重送信の防止：①同時に1本（LEASE）②人×枠の鍵（ロックの中で読み直してから sending）③1枠3名もロックの中の数で決める。vacancy_notice の state は記録で、送る権利の正本は nudge_log。

### 5-9 文面（Flex 1通・4言語・敬体・名前を入れない＝Nudge と同じ）
```
ご予約のお時間が空きました。

{11月28日(金) 10:00}〜　{トレーナー名}
（ご予約の受付は {11月27日(木) 22:00} までです）

ご都合が合いましたら、下記よりお待ちしております。
ご予約の状況により、お取りいただけない場合がございます。

［予約画面を開く］（https://liff.line.me/{LIFF の ID}）
［今後このお知らせを受け取らない］（postback vac=off）
```
- 代わりの文（altText・通知の一覧に出る）：「ご予約のお時間が空きました（{日時}〜）」
- 「キャンセル」と書かない・誰が・何人・理由を書かない。URL に顧客を指す値を入れない（今の LIFF の入口のまま）。
- 日時・締め切りは送る瞬間に計算する。トレーナー名は `_lbTrainerNameLang`（en/zh は英語名）。日時は `_lbFmtResvLabel`。

### 5-10 受け取らない（postback）
- ボタンを押す → LINE が webhook へ postback（`data='vac=off'`）→ `handleLineWebhook` の postback の分岐で **meal-ai より前に** `_lbVacPostback(ev)` へ（`vac=` で始まる時だけ。それ以外は今どおり meal-ai）。
- 本人は LINE が付けた `ev.source.userId` だけで決める（webhook は whToken で守られている）。名簿で customer_id を引く。無ければ「確認できませんでした」と返して記録しない。
- `vacancy_optout`（customer_id・opted_out_at・via）に1行。既にあれば足さない。無ければシートを作る（見出しだけ）。返信（reply・無料）：「承知しました。今後、空き枠のお知らせはお送りしません。ご予約・リマインドのご連絡はこれまでどおりお届けします。」
- 書けなかった → 「恐れ入ります、設定を受け付けられませんでした。お手数ですが、このトークでスタッフにお知らせください。」・booking_metrics に `VAC_OPTOUT_FAIL`。
- 受け取るに戻す：オーナーがシートの行を消す（いまは画面なし・§5-19-5）。

### 5-11 記録
**`vacancy_optout`**（GAS のシート・D1 に送らない）：customer_id・opted_out_at（ms）・via。氏名・LINE ID を持たない。行は消さない。
**`vacancy_notice`**（GAS のシート・1キャンセル1行・行の番号は変わらない＝追記と上書きだけ）：
| 列 | 中身 |
|---|---|
| res_id・trainer_id・start_at・deadline_at・cancelled_at | 枠とキャンセル（cancel_notes から写す。氏名なし） |
| first_seen_at・updated_at | 見つけた・最後に見た時刻 |
| state | `wait`／`listed`／`sent`／`no_target`／`too_late`／`filled`／`not_offered`／`unknown`／`not_target`／`skip_trainer` |
| why | wait・終わりの理由（`night`・`nudge_pending`・`slot_not_yet`・`slot_unknown`・`budget`・`actor`・`window`・`margin`・`bad_row`・`dup_res` 等） |
| mode | 判定したときの mode（list／on） |
| attempts | slot_not_yet・slot_unknown の回数（6回で終わり） |
| eligible_n・sent_n・failed_n・unknown_n | 人数だけ |
| would | list のとき送るはずだった相手（顧客IDの下4桁・最大3） |
| skip_json | 外した理由ごとの人数（例 `{"visits":12,"same_day":1,"no_remain":2}`） |
| elapsed_ms・build | かかった時間・版の印 |
- 作業依頼：`remaining {vacancy: 日数}` → 件数・state と理由の内訳・送った/送るはずだった人数（名前なし・顧客は下4桁だけ・`_ejScrub` を通す）。`remaining {vacancyMode:'list'|'off'}` → スイッチを list にする／消す（**on にはできない**）。新しい op は足さない（許可一覧3か所を触らない）。

### 5-12 スイッチと段取り
- `LB_VACANCY_MODE`：厳密に `'list'`／`'on'` だけが効く。未設定・`'ON'`・`'1'`・その他＝何もしない（I-V1）。
- 切り替え：エディタの関数 `lbVacancySetList()`／`lbVacancySetOn()`／`lbVacancySetOff()`（Off は値を消す）。作業依頼は list と off だけ。
- 段取り：①GAS 反映（未設定＝何もしない）→ 作業依頼で版の印を確かめる ②CEO が `vacancyMode:'list'` → 2週 → `remaining {vacancy:14}` で件数・送るはずだった人数・理由を見る ③オーナーの端末に見本を送る `lbVacancySample()`（エディタ・オーナーの LINE にだけ・postback は `vac=test`＝記録しない）で Flex の見え方とボタンを確かめる ④関門③ → オーナー承認 → `lbVacancySetOn()`

### 5-13 止まったら誰が気づくか
- tick は mode が list/on のとき毎回 `LB_VACANCY_LAST`（{at, result}）を書く。切り替えの関数もその時刻を書く（切り替え直後に鳴らさない）。
- 日次点検に `vacancy_stale`（warn・B）：mode が list/on で、最後の記録が **60分より古い／無い**、または最後の結果が `error`。
- warmupCache が止まると、送り直しと一緒に止まる＝`notify_retry_stalled` も鳴る（既存）。
- 送れなかった人数は vacancy_notice の failed_n・unknown_n、作業依頼で見る。

### 5-14 戻し方
- 即時：`lbVacancySetOff()`（または作業依頼 `vacancyMode:'off'`）＝次の tick から何も読まない・送らない。反映は要らない。
- コード：warmupCache の1行と webhook の分岐を戻して GAS 反映（シートは残してよい）。
- nudge_log の `nudge_vacancy` の行は残る（声かけの1日1通の判定に効くのはその日だけ）。

### 5-15 個人情報（どこに出て誰が読めるか）
| 場所 | 中身 | 読める人 |
|---|---|---|
| LINE（会員本人とのトーク） | 日時・トレーナー名・締め切り・LIFF の入口。名前・他の会員・キャンセルした人は入れない | 本人 |
| `nudge_log` | 送信日時・種別・customer_id・鍵（トレーナーID・開始ms）・結果 | スプレッドシートの編集者（今と同じ） |
| `vacancy_notice` | res_id・トレーナーID・時刻・人数・下4桁・理由の人数。氏名・LINE ID なし | 同上 |
| `vacancy_optout` | customer_id・時刻 | 同上 |
| 作業依頼の結果（公開 repo の番号・読み取りの鍵つき） | 件数・理由・下4桁だけ（`_ejScrub`） | 鍵を持つ人 |
| Logger | 件数・理由・下4桁だけ | GAS の編集者 |
| ★既存のシート同士の突き合わせ | vacancy_notice の res_id・時刻 ＋ 予約台帳・cancel_notes → キャンセルした本人が分かる | 今の編集者（権限は広げていない） |
| 予約・残数の判定の中 | 氏名・LINE ID はメモリの中だけ（送り先に使う） | — |

### 5-16 誤って送る経路と塞ぎ方
| 経路 | 塞ぎ方 | 検査 |
|---|---|---|
| 残数の誤判定（残数0の人へ） | 予約画面と同じ `getBookingOptions`。success でない・例外・形が違えば外す | V-8 |
| 契約切れ・未認証 | 名簿の active・verified（Nudge と同じ） | V-5 |
| キャンセルの取り違え（別の枠・別の人を本人として外し損ねる） | res_id が1行だけ・本人は cancel_notes の customer_id・枠は cancel_notes の trainer_id と start_at（台帳を時刻で引き直さない） | V-3 |
| トレーナーの都合の取消を会員都合と取り違える | actor=customer か customer_proxy の明示だけ | V-2 |
| 二重送信（同じ人に同じ枠） | 同時に1本（LEASE）＋ロックの中で nudge_log を読み直してから sending＋failed も数える | V-11・V-12 |
| 1日2通（声かけと） | 声かけの印が出るまで送らない＋今日 nudge_ を受けた人は外す＋声かけ側も nudge_vacancy を数える | V-9・V-10 |
| 時刻の取り違え（UTC/JST・日付セル） | cancel_notes の時刻は ms の数（数でなければ外す）・暦日と曜日は SETTINGS.TIMEZONE（JST）で切る・nudge_log の日付は `_lbParseResvDate` | V-4・V-13 |
| 夜に届く | 9〜20時以外は wait | V-9 |
| 期限の直前に届く | 送る瞬間にも締め切り−2時間を見る | V-4 |
| 埋まった枠を知らせる | 台帳の重なり・会員に見える枠・送る直前に予約確定と同じ部品の4段（B1・トレーナー・1F・連続ルール＝§5-21-2・5-22-1）。残りは送ってから押すまでの間＝予約確定がロックの中で止める | V-6 |
| 担当でないトレーナーの枠（画面から取れない） | 担当＝その枠のトレーナーか担当なし | V-5 |
| 受け取らないを押した人へ | ロックの中で読み直す | V-7 |
| スイッチの読み違い | 'list'/'on' の完全一致だけ | V-1 |

### 5-17 不変条件（MODEL §3 に足す）
I-V1 既定は何もしない（'list'/'on' の完全一致だけ）／I-V2 新しいトリガーを作らない（warmupCache の末尾）／I-V3 枠と予約の可否は入口の関数（getTrainerSlots・getBookingOptions・_lbBookingDeadlineMs・_lbCheckTrainerAvailable）／I-V4 送る権利の正本は nudge_log（ロックの中で読み直してから sending・送っている間はロックを持たない）／I-V5 判定できないものは送らない（state と理由で数える）／I-V6 文面に他の会員の行動・名前を出さない／I-V7 対象は 3日前0時〜前日・締め切り−2時間より前・会員本人の取消／I-V8 1日1通（声かけと合わせて）・週2通・同じ枠1回・1枠3名

### 5-18 検査（worker/test/gas-vacancy.test.js・vm で本物のコードを動かす。シート・カレンダー・LINE・時計・ロックは身代わり）
V-1 mode（未設定・'ON'・'1'・'list'・'on'）／V-2 actor×trainer_reason／V-3 res_id の重複・列の欠け・時刻の不正／V-4 期間の境界（3日前0時の前後・前日23:59・当日0時・締め切り−2時間の前後・送る瞬間の締め切り）／V-5 名簿の条件（未認証・契約切れ・LINE ID なし・担当違い・担当なし）／V-6 枠の段（台帳の重なり・会員の枠に無い→wait→6回で not_offered・カレンダーで埋まり・hidden）／V-7 受け取らない（読み直し）／V-8 残数（getBookingOptions の失敗・選択肢なし・ペアだけ）／V-9 時間帯と声かけの印／V-10 声かけ側が今日のお知らせを数える（入口 lbNudgePlanAll から）／V-11 上限（今日1通・週2通・同じ枠・failed の再送なし・1枠3名・4人目は送らない）／V-12 sending を書いてから送る・書けなければ送らない・例外は sending のまま・結果は鍵で探して書く／V-13 来店の数え方（曜日・前後60分・8週・confirmed だけ）と並び順／V-14 list は1通も送らず nudge_log に書かない／V-15 文面（空きました・キャンセルの字が無い・名前が無い・4言語・Flex の形）／V-16 postback（vac=off で記録・二度目は足さない・会員でない・書けない・meal-ai へ行かない／ほかの postback は meal-ai へ）／V-17 配線（warmupCache を入口から動かして tick に届く・tick の例外が warmupCache を壊さない）／V-18 ログ・作業依頼に氏名・LINE ID・フル ID が無い／V-19 このコードに newTrigger・everyMinutes が無い／V-20 見張り（vacancy_stale）／V-21 作業依頼は on にできない。壊して落ちる：mode の判定・1日1通・担当の条件・sending の順番・list の送信止め・期間の下限。

### 5-19 オーナーに確かめること（決まるまで安全側の既定で出す）
1. 当日（D0 以降）のキャンセルも対象にするか（既定：対象外＝0139 の指定のまま）
2. ★担当がいる会員には、担当の枠だけ知らせる（設計59 で担当以外の枠は画面から取れない）でよいか（既定：担当の枠だけ＋担当なしの会員）
3. 上限：1日1通（声かけと合わせて）・週2通・送る時間 9〜20時・締め切りの2時間前まで（既定）
4. 来店の数え方：直近8週・同じ曜日・前後60分・2回以上・担当を問わない（決定どおり。ただし 3 で担当の枠に絞られる）
5. 受け取らないを押した人を戻す手段（既定：オーナーがシートの行を消す）
6. 文面（§5-9）

### 5-20 未確認（関門③の前に確かめる）
1. この LINE チャネルの webhook が GAS（whToken つき）に向いていて postback が届くか（meal-ai は postback を受けている＝見込みはある）。→ `lbVacancySample()` の vac=test で確かめる
2. Flex の見え方（4言語・ボタンの文字の長さ）→ 同上
3. warmupCache の所要時間に 45秒を足しても6分の制限に余裕があるか（list の段の elapsed_ms と `[warmup]` のログで見る）
4. `getBookingOptions` 1回の時間（list の段の elapsed_ms）


### 5-21 関門① 1周目（Codex・2026-11-26）の反映 ★5-0〜5-20 より優先
高2・中4・低2・重大0。全部反映した（却下なし）。
1. **（高）声かけ側の1日1通**：`_lbNudgeLogReadAll` の `out` の初期化と受け付ける種別を `LB_NUDGE_DAILY_CAP_KINDS`（＝`LB_NUDGE_ORDER`＋`nudge_vacancy`）にする。**優先順位・counts・候補・`_lbNudgeSentForRange`・`_lbNudgeFirstOfMonth` は `LB_NUDGE_ORDER` のまま**。V-10 で「お知らせは `_byDay` に入るが counts・候補・追いかけの判定には入らない」を入口（`lbNudgePlanAll`）から固定する。
2. **（高）送る直前の空き確認**：`_lbCheckTrainerAvailable` はトレーナーのカレンダーだけ（予約確定はさらに B1・1F・連続ルールを見る＝LineBooking.js の B1競合チェック〜連続ルール）。→ 予約確定の入口の中身は変えず、**同じ部品を同じ順で呼ぶ読み取りだけの関数 `_lbVacSlotFreeNow(trainer, start, end)`** を置く：①B1（`[消化]` を除き `_lbEventOverlaps`）②`_lbCheckTrainerAvailable` ③`_lb1FBlockEnabled()` のとき `_lb1FTrainerBusy`＋`_lbOverlapsBusy`（取得失敗は unknown）④連続ルールが on のとき `_lbConsecCheckAt`（unknown は送らない）。返り値 `{ok}`／`{ok:false, reason:'b1'|'trainer'|'f1'|'consec'}`／`{ok:false, unknown:true}`。**人ごとに送る直前（ロックの前）に呼ぶ**。例外は unknown。予約確定と同じ部品を呼んでいることを検査で固定（確定側の4つの呼び出しが今も在ること・こちらの4つの呼び出し）。§5-16・I-V3・V-6 を「予約確定と同じ部品で、ロックの外で確かめる（確定はロックの中で再び確かめる）」に読み替える。残る競合＝確かめてから押すまでの間だけ。
3. **（中）`LB_NUDGE_DAILY_DONE` の成功条件**：lbNudgeDaily のロックの中で `_lbNudgeSend` の戻り値を受け、`plan.code === 'OK'` かつ戻り値の code が無い（LOG_UNWRITABLE・ALREADY_RUNNING・LOCK_UNAVAILABLE でない）ときに今日の日付を書く。LINE の未達（failed）は妨げない（送る処理は最後まで回っている）。声かけが無効（enabled=false）でも書く。書けなければお知らせは送らない側（印が無い＝nudge_pending）。
4. **（中）枠のキャッシュの作り直し**：tick は **この warmupCache の中で枠が作られた（または作りたてで省かれた）とき**だけ枠の段に進む＝`LB_SLOTS_BUILT_AT ≥ _wcStart − 35秒`。そうでなければ枠の段に入らず `slots_not_fresh`（wait・回数に数えない）。これで tick の中の `getTrainerSlots` がキャッシュを作り直すのは、キャッシュの保存に失敗した回と連続ルールの切替直後だけになる。tick の所要時間は vacancy_notice の elapsed_ms と LB_VACANCY_LAST に残す。
5. **（中）個人情報**：§5-15 に追記：氏名・LINE ID は写さないが、**予約台帳・cancel_notes を読める編集者は res_id と時刻からキャンセルした本人を特定できる**（今の権限の範囲）。作業依頼・Logger には res_id・フルの customer_id を出さない（検査 V-18）。
6. **（中）記録が書けないときの観測**：`LB_VACANCY_LAST` に `{at, result, n}`。result は `ok`／`late`／`busy`（LEASE）／`slots_not_fresh`／`read_fail`／`notice_write_fail`／`log_unwritable`／`lock_busy`／`error`。`vacancy_notice` に書けなかった回は result で残す（成功で上書きしない）。日次点検の `vacancy_stale` は「60分より古い・無い・result が read_fail／notice_write_fail／log_unwritable／error」。作業依頼にも出す。
7. **（低）nudge_log の日付**：読み方は `_lbNudgeLogReadAll` と同じ（先頭の `'` を外して `_lbParseResvDate`）。Date 型のセルも扱う検査を V-11 に足す。
8. **（低）postback**：`data === 'vac=off'` と `data === 'vac=test'` の**完全一致だけ**を先に取る。その他は今どおり meal-ai へ。
- lbNudgeDaily がロックを持っている間、お知らせは5秒で諦めて次の tick へ（`lock_busy` として数える）。


### 5-22 関門① 2周目（Codex・2026-11-26）の反映 ★5-21 より優先
1周目の8件のうち6件は塞がった判定。残り2件と新しい3件（高1・中2・低2）を反映した（却下なし）。
1. **（高）連続ルールの条件を予約確定と同じに**：予約確定は `custInfo.consecRule === true` かつ契約の種別に「体験」を含まない、かつ `_lbConsecMode() === 'on'` のときだけ `_lbConsecCheckAt` を呼ぶ（LineBooking.js 予約確定の連続ルールの段）。会員が自分で取る予約は `consecRule: true`（makeReservationLine の custInfo）。→ `_lbVacSlotFreeNow(trainer, start, end, member)` は **member.contractType（名簿の F 列）を受け取り**、`_lbConsecMode()==='on'` かつ `contractType` に「体験」を含まないときだけ `_lbConsecCheckAt` を呼ぶ（お知らせの相手は会員本人が取る予約＝consecRule は常に真）。検査：体験の契約の会員は連続ルールで外さない／on でないときは呼ばない。
2. **（中）枠の鮮度は「この実行で、キャンセルより後に読み始めた枠」で判定**：共有の `LB_SLOTS_BUILT_AT` は使わない。`LB_SLOTS_READ_START_LOCAL`（この実行で buildAvailableSlots がカレンダーを読み始めた時刻・コード.js）を使う。
   - 0（この実行では作っていない＝作りたてで省いた）→ 枠の段に入らない（`slots_not_fresh`・回数に数えない・次の tick へ）
   - キャンセルの cancelled_at ≥ 読み始め → その枠は `wait`（`cache_older`・回数に数えない）
   - cancelled_at < 読み始め のときだけ `getTrainerSlots` の答えを使う。これで「キャンセルを含まない枠」を見て `not_offered` に進むことが無くなる。
3. **（中）残数は送る直前にも確かめ直す**：人ごとに、送る直前（`_lbVacSlotFreeNow` と同じくロックの前）に `getBookingOptions` をもう一度呼び、§5-5-8 の条件を満たさなければ送らない（`no_remain_late` として数える）。1枠あたりの呼び出しは選ぶ段の最大6回＋送る段の最大3回。
4. **（低）§5-16 の「埋まった枠を知らせる」行は §5-21-2 の4段（B1・トレーナー・1F〔blockAll を含む〕・連続ルール）に読み替える**（実装はそちら）。
5. **（低）確かめてから送るまでの競合は残る**：予約確定がロックの中で再び確かめるので取れない予約は作られない。古いお知らせになる可能性だけ（§5-1）。


### 5-23 関門① 3周目（Codex・2026-11-26）の反映 ★5-22 より優先
高2・中3・低2。全部反映した（却下なし）。
1. **（高）契約の種別は予約確定と同じ導き方**：`makeReservationLine` は `_lbContractTypeOf(氏名) || 名簿の F 列`。`_lbVacSlotFreeNow` に渡す contractType はこれと同じ式で作る（氏名はメモリの中だけ）。
2. **（高）予約停止のゲート**：予約確定は最初に `_lbBookingGate(customerId, channel)` を通る（LB_BOOKING_FROZEN・LB_ONBOARDING_MODE）。→ 送る直前に人ごとに `_lbBookingGate(customerId, 'line')` を呼び、ok でなければ送らない（`gate` として数える）。`BOOKING_FROZEN` のときはその tick の残りの枠も送らない（wait・`frozen`）。
3. **（中）枠の鮮度の飢餓**：この実行で枠を作っていない（`LB_SLOTS_READ_START_LOCAL === 0`）のに、安い判定（時間帯・声かけの印・締め切り）を通った枠があり、warmupCache の開始から2分30秒以内なら、**tick が `buildAndCacheSlots()` を1回だけ呼ぶ**（`slots_rebuilt` として数える）。それでも 0 のまま・例外なら `slots_not_fresh`。押し出しと warmupCache の時刻が揃っても毎回止まらない。
4. **（中）送る段の順番を固定**（§5-8 を置き換え）：
   ```
   a. 残り時間（5秒未満なら止める）
   b. 名簿の行を lineUserId で読み直す（getCustomerByLine）：verified・active・customer_id が同じ・担当の条件・LINE ID が同じ
   c. _lbBookingGate(customerId,'line')
   d. getBookingOptions（残数・§5-22-3）
   e. _lbVacSlotFreeNow（B1・トレーナー・1F・連続ルール）
   f. ロック：nudge_log・vacancy_optout を読み直し、今日1通・週2通・同じ枠（failed も）・1枠3名・受け取らない → sending を書く → 放す
   g. 送る（ロックの外）
   h. ロック：鍵で探して sent／failed（見つからない・取れない・例外は sending のまま）
   ```
   a〜e のどれかで外れたら sending を書かない（上限を使わない）。
5. **（中）名簿の状態の変化**：上の b で送る直前に確かめる。
6. **（低）cancelled_at < 読み始め は安全側**（カレンダーの削除の後に時刻を書く）＝そのまま。
7. **（低）§5-15 の表に「予約台帳・cancel_notes を読める編集者は res_id と時刻からキャンセルした本人を特定できる（今の権限の範囲）」の行を足した**。


### 5-24 関門① 4周目（Codex・2026-11-26）の反映 ★5-23 より優先
高2・中2・低2。全部反映した（却下なし）。
1. **（高）送る瞬間の締め切り・時間帯**：§5-23-4 の f（ロックの中・sending を書く直前）で、`いま < _lbBookingDeadlineMs(S) − MARGIN` と「9:00〜20:00」を確かめ直す。外れていれば sending を書かずに枠を too_late／wait にする。
2. **（高・中）tick からは `buildAndCacheSlots()` を呼ばない**（§5-23-3 を取り消す）。全枠の計算・キャッシュ・公開シートの書き直しを tick に持ち込まない。飢餓は次の形で塞ぐ：
   - `buildAndCacheSlots` が今ある `LB_SLOTS_BUILT_AT` の書き込みの隣で、**読み始めた時刻 `LB_SLOTS_READ_START`（ms）も Script Property に残す**（1行・値は数だけ・例外は握る＝今の BUILT_AT と同じ扱い）。
   - tick は「この実行の `LB_SLOTS_READ_START_LOCAL`（0 でなければ）」、0 なら「`LB_SLOTS_READ_START` の値」を枠の読み始めとし、`cancelled_at < 読み始め` の枠だけ枠の段に進む。押し出し（pushToEdgeSlots）が作った枠も使えるので、warmupCache が省いた回でも止まらない。
   - 並行した2回の作り直しで、キャッシュが古い読みのまま・Property が新しい読み、になる組み合わせは残る。そのとき起きるのは「S が無い＝wait→not_offered」（送らない側）だけ。逆の向き（埋まっている枠が空いて見える）は e の生の確認（`_lbVacSlotFreeNow`）と台帳で止める。
   - 読み始めが読めない・数でない → `slots_not_fresh`（送らない・数える）。
3. **（中）予約停止のゲートを sending の直前へ**：順番を a 残り時間 → b 名簿 → d 残数 → e 空き（4段）→ **c ゲート** → f ロック（締め切り・時間帯・上限・受け取らない → sending）→ g 送る → h 書き戻し、にする。
4. **（低）公開シート**：tick は公開シートを書かない（2 で buildAndCacheSlots を呼ばないため）。


### 5-25 関門① 5周目（Codex・2026-11-26）の反映 ★5-24 より優先 ＝ 通過の条件
高2・中1。全部反映した（Codex：「この3点を直せば実装に進んでよい」）。
1. **（高）ゲートはロックの中でも**：f（ロックの中・sending の直前）で締め切り・時間帯と一緒に `_lbBookingGate(customerId,'line')` を確かめ直す。`BOOKING_FROZEN` ならその人だけでなく、その tick の残りの枠も止める（wait・`frozen`）。c（ロックの前）は重い読みを省くための予備。
2. **（高）締め切りは予約入口と同じ設定で**：すべての締め切りの計算を `_lbBookingDeadlineMs(S, _lbBookingCfg(SETTINGS))` にする（予約確定の `_lbBookingOpen(..., _lbBookingCfg(SETTINGS))` と同じ）。
3. **（中）途中で止まったときの state**：その枠で1人でも送っていれば（nudge_log の鍵の sent・sending が1以上）、state は `sent` を下げない。止まった理由（`too_late`・`night`・`frozen`・`budget`・`lock_busy`）は why と skip_json に足す。
   - 3名に届いた → `sent`（終わり）
   - 3名未満で、締め切り−MARGIN まで時間があり、止まった理由が night・frozen・budget・lock_busy・nudge_pending → `sent_partial`（終わっていない＝次の tick で続き。送った人は鍵で飛ばす・1枠3名は nudge_log の数）
   - 3名未満で、候補が尽きた → `sent`（終わり・why=`no_more`）
   - 締め切り−MARGIN を過ぎた → 送っていれば `sent`（why=`too_late`）、送っていなければ `too_late`

---

# 以下は経緯（本文〜改訂4・2026-11-06）。改訂5 が優先する


> ★**優先の順は 改訂4 ＞ 改訂3 ＞ 改訂2 ＞ 改訂1 ＞ 本文。** 食い違う所は新しい改訂に従う。

2026-11-06・CEO 玄。方向はオーナー決定済み（00_board/decisions/0139 機能2）。
オーナーの指摘：トレーナーが一番困るのは**前日・前々日のキャンセル**（他の会員が取りたかった可能性がある）。
前日・前々日は、会員がまだ予約できる時間帯（締め切り＝開始3時間前・午前枠は前日22時）＝お知らせで埋められる。

読んだもの：ops/MODEL.md（§0・§3 I17〜I25・I38・I47・§6・§7・§8・§8-2）、gas/コード.js の `buildAvailableSlots`・`warmupCache`／`_warmupCacheBody`（`CACHE_SECONDS: 660`）・`_lbIsBusyTitle`、gas/BookingRules.js の `_lbBookingDeadlineMs`・`_lbBookingOpen`・`_lbConsecVerdict`、gas/LineBooking.js の `cancelReservationLine`・`_lbConsumeReservationEvents`・`getBookingOptions`・`_lbConsecCheckAt`・`_lbPushOnce`・`_lbNqPolicy`・`estimateLineUsage`・`checkLineQuota`・`_lbGrantTransferCredit`、gas/Nudge.js（設計の柱①〜⑦・`nudge_log`・`_lbNudgeSentOnDay`）、gas/EdgeJob.js の `remaining`、liff/index.html の起動と URL の読み方。設計36（キャンセル理由）を前提にする。

---

## 0. 範囲

| 段 | 出すもの | 会員に届くか |
|---|---|---|
| 0歩目 | 前日・前々日のキャンセルの**実数を数える**（読み取りだけ・作業依頼） | 届かない |
| 1 | 空いた枠を見つけて**一覧に記録するだけ**（送らない・`list`） | 届かない |
| 2 (A) | その枠のトレーナーへ「受付の期限」と「候補の会員（最大3名）」を知らせる | 届かない（トレーナーだけ） |
| 3 (B) | 希望を登録した会員へのお知らせ（オプトイン） | **届く**（オーナー承認が要る＝憲法第3節-3） |
| 3' | 会員が希望の曜日×時間帯を登録する画面 | 画面だけ |

- **対象にするのは「会員が自分でキャンセルした枠」だけ**（設計36 の `cancel_notes.actor = customer`）。トレーナー・オーナーのキャンセルは対象外：トレーナー都合で取り消した枠はトレーナーがその時間に居ない可能性が高く、お知らせすると**取れても実施できない予約**を作る（出勤の予定はカレンダーに残るので、空き枠の計算では空いて見える）。
- **やらない（第2段の候補）**：時間変更（`changeReservationLine`）で空いた旧枠／当日（開始日）のキャンセル／オーナー（hidden）の枠／一斉ではなく1人ずつ順に送る方式／Worker（D1）側での計算。
- 前提：**設計36 が先に出ていること**。キャンセルした時刻は今どこにも記録されていない（§5-1）。設計36 の `cancel_notes.cancelled_at` が唯一の記録になる。

## 1. 倒れる向き

```
送ってよいか判定できない（枠が今も空いているか・その会員が予約できるか・何通目か・送ったかどうか）→ **送らない。**
間違ったお知らせ（取れない枠・予約できない人・2通目）は、届かないより悪い（設計17 と同じ考え）。
届いたか分からないとき（通信の例外）は「送った」として数え、二度と送らない。
```

## 2. 守る不変条件

1. **既定は送らない。** スイッチ `LB_VACANCY_MODE` が厳密に `'on'` のときだけ会員に送る。`'trainer'` はトレーナーだけ・`'list'` は記録だけ・それ以外（未設定・読めない）は何もしない。CEO の判断で `on` にしない（Nudge の柱①と同じ）。
2. **新しいトリガーを作らない。** 10分ごとの `warmupCache` の末尾に相乗りする（トリガーは18本／上限20・設計15。送り直しの `lbNotifyRetryTick` と同じ置き方）。分・時間ごとのトリガーをこの機能のファイルに書かない（検査で固定・Nudge の柱⑤）。
3. **枠の正しさは予約の入口と同じ関数で決める**：
   - 締め切り＝`_lbBookingDeadlineMs`（I21 と同じく別の式を立てない）
   - その会員が予約できるか（残数・契約）＝`getBookingOptions(会員の lineUserId, startISO)`（会員本人が予約を選ぶときと同じ関数）
   - 連続ルール＝`_lbConsecCheckAt`（`_lbConsecVerdict` が正本・I21。スイッチが off なら絞らない＝I22）
   - その枠が今も会員に出ているか＝`buildAvailableSlots` が作った**会員向けの枠**（締め切り・hidden・連続ルールを通った後）に、そのトレーナー・その開始時刻がちょうどあるか
4. **1人1日1通（声かけと合わせて）・お知らせは1人週2通・同じ枠を同じ人に二度送らない。** 正本は `nudge_log`（種別 `nudge_vacancy`）。Nudge の「その暦日にもう1通送っている」（`_lbNudgeSentOnDay`）が種別をまたいで見る＝**声かけ側の判定はそのまま効く**。
5. **送る前に記録する**（`sending` を先に書いてから送る＝Nudge と同じ）。書けなければ送らない。
6. **LINE を送っているあいだ ScriptLock を持たない**（I19）。`nudge_log` に書く・結果を書き戻すときだけロックを取る。
7. **トレーナーに見せる候補は、そのトレーナーが見てよい会員だけ**（I47 の担当の範囲：担当＝そのトレーナー、担当なし、オーナーは全員）。
8. **会員へのお知らせに他の会員の行動を透かさない**：「キャンセル」「空きが出ました」と書かない。キャンセルした人を推測できる情報（人数・名前・理由）を載せない。
9. 作業依頼の結果・ログに氏名・LINE ID・フル ID を出さない（顧客IDの下4桁・I28・I38）。

## 3. 作るもの

### 3-0 0歩目：前日・前々日のキャンセルの実数を数える（読み取りだけ）

**新しい op を足さない**（足すと許可一覧3か所＝`.github/workflows/edge-job.yml` の case 行の更新がオーナー作業になる・私は workflow を push できない）。既存の `remaining` の args に `vacancyStats`（日数）を足す。gas/EdgeJob.js の `case 'remaining':` の他の args と同じ並びに1行。結果は `_ejScrub` を通す。

数え方（2026-09〜。記録は約2か月）：
| 種類 | キャンセルした時刻の出どころ | 精度 |
|---|---|---|
| 当日消化（`consumed`・振替でない） | `transfer_credits` の2列目（振替権を付けた時刻）＝5列目の予約IDで突き合わせる | 分単位で正確 |
| オーナーの無料取消 | 備考の `無料取消（オーナー権限 yyyy/MM/dd HH:mm）` | 分単位（ただしオーナーの操作＝対象外） |
| 無料の取消（`cancelled`） | **どこにも無い**。分かるのは「前日17時より前」だけ | 前々日か1週間前か区別できない |
| 設計36 の反映後 | `cancel_notes.cancelled_at` | 正確 |

出すもの（件数・時間帯・後で埋まったかだけ。名前は出さない）：
```
期間・件数（状態ごと）
当日消化：開始まで何時間前にキャンセルしたかの分布（0-3h／3-6h／6-12h／12-24h／前日17時〜）・曜日×時間帯（朝7-10／昼10-14／午後14-18／夜18-24）
無料の取消：開始日の曜日×時間帯の件数（キャンセルの時刻は不明と明記）
後で埋まったか：同じトレーナー・枠の時間が重なる予約で、記録日時（K列）がキャンセル時刻（不明なら元の予約の記録日時）より後のもの。
                その人がキャンセルした本人か別の人か（本人の取り直しは別に数える）
cancel_notes がある期間：actor=customer で、開始日の前々日0時〜締め切りの間にキャンセルした件数・そのうち後で埋まった件数
```
★**過去のデータだけでは「前々日〜前日17時の無料の取消」の実数は出せない**（時刻が無い）。だから、設計36 の反映から2〜4週間 cancel_notes を貯め、`list`（段1）の記録と合わせて (B) を出すかを決める。

### 3-1 対象の定義

```
S        = 予約の開始（JST）。D = S の日付
t_c      = キャンセルした時刻（cancel_notes.cancelled_at）
deadline = _lbBookingDeadlineMs(S)          ← 午前枠（12時前）は前日22時と3時間前の早いほう／他は3時間前
対象     : actor = customer
           かつ  D−2 日 00:00 ≦ t_c       （前々日・前日。当日は対象外＝オーナーの指定）
           かつ  t_c < deadline − MARGIN    （会員が予約できる時間が十分残っている）
           かつ  outcome が free か consumed（どちらも枠は空く：無料は予定を消し、当日消化は B1 を [消化] にしてトレーナーの予定を消す＝_lbIsBusyTitle が埋まりと見ない）
MARGIN   = 2時間（推奨・オーナーが決める §4-2）
```
- お知らせを送る時点 t_s でも `t_s < deadline − MARGIN` を確かめ直す（夜の保留から明けたときに期限が近ければ送らない）。
- 午前枠の例：明日10時の枠を今日20時にキャンセル → 締め切り＝今日22時 → MARGIN 2時間なら対象外（20時＝22時−2時間ちょうど）。午前枠は前日の夜には埋められない構造。

### 3-2 流れ（warmupCache に相乗り）

```
warmupCache
  ├ _warmupCacheBody（枠の作り直し・今のまま）
  ├ lbNotifyRetryTick（送り直し・今のまま。開始3分超なら見送り・90秒まで）
  └ lbVacancyTick(_wcStart) ← 新しく足す（例外を外に出さない）
       ・warmupCache の開始から 3分30秒 を過ぎていたら何もしない（6分の制限）
       ・使ってよい時間 45秒。1回で処理する枠は最大3つ・会員へ送るのは最大10通
       ・mode を読む（off なら即終わり）
       1. cancel_notes の直近48時間の行から §3-1 の対象を拾う（vacancy_notice に resId がある行は飛ばす）
       2. その枠が今も会員向けの枠にあるか（キャッシュの枠を読む。作りたてでなければ作り直さず「次の10分に回す」）
       3. (A) トレーナーへの知らせ（mode が trainer か on）
       4. (B) 会員への知らせ（mode が on・送る時間帯の中）
       5. vacancy_notice に結果を書く
```
- **キャンセルの瞬間ではなく10分以内に送る理由**：①キャンセルのロックの中に重い処理（候補の計算・残数の計算）を足さない（キャンセルが遅くなる）②キャンセルした直後は枠のキャッシュがまだ古い（最大660秒）＝空いたことが会員向けの枠に出てから知らせる③夜の保留・二重送信の防止を1か所で扱える。
- **キャンセル時のトレーナー宛の通知には「受付の期限」だけ足す**（軽い計算・`_lbBookingDeadlineMs` だけ）。対象の枠のときに1行：`この枠は {締め切り} までお客様の予約を受け付けています。` 候補の名前は (A) で10分以内に別に届く。

### 3-3 (A) トレーナーへの候補の知らせ

- 宛先：その枠のトレーナー（`getTrainerLineId(r[4])`）。届かなかったら送り直さない（用途 `vacancy_trainer`・`_lbNqPolicy` で `alert` になる＝オーナーへのメール。時間が大事な知らせなので送り直しても意味が薄い）。※ `nudge_` で始めない（声かけの1日1通に数えない・トレーナー宛なので）。
- 文（日本語固定）：
  ```
  【空き枠の候補】{日時}（{締め切り}まで受付）
  この曜日・時間帯によくお越しの方：
  ・A様（直近8週で3回）
  ・B様（直近8週で2回）
  ご連絡される場合のご参考にどうぞ。
  ```
  (B) が on のときは末尾に「お知らせを{n}名にお送りしました」（n だけ。名前は書かない）。
- 候補の選び方（全部を満たす人を、回数の多い順・同じなら最近来た順に最大3名）：
  1. そのトレーナーが見てよい会員（I47 の担当の範囲＝`_lbTrainerMaySeeCustomer(tr, _lbCustOwnerOf(cid))`。読めなければ外す）
  2. verified・契約が有効・キャンセルした本人でない
  3. 直近8週の予約（状態 `confirmed` で開始が過去のもの＝来店。当日消化の取消は除く）で、S と同じ曜日・S の前後1時間に始まった回が **2回以上**（担当トレーナーは問わない）
  4. その日（D）に予約が無い
  5. その枠を予約できる：`getBookingOptions(その会員, S)` が予約できる選択肢を1つ以上返す（残数がある）
  6. 連続ルールに当たらない（`_lbConsecCheckAt`・スイッチが on のとき）
- ★記録は 2026-09 からの約2か月＝「直近8週」はほぼ全期間。候補が0名の回が多い見込み。**0名なら送らない**（「候補はいません」を送らない）。
- 計算の重さ：5 の `getBookingOptions` は契約の行を読む（重い）。1〜4 で絞った後の人にだけ呼ぶ（1枠あたり最大6名まで試す）。かかった時間を vacancy_notice に残す（§2-9・feedback「所要時間を最初から記録する」）。

### 3-4 (B) 会員へのお知らせ（オプトイン）

#### 送る相手（全部を満たす人）
1. お知らせを**自分で登録した**（vacancy_prefs の `on = true`）
2. verified・契約が有効・LINE の ID がある（Nudge の `_lbNudgeEligible` と同じ条件）
3. S の曜日×時間帯が、本人が登録した希望に入っている
4. そのトレーナーが本人の「お知らせを受けるトレーナー」に入っている（既定：直近8週に予約したトレーナー。§4-4）
5. hidden のトレーナー（オーナー）の枠ではない（第1段）
6. その枠を予約できる：締め切り−MARGIN より前・`getBookingOptions` が予約できる選択肢を返す・連続ルールに当たらない
7. その日（D）に予約が無い・キャンセルした本人でない
8. 今日まだ `nudge_` の何も受け取っていない（`_lbNudgeSentOnDay`）・お知らせ（`nudge_vacancy`）を直近7日で2通未満・この枠（キー `vac|{trainerId}|{S}`）をまだ受け取っていない
#### 人数と順番
- 1つの枠につき**一斉に最大5名**（設定 `LB_VACANCY_MAX_PER_SLOT`・既定5。オーナーに確認 §4-3）。先着順（最初に予約した人が取る）。
- 5名を超えるときの優先順位：①直近7日でお知らせを受け取っていない人 ②その曜日×時間帯の来店回数が多い人 ③今月の残数の消化が遅れている人（残数÷月の残り日数が大きい）④顧客IDの順（決まった並びにする＝検査できる）
- (A) の候補と (B) の相手が重なってもよい（トレーナーは連絡を控えられるよう「お知らせを送った人数」が見える）。
#### 送る時間帯（夜の保留）
- 会員に送るのは **9:00〜20:00**（推奨・§4-5）。外れていたら保留し、次に時間帯に入った最初の回で、§3-1 と相手の条件を**最初から確かめ直して**送る（期限が近ければ送らない）。
- その日の声かけ（`lbNudgeDaily`・10時）が `LB_REMIND_ON=1` で有効なときは、**その日の声かけが終わるまで会員に送らない**（先にお知らせを送ると、声かけの「1人1日1通」でその日の振替の案内が押し出され、翌日には対象から外れて永久に届かない）。声かけが終わったかは `nudge_log` か声かけの完了の印で見る（§5-4）。声かけが無効なら気にしない。
#### 送り方
```
ロックを取る（tryLock 10秒。取れなければ今回は送らない＝次の10分）
  相手ごとに nudge_log に 'sending' を1行（種別 nudge_vacancy・キー vac|trainer|S）→ flush
ロックを放す
相手ごとに _lbPushOnce（260ms の間隔・429 の短い粘りあり）
ロックを取る
  結果を書き戻す：行の番号ではなく「種別・顧客ID・キー」で行を探す（先頭から最大50行）。
  見つからなければ書かない（sending のまま＝送った扱い＝再送しない）
ロックを放す
```
- `_lbPush` ではなく `_lbPushOnce` を使う＝送り直しの列に積まない（`nudge_` は `_lbNqPolicy` でも `none`。二重に送る害が大きい）。
- 届いたか分からない（通信の例外・応答が読めない）→ `sending` のまま＝送った扱い。週2通・1日1通に数える。
- 429 で届かなかった → `failed`。この枠では送り直さない（時間が経つと意味が薄い）。1日1通には数えない（届いていないので）。
- 二重送信の防止：①枠ごとに vacancy_notice の行（resId）で1回しか処理しない ②人×枠のキー ③ロックの中で sending を先に書く。同じ枠がもう一度キャンセルされた（取り直し→再キャンセル）ときは新しい resId だが、②で同じ人には届かない。
#### 文面（下書き・4言語。敬体・マイナスの言い方をしない・「下記よりお待ちしております」）
```
{名}様

{M月D日（曜）} {H:MM}〜、{トレーナー名}のお時間にご予約いただけます。
ご都合が合いましたら、下記よりお待ちしております。

▼ ご予約
{URL}

ご予約の状況により、お取りいただけない場合がございます。
（受付は {締め切り} までです）
お知らせの設定は、予約画面の「お知らせ設定」から変更いただけます。
```
- 「キャンセル」「空きが出ました」「先着」と書かない（§2-8）。
- **機械性が透けないこと**（feedback）：名前で呼ぶ・送る時刻は10分ごとの起動に依存してばらつく（毎日同じ時刻に揃わない）・同じ文が全員に同時に届くが、受け取る人どうしは互いを見ない。文の長さで切り詰めない。
- 文面の数字（日時・締め切り）は送る瞬間に計算する（キャッシュの値を使わない）。

### 3-5 希望の登録の画面（会員・liff/index.html）と保存先

- ホームに「お知らせ設定」（44px・4言語）。開くと：
  1. 説明：「ご希望の曜日・時間帯にご予約いただけるお時間があるとき、LINE でお知らせします（週2回まで・1日1回まで）。」
  2. スイッチ「お知らせを受け取る」（**既定は切**）
  3. 曜日（月〜日）×時間帯（朝7-10／昼10-14／午後14-18／夜18-24）の表。タップで選ぶ／外す（44px）
  4. **初期値の提案**：過去の予約（直近8週・2回以上の曜日×時間帯）と固定枠（recurring_patterns＝本人の希望）から、最初に開いたときだけ選んだ状態で出す。「あなたのよくご予約の時間を選んでいます」と書く。スイッチは切のまま（**提案は登録ではない**）
  5. トレーナー：「いつものトレーナー（直近8週）」／「どのトレーナーでも」（§4-4）
  6. 「保存する」。保存したら「保存しました」。戻るの決まりは `data-back`（入力があれば `_formTouched` の確認）。言語切替で選んだ内容が消えない（`state` に持つ）
- 窓口（GAS・JSONP）：`line_getVacancyPrefs`（本人の設定と提案）・`line_setVacancyPrefs`（本人の設定を上書き）。**本人は lineUserId だけで決める**（customerId を受け取らない）。verified でなければ断る。入力は曜日0-6×時間帯の鍵の配列だけ（それ以外は400）・トレーナーの選び方は2値。自由文は無い。
  - `gas-entry-guard` の入口の一覧に足し、customerId を受け取らないことを検査で固定する
  - 読み取り（get）は `BATCH_READ_ONLY` 等の画面の決まりに沿わせる（書き込み後の古い答えを出さない）
- 保存先：GAS のシート `vacancy_prefs`（customer_id・on・prefs_json・trainer_scope・updated_at・opted_in_at・opted_out_at）。氏名は持たない。
- **オプトアウト**：①設定の画面でスイッチを切る ②お知らせの文に設定の場所を書く ③契約が有効でなくなったら送らない（行はそのまま）④LINE をブロックした人は 403 で届かない（送り直さない）。

### 3-6 通知から予約までの導線（今の LIFF に日時を指定して開く仕組みは**無い**）

- 今の index.html が URL から読むのは `edge`・`cal`・`perf`・`whoami` の印だけ。トレーナーと日時を指定して週の画面を開く仕組みは無い。
- **最小の足し方**：お知らせの URL を `https://liff.line.me/{LIFF の ID}?vac={trainerId}.{yyyyMMddHHmm}` にする。
  - 起動（`line_boot`）が済んで会員と分かったら、`vac` を読んで**厳しく検査**（形が `^[A-Za-z0-9_-]{1,20}\.\d{12}$`・トレーナーが一覧にいる・日時が未来で予約できる範囲）→ そのトレーナーの週の画面（`loadSlots`）をその週で開き、その枠を目立たせる。
  - その枠がもう無い（埋まった・締め切り）→ 週の画面のまま上に「このお時間はご予約が埋まりました。ほかのお時間もご覧いただけます。」（4言語）。
  - 形が違う・トレーナーでない人・未登録の人 → 何もせず今の起動のまま（**読めない印は無視する**）。
  - 一度使ったら `history.replaceState` で URL から外す（戻る・再読み込みで何度も開かない）。
  - URL に顧客を指す値を入れない（トレーナーID と日時だけ）。
- ★`liff.line.me/{ID}?…` のクエリが `liff.init` の後の `location` に残るか（`liff.state` の扱い）は**未確認**（§5-5）。`whoami` は `location.href` で読めている実績があるので見込みはある。

### 3-7 記録 `vacancy_notice`（GAS のシート）と作業依頼での出し方

| 列 | 中身 |
|---|---|
| res_id | キャンセルの予約ID（1枠1行） |
| trainer_id・start_at・deadline_at | 枠 |
| found_at | tick が見つけた時刻 |
| state | `listed`／`held_night`／`held_nudge`／`sent`／`no_target`／`not_offered`（会員向けの枠に無い）／`too_late`／`filled`（送る前に埋まった）／`error` |
| trainer_msg | `sent`／`failed`／`no_candidate`／`skipped` |
| candidates_n・eligible_n・sent_n・failed_n・unknown_n | 人数だけ |
| skip_counts_json | 外した理由ごとの人数（例：`{"no_remain":3,"same_day":1,"weekly_cap":2}`） |
| filled_at・filled_by_notice | 後で埋まったか（次の tick で、同じ枠に予約が入ったかを台帳で見る）／お知らせを受けた人が取ったか |
| elapsed_ms | かかった時間 |
| build | 版の印 |

- 作業依頼：`remaining` の args に `vacancy`（日数）を足し、vacancy_notice の集計を出す（件数・理由の内訳・埋まった率・送った通数。名前は出さない・顧客は出さない）。`list` 段の確認はこれで行う。
- 見張り：tick の最後に走った時刻を Script Properties に残す（feedback「見張りは走った記録で」）。mode が off 以外なのに1時間以上走っていなければ日次点検が出す。

### 3-8 LINE の通数の見積もり

- 今：ライトプラン月5,000通・実績は月200通台（checkLineQuota・estimateLineUsage）。
- 上限（悪い側）：(B) は1人週2通まで＝1人月約9通。登録者20名なら月180通が天井。1枠5名まで。(A) は対象の枠1つに1通。対象の枠が月10件なら (A) 10通＋(B) 最大50通。
- 実数は0歩目と `list` 段で数える。`estimateLineUsage` に用途 `vacancy_trainer`・`nudge_vacancy` を足し（vacancy_notice・nudge_log から数える）、checkLineQuota の内訳に出す。

## 4. オーナーに決めてもらうこと

1. **(B) を出すかどうかは、0歩目と `list` 段の数字を見てから決める**（推奨：設計36 の反映から2〜4週の記録で「前日・前々日に会員がキャンセルした枠が月に何件・そのうち埋まらなかったのが何件」を出し、月に数件以上あれば (B) へ進む）。(A) は数字を待たずに出してよいか。
2. **MARGIN（締め切りの何時間前までに送れれば送るか）**：推奨2時間。
3. **一斉に送る人数**：推奨5名（ご指示どおり）。取れなかった人が「埋まりました」を見る回が増えるのが気になるなら3名。
4. **お知らせを受けるトレーナーの既定**：推奨「いつものトレーナー（直近8週に予約したトレーナー）」。会員が「どのトレーナーでも」に変えられる。
5. **送る時間帯**：推奨 会員 9:00〜20:00／トレーナーへの候補 7:00〜22:00。
6. 文面（下書き）でよいか。特に「ご予約の状況により、お取りいただけない場合がございます」を入れるか。
7. 候補の条件「同じ曜日・前後1時間に直近8週で2回以上」でよいか（記録が2か月しか無いので、当面は候補0名の回が多い見込み）。
8. **（改訂1で追加）オーナーの代理キャンセルを対象にするか**：推奨＝トレーナーと同じく `customer_proxy` を明示したときだけ対象（改訂1-5）。一律に外す案もある。

## 5. 未確認（関門①の前に確かめる）

1. **キャンセルした時刻**：台帳に列が無い（設計36 §5-2）。無料の取消は時刻が分からない。→ 0歩目の結果は「当日消化は正確・無料の取消は開始日だけ」と明記して出す。
2. **トリガーの本数**：18本／上限20（設計15）。`remaining` の `triggers` で数え直す（相乗りなので増やさないが、warmupCache が止まると送り直しとお知らせが一緒に止まる＝見張り §3-7）。
3. **warmupCache の所要時間**：枠の作り直し＋送り直し（最大90秒）に、この tick（最大45秒）が加わる。今の warmupCache の実測の時間（ログの `[warmup]`）を数日分取り、6分の制限に対する余裕を確かめる。`getBookingOptions` 1回の時間も測る。
4. **声かけ（lbNudgeDaily）が「今日終わった」ことを示す印**があるか（nudge_log の行か、Script Properties か）。無ければ足す（Nudge.js の版の印を上げる）。声かけは今 `LB_REMIND_ON` の値しだい。
5. `liff.line.me/{ID}?vac=…` のクエリが `liff.init` の後に `location` に残るか（`liff.state`）。staging で確かめる。
6. 締め切りの後の吸着方式：空いた60分の前後に別の予約があると、会員向けの枠の開始時刻が S からずれることがある（空きブロックの端から刻む）。その場合 S ちょうどは出ず `not_offered` になる。件数を `list` 段で数え、多ければ「S を含む空きブロックに出ている最初の開始時刻」に広げるか決める。
7. キャッシュの枠に「会員向け（連続ルール・hidden を通した後）」と「トレーナー向け（全部）」のどちらが入っているか（I23・`_lbTrainerSlotsAll`）。会員向けで判定する。
8. 会員の `getBookingOptions` を lineUserId で呼ぶとき、名簿の行が読めない・契約の行が壊れている会員は `success:false` を返す＝送らない側に倒れるか。

## 6. 検査

### 6-1 GAS（worker/test/gas-vacancy.test.js・vm で動かす・シートとカレンダーは身代わり）
1. 対象の定義：前々日0時ちょうど／前々日0時の1分前（対象外）／締め切り−MARGIN の前後1分／午前枠（前日22時）／当日（対象外）／actor=trainer・owner（対象外）
2. mode：未設定・`'ON'`・`'1'`・読めない → 何もしない／`list` → 記録だけで1通も送らない（push の身代わりが0回）／`trainer` → トレーナーだけ／`on` → 両方
3. 会員の条件の1つずつ：登録していない・切っている・希望の外・トレーナーの外・hidden・残数なし（`getBookingOptions` の身代わりが選択肢0）・連続ルール・同じ日に予約あり・キャンセルした本人・今日すでに声かけを受けた・週2通目まで・同じ枠を受けた → 送らない、理由が skip_counts に数えられる
4. 6名が条件を満たす → 5名だけ・優先順位どおり（決まった並び）
5. 送る前に sending を書く／書けなければ1通も送らない
6. 通信の例外 → sending のまま・次の枠で同じ人を「今日1通」と数える
7. 429 → failed・その枠で送り直さない・1日1通に数えない
8. 結果の書き戻しは種別・顧客ID・キーで探す（間に他の行が入っても別人の行を書き換えない）
9. 夜：20時以降は held_night・翌朝9時の回で条件を確かめ直す・期限が近ければ too_late
10. 声かけが有効で今日まだ終わっていない → held_nudge
11. 会員向けの枠に S が無い → not_offered（送らない）
12. 開始3分30秒を過ぎた warmupCache → 何もしない／45秒を使い切ったら途中でやめ、残りは次の回（同じ枠を二度処理しない）
13. (A)：候補はそのトレーナーの担当の範囲だけ（別のトレーナーの担当の会員が入らない）・0名なら送らない・最大3名
14. 文面：「キャンセル」「空き」「先着」の字が4言語のどれにも無い／名前・日時・締め切り・URL が入る
15. ログ（Logger の身代わり）・作業依頼の結果に氏名・LINE ID・フル ID が無い（下4桁だけ）
16. このファイルに `newTrigger`・`everyMinutes`・`everyHours` が無い（文字列の検査＋warmupCache から呼ばれていることを配線の検査で）
17. **配線**：warmupCache を入口から動かして lbVacancyTick まで届く（部品を直接呼ぶだけにしない）。lbVacancyTick の例外が warmupCache の結果を変えない
18. **壊して落ちる**：①mode の判定を `!= 'off'` にする ②1日1通の判定を外す ③担当の範囲の判定を外す ④sending を送った後に書く — それぞれで上の検査が落ちることを確かめる

### 6-2 画面（worker/test/liff-vacancy.test.js・本番の index.html を取り出して jsdom）
1. 入口から：ホーム→「お知らせ設定」→ 選ぶ → 保存。送る引数が `line_setVacancyPrefs` と曜日×時間帯の鍵とトレーナーの選び方だけ（customerId を送らない）
2. 初期の提案は選んだ状態で出るが、スイッチは切のまま（保存しても on にならない）
3. 4言語の鍵・言語切替で選んだ内容が消えない・戻るの決まり
4. `?vac=` の形が正しい → そのトレーナーの週の画面・その枠が目立つ／枠が無い → 「埋まりました」／形が違う・未登録・トレーナー → 今の起動のまま／使った後に URL から外れる

### 6-3 作業依頼
- `remaining` の `vacancyStats`・`vacancy` が氏名を出さない（`_ejScrub` の検査）・新しい op を足していない（`job-ops-drift` の検査がそのまま通る）

## 7. 関門と出し方

- 関門①：この設計（MODEL.md・設計36 と一緒に渡す。見てほしい所＝送ってよいかの判定を予約の入口と同じ関数で行っているか・1日1通と声かけの順番・二重送信・ロックの持ち方・候補の閲覧の範囲・他の会員の行動が透けないか・個人情報がどこに出て誰が読めるか）
- 関門②：差分
- 関門③：会員に送る前（何が起きたら会員に害が出るか：取れない枠を知らせる・予約できない人に送る・1日に2通・同じ枠を2回・夜に届く・声かけを押し出す・取りに行ったら埋まっている）
- 出し方：
  1. 設計36 が出ていること（cancel_notes が貯まり始めている）
  2. 0歩目：作業依頼 `remaining {vacancyStats: 60}` → 数字をオーナーへ
  3. GAS をまとめて1回反映（mode は未設定＝何もしない）→ 版の印を確かめる
  4. `LB_VACANCY_MODE=list` を2週（CEO が設定してよい：会員にもトレーナーにも何も届かない）→ `remaining {vacancy: 14}` で「対象の枠の数・not_offered の数・送っていたら何名に届いたか・後で埋まったか」を見る
  5. `trainer`（トレーナーに届く。オーナーの了承を取ってから）
  6. 画面（お知らせ設定）を出す。登録した人がいても mode が on でなければ届かない
  7. 関門③ → オーナー承認 → `on`
- MODEL.md へ足すもの（実装と同じコミット）：§2 に `vacancy_prefs`・`vacancy_notice`、§3 に不変条件 I-V1〜I-V6（既定は送らない／トリガーを作らない／枠と予約の可否は入口と同じ関数／1日1通・週2通・同じ枠1回の正本は nudge_log／送る前に記録・送信中にロックを持たない／候補は担当の範囲だけ）と守る検査、§6 に `lbVacancyTick`（10分ごと・warmupCache の末尾）、§7 の warmupCache の行に「送り直し＋お知らせ」を足す

---

## 改訂1（Codex 関門① 1周目の反映・2026-11-06）★本文より優先

確かめた該当行：gas/Nudge.js `_lbNudgeLogReadAll`（`out` を `LB_NUDGE_ORDER` の種別だけで作り、`if (!out[kind]) continue;` で**知らない種別の行を `_byDay` に入れる前に読み飛ばす**）／gas/コード.js `buildAvailableSlots` の連続ルールの段（`_lbApplyConsecToSlots` は `consecOk` を付けるだけで**枠を消さない**）とトレーナー別キャッシュ（全枠を入れる）／gas/LineBooking.js `getTrainerSlots`（モードが on で会員のときだけ、印が無ければ作り直し、作り直しても無ければ `SLOTS_UNAVAILABLE`、最後に `consecOk === true` だけ残す）／`getBookingOptions(lineUserId, startISO, customerId)`（トレーナーを取らない＝残数・契約だけ）／`_lbCheckTrainerAvailable(trainer, start, end, excludeStart)`（予約確定の入口の空き判定）／`_lbPushOnce` の `noInlineRetry`。

### 1-1 対象の期間に上限を付ける（重大1）
```
対象：D−2日 00:00 ≦ t_c < D日 00:00（JST）かつ t_c < deadline − MARGIN
```
- 当日（D日 00:00 以降）のキャンセルは対象外。
- 検査：D日 00:00 の1分前（対象）／ちょうど（対象外）／D−2日 00:00 の1分前（対象外）／ちょうど（対象）。

### 1-2 送る権利は1つのロックの中で決める（重大2）
送るまでの流れを差し替える（本文 §3-4「送り方」）：
```
[判定（ロックの外）] 候補を絞る（重い読み取り：枠・getBookingOptions・連続ルール）
[ロック tryLock 10秒・取れなければ今回は送らない]
   vacancy_notice のその resId の行を読み直し、lease を自分が持っているか（§1-11）
   nudge_log の先頭（LB_NUDGE_LOG_SCAN 行）を読み直す
   vacancy_prefs をその人の分だけ読み直す（オプトアウトの最新）
   人ごとに再判定：今日すでに1通（全種別・§1-3）／直近7日で nudge_vacancy 2通／人×枠のキー済み／on のまま
   通った人だけ nudge_log に 'sending' を書き、vacancy_notice を B_CLAIMED にする → flush
[ロックを放す]
[送る（ロックの外）] 送る直前の再検査（§1-7）→ _lbPushOnce
[ロック] 結果を種別・顧客ID・キーで探して書き戻す → vacancy_notice を更新
```
- 検査：warmupCache を同時に2つ（身代わりのロックを順に渡す）→ 同じ人に1通だけ・同じ resId を二重に処理しない／ロックを取った後にオプトアウトした人には送らない。

### 1-3 1日1通の数え方と声かけの優先順位を分ける（重大3）
- `LB_NUDGE_ORDER`（声かけの優先順位）には**足さない**（足すと声かけの計画に nudge_vacancy が種別として現れる）。
- Nudge.js に別の定義 `LB_NUDGE_DAILY_CAP_KINDS = LB_NUDGE_ORDER ＋ ['nudge_vacancy']` を置き、`_lbNudgeLogReadAll` の `out` をこの定義で作る＝`_byDay`（1日1通）に nudge_vacancy が入る。声かけの種別ごとの判定（`out[kind]`）は今どおり。Nudge.js の版の印を上げる。
- お知らせ側も同じ `_lbNudgeLogReadAll` を使う（別の読み方を作らない）。
- **配線の検査**：nudge_log に今日の nudge_vacancy（sent と sending）がある会員を、`lbNudgePlanAll` が「今日はもう1通」として外す（入口から計画を作って確かめる）／逆に今日の声かけを受けた人にお知らせが行かない／`LB_NUDGE_ORDER` に nudge_vacancy が無い。壊して落ちる：`out` を LB_NUDGE_ORDER で作り直すと落ちる。

### 1-4 会員向けの枠は getTrainerSlots と同じ関数で作る（高4）
- 本文 §5-7 の答え：**キャッシュは会員向けではない**（全枠＋consecOk の印）。
- `getTrainerSlots` の会員向けの絞り込み（モード判定・印が無ければ作り直す・作り直しても無ければ判定不能・`consecOk === true` だけ）を共有の関数 `_lbCustomerSlotsFor(trainerId)` に切り出し、`getTrainerSlots`（会員のとき）とお知らせの両方がこれを通る。
- 判定不能（`SLOTS_UNAVAILABLE`）→ その枠は送らない（`not_offered` ではなく `slots_unknown` として数える）。
- 検査：consecOk の無い古いキャッシュ・連続ルールの読み取り失敗・mode off（全枠）・dry（絞らない）・on（true だけ）／getTrainerSlots の答えが切り出しの前後で同じ（配線）。

### 1-5 対象の actor を絞る（高5）
- 対象は **`actor = customer`**、または **`actor = trainer` かつ `trainer_reason = customer_proxy`**（設計36 改訂1-11 の鍵）だけ。
- 次は送らない：`trainer_convenience`・`trainer_reason` が空・知らない値・第2段の前の行（列が空）・列が読めない・組み合わせが不正（customer なのに trainer_reason がある等）。
- **actor = owner**：推奨＝**トレーナーと同じ扱い**（`customer_proxy` を明示したときだけ対象）。理由：オーナーが会員の電話を受けて代理で取り消すことは実際にあり得る。ただし第2段（理由の欄）が出るまでは owner の行は常に空＝対象外。→ §4 に「8. オーナーの代理キャンセルを対象にするか」を足す（推奨：customer_proxy の明示だけ許す）。
- 検査：actor×trainer_reason の全組み合わせ。

### 1-6 「予約できる」の役割を分ける（高6）
| 確かめること | 正本 | 読めないとき |
|---|---|---|
| 枠が会員に出ているか | `_lbCustomerSlotsFor`（§1-4） | 送らない |
| 締め切り | `_lbBookingDeadlineMs`・`_lbBookingOpen` | 送らない |
| 残数・契約 | `getBookingOptions(会員の lineUserId, S)`（予約できる選択肢が1つ以上） | 送らない |
| 連続ルール | `_lbConsecCheckAt`（`unknown` は送らない） | 送らない |
| その日の予約 | 台帳（line_reservations の confirmed） | 送らない |
| hidden | トレーナーの設定（`CALENDAR_IDS.TRAINERS` の hidden） | 送らない |
- `getBookingOptions` はトレーナーを取らないので「その枠を予約できる」の全体は保証しない。上の表の全部が通って初めて送る。
- 検査：表の行ごとに「読めない」を作り、その人に送らない・理由が数えられる。

### 1-7 送る直前に台帳とカレンダーで確かめ直す（高7）
- 送る直前（人ごと・ロックの外）に `_lbCheckTrainerAvailable(trainer, S, S+60分)`（予約確定の入口と同じ判定）を呼ぶ。空いていなければ、その枠の残りの人には送らず `filled` で止める。同じ枠の2人目以降も毎回呼ぶ（1回の呼び出しの時間を測って vacancy_notice に残す）。
- 検査：枠の確認の後・送信の前に別の予約で埋まる → 送らない。

### 1-8 吸着で開始時刻がずれるとき（中8）
- 第1段は **S ちょうどが会員向けの枠にあるときだけ**。
- 将来広げるなら、`S_offer`（空きブロックに出た開始時刻）を最初に1つ固定し、締め切り・連続ルール・残数・空き判定・文面・`?vac=` のすべてを S_offer 基準にする（S と S_offer を混ぜない）。

### 1-9 時間の予算（中9）
- tick では `_lbPushOnce(..., { noInlineRetry: true })`（429 の1.2・3・6秒の粘りをしない）。429 は `failed`。
- 送る前ごとに残り時間を見る（1通あたりの上限を2秒と見て、残りが5秒未満なら送らずに止める）。
- 時間切れで止めたとき、vacancy_notice を**完了にしない**（§1-11 の状態のまま・lease が切れたら次の回が続きから）。B_CLAIMED で sending を書いたのに送っていない人は、次の回に「sending＝送った扱い」で二度と送らない。→ 送る前に止める判断は**sending を書く前**に行う（書いてから止めない）。
- 検査：45秒の直前に429 → 待たずに止まる／途中で止まった枠を次の回が続きから処理し、同じ人に送らない。

### 1-10 (A) の人数の書き方（中10）
- (A) の文から「n名にお送りしました」を**外す**（B を先に終える順にすると (A) が遅れ、トレーナーへの候補が送る時間帯の外で止まる）。人数は vacancy_notice と作業依頼で見る。

### 1-11 vacancy_notice は状態の機械にする（中11）
```
NEW → PROCESSING(lease_id, lease_until) → A_DONE → B_CLAIMED → DONE
                                          ↘ HELD（夜・声かけ待ち・次の回へ。lease を放す）
どこからでも → SKIPPED(理由) ／ EXPIRED（期限切れ）／ FILLED
```
- 取るとき：ロックの中で `lease_until < いま` か自分の lease のときだけ PROCESSING にする（5分）。
- A_DONE：(A) を送った・送らないと決めた。B_CLAIMED：送る人を確保し sending を書いた（人の一覧は nudge_log のキーが正本）。DONE：書き戻しまで済んだ。
- 例外で落ちたら lease が切れるのを待って次の回が状態の続きから。A_DONE なら (A) を二度送らない。
- 検査：PROCESSING の途中で例外 → 次の回で再開・(A) は1回・(B) の同じ人に2回送らない。

### 1-12 ?vac= の合格条件（低12）
- 実機かステージングで次を全部通ってから出す：LINE のトークのリンクから開く／外部のブラウザから開いて LIFF に移る／`liff.state` にエンコードされて渡る場合／`replaceState` で外した後の戻る・再読み込み／古い枠（過去・締め切り後）／月またぎの週／予約できる範囲の外／トレーナーが開いた場合／未登録の人。

### 1-13 検査の追加（本文 §6 に足す）
- cancel_notes の必須列の欠け・時刻の不正（数でない・未来）・同じ resId の重複 → その行は対象外（送らない）
- ロックを取った後のオプトアウト（§1-2）・consecOk の無い古いキャッシュ（§1-4）・連続ルールの読み取り失敗・45秒直前の429（§1-9）・PROCESSING 途中の例外後の再開（§1-11）・trainer_reason の各値（§1-5）・期間の境界（§1-1）・送る直前に埋まる（§1-7）・Nudge との配線（§1-3）

### 1-14 MODEL への追記に足す（本文 §7 の I-V1〜6 に追加）
- I-V7 対象は `D−2日 00:00 ≦ t_c < D日 00:00` かつ締め切り−MARGIN より前
- I-V8 判定できないもの（actor・trainer_reason・枠・残数・連続・同日・hidden のどれか）は対象外＝送らない
- I-V9 1日1通・週2通・人×枠・resId の処理権・オプトアウトの再判定と sending の書き込みは**同じロックの中**
- I-V10 1日1通は全種別（`LB_NUDGE_DAILY_CAP_KINDS`）で数える。声かけの優先順位（`LB_NUDGE_ORDER`）とは別の定義
- I-V11 送る直前に `_lbCheckTrainerAvailable` で確かめ直す
- I-V12 途中で止まっても二重に送らず、状態の続きから再開する（sending を書いた人は送った扱い）

### 直さなかった指摘
- なし（12件・検査の追加・I-V7〜12 すべて反映）。1-5 の owner の扱いは推奨を書いた上でオーナーの決定事項に回した。

---

## 改訂2（Codex 関門① 2周目の反映・2026-11-06）★改訂1・本文より優先

確かめた該当行：予約確定の入口（`_lbReserveCoreImpl` の中）は、B1 の施設の埋まり（`[消化]` と自分の旧予定は除く・境界で接するだけは競合でない）→ `_lbCheckTrainerAvailable` → 1F の競合（`_lb1FBlockEnabled` のとき `_lb1FTrainerBusy`。取得失敗は `SLOT_CHECK_UNAVAILABLE` で断る）の3段で確かめている。`_lbCheckTrainerAvailable` は**トレーナーのカレンダーだけ**／`getTrainerSlots` は `excludeStartISO` を `_lbTrainerSlotsAll` に渡し、変更・振替では作りたての枠（`fresh: true`）を使う／残数の計上と Nudge の来店は confirmed と consumed の両方を数える／`_lbNudgeSentForRange`・`_lbNudgeFirstOfMonth` は種別ごとの記録（`out[kind]`）を見る。

### 2-1 送る直前の空き確認は、予約確定の入口と同じ関数（重大1）
- 予約確定の入口の3段（B1・トレーナーのカレンダー・1F）を共通の関数 **`_lbCheckBookableSlotNow(trainer, start, end, opts)`** に切り出す。返り値は `{ ok: true }`／`{ ok: false, code: 'SLOT_TAKEN' }`／`{ ok: false, unknown: true, code: 'SLOT_CHECK_UNAVAILABLE' }`（カレンダーが読めない・1F の取得失敗・例外）。`opts` は `excludeStart`・`excludeEventId`（変更・振替のため・今の入口と同じ）。
- 予約確定の入口は今の3段の代わりにこれを呼ぶ（返すコードと文は今と同じ）。お知らせは送る直前にこれを呼び、`ok: true` のときだけ送る（`unknown` は送らない）。
- 改訂1-7・I-V11 の `_lbCheckTrainerAvailable` は **`_lbCheckBookableSlotNow` に読み替える**。
- 検査：B1 が埋まっている／トレーナーが埋まっている／1F が埋まっている／1F の取得失敗／`[消化]` だけ（空き扱い）／境界で接するだけ（空き）→ 予約確定の入口とお知らせの答えが同じ（同じ入力で両方を動かす配線の検査）。切り出しの前後で予約確定の入口の答え（コード・文）が完全に同じ。

### 2-2 (A) も送る前に確保する（重大2）
- 状態に **A_CLAIMED** を足す：`PROCESSING → A_CLAIMED（ロックの中・送る前）→ ロックの外で送る → A_DONE`。
- A_CLAIMED のまま落ちた（lease が切れた）ら、**届いたか分からない＝送った扱い**で再送せず A_DONE に進める（`trainer_msg='unknown'`）。
- 検査：(A) を送った後・A_DONE を書く前に例外 → 次の回で (A) を送らずに A_DONE。

### 2-3 会員向けの枠の関数は excludeStartISO を受け取る（高3）
- `_lbCustomerSlotsFor(trainerId, excludeStartISO)`。内部で必ず `_lbTrainerSlotsAll(trainerId, excludeStartISO)` を呼び、その後に今の `getTrainerSlots` の絞り込み（mode・`_lbIsTrainerCaller`・印が無ければ作り直す・`fresh` の分岐・`consecOk === true`）を行う。`getTrainerSlots(body, lineUserId)` は `_lbCustomerSlotsFor(body.trainerId, body.excludeStartISO)` を呼ぶだけにする（トレーナーの呼び出しは今どおり全枠）。お知らせは `excludeStartISO` を渡さない。
- 回帰の検査：通常の予約は切り出しの前後で答えが完全に同じ／変更・振替で旧枠を除外して同じ開始時刻を候補にできる／トレーナーの呼び出しは全枠／off・dry・on の全モード／印の無い古いキャッシュの作り直し・`fresh` の分岐・作り直しても印が無ければ `SLOTS_UNAVAILABLE`。

### 2-4 lease は終わっていない状態すべてに付ける（高4）
- `PROCESSING`・`A_CLAIMED`・`A_DONE`・`B_CLAIMED`（と §2-6 の B の途中）はすべて `lease_id`・`lease_until` を持つ。状態を進めるときは**同じ lease_id のまま**（ロックの中で「今の lease_id が自分のもの」を確かめてから書く）。
- 再開：ロックの中で `lease_until < いま` の行だけ、新しい `lease_id` に置き換えて取る（読んだ lease_id と今の値が同じときだけ書く＝CAS 相当）。
- HELD は lease を放す（lease_id を空にする）。終わった状態（DONE・SKIPPED・EXPIRED・FILLED）は lease を持たない。
- 検査：2つの実行が同じ期限切れの行を取り合う → 片方だけ取れる／自分の lease でない行の状態を進めない。

### 2-5 同じ日の予約は confirmed と consumed の両方（高5）
- 「その日（D）に予約が無い」は、台帳の状態が **confirmed か consumed** の行を数える（残数の計上・Nudge の来店と同じ「消化の定義」）。本文 §3-3-4・§3-4-7・改訂1-6 の表の「その日の予約」をこれに直す。
- 検査：その日に consumed（当日消化の取消・来店）の行がある会員に送らない。

### 2-6 B は1人ずつ確保して送る（中6）
- 改訂1-2 の「通った人をまとめて sending」をやめる（送らなかった人まで1日1通・週2通を使ってしまう）。
- 1人ずつ次を繰り返す（優先順位の順・その枠で最大5名まで）：
  ```
  ① 残り時間を見る（足りなければここで止める＝sending を書く前）
  ② _lbCheckBookableSlotNow（ロックの外）。ok でなければ枠ごと止める（FILLED か unknown）
  ③ ロック：lease を確かめ、その人の再判定（今日1通・週2通・人×枠・on のまま）→ 通れば sending を1行 → 放す
  ④ _lbPushOnce（noInlineRetry）
  ⑤ ロック：結果の書き戻し・vacancy_notice の送った人数を更新 → 放す
  ```
- B_CLAIMED は「B の途中（何人まで済んだか）」を持つ状態にする（`b_done_n`）。再開は nudge_log のキーで済んだ人を飛ばす。

### 2-7 ロックの中を短くする（中7）
- ロックを取る前に、その枠の**候補の顧客IDを固定**する（ロックの中で候補を増やさない）。
- ロックの中のシートの読み取りは**各シート1回**：vacancy_prefs は候補全員の分を1回の範囲読み取り、nudge_log も先頭の範囲を1回、vacancy_notice はその行を1回。
- sending はまとめて書く場合も先頭に挿入して一括の setValues（§2-6 で1人ずつにしたので通常は1行）。
- **ロックを持っていた時間を測り**、5秒を超えたら vacancy_notice と `booking_metrics` に悪化として残す（日次点検に出す）。
- 検査：`lbNudgeDaily`（声かけ）とお知らせを競合させても、声かけが**永久に落ちない**（声かけのロック待ち30秒の間にお知らせのロックが必ず放される・お知らせがロックを取れなければ自分が次の回へ回る）。

### 2-8 検査の追加
- 声かけの計画（`lbNudgePlanAll`）の counts・targets・demoted に `nudge_vacancy` が現れない
- `_lbNudgeSentForRange`・`_lbNudgeFirstOfMonth` の走査は従来どおり `LB_NUDGE_ORDER` の種別だけ（nudge_vacancy を数えない）
- 1日1通に数えるのは nudge_vacancy の **sent と sending だけ**。failed は数えない（`_lbNudgeLogReadAll` の今の条件 `sent`／`sending` に乗る＝`out` の種別を広げるだけで failed は入らない）
- §2-1〜2-7 の各項目

### 直さなかった指摘
- なし（7件・検査の追加すべて反映）。

---

## 改訂3（Codex 関門① 3周目の反映・2026-11-06）★改訂2・改訂1・本文より優先

確かめた該当行：予約確定（`_lbReserveCoreImpl`）は ScriptLock を取ってから、残数・B1・トレーナー・1F の確認→カレンダーと台帳への登録までをロックの中で行う／その外側の catch は `{ success:false, code:'SERVER_ERROR', message: e.message }`（生の例外文を会員に返す）／`lbNudgeDaily` は `tryLock(30秒)` で取れなければ `ALREADY_RUNNING` で終わり、その日の対象者を取りこぼす。

### 3-1 空き確認は sending を書く同じロックの中でもう一度（重大1）
- 改訂2-6 の②（ロックの外の `_lbCheckBookableSlotNow`）は**予備の確認**とする。
- ③のロックの中で、再判定（1日1通・週2通・人×枠・on のまま）に加えて **`_lbCheckBookableSlotNow` を再実行**し、`ok: true` のときだけ sending を書く。予約確定も同じ ScriptLock の中で確認→登録するので、ロックの中で確かめた時点では「確かめた後に予約が入った」は起きない。
- LINE の送信はロックの外（I19）。**ロックを放してから送るまでの短い間に予約が入る競合は残余リスク**として受ける（文面の「ご予約の状況により、お取りいただけない場合がございます」・LIFF の「埋まりました」の案内で受ける）。
- ロックの中でカレンダーを3つ読む分、ロックを持つ時間が延びる（改訂2-7 の5秒の計測で見る）。

### 3-2 枠の関数は呼び出し元の種類を受け取る（高2・改訂2-3 を差し替え）
- `_lbSlotsForCaller(trainerId, excludeStartISO, callerKind)`。`callerKind` は `'customer'` か `'trainer'` で、**呼び出し側が確定させて渡す**。それ以外の値は `{ success:false, code:'BAD_CALLER' }`（推測しない）。
- `getTrainerSlots(body, lineUserId)` は `_lbIsTrainerCaller(lineUserId)` で判定して渡す（今の動きと同じ）。お知らせは**必ず `'customer'` を明示**する（引数が空だから会員、という暗黙の判定はしない）。
- 検査：callerKind が空・未知 → BAD_CALLER／`'trainer'` は全枠／`'customer'` は絞った枠／getTrainerSlots の答えは切り出しの前後で同じ。

### 3-3 空き判定の返り値に原因を残す（高3）
```
{ ok:true }
{ ok:false, code:'SLOT_TAKEN', reason:'capacity_b1' | 'trainer' | 'trainer_1f' }
{ ok:false, unknown:true, code:'SLOT_CHECK_UNAVAILABLE', reason:'calendar_unavailable' }
```
- 予約確定の入口は `reason` から今と同じ文を組み立てる（capacity_b1＝「この時間帯はすでに予約が入りました…」／trainer・trainer_1f＝「この時間帯は選択されたトレーナーが対応できません。」／calendar_unavailable＝今の1F 取得失敗の文）。検査で文が1文字も変わらないことを固定。
- **挙動の変更（推奨・承認が要る）**：今は B1 やトレーナーのカレンダーの読み取りで例外が出ると、外側の catch が `SERVER_ERROR` と**生の例外文**を会員に返す。共通の関数はカレンダーの例外を握って `SLOT_CHECK_UNAVAILABLE`（安全な固定文）を返すので、予約確定の入口の答えが `SERVER_ERROR`→`SLOT_CHECK_UNAVAILABLE` に変わる。利点：会員に生のエラー文を返さなくなる。→ §4 に「9.」として足す。承認されなければ、予約確定の入口では例外を握らずに投げ直す（今と同じ）作りにする。

### 3-4 声かけを取りこぼさせない（高4）
1. **`LB_REMIND_ON=1` かつ当日の声かけの完了の印が無い間は、B に入らない**（最優先）。完了の印は声かけ側が**送信を終えた後**に書く（`lbNudgeDaily` の成功・`ALREADY_RUNNING`・中止を区別して記録し、お知らせ側は「成功で終わった印」だけを完了とみなす。中止・取れなかった印は完了ではない＝その日は B に入らない）。
2. **1回の tick で B は1人だけ**（10分ごとに順に送る）。改訂2-6 のループは1周で終わる。
3. ロックを放した直後に、同じ実行の中で次のロックを取りに行かない（1人の③と⑤の2回だけ）。
4. A（トレーナーへの1通）は声かけと関係なく進めてよい（ロックの時間は短い）。
5. 期限との兼ね合い（1人ずつ10分おきだと、5人目まで最大40分）は `list` の段で「対象の枠が締め切りまで何分残っていたか」を測って判断する。
- 検査：声かけが有効で完了の印が無い日は B に入らない／中止の印では B に入らない／お知らせの tick と `lbNudgeDaily` を競合させ、声かけが**送信の完了まで**進む（`ALREADY_RUNNING` にならない）／1回の tick で B の送信が1通以下。

### 3-5 候補の固定は1回の実行の中だけ（中5・改訂2-6・2-7 を直す）
- 改訂2-7 の「候補の顧客IDを固定」は「**その1回の実行の中だけ**」と読み替える。実行をまたいで持たない。
- `b_done_n` は正本にしない（表示用の参考値）。毎回の実行で最新の候補を計算し直し、**nudge_log のその枠のキー（`vac|trainer|S`）の sent・sending の数**で「最大5人」に達したかを判定する。
- 検査：途中で候補が変わっても（オプトアウト・予約が入る）、送った人数が nudge_log の数で5を超えない／`b_done_n` が壊れていても判定が変わらない。

### §4 に足すこと
- 9. **予約確定の入口の、カレンダーの例外のときの答えを `SERVER_ERROR`（生の例外文）から `SLOT_CHECK_UNAVAILABLE`（固定の文）に変えてよいか**（推奨：変える）。

### MODEL への追記に足す
- I-V13 sending を書くのは、同じロックの中で `_lbCheckBookableSlotNow` が ok のときだけ
- I-V14 声かけが有効な日は、成功の完了の印が出るまで B に入らない・1回の tick で B は1人まで

### 直さなかった指摘
- なし（5件すべて反映）。3-3 の挙動の変更はオーナーの決定に回した。

---

## 改訂4（Codex 関門① 4周目の反映・CEO が記入）

### 4-1 failed の数え方を3つに分ける（高）
| 判定 | 数えるもの |
|---|---|
| 1日1通・週2通 | sent・sending |
| 枠ごとの最大5名 | sent・sending |
| **同じ人×同じ枠に二度送らない** | **sent・sending・failed** |
- failed はその人の上限を使わないが、同じ枠への送り直しだけは禁止する（429 で failed になった人に、次の tick で同じ枠を送らない）。
- 検査：A が429で failed → 次の tick で A には送らない／A の failed は、その日の別の枠を A に送ることを妨げない／A の failed は枠の最大5名に数えず、別の B に送れる。

### 4-2 1人送った後の状態（中）
1人の書き戻しの後：
- その枠の sent・sending が5人未満で、期限内 → B_CLAIMED のまま lease を放して次の tick へ
- 5人に達した → DONE
- 最新の候補が0人 → DONE（reason=NO_TARGET）
- 期限を過ぎた → EXPIRED
- 枠が埋まった → FILLED
- 判定できない → lease を放して次の tick へ。期限までの再試行は最大6回（約1時間）、超えたら SKIPPED（reason=UNKNOWN）
  - 回数は `vacancy_notice.unknown_attempts` に持つ（実行をまたいで残す）。unknown になった**同じロックの中で +1**、lease を持つ実行だけが更新する。6回目で SKIPPED(UNKNOWN)。FILLED など判定できた結果では増やさない。
  - 検査：並行して2つ実行しても1回につき +1 だけ。

### 4-3 カレンダーの例外の扱いはオーナーの決定の後に実装する（中）
- 推奨：オーナーの承認を得て、共通の判定は例外を SLOT_CHECK_UNAVAILABLE（固定の文）に統一する。
- **承認が出るまでは予約確定の入口を変えない。** 承認が出ない場合は、共通の内部の関数は例外をそのまま投げ、お知らせ側だけが catch して unknown（送らない）に変える。
