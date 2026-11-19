# 設計44 会員画面で「カルテの健康情報・写真」と「録音と AI の記録作成」への同意を求めて記録する（2026-11-13）

> 状態：**関門① 通過（4周・最終スレッド 01a1d4e9-face-7f41-b3fb-9ebc655dc497）・関門② 通過（2周）**。改訂2（関門① 1周目 重大2・高4・中3・低1 → 全部受け入れ・スレッド 01a1d4d7-be43-7010-935e-cb458c5b2563／2周目 重大0・高2・中4・低1 → 全部受け入れ・スレッド 01a1d4dc-40a0-73e2-a7db-c761d918066f／3周目 重大0・高2・中3・低1 → 全部受け入れ・スレッド 01a1d4df-a23b-7a63-90b2-65356fe39adb）。改訂3。オーナー決定 2026-11-13：同意は会員画面で求める（紙ではない）・健康情報も含めまとめて促す・
> 案A＝今の文面で同意画面を作り、オーナー（trainer_id A）のお客様で同意した人だけで AI 振り分けを使い始める。全トレーナーへ広げる前に弁護士へスポットで確認する。

## 関門②（2周目・スレッド 01a1d504-0941-75d1-8b82-2a30023a7889）＝通過（重大0・高0・中1）

| # | 指摘 | 対処 |
|---|---|---|
| 中 | 旧版に同意済みの録音・AI で「撤回」と同意のチェックが並び、状態も「同意済み」で意味が伝わらない | 状態を「以前の内容に同意済み（日付）。いまの内容への同意がまだです」にし、チェックの前に「いまの内容に同意し直す場合は…」を出す（4言語・liff-member-consent 6-7） |

## 関門②（1周目・スレッド 01a1d4ff-1db1-7740-8e6c-6eb88bdd2ebd）

| # | 指摘 | 対処 |
|---|---|---|
| 高 | 旧版の録音・AI の同意（current:false）では、画面の撤回ボタンが出ない（agreedNow の中にしか無い） | 撤回は `state==='agreed'` なら版に関係なく出す。current は「最新の版か・AI に使えるか」の表示だけ。full で旧版なら撤回と新しい版への同意の両方（liff-member-consent 6-6・6-7） |
| 中 | 回答を200件で切ると、会員の古い版の同意を紙（版なし）と取り違える | 健康情報の版は health・agreed の最新1行を専用の SQL で、現行の版に答えたかは kind ごとの SQL で引く。会員の記録なのに回答が無ければ最新とみなさない（member-consent D2-1〜D2-3） |
| 中 | 回数の守りの COUNT と書き込みが別 | 判定を書き込みと同じ batch の先頭の見張り（karte_consent_guard.crate・KARTE_GUARD_CRATE → 429）に移した（D13b：並行3送信で20行を超えない） |
| 低 | DOC_CHANGED の後に最新の文面を出さない | 読み直した後に1回だけ開き直す（6-8） |

## 改訂3（関門① 3周目）

| # | 指摘 | 変更 |
|---|---|---|
| 高1 | off では起動の印が偽＝本人が画面から撤回できない | **切替が閉じている（off・allow で対象外）とき、録音・AI に同意している本人にだけ**起動の印を真にし、画面は「同意の内容」の入口から**録音・AI の状態と撤回だけ**を出す（勧誘・新しい同意は出さない） |
| 高2 | 起動の印のための読み取りの失敗を「同意なし」に潰す | 印は `true`／`false`／`'unknown'`。読めなければ `'unknown'`＝画面は m_myConsent に聞き、そちらが決める（起動そのものは GAS へ落とさない＝予約の起動を同意の表に巻き込まない）。GAS の応答には印が無い＝出さない（GAS は表を知らない・既存の memberKarte と同じ） |
| 中1 | off でも全会員に文面と状態の API が開く | 切替が閉じているとき m_myConsent は、録音・AI に同意している本人にだけ rec_ai の文面と状態を返す（`mode:'revoke_only'`）。それ以外は 503 `MEMBER_CONSENT_OFF` |
| 中2 | 本人の rec_ai revoked に既存の同意の条件が無い | 同じ batch で「karte_consent_rec が agreed」を見張る（無ければ CONFLICT 409・何も書かない）。トレーナーの撤回も同じ見張り |
| 中3 | ALREADY と CONFLICT の矛盾・G.rev は rev 列用 | 応答は CONFLICT に統一。見張りは専用の `G.healthNotAgreed(cid)`（agreed があれば発火）と `G.recAgreed(cid)`（agreed が無ければ発火）。どちらも制約名 KARTE_GUARD_REV を使う |
| 低1 | kind の後方互換 | k_saveConsent の kind 省略＝health。許すのは health｜rec_ai。rec_ai は state='revoked' かつ method 省略/null だけ（それ以外 400） |

