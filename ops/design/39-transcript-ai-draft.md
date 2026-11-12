# 設計39 録音の文字起こしを AI でカルテの各項目へ振り分けた下書きにする（2026-11-12・改訂3）

> 状態：**関門① 通過（4周）・関門② 通過（4周・スレッド 01a1cee6-369a-7de1-8e4e-1e3d30ad43ed）**。改訂3（関門① 1周目 重大4・高5・中5・低3／2周目 重大1・高3・中4・低1／3周目 重大2・高1・中3・低1 → 全部受け入れ・スレッド 01a1cecd-ce16-7482-9821-8d5efa65f51b）。

## 改訂3（関門① 3周目）

| # | 指摘 | 変更 |
|---|---|---|
| 重大1・2 | pendItem の rule カードが `res.items[p.item]` を直接参照して壊れる・許可表が条件なしに addset を許す | 共通の `ruleTarget(p)`：item なら base、pendItem なら「自分より前の AI の name」で `dec[pendItem].act==='item'` のときだけ決めた名前。addSetDest・proposeDest・カード・assemble・許可の検査が全部これを使う。カード：name が未決定→根拠を出し「先に種目名を決めてください」＋社内メモ／捨てる、memo/discard→社内メモ／捨てる、item→addset のボタンも。**ruleTarget が解けない addset は許可外**（build が投げる・commit は下書きを変えない）。pendItem が自分より前の AI の name を指していなければ aiToRes が作らない（その種目のセットは aiunv へ） |
| 高3 | 0.1 刻みへの丸め比較で 55.04 が 55.0 の根拠になる | 丸めない：AI の weight は `w*10` が整数のものだけ（それ以外は unverified）・evidence のトークンも `v*10` が整数のものだけを重さの候補に・数値で完全一致（55＝55.0、55.04・55.15 は不一致） |
| 中4 | 「画面でも memoQuiet で拾う」は同じ式なので誤り | 「語の一覧に無い表現は Worker でも画面でも検出できず残り得る」に直した |
| 中5・6 | 検査の項目 | §9 に足した |
| 低7 | 表題が改訂1 | 直した |


## 改訂1（関門① 1周目）

| # | 指摘 | 変更 |
|---|---|---|
| 重大1 | AI の pending が既存の card（`p.lines.join`）・posOf（`p.lines[0]`）・assemble（知らない決定は黙って消える）・一般のカード（caution に社内メモが出る）を壊す | §4-2 に**全 pending の型の表**と、card・posOf・exTarget・proposeDest・proposeAct・assemble・makePlan・commit の AI の分岐を個別に書いた。caution は専用のカード（捨てるだけ）・assemble でも捨てる以外にしない。member/todo は入らなければ取り込み全体を止める |
| 重大2 | 「出力本文を応答に残さない」と `{draft}` を返すが矛盾 | 禁止対象を分けた：**Anthropic の生の応答・文字起こし・伏せた文は返さない。検証・再マスクした draft は、認証済みのトレーナーへの当該の HTTP 応答（no-store・既存の json() が付ける）と端末のメモリにだけ置く**（§3-7・I76） |
| 重大3 | index.js の共通の catch が `e.message` を console に出す | ハンドラの最外周で全例外を捕まえて固定コードに変える。加えて index.js は k_aiDraft のとき message を出さない（固定の文字）。fetch の失敗・壊れた JSON・D1 の失敗・マスクの例外を起こして console に原文・AI の文が無い検査（§9 F） |
| 重大4 | 数字が全文のどこかに別々にあれば通る（別の種目の数字・日付・目標値の流用） | 各セットに**根拠の抜き出し（evidence・80字まで）を必須**にし、Worker が「伏せた文字起こしにそのまま在る（空白の違いだけ許す）」「重さと回数の両方がその抜き出しの中に在る」を確かめる。重さ null（自重）は抜き出しに「自重」等の明示語があるときだけ。**計画の一覧とカードに根拠を出す**（§3-7・§4-2） |
| 高5 | isKarteWrite で59分を超えると kWrite が reauth（sessionStorage へ退避・読み直し）→ 原文が消える | AI は kWrite を使わない。押す前に tokenNeedsRefresh を見て、古ければ**送らず・読み直さず**画面に「LINE から開き直してから、もう一度貼ってください（貼った文字は先にコピー）」。401 が返っても読み直さない（§4-1） |
| 高6 | I63 の改め方が「例外の追加」では弱い | I63 を置き換え、送る条件・送り先・保持・no-store・退避しない・**同意と契約が揃うまで切替を allow/on にしない**を I76 に書いた（§5・§8） |
| 高7 | known（共有の種目）が伏せずに送られる・第三者名 | known にも同じ置換を掛け、名前らしい印（敬称・回目・初回・体験）を含む名前は送らない。案内文を「登録済みの氏名などを機械的に伏せます。聞き違い・第三者の名前は残ることがあります」に（§3-5・§4-1） |
| 高8 | 128KB の組が片方向 | 両方向にした：`/karte/ai-draft` は action が k_aiDraft でなければ 400、k_aiDraft は `/karte/ai-draft` 以外なら 400。Content-Length は信用せず arrayBuffer の実測で止める（今どおり）（§3-1） |
| 高9 | 体の状態を捨てるのが AI の分類頼み | Worker で**全カテゴリの文に健康語の検査**（画面の MEMO_HEALTH と同じ式・一致を検査で固定）を掛け、当たれば caution へ移す。画面も memoQuiet。保証は「検出した体の状態」に限ると明記（§3-7） |
| 中10 | 回数の UPSERT の成否 | `meta.changes === 1` だけを成功。0・不明・例外は API を呼ばない（503 AI_UNAVAILABLE）。上限を下げて n>max の行も止まる・連続の要求で上限を超えない検査（§3-4） |
| 中11 | access_log の result 対応 | 対応表を書いた（§3-8） |
| 中12 | karte_requests に入らないこと | 検査に「karte_requests に k_aiDraft が0行」（§9） |
| 中13 | todo の空き・順序 | assemble は todo を順序つき配列で返し、commit で既存の3枠と1回だけ結合。1件でも入らなければ取り込み全体を止める（§4-2） |
| 中14 | AI のセットの sq | aiToRes で全セットに重ならない sq を振る（memoSeqN と同じ数え方・parseMemo とは別に毎回1から）（§4-2） |
| 低17 | 時間切れの後の押し直し | 失敗の1行に「もう一度押すと1日の回数を1回使います」（§4-1） |

