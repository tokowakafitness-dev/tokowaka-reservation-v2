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
| `monthly_quota` | (customer_id, month_key) | `quotaBuild`（UPSERT）／**`used` はトリガーだけ** | 残数・照合 | 引当の親 |
| `ticket_packs` | pack_id | 同 | 同 | 引当の親 |
| `reservation_allocations` | reservation_id | `quotaBuild`（**消してから入れる**） | 超過の件数 | ↑2つを外部キーで参照 |
| `customer_sync_version` | customer_id | ingest（source）／quotaBuild（built） | 鮮度の判定 | — |
| `remain_shadow_slot` / `remain_shadow` / `remain_shadow_sample` | 設計12 | shadow | 心拍 | — |

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

### `readRemainDiag`（D1から作る・`worker/src/lib/remain-from-d1.js`）
答えない理由：`no_customer` / `out_of_range` / `no_version_row` / `not_built` / `behind` /
`read_failed` / `version_changed` / `row_count_missing` / `row_count_mismatch` /
`coverage_missing` / `base_freq_missing`
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
| `routeBoot` | 会員が起動したとき1回 | ✅ |
| `compatMemberStatus` | 同（互換の経路） | ✅ |
| `compatCustomerHome` | トレーナーが顧客カードを開くたび | ✅ |
| `compatBookingOptions` / `routeBookingOptions` | ★**候補を選び直すたび** | ❌ 確定を遅くしない |
| `customerDetail` | 上から連鎖 | ❌ |

★`ctx`（`waitUntil`）は**すべての handler に一律で渡る**。
　「`ctx` があるから比べる」にしてはいけない。入口の意思は別に渡す。

★書き込みの直後35分は、画面がWorkerではなくGASへ直接聞く。
　＝**予約・取消の直後はWorkerに来ない**（shadow で見たい場面がいちばん観測しにくい）。

---

## 7. 天井（構造的な上限）

| | 上限 | いまの状況 | 当たったら |
|---|---|---|---|
| GASのトリガー | 20本 | コード上21ハンドラ分。既存に相乗りで回避 | 新しい定期処理を作れない |
| GASのバージョン | 200・削除不可 | 2026-10-02 に188まで使った | プロジェクト作り直し＝**LIFFのURLが変わる** |
| GASの実行時間 | 6分 | 押し出しは打ち切り方式 | 途中から再開する作りが必須 |
| D1の書き込み | 1日10万行 | 差分同期で抑えている | 書き込みが止まる |
| D1の読み取り | 1日500万行 | 余裕 | — |
★だから**反映はまとめて1回**。小分けに頼むと天井に当たる。

---

## 8. 変更の型（★これを始める前に読む）

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

```
1. ops/job.json を書き換えて push
     {"op":"quotaBuild","requestId":"job-<時刻>-<乱数>","args":{…}}
     ★requestId は 24〜64文字の [A-Za-z0-9_-]
     ★op は許可一覧にあるものだけ（.github/workflows/edge-job.yml の case 行）
2. GitHub Actions が Worker へ登録する（★登録するだけ。結果は読まない）
3. GAS の edgeJobPoll が**1分ごと**に拾って実行し、結果を Worker へ返す
4. 読む： curl -sS "<EDGE_URL>/jobs/<requestId>"
     ★合言葉は要らない（jobs.js：「IDを知っていることが鍵」）
     ★EDGE_URL は liff/index.html に平文＝顧客のブラウザが叩く公開情報
     ★15秒ごとに最大10分ポーリングする（foreground の sleep は禁止なので背景で）
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
