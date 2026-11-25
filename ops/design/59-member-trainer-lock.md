# 設計59 会員の予約は担当トレーナーだけ（画面の段）

最終更新：2026-11-25（改訂2：関門③「不可」を受けて［公式LINEで相談する］と空きなしの週の強調を追加・CTO）

## 0. 1枚（現状・理想・差分）— 90_ops/playbooks/new-operation.md の型

### 1. 理想（TO-BE）— オーナーの言葉から
- 2026-11-25 オーナー要望（CEO 経由）：「会員が予約するとき、担当トレーナー以外を選べないようにし、担当のカレンダーだけを出す。どうしても予約が難しい場合のために『公式LINEのトークでご相談ください』というアナウンスを1つ置く（選択肢ではなく案内文でよい）」
- 成功の定義：担当のいる会員が「予約する」を押すと、迷わず担当の週の表に着く。担当以外で取りたい・日時が見つからない会員は、画面の案内で公式LINEに相談する（予約が取れずに離脱しない）。
- 測り方（閉ループ）：反映後2週間で ①担当のいる会員の予約のうち担当以外のトレーナーで取られた件数（会員自身が取ったもの・代行を除く）＝0 になっているか（台帳の取った人と担当の突き合わせ）②公式LINEへの「担当以外で／日時が合わない」相談の件数（トレーナーへの聞き取り）。→ CEO の ceo-backlog「確かめる」へ。

### 2. 現状（AS-IS）— 実物で確かめた事実
| 項目 | 事実 | 確かめた方法・日付 |
|---|---|---|
| 会員の予約の入口 | ホームの「予約する」(`homeReserve`) → `loadTrainers()` → `line_getTrainers` の全員を `renderTrainers()` で並べる。担当（`state.defaultTrainerId`）は先頭・「担当」の印つき。どれを押しても `loadSlots()` で週の表へ | `liff/index.html` loadTrainers/renderTrainers（1806〜1834行）2026-11-25 |
| 担当の出所 | 起動の応答 `defaultTrainerId`（GAS `line_getMemberStatus` 1060行＝名簿の担当列／Worker boot.js 247行＝`who.trainerId`）→ `renderHome` が `state.defaultTrainerId` に入れる | コード 2026-11-25 |
| トレーナーの一覧 | GAS `getTrainers`（5302行）・Worker `compatTrainers`：hidden（オーナー等）は除く。ただし**本人の担当なら hidden でも出す**。並びは名前順 | コード 2026-11-25 |
| 週の表の戻る | `backToTrainer`：トレーナーの代行・変更なら担当予約一覧へ、会員は `show('s-trainer')`（描き直さずに前の一覧を出す） | 3902行 |
| 週の表の「ホームに戻る」 | `weekHome` → `goHome()` → 会員は `loadHome()` | 4079〜4086行・4175行 |
| 代行 | `startProxyReservation` → `proxyMode=true`・`_fromTrainerAdmin=true` → `loadTrainers()`（同じトレーナー選びの画面を使い回す・担当を先頭に・他も選べる＝A03 の代行はトレーナーとオーナー） | 2537〜2547行 |
| 会員の変更・振替 | `startChange`／`startTransfer`：その予約のトレーナーで直接 `loadSlots()`（トレーナー選びを通らない） | 3504〜3516行・3717〜3725行 |
| トレーナーの変更 | `startTrainerChange` → その予約のトレーナーで `loadSlots()` | 2593〜2610行 |
| オーナー・トレーナー | 起動で `role==='trainer'` なら `renderTrainerAdmin`。会員のホーム（`homeReserve`）には入らない | 1772〜1780行 |
| サーバーの強制 | `line_getTrainerSlots`・`line_makeReservationLine` は会員がどのトレーナーを指定しても受け付ける（hidden は固定枠の追加だけ担当判定あり＝10941行付近） | コード 2026-11-25（予約の作成側で担当を見る判定は見当たらない＝未確認の残りは §5） |
| 業務の規則 | A80「担当トレーナーの希望は予約の備考に書いてもらう」・A03「代行予約はトレーナーとオーナー」 | `personal-training/ops/OPS-RULES.md` |