## 改訂2（関門① 2周目・同じスレッド）

| # | 指摘 | 変更 |
|---|---|---|
| 重大1 | 一覧に無い種目の name に parsed.sets を持たせると「種目にする」でセットが計画を通らずに入る（assemble の item 分岐） | **AI の name は sets を持たない**。セットはその後ろの AI の rule（`pendItem`＝name の添字）に置き、name が `item` に決まったときだけ addset の行き先が解ける＝根拠つきで計画に入る。name を社内メモ・捨てるにしたら rule は社内メモ／捨てるだけ。name を選び直したら rule の決定も外す（dropDependents）（§4-2） |
| 高2 | 「前後が数字でない」では `55.5` の中の `55`・`52.5` の中の `5` を誤認 | evidence から**数値のトークン**（`(?:^|[^0-9.])(\d+(?:\.\d+)?)(?![0-9.])`）を取り出し数値で完全一致。重さは 0.1 刻みに正規化して一致（55 と 55.0 は同じ）・回数は小数点の無いトークンだけ。重さと回数が同じ値なら、その値のトークンが2つ以上要る。NFKC の後（全角も同じ）（§3-7） |
| 高3 | 健康語を caution へ移した後の上限・元の項目の扱い | 順序を決めた：①型と件数 → ②健康語の検出 → ③元の場所から消す（member_message は ""・todo は要素を外す・note は外す）→ ④文面（note は「種目名：note」）→ ⑤同じ文の重複は1つ → ⑥移した後の caution が20件を超えたら全体を AI_BAD_OUTPUT（切らない）（§3-7） |
| 高4 | cat/kind ごとの許可の決定が不足・「無視せず例外にしない」が不明 | 許可表を書いた。表に無い組み合わせは build が投げ、commit は取り込み全体を止めて下書き（localStorage）を変えない（§4-2） |
| 中5 | 表示する根拠と照合したものがずれる | 返す evidence は **Worker が伏せた文字起こし（空白をそろえたもの）から切り出した部分**（AI の文字列そのものではない）（§3-7） |
| 中6 | name の text・根拠の表示 | name の text＝`聞こえた名前`。根拠は後ろの rule のカードと計画に出る（§4-2） |
| 中7 | §7 に access_log・応答・usage・requests・KV が無い | 足した（§7） |
| 中8 | karte_ai_log をどこから書くか | ハンドラに入った全ての k_aiDraft（切替 off・未許可も trainer_id つきで）。入口（index.js）で止まったもの（Origin・トークン・許可表）は今の access_log の扱いのまま（§3-8） |
| 低9 | exTarget の説明が既存と不一致 | 「AI の rule は exTarget を使わない（addSetDest が item／pendItem を使う）」に直した（§4-2） |

> オーナー指示（2026-11-12）「録音の文字起こしをカルテのそれぞれの項目にうまく分配する機能を作成して欲しい」。
> 前に読んだもの：ops/MODEL.md（§0・§2-3b・I46・I55・I57・I60・I62・I63・I64・I71・I72・I73・I75）・設計38/40/41・
> 決定0144（大原則：決めた項目だけ抜き出し雑談・思想信条は捨てる・全文はどこにも保存しない）・決定0153（送り先＝Anthropic API・検証1回目：種目名が崩れる→一覧を渡して寄せる必須／雑談に要配慮情報）・
> liff/karte.js（trImportSub の read/assemble/makePlan/card/commit・parseMemo の pending の形・MEMO_HEALTH・MEMO_PII_WEAK・kRead/kWrite/tokenNeedsRefresh）・
> worker/src/index.js（本文16KB の先行検査・isKarteWrite の Origin と iat の検査・許可表）・worker/src/routes/karte.js（trainingExtOn・karteSchemaFor・logAccess・runWrite）。

## 0. 目的（1行）

トレーナーが取り込み画面に貼った**セッション録音の文字起こし**（話し言葉・まとまりなし）を、Anthropic API で
カルテの項目（トレーニングの記録・指導のメモ・ヒアリング・注意すること・お客様へ・次回までに）へ振り分けた**下書き**にし、
**既存の取り込みの確認フロー（決定待ちのカード・提案・「提案どおりに決める」→「この内容で決める」）にそのまま流し込む。**
AI の出力を直接保存する経路は作らない（I71 を維持）。

## 1. 比べた手段

| 手段 | オーナー操作 | 戻せるか | 変える面積 | 判定 |
|---|---|---|---|---|
| A. ルールの読み取り（設計40/41）を話し言葉へさらに広げる | 0 | ○ | 画面だけ | ✗ 検証1回目で「話し言葉はほぼ読めない」（決定0153）。種目名の崩れ（スカルフラッシュ）は規則では寄せられない |
| B. CEO の Claude Code で下書きを作り、オーナーが貼る（検証の形） | 毎回 | ○ | 0 | ✗ 本番に載せない（決定0144-5・0153-3：オーナーの Mac と操作に依存・個人向け契約） |
| **C. Worker から Anthropic API を呼び、下書きを既存の取り込み画面の決定待ちへ変換する** | 鍵の登録1回・切替 | ○（切替 off・鍵の削除） | Worker 1窓口・画面の取り込みに入力を1つ | **採用** |
| D. LIFF から直接 API を呼ぶ | — | — | — | ✗ 鍵が端末に出る |

