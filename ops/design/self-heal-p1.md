# 設計 P1：予約システムが自分で直す（AI なし）・氏名を外した要約・案件台帳・練習モード
最終更新：2026-11-24（第10版・関門②の3件 §14-2／第9版・本番で台帳が空のタブのまま初回から黙っていたことへの直し §14／第8版・関門②3回目：副作用の直前は延長できたときだけ通す・完走後の通知の見送りは数えない／第7版・関門②の差し戻しを反映：印を失ったら点検は以降の副作用をせずに終える・確認を ok/busy/lost に分ける・修理の予算・作った後の上限超え／第6版・実装と CEO 裁定を反映：専用トリガーを作らず lbNudgeDaily に相乗り・足した後18本以下・宛先は owner かつ active・§13 実装で決めたこと／第5版・関門①4回目「条件付き実装可」の7条件を取り込み済み／第4版・関門①3回目：印の期限を実行上限から切り離す・印の延長と確認・完走の一致条件）

> ★このリポジトリの写しが正本（会社側 `30_projects/personal-training/ops/design-self-heal-P1.md` から写した・2026-11-23）。
> 構想＝`booking-self-healing.md`・`90_ops/operations/maintenance-squad.md`（会社側）。振り分け＝`../booking-health-triage.md`（正本）。
> 決定＝0198（個人情報の線・会員番号）・0199（部隊）・0200（起こす上限5回・即時は LINE）。関門①の記録＝決定0201。
> 対象コード＝`tokowaka-reservation-v2/gas/LineBooking.js` の `dailyHealthCheck`（1914〜2598）。不変条件の置き場所＝`tokowaka-reservation-v2/ops/MODEL.md`。

## 0. 目的（1行）
**本当に安全な修理だけを GAS が AI なしで行い、直ったかを「検査が完走して 0 件」で確かめ、オーナーへは C と行き詰まりだけを届ける。**

## 1. 比べた手段
| 手段 | 採否 |
|---|---|
| ① 点検の中で直す | ✗ 点検は 557 秒で 6 分制限を超えた実績（2026-10-10） |
| ② **点検の後に `lbSelfHeal` で直す** | **採用**。★実装で変更（CEO 裁定 2026-11-23）：専用のトリガーは作らず、**lbNudgeDaily（10時）の最後**に相乗りする（本番のトリガーは18本で上限20に近い） |
| ③ 部隊（AI）に直させる | ✗ P1 では不要（決定0200） |

## 2. 実物で確かめた事実
1. `add()` は **count=0 なら何も積まない**（1961〜1964）。記録に無い＝0 とは限らない（段が落ちた・key が無くなった）
2. `LB_HEALTH_LAST` は**点検の開始時**に書く（1939）。途中で落ちても「走った」に見える。見張りは `Nudge.js:814`・`EdgeAudit.js:2658`
3. 既存のトリガー設定関数はどれも**「担当分を全部消してから作り直す」**。途中で失敗しても戻さない。`setupEdgeJobTrigger` は**消した後に**設定の確認と ping をする（EdgeJob.js 302〜317）＝失敗すると消えたまま。**修理には使わない**
4. `dailySync` は `syncExistingReservations()` で予約の行を書き、`line_unlinked` を作り直す（3660〜・6041〜6088）＝顧客の状態に触る＝**A ではない**
5. `lbDwEnsureQueued(customerIds)` は会員番号の配列が要る。`gen_*` の案件にどの番号を渡すかの出どころが無い
6. `setupCancelNotesSheet` は、見出しが違うときは書き換えずに `mismatch` を返す（8193〜8212）。回復の判定は `_lbCnHealth().ready`
7. detail には氏名と `e.message` が入る（1969・2047・2083 ほか）
8. 権限の判定は owner と admin の両方（3768）。LINE の通数が尽きた警告は既存でもメール（`checkLineQuota` 1208〜1255）
9. `dailyHealthCheck` には実行のロックが無い。トリガーが重複すれば 2 本同時に走りうる

## 2-1. 同時に1本だけ（★第4版の土台）
GAS の ScriptLock はスクリプト全体で1つで、予約・振替・一括予約も使う（5374・5677・9202）。**長く持つと顧客の操作が待たされる。**
**★実行時間の上限を前提にしない。** 点検は 557 秒（9 分 17 秒）かかった実績がある（1943）＝「6 分で必ず止まる」は成り立たない（Workspace のアカウントなら上限 30 分）。

