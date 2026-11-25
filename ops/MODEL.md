# データの地図と不変条件（★設計を始める前に必ずここを読む）

> 2026-10-09・CEO玄
> **なぜこれを作ったか**：この日1日で、設計の差し戻し8回・実装の差し戻し7周・
> 指摘約50件（却下0）を出した。原因を分類すると**6割が「既にコードにある事実を
> 知らずに設計した」**ことだった。「不変条件」という言葉は12のファイルのコメントに
> 散在していて、1枚になっていなかった。だから毎回コードを読み直して発見していた。
>
> **この文書の役目は「設計を始める前に読むべき事実を1枚にすること」。**
> Codex にレビューを頼むときも、まずこれを渡す。

---

## 0. いちばん大事な1行

```
判定できないとき・確かめられないときは、**必ず「答えない」側へ倒す。**
答えないと、顧客の画面は写し（member_home）へ落ちる。遅いが正しい。
```
★これに反する実装は、どんなに他が正しくても通してはいけない。
　2026-10-09 に2回踏んだ（「印の無い行は読まれない＝安全」は成立せず、
　0行を「契約なし」と答えて**月額会員の残数が画面から消える**形だった）。

---

## 1. 真実はどこにあるか（いまの段階）

```
契約・予約の真実        Google側（スプレッドシートとカレンダー）
D1                      その写し ＋ D1で作った枠・引当
顧客に出る残数          ★全員 D1 から計算した値（2026-11-10〜・決定0149）
                          wrangler.toml：LB_D1_REMAIN_MODE="on" ＋ LB_D1_REMAIN_ALL="1"
                        ただし D1 が答えられないときは写し（member_home）へ落ちる
                          （I8 世代の不一致・I53 材料4つの回の不一致/45分以上・書き込み直後 ほか）
                        上書きするのは D1_OVERRIDE_FIELDS だけ（I36）。
                          振替権（transferCredits）など写しにしか無い値は写しのまま（§5）
```
- 段階3-b（読み取りをD1へ）の段階2まで済み。**正本はまだ Google 側**（D1 は Google の表から作った写しと、そこから計算した枠・引当）。
  正本の移行（段階3-c）は未着手（ROADMAP）。
- 切り替え後の様子（写しに落ちた回数・食い違い・both_fail）は **2026-11-11 の日次点検で確かめる予定＝この文書の更新時点で未確認**。
- 戻し方：`LB_D1_REMAIN_ALL` の行を消して push＝許可表の会員だけ D1／全員を写しへは mode を `shadow` に（決定0149）。
- **方針（未移行）**：契約の正本は D1 へ寄せる（決定0158・2026-11-11）。順序は予約の正本移行（段階3-c）の後。
  入力は画面→D1、シートは D1 から書き出す閲覧用にする想定。設計時に関門①。**いまの契約の正本はスプレッドシートのまま。**

---

## 2. 表の地図（誰が書くか・誰が読むか）

### 2-1. Googleからの写し（GASが押し出す・Workerは読むだけ）
| 表 | 主キー | 書くのは | 読むのは | 消える条件 |
|---|---|---|---|---|
| `customers` | customer_id | GAS（押し出し） | boot / compat | 完全同期で含まれなければ消える |
| `contracts` | contract_id | GAS | 承認待ちの数 | 同 |
| `reservations` | reservation_id | GAS（★`scope:'customer'` で会員ぶん入れ替え） | boot / compat / **当月の件数** | 同・会員ぶんは世代で入れ替え |
| `recurring_patterns` | pattern_id | GAS | compat | 同（`allowEmpty` を名乗れる唯一の表） |
| `trainers` | trainer_id | GAS | boot（★`kana`＝読みは k_aiDraft の伏せる処理と日次点検の数だけが読む・画面へ返さない・migration 0031） | 同 |
| `slots_cache` | trainer_id | GAS（10分ごと＋カレンダー同期が変更を見つけた直後・I74） | 空き枠 | `keepStale`＝消さない |
| `body_records` | record_id | GAS | 体組成 | `keepStale` |
| `member_home` | customer_id | GAS（計算した残数の写し） | ★`readHome`（4経路） | `keepStale` |

### 2-2. 残数の計算の入力（GASが押し出す／Workerが計算に使う）
| 表 | 主キー | 読むのは | ★世代を進めるか |
|---|---|---|---|
| `calc_contract_rows` | row_key | `loadCalcInput` | ✅ その会員 |
| `calc_reservation_rows` | row_key | 同 | ✅ その会員 |
| `member_opening` | customer_id | 同 | ✅ その会員 |
| `calc_meta` | key | 同（契約表の列の並び） | ✅ **全員** |
★この4つ以外の表が変わっても世代は進めない（進めすぎるとD1から答えられない）。

### 2-3. D1で作るもの（★Workerが書く）
| 表 | 主キー | 書くのは | 読むのは | 親子 |
|---|---|---|---|---|
| `monthly_quota` | (customer_id, month_key) | `quotaBuild`（UPSERT・lent／as_of_month も＝設計22）／**`used` はトリガーだけ** | 残数・照合 | 引当の親 |
| `ticket_packs` | pack_id | 同 | 同 | 引当の親 |
| `reservation_allocations` | reservation_id | `quotaBuild`（**消してから入れる**） | 超過の件数 | ↑2つを外部キーで参照 |
| `customer_sync_version` | customer_id | ingest（source・dirty・★`home_covers_seq`／`resv_covers_seq`＝写しが含む通し番号と `*_blocked_since`・設計45 migration 0034）／quotaBuild（built） | 鮮度の判定・★I79 の門 | — |
| `remain_shadow_slot` / `remain_shadow` / `remain_shadow_sample` | 設計12 | shadow | 心拍 | — |
| `write_shadow_log` / `write_shadow_stat` / `calendar_arrival_log` / `fresh_delay_log`（設計54 S1a・migration 0036） | n（GAS が作る8桁の乱数）／(day,key)／id | `/writeshadow`（GAS の送る段から・判定して記録）／calsync の差分（M2）／`/quota/rebuild`（M3）。★WRITE_SHADOW が厳密に "on" のときだけ書く | `/writeshadow/status`（日次点検・作業依頼）| 14日／30日で消す（status の呼び出しで1回50行まで）。★顧客ID・予約ID・予定ID・氏名の列が無い（I84） |

### 2-3b. 顧客カルテ（設計28・★Worker だけが書く・D1 が唯一の正本）
| 表 | 主キー | 書くのは | 読むのは | 備考 |
|---|---|---|---|---|
| `karte_profile` / `karte_safety` | customer_id | `k_saveProfile` / `k_saveSafety`（rev） | `k_summary` / `k_safety` | 安全面は同意の JOIN でだけ読む |
| `karte_consent` / `karte_consent_log` | (customer_id, kind) / id | `k_saveConsent`（撤回で safety を同じ batch で消す）・`m_saveConsent`（会員の health agreed・recorded_by '@member'） | 同意の判定（I48） | log は全ての状態の変化（rec_ai も・追記だけ）。kind の CHECK は 'health' だけ＝録音・AI は別の表 |
| `karte_consent_rec`（設計44） | customer_id | `m_saveConsent`（会員の agreed／revoked）・`k_saveConsent` kind:'rec_ai'（トレーナーは revoked だけ） | `k_aiDraft` の同意の関門（I76-8）・`k_summary`・`k_training` の aiConsent・起動の印 | 録音・AI の同意のいまの状態。state は agreed/revoked だけ・doc_ver＝同意した文面の版 |
| `karte_consent_answers`（設計44） | id | `m_saveConsent`（追記だけ） | `m_myConsent`（ask・健康情報の会員の版） | 会員が会員画面で答えた内容と版（agreed／declined／revoked）。declined はここにだけ。応答に出さない |
| `karte_consent_guard`（設計44） | （行は入らない） | 同意の状態の見張り | — | 制約 KARTE_GUARD_CSTATE → CONFLICT 409 |
| `karte_notes` / `karte_tr_sessions` / `karte_tr_sets` | TEXT の ID（Worker が作る） | `k_add*` / `k_edit*` / `k_delete*`（deleted_at）。★`k_editTraining`（設計58）は**置き換え**：1つの batch で新しい session を作り（顧客・作者・作成時刻は古い行から）、古い session を論理削除する＝前の版は論理削除した行として子の表ごと残る | `k_notes` / `k_training` | 1行1セット。論理削除された session は「削除」か「直す前の版」（karte_revisions の reason='edit'・before_json.replaced_by で見分ける） |
| `karte_member_notes` | mnote_id（Worker が作る） | `k_addTraining`（member・トレーニングと同じ batch）／`k_saveMemberNote`（3つの形・rev）／`k_deleteMemberNote`・`k_deleteTraining`（同じ session の枚を同じ batch で deleted_at）／`k_editTraining`（設計58：生きた枚を新しい session に付け替え・日付も合わせる・rev+1・updated_by＝直した人。中身は変えない） | `buildMemberKarte`（`c_myKarte`・`k_memberPreview`） | ★会員に見せる文だけ（社内メモと別の表・設計35）。session に1枚（部分 UNIQUE・生きた行）／session なしは NULL。顧客・日付は参照先の session と一致（見張り）。req_id 列は持たない |
| `karte_exercises` | name（前後の空白を落とした1〜50字） | `k_saveExercise`（追加・部位の変更・消した行の復活＝名前と部位だけ・後勝ち・rev なし・控えは karte_revisions の before_json に **part と deleted_at**（名前は row_id）） | `k_exercises`（★**表の生きた行だけ**・500件まで・入りきらなければ truncated。karte_tr_sets は読まない） | ★**全トレーナー・全顧客で共有**（顧客に結び付かない）。part は CHECK（chest/legs/back/shoulder/arm/core/other）・NOT NULL。karte_tr_sets.exercise（自由文）は変えない・読まない（既存の名前はその顧客の「最近の種目」にだけ出る）。生きた行は500まで（新しい名前・消した行の復活は EX_LIMIT 409） |
| `karte_tr_exercises` / `karte_tr_set_ext` / `karte_tr_drops` | (session_id, ord) / set_id（**INT NOT NULL PRIMARY KEY**＝rowid の別名にしない）/ (set_id, drop_seq) | `k_addTraining` と `k_editTraining`（設計58・同じ `trainingRows` で組む）だけ（本セットの INSERT の直後に `SELECT MAX(set_id) … WHERE session_id=?` で親を指す・同じ batch・最後に `G.trShape`） | `k_training`・`buildMemberKarte`（**生きた session の id を通してだけ**） | 設計38。種目の並び・数字の無い種目（done_only）・補助・無理やり・ドロップ。**既存の表に ALTER しない**（0029 は CREATE IF NOT EXISTS だけ）。ドロップは karte_tr_sets に置かない（古い読み手が本セットと数えない）。古い回は行が無い＝今までどおりの読み方。受付は `KARTE_TRAINING_EXT`（off／allow／on） |
| `karte_ai_usage` / `karte_ai_log` | day / id | `k_aiDraft`（設計39：usage は API の前に1文で数える・log は1回ごとに best effort） | 運用（1日の上限・倒れた回数と母数） | ★中身（文字起こし・AI の出力）・customer_id を入れる列を持たない（I76）。migration 0030 は CREATE IF NOT EXISTS だけ。`n_sets`（確かめたセット数・0032・以前の行は NULL）。★設計49：karte_ai_log の列は変えない（12列の INSERT のまま）。v2 の計測は別表 `karte_ai_log_v2`（0035・CREATE IF NOT EXISTS だけ＝既存の表に ALTER しない）。前日の結果別件数は `/quota/status?karteai=1` → GAS 日次点検「カルテのAI」 |
| `karte_revisions` | id | 編集・削除の前の中身（★`k_editTraining` は中身を入れず `{replaced_by, session_date}` だけ・reason='edit'＝中身は論理削除した古い行に残る） | 監査 | 安全面の中身は入れない |
| `karte_requests` / `body_requests` | (trainer,action,req) / (channel,req) | 書き込みと同じ batch | 二重送信の再送 | 成功だけ残る |
| `karte_rate` | (trainer_id, window_start) | 先行 batch | 回数制限 | 10分の区切りごと60回 |
| `karte_access_log` | id | best effort | 監査 | 中身を書かない・7種類の結果 |
| `karte_membership_events` | id | `k_recordMembership`（追記だけ・cancel は最後の1行） | 退会後3年の起算日 | 在籍の判定には使わない |
| `karte_guard` | （行は入らない） | 見張りの INSERT | — | 名前つき CHECK で batch 全体を巻き戻す |
| `body_measurements` / `body_goals` | id | `k_addMeasurement` / `/body/write`（d1）／`/body/freeze`（sheet・凍結から一度だけ） | `k_body` / `k_board` / `/body/series` | sheet の行は書き換えない |
| `body_freeze` | freeze_id | `/body/freeze`（frozen→copying→copied→verified／failed） | 読むのは verified だけ | — |
★`body_records`（2-1）は使わない（列が足りない・設計28で `body_measurements` に置き換え）。

### 2-3c. GAS のシート：キャンセルの記録（設計36・★D1 へは押し出さない）
| 表 | 主キー | 書くのは | 読むのは | 消える条件 |
|---|---|---|---|---|
| `cancel_notes` | res_id（1予約に1行） | `cancelReservationLine`（ロックの中で appendRow 1回・**すべての取消**＝会員・トレーナー・オーナー）／`_lbCnMaintain`（ロックの外・ひとことと識別子を空にする・notified を直す）／作るのは `setupCancelNotesSheet` だけ | オーナー（シート）／作業依頼 `remaining` の `cancelNotes`（件数だけ・COUNT_COLS）／日次点検（cancelled_at と note_purged_at だけ） | 行は消さない。ひとこと（note）は1年で空・res_id・customer_id・trainer_id は2年で空 |
| `notify_retry`（既存・設計17） | id | `_lbNqOnFail`／`_lbNqDefer`（キャンセルの時間予算を超えた残り・設計36／★設計45b の引き渡し＝id `'D'+待ちのid`・30分超は pending・期限切れの取り分けは alert） | `lbNotifyRetryTick` | ★設計36 から：終わった行（sent・stale・closed）の本文 text を30日で空にする（取り分けのロックと同じ1回の書き込み・1回50行まで）。行は消さない |

| Script Property `LB_NOTIFY_PENDING`（設計45b・既定オフ `LB_NOTIFY_DEFER`） | 項目の id（`q`+UUID） | `_lbNotifyHoldPersist`（要求の中・edgeAfterWrite の前・ScriptLock 3秒） | `_lbNotifyDeferRun`（一回限りトリガー `_lbCalSyncAfterWrite`・5分ごと `lbCalSyncTick` 90秒超・10分ごと `warmupCache` 5分超・日次点検は30分超の引き渡しだけ）／`_lbNotifyDeferFlushRes`（取消・変更の後に同じ予約の `booking_*` を捨てる） | ★**個人情報（LINE ID・氏名を含む本文・ひとこと）を持つ**。送る試みで消す／30分超は `notify_retry` へ引き渡して消す（日次点検も行う＝最長およそ1日）／壊れた値は書き換えず24時間後に日次点検が中身を出さずに消す。16件・8,000バイト（UTF-8）まで。ログ・点検・作業依頼には数だけ |
| Script Property `LB_WRITE_LOCK_COUNT`／`LB_EDGE_PUSH_COUNT`／`LB_LOCK_COUNT_BAD`（設計47） | 日（JST `yyyy-MM-dd`）→ op／kind | `_lbWlFlush`（要求の出口・ロックの外）／`_edgePushFlush`（押し出しのロックを放した後・作業依頼は `_ejPushFlush`）／`_lbLcMerge`（壊れた・大きすぎたら BAD に鍵・理由・時刻だけ） | 日次点検 `lbLockCountDailyCheck`・作業依頼 `remaining {writePerf:true}`（`lbLockCountText`） | 直近3日・UTF-8 8,000バイトを超えたら古い日から落とす。★数と固定の名前だけ（個人情報なし）・下限 |