C の中の選択：
- **SDK ではなく生の HTTP（fetch）。** Worker は依存ゼロで、デプロイのワークフロー（触れない）は `wrangler@4` しか入れない。SDK を入れるにはワークフローの変更が要る。fetch なら検査で身代わりにできる。
- **構造化出力は `output_config.format`（type: json_schema）。** 強制の tool_choice（any/tool）は Sonnet 5.5 で 400（claude-api スキル）。
- **モデル**：既定 `claude-sonnet-5-5`。`KARTE_AI_MODEL` が厳密に `claude-haiku-5-5` のときだけ Haiku。それ以外の値は既定に倒す。
- **effort は `low`**（抽出・分類の仕事）。thinking は指定しない（両モデルとも省略＝adaptive）。temperature 等は送らない（2026-10-21 版で 400）。
- **refusal の fallback（server-side fallbacks）は付けない**：Haiku 5.5 には無く、Sonnet 5.5 の fallback 先（Sonnet 5）は別モデル。断られたら AI_REFUSED を返し、画面はルールの読み取りへ戻す（答えない側）。
- ヘッダ：`x-api-key`・`anthropic-version: 2026-10-21`・`content-type: application/json`（claude-api スキルの Required Headers）。

## 2. 流れ

```
取り込み画面（trImportSub）
  [貼る] → 「AIで振り分ける」（cur.aiDraft が真のときだけ出る）
     │ 送る前：空・3万字超は送らない／トークンが59分を超えていたら送らない（§5-4）
     ▼ POST {EDGE_URL}/karte/ai-draft  { action:'k_aiDraft', idToken, customerId, text, known:[autoKnown] }
Worker（index.js の共通の入口：Origin・ID トークン・iat・役割の鮮度・許可表 → routes/karte-ai.js）
  ① 切替（KARTE_AI_DRAFT）→ ② 鍵の有無 → ③ 入力の検査 → ④ 共有の範囲（canSeeKarteShared）
  ⑤ 1日の回数（先に数える）→ ⑥ 氏名を伏せる → ⑦ API（60秒で打ち切り・再試行なし）
  ⑧ 出力の検証（数字は文字起こしに実在・上限・型・氏名の再マスク）→ ⑨ 記録（中身なし）
  ▼ { draft, model, build }（保存しない・文字起こしを返さない）
画面：aiToRes(draft, autoKnown) → 既存の res（items＋pending）の形 → 既存のカード・計画・commit
  → 記録の画面（✓は全部外れたまま＝I57）→ トレーナーが ✓ → 既存の保存（k_addTraining 等）
```

## 3. Worker

### 3-1 入口（index.js）
- `k_aiDraft` を許可表に trainer（オーナーは継承）で載せる。
- **本文の上限**：通常は16KB（I46）。**パスが `/karte/ai-draft` のときだけ 128KB**（Content-Length の宣言と arrayBuffer の実測の両方）。パース後、**`/karte/ai-draft` で action が `k_aiDraft` 以外、または `k_aiDraft` が `/karte/ai-draft` 以外なら 400 `BAD_PATH`**（両方向・改訂1 高8）。
- index.js の共通の catch は、action が `k_aiDraft` のとき `e.message` を出さない（固定の文字だけ・改訂1 重大3）。
- **`isKarteWrite` に `k_aiDraft` を足す**＝Origin の完全一致と iat 1時間の検査が掛かる（外部へ送る・費用がかかる操作を、盗まれた古いトークン・他サイトから叩かせない）。
  ★ isKarteWrite に足しても runWrite（karte_requests・karte_rate）は通らない（このハンドラは runWrite を使わない）。
- 停止スイッチ KARTE='off' はそのまま効く（k_ の共通の検査）。

### 3-2 切替（I76）
```
KARTE_AI_DRAFT          "off"（既定）／"allow"／"on"。厳密一致。それ以外は off
KARTE_AI_DRAFT_TRAINERS allow のときの trainer_id（カンマ区切り・氏名を書かない）
KARTE_AI_MODEL          "claude-sonnet-5-5"（既定）／"claude-haiku-5-5"。それ以外は既定
KARTE_AI_DAILY_MAX      1日（JST）の呼び出しの上限・店全体。1〜500の整数。それ以外は 30
ANTHROPIC_API_KEY       Worker の Secret（オーナーが登録・コードは名前でだけ読む）
```
- `aiDraftOn(env, who)` は trainingExtOn と同じ形（1か所）。
- **k_training の応答に `aiDraft: aiDraftOn(env,who) && !!env.ANTHROPIC_API_KEY`** を足す（真偽値だけ・鍵の値は出さない）。画面はこれが真のときだけボタンを出す。
- 偽のとき k_aiDraft は **503 `AI_NOT_CONFIGURED`**（detail は `OFF` か `NO_KEY` だけ・誰が許可されているかは返さない）。何も外へ送らない・回数を数えない。

### 3-3 入力の検査（③）
- 知らない鍵は 400。`text`：文字列・前後の空白を落として1〜30,000字（超えたら 413 `AI_TOO_LONG`）。
- `known`：配列・600件まで・各要素は種目名の正規化（前後の空白を落とした1〜50字・I60 と同じ）。合わないものは 400（黙って捨てない）。
- `customerId`：必須。`canSeeKarteShared`（共有の範囲＝トレーナー全員・I47）で無ければ 404。

### 3-4 1日の回数（⑤・費用と暴走の守り）
- 新しい表 `karte_ai_usage(day TEXT PRIMARY KEY, n INTEGER NOT NULL)`（migration 0030・CREATE IF NOT EXISTS だけ）。
- `INSERT … VALUES(?,1) ON CONFLICT(day) DO UPDATE SET n = n + 1 WHERE n < ?` を1文で。**`meta.changes === 1` だけが成功**。0なら 429 `AI_DAILY_LIMIT`、結果が不明・例外なら 503 `AI_UNAVAILABLE`（どちらも API は呼ばない）。上限を下げて既に n > max の日も0件で止まる。
- **API を呼ぶ前に数える・失敗しても戻さない**（呼んだ回数＝費用の上限）。日付は JST。
- 月の上限額は Anthropic の管理画面でオーナーが掛ける（二重の守り）。

