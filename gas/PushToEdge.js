// GAS → Cloudflare への押し出し（2026-09-28）
//
// 第1段階の役割分担：
//   真実はここ（スプレッドシートとGoogleカレンダー）。Cloudflareはその写しを配るだけ。
//   だから「書くのはGAS、読むのはWorker」。この向きを崩さない。
//
// 押し出すもの：
//   D1 … トレーナー・顧客・契約・予約・固定枠（一人ひとり違う／正確さが要る）
//   KV … トレーナー名簿・空き枠・残数（みんなが同じものを読む）
//
// 設定（Script Properties）：
//   EDGE_URL        … 例 https://tokowaka-api.tokowaka-fitness.workers.dev
//   EDGE_SECRET     … Worker側の SHARED_SECRET と同じ合言葉
//   EDGE_PUSH_ON    … '1' のときだけ押し出す（既定は停止。安全側）
//
// 使い方：
//   1) 手動で1回 pushToEdgeAll() を実行して疎通を見る
//   2) 問題なければ setupEdgeTrigger() で5分ごとに回す

var EDGE = {
  CHUNK: 300,            // 1回の送信で送る行数（Worker側の上限は500）
  BUDGET_MS: 4 * 60000   // GASは1回6分で止められる。4分で残数の計算を打ち切り、残りは次回に回す
};

// ★版の印（2026-10-08）。反映が入ったかを一目で確かめるため。
//   これが無いと「反映したつもりで入っていない」ことに気づけない。
//   実際に 2026-10-08、新しいファイルが許可一覧に無くて反映が止まっていたのに、
//   出力が前日と同じで区別がつかなかった。**反映のたびにここを上げる。**
var LB_EDGE_BUILD = '2026-10-09e 振替権を写しに入れる（読めなければ押し出さない）';

function _edgeProp(k) { return PropertiesService.getScriptProperties().getProperty(k) || ''; }

// 空欄は '' ではなく null で送る。'' は「そういうIDが実在する」ことになってしまい、
// 参照先を探しても見つからない行を作る。
function _edgeIdOrNull(v) {
  var s = String(v == null ? '' : v).replace(/^\s+|\s+$/g, '');
  return s === '' ? null : s;
}
function _edgeEnabled() { return _edgeProp('EDGE_PUSH_ON') === '1'; }

function _edgePost(payload) {
  var url = _edgeProp('EDGE_URL');
  var secret = _edgeProp('EDGE_SECRET');
  if (!url || !secret) throw new Error('EDGE_URL / EDGE_SECRET が未設定です');
  var res = UrlFetchApp.fetch(url.replace(/\/+$/, '') + '/ingest', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Ingest-Secret': secret },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  var text = res.getContentText();
  if (code !== 200) throw new Error('ingest ' + payload.kind + ' が失敗（HTTP ' + code + '）: ' + text.slice(0, 200));
  return JSON.parse(text);
}

// 行を分割して送り、最後の塊にだけ final を付ける。
//   → 途中で失敗したら final が届かないので、Worker側は古い行を消さない（中途半端に消えない）。
// 押し出し本体から「完全同期かどうか」を渡すための包み
function _edgePushRowsF(kind, rows, batchId, opts) { return _edgePushRows(kind, rows, batchId, opts); }

// 同じ識別子の行が複数あったら、最後のものだけ残す。
//   重複したまま送ると、押し出しのたびに互いを上書きし合い、
//   書き込みが無駄に発生するうえ、画面に出る内容が毎回入れ替わる。
function _edgeDedupe(kind, rows) {
  if (!rows || !rows.length) return rows;
  var keyOf = { trainers: 'trainer_id', customers: 'customer_id', reservations: 'reservation_id',
                recurring: 'pattern_id', home: 'customer_id', slots: 'trainer_id',
                body: 'record_id' }[kind];
  if (!keyOf) return rows;
  var seen = {}, out = [];
  for (var i = 0; i < rows.length; i++) {
    var k = String(rows[i][keyOf] == null ? '' : rows[i][keyOf]);
    if (!k) continue;
    if (seen[k] != null) out[seen[k]] = rows[i];   // 後のもので置き換える
    else { seen[k] = out.length; out.push(rows[i]); }
  }
  return out;
}

// ★scope は必ず書く（2026-10-03・Codexの設計レビュー）。
//
//   scope … 今回その表の**全件を走査し終えたか**
//     'all'     … 全件を見て送った（15分ごとの同期・日次の完全同期・10分の枠同期）
//     'partial' … 一部だけ（予約直後の1人ぶん・1トレーナーぶん・時間切れの続き）
//
//   deleteStale … 含まれなかった行を**消してよいか**（日次の完全同期だけ）
//
//   ★この2つは別物である。
//     以前は full ひとつで両方を表しており、「全件を送っているのに full=false」
//     （15分ごとの同期）と「1人ぶんだけで full=false」が区別できなかった。
//     そのため Worker 側で全体の同期時刻を押す条件を作れず、
//     1人が予約するたびに予約一覧全体が「たったいま同期した」ことになっていた。
//
//   ★既定値を持たせない。書き忘れたら**例外で止める。**
//     既定を 'partial' にすると、新しい呼び出しを足したときに書き忘れても
//     黙って「同期時刻を押さない」状態になり、遅くなった理由が分からなくなる。
//     安全に失敗することと、黙って劣化することは別である。
function _edgePushRows(kind, rows, batchId, opts) {
  var _o = opts || {};
  var scope = _o.scope;
  if (scope !== 'all' && scope !== 'partial') {
    throw new Error('_edgePushRows: scope は "all"（全件を走査した）か "partial"（一部だけ）を必ず指定してください。kind=' + kind);
  }
  var full = !!_o.deleteStale;
  if (full && scope !== 'all') {
    throw new Error('_edgePushRows: 含まれない行を消してよいのは全件を走査したときだけです。kind=' + kind);
  }
  // ★0件のときに「本当に0件だ」と名乗るか（2026-10-03・Codexの再判定）。
  //   受け取る側は、元データが読めなかった事故を疑って**0件の完全同期では消さない**。
  //   そのため最後の1件を消したとき、次の同期が0件になり、D1に残り続けていた。
  //   「読めなかった」と「本当に0件」を送る側で区別できる表だけ、これを立てる。
  //   （固定枠は _edgeRecurring が読めないとき null を返して送信ごと中止する）
  var allowEmpty = !!_o.allowEmpty;
  if (allowEmpty && !full) {
    throw new Error('_edgePushRows: allowEmpty は消す指定とあわせてのみ使えます。kind=' + kind);
  }

  var sent = 0, wrote = 0, skip = 0, i;
  // 元データが読めなかった（null）ときは、何も送らない。
  //   空配列を final 付きで送ると、取り込み側が全行を消してしまう。
  if (rows == null) throw new Error(kind + ' の元データが読めませんでした（送信を中止）');
  rows = _edgeDedupe(kind, rows);
  if (!rows.length) {
    _edgePost({ kind: kind, batchId: batchId, rows: [], final: true, deleteStale: full, scope: scope, allowEmpty: allowEmpty });
    return '0件';
  }
  for (i = 0; i < rows.length; i += EDGE.CHUNK) {
    var chunk = rows.slice(i, i + EDGE.CHUNK);
    var last = (i + EDGE.CHUNK) >= rows.length;
    var res = _edgePost({ kind: kind, batchId: batchId, rows: chunk, final: last, deleteStale: full, scope: scope });
    sent += chunk.length;
    wrote += Number((res && res.written) || 0);
    skip  += Number((res && res.skipped) || 0);
  }
  // 「送った件数」ではなく「実際に書いた件数」を出す。
  //   変わっていない行を書き直していないか、ここで分かるようにする。
  return sent + '件中' + wrote + '件を書込' + (skip ? '（' + skip + '件は変更なし）' : '');
}

// ============================================================
// それぞれの材料を作る
// ============================================================

function _edgeTrainers() {
  var out = [];
  var sh = _lbSheet(LINE_BOOKING.TRAINER_SHEET);
  var byId = {};
  if (sh && sh.getLastRow() >= 2) {
    var v = sh.getRange(2, 1, sh.getLastRow() - 1, Math.max(TR_COL.NAME_EN, sh.getLastColumn())).getValues();
    for (var i = 0; i < v.length; i++) {
      var id = String(v[i][TR_COL.TRAINER_ID - 1] || '');
      if (!id) continue;
      byId[id] = {
        trainer_id: id,
        name: String(v[i][TR_COL.NAME - 1] || ''),
        name_en: String(v[i][TR_COL.NAME_EN - 1] || ''),
        calendar_id: '',
        line_user_id: _edgeIdOrNull(v[i][TR_COL.LINE_USER_ID - 1]),
        role: String(v[i][TR_COL.ROLE - 1] || 'trainer'),
        active: _lbTruthy(v[i][TR_COL.ACTIVE - 1]) ? 1 : 0,
        hidden: 0
      };
    }
  }
  // カレンダー定義側にしか無いトレーナー（hidden含む）も名簿に載せる
  var list = (CALENDAR_IDS && CALENDAR_IDS.TRAINERS) || [];
  for (var j = 0; j < list.length; j++) {
    var t = list[j], tid = String(t.id || '');
    if (!tid) continue;
    if (!byId[tid]) byId[tid] = { trainer_id: tid, name: String(t.name || ''), name_en: '', line_user_id: '', role: 'trainer', active: 1 };
    byId[tid].calendar_id = String(t.calendarId || t.email || '');
    byId[tid].hidden = t.hidden ? 1 : 0;
  }
  for (var k in byId) out.push(byId[k]);
  return out;
}

function _edgeCustomers() {
  var sh = _lbSheet(LINE_BOOKING.MAP_SHEET);
  // ★シートが取れないのは「0件」ではなく「読めなかった」。空配列を返すと、
  //   取り込み側が「全員いなくなった」と解釈して消してしまう。
  if (!sh) return null;
  if (sh.getLastRow() < 2) return null;
  var last = sh.getLastRow();
  var v = sh.getRange(2, 1, last - 1, Math.max(MAP_COL.NOTE || 14, sh.getLastColumn())).getValues();
  var out = [], now = Date.now();
  for (var i = 0; i < v.length; i++) {
    var cid = String(v[i][MAP_COL.CUSTOMER_ID - 1] || '');
    if (!cid) continue;
    var linked = v[i][MAP_COL.LINKED_AT - 1];
    var created = (linked instanceof Date) ? linked.getTime() : now;
    out.push({
      customer_id: cid,
      name: String(v[i][MAP_COL.NAME - 1] || ''),
      kana: '',
      phone: String(v[i][MAP_COL.PHONE - 1] || ''),
      email: '',
      birthday: '',
      line_user_id: _edgeIdOrNull(v[i][MAP_COL.LINE_USER_ID - 1]),
      default_trainer_id: _edgeIdOrNull(v[i][MAP_COL.TRAINER_ID - 1]),
      contract_status: String(v[i][MAP_COL.CONTRACT_STAT - 1] || ''),
      contract_type: String(v[i][MAP_COL.CONTRACT_TYPE - 1] || ''),
      lang: '',
      goal: '',
      note: '',
      created_at: created,
      // ★ここに「いまの時刻」を入れてはいけない。中身が同じでも毎回違う行になり、
      //   変更の有無を見比べられなくなる（顧客39件が毎回書き直されていた）。
      //   写し元に更新時刻が無いので、登録日時をそのまま使う。
      updated_at: created
    });
  }
  return out;
}

function _edgeReservations() {
  var sh = _lbSheet(LINE_BOOKING.RESV_SHEET);
  if (!sh) return null;                     // 読めなかった（0件ではない）
  if (sh.getLastRow() < 2) return null;
  var lastCol = Math.max(15, sh.getLastColumn());
  var v = sh.getRange(2, 1, sh.getLastRow() - 1, lastCol).getValues();
  // 会員の「これまでの記録」は全件表示されるため、過去も広く写す。
  //   60日で切ると、会員の画面から過去の記録が消えてしまう。
  var lo = Date.now() - 730 * 86400000, hi = Date.now() + 180 * 86400000;
  var mins = (SETTINGS && SETTINGS.SESSION_MINUTES) || 60;
  var out = [];
  for (var i = 0; i < v.length; i++) {
    var r = v[i];
    // ★状態はそのまま写す。画面に出すのは 'booked'（＝confirmed）だけ。
    //   当日キャンセルは残数を戻さないため 'consumed' のまま残る（cancelled にならない）。
    //   ここを「消化計上用の条件」（confirmed か consumed）で写すと、
    //   当日キャンセルした予約が「予約あり」として復活する（2026-09-28 実際に起きた）。
    var st = String(r[6] || '');
    var status = (st === 'confirmed') ? 'booked'
               : (st === 'consumed')  ? 'consumed'
               : (st === 'cancelled') ? 'cancelled'
               : (st === 'changed')   ? 'changed' : '';
    if (!status) continue;
    var dt = _lbParseResvDate(r[0]);
    if (!dt || isNaN(dt.getTime())) continue;
    var startAt = dt.getTime();
    if (startAt < lo || startAt > hi) continue;
    // ★識別子は「備考欄のresId」を使う。session_id を優先してはいけない。
    //   GASのキャンセル・変更・振替はすべて備考欄（8列目）で予約行を探すため、
    //   画面がWorkerから受け取ったIDでキャンセルを頼むと、行が見つからず
    //   サーバーエラーになる（2026-09-28 実際に起きた）。
    //   session_id は行が見つからないときの最後の手段としてだけ使う。
    var rid = String(r[8] == null ? '' : r[8]).split('|')[0].replace(/^\s+|\s+$/g, '');
    var sid = String(r[11] == null ? '' : r[11]).replace(/^\s+|\s+$/g, '');
    var id = rid || sid;
    if (!id) continue;
    var bt = String(r[13] == null ? '' : r[13]);
    var kind = (bt.indexOf('体験') >= 0) ? 'trial' : (String(r[9]) === 'transfer' ? 'transfer' : 'normal');
    var dur = (kind === 'trial') ? ((SETTINGS && SETTINGS.TRIAL_SESSION_MINUTES) || mins) : mins;
    out.push({
      reservation_id: id,
      customer_id: _edgeIdOrNull(r[2]),
      customer_name: String(r[1] || ''),
      trainer_id: _edgeIdOrNull(r[4]) || 'unknown',
      start_at: startAt,
      end_at: startAt + dur * 60000,
      kind: kind,
      book_type: bt,                       // 台帳の「種別」そのまま（画面のラベル表示に使う）
      attendee_count: (r[14] === '' || r[14] == null) ? 1 : Number(r[14]),
      status: status,
      calendar_event_id: null,
      channel: String(r[9] || 'line'),
      created_by: null,
      created_at: startAt
    });
  }
  return out;
}

// ★固定枠は**行ごと削除される**（deleteRecurringPattern が deleteRow する）。
//   状態（active）では消えたことを表せないので、15分ごとの全件同期で
//   「含まれなかった行＝消えた行」として落とす（下の deleteStale: true）。
//   そのため「読めなかった」と「本当に0件」を区別する必要がある。
//   読めなかったときに [] を返すと、全件を消してしまう。
function _edgeRecurring() {
  //   ★シートを作らない版を使う。_lbRecurSheet は無ければ新規作成するため、
  //     元シートが誤って消えたときに空シートが生まれ、「本当に0件」として
  //     D1の固定枠を全部消してしまう（2026-10-03・Codexの4回目の判定）。
  var sh = _lbRecurSheetReadOnly();
  if (!sh) return null;                     // 無い／読めなかった（0件ではない）＝送らない
  if (sh.getLastRow() < 2) return [];       // 本当に1件も無い
  var v = sh.getRange(2, 1, sh.getLastRow() - 1, 10).getValues();
  var out = [];
  for (var i = 0; i < v.length; i++) {
    var pid = String(v[i][RP_COL.PATTERN_ID - 1] || '');
    if (!pid) continue;
    if (!_lbTruthy(v[i][RP_COL.ACTIVE - 1])) continue;
    var ca = v[i][RP_COL.CREATED_AT - 1];
    out.push({
      pattern_id: pid,
      customer_id: _edgeIdOrNull(v[i][RP_COL.CUSTOMER_ID - 1]),
      trainer_id: _edgeIdOrNull(v[i][RP_COL.TRAINER_ID - 1]),
      weekday: Number(v[i][RP_COL.WEEKDAY - 1]),
      time: String(v[i][RP_COL.TIME - 1] || ''),
      active: 1,
      created_at: (ca instanceof Date) ? ca.getTime() : Date.now()
    });
  }
  return out;
}

// 残数の写し。計算そのもの（Allocate.js）はGASに置いたまま、結果だけをKVへ。
//   第2段階でD1が契約の真実になったら、この計算をWorkerへ移す。
function _edgeMonthKey(d) {
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);
}

