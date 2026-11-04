# 設計32 カルテの体の写真（2026-11-04・関門①通過＝改訂5。実装は改訂1〜5の新しい方を優先）

## なぜ
オーナー指示「体の写真も記録できるようにしたい」。経過を並べて比べる（ビフォーアフター）。

## オーナーの判断（2026-11-04・決定0127）
- 見られる人：**トレーナー全員**（メモ・体組成と同じ共有の範囲）
- 同意：**健康情報の同意（karte_consent kind='health'）に含める**。同意が agreed の会員だけ撮れる・見られる。撤回で写真も消す
- 保存先：**Cloudflare R2**（公開の URL を作らない）

## 前提（MODEL.md I46〜I56 を読んだ上で）
- 体の写真は最も重い個人情報として扱う。「健康情報と同じ守り」を下限にする
- k_ の入口の守り（役割の鮮度・Origin・トークン10分・停止スイッチ）はそのまま使う。本文16KBの上限は写真に合わないので、**写真の保存だけ別の上限**（例：2MB）を持つ

## データ
| 場所 | 中身 |
|---|---|
| R2 バケット（非公開） | 画像そのもの。鍵は推測できない乱数（`p/<UUID>.jpg`）。顧客ID・氏名・日付を鍵に入れない |
| D1 `karte_photos`（★改訂3で r2_key を外した。鍵は karte_photo_objects だけ） | photo_id（UUID）・customer_id・session_id（同じ撮影の3枚をまとめる UUID）・taken_date・pose（front/side/back）・bytes・width・height・uploaded_by・created_at・deleted_at・deleted_by ｜（★改訂5の後：消し終わったかは objects 表だけが持つ。写真の行に purge_state は置かない） |

## オーナーの求める使い方（2026-11-04 追記）
「初回の画像登録と、その後撮影をしたタイミングで、過去の画像と比較できるようにアップロードし、確認できる環境」
- **初回の登録**：体組成タブの「写真」で、正面・横・背面の3枚を1回の撮影として登録する（1枚だけでもよい）。最初の撮影を「基準」とする
- **2回目以降**：同じ画面で撮る。撮る画面に**前回の同じ向きの写真を薄く重ねて**、立ち位置と距離を合わせられるようにする（比べられる写真にするため）。重ねる写真は画面の中だけで、保存しない
- **比べる**：撮ったら、そのまま「基準（初回）と今回」を左右に並べて見せる。日付を選べば任意の2回を並べられる。向きごとに切り替え。並べた下に、それぞれの撮影日に一番近い体組成（体重・体脂肪率）の差
- **一覧**：撮影日ごとに縮小画像を並べる（日付・向き）
- トレーナーの片手の操作：撮る→確認→保存を3回のタップ以内。保存中は二重に送れない。失敗したら画像を端末に残して「もう一度送る」

## 流れ
- **撮る**：LIFF でカメラ／写真を選ぶ → 端末内で縮小（長辺1280px・JPEG 品質0.8）＝**再エンコードで位置情報などの EXIF を落とす** → `k_addPhoto`（本文は画像のバイト列＋最小のメタ・上限2MB）
  - Worker：入口の守り → 同意の確認（SQL）→ 画像の先頭バイトが JPEG であることを確かめる → R2 に put → D1 に1行（R2 が成功してから D1。D1 が失敗したら R2 を消す）
- **見る**：`k_photos`（一覧＝メタだけ・同意の JOIN）→ 画像は `k_photo`（photo_id を指定・同意の JOIN で行を確かめてから R2 を get して返す）。画面は blob の object URL で表示。**R2 の URL は画面に出さない**
- **比べる**：2枚を選んで並べる。撮影日に一番近い体組成の差も出す
- **消す**：本人（撮った人）かオーナー。D1 は deleted_at、R2 は同じ要求の中で delete（失敗したら purge_state=pending で日次に再試行）
- **撤回**：saveConsent の撤回の batch で、その会員の写真の行に deleted_at と purge_state='pending' を付ける（D1 は全部か無か）。R2 の削除は batch の外なので、**日次の掃除**（pending を消して done）で追いつく。読み取りは deleted_at と同意の JOIN で即座に止まる
- **退会後3年**：設計29（削除・匿名化）で写真も消す対象に入れる