## 改訂2（関門① 2周目）

| # | 指摘 | 変更 |
|---|---|---|
| 高1 | health の旧版を CONSENT_VALID から外しても I48 の判定（state='agreed' だけ）で健康情報を読める・書ける | **健康情報の版は利用の関門にしない**と明記（I48 は今どおり state だけ）。版は「誰がどの版に答えたか」の記録と、新しい版への再回答のお願い（ask）にだけ使う。中身の変わる改訂で以前の同意の利用を止めるなら、その時に I48 の判定を変える別の設計にする（§3）。`CONSENT_VALID` は rec_ai だけに置く |
| 高2 | 切替 off・allow 対象外になると、同意済みの会員が録音・AI を撤回できない | (a) **m_saveConsent の rec_ai revoked は切替に関係なく受ける**（記録がある本人なら）。m_myConsent も切替に関係なく読める（ask は切替が開いているときだけ）。(b) 起動の印は「切替が開いている」または「allow で対象外だが録音・AI に同意している」（後者のときだけ PK で1行読む・off のときは読まない）。(c) **店頭の撤回の経路**：トレーナーが k_saveConsent に `kind:'rec_ai'` で **revoked だけ**記録できる（同意は記録できない）。MEMBER_CONSENT="off" は勧誘の停止で、撤回は店頭で受ける |
| 中3 | 「最新行」が一意でない | answers に `id INTEGER PRIMARY KEY AUTOINCREMENT`・最新は `ORDER BY at DESC, id DESC` |
| 中4 | 再送は何も書かないのに監査は書く | 「同意の状態・log・answers には書かない。access_log（監査）だけは書く」。回数の守りは answers の行だけを数える |
| 中5 | m_ の入口の負の検査が無い | §11 に足した（roles が古い→503・EDGE_READS=off でも FALLBACK にならない・Origin 欠落/不一致・共通 catch で message を出さない・許可表に customer だけ） |
| 中6 | 個人情報の表の矛盾（版）・読める人の過小記載 | §7 を直した（版を返さない・D1 は Worker の処理と Cloudflare の管理権限者が読める・回答の履歴は「健康情報を預ける意思・国外の AI の利用への意思」を表すので扱いに注意） |
| 低7 | ALREADY の画面の文・replay との順序 | トレーナーの agreed→agreed は**既存の見張り（KARTE_GUARD_REV＝CONFLICT 409）を batch の中で**使う＝runWrite の replay（同じ clientReqId）が先に効く。画面の文は既存の CONFLICT（「ほかの人が先に更新しました。画面を開き直して…」） |

## 改訂1（関門① 1周目）

