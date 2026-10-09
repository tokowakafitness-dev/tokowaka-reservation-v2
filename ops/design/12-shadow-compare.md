# 段階3-b 手順3：shadow（両方を読んで食い違いを数える）

> 2026-10-09・CEO玄／前提：`10-stage-3b-read-from-d1.md`・`11-sync-version.md`
> **第5版。** 関門①で4回差し戻された（指摘 8 → 6 → 2 → 2件・却下0・累計18件）。
> 差し戻しの内容は第11節に残す。**同じ設計を5回書き直している。**
> それでも実装より安い。書き直しは文章の修正で、実装のやり直しは本番の作り直しになる。

---

## 1. なぜ要るのか

手順2で「D1の行から残数を作る部品」を書いた。しかし**値が合うことは何も確かめていない。**
確かめたのは形（鍵の名前）と規則だけ。

```
照合（quotaBuild verify）   私が回すときだけ・月額の残数とチケットの残数だけ
shadow                      ★顧客が画面を開くたび・**写しの全部の鍵**を比べる
```

`carryover` / `thisMonth` / `overageCount` / `ticketExpire` / `ticketPacks` / `nextMonth` は
照合の外側にある。**そこがずれていても、いまは誰も気づかない。**

---

## 2. 一行で言うと

```
写しを読んだあと、D1からも読んで比べ、違っていたら記録する。
顧客に返すのは写しのまま。
```

---

## 3. どこに入れるか

### 写しの読み取りを「診断つき」に分ける（★第3版で変えた）
いまの `readHome` は、写しが使えないとき**どの段で諦めたかを捨てて null を返す**。
そのままだと「写しが null・D1は答えられる」場面で shadow が一度も起動しない
（早期 return するので比較までたどり着かない）。**手順4で顧客に出す前に、
いちばん確かめたい場面がこれ**（写しが壊れていてもD1なら答えられる）。

```
readHomeDiag(env, cid, targetMs) → { value, status, month, computedAt, ageMs }
    status  'ok' / 'no_customer' / 'no_row' / 'bad_json' / 'month_missing'
            / 'bad_shape' / 'no_computed_at'
readHome(...)  上を呼び、value（＋付帯情報）だけ返す＝**いまの振る舞いは変えない**
```

### 比べるのは、次が全部そろったときだけ
```
モードが 'shadow'（文字列が厳密に一致）
opts.shadow === true           ← 入口の意思
opts.ctx.waitUntil が使える    ← 応答のあとに走らせる手段
比較枠を確保できた             ← 第5節（原子的に取る）
```
★`ctx` は `index.js` ですべての handler に一律で渡っている。
　**`ctx` の有無を入口の印にしない。** `ctx` は手段、`opts.shadow` は意思。

### 比べる入口／比べない入口

| 入口 | entry | 比べる | なぜ |
|---|---|:-:|---|
| `routeBoot`（会員の起動） | `boot` | ✅ | 1回の起動で1回 |
| `compatMemberStatus`（会員の起動・互換） | `compat_member` | ✅ | 同じ |
| `compatCustomerHome`（トレーナーが顧客カードを開く） | `compat_home` | ✅ | 回数が読める |
| `compatBookingOptions` / `routeBookingOptions` | — | ❌ | **候補を選び直すたびに呼ばれる**（`liff/index.html` の確認画面）。確定の経路を遅くしない |
| `customerDetail` | — | ❌ | 上と同じ入口から連鎖する |

★`compat` は1つの入口ではない（`compatBoot`→`compatMemberStatus`、
　`compatCustomerCard`→`compatCustomerHome`）。だから `readHome` の中で handler 名を推測せず、
　**`readHomeSafe` に opts（entry 付き）を通す。**

---

## 4. ★時点をどう揃えるか（第2版の重大な誤り）

第2版は「写しが返した月の**中旬**をD1に渡す」とした。**これは壊れる。**

D1側の `targetMs` は、月額の月を選ぶだけでなく**チケットの有効性の判定にも使う**
（`valid_from <= atMs && atMs <= valid_to`）。
```
10月31日の写しを、10月15日を渡して比べると
  10月20日に買ったパック   → D1ではまだ無効
  10月20日に切れたパック   → D1ではまだ有効
＝月は同じでも残数が別物になる。食い違いが「こちらの作り方のせい」で出る。
```

