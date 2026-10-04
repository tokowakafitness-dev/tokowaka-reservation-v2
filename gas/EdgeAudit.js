// 残数の計算をWorkerへ移す前の「実データの棚卸し」（2026-09-29）
//
// なぜ必要か：
//   Codexのレビューで「リポジトリを読むだけでは確定できない」項目が6つ挙がった。
//   これを確かめずに移すと、切り替えたあとで残数が静かにずれる。
//   ここは**読み取りだけ**。何も書き換えない。
//
// 使い方：GASエディタで auditForEdgeMigration() を1回実行し、ログを共有する。

// ★この版の印。EdgeAudit.js の中身を変えたら必ず書き換える。
//   「直したのに出力が変わらない」とき、GASへの反映漏れなのか不具合なのかを
//   切り分けられず何往復も使った（2026-10-01／10-02）。印があれば一目で分かる。
//   Nudge.js の LB_NUDGE_BUILD と同じ仕掛け。
var LB_AUDIT_BUILD = '2026-10-04a 版の印/契約の二重/月額会員の残数一覧/連続セッションの実測/過去のある時点の残数の再現';

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
  say('版: ' + LB_AUDIT_BUILD);
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
      // 終了日が空の行だけを氏名ごとに集める（これが2行以上あるときだけ危ない）
      var openByName = {};
      for (var ob = 0; ob < openEnded.length; ob++) {
        (openByName[openEnded[ob].name] = openByName[openEnded[ob].name] || []).push(openEnded[ob].row);
      }
      for (var oi = 0; oi < openEnded.length; oi++) {
        var o = openEnded[oi];
        var same = (rowsByName[o.name] || []).filter(function (x) { return x !== o.row; });
        // ★「同じ方に別の行がある」だけでは問題にならない。古い行に終了日が入っていれば正常な更新。
        //   危ないのは「終了日が空の行が同じ方に2行以上ある」場合だけ。
        //   以前はこの区別をせず、正常な更新にも ⚠ を付けていたため、読んだ私が誤解した（2026-10-02）。
        var openSame = openByName[o.name].filter(function (x) { return x !== o.row; });
        var mark;
        if (openSame.length) mark = '  🚨 終了日が空の行がもう1行あります: ' + openSame.join(',') + '行目';
        else if (same.length) mark = '  （同じ方の他の行 ' + same.join(',') + '行目 には終了日が入っています＝正常な更新）';
        else mark = '  （この方は1行のみ）';
        say('    ' + o.row + '行目：' + o.type + ' / ' + o.method
            + ' / 頻度' + (o.freq || '-') + ' / チケット' + (o.ticket || '-')
            + ' / 開始 ' + o.start + mark);
      }
      say('');
      var openDup = 0;
      for (var dn in openByName) if (openByName[dn].length >= 2) openDup++;
      if (openDup) {
        say('    🚨 終了日が空の行が2行以上ある方が ' + openDup + '名います。');
        say('      2つの契約が同時に生きて枠が二重になる恐れがあります。古い行に終了日を入れてください。');
      } else {
        say('    ✅ 終了日が空の行が2行以上ある方はいません（枠が二重になる形はありません）。');
        say('      終了日が空の行は、継続中の契約として正常に扱われます。');
      }
      say('      ※「他の行には終了日が入っています」は正常な契約更新です。');
    }
    say('  いちばん古い契約開始日 … ' + (oldest ? Utilities.formatDate(new Date(oldest), 'Asia/Tokyo', 'yyyy/MM/dd') : '不明'));
  } else say('  （読めませんでした）');

  // ---------------------------------------------------------
  // 3-2. 契約行が二重に効いていないか（会員ごとに「いまの実害」を見る）
  //   上の一覧は「終了日が空の行」を挙げるだけで、いま枠が二重になっているかは分からない。
  //   入力の不備（将来ずれる）と、いま実際にずれていることを分けて出す（2026-10-02）。
  // ---------------------------------------------------------
  head('3-2. 契約行が二重に効いていないか');
  try {
    var _ovLines = String(contractOverlapImpactText(true)).split('\n');
    for (var _ovi = 0; _ovi < _ovLines.length; _ovi++) say('  ' + _ovLines[_ovi]);
  } catch (eOv) { say('  （検査に失敗: ' + (eOv && eOv.message) + '）'); }

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
  if (!namePart) return '版: ' + LB_AUDIT_BUILD
    + '\n調べる会員を args.name で渡してください（氏名の一部、または顧客IDの下桁「*5133」。「,」でまとめて渡せます）。';
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

// ============================================================
// LINEの用途別の送信通数を読む（2026-10-02）
//
//   なぜ前月を見るか：当月は予約がまだ入りきっていないため、月の見込みが立たない。
//   実績が揃った前月を見るのが正しい（オーナー指示）。
//   総数の正本はLINEのquota API。用途別は既存データからの再構成＝概算。
//   ★読み取りだけ。氏名は出さない（会員単位の情報を出さないので構造的に出ない）。
// ============================================================
function lineUsageText(ym) {
  var month = String(ym || '').match(/^\d{4}-\d{2}$/) ? String(ym)
            : Utilities.formatDate(new Date(), SETTINGS.TIMEZONE, 'yyyy-MM');
  var out = [];
  function say(x) { out.push(x); }
  say('===== LINEの送信通数 ' + month + '（読み取りだけ）=====');
  say('版: ' + LB_AUDIT_BUILD);

  // 当月の総数はAPIから（上限・使用・残）。前月の総数はAPIでは取れないので内訳の合計で見る。
  var nowMonth = Utilities.formatDate(new Date(), SETTINGS.TIMEZONE, 'yyyy-MM');
  try {
    var q = _lbQuotaFetch();
    if (q && q.ok) {
      say('');
      say('■ いまの枠（当月 ' + nowMonth + '・LINEが返す実数）');
      if (q.limited) {
        say('  上限 ' + q.limit + '通 ／ 送信済み ' + q.used + '通 ／ 残り ' + q.left + '通（' + q.pct + '%）');
      } else {
        say('  上限なしのプランです（送信済み ' + q.used + '通）');
      }
    } else {
      say('');
      say('■ いまの枠：読めませんでした（' + ((q && q.error) || '不明') + '）');
    }
  } catch (eQ) { say(''); say('■ いまの枠：読めませんでした（' + eQ.message + '）'); }

  var u = null;
  try { u = estimateLineUsage(month); } catch (eU) { return out.join('\n') + '\n⛔ 内訳を読めません: ' + eU.message; }

  say('');
  say('■ ' + month + ' の用途別（既存データからの再構成＝概算）');
  var keys = [];
  for (var k in u.byPurpose) keys.push(k);
  keys.sort(function (a, b) { return u.byPurpose[b] - u.byPurpose[a]; });
  if (!keys.length) say('  （記録がありません）');
  for (var i = 0; i < keys.length; i++) {
    say('  ' + _lbUsageLabel(keys[i]) + ' … ' + u.byPurpose[keys[i]] + '通');
  }
  say('  ───────────────');
  say('  合計 ' + u.total + '通');
  if (u.notes && u.notes.length) {
    say('');
    say('■ 読むときの注意');
    for (var n = 0; n < u.notes.length; n++) say('  ・' + u.notes[n]);
  }
  say('');
  say('※ 用途別は概算です。総数の正本はLINEが返す実数（上の「いまの枠」）です。');
  say('   予約を促すリマインドは nudge_log の実測（sent の行だけ）を数えています。');
  say('');
  say('===== ここまで。何も書き換えていません =====');
  return out.join('\n');
}

// purpose タグを日本語にする（オーナーが読むため）
var _LB_USAGE_LABEL = {
  booking_customer: '予約確定（顧客へ）', booking_trainer: '予約確定（担当へ）',
  cancel_customer: 'キャンセル（顧客へ）', cancel_trainer: 'キャンセル（担当へ）',
  change_customer: '時間変更（顧客へ）', change_trainer: '時間変更（担当へ）',
  reminder_customer: '前日リマインド（顧客へ）', reminder_trainer: '前日リマインド（担当へ）',
  autobook_customer: '固定枠の自動予約（顧客へ）', autobook_trainer: '固定枠の自動予約（担当へ）',
  shift_trainer: 'シフト依頼（担当へ）', pace_trainer: '消化ペース報告（担当へ）',
  batch_customer: '一括操作（顧客へ）', batch_trainer: '一括操作（担当へ）',
  nudge_transfer: '予約を促す：振替の案内', nudge_month_open: '予約を促す：翌月分の解放',
  nudge_visit_a: '予約を促す：来店翌日A', nudge_visit_b: '予約を促す：来店翌日B'
};
function _lbUsageLabel(k) { return (_LB_USAGE_LABEL[k] || k) + '（' + k + '）'; }

// ============================================================
// 繰越が「記録のない月」から生まれていないかを点検する（2026-10-01）
//
//   きっかけ：ある会員の10月の残が6回だった。内訳を追うと、5〜8月の枠が
//   「1件も予約がない＝使っていない」とみなされ、毎月繰越上限まで繰り越されていた。
//   実際には来店されていて、予約台帳にその記録が無いだけだった。
//
//   残数の計算には「ここより前は記録がないので数えない」という下限（recordsFrom）があり、
//   既定では会員の紐付け日時の月が入る。ところが紐付けが台帳の記録開始より古いと、
//   その差の期間が「来なかった月」として繰越に化ける。
//
//   繰越には上限があるので、差が結果に出ないことも多い（上限で抑えられる）。
//   だから「誰で、いくつ違うのか」を出して、人が判断できるようにする。
//   ★読み取りだけ。残数の計算には一切触らない。氏名は出さない。
// ============================================================
// オブジェクトのキー数（チケット引継ぎが入っているかの判定）。表示用。
function _lbCountKeys(o) { var n = 0; for (var k in o) n++; return n; }

// 残数ログの繰越回数（月ごとに入っているので合計する）。表示用。
function _lbMbCarryOf(op) {
  if (!op || !op.carry) return 0;
  var t = 0;
  for (var k in op.carry) t += Number(op.carry[k]) || 0;
  return t;
}

function carryRangeImpactText() {
  var out = [];
  function say(x) { out.push(x); }
  var now = new Date(), nowMs = now.getTime();
  var nowKey = _lbMonthKeyJst(nowMs);
  var rate = LINE_BOOKING.CARRYOVER_RATE;

  var map = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (!map || map.getLastRow() < 2) return '版: ' + LB_AUDIT_BUILD + '\n会員名簿が読めません。';
  var vals = map.getRange(2, 1, map.getLastRow() - 1, _auditMapWidth(map)).getValues();

  say('===== 繰越が「記録のない月」から生まれていないかの点検 '
      + Utilities.formatDate(now, SETTINGS.TIMEZONE, 'yyyy/MM/dd HH:mm') + '（読み取りだけ）=====');
  say('版: ' + LB_AUDIT_BUILD);
  say('※氏名は出しません。会員は顧客IDの下4桁で示します。');
  say('');

  // ① まず「予約台帳が記録を持ち始めた月」を出す。これより前は誰についても
  //    「予約0件＝来ていない」と判断できない。8月以前の残は残数ログから引き継ぐ。
  var ledgerFrom = _lbRecordsFromMonth();

  // ② 残数ログ（migration_balance）の状態。承認済みでなければ計算に使われない。
  var mb = { exists: false, rows: 0, approved: 0, months: {} };
  try {
    var mbSh = _lbSheet(LB_MIGBAL_SHEET);
    if (mbSh && mbSh.getLastRow() >= 2) {
      mb.exists = true;
      var mbv = mbSh.getRange(2, 1, mbSh.getLastRow() - 1, 7).getValues();
      for (var q = 0; q < mbv.length; q++) {
        if (!String(mbv[q][0] || '')) continue;
        mb.rows++;
        if (String(mbv[q][5] || '') && String(mbv[q][6] || '')) {
          mb.approved++;
          var mk0 = _lbMonthKeyCell(mbv[q][1], SETTINGS.TIMEZONE);
          mb.months[mk0] = (mb.months[mk0] || 0) + 1;
        }
      }
    } else if (mbSh) { mb.exists = true; }
  } catch (e0) {}

  say('■ 予約台帳が記録を持ち始めた月: ' + ledgerFrom + '（これより前は残数ログから引き継ぎます）');
  if (!mb.exists) {
    say('■ 残数ログ（' + LB_MIGBAL_SHEET + '）: ⛔ シートがありません');
  } else {
    var mons = [];
    for (var mk1 in mb.months) mons.push(mk1 + '基準' + mb.months[mk1] + '名');
    say('■ 残数ログ（' + LB_MIGBAL_SHEET + '）: ' + mb.rows + '行 ／ 承認済み ' + mb.approved + '行'
        + (mons.length ? '（' + mons.join('・') + '）' : ''));
    if (mb.rows > 0 && mb.approved === 0) say('   ⚠️ 承認者・承認日が未記入のため、どの行も計算に使われていません。');
  }
  say('');

  var checked = 0, diffs = [], gaps = [], skipped = [], withLog = 0;
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][MAP_COL.AUTH_STATE - 1]) !== 'verified') continue;
    var nm = String(vals[i][MAP_COL.NAME - 1] || ''); if (!nm) continue;
    var cid = String(vals[i][MAP_COL.CUSTOMER_ID - 1] || ''); if (!cid) continue;
    var who = '*' + cid.slice(-4);
    checked++;

    var rows, sess, opening, logged;
    try {
      rows = _lbContractRowsAll(nm, _lbPhoneByCustomerId(cid), false, cid);
      if (!rows || !rows.length) { skipped.push(who + '(契約なし)'); continue; }
      sess = _lbResvSessions(cid);
      if (sess === null) { skipped.push(who + '(台帳が読めない)'); continue; }
      logged = _lbMemberOpening(cid);          // 承認済みの残数ログ（無ければ null）
      if (logged) withLog++;
      opening = _lbMemberOpeningWithFloor(cid); // いま本番が使っている下限つきの状態
    } catch (e) { skipped.push(who + '(' + e.message + ')'); continue; }

    var floorNow = (opening && opening.recordsFrom) ? String(opening.recordsFrom) : '(下限なし)';
    var contractFrom = null;
    for (var r = 0; r < rows.length; r++) {
      if (!rows[r].start) continue;
      var ck = _lbMonthKeyJst(rows[r].start.getTime());
      if (contractFrom == null || ck < contractFrom) contractFrom = ck;
    }

    var a, b;
    try {
      a = _lbComputeRemaining(cid, rows, sess, nowKey, nowMs, rate, opening);
      // 下限を「台帳の記録開始月」にした場合（残数ログがあればその月が優先される）
      var floorWant = ledgerFrom;
      if (logged && logged.recordsFrom) floorWant = String(logged.recordsFrom);
      var op2 = {
        carry: (logged && logged.carry) || {},
        packsUsed: (logged && (logged.packsUsed || logged.packs)) || {},
        cutoverMonth: logged ? logged.cutoverMonth : undefined,
        recordsFrom: floorWant
      };
      b = _lbComputeRemaining(cid, rows, sess, nowKey, nowMs, rate, op2);
    } catch (e2) { skipped.push(who + '(計算できない: ' + e2.message + ')'); continue; }

    var remA = (a && a.monthlyRem != null) ? Number(a.monthlyRem) : null;
    var remB = (b && b.monthlyRem != null) ? Number(b.monthlyRem) : null;

    if (contractFrom != null && contractFrom < ledgerFrom) {
      gaps.push(who + '（契約' + contractFrom + '〜 ／ いまの下限=' + floorNow
                + ' ／ 残数ログ=' + (logged ? '有（' + (logged.recordsFrom || '?') + '基準・繰越'
                    + _lbMbCarryOf(logged) + '回）' : '無') + '）');
    }
    if (remA !== remB) {
      diffs.push({ who: who, now: remA, want: remB, contractFrom: contractFrom,
                   floorNow: floorNow, logged: !!logged });
    }
  }

  say('── 調べた会員 ' + checked + '名 ／ 承認済みの残数ログがある会員 ' + withLog + '名');
  say('');
  say('■ 台帳の記録開始（' + ledgerFrom + '）より前に契約が始まっている会員: ' + gaps.length + '名');
  if (!gaps.length) say('   （該当なし）');
  for (var g = 0; g < gaps.length; g++) say('   ・' + gaps[g]);

  say('');
  say('■ 下限を ' + ledgerFrom + ' にすると今月の残数が変わる会員: ' + diffs.length + '名');
  if (!diffs.length) {
    say('   （該当なし。いま下限を直しても、どなたの残数も変わりません）');
  } else {
    for (var d = 0; d < diffs.length; d++) {
      var x = diffs[d];
      var sign = (x.want - x.now);
      say('   ・' + x.who + '：いま ' + x.now + '回 → 直すと ' + x.want + '回'
          + '（' + (sign > 0 ? '+' : '') + sign + '回）'
          + ' ／ 契約' + x.contractFrom + '〜 ／ いまの下限=' + x.floorNow
          + ' ／ 残数ログ=' + (x.logged ? '有' : '無'));
    }
    say('');
    say('   ※ マイナスの方は、直すと残数が減ります。残数ログに切替時点の繰越を');
    say('      入れておかないと、本来ある回数をお断りしてしまいます。');
    say('      ★下限を直す前に、この方々の残数ログを埋めてください。');
  }

  if (skipped.length) { say(''); say('■ 調べられなかった会員: ' + skipped.join(' / ')); }
  say('');
  say('===== ここまで。何も書き換えていません =====');
  return out.join('\n');
}

