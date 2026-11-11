# 設計42 カレンダーが変わったら、空き枠をすぐ押し出す（反映 最大10分 → 最大5分＋α）

> 2026-11-11 オーナー指示「シフトの反映を5分に」。版の印 2026-11-11a（GAS）。
> 改訂4（関門① 3周の指摘を反映した完成形。旧記述は残さない）。
> 改訂4の要点：予算の「予約→精算」をやめ、**送り終えた実測の合計だけで判定する**。予約という状態を持たないので、精算しそこねた予約で予算が詰まる経路が構造的に無くなる。代わりに、同時に走った1〜2回ぶん予算を超え得ることを許容し、点検で見る。

## 目的（1行）
カレンダーのシフトを直してから会員の予約画面に出るまでを、「最大10分」から「最大5分＋約30秒」へ縮める。GAS の実行時間は、変更があった回の分だけ、1日の予算の範囲で増やす。

## 現状（実測 2026-11-11 15:34・作業依頼 slotsFresh）
- 空き枠（②`slots_cache`）を作って送るのは `pushToEdgeSlots`（10分ごとのトリガー）。
  - 1回 24.5秒（作り直し 5.5秒／ロック待ちと送信 19秒）。ロックは最大90秒待つので、最悪は約115秒。
  - ロックの見送りは累計57回。
- カレンダー → D1 の同期 `lbCalSyncTick` は5分ごとに走る。予約の書き込みの直後（`_lbCalSyncAfterWrite`）にも走る。
  - Worker の応答は `mode: 'unchanged' | 'patched' | 'published'`（calsync.js:386/433/483）。
  - 拒否は HTTP 422 なので、pushCalSync は `ok:false` を返す。
  - 同じ中身なら必ず `unchanged` になる（calsync.js:377-386。地平・規則版・1F・カレンダー構成・owner window まで比べる）。
- 会員の画面が読む空き枠は②だけ。`SLOTS_FROM_CALENDAR` は未設定。

## 比べた手段
| 手段 | 反映 | 増える GAS 実行時間 | 判定 |
|---|---|---|---|
| A. `pushToEdgeSlots` を5分ごとに | 最大5分 | 常に +144回/日 × 24.5秒 ≒ +59分/日 | ✗ 無料アカウントの実行枠（上限90分/日・setupCalSyncTrigger の注記）を常に圧迫する。超えると通知・同期が全部止まる |
| B. `SLOTS_FROM_CALENDAR="on"` | 最大5分 | 0 | ✗ 今は不可。①は連続ルール（設計18）を実装していない。calendar から返した枠は compat.js:455-458 で `consecPick` を素通りするので、規則に反する枠が会員に出る。規則の移植と7日間の突き合わせが要る（別の設計） |
| **C. 同期が patched/published を返したときだけ、同じ実行の後ろで `pushToEdgeSlots` を呼ぶ** | 最大5分＋約30秒（書き込み直後は約30秒） | 変更があった回だけ。**1日30分の目標予算で止める** | ◎ 採用 |

C は新しいトリガーを作らない。トリガーはいま18本で、上限は20本。1回限りのトリガーを増やすと、予約直後の同期や登録後の同期が上限に当たり得る。

## 変えるもの

### 導入の条件
- Web アプリ（`executeAs: USER_DEPLOYING`・appsscript.json:5）のデプロイと、`setupCalSyncTrigger()` の実行は**同じ Google アカウント**（tokowaka.fitness@gmail.com）で行う。
  予約直後の1回限りのトリガーはデプロイしたユーザーの実行として作られ、5分ごとのトリガーは setupCalSyncTrigger を実行したユーザーのものになる。同期の直列化（既存の `getUserLock`）は、この2つが同じユーザーであることを前提にしている。
- **コードで確かめる（関門②で方式を替えた）**：GAS の `ScriptApp.getProjectTriggers()` は「いまのユーザーのトリガー」だけを返す。予約直後の実行から `lbCalSyncTick` のトリガーが見えれば同じユーザー。見えなければ `TICK_NOT_VISIBLE`（別のユーザー・付け直しの最中・トリガーの消失を区別しない）、読めなければ `USER_UNKNOWN` を記録し、**押し出さない**（10分ごとが拾う・点検が high で鳴る）。
  メールのハッシュを使う案は、oauthScopes に `userinfo.email` が無く `getEmail()` が空になり得る（照合が黙って無効になる）ためやめた。新しい権限は要らない。