| シート `booking_metrics` の6列目（設計54 S1a） | 行 | `_lbLogOutcome`（`_lbReserveCore` の1回ごとの appendRow に相乗り・`'ws1'`＋JSON・許可した鍵だけ・1,000文字以内）／送る側 `_lbWsRun`（顧客IDを消して `sent:1` か `stale:1` に書き換え・前後で1〜5列目と n を照合） | `_lbWsRun`（一回限りトリガー・5分ごとの同期の最後）・日次点検（母数と独立の検知） | 行は消さない。★顧客IDは送れたら・2時間で消す（スイッチ・保護に関係なく）。予約ID・予定ID・トレーナーID・時刻は残る（台帳と D1 に既にある識別子） |
| Script Property `LB_WS_ON`／`LB_WS_CURSOR`（送信カーソル）／`LB_WS_ERASE_CURSOR`（消去カーソル）／`LB_WS_STAT`／`LB_METRICS_WRITE_FAIL`（設計54 S1a） | — | 人（切替関数 `lbWriteShadowSetOn/Off`）／送る側（UserLock の中。カーソルは {row, k＝1列目の epoch ミリ秒}）／`_lbMetricsWriteFailNote`（booking_metrics に書けなかったときだけ・ロックなし） | 送る側・日次点検・作業依頼 `remaining {wsPrecheck}`・`{writeShadow}` | STAT は日の数を3日だけ。FAIL は日次点検が見た分を引く |
| `booking_metrics` のシートの保護（説明 `lb-write-shadow-v1`・設計54） | — | `setupMetricsProtection()`（作業依頼 `{wsProtect:'setup'}`・確かめられる範囲が通ったときだけ・冪等）／`_lbWsUnprotect()`（日次点検が書けなかった事実を見たとき・印つきだけ外す） | 送る側（保護が無ければ送らない）・日次点検 | — |
| シート `incidents`（自己修理 P1・案件台帳） | id＝`key@check_id` | `_lbIncReflect`（点検の最後・借りる印を持った1本だけ。★完全に空のタブなら `_lbIncRepairEmpty` が見出しを書いて使う＝I-H32）／`_lbSelfHealRun`（attempts・would_attempts・last_action・status）／`_lbHealNotify`（notify_*） | `lbSelfHeal`・CEO（部隊） | 消さない（fixed で閉じる） |
| Script Property `LB_HEALTH_LEASE`／`LB_HEALTH_SKIP`（自己修理 P1 §2-1） | — | `_lbLeaseAcquire`／`_lbLeaseCheck`／`_lbLeaseRelease`（ScriptLock 300ms の中だけ）／`_lbHealthSkipNote` | 点検・修理・lbNudgeDaily（壊れた印のメール） | 放す・期限35分 |
| Script Property `LB_HEALTH_STATUS`／`LB_HEALTH_SINCE`／`LB_HEALTH_DONE`（自己修理 P1 §4） | — | `_lbHealthSave`（点検の最後に1回） | `lbSelfHeal`（`check_id === DONE` のときだけ）・Nudge・監査 | 次の点検が上書き（古い check_id では上書きしない） |
| Script Property `LB_HEALTH_SAVE_LAST`（2026-11-24・I-H33） | — | `_lbHealthSaveNote`（dailyHealthCheck の最後・newer と印を失った回は書かない） | 次の点検（`_lbHealthSaveFailRead` → heal_save_fail）・作業依頼 `remaining {healStatus}`（I-H34） | 次の点検が上書き。★DONE ≥ check_id なら古い失敗とみなして鳴らさない |
| Script Property `SELF_HEAL_MODE`／`LB_SELFHEAL_LAST`／`LB_SELFHEAL_DONE` ほか | — | 人（モード・既定 practice）／`lbSelfHeal`（lbNudgeDaily の最後から） | 点検（selfheal_stale） | — |

- ★`cancel_notes.note_purged_at` は「ひとことが残っていない」印を兼ねる（ひとことが無い行は書いた時点で `-`）。だから点検と作業依頼は **note 列を一度も読まずに**「残っている行」を数えられる（I-C6）。
- ★**キャンセルした時刻は cancel_notes の `cancelled_at` にしか無い**（台帳にキャンセルの時刻の列は無い。当日消化のときだけ transfer_credits の付与時刻が実質の時刻）。設計37 の計測の土台。
- 見出し（14列・完全一致）：res_id, cancelled_at, start_at, trainer_id, customer_id, actor（customer／trainer／owner）, outcome（free／consumed／owner_free）, transfer, reason_key（work／family／condition／other／空）, trainer_reason（第2段・trainer_convenience／customer_proxy／空）, note, note_purged_at, notified（slot／slot+owner_trainer／none）, ids_purged_at

### 2-4. トリガー（★4本だけ。ここだけが `used` を動かす）
```
trg_alloc_consume_monthly   引当 INSERT → monthly_quota.used + units
trg_alloc_consume_pack      引当 INSERT → ticket_packs.used + units（ticket と pair の両方）
trg_alloc_return_monthly    引当 DELETE → used − units（used >= units のときだけ）
trg_alloc_return_pack       同
```
★`UPDATE monthly_quota SET built_version = …` はトリガーを引かない（INSERT/DELETE だけ）。

---

## 3. 不変条件の台帳（★守っている検査を必ず紐付ける）