### 3. 差分 → 実行
| # | 作業 | 依存 | 担当 | 完了条件 |
|---|---|---|---|---|
| 1 | 担当がいて一覧に居る会員は、トレーナー選びを飛ばして担当の週の表へ直行 | — | CTO | jsdom 入口検査：ホーム→予約する→`s-week`・`line_getTrainerSlots` の trainerId が担当 |
| 2 | 週の表とトレーナー選び（担当なしの会員）に案内文（4言語） | — | CTO | 案内文が会員の素の予約でだけ見える・代行/変更/振替では出ない |
| 3 | 直行のときの「戻る」はホームへ（空のトレーナー選びを出さない） | 1 | CTO | 検査：`backToTrainer` → `s-home` |
| 4 | サーバーで担当以外を拒否（次の段） | 1 の運用確認 | CTO＋COO | §4 に設計だけ書く・今回は実装しない |

### 4. オーナーに決めてもらうこと
- なし（CEO 裁定のとおり）。次の段（サーバーで拒否）に進むかは、§3 #1 の効果確認の後に CEO が判断する。

### 5. 片づいた心配ごと
- オーナー・トレーナーは会員のホームを通らない（起動で分岐）＝今回の変更は届かない。

---

## 1. 方針（CEO 裁定）
- 担当がいて、トレーナー一覧（`line_getTrainers` の応答）に居る会員：トレーナー選びの画面を出さず、担当で直接 `loadSlots()`。
- 担当が未設定・一覧に居ない会員：今までどおり全員を並べる（悪化させない）。
- どちらの会員にも、案内文「担当以外のトレーナーでのご予約や、ご希望の日時が見つからない場合は、公式LINEのトークでご相談ください。」を出す。
- 代行（proxyMode）・トレーナーの変更（_fromTrainerAdmin）・会員の変更（changeMode）・振替（transferMode）・オーナー：今までの挙動を変えない（案内文も出さない）。
- 今回は画面だけ。GAS・Worker は触らない（反映は GitHub Pages の LIFF のみ＝オーナーの GAS 操作 0 回）。

## 2. 最小の手段の比較
| 案 | オーナー操作 | 戻せるか | 変える面積 | 結論 |
|---|---|---|---|---|
| A. 画面だけ：担当を直行・案内文 | 0（PR のマージ＝公開の承認のみ） | 戻せる（1コミット revert） | liff/index.html の1関数＋週の表の2行＋辞書4行 | **採用** |
| B. 一覧を担当1人だけにして選ばせる | 0 | 戻せる | 同程度 | 1タップ増えるだけで得が無い |
| C. サーバーで担当以外を拒否 | GAS 反映1回＋Worker | 戻せるが GAS 版を1本消費 | GAS/Worker の予約の入口・検査 | 次の段（§6） |

## 3. 画面の変更（liff/index.html）
### 3-1. loadTrainers の分岐
```
api(line_getTrainers) 成功 → state._trainersRes = res
  member = !state.proxyMode && !state._fromTrainerAdmin
  def = member ? String(state.defaultTrainerId||'') : ''
  hit = def ? res.trainers の中で String(id) === def の1件 : なし
  hit あり → state._weekFrom = 'lock'
             trainerId/trainerName = hit、weekOffset=0、カードの onclick と同じ初期化（changeMode/transferMode/excludeStartISO 等）
             loadSlots()
  hit なし → renderTrainers()（今のまま）
```
- 比較は `String()` どうし（今の renderTrainers は `===` で、型が違うと担当の印も外れる。直行の判定では型の違いで「一覧に居ない」と誤らない）。
- `line_getTrainers` の失敗は今のまま showError（担当で直行もしない＝判定できないときは今の経路の失敗のまま）。
- ★代行・トレーナーの入口（proxyMode・_fromTrainerAdmin）では直行しない。

### 3-2. 案内文
- 辞書に `lock_note`（ja/en/zh/zh-Hant）を足す。静的な要素 `data-i18n="lock_note"` を2か所：
  - `s-week`：`weekHint` の下に `<p id="weekLineNote" class="muted" hidden>`
  - `s-trainer`：`trainerList` の下に `<p id="trainerLineNote" class="muted" hidden>`
- 見せる条件は §3-6（正）。renderWeek と renderTrainers の中で `hidden` を決める（言語切替は applyI18n が文を差し替え・_repaint が hidden を決め直す）。
- 文は固定の文字列だけ（サーバーの値を混ぜない）＝個人情報は出ない。

### 3-3. 担当の名前（ステップ表示の整合）
- 直行のとき、週の表の上に「担当：〇〇」（既存の `cf_trainer_label` ＋ 名前）を `textContent` で出す（`<p id="weekTrainer" hidden>`）。ステップ1「トレーナー」は「済」のままで意味が合う。
- 直行でないとき（代行・変更・担当なし）は出さない（今のまま）。

