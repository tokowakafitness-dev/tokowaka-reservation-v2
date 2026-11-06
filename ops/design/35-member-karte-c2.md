# 35 会員画面 C2：会員が自分のカルテを読む（確定版モック F1〜F5）【関門①通過＝改訂3】

2026-11-06・CEO 玄。C1（設計34）は公開済み（6ce04a4）。オーナー承認のモック（canvas 7UJJVobiQxR7FP6BAQ3AKJ の F1 概要・F2 体組成・F3 トレーニング・F4 指導の履歴・F5 契約）の残りを出す。オーナー指示：「C2をすぐ準備」。

## 0. 範囲と、モックとの対応

| モック | C2 で出すもの | 出し元 |
|---|---|---|
| F1 概要 | 次回のご予約（＋このあとの予約）・目標と進み具合・直近の「お客様へ」・次回までに | 次回＝起動時の myReservations（既にある）。他＝新しい窓口 |
| F2 体組成 | 進み具合（目標体重・期日）・体重/体脂肪率/骨格筋量の最新と前回比・推移・最近の記録 | body_measurements（I51：verified の凍結＋d1 だけ）・body_goals・karte_profile |
| F3 トレーニング | 前回の内容・種目ごとの推移・自己ベスト・日別の記録（日のタグ） | karte_tr_sessions / karte_tr_sets（セットのメモは出さない）・日のタグ＝新しい欄 |
| F4 指導の履歴 | 次回までに（最大3つ）・「お客様へ」の履歴 | **新しい表**（社内の指導メモは出さない） |
| F5 契約 | 残り回数・振替（既にある）＋契約の種類・期間・回数・担当・キャンセル規定 | member_home（既にある）＋calc_contract_rows の**列を選んで**（金額は出さない） |
| 下のタブ | 概要・体組成・トレーニング・指導の履歴・契約 | — |

- **やらない（C3 以降）**：会員が「次回までに」に✓を付ける（会員の書き込み＝別の守りが要る）。写真。録音→AI。
- モックの「1 / 3」（✓の数）は C2 では出さない。

## 1. 倒れる向き
判定できないとき（本人が特定できない・写しが古い・窓口が止まっている）は**何も見せない**。他の会員の記録を1行でも見せるより、空のタブの方がよい。

## 2. 守る不変条件
1. **本人は who.customerId だけで決める。** 新しい窓口は body から customerId・noteId・sessionId 等の「顧客を指す値」を一切受け取らない（入口の検査は body.customerId にしか効かない・index.js:294）
2. **返す項目は「足す一覧（allowlist）」で作る。** k_ の応答を流用して落とす（redact）形にしない（redact は body・next_plan・next_check・author_trainer_id・reasons を落とさない＝社内メモが漏れる）
3. **社内の指導メモ（karte_notes）は会員に返さない。** 会員に見せる文は新しい表にだけ書く
4. **健康情報（karte_safety・pain・diagnosis）は返さない**（I48・I55）
5. 体の記録は I51 のまま（verified の凍結＋d1）
6. 契約の金額・支払い方法は返さない
7. k_ の許可（trainer/owner だけ・I46）は変えない
8. 公開リポジトリ・ログに氏名・フルID を出さない（I38）

## 3. 作るもの

### 3-1 新しい表（migration 0027）
```
karte_member_notes          -- 会員に見せる文（トレーナーが書く）
  mnote_id TEXT PK, customer_id TEXT NOT NULL, session_date TEXT NOT NULL,
  message TEXT,               -- 「お客様へ」（〜400字）
  todo_json TEXT,             -- 次回までに（最大3つ・各〜60字）
  day_tags_json TEXT,         -- 日のタグ（例：全身・脚・尻・背中）
  author_trainer_id TEXT, created_at, updated_at, deleted_at, rev
  UNIQUE(customer_id, session_date)   -- 1日1枚（上書き＝rev で衝突を検出）
```
- 日のタグを社内メモ（karte_notes.tag）から取らない：あちらは種類（training/meal…）で、会員に見せる日のタグとは別物。

