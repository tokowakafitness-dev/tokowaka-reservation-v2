# 設計58 保存したトレーニングの記録を直す（日別の記録の［編集］）（2026-11-25）

> 状態：**実装・検査済み（§12）→ 関門②**。不変条件の番号は I86 を設計57 が使うため I87〜I90 に（2026-11-25）。CEO 決定：Q1 期限なし・Q2 allow（オーナーだけ）で実機確認→on・Q3 印は出さない。
> 経緯：設計・関門①1回目の指摘（重2・中8・軽1）を反映＝改訂1**、2回目（重2・中5・軽1）を反映＝**改訂2**、3回目（重0・中2・軽1）を反映＝**改訂3**、4回目（重0・中2・軽1）を反映＝**改訂4**、5回目（重0・中2）を反映＝**改訂5**、6回目（重0・中3）を反映＝**改訂6**、7回目（重0・中1）を反映＝**改訂7**、8回目（重0・中1・軽1）を反映＝**改訂8**。**9回目で重0・中0（関門①通過）**（§11）。CTO が書いた。実装はまだしない。
> きっかけ：オーナーの実機確認（2026-11-25）「日別の記録で日を開くと［削除］だけ。［編集］も付けたい」。
> 前に読んだもの：`ops/MODEL.md`（§2-3b・I46・I57・I60・I61・I65b・I67〜I72・I-M7・§7 の batch の天井）・設計33・35・38・53・55・56、
> `worker/src/routes/karte.js`（isKarteWrite 104〜107行・G 214〜253行・runWrite 304〜375行・editNote 573〜615行・normalizeTraining 687〜731行・trainingHashItems 733〜753行・addTraining 755〜823行・deleteTraining 825〜855行・saveMemberNote 926〜1028行・training 1326〜1387行・KARTE_HANDLERS 1577〜）、
> `worker/src/lib/member-karte.js`（readTraining 111〜200行・readMemberNotes 204〜）・`worker/src/perms.js`（k_ の許可表 84〜114行）・`worker/src/index.js`（270・288行：isKarteWrite で Origin と iat の守り）、
> `worker/migrations/0025_karte.sql`（karte_tr_sessions・karte_tr_sets・karte_revisions）・`0027_member_notes.sql`・`0029_karte_tr_ext.sql`、
> `liff/karte.js`（purgeTrDrafts 1393〜1403行・buildPayload 1442〜1466行・tabTraining 2191〜2229行・trainingSub 2242〜2247行・exOrder 2260〜2275行・trainingForm 3647〜・send 4228〜4294行・drawDays 4602〜4630行・reauth 502〜515行）。

## 0. 目的（1行）

保存済みのトレーニングの記録（1回＝1 session）を、**記録の画面をそのまま使って**直せるようにし、直した結果を**1回の書き込みで全部か無か**で入れ替える。

## 1. いまの事実（コードで確かめたもの）

| # | 事実 | 根拠 |
|---|---|---|
| F1 | トレーニングの書き込みは `k_addTraining`（新しい session）と `k_deleteTraining`（論理削除）だけ。直す操作は無い | karte.js 1588〜1589行 |
| F2 | 1回の記録は5つの表に分かれる：`karte_tr_sessions`（親・rev・deleted_at）／`karte_tr_sets`（本セット・deleted_at なし）／`karte_tr_exercises`（ord）／`karte_tr_set_ext`（補助・無理やり）／`karte_tr_drops`。子の4表は deleted_at を持たない＝**生きた session の id を通してだけ読む**（I70） | 0025・0029、karte.js 1329〜1352行、member-karte.js 112〜156行 |
| F3 | 子の表の親の指し方は「本セットの INSERT の直後に `SELECT MAX(set_id) … WHERE session_id=?`」。最後に `G.trShape` が形の自己矛盾を見て、当たれば batch 全体が戻る | karte.js 783〜796・247〜282行 |
| F4 | 「お客様へ」（karte_member_notes）は session に1枚（部分 UNIQUE・生きた行）。削除は同じ batch で枚も論理削除。会員の画面は**生きた session に付いた枚だけ**出す | karte.js 840〜850行、0027 27〜29行、member-karte.js 216〜218行 |
| F5 | 書き込みの守り（Origin の完全一致・iat 1時間）は `isKarteWrite` の正規表現 `/^k_(save\|add\|edit\|delete\|record)/` に当たる操作だけに掛かる | karte.js 106行、index.js 270・288行 |
| F6 | `G.rev`・`G.author`・`G.rowLive` は表の名前と列を引数で受ける汎用の見張り。`editNote` が rev＋作者＋karte_revisions の型の前例 | karte.js 222〜235・573〜615行 |
| F7 | 記録の画面の下書きは localStorage の `karte_tr_draft_v1:<tid>:<cid>`（トレーナー×顧客に1つ・24時間）。`trPickSub`（写す）・`trImportSub`（取り込み）・AI の振り分けも**同じ鍵に直接書く** | karte.js 1379〜1380・2311・2811・3651行 |
| F8 | 送るのは ✓ のセットだけ（buildPayload が `s.done === true` で絞る）。写す・取り込み・復元では ✓ の初期値は false（I57） | karte.js 1442〜1466行 |
| F9 | `k_training` は session ごとに `rev`・`created_at`・セット（新しい回は ord・assist_reps・forced・drops）を返す。**古い回（karte_tr_exercises が無い）は ord を返さず、並びは種目名順**（`ORDER BY t.session_id, e.ord, t.exercise, t.set_no`） | karte.js 1341〜1343・1364〜1366行 |
| F10 | 同じ日の複数の回の並びは `created_at`（byNewest・trPickSub） | karte.js 1408・2321行 |
| F11 | 新しい鍵（doneOnly・assist・forced・drops）の受付は `KARTE_TRAINING_EXT`（いま `allow`・許可は1名）。runWrite の extUsed で 409 TRAINING_EXT_OFF | wrangler.toml 95〜97行、karte.js 323〜326行 |
| F12 | `karte_tr_sessions` を読むのは karte.js（k_summary 1271行・k_training）と member-karte.js だけ。GAS・他のルートは読まない | grep の結果（worker/src・gas） |

## 2. 比べた手段

| | 手段 | オーナー操作 | 戻せるか | 変える面積 | 判定 |
|---|---|---|---|---|---|
| A | **置き換え**：1つの batch で「新しい session を作る＋古い session を論理削除＋お客様への枚を新しい session に付け替える」。古い版は論理削除された行としてそのまま残る | 0（Worker は main で自動反映） | ◎ 古い版が全部残る（子の4表ごと） | Worker 1関数（addTraining の行の組み立てを共有）・画面は記録の画面のモード | **採用** |
| B | 同じ session_id のまま子の4表を物理削除して入れ直す。前の版は karte_revisions の before_json に全セットを JSON で残す | 0 | △ before_json から戻す道具が要る | 物理削除の文が4つ・before_json を組む SQL が重い（最大60セット＋ドロップ） | 不採用：子の表に deleted_at が無く物理削除になる／before_json が大きい |
| C | 画面から k_addTraining → k_deleteTraining の2回 | 0 | — | 小 | **不可**：非原子（片方だけ通ると2回分残る／両方消える） |
| D | コードを書かない：削除して記録の画面で入れ直してもらう | 0 | — | 0 | 不可：写す画面は「記録の日付より前」しか出ない（2318行）＝同じ日の記録を写せない／削除で「お客様へ」も消える |