// ============================================================
// 氏名つきの残数の内訳 — GASエディタから実行する版（2026-10-01）
//
//   なぜ分けるか：作業依頼の結果は、作業番号を知っていれば合言葉なしで読めるURLに置かれる。
//     そこへお客様の氏名を載せると、社外へ出る経路ができてしまう。
//     だから氏名を出す版はエディタ専用にして、Googleの外へ出さない。
//     （Nudge.js の lbNudgePreviewNamed と同じ考え方）
//
//   使い方：GASエディタで関数を選び、実行 → 実行ログに出ます。
// ============================================================

// ① 今日リマインドを送る方について、氏名・残数の内訳・送る文面をまとめて出す
function remainingNamedForNudge() {
  Logger.log(_remainingNamedForNudgeText());
}

function _remainingNamedForNudgeText(nowMs) {
  var ms = (nowMs != null) ? nowMs : new Date().getTime();
  var plan = lbNudgePlanAll(ms);
  var out = [];
  out.push('===== 今日リマインドを送る方の残数の内訳（氏名つき・読み取りだけ）' + plan.asOf + ' =====');
  out.push('★この出力には個人情報が含まれます。外部へ貼らないでください。');
  out.push('');
  if (plan.code !== 'OK') { out.push('⛔ ' + plan.code + ' — 必要なシートが読めません。'); return out.join('\n'); }
  if (!plan.targets.length) { out.push('今日の対象はいません。'); return out.join('\n'); }

  for (var i = 0; i < plan.targets.length; i++) {
    var t = plan.targets[i];
    out.push('━━━━━━━━━━━━━ ' + (i + 1) + '/' + plan.targets.length + ' ━━━━━━━━━━━━━');
    out.push('種別: ' + (LB_NUDGE_LABEL[t.kind] || t.kind) + ' ／ 言語: ' + (t.lang || 'ja'));
    out.push('リマインドに出す数字: 今月残' + t.remain + '回 ／ 繰越可' + t.carry + '回');
    out.push('');
    out.push(_remainingOneText(t._cidFull, true));
    out.push('');
    out.push('▼ 送る文面');
    var lines = String(t._text || '').split('\n');
    for (var j = 0; j < lines.length; j++) out.push('   | ' + lines[j]);
    out.push('');
  }
  return out.join('\n');
}

// ② 任意の会員を氏名つきで調べる（who を書き換えて実行）
function remainingNamed() {
  var who = '';   // ← 氏名の一部／顧客IDの下4桁／「,」で複数（例 '5133,4337'）
  if (!who) { Logger.log('調べたい会員を who に書いてください（氏名の一部／顧客IDの下4桁／「,」でつないで複数）。'); return; }
  var specs = String(who).split(',').map(function (x) { return String(x).trim(); })
                         .filter(function (x) { return x.length > 0; });
  var out = ['★この出力には個人情報が含まれます。外部へ貼らないでください。', ''];
  for (var i = 0; i < specs.length; i++) { out.push(_remainingOneText(specs[i], true)); out.push(''); }
  Logger.log(out.join('\n'));
}

// ============================================================
// 契約の入力の食い違いを拾う（2026-10-01）
//
//   きっかけ：ある会員の契約が「残数方式=月額 / 頻度=4 / チケット枚数=4」だった。
//   月額として扱われるのでチケット4枚は計算に入らない。入力ミスなら問題ないが、
//   本当に月額＋チケットなら残数が4回少なく案内される。コードでは判定できない。
//   だから「人が決めるべき食い違い」として表に出す。残数の計算は変えない。
// ============================================================
function _contractOddities(rows) {
  var out = [];
  if (!rows || !rows.length) return out;

  function cell(rr, k) {
    var c = rr.cols && rr.cols[k];
    return (c != null && c >= 0) ? rr.row[c] : '';
  }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function dstr(x) { return x ? Utilities.formatDate(x, SETTINGS.TIMEZONE, 'yyyy/MM/dd') : '(なし)'; }

  for (var i = 0; i < rows.length; i++) {
    var rr = rows[i], tag = (i + 1) + ')';
    var method = String(cell(rr, 'method') || '');
    var freq = num(cell(rr, 'freq'));
    var tick = num(cell(rr, 'ticket'));
    var cap  = cell(rr, 'carryCap');

    // ① 月額方式なのにチケット枚数が入っている → チケットは計算に入らない
    if (method.indexOf('月額') >= 0 && tick > 0) {
      out.push(tag + ' 残数方式=月額 なのにチケット枚数=' + tick
               + '。月額として扱うのでチケット' + tick + '枚は残数に入りません。'
               + '月額のみなら枚数を空に、月額＋チケットなら方式を見直してください。');
    }
    // ② チケット方式なのに頻度が入っている → 頻度は計算に入らない
    if (method.indexOf('チケット') >= 0 && freq > 0) {
      out.push(tag + ' 残数方式=チケット なのに頻度=' + freq
               + '。チケットとして扱うので頻度' + freq + '回は残数に入りません。');
    }
    // ③ 繰越上限が頻度の既定と違う（意図した上書きかの確認用。誤りとは言わない）
    if (cap !== '' && cap != null) {
      var def = (typeof LB_CARRY_CAP_TABLE !== 'undefined') ? LB_CARRY_CAP_TABLE[freq] : null;
      if (def != null && num(cap) !== num(def)) {
        out.push(tag + ' 繰越上限=' + cap + '（頻度' + freq + 'の既定は' + def + '）。'
                 + '意図した上書きならそのままで問題ありません。');
      }
    }
    // ④ 期間が前の行と重なっている
    //   ★同じ残数方式の行どうしだけを見る（2026-10-02）。
    //     月額とチケットは数える土台が別なので、期間が重なっても枠は揺れない。
    //     方式を見ずに比べていたため、月額＋チケットを併用している方（正常な契約形態）が
    //     全員「確認が要る」に入り、一覧で本当に見るべき方が埋もれていた。
    if (method.indexOf('月額') < 0 && method.indexOf('チケット') < 0) continue;   // 方式が読めない行は比べない
    for (var j = 0; j < i; j++) {
      var pr = rows[j];
      var pMethod = String(cell(pr, 'method') || '');
      var sameKind = (method.indexOf('月額') >= 0 && pMethod.indexOf('月額') >= 0)
                  || (method.indexOf('チケット') >= 0 && pMethod.indexOf('チケット') >= 0);
      if (!sameKind) continue;   // 月額×チケットの重なりは正常（併用）
      var aS = rr.start ? rr.start.getTime() : null, aE = rr.end ? rr.end.getTime() : null;
      var bS = pr.start ? pr.start.getTime() : null, bE = pr.end ? pr.end.getTime() : null;
      if (aS == null || bS == null) continue;
      var overlap = (bE == null || aS <= bE) && (aE == null || bS <= aE);
      if (overlap) {
        out.push(tag + ' 期間が ' + (j + 1) + ') と重なっています（'
                 + dstr(pr.start) + '〜' + dstr(pr.end) + ' と '
                 + dstr(rr.start) + '〜' + dstr(rr.end) + '）。'
                 + 'どちらの条件で数えるかが揺れます。（同じ残数方式の行どうしです）');
      }
    }
  }
  return out;
}

