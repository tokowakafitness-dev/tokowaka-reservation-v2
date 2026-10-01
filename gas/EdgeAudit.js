// 残数の計算をWorkerへ移す前の「実データの棚卸し」（2026-09-29）
//
// なぜ必要か：
//   Codexのレビューで「リポジトリを読むだけでは確定できない」項目が6つ挙がった。
//   これを確かめずに移すと、切り替えたあとで残数が静かにずれる。
//   ここは**読み取りだけ**。何も書き換えない。
//
// 使い方：GASエディタで auditForEdgeMigration() を1回実行し、ログを共有する。

// 文字列を返す版（作業の受け渡しで使う）。ログに出す版は下にある。
// 会員名簿を読む幅。
//   ★氏名の列（3列目）までしか読まずに照合状態（8列目）を参照していたため、
//     undefined が 'verified' と一致せず **全員が除外**されていた。
//     8番の点検が「調べた会員0名」になっていた原因（2026-10-01）。
//     昨日 EdgeVerify で踏んだのとまったく同じ誤り。読む幅は1箇所で決める。
function _auditMapWidth(sh) {
  return Math.max(MAP_COL.NOTE || 14, MAP_COL.AUTH_STATE, MAP_COL.NAME,
                  MAP_COL.CUSTOMER_ID, MAP_COL.LINE_USER_ID, sh.getLastColumn());
}