### 第3版の決め方：月の選択と有効性の時点を分ける
```
readRemainDiag(env, cid, { monthKey, effectiveAtMs, nowMs })
   monthKey        月額の枠をどの月から読むか
   effectiveAtMs   チケットの有効性を見る実時刻
```
比較のときの渡し方：
```
targetMs が明示されている   → その実値をそのまま使う（月も有効性も）
targetMs が無い（当月）     → nowMs をそのまま使う
```
**中旬に置き換えない。**

### 比べてはいけない組み合わせを先に弾く
| 条件 | status | なぜ比べないか |
|---|---|---|
| 写しの月 ≠ 見ている時刻の月 | `copy_month_mismatch` | 月の境目。写しが前月のまま |
| 写しが古い（`ageMs` > 10分） | `copy_stale_for_compare` | 写しは計算時刻の状態。D1はいまの状態。**違って当然**であり、それは「写しが古い」という別の話 |
| D1の当月・翌月の外 | `out_of_range` | D1は2か月しか持たない（★preclaim。枠を取る前に分かる） |

★これらを「値の食い違い」に混ぜると、原因が追えなくなる。**別に数える。**
★そして**比較枠を取る前に弾く**（第5節）。枠を消費すると、同じ時間帯に
　あとから新鮮な写しが来ても比べられなくなる。

### 10分という線の意味（★広げない）
既存のコードが既に2つの線を持っている。それに合わせる。
```
10分以内        値の一致を判定する（HOME_TTL_WARN_MS）
10分〜40分      値は比べず、鮮度の分布として数える（copy_stale_for_compare）
40分より古い    顧客向けにも使えない写し（HOME_TTL_HARD_MS）
```
押し出しは15分ごとなので、10分以内に入るのは概算で2/3ほど。**それでよい。**
線を15分や20分へ広げると、**正しいD1の更新を「写しとの食い違い」と誤って数える。**
★`_completed` が足りなければ、線を動かすのではなく
　「押し出しの直後に比較が走る入口」を考える。ベースラインでは
　`0-5分 / 5-10分 / 10-15分 / 15-40分 / 40分超` の分布を出す。

---

## 5. ★比較枠の確保（原子的に取る）

第2版は「`_attempted` を読んで n<3 なら比べる」とした。**競合する。**
同時に来た3つが同じ n を読み、上限を超える（起動のやり直し・複数端末・
トレーナーが何人ぶんも開く、で実際に起きる）。

### 枠は専用の表で持つ（★第4版で変えた）
集計の数（`_attempted` など）と**排他の鍵を混ぜない**。混ぜると、
時間帯の枠と世代の枠を同じ行に押し込むことになり、どちらの意味か分からなくなる。

```
remain_shadow_slot
  day           'YYYY-MM-DD'（JST）
  customer_id
  entry         'boot' / 'compat_member' / 'compat_home'   ← ★入口だけ
  sample_key    'time:00-07' / 'time:08-15' / 'time:16-23'
                'ver:<source_version>:<built_version>'      ← 世代が変わったとき
  claimed_at
  PRIMARY KEY (day, customer_id, entry, sample_key)
```
★`entry`（どの入口から来たか）と `sample_key`（どの枠で取ったか）は**別の軸**。
　同じ列に入れると「`time:08-15` の比較が boot から来たのか compat から来たのか」が消える。

