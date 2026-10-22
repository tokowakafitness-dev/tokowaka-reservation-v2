# 設計21：残数を D1 から顧客に出す（段階3-b 手順4「1人だけ on」）

- 日付：2026-10-22（第6版：関門①5回目の指摘を反映）
- 承認：オーナー「仕組みの設計を進めて」（10/22）。**実在のお客様に効かせる段（段階1以降）は、関門③とオーナーの承認が要る**
- 前提：設計10（段階3-b）・設計12（shadow）・設計19（sweep）・設計20（書き込みの通し番号・決定0091）
- 地図：ops/MODEL.md §3・§5・§4-2

## 0. 倒れる向き
D1 で答えられるか少しでも怪しければ、**いまと同じ写しを返す**（写しが使えなければ、いまと同じく GAS へ）。
**原則としていまより悪くしない。完全には防げない混在（2-5）は明示し、時間を限り、見張り、その会員だけ止められることを段階1の条件にする。**

## 1. 事実
| | 事実 | 根拠 |
|---|---|---|
| F1 | 残数を返す経路は**すべて `readHome`（boot.js）を通る**：compat の3つ（memberStatus・customerHome・bookingOptions は readHomeSafe 経由）＋ routeBoot・customerDetail・routeBookingOptions（readHome 直呼び）。いまの LIFF が使うのは compat（c_*）だけ。member_home を直接解析する別経路は無い | compat.js:78・233・278、boot.js:194、customer.js:19、slots.js:339、liff/index.html:746（関門①で訂正） |
| F2 | `readRemainDiag` は `{ value, status, month, version }` を返す。value は COMPARE_FIELDS を作るが、写しにある `transferCredits`・`reviewRequired`・`computedAt`・`stale`・`ageMs` は無く、D1 にしか無い `_src`・`_packOverUse` がある | remain-from-d1.js:183-197・339 |
| F3 | `reviewRequired`（GAS が「残数を出せない」と判断した印）は COMPARE_FIELDS に無い＝shadow の「食い違い0」はこの鍵について何も証明していない | LineBooking.js:652・655、remain-shadow.js:78 |
| F4 | shadow：10/19 起点 125回・食い違い0・41名（①値 ✅）。②配線は compat_home が未。照合は全員一致・重複パック0組 | 10/21・10/22 |
| F5 | `worker/**` を main に push すると migration → 公開まで自動。**push が公開の操作** | worker-deploy.yml |
| F6 | 検証用の会員 `CVERIFY0000001`（LINE 未連携・通知が飛ばない） | EdgeAudit.js:3073 |
| F7 | 書き込み直後の写し（home）と予約一覧の写しは、別々の送信。中央出口を通らない書き込みは予約一覧を送っていない | PushToEdge.js:964-965・`_lbDwMarkDirty` |
| F8 | `/quota/status` の coverageDetail はフルの会員 ID を返している | quota.js:451 |
| F9 | GAS の memberStatus には移行期の「オンボーディング中は残数を出さない」分岐がある（LB_ONBOARDING_MODE・LB_FACILITY_LIVE）。Worker の compat は**前から**常に onboarding:false で答えている＝今回の切り替えで新しく生じる穴ではない。いまこの分岐が無効かは**未確認**（段階1の前に作業依頼で確かめる） | LineBooking.js:622、compat.js:87 |

## 2. 変えること

### 2-1 写しを土台に、D1 で確かめた鍵だけを上書きする（readHome の1か所）
```
copy = いまどおり写しを読む（readHomeDiag）
if (mode !== 'on' || !選ばれた会員) return copy                       ← いまと同じ（remainSource も付けない）
if (!copy) return null                                               ← いまと同じ（GAS へ）
if (copy.reviewRequired === true) return mark(copy, 'copy:review')   ← ★GAS が出せないと言う会員は D1 でも出さない
d = readRemainDiag(env, cid, targetMs)   ※関数の外の例外も捕まえて 'read_failed'
if (d.status !== 'ok') return mark(copy, 'copy:' + d.status)
if (d.month !== copy.month) return mark(copy, 'copy:month_mismatch')
out = { ...copy }                                                    ← 写しの鍵は全部残る（transferCredits も）
for k of D1_OVERRIDE_FIELDS:                                         ← = COMPARE_FIELDS（shadow で食い違い0を確かめた鍵だけ）
   if (Object.prototype.hasOwnProperty.call(d.value, k)) out[k] = d.value[k]
   else delete out[k]                                                ← D1 に無い鍵は消す（両者の形をそろえる・undefined で上書きしない）
out.remainSource = 'd1'; out.remainBuiltAt = 世代の built_at
return out
```
- **D1 にしか無い `_src`・`_packOverUse` は顧客に出ない**（上書きする鍵を固定しているため）
- `computedAt`・`stale`・`ageMs`・`month` は写しのもの（readHomeSafe の「写しが40分より古ければ GAS」の判断は今のまま）。D1 を「写しが古いときの救済」には使わない＝範囲を絞る
- `remainSource` は mode 'on' のときだけ付ける（mode 'shadow' の応答は1文字も変えない）
- `readRemainDiag` の version の読み取りで `built_at` も読む（remainBuiltAt・調査用）

