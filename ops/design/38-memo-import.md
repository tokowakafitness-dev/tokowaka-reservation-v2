# 設計38 トレーナーのメモ（紙・スマホ）をカルテのトレーニング記録に取り込む（2026-11-06・**改訂3・関門①3周目の高2・中1を反映**）

> 状態：**下書き。Codex の関門① 1周目は未通過（重大2・高6・中4・低1）→ 改訂1。2周目は「3点を直せば通過」→ 改訂2。3周目は前回3点が解決・新しく高2・中1 → 改訂3。** 実装しない・push しない。
> 前に読んだもの：ops/MODEL.md（§0・§2-3b・§3 I46〜I62／I-M1〜I-M8・§4・§7・§8）・設計33（§4-2・§4-3・§9〜§11）・設計35（改訂1〜3）・
> worker/migrations/0025_karte.sql・0027_member_notes.sql・0028_karte_exercises.sql・worker/src/routes/karte.js（addTraining・deleteTraining・training・runWrite・replay・G・KARTE_LIMITS・KARTE_SCHEMA）・
> worker/src/lib/member-karte.js（readTraining）・liff/karte.js（trainingForm・buildPayload・uncheckedCount・exercisePicker・partOf・prevLabel・prevOfExercise・exerciseStats・exOrder・copyInto・trPickSub・trainingViews）・
> liff/index.html（MemberKarteView：_mkSetLine・_mkExRows・_mkViewTraining）・.github/workflows/worker-deploy.yml（L82-93）。

---

## 改訂3（Codex 関門① 3周目の反映・2026-11-06）変更点の一覧

| # | 指摘 | 変更（どこを直したか） |
|---|---|---|
| 1 高 | suggestKnown（最近の種目）の候補を押すと一押しで種目になっていた＝健康の文が最近の種目にあれば、一押しで保存の対象に戻る | **suggestKnown の候補を押したら名前の欄に仮に入れるだけ**。部位を選んで「種目にする」を押すまで確定しない（元の文字列と完全一致の候補でも同じ）。候補の近くにも I55 の注記。**autoKnown の候補だけは一押しで既知の種目に置き換えてよい**。P52〜P55 に「候補を押しただけでは items に入らない」、M21 に「押した後、部位を選んで種目にするまで記録の画面へ進めない」を足した（§4-1・§5-2・I71） |
| 2 高 | 新しい鍵の受付を止める手段が「古い Worker に巻き戻す」か「KARTE_SCHEMA を下げる再デプロイ」しかなく、schema 33 を持ったままの画面からの保存をサーバーで止められなかった | **Worker に受付の切替を足す**：wrangler.toml の `KARTE_TRAINING_EXT`（"off"／"allow"／"on"・厳密一致・それ以外は off）と `KARTE_TRAINING_EXT_TRAINERS`（allow のときの許可トレーナーの trainer_id のカンマ区切り・**氏名は書かない**）。off・未許可は新しい鍵を含む要求を **409 TRAINING_EXT_OFF**（旧形は今どおり保存）・karteSchema 32。on・許可済みは受け付けて karteSchema 33。画面は 409 を受けたら黙らずに知らせ、下書きを残す。関門③は allow（オーナーの trainer_id だけ）→1件保存→親の指し先を確かめる→on。不一致なら off。**古い Worker への巻き戻しを止める手段に使わない**（§3-7・§7・§12-5・I72・T30〜T35・M23） |
| 3 文書 | ★A はオーナーが確定した | **確定事項に移した**（無理やりのセットは会員に出さない）。§6-3-1（参考記録の差分表）と「確認中」の表現を削り、§6-3 は確定と理由・欠点だけにした |

## 改訂2（Codex 関門① 2周目の反映・2026-11-06）変更点の一覧

| # | 指摘 | 変更（どこを直したか） |
|---|---|---|
| 1 重大 | 自動で種目にする known に「この方の最近の種目」を入れていた。最近の種目は既存の自由文 `karte_tr_sets.exercise` 由来＝過去に健康の文が種目名として入っていれば、完全一致で自動保存が復活する | known を2つに分けた：**autoKnown＝固定の EXERCISES ＋ 共有の種目（karte_exercises の生きた行＝k_exercises の応答）だけ**（自動で種目にする・前方完全一致もこれだけ）／**suggestKnown＝この方の最近の種目**（「もしかして」の押せる候補にだけ使う）。P52〜P55 に「同じ文字列が最近の種目にあっても自動確定しない」を足し、P60・P61 を足した（§4-1・§4-2・§4-3・§5-2・I71） |
| 2 高 | trShape の条件2が ext の指す先を確かめていなかった | 条件2を「ext の set_id が**同じ session の** karte_tr_sets を指す（`t.session_id IS e.session_id`・`e.session_id IS sid`）・`t.exercise IS` 対応する karte_tr_exercises.exercise」に書き直し、**ext の無い本セット・親の無い ext・別の session を指す ext** の拒否を明記。T16 に「ext.set_id だけを別の session の set_id に差し替える」破壊を足した（§3-3・T16） |
| 2 補 | （改訂2で自分で見つけた）`karte_tr_set_ext.set_id INTEGER PRIMARY KEY` は SQLite の rowid の別名で、**NULL を入れるとエラーにならず新しい番号が自動で振られる**（`NOT NULL` を付けても同じ）。MAX(set_id) が NULL になったとき、黙って誤った親を指す | 型を `INT NOT NULL PRIMARY KEY`（rowid の別名にならない）に変えた。node:sqlite で「INTEGER PRIMARY KEY は NULL で番号が振られる／INT NOT NULL PRIMARY KEY は NOT NULL で失敗する」を実測。検査 T1c を足した（§3-1） |
| 3 中 | ★A の実装の前提が曖昧 | 実装の前提を「**無理やりのセットは会員へ出さない**」に固定。オーナーが「参考記録」案を選んだ場合に変わる箇所（SQL・allowlist・会員の表示・4言語の鍵・検査 14-4〜14-6）を §6-3-1 に列挙した（★改訂3：オーナー確定により §6-3-1 は削除） |
| 4 中 | 前方一致の候補が複数あるときの規則が無い | 前方一致は **autoKnown の長い名前から順に**試し、**残り全体が sets_line として成立する候補が1つのときだけ**採る。2つ以上成立すれば決定待ち。P62・P63 を足した（§4-2） |
| 5 CEO 決定 | D1 remote の batch の可視性・取引性が未確認のままだった | 使い捨ての D1 を作るのは CEO の権限外（Cloudflare の資源の新規作成・wrangler の認証は封鎖）。根拠を2つ書いた：①Cloudflare D1 の公式ドキュメントの batch() の仕様（文を順に実行し、1つ失敗すれば全体を戻す）②本番で既に同じ前提で動いている箇所（routes/karte.js:205-208 の回数の先行 batch・:543 と :716 の `G.mnoteMatch`）。成り立たなかったときは MAX が NULL になり NOT NULL で batch が失敗する＝黙って誤保存しない向き（2 補の型の変更が前提）。本番の最初の保存の直後に親が正しく指されているかを確かめる手順を関門③の項目に書いた（§11・§12-5） |

## 改訂1（Codex 関門① 1周目の反映・2026-11-06）変更点の一覧

| # | 指摘 | 変更（どこを直したか） |
|---|---|---|
| 重大1・高3 | 一致しない種目名・括弧書きを自動で構造やメモに入れていた（I55） | **CEO 決定**：種目名の行は**共有の種目・固定の EXERCISES・その顧客の最近の種目と完全一致したときだけ**自動で種目にする（★改訂2で「最近の種目」を自動から外した）。一致しない行は「決定待ち」＝トレーナーが「種目にする（部位を選ぶ）／社内メモに足す／捨てる」を選ぶまで保存しない。括弧書きは**無理やりの確定語だけ**構造にし、それ以外は「読めなかった部分」として決定待ち。セットのメモに入れるのはトレーナーが明示的に選んだときだけ（§4-3・§5-2・I64・I71） |
| 重大2 | 既存の表に ALTER していた。worker-deploy.yml は「ファイルの実行」と「schema_migrations の記録」の二操作（L90-92）で、途中失敗で記録が残らず次回 `duplicate column` で止まり続ける | **CEO 決定**：**既存の表に ALTER しない**。新しい表3つ（karte_tr_exercises・karte_tr_set_ext・karte_tr_drops）を `CREATE TABLE IF NOT EXISTS`／`CREATE INDEX IF NOT EXISTS` だけで作る＝何度流しても同じ結果。**ドロップは karte_tr_sets に置かない**（古い読み手が本セットと混同しない）。2回流す検査を本物の SQLite で固定（§3・I65・T1） |
| 高4 | 旧ハッシュの互換が広すぎた | 旧ハッシュで一致させるのは「旧形で、かつ**同じ種目名が2つ以上の種目に無い**」要求だけ。それ以外の不一致は 409（§3-4・I69） |
| 高5 | 画面の構造の単位が曖昧 | **構造の単位は ord**（日別・写す・前回カード・set_no は ord ごとに1〜10）。**自己ベスト・種目別推移だけ exercise**。copyInto・prevOfExercise・exerciseStats・partsSince・最近の種目の変更を列挙（§6-1） |
| 高6 | 古いトレーナー画面の自己ベストに forced が入る | **CEO 判断**：受け入れた残余として理由と期間を書いた（§7-2） |
| 高7 ★ | 会員に数字だけ出して印を隠すと 80kg/60kg の食い違い | 推奨を「**無理やりのセットは会員の画面に出さない**（日別・自己ベスト・推移とも）」に変更。代わりの案（中立の「参考記録」）を併記。冒頭の★へ（§6-3） |
| 高8 | schema 33 の確認の経路が不明確 | 通常の送信・pending の固定 payload の再送・下書きの復元後・doneOnly だけ・drops だけ・ドロップの中の補助/無理やり、の**すべての送信経路で毎回**確かめると明記し、検査 M13〜M19 に入れた（§5-4・I68） |
| 中9 | 見張りの条件が足りない | trShape に「ord が1からの連続」「本セットの set_no の ord 内の重複と連続（NULL 比較は IS／COALESCE）」「drop_seq の連続」「done_only の値」を足した（§3-3） |
| 中10 | 0.1 刻みでない小数を丸めていた | **丸めずに読めなかった部分**にする（P22・P50） |
| 中11 | 種目名と数値がつながる形を広く読んでいた | **既知の種目名との前方完全一致のときだけ**読む。それ以外は読めなかった行（P19・P49） |
| 中12 | 「50キロ10回」（×なし）を読んでいた・BNF と説明が不一致 | 第1段では**読まない**。BNF から外した（P40→P51） |
| 低13 | 互換表の重複・0029 の呼び方・操作数・F12 の注記 | 互換表を1行1事象に整理。migration は `0029_karte_tr_ext.sql` の1ファイル。例の操作数を数え直した。F12 を「ALTER はしないので該当しない・D1 remote の取引性は未確認」に直した |

---

## 倒れる向き（1行）

**読み取れないもの・意味が決まっていない書き方・既知の種目と完全一致しない名前・括弧書きは、推測で数値や種目やメモにせず「決定待ち」として画面に残し、トレーナーが選ぶまで保存しない（黙って捨てない・黙って構造にしない）。**

## この設計で決めること（★＝オーナーに確認が要る）

| # | 決めること | 推奨 |
|---|---|---|
| A（確定） | 会員の画面で、無理やりのセットをどう扱うか | **出さない**（日別・前回・自己ベスト・推移とも）＝**オーナー確定（2026-11-06）**（§6-3） |
| ★B | 取り込んだセットの✓ | **✓なしで入れる（I57 のまま）**。種目ごとの「全部✓」で1種目1タップで確かめる（速さより読み取りの誤りを✓で見つけることを取る・保存後に直す窓口が無い＝F4） |
| ★C | `50×10×3`（3セットの略記）・`20回`（重さが無い）・`60秒`・`50キロ10回`（×が無い） | オーナーが確定するまで**読めなかった行**（推測しない）。確定したら第2段で足す |
| ★D | 数字の無い種目を会員に出すか | **出す**（「実施」とだけ。種目名は既に会員に見えている） |
| ★E | 「できない」以外に無理やりを表す言葉 | いまは6語だけ（§4-2）。オーナーに語の一覧を確かめたい |
| 1 | データの持ち方 | **新しい表3つだけ**（既存の表に ALTER しない）：種目の並び `karte_tr_exercises`・本セットの付加 `karte_tr_set_ext`・ドロップ `karte_tr_drops`（§3） |
| 2 | 補助 | `assist_reps`（1〜100・NULL＝なし）。回数に足さない |
| 3 | 無理やり | `forced`（NULL／1）。自己ベスト・推移・推定1RM から外す。トレーナーの前回の値には印つきで出す |
| 4 | 構造の単位 | ord（その回の何番目の種目か）。自己ベスト・種目別推移だけ種目名 |
| 5 | 読み取り | liff 側の純粋関数。Worker は確定した構造だけ受け取る。原文はサーバーにも端末の保存領域にも残さない |
| 6 | 画面 | 「メモから取り込む」→ 貼る → 読み取る。決定待ちが無ければそのまま記録の画面（trainingForm）へ。あれば取り込みの画面の中で1つずつ選ぶ |
| 7 | 互換 | KARTE_SCHEMA 32→33。新しい項目を**使う保存だけ**、すべての送信経路で毎回33以上を確かめる |
| 8 | 外部の AI | 第3段の選択肢として書くだけ（§10）。今回は一切送らない |