### 一意性と1日の上限を**1文で**守る
```sql
-- 時間帯の枠（total < 5 だけを見る。各時間帯は主キーで1件に限られる）
INSERT INTO remain_shadow_slot (day, customer_id, entry, sample_key, claimed_at)
SELECT ?, ?, ?, ?, ?
 WHERE (SELECT COUNT(*) FROM remain_shadow_slot
         WHERE day = ? AND customer_id = ? AND entry = ?) < 5
ON CONFLICT(day, customer_id, entry, sample_key) DO NOTHING
```
```sql
-- 世代の枠（★total < 5 かつ 世代の枠が 2 未満）
INSERT INTO remain_shadow_slot (day, customer_id, entry, sample_key, claimed_at)
SELECT ?, ?, ?, ?, ?
 WHERE (SELECT COUNT(*) FROM remain_shadow_slot
         WHERE day = ? AND customer_id = ? AND entry = ?) < 5
   AND (SELECT COUNT(*) FROM remain_shadow_slot
         WHERE day = ? AND customer_id = ? AND entry = ?
           AND sample_key LIKE 'ver:%') < 2
ON CONFLICT(day, customer_id, entry, sample_key) DO NOTHING
```
```
DO NOTHING   同じ sample_key はもう取られている（★主キーの衝突だけを無視する）
WHERE        上限に達している
書き換わった行数が 1 なら枠を取れた／0 なら比べずに終わる
```
★`OR IGNORE` にしない。NOT NULL や CHECK の違反まで黙って無視し、
　「上限か重複」と読み違える。**主キーの衝突だけを無視する。**
★2文に分けると（枠の行を入れる → 総数を数えて更新）、その間で競合して上限を超える。
　**副問い合わせで数えて1文にする。**

### ★世代の枠に上限2を入れないと、時間帯の枠が食い潰される
総数5だけを見ると、午前に世代が5回変われば
`ver:1:1 … ver:5:5` で5枠を使い切り、**午後と夜の時間帯が1回も観測されない。**

### 枠を選ぶ順序（固定する）
```
1. いまの時間帯の 'time:<帯>' を試す      ← 3つの時間帯の観測を優先する
2. 取れなければ 'ver:<source>:<built>'    ← 同じ時間帯の2回目以降を世代の観測に使う
3. どちらも 0 なら比べない
```
これで、早い時間に使えるのは「その時間帯1＋世代2＝3」まで。**残り2時間帯ぶんが残る。**

### 上限と単位（★第4版で確定）
```
単位   **会員 × 入口** で1日 5回
       （会員全体にすると、boot のアクセスが compat の観測枠を食い潰す）
内訳   時間帯の枠3つ（JST 00-07 / 08-15 / 16-23）＋ 世代が変わったときの枠2つぶん
```
②の「世代が変わったら1回」が、**契約・予約の変更の直後**を拾う。
　これが要るのは、このシステムが**書き込みの直後35分はWorkerに来ない**ため
　（画面がGASへ直接聞く）。朝の3回だけでは、いちばん見たい場面が入らない。

### 枠を取る前に弾くもの／取ったあとに分かるもの
```
枠を取る前   月の不一致・写しが古い・★D1が持っていない月（out_of_range）
             → '_pre:<理由>' として数える（上限3）
             ★枠を消費させない。消費すると、あとで新鮮な写しが来ても比べられない
             ★out_of_range も**ここ**。あとで判定すると、比べられないと
               分かっている要求が枠を使い、その日の機会を減らす
枠を取った後 D1側の事情（行が無い・base_freq が無い・coverage が無い）
             ★枠を取るために読んだ世代と、読んだ行の世代が違う場合も**ここ**
               （version_changed_during_shadow）。D1が答えられたかに関わらず、
               世代の照合を**先に**行う。「世代が動いた」と「追いついていない（behind）」
               を混ぜると原因が追えない
             → '_post:<理由>' として数える（★上限は**枠の上限と同じ5**。
               3にすると4回目以降が incomplete に数えられ、正常に終わった回を
               「結末を残せなかった」と誤って出す）
```

### 世代を先に読むこと
`sample_key` に世代を入れるには、枠を取る前に世代を1回読む。
これは第5節の「読んでから書く形にしない」（＝**上限の数え方**の話）とは別で、矛盾しない。
```
1. 世代を軽く読む（source_version : built_version）
2. その組で枠を確保する
3. readRemainDiag が、行を読む前後で世代を再確認する（既にそうなっている）
4. 1 で読んだ世代と 3 の結果が違えば、値を比べず 'version_changed_during_shadow'
5. ★枠は戻さない（戻すと並行した要求が取り直して上限管理が壊れる）
```

## 6. 記録のしかた（2層）

### 層1：日次の集計 `remain_shadow`
```
day            'YYYY-MM-DD'（JST）
customer_id
entry          'boot' / 'compat_member' / 'compat_home'   ← ★入口だけ（枠の鍵は入れない）
field          食い違った鍵の名前。または次の印
                 （★'_attempted' は**書かない**。下の★を参照）
                 '_completed'  比べ終わった回数
                 '_failed'     途中で落ちた回数
first_value / last_value   写しとD1の値の組（文字列・長いものは切る）
n / first_at / last_at
```
主キー **`(day, customer_id, entry, field)`**。
★第2版は `entry` が主キーに無く、「入口ごとに3回」が成立していなかった（内部矛盾）。

