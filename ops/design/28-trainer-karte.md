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

## 3. データ（関門①を受けて改訂・v2）

### 3-1. 体の記録（⑤）は段1では**シートのまま**（案C）
- 正本は今の `body_log`（GAS）のまま。**既存5項目の意味と列（1〜11列）は変えず、新しい項目を末尾に足す**：骨格筋量・胸囲・上腕・ウエスト・ヒップ・太もも（12〜17列）
- GAS の変更（関門②の対象）：
  - `body_log.header` を17列に
  - `MA_INBODY_FIELDS`（MealAi.js 1313）に6項目と範囲を足す
  - `maSaveInBody_`（1363）の保存行を**列番号から組み立てる**（11要素の固定配列をやめる）
  - `maLastInBody_`（1385）と `maReadBody_`（1154）の読む幅を最大列まで広げ、**6項目も項目ごとの後勝ち合成**（空欄で上書きしない）
  - `line_maSaveInBody`（LineBooking.js 333）の引き渡しに6項目を足す
  - `ma_series` の返り値に6項目を足す（karte/index.html は知らない鍵を無視する＝テスターの画面は変わらない）
  - ★**`maDedupeBodyLog()`（1047〜1063）は実行禁止にする**（先頭で止めて理由を返す）。同じ日の先行行を丸ごと消すので、体重の行とウエストの行が別だと体重が消える（関門①2周目）
  - staging の自己テストを新しい列まで広げる
- 読む・書くの認可：GAS 側にも**共有用の認可**（トレーナーであり、顧客が実在し照合済み）を置き、`ma_series` のトレーナー経路（MealAi.js 1108〜1115）と InBody カードの読み書き（LineBooking.js 320・329）をそれに替える。**共有の範囲は読み・書きとも全トレーナー**（メモと同じ扱い。オーナー確認を取って確定する）
- 体脂肪量は保存列ではなく、読むときに 体重×体脂肪率 で出している（MealAi.js 1183）
- 理由：D1 へ移す案（案A）の落とし穴（安定IDが無い・項目ごとの合成・テスター画面が古くなる）は、移すときだけ起きる。段3（顧客への公開）の設計で正本の移し方を決める
- GAS の反映が1回要る → 次のまとめ反映に入れる

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
| `karte_requests` | (trainer_id, action, client_req_id)(PK)・payload_hash・result_id・done_at | 二重送信を弾く。本体の書き込みと**同じ batch**。同じ鍵の再送は同じ結果を返す。payload_hash が違えば REQ_REUSED |
| `karte_access_log` | id・at・trainer_id・role・customer_id・section・action・result（ok／denied／not_found／conflict／no_consent／rate_limited／error）・req_id | 中身は書かない。保存1年 |

- 編集・削除：書いた人（author_trainer_id＝不変の trainer_id）とオーナー。オーナーの代理修正は reason 必須
- 測定値は固定列（3-1 のとおりシート側）。D1 側に JSON の値の列は作らない

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
| `k_board` | 担当＋担当なし（**オーナーは全員**） | 4-4。50件ずつ |
| `k_save*` / `k_add*` / `k_edit*` / `k_delete*` | 共有（安全面は同意） | 4-5 |
- 体の記録は GAS の `ma_series`（拡張）から（3-1）

### 4-4. 一覧（k_board）の材料
| 印 | 正本 | 新しさの条件 | 判定できないとき |
|---|---|---|---|
| 次の予約が無い | D1 `reservations`（写し） | 同期の時刻（sync_state）が30分以内 | 「確認中」（問題なしにしない） |
| 記録が止まっている | GAS の新しい窓口 `ma_lastMeasured`（会員ごとの最終測定日 or 「記録なし」。body_log を全行見る。`ma_myMembers` は記録のある会員・末尾6000行だけなので使わない） | GAS が答えたとき | 「確認中」 |
| 契約の終了が近い | D1 `calc_contract_rows.end_ms`（写し） | その会員の世代が新しい（fresh.js）**かつ** `sync_state` の calcContracts（完全同期の時刻・ingest.js 483〜497）が26時間以内 | 「確認中」 |
| 残数・支払い待ち | 既存の残数の読み取り。`readHomeSafe`（compat.js 109〜112・40分を超えたら null）と同じ上限で。生の表を独自に読まない | readHomeSafe が答えたとき | 「確認中」 |
- 一覧には金額・契約の種別・健康情報を出さない（印と名前だけ）

### 4-5. 書き込みの守り（Worker で初めて受ける書き込み）
入れる場所（worker/src/index.js）：大きさ＝200行（JSON を読む前）／KARTE 停止＝action 確定の直後（211）／Origin＝同じく211付近・書き込みの k_ だけ／iat＝署名検証の直後（215）／鮮度＝230〜241 を `^(c_|k_)` に（k_ は 200＋FALLBACK ではなく **403**）／回数＝許可表の後・本体の中（同じ batch）
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
| 記録 | 成功・拒否・競合・同意なしを karte_access_log に。本文・健康情報は console に出さない |
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
- 退会後の保存期間：同意文の未決と合わせてオーナーに確認

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
- 画面：カルテの入口が InBody カードの失敗で消えない
- 壊して落ちることを確かめる

## 8. 反映
- D1 migration → Worker（自動）→ LIFF（main への push＝即公開）。Worker の窓口が先に出ても、LIFF が呼ばなければ影響なし
- GAS：body_log の列追加と ma_series の拡張で1回（次のまとめ反映）
- 関門：①この設計 ②push 前 ③段1はトレーナーだけ＝「顧客に出す前」は段3で

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
| 要修正：GAS の書き込み範囲が未決と完了で矛盾 | **オーナー確認待ち**（§3-1）。確定したら両方を直す |
| 軽微：失敗の記録は best effort | 元の code を返す・書けなかった回数を日次点検に |
| 軽微：OPTIONS では action が分からない | 2段構え |
| 軽微：access_log の結果の種類 | 7種類に固定 |
| D1 の batch が巻き戻る前提 | Codex が Cloudflare の仕様で確認（batch は SQL トランザクション・途中で失敗すれば全体をロールバック） |