---

## 1. なぜ

トレーナーはいま、紙やスマホのメモに記録を書いて、あとでカルテに1セットずつ打ち直している（または打ち直していない）。
**メモの形のまま貼れば、カルテのデータになる**ようにする。理想は音声だが、外部の AI に会員の記録を送るのはオーナー承認事項（憲法 §3-3・§3-4）。
第1段は**スマホのキーボードの音声入力（OS の機能）で話す → 文字になったものを貼る → 端末の中で読み取る**で、音声の入口を作る。

### 例（実際のメモ・オーナー提示）
```
9/18

腸腰筋ストレッチ
アーチスクワット
フロアアブ
0×10 10×10+0×10 10×10+0×10
ヒップリフト
30×10 50×10+5  80×5(できない)60×10+5 60×10+5
ラットプルダウン
10×10 15×10 20×10
ドンキーキック
60×10 80×10
ルーマニアン片足
9×10 14×10
```

### オーナーが確定した書き方の意味
| 書き方 | 意味 |
|---|---|
| `重さ×回数` | 1セット。`0×10`＝自重で10回（既存の「重量0＝自重」I61 と同じ） |
| `50×10+5` | 50kgで10回の後、**補助付きで5回追加**（＋の後ろが数字だけ＝補助の回数） |
| `10×10+0×10` | 10kgで10回の直後に重さ0で10回＝**ドロップセット**（＋の後ろが「重さ×回数」＝ドロップ） |
| `80×5(できない)` | **ちゃんとできていない、無理やりやった重さ** |
| 数字の無い行 | **やった種目として記録に残したい** |
| `9/18` | その回の日付 |

---

## 2. いまの事実（コードで確かめたこと）