### 層2：値の組ごとの標本 `remain_shadow_sample`
```
主キー (day, customer_id, entry, field, fp)
   fp ＝ 正規化した「写しの値＋D1の値」の指紋
INSERT OR IGNORE で入れる ＝ 同じ組は D1 が原子的に弾く（前回値を読まない）
中身：requested_month / copy_month / d1_month / copy_computed_at
      source_version / built_version / d1_status / copy_value / d1_value / at
```
★第2版の「前回と同じなら書かない」は、前回値を読む→書く で競合する。
　指紋で弾けば読まなくてよい。**揺れの順序は失う**が、この規模では組の種類が分かれば足りる。

### ★1回の比較の記録は同じ batch にまとめる
`_completed` だけ増えて食い違いの行が書けなかった状態は、
**「一致した」ように見える**（いちばん危険な壊れ方）。1文ずつ書かない。

### ★`_attempted` は書かない。枠の表から数える（第5版）
枠を取ったあと、結果を書く前に処理が消えると（isolate の終了・D1の障害）、
```
remain_shadow_slot   1行増える
_attempted           増えない    ← 別の batch だから
_completed           増えない
_failed              増えない
```
となり、`incomplete = attempted − …` が **0 − 0 − 0 = 0**。
**いちばん検知したい「枠だけ取って消えた処理」が静かに消える。**

```
attempted         ＝ remain_shadow_slot の (day, customer_id, entry) ごとの COUNT(*)
last_attempted_at ＝ MAX(claimed_at)
incomplete        ＝ attempted − completed − failed − postclaim_skipped
```
枠のINSERTが成功した瞬間が attempted。**枠と結果の間で消えても必ず差が残る。**

### ★弾いた理由は2つに分ける
```
preclaim_skipped   枠を取る前に弾いた（枠を消費していない）
                     copy_month_mismatch / copy_stale_for_compare / copy_too_old
                     / out_of_range
postclaim_skipped  枠を取ったあとに分かった
                     version_changed_during_shadow / no_rows / base_freq_missing
                     / coverage_missing
                   ★out_of_range は preclaim に入れる（枠を取る前に判定できる）
```
`preclaim_skipped` は枠の数に入っていないので、**incomplete から引いてはいけない。**
鮮度の分布として別に見せる。

### 書き込み量（★第5版で数え直した）
```
1回の比較で最大   枠1 ＋ _completed 1 ＋ 集計24 ＋ 標本24 ＝ 50
1日の上限         40名 × 3入口 × 5回 ＝ 600比較 → 最悪 約30,000 行/日
ふだん            食い違いが5鍵なら 枠1＋completed1＋集計5＋標本5 ＝ 12
                  → 600 × 12 ＝ 約7,200 行/日
```
無料枠（1日10万行）の内側。**式はこれ**（ユニーク行数で数えてはいけない）。

★上限つきの数え方（`WHERE n < ?`）は、条件を満たさなければ**行を変えない**。
　＝書き込み行数を消費しない。だから `_pre:` を上限3で数えても、
　アクセスが増えても書き込みは増えない。

### ★D1が答えなかった理由を失わない
```
readRemainDiag(...)      → { value, status, reason, version }
readRemainFromD1(...)    → 上を呼んで value だけ返す（顧客向けの振る舞いは変えない）
   status: 'ok' / 'no_version_row' / 'not_built' / 'behind' / 'out_of_range'
           / 'read_failed' / 'no_rows' / 'base_freq_missing' / 'coverage_missing'
```

---

## 7. 比べ方

### 比べない鍵
```
computedAt / stale / ageMs / month   ← readHome が写しに**後から足している**付帯情報
_ で始まるもの（_src / _packOverUse）
```

### 値の比べ方
```
null と 0 は別物（丸めない）
オブジェクト・配列は JSON にして比べる（nextMonth / ticketPacks）
片方だけが答えた → '_one_sided' として別に数える（★第3節の診断分離が前提）
```

---

