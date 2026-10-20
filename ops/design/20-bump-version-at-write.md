# 設計20：D1 が「古いのに新しい」と名乗らないようにする（切り替え前の修正）＋重複パックを数える

- 日付：2026-10-20（第3版：関門①2回目 NOT PASSED を受けて作り直し）
- 承認：オーナー「2と3を進めて」（D1 正本化の切り替え前の修正と未測の条件）
- 関連：設計10（段階3-b）§関門① ②、設計11（sync-version）、設計07（二重書き）、決定0084 追記（10/19 の食い違い）

## 0. 倒れる向き
判定できないときは **D1 で答えない（写しへ落とす）** 側へ倒す。ただし倒れたままを隠さない（数える・作り直しを積む）。

## 1. 事実

| | 事実 | 根拠 |
|---|---|---|
| F1 | 10/18 にチケット2枚を追加した会員1名で、shadow が「写し=2枚／D1=0枚」を1回記録。10/19 の照合で D1 も2枚・41名一致 | shadow 10/16〜・quotaBuild verify 10/19 |
| F2 | D1 が新しいと名乗る条件＝`source_version === built_version && built_version > 0`（I8） | `worker/src/lib/remain-from-d1.js:342-351`・`shadow-status.js:58`・`quota.js:349` |
| F3 | `source_version` が進むのは計算入力（calcContracts/calcReservations/opening）を受けたときだけ。scope:'customer' は行0件でも進む | `worker/src/routes/ingest.js:310-331` |
| F4 | 二重書きの後追い処理（`lbDualWriteDrain`）が送る計算入力は **予約（calcReservations）だけ**。契約と棚卸しは送らない。その後 `/quota/build?customer=` で作り直す | `gas/PushToEdge.js:3537-3543`・`_edgePushCalcResvFor` |
| F5 | 契約（calcContracts）を D1 へ送るのは `_pushToEdgeAllImpl`（15分ごとの pushToEdgeLight と深夜の完全同期）だけ。全員ぶん・same() で変わった会員だけ source を進める | `gas/PushToEdge.js:1074-1081` |
| F6 | 書き込み直後の `edgeAfterWrite` は ①二重書きに積む ②写しの残数（home）③予約の写し、をその場で送る。②③は計算入力ではない＝世代は進まない | `gas/PushToEdge.js:900-950` |
| F7 | 走っている後追い処理は台帳を開始時に1回だけ読む。走っている間の書き込みは版を上げ、終了時に REQUEUED になる | `PushToEdge.js:3222・3503・3329` |
| F8 | 待ち行列の版は会員ごとで、完了すると行ごと消える（次の書き込みは1から） | `lbDwEnqueue`・`_lbDwDone` |

**穴は2つ**（第2版の H3「誰も積まない」は誤り。`lbDwPullBehind`（PushToEdge.js:3081・pushToEdgeLight から呼ぶ）が source>built の会員を1回2名ずつ積んでいる＝関門①2回目で訂正）
- **H1（10/18 の最も整合する説明）**：チケット追加 → 後追い処理が**古い契約のまま**作り直し → source===built。D1 は「新しい」と名乗るがパックが無い。15分後の定期送信で契約が届いて source が進み、lbDwPullBehind が積み直して追いつく
- **H2**：書き込み直後〜後追い処理の完了まで、D1 は古いのに世代は一致したまま。走っている後追い処理が古い台帳で作り直すと、その後も一致したまま（F7）
- 第2版の「入力ごとに input_seq を進める」案は捨てた：入力は4回に分けて届くので、途中の混ざった状態を「この番号まで入った」と名乗れる（関門①2回目）

## 2. 変えること（第3版）

