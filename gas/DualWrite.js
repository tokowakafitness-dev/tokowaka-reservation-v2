// ============================================================
// DualWrite — 段階3-a「二重書き」
//
//   台帳に書いたあと、**その会員ぶんの計算入力と枠・引当をD1にも作り直す。**
//
//   ★なぜ「作り直す」のか（設計 ops/design/07-dualwrite-3a.md 第2節）
//     入口は11以上ある（取消・変更・振替・一括・代行・固定枠…）。
//     入口ごとに引当の増減を書けば、**同じ計算が11通り生まれる。** 1つ間違えば残数が狂う。
//     作り直しの処理（buildQuotaForCustomer / buildAllocationsForCustomer）は
//     39名の実データで計算と一致することを確認済み。**新しいロジックを持ち込まない。**
//
//   ★なぜ「あとで」やるのか（同 第4節）
//     予約確定の応答に2呼び出しぶん足すと、1,703msまで削った経路が遅くなる。
//     3-a では顧客の予約可否・残数表示に枠・引当を使う経路が0件なので、遅れは見えない。
//     ★3-b（読み取りをD1へ向ける）の前に、ここは同期呼び出しへ戻す。
//
//   ★なぜ新しいトリガーを作らないのか（同 第4節・2026-10-08 測って決めた）
//     コード上のトリガーは21ハンドラ分。GASの上限は1プロジェクト20本。余裕がない。
//     「掃除してから作る」には並行実行の競合もある。既にある2つに相乗りする。
//
//       速い道  _lbCalSyncAfterWrite  書き込みの1秒後（予約系の操作）
//       心拍    pushToEdgeLight       15分ごと（速い道が働かなかったぶん）
//       網      pushToEdgeFullSync    1日1回・深夜4時（計算入力を全件入れ直す）
// ============================================================

var LB_DW = {
  QUEUE_PROP:    'LB_DUALWRITE_QUEUE',      // { "C123": { version, queuedAt }, … }
  OVERFLOW_PROP: 'LB_DUALWRITE_OVERFLOW',   // 溢れて捨てた件数（累計）
  LAST_PROP:     'LB_DUALWRITE_LAST',       // 最後に処理した時刻と結果（点検用）
  // ★待ち行列の人数の上限（2026-10-08・Codex関門②で計算して決めた）。
  //   Script Properties は1つの値が9KBまで。実測（顧客IDは 'C'+14桁＝15文字）：
  //     200名・全部取り置き中 → 16,601 bytes  ★上限超え
  //     100名・全部取り置き中 →  8,301 bytes
  //      80名・全部取り置き中 →  6,641 bytes  ← ここにする（項目が増えても余裕がある）
  //   人数だけでなく、書く直前にバイト数も見る（下の _lbDwWriteQueue）。
  MAX_QUEUE: 80,           // これを超えたら古い順に捨てる（捨てた件数は記録する）
  MAX_PER_RUN: 5,          // 1回の実行で処理する人数（下の時間の上限と両方で縛る）
  LOCK_WAIT_MS: 15000,     // キューの読み書きを待つ時間
  MONTHS_AHEAD: 2,         // 枠を作る先（当月＋この数）。予約が更に先ならそこまで広げる

  // ★取り置きの期限（2026-10-08・Codex関門②）
  //   GASの1実行の上限は6分（一般・Workspaceとも同じ。Workspaceの6時間/日は
  //   トリガーの合計時間で、1実行の上限ではない）。
  //   ただし**ちょうど6分にすると境目が弱い。** 落ちた実行の通信やロック解放が
  //   完全に終わったとは言い切れない。上限＋余裕で10分にする。
  //   ふだんの復帰は「失敗したら取り置きを外す」で速いので、
  //   10分待つのは異常終了のときだけ。**古い世代に上書きされるより安全。**
  LEASE_MS: 10 * 60 * 1000,

  // 1回の実行で使う時間の上限。人数だけで縛ると、1名が重いときに溢れる
  BUDGET_MS: 90 * 1000,
};

// ------------------------------------------------------------
// 待ち行列
//   ★会員IDの配列にしてはいけない（2026-10-08・Codex関門①）。
//     処理中に同じ会員へ新しい予約が入ると「既に居る」ので積まれず、
//     処理成功で外されて、その予約が永遠に反映されない。
//     version を持たせ、外すときに変わっていないことを確かめる。
// ------------------------------------------------------------