### 3-4. 戻る（関門① 1回目の重1・中2を受けて改訂）
- ★週の表へ「どこから来たか」を `state._weekFrom` に持つ（`_trainerLocked` という真偽値はやめる＝古い値が他の入口の戻りを狂わせた）。週の表へ入る入口すべてで書く：
  | 入口 | `_weekFrom` |
  |---|---|
  | loadTrainers の直行（担当） | `'lock'` |
  | トレーナーのカード（renderTrainers の onclick・会員も代行も） | `'list'` |
  | 会員の変更 startChange | `'change'` |
  | 振替 startTransfer | `'transfer'` |
  | トレーナーの変更 _startTrainerChangeGo | `'admin'` |
- `backToTrainer`：まず今のとおりモードを消し、`_fromTrainerAdmin` なら今のまま担当予約一覧へ。会員は `_weekFrom` で分ける：
  - `'list'` → 今のまま `show('s-trainer')`（その一覧はこの入口で描いたもの）
  - `'change'` → 手元の予約の一覧 `state._myResRes` があれば `renderMyReservations()`（再通信しない・変更はまだ成立していないので一覧は正しい）、無ければ `loadHome()`。★`loadMyReservations()` は失敗すると戻るボタンの無い `s-error` に落ちる＝行き止まり（関門① 2回目 中）
  - それ以外（`'lock'`・`'transfer'`・空） → `loadHome()`
  - ★変更・振替の戻りが変わる理由：今は `s-trainer` を描き直さずに出すため、一度もトレーナー一覧を描いていない会員は**空のトレーナー選び**に落ちる（既存の行き止まり）。一覧が前に描かれていれば**担当以外のトレーナーを選んで素の予約へ進めてしまう**＝今回の目的の抜け道。だから会員の変更・振替は `s-trainer` に戻さない（Codex 関門① 重）。
- 戻るの読み上げ名（aria）：`'list'` とトレーナー（`_fromTrainerAdmin`）は今のまま「トレーナーを選び直す」、会員のそれ以外は「戻る」（`back`）。renderWeek で `data-i18n-aria` を書き換え、aria-label も入れ直す。
- `weekHome`（goHome→loadHome）・`toHome`・確認画面の戻る（`s-week`）は変えない。

### 3-4b. 読み込み中の言語切替（関門① 3回目 中）
- 今は `loadSlots()`・`loadTrainers()` の通信中も前の画面の `_repaint`（予約の一覧・ホーム）が残り、読み込み中に言語を切り替えると前の画面が描き直されて操作でき、その後で週の表が出る（既存の競合）。会員の変更の戻りで手元の一覧を描き直す（§3-4）ので、ここを塞ぐ。
- `loadSlots()` と `loadTrainers()` の始めで `state._repaint = null`。成功すれば今までどおり各画面が自分の `_repaint` を入れる。失敗は showError（今のまま）。
- 世代番号で古い応答を捨てる案は採らない：`refreshSlotsQuietly` も同じ `slotsGen` を進めるため、loadSlots の応答を捨てると読み込み中のまま止まる経路ができる。

### 3-5. 直行のときの初期化（カードの onclick と同じものを列挙で固定）
`trainerId`・`trainerName`・`weekOffset=0`・`changeMode=false`・`_ownerFreeResId=''`・`changeCustomerId=''`・`transferMode=false`・`excludeStartISO=''`（★残ると見えるはずの枠を除いてしまう）。`batchMode/batchSel` は loadSlots の成功で初期化される。

### 3-6. 案内文を見せる条件（改訂）
- 週の表：`!proxyMode && !_fromTrainerAdmin && (_weekFrom === 'lock' || _weekFrom === 'list')`。
- トレーナー選び：`!proxyMode && !_fromTrainerAdmin`（`s-trainer` に会員が入るのは素の予約の一覧だけになった）。