function auditForEdgeMigrationText() {
  var out = [];
  function say(s) { out.push(s); }
  function head(s) { say(''); say('■ ' + s); }

  say('===== 残数をWorkerへ移す前の棚卸し =====');
  say('（読み取りだけ。何も書き換えません）');

  // ---------------------------------------------------------
  // 1. 顧客の見分け方が「ID」か「氏名＋電話」か
  // ---------------------------------------------------------
  head('1. 顧客の見分け方');
  var strict = false;
  try { strict = String(PropertiesService.getScriptProperties().getProperty('LB_STRICT_ID_MODE') || '') === 'on'; } catch (e) {}
  say('  LB_STRICT_ID_MODE = ' + (strict ? 'on（顧客IDで厳密に照合）' : 'off（氏名＋電話で照合）'));
  if (!strict) say('  ⚠ 氏名での照合が残っています。同名・改名・分裂で別人の契約を拾う余地があります。');

  // ---------------------------------------------------------
  // 2. 契約シートの見出し（同じ言葉を含む列が複数ないか）
  // ---------------------------------------------------------
  head('2. 契約シートの見出し');
  var sh = null, headers = [], cols = null, vals = [];
  try {
    sh = _lbContractSheet();
    if (!sh) { say('  ❌ 契約シートが開けません'); }
    else {
      var lastCol = sh.getLastColumn(), lastRow = sh.getLastRow();
      headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
      cols = _lbContractCols(headers);
      vals = (lastRow >= 2) ? sh.getRange(2, 1, lastRow - 1, lastCol).getValues() : [];
      say('  シート「' + sh.getName() + '」 ' + (lastRow - 1) + '行 × ' + lastCol + '列');

      // 探している言葉ごとに、何列が一致するかを数える（複数一致＝どれを読むか決められない）
      var want = ['お客様名', '種別', 'コース', '頻度', 'チケット枚数', '開始日', '契約終了日',
                  '繰越率', '繰越上限', '電話', '残数方式', '担当', '単価', '顧客ID', 'pack_id', '1名来店'];
      for (var w = 0; w < want.length; w++) {
        var hits = [];
        for (var h = 0; h < headers.length; h++) {
          if (String(headers[h]).indexOf(want[w]) >= 0) hits.push((h + 1) + ':' + String(headers[h]));
        }
        var mark = (hits.length === 0) ? '（無し）' : (hits.length > 1 ? '⚠ 複数一致' : 'OK');
        say('  ' + want[w] + ' … ' + mark + ' ' + hits.join(' / '));
      }
    }
  } catch (e) { say('  ❌ ' + e.message); }

  // ---------------------------------------------------------
  // 3. 契約行の中身（ID・空欄・最古の開始日）
  // ---------------------------------------------------------
  head('3. 契約行の中身');
  if (cols && vals.length) {
    var noName = 0, noStart = 0, noEnd = 0, noCustId = 0, noPackId = 0, ticketRows = 0;
    var oldest = null, names = {}, dupName = 0;
    // 終了日が空の行を、あとで一覧にするために控える（★行番号で示す＝氏名を出さずに直せる）
    var openEnded = [], rowsByName = {};
    for (var i = 0; i < vals.length; i++) {
      var r = vals[i];
      var nm = String(cols.name >= 0 ? r[cols.name] : '').replace(/^\s+|\s+$/g, '');
      if (!nm) { noName++; continue; }
      names[nm] = (names[nm] || 0) + 1;
      (rowsByName[nm] = rowsByName[nm] || []).push(i + 2);   // 見出し1行ぶんを足す＝シートの行番号
      var st = cols.start >= 0 ? _lbParseResvDate(r[cols.start]) : null;
      if (!st || isNaN(st.getTime())) noStart++;
      else if (!oldest || st.getTime() < oldest) oldest = st.getTime();
      var en = cols.end >= 0 ? _lbParseResvDate(r[cols.end]) : null;
      if (!en || isNaN(en.getTime())) {
        noEnd++;
        openEnded.push({
          row: i + 2, name: nm,
          type: String(cols.type >= 0 ? r[cols.type] : ''),
          method: String(cols.method >= 0 ? r[cols.method] : ''),
          freq: String(cols.freq >= 0 ? r[cols.freq] : ''),
          ticket: String(cols.ticket >= 0 ? r[cols.ticket] : ''),
          start: (st && !isNaN(st.getTime())) ? Utilities.formatDate(st, SETTINGS.TIMEZONE, 'yyyy/MM/dd') : '(読めない)'
        });
      }
      if (cols.custId >= 0 && !String(r[cols.custId] || '').replace(/^\s+|\s+$/g, '')) noCustId++;
      var method = String(cols.method >= 0 ? r[cols.method] : '');
      if (method.indexOf('チケット') >= 0) {
        ticketRows++;
        if (cols.packId >= 0 && !String(r[cols.packId] || '').replace(/^\s+|\s+$/g, '')) noPackId++;
      }
    }
    for (var k in names) if (names[k] > 1) dupName++;
    say('  契約行 ' + vals.length + '件（うちチケット ' + ticketRows + '件）');
    say('  お客様名が空 … ' + noName + '件');
    say('  開始日が読めない … ' + noStart + '件');
    say('  契約終了日が空 … ' + noEnd + '件' + (noEnd ? '（★継続契約として扱われます。写す設計に反映が必要）' : ''));
    say('  顧客ID列 … ' + (cols.custId >= 0 ? ('あり／空欄 ' + noCustId + '件') : '（strictモードが off のため未使用）'));
    say('  pack_id列 … ' + (cols.packId >= 0 ? ('あり／チケット行で空欄 ' + noPackId + '件') : '（strictモードが off のため未使用）'));
    say('  同じ氏名が複数行にある人 … ' + dupName + '名（契約更新なら正常。別人の同名なら要注意）');

    // ★終了日が空の行の一覧。
    //   終了日が空＝ずっと有効。古い行の終了日を入れ忘れると、新旧2つの契約が
    //   同時に生き、枠が二重になる（過去行をコピペして更新する運用と直結する）。
    //   氏名は出さず、シートの行番号で示す。オーナーはその行を開けば分かる。
    if (openEnded.length) {
      say('');
      say('  ■ 終了日が空の行 ' + openEnded.length + '件（行番号で示します）');
      openEnded.sort(function (a, b) { return a.row - b.row; });
      for (var oi = 0; oi < openEnded.length; oi++) {
        var o = openEnded[oi];
        var same = (rowsByName[o.name] || []).filter(function (x) { return x !== o.row; });
        say('    ' + o.row + '行目：' + o.type + ' / ' + o.method
            + ' / 頻度' + (o.freq || '-') + ' / チケット' + (o.ticket || '-')
            + ' / 開始 ' + o.start
            + (same.length ? '  ⚠ 同じ方の他の行: ' + same.join(',') + '行目' : '  （この方は1行のみ）'));
      }
      say('');
      say('    ⚠ の付いた行は、同じ方に別の契約行があります。');
      say('      古い方の終了日が空のままなら、2つの契約が同時に生きて枠が二重になります。');
      say('      「この方は1行のみ」は継続契約として正常です（今別府様もこちら）。');
    }
    say('  いちばん古い契約開始日 … ' + (oldest ? Utilities.formatDate(new Date(oldest), 'Asia/Tokyo', 'yyyy/MM/dd') : '不明'));
  } else say('  （読めませんでした）');

  // ---------------------------------------------------------
  // 4. 予約の履歴がどこまで遡れるか（写しは過去730日で切っている）
  // ---------------------------------------------------------
  head('4. 予約の履歴');
  try {
    var rsh = _lbSheet(LINE_BOOKING.RESV_SHEET);
    if (!rsh || rsh.getLastRow() < 2) say('  予約台帳が空です');
    else {
      var rv = rsh.getRange(2, 1, rsh.getLastRow() - 1, Math.max(15, rsh.getLastColumn())).getValues();
      var st2 = {}, oldestR = null, older730 = 0;
      var cut = Date.now() - 730 * 86400000;
      for (var j = 0; j < rv.length; j++) {
        var s2 = String(rv[j][6] || '(空)');
        st2[s2] = (st2[s2] || 0) + 1;
        var d2 = _lbParseResvDate(rv[j][0]);
        if (d2 && !isNaN(d2.getTime())) {
          if (!oldestR || d2.getTime() < oldestR) oldestR = d2.getTime();
          if (d2.getTime() < cut) older730++;
        }
      }
      say('  予約 ' + rv.length + '件');
      var parts = []; for (var s3 in st2) parts.push(s3 + ' ' + st2[s3] + '件');
      say('  状態の内訳 … ' + parts.join(' / '));
      say('  いちばん古い予約 … ' + (oldestR ? Utilities.formatDate(new Date(oldestR), 'Asia/Tokyo', 'yyyy/MM/dd') : '不明'));
      say('  730日より前の予約 … ' + older730 + '件' + (older730 ? '（★写しに入っていません。残数がずれる原因になります）' : '（写しの範囲で足りています）'));
    }
  } catch (e) { say('  ❌ ' + e.message); }

  // ---------------------------------------------------------
  // 5. 棚卸し（繰越の初期値）を使っている会員
  // ---------------------------------------------------------
  head('5. 棚卸し（繰越の初期値）');
  try {
    var msh = _lbSheet(LB_MIGBAL_SHEET);
    if (!msh || msh.getLastRow() < 2) say('  登録なし（全員、履歴から計算しています）');
    else {
      var mv = msh.getRange(2, 1, msh.getLastRow() - 1, 7).getValues();
      var approved = 0, pending = 0;
      for (var m = 0; m < mv.length; m++) {
        if (String(mv[m][5] || '') && String(mv[m][6] || '')) approved++; else pending++;
      }
      say('  承認済み ' + approved + '件 / 未承認 ' + pending + '件');
      if (approved) say('  ★これらの会員は履歴だけでは残数が出ません。写しにも持っていく必要があります。');
    }
  } catch (e) { say('  ❌ ' + e.message); }

  // ---------------------------------------------------------
  // 6. 同じLINE IDがトレーナーと会員の両方にないか
  // ---------------------------------------------------------
  head('6. LINE IDの重複');
  try {
    var tsh = _lbSheet(LINE_BOOKING.TRAINER_SHEET);
    var csh = _lbSheet(LINE_BOOKING.MAP_SHEET);
    var tIds = {};
    if (tsh && tsh.getLastRow() >= 2) {
      var tv = tsh.getRange(2, 1, tsh.getLastRow() - 1, TR_COL.NAME).getValues();
      for (var t = 0; t < tv.length; t++) {
        var id = String(tv[t][TR_COL.LINE_USER_ID - 1] || '');
        if (id) tIds[id] = String(tv[t][TR_COL.NAME - 1] || '');
      }
    }
    var both = [];
    if (csh && csh.getLastRow() >= 2) {
      var cv = csh.getRange(2, 1, csh.getLastRow() - 1, _auditMapWidth(csh)).getValues();
      for (var c = 0; c < cv.length; c++) {
        var cid2 = String(cv[c][MAP_COL.LINE_USER_ID - 1] || '');
        if (cid2 && tIds[cid2]) both.push(tIds[cid2] + '（会員名: ' + String(cv[c][MAP_COL.NAME - 1] || '') + '）');
      }
    }
    say('  両方に載っている人 … ' + both.length + '名' + (both.length ? '：' + both.join(' / ') : ''));
    if (both.length) say('  （オーナーご自身なら正常。トレーナー扱いが優先されます）');
  } catch (e) { say('  ❌ ' + e.message); }

  // ---------------------------------------------------------
  // 7. どの会員にも紐付かない契約行
  // ---------------------------------------------------------
  head('7. 誰にも紐付かない契約行');
  try {
    if (!cols || !vals.length) say('  （契約シートが読めませんでした）');
    else {
      // 会員名簿を作る（氏名の正規化はGASの照合と同じ関数を使う）
      var csh2 = _lbSheet(LINE_BOOKING.MAP_SHEET);
      var members = {};
      if (csh2 && csh2.getLastRow() >= 2) {
        var cv2 = csh2.getRange(2, 1, csh2.getLastRow() - 1, _auditMapWidth(csh2)).getValues();
        for (var q = 0; q < cv2.length; q++) {
          var nm2 = _lbNormName(cv2[q][MAP_COL.NAME - 1]);
          if (nm2) members[nm2] = true;
        }
      }
      var orphan = {};
      for (var p2 = 0; p2 < vals.length; p2++) {
        var nm3raw = String(cols.name >= 0 ? vals[p2][cols.name] : '');
        var nm3 = _lbNormName(nm3raw);
        if (!nm3) continue;
        if (!members[nm3]) orphan[nm3raw] = (orphan[nm3raw] || 0) + 1;
      }
      var list = [];
      for (var o2 in orphan) list.push(o2 + '（' + orphan[o2] + '行）');
      say('  紐付かない契約行の氏名 … ' + list.length + '名');
      for (var L = 0; L < list.length; L++) say('    - ' + list[L]);
      if (list.length) {
        say('  ★退会された方・LINE未登録の方なら問題ありません。');
        say('  ★いま通っている会員が含まれていたら、氏名の表記ゆれで契約を取りこぼしています。');
      }
    }
  } catch (e) { say('  ❌ ' + e.message); }

  // ---------------------------------------------------------
  // 8. 会員ごとに契約が何行拾えているか（これが本命）
  //    0行の会員がいれば、その人の残数は0になる。
  //    同じ行を複数人が拾っていれば、他人の契約で残数が増える。
  // ---------------------------------------------------------
  head('8. 会員ごとの契約の拾い方');
  try {
    var csh3 = _lbSheet(LINE_BOOKING.MAP_SHEET);
    if (!csh3 || csh3.getLastRow() < 2) say('  会員名簿が空です');
    else {
      var mv3 = csh3.getRange(2, 1, csh3.getLastRow() - 1, _auditMapWidth(csh3)).getValues();
      var zero = [], rowOwners = {}, totalRows = 0, seenName = {}, dupMember = [];
      var checked = 0, skipped = 0;
      for (var z = 0; z < mv3.length; z++) {
        var cid3 = String(mv3[z][MAP_COL.CUSTOMER_ID - 1] || '');
        var nm4 = String(mv3[z][MAP_COL.NAME - 1] || '');
        if (!cid3 || !nm4) continue;
        // ★照合が済んでいない登録（rejected・pending）は、GASの顧客一覧にも出ず、
        //   本人もログインできない＝無効。数えると「使われていない登録」を
        //   二重登録として誤報する（2026-09-29 実際に誤報した）。
        if (String(mv3[z][MAP_COL.AUTH_STATE - 1]) !== 'verified') { skipped++; continue; }
        checked++;
        var key4 = _lbNormName(nm4);
        if (seenName[key4]) dupMember.push(nm4 + '（' + cid3 + ' と ' + seenName[key4] + '）');
        else seenName[key4] = cid3;

        var got = [];
        try { got = _lbContractRowsAll(nm4, _lbPhoneByCustomerId(cid3), false, cid3) || []; } catch (e) { got = []; }
        totalRows += got.length;
        if (!got.length) zero.push(nm4);
        for (var g = 0; g < got.length; g++) {
          var k5 = String(got[g].idx);
          if (!rowOwners[k5]) rowOwners[k5] = [];
          // ★顧客IDで数える。氏名で数えると、同じ氏名で2重登録された会員が
          //   同じ契約行を拾っていても1人と見なしてしまう（2026-09-29 実際に見落とした）。
          var who5 = nm4 + '[' + cid3 + ']';
          if (rowOwners[k5].indexOf(who5) < 0) rowOwners[k5].push(who5);
        }
      }
      say('  調べた会員 … ' + checked + '名（照合済みのみ）');
      if (skipped) say('  除いた登録 … ' + skipped + '件（照合前・却下済み＝一覧にも出ず、ログインもできない）');
      say('  拾えた契約行の延べ数 … ' + totalRows + '行');

      say('  契約が1行も拾えない会員 … ' + zero.length + '名');
      for (var z2 = 0; z2 < zero.length; z2++) say('    - ' + zero[z2]);
      if (zero.length) say('  ★この方たちは残数が0になります。氏名の表記ゆれか、契約が未登録です。');

      var shared = [];
      for (var k6 in rowOwners) if (rowOwners[k6].length > 1) shared.push('行' + (Number(k6) + 2) + '：' + rowOwners[k6].join(' と '));
      say('  同じ契約行を複数の会員が拾っている … ' + shared.length + '件');
      for (var s5 = 0; s5 < shared.length; s5++) say('    - ' + shared[s5]);
          if (shared.length) {
        say('  ★同じ契約を2人が別々に数えています。それぞれが「自分は使っていない」と認識するため、');
        say('    契約の回数を超えて予約できてしまいます。どちらか一方に寄せてください。');
      }

      say('  照合済みの中で同じ氏名 … ' + dupMember.length + '件' + (dupMember.length ? '：' + dupMember.join(' / ') : ''));
    }
  } catch (e) { say('  ❌ ' + e.message); }

  say('');
  // 予約データの健康診断もここで一緒に出す（未紐付け・契約が引けない会員・重複）。
  //   新しい作業opを足すとオーナーに許可一覧の編集をお願いすることになるため、
  //   既に許可されている audit に相乗りさせる（2026-09-30）。
  say('');
  say('■ 9. 予約データの健康診断');
  try {
    var hv = dataHealthText();
    var hl = String(hv).split('\n');
    for (var hi = 0; hi < hl.length; hi++) say('  ' + hl[hi]);
  } catch (e) { say('  （健康診断に失敗: ' + (e && e.message) + '）'); }
  say('');
  say('===== ここまで。何も書き換えていません =====');
  return out.join('\n');
}

