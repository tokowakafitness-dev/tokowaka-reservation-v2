# 設計31 カルテのヒアリング構造化と見せ方の改修（2026-11-04）

## なぜ
オーナー承認のモック（https://claude.ai/artifact/UcD4nByMrWMnPoYLF1bzyY・トレカル分析が元）を実装する。
「からだ」→「体組成」に改称、配色は TOKOWAKA の規約（tokowaka-lp/design-system.md §4：ネイビー #1b2a47・ゴールド #b8965a・クリーム・墨 #22201c／副 #5d574e・罫線 #e6ddcd）。注意の赤は予約画面の --warn #a8524a。

## 前提（MODEL.md §2-3b・I46〜I52 を読んだ上で）
- 閲覧の範囲（I46/設計28 4-2）は変えない：共有（メモ・トレーニング・目標・安全面・体組成）＝トレーナー全員／担当（契約・一覧）＝担当＋担当なし
- 健康情報（安全面）は同意があるときだけ（I47）。撤回で同じ batch に削除（karte_safety の行ごと＝新しい列も消える）
- 書き込みは runWrite（回数の先行 batch → 本体の全部か無か → karte_requests）。新しい窓口は作らない＝許可表・入口の守りはそのまま

## データ（migration 0026・列を足すだけ）
| 表 | 足す列 | 中身 | 健康情報か |
|---|---|---|---|
| karte_profile | hearing_json TEXT | 目的[]・引き締めたい部位[≤3・順序つき]・やる気1〜10・目標体重・目標体脂肪率・理想（文）・いまの運動・過去の経験・睡眠・食事 | いいえ（同意なしで書ける） |
| karte_safety | pain_json TEXT, diagnosis TEXT | 痛み[{region, level 1〜10, symptom ≤80字}]（最大12）・医師の診断 | **はい**（同意の見張り＋条件つき INSERT＋読みは JOIN、既存と同じ） |
| karte_notes | tag TEXT, reasons_json TEXT, next_check TEXT | タグ（training/meal/life/body）・変化の理由[]（選択肢の鍵・最大12）・次回確かめること | いいえ（理由に「服薬」「生理周期」を入れない＝健康情報を同意なしの場所に置かない） |

- 列挙はすべてサーバーの固定表（REGIONS・PURPOSES・SLIM_AREAS・TAGS・REASONS）で検査。知らない鍵は 400。JSON は検査後に**正規化して**保存（受け取った文字列をそのまま入れない）
- tag の CHECK は migration に置く（新しい値を足すときは CHECK を grep する＝feedback_new_enum_value_check_schema）
- 既存の列（goal_text・goal_deadline・pain_sites 等）は残す。期日は goal_deadline、理想は goal_text を使い回す（二重に持たない）

## 窓口の変更
- k_saveProfile：hearing を受ける（無ければ hearing_json は変えない＝古い画面からの保存で消さない）。改訂の控え（karte_revisions）に hearing_json も入れる
- k_saveSafety：painMap・diagnosis を受ける（同意の条件は既存の文に列を足すだけ）
- k_addNote / k_editNote：tag・reasons・nextCheck を受ける。空の判定に reasons も含める
- k_summary：profile に hearing（解析済み）、safetyBrief に pain・diagnosis・medication・restrictions（同意があるときだけ・既存の JOIN）
- k_notes：tag・reasons・next_check を返す
- k_board：印を3つ足す（真偽だけ）
  - hearingMissing：hearing_json が無い
  - consentPending：同意が agreed でない
  - caution：同意があり、痛みか運動制限が記録されている（**部位や強さは出さない**＝一覧には詳細を載せない。詳細はカルテの中だけ）

## 画面（liff/karte.js の作り直し）
- タブ：概要／体組成／トレーニング／指導の履歴／契約
- 概要：注意すること（身体図＋痛みの強さ・診断・服薬）を最上部 → 目標3列（現在・目標・残り日数）→ やる気の輪＋目的 → 引き締めたい部位の上位3 → 運動と生活 → 直近の指導 → 退会の記録（担当だけ）
- ヒアリング入力：選択肢（目的・部位）・やる気1〜10・目標・運動と生活。痛みの身体図は同意があるときだけ（無ければ鍵の表示）
- 体組成：体重と体脂肪率を大きく＋前回比、骨格筋量・ウエスト・除脂肪、目標までの輪（入会時＝最初の記録→目標）、推移（4指標・期間 1ヶ月/3ヶ月/全部）、本人／InBody の別、**見立ての一言（規則で決める・断定しない・「診断ではありません」）**、測定の記録・目標線
- 見立ての規則（純粋関数・LIFF）：直近2回の差で
  - 体重↓・体脂肪率↓・骨格筋量↓でない → 「良い方向」
  - 目的にダイエット系があり体重・体脂肪率がともに↑ → 「目的と逆の動き」→ 理由の整理へ誘導
  - 差が小さい（体重±0.3kg・体脂肪率±0.3%未満）→ 「ゆるやか」
  - 記録2件未満 → 出さない