function _lbDwLocked(fn, waitMs) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(waitMs == null ? LB_DW.LOCK_WAIT_MS : waitMs)) return null;   // 取れなかった
  try { return fn(); } finally { try { lock.releaseLock(); } catch (e) {} }
}

// ★「空」と「壊れている」を取り違えない（2026-10-08・Codex関門②）。
//   壊れたときに {} を返すと、次の enqueue がその空の中身を保存し、
//   **待っていた会員が全部消える。** 壊れていたら null を返し、呼ぶ側が中止する。
function _lbDwReadQueue() {
  var raw = PropertiesService.getScriptProperties().getProperty(LB_DW.QUEUE_PROP) || '';
  if (!raw) return {};                      // 一度も積んでいない＝正常な空
  try {
    var q = JSON.parse(raw);
    if (q && typeof q === 'object' && !Array.isArray(q)) return q;
    Logger.log('[dw] 待ち行列の形が想定と違います（中止します）');
    return null;
  } catch (e) {
    Logger.log('[dw] 待ち行列が読めませんでした（中止します）: ' + (e && e.message));
    return null;
  }
}

//   ★9KBを超えたら古い順に落としてから書く（2026-10-08・Codex関門②）。
//     人数の上限だけでは守れない（項目が増えたり顧客IDが長くなったりする）。
//     溢れたぶんは記録する（黙って捨てない）。
function _lbDwWriteQueue(q, protectIds) {
  var LIMIT = 8500;   // 9KBに対する余裕
  var json = JSON.stringify(q);
  var dropped = [];
  //   ★見るのは**バイト数**（2026-10-08・Codex関門②の4回目）。
  //     JSONの文字数で測ると、日本語など1文字が複数バイトになる値が入ったとき足りない。
  //     いまの顧客IDは 'C'＋数字14桁なので文字数＝バイト数だが、
  //     将来ほかの文字が入っても守れるようにしておく。
  function _bytes(str) {
    var n = 0;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xD800 && c <= 0xDBFF) { n += 4; i++; }   // 4バイト文字（上位・下位の対）
      else n += 3;
    }
    return n;
  }
  if (_bytes(json) > LIMIT) {
    //   ★取り置いた会員は**最後まで残す**（2026-10-08・Codex関門②の3回目）。
    //     取り置きも容量削りも「古い順」なので、素朴に削ると
    //     **いま取り置いた会員が最初に捨てられる。**
    //     呼ぶ側はその会員を処理し続けるので、終わったときには待ち行列に居ない
    //     （＝取り置きの約束が破れる）。守る会員を後ろに回して削る。
    var protect = {};
    for (var pi = 0; pi < (protectIds || []).length; pi++) protect[protectIds[pi]] = 1;
    var keys = Object.keys(q);
    keys.sort(function (a, b) { return (q[a].queuedAt || 0) - (q[b].queuedAt || 0); });
    var order = [];
    for (var a = 0; a < keys.length; a++) if (!protect[keys[a]]) order.push(keys[a]);
    for (var b = 0; b < keys.length; b++) if (protect[keys[b]]) order.push(keys[b]);
    //   ★1件だけでも超えるなら、その1件も捨てる（keys.length > 1 だと守れない）
    while (_bytes(json) > LIMIT && order.length) {
      var k = order.shift();
      delete q[k]; dropped.push(k);
      json = JSON.stringify(q);
    }
    var p = PropertiesService.getScriptProperties();
    p.setProperty(LB_DW.OVERFLOW_PROP,
      String(Number(p.getProperty(LB_DW.OVERFLOW_PROP) || 0) + dropped.length));
    Logger.log('[dw] 待ち行列が容量を超えたので古い ' + dropped.length + '名を捨てました');
  }
  PropertiesService.getScriptProperties().setProperty(LB_DW.QUEUE_PROP, json);
  return dropped;   // 捨てた会員ID（呼ぶ側は処理対象から外す）
}