A を採る理由：**親の rev ガードが1つで済む**（子の4表の版を考えない）・**新しい表も列も作らない**・行の組み立てと形の見張り（trShape）を k_addTraining と完全に同じものにできる・前の版を戻す道具が要らない（論理削除を戻すだけ）。

## 3. Worker：`k_editTraining`（新しい操作）

### 3-1. 名前
CEO の案は `k_updateTraining` だが、**`k_editTraining` にする**。`update` は isKarteWrite の正規表現（F5）に当たらず、Origin と iat の守りが**黙って外れる**。前例 `k_editNote` とも揃う。検査で `isKarteWrite('k_editTraining') === true` と、Origin 違いの要求が 403 になることを固定する（§7 T1）。

### 3-2. 要求
```
{ action:'k_editTraining', sessionId, rev, sessionDate, items, clientReqId }
```
- `items` は k_addTraining と同じ形・同じ正規化（`normalizeTraining`）・同じ合計の上限（TOTAL_SETS）。
- `sessionDate` は `isPastOrToday`（未来は 400）。日付も直せる（間違った日に入れた、を直す）。
- **`customerId`・`member` は受け取らない**（あれば 400 SHAPE）。顧客・作者・作成時刻は古い session の行から引く。
- 「お客様へ」の中身は直さない（既存の「お客様の見え方」→［直す］＝k_saveMemberNote ③ が正本の経路）。

### 3-3. 順序
1. 古い session の customer_id を読む（deleteTraining と同じ）→ `canSeeKarteShared`（無ければ 404）。
2. 切替 `KARTE_TRAINING_EDIT`（§3-6）が偽なら **replay の後・回数の前**に 409 TRAINING_EDIT_OFF（何も書かない）。★handler の中で先に判定すると replay より前になり、plan() の中では回数を消費した後になる。だから **runWrite の spec に `editGate: true` を足し、`prev`／replay の直後・extUsed の判定と同じ位置（rate の batch の前）で `trainingEditOn(env, who)` を見る**（karte.js 314〜326行の並び。関門①2回目）。on で保存できた要求を off の後に送り直したら replay で成功を返す（ext と同じ考え方）。
3. runWrite（reqId の replay・回数・本体 batch・karte_requests）。

### 3-4. 本体の batch（全部か無か）
| # | 文 | 目的 |
|---|---|---|
| 1 | `G.rowLive('karte_tr_sessions','session_id',old)` | 消えた／置き換え済みなら 404 |
| 2 | `G.author(…, 'author_trainer_id', who)` | 作者本人かオーナー（403） |
| 3 | `G.rev(…, old, rev)` | 別の端末の変更の後なら 409 |
| 4 | `G.target(cid)` | 顧客が実在 |
| 5 | `INSERT INTO karte_revisions (table_name,row_id,rev,before_json,changed_by,changed_at,reason) SELECT 'karte_tr_sessions', session_id, rev, json_object('replaced_by', ?new, 'session_date', session_date), ?tid, ?now, 'edit' FROM karte_tr_sessions WHERE session_id=?old` | 監査。**中身は入れない**（中身は論理削除された古い行に残る） |
| 6 | `INSERT INTO karte_tr_sessions (session_id, customer_id, session_date, author_trainer_id, rev, created_at) SELECT ?new, customer_id, ?date, author_trainer_id, 1, created_at FROM karte_tr_sessions WHERE session_id=?old AND rev=?rev AND deleted_at IS NULL` | 顧客・作者・作成時刻を**古い行から写す**（要求から取らない＝別の顧客に付かない・同じ日の並びが変わらない F10） |
| 7 | 見張り：`?new` の生きた行が `customer_id = ?cid` で1行ある（無ければ state） | 6 が0行だったときに子の行だけが入らない |
| 8 | 子の行（k_addTraining の rows と同じ関数で `sid=new` に組む） | |
| 9 | `UPDATE karte_tr_sessions SET deleted_at=?now, deleted_by=?tid, rev=rev+1 WHERE session_id=?old AND rev=?rev AND deleted_at IS NULL` | 古い版を論理削除 |
| 10 | 見張り：`?old` が `deleted_at = ?now AND rev = ?rev+1` でなければ state | 9 が0行なら全体を戻す |
| 11 | `UPDATE karte_member_notes SET session_id=?new, session_date=?date, rev=rev+1, updated_at=?now, updated_by=?tid WHERE session_id=?old AND deleted_at IS NULL` | 「お客様へ」を付け替える（日付も合わせる）。rev を上げる＝開いていた「直す」は 409 で読み直しになる（安全側） |
| 12 | 見張り：`session_id IN (old,new)` の生きた枚で、生きた session（同じ顧客・同じ日付）を指さないものがあれば target | F4 の一致（mnoteMatch の session 版） |
| 13 | `G.trShape(new, 数)` | k_addTraining と同じ形の見張り |
| 14 | karte_requests（runWrite が足す） | 冪等 |

- `updated_by` は直した人にする（k_saveMemberNote ③と同じ意味＝最後に変えた人。文を書いた人は `author_trainer_id` に残る・関門①）。
- 本体の文は**1回の `env.DB.batch()`** に全部入れる（runWrite の今の作り）。文の組み立ては純粋な関数 `editTrainingStmts({ old, rev, sid, cid, tid, now, date, tr, who })` に切り出して export する（検査 T5 が文6だけを差し替えて流せるように）。
- section：オーナーが他人の記録を直すときは `training_owner_override`（k_saveMemberNote と同じ扱い）。それ以外は `training`。
- payload（ハッシュの元）：`{ v:1, sid:old, rev, date, items: trainingHashItems(items) }`。旧ハッシュ（altPayloads）は持たない。
- 返す値：`{ sessionId:new, rev:1, replaced: old }`。
- extUsed は normalizeTraining の値をそのまま渡す（F11：許可の無いトレーナーが新しい鍵を送れば 409）。

### 3-5. 文の数（§7 の天井）
k_addTraining の固定の文は3つ（target・session・trShape）、k_editTraining は12（1〜7・9〜13）。子の行は同じ＝**k_addTraining の最大およそ150文＋9**。D1 の batch は1回の呼び出しで1クエリ（MODEL §7）。30秒の天井は関門③で「最大に近い記録を直す」1件で時間を確かめる（k_addTraining と同じ手順）。

### 3-6. 切替と画面への知らせ
- `wrangler.toml [vars]` に `KARTE_TRAINING_EDIT = "off"`（既定）・`KARTE_TRAINING_EDIT_TRAINERS`。判定は `trainingEditOn(env, who)` の1か所（trainingExtOn と同じ形：厳密に 'on'／'allow' で完全一致）。
- `k_training` の応答に `trainingEdit: true|false` を足す（空の一覧のときも）。**画面は真のときだけ［編集］を出す**＝新しい画面×古い Worker（k_editTraining を知らない）でも押せない。
- 反映の順：main に入っても off のまま → `allow`＋オーナーの trainer_id で実機確認 → `on`（別 PR）。