## 8. 切り替えと、動いていることの確認

`worker/wrangler.toml` の `[vars]`：
```
LB_D1_REMAIN_MODE = "off"      既定。比べない
                  = "shadow"   比べて記録する。顧客に出すのは写し
                  = "on"       ★手順4。この設計の範囲外
```
★文字列が**厳密に `"shadow"`** のときだけ動く。書き忘れ・打ち間違いは off 側に倒れる。

### ★入口ごとの心拍（「動いているつもり」を潰す）
第2版でも、次は**全部同じ「0件」**になる。
```
人が来なかった／モードが off／opts の渡し忘れ／waitUntil より前に return
／D1の読み取りが落ちた／表が無い／35分の迂回でWorkerに来ていない
```
作業依頼の結果に、**入口ごとに**次を出す。
```
mode / 版の印 / entry
last_attempted_at（＝枠の MAX(claimed_at)）/ last_completed_at / last_failed_at
attempted（★枠の表の COUNT）/ completed / failed
preclaim_skipped（理由ごと）/ postclaim_skipped（理由ごと）
★incomplete ＝ attempted − completed − failed − postclaim_skipped
```
★`incomplete` を必ず出す。これは**結末を記録できなかった回数**。
```
_failed       catch まで届いて、失敗を書けた
incomplete    isolate が終わった／D1が落ちた／結果の batch が書けなかった
              ＝ D1に何も残らない。**この差だけが痕跡**
```
`_attempted` だけ残ることを `_failed` と同じに扱ってはいけない。
★さらに **shadow を入れた直後に、各入口を実際に1回通すスモークテスト**を行う。
　preflight でSQLを直接呼ぶだけでは、**opts の配線ミスは絶対に見つからない。**

### 本番で shadow を入れる前の preflight
```
① migration 0014（世代の表）が本番D1に入っているか
② remain_shadow_slot / remain_shadow / remain_shadow_sample の**3つ**が入っているか
③ 世代が fresh の会員が1名以上いるか（0名なら全部 'not_built' になる）
```
作業依頼の `remaining` op に `shadow: 'preflight'` を足す（新しい op は作らない）。

---

## 9. 済んだと言える条件

```
1. preflight（第8節）                                  ← 表と世代の確認
2. shadow を入れる ＋ 各入口のスモークテスト            ★「ベースライン採取」
3. 食い違いの基準値を取る（どの鍵が・何名で・なぜ）
4. 古い行の掃除を独立した工程で実装・検証              ← 下の★
5. 全会員を作り直す
6. shadow をもう一度1週間
7. 食い違い0 かつ _completed が十分にある               ★ここが合格判定
8. 1人だけ 'on'（★オーナー承認）
```
★**掃除の前のshadowの結果を、合格の1週間に含めない。**
　いま枠とチケットの古い行が残っている（設計11の末尾）。その会員では必ず食い違う。

### ★掃除の検証に shadow を使うだけでは足りない
論理の循環ではない（比べる相手は独立）。しかし**共通の見落としは捕まらない**。
掃除が誤った行を残し、`readRemainDiag` もその行を無視すれば、shadow は一致してしまう。

だから掃除には**直接SQLの不変条件検査**を別に用意する。
```
いまの計算に無い monthly_quota が0件
いまの計算に無い ticket_packs が0件
monthly_quota.used が、対応する引当の units の合計と一致
ticket_packs.used が、対応する引当の units の合計と一致
引当のある親の行を消していない
掃除の前後で、消す対象の一覧と件数を残す
dry-run と本実行の結果が一致する
```
shadow はその**あと**の、外から見た整合の確認として使う。

---

## 10. 壊れうるところ（正直に）

| | 懸念 | 手当て |
|---|---|---|
| ① | 比べる処理が例外を投げて顧客の画面が止まる | すべて try で包み、何があっても写しを返す。`waitUntil` の中でも catch して `console.error` |
| ② | 書き込み枠を食う | 第5節の枠の確保＋第6節の式で見積もる |
| ③ | `waitUntil` のあと D1 が落ちていて記録できない | `_failed` も同じD1なので記録できない → **入口ごとの心拍**（第8節）とWorkerのログで見る |
| ④ | 写しと D1 で見ている時点が違う | 第4節（中旬に置き換えない・比べてはいけない組み合わせを先に弾く） |
| ⑤ | 古い行が残っている会員で食い違いが出る | ★それが目的（第9節のベースライン） |
| ⑥ | 記録に顧客の氏名が入る | 入れない。会員IDだけ（照合と同じ方針） |
| ⑦ | 枠の上限に当たって、見たい場面が観測されない | 時間帯＋世代変化で割る（第5節） |