### 2-1（H1・H2の土台）後追い処理を「1回の送信・1つの batch」にする
```
GAS   lbDualWriteDrain（1名ごと）
        ① 通し番号 S を読む（LB_DW_SEQ・台帳を読む前）
        ② 台帳・契約表・棚卸しを読む（実行につき1回・シートキャッシュ）
        ③ POST /quota/rebuild { customerId, seq:S, contracts:[…], reservations:[…], opening:{…}|null }  ← 1回だけ
Worker /quota/rebuild（合言葉が要る）
        ・受け取った3種類から、いまの buildQuota と同じ関数で枠・パック・引当を作る（D1 の計算入力を読まない）
          calcMeta（契約表の列の並び）だけは D1 のものを使う
        ・次を**1つの D1 batch** に入れる
            その会員の calc_contract_rows / calc_reservation_rows / member_opening の差し替え（scope:'customer' と同じ意味）
            source_version +1（いまの scope:'customer' と同じ）
            枠・パック・引当の書き込み（いまの buildQuota と同じ文）
            作り直しの記録（markBuilt）：built = 進めた後の source、built_covers_seq = S（同じ1文で、いまの source と比べる）
        ・途中に別の入力が来たら（source が想定と違う）built=0＝名乗らない（いまの markBuilt と同じ規則）
```
- **混ざった状態が存在しない**：入力の差し替えと作り直しと記録が同じ batch。届いた／届いていないの中間が無い
- **通信が減る**：いまは1名につき2回（予約の入力・作り直し）→ 1回
- 契約の行は**シートの行番号（idx）を保ったまま**送る（合成 pack_id が行番号を含むため・MODEL §4）
- 問題（OPENING_PACK_UNRESOLVED 等）が1件でもあれば何も書かない（いまの buildQuota と同じ・I5）
- 定期送信（scope:'all'）と深夜の全員作り直しはいまのまま。**built_covers_seq を上げるのは /quota/rebuild だけ**。ほかの作り直しは covers を変えない（上げも下げもしない）

### 2-2（H2）書き込みの通し番号で「追いついたか」を判定する
```
GAS   LB_DW_SEQ：全体で1本・減らない。lbDwEnqueue のロックの中で +1、戻り値で返す
      edgeAfterWrite：積む（S を得る）→ 写し（home）の送信に dirtySeq:S を載せる（_edgePushRows が本文に明示的に載せる）
D1    customer_sync_version に足す（migration 0020）
        dirty_seq         書き込みの最新の番号（MAX で更新＝再送しても同じ）
        built_covers_seq  /quota/rebuild が作り直したときの S
        dirty_since       covers >= dirty から外れた最初の時刻（追いついたら NULL・追加の書き込みでは動かさない）
      新しいと名乗る条件（I8 を拡張・判定は1つの関数に。いま3か所に複製がある）
        source === built && built > 0 && built_covers_seq >= dirty_seq
```
- 走っている後追い処理が古い台帳（S0）で作り直しても、書き込みの番号 S1 > S0 なので名乗らない。REQUEUED → 次の処理で追いつく
- 写しと dirty_seq は同じ batch。写しが新しくなった瞬間に D1 は古いと知る
- 番号を送らない経路（定期の写し・古い GAS）は dirty を変えない。初期値は dirty=0・covers=0 ＝ 判定はいまと同じ（後方互換）
- 積むのに失敗（溢れ・ロック）すると番号が無い＝dirty を立てられない＝この窓は今と同じで残る。溢れは既に至急で知らせている（決定0090）

### 2-3 取り残しを数える
- `/quota/status` に「書き込みに追いついていない会員：n名（dirty_since が最も古いもの 何分前）」。日次点検で30分超が1名でもあれば warn
- 既存の stale（source>built）の会員 ID は **Worker 側で下4桁にして返す**（いまはフルの ID・Codex 指摘）
- lbDwPullBehind の1回2名は、待ち行列を押し出さない既存の作り（_lbDwEnsureQueuedInLock）のまま。件数は変えない（収束が遅いと分かってから測って決める）

### 2-4（3a）重複パックを数える
- 対象：`pack_id` が `/^CT\d+_\d+_\d+$/`（合成ID）の行だけ。規則は `_lbPackPrefix` と同じ関数を共通で使う。PK・strict の明示 ID は対象外
- 数え方：**同じ会員・同じ `CT<開始>_<終了>` が2行以上ある組（会員×prefix）の数**と、該当会員の下4桁
- 出すのは件数と下4桁だけ。生の pack_id・氏名・電話は出さない。表示は _ejScrub を通る（I28）