- **借りる印** `LB_HEALTH_LEASE = {owner: 実行ごとの乱数（Utilities.getUuid()）, until: 期限, entry: 'check'|'check_dry'|'heal'}`（Script Properties）。★owner に check_id（開始のミリ秒）を使わない＝同じミリ秒に起動した 2 本が同じ owner になる。check_id は結果の順序用に別に持つ
- **手動・dry-run の点検も同じ印を取る**（`dailyHealthCheck(true)` も `refreshPaceBoard()` でシートを書く 1966〜1969・1671〜1688＝読み取り専用ではない）。取れなければ実行しない
- **取る**：ScriptLock を `tryLock(300ms)` → 印が無い、または `until` を過ぎていれば自分の印を書く → **すぐ放す**
- **期限は 35 分**（どの実行上限 30 分よりも長い）。そのうえで**段ごとに延長する**：既存の `_step()`（段の始めに Script Properties へ書いている・1950 付近）で、印が自分のものなら `until = いま + 35 分` に書き直す。lbSelfHeal も案件ごとに延長
  → **生きている実行の印は、最後の延長から 35 分以内に必ず次の延長か終了が来る**（35 分延長されない＝上限 30 分を超えた＝実行は既に死んでいる）。古い実行が副作用を続けたまま印を奪われることは起きない
- ★第7版：**点検は印を失った（他人の印・期限切れ）と分かった時点で、以降の副作用（health_status の追記・LB_HEALTH_PREV・悪化メール・lbNotifyDeferDailyMaint・要約・SINCE・台帳・DONE を含む）をせずに終える**（I-H21）。確認の結果は ok／busy（ScriptLock が取れない）／lost の3つに分ける。★第8版：**副作用の直前は延長できたときだけ通す**（busy なら tryLock 300ms を3回まで試し、だめならその副作用をしない＝点検は終える・修理は次回へ）。延長しないまま続けてよいのは**点検の段の進行（読み取り）だけ**で、手元の期限の残りが5分以上のとき。busy で終えた回は LB_HEALTH_SKIP に lock_busy（I-H30）。DONE の後の見送りの引き算・起こすはずだった回数は DONE の直前の延長から35分の中なので確かめない。完走した点検の後の通知（LINE・メールの1通ごと）は延長できなければ送らずに次回へ（deferred_lease・SKIP に数えない＝見送りではない）
- **確かめる**：トリガーを足す・シートを作る・LINE を送る・attempts を増やす・sending を書く・台帳を書く・要約を書く、の**それぞれの直前**に、短い ScriptLock（tryLock 300ms）の中で「**owner が自分 かつ 期限内**」を確かめ、**その場で 35 分延長**してから放す。期限を過ぎていれば owner が自分のままでも以降の副作用をせずに終わる（実行上限が未確認でも安全側に倒れる）。ロックが取れなければ副作用をせず見送り
- **放す**：`finally` で、短い ScriptLock の中で「まだ自分の印なら消す」（既存の例：PushToEdge.js 1698）
- **壊れた印**（JSON が壊れている・owner/until が無い・数でない・いまより 2 時間以上未来）は**期限切れとみなさない**。取らずに見送り、`LB_HEALTH_SKIP` に `lease_broken` を書く（倒れる向き＝修理しない側）
- **見送りの記録** `LB_HEALTH_SKIP = {count: 連続回数, last: 時刻, entry, why: 'held'|'lock_busy'|'lease_broken'|'expired'}`。順序を固定：①点検の開始時に前回までの count を読む ②count>0 なら `health_skipped`（B・メール）を今回の要約・台帳に入れる ③要約・台帳・DONE を保存できた**後に** count を 0 に戻す。**点検そのものが連続で見送られ続けた場合**は `LB_HEALTH_LAST` が更新されないので、既存の見張り（Nudge.js 836〜841・36 時間）が気づく。lease_broken は**次の lbNudgeDaily でメール**（固定の文）
- **この印が排他するのは点検と修理の間だけ。** 点検が呼ぶ既存の書き込み（`refreshPaceBoard` がシートを消して作り直す 1671〜1675）と、その日次トリガー（6 時）との重なりは**今までどおり**で、この設計では防がない（P1 で新しく生む競合ではない）
- オーナーが手で既存の setup* を走らせる・別の処理が一回限りのトリガーを作る、は印を見ない。トリガーを足す処理は「作る直前に数え直し、作った後にもう一度数える」。**作った後に 2 本以上あれば消さずに escalated**（B へ）。★足した後 18 本以下（普段の本数を超えない＝元に戻すだけ・CEO 裁定 2026-11-23。第5版は 17 本）

**回数（attempts）**：修理を呼ぶ**前に**台帳で +1（書き手が 1 本なので二重にならない）。呼んだ後に落ちても「試した」に数える＝3 回で必ず止まる側に倒す。練習の would_attempts も同じ
**通知**：送る**前に** `notify_state=sending` と時刻を書き、届いたら `delivered`。次の回に `sending` のまま残っていたら（送信中に落ちた）**LINE は送り直さず**メールに倒す（二重に届くより安全）。notify_tries は sending を書くときに +1

