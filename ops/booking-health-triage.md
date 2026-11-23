# 予約システム 点検項目の振り分け（保全部隊の手当表の元）
最終更新：2026-11-23（第3版：P1 の実装で足した見張り3つ・このリポジトリへ写した。第2版：A を 15→2 に絞った・P1 設計 関門①2回目。初版は`gas/LineBooking.js` の `dailyHealthCheck` の `add()` 76個を機械で抜き出して振り分け）

> ★**この表が正本**（会社側の同名の文書は案内だけ・CEO 裁定 2026-11-23）。`gas/LineBooking.js` の `LB_TRIAGE` と1対1（`worker/test/self-heal-triage.test.js` が機械で突き合わせる・I-H10）。
> 　どちらかを変えたら両方を同じ変更で直す。表に無い key は B として扱う（段は add した時の段）。
> 　P1 では A→B も B と同じく直さない（「1回だけ点検をやり直す」は P1 の範囲外）。

> 構想＝`booking-self-healing.md`・`90_ops/operations/maintenance-squad.md`。個人情報の線＝決定0198。
> **区分**　A＝GAS が AI なしで直す／A→B＝まず1回やり直し、続けば CEO／B＝CEO（部隊）が判断／C＝オーナー／記録＝案件にしない（info）
> **名前**　●＝いまの詳細に氏名が入る（確認済み）／○＝入る見込み（未確認）／空欄＝入らない
> ★A の条件：何度やっても同じ結果・顧客に何も届かない・元に戻せる。**「仕組みを元の状態に戻す」は A、「取りこぼした分を送る・消す」は B か C。**

## A　GAS が自分で直す（2）
P1 設計（`design-self-heal-P1.md` 第5版・関門①4回目で条件付き実装可）で、本当に安全なものだけに絞った（2026-11-23）。
| key | 手当て | 備考 |
|---|---|---|
| trigger_missing | 足りない処理名のトリガーを**1本だけ足す**専用関数（消さない・足した後18本以下） | 既存の setup* は消してから作る＝途中で落ちると悪化するので使わない |
| cancel_notes_unready | `setupCancelNotesSheet`（冪等・空のシートなら見出しを書き直す・データ行があれば触らず mismatch） | 回復は `_lbCnHealth().ready` で判定 |

## B へ移したもの（第1版では A だった13）
| key | 理由 |
|---|---|
| trigger_dup | どれを残すかの判断と、一回限りの正常な重複の見分けが要る |
| sync_stale / sync_never | `dailySync` は予約の行を書く（顧客の状態に触る）。トリガーが消えた場合は trigger_missing で戻る |
| gen_behind_stuck / gen_write_behind / gen_behind_no_time / gen_write_behind_no_time | `lbDwEnsureQueued` に渡す会員番号の出どころが無い |
| reminder_stale・notify_retry_stalled・pace_fail・shadow_sweep_stale / shadow_sweep_expired / shadow_sweep_short | 手当ての関数の副作用が未確認。確かめて A に上げるのは P1 の後 |

## A→B　点検そのものが失敗した（14）
1回だけ点検をやり直す。続けて失敗したらコードの不具合として B。
datahealth_fail・orphan_fail・metrics_fail・notify_retry_read_fail・consec_read_fail・shadow_sweep_read_fail・trigger_check_fail・pending_payment_check_fail・dualwrite_check_fail・calslots_check_fail・karte_ai_check_fail・contract_input_check_fail・cancel_notes_check_fail・d1_allow_unreadable

## B　部隊が判断する・名前は要らない（25）
| key | 何を見るか |
|---|---|
| booking_error | 予約の内部失敗の理由別件数 |
| notify_fail | LINE 未達の理由別（HTTP の番号） |
| notify_retry_pending / notify_queue_write_fail | 送り直しが詰まっていないか |
| nudge_lock_miss / nudge_open_miss | 声かけの取りこぼし |
| consec_display_miss | 連続ルールの表示の食い違い |
| register_fail | 会員登録の失敗の理由別（理由だけ・名前なし） |
| cancel_notes_save_fail / cancel_notes_purge_late | 保存の失敗／古い記録の削除の遅れ（削除は戻せない＝A にしない） |
| both_fail / both_fail_broken / both_fail_overflow | 写しも予約一覧も送れなかった（会員番号で見る） |
| d1_read_none / dualwrite_too_large / dup_pack_prefix / edge_push_off | D1 の配線・容量（edge_push_off は意図して止めている場合がある） |
| gen_behind_capacity / shadow_diff / shadow_idle / shadow_incomplete / shadow_sweep_state_broken | D1 と写しの照合 |
| trigger_near_limit / trigger_create_fail / job_lock_miss | トリガーの上限・作成失敗・ロック待ち |

## B　部隊が判断する・いまは名前が入っている（8）→ GAS で「違いの種類」と会員番号に替えてから渡す
| key | 名前 | 替え方 |
|---|---|---|
| member_broken | ● | 会員番号＋「契約データのどこが不備か」（期限・種別・残数の欄） |
| resv_dup_ev / resv_dup_slot | ● | 会員番号＋行番号＋日時 |
| resv_unlinked | ● | 名前の「違いの種類」（旧字体・空白・かな/漢字・名が違う・契約に無い） |
| cal_missing / cal_orphan / cal_missing_tr / cal_orphan_tr | ○ | 予定の ID＋日時＋担当。予定名（顧客名が入る）は渡さない |

予定を作る・消す・予約の行を直すは顧客の残数と枠に直結＝**修理は B のまま**。実績を積んでも A に上げるのは関門③を通してから。

## C　オーナー（6）
| key | 届け方 | 理由 |
|---|---|---|
| quota_exhausted | **即時** | 通知が全部止まる。プラン変更＝お金 |
| notify_alert_unsent | **即時**（メール以外の経路で） | オーナーへの警告が届いていない |
| pending_payment_overage_urgent | **即時** | 支払い待ちの期限が3日以内 |
| pending_payment_overage / pending_payment_unknown | 1日1回 | 請求・入金 |
| quota_near | 1日1回 | 先にプランを考える時間がある |

## 記録だけ（info・案件にしない）（8）
cal_manual・cancel_notify_slow・consec_counts・d1_read_served・gen_behind・member_nocontract（●）・resv_future・transfer_seen

## P1 で足した key（3）
| key | 区分 | 何を見るか |
|---|---|---|
| health_skipped | B | 点検・修理が重なって見送られた（借りる印・design-self-heal-P1 §2-1）。オーナーへのメールにも載る |
| selfheal_stale | B | lbSelfHeal が26時間以上完走していない（モード off 以外）。オーナーへのメールにも載る |
| selfheal_practice_long | 記録 | 練習モードが14日を超えた |

## 数え（79）
A 2 ＋ B へ移した 13 ＋ A→B 14 ＋ B 25 ＋ B（名前）8 ＋ C 6 ＋ 記録 8 ＝ **76**（抜き出した74 key ＋ `_ppKey` の2種）。
＋ P1 で足した 3 ＝ **79**。
子の点検（calslots・karte_ai・contract_input）が出す細かい項目は未分類＝P1 で足す。

## 未確認
- カレンダー系の詳細に顧客名が入るか（○）。予定名に顧客名が入るので入る見込み
- 各 A の手当て関数を「顧客に何も届かない」ことの検査で固定する（P1 の検査）