### 3(b) D1 が答えないとき写しへ落ちるか
- **いまは測れない**（D1 の値を顧客に出す mode 'on' が未実装・設計10 §関門① ③）。次の設計で、①null ②世代・番号の不一致 ③読み取りの例外 の3通りを入口から通す検査で固定する

## 3. 不変条件（MODEL §3 に足す）
| | 不変条件 | 守る検査（予定） |
|---|---|---|
| I30 | 後追い処理は1名につき /quota/rebuild を1回。入力の差し替え・作り直し・記録は1つの batch | `worker/test/rebuild-one.test.js`（本物の SQLite に migration を流し、入口から通す） |
| I31 | 新しいと名乗るのは source===built && built>0 && built_covers_seq>=dirty_seq のときだけ。判定は1つの関数 | 同上＋3か所がその関数を呼ぶことの検査 |
| I32 | 通し番号は台帳を読む**前**に読む | GAS：読む順番を身代わりで記録して確かめる |
| I33 | built_covers_seq を上げるのは /quota/rebuild だけ | rebuild-one.test.js（他の作り直しで covers が変わらない） |
| I34 | 書き込みに追いついていない会員が30分を超えたら点検に出る | status の検査 |

## 4. 競合の表
| | 順番 | 結果 |
|---|---|---|
| ① | 書き込み → 積む(S1) → 写し(dirty=S1) → 後追い(S≥S1 を読む→台帳) → rebuild(covers=S) | 名乗る ✅ |
| ② | 後追い A が S0 を読み台帳を読む → 書き込み(S1) → 写し(dirty=S1) → A の rebuild(covers=S0) | covers<dirty＝名乗らない。A は REQUEUED → ① ✅ |
| ③ | 速い道の後追いが S≥S1 を読んで rebuild → 写し(dirty=S1) が後から届く | covers≥dirty＝名乗る ✅（台帳は積む前に書き込み済み） |
| ④ | 書き込み2回（S1,S2） | dirty=S2。S≥S2 の rebuild だけが名乗れる ✅ |
| ⑤ | 写しの送信だけ失敗 | dirty が立たない＝今と同じ窓。送信失敗を数える |
| ⑥ | 積むのに失敗 | 番号が無い＝今と同じ窓。溢れの至急 |
| ⑦ | 写しの再送 | MAX＝同じ ✅ |
| ⑧ | rebuild の応答を GAS が受け取れず再送 | 同じ入力の差し替えは冪等。source が1つ余分に進み built も同じ1文で揃う ✅（検査で固定） |
| ⑨ | rebuild の batch が途中で失敗 | 全部無かったことになる（D1 の batch）。lease を外して次回 |
| ⑩ | 定期送信（scope:'all'）の契約が rebuild の後に届き、中身が同じ | same() で source は進まない＝名乗ったまま ✅ |
| ⑪ | 定期送信が rebuild より**古い**スナップショットを後から送る | 行は synced_at のガードで巻き戻らない（ingest.js:226）。中身が違えば source が進み名乗らない → lbDwPullBehind ✅（安全側） |
| ⑫ | 深夜の全員作り直しが rebuild の後に走る | 通常の作り直しは covers を変えず、開始時の source と batch 内の source が一致したときだけ built を進める（§7-1 の4）。入力が定期送信で変わっていても、その最新の入力から作るので正しい ✅ |
| ⑬ | calcMeta（列の並び）が変わった | 全員の source が進み名乗らない → 全員作り直し（いまと同じ） |