## 3. P1 の修理の範囲（第1版から大きく絞った）
| key | P1 の扱い | 理由 |
|---|---|---|
| **trigger_missing** | **A：足りない処理名のトリガーを1本だけ足す専用関数**（消さない） | 正常なトリガーに触れない。足すだけなので途中で落ちても悪化しない |
| **cancel_notes_unready** | **A：`setupCancelNotesSheet`**。回復の判定は `_lbCnHealth().ready` | 冪等。シートが**空なら見出しを書き直し**、データ行があって見出しが違えば触らず `mismatch`（8204〜8211）＝データは消さない |
| trigger_dup | **B**（P1 では消さない） | どれを残すかの判断と、一回限りの正常な重複の見分けが要る |
| sync_stale / sync_never | **B** | `dailySync` は予約の行を書く（§2-4）。トリガーが消えた場合は trigger_missing 側で戻る |
| gen_* 4 つ | **B** | 渡す会員番号の出どころが無い（§2-5） |
| reminder_stale・notify_retry_stalled・pace_fail・shadow_sweep_* | **B** | 手当ての関数の副作用が未確認 |

→ 振り分け表 `booking-health-triage.md` の A を 15 → 2 に、B を増やす（同じ変更で直す）。

### 3-1. trigger_missing の専用関数 `lbHealAddMissingTriggers(names)`
- 対象は `dailyHealthCheck` の必須一覧 8 つのうち **`dailyHealthCheck` 以外の 7 つ**（自分を起こす処理は自分で直せない＝見張りは lbNudgeDaily）
- 時刻の表 `LB_HEAL_SCHEDULE`（処理名→作り方）を持つ。**既存の設定関数と食い違わないことを検査で固定**：検査の中で既存の設定関数（setupLineTriggers・setupNudgeTrigger・setupEdgeTrigger・setupEdgeJobTrigger）を**記録用の身代わり ScriptApp で実際に動かし**、作られたトリガーの組み立て（処理名・周期・時刻）を表と突き合わせる（本文を正規表現で抜くと定数・改行で壊れるため）。`setupCalSyncTrigger`（`lbCalSyncTick`）は必須一覧に無い＝対象外と明記
- 手順：（借りる印を持った状態で）**作る直前にトリガーを数え直す** → 0 本の処理名だけ → 総数＋足す本数が **18 本以下**のときだけ（普段の本数を超えない・第5版は 17 本）→ 1本ずつ作る → 作った後に数え直して 1 本になったかを記録
- edgeJobPoll と pushToEdge* は `EDGE_URL`・`EDGE_SECRET` が無ければ足さずに B（設定が無いのに動かしても失敗が積もるだけ）
- ★第7版：作った後に総数を数え、18本を超えていれば（作っている間に別の処理が作った）消さずに escalated（last_action=over_limit_after）
- 時刻のずれ（6時間ごとの起点など）は顧客に届かない＝許容
- sendLineReminders を足しても、その場では送らない（次の 12 時に走る）。0 本のときだけ足すので二重にならない

## 4. 氏名を外した要約（`LB_HEALTH_STATUS`）
### 4-1. 型で漏れを防ぐ（★列挙だけ・自由な文字は通さない）
- `add(key, area, severity, count, detail, safe)` に 6 番目の引数 `safe = { facts: [...], ids: [...] }` を足す。**要約は `safe` だけから作り、detail は読まない**
- `facts` は **key ごとに許す値の一覧 `LB_FACT_ENUM`** にあるものだけ。例：trigger_missing＝必須の処理名 7 つ／cancel_notes_unready＝`missing`・`mismatch`・`unreadable`／`*_fail` 全般＝`exception`／名前入り key＝`ids_unavailable`。一覧に無い値は捨てて `facts_rejected` を数える（正規表現の形だけではローマ字の氏名・電話番号が通るため）
- `ids` は会員番号の形 `^C\d{14}$` だけ。P1 で ids を出すのは **member_broken のみ**。`_lbCollectPace` が既に読んでいる `cid`（1511）から**直接**組み立て、氏名の配列（1514・1682 brokenNames）からは作らない
- `last_action`・`notify_code`・`notify_state` も列挙（`LB_ACTION_ENUM`・`LB_NOTIFY_ENUM`）
- **LINE とメールの文面は key ごとの固定の文 `LB_OWNER_MSG`**。差し込めるのは列挙の値・件数・会員番号の末尾 4 桁だけ。**オーナー向けメールの「オーナーにしかできないこと」の節も台帳と要約だけから作る**（detail を差し込まない）
- `e.message` は要約にも台帳にも入れない。例外は `facts: ["exception"]` だけ
- 各 20 件で切り、切ったら `truncated` に件数