## 4. 何が起きたら顧客に害が出るか（自分で列挙）
1. 担当の週の表が出ない（担当の id の型違い・一覧に居ないのに直行）→ 予約できない。→ 一覧に居るときだけ直行・String 比較・検査で固定。
2. 担当なしの会員がトレーナーを選べなくなる → 検査「担当なし→全員」。
3. 代行で担当に固定され、トレーナーが他のトレーナーで代行できなくなる → 検査「代行→一覧」。
4. 戻るで空の画面に落ちて詰まる → 検査「直行→戻る→ホーム」「起動直後→変更→戻る→予約の一覧」「振替→戻る→ホーム」「直行→戻る→ホーム→変更→戻る→予約の一覧」。
5. 案内文がトレーナーの代行画面にも出て紛らわしい → 見せる条件で固定。
6. 担当の空きが無い月：一覧が全部「·」で、他を選ぶ手段が無い → 案内文が常に週の表に出ている（公式LINEで相談）。これは裁定どおりの仕様（担当以外は相談で受ける）。
8. 代行の担当の既定（`startProxyReservation` の `defaultTrainerId || state.defaultTrainerId`）が前の顧客の値を引き継ぐのは既存の挙動。今回は代行を変えない（直行はしない＝害なし）。検査では代行が一覧になることだけを固定する。
7. hidden（オーナー）が担当の会員：一覧に担当として出る（サーバーの既存の判定）＝オーナーの週の表に直行。今も先頭に出ているので取れる枠は同じ。

## 5. 個人情報
- 新しく出すのは担当の名前（既に確認画面・一覧に出ている）と固定の案内文だけ。送る値・記録・検査に会員の実名を入れない（検査の名前は架空）。

## 6. 次の段（今回は実装しない）：サーバーで担当以外を拒否
- **残リスク（今回の段の限界）：画面を飛ばすだけなので、会員が API（`line_getTrainerSlots`・`line_makeReservationLine`・`line_makeBatchReservation`）を直接叩けば担当以外の枠も取れる。** 普通の会員の操作では起きないが、強制ではない。
- 同じく残リスク：GAS 側の古い会員画面 `gas/LiffApp.html`（`doGet` の `?view=liff`・295行の旧版）は今回触らない（GAS の反映が要る）。いまの LIFF の入口は `liff/index.html`（GitHub Pages）なので普段の会員は通らないが、旧 URL を持っていれば全員が選べる。次の段でサーバーを強制すれば旧画面も一緒に塞がる。
- 設計の素案：会員の入口（代行・トレーナーの入口を除く）で、名簿の担当があり、かつ指定 trainerId が担当と違えば `TRAINER_NOT_ALLOWED` を返す。担当なし・名簿が読めないときは今のまま通す（業務を止めない側。§0 の「答えない」は読み取りの話で、予約の受付を止めると会員が取れなくなる）。振替・変更（その予約のトレーナーで取る）は「元の予約のトレーナー」も許す。まとめて予約は1件ずつ同じ判定。
- 着手の条件：今回の段の効果確認（§0-1 測り方①）で、担当以外の会員予約が 0 にならない（＝直接叩く・古い画面）ことが分かったとき、または CEO が強制を求めたとき。GAS の反映が1回要る。

## 7. 改訂2（関門③ 1回目「不可」→ CEO 裁定・2026-11-25）
- 指摘の主旨：案内が文字だけで、担当の空きが無い・休職/退職・非表示（オーナー）担当・担当のデータが古い会員が、自力で抜ける操作が無く詰む。サーバーで強制しないことは今回は受容（中）。
- CEO 裁定：「難しい場合は公式LINEに相談」を**実行できる形**にする。担当以外を選ばせる逃げ道は作らない。
  1. 案内文の下に［公式LINEで相談する］（`a.btn`・最小48px・4言語 `lock_line_btn`）。LINE の中（`liff.isInClient()` が真）なら既定の動きを止めて `liff.closeWindow()`＝トークへ戻す。外なら `href="https://lin.ee/U8oLJPT"`（`gas/コード.js` の `SETTINGS.LINE_URL` と同じ）を `target=_blank` で開く。`closeWindow` が例外なら同じ URL を `window.open`。
  2. 表示中の週に押せる枠（`#gridWrap .cell-open`）が0のとき、案内とボタンを週の表の上へ移し、枠つき（`.lock-strong`）で「この週はご予約いただける枠がありません。」（`lock_noslots`・4言語）を添える。週の移動は今のまま（先の週に空きがあれば取れる）。
  3. 会員の変更・振替の週の表にも、枠が0のときだけ同じ強調の案内とボタン（元の予約のトレーナーが休職等で詰む経路）。枠があれば今のまま出さない。
  4. 代行・トレーナーの変更には出さない。トレーナー選び（担当なしの会員）にもボタン（`trainerLineBtn`）。
- 判定は `renderWeek` の後（`_weekMemberParts`）で毎回。週の移動・言語切替（`_repaint`）でも決め直す。
- 個人情報：送る値は無い（固定の URL を開く・画面を閉じるだけ）。
- 残リスク：公式LINEのトークで相談を受けたトレーナー・オーナーが代行で取る運用が前提（COO に確かめる点）。
