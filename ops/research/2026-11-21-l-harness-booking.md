# L Harness（旧 LINE Harness）の予約機能の分析 — PT 予約システムとの比較

2026-11-21 ／ CEO玄 ／ オーナー依頼「Lハーネスの予約機能を分析。PT 予約システムのアップデートにつながる気がする」
出所：github.com/Shudesu/line-harness-oss（MIT・commit 66efa10 時点）のコードを読んだ（実行はしていない）。外部のコード＝手本として扱い、そのまま取り込まない。

## 事実（コードで確認）
- 構成：Cloudflare Worker（Hono）＋D1＋Pages（Next.js）。予約は3種：サロン型（menus/staff/staff_menus/staff_shifts/staff_availability_rules/bookings）・イベント予約（events/event_slots/event_bookings/event_booking_reminders）・Google Calendar 連携（freebusy で除外・確定で createEvent）
- サロン型：`computeSlots` は 30分刻みのます目（granularity 30・ceil で揃える）。所要＋後片付け（buffer_after_minutes）で占有。staff_menus で所要・料金をスタッフ別に上書き
- 予約は `requested` → 運営が PATCH で `confirmed`（承認制）。**お客様側のキャンセル・変更の API は無い**（/me は履歴のみ）
- 二重予約の防止：`INSERT … SELECT … WHERE NOT EXISTS (同一スタッフ・status IN requested/confirmed・starts_at < 新block_end AND block_ends_at > 新start)` の1文。changes=0 を slot_conflict(409)
- 確定直前に getAvailability を同じ日で再計算し、枠が一致しなければ 422
- 冪等：Idempotency-Key 必須。キャッシュは account＋friend の範囲（他人の応答を返さない）・TTL つき
- リマインダー：booking_reminders に1件ずつ（pending/sent/failed/failed_permanent/cancelled・retry_count・last_error）
- Google OAuth は calendar.events と calendar.events.freebusy に限定（広い calendar scope を取らない）
- 予約時に menu の auto_tag_id でタグ付け → シナリオ（ステップ配信）起動
- ブロック中の友だち（is_following=0）は予約不可

## PT との差
L Harness に無いもの：吸着方式の枠・即時確定・お客様のキャンセル/変更・契約/残数/チケット/月上限/振替・繰り返し予約・トレーナー画面・カルテ・サロンボード/請求連動
→ **PT の置き換えには使えない**（後退する）

## PT に取り入れる候補
| # | 内容 | 時期 |
|---|---|---|
| ① | 二重予約防止を1文の条件付き INSERT に（changes=0 で衝突） | 予約の真実を D1 に移すときの設計の手本 |
| ② | 確定直前の空き枠の再計算 | 現行の有無を確かめて揃える（未確認） |
| ③ | リマインダーを1件ずつ記録・失敗と諦めを残す | line-reminder-gas の失敗が見えにくい件の改善 |
| ④ | 予約をきっかけにタグ→ステップ配信（体験予約→来店前案内→来店後フォロー→入会の後押し） | **最有力**。来店→契約が未計測（unit-economics）なので計測とセットで |
| ⑤ | Google の許可を events＋freebusy に絞る | 現行スコープの見直し |

## 注意
- PT の公式 LINE の Webhook は予約システムが使用中＝L Harness を同じアカウントに入れると衝突（Webhook は1本）
- ④は顧客への配信＝文面と条件はオーナー承認（憲法§3）