| | 不変条件 | 守っている検査 |
|---|---|---|
| I1 | **`used` を動かすのはトリガーだけ。** アプリのSQLが `used` を書かない | `quota-route.test.js` ⑤／`quota-build.test.js` ④ |
| I2 | 枠・パックの UPSERT は `used` を更新しない（大きさだけ） | `quota-build.test.js` ④ |
| I3 | 枠と引当は**同じ batch**。片方だけ通る状態を作らない | `quota-route.test.js` ⑨ |
| I4 | 引当は「対象期間を全部消して入れ直す」。`OR IGNORE` にしない | `alloc-build` の検査 |
| I5 | 問題が1件でもあればその会員は**何も書かない** | `quota-route.test.js` |
| I6 | 行の世代印を外すのは batch の冒頭（同じ世代で作り直すと行が溜まる） | `quota-route.test.js` ⑨ |
| I7 | `dry=0` で書くなら `alloc=1` も必須（枠だけ作ると `used` が古い） | `quota-route.test.js` ⑨／`sync-version.test.js` ⑨ |
| I8 | 顧客に答えるのは `source_version === built_version && built_version > 0` のときだけ | `sync-version.test.js` |
| I9 | **読めた行数が記録と一致しないときは答えない** | `remain-from-d1.test.js` ⑫-c |
| I10 | 写しの形（鍵）はGASの `_lbBuildHome` と1対1。**ソースから機械で取り出して突き合わせる** | `remain-from-d1.test.js` ①／`remain-shadow.test.js` ① |
| I11 | shadow は顧客に返す値を変えない。例外を外に出さない | `remain-shadow.test.js` ⑫ |
| I12 | `member_home` の鮮度は**その行の計算時刻だけ**で見る（全体の同期時刻と混ぜない） | `boot.js` の★コメント／`ingest` の検査 |
| I13 | 全体の同期時刻（`sync_state`）を押すのは `scope:'all'` のときだけ | `ingest` の検査 |
| I14 | 0件で `final` を受けても消さない（`allowEmpty` は固定枠だけ） | `ingest` の検査 |
| I15 | 機密（合言葉）はGASだけが持つ。Workerの窓口は合言葉で守る | — |
| I16 | **世代の仕組みを既存データへ後付けするときは、最初の作り直しより前に基準世代（source>0 / built=0）を入れる。** 既存の 0/0 を取り残さず、すでに進んだ世代は上書きしない | `seed-sync-version.test.js` |
| I17 | **LINE通知の送り直しは、その予約IDの行が期待の状態（確定＝confirmed／変更＝新confirmed・旧changed／取消＝cancelled・consumed かつ取り直し無し）で、開始時刻前のときだけ。** 判定できなければ送らずオーナーへ（設計17） | `notify-retry.test.js` 2-6〜2-12 |
| I18 | 送り直しの失敗は再び積まない（tick は `_lbPushOnce` だけを使う）。通信例外・400番台・まとめ通知は送り直さない | `notify-retry.test.js` 1-5〜1-8・2-16 |
| I19 | LINEへ送っているあいだ ScriptLock を持たない（予約・取消・変更が同じロックを10秒待つ） | `notify-retry.test.js` 2-3 |
| I20 | 届かなかった通知が記録できないときは Script Properties に残し、送り直しが止まれば点検が high を出す | `notify-retry.test.js` 1-15・2-20・4-10 |
| I21 | **連続ルールの判定の正本は `_lbConsecVerdict`（BookingRules.js）の1つ。** 画面の枠（`_lbApplyConsecToSlots`）と確定（`_lbConsecCheckAt`）は同じ関数を呼ぶ（設計18） | `consec-rule.test.js`・`consec-slots.test.js`・`consec-gas-entry.test.js` 2 |
| I22 | `LB_CONSEC_RULE` が off/dry のとき、枠は**変更前のコードと順番まで同じ**（`consecOk` を1つも付けない） | `consec-slots.test.js` 1-1（ランダム500通り） |
| I23 | 顧客にだけ絞る。トレーナー・オーナーには全部の枠。写しへ送る処理は絞らない `_lbTrainerSlotsAll` だけを使う | `consec-gas-entry.test.js` 1・`consec-worker.test.js` 1-3, 3-8 |
| I24 | 写しのモードは「作った枠」と「いまのスイッチ」の表で決める。on なのに印の無い枠は顧客に出さない（Worker は _fallback、GAS は作り直し→だめなら失敗で答える） | `consec-worker.test.js` 1-5〜1-8, 3 |
| I25 | 連続ルールは顧客が自分で取る予約だけ（`consecRule`）。代行・自動予約・トレーナーが他人の予約を変える、には効かない | `consec-gas-entry.test.js` 3 |
| I26 | **shadow の配線の確認に使う入口は、LIFF から実際に届く入口と完全に一致する**（`CUSTOMER_ENTRIES`）。表の CHECK との照合は `ALL_CUSTOMER_SIDE_ENTRIES` で別に持つ。GAS は一覧を複製せず Worker の wiring の鍵を使う | `shadow-entry-check.test.js` 7a〜7d |
| I27 | 二重書きの溢れの「確かめ済み」を進めるのは、照合が `_edgeQuotaAllGood`（表示の全員一致と同じ関数）のときだけ。累計は照合の前に読む。dry では書かない | `gas-1017.test.js` ② |
| I28 | 作業依頼の結果と例外文は、報告の直前に必ず `_ejScrub` を通す（氏名＋様／名簿・台帳・契約の氏名／電話・メール・LINE ID） | `gas-1017.test.js` ① |
| I29 | カレンダーと台帳の突合は、進行中の予定を台帳の **confirmed** で救う（changed・cancelled・consumed は救わない＝残骸として出す）。カレンダー側で「開始済みを飛ばす」をしない | `gas-1017.test.js` ④ |
| I30 | 後追い処理は1名につき `/quota/rebuild` を1回。入力の入れ替え・作り直し・記録は1つの batch（設計20） | `rebuild-one.test.js` 2・4 |
| I31 | **新しいと名乗るのは `source===built && built>0 && built_covers_seq>=dirty_seq` のときだけ。定義は `worker/src/lib/fresh.js` の1か所**（読み取り・状態・修復の巡回・shadow が全部これを使う） | `rebuild-one.test.js` 3・6、`quota-behind-run.test.js` ③、`quota-verify.test.js` ①-c |
| I32 | 書き込みの通し番号（LB_DW_SEQ）は台帳を読む**前**に読み、取り置いたときの番号を rebuild に送る | GAS 側の検査（設計20 実装の後半） |
| I33 | `built_covers_seq` を上げるのは `/quota/rebuild` だけ。source の比較に通ったときだけ MAX で進める。通常の作り直しは変えない | `rebuild-one.test.js` 3-8・7 |
| I34 | 写しの送信の印（dirty_seq）は写しと同じ batch・MAX 更新。home・partial 以外では断る | `rebuild-one.test.js` 5 |
| I35 | D1 で上書きするのは mode 'on'・選ばれた会員（許可表が読めた）・写しがある・reviewRequired でない・D1 が ok・月が一致、の全部のときだけ（設計21） | `read-on.test.js` ①・②-4 |
| I36 | 上書きするのは D1_OVERRIDE_FIELDS（= COMPARE_FIELDS）だけ。写しの他の鍵（transferCredits 等）は残る。`_src`・`_packOverUse` は出ない | `read-on.test.js` ③、`home-fields.test.js` ③-b |
| I37 | mode が 'on' でない・選ばれていない会員の応答は変更前と1文字も同じ（remainSource も付けない） | `read-on.test.js` ② |
| I38 | 会員の選び方に ID を公開の場所へ書かない（許可表は D1・作業依頼は下4桁・検証用は完全一致） | `read-on.test.js` ⑦・①-13、`gas-1022.test.js` ④ |
| I39 | 出どころは選ばれた会員だけ数え、日×入口の**合計**で500まで（_dropped は日×入口で1回）。6つの入口は名前で数える | `read-on.test.js` ④ |
| I40 | 許可表の窓口は入力を厳しく検査し、実在の会員だけ足す。remove は判定と削除を1文で。応答・ログは下4桁だけ | `read-on.test.js` ⑤ |
| I41 | 書き込みの直後は写しと予約一覧の**両方**に通し番号を載せる（予約0件でも送る）。両方失敗した会員は記録して点検に出す | `read-on.test.js` ⑥、`gas-1022.test.js` ①〜③ |
| I42 | **月額の残り＝quota − used − lent**（lent＝翌月以降に前借りされた回数＝計算の carryForward）。used は引当トリガーだけが動かすので前借りが入らない。lent が NULL の limited 行からは答えない（0で埋めない） | `remain-from-d1.test.js` ⑳、`quota-build.test.js` 設計22、`quota-verify.test.js` ② |
| I43 | **D1 の月額行は「作った時点の月」（as_of_month）が今の月と同じときだけ答える**（計算は今の月で消化順と前借りが変わる）。翌月の行も同じ厳しさ。今の月でない会員は `/quota/behind` が返し巡回が作り直す | `remain-from-d1.test.js` ⑳、`quota-behind-run.test.js` ⑨ |
| I44 | **支払い待ちの正本は世代の行の `built_overage_json`（設計27）。** 作った範囲の全月を0も含めて書き、競合で世代を倒すと NULL。読む側は欠け・壊れ・月違い・範囲外・枠の行の overage との割れを全部「答えない」。二度読みで `built_rev`（作り直しのたびに+1）と JSON・範囲の生の値も比べる（同じ世代でも計算には今の時刻が入るため）。★この asOf の検査が**チケットだけの会員の月替わりの守りも兼ねる**（枠の行が無いと I43 が素通り）＝JSON を外すと穴が戻る | `remain-from-d1.test.js` ⑳-12b・㉑、`overage-in-sync-version.test.js` ①〜③ |
| I45 | 未割当を支払い待ちに数える規則は GAS `_lbOverageOf` と Worker `countsAsOverage` で同じ（理由が空か LB_OVERAGE_REASONS） | `overage-reasons.test.js` ③-b |
| I46 | **カルテ（k_）は trainer/owner だけ**（許可表）。入口で役割の鮮度（古ければ403）・停止スイッチ KARTE・書き込みの Origin 完全一致・トークンの iat 1時間（2026-11-06 決定0142 で10分→1時間＝当座。画面は59分で取り直す＝I62）・本文16KB（JSON を読む前）| `karte.test.js` 1-1〜1-11 |
| I47 | **閲覧の範囲は2つ**：共有（メモ・トレーニング・目標・安全面・体の記録）＝トレーナー全員／担当（契約・残数・一覧）＝担当＋担当なし・オーナー全員 | `karte.test.js` 1-3・2-10・3-4・4-1〜4-4・5-6 |
| I48 | **健康情報は同意の記録があるときだけ**書ける・読める（見張りと書く文の両方に条件・読みは JOIN）。撤回は同じ batch で中身を消す。履歴に中身を残さない。★文面は「写真も消す」と約束している＝写真の表・R2 を足したら撤回（会員・トレーナー両方）と掃除で消す（いまは写真の保存なし・2026-11-19 関門③） | `karte.test.js` 3-1〜3-10、`consent-photo-guard.test.js` |
| I49 | **書き込みは全部か無か**：回数は先行 batch（失敗の要求も数える）／本体は見張りの表の CHECK 違反で巻き戻す／二重送信は requests 表（成功だけ・同じ鍵の再送は保存した応答） | `karte.test.js` 2-2・2-3・8-1〜8-4、`body-d1.test.js` 2-3・2-7 |
| I50 | **体の記録の合成は GAS の maReadBody_／maReadGoal_ と同じ答え**（元のコードを vm で動かしてランダムに突き合わせる）。d1 の行はシートの行より後 | `body-d1.test.js` 1-1〜1-3 |
| I51 | **体の記録の新しい書き込みは凍結（body_freeze）の後だけ**。sheet の行は書き換えない（体脂肪率は d1 の行だけ・無ければ known_weight で作る）。読むのは verified の凍結＋d1 | `karte.test.js` 5-1〜5-6、`body-d1.test.js` 2-1・2-4〜2-6・3-1〜3-12 |
| I52 | 退会の起算日は追記だけの表。交互（withdrawn↔rejoined）・最後の行以降・cancel は最後の1行だけ・オーナーだけ・実在する今日以前の日付 | `karte.test.js` 7-1〜7-12 |
| I53 | **D1 から残数を答えるのは、計算の材料4つ（calcContracts・calcMeta・calcReservations・opening）の sync_state が同じ batchId で、45分未満のときだけ**。欠け・数でない・未来5分超・回の不一致・45分以上は写し（copy:calc_input_*）。会員ごとの作り直し（/quota/rebuild）は全体の印を押さない（設計30） | `read-on.test.js` ⑧-1〜⑧-6・⑧-e1〜⑧-e6 |
| I54 | **カルテの保存は、要求に鍵がある列だけを置き換える**（hearing・painMap・diagnosis と既存の列。null・空は消す、鍵が無ければそのまま）＝古い画面からの保存で新しい項目を消さない（設計31） | `karte.test.js` 10-3・10-9・10-20 |
| I55 | **健康情報は karte_safety にだけ置く**：変化の理由（REASONS）に健康の選択肢を入れない・知らない鍵は400。一覧の「注意あり」は同意の JOIN の中で SQL が決め、部位や強さは返さない。改訂の控えにヒアリングの自由文を入れない。**自由文（メモ・セットのメモ・ヒアリング）は健康情報を書く場所ではない＝入力欄の真下に「痛み・診断・服薬は『注意すること』へ」を置き、よく使うメモの選択肢に健康の言葉を入れない**（サーバーで意味は判定しない・設計31 確定事項2）（設計31） | `liff-karte.test.js` 14-8・14-10、`karte.test.js` 10-6・10-7・10-12・10-14・10-15・10-18、`liff-karte.test.js` 8-5・8-7 |
| I56 | **画面の固定表（目的・部位・痛み・タグ・理由）の鍵と表示名は Worker（lib/karte-hearing.js）と同じ** | `liff-karte.test.js` 7-1 |
| I57 | **トレーニングの記録は✓のセットだけ送る**（前回の呼び出し・複製・下書きの復元・**メモの取り込み（設計38）**でも✓の初期値は false。ドロップは本セットの✓に従う。数字の無い種目は「実施した」の✓があるときだけ送る）。合計60セットまで（画面と Worker の TOTAL_SETS）（設計33）。★回数が空のセットは送らない／重量の空は自重＝0（I61）。★設計49（2026-11-20）：AI の下書き v2 の1画面の確認から入るセットも ✓ は false（reviewBuild が done:false で組む）。AI の要確認から入ったセットの出所の印 `src`／`srcEdited`（設計50 で種目名を変えた種目の `srcRenamed` を足した）は**記録の下書きにだけ**置き、保存する直前まで画面に出す。保存の payload（buildPayload の許可した鍵）・「＋ セット」の複製・写すには持ち越さない。★設計53（2026-11-23）：種目の並べ替えは記録の下書きの配列の順を入れ替えるだけ（✓・src はその種目の要素に付いたまま動く）。送った items の順が karte_tr_exercises.ord になる。送信中・結果待ちは並べ替えない・保存の入口で動かしている途中のドラッグを捨てる。★設計58（2026-11-25）：**保存した記録を直す画面は記録済みのセットを ✓ 済みで開く**（I57 の例外＝I89。false で開くと、そのまま保存しただけで全セットが消える） | `liff-karte-ai-review.test.js` R9・R13・R19、`liff-karte.test.js` 10-1・10-5・10-6・10-9、`karte.test.js` 11-2、`liff-karte-reorder.test.js` S2・S4・S11、`karte-training-ext.test.js` S5、`liff-karte-training-edit.test.js` L22 |
| I58 | **トレーニングの下書きは localStorage（トレーナー×顧客）が正本**。氏名を入れない・24時間で実際に消す・中身の顧客が違えば戻さない。送ったが結果が分からないときは中身と clientReqId を固定し、同じ組でだけ送り直す。トークン切れの退避（sessionStorage）に中身を入れない（設計33） | `liff-karte.test.js` 10-7・10-8・10-10〜10-12・10-14〜10-17 |
| I59 | **「前回」は入力中の日付より前の、session_id 単位の直近1回**（同じ日の2回を混ぜない・直近20回の中だけ）（設計33） | `liff-karte.test.js` 10-2・10-3 |
| I60 | **種目の一覧（karte_exercises）は全員で共有し、書くのは `k_saveExercise` だけ**（名前と部位だけ・知らない鍵は400・名前は前後の空白を落とした1〜50字＝画面と同じ正規化・isKarteWrite に当たる＝I46/I49 の守り）。**読みは表の生きた行だけ**（記録の自由文 karte_tr_sets は読まない＝走査の負荷と、自由文の個人・健康の情報を顧客と切り離して全員に並べないため・CEO 決定）。500件まで・切れたら truncated（画面は「一部だけ表示・見つからなければ名前を入力」）。**生きた行は500まで**：事前の検査も batch の見張りも「同名の生きた行が無い、かつ生きた行が500以上」で止める（消した行の復活も数える）。**部位の鍵は画面（PART_KEYS）＝ Worker（lib/karte-exercises.js の EXERCISE_PARTS）＝ 表の CHECK**。画面の部位は「一覧の部位 → 無ければ名前からの推定」。その顧客の「最近の種目」から選んだ名前が一覧に無ければ、その場で部位を選んで登録できる（任意・ダイアログなし）。種目名は健康の言葉を書く場所ではない（I55・注記） | `karte-exercises.test.js` E1-1〜E1-5・E2-1〜E2-3・E3-1〜E3-4・E4-1〜E4-9・E5-1〜E5-6・E6-1〜E6-4、`liff-karte-exercises.test.js` P0-1・P1-1〜P8-2 |
| I61 | **自重は重量0で保存する**：画面は重量が空の✓を 0 で送る（回数が空は送らない・「記録されない入力」に重量の空を数えない）。表示は 0 を「自重」（トレーナーの記録・見る側・写す画面・会員の画面 4言語）。写す・前回の値では 0 を空に戻す。D1 の weight_kg は作り直さない（0 は CHECK を通る） | `karte-exercises.test.js` E7-1〜E7-4、`liff-karte-exercises.test.js` B1-1〜B3-2、`liff-member-karte.test.js` 9-1・9-2 |
| I62 | **カルテの書き込みは送る前にトークンの発行時刻を見る**：59分（TOKEN_REFRESH_S=3540・決定0142）を超えていたら送らずに、入力を端末に退避 → 読み直し（`liff.logout()` は LINE アプリの外＝isInClient()===false のときだけ。アプリの中で logout すると最初のページに戻った）。401 が返った経路も同じ。**入力のあるフォームは全部、読み直し後に同じ画面・同じカードで戻す**（トレーニング・お客様の欄・指導メモは下書き、ヒアリング・測定・メモ・振り返り・目標線・退会の発効日・お客様の見え方の編集・種目の登録/部位を直す途中は sessionStorage の退避。戻すのは退避の顧客＝開く顧客のときだけ・**氏名を残さない**・30分を過ぎた退避は次の起動で捨てる・読んだら消す。安全面（健康情報）は退避しない＝I48）。読み直しの印（sessionStorage `karte_reauth`・時刻）は 0≦経過<10分のときだけ効き、未来の時刻は消す。**新しいトークンで書けたときに消す**。印が効く間は画面で判定せず送り、また 401 なら読み直さず「LINE から開き直して」（無限に読み直さない）。Worker の上限は1時間（I46・決定0142） | `liff-karte-exercises.test.js` S1-1〜S12-1、`liff-member-karte.test.js` 8b-1〜8b-6、`liff-karte.test.js` 4-1〜4-5 |
| I63 | **メモの原文と決定待ちは端末のメモリの中だけ**：localStorage／sessionStorage に入れない・console に出さない。★**設計51（2026-11-23・CEO 裁定）で一部を改めた**：AI の振り分けの確認（設計50 の rv）の途中だけは、記録の下書きに入る種類の情報（種目名・1行・AI の判定の状態と数字・欄の文章〔trial は範囲内だけ〕・お客様の欄）に限り、`karte_ai_review_v1:<トレーナー>:<お客様>` に当日中かつ24時間以内だけ一時保存してよい。体のことの言葉を含む行と種目（名前・1行に当たれば種目ごと）・健康由来のセットの状態・根拠・迷い・聞こえた言葉・体のこと・分からなかった点・原文は保存しない。原文の代わりに、200字以上のときだけトレーナーとお客様を前置きにした SHA-256 のしるしを保存し、完全一致なら送らずに保存から出す。壊れた・版や持ち主や範囲が違う保存は使わずに消して1行で知らせる。物理削除は起動・トレーニングを開く・保存の時。記録の画面に入れたら消す。「読み取る」は何も送らない（設計38）。★設計39（2026-11-12）：**送るのは I76 の条件を全部満たした「AIで振り分ける」の1回だけ**（k_aiDraft・切替が開いたトレーナーにだけボタンが出る）。再認証・時間切れ・画面の移動でも原文を保存領域へ退避しない（トークンが古ければ送らず読み直さない）。★設計48（2026-11-20）：**文字起こしのファイルの添付も端末の中だけ**（FileReader で読んで貼り付け欄に入れる・fetch しない・中身もファイル名も保存領域・console に出さない・読んでいる途中に選び直した／画面を離れた／別の顧客なら捨てる）。音声・.docx 等は読まない。3万字（`AI_TEXT_MAX`）・1MB を超えたら切らずに入れない。★設計49 段階0（2026-11-20）：「読み取る」の結果が文字起こしらしい（3,000字以上・種目とセットになった行が1割未満・決定待ち40件超の全部）ときは、1件ずつのカードの前に案内と AI のボタンが出ない理由を出す。**止めない**（「それでも1件ずつ確認する」で今のカード）。添付の見出しの行は許可リスト `ATT_HEADER_LINES`（実物を確かめるまで空）の完全一致・先頭3行だけ落とす | `liff-memo-parse.test.js` P0、`liff-karte-transcript-guide.test.js` G1〜G4、`liff-karte-import.test.js` M1・M17、`liff-karte-ai.test.js` L2-1・L2-14・L3-3・L3-9、`liff-karte-attach.test.js` T2-5・T2-6・T5・T6・T9・T10、`liff-karte-ai-resume.test.js` U1〜U13・P1〜P2 |
| I64 | **読み取れない行を黙って捨てない・黙って数値にしない**：文法に合わない・2つ目の日付以降・実在しない/未来の日付・種目の無い数値・上限超え・行の残り・0.1 刻みでない小数・×の無い形・`50×10×3`・`20回`・`60秒` は決定待ちにし、トレーナーが選ぶまで記録の画面に入れない（設計38）。★設計40（2026-11-09）：数値の直後のかな・漢字は区切り（20×10トップで…）だが、**単位・構造の語（キロ・秒・分・セット・回・目・ずつ 等）で始まるならセット全体を読まない**。重さ無しの ×N は直後が空白・行末・＋・括弧・区切りのときだけ（×8クリアは読まない）。**箇条書き・名前の行の後は sealed**＝続く数値行を直前の種目に足さず item の無い line にする（次の種目か名前の決定待ちで解ける）。★設計41（2026-11-10）：**新しく数値にする規則（R2 チューブ・R4 括弧・R5 自重・R7 ×Nずつ M種類・R8 左右同じ・R10 話した数値）は items に直接入れず、下見つきの決定待ち（propose 'addset'／'parenset'）にして計画の一覧を通す**。セットは読んだ順の通し番号 sq で持ち、組み立て（assemble）で sq の順に並べ直す。セットのメモの宛先も sq（setSq）。足すと上限（1種目10・合計60）を超えるものは計画に入れず、カードでも決めない。決めた後に入らないものがあれば取り込み全体を止める（黙って落とさない）。R10 は1行に1組だけ・後ろは決まった言い方だけ・漢数字は読まない。R9（次・次回）は R10 より先にメモの提案 | `liff-memo-parse.test.js` P1〜P63・P64〜P89・P90〜P111、`liff-karte-import.test.js` M2・M25・M26 |
| I65 | **migration 0029 は新しい表を作るだけ**（CREATE … IF NOT EXISTS・既存の表に ALTER しない）＝途中で失敗しても、記録が残らなくても、次の実行で同じファイルがそのまま通る（設計38） | `karte-training-ext.test.js` T1・T1b・T1c |
| I65b | **トレーニングの1回の形**：種目は ord 1〜20 の連続（数字の無い種目＝done_only=1・本セット0）／本セットは ord ごとに set_no 1〜10 の連続／ドロップは drop_seq 1〜3 の連続（別の表）／合計60（ドロップを数える）／補助は1〜100で回数に足さない／知らない鍵は400（古い形の要求にも）／doneOnly とセットの両方は400。自己矛盾は trShape（Worker が数えた数との照合を含む）で batch ごと戻す（設計38） | `karte-training-ext.test.js` T2〜T20・T16c |
| I66 | **自己ベスト・種目別推移・推定1RM は本セットかつ無理やりでない行だけ（種目名ごと）**。回数は自分の回数。日別・写す・前回は ord ごと。トレーナーの前回の値には無理やりも印つきで出す（設計38） | `karte-training-ext.test.js` T21〜T24、`liff-karte-import.test.js` M10〜M12・M20、`member-karte.test.js` 38-14-1〜38-14-3b |
| I67 | **会員の応答に無理やりのセットを出さない**（オーナー確定 2026-11-06）。SELECT 句に forced を書かない（WHERE・JOIN の条件にだけ）。無理やりの本セットの下のドロップ・全部が無理やりの種目も出さない。補助・ドロップ・数字の無い種目は出す（設計38） | `member-karte.test.js` 38-14-4〜38-14-7 |
| I68 | **新しい鍵（doneOnly・assist・forced・drops）を使う保存は、すべての送信経路で毎回 karteSchema>=33 を確かめる**（payload の中身＝鍵があるかで判定）。使わない保存は32以上で送れる。印の無い鍵は送らない（null・空配列で送らない）（設計38） | `liff-karte-import.test.js` M13〜M19 |
| I69 | **旧ハッシュで一致させるのは、新しい鍵を使わず、同じ種目名が2つ以上の種目に無い要求だけ**。それ以外の不一致は 409（設計38） | `karte-training-ext.test.js` T25〜T27b |
| I70 | **3つの表は生きた session の id を通してだけ読む**。k_exercises は karte_tr_exercises を読まない（I60）（設計38） | `karte-training-ext.test.js` T28・T29、`karte-exercises.test.js` E5-7 |
| I71 | **取り込みは健康の言葉を自動でどこにも入れない**（I55）：自動で種目にするのは autoKnown（固定の EXERCISES ＋ 共有の種目の生きた行）と完全一致した名前だけ。この方の最近の種目は候補として押させるだけ（押しても名前の欄に仮に入るだけ）。括弧書きで構造にするのは無理やりの確定語だけ。それ以外はトレーナーが選ぶまで保存しない（設計38）。★種目の下の自由文は「直前の種目の1セット目のメモにする」を選べる（2026-11-08）：宛先は直前の種目か、直前の名前の決定待ちを「種目にした」ときはその種目。前が決まらない・選び直したら宛先を出さない／外す（別の種目へ入れない）。セットが無い・200字を超えるなら種目名を付けて社内メモへ（切らない）。set note は会員に出さない。★設計40（2026-11-09）：自由文に**提案**（そのセットのメモ／種目のメモ／捨てる）を付け、「提案どおりに決める（N件）」→ 全件の原文と行き先を画面内に並べる →「この内容で決める」を押したときだけ決める（開いただけでは dec を変えない・計画は dec の写しで作る）。**健康の言葉（MEMO_HEALTH）・名前らしい印（敬称・回目・初回・体験）を含む文には提案を付けない**（1件ずつ）。行頭の漢字・カタカナ＋敬称の行は提案「捨てる」で、計画には名前の部分を〇〇にして出す。下に数値が続く名前には提案しない。一覧で拾えない健康の文・文中の氏名は、計画に原文で出る（トレーナーが閉じて選び直せる）＝1件ずつ選ぶのと同じ判断として受け入れた（関門①）。★設計41：**新しい規則（R2〜R10）は、行全体に健康の言葉・名前らしい印があれば当てない**（数字も読まない）。既存の G 規則は、同じ行の重さと回数は読み、健康の文だけ提案なしの1件ずつ（設計40 の振る舞いを維持＝新旧で扱いが違う・設計41 改訂3 J）。R3（行の途中の種目名）は一括の計画に入れず、カードで選ぶ。★設計39：AI の下書きも同じ＝autoKnown と完全一致した種目だけ items、セットは全部 addset の決定待ち（根拠の抜き出しを計画とカードに出す）。一致しない名前は sets を持たない name＋その後ろの rule（名前を種目にしたときだけ足せる）。**お客様へ・次回までに・体の状態・確かめられない数字は計画に入れない**（お客様へ・次回までには1件ずつ・体の状態は捨てるだけ）。AI の決定待ちに許す決定は表で決め、表に無い組み合わせは取り込み全体を止める。★**設計49 v2（2026-11-20）**：v2 の応答（draft.v===2）は1件ずつのカードではなく1画面の確認（`aiReview`）で決める。状態は純粋なデータ（セットの `sourceStatus` は応答から1回だけ作り以後変えない・トレーナーの操作は `resolution`＝unresolved／confirmed／edited／excluded）。下書きへ入れるのは**最後のボタン（画面に並んだ採用中の全項目を一括で承認する明示の操作・直上に区分ごとの採用件数）の1回だけ**（既存の commit()）。含めてよいのは match（confirmed・edited）／inferred・nobasis（confirmed・edited）／healthHidden（edited だけ）で、種目名が決まった種目だけ。種目名を選び直したら配下は match も含めて unresolved。**移してよい範囲は画面の定数 `AI_V2_SAVE_SCOPE`（既定 'trial'・不正値も trial）と `scopeAllows` の1か所で決め、表示と reviewBuild が同じ関数を見る**。trial（D8 が決まるまで）は v1 と同じ範囲（match のセット・種目・種目とセットの備考・指導・ヒアリング・お客様の欄）だけで、要約・状態・次回やること・要確認の点・inferred／nobasis／healthHidden の数字は見るだけ（初期値で include を立てない・立てて渡すと投げる）。健康語の行・体の状態は入れる操作が無い。名前の印の行は初期値で外す（押せば入る）。人名・〔人〕では止めない（オーナー判断）。根拠（evidence）は表示だけで下書きに入れない。社内メモ2,000字を超えるなら入れない（切らない）。★**設計50（2026-11-23・上の v2 の確認の画面を置き換えた）**：1件ずつの入れる／入れない・セットごとの確定（resolution）をやめ、**種目は1種目＝1枚の1行の文字**（「読み取る」の memoSets で読む・`?` を含むかたまりは入れない・読めない書き方があれば押せない）、**ほかは欄ごとの文章**（今日の流れ・状態・次回やること＝full だけ・指導・ヒアリング・種目のメモ＝1行1項目・社内メモへ・空の欄は入れない）。最後のボタン（画面に見えている1行と欄の全部を一括で承認する明示の操作）の1回だけ下書きに書く（commit()・reviewBuild の出力の形は設計49 と同じ）。**推測・根拠なしの数字も1行に入っていれば入る**（設計49 D2 を改めた・CEO 裁定 2026-11-23）＝押す前に下の帯へ「推測 N・根拠なし N を含む」、記録の画面では✓が外れたまま推／！の印。色（出所）は値の並びを LCS で照合し、**どの最長の対応にも入る1組だけ**元の状態を引き継ぐ（それ以外は「直した」で、その種目の最も強い警告〔根拠なし＞推測＞健康〕を src に残す・一致に昇格させない）。種目名を元から変えた種目は全セットを「直した（種目名を変更）」＝`srcRenamed`。一覧に無い種目名は部位を選ぶまで押せない（名前を変えたら選び直し）。「入れない」にするのは純粋な `?` の形（`?`・`N×?`・`×?`・`?×N`・`?×?`）だけで、`?` と一緒に文字を書いた塊は読めない（押せない）。セットの行も健康語を見る。**お客様に見える欄は既定オフのチェック**（reviewBuild も `member.on === true` を見直す）。体のこと（caution）・AI が分からなかった点（unclear）は読むだけ。名前・欄・種目のメモ・（オンのとき）お客様の欄に健康語の行があれば押せない。名前の印の行を初期値で外す扱いはやめた（CEO 裁定）。`AI_SCOPE.full` に next を足した（trial には足さない）。★**設計52（2026-11-23）**：一覧に無い種目名でも止めない（部位は推定を既定・タップで直せる・その他でも止める理由にしない）。記録の画面への regPart は推定か選んだ部位で、名前らしい印（MEMO_PII_WEAK）の名前には付けず、記録の画面でも登録の欄を出さない（共有の一覧への登録は今どおり任意＝I60）。AI の名前が固定の表の**別名に完全一致**したときだけ正式名へ置き換え、元の種目名も正式名にする（S-H5 の明示の例外。別名は「その種目だけを指す語」だけ・広い語は EX_HINTS＝もしかしての候補止まり）。もしかしての置き換えは種目名の変更＝srcRenamed。固定の表（EXERCISE_TABLE・85種目）が autoKnown に入るので「読み取る」で自動で種目になる名前も増える（規則は完全一致のまま） | `liff-karte-ai-review.test.js` T1〜T12・R0・R2・R10・R16、`liff-memo-parse.test.js` P52〜P61・P78〜P89・P98〜P102・P111、`liff-karte-import.test.js` M21・M24・M25・M26、`member-karte.test.js` 6-6、`liff-karte-ai.test.js` L2-3〜L2-9・L3-7・L3-8、`liff-karte-exercise-names.test.js` N1〜N11 |
| I72 | **新しい鍵の受付はサーバーの切替 KARTE_TRAINING_EXT で決める**：厳密に 'on'、または 'allow' で KARTE_TRAINING_EXT_TRAINERS に trainer_id が完全一致のときだけ受け付けて karteSchema 33。それ以外は新しい鍵を含む k_addTraining を何も書かずに 409 TRAINING_EXT_OFF・karteSchema 32。旧形は切替に関わらず保存。replay は切替の判定より先。一覧に氏名を書かない。止める手段に古い Worker への巻き戻しを使わない（設計38） | `karte-training-ext.test.js` T30〜T35、`liff-karte-import.test.js` M23 |
| I73 | **公開リポジトリに実在の人の氏名・電話番号を書かない。** 「〇〇様」は許可リスト（ダミー・架空・トレーナーの姓・一般語）に無ければ落とす。実例は「会員A」、テストは架空の名前（甲野一郎 等）。日付＋時刻＋人で特定できる書き方をしない（決定0164） | `no-real-names.test.js` 1-1・1-2 |
| I74 | **カレンダー同期が patched / published を返したときだけ、同じ実行の後ろで空き枠を押し出す（設計42）**：unchanged・知らない mode・失敗では押し出さない。新しいトリガーを作らない（上限20本）。予約直後は 同期→二重書き→掃除→押し出し の順（速い道を待たせない）。送り終えた実測の当日合計（JST）が30分（目標予算・厳密な上限ではない）に達したら呼ばない。予約直後の実行から5分ごとのトリガーが見えなければ（別のユーザー）止める。記録は固定のコード・時刻・ミリ秒だけ。止まったら日次点検（配線の印・昨日の件数・記録の異常）が鳴る | `calslots-onchange.test.js` ①〜⑥ |
| I75 | **push で外に出る履歴に、個人情報・鍵の形を入れない。** push するコミット1つずつの「足した行」と説明文を、作業ツリーの検査と同じ検出器（`worker/test/pii-detect.mjs`・許可リスト方式）で見て、見つけたら止める。値は出さない。判定できないときも止める。pre-push（`ops/cloud-setup.sh` がつなぐ）が先、PR の検査（`ops/workflows/pii-scan.yml`・検出器は base の版）が後ろの網（決定0167） | `prepush-scan.test.js` 1〜9・`no-real-names.test.js` 0-7〜0-11・1-3〜1-5 |
| I76 | **録音の文字起こしの AI 下書き（設計39・k_aiDraft）**：①明示の操作でだけ送り、送り先は Worker と Anthropic だけ。Origin・ID トークン・iat・役割の鮮度・許可表・共有の範囲・切替 `KARTE_AI_DRAFT`（厳密に on／allow＋`KARTE_AI_DRAFT_TRAINERS`・既定 off）・鍵 `ANTHROPIC_API_KEY`・1日の回数（`karte_ai_usage` を API の前に1文で数え changes===1 だけ成功）が全部通ったときだけ外へ送る。切替・鍵が無ければ 503 AI_NOT_CONFIGURED で送らず数えない。本文は `/karte/ai-draft` だけ128KB・パスと action の組は両方向 （★設計51：⑥の「保存しない」は記録〔D1〕への保存のこと。確認の途中の端末への一時保存は I63 の設計51 の段落の範囲で行い、記録ではない）②（★設計50：「お客様」「お客さん」〔「お」が前に付く形だけ〕は第三者名の式で伏せない。ほかの伏せ方は変えない）送る前に会員の氏名（漢字・かな・カナ）・トレーナーの氏名（漢字・英字）・敬称つきの名前（漢字・カナ・ひらがな）・電話・メールを伏せる（known も）。★トレーナーの読み（かな）は `trainers.kana`（GAS の名簿 trainer_master の1行目の見出しが kana の列・G 以降だけ・かな/長音/中黒/空白で1〜40字だけ＝GAS `_edgeTrainerKana` と Worker `isKanaName` が同じ判定）があるときだけ伏せる。列が無い・空・かな以外のトレーナー（日次点検に未登録の数が出る・切替が開いていれば warn）・敬称なしの第三者名・聞き違えた名前・漢数字の電話は残り得る＝画面の案内に明記し、同意の文面に含める。短い読みは同じ並びを全部伏せる（伏せすぎる向き・数字は消えない）（設計39 関門② 2周目・続き 2026-11-12） ③**文字起こし・伏せた文・Anthropic の生の応答を D1・KV・console・エラー文・応答に残さない**。返すのは検証・再マスクした draft だけ（no-store）。ハンドラは全例外を固定コードに変え、index.js も k_aiDraft の message を出さない。記録（`karte_ai_log`）は回数・時間・文字数・トークン・モデル・結果・版の印だけ（失敗も）。runWrite を通らない＝karte_requests に入らない ④セットは根拠の抜き出しが伏せた文字起こしに在り、重さ（0.1刻み・丸めない）と回数がその中の数値のトークンと完全一致するものだけ（自重は明示語のときだけ）。それ以外は unverified ⑤健康語（画面の MEMO_HEALTH と同じ式）の文は元の場所から消して caution へ（根拠の抜き出しに健康語があるセットは確かめたセットにしない）・移した後20件を超えたら AI_BAD_OUTPUT。画面も ai・aiunv・rule の健康語の文は捨てるだけ ⑥**AI の出力は保存しない**＝取り込みの確認フローでトレーナーが決めたものだけが下書きに入る（I71） ⑦**お客様の同意（録音・AI・国外の事業者・全文を残さない）と Anthropic の契約条件の確認が decisions に記録されるまで allow/on にしない** ⑧**会員ごとの同意（設計44）**：共有の範囲の後・1日の回数の前に `karte_consent_rec` を読み、agreed かつ doc_ver が `CONSENT_VALID_REC` にあるときだけ送る。無い・撤回・古い版は 403 NO_CONSENT、読めなければ 503 AI_UNAVAILABLE（CONSENT）＝どちらも送らない・数えない。この2つは karte_ai_log の CHECK に無い＝access_log（no_consent／error）にだけ残し、日次点検は access_log から noConsent を数える。画面の aiConsent は補助で、関門はサーバーだけ。★**設計49 v2（2026-11-20）**：(1) 使う形式は `KARTE_AI_FORMAT` が厳密に 'v2' **かつ**要求の `client_ai_format` が数値の 2 のときだけ v2（旧画面は v1 を受け取る）。設定は未設定・空＝v1／'v1'・'v2' の厳密一致／それ以外は閉じる（503 FORMAT・送らない・数えない・起動の印 aiDraft も偽）。考える量は `KARTE_AI_EFFORT`（'low'／'medium' の厳密一致・それ以外は low・v2 だけ） (2) v2 は Anthropic からストリーミングで受け、message_stop の後に1回だけ parse・検証（累積512KB・20,000件・1イベント64KB・UTF-8 は stream:true で fatal・イベントの順序の外れ・stop の後のデータは AI_BAD_OUTPUT・error は許可リストの語だけ）。Worker の締切 90秒。SSE のイベント・差分・考えの差分を D1・KV・console・応答に残さない (3) ④を改める（★設計50 2026-11-23 で分類を正した：nobasis は**根拠が見つからないときだけ**・根拠が在れば数字が欠けても inferred で、inferred が返す数字は**見つかった根拠の中に数字として在るもの**だけ〔例外：根拠に繰り返しの言葉があり同じ種目の直前のセットと同じ値〕・根拠は空白と句読点の違いだけ無視して探し、詰めて6字以上・見つかった位置の前後の文〔±40字・。！？改行で止める〕に健康語があれば healthHidden〔同じ根拠が何か所にもあれば全部の位置で見る・健康語の当たり位置と区切りは1回の要求につき1回だけ数え、位置は indexOf で順にたどり二分探索で見る＝3万字×60セットでも CPU の上限に届かない・打ち切って安全側を外さない〕・自重は形の `bodyweight` で返し応答に `bw`＝w が null で bw が偽は重さ不明・inferred の bw は根拠に自重の言葉〔BODYWEIGHT〕があるか繰り返し＋直前のセットが自重のときだけ・unclear の根拠は文字起こしに見つかったときだけ返す〔関門② 2026-11-23〕）：セットは Worker が4つに分ける＝match（今の verifySet が通り basis が said・unsure が空）／inferred（根拠は伏せた文字起こしに在るが数字が根拠に無い等・数字は返す）／nobasis（根拠が無い・数字は範囲内なら返す）／healthHidden（根拠か unsure に健康語・**w/r は null・evidence/unsure は空**） (4) ⑤の対象を全自由文（要約・状態・次回・指導・ヒアリング・要確認の点の文と根拠・種目とセットの備考・unsure・お客様の欄）に広げる。caution は AI 直接20件・移した後30件まで（超えたら AI_BAD_OUTPUT・切らない）。人名で採用は止めない（オーナー判断 2026-11-20）＝伏せるのは②のとおり (5) 記録は**終了処理まで届いた呼び出し**だけ（強制終了は残らない）。基本の記録 karte_ai_log は v1・v2 とも1回1行・12列のまま（v1 の応答の draft にも v を付けない＝未設定なら v1 の応答とログは今と同じ）。v2 のときだけ別表 karte_ai_log_v2 に effort・client_req_id（形が合うときだけ）・状態ごとの数・イベント数・バイト数を1行（best effort・失敗は固定の文だけ・中身なし）。届かなかった数は日次点検の lost＝その日の usage − karte_ai_log の回数を数えた後の結果の行数（**基本の記録だけで数え、2つの表を足さない**）。形式別の内訳は v2＝別表の ok・v1＝基本の ok − v2 | `karte-ai-v2.test.js` V2-1〜V2-32、`karte-ai.test.js` A〜G・M・E3-1〜E3-9・E4-1〜E4-3・E5・C1〜C3・F1〜F6、`liff-karte-ai.test.js` L1〜L3、`karte-ai-kana-health.test.js` K1〜K3（読み）・H（点検の窓口・名前を出さない・読めなければ0件と言わない）・G（日次点検の判定）・M1（反映の順序）、`member-consent.test.js` G1〜G9（⑧）、`liff-karte-ai.test.js` L1-4（画面の補助） |
| I77 | **書き込み（予約・取消・変更）の段ごとの所要時間（設計43 A）は、数と固定の文字だけを Script Properties `LB_WRITE_PERF` の直近60件・8,000バイトのリングに残す**：操作名（固定の9つ）・成否・コード（許可リスト `LB_WP_CODES` に完全一致・外は OTHER・例外は THROW）・版・最後の印・段の ms。氏名・電話・LINE ID・予約ID・例外の文・応答の message を持たない。記録の失敗で予約の結果を変えない。認証と振り分けの例外は記録してから同じ例外を投げ直す（edgeAfterWrite の中の例外は今までどおり握りつぶす）。ロックを取らない＝標本（全数は booking_metrics）。読むのは作業依頼 `remaining {writePerf:true}`（op を足さない）。★段は後ろに足すだけ（古い行の位置を変えない）：2026-11-18 に変更の `preTrainer`（トレーナー名簿）・`preLedger`（台帳）・`preType`（契約種別）・`remainText`（トレーナー宛の文。芯の `_lbBuildHome` は `remain`）を足して19個。反映の前の並び（15・13・11個）も行の長さで読む | `write-perf.test.js` ①〜⑥、`gas-1118.test.js` ②・⑤ |
| I78 | **書き込みの後、Worker が空き枠を答えてよいのは、`slots_cache` の payload の `readStartAt`（その写しがカレンダーを読み始めた時刻・GAS の時計・数値型の整数だけ）≧ 画面が送った `slotsAfter`（GAS の `edgeAfterWrite` 入口の時刻）＋2秒 のときだけ（設計43 B）**。答えたら `slotsAfterOk` に同じ値を返し、画面は一致を確かめてから使う。`readStartAt` は作りたての枠を送る回（`pushToEdgeSlots` が自分で作り直せた回）だけ載る。①（カレンダーから計算）・写しが古い・連続ルールで答えない回も答えない。答えた／答えない理由は `remain_source_daily` の entry `slots_after` に数え、日次点検は残数の出どころと混ぜない。画面が残数・予約一覧を Worker に戻すのは、`edgeSyncedExceptSlots`（`EDGE_SLOTS_ONLY_LAG` の操作で、写しと予約一覧を送れて通し番号を積めた）と正しい `edgeWriteAt` が来て、ほかの書き込みが途中でないときだけ。スイッチ `WL_DEFAULT_ON`（既定 false・`?wl=1`） | `write-latency.test.js` ①〜④・`liff-write-latency.test.js` 1〜3 |
| I79 | **写しが書き込みの印を含んでいなければ Worker は答えない（設計45）**：会員が「閉じている」＝ `dirty_seq > 0` かつ（covers が NULL か `dirty_seq > covers`）。★NULL は閉じる（migration 0034 は初期化しない＝番号つきの押し出しが成功した会員から開く）。home の covers で閉じた会員の残数（D1 から作った値も写しも・振替権も）を `readHome` が null にする（写しを読む前と、値を全部読んだ後の2回。読めなければ閉じる）。resv の covers で閉じた会員の予約から作った値（会員の予約一覧・会員の boot・顧客詳細）は FALLBACK、トレーナー／オーナーの一覧と boot の今後の件数は**誰か1人でも**閉じていれば FALLBACK、カルテの概要は `nextUnknownOk` の要求にだけ `nextReservationUnknown`（印の無い古い画面は概要ごと 503 RESV_SYNCING）、一覧の `noNextBooking` は `'unknown'`。covers は写しの行と**同じ batch** で**置き換える（MAX にしない）**・dirty の文の後ろに積む。番号は写しを作るために台帳を読む**前**に読んだ全体の通し番号（GAS `_edgeCoversSeqNow`）。予約一覧は一部の送信が customerId、全体の送信が coveredCustomers（final の batch・行1件以上・2,000件まで）。印だけの送信（`rows:[]`＋`dirtySeq`）は covers を触らない。`remain-from-d1.js` の件数は I31 が先に守るので門を足さない。答えなかった回は `remain_source_daily` の entry `covers`、閉じている数と最長は `/quota/status` の `writeCovers`（会員IDなし・退会を除く）→ 日次点検（10分 warn・60分 high・移行の残り warn）。★GAS は写しの送信を応答の後ろへ回せる（スイッチ `LB_EDGE_DEFER`・既定オフ・既にある一回限りトリガー `_lbCalSyncAfterWrite` の先頭と5分ごとの `lbCalSyncTick`・新しいトリガー0本・どれか1つでもできなければ今の経路） | `write-covers.test.js` ①〜⑥、`ingest-mark-only.test.js` ①〜④（印だけの送信は表の全行を読まない・印は立つ・covers を触らない）、`gas-edge-defer.test.js` ①〜⑧、`karte.test.js` 11-1〜11-6、`liff-karte.test.js` 11-9・11-10、`read-on.test.js` ①-3〜①-3c |
| I80 | **後ろへ回した LINE 通知は、二重に送らず黙って落とさない（設計45b）**：スイッチ `LB_NOTIFY_DEFER`（既定オフ・`LB_EDGE_DEFER` とは別）。対象は `handleLineGet` の予約・代行予約・振替予約（`booking_customer`・`booking_trainer`）と取消・オーナーの無料取消（会員宛・契約上の担当宛の `cancel_*`）。その枠のトレーナー・変更・まとめて予約・トリガーからの通知は今のまま。文面は今と同じ場所・順序で応答の前に作る（残数は `_lbTrainerRemainText`＝書き込みの時点で固定）＝送る側は待ちの `text` をそのまま `_lbPush` へ。待ち `LB_NOTIFY_PENDING` へは edgeAfterWrite（一回限りトリガー）の**前**に入れ、トリガーを作れなければ自分の項目（取り分けられていないもの）だけ待ちから取り出して今の `_lbPush`（取り出せなければ待ちに残り受け皿が送る）、入れられなければメモリの保留を今の `_lbPush`、振り分けの例外でも投げ直す前に送る。項目は取り分け（ScriptLock の中で `li`/`lu`・5分）をした1つの実行だけが送り、試みたら1通ごとに消す（失敗は `_lbPush` → `_lbNqOnFail` が `notify_retry` に1回）。送る直前に「送る試みの印」`a=1` を立て（立てられなければその回は送らない）、期限切れの取り分けは印があれば送らず `notify_retry` の alert（送ったか分からない）・印が無ければ普通の項目に戻す（送っていないと確定）、30分超は pending（I17 が送る前に台帳を確かめる）。引き渡しの行 id は `'D'+待ちのid`・末尾200行に同じ id があれば追記しない。取消・変更が成立した後（ロックの外）、その予約の `booking_*` は待ちから捨てる（I17 と同じ）。取り分け中だけはロックを持たずに最大2秒（受付12秒の予算の内）待ち、消えなければ `flushTimeout`。数は `LB_NOTIFY_DEFER_COUNT`（held・inline_*・sent*・sendFail・leaseLost・handover・staleDropped・flushTimeout・maxAgeMs・sendMs・lockMsMax）→ 日次点検（壊れた待ち high・10分超の待ち warn はスイッチに関係なく）・作業依頼 `remaining {writePerf:true}`。段 `notifyCalc`・`notifyQ` | `gas-notify-defer.test.js` ①〜⑦、`gas-cancel-reason.test.js`、`write-perf.test.js` ④-10〜④-12 |
| I81 | **書き込みのロック待ちの時間切れは BUSY で返し、何も書かない（設計47）**：対象10関数（`verifyMembership`・`selfRegister`・`mergeMemberLink`・`_lbReserveCoreImpl`・`addOfflineMember`・`cancelReservationLine`・`undoSameDayCancel`・`changeReservationLine`・`_lbAddRecurPattern`・`deleteRecurringPattern`）は ScriptLock を共通関数 `_lbTakeWriteLock(op)` で取る（既に持っていれば取り直さない＝変更から呼ばれる予約の芯・自分で取ったときだけ放す）。**自分で取ったときだけ放す（10関数とも `if (_wl.owned)`／芯は `_lbOwnedLock`）**。`tryLock(10000)` の例外は BUSY にせず投げ直す（数は `err`）。`tryLock(10000)` が偽のときだけ `{success:false, code:'BUSY', message:'ただいま混み合っています…（まだ何も変更されていません）'}`（保守関数はその関数の形）。ロックの前に台帳・名簿へ書かない。**ロックを取った後の例外は BUSY にしない**（今のまま投げ直す）。ScriptLock の `waitLock` は許可リスト（`closeAllocationMonth`・web 体験予約 `makeReservation`）だけ＝増えたら構文の検査が落ちる。数は `LB_WRITE_LOCK_COUNT`（日ごと・op の許可リスト・n／busy／waitMax・直近3日・UTF-8 8,000バイト以下）に、要求のすべての出口（`handleLineGet` の末尾と例外の catch・`doPost`・`liffApi` の finally・保守関数の finally）で**ロックを持たずに1回だけ**書く（下限）。記録の関数の引数は固定の文字と数・真偽値だけ（構文の検査）。記録の失敗で結果を変えない。画面は `busy_retry`（4言語）を、会員の取消（新旧の経路）・トレーナーの取消・オーナーの無料取消・当日取消の戻し・固定枠の追加/削除で出す（確定と自己登録は `res.message`）。日次点検「対象10操作のロック競合」。★固定枠の自動予約（`autoBookRecurringPatterns`・外側でロックを持たない）は BUSY なら3秒・6秒・10秒の間隔で最大3回取り直し（sleep はロックの外・走り始めから4分を過ぎたら取り直さず残りの会員を保留）、それでも BUSY の会員は**保留**＝冪等マーク（LAST_MONTH）を付けない・お知らせを送らない（BUSY を skipped に載せない）・件数（`LB_AUTOBOOK_RESULT_*`）に足さない・新しく取れた分は写しへ積む。保留の人数を `LB_AUTOBOOK_HELD`（対象月ごと `{n, at}`・会員IDなし）に書き、保留0で終わったらその対象月の値を消す。日次点検は**記録の対象月**で warn（月をまたいでも消えない）。取り直しは人が GAS エディタで再実行し、本人の予約の見分け（mine）で取れていた枠を二重に取らない。トリガーは作らない。強制終了・開始失敗・手動との重なりの取りこぼしは既存の問題で範囲外（設計47 §7-4） | `gas-write-lock.test.js` ①②③⑤⑨⑫・D-1〜D-8、`gas-lock-syntax.test.js` ④⑪⑩、`liff-busy.test.js` 1〜5、`write-perf.test.js` ⑤-1〜⑤-5、`gas-autobook-busy.test.js` ①〜⑥、`gas-write-lock.test.js` ⑬⑭、`gas-lock-syntax.test.js` ④-5 |
| I82 | **押し出し（`_edgeLocked`）は ScriptLock を所有権方式で持ち、書き込みと同じロックで排他する（設計47）**：共通の ScriptLock は押し出し同士の後着の巻き戻しだけでなく「書きかけの名簿・固定枠を写さない」守りでもある（`verifyMembership` は名簿の同じ行を複数セルに分けて書き、押し出しは同じロックの中で customers を読む）＝**押し出しのロックを書き込みと別にしない**（リース・UserLock へ移さない・関門① 設計47 第1周）。呼び出し元が既に持っていれば（作業依頼 `pushAll`）取り直さず放さない。自分で取ったときだけ放す（GAS のロックの入れ子の数え方に頼らない）。握った時間は内側の finally でメモリに確定 → 放す → **放した後に** `LB_EDGE_PUSH_COUNT`（kind＝slots／all／home／fullSync／OTHER・n／thrown／skip／holdMax／holdSum／over10Sum／waitMax）へ best-effort → 元の戻り値／元の例外。入れ子の回は溜めて、作業依頼は `edgeJobPoll` がロックを放した直後に `jobHold` と一緒に1回だけ書く（`job_`＝作業依頼の実行中の印 `_EJ_IN_RUN`・解除は専用の外側の finally／印の無い入れ子は `nested_`）。残数の押し出しは label `home`。日次点検：10秒超の窓の秒数・例外・6分に近い・想定外の入れ子・昨日の記録が無い | `gas-push-count.test.js` ⑦⑧⑨⑫⑭⑮、`gas-lock-syntax.test.js` ⑪、`shadow-sweep.test.js` 2-20 |
| I83 | **write-shadow（設計54 S1a）は GAS の答えと副作用を変えない**：6列目の有無で `_lbReserveCore` の返り値・カレンダー・台帳・通知の呼び出しが同じ。6列目が作れなければ今と同じ5列の行。**顧客の要求の中で新しいロック・Script Property の読み書きをしない**（材料は既にある outcome の appendRow に相乗り）。`_lbLogOutcome` の appendRow が落ちたら失敗の数だけ別の try で残し、元の例外をそのまま投げ直す。送る段は一回限りトリガー・5分ごとの同期の最後で、経過4分／3分以上なら何もしない。新しいトリガーを作らない。送る段の排他は UserLock、**ScriptLock は LB_WS_STAT とカーソルの「読み直し→合成→書き込み」の数ミリ秒だけ（tryLock 500ms・取れなければ差分を捨てて LB_WS_STAT_MISS に数える）**＝顧客の書き込みのロック（I81 の10秒待ち）を待たせるのはその数ミリ秒だけ。合成は 数は足す・時刻は大きい方・掃き出しは立てるを優先・カーソルは前進のみ | `gas-write-shadow.test.js` ①④⑥⑦・④-l・④-s |
| I84 | **比べた記録（D1 の4つの表）に顧客ID・予約ID・予定ID・氏名・予定名を残さない**（列が無い・status と作業依頼は件数と分布だけ）。`booking_metrics` の6列目は許可した鍵だけ・氏名・LINE の ID・予定名なし・1,000文字以内。顧客IDは送れたら・2時間を超えたら消す（`stale:1` の印を残してからカーソルを進める・前後の照合で確かめられなければ進めない） | `write-shadow.test.js` ④⑧・`gas-write-shadow.test.js` ③④-d④-k |
| I85 | **Worker の判定は既存の単一ソース（`allocate.js` の `_lbBookability`・`calread.js` の `readCalendar`＝FRESH_MS 7分・`fresh.js`／`sync-version.js` の `isFresh`・`readCalcInputStatus`）を呼ぶだけ**で書き写さない。自分の予約は予約ID・予定IDで外す（同じ時刻の1件を外す推定はしない）。判定できない（u_*）・範囲外（x_*）・新しくない（w_stale）は一致にも食い違いにも数えない。GAS の段の語（`LB_WS.AT`）と Worker の語（`WS_GAS_AT`）は同じ集合 | `write-shadow.test.js` ①②③⑥⑨ |
| I87 | **k_editTraining（設計58）は置き換え**：1つの batch で「新しい session を作る（顧客・作者・作成時刻は古い行から写す＝要求から取らない）＋子の行（k_addTraining と同じ `trainingRows`・最後に trShape）＋古い session を論理削除＋生きた「お客様へ」の枚を新しい session に付け替える（日付も合わせる）」。customerId・member は受け取らない（400 SHAPE）。見張り：生きている・作者本人かオーナー・rev・文6の直後（新しい session が無ければ戻す）・文9の直後（古い session が消えていなければ戻す）・枚が生きた session（同じ顧客・同じ日付）を指すか。前の版は論理削除した行として子の表ごと残し、karte_revisions には中身を入れない（`{replaced_by, session_date}`・reason='edit'） | `karte-training-edit.test.js` E4〜E7・E10〜E16・E21・E32 |
| I88 | **直す画面は今日の下書き（karte_tr_draft_v1）を読まない・書かない・消さない**：直す下書きは別の鍵 `karte_tr_edit_v1:<tid>:<cid>`（24時間・purgeTrDrafts が消す）。送るのは k_editTraining だけ（中身は sessionId・rev・sessionDate・items）。写す・取り込み・AI・社内メモ・お客様に見える欄・休憩タイマーは出さない。ログインの取り直し・種目の登録の退避は `kind:'trainingEdit'`＋sid（直す画面に戻る）。2つの画面：持ち主 formId＋世代 ver・送り直しの画面は持ち主を取らない・書くのは edStore だけ（同じ document へも通知）・結果の処理は保存中の pending.reqId で決める・ほかの画面では成功と言い切らない・購読は dispose で外す | `liff-karte-training-edit.test.js` L20・L24・L25・L27〜L31 |
| I89 | **直す画面は記録済みのセットを ✓ 済みで開く（I57 の例外）**。全部の ✓ を外したら送らない（［削除］の案内）・変更が無ければ送らない。写しで値を落とさない（セットのメモ・補助・無理やり・ドロップ・実施のみ・同名の2種目・自重）・印の無い鍵（null・false・[]）は作らない | `liff-karte-training-edit.test.js` L20〜L23 |
| I90 | **k_editTraining は isKarteWrite に当たる名前（edit）**＝Origin・iat の守り。切替 `KARTE_TRAINING_EDIT`（既定 off・厳密に on／allow＋`KARTE_TRAINING_EDIT_TRAINERS`）が偽なら replay の後・回数の前に何も書かずに 409 TRAINING_EDIT_OFF（runWrite の editGate）。画面は k_training の `trainingEdit` が真のときだけ［編集］を出す（作者本人かオーナー・新しい鍵を値で使う回は 33 のときだけ） | `karte-training-edit.test.js` E1・E2・E17、`liff-karte-training-edit.test.js` L26 |
| I-M1 | **会員のカルテ（c_myKarte）の本人は who.customerId だけで決める。body を一切読まない**（customerId・noteId・sessionId 等で他人を指させない）。customer 以外・who.customerId が無ければ 403（設計35） | `member-karte.test.js` 1-7〜1-15・2-17・5-7 |
| I-M2 | **応答は専用の allowlist で組み立てる**（k_ の応答を流用して落とす形にしない）。SQL の段階で列を選ぶ（全部の列を取らない）。値が無いものは null／空配列（推測で埋めない）。体の記録は I51 のまま（verified の凍結＋d1） | `member-karte.test.js` 2-3〜2-16・5-3 |
| I-M3 | **社内メモ（karte_notes の本文・次回の計画・確かめること・理由）・健康情報（karte_safety・同意）・セットのメモ・ヒアリングの自由文・契約の金額と報酬を読まない・返さない**。契約は I53 を満たすときだけ・期間の列が無ければ null・担当は名簿の表示名（当たらなければ null）。includeContract=false なら契約の SQL を1本も出さない | `member-karte.test.js` 2-2・3-1〜3-4・4-1〜4-3・5-1〜5-5・6-6 |
| I-M4 | **会員に見せる文は karte_member_notes にだけ書く**。トレーニングと一緒の枚は同じ batch（全部か無か・ハッシュに正規化した member を含める）。session のある枚は参照先の生きた session と顧客・日付が一致（見張りで batch ごと戻す）・読むときも生きた session と JOIN。トレーニングを消すと同じ batch で枚も消える。編集・削除は本人か owner（owner の上書きは section=member_note_owner_override） | `member-karte.test.js` 7-1〜7-9・8-0〜8-12・9-1〜9-2・10-1〜10-10・11-1〜11-10 |
| I-M5 | **MEMBER_KARTE が厳密に 'on' でなければ c_myKarte はサーバーで必ず 503**（入口で認証より前に止め、窓口の中でももう一度確かめる）。k_memberPreview・k_saveMemberNote は止めない（KARTE の守りだけ）。起動の印 memberKarte は env だけで決める真偽値 | `member-karte.test.js` 1-1〜1-6・12-1〜12-4・13-1 |
| I-M6 | **verified でない会員の行は LINE の ID を送らない**（押し出し側。D1 で customer にならない＝c_myKarte に届かない）。Worker 側の確認は「LINE の ID が無い行は guest」 | `member-karte.test.js` 1-15（GAS 側の検査は gas/ の担当が足す） |
| I-M7 | **会員本人と「お客様の見え方」は同じ組み立て関数（buildMemberKarte）を通る**。見え方は共有の範囲（canSeeKarteShared）で開け、契約は担当の範囲（canSeeCustomer）のときだけ。ID（mnoteId・rev・sessionId・authorIsMe）は見え方にだけ付く | `member-karte.test.js` 5-6・6-1〜6-8 |
| I-M8 | **access_log に中身を書かない**。会員本人の閲覧は trainer_id=NULL・role='customer'・section='member_karte'・action='c_myKarte'・req_id=NULL。失敗の console に ID を出さない | `member-karte.test.js` 2-18・6-8・8-10・10-5 |
| I-CS1 | **会員の同意（設計44）の本人は who.customerId だけ**。m_myConsent・m_saveConsent は customer だけ（許可表）・body の customerId は入口で403・窓口は body から顧客を指す値を読まない | `member-consent.test.js` A1・A2・A8・D9 |
| I-CS2 | **m_ は FALLBACK を返さない**（GAS に対応が無い）：役割の写しが古ければ 503 ROLES_STALE・EDGE_READS を掛けない。m_saveConsent は Origin の完全一致と iat 1時間。共通の catch で m_ の message を出さない | `member-consent.test.js` A3〜A7・A9 |
| I-CS3 | **正本は分ける・二重にしない**：健康情報のいまの同意＝karte_consent（I48）、録音・AI＝karte_consent_rec、回答と版＝karte_consent_answers、状態の変化＝karte_consent_log。migration は CREATE IF NOT EXISTS だけ（ALTER しない） | `member-consent.test.js` D1・D14・J3・J4 |
| I-CS4 | **declined はいまの状態を変えない**（回答の表にだけ）。★紙で同意済みの人の declined も撤回しない・健康情報を消さない（CEO 裁定 2026-11-16）＝k_summary の consent.memberDeclined でトレーナーに見せる。**会員画面からの健康情報の撤回は受ける**（オーナー決定 2026-11-16・agreed の見張りつき・I48 のとおり同じ batch で karte_safety を消す・メモ・トレーニングは消さない・画面は2段の確かめ）。再送（同じ状態・同じ版）は状態・log・回答に何も書かない（access_log だけ）。録音・AI の撤回は agreed の見張りつき（無ければ CONFLICT） | `member-consent.test.js` D3〜D7・D3b・D11・D12・D13・D13b（回数の守りは書き込みと同じ batch の見張り KARTE_GUARD_CRATE）・D2-1〜D2-3（健康情報の会員の版は専用の SQL で引く）・K1〜K10・K9b（オーナーの答え・読めなければ memberDeclined を付けない）、`liff-member-consent.test.js` 6-9〜6-12、`liff-karte-ai.test.js` L9-4・L9-5 |
| I-CS5 | **切替 MEMBER_CONSENT（厳密に on／allow＋担当・既定 off）は勧誘と新しい同意にだけ効く**。閉じていても録音・AI に同意済みの本人と、健康情報に**会員画面で**同意済みの本人は revoke_only で状態を読み撤回できる（紙の同意だけの人には出さない＝既定 off の約束）。紙で同意済みの会員にも会員画面で健康情報を聞く（オーナー決定 2026-11-16）。起動の印は true／false／'unknown'（読めなければ unknown・偽に潰さない・起動は落とさない）。画面は true／'unknown' のときだけ聞き、起動ごとに1回 | `member-consent.test.js` B1〜B5・E1〜E4・F1〜F5、`liff-member-consent.test.js` 1-1・4-1・5-1・6-1〜6-8（撤回は版に関係なく出す）・6-13・6-14、`member-consent.test.js` C3・K11〜K13 |
| I-CS6 | **文面は Worker（consent-docs.js）が正本で、版と SHA-256 を検査で固定**（文を変えて版を上げ忘れると落ちる）。画面は返された文を textContent で描く（** だけ太字）。版が現行と違う送信は 409 DOC_CHANGED | `member-consent.test.js` I1〜I4・D8、`liff-member-consent.test.js` 2-3 |
| I-CS7 | **トレーナーは録音・AI の同意を記録できない（撤回だけ）**。健康情報の agreed に agreed は CONFLICT（会員の版つきの記録を紙で置き換えない・replay が先）。k_summary は state・日付・byMember だけ（版を返さない） | `member-consent.test.js` H1〜H7、`liff-karte-ai.test.js` L9-1〜L9-3 |
| I-C1 | **台帳の備考（9列目）は予約の鍵。理由・ひとことを一切入れない**（書く値は設計36の前と1文字も同じ）。備考を鍵として読む4か所（`cancelReservationLine` の完全一致・`undoSameDayCancel` の前方一致・`_lbNqFindResv`・`_lbNudgeResId`）が今どおり（設計36） | `gas-cancel-reason.test.js` 1-1〜1-4・10-1〜10-5 |
| I-C2 | **理由・ひとことのせいでキャンセルを失敗させない**：知らない鍵・101字以上・文字列でない値・数式（sanitizeCell）・保存の失敗・見出しの不一致は、キャンセルを成立させて印（noteDropped・booking_metrics の CXL_）だけ残す。長すぎるひとことは切り詰めず丸ごと捨てる | `gas-cancel-reason.test.js` 2-1〜2-12・8-1〜8-6 |
| I-C3 | **cancel_notes からカルテ（karte_*）へ何も写さない**。ひとことは健康情報を書く場所ではない＝入力欄の真下に注意書き・選択肢「体調・コンディション」は区分だけ | `gas-cancel-reason.test.js` 11-7、`liff-cancel-reason.test.js` 1-5・1-6 |
| I-C4 | **ひとことの本文をログ・booking_metrics・作業依頼の結果・会員宛の LINE に出さない**（トレーナー宛と送り直しの列・オーナーへのメールには載る＝オーナー決定）。会員に「お伝えします」と言うのは空でないひとことを保存できたとき（messageAccepted）だけ | `gas-cancel-reason.test.js` 5-3・5-4・7-6・9-17・11-3・11-4、`liff-cancel-reason.test.js` 6-1〜6-7 |
| I-C5 | **キャンセルの判定は変えない**（`_lbIsFreeCancelWindow`・振替権の付与）。無料にできるのはオーナーの専用の入口 `line_ownerFreeCancel` だけ。トレーナーの画面は見え方（「キャンセル（当日消化）」と確認の文）だけ変え、`r.freeCancel` が真偽値でなければ「消化されるかもしれない」側の文 | `gas-cancel-reason.test.js` 11-8・3-8・11-5、`liff-cancel-reason.test.js` 7-1〜7-9 |
| I-C6 | **作業依頼・日次点検は note 列を読まない**（ひとことが残っているかは note_purged_at の空で見る）。作業依頼は COUNT_COLS の列だけを読み、鍵ごと・状態ごとの件数だけを固定の一覧で返す（セルの文字を出さない） | `gas-cancel-reason.test.js` 9-13〜9-22 |
| I-C7 | **ロックの中は「判定・台帳・振替権・cancel_notes の1行」だけ**。LINE の送信・担当や LINE ID や言語の検索・文の組み立て・掃除・booking_metrics はロックの後（I19 の精神）。trainer_master・名簿（オーナー無料取消の認可）もロックの前に1回だけ読み、ロックの中は手元の値を引く（2026-11-06 関門②） | `gas-cancel-reason.test.js` 4-1〜4-5・13-1〜13-2b・13-8 |
| I-C8 | **判定が画面で同意した結果（cxlExpect）と違えば何も書かずに OUTCOME_CHANGED**。無い・空は比べない（古い画面）・free／consumed 以外は何も書かずに BAD_EXPECTATION（理由・ひとことと違い、同意の内容なので壊れていれば止める） | `gas-cancel-reason.test.js` 3-1〜3-8、`liff-cancel-reason.test.js` 5-5〜5-8 |
| I-C9 | **cancel_notes の見出しが完全一致（14列・順番）しなければ行を書かない**（キャンセルは成立・header_mismatch・CXL_NOTE_HEADER）。キャンセルの経路ではシートを作らない。appendRow はそれだけを内側で囲む | `gas-cancel-reason.test.js` 8-1〜8-9 |
| I-C10 | **trainer_reason（第2段の鍵）は判定・消化・振替権に使わない**（使い道は設計37 の対象判定だけ）。会員から来たら捨てる | `gas-cancel-reason.test.js` 10-6・10-7 |
| I-C11 | **台帳を書いた後の処理は「成立後の付け足し」**：その枠のトレーナー／契約上の担当／会員／掃除／記録の5つを独立に囲み、どれが落ちても success:true（例外のログは単位の名前と種類だけ）。その枠のトレーナーには時間予算を見ずに直接（noInlineRetry）、担当と会員は受付から12秒・通知開始から4秒を超えたら `_lbNqDefer` で積む。各通知は一度だけ attempted か deferred に進む（_lbPush を呼んだ通知は外から積まない）。**messageAccepted と会員宛の「お伝えしました」は、保存できて、かつその枠か担当へ送ったか積んだときだけ**。cancel_notes の notified の訂正は時間予算を見ずに毎回（掃除と別の単位） | `gas-cancel-reason.test.js` 6-1〜6-9・7-1〜7-6・13-3〜13-7c |
| I-H1 | **自己修理 P1 の要約（LB_HEALTH_STATUS）・台帳（incidents）・LINE・メール「オーナーにしかできないこと」に、氏名・顧客が書いた文・例外の文・LINE の ID・メール・電話・予定名を入れない**。要約は `add()` の6番目 `safe` だけから作り detail を読まない。文面は固定の文 `LB_OWNER_MSG`（差し込むのは列挙の値・件数・会員番号の末尾4桁だけ）。既存の health_status と悪化メールの detail は今どおり（オーナーだけの場所） | `self-heal-check.test.js` I-H1 |
| I-H2 | **fixed は「完走した点検で、その key の段が checked にあり、key が無い」ときだけ**。段が checked に無ければ unknown（閉じない）。修理の直後は fixing（閉じるのは次の点検） | `self-heal-check.test.js` I-H2 |
| I-H3 | **修理（lbSelfHeal）は既存の setup* を呼ばない・トリガーを消さない**（既存の設定関数は「全部消してから作り直す」＝途中で落ちると悪化する） | `self-heal-repair.test.js` I-H3 |
| I-H4 | **足すのは 0 本の処理名だけ。作る直前と直後に数える。直後に 2 本以上なら消さずに escalated** | `self-heal-repair.test.js` I-H4 |
| I-H5 | **足した後のトリガーの総数は 18 本以下**（普段の本数を超えない＝元に戻すだけ・CEO 裁定 2026-11-23）。超えるなら足さずに escalated。**作った後に数えて18本を超えていれば（作っている間に別の処理が作った）消さずに escalated（over_limit_after）** | `self-heal-repair.test.js` I-H5 |
| I-H6 | **修理の途中で落ちても、修理前にあったトリガーは残る**（消さないので悪化しない） | `self-heal-repair.test.js` I-H6 |
| I-H7 | **SELF_HEAL_MODE が未設定・不正値・トリガーのイベント引数 → practice**（直さず would_attempts を数えるだけ）。`lbSelfHeal(nudgeStartMs)` の引数は**予算の計算にだけ**使い（I-H31）、mode には一切効かない（専用のトリガーは無く、lbNudgeDaily の最後から呼ぶ） | `self-heal-repair.test.js` I-H7 |
| I-H8 | **`要約.check_id === LB_HEALTH_DONE`・`completed === true`・26時間以内でなければ修理しない**（要約だけ書いて落ちた点検の結果を使わない） | `self-heal-repair.test.js` I-H8 |
| I-H9 | **同じ案件の修理は3回まで。attempts は呼ぶ前に +1**（途中で落ちても数える）。練習は attempts を使わず would_attempts（これも3回まで） | `self-heal-repair.test.js` I-H9 |
| I-H10 | **振り分け表 `ops/booking-health-triage.md` と `LB_TRIAGE` が一致（79 key）・表に無い key は B**。LB_TRIAGE の段は add している段と一致 | `self-heal-triage.test.js` I-H10 |
| I-H11 | **古い点検（check_id が小さい）は新しい要約・台帳を上書きしない／DONE は小さい値で戻らない** | `self-heal-check.test.js` I-H11 |
| I-H12 | **予約の行・残数の材料・顧客に届くものを書く処理（dailySync・syncExistingReservations・lbDwEnsureQueued・_lbPush 等）を修理から呼ばない**。P1 の A は trigger_missing と cancel_notes_unready の2つだけ | `self-heal-repair.test.js` I-H12 |
| I-H13 | **facts・ids・last_action・notify_code・notify_state・status は列挙だけ**（facts は key ごとの一覧 `LB_FACT_ENUM`・ids は `^C\d{14}$` で member_broken だけ）。一覧に無い値は捨てて `facts_rejected` に数える | `self-heal-check.test.js` I-H13 |
| I-H14 | **即時（LINE）の宛先は trainer_master の role=owner・active が真（_lbTruthy）・LINE ID あり（同じ ID は1回・admin に送らない）。0人・表が読めないならメール。quota_exhausted は LINE を試さない** | `self-heal-notify.test.js` I-H14 |
| I-H15 | **通知は送る前に sending と時刻を書き（tries +1）、届いたら delivered。届いた後は送らない。sending のまま残っていたら LINE で送り直さずメール**。1日1回・最大3日 | `self-heal-notify.test.js` I-H15 |
| I-H16 | **lbSelfHeal（lbNudgeDaily 10時の最後）の完走（LB_SELFHEAL_DONE）を翌日の点検が（selfheal_stale・26時間・反映直後は猶予）、点検の完走（LB_HEALTH_DONE）を lbNudgeDaily が確かめる** | `self-heal-lease.test.js` I-H16 |
| I-H17 | **cancel_notes の回復は `_lbCnHealth().ready` でだけ判定**。データ行があって見出しが違えば setupCancelNotesSheet は触らない（mismatch）→ escalated・閉じない | `self-heal-repair.test.js` I-H17 |
| I-H18 | **`LB_HEAL_SCHEDULE` は既存の setup*（setupLineTriggers・setupNudgeTrigger・setupEdgeTrigger・setupEdgeJobTrigger）と同じ組み立て**（身代わりの ScriptApp で setup* を実際に動かして突き合わせる） | `self-heal-repair.test.js` I-H18 |
| I-H19 | **オーナーへの通知は `_lbPushOnce` を直接使い、失敗を `_lbNqOnFail` に積まない**（`_lbPush` は未知の用途を alert として積む＝警告の未達が警告を呼ぶループになる） | `self-heal-notify.test.js` I-H19 |
| I-H20 | **点検（dry-run を含む）と修理は同時に1本だけ（借りる印 LB_HEALTH_LEASE）。印の期限は35分・段ごとに延長。ScriptLock は印を取る・延ばす・放す瞬間だけ（tryLock 300ms）** | `self-heal-lease.test.js` I-H20 |
| I-H21 | **副作用（トリガーを足す・シートを作る・LINE・メール・attempts・sending・台帳・要約・SINCE・DONE・見送りの数、点検の health_status 追記・LB_HEALTH_PREV・悪化メール・lbNotifyDeferDailyMaint）の直前に印を確かめ、失っていれば止まる。点検は印を失った時点で以降の副作用をせずに終える（他人の印は放さない）**。dry-run も同じ | `self-heal-lease.test.js` I-H21 |
| I-H22 | **壊れた印（JSON 不正・owner/until が無い・数でない・2時間以上未来）は期限切れとみなさず見送り、lease_broken を記録**（lbNudgeDaily が固定の文でメール） | `self-heal-lease.test.js` I-H22 |
| I-H23 | **checked は段の処理が例外なく終わった後（_done）にだけ付く**。*_fail を出した段・例外を黙って握りつぶした段・読めなかった段は付かない | `self-heal-check.test.js` I-H23 |
| I-H24 | **check_id と LB_HEALTH_LAST は同じ数／Nudge は DONE が未設定の間「途中で落ちた」を出さない**（LAST > DONE かつ2時間超で知らせる） | `self-heal-check.test.js` I-H24・`self-heal-lease.test.js` I-H24 |
| I-H25 | **見送りは LB_HEALTH_SKIP に連続回数を数え、完走した点検が health_skipped を要約・台帳に出して保存できた後に、読んだ分だけ引く**（走っている間に増えた分は残す・保存に失敗したら引かない） | `self-heal-check.test.js` I-H25 |
| I-H26 | **印の owner は実行ごとの乱数（Utilities.getUuid）で check_id と別**。同じ時刻に2本起動しても互いの印を消さない | `self-heal-lease.test.js` I-H26 |
| I-H27 | **期限切れの印を持つ実行は、owner が一致しても副作用をしない（点検はその時点で終える）。副作用（点検の lbNotifyDeferDailyMaint・health_status・LB_HEALTH_PREV・悪化メール・_lbHealthSave の各書き込み・DONE、修理の各書き込み、通知の LINE とメールの1通ごと）の直前は、延長できたときだけ通す（`_lbLeaseOk`）**。DONE の後の見送りの引き算・起こすはずだった回数は、DONE の直前の延長から35分の中なので確かめない。完走した点検の後の通知は、延長できなければ送らずに次回へ（notify_code 相当の `deferred_lease`・LB_HEALTH_SKIP に数えない） | `self-heal-lease.test.js` I-H27・I-H21 |
| I-H28 | **手動・dry-run の点検（runHealthCheckDryRun・作業依頼 health）も同じ印で排他する**（dry-run も refreshPaceBoard でシートを書く）。見送ったら「問題なし」と言わない | `self-heal-check.test.js` I-H28 |
| I-H29 | **lbSelfHeal は専用のトリガーを持たず、lbNudgeDaily の最後（finally・うながしのロックを放した後）に `_lbNudgeThenSelfHeal` から1回呼ぶ**。うながしの戻り値・送信を変えない・自己修理の例外をうながし側に漏らさない・うながしの例外は今までどおり外へ出す（CEO 裁定 2026-11-23） | `self-heal-nudge.test.js` I-H29 |
| I-H30 | **印の確認は ok／busy（ScriptLock が取れない＝予約などが持っている）／lost（他人の印・期限切れ）の3つに分ける**。副作用の直前は busy なら tryLock(300ms) を3回まで試し、延長できなければその副作用をしない（点検は終える・修理は次回へ・完走の印を書かない）。**延長しないまま続けてよいのは点検の段の進行だけ**で（★印が守る範囲＝**この設計で足した書き込み**：要約・SINCE・台帳・DONE・通知・修理・WATCH_FROM・selfheal の DONE。**点検が元から行っていた書き込み**＝進行の記録 LB_HEALTH_STEP と `refreshPaceBoard` のシート書き込みは印の外で、今までどおり（設計 §2-1）。修理の入口の心拍 LB_SELFHEAL_LAST と練習の開始印は「起きた」ことを残すため印を取る前に書く）、手元で覚えている期限の残りが5分以上のとき（切ったら延長を試し、だめなら終える）。busy で終えた・見送った回は LB_HEALTH_SKIP に why=lock_busy。印を放すときはロックを3回まで試す | `self-heal-lease.test.js` I-H30 |
| I-H31 | **修理の時間の予算＝min(4分, 5分 − lbNudgeDaily にかかった時間)**（lbNudgeDaily が開始時刻を渡す）。60秒未満なら始めず LB_HEALTH_SKIP に why=no_time（entry=heal）・完走の印を書かない。予算を超えたら残りの案件は次回へ | `self-heal-repair.test.js` I-H31・`self-heal-nudge.test.js` I-H29 |
| I-H32 | **台帳 `incidents` が完全に空（getLastRow<1 かつ getLastColumn<1＝見出しの行も無い）のときだけ、印を確かめて（`_lbLeaseOk`）から見出しを書いて使い、`header_repaired` を返して LB_HEALTH_SAVE_LAST の repairs に数える**。1行でも中身がある・見出しが違うなら書かない（今どおり header_mismatch＝行の意味を変えない）。印を確かめられなければ書かない（2026-11-24 本番で空のタブのまま初回から黙っていた） | `self-heal-ledger.test.js` I-H32 |
| I-H33 | **点検の保存（`_lbHealthSave`）の結果を LB_HEALTH_SAVE_LAST に残し（newer と印を失った回は書かない。★DONE を書いていない回は印の確認を noSkip にしない＝延長できなければ LB_HEALTH_SKIP に数え翌日 health_skipped が鳴る）、次の点検が「saved=false で、DONE が信じられない（未設定・数でない・0以下・いま＋5分より先＝broken・要約の check_id ≠ DONE・completed でない）か DONE < その check_id」なら `heal_save_fail`（B・理由は列挙 `LB_SAVE_WHY`＋other／壊れた記録は broken）を出す**＝従来の悪化メールに「自己修理の台帳に保存できませんでした（理由: …）」が載る。悪化したときだけ知らせる既存の規則に従う（続いても1回）。★知らせるのは失敗した翌日の点検 | `self-heal-ledger.test.js` I-H33 |
| I-H34 | **作業依頼 `remaining {healStatus}`（`heal_status` も可・新しい op を足さない）は読むだけで、列挙・数・日時だけを返す**：LB_HEALTH_STATUS の要約（会員番号は件数だけ）・LB_HEALTH_DONE・LB_SELFHEAL_DONE・保存の結果・見送り・台帳の行（key・cls・stage・status・attempts・would_attempts・last_action・日時）。列挙に無い値は `?`。印の owner・氏名・自由文は返さない | `self-heal-ledger.test.js` I-H34 |
| I-H35 | **点検の段「自己修理の見張り」そのものが例外で落ちたら、固定の key `selfheal_watch_fail`（B・warn・facts は exception だけ）を add する**。例外の文は出さない（I-H1）。段は checked に付けない（今どおり＝その段の key を閉じない）。印を失った例外（lbLeaseLost）は add せず外へ投げる（I-H21） | `self-heal-ledger.test.js` I-H35 |

