# 67 数字の無い種目（実施のみ）にメモを持たせる

> 2026-11-26。オーナー指示：数字が無い種目（「実施した」だけ）のメモを社内メモに回している件、「これは種目として登録しておけばいい気がする」。CEO から CTO へ。設計66（種目のメモ→1セット目のメモ）の続き。設計66 では置く先のセットが無いため社内メモ `種目名：…` に回していた。

## 目的（1行）
数字の無い種目（doneOnly）のメモを、トレーニングログのその種目に付ける（社内メモの「種目名：…」に回さない）。

## 実物で確かめた事実
| # | 事実 | 確かめ方 |
|---|---|---|
| 1 | 数字の無い種目は `karte_tr_exercises.done_only = 1`・本セット0行。**この表にメモの列は無い**（session_id・ord・exercise・done_only だけ） | migration 0029 |
| 2 | `karte_tr_sets` は `weight_kg REAL NOT NULL CHECK (0〜500)`・`reps INTEGER NOT NULL CHECK (1〜100)`＝**重さ・回数が null のセットは入らない** | migration 0025 |
| 3 | Worker の受け取りは `normalizeTraining`（k_addTraining・k_editTraining・k_importDay の3経路が共有）。種目の鍵は `exercise・sets・doneOnly` だけ・知らない鍵は 400（SET_KEY）。doneOnly は sets:[] のときだけ | worker/src/routes/karte.js |
| 4 | 子の行は `trainingRows`（3経路で共有）。形の見張り `trShape` は batch の最後 | 同 |
| 5 | 読みは k_training の一覧（種目の並びの表を session の id で読む）。会員のカルテは `member-karte.js` が自分の SQL で `karte_tr_exercises` の決まった列だけを読む（I-M2・I-M3） | 同・lib/member-karte.js |
| 6 | 推移・自己ベスト・月ごとの1行は本セット（karte_tr_sets）と done_only から数える | karte.js 1934 行付近・画面の exerciseStats |

## 比べた手段
| 手段 | 集計への影響 | 変える面積 | 戻せるか | 採否 |
|---|---|---|---|---|
| (a) 重さ・回数 null のセットを1つ作り、そのセットのメモに | D1 の CHECK（事実2）で**入らない**。CHECK を外すと e1rm・推移・自己ベスト・会員の「実施のみ」・trShape（done_with_sets）が全部 null を扱う必要＝集計を汚す | 大（表の作り直し） | ✕ | ✕ |
| (b) 既にある列・形に入れる | 実施のみの種目にメモを持てる列は**無い**（事実1）。セットのメモは本セットにしか付かない | — | — | ✕（無い） |
| **(c) 種目のメモの表を足す `karte_tr_ex_notes (session_id, ord, note)`（数字の無い種目だけ）** | **無い**（集計は本セットと done_only だけを見る＝新しい表を読まない） | 中：migration 1本（CREATE IF NOT EXISTS）・normalizeTraining/trainingRows（3経路共有）・一覧の読み・画面 | 表は残るが読まなければ無害・revert で戻る | ◯ |
| (d) 今どおり社内メモ `種目名：…` | 無い | 0 | — | ✕ オーナーの指示に合わない |

**(c) を選ぶ。** 範囲は**数字の無い種目だけ**（数字のある種目は設計66 どおりセットのメモ＝同じ情報の置き場所を2つにしない）。

## 形
- migration `0039_karte_tr_ex_notes.sql`：
  ```sql
  CREATE TABLE IF NOT EXISTS karte_tr_ex_notes (
    session_id TEXT NOT NULL,
    ord        INTEGER NOT NULL CHECK (ord BETWEEN 1 AND 20),
    note       TEXT NOT NULL CHECK (length(note) BETWEEN 1 AND 200 AND note = trim(note)),
    PRIMARY KEY (session_id, ord),
    FOREIGN KEY (session_id, ord) REFERENCES karte_tr_exercises(session_id, ord)
  );
  ```
  ALTER しない（MODEL §8）。既定値なし。
- 要求：種目に `note`（文字列・前後の空白を落として1〜200字）。**`doneOnly: true` のときだけ**受ける（数字のある種目に付けたら 400 `EX_NOTE`）。文字列でなければ 400。空文字・空白だけは鍵が無いのと同じ（入れない・**新しい鍵と数えない**＝切替が閉じていても 409 にならない・ハッシュも鍵なしと同じ）。中身のある `note` は「新しい鍵」（trainingExtUsed＝受付の版 33 のときだけ）。ハッシュの元（trainingHashItems）には値があるときだけ載せる（古い要求の照合を変えない）。
- 書く：`trainingRows` で、その種目の `karte_tr_exercises` を入れた直後に `INSERT INTO karte_tr_ex_notes … SELECT … FROM karte_tr_exercises WHERE session_id=? AND ord=? AND done_only=1`。直後に見張り（その行が無ければ karte_guard＝batch 全体が戻る）＝数字のある種目には付かない・黙って落ちない。加えて **trShape に n_notes（数）・note_without_done_only（付き先）を足す**（関門① 中3）。k_editTraining は新しい session に付く（古い session の行は論理削除した回に残る＝前の版として残る、今のセットのメモと同じ）。
- 読む：k_training の一覧で、種目の並びと同じく生きた session の id を通して読み、`exercises[].note` に載せる（無ければ鍵を付けない）。**会員のカルテは読まない**（member-karte.js は触らない・I-M3 に「種目のメモ」を足す）。
- 画面の切替：k_training の応答に `exNote`＝**`trainingExtOn(env, who)`（受付の版 33 と同じ判定源・トレーナーごと）**（関門① 重大1）。画面は `cur.exNote` が真のときだけ送る・メモの欄を出す。偽なら今どおり（社内メモへ）＝Worker と画面の反映がずれても 400 にならない。