### 3-7. 許可表
`perms.js` に `'k_editTraining': ['trainer']`（オーナーは継承）。`KARTE_HANDLERS` に `k_editTraining: editTraining`。

## 4. 画面：記録の画面を「この日の記録を直す」モードで開く

### 4-1. 入口
`drawDays` の開いた日の行に［編集］を［削除］の左に置く（44px 以上・`k-btn out small`）。出す条件：
- `r.trainingEdit === true`（§3-6）、かつ
- 作者本人かオーナー（［削除］と同じ条件）、かつ
- その回が新しい鍵を**値として**使っている（どれかの種目が `doneOnly === true`、またはどれかの本セットが `assist_reps != null`・`forced === true`・`drops.length > 0`）なら `extOk()` が真（偽なら押しても 409 になるだけなので出さない）。★k_training は新しい形の回の全セットに `assist_reps:null`・`forced:false`・`drops:[]` を返す（1364〜1366行）＝**鍵があるかでは判定しない**（関門①）。下書きへの写しも同じ：null・false・空配列は鍵ごと作らない（送る中身に印の無い鍵を載せない＝I68）。

### 4-2. 開き方
`trainingEditSub(box, sessions, sid, mode)`：`navPush({ cid, tab:'training', sub:'tredit', sid }, mode)`・見出しは「〇/〇(曜) の記録を直す」。`trainingForm(sessions, null, { editOf: x })` を呼ぶ＝**新しい画面は作らない**。

### 4-3. 下書き（今日の下書きと衝突させない）
- 鍵は別にする：`karte_tr_edit_v1:<tid>:<cid>`（トレーナー×顧客に1つ）。中身 `{ v:1, tid, cid, editOf:sid, editRev:rev, sessionDate, items, reqId, pending, base, at }`。`base` は開いた時点の送る中身（buildPayload＋日付）の JSON。
- **今日の下書き（karte_tr_draft_v1）は編集モードでは一度も読まない・書かない・消さない。** trainingForm の中の鍵を引数にし、編集モードでは編集の鍵だけを使う。
- 期限は24時間。`purgeTrDrafts` が両方の接頭辞を消す。
- 別の日の直しかけがあるときに［編集］を押した：pending なら「前の直しの結果を確かめるまで、ほかの日は直せません」で止める／pending でなければ「〇/〇 の直しかけを破棄して、この日を直しますか？」（確認1回）。同じ日なら直しかけを開き直す。
- 直しかけの `editRev` が一覧の `rev` と違う（ほかの端末で変わった）：開くときに「ほかの端末で変わっています。直しかけを破棄して開き直します」で破棄して最新から開く。

### 4-4. 中身の写し方（値を黙って落とさない）
k_training の session → 下書きの items。exOrder の groups の順（新しい回は ord・古い回は種目名順）で：
- 種目：`{ exercise, sets, doneOnly: g.doneOnly }`（数字の無い種目は doneOnly のまま）
- 本セット：`{ w: 0 なら ''（I61）, r: String(reps), done: true, note, assist: assist_reps（null は鍵ごと無し）, forced: forced === true, drops: [...] }`
- ドロップ：`{ w, r, assist, forced }`
- **✓ の初期値は true**（記録済みのセット＝実施済み）。F8 の I57 の「✓ の初期値は false」は**写す・取り込み・復元**の規則で、直すモードには当てはまらない（false で開くと、そのまま保存しただけで全セットが消える＝§6 H2）。MODEL の I57 にこの例外を書き足す。

### 4-5. 出すもの・隠すもの
- 出す：日付・種目とセットの編集・並べ替え（設計53）・＋種目を足す（種目の欄）。
- **隠す**：始め方の3つ／前回から写す／メモ・音声から取り込む（F7：今日の下書きに直接書くため）／社内メモ／お客様に見える欄／休憩タイマー。
- お客様に見える欄の代わりに1行：「お客様に見える欄は［お客様の見え方］から直せます。日付を変えると、この日のお客様に見える欄も同じ日に移ります。」

### 4-6. 保存
- 見出し右上の［保存する］（設計55 と同じ位置・文言）。
- 送る中身が `base` と同じ（何も変えていない）→「変更はありません」で送らない。
- 送る中身が空（全部の ✓ を外した）→「記録を全部消すときは日別の記録の［削除］を使ってください」で送らない。
- 確認の文（k_addTraining の確認と同じ型）に「お客様の画面の数字も変わります」を足す。
- **送る中身は編集専用に組む**：`{ sessionId: D.editOf, rev: D.editRev, sessionDate: D.sessionDate, items }`（customerId・member は載せない）。今の send は `payload.customerId !== cid` で止める（4252行）ので、**編集用の `sendEdit(payload, reqId)` を別に置く**。送る前の確かめは「トレーナー・顧客がフォームを作った時点と同じ（same()）」＋「`payload.sessionId === D.editOf`」＋§4-8 の多重タブの確かめ。
- 送信の扱いは send と同じ型（pending に payload と reqId を固定 → 結果が分からなければ「同じ内容で送り直す」）。**呼ぶのは k_editTraining だけ**（k_addTraining・k_addNote・k_saveMemberNote は呼ばない）。
- 成功：編集の下書きを消し「直しました（〇/〇・n種目・nセット）」＋［記録の一覧を見る］。
- 断られた：CONFLICT／NOT_FOUND＝「ほかの端末で直されたか消されています。開き直して確かめてください」（直しかけは pending を解いて残す・破棄の導線を出す）／BAD_REQUEST は TR_DETAIL／TRAINING_EDIT_OFF・TRAINING_EXT_OFF は専用の文。

### 4-7. 読み直し・戻る
- ログインの取り直し（reauth）の退避は `{ kind:'trainingEdit', customerId, sid }`。`reauth` の isTr の判定（504・508行）に trainingEdit を足し、開き直したら tabTraining が `trainingEditSub` を開く。
- **種目の欄の登録（k_saveExercise）の退避も分ける**：今は `{ kind:'training', customerId, ex }`（4063・4420行）で、戻ると**今日の記録の画面**が開く。編集モードの trainingForm から作った exercisePicker には `{ kind:'trainingEdit', customerId, sid, ex }` を渡し、戻ったら編集の画面で種目の欄を開いたまま戻す（関門①）。退避を組む箇所は trainingForm に1つの関数 `trDraftTag(extra)` にまとめ、モードで分ける。
- 戻る・進む（`sub:'tredit'`）で来たとき、sid の回が一覧に無ければ（置き換え済み・削除済み）「この記録はもうありません」で一覧に戻す。
- tabTraining の「途中の記録を自動で開く」（d0）は今日の下書きだけを見る（今のまま）。直しかけがあれば一覧の上に「〇/〇 の記録を直している途中です［開く］」を出す（自動では開かない）。