## 5. 壊れうるところ
| | 懸念 | 手当て |
|---|---|---|
| ① | 書き込みのたびに D1 が一時的に答えない | 意図どおり（写しへ落ちる＝今と同じ表示） |
| ② | rebuild 1回の本文が大きい | 1名分の契約・予約・棚卸し。上限を決めて超えたら断る（413）＝作り直さず次回 |
| ③ | 後追い処理の時間（予算90秒・1回5名） | 通信は1名2回→1回に減る。契約表を読む分が増える＝実行ごとに1回。各送信の前に残り時間を見る。所要時間を段ごとに記録 |
| ④ | /quota/build と /quota/rebuild で計算が二重になる | 計算の関数は共通（入力の出どころだけが違う）。同じ入力で同じ答えになることを検査で固定 |
| ⑤ | 個人情報 | 新しく出すのは件数と会員#下4桁だけ。rebuild の本文（契約行に氏名が入る）は合言葉つきの内部送信で、エラー応答・ログに本文を入れない |

## 6. 実装の順序
1. Worker：migration 0020（dirty_seq・built_covers_seq・dirty_since）・/quota/rebuild・ingest(home) の dirtySeq・判定関数の一本化・status の追加（検査を先に書く・壊して落ちることを確かめる）
2. GAS：LB_DW_SEQ・lbDwEnqueue の戻り値・edgeAfterWrite の dirtySeq・後追い処理を /quota/rebuild 1回に・_edgePushRows の転送・status と日次点検の表示
3. 関門②（Codex）→ push（Worker は即公開。GAS が番号を送るまでは dirty=0・covers=0 で判定は今と同じ＝後方互換）→ GAS 反映（オーナー）
4. 反映後：チケット追加か予約を1件入れ、①名乗らない→②追いついて名乗る、を作業依頼で確かめる

## 7. 実装の取り決め（関門①3回目の指摘12点・すべて採用）

### 7-1 世代と記録（/quota/rebuild）
1. 開始時に `ver0`（いまの source）を読む。batch 内で source を +1 するので、**期待する世代は ver0+1**。枠・パック行の built_version も ver0+1
2. batch の順番：計算入力の差し替え → source+1 → 世代の印を外す → 枠・パック・引当 → markBuilt
3. markBuilt は「いまの source が ver0+1 のとき」だけ built=ver0+1・`built_covers_seq = MAX(built_covers_seq, S)`。違えば built=0・行数と範囲は NULL・**covers は動かさない**
4. 通常の作り直し（/quota/build・深夜・作業依頼）は **covers を決して変えない**。開始時に読んだ source と batch 内の source が一致するときだけ built を進める（いまの規則のまま）
5. `dirty_since`：rebuild 成功で covers>=dirty なら NULL／競合で built=0 なら維持／写しの dirty 更新で新しい dirty<=covers なら NULL のまま・初めて dirty>covers になったときだけ現在時刻・追加の dirty では維持
6. calcMeta が読めない・壊れている（NO_META / BAD_META）ときは何も書かない

### 7-2 入力の形をそろえる
7. rebuild が書く計算入力は、定期送信の ingest と**同じ正規化の関数**で作る（row_key・customer_id・idx・row_json の文字列化・start_ms/end_ms・opening の payload の文字列化まで同じ）。そろっていないと15分ごとに「変わった」と誤判定し、毎回 source が進む。検査で `same()` が真になることを固定する
8. rebuild が書く行にも新しい batchId / synced_at を付ける（古い scope:'all' に上書きされないため・ingest.js:226 のガード）

### 7-3 大きさの上限
9. 上限を3つ：本文のバイト数・契約と予約の行数・**生成した SQL 文の数**（計算の後、書き込みの前にも見る）。超えたら 413/422 で何も書かない
10. 大きすぎた会員は再試行の輪にしない：待ち行列から外し、日次点検に「作り直せない（大きすぎる）：会員#下4桁・件数」を出す
11. 後追い処理の時間：各会員の送信の前と応答の後に残り時間を見る。超えたら残りの会員の取り置きをまとめて外す。Worker の応答に `ms / statements / inputRows / allocRows`（件数だけ）を返し、段の記録に残す。本番の最大の会員で測ってから MAX_PER_RUN=5 を維持するか決める