| # | 指摘 | 変更 |
|---|---|---|
| 重大1 | ALTER を1ファイル1文にしても、ALTER の成功後に schema_migrations の記録だけ失敗すると次回 duplicate column で止まる（worker-deploy.yml:95-97） | **ALTER をやめる。migration は CREATE … IF NOT EXISTS だけ**（何度流しても同じ）。版の印は新しい表 `karte_consent_answers`（会員の回答の履歴）と `karte_consent_rec` に持つ。健康情報のいまの同意の版は「karte_consent.recorded_by='@member' のとき、その会員の health の agreed の回答の最新行」から引く（同じ batch で同じ時刻に書く） |
| 重大2 | c_ 接頭辞は rolesTooOld（index.js:304）と EDGE_READS（index.js:332）で 200 FALLBACK＝書き込みが GAS へ落ちうる・isKarteWrite は k_ だけ | 窓口名を **`m_myConsent`・`m_saveConsent`**（m_＝Worker だけの会員の窓口）。rolesTooOld は m_ を **503 ROLES_STALE**（FALLBACK にしない）・EDGE_READS は掛けない（GAS に対応が無い）。`m_saveConsent` に Origin の完全一致と iat 1時間を**明示の条件で**掛ける（isMemberWrite）。画面は専用の fetch（GAS へ送らない） |
| 高3 | 既存 k_saveConsent が会員の同意を紙で上書き・誤って撤回できる | **agreed の状態に agreed を記録すると 409 `ALREADY`**（会員の版つきの記録を紙で置き換えない）。撤回はトレーナーの唯一の経路として残す（店頭の申し出）が、確かめの文に「会員画面で同意した記録です」と出す（k_summary の byMember） |
| 高4 | 二重送信で履歴と時刻が重複する | **同じ状態・同じ版への再送は何も書かない**（agreed に agreed・revoked に revoked・この版に答え済みの declined）＝最初の時刻が残る。回数の守りは「書く予定の行を含めて直近10分で20行」 |
| 高5 | UI の判定は補助・撤回後の古い画面からの送信 | サーバーの判定だけが関門（4-4 のとおり）。「training を読んだ後に撤回 → 古い画面から送る」の検査を足す |
| 高6 | allow（担当で出す）と AI の許可（操作するトレーナー）は別の集合 | 明文化：**同意の有効性は担当に依らない**（お客様本人の同意）。allow の担当は「同意の画面を誰に出すか」だけ。AI を使えるかは KARTE_AI_DRAFT(_TRAINERS)＋その会員の同意 |
| 中7 | 「あとで」は毎回出る・紙／撤回は自動では出ない | オーナー指示の目安（閉じても次回また出す）どおり。§9 の3に「あとで」の頻度も足した |
| 中8 | 個人情報の一覧の不足・例外の message | §7 に保持と管理者を足した。m_ の窓口は全例外を固定コードに（index.js の共通の catch でも m_ は message を出さない）。recAgreed が読めなければ 0 でなく error |
| 中9 | 版・記録主体まで全トレーナーへ返す必要 | トレーナーへは state・日付・byMember（会員画面かどうか）だけ。版は返さない |
| 低10 | rec の表の CHECK・CHECK に入らない値の負の検査 | karte_consent_rec は state を agreed/revoked に CHECK。declined は回答の表にだけ。検査で全部の INSERT を本物の SQLite に通す |

## 0. 目的（1行）

会員が LIFF で2つの文面（どちらも任意・片方だけも可）に同意・撤回でき、**誰がいつどの版の文面に答えたか**が D1 に残り、
**AI 振り分け（k_aiDraft）はその会員の「録音・AI」の同意が有効なときだけ** Worker が通す。

## 1. 比べた手段

| 手段 | オーナー操作 | 戻せるか | 変える面積 | 判定 |
|---|---|---|---|---|
| A. 紙の同意書＋トレーナーが「同意を記録（紙）」 | 毎回（紙の管理） | ○ | 0（既にある） | ✗ オーナー決定で会員画面に。版の印も残らない |
| B. LINE の push で同意のページへ誘う | 送信の判断 | ✗（送った通知は消せない） | push の仕組み | ✗ 既定にしない（§6）。送信通数に数えられ、全員に一斉に届く＝しつこい |
| **C. 会員画面を開いたときに1回出す（閉じても次回また出す）＋ホームに「同意の内容」の入口** | 切替の push 1回 | ○（切替 off） | Worker 2窓口・表1つ・列2つ・画面1枚 | **採用** |
| D. Google フォーム | 0 | ○ | 正本が D1 の外に増える | ✗ 正本が2つになる・I48 の JOIN に乗らない |

## 2. 正本はどこか（二重の正本を作らない）

| 事実 | 正本 | 備考 |
|---|---|---|
| 健康情報（カルテ・写真）の同意の**いまの状態** | 既存の `karte_consent`（kind='health'） | I48 の JOIN・見張り（G.consent）がここを見る。**会員の同意も同じ行に書く**（method 'line'・recorded_by '@member'） |
| 録音・AI の同意の**いまの状態** | 新しい `karte_consent_rec`（1会員1行・doc_ver を持つ） | `karte_consent.kind` は CHECK (kind IN ('health')) で入れられない。CHECK は作り直せない（0018）＝新しい表 |
| 状態の変化の履歴（誰が・いつ） | 既存の `karte_consent_log`（全ての状態の変化・追記だけ） | 会員の変化も rec_ai の変化もここへ（kind・state に CHECK が無い） |
| 会員が会員画面で答えた内容と**版**（同意・今回は同意しない・撤回） | 新しい `karte_consent_answers`（追記だけ） | 「誰がどの版に答えたか」の正本。declined はここにだけある |
| 文面と版の印 | `worker/src/lib/consent-docs.js`。画面は Worker が返した文をそのまま描く | 画面に文を持たない |

