# 設計27：チケットだけの会員の「支払い待ち」を D1 に残す

2026-11-03 ／ shadow の食い違い（11/2・11/3 朝の sweep・*4717）から。

## 0. 倒れる向き
支払い待ちの件数が D1 で確かめられないときは **答えない**（写しへ落とす）。0 で埋めない。

## 1. 事実
- 写し（GAS `_lbOverageOf`・gas/LineBooking.js 7217）：当月の未割当で、理由が LB_OVERAGE_REASONS か**空**のものを数える。契約の種類を問わない
- D1：引当の結果 `al.overageByMonth`（worker/src/lib/alloc-build.js 100）を**月額の枠の行にだけ**移す（worker/src/routes/quota.js 661 `for (const m of built.monthly) m.overage = …`）
- 読む側（worker/src/lib/remain-from-d1.js 171）：`overageCount = curMonthRow ? curMonthRow.overage : 0`
- 月額の枠の行は `res.hasMonthly` の会員にしか作られない（worker/src/lib/quota-build.js 105）＝**チケットだけの会員は常に 0**
- 実例：*4717（レンタル3枚・期限10/31）の 11/5 の予約が PACK_EXPIRED で未割当。写し=支払い待ち1、D1=0。毎朝の sweep で同じ食い違い（11/2・11/3）。オーナーが契約を延長して 11/3 昼に解消（穴は残る）
- 段階1の4名のうち2名（*3330・*4220）がチケットだけ。いまは支払い待ち0なので画面は正しいが、超えた時点で D1 は「要支払い」を出さない
- 作り直しは2経路：/quota/build（quota.js 203・withAlloc のときだけ markBuilt）と /quota/rebuild（quota-rebuild.js 138）。どちらも `computeCustomerBuild` の `cb.al` を持つ
- 世代の行 `customer_sync_version` は読むたびに2回読む（ver / ver2 で世代が動いていないか）＝**ここに置けば枠・パックと同じ世代の値として読める**

## 2. 変更
1. migration 0024：`ALTER TABLE customer_sync_version ADD COLUMN built_overage_json TEXT`
2. `markBuiltStatement(…, rows)`：`rows.overage = { asOf:'YYYY-MM', m:{ 'YYYY-MM': n } }` を受け、JSON で書く。
   競合で世代を 0 に倒すときは他の列と同じく **NULL**
3. 呼ぶ側（2経路）：`overage: { asOf: nowMonthKeyJst(now), m: cb.al.overageByMonth }`
4. `readSyncVersionForRemain`：`built_overage_json`・`built_from_month`・`built_to_month` も読む。壊れた JSON は null
5. `buildRemainDiag`（契約が無い会員の `{type:null}` より後、契約がある会員だけ）：
   - overage が null → `overage_missing`（答えない）＝新しい作り直しを通っていない会員
   - `overage.asOf !== nowKey` → `as_of_stale`（月替わり・設計22と同じ）
   - 当月が作った範囲（from〜to）の外 → `overage_out_of_range`
   - 当月の枠の行があり、その overage と JSON の当月が違う → `overage_mismatch`（2つの写しが割れている）
   - それ以外：`overageCount = m[当月] || 0`
6. MODEL.md：答えない理由に3つ足す・不変条件「支払い待ちは世代の行が正本（枠の行の overage は照合用）」

## 3. 入れたあとの動き
- 反映直後は全員 `overage_missing` → 写しで答える（段階1の4名も）。作り直しが一巡すれば戻る
- 一巡のさせ方：作業依頼 `quotaBuild {write:true}`（全員の作り直し・既存）を1回

## 4. 検査
- チケットだけの会員：未割当1 → D1 の overageCount 1・paymentRequired true（*4717 の形）
- JSON が無い → null（overage_missing）／月が違う → as_of_stale／範囲外 → null
- 枠の行の overage と JSON が違う → null
- 競合で built を 0 に倒すと JSON も NULL
- 2経路の markBuilt に overage が渡っている（配線）
- 壊して落ちることを確かめる

## 5. 関門①（Codex・2026-11-03）の指摘と対処
| 指摘 | 対処 |
|---|---|
| 重大：同じ世代のまま作り直すと ver/ver2 が同じでも、古い JSON と新しい枠・パックが混ざりうる | 同じ世代＝同じ入力なので計算は同じ（違いうるのは今の月＝asOf で捕まる、と版の差＝反映の瞬間だけ）。そのうえで**ver と ver2 で JSON・from・to の生の値も比べる**（違えば version_changed）。専用の build_revision は入れない（既存の枠・パックも同じ前提で動いている） |
| 重大：理由が空の未割当を GAS は数え、Worker は数えない | Worker を GAS（写し＝今の正）に合わせる：`!reason \|\| OVERAGE_REASONS[reason]`。Allocate は未割当に必ず理由を付けるので実害は無いが、規則を1つにする。実行の検査を足す |
| 要修正：形の検査 | asOf=YYYY-MM・m は plain object・**当月の鍵が明示的にある**・値は0以上の安全な整数。満たさなければ `overage_bad_shape`。書く側は from〜to の**全月を0も含めて**書く（欠けと0を区別するため） |
| 要修正：from/to が NULL・不正 | `overage_out_of_range` ではなく `overage_bad_shape` |
| 要修正：チケットだけの会員は as_of の検査が効いていなかった（残数も） | JSON の asOf がチケット残数の月替わりの守りも兼ねる、と MODEL.md の不変条件に明記（JSON を外すと穴が戻る） |
| 要修正：反映直後は shadow の比較が `_post:overage_missing` になり母数が減る | 記載。作り直しを一巡させてから数え直す |
| 軽微：`cb.al.computed === true` を前提に | 書く側で確かめ、満たさなければ JSON を null（＝答えない） |
| 軽微：個人情報 | 新しい列は月・件数・asOf だけ。壊れた JSON を出力に出さない |

## 6. 関門②（Codex・2026-11-03）の指摘と対処
| 指摘 | 対処 |
|---|---|
| 重大：「同じ世代＝同じ入力＝同じ計算」は成り立たない（計算には今の時刻 now が入る）。JSON・範囲が同じまま枠・パックだけ変わる作り直しが、二度読みの間に挟まると混ざる | **関門①の案どおり `built_rev` を入れる**（0024 に列を追加・markBuilt のたびに結果にかかわらず +1）。二度読みで比べる。§5 の「入れない」判断は誤りだった |
| 要修正：形の検査が当月の値しか見ていない | m の鍵が from〜to の全月と**過不足なく一致**・全値が0以上の安全な整数・月は 01〜12。書く側も同じ月の形 |
| migration の順序 | 標準の反映は migrations → deploy の順なので窓は無い。手で逆順にすると markBuilt が落ちる＝**手で deploy しない** |
| 反映直後の画面 | D1 が ok でなければ上書きせず写し（remain-read-on.js）。壊れない |