### 3-2 トレーナー側（カルテの「今日の記録」）
- 「今日の記録」に **「お客様に見える欄」** を足す：お客様へ（文）・次回までに（3行）・日のタグ（選ぶ）。見出しに「お客様に見えます」と明記し、社内メモの欄と色で分ける（社内＝灰・お客様＝ネイビーの淡）
- 保存1回で記録・社内メモ・お客様の欄を送る（今の memoPending と同じ扱い：結果が確定するまで下書きに残す）
- 新しい k_ 操作：`k_saveMemberNote`（trainer/owner・canSeeKarteShared・rev）・`k_deleteMemberNote`
- **「お客様の見え方」ボタン**（トレーナーのカルテの概要）：会員の画面と同じ組み立て関数でその顧客の C2 を出す。★オーナーは会員として開けない（トレーナー判定）ので、実機の確認はこれで行う

### 3-3 会員の窓口（Worker）
- 1本：`c_myKarte`（customer だけ・許可表に追加）。who.customerId だけを使う。body は無視
- 返すもの（すべて allowlist で組み立てる関数 `buildMemberKarte(db, customerId)`。トレーナーの「お客様の見え方」も同じ関数を通す＝見え方が食い違わない）
  - goal：{ targetWeight, deadline }（hearing.targetWeight・profile.goal_deadline）
  - body：{ latest, prev, series[≦24], recent[≦10] }：weight_kg・body_fat_pct・skeletal_muscle_kg・measured_on だけ。goalLine：{ start_date, end_date, start_weight, target_weight }
  - training：sessions[≦20]：{ date, sets:[{ exercise, set_no, weight_kg, reps }], tags }・best：種目ごとの最大（重さ×回数・日付）
  - notes：[≦20]：{ date, message, todo, trainerName }（trainerName は名＝表示名だけ）
  - contract：{ type, course, freq, trainerName, startDate, endDate, tickets } ※ calc_contract_rows から列を選ぶ。金額・支払い方法は返さない
- 停止スイッチ `MEMBER_KARTE`（既定 off）。off のとき会員の画面はタブを出さず C1 のまま
- 鮮度：契約の写しが古い（sync_state）ときは contract を null（答えない）。カルテの表は D1 が正本なので鮮度の判定は要らない
- 呼ばれ方：会員がタブを開いたときだけ（起動時には呼ばない＝§6 の回数を増やさない）。1回で全タブ分を返し、画面で持つ
- 読んだ記録：karte_access_log に「customer 本人が読んだ」を残す（中身は書かない）

### 3-4 会員の画面（liff/index.html）
- ホーム（F1）：C1 の並びに「次回のご予約」カード（myReservations の先頭・このあとの日付）・目標と進み具合・直近の「お客様へ」・次回までに
- 下のタブ（56px・14px・4言語）：概要／体組成／トレーニング／指導の履歴／契約。タブは戻るの履歴に積まない（横スワイプ＝戻るの決まりを崩さない）
- 値はすべて textContent。推移の線は SVG を DOM で作る
- 4言語の鍵を足す

## 4. オーナーに決めてもらうこと
1. **「お客様へ」は保存した瞬間に会員に見えてよいか**（推奨：見えてよい。欄に「お客様に見えます」と出す。下書き・公開の2段は書き忘れが増える）
2. **トレーニングの重さ・回数を会員に全部見せてよいか**（推奨：見せる。モックどおり）
3. **体組成を会員に見せ始める時期**：テスター向けの体組成画面（karte/index.html）を使っている会員がいる。C2 で全会員に開くと、その画面は役目を終える（推奨：C2 に一本化）

## 5. 未確認（関門①の前に確かめる）
- **pending（未承認）の会員が Worker で customer 扱いになる経路**（CEO が確認・2026-11-06）：resolveRole は customers.line_user_id だけで判定し auth_state を見ない（auth.js:119-124）。押し出し（PushToEdge.js:186-224）は customer_id のある行を **AUTH_STATE を見ずに** line_user_id ごと送る。コード発行（LineBooking.js:435-441）は、既存の行が verified でなければ pending に戻すが LINE_USER_ID は消さない。→ **LINE の ID が入ったまま verified でない行は D1 で customer になる**（実在の件数は未確認）。
  - 案（推奨）：押し出しで `line_user_id` を **AUTH_STATE='verified' の行だけ** 送る（未承認は null）。c_myKarte だけでなく既存の会員窓口も同じ守りになる。GAS の反映が1回要る。
  - 反映までの間は MEMBER_KARTE=off のままにする（C2 を開く条件にする）
- calc_contract_rows の列（contract_cols）に、月額契約の開始日・終了日があるか（k_contract が startMs/endMs を返しているので、ある見込み）
- karte/index.html（テスター向け）の利用者