// その会員を待ち行列に積む。既に居れば version を上げる。
//   ★「読む→直す→書く」の全体をロックで囲む。個々の setProperty は原子的だが、
//     全体は原子的ではない。囲わないと並行予約で会員IDが失われる。
function lbDwEnqueue(customerId) {
  var cid = String(customerId || '').replace(/^\s+|\s+$/g, '');
  if (!cid) return false;
  var r = _lbDwLocked(function () {
    var q = _lbDwReadQueue();
    if (q === null) return 'BROKEN';        // 壊れている＝上書きしない（消してしまう）
    var cur = q[cid];
    // ★有効な取り置きを**引き継ぐ**（2026-10-08・Codex関門②の2回目）。
    //   取り置きを足したのに、ここでオブジェクトごと置き換えて消していた。
    //   消すと、処理中の会員を別の実行が取れてしまい、
    //   **防ごうとしていた「古い世代が最後に残る」競合がそのまま再発する。**
    //     Aが version 1 を処理中 → 予約が入り version 2 かつ取り置きが消える
    //     → Bが version 2 を取る → AとBが並んで書き、古いAが最後に残り得る
    //   version が変わったことは _lbDwDone が見て、そこで取り置きを外す。
    var next = { version: (cur && Number(cur.version) || 0) + 1, queuedAt: Date.now() };
    if (cur && Number(cur.leaseUntil || 0) > Date.now()) next.leaseUntil = cur.leaseUntil;
    q[cid] = next;

    // 溢れたら古い順に捨てる。**黙って捨てない**（捨てた件数を記録し、照合で気づけるようにする）
    var keys = Object.keys(q);
    if (keys.length > LB_DW.MAX_QUEUE) {
      keys.sort(function (a, b) { return (q[a].queuedAt || 0) - (q[b].queuedAt || 0); });
      var drop = keys.slice(0, keys.length - LB_DW.MAX_QUEUE);
      for (var i = 0; i < drop.length; i++) if (drop[i] !== cid) delete q[drop[i]];
      var p = PropertiesService.getScriptProperties();
      var over = Number(p.getProperty(LB_DW.OVERFLOW_PROP) || 0) + drop.length;
      p.setProperty(LB_DW.OVERFLOW_PROP, String(over));
      Logger.log('[dw] 待ち行列が上限を超えました。古い ' + drop.length + '件を捨てました（累計 ' + over + '）');
    }
    _lbDwWriteQueue(q);
    return true;
  });
  if (r === 'BROKEN') {
    //   壊れた待ち行列を上書きしない。積めていないので記録して気づけるようにする
    var p3 = PropertiesService.getScriptProperties();
    p3.setProperty(LB_DW.OVERFLOW_PROP,
      String(Number(p3.getProperty(LB_DW.OVERFLOW_PROP) || 0) + 1));
    return false;
  }
  if (r === null) {
    // ロックが取れなかった＝積めていない。**黙って落とさない。**
    //   心拍（15分ごと）では拾えないので、ここだけは記録して気づけるようにする。
    Logger.log('[dw] 待ち行列のロックが取れず積めませんでした: ' + cid);
    var p2 = PropertiesService.getScriptProperties();
    p2.setProperty(LB_DW.OVERFLOW_PROP,
      String(Number(p2.getProperty(LB_DW.OVERFLOW_PROP) || 0) + 1));
    return false;
  }
  return true;
}

