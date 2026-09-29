// 同じ方が会員名簿に2つ登録されている場合の統合（2026-09-29）
//
// なぜ起きたか（鈴木様の例）：
//   LINEを使われない前提で、トレーナーが代行予約するための枠を先に用意していた。
//   その後ご本人が電話番号でLINE登録されたため、別の登録ができた。
//
// なぜ直す必要があるか：
//   予約は顧客IDごとに数えるので、2つの登録がそれぞれ「自分は使っていない」と認識する。
//   **契約の回数を超えて予約できてしまう。**
//
// 使い方：
//   1) previewMemberMerge()        … 何が起きるかを見るだけ（書き換えなし）
//   2) mergeMembers('残す側ID', '消す側ID')          … 下見（書き換えなし）
//   3) mergeMembers('残す側ID', '消す側ID', true)    … 実行

// 個人を特定する値はログに出さない。有無と末尾だけ示す。
function _mmMaskId(v) {
  var s = String(v || '');
  if (!s) return '(なし)';
  return '…' + s.slice(-4);
}

/** 同じ氏名で複数登録されている会員を洗い出す（読み取りのみ）。文字列を返す版 */
function previewMemberMergeText() {
  var out = [];
  function say(s) { out.push(s); }

  say('===== 二重登録の下見（読み取りだけ。何も書き換えません）=====');

  var sh = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (!sh || sh.getLastRow() < 2) { Logger.log('会員名簿が空です'); return; }
  var lastCol = Math.max(MAP_COL.NOTE || 14, sh.getLastColumn());
  var v = sh.getRange(2, 1, sh.getLastRow() - 1, lastCol).getValues();

  // 予約の件数を顧客IDごとに数える
  var resvCount = {}, resvFuture = {};
  var rsh = _lbSheet(LINE_BOOKING.RESV_SHEET);
  if (rsh && rsh.getLastRow() >= 2) {
    var rv = rsh.getRange(2, 1, rsh.getLastRow() - 1, Math.max(12, rsh.getLastColumn())).getValues();
    var now = Date.now();
    for (var i = 0; i < rv.length; i++) {
      var st = String(rv[i][6] || '');
      if (st !== 'confirmed' && st !== 'consumed') continue;
      var cid = String(rv[i][2] || ''); if (!cid) continue;
      resvCount[cid] = (resvCount[cid] || 0) + 1;
      var d = _lbParseResvDate(rv[i][0]);
      if (d && !isNaN(d.getTime()) && d.getTime() >= now) resvFuture[cid] = (resvFuture[cid] || 0) + 1;
    }
  }

  // 同じ氏名でまとめる
  var groups = {};
  for (var j = 0; j < v.length; j++) {
    var name = String(v[j][MAP_COL.NAME - 1] || '');
    var cid2 = String(v[j][MAP_COL.CUSTOMER_ID - 1] || '');
    if (!name || !cid2) continue;
    var key = _lbNormName(name);
    if (!groups[key]) groups[key] = [];
    groups[key].push({
      row: j + 2, name: name, customerId: cid2,
      lineUserId: String(v[j][MAP_COL.LINE_USER_ID - 1] || ''),
      phone: String(v[j][MAP_COL.PHONE - 1] || ''),
      auth: String(v[j][MAP_COL.AUTH_STATE - 1] || ''),
      linkedAt: v[j][MAP_COL.LINKED_AT - 1],
      status: String(v[j][MAP_COL.CONTRACT_STAT - 1] || '')
    });
  }

  var found = 0;
  for (var k in groups) {
    var g = groups[k];
    if (g.length < 2) continue;
    found++;
    say('');
    say('■ ' + g[0].name + '（' + g.length + '件の登録）');
    for (var m = 0; m < g.length; m++) {
      var e = g[m];
      say('  [' + (m + 1) + '] 顧客ID ' + e.customerId + ' （名簿の' + e.row + '行目）');
      say('      LINE … ' + (e.lineUserId ? 'あり ' + _mmMaskId(e.lineUserId) : 'なし') +
          ' ／ 電話 … ' + (e.phone ? 'あり' : 'なし') +
          ' ／ 照合 … ' + (e.auth || '(空)'));
      say('      予約 … 合計' + (resvCount[e.customerId] || 0) + '件（うち今後 ' + (resvFuture[e.customerId] || 0) + '件）');
      var rows = [];
      try { rows = _lbContractRowsAll(e.name, _lbPhoneByCustomerId(e.customerId), false, e.customerId) || []; } catch (x) {}
      say('      拾っている契約 … ' + rows.length + '行');
    }

    // どちらを残すべきか（ご本人が実際に使っている登録＝LINEが紐付いていて照合済み）
    var keep = null;
    for (var n = 0; n < g.length; n++) {
      if (g[n].lineUserId && g[n].auth === 'verified') { keep = g[n]; break; }
    }
    if (!keep) for (var n2 = 0; n2 < g.length; n2++) if (g[n2].lineUserId) { keep = g[n2]; break; }
    // 照合済みが1つだけなら、残りは既に無効＝統合しなくてよい
    var verified = [];
    for (var vv = 0; vv < g.length; vv++) if (g[vv].auth === 'verified') verified.push(g[vv]);
    if (verified.length <= 1) {
      say('  → 統合は不要です。照合済みの登録は ' + verified.length + '件だけで、');
      say('    残りは顧客一覧にも出ず、ログインもできません（無効な登録）。');
      if (verified.length === 1) say('    有効なのは ' + verified[0].customerId + ' の1つです。');
      continue;
    }

    if (keep) {
      var drop = [];
      for (var n3 = 0; n3 < g.length; n3++) if (g[n3].customerId !== keep.customerId) drop.push(g[n3].customerId);
      say('  → 残す候補：' + keep.customerId + '（ご本人のLINEが紐付いている側）');
      say('  → 寄せる側：' + drop.join(' / '));
      say('  → 実行するなら：mergeMembers(\'' + keep.customerId + '\', \'' + drop[0] + '\')   ← まず下見');
    } else {
      say('  → どちらにもLINEが紐付いていません。オーナーの判断が必要です。');
    }
  }

  if (!found) say('二重登録はありません。');
  say('');
  say('===== ここまで。何も書き換えていません =====');
  return out.join('\n');
}