- ★選ばれているかの判定（許可表の読み取り）が失敗したら**選ばれていない**扱い＝写しを**そのまま**返す（remainSource も付けない＝応答の形を変えない）。理由は opts.diag にだけ入れる。例外を外に出さない（全入口が500になるのを防ぐ）。`/quota/status` が許可表を直接読み、読めなければ `read_failed` と出す
- `LB_D1_REMAIN_ALL` は文字列 `"1"` と厳密に一致するときだけ全員。それ以外（空・"true"・"01" 等）は全員扱いにしない

### 2-2 選ぶ会員は「許可表」で決める（★公開リポジトリに会員 ID を書かない・1名を保証する）
```
D1 の表 remain_d1_allow(customer_id PRIMARY KEY, added_at)        （migration 0021）
Worker  POST /quota/remain-allow   合言葉・本文 { action: 'add'|'remove'|'list', customerId? }
           list は下4桁と件数だけ返す
GAS     作業依頼 quotaBuild { d1Allow: '*4526' } / { d1Remove: '*4526' } / { d1AllowList: true }
           下4桁 → 名簿から会員を引く（**ちょうど1名のときだけ**。0名・2名以上は断る）→ Worker へは本文でフル ID を送る
```
- 公開の job.json に載るのは下4桁だけ（いまの調べものと同じ）
- **窓口の入力と出力（I40）**：POST 以外は 405／合言葉は既存の requireSecret（未設定は 503）／Content-Type は application/json だけ／本文は 4KiB まで／action は 'add'・'remove'・'list' の完全一致（それ以外は 400・書き込みなし）／本文の形は action ごとに固定：add＝`{ action, customerId: フルID }`・remove＝`{ action, customer: '*' + 下4桁 }`（`^\*[A-Za-z0-9]{4}$`）・list＝`{ action }`（customer・customerId があれば 400）／**add は customers 表に実在する会員だけ**（存在しない ID は 404・書き込みなし）／応答は `{ ok, action, customer: '*下4桁', changed }`・list は `{ ok, count, customers: ['*下4桁'…] }` だけ（契約月など他の情報を同じ要素に載せない）／例外・ログ・エラー応答にフル ID を出さない
- **外すとき**は Worker が**許可表の中で**下4桁を解決し、**判定と削除を1文で**行う（関門①4回目：数えてから消すと、その間に同じ下4桁が足されると別人を消せる）：
  ```
  DELETE FROM remain_d1_allow
   WHERE customer_id = (SELECT MAX(customer_id) FROM remain_d1_allow
                         WHERE substr(customer_id, -4) = ? HAVING COUNT(*) = 1)
  ```
  bind するのは先頭の `*` を除いた4文字。`changes === 1` → 200 ／ `changes === 0` → 読み直して 0件は 404・**1件は 409 RETRY**（消してはいない＝成功扱いにしない）・2件以上は 409 AMBIGUOUS ／ 読み直しに失敗したら 503。後から名簿に同じ下4桁の会員が増えても外せる
- 作業依頼の結果・失敗・GAS のログも固定の形（`ok / action / *下4桁 / changed`）。氏名・フル ID を出さない
- 検証用の会員は ID の**完全一致**（`=== 'CVERIFY0000001'`）で、mode 'on' なら常に選ぶ（前方一致にしない）
- 段階2（全員）は wrangler.toml の `LB_D1_REMAIN_ALL = "1"`（ID を書かない）
- **外すのは作業依頼1回**（d1Remove）。公開し直さずに、その会員を写しへ戻せる

