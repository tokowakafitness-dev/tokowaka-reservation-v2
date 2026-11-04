# 設計32 カルテの体の写真（2026-11-04・下書き・関門①前）

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
| D1 `karte_photos` | photo_id（UUID）・customer_id・taken_date・pose（front/side/back）・r2_key・bytes・width・height・uploaded_by・created_at・deleted_at・deleted_by・purge_state（none/pending/done） |

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