| # | 事実 | 根拠 |
|---|---|---|
| F1 | `karte_tr_sets` は `set_id AUTOINCREMENT`・`set_no 1〜10`・`weight_kg NOT NULL 0〜500`・`reps NOT NULL 1〜100`・`note` だけ。(session_id, exercise, set_no) に UNIQUE は無い | 0025_karte.sql:83-91 |
| F2 | k_addTraining は「種目ごとに1〜10セット・種目1〜20・合計60行」。**セットが0の種目は 400（SETS）**。セットの知らない鍵は**黙って無視**する | routes/karte.js:498-521 |
| F3 | ハッシュの対象は `{cid, date, sets, member}`。sets は `{exercise, set_no, weight_kg, reps, note}` の平らな配列で、**種目の境目を持たない**（同じ名前が2つの種目にあると、どこで分かれるかがハッシュから分からない） | routes/karte.js:516・530 |
| F4 | **k_editTraining は存在しない**（設計33 A4 は未実装）。保存後に直すには削除して入れ直すしかない | routes/karte.js:1236-1264 |
| F5 | k_training はセットを `ORDER BY session_id, exercise, set_no` で返す。画面（exOrder）は set_no で並べ替えるだけ＝**種目の並びは名前順になり、入力した順は失われている** | routes/karte.js:1043・liff/karte.js:1341 |
| F6 | 会員側はセットを `ORDER BY session_id, set_id`＝入力の順。**トレーナー側と会員側で並びが違う** | member-karte.js:136-137 |
| F7 | トレーナーの推定1RM は Worker の `e1rm`・自己ベストは画面の `exerciseStats`（重量最大→回数最大）。会員の自己ベストは SQL（重量最大→回数最大→早い日）、会員の推移は画面で「その日の最大の重さ」 | routes/karte.js:106・liff/karte.js:1145・member-karte.js:119-125・index.html `_mkViewTraining` |
| F8 | 画面の送信は「✓かつ回数あり」のセットだけ（I57）。前回の呼び出し・写す・下書きの復元で✓の初期値は false | liff/karte.js `buildPayload`・`copyInto` |
| F9 | 画面は `karteSchema >= NEED_SCHEMA(32)` でなければ k_addTraining を送らない（全部の保存を止める）。確かめるのは `send()` の入口（pending の再送も send を通る） | liff/karte.js:19-21・1732 |
| F10 | セットのメモの選択肢に「補助あり」「フォーム崩れ」がある（自由文） | liff/karte.js `MEMO_PRESETS` |
| F11 | migration は Worker のデプロイの**前に**流す。各ファイルは「`--file` で実行」→「`schema_migrations` に記録」の**二操作**（L90-92）。実行が成功して記録が失敗すると、**次の実行で同じファイルがもう一度流れる**。この流れ（ワークフロー）は CEO の権限では変えられない（PAT に workflow 権限が無い） | worker-deploy.yml:82-93・env_cannot_push_workflows |
| F12 | LIFF は main への push で公開（GitHub Pages・CNAME）、Worker は worker/** の push で Actions。**同じ push でも LIFF が先に公開されうる** | worker-deploy.yml:10-12・CNAME |
| F13 | `karte_tr_sets` を読むのは routes/karte.js と lib/member-karte.js だけ（GAS・他の窓口は読まない） | grep（2026-11-06） |
| F14 | 同じ batch の中で前の文が書いた行を後の文が読む作りは**本番で既に動いている**：回数の先行 batch（karte_rate へ INSERT した直後の文が同じ行の n を読む）と、`G.mnoteMatch`（同じ batch で INSERT した karte_member_notes を読む）。Cloudflare D1 の公式ドキュメントの batch() の仕様は「文を順に実行し、1つ失敗すれば全体を戻す」。使い捨ての D1 で実測するのは CEO の権限外（§11-1） | routes/karte.js:205-208（回数）・:162-166（mnoteMatch の定義）・:543（addTraining）・:716（saveMemberNote） |
| F15 | MEMBER_KARTE は wrangler.toml で "off" | wrangler.toml:67 |
| F16 | 会員カルテのソース検査（5-1）の禁止語に `forced`・`assist`・`drop` は無い | member-karte.test.js:297-298 |

---

## 3. データの持ち方（migration `0029_karte_tr_ext.sql`）

### 3-1. 推奨の形（★新しい表を作るだけ・既存の表は1文字も変えない）

```sql
-- 設計38：種目の並び・数字の無い種目・補助・無理やり・ドロップ（2026-11-xx）
--   ★既存の表に ALTER しない。CREATE … IF NOT EXISTS だけ＝何度流しても同じ結果
--     （worker-deploy.yml は「実行」と「記録」の二操作。記録が失敗しても次の実行でそのまま通る＝F11）
--   ★NOT NULL を付けない列は「印が無い＝NULL」。既定値は入れない（MODEL §8）
--   ★ドロップは karte_tr_sets に置かない（古い読み手が本セットと数えないため）

CREATE TABLE IF NOT EXISTS karte_tr_exercises (          -- その回の種目の並び（新しい形の回だけ・全種目）
  session_id TEXT NOT NULL REFERENCES karte_tr_sessions(session_id),
  ord        INTEGER NOT NULL CHECK (ord BETWEEN 1 AND 20),
  exercise   TEXT NOT NULL CHECK (length(exercise) BETWEEN 1 AND 50 AND exercise = trim(exercise)),
  done_only  INTEGER CHECK (done_only IS NULL OR done_only = 1),   -- 1＝数字の無い種目（本セット0行）
  PRIMARY KEY (session_id, ord)
);

CREATE TABLE IF NOT EXISTS karte_tr_set_ext (            -- 本セット（karte_tr_sets の行）1つに1行
  --   ★型は INT（INTEGER にしない）。INTEGER PRIMARY KEY は rowid の別名になり、NULL を入れると
  --     エラーにならず新しい番号が振られる＝MAX(set_id) が NULL のとき黙って誤った親を指す（改訂2・実測）
  set_id      INT NOT NULL PRIMARY KEY REFERENCES karte_tr_sets(set_id),
  session_id  TEXT NOT NULL REFERENCES karte_tr_sessions(session_id),
  ord         INTEGER NOT NULL CHECK (ord BETWEEN 1 AND 20),
  assist_reps INTEGER CHECK (assist_reps IS NULL OR (assist_reps BETWEEN 1 AND 100)),
  forced      INTEGER CHECK (forced IS NULL OR forced = 1)
);
CREATE INDEX IF NOT EXISTS idx_karte_set_ext_session ON karte_tr_set_ext (session_id, ord);

CREATE TABLE IF NOT EXISTS karte_tr_drops (              -- ドロップの段（本セットの続き）
  set_id      INTEGER NOT NULL REFERENCES karte_tr_sets(set_id),   -- 親の本セット
  drop_seq    INTEGER NOT NULL CHECK (drop_seq BETWEEN 1 AND 3),
  weight_kg   REAL NOT NULL CHECK (weight_kg >= 0 AND weight_kg <= 500),
  reps        INTEGER NOT NULL CHECK (reps BETWEEN 1 AND 100),
  assist_reps INTEGER CHECK (assist_reps IS NULL OR (assist_reps BETWEEN 1 AND 100)),
  forced      INTEGER CHECK (forced IS NULL OR forced = 1),
  PRIMARY KEY (set_id, drop_seq)
);
```
node:sqlite（3.53.1）で「先頭の1文だけ流す→ファイル全体を2回流す」が通り、`SELECT MAX(set_id)` で親を指す INSERT が書けることを実測した（2026-11-06）。
改訂2で実測：`INTEGER PRIMARY KEY`（`NOT NULL` つきでも）に `SELECT MAX(set_id)`＝NULL を入れると**番号が自動で振られて成功する**。`INT NOT NULL PRIMARY KEY` と karte_tr_drops の `INTEGER NOT NULL`（複合主キー＝rowid の別名ではない）は **NOT NULL で失敗する**。

| 項目 | 持ち方 | 選ばなかった案と理由 |
|---|---|---|
| 並び・数字の無い種目 | `karte_tr_exercises`（主キー (session_id, ord)）。数字の無い種目＝done_only=1・本セット0行 | reps を NULL 可にする：NOT NULL は表の作り直しが要る（設計33 §4-3）。設計33 案の主キー (session_id, exercise)：同じ種目名を1回に2度やる回で壊れる（F1 で禁止されていない） |
| 本セットの付加（ord・補助・無理やり） | `karte_tr_set_ext`（set_id が主キー）。**新しい形の回の本セットには全部1行** | karte_tr_sets に ALTER：**重大2**（途中失敗で止まり続ける・F11） |
| ドロップ | `karte_tr_drops`（親の set_id と段の番号） | karte_tr_sets に同じ set_no の続きの行として置く：古い読み手（巻き戻した古い Worker の k_training・buildMemberKarte）は ext を知らず、**ドロップを本セットと数えて**自己ベスト・セット数・写すに入れる。別の表なら古い読み手には見えないだけ |
| 親の指し方 | 本セットの INSERT の直後に `INSERT … SELECT MAX(set_id) … FROM karte_tr_sets WHERE session_id = ?`（その回は同じ batch でしか書かれない新しい session_id なので、直前に入れた行が最大）。**見えなければ MAX は NULL＝ext・drops の NOT NULL で batch 全体が失敗する**（黙って誤保存しない・§11-1） | `last_insert_rowid()`：D1 での振る舞いが**未確認**。set_id を Worker で作る：AUTOINCREMENT の列に値を入れると連番と衝突しうる |

- 古い回（0029 より前）は3つの表に行が無い。読む側は「その回に karte_tr_exercises の行があれば新しい形・無ければ今までどおり」（3-5）。
- 外部キーは書いてあるが、D1 で外部キーの検査が効いているかは**未確認**（0001 で外部キーを外した経緯がある）。**一致は見張り（trShape）で守る**（3-3）。

### 3-2. 上限
| 上限 | いま | 推奨 | 理由 |
|---|---|---|---|
| 1種目（1つの ord）の本セット | 10 | **ord ごとに10**（set_no 1〜10） | 同じ名前の2つの種目は別々に数える |
| 1セットのドロップ | — | **3段まで**（`DROPS_PER_SET`） | 本文が膨らまないように |
| 1回の種目 | 20 | **20（数字の無い種目も数える）**＝ord 1〜20 | |
| 1回の合計 | 60（行） | **本セット＋ドロップの段で60**（コードは `TOTAL_SETS` のまま） | 本文16KB の余裕のための上限＝送る量で数える。文言「合計60セットまで（ドロップも1つと数えます）」 |
| 補助の回数 | — | 1〜100 | reps と同じ |

### 3-3. k_addTraining の変更（★既存の要求の形と、その答えを1文字も変えない）

**受ける形（新しい鍵は全部任意）**
```
items[] : { exercise, sets: [set…], doneOnly?: true }
set     : { weight, reps, note?, assist?: 1〜100 の整数, forced?: true, drops?: [drop…]（0〜3） }
drop    : { weight, reps, assist?: 1〜100, forced?: true }        ※ drop に note・drops は持たない
```
- `doneOnly: true` は `sets: []` のときだけ。`doneOnly` とセットの両方＝400（`DONE_ONLY`）。`doneOnly` が無くて `sets: []`＝今までどおり 400（`SETS`）。
- **セット・ドロップ・種目の中の知らない鍵は 400**（`SET_KEY`）。古い画面が送る鍵（item：exercise・sets／set：weight・reps・note）は全部知っている鍵。
- `forced` は `true` だけ受ける（`false`・`1`・`"true"` は 400）。
- 0.1 刻みでない重さ（`12.25`）は**丸めずに 400**（`SET_VALUE`）。画面のパーサも同じ規則（4-2）。★既存の手入力は `numOrNull` で丸めている（routes/karte.js:91-97）。**古い形の要求の扱いは変えない**（丸めのまま）。新しい鍵を1つでも使う要求からこの規則を当てる＝既存の挙動を変えない。
- 行に直す：種目の並び i（1始まり）を ord、その ord の中の本セットの並び j を set_no、ドロップの並び k を drop_seq。

**書く文（同じ batch・全部か無か＝I49）**
```
G.target(cid)
INSERT karte_tr_sessions …
（種目ごと）INSERT karte_tr_exercises (session_id, ord, exercise, done_only)
（本セットごと）INSERT karte_tr_sets (session_id, exercise, set_no, weight_kg, reps, note)       ← 今までと同じ文
              INSERT karte_tr_set_ext (set_id, session_id, ord, assist_reps, forced)
                SELECT MAX(set_id), ?, ?, ?, ? FROM karte_tr_sets WHERE session_id = ?
              （ドロップごと）INSERT karte_tr_drops (set_id, drop_seq, weight_kg, reps, assist_reps, forced)
                SELECT MAX(set_id), ?, ?, ?, ?, ? FROM karte_tr_sets WHERE session_id = ?
（member があれば）INSERT karte_member_notes … ／ G.mnoteMatch
G.trShape(sid)
karte_requests
```
- **古い形の要求も、新しい Worker では3つの表に行を作る**（ord は並び、補助・無理やり・ドロップは無し）。理由：新しい回の読み方を1つにする（古い形かどうかで読み方を分けない）。

**見張り `G.trShape(sid)`**（karte_guard の `state`＝BAD_STATE 409。Worker が組んだ行の自己矛盾を batch の最後に確かめる二重の守り。どれか1つでも当たれば batch 全体が戻る）：
1. その回の karte_tr_sets の行数 ≠ karte_tr_set_ext（`session_id IS sid`）の行数（本セットに付加の行が無い・余る）
2. **ext の指す先**（改訂2）。次のどれか1つでも当たれば失敗：
   - **ext の無い本セット**：`karte_tr_sets t WHERE t.session_id IS sid AND NOT EXISTS (SELECT 1 FROM karte_tr_set_ext e WHERE e.set_id IS t.set_id)`
   - **親の無い ext**：`karte_tr_set_ext e WHERE e.session_id IS sid AND NOT EXISTS (SELECT 1 FROM karte_tr_sets t WHERE t.set_id IS e.set_id)`
   - **別の session を指す ext**：`karte_tr_set_ext e JOIN karte_tr_sets t ON t.set_id IS e.set_id WHERE (e.session_id IS sid OR t.session_id IS sid) AND (t.session_id IS NOT e.session_id OR e.session_id IS NOT sid)`
   - **種目の不一致**：ext の (session_id, ord) に karte_tr_exercises の行が無い、または `t.exercise IS NOT x.exercise`（x＝`karte_tr_exercises` の `x.session_id IS e.session_id AND x.ord IS e.ord`）
3. ord が1からの連続でない：`COUNT(*) <> MAX(ord) OR MIN(ord) <> 1`（主キーで重複は無い）
4. 本セットの set_no が ord の中で重複している、または1からの連続でない：`GROUP BY e.ord HAVING COUNT(*) <> COUNT(DISTINCT t.set_no) OR MAX(t.set_no) <> COUNT(*)`
5. done_only の値：`COALESCE(done_only, 0) = 1` の種目に本セットがある／`done_only IS NULL` の種目に本セットが無い
6. ドロップの親が別の回の本セット（`karte_tr_drops.set_id` の karte_tr_sets.session_id が sid でない）、または drop_seq が1からの連続でない（親ごとに `COUNT(*) <> MAX(drop_seq)`）
7. 合計（本セット＋ドロップ）が60を超える／ord が20を超える（CHECK と Worker の検査に加えて三重目）
- NULL を比べる箇所は `IS`／`IS NOT`／`COALESCE` を使う（`=` は NULL で真にならず素通りする）。

**答え**：今までどおり `{ sessionId, rev:1 }`（＋member があれば mnoteId・mnoteRev）。足さない。

### 3-4. ハッシュの互換（I49・高4）
- 新しいハッシュは `{v:2, cid, date, items（正規化した種目の並び・各セットと段の新しい鍵は値があるときだけ）, member}`。保存するのは常にこれ。
- 旧ハッシュ（今の `{cid, date, sets, member}`）も見るのは、要求が**次の両方を満たすときだけ**：
  1. 新しい鍵（doneOnly・assist・forced・drops）を1つも使っていない（＝古い画面が作れる形）
  2. **同じ種目名が2つ以上の種目（items）に無い**（F3：旧ハッシュは種目の境目を持たない。同じ名前が2か所にあると、別の分け方の要求と同じハッシュになりうる）
- 保存済みのハッシュが新旧どちらかと一致すれば replayed。どちらとも一致しなければ今までどおり **409 REQ_REUSED**（上の条件を満たさない要求は新しいハッシュだけで比べる＝曖昧なら 409）。
- 目的：デプロイの前に古い画面が送り、結果が分からず、デプロイの後に送り直した同じ要求を REQ_REUSED にしない。

### 3-5. 読む側（k_training・buildMemberKarte）
新しい形の回か古い回かは「karte_tr_exercises にその回の行があるか」だけで決める。

**k_training（トレーナー）**
- `sessions[].sets[]` は**本セットだけ**の平らな配列のまま（古い画面がそのまま読める）。新しい形の回は各セットに `ord`・`assist_reps`・`forced`（真偽値）・`drops: [{weight_kg, reps, assist_reps, forced}]` を足す。**ドロップを平らな配列に混ぜない**。
- 新しい形の回だけ `sessions[].exercises: [{ ord, exercise, doneOnly }]` を足す。
- 並び：新しい回は `ord, set_no`。古い回は今までどおり `exercise, set_no`。
- `best`（推定1RM のグラフ）：**本セット（ドロップは別の表なので入らない）かつ forced が NULL**。reps は自分の回数（補助を足さない）。種目名ごと（I66）。
- 読む SQL は karte_tr_sets を起点に `LEFT JOIN karte_tr_set_ext`、ドロップは本セットの set_id で引く。どれも生きた session（`deleted_at IS NULL`）の id だけ（I70）。

**buildMemberKarte（会員・お客様の見え方）**
- **無理やりのセットは会員の画面に出さない（オーナー確定）**：`LEFT JOIN karte_tr_set_ext e ON e.set_id = t.set_id … WHERE e.forced IS NULL`。無理やりの本セットの下のドロップも出さない。無理やりのドロップの段は、その段だけ出さない。
- SELECT 句に `forced` を書かない（WHERE と JOIN の条件にだけ出る＝I67）。
- 返す形：`items[]` を ord の順（古い回は今までどおり set_id の順）。セット `{ setNo, weight, reps, assist }`、ドロップは本セットの下に `drops: [{ weight, reps, assist }]`、数字の無い種目は `{ exercise, sets: [], done: true }`。
- ある種目のセットが全部無理やりで、数字の無い種目でもない場合は、**その種目ごと出さない**（名前だけの空の行を出さない）。
- 自己ベスト（bestQ）：本セットかつ `e.forced IS NULL`。推移は会員の画面が出ているセットから計算する（無理やりのセットが応答に無いので、日別・自己ベスト・推移が同じ集合から作られ、食い違わない）。
- 古い会員の画面（キャッシュ）：drops を知らない＝ドロップが見えないだけ。数字の無い種目は名前だけの行。無理やりのセットはそもそも届かない。

### 3-6. 削除・その他の窓口への影響
| 窓口 | 影響 |
|---|---|
| k_deleteTraining | 変えない。session を論理削除すれば、3つの表の行は生きた session の id を通してしか読まれない（I70） |
| k_editTraining | **存在しない**（F4）。取り込みの誤りは保存の前に✓の画面で直す（★B の理由の一つ） |
| rev | session の rev だけ（変えない） |
| 回数の制限・access_log・karte_revisions | 変えない |
| k_exercises（共有の種目） | 変えない。**karte_tr_exercises を読まない**（I60・I70） |
| 本文16KB | セットに数十バイト足す。**いまでもセットのメモ（200字×60）を最大にすると約36KB で16KB を超えうる**（新しく生まれた問題ではない）。トレーニングの最大の要求の大きさを固定する検査があるかは**未確認**。推奨：画面が送る前に本文のバイト数を数え、超えるなら pending を固定する前に止める |

### 3-7. Worker の受付の切替（改訂3）

**目的**：新しい鍵（doneOnly・assist・forced・drops）を受け付けるかを、**画面の版に頼らずサーバーで決める**。画面が karteSchema 33 を覚えたまま（キャッシュ・開きっぱなし）でも、止めたいときに止められるようにする。止める手段に古い Worker への巻き戻しを使わない（巻き戻すと数字の無い種目・ドロップ・補助が見えなくなり、トレーナーの記録の見え方が壊れる＝§7-1 #9 は事故の想定であって手段ではない）。

**wrangler.toml の vars**（公開リポジトリに載る）
```toml
# ---- トレーニングの記録の新しい項目（補助・無理やり・ドロップ・数字の無い種目）の受付（設計38）----
#   "off"（既定）… 新しい鍵を含む k_addTraining は 409 TRAINING_EXT_OFF。旧形は今どおり保存。karteSchema は 32
#   "allow"     … KARTE_TRAINING_EXT_TRAINERS に載ったトレーナーだけ "on" と同じ。ほかは "off" と同じ
#   "on"        … 全トレーナーで受け付ける。karteSchema は 33
#   ★厳密に "on"／"allow" のときだけ開く。書き忘れ・打ち間違いは "off" に倒れる
KARTE_TRAINING_EXT = "off"
#   allow のときに受け付けるトレーナーの trainer_id（カンマ区切り）。★trainer_id だけ。氏名・メールを書かない
KARTE_TRAINING_EXT_TRAINERS = ""
```

**判定（Worker の1か所＝`trainingExtOn(env, who)`）**
- `mode = String(env.KARTE_TRAINING_EXT || '')`。`'on'` → 真。`'allow'` → `KARTE_TRAINING_EXT_TRAINERS` を `,` で割り、前後の空白を落とし、空を捨てた一覧に `String(who.trainerId)` が**完全一致**で在れば真。それ以外（`'off'`・空・打ち間違い・who.trainerId が空）→ 偽。
- **karteSchema を返す全部の応答**（routes/karte.js で `karteSchema: KARTE_SCHEMA` を返す6か所）は `karteSchemaFor(env, who)` に替える＝真なら33、偽なら32。画面の NEED_SCHEMA（32）で守っている既存の機能（お客様の欄・指導メモのタグ）は32で今どおり動く。

**k_addTraining の受付**
- 順番：①正規化（新しい鍵を使っているか＝extUsed を決める）→ ②**同じ送信番号の保存済みの結果があれば、それを返す（replay・3-4 のハッシュの互換を含む）**→ ③extUsed で `trainingExtOn` が偽なら **409 `TRAINING_EXT_OFF`**（回数の先行 batch より前・何も書かない）→ ④今までどおり。
  - ②を③より先にする理由：on のときに保存できた要求の結果が分からず、off に切り替えた後に送り直したとき、「保存できていない」と誤って伝えないため（誤って伝えると、トレーナーが別の送信番号で入れ直して二重になる）。
  - routes/karte.js `runWrite` の①（replay を引く）の後、②（回数の先行 batch）の前に、spec の `extUsed` を見て③を差し込む形にする。
- 旧形の要求（新しい鍵を1つも使わない）は、切替がどの値でも今どおり保存する（3つの表の行も作る＝読み方を1つにする・3-3）。
- 409 の応答は `{ success:false, code:'TRAINING_EXT_OFF' }` だけ（どのトレーナーが許可されているかを返さない）。access_log の result は既存の種類に合わせて `denied`。

**画面（liff/karte.js）**
- 409 `TRAINING_EXT_OFF` は**はっきりした断り**として扱う（pending を解き、次は新しい送信番号・send の既存の分岐）。黙らずに「この形の保存はまだ使えません（補助・無理やり・ドロップ・数字だけの種目）。入力は残っています。印を外せば保存できます」と出し、**下書きは残す**（I58）。
- 取り込みのボタン・補助などの欄は、今までどおり karteSchema 33 のときだけ出す（I68）。サーバーの切替が偽なら32が返るので、読み直せばボタンが消える。

**切替の操作**：wrangler.toml の値を変えて worker/** を push → Actions が Worker を再デプロイ（数分）。CEO が自分で行える（オーナーの操作は要らない）。値を変えた push は decisions に記録する。

---

## 4. 読み取り（パーサ）

### 4-1. 置き場所と原則
- `liff/karte.js` の純粋関数 `parseMemo(text, todayYmd, autoKnown, suggestKnown)`（`_t` に出して検査から呼ぶ）。DOM・保存領域・通信に触れない。
  - **autoKnown（自動で種目にしてよい名前）＝固定の EXERCISES ∪ 共有の種目（k_exercises が返した karte_exercises の生きた行の名前＝exMaster のキー）だけ**。どちらも「種目名として登録された名前」（I60：登録の欄に健康の言葉を入れない注記つき）。
  - **suggestKnown（候補にだけ使う名前）＝この方の最近の種目**（k_training の種目名＝`karte_tr_sets.exercise`、新しい回の karte_tr_exercises の名前）。**自動では種目にしない**。理由：最近の種目は既存の自由文 `karte_tr_sets.exercise` 由来で、過去に健康の文が種目名として入っていれば、完全一致で自動保存が復活する（改訂2・重大）。決定待ちのカードで「もしかして：◯◯」として出すだけで、**押しても名前の欄に仮に入るだけ**（部位を選んで「種目にする」を押すまで確定しない・元の文字列と完全一致の候補でも同じ・改訂3）。
  - 画面の「この方の最近の種目」の段（exercisePicker）は今までどおり（トレーナーが自分で押して選ぶ＝明示の操作）。
- **Worker では読まない。** 送るのは画面で確定した構造だけ。
- 数値は NFKC をかけた文字列で読む（全角数字・全角＋・全角括弧・全角空白・ｋｇ）。**種目名は元の文字のまま**（前後の空白を落とし、連続する空白を1つに）。自動の照合は**この名前と autoKnown の完全一致だけ**（NFKC や部分一致や suggestKnown で自動に寄せない）。
- 共有の種目が読めなかった・一部だけ（truncated）のときは autoKnown が小さくなる＝決定待ちが増える側へ倒れる。画面に「共有の種目を一部しか読めていないため、確かめが必要な名前が増えます」。

### 4-2. 文法（BNF 風・NFKC の後の数値部分）
```
memo        ::= line ( NL line )*
line        ::= blank | date | sets_line | known_line | known_sets_line | other
blank       ::= WS*
date        ::= WS* ( YEAR SEP_D )? MONTH SEP_D DAY ( "日" )? WS* ( "(" WEEKDAY ")" )? WS*
                SEP_D = "/" | "." | "月"
sets_line   ::= WS* set ( SETSEP set )* WS*
known_line  ::= BULLET? KNOWN                      KNOWN＝autoKnown の名前と完全一致（suggestKnown は使わない）
known_sets_line ::= BULLET? KNOWN WS* sets_line    空白でつながる形
                  | BULLET? KNOWN sets_line        ★空白なしでつながる形は、行の先頭が KNOWN と前方完全一致のときだけ
              ※ KNOWN の切り方（改訂2）：autoKnown の名前を**長い順に**行の先頭と比べ、
                 前方完全一致した名前ごとに「残り全体が（空白を落として）sets_line として成立するか」を見る。
                 成立する候補が**ちょうど1つ**のときだけ採る。0なら known_line か決定待ち、**2つ以上なら決定待ち**（どちらの名前か決めない）。
                 空白でつながる形でも同じ規則（空白の位置で切らない。空白の前の文字列が KNOWN と一致しても、
                 別の長い KNOWN でも成立するなら決定待ち）
set         ::= seg ( WS* "+" WS* seg ){0,3} ( WS* "+" WS* assist )? FORCED?
              ※ 補助は最後の seg（ドロップがあればその段）に付く
seg         ::= WEIGHT WS* MUL WS* REPS
assist      ::= INT ( "回" )?                       1〜100
WEIGHT      ::= DEC ( "kg" )?                       0〜500・小数は1桁まで（0.1 刻み）。2桁以上は読めない（丸めない）
REPS        ::= INT ( "回" )?                       1〜100
MUL         ::= "×" | "x" | "X" | "*" | "✕" | "✖" | "かける"
FORCED      ::= "(" FORCED_WORD ")"                 FORCED_WORD ∈ { できない, できず, 出来ない, できなかった, 無理やり, むりやり }
SETSEP      ::= WS+ | WS* ( "、" | "," ) WS* | （FORCED の直後に限り区切りなし）
BULLET      ::= "・" | "-" | "•" | INT ( "." | ")" ) WS+
```
- `+` の後ろが seg ならドロップ（3段まで）、数字だけなら補助（1つだけ・最後）。`50×10+5+3`（補助2つ）・`50×10+5+40×10`（補助の後ろにドロップ）・4段目のドロップは**読めない**。
- **`キロ` の単位と、×の無い形（`50キロ10回`）は第1段では読まない**（★C）。`kg` は付いても付かなくても同じ。
- **括弧書きは FORCED_WORD だけ構造にする。** それ以外（`(補助)`・`(片足)`・`(右膝痛)`・`(ゆっくり)`）は、その括弧を含むセットのかたまりごと**決定待ち**（4-3 の「読めなかった部分」）。
- 種目名の行の中の括弧（`ルーマニアン(片足)`）は名前の一部。autoKnown と完全一致すれば種目、しなければ決定待ち。

### 4-3. 行の役割と組み立て
1. 空の行は飛ばす。
2. 日付の行：**最初の1つだけ**。年が無ければ今年、それが今日（JST）より後なら去年。年があって未来・実在しない日（2/30）は読めなかった行。Worker の `isPastOrToday` と同じ条件を画面でも先に見る。
3. **2つ目の日付の行が出たら止める**。それ以降は全部読めなかった行（second_date）。「1回の記録に1日分だけ取り込みます。9/20 以降は保存した後にもう一度取り込んでください」。貼った欄の文字は消さない。
4. known_line：新しい種目。前の種目に数値が無ければ、前の種目は数字の無い種目（doneOnly）。
5. known_sets_line：新しい種目＋セット。
6. sets_line：直前の種目に足す（2行に分かれても続ける）。直前の種目が**決定待ちの名前**なら、そのかたまり（名前＋数値の行）として一緒に決定待ちにする。直前に何も無ければ読めなかった行（no_exercise）。
7. **それ以外の行は全部、決定待ち**：autoKnown と一致しない名前（健康の文「腰が痛い」「右膝に違和感」「血圧の薬」「体調が悪い」を含む。**最近の種目（suggestKnown）に同じ文字列があっても決定待ち**）・50字を超える行・`×` があるが文法に合わない行・つながる形で前方が autoKnown と一致しない行（`45度レッグプレス50×10`）・前方一致の候補が2つ以上成立する行。**どこにも自動で入れない**。
8. 行の中で読めたセットの後ろに読めない残りがあれば、読めたところまで入れ、残りを読めなかった部分（tail）として決定待ちに出す。括弧書きのあるセットは、そのセットのかたまりを決定待ちにする（paren）。
9. 上限（ord ごとの本セット10・ドロップ3・種目20・合計60）を超える分は入れず、決定待ち（limit・選べるのは「捨てる」だけ）。
10. 日付の行が無い：記録の画面の日付（既定は今日）のまま。「日付の行がありません。11/6 として入れます（見出しで変えられます）」。

### 4-4. 返す構造
```
{ date: 'YYYY-MM-DD' | null,
  items:   [{ exercise, doneOnly, sets: [{ w, r, assist, forced, drops: [{ w, r, assist, forced }] }] }],   ← autoKnown と完全一致した名前だけ
  pending: [{ kind: 'name' | 'line' | 'paren' | 'tail' | 'limit' | 'second_date' | 'bad_date' | 'no_exercise',
              lines: [行番号…], text: 元の文字, parsed?: { exercise?, sets? }（あれば読めた形の下見） }] }
```
（w・r は画面の下書きと同じ文字列。0 は自重として `w: ''`＝I61）
- pending の text は**画面のメモリにだけ**置く（§8）。

---

## 5. 画面

### 5-1. 入口
- 記録の画面（trainingForm）の「過去の記録から写す」の隣に **「メモから取り込む」**（44px）。`karteSchema >= 33` のときだけ出す（I68）。
- 送ったが応答が分からない（pending／mpending／memoPending）間は取り込ませない（写すと同じ）。

### 5-2. 取り込みの画面（専用の画面・trPickSub と同じ作り・navPush の sub＝'trimport'）
- 貼る欄：`textarea`・**16px**・10行・`autocomplete="off"`・`autocapitalize="off"`・`spellcheck="false"`。クリップボードの API は使わない。
- 案内：「紙のメモを打つか、貼ってください」「キーボードのマイクで話しても入ります（例：ヒップリフト／改行／30かける10　50かける10プラス5）」「痛み・診断・服薬はここに書かず『注意すること』へ」（I55）。
- 「読み取る」（44px・下に固定）。
- **決定待ちが0** → 下書きに入れて（5-3）記録の画面へ戻る。
- **決定待ちがある** → 同じ画面の中に1つずつカードで出す（ダイアログを使わない）。上に読めた分の要約（「9/18・5種目・本セット15（ドロップ2）」）。カードごとのボタン（各44px・縦に並べ、間を8px）：

| 決定待ちの種類 | 選べるもの |
|---|---|
| name（一致しない名前・とその下の数値） | **「種目にする」**（その場で部位を選ぶ欄が開く＝PART_KEYS の押すだけの欄・ダイアログなし。下の数値もセットとして入る。50字以内のときだけ）／**「社内メモに足す」**（元の文字をそのまま D.memo の末尾へ・社内メモの注記つき）／**「捨てる」**。一致しない名前に近い既知の名前（autoKnown ∪ suggestKnown。**suggestKnown は完全一致でもここに候補として出るだけ**）があれば「もしかして：◯◯」を押せる候補として出す（**自動では寄せない**）。押したときの動きは候補の出どころで分ける（改訂3）：**autoKnown の候補＝一押しでその既知の種目に置き換える**（登録済みの名前）／**suggestKnown の候補＝名前の欄に仮に入れるだけ**。部位を選んで「種目にする」を押すまで決定待ちのまま（元の文字列と完全一致の候補でも同じ）。候補の並びの真下にも「種目名に痛み・診断・服薬を入れない（『注意すること』へ）」 |
| paren（`80×5(右膝痛)` 等） | **「括弧を除いてセットにする」**／**「括弧の中をセットのメモに入れてセットにする」**（I55 の注記をボタンの真下に）／**「社内メモに足す」**／**「捨てる」** |
| line・tail・no_exercise・bad_date | 「社内メモに足す」／「捨てる」 |
| limit・second_date | 「捨てる」（second_date は「次に取り込む」の案内つき） |

- 全部決めると「記録の画面に入れる」が押せる。
- 「種目にする」で選んだ部位は**この画面からは送らない**（取り込みの画面は何も送らない＝トークンの取り直しが起きない・原文が退避に乗らない）。記録の画面の種目カードに既存の「共有の一覧にありません／部位を選んで登録」（exunreg・I60）を、選んだ部位を初期値にして出す。登録するか（全員の一覧に出すか）は既存どおりトレーナーが選ぶ。
- 取り込みの画面を出たら、貼った文字と決定待ちは**メモリから消える**（§8）。

### 5-3. 下書きへの入れ方
- 下書き（localStorage・I58）が**空**：日付をメモの日付にし、種目を入れる。
- 下書きに種目が**ある**：メモの日付と違えば入れない（「入力中の記録は 11/6 です…」）。同じ日付（または日付の行が無い）なら、取り込みの画面の中で2択（「いまの入力の後ろに足す」／「やめる」）。置き換えは作らない。
- ✓：**すべて false**（★B・I57）。入れた種目のカードに「メモから」の小さな印。
- 記録の画面の上に1行：「メモから 7種目・15セットを入れました。✓を付けて保存してください（✓の無いセットは保存されません）」。

### 5-4. 記録の画面（trainingForm）に足すもの（手入力でも使う）
| 足すもの | 置き場所 | 理由・守り |
|---|---|---|
| **「全部✓」** | 種目カードの見出しの右（「外す」と離す・44px） | 1種目1タップで確かめる。回数が空のセットには付けない |
| **実施（数字なし）** | 回数の入ったセットが1つも無い種目に「実施した」✓（48px）＝doneOnly | 回数のあるセットができたら消える（両方は送らない） |
| **補助・無理やり・ドロップ** | いまの ✎ の欄（見出しを「メモ・補助」に）：「補助 ＋[ ]回」／「無理やり」（切り替え・aria-pressed）／「ドロップを足す」（重量・回数の小さな行・3段まで・×で消す） | セットの行（grid）に列を増やすと片手で押せる幅が無くなる。ダイアログを増やさない |
| 印の表示 | セットの行の真下に小さく「＋補助5」「→ 自重×10」「無理」 | ✎ を閉じていても分かる |
| ✓の範囲 | ドロップは本セットの✓に含める | ✓を増やすと押し忘れが増える |
| よく使うメモ | 「補助あり」「フォーム崩れ」を外す | 構造の項目と自由文が二重になる（F10）。既存のメモの文字は変えない |

- `buildPayload`：本セットは「✓かつ回数あり」。ドロップは本セットが送られるときだけ、回数のある段を送る（重量の空は0）。doneOnly の種目は `{ exercise, sets: [], doneOnly: true }`。
- `uncheckedCount`：doneOnly の種目は数えない。回数が空のドロップの段は数える。
- 下書きの版（v:1）は変えず、新しい鍵を任意で足す（古い下書きは鍵が無い＝印なし）。

**★schema 33 の確認（高8・I68）**：送る中身（payload）が新しい鍵（doneOnly・assist・forced・drops、ドロップの中の assist・forced を含む）を1つでも使っていれば、`karteSchema < 33` のとき送らない（SCHEMA_MSG・入力は下書きに残る）。確かめる場所は `send()` の入口の1か所にまとめ、**次のすべての経路がそこを通る**ことを検査で固定する：
1. 通常の「保存する」
2. pending の固定 payload の「同じ内容で送り直す」（固定した payload をもう一度判定する。固定した時点の判定を使い回さない）
3. 下書きの復元（読み直し・開き直し）の後の保存・送り直し
4. doneOnly だけの payload
5. drops だけの payload
6. ドロップの中の assist／forced だけの payload
- 新しい鍵を使わない payload は今までどおり32以上で送る（全体を止めない＝F9 の挙動を変えない）。
- 判定は payload の中身を見て決める（画面の状態や「取り込みから来たか」で決めない）。

### 5-5. 使いやすさ（関門②で必ず問う）
- 押すもの 44px 以上・✓は 48px。「全部✓」と「外す」を離す。
- 例のメモ（§1）の操作数：「メモから取り込む」1 → 貼る（OS の貼り付け）1 → 「読み取る」1 → 「全部✓」5種目で5 → 「実施した」2 → 「保存する」1 ＋ 確認なし＝**11操作**（例の名前が全部 autoKnown にあるとき。無ければ決定待ちのカードで名前ごとに2操作＝「種目にする」＋部位）。
- 決定待ちのボタンは片手の親指で届く下半分に。

---

## 6. 表示

### 6-1. トレーナー画面（★構造の単位は ord・自己ベストと種目別推移だけ種目名）
| 関数・場所 | 変更 |
|---|---|
| `exOrder`（日別・前回カード・写す画面の中身） | 新しい回は **ord ごとのかたまり**（`exercises` の順・同じ名前でも別のかたまり・数字の無い種目もかたまりとして出す）。古い回は今までどおり名前でまとめる |
| `setLineOf` | 1つの ord のセットを並べる。印（補助・ドロップ・無理やり）が1つでもあればまとめ書き（`50kg × 10・10・8`）をせず1セットずつ：`50kg×10+補助5`／`10kg×10→自重×10`／`80kg×5（無理）`。数字の無い種目は `実施のみ` |
| `prevOfExercise`（前回の値・prevLabel） | 種目名で「入力中の日付より前の直近の回」を探す（今までどおり）。その回に同じ名前の ord が2つ以上あれば、**ord ごとに並べて「 ／ 」でつなぐ**。無理やりも印つきで出す |
| `addExercises` の1セット目 | 前回の回の、その名前の全 ord の本セットのうち、**無理やりでない最大**。無ければ空 |
| `copyInto`（写す） | **新しい回：写す元の1つの ord ＝ 下書きの1つの種目**（同じ名前が下書きにあっても混ぜない・後ろに足す）。ドロップの形は写す・補助と無理やりは写さない（その日の結果）・数字の無い種目は doneOnly のまま写す。**古い回：今までどおり**（名前でまとめ、下書きの同じ名前に足す＝関門② の挙動を変えない）。上限は ord ごとに10・種目20・合計60（ドロップを数える） |
| `exerciseStats`（自己ベスト・種目別推移） | **種目名ごと**（全 ord をまとめる）。本セットだけ（ドロップは平らな配列に無い）・**無理やりを除く**・回数は自分の回数 |
| `best`（Worker の推定1RM） | 同上（3-5） |
| `partsSince`（部位ごとの経過日数） | 数字の無い種目も数える（`exercises` の名前も見る） |
| `exercisePicker` の「この方の最近の種目」 | 数字の無い種目も数える（回ごとに名前を1回） |
| 並び | 新しい回は入力の順（F5 の名前順が直る）。古い回は今までどおり |

### 6-2. 会員画面 C2（4言語：ja・en・zh・zh-Hant）
| 鍵 | ja | en | zh | zh-Hant |
|---|---|---|---|---|
| `mk_assist` | `+補助{n}回` | `+{n} assisted` | `+辅助{n}次` | `+輔助{n}次` |
| `mk_drop` | `ドロップ` | `Drop set` | `递减组` | `遞減組` |
| `mk_done` | `実施` | `Done` | `已完成` | `已完成` |
- 表示例：`50kg×10 +補助5回`／`10kg×10 → 自重×10`（ドロップのある行に `mk_drop` のチップ）。数字の無い種目は名前の右に `実施`。
- 種目の並びは応答の items の順（新しい回は ord の順）。同じ名前の2つの種目は2行。
- `mk_counts`：種目数は出ている種目（数字の無い種目を含む）、セット数は出ている本セット（ドロップは数えない）。
- 値はすべて textContent。

### 6-3. 会員の画面での無理やりのセット（**オーナー確定・2026-11-06**）
- **無理やりのセットは会員の画面に出さない**（日別・前回・自己ベスト・推移とも）。無理やりの本セットの下のドロップも出さない。全部が無理やりの種目は種目ごと出さない。応答に `forced` の鍵は出さない（I67）。
- 理由：
  - 数字だけ出して印を隠すと、日別で「80×5」、自己ベストで「60×10」と出て、会員が食い違いを不思議に思う。
  - 「無理やり」はトレーナーのフォームの評価で、会員に見せると叱責として読まれやすい。
  - 出さない集合を Worker の SQL で決めると、日別・自己ベスト・推移が同じ集合から作られ、画面で計算しても食い違わない（3-5）。
- 欠点：会員は「やったはずの80kg」が記録に無いと感じうる。トレーナーの画面には残っている（記録は消えていない）。

### 6-4. ★D 数字の無い種目を会員に出す（推奨：出す）
- 種目名は既に会員に見えている（設計35 F3）。ストレッチだけの回が会員の画面で空の日にならない。

---

## 7. 互換（古い画面・古い Worker・schema の版）

### 7-1. 組み合わせ（1行1事象）
| # | 組み合わせ | 起きること | 守り |
|---|---|---|---|
| 1 | 古い画面 → 新しい Worker（保存） | 古い形の要求は全部知っている鍵＝通る。3つの表にも行ができる（ord は並び・印なし） | 検査 T6：古い buildPayload の出力で 200・答えの鍵が今までと同じ |
| 2 | 古い画面の pending をデプロイの後に送り直す | 旧ハッシュで一致＝replayed（3-4 の条件のときだけ） | T25〜T27 |
| 3 | 古い画面 → 新しい Worker（読む） | ドロップ・数字の無い種目が見えない。無理やりのセットが自己ベストに入る | 7-2 の受け入れた残余 |
| 4 | 新しい画面 → 古い Worker（保存） | 古い Worker は新しい鍵を黙って捨てる（F2）＝補助などが消えたまま「記録しました」 | **新しい鍵を使う保存は、すべての経路で karteSchema>=33 を確かめる**（5-4）。doneOnly（sets:[]）は古い Worker が 400 で断る |
| 5 | 新しい画面が古い Worker より先に公開される（F12） | karteSchema が32＝取り込みのボタンが出ない・新しい鍵を送らない | I68 |
| 6 | 新しい Worker が migration より先に動く | 新しい表への INSERT・SELECT が失敗＝**k_training が 500＝トレーニングのタブが見られない** | worker-deploy.yml は migration をデプロイの前に流し、失敗すれば止まる（`set -euo pipefail`）。順番を手で入れ替えない |
| 7 | migration の実行は成功・記録が失敗（F11） | 次の実行で同じファイルがもう一度流れる | **CREATE … IF NOT EXISTS だけ**＝2回目もそのまま通る（T1） |
| 8 | migration の途中で失敗 | 前の CREATE だけ残る | 次の実行でファイル全体がもう一度流れ、残った表は IF NOT EXISTS で飛ばされる（T1 の「先頭の1文だけ流した後に全体を2回」）。D1 remote の `--file` が1つの取引かは**未確認**（どちらでも同じ結果になる形にした） |
| 9 | Worker を古い版に巻き戻す | 古い Worker は新しい表を読まない＝数字の無い種目・ドロップ・補助が見えない・無理やりが自己ベストに入る。**ドロップを本セットと数えない**（別の表なので） | 既存の表を変えていないので、古い Worker はそのまま動く |
| 10 | 会員の古い画面 | drops を知らない＝ドロップが見えない。無理やりのセットは届かない | MEMBER_KARTE が off の間は会員に出ない（F15） |
| 11 | 画面が karteSchema 33 を覚えたまま、Worker の切替が off／未許可 | 新しい鍵を含む保存は **409 TRAINING_EXT_OFF**（何も書かない）。画面は知らせて下書きを残す。旧形の保存は通る | §3-7・T30〜T33・M23 |
| 12 | on で保存した要求の結果が分からず、off にした後に送り直す | 保存済みの結果を返す（replay が切替の判定より先） | §3-7・T34 |
| 13 | 止めたいとき | **切替を off にする**（schema 32＋サーバーで拒否）。古い Worker への巻き戻しは止める手段に使わない（#9 は事故の想定） | §3-7 |

**出す順番**：①`0029_karte_tr_ext.sql`（Actions がデプロイの前に流す）→ ②Worker（KARTE_SCHEMA 33）→ ③LIFF。②③を同じ push にしてよい（#5）。

### 7-2. 受け入れた残余（高6・CEO 判断）
- **何が**：古いトレーナーの画面（キャッシュ）の自己ベスト・種目別推移に、無理やりのセットが入る（古い exerciseStats は forced を知らない）。Worker の best（推定1RM）は新しい Worker が外すので、古い画面のグラフは正しい。
- **なぜ受け入れるか**：トレーナー内部の表示だけで、会員には出ない。記録（データ）は正しく、読み直せば消える。防ぐには応答から forced のセットを外す必要があり、トレーナーの記録の見え方を壊す。
- **期間**：そのトレーナーがカルテを読み直すまで（LIFF のキャッシュが入れ替わるまで）。長くても次に LINE から開き直すまで。

---

## 8. 個人情報

| もの | どこに残るか | 推奨 |
|---|---|---|
| 貼った原文 | 取り込みの画面の textarea（メモリ）だけ | **サーバーに送らない・localStorage／sessionStorage に入れない・console に出さない**。画面を出たら消える。取り込みの画面は何も送らない（部位の登録も記録の画面へ回す）＝トークンの取り直し（I62）の退避に乗らない |
| 決定待ち | メモリだけ | 同上。トレーナーが選んだときだけ、選んだ先（種目・社内メモ・セットのメモ）に入る |
| 読み取った構造 | 下書き（localStorage・24時間・氏名なし＝I58） | 既存の入力と同じ扱い。新しい保存場所を作らない |
| 健康の言葉 | — | **自動ではどこにも入らない**：autoKnown（固定の種目＋共有の種目）と一致しない行は全部決定待ち（最近の種目は自動に使わない）・括弧書きは確定語以外は決定待ち（I71）。意味の判定はしない（設計31 確定事項2・I55）。選ぶ欄の真下に「痛み・診断・服薬は『注意すること』へ」 |
| セットのメモ・社内メモ | トレーナーが明示的に選んだときだけ | 既存の欄と同じ注記 |
| キーボードの音声入力 | OS の機能。音声がどこで文字になるかは端末と設定で違う＝**未確認** | 私たちのシステムの外で、すでにどの入力欄でも使える。ただし案内で音声を勧める以上、オーナーに事実として伝える |

---

## 9. 不変条件（MODEL.md §3 に足す案）と守る検査

| | 不変条件 | 守る検査 |
|---|---|---|
| I63 | **メモの原文と決定待ちは端末のメモリの中だけ**：サーバーへ送らない・localStorage／sessionStorage に入れない・console に出さない。取り込みの画面は何も送らない | `liff-karte-import.test.js` M1・M17 |
| I64 | **読み取れない行を黙って捨てない・黙って数値にしない**：文法に合わない・2つ目の日付以降・実在しない/未来の日付・種目の無い数値・上限超え・行の残り・0.1 刻みでない小数・×の無い形・`50×10×3`・`20回`・`60秒` は決定待ちにし、トレーナーが選ぶまで「記録の画面に入れる」を押せない | `liff-memo-parse.test.js` P1〜P56・`liff-karte-import.test.js` M2 |
| I65 | **migration 0029 は新しい表を作るだけ**（CREATE … IF NOT EXISTS・既存の表に ALTER しない）＝途中で失敗しても、記録が残らなくても、次の実行で同じファイルがそのまま通る | `karte-training-ext.test.js` T1（本物の SQLite：先頭の1文だけ→全体→全体）・T1b（0029 のソースに `ALTER` と `DROP` が無い） |
| I65b | **トレーニングの1回の形**：種目は ord 1〜20 の連続（数字の無い種目＝done_only=1・本セット0）／本セットは ord ごとに set_no 1〜10 の連続／ドロップは本セットの続きで drop_seq 1〜3 の連続（別の表）／合計60（ドロップを数える）／補助は1〜100で回数に足さない／知らない鍵は400／doneOnly とセットの両方は400。自己矛盾は trShape で batch ごと戻す | `karte-training-ext.test.js` T2〜T20 |
| I66 | **自己ベスト・種目別推移・推定1RM は本セットかつ無理やりでない行だけ（種目名ごと）**。回数は自分の回数。日別・写す・前回は ord ごと。トレーナーの前回の値には無理やりも印つきで出す | T21〜T24、`liff-karte-import.test.js` M10〜M12・M20、`member-karte.test.js` 14-1〜14-3 |
| I67 | **会員の応答に無理やりのセットを出さない**（オーナー確定）。SELECT 句に forced を書かない（WHERE・JOIN の条件にだけ）。補助・ドロップ・数字の無い種目は出す | `member-karte.test.js` 14-4〜14-6（応答の JSON 全体に `forced` が無い・80kg の無理やりのセットがどこにも無い・ソースの SELECT 句に forced が無い・見え方も同じ） |
| I68 | **新しい鍵を使う保存は、すべての送信経路（通常・pending の再送・下書きの復元後・doneOnly だけ・drops だけ・ドロップの中の補助/無理やり）で毎回 karteSchema>=33 を確かめる**。使わない保存は32以上で送れる。取り込みのボタンは33以上でだけ出す | `liff-karte-import.test.js` M13〜M19 |
| I69 | **旧ハッシュで一致させるのは、新しい鍵を使わず、同じ種目名が2つ以上の種目に無い要求だけ**。それ以外の不一致は 409 | T25〜T27b |
| I70 | **読む側は3つの表を生きた session の id を通してだけ読む**。k_exercises は karte_tr_exercises を読まない（I60） | T28〜T29、`karte-exercises.test.js` に1本足す |
| I71 | **I55 との関係：取り込みは健康の言葉を自動でどこにも入れない**。自動で種目にするのは **autoKnown（固定の EXERCISES ＋ 共有の種目の生きた行）と完全一致した名前だけ**（この方の最近の種目＝既存の自由文 karte_tr_sets.exercise 由来は、候補として押させるだけで自動では使わない）、括弧書きで構造にするのは無理やりの確定語だけ。それ以外（健康の文・健康の括弧書きを含む）はトレーナーが「種目にする／セットのメモに入れる／社内メモに足す／捨てる」を明示的に選ぶまで保存しない。**最近の種目の候補を押しても名前の欄に仮に入るだけで、部位を選んで「種目にする」を押すまで確定しない**（autoKnown の候補だけ一押しで置き換えてよい）。選ぶ欄と候補の真下に I55 の注記 | P52〜P56・P60・P61（健康の文・括弧の健康語が全部決定待ち。最近の種目に同じ文字列があっても自動で確定しない）、`liff-karte-import.test.js` M21（決定待ちを選ばずに保存できない・選んだ先にだけ入る・注記がある・suggestKnown の候補を押しただけでは進めない） |
| I72 | **新しい鍵の受付はサーバーの切替（KARTE_TRAINING_EXT）で決める**：厳密に 'on'、または 'allow' で KARTE_TRAINING_EXT_TRAINERS に trainer_id が完全一致で載っているときだけ受け付け、karteSchema 33 を返す。それ以外は新しい鍵を含む k_addTraining を何も書かずに 409 TRAINING_EXT_OFF（画面が33を覚えていても）・karteSchema 32。旧形は切替に関わらず保存する。同じ送信番号の保存済みの結果は切替の判定より先に返す。許可の一覧に氏名を書かない。止める手段に古い Worker への巻き戻しを使わない | `karte-training-ext.test.js` T30〜T35、`liff-karte-import.test.js` M23 |

**既存の不変条件の書き換え**
- I57：「✓のセットだけ送る（前回の呼び出し・複製・下書きの復元・**メモの取り込み**でも✓の初期値は false）。ドロップは本セットの✓に従う。数字の無い種目は『実施した』の✓があるときだけ送る」。検査に M5・M6。
- I61：「ドロップの段も、重量の空は0」。
- MODEL §2-3b に3つの表を足す（書くのは k_addTraining だけ・読むのは k_training・buildMemberKarte・生きた session の id を通して）。
- MODEL §4 語彙表（カルテ）：

| 意味 | メモ | 画面（表示） | D1・Worker |
|---|---|---|---|
| 補助 | `50×10+5` | `+補助5`（会員 `mk_assist`） | `karte_tr_set_ext.assist_reps` 5（reps は10のまま）。ドロップの段は `karte_tr_drops.assist_reps` |
| ドロップ | `10×10+0×10` | `10kg×10→自重×10` | `karte_tr_drops`（親の set_id・drop_seq 1）。**karte_tr_sets には無い** |
| 無理やり | `80×5(できない)` | `（無理）`（**会員には出さない**） | `forced` 1（印なし＝NULL） |
| 数字の無い種目 | autoKnown と一致する名前だけの行 | `実施のみ`（会員 `mk_done`） | `karte_tr_exercises.done_only` 1・本セット0行 |
| 種目の並び | 行の順 | 新しい回は入力の順 | `ord`（古い回は karte_tr_exercises が無い＝名前順／会員は set_id の順） |
| 種目（構造） | — | ord ごとのかたまり | (session_id, ord)。自己ベスト・推移だけ exercise の名前 |

- MODEL §7 天井：「トレーニングの1回：種目20（数字の無い種目を含む）・本セット10/ord・ドロップ3/セット・合計60（ドロップを数える）・本文16KB」。

---

## 10. 段階

### 第1段（最小で価値が出る範囲・今回）
1. `0029_karte_tr_ext.sql`（新しい表3つ）
2. Worker：k_addTraining（3-3・3-4）・k_training（3-5）・buildMemberKarte（3-5）・KARTE_SCHEMA 33
3. LIFF：parseMemo（4）・取り込みの画面（5-2・5-3）・記録の画面の追加（5-4）・表示（6-1）・すべての送信経路の schema の確認
4. 会員画面 C2 の表示（6-2）。MEMBER_KARTE が off でも、お客様の見え方で同じ関数を使うので同時に入れる

### 第2段（運用を見てから）
- ★C の書き方をオーナーの確定どおり足す（秒は reps に入らない＝設計33 B2）
- 実際の音声入力の出方（漢数字・「キロ」・句読点）を実例で集めて文法に足す
- トレーナーの略記（「RDL」）の読み替え表（共有の種目に別名を持たせる）
- 保存後の編集（k_editTraining・設計33 A4）

### 第3段（選択肢として書くだけ）：音声を外部の AI に読ませる
- 形：録音 → 外部の音声認識・言語モデル → 4-4 と同じ構造 → **同じ取り込みの画面・記録の画面で、決定待ちと✓を通して保存**。
- 必要な承認（すべてオーナー）：①会員の記録を外部へ送ること（憲法 §3-3・§3-4）。メモには体調・痛みの言葉が混ざりうる＝**要配慮個人情報**を外部の事業者へ渡す可能性＝本人同意の取り方・委託先の管理（学習に使わない設定・保存期間）を法務として決める ②契約とコスト ③セキュリティを緩める変更（Worker から外部 API への通信の許可・API キーの登録はオーナー自身）。
- リスク：聞き間違い・作り話で数値を埋める（§0 に反する）→ 出力も autoKnown との完全一致と文法の規則を通し、外れたものは決定待ちにする。声そのものが個人の情報。
- ブラウザの音声認識（Web Speech API）も、iPhone では Apple のサーバーへ送られる場合がある（**未確認**）。

---

## 11. 未確認

1. **D1 remote の batch の中の可視性と取引性（改訂2・CEO 決定の扱い）**
   - 使い捨ての D1 を作って実測するのは Cloudflare の資源の新規作成で、CEO の権限外（wrangler の認証は封鎖）。だから実測はしない。
   - **根拠①（仕様）**：Cloudflare D1 の公式ドキュメント（Workers Binding API の `batch()`）は、batch の文を**順に実行し、1つが失敗すれば全体を戻す**（SQL の取引として扱う）と書いている。
   - **根拠②（本番で既に同じ前提で動いている箇所）**：routes/karte.js:205-208 の回数の先行 batch（karte_rate に INSERT した直後の文が、同じ行の n を読んで上限を判定する）。:543（k_addTraining）と :716（k_saveMemberNote）の `G.mnoteMatch`（:162-166・同じ batch で INSERT した karte_member_notes を読んで見張る）。前の文の行が見えなければ、回数の制限が効かず、mnoteMatch は常に素通りしていたことになる。
   - **成り立たなかったときの倒れる向き**：`SELECT MAX(set_id)` が NULL になり、karte_tr_set_ext（`INT NOT NULL PRIMARY KEY`）と karte_tr_drops（`INTEGER NOT NULL`）の NOT NULL で **batch 全体が失敗**する＝黙って誤保存しない（Codex 確認済み・改訂2で ext の型を rowid の別名でない形に変えたことが前提。`INTEGER PRIMARY KEY` のままだと NULL で番号が振られて**成功してしまう**＝実測）。trShape の条件1・2も同じ失敗を二重に捕まえる。
   - **確かめる手順は関門③の項目**（§12-5）。
   - migration の `--file` が1つの取引かは未確認のまま（どちらでも同じ結果になる形にした＝I65）。
2. D1 で外部キーの検査が効いているか（0001 の経緯）。効いていなくても trShape で守る
3. iPhone・Android のキーボードの音声入力が「50かける10」「50×10」「50キロ10回」「五十」のどれで出るか・改行の入り方
4. キーボードの音声入力の音声が端末の中で文字になるか、外部のサーバーへ送られるか
5. 本番の karte_tr_sets に、同じ回で同じ種目名が2度出ている行があるか（古い回の表示は名前でまとめられる）
6. トレーニングの最大の要求（メモ200字×60）の本文の大きさを固定する検査があるか
7. トレーナーのメモの書き方のゆれ（`@`・`/`）。今回は読まない（決定待ち）
8. MEMBER_KARTE を on にする時期（設計35 の関門③）
9. 無理やりを表すほかの言葉（★E）

---

## 12. 検査

### 12-1. パーサの実例の表（`worker/test/liff-memo-parse.test.js`・本番の liff/karte.js から `_t.parseMemo` を取り出して呼ぶ）
今日＝2026-11-06（JST）。autoKnown＝{腸腰筋ストレッチ, アーチスクワット, フロアアブ, ヒップリフト, ラットプルダウン, ドンキーキック, ルーマニアン片足, スクワット, ベンチプレス, プランク, カール, ディップス, ランジ, クランチ}（**45度レッグプレス は入れない**）。suggestKnown＝{腰が痛い, 右膝に違和感, 血圧の薬, 体調が悪い, ｽｸﾜｯﾄ}（**過去の自由文に健康の文が種目名として入っていた場合を模す**）。「決定待ち」は pending に入り items に入らないこと。

| # | 入力 | 期待する構造 |
|---|---|---|
| P1 | オーナーの例（§1 全文） | date 2026-09-18／items 7：腸腰筋ストレッチ（doneOnly）・アーチスクワット（doneOnly）・フロアアブ [0×10],[10×10→0×10],[10×10→0×10]・ヒップリフト [30×10],[50×10 補助5],[80×5 無理],[60×10 補助5],[60×10 補助5]・ラットプルダウン [10×10],[15×10],[20×10]・ドンキーキック [60×10],[80×10]・ルーマニアン片足 [9×10],[14×10]／pending 0 |
| P1b | P1 を autoKnown＝空で（suggestKnown に P1 の名前を全部入れても同じ） | items 0・pending 7（name。各名前の下の数値が一緒に下見に入る） |
| P2 | `スクワット\n50×10` | [50×10] |
| P3 | `スクワット\n50x10 50X10 50*10 50＊10 50✕10` | 5セット すべて 50×10 |
| P4 | `スクワット\n５０×１０　６０×８` | [50×10],[60×8] |
| P5 | `スクワット\n50kg×10 60ｋｇ×8回` | [50×10],[60×8] |
| P6 | `プランク\n0×10` | [0×10]（自重） |
| P7 | `ヒップリフト\n50×10+5` | [50×10 補助5] |
| P8 | `ヒップリフト\n50×10＋5回` | [50×10 補助5] |
| P9 | `フロアアブ\n10×10+0×10` | [10×10 → drop 0×10] |
| P10 | `フロアアブ\n10×10+0×10+5` | [10×10 → drop 0×10 補助5] |
| P11 | `カール\n20×10+15×10+10×10+5×10` | 3段のドロップ |
| P12 | `カール\n20×10+15×10+10×10+5×10+3×10` | 決定待ち（limit：ドロップ4段） |
| P13 | `ヒップリフト\n80×5(できない)` | [80×5 無理] |
| P14 | `ヒップリフト\n80×5（出来ない）` | [80×5 無理] |
| P15 | `ヒップリフト\n80×5(できない)60×10+5` | [80×5 無理],[60×10 補助5] |
| P16 | `ディップス\n0×8(補助)` | 決定待ち（paren）。items のディップスはセット0＝doneOnly にもならない（決定待ちが決まるまで） |
| P17 | `ランジ\n10×10(片足)` | 決定待ち（paren） |
| P18 | `ラットプルダウン 10×10 15×10` | 1種目 [10×10],[15×10] |
| P19 | `ベンチプレス40×10` | ベンチプレス [40×10]（前方が autoKnown と完全一致・成立する候補は1つ） |
| P20 | `45度レッグプレス` | 決定待ち（name：autoKnown に無い） |
| P21 | `スクワット\n130×10` | [130×10] |
| P22 | `スクワット\n12.5×10` | [12.5×10] |
| P23 | `スクワット\n50×0 50×101 501×10` | 3つとも決定待ち（tail／line） |
| P24 | `スクワット\n50×10×3` | ★決定待ち |
| P25 | `クランチ\n20回` | ★決定待ち |
| P26 | `プランク\n60秒` | 決定待ち |
| P27 | `9/18(木)\nスクワット\n50×10` | date 2026-09-18 |
| P28 | `9月18日\nスクワット\n50×10` | date 2026-09-18 |
| P29 | `2026/9/18\nスクワット\n50×10` | date 2026-09-18 |
| P30 | `12/24\nスクワット\n50×10` | date **2025**-12-24 |
| P31 | `2/30\nスクワット\n50×10` | date null・決定待ち（bad_date） |
| P32 | `2027/1/1\nスクワット\n50×10` | date null・決定待ち（bad_date） |
| P33 | `9/18\nスクワット\n50×10\n9/20\nベンチプレス\n40×10` | 9/18 の1種目だけ・決定待ち（second_date・3行） |
| P34 | `50×10\nスクワット\n60×10` | 1行目は決定待ち（no_exercise）・スクワット [60×10] |
| P35 | `\n\n  スクワット  \n\n  50×10  \n` | スクワット [50×10] |
| P36 | `スクワット\n50×10\n60×10` | [50×10],[60×10] |
| P37 | 51字の文 | 決定待ち（name・50字超え）。どこにも自動で入らない |
| P38 | スクワットに 50×10 を11個 | 10セット・11本目は決定待ち（limit） |
| P39 | `スクワット\n50×10+5+3` | 決定待ち |
| P40 | `スクワット\n50かける10` | [50×10] |
| P41 | `スクワット\n50×10 ああ` | [50×10]・決定待ち（tail「ああ」） |
| P42 | `1. スクワット\n・ベンチプレス\n40×10` | スクワット（doneOnly）・ベンチプレス [40×10] |
| P43 | `ｽｸﾜｯﾄ\n50×10` | 決定待ち（name。候補「スクワット」を出す・自動では寄せない） |
| P44 | 21種目の autoKnown の名前の行 | 20種目・21個目は決定待ち（limit） |
| P45 | 合計61（ドロップを含む）になるメモ | 60まで・残りは決定待ち（limit） |
| P46 | `スクワット\n50×10\nスクワット\n60×10` | ord 1・ord 2 の2つの種目（混ぜない） |
| P47 | `スクワット\n50×10+5+40×10` | 決定待ち（補助の後ろにドロップ） |
| P48 | `スクワット 50×10 60×10`（autoKnown を空にして） | 決定待ち（name・下見に2セット） |
| P49 | `45度レッグプレス50×10` | **決定待ち**（前方が autoKnown と一致しない） |
| P50 | `スクワット\n12.34×10` | **決定待ち**（0.1 刻みでない・丸めない） |
| P51 | `スクワット\n50キロ10回` | **決定待ち**（×の無い形・第1段では読まない） |
| P52 | `腰が痛い` | **決定待ち**（name）・items 0。**suggestKnown に同じ文字列があっても自動確定しない**（候補として出るだけ）。**候補「腰が痛い」を押しただけでは items に入らない**（名前の欄に仮に入るだけ＝M21） |
| P53 | `右膝に違和感` | **決定待ち**（suggestKnown に同じ文字列があっても自動確定しない・候補を押しただけでは items に入らない） |
| P54 | `血圧の薬` | **決定待ち**（suggestKnown に同じ文字列があっても自動確定しない・候補を押しただけでは items に入らない） |
| P55 | `体調が悪い` | **決定待ち**（suggestKnown に同じ文字列があっても自動確定しない・候補を押しただけでは items に入らない） |
| P56 | `ヒップリフト\n80×5(右膝痛)` | **決定待ち**（paren）。セットのメモにも入らない |
| P57 | `腰が痛い\n0×10`（suggestKnown に「腰が痛い」） | **決定待ち**（name・下見に [0×10]）。items 0 |
| P58 | `ｽｸﾜｯﾄ\n50×10`（suggestKnown に「ｽｸﾜｯﾄ」・autoKnown に「スクワット」） | 決定待ち。候補は「ｽｸﾜｯﾄ」「スクワット」の両方（押させるだけ） |
| P59 | `腰が痛い50×10`（suggestKnown に「腰が痛い」） | **決定待ち**（前方一致は autoKnown だけ） |
| P60 | suggestKnown にだけある名前の行（例 `ゴブレットスクワット`）| **決定待ち**（最近の種目でも自動確定しない） |
| P61 | P60 の名前が後で共有の種目（autoKnown）に登録された | 種目として自動で入る（登録＝I60 の登録の欄を通った名前） |
| P62 | autoKnown＝{レッグプレス, 45度レッグプレス}・`45度レッグプレス50×10` | 45度レッグプレス [50×10]（長い順に試し、成立する候補が1つ：「45度レッグプレス」の残り「50×10」が成立・短い「レッグプレス」は先頭が一致しない） |
| P63 | autoKnown＝{カール, カール1}・`カール110×10` | **決定待ち**（「カール1」の残り「10×10」も「カール」の残り「110×10」も成立＝候補が2つ） |

### 12-2. 本物の SQLite の検査（`worker/test/karte-training-ext.test.js`・node:sqlite に schema.sql と 0001〜0029 を流し、入口の index.js から通す）
- **T1** 0029：先頭の1文だけ流す → ファイル全体 → ファイル全体、がすべて通り、3つの表と索引が1つずつある（I65）
- **T1b** 0029 のソースに `ALTER`・`DROP` が無い／0025 の karte_tr_sets の定義が0029 の前後で同じ（`sqlite_master.sql` の比較）
- **T1c**（改訂2）karte_tr_set_ext・karte_tr_drops に `SELECT MAX(set_id) … WHERE session_id = '存在しない'`（＝NULL）で INSERT すると **NOT NULL で失敗し、番号が自動で振られない**。0029 の ext の set_id の型が `INTEGER PRIMARY KEY` でないこと（`sqlite_master.sql` を見る）
- T2〜T5 CHECK：assist_reps 0／101、forced 0／2、drop_seq 0／4、ord 0／21 が失敗
- T6 古い形の要求（設計38 より前の buildPayload の出力）が 200・答えが `{sessionId, rev}` だけ・3つの表に行ができる
- T7 例（P1）を送る→exercises 7（done_only 2）・本セット15・ext 15・drops 2・assist 3・forced 1
- T8 doneOnly とセットの両方→400 DONE_ONLY・行が増えない
- T9 doneOnly なしの sets:[]→400 SETS
- T10 知らない鍵（セット `rpe`・ドロップ `note`・種目 `memo`）→400
- T11 forced に `false`・`1`→400
- T12 ドロップ4段→400 DROPS
- T13 ord ごとの本セット11→400（本セット10＋ドロップ20＝合計30は通る）
- T14 合計61（ドロップを含む）→400 TOTAL_SETS
- T15 種目21→400 ITEMS
- T15b 新しい鍵を使う要求で `12.25`→400 SET_VALUE／古い形の要求の `12.25`→今までどおり 12.3 で保存
- **T16** trShape：Worker の組み立てを1か所ずつ壊して（ext を1行落とす・ext を1行余分に足す（親の無い ext）・**ext.set_id だけを別の session の set_id に差し替える**（改訂2）・ext.session_id だけを別の session にする・ord を飛ばす・set_no を重ねる・drop_seq を飛ばす・done_only の種目にセット・ドロップの親を別の回へ・exercise の名前を変える）。差し替えの破壊では、**別の session（先に保存した回）の行が1つも変わっていない**ことも確かめる、それぞれ batch 全体が戻り BAD_STATE
- T17 member つきでも全部か無か
- T18 同じ種目名が1回に2度→ord 1 と ord 5 の別の行・set_no はそれぞれ1から
- T19 k_training：新しい回は ord の順・古い回は今までどおり
- T20 k_training：sets にドロップが無い・drops は本セットの下・exercises は新しい回だけ
- T21〜T24 best：無理やりが入らない／補助を足さない／無理やりだけの種目は出ない／同じ名前の2つの ord をまとめる
- T25 旧ハッシュの行に、同じ古い形の要求→replayed
- T26 同じ鍵で補助を足した要求→409
- T27 新しい形の要求の再送→replayed
- **T27b** 同じ種目名が2つの種目にある古い形の要求：旧ハッシュの行と一致しても replayed にせず 409（I69）
- T28 回を消すと k_training・buildMemberKarte から exercises・drops も消える
- T29 消した回の3つの表の行は残るが読まれない
- **T30**（I72）KARTE_TRAINING_EXT="off"：補助つきの要求→409 TRAINING_EXT_OFF・3つの表にも karte_tr_sets にも行が増えない・回数（karte_rate）も増えない／**旧形の要求は 200**
- **T31** "off" のとき karteSchema を返す6つの窓口が全部32／"on" のとき全部33（窓口の一覧は KARTE_HANDLERS から機械で取り出す）
- **T32** "allow"＋TRAINERS="t1, t2"：t1 の補助つきの要求は 200・karteSchema 33／t3 は 409・karteSchema 32／前後の空白を許す・部分一致（"t" や "t1x"）は許さない／TRAINERS が空なら全員 409
- **T33** 値の打ち間違い（"ON"・"true"・"allow "・未設定）は全部 off と同じ
- **T34** "on" で保存した要求の結果を、"off" に替えてから同じ送信番号・同じ中身で送る→replayed（409 にしない）
- **T35** doneOnly だけ・drops だけ・ドロップの中の assist／forced だけの要求も "off" で 409（新しい鍵の判定に抜けが無い）

### 12-3. jsdom で入口から通す検査（`worker/test/liff-karte-import.test.js`・本番の liff/karte.js を jsdom で動かす）
- M1（I63）開く→記録→「メモから取り込む」→P1 を貼る→読み取る→7種目→全部✓×5・実施した×2→保存→送られた本文が 3-3 の形で P1 の構造。fetch の本文・localStorage・sessionStorage・console に原文全体が出ない
- M2（I64）決定待ちのあるメモ→カードが出る・「記録の画面に入れる」が押せない→1つずつ選ぶ→押せる→選んだ先にだけ入っている
- M3 2つ目の日付→1日分だけ・案内・貼った欄は残る
- M4 下書きと日付が違う→入れない／日付の行が無い→2択→後ろに足す
- M5（I57）取り込んだセットの✓が全部 false・そのまま保存→送られない
- M6 ドロップは本セットの✓に従う・数字の無い種目は「実施した」が無いと送られない
- M7 pending の間は取り込めない
- M8 「種目にする」で部位を選ぶ→記録の画面の exunreg にその部位が初期値で出る・取り込みの画面から k_saveExercise が送られない
- M9 手入力：✎→補助・無理やり・ドロップ→印→送られる鍵
- M10〜M12（I66）exerciseStats の自己ベストに無理やりが入らない／prevLabel の印と ord ごとの並び／1セット目が無理やりでない最大
- **M13〜M19（I68）** karteSchema 32 の応答で：M13 取り込みのボタンが出ない／M14 補助つきの通常の保存が送られない／M15 補助なしの保存は送られる／M16 pending の固定 payload（新しい鍵つき）の「同じ内容で送り直す」が送られない／M17 下書きの復元（読み直し）後の保存が送られない、かつ取り込みの画面ではトークンの取り直しが起きない／M18 doneOnly だけ・drops だけの payload が送られない／M19 ドロップの中の assist・forced だけの payload が送られない
- M20（高5）copyInto：新しい回の同じ名前の2つの ord が2つの種目として写る・古い回は今までどおり下書きの同じ名前に足される
- M21（I71）健康の文・健康の括弧書きを含むメモ（k_training の応答の最近の種目に同じ健康の文が種目名として入っている状態で）→決定待ち・「もしかして」に出るだけ→**suggestKnown の候補を押すと名前の欄に入るが、部位を選んで「種目にする」を押すまで「記録の画面に入れる」が押せない・下書き（localStorage）にも入らない**／autoKnown の候補（例：ｽｸﾜｯﾄ→スクワット）は一押しで種目になる→選ばずに保存できない・注記がある・「括弧の中をセットのメモに入れる」を選んだときだけ note に入る
- M22（使いやすさ）新しいボタンが 44px 以上（✓は48px）・貼る欄が16px
- **M23（I72）** k_training が karteSchema 33 を返した後に、Worker の身代わりが k_addTraining へ 409 TRAINING_EXT_OFF を返す→画面が「この形の保存はまだ使えません…」を出す・pending が解ける・下書き（種目・セット・補助の印）が残る・次の保存は新しい送信番号／その後 karteSchema 32 の応答で読み直すと取り込みのボタンが消える
- 会員：`liff-member-karte.test.js` 14-x：補助・ドロップ・実施の表示（4言語）・同じ名前の2つの種目が2行・無理やりのセットが応答に無い前提で日別・自己ベスト・推移が一致

### 12-4. 壊して落ちることを確かめる（実装の後に1つずつ）
| 壊すところ | 落ちるべき検査 |
|---|---|
| known との完全一致をやめて、知らない名前を種目にする | P1b・P20・P52〜P55・M21 |
| autoKnown に最近の種目（suggestKnown）を混ぜる | P52〜P55・P57・P59・P60 |
| 前方一致で最初に当たった候補を採る（候補が2つの判定を外す） | P63 |
| ext の set_id の型を INTEGER PRIMARY KEY に戻す | T1c |
| 括弧書きを自動でセットのメモに入れる | P16・P17・P56・M21 |
| `+` の判定（ドロップと補助を逆にする） | P7・P9・P10・M1 |
| 無理やりの語から「できない」を消す | P13・P1 |
| 2つ目の日付で止めない | P33・M3 |
| 0.1 刻みでない小数を丸める | P50・T15b |
| つながる形を autoKnown 以外でも割る | P49・P59 |
| ×の無い形を読む | P51 |
| 決定待ちを黙って捨てる | P23・P37・P41・M2 |
| 0029 に ALTER を1行入れる | T1・T1b |
| trShape の条件を1つずつ外す | T16 |
| 知らない鍵の 400 を外す | T10 |
| best で forced の条件を外す | T21・M10 |
| buildMemberKarte の WHERE から forced の条件を外す／SELECT に forced を足す | member-karte 14-4〜14-6 |
| 旧ハッシュの「同じ名前が2つ以上」の条件を外す | T27b |
| pending の再送で schema を確かめない | M16 |
| copyInto で新しい回の同じ名前を混ぜる | M20 |
| 下書きの保存に原文を入れる | M1 |
| suggestKnown の候補を一押しで確定させる | P52〜P55・M21 |
| 切替の判定を外す（常に受け付ける） | T30・T32・T35 |
| 切替の判定を replay より先に置く | T34 |
| karteSchema を定数のまま返す（切替を見ない） | T31 |
| 画面が 409 TRAINING_EXT_OFF で下書きを消す・黙る | M23 |

`run-all`（一括で走らせて落ちたら終了コード1）に新しい3ファイルを足す。model-doc.test.js が §3 の検査ファイルの実在を見る。

### 12-5. 関門③（顧客に出す前）の項目：本番で親が正しく指されているかを確かめる（改訂2・改訂3で切替の手順に）
1. **allow で出す**：`KARTE_TRAINING_EXT="allow"`・`KARTE_TRAINING_EXT_TRAINERS="<オーナーの trainer_id だけ>"` で Worker・画面を出す（ほかのトレーナーには karteSchema 32＝取り込みのボタンが出ず、新しい鍵はサーバーで拒否）。オーナーの trainer_id の値は CEO が名簿で確かめる（ここには書かない）。
2. **オーナーが1件保存する**：ドロップ・補助・無理やり・数字の無い種目を含む記録（メモから取り込むでも手入力でもよい）。
3. **親の指し先を読んで確かめる**：保存の直後に k_training をその顧客で読む（トレーナーの画面の「日別の記録」で見るか、CEO が作業依頼で読み取る）。
   - ①その回の本セットの数＝ext の数（各セットに ord が付いている）②各セットの ord と種目名が入力どおり ③ドロップが入力した本セットの下に、入力どおりの段で付いている ④補助・無理やりが入力したセットにだけ付いている ⑤**先に保存してあった別の回（古い回・別の顧客の回）のセットに ext・ドロップが付いていない** ⑥会員の見え方（k_memberPreview）で無理やりのセットが出ていない。
   - 作業依頼で読む場合は件数だけ（氏名と中身を出さない＝I28 の精神）：その日に作った回の「sets 数・ext 数・ext の session 不一致の数・drops 数・drops の親の session 不一致の数」。
4. **全部一致したら on**：`KARTE_TRAINING_EXT="on"` に替えて push（全トレーナーで karteSchema 33）。
5. **1つでも不一致なら off にして出し直す**：`KARTE_TRAINING_EXT="off"`（karteSchema 32＋サーバーで拒否＝画面が33を覚えていても新しい鍵は保存されない・旧形の保存は続く）。原因を直してから 1 からやり直す。**古い Worker への巻き戻しは止める手段に使わない**。不一致で作られた行の扱いは件数を見てから別に決める（その回を k_deleteTraining で消して入れ直すのが最小）。
6. 1〜4 が済むまで、トレーナー全員への案内（取り込みを使ってください）を出さない。切替を替えた push は decisions に記録する。

---

## 13. Codex 関門①（4周目）で見てほしいこと（改訂3で直した点を中心に）

0. **改訂3の3点**：①suggestKnown の候補が一押しで確定する経路が残っていないか（5-2・I71）②受付の切替（3-7）：判定が1か所か・karteSchema を返す6か所が全部切替を見るか・replay → 切替 → 回数の順で、off にした後の送り直しを誤って断らないか・新しい鍵の判定（extUsed）に抜けが無いか・allow の一覧の照合が完全一致か・画面が 409 を「はっきりした断り」として扱い下書きを残すか ③§6-3 の確定に合わせて I67 と検査に食い違いが無いか
1. **新しい表3つの持ち方（3-1）**：ドロップを別の表にし、本セットの付加を set_id で持つ形が、読む側（routes/karte.js `training`・lib/member-karte.js `readTraining`・liff/karte.js `exOrder`・`exerciseStats`・`copyInto`・`prevOfExercise`・`partsSince`・`exercisePicker`）で破綻しないか。古い回と新しい回が混ざるとき
2. **`INSERT … SELECT MAX(set_id) … WHERE session_id = ?` で親を指す作り**が、同じ batch の中で正しい行を指すか（同じ session_id を書くのはこの batch だけという前提が崩れる経路が無いか）。成り立たなかったときに ext（`INT NOT NULL PRIMARY KEY`）と drops が NOT NULL で失敗する向きになっているか（改訂2・§11-1）。trShape の条件2（改訂2）が「ext の無い本セット・親の無い ext・別の session を指す ext」を全部捕まえるか
3. **migration の冪等（I65・7-1 #6〜#9）**：worker-deploy.yml の二操作（L90-92）のどこで落ちても、次の実行で同じ結果になるか。巻き戻した古い Worker が新しい表の行で誤動作しないか
4. **trShape の7条件（3-3）**の SQL が karte_guard の CHECK 方式で書けるか・NULL 比較の抜けが無いか
5. **ハッシュの互換（3-4）**：「新しい鍵を使わず、同じ種目名が2つ以上に無い」に限った判定が I49 を弱めていないか
6. **知らない鍵の 400**・**新しい鍵を使う要求だけ 0.1 刻みを厳しくする**ことが、本番の画面・キャッシュの古い画面・pending の送り直しを断らないか
7. **自己ベストの4か所（I66）**とトレーナーの ord／種目名の使い分け（6-1）が一致しているか
8. **会員に無理やりのセットを出さない（I67・オーナー確定）**：無理やりの本セットの下のドロップ・全部が無理やりの種目・数字の無い種目の扱いに漏れが無いか
9. **パーサ（4-2・4-3）**：P1〜P63 の期待が文法から一意に決まるか。autoKnown と一致しない名前・最近の種目にだけある名前・括弧書き・健康の文が items やメモに入る経路が残っていないか（I71）
10. **schema の確認（I68）**：6つの経路がすべて `send()` の入口の判定を通るか（`sendMember`・`submitMemo` は新しい鍵を持たないので対象外でよいか）
11. **個人情報（8）**：原文・決定待ちが保存領域・送信・ログに漏れる経路（下書きの自動保存 `save()`・トークンの取り直しの退避）が無いか
12. **この変更が新たに持ち込む不具合**：新しい鍵の無い既存の記録・古い回で、「✓のセットだけ送る」「写す」「前回の値」「部位ごとの経過日数」の挙動が1文字も変わらないか
13. 推測ではなく、上に挙げたファイルの該当行を根拠に指摘してほしい