### 4-2. 完走の印と保存の順（★途中で落ちた結果を修理に使わない）
- 点検の最初に `check_id = 開始の時刻(ms)`。**`LB_HEALTH_LAST` にもこの同じ数を書く**（いまは別の `Date.now()` を書いている 1930/1939。ずれると完走しても `DONE < LAST` になり誤報）
- 要約には `completed`（最後まで来たか）と `checked`（**例外なく終わった段の名前**）を入れる。★`checked` は既存の `_step()`（段の**始め**に呼ばれる）と**共用しない**。各段の処理が例外なく終わった**直後**に `_done('段の名前')` で足す（始めに付けると、途中で落ちた段の key 不在を 0 とみなして案件を閉じてしまう）
- key には `LB_TRIAGE` で**それを測る段**を対応させる。**「その段が checked にあって、key が無い」ときだけ 0 とみなす**
- 保存は最後に**1回で**：借りる印が自分のものか確かめる → 保存済みの `check_id` が**自分より新しければ上書きしない** → 要約 → `LB_HEALTH_SINCE` → 台帳の反映 → `LB_HEALTH_DONE`（**完走した最大の check_id**。小さい値で戻さない）
- `LB_HEALTH_DONE`（完走の時刻）を新設。既存の見張り（Nudge.js 813〜836）の判定を次にする：
  - `LB_HEALTH_LAST` が古い → 点検そのものが止まった（今までどおり）
  - `LAST > DONE` かつ LAST から 2 時間超 → 最新の点検が途中で落ちた（新設）
  - `DONE >= LAST` → 完走
  - **`DONE` が未設定の間は「途中で落ちた」を出さない**（反映直後の誤報を防ぐ移行の猶予。DONE が一度でも書かれたら判定を始める）
- 監査の画面（EdgeAudit.js 2658〜2668）にも「最後に完走した時刻」を並べる（開始時刻だけ見て正常と思い込まないため）

## 5. 案件台帳（シート `incidents`）
| 列 | 中身（★固定のコードと数値だけ） |
|---|---|
| id | `key@check_id`（開いた点検） |
| key / cls | |
| opened_at / last_seen / closed_at | |
| count_first / count_last | |
| attempts | 本当に修理した回数 |
| would_attempts | 練習モードで「するはずだった」回数（attempts は増やさない） |
| last_action | `add_trigger:<処理名>`・`setup_cancel_notes` などの固定のコード |
| status | open / fixing / fixed / escalated / owner / unknown |
| notified_at / notify_code / notify_tries | 通知の試行と結果（修理とは別の列） |

- 開く・更新・閉じるは借りる印を持った 1 本だけが行う（§2-1）。開く前に同じ key の開いた行が無いかを読み直す
- **閉じる（fixed）は「完走した点検で、その key の段が checked にあり、key が無い」ときだけ**
- 段が checked に無い → `unknown`（閉じない・開いたまま）
- escalated：attempts が 3 でも残る／A の修理が「上限に近い」「設定が無い」で足せない
- 練習モードでは status を fixing にしない（open のまま・would_attempts だけ増やす）

## 6. 修理 `lbSelfHeal`（lbNudgeDaily の最後・毎日 1 回）
★第6版：専用のトリガーは無い。`lbNudgeDaily` の最後（finally・うながしのロックを放した後）に `_lbNudgeThenSelfHeal` が try/catch で1回呼ぶ。うながしの戻り値・送信を変えない・自己修理の例外をうながし側に漏らさない（I-H29）。早く戻った回（ロックが取れない等）も呼ぶ
1. `SELF_HEAL_MODE`：`off`／`practice`／`on`。**未設定・不正値は practice**。トリガーから来る第 1 引数は見ない
2. 最初に `LB_SELFHEAL_LAST` を書き、最後に `LB_SELFHEAL_DONE` を書く
3. **`要約.check_id === LB_HEALTH_DONE`** で、かつ `completed`、26 時間以内、のときだけ進む。どれか欠ければ何もしない（台帳は触らない・心拍だけ残す）。★要約を書いた後・台帳や DONE の前に落ちた点検の結果は、DONE が進んでいないので使われない
   - 途中で落ちた点検の後始末：次の点検が要約・SINCE・台帳を**最初から作り直す**（台帳への反映は key ごとに「開いた行があれば更新・無ければ開く」なので、同じ結果を 2 回反映しても同じになる）