## 6. 検査
- worker：c_myKarte が body の customerId・noteId を無視する／他の会員の行が混ざらない（2人分の行を入れて1人で読む）／karte_notes の body・next_plan・next_check が応答のどこにも無い（応答の JSON 全体を文字列で検索）／karte_safety が無い／金額の列が無い／MEMBER_KARTE=off で 503／trainer が c_myKarte を叩いても他人を読めない
- 「お客様の見え方」と c_myKarte が同じ関数を通る（配線の検査）
- 画面：入口から（起動→ホーム→タブ）、値は文字として、4言語、戻るの決まり
- 本物の SQLite に migration を流して通す（feedback：D1 の身代わりは CHECK・UNIQUE を再現しない）
- 守りを壊して落ちることを確かめる

## 7. 関門と出し方
- ①この設計 ②差分 ③会員に出す前
- 出し方：push（MEMBER_KARTE=off のまま）→ トレーナーが「お客様の見え方」で確認・数名分の「お客様へ」を書く → 関門③ → MEMBER_KARTE=on（オーナー承認）

---

## 改訂1（Codex 関門① 1周目の反映・2026-11-06・スレッド 01a1aef4）

### 1-1 「お客様の見え方」は別の操作（重大1）
- `k_memberPreview`（trainer/owner だけ・KARTE の守りを受ける）。body.customerId を受け、**canSeeKarteShared**（共有カルテと同じ範囲＝トレーナー全員）を通してから `buildMemberKarte` を呼ぶ。範囲を共有カルテと揃える理由：中身は共有カルテ（体の記録・トレーニング）の部分集合で、新しく見える情報が増えないため。契約の部分だけは担当の範囲（canSeeCustomer）を通らなければ null
- `c_myKarte` は customer だけ・who.customerId だけ（body は読まない）

### 1-2 お客様向けの欄はトレーニングと同じ1回の書き込みに入れる（重大2）
- **k_addTraining の payload に任意の `member: { message, todo[], tags[] }` を足し、トレーニングの行と同じ D1 batch で karte_member_notes に書く**＝同じ送信番号（reqId）の冪等・全部か無か（MODEL の「書き込みは全部か無か」）。今の画面の順（トレーニング→成功後に社内メモ＝memoPending）はそのまま。部分成功は「トレーニング＋お客様の欄」と「社内メモ」の2つだけで、後者は今の memoPending の扱いのまま
- 下書き：トレーニングの送信が成功したら、セットとお客様の欄を下書きから消す（今のセットと同じ時点）。社内メモは今どおり memoPending に移る
- トレーニングを付けない日（お客様の欄だけ）・後から直す：`k_saveMemberNote`（mnoteId＋rev で衝突検出・reqId で冪等）。消す：`k_deleteMemberNote`（論理削除）

### 1-3 1日1枚をやめ、トレーニング1回に1枚（高3）
```
karte_member_notes
  mnote_id TEXT PK, customer_id TEXT NOT NULL, session_id TEXT NULL REFERENCES karte_tr_sessions(session_id),
  session_date TEXT NOT NULL, message TEXT, todo_json TEXT, tags_json TEXT,
  author_trainer_id TEXT, req_id TEXT, created_at, updated_at, deleted_at, rev INTEGER NOT NULL DEFAULT 1
  UNIQUE INDEX (session_id) WHERE session_id IS NOT NULL AND deleted_at IS NULL
  UNIQUE INDEX (req_id) WHERE req_id IS NOT NULL
```
- 会員の画面の「日のタグ」は、その日のトレーニング（session）に付いた枚の tags。同じ日に2回あれば2行として出す

### 1-4 停止スイッチの範囲（高4）
- `MEMBER_KARTE=off`：**c_myKarte はサーバーで必ず 503**（古い LIFF が直接呼んでも止まる）。画面はタブを出さない
- k_memberPreview・k_saveMemberNote は MEMBER_KARTE に止められない（KARTE の守りだけ）＝off のままトレーナーが書いて見え方を確かめられる
- 検査：off で c_myKarte が 503／off でも k_memberPreview が動く／両方が同じビルダーを通る