//   振替権を**1回のシート読みで全員ぶん**作る（2026-10-09）。
//
//   ★なぜ写しに入れるのか
//     transferCredits は顧客の画面に出る（ホームの「振替 N回」＋
//     予約画面の「①通常／②振替」の分岐）。ところがGASは memberStatus の
//     **home の外**に置き、Workerは **home の中**を読んでいた（compat.js:89）。
//     ＝Worker経由では**常に { available: 0 }**。
//     振替権を持つ会員が、振替で予約できない状態だった。
//
//   ★1回だけ読む。_lbTransferCreditsFor は会員ごとにシート全体を読むので、
//     40名ぶん呼ぶと40回の全行読みになる（_edgeHomeRows は既に42秒かかっている）。
//
//   ★★読めなかったら押し出しを**止める**（2026-10-09・関門③の2周目）。
//     最初は「失敗しても止めない（0に見えるだけ）」と書いたが、**それは退行だった。**
//     振替権を写しに入れたあとは、読めないときに 0 を書くと
//     **正しい写しを「振替0回」で上書きする**＝振替で予約できなくなる。
//     「不明」を「0件」に変換して押し出してはいけない。
//     押し出さなければ前の正しい写しが残る（keepStale なので消えない）。
//     残数の写しは古くなるが、40分の安全弁で画面がGASへ落ちる＝遅いが正しい。
//   返り値 { ok, byCid }
function _edgeTransferCreditsAll() {
  var out = {};
  try {
    var sh = _lbSheet(LB_TCREDIT_SHEET);
    //   ★シートが無い／空は「振替権を持つ人がいない」＝正常。0でよい
    if (!sh) return { ok: true, byCid: out, empty: 'no_sheet' };
    if (sh.getLastRow() < 2) return { ok: true, byCid: out, empty: 'no_rows' };
    var v = sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues();
    var byCid = {};
    for (var i = 0; i < v.length; i++) {
      var cid = String(v[i][0] == null ? '' : v[i][0]).replace(/^\s+|\s+$/g, '');
      if (!cid) continue;
      var g = _lbParseResvDate(v[i][1]), e = _lbParseResvDate(v[i][2]);
      var u = v[i][3] ? _lbParseResvDate(v[i][3]) : null;
      (byCid[cid] = byCid[cid] || []).push({
        grantedMs: g ? g.getTime() : 0, expiresMs: e ? e.getTime() : 0,
        usedMs: u ? u.getTime() : 0, rowIndex: i + 2
      });
    }
    var now = Date.now();
    for (var c in byCid) {
      if (!byCid.hasOwnProperty(c)) continue;
      var st = _lbTransferCreditState(byCid[c], now);
      out[c] = {
        available: st.available, nextExpiryMs: st.nextExpiryMs || null,
        //   ★ラベルは日本語で固定。写しは1つなので言語ごとに作れない。
        //     英語の会員には日本語の日付が出る（振替が0に見えるより軽い）。
        nextExpireLabel: st.nextExpiryMs ? _lbFmtDateShort(new Date(st.nextExpiryMs), null) : ''
      };
    }
  } catch (e) {
    //   ★0 を返さない。読めなかったことを呼ぶ側へ伝える
    Logger.log('⚠️ 振替権が読めませんでした（残数の写しを押し出しません）: ' + (e && e.message));
    return { ok: false, byCid: {}, error: String((e && e.message) || e) };
  }
  return { ok: true, byCid: out };
}

function _edgeHomeRows(customerIds, deadlineMs) {
  var rows = [];
  var now = new Date();
  // 25日以降は翌月の枠が開く。「今日の残数」だけでは、翌月の予約に答えられない
  //   （9月の残数と10月の残数は別物）。今月分と翌月分の2つを持たせる。
  var nextMid = new Date(now.getFullYear(), now.getMonth() + 1, 15, 12, 0, 0);
  var curKey = _edgeMonthKey(now), nextKey = _edgeMonthKey(nextMid);
  //   ★振替権は1回だけ読む（顧客の画面に出る値・compat が home から読む）
  //   ★読めなければ**押し出さない**。0 で上書きすると振替で予約できなくなる
  var _tc = _edgeTransferCreditsAll();
  if (!_tc.ok) {
    Logger.log('⚠️ 残数の写しを押し出しません（振替権が読めないため）: ' + (_tc.error || ''));
    return [];   // 前の正しい写しを残す（keepStale なので消えない）
  }
  var tcAll = _tc.byCid;

  for (var i = 0; i < customerIds.length; i++) {
    // GASは1回の実行が6分で止められる。全員分を作りきれなくても、
    // そこまでを送って残りは次回に回す（残数は会員ごとに独立しているので部分更新でよい）。
    if (deadlineMs && Date.now() > deadlineMs) break;
    var cid = customerIds[i].id, name = customerIds[i].name;
    var cur = null, nxt = null;
    try { cur = _lbBuildHome(cid, name); } catch (e) { cur = null; }
    if (!cur) continue;
    try { nxt = _lbBuildHome(cid, name, null, nextMid.getTime()); } catch (e) { nxt = null; }
    rows.push({
      customer_id: cid,
      payload: JSON.stringify({ currentMonth: curKey, nextMonth: nextKey, current: cur, next: nxt,
                                //   ★振替権（顧客の画面に出る。写しに無いと常に0になる）
                                transferCredits: tcAll[cid] || { available: 0, nextExpiryMs: null, nextExpireLabel: '' } }),
      computed_at: Date.now()
    });
  }
  return rows;
}

// InBody・体重の記録。トレーナーが顧客を開いたときに出す（現在 maInBodyCard が3.5秒かかっている）。
function _edgeBodyRows() {
  var ss;
  try { ss = maOpenSs_(); } catch (e) { return []; }
  var sh = ss && ss.getSheetByName('body_log');
  if (!sh || sh.getLastRow() < 2) return [];
  var lastRow = sh.getLastRow();
  var from = Math.max(2, lastRow - 4000);          // 直近4000行だけ見る（既存の読み方に合わせる）
  var v = sh.getRange(from, 1, lastRow - from + 1, 11).getValues();
  var out = [];
  for (var i = 0; i < v.length; i++) {
    var cid = _edgeIdOrNull(v[i][0]);
    if (!cid) continue;
    var d = v[i][1];
    var ms = (d instanceof Date) ? d.getTime() : new Date(String(d)).getTime();
    if (!ms || isNaN(ms)) continue;
    out.push({
      // 同じ人・同じ日でも、測定元が違えば別の記録（体組成計とInBodyの両方がありうる）。
      //   測定元を入れないと互いを上書きし合い、押し出しのたびに内容が入れ替わる。
      record_id: cid + '_' + ms + '_' + String(v[i][7] || '-').replace(/[^A-Za-z0-9_-]/g, ''),
      customer_id: cid,
      measured_at: ms,
      weight_kg: Number(v[i][2]) || null,
      body_fat_pct: Number(v[i][3]) || null,
      muscle_kg: Number(v[i][4]) || null,
      note: String(v[i][7] || ''),                 // 測定元（inbody / scale）
      created_at: ms
    });
  }
  return out;
}

// 空き枠の写し。枠の作り方（吸着方式）はGASのまま、出来上がりをKVへ。
function _edgeSlotRows() {
  var entries = [];
  var list = (CALENDAR_IDS && CALENDAR_IDS.TRAINERS) || [];
  var rules = {
    leadMinutes: (SETTINGS && SETTINGS.BOOKING_LEAD_MINUTES) || 180,
    morningUntilHour: (SETTINGS && SETTINGS.MORNING_UNTIL_HOUR) || 12,
    prevDeadlineHour: (SETTINGS && SETTINGS.MORNING_PREV_DEADLINE_HOUR) || 22
  };
  for (var i = 0; i < list.length; i++) {
    var tid = String(list[i].id || '');
    if (!tid) continue;
    var slots = [];
    try {
      var r = getTrainerSlots({ trainerId: tid });
      var src = (r && r.slots) || [];
      for (var j = 0; j < src.length; j++) {
        var s = src[j];
        var ms = s.startISO ? new Date(s.startISO).getTime() : NaN;
        if (!ms || isNaN(ms)) continue;
        // 画面がそのまま描けるよう、GASが作った項目をそのまま持たせる。
        // startMs は Worker 側で締め切り判定に使う（毎回パースしないで済む）。
        slots.push({
          startMs: ms, startISO: s.startISO, endISO: s.endISO,
          date: s.date, dayOfWeek: s.dayOfWeek, startTime: s.startTime, endTime: s.endTime,
          trainerId: s.trainerId, trainerName: s.trainerName, trialOk: !!s.trialOk
        });
      }
    } catch (e) { continue; }   // 1人分が取れなくても他を止めない
    entries.push({ trainer_id: tid, payload: JSON.stringify({ trainerId: tid, slots: slots, rules: rules }), computed_at: Date.now() });
  }
  return entries;
}

// 押し出しの間だけ、シートの読み込みを1回で済ませる。
//
//   残数の計算は会員1人ごとに
//     ・顧客マスタ（電話番号を引くため）
//     ・顧客マスタ（登録月を引くため）
//     ・棚卸しシート（繰越の初期値を引くため）
//     ・予約シート
//   を丸ごと読み直している。39人×2ヶ月で200回を超える。
//
//   ここでは書き込みを一切しないので、1回読んだ内容を配り続けてよい。
//   ★ふるまいを変えないため、取り出し方（getRange→getValues）はそのまま真似る。
//     知らない操作は本物のシートへ素通しする。差し替えは finally で必ず戻す。
function _edgeWithSheetCache(fn) {
  var orig = (typeof _lbSheet === 'function') ? _lbSheet : null;
  if (!orig) return fn();
  var cache = {};

  function fake(name) {
    var real = orig(name);
    if (!real) return real;
    if (!cache[name]) {
      var lastRow = real.getLastRow(), lastCol = real.getLastColumn();
      var vals = (lastRow >= 1 && lastCol >= 1) ? real.getRange(1, 1, lastRow, lastCol).getValues() : [];
      cache[name] = { lastRow: lastRow, lastCol: lastCol, vals: vals, real: real };
    }
    var c = cache[name];

    // 知らない操作は本物のシートへ素通しする。
    //   ここで用意していないメソッド（getDataRange・createTextFinder など）が
    //   将来使われたとき、黙って失敗して残数だけ更新されない事故を防ぐ。
    function passThrough(target, real) {
      for (var k in real) {
        if (target[k] !== undefined) continue;
        if (typeof real[k] !== 'function') continue;
        (function (key) {
          target[key] = function () { return real[key].apply(real, arguments); };
        })(k);
      }
      return target;
    }

    var fakeRange = function (row, col, numRows, numCols) {
      var nr = (numRows == null) ? 1 : numRows;
      var nc = (numCols == null) ? 1 : numCols;
      var realRange = null;
      function real() {
        if (!realRange) realRange = c.real.getRange(row, col, numRows, numCols);
        return realRange;
      }
      var r = {
        getValues: function () {
          var out = [];
          for (var i = 0; i < nr; i++) {
            var src = c.vals[row - 1 + i] || [];
            var line = [];
            for (var j = 0; j < nc; j++) line.push(src[col - 1 + j]);
            out.push(line);
          }
          return out;
        },
        getValue: function () { var rr = c.vals[row - 1] || []; return rr[col - 1]; },
        getNumRows: function () { return nr; },
        getNumColumns: function () { return nc; },
        getRow: function () { return row; },
        getColumn: function () { return col; }
      };
      // 上記以外（getDisplayValues など）は本物へ回す
      return new Proxy(r, {
        get: function (t, k) {
          if (k in t) return t[k];
          var v = real()[k];
          return (typeof v === 'function') ? v.bind(real()) : v;
        }
      });
    };

    var fakeSheet = {
      getLastRow: function () { return c.lastRow; },
      getLastColumn: function () { return c.lastCol; },
      getName: function () { return name; },
      getRange: fakeRange,
      getDataRange: function () { return fakeRange(1, 1, c.lastRow, c.lastCol); }
    };
    return new Proxy(fakeSheet, {
      get: function (t, k) {
        if (k in t) return t[k];
        var v = c.real[k];
        return (typeof v === 'function') ? v.bind(c.real) : v;
      }
    });
  }

  try { _lbSheet = fake; return fn(); } finally { _lbSheet = orig; }
}

// 残数の計算は、会員1人ごとに予約シート全体を読み直している（39人×2ヶ月＝78回）。
// 押し出しの間だけ1回読んだ内容を使い回す。ここでは書き込みをしないので安全。
//   ※ この差し替えは finally で必ず戻す。GASは実行ごとに新しい場になるため、
//     仮に戻し損ねても次の実行には持ち越さない。
function _edgeWithResvCache(fn) {
  var orig = (typeof _lbResvSessions === 'function') ? _lbResvSessions : null;
  if (!orig) return fn();
  var vals;
  try {
    var sh = _lbSheet(LINE_BOOKING.RESV_SHEET);
    if (!sh) return fn();                       // 正本が無いときは元の挙動のまま（安全側）
    var last = sh.getLastRow();
    vals = (last < 2) ? [] : sh.getRange(2, 1, last - 1, Math.max(15, sh.getLastColumn())).getValues();
  } catch (e) { return fn(); }
  try {
    _lbResvSessions = function (customerId) {
      return _lbResvValsToSessions(vals, customerId, _lbParseResvDate);
    };
    return fn();
  } finally {
    _lbResvSessions = orig;
  }
}

// ============================================================
// 残数計算のための「入力の写し」
//
//   ★列に変換しない。契約シートの行と予約台帳の行を、そのまま写す。
//     変換すると意味がずれる余地ができる（終了日の空欄・繰越率の列なし・pack_idの有無）。
//     GASとWorkerで同じ関数に同じ形を渡せば、出力は必ず一致する。
//
//   ★顧客の紐付けはここ（GAS側）で済ませる。いまは氏名＋電話で照合しており、
//     その手順をWorkerへ移すのは危険なため。紐付けられない行は取り込まず、
//     同期を失敗させる（黙って落とさない）。
// ============================================================

// 契約シートの行を、顧客ごとに解決して写す
function _edgeCalcContracts(customers) {
  if (customers == null) throw new Error('顧客の元データが読めませんでした');
  var sh = _lbContractSheet();
  if (!sh) return null;                              // 読めなかった（0件ではない）
  var last = sh.getLastRow(); if (last < 2) return null;
  var lastCol = sh.getLastColumn();
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var cols = _lbContractCols(headers);
  if (cols.name < 0) throw new Error('契約シートに「お客様名」の列が見つかりません');

  var rows = [], meta = [], unresolved = 0;
  for (var c = 0; c < customers.length; c++) {
    var cid = customers[c].customer_id, name = customers[c].name;
    if (!cid || !name) continue;
    var hit;
    try { hit = _lbContractRowsAll(name, _lbPhoneByCustomerId(cid), false, cid); }
    catch (e) { throw new Error('契約の照合に失敗（' + name + '）: ' + e.message); }
    if (hit && hit.migrationGap) { unresolved++; continue; }   // 同名の未採番行が残る＝紐付けられない
    for (var i = 0; i < (hit || []).length; i++) {
      var rr = hit[i];
      rows.push({
        row_key: cid + '#' + rr.idx,
        customer_id: cid,
        idx: rr.idx,
        row_json: JSON.stringify(rr.row),
        start_ms: (rr.start && !isNaN(rr.start.getTime())) ? rr.start.getTime() : null,
        end_ms:   (rr.end   && !isNaN(rr.end.getTime()))   ? rr.end.getTime()   : null
      });
    }
  }
  if (unresolved) throw new Error('契約を紐付けられない会員が ' + unresolved + '名います（同名の未採番行）。取り込みを中止しました');

  // 列の位置と見出しの構成も一緒に写す。見出しが変われば計算が変わるため。
  meta.push({ key: 'contract_cols', payload: JSON.stringify({ cols: cols, headers: headers.map(String) }) });
  _edgeCalcContracts._meta = meta;
  return rows;
}

// 予約台帳の行をそのまま写す
function _edgeCalcReservations() {
  var sh = _lbSheet(LINE_BOOKING.RESV_SHEET);
  if (!sh) return null;                     // シートが無い／読めない＝送らない
  //   ★ヘッダだけ（予約0件）は**正常**なので空配列を返す（2026-10-08・Codex関門②）。
  //     null にすると「読めなかった」と同じ扱いになり、二重書きが永遠に進まない。
  //     送り先は0件＋全件走査のとき削除を止める作りなので、全体同期も安全。
  var last = sh.getLastRow(); if (last < 2) return [];
  var v = sh.getRange(2, 1, last - 1, Math.max(15, sh.getLastColumn())).getValues();
  var out = [];
  for (var i = 0; i < v.length; i++) {
    var r = v[i];
    var st = String(r[6] || '');
    if (st !== 'confirmed' && st !== 'consumed') continue;   // 残数に関わるのはこの2つだけ
    var cid = _edgeIdOrNull(r[2]);
    if (!cid) continue;                                      // 未紐付けは残数に関係しない
    var sid = String(r[11] == null ? '' : r[11]).replace(/^\s+|\s+$/g, '');
    var rid = String(r[8] == null ? '' : r[8]).split('|')[0].replace(/^\s+|\s+$/g, '');
    var key = sid || rid || (cid + '#' + i);
    // 日付はGASが解釈したミリ秒に直してから渡す（文字列のままだと解釈が環境で変わる）
    var d = _lbParseResvDate(r[0]);
    var copy = r.slice();
    copy[0] = (d && !isNaN(d.getTime())) ? d.getTime() : null;
    out.push({ row_key: key, customer_id: cid, row_json: JSON.stringify(copy) });
  }
  return out;
}