function _remainingOneText(namePart, showName) {
  var log = [];
  function say(s) { log.push(s); }
  if (!namePart) return '版: ' + LB_AUDIT_BUILD + '\n調べる会員を args.name で渡してください。';

  try { CacheService.getScriptCache().remove('lb_contract_all'); } catch (e) {}

  var map = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (!map || map.getLastRow() < 2) return '版: ' + LB_AUDIT_BUILD + '\n会員名簿が読めません。';
  // 顧客IDの下桁で引くか、氏名の一部で引くか。数字だけなら顧客IDとして扱う。
  var rawId = String(namePart).replace(/^\*/, '').trim();
  var byId = /^[0-9]{3,}$/.test(rawId);
  var target = _lbNormName(namePart);
  var vals = map.getRange(2, 1, map.getLastRow() - 1, _auditMapWidth(map)).getValues();
  var hits = [];
  var exact = String(namePart).trim();
  for (var i = 0; i < vals.length; i++) {
    var cidRow = String(vals[i][MAP_COL.CUSTOMER_ID - 1] || '');
    if (cidRow && cidRow === exact) { hits = [vals[i]]; break; }   // 顧客IDそのものなら一意
    if (byId) { if (cidRow && cidRow.slice(-rawId.length) === rawId) hits.push(vals[i]); }
    else if (_lbNormName(vals[i][MAP_COL.NAME - 1]).indexOf(target) >= 0) hits.push(vals[i]);
  }
  if (!hits.length) return '版: ' + LB_AUDIT_BUILD
                         + '\n「' + namePart + '」に一致する会員が名簿にいません。'
                         + (byId ? '（顧客IDの下' + rawId.length + '桁として探しました）' : '');
  if (hits.length > 1) say('※ ' + hits.length + '件一致しました。1件目で調べます。');

  var hit = hits[0];
  var customerId = String(hit[MAP_COL.CUSTOMER_ID - 1] || '');
  var name = String(hit[MAP_COL.NAME - 1] || '');
  //   氏名は showName のときだけ。作業依頼（公開URL）からは showName を渡さない。
  var who = showName ? (name + '（会員#' + customerId.slice(-4) + '）') : ('会員#' + customerId.slice(-4));

  say('===== 残数の内訳：' + who + ' =====');
  say('版: ' + LB_AUDIT_BUILD);
  say('照合状態=' + String(hit[MAP_COL.AUTH_STATE - 1] || '(空)')
      + ' / 契約状況=' + String(hit[MAP_COL.CONTRACT_STAT - 1] || '(空)'));

  // ★計算の前提を必ず出す（2026-10-02）。
  //   これが出ていなかったため、手元で一部の入力だけを再現して
  //   「同じ数字が出た＝同じ計算をしている」と誤って断定した。
  //   数字の一致は経路の一致を意味しない。前提は常に数字と並べて出す。
  say('');
  say('■ 計算の前提');
  try {
    var _op = _lbMemberOpeningWithFloor(customerId);
    var _logged = _lbMemberOpening(customerId);
    say('  台帳が記録を持ち始めた月 = ' + _lbRecordsFromMonth());
    say('  この会員の下限（ここより前は数えない） = '
        + ((_op && _op.recordsFrom) ? String(_op.recordsFrom) : '(下限なし＝契約開始月まで遡る)'));
    if (_logged) {
      say('  残数ログ = 有（' + (_logged.recordsFrom || '?') + '基準・繰越 '
          + _lbMbCarryOf(_logged) + '回'
          + (_logged.packsUsed && _lbCountKeys(_logged.packsUsed) ? '・チケット引継ぎ有' : '') + '）');
    } else {
      say('  残数ログ = 無（下限は会員登録の月。登録より前は数えません）');
    }
  } catch (ePre) { say('  ⚠️ 前提を読めませんでした: ' + ePre.message); }

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

  var odd = _contractOddities(rows);
  if (odd.length) {
    say('');
    say('⚠️ 契約の入力に食い違いがあります（残数の解釈が揺れます）');
    for (var o = 0; o < odd.length; o++) say('  ・' + odd[o]);
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
      // ★「いつ取られたか」を並べる（2026-10-03）。
      //   枠を超えて予約が入っていたとき、先に取ったのか後から増えたのかは
      //   これが無いと切り分けられない。月をまたいで取られた予約は印を付ける
      //   （翌月ぶんを前の月のうちに取ると、その時点の残で判定されるため）。
      var _ca = x.createdAt ? Utilities.formatDate(new Date(x.createdAt), SETTINGS.TIMEZONE, 'MM/dd HH:mm') : '不明';
      var _mark = (x.createdAt && _lbMonthKeyJst(x.createdAt) !== keys[k]) ? ' ◀前の月に取得' : '';
      say('     ・' + Utilities.formatDate(new Date(x.startAt), SETTINGS.TIMEZONE, 'MM/dd HH:mm')
          + ' / 取得=' + _ca + _mark
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
  say('   (5) ◀前の月に取得 が並んでいないか');
  say('       翌月ぶんを前の月のうちに取ると、**その時点の残**で判定される。');
  say('       当月でこれから使うチケットが「まだ残っている」と数えられ、');
  say('       翌月の枠を実際より多く見せることがある（チケットの先食い）。');
  return log.join('\n');
}

// ============================================================
// 過去のある時点の残数を再現する（2026-10-04）
//
//   きっかけ：会員#2412 で、10月の枠8回に対して10件の予約が入っていた。
//     ・契約は 月額8回（2026/05/01〜2026/11/01）＋ チケット3枚（2026/09/15〜2026/12/15）
//     ・9月は11件消化（月額8＋チケット3でちょうど使い切り）
//     ・10月の10件は **すべて9月のうちに取られていた**
//         8件 … 9/25 00:06〜00:08（毎月25日の固定枠の自動予約）
//         2件 … 9/25 12:56（手動で追加。10/09 の 10:00 と 11:00）
//     ・いま計算すると「残り0回」と**正しく**出る
//   つまり「9/25 12:56 の時点では、10月にまだ余裕があると見えていた」。
//   いまの数字を何度見てもその時点の見え方は出てこない。再現しないと確かめられない。
//
//   やり方：残数の計算には一切触らない。**渡す予約を減らすだけ**。
//     取得日時（createdAt）が指定の時点より後の予約を除き、
//     残った予約だけを既存の _lbComputeRemaining に渡す。
//     入力を変えて同じ計算器を回す＝計算を書き換えずに過去を再現する唯一の方法。
//
//   ★取得日時が無い予約は除かない（ここを間違えると再現が狂う）。
//     createdAt（台帳のcol11=記録日時）は 2026-10-04 に足したので、
//     それより前に作られた行には入っていない。
//     「無い＝後で取られた」と扱って除くと、過去の予約がまるごと消え、
//     残数が実際より**多く**出る。だから除かずに、何件あったかを出力に明記する。
//
//   ★読み取りだけ。シートもカレンダーも書き換えない。
//   ★氏名・電話・LINE IDは出さない（結果は作業番号を知っていれば読めるため）。
// ============================================================
//   args = { name: '氏名の一部 または 顧客IDの下桁', at: '2026-09-25 12:56' }

// 'YYYY-MM-DD HH:MM[:SS]'（'T'区切りも可）→ { ms, hasTime }。読めなければ null。
//   ★日付だけなら「その日の終わり（23:59:59）」とみなす。
//     00:00 にすると、その日に取られた予約が全部除かれて「その日の前」の再現になる。
//   ★存在しない日付（2026-02-31 等）は Date が翌月へ転がるので、月日を突き合わせて弾く。
function _lbAtParseMs(text) {
  var s = String(text == null ? '' : text).trim().replace(/[Tt]/, ' ').replace(/\//g, '-');
  var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  var hasTime = (m[4] != null);
  var hh = hasTime ? Number(m[4]) : 23;
  var mi = hasTime ? Number(m[5]) : 59;
  var ss = hasTime ? Number(m[6] || 0) : 59;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (hh > 23 || mi > 59 || ss > 59) return null;
  var dt = new Date(y, mo - 1, d, hh, mi, ss);
  if (isNaN(dt.getTime())) return null;
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;   // 転がった＝存在しない日付
  return { ms: dt.getTime(), hasTime: hasTime };
}

// 会員を1人引く（氏名の一部／顧客IDの下桁／顧客IDそのもの）。
//   ★_remainingOneText と同じ引き方をここにも持つ。
//     毎日使っている関数の中身は触らない（壊したときの影響が大きい）。
//     引き方を変えるときは両方を直すこと。
function _lbAtFindMember(spec) {
  var map = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (!map || map.getLastRow() < 2) return { error: '会員名簿が読めません。' };
  var rawId = String(spec).replace(/^\*/, '').trim();
  var byId = /^[0-9]{3,}$/.test(rawId);
  var target = _lbNormName(spec);
  var vals = map.getRange(2, 1, map.getLastRow() - 1, _auditMapWidth(map)).getValues();
  var hits = [], exact = String(spec).trim();
  for (var i = 0; i < vals.length; i++) {
    var cidRow = String(vals[i][MAP_COL.CUSTOMER_ID - 1] || '');
    if (cidRow && cidRow === exact) { hits = [vals[i]]; break; }   // 顧客IDそのものなら一意
    if (byId) { if (cidRow && cidRow.slice(-rawId.length) === rawId) hits.push(vals[i]); }
    else if (_lbNormName(vals[i][MAP_COL.NAME - 1]).indexOf(target) >= 0) hits.push(vals[i]);
  }
  if (!hits.length) return { error: '「' + spec + '」に一致する会員が名簿にいません。'
    + (byId ? '（顧客IDの下' + rawId.length + '桁として探しました）' : '') };
  return { row: hits[0], count: hits.length };
}

// 月ごとの内訳と「どの予約がチケットを使ったか」を取るための割当（表示専用）。
//   ★残数の数字はここから取らない。数字は _lbComputeRemaining が正本。
//     ここは内訳（どの予約がどこへ当たったか）を見せるためだけに使う。
//     条件は _lbComputeRemaining とまったく同じに揃える（揃っているかは下で突き合わせる）。
function _lbAtAllocate(customerId, rows, sessions, asOfKey, throughKey, rate, opening) {
  var ent = _lbRowsToEntitlements(rows, rate);
  if (opening) {
    ent.entitlements.openingCarry = opening.carry || {};
    ent.entitlements.openingPacks = opening.packsUsed || opening.packs || {};
  }
  return _lbAllocateSessions(String(customerId || 'unknown'), ent.entitlements, sessions,
    { asOfMonth: asOfKey, throughMonth: throughKey, carryRateDefault: rate,
      cutoverMonth: (opening ? opening.cutoverMonth : undefined),
      legacyMonthlyFirst: false,
      carryFromContractStart: true,
      recordsFromMonth: (opening ? opening.recordsFrom : undefined) });
}

// 月（ord）を見るときの基準日時。
//   基準の月（asOf）はその時刻そのまま／過去の月はその月の終わり／先の月はその月の1日正午。
//   （先の月を1日正午で見るのは既存の点検と同じ作法）
function _lbAtRefMs(ord, baseOrd, baseMs) {
  if (ord === baseOrd) return baseMs;
  var k = _lbOrdToKey(ord);
  var y = Number(k.slice(0, 4)), mo = Number(k.slice(5, 7)) - 1;
  if (ord < baseOrd) return new Date(y, mo + 1, 0, 23, 59, 59).getTime();   // その月の末日
  return new Date(y, mo, 1, 12, 0, 0).getTime();                            // その月の1日正午
}

function remainingAtText(args) {
  var spec = String((args && args.name) || '').trim();
  var atRaw = String((args && args.at) || '').trim();
  if (!spec || !atRaw) return '版: ' + LB_AUDIT_BUILD
    + '\n再現する会員と時点を渡してください。'
    + '\n  args = { name: "氏名の一部 または 顧客IDの下桁", at: "2026-09-25 12:56" }';

  var at = _lbAtParseMs(atRaw);
  if (!at) return '版: ' + LB_AUDIT_BUILD
    + '\nat の形が読めません。"2026-09-25 12:56"（秒まで可）で渡してください。'
    + '\n日付だけ（"2026-09-25"）なら、その日の終わり（23:59:59）として扱います。';

  var log = [];
  function say(s) { log.push(s); }

  try { CacheService.getScriptCache().remove('lb_contract_all'); } catch (e0) {}

  var found = _lbAtFindMember(spec);
  if (found.error) return '版: ' + LB_AUDIT_BUILD + '\n' + found.error;
  var hit = found.row;
  var customerId = String(hit[MAP_COL.CUSTOMER_ID - 1] || '');
  // ★_cname は契約行を引くためだけに使う。出力には絶対に出さない（下で2箇所しか現れない）。
  var _cname = String(hit[MAP_COL.NAME - 1] || '');
  var who = '会員#' + (customerId ? customerId.slice(-4) : '不明');

  var atMs = at.ms;
  var atKey = _lbMonthKeyJst(atMs);
  var atOrd = _lbMonthOrd(atKey);
  var atStr = Utilities.formatDate(new Date(atMs), SETTINGS.TIMEZONE, 'yyyy/MM/dd HH:mm:ss');
  var nowMs = new Date().getTime();
  var nowKey = _lbMonthKeyJst(nowMs);
  var nowOrd = _lbMonthOrd(nowKey);

  say('===== その時点の残数の再現：' + who + '（' + atStr + ' 時点）=====');
  say('版: ' + LB_AUDIT_BUILD);
  say('（読み取りだけ。シートもカレンダーも書き換えていません）');
  if (found.count > 1) say('※ ' + found.count + '件一致しました。1件目で再現します。');
  if (!at.hasTime) say('※ 時刻の指定が無いので、その日の終わり（23:59:59）を時点としました。');
  say('照合状態=' + String(hit[MAP_COL.AUTH_STATE - 1] || '(空)')
      + ' / 契約状況=' + String(hit[MAP_COL.CONTRACT_STAT - 1] || '(空)'));

  // ---- 計算の前提（数字だけ出して前提を書かないと、また誤って断定する）----
  say('');
  say('■ 計算の前提');
  say('  再現する時点 = ' + atStr);
  say('  この時点より後に**取られた**予約を、計算に渡す前に除きます（除く＝入力を減らすだけ）。');
  say('  この時点の月を「いま」として計算します（asOfMonth=' + atKey + '）。');
  say('  残数の計算そのものは既存の _lbComputeRemaining をそのまま呼んでいます（書き換えていません）。');
  say('  ⚠️ 契約・会員名簿・残数ログは **いまの中身** を読んでいます（過去の中身は残っていません）。');
  say('     ' + atStr + ' 以降にそれらが書き換わっていれば、その分はこの再現に現れません。');
  var rate = (typeof LINE_BOOKING !== 'undefined' && LINE_BOOKING.CARRYOVER_RATE != null)
             ? LINE_BOOKING.CARRYOVER_RATE : (1 / 3);
  var opening = null;
  try {
    opening = _lbMemberOpeningWithFloor(customerId);
    var _logged = _lbMemberOpening(customerId);
    say('  台帳が記録を持ち始めた月 = ' + _lbRecordsFromMonth());
    say('  この会員の下限（ここより前は数えない） = '
        + ((opening && opening.recordsFrom) ? String(opening.recordsFrom) : '(下限なし＝契約開始月まで遡る)'));
    say('  残数ログ = ' + (_logged
        ? ('有（' + (_logged.recordsFrom || '?') + '基準・繰越 ' + _lbMbCarryOf(_logged) + '回'
           + (_logged.packsUsed && _lbCountKeys(_logged.packsUsed) ? '・チケット引継ぎ有' : '') + '）')
        : '無（下限は会員登録の月）'));
  } catch (ePre) { say('  ⚠️ 前提を読めませんでした: ' + ePre.message); }

  // ---- 契約行 ----
  var rows = null;
  try { rows = _lbContractRowsAll(_cname, _lbPhoneByCustomerId(customerId), false, customerId); }
  catch (eC) { return log.join('\n') + '\n⛔ 契約を読めません: ' + eC.message; }
  if (!rows || !rows.length) return log.join('\n') + '\n⛔ 有効な契約行がありません。';
  if (rows.migrationGap) say('⚠️ ID移行が未完了の行があります（残数は要確認扱い）。');

  say('');
  say('■ いまの契約行 ' + rows.length + '件（これがその時点の契約だったと仮定します）');
  for (var r = 0; r < rows.length; r++) {
    var rr = rows[r], cc = rr.cols, row = rr.row;
    var f = function (k) { return (cc[k] >= 0 && cc[k] != null) ? String(row[cc[k]]) : '(列なし)'; };
    var dd = function (x) { return x ? Utilities.formatDate(x, SETTINGS.TIMEZONE, 'yyyy/MM/dd') : '(なし)'; };
    say('  ' + (r + 1) + ') 種別=' + f('type') + ' / 残数方式=' + f('method')
        + ' / 頻度=' + f('freq') + ' / チケット枚数=' + f('ticket')
        + ' / 期間=' + dd(rr.start) + '〜' + dd(rr.end));
  }

  // ---- 予約を取り、その時点より後に取られたものを除く ----
  var all = _lbResvSessions(customerId);
  if (all === null) return log.join('\n') + '\n⛔ 予約台帳が読めません（再現できません）。';

  var kept = [], dropped = [], noStamp = [];
  for (var i = 0; i < all.length; i++) {
    var s = all[i];
    // ★取得日時が無い予約は**除かない**。除くと過去の予約が消えて残が多く出る＝再現が狂う。
    if (s.createdAt == null) { noStamp.push(s); kept.push(s); continue; }
    if (s.createdAt > atMs) { dropped.push(s); continue; }   // この時点より後に取られた＝まだ無かった
    kept.push(s);
  }

  function _mk(x) {
    return (x && x.startAt != null && isFinite(x.startAt)) ? _lbMonthKeyJst(x.startAt) : '(日時不明)';
  }
  function _sline(x) {
    var st = (x.startAt != null && isFinite(x.startAt))
      ? Utilities.formatDate(new Date(x.startAt), SETTINGS.TIMEZONE, 'MM/dd HH:mm') : '日時不明';
    var ca = (x.createdAt != null)
      ? Utilities.formatDate(new Date(x.createdAt), SETTINGS.TIMEZONE, 'MM/dd HH:mm:ss') : '不明';
    return st + ' / 取得=' + ca
      + ' / 消化先=' + (x.consumptionMode || '(自動)')
      + ' / 種類=' + (x.packKind || '通常')
      + ' / 人数=' + (x.attendeeCount == null ? 1 : x.attendeeCount);
  }

  say('');
  say('■ 予約の取り扱い');
  say('  台帳にある本人の予約（confirmed/consumed） ' + all.length + '件');
  say('  ├ この時点より後に取られた＝**除いた** ' + dropped.length + '件');
  say('  ├ 取得日時が無い＝**除かなかった** ' + noStamp.length + '件');
  if (noStamp.length) {
    say('  │   ★取得日時の列は2026-10-04に足したので、それ以前の行には入っていません。');
    say('  │     「無い＝後で取られた」として除くと、過去の予約が消えて残が実際より多く出ます。');
    say('  │     だから除かず、この時点より前に取られたものとして数えています。');
  }
  say('  └ 残して計算に渡した ' + kept.length + '件');
  if (dropped.length) {
    say('');
    say('  ● 除いた予約（この時点より後に取られた）');
    dropped.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
    for (var d1 = 0; d1 < dropped.length; d1++) say('     ・' + _mk(dropped[d1]) + ' ' + _sline(dropped[d1]));
  }
  if (noStamp.length) {
    say('');
    say('  ● 取得日時が無い予約（除いていません）');
    for (var d2 = 0; d2 < noStamp.length; d2++) say('     ・' + _mk(noStamp[d2]) + ' ' + _sline(noStamp[d2]));
  }

  // ---- 見る月を決める（この時点の月・翌月・予約のある月）----
  var ordSet = {};
  ordSet[atOrd] = true; ordSet[atOrd + 1] = true;
  for (var a1 = 0; a1 < all.length; a1++) {
    if (all[a1].startAt == null || !isFinite(all[a1].startAt)) continue;
    ordSet[_lbMonthOrd(_lbMonthKeyJst(all[a1].startAt))] = true;
  }
  var ords = [];
  for (var ok in ordSet) if (ordSet.hasOwnProperty(ok)) ords.push(Number(ok));
  ords.sort(function (x, y) { return x - y; });
  if (ords.length > 6) ords = ords.slice(ords.length - 6);   // 出力を膨らませない（新しい方を残す）
  var throughKey = _lbOrdToKey(ords[ords.length - 1]);

  // ---- 内訳（どの予約がどこへ当たったか）。数字は下の _lbComputeRemaining が正本 ----
  var alcThen = null, alcErr = '';
  try { alcThen = _lbAtAllocate(customerId, rows, kept, atKey, throughKey, rate, opening); }
  catch (eA) { alcErr = eA.message; }

  var persByMonth = {}, packLabel = {}, packSeq = 0, packUse = [];
  if (alcThen) {
    for (var p1 = 0; p1 < alcThen.perPack.length; p1++) {
      packSeq++;
      packLabel[alcThen.perPack[p1].packId] = 'チケット' + packSeq;   // ★packIdは生で出さない（長い数字列は伏せ字処理で壊れる）
    }
    var sidMonth = {}, sidLine = {};
    for (var s1 = 0; s1 < kept.length; s1++) { sidMonth[kept[s1].sessionId] = _mk(kept[s1]); sidLine[kept[s1].sessionId] = _sline(kept[s1]); }
    for (var q = 0; q < alcThen.perSession.length; q++) {
      var ps = alcThen.perSession[q];
      var mk2 = ps.monthKey || '(月不明)';
      var b = persByMonth[mk2] = persByMonth[mk2] || { monthly: 0, pack: 0, transfer: 0, unalloc: 0, reasons: {} };
      if (ps.alloc === 'monthly') b.monthly++;
      else if (ps.alloc === 'pack') {
        b.pack++;
        packUse.push({ monthKey: mk2, label: (packLabel[ps.packId] || 'チケット?'),
                       units: (ps.units == null ? 1 : ps.units), line: (sidLine[ps.sessionId] || '(詳細不明)') });
      } else if (ps.alloc === 'transfer') b.transfer++;
      else { b.unalloc++; b.reasons[ps.reason || '?'] = (b.reasons[ps.reason || '?'] || 0) + 1; }
    }
  }

  // ---- 月ごとの見え方（A=その時点／B=除いた予約を戻す／C=いま）----
  function _calc(sessions, asOfKey, baseOrd, baseMs, ord) {
    var ms = _lbAtRefMs(ord, baseOrd, baseMs);
    try {
      var c = _lbComputeRemaining(customerId, rows, sessions, asOfKey, ms, rate, opening);
      return { r: c, ms: ms, total: ((c.monthlyRem || 0) + (c.ticketRem || 0)) };
    } catch (e) { return { err: e.message, ms: ms }; }
  }

  say('');
  say('■ その時点の見え方（月ごと・' + atStr + ' に計算したとしたら）');
  if (alcErr) say('  ⚠️ 内訳を取れませんでした（' + alcErr + '）。残数の数字は下に出ます。');
  var A = {}, B = {}, C = {};
  for (var z = 0; z < ords.length; z++) {
    var ord = ords[z], mk3 = _lbOrdToKey(ord);
    A[mk3] = _calc(kept, atKey, atOrd, atMs, ord);
    B[mk3] = _calc(all, atKey, atOrd, atMs, ord);
    C[mk3] = _calc(all, nowKey, nowOrd, nowMs, ord);

    var tag = (ord === atOrd) ? '（この時点の月）' : (ord === atOrd + 1 ? '（その翌月）' : (ord < atOrd ? '（過去）' : ''));
    say('');
    say('  ' + mk3 + tag + '  基準日時=' + Utilities.formatDate(new Date(A[mk3].ms), SETTINGS.TIMEZONE, 'yyyy/MM/dd HH:mm'));
    if (A[mk3].err) { say('    ⛔ 計算できません: ' + A[mk3].err); continue; }
    var ar = A[mk3].r;
    var bd = persByMonth[mk3] || { monthly: 0, pack: 0, transfer: 0, unalloc: 0, reasons: {} };
    var later = 0;
    for (var d3 = 0; d3 < dropped.length; d3++) if (_mk(dropped[d3]) === mk3) later++;
    say('    枠（頻度＋繰越）= ' + ar.avail + '（うち頻度 ' + ar.freq + '）');
    say('    計算に入った予約 ' + (bd.monthly + bd.pack + bd.transfer + bd.unalloc) + '件'
        + '（月額で消化 ' + bd.monthly + ' ／ チケットで消化 ' + bd.pack
        + ' ／ 振替 ' + bd.transfer + ' ／ 割当できず ' + bd.unalloc + '）');
    if (bd.unalloc) {
      var rk = [];
      for (var k4 in bd.reasons) if (bd.reasons.hasOwnProperty(k4)) rk.push(k4 + ' ' + bd.reasons[k4] + '件');
      say('      割当できなかった理由：' + rk.join(' / '));
    }
    say('    月額残 = ' + (ar.monthlyRem == null ? '(頻度未設定＝無制限扱い)' : ar.monthlyRem)
        + ' ／ チケット残 = ' + ar.ticketRem
        + ' ／ ▶ その時点で予約できる残り = ' + A[mk3].total);
    if (later) say('    ◀ この月の予約は、この時点より後に ' + later + '件 増えています');
    if (ar.ok === false) say('    ⚠️ 割当器が「要確認」と判定: ' + JSON.stringify(ar.issues || []));

    // 内訳と残数が同じ条件で出ているかの突き合わせ（ずれたら内訳を信用しない）
    if (alcThen && ar.monthlyRem != null) {
      var pmA = null;
      for (var pm1 = 0; pm1 < alcThen.perMonth.length; pm1++) if (alcThen.perMonth[pm1].monthKey === mk3) { pmA = alcThen.perMonth[pm1]; break; }
      if (pmA && Number(pmA.monthlyRemaining) !== Number(ar.monthlyRem)) {
        say('    ⚠️ 内訳と残数が一致しません（内訳の月額残=' + pmA.monthlyRemaining + ' / 残数=' + ar.monthlyRem + '）。'
            + '内訳は参考に留めてください（見る月の範囲の違いで起こります）。');
      }
    }
  }

  // ---- チケット ----
  say('');
  say('■ チケット（その時点）');
  var arAt = A[atKey] && A[atKey].r;
  if (arAt) {
    say('  ' + atKey + ' を対象にしたチケット残 = ' + arAt.ticketRem + '枚'
        + '（通常 ' + arAt.ticketRemNormal + ' ／ ペア ' + arAt.ticketRemPair + '）');
    if (arAt.ticketPacks && arAt.ticketPacks.length) {
      for (var tp = 0; tp < arAt.ticketPacks.length; tp++) {
        say('    ・残 ' + arAt.ticketPacks[tp].remaining + '枚'
            + ' / 期限 ' + Utilities.formatDate(new Date(arAt.ticketPacks[tp].expireMs), SETTINGS.TIMEZONE, 'yyyy/MM/dd')
            + ' / 種類 ' + (arAt.ticketPacks[tp].kind === 'pair' ? 'ペア' : '通常'));
      }
    } else say('    ・この時点で有効なチケットの残はありません');
  }
  if (alcThen) {
    say('  契約上のチケット：' + alcThen.perPack.length + '枚組');
    for (var p2 = 0; p2 < alcThen.perPack.length; p2++) {
      var pp = alcThen.perPack[p2];
      say('    ・' + (packLabel[pp.packId] || 'チケット?') + '：' + pp.qty + '枚中 ' + pp.used + '枚を使用した扱い（残 ' + pp.remaining + '）'
          + ' / 種類 ' + (pp.kind === 'pair' ? 'ペア' : '通常'));
    }
    say('  チケットを使った扱いになった予約 ' + packUse.length + '件');
    packUse.sort(function (x, y) { return (x.monthKey < y.monthKey) ? -1 : (x.monthKey > y.monthKey ? 1 : 0); });
    for (var u = 0; u < packUse.length; u++) {
      say('    ・' + packUse[u].monthKey + ' ' + packUse[u].line
          + ' → ' + packUse[u].label + (packUse[u].units > 1 ? '（' + packUse[u].units + '枚）' : ''));
    }
    if (!packUse.length) say('    （ありません）');
  }

  // ---- いまとの差 ----
  say('');
  say('■ いまの計算との差（何が変わったか）');
  say('  A … その時点（除いた ' + dropped.length + '件を抜き・asOfMonth=' + atKey + '）');
  say('  B … 参考：A と同じ基準のまま、除いた ' + dropped.length + '件を戻した場合'
      + ' → A→B の差が「後から取られた予約」ぶん');
  say('  C … いま（予約を全部・asOfMonth=' + nowKey + '・基準日時もいま）'
      + ' → B→C の差が「基準日時が動いたこと」ぶん');
  for (var z2 = 0; z2 < ords.length; z2++) {
    var mk5 = _lbOrdToKey(ords[z2]);
    var ta = A[mk5].err ? null : A[mk5].total;
    var tb = B[mk5].err ? null : B[mk5].total;
    var tc = C[mk5].err ? null : C[mk5].total;
    var sgn = function (n) { return (n > 0 ? '+' : '') + n; };
    say('  ' + mk5 + '：予約できる残り  A=' + (ta == null ? '?' : ta)
        + ' ／ B=' + (tb == null ? '?' : tb)
        + ' ／ C=' + (tc == null ? '?' : tc)
        + ((ta != null && tb != null && tc != null)
            ? ('　→ A→C ' + sgn(tc - ta) + '（後から取られた予約 ' + sgn(tb - ta)
               + ' ／ 基準日時の違い ' + sgn(tc - tb) + '）')
            : ''));
    if (!A[mk5].err && !C[mk5].err) {
      say('        月額残 A=' + (A[mk5].r.monthlyRem == null ? '?' : A[mk5].r.monthlyRem)
          + '→C=' + (C[mk5].r.monthlyRem == null ? '?' : C[mk5].r.monthlyRem)
          + ' ／ チケット残 A=' + A[mk5].r.ticketRem + '→C=' + C[mk5].r.ticketRem
          + ' ／ 枠 A=' + A[mk5].r.avail + '→C=' + C[mk5].r.avail);
    }
  }

  say('');
  say('■ 読むときの注意');
  say('  ・A が 0 より大きいのに、いま C が 0 なら、その時点では「まだ空いている」と見えていた。');
  say('    枠を超えて受け付けたのではなく、**その時点の見え方のまま受け付けた**ということ。');
  say('  ・翌月ぶんを前の月のうちに取ると、その時点の残で判定される。');
  say('    当月でこれから使うチケットが「まだ残っている」と数えられ、');
  say('    翌月の枠を実際より多く見せることがある（チケットの先食い）。');
  say('  ・取得日時が無い予約が多いほど、この再現は「その時点より前に取られた」側へ寄る。');
  say('    件数は上の「予約の取り扱い」に出している。');
  say('');
  say('===== ここまで。何も書き換えていません =====');
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
//   args.date は 'YYYY-MM-DD'（その日）または 'YYYY-MM'（その月まるごと）。
//   月で渡せるようにしたのは、検証用に入れた予約をまとめて洗い出して
//   消す行を決めるため（2026-10-01）。行番号を必ず添える。
function dayReservationsText(dateStr) {
  var raw = String(dateStr || '');
  var m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  var mm = m ? null : raw.match(/^(\d{4})-(\d{2})$/);
  if (!m && !mm) return '版: ' + LB_AUDIT_BUILD
    + '\n日付を YYYY-MM-DD（その日）か YYYY-MM（その月）の形で args.date に渡してください。';

  var y, mo, d, dayStart, dayEnd, title;
  if (m) {
    y = Number(m[1]); mo = Number(m[2]) - 1; d = Number(m[3]);
    dayStart = new Date(y, mo, d, 0, 0, 0).getTime();
    dayEnd   = new Date(y, mo, d + 1, 0, 0, 0).getTime();
    title = m[1] + '/' + m[2] + '/' + m[3] + ' の予約';
  } else {
    y = Number(mm[1]); mo = Number(mm[2]) - 1;
    dayStart = new Date(y, mo, 1, 0, 0, 0).getTime();
    dayEnd   = new Date(y, mo + 1, 1, 0, 0, 0).getTime();
    title = mm[1] + '/' + mm[2] + ' の予約（1ヶ月ぶん）';
  }

  var log = [];
  function say(s) { log.push(s); }
  say('===== ' + title + '（読み取りだけ）=====');
  say('版: ' + LB_AUDIT_BUILD);

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
      sortKey: t,
      time: Utilities.formatDate(dt, SETTINGS.TIMEZONE, m ? 'HH:mm' : 'MM/dd HH:mm'),
      cid: String(v[2] || ''),
      hasName: String(v[1] || '') ? 'あり' : 'なし',
      trainer: String(v[5] || v[4] || ''),
      status: st,
      channel: String(v[9] || '')
    });
  }

  rows.sort(function (a, b) { return a.sortKey - b.sortKey; });
  say('台帳にこの期間の行 ' + rows.length + '件');
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
  if (!m && rows.length) {
    var nums = [];
    for (var n = 0; n < rows.length; n++) nums.push(rows[n].row);
    nums.sort(function (a, b) { return a - b; });
    say('');
    say('■ この期間の台帳の行番号（消す判断に使えます）');
    say('   ' + nums.join(', '));
    say('   ※ 行を消すと、その予約は消化から外れ、残数が戻ります。');
    say('      下から上へ（行番号の大きい方から）消してください。上から消すと番号がずれます。');
  }

  say('');
  say('※ 台帳に無い予約（カレンダーに手入力して氏名が一致しなかったもの）は、ここには出ません。');
  say('   その場合は健康診断の「未紐付けの予約」に出ます。');
  return log.join('\n');
}

// ============================================================
// 契約行が二重に効いていないかの検査（2026-10-02）
//
//   きっかけ：棚卸しの「3. 契約行の中身」で、終了日が空の行14件のうち8件が
//   「同じ方に別の契約行がある」と出た。古い契約行の終了日が空のままだと、
//   新しい契約が始まっても古い行が生き続ける。2つの月額契約が同時に有効になれば
//   頻度が合計されて枠が二重に足され、契約の回数を超えて予約できてしまう。
//
//   ★ただし「同時に有効な行が2つある」ことと「いま枠が二重になっている」ことは別。
//     いまの割当器は、ある月に当てはまる月額行のうち**開始がいちばん新しい1行だけ**を
//     採用する（Allocate.js の _lbMonthlyForMonth）。だから行が重なっていても
//     ふつうは枠は二重にならない。入力の不備（放置すれば将来ずれる）と、
//     いま実際にずれていることを必ず分けて出す。
//
//   判定（誤検知を出さないための組み立て）：
//     ① その月に同時に有効な月額行を並べる（範囲の判定は _lbMonthlyCoverage と同じ）
//     ② 2行以上ある会員だけを対象にする（1行なら継続契約として正常）
//     ③ 実際に効くのは開始がいちばん新しい行。枠の上限は「その頻度 ＋ 繰越で入りうる上限」
//     ④ 繰越で入りうる上限は**前月に効いていた行**の繰越上限で測る。
//        頻度の少ない契約へ切り替えた月は前月の上限ぶんが繰り越されてくるので、
//        当月の上限で測ると正当な繰越を二重と誤報する（例：頻度12→2の切替月）。
//        棚卸しの繰越seedがある月は、そのseedも上限に含める。
//     ⑤ いまの月額枠（_lbSplitRemaining の avail）が上限を超えていたら「二重の疑い」。
//        超えていなければ「二重にはなっていない」と**明言する**。
//        ここを曖昧に「疑い」と出すと、正常な契約更新まで疑わしく見えて点検が信用を失う。
//
//   ★読み取りだけ。氏名・電話・LINE IDは出さない。会員は顧客IDの下4桁で示す。
// ============================================================

// ある月に同時に有効な月額行を並べる。先頭＝実際に効く行（開始がいちばん新しい）。
//   monthlyRows は _lbRowsToEntitlements が作る { frequency, carryRate, carryCap, serviceFrom, serviceTo }。
function _auditActiveMonthly(monthlyRows, monthKey) {
  var tOrd = _lbMonthOrd(monthKey), out = [];
  for (var i = 0; i < (monthlyRows || []).length; i++) {
    var mr = monthlyRows[i];
    var fO = (mr.serviceFrom != null) ? _lbMonthOrd(_lbMonthKeyJst(mr.serviceFrom)) : -1e9;
    var tO = (mr.serviceTo != null) ? _lbMonthOrd(_lbMonthKeyJst(mr.serviceTo)) : 1e9;
    if (tOrd < fO || tOrd > tO) continue;
    out.push({
      freq: Number(mr.frequency) || 0, carryCap: mr.carryCap, carryRate: mr.carryRate,
      fromOrd: fO, toOrd: tO,
      from: (mr.serviceFrom != null) ? _lbMonthKeyJst(mr.serviceFrom) : '(開始なし)',
      to: (mr.serviceTo != null) ? _lbMonthKeyJst(mr.serviceTo) : '(終了日が空)'
    });
  }
  // 割当器と同じ採用順（開始が新しい方が先）。
  out.sort(function (a, b) { return b.fromOrd - a.fromOrd; });
  return out;
}

// 会員1人・1ヶ月ぶんの判定（純粋・シートを読まない）。
//   rows   … _lbContractRowsAll が返す契約行
//   avail  … _lbSplitRemaining の avail（月額の枠＝頻度＋繰越）。不明なら null
//   openingCarry … その月の棚卸し繰越seed（無ければ null）
function _contractDoubleCharge(rows, monthKey, avail, openingCarry) {
  var r = { monthKey: monthKey, count: 0, rows: [], sumFreq: 0, appliedFreq: 0,
            cap: 0, prevCap: 0, seed: null, allowCarry: 0, maxLegit: 0,
            avail: null, suspect: false, tie: false };
  var rate = (typeof LINE_BOOKING !== 'undefined' && LINE_BOOKING.CARRYOVER_RATE != null)
             ? LINE_BOOKING.CARRYOVER_RATE : (1 / 3);
  var ent = _lbRowsToEntitlements(rows || [], rate);
  var mrows = ent.entitlements.monthlyRows;
  var active = _auditActiveMonthly(mrows, monthKey);
  r.count = active.length;
  r.rows = active;
  if (!active.length) return r;

  for (var i = 0; i < active.length; i++) r.sumFreq += active[i].freq;
  var top = active[0];
  r.appliedFreq = top.freq;
  r.cap = _lbResolveCarryCap(top.freq, top.carryCap, top.carryRate);   // この月から翌月へ回せる上限

  // 繰越で入りうる上限は「前月に効いていた行」の上限（当月の上限ではない）。
  var prev = _auditActiveMonthly(mrows, _lbOrdToKey(_lbMonthOrd(monthKey) - 1));
  r.prevCap = prev.length ? _lbResolveCarryCap(prev[0].freq, prev[0].carryCap, prev[0].carryRate) : 0;

  var seed = Number(openingCarry);
  r.seed = (openingCarry != null && isFinite(seed)) ? seed : null;
  r.allowCarry = Math.max(r.prevCap, (r.seed != null && r.seed > 0) ? r.seed : 0);
  r.maxLegit = r.appliedFreq + r.allowCarry;

  // 開始が同じ月で内容が割れている＝どちらで数えるか決まらない（割当器は REVIEW_REQUIRED にする）
  for (var j = 1; j < active.length; j++) {
    if (active[j].fromOrd !== top.fromOrd) continue;
    if (active[j].freq !== top.freq ||
        _lbResolveCarryCap(active[j].freq, active[j].carryCap, active[j].carryRate) !== r.cap) { r.tie = true; break; }
  }

  if (avail != null && isFinite(Number(avail))) {
    r.avail = Number(avail);
    // 2行以上あるときだけ「二重」と言う。1行なら重なっていないので判定しない。
    if (active.length >= 2 && r.avail > r.maxLegit) r.suspect = true;
  }
  return r;
}

// embedded=true のときは棚卸しの一節として埋め込む（見出しと版の重複を出さない）
function contractOverlapImpactText(embedded) {
  var out = [];
  function say(x) { out.push(x); }
  var now = new Date(), nowMs = now.getTime();
  var nowKey = _lbMonthKeyJst(nowMs);
  // 翌月の1日・正午。25日以降は翌月の予約が開くので、翌月も見ないと手遅れになる。
  var nextMs = new Date(now.getFullYear(), now.getMonth() + 1, 1, 12, 0, 0).getTime();
  var nextKey = _lbMonthKeyJst(nextMs);

  if (!embedded) {
    say('===== 契約行が二重に効いていないかの検査 '
        + Utilities.formatDate(now, SETTINGS.TIMEZONE, 'yyyy/MM/dd HH:mm') + '（読み取りだけ）=====');
    say('版: ' + LB_AUDIT_BUILD);
    say('※氏名は出しません。会員は顧客IDの下4桁で示します。');
  }
  say('対象の月: ' + nowKey + '（当月）／ ' + nextKey + '（翌月）');
  say('見方: 同時に有効な月額行が2行以上あっても、実際に効くのは開始がいちばん新しい1行です。');
  say('      いまの月額枠がその行の「頻度＋繰越で入りうる上限」を超えていたら、枠が二重に足されています。');

  var map = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (!map || map.getLastRow() < 2) { say('⛔ 会員名簿が読めません。'); return out.join('\n'); }
  var vals = map.getRange(2, 1, map.getLastRow() - 1, _auditMapWidth(map)).getValues();

  // 予約台帳は1回だけ読み、会員ごとの消化は同じ値から導く。
  //   会員ごとに読み直すと、人数ぶん台帳を読んで6分を使い切る（棚卸しに相乗りするため）。
  var rvals = null, rvalsOk = false;
  try {
    var rsh = _lbSheet(LINE_BOOKING.RESV_SHEET);
    if (rsh) {
      var lastR = rsh.getLastRow();
      rvals = (lastR < 2) ? [] : rsh.getRange(2, 1, lastR - 1, Math.max(12, rsh.getLastColumn())).getValues();
      rvalsOk = true;
    }
  } catch (eR) { rvalsOk = false; }
  if (!rvalsOk) say('⚠️ 予約台帳が読めないため、枠（avail）は出せません。行の重なりだけを出します。');

  var checked = 0, overlapped = 0, suspects = 0, ties = 0, minuses = 0, skipped = [], blocks = [];
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][MAP_COL.AUTH_STATE - 1]) !== 'verified') continue;   // 照合前・却下は無効な登録
    var nm = String(vals[i][MAP_COL.NAME - 1] || ''); if (!nm) continue;
    var cid = String(vals[i][MAP_COL.CUSTOMER_ID - 1] || ''); if (!cid) continue;
    var who = '*' + cid.slice(-4);
    checked++;

    var rows = null;
    try { rows = _lbContractRowsAll(nm, _lbPhoneByCustomerId(cid), false, cid); }
    catch (e1) { skipped.push(who + '(契約が読めない)'); continue; }
    if (!rows || !rows.length) continue;

    // まず枠を見ずに「同時に有効な月額行が2行以上あるか」だけで絞る（台帳から作る会員を最小にする）
    var pre = {};
    pre[nowKey] = _contractDoubleCharge(rows, nowKey, null, null);
    pre[nextKey] = _contractDoubleCharge(rows, nextKey, null, null);
    if (pre[nowKey].count < 2 && pre[nextKey].count < 2) continue;
    overlapped++;

    var sessions = null;
    if (rvalsOk) {
      try { sessions = _lbResvValsToSessions(rvals, cid, _lbParseResvDate); } catch (e2) { sessions = null; }
    }
    var opening = null;
    try { opening = _lbMemberOpeningWithFloor(cid); } catch (e3) { opening = null; }

    var blk = ['・' + who], keys = [nowKey, nextKey];
    var memberSuspect = false, memberTie = false, memberMinus = false;
    for (var k = 0; k < keys.length; k++) {
      var mk = keys[k];
      if (pre[mk].count < 2) {
        blk.push('   ' + mk + '：同時に有効な月額行は ' + pre[mk].count + '行（重なっていません）');
        continue;
      }
      var avail = null, note = '', spFreq = null;
      if (sessions === null) note = '（台帳が読めないため不明）';
      else {
        try {
          var sp = _lbSplitRemaining(rows, cid, (mk === nowKey ? nowMs : nextMs), sessions);
          if (sp && sp.avail != null) avail = Number(sp.avail);
          if (sp && sp.freq != null) spFreq = Number(sp.freq);   // 会員画面に出る「月○回」
          if (sp && sp._ok === false) note = '（割当器が「要確認」と判定）';
        } catch (e4) { note = '（枠を計算できない: ' + e4.message + '）'; }
      }
      var seed = (opening && opening.carry && opening.carry[mk] != null) ? Number(opening.carry[mk]) : null;
      var r = _contractDoubleCharge(rows, mk, avail, seed);

      // ★会員画面に出る数字も見る（2026-10-02）。上で計算した結果を使い回す（読み直さない）。
      //   会員ホームは quota=「同時有効行の最大頻度」／carryover=「枠−その頻度」で表示する。
      //   契約行が重なって、新しい行の頻度が古い行より少ないと carryover がマイナスになり、
      //   顧客の画面に「月4回・繰越-1回」と出る。残数は正しいので予約はできるが、
      //   顧客に見せる数字にマイナスを出してはいけない（オーナー指示）。
      var shownQuota = null, shownCarry = null;
      if (spFreq != null && avail != null) {
        shownQuota = spFreq;
        shownCarry = avail - spFreq;
      }
      var parts = [];
      for (var z = 0; z < r.rows.length; z++) parts.push('頻度' + r.rows[z].freq + '：' + r.rows[z].from + '〜' + r.rows[z].to);
      blk.push('   ' + mk + '：同時に有効な月額行 ' + r.count + '行（' + parts.join(' ／ ') + '）');
      blk.push('     頻度の合計=' + r.sumFreq
               + ' ／ 実際に効く頻度=' + r.appliedFreq + '（開始がいちばん新しい行）'
               + ' ／ 繰越で入りうる上限=' + r.allowCarry + (r.seed != null ? '（棚卸しのseed=' + r.seed + '）' : '')
               + ' ／ いまの月額枠=' + (r.avail == null ? '不明' : r.avail) + note);
      if (r.tie) {
        blk.push('     ⚠ 開始が同じ月の月額行で頻度・繰越上限が割れています。どちらで数えるかが決まりません。');
        memberTie = true;
      }
      if (shownQuota != null) {
        blk.push('     ▶ 会員画面の表示：月' + shownQuota + '回 ／ 繰越' + shownCarry + '回'
                 + (shownCarry < 0 ? '   🚨 顧客の画面にマイナスが出ています' : ''));
        if (shownCarry < 0) memberMinus = true;
      }
      if (r.suspect) {
        blk.push('     🚨 二重の疑い：枠 ' + r.avail + ' が上限 ' + r.maxLegit
                 + '（頻度' + r.appliedFreq + '＋繰越' + r.allowCarry + '）を超えています。頻度の合計=' + r.sumFreq + '。');
        memberSuspect = true;
      } else if (r.avail == null) {
        blk.push('     → 枠が読めないため、二重かどうかは判定できません。');
      } else {
        blk.push('     → 二重にはなっていません（枠 ' + r.avail + ' ≦ 上限 ' + r.maxLegit + '。新しい行だけが効いています）。');
      }
    }
    if (memberSuspect) suspects++;
    if (memberTie) ties++;
    if (memberMinus) minuses++;
    blocks.push(blk.join('\n'));
  }

  say('');
  say('── 調べた会員 ' + checked + '名 ／ 同時に有効な月額行が2行以上ある会員 ' + overlapped + '名'
      + ' ／ 枠が二重の疑い ' + suspects + '名 ／ 開始が同じで内容が割れている ' + ties + '名'
      + (minuses ? ' ／ 🚨 顧客の画面にマイナスが出ている ' + minuses + '名'
                 : ' ／ 顧客の画面のマイナス なし'));
  say('');
  if (!blocks.length) {
    say('（同時に有効な月額行が2行以上ある会員はいません）');
  } else {
    for (var L = 0; L < blocks.length; L++) say(blocks[L]);
    say('');
    if (!suspects) {
      say('※ いま枠が二重になっている会員はいません（古い行は効いていません）。');
    } else {
      say('★ 二重の疑いがある会員は、古い契約行の終了日を入れてから残数を確認してください。');
    }
    if (minuses) {
      say('');
      say('🚨 顧客の画面に「繰越-1回」のようなマイナスが出ている会員が ' + minuses + '名います。');
      say('   残数そのものは正しく、予約はできます。表示だけが矛盾しています。');
      say('   原因：会員画面は「同時に有効な行の最大頻度」を月の回数として出すのに、');
      say('         枠は「開始がいちばん新しい行」で計算されるため、頻度を下げた切替で食い違います。');
      say('   ★古い契約行に終了日を入れれば、この表示も直ります。');
    }
    if (overlapped) {
      say('');
      say('※ 古い行の終了日が空のままだと、次の契約更新で二重になります。');
      say('   古い行に終了日を入れてください（行番号は「3. 契約行の中身」の一覧に出ています）。');
    }
  }
  if (skipped.length) { say(''); say('■ 調べられなかった会員: ' + skipped.join(' / ')); }
  if (!embedded) { say(''); say('===== ここまで。何も書き換えていません =====');}
  return out.join('\n');
}