## 害の列挙（関門③の先取り）
- 顧客の画面には出ない（k_ はトレーナーだけ）
- 写真が同意なしで見える経路：読み取りは毎回 同意 JOIN＋deleted_at。R2 は非公開（公開バケット・カスタムドメインを付けない）
- R2 に残り続ける：撤回・削除の pending を日次点検に出す（件数と最古の時刻）
- 端末に残る：LIFF は object URL を画面を閉じたら revoke。sessionStorage に入れない
- 位置情報の漏れ：端末で再エンコード（EXIF を落とす）。Worker でも JPEG の先頭だけ確かめる（EXIF の除去を Worker で保証はできない＝端末の再エンコードが前提。検査で固定）
- 容量：10GB の無料枠。1枚 200〜400KB として約3万枚。日次点検に合計の容量を出す

## オーナーにお願いすること
- Cloudflare の管理画面で R2 を有効にする（支払い方法の登録を含む）。バケットの作成と Worker への結び付けは、こちらの自動反映（worker-setup）で行えるか確認する

## 未確認
- R2 のバケットを wrangler（自動反映の権限）で作れるか。API トークンに R2 の権限があるか
- LIFF のブラウザでカメラの起動（input type=file capture）が動くか

---

# 改訂1（2026-11-04・関門①の指摘11点を受けて）
**ここから下が上の記述に優先する。** 上の「流れ」「データ」は改訂前の案として残す。

## A. 入口：認証の前に写真を読まない（指摘1）
2段にする。
1. **`k_photoBegin`**（今の JSON の入口・16KB・守りは全部そのまま）：役割・Origin・停止スイッチ・同意（guard と SQL の両方）を確かめ、`karte_photo_sessions` と写真の行を `uploading` で作り、**一回限りの受付券**を返す
   - 受付券：乱数32バイト。D1 にはハッシュだけ。有効5分・1回で使い切り・photo_id／発行したトレーナー／**同意の changed_at（版）**に結び付ける
2. **`POST /photo`**（別の道）：本文を読む前に、順に
   - Content-Length が必須・2,000,000 以下（欠け・不正・超過は拒否）
   - Origin が許可の1つと完全一致・KARTE 停止スイッチ
   - ヘッダ `X-Photo-Ticket` を D1 で照合（未使用・期限内・写真行が uploading）
   - ここまで通ってから本文を読む。読みながらバイト数を数え、上限を超えたら打ち切る
   - 本文は JPEG のバイト列そのまま（base64 にしない）
   - CORS の許可ヘッダに `X-Photo-Ticket` を足す

## B. サーバー側でも位置情報を残さない（指摘4）
Worker で JPEG のマーカーを最後まで読み、**作り直して**保存する。
- 残す：SOI・DQT・SOF0/SOF2・DHT・DRI・SOS とその画像データ・EOI
- 落とす：APP0〜APP15（EXIF・XMP・埋め込みの縮小画像・ICC を含む）・COM・EOI の後ろのデータ
- 拒否：SOI で始まらない・EOI が無い・知らないマーカー・幅か高さが 2000px を超える・画素数が 4,000,000 を超える
- 端末側：長辺1280px・品質0.8で作り直す。**作り直しに失敗したら元の画像は送らずに失敗させる**
- 検査：EXIF（位置情報入り）・XMP・埋め込み縮小画像・EOI の後ろに付けたデータの4種を、**人物の写っていない生成画像**で作り、保存物に1バイトも残らないことを確かめる

## C. 書く順番と後始末（指摘2・3）
1. `k_photoBegin`：D1 に写真の行を `uploading` で先に作る（同意つきの batch）。R2 の鍵は `p/<乱数>`（photo_id とも別の乱数）。D1 の行が鍵を持つので、R2 だけが残ることがない（★改訂3：鍵を持つのは objects 表だけ）
2. `/photo`：R2 に put
3. 確定：D1 の batch で `uploading → ready` と受付券の使用済みを一緒に。**UPDATE 文そのものに「同意が agreed かつ changed_at が受付券の版と一致」を入れる**（guard と文の両方＝I48）。0行なら R2 を消して pending へ
4. どこで止まっても行は `uploading` のまま残る → 掃除が1時間を過ぎた `uploading` を消す
5. 週1回、R2 の全部の鍵と D1 の鍵を突き合わせ、D1 に無い鍵を消す（鍵そのものはログに出さない・件数だけ）