4. 開いている A の案件ごとに §3 の手当て（attempts < 3・呼ぶ前に +1）。借りる印を持った状態で
5. 直後の測り直しは記録だけ（閉じるのは次の点検）
6. ★第7版：予算＝min(4分, 5分 − lbNudgeDaily にかかった時間)（lbNudgeDaily が開始時刻を渡す）。60秒未満なら始めず LB_HEALTH_SKIP に no_time（entry=heal）・完走の印を書かない。予算を超えたら残りは次回へ（I-H31）

**自分の見張り**：次の `dailyHealthCheck` が `LB_SELFHEAL_DONE` を見て、mode≠off なのに 26 時間を超えていれば `selfheal_stale`（B・メール）。practice が 14 日を超えたら `selfheal_practice_long`（info）。

## 7. 通知
| 何 | 経路 | 判定 |
|---|---|---|
| quota_exhausted | **メールだけ**（LINE は試さない） | 案件が開いたとき 1 回＋毎日の要約 |
| notify_alert_unsent・pending_payment_overage_urgent | **LINE**＋失敗ならメール | 案件ごとに届くまで（最大 3 日・1 日 1 回）。届いたら送らない |
| C の 1 日 1 回 3 つ・escalated・unknown・selfheal_stale | メール「オーナーにしかできないこと」 | **悪化と無関係に**、開いている間は日付ごとに 1 通（`LB_OWNER_DIGEST_DATE`） |
| A の修理・fixed | 送らない（台帳） | |

**LINE の宛先**：`trainer_master` で role=**owner**、**active が真**（既存 `_lbOwnerLineIds` と同じ `_lbTruthy`・第6版で訂正：在籍の列 TR_COL.ACTIVE は**ある**）、line_user_id が空でない人。★`_lbOwnerLineIds` はそのまま使わない（admin も返す・重複を除かない・表が読めないと例外）。同じ ID は 1 回。admin には送らない。**0 人・表が読めないときはメール**に倒し、`notify_code=no_recipient`
**文面**：取り違えようのない一文＋押すもの 1 つ。会員は番号の末尾 4 桁。氏名なし
**送信**：**`_lbPush` を使わず `_lbPushOnce(to, text, {purpose:'owner_heal', noInlineRetry:true})` を直接呼ぶ。** `_lbPush` は失敗を `_lbNqOnFail` に積み、未知の用途は方針 `alert`（`_lbNqPolicy` 4637〜4642）＝**送れなかった警告が notify_alert_unsent になり、それがまた LINE を呼ぶループ**になる。結果のコードを `notify_code` に書き、再送はこの台帳の notify_tries で行う

## 8. 部隊を起こす回数（決定0200）
P1 では起こさない。「起こすはずだった回数」を日付ごとに `LB_SQUAD_WOULD_WAKE` に数える（上限 5 を超えた日も）。