- **migration は CREATE … IF NOT EXISTS だけ（0033）。ALTER しない**＝途中で止まっても、記録だけ失敗しても、次の実行で同じ結果（改訂1 重大1）。
- 健康情報のいまの同意の版：`karte_consent.recorded_by = '@member'` のときだけ、`karte_consent_answers` のその会員・health・agreed の最新行の doc_ver。トレーナーの記録（紙・LINE）は版なし。
- LINE のユーザーID・氏名は書かない（customer_id が鍵）。'@member' は trainer_id と重ならない（trainer_id は英数字）。

## 3. 文面と版

- `CONSENT_DOCS.health`（版 `health-2026-11-04`）＝ customer-karte/consent-draft.md「同意書に入れる文（案）」（写真の追加後）。
- `CONSENT_DOCS.rec_ai`（版 `rec_ai-2026-11-12`）＝ 同「2026-11-12 委託先が決まったので空欄を埋めた版」。
- **文は1字も変えない。** 太字の印（`**`）だけ画面の強調に置き換える。
- 版の印と文の SHA-256 を検査で固定する（`consent-docs.test.js`）＝**文を変えて版を上げ忘れると落ちる**。
- `CONSENT_VALID.rec_ai`：AI の関門で有効とみなす版の一覧（いまは現行の1つ）。文面を変えたとき、以前の同意を有効のまま残すか（軽い直し）無効にするか（中身の変更）をここで決める（業務の判断＝その時オーナー）。
- **健康情報の版は利用の関門にしない**（I48 は state だけ）。版は記録と、新しい版への再回答のお願い（ask）にだけ使う（改訂2 高1）。

## 4. Worker

### 4-1 切替（既定 off）
```
MEMBER_CONSENT          "off"（既定）／"allow"／"on"。厳密一致。それ以外は off
MEMBER_CONSENT_TRAINERS allow のとき：会員の担当（customers.default_trainer_id）がこの一覧に完全一致する会員だけ（trainer_id だけ）
```
- 起動の会員の状態（compat の memberStatus＝c_boot にも乗る）に `memberConsent: true/false`（cust は読んである＝D1 を増やさない）。
- 切替は**勧誘と新しい同意**にだけ効く（改訂2 高2・改訂3）：切替が閉じている（off・allow で対象外）とき、
  - m_myConsent：録音・AI に同意している本人には `mode:'revoke_only'`（rec_ai の文面・状態だけ・ask は空）。それ以外は 503 `MEMBER_CONSENT_OFF`
  - m_saveConsent：agreed・declined は 503 `MEMBER_CONSENT_OFF`。**rec_ai の revoked は受ける**（agreed の見張りつき）
- 起動の印 `memberConsent`：on → true／allow で対象 → true／それ以外 → karte_consent_rec に agreed の行があれば true・無ければ false・**読めなければ 'unknown'**（画面は m_myConsent に聞く）。起動そのものは同意の表の失敗で GAS へ落とさない。
- 撤回の経路は3つ：会員画面（常に）・店頭（トレーナーの k_saveConsent rec_ai revoked）・（健康情報は店頭だけ §9-1）。
- **同意の有効性は担当に依らない**（本人の同意）。allow の担当は「画面を誰に出すか」だけ（改訂1 高6）。

### 4-2 入口（index.js）
- 窓口名は `m_` 接頭辞（Worker だけの会員の窓口）。**FALLBACK を返さない**：rolesTooOld は 503 `ROLES_STALE`、EDGE_READS は掛けない。
- `m_saveConsent` は Origin の完全一致・ID トークンの iat 1時間（KARTE_LIMITS.TOKEN_MAX_AGE_S）を明示の条件で掛ける。
- 共通の catch は m_ の e.message を出さない（固定の文字）。窓口の中でも全例外を固定コードに。

