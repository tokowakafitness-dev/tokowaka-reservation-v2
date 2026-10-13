# 17 LINE通知が届かないまま誰も気づかない、をなくす（設計）

> 起草：2026-10-13／**第3版・関門①②通過・実装済み（未反映）**（決定0082）
> オーナー承認：4段の対策で進める（2026-10-13「OK問題ない」）

---

## 0. 結論

| # | 何をするか |
|---|---|
| 1 | 届かなかった通知を、宛先・本文・用途・**予約ID**ごと非公開シート `notify_retry` に積む |
| 2 | **1件の予約に紐づく通知だけ**、10分ごとの `warmupCache` の**末尾**で送り直す。送る前に、その予約が今もその状態かを台帳で確かめる |
| 3 | 送り直さないもの（まとめ通知・通信例外・ブロック等）と、送り直しても届かなかったものは、**オーナーへメール**（本文つき） |
| 4 | LINE の応答本文を記録（実装済み・未反映） |
| 5 | 過去の失敗が誰のどの通知か、**候補**を出す読み取り窓口 `remaining {notifyFails:N}` |
| 6 | ★**予約変更で「承りました」と「変更しました」が二重に送られていた**のを直す（変更の通知だけにする） |

**倒れる向き**：迷ったら**送らずにオーナーへ知らせる**。間違った案内を送るほうが、届かないより悪い。

---

## 1. 事実（コードで確認済み）

- 送信の出口は `_lbPush(to, text, purpose)`（LineBooking.js:4187）。失敗は `booking_metrics` に理由と用途だけ。宛先・本文・予約は残していない。
- 429 は 9/17・10/08・10/12 に**いずれも4件**。月の枠は5000通中200通台。原因は未確定。
- ★**予約変更**（6871〜）は `_lbReserveCore` を `suppressNotify` なしで呼ぶ（6882）→ `_lbNotifyReservation` が「ご予約を承りました」「【新規予約】」を送り（4441〜）、その後に「変更」2通を送る（6905〜6910）。**1回の変更で4通**。過去の「4件ずつ」と一致する（仮説・未確認）。
- 予約系はすべて **ScriptLock** を使う（予約 4349 waitLock 10s／取消 6767／変更 6871／一括 7315 tryLock 20s／体験 コード.js:550）。通知の送信は予約・取消ではロックの**中**。
- 台帳 `line_reservations`：A=予約日時 C=customer_id G=status I=備考（**予約ID。取消後は「予約ID|無料取消」等**）。
- 現行の 429 再送は、途中で 429 以外が返っても**最初の応答**を記録する（4238）＝分類を誤る。
- `_lbPush` は token が無いと記録せず false（4190）。本番でトークンが消えても気づけない。
- トリガー 18/20。新設しない。`warmupCache`（10分ごと）は止まらない。`edgeJobPoll` 等はスイッチで止まる。
- 作業依頼の結果は公開URL。`_ejScrub` は LINE ID・電話・メールしか消さない（氏名は残る）。

## 2. 送り直すもの・送り直さないもの（用途ごとの規則）

| 用途 | 自動で送り直すか | 送る前の確認（全部満たすときだけ送る） |
|---|---|---|
| `booking_customer` `booking_trainer`（単発の予約確定） | する | 予約IDの行が **confirmed** |
| `change_customer` `change_trainer` | する | **新**予約IDが confirmed、かつ**旧**予約IDが changed |
| `cancel_customer` `cancel_trainer` | する | 予約IDの行が cancelled/consumed のまま、かつ**同じ会員・同じ開始時刻の confirmed 行が無い** |
| `reminder_customer` | する | 予約IDの行が confirmed |
| `reminder_trainer`（1日分のまとめ） | **しない** → オーナーへ | — |
| `batch_*` `autobook_*`（複数予約のまとめ） | **しない** → オーナーへ | — |
| `shift_trainer` `pace_trainer` | **しない** → オーナーへ | — |
| `trial_staff`（体験予約のスタッフ通知・旧トークン） | **しない** → オーナーへ | 体験は通知が台帳記録より先（コード.js:637→643）で、成立を確かめられない |
| `nudge_*` | **しない**・オーナーへも送らない | 独自の記録あり。件数は点検に出る（既存） |

共通の確認：**期限**＝その予約の開始時刻（過ぎたら送らない）。予約IDが無い／台帳で2件以上ヒット → 送らずオーナーへ。

## 3. 応答ごとの扱い