## 9. 不変条件（MODEL.md に **I-H1〜** として足す。各行に守る検査を書く）
| # | 規則 | 守る検査（P1 で書く・`worker/test/self-heal-*.test.js`） |
|---|---|---|
| I-H1 | 要約・台帳・LINE・メールの「オーナーにしかできないこと」に、架空の氏名・顧客が書いた文・例外の文・LINE の ID・メール・電話・予定名が入らない | 全部を detail と e.message に混ぜて点検を通し、出力の全文字列を走査 |
| I-H2 | fixed は「完走・その段が checked・key 無し」の点検だけが付ける | 修理が成功を返しても count>0 なら閉じない／段が落ちた点検で閉じない |
| I-H3 | 修理は既存の setup* を呼ばない・トリガーを消さない | setup*・deleteTrigger を呼ぶと落ちる身代わり |
| I-H4 | 足すのは 0 本の処理名だけ。作る直前と直後に数える。直後に 2 本以上なら消さずに escalated | 直前に別の処理が 1 本作った場合・直後に 2 本ある場合 |
| I-H5 | 足した後の総数は 18 本以下。超えるなら足さずに escalated | 17 本・18 本・19 本 |
| I-H6 | 修理の途中で落ちても、修理前にあったトリガーは残る | 作成の途中で例外 |
| I-H7 | mode 未設定・不正値・イベントの引数 → practice | 修理関数が呼ばれない |
| I-H8 | `要約.check_id === LB_HEALTH_DONE`・completed・26 時間以内でなければ修理しない | 要約だけ書いて落ちた状態・古い要約 |
| I-H9 | 同じ案件の修理は 3 回まで（呼ぶ前に +1）／練習は attempts を使わない | 4 回目・修理の途中で落ちた回も数える |
| I-H10 | 振り分け表に無い key は B／`LB_TRIAGE` と `booking-health-triage.md` が一致（76 key） | 表を読んで突き合わせ |
| I-H11 | 古い点検は新しい要約・台帳を上書きしない／DONE は小さい値で戻らない | check_id の前後を入れ替えて保存 |
| I-H12 | 予約の行・残数の材料・顧客に届くものを書く処理を A から呼ばない | 修理の呼び出し表に dailySync 等が無い・呼ぶと落ちる身代わり |
| I-H13 | facts・ids・last_action・notify_code・notify_state は列挙だけ | 一覧に無い値（ローマ字の氏名・電話番号）が捨てられる |
| I-H14 | 即時の宛先が 0 人ならメール。quota_exhausted は LINE を試さない | owner 0 人・2 人・同じ ID・表が読めない |
| I-H15 | 通知は試行と成功を分け、届いた後は送らない／sending のまま残れば LINE で送り直さずメール | 送信中に落ちた状態から再実行 |
| I-H16 | lbSelfHeal の完走を翌日の点検が、点検の完走を lbNudgeDaily が確かめる | 心拍が古い状態 |
| I-H17 | cancel_notes の回復は `_lbCnHealth().ready` でだけ | シートはあるが見出し違い |
| I-H18 | `LB_HEAL_SCHEDULE` が既存 setup* の作り方と一致 | setup* を身代わり ScriptApp で実行して突き合わせ |
| I-H19 | オーナーへの通知の失敗は `_lbNqOnFail` に積まれない（警告の未達が警告を呼ぶループを作らない） | `_lbPushOnce` 失敗時に `_lbNqOnFail` が呼ばれない |
| I-H20 | 点検・修理は同時に 1 本だけ。印は 35 分・段ごとに延長。ScriptLock は印を取る・放す瞬間だけ | 2 本同時に起動・印を持つ実行が段を進める間に別の実行が取れない |
| I-H21 | 副作用の直前に印の owner を確かめ、違えば止まる | 途中で印を書き換えて、以降の副作用が起きない |
| I-H22 | 壊れた印は期限切れとみなさず見送り、lease_broken を記録 | 壊れた JSON・NaN・遠い未来 |
| I-H23 | `checked` は段が例外なく終わった後にだけ付く | 段の途中で例外 |
| I-H24 | `check_id` と `LB_HEALTH_LAST` は同じ数／Nudge は DONE 未設定の間「途中で落ちた」を出さない | 正常完走で誤報しない・反映直後に誤報しない |
| I-H25 | 見送りは連続回数を数え、完走した点検が `health_skipped` を出してから 0 に戻す | 見送り 1 回の後の完走・保存に失敗したら 0 に戻さない |
| I-H26 | 印の owner は実行ごとに一意（check_id と別） | 同じ時刻に 2 本起動しても互いの印を消さない |
| I-H27 | 期限切れの印を持つ実行は、owner が一致しても副作用をしない／副作用の直前に期限内を確かめて延長 | 期限を過ぎた状態で owner だけ一致 |
| I-H28 | 手動・dry-run の点検も同じ印で排他する | 修理中に dry-run を起動しても走らない |
| I-H29 | lbSelfHeal は lbNudgeDaily の最後に相乗り。うながしの結果・送信に影響しない・自己修理の例外が漏れない（第6版） | `self-heal-nudge.test.js` |
| I-H30 | 確認は ok／busy／lost を分ける。副作用の直前は延長できたときだけ通す。延長しない続行は段の進行（読み取り）だけ・残り5分以上（第8版） | 毎回 busy が挟まっても完走・busy が続くと段は進むが副作用はしない・5分を切って副作用の直前に延長できなければしない |
| I-H31 | 修理の予算＝min(4分, 5分 − うながしの時間)。60秒未満なら no_time（第7版） | うながしが4分30秒・2分 |

検査は実 `LineBooking.js` を Node の vm で読み、`ScriptApp`・`PropertiesService`・`SpreadsheetApp`・`LockService` を身代わりにして**入口（`dailyHealthCheck` → `lbSelfHeal`）から**通す。実装を 1 行壊して落ちることを確かめる。

## 10. 顧客に何が出るか・個人情報
- 修理はトリガーを足す・空の記録シートを作るだけ。顧客には何も出ない
- 新しく作る要約・台帳・LINE 文面に氏名は出ない（H1）。既存の `health_status` とメールの detail には今までどおり入る（オーナーだけの場所）。部隊には要約だけを渡す

## 11. 反映と戻し方
- 反映：GAS 1 回（オーナー）。トリガーの設定は要らない（lbNudgeDaily に相乗り）。最初は practice
- practice を 1 週間見て、would_attempts の中身が正しければ CEO が作業依頼で `SELF_HEAL_MODE=on`
- 戻す：`SELF_HEAL_MODE=off`（即時・反映不要）