### 4-8. 同じ顧客を2つの画面（タブ）で開いたとき
- 編集の下書きは顧客ごとに1つ。片方で保存・破棄した後、もう片方のメモリの D が同じ鍵へ書き戻すと、消えたはずの直しかけ・pending が出てくる。
- 守り（**持ち主と世代番号**・関門①2回目で作り直した）：
  - フォームを作るたびに `formId`（乱数）を作る。編集の下書きに `owner`（formId）と `ver`（書くたびに1増える整数）を持つ。
  - フォームを作った時点で、下書きがあり **pending でなければ** 読んで `owner = 自分の formId`・`ver+1` で書き直す＝**後から開いた入力の画面が持ち主になる**（同じ下書きを2つの画面で同時に書かない）。無ければ新しく作る（これがこのフォームの最初の書き込み＝例外はこの1回だけで、書いた時点で失効する）。
  - **下書きが pending なら、持ち主を取らない・何も書かない読むだけの送り直しの画面**を出す（入力欄なし。押せるのは「同じ内容で送り直す」「日別の記録を確かめる」「破棄」だけ）。送り直し・破棄は owner ではなく「保存されている pending.reqId が画面に出している reqId と同じか」で確かめてから行う。＝送り直しの画面どうしが持ち主を取り合って作り直しが連鎖しない（関門①5回目）。
  - **localStorage の編集の鍵に書く・消すのは1つの関数 `edStore(next)` だけ**。書いた後に、同じ document の中へも通知（`karte-edit-draft` の CustomEvent・`{ oldValue, newValue, sourceFormId }`）を出す。**通知を受けたフォームは `sourceFormId` が自分なら無視する**（自分の save で自分を世代違いとして凍結しない）。D.ver は書く前に次の値にし、書けなかったときだけ戻す（関門①6回目）。各フォームは `storage`（ほかのタブ）とこの通知（同じタブ）の両方を同じ処理で受ける＝同じタブで古いフォームの結果が鍵を変えても、新しいフォームが気づく（`storage` は書いた window には届かない・関門①5回目）。
  - `save()`（入力のたびに呼ばれる・3658行）と `sendEdit()` の前に localStorage を読み直し、**`owner === 自分の formId` かつ `ver === メモリの D.ver`** のときだけ書く・送る（書いたら D.ver を1増やす）。reqId は照合に使わない（確定した失敗で reqId を作り直す正常な遷移を止めないため）。
  - 鍵が無い（ほかの画面で成功・破棄・期限切れで消えた）、持ち主が違う、世代が違う → このフォームを凍結（入力・保存・送り直しを止める）し「ほかの画面で変わりました。開き直してください」。書かない・送らない。
  - `storage` イベントで編集の鍵が変わったら、その場で次のとおり扱う（気づくのを次の入力まで待たない）：
    - **鍵が消えた**：**ほかのフォームの画面では成功と言い切らない**（鍵が消える理由は成功・破棄・期限切れの3つで、消えた後の値からは見分けられない・関門①7回目）。消える前の値（`oldValue`）の `pending.reqId` が、このフォームが送った reqId、またはいま表示している pending の reqId と同じ → 「この直しは別の画面で片づきました（保存または破棄）。日別の記録で確かめてください」＋［日別の記録を確かめる］。それ以外 → 「ほかの画面で変わりました。開き直してください」。どちらもこのフォームは凍結。
    - 「直しました」と言うのは、**応答で成功を受け取ったフォーム自身の完了画面だけ**（§4-6）。
    - **鍵が書き換わった**：このフォームが**送り直しの画面**にいる → `pending` の有無か `pending.reqId` が変わったときだけ作り直す（pending が解けていれば入力の画面＝そこで初めて持ち主を取る。まだ pending なら同じ読むだけの画面のままで何も書かない）。それ以外の変化（owner・ver だけ）は無視＝連鎖しない。入力の画面にいる → owner・ver の照合をして、違えば凍結。
  - **送信の結果の処理は持ち主を見ない**（送っている間に戻る・進む・reauth で作り直したフォームが持ち主を取り直しても、結果を捨てない・関門①3回目）。結果が返ったら localStorage を読み直し、**保存されている `pending.reqId` が今回送った reqId と同じとき**だけ：
    - 成功 → 持ち主に関係なく鍵を消す（ほかのフォームは下の「鍵が消えた」の規則どおり凍結し「片づきました（保存または破棄）」と出す＝成功と言い切らない）。
    - 確定した失敗 → 保存されている下書きに対して `pending = null`・`reqId` を新しく・`ver+1` で書く（**owner は変えない**）。持ち主のフォームは pending の間は送り直しの画面＝入力欄が無いので、storage イベントで作り直されるだけ（入力が消えない・凍結されない）。★pending の間はどのフォームも入力の画面を出さない（今の send の作りのまま。§4-6）。
    - 結果が分からない → localStorage は触らない（pending のまま＝送り直しの画面）。
    - 保存されている pending.reqId が違う・鍵が無い → localStorage は触らない（ほかで片づいた）。
  - **購読の寿命**：各フォームは `dispose()` を持ち、`storage` と `karte-edit-draft` の両方の購読を外す。作り直し・戻る・進む・別の画面を開く（open）・成功の完了画面・破棄・凍結の**全部の経路**から呼ぶ（今の leaveForm は picker を外すだけ＝4228〜4229行。足す）。dispose した後も、送信の結果の処理（edStore で鍵を消す・pending を解く）は行うが、**dispose したフォームは自分の DOM も共通の画面（見出し・cur）も触らない**。
  - localStorage の読みと書きは同じ処理の中で続けて行う（同期）。それでも2つの画面が同じ瞬間に書く隙は残る＝Worker 側の rev・reqId が最後の守り。
- Worker 側は rev・reqId で守られている（二重には書けない）。画面の守りは「消えた直しかけを生き返らせない」ため。

## 5. お客様の画面（member-karte）と個人情報

### 5-1. お客様の画面に出る値
- 直した値は保存の瞬間からお客様の日別・自己ベスト・推移に出る（k_addTraining と同じ。設計35 の「下書き・公開の2段は設けない」オーナー判断に従う）。
- 古い版のセットは**出ない**：member-karte.js は生きた session の id を通してだけ読む（112〜156行・自己ベストも `s.deleted_at IS NULL`）。
- 「お客様へ」は付け替えで同じ日に出続ける（日付を変えたら新しい日に移る）。直した印はお客様の画面に出さない（§9 Q3）。
- 古い回（ord の無い回）を直すと新しい形になり、お客様の画面の種目の順が「入力の順（set_id）」から「種目名順（=直す画面の順）」に変わることがある。直す画面で並べ替えれば、その順で残る。