### 4-3 m_myConsent（customer だけ・読み取り）
- 本人は who.customerId だけ。body を読まない（I-M1 と同じ）。
- 返す：`docs`（kind・ver・title・本文の段落・チェックの文）／`state`（kind ごと：state agreed|revoked|none・current（有効な版か。紙は true）・at・byMember）／`ask`（今回出す kind）。
- **ask の規則**：（state が none、または agreed で版が分かりかつ有効な版の一覧に無い）かつ 本人がこの版に答えていない（answers に kind・doc_ver=現行版 の行が無い）。
  revoked・紙の agreed は出さない（答えた人をしつこく誘わない）。
- 読めない → 503 `CONSENT_UNAVAILABLE`。画面は何も出さない。

### 4-4 m_saveConsent（customer だけ・書き込み）
- 本文：`{ answers: { health?: 'agreed'|'declined', rec_ai?: 'agreed'|'declined'|'revoked' }, vers: { <kind>: <版> } }`。知らない鍵・値は 400。answers が空は 400。answers の kind ごとに vers が要る。
- 版が現行と違う → 409 `DOC_CHANGED`（何も書かない）。
- 1つの batch（全部か無か）：
  - health agreed → karte_consent upsert（agreed・line・'@member'）＋ log ＋ answers
  - rec_ai agreed → karte_consent_rec upsert ＋ log ＋ answers
  - rec_ai revoked → 見張り G.recAgreed（agreed が無ければ CONFLICT・何も書かない）＋ karte_consent_rec を revoked に ＋ log ＋ answers
  - declined → **answers だけ**。**いまの状態を変えない**（同意済みの人が誤って外しても撤回にならない）
  - **health の revoked は会員画面から受けない（400）**（撤回は既存の決まりで健康情報を同じ batch で消す I48＝会員の操作で新しく走らせるかは §9-1）
- **再送は何も書かない**（改訂1 高4）：agreed に agreed（同じ版）・revoked に revoked・この版に答え済みの declined。最初の時刻が残る。
  ★health が紙で agreed のとき会員が agreed → 版つきの会員の記録に置き換える（書く）。
- 回数の守り：その会員の answers が直近10分で（書く予定を含め）20行を超えるなら 429（answers の行だけを数える）。
- 再送で何も書かないときも access_log（監査）だけは書く。
- 監査：karte_access_log に role='customer'・section='consent'・action='m_saveConsent'・result（中身なし）。
- 応答：保存後の state（4-3 と同じ形）。

### 4-5 AI 振り分けの関門（k_aiDraft・I76 に足す）
- canSeeKarteShared の後・1日の回数を数える**前**：`SELECT state, doc_ver FROM karte_consent_rec WHERE customer_id = ?`
  - agreed かつ doc_ver が `CONSENT_VALID.rec_ai` にある → 通す
  - それ以外 → **403 `NO_CONSENT`**（送らない・数えない）／例外 → **503 `AI_UNAVAILABLE` detail `CONSENT`**（送らない・数えない）
- karte_ai_log の result は CHECK で新しい値を入れられない＝この2つは karte_ai_log に書かず karte_access_log（'no_consent'／'error'・既存の CHECK にある）。
- 日次点検の材料に `noConsent`（前日の k_aiDraft の no_consent 件数）と `recAgreed`（有効な同意の会員の数・数だけ。読めなければ error）。GAS の表示は次の GAS 反映でまとめて。
- k_training に `aiConsent`（'agreed'|'none'|'unknown'・aiDraft が真のときだけ読む）。**画面の補助であり関門ではない**。

### 4-6 トレーナーの画面
- k_summary：`consent` に `byMember`、`recConsent`（state・changedAt・byMember）を足す。**版は返さない**（改訂1 中9）。
- 「契約・会員」末尾：「録音と AI の記録作成の同意」の行（表示だけ）。健康情報の行に「（会員画面）」。
- k_saveConsent（トレーナー）：kind 省略＝health。**health の agreed に agreed は CONFLICT 409**（見張り G.healthNotAgreed・batch の中＝replay が先）。撤回の確かめの文に、会員画面で同意した記録なら「会員画面でご本人が同意した記録です」を足す。
- トレーナーは録音・AI の同意を**記録できない**（§9-4）。**撤回だけ**記録できる（k_saveConsent `kind:'rec_ai'`・`state:'revoked'`・同意の行が agreed でなければ CONFLICT）＝店頭・セッション中の申し出の経路。