// 待ち行列から処理対象を**取り置く**（消さない。成功してから外す）
//
//   ★ただ読むだけにしてはいけない（2026-10-08・Codex関門②）。
//     2つの実行が同じ会員を同時に取ると、こうなる：
//       実行A が version 1 を取り、古い計算入力で枠を作り始める
//       → 新しい予約が入り version 2 になる
//       → 実行B が version 2 を取り、新しい内容で枠を作る
//       → **Bが先に終わり、Aの古い内容が後から上書きする**
//       → Bが version 2 を外す。Aは ALREADY_GONE
//       → **待ち行列は空なのに、D1には古い枠と引当が残る**
//
//     「全削除→全挿入」は同じ入力なら冪等だが、**違う世代同士は順序が入れ替わる。**
//     version の照合は「外してよいか」を守るだけで、D1への書き込み順は守らない。
//
//     だから取り置く。期限は6分＝GASの実行制限。**6分を超えて生きている実行は無い**ので、
//     期限が切れた取り置きは落ちた実行のものとみなして取り直せる。
function _lbDwClaim(limit) {
  return _lbDwLocked(function () {
    var q = _lbDwReadQueue();
    if (q === null) return null;                 // 壊れている＝触らない
    var now = Date.now();
    var keys = Object.keys(q);
    keys.sort(function (a, b) { return (q[a].queuedAt || 0) - (q[b].queuedAt || 0); });   // 古い順
    var out = [];
    for (var i = 0; i < keys.length && out.length < limit; i++) {
      var e = q[keys[i]];
      var lease = Number(e.leaseUntil || 0);
      if (lease > now) continue;                 // 他の実行が処理中（期限内）＝飛ばす
      e.leaseUntil = now + LB_DW.LEASE_MS;
      out.push({ customerId: keys[i], version: Number(e.version || 0) });
    }
    if (out.length) {
      //   ★取り置いた会員を守りながら書く。それでも容量で落ちたぶんは
      //     処理対象から外す（待ち行列に居ない会員を処理しても、
      //     終わったときに「既に消えていた」になるだけ）。
      var ids = [];
      for (var oi = 0; oi < out.length; oi++) ids.push(out[oi].customerId);
      var gone = _lbDwWriteQueue(q, ids);
      if (gone.length) {
        var lost = {};
        for (var gi = 0; gi < gone.length; gi++) lost[gone[gi]] = 1;
        var kept = [];
        for (var ki = 0; ki < out.length; ki++) if (!lost[out[ki].customerId]) kept.push(out[ki]);
        out = kept;
        Logger.log('[dw] 容量で捨てられた会員を処理対象から外しました: ' + gone.join(' '));
      }
    }
    //   ★待っている人数も返す（2026-10-08・Codex関門②）。
    //     全員が処理中のとき out は空になる。そこで「残り0」と報告すると、
    //     実際には残っているのに片づいたように見える。
    return { items: out, total: Object.keys(q).length };
  });
}

// 成功したので外す。★version が取り置いたときと同じときだけ外す。
//   違っていれば、処理中に新しい書き込みがあった＝残し、**取り置きを外して**
//   次の実行がすぐ取れるようにする。
function _lbDwDone(customerId, version) {
  return _lbDwLocked(function () {
    var q = _lbDwReadQueue();
    if (q === null) return 'BROKEN';
    var cur = q[customerId];
    if (!cur) return 'ALREADY_GONE';
    if (Number(cur.version) !== Number(version)) {
      delete cur.leaseUntil;                     // 取り置きを外す（次の実行がすぐ取れる）
      _lbDwWriteQueue(q);
      return 'REQUEUED';
    }
    delete q[customerId];
    _lbDwWriteQueue(q);
    return 'DONE';
  });
}

// 失敗したので取り置きだけ外す（会員は残す＝次の実行で再送される）。
//   外さないと期限（10分）まで待つことになる。
function _lbDwRelease(customerId) { return _lbDwReleaseMany([customerId]); }

//   ★複数をまとめて外す（2026-10-08・Codex関門②）。
//     1名ずつ呼ぶと、1回ごとにロックを最大15秒待つ。5名で75秒。
//     **時間切れで打ち切るための処理が、さらに時間を使う形になっていた。**
function _lbDwReleaseMany(customerIds) {
  if (!customerIds || !customerIds.length) return 'RELEASED';
  return _lbDwLocked(function () {
    var q = _lbDwReadQueue();
    if (q === null) return 'BROKEN';
    var touched = 0;
    for (var i = 0; i < customerIds.length; i++) {
      var e = q[customerIds[i]];
      if (e && e.leaseUntil != null) { delete e.leaseUntil; touched++; }
    }
    if (touched) _lbDwWriteQueue(q);
    return 'RELEASED';
  });
}

// ------------------------------------------------------------
// その会員の計算入力をD1へ送る
// ------------------------------------------------------------

// ★「読めなかった（null）」と「0件（[]）」を取り違えない（2026-10-08・Codex関門①）。
//   `(_edgeCalcReservations() || []).filter(...)` と書いてはいけない。
//   読めなかった null が正常な空配列に化け、その会員の生きている予約を全部消す。
function _edgePushCalcResvFor(customerId, all) {
  if (all == null) return false;                 // 読めなかった＝送らない（D1は前のまま）
  var mine = [];
  for (var i = 0; i < all.length; i++) {
    if (String(all[i].customer_id || '') === String(customerId)) mine.push(all[i]);
  }
  // mine が0件でも送る＝その会員の予約が全部取り消された状態は**正常**。
  //   送らないと、最後の1件の取消がD1へ伝わらない。
  var r = _edgePost({
    kind: 'calcReservations',
    scope: 'customer',            // その会員ぶんを世代で入れ替える
    customerId: String(customerId),
    batchId: Date.now(),
    rows: mine,
  });
  return !!(r && r.success);
}