### 3-5 氏名を伏せる（⑥）
送る前に、文字起こしの中の次を置き換える（NFKC の後）：
1. そのカルテの会員の `customers.name`・`kana`：全体・空白を除いた全体・空白で分けた2字以上の各部分 → `〔会員〕`（カタカナ⇄ひらがなの両方）
2. トレーナー全員の `trainers.name`：同じ規則 → `〔トレーナー〕`
3. 1字の部分は「＋敬称」のときだけ（`林さん` → `〔会員〕`）
4. 一般の「漢字・カタカナ1〜6字＋敬称（さん・様・くん・ちゃん・氏）」→ `〔人〕`（店の外の人の名前・家族）
5. 電話番号らしい数字（10〜11桁・ハイフン可）→ `〔番号〕`、メールアドレス → `〔メール〕`
- 長い名前から順に置き換える。★伏せた後の文字起こしが**以後の全ての検証の基準**（⑧）。
- **known（共有の種目の名前）にも同じ置換を掛け、名前らしい印（様・さん・氏・くん・君・ちゃん・回目・初回・体験）を含む名前・置換で変わった名前は送らない**（改訂1 高7）。
- 文字起こしの全体は（伏せた後も）雑談・思想信条を含んだまま送られる。**出力しない指示は送る時の守りにならない**＝お客様の同意（AI・国外の事業者・全文を残さない）が本番の前提（§8）。
- **残る危険**：ひらがなだけの名前・聞き違えた名前（ASR の崩れ）・敬称なしの第三者名は伏せられない → 指示で「人の名前を出力しない」と書き、出力も同じ置換を通し、画面では MEMO_PII_WEAK の規則で提案を付けない。お客様の同意書（AI・国外の事業者）が前提（決定0144・オーナーの未決）。

### 3-6 API（⑦）
- `POST https://api.anthropic.com/v1/messages`、`max_tokens: 8000`、`output_config: { effort: 'low', format: { type: 'json_schema', schema } }`、system＝指示、user＝`<exercises>`（known を改行区切り）と `<transcript>`（伏せた文字起こし）。
- 60秒で AbortController で打ち切り → 504 `AI_TIMEOUT`。**再試行しない**（費用と待ち時間。トレーナーはもう一度押せる＝回数に入る）。
- 応答：HTTP が200以外 → 502 `AI_HTTP`（detail は状態番号だけ）。`stop_reason` が `refusal` → 502 `AI_REFUSED`、`max_tokens` → 502 `AI_TRUNCATED`（部分の出力は使わない）。text ブロックを JSON.parse できない → 502 `AI_BAD_OUTPUT`。
- ★エラー文・応答の本文・例外の message を console・ログ・応答に出さない（固定のコードだけ）。

**出力の形（JSON Schema・additionalProperties:false・全部 required）**
```
exercises[]: { name, heard, note, sets[]: { weight_kg: number|null(自重), reps: integer, evidence, note } }
             evidence＝そのセットの重さと回数を話した部分を文字起こしからそのまま抜き出した文（80字まで）
coaching[]   指導の要点（フォーム・意識・次回の課題）
hearing[]    生活・食事・睡眠・仕事・目標・運動歴（体の不調・診断・服薬は入れない）
caution[]    痛み・怪我・診断・服薬・体調など体の状態（注意することへ人が入れる）
member_message  お客様へ（お客様に見せてよい励まし・今日の要点）。無ければ ""
member_todo[]   次回までに（お客様にしてほしいこと）
```
**指示（要点）**：種目名は `<exercises>` の名前に寄せる（無い・自信が無いときは聞こえたまま）・**数字は文字起こしに出てきたものだけ**（推測で補わない・話した予告と実施の区別がつかなければ note に書く）・雑談・政治・宗教・思想信条・性的指向・家族の事情・第三者の話・項目に入らないものは**出力しない**・人の名前を出さない（〔会員〕等の置換語もそのまま出さない）・体の状態は caution にだけ書く。

### 3-7 出力の検証（⑧・Worker が決める）
- 型・件数：exercises 20・1種目のセット10・合計60・各文200字（member_message 400）・coaching/hearing/caution 各20件・member_todo 3件。超えた分は落とさず **400 の代わりに `overflow` の件数で返す**のではなく、**全体を `AI_BAD_OUTPUT`**（黙って切らない）。
- **数字（改訂1 重大4）**：`weight_kg` は 0.1刻み・0＜w≤500 または null、`reps` は1〜100の整数。次を全部満たすセットだけ sets に残す：
  1. `evidence` が1〜80字で、**伏せた文字起こしの中にそのまま在る**（両方の空白を1つの空白にそろえ、NFKC の後で部分一致。それ以外の違いは許さない）
  2. **重さと回数が両方とも evidence の数値のトークンに在る**（改訂2 高2）：トークン＝`(?:^|[^0-9.])(\d+(?:\.\d+)?)(?![0-9.])`（NFKC の後）。**丸めない**（改訂3）：AI の重さは `w*10` が整数のものだけ・evidence のトークンも `v*10` が整数のものだけを重さの候補にし、数値で完全一致（55＝55.0・`55.5`／`55.04` は 55 の根拠にならない）。回数は小数点の無いトークンだけ。重さと回数が同じ値なら、その値のトークンが2つ以上
  3. 重さ null（自重）は evidence に `自重`・`じじゅう`・`重りなし`・`ウェイトなし` のどれかがあるときだけ
  満たさないセットは sets から外して `unverified[]`（種目名・重さ・回数・根拠の表示用）へ移す＝画面で決定待ち（自動で入らない）。
  ★返す evidence は **Worker が空白をそろえた伏せた文字起こしから切り出した部分**（照合したもの＝表示するもの・改訂2 中5）。
  ★それでも「同じ発話の中で別の種目の数字」「予告と実施」は区別できない＝**計画の一覧とカードに根拠（evidence）を出し、トレーナーが見て決める**（設計41 の「いきます」と同じ判断）。