### gas/PushToEdge.js
1. **`lbCalSyncTick()`**（引数なしのまま。トリガーのイベント引数を受けない）
   ```
   r = _lbCalSyncCore()        // 今の中身（ユーザーロック → pushCalSync → _calsyncNote）
   _lbCalSlotsWired()          // 配線の印 LB_CALSLOTS_WIRED = LB_HEALTH_BUILD の版|時刻（毎回）
   _lbCalSlotsAfter(r)         // ロックの外
   return r
   ```
2. **`_lbCalSyncAfterWrite`**：`_lbCalSyncCore()` → `lbDualWriteDrain` → `_lbCleanCalSyncAfterTriggers` → `_lbCalSlotsAfter(r)` の順にする。
   - 二重書きの速い道とトリガーの枠を、押し出し（25〜115秒）より先に済ませる。
   - `_lbCleanCalSyncAfterTriggers` は同じ名前のトリガーを全部消す。core と drain のあいだに予約された1本も消え得る（既存のふるまい）。その場合は5分ごとの同期が拾う。
3. **`_lbCalSlotsAfter(r)`**
   - 呼ぶ条件：`r.ok && r.result && (r.result.mode === 'patched' || r.result.mode === 'published')`。知らない mode なら呼ばない。
   - `LB_CALSLOTS_ON === '0'` なら何もしない。
   - 当日（JST）の記録を、ユーザーロック（`tryLock(3000)`）の中で読む。読めない（JSON が壊れている）ときは、**同じロックの中で**、壊れた記録を `LB_CALSLOTS_COUNT_BAD` へ移して `{}` に作り直し、`LB_CALSLOTS_RECORD_ERROR = 時刻|BAD_JSON` を書く。**この回は押し出さない。**
     ロックが取れなければ、作り直さずに `LB_CALSLOTS_COUNT_LOST` を書き、この回は押し出さない（10分ごとの押し出しが拾う）。
   - `usedMs ≧ 1800000`（目標予算30分）なら `capped` を数えて押し出さない。
   - それ以外は `changed` を数える。呼ぶ直前に `LB_CALSLOTS_LAST_START = 時刻` を書き、`t0 → res = pushToEdgeSlots() → ms`。終わったら `LB_CALSLOTS_LAST` を書く。開始の時刻が `LAST` より新しいまま残っていれば、「始めたまま終わらなかった」（GAS の強制終了）と分かる。
   - 結果を分類（下の表）し、`usedMs += ms` と分類の件数を数える。`ms > 115000` なら `slow` を数える。
   - `LB_CALSLOTS_LAST = 時刻|分類|ms` を書く。固定のコードだけで、例外の全文や応答本文は残さない。
   - 例外は外へ出さない。
   - **件数の書き込み**は、読む→足す→書くを `getUserLock().tryLock(3000)` の中で行う。
     最初の読み（予算の判定）でロックが取れなければ、予算を判定できないので**押し出さない**。押し出した後の件数の書き込みでロックが取れなければ、件数を書かずに `LB_CALSLOTS_COUNT_LOST = 時刻` を上書きする（件数が欠けた印。成功しても消さない。24時間で点検の対象から外れる）。済んだ押し出しは巻き戻さない。
   - 記録は、日の行がオブジェクトで、すべての値が有限の0以上の数値であるときだけ正しいとみなす（関門②：`usedMs:"broken"` が NaN になって予算の判定が黙って偽になるのを防ぐ）。違えば壊れた記録として扱う。
4. **`pushToEdgeSlots`** は結果を返す。ロック見送り（`_edgeLocked` が `undefined`）なら `'LOCK_SKIP'`。
   **`_pushToEdgeSlotsImpl`** は `_edgeSendSlots` の戻り値を返し、例外のときは `'ERROR'` を返す。
   既存の呼び出し元（LineBooking.js 3912/3922）は戻り値を使っていない。
5. `buildCalSyncPayload` の `pushedAt` のコメントを「読み始めた時刻」に直す（中身は変えない）。

### 結果の分類（固定の表。ここに無い値は error）
| `pushToEdgeSlots` の戻り値 | 分類 |
|---|---|
| 数値（送った件数。0 も含む） | sent |
| `'LOCK_SKIP'` | lockSkip |
| `'STALE_SNAPSHOT'`（もっと新しい枠を送り済み） | stale（害なし） |
| `'UNKNOWN_SNAPSHOT'`・`'RECORD_FAILED'`・`'ERROR'`・その他・例外 | error |

### 記録の形
`LB_CALSLOTS_COUNT` は日付をキーにした JSON。直近3日だけ残す。
```
{ "2026-11-11": { changed, sent, lockSkip, stale, error, capped, slow, usedMs }, "2026-11-10": {...} }
```
日次点検（6:30）は、JST で明示的に**昨日のキー**を読む。0時〜6:30 に当日の記録が始まっても、昨日の値は消えない。
日付の生成と3日より古いキーの削除は、どちらも `Utilities.formatDate(…, 'Asia/Tokyo', 'yyyy-MM-dd')` で行う（検査で固定）。