// その会員の予約の、最も先の月。枠を作る範囲の上端に使う。
//   「当月+2」と決め打つと、それより先の予約の引当が作れず NO_QUOTA_ROW で止まる。
//   ★引数の all を使い回す（2026-10-08・Codex関門②）。
//     以前は自分で _edgeCalcReservations() を呼び直していた。
//     1名で台帳を2回読むうえ、**2回の間に予約が変わると違う写しを見る。**
function _lbDwMaxResvMonth(customerId, all) {
  if (all == null) return null;
  var max = null;
  for (var i = 0; i < all.length; i++) {
    if (String(all[i].customer_id || '') !== String(customerId)) continue;
    var vals = null;
    try { vals = JSON.parse(all[i].row_json); } catch (e) { continue; }
    var ms = vals && vals[0];
    if (ms == null) continue;
    var mk = _lbMonthKeyJst(Number(ms));
    if (!max || mk > max) max = mk;
  }
  return max;
}

function _lbDwMonthKeyAhead(n) {
  var d = new Date();
  var y = d.getFullYear(), m = d.getMonth() + 1 + n;
  y += Math.floor((m - 1) / 12); m = ((m - 1) % 12) + 1;
  return y + '-' + ('0' + m).slice(-2);
}

// 枠と引当を、その会員ぶんだけ作り直す
function _edgeQuotaBuildOne(customerId, all) {
  // from … その会員の記録開始月。これより前は完全な予約履歴として扱わない領域
  var from = null;
  try {
    var op = _lbMemberOpeningWithFloor(customerId);
    if (op && op.recordsFrom) from = String(op.recordsFrom);
  } catch (e) {}
  if (!from) {
    // 記録開始月が分からなければ作り直さない。範囲が決まらないのに書くほうが危険
    Logger.log('[dw] 記録開始月が分からないので枠は作り直しません: ' + customerId);
    return false;
  }
  var to = _lbDwMonthKeyAhead(LB_DW.MONTHS_AHEAD);
  var maxMk = _lbDwMaxResvMonth(customerId, all);
  if (maxMk && maxMk > to) to = maxMk;          // 予約が更に先ならそこまで
  if (from > to) to = from;

  var url = _edgeProp('EDGE_URL');
  if (!url) return false;
  var q = '/quota/build?dry=0&alloc=1&customer=' + encodeURIComponent(customerId)
        + '&from=' + from + '&to=' + to;
  try {
    var res = UrlFetchApp.fetch(url + q, {
      method: 'get',
      headers: { 'X-Ingest-Secret': _edgeProp('EDGE_SECRET') },
      muteHttpExceptions: true,
    });
    var code = res.getResponseCode();
    var body = {};
    try { body = JSON.parse(res.getContentText() || '{}'); } catch (e) {}
    if (code !== 200 || body.ok !== true) {
      Logger.log('[dw] 枠の作り直しが失敗（HTTP ' + code + '）: ' + customerId
                 + ' ' + String(res.getContentText() || '').slice(0, 200));
      return false;
    }
    // ★問題が記録されていたら成功としない。この会員は書かれていない（Workerが止めている）
    if ((body.issues && body.issues.length) || (body.skipped && body.skipped.length)) {
      Logger.log('[dw] 枠を作れませんでした: ' + customerId
                 + ' issues=' + JSON.stringify(body.issues || []).slice(0, 300)
                 + ' skipped=' + JSON.stringify(body.skipped || []).slice(0, 200));
      return false;
    }
    return true;
  } catch (e) {
    Logger.log('[dw] 枠の作り直しで例外: ' + customerId + ' ' + (e && e.message));
    return false;
  }
}

// ------------------------------------------------------------
// 待ち行列を処理する（相乗り先から呼ばれる）
// ------------------------------------------------------------