**見る（`k_photo`）**：D1 で同意と deleted_at を JOIN → R2 から get → **もう一度 D1 で同意・deleted_at・版を確かめてから**返す。だめなら画像を返さない。応答は `Cache-Control: no-store`

## D. 掃除の実行役（指摘5）
- Worker の **cron**（wrangler.toml の `[triggers] crons`・1日1回）と `scheduled` の処理を新しく置く
- 1回に50件まで。行に `attempts`・`last_attempt_at`・`last_error_code`（中身は持たない）
- R2 の delete が成功したときだけ、条件つき UPDATE で `done`。404 は消えているので done、5xx・時間切れは pending のまま
- 退会後3年の削除（設計29）も同じ pending の経路に入れる
- 日次点検（remaining health）に、pending の件数・最古の時刻・合計のバイト数、`uploading` の残り、cron が最後に走った時刻を出す。pending が24時間を超えたら high

## E. 撮影の単位（指摘6・9）
- 親 `karte_photo_sessions`：session_id・customer_id・taken_date・status（draft/ready/deleted）・created_by・created_at
- 子 `karte_photos`：(session_id, pose) は UNIQUE。再送は同じ clientReqId・session_id・pose
- 「保存」で session を ready にする。一覧・基準・前回は **ready の session だけ**を見る
- **基準**：生きている ready の session のうち一番古いもの。消されたら次に古いものに移る（基準を別に持たない）
- **前回**：対象の撮影日より前で、taken_date の新しい順 → created_at の新しい順。同じ日の2回は別の session として混ぜない
- **並べる体組成**：撮影日と同じ日か、それより前の一番新しい測定。14日より古ければ出さない。同じ日に複数あれば created_at の新しいもの
- 片方にその向きの写真が無ければ「この向きは撮っていません」と出す
- 撤回のあと再び同意しても、前の写真は deleted のまま戻さない（検査で固定）
- 消せるのは session 単位と写真1枚単位の両方。撮った本人かオーナー

## F. 画面（指摘7・8・10）
- **撮る**：まず `getUserMedia` で LIFF の中にカメラの映像を出し、**前回の同じ向きを薄く重ねる**。LINE の中のブラウザで使えないときは、OS のカメラ（input capture）に切り替え、撮った後に前回と並べて位置を確かめる画面を出す（★実機で確かめる）
- 配置：体組成タブの一番上に「写真を撮る」「比べる」の大きいボタン
- タップ数：1枚につき「撮る」「使う」の2回。次の向きが自動で出る。3枚目のあとに「保存」1回（＝3枚で7回）。向きは飛ばせる
- 失敗した向きだけ送り直す。送れた向きは撮り直さない。応答が分からないときは同じ reqId で同じ写真を送る
- 写真は **localStorage にも sessionStorage にも入れない**。送り直しは同じ画面を開いている間だけ（再読み込みで消える＝そう画面に書く）
- object URL は画面ごとに集めて、描き直し・タブの切り替え・顧客の切り替え・閉じる・pagehide のたびに全部 revoke

## G. 個人情報（問題なしの点の明文化）
- ログ・エラーの detail に出さないもの：R2 の鍵・氏名・customer_id・画像のバイト列・受付券
- `ops/job.json`（公開リポジトリ）に顧客ID・R2 の鍵・写真を入れない。検査で固定
- 検査に使う画像は生成した無地や模様だけ。実在の人の写真は使わない