function contractOverlapImpact() { Logger.log(contractOverlapImpactText()); }

// ============================================================
// 月額会員ぜんぶの残数を、氏名つきで1回で一覧する（2026-10-02）
//
//   きっかけ：オーナーが全月額会員の残数を確かめるまでリマインド配信を開始しない判断をした。
//   ところが1人ずつ調べる関数（remainingNamed）しかなく、38名を見るのに現実的でない。
//   この一覧が配信開始を止めているボトルネックだったので、1回で出す。
//
//   ★GASエディタ専用。氏名を出すのはここだけ。
//     作業依頼（EdgeJob.js）からは呼べない作りにする。作業依頼の結果は作業番号を
//     知っていれば合言葉なしで読めるURLに置かれるため、氏名を載せると社外へ出る経路ができる。
//     （remainingNamedForNudge / remainingNamed と同じ考え方）
//
//   ★読み取りだけ。何も書き換えない。
//
//   ★予約台帳は1回だけ読む。会員ごとに読み直すと38人ぶん台帳を読んで6分を使い切る。
//     （contractOverlapImpactText と同じやり方）
//
//   使い方：GASエディタで monthlyMembersRemainingNamed を選び、実行 → 実行ログに出ます。
// ============================================================

// 実行ログは1件が長すぎると途中で切れる。会員ブロックの区切りで分けて出す。
function _lbAuditLogChunks(text, limit) {
  var cap = limit || 6000;
  var lines = String(text == null ? '' : text).split('\n');
  var buf = [], len = 0;
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i];
    if (len && (len + ln.length + 1) > cap) { Logger.log(buf.join('\n')); buf = []; len = 0; }
    buf.push(ln); len += ln.length + 1;
  }
  if (buf.length) Logger.log(buf.join('\n'));
}