---

## 11. 版ごとの差し戻し（関門①・却下0）

### 第1版 → 第2版（指摘8件）
```
① ctx は全handlerに渡るので入口の印にできない        → 明示 opts.shadow
② bookingOptions は候補を選び直すたびに呼ばれる      → 入口の表／readHomeSafe に opts
③ ★書き込み量をユニーク行数で数えていた              → 更新回数で数え直し、枠を入れた
④ computedAt/stale/ageMs/month が毎回食い違う        → 比べない鍵に加えた
⑤ 月の境目で写しとD1が違う月を見る                   → 写しの月を使う（→第3版で再修正）
⑥ 1日1行では原因が追えない                           → 標本の層を足した
⑦ null の理由が失われる                              → 診断版を設ける
⑧ _checked 1つでは失敗に気づけない                   → attempted/completed/failed に分けた
```

### 第2版 → 第3版（指摘6件）
```
① entry が主キーに無く「入口ごとに3回」が成立していない  → 主キーに entry を入れた
② 読む→比較→書く は競合し、3回を超える                  → 1文で原子的に確保（changes=0なら諦める）
③ ★★月中旬を渡すとチケットの有効性判定が変わる          → 月の選択と有効性の時点を分けた
     （10/31の写しに10/15を渡すと、10/20に買ったパックが無効になる＝残数が別物）
④ 書き込み最大値が標本・completed を含んでいない         → 1比較あたり最大50で数え直した
⑤ ★写しが null の経路では shadow が起動しない            → 写しの読み取りも診断に分離
     （手順4でいちばん確かめたい場面がこれ）
⑥ 標本の「前回と同じなら書かない」も競合する             → 指紋＋INSERT OR IGNORE
```
加えて：
- 朝の3回では偏る（**書き込み直後35分はWorkerに来ない**＝見たい場面が入らない）→ 時間帯＋世代変化
- 掃除の検証を shadow だけに頼ると共通の見落としを捕まえられない → 直接SQLの不変条件検査を別に
- preflight では opts の配線ミスが見つからない → 各入口のスモークテスト

### 第3版 → 第4版（指摘2件）
```
① entry に「入口」と「枠の種類」の2つの意味が混ざっていた
   → 枠を専用の表（remain_shadow_slot）に分け、entry と sample_key を別の軸にした
② 「1日8回」の単位が曖昧で、時間帯枠と世代枠をまたいで原子的に守る方法が無かった
   → 単位を「会員×入口で1日5回」に確定。副問い合わせで数える1文で、
     一意性と総数上限を同時に守る（2文に分けると競合して超える）
```
加えて明記した：
- 10分の線は**動かさない**（広げると、正しいD1の更新を食い違いと誤って数える）
- 写しが古い／月が違うものは**枠を取る前に**弾く
- 世代が読み取り中に動いたら `version_changed_during_shadow`。枠は戻さない
- 心拍に `incomplete`（結末を記録できなかった回数）を出す
- `sample_key` の世代は `source:built` の組（built が同じで source だけ進んだ `behind` を区別する）

### 実装のときに固定すること（テストで縛る）
```
比べる鍵は「両方の鍵の和」ではなく、GASの _lbBuildHome から取り出した**固定の一覧**
指紋は切り詰める前の正規化した値から作る（オブジェクトは鍵の順を揃える）
集計・標本・_completed は同じ DB.batch() に入れる
batch が落ちたら _failed を別に best-effort で書き、必ず console.error
readHomeDiag の全部の status で、いまの readHome の戻り値が**1文字も変わらない**
```