- 種目名：1〜50字に正規化できないものは unverified へ。**一覧にあるかの判定は画面**（autoKnown との完全一致・I71。Worker は known を AI に渡すだけ）。
- **健康語（改訂1 高9・改訂2 高3）**：画面の MEMO_HEALTH と同じ式（検査で一致を固定）を使い、次の順で処理する：
  ① 型と件数（元の各カテゴリ）→ ② coaching・hearing・member_message・member_todo・種目の note・セットの note を検出 →
  ③ 元の場所から消す（member_message は ""・todo は要素を外す・note は ""）→ ④ caution へ入れる文面（note は「種目名：note」・他はそのまま）→
  ⑤ 同じ文は1つ → ⑥ **移した後の caution が20件を超えたら全体を AI_BAD_OUTPUT**（切らない）。
  保証は「検出した体の状態」に限る。**語の一覧に無い表現は Worker でも画面でも検出できず残り得る**（画面の memoQuiet は同じ式＋名前の印。カードに原文が出てトレーナーが選ぶ＝設計40 で受け入れた残る危険と同じ）。
- 全ての文に §3-5 の置換をもう一度掛ける。
- **返すもの（改訂1 重大2）**：検証・再マスクした draft だけ。Anthropic の生の応答・文字起こし・伏せた文字起こしは返さない。draft は認証済みのトレーナーへの当該 HTTP 応答（既存の json() が `Cache-Control: no-store` を付ける）と端末のメモリにだけ置く。
- ハンドラは**最外周で全ての例外を捕まえ**、固定コード（AI_ERROR 500）に変える（共通の catch へ出さない・改訂1 重大3）。

### 3-8 記録（⑨・失敗も数える）
- 新しい表 `karte_ai_log(id, at, trainer_id, model, chars_in, ms, result, in_tokens, out_tokens, n_ex, n_unverified, build)`。result は CHECK（ok・off・no_key・too_long・bad_request・not_found・daily_limit・unavailable・timeout・http_error・refused・truncated・bad_output・error）。**中身・customer_id は書かない**。best effort（書けなくても応答は変えない・console には固定の文だけ）。
- 書くのは**ハンドラに入った全ての k_aiDraft**（切替 off・未許可も trainer_id つき）。入口（index.js）で止まったもの（Origin・トークン・許可表・本文の大きさ）は今の扱いのまま（改訂2 中8）。
- 監査は既存の `karte_access_log`（section 'ai_draft'・customer_id あり）。結果の対応（改訂1 中11）：ok→`ok`／off・no_key・daily_limit・too_long・bad_request→`denied`／not_found→`not_found`／timeout・http_error・refused・truncated・bad_output・error・unavailable→`error`。
- karte_requests・karte_rate は通らない（runWrite を使わない＝draft が result_json に残らない）。検査で k_aiDraft の行が0。
- **止まったら誰が気づくか**：トレーナーが押した瞬間に画面に出る（黙らない）。倒れた回数と母数は karte_ai_log の result で数えられる（日次点検への組み込みは次の段・ROADMAP に置く）。

## 4. 画面（liff/karte.js）

### 4-1 ボタン
- 取り込み画面の下の帯に、`cur.aiDraft` が真のときだけ **「AIで振り分ける（録音の文字起こし）」**（44px・「読み取る」の下）。案内1行：「外部（Anthropic）へ送ります。登録済みの氏名などは機械的に伏せますが、聞き違い・第三者の名前は残ることがあります。保存はしません。」
- **送る前（改訂1 高5）**：空なら送らない・3万字を超えたら送らない・`tokenNeedsRefresh()` が真なら**送らず読み直さず**「ログインの更新が必要です。貼った文字をコピーしてから LINE で開き直し、もう一度貼ってください」。kWrite（reauth で sessionStorage に退避して読み直す）は使わない。401 が返っても読み直さない（同じ文）。
- 送信中はボタンを押せなくし「振り分けています（1分ほど）」。応答が返る前に文字を変えた・別の画面へ移った・別の顧客を開いたら、応答を捨てる（世代の番号で照合）。
- 失敗（AI_NOT_CONFIGURED・AI_DAILY_LIMIT・AI_TIMEOUT・AI_REFUSED・AI_BAD_OUTPUT・AI_UNAVAILABLE・通信）は**画面の中の1行で知らせ**（ダイアログなし）、貼った文字はそのまま・「読み取る」（ルール）はそのまま使える。時間切れ・通信の失敗には「もう一度押すと1日の回数を1回使います」を添える。

### 4-2 下書き → 既存の res（純粋関数 aiToRes）
| AI の出力 | res | 提案（計画に入るか） |
|---|---|---|
| 種目名が autoKnown と完全一致・確かめられたセット | items に `{exercise, sets:[], doneOnly:true}`＋pending `kind:'rule'`（propose 'addset'・セットの note は健康語/名前の印が無いときだけセットのメモに） | ✓（設計41 と同じ：数字は計画の一覧を通してから入る） |
| 種目名が一致しない | pending `kind:'name'`（**sets を持たない**・入力欄に聞こえた名前）＋その後ろに AI の `rule`（`pendItem`＝name の添字・確かめられたセット） | name は✗（1件ずつ「種目にする」＝部位を選ぶ・I71）。rule は name が item に決まった後だけ✓（根拠つき・改訂2 重大1） |
| 数字が確かめられないセット（unverified） | pending `kind:'aiunv'` | ✗（社内メモ／捨てる） |
| 種目の note・指導の要点 | pending `kind:'ai'` cat coaching | 健康語・名前の印が無ければ propose 'memo'（社内メモ） |
| ヒアリング | `kind:'ai'` cat hearing（文頭に「ヒアリング：」） | 同上 |
| 体の状態 | `kind:'ai'` cat caution | ✗。**捨てるだけ**＋「『注意すること』の画面で入れてください（同意が要ります）」（I55・I48：自由文にも社内メモにも入れない） |
| お客様へ | `kind:'ai'` cat member | ✗（**お客様に見える**ので1件ずつ）。健康語・名前の印が無く400字以内のときだけ「お客様へに入れる」 |
| 次回までに | `kind:'ai'` cat todo | ✗。同上（60字以内・空きの欄があるとき） |

