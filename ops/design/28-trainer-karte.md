# 設計28：トレーナー用の顧客カルテ（段1・トレーナー画面だけ）

2026-11-03 ／ オーナー決定は 30_projects/personal-training/customer-karte/memory.md。
段階公開：**段1＝トレーナー・オーナーだけ** → 運用 → 段3＝顧客に「からだ」だけを公開（別設計）。

## 0. 倒れる向き
- 見せてよいか判定できないときは**見せない**（403）。保存に失敗したら**保存したと言わない**
- 健康情報（安全面）は、その会員の**同意が記録されているときだけ**書ける・見せる。判定できなければ「同意待ち」

## 1. 事実（既存）
- Worker：入口で LINE の ID トークンを検証（worker/src/auth.js `verifyIdToken`）→ 役割を確定（trainers に載れば trainer/owner、customers なら customer）。操作は**許可表**（worker/src/perms.js）に載っていなければ通らない。owner は trainer の上位互換
- 既にある窓口（LIFF 未使用）：`customerDetail`（顧客・残数・体組成・固定枠・予約）、`contractList`（契約履歴・オーナーだけに粗利・他トレーナーの報酬を隠す）（worker/src/routes/customer.js）
- 体の記録の正本：meal-ai 用シート `body_log`（GAS MealAi.js）。InBody 6項目（体重・体脂肪率・体脂肪量・除脂肪量・体水分量・内臓脂肪）。LIFF の InBody カード（`line_maInBodyCard`/`line_maSaveInBody`）と karte/index.html（`ma_series`）が GAS を読む。D1 `body_records` は列が足りず未使用
- 担当の判定：GAS `_lbTrainerMaySeeCustomer`・Worker 側にも同じ規則（オーナーは全員・担当なしは誰でも・他人の担当は不可）
- 予約 LIFF の顧客詳細 `renderCustomerDetail`（liff/index.html 1890〜）。カルテへのボタンが InBody カードの中にあり、カードが落ちると消える（1793）
- LIFF の書き込みは今は GAS 直（EDGE_WRITE_ACTIONS → null）。**Worker が D1 に書く窓口はまだ本番で使っていない**
- 契約の正本は請求ブック「フォームの回答 1」（段1では読むだけ・書かない）

## 2. 範囲（段1）
| 区分 | 中身 | 入力の場面 |
|---|---|---|
| ① 基本 | 名前・年齢・性別・身長・入会日・担当・契約・残数・支払い待ち・振替権・次回予約・入会のきっかけ（取れれば） | 自動（契約・予約・顧客マスタ） |
| ② 目標・動機 | 目標（文）・目標の数値と期限・理由・過去のジム経験と続かなかった理由 | 入会時（トレーナー） |
| ③ 安全面 | 既往歴・ケガ・痛む部位・服薬・運動制限 | 入会時（トレーナー）。**同意の記録があるときだけ** |
| ⑤ 身体測定 | InBody 6項目＋**骨格筋量**＋**周囲径5か所**（胸囲・上腕・ウエスト・ヒップ・太もも）。毎回必須にしない | 測定時（トレーナー） |
| ⑦ トレーニング | **主要種目だけ**（初期：ベンチプレス・スクワット・デッドリフト・ラットプル・ショルダープレス／設定で増減）重量×回数×セット＋フォームのメモ。推定1RM＝Epley（重量×(1＋回数/30)・回数1は重量そのもの・回数>12は出さない） | 毎回（トレーナー） |
| ⑧ セッションメモ | 体調（良い／普通／悪い）・話した内容・次回やること | 毎回（トレーナー） |
| ⑨ グラフ | 体重・体脂肪率・ウエスト・胸囲・主要種目の推定1RM | 自動 |
| 一覧 | 次の予約が無い／記録が止まっている／契約の終了・残数切れが近い／支払い待ち | 自動 |
| 後で | ④生活習慣（問診票）・⑥写真・全種目の記録・食事・契約の登録/更新・顧客への公開 | — |

## 3. データ（関門①を受けて改訂・v4）

### 3-1. 体の記録（⑤）と目標線は **D1 が唯一の正本**（2026-11-03 オーナー「最速化したく、D1ベースで」・v4）
- 旧案C（シートのまま）は取り下げ。v3（シートから15分ごとに写し続ける）は、書き込み先が2つに割れて安定ID・差分・順序・二重登録・6分制限の穴が出た（関門①再審査）→ **書き込み口を全部 D1 に向け、シートは切り替えの時点で凍結して一度だけ写す**

**書き込み口（すべて D1 へ）**
| 書き込み口 | 段1 |
|---|---|
| トレーナーの InBody 入力 | 新しい画面 → Worker `k_addMeasurement`（D1）。★**サーバー側の関門：body_freeze に state が frozen 以上の行が1つも無い（＝切り替え前）なら BODY_NOT_READY で書かない**（画面は入力欄を「準備中」にし、従来の InBody カード＝GAS 経由を出す）。切り替えより前に D1 とシートへ並行して書かれることを無くす。**古い画面が GAS の `line_maSaveInBody` を呼んでも、切り替え後（フラグ 'd1'）は GAS が body_log に書かず Worker へ転送**（切り替え前の 'sheet' は今までどおり body_log）（GAS→Worker は既存の合言葉つきの入口と同じ方式）。転送は client_req_id 付き＝二重にならない |
| 会員が LINE で体重（`maLogWeight_` 547） | GAS は body_log に appendRow せず、**Worker の入口へ転送して D1 に書く** |
| 会員が LINE で体脂肪率（`maLogFat_` 945・その日の行を書き換え） | 同じく Worker へ。D1 側で「その会員のその日の最後の行」に体脂肪率と除脂肪を足す（同日の行が無ければ『先に体重を』の今の応答のまま） |
| 目標線（meal_goals／goal_phases・**いまはシートを手で編集**） | カルテの画面から入力（`k_saveGoalLine`）。シートの編集は切り替え以降は使わない（オーナーに周知） |
- LINE ボットの「前回 ○kg」は GAS のキャッシュではなく Worker から引く（同じ D1 を見る）