### 5-2. 個人情報がどこに出て誰が読めるか
| 場所 | 入るもの | 誰が読めるか | 変化 |
|---|---|---|---|
| D1 の論理削除された古い行 | 種目名・重さ・回数・セットのメモ（自由文） | Worker だけ（どの読みも生きた行だけ） | **増える**（直すたびに前の版が残る）。保存期間は削除と同じ扱い |
| karte_revisions | session_id・新しい session_id・日付 | Worker だけ | 中身は入れない（T15 で鍵を固定） |
| karte_access_log | trainer_id・customer_id・section・結果 | 運用 | 既存と同じ（中身なし） |
| karte_requests | trainer_id・payload のハッシュ・**新旧の session_id**（result_json の sessionId・replaced）・rev・完了時刻 | Worker だけ | 置き換えの関係がここにも残る（中身は入らない） |
| 端末の sessionStorage（ログインの取り直しの退避 `karte_draft_v1`） | customer_id・`kind:'trainingEdit'`・直す元の session_id・種目の欄の途中（検索の文字・部位・モード・送信番号・**選んだ種目の名前の一覧（picked）・登録中／直し中の種目名（name・regName・editing）**＝4417〜4418行の ex）。氏名は入れない（509行と同じ） | その端末 | 開き直した時点で読んで消す（今と同じ）。取り直しをやめたらタブを閉じた時に消える |
| 端末→Worker の要求の本文（HTTPS） | session_id・rev・日付・種目名・重さ・回数・セットのメモ・補助・無理やり・ドロップ | Worker（中身は D1 にだけ書く・ログに出さない） | k_addTraining と同じ種類 |
| 端末の localStorage（編集の下書き） | 鍵に trainer_id・customer_id。値に tid・cid・直す元の session_id・rev・reqId・日付・種目名・重さ・回数・セットのメモ・補助・無理やり・ドロップ（`items`）、開いた時点の中身 `base`、送信中の `pending`（payload と reqId）＝**記録の中身が最大3つ重なって残る**。氏名は入れない | その端末を使う人 | 鍵が1つ増える。**成功・破棄・24時間超えのどの経路でも消える**（T29） |
| トレーナーの画面 | 日別の記録：日付・担当の名前・種目名・重さ・回数・セットのメモ（4616〜4617行・今と同じ）。直す画面：同じ中身＋補助・無理やり・ドロップ。完了の文：日付・種目数・セット数 | カルテを開けるトレーナー・オーナー（共有の範囲 canSeeKarteShared） | 見えるものは日別の記録と同じ種類（肩越し・共有の端末で見える危険は今の記録の画面と同じ。新しく増えない） |
新しく外部へ送るものは無い。テストの固定値は架空のもの（I73）。

## 6. 何が起きたら害が出るか（と守り）

| # | 害 | 守り | 検査 |
|---|---|---|---|
| H1 | 直すだけで値が黙って欠ける（セットのメモ・補助・無理やり・ドロップ・実施のみ・順）→お客様の数字・自己ベストが変わる | §4-4 の全項目の写し・Worker は addTraining と同じ正規化 | T20・T21（往復で同じ） |
| H2 | ✓ が外れた状態で開き、そのまま保存して全セットが消える | ✓ の初期値 true・空なら送らない | T22・T23 |
| H3 | 新旧の両方が生きる／両方消える | 1つの batch・見張り 7・10・13 | T4・T5（途中の失敗で何も変わらない） |
| H4 | 別の顧客・別の作者の記録として作られる | 顧客・作者・作成時刻を古い行から写す・customerId を受け取らない | T6 |
| H5 | 作者でないトレーナーが直す | G.author | T7 |
| H6 | 二重送信で2回分できる／同じ番号で別の中身 | runWrite の replay・REQ_REUSED | T8・T9 |
| H7 | 別の端末の変更を古い rev で上書き | G.rev／rowLive | T10 |
| H8 | 「お客様へ」が古い session に残り会員から消える・同じ session に2枚 | 文 11・12（同じ batch） | T11・T12 |
| H9 | 今日の下書きを編集で上書き・消す | 鍵を分ける | T24 |
| H10 | 直す中身が k_addTraining で送られ、回が増える | 編集モードの送信は k_editTraining だけ | T25 |
| H11 | 名前が守りの正規表現に当たらず Origin・iat の守りが外れる | `k_editTraining` | T1 |
| H12 | 切替 off なのに書ける／古い Worker に［編集］が出る | 切替の判定・trainingEdit の旗 | T2・T26 |
| H13 | 置き換え済みの古い session を古い画面から削除・直す | rowLive（404）・rev（409） | T13 |
| H14 | 日付を未来にする | isPastOrToday | T3 |
| H15 | 同じ日の並びが入れ替わる | created_at を写す | T14 |
| H16 | 自己ベスト・推移に古い版の数字が残る | 生きた session だけを読む（I70） | T16 |
| H17 | 監査の記録に中身（自由文）が入る | before_json は replaced_by と日付だけ | T15 |
| H18 | 古い回を直したら、お客様の画面の種目の順が変わる | 仕様として受ける（§5-1）・直す画面で並べ替えれば残る | T21b（順は直す画面の順） |
| H19 | 新しい鍵の許可が無いトレーナーが、許可のある人の記録を直そうとして詰まる | 作者本人かオーナーだけ＋§4-1 で出さない（値で判定） | T26b |
| H20 | 2つの画面で同じ顧客を直し、片方の保存・破棄の後に古い直しかけ・pending が生き返る | §4-8 の読み直しと凍結 | T30 |
| H21 | 種目の登録中にログインを取り直すと、今日の記録の画面に戻る（直しかけが見えなくなり、今日の下書きを開く） | §4-7 の退避を分ける | T31 |
| H22 | 編集の送信が今の send を通り、customerId の確かめで止まる／Worker で SHAPE 400 | sendEdit と編集専用の中身 | T25 |
| H23 | 編集の下書きが端末に残り続ける（記録の中身が重なって残る） | 成功・破棄・24時間で消す | T29 |

## 7. 検査の案（入口から通す・壊して落とす）

置き場所：Worker は `worker/test/karte-training-edit.test.js`（本物の SQLite に migration を流す＝karte-training-ext と同じ作り）、画面は `worker/test/liff-karte-training-edit.test.js`（jsdom・本番の liff/karte.js を読み込む）、会員の画面は `member-karte.test.js` に足す。