## 12. 確かめていないこと
- ~~`_lbPush` の opts~~ → 確認済み：積まない指定は無い。`_lbPushOnce` を直接使う（§7）
- ~~在籍の列~~ → ★第6版で訂正：ある（TR_COL.ACTIVE・5列目）。role=owner かつ active で判定
- `LB_HEAL_SCHEDULE` の検査は既存の setup* を身代わり ScriptApp で動かして突き合わせる（§3-1）。身代わりで setup* が通るか（`setupEdgeJobTrigger` の ping は身代わりの UrlFetchApp で返す）
- このアカウントの実行上限（6 分か 30 分か）。印の期限 35 分はどちらでも成り立つ
- 名前入り key のうちカレンダー系の詳細に顧客名が入るか（振り分け表の ○）

## 13. 実装で決めたこと（第5版から外れたところ・CEO 了承 2026-11-23）
1. **lbSelfHeal の起動**：第5版の「点検の30分後の専用トリガー」はやめ、lbNudgeDaily（10時）の最後に相乗り（§6・I-H29）。`setupSelfHealTrigger` は作らない
2. **edgeJobPoll は EDGE_JOB_ON≠'1' なら足さず skip_no_config（escalated）**。既存の `_edgeHealJobTrigger` と同じ条件。止めている状態を勝手に戻さない
3. **selfheal_stale に移行の猶予**：`LB_SELFHEAL_WATCH_FROM` から26時間は出さない（反映直後の誤報を防ぐ・Nudge と同じ作り）
4. **見送りの回数は 0 に戻さず「読んだ分だけ引く」**：点検が走っている間に起きた見送りを消さない（I-H25）
5. **表に無い key は「add した時の段」を台帳の stage 列に持ち、その段で閉じる**（子の点検の key が永久に unknown にならないため）。表にある key は LB_TRIAGE の段。LB_TRIAGE の段がソースの add の段と一致することを検査で固定
6. **gas-cancel-reason 11-7（cancel_notes と karte の近さの検査）に当たらないよう、LB_TRIAGE の並べ順を調整**（意味は無い）
7. **SELF_HEAL_MODE=off で通知（LINE・メール）も止める**。要約・台帳は off でも書く。通知は点検の最後に送る（lbSelfHeal で escalated になったものは翌日のまとめに載る）
8. **`LB_HEALTH_SINCE`＝key ごとの「いつから出ているか」(ms)**。A→B は P1 では B と同じく直さない
9. **LINE の文面は固定の文だけ（リンクは付けない）**
10. **関門②の差し戻し（第7版）**：§2-1 の第7版の段落・§3-1 の over_limit_after・§6 の予算・I-H30・I-H31
11. **関門②3回目（第8版）**：副作用の直前は `_lbLeaseOk`（延長できたときだけ）・段の進行は `_lbLeaseStep`（残り5分以上なら busy でも続ける）。通知の見送りは戻り値の `notified.code=deferred_lease`・`deferred` に出し、台帳の行は書かない（印が無い状態で書かないため）・SKIP に数えない

## 14. 改訂（第9版・2026-11-24）：空の台帳で初回から黙っていた
### 事実（確認済み）
- 本番 SS の `incidents` タブは**在るが完全に空**（見出しの行も無い）。2026-11-24 オーナーのスクショで確認
- `_lbIncRead` は `getLastRow()<1` で `header_mismatch` → `_lbIncReflect` が ok:false → `_lbHealthSave` が saved:false → **DONE を書かず通知もしない**。結果は Logger だけ。修理役は DONE を前提に動かない（I-H8）＝何もしない。見張りも同じ台帳・通知の経路なので鳴らない。Nudge の「途中で落ちた」は DONE が一度も書かれていない間は出さない（I-H24 の移行の猶予）＝これも黙る
- 従来の日次点検（health_status・悪化メール）は別経路で生きている
- 空のタブができた原因は**未確定**（手で作られたか、`insertSheet` の後の見出しの書き込みだけ落ちたか）

### 比べた手段
| 手段 | 採否 |
|---|---|
| ① オーナーに見出しを手で貼ってもらう | ✗ 次に同じことが起きても黙る（原因が未確定）。オーナー操作が増える |
| ② 空のタブを点検が自分で直す＋保存の失敗を既存の悪化メールに載せる＋CEO が読める | **採用**。GAS 反映1回（他の変更とまとめられる） |
| ③ 見出しが違う台帳も作り直す | ✗ 行の意味を変える（データ行があるかもしれない） |