// 棚卸し（繰越の初期値）。39名中31名がこれに依存している。
function _edgeOpening(customers) {
  if (customers == null) throw new Error('顧客の元データが読めませんでした');
  var out = [];
  for (var i = 0; i < customers.length; i++) {
    var cid = customers[i].customer_id;
    if (!cid) continue;
    var op = null;
    try { op = _lbMemberOpeningWithFloor(cid); } catch (e) { op = null; }
    if (!op) continue;
    out.push({ customer_id: cid, payload: JSON.stringify(op) });
  }
  return out;
}

// ============================================================
// 押し出し本体
// ============================================================

function _edgePushHome(customers, batchId, t0, log, full) {
  if (customers == null) throw new Error('顧客の元データが読めませんでした（残数の押し出しを中止）');
  var all = [];
  for (var i = 0; i < customers.length; i++) {
    if (customers[i].contract_status === '退会') continue;
    all.push({ id: customers[i].customer_id, name: customers[i].name });
  }
  if (!all.length) return 0;

  // ★時間切れになったとき、次回は「続きから」始める。
  //   毎回先頭から始めると、後半の会員はいつまでも更新されない。
  var startAt = 0;
  try { startAt = Number(_edgeProp('EDGE_HOME_CURSOR') || 0) || 0; } catch (e) { startAt = 0; }
  if (startAt >= all.length || startAt < 0) startAt = 0;

  var ids = all.slice(startAt).concat(all.slice(0, startAt));   // 続きから一周する
  var deadline = t0 + EDGE.BUDGET_MS;
  var rows = _edgeWithSheetCache(function () {
    return _edgeWithResvCache(function () { return _edgeHomeRows(ids, deadline); });
  });

  var next = (startAt + rows.length) % all.length;
  try { PropertiesService.getScriptProperties().setProperty('EDGE_HOME_CURSOR', String(rows.length >= all.length ? 0 : next)); } catch (e) {}
  if (rows.length < all.length) {
    log.push('（残数は時間切れで ' + rows.length + '/' + all.length + ' 件。次回は ' + next + ' 番目から）');
  }
  // ★全員ぶん送れたときだけ 'all'。時間切れで途中までなら 'partial'（Codex指摘・2026-10-03）。
  //   「_pushToEdgeAllImpl から呼ばれた」ことは全件を見終えたことを意味しない。
  var _done = (rows.length >= all.length);
  return _edgePushRows('home', rows, batchId,
    { scope: _done ? 'all' : 'partial', deleteStale: !!full && _done });
}

// 契約や予約が変わった会員1人分だけを、その場で押し出す。
//   写しは15〜30分ごとに更新されるが、その間に予約すると残数がずれる。
//   予約・取消の直後にここを呼べば、その会員だけ即座に正しくなる。
//   ★成否を返す（2026-10-03）。画面は書き込みの直後、残数と枠をGASに直接聞く作りで、
//     その期間をここの結果で決める。失敗を黙って握りつぶすと、画面は
//     「写しが新しい」と信じて古い残数を出してしまう。
function pushToEdgeHomeFor(customerId, customerName) {
  if (!_edgeEnabled()) return false;
  try {
    var rows = _edgeHomeRows([{ id: String(customerId), name: String(customerName || '') }], 0);
    if (!rows.length) return false;                 // 作れなかった＝写しは直っていない
    _edgePushRows('home', rows, Date.now(), { scope: 'partial' });
    return true;
  } catch (e) { Logger.log('[edge] 残数の即時更新に失敗: ' + (e && e.message)); return false; }
}

// ============================================================
// 書き込みの直後に、その会員ぶんだけ写しを直す（2026-09-29）
//
//   写しは残数30分・予約15分・枠10分ごとにしか更新されない。
//   その間に予約や取消をすると、写しは古いままになる。
//   画面側にも「書き込み後35分はGASに聞く」印があるが、これは
//   書き込みをした端末にしか付かない。
//   スマホで予約してPCで開いた人、トレーナーが代行で予約した顧客には
//   印が付かず、予約前の残数や予約前の空き枠が見えてしまう。
//   だから端末ではなくサーバー側で直す。
//
//   ★ここで失敗しても、予約そのものは成功している。
//     例外は決して外へ出さない（写しの都合で予約を落とさない）。
// ============================================================

// 写しを直す必要がある操作。読み取りは入れない。
var EDGE_AFTER_WRITE = {
  line_makeReservationLine: 1, line_makeReservationLineProxy: 1,
  line_makeRecurringReservation: 1, line_makeBatchReservation: 1,
  line_makeBatchReservationProxy: 1, line_makeTransferReservation: 1,
  line_cancelReservation: 1, line_changeReservation: 1,
  line_makeAdminBooking: 1, line_makeBlock: 1, line_deleteAdminSlot: 1,
  line_addTicketRefill: 1, line_linkUnlinked: 1, line_selfRegister: 1,
  line_addRecurringPatternByTrainer: 1, line_deleteRecurringPattern: 1
};

function _edgeNameByCustomerId(customerId) {
  try {
    var sh = _lbSheet(LINE_BOOKING.MAP_SHEET);
    if (!sh || sh.getLastRow() < 2) return '';
    var v = sh.getRange(2, 1, sh.getLastRow() - 1, Math.max(MAP_COL.NAME, sh.getLastColumn())).getValues();
    for (var i = 0; i < v.length; i++) {
      if (String(v[i][MAP_COL.CUSTOMER_ID - 1] || '') === String(customerId)) {
        return String(v[i][MAP_COL.NAME - 1] || '');
      }
    }
  } catch (e) {}
  return '';
}

// その会員の予約だけを送り直す。含まれない行は消えない（削除は1日1回の完全同期だけ）。
function _edgePushReservationsFor(customerId) {
  var all = _edgeReservations();
  if (all == null) return false;                  // 読めなかった＝送らない（写しは直っていない）
  var mine = [];
  for (var i = 0; i < all.length; i++) {
    if (String(all[i].customer_id || '') === String(customerId)) mine.push(all[i]);
  }
  if (!mine.length) return 0;
  return _edgePushRows('reservations', mine, Date.now(), { scope: 'partial' });
}

// そのトレーナーの枠だけを送り直す。
function _edgePushSlotsFor(trainerId) {
  var all = _edgeSlotRows();
  if (all == null) return false;                  // 読めなかった＝送らない（写しは直っていない）
  var mine = [];
  for (var i = 0; i < all.length; i++) {
    if (String(all[i].trainer_id || '') === String(trainerId)) mine.push(all[i]);
  }
  if (!mine.length) return 0;
  return _edgePushRows('slots', mine, Date.now(), { scope: 'partial' });
}

// 振り分けの出口から呼ぶ。書き込みが成功したときだけ働く。
function edgeAfterWrite(action, params, res, lineUserId) {
  try {
    if (!_edgeEnabled()) return;
    if (!EDGE_AFTER_WRITE[String(action || '')]) return;
    if (!res || res.success !== true) return;     // 失敗した書き込みでは何も変わっていない

    // ★カレンダーが変わった操作なら、空き枠の元データ（D1のcalsync）も作り直す。
    //   ここで直接 pushCalSync を呼ばない（カレンダー5本を読むのでお客様を数秒待たせる）。
    //   1秒後の一回限りトリガーに逃がす。詳しくは下の「①-b 自動で回す」の節。
    //   ★会員が特定できなくても実行する。席の埋まりは「誰の操作か」とは無関係に変わるため、
    //     下の cid 判定より前に置く。
    if (EDGE_CALSYNC_AFTER[String(action || '')]) _lbScheduleCalSync();

    params = params || {};
    var cid = String(res.customerId || params.customerId || '');
    var nm  = String(res.customerName || '');
    if (!cid && lineUserId) {
      var m = getCustomerByLine(lineUserId);
      if (m) {
        cid = String(m.data[MAP_COL.CUSTOMER_ID - 1] || '');
        nm  = String(m.data[MAP_COL.NAME - 1] || '');
      }
    }
    if (!cid) { Logger.log('[edge] 書き込み後：会員が特定できず写しを直せません（' + action + '）'); return; }
    if (!nm) nm = _edgeNameByCustomerId(cid);

    // ★押し直しが済んだかを応答に載せる（2026-10-03・オーナーの指摘から）。
    //
    //   画面は書き込みの直後35分、残数と枠をWorkerではなくGASに直接聞く
    //   （自分が取った枠が「まだ空いている」と見えるのを防ぐため）。
    //   ところがここで、その方の残数・予約・空き枠をすぐ押し直している。
    //   **成功しているなら35分も待つ理由がない。**
    //   予約を終えた直後こそ「残りが減った」を見たい場面なのに、
    //   そこだけ遅いという、ちょうど逆の体験になっていた。
    //
    //   ★3つとも成功したときだけ真にする。1つでも落ちたら画面は待つ側に倒れる
    //     （遅いほうが、古い残数を見せるより良い）。
    // ★二重書き（2026-10-08・段階3-a）。
    //   計算入力と枠・引当の作り直しは**ここでやらない**（予約確定の応答を待たせない）。
    //   待ち行列に積み、速い道（1秒後）か心拍（15分ごと）が処理する。設計第4節。
    try { lbDwEnqueue(cid); } catch (e) { Logger.log('[dw] 積めませんでした: ' + (e && e.message)); }

    var _syncedHome = pushToEdgeHomeFor(cid, nm);                   // 残数
    var _syncedResv = (_edgePushReservationsFor(cid) !== false);    // その人の予約

    var tid = String(res.trainerId || params.trainerId || '');
    var _syncedSlots = true;
    if (tid) _syncedSlots = (_edgePushSlotsFor(tid) !== false);     // 空き枠

    if (res && typeof res === 'object') {
      res.edgeSynced = !!(_syncedHome && _syncedResv && _syncedSlots);
    }
  } catch (e) {
    // ★予約は成功している。写しの都合で失敗にしてはいけない。
    Logger.log('[edge] 書き込み後の写し更新に失敗: ' + (e && e.message));
  }
}

// 押し出し同士が重ならないようにする。
//   定期実行と手動実行が重なると、古い方が後から完了して新しい内容を巻き戻しうる。
function _edgeLocked(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { Logger.log('[edge] ほかの押し出しが動いているので今回は見送ります'); return; }
  try { return fn(); } finally { try { lock.releaseLock(); } catch (e) {} }
}

function pushToEdgeAll(withHome) {
  if (withHome === undefined) withHome = true;
  if (!_edgeEnabled()) { Logger.log('EDGE_PUSH_ON が 1 ではないので何もしません'); return; }
  return _edgeLocked(function () { return _pushToEdgeAllImpl(withHome, false); });
}

// 1日1回の完全同期。全行を書き直し、Google側から消えた行を消す。
//   ふだんの押し出しは「変わった行だけ」書くので、消す判断はここでまとめて行う。
function pushToEdgeFullSync() {
  if (!_edgeEnabled()) return;
  return _edgeLocked(function () { return _pushToEdgeAllImpl(true, true); });
}

function _pushToEdgeAllImpl(withHome, full) {
  var batchId = Date.now();
  var t0 = batchId, log = [];

  function step(name, fn) {
    var s = Date.now();
    try {
      var n = fn();
      log.push(name + ' ' + n + ' (' + (Date.now() - s) + 'ms)');
    } catch (e) {
      log.push('❌ ' + name + ' 失敗: ' + (e && e.message));
    }
  }

  var customers = _edgeCustomers();

  step('trainers',     function () { return _edgePushRowsF('trainers', _edgeTrainers(), batchId, { scope: 'all', deleteStale: full }); });
  step('customers',    function () { return _edgePushRowsF('customers', customers, batchId, { scope: 'all', deleteStale: full }); });
  step('reservations', function () { return _edgePushRowsF('reservations', _edgeReservations(), batchId, { scope: 'all', deleteStale: full }); });
  // ★固定枠だけは、ふだんの同期でも消す（2026-10-03・Codexの最終判定）。
  //   固定枠の削除はシートから行ごと消えるため、押し出す側に「消えた」という情報が残らない。
  //   日次4時の完全同期まで待つと、**削除したのに丸一日「まだ固定枠がある」と見える。**
  //   件数が少なく（顧客ごとに数件）、全件を毎回送っているので、ここで消して問題ない。
  //   元データが読めなかったときは _edgeRecurring が null を返して送信ごと中止する。
  //   0件だった場合は Worker 側が EMPTY_SOURCE で削除を止める（全消しを防ぐ）。
  //   ★0件でも消す（allowEmpty）。最後の1件を消したとき、次の同期は0件になる。
  //     受け取る側は事故を疑って0件では消さないので、ここで「本当に0件だ」と名乗らないと
  //     **最後の固定枠だけが永久に残る**（2026-10-03・Codexの再判定）。
  //     名乗ってよいのは、読めなかったときに null を返して送信ごと中止するから。
  step('recurring',    function () { return _edgePushRowsF('recurring', _edgeRecurring(), batchId, { scope: 'all', deleteStale: true, allowEmpty: true }); });
  step('slots',        function () { return _edgePushRowsF('slots', _edgeSlotRows(), batchId, { scope: 'all', deleteStale: full }); });
  step('body',         function () { return _edgePushRowsF('body', _edgeBodyRows(), batchId, { scope: 'all', deleteStale: full }); });
  // 残数計算の入力（シート読み込みは1回にまとめる）
  step('計算入力',      function () {
    return _edgeWithSheetCache(function () {
      var cr = _edgeCalcContracts(customers);
      var a = _edgePushRowsF('calcContracts', cr, batchId, { scope: 'all', deleteStale: full });
      var m = (_edgeCalcContracts._meta || []);
      if (m.length) _edgePushRowsF('calcMeta', m, batchId, { scope: 'all', deleteStale: full });
      var b = _edgePushRowsF('calcReservations', _edgeCalcReservations(), batchId, { scope: 'all', deleteStale: full });
      var o = _edgePushRowsF('opening', _edgeOpening(customers), batchId, { scope: 'all', deleteStale: full });
      return '契約' + a + ' / 予約' + b + ' / 棚卸し' + o;
    });
  });
  if (withHome) {
    step('home',       function () { return _edgePushHome(customers, batchId, t0, log, full); });
  }

  var _line = '[edge] ' + log.join(' / ') + ' 合計 ' + (Date.now() - t0) + 'ms';
  Logger.log(_line);
  return _line;
}

// 作業の受け渡しで使う版（文字列を返す）
function pushToEdgeAllText() {
  var r = pushToEdgeAll();
  return String(r == null ? '（EDGE_PUSH_ON が 1 ではないため何もしませんでした）' : r);
}

// 枠だけを短い間隔で押し出す（予約の反映を早くするため）
function pushToEdgeSlots() {
  if (!_edgeEnabled()) return;
  return _edgeLocked(_pushToEdgeSlotsImpl);
}
function _pushToEdgeSlotsImpl() {
  var batchId = Date.now();
  try {
    var n = _edgePushRowsF('slots', _edgeSlotRows(), batchId, { scope: 'all', deleteStale: false });
    Logger.log('[edge] 枠 ' + n);
  } catch (e) { Logger.log('[edge] 枠の押し出しに失敗: ' + (e && e.message)); }
}

// 残数を含まない押し出し。10秒程度で終わるので短い間隔で回せる。
function pushToEdgeLight() {
  // ★それぞれ別の try で囲む（2026-10-08・Codex関門②）。
  //   以前は押し出しのあとに二重書きを呼んでいた。**押し出しが落ちると
  //   二重書きの心拍まで届かない。**「15分ごとに必ず再送する」が嘘になる。
  try { pushToEdgeAll(false); } catch (e) { Logger.log('[edge] 押し出しで例外: ' + (e && e.message)); }
  try { _edgeHealJobTrigger(); } catch (e) { Logger.log('[edge] 見回りの回復で例外: ' + (e && e.message)); }
  // 二重書きの心拍：速い道（_lbCalSyncAfterWrite）が働かなかったぶんを15分ごとに拾う。
  //   新しいトリガーを作らないためにここへ相乗りする（上限20本・設計第4節）。
  try { lbDualWriteDrain(); } catch (e) { Logger.log('[dw] 心拍で例外: ' + (e && e.message)); }
}

// 見回り（1分ごと）が消えていたら作り直す。
//   見回りは連続して届かないと自分を止める（実行枠を守るため）。
//   そのままだと再開に人の手が要るので、既に動いているこの押し出しから戻す。
//   ★新しい入口は増えない。既存のトリガーから動くだけ。
function _edgeHealJobTrigger() {
  try {
    if (_edgeProp('EDGE_JOB_ON') !== '1') return;      // そもそも使っていない
    if (!_edgeProp('EDGE_URL') || !_edgeProp('EDGE_SECRET')) return;   // 設定が無ければ戻さない
    var all = ScriptApp.getProjectTriggers();
    for (var i = 0; i < all.length; i++) {
      if (all[i].getHandlerFunction() === 'edgeJobPoll') return;       // 生きている
    }
    ScriptApp.newTrigger('edgeJobPoll').timeBased().everyMinutes(1).create();
    PropertiesService.getScriptProperties().setProperty('EDGE_JOB_FAILS', '0');
    Logger.log('[edge] 見回りが止まっていたので戻しました');
  } catch (e) { /* 戻せなくても押し出しは止めない */ }
}

// 残数だけ
function pushToEdgeHome() {
  if (!_edgeEnabled()) return;
  return _edgeLocked(_pushToEdgeHomeImpl);
}
function _pushToEdgeHomeImpl() {
  var t0 = Date.now(), log = [];
  var customers = _edgeCustomers();
  try {
    var n = _edgePushHome(customers, t0, t0, log);
    Logger.log('[edge] 残数 ' + n + ' (' + (Date.now() - t0) + 'ms) ' + log.join(' '));
  } catch (e) { Logger.log('[edge] 残数の押し出しに失敗: ' + (e && e.message)); }
}

