# 段階3-b 手順3：shadow（両方を読んで食い違いを数える）

> 2026-10-09・CEO玄／前提：`10-stage-3b-read-from-d1.md`・`11-sync-version.md`
> **第2版。** 第1版は関門①で差し戻された（指摘8件・却下0）。差し戻しの内容は第10節に残す。

---

## 1. なぜ要るのか

手順2で「D1の行から残数を作る部品」を書いた。しかし**値が合うことは何も確かめていない。**
確かめたのは形（鍵の名前）と規則だけ。

```
照合（quotaBuild verify）   私が回すときだけ・月額の残数とチケットの残数だけ
shadow                      ★顧客が画面を開くたび・**写しの全部の鍵**を比べる
```

照合で見ているのは2つの数字。写しには24個の鍵がある。
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

`readHome`（`worker/src/routes/boot.js`）の中に入れる。ただし**勝手には比べない。**

```
readHome(env, customerId, targetMs, opts)
  └ 写しを読む（いまの中身そのまま）
  └ 比べるのは、次が**全部**そろったときだけ
       モードが 'shadow'（文字列が厳密に一致）
       opts.shadow === true          ← 入口の意思
       opts.ctx.waitUntil が使える   ← 応答のあとに走らせる手段
  └ 返すのは**いつでも写し**
```

### ★`ctx` の有無を入口の印にしない（関門①の指摘1）
`ctx` は `index.js` で**すべての handler に一律で渡っている**。
「`ctx` があれば比べる」にすると、除外したい入口まで全部対象になる。
`ctx` は**実行の手段**、`opts.shadow` は**入口の意思**。分ける。

### 比べる入口／比べない入口

| 入口 | 比べる | なぜ |
|---|:-:|---|
| `routeBoot`（会員の起動） | ✅ | 1回の起動で1回 |
| `compatMemberStatus`（会員の起動・互換） | ✅ | 同じ |
| `compatCustomerHome`（トレーナーが顧客カードを開く） | ✅ | 回数が読める |
| **`compatBookingOptions` / `routeBookingOptions`** | ❌ | **候補を選び直すたびに呼ばれる**（`liff/index.html` の確認画面）。確定の経路を遅くしない |
| `customerDetail` | ❌ | 上と同じ入口から連鎖する |

★`compat` は1つの入口ではない。`compatBoot` が `compatMemberStatus` を、
`compatCustomerCard` が `compatCustomerHome` を内部で呼ぶ。
だから `readHome` の中で handler 名を推測しない。**`readHomeSafe` に opts を通す。**

---

## 4. 速くするための縛り

| | 縛り | なぜ |
|---|---|---|
| ① | **応答のあとに比べる**（`ctx.waitUntil`） | 顧客を待たせない |
| ② | **比べる入口を明示する**（第3節の表） | 候補の選び直しで4クエリ増やさない |
| ③ | `ctx.waitUntil` が無ければ比べない | 渡し忘れた経路で勝手に遅くならない |
| ④ | **会員・日・入口ごとに最初の3回だけ**比べる | 下の第5節（書き込み枠） |

---

## 5. 書き込み枠（★第1版の計算が間違っていた）

第1版は「1日1行に丸めるから最大960行」と書いた。**誤り。**
`n = n + 1` の更新は、**呼ばれるたびにD1の書き込み行数を消費する**。
ユニーク行数ではなく、更新の回数で数えなければならない。

```
正しい概算 ＝ 比較の回数 × (1 ＋ その比較で食い違った鍵の数)

1日4,000回の比較で平均5鍵が食い違えば 約24,000 行/日
全24鍵が食い違えば 約100,000 行/日 ＝ 無料枠を使い切る
```
★**会員が40名なのは、リクエストの回数の上限にはならない。**
　起動のやり直し・複数端末・トレーナーが何人ぶんも開く、で増える。

### 縛り：会員・日・入口ごとに最初の3回だけ
```
比較の前に _attempted の行を読む（n < 3 なら比べる）
上限  40名 × 3入口 × 3回 × (1 + 24) ＝ 最大 9,000 行/日（実際はこれよりずっと少ない）
```
読み取りは1日500万行まで無料なので、読んで判断するほうが安い。

---

## 6. 記録のしかた（★2層）

1日1行の集計だけでは原因を追えない（関門①の指摘）。失うのは、値が揺れたこと・
どの世代か・どの入口か・当月か翌月か・D1が答えなかった理由。

### 層1：日次の集計 `remain_shadow`
```
day            'YYYY-MM-DD'（JST）
customer_id
field          食い違った鍵の名前。または次の印
                 '_attempted'  比べようとした回数
                 '_completed'  比べ終わった回数
                 '_failed'     途中で落ちた回数
first_value / last_value    写しとD1の値の組（文字列・長いものは切る）
n              その日の回数
first_at / last_at
```
主キー `(day, customer_id, field)`。

★`_attempted` / `_completed` / `_failed` を**分ける**。
　第1版は `_checked` 1つだったが、それでは
　「人が来なかった」「モードがoff」「渡し忘れ」「D1の読み取りが落ちた」
　「表が無い」が**全部同じ0件**になり、失敗に気づけない。