| T | 何を通すか | 壊して落とすところ |
|---|---|---|
| T1 | `isKarteWrite('k_editTraining')` が真・Origin 違いの要求が 403・perms に在る | 名前を `k_updateTraining` に変える → 落ちる |
| T2 | 切替 off／allow で未許可 → 409 TRAINING_EDIT_OFF・5表とも行数が変わらない | 判定を常に真に → 落ちる |
| T3 | 未来の日付 → 400・何も変わらない | isPastOrToday を外す |
| T4 | 本体の最後の方で失敗させる：直す前に、古い session に付いた生きた枚の **customer_id を session と違う値**にしておく（壊れたデータ。文11は session_id と日付しか直さない＝日付を壊しても文11が直してしまうので使わない）→ 見張り12で失敗 → 古い session は生きたまま・新しい行は0・枚もそのまま | runWrite の本体を2回の `DB.batch` に分ける（文10までと文11以降）→ 古い session の削除だけが残り落ちる |
| T5 | export した `editTrainingStmts` の文6を「0行になる文」（WHERE に `AND 0`）に差し替えて本物の SQLite に流す → BAD_STATE で全体が戻り、子の4表の行数が変わらない（古い rev は文3が先に止める＝この経路では文6まで届かないため、文6だけを差し替える） | 見張り7を外す → 新しい session の無い子の行が残り落ちる |
| T6 | 要求に customerId を入れる → 400 SHAPE・全表不変／要求に member を入れる → 400 SHAPE・全表不変／正しい要求で、新しい session の customer_id・author・created_at が古い行と同じ | 文6を要求の値で INSERT に変える／member の拒否を外す（addTraining の行の組み立てを共有して member を受ける）→ 落ちる |
| T7 | 作者でないトレーナー → 403・何も変わらない／オーナーは通る（section が override） | G.author を外す |
| T8 | 同じ reqId で2回 → 新しい session は1つ・2回目は replayed | karte_requests を外す |
| T9 | 同じ reqId で別の中身 → REQ_REUSED 409・何も変わらない | payload に items を入れない（ハッシュが中身を見ない）→ 落ちる |
| T10 | 1回直した後に古い rev でもう一度 → 404/409・最新は変わらない | G.rev／rowLive を外す |
| T11 | 「お客様へ」のある回を直す → 会員の画面（buildMemberKarte）に枚が出続ける・生きた枚は新しい session に1枚 | 文11を外す → 枚が消える |
| T12 | 日付を変えて直す → 枚の session_date も新しい日・会員の画面で新しい日に出る | 文11の session_date を外す → 見張り12で全体が戻る |
| T13 | 置き換え済みの古い session に k_deleteTraining → 404・新しい session は生きたまま | 文9を外す（古い session が生きたまま）→ 削除が通り落ちる |
| T14 | 同じ日に2回ある日の1回を直す → k_training の並びが変わらない | 文6の created_at を ?now に |
| T15 | karte_revisions の before_json の鍵が `replaced_by`・`session_date` だけ | json_object に note を足す |
| T16 | 重さを下げて直す → 会員の自己ベスト・k_training の best に古い数字が出ない | member-karte の `s.deleted_at IS NULL` を外す |
| T17 | 新しい鍵を使う中身を ext 未許可のトレーナーで → 409 TRAINING_EXT_OFF・何も変わらない | extUsed を渡さない |
| T20 | 画面：全部入りの回（メモ・補助・無理やり・ドロップ3段・実施のみ・同名2種目）を［編集］→そのまま保存しようとすると「変更はありません」／1か所だけ変えて保存 → 送った items が元＋その1か所 | §4-4 の写しから note を落とす |
| T21 | Worker と画面の往復：上の回を直して k_training と buildMemberKarte を読み直す → 変えた所以外が同じ（session_id を除いて深く比べる） | §4-4 の写しから drops を落とす／addTraining と共有する行の組み立てから assist を落とす → 落ちる |
| T21b | 古い回（karte_tr_exercises の無い回）を直す → 新しい形になり ord が直す画面の順（並べ替えた順） | 写しで exOrder を使わず sets の順にする → 落ちる |
| T22 | ✓ の初期値が全部 true | done:false に変える |
| T23 | 全部の ✓ を外して保存 → 送らない・削除の案内 | 空の判定を外す |
| T24 | 今日の下書き（種目あり）がある状態で別の日を直して保存 → 今日の下書きの中身が1文字も変わらない | 編集の鍵を今日の鍵に変える |
| T25 | 編集モードの保存で呼ばれる操作が k_editTraining だけ | send を共有のまま k_addTraining を呼ぶ形にする |
| T26 | trainingEdit が偽（または無い）→［編集］が出ない | 判定を外す |
| T26b | 新しい鍵を値で使う回で extOk() が偽 →［編集］が出ない／新しい形だが値を使っていない回（assist_reps:null・forced:false・drops:[]）では出る | 判定を「鍵があるか」に変える → 後者で落ちる |
| T27 | pending（結果が分からない）→「同じ内容で送り直す」が同じ reqId・同じ中身を送る | 送り直しで reqId を作り直す → 落ちる |
| T28 | 戻る・進むで置き換え済みの sid に来た →「この記録はもうありません」・送信は1回も起きない | 一覧に無い sid でも空のフォームを開く形にする → 落ちる |
| T29 | 編集の下書きが成功・破棄・24時間超え（purgeTrDrafts）のどれでも消える／今日の下書きは消えない | purgeTrDrafts の接頭辞に編集を足さない → 落ちる |
| T30a | 2つのフォーム：A で開く → B で同じ直しかけを開く（B が持ち主）→ A で入力 → A は凍結・localStorage は B の中身のまま | 照合から owner を外す → 落ちる |
| T30b | 1つのフォーム：入力を10回（save 10回）→ 凍結しない／確定した失敗（CONFLICT）で reqId を作り直して save → 凍結しない | 照合に reqId を足す → 落ちる |
| T30c | 2つのフォーム：B で保存成功（鍵が消える）→ A で入力 → 鍵が生き返らない・送らない | 「鍵が無ければ書いてよい」をフォームの寿命の間ずっと真にする → 落ちる |
| T30d | 2つのフォーム：B で破棄 → A で送り直し（pending）→ 送らない | sendEdit の前の照合を外す → 落ちる |
| T30e | storage イベント：B が書いた瞬間に A が凍結の表示になる | storage の購読を外す → 落ちる |
| T30f | A で送信中 → 戻る・進むで B を作り直す → A に成功が返る → 鍵が消える・B は「別の画面で片づきました（保存または破棄）」で凍結（文言まで固定・「保存されました」と言わない）。**同じタブと別のタブの両方**／同じ pending を表示する A・B で A が破棄 → B も同じ「片づきました」の文言（成功と言わない）／pending でない直しかけを B が破棄 → A は「ほかの画面で変わりました」（文言まで固定） | 判定を「表示中の reqId と同じなら保存されました」に戻す → 破棄の場面で落ちる<br>結果の処理を持ち主の照合に通す → 鍵が残り落ちる |
| T30h | A で送信中に B を作り直す（B は送り直しの画面）→ A に確定した失敗 → B は入力の画面に作り直され、入力できる・下書きの中身（種目・セット）が失われない。**同じタブ（A と B が同じ document・通知で受ける）と別のタブ（storage で受ける）の両方**で通す | 通知の発行を外す（storage だけにする）→ 同じタブの場合で落ちる |
| T30j | 1つのフォームで入力を10回（edStore が通知を10回出す）→ 自分の通知で凍結しない | sourceFormId の無視を外す → 落ちる |
| T30k | A で送信中に B を作り直す（A は dispose 済み）→ A に成功／確定した失敗が返る → 鍵は edStore で正しく変わる・A は DOM・見出し・cur を触らない（B の画面が上書きされない）・作り直しを10回してもリスナーの数が増えない | dispose でリスナーを外さない／dispose 後も A が画面を描く → 落ちる |
| T30i | 2つのタブがどちらも送り直しの画面 → 片方が送り直す（結果が分からない）→ 鍵の書き込みは0回・作り直しの回数が有限（各タブ1回以下） | 送り直しの画面を作るときに owner を取る形にする → 書き込みが続き落ちる |
| T30g | A で送信中 → B を作り直す → A に確定した失敗（CONFLICT）→ 下書きの pending が解け reqId が新しい・owner は B のまま・B は凍結せず使える | 確定した失敗で owner を A に書き戻す／照合で捨てる → 落ちる |
| T31 | 編集モードで種目の登録中に reauth → 退避が `kind:'trainingEdit'`・sid つき／開き直すと編集の画面で種目の欄が開く・**退避（sessionStorage）は読んだ時点で消える**・今日の下書きは触らない・**退避にも編集の下書きにも氏名（cur.name）が入らない**（架空の名前で開いて localStorage・sessionStorage の全部の値を文字で探す） | 退避を `kind:'training'` のままにする → 落ちる |
| T32 | 部分 UNIQUE：新しい session に生きた枚が既にある状態（固定 ID で作った壊れたデータ）で直す → 全体が戻る | — （D1 の制約の確かめ。壊す対象はスキーマ側なので mutation は持たない＝「入口から通す検査」として置く） |