**一度だけの写し（切り替えの手順・2段で凍結を確実にする）**
1. **移行版の GAS を反映**（まとめ反映の1回）：書き込み口（`maLogWeight_`・`maLogFat_`・`line_maSaveInBody`・`maSaveInBody_`）がすべて**共通のロック**（ScriptLock）の中で切替フラグ `BODY_WRITE_TARGET`（Script Properties・既定 'sheet'）を見る。'sheet' の間は今までどおり body_log、'd1' なら Worker へ転送。`maDedupeBodyLog()` は実行禁止。この時点では何も変わらない
2. **待つ**：旧版の最大実行時間（6分）を超えて待ち、LINE の webhook が指す GAS の URL が移行版の配信（同じデプロイの新しい版）であることを確かめる
3. **切り替え** `bodyCutover()`（作業依頼）：**共通のロックの中で**、①フラグを 'd1' に ②body_log・meal_goals・goal_phases の値を**凍結用のシート**（`body_log__freeze_<freeze_id>` 等）へ丸ごとコピー ③行数と全体のハッシュを `body_freeze` に記録（state='frozen'）。ロックを離したら、以後の書き込みは全部 D1
4. **写し**：凍結用のシートだけを読む（元のシートは読まない）。鍵＝`<freeze_id>:<シート名>:<行の順番>`（シート名を含める＝meal_goals と goal_phases が衝突しない）。分割して再開できる（どこまで写したかを記録）。**開始・各分割・終了で凍結用シートの行数とハッシュを確かめ、変わっていたらこの freeze_id を failed にして全部やり直す**。state：frozen → copying → copied
5. **突き合わせ**：凍結用シートを GAS の計算（maReadBody_ と同じ）に通した答えと、Worker の答え（その freeze_id の行だけ）を全会員×日付×項目×出所で比べる。目標線も。一致したら state='verified'、違えば 'failed'（切り替えない）
6. **読み先の切り替え**：Worker の読み取り（k_body・k_board・会員用）は **state='verified' の freeze_id の行＋origin='d1' の行**だけを使う。verified になるまで、カルテの「からだ」タブと一覧の「記録停止」は「準備中」。テスターの karte/index.html を Worker の会員用窓口（`myBodyRecords`）へ＝**関門③**（テスターだけ）
- `body_freeze`：freeze_id(PK)・state（frozen／copying／copied／verified／failed）・各シートの行数とハッシュ・写した位置・開始/終了時刻

**GAS → Worker の転送（Worker が落ちているとき）**
- 入口：Worker に**体の記録専用の入口**（`/body/write`）。既存の GAS→Worker と同じ方式（EDGE_URL・EDGE_SECRET・X-Ingest-Secret・muteHttpExceptions・200以外は失敗＝PushToEdge.js 41）。許す操作は addWeight／addFat／addInBody だけ・列と範囲を検査・冪等
- **同期で転送し、失敗したら成功の返信をしない**（LINE には「記録できませんでした。少し時間をおいてもう一度送ってください」）。キューや後からの push はしない（会員が送り直せば入る）
- client_req_id は**送り直しでも同じ値**：LINE の `webhookEventId＋操作の種類`／LIFF は画面が作った ID を再試行でも保つ
- Worker は保存済みで GAS が応答を受け取れなかった場合：同じ client_req_id の再送に同じ成功を返す（karte_requests と同じ仕組み）
- postback の二度押し防止（`maOnce_`・MealAi.js 887）は **Worker の成功の後に確定**し、失敗したら解除する（失敗後の同じ操作を二度押しとして捨てない）

**体脂肪率を同日の行に足す（D1）**
- ★**origin='sheet' の行（凍結から写した行）は決して書き換えない**（突き合わせの対象を変えない）。体脂肪率が足されるのは origin='d1' の行だけ
- GAS は転送のとき、**その日の体重**（GAS が今まで見ていたもの＝写しのキャッシュ／当日の行）を要求に含める（`known_weight_kg`）。切り替えの直前にシートへ体重を入れ、直後に体脂肪率を送った会員でも結びつけられるように
- D1 の処理（1つの batch）：
  ※ D1 は batch を1つずつトランザクションとして実行する（書き手は1つ・途中で他の batch が割り込まない＝Cloudflare の仕様）。1と2を同じ batch に入れるので、別の要求の体脂肪率と交互に混ざらない
  1. その会員のその日の **origin='d1'** の行のうち最後（サーバー採番の id が最大・削除済みを除く・体重あり）を、`UPDATE … SET body_fat_pct=?, lean_kg=ROUND(weight_kg*(1-?/100.0),1), rev=rev+1 WHERE id=(SELECT … ORDER BY id DESC LIMIT 1)` の**1文**で更新（除脂肪は同じ文の中で対象行の体重から計算）
  2. `INSERT … SELECT … WHERE ? IS NOT NULL AND NOT EXISTS (その会員のその日の origin='d1'・削除済みでない・体重ありの行)`：1で更新できなかったとき（＝d1 の行が無い）だけ、`known_weight_kg` で origin='d1'・source='self' の行を**体重と体脂肪率つきで新しく作る**（読み方の順序では d1 の行がシートの行より後＝その日の値はこの組になる）
  3. どちらも無ければ「先に体重を記録してください」（今の応答）
- 1が更新したら、2の NOT EXISTS が偽になり作らない（同じ batch の中で順に）