### 2-3 試しに読ませる窓口（段階0）
- `POST /quota/remain-probe`（合言葉）本文 `{ customerId }`。**`CVERIFY0000001` 以外は断る**
- 本番と同じ `readHome` を**1回だけ**通し、そのときの判定を `opts.diag.result = { selected, source, status, monthMatch }`（固定の形・顧客のデータは入れない）で受け取る。D1 を2回読まない＝本番と同じ1回の判定を返す。振替権の数などは probe の窓口が最終の答えから固定の一覧だけ抜き出す
- 診断の値は**顧客への応答に混ぜない**（opts.diag を渡した呼び出しだけが受け取る・検査で固定）
- probe は数えない（入口の統計に混ぜない）
- 返すのは固定の一覧だけ：`remainSource`・D1 の status・`remaining`・`ticketRemaining`・`monthlyRemaining`・振替権の数・会員の下4桁
- 例外の文に ID を入れない（応答は code だけ）

### 2-4 数える（倒れたままを隠さない・書き込みに上限）
- 表 `remain_source_daily(day, entry, source, n)`（migration 0021）。**値の CHECK は付けない**（2026-10-15 の事故）。値の集合はコードの定数1か所＋検査
- **数えるのは選ばれた会員の読み取りだけ**（選ばれていない会員は数えない＝書き込みが増えない）
- 上限：**1日・入口ごとの合計で 500回まで**（関門①：理由ごとの行に `n < 500` を付けると、理由の種類数×500 になる）。1文で原子的に：
  ```
  INSERT INTO remain_source_daily (day, entry, source, n)
    SELECT ?, ?, ?, 1
     WHERE (SELECT COALESCE(SUM(n), 0) FROM remain_source_daily
             WHERE day = ? AND entry = ? AND source NOT LIKE '\_%' ESCAPE '\') < 500
  ON CONFLICT(day, entry, source) DO UPDATE SET n = n + 1
  ```
  （D1 は書き込みが1本ずつ＝この1文の中で数えて足すので超えない）
- 境界：500回目は数え、501回目で初めて `_dropped`。2つの理由で並んで499→500を争っても合計500（検査で固定）
- 上の文が1行も変えなかった（`meta.changes === 0`）ときだけ、`INSERT OR IGNORE ... (day, entry, '_dropped', 1)`＝**日×入口で最大1回の書き込み**
- 入口の名前は6つを定数で固定（compat_member / compat_home / booking_options / boot / customer_detail / route_booking_options）。名前の無い呼び出しは 'unknown' として数え、検査で0件を確かめる
- 書くのは応答の後（waitUntil）・例外を外に出さない
- `/quota/status` と日次点検に「昨日 D1 で答えた回数 / 写しに落ちた回数（理由別）」。**許可表に会員がいるのに d1 が0回**なら warn

### 2-5 予約一覧の写し（F7）
- `_lbDwMarkDirty` で、home に加えて**その会員の予約一覧の写し**も送る（中央出口とそろえる）
- **予約一覧の送信にも通し番号（dirtySeq）を載せる**（Worker は home と同じく reservations・partial でも受け付ける）。写しの送信が失敗しても、予約一覧の送信が届けば D1 は古いと知る
- ★**予約が0件の会員でも送る**（関門①3回目）。いまの `_edgePushReservationsFor` は0件なら送らずに「成功」と答える＝チケット追加・自己登録の直後に dirty が届かない。
  本文 `{ kind:'reservations', scope:'partial', customerId, dirtySeq, rows: [] }`。Worker は：reservations＋partial＋dirtySeq なら customerId 必須／rows があれば全行の customer_id が一致／rows が0件でも customerId に dirty を立てる／customers に実在しなければ断る／他の kind の「空の rows＋dirtySeq」は断る／dirty と行の書き込みは同じ batch
  GAS は HTTP の成功のときだけ「予約一覧を送れた」とする
- 送った結果は共通の関数で `{ home: 真偽, reservations: 真偽, bothFailed: 真偽 }` として持ち、`edgeAfterWrite` と `_lbDwMarkDirty` の**両方**で使う
- **これは短縮策であって、残数と予約一覧の世代の一致は保証しない**（関門①2回目で訂正）：
  - 正常時：いまも写しの残数と予約一覧は別の送信で、短い食い違い（残数は新・一覧は旧）は起きる。切り替えで増える食い違いは通常時には無いと**期待する**（後追い処理は最短1秒後・予約一覧の送信は同じ実行の数百ms。ただし順番は保証されない）
  - ★**新しく生じる組み合わせ**：写しと予約一覧の**両方の送信が失敗**し、後追い処理だけ成功すると、D1 の残数だけが新しく、写しと予約一覧は古い（いまは両方古い＝食い違いは無い）。Worker が古い予約一覧を返すのは、全体の同期時刻の TTL により最大およそ20分。その後は GAS に落ちる（compat.js:139）。**D1 と予約一覧が20分以内に必ず一致する保証ではない**（全体の同期が止まれば GAS に落ちるだけ）