function auditForEdgeMigration() { Logger.log(auditForEdgeMigrationText()); }

// ============================================================
// 残数が合わない会員を調べる（2026-09-29）
//
//   きっかけ：月4回契約の会員が5回予約できた。
//   原因を確かめるには、その会員の契約行・枠・消化・繰越を並べて見るしかない。
//   これまではオーナーにGASエディタで関数を実行してもらう必要があった。
//   作業依頼から呼べるようにして、オーナーの手を借りずに調べられるようにする。
//
//   ★読み取りだけ。氏名・電話・LINE IDは出さない（結果は作業番号を知っていれば読めるため）。
// ============================================================
//   指定の仕方（2026-10-01 追加）：
//     ・氏名の一部（これまでどおり）
//     ・顧客IDの下桁（'*5133' / '5133'）… リマインドの一覧は伏せ字で示すので、
//       そのまま貼れば氏名をやりとりせずに調べられる
//     ・「,」でつないで、まとめて複数（'5133,4337,2038'）
function remainingDebugText(namePart) {
  if (!namePart) return '調べる会員を args.name で渡してください（氏名の一部、または顧客IDの下桁「*5133」。「,」でまとめて渡せます）。';
  var specs = String(namePart).split(',').map(function (x) { return String(x).trim(); })
                              .filter(function (x) { return x.length > 0; });
  if (specs.length <= 1) return _remainingOneText(specs[0] || '');
  var out = [];
  for (var si = 0; si < specs.length; si++) {
    out.push('━━━━━━━━━━ ' + (si + 1) + '/' + specs.length + '：' + specs[si] + ' ━━━━━━━━━━');
    out.push(_remainingOneText(specs[si]));
    out.push('');
  }
  return out.join('\n');
}