★**新しい不変条件を足したら、この表に「守っている検査」を必ず書く。**
　空欄のまま残すと、2026-10-09 のように**検査が飾りになっていても気づけない**。

---

## 4. 語彙表（★同じものの別名。ここを間違えると静かに壊れる）

| 意味 | 台帳（GAS） | D1の写し | 変換している場所 |
|---|---|---|---|
| 予約が有効 | `confirmed` | **`booked`** | `gas/PushToEdge.js`（`_edgeReservations`） |
| 当日消化 | `consumed` | `consumed` | 同 |
| 取消 | `cancelled` | `cancelled` | 同 |
| 変更 | `changed` | `changed` | 同 |
★2026-10-09、台帳の語彙で数えたため**通常の予約を1件も数えていなかった**。

### カルテの種目の部位・重量（★2026-11-06）
| 意味 | 画面（表示） | D1・Worker の鍵 | 変換している場所 |
|---|---|---|---|
| 部位 | 胸／脚・尻／背中／肩／腕／体幹／その他 | chest／legs／back／shoulder／arm／core／other | `liff/karte.js` の `PART_KEYS`（鍵の正本は `worker/src/lib/karte-exercises.js`） |
| 部位がまだ無い（共有の一覧に無い名前） | 名前からの推定（`PART_RULES`）・当たらなければ「その他」 | 表に行が無い（`k_exercises` に出ない） | `liff/karte.js` の `partKeyOf` |
| 自重 | 重量の欄が空／表示は「自重」（会員の画面は `mk_bw`） | weight_kg **0** | 画面の `buildPayload`（空→0）・`wLabel`／index.html の `_mkW` |
★「一覧に無い」と「その他（other）」は別の事実（無い＝誰も分類していない・other＝分類した結果その他）。