function setupEdgeTrigger() {
  var all = ScriptApp.getProjectTriggers();
  var mine = { pushToEdgeAll: 1, pushToEdgeSlots: 1, pushToEdgeLight: 1, pushToEdgeHome: 1, pushToEdgeFullSync: 1 };
  for (var i = 0; i < all.length; i++) {
    if (mine[all[i].getHandlerFunction()]) ScriptApp.deleteTrigger(all[i]);
  }
  // 残数は重いので分ける。GASの1日あたりの実行時間を使い切らないため。
  // D1の書き込みは1日10万行まで。ふだんは「変わった行だけ」書くので回数を増やしても軽いが、
  // 完全同期は全行を書くので1日1回だけにする。
  ScriptApp.newTrigger('pushToEdgeSlots').timeBased().everyMinutes(10).create();   // 枠
  ScriptApp.newTrigger('pushToEdgeLight').timeBased().everyMinutes(15).create();   // 残数以外
  ScriptApp.newTrigger('pushToEdgeHome').timeBased().everyMinutes(30).create();    // 残数
  ScriptApp.newTrigger('pushToEdgeFullSync').timeBased().atHour(4).everyDays(1).create();   // 完全同期（深夜4時）
  Logger.log('押し出しのトリガーを設定しました（枠10分 / 残数以外15分 / 残数30分 / 完全同期は毎日4時）');
}

// 疎通だけを確かめる。データは送らない。
function testEdgeConnectionText() {
  var out = [];
  var url = _edgeProp('EDGE_URL');
  if (!url) return 'EDGE_URL が未設定です';
  var res = UrlFetchApp.fetch(url.replace(/\/+$/, '') + '/health', { muteHttpExceptions: true });
  out.push('health: HTTP ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 300));
  try {
    _edgePost({ kind: 'slots', batchId: Date.now(), rows: [], final: true });   // 0件＝何も書き換えない
    out.push('合言葉の照合: OK（取り込み口に届きました）');
  } catch (e) {
    out.push('合言葉の照合: 失敗 — ' + (e && e.message));
  }
  return out.join('\n');
}

function testEdgeConnection() { Logger.log(testEdgeConnectionText()); }

// ============================================================
// ① カレンダー → D1（2026-10-02・設計書 ops/design/01-calendar-to-d1.md 第4版）
//
//   なぜGASが読むか：
//     当初はWorkerがサービスアカウントで直接カレンダーを読む設計だったが、
//     組織ポリシー（iam.disableServiceAccountKeyCreation）が鍵の作成を禁じていた。
//     ポリシーは緩めない。鍵を使わない方法（Workload Identity）もCloudflare Workers
//     からは結局自前の鍵が要るので目的を達しない。
//     そして①は移行期間だけの仕組みで、③（予約の正本をD1へ）が終われば向きが逆になり
//     消える。捨てるものに認証の仕組みを作り込まない。
//
//   顧客の速度は落ちない：
//     速度を決めるのは「顧客が読むときの経路」。D1に誰が書くかは待ち時間に影響しない。
//     むしろ予約直後は edgeAfterWrite が即座に押し出すので、定期取得だけの設計より速い。
//
//   ★ここでは分類の条件を書かない。コード.js の isShiftEvent / _lbIsBusyTitle /
//     _lbIsSessionTitle を呼ぶ。同じ条件を2か所に書くと必ず食い違う（2026-10-02に
//     体験予約で実際に起きた）。Worker側（worker/src/lib/calclass.js）とは
//     ハーネス（worker/test/calclass.test.js）が答えの一致を検査する。
// ============================================================

var LB_CALSYNC_RULE_VERSION = 1;   // 分類規則の版。規則を変えたら必ず上げる（世代が作り直される）

// 予定を「D1に入れる形」に直す。タイトルは入れない（会員の氏名が入るため）。
//   戻り値は { role, effect, reason } 。effect が ignore なら送らない。
function _calsyncClassify(role, title) {
  var t = String(title == null ? '' : title);

  if (role === 'capacity_b1') {
    // B1は席そのもの。「[消化]で始まるか」だけで決まり、それ以外はすべて埋まり（fail-closed）。
    if (t.indexOf('[消化]') === 0) return { effect: 'ignore', reason: 'consumed' };
    return { effect: 'room_busy', reason: 'room' };
  }

  if (role === 'capacity_1f') {
    // ★1Fは「部屋が埋まる」ではない（2026-10-02 修正）。
    //   1Fはオンライン・体験用で、B1の席は使わない。塞ぐのは**担当トレーナーだけ**。
    //   GAS側の _lb1FTrainerBusy と同じ読み方にする：
    //     ・予約として読めない予定は無視（1Fの非予約は容量に数えない）
    //     ・担当が分かればそのトレーナーを塞ぐ
    //     ・担当が分からなければ全員を塞ぐ（fail-closed。二重予約を作らない）
    //   ここを room_busy で一括りにすると、1Fのオンライン1件でB1の枠が全部消える。
    if (t.indexOf('[消化]') === 0) return { effect: 'ignore', reason: 'consumed' };
    var cls1f = _calsync1FClassify(t);
    if (!cls1f.parsed) return { effect: 'ignore', reason: 'other' };
    if (cls1f.trainerId) return { effect: 'busy', reason: 'online', trainerId: cls1f.trainerId };
    return { effect: 'room_busy', reason: 'online_unknown' };   // 担当不明＝全員を塞ぐ
  }

  // トレーナー。評価順はシフトが最優先（コード.js の buildAvailableSlots と同じ）。
  if (isShiftEvent(t)) return { effect: 'shift', reason: 'shift' };
  if (!_lbIsBusyTitle(t)) return { effect: 'ignore', reason: 'other' };
  // 埋まりの内訳（なぜ埋まっているか）。タイトルは残さないので、理由だけ持つ。
  var reason = 'reserved';
  if (t.indexOf('休憩') >= 0) reason = 'break';
  else if (t.indexOf('ブロック') >= 0) reason = 'block';
  return { effect: 'busy', reason: reason };
}

// 1Fの予定から担当トレーナーを読む。GAS側の _lb1FTrainerBusy と同じ判定を使う
//   （_lbClassifyBooking。条件を書き写さない）。
function _calsync1FClassify(title) {
  var surToId = {};
  for (var i = 0; i < CALENDAR_IDS.TRAINERS.length; i++) {
    var tr = CALENDAR_IDS.TRAINERS[i];
    surToId[_lbNormTok(tr.name.split(' ')[0])] = tr.id;
  }
  var copts = { b1Id: CALENDAR_IDS.CAPACITY_B1, oneFId: CALENDAR_IDS.CAPACITY_1F,
                surToId: surToId, isMember: function () { return false; } };
  try {
    var cls = _lbClassifyBooking(String(title), CALENDAR_IDS.CAPACITY_1F, copts);
    return { parsed: !!cls.parsed, trainerId: cls.trainerId || '' };
  } catch (e) {
    // 読めなければ「担当不明の予約」として扱う＝全員を塞ぐ（fail-closed）
    return { parsed: true, trainerId: '' };
  }
}

// 中身が前回と同じかを判定するための印。
//   ★並び順で変わらないようにしてから作る。カレンダーAPIの返す順は保証されない。
function _calsyncHash(rows) {
  var keys = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    keys.push([r.calendarId, r.eventId, r.effect, r.reason, r.startAt, r.endAt, r.allDay].join('|'));
  }
  keys.sort();
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
                                       keys.join('\n'), Utilities.Charset.UTF_8);
  var hex = '';
  for (var d = 0; d < digest.length; d++) {
    var b = (digest[d] + 256) % 256;
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}

// 取得するカレンダーの一覧（役割つき）。構成が変わったら世代を作り直すため、送って比べる。
function _calsyncCalendars() {
  var list = [{ calendarId: CALENDAR_IDS.CAPACITY_B1, role: 'capacity_b1' }];
  // ★1Fは LB_1F_TRAINER_BLOCK が on のときだけ送る（2026-10-02）。
  //   1Fはオンライン・体験用で、B1の席は使わない。フラグが off のあいだは
  //   空き枠の計算に入れない仕様（コード.js の buildAvailableSlots と同じ）。
  //   なのに送ってしまうと、読み取り側が「room_busy なら塞がる」と素朴に書いた瞬間、
  //   off のはずの1Fの予定でB1の枠が消える。送らなければその誤りが起きようがない。
  //   フラグを on にすると flag_1f が変わるので、世代は自動で作り直される。
  if (CALENDAR_IDS.CAPACITY_1F && _calsyncUse1F()) {
    list.push({ calendarId: CALENDAR_IDS.CAPACITY_1F, role: 'capacity_1f' });
  }
  for (var i = 0; i < CALENDAR_IDS.TRAINERS.length; i++) {
    var tr = CALENDAR_IDS.TRAINERS[i];
    list.push({ calendarId: tr.email, role: 'trainer', trainerId: tr.id });
  }
  return list;
}

// 1Fを空き枠の計算に入れるか。コード.js の判定をそのまま使う（条件を書き写さない）。
function _calsyncUse1F() {
  return (typeof _lb1FBlockEnabled === 'function') && _lb1FBlockEnabled();
}

// カレンダー全量を読んで、D1へ押し出す形を作る（読み取りだけ・送信はしない）。
//   送る前にこの関数だけを実行すれば、何を送ることになるかを確認できる。
function buildCalSyncPayload(nowMs) {
  var now = (nowMs != null) ? new Date(nowMs) : new Date();
  var horizonEnd = _lbBookingHorizonEnd(now);
  // 地平の始まりは当日0時（設計書 §2）。過去の予定は空き枠に影響しないが、
  //   「当日の朝からの埋まり」を取りこぼさないために0時から取る。
  var horizonStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);

  var cals = _calsyncCalendars();
  var events = [], invalid = [];

  for (var c = 0; c < cals.length; c++) {
    var cal = null;
    try { cal = CalendarApp.getCalendarById(cals[c].calendarId); } catch (e) { cal = null; }
    if (!cal) {
      // ★1つでも読めなければ、その回は送らない（部分的な世代を作らない）。
      //   読めないカレンダーの予定が「無い」ことになると、席が空いていると誤判断する。
      return { ok: false, code: 'CALENDAR_UNREADABLE', calendarId: cals[c].calendarId };
    }
    var evs;
    try { evs = cal.getEvents(horizonStart, horizonEnd); }
    catch (e2) { return { ok: false, code: 'CALENDAR_FETCH_FAILED', detail: String(e2.message).slice(0, 120) }; }

    for (var j = 0; j < evs.length; j++) {
      var ev = evs[j];
      var cls = _calsyncClassify(cals[c].role, ev.getTitle());
      if (cls.effect === 'ignore') continue;          // 空き枠に影響しないものは持たない

      var s = ev.getStartTime(), e3 = ev.getEndTime();
      var sMs = s ? s.getTime() : null, eMs = e3 ? e3.getTime() : null;
      var id = '';
      try { id = String(ev.getId() || ''); } catch (eId) { id = ''; }

      // 壊れた予定は送らずに「壊れていた」と伝える。黙って捨てると、日時変換の
      //   不具合が「予定が無い」に化けて席が空いていることになる。
      if (!id) { invalid.push({ calendarId: cals[c].calendarId, eventId: '', reason: 'NO_EVENT_ID' }); continue; }
      if (sMs == null || eMs == null || !isFinite(sMs) || !isFinite(eMs)) {
        invalid.push({ calendarId: cals[c].calendarId, eventId: id, reason: 'NOT_INTEGER_MS' }); continue;
      }
      if (eMs < sMs) { invalid.push({ calendarId: cals[c].calendarId, eventId: id, reason: 'REVERSED' }); continue; }
      if (eMs === sMs) { invalid.push({ calendarId: cals[c].calendarId, eventId: id, reason: 'ZERO_WIDTH' }); continue; }

      // ★繰り返し予定は、各回で getId() が同じ値を返す（GASの仕様）。
      //   出勤シフトを毎週の繰り返しで入れていると、全部が同じIDになって重複する。
      //   開始時刻を足して回ごとに一意にする。これなら「同じ予定の別の回」と
      //   「本当に重複している予定」を区別できる（後者は Worker が DUPLICATE_EVENT で弾く）。
      var uid = id + '#' + String(sMs);

      var allDay = 0;
      try { allDay = ev.isAllDayEvent() ? 1 : 0; } catch (eA) { allDay = 0; }

      events.push({
        calendarId: cals[c].calendarId,
        eventId: uid,
        role: cals[c].role,
        // 1Fは予定ごとに担当が変わる。カレンダーの担当（トレーナーcal）より優先する。
        trainerId: cls.trainerId || cals[c].trainerId || null,
        effect: cls.effect,
        reason: cls.reason,
        startAt: sMs,
        endAt: eMs,
        allDay: allDay
      });
    }
  }

  // 送る前に重複を見つける。Workerに弾かれてから原因を探すより、ここで分かる方が早い。
  var seen = {}, dups = 0;
  for (var k = 0; k < events.length; k++) {
    var key = events[k].calendarId + '|' + events[k].eventId;
    if (seen[key]) { dups++; invalid.push({ calendarId: events[k].calendarId, eventId: events[k].eventId, reason: 'DUPLICATE' }); }
    seen[key] = true;
  }
  if (dups) {
    // 重複したまま送ると世代ごと拒否される。送らずに知らせる。
    return { ok: false, code: 'DUPLICATE_EVENTS', detail: dups + '件が重複しています', invalid: invalid };
  }

  return {
    ok: true,
    horizonStart: horizonStart.getTime(),
    horizonEnd: horizonEnd.getTime(),
    ruleVersion: LB_CALSYNC_RULE_VERSION,
    flag1f: _calsyncUse1F() ? 'on' : 'off',
    // ★固定枠の持ち主（hidden なトレーナー）の曜日×時間帯（2026-10-03）。
    //   Worker側がこれを持っていないと、その人の枠が本来出ない曜日・時間にも出る。
    //   世代の一部として保存し、読み取り側が同じ条件で絞れるようにする。
    //   未設定なら null（制限なし）。
    ownerWindow: _lbOwnerSlotWindow(),
    // 読み終えた時刻。遅れて届いた押し出しで鮮度を偽らないための印。
    //   3分前に読んだ内容がいま届くと、確認時刻が「いま」になって古い内容が新鮮に見える。
    pushedAt: now.getTime(),
    calendars: cals,
    events: events,
    contentHash: _calsyncHash(events),
    invalid: invalid
  };
}

// D1へ送る。1分ごとのトリガーと、予約の確定直後から呼ぶ。
//   ★何が起きたかを必ずログに出す。出さないとGASエディタで実行しても
//     「実行開始／実行完了」しか出ず、成功したのか途中で止まったのか分からない。
//     2026-10-02、まさにそれで切り分けに往復した。
function pushCalSync() {
  if (!_edgeEnabled()) {
    Logger.log('⛔ calsync 中止: EDGE_PUSH_ON が 1 ではありません'
               + '（GASエディタ → ⚙プロジェクトの設定 → スクリプト プロパティ で確認してください）');
    return { ok: false, code: 'EDGE_OFF' };
  }
  var p = buildCalSyncPayload();
  if (!p.ok) { Logger.log('⛔ calsync 中止: ' + p.code + ' ' + (p.calendarId || p.detail || '')); return p; }

  var url = _edgeProp('EDGE_URL'), secret = _edgeProp('EDGE_SECRET');
  if (!url || !secret) {
    Logger.log('⛔ calsync 中止: EDGE_URL / EDGE_SECRET が未設定です');
    return { ok: false, code: 'EDGE_NOT_CONFIGURED' };
  }
  Logger.log('calsync: ' + p.events.length + '件を送ります（壊れていた予定 ' + p.invalid.length + '件）');
  var res = UrlFetchApp.fetch(url.replace(/\/+$/, '') + '/calsync', {
    method: 'post', contentType: 'application/json',
    headers: { 'X-Ingest-Secret': secret },
    payload: JSON.stringify(p), muteHttpExceptions: true
  });
  var code = res.getResponseCode(), text = res.getContentText();
  if (code !== 200) {
    Logger.log('❌ calsync 失敗 HTTP ' + code + ': ' + text.slice(0, 400));
    return { ok: false, code: 'HTTP_' + code, body: text.slice(0, 400) };
  }
  var out = {};
  try { out = JSON.parse(text); } catch (e) { out = {}; }
  // 何が起きたかを人が読める形で出す
  if (out.unchanged) {
    Logger.log('✅ calsync: 中身は前回と同じ（世代は増やさず、確認時刻だけ更新）世代=' + (out.generation || '?'));
  } else if (out.status === 'rejected') {
    Logger.log('⚠️ calsync: 検査に引っかかって公開していません。理由=' + JSON.stringify(out.reasons || out.reason || out));
    Logger.log('   公開中の世代はそのままです（壊れたものは出しません）。');
  } else {
    Logger.log('✅ calsync: 公開しました 世代=' + (out.generation || '?') + ' / 状態=' + (out.status || '?')
               + ' / 送った予定=' + p.events.length + '件');
    if (out.warnings && out.warnings.length) Logger.log('   ⚠ 警告: ' + JSON.stringify(out.warnings));
  }
  return { ok: true, result: out, sent: p.events.length, invalid: p.invalid.length };
}