function previewMemberMerge() { Logger.log(previewMemberMergeText()); }

/**
 * 2つの登録を1つに寄せる。
 *   keepId … 残す顧客ID（ご本人のLINEが紐付いている側）
 *   dropId … 寄せる（無効にする）顧客ID
 *   apply  … true のときだけ実際に書き換える。既定は下見。
 *
 * やること：
 *   1) 予約台帳の customer_id を dropId → keepId に付け替える
 *   2) 会員名簿の dropId の行を「統合済み」にする（行は消さない＝履歴を残す）
 */
function mergeMembers(keepId, dropId, apply) {
  keepId = String(keepId || '').replace(/^\s+|\s+$/g, '');
  dropId = String(dropId || '').replace(/^\s+|\s+$/g, '');
  var log = [];
  function say(s) { log.push(s); }

  say(apply ? '===== 統合を実行します =====' : '===== 下見（何も書き換えません）=====');
  if (!keepId || !dropId) { say('❌ 顧客IDを2つ指定してください'); Logger.log(log.join('\n')); return; }
  if (keepId === dropId) { say('❌ 同じIDが指定されています'); Logger.log(log.join('\n')); return; }

  var lock = LockService.getScriptLock();
  if (apply && !lock.tryLock(10000)) { Logger.log('ほかの処理が動いています。少し待って再実行してください。'); return; }
  try {
    // --- 会員名簿の確認 ---
    var msh = _lbSheet(LINE_BOOKING.MAP_SHEET);
    if (!msh || msh.getLastRow() < 2) { say('❌ 会員名簿が読めません'); Logger.log(log.join('\n')); return; }
    var mLastCol = Math.max(MAP_COL.NOTE || 14, msh.getLastColumn());
    var mv = msh.getRange(2, 1, msh.getLastRow() - 1, mLastCol).getValues();
    var keepRow = -1, dropRow = -1, keepName = '', dropName = '';
    for (var i = 0; i < mv.length; i++) {
      var cid = String(mv[i][MAP_COL.CUSTOMER_ID - 1] || '');
      if (cid === keepId) { keepRow = i + 2; keepName = String(mv[i][MAP_COL.NAME - 1] || ''); }
      if (cid === dropId) { dropRow = i + 2; dropName = String(mv[i][MAP_COL.NAME - 1] || ''); }
    }
    if (keepRow < 0) { say('❌ 残す側の顧客IDが名簿にありません：' + keepId); Logger.log(log.join('\n')); return; }
    if (dropRow < 0) { say('❌ 寄せる側の顧客IDが名簿にありません：' + dropId); Logger.log(log.join('\n')); return; }
    if (_lbNormName(keepName) !== _lbNormName(dropName)) {
      say('❌ 氏名が違います（' + keepName + ' と ' + dropName + '）。別人の可能性があるため中止しました。');
      Logger.log(log.join('\n')); return;
    }
    say('残す側 … ' + keepName + '（' + keepId + '・名簿' + keepRow + '行目）');
    say('寄せる側 … ' + dropName + '（' + dropId + '・名簿' + dropRow + '行目）');

    // --- 予約の付け替え ---
    var rsh = _lbSheet(LINE_BOOKING.RESV_SHEET);
    var moved = 0, targets = [];
    if (rsh && rsh.getLastRow() >= 2) {
      var rLastCol = Math.max(12, rsh.getLastColumn());
      var rv = rsh.getRange(2, 1, rsh.getLastRow() - 1, rLastCol).getValues();
      for (var j = 0; j < rv.length; j++) {
        if (String(rv[j][2] || '') !== dropId) continue;
        targets.push({ row: j + 2, when: rv[j][0], status: rv[j][6] });
      }
    }
    say('付け替える予約 … ' + targets.length + '件');
    for (var t = 0; t < Math.min(targets.length, 20); t++) {
      say('  ' + (t + 1) + '. ' + targets[t].row + '行目 ' + targets[t].when + ' （' + targets[t].status + '）');
    }
    if (targets.length > 20) say('  …ほか ' + (targets.length - 20) + '件');

    if (!apply) {
      say('');
      say('これは下見です。実行するには次を実行してください：');
      say("  mergeMembers('" + keepId + "', '" + dropId + "', true)");
      Logger.log(log.join('\n')); return;
    }

    // --- ここから書き換え ---
    for (var u = 0; u < targets.length; u++) {
      rsh.getRange(targets[u].row, 3).setValue(keepId);   // C列＝customer_id
      moved++;
    }
    // 寄せた側は行を消さず、無効にして経緯を残す
    msh.getRange(dropRow, MAP_COL.CONTRACT_STAT).setValue('統合済み');
    msh.getRange(dropRow, MAP_COL.AUTH_STATE).setValue('merged');
    if (MAP_COL.NOTE) {
      msh.getRange(dropRow, MAP_COL.NOTE).setValue(
        Utilities.formatDate(new Date(), SETTINGS.TIMEZONE, 'yyyy/MM/dd') + ' ' + keepId + ' へ統合（予約' + moved + '件を付け替え）');
    }
    SpreadsheetApp.flush();
    try { CacheService.getScriptCache().remove('lb_contract_all'); } catch (e) {}

    say('');
    say('✅ 完了：予約 ' + moved + '件を付け替え、' + dropId + ' を「統合済み」にしました。');
    say('次に pushToEdgeAll を1回実行して、写しにも反映してください。');
  } finally {
    if (apply) { try { lock.releaseLock(); } catch (e) {} }
  }
  Logger.log(log.join('\n'));
}