## H. 自動反映でできること／オーナーにお願いすること（指摘11）
- 私がやる：wrangler.toml に `[[r2_buckets]]`（binding KARTE_PHOTOS）と cron を足す（バケット名だけで結び付けられるので、反映の仕組みに ID を引く処理は要らない）。D1 の migration
- 私にできない：`.github/workflows` の変更（権限が無い）
- **オーナーにお願い**：
  1. Cloudflare で R2 を有効にする（支払い方法の登録）
  2. バケット `tokowaka-karte-photos` を作る（公開しない・カスタムドメインを付けない）
  3. GitHub の `CLOUDFLARE_API_TOKEN` に R2 の編集の権限を足す（足せない場合は反映が失敗して気づける）
  4. iPhone の LINE でカメラの許可と撮影の実機確認

---

# 改訂2（2026-11-04・関門①の2回目の指摘を受けて）
**改訂1の A・C・D・E と B の一部をこれで置き換える。** F・G・H はそのまま。

## A2. `/photo` も入口の守りを全部通す（指摘2）
- `/photo` は ID トークンを `Authorization: Bearer` で受け、**本文を読む前に**今の入口と同じ関数で 署名・iat 10分・役割の鮮度・trainer/owner を確かめる。さらに受付券を発行したトレーナーと同じ人であること
- 順番：Content-Length（必須・2,000,000以下）→ Origin → 停止スイッチ → ID トークン → 役割 → 受付券の確保（A3）→ 本文
- CORS の許可ヘッダに `Authorization` と `X-Photo-Ticket` と `X-Req-Id` を足す
- 受付券は「入口の守りを通った人に5分だけ渡す、写真1枚ぶんの許可」。I46 の代わりではなく上乗せ。MODEL.md に I60 として足す

## A3. 受付券の確保は1文で・同意もそこで確かめる（指摘1・3）
本文を読む前に、D1 の batch で次を一度に行う。
1. guard：同意が agreed かつ changed_at が受付券に固定した版と同じ（I48）
2. 条件つき UPDATE：受付券を `issued → claimed`。WHERE に「state='issued' かつ 期限内 かつ 同意の EXISTS（版も一致）」。**再送**は「state='claimed' かつ 同じ X-Req-Id かつ 前の確保から30秒以上」のときだけ取り直せる
3. 同じ batch で `karte_photo_objects` に1行（r2_key＝**確保のたびに新しい乱数**・state='writing'・claim_nonce）
- 変わった行が1でなければ本文を読まずに 409。並んで来た2本目は必ずここで落ちる

## C2. R2 の鍵は全部、put より前に D1 にある（指摘4）
`karte_photo_objects`（r2_key・photo_id・claim_nonce・state・attempts・next_attempt_at・last_error_code・created_at）
| 状態 | 意味 | 次 |
|---|---|---|
| writing | 確保した。put の前か途中 | 確定で live／失敗で purge_pending／2時間を過ぎたら掃除が purge_pending |
| live | 写真の行が指している唯一の実体 | 写真の削除・撤回で purge_pending |
| purge_pending | 消す | R2 の delete が成功（404 も含む）したら purge_done |
| purge_done | 消えた | — |
- 確定（1つの batch）：guard（同意・版）＋ 写真を `uploading → ready`（★改訂3で廃止：写真の行は鍵を持たない）＋ objects を `writing → live`（WHERE claim_nonce が自分）＋ 受付券を `claimed → used`。**どの文も同意の EXISTS と claim_nonce の一致を WHERE に持つ**
- 確定が0行（撤回された・他の確保に負けた）：自分の object を `purge_pending` にしてからすぐ delete を1回試す。delete が成功すれば purge_done
- **live は掃除も後始末も消さない**（UPDATE の WHERE に state IN ('writing','purge_pending') を必ず入れる）。古い要求が消せるのは自分の鍵だけで、自分の鍵は live になっていない
- D1 の更新がどこで失敗しても、objects の行は writing のまま残る → 掃除が拾う。delete を何度繰り返しても害はない

