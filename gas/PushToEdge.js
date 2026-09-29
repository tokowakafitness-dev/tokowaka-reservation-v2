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
      getDataRange: function () { return fakeRange(1, 1, c.lastRow, c.lastCol); },
      _real: c.real
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