### トレーニングの記録の印（★2026-11-07・設計38）
| 意味 | メモ | 画面（表示） | D1・Worker |
|---|---|---|---|
| 補助 | `50×10+5` | `+補助5`（会員 `mk_assist`） | `karte_tr_set_ext.assist_reps` 5（reps は10のまま）。ドロップの段は `karte_tr_drops.assist_reps` |
| ドロップ | `10×10+0×10` | `10kg×10→自重×10` | `karte_tr_drops`（親の set_id・drop_seq 1）。**karte_tr_sets には無い** |
| 無理やり | `80×5(できない)` | `（無理）`（**会員には出さない**） | `forced` 1（印なし＝NULL）。要求では `forced: true` のときだけ鍵を付ける |
| 数字の無い種目 | autoKnown と一致する名前だけの行 | `実施のみ`（会員 `mk_done`） | `karte_tr_exercises.done_only` 1・本セット0行。要求では `doneOnly: true`・`sets: []` |
| 種目の並び | 行の順 | 新しい回は入力の順 | `ord`（古い回は karte_tr_exercises が無い＝名前順／会員は set_id の順） |
| 種目（構造の単位） | — | ord ごとのかたまり | (session_id, ord)。自己ベスト・推移だけ exercise の名前 |
| 受付の版 | — | 取り込みのボタン・補助の欄は33のときだけ | `karteSchemaFor(env, who)`＝切替が開けば33・閉じれば32（定数 KARTE_SCHEMA=33 は最大値） |
★新しい鍵は「値ではなく鍵があるか」で判定する（`drops: []` も新しい鍵・`assist: null` は400）。