## B2. JPEG：画素は作り直さず、余計な区画を落として組み立て直す（指摘5・6）
- 言葉を直す：「作り直す」ではなく「**メタデータの区画を落として組み立て直す**」。画素のデコード・再エンコードは Worker ではしない
- 受け付けるのは端末の canvas が出す **baseline（SOF0）だけ**。SOF2（progressive）は拒否
- 区画の規則：各区画の長さは2以上で本文の中に収まる／SOF・SOS はちょうど1つ・順番は DQT・SOF0・DHT の後に SOS／DQT・DHT は1〜4個・中身が空でない／SOF0 の成分は1か3・幅と高さは1〜2000・画素は4,000,000以下／SOS の後は `FF00` と `FFD0〜FFD7` だけを許し、最初に現れる `FFD9` を終わりとする／EOI の後ろは捨てる
- 残すのは SOI・DQT・SOF0・DHT・DRI・SOS＋画像データ・EOI。APPn・COM は全部落とす
- 本文は1回だけ読み、出力は区画の位置を並べて1回で組み立てる（コピーは入力1・出力1まで）
- 途中で規則に合わない・時間がかかりすぎる・例外 → R2 に put しない。返すのは `BAD_IMAGE` だけ
- デコードできるかの確認は**端末側**で、保存の後に `k_photo` で取り直して画面に出せたことで確かめる。出せなければ画面に「表示できません・撮り直してください」
- 検査：EXIF・XMP・埋め込み縮小画像・EOI の後ろのデータ・progressive・長さの壊れた区画・途中で切れたファイル・SOS が2つ・FFD9 が画像データの途中に見える並び、を生成画像で作る。人物は使わない

## D2. 掃除は1時間ごと（指摘7・8）
- cron は **毎時**。同時に走らないよう D1 に lease（有効10分）を取ってから始める。取れなければ何もしない
- 対象：objects の purge_pending と、2時間を過ぎた writing。`next_attempt_at` の早い順。失敗したら attempts を足し、次は 5分→30分→2時間→6時間後（同じ行が先頭に居座らない）
- 1回の持ち時間は20秒。残ればそこで止めて次の時間に続ける
- 写真の行の `uploading` が2時間を過ぎたもの、session の draft が24時間を過ぎたものも同じ掃除で片づける
- 日次点検に出す：purge_pending の件数・最古、writing の2時間超の件数、cron が最後に走った時刻、1時間に増えた件数と消した件数。**purge_pending が6時間を超えたら high**、cron が3時間走っていなければ high
- **孤児の突き合わせ**（D1 に行の無い R2 の鍵）：鍵は put より前に必ず D1 にあるので、孤児が出るのは D1 の行が消えたときだけ。**月1回**、R2 の list をカーソルで1回1,000件ずつ（カーソルは D1 に保存）。D1 に無い鍵は `orphan_candidates` に記録するだけで、**次の月にもう一度無かったものだけ消す**。list か D1 のどちらかが途中で失敗した回は何も消さない。費用は3万枚で list 30回／月で無料枠の内

## E2. 撮影（session）の状態の動き（指摘9）
| 操作 | 条件（すべて WHERE に入れる） | 結果 |
|---|---|---|
| `k_photoBegin`（1枚目） | 同意・版 | session を draft で作る（created_by＝自分）・写真 uploading・受付券 issued |
| `k_photoBegin`（2枚目以降） | session が draft かつ customer_id が同じ かつ created_by が自分・同意・版 | 同じ session に写真を足す。同じ pose が uploading/ready ならその行を返す（再送） |
| 写真の確定 | C2 | 写真 ready |
| `k_photoSessionReady`（保存） | draft・created_by が自分・ready の写真が1枚以上・uploading が0枚・同意・版 | session ready。同じ reqId の再送は保存済みの結果を返す（I49） |
| 写真1枚の削除 | 撮った本人かオーナー | 写真 deleted・object purge_pending。session の ready 写真が0枚になったら session も deleted |
| session の削除 | 撮った本人かオーナー | session と写真を全部 deleted・objects を purge_pending（1つの batch） |
| 撤回 | saveConsent の撤回 batch | その会員の session・写真を全部 deleted、objects を purge_pending、未使用の受付券を revoked |
| 掃除 | draft が24時間・uploading が2時間 | deleted・purge_pending |
- session_id と photo_id は推測できない乱数。それでも他人の session に足せないのは WHERE の created_by と customer_id で止める