### 直したこと
1. **空のタブを自分で直す（I-H32）**：`_lbIncRepairEmpty(sh, g)`。`getLastRow()<1` かつ `getLastColumn()<1` のときだけ、`_lbLeaseOk(g)` を確かめてから見出しを書く。1行でも中身がある・見出しが違うなら今どおり書かない。`header_repaired` を戻り値に出し、`LB_HEALTH_SAVE_LAST.repairs` に数える
2. **黙らない（I-H33）**：`_lbHealthSaveNote` が保存の結果を `LB_HEALTH_SAVE_LAST` に残す（newer と印を失った回は書かない＝見送りは LB_HEALTH_SKIP が health_skipped で知らせる）。次の点検の段「自己修理の見張り」が `_lbHealthSaveFailRead` で読み、`saved=false` かつ `DONE < その check_id` なら `heal_save_fail`（B）を add する＝従来の health_status と**悪化メール**に「自己修理の台帳に保存できませんでした（理由: …）」の1行が載る。悪化したときだけ知らせる既存の規則に従う（続いても1通）。理由は列挙 `LB_SAVE_WHY`＋other、壊れた記録は broken。オーナー宛のまとめ（`LB_OWNER_MSG`）にも足した
   - ★**知らせるのは失敗した翌日の点検**（悪化メールは保存より前に送る作り＝同じ回の保存の結果を載せられない。順序を変えると印・通知の不変条件 I-H21・I-H27 を作り直すことになるので変えない）
   - ★DONE と突き合わせるので、保存の結果を書けなかった回（延長できなかった）があっても古い失敗では鳴らない
3. **CEO が自分で読める（I-H34）**：作業依頼 `remaining {healStatus}`（`heal_status` も可）。**新しい op は足さない**（許可の一覧 3 箇所＝Worker・GAS・ワークフローは変えない。揃いは job-ops-drift.test.js）。`lbHealStatusText()` は読むだけで、要約（会員番号は件数だけ）・LB_HEALTH_DONE・LB_SELFHEAL_DONE・保存の結果・見送り・印（owner は出さない）・修理の関門・台帳の行（key・cls・stage・status・attempts・would_attempts・last_action・日時）を列挙と日時だけで返す。列挙に無い値は `?`。結果は `_ejScrub` も通す

### 判定できないとき
- 空かどうか分からない（中身がある）→ 書かない（header_mismatch のまま）＝翌日に heal_save_fail で知らせる
- 保存の記録が壊れている → broken で知らせる（0 とみなさない）

### 検査
`worker/test/self-heal-ledger.test.js`（入口 dailyHealthCheck・本物の `_ejRun('remaining', …)` から）。版の印 `LB_HEALTH_BUILD`＝2026-11-24a・`LB_JOB_BUILD`＝2026-11-24a

### 確かめていないこと
- 本番の空のタブで `getLastColumn()` が 0 を返すか（書式だけ・入力規則だけのセルがあると GAS は数えない見込み。数えた場合は直さずに heal_save_fail で知らせる側に倒れる）
- 空のタブができた原因

### 14-2. 関門②の指摘3件への直し（第10版・2026-11-24・GAS 版 2026-11-24b）
1. **保存失敗がまた黙る**：`_lbHealthSaveNote` が `_lbLeaseOk(g, true)`（noSkip）だったので、DONE を書いていない回に印の確認だけ失敗すると SKIP にも SAVE_LAST にも残らなかった。→ **saved:false の回は noSkip にしない**（延長できなければ LB_HEALTH_SKIP に数え、翌日 health_skipped が鳴る）。saved:true（DONE 済み）は今どおり noSkip。呼び出し側の catch は Logger に例外の型だけ残す
2. **壊れた未来の DONE が失敗を隠す**：`DONE >= check_id` だけで解除していた。→ DONE が有限・正・いま＋5分以下（`LB_HEAL.DONE_FUTURE_MS`）で、かつ `LB_HEALTH_STATUS.check_id === DONE`・`completed === true` のときだけ解除。DONE が数でない・0以下・未来なら broken で鳴らす。要約と合わないときは記録の理由のまま鳴らす
3. **見張りの段の例外が外に出ない**：catch が `_bad()` だけだった。→ 固定 key `selfheal_watch_fail`（B・warn・facts は exception・例外の文は出さない）を add（I-H35）。_done を付けない挙動は維持。印を失った例外（lbLeaseLost）は add せず外へ投げる（この段の中の WATCH_FROM の `_hcNeed` が投げた印の喪失を、いままで握りつぶしていた）
- 振り分け表 80→81 key。検査 `self-heal-ledger.test.js` I-H33-15〜22・I-H35