function lbDualWriteDrain(limit) {
  if (!_edgeEnabled()) return { skipped: 'EDGE_OFF' };
  var t0 = Date.now();
  var n = Number(limit || LB_DW.MAX_PER_RUN);
  var claim = _lbDwClaim(n);
  if (claim === null) return { skipped: 'QUEUE_BROKEN_OR_LOCKED' };
  var todo = claim.items, queued = claim.total;
  if (!todo.length) {
    //   ★実際の残り人数を返す。全員が処理中のとき0と報告してはいけない
    return { done: 0, left: queued, allLeased: queued > 0 };
  }

  // ★台帳は**1回だけ**読む（2026-10-08・Codex関門②）。
  //   会員ごとに読み直すと、5名で10回読むうえ、読んだ時点が会員ごとにずれる。
  //   ★「読めなかった（null）」と「0件（[]）」を取り違えない。
  //     `(… || []).filter()` と書くと、読めなかった null が空配列に化け、
  //     その会員の生きている予約を全部消す。
  var all = null;
  try { all = _edgeCalcReservations(); } catch (e) {
    Logger.log('[dw] 台帳が読めませんでした: ' + (e && e.message));
  }
  if (all == null) {
    // 読めなかった＝何も送らない。取り置きを**まとめて**外して次の実行に回す
    var back = [];
    for (var j = 0; j < todo.length; j++) back.push(todo[j].customerId);
    _lbDwReleaseMany(back);
    Logger.log('[dw] 台帳が読めないので今回は見送ります（' + back.length + '名を戻しました）');
    return { skipped: 'LEDGER_UNREADABLE', left: queued };
  }

  var done = 0, failed = 0, requeued = 0, overBudget = 0, anomaly = 0;
  for (var i = 0; i < todo.length; i++) {
    // ★人数だけでなく時間でも縛る。1名が重いと人数の上限内でも6分に届く
    if (Date.now() - t0 > LB_DW.BUDGET_MS) {
      var rest = [];
      for (var k = i; k < todo.length; k++) rest.push(todo[k].customerId);
      _lbDwReleaseMany(rest);        // ★まとめて1回のロックで外す（1名ずつだと更に時間を使う）
      overBudget = rest.length;
      Logger.log('[dw] 時間の上限に達したので ' + overBudget + '名を次回に回しました');
      break;
    }
    var cid = todo[i].customerId, ver = todo[i].version;
    // ★順序が要点：計算入力を先に入れ替え、そのあと枠・引当を作り直す。
    //   逆にすると、古い予約で引当を作ってしまう。
    var okResv = false, okQuota = false;
    try { okResv = _edgePushCalcResvFor(cid, all); } catch (e) {
      Logger.log('[dw] 計算入力の送信で例外: ' + cid + ' ' + (e && e.message));
    }
    if (okResv) {
      try { okQuota = _edgeQuotaBuildOne(cid, all); } catch (e) {
        Logger.log('[dw] 枠の作り直しで例外: ' + cid + ' ' + (e && e.message));
      }
    }
    if (okResv && okQuota) {
      var r = _lbDwDone(cid, ver);
      if (r === 'REQUEUED') requeued++;
      else if (r === 'DONE') done++;
      else if (r === 'ALREADY_GONE') {
        //   ★成功に数えない（2026-10-08・Codex関門②）。
        //     取り置きがあるのに他の実行が外した＝取り置きの仕組みが破れている
        //     （期限切れでの取り直し／溢れで捨てられた／手で空にした のいずれか）。
        //     D1には書けているが、**取り置いた世代を安全に終えたとは言えない。**
        anomaly++;
        Logger.log('[dw] 🚨待ち行列から既に消えていました（取り置きが破れています）: ' + cid);
      } else { failed++; Logger.log('[dw] 外せませんでした（次の実行で処理されます）: ' + cid + ' ' + r); }
    } else {
      _lbDwRelease(cid);   // 取り置きを外す（6分待たずに次の実行で再送）
      failed++;
    }
  }

  var leftQ = _lbDwReadQueue();
  var left = (leftQ === null) ? -1 : Object.keys(leftQ).length;
  var ms = Date.now() - t0;
  PropertiesService.getScriptProperties().setProperty(LB_DW.LAST_PROP, JSON.stringify({
    at: Date.now(), ms: ms, done: done, failed: failed,
    requeued: requeued, overBudget: overBudget, anomaly: anomaly, left: left,
  }));
  Logger.log('[dw] ' + ms + 'ms 成功' + done + ' 失敗' + failed
             + ' 再更新' + requeued + ' 時間切れ' + overBudget
             + (anomaly ? ' 🚨異常' + anomaly : '') + ' 残り' + left);
  return { ms: ms, done: done, failed: failed, requeued: requeued,
           overBudget: overBudget, anomaly: anomaly, left: left };
}