function monthlyMembersRemainingNamed() {
  _lbAuditLogChunks(_monthlyMembersRemainingNamedText());
}

function _monthlyMembersRemainingNamedText(nowMs) {
  var out = [];
  function say(s) { out.push(s); }

  var ms = (nowMs != null) ? nowMs : new Date().getTime();
  var now = new Date(ms);
  var nowKey = _lbMonthKeyJst(ms);
  // 翌月の1日・正午。25日以降は翌月の予約が開くので、翌月も見ないと手遅れになる。
  var nextMs = new Date(now.getFullYear(), now.getMonth() + 1, 1, 12, 0, 0).getTime();
  var nextKey = _lbMonthKeyJst(nextMs);

  say('===== 月額会員の残数の一覧（氏名つき・読み取りだけ）'
      + Utilities.formatDate(now, SETTINGS.TIMEZONE, 'yyyy/MM/dd HH:mm') + ' =====');
  say('版: ' + LB_AUDIT_BUILD);
  say('★この出力には個人情報が含まれます。外部へ貼らないでください。');
  say('対象の月: ' + nowKey + '（当月）／ ' + nextKey + '（翌月）');

  try { CacheService.getScriptCache().remove('lb_contract_all'); } catch (eC) {}

  var map = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (!map || map.getLastRow() < 2) { say('⛔ 会員名簿が読めません。'); return out.join('\n'); }
  var vals = map.getRange(2, 1, map.getLastRow() - 1, _auditMapWidth(map)).getValues();

  // 予約台帳は1回だけ読む（会員ごとに読み直さない）
  var rvals = null, rvalsOk = false;
  try {
    var rsh = _lbSheet(LINE_BOOKING.RESV_SHEET);
    if (rsh) {
      var lastR = rsh.getLastRow();
      rvals = (lastR < 2) ? [] : rsh.getRange(2, 1, lastR - 1, Math.max(12, rsh.getLastColumn())).getValues();
      rvalsOk = true;
    }
  } catch (eR) { rvalsOk = false; }
  if (!rvalsOk) say('⚠️ 予約台帳が読めません。残数はすべて「算出できない」扱いになります。');

  var rate = (typeof LINE_BOOKING !== 'undefined' && LINE_BOOKING.CARRYOVER_RATE != null)
             ? LINE_BOOKING.CARRYOVER_RATE : (1 / 3);

  var checked = 0, monthly = 0, skipped = [];
  var nUnknown = 0, nOdd = 0, nZero = 0, nOver = 0;
  var review = [], fine = [];

  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][MAP_COL.AUTH_STATE - 1]) !== 'verified') continue;   // 照合前・却下は無効な登録
    var nm = String(vals[i][MAP_COL.NAME - 1] || ''); if (!nm) continue;
    var cid = String(vals[i][MAP_COL.CUSTOMER_ID - 1] || ''); if (!cid) continue;
    checked++;

    var rows = null;
    try { rows = _lbContractRowsAll(nm, _lbPhoneByCustomerId(cid), false, cid); }
    catch (e1) { skipped.push(nm + '（会員#' + cid.slice(-4) + '・契約が読めない）'); continue; }
    if (!rows || !rows.length) continue;

    var sessions = null;
    if (rvalsOk) {
      try { sessions = _lbResvValsToSessions(rvals, cid, _lbParseResvDate); } catch (e2) { sessions = null; }
    }

    // 月額を持つかどうかは契約行だけで分かる（シートを読まない純粋な判定）。
    //   ★予約が読めないときに残数の計算へ入らないため、ここで先に判定する。
    //     _lbSplitRemaining に予約を渡さないと、関数の中で会員ごとに台帳を読み直してしまう。
    var entMonthly = false;
    try { entMonthly = !!_lbRowsToEntitlements(rows, rate).hasMonthly; }
    catch (eE) { skipped.push(nm + '（会員#' + cid.slice(-4) + '・契約を解釈できない: ' + eE.message + '）'); continue; }
    if (!entMonthly) continue;   // ★月額契約を持つ会員だけを対象にする
    monthly++;

    var sp = null, spNext = null, calcErr = '';
    if (sessions !== null) {
      try {
        sp = _lbSplitRemaining(rows, cid, ms, sessions);
        spNext = _lbSplitRemaining(rows, cid, nextMs, sessions);
      } catch (e3) { calcErr = e3.message; sp = null; spNext = null; }
    }

    // ---- 確認が要るかどうか ----
    var flags = [];
    var unknown = (sessions === null) || !sp || (sp._ok === false) || (sp.monthlyRem == null);
    if (unknown) flags.push('残数が算出できない' + (calcErr ? '（' + calcErr + '）' : ''));

    var odd = _contractOddities(rows);
    if (odd.length) flags.push('契約の入力に食い違い');

    var total = unknown ? null : ((sp.monthlyRem || 0) + (sp.ticketRem || 0));
    if (total === 0) flags.push('残数が0');

    // 残数が「頻度＋繰越上限」を超えていないか。
    //   上限の出し方は二重検査と同じ道具を使う（_contractDoubleCharge の maxLegit）。
    //   ただし二重検査は「月額行が2行以上」のときだけ疑うので、ここでは行数に関わらず超過を見る。
    var opening = null;
    try { opening = _lbMemberOpeningWithFloor(cid); } catch (e4) { opening = null; }
    var seed = (opening && opening.carry && opening.carry[nowKey] != null) ? Number(opening.carry[nowKey]) : null;
    var dc = null, over = false;
    try {
      dc = _contractDoubleCharge(rows, nowKey, (unknown ? null : sp.avail), seed);
      if (dc && dc.count >= 1 && dc.avail != null && dc.avail > dc.maxLegit) { over = true; }
    } catch (e5) { dc = null; }
    if (over) flags.push('残数が頻度＋繰越上限を超えている（多すぎる）');

    if (unknown) nUnknown++;
    if (odd.length) nOdd++;
    if (total === 0) nZero++;
    if (over) nOver++;

    // ---- 1会員のブロック（簡潔に。38名ぶん出すため罫線と必要な数字だけ） ----
    var blk = [];
    var who = nm + '（会員#' + cid.slice(-4) + '）';
    blk.push('━━━━━━━━ ' + (flags.length ? '⚠ 確認が要る ' : '○ ') + who + ' ━━━━━━━━');
    if (flags.length) blk.push('  要確認: ' + flags.join(' / '));

    // 計算の前提（_remainingOneText と同じ形。数字だけ出して前提を省くと誤読する）
    try {
      var logged = _lbMemberOpening(cid);
      blk.push('  前提: 台帳の記録開始=' + _lbRecordsFromMonth()
               + ' ／ この会員の下限=' + ((opening && opening.recordsFrom) ? String(opening.recordsFrom) : '(なし＝契約開始月まで遡る)')
               + ' ／ 残数ログ=' + (logged ? ('有（' + (logged.recordsFrom || '?') + '基準・繰越' + _lbMbCarryOf(logged) + '回'
                   + ((logged.packsUsed && _lbCountKeys(logged.packsUsed)) ? '・チケット引継ぎ有' : '') + '）')
                 : '無（下限は会員登録の月）'));
    } catch (e6) { blk.push('  前提: ⚠️ 読めませんでした（' + e6.message + '）'); }

    blk.push('  契約 ' + rows.length + '件' + (rows.migrationGap ? '（⚠️ ID移行が未完了の行あり）' : ''));
    for (var r = 0; r < rows.length; r++) {
      var rr = rows[r], cc = rr.cols, row = rr.row;
      var f = function (k) { return (cc[k] >= 0 && cc[k] != null) ? String(row[cc[k]]) : '(列なし)'; };
      var dd = function (x) { return x ? Utilities.formatDate(x, SETTINGS.TIMEZONE, 'yyyy/MM/dd') : '(なし)'; };
      blk.push('    ' + (r + 1) + ') 種別=' + f('type') + ' / 方式=' + f('method') + ' / 頻度=' + f('freq')
               + ' / 券=' + f('ticket') + ' / 繰越上限=' + f('carryCap')
               + ' / 期間=' + dd(rr.start) + '〜' + dd(rr.end));
    }
    if (odd.length) for (var o = 0; o < odd.length; o++) blk.push('  ⚠ 食い違い: ' + odd[o]);

    function remLine(label, mk, s) {
      if (!s) return '  ' + label + ' ' + mk + '：計算できませんでした';
      var mr = (s.monthlyRem == null) ? '無制限扱い（頻度の入力なし）' : s.monthlyRem;
      var tt = (s.monthlyRem == null) ? '不明' : ((s.monthlyRem || 0) + (s.ticketRem || 0));
      return '  ' + label + ' ' + mk + '：枠(頻度' + (s.freq == null ? '?' : s.freq) + '＋繰越)=' + s.avail
             + ' → 月額残=' + mr + ' ／ チケット残=' + (s.ticketRem || 0) + ' ／ 合計=' + tt
             + (s._ok === false ? '  ⚠️ 割当器が「要確認」' : '');
    }
    blk.push(remLine('当月', nowKey, sp));
    blk.push(remLine('翌月', nextKey, spNext));
    if (dc && dc.count >= 1 && dc.avail != null) {
      blk.push('  上限の検算: 実際に効く頻度=' + dc.appliedFreq + '＋繰越で入りうる上限=' + dc.allowCarry
               + (dc.seed != null ? '（残数ログのseed=' + dc.seed + '）' : '')
               + ' = ' + dc.maxLegit + ' ／ いまの枠=' + dc.avail
               + (over ? '  🚨 枠が上限を超えています' : ''));
      if (dc.count >= 2) blk.push('  ⚠ 同時に有効な月額行が ' + dc.count + '行あります（古い行の終了日を入れてください）');
    }

    // 今月／翌月の予約（日時を並べる。25日以降は翌月が開くので分けて出す）
    if (sessions === null) {
      blk.push('  予約: ⚠️ 台帳が読めないため不明');
    } else {
      var curList = [], nextList = [], others = 0;
      for (var s2 = 0; s2 < sessions.length; s2++) {
        var mk2 = _lbMonthKeyJst(sessions[s2].startAt);
        var lab = Utilities.formatDate(new Date(sessions[s2].startAt), SETTINGS.TIMEZONE, 'MM/dd HH:mm')
                + (sessions[s2].packKind && sessions[s2].packKind !== 'normal' ? '(' + sessions[s2].packKind + ')' : '');
        if (mk2 === nowKey) curList.push(lab);
        else if (mk2 === nextKey) nextList.push(lab);
        else others++;
      }
      curList.sort(); nextList.sort();
      blk.push('  当月の予約 ' + curList.length + '件' + (curList.length ? '：' + curList.join('、') : ''));
      blk.push('  翌月の予約 ' + nextList.length + '件' + (nextList.length ? '：' + nextList.join('、') : ''));
      if (others) blk.push('  （他の月の計上 ' + others + '件）');
    }

    (flags.length ? review : fine).push(blk.join('\n'));
  }

  // ---- 冒頭の総括（ここが一番読まれる） ----
  var head = [];
  head.push('');
  head.push('── 調べた会員 ' + checked + '名 ／ 月額契約を持つ会員 ' + monthly + '名');
  head.push('── ⚠ 確認が要る会員 ' + review.length + '名'
            + (review.length ? '（上から ' + review.length + '名を見れば済みます）' : '（なし）'));
  head.push('     ・残数が算出できない ' + nUnknown + '名');
  head.push('     ・契約の入力に食い違いがある ' + nOdd + '名');
  head.push('     ・残数が0 ' + nZero + '名');
  head.push('     ・残数が頻度＋繰越上限を超えている（多すぎる） ' + nOver + '名');
  head.push('── ○ 問題なし ' + fine.length + '名');
  if (skipped.length) head.push('── 調べられなかった会員 ' + skipped.length + '名: ' + skipped.join(' / '));
  head.push('');
  head.push('並び順: 確認が要る会員が先、問題なしが後です。');
  for (var h = 0; h < head.length; h++) say(head[h]);

  if (!monthly) { say(''); say('（月額契約を持つ会員がいません）'); return out.join('\n'); }

  say('');
  say('========== ⚠ 確認が要る会員 ' + review.length + '名 ==========');
  if (!review.length) say('（なし）');
  for (var a1 = 0; a1 < review.length; a1++) say(review[a1]);

  say('');
  say('========== ○ 問題なし ' + fine.length + '名 ==========');
  if (!fine.length) say('（なし）');
  for (var b1 = 0; b1 < fine.length; b1++) say(fine[b1]);

  say('');
  say('===== ここまで。何も書き換えていません =====');
  return out.join('\n');
}