### 第4版 → 第5版（指摘2件）
```
① ★_attempted を別に書くと、枠だけ取って消えた処理が検知できない
   （枠と結果が別の batch なので、間で消えると incomplete が 0 − 0 − 0 = 0 になる）
   → _attempted を書かず、枠の表の COUNT から数える。
     弾いた理由も preclaim（枠を使っていない）と postclaim に分けた
② 総数5だけでは「時間帯3＋世代2」を保証できない
   （午前に世代が5回変われば午後と夜が1回も観測されない）
   → 世代の枠にSQLで上限2を入れ、選ぶ順序を「時間帯→世代」に固定した
```
あわせて：`OR IGNORE` を `ON CONFLICT(…) DO NOTHING` に（NOT NULL や CHECK の違反を
黙って無視しない）。preflight の対象を3表に。書き込み量を 50／12 に直した。

### 確かめ済み（Codex が手元のSQLiteで実行）
```
初回のINSERT              changes=1
同じ主キーをもう一度      changes=0（行数は増えない）
上限まで別の鍵            changes=1
上限に達したあと          changes=0
条件つきUPSERTで条件が偽  行を変えない＝書き込み行数を消費しない
```

**shadow を掃除より先に入れる判断は、5つの版すべてで支持された。**
（観測だけで安全・実データで規模が分かる・掃除後に同じ計測で消えたことを確認できる）

---

## 12. 実装のときに見つかった3つ＋2つ（関門②・2周・却下0）

### 1周目（3件）
```
① ★Blocker：readHome が scheduleShadow へ shadow の意思を転送していなかった
   ＝モードを 'shadow' にしても**一度も比べない**。それでも検査は全部通っていた
   （scheduleShadow を直接呼び、配線は正規表現で見ていたため）
   → shadow: opts.shadow を足し、**readHome を実際に通す結合テスト**を足した
② 枠の鍵のために読んだ世代と、実際に読んだ行の世代を比べていなかった
   （'ver:3:3' の枠で 'ver:4:4' の行を比べると、世代の枠の意味が壊れる）
③ _post: の上限3と incomplete の式が矛盾し、正常に終わった回を
   「結末を残せなかった」と誤って出す → 上限を枠の上限（5）に合わせた
```

### 2周目（自分の修正を戻した・2件）
```
④ 世代の照合を status === 'ok' に限定していた
   → 'ver:3:3' の枠で読んだら 'ver:4:3'（behind）だった場合も「世代が動いた」。
     D1が答えられたかに関わらず**先に**照合する
⑤ out_of_range が枠を取ったあとの判定だった
   → 枠を取る前に弾く（比べられないと分かっている要求が枠を使わない）
```

★①の根因は「**配線を正規表現でしか見ていなかった**」こと。
　入口は正しく `shadow: true` を渡していた。中継が落としていた。
　**関数を実際に通す検査でしか見つからない。**

### 検査
`worker/test/remain-shadow.test.js` 105本。全54ファイル・落ち0。
枠の確保は**本物のSQLiteで走らせている**（1文で総数5・世代2を守れるか）。
壊して落ちることを6通り確かめた。
```
shadow の転送を落とす        → ⑪-b が落ちる（①の形そのもの）
世代の照合を外す              → ⑪-d が落ちる
世代の照合を status に限定     → ⑪-f が落ちる
out_of_range を枠の後に戻す    → ⑪-g が落ちる
モードの厳密一致を緩める      → ⑩ が落ちる
付帯情報も比べる              → ① が落ちる
```

## 13. まだやっていないこと
```
各入口を実際に1回通すスモークテスト（第8節）  ← shadow を on にする前に作る
本番で shadow を1回も動かしていない（モードは off）
migration 0014 / 0015 が本番D1に入ったか未確認（gh が TLS で落ちて結果を読めない）
GAS側の変更は未反映（オーナーの承認が1回必要）
```

---

## 14. 関門③で止められた3件（2026-10-09・却下0）

本番で on にする直前に「何が起きたら顧客に害が出るか」を問い、**条件付き不合格**。

### ① ★最重要：比較が「応答後」ではなく**その場で**走り始めていた
```
ctx.waitUntil(runShadow(...)) は runShadow を**先に呼んで**Promiseを登録する
readHome は handler の Promise.all の中で待たれている
＝本体の残りのD1読み取りが**まだ終わっていない**
→ 比較のD1読み書きが本体と競合し、本体が上限やD1の障害を踏めば
  handler ごと 500 になる＝**顧客の画面が壊れる**
```
```
直し方   readHome は「あとで実行する関数」を opts.defer に積むだけにする
         handler が**結果を返す直前**に runDeferred(defer) で起動する
         動的 import も defer の中へ移した（応答経路から外す）
```
★「`waitUntil` に入れたから応答後」は**誤り**。登録するのは Promise で、
　その Promise を作る関数呼び出しはその場で走る。