// 点検用（GASエディタから引数なしで呼べる）
function lbDualWriteStatusText() {
  var p = PropertiesService.getScriptProperties();
  var q = _lbDwReadQueue();
  if (q === null) {
    var tb = '=== 二重書きの待ち行列 ===\n🚨 待ち行列が壊れています（読めません）。'
           + 'lbDualWriteClearQueue() で空にすると、待っていた会員は失われます。'
           + '先に照合（quotaBuild verify）で食い違いを確認してください。';
    Logger.log(tb); return tb;
  }
  var keys = Object.keys(q);
  var last = {};
  try { last = JSON.parse(p.getProperty(LB_DW.LAST_PROP) || '{}'); } catch (e) {}
  var o = [];
  o.push('=== 二重書きの待ち行列 ===');
  o.push('待っている会員: ' + keys.length + '名');
  if (keys.length) {
    keys.sort(function (a, b) { return (q[a].queuedAt || 0) - (q[b].queuedAt || 0); });
    var lines = [];
    for (var i = 0; i < Math.min(keys.length, 10); i++) {
      var lu = Number(q[keys[i]].leaseUntil || 0);
      lines.push(keys[i] + '(v' + q[keys[i]].version + (lu > Date.now() ? '・処理中' : '') + ')');
    }
    o.push('  古い順: ' + lines.join(' / ') + (keys.length > 10 ? ' …ほか' + (keys.length - 10) + '名' : ''));
  }
  var over = Number(p.getProperty(LB_DW.OVERFLOW_PROP) || 0);
  if (over) o.push('🚨 溢れて捨てた／積めなかった件数（累計）: ' + over + '（★照合で食い違いが出る原因になります）');
  if (last.at) {
    o.push('最後の処理: ' + Utilities.formatDate(new Date(Number(last.at)), SETTINGS.TIMEZONE, 'MM/dd HH:mm')
           + '  ' + (last.ms || 0) + 'ms'
           + ' / 成功' + (last.done || 0) + ' / 失敗' + (last.failed || 0)
           + ' / 処理中に再更新' + (last.requeued || 0)
           + ' / 時間切れ' + (last.overBudget || 0) + ' / 残り' + (last.left || 0));
  } else {
    o.push('最後の処理: まだ一度も動いていません');
  }
  var t = o.join('\n');
  Logger.log(t);
  return t;
}

// 待ち行列を空にする（取り扱い注意・手で呼ぶときだけ）
function lbDualWriteClearQueue() {
  _lbDwLocked(function () { _lbDwWriteQueue({}); });
  Logger.log('[dw] 待ち行列を空にしました');
}

// ------------------------------------------------------------
// 日次の点検（dailyHealthCheck から呼ばれる）
//
//   ★「14日連続で食い違い0件」を待つ代わりに、**毎日照合して食い違いを見つける。**
//     放置すると積み上がる（2026-10-08 朝、一晩で1名ズレた）。
//     設計：ops/design/06-verify-without-waiting.md ／ 07-dualwrite-3a.md 第7節
//
//   返すもの：[{ key, severity, count, detail }] — dailyHealthCheck の add() にそのまま渡す
// ------------------------------------------------------------