**/body/write の二重送信の防止**
- 表 `body_requests`：(channel（line／liff／gas_inbody）, client_req_id)(PK)・payload_hash・http_status・result_code・result_json（作った ID・体重/体脂肪率の数値だけ）・done_at
- **本体と同じ batch の先頭で** body_requests に INSERT。主キー違反（＝同じ要求が既に完了 or 並行中）なら batch 全体が巻き戻り、本体の UPDATE も rev も動かない → 引き直して、同じ payload_hash なら保存した結果を返す・違えば REQ_REUSED・まだ無ければ（並行中）少し待って引き直し、決まらなければ500（会員には「もう一度」）
- channel を主キーに含める＝会員の LINE と LIFF とトレーナー入力の ID が衝突しない（trainer_id を持たない要求も扱える）

**読み方（Worker・GAS と同じ答え）**
- 削除済み（deleted_at）の行は読まない。同じ日の複数行は**項目ごとに後勝ち・空欄では上書きしない**（maReadBody_ 1157〜1170）。順序は「origin='sheet' を sheet_order 順 → その後に origin='d1' を created_at・id 順」（凍結より後の書き込みは必ずシートの行より新しい）
- 出所：測定元の文字列に `inbody` を**含めば** i、それ以外は s（MealAi.js 1166 と同じ）
- 除脂肪が無く体重と体脂肪率があれば計算で補う・体脂肪量は 体重×体脂肪率（1183）
- 目標線：meal_goals は同じ会員の**最後の行**／goal_phases は『無効』を除き phase_no 順／有効な点が2つ未満なら meal_goals の線（MealAi.js 1200〜1245 と同じ）

**表**
- `body_measurements`：id・customer_id・measured_date・source_raw（測定元の文字列）・origin（sheet／d1）・origin_key（一意）・sheet_order・weight_kg・body_fat_pct・lean_kg・body_water_l・visceral_fat・skeletal_muscle_kg・chest_cm・arm_cm・waist_cm・hip_cm・thigh_cm・entered_by・client_req_id・created_at・updated_at・deleted_at・rev
- 値の範囲（CHECK・保存時の検査も同じ）：体重 20〜250（0.1）／体脂肪率 3〜60（0.1）／除脂肪 10〜150（0.1）／体水分 5〜100（0.1）／内臓脂肪 1〜30（整数）＝MealAi.js 1313 と同じ。**新しい項目**：骨格筋量 5〜80kg（0.1）／胸囲 50〜180cm（0.1）／上腕 15〜70cm（0.1）／ウエスト 40〜180cm（0.1）／ヒップ 50〜180cm（0.1）／太もも 25〜100cm（0.1）
- `body_goals`：id・customer_id・kind（meal_goal／phase）・phase_no・状態・開始/終了・体重・origin・origin_key・sheet_order・rev・updated_by・updated_at

**検査**
- 書き込み口（k_addMeasurement・line_maSaveInBody・maSaveInBody_・maLogWeight_・maLogFat_）がフラグ 'd1' でどれも D1 に入り、body_log が増えない／'sheet' の間は今までどおり
- 切り替えはロックの中でフラグと凍結コピーが同時／凍結用シートが写しの途中で変わったら failed
- Worker が落ちているとき：成功の返信をしない・maOnce_ が解除される・同じ webhookEventId の再送で二重にならない
- 体脂肪率と体重が同時でも、選ぶ・書くが1文／切り替え直後（体重はシート・体脂肪率は D1）でも known_weight_kg で結びつく／origin='sheet' の行は書き換わらない／origin='d1' の行も known_weight_kg も無ければ「先に体重を」
- k_addMeasurement は切り替え前（body_freeze が無い）だと BODY_NOT_READY
- /body/write：同じ client_req_id を2回送っても rev が1回しか増えない・違う中身は REQ_REUSED
- 体脂肪率は同日の最後の行に足される／同日の行が無ければ今の応答
- 写しを2回流しても増えない
- 突き合わせ：凍結したシートの GAS と Worker（sheet 由来だけ）が全会員で一致。不一致なら切り替えない
- 範囲外は CHECK で入らない
- 同じ日に sheet と d1 が混ざっても d1 が後勝ち

### 3-2. D1 の新しい表（カルテ固有のもの）
| 表 | 主キー・主な列 | 備考 |
|---|---|---|
| `karte_profile` | customer_id(PK)・goal_text・goal_value・goal_unit・goal_deadline・motive・history・rev・updated_by・updated_at | ②。更新は `WHERE customer_id=? AND rev=?` で rev+1、0件なら CONFLICT |
| `karte_consent` | (customer_id, kind)(PK)・state('agreed'/'revoked')・changed_at・method・recorded_by | 今の状態 |
| `karte_consent_log` | id・customer_id・kind・state・at・method・recorded_by | 同意・撤回・再同意の履歴（追記だけ） |
| `karte_safety` | customer_id(PK)・conditions・injuries・pain_sites・medication・restrictions・source('trainer'/'form')・rev・updated_by・updated_at | ③。下の 3-3 |
| `karte_notes` | note_id(PK)・customer_id・session_date・condition・body・next_plan・author_trainer_id(不変)・rev・created_at・edited_at・edited_by・deleted_at・deleted_by | ⑧ |
| `karte_tr_sessions` | session_id(PK)・customer_id・session_date・author_trainer_id・rev・created_at・deleted_at・deleted_by | ⑦の親 |
| `karte_tr_sets` | set_id(PK)・session_id・exercise・set_no・weight_kg・reps・note | **1行＝1セット**（40kg×10・45kg×8 を表せる）。推定1RMはセットごとに計算し、その日の最大をグラフに |
| `karte_revisions` | id・table_name・row_id・rev・before_json・changed_by・changed_at・reason | 編集・削除の前の中身（追記だけ）。**安全面の中身は入れない**（3-3） |
| `karte_requests` | (trainer_id, action, client_req_id)(PK)・payload_hash・result_id・**http_status・result_code・result_json**（**本体が確定した成功の応答だけ**。中身は操作ごとに列挙した安全な項目＝作った ID・新しい rev だけ。健康情報・メモ本文・名前は入れない）・done_at | 二重送信を弾く。本体の書き込みと**同じ batch**。同じ鍵の再送は保存した成功の応答をそのまま返す（本体を読み直さない）。失敗（競合・同意なし等）は保存されない＝再送はもう一度判定する。payload_hash が違えば REQ_REUSED |
| `karte_membership_events` | id(PK)・customer_id・kind（withdrawn／rejoined／cancel）・effective_date・target_event_id・recorded_by・recorded_at・reason | 退会後3年の起算日の正本（追記だけ・§6） |
| `karte_access_log` | id・at・trainer_id・role・customer_id・section・action・result（ok／denied／not_found／conflict／no_consent／rate_limited／error）・req_id | 中身は書かない。保存1年 |