### ② 書き込み量の計算が1行少なく、枠が多すぎた
```
設計書は 1比較あたり最大50行としていた → **51行**（_age: を数えていなかった）
さらに _pre: と _age: は**枠の外でも**書かれる（理由の種類ぶん・各3回まで）
D1の1日10万行は shadow 専用ではない（押し出し・写しの更新・引当と共用）
使い切ると**押し出しが止まり、写しが古くなって画面がGASへ落ちる（遅くなる）**
```
```
直し方   枠を「会員×入口で5回」→**3回**（時間帯＋世代で合わせて3・世代は1つまで）
         40名 × 3入口 × 3回 × 51 ＝ 最大 約18,400行/日（ふだん約4,700行）
         ベースラインの母数は 360比較/日あれば足りる
```

### ③ ★比較対象に `transferCredits` が無く、**実在する不具合**に行き当たった
```
transferCredits は顧客の画面に出る（ホームの「振替 N回」＋
予約画面の「①通常／②振替」の分岐）
GASは memberStatus の home の**外**に置き、Workerは home の**中**を読んでいた
＝Worker経由では**常に { available: 0 }**
＝振替権を持つ会員が、振替で予約できなかった
```
★shadow のために「顧客に返す値の一覧」を作ろうとして初めて気づいた。
```
直し方   写しのトップレベルに transferCredits を入れる（GAS・1回のシート読み）
         readHome がそれを返す（Worker）
         D1からは作れない（振替権のデータがD1に無い）ので、
         **手順4（顧客に出す）のときは写しから補う**＝設計10の一覧に追加
         再発防止：home-fields.test.js が「Worker が home.XXX として読む鍵が
         全部そろっているか」を機械で確かめる
```

### この関門が無ければ
①は**顧客の画面が壊れる**経路、③は**いま顧客に影響している不具合**だった。
どちらも「on にする直前に、害を列挙して問う」ことでしか出てこなかった。

### 関門③の2周目（★自分の修正が3つとも新しい穴を作っていた・却下0）
```
① ★★退行：振替権のシートが読めないとき、**全員を0で上書き**していた
   「失敗しても押し出しを止めない（0に見えるだけ・いまと同じ）」と書いたが、
   **写しに入れたあとは同じではない。** 正しい写しを「振替0回」で潰す
   ＝振替で予約できなくなる。**「不明」を「0件」に変換して押し出してはいけない**
   → 読めなければ写しを押し出さない（前の正しい写しが残る・keepStale）
② 動的 import の Promise は waitUntil に登録されない
   ＝応答後に解決する前に isolate が終わりうる＝**静かに一度も動かない**
   → 静的 import にして、deferred の中で同期的に scheduleShadow を呼ぶ
③ compatMemberStatus の早期 return（!cust / !home）で runDeferred を呼んでいなかった
   !home は「写しが無い／壊れた／古すぎる」＝**D1なら答えられるか、
   いちばん確かめたい場面**。取りこぼしていた
   → 早期 return でも起動する
```
★①は**私の修正が持ち込んだ退行**。②③は**取りこぼし**。
　「自分の修正こそレビューに戻す」が3回続けて効いた。

### 壊して落ちることを確かめた（計9通り）
```
shadow の転送を落とす／世代の照合を外す／status に限定／out_of_range を枠の後に
モードの厳密一致を緩める／付帯情報も比べる
★読めなくても0で押し出す／★静的importを消す／★早期returnでflushしない
```

### 残っている課題（本番 on の前に実測する）
```
□ 振替シートの行数と _edgeTransferCreditsAll の所要時間（home は既に42秒）
□ nextExpireLabel の日本語固定（英語の会員に日本語の日付が出る）
  → 画面が nextExpiryMs から整形する形が望ましい。別の変更として扱う
□ 枠3は「保証値ではない」。1週間後に入口別の completed・時間帯の分布・
  世代枠の件数・incomplete・pre/post skip を見て合否を決める
```