### 流入元（`utm_source`）の値の意味（★2026-11-05 に確定）

| 値 | 意味 |
|---|---|
| `tr_nakano` / `tr_suzuki` / `tr_oki` | **トレーナーの紹介**。どのトレーナーの口・名刺・SNSから来たか |
| `instagram` / `google` / `line` / `facebook` | 広告・公式アカウント |
| `mail` | モニターの選考通過メールの中継（`tokowaka-gym.com/r/`） |
| `direct` | UTMが付いていない。**紹介から来て途中で別ページへ出た人もここに落ちる** |

★**`utm_source`（誰経由）と「担当トレーナー」（誰の枠を取ったか）は別の列。**
　`reservations` の8列目が流入元、5・6列目が担当。
　「鈴木の紹介で沖の枠を取った」を区別して残すために分けている。混ぜてはならない。

紹介URLの形（唯一の定義は `worker/test/utm-referral.test.js`）：

```
https://reservation.tokowaka-gym.com/?utm_source=tr_<slug>&utm_medium=referral_trainer&utm_campaign=trial_referral[&utm_content=<貼り先>]
```

- **`utm_campaign` に月を入れない。** 名刺・QRを刷り直さずに使い続けるため。いつ来たかは台帳の日時で分かる
- **`traffic_type=internal` を付けない。** 付けるとGA4の自社トラフィック除外に当たり、紹介が1件も計測されない
  （`traffic_type=internal` は `utm_source=staff`＝スタッフ確認用だけに付く形）