### 1-5 契約の鮮度は I53 と同じ（高5）
- contract は **I53 の判定（計算の材料4つが同じ batchId・45分未満）を満たすときだけ**返す。満たさなければ null（画面は「担当トレーナーにお尋ねください」）。判定は I53 の既存の関数を呼ぶ（別の式を立てない）
- 期間の列（開始・終了）が contract_cols に無ければ、推定せず null。検査：contract_cols に必要な鍵が無いとき null になる
- 契約の担当名は trainer master の表示名に直す（行の自由文字をそのまま出さない）。直せなければ null

### 1-6 未承認の行（高6）
- 押し出し `_edgeCustomers` は、`AUTH_STATE === 'verified'` の行だけ line_user_id を送る（それ以外は null）
- 反映の前後に確かめること（関門③の必須）：①verified でなく LINE ID がある行の件数（GAS で数える・名前は出さない）②反映後、それらの D1 の line_user_id が NULL になった件数 ③verified の行の LINE ID が残った件数 ④同じ LINE ID が複数行にあるときの扱い（verified の行だけが送られる＝D1 の UNIQUE を破らない）⑤resolveRole が該当者を guest にし、c_boot が未登録の画面へ倒れる（Worker の検査）⑥GAS の版の印を上げ、反映後に印を確かめる
- GAS の反映は C2 の Worker・画面と別にまとめて1回（上限200本の節約）

### 1-7 access_log（高7）
- D1 の監査表 karte_access_log は**非公開の内部の表**で、フル customer_id を持つのは既存どおり（ここは I38 の「公開の場所・ログ」に当たらない）。会員本人の閲覧は：trainer_id=NULL・role='customer'・section='member_karte'・action='c_myKarte'。中身・応答・氏名・LINE ID・測定値は書かない。書き込みの失敗の console に ID を出さない。保存期間は既存どおり
- 「ログに出さない」の対象は console・公開リポジトリ・作業依頼の結果と明記する

### 1-8 SQL の段階で allowlist（中8）
- buildMemberKarte の SELECT 列を固定：
  - karte_profile：goal_deadline と `json_extract(hearing_json,'$.targetWeight')` だけ（hearing_json 全体を読まない）
  - body_measurements：measured_on・weight_kg・body_fat_pct・skeletal_muscle_kg（I51 の条件つき）。body_goals：start_date・end_date・start_weight・target_weight
  - karte_tr_sessions：session_id・session_date。karte_tr_sets：exercise・set_no・weight_kg・reps（**note を読まない**）
  - karte_member_notes：session_id・session_date・message・todo_json・tags_json・author_trainer_id（→ trainers の表示名に直し、ID は返さない）
  - calc_contract_rows：I53 を満たすときの必要な列だけ
- **karte_notes・karte_safety・karte_consent は SQL に出てこない。** 検査：buildMemberKarte のソースに禁止の表名・列名（karte_notes・karte_safety・pain・diagnosis・next_plan・next_check・price・amount 等）が無い＋応答 JSON 全体の文字列検索

### 1-9 GAS へ送り直さない（中9）
- c_myKarte は EDGE_MAP の送り直しに乗せない（対応する GAS の操作が無い）。失敗・503・タイムアウトはタブの中に「いまは表示できません」を出し、空のまま。既存の予約・残数の送り直しは変えない

### 1-10 MODEL の台帳に足す（低10）
- 新しい不変条件 I-M1〜I-M8（本人＝who.customerId だけ／応答は専用 allowlist／社内メモ・健康情報・セットのメモ・金額を読まない返さない／会員向けの文は別の表／MEMBER_KARTE=off でサーバーも止まる／verified でない行は LINE ID を送らない／見え方と本人は同じビルダー／access_log に中身を書かない）を、それぞれ守る検査と一緒に §3 に書く。§2 の表の地図に karte_member_notes、§6 に c_myKarte（タブを開いたときだけ）を足す

## 改訂2（Codex 関門① 2周目の反映）

### 2-1 トレーニングを消したら会員向けの枚も消す（高1）
- k_deleteTraining は**同じ D1 batch で**、同じ session_id の生きた karte_member_notes を論理削除する（片方だけ成功しない）
- buildMemberKarte は session_id のある枚について `JOIN karte_tr_sessions s ON s.session_id = m.session_id AND s.deleted_at IS NULL` を要求する（消し忘れがあっても会員に出ない＝二重の守り）
- 検査：削除で両方が消える／片方だけ失敗させると batch 全体が戻る／削除後に同じ session_id へ新しい reqId で作り直せる

