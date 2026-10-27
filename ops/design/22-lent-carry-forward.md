# 設計22：翌月に前借りされた回数（lent）を D1 に持つ

2026-10-27 ／ 決定0092（D1 正本化）の全員切り替えの前提

## 0. 倒れる向き
前借りの数が分からない行（lent が NULL）・別の月の時点で作った行（as_of_month が今の月と違う）は D1 から答えない（写しへ）。

## 1. 何が起きたか（事実）
- 照合（GAS⇄Worker の計算）45名・547時点 全一致。D1 世代 45/45 最新。
- shadow と quota verify で 2名（*3105・*3922）の10月が **計算=0 / D1=1**（枠4・D1の使った=3）。
- 2名とも11月に5件（枠4を1超え）。
- 計算（worker/src/allocate.js:405-429・gas/Allocate.js 同一）：未来月（11月）は自分の base を先に使い、
  足りない分を carryIn（＝10月の carryOut）から使う（carryUsed）。2巡目で当月（10月）に
  `carryForward = min(taken, base − baseUsed)` を **used に足す**（同じ枠を二度使わせない・2026-09-25）。
- D1：monthly_quota.used は引当（allocations）のトリガーだけが動かす＝**その月に割り当たった予約の数**。
  前借りされた1回は11月の予約なので10月の used に入らない → 10月の残りが1多い。
- 11月側は一致する：11月の quota = 4＋carryIn(1) = 5、11月の引当5件＝used 5 → 残り0。

## 2. 変更
1. **計算**：`_lbComputeRemaining` の返り値に `lent: pm ? (pm.carryForward || 0) : 0` を足す
   （gas/Allocate.js と worker/src/allocate.js の両方・allocate-drift 検査で同一を保つ）。他の読み手は見ない。
2. **migration 0023**：`ALTER TABLE monthly_quota ADD COLUMN lent INTEGER;` と `ADD COLUMN as_of_month TEXT;`（どちらも既定値なし＝NULL）
   - as_of_month＝その行を作ったときの「今の月」（計算に渡した nowKey）。計算は今の月で消化順（未来月は base 先・当月は繰越先）と
     前借り（ord >= asOfOrd のときだけ）が変わるので、**予約が無くても月が替われば値が変わる**（関門①）。
   - 既定値を入れない理由：既存行を 0 で埋めると「まだ作り直していない行」が「前借りなし」として正しく見えてしまう（MODEL の 0012 と同じ罠）。
3. **保存**（quota-build.js）：月の行に `lent = Number(res.lent || 0)` と `asOfMonth = nowKey` を持たせ、`quotaUpsertStatements` で両方書く。
   - used には触れない（不変条件のまま）。lent は作り直しのたびに上書き。
4. **読み取り**（remain-from-d1.js）：
   - 読む行（対象月・当月・**翌月**）すべてで as_of_month が今の JST の月と違う／NULL なら、全体を `as_of_stale` で失敗（写しへ）。
   - limited のとき lent が NULL なら `lent_missing` で全体を失敗。**翌月の行も同じ**（以前は翌月の ok:false を nextMonth=null として続けていた＝写しの nextMonth を null で上書きしうる・関門①）。
   - 数値なら limited の残り＝`quota − used − lent`。uncovered（0）／unlimited（null）は従来どおり coverage の規則が優先。
   - SELECT に lent・as_of_month を足す。
5. **照合**（quota-verify.js）：d1Monthly を同じ規則に（lent NULL・as_of_month が今の月でない行は一致と数えない・件数を出す）。
6. **状態表示**（quota.js status）：「いまの世代かつ fresh の行」に限って、lent 未設定・as_of_month が今の月でない行の件数を出す（古い世代の行は数えない・関門①）。0 になるまで切り替えない。
7. **月替わりの自動の作り直し**（quota.js /quota/behind）：「いまの世代の月額行で as_of_month が今の月でない（NULL 含む）会員」も返す。
   GAS の lbDwPullBehind（15分ごと・2名）がそのまま拾って作り直す＝GAS の変更なし。45名なら約6時間で全員。その間は写しを返す。

## 3. 反映の順序
1. push → migration（列を足す）→ Worker 反映。この時点で全員の行は lent・as_of_month が NULL
   → 許可表4名・検証会員も含め D1 からは答えず写しへ（顧客に出るのは写し＝今と同じ正しい値）。
2. 全員の作り直し（作業依頼 quotaBuild write/alloc・from 2026-09 to 2026-12）→ 入る（放っておいても /quota/behind で約6時間で入る）。
3. status で「lent 未設定 0」・quota verify 全員一致・shadow 食い違い0 を確かめる。
4. 関門③ → オーナー承認 → 全員切り替え。

## 4. 境界・既知のこと
- 月替わり：as_of_month の不一致で写しへ倒れ、/quota/behind が作り直す（§2-7）。11/1 の朝は数時間 D1 から答えない（写しは正しい）。
- 当月に予約が増えて base が埋まると carryForward は縮む（min）。予約のたびの作り直し（設計20）で lent も更新される。
- 不変条件 `used ≤ quota` の検査はそのまま。`used + lent ≤ quota` も成り立つはず（carryForward ≤ base − baseUsed）→ status に件数を出す。

## 5. 検査
- 本物の SQLite に migration を流して列が NULL で足されること（CHECK・既定値なし）。
- quota-build：前借りがある会員で lent=1 が行に入る（計算と同じ入力で）。
- remain-from-d1：lent NULL → ok:false／lent 1 → rem が1減る／uncovered・unlimited は lent を見ない。
- quota-verify：lent NULL は一致と数えない。
- 入口から：前借りの形（10月 base4 使った3・11月5件）で readRemainDiag の10月が 0。壊して落ちることを確かめる。
- 10月に作った行を11月に読む → as_of_stale（写しへ）。翌月の行だけ lent NULL → 全体が lent_missing。
- /quota/behind：as_of_month が今の月でない会員・NULL の会員を返し、今の月の会員は返さない（本物の SQLite）。
- MODEL.md §3 に不変条件を足し、守る検査を紐付ける。