- 編集・削除：書いた人（author_trainer_id＝不変の trainer_id）とオーナー。オーナーの代理修正は reason 必須
- 測定値は D1 の固定列（3-1 の body_measurements）。JSON の値の列は作らない

### 3-3. 安全面（要配慮個人情報）
- 書く：`INSERT … SELECT … WHERE EXISTS (SELECT 1 FROM karte_consent WHERE customer_id=? AND kind='health' AND state='agreed')`（更新も同じ条件＋rev）。**影響0件なら NO_CONSENT**。同意の確認と書き込みが1文
- 読む：`karte_safety JOIN karte_consent … state='agreed'` を SQL に置く。アプリで後から削らない
- 撤回：同じ batch で consent を revoked にし、karte_consent_log に追記し、**karte_safety の中身を消す**（行ごと削除）。再同意しても戻らない（もう一度聞き取る）。履歴（karte_revisions）にも中身は残さない
- バックアップ（D1 Time Travel 30日）には撤回前の中身が最大30日残る → 同意文の「退会・削除の窓口」で説明できる範囲として受容（オーナー確認）

## 4. 窓口（Worker・v2）
### 4-1. 名前と入口の検査
- カルテの操作は **`k_` で始める**。入口（worker/src/index.js）の
  - 役割の写しの鮮度検査（230〜241・いまは `^c_` だけ）を **`^(c_|k_)`** に広げる。`k_` は GAS へ落とす道が無いので、古ければ **ROLES_STALE（403）で何も返さない**
  - 停止スイッチ：`KARTE = "off"`（wrangler.toml）で `k_` を全部止める（EDGE_READS とは別）
- 許可表（perms.js）に `k_*: ['trainer']` だけ足す。customer・guest には何も足さない

### 4-2. 閲覧の範囲（2つの関数に分ける）
| 区分 | 誰が見られるか | 関数 |
|---|---|---|
| メモ・トレーニング・目標・安全面（同意あり）・体の記録 | **トレーナー全員**（オーナー決定）。ただし顧客が実在し照合済みであること | `canSeeKarteShared`（新） |
| 契約・残数・支払い待ち・連絡先（電話・メール）・顧客マスタの note | 担当＋担当なし・オーナーは全員（既存） | `canSeeCustomer`（既存・perms.js 147）。契約の報酬秘匿は既存（161） |

### 4-3. 窓口（タブごと・ページング）
| 操作 | 範囲 | 中身 |
|---|---|---|
| `k_summary` | 共有＋担当 | 概要（名前・目標・注意事項の要点・直近メモ1件・次回予約）。担当外なら契約・残数の欄は「担当外」 |
| `k_notes` / `k_training` | 共有 | 20件ずつ |
| `k_safety` | 共有＋同意 | 開いたときだけ取る（概要に全文を含めない） |
| `k_contract` | 担当 | 既存 contractList と同じ出し分け |
| `k_board` | 担当＋担当なし（**オーナーは全員**・2026-11-03 オーナー決定） | 4-4。50件ずつ |
| `k_save*` / `k_add*` / `k_edit*` / `k_delete*` | 共有（安全面は同意） | 4-5 |
| `k_recordMembership` | 担当＋担当なし（オーナーは全員）。cancel はオーナーだけ | §6 |
- 体の記録・目標線は Worker の `k_body`（D1・3-1）

### 4-4. 一覧（k_board）の材料
| 印 | 正本 | 新しさの条件 | 判定できないとき |
|---|---|---|---|
| 次の予約が無い | D1 `reservations`（写し） | 同期の時刻（sync_state）が30分以内 | 「確認中」（問題なしにしない） |
| 記録が止まっている | D1 `body_measurements` の会員ごとの最終測定日（削除済みを除く・無ければ「記録なし」） | body_freeze が **verified** | 「準備中」 |
| 契約の終了が近い | D1 `calc_contract_rows.end_ms`（写し） | その会員の世代が新しい（fresh.js）**かつ** `sync_state` の calcContracts（完全同期の時刻・ingest.js 483〜497）が26時間以内 | 「確認中」 |
| 残数・支払い待ち | 既存の残数の読み取り。`readHomeSafe`（compat.js 109〜112・40分を超えたら null）と同じ上限で。生の表を独自に読まない | readHomeSafe が答えたとき | 「確認中」 |
- 一覧には金額・契約の種別・健康情報を出さない（印と名前だけ）