---

# 改訂3（2026-11-04・関門①の3回目の指摘を受けて）
改訂2の該当部分をこれで上書きする。

## 1・2. 「0行だった」は batch の最後の guard で全部巻き戻す
D1 の batch は、条件に合わず0行だったことを失敗にしない。だから**どの batch も最後に名前つきの guard を置き、期待した状態でなければ CHECK 違反を起こして batch 全体を巻き戻す**（今のカルテと同じ方式＝karte.js の G.*）。
- 受付券の確保：object の INSERT は `INSERT … SELECT … WHERE EXISTS(受付券が今回の claim_nonce で claimed)`。最後の guard `PHOTO_CLAIM`：受付券が claimed・req_id・claim_nonce・発行トレーナー・同意の版が今回の値、かつ今回の claim_nonce の object がちょうど1件
- 確定：最後の guard `PHOTO_COMMIT`：写真 ready・その写真の live object がちょうど1件で claim_nonce が今回・受付券 used で claim_nonce が今回・同意の版が一致
- guard 違反は「確定が0行」ではなく「batch が失敗した」として扱う → 自分の object を purge_pending にして delete を1回試す（C2 のとおり）

## 3. 鍵を持つのは objects 表だけにする（二重管理をやめる）
- `karte_photos` から r2_key を外す。**R2 の鍵は `karte_photo_objects` だけが持つ**
- 部分 UNIQUE 索引：`ON karte_photo_objects(photo_id) WHERE state='live'`（1枚に live は1つまで）。r2_key は主キー
- 読む（`k_photo`）：写真 ready ＋ session ready ＋ live object を JOIN ＋ 同意。どれか欠ければ画像を返さない
- MODEL.md に不変条件を足す（I60〜I63）：ready の写真は live object をちょうど1つ持つ／live object は ready の写真を指す／deleted の写真は live object を持たない／purge_done の鍵は R2 に無い
- 日次の整合検査（D1 の中）：上の4つの食い違いと、2時間を過ぎた writing の件数。1件でも high。自動で直さない（読み取りは JOIN で返さない側に倒れている）

## 4. 再送の取り直し
- 取り直しの条件：同じ req_id・**受付券の期限内**・前の確保から **2分以上**・取り直しは2回まで
- 同じ req_id の確保がすでに live／used なら、保存済みの成功を返す（R2 に書かない）
- 画面：送っている最中は「もう一度送る」を出さない。応答が返らず60秒たってから出す

## 5. 表示できない写真は保存にしない
- 写真に `display_verified_at` を持つ
- 画面は確定の後に `k_photo` で取り直し、`img.decode()` が成功したら `k_photoVerified`（同じトレーナー・同意・写真 ready が条件）
- `k_photoSessionReady` は「ready の写真が全部 verified」を条件に加える
- decode に失敗したら、その写真を deleted・object を purge_pending にして「この向きを撮り直してください」
- JPEG の規則の書き方を直す：SOS の後は FF 以外のバイトは自由。FF が来たら次は `00`・`D0〜D7`・`D9` のどれかだけ。`D9` で終わり

## 6. cron の lease と孤児の期間
- lease：行に token（乱数）と until。取るのは1文の条件つき UPSERT（until が過ぎているときだけ自分の token を書く）→ 読み直して自分の token なら実行。カーソル・最終実行時刻・解放はすべて `WHERE token=?`。落ちても10分で取り直せる。取れなかった回は最終成功時刻を更新しない
- 孤児の突き合わせは**週1回**。1回目は候補にするだけ、**24時間以上あけた次の回**でも D1 に無ければ消す（最長でおよそ8日）
- 候補が一度に20件または全体の1%を超えたら消さずに high（D1 側の事故を疑う）。migration の直後7日は消さない

## 8. 撤回の batch
- 表ごとに1文の集合 UPDATE（写真ごとに文を作らない）。objects にも customer_id を持ち、`(customer_id, state)` に索引
- 検査：写真200枚の会員で撤回の batch が通ること、batch が失敗したら同意も revoked にならないこと（本物の SQLite で）

---