function _remainingOneText(namePart) {
  var log = [];
  function say(s) { log.push(s); }
  if (!namePart) return '調べる会員を args.name で渡してください。';

  try { CacheService.getScriptCache().remove('lb_contract_all'); } catch (e) {}

  var map = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (!map || map.getLastRow() < 2) return '会員名簿が読めません。';
  // 顧客IDの下桁で引くか、氏名の一部で引くか。数字だけなら顧客IDとして扱う。
  var rawId = String(namePart).replace(/^\*/, '').trim();
  var byId = /^[0-9]{3,}$/.test(rawId);
  var target = _lbNormName(namePart);
  var vals = map.getRange(2, 1, map.getLastRow() - 1, _auditMapWidth(map)).getValues();
  var hits = [];
  for (var i = 0; i < vals.length; i++) {
    var cidRow = String(vals[i][MAP_COL.CUSTOMER_ID - 1] || '');
    if (byId) { if (cidRow && cidRow.slice(-rawId.length) === rawId) hits.push(vals[i]); }
    else if (_lbNormName(vals[i][MAP_COL.NAME - 1]).indexOf(target) >= 0) hits.push(vals[i]);
  }
  if (!hits.length) return '「' + namePart + '」に一致する会員が名簿にいません。'
                         + (byId ? '（顧客IDの下' + rawId.length + '桁として探しました）' : '');
  if (hits.length > 1) say('※ ' + hits.length + '件一致しました。1件目で調べます。');

  var hit = hits[0];
  var customerId = String(hit[MAP_COL.CUSTOMER_ID - 1] || '');
  var name = String(hit[MAP_COL.NAME - 1] || '');
  var who = '会員#' + customerId.slice(-4);

  say('===== 残数の内訳：' + who + ' =====');
  say('照合状態=' + String(hit[MAP_COL.AUTH_STATE - 1] || '(空)')
      + ' / 契約状況=' + String(hit[MAP_COL.CONTRACT_STAT - 1] || '(空)'));

  var rows = _lbContractRowsAll(name, _lbPhoneByCustomerId(customerId), false, customerId);
  if (!rows || !rows.length) return log.join('\n') + '\n⛔ 有効な契約行がありません。';
  if (rows.migrationGap) say('⚠️ ID移行が未完了の行があります（残数は要確認扱い）。');

  say('');
  say('■ 有効な契約行 ' + rows.length + '件');
  for (var r = 0; r < rows.length; r++) {
    var rr = rows[r], cc = rr.cols, row = rr.row;
    var f = function (k) { return (cc[k] >= 0 && cc[k] != null) ? String(row[cc[k]]) : '(列なし)'; };
    var d = function (x) { return x ? Utilities.formatDate(x, SETTINGS.TIMEZONE, 'yyyy/MM/dd') : '(なし)'; };
    say('  ' + (r + 1) + ') 種別=' + f('type') + ' / 残数方式=' + f('method')
        + ' / 頻度=' + f('freq') + ' / チケット枚数=' + f('ticket'));
    say('     繰越上限=' + f('carryCap') + ' / 繰越率=' + f('carry')
        + ' / 期間=' + d(rr.start) + '〜' + d(rr.end));
  }

  var sp = _lbSplitRemaining(rows, customerId);
  if (sp._ok === false) say('⚠️ 割当器が「要確認」と判定: ' + JSON.stringify(sp._issues || []));

  say('');
  say('■ いまの残数');
  say('  月額の枠（頻度＋繰越）= ' + sp.avail + ' → 月額残 = ' + sp.monthlyRem);
  say('  チケット残 = ' + sp.ticketRem);
  say('  ▶ 予約できる残り = ' + ((sp.monthlyRem || 0) + (sp.ticketRem || 0)));

  var sess = _lbResvSessions(customerId);
  say('');
  if (sess === null) { say('■ 予約：読み取れませんでした（残数は不明扱い）'); return log.join('\n'); }
  say('■ 計上している予約 ' + sess.length + '件');
  var byMonth = {};
  for (var s2 = 0; s2 < sess.length; s2++) {
    var ss = sess[s2];
    var mk = _lbMonthKeyJst(ss.startAt);
    (byMonth[mk] = byMonth[mk] || []).push(ss);
  }
  var keys = Object.keys(byMonth).sort();
  for (var k = 0; k < keys.length; k++) {
    var list = byMonth[keys[k]];
    say('  ' + keys[k] + '：' + list.length + '件');
    for (var li = 0; li < list.length; li++) {
      var x = list[li];
      say('     ・' + Utilities.formatDate(new Date(x.startAt), SETTINGS.TIMEZONE, 'MM/dd HH:mm')
          + ' / 消化先=' + (x.consumptionMode || '(自動)')
          + ' / 種類=' + (x.packKind || '通常')
          + ' / 人数=' + (x.units == null ? 1 : x.units));
    }
  }
  say('');
  say('※ 今月の枠を超えて予約できている場合、見るべきは');
  say('   (1) 契約行が2件以上ないか（過去行のコピペが残っていないか）');
  say('   (2) 頻度の列を正しく読めているか（列の並びが変わっていないか）');
  say('   (3) 翌月ぶんの予約が混ざっていないか（25日以降は翌月が開く）');
  say('   (4) チケットやペアが月額とは別に引かれていないか');
  return log.join('\n');
}