### 4-5. 書き込みの守り（Worker で初めて受ける書き込み）
入れる場所（worker/src/index.js）：大きさ＝200行（JSON を読む前）／KARTE 停止＝action 確定の直後（211）／Origin＝同じく211付近・書き込みの k_ だけ／iat＝署名検証の直後（215）／鮮度＝230〜241 を `^(c_|k_)` に（k_ は 200＋FALLBACK ではなく **403**）／回数＝許可表の後・**本体より前の別 batch**
| 守り | 中身 |
|---|---|
| Origin | `k_` の書き込みは Origin が許可の1つと**完全一致**でなければ処理前に403。欠けていても403 |
| トークンの新しさ | 書き込みは ID トークンの iat が**ある**・未来60秒以内・`now − iat ≤ 600秒` のときだけ（auth.js 95〜98 は未来しか見ていない）。画面は保存の直前に取り直す |
| 二重送信 | karte_requests（3-2）を同じ batch で |
| 大きさ | **共通の入口（index.js 200〜208）で** `request.json()` をやめ、Content-Length が 16KB 超なら413 → `arrayBuffer()` の実バイト数で再確認 → `JSON.parse`。action は本文の中なので k_ だけに絞れない＝全 action に掛ける（画面からの要求は小さい。/ingest など別の道は対象外）。項目：メモ本文2000字・種目20・セット10/種目・文字列項目500字 |
| 回数 | 表 `karte_rate`（(trainer_id, window_start) PK・n）。window_start は **Worker だけが** `Math.floor(Date.now()/600000)*600000`（整数ミリ秒・UTC）で作る。クライアントの値は受けない。仕様は「10分の区切りごとに60回」（区切りをまたぐと最大120回は仕様どおり）。古い行は1日で消す（日次の掃除に相乗り） |
| 回数を数える | ★本体とは**別の先行 batch**：karte_rate を +1 → `karte_guard_rate` へ条件つき INSERT（60超なら CHECK 違反でこの batch だけ巻き戻り＝429）。**通ったら1回を消費し、本体が失敗しても戻さない**（失敗の要求も数える＝試行回数の制限） |
| まとめて取り消す | 本体の batch は**全部か無か**。見張りの表（`karte_guard_target`・`_owner`・`_consent`・`_rev`）へ条件つき INSERT。違反で本体・karte_requests・karte_revisions・子行が全部巻き戻る（D1 の batch はトランザクション・途中で失敗すれば全体をロールバック＝Cloudflare の仕様）。制約には**固有の名前**を付ける（`x INTEGER CONSTRAINT KARTE_GUARD_CONSENT CHECK (x = 0)` → `CHECK constraint failed: KARTE_GUARD_CONSENT`）。エラーに既知の名前が**含まれるか**だけを見て code を決め、どれも無ければ推測せず 500。本物の D1 に migration を流す統合検査を公開前の条件にする |
| 二重送信 | batch の前に karte_requests を引く：同じ鍵・同じ payload_hash → 保存済みの結果を返す／hash 違い → REQ_REUSED。並行で先を越されて主キー違反になったら、catch のあとに同じ鍵を引き直して同じ判定。それでも決まらなければ 500 |
| 失敗の記録 | 巻き戻ったあとに別の文で access_log に1行（best effort）。書けなくても元の code を返し、console には中身なしで出す。書けなかった回数を日次点検に出す。result は ok／denied／not_found／conflict／no_consent／rate_limited／error |
| CORS | 2段構え：①**OPTIONS（事前確認）は本文が無く action が分からない**ので、全体に許可 Origin の判定を掛け、許可外は CORS ヘッダなしで403 ②通常の POST は action が分かった後、k_ の書き込みに Origin の完全一致を追加で掛ける（既存の helper は許可外にも先頭の Origin を返す＝index.js 66） |
| 記録 | 7種類の結果（ok／denied／not_found／conflict／no_consent／rate_limited／error）を全部 karte_access_log に。本文・健康情報は console に出さない |
| 安全面の記録が書けないとき | 安全面の読み書きは止める（fail-closed）。それ以外は続けて、失敗の回数を日次点検に出す |

## 5. 画面（LIFF・トレーナー管理）
- 顧客詳細をカルテに作り替える（タブ：概要／からだ／トレーニング／メモ／契約）。概要の最上部に注意事項の要点
- カルテへの入口を InBody カードから外す
- 一覧（k_board）をトレーナー管理のトップに
- 入力は片手・1分以内：体調3択、種目は選ぶだけ、重量・回数は数字キー