- 日付は持たない（res.date＝null＝今の下書きの日付）。res に `ai: true`。

**pending の型（改訂1 重大1・全部の鍵）**
| kind | 鍵 | 備考 |
|---|---|---|
| `rule`（AI） | `kind, ai:true, lines:[], label:'AIの下書き', text, pos, item（一覧にある種目）か pendItem（AI の name の添字）, parsed:{exercise, sets}, propose:'addset'` | text＝`種目名：「根拠1」／「根拠2」…`（計画の一覧の原文の欄にそのまま出る＝根拠を見て決める）。sets は全部 sq 付き・✓なし。セットの note は健康語・名前の印が無いときだけ付く（addSetDest の ruleNote で見える）。pendItem の rule は**その name の後ろ**に置く |
| `name`（AI） | `kind, ai:true, lines:[], label, text＝聞こえた名前, pos, after:null, prevPend:null, candidates:[], parsed:{exercise:聞こえた名前, sets:[]}` | **sets は空**（改訂2 重大1）。既存の名前のカード（種目にする＝部位を選ぶ）。exTarget は after/prevPend が null なので null |
| `aiunv` | `kind, ai:true, lines:[], label, text, pos` | 数字を確かめられないセット。専用のカード：社内メモ／捨てる |
| `ai` | `kind, ai:true, lines:[], label, text, pos, cat:'coaching'｜'hearing'｜'caution'｜'member'｜'todo', propose` | 専用のカード（下） |

**分岐（各関数）**
- `card`：`p.lines.length ? 行番号 : p.label`。`aiunv`・`ai` は**専用の分岐**（一般の分岐に落とさない）。
  - caution：**「捨てる」だけ**＋「体の状態は『注意すること』の画面で入れてください（同意が要ります）」。
  - member：常に「お客様にそのまま見えます」を表示。健康語・名前の印が無く400字以内なら「お客様へに入れる」。＋社内メモ／捨てる。
  - todo：同上（60字以内）「次回までにに入れる」。＋社内メモ／捨てる。
  - coaching・hearing：社内メモ／捨てる（提案があれば「提案：社内メモ」）。
- `posOf(p)`：`p.pos != null` なら p.pos（AI は種目の並びの位置を aiToRes で決める）。
- `exTarget`：今のコードのまま（item から base を返すのは line・tail だけ。AI の rule は exTarget を使わず、addSetDest が item／pendItem を使う。ai・aiunv・AI の name は null）（改訂2 低9）。
- **`ruleTarget(p)`（改訂3）**：item があれば `{base:item, name}`。pendItem なら、pendItem が自分より前の `ai:true` の name で、`dec[pendItem].act==='item'` のときだけ `{pend:pendItem, name:決めた名前}`。それ以外は null。addSetDest・proposeDest・rule のカード・assemble・許可の検査がこれだけを使う。
- rule（AI）のカード：根拠（text）を出す。ruleTarget が null で name が未決定なら「先に『聞こえた名前』の種目名を決めてください」＋社内メモ／捨てる。name が memo/discard なら社内メモ／捨てる。解けるときだけ「『名前』に … を足す」も出す。
- `proposeDest`：`propose === 'memo'` →「社内メモ（お客様には見えません）」。AI の rule の addset は ruleTarget が解けるときだけ、それ以外は null（計画に入らない）。`proposeAct`：memo → `{act:'memo'}`。
- aiToRes は pendItem を自分より前の AI の name にしか向けない（作れなければそのセットは aiunv）。
- `makePlan`：今のまま（propose のあるもの・行き先が解けるものだけ）。**member・todo・caution・aiunv・AI の name には propose を付けない**＝計画に入らない。
- `assemble`：新しい決定 `member`（messages に push）・`todo`（todos に push・順序つき）。addset の宛先は item なら base、pendItem なら namedBy[pendItem]（無ければ blocked＝入れない）。
- `dropDependents(j)`：AI の name を選び直したら、pendItem===j の rule の決定も外す。
- **許可の表（改訂2 高4）**：表に無い組み合わせは build が投げ、commit は取り込み全体を止めて下書きを変えない。

| kind/cat | 許す決定 |
|---|---|
| ai/caution | discard だけ |
| ai/member | member・memo・discard |
| ai/todo | todo・memo・discard |
| ai/coaching・hearing | memo・discard |
| aiunv | memo・discard |
| rule（AI） | addset（**ruleTarget が解けるときだけ**）・memo・discard |
| name（AI） | item・memo・discard |
| ai: true でない pending | 今どおり（検査しない） |
- `commit`：`T.member` を既存の形で用意し、message は既にあれば改行でつなぐ・**400字を超えるなら取り込み全体を止める**。todos は既存の3枠の空きに順に入れ、**1件でも入らなければ取り込み全体を止める**（途中まで入れない・改訂1 中13）。**お客様に出るのは、トレーナーが記録の画面で「保存する」を押したときだけ**（今どおり）。
- sq：aiToRes が全セットに 1 から重ならない番号を振る（改訂1 中14）。
- 「読み取る」（parseMemo）の res には `ai` が無い＝既存の分岐だけを通る（変えない）。

### 4-3 変えないこと
- 「読み取る」（parseMemo）の振る舞い・I57（✓の初期値 false）・計画の作り方（開いただけで dec を変えない・原文の全文表示）・保存の経路・I72（受付の切替）。