| 応答 | 扱い |
|---|---|
| 200 | 成功 |
| 429・5xx | 上の表で「する」なら積む。「しない」ならオーナーへ |
| 400/401/403/404 | 送り直さない → オーナーへ（401 は件名を「全通知停止」に） |
| 通信例外・コード取得不能 | **`delivery_unknown`**。LINE側に届いている可能性があり、送り直すと二重になる → 送り直さずオーナーへ |
| 本番でトークンが無い | 記録する（`NO_TOKEN`）。staging（`_lbIsStaging()`）は従来どおり記録しない |
| 宛先が無い | 従来どおり（LINE未連携の会員＝想定内） |

## 4. 仕組み

### 4-0. 予約IDを渡す呼び出し元（ctx の配線表）

| 呼び出し元 | 用途 | 渡す ctx |
|---|---|---|
| `_lbNotifyReservation`（4272・通常予約／トレーナー代行） | booking_customer / booking_trainer | `recordReservationLine` が返した resId・customerId・startMs（引数を足す） |
| 手動紐付け（6370） | booking_customer | resId・customerId・startMs（6362 で持っている） |
| 予約変更（6905・6910） | change_* | 新 resId（`made.reservationId`）・旧 resId・customerId・新 startMs |
| 取消（6804・6808） | cancel_* | resId・customerId・startMs |
| 前日リマインド（906） | reminder_customer | I列の '|' の前・customerId・startMs |
| それ以外 | — | 渡さない（＝送り直さずオーナーへ） |

予約IDの照合は必ず `String(note || '').split('|')[0] === resId`。ヒットが1行でなければ送らない。

### 4-1. 送信を2層に分ける
```
_lbPushOnce(to, text, opts) → { ok, code, body, uncertain }
   … 送るだけ。間隔260ms・429の短い粘り(1.2/3/6s)は今のまま
   ★code/body は「最後の試行」の値を返す（現行の誤分類を直す）
   ★opts.noInlineRetry で短い粘りを省く（送り直しの tick 用＝時間を読める）
_lbPush(to, text, purpose, ctx) → true/false   … 今の入口。4引数目は任意
   失敗 → booking_metrics に記録（今どおり）＋ 規則に従い「積む」か「オーナー宛ての行」を作る
```
- tick は `_lbPushOnce` だけを使う＝**送り直しの失敗が再び積まれない**（N1）。

### 4-2. `notify_retry` シート
`id, created_at, token_key, to, text, purpose, ctx_json, state, attempts, next_at, last_code, last_detail, alerted_at, email_attempts, last_email_error`
- `ctx_json`：`{ resId, oldResId, customerId, startMs, trainerId }`
- state：`pending`（送り直し待ち）／`sending`／`sent`／`stale`（送るべきでなくなった）／`alert`（オーナーへ知らせる）／`alerting`／`closed`（知らせ済み）。列に `lease_id, lease_until` を足す
- 書き込みは失敗時だけ（月数件）。
- ★書けなかったら（シートが無い・書き込み例外）、**同じスプレッドシートとは別の媒体**＝Script Properties `LB_NOTIFY_QUEUE_WRITE_FAIL` に `件数|最終時刻|用途|code` を残す（氏名・本文・LINE ID は入れない）。点検はこれが1以上なら high。`booking_metrics` だけだと、同じ原因で一緒に書けない

### 4-3. 送り直し `lbNotifyRetryTick()`
- 呼ぶ場所：**`warmupCache` の末尾**（作りたてで省略する分岐でも呼ぶ）。枠の温め直しを先に終える。
- **ScriptLock は「取り分け」と「結果の書き戻し」の短い区間だけ**使う（`tryLock(0)`。取れなければその回は何もしない）。
  - 取り分け：送る行を `pending → sending` にし、`lease_id`（この実行のID）と `lease_until`（5分後）を書いて即解放
  - LINE への送信・待ち・メール送信のあいだは**ロックを持たない**（予約の10秒待ちを邪魔しない）
  - 書き戻し：短くロックを取り、`state=sending かつ lease_id が自分` の行だけ `sent/pending/alert/stale` にする
  - `lease_until` を過ぎた `sending` は `pending` に戻す（途中で止まった実行の後始末）
  - ★Script Properties だけのリースは原子的でない（読む→書くの間に別の実行が入る）ので使わない