// ============================================================
// トレーナーの連続セッションの実測（2026-10-02）
//
// なぜ必要か：
//   オーナーは「同じトレーナーで3セッション連続したら、その後15分は受け付けない」
//   制限を入れたいと考えている。だが顧客が選べるトレーナーは実質2名（鈴木・沖）しかいない。
//   制限で空き枠を落としすぎると予約が取れず、売上に直接響く。
//   だから「3か2か」「隙間を何分とみなすか」を決める前に、いま実際にどうなっているかを測る。
//
//   ★ここは読み取りだけ。制限そのものは実装しない。カレンダーもシートも書き換えない。
//   ★氏名を出さない。予定のタイトルは顧客名を含むため、一切出力しない（時刻と長さだけ）。
//     トレーナー名は社内の人なので出す。
//   ★カレンダーの読み出しはトレーナー3名×1回＝3回に抑える（GASは6分で止まる）。
//
// 使い方（作業依頼）：{ op:'remaining', args:{ consec:true, days:30, gap:15 } }
// ============================================================

// ---- 純粋関数①：時刻の正規化（Date でもミリ秒でも受ける）----
//   vm をまたぐと instanceof Date が効かないため、getTime があるかで見る。
function _consecMs(v) {
  if (v == null) return NaN;
  if (typeof v === 'number') return v;
  if (typeof v.getTime === 'function') return v.getTime();
  return NaN;
}

// ---- 純粋関数②：重なりを畳んだ実働の分数 ----
function _consecBusyMinutes(items) {
  var a = [];
  for (var i = 0; i < (items || []).length; i++) a.push({ s: items[i].start, e: items[i].end });
  a.sort(function (x, y) { return x.s - y.s; });
  var total = 0, cs = null, ce = null;
  for (var j = 0; j < a.length; j++) {
    if (cs === null) { cs = a[j].s; ce = a[j].e; continue; }
    if (a[j].s <= ce) { if (a[j].e > ce) ce = a[j].e; }
    else { total += ce - cs; cs = a[j].s; ce = a[j].e; }
  }
  if (cs !== null) total += ce - cs;
  return total / 60000;
}

// ---- 純粋関数③：区間を「連続の塊」に畳む ----
//   隙間が gapMinutes 分**未満**なら同じ塊。ちょうど gapMinutes 空いていたら別の塊。
//   返す塊： { start, end, spanMinutes, busyMinutes, parts, items }
//     spanMinutes  … 開始〜終了の幅（間の隙間も含む）。「3時間連続」はこれで見る。
//     busyMinutes  … 実際に予定が入っている分数。隙間で span が膨らんでいないかの確認用。
//     parts        … 何セッション分か（まったく同じ時刻の重複は1件に数える）
function _consecRuns(intervals, gapMinutes) {
  var gapMs = (gapMinutes == null ? 15 : Number(gapMinutes)) * 60000;
  if (!(gapMs >= 0)) gapMs = 0;
  var list = [], seen = {};
  for (var i = 0; i < (intervals || []).length; i++) {
    var iv = intervals[i];
    if (!iv) continue;
    var s = _consecMs(iv.start), e = _consecMs(iv.end);
    if (!isFinite(s) || !isFinite(e) || e <= s) continue;     // 長さ0・逆順は捨てる
    var key = s + '/' + e;
    if (seen[key]) continue;                                   // 同じ時刻の重複は1件として扱う
    seen[key] = true;
    list.push({ start: s, end: e });
  }
  list.sort(function (a, b) { return (a.start - b.start) || (a.end - b.end); });
  var runs = [];
  for (var j = 0; j < list.length; j++) {
    var cur = runs.length ? runs[runs.length - 1] : null;
    var diff = cur ? (list[j].start - cur.end) : null;
    //   ★重なり・接するだけ（diff<=0）は隙間の指定が0でも常に同じ塊。
    //     diff < gapMs だけで書くと gap=0 のとき接するものが分かれる（2026-10-02 テストで検出）。
    if (cur && (diff <= 0 || diff < gapMs)) {
      cur.items.push(list[j]);
      if (list[j].end > cur.end) cur.end = list[j].end;
    } else {
      runs.push({ start: list[j].start, end: list[j].end, items: [list[j]] });
    }
  }
  for (var k = 0; k < runs.length; k++) {
    var r = runs[k];
    r.parts = r.items.length;
    r.spanMinutes = Math.round((r.end - r.start) / 60000);
    r.busyMinutes = Math.round(_consecBusyMinutes(r.items));
  }
  return runs;
}