## 5. 会員の画面（liff/index.html）
- ホーム：`memberConsent` が true か 'unknown' のときだけ、起動ごとに1回 `m_myConsent` を Worker に聞く（GAS へ送らない・8秒で打ち切り・失敗は何も出さない）。
- ask が空でなければ**下から出る1枚**：ask の kind の文面（Worker の文を textContent で）と、kind ごとのチェック（初期値は外れたまま）・「送る」・「あとで」。
  - 「あとで」＝何も記録しない＝次に開いたときまた出る。
  - 「送る」＝チェックした kind は agreed、外した kind は declined（＝この版ではもう出さない）。
- ホームに「同意の内容（カルテ・録音）」の小さな入口（memberConsent のときだけ）：両方の文面・いまの状態・
  録音・AI が同意済みなら「撤回する」（確かめてから）・未同意なら同意のチェック。健康情報が同意済みなら「撤回は店舗へお申し出ください」。
- 4言語：ボタン・見出しは4言語。**文面は日本語だけ**（法的な文の翻訳は未決＝§9）。日本語以外の画面では「同意の文面は日本語です」を添える。
- タップ領域 44px 以上。チェックは行全体を押せる。

## 6. 通知の出し方（push と画面を比べた）

| | 画面を開いたとき（採用） | LINE の push |
|---|---|---|
| 費用 | 0（Worker の呼び出し1回・D1 の読み3本） | 送った人数だけ通数に数えられる（プランの無料枠・従量） |
| しつこさ | 開いた人にだけ・閉じても次回1回・答えたら出ない | 予約と関係のない通知が全員に届く・既読でも答えるとは限らない |
| 届く範囲 | 予約・残数を見に来る人（来店する会員はほぼ毎週開く） | 全員（来ない人にも） |
| 戻せるか | 切替 off で即止まる | 送った通知は消せない |

→ 既定は画面のみ。push は作らない。同意が集まらなければ、オーナー判断で「店頭でひとこと」か、別途 push を検討（§9）。

## 7. 個人情報（どこに出て誰が読めるか）

| 場所 | 中身 | 読める人 |
|---|---|---|
| karte_consent / karte_consent_rec | customer_id・状態・時刻・method・'@member' か trainer_id（rec は版の印も） | Worker の処理・Cloudflare/D1 の管理権限者。トレーナーの画面には状態・日付・会員画面かどうかだけ（共有の範囲＝トレーナー全員・業務上必要として受け入れる） |
| karte_consent_log | 状態の変化の履歴 | Worker の処理・D1 の管理権限者（応答に出さない） |
| karte_consent_answers | customer_id・kind・回答・版・時刻。★「健康情報を預ける意思・国外の AI の利用への意思」を表す | Worker の処理・D1 の管理権限者（応答に出さない） |
| karte_access_log | customer_id・role・section・action・結果（中身なし） | 運用 |
| 応答（会員） | 本人の状態と文面だけ | 本人 |
| 応答（トレーナー） | 状態・日付・会員画面かどうか（版は返さない） | 共有の範囲のトレーナー |
| 日次点検 | 件数だけ（customer_id を出さない） | オーナー |
| 公開リポジトリ・テスト | 架空の customer_id（C1 等）だけ | 誰でも |
| console | 固定の文字だけ（ID・状態を出さない） | 運用 |

- 出どころ（関門① 4周目 中5）：customer_id＝LINE の ID トークンから解決した本人と D1 の会員の写し（本人の窓口は body を使わない）／回答＝会員が LIFF で押したもの、またはトレーナーの撤回の記録／'@member'・trainer_id＝認証済みの本人／文面と版＝リポジトリの固定の文（会員由来ではない）。AI へ送る文字起こしの出どころと伏せ方は設計39（I76）のまま。
- 保持：D1（Cloudflare・管理はオーナーのアカウント）。同意の記録は退会後も「同意を得た証拠」として残す（期間は §9-8）。削除は手作業（窓口は作らない）。
- 文面には健康情報が無い・同意の記録自体は「健康情報を預けることに同意した」という事実だけ（中身は持たない）。

## 8. 倒れる向き（判定できないとき）