// ============================================================
// ある日の予約を洗い出す（2026-09-30）
//
//   きっかけ：オーナー「9/29に来店は8名いる」に対し、リマインドの一覧は7名しか
//   拾えていなかった。台帳のどの行が、どう判定されたのかを行単位で見ないと
//   原因が特定できない。
//
//   ★読み取りだけ。氏名は出さない（顧客IDの下4桁と、名簿にあるかどうかだけ）。
// ============================================================
function dayReservationsText(dateStr) {
  var m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '日付を YYYY-MM-DD の形で args.date に渡してください。';
  var y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
  var dayStart = new Date(y, mo, d, 0, 0, 0).getTime();
  var dayEnd   = new Date(y, mo, d + 1, 0, 0, 0).getTime();

  var log = [];
  function say(s) { log.push(s); }
  say('===== ' + m[1] + '/' + m[2] + '/' + m[3] + ' の予約（読み取りだけ）=====');

  // 名簿：顧客IDごとの照合状態・契約状況を引けるようにする
  var members = {};
  var msh = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (msh && msh.getLastRow() >= 2) {
    var mv = msh.getRange(2, 1, msh.getLastRow() - 1,
             Math.max(MAP_COL.NOTE, msh.getLastColumn())).getValues();
    for (var i = 0; i < mv.length; i++) {
      var cid = String(mv[i][MAP_COL.CUSTOMER_ID - 1] || '');
      if (!cid) continue;
      members[cid] = {
        auth: String(mv[i][MAP_COL.AUTH_STATE - 1] || '(空)'),
        stat: String(mv[i][MAP_COL.CONTRACT_STAT - 1] || '(空)'),
        line: String(mv[i][MAP_COL.LINE_USER_ID - 1] || '') ? 'あり' : 'なし'
      };
    }
  }

  var sh = _lbSheet(LINE_BOOKING.RESV_SHEET);
  if (!sh) return log.join('\n') + '\n⛔ 予約台帳が読めません。';
  var last = sh.getLastRow();
  if (last < 2) return log.join('\n') + '\n（台帳に行がありません）';

  var vals = sh.getRange(2, 1, last - 1, Math.max(13, sh.getLastColumn())).getValues();
  var rows = [], byStatus = {};
  for (var r = 0; r < vals.length; r++) {
    var v = vals[r];
    var dt = _lbParseResvDate(v[0]);
    if (!dt) continue;
    var t = dt.getTime();
    if (t < dayStart || t >= dayEnd) continue;
    var st = String(v[6] || '(空)');
    byStatus[st] = (byStatus[st] || 0) + 1;
    rows.push({
      row: r + 2,
      time: Utilities.formatDate(dt, SETTINGS.TIMEZONE, 'HH:mm'),
      cid: String(v[2] || ''),
      hasName: String(v[1] || '') ? 'あり' : 'なし',
      trainer: String(v[5] || v[4] || ''),
      status: st,
      channel: String(v[9] || '')
    });
  }

  rows.sort(function (a, b) { return a.time < b.time ? -1 : (a.time > b.time ? 1 : 0); });
  say('台帳にこの日の行 ' + rows.length + '件');
  var stKeys = [];
  for (var k in byStatus) stKeys.push(k + ' ' + byStatus[k] + '件');
  say('状態の内訳：' + (stKeys.join(' / ') || '（なし）'));
  say('');

  var counted = 0, reasons = {};
  for (var j = 0; j < rows.length; j++) {
    var x = rows[j];
    var mem = x.cid ? members[x.cid] : null;
    // リマインドが「来店」として数えるかどうかを、同じ条件で再現する
    var why = '';
    if (!x.cid)                              why = '顧客IDが空';
    else if (!mem)                           why = '名簿に無い';
    else if (mem.auth !== 'verified')        why = '未認証(' + mem.auth + ')';
    else if (mem.stat !== 'active')          why = '契約が有効でない(' + mem.stat + ')';
    else if (mem.line === 'なし')            why = 'LINE未連携';
    else if (x.status !== 'confirmed' && x.status !== 'consumed') why = '状態が' + x.status;
    if (!why) counted++; else reasons[why] = (reasons[why] || 0) + 1;

    say('  ' + x.time + '  ' + (x.cid ? '会員#' + x.cid.slice(-4) : '（IDなし）')
        + ' / 担当' + (x.trainer || '-') + ' / ' + x.status
        + ' / ' + (x.channel || '-') + ' / 台帳' + x.row + '行'
        + (why ? '  → 数えない：' + why : '  → 来店として数える'));
  }

  say('');
  say('▶ 来店として数えた ' + counted + '件 ／ 数えなかった ' + (rows.length - counted) + '件');
  var rk = [];
  for (var k2 in reasons) rk.push(k2 + ' ' + reasons[k2] + '件');
  if (rk.length) say('  内訳：' + rk.join(' / '));
  say('');
  say('※ 台帳に無い予約（カレンダーに手入力して氏名が一致しなかったもの）は、ここには出ません。');
  say('   その場合は健康診断の「未紐付けの予約」に出ます。');
  return log.join('\n');
}