★「壊して落とす」欄が — の T32 は入口から通す検査。それ以外は実装の PR で壊して落ちることを確かめ、PR に書く。全部 `bash worker/test/run-all.sh` に入る。MODEL の不変条件（案）：
- **I87** k_editTraining は1つの batch で「新しい session を作る（顧客・作者・作成時刻は古い行から）＋古い session を論理削除＋お客様への枚を付け替える」。customerId・member を受け取らない。前の版は論理削除された行として残し、karte_revisions には中身を入れない（T4〜T6・T11〜T15）
- **I88** 直す画面は今日の下書き（karte_tr_draft_v1）を読まない・書かない・消さない。送るのは k_editTraining だけ（中身は sessionId・rev・sessionDate・items）。ログインの取り直しの退避は直す画面に戻る。同じ顧客の別の画面で変わった直しかけを書き戻さない（T24・T25・T29・T30a〜k・T31）
- **I89** 直す画面は記録済みのセットを ✓ 済みで開く（I57 の例外）。空・変更なしは送らない（T22・T23・T20）
- **I90** k_editTraining は isKarteWrite に当たる名前で、切替 KARTE_TRAINING_EDIT（既定 off）が偽なら何も書かずに 409。画面は k_training の trainingEdit が真のときだけ［編集］を出す（T1・T2・T26）

## 8. MODEL.md に足すもの（実装と同じ PR）
- §2-3b：karte_tr_sessions／karte_tr_* の書き手に k_editTraining、karte_member_notes の書き手に「k_editTraining（付け替え）」。
- §3：I87〜I90・I57 に直す画面の例外。
- §4 語彙：論理削除された session ＝「削除」または「直す前の版」（karte_revisions の reason='edit'・before_json.replaced_by で見分ける）。
- §7：トレーニングの1回の batch の文の数（k_editTraining は k_addTraining＋9）。

## 9. オーナーに決めてもらう点
| # | 問い | 推奨 |
|---|---|---|
| Q1 | 直せる期間 | **期限なし**（いまの［削除］と同じ・作者本人かオーナー） |
| Q2 | 最初に開く範囲 | **オーナーだけ（allow）で実機確認 → 全員（on）** |
| Q3 | お客様の画面に「直しました」の印を出すか | **出さない**（数字が正しくなるだけ。社内の監査は karte_revisions） |

## 10. 戻し方
- 画面だけ止める：`KARTE_TRAINING_EDIT = "off"`（［編集］が消え、Worker も 409）。
- 直した1回を戻す：古い session の deleted_at を NULL に戻し、新しい session を論理削除し、枚の session_id を戻す（job の手順として書く。実装の PR で用意する）。
- コード全体：この機能のコミットを revert。migration は無いので D1 は戻さなくてよい。

## 11. 関門①の記録
### 1回目（2026-11-25・Codex read-only）重2・中8・軽1 → 全部反映（改訂1）
| # | 指摘 | 裏取り | 対処 |
|---|---|---|---|
| 重1 | T4 の壊し方（文9を先頭へ）では batch が全部戻るので落ちない | runWrite は本体を1回の batch（351行）＝そのとおり | T4 を「見張り12で失敗させる・壊すのは batch を2回に分けること」に変えた |
| 重2 | T5 は古い rev だと文3が先に止まり文6まで届かない＝見張り7を外しても落ちない | G.rev は文3（§3-4）＝そのとおり | 文の組み立てを export し、文6だけを0行に差し替えて流す形にした |
| 中1 | updated_by を変えない理由が列の意味と逆 | k_saveMemberNote ③は updated_by=直した人（1013〜1017行） | 文11で updated_by=?tid |
| 中2 | 今の send は customerId を必須にしている＝そのまま使えない | 4252・4361行 | sendEdit と編集専用の中身（§4-6） |
| 中3 | 種目の登録の reauth が kind:'training' で今日の画面に戻る | 4063・4420行 | §4-7 で退避を分ける・T31 |
| 中4 | ext の判定を鍵の有無でやると、新しい形の回は全部「使っている」になる | 1364〜1366行（null・false・[] を返す） | §4-1 を値で判定・T26b |
| 中5 | 個人情報の表に localStorage の tid・cid・session_id・reqId・base・pending が無い | 3651〜3657行 | §5-2 を具体化・T29 |
| 中6 | karte_requests に新旧の session_id が残ることが書かれていない | 345〜349行 | §5-2 を具体化 |
| 中7 | 2つの画面（タブ）で古い直しかけが生き返る | 3654・3658行（読むのは開いた時だけ） | §4-8・H20・T30 |
| 中8 | 壊して落とす欄が — の検査が多い | — | 全部に壊し方を書いた（T32 だけは入口から通す検査と明記） |
| 軽1 | 部分 UNIQUE を将来壊したときの検査が無い | 0027 27〜29行 | T32 |

### 2回目（2026-11-25・Codex read-only・新しい呼び出し）重2・中5・軽1 → 全部反映（改訂2）
| # | 指摘 | 裏取り | 対処 |
|---|---|---|---|
| 重1 | §4-8 の照合に reqId を入れると、確定した失敗で reqId を作り直す正常な save が凍結される | 4287行（`D.reqId = newReqId(); save()`） | 照合を「持ち主 formId＋世代 ver」に変え、reqId を外した・T30b |
| 重2 | T4：文11が日付を直すので、日付を壊しても見張り12を通る | §3-4 文11＝そのとおり | 壊すのを customer_id にした（文11では直らない） |
| 中1 | 同じ直しかけを開いた2画面は3項目が同じで互いに上書きできる | 3654・3658行 | 後から開いた画面が持ち主になる・T30a |
| 中2 | 「作った直後」の例外の期間が無い＝成功後に鍵を生き返らせうる | 4369行（作った直後の save） | 最初の1回だけ・書いた時点で失効・T30c |
| 中3 | T30 が守る経路を壊していない | — | T30a〜e に分けた |
| 中4 | 切替の判定の位置（replay 後・回数前）を runWrite でどう実現するかが無い | 314〜326行 | spec に editGate を足し、extUsed と同じ位置で判定 |
| 中5 | sessionStorage の退避と要求の本文が個人情報の表に無い | 508〜509行 | §5-2 に2行足した |
| 軽1 | 文の数の説明が合わない（＋11 ではなく＋9） | 805行（固定は3文） | §3-5・§8 を＋9 に |