- **段階1の見張りと止める条件**：
  - edgeAfterWrite と _lbDwMarkDirty の両方で「写しも予約一覧も送れなかった」ことを記録し、日次点検に出す（LB_EDGE_AFTER_WRITE_BOTH_FAIL）。記録は**会員ごと**に `{ 最初の時刻, 最後の時刻, 回数 }`（内部の鍵はフル ID＝同じ下4桁の別人を合算しない）。点検とログには下4桁だけ出す
    - 保存の規則（最大20名）：①書く前に「最後の時刻が24時間より前」の項目を除く ②既にいる会員は満杯でも必ず更新 ③新しい会員で満杯なら、最後の時刻が最も古い項目と入れ替え、`overflow` を1増やす（減らさない）④`overflow > 0` は日次点検で warn・段階1の間に出たら選ばれた会員の記録の有無にかかわらず当日確認 ⑤保存の失敗・壊れた値は「0件」とみなさず warn（LB_EDGE_AFTER_WRITE_BOTH_FAIL_BROKEN）
  - 段階1の間に1回でも起きたら、その日のうちに中身を見る。長く続く（同じ会員で20分超）なら d1Remove
- 予約一覧にも世代を持たせる案（関門①の案）は、**段階2（全員）の前に**、段階1の実測を根拠に改めて判断する（オーナーに諮る）

### 2-6 段階と止め方（push＝公開）
| 段 | 手順 | 承認 |
|---|---|---|
| 準備 | mode 'shadow' のまま push（migration 0021・新しい窓口・分岐。挙動は変わらない）→ 公開の成功と表の存在を status で確認 | 不要 |
| 0 | mode 'on'（許可表は空）を push → 公開を確認 → probe で検証用の会員が `d1` で答えること・書き込み直後に `copy:behind_write` になることを確かめる | 不要（実在の顧客に効かない） |
| 1 | 前提：オンボーディングが無効（`LB_ONBOARDING_MODE === "true" && LB_FACILITY_LIVE !== "true"` でない）ことを作業依頼で確かめる。有効なら進まない。→ 関門③ → **オーナー承認** → 作業依頼 d1Allow で**実在の会員1名**を足す | **要** |
| 2 | 数日見て問題が無ければ、関門③ → **オーナー承認** → `LB_D1_REMAIN_ALL=1` を push | **要** |

止め方（**影響範囲の小さい順**。実時間は 1 と 2 で逆転しうる）：
1. その会員だけ戻す：作業依頼 d1Remove（公開し直し不要・2〜3分）。★段階2（全員）では使えない
2. 全員を写しへ：mode を 'shadow' に戻して push（1〜2分で公開）
3. Worker の読み取り全体を GAS へ：`EDGE_READS` を off にして push（いまある停止策）
4. 公開の仕組みが動かないとき：Cloudflare の管理画面で Worker を1つ前の版へ戻す（**オーナー操作**。手順を runbook に書く）

## 3. 3(b)「D1 が答えないとき写しへ確実に落ちるか」をここで固定する
- **検査（本物の SQLite・入口から）で全部の理由**：6つの入口それぞれで、ok→d1 ／ behind・behind_write・not_built・no_version_row・out_of_range・row_count_*・coverage_missing・read_failed（表を壊す）・month_mismatch・reviewRequired→copy ／ 写しの行が無い→null（GAS） ／ 選ばれていない・mode shadow→いまと1文字も同じ
- 状態の表に `allow_read_failed`（許可表を壊す）→copy も入れる
- **本番（段階0の probe）で確かめるのは**：ok→d1、書き込み直後の behind_write→copy、許可表に無い→copy。それ以外の理由は本番では作らない（作るために本番のデータを壊さない）