// 何を送ることになるかを、送らずに確認する（GASエディタ用）。
function calSyncPreview() {
  var p = buildCalSyncPayload();
  var out = [];
  out.push('===== カレンダー → D1 に送る内容（送信しません）=====');
  if (!p.ok) { out.push('⛔ 中止: ' + p.code + ' ' + (p.calendarId || p.detail || '')); Logger.log(out.join('\n')); return; }
  out.push('地平: ' + Utilities.formatDate(new Date(p.horizonStart), SETTINGS.TIMEZONE, 'yyyy/MM/dd HH:mm')
           + ' 〜 ' + Utilities.formatDate(new Date(p.horizonEnd), SETTINGS.TIMEZONE, 'yyyy/MM/dd HH:mm'));
  out.push('規則の版: ' + p.ruleVersion + ' ／ 1Fフラグ: ' + p.flag1f);
  out.push('カレンダー: ' + p.calendars.length + '件');
  out.push('送る予定: ' + p.events.length + '件');
  var byEffect = {}, byReason = {};
  for (var i = 0; i < p.events.length; i++) {
    byEffect[p.events[i].effect] = (byEffect[p.events[i].effect] || 0) + 1;
    byReason[p.events[i].reason] = (byReason[p.events[i].reason] || 0) + 1;
  }
  var ke = []; for (var k in byEffect) ke.push(k + ' ' + byEffect[k] + '件');
  var kr = []; for (var k2 in byReason) kr.push(k2 + ' ' + byReason[k2] + '件');
  out.push('  効果の内訳: ' + ke.join(' / '));
  out.push('  理由の内訳: ' + kr.join(' / '));
  out.push('中身の印: ' + p.contentHash.slice(0, 16) + '…');
  out.push('壊れていた予定: ' + p.invalid.length + '件'
           + (p.invalid.length ? '（' + p.invalid.map(function (x) { return x.reason; }).join(',') + '）' : ''));
  out.push('');
  out.push('※ タイトルは送りません（会員の氏名が入るため）。時刻と分類だけです。');
  Logger.log(out.join('\n'));
}

// ============================================================
// ①-b カレンダー → D1 の同期を自動で回す（2026-10-02・設計書 ops/design/01-calendar-to-d1.md 第4版）
//
//   誰が呼ぶか（設計書「誰が呼ぶか」）：
//     ・1分ごとの時間主導トリガー … lbCalSyncTick（カレンダー全量を読んでD1へ押し出す）
//     ・予約の確定・変更・取消 … edgeAfterWrite から、その場で押し出す
//
//   ★なぜ予約の処理の中で直接 pushCalSync を呼ばないか（顧客の待ち時間を増やさないため）：
//     edgeAfterWrite は handleLineGet の中＝お客様が答えを待っている最中に同期で動く
//     （LineBooking.js：res を作ったあと、return の直前）。
//     pushCalSync はカレンダー5本を地平の終わりまで読むので数秒かかる。そこへ足すと
//     予約の応答がそのぶん遅くなり、LIFFの20秒制限にも近づく。
//     そこで会員登録後の同期（_lbScheduleSyncAfterRegister）と同じ作法を使う：
//       「1秒後の一回限りトリガー」を作って別の実行に逃がす。作るのは数十ミリ秒。
//     押し出しは1〜2秒後に別実行で走るので、顧客の応答は遅くならず、反映はほぼ即時。
//     ★トリガーを作れなくても（上限20件・一時的な失敗）予約は通る。1分ごとの同期が
//       最大60秒後に拾うだけ。だから作成の失敗は例外にせずログに残す。
//
//   止めかた（押し出し全体は止めずに、同期だけ止める）：
//     ・LB_CALSYNC_ON を '0' にする … トリガーは残るが何もしない（すぐ戻せる）
//     ・stopCalSyncTrigger() … トリガーごと外す
//     ・EDGE_PUSH_ON が '1' でなければ、そもそも何も動かない（押し出し全体の元栓）
//
//   ★ここでは pushCalSync / buildCalSyncPayload / calSyncPreview の中身を変えない。呼ぶだけ。
// ============================================================

var LB_CALSYNC = {
  EVERY_MINUTES: 5,            // 定期の間隔（分）。無料アカウントの実行枠に合わせる
  ON_PROP:       'LB_CALSYNC_ON',        // '0' のときだけ止まる（未設定は EDGE_PUSH_ON に従う）
  LAST_OK_PROP:  'LB_CALSYNC_LAST_OK',   // 最後に成功した時刻（ミリ秒）
  FAILS_PROP:    'LB_CALSYNC_FAILS',     // 連続して失敗した回数
  LAST_ERR_PROP: 'LB_CALSYNC_LAST_ERR',  // 最後の失敗の理由（個人情報は入らない）
  TICK_HANDLER:  'lbCalSyncTick',        // 1分ごとに呼ばれる関数
  AFTER_HANDLER: '_lbCalSyncAfterWrite', // 予約直後に一度だけ呼ばれる関数
  STALE_MS:      15 * 60000              // 15分以上成功していなければ「止まっている」と見なす
};

// 予約の直後にカレンダー同期をやり直す操作。
//   ★カレンダーの予定が変わるものだけを挙げる。残数や紐付けだけが変わる操作
//     （チケット追加・会員登録・未紐付けの解消）は席の埋まりを変えないので入れない。
//   もし取りこぼしても、1分ごとの同期が最大60秒で追いつく（安全側に倒れる）。
var EDGE_CALSYNC_AFTER = {
  line_makeReservationLine: 1, line_makeReservationLineProxy: 1,
  line_makeRecurringReservation: 1, line_makeBatchReservation: 1,
  line_makeBatchReservationProxy: 1, line_makeTransferReservation: 1,
  line_cancelReservation: 1, line_changeReservation: 1,
  line_makeAdminBooking: 1, line_makeBlock: 1, line_deleteAdminSlot: 1,
  line_addRecurringPatternByTrainer: 1, line_deleteRecurringPattern: 1
};

function _calsyncSetProp(k, v) {
  try { PropertiesService.getScriptProperties().setProperty(k, String(v)); } catch (e) {}
}

// 同期を動かしてよいか。押し出し全体の元栓（EDGE_PUSH_ON）と、同期だけの栓（LB_CALSYNC_ON）。
function _calsyncAutoOn() {
  if (!_edgeEnabled()) return false;                       // 押し出し全体が止まっている
  return _edgeProp(LB_CALSYNC.ON_PROP) !== '0';            // 既定は動く（'0' のときだけ止める）
}

// ------------------------------------------------------------
// 1分ごとの入口。トリガーからも、予約直後の一回限りトリガーからも、ここを通す。
//   記録（成功時刻・連続失敗）と重なり防止を1か所にまとめるため。
// ------------------------------------------------------------
function lbCalSyncTick() {
  if (!_edgeEnabled()) return { ok: false, code: 'EDGE_OFF' };          // 元栓が閉じている（静かに終わる）
  if (_edgeProp(LB_CALSYNC.ON_PROP) === '0') return { ok: false, code: 'CALSYNC_OFF' };

  // 同期同士が重ならないようにする（1分ごとの実行と、予約直後の実行がぶつかりうる）。
  //   ★押し出し本体の _edgeLocked（スクリプトロック）は使わない。1分ごとに数秒握ると、
  //     10分ごとの枠の押し出しがロック待ちで見送られる。別のロックで同期だけを直列化する。
  var lock = null;
  try { lock = LockService.getUserLock(); } catch (e) { lock = null; }
  if (lock) {
    var got = false;
    try { got = lock.tryLock(2000); } catch (e2) { got = true; lock = null; }   // ロックが使えない環境では止めない
    if (!got) { Logger.log('[calsync] 前の同期がまだ動いているので今回は見送ります'); return { ok: false, code: 'BUSY' }; }
  }

  var r = null;
  try {
    r = pushCalSync();                                     // ★中身は変えない。呼ぶだけ
  } catch (e3) {
    r = { ok: false, code: 'EXCEPTION', detail: String((e3 && e3.message) || e3).slice(0, 200) };
    Logger.log('❌ calsync で例外: ' + r.detail);
  } finally {
    if (lock) { try { lock.releaseLock(); } catch (e4) {} }
  }
  _calsyncNote(r);
  return r;
}

// 実行の記録。1分ごとに回るので「失敗が続いていること」に気づけなければ意味がない。
function _calsyncNote(r) {
  try {
    if (r && r.ok) {
      _calsyncSetProp(LB_CALSYNC.LAST_OK_PROP, Date.now());
      if (_edgeProp(LB_CALSYNC.FAILS_PROP) && _edgeProp(LB_CALSYNC.FAILS_PROP) !== '0') {
        _calsyncSetProp(LB_CALSYNC.FAILS_PROP, '0');
      }
      return;
    }
    var code = String((r && r.code) || 'UNKNOWN');
    var n = Number(_edgeProp(LB_CALSYNC.FAILS_PROP) || 0) + 1;
    _calsyncSetProp(LB_CALSYNC.FAILS_PROP, n);
    _calsyncSetProp(LB_CALSYNC.LAST_ERR_PROP, code + ' / ' + new Date().toISOString());
    Logger.log('[calsync] 失敗（連続' + n + '回目・理由 ' + code + '）');

    // 設定が足りない失敗は、回り続けても直らない。1分ごとに失敗して実行枠を食うだけなので
    //   同期だけ止める（押し出し全体は触らない）。setupCalSyncTrigger で再開できる。
    if (code === 'EDGE_NOT_CONFIGURED') {
      _calsyncSetProp(LB_CALSYNC.ON_PROP, '0');
      Logger.log('[calsync] ⛔ EDGE_URL / EDGE_SECRET が未設定のため同期を止めました。設定後に setupCalSyncTrigger() を実行してください。');
      return;
    }
    // 10回（＝約10分）連続で失敗したら、以後は60回ごとに強く出す（ログが埋まらない程度に鳴らし続ける）。
    if (n === 10 || (n > 10 && n % 60 === 0)) {
      Logger.log('[calsync] ⚠️ ' + n + '回続けて失敗しています。公開中の世代は古いままです（理由 ' + code + '）。'
                 + ' calSyncStatus() で状態を確認してください。');
    }
  } catch (e) { /* 記録に失敗しても同期は止めない */ }
}

// ------------------------------------------------------------
// 予約の確定・変更・取消の直後（edgeAfterWrite から呼ばれる）
//   1秒後の一回限りトリガーに逃がす。お客様の応答を遅くしないため。
// ------------------------------------------------------------
function _lbCleanCalSyncAfterTriggers() {
  try {
    var ts = ScriptApp.getProjectTriggers();
    for (var i = 0; i < ts.length; i++) {
      if (ts[i].getHandlerFunction() === LB_CALSYNC.AFTER_HANDLER) ScriptApp.deleteTrigger(ts[i]);
    }
  } catch (e) { Logger.log('[calsync] 予約直後トリガーの掃除に失敗: ' + (e && e.message)); }
}

function _lbCalSyncAfterWrite() {
  try { lbCalSyncTick(); }
  catch (e) { Logger.log('[calsync] 予約直後の同期に失敗（1分ごとの同期で追いつきます）: ' + (e && e.message)); }
  // ★二重書きの速い道（2026-10-08・段階3-a）。
  //   このトリガーは予約系の書き込みの1秒後に一度だけ動く。そこへ相乗りする。
  //   失敗しても待ち行列に残るので、心拍（15分ごと）が拾う。
  try { lbDualWriteDrain(); }
  catch (e) { Logger.log('[dw] 速い道で例外（心拍で追いつきます）: ' + (e && e.message)); }
  _lbCleanCalSyncAfterTriggers();   // 役目を終えたら自分を消す（トリガー上限20件に溜めない）
}

// ★ここで例外を外へ出してはいけない。予約は既に成立している。
// 一回限りトリガーが作れなかったことを記録する。
//   ★ログだけでは誰も気づけない。原因はほぼ「上限20本に当たった」。
//     その状態では二重書きの速い道も黙って止まる。
function _lbNoteTriggerFail(where, err) {
  try {
    var p = PropertiesService.getScriptProperties();
    var arr = [];
    try { arr = JSON.parse(p.getProperty('LB_TRIGGER_FAIL') || '[]'); } catch (e) { arr = []; }
    if (Object.prototype.toString.call(arr) !== '[object Array]') arr = [];
    arr.unshift({ at: Date.now(), where: String(where || ''), msg: String((err && err.message) || '').slice(0, 120) });
    arr = arr.slice(0, 20);
    p.setProperty('LB_TRIGGER_FAIL', JSON.stringify(arr));
  } catch (e) { Logger.log('トリガー作成の失敗を記録できませんでした: ' + (e && e.message)); }
}

function _lbScheduleCalSync() {
  if (!_calsyncAutoOn()) return false;
  try {
    // 同時刻に複数の予約が入っても1本にまとめる（同期は全量を読み直すので1回で足りる）
    _lbCleanCalSyncAfterTriggers();
    ScriptApp.newTrigger(LB_CALSYNC.AFTER_HANDLER).timeBased().after(1000).create();
    return true;
  } catch (e) {
    // 作れなくても予約は通る。1分ごとの同期が最大60秒で拾う。
    Logger.log('[calsync] 予約直後の同期を予約できませんでした（1分ごとの同期で反映されます）: ' + (e && e.message));
    //   ★作れなかったことを記録する（2026-10-09）。
    //     いままでログだけで、**誰も気づけなかった。**
    //     作れない原因はほぼ「トリガーが上限（20本）に当たった」。
    //     その状態では二重書きの速い道も黙って止まり、心拍（15分）まで遅れる。
    //     一時的なら害は小さいが、**続いていれば上限の問題なので知る必要がある。**
    _lbNoteTriggerFail('calsyncAfter', e);
    return false;
  }
}

// ------------------------------------------------------------
// トリガーの登録／解除（★オーナーがGASエディタで1回実行する）
// ------------------------------------------------------------
function setupCalSyncTrigger() {
  // 設定が揃っていなければ始めない。1分ごとに失敗し続けるのを防ぐ（setupEdgeJobTrigger と同じ考え方）。
  if (!_edgeProp('EDGE_URL') || !_edgeProp('EDGE_SECRET')) {
    Logger.log('❌ EDGE_URL / EDGE_SECRET が未設定です。スクリプト プロパティに登録してから実行してください。');
    return;
  }
  var all = ScriptApp.getProjectTriggers(), removed = 0;
  for (var i = 0; i < all.length; i++) {
    var h = all[i].getHandlerFunction();
    // 重複登録を防ぐ。pushCalSync を直接登録してしまった場合も外す（二重に走らせない）。
    if (h === LB_CALSYNC.TICK_HANDLER || h === 'pushCalSync') { ScriptApp.deleteTrigger(all[i]); removed++; }
  }
  // ★5分ごと（2026-10-02 変更）。1分ごとにすると無料アカウントの実行枠を超える。
  //   1440回/日 × 3〜5秒 ＝ 1日72〜120分。無料の上限は90分/日で、しかも
  //   edgeJobPoll も1分ごとに動いている。枠を使い切ると**リマインド・予約通知・
  //   残数の押し出しが全部止まる**。顧客に届く通知が止まるのが最悪なので、
  //   同期の粒度を落とす側を選ぶ。
  //   粗くしても実害が小さいのは、予約・変更・取消の直後は一回限りトリガーで
  //   即座に押し出すため。定期が拾うのは「カレンダーの直接編集」だけで、
  //   そこは最大5分の遅れを許容できる（いまのキャッシュは11分なので改善になる）。
  ScriptApp.newTrigger(LB_CALSYNC.TICK_HANDLER).timeBased()
    .everyMinutes(LB_CALSYNC.EVERY_MINUTES).create();
  _calsyncSetProp(LB_CALSYNC.ON_PROP, '1');
  _calsyncSetProp(LB_CALSYNC.FAILS_PROP, '0');
  Logger.log('✅ カレンダー → D1 の同期を' + LB_CALSYNC.EVERY_MINUTES + '分ごとに設定しました（' + LB_CALSYNC.TICK_HANDLER + '）'
             + (removed ? '／古い登録 ' + removed + '件を外しました' : ''));
  Logger.log('   予約の確定・変更・取消の直後にも、1秒後の一回限りトリガーで押し出します。');
  Logger.log('   元栓 EDGE_PUSH_ON = ' + (_edgeEnabled() ? '1（動きます）' : '1 ではありません（このままでは何も送りません）'));
  Logger.log('   同期だけ止めるときは LB_CALSYNC_ON を 0 に／トリガーごと外すときは stopCalSyncTrigger()。');
  Logger.log('   状態の確認は calSyncStatus()。');
}

function stopCalSyncTrigger() {
  _calsyncSetProp(LB_CALSYNC.ON_PROP, '0');
  var all = ScriptApp.getProjectTriggers(), removed = 0;
  for (var i = 0; i < all.length; i++) {
    var h = all[i].getHandlerFunction();
    if (h === LB_CALSYNC.TICK_HANDLER || h === LB_CALSYNC.AFTER_HANDLER) { ScriptApp.deleteTrigger(all[i]); removed++; }
  }
  Logger.log('カレンダー同期を止めました（外したトリガー ' + removed + '件・LB_CALSYNC_ON=0）。'
             + '押し出し全体（EDGE_PUSH_ON）は触っていません。');
}