# 改訂4（2026-11-04・関門①の4回目の指摘を受けて）

## 1. 保存前の確認は別の読み口にする（堂々巡りをなくす）
- 通常の `k_photo`：写真 ready・session ready・live object・同意（緩めない）
- 保存前の `k_photoCheck`：写真 ready・**session draft**・session の created_by が自分・live object・同意と版・入口の守り全部（ID トークン・役割・Origin）。`Cache-Control: no-store`
- `k_photoVerified`：同じ条件（created_by・同意の版・写真 ready・object live）で `display_verified_at` を付ける
- decode に失敗したとき：写真 deleted と object purge_pending を1つの batch でまとめ、最後に guard を置く

## 2. objects の customer_id は写真から写すだけ・撤回は写真から辿る
- object を作るときの customer_id は要求から取らない。`INSERT … SELECT` で写真（session）の customer_id を写す。作った後は変えない
- 撤回・session の削除の objects 更新は `WHERE photo_id IN (SELECT photo_id FROM karte_photos WHERE customer_id=?) AND state IN ('writing','live')`。objects.customer_id は検索と点検の補助で、消す対象を決める根拠にしない。purge_done を戻さない
- 不変条件に足す（I64）：object の customer_id は指している写真の customer_id と同じ。日次の整合検査で1件でも high

## 3. 孤児の期間を正しく書く
- R2 の全部の list は週1回。見つけたものは候補にする
- **候補だけは毎日**もう一度 D1 と R2 を確かめ、候補にしてから24時間以上たっても D1 に無ければ消す
- これで孤児が生まれてから消えるまで最長およそ8日（週1の発見まで7日＋確かめ直し1日）
- `purge_done なのに R2 に残っている` は D1 の中だけでは分からない → 週1の list のときに purge_done の鍵が R2 にあれば high（別の外部の検査として数える）

## 実装時の注意（関門①の Medium 以下）
- guard の名前 `PHOTO_CLAIM`・`PHOTO_COMMIT` は既存の guardOf() の既知の名前に加え、生の SQL・鍵・受付券を detail に出さない
- 取り直しは「最初の1回＋取り直し2回＝最大3回」

---

# 改訂5（2026-11-04・関門①の5回目の指摘を受けて）

## 1. 消す範囲は操作ごとに分ける（改訂4 の2を上書き）
| 操作 | objects を purge_pending にする条件 |
|---|---|
| 撤回 | `photo_id IN (SELECT photo_id FROM karte_photos WHERE customer_id=?) AND state IN ('writing','live')` |
| session の削除 | `photo_id IN (SELECT photo_id FROM karte_photos WHERE session_id=? AND customer_id=?) AND state IN ('writing','live')` |
| 写真1枚の削除 | `photo_id=? AND state IN ('writing','live')` |
- session の削除の batch の最後の guard：その session と写真が deleted、その session の object に live・writing が無い
- 検査：同じ会員に ready の session が2つあり、片方だけ消すと、もう片方の写真と object は ready・live のまま（本物の SQLite で）

## 2. `k_photoCheck` も二度確かめる
- 入口の守り：Origin・KARTE 停止スイッチ・ID トークンの署名と iat 10分・役割の鮮度・trainer/owner の許可表（A2 と同じ。I60 に紐付ける）
- D1 の1つの JOIN で：写真 ready・session draft・session の created_by が自分（**オーナーでも他人の draft は見られない**）・object live・同意 agreed と版・写真／session／object の customer_id が同じ
- R2 から get → **返す直前に同じ条件を D1 でもう一度**。1つでも変わっていれば画像を捨てて返さない
- draft の写真は `k_photos`（一覧）に出さない。photo_id を持つのは撮った人の保存の画面だけ
- `k_photoVerified` と decode に失敗したときの削除も、session draft・created_by・同意の版・写真 ready・object live を UPDATE 文と guard の両方で確かめる

## 3. 孤児の確かめ直し
- 毎日の確かめ直しで、D1 の照合・R2 の HEAD が失敗した・時間切れの回は消さず候補のまま。改訂3の「一度に20件または1%超は消さない」「migration の後7日は消さない」はそのまま