### 7-4 入力の検査と個人情報
12. 合言葉が必須。本文の `customerId` と、全ての契約行・予約行・棚卸しの会員 ID が一致すること（1件でも違えば**全体を拒否**・混ざった行だけ捨てない）。idx は整数・重複なし。seq は正の安全な整数
13. エラー応答は `{ code, kind, count }` だけ。本文・契約行・予約行・元の例外を応答にもログ（console.error）にも出さない。計算の issue は `{ code }` に縮める（detail・予約 ID・pack_id・row_json を返さない）。GAS 側のログも同じ
14. shadow の記録に rebuild の本文や例外を流用しない

### 7-5 修復の経路と通し番号の部分成功
15. ★`/quota/behind`（lbDwPullBehind が使う）の条件を **「新しいと名乗れない」（共通の判定関数の否定）** に広げる。いまは `source_version > built_version` だけ＝**source===built だが covers<dirty の会員を永久に拾わない**
16. `LB_DW_SEQ` と待ち行列は同じロックの中で書くが、Script Properties の2回の書き込みは一体ではない。順番は **番号を先に保存 → 待ち行列を保存**。
   - 番号の保存が失敗 → 積まない・dirty を載せない（⑥と同じ・溢れとして数える）
   - 番号は保存できたが待ち行列の保存が失敗 → 番号は飛ぶだけ（比較は >= なので害は無い）。dirty を載せない（⑥と同じ）
   - ★逆順（待ち行列が先）は採らない：番号の保存だけ失敗すると、dirty=S を立てたのに保存された番号が S−1 のまま＝後追い処理が読む番号が S に届かず、**次の書き込みが来るまで永久に名乗れない**
   - lbDwPullBehind が積むとき（_lbDwEnsureQueuedInLock）も番号を+1 して待ち行列の行に持たせる（後追い処理はその時点より後の台帳を読む）

### 7-6 追加の競合（§4 に足す）
| | 順番 | 結果 |
|---|---|---|
| ⑭ | rebuild が ver0 と calcMeta を読んだ後、batch の前に calcMeta が変わる | calcMeta の ingest が全員の source を進める＝ver0+1 にならず built=0 ✅ |
| ⑮ | rebuild が ver0 を読んだ後、定期の ingest が source を進める | 同上 ✅ |
| ⑯ | rebuild 成功の後、写しの dirty より先に通常の作り直し | covers を変えない＝dirty が届けば名乗らなくなる（S<dirty の場合）。dirty<=covers なら名乗る ✅ |
| ⑰ | 計算入力は書けたが文数超過で batch 全体が失敗 | 書き込み前に上限で断る（7-3）。batch は全部か無しか ✅ |
| ⑱ | 同じ S の古い rebuild の再送が、S より新しい書き込みの後に届く | covers=S<dirty＝名乗らない。D1 の入力が古い内容に戻る＝次の rebuild まで D1 は使えない（安全側）。lbDwPullBehind（15 で拡張）が拾う |
| ⑲ | 会員ごとの番号は飛び番 | 比較は一致ではなく covers>=dirty ✅ |

### 7-7 実装で必ず検査に固定する3点（関門① PASS 時の指定）
1. 後追い処理は**取り置いたときの seq** を rebuild に送る。処理の途中で全体の番号や待ち行列の行を読み直さない（claim の結果に seq を持たせる）
2. lbDwPullBehind は**新しく待ち行列に足すときだけ**番号を発行する（既にいる会員・取り置き中の行の seq を書き換えない）
3. `/quota/behind`・残数の読み取り・shadow/status の「新しいか」は**同じモジュールの1つの定義**から作る（JS の isFresh と SQL の条件を同じ場所で組み立てる。別ファイルに手書きしない）

> 関門①：2026-10-20・4往復で PASS。第1版（写しに相乗りして source+1）→ 走っている後追い処理との競合で不合格。第2版（入力ごとの input_seq）→ 混ざった入力を名乗れる・H3 は既存の修復を見落とした誤りで不合格。第3版（1回の rebuild）→ 取り決め12点の書き漏らしで不合格。§7 を足して合格。却下した指摘は無し