// ------------------------------------------------------------
// 状態（日次点検から相乗りできる形で返す。個人情報は含まない）
// ------------------------------------------------------------
function calSyncHealth() {
  var on = _calsyncAutoOn();
  var lastOk = Number(_edgeProp(LB_CALSYNC.LAST_OK_PROP) || 0);
  var ageMs = lastOk ? (Date.now() - lastOk) : null;
  var alive = false;
  try {
    var all = ScriptApp.getProjectTriggers();
    for (var i = 0; i < all.length; i++) {
      if (all[i].getHandlerFunction() === LB_CALSYNC.TICK_HANDLER) { alive = true; break; }
    }
  } catch (e) {}
  return {
    on: on,
    triggerAlive: alive,
    lastOkMs: lastOk || null,
    ageMin: (ageMs == null) ? null : Math.round(ageMs / 60000),
    fails: Number(_edgeProp(LB_CALSYNC.FAILS_PROP) || 0),
    lastError: _edgeProp(LB_CALSYNC.LAST_ERR_PROP),
    // 動かしているつもりなのに成功が途絶えている＝空き枠が古いまま配られている
    stale: !!(on && (lastOk === 0 || (ageMs != null && ageMs > LB_CALSYNC.STALE_MS)))
  };
}

function calSyncStatus() {
  var h = calSyncHealth();
  var out = ['===== カレンダー → D1 同期の状態 ====='];
  out.push('同期: ' + (h.on ? '動かす設定' : '止めている（EDGE_PUSH_ON か LB_CALSYNC_ON）'));
  out.push('1分ごとのトリガー: ' + (h.triggerAlive ? 'あり' : 'なし（setupCalSyncTrigger() を実行してください）'));
  out.push('最後に成功: ' + (h.lastOkMs ? (h.ageMin + '分前') : 'まだ成功していません'));
  out.push('連続失敗: ' + h.fails + '回' + (h.lastError ? '（最後の理由 ' + h.lastError + '）' : ''));
  if (h.stale) out.push('⚠️ 15分以上成功していません。公開中の世代が古いままです。');
  Logger.log(out.join('\n'));
  return h;
}

// ============================================================
// ① の仕上げ：GASの空き枠とD1の空き枠を突き合わせる（2026-10-03）
//
//   完了条件は「GASとD1が同じ答えを出すこと」。手元のテストでは52件すべて
//   一致しているが、本番のカレンダーには想定外の形が必ずある。
//
//   ★7日間待たずに済ませる（2026-10-03 オーナー提案）。
//     いまのカレンダーのデータで「いま」をずらしながら計算すれば、
//     本来7日かけても踏めるとは限らない状況を**狙って踏める**：
//       ・25日の翌月解放  ・月またぎで地平が伸びる瞬間
//       ・締め切りの境界（午前枠の前日22時／他は開始180分前）
//     両方が同じデータ・同じ時点で計算するので、一致すべきである。
//
//   ★送るのは時刻とトレーナーIDだけ。氏名もタイトルも送らない。
// ============================================================