## 5. 不変条件（MODEL.md）

- **I63 を置き換える（改訂1 高6）**：メモの原文と決定待ちは端末のメモリの中だけ。localStorage・sessionStorage・console に入れない。**送るのは I76 の条件を全部満たした「AIで振り分ける」の1回だけ**（「読み取る」は何も送らない）。再認証・時間切れ・画面の移動でも原文を保存領域へ退避しない。
- **I76 を足す**：AI の下書き（設計39）：
  1. 明示の操作（ボタン）でだけ送る。送り先は Worker と Anthropic だけ。Origin・ID トークン・iat・役割の鮮度・許可表・共有の範囲・切替（厳密一致・既定 off）・鍵・1日の回数（changes===1）が全部通ったときだけ外へ送る。
  2. 送る前に氏名・連絡先を伏せる（known も）。
  3. **文字起こし・伏せた文字起こし・Anthropic の生の応答を D1・KV・console・エラー文・応答に残さない。** 検証・再マスクした draft は当該の HTTP 応答（no-store）と端末のメモリにだけ置く。記録は回数・時間・文字数・トークン数・モデル・結果・版の印だけ。
  4. セットは根拠の抜き出しが伏せた文字起こしに在り、重さと回数がその中に在るものだけ。それ以外は決定待ち（自動で入らない）。
  5. **AI の出力は保存しない**＝既存の確認フローを通して、トレーナーが決めたものだけが下書きに入る（I71）。お客様へ・次回までに・体の状態は計画に入れない。検出した体の状態は捨てるだけ（自由文に入れない）。
  6. **お客様の同意（録音・AI・国外の事業者・全文を残さない）と Anthropic の契約条件（保持・学習）が揃うまで、切替を allow/on にしない**（オーナー判断・decisions に記録してから）。
- I71 に追記：AI の種目も autoKnown と完全一致だけが items、セットは計画の一覧を通す。お客様へ・次回までには計画に入れない。

## 6. 判定できないとき何が出るか（倒れる向き）

| 状況 | 出るもの |
|---|---|
| 切替 off・未許可・鍵なし | ボタンが出ない。古い画面が押しても 503 → 「AIの振り分けはいま使えません。『読み取る』で取り込めます」 |
| 上限・時間切れ・断られた・出力が壊れている | 画面に1行・貼った文字は残る・「読み取る」が使える |
| 数字が文字起こしに無い | そのセットは自動で入らず、カードで社内メモか捨てる |
| 種目名が一覧に無い | 1件ずつ「種目にする」（部位を選ぶ） |
| 体の状態・健康語を含む文・名前の印 | 提案なし。体の状態は捨てるだけ |
| 記録（karte_ai_log）が書けない | 応答は変えない（console に固定の文） |

## 7. 個人情報（どこに出て誰が読めるか）

| 場所 | 中身 | 読める人 |
|---|---|---|
| 端末のメモリ | 貼った全文・下書き | そのトレーナー（今どおり保存領域に入れない） |
| Worker のメモリ | 全文・伏せた文 | 処理の間だけ（保存・ログなし） |
| Anthropic | 伏せた文字起こし・種目一覧 | 事業者（API の保持・学習しない契約は規約で要確認＝オーナー） |
| D1 karte_ai_log | 回数・時間・文字数・結果・トークン数・trainer_id | 運用（中身なし） |
| D1 karte_ai_usage | 日（JST）と回数だけ | 運用 |
| D1 karte_access_log | trainer_id・customer_id・action・結果（既存の監査） | 運用・監査 |
| D1 karte_requests | k_aiDraft は0行（runWrite を通らない） | — |
| KV | 何も書かない | — |
| HTTP 応答 | 検証・再マスクした draft（no-store） | 押した認証済みのトレーナー |
| 決めた後の下書き・保存 | トレーナーが選んだ文だけ（今の経路と同じ行き先） | 今どおり |

## 8. 切り替え・戻し方

- push 時は `KARTE_AI_DRAFT = "off"`＝何も変わらない（ボタンも出ない・migration 0030 で空の表が2つできるだけ）。
- **使い始めの阻害条件（I76-6）**：お客様の同意書と Anthropic の契約条件（保持・学習）の確認が済み、decisions に記録されるまで allow/on にしない。検証はオーナー自身のセッション（オーナーが本人の了承を得たもの）から。
- 使い始め：オーナーが鍵を登録（ワークフロー ops/workflows/worker-secret-anthropic.yml）→ `KARTE_AI_DRAFT="allow"`・`KARTE_AI_DRAFT_TRAINERS="A"` を push。
- 止める：`"off"` を push（1分ほど）。鍵を消す（同じワークフローの delete）でも止まる（NO_KEY）。

## 9. 検査（書いてから実装・壊して落ちることを確かめる）

- `worker/test/karte-ai.test.js`（本物の SQLite＋全 migration・入口から・fetch は身代わり）：
  A 切替・鍵なしで外へ送らない・回数を数えない／allow の一致・不一致／k_training の aiDraft／
  B 本文128KB はパスと action の組だけ・16KB の通常のパス／Origin・古い iat／customer の範囲／known の検査／3万字超／
  C 1日の上限（上限ちょうどで429・API を呼ばない）／
  D 送った本文に会員名・トレーナー名・敬称つきの名前・電話番号が無い（伏せた語がある）・model・ヘッダ・output_config／
  E 数字の実在（155 の中の 55 は数えない・52.5）→ unverified／上限超え→AI_BAD_OUTPUT／refusal・max_tokens・HTTP 500・時間切れ・壊れた JSON／
  E2 根拠：抜き出しが文字起こしに無い・重さだけ抜き出しの外・自重の明示語なし → unverified／健康語の文は caution へ／known の名前らしい印を送らない／
  F ★D1 の全表・console・応答に文字起こしの特徴的な文字列・AI の出力の雑談が無い（fetch の例外・壊れた JSON・D1 の失敗・マスクの例外でも）／karte_ai_log に result が残る（失敗も）／karte_requests に k_aiDraft が0行／応答が no-store／
  E3 数値（改訂3）：55＝55.0 一致／55 と 55.5・55.04 不一致／回数 5 と 52.5 不一致／重さと回数が同じ値はトークン1つで不一致・2つで一致／全角数字は NFKC で一致／
  E4 健康語の移し方：caution 20件＋移す1件→AI_BAD_OUTPUT／重複を1つにして20件なら成功／member_message は ""・todo は該当だけ外し順序を保つ・種目とセットの note は「種目名：note」で移し元は空／
  G 画面と Worker の健康語の式が同じ。