function lbDwDailyCheck() {
  var out = [];
  var p = PropertiesService.getScriptProperties();

  // ① 待ち行列が溜まっていないか
  //   速い道と心拍で片づくはずのものが残っている＝作り直しが失敗し続けている
  var q = _lbDwReadQueue();
  if (q === null) {
    out.push({ key: 'dualwrite_queue_broken', severity: 'high', count: 1,
               detail: '二重書きの待ち行列が壊れています（読めません）。'
                     + '新しい書き込みが積めず、D1に伝わりません。' });
    q = {};
  }
  var left = Object.keys(q).length;
  if (left) {
    var oldest = null;
    for (var k in q) if (q.hasOwnProperty(k)) {
      var t = Number(q[k].queuedAt || 0);
      if (t && (oldest == null || t < oldest)) oldest = t;
    }
    var ageH = oldest ? Math.floor((Date.now() - oldest) / 3600000) : 0;
    //   15分の心拍で片づくので、1時間以上残っていれば失敗が続いている
    out.push({
      key: 'dualwrite_queue', severity: (ageH >= 1 ? 'high' : 'warn'), count: left,
      detail: '二重書きの待ち行列に' + left + '名残っています（最も古いもの ' + ageH + '時間前）。'
            + (ageH >= 1 ? 'D1の引当が追いついていません。' : '処理中の可能性があります。'),
    });
  }

  // ② 溢れた／積めなかったことがないか
  //   ここが0でなければ、**その会員の変更はD1に伝わっていない**（照合で食い違いとして出る）
  var over = Number(p.getProperty(LB_DW.OVERFLOW_PROP) || 0);
  if (over) {
    out.push({
      key: 'dualwrite_overflow', severity: 'high', count: over,
      detail: '待ち行列から捨てた／積めなかった回数が累計' + over + '回あります。'
            + 'その会員の変更はD1に伝わっていません。全員の作り直しが必要です。',
    });
  }

  // ③ D1と計算の突き合わせ（全員）
  //   ★これが本体。食い違いが1名でもあれば、読み取りをD1へ向けてはいけない。
  var v = null;
  try { v = _edgeQuotaVerify({ limit: 5, maxPages: 12 }); }
  catch (e) {
    out.push({ key: 'dualwrite_verify_fail', severity: 'high', count: 1,
               detail: '照合そのものが失敗しました: ' + (e && e.message) });
    return out;
  }

  if (!v.done) {
    out.push({ key: 'dualwrite_verify_partial', severity: 'warn', count: 1,
               detail: '照合が最後まで到達しませんでした（比べた会員 ' + v.checked + '名）。'
                     + '会員が増えたなら1回に見る人数の上限を見直す。' });
  }
  if (v.differ) {
    out.push({ key: 'dualwrite_differ', severity: 'high', count: v.differ,
               detail: 'D1と計算が食い違う会員が' + v.differ + '名います。'
                     + '二重書きが届いていないか、計算側が変わっています。読み取りをD1へ向けてはいけません。' });
  }
  if (v.skipped) {
    out.push({ key: 'dualwrite_skipped', severity: 'warn', count: v.skipped,
               detail: '比べられなかった会員が' + v.skipped + '名います（理由: '
                     + JSON.stringify(v.skippedWhy || {}) + '）。' });
  }
  if (v.overUsedPacks) {
    out.push({ key: 'dualwrite_over_packs', severity: 'high', count: v.overUsedPacks,
               detail: '買った枚数を超えて使っているチケットの会員が' + v.overUsedPacks + '名います。' });
  }
  if (v.overUsedMonths) {
    out.push({ key: 'dualwrite_over_months', severity: 'high', count: v.overUsedMonths,
               detail: '枠を超えて使っている月がある会員が' + v.overUsedMonths + '名います。' });
  }
  if (v.coverageMissing || v.staleCoverage) {
    out.push({ key: 'dualwrite_coverage', severity: 'high',
               count: Number(v.coverageMissing || 0) + Number(v.staleCoverage || 0),
               detail: '契約の覆い方が入っていない枠の行があります（比べられず '
                     + (v.coverageMissing || 0) + '件 / 表全体 ' + (v.staleCoverage || 0) + '件）。'
                     + '枠の作り直しが必要です。' });
  }
  if (v.quotaInvariantBroken) {
    out.push({ key: 'dualwrite_invariant', severity: 'high', count: v.quotaInvariantBroken,
               detail: '使った数が枠を超えている行が' + v.quotaInvariantBroken + '件あります。'
                     + '引当かトリガーの異常です。' });
  }
  if (v.orphans && (v.orphans.quotaRows || v.orphans.packRows || v.orphans.allocRows)) {
    out.push({ key: 'dualwrite_orphans', severity: 'high',
               count: v.orphans.quotaRows + v.orphans.packRows + v.orphans.allocRows,
               detail: '契約が無い会員の行がD1に残っています（枠 ' + v.orphans.quotaRows
                     + ' / チケット ' + v.orphans.packRows + ' / 引当 ' + v.orphans.allocRows + '）。' });
  }

  return out;
}