// 突き合わせを1回ぶん送る。nowMsOpt を渡すと、その時点として計算する。
//   nowMsOpt を渡したとき（＝時点をずらした突き合わせ）は sweep:true を付ける。
//   Worker側は「時計がずれている」要求を既定で拒否するが、ここは意図してずらすため。
function pushCalCompare(nowMsOpt) {
  if (!_edgeEnabled()) return { ok: false, code: 'EDGE_OFF' };
  var url = _edgeProp('EDGE_URL'), secret = _edgeProp('EDGE_SECRET');
  if (!url || !secret) return { ok: false, code: 'EDGE_NOT_CONFIGURED' };

  var nowMs = (nowMsOpt != null) ? Number(nowMsOpt) : new Date().getTime();

  // ★比べる範囲は「実時刻の地平」に固定する（2026-10-03）。
  //   D1の地平は押し出した時点（＝実時刻）で決まる。時点をずらすと、
  //   ずらした時点の地平（例：1日前なら前日0時から／25日なら翌月末まで）が
  //   D1の地平からはみ出し、**比較そのものが成立しない**（horizon で落ちる）。
  //   実際、最初の実行で10時点が horizon で止まった。
  //   範囲は固定し、ずらすのは「いま」だけにする。
  //   ★この結果、25日の解放や月末の地平の伸びは比較できない（範囲がD1にない）。
  //     そこは実際にその日が来たときに確認する。範囲を無理に広げてD1側の地平を
  //     動かすと、公開中の世代を壊すので採らない。
  var realNow = new Date();
  var horizonEnd = _lbBookingHorizonEnd(realNow);
  var fromMs = new Date(realNow.getFullYear(), realNow.getMonth(), realNow.getDate(), 0, 0, 0).getTime();
  var toMs = horizonEnd.getTime();

  // ★GASの答え。ここは本番と同じ関数を使う（別の実装で作ると比較の意味がない）。
  var slots;
  try { slots = buildAvailableSlots(null, nowMs) || []; }
  catch (e) { Logger.log('⛔ 突き合わせ中止: 空き枠を作れません: ' + e.message); return { ok: false, code: 'BUILD_FAILED' }; }

  // 送るのは3つだけ。氏名・タイトル・顧客情報は入れない。
  var payload = {
    fromMs: fromMs, toMs: toMs,
    ruleVersion: LB_CALSYNC_RULE_VERSION,
    flag1f: _calsyncUse1F() ? 'on' : 'off',
    nowMs: nowMs,
    trainers: CALENDAR_IDS.TRAINERS.map(function (t) { return { id: t.id, hidden: !!t.hidden }; }),
    ownerWindow: _lbOwnerSlotWindow(),
    requiredCalendars: _calsyncCalendars(),
    sweep: (nowMsOpt != null),      // 時点をずらしているときだけ true
    slots: slots.map(function (s) {
      return { startMs: new Date(s.startISO).getTime(), trainerId: s.trainerId, trialOk: s.trialOk !== false };
    })
  };

  var res = UrlFetchApp.fetch(url.replace(/\/+$/, '') + '/calcompare', {
    method: 'post', contentType: 'application/json',
    headers: { 'X-Ingest-Secret': secret },
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  var code = res.getResponseCode(), text = res.getContentText();
  if (code !== 200) { Logger.log('❌ 突き合わせ失敗 HTTP ' + code + ': ' + text.slice(0, 300)); return { ok: false, code: 'HTTP_' + code }; }
  var out = {};
  try { out = JSON.parse(text); } catch (e) { out = {}; }
  return { ok: true, result: out, gasSlots: slots.length };
}

// 1分ごとの同期のあとに、そのまま突き合わせる。
//   ★押し出した直後に比べる。別のタイミングで比べると、D1が最大7分古いせいで
//     「カレンダー変更直後の時間差」が大量の不一致として記録され、本当の実装差が埋もれる。
function lbCalSyncAndCompare() {
  var sync = pushCalSync();
  if (!sync || !sync.ok) return sync;
  var cmp = pushCalCompare();
  if (cmp && cmp.ok && cmp.result) {
    var r = cmp.result;
    if (r.compared === false) Logger.log('突き合わせ: 比較できませんでした（' + r.reason + '）');
    else Logger.log('突き合わせ: ' + (r.matched ? '✅ 一致' : '❌ 食い違い')
                    + ' GAS ' + r.gasCount + '件 / D1 ' + r.d1Count + '件');
  }
  return { sync: sync, compare: cmp };
}

// ------------------------------------------------------------
// 一括の突き合わせ（オーナーがGASエディタで1回実行する）
//
//   時点をずらして何度も比べる。7日間の観察の代わりになる。
//   ★カレンダーを何度も読むので重い。GASの実行時間（6分）に収まるよう、
//     既定では時点を絞ってある。足りなければ日を分けて実行する。
// ------------------------------------------------------------
function calCompareSweep() {
  Logger.log(calCompareSweepText());
}

function calCompareSweepText() {
  var out = [];
  function say(x) { out.push(x); }
  var now = new Date(), nowMs = now.getTime();

  say('===== GASとD1の空き枠を、時点をずらして突き合わせます =====');
  say('版: ' + LB_CALSYNC_RULE_VERSION + ' ／ 1Fフラグ: ' + (_calsyncUse1F() ? 'on' : 'off'));
  say('※ 送るのは時刻とトレーナーIDだけ。氏名もタイトルも送りません。');
  say('');

  if (!_edgeEnabled()) { say('⛔ EDGE_PUSH_ON が 1 ではありません'); return out.join('\n'); }

  // まず、いまの状態をD1へ押し出す。これをしないと「古いD1」と比べることになる。
  var sync = pushCalSync();
  if (!sync || !sync.ok) {
    say('⛔ 先にD1へ押し出す段で止まりました: ' + ((sync && sync.code) || '不明'));
    return out.join('\n');
  }
  say('D1へ押し出しました（' + (sync.sent || 0) + '件）');
  say('');

  // 狙って踏みたい時点。カレンダーのデータは「いま」のものを使い、
  //   計算の基準時刻だけをずらす。両方が同じデータ・同じ時点で計算する。
  var day = 24 * 60 * 60 * 1000;
  var points = [];
  points.push({ label: 'いま', ms: nowMs });
  for (var d = 1; d <= 7; d++) points.push({ label: d + '日前', ms: nowMs - d * day });
  // 月のかたちが変わる時点（25日の翌月解放・月末・月初）
  //   ★これらは「その時点の地平」がD1の地平と違うため、比較できないことがある。
  //     比較できるかは Worker が判定する（horizon）。出しておいて、
  //     できなかったものは理由とともに一覧に残す（黙って消さない）。
  var y = now.getFullYear(), mo = now.getMonth();
  points.push({ label: '今月25日 10時（翌月の解放）', ms: new Date(y, mo, 25, 10, 0, 0).getTime() });
  points.push({ label: '今月24日 10時（解放の前日）', ms: new Date(y, mo, 24, 10, 0, 0).getTime() });
  points.push({ label: '月末 23時', ms: new Date(y, mo + 1, 0, 23, 0, 0).getTime() });
  points.push({ label: '翌月1日 9時', ms: new Date(y, mo + 1, 1, 9, 0, 0).getTime() });
  // 締め切りの境界（午前枠は前日22時・他は開始180分前）
  points.push({ label: '今日 22時（午前枠の締め切り）', ms: new Date(y, mo, now.getDate(), 22, 0, 0).getTime() });
  points.push({ label: '今日 21時59分', ms: new Date(y, mo, now.getDate(), 21, 59, 0).getTime() });

  var okCount = 0, ngCount = 0, skipCount = 0, details = [];
  for (var i = 0; i < points.length; i++) {
    var p = points[i];
    var cmp;
    try { cmp = pushCalCompare(p.ms); } catch (e) { cmp = { ok: false, code: 'EXCEPTION', detail: e.message }; }

    if (!cmp || !cmp.ok) {
      ngCount++;
      say('  ❌ ' + p.label + ' … 送れませんでした（' + ((cmp && cmp.code) || '不明') + '）');
      continue;
    }
    var r = cmp.result || {};
    if (r.compared === false) {
      skipCount++;
      say('  ⏭ ' + p.label + ' … 比較できず（' + r.reason + '）');
      continue;
    }
    if (r.matched) {
      okCount++;
      say('  ✅ ' + p.label + ' … 一致（' + r.gasCount + '枠）');
    } else {
      ngCount++;
      say('  ❌ ' + p.label + ' … 食い違い（GAS ' + r.gasCount + ' / D1 ' + r.d1Count + '）');
      // どのトレーナーで、どの時間帯が違うか
      var trs = r.trainers || [];
      for (var t = 0; t < trs.length; t++) {
        if (trs[t].matched) continue;
        var c = trs[t].counts || {};
        details.push('     ' + p.label + ' / ' + trs[t].trainerId
          + '：GASだけ ' + (c.onlyGas || 0) + '件 ／ D1だけ ' + (c.onlyD1 || 0) + '件'
          + ' ／ 体験の可否 ' + (c.trial || 0) + '件');
        if ((trs[t].onlyGas || []).length) details.push('       GASだけ: ' + trs[t].onlyGas.slice(0, 5).join(' / '));
        if ((trs[t].onlyD1 || []).length) details.push('       D1だけ: ' + trs[t].onlyD1.slice(0, 5).join(' / '));
      }
    }
  }

  say('');
  say('────── 結果 ──────');
  say('  一致 ' + okCount + ' / 食い違い ' + ngCount + ' / 比較できず ' + skipCount
      + '（全 ' + points.length + ' 時点）');
  if (details.length) {
    say('');
    say('■ 食い違いの中身');
    for (var k = 0; k < details.length; k++) say(details[k]);
  }
  say('');
  if (ngCount > 0) {
    say('⛔ 食い違いがあります。切り替える前に、上の中身を潰してください。');
  } else if (okCount === 0) {
    say('⛔ 1つも比較できていません。切り替えの判断材料がありません。');
  } else if (skipCount === 0) {
    say('✅ すべての時点で一致しました。読み取りをD1へ切り替える判断材料が揃っています。');
  } else {
    // 比較できた分はすべて一致している。できなかった分の理由で意味が変わる。
    say('△ 比較できた ' + okCount + ' 時点はすべて一致しました（食い違い 0）。');
    say('   比較できなかった ' + skipCount + ' 時点は、理由を見て判断してください。');
    say('     horizon … その時点の地平がD1の範囲外。**実装の問題ではない**。');
    say('               25日の解放・月末の地平の伸びは、その日が来たときに確認する。');
    say('     stale   … D1が古い。押し出しの直後に実行し直す。');
    say('     rule / flag / calendars … 設定が食い違っている。先にそこを揃える。');
  }
  return out.join('\n');
}

// ============================================================
// 任意の月を検証する（D1に触らない・2026-10-03 オーナー提案）
//
//   D1経由の突き合わせは、D1が持っている地平の中しか比べられない。
//   地平は「いま」で決まるので、**25日の翌月解放や月末の地平の伸び**を比べられなかった。
//   かといって9月のデータをD1へ押し出すと、公開中の世代が9月になって本番が壊れる。
//
//   だから予定をそのまま送り、Workerに同じ計算をさせて比べる。
//   **D1には一切触らない**ので本番は無傷のまま、過ぎた月の実データで確かめられる。
//   9月は実際に25日の解放が起きた月なので、そのときの形をそのまま検証できる。
// ============================================================

// 指定した期間の予定を読んで、D1に入れる形に直す（押し出しはしない）。
function _calsyncEventsFor(fromDate, toDate) {
  var cals = _calsyncCalendars();
  var events = [], invalid = [];
  for (var c = 0; c < cals.length; c++) {
    var cal = null;
    try { cal = CalendarApp.getCalendarById(cals[c].calendarId); } catch (e) { cal = null; }
    if (!cal) return { ok: false, code: 'CALENDAR_UNREADABLE', calendarId: cals[c].calendarId };
    var evs;
    try { evs = cal.getEvents(fromDate, toDate); }
    catch (e2) { return { ok: false, code: 'CALENDAR_FETCH_FAILED', detail: String(e2.message).slice(0, 120) }; }

    for (var j = 0; j < evs.length; j++) {
      var ev = evs[j];
      var cls = _calsyncClassify(cals[c].role, ev.getTitle());
      if (cls.effect === 'ignore') continue;
      var s = ev.getStartTime(), e3 = ev.getEndTime();
      var sMs = s ? s.getTime() : null, eMs = e3 ? e3.getTime() : null;
      var id = ''; try { id = String(ev.getId() || ''); } catch (eId) { id = ''; }
      if (!id) { invalid.push({ reason: 'NO_EVENT_ID' }); continue; }
      if (sMs == null || eMs == null || !isFinite(sMs) || !isFinite(eMs)) { invalid.push({ reason: 'NOT_INTEGER_MS' }); continue; }
      if (eMs <= sMs) { invalid.push({ reason: eMs < sMs ? 'REVERSED' : 'ZERO_WIDTH' }); continue; }
      var allDay = 0; try { allDay = ev.isAllDayEvent() ? 1 : 0; } catch (eA) { allDay = 0; }
      events.push({
        calendarId: cals[c].calendarId, eventId: id + '#' + String(sMs),
        role: cals[c].role, trainerId: cls.trainerId || cals[c].trainerId || null,
        effect: cls.effect, reason: cls.reason,
        startAt: sMs, endAt: eMs, allDay: allDay
      });
    }
  }
  return { ok: true, events: events, invalid: invalid };
}

// 1つの時点について、D1を使わずに突き合わせる。
function _calCompareDirectAt(nowMs, fromMs, toMs, events) {
  var url = _edgeProp('EDGE_URL'), secret = _edgeProp('EDGE_SECRET');
  if (!url || !secret) return { ok: false, code: 'EDGE_NOT_CONFIGURED' };

  var slots;
  try { slots = buildAvailableSlots(null, nowMs) || []; }
  catch (e) { return { ok: false, code: 'BUILD_FAILED', detail: e.message }; }

  var payload = {
    fromMs: fromMs, toMs: toMs, nowMs: nowMs,
    trainers: CALENDAR_IDS.TRAINERS.map(function (t) { return { id: t.id, hidden: !!t.hidden }; }),
    ownerWindow: _lbOwnerSlotWindow(),
    events: events,
    slots: slots.map(function (s) {
      return { startMs: new Date(s.startISO).getTime(), trainerId: s.trainerId, trialOk: s.trialOk !== false };
    })
  };
  var res = UrlFetchApp.fetch(url.replace(/\/+$/, '') + '/calcompare/direct', {
    method: 'post', contentType: 'application/json',
    headers: { 'X-Ingest-Secret': secret },
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  var code = res.getResponseCode(), text = res.getContentText();
  if (code !== 200) return { ok: false, code: 'HTTP_' + code, body: text.slice(0, 300) };
  var out = {}; try { out = JSON.parse(text); } catch (e) { out = {}; }
  return { ok: true, result: out };
}

// 過ぎた月を検証する。オーナーがGASエディタで実行する。
//   月を変えたいときは下の ym を書き換える（'2026-09' の形）。
function calCompareMonth() {
  var ym = '2026-09';          // ← 検証したい月
  Logger.log(calCompareMonthText(ym));
}

function calCompareMonthText(ym) {
  var out = [];
  function say(x) { out.push(x); }
  var m = String(ym || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return '月を YYYY-MM の形で指定してください（例 2026-09）。';
  var y = Number(m[1]), mo = Number(m[2]) - 1;

  say('===== ' + ym + ' の空き枠を突き合わせます（D1には触りません）=====');
  say('※ 予定をそのまま送り、Workerに同じ計算をさせて比べます。');
  say('   本番のD1は無傷のままです。過ぎた月の実データで確かめられます。');
  say('');

  if (!_edgeEnabled()) { say('⛔ EDGE_PUSH_ON が 1 ではありません'); return out.join('\n'); }

  // その月の予定をまとめて1回だけ読む（時点ごとに読み直すとAPIを無駄に叩く）
  var monthStart = new Date(y, mo, 1, 0, 0, 0);
  var monthEnd = new Date(y, mo + 2, 1, 0, 0, 0);   // 翌月末まで（25日の解放で翌月が見えるため）
  var got = _calsyncEventsFor(monthStart, monthEnd);
  if (!got.ok) { say('⛔ 予定を読めません: ' + got.code + ' ' + (got.calendarId || got.detail || '')); return out.join('\n'); }
  say('読んだ予定: ' + got.events.length + '件（壊れていた予定 ' + got.invalid.length + '件）');
  say('');

  // その月に起きた「月のかたちが変わる瞬間」を狙う
  var points = [
    { label: ym + '-01 09時（月初）', d: new Date(y, mo, 1, 9, 0, 0) },
    { label: ym + '-10 12時（平常時）', d: new Date(y, mo, 10, 12, 0, 0) },
    { label: ym + '-20 10時（シフト提出）', d: new Date(y, mo, 20, 10, 0, 0) },
    { label: ym + '-24 10時（解放の前日）', d: new Date(y, mo, 24, 10, 0, 0) },
    { label: ym + '-25 10時（★翌月の解放）', d: new Date(y, mo, 25, 10, 0, 0) },
    { label: ym + '-25 23時（解放日の夜）', d: new Date(y, mo, 25, 23, 0, 0) },
    { label: '月末 12時', d: new Date(y, mo + 1, 0, 12, 0, 0) },
    { label: '月末 23時', d: new Date(y, mo + 1, 0, 23, 0, 0) },
    { label: '翌月1日 9時', d: new Date(y, mo + 1, 1, 9, 0, 0) }
  ];

  var okCount = 0, ngCount = 0, details = [];
  for (var i = 0; i < points.length; i++) {
    var p = points[i], nowMs = p.d.getTime();
    // ★その時点の地平で比べる。D1を使わないので、範囲を固定する必要がない。
    //   これが D1経由では比べられなかった「月のかたちが変わる瞬間」を見る鍵。
    var hEnd = _lbBookingHorizonEnd(p.d);
    var fromMs = new Date(p.d.getFullYear(), p.d.getMonth(), p.d.getDate(), 0, 0, 0).getTime();
    var toMs = hEnd.getTime();

    var r;
    try { r = _calCompareDirectAt(nowMs, fromMs, toMs, got.events); }
    catch (e) { r = { ok: false, code: 'EXCEPTION', detail: e.message }; }

    if (!r || !r.ok) {
      ngCount++;
      say('  ❌ ' + p.label + ' … 送れませんでした（' + ((r && r.code) || '不明') + '）');
      continue;
    }
    var x = r.result || {};
    if (x.matched) {
      okCount++;
      say('  ✅ ' + p.label + ' … 一致（' + x.gasCount + '枠）');
    } else {
      ngCount++;
      say('  ❌ ' + p.label + ' … 食い違い（GAS ' + x.gasCount + ' / D1 ' + x.d1Count + '）');
      var trs = x.trainers || [];
      for (var t = 0; t < trs.length; t++) {
        if (trs[t].matched) continue;
        var c = trs[t].counts || {};
        details.push('     ' + p.label + ' / ' + trs[t].trainerId
          + '：GASだけ ' + (c.onlyGas || 0) + '件 ／ D1だけ ' + (c.onlyD1 || 0) + '件'
          + ' ／ 体験の可否 ' + (c.trial || 0) + '件');
        if ((trs[t].onlyGas || []).length) details.push('       GASだけ: ' + trs[t].onlyGas.slice(0, 5).join(' / '));
        if ((trs[t].onlyD1 || []).length) details.push('       D1だけ: ' + trs[t].onlyD1.slice(0, 5).join(' / '));
      }
    }
  }

  say('');
  say('────── 結果 ──────');
  say('  一致 ' + okCount + ' / 食い違い ' + ngCount + '（全 ' + points.length + ' 時点）');
  if (details.length) {
    say('');
    say('■ 食い違いの中身');
    for (var k = 0; k < details.length; k++) say(details[k]);
  }
  say('');
  if (ngCount === 0) {
    say('✅ ' + ym + ' のすべての時点で一致しました。');
    say('   月のかたちが変わる瞬間（25日の解放・月末・月初）も含めて確認できています。');
  } else {
    say('⛔ 食い違いがあります。切り替える前に、上の中身を潰してください。');
  }
  say('');
  say('※ この検証は分類と空き枠の計算を見るものです。');
  say('   D1の読み書き・鮮度判定・世代の公開は calCompareSweep の責務です。両方が要ります。');
  return out.join('\n');
}

// ============================================================
// 枠を作る（段階3-a の土台・2026-10-07）
// ============================================================
//   Worker の /quota/build を呼んで、契約から monthly_quota / ticket_packs を作る。
//
//   ★なぜGASから呼ぶのか
//     Workerの窓口は合言葉（EDGE_SECRET）で守ってある。合言葉を持っているのはGASだけ。
//     CEOは secrets を読めないので、作業依頼（job）→GAS→Worker の順で辿る。
//
//   ★既定は「書かない」
//     Worker側も dry が既定だが、ここでも明示する。
//     枠はすべての残数の土台で、間違えると全員の残数が動く。
//
//   ★人数で区切って、続きがある限り繰り返す
//     会員1人につきWorkerが5本のクエリを投げる。一度に回すとサブリクエスト上限に当たる。
//     next が返る限り after を進める。1回の実行で止まっても、同じ after からやり直せる
//     （枠の書き込みは UPSERT で used に触れないため、二度処理しても壊れない）。
function _edgeQuotaBuild(opts) {
  var o = opts || {};
  var url = _edgeProp('EDGE_URL');
  var secret = _edgeProp('EDGE_SECRET');
  if (!url || !secret) throw new Error('EDGE_URL / EDGE_SECRET が未設定です');
  var base = url.replace(/\/+$/, '');

  // ★Worker側の指定は dry（1=書かない / 0=書く）。こちらは write で受けて変換する。
  //   名前が違うので、どちらを見ているかを取り違えないよう明示しておく。
  var dry = (o.write === true) ? '0' : '1';          // ★既定は書かない（write を明示したときだけ 0）
  var alloc = (o.alloc === true) ? '1' : '';         // 引当も作るか（枠だけ作ると used が0のまま）
  var from = String(o.from || '');
  var to = String(o.to || '');
  var limit = Math.max(1, Math.min(Number(o.limit || 5) || 5, 8));
  var maxPages = Math.max(1, Math.min(Number(o.maxPages || 12) || 12, 40));   // 1回の実行で回す上限

  var after = String(o.after || '');
  var total = { pages: 0, customers: 0, monthlyRows: 0, packRows: 0, allocRows: 0, overflow: 0, wrote: 0,
                skipped: [], issues: [], lastAfter: after, done: false };

  for (var p = 0; p < maxPages; p++) {
    var q = '?dry=' + dry + '&limit=' + limit + '&after=' + encodeURIComponent(after)
          + (alloc ? '&alloc=1' : '')
          + (from ? '&from=' + encodeURIComponent(from) : '')
          + (to ? '&to=' + encodeURIComponent(to) : '');
    var res = UrlFetchApp.fetch(base + '/quota/build' + q, {
      method: 'get',
      headers: { 'X-Ingest-Secret': secret },
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    var text = res.getContentText();
    if (code !== 200) throw new Error('quota/build が失敗（HTTP ' + code + '・after=' + after + '）: ' + text.slice(0, 200));

    var r = JSON.parse(text);
    total.pages++;
    total.customers += Number(r.customers || 0);
    total.monthlyRows += Number(r.monthlyRows || 0);
    total.packRows += Number(r.packRows || 0);
    total.allocRows += Number(r.allocRows || 0);
    total.overflow += Number(r.overflow || 0);
    total.wrote += Number(r.wrote || 0);
    // 問題は全部ためる（件数だけだと、何が起きたか分からない）
    for (var i = 0; i < (r.skipped || []).length; i++) total.skipped.push(r.skipped[i]);
    for (var j = 0; j < (r.issues || []).length; j++) total.issues.push(r.issues[j]);

    if (r.done || !r.next) { total.done = true; break; }
    after = String(r.next);
    total.lastAfter = after;
    Utilities.sleep(200);   // Workerを急かさない
  }
  return total;
}

// いまD1に入っている枠を数える（書き込みの結果を、報告ではなく実物で確かめる）。
//   ★「何件作れるか」と「何件入っているか」は別のこと。
//     作る側の報告だけを見ると、書けていなくても気づけない。
function _edgeQuotaStatus(query) {
  var url = _edgeProp('EDGE_URL');
  var secret = _edgeProp('EDGE_SECRET');
  if (!url || !secret) throw new Error('EDGE_URL / EDGE_SECRET が未設定です');
  //   query（例 '?shadow=1'）を付けられるようにした（2026-10-09・shadow の心拍）。
  //   ★新しいルートを足さず、既存の窓口に寄せる方針に合わせる。
  var q = query ? String(query) : '';
  var res = UrlFetchApp.fetch(url.replace(/\/+$/, '') + '/quota/status' + q, {
    method: 'get', headers: { 'X-Ingest-Secret': secret }, muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code !== 200) throw new Error('quota/status が失敗（HTTP ' + code + '）: ' + res.getContentText().slice(0, 200));
  return JSON.parse(res.getContentText());
}

// D1の枠と引当から出した残数が、計算と一致するかを突き合わせる（2026-10-07）。
//   ★「D1を正本にしてよいか」はここが一致するかで決まる。
//     正本にするとは、残数を計算で出すのをやめて**行から読む**こと。
//     行から読んだ値が計算と違えば、顧客の残数が変わる。
function _edgeQuotaVerify(opts) {
  var o = opts || {};
  var url = _edgeProp('EDGE_URL');
  var secret = _edgeProp('EDGE_SECRET');
  if (!url || !secret) throw new Error('EDGE_URL / EDGE_SECRET が未設定です');
  var base = url.replace(/\/+$/, '');
  var limit = Math.max(1, Math.min(Number(o.limit || 5) || 5, 8));
  var maxPages = Math.max(1, Math.min(Number(o.maxPages || 12) || 12, 40));
  var month = String(o.month || '');
  var after = String(o.after || '');
  var total = { pages: 0, checked: 0, agree: 0, differ: 0, skipped: 0, diffs: [],
                skippedWhy: {}, orphans: null, overUsedPacks: 0, overUsedMonths: 0, coverageMissing: 0,
                staleCoverage: null, quotaInvariantBroken: null, lastAfter: after, done: false,
                //   ★主キーの集合の照合（2026-10-09・設計13）。
                //     残数が一致しても、別の月・別のパックに入れ替わっていれば一致しない。
                //     **切り替えの合格条件はこちら。** 走った数（keyChecked）も見る
                //     ＝「0件だから一致」と読ませないため。
                keyMismatch: 0, keyChecked: 0, keyRangeMissing: 0, keyDetail: [] };

  for (var p = 0; p < maxPages; p++) {
    var q = '?limit=' + limit + '&after=' + encodeURIComponent(after) + (month ? '&month=' + encodeURIComponent(month) : '');
    var res = UrlFetchApp.fetch(base + '/quota/verify' + q, {
      method: 'get', headers: { 'X-Ingest-Secret': secret }, muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) throw new Error('quota/verify が失敗（HTTP ' + res.getResponseCode() + '・after=' + after + '）: ' + res.getContentText().slice(0, 200));
    var r = JSON.parse(res.getContentText());
    total.pages++;
    total.checked += Number(r.checked || 0);
    total.agree += Number(r.agree || 0);
    total.differ += Number(r.differ || 0);
    total.skipped += Number(r.skipped || 0);
    total.overUsedPacks += Number(r.overUsedPacks || 0);
    total.overUsedMonths += Number(r.overUsedMonths || 0);
    total.coverageMissing += Number(r.coverageMissing || 0);
    total.keyMismatch += Number(r.keyMismatch || 0);
    total.keyChecked += Number(r.keyChecked || 0);
    total.keyRangeMissing += Number(r.keyRangeMissing || 0);
    //   詳細は増えすぎないように20件で止める。数（keyMismatch）は止めない。
    for (var k2 = 0; k2 < (r.keyMismatchDetail || []).length; k2++) {
      if (total.keyDetail.length < 20) total.keyDetail.push(r.keyMismatchDetail[k2]);
    }
    //   表全体の検査は最後のページでだけ返る。返ってきた値をそのまま採る（足さない）。
    if (r.staleCoverage != null) total.staleCoverage = Number(r.staleCoverage);
    if (r.quotaInvariantBroken != null) total.quotaInvariantBroken = Number(r.quotaInvariantBroken);
    for (var i = 0; i < (r.diffs || []).length; i++) total.diffs.push(r.diffs[i]);
    //   比べられなかった理由と、D1にだけ残った行（孤児）もためる。
    //   ★孤児は最後のページでしか返らないので、上書きでよい。
    for (var w in (r.skippedWhy || {})) if (r.skippedWhy.hasOwnProperty(w)) {
      total.skippedWhy[w] = (total.skippedWhy[w] || 0) + Number(r.skippedWhy[w] || 0);
    }
    if (r.orphans) total.orphans = r.orphans;
    if (r.done || !r.next) { total.done = true; break; }
    after = String(r.next); total.lastAfter = after;
    Utilities.sleep(200);
  }
  return total;
}

/** 作業依頼から呼ぶ：枠を作れるか試す／実際に作る／いま入っている数を見る／突き合わせる。氏名は出さない。 */
function quotaBuildText(args) {
  var a0 = args || {};
  // args.verify を付けたら、D1の行と計算を突き合わせる
  if (a0.verify === true || a0.verify === '1') {
    var v = _edgeQuotaVerify({ month: a0.month, limit: a0.limit, after: a0.after, maxPages: a0.maxPages });
    var vo = [];
    vo.push('=== D1の行と計算の突き合わせ（' + (a0.month || '今月') + '）===');
    vo.push('★見ているのは「計算の答え」と「D1の枠・引当から読んだ答え」が同じか。');
    vo.push('　 ここが一致して初めて、残数の読み取りをD1へ向けられます。');
    vo.push('');
    vo.push('回した回数: ' + v.pages + ' ／ 比べた会員 ' + v.checked + '名'
            + (v.done ? ' ／ 最後まで到達' : ' ／ ★途中（続き after=' + v.lastAfter + '）'));
    vo.push('一致 ' + v.agree + '名 ／ ★食い違い ' + v.differ + '名 ／ 比べられず ' + v.skipped + '名');
    if (v.coverageMissing) {
      vo.push('★契約の覆い方がまだ入っていない枠の行: ' + v.coverageMissing + '件'
            + '（枠を作り直すと入る。入るまで比べられない）');
    }
    if (v.overUsedMonths) {
      vo.push('★枠を超えて使っている月がある会員: ' + v.overUsedMonths + '名（直すまでD1へ向けない）');
    }
    if (v.staleCoverage) {
      vo.push('★契約の覆い方が入っていない枠の行（表全体）: ' + v.staleCoverage + '件'
            + '（作り直しで取り残された行。消すか作り直すまでD1へ向けない）');
    }
    if (v.quotaInvariantBroken) {
      vo.push('🚨使った数が枠を超えている行（表全体）: ' + v.quotaInvariantBroken + '件'
            + '（引当かトリガーの異常。原因を特定するまでD1へ向けない）');
    }
    if (v.overUsedPacks) {
      vo.push('★買った枚数を超えて使っているチケットがある会員: ' + v.overUsedPacks + '名（直すまでD1へ向けない）');
    }
    // ★「全員一致」と言えるのは、全ページを集計して次が**すべて**満たされたとき。
    //   ページごとの判定（pageOk）を見て決めない。前のページの食い違いを見落とす。
    //   ★主キーの集合も条件に入れる（2026-10-09・設計13・関門②）。
    //     残数が一致しても、別の月・別のパックに入れ替わっていれば一致しない。
    //   ★keyChecked > 0 も条件。**照合が1人も走っていない状態を「一致」と読ませない。**
    var allGood = v.done && v.checked > 0 && v.differ === 0 && v.skipped === 0
                  && v.overUsedPacks === 0 && v.overUsedMonths === 0 && v.coverageMissing === 0
                  && v.staleCoverage === 0 && v.quotaInvariantBroken === 0
                  && v.keyMismatch === 0 && v.keyRangeMissing === 0 && v.keyChecked > 0
                  && v.orphans && !v.orphans.quotaRows && !v.orphans.packRows && !v.orphans.allocRows;

    if (v.orphans) {
      vo.push('D1にだけ残った行: 枠 ' + v.orphans.quotaRows + ' ／ チケット ' + v.orphans.packRows
              + ' ／ 引当 ' + v.orphans.allocRows + '（契約が無い会員の行。0であるべき）');
    } else {
      vo.push('D1にだけ残った行: ★最後まで到達していないため、まだ数えていません');
    }
    var swk = [];
    for (var w2 in v.skippedWhy) if (v.skippedWhy.hasOwnProperty(w2)) swk.push(w2 + ' ' + v.skippedWhy[w2] + '名');
    if (swk.length) vo.push('比べられなかった理由: ' + swk.join(' / '));

    vo.push('主キーの集合の照合: 走った ' + v.keyChecked + '名 / 合わない ' + v.keyMismatch
            + '名 / 範囲が無くて照合できない ' + v.keyRangeMissing + '名');
    if (v.keyDetail.length) {
      vo.push('');
      vo.push('── 主キーの集合が合わない会員（別の月・別のパックに入れ替わっている）');
      for (var k3 = 0; k3 < v.keyDetail.length; k3++) {
        var kd = v.keyDetail[k3];
        vo.push('   ・' + kd.customerId + '  範囲=' + kd.range
                + '  月:欠け[' + (kd.monthsMissing || []).join(',') + '] 余り[' + (kd.monthsExtra || []).join(',') + ']'
                + '  チケット:欠け' + kd.packsMissing + ' 余り' + kd.packsExtra);
      }
      if (v.keyMismatch > v.keyDetail.length) vo.push('   …ほか ' + (v.keyMismatch - v.keyDetail.length) + '名');
    }

    if (v.diffs.length) {
      vo.push('');
      vo.push('── 食い違った会員');
      for (var k = 0; k < Math.min(v.diffs.length, 20); k++) {
        var d = v.diffs[k];
        vo.push('   ・' + d.customerId
                + '  月額 計算=' + d.monthly.calc + ' / D1=' + d.monthly.d1
                + '  チケット 計算=' + d.ticket.calc + ' / D1=' + d.ticket.d1
                + (d.quotaRow ? '  （枠=' + d.quotaRow.quota + ' 使った=' + d.quotaRow.used + '）' : '  （枠の行なし）'));
      }
      if (v.diffs.length > 20) vo.push('   …ほか ' + (v.diffs.length - 20) + '名');
    }
    vo.push('');
    if (allGood) {
      vo.push('✅ 全員で一致しました。D1の行から正しい残数が読めています。');
      vo.push('　 （全員を比べ、食い違い0・比べられない人0・D1にだけ残った行0）');
    } else {
      vo.push('⚠️ まだ「全員一致」とは言えません。次のどれかが残っています：');
      if (!v.done) vo.push('　 ・最後まで到達していない（続き after=' + v.lastAfter + '）');
      if (!v.checked) vo.push('　 ・1人も比べられていない');
      if (v.differ) vo.push('　 ・食い違いが ' + v.differ + '名');
      if (v.skipped) vo.push('　 ・比べられなかった人が ' + v.skipped + '名');
      if (v.overUsedPacks) vo.push('　 ・買った枚数を超えて使っているチケットがある（' + v.overUsedPacks + '名）');
      if (v.overUsedMonths) vo.push('　 ・枠を超えて使っている月がある（' + v.overUsedMonths + '名）');
      if (v.coverageMissing) vo.push('　 ・契約の覆い方が入っていない行がある（' + v.coverageMissing + '件・作り直しが必要）');
      if (v.keyMismatch) vo.push('　 ・主キーの集合が合わない（' + v.keyMismatch + '名・別の月／別のパックに入れ替わっている）');
      if (v.keyRangeMissing) vo.push('　 ・作り直しの範囲が保存されていないので照合できない（' + v.keyRangeMissing + '名・作り直しが必要）');
      if (!v.keyChecked) vo.push('　 ・★主キーの集合の照合が1人も走っていない（これを「一致」と読んではいけない）');
      if (v.staleCoverage !== 0) vo.push('　 ・表全体の覆い方の検査が済んでいない（staleCoverage=' + v.staleCoverage + '）');
      if (v.quotaInvariantBroken !== 0) vo.push('　 ・表全体の不変条件の検査が済んでいない（quotaInvariantBroken=' + v.quotaInvariantBroken + '）');
      if (v.orphans && (v.orphans.quotaRows || v.orphans.packRows || v.orphans.allocRows)) {
        vo.push('　 ・D1にだけ残った行がある（契約が無い会員の枠や引当）');
      }
      vo.push('　 ★ここが全部片づくまで、残数の読み取りをD1へ向けてはいけません。');
    }
    var vt = vo.join('\n'); Logger.log(vt); return vt;
  }

  // args.status を付けたら、作らずに「いま入っている数」だけを返す
  if (a0.status === true || a0.status === '1') {
    var st = _edgeQuotaStatus();
    var o = [];
    o.push('版の印: ' + LB_EDGE_BUILD);
    o.push('');
    o.push('=== いまD1に入っている枠 ===');
    o.push('月額の枠: ' + st.monthly.rows + '行（使った数の合計 ' + st.monthly.used + '）');
    o.push('チケット: ' + st.packs.rows + '組（使った数の合計 ' + st.packs.used + '）');
    o.push('');
    //   ★契約の覆い方の内訳（2026-10-07）。unlimited が1件でもあれば
    //     「頻度欄が空の月額契約」が実在する＝オーナーの判断が要る。
    var cv = st.coverage || {};
    o.push('── 契約の覆い方の内訳');
    o.push('   契約が覆っている（頻度あり）: ' + (cv.limited || 0) + '行');
    o.push('   契約が覆っていない（繰越だけ）: ' + (cv.uncovered || 0) + '行');
    //   ★2026-10-08 以降、'unlimited' は**新しく作られない**（頻度0は月0回＝limited）。
    //     ここに出るのは、それより前に作られた古い行。作り直せば消える。
    o.push('   旧「上限なし」のまま残っている行: ' + (cv.unlimited || 0) + '行'
           + ((cv.unlimited || 0) ? '（★枠を作り直してください。古い規則の行です）' : ''));
    var cd = st.coverageDetail || {};
    if (cd.unlimited && cd.unlimited.length) {
      o.push('      該当: ' + cd.unlimited.join(' / '));
    }
    if (cd.notSet && cd.notSet.length) {
      o.push('      覆い方が入っていない行: ' + cd.notSet.join(' / '));
    }
    if (cv['(未設定)']) {
      o.push('   ★覆い方が入っていない: ' + cv['(未設定)'] + '行（作り直しの取り残し。作り直してください）');
    }
    o.push('');
    o.push('※ 使った数が0なら、まだ引当を作っていないということ（これから入れる）。');
    //   ★3-b で足した2列の入り具合（2026-10-09）。
    //     base_freq が入っていない行から繰越を作ると、quota 全部を繰越として見せる。
    //     読み取りをD1へ向ける前に0件であることを確かめる。
    var b3 = st.stage3b || {};
    o.push('');
    o.push('── 段階3-b の土台（顧客の残数をD1から作るための2列）');
    o.push('   枠の行: ' + (b3.rows || 0) + '行');
    o.push('   頻度が入っていない行: ' + (b3.baseFreqMissing == null ? '?' : b3.baseFreqMissing) + '行'
           + ((b3.baseFreqMissing) ? '（★作り直しが必要。繰越が過大に見えます）' : '（✅ 全部入っています）'));
    o.push('   支払い待ち: ' + (b3.overageSessions || 0) + '件（' + (b3.overageMonths || 0) + 'か月に分布）');

    //   ★会員ごとの世代（決定0076）と行ごとの世代（決定0078）、shadow の表（決定0077）。
    //     作業依頼の結果はCEOから読めない（この環境では gh が TLS で落ちる）ので、
    //     **1回の依頼で確かめる量を増やす。**
    var sv = st.syncVersion || {};
    o.push('');
    o.push('── 会員ごとの世代（作り直しが入力に追いついているか）');
    if (sv.table !== 'ok') {
      o.push('   ★表がまだ入っていません（' + (sv.detail || 'customer_sync_version') + '）');
    } else {
      o.push('   行がある会員: ' + (sv.total || 0) + '名');
      o.push('   ✅ 追いついている: ' + (sv.fresh || 0) + '名  ／  🔄 遅れている: ' + (sv.stale || 0) + '名');
      o.push('   まだ作り直していない: ' + (sv.noBuilt || 0) + '名'
             + ((sv.ahead) ? '  ／  ★あってはならない向き: ' + sv.ahead + '名' : ''));
      if (sv.staleIds && sv.staleIds.length) o.push('   遅れている会員: ' + sv.staleIds.join(' / '));
    }

    var gen = st.generation || {};
    o.push('');
    o.push('── 行ごとの世代（顧客に出るのは「いまの世代」の行だけ）');
    if (gen.table !== 'ok') {
      o.push('   ★列がまだ入っていません（' + (gen.detail || 'built_version') + '）');
    } else {
      o.push('   枠　　: 全' + gen.quota.rows + '行 ／ いまの世代 ' + gen.quota.current
             + ' ／ 古い行 ' + gen.quota.stale + ' ／ 印が無い ' + gen.quota.noMark);
      o.push('   チケット: 全' + gen.packs.rows + '行 ／ いまの世代 ' + gen.packs.current
             + ' ／ 古い行 ' + gen.packs.stale + ' ／ 印が無い ' + gen.packs.noMark);
      o.push('   ※「印が無い」は作り直す前の行。古い行は**消さずに読まない**方針（決定0078）');
    }

    var sht = st.shadowTables || {};
    var shk = Object.keys(sht);
    if (shk.length) {
      var shOk = 0;
      for (var _s = 0; _s < shk.length; _s++) if (sht[shk[_s]]) shOk++;
      o.push('');
      o.push('── shadow の表: ' + shOk + '/' + shk.length + ' 入っています'
             + (shOk === shk.length ? '（✅）' : '（★まだ比べられません）'));
    }

    //   ★二重書きの状態も同じ窓口で見られるようにする（2026-10-08）。
    //     新しいopを足すと許可一覧（3箇所）の更新がオーナー作業になるため、ここへ寄せる。
    //     ★囲む理由：待ち行列が壊れている等でここが落ちても、
    //       **枠の状態を見る窓口そのものを落としてはいけない。**
    o.push('');
    try {
      o.push(lbDualWriteStatusText());
    } catch (e) {
      o.push('=== 二重書きの待ち行列 ===');
      o.push('状態が読めませんでした: ' + (e && e.message));
    }
    var t0 = o.join('\n'); Logger.log(t0); return t0;
  }
  var a = a0;
  var write = (a.write === true || a.write === '1');
  var alloc = (a.alloc === true || a.alloc === '1');
  var t = _edgeQuotaBuild({ write: write, alloc: alloc, from: a.from, to: a.to, limit: a.limit, after: a.after, maxPages: a.maxPages });

  var out = [];
  out.push('=== 枠を作る（' + (write ? '⚠️ 実際に書きました' : '試しただけ・書いていません') + '） ===');
  out.push('対象の月: ' + (a.from || '(今月)') + ' 〜 ' + (a.to || '(翌月)'));
  out.push('回した回数: ' + t.pages + ' ／ 会員 ' + t.customers + '名'
           + (t.done ? ' ／ 最後まで到達' : ' ／ ★途中（続き after=' + t.lastAfter + '）'));
  out.push('作られる枠: 月額 ' + t.monthlyRows + '行 ／ チケット ' + t.packRows + '組'
           + (write ? ' ／ 書いた文 ' + t.wrote : ''));
  if (alloc) {
    out.push('作られる引当: ' + t.allocRows + '件'
             + ' ／ 枠に入りきらなかった予約 ' + t.overflow + '件（＝超過。行は作らない）');
    out.push('　※ 引当を入れるとトリガーが「使った数」を増やします。これで残数が実際の値になります。');
  } else {
    out.push('※ 引当は作っていません（args に alloc:true を付けると作ります）。');
    out.push('　 引当が無いと「使った数」は0のまま＝誰も使っていないことになります。');
  }

  if (t.skipped.length) {
    out.push('');
    out.push('── 計算入力が揃わず飛ばした会員 ' + t.skipped.length + '名');
    var why = {};
    for (var i = 0; i < t.skipped.length; i++) {
      var k = String(t.skipped[i].reason || '?');
      (why[k] = why[k] || []).push(t.skipped[i].customerId);
    }
    for (var w in why) if (why.hasOwnProperty(w)) out.push('   ・' + w + '：' + why[w].length + '名（' + why[w].slice(0, 8).join(' ') + '）');
  }
  if (t.issues.length) {
    out.push('');
    out.push('── 枠を作れなかった ' + t.issues.length + '件（★これが残っていると、その会員はD1で予約できません）');
    for (var j = 0; j < Math.min(t.issues.length, 20); j++) {
      var is = t.issues[j];
      out.push('   ・' + is.customerId + ' ' + (is.monthKey || '') + ' ' + is.code + ' ' + String(is.detail || '').slice(0, 120));
    }
    if (t.issues.length > 20) out.push('   …ほか ' + (t.issues.length - 20) + '件');
  }
  if (!t.skipped.length && !t.issues.length) {
    out.push('');
    out.push('✅ 全員ぶんの枠を作れました（問題なし）');
  }
  out.push('');
  out.push('===== ここまで =====');
  var txt = out.join('\n');
  Logger.log(txt);
  return txt;
}

// ============================================================
// ===== DUALWRITE:BEGIN =====
//   段階3-a「二重書き」
//
//   ★独立したファイル（gas/DualWrite.js）にしていたが、PushToEdge.js へ寄せた
//     （2026-10-08）。GASの反映は「押し出すファイルの許可一覧」と一致しないと
//     **全体ごと止まる**（.github/workflows/gas-deploy.yml の step 2）。
//     その一覧は「増減のときに人間のレビューを入れる」ための安全装置で、
//     CEOの権限では直せない。オーナーに1行足してもらう手もあるが、
//     **この二重書きが差し込む先（edgeAfterWrite／pushToEdgeLight／_lbCalSyncAfterWrite）は
//     すべてこのファイルにある。** 置き場所としても自然なので、ここへ寄せる。
//
//   ★テストはこの BEGIN/END に挟まれた範囲だけを切り出して動かす
//     （worker/test/dualwrite-queue.test.js）。節の名前を変えるときはそちらも直す。
// ============================================================

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
  //   ★見送ったことも必ず記録する（2026-10-08・実際に見えなくなった）。
  //     待ち行列に1名残っているのに「最後の処理: まだ一度も動いていません」と出た。
  //     ロックが取れずに早く戻ると何も書き残さないため、
  //     **「動いていない」と「動いたが見送った」が区別できなかった。**
  //     成功だけ記録すると、落ちた理由が追えない（記憶 feedback_measure_failures_too）。
  function _note(o) {
    try {
      o.at = Date.now();
      PropertiesService.getScriptProperties().setProperty(LB_DW.LAST_PROP, JSON.stringify(o));
    } catch (e) {}
    return o;
  }
  if (!_edgeEnabled()) return _note({ skipped: 'EDGE_OFF' });
  var t0 = Date.now();
  var n = Number(limit || LB_DW.MAX_PER_RUN);
  var claim = _lbDwClaim(n);
  if (claim === null) {
    //   壊れている／ロックが取れなかった。どちらも次の実行で拾える
    return _note({ skipped: 'QUEUE_BROKEN_OR_LOCKED' });
  }
  var todo = claim.items, queued = claim.total;
  if (!todo.length) {
    //   ★実際の残り人数を返す。全員が処理中のとき0と報告してはいけない
    return _note({ done: 0, left: queued, allLeased: queued > 0 });
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
    return _note({ skipped: 'LEDGER_UNREADABLE', left: queued });
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
  if (last.at && last.skipped) {
    o.push('最後の処理: ' + Utilities.formatDate(new Date(Number(last.at)), SETTINGS.TIMEZONE, 'MM/dd HH:mm')
           + '  ★見送りました（' + last.skipped + '）'
           + (last.left != null ? ' / 残り' + last.left : ''));
    if (last.skipped === 'QUEUE_BROKEN_OR_LOCKED') {
      o.push('  → ロックが取れなかった（他の処理と重なった）か、待ち行列が壊れています。'
             + '続くなら 1回に処理する人数か待ち時間を見直します');
    }
  } else if (last.at) {
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

// ===== DUALWRITE:END =====