## 6. 個人情報
- 健康情報は 3-3。閲覧・書き込みは karte_access_log（保存1年・オーナーだけが読める窓口を後で）
- 作業依頼（job）・shadow・ログにカルテの中身を出さない
- バックアップ：D1 Time Travel（30日）。定期の書き出し（暗号化・保持世代・復旧の試験）は段3の前に決める（未決）
- 退会後（2026-11-03 オーナー決定：3年保持 → その後は外に漏れない形で残す）：**消去と匿名化は別の設計（設計29・未着手）に切り出す**。段1の開始後に退会した方は、最初の期限が早くても2029年。**既に退会している方**は2029年より前に3年を迎えうる＝設計29の移行要件
  - ★段1で入れること：**退会を明示の操作で記録し始める**（契約の期限切れ＝contract_status 'expired' とは別。expired は日次処理が期限で付ける＝LineBooking.js 870・878 なので退会日にしてはいけない）
    - 正本＝D1 の新しい表 `karte_membership_events`。**用途は「退会後3年の起算日」だけ**（会員の状態そのものの正本ではない。予約・一覧の在籍判定は今までどおり contract_status）
      - 列：id・customer_id・kind（withdrawn／rejoined／cancel）・effective_date・target_event_id・recorded_by・recorded_at・reason
        - withdrawn：effective_date＝**退会の発効日**（必須）／rejoined：**再入会の発効日**（必須）／cancel：effective_date は **NULL**（CHECK で固定）・target_event_id と reason 必須
        - withdrawn／rejoined の effective_date は `YYYY-MM-DD` の**実在する日付**で、**Worker の時計（JST）で今日以前**（JavaScript の日付の繰り上がりで 2026-13-01 等を受けない・JST の日付の境界を検査で固定）
      - **追記だけ**。元の行は更新・削除しない
      - **有効な行**＝kind が withdrawn／rejoined で、どの cancel 行からも target_event_id として指されていない行（cancel の行そのものは並べない）
      - cancel の対象は**同じ customer_id の、有効な行の最後の1行だけ**（途中の行・cancel 行・取り消し済みは不可）。最後を外しても残りは先頭が withdrawn の交互のまま＝規則が崩れない。途中を直したいときは、後ろから順に cancel してから記録し直す。存在・顧客一致・最後の行であることは本体と同じ batch の見張りの表で
      - **交互の規則**：有効な行を effective_date → recorded_at → id の順に並べたとき、新しい withdrawn は「直前が無い（在籍）か rejoined」のときだけ、rejoined は「直前が withdrawn」のときだけ書ける（見張りの表で batch 内に検査）。同じ状態を重ねて起算日を動かせない
      - 新しい行の effective_date は、有効な最後の行の effective_date **以降**（過去へ差し込まない。過去を直したいときは cancel してから記録し直す）
      - 起算日＝有効な行の最後が withdrawn なら、その effective_date。rejoined なら起算日なし
    - 操作 `k_recordMembership`：withdrawn／rejoined は**トレーナー（担当＋担当なし）・オーナー（全員）**。cancel は**オーナーだけ**。顧客の実在・権限は本体と同じ batch の見張りの表で。access_log には action=k_recordMembership で記録し、cancel の成功も result=ok（7種類の中で）
    - 一覧（k_board）に「契約が切れて更新が無い」会員を出し、退会かどうかを確認して**退会だけを記録**（休会は記録しない）。contract_status と食い違う（記録は退会なのに在籍等）ときは一覧に「要確認」
    - GAS・契約フォームは変えない
    - 既に退会している会員：推測の日付を入れない。設計29の移行で「要確認」として解消
  - 設計29の要件（関門①5周目）：消去の対象をD1・GAS・シート・ログ・履歴（karte_revisions）・キャッシュ・CSV・バックアップまで列挙／GAS の完全同期で消したものが D1 に戻らない／**ダウンロードは集計だけ**（個人ごとの時系列は少人数の店では匿名にならない＝再識別できる。区分ごとの最低人数 k≥5・丸め・差し引きで1人が分かる小計の抑止）／**集計専用の表**を作り、個人の行との**対応表は持たない**・CSV は集計の表だけから作る／集計を作って確かめてから個人の行を消す／件数の照合
- 名前つきの書き出しは作らない（漏れたときの害が大きい。必要になったら別途設計）

## 7. 検査（入口から）
- 許可表：customer・guest は `k_` に届かない／役割の写しが古いと `k_` は ROLES_STALE／KARTE=off で全部止まる
- 範囲：担当外のトレーナーはメモ・トレーニングは見える・契約と連絡先は見えない／オーナーは全部
- 安全面：同意なし→NO_CONSENT（書けない・返らない）／撤回の batch で中身が消える／撤回と書き込みが競っても中身が残らない
- 二重送信：同じ鍵は1件・違う中身の同じ鍵は REQ_REUSED
- rev：古い rev は CONFLICT
- 書き込みの守り：Origin なし・違う／iat が10分超・無い／16KB超 → 処理前に止まる。61回目 → **本体・requests・revisions・子行を含め一切変化なし**で429
- 見張りの表：同意なし・rev 違い・権限なし・顧客なし → それぞれ全部巻き戻り、正しい code が返る（本物の SQLite に migration を流して確かめる）
- 推定1RM：回数1＝重量・回数12まで・13以上は出さない・重量0
- 一覧：同期が古いと「確認中」
- 退会の記録：担当外のトレーナーは記録できない／cancel はオーナーだけ・理由必須・二重の取り消し不可・cancel 行は対象にできない／未来日・過去への差し込み・形式違い（2026-13-01 等の実在しない日）は不可／途中の行の cancel は拒否・cancel のあとも全体が先頭 withdrawn の交互／withdrawn の後の withdrawn・在籍での rejoined は拒否／`withdrawn → rejoined → rejoined を cancel` で起算日が withdrawn の日に戻る
- 画面：カルテの入口が InBody カードの失敗で消えない
- 壊して落ちることを確かめる

## 8. 反映
- D1 migration → Worker（自動）→ LIFF（main への push＝即公開）。Worker の窓口が先に出ても、LIFF が呼ばなければ影響なし。**体の記録の新しい入力は、切り替え（3-1 の3）が済むまでサーバー側で止まっている**（BODY_NOT_READY）ので、LIFF を先に出してもシートと並行しない
- GAS：転送の対象4関数（maLogWeight_・maLogFat_・line_maSaveInBody・maSaveInBody_）の切替フラグと転送・写しの関数（body_log・meal_goals・goal_phases → D1）・maDedupeBodyLog の禁止で1回（次のまとめ反映）。手順は 3-1 の1〜6
- 関門：①この設計 ②push 前 ③段1はトレーナーだけ＝「顧客に出す前」は段3で

## 関門①の結果：10周目で通過 → 3-1 を D1 に変更して再審査 → **再審査5周目で通過（軽微のみ・2026-11-03）**

