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
顧客に出る残数          ★まだGASが計算した写し（member_home）
```
段階3-b で、残数だけを「D1の行から引き算」へ移している（設計 10〜13）。

---

## 2. 表の地図（誰が書くか・誰が読むか）

### 2-1. Googleからの写し（GASが押し出す・Workerは読むだけ）
| 表 | 主キー | 書くのは | 読むのは | 消える条件 |
|---|---|---|---|---|
| `customers` | customer_id | GAS（押し出し） | boot / compat | 完全同期で含まれなければ消える |
| `contracts` | contract_id | GAS | 承認待ちの数 | 同 |
| `reservations` | reservation_id | GAS（★`scope:'customer'` で会員ぶん入れ替え） | boot / compat / **当月の件数** | 同・会員ぶんは世代で入れ替え |
| `recurring_patterns` | pattern_id | GAS | compat | 同（`allowEmpty` を名乗れる唯一の表） |
| `trainers` | trainer_id | GAS | boot | 同 |
| `slots_cache` | trainer_id | GAS | 空き枠 | `keepStale`＝消さない |
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
| `customer_sync_version` | customer_id | ingest（source）／quotaBuild（built） | 鮮度の判定 | — |
| `remain_shadow_slot` / `remain_shadow` / `remain_shadow_sample` | 設計12 | shadow | 心拍 | — |

### 2-3b. 顧客カルテ（設計28・★Worker だけが書く・D1 が唯一の正本）
| 表 | 主キー | 書くのは | 読むのは | 備考 |
|---|---|---|---|---|
| `karte_profile` / `karte_safety` | customer_id | `k_saveProfile` / `k_saveSafety`（rev） | `k_summary` / `k_safety` | 安全面は同意の JOIN でだけ読む |
| `karte_consent` / `karte_consent_log` | (customer_id, kind) / id | `k_saveConsent`（撤回で safety を同じ batch で消す） | 同意の判定 | log は追記だけ |
| `karte_notes` / `karte_tr_sessions` / `karte_tr_sets` | TEXT の ID（Worker が作る） | `k_add*` / `k_edit*` / `k_delete*`（deleted_at） | `k_notes` / `k_training` | 1行1セット |
| `karte_member_notes` | mnote_id（Worker が作る） | `k_addTraining`（member・トレーニングと同じ batch）／`k_saveMemberNote`（3つの形・rev）／`k_deleteMemberNote`・`k_deleteTraining`（同じ session の枚を同じ batch で deleted_at） | `buildMemberKarte`（`c_myKarte`・`k_memberPreview`） | ★会員に見せる文だけ（社内メモと別の表・設計35）。session に1枚（部分 UNIQUE・生きた行）／session なしは NULL。顧客・日付は参照先の session と一致（見張り）。req_id 列は持たない |
| `karte_exercises` | name（前後の空白を落とした1〜50字） | `k_saveExercise`（追加・部位の変更・消した行の復活＝名前と部位だけ・後勝ち・rev なし・控えは karte_revisions の before_json に **part と deleted_at**（名前は row_id）） | `k_exercises`（★**表の生きた行だけ**・500件まで・入りきらなければ truncated。karte_tr_sets は読まない） | ★**全トレーナー・全顧客で共有**（顧客に結び付かない）。part は CHECK（chest/legs/back/shoulder/arm/core/other）・NOT NULL。karte_tr_sets.exercise（自由文）は変えない・読まない（既存の名前はその顧客の「最近の種目」にだけ出る）。生きた行は500まで（新しい名前・消した行の復活は EX_LIMIT 409） |
| `karte_revisions` | id | 編集・削除の前の中身 | 監査 | 安全面の中身は入れない |
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
| `notify_retry`（既存・設計17） | id | `_lbNqOnFail`／`_lbNqDefer`（キャンセルの時間予算を超えた残り・設計36） | `lbNotifyRetryTick` | ★設計36 から：終わった行（sent・stale・closed）の本文 text を30日で空にする（取り分けのロックと同じ1回の書き込み・1回50行まで）。行は消さない |

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
| I48 | **健康情報は同意の記録があるときだけ**書ける・読める（見張りと書く文の両方に条件・読みは JOIN）。撤回は同じ batch で中身を消す。履歴に中身を残さない | `karte.test.js` 3-1〜3-10 |
| I49 | **書き込みは全部か無か**：回数は先行 batch（失敗の要求も数える）／本体は見張りの表の CHECK 違反で巻き戻す／二重送信は requests 表（成功だけ・同じ鍵の再送は保存した応答） | `karte.test.js` 2-2・2-3・8-1〜8-4、`body-d1.test.js` 2-3・2-7 |
| I50 | **体の記録の合成は GAS の maReadBody_／maReadGoal_ と同じ答え**（元のコードを vm で動かしてランダムに突き合わせる）。d1 の行はシートの行より後 | `body-d1.test.js` 1-1〜1-3 |
| I51 | **体の記録の新しい書き込みは凍結（body_freeze）の後だけ**。sheet の行は書き換えない（体脂肪率は d1 の行だけ・無ければ known_weight で作る）。読むのは verified の凍結＋d1 | `karte.test.js` 5-1〜5-6、`body-d1.test.js` 2-1・2-4〜2-6・3-1〜3-12 |
| I52 | 退会の起算日は追記だけの表。交互（withdrawn↔rejoined）・最後の行以降・cancel は最後の1行だけ・オーナーだけ・実在する今日以前の日付 | `karte.test.js` 7-1〜7-12 |
| I53 | **D1 から残数を答えるのは、計算の材料4つ（calcContracts・calcMeta・calcReservations・opening）の sync_state が同じ batchId で、45分未満のときだけ**。欠け・数でない・未来5分超・回の不一致・45分以上は写し（copy:calc_input_*）。会員ごとの作り直し（/quota/rebuild）は全体の印を押さない（設計30） | `read-on.test.js` ⑧-1〜⑧-6・⑧-e1〜⑧-e6 |
| I54 | **カルテの保存は、要求に鍵がある列だけを置き換える**（hearing・painMap・diagnosis と既存の列。null・空は消す、鍵が無ければそのまま）＝古い画面からの保存で新しい項目を消さない（設計31） | `karte.test.js` 10-3・10-9・10-20 |
| I55 | **健康情報は karte_safety にだけ置く**：変化の理由（REASONS）に健康の選択肢を入れない・知らない鍵は400。一覧の「注意あり」は同意の JOIN の中で SQL が決め、部位や強さは返さない。改訂の控えにヒアリングの自由文を入れない。**自由文（メモ・セットのメモ・ヒアリング）は健康情報を書く場所ではない＝入力欄の真下に「痛み・診断・服薬は『注意すること』へ」を置き、よく使うメモの選択肢に健康の言葉を入れない**（サーバーで意味は判定しない・設計31 確定事項2）（設計31） | `liff-karte.test.js` 14-8・14-10、`karte.test.js` 10-6・10-7・10-12・10-14・10-15・10-18、`liff-karte.test.js` 8-5・8-7 |
| I56 | **画面の固定表（目的・部位・痛み・タグ・理由）の鍵と表示名は Worker（lib/karte-hearing.js）と同じ** | `liff-karte.test.js` 7-1 |
| I57 | **トレーニングの記録は✓のセットだけ送る**（前回の呼び出し・複製・下書きの復元でも✓の初期値は false）。合計60セットまで（画面と Worker の TOTAL_SETS）（設計33）。★回数が空のセットは送らない／重量の空は自重＝0（I61） | `liff-karte.test.js` 10-1・10-5・10-6・10-9、`karte.test.js` 11-2 |
| I58 | **トレーニングの下書きは localStorage（トレーナー×顧客）が正本**。氏名を入れない・24時間で実際に消す・中身の顧客が違えば戻さない。送ったが結果が分からないときは中身と clientReqId を固定し、同じ組でだけ送り直す。トークン切れの退避（sessionStorage）に中身を入れない（設計33） | `liff-karte.test.js` 10-7・10-8・10-10〜10-12・10-14〜10-17 |
| I59 | **「前回」は入力中の日付より前の、session_id 単位の直近1回**（同じ日の2回を混ぜない・直近20回の中だけ）（設計33） | `liff-karte.test.js` 10-2・10-3 |
| I60 | **種目の一覧（karte_exercises）は全員で共有し、書くのは `k_saveExercise` だけ**（名前と部位だけ・知らない鍵は400・名前は前後の空白を落とした1〜50字＝画面と同じ正規化・isKarteWrite に当たる＝I46/I49 の守り）。**読みは表の生きた行だけ**（記録の自由文 karte_tr_sets は読まない＝走査の負荷と、自由文の個人・健康の情報を顧客と切り離して全員に並べないため・CEO 決定）。500件まで・切れたら truncated（画面は「一部だけ表示・見つからなければ名前を入力」）。**生きた行は500まで**：事前の検査も batch の見張りも「同名の生きた行が無い、かつ生きた行が500以上」で止める（消した行の復活も数える）。**部位の鍵は画面（PART_KEYS）＝ Worker（lib/karte-exercises.js の EXERCISE_PARTS）＝ 表の CHECK**。画面の部位は「一覧の部位 → 無ければ名前からの推定」。その顧客の「最近の種目」から選んだ名前が一覧に無ければ、その場で部位を選んで登録できる（任意・ダイアログなし）。種目名は健康の言葉を書く場所ではない（I55・注記） | `karte-exercises.test.js` E1-1〜E1-5・E2-1〜E2-3・E3-1〜E3-4・E4-1〜E4-9・E5-1〜E5-6・E6-1〜E6-4、`liff-karte-exercises.test.js` P0-1・P1-1〜P8-2 |
| I61 | **自重は重量0で保存する**：画面は重量が空の✓を 0 で送る（回数が空は送らない・「記録されない入力」に重量の空を数えない）。表示は 0 を「自重」（トレーナーの記録・見る側・写す画面・会員の画面 4言語）。写す・前回の値では 0 を空に戻す。D1 の weight_kg は作り直さない（0 は CHECK を通る） | `karte-exercises.test.js` E7-1〜E7-4、`liff-karte-exercises.test.js` B1-1〜B3-2、`liff-member-karte.test.js` 9-1・9-2 |
| I62 | **カルテの書き込みは送る前にトークンの発行時刻を見る**：59分（TOKEN_REFRESH_S=3540・決定0142）を超えていたら送らずに、入力を端末に退避 → 読み直し（`liff.logout()` は LINE アプリの外＝isInClient()===false のときだけ。アプリの中で logout すると最初のページに戻った）。401 が返った経路も同じ。**入力のあるフォームは全部、読み直し後に同じ画面・同じカードで戻す**（トレーニング・お客様の欄・指導メモは下書き、ヒアリング・測定・メモ・振り返り・目標線・退会の発効日・お客様の見え方の編集・種目の登録/部位を直す途中は sessionStorage の退避。戻すのは退避の顧客＝開く顧客のときだけ・**氏名を残さない**・30分を過ぎた退避は次の起動で捨てる・読んだら消す。安全面（健康情報）は退避しない＝I48）。読み直しの印（sessionStorage `karte_reauth`・時刻）は 0≦経過<10分のときだけ効き、未来の時刻は消す。**新しいトークンで書けたときに消す**。印が効く間は画面で判定せず送り、また 401 なら読み直さず「LINE から開き直して」（無限に読み直さない）。Worker の上限は1時間（I46・決定0142） | `liff-karte-exercises.test.js` S1-1〜S12-1、`liff-member-karte.test.js` 8b-1〜8b-6、`liff-karte.test.js` 4-1〜4-5 |
| I-M1 | **会員のカルテ（c_myKarte）の本人は who.customerId だけで決める。body を一切読まない**（customerId・noteId・sessionId 等で他人を指させない）。customer 以外・who.customerId が無ければ 403（設計35） | `member-karte.test.js` 1-7〜1-15・2-17・5-7 |
| I-M2 | **応答は専用の allowlist で組み立てる**（k_ の応答を流用して落とす形にしない）。SQL の段階で列を選ぶ（全部の列を取らない）。値が無いものは null／空配列（推測で埋めない）。体の記録は I51 のまま（verified の凍結＋d1） | `member-karte.test.js` 2-3〜2-16・5-3 |
| I-M3 | **社内メモ（karte_notes の本文・次回の計画・確かめること・理由）・健康情報（karte_safety・同意）・セットのメモ・ヒアリングの自由文・契約の金額と報酬を読まない・返さない**。契約は I53 を満たすときだけ・期間の列が無ければ null・担当は名簿の表示名（当たらなければ null）。includeContract=false なら契約の SQL を1本も出さない | `member-karte.test.js` 2-2・3-1〜3-4・4-1〜4-3・5-1〜5-5・6-6 |
| I-M4 | **会員に見せる文は karte_member_notes にだけ書く**。トレーニングと一緒の枚は同じ batch（全部か無か・ハッシュに正規化した member を含める）。session のある枚は参照先の生きた session と顧客・日付が一致（見張りで batch ごと戻す）・読むときも生きた session と JOIN。トレーニングを消すと同じ batch で枚も消える。編集・削除は本人か owner（owner の上書きは section=member_note_owner_override） | `member-karte.test.js` 7-1〜7-9・8-0〜8-12・9-1〜9-2・10-1〜10-10・11-1〜11-10 |
| I-M5 | **MEMBER_KARTE が厳密に 'on' でなければ c_myKarte はサーバーで必ず 503**（入口で認証より前に止め、窓口の中でももう一度確かめる）。k_memberPreview・k_saveMemberNote は止めない（KARTE の守りだけ）。起動の印 memberKarte は env だけで決める真偽値 | `member-karte.test.js` 1-1〜1-6・12-1〜12-4・13-1 |
| I-M6 | **verified でない会員の行は LINE の ID を送らない**（押し出し側。D1 で customer にならない＝c_myKarte に届かない）。Worker 側の確認は「LINE の ID が無い行は guest」 | `member-karte.test.js` 1-15（GAS 側の検査は gas/ の担当が足す） |
| I-M7 | **会員本人と「お客様の見え方」は同じ組み立て関数（buildMemberKarte）を通る**。見え方は共有の範囲（canSeeKarteShared）で開け、契約は担当の範囲（canSeeCustomer）のときだけ。ID（mnoteId・rev・sessionId・authorIsMe）は見え方にだけ付く | `member-karte.test.js` 5-6・6-1〜6-8 |
| I-M8 | **access_log に中身を書かない**。会員本人の閲覧は trainer_id=NULL・role='customer'・section='member_karte'・action='c_myKarte'・req_id=NULL。失敗の console に ID を出さない | `member-karte.test.js` 2-18・6-8・8-10・10-5 |
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
| `c_myKarte`（会員のカルテ・設計35） | 会員がホームを開いたときと、タブを開いたとき＝**起動ごとに最大1回**（画面側で持つ）。MEMBER_KARTE が 'on' のときだけ。GAS へ送り直さない（EDGE_MAP に載せない） | ❌ |

★`ctx`（`waitUntil`）は**すべての handler に一律で渡る**。
　「`ctx` があるから比べる」にしてはいけない。入口の意思は別に渡す。

★書き込みの直後35分は、画面がWorkerではなくGASへ直接聞く。
　＝**予約・取消の直後はWorkerに来ない**（shadow で見たい場面がいちばん観測しにくい）。

---

## 7. 天井（構造的な上限）

| | 上限 | いまの状況 | 当たったら |
|---|---|---|---|
| GASのトリガー | 20本 | コード上21ハンドラ分。既存に相乗りで回避 | 新しい定期処理を作れない |
| LINE通知の送り直し | 1回8件・90秒 | `warmupCache`（10分ごと）の末尾に相乗り。開始3分超なら見送り | 次の10分へ回る |
| GASのバージョン | 200・削除不可 | 2026-10-02 に188まで使った | プロジェクト作り直し＝**LIFFのURLが変わる** |
| GASの実行時間 | 6分 | 押し出しは打ち切り方式 | 途中から再開する作りが必須 |
| D1の書き込み | 1日10万行 | 差分同期で抑えている | 書き込みが止まる |
| D1の読み取り | 1日500万行 | 余裕 | — |
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
