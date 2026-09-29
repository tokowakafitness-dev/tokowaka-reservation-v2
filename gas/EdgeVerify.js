// GASとWorkerの残数を突き合わせる（2026-09-29）
//
// なぜ必要か：
//   計算本体は1文字も同じだが、入力の作り方がずれれば違う答えが出る。
//   テストが通っても、実データで1人でも残数が違えば予約できる回数が変わる。
//
// なぜ「今日の残数」だけでは足りないか（Codexの指摘）：
//   たまたま今日は一致しても、月末・契約の開始日・チケットの期限の前後で壊れる。
//   残数の合計が同じでも「月額から引いたのかチケットから引いたのか」が違えば、
//   あとで請求と報酬がずれる。だから内訳まで比べる。
//
// 使い方：verifyEdgeRemaining() を1回実行してログを見る。読み取りだけ（何も書き換えない）。

var EV = {
  BUDGET_MS: 4.5 * 60000,   // GASは1回6分で止まる。4分半で打ち切り、続きは次回
  MAX_TIMES: 40             // 1人あたりの比較時点の上限（Worker側と揃える）
};

// 比べる中身をそろえる。並び順や小さな表記差を「実装の差」に見せないため。
function _evCanon(a) {
  if (!a) return null;
  var packs = (a.ticketPacks || []).map(function (p) {
    return { packId: String(p.packId), remaining: Number(p.remaining || 0),
             kind: String(p.kind || 'normal'), expireMs: Number(p.expireMs || 0) };
  }).sort(function (x, y) { return (x.packId < y.packId) ? -1 : (x.packId > y.packId ? 1 : 0); });
  var issues = (a.issues || []).map(function (s) { return String(s.code || ''); }).sort();
  return JSON.stringify({
    ok: !!a.ok, issues: issues,
    hasMonthly: !!a.hasMonthly, hasTicket: !!a.hasTicket,
    monthlyRem: (a.monthlyRem == null) ? null : Number(a.monthlyRem),
    ticketTotal: Number(a.ticketTotal || 0), ticketRem: Number(a.ticketRem || 0),
    ticketRemPair: Number(a.ticketRemPair || 0), ticketRemNormal: Number(a.ticketRemNormal || 0),
    pairPackMax: Number(a.pairPackMax || 0),
    freq: Number(a.freq || 0), avail: Number(a.avail || 0),
    packs: packs
  });
}

// その会員について「いつを比べるべきか」を契約から組み立てる
function _evTimePoints(rows) {
  var t = {}, now = Date.now();
  function add(ms, label) { if (ms != null && isFinite(ms)) t[String(Math.round(ms))] = label; }
  var JST = 9 * 3600000;
  function endOfDayJst(ms) { return (Math.floor((ms + JST) / 86400000) * 86400000 - JST) + 86399999; }
  function monthEnd(ms) { var d = new Date(ms + JST); return endOfDayJst(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 12) - JST); }

  add(now, '今');
  add(monthEnd(now), '今月末');
  add(monthEnd(now) + 1, '翌月に入った瞬間');
  var nx = new Date(now + JST); nx = Date.UTC(nx.getUTCFullYear(), nx.getUTCMonth() + 1, 15, 12) - JST;
  add(nx, '翌月なかば');
  var nn = new Date(now + JST); nn = Date.UTC(nn.getUTCFullYear(), nn.getUTCMonth() + 2, 15, 12) - JST;
  add(nn, '翌々月なかば');

  for (var i = 0; i < rows.length; i++) {
    var st = rows[i].start ? rows[i].start.getTime() : null;
    var en = rows[i].end ? rows[i].end.getTime() : null;
    if (st != null) { add(st - 1, '契約開始の直前'); add(st, '契約開始'); }
    if (en != null) { add(endOfDayJst(en), '終了日の終わり'); add(endOfDayJst(en) + 1, '終了日の翌日'); }
  }
  var out = [];
  for (var k in t) out.push({ ms: Number(k), label: t[k] });
  out.sort(function (a, b) { return a.ms - b.ms; });
  return out.slice(0, EV.MAX_TIMES);
}