## 画面（同じ扱いにする経路）
| 経路 | 今 | 新しい |
|---|---|---|
| AI の下書き（reviewBuild） | 数字の無い種目の種目のメモ → 社内メモ `種目名：…` | その種目の `note`（200字を超える・`exNote` が無い → 今どおり社内メモ） |
| 読み取る（assemble の exnote・種目の下のメモ） | 同上 | 同上 |
| 手で入れる記録の画面 | 数字の無い種目にメモの欄は無い | 「✓ 実施した」の行の下にメモの欄（✎ と同じ1行の入力・200字・`placeholder`・健康の1行） |
| 数字の無い種目にセットを足した | — | 種目のメモを新しい1セット目のメモへ移す（数字のある種目は種目のメモを持たない＝黙って捨てない） |
| 直す画面（sessToItems） | 読まない | `exercises[].note` を種目の `note` に戻す |
| 日別の記録・前回 | 実施のみ | 実施のみの下にメモ（セットのメモと同じ小さな文字） |
| 前回の記録から写す | 実施のみの種目を写す（✓は外す） | 種目のメモは**写さない**（セットのメモも写さない＝その日の出来事） |
| 過去分の取り込み | 種目の下のメモを種目に付ける経路は無い（読めなかった行は社内メモの【読めなかった行】） | 変えない（payload は buildPayload を通るので note があれば送る） |

## 集計への影響
- 無い。推移・自己ベスト・月ごとの1行・e1rm・会員の画面は本セットと done_only だけを読み、新しい表を読まない。検査で、メモ付きの実施のみの種目があっても k_training の series・best・months が変わらないことを確かめる。

## 判定できないとき
- `exNote` が無い（古い Worker）→ 今どおり社内メモへ（捨てない）
- 見張りに当たる → batch 全体が戻り BAD_STATE（今の trShape と同じ）

## 戻し方
PR を revert。表は残る（データは残る）。★**ただし Worker を戻した後に［編集］で直すと、新しい版にメモが付かない**（古い版の行には残る・関門① 中4）＝戻すなら先に KARTE_TRAINING_EDIT を閉じる。閲覧は表示されなくなるだけ。

## 業務の規則として確かめたいこと
- 数字のある種目にも種目ごとのメモの欄（この表）を使うか（いまは設計66 どおり1セット目のメモ）。使うなら1か所に寄せる設計を別に。

## 個人情報（関門① 軽5）
種目のメモは社内のトレーニング記録で、セットのメモと同じ閲覧範囲（全トレーナー共有）・同じ保持（論理削除の回に残る）。健康情報の置き場所ではない（入力欄の真下に健康の1行・I55）。会員の応答・k_summary・AI の記録・karte_requests（ハッシュだけ）・karte_access_log・karte_revisions.before_json に本文を写さない。

## 関門①（Codex・read-only・2026-11-26）
| # | 重さ | 指摘 | 対処 |
|---|---|---|---|
| 1 | 重大 | `exNote: true` を固定で返すと、切替 OFF／allow 対象外のトレーナーで欄が出て保存が 409 | `exNote: trainingExtOn(env, who)`（受付の版と同じ判定源）。検査 N3-2・D2 |
| 2 | 中 | 空白だけの note を「鍵がある」で新しい鍵と数えると切替 OFF で 409 | trainingExtUsed は中身のある文字列だけ数える・文字列でなければ 400・空はハッシュも鍵なしと同じ。検査 N3-1・N3-4 |
| 3 | 中 | 直後の見張りだけでは余分なメモ行・付き先の誤りを trShape が見ない | TR_SHAPE_CONDS に n_notes・note_without_done_only。T16（設計67）・T16c で実際に当たることを確かめた |
| 4 | 中 | Worker を戻した後に直すと現行版からメモが消える | 戻し方に明記（KARTE_TRAINING_EDIT を先に閉じる）・MODEL I102 |
| 5 | 軽 | 個人情報の扱いの明文化 | 上の節・MODEL I-M3 に「種目のメモ」 |
| 6 | 軽 | 外部キーは複合の親を指す方が正確 | `FOREIGN KEY (session_id, ord) REFERENCES karte_tr_exercises` |

## 関門②（Codex・read-only・2026-11-26）
| # | 重さ | 指摘 | 対処 |
|---|---|---|---|
| 1 | 重大 | `exNote` が偽（allow から外した・切替を閉じた・Worker を戻した）のまま、メモのある記録を直すと、置き換えで現行版からメモが消える | 直す画面の保存で、`exNote` が偽かつ種目のメモがあれば送らずに「種目のメモがあるため、いまは直せません」。今日の記録は `uncheckedCount` に数える（保存前の確認で「消えます」と出る）。検査 D8 |
| 2 | 中 | 前回から写すで種目のメモが写らない | 仕様として写さない（セットのメモも写さない）を表に明記・検査 D9 |
| 3 | 軽 | 既存の検査 M25-2 が旧文言のまま | 新しい文言に直した |