| 状況 | 出るもの |
|---|---|
| 切替 off／allow で対象外／GAS の応答／古い写し | 同意の画面も入口も出ない（今どおり） |
| m_myConsent が失敗・時間切れ | 何も出さない（次回また聞く） |
| 送信が失敗 | 「送れませんでした。もう一度押してください」（チェックは残す） |
| 版が変わった | 読み直して最新の文面を出す |
| 同意の表が読めない（k_aiDraft） | 送らない（503） |

## 9. 業務の規則（オーナーの答え 2026-11-16・実装済み＝ブランチ claude/consent-rules）
1. **会員画面からの健康情報の撤回 → 受ける。** I48 のとおり、その場で同じ batch で健康情報（karte_safety）を消す（再同意しても戻らない）。画面の確かめは2段（1段目に「その場で削除され、元に戻せません」・2段目に「本当に撤回しますか」）。メモ・トレーニング・体組成は消さない。同意の無い人の撤回は CONFLICT。
2. **紙（トレーナーの記録）で同意済みの会員にも、会員画面でもう一度聞く**（推奨と逆・オーナー決定）。state.health.current は「会員画面で現行の版に同意済み」だけを真にし、紙は viaStore で表す（I48 の利用の判定は state だけで変わらない）。
   - ★**CEO 裁定・オーナーに報告済み（2026-11-16）**：紙で同意済みの会員が会員画面で健康情報に「同意しない」（外したまま送る）と答えたときは、**自動で撤回しない・健康情報を消さない**（不可逆の操作を、画面のチェックの外し忘れで起こさない）。いまの状態は紙の同意のまま残し、答えは karte_consent_answers に declined として残す（同じ版ではもう聞かない）。トレーナーのカルテ（契約・会員タブの同意の行）に「会員画面では同意しなかった（紙は同意済み）」と出す（k_summary の consent.memberDeclined）＝止めずに見せる。本人が消したいときは 1 の撤回（2段の確かめ）から。勧める1枚の健康情報には「店頭でいただいた同意は、ここでチェックを外したまま送っても取り消されません」を添える。
3. **「あとで」は次に開くたびにまた出す・外したまま送った人には同じ版で出さない → 今のまま。**
4. **トレーナーが録音・AI の同意を代わりに記録 → 不可（今のまま）。** 撤回の記録だけ可。
5. **日本語以外の画面 → 当面は日本語の文面のまま注記**（mc_ja_only）。英語の文面は準備ができたら別の版として足す（今回は作らない）。
   - 足せる形か（確かめた結果）：回答と同意の記録は文面を版の文字列（doc_ver）で持つので、英語の文面を別の版（例 `rec_ai-2026-11-12-en`）として記録できる。AI の関門は版の一覧（CONSENT_VALID_REC）に英語の版を足せば同じ扱いになる。**足りないもの**：① consent-docs.js は kind ごとに1つの文面だけを持つ＝言語ごとの文面を持つ形への変更 ② m_myConsent が body.lang で文面を選ぶ ③ m_saveConsent の「版が現行と一致」の判定を「その kind の現行の版のどれか」に ④ ask の「この版に答えたか」を言語の違う版も同じ版として数える規則（オーナー判断）⑤ 版と SHA-256 の固定の検査に英語の版を足す。表（migration）の変更は要らない。
6. **録音・AI の撤回では、確認済みのカルテの記録を残す → 今のまま。** 検査で確かめた（member-consent K10：撤回の後もメモ・トレーニング・健康情報が残る）。
7. **対象は担当 A の会員（MEMBER_CONSENT="allow"・MEMBER_CONSENT_TRAINERS="A"）。保存期間はカルテと同じ3年。**
   - 3年が効いている場所（確かめた結果）：**文面**（健康情報の文「退会後、カルテは3年間保管し…」）と、**退会の記録**（karte_membership_events＝3年の起算日の正本・MODEL §2-3b）だけ。**3年を過ぎたら消す処理はどこにも無い**（Worker・GAS・作業依頼のいずれにも無い）。同意の記録（karte_consent・karte_consent_rec・karte_consent_log・karte_consent_answers・karte_access_log）にも保存期間の処理は無い。文面の約束を守るには、退会から3年を過ぎた会員の特定できる情報と同意の記録を消す処理が別に要る（未設計・ROADMAP の ⬜）。