## 9. 関門①（Codex・2026-11-03 1周目）の指摘と対処
| 指摘 | 対処 |
|---|---|
| 重大：`karte*` に役割の鮮度検査・停止スイッチが掛からない（`^c_` だけ） | `k_` に統一し、鮮度検査を `^(c_|k_)` に。古ければ403。停止スイッチ KARTE（4-1） |
| 重大：全員閲覧と担当制限を同じ窓口で満たせない／customerDetail を丸ごと返すと連絡先まで広がる | 認可を2つに分け、タブごとの窓口に（4-2・4-3） |
| 重大：案Aは record_id が無く冪等に写せない／合成の単位 | **段1は移さない（案C）**。段3で改めて設計（3-1） |
| 重大：案Aではテスター画面が段3まで古い | 同上（移さない） |
| 重大：同意の確認と安全面の書き込みが別 | 1文の条件つき書き込み・JOIN で読む・撤回で中身を消す（3-3） |
| 要修正：Worker 初の書き込みの守り | 4-5 の表 |
| 要修正：一覧を既存 D1 だけで作れない（contracts は空 等） | 印ごとに正本・新しさ・判定不能の表（4-4）。判定不能は「確認中」 |
| 要修正：一覧の全員公開は過大 | 担当＋担当なし（オーナーは全員）。金額・種別・健康情報は出さない（**オーナー確認**） |
| 要修正：記録・退会・撤回・バックアップ | 記録の列・保存1年・失敗時の扱い（4-5・6）。退会後とバックアップの書き出しは未決として明記 |
| 要修正：測定値は固定列 | シート側の固定列（3-1） |
| 要修正：rev・削除・履歴・冪等の表 | 3-2（rev は編集される表・karte_revisions・karte_requests） |
| 要修正：1行にセット数では表せない | 親子（1行＝1セット） |
| 軽微：一括取得は肥大・記録の意味が曖昧 | タブごと・ページング（4-3） |
| 軽微：同意の一意制約 | 今の状態（PK）＋履歴の表（3-2） |
| 軽微：本人の定義・異動 | 不変の trainer_id・オーナーの代理修正は理由必須（3-2） |

## 10. 関門①（2周目）の指摘と対処
| 指摘 | 対処 |
|---|---|
| 重大：`maDedupeBodyLog` が項目ごとの合成を壊す（周囲径で起きやすい） | 実行禁止（3-1） |
| 重大：体の記録を読む GAS が担当制限のまま＝「全員共有」と食い違う | GAS 側にも共有用の認可（3-1）。書き込みまで全員にするかはオーナー確認 |
| 重大：COUNT による回数制限は並行で越えられる | karte_rate を本体と同じ batch・条件つき（4-5） |
| 要修正：列を末尾に足すだけでは保存・読み取りが広がらない | 変更点を列挙（3-1） |
| 要修正：ma_myMembers は記録停止の材料として不足 | ma_lastMeasured を新設（4-4） |
| 要修正：fresh.js は時間の新しさを見ない | sync_state の完全同期の時刻26時間を併用（4-4） |
| 要修正：readHome は40分を捨てない | readHomeSafe と同じ上限（4-4） |
| 要修正：16KB は request.json() の前に | arrayBuffer で（4-5） |
| 要修正：Origin・iat・KARTE の入れる場所 | 4-5 の冒頭に固定。iat の3条件 |
| 軽微：rev は全表ではない／撤回 batch に履歴の追記／CORS／ROLES_STALE は403 | 文言を直した（3-2・3-3・4-5） |

## 11. 関門①（3周目）の指摘と対処
| 指摘 | 対処 |
|---|---|
| 重大：本体だけ条件づけても batch は確定し、requests・履歴・子行が残る | 見張りの表（CHECK 違反）で batch 全体を巻き戻す（4-5「まとめて取り消す」）。検査に「61回目は一切変化なし」 |
| 要修正：window_start が未定義 | Worker だけが作る10分の区切り・仕様は区切りごと60回 |
| 要修正：GAS の書き込み範囲が未決 | 読み・書きとも全トレーナーに揃える（オーナー確認で確定） |
| 要修正：本体0件を全部429にしてしまう | 見張りの表を理由ごとに分け、表の名前で code を決める・順序を固定 |
| 軽微：karte_rate の掃除 | 1日で消す |
| 軽微：CORS | 4-5 に1行 |

## 12. 関門①（4周目）の指摘と対処
| 指摘 | 対処 |
|---|---|
| 要修正：回数の加算まで巻き戻る＝失敗の要求は無制限 | 回数は別の先行 batch で消費（4-5） |
| 要修正：CHECK のエラーに表名が出ない | 名前つき制約・名前が含まれるかだけを見る・不明は500・本物の D1 で統合検査 |
| 要修正：二重送信と batch の失敗 | 事前に引く＋主キー違反のあと引き直す・決まらなければ500 |
| 要修正：GAS の書き込み範囲が未決と完了で矛盾 | オーナー決定（全トレーナーが読み書き）で両方を統一 |
| 軽微：失敗の記録は best effort | 元の code を返す・書けなかった回数を日次点検に |
| 軽微：OPTIONS では action が分からない | 2段構え |
| 軽微：access_log の結果の種類 | 7種類に固定 |
| D1 の batch が巻き戻る前提 | Codex が Cloudflare の仕様で確認（batch は SQL トランザクション・途中で失敗すれば全体をロールバック） |

## 13. 関門①（5周目）の指摘と対処
| 指摘 | 対処 |
|---|---|
| 重大：個人ごとの時系列は少人数では匿名にならない | ダウンロードは集計だけ（k≥5・丸め・小計の抑止）。設計29に切り出し |
| 重大：消去の対象が保存先を覆っていない・退会日が無い | 設計29に切り出し、要件を列挙。段1では退会日の記録だけ始める |
| 要修正：回数の batch の所属が矛盾 | 「本体より前の別 batch」に統一 |
| 要修正：result_id だけでは同じ応答を返せない | http_status・result_code・result_json を保存（中身は入れない） |
| 要修正：匿名化後の表が未定義 | 設計29（集計専用表・対応表を持たない・CSV は集計表だけから） |
| 軽微：記録の対象の文言 | 7種類に揃えた |