- `tr_` の形は `worker/src/routes/pagehits.js` の `SOURCE_RE` に合わせる。合わないとLP側の到達が `none` に落ちる

### `pack_id` の作られ方（★2026-10-09 に実態を確定した）

```
Script Property  LB_STRICT_ID_MODE === 'on'  → 契約表の 'pack_id' 列を読む（不変のID）
                 それ以外（★既定は off）     → 読まない。**必ず合成する**
合成の形         'CT' + 開始日のms + '_' + 終了日のms + '_' + シートの行の番号
```
★**いま本番は合成IDを使っている**（`_lbStrictIdMode` の既定が off・`gas/LineBooking.js:3518`）。
　シートに `pack_id` 列があっても、strict が off なら読まない。

### 何が起きるか
```
契約表に行を1行挿入する  → 以降の行の番号がずれる → pack_id が変わる
開始日・終了日を直す     → pack_id が変わる
```

### なぜ「読まない」方式で救われるか（2026-10-09・設計13）
```
古い pack の行     世代の印が外れる → **読まれない**
新しい pack の行   作られる（used は 0 から）
引当               毎回「消して入れ直す」ので、新しい pack_id を指す
used               トリガーが新しい行に積み直す
```
＝**IDが変わっても、読む値は整合する。**

### 棚卸し（`opening_used`）との紐付け
`opening_used`（移行前に使った枚数）は `pack_id` で紐付いている。照合の順序は：
```
① 完全一致を探す
② 無ければ「末尾の '_行番号' を除いた値の完全一致」を探す（_lbPackPrefix）
   ★「前方一致（startsWith）」ではない。末尾を落とした値どうしの一致
③ 一致しない／候補が複数 → OPENING_PACK_UNRESOLVED
```
`OPENING_PACK_UNRESOLVED` が出ると、**その会員のD1の作り直しは止まる**（I5）。

★だから**「開始日を直すとチケットが復活する」は誤り**（2026-10-09・Codexの指摘で訂正）。
　止まるので、古い行がそのまま残る。顧客に出るのは写しのまま。

### それでも残る危険（★正確な形）
```
誤った完全一致   行を移動したあとのIDが、別の既存packの旧IDと**偶然一致する**
                 → 止まらずに、間違ったpackへ棚卸しを割り当てる
                 ★同じ開始日・終了日のpackが複数ある会員では、
                   行番号のずれを常に安全に吸収できるとは言えない
```
→ 切り替えの合格条件（§4-2）に「同じ `CT<開始>_<終了>` のpackが複数ない」を入れる。

### 本筋は `LB_STRICT_ID_MODE` を on にすること
ただし**順序が重い**（strict は顧客ID列も同時に有効化する）。
```
1. 顧客ID列を全対象行へ書き戻す
2. pack_id を全チケット行へ採番する
3. 新規登録時の顧客IDの書き戻しを有効にする
4. チケット追加時の pack_id の採番を有効にする
5. ★migration_balance.packs_json の鍵を、旧い合成IDから新しい固定IDへ変換する
   （変換しないと、明示IDは合成IDと結び付かない＝全会員で棚卸しが解決しない）
6. dry-run で全部の棚卸しが解決することを確かめる
7. LB_STRICT_ID_MODE = on
8. ★入力を押し直して source_version を進める
9. withAlloc=1 で全会員を作り直す
10. 照合と shadow が通ってから使い始める
```
★8を飛ばすと危ない。空欄の行があれば作り直しは止まるが、
　**古いD1の行は残る**。世代を進めていなければ、読む側はそれを読み続ける。
　進めれば `behind` になって答えない＝安全側に倒れる。

---

## 4-2. ★段階3-b の切り替えの合格条件（「採番済み」の代わり）

合成IDのままでも切り替えは成立する（古い行は読まれず、引当を入れ直すので
`used` が新しい行に積み直される）。ただし次を**全部**満たしてから。

```
□ 全会員の作り直しが withAlloc=1 で完了（blocked 0・skipped 0・issues 0）
□ 世代：stale 0・ahead 0／いまの世代の行数と記録した行数が一致
□ 照合（quota-verify）が pageOk=true。主キーの集合も一致（keyChecked > 0）
□ shadow が十分な母数で食い違い0
□ ★棚卸しの鍵（openingPacks）が**全部**、完全一致か「一意な末尾除去一致」で解決する
    OPENING_PACK_UNRESOLVED = 0 ／ OPENING_OVER_TOTAL = 0
□ ★同じ会員の中に、同じ 'CT<開始>_<終了>' のpackが**複数ない**
□ D1の used が、作り直した引当の合計とpackごとに一致
□ D1が答えないとき、写しへ確実に落ちることを実データで確認
□ 切り替えの作業中は、契約表の行の挿入・移動・日付の修正を凍結する
```
★**「棚卸しの解決そのもの」を検査対象にするのが、固定IDの採番に代わる本質的な条件。**

### 月のキー
```
'YYYY-MM'（JST）。UTCで作ると日本の深夜に前月になる
```

---

## 5. 読み取りの契約（★いつ `null` を返すか）

### `readHome`（写しを読む・`worker/src/routes/boot.js`）
`null` を返す6つ：`no_customer` / `no_row` / `bad_json` / `month_missing` / `bad_shape` / `no_computed_at`
★設計45（I79）：その前後に門。写しが書き込みの印を含まない会員（`dirty_seq > home_covers_seq`・NULL）・門が読めないときも `null`（`readHomeDiag` を呼ぶ前と、値を全部読んだ後）
★返り値には**写しに無いものが後から足される**：`month` / `computedAt` / `stale` / `ageMs`
　→ shadow で比べるときは**この4つを除く**（でないと毎回必ず食い違う）