### 2-2 k_saveMemberNote の作成・編集・権限（高2）
- 新規：mnoteId は Worker が作る。rev=0 を要求。トレーニングが無い枚は session_id=NULL・session_date 必須。権限は canSeeKarteShared
- 編集：既存の mnoteId と今の rev（>0）を要求。**書いた本人（author_trainer_id === who.trainerId）か owner だけ**（社内メモの編集と同じ見張り karte.js:141・438 に揃える）。customer_id・session_id・session_date・作成者は変えられない（送られても無視でなく 400）
- 削除（k_deleteMemberNote）：本人か owner。owner が他人の枚を直す・消すときは access_log の action に 'owner_override' を残す（中身は書かない）
- トレーニングと一緒に書いた枚（1-2）の作成者は k_addTraining を送ったトレーナー

### 2-3 プレビューで契約を読まない構造（高3）
```
k_memberPreview:
  if (!canSeeKarteShared(...)) → 403
  contractAllowed = canSeeCustomer(...)
  buildMemberKarte(db, customerId, { includeContract: contractAllowed })
c_myKarte:
  buildMemberKarte(db, who.customerId, { includeContract: true })
```
- includeContract=false のとき calc_contract_rows・calc_meta・sync_state（契約用）・契約の担当名の問い合わせ自体を実行しない。検査：D1 の身代わりで実行された SQL を記録し、契約の表が1本も無いこと

### 2-4 枚の顧客・日付と、参照先のトレーニングの一致（高4）
- session_id のある枚は、参照先の karte_tr_sessions の customer_id と session_date が枚と一致しなければ batch 全体を失敗させる（既存の karte_guard の CHECK 違反で戻す方式 karte.js:129・203・215 に揃える）
- 検査：別の顧客の session_id を与えても書けない／日付の違う session_id でも書けない

### 2-5 冪等（中）
- k_addTraining のハッシュ対象を `{cid, date, sets, member}` に広げる。member は正規化して必ず含める（無いときは member:null。文は前後の空白を落とし、空文字は null、todo・tags は空要素を落とした配列・空配列は null）
- 同じ reqId で member の有無・中身だけ違う再送は REQ_REUSED（後から足さない）。足すのは新しい reqId の k_saveMemberNote。REQ_REUSED のとき下書きを自動で捨てず、日別の記録を確かめさせる（今の文言どおり）
- 検査4組：member あり→同じ内容の再送＝同じ sessionId・mnoteId／あり→なし＝REQ_REUSED／なし→あり＝REQ_REUSED／todo・tags だけ変更＝REQ_REUSED
- karte_member_notes から req_id 列と UNIQUE を外す（冪等の正本は karte_requests の (trainer_id, action, client_req_id)）。作り直しは必ず新しい reqId

### 2-6 I53 の判定の共用（低）
- remain-read-on.js の readCalcInputStatus を export して共用する（45分の判定を書き直さない）

## 改訂3（Codex 関門① 3周目の反映）

### 3-1 k_saveMemberNote の形を3つに分ける（高）
| 形 | 受け取る | サーバーが決める | それ以外は |
|---|---|---|---|
| 新規・トレーニングなし | rev=0・customerId・sessionDate・中身（sessionId・mnoteId は受け取らない） | mnoteId | — |
| 新規・既存のトレーニングに追加 | rev=0・sessionId・中身（customerId・sessionDate は受け取らない） | mnoteId・customer_id と session_date は**参照先の session から引く**（生きている session だけ） | 生きた枚が既にある＝409／session が無い・消えている・canSeeKarteShared が否＝404 |
| 編集 | mnoteId・今の rev（>0）・中身（sessionId・sessionDate・customerId は受け取らない） | — | 本人か owner だけ（2-2） |
- 曖昧な形（rev=0 で mnoteId がある・新規で sessionId と customerId の両方／どちらも無い・編集で sessionId を送る等）は 400
- 検査（2-1 の作り直しとつなぐ）：member なしで作った session に後から1枚足せる／枚を消した後、同じ session に新しい reqId で作り直せる／生きた枚がある session への新規は 409／別の顧客の session は 404／既存の session への追加で sessionDate か customerId を送ったら 400（行は作られない）

### 3-2 owner の上書きの記録（低）
- action は実際の操作名（k_saveMemberNote／k_deleteMemberNote）のまま、section='member_note_owner_override'
