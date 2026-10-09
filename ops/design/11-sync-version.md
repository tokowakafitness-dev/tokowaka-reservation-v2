# 会員ごとの世代（段階3-b 手順1）

> 2026-10-09・CEO玄／前提：`10-stage-3b-read-from-d1.md`（関門①の追記を含む）
> 関門②（push前）を2周通した記録。指摘と対処は `00_board/decisions/0076` に。

---

## 1. 何を解く仕掛けか

3-b で顧客の残数をD1の行から作る。そのとき必要なのは1つの判定だけ。

```
この枠と引当は、いまの入力から作り直したものか
```

**いまのD1には、それを判定できる時刻が無い。**

| 使えそうなもの | なぜ使えないか |
|---|---|
| `monthly_quota.updated_at` | 取消のトリガーで**過去に戻る**（0009:109 が削除した引当の古い decided_at を書き戻す） |
| `*.synced_at` | 内容が変わった時刻ではない。差分同期は変わっていない行を書かない |
| `line_reservations` の作成時刻 | 取消・変更では動かない |
| `reservation_allocations.decided_at` | 比べたい対象そのもの |

---

## 2. 仕組み（3行）

```
GASが計算の入力を押すたび        source_version を +1
枠と引当を作り直したとき          自分が読んだ source_version を built_version に書く
顧客に答えるのは                  source_version === built_version かつ built_version > 0
```

答えないときは写し（`member_home`）へ落とす。**止まる側ではなく、遅い側に倒れる。**

計算の入力は `loadCalcInput` が読む4つと1対1に合わせる。

| 種別 | 表 | 進め方 |
|---|---|---|
| `calcContracts` | `calc_contract_rows` | その会員 |
| `calcReservations` | `calc_reservation_rows` | その会員 |
| `opening` | `member_opening` | その会員 |
| `calcMeta` | `calc_meta`（列の並び） | **全員**（会員で分かれていない） |

★これ以外の表（予約の写し・残数の写し・体組成・空き枠）では進めない。
　進めすぎると `source > built` が常態化し、いつまでもD1から答えられない。

---

## 3. ★いちばん難しかったところ：古い作り直しが後に書き終わる

作り直しは同時に2本走りうる（作業依頼と手動、ページ分割）。

```
A が世代10を読む
   入力が来て source=11
B が世代11を読み、新しい枠を書いて built=11
A が古い枠で上書きする          ← ここ
```

A の印を `MAX(11, 10)` で書くと **11 のまま**＝行は世代10の内容なのに「新しい」と見える。

### 採らなかった案：書いたあとに読み直して倒す
一度実装したが捨てた。理由2つ（どちらもCodexの指摘）。
```
① batch が終わってから倒すまでに窓が開く。
   その間にWorkerが終われば、誤った「新しい」が残り続ける
② 倒す文は、後から完了した**正しい方**のビルドも倒す
```

### 採った案：枠と同じ batch の中で判定する
`markBuiltStatement` の1文で、いまの source と自分が読んだ世代を比べる。
```sql
built_version = CASE
  WHEN source_version = excluded.built_version
    THEN MAX(built_version, excluded.built_version)   -- 自分が最後に書いた
  ELSE 0                                              -- 古い方だった／途中で入力が来た
END
```
**どちらの順序で終わっても、最後に枠を書いた方の世代が印として残る。**
MAX は「同じ世代から同時に作り直した2本」のためだけに残している。

---

## 4. 完全同期で消える行（もう1つの穴）

日次の完全同期（`deleteStale`）は「送られてこなかった行＝消えた行」を落とす。
その会員は `rows` に出てこないので、**入力が変わったのに世代が進まない。**

```
対処  削除の前に SELECT DISTINCT customer_id で消える会員を集め、
      その bump と DELETE を**同じ batch**に入れる（DELETE は最後）
```

★読めなかったときは**消さずに帰る**（`skippedDelete: 'STALE_IDS_READ_FAILED'`）。
```
消せなかった            → 古い入力が残る → 写しへ落ちるだけ
世代を進めずに消した    → 古い枠を新しいと答える → 顧客に誤った残数
```
後者のほうが重い。同期時刻も押さない（押すと古い行が「たったいま同期した」顔になる）。

---

## 5. 確かめ方

```
quotaStatus の syncVersion   total / fresh / stale / ahead / noBuilt ＋ 遅れている会員20件まで
ingest の応答                bumped（その会員ぶん）/ bumpedStale（完全同期で消える会員ぶん）
quotaBuild の応答            marked（印を書こうとした会員の数）
```
★`ahead`（built > source）は**あってはならない向き**。0でなければ何かが壊れている。

検査は `worker/test/sync-version.test.js`（52本）。
**本物のSQLiteで文を走らせている。** この仕組みの正しさはSQLの意味にあるので、
字面を見るだけでは「MAX と書いてある」しか分からない。
壊して落ちることも確かめた（CASE を外す／条件を false にする／読めなくても消す形に戻す）。

---

## 6. まだやっていないこと

```
手順2  readRemainFromD1（D1の行から member_home と同じ形を作る）
手順3  shadow（両方を読んで食い違いを数える）
手順4  この世代を使った鮮度の判定を読み取りに繋ぐ
```
★`isFresh` はまだどこからも呼ばれていない。**顧客に出る数字は変わっていない。**
