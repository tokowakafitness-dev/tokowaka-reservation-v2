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
function _edgePushRowsF(kind, rows, batchId, full) { return _edgePushRows(kind, rows, batchId, full); }

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

function _edgePushRows(kind, rows, batchId, full) {
  var sent = 0, wrote = 0, skip = 0, i;
  // 元データが読めなかった（null）ときは、何も送らない。
  //   空配列を final 付きで送ると、取り込み側が全行を消してしまう。
  if (rows == null) throw new Error(kind + ' の元データが読めませんでした（送信を中止）');
  rows = _edgeDedupe(kind, rows);
  if (!rows.length) {
    _edgePost({ kind: kind, batchId: batchId, rows: [], final: true, deleteStale: !!full });
    return '0件';
  }
  for (i = 0; i < rows.length; i += EDGE.CHUNK) {
    var chunk = rows.slice(i, i + EDGE.CHUNK);
    var last = (i + EDGE.CHUNK) >= rows.length;
    var res = _edgePost({ kind: kind, batchId: batchId, rows: chunk, final: last, deleteStale: !!full });
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

function _edgeRecurring() {
  var sh = _lbRecurSheet();
  if (!sh || sh.getLastRow() < 2) return [];
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

function _edgeHomeRows(customerIds, deadlineMs) {
  var rows = [];
  var now = new Date();
  // 25日以降は翌月の枠が開く。「今日の残数」だけでは、翌月の予約に答えられない
  //   （9月の残数と10月の残数は別物）。今月分と翌月分の2つを持たせる。
  var nextMid = new Date(now.getFullYear(), now.getMonth() + 1, 15, 12, 0, 0);
  var curKey = _edgeMonthKey(now), nextKey = _edgeMonthKey(nextMid);

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
      payload: JSON.stringify({ currentMonth: curKey, nextMonth: nextKey, current: cur, next: nxt }),
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
  if (!sh) return null;
  var last = sh.getLastRow(); if (last < 2) return null;
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
  return _edgePushRows('home', rows, batchId, full);
}

// 契約や予約が変わった会員1人分だけを、その場で押し出す。
//   写しは15〜30分ごとに更新されるが、その間に予約すると残数がずれる。
//   予約・取消の直後にここを呼べば、その会員だけ即座に正しくなる。
function pushToEdgeHomeFor(customerId, customerName) {
  if (!_edgeEnabled()) return;
  try {
    var rows = _edgeHomeRows([{ id: String(customerId), name: String(customerName || '') }], 0);
    if (rows.length) _edgePushRows('home', rows, Date.now());
  } catch (e) { Logger.log('[edge] 残数の即時更新に失敗: ' + (e && e.message)); }
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
  if (all == null) return 0;                      // 読めなかった＝送らない
  var mine = [];
  for (var i = 0; i < all.length; i++) {
    if (String(all[i].customer_id || '') === String(customerId)) mine.push(all[i]);
  }
  if (!mine.length) return 0;
  return _edgePushRows('reservations', mine, Date.now());
}

// そのトレーナーの枠だけを送り直す。
function _edgePushSlotsFor(trainerId) {
  var all = _edgeSlotRows();
  if (all == null) return 0;
  var mine = [];
  for (var i = 0; i < all.length; i++) {
    if (String(all[i].trainer_id || '') === String(trainerId)) mine.push(all[i]);
  }
  if (!mine.length) return 0;
  return _edgePushRows('slots', mine, Date.now());
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

    pushToEdgeHomeFor(cid, nm);                   // 残数
    _edgePushReservationsFor(cid);                // その人の予約

    var tid = String(res.trainerId || params.trainerId || '');
    if (tid) _edgePushSlotsFor(tid);              // 空き枠
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

  step('trainers',     function () { return _edgePushRowsF('trainers', _edgeTrainers(), batchId, full); });
  step('customers',    function () { return _edgePushRowsF('customers', customers, batchId, full); });
  step('reservations', function () { return _edgePushRowsF('reservations', _edgeReservations(), batchId, full); });
  step('recurring',    function () { return _edgePushRowsF('recurring', _edgeRecurring(), batchId, full); });
  step('slots',        function () { return _edgePushRowsF('slots', _edgeSlotRows(), batchId, full); });
  step('body',         function () { return _edgePushRowsF('body', _edgeBodyRows(), batchId, full); });
  // 残数計算の入力（シート読み込みは1回にまとめる）
  step('計算入力',      function () {
    return _edgeWithSheetCache(function () {
      var cr = _edgeCalcContracts(customers);
      var a = _edgePushRowsF('calcContracts', cr, batchId, full);
      var m = (_edgeCalcContracts._meta || []);
      if (m.length) _edgePushRowsF('calcMeta', m, batchId, full);
      var b = _edgePushRowsF('calcReservations', _edgeCalcReservations(), batchId, full);
      var o = _edgePushRowsF('opening', _edgeOpening(customers), batchId, full);
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
    var n = _edgePushRowsF('slots', _edgeSlotRows(), batchId);
    Logger.log('[edge] 枠 ' + n);
  } catch (e) { Logger.log('[edge] 枠の押し出しに失敗: ' + (e && e.message)); }
}

// 残数を含まない押し出し。10秒程度で終わるので短い間隔で回せる。
function pushToEdgeLight() {
  pushToEdgeAll(false);
  _edgeHealJobTrigger();   // ついでに、見回りが止まっていたら戻す
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
  _lbCleanCalSyncAfterTriggers();   // 役目を終えたら自分を消す（トリガー上限20件に溜めない）
}

// ★ここで例外を外へ出してはいけない。予約は既に成立している。
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