- 画面の追加（改訂3）：許可外の決定を注入すると build が投げ、commit 後も localStorage が1文字も変わらず、画面に固定のエラー・console に本文なし／pendItem の rule：name 未決定・捨てる・種目にした、の3通りのカードとボタン／name を選び直すと rule の addset が外れる。
- `worker/test/liff-karte-ai.test.js`（jsdom・入口から）：ボタンの有無／押す→計画→この内容で決める→記録の画面→✓→保存の payload／お客様へは1件ずつ・member に入る／体の状態は捨てるだけ／健康語の文に提案なし／失敗で1行・文字が残る・読み取るが使える／保存領域・console に原文が無い／送ったのは k_aiDraft の1回で /karte/ai-draft へ／応答の前に文字を変えたら捨てる。
- 架空の文字起こしだけを使う（I73）。

## 10. 関門で見てほしいこと

1. 本文128KB の枠が他の窓口へ流用できないか。isKarteWrite に足すことの副作用。
2. 文字起こし・出力本文がどこかに残る経路（例外の message・console・access_log・応答）。
3. 数字の実在の検査で、黙って違う数字が入る経路（AI が並べ替えた・別の種目の数字を付けた＝実在はする）。→ 計画の一覧を通す（設計41 と同じ判断）で足りるか。
4. 画面：ボタン1つ追加で片手・44px・ダイアログ増なしを満たすか。お客様へを1件ずつにしたことの手間。
5. 氏名を伏せる規則の穴。

## 関門②（実装レビュー・スレッド 01a1cee6-369a-7de1-8e4e-1e3d30ad43ed）

### 1周目：高2・中2・低1
| # | 指摘 | 対処 |
|---|---|---|
| 高1 | 根拠の抜き出し（evidence）に健康語があると、rule・aiunv の本文に入り「社内メモに足す」で保存できる | Worker：evidence に健康語があるセットは確かめたセットにせず（根拠は空で unverified）、その文を caution へ移す（上限の判定は全部移した後）。画面（二重）：ai・aiunv・rule の本文に健康語があれば「捨てる」だけ（rule は足すと捨てる）・許可の表でも社内メモ・お客様の欄を許さない。検査 E6-1・L5-1 |
| 高2 | トレーナーの読み・ひらがな名・空白/括弧/国番号の電話が伏せられない | ひらがな2〜6字＋敬称を〔人〕（「ちゃんと」は除く・伏せすぎる向き）／電話は 0 か +81 で始まり空白・ハイフン・括弧をはさんで数字10〜12桁／trainers.name_en も伏せる。**トレーナーの読み（かな）は表に無い＝残る危険**（スタッフの名前・お客様の名前ではない）。漢数字の電話（ゼロ九〇…）も残る危険。検査 G4-1〜G4-3・D3b |
| 中3 | API の版・モデル・output_config が受理されるかは検査で証明していない | claude-api スキルの資料（Required Headers・構造化出力・モデル表）どおりに書いた。**実通信の確認は allow の前の条件**として残す（オーナーが鍵を登録した後、オーナー自身のセッションで1回）。受理されなければ全件 AI_HTTP＝画面は「読み取る」へ戻る（顧客に害は出ない） |
| 中4 | お客様へは一部に健康語があると全文を caution へ移す | **意図的な仕様**（漏らさない向きに倒す）。お客様へは1つの文字列で、文の区切りの判定を入れると漏れる経路が増える。トレーナーは記録の画面で自分で書ける |
| 低5 | n_ex が空の種目も数える | 名前か聞こえた言葉があるものだけ数える |

### 2周目：高2
| # | 指摘 | 対処 |
|---|---|---|
| 高1 | 電話の正規表現が改行・空白の先の数字まで飲み込み、13桁になって電話ごと伏せない（`09012345678\n55キロで5回`） | 3つの数字のまとまりに固定（市外局番か +81／中／末尾。間は空白（改行を含めない）・ハイフン・括弧だけ）＋数字10〜12桁。検査 G4-1b（電話＋改行＋55キロ・電話＋空白＋20回・電話2つ・トレーニングの数字は残る）。前の式に戻すと落ちることを確認 |
| 高2 | トレーナーのかな名を伏せられないのに、コメントで保証を弱めている | **取る元が無い**（trainers は GAS の写しで読みの列が無い・name_en は英字）。CTO 判断：残る危険として明示的に受け入れる案を CEO に上げる。I76 ②・MODEL・画面の案内（「トレーナーの名前のかな書きは残ることがあります」）・同意の文面に含める。根本対応の候補＝(a) トレーナー名簿に読みの列を足し GAS から押し出す（GAS の反映が要る）／(b) オーナーが読みを Worker の Secret に登録（公開リポジトリに書かない）。**allow の前に CEO が選ぶ** |

### 3周目：高1
| # | 指摘 | 対処 |
|---|---|---|
| 高1 | `+81 (0)90 …`・`090 - 1234 - 5678`（空白＋ハイフン＋空白）を取りこぼす | 区切りを3文字まで・+81 の後の (0)／（0）を読む・桁数は (0) を除いて数える。検査 G4-1c（4つの形＋後ろの改行と数字は残る）。区切りを2文字に戻すと落ちることを確認 |