### ★写しにしか無い値（D1からは作れない）
```
transferCredits   振替権（ホームの「振替 N回」＋予約画面の①通常/②振替の分岐）
                  振替権は transfer_credits シートにしかない。D1に無い
                  ★写しのトップレベルに入れている（月ごとに分かれない）
                  ★手順4（顧客に出す）のときは**写しから補う**。
                    補わないと顧客の画面から振替が消える
```
★2026-10-09 まで、これが**写しに入っていなかった**。
　GASは memberStatus の `home` の**外**に置き、Workerは `home` の**中**を読んでいた
　＝Worker経由では常に `{ available: 0 }`。**振替権を持つ会員が振替で予約できなかった。**
　shadow のために「顧客に返す値の一覧」を作ろうとして初めて気づいた。
→ 再発防止：`worker/test/home-fields.test.js` が
　「Worker が `home.XXX` として読む鍵が全部そろっているか」を機械で確かめる。

### `readRemainDiag`（D1から作る・`worker/src/lib/remain-from-d1.js`）
答えない理由：`no_customer` / `out_of_range` / `no_version_row` / `not_built` / `behind` / `behind_write`（書き込みの通し番号より前の台帳で作り直している・設計20） /
`read_failed` / `version_changed` / `row_count_missing` / `row_count_mismatch` /
`coverage_missing` / `base_freq_missing` / `overage_missing` / `overage_bad_shape` / `overage_out_of_range` / `overage_mismatch` / `as_of_stale`（設計27：支払い待ち）
★`{ type: null }`（契約が無い会員）は**正常な答え**。`null`（答えない）とは別物。

### 範囲のずれ（★2026-10-09 に踏んだ）
```
書く側   fromMonth..toMonth（呼び出しごとに違う。全員ぶんは当月〜翌月、
         二重書きは recordsFrom〜当月+2か月または最も先の予約月）
読む側   表示は当月と翌月だけ。ただし**件数の照合のために全部の月を読む**
照合     ★作り直しが保存した範囲（built_from_month / built_to_month）を使う。
         URLで渡さない（渡すと推測になり、正しい行を「欠けている」と誤判定する）
```

---

## 6. 呼ばれ方の事実（★設計の前に確かめる）

| 経路 | いつ呼ばれるか | shadow の対象 |
|---|---|---|
| `routeBoot`（入口 boot） | ★**どの画面からも呼ばれない**（2026-10-17 に確定。LIFF の EDGE_MAP に `boot` が無い） | ✅（だが0回） |
| `compatMemberStatus`（入口 compat_member） | 会員が起動したとき1回（LIFF `line_boot` → `c_boot` → `compatBoot` → ここ）＋`getMemberStatus` | ✅ |
| `compatCustomerHome` | トレーナーが顧客カードを開くたび | ✅ |
| `compatBookingOptions` / `routeBookingOptions` | ★**候補を選び直すたび** | ❌ 確定を遅くしない |
| `customerDetail` | 上から連鎖 | ❌ |
| `m_myConsent`（会員の同意・設計44） | 起動の印 memberConsent が true／'unknown' のときだけ、**起動ごとに最大1回**（言語の切り替え・ホームの描き直しで聞き直さない）。印のために compatMemberStatus は切替が on でないとき karte_consent_rec を PK で1行、顧客・残数と並べて読む | — |
| `c_myKarte`（会員のカルテ・設計35） | 会員がホームを開いたときと、タブを開いたとき＝**起動ごとに最大1回**（画面側で持つ）。MEMBER_KARTE が 'on' のときだけ。GAS へ送り直さない（EDGE_MAP に載せない） | ❌ |

★`ctx`（`waitUntil`）は**すべての handler に一律で渡る**。
　「`ctx` があるから比べる」にしてはいけない。入口の意思は別に渡す。

★書き込みの直後35分は、画面がWorkerではなくGASへ直接聞く。
　＝**予約・取消の直後はWorkerに来ない**（shadow で見たい場面がいちばん観測しにくい）。
　★設計43（2026-11-13・スイッチ WL_DEFAULT_ON=false・`?wl=1` の端末だけ）：予約・取消・変更の後は、残数・予約一覧は Worker へ戻し、
　　空き枠だけ「書き込みの後に読み始めた写し」と Worker が比べられるまで GAS（I78）。枠の写しが追いつくのは
　　設計42 のすぐ押し出し（約30秒）か10分ごとの押し出し。それまで枠は GAS（上限は今と同じ35分）。
　★設計45（スイッチ LB_EDGE_DEFER・既定オフ）：オンのとき予約・取消・変更の写しは応答の後ろ（一回限りトリガー）で送る。
　　その間、**別の端末・トレーナーの画面**も、その会員の残数・予約一覧は Worker が答えず GAS（I79）。
　　オーナー・トレーナーの一覧は誰か1人の書き込みで GAS に落ちる（写しが届くまで）。書き込みをした端末は今と同じ35分 GAS
　★設計45b（スイッチ LB_NOTIFY_DEFER・既定オフ）：オンのとき予約の会員宛・トレーナー宛、取消の会員宛・担当宛の LINE は応答の後ろ
　　（一回限りトリガーの起動の遅れ＝本番の分布は未計測・最悪は TICK で約6分半・WARM で約15分）。その枠のトレーナーへの取消は今どおり応答の前

---

## 7. 天井（構造的な上限）

| | 上限 | いまの状況 | 当たったら |
|---|---|---|---|
| GASのトリガー | 20本 | コード上21ハンドラ分。既存に相乗りで回避（設計45 の写しの後ろ回しも既存の一回限りトリガーと5分ごとの同期に相乗り・`gas-edge-defer.test.js` ⑦ が集合を固定。設計45b の LINE 通知の後ろ回しも同じ2つと `warmupCache` に相乗り・`gas-notify-defer.test.js` ⑥） | 新しい定期処理を作れない |
| Script Property の数 | 画面から追加できるのは50個まで（2026-11-17 に超えた） | ★設計47 でコードが書く記録を3つ足した（`LB_WRITE_LOCK_COUNT`・`LB_EDGE_PUSH_COUNT`・`LB_LOCK_COUNT_BAD`）。スイッチは画面で足さず、エディタで押す関数で切り替える（`lbEdgeDeferSetOn/Off`・`lbNotifyDeferSetOn/Off`・`lbConsecSetOn` 等）。★エディタでコードを一時的に書き換えて実行しない（11/17 に HEAD を古い版で上書きした）。Off は値を消す（`'0'` を置かない） | 画面から新しいスイッチを足せない |
| 設計54 S1a | **トリガーを作らない**（一回限りトリガーと5分ごとの同期の最後に相乗り）。booking_metrics の6列目はセル1つ（既定の26列なら増えない＝グリッドの増分は 最大行数×max(0, 6−最大列数)）。送る段の1回は最大500行の読み・50件の送信 | 実装前に作業依頼 `remaining {wsPrecheck}` でグリッドと行数を数える | 超えたら次の回に続きから（カーソル） |
| 自己修理 P1 | **専用のトリガーは作らない**（lbNudgeDaily に相乗り）。修理で足すのは足した後 18本以下まで（普段の本数を超えない） | 本番は 2026-10-09 時点で18本（設計15） | `skip_near_limit`（escalated） |
| Script Property 1つの値 | 9KB | 通知の待ち `LB_NOTIFY_PENDING` は 16件・8,000バイト（UTF-8）まで | 超えたら今の経路（応答の前に送る） |
| LINE通知の送り直し | 1回8件・90秒 | `warmupCache`（10分ごと）の末尾に相乗り。開始3分超なら見送り | 次の10分へ回る |
| GASのバージョン | 200・削除不可（上限は「本数」＝`clasp versions` の件数。GASエディタの「番号」ではない） | 2026-10-06 の確認で 109本（以前ここにあった「188」は番号を本数と読み違えた値）。いまの本数は**未確認**（唯一の出所は GitHub Actions「GASを反映する」のログ）。床だけは分かる：反映ワークフローは残り5本以下で止まる＝直前の反映が成功していれば残り6本以上 | プロジェクト作り直し＝**LIFFのURLが変わる** |
| GASの実行時間 | 6分 | 押し出しは打ち切り方式 | 途中から再開する作りが必須 |
| D1の書き込み | 1日10万行 | 差分同期で抑えている | 書き込みが止まる |
| D1の読み取り | 1日500万行 | 余裕 | — |
| トレーニングの1回（`k_addTraining`・設計38。`k_editTraining`（設計58）は固定の文が9つ多い） | 種目20（数字の無い種目を含む）・本セット10/ord・ドロップ3/セット・合計60（ドロップを数える）・本文16KB | 1回の保存の文の数は最大でおよそ150（本セットごとに付加の文が1つ増える・以前はおよそ63）。D1 の公式の上限（2026-11-07 確認）：**batch() は文の数に関わらず1回の呼び出しで1クエリと数える**（呼び出しあたり Paid 1000／Free 50）。文ごとの上限＝引数100・文の長さ100KB。**30秒は batch 全体にかかる** | 30秒を超えれば保存全体が失敗（全部か無か）。関門③で最大に近い記録を1件保存して時間を確かめる |
| 種目の一覧（`k_exercises`） | 表の生きた行500件・返すのも500件 | 2026-11-06 に作成 | 新しい名前・消した行の復活は EX_LIMIT。読みは表の主キー順に最大501行だけ（記録のセットは走査しない） |
★だから**反映はまとめて1回**。小分けに頼むと天井に当たる。

---

## 8. 変更の型（★これを始める前に読む）

### ★GASのコードを変えたとき
```
□ そのファイルの**版の印を上げる**（LB_EDGE_BUILD / LB_AUDIT_BUILD / LB_JOB_BUILD 等）
   ★上げ忘れると「反映済みの変更を未反映だと誤認」する（2026-10-09 に踏んだ）
□ 反映は**まとめて1回**（バージョン上限200・削除不可）
□ 反映後、出力の版の印が上がっているかを必ず確かめる
```

### 表に列を足すとき
```
□ 既定値を入れない（既定で埋めると「まだ作り直していない」が「正常」に化ける）
□ その列を読む側は、NULL のとき**答えない**か（§0）
□ 書く側と読む側の**範囲**がそろっているか（§5）
□ 照合（quota-verify）も同じ条件で見るか
□ 不変条件を足したら §3 に検査を紐付ける
```

### 読む経路を増やすとき
```
□ その経路は**何回呼ばれるか**（§6）。重い処理を足してよい経路か
□ 入口の意思をどう渡すか（`ctx` の有無で判断しない）
□ 新しい検査は**実際に走るか**。走った回数を出すか
□ 合否の式（`allGood` 等）にその結果が入っているか
   ★2026-10-09、入っていなかったため「不一致があっても全員一致」と出た
```

### 値を別の場所から作り直すとき
```
□ 両側の**語彙表**を作る（§4）。変換している場所を grep で見つける
□ 「行が無い」の意味が両側で同じか
□ 形の鍵を**ソースから機械で取り出して**突き合わせる（目で見ると漏れる）
□ 実データで突き合わせる段（shadow）を必ず挟む
```

### 検査を足すとき
```
□ 実装を1行壊して、**落ちることを確かめる**
□ 条件（if）ごと見ているか。SQLやコードの字面だけを見ていないか
□ 走った回数を出す（0件が「一致」なのか「走っていない」のか区別できるように）
```

---

## 8-2. ★作業依頼（job）の出し方と、結果の読み方

**結果はCEOが自分で読める。オーナーに貼ってもらう必要はない。**
★2026-10-16 から**読み取りの鍵が必須**。このリポジトリは**一般公開**で、ops/job.json の requestId は誰でも見える。
　日次点検の結果に顧客の氏名が入る回があった＝IDだけを鍵にすると外から読めた。

```
0. 読み取りの鍵を手元で作る（乱数24バイトの16進。公開しない）。そのSHA-256を _rk にする
1. ops/job.json を書き換えて push
     {"op":"quotaBuild","requestId":"job-<時刻>-<乱数>","args":{…, "_rk":"<鍵のSHA-256>"}}
     ★公開するのはハッシュ（_rk）だけ。Worker が別の列に移し、GAS に渡す args からは外す
     ★_rk が無い・形が違う依頼は登録で断る（400 NO_READ_KEY・Actions が赤くなる）
     ★requestId は 24〜64文字の [A-Za-z0-9_-]
     ★op は許可一覧にあるものだけ（.github/workflows/edge-job.yml の case 行）
2. GitHub Actions が Worker へ登録する（★登録するだけ。結果は読まない）
3. GAS の edgeJobPoll が**1分ごと**に拾って実行し、結果を Worker へ返す
4. 読む： curl -sS -H "X-Job-Read-Key: <KEY>" "<EDGE_URL>/jobs/<requestId>"
     ★鍵が無い・違う・鍵の無い（古い）依頼は、状態だけ返して結果は返さない（withheld）
     ★EDGE_URL は liff/index.html に平文＝顧客のブラウザが叩く公開情報
     ★15秒ごとに最大10分ポーリングする（foreground の sleep は禁止なので背景で）
```

### ★作り直しの順序
```
① 入力を押す           {"op":"pushAll"}
② 作り直す             {"op":"quotaBuild","args":{"write":true,"alloc":true,"from":…,"to":…}}
③ 照合                 {"op":"quotaBuild","args":{"verify":true}}
```

### ★①で `source_version` が進むとは限らない（2026-10-09 に踏んだ）
```
pushAll は**差分同期**。内容が変わっていない行は書かない（same() で省く）
→ 実際にD1へ書いた会員だけ source_version が進む
→ 実測：契約88件中0件を書込（88件は変更なし）＝**1人も進まなかった**
★pushAll は削除差分を消さない。削除まで確定するのは**日次の完全同期**

★完全同期でも、中身が変わっていなければ `source_version` は進まない（2026-10-11・設計16）
  完全同期は全行を**書く**（synced_at が古い行を消す判断に要る）が、
  **世代を進めるのは中身が変わった会員だけ**。この2つは別の判断である。
  以前は同じ条件で判定していたため、毎晩4時に全員の世代が進み、
  **追いついている会員が 40名 → 3名 に落ちた**（顧客には写しが出るので害は無いが移行が進まない）
★`calcMeta`（契約表の列の並び）は全員を進める入力。
  進めるかどうかは `changedInput` で判断する（書いた文の数では判断しない）
```
`markBuiltStatement` は「いまの source ＝ 自分が読んだ世代」のときだけ印を進めるので、
source が 0 なら built も 0 ＝ 照合は `VERSION_NOT_BUILT` で全員を飛ばす。
**止まるのは正しい動き**（答えない側に倒れた）。「一致」と出るほうが危険だった。

### ★世代表を既存の入力へ後付けするとき（bootstrap）
```
□ **最初の作り直しより前に**基準世代を入れる（migration で）
□ 対象は作り直しと同じ集合（calc_contract_rows に載っている customer_id）
□ 基準は source=1 / built=0
□ ★既存の 0/0 の行も 1/0 に直す
   （作り直しは行が無ければ 0/0 を読み、その値をそのまま INSERT するため、
     一度でも作り直しが走っていれば 0/0 の行が既に在る。
     DO NOTHING では何も起きない＝2026-10-09 に作りかけた）
□ source>0 または built>0 の行は上書きしない
□ seed の直後は必ず not_built ＝ 顧客には答えない
□ seed のあと withAlloc=1 で全員を作り直し、そのあとに照合する
□ 基準にする入力は、できれば**完全同期のあと**の状態を採る
   （差分同期のあとでも、照合で「D1にだけ残った行 0」なら取り残しは無い）
```

### 書き込みを伴う依頼
```
quotaBuild で書くなら {"write":true,"alloc":true} の**両方**が必須
  （alloc なしは 400 で弾かれる。枠だけ作ると used が古いまま）
範囲は {"from":"2026-09","to":"2026-12"}
  ★狭いと枠が0行になる（2026-01〜08 を指定すると枠0行・引当1件）
```

### 合言葉が要る窓口（CEOは叩けない）
```
POST /jobs（登録・受け取り・報告）／ /quota/status ／ /quota/build ／
/quota/verify ／ /ingest
→ これらは GAS か GitHub Actions が叩く。CEOは作業依頼を経由する
```

---

## 9. この文書の使い方

```
設計を書く前        §0〜§7 を読む
Codex に頼む前      この文書を渡す（同じ指摘を繰り返させない）
不変条件を足した    §3 に検査を紐付けて書く
事実が変わった      その場で直す（古い地図は無いより悪い）
```

★**未確認のものは「未確認」と書く。** 推測を事実として書くと、この文書が嘘の源になる。
　いまの未確認：`pack_id` 列の本番の状態（§4）。