### gas/EdgeAudit.js（`slotsFreshnessText`）
- `LB_CALSLOTS_LAST`、今日と昨日の内訳、`LB_CALSLOTS_WIRED` を出す。
- 「何分で反映されるか」の説明を直す。

### gas/LineBooking.js（`dailyHealthCheck` と `LB_HEALTH_BUILD`）
重大度は既存の `high` / `warn` だけを使う。
| key | 条件 | 重大度 |
|---|---|---|
| `calslots_unwired` | calsync が直近15分以内に成功している（`LB_CALSYNC_LAST_OK`）のに、`LB_CALSLOTS_WIRED` が無い、30分より古い、または版が `LB_HEALTH_BUILD` と一致しない＝新しい配線が動いていない／反映漏れ | high |
| `calslots_none_sent` | 昨日の changed > 0 なのに sent + stale == 0（stale は新しい枠を送り済み＝害なし） | high |
| `calslots_error` | 昨日の error ≧ 3 | warn |
| `calslots_capped` | 昨日の capped > 0（予算30分に達した） | warn |
| `calslots_lockskip` | 昨日の lockSkip ≧ 5、または lockSkip が changed の2割以上 | warn |
| `calslots_over` | 昨日の usedMs > 1800000（目標予算を超えた）、または slow > 0 | warn |
| `calslots_unfinished` | `LB_CALSLOTS_LAST_START` が `LB_CALSLOTS_LAST` の時刻より新しく、10分以上たっている（開始と最後は各1つなので、並んで走った回の強制終了は取りこぼす。全部は捕まえない補助の見張り） | warn |
| `calslots_record` | `LB_CALSLOTS_RECORD_ERROR`（BAD_JSON・TICK_NOT_VISIBLE・USER_UNKNOWN。setupCalSyncTrigger で付け直した直後は誤警報になり得る）が直近24時間以内、または件数の記録が壊れている | high |
| `calslots_lost` | `LB_CALSLOTS_COUNT_LOST` が直近24時間以内 | warn |

`LB_HEALTH_BUILD` を `2026-11-11a` にする。

## 変えないもの
- `_edgeSendSlots`（枠を送る唯一の経路・巻き戻し防止の世代比較）と、`pushToEdgeSlots` の作り直し・ロック90秒の中身
- 10分ごとの `pushToEdgeSlots` トリガー（取りこぼしの受け皿）
- Worker・画面・空き枠の計算。**会員に出る枠の中身は同じで、早く届くだけ**

## 不変条件（MODEL.md に足す）
- 新：**カレンダー同期が patched/published を返した後の枠の押し出しは、新しいトリガーを作らず、同じ実行の中で呼ぶ。送り終えた実測の当日合計が30分に達したら呼ばない**（検査：`worker/test/calslots-onchange.test.js`）

## 判定できないとき
- 同期の失敗、知らない mode、予算の記録が読めない → 押し出さない。10分ごとの押し出しが拾うので、今と同じ。
- 予算の記録が壊れている（JSON として読めない）→ 押し出さない。`LB_CALSLOTS_RECORD_ERROR` を書く（点検の `calslots_record` が high で鳴る）。
  同じ回で、壊れた記録を `LB_CALSLOTS_COUNT_BAD` へ移し、`LB_CALSLOTS_COUNT` を `{}` に作り直す。次の回からは押し出しが再開する（止まりっぱなしにしない）。その日の予算はゼロから数え直すことになるが、点検で分かる。

## 重複について
重複を省く仕組みは置かない。「その変更を含む枠を既に送った」ことは、時刻の比較では証明できないため。
同じ中身なら同期は必ず `unchanged` を返すので、連続して押し出すことはない。重なるのは、10分ごとの押し出しとたまたま同時になった回だけ。

## 負荷
- 30分/日は**目標予算**で、厳密な上限ではない。送り終えた実測で判定するので、判定の時点でまだ終わっていない実行の数ぶん超え得る。超えたら `calslots_over` で分かる。
- 平均（24.5秒）なら1日約70回ぶん。世代の実数は未計測。反映後、作業依頼 slotsFresh で changed と usedMs を数え、ROADMAP に書く。

## 戻し方
- スクリプト プロパティ `LB_CALSLOTS_ON` を `0` にすれば、すぐ止まる。GAS の反映は要らない。
  ただし `calslots_unwired` は鳴らない（配線の印は書かれ続ける）。
- コードを戻すなら GAS の反映が1回要る。