### 層2：値が変わったときだけの標本 `remain_shadow_sample`
```
entry             'boot' / 'compat_member' / 'compat_home'
requested_month   呼ばれたときに求められた月
copy_month        写しが返した月
d1_month          D1が計算した月
copy_computed_at  写しの計算時刻
source_version / built_version
d1_status         'ok' / 'no_version_row' / 'not_built' / 'behind' / 'out_of_range' /
                  'read_failed' / 'no_rows' / 'base_freq_missing' / 'coverage_missing'
field / copy_value / d1_value / at
```
同じ会員・鍵で**値の組が前回と同じなら書かない**（揺れだけを拾う）。

### ★D1が答えなかった理由を失わない
いまの `readRemainFromD1` は、何があっても `null` を返す（顧客の画面を止めないため）。
shadow では理由が要るので、**診断版を別に設ける**。
```
readRemainDiag(env, cid, targetMs, opts) → { value, status, reason, version }
readRemainFromD1(...)                    → 上を呼んで value だけ返す（いまのまま）
```
顧客向けの振る舞いは変えない。理由は shadow だけが見る。

---

## 7. 比べ方

### 比べない鍵（★関門①の指摘）
```
computedAt / stale / ageMs / month   ← readHome が写しに**後から足している**応答の付帯情報
_ で始まるもの（_src / _packOverUse）
```
第1版は「`_` 始まりを除く」だけだった。それでは上の4つが**毎回必ず食い違う**。

### 値の比べ方
```
null と 0 は別物（丸めない）
オブジェクト・配列は JSON にして比べる（nextMonth / ticketPacks）
片方だけが答えた（写しが null・D1が null）は '_one_sided' として別に数える
```

### ★月をそろえる
写しは `targetMs` が無ければ `p.current` を返す。D1は `targetMs || now` で月を決める。
**月の境目では、写しの `currentMonth` が前月のままでもD1は新しい当月を選ぶ。**

```
対処  比較の始めに now を1回固定する
      D1に渡すのは「**写しが返した月**の中旬」
      その月がD1の当月／翌月の外なら status='out_of_range' として別に数える
        （単純な「値の食い違い」に混ぜない。原因が追えなくなる）
      requested / copy / d1 の3つの月を標本に残す
```

---

## 8. 切り替えと preflight

`worker/wrangler.toml` の `[vars]`：
```
LB_D1_REMAIN_MODE = "off"      既定。比べない
                  = "shadow"   比べて記録する。顧客に出すのは写し
                  = "on"       ★手順4。この設計の範囲外
```
★文字列が**厳密に `"shadow"`** のときだけ動かす。書き忘れ・打ち間違いは off 側に倒れる。
★push でデプロイ＝私が切り替えられる（承認ゲートは無い）。

### 本番で shadow を入れる前の preflight（★必須）
```
① migration 0014（世代の表）が本番D1に入っているか
② remain_shadow / remain_shadow_sample の表が入っているか
③ 世代が fresh の会員が1名以上いるか（0名なら全部が status='not_built' になる）
```
確かめ方：作業依頼の `remaining` op に `shadow: 'preflight'` を足す（新しい op は作らない）。

---

## 9. 済んだと言える条件（★第1版から変えた）

第1版は「1週間回して食い違い0件」とした。**いまは成立しない。**
枠とチケットの古い行が残っている（設計11の末尾）。その会員では必ず食い違う。

```
1. migration 0014 の適用を確かめる                        ← preflight
2. shadow を入れる                                        ★ここは「ベースライン採取」
3. 食い違いの**基準値**を取る（どの鍵が・何名で・なぜ）
4. 古い行の掃除を独立した工程で実装・検証                  ← used はトリガー管理。危険
5. 全会員を作り直す
6. shadow をもう一度1週間
7. 食い違い0 かつ _completed が十分にある                   ★ここが合格判定
8. 1人だけ 'on'（★オーナー承認）
```
★**掃除の前のshadowの結果を、合格の1週間に含めない。**

---

## 10. 第1版からの変更（関門①の指摘8件・却下0）

| | 指摘 | 直したところ |
|---|---|---|
| ① | `ctx` は全handlerに渡るので入口の印にできない | 明示 `opts.shadow`（第3節） |
| ② | `bookingOptions` は候補を選び直すたびに呼ばれる。compat は1入口でない | 入口の表を作り、`readHomeSafe` に opts を通す（第3節） |
| ③ | **書き込み量の計算が誤り**（ユニーク行数で数えていた） | 更新回数で数え直し、サンプリングを入れた（第5節） |
| ④ | `computedAt / stale / ageMs / month` が毎回食い違う | 比べない鍵に加えた（第7節） |
| ⑤ | 月の境目で写しとD1が違う月を見る | 写しが返した月をD1に渡す／範囲外は別分類（第7節） |
| ⑥ | 1日1行では原因が追えない | 標本の層を足した（第6節） |
| ⑦ | `null` の理由が失われる | 診断版を別に設ける（第6節） |
| ⑧ | `_checked` 1つでは失敗に気づけない | `_attempted` / `_completed` / `_failed` に分け、`console.error` にも出す（第6節） |

加えて、shadow を掃除より先に入れる判断は支持された（観測だけで安全・実データで規模が分かる・
掃除後に同じ計測で消えたことを確認できる）。ただし**最初のshadowは合格判定ではない**（第9節）。