- シート `notify_retry` は tick が毎回「無ければ作る」（**取り分けの短区間ロックの中で**作る＝同時作成を避ける）。**予約処理の失敗経路でシートを作らない**（ロック内を重くしない）。無ければ非常用記録（4-2）へ
- 時間：`warmupCache` 開始から **3分を過ぎていたら何もしない**。tick 内は**90秒**の予算。各送信の前に残りを見る。
- 送り直しは `noInlineRetry`（1回だけ）。間隔：10分後 → 30分後 → 2時間後。3回で駄目なら `alert`。
- 行の更新は行番号で行う（追記は末尾なので番号はずれない）。
- 最後に `alert` の行を**まとめて1通**オーナーへ。送る行も同じ方式で取り分ける：短区間ロックで `alert → alerting`＋lease_id → ロックを外してメール → 自分の lease_id の行だけ、成功なら `closed`、失敗なら `alert` に戻して `email_attempts++`・`last_email_error`。期限切れの `alerting` は `alert` に戻す。
- 記録：`LB_NOTIFY_RETRY_STARTED` / `_COMPLETED` / `_LAST_ERROR` を分けて残す。

### 4-4. 点検（`dailyHealthCheck`）
- `_COMPLETED` が **1時間より古い → high**（送り直しが止まっている）
- `pending` 件数、`alert` で未通知の件数（メールが送れていない）、前日の `alert`/`closed` 件数

### 4-5. 読み取り窓口 `remaining {notifyFails:N}`
- **許可した項目だけで組み立てる**（行を文字列化して伏せる方式にしない）：時刻・理由・用途・応答の先頭・候補
- 候補の作り方（過去分は宛先の記録が無いので**特定ではなく候補**）：
  - `reminder_*` → 失敗の翌日の confirmed 予約。`reminder_trainer` はトレーナー別に
  - それ以外 → 記録日時（K列・分単位）が失敗時刻の −3分〜＋1分の行
  - 候補の数を必ず出す。2件以上なら `AMBIGUOUS`
  - 候補ごとに：予約日時・トレーナー名・顧客IDの下4桁・status・channel
- `notify_retry` は状態別の件数だけ
- 本文（text）・宛先（to）・応答の生値は出さない

### 4-6. 予約変更の二重通知を直す
- 変更から `_lbReserveCore` を呼ぶとき、**新しいオブジェクト**に `suppressNotify: true` を足して渡す（既存の custInfo を書き換えない）。通知は「変更」2通だけにする。
- ★お客様から見える変化：変更時に届くLINEが2通→1通（「変更しました」だけ）。トレーナーも同じ。

## 5. 守ること（不変条件）

| | 規則 | 守る検査 |
|---|---|---|
| N1 | 送り直しの失敗は再び積まれない | `notify-retry.test.js`（GASコードを vm で動かす） |
| N2 | 予約系は、その予約IDが期待の状態でなければ送らない（取消済みへ「承りました」を送らない） | 同上 |
| N3 | 開始時刻を過ぎた通知は送らない | 同上 |
| N4 | まとめ通知・通信例外・400番台は送り直さず、オーナーへ | 同上 |
| N5 | 積む処理・tick が例外を出しても、予約と枠の温め直しは止まらない | 同上（例外を注入） |
| N6 | 外部通信のあいだ ScriptLock を持たない（取るのは取り分け・書き戻しの短区間だけ・tryLock(0)）。時間予算を守る | 同上＋字面検査 |
| N10 | 送り直しの行も警告メールの行も、2つの実行が同時に処理しない（取り分けで `sending`/`alerting`＋lease_id） | 同上 |
| N11 | キューに書けなかったことが別の媒体（Script Properties）に残り、点検に出る | 同上 |
| N7 | 公開窓口に氏名・lineUserId・本文を出さない | 同上（既知の氏名・ID・本文を入れて出力に無いこと） |
| N8 | 予約変更で `booking_*` を送らない | 同上 |
| N9 | 最後の試行の code を返す（429→401 は 401 として扱う） | 同上 |

## 6. 見送ったもの（理由つき）

| 指摘 | 判断 | 理由 |
|---|---|---|
| 失敗の記録を予約のロックの外へ移す（関門① #6） | **見送る** | 失敗は月に数件で、そのときだけ1行の追記が増える（既に `booking_metrics` の追記がロック内にある）。通知をロックの外へ移すには `_lbReserveCoreImpl` の構造を変える必要があり、巻き戻し機構（catch内の deleteEvent）に隣接する。得るものより壊す危険が大きい |
| 体験予約の通知を台帳記録の後へ移す（#10） | 今回は見送る | 自動で送り直さない＋オーナーへ知らせる、で害は無くなる。順序の変更は体験予約の経路の別作業 |
| 声かけのロック取り損ねの可視化（静かな経路） | 今回は見送る | 本件（予約の通知）と別。やり残しに記録する |

## 7. 変えないもの
- 送信の間隔・予約が通知失敗で巻き戻らないこと・トリガーを新設しないこと
- 二重送信を**絶対に**防げるとは言わない（LINE成功後に `sent` を書く前に止まると次回また送る。確率は低い）