### 3回目（2026-11-25・Codex read-only・新しい呼び出し）重0・中2・軽1 → 全部反映（改訂3）
| # | 指摘 | 裏取り | 対処 |
|---|---|---|---|
| 中1 | 送信中に作り直したフォームが持ち主を取ると、元のフォームの結果の処理（成功で鍵を消す・失敗で pending を解く）が凍結される | 4275・4277・4287行 | 結果の処理は持ち主でなく「保存されている pending.reqId が送った reqId と同じか」で決める（§4-8）・T30f・T30g |
| 中2 | sessionStorage の退避に種目名（picked・name・regName・editing）も入る | 4417〜4418行 | §5-2 に書き足した・T31 で読んだら消えることを確かめる |
| 軽1 | member を拒否する検査が無い | 811〜817行（addTraining は member を受ける） | T6 に member の場合を足した |
確認された点（Codex）：T4・T5 は壊して落ちる形／editGate の位置は仕様どおり（314〜326行）／会員側は生きた session と同じ顧客の枚だけを返す。

### 4回目（2026-11-25・Codex read-only・新しい呼び出し）重0・中2・軽1 → 全部反映（改訂4）
| # | 指摘 | 裏取り | 対処 |
|---|---|---|---|
| 中1 | 確定した失敗で ver を上げると、持ち主のフォームが「世代が違う」で凍結される／取り込みで入力が消える | 4287行・§4-8 | pending の間はどのフォームも入力欄の無い送り直しの画面（3687〜3695行と同じ作り）＝storage イベントで作り直すだけにした・T30h |
| 中2 | 成功で鍵が消えたのか、破棄・期限切れで消えたのかを見分ける規則が無い | §4-8 | storage の oldValue の pending.reqId で見分ける・T30f で文言まで固定 |
| 軽1 | 画面に出る個人情報の行が足りない | 4616〜4617行 | §5-2 の画面の行を具体化・T31 に氏名が端末に残らない確かめを足した |

### 5回目（2026-11-25・Codex read-only・新しい呼び出し）重0・中2 → 全部反映（改訂5）
| # | 指摘 | 裏取り | 対処 |
|---|---|---|---|
| 中1 | 送り直しの画面どうしが作り直しのたびに持ち主を取り、storage で作り直しが連鎖する | 設計の §4-8・1391行（同期の setItem） | 送り直しの画面は持ち主を取らない読むだけの画面。作り直すのは pending の有無か reqId が変わったときだけ・T30i |
| 中2 | 同じタブで古いフォームの結果が鍵を変えても、storage は書いた window に届かず新しいフォームが気づかない | storage イベントの仕様（同じ window には発火しない） | 書く・消すを edStore に集め、同じ document へ CustomEvent も出す・T30f・T30h を同じタブ／別のタブの両方で |

### 6回目（2026-11-25・Codex read-only・新しい呼び出し）重0・中3 → 全部反映（改訂6）
| # | 指摘 | 裏取り | 対処 |
|---|---|---|---|
| 中1 | 同じ document への通知を書いたフォーム自身も受け、自分の save で凍結する | 3658行（入力のたびに save） | 通知に sourceFormId・自分の通知は無視・ver は書く前に進める・T30j |
| 中2 | 作り直したときの購読の解除が無く、古いフォームが通知を受けて画面を書き換え得る | 4228〜4229行（leaveForm は picker だけ） | dispose() を全部の経路から呼ぶ・dispose 後は結果の処理だけで画面は触らない・T30k |
| 中3 | 成功の文言の判定（自分が送った reqId）では、作り直された送り直しの画面が「保存されました」にならず T30f と食い違う | 設計 §4-8 と T30f | 「送った reqId、または表示している pending の reqId」で判定 |

### 7回目（2026-11-25・Codex read-only・新しい呼び出し）重0・中1 → 反映（改訂7）
| # | 指摘 | 裏取り | 対処 |
|---|---|---|---|
| 中1 | 同じ pending を表示する別の画面で破棄・期限切れになっても「保存されました」と出る | 設計 §4-3（24時間で消す）・§4-8 | 墓標は足さず（状態を増やさない）、ほかの画面では「片づきました（保存または破棄）」と言い、成功と言い切るのは応答を受けたフォームだけにした・T30f を破棄の場面まで固定 |
6回目の中1〜中3は解消と確認された（Codex）。

### 8回目（2026-11-25）重0・中1・軽1 → 反映
- 中1：§4-8 の成功の処理の括弧に旧い文言「保存されました」が残っていた → 「片づきました（保存または破棄）」に直した（grep で設計の本文に「保存されました」が §11 の記録以外に無いことを確かめた）。
- 軽1：T30f の行の列が1つ多かった → 壊し方を同じ欄に `<br>` で並べた。

### 9回目（2026-11-25）重0・中0・軽1 → 関門①通過
- 軽1：冒頭の状態の行が改訂7までだった → 直した。
- Codex の確認：§4-3・§4-6・§4-7・§4-8・§5-2・§6・§7 の間に矛盾なし。batch の全部か無か・置き換え後の読み手・下書きの衝突・個人情報・害・壊して落とす検査は該当行と整合。

## 12. 実装の記録（2026-11-25）
- CEO 決定：Q1 期限なし／Q2 `allow`（オーナーだけ）で実機確認 → `on`（どちらも別の PR）／Q3 お客様の画面に印は出さない。**この PR では `KARTE_TRAINING_EDIT = "off"` のまま**（既定をオンにする変更は単独の PR・CLAUDE.md §2-6）。
- 不変条件の番号：I86 は設計57（翌月の空き枠の見張り・claude/next-month-open）が使うため、本設計は **I87〜I90**（§7 の案の番号を1つずつずらした）。
- 版の印：`KARTE_BUILD 2026-11-25e`。
- 設計から変えた1点：§4-6 の「確認の文に『お客様の画面の数字も変わります』を足す」は、記録の画面の保存にふだん確認が無い（未記録のセットがあるときだけ）ため、**ダイアログを増やさず直す画面の上の1行（`.k-edhint`）で常に知らせる**形にした（片手で迷わず速く）。
- 自己レビューで見つけて直したもの：直す画面で日付を変えると `drawDateWarn` が［今日にする］を出していた → 先頭で EDIT なら出さない（L20 で固定）。
- 検査：`worker/test/karte-training-edit.test.js`（E1〜E32・37件）・`worker/test/liff-karte-training-edit.test.js`（L00・L20〜L32・53件）。壊して落とす確かめ40件（Worker 16・画面24）は全部落ちる（手順は PR の本文）。§7 の T 番号は検査では E（Worker）・L（画面）に読み替え。
- 関門②：1回目 重0・中1・軽1（中1＝種目の登録の退避の検査が文字列だけ → 画面から登録を実行する L31c に置き換え〔採用〕／軽1＝jsdom をリポジトリの外から読む → 全部の画面の検査が同じ作り・ops/cloud-setup.sh が lockfile で固定版を入れる約束のため却下）→ 2回目 **重0・中0**。