- トレーニング：日別／種目別（自己ベスト・推定MAX・合計回数・推移）／部位別（種目→部位の固定表・知らない種目は「その他」）
- 指導の履歴：変化の理由のチェック（食事・運動・睡眠と生活）＋次回確かめること・方針 → タグ付きメモと1本の時系列。タグで絞り込み
- 一覧：印＋「ヒアリング未記入」「同意待ち」「注意あり」
- 表示はすべて textContent（SVG は数値と固定の文字だけ）。安全面は端末に退避しない（既存どおり）

## 害の列挙（関門③の先取り）
- 顧客の画面には出ない（k_ はトレーナーだけ・入口はトレーナー画面）
- 健康情報が同意なしの場所に入る経路：理由の選択肢から健康項目を外す／痛みは karte_safety だけ
- 古い画面（キャッシュ）から保存したとき新しい項目が消える → hearing・painMap が無い要求では列を変えない
- 一覧で健康情報が広く見える → 真偽の「注意あり」だけ

## 検査
- worker：karte.test.js に足す（列挙の検査・正規化・同意なしで painMap を書けない・撤回で pain_json も消える・古い画面の保存で消えない・board の印・notes の新列）
- liff：liff-karte.test.js（jsdom）に足す（タブ名「体組成」・見立ての規則・HTML として解釈しない・安全面を退避しない・一覧の印）
- 実装を1行壊して落ちることを確かめる

## 関門①（Codex）の結果を受けた確定事項
1. **古い画面の保存で消さない**：hearing・painMap・diagnosis に加え、profile の既存列（goalText・goalValue・goalUnit・goalDeadline・motive・history）と safety の既存列も、**要求にその鍵が無いときは変えない**（`Object.prototype.hasOwnProperty`）。null・空文字・空配列は「消す」。G.rev はそのまま（読んだ rev が古ければ409）
2. **自由文の健康情報**：メモ（body・next_plan・next_check）とヒアリングの自由文は健康情報を書く場所ではない、と画面に明示（「痛み・診断・服薬は『注意すること』へ」）。既存のメモと同じ扱い（設計28 の運用）。サーバーで意味は判定しない
3. **caution は健康由来の印**として扱う：同意の JOIN の中（SQL）で算出し、JS で同意と安全面を別々に読んで合成しない。一覧の範囲（担当＋担当なし）は変えないので、見える人は広がらない
4. **改訂の控え（karte_revisions）に hearing の自由文を入れない**：選択肢と数値（purposes・slimAreas・motivation・targetWeight・targetFat）だけ。メモの編集・削除の控えには tag・reasons を足す（next_check は既存の body・next_plan と同じ扱いで入れる）
5. **正規形**
   - hearing：オブジェクトだけ。知らない鍵は400。purposes＝固定表の鍵・重複は400・固定表の順に並べ直す／slimAreas＝固定表の鍵・重複は400・最大3・**順序を保つ**／motivation＝整数1〜10（数値型だけ）／targetWeight 20〜250・targetFat 3〜60（小数1桁）／自由文（exerciseNow・exercisePast・sleep・meals）＝前後の空白を除き NFC・各100字。正規化して**全部空なら NULL**
   - painMap：配列だけ・最大12・各要素は {region, level, symptom} 以外の鍵を400・region＝固定表・重複は400・level＝整数1〜10・symptom＝80字。固定表の順に並べ直す。空配列は NULL
   - reasons：配列・固定表の鍵・重複は400・最大12・固定表の順
6. **目標の正本**：目標体重・目標体脂肪率は hearing_json。期日＝goal_deadline、理想＝goal_text。goal_value・goal_unit は新しい画面では送らない（残す）
7. **本文16KB**：全項目を最大長・最大件数にした正規の要求の UTF-8 バイト数が16KB以下であることを検査で固定
8. **migration**：`ADD COLUMN ... CHECK (x IS NULL OR json_valid(x))`／tag は `CHECK (tag IS NULL OR tag IN (...))`。NOT NULL は付けない。D1 の migration の履歴でだけ適用
9. **hearingMissing**：hearing_json IS NULL（空は NULL で保存するので一致する）