## 14. 関門①（6周目）の指摘と対処
| 指摘 | 対処 |
|---|---|
| 重大：退会日の正本と記録の契機が無い（expired は期限切れでも付く） | 明示の操作で D1 `karte_membership_events` に追記（§6・3-2）。既存の退会者は推測せず設計29で「要確認」 |
| 要修正：失敗は requests に残らないのに「同じ応答を返す」 | 保存するのは確定した成功だけ・失敗は再判定。result_json は操作ごとに列挙した安全な項目だけ |
| 要修正：匿名化の要件の置き場所 | §6 の本文に集計専用表・対応表を持たない・CSV は集計だけ |
| 軽微：「2029年」は段1開始後の退会に限る | 文言を限定し、既存の退会者を設計29の移行要件に |

## 15. 関門①（7周目）の指摘と対処
| 指摘 | 対処 |
|---|---|
| 要修正：追記だけの表で誤記録を訂正できない | cancel の行（target_event_id・理由必須・オーナーだけ・二重不可）。起算日の求め方を固定 |
| 要修正：k_recordMembership の権限が未定義 | 担当＋担当なし（オーナーは全員）・見張りの表・access_log・検査 |
| 要修正：contract_status と二重化 | 用途を「3年の起算日」だけに限定。在籍の判定は contract_status のまま。食い違いは一覧に「要確認」。休会は記録しない |
| 軽微：effective_date の意味 | 発効日に限定・ISO・未来日不可 |

## 16. 関門①（8周目）の指摘と対処
| 指摘 | 対処 |
|---|---|
| 要修正：cancel 行そのものが「取り消されていない行」に入る | 有効な行＝withdrawn／rejoined で、cancel から指されていない行。cancel 行は並べない・対象にもできない |
| 要修正：同じ状態の重ね記録で起算日を動かせる | 交互の規則と「最後の行以降」を batch 内の見張りで |
| 軽微：effective_date の意味が kind で違う | kind ごとに定義・cancel は NULL（CHECK） |
| 軽微：access_log の文言 | action=k_recordMembership・cancel も result=ok |

## 17. 関門①（9周目）の指摘と対処
| 指摘 | 対処 |
|---|---|
| 要修正：途中の行を cancel すると交互が崩れる | cancel の対象を有効な最後の1行だけに限定 |
| 軽微：ISO・未来日の条件が本文から抜けた | §6 に戻し、§7 に形式違い・実在しない日を追加 |

## 18. 関門①（再審査1周目・3-1 v3）の指摘と対処
| 指摘 | 対処 |
|---|---|
| 重大：origin_key（記録日時）は衝突しうる | 書き込みを全部 D1 にしてシートを凍結 → 凍結時の行番号を鍵に（凍結後は動かない） |
| 重大：15分の差分では体脂肪率の書き換えを拾えない | 写し続けない（凍結・一度だけ）。体脂肪率も D1 に直接 |
| 重大：後勝ちの順序が GAS の行順と違う | sheet_order を保持・d1 はその後。出所は `inbody` を含むか |
| 重大：一覧の記録停止が D1 の直接入力を見ない | 一覧も D1 から |
| 要修正：新旧の画面で二重登録 | 古い画面の GAS 経由も Worker へ転送・client_req_id |
| 要修正：照合の母集団 | sheet 由来だけで比べる・手順を固定（3-1 の1〜4） |
| 要修正：目標線の選び方 | GAS と同じ規則を明記・目標線の編集はカルテへ |
| 要修正：6分制限・ロック | 15分ごとの写しを無くした（一度だけの写しは分割して再開できる形・行番号で進む） |
| 要修正：新しい項目の範囲が無い | 範囲を明記 |
| 軽微：§4・§8 が旧仕様 | 直した |

## 19. 関門①（再審査2周目）の指摘と対処
| 指摘 | 対処 |
|---|---|
| 重大：反映の瞬間＝凍結は成り立たない（実行中の旧版・再送） | 2段：移行版（共通ロック＋切替フラグ）を先に反映 → 6分以上待つ → ロックの中でフラグと凍結コピー |
| 重大：行番号は凍結後も動きうる | 凍結用シートにコピーし `freeze_id:シート名:順番` を鍵に。行数とハッシュを各段で確かめ、変われば failed |
| 要修正：Worker が落ちたとき | 専用の入口・同期で転送・失敗なら成功を返さない・決定的な client_req_id・maOnce_ は成功後に確定 |
| 要修正：体重と体脂肪率の同時 | 選ぶと書くを1文に |
| 要修正：凍結の状態が1つの印では足りない | body_freeze の状態（frozen→copying→copied→verified／failed）。読むのは verified だけ |
| 軽微：見出し・旧仕様の文言・書き込み口の数え方・削除済みの除外 | 直した |

## 20. 関門①（再審査3周目）の指摘と対処
| 指摘 | 対処 |
|---|---|
| 重大：切り替え直後の体脂肪率が、写しの途中だと失敗・検証対象を書き換える | origin='sheet' の行は書き換えない。GAS がその日の体重を要求に含め、D1 の行が無ければ体重つきで新しく作る |
| 要修正：1文では除脂肪を計算できない | 同じ文の中で対象行の体重から計算 |
| 要修正：/body/write の冪等の鍵と同じ batch | body_requests（channel＋client_req_id）を batch の先頭に |
| 軽微：書き込み口の数え方 | 「転送の対象4関数」に統一 |

## 21. 関門①（再審査4周目）の指摘と対処
| 指摘 | 対処 |
|---|---|
| 重大：LIFF が先に出ると、切り替え前に D1 とシートへ並行して書かれる | k_addMeasurement は切り替え前は BODY_NOT_READY（サーバー側の関門）。画面は従来の InBody カードを出す |
| 要修正：体脂肪率の並行処理の排他が未定義 | 1と2を同じ batch・2は NOT EXISTS の条件つき INSERT。D1 は batch を1つずつトランザクションで実行するので交互に混ざらない |
| 軽微：検査の文言 | 「d1 の行も known_weight_kg も無ければ」に |