### 関門②（2026-11-16・スレッド 01a1e3b3-4f3b-7103-9a3b-1da610082f8c）＝通過（重大0・高0・低1）
| # | 指摘 | 対処 |
|---|---|---|
| 低 | k_summary の memberDeclined を、回答の表が読めないときも false と答える | 読めなければ memberDeclined を付けない（undefined）・回答なしは false（member-consent K9b） |

### 切替が閉じているときの撤回（この変更で足した）
- revoke_only に出す kind：録音・AI に同意している／健康情報に**会員画面で**同意している（recorded_by '@member'）。起動の印もこの2つで真になる。
- **紙の同意だけの人には出さない**＝MEMBER_CONSENT="off" のまま、会員画面を見たことの無い人に入口を出さない（既定 off の約束）。その人の撤回は店頭（トレーナーの「撤回を記録」）。
- m_saveConsent は閉じているとき、revoke_only に出している kind の revoked だけ受ける。

## 10. 切り替え・戻し方
- push 時：MEMBER_CONSENT="off"＝会員には何も出ない。migration 0033 は空の表2つと索引（CREATE IF NOT EXISTS だけ）。
- k_aiDraft の同意の関門は**切替に関係なく常に効く**（KARTE_AI_DRAFT は今 off なので本番の挙動は変わらない）。
- 使い始め：MEMBER_CONSENT="allow"・MEMBER_CONSENT_TRAINERS="A" を push → オーナーのお客様が会員画面で同意 → KARTE_AI_DRAFT="allow"・KARTE_AI_DRAFT_TRAINERS="A"（I76-7 の decisions の記録の後）。
- 止める：MEMBER_CONSENT="off" を push。記録は残る（消さない）。
- GAS の反映：不要（Worker と liff/ だけ）。日次点検に新しい数を表示するなら次の GAS 反映でまとめて。

## 11. 検査（書いてから実装・壊して落ちることを確かめる）
- `worker/test/member-consent.test.js`（本物の SQLite＋全 migration・入口から）：
  切替（off／allow の一致・不一致・on）／ask の規則（none・紙・古い版・declined 済み・revoked）／版の不一致で何も書かない／
  declined は状態を変えない／health の revoked は 400／Origin・古い iat／customer 以外・body の customerId を無視／
  回数の守り／k_saveConsent（トレーナー）が doc_ver を NULL にする／access_log に中身が無い。
- 入口の負の検査：roles が古い→m_ は 503（FALLBACK でない）・EDGE_READS=off でも FALLBACK にならない・m_saveConsent の Origin 欠落/不一致は 403・iat が古いと 401・共通 catch で m_ の message を出さない・許可表は customer だけ。
- 切替が閉じていても rec_ai の revoked は通る・agreed/declined は 503・ask は空。トレーナーの rec_ai revoked（agreed でなければ CONFLICT・agreed は 400）。
- `karte-ai.test.js` に：同意なし・撤回・古い版は 403 で fetch を呼ばず回数を数えない／同意の表が読めなければ 503／同意ありは今どおり。
- `consent-docs.test.js`：版と SHA-256 の固定・文面に `［` `］`（空欄）が無い。
- `liff-member-consent.test.js`（jsdom・入口から）：memberConsent のときだけ聞く／ask の kind だけ出る／チェックの初期値は外れ／送る本文（answers・vers）／あとでは何も送らない／textContent（HTML を解釈しない）。
- `liff-karte` に：aiConsent が agreed でなければ AI のボタンが出ない・契約タブに録音・AI の行。

## 関門③（2026-11-19・Codex）
- 判定：本人の意図に反する削除・担当A以外への勧誘・未同意の同意記録・本人以外への露出・判定不能時の扱い、いずれも「起きない」（該当行で確認）。
- 指摘1：撤回の確かめと同意の文面は「写真も消す」と言うが、撤回が消すのは karte_safety だけ。→ 裏取り：写真の保存はまだ無い（設計32 未実装・R2 未結合）＝約束は空のまま守られている。将来の入れ忘れを `consent-photo-guard.test.js` で止める（写真の表／R2 が現れたら、撤回と掃除で消していなければ落ちる。壊して落ちることを確認）。
- 指摘2：切替オフでも、会員画面で健康情報に同意済みの本人は撤回できる（取り消し不能な削除）。→ 仕様どおり（I-CS5：同意した人が撤回できなくなるのを防ぐ）。本番で allow にしたことは無い＝該当者は0名。