// ---- 純粋関数④：この枠を入れたら塊が何分になるか ----
//   ★「直前が2連続か」だけを見てはいけない。既存の2連続の**前**に挟む枠・**間**に入る枠も
//     3連続を作る。だから枠を足してから畳み直し、その枠を含む塊を返す（前後どちらも見る）。
//   返り値は _consecRuns と同じ形の塊1つ。判定不能なら null。
function _consecWithSlot(runs, slotStart, slotEnd, gapMinutes) {
  var ss = _consecMs(slotStart), se = _consecMs(slotEnd);
  if (!isFinite(ss) || !isFinite(se) || se <= ss) return null;
  var ivs = [{ start: ss, end: se }];
  for (var i = 0; i < (runs || []).length; i++) {
    var r = runs[i];
    if (!r) continue;
    if (r.items && r.items.length) {
      for (var j = 0; j < r.items.length; j++) ivs.push({ start: r.items[j].start, end: r.items[j].end });
    } else {
      ivs.push({ start: _consecMs(r.start), end: _consecMs(r.end) });
    }
  }
  var merged = _consecRuns(ivs, gapMinutes);
  for (var m = 0; m < merged.length; m++) {
    if (merged[m].start <= ss && merged[m].end >= se) return merged[m];
  }
  return null;
}

// ---- 純粋関数⑤：塊の長さごとの分布を「60分 12件 ／ 120分 8件」の形にする ----
function _consecDist(runs) {
  var byLen = {};
  for (var i = 0; i < (runs || []).length; i++) {
    var L = runs[i].spanMinutes;
    byLen[L] = (byLen[L] || 0) + 1;
  }
  var keys = [];
  for (var k in byLen) keys.push(Number(k));
  keys.sort(function (a, b) { return a - b; });
  var parts = [];
  for (var q = 0; q < keys.length; q++) parts.push(keys[q] + '分 ' + byLen[keys[q]] + '件');
  return parts.length ? parts.join(' ／ ') : '（なし）';
}

// ---- 純粋関数⑥：塊の中に休憩が何件かぶっているか ----
//   ★ここが実測の読み方を左右する。「休憩」は _lbIsBusyTitle が埋まりと見なすため、
//     休憩をはさんだ前後のセッションが1つの塊に畳まれる。
//     トレーナーは実際に休んでいるので、その塊は「3時間連続で働いた」ではない。
//     予約エンジンが塞ぐ範囲としては正しい（だから主の数え方は変えない）が、
//     疲労の実態としては過大。だから件数を添えて、読み手が割り引けるようにする。
function _consecBreaksIn(run, breakIvs) {
  var n = 0;
  for (var i = 0; i < (breakIvs || []).length; i++) {
    var b = breakIvs[i];
    if (b.start < run.end && b.end > run.start) n++;
  }
  return n;
}

// ---- 表示用のこまごま（GASのAPIを使うのでここから下は純粋ではない）----
function _consecFmtDay(ms)  { return Utilities.formatDate(new Date(ms), SETTINGS.TIMEZONE, 'yyyy/MM/dd'); }
function _consecFmtTime(ms) { return Utilities.formatDate(new Date(ms), SETTINGS.TIMEZONE, 'HH:mm'); }
// 時間帯の帯（7-12 / 12-18 / 18-24）。JSTの時で見るため書式から取る。
function _consecBand(ms) {
  var h = Number(String(_consecFmtTime(ms)).slice(0, 2));
  if (h < 12) return '7-12時';
  if (h < 18) return '12-18時';
  return '18-24時';
}

// ============================================================
// 入口：トレーナーの連続セッションの実測
//   args = { consec:true, days:30, gap:15 }
// ============================================================
function consecutiveSessionsText(args) {
  args = args || {};
  var days = Number(args.days || 30); if (!(days > 0)) days = 30;
  var gap  = Number(args.gap  != null ? args.gap : 15); if (!(gap >= 0)) gap = 15;
  var COOL = 15;                       // クールダウンの分数（④で使う。制限は入れない）
  var LIMIT3 = 180, LIMIT2 = 120;      // 3連続／2連続のしきい値（分）

  var out = [];
  function say(s) { out.push(s); }
  function head(s) { say(''); say('■ ' + s); }

  say('===== トレーナーの連続セッションの実測 =====');
  say('版: ' + LB_AUDIT_BUILD);
  say('（読み取りだけ。制限は入れていません。何も書き換えません）');
  say('条件: 過去' + days + '日 ／ 隙間' + gap + '分未満を連続とみなす');
  say('数え方: 連続に数えるのは「実際のセッション」だけです。休憩・ブロックは区切りとして扱います');
  say('        （休憩を挟めば質は回復するため。塊に入れると休んでいる日の前後の枠まで落ちます）。');
  say('★予定のタイトルは顧客名を含むため出しません（時刻と長さだけ）。');

  var now = new Date(), nowMs = now.getTime();
  var pastStart = new Date(nowMs - days * 86400000);
  var horizon = _lbBookingHorizonEnd(now);

  // ---------------------------------------------------------
  // カレンダーの読み出し：トレーナー1名につき1回だけ（過去30日＋未来の地平をまとめて）
  // ---------------------------------------------------------
  var T = [];
  for (var t = 0; t < CALENDAR_IDS.TRAINERS.length; t++) {
    var tr = CALENDAR_IDS.TRAINERS[t];
    var rec = { id: tr.id, name: tr.name, hidden: !!tr.hidden,
                pastBusy: [], futureBusy: [], busyAll: [], shifts: [], breakByDay: {}, breaks: 0, err: '',
                pastRuns: [], futureRuns: [], breakIvs: [] };   // ★先に空で置く。カレンダーが開けない経路でも後段が落ちない
    //   pastBusy/futureBusy＝実際のセッションだけ（連続を数える）
    //   busyAll＝休憩・ブロックも含む埋まり全部（席が塞がる範囲。空きブロックの計算に使う）
    try {
      var cal = CalendarApp.getCalendarById(tr.email);
      if (!cal) { rec.err = 'カレンダーが開けません'; T.push(rec); continue; }
      var evs = cal.getEvents(pastStart, horizon);     // ★ここが1回。合計3回。
      for (var j = 0; j < evs.length; j++) {
        var ev = evs[j], title = ev.getTitle();
        var s = ev.getStartTime(), e = ev.getEndTime();
        // ★判定はシフトを先に見る（出勤シフトは埋まりではない）。
        if (isShiftEvent(title)) { rec.shifts.push({ start: s, end: e }); continue; }
        if (!_lbIsBusyTitle(title)) continue;           // 埋まりの判定は コード.js の1か所から呼ぶ
        // 「休憩」がシフトに入っているかの実測（②）。埋まりの判定とは別の目的なので別に数える。
        if (String(title).indexOf('休憩') >= 0) {
          var dk = _consecFmtDay(s.getTime());
          rec.breakByDay[dk] = (rec.breakByDay[dk] || 0) + 1;
          rec.breaks++;
          rec.breakIvs.push({ start: s.getTime(), end: e.getTime() });
        }
        // ★連続の塊に数えるのは「実際のセッション」だけ（2026-10-02）。
        //   休憩やブロックも埋まりなので席は塞ぐが、トレーナーは施術していない。
        //   これを塊に入れると「セッション→休憩60分→セッション」が180分の連続に見え、
        //   休んでいる日の前後の枠まで制限で落ちてしまう。休憩は区切りとして扱う。
        //   空きブロック（②）の計算には埋まり全部を使う（席は実際に塞がるため）。
        rec.busyAll.push({ start: s, end: e });
        if (!_lbIsSessionTitle(title)) continue;
        (s.getTime() < nowMs ? rec.pastBusy : rec.futureBusy).push({ start: s, end: e });
      }
    } catch (eT) { rec.err = String((eT && eT.message) || eT).slice(0, 120); }
    rec.pastRuns   = _consecRuns(rec.pastBusy, gap);
    rec.futureRuns = _consecRuns(rec.futureBusy, gap);
    T.push(rec);
  }

  // ---------------------------------------------------------
  // ① 過去に実際あった「連続の塊」
  // ---------------------------------------------------------
  var long3 = [], long4 = 0;
  for (var a = 0; a < T.length; a++) {
    for (var b = 0; b < T[a].pastRuns.length; b++) {
      var r = T[a].pastRuns[b];
      if (r.spanMinutes >= LIMIT3) {
        long3.push({ name: T[a].name, run: r, brk: _consecBreaksIn(r, T[a].breakIvs) });
        if (r.spanMinutes >= 240) long4++;
      }
    }
  }
  long3.sort(function (x, y) { return x.run.start - y.run.start; });

  // ---------------------------------------------------------
  // ③ 未来の空き枠が、制限でどれだけ落ちるか（★一番重要）
  // ---------------------------------------------------------
  var slots = [], slotErr = '';
  try { slots = buildAvailableSlots() || []; }        // ★重い。1回だけ呼ぶ。
  catch (eS) { slotErr = String((eS && eS.message) || eS).slice(0, 120); }

  var byId = {};
  for (var c = 0; c < T.length; c++) byId[T[c].id] = T[c];

  var tot = 0, drop3 = 0, drop2 = 0, cool = 0, coolExtra = 0;
  var drop3ByTrainer = {}, drop2ByTrainer = {}, drop3ByBand = {}, unknownTrainer = 0;
  for (var d = 0; d < slots.length; d++) {
    var sl = slots[d];
    var rec2 = byId[String(sl.trainerId)];
    if (!rec2) { unknownTrainer++; continue; }
    var ss = new Date(sl.startISO).getTime(), se = new Date(sl.endISO).getTime();
    if (!isFinite(ss) || !isFinite(se)) { unknownTrainer++; continue; }
    tot++;
    var merged = _consecWithSlot(rec2.futureRuns, ss, se, gap);
    var span = merged ? merged.spanMinutes : Math.round((se - ss) / 60000);
    var d3 = span > LIMIT3, d2 = span > LIMIT2;
    if (d3) {
      drop3++;
      drop3ByTrainer[rec2.name] = (drop3ByTrainer[rec2.name] || 0) + 1;
      var bd = _consecBand(ss);
      drop3ByBand[bd] = (drop3ByBand[bd] || 0) + 1;
    }
    if (d2) { drop2++; drop2ByTrainer[rec2.name] = (drop2ByTrainer[rec2.name] || 0) + 1; }
    // ④ 既存の「3連続以上の塊」の直後COOL分に入る枠
    var inCool = false;
    for (var f = 0; f < rec2.futureRuns.length; f++) {
      var fr = rec2.futureRuns[f];
      if (fr.spanMinutes < LIMIT3) continue;
      if (ss >= fr.end && ss < fr.end + COOL * 60000) { inCool = true; break; }
    }
    if (inCool) { cool++; if (!d3) coolExtra++; }
  }
  function pct(n) { return tot ? (Math.round(n * 1000 / tot) / 10) + '%' : '—'; }
  function byTrainerText(m) {
    var ps = [];
    for (var g = 0; g < T.length; g++) if (m[T[g].name] != null) ps.push(T[g].name + '：' + m[T[g].name] + '枠');
    return ps.length ? ps.join(' ／ ') : '（なし）';
  }

  // ---------------------------------------------------------
  // 結論（ここが一番読まれる）
  // ---------------------------------------------------------
  say('');
  say('────── 結論 ──────');
  var long3brk = 0;
  for (var a2 = 0; a2 < long3.length; a2++) if (long3[a2].brk) long3brk++;
  say('① 過去' + days + '日で ' + LIMIT3 + '分以上の連続の塊は 合計 ' + long3.length + '件'
      + (long4 ? '（うち240分以上 ' + long4 + '件）' : '（240分以上は なし）'));
  if (slotErr) say('③ 空き枠を取得できませんでした：' + slotErr);
  else {
    say('③ いまの空き枠 ' + tot + '枠 ／ ' + LIMIT3 + '分制限で落ちるのは ' + drop3 + '枠（' + pct(drop3) + '）');
    say('   ' + LIMIT2 + '分制限にした場合は ' + drop2 + '枠（' + pct(drop2) + '）が落ちます');
    say('④ クールダウン' + COOL + '分で追加で落ちる枠は ' + coolExtra + '枠'
        + '（' + LIMIT3 + '分制限が既に落とす分と重なるのが ' + (cool - coolExtra) + '枠）');
  }
  say('★顧客が選べるトレーナーは2名（' + (function () {
    var v = []; for (var h2 = 0; h2 < T.length; h2++) if (!T[h2].hidden) v.push(T[h2].name);
    return v.join('・') || '—';
  })() + '）。中野（顧客には非表示）は実測には含め、③の空き枠の数え上げにも現れます。');

  // ---------------------------------------------------------
  // 内訳
  // ---------------------------------------------------------
  head('① 連続の塊の長さ（過去' + days + '日・隙間' + gap + '分未満を連続とみなす）');
  for (var i1 = 0; i1 < T.length; i1++) {
    if (T[i1].err) { say('  ' + T[i1].name + '：❌ ' + T[i1].err); continue; }
    say('  ' + T[i1].name + (T[i1].hidden ? '（顧客非表示）' : '') + '：' + _consecDist(T[i1].pastRuns));
  }
  say('  ▶ ' + LIMIT3 + '分以上の塊は 合計 ' + long3.length + '件'
      + (long4 ? '（うち240分以上 ' + long4 + '件）' : ''));
  if (long3.length) {
    say('');
    say('  ── ' + LIMIT3 + '分以上の塊の明細（本当にあったかを確認できるように）──');
    var cap = 40;
    for (var i2 = 0; i2 < long3.length && i2 < cap; i2++) {
      var L = long3[i2];
      say('   ' + _consecFmtDay(L.run.start) + ' ' + L.name
          + ' ' + _consecFmtTime(L.run.start) + '〜' + _consecFmtTime(L.run.end)
          + ' ' + L.run.spanMinutes + '分（' + L.run.parts + 'セッション分'
          + (L.run.busyMinutes !== L.run.spanMinutes ? '／実働' + L.run.busyMinutes + '分' : '')
          + '）');
    }
    if (long3.length > cap) say('   …ほか ' + (long3.length - cap) + '件（長いので省略）');
  }

  head('② 3時間連続が成立しうる帯（出勤シフト − 埋まり ＝ 空きブロックのうち' + LIMIT3 + '分以上）');
  say('  ※施設（B1）の埋まりは引いていません＝「最大でここまで」の上限値です（読み出しを3回に抑えるため）。');
  var wide = 0, wideLines = [];
  for (var i3 = 0; i3 < T.length; i3++) {
    var rec3 = T[i3];
    if (rec3.err) continue;
    // 空きブロックは「席が実際に塞がる範囲」を引く＝休憩・ブロックも含む
    var busyAll = rec3.busyAll;
    for (var s3 = 0; s3 < rec3.shifts.length; s3++) {
      var free = _lbSubtractIntervals(rec3.shifts[s3], busyAll);   // コード.js の共通ヘルパーを使う
      for (var f3 = 0; f3 < free.length; f3++) {
        var mins = Math.round((free[f3].end.getTime() - free[f3].start.getTime()) / 60000);
        if (mins < LIMIT3) continue;
        wide++;
        wideLines.push({ ms: free[f3].start.getTime(),
          line: '   ' + _consecFmtDay(free[f3].start.getTime()) + ' ' + rec3.name
                + ' ' + _consecFmtTime(free[f3].start.getTime()) + '〜' + _consecFmtTime(free[f3].end.getTime())
                + ' ' + mins + '分' + (free[f3].start.getTime() < nowMs ? '（過去）' : '（今後）') });
      }
    }
  }
  wideLines.sort(function (x, y) { return x.ms - y.ms; });
  say('  ' + LIMIT3 + '分以上の空きブロック 合計 ' + wide + '件');
  var cap2 = 40;
  for (var i4 = 0; i4 < wideLines.length && i4 < cap2; i4++) say(wideLines[i4].line);
  if (wideLines.length > cap2) say('   …ほか ' + (wideLines.length - cap2) + '件（長いので省略）');

  say('');
  say('  ── 「休憩」を含む予定の件数（シフトに休憩が入っているかの実測）──');
  for (var i5 = 0; i5 < T.length; i5++) {
    var rec5 = T[i5];
    if (rec5.err) continue;
    var dkeys = [];
    for (var dk5 in rec5.breakByDay) dkeys.push(dk5);
    dkeys.sort();
    say('  ' + rec5.name + '：合計 ' + rec5.breaks + '件 ／ 休憩のある日 ' + dkeys.length + '日');
    var cap3 = 20;
    for (var i6 = 0; i6 < dkeys.length && i6 < cap3; i6++) say('   ' + dkeys[i6] + ' ' + rec5.breakByDay[dkeys[i6]] + '件');
    if (dkeys.length > cap3) say('   …ほか ' + (dkeys.length - cap3) + '日');
  }

  head(Math.round(LIMIT3 / 60) + '連続（' + LIMIT3 + '分）制限を入れた場合の影響（未来の空き枠）');
  if (slotErr) say('  ❌ 空き枠を取得できませんでした：' + slotErr);
  else {
    say('  いまの空き枠 ' + tot + '枠');
    say('  落ちる枠     ' + drop3 + '枠（' + pct(drop3) + '）');
    say('    ' + byTrainerText(drop3ByTrainer));
    say('  落ちる枠の時間帯の偏り：'
        + '7-12時 ' + (drop3ByBand['7-12時'] || 0) + '枠 ／ '
        + '12-18時 ' + (drop3ByBand['12-18時'] || 0) + '枠 ／ '
        + '18-24時 ' + (drop3ByBand['18-24時'] || 0) + '枠');
    say('  ▶ ' + Math.round(LIMIT2 / 60) + '連続（' + LIMIT2 + '分）制限にした場合は '
        + drop2 + '枠（' + pct(drop2) + '）が落ちます');
    say('    ' + byTrainerText(drop2ByTrainer));
    if (unknownTrainer) say('  （トレーナーを特定できなかった枠 ' + unknownTrainer + '枠は数えていません）');
    say('  ※各枠は「その枠だけが埋まったら」で判定しています。同じトレーナーの枠は互いに代替なので、');
    say('    実際に同時に埋まることはありません。落ちる枠の数は「候補から消える枠」の数です。');

    head('④ クールダウン' + COOL + '分の影響');
    say('  既存の' + LIMIT3 + '分以上の塊の直後' + COOL + '分に入る枠 ' + cool + '枠');
    say('  うち' + LIMIT3 + '分制限で既に落ちる枠 ' + (cool - coolExtra) + '枠 ／ 追加で落ちる枠 ' + coolExtra + '枠');
    if (COOL <= gap) {
      say('  ※クールダウン' + COOL + '分 ≦ 連続とみなす隙間' + gap + '分 のため、直後' + COOL + '分の枠は');
      say('    そもそも同じ塊に畳まれて' + LIMIT3 + '分制限で落ちます。この設定ではクールダウンは追加の効果をほぼ持ちません。');
    }
  }

  // ---------------------------------------------------------
  // この数字をどう読むか
  // ---------------------------------------------------------
  say('');
  say('────── この数字をどう読むか ──────');
  if (slotErr) {
    say('  空き枠が取得できていないため、制限の影響は判断できません。再実行が必要です。');
  } else if (!tot) {
    say('  空き枠が0枠です。制限の影響を測る前に、出勤シフトが入っているかを確認してください。');
  } else {
    var r3 = drop3 * 100 / tot;
    if (!long3.length) {
      say('  過去' + days + '日に' + LIMIT3 + '分以上の連続は実際には起きていません。'
          + LIMIT3 + '分制限は「いま起きている問題」への対処ではありません。');
    } else {
      say('  過去' + days + '日に' + LIMIT3 + '分以上の連続が ' + long3.length + '件 実際に起きています。');
    }
    if (r3 < 5) say('  ' + LIMIT3 + '分制限で落ちる枠は ' + pct(drop3) + '＝5%未満。空き枠への影響は小さいと言えます。');
    else if (r3 < 15) say('  ' + LIMIT3 + '分制限で落ちる枠は ' + pct(drop3) + '。影響は限定的ですが、時間帯の偏りを見てください。');
    else say('  ' + LIMIT3 + '分制限で落ちる枠は ' + pct(drop3) + '＝1割超。顧客が選べるのは2名しかいないため、予約の取りにくさに直結します。');
    say('  ' + LIMIT2 + '分制限は ' + pct(drop2) + ' を落とします（' + LIMIT3 + '分制限の '
        + (drop3 ? (Math.round(drop2 * 10 / drop3) / 10) + '倍' : '—') + '）。');
  }
  say('');
  say('===== ここまで。何も書き換えていません =====');
  return out.join('\n');
}