function _evPost(payload) {
  var url = _edgeProp('EDGE_URL'), secret = _edgeProp('EDGE_SECRET');
  if (!url || !secret) throw new Error('EDGE_URL / EDGE_SECRET が未設定です');
  var res = UrlFetchApp.fetch(url.replace(/\/+$/, '') + '/calc', {
    method: 'post', contentType: 'application/json',
    headers: { 'X-Ingest-Secret': secret },
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('HTTP ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
  return JSON.parse(res.getContentText());
}

// 外へ返す版は氏名を出さない。
//   結果は作業番号を知っていれば読めるため（合言葉なし）、個人を特定できる文字列を載せない。
//   ★呼び出し元を推測して切り替えない。入口ごとに別の関数にする（Codexの指摘）。
function verifyEdgeRemainingText() { return _verifyEdgeRemaining(true); }
function verifyEdgeRemaining() { Logger.log(_verifyEdgeRemaining(false)); }

function _verifyEdgeRemaining(mask) {
  var t0 = Date.now(), log = [];
  // 会員の呼び方。伏せるときは顧客IDの下4桁だけにする。
  function who(name, cid) { return mask ? ('会員#' + String(cid || '').slice(-4)) : name; }
  function say(s) { log.push(s); }

  say('===== GASとWorkerの残数を突き合わせます（読み取りだけ）=====');

  var carryRate = LINE_BOOKING.CARRYOVER_RATE;
  var nowKey = _lbMonthKeyJst(Date.now());
  say('繰越率 ' + carryRate + ' ／ 今の月 ' + nowKey);

  var msh = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (!msh || msh.getLastRow() < 2) { Logger.log('会員名簿が読めません'); return; }
  var mv = msh.getRange(2, 1, msh.getLastRow() - 1, MAP_COL.NAME).getValues();

  var members = [];
  for (var i = 0; i < mv.length; i++) {
    if (String(mv[i][MAP_COL.AUTH_STATE - 1]) !== 'verified') continue;   // 照合済みだけ
    var cid = String(mv[i][MAP_COL.CUSTOMER_ID - 1] || '');
    var nm = String(mv[i][MAP_COL.NAME - 1] || '');
    if (cid && nm) members.push({ id: cid, name: nm });
  }
  say('対象 ' + members.length + '名');

  var okCount = 0, ngCount = 0, skipCount = 0, points = 0;
  var ngDetail = [];

  // シートの読み込みは1回にまとめる（会員ごとに読み直すと6分で終わらない）
  _edgeWithSheetCache(function () {
  _edgeWithResvCache(function () {
    for (var m = 0; m < members.length; m++) {
      if (Date.now() - t0 > EV.BUDGET_MS) { say('⏱ 時間切れ。' + m + '名まで確認しました'); break; }
      var cid2 = members[m].id, nm2 = members[m].name;

      var rows, sessions, opening;
      try {
        rows = _lbContractRowsAll(nm2, _lbPhoneByCustomerId(cid2), false, cid2) || [];
        sessions = _lbResvSessions(cid2);
        opening = _lbMemberOpeningWithFloor(cid2);
      } catch (e) { ngCount++; ngDetail.push(who(nm2, cid2) + '：GAS側の材料が揃わない'); continue; }
      if (sessions === null) { skipCount++; continue; }

      var pts = _evTimePoints(rows);
      var times = pts.map(function (p) { return p.ms; });

      var wk;
      try { wk = _evPost({ customerId: cid2, times: times, nowKey: nowKey, carryRate: carryRate }); }
      catch (e) { ngCount++; ngDetail.push(who(nm2, cid2) + '：Workerに聞けない'); continue; }

      if (!wk.success) {
        if (wk.code === 'NO_INPUT') { skipCount++; say('  － ' + who(nm2, cid2) + '：Workerに材料がまだ無い（' + wk.detail + '）'); }
        else { ngCount++; ngDetail.push(who(nm2, cid2) + '：Workerが答えられない（' + wk.code + '）'); }
        continue;
      }

      // 材料の数が違えば、その時点で入力がずれている
      if (wk.contractRows !== rows.length) {
        ngCount++;
        ngDetail.push(who(nm2, cid2) + '：契約の行数が違う（GAS ' + rows.length + ' / Worker ' + wk.contractRows + '）');
        continue;
      }
      if (wk.sessions !== sessions.length) {
        ngCount++;
        ngDetail.push(who(nm2, cid2) + '：予約の件数が違う（GAS ' + sessions.length + ' / Worker ' + wk.sessions + '）');
        continue;
      }
      if (wk.hasOpening !== !!opening) {
        ngCount++;
        ngDetail.push(who(nm2, cid2) + '：棚卸しの有無が違う（GAS ' + (!!opening) + ' / Worker ' + wk.hasOpening + '）');
        continue;
      }

      var bad = [];
      for (var p2 = 0; p2 < pts.length; p2++) {
        points++;
        var gas = _lbComputeRemaining(cid2, rows, sessions, nowKey, pts[p2].ms, carryRate, opening);
        var a = _evCanon(gas), b = _evCanon(wk.results[p2]);
        if (a !== b) {
          bad.push(pts[p2].label + '（' + Utilities.formatDate(new Date(pts[p2].ms), SETTINGS.TIMEZONE, 'yyyy/MM/dd HH:mm') + '）');
          if (bad.length === 1) {
            ngDetail.push(who(nm2, cid2) + '：' + pts[p2].label + ' で食い違い');
            ngDetail.push('    GAS    ' + a);
            ngDetail.push('    Worker ' + b);
          }
        }
      }
      if (bad.length) { ngCount++; ngDetail.push('    （ほか ' + (bad.length - 1) + ' 時点）'); }
      else okCount++;
    }
  });
  });

  say('');
  say('一致 ' + okCount + '名 ／ 食い違い ' + ngCount + '名 ／ 確認できず ' + skipCount + '名');
  say('比べた時点 ' + points + '箇所（' + Math.round((Date.now() - t0) / 1000) + '秒）');
  if (ngDetail.length) {
    say('');
    say('■ 食い違いの中身');
    for (var d = 0; d < Math.min(ngDetail.length, 60); d++) say('  ' + ngDetail[d]);
    if (ngDetail.length > 60) say('  …ほか ' + (ngDetail.length - 60) + '行');
  }
  say('');
  say(ngCount === 0 && skipCount === 0
      ? '✅ 全員一致しました。切り替えの前提が整っています。'
      : '⚠ 食い違い、または確認できない会員がいます。切り替えないでください。');
  return log.join('\n');
}
