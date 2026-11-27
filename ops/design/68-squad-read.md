# 68 保全部隊が予約システムの要約を無人で読む口（2026-11-27）

> 上位の設計（会社リポジトリ・非公開）：`90_ops/operations/maintenance-squad-read-endpoint.md`（関門① Codex 5回で通過・会社の決定0208）。
> ここは予約リポジトリで実装した範囲の要約と、関門②の記録。顧客の画面・予約・残数・通知には触れない（オーナーへの通知だけ）。

## 目的（1行）
無人の保全部隊（オーナーの Mac で毎時起きる台本＋点検役の Claude）が、オーナーの操作なしで、氏名を含まない予約システムの状態を毎回読める。古い・確かめられないときは「答えない（stale）」。

## 比べた手段（上位の設計 §2）
A. GAS が Worker へ送り、Worker の読む窓口で読む（★採用）／B. GAS の Web アプリに読む口／C. 作業依頼の流用。
A だけが「GAS が止まった」を Worker 側で答えられ、鍵の検査を顧客の入口と別の場所に閉じ込められ、戻すのが Worker の1行。

## 作ったもの
| 場所 | 中身 |
|---|---|
| `worker/migrations/0040_squad.sql` | `squad_digest`（要約・心拍を1種類1行）・`squad_reads`（読んだ回数・1日1行）・`squad_report`（部隊の報告・最新1件） |
| `worker/src/lib/squad-schema.js` | 許可リスト（受ける・返す・Mac の再構築器が同じ定義を使う）・重複キーを拒否する JSON の読み取り |
| `worker/src/routes/squad.js` | `POST /squad/digest`（GAS・合言葉）・`GET /squad/status`（部隊の鍵）・`POST /squad/report`（部隊の鍵・SQUAD_REPORT=on）・`POST /squad/report/ack`（GAS）・`?squad=1` の材料 |
| `worker/src/routes/quota.js` | `/quota/status?squad=1`（部隊が最後に読んだ時刻） |
| `worker/src/routes/jobs.js` | （別件）`/jobs/<id>` は鍵の形を D1 より前に見る＝鍵の無い要求は 403 で D1 を引かない（以前は状態だけ返していた） |
| `gas/LineBooking.js` | `_lbHealStatusRead`（読み取りを1か所に）・`lbHealStatusObject`（部隊への要約）・送る2か所（日次点検と修理の完走の印の後）・見張りの段「保全部隊の見張り」（squad_quiet＝C・squad_check_fail＝AB） |
| `gas/PushToEdge.js` | `lbSquadSend`・`lbSquadBeat`（pushToEdgeLight の最後・1時間に1回）・部隊の報告の配達（固定の文で LINE・失敗はメール・ack） |
| `worker/wrangler.toml` | `SQUAD_READ_KEY_SHA256`・`_NEXT`（空＝閉じたまま）・`SQUAD_REPORT`（コメント＝未設定＝閉じたまま） |

不変条件：MODEL.md I-SQ1〜I-SQ9（検査 `squad-read.test.js`・`gas-squad.test.js`）。

## 判定できないとき
- 部隊へ：state=stale／none で中身を出さない（理由だけ）
- 日次点検：Worker の応答の形が違えば squad_check_fail（段を閉じない）。鍵の欄が空・off・一度も読まれていないは squad_quiet にしない

## 戻し方
1. `SQUAD_READ = "off"`（PR 1本）：/squad/* が全部 503・D1 に触れない。GAS は 503 を数えるだけ（顧客に影響なし）
2. 鍵だけ失効：ハッシュの欄を空に
3. 報告だけ止める：`SQUAD_REPORT` を消す
4. GAS の送信を外す：次のまとめた反映で（急がない）
5. 表を消す：migration で DROP（最後でよい）

## 上位の設計から変えたところ（実装で決めたこと）
- 報告（④）を足した：`/squad/report`・`squad_report`・心拍の応答で渡す・`/squad/report/ack`。上位の設計 I-SQ2 の「読む鍵では書けない」を「部隊の鍵で書けるのは squad_reads の加算と、SQUAD_REPORT=on のときの squad_report（列挙と件数だけ）」に広げる＝**CEO の守りの判断**。既定は閉じたまま（SQUAD_REPORT 未設定で 503・D1 に触れない）
- 外枠に `report_state`・`report_id` を足した（上位の設計 §3-3-1 の表に無い欄）
- 返す本文が 65,536 を超えたときの `digest_too_large` は数えず console.error と 500 だけ（列を足さない）
- 送信の失敗の数は CacheService（6時間で消える）。止まったかの正は Worker の受け取り時刻
- 未知の欄（GAS が先に足した欄）は Worker が受けるときは無視・Mac の再構築器は全体拒否

## 関門②（Codex・read-only・スレッド 01a21b7e）
| 指摘 | 対処 |
|---|---|
| 中1 報告を渡した瞬間に印を付ける＝応答が届かない・配達の前に落ちると永久に失われる（at-most-once） | ack が無いまま2時間たてば渡し直す（hand_n・3回まで）。GAS は報告の番号を CacheService に覚え、渡し直された同じ番号は送らずに ack だけ（I-SQ9・検査 I-SQ9-13a〜c・G3-6） |
| 中2 Mac の台本が手動と launchd で重なると一時ファイル・応答・上限の数えが競合する | 会社側：mkdir の印で台本全体を1本に（30分より古い印は取り直す）。検査 S-16・S-17 |
| 軽1 ack の失敗を見ていない | 応答の番号を見て、200・409 以外は send_fail に数える（G3-7） |
| 軽2 /jobs/<id> の案内リンクが鍵なしで 403 になる | `ops/workflows/edge-job.yml` の案内を「鍵のヘッダつきで読む」に直した。★取り付け済みの `.github/workflows/edge-job.yml` はオーナーが写す（CLAUDE.md §4 で私は変えない）。読むのは CEO の道具（鍵つき）だけで、ブラウザで開く運用は無い |
| 参考 点検役の AI が会社リポジトリ全体を Read できる（道具の制限の実機の振る舞いは未確認） | CEO の守りの判断へ（会社側の報告に記載）。初回の手動実行で確かめる |

## 関門② 再審（Codex・スレッド 01a21b84）
| 指摘 | 対処 |
|---|---|
| 中 送る前に 'failed' を覚えると、送る前に落ちた報告が渡し直しで送られず失われる／キャッシュが使えないと二重 | 送る前は 'sending'。渡し直しで 'sending' が残っていれば LINE ではなくメールで送る（I-H15 と同じ型）。結果が覚えてあれば ack だけ。何も覚えていなければもう一度送る＝**取りこぼしより二重に倒す**（G3-6b・G3-6c） |
| 中 古い印の取り直しが2本同時に古いと見たとき排他が破れる（会社側） | 取り直しを mv（rename は原子的）→ mkdir。放すのは印の中の PID が自分のときだけ（S-18・S-19） |
| 軽 ack の 409 をまとめて成功扱い | Worker は同じ番号で既に ack 済みなら 200（already）、古い番号・未渡しは 409。GAS は 200 以外を数える（I-SQ9-9・9b） |
