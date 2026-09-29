// 作業の受け渡し・GAS側（2026-09-29）
//
// なぜこの形か：
//   開発中、点検を実行するのにオーナーの手を借りていた（1日20往復）。
//   GASに新しい公開入口を作ると、匿名で叩かれて実行枠を食い潰され、
//   お客様の予約が止まりうる（Codexの指摘）。
//   そこで「GASから聞きに行く」形にした。外からGASは呼べない。
//
// ★結果に個人情報を入れない。
//   結果は作業番号を知っていれば読める（合言葉なし）ため、
//   氏名・電話・LINE IDを出さない。会員は「会員#下4桁」で表す。
//
// 使い方：setupEdgeJobTrigger() で1分ごとの見回りを設定する。

var EJ = {
  TIMEOUT_MS: 4.5 * 60000,   // GASは1回6分。4分半で切り上げる
  ENABLED_PROP: 'EDGE_JOB_ON'   // '1' のときだけ見回る
};

function _ejOn() { return _edgeProp(EJ.ENABLED_PROP) === '1'; }

function _ejPost(payload) {
  var url = _edgeProp('EDGE_URL'), secret = _edgeProp('EDGE_SECRET');
  if (!url || !secret) throw new Error('EDGE_URL / EDGE_SECRET が未設定です');
  var res = UrlFetchApp.fetch(url.replace(/\/+$/, '') + '/jobs', {
    method: 'post', contentType: 'application/json',
    headers: { 'X-Ingest-Secret': secret },
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('HTTP ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
  return JSON.parse(res.getContentText());
}

// 個人を特定できる文字列を落とす。結果は合言葉なしで読めるため。
function _ejScrub(text) {
  var s = String(text == null ? '' : text);
  // LINEのユーザーID（U+英数32文字）
  s = s.replace(/U[0-9a-f]{32}/g, 'U…');
  // 電話番号。
  //   ★前後が数字でないことを条件にする。これが無いと、時刻のミリ秒（1790658000000）の
  //     途中を電話番号と誤認して潰す（2026-09-29 実際に起きた）。結果が読めなくなる。
  s = s.replace(/(^|[^0-9])(0\d{1,4}-\d{1,4}-\d{3,4})(?![0-9])/g, '$1（電話）');      // 03-1234-5678
  s = s.replace(/(^|[^0-9])(0[789]0\d{8})(?![0-9])/g, '$1（電話）');                    // 09012345678
  s = s.replace(/(^|[^0-9])(0\d{1}\d{8})(?![0-9])/g, '$1（電話）');                    // 0312345678
  // メールアドレス
  s = s.replace(/[\w.+-]+@[\w.-]+\.\w+/g, '（メール）');
  return s;
}

// 会員の呼び名。氏名は出さず、顧客IDの下4桁で表す。
function _ejMember(customerId) {
  var s = String(customerId || '');
  return '会員#' + (s ? s.slice(-4) : '不明');
}

// ============================================================
// 実行できる作業（固定の分岐。名前から関数を引かない）
//   ★オブジェクトから引くと、継承された名前（constructor など）を拾う余地がある。
//     switch で直接呼ぶ（Codexの指摘）。
// ============================================================
function _ejRun(op, args) {
  switch (op) {
    case 'audit':          return _ejScrub(auditForEdgeMigrationText());
    case 'verify':         return verifyEdgeRemainingText();          // 元から氏名を出さない作りにする
    case 'previewMerge':   return _ejScrub(previewMemberMergeText());
    case 'testConnection': return _ejScrub(testEdgeConnectionText());
    // 残数が合わない会員を、オーナーの手を借りずに調べられるようにする（2026-09-29）。
    //   args = { name: '部分一致の氏名' }。読み取りだけ。氏名や電話は出さない。
    case 'remaining':      return _ejScrub(remainingDebugText((args && args.name) || ''));
    case 'pushAll':        return _ejScrub(pushToEdgeAllText());
    default: throw new Error('許可されていない作業です：' + op);
  }
}

/** 1分ごとに呼ばれる。作業が無ければすぐ終わる（0.3〜0.5秒） */
function edgeJobPoll() {
  if (!_ejOn()) return;                       // 開発中だけ動かす

  // ★設定が無いまま回すと、1分ごとに失敗し続けてGASの実行枠を無駄に使う。
  //   その場合は見回り自体を止める（気づかないまま枠を消費しないため）。
  if (!_edgeProp('EDGE_URL') || !_edgeProp('EDGE_SECRET')) {
    PropertiesService.getScriptProperties().setProperty(EJ.ENABLED_PROP, '0');
    Logger.log('[job] EDGE_URL / EDGE_SECRET が未設定のため見回りを止めました。設定後に setupEdgeJobTrigger を実行してください。');
    return;
  }

  var claimed = null;
  try {
    var r = _ejPost({ action: 'claim' });
    if (!r || !r.success || !r.job) { _ejNoteOk(); return; }   // 何も無い＝即終了
    claimed = r.job;
    _ejNoteOk();
  } catch (e) {
    // 続けて失敗するなら、通信先か合言葉が間違っている。回り続けても直らないので止める。
    if (_ejNoteFail() >= 20) {
      PropertiesService.getScriptProperties().setProperty(EJ.ENABLED_PROP, '0');
      Logger.log('[job] 連続して届かないため見回りを止めました。EDGE_URL / EDGE_SECRET を確認してください。');
    }
    return;
  }

  // 写しを書き換える作業は、ほかの押し出しと重ならないようにする
  var lock = null;
  if (claimed.isWrite) {
    lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) {
      try { _ejPost({ action: 'report', requestId: claimed.requestId, ok: false, error: 'ほかの処理が動いていました' }); } catch (e2) {}
      return;
    }
  }

  var t0 = Date.now(), text = '', ok = false, err = null;
  try {
    text = _ejRun(claimed.op, claimed.args);
    ok = true;
  } catch (e) {
    // 生の例外文は内部構造が漏れるので、種類と短い説明だけにする
    err = String((e && e.message) || e).slice(0, 300);
    ok = false;
  } finally {
    if (lock) { try { lock.releaseLock(); } catch (e3) {} }
  }

  try {
    _ejPost({ action: 'report', requestId: claimed.requestId, ok: ok,
              result: '[' + claimed.op + '] ' + Math.round((Date.now() - t0) / 1000) + '秒\n' + text,
              error: err });
  } catch (e4) { Logger.log('[job] 報告に失敗: ' + (e4 && e4.message)); }
}

// 連続失敗の回数を覚える（届かない設定のまま回り続けないため）
function _ejNoteFail() {
  var n = Number(_edgeProp('EDGE_JOB_FAILS') || 0) + 1;
  try { PropertiesService.getScriptProperties().setProperty('EDGE_JOB_FAILS', String(n)); } catch (e) {}
  return n;
}
function _ejNoteOk() {
  if (_edgeProp('EDGE_JOB_FAILS')) {
    try { PropertiesService.getScriptProperties().setProperty('EDGE_JOB_FAILS', '0'); } catch (e) {}
  }
}

function setupEdgeJobTrigger() {
  var all = ScriptApp.getProjectTriggers();
  for (var i = 0; i < all.length; i++) {
    if (all[i].getHandlerFunction() === 'edgeJobPoll') ScriptApp.deleteTrigger(all[i]);
  }
  // ★設定が揃っていなければ始めない。1分ごとに失敗し続けるのを防ぐ。
  if (!_edgeProp('EDGE_URL') || !_edgeProp('EDGE_SECRET')) {
    Logger.log('❌ EDGE_URL / EDGE_SECRET が未設定です。スクリプトプロパティに登録してから実行してください。');
    return;
  }
  // 実際に届くかを先に確かめる。
  //   ★claim を使ってはいけない。仕事を1つ取って捨ててしまう（2026-09-29 実際にやった）。
  try { _ejPost({ action: 'ping' }); }
  catch (e) {
    Logger.log('❌ Workerに届きませんでした（' + (e && e.message) + '）。EDGE_URL / EDGE_SECRET を確認してください。');
    return;
  }
  ScriptApp.newTrigger('edgeJobPoll').timeBased().everyMinutes(1).create();
  PropertiesService.getScriptProperties().setProperty(EJ.ENABLED_PROP, '1');
  PropertiesService.getScriptProperties().setProperty('EDGE_JOB_FAILS', '0');
  Logger.log('✅ 届くことを確認し、1分ごとの見回りを設定しました。止めるときは stopEdgeJobPolling() を実行してください。');
}

function stopEdgeJobPolling() {
  PropertiesService.getScriptProperties().setProperty(EJ.ENABLED_PROP, '0');
  var all = ScriptApp.getProjectTriggers();
  for (var i = 0; i < all.length; i++) {
    if (all[i].getHandlerFunction() === 'edgeJobPoll') ScriptApp.deleteTrigger(all[i]);
  }
  Logger.log('見回りを止めました。');
}