## 4. 不変条件（MODEL §3 に足す）
| | 不変条件 | 守る検査（予定） |
|---|---|---|
| I35 | D1 で上書きするのは mode 'on'・選ばれた会員（許可表が読めた）・写しがある・reviewRequired でない・D1 が ok・月が一致、の全部のときだけ | `read-on.test.js`（6入口×状態の表） |
| I36 | 上書きするのは D1_OVERRIDE_FIELDS（= COMPARE_FIELDS）だけ。写しの他の鍵（transferCredits 等）は残る。`_src`・`_packOverUse` は出さない | `read-on.test.js`＋`home-fields.test.js` |
| I37 | mode 'shadow'・選ばれていない会員の応答は、変更前と1文字も同じ | `read-on.test.js`（変更前の readHome と比べる） |
| I38 | 会員の選び方に ID を公開の場所へ書かない（許可表は D1・作業依頼は下4桁・検証用は完全一致） | `read-on.test.js`（wrangler.toml・job.json に C+数字が無い） |
| I39 | 出どころは選ばれた会員だけ数え、1日・入口ごとの**合計**で500まで（_dropped は日×入口で最大1回）。許可表に会員がいるのに d1 が0回なら点検に出る | `read-on.test.js`・health |
| I40 | 許可表の窓口は入力を厳しく検査し、実在の会員だけ足す。応答・ログ・エラーは下4桁だけ。許可表が読めなければ「選ばれていない」 | `read-on.test.js` |

## 5. 壊れうるところ
| | 懸念 | 手当て |
|---|---|---|
| ① | D1 の値が写しと違う（shadow が見逃した形） | 段階1は1名。shadow は続ける。食い違いは即 d1Remove |
| ② | 写しにしか無い鍵が消える | 写しを土台に上書き（I36） |
| ③ | 応答が遅くなる・問い合わせ上限50 | 選ばれた会員だけ同期で D1 を読む（約5文）。入口ごとの最大の文の数を検査で固定 |
| ④ | 数える書き込みが D1 の1日10万の枠を食う | 選ばれた会員だけ・1日入口ごと500まで |
| ⑤ | 残数と予約一覧の食い違い | 2-5（両方の送信失敗で新しく生じる混在を見張り、段階2の前に予約一覧の世代を判断） |
| ⑥ | 個人情報 | 公開の場所に出るのは下4桁だけ。probe は検証用の会員だけ・固定の一覧。status の coverageDetail も下4桁に直す（F8） |
| ⑦ | push の取り違えで意図せず公開 | 各段は1つの push＝1つの変更。push の後に status で版と mode を確かめる |

## 6. 実装の順序
1. 検査を先に（read-on.test.js：6入口×状態の表・I37 の1文字比較・壊して落ちることを確かめる）
2. Worker：readHome の分岐・許可表と窓口（migration 0021）・probe・数える表・status（coverageDetail の下4桁も）
3. GAS：作業依頼の d1Allow/d1Remove/d1AllowList（下4桁→ちょうど1名）・_lbDwMarkDirty に予約一覧・点検の表示
4. 関門②→push（mode 'shadow' のまま）→ GAS 反映（オーナー）
5. 段階0 → 段階1（関門③・**承認**）

## 8. 検査に必ず入れるもの（関門①4回目の指定）
- 予約0件の送信：`rows:[]` でも dirty が立つ／空配列で予約の行を消さない／別会員の行が1件でもあれば dirty を含む batch 全体が書かれない／会員が実在しなければ何も書かれない／同じ番号の再送で dirty が下がらない
- BOTH_FAIL：写しだけ失敗・予約一覧だけ失敗では増えない／両方失敗のときだけ1増える／_lbDwMarkDirty の経路でも同じ
- 許可表の remove：0件 404・1件 200・2件 409（2件のときは消えない）・bind は `*` を除いた4文字
- BOTH_FAIL の保存：満杯でも既にいる会員は更新される／21人目で最も古い項目と入れ替わり overflow が増える／24時間より古い項目は除かれる／保存の失敗・壊れた値が黙って0件にならない／点検にフル ID が出ない
- 数える上限：500回目は数え、501回目で初めて _dropped／並行して499→500を争っても合計500

> 関門①：2026-10-22・5往復。第1版（PCT・D1 の答えをそのまま返す）→ 写しと形が違う・1名を保証できない・probe の ID が公開に出る。第2版 → 数える上限が理由の数だけ増える・失敗時に新しい混在が生じる・許可表が読めないとき未定義。第3版 → 予約0件で dirty が届かない・remove でフル ID を復元できない。第4版 → remove の数えてから消すが原子的でない。第5版 → 失敗の記録が満杯のときの規則が無い。第6版で反映。却下した指摘は無し