// GASエディタから直接見るとき
function consecutiveSessions() { _lbAuditLogChunks(consecutiveSessionsText({ consec: true }), 7000); }

// ============================================================
// 月額会員の「今月の枠」を1行1人で一覧する（2026-10-03 オーナー要望）
//
//   目的：トレーナーに共有して、繰越が正しいかを目で確かめてもらう。
//   既存の monthlyMembersRemainingNamed は1人ずつ詳しく出すので、
//   38名ぶんだと長すぎて一覧できない。こちらは**1行1人**の表にする。
//
//   ★「予約を含めない回数」＝**枠（頻度＋繰越）**。
//     残数（予約を引いた後）とは別物。繰越の確認には枠を見る。
//     両方を並べて出すので、どちらを見ているかを取り違えない。
//
//   ★GASエディタ専用（氏名を出すため）。作業依頼の結果URLには出さない。
//   ★読み取りだけ。何も書き換えない。
// ============================================================
function monthlyQuotaTable() {
  Logger.log(_monthlyQuotaTableText());
}

function _monthlyQuotaTableText(nowMs) {
  var out = [];
  function say(s) { out.push(s); }

  var ms = (nowMs != null) ? nowMs : new Date().getTime();
  var now = new Date(ms);
  var nowKey = _lbMonthKeyJst(ms);
  var nextMs = new Date(now.getFullYear(), now.getMonth() + 1, 1, 12, 0, 0).getTime();
  var nextKey = _lbMonthKeyJst(nextMs);

  say('===== 月額会員の今月の枠（1行1人・氏名つき・読み取りだけ）'
      + Utilities.formatDate(now, SETTINGS.TIMEZONE, 'yyyy/MM/dd HH:mm') + ' =====');
  say('版: ' + LB_AUDIT_BUILD);
  say('★この出力には個人情報が含まれます。外部へ貼らないでください。');
  say('');
  say('【見方】');
  say('  枠   … 今月使える回数。**予約を引く前**（頻度＋繰越）。繰越の確認はここを見る');
  say('  頻度 … 契約の月あたりの回数');
  say('  繰越 … 先月から持ち越した回数（枠 − 頻度）');
  say('  予約 … 今月すでに入っている予約の数');
  say('  残り … 枠 − 予約。お客様の画面に出る数字');
  say('');

  try { CacheService.getScriptCache().remove('lb_contract_all'); } catch (eC) {}

  var map = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (!map || map.getLastRow() < 2) { say('⛔ 会員名簿が読めません。'); return out.join('\n'); }
  var vals = map.getRange(2, 1, map.getLastRow() - 1, _auditMapWidth(map)).getValues();

  // 予約台帳は1回だけ読む（会員ごとに読み直すと6分の制限を使い切る）
  var rvals = null, rvalsOk = false;
  try {
    var rsh = _lbSheet(LINE_BOOKING.RESV_SHEET);
    if (rsh) {
      var lastR = rsh.getLastRow();
      rvals = (lastR < 2) ? [] : rsh.getRange(2, 1, lastR - 1, Math.max(12, rsh.getLastColumn())).getValues();
      rvalsOk = true;
    }
  } catch (eR) { rvalsOk = false; }
  if (!rvalsOk) say('⚠️ 予約台帳が読めません。予約数と残りは出せません。');

  var rate = (typeof LINE_BOOKING !== 'undefined' && LINE_BOOKING.CARRYOVER_RATE != null)
             ? LINE_BOOKING.CARRYOVER_RATE : (1 / 3);

  var rowsOut = [], checkOut = [], skipped = [];
  var checked = 0;

  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][MAP_COL.AUTH_STATE - 1]) !== 'verified') continue;
    var nm = String(vals[i][MAP_COL.NAME - 1] || ''); if (!nm) continue;
    var cid = String(vals[i][MAP_COL.CUSTOMER_ID - 1] || ''); if (!cid) continue;
    var stat = String(vals[i][MAP_COL.CONTRACT_STAT - 1] || '');
    checked++;

    var rows, sessions, opening;
    try {
      rows = _lbContractRowsAll(nm, _lbPhoneByCustomerId(cid), false, cid);
      if (!rows || !rows.length) { skipped.push(nm + '（契約なし）'); continue; }
      sessions = rvalsOk ? _lbResvValsToSessions(rvals, cid, _lbParseResvDate) : null;
      opening = _lbMemberOpeningWithFloor(cid);
    } catch (e) { skipped.push(nm + '（' + e.message + '）'); continue; }

    var sp = null, spNext = null;
    try { sp = _lbSplitRemaining(rows, cid, ms, sessions); } catch (e2) { sp = null; }
    try { spNext = _lbSplitRemaining(rows, cid, nextMs, sessions); } catch (e3) { spNext = null; }

    // 月額契約を持たない方（チケットのみ）は対象外
    if (!sp || !sp.hasMonthly) { continue; }

    // 今月／翌月の予約数
    var curN = 0, nextN = 0;
    if (sessions) {
      for (var s2 = 0; s2 < sessions.length; s2++) {
        var mk = _lbMonthKeyJst(sessions[s2].startAt);
        if (mk === nowKey) curN++;
        else if (mk === nextKey) nextN++;
      }
    }

    var freq = (sp.freq == null) ? null : Number(sp.freq);
    var avail = (sp.avail == null) ? null : Number(sp.avail);
    var carry = (freq != null && avail != null) ? (avail - freq) : null;
    var rem = (sp.monthlyRem == null) ? null : Number(sp.monthlyRem);
    var availNext = (spNext && spNext.avail != null) ? Number(spNext.avail) : null;

    // 要確認の印（人が決めるべきものだけ）
    var flags = [];
    if (rem == null) flags.push('残数が出ない');
    if (stat !== 'active') flags.push('契約が' + (stat || '空'));
    if (carry != null && carry < 0) flags.push('繰越がマイナス');
    // ★予約台帳が読めないときは、この検査をしない。
    //   予約数が0として扱われるので、全員が「合わない」になって一覧が埋まる。
    //   「分からない」を「問題あり」に化けさせない。
    if (rvalsOk && avail != null && rem != null && curN !== (avail - rem)) {
      flags.push('枠と残りが合わない');
    }
    try {
      var odd = _contractOddities(rows);
      if (odd.length) flags.push('契約の入力に食い違い');
    } catch (eO) {}

    // 台帳が読めないときは予約数と残りを「-」にする。0件と「分からない」を同じ見た目にしない。
    var curShow = rvalsOk ? curN : null;

    var nextShow = rvalsOk ? nextN : null;
    // ★枠を超えて予約が入っていないか（2026-10-03・オーナーの指摘から）。
    //   会員#2412 で、10月の枠8回に対して10件の予約が入っていた。
    //   残数の計算は正しく0回を出していたが、**予約の受付が通りすぎていた。**
    //   オーナーが気づいたのは偶然で、気づかなければそのままだった。
    //   超過は顧客との金銭の話になるので、毎日の確認で自然に目に入るようにする。
    //   ★原因が何であれ、ここで気づける。原因を1つ塞いでも、別の経路でまた起こりうる。
    if (rvalsOk && avail != null && curShow != null && curShow > avail) {
      flags.push('今月が' + (curShow - avail) + '件超過');
    }
    if (availNext != null && nextShow != null && nextShow > availNext) {
      flags.push('翌月が' + (nextShow - availNext) + '件超過');
    }
    var line = _mqPad(nm, 8) + _mqNum(freq, 5) + _mqNum(carry, 5)
             + _mqNum(avail, 5) + _mqNum(curShow, 5) + _mqNum(rem, 5)
             + '  ' + _mqNum(availNext, 5) + _mqNum(nextShow, 5)
             + (flags.length ? '   ⚠ ' + flags.join('・') : '');
    if (flags.length) checkOut.push(line); else rowsOut.push(line);
  }

  // 見出しも同じ幅で並べる（数字は右そろえ）
  var head = _mqPad('氏名', 8) + _mqNum('頻度', 5) + _mqNum('繰越', 5)
           + _mqNum('枠', 5) + _mqNum('予約', 5) + _mqNum('残り', 5)
           + '  ' + _mqNum('翌枠', 5) + _mqNum('翌約', 5);

  say('── 調べた会員 ' + checked + '名 ／ 月額契約あり ' + (rowsOut.length + checkOut.length) + '名');
  say('');
  if (checkOut.length) {
    say('■ ⚠ 確認が要る ' + checkOut.length + '名');
    say('  ' + head);
    say('  ' + _mqRule(head.length));
    for (var c = 0; c < checkOut.length; c++) say('  ' + checkOut[c]);
    say('');
  }
  say('■ ○ 問題なし ' + rowsOut.length + '名');
  say('  ' + head);
  say('  ' + _mqRule(head.length));
  for (var r2 = 0; r2 < rowsOut.length; r2++) say('  ' + rowsOut[r2]);

  if (skipped.length) { say(''); say('■ 調べられなかった会員: ' + skipped.join(' / ')); }
  say('');
  say('※ 「枠」が繰越を含んだ今月の回数です。お客様の画面には「残り」が出ます。');
  say('※ 翌枠・翌約は翌月（' + nextKey + '）の枠と予約数。25日以降は翌月の予約が開きます。');
  say('');
  say('===== ここまで。何も書き換えていません =====');
  return out.join('\n');
}

// 表をそろえるための小道具（全角は2文字ぶんとして数える）
function _mqWidth(s) {
  var n = 0, t = String(s == null ? '' : s);
  for (var i = 0; i < t.length; i++) n += (t.charCodeAt(i) > 0x7f) ? 2 : 1;
  return n;
}
// 左そろえ。w は「全角の文字数」（全角1文字＝半角2つぶん）。
function _mqPad(s, w) {
  var t = String(s == null ? '' : s), need = w * 2 - _mqWidth(t);
  return t + (need > 0 ? new Array(need + 1).join(' ') : '');
}
// 右そろえ。全角の見出し（頻度・繰越など）も数字と同じ幅にそろえる。
function _mqNum(v, w) {
  var t = (v == null) ? '-' : String(v);
  var pad = w * 2 - _mqWidth(t);
  return (pad > 0 ? new Array(pad + 1).join(' ') : '') + t;
}
function _mqRule(n) { return new Array(Math.max(n, 10) + 1).join('─'); }
