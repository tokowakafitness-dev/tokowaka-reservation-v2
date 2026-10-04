// ============================================================
// LINE予約システム — Phase 1（会員登録基盤・ID Token検証・トレーナー認証）
// アカウント: tokowaka.fitness@gmail.com ／ 既存 pt-gas と同一スクリプトに相乗り
// 設計: line-booking/DESIGN.md・TECH_SPEC.md
// セキュリティ不変条件: decisions/0032（fail-closed 等）・0033（案B認証・構成）
// ------------------------------------------------------------
// ★機密の値はこのファイルに書かない。すべて Script Properties から名前で参照する:
//   LINE_CHANNEL_ID / LINE_CHANNEL_SECRET / LINE_MESSAGING_TOKEN /
//   LINE_ADMIN_TOKEN / LINE_WEBHOOK_TOKEN / LINE_CODE_SALT / STAGING_SPREADSHEET_ID
// ============================================================

var LINE_BOOKING = {
  MAP_SHEET:     'customer_line_map',   // 会員紐付け（制限付きSS）
  BALANCE_SHEET: 'line_balance',        // 月次残数（Phase 2）
  RESV_SHEET:    'line_reservations',   // line予約（Phase 2・既存reservationsは汚さない）
  TRAINER_SHEET: 'trainer_master',      // トレーナー認証（案B・line_user_id/role）
  CONTRACT_SS_ID: '1ch84msnulH7HX5DZ82yd0nRl5Hm95Ho72J39WCNfVkc',  // 契約フォーム回答（請求ブック）。列はヘッダ名で特定＝並べ替え可
  CARRYOVER_RATE: 1 / 3,   // 繰越率fallback（テーブル外の頻度のみ使用）。上限の本則は Allocate.js の LB_CARRY_CAP_TABLE（頻度→回数）＋契約「繰越上限」列override
  VERIFY_URL:    'https://api.line.me/oauth2/v2.1/verify',
  CODE_DIGITS:   6,
  CODE_TTL_MIN:  10,     // 認証番号の有効期限（分）
  CODE_MAX_TRIES: 5,     // lineUserId単位の照合試行上限（レート制限窓内）
  TRY_WINDOW_SEC: 600    // 試行カウントの窓（秒）＝10分
};

// customer_line_map 列（1始まり）
var MAP_COL = {
  LINE_USER_ID: 1, // A
  CUSTOMER_ID:  2, // B
  NAME:         3, // C
  PHONE:        4, // D
  TRAINER_ID:   5, // E
  CONTRACT_TYPE:6, // F
  CONTRACT_STAT:7, // G  active/suspended/expired
  AUTH_STATE:   8, // H  pending/verified/rejected
  LINKED_AT:    9, // I
  CODE_HASH:   10, // J  ワンタイム番号のhash（平文保存しない）
  CODE_EXPIRE: 11, // K  番号有効期限
  TRY_COUNT:   12, // L  照合試行回数（監査用）
  NOTE:        13, // M
  EMAIL:       14, // N  会員登録の基本情報（PII・制限付きSSのみ）
  BIRTHDAY:    15, // O  生年月日
  GOAL:        16, // P  トレーニングの目標・ご要望
  LANG:        17  // Q  表示/通知言語（'ja'|'en'・空欄はja）
};

// trainer_master 列（1始まり）
var TR_COL = { LINE_USER_ID:1, TRAINER_ID:2, NAME:3, ROLE:4, ACTIVE:5, NAME_EN:6 };   // F=英語名（空欄なら日本語名で表示）

// ============================================================
// 小道具
// ============================================================
function _lbProp(key) { return PropertiesService.getScriptProperties().getProperty(key); }

function _lbJson(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// 書き込み先SS（staging対応）。STAGING_SPREADSHEET_ID があればそちら＝本番SSを汚さない（憲法第13節）。
// ※本番デプロイ環境では STAGING_SPREADSHEET_ID を設定しないこと。将来デプロイID判定に置換予定。
function _lbIsStaging() { return !!_lbProp('STAGING_SPREADSHEET_ID'); }   // staging判定（本番はこのプロパティを設定しない）
function _lbSs() {
  var id = _lbProp('STAGING_SPREADSHEET_ID') || SETTINGS.SPREADSHEET_ID;
  return SpreadsheetApp.openById(id);
}

// 会員名簿を読む幅。
//   ★照合状態（8列目）までは必ず読む。
//     氏名（3列目）までしか読まずに照合状態を参照していたため、
//     undefined が 'verified' と一致せず **静かに全員が除外される**事故が
//     2026-09-29（残数の突合）と 2026-10-01（棚卸し）で2日続けて起きた。
//     例外も出ず件数が0になるだけなので気づきにくい。幅は1箇所で決める。
function _lbMapWidth(sh) {
  // getLastColumn を持たない相手（検証用の身代わり等）でも落とさない。
  var last = 0;
  try { if (sh && typeof sh.getLastColumn === 'function') last = sh.getLastColumn(); } catch (e) {}
  return Math.max(MAP_COL.NOTE || 14, MAP_COL.AUTH_STATE, last);
}

function _lbSheet(name) {
  var ss = _lbSs();
  return ss.getSheetByName(name);
}

// SHA-256 hex。認証番号は平文保存しない（decisions/0032 不変条件④）。
function _lbHashCode(code) {
  var salt = _lbProp('LINE_CODE_SALT') || '';
  var raw  = String(code) + ':' + salt;
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw, Utilities.Charset.UTF_8);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = (bytes[i] & 0xff).toString(16);
    hex += (b.length === 1 ? '0' : '') + b;
  }
  return hex;
}

// 一定長のランダム数字コード
function _lbRandomCode(digits) {
  var s = '';
  for (var i = 0; i < digits; i++) { s += Math.floor(Math.random() * 10); }
  return s;
}

// ============================================================
// ① ID Token検証（fail-closed・decisions/0032 不変条件①）
//    失敗・未設定・異常応答・例外のいずれでも必ず拒否する。
//    既存 verifyRecaptcha の fail-open（可用性優先で許可）を絶対に真似ない。
// ============================================================
function verifyLineIdToken(idToken) {
  var channelId = _lbProp('LINE_CHANNEL_ID');
  if (!channelId) { Logger.log('verifyLineIdToken: LINE_CHANNEL_ID未設定 → 拒否(fail-closed)'); return { ok:false, code:'UNAUTHORIZED' }; }
  if (!idToken)   { return { ok:false, code:'UNAUTHORIZED' }; }
  // 検証済み結果を5分だけ再利用（api.line.me往復を省き体感短縮・decisions/0032補遺）。
  // 初回は必ず下でfail-closed検証。キャッシュは"検証済みlineUserIdの再利用"で認証を緩めない。
  var _cache = CacheService.getScriptCache();
  var _ckey = 'idtok_' + _lbHashCode(idToken).substring(0, 40);
  var _hit = _cache.get(_ckey);
  if (_hit) { return { ok:true, lineUserId: _hit }; }
  try {
    var res = UrlFetchApp.fetch(LINE_BOOKING.VERIFY_URL, {
      method: 'post',
      payload: { id_token: idToken, client_id: channelId },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) { return { ok:false, code:'UNAUTHORIZED' }; }
    var data = JSON.parse(res.getContentText());
    // aud一致（他LIFFアプリのトークンによる成りすまし防止）
    if (String(data.aud) !== String(channelId)) { return { ok:false, code:'UNAUTHORIZED' }; }
    // exp検証（LINE側も検証済だが多層で）
    if (data.exp && (Number(data.exp) * 1000) < new Date().getTime()) { return { ok:false, code:'UNAUTHORIZED' }; }
    if (!data.sub) { return { ok:false, code:'UNAUTHORIZED' }; }
    _cache.put(_ckey, String(data.sub), 300); // 検証成功を5分キャッシュ
    return { ok:true, lineUserId: String(data.sub), name: data.name || '' };
  } catch (err) {
    Logger.log('verifyLineIdToken 例外 → 拒否(fail-closed): ' + err.message);
    return { ok:false, code:'UNAUTHORIZED' };
  }
}

// ============================================================
// doPost — line系の唯一の入口
//   ・Webhook（LINE Platform→GAS）と LIFF API（クライアント→GAS）を分離
//   ・LIFF API は全action入口で verifyLineIdToken を通し lineUserId を確定
//   ・body の lineUserId / customer_id は一切信用しない（decisions/0032 不変条件②）
// ============================================================
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) return _lbJson({ success:false, code:'BAD_REQUEST' });

    // Webhook判定：URLクエリ ?type=webhook で明示（GASはヘッダ非取得のため署名の代わりにwhTokenで検証）
    var p = (e.parameter) || {};
    if (p.type === 'webhook') { return handleLineWebhook(e); }

    var body = JSON.parse(e.postData.contents);
    var action = body.action || '';

    // 管理系（ADMIN_TOKEN必須）— ID Tokenではなく管理トークンで守る（不変条件③）
    if (action === 'issueVerifyCode') {
      if (!_lbRequireAdmin(body.adminToken)) return _lbJson({ success:false, code:'UNAUTHORIZED' });
      return _lbJson(issueVerifyCode(body));
    }

    // ここから先は全て会員LIFF系 → ID Token検証を最初に通す
    var auth = verifyLineIdToken(body.idToken);
    if (!auth.ok) return _lbJson({ success:false, code:'UNAUTHORIZED' });
    var lineUserId = auth.lineUserId;   // ★以降これだけを信用する

    switch (action) {
      case 'verifyMembership':   return _lbJson(verifyMembership(lineUserId, body.code));
      case 'getMemberStatus':    return _lbJson(getMemberStatus(lineUserId));
      case 'getTrainers':        return _lbJson(getTrainers());
      case 'getTrainerSlots':    return _lbJson(getTrainerSlots(body));
      case 'makeReservationLine':return _lbJson(makeReservationLine(lineUserId, body));
      case 'makeReservationLineProxy': {
        var tr = requireTrainer(lineUserId);           // 案B：トレーナー権限を確認
        if (!tr) return _lbJson({ success: false, code: 'FORBIDDEN' });
        return _lbJson(makeReservationLineProxy(tr, body));
      }
      // Phase 4以降: getMyReservations/cancelReservation/changeReservation/confirmAttendance
      default: return _lbJson({ success:false, code:'UNKNOWN_ACTION' });
    }
  } catch (err) {
    Logger.log('doPost エラー: ' + err.message);
    return _lbJson({ success:false, code:'SERVER_ERROR' });
  }
}

// ============================================================
// liffApi — LIFF（HtmlService sandbox）から google.script.run で呼ぶ窓口
//   ★HtmlServiceのサンドボックスからは fetch がCORSで通らないため、
//     クライアントは fetch ではなく google.script.run.liffApi(...) を使う。
//   doPost と同じく、入口で必ず verifyLineIdToken を通し lineUserId を確定する。
//   引数/戻り値は JSON文字列（google.script.run は構造体をそのまま返せるが、
//   互換のため文字列で統一）。
// ============================================================
function liffApi(payloadJson) {
  try {
    var body = JSON.parse(payloadJson || '{}');
    var action = body.action || '';
    var auth = verifyLineIdToken(body.idToken);
    if (!auth.ok) return JSON.stringify({ success: false, code: 'UNAUTHORIZED' });
    var lineUserId = auth.lineUserId;
    var res;
    switch (action) {
      case 'getMemberStatus':    res = getMemberStatus(lineUserId); break;
      case 'verifyMembership':   res = verifyMembership(lineUserId, body.code); break;
      case 'getTrainers':        res = getTrainers(); break;
      case 'getTrainerSlots':    res = getTrainerSlots(body); break;
      case 'makeReservationLine':res = makeReservationLine(lineUserId, body); break;
      case 'makeReservationLineProxy': {
        var tr = requireTrainer(lineUserId);
        res = tr ? makeReservationLineProxy(tr, body) : { success: false, code: 'FORBIDDEN' };
        break;
      }
      default: res = { success: false, code: 'UNKNOWN_ACTION' };
    }
    return JSON.stringify(res);
  } catch (err) {
    Logger.log('liffApi エラー: ' + err.message);
    return JSON.stringify({ success: false, code: 'SERVER_ERROR', message: err.message });
  }
}

// ============================================================
// handleLineGet — GitHub Pages上のLIFFから JSONP(doGet) で呼ぶ窓口
//   ★LIFF画面はGitHub Pages（独自ドメイン）でホストし、GAS HtmlServiceは使わない
//     （HtmlServiceは消せないバナー＋googleusercontent.comドメインでliff.initが停止するため）。
//   ★GitHub Pages→GASはCORSでfetch不可のため、既存の体験予約と同じ JSONP(doGet+callback) で通信する。
//   入口で必ず verifyLineIdToken を通し lineUserId を確定（body/paramのidは信用しない）。
//   注意：JSONPはGETのため idToken がURLに載る（短命JWT・aud検証必須で影響限定・実行ログに残る点はdecisions/0033補遺に記録）。
// ============================================================
// 窓口。ここを1つの出口にして、書き込みが成功したら写しを直す。
//   ★各 case に個別に書き足さない。足し忘れがそのまま
//     「古い残数が見える」につながるため、必ずここを通す。
function handleLineGet(params) {
  var action = String((params && params.action) || '');
  var _tv = new Date().getTime();
  var auth = verifyLineIdToken(params && params.idToken);
  Logger.log('[perf] verifyLineIdToken: ' + (new Date().getTime() - _tv) + 'ms (' + action + ')');
  if (!auth.ok) return { success: false, code: 'UNAUTHORIZED' };

  var res = _lbDispatch(params, action, auth.lineUserId, auth);

  // 写しを直す。ここで何が起きても、返す答えは変えない。
  try { edgeAfterWrite(action, params, res, auth.lineUserId); } catch (e) {}
  return res;
}

function _lbDispatch(params, action, lineUserId, auth) {
  switch (action) {
    // ★まとめ取得。起動時の複数回を1回にする（LbBatch.js）。
    //   中身は下の個別の case と同じ関数を呼ぶ。答えの形も変えていない。
    case 'line_boot':               return lbBoot(lineUserId);
    case 'line_customerCard':       return lbCustomerCard(lineUserId, params.customerId);
    case 'line_getMemberStatus':    return getMemberStatus(lineUserId);
    case 'line_verifyMembership':   return verifyMembership(lineUserId, params.code);
    case 'line_selfRegister':       return selfRegister(lineUserId, { name: params.name, phone: params.phone, email: params.email, birthday: params.birthday, goal: params.goal, lang: params.lang });
    case 'line_setLang':            return setMemberLang(lineUserId, params.lang);
    case 'line_getTrainers':        return getTrainers(lineUserId);
    case 'line_getAllTrainers':     return requireTrainer(lineUserId) ? getAllTrainers(lineUserId) : { success: false, code: 'FORBIDDEN' };   // 未登録客枠の担当選択用（全トレーナー・越権はmakeAdminBookingが遮断）
    case 'line_getTrainerSlots':    return getTrainerSlots({ trainerId: params.trainerId, excludeStartISO: params.excludeStartISO });
    case 'line_makeReservationLine':return makeReservationLine(lineUserId, { trainerId: params.trainerId, startISO: params.startISO, attendeeCount: params.attendeeCount, packKind: params.packKind });   // packKind＝消化先の明示（併存会員用・省略時は実体から自動）
    case 'line_makeRecurringReservation':return makeRecurringReservationLine(lineUserId, { trainerId: params.trainerId, startISO: params.startISO, repeatCount: params.repeatCount });
    case 'line_makeBatchReservation':   return makeBatchReservationLine(lineUserId, { items: _lbParseItems(params.items) });   // まとめて予約（会員本人・items=JSON配列[{trainerId,startISO}]）
    case 'line_makeBatchReservationProxy': {
      var _bptr = requireTrainer(lineUserId);
      return _bptr ? makeBatchReservationLineProxy(_bptr, { customerId: params.customerId, items: _lbParseItems(params.items) }) : { success: false, code: 'FORBIDDEN' };
    }
    case 'line_makeTransferReservation':return makeTransferReservationLine(lineUserId, { trainerId: params.trainerId, startISO: params.startISO });
    case 'line_getBookingOptions':  return getBookingOptions(lineUserId, params.startISO, params.customerId);   // 予約対象日時ベースの選択肢（ペア残・通常経路）
    case 'line_getMyReservations':  return getMyReservations(lineUserId);
    case 'line_cancelReservation':  return cancelReservationLine(lineUserId, params.reservationId);
    case 'line_changeReservation':  return changeReservationLine(lineUserId, params.reservationId, params.newStartISO);
    case 'line_getTrainerReservations': return getTrainerReservations(lineUserId);
    case 'line_getPaceBoard':       return getPaceBoard(lineUserId);
    case 'line_getHealthBoard':     return getHealthBoard(lineUserId);
    case 'line_refreshContract':    return refreshContractForApp(lineUserId);
    case 'line_getCustomerHome':    return getCustomerHomeForTrainer(lineUserId, params.customerId);
    case 'line_getUnlinked':        return getUnlinkedReservations(lineUserId);
    case 'line_linkUnlinked':       return linkUnlinkedReservation(lineUserId, params.resId, params.customerId, params.attendeeCount);   // ペアは来店人数必須
    case 'line_addTicketRefill':    return addTicketRefill(lineUserId, params.customerId, params.tickets, params.unitPrice, params.expireISO, params.pair, params.normalUnitPrice, params.rental);
    case 'line_makeReservationLineProxy': {
      var _ptr = requireTrainer(lineUserId);
      return _ptr ? makeReservationLineProxy(_ptr, { customerId: params.customerId, trainerId: params.trainerId, startISO: params.startISO, attendeeCount: params.attendeeCount, packKind: params.packKind }) : { success: false, code: 'FORBIDDEN' };   // ペア代行時の来店人数（未指定=1名）
    }
    case 'line_makeAdminBooking': {
      var _pab = requireTrainer(lineUserId);
      return _pab ? makeAdminBooking(_pab, { trainerId: params.trainerId, startISO: params.startISO, customerName: params.customerName, kind: params.kind }) : { success: false, code: 'FORBIDDEN' };   // 未登録客の予約枠（本予約書式・登録後に同期で計上）
    }
    case 'line_makeBlock': {
      var _pbk = requireTrainer(lineUserId);
      return _pbk ? makeBlock(_pbk, { trainerId: params.trainerId, startISO: params.startISO, label: params.label }) : { success: false, code: 'FORBIDDEN' };   // ブロック枠（施設/担当を塞ぐ）
    }
    case 'line_listAdminSlots':     return listAdminSlots(lineUserId);          // 自分が作った枠/ブロックの一覧
    case 'line_deleteAdminSlot':    return deleteAdminSlot(lineUserId, params.eventId);   // 同上の削除（本予約は対象外）
    case 'line_deleteRecurringPattern': return deleteRecurringPattern(lineUserId, params.patternId);   // 固定枠の設定/登録/削除はトレーナー限定（顧客本人アクションは非公開）
    case 'line_addRecurringPatternByTrainer':  return addRecurringPatternByTrainer(lineUserId, params.customerId, { weekday: params.weekday, time: params.time, trainerId: params.trainerId });
    case 'line_listRecurringPatternsByTrainer':return listRecurringPatternsByTrainer(lineUserId, params.customerId);
    // ── meal-ai：InBody入力（トレーナー限定）── MealAi.js が未配置でも予約側を巻き込まない
    case 'line_maInBodyCard': {
      var _pic = requireTrainer(lineUserId);
      if (!_pic) return { success: false, code: 'FORBIDDEN' };
      // ★担当外の顧客の体組成を見せない（2026-10-03・Codexの再判定）。
      //   maInBodyCard_ は顧客IDだけで記録を返すため、ここで止めるしかない。
      if (!_lbTrainerMaySeeCustomer(_pic, _lbCustOwnerOf(params.customerId))) return { success: false, code: 'FORBIDDEN' };
      try { return maInBodyCard_(_pic, params.customerId); }
      catch (e1) { Logger.log('meal-ai 隔離(card): ' + e1.message); return { success: false, code: 'UNAVAILABLE' }; }
    }
    case 'line_maSaveInBody': {
      var _pis = requireTrainer(lineUserId);
      if (!_pis) return { success: false, code: 'FORBIDDEN' };
      // ★担当外の顧客の体組成を**書き込めない**ようにする（2026-10-03・Codexの再判定）。
      //   読み取りより重い。他のトレーナーの顧客の記録に測定値を混ぜられる状態だった。
      if (!_lbTrainerMaySeeCustomer(_pis, _lbCustOwnerOf(params.customerId))) return { success: false, code: 'FORBIDDEN' };
      try {
        return maSaveInBody_(_pis, params.customerId, {
          date: params.date, w: params.w, pbf: params.pbf,
          lean: params.lean, tbw: params.tbw, vis: params.vis
        });
      } catch (e2) { Logger.log('meal-ai 隔離(save): ' + e2.message); return { success: false, code: 'UNAVAILABLE', message: e2.message }; }
    }
    case 'line_whoami':             return { success: true, lineUserId: lineUserId, name: auth.name || '' };
    default: return { success: false, code: 'UNKNOWN_ACTION' };
  }
}

// 管理トークン照合（オーナー限定の最上位操作用・decisions/0033-5）
function _lbRequireAdmin(token) {
  var expected = _lbProp('LINE_ADMIN_TOKEN');
  if (!expected) return false;          // 未設定なら管理系は全拒否（fail-closed）
  if (!token) return false;
  return String(token) === String(expected);
}

// ============================================================
// customer_line_map ヘルパー
// ============================================================
function getCustomerByLine(lineUserId) {
  var sh = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (!sh) return null;
  var last = sh.getLastRow();
  if (last < 2) return null;
  var values = sh.getRange(2, 1, last - 1, MAP_COL.NOTE).getValues();
  var fallback = null;
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][MAP_COL.LINE_USER_ID - 1]) === String(lineUserId)) {
      if (String(values[i][MAP_COL.AUTH_STATE - 1]) === 'verified') return { row: i + 2, data: values[i] };   // verified優先（6-A：pending/verified二重行でも認証済を返す）
      if (!fallback) fallback = { row: i + 2, data: values[i] };
    }
  }
  return fallback;
}

// 名前→会員（verified）を逆引き（既存予約同期の自動紐付け用）。_lbNormNameで様・空白を吸収して照合。
function _lbFindMemberByName(name) {
  var sh = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (!sh) return null;
  var last = sh.getLastRow();
  if (last < 2) return null;
  var target = _lbNormName(name);
  if (!target) return null;
  var vals = sh.getRange(2, 1, last - 1, MAP_COL.NOTE).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][MAP_COL.AUTH_STATE - 1]) !== 'verified') continue;
    if (_lbNormName(vals[i][MAP_COL.NAME - 1]) === target) {
      return { lineUserId: String(vals[i][MAP_COL.LINE_USER_ID - 1]), customerId: String(vals[i][MAP_COL.CUSTOMER_ID - 1]), name: String(vals[i][MAP_COL.NAME - 1]) };
    }
  }
  return null;
}

// 氏名一致する verified 会員を「全件」返す（同名衝突の検出用・Codex#9）。同期は1件のときだけ自動紐付け。
function _lbFindMembersByName(name) {
  var out = [];
  var sh = _lbSheet(LINE_BOOKING.MAP_SHEET); if (!sh) return out;
  var last = sh.getLastRow(); if (last < 2) return out;
  var target = _lbNormName(name); if (!target) return out;
  var vals = sh.getRange(2, 1, last - 1, MAP_COL.NOTE).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][MAP_COL.AUTH_STATE - 1]) !== 'verified') continue;
    if (_lbNormName(vals[i][MAP_COL.NAME - 1]) === target) {
      out.push({ lineUserId: String(vals[i][MAP_COL.LINE_USER_ID - 1]), customerId: String(vals[i][MAP_COL.CUSTOMER_ID - 1]), name: String(vals[i][MAP_COL.NAME - 1]) });
    }
  }
  return out;
}

// verified 済みで、この lineUserId が既に使われているか（多重紐付けの逆方向チェック用）
function _lbFindVerifiedByLine(lineUserId) {
  var rec = getCustomerByLine(lineUserId);
  if (rec && String(rec.data[MAP_COL.AUTH_STATE - 1]) === 'verified') return rec;
  return null;
}

// ============================================================
// 会員登録 — 認証番号発行（管理・ADMIN_TOKEN必須）
//   顧客マスタ行（customer_id）に対しワンタイム番号を発行し hash+期限を保存。
//   番号平文はレスポンスで管理者に返す（対面/書面で顧客へ配布・DESIGN §5.1）。
// ============================================================
function issueVerifyCode(body) {
  var customerId = String(body.customerId || '').trim();
  if (!customerId) return { success:false, code:'BAD_REQUEST', message:'customerId必須' };

  var sh = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (!sh) return { success:false, code:'NO_SHEET', message:'customer_line_map未作成' };

  // customer_id で対象行を探す（なければ新規行）
  var last = sh.getLastRow();
  var row = null;
  if (last >= 2) {
    var values = sh.getRange(2, 1, last - 1, MAP_COL.NOTE).getValues();
    for (var i = 0; i < values.length; i++) {
      if (String(values[i][MAP_COL.CUSTOMER_ID - 1]) === customerId) { row = i + 2; break; }
    }
  }
  var code = _lbRandomCode(LINE_BOOKING.CODE_DIGITS);
  var hash = _lbHashCode(code);
  var expire = new Date(new Date().getTime() + LINE_BOOKING.CODE_TTL_MIN * 60000);

  if (row) {
    sh.getRange(row, MAP_COL.CODE_HASH).setValue(hash);
    sh.getRange(row, MAP_COL.CODE_EXPIRE).setValue(expire);
    sh.getRange(row, MAP_COL.TRY_COUNT).setValue(0);
    if (String(sh.getRange(row, MAP_COL.AUTH_STATE).getValue()) !== 'verified') {
      sh.getRange(row, MAP_COL.AUTH_STATE).setValue('pending');
    }
  } else {
    var newRow = sh.getLastRow() + 1;
    sh.getRange(newRow, MAP_COL.CUSTOMER_ID).setValue(sanitizeCell(customerId));
    if (body.name)  sh.getRange(newRow, MAP_COL.NAME).setValue(sanitizeCell(body.name));
    if (body.phone) sh.getRange(newRow, MAP_COL.PHONE).setValue(sanitizeCell(String(body.phone)));
    sh.getRange(newRow, MAP_COL.AUTH_STATE).setValue('pending');
    sh.getRange(newRow, MAP_COL.CODE_HASH).setValue(hash);
    sh.getRange(newRow, MAP_COL.CODE_EXPIRE).setValue(expire);
    sh.getRange(newRow, MAP_COL.TRY_COUNT).setValue(0);
  }
  // 番号は管理者にだけ返す（顧客へは対面/書面で渡す）
  return { success:true, customerId: customerId, code: code, expiresAt: expire.toISOString() };
}

// ============================================================
// 会員登録 — 認証番号照合（顧客LIFF・ID Token検証済 lineUserId）
//   ・lineUserId単位のレート制限（総当たり対策・decisions/0032 不変条件④）
//   ・hash照合＋期限内
//   ・多重紐付け双方向禁止
// ============================================================
function verifyMembership(lineUserId, code) {
  code = String(code || '').trim();
  if (!/^[0-9]{4,8}$/.test(code)) return { success:false, code:'BAD_REQUEST', message:'認証番号の形式が正しくありません。' };

  // レート制限（lineUserId単位・窓内 CODE_MAX_TRIES 回）
  var cache = CacheService.getScriptCache();
  var rlKey = 'lc_try_' + lineUserId;
  var tries = parseInt(cache.get(rlKey) || '0', 10);
  if (tries >= LINE_BOOKING.CODE_MAX_TRIES) {
    return { success:false, code:'RATE_LIMITED', message:'認証の試行が続いています。しばらくしてからお試しください。' };
  }
  cache.put(rlKey, String(tries + 1), LINE_BOOKING.TRY_WINDOW_SEC);

  var sh = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (!sh) return { success:false, code:'NO_SHEET' };

  // 逆方向の多重紐付け：この lineUserId が既に別customerで verified なら拒否
  var already = _lbFindVerifiedByLine(lineUserId);
  if (already) return { success:false, code:'ALREADY_LINKED', message:'このLINEアカウントは既に会員登録済みです。' };

  var last = sh.getLastRow();
  if (last < 2) return { success:false, code:'NOT_FOUND', message:'認証番号が正しくないか、有効期限が切れています。' };

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var values = sh.getRange(2, 1, last - 1, MAP_COL.NOTE).getValues();
    var hash = _lbHashCode(code);
    var now = new Date().getTime();

    for (var i = 0; i < values.length; i++) {
      var r = values[i];
      if (String(r[MAP_COL.CODE_HASH - 1]) !== hash) continue;

      var rowIndex = i + 2;
      // 試行回数を監査列にも加算
      sh.getRange(rowIndex, MAP_COL.TRY_COUNT).setValue(Number(r[MAP_COL.TRY_COUNT - 1] || 0) + 1);

      // 期限チェック
      var exp = r[MAP_COL.CODE_EXPIRE - 1];
      var expMs = (exp instanceof Date) ? exp.getTime() : new Date(exp).getTime();
      if (!expMs || expMs < now) return { success:false, code:'CODE_EXPIRED', message:'認証番号の有効期限が切れています。担当トレーナーへご連絡ください。' };

      // 正方向の多重紐付け：この行が既に別 lineUserId で verified なら拒否
      if (String(r[MAP_COL.AUTH_STATE - 1]) === 'verified' &&
          String(r[MAP_COL.LINE_USER_ID - 1]) && String(r[MAP_COL.LINE_USER_ID - 1]) !== String(lineUserId)) {
        return { success:false, code:'ALREADY_LINKED', message:'この認証番号は既に使用されています。' };
      }

      // 紐付け確定
      sh.getRange(rowIndex, MAP_COL.LINE_USER_ID).setValue(lineUserId);
      sh.getRange(rowIndex, MAP_COL.AUTH_STATE).setValue('verified');
      sh.getRange(rowIndex, MAP_COL.LINKED_AT).setValue(new Date());
      // ワンタイム番号を無効化（使い捨て）
      sh.getRange(rowIndex, MAP_COL.CODE_HASH).setValue('');
      sh.getRange(rowIndex, MAP_COL.CODE_EXPIRE).setValue('');
      cache.remove(rlKey);

      return { success:true, verified:true, customerId: String(r[MAP_COL.CUSTOMER_ID - 1]) };
    }
    return { success:false, code:'NOT_FOUND', message:'認証番号が正しくないか、有効期限が切れています。' };
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// 会員登録（自己登録）— 公式LINEの登録URLから顧客が基本情報を入力。
//   お名前＋電話番号で契約フォーム(顧客マスタ)と照合し、一致で customer_id を自動採番。
//   customer_line_map に基本情報(PII)を保存し line_user_id を紐付け（verified）。認証番号方式は併存（フォールバック）。
// ============================================================
// 電話番号の正規化：数字のみ＋先頭0除去（契約フォームの電話が数値型で先頭0が消えても照合できるように＝電話型）
function _lbNormPhone(s) { return String(s == null ? '' : s).replace(/[^0-9]/g, '').replace(/^0+/, ''); }
// PIIは空欄補完のみ（既存の値を無条件上書きしない・段階4）
function _lbSetIfBlank(sh, row, col, value) { var cur = sh.getRange(row, col).getValue(); if (cur === '' || cur == null) sh.getRange(row, col).setValue(sanitizeCell(value)); }

function selfRegister(lineUserId, body) {
  var name = String(body.name || '').trim();
  var phone = _lbNormPhone(body.phone);   // 数字のみ＋先頭0除去（数値型セル対策）
  var email = String(body.email || '').trim();
  var birthday = String(body.birthday || '').trim();
  var goal = String(body.goal || '').trim();
  if (!name || !phone || !email || !birthday || !goal) {
    return { success: false, code: 'BAD_REQUEST', message: 'すべての項目をご入力ください。' };
  }
  // 契約フォーム（顧客マスタ）と「お名前＋電話番号」で照合
  var c = _lbFindContract(name);
  if (!c) {
    // 記憶を捨てる：トレーナーが契約フォームに追加した直後に会員が再試行すれば、その場で通るようにする。
    //   （TTLを1時間に延ばしたため、これが無いと「追加したのに登録できない」時間が最大1時間続く）
    try { CacheService.getScriptCache().remove('lb_contract_all'); } catch (e) {}
    return { success: false, code: 'NOT_FOUND', message: '契約情報が見つかりません。お名前をご確認のうえ、担当トレーナーへご連絡ください。' };
  }
  var cPhone = _lbNormPhone(c.cols.phone >= 0 ? c.row[c.cols.phone] : '');
  if (!cPhone) return { success: false, code: 'NO_CONTRACT_PHONE', message: 'ご登録には電話番号の照合が必要です。担当トレーナーへご連絡ください。' };
  if (cPhone !== phone) return { success: false, code: 'PHONE_MISMATCH', message: '電話番号が契約情報と一致しません。ご確認のうえ担当トレーナーへご連絡ください。' };

  var sh = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (!sh) return { success: false, code: 'NO_SHEET', message: 'customer_line_map未作成' };
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    // map を正規化して昇格判定（新規発行/既存ID再利用/更新/再バインド認証必須/曖昧）を純粋関数で決める（段階4）
    var last = sh.getLastRow();
    var entries = [];
    if (last >= 2) {
      var vals = sh.getRange(2, 1, last - 1, MAP_COL.GOAL).getValues();
      for (var i = 0; i < vals.length; i++) {
        entries.push({ rowIndex: i + 2,
          lineUserId: String(vals[i][MAP_COL.LINE_USER_ID - 1] || ''),
          customerId: String(vals[i][MAP_COL.CUSTOMER_ID - 1] || ''),
          name: _lbNormName(vals[i][MAP_COL.NAME - 1]),
          phone: _lbNormPhone(vals[i][MAP_COL.PHONE - 1]),
          authState: String(vals[i][MAP_COL.AUTH_STATE - 1] || '') });
      }
    }
    var decision = _lbResolveRegistration(entries, lineUserId, _lbNormName(name), phone);   // phoneは上で正規化済み
    if (decision.action === 'idempotent') return { success: true, verified: true, customerId: decision.customerId };
    if (decision.action === 'ambiguous') return { success: false, code: 'AMBIGUOUS_MEMBER', message: 'ご登録情報の確認が必要です。担当トレーナーへご連絡ください。' };
    if (decision.action === 'rebind_required') return { success: false, code: 'VERIFY_REQUIRED', message: '機種変更などの再登録には認証番号が必要です。担当トレーナーへご連絡ください。' };

    var kind = (c.cols.type >= 0) ? String(c.row[c.cols.type] || '') : '';   // 契約の種別をmapにも記録（自己予約のタイトル種別の土台）
    var trName = (c.cols.trainer >= 0) ? String(c.row[c.cols.trainer] || '') : '';
    var trId = _lbTrainerIdByName(trName);
    var customerId = decision.customerId || ('C' + Utilities.formatDate(new Date(), SETTINGS.TIMEZONE, 'yyyyMMddHHmmss'));
    var row = (decision.rowIndex && decision.rowIndex > 0) ? decision.rowIndex : (sh.getLastRow() + 1);
    // バインド確定（ID/紐付けは確定値・PIIは空欄補完のみで既存を上書きしない）
    sh.getRange(row, MAP_COL.LINE_USER_ID).setValue(lineUserId);
    sh.getRange(row, MAP_COL.CUSTOMER_ID).setValue(sanitizeCell(customerId));
    _lbSetIfBlank(sh, row, MAP_COL.NAME, name);
    _lbSetIfBlank(sh, row, MAP_COL.PHONE, phone);
    sh.getRange(row, MAP_COL.CONTRACT_TYPE).setValue(sanitizeCell(kind));   // 種別は最新契約で更新
    if (trId) sh.getRange(row, MAP_COL.TRAINER_ID).setValue(trId);
    sh.getRange(row, MAP_COL.AUTH_STATE).setValue('verified');
    sh.getRange(row, MAP_COL.LINKED_AT).setValue(Utilities.formatDate(new Date(), SETTINGS.TIMEZONE, 'yyyy/MM/dd HH:mm'));
    _lbSetIfBlank(sh, row, MAP_COL.EMAIL, email);
    _lbSetIfBlank(sh, row, MAP_COL.BIRTHDAY, birthday);
    _lbSetIfBlank(sh, row, MAP_COL.GOAL, goal);
    sh.getRange(row, MAP_COL.LANG).setValue(_lbNormLang(body.lang));   // 表示/通知言語（登録時の検出値・以後トグルで更新）
    // 登録直後にカレンダー同期を裏で走らせる＝「登録したのにマイ予約が空」を防ぐ。
    //   失敗しても登録自体は成功（6時間毎の定期同期で取り込まれる）。
    _lbScheduleSyncAfterRegister();
    return { success: true, verified: true, customerId: customerId };
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// 会員状態の取得（骨格・残数計算はPhase 2で請求連携）
// ============================================================
function getMemberStatus(lineUserId) {
  // トレーナー本人なら管理モード（顧客の会員情報より優先）
  var _tr = getTrainerByLine(lineUserId);
  //   roleは'trainer'固定（オーナーもトレーナー画面を使うため）。オーナー限定の導線を出し分けたいので
  //   isOwner を別に返す（画面側で判定できるようにする）。
  if (_tr) return { success: true, verified: true, role: 'trainer', trainerName: _tr.name, trainerId: _tr.trainerId, isOwner: _lbIsOwnerRole(_tr) };
  var rec = getCustomerByLine(lineUserId);
  if (!rec || String(rec.data[MAP_COL.AUTH_STATE - 1]) !== 'verified') {
    return { success:true, verified:false };
  }
  var customerId = String(rec.data[MAP_COL.CUSTOMER_ID - 1]);
  // オンボード期間（登録可・予約不可）＝残数はまだ棚卸し前で正確でないため、数字を出さず「9/1開始」案内に切り替える。
  var _onboarding = (String(_lbProp('LB_ONBOARDING_MODE')) === 'true' && String(_lbProp('LB_FACILITY_LIVE')) !== 'true');
  var _lang = _lbMemberLang(lineUserId);   // 期限ラベル等を会員の言語で
  var _home = _onboarding ? { type: null } : _lbBuildHome(customerId, String(rec.data[MAP_COL.NAME - 1] || ''), _lang);
  return {
    success: true,
    verified: true,
    onboarding:      _onboarding,
    name:            String(rec.data[MAP_COL.NAME - 1] || '会員'),
    customerId:      customerId,
    contractStatus:  String(rec.data[MAP_COL.CONTRACT_STAT - 1] || ''),
    contractType:    String(rec.data[MAP_COL.CONTRACT_TYPE - 1] || ''),
    defaultTrainerId:String(rec.data[MAP_COL.TRAINER_ID - 1] || ''),
    // ★ペア判定は契約種別の文字列でなく実体（有効なペアpack残）で行う＝購入直後から効き、失効後は自動で消える。
    isPair:          ((_home && _home.pairRemaining) > 0),                    // ペアチケットを持つ＝予約時に来店人数を選ぶ
    hasNormalRoute:  !!(_home && _home.hasNormalRoute),                       // 月額枠 or 通常チケットが残っている＝消化先を選べる
    pairRemaining:   (_home && _home.pairRemaining) || 0,
    pairPackMax:     (_home && _home.pairPackMax) || 0,                       // 単一packの最大残（2名来店の可否目安）
    transferCredits: _onboarding ? { available: 0 } : _lbTransferCreditsFor(customerId, _lang),   // #9：有効な振替権（予約画面の①通常/②振替の分岐＋ホーム表示）
    home:            _home   // オンボード中は残数を計算・表示しない
  };
}

// ホーム表示用の契約・残数情報（契約フォーム回答＋line_reservationsから）。契約期間内の行が無ければ type:null。
// targetDateMs＝残数を「いつ時点」で出すか。省略＝今日（ホーム画面）。
//   通知は「予約した日の月」で出す必要がある。25日以降は翌月の予約ができるため、
//   今日基準のままだと月途中で契約が変わる会員に誤った回数が届く（2026-09-26 実害）。
function _lbBuildHome(customerId, customerName, lang, targetDateMs) {
  if (!customerName) return { type: null };
  var rows = _lbContractRowsAll(customerName, _lbPhoneByCustomerId(customerId), false, customerId);   // 全履歴（H1）＋ID優先join（H3）
  if (rows.migrationGap) return { type: null, reviewRequired: true };   // C-2：ID移行未完了
  if (!rows.length) return { type: null };
  var sp = _lbSplitRemaining(rows, customerId, (targetDateMs != null && isFinite(targetDateMs)) ? targetDateMs : undefined);   // 月額+チケット併存対応（月額優先消化）
  if (!sp._ok) return { type: null, reviewRequired: true };   // M1：割当器ok=false時は壊れた残数を表示しない
  if (!sp.hasMonthly && !sp.hasTicket) return { type: null };

  // チケットの有効期限（最も遅い行）
  var ticketExpire = '', ticketExpireMs = null;
  if (sp.hasTicket) {
    for (var i = 0; i < rows.length; i++) {
      var rr = rows[i], cc = rr.cols, rw = rr.row;
      var mth = String(cc.method >= 0 ? rw[cc.method] : ''), tp = String(cc.type >= 0 ? rw[cc.type] : '');
      var isT = mth ? (mth.indexOf('チケット') >= 0) : (tp.indexOf('チケット') >= 0);
      if (isT && rr.end && (ticketExpireMs === null || rr.end.getTime() > ticketExpireMs)) {
        ticketExpireMs = rr.end.getTime(); ticketExpire = _lbFmtDateOnly(cc.end >= 0 ? rw[cc.end] : '', lang);
      }
    }
  }
  // 翌月の受付が始まっていれば（25日ゲート）、翌月に使える回数も返す。
  //   ホームの残数は「今日」基準のため、25日以降は「今月0回／翌月6回」のようにズレる。
  //   お客様が「もう予約できない」と誤解して翌月の枠を取りに来ないのを防ぐ（全会員で起きる）。
  var nextMonth = null;
  try {
    var _now = new Date();
    if (_now.getDate() >= 25) {
      var _nm = new Date(_now.getFullYear(), _now.getMonth() + 1, 15, 12, 0, 0);   // 翌月の中旬＝確実にその月
      var spN = _lbSplitRemaining(rows, customerId, _nm.getTime(), sp._sessions);
      if (spN && spN._ok) {
        var _tot = (spN.monthlyRem == null ? 0 : Number(spN.monthlyRem)) + Number(spN.ticketRem || 0);
        if (_tot > 0) nextMonth = { month: _nm.getMonth() + 1, total: _tot };   // 0回なら出さない（契約終了など）
      }
    }
  } catch (e) { Logger.log('翌月残数の算出に失敗（表示を省略）: ' + e.message); }

  var month = _lbCountReservations(customerId, 'month');
  var type = (sp.hasMonthly && sp.hasTicket) ? 'both' : (sp.hasTicket ? 'ticket' : 'monthly');
  return {
    type: type, active: true, nextMonth: nextMonth,
    quota: sp.freq, carryover: (sp.avail - sp.freq), thisMonth: month, monthlyRemaining: sp.monthlyRem,
    ticketTotal: sp.ticketTotal, ticketRemaining: sp.ticketRem, ticketExpire: ticketExpire, ticketExpireMs: ticketExpireMs,
    // ペア／通常の内訳と「通常経路が使えるか」。予約確定画面が消化先の選択を出すか決めるのに使う（当日基準の目安・最終判定はサーバ）。
    pairRemaining: sp.ticketRemPair, pairPackMax: sp.pairPackMax, normalTicketRemaining: sp.ticketRemNormal,
    hasNormalRoute: ((sp.monthlyRem == null) ? !!sp.hasMonthly : (sp.monthlyRem > 0)) || (sp.ticketRemNormal > 0),
    ticketPacks: (sp.ticketPacks || []).map(function (p) { return { remaining: p.remaining, expire: _lbFmtDateOnly(new Date(p.expireMs), lang), kind: (p.kind || 'normal') }; }),   // #3：pack別（残枚数・期限・種別）
    // 後方互換（既存フロントの単一type表示用）
    remaining: (type === 'ticket') ? sp.ticketRem : sp.monthlyRem,
    total: sp.ticketTotal, used: (sp.ticketTotal - sp.ticketRem), expire: ticketExpire, expireMs: ticketExpireMs
  };
}

// ============================================================
// トレーナー認証（案B・decisions/0033-4）
//   LIFFのID Tokenで確定した lineUserId を trainer_master で照合し role=trainer を確認。
//   共有トークンは使わない（個人単位で監査可能）。
// ============================================================
function getTrainerByLine(lineUserId) {
  var sh = _lbSheet(LINE_BOOKING.TRAINER_SHEET);
  if (!sh) return null;
  var last = sh.getLastRow();
  if (last < 2) return null;
  var values = sh.getRange(2, 1, last - 1, TR_COL.ACTIVE).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][TR_COL.LINE_USER_ID - 1]) === String(lineUserId)) {
      var active = values[i][TR_COL.ACTIVE - 1];
      var _act = String(active).trim().toLowerCase();
      if (!(active === true || _act === 'true' || _act === '1' || _act === '有効' || _act === 'yes' || _act === 'active')) return null;   // fail-closed：認識できる有効値のみ許可（空欄/壊れ値/false系は無効・Codex）
      return {
        row: i + 2,
        trainerId: String(values[i][TR_COL.TRAINER_ID - 1]),
        name:      String(values[i][TR_COL.NAME - 1]),
        role:      String(values[i][TR_COL.ROLE - 1] || 'trainer')
      };
    }
  }
  return null;
}

// トレーナー権限を要求（Phase 2+ の confirmAttendance / 代理予約 で使用）
function requireTrainer(lineUserId) {
  var tr = getTrainerByLine(lineUserId);
  if (!tr || (tr.role !== 'trainer' && tr.role !== 'owner' && tr.role !== 'admin')) return null;   // 有効スタッフロールのホワイトリスト（owner/adminも許可・Codex退行修正）
  return tr;
}

// ============================================================
// follow webhook（friend追加時に line_user_id を記録＝配信の会員/非会員振り分け土台）
//   GASはHTTPヘッダを取得できず x-line-signature 検証不可 → URLクエリの whToken で代替検証（fail-closed）。
//   ※follow情報だけでは会員にならない（会員化は verifyMembership の認証番号が必須）。
// ============================================================
function handleLineWebhook(e) {
  var p = e.parameter || {};
  var expected = _lbProp('LINE_WEBHOOK_TOKEN');
  if (!expected || String(p.whToken) !== String(expected)) {
    Logger.log('webhook: whToken不一致 → 拒否');
    return _lbJson({ success:false, code:'UNAUTHORIZED' });
  }
  try {
    var payload = JSON.parse(e.postData.contents);
    var events = (payload && payload.events) || [];
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      var uid = ev && ev.source && ev.source.userId;
      if (!uid) continue;
      if (ev.type === 'follow') { _lbUpsertFollower(uid); }   // あいさつはLINE公式の管理画面で設定（二重送信を避けるためwebhook側では送らない）
      // ★meal-ai（体重・のちに食事）。MealAi.js が未配置でも ReferenceError をここで握りつぶし、
      //   予約側は絶対に巻き込まない（設計 §2.1）。
      else if (ev.type === 'message') {
        try { _maHandleMessage(ev); }
        catch (mealErr) { Logger.log('meal-ai 隔離: ' + mealErr.message); }
      }
      else if (ev.type === 'postback') {
        try { _maHandlePostback(ev); }
        catch (mealErr2) { Logger.log('meal-ai 隔離(postback): ' + mealErr2.message); }
      }
      // unfollow等は将来: 配信対象フラグの更新
    }
    return _lbJson({ success:true });
  } catch (err) {
    Logger.log('webhook エラー: ' + err.message);
    return _lbJson({ success:false, code:'SERVER_ERROR' });
  }
}

// friend追加者を記録（未登録なら pending 行を用意。既存行があれば何もしない）
function _lbUpsertFollower(lineUserId) {
  var sh = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (!sh) return;
  if (getCustomerByLine(lineUserId)) return; // 既に行あり
  var newRow = sh.getLastRow() + 1;
  sh.getRange(newRow, MAP_COL.LINE_USER_ID).setValue(lineUserId);
  sh.getRange(newRow, MAP_COL.AUTH_STATE).setValue('pending');
  sh.getRange(newRow, MAP_COL.LINKED_AT).setValue(new Date());
  sh.getRange(newRow, MAP_COL.NOTE).setValue('follow');
}

// ============================================================
// 日次契約同期（骨格・請求マスタ連携はPhase 4）
//   退会・休会・失効を verified→アクセス制限へ降格（DESIGN §5.4）。
//   Phase 4で請求マスタ（種別・開始/終了日）を読み G列 contract_status を更新する。
// ============================================================
function syncContractStatus() {
  var sh = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (!sh || sh.getLastRow() < 2) { Logger.log('syncContractStatus: customer_line_map未作成/空'); return { success: true, updated: 0 }; }
  // ★契約シートが読めない/空なら同期中止（全verified会員を誤ってexpired降格しない・Codex）。
  var _csh = _lbContractSheet();
  if (!_csh || _csh.getLastRow() < 2) { Logger.log('syncContractStatus: 契約シート読取不可/空→同期中止(全員降格を防ぐ)'); return { success: false, code: 'NO_CONTRACT_SHEET' }; }
  var last = sh.getLastRow();
  var vals = sh.getRange(2, 1, last - 1, MAP_COL.AUTH_STATE).getValues();   // AUTH_STATE(8列)まで読む（NAME幅だと認証/契約状況列がundefinedになるバグ修正）
  var updated = 0, expired = 0;
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][MAP_COL.AUTH_STATE - 1]) !== 'verified') continue;
    var name = String(vals[i][MAP_COL.NAME - 1] || ''), cid = String(vals[i][MAP_COL.CUSTOMER_ID - 1] || '');
    // 氏名＋電話（＋顧客ID）で厳密に絞った契約行のうち、期間内が1つでもあれば active。
    //   ※_lbFindContractは電話不一致時に同名別人の最新行へfallbackし誤active化しうるため使わない（Codex）。
    var rows = _lbContractRowsAll(name, _lbPhoneByCustomerId(cid), false, cid);
    var nowMs = new Date().getTime(), hasActive = false;
    for (var k = 0; k < rows.length; k++) {
      var st = rows[k].start ? rows[k].start.getTime() : null, en = rows[k].end ? rows[k].end.getTime() : null;
      if ((st === null || st <= nowMs) && (en === null || en >= nowMs)) { hasActive = true; break; }
    }
    var want = (rows.migrationGap ? '' : (hasActive ? 'active' : 'expired'));   // 移行ギャップは判定保留（空＝変更しない）
    if (want === '') continue;
    var cur = String(vals[i][MAP_COL.CONTRACT_STAT - 1] || '');
    if (cur !== want) { sh.getRange(i + 2, MAP_COL.CONTRACT_STAT).setValue(want); updated++; if (want === 'expired') expired++; }
  }
  Logger.log('syncContractStatus: ' + updated + '件更新（expired ' + expired + '件）。予約可否は割当器の契約期間判定でも二重に担保。');
  return { success: true, updated: updated, expired: expired };
}

// ============================================================
// 前日リマインダー（毎日トリガー）— 翌日のline予約を顧客＋トレーナー両方のLINEへ通知
//   line_reservations の翌日分 confirmed を抽出し push。トレーナーは trainer_master の line_user_id 宛。
// ============================================================
function sendLineReminders() {
  var sh = _lbSheet(LINE_BOOKING.RESV_SHEET);
  if (!sh) { Logger.log('sendLineReminders: line_reservations未作成'); return; }
  var last = sh.getLastRow();
  if (last < 2) return;
  var values = sh.getRange(2, 1, last - 1, 11).getValues();
  var tz = SETTINGS.TIMEZONE;
  var tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  var ts = new Date(tomorrow); ts.setHours(0, 0, 0, 0);
  var te = new Date(tomorrow); te.setHours(23, 59, 59, 999);
  var now = new Date().getTime();
  var byTrainer = {};   // trainerId → { name, list:[{sort,time,custName,isTransfer,zanText,warn}] }
  var enMap = _lbTrainerEnMap();   // 顧客が英語なら英語名でトレーナー名を出す
  // 送達の実測（来ない原因を後から切り分けるため）：対象/送信成功/未達/LINE未連携/行エラー
  var sent = 0, failed = 0, targets = 0, noLine = 0, rowErrors = [];
  for (var i = 0; i < values.length; i++) {
   try {
    var r = values[i];
    if (String(r[6]) !== 'confirmed') continue;                 // G=status
    var dt = _lbParseResvDate(r[0]);                            // A=予約日時（文字列/日付型の両方を吸収）
    if (!dt || dt < ts || dt > te) continue;
    targets++;
    var custLine    = String(r[3]);   // D=line_user_id
    var custName    = String(r[1]);   // B=顧客名
    var trainerId   = String(r[4]);   // E=trainer_id
    var trainerName = String(r[5]);   // F=トレーナー名
    var dow = ['日','月','火','水','木','金','土'][dt.getDay()];
    var stt = Utilities.formatDate(dt, tz, 'HH:mm');
    var ett = Utilities.formatDate(new Date(dt.getTime() + SETTINGS.SESSION_MINUTES * 60000), tz, 'HH:mm');
    var label = Utilities.formatDate(dt, tz, 'M/d') + '（' + dow + '）' + stt;   // トレーナー集約は日本語のまま
    var isTransfer = (String(r[9]) === 'transfer');
    // 残数情報＋注意喚起（トレーナー用・日本語。顧客向けは下で言語別に組む）
    var home = _lbBuildHome(String(r[2]), custName);
    var zanText = '', warn = '';
    if (home && home.type === 'ticket') {
      zanText = 'チケット残り' + home.remaining + '回' + (home.expire ? '（有効期限 ' + home.expire + '）' : '');
      if (home.remaining <= 1) warn = '※チケット残りわずか。継続のご案内を';
      else if (home.expireMs && (home.expireMs - now) < 30 * 24 * 3600 * 1000) warn = '※有効期限が近づいています。継続のご案内を';
    } else if (home && home.type === 'monthly') {
      zanText = '今月' + home.thisMonth + '回 / 月' + home.quota + '回' + (home.carryover ? '＋繰越' + home.carryover + '回' : '') + (home.remaining !== null ? '（残り' + home.remaining + '回）' : '');
      if (home.remaining !== null && home.remaining <= 0) warn = '※今月の枠を使い切ります。継続・追加のご案内を';
    }
    // 顧客へ（各予約1通・会員の言語で）
    if (custLine) {
      var clang = _lbMemberLang(custLine, String(r[2]));
      var custLabel = _lbFmtDateShort(dt, clang) + ' ' + stt;   // 「M月d日 HH:mm」/「Sep 1 10:00」
      var zanC = '';   // 顧客向け残数（言語別）
      if (home && home.type === 'ticket') zanC = _lbSt(clang,'zan_ticket',{n:home.remaining}) + (home.expireMs ? _lbSt(clang,'zan_ticket_exp',{e:_lbFmtDateShort(new Date(home.expireMs), clang)}) : '');
      else if (home && home.type === 'monthly') zanC = _lbSt(clang,'zan_monthly',{ used:home.thisMonth, q:home.quota, carry:(home.carryover?_lbSt(clang,'zan_carry',{c:home.carryover}):''), rem:(home.remaining!==null?_lbSt(clang,'zan_rem',{r:home.remaining}):'') });
      var _okPush = _lbPush(custLine,
        _lbSt(clang, isTransfer ? 'rem_title_transfer' : 'rem_title') +
        '\n' + _lbStripSama(custName) + _lbSt(clang,'name_suffix') +   // 敬称はname_suffix側だけ＝「様 様」を防ぐ（2026-09-16）
        '\n' + _lbSt(clang,'rem_datetime') + custLabel + '〜' + ett +
        '\n' + _lbSt(clang,'rem_trainer') + _lbTrainerNameLang(trainerId, trainerName, clang, enMap) +
        '\n' + _lbSt(clang,'rem_place') + _lbSt(clang,'gym_name') +
        (zanC ? '\n' + _lbSt(clang,'rem_status') + zanC : '') +
        '\n\n' + _lbSt(clang,'rem_arrive') +
        '\n\n' + _lbSt(clang,'rem_footer') + (isTransfer ? '' : '\n' + _lbSt(clang,'rem_free_cancel')), 'reminder_customer');
      if (_okPush) sent++; else failed++;
      Utilities.sleep(250);   // 連続送信で429を招かないための間隔（対象20名でも5秒程度）
    } else { noLine++; }   // LINE未連携の会員（同期で取り込んだ予約など）＝送りようがない
    // トレーナー向けは集約（後でトレーナーごとに1通）
    if (!byTrainer[trainerId]) byTrainer[trainerId] = { name: trainerName, list: [] };
    byTrainer[trainerId].list.push({ sort: dt.getTime(), time: stt + '〜' + ett, custName: custName, isTransfer: isTransfer, zanText: zanText, warn: warn });
   } catch (eRow) {
     // ★1件の異常（残数データ不備など）で全員のリマインドを止めない。行を記録して次へ進む。
     rowErrors.push(String(values[i] && values[i][1] || '?') + ': ' + eRow.message);
     Logger.log('リマインド1件失敗（他は継続）: ' + eRow.message);
   }
  }
  // トレーナーごとに翌日分をまとめて1通（時刻順）
  var dowJa = ['日','月','火','水','木','金','土'];
  var tomoLabel = Utilities.formatDate(tomorrow, tz, 'M/d') + '（' + dowJa[tomorrow.getDay()] + '）';
  var trSent = 0, trNoLine = 0, trFailed = 0;
  for (var tid in byTrainer) {
   try {
    var trLine = getTrainerLineId(tid);
    if (!trLine) { trNoLine++; continue; }   // trainer_master に line_user_id 未登録＝届かない
    var g = byTrainer[tid];
    g.list.sort(function (a, b) { return a.sort - b.sort; });
    var msg = '【明日のセッション予定】' + tomoLabel + '　' + g.list.length + '件\n場所：' + SETTINGS.GYM_NAME;
    for (var j = 0; j < g.list.length; j++) {
      var s = g.list[j];
      msg += '\n\n' + (j + 1) + '. ' + s.time + (s.isTransfer ? '（振替）' : '') +
        '\n　お客様：' + s.custName + ' 様' +
        (s.zanText ? '\n　残数：' + s.zanText : '') +
        (s.warn ? '\n　' + s.warn : '');
    }
    if (_lbPush(trLine, msg, 'reminder_trainer')) trSent++; else trFailed++;
   } catch (eTr) { trFailed++; Logger.log('トレーナーリマインド失敗（他は継続）: ' + eTr.message); }
  }
  var _res = { success: true, targets: targets, sent: sent, failed: failed, noLine: noLine,
               trainerSent: trSent, trainerNoLine: trNoLine, trainerFailed: trFailed,
               rowErrors: rowErrors.slice(0, 10), tomorrow: Utilities.formatDate(tomorrow, tz, 'yyyy/MM/dd') };
  Logger.log('sendLineReminders: ' + JSON.stringify(_res));
  _lbLogReminderStatus(_res);
  return _res;
}

// 前日リマインドの実行記録（sync_status と同方針）。「そもそも動いたのか」を後から確認できるようにする。
//   ここに行が増えない＝トリガーが動いていない、という切り分けができる。
var LB_REMINDER_STATUS_SHEET = 'reminder_status';
function _lbLogReminderStatus(res) {
  try {
    var ss = _lbSs(); var sh = ss.getSheetByName(LB_REMINDER_STATUS_SHEET) || ss.insertSheet(LB_REMINDER_STATUS_SHEET);
    if (sh.getLastRow() === 0) { sh.getRange(1, 1, 1, 3).setValues([['実行時刻', '結果', '詳細']]).setFontWeight('bold'); sh.setFrozenRows(1); }
    var when = Utilities.formatDate(new Date(), SETTINGS.TIMEZONE, 'yyyy/MM/dd HH:mm');
    var okTxt = '対象' + res.targets + '件／顧客' + res.sent + '通' + (res.failed ? '（未達' + res.failed + '）' : '') +
                (res.noLine ? '／LINE未連携' + res.noLine : '') + '／トレーナー' + res.trainerSent + '名' +
                (res.trainerNoLine ? '（未登録' + res.trainerNoLine + '）' : '') + (res.rowErrors.length ? '／⚠️行エラー' + res.rowErrors.length : '');
    sh.insertRowsAfter(1, 1); sh.getRange(2, 1, 1, 3).setValues([["'" + when, okTxt, String(JSON.stringify(res)).slice(0, 500)]]);
  } catch (e) { Logger.log('reminder_status記録失敗: ' + e.message); }
}

// ============================================================
// 前日リマインドが届かないときの診断（GASエディタで実行・送信はしない・読み取りのみ）
//   「トリガーが無い」「LINE未連携」「トレーナー未登録」「残数データ不備で落ちる」「通知がLINE側で弾かれている」を
//   1回の実行で切り分ける。機密（トークンの値）は出力しない（有無と桁数のみ）。
// ============================================================
function debugReminders() {
  var tz = SETTINGS.TIMEZONE, out = [];
  out.push('=== 前日リマインド 診断 ' + Utilities.formatDate(new Date(), tz, 'yyyy/MM/dd HH:mm') + ' ===');

  // ① トリガー（ここに sendLineReminders が無ければ、そもそも自動実行されていない＝最有力原因）
  var trs = ScriptApp.getProjectTriggers(), names = {};
  for (var i = 0; i < trs.length; i++) { var h = trs[i].getHandlerFunction(); names[h] = (names[h] || 0) + 1; }
  var list = []; for (var k in names) list.push(k + (names[k] > 1 ? '×' + names[k] : ''));
  out.push('① トリガー(' + trs.length + '件): ' + (list.length ? list.join(', ') : 'なし'));
  out.push('   → sendLineReminders: ' + (names['sendLineReminders'] ? '✅登録あり' : '❌未登録＝自動実行されない。setupLineTriggers() を1回実行してください'));

  // ② 送信トークン（値は出さない）
  var tk = _lbProp('LINE_MESSAGING_TOKEN');
  out.push('② LINE_MESSAGING_TOKEN: ' + (tk ? '✅設定あり（' + String(tk).length + '文字）' : '❌未設定＝全通知が送られない'));

  // ③ 明日の予約と、その宛先が揃っているか
  var sh = _lbSheet(LINE_BOOKING.RESV_SHEET);
  if (!sh || sh.getLastRow() < 2) { out.push('③ line_reservations: 行なし'); Logger.log(out.join('\n')); return out.join('\n'); }
  var tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  var ts = new Date(tomorrow); ts.setHours(0, 0, 0, 0);
  var te = new Date(tomorrow); te.setHours(23, 59, 59, 999);
  var v = sh.getRange(2, 1, sh.getLastRow() - 1, 11).getValues();
  var rows = [], noLine = [], homeErr = [], trainers = {};
  for (var j = 0; j < v.length; j++) {
    var r = v[j];
    if (String(r[6]) !== 'confirmed') continue;
    var dt = _lbParseResvDate(r[0]);
    if (!dt || dt < ts || dt > te) continue;
    var nm = String(r[1]), luid = String(r[3]), tid = String(r[4]);
    rows.push(Utilities.formatDate(dt, tz, 'M/d HH:mm') + ' ' + nm + '（担当' + String(r[5]) + '）' + (luid ? '' : ' ※LINE未連携'));
    if (!luid) noLine.push(nm);
    trainers[tid] = String(r[5]);
    // 残数計算が例外を投げる会員がいると、以前はそこで全員分が止まっていた（現在は行単位で継続）
    try { _lbBuildHome(String(r[2]), nm); } catch (e) { homeErr.push(nm + ': ' + e.message); }
  }
  out.push('③ 明日(' + Utilities.formatDate(tomorrow, tz, 'yyyy/MM/dd') + ')の確定予約: ' + rows.length + '件');
  for (var x = 0; x < rows.length; x++) out.push('   ・' + rows[x]);
  if (!rows.length) out.push('   → 0件なら「送るものが無い」＝正常。前日に予約がある日で再確認してください');
  if (noLine.length) out.push('   ⚠️ LINE未連携で顧客に届かない: ' + noLine.join(', '));
  if (homeErr.length) out.push('   ⚠️ 残数計算でエラー: ' + homeErr.join(' / '));

  // ④ トレーナー側の宛先（trainer_master の line_user_id）
  var trOk = [], trNg = [];
  for (var t2 in trainers) { (getTrainerLineId(t2) ? trOk : trNg).push(trainers[t2] || t2); }
  out.push('④ トレーナー宛先: 送れる=' + (trOk.join(',') || 'なし') + ' / ❌未登録=' + (trNg.join(',') || 'なし'));

  // ⑤ 実行記録（行が増えていない＝トリガーが動いていない）
  var rs = _lbSheet(LB_REMINDER_STATUS_SHEET);
  if (rs && rs.getLastRow() > 1) {
    var rv = rs.getRange(2, 1, Math.min(3, rs.getLastRow() - 1), 2).getValues();
    out.push('⑤ 直近の実行記録:');
    for (var y = 0; y < rv.length; y++) out.push('   ・' + rv[y][0] + ' ' + rv[y][1]);
  } else {
    out.push('⑤ 実行記録: なし（このデプロイ以降まだ1度も動いていない）');
  }

  // ⑥ LINE側で弾かれた通知（401=トークン失効 / 403=ブロック / 429=送信上限）
  var m = getBookingMetrics(7), nf = m.notifyFail || { total: 0, byReason: {} };
  var rr = []; for (var rk in nf.byReason) rr.push(rk + ':' + nf.byReason[rk]);
  out.push('⑥ 直近7日のLINE未達: ' + nf.total + '件' + (rr.length ? '（' + rr.join(' / ') + '）' : ''));

  var txt = out.join('\n');
  Logger.log(txt);
  return txt;
}

// ============================================================
// LINE公式アカウントの当月メッセージ通数を確認する（読み取りのみ・送信しない）
//   HTTP 429 が出る原因は「短時間の連打」か「当月の無料通数の上限」かの二択で、
//   後者なら全ての push が弾かれる＝予約確定もリマインドも一切届かない。ここで一意に判定する。
//   quota: {"type":"limited","value":200} / {"type":"none"}（無制限）
//   consumption: {"totalUsage":123}
// ============================================================
// 当月通数の取得（純粋な読み取り。表示・監視の両方から使う）
//   quota: {"type":"limited","value":5000} / {"type":"none"}（無制限）　consumption: {"totalUsage":123}
function _lbQuotaFetch() {
  var token = _lbProp('LINE_MESSAGING_TOKEN');
  if (!token) return { ok: false, error: 'NO_TOKEN' };
  var opt = { method: 'get', headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true };
  function get(url) {
    var res = UrlFetchApp.fetch(url, opt);
    var code = Number(res.getResponseCode());
    var body = String(res.getContentText() || '');
    if (code !== 200) return { ok: false, code: code, body: body.slice(0, 200) };
    try { return { ok: true, data: JSON.parse(body) }; } catch (e) { return { ok: false, code: code, body: body.slice(0, 200) }; }
  }
  var q = get('https://api.line.me/v2/bot/message/quota');
  var c = get('https://api.line.me/v2/bot/message/quota/consumption');
  if (!q.ok || !c.ok) return { ok: false, error: 'HTTP', quota: q, consumption: c };
  var type = String(q.data.type || ''), limit = Number(q.data.value || 0), used = Number(c.data.totalUsage || 0);
  if (type === 'none') return { ok: true, limited: false, used: used, limit: null, left: null, pct: 0 };
  return { ok: true, limited: true, used: used, limit: limit, left: limit - used, pct: limit ? Math.round(used / limit * 100) : 0 };
}

// 当月のメッセージ通数を表示する（GASエディタから実行・読み取りのみ）
function debugLineQuota() {
  var q = _lbQuotaFetch();
  var out = ['=== LINE 当月メッセージ通数 ' + Utilities.formatDate(new Date(), SETTINGS.TIMEZONE, 'yyyy/MM/dd HH:mm') + ' ==='];
  if (!q.ok) { out.push('❌ 取得失敗: ' + JSON.stringify(q).slice(0, 300)); Logger.log(out.join('\n')); return null; }
  if (!q.limited) {
    out.push('プラン上限：なし（無制限）／今月の送信: ' + q.used + '通');
  } else {
    out.push('プラン上限：' + q.limit + '通／今月の送信: ' + q.used + '通（' + q.pct + '%）／残り: ' + q.left + '通');
    out.push(q.left <= 0 ? '🔴 上限に到達＝以降の通知はすべて届きません'
           : q.pct >= 95 ? '🔴 残りわずか。今月中に上限へ到達する見込み'
           : q.pct >= 80 ? '⚠️ 8割を超過。用途別の内訳を確認してください（monthlyLineUsageReport）'
           : '✅ 余裕あり');
  }
  // 用途別の内訳（何が通数を食っているか）
  var u = estimateLineUsage();
  if (u.total) {
    out.push('--- 今月の送信内訳（既存データからの概算） ---');
    var keys = Object.keys(u.byPurpose).sort(function (a, b) { return u.byPurpose[b] - u.byPurpose[a]; });
    for (var i = 0; i < keys.length; i++) out.push('   ' + keys[i] + ': ' + u.byPurpose[keys[i]] + '通');
    out.push('   合計: ' + u.total + '通（概算）');
  }
  Logger.log(out.join('\n'));
  return q;
}

// ============================================================
// 送信通数のマネジメント
//   ①用途別に実績を記録（何を削れば効くかを数字で示す）
//   ②日次で残量を監視し、8割／9.5割でオーナーへ**メール**警告（メールは通数を消費しない）
// ============================================================
var LB_QUOTA_SHEET = 'quota_status';

// 用途別の送信通数を「既存データから再構成」する（読み取りのみ・月1回の実行を想定）。
//   ★1通ごとに記録する方式はやめた：予約完了フロー(Lock内)にシート往復が増え、顧客の待ち時間に直結するため。
//   リマインドは実測値(reminder_status)、予約系は台帳(line_reservations)の件数から概算する。
//   概算でよい理由＝この数字の用途は「どの通知を削れば効くか」の判断材料であり、請求根拠ではない。
function estimateLineUsage(ym) {
  var month = ym || Utilities.formatDate(new Date(), SETTINGS.TIMEZONE, 'yyyy-MM');
  var byPurpose = {}, notes = [];
  function add(k, n) { if (n) byPurpose[k] = (byPurpose[k] || 0) + n; }

  // ① 前日リマインド＝実測（sendLineReminders が毎回記録している）
  var rs = _lbSheet(LB_REMINDER_STATUS_SHEET);
  if (rs && rs.getLastRow() > 1) {
    var rv = rs.getRange(2, 1, rs.getLastRow() - 1, 3).getValues();
    for (var i = 0; i < rv.length; i++) {
      if (String(rv[i][0]).replace(/\//g, '-').indexOf(month) !== 0) continue;
      try { var d = JSON.parse(rv[i][2]); add('reminder_customer', Number(d.sent || 0)); add('reminder_trainer', Number(d.trainerSent || 0)); } catch (e) {}
    }
  } else { notes.push('リマインドの実測記録なし'); }

  // ② 予約・変更・取消＝台帳の件数×2（顧客＋担当トレーナーの2通）。トレーナーがLINE未登録なら過大になる。
  var sh = _lbSheet(LINE_BOOKING.RESV_SHEET);
  if (sh && sh.getLastRow() > 1) {
    var v = sh.getRange(2, 1, sh.getLastRow() - 1, 11).getValues();
    var booked = 0, cancelled = 0, changed = 0;
    for (var j = 0; j < v.length; j++) {
      var created = String(v[j][10] || '').replace(/\//g, '-');   // K=記録日時
      if (created.indexOf(month) !== 0) continue;
      booked++;
      var st = String(v[j][6]);
      if (st === 'cancelled' || st === 'consumed') cancelled++;
      else if (st === 'changed') changed++;
    }
    add('booking_customer', booked); add('booking_trainer', booked);
    add('cancel_customer', cancelled); add('cancel_trainer', cancelled);
    add('change_customer', changed); add('change_trainer', changed);
    notes.push('予約系は台帳件数×2の概算（トレーナー未登録分は過大）');
  }

  // ③ 予約を促すリマインド＝実測（nudge_log に1通1行で残る。sent の行だけ数える）
  //   これが無いと、quota が返す総数と内訳の合計がリマインド分だけ食い違い、
  //   「何が通数を食っているか」を内訳から判断できない（2026-10-02）。
  try {
    // シート名は Nudge.js で定義される。読み込み順に依存しないよう既定値を持つ。
    var nlName = (typeof LB_NUDGE_LOG_SHEET !== 'undefined') ? LB_NUDGE_LOG_SHEET : 'nudge_log';
    var nl = _lbSheet(nlName);
    if (nl && nl.getLastRow() > 1) {
      var nv = nl.getRange(2, 1, nl.getLastRow() - 1, 5).getValues();
      var nudged = 0;
      for (var n = 0; n < nv.length; n++) {
        var at = String(nv[n][0] || '').replace(/\//g, '-');
        if (at.indexOf(month) !== 0) continue;
        if (String(nv[n][4] || '') !== 'sent') continue;      // 未達は送ったことにしない
        var kind = String(nv[n][1] || 'nudge');
        add(kind, 1);
        nudged++;
      }
      if (!nudged) notes.push('リマインドの送信記録は当月0件');
    } else { notes.push('リマインドの送信記録なし（まだ送っていない／シート未作成）'); }
  } catch (eN) { notes.push('リマインドの記録を読めません: ' + eN.message); }

  var total = 0; for (var k in byPurpose) total += byPurpose[k];
  return { month: month, total: total, byPurpose: byPurpose, notes: notes, estimated: true };
}

// 通知の宛先メール（Script Property OWNER_EMAIL 優先・未設定なら実行アカウント）
function _lbAlertEmail() {
  var e = _lbProp('OWNER_EMAIL');
  if (e) return e;
  try { return Session.getEffectiveUser().getEmail(); } catch (e2) { return ''; }
}

// 日次：残量を監視し、閾値超過でメール警告（トリガーは setupLineTriggers）
//   ★警告をLINEで送ると、上限が近い状況で通数をさらに消費する。メールなら消費ゼロで確実に届く。
function checkLineQuota() {
  var q = _lbQuotaFetch();
  var tz = SETTINGS.TIMEZONE, now = new Date();
  var month = Utilities.formatDate(now, tz, 'yyyy-MM');
  var u = estimateLineUsage(month);
  // 記録（推移を残す＝増加ペースが見える）
  try {
    var ss = _lbSs(); var sh = ss.getSheetByName(LB_QUOTA_SHEET);
    if (!sh) { sh = ss.insertSheet(LB_QUOTA_SHEET); sh.getRange(1, 1, 1, 5).setValues([['日時', '上限', '送信済み', '残り', '内訳(自社計測)']]).setFontWeight('bold'); sh.setFrozenRows(1); }
    sh.appendRow(["'" + Utilities.formatDate(now, tz, 'yyyy/MM/dd HH:mm'),
      (q.ok && q.limited) ? q.limit : (q.ok ? '無制限' : '取得失敗'),
      q.ok ? q.used : '', (q.ok && q.limited) ? q.left : '',
      JSON.stringify(u.byPurpose).slice(0, 400)]);
  } catch (e) { Logger.log('quota_status記録失敗: ' + e.message); }
  if (!q.ok) { Logger.log('checkLineQuota: 取得失敗 ' + JSON.stringify(q).slice(0, 200)); return null; }
  if (!q.limited) { Logger.log('checkLineQuota: 無制限プラン（送信' + q.used + '通）'); return q; }

  // 共有は8割到達の1回だけ（オーナー方針 2026-09-15）。残1,000通＝数週間分あり、対処の時間は足りる。
  //   例外＝上限に到達した場合。これは「状況共有」ではなく通知が全停止する障害なので必ず知らせる。
  var level = (q.left <= 0) ? 100 : (q.pct >= 80 ? 80 : 0);
  Logger.log('checkLineQuota: ' + q.used + '/' + q.limit + '通（' + q.pct + '%）');
  if (!level) return q;
  var propKey = 'LB_QUOTA_ALERTED', seen = String(_lbProp(propKey) || '');
  var stamp = month + ':' + level;
  if (seen === stamp) return q;   // 通知済み
  var to = _lbAlertEmail();
  if (to) {
    var keys = Object.keys(u.byPurpose).sort(function (a, b) { return u.byPurpose[b] - u.byPurpose[a]; });
    var head = (level === 100)
      ? 'LINE公式アカウントの当月メッセージ通数が上限に達しました。\n★予約確定・変更・取消・前日リマインドのすべてが、今この瞬間から届いていません。\n'
      : 'LINE公式アカウントの当月メッセージ通数が ' + q.pct + '% に達しました。\n';
    var body = head + '\n'
      + '上限：' + q.limit + '通\n送信済み：' + q.used + '通\n残り：' + q.left + '通\n\n'
      + '【今月の送信内訳（既存データからの概算）】\n'
      + (keys.length ? keys.map(function (k) { return '・' + k + '：' + u.byPurpose[k] + '通'; }).join('\n') : '（記録なし）')
      + (level === 100
         ? '\n\n復旧するには上位プランへの変更が必要です（翌月1日には無料枠がリセットされます）。'
         : '\n\n上限に達すると、すべての通知が届かなくなります。'
           + '\n削減するなら、件数の多い用途から（顧客向けはメール／LIFF画面／リプライへの振替が可能です）。');
    var subject = (level === 100)
      ? '【🔴LINE通知が停止】当月の上限に到達（' + month + '）'
      : '【LINE通数 ' + q.pct + '%】残り' + q.left + '通（' + month + '）';
    try {
      GmailApp.sendEmail(to, subject, body);
      try { PropertiesService.getScriptProperties().setProperty(propKey, stamp); } catch (e3) {}
    } catch (e4) { Logger.log('通数警告メール失敗: ' + e4.message); }
  }
  return q;
}

// 用途別の内訳をメールで受け取る（手動実行 or 月初トリガー）。削る対象を数字で決めるための材料。
function monthlyLineUsageReport(ym) {
  var u = estimateLineUsage(ym), q = _lbQuotaFetch();
  var keys = Object.keys(u.byPurpose).sort(function (a, b) { return u.byPurpose[b] - u.byPurpose[a]; });
  var lines = ['【LINE送信内訳】' + u.month,
    (q.ok && q.limited) ? ('上限' + q.limit + '通 / 送信' + q.used + '通 / 残り' + q.left + '通') : (q.ok ? ('無制限プラン / 送信' + q.used + '通') : '通数の取得に失敗'),
    ''];
  for (var i = 0; i < keys.length; i++) lines.push('・' + keys[i] + '：' + u.byPurpose[keys[i]] + '通');
  lines.push('', '合計：' + u.total + '通（概算）');
  if (u.notes && u.notes.length) lines.push('※ ' + u.notes.join(' / '));
  var txt = lines.join('\n');
  Logger.log(txt);
  var to = _lbAlertEmail();
  if (to) { try { GmailApp.sendEmail(to, '【LINE送信内訳】' + u.month, txt); } catch (e) { Logger.log('内訳メール失敗: ' + e.message); } }
  return u;
}


// ============================================================
// カレンダーと台帳の突合（★読み取りのみ・削除も変更も一切しない）
//   キャンセル/変更時のカレンダー削除は失敗してもログに残るだけで自動回復しない。放置すると
//   「台帳では空いているのにカレンダーが埋まったまま」＝**その枠が二度と売れない**状態になる。
//   逆に「台帳にあるのにカレンダーに無い」は二重予約のリスク。両方向を洗い出す。
//   除外：[消化]（計上の証跡＝正常）／ブロック／出勤シフト／仮押さえ(channel：admin_hold＝台帳に書かない仕様)。
//   検出結果は「要確認リスト」。削除の判断は人が行う（手動作成の予定を誤って消さないため）。
// ============================================================
//   daysAhead を渡すと期間を延長できる（例 debugOrphanEvents(60)）。既定は予約窓の地平まで。
//   台帳には窓より先の予約が入りうる（同期の窓が広かった時期の取込など）ので、その整合も見たいときに使う。
function debugOrphanEvents(daysAhead) {
  var tz = SETTINGS.TIMEZONE, now = new Date();
  var endD = _lbBookingHorizonEnd(now);
  if (daysAhead && Number(daysAhead) > 0) {
    var ext = new Date(now.getTime() + Number(daysAhead) * 86400000);
    if (ext > endD) endD = ext;
  }
  // 照合キー＝開始時刻＋顧客名。名前の表記は経路によって揺れる：
  //   ・LINE予約  … 台帳「山田 太郎」／カレンダー「山田 太郎様」
  //   ・同期由来  … 台帳「今別府利江様」（カレンダーのcnameをそのまま記録）／カレンダー「今別府利江様様」
  //   末尾の敬称を**繰り返し**落とし、空白も除いて両側を同じ土俵に乗せる（_lbNormNameは様を1つしか外さない）。
  function nkey(name) { return String(name || '').replace(/\s+/g, '').replace(/様+$/, ''); }
  function key(d, name) { return Utilities.formatDate(d, tz, 'yyyyMMddHHmm') + '|' + nkey(name); }
  function label(d) { return Utilities.formatDate(d, tz, 'M/d HH:mm'); }
  function disp(name) { return String(name || '').replace(/様+$/, '') + '様'; }   // 表示は敬称1つに畳む
  // カレンダー起点の予約（同期・手動紐付け）は、システムがトレーナーcalに✅を作らない＝④の対象外。
  var CAL_ORIGIN = { 'calendar_sync': 1, 'manual_link': 1 };
  var out = ['=== カレンダーと台帳の突合 ' + Utilities.formatDate(now, tz, 'yyyy/MM/dd HH:mm') + '（読み取りのみ）==='];
  out.push('対象期間：' + Utilities.formatDate(now, tz, 'yyyy/MM/dd') + ' 〜 ' + Utilities.formatDate(endD, tz, 'yyyy/MM/dd'));

  // ---- 台帳（未来の confirmed）----
  var ledger = {}, ledgerList = [];
  var sh = _lbSheet(LINE_BOOKING.RESV_SHEET);
  if (sh && sh.getLastRow() > 1) {
    var v = sh.getRange(2, 1, sh.getLastRow() - 1, 11).getValues();
    for (var i = 0; i < v.length; i++) {
      if (String(v[i][6]) !== 'confirmed') continue;
      var dt = _lbParseResvDate(v[i][0]);
      if (!dt || dt < now || dt > endD) continue;
      var k = key(dt, v[i][1]);
      ledger[k] = { dt: dt, name: String(v[i][1]), trainerId: String(v[i][4]), trainerName: String(v[i][5]), channel: String(v[i][9] || '') };
      ledgerList.push(k);
    }
  }
  out.push('台帳の確定予約：' + ledgerList.length + '件');

  var surToId = {}; for (var t = 0; t < CALENDAR_IDS.TRAINERS.length; t++) { surToId[_lbNormTok(CALENDAR_IDS.TRAINERS[t].name.split(' ')[0])] = CALENDAR_IDS.TRAINERS[t].id; }

  // ---- ① 施設calに予定があるのに台帳に無い ----
  //   走査対象は同期と同じ B1＋1F。1Fを見ないと「オンライン等で1Fに置いた予約」が全部欠落扱いになる。
  var orphan = [], manual = [], rental = [], hold = 0, calSeen = {}, calWhere = {}, b1Count = 0, f1Count = 0;
  // 同時刻に「解析できない予定」が居るかを見るための素データ（[消化]・ブロック・タイトル非公開なども全部拾う）。
  //   ②の原因が「予定が消えた」のか「タイトルが読めないだけ」なのかは、これが無いと切り分けられない。
  var slotAny = {};
  var targets = [{ id: CALENDAR_IDS.CAPACITY_B1, name: 'B1' }, { id: CALENDAR_IDS.CAPACITY_1F, name: '1F' }];
  for (var ci = 0; ci < targets.length; ci++) {
    var cal = null; try { cal = CalendarApp.getCalendarById(targets[ci].id); } catch (eX) { cal = null; }
    if (!cal) continue;
    var copts = { b1Id: CALENDAR_IDS.CAPACITY_B1, oneFId: CALENDAR_IDS.CAPACITY_1F, surToId: surToId, isMember: function () { return false; } };
    var evs = cal.getEvents(now, endD);
    for (var e = 0; e < evs.length; e++) {
      var ttl = String(evs[e].getTitle());
      var _sk = Utilities.formatDate(evs[e].getStartTime(), tz, 'yyyyMMddHHmm');
      (slotAny[_sk] = slotAny[_sk] || []).push(targets[ci].name + ':' + (ttl || '(タイトルなし)'));
      if (ttl.indexOf('[消化]') === 0) continue;                 // 計上の証跡＝正常
      var cls = _lbClassifyBooking(ttl, targets[ci].id, copts);
      // ★照合対象＝台帳に載りうる予約すべて。isSessionKind（残数を消化する種別）で切ってはいけない：
      //   レンタルは残数を消化しないが会員契約として台帳に載るため、除外すると全件が②に誤検知される。
      //   台帳に載らないのは体験・カウンセリング（非会員・枠確保のみ）＝ここだけ外す。
      if (!cls.parsed) continue;                                   // ブロック/出勤シフト/休憩など
      if (cls.mode === 'trial' || cls.mode === 'consultation') continue;
      var st = evs[e].getStartTime();
      var kk = key(st, cls.cname);
      if (!calSeen[kk]) { calSeen[kk] = true; calWhere[kk] = targets[ci].name; if (targets[ci].name === 'B1') b1Count++; else f1Count++; }
      if (ledger[kk]) continue;                                   // 正常（台帳と一致）
      var desc = ''; try { desc = String(evs[e].getDescription() || ''); } catch (eD) {}
      if (desc.indexOf('admin_hold') >= 0) { hold++; continue; }   // 未登録客の枠確保＝台帳に書かない仕様
      if (cls.mode === 'rental') { rental.push(label(st) + ' ' + disp(cls.cname) + '（' + targets[ci].name + '）'); continue; }   // 非会員の場所貸し＝台帳に載らなくて正常
      if (desc.indexOf('channel') < 0) { manual.push(label(st) + ' ' + disp(cls.cname) + '（' + targets[ci].name + '）'); continue; }
      orphan.push(label(st) + ' ' + disp(cls.cname) + '（' + cls.kind + '_' + cls.sur + '／' + targets[ci].name + '）');
    }
  }
  out.push('施設カレンダーの予約：B1 ' + b1Count + '件／1F ' + f1Count + '件');

  // ---- ③④ トレーナーカレンダー（②の材料にも使うので先に集める）----
  var orphanTr = [], missingTr = [], trSeen = {}, trAny = {};
  for (var ti = 0; ti < CALENDAR_IDS.TRAINERS.length; ti++) {
    var tr = CALENDAR_IDS.TRAINERS[ti];
    if (!tr.email) continue;
    var tcal = null; try { tcal = CalendarApp.getCalendarById(tr.email); } catch (eC) { tcal = null; }
    if (!tcal) continue;
    var tEvs = tcal.getEvents(now, endD);
    for (var x = 0; x < tEvs.length; x++) {
      var tt = String(tEvs[x].getTitle());
      if (tt.indexOf('[消化]') === 0) continue;
      var _tk = Utilities.formatDate(tEvs[x].getStartTime(), tz, 'yyyyMMddHHmm');
      if (tt.indexOf('出勤') < 0 && tt.indexOf('休憩') < 0) (trAny[_tk + '|' + tr.id] = trAny[_tk + '|' + tr.id] || []).push(tt);
      if (tt.indexOf('✅') !== 0 || tt.indexOf('_line') < 0) continue;   // システムが作る予約本体のみ
      var nm = tt.replace(/^✅\s*/, '').split('｜')[0];
      var kt = key(tEvs[x].getStartTime(), nm);
      trSeen[kt] = true;
      if (!ledger[kt]) orphanTr.push(label(tEvs[x].getStartTime()) + ' ' + disp(nm) + '（' + tr.name + '）');
    }
  }
  for (var y = 0; y < ledgerList.length; y++) {
    var L2 = ledger[ledgerList[y]];
    if (CAL_ORIGIN[L2.channel]) continue;          // カレンダー起点＝システムは✅を作らない（正常）
    if (!calSeen[ledgerList[y]]) continue;         // 施設calにも無いものは②で扱う（二重計上しない）
    if (!trSeen[ledgerList[y]]) missingTr.push(label(L2.dt) + ' ' + disp(L2.name) + '（' + L2.trainerName + '／channel=' + (L2.channel || '不明') + '）');
  }

  // ---- ② 台帳にあるのに施設calに予定が無い（原因の切り分け材料つき）----
  var missing = [];
  for (var m = 0; m < ledgerList.length; m++) {
    if (calSeen[ledgerList[m]]) continue;
    var L = ledger[ledgerList[m]];
    var sk = Utilities.formatDate(L.dt, tz, 'yyyyMMddHHmm');
    var near = slotAny[sk] ? ('同時刻の施設cal＝' + slotAny[sk].join(' / ')) : '同時刻の施設cal＝空';
    var trh = trAny[sk + '|' + L.trainerId];
    var trTxt = trh ? ('担当cal＝' + trh.join(' / ')) : '担当cal＝空';
    missing.push(label(L.dt) + ' ' + disp(L.name) + '（担当' + L.trainerName + '／channel=' + (L.channel || '不明') + '）\n        ' + near + '／' + trTxt);
  }

  function section(title, arr, note) {
    out.push('');
    out.push(title + '：' + arr.length + '件' + (arr.length ? '' : ' ✅'));
    for (var i = 0; i < Math.min(arr.length, 30); i++) out.push('   ・' + arr[i]);
    if (arr.length > 30) out.push('   …ほか' + (arr.length - 30) + '件');
    if (arr.length && note) out.push('   → ' + note);
  }
  section('① 施設calに予定があるのに台帳に無い【枠が売れない】', orphan, 'キャンセル/変更時の削除漏れの疑い。内容を確認のうえカレンダーから削除してください');
  section('② 台帳にあるのに施設calに予定が無い【二重予約のリスク】', missing, '別の顧客に同じ枠が売れてしまいます。カレンダーへ復元するか、台帳側を取消にしてください');
  section('③ トレーナーcalに✅が残っているが台帳に無い', orphanTr, 'トレーナーの画面上だけ埋まって見えます。削除してください');
  section('④ システム作成の予約なのに担当calに✅が無い', missingTr, 'トレーナーが予定を見落とします。担当カレンダーへ追加してください');
  out.push('');
  out.push('参考：仮押さえ(admin_hold) ' + hold + '件は正常（台帳に書かない仕様）');
  if (rental.length) out.push('参考：台帳に無いレンタル ' + rental.length + '件 ＝ 非会員の場所貸しなら正常（会員のレンタルなら未同期）');
  if (manual.length) {
    out.push('参考：手動作成（channel記録なし）' + manual.length + '件 ＝ Googleカレンダー直接編集の可能性。①とは区別しています');
    for (var mi = 0; mi < Math.min(manual.length, 10); mi++) out.push('   ・' + manual[mi]);
  }
  var txt = out.join('\n');
  Logger.log(txt);
  return { orphanB1: orphan, missingB1: missing, orphanTrainer: orphanTr, missingTrainer: missingTr, hold: hold, manual: manual, rental: rental };
}

// 突合を期間指定で回すラッパー（★GASエディタの実行ボタンは引数を渡せないため必要）。
//   既定90日先まで＝予約窓より先に入っている予約（同期の窓が広かった時期の取込）の整合も確認できる。
//   期間を変えたいときは下の daysAhead を書き換えて実行する。
function runOrphanCheck() {
  var daysAhead = 90;   // ← 何日先まで突合するか
  return debugOrphanEvents(daysAhead);
}

// ============================================================
// 消化ペースの把握（★読み取りのみ・送信しない）
//   月額は「月内に使い切れるか」、チケットは「期限までに使い切れるか」で、間に合わない会員を洗い出す。
//   使い切れない＝顧客は払った分を受け取れず、トレーナーは実施報酬を得られず、継続率も落ちる。
//   ※この関数は数字を出すだけ。誰にどう伝えるかは別途（トレーナー週次メール／顧客通知）。
//   pace = 残りを消化するために必要な「週あたり回数」。週2回を超えると現実的に厳しい＝要フォロー。
// ============================================================
// 月額の理想ペース＝契約回数を4週で割った「週あたり回数」。
//   月4回＝週1回／月8回＝週2回／月2回＝2週に1回。オーナー方針（2026-09-17）：
//   目的は「間に合わせる」ことではなく**均等に通う習慣をつくる**こと。月末に偏る消化を避ける。
//   月に週が5回ある月は、4週分のペースで通えば月末前に契約回数へ到達する＝自然に余裕が生まれる
//   （あるべき消化数を契約回数で頭打ちにすることで表現）。
//   戻り値 behind＝「今この時点で何回分の遅れか」。1回以上で要フォロー、2回以上で深刻。
function _lbMonthlyPace(quota, carryover, used, dayNow) {
  var q = Number(quota || 0), carry = Number(carryover || 0), u = Number(used || 0);
  if (q <= 0) return { weekly: 0, should: 0, behind: 0 };
  var weekly = q / 4;                                   // 週あたりの理想回数
  var weeksElapsed = Math.max(0, Number(dayNow || 0)) / 7;
  var should = Math.min(q + carry, weekly * weeksElapsed);   // あるべき消化数（契約回数＋繰越で頭打ち）
  var behind = Math.max(0, should - u);
  return { weekly: Math.round(weekly * 100) / 100, should: Math.round(should * 10) / 10, behind: Math.round(behind * 10) / 10 };
}
// チケットの最低ライン＝**月1回**（回数券の有効期限は「枚数＝ヶ月」で設計されているため）。
//   顧客ごとに目指すペースは違うので踏み込まず、「月1回ペースで期限までに使い切れるか」だけを見る。
//   needPerMonth > 1 ＝ 月1回では間に合わない＝失効の恐れあり。期限切れ後は残数がそのまま遅れ。
function _lbTicketPace(remaining, expireMs, nowMs) {
  var rem = Number(remaining || 0);
  if (rem <= 0) return { monthsLeft: null, needPerMonth: 0, behind: 0 };
  if (!expireMs) return { monthsLeft: null, needPerMonth: 0, behind: 0 };   // 期限なし＝失効しない
  var monthsLeft = (Number(expireMs) - Number(nowMs)) / (30.44 * 86400000);
  if (monthsLeft <= 0) return { monthsLeft: 0, needPerMonth: rem, behind: rem };
  return { monthsLeft: Math.round(monthsLeft * 10) / 10,
           needPerMonth: Math.round(rem / monthsLeft * 10) / 10,
           behind: Math.round(Math.max(0, rem - monthsLeft) * 10) / 10 };
}
//   freshContracts=true なら契約の記憶を捨てて最新を読む（診断用・数十秒かかる）。
//   画面から呼ぶときは false＝記憶を活かす（応答速度を優先。1時間以内の契約変更は次の更新で反映）。
function _lbCollectPace(freshContracts) {
  var tz = SETTINGS.TIMEZONE, now = new Date();
  if (freshContracts) { try { CacheService.getScriptCache().remove('lb_contract_all'); } catch (e) {} }
  var monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
  var daysInMonth = monthEnd.getDate(), dayNow = now.getDate();
  var daysLeftInMonth = Math.max(0, daysInMonth - dayNow);
  var elapsedPct = Math.round(dayNow / daysInMonth * 100);

  var monthly = [], ticket = [], done = [], checked = 0, members = 0;
  var broken = [], noContract = [], typeCount = { monthly: 0, ticket: 0, both: 0 };
  var ticketDone = 0;
  var mapSh = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (mapSh && mapSh.getLastRow() > 1) {
    var mv = mapSh.getRange(2, 1, mapSh.getLastRow() - 1, MAP_COL.NOTE).getValues();
    for (var i = 0; i < mv.length; i++) {
      if (String(mv[i][MAP_COL.AUTH_STATE - 1]) !== 'verified') continue;
      var nm = String(mv[i][MAP_COL.NAME - 1] || ''); if (!nm) continue;
      var cid = String(mv[i][MAP_COL.CUSTOMER_ID - 1] || '');
      var tid = String(mv[i][MAP_COL.TRAINER_ID - 1] || '');   // 担当（週次レポートを担当別に配るのに使う）
      members++;
      var h; try { h = _lbBuildHome(cid, nm); } catch (e) { broken.push(nm); continue; }
      if (h && h.reviewRequired) { broken.push(nm); continue; }        // 残数を確定できない＝データ不備（debugDataHealthの担当）
      if (!h || !h.type) { noContract.push(nm); continue; }            // 契約が見つからない＝退会・契約切れ・氏名不一致
      checked++;
      if (h.type === 'monthly') typeCount.monthly++;
      else if (h.type === 'ticket') typeCount.ticket++;
      else if (h.type === 'both') typeCount.both++;
      // 月額：今月の枠を月内に使い切れるか（繰越込みの残数を使う）
      if (h.type === 'monthly' || h.type === 'both') {
        var rem = (h.monthlyRemaining != null) ? Number(h.monthlyRemaining) : Math.max(0, Number(h.quota || 0) - Number(h.thisMonth || 0));
        var usedPct = (Number(h.quota || 0) + Number(h.carryover || 0)) > 0
          ? Math.round(Number(h.thisMonth || 0) / (Number(h.quota || 0) + Number(h.carryover || 0)) * 100) : 0;
        if (rem > 0) {
          var mp = _lbMonthlyPace(h.quota, h.carryover, h.thisMonth, dayNow);
          monthly.push({ name: nm, trainerId: tid, rem: rem, quota: Number(h.quota || 0), used: Number(h.thisMonth || 0),
            carry: Number(h.carryover || 0), usedPct: usedPct,
            weekly: mp.weekly, should: mp.should, behind: mp.behind });
        } else { done.push(nm + '（月額を消化済み）'); }
      }
      // チケット：有効期限までに使い切れるか
      if (h.type === 'ticket' || h.type === 'both') {
        var tRem = Number((h.type === 'ticket') ? h.remaining : h.ticketRemaining) || 0;
        var expMs = (h.type === 'ticket') ? h.expireMs : h.ticketExpireMs;
        if (tRem > 0) {
          var dLeft = expMs ? Math.ceil((Number(expMs) - now.getTime()) / 86400000) : null;
          var tp = _lbTicketPace(tRem, expMs, now.getTime());
          ticket.push({ name: nm, trainerId: tid, rem: tRem, daysLeft: dLeft,
            expire: expMs ? Utilities.formatDate(new Date(Number(expMs)), tz, 'M/d') : '期限なし',
            monthsLeft: tp.monthsLeft, needPerMonth: tp.needPerMonth, behind: tp.behind });
        } else { ticketDone++; }   // 使い切り済み（ここを数えないと合計が合わない）
      }
    }
  }
  // 遅れている順に並べる（均等ペースからの乖離が大きい順）
  monthly.sort(function (a, b) { return b.behind - a.behind; });
  ticket.sort(function (a, b) { return b.needPerMonth - a.needPerMonth; });
  return { month: { elapsedPct: elapsedPct, daysLeft: daysLeftInMonth, dayNow: dayNow, daysInMonth: daysInMonth },
           monthly: monthly, ticket: ticket, done: done.length, checked: checked,
           // 内訳（合計が合うように、会員数と行数を分けて持つ）
           members: members, typeCount: typeCount, monthlyDone: done.length, ticketDone: ticketDone,
           broken: broken, noContract: noContract };
}

// GASエディタから実行して全体を眺める（読み取りのみ・契約は最新を読む）
function debugConsumptionPace() {
  var tz = SETTINGS.TIMEZONE, now = new Date();
  var r = _lbCollectPace(true);
  var monthly = r.monthly, ticket = r.ticket, done = r.done, checked = r.checked;
  var out = ['=== 消化ペース ' + Utilities.formatDate(now, tz, 'yyyy/MM/dd') + '（読み取りのみ）==='];
  out.push('今月の経過：' + r.month.dayNow + '/' + r.month.daysInMonth + '日（' + r.month.elapsedPct + '%）／残り' + r.month.daysLeft + '日');
  var th = _lbPaceThresholds();
  function markM(behind) { return behind >= th.alert ? '🔴' : behind >= th.warn ? '⚠️' : '　'; }
  function markT(y) { return (y.daysLeft != null && y.daysLeft <= 30) ? '🔴' : (y.needPerMonth > 1 ? '⚠️' : '　'); }
  out.push('');
  out.push('【月額】残数がある会員：' + monthly.length + '名（遅れの大きい順）');
  for (var m = 0; m < monthly.length; m++) {
    var x = monthly[m];
    out.push('  ' + markM(x.behind) + ' ' + x.name + '様　月' + x.quota + '回（週' + x.weekly + '回ペース）' + (x.carry ? '＋繰越' + x.carry : '') +
      '／今月' + x.used + '回（本来' + x.should + '回）' + (x.behind > 0 ? '　→ ' + x.behind + '回分の遅れ' : '　→ 予定どおり') + '　残' + x.rem + '回');
  }
  out.push('');
  out.push('【チケット】残枚数がある会員：' + ticket.length + '名（月1回ペースで間に合わない順）');
  for (var t = 0; t < ticket.length; t++) {
    var y = ticket[t];
    out.push('  ' + markT(y) + ' ' + y.name + '様　残' + y.rem + '回／期限' + y.expire +
      (y.daysLeft != null ? '（あと' + y.daysLeft + '日）' : '（期限なし）') +
      (y.needPerMonth > 0 ? '　→ 月' + y.needPerMonth + '回ペースが必要' + (y.needPerMonth > 1 ? '（月1回では間に合いません）' : '') : ''));
  }
  out.push('');
  out.push('会員' + r.members + '名を集計：残数を算出できた' + checked + '名（月額' + r.typeCount.monthly + '／チケット' + r.typeCount.ticket + '／併用' + r.typeCount.both + '）');
  out.push('　今月の月額を使い切り：' + r.monthlyDone + '名／チケットを使い切り：' + r.ticketDone + '名');
  if (r.noContract.length) out.push('　契約が見つからない：' + r.noContract.length + '名（' + r.noContract.slice(0, 8).join(', ') + '）＝退会・契約切れなら正常');
  if (r.broken.length) out.push('　⚠️ 残数を確定できない：' + r.broken.length + '名（' + r.broken.slice(0, 8).join(', ') + '）→ debugDataHealth / runRemainingDebug で原因を特定してください');
  out.push('※月額＝均等ペース（月4回なら週1回）に対する遅れで判定。🔴' + th.alert + '回以上／⚠️' + th.warn + '回以上の遅れ');
  out.push('※チケット＝最低ライン月1回。🔴期限30日以内に残あり／⚠️月1回では間に合わない');
  var txt = out.join('\n');
  Logger.log(txt);
  return r;
}

// ============================================================
// 消化ペースのダッシュボード（LIFFのトレーナー管理画面から参照）
//   通知は流れて消えるが、画面はいつでも見られる。トレーナーは自分の担当だけ、
//   オーナー/管理者は全員を見る（越権防止と情報量の最適化を兼ねる）。
//   契約の記憶を活かして応答を優先（診断=debugConsumptionPaceは最新を読み直す）。
// ============================================================
// ★画面から全会員の残数を計算し直してはいけない（33名で60秒級＝LIFFの20秒制限を超える）。
//   集計は1日1回まとめて行い（refreshPaceBoard）、シートに書き出す。画面はそれを読むだけ＝一瞬。
//   「いつ時点の数字か」を必ず一緒に返す（古い数字を最新だと誤解させない）。
var LB_PACE_SHEET = 'pace_board';
// ★シートに日時を「文字列」で書いてもスプレッドシートが日付型に変換して保存するため、
//   読み戻すと "Thu Sep 17 2026 18:53:00 GMT+0900 (日本標準時)" になる。
//   **シートから読んだ日時を画面やメールに出すときは、必ずこの関数を通すこと。**
//   書き出し側でも先頭に ' を付けて文字列固定するが、既存データを救うため読む側でも吸収する。
// 日時を「9/25(金) 16:00」の形で返す。
//   ★Utilities.formatDate の 'E'/'EEE' はロケール依存で「Fri」と英語になるため使わない。
//     日本語の曜日は必ずこの関数（または同等の配列）を通す。
function _lbFmtWhenJa(d, withTime) {
  // instanceof は実行コンテキストが違うと false になる（検証環境など）。振る舞いで判定する。
  if (!d || typeof d.getTime !== 'function' || isNaN(d.getTime())) return '';
  var tz = SETTINGS.TIMEZONE;
  var w = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return Utilities.formatDate(d, tz, 'M/d') + '(' + w + ')' + (withTime === false ? '' : ' ' + Utilities.formatDate(d, tz, 'HH:mm'));
}
// 「09/25(金) 16:00」の形（診断ログ用・月日ゼロ埋め）
function _lbFmtWhenJaPad(d) {
  if (!d || typeof d.getTime !== 'function' || isNaN(d.getTime())) return '';
  var tz = SETTINGS.TIMEZONE;
  var w = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return Utilities.formatDate(d, tz, 'MM/dd') + '(' + w + ') ' + Utilities.formatDate(d, tz, 'HH:mm');
}
function _lbFmtSheetDate(v, fmt) {
  var f = fmt || 'yyyy/MM/dd HH:mm';
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : Utilities.formatDate(v, SETTINGS.TIMEZONE, f);
  var t = String(v == null ? '' : v).replace(/^'/, '');
  if (!t) return '';
  // 生のDate文字列（Thu Sep 17 2026 …）や ISO/スラッシュ日付が入っている行も整形して救う
  if (/GMT|^[A-Z][a-z]{2}\s[A-Z][a-z]{2}\s\d|^\d{4}[-/]\d{1,2}[-/]\d{1,2}T/.test(t)) {
    var d = new Date(t);
    if (!isNaN(d.getTime())) return Utilities.formatDate(d, SETTINGS.TIMEZONE, f);
  }
  return t;   // 既に「2026/09/17 18:53」等の表示用文字列ならそのまま
}
function _lbFmtExpireCell(v) { return _lbFmtSheetDate(v, 'M/d'); }
var LB_PACE_COLS = ['更新時刻', '種別', '担当', '氏名', '契約回数', '週ペース', '今月消化', '本来', '遅れ', '残', '期限', '期限まで日数', '必要月ペース', '判定'];

// 集計してシートへ書き出す（日次トリガー。GASエディタから手動実行も可）
function refreshPaceBoard() {
  var tz = SETTINGS.TIMEZONE, now = new Date();
  var r = _lbCollectPace(true);
  var th = _lbPaceThresholds();
  var stamp = Utilities.formatDate(now, tz, 'yyyy/MM/dd HH:mm');
  var rows = [];
  var stampCell = "'" + stamp;   // 先頭の ' で文字列として固定（表示には出ない）
  for (var i = 0; i < r.monthly.length; i++) {
    var x = r.monthly[i];
    rows.push([stampCell, 'monthly', x.trainerId || '', x.name, x.quota, x.weekly, x.used, x.should, x.behind, x.rem, '', '', '',
      (x.behind >= th.alert ? 'alert' : (x.behind >= th.warn ? 'warn' : 'ok'))]);
  }
  for (var j = 0; j < r.ticket.length; j++) {
    var y = r.ticket[j];
    var urgent = (y.daysLeft != null && y.daysLeft <= 30);
    rows.push([stampCell, 'ticket', y.trainerId || '', y.name, '', '', '', '', y.behind, y.rem, "'" + y.expire,
      (y.daysLeft == null ? '' : y.daysLeft), y.needPerMonth, (urgent ? 'alert' : (y.needPerMonth > 1 ? 'warn' : 'ok'))]);
  }
  var ss = _lbSs();
  var sh = ss.getSheetByName(LB_PACE_SHEET);
  if (!sh) { sh = ss.insertSheet(LB_PACE_SHEET); }
  sh.clear();
  sh.getRange(1, 1, 1, LB_PACE_COLS.length).setValues([LB_PACE_COLS]).setFontWeight('bold');
  sh.setFrozenRows(1);
  if (rows.length) sh.getRange(2, 1, rows.length, LB_PACE_COLS.length).setValues(rows);
  // 月の進み具合と全体件数はA1メモとして別行に持たず、プロパティに保存（画面の説明文に使う）
  try {
    PropertiesService.getScriptProperties().setProperty('LB_PACE_META', JSON.stringify({
      stamp: stamp, dayNow: r.month.dayNow, daysInMonth: r.month.daysInMonth,
      elapsedPct: r.month.elapsedPct, daysLeft: r.month.daysLeft, checked: r.checked, done: r.done,
      members: r.members, typeCount: r.typeCount, monthlyDone: r.monthlyDone, ticketDone: r.ticketDone,
      brokenCount: r.broken.length, brokenNames: r.broken.slice(0, 20),
      noContractCount: r.noContract.length, noContractNames: r.noContract.slice(0, 20)
    }));
  } catch (e) { Logger.log('pace metaの保存に失敗: ' + e.message); }
  Logger.log('refreshPaceBoard: ' + rows.length + '行を書き出し（' + stamp + '）');
  return { rows: rows.length, stamp: stamp, checked: r.checked };
}

// ============================================================
// 消化ペースのダッシュボード（LIFFのトレーナー管理画面から参照）
//   ★書き出し済みのシートを読むだけ＝応答は一瞬。再計算はしない。
//   トレーナーは自分の担当だけ、オーナー/管理者は全員（越権防止と情報量の最適化）。
// ============================================================
function getPaceBoard(lineUserId) {
  var tr = requireTrainer(lineUserId);
  if (!tr) return { success: false, code: 'FORBIDDEN', message: 'トレーナーのみ利用できます。' };
  var isOwner = _lbIsOwnerRole(tr);
  var sh = _lbSheet(LB_PACE_SHEET);
  if (!sh || sh.getLastRow() < 2) {
    return { success: true, isOwner: isOwner, trainerName: tr.name, stale: true, stamp: '',
             month: null, monthly: [], ticket: [], checked: 0, done: 0,
             message: '集計がまだありません。オーナーに集計の実行（refreshPaceBoard）をご依頼ください。' };
  }
  var v = sh.getRange(2, 1, sh.getLastRow() - 1, LB_PACE_COLS.length).getValues();
  var monthly = [], ticket = [], stamp = '';
  for (var i = 0; i < v.length; i++) {
    var row = v[i];
    stamp = _lbFmtSheetDate(row[0]) || stamp;
    if (!isOwner && String(row[2] || '') !== String(tr.trainerId)) continue;   // 自分の担当だけ
    if (String(row[1]) === 'monthly') {
      monthly.push({ name: String(row[3]), quota: Number(row[4] || 0), weekly: Number(row[5] || 0),
        used: Number(row[6] || 0), should: Number(row[7] || 0), behind: Number(row[8] || 0),
        rem: Number(row[9] || 0), level: String(row[13] || 'ok') });
    } else {
      ticket.push({ name: String(row[3]), rem: Number(row[9] || 0), expire: _lbFmtExpireCell(row[10]),
        daysLeft: (row[11] === '' ? null : Number(row[11])), needPerMonth: Number(row[12] || 0),
        level: String(row[13] || 'ok') });
    }
  }
  monthly.sort(function (a, b) { return b.behind - a.behind; });
  ticket.sort(function (a, b) { return b.needPerMonth - a.needPerMonth; });
  var meta = {}; try { meta = JSON.parse(_lbProp('LB_PACE_META') || '{}'); } catch (e) { meta = {}; }
  return { success: true, isOwner: isOwner, trainerName: tr.name, stamp: stamp || meta.stamp || '',
           month: (meta.dayNow ? { dayNow: meta.dayNow, daysInMonth: meta.daysInMonth, elapsedPct: meta.elapsedPct, daysLeft: meta.daysLeft } : null),
           monthly: monthly, ticket: ticket, checked: Number(meta.checked || 0), done: Number(meta.done || 0),
           // 内訳（合計が合うように会員数と行数を分けて返す）。集計できなかった方はオーナーにだけ知らせる。
           stats: { members: Number(meta.members || 0), typeCount: meta.typeCount || null,
                    monthlyDone: Number(meta.monthlyDone || 0), ticketDone: Number(meta.ticketDone || 0),
                    brokenCount: Number(meta.brokenCount || 0), noContractCount: Number(meta.noContractCount || 0),
                    brokenNames: (isOwner ? (meta.brokenNames || []) : []),
                    noContractNames: (isOwner ? (meta.noContractNames || []) : []) },
           thresholds: _lbPaceThresholds() };
}

// 点検結果をダッシュボードへ（★オーナー限定＝他担当の顧客名や全体の不備を一般トレーナーに見せない）
//   書き出し済みの health_status を読むだけ＝一瞬。点検そのものは1日1回だけ走る。
function getHealthBoard(lineUserId) {
  var tr = requireTrainer(lineUserId);
  if (!tr) return { success: false, code: 'FORBIDDEN', message: 'トレーナーのみ利用できます。' };
  if (!_lbIsOwnerRole(tr)) return { success: false, code: 'OWNER_ONLY', message: 'この画面はオーナーのみ閲覧できます。' };
  var sh = _lbSheet(LB_HEALTH_SHEET);
  if (!sh || sh.getLastRow() < 2) {
    return { success: true, stamp: '', issues: [], message: '点検の記録がまだありません。dailyHealthCheck を1回実行してください。' };
  }
  var last = Math.min(sh.getLastRow() - 1, 60);   // 直近分だけ読む（履歴は全部シートに残る）
  var v = sh.getRange(2, 1, last, LB_HEALTH_COLS.length).getValues();
  var stamp = _lbFmtSheetDate(v[0][0]), issues = [];
  for (var i = 0; i < v.length; i++) {
    if (_lbFmtSheetDate(v[i][0]) !== stamp) break;   // 最新の点検分だけを返す
    if (String(v[i][2]) === 'ok') continue;
    issues.push({ area: String(v[i][1]), severity: String(v[i][2]), count: Number(v[i][3] || 0), detail: String(v[i][4] || '') });
  }
  // ★ high の重みは 0。|| を使うと 0 が falsy と判定されて最後尾に落ちる（実際に落ちていた）。
  var order = { high: 0, warn: 1, info: 2 };
  function rank(sev) { var v = order[sev]; return (v === undefined) ? 9 : v; }
  issues.sort(function (a, b) { return rank(a.severity) - rank(b.severity); });
  return { success: true, stamp: stamp, issues: issues,
           counts: { high: issues.filter(function (x) { return x.severity === 'high'; }).length,
                     warn: issues.filter(function (x) { return x.severity === 'warn'; }).length,
                     info: issues.filter(function (x) { return x.severity === 'info'; }).length } };
}

// ============================================================
// 契約（顧客マスタ）の修正を会員の表示へ即時反映する
//   契約フォームは重い読み込みのため1時間キャッシュしている。修正しても既定では
//   最大1時間反映されない。店頭で直した直後に「残数が違う」と言われないよう、
//   キャッシュを捨てて読み直す入口を用意する（GASエディタ／トレーナー画面の両方から）。
//   ★残数そのものは保存していない＝契約を読み直せば即座に正しくなる。
// ============================================================
//   ★画面から呼ぶ経路で契約を読み直してはいけない（実測59秒＝LIFFの20秒制限を超える）。
//     キャッシュを捨てるのは一瞬。読み直しは1秒後のトリガーに逃がし、裏で温める。
function refreshContractCache(warmNow) {
  try { CacheService.getScriptCache().remove('lb_contract_all'); } catch (e) {}
  var sh = _lbContractSheet();
  var rows = (sh && sh.getLastRow() > 1) ? (sh.getLastRow() - 1) : 0;
  if (warmNow) {
    try { _lbFindContract('__warmup__'); } catch (e) {}   // GASエディタから実行するとき用（時間がかかってよい）
  }
  Logger.log('契約情報を読み直しました（' + rows + '件）。会員の残数表示に即時反映されます。');
  return { success: true, rows: rows };
}

// ============================================================
// 予約台帳の line_user_id（D列）を会員情報から埋め直す（★dryRun既定）
//   症状：トレーナー画面には予約が出るのに、本人のマイ予約に出ない。
//   原因：D列が空 or 古いまま。本人未登録の時点で同期された予約や、二重登録の統合で発生する。
//   customer_id（C列）は正しいので、そこから会員のLINE IDを引いて埋める。
//   ※ customer_line_map に verified で存在する会員だけを対象にする（勝手な推測はしない）。
// ============================================================
function repairReservationLineIds(dryRun) {
  var sh = _lbSheet(LINE_BOOKING.RESV_SHEET);
  if (!sh || sh.getLastRow() < 2) { Logger.log('line_reservations が空です'); return { fixed: 0 }; }
  // customerId → lineUserId（verifiedのみ）
  var cid2lu = {};
  var map = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (map && map.getLastRow() > 1) {
    var mv = map.getRange(2, 1, map.getLastRow() - 1, MAP_COL.NOTE).getValues();
    for (var i = 0; i < mv.length; i++) {
      if (String(mv[i][MAP_COL.AUTH_STATE - 1]) !== 'verified') continue;
      var c = String(mv[i][MAP_COL.CUSTOMER_ID - 1] || ''), l = String(mv[i][MAP_COL.LINE_USER_ID - 1] || '');
      if (c && l) cid2lu[c] = l;
    }
  }
  var v = sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues();
  var targets = [];
  for (var j = 0; j < v.length; j++) {
    var cid = String(v[j][2] || ''), lu = String(v[j][3] || '');
    if (!cid || !cid2lu[cid]) continue;
    if (lu === cid2lu[cid]) continue;        // 既に正しい
    targets.push({ row: j + 2, name: String(v[j][1]), when: _lbFmtSheetDate(v[j][0], 'M/d HH:mm'),
                   from: (lu || '(空)'), to: cid2lu[cid] });
  }
  Logger.log('=== 予約のLINE ID修復' + (dryRun === false ? '（実行）' : '（DRYRUN・変更なし）') + ' ===');
  Logger.log('対象 ' + targets.length + '行');
  for (var k = 0; k < Math.min(targets.length, 30); k++) {
    var t = targets[k];
    Logger.log('  行' + t.row + '：' + t.name + ' ' + t.when + '　' + t.from + ' → ' + t.to);
  }
  if (targets.length > 30) Logger.log('  …ほか' + (targets.length - 30) + '行');
  if (dryRun !== false) { Logger.log('→ 問題なければ runRepairReservationLineIds() を実行してください。'); return { dryRun: true, would: targets.length }; }
  for (var m = 0; m < targets.length; m++) sh.getRange(targets[m].row, 4).setValue(targets[m].to);
  Logger.log('✅ ' + targets.length + '行を修復しました。お客様のマイ予約に反映されます。');
  return { dryRun: false, fixed: targets.length };
}
function runRepairReservationLineIdsDryRun() { return repairReservationLineIds(true); }
function runRepairReservationLineIds() { return repairReservationLineIds(false); }

// 会員登録の直後にカレンダー同期を走らせる（オーナー方針 2026-09-18）。
//   登録した瞬間は、カレンダーにある既存予約がまだ台帳に取り込まれていない＝
//   「登録したのにマイ予約が空」になる。定期同期(6時間毎)を待たせない。
//   ★同期は数十秒かかる＝画面から直接呼べない（LIFFは20秒で切れる）。
//     1秒後の一回限りトリガーに逃がし、裏で走らせる。トリガーは実行後に自分を消す。
function _lbCleanSyncTriggers() {
  try {
    var ts = ScriptApp.getProjectTriggers();
    for (var i = 0; i < ts.length; i++) {
      if (ts[i].getHandlerFunction() === '_lbSyncAfterRegister') ScriptApp.deleteTrigger(ts[i]);
    }
  } catch (e) { Logger.log('登録後同期トリガーの掃除に失敗: ' + e.message); }
}
function _lbSyncAfterRegister() {
  try { dailySync(); } catch (e) { Logger.log('登録後の同期に失敗（次の定期同期で取り込まれます）: ' + e.message); }
  _lbCleanSyncTriggers();   // 役目を終えたら自分を消す
}
function _lbScheduleSyncAfterRegister() {
  try {
    _lbCleanSyncTriggers();   // 同時刻に複数人が登録しても1本にまとめる（同期は全件走査なので1回で足りる）
    ScriptApp.newTrigger('_lbSyncAfterRegister').timeBased().after(1000).create();
    return true;
  } catch (e) { Logger.log('登録後同期の予約に失敗（定期同期で取り込まれます）: ' + e.message); return false; }
}

// 契約の読み込みを「1秒後の一回限りトリガー」に逃がす。画面を待たせずに裏で温める。
//   トリガーは実行後に自分で消す（上限20件に溜めない）。作成に失敗しても実害はない
//   （次に会員が開いたときに読み込まれるだけ）。
function _lbCleanWarmTriggers() {
  try {
    var ts = ScriptApp.getProjectTriggers();
    for (var i = 0; i < ts.length; i++) {
      if (ts[i].getHandlerFunction() === '_lbWarmContract') ScriptApp.deleteTrigger(ts[i]);
    }
  } catch (e) { Logger.log('温めトリガーの掃除に失敗: ' + e.message); }
}
function _lbWarmContract() {
  try { _lbFindContract('__warmup__'); } catch (e) { Logger.log('契約の温め直しに失敗: ' + e.message); }
  _lbCleanWarmTriggers();   // 役目を終えたら自分を消す
}
function _lbScheduleContractWarm() {
  try {
    _lbCleanWarmTriggers();   // 重複を作らない
    ScriptApp.newTrigger('_lbWarmContract').timeBased().after(1000).create();
    return true;
  } catch (e) { Logger.log('温め直しの予約に失敗（次のアクセスで読み込まれます）: ' + e.message); return false; }
}

// GASエディタから実行するとき用（読み直しまで行う。数十秒かかる）
function runRefreshContract() { return refreshContractCache(true); }

// トレーナー管理画面から実行（オーナー／トレーナーのどちらでも可＝店頭ですぐ直せるように）
//   ここでは**読み直さない**＝即座に返す。読み込みは裏のトリガーが引き受ける。
function refreshContractForApp(lineUserId) {
  var tr = requireTrainer(lineUserId);
  if (!tr) return { success: false, code: 'FORBIDDEN', message: 'トレーナーのみ利用できます。' };
  var r = refreshContractCache(false);
  var warmed = _lbScheduleContractWarm();
  return { success: true, rows: r.rows, warmScheduled: warmed,
           message: '契約情報を読み直しました（' + r.rows + '件）。お客様の画面にも最新の残数が表示されます。'
                  + (warmed ? '\n（数十秒後から表示が速くなります）' : '') };
}

// ============================================================
// 毎日の健康チェック（★問題の発見を人の申告に頼らない）
//   顧客やトレーナーが「予約できない」「残数が違う」と気づいて報告してくる前に、
//   こちらが先に把握して直すための仕組み。会員・予約・カレンダー・通知を1回でまとめて点検し、
//   結果を health_status シートへ蓄積する（推移が見える）。
//   ★通知は「前回より悪化したとき」だけ。同じ問題を毎日送ると読まれなくなり、
//     本当に新しい問題が埋もれる。件数が減った/横ばいなら静かにしている。
//   トリガーは setupLineTriggers（毎日 6:30＝ペース集計の直後）。
// ============================================================
var LB_HEALTH_SHEET = 'health_status';
var LB_HEALTH_COLS = ['点検時刻', '区分', '重大度', '件数', '内容'];

function dailyHealthCheck(dryRun) {
  var tz = SETTINGS.TIMEZONE, now = new Date();
  var stamp = Utilities.formatDate(now, tz, 'yyyy/MM/dd HH:mm');
  var issues = [];   // { key, area, severity, count, detail }
  function add(key, area, severity, count, detail) {
    if (!count) return;
    issues.push({ key: key, area: area, severity: severity, count: count, detail: String(detail || '').slice(0, 300) });
  }

  // ---- 会員データ（消化ペースの集計と同時に取る＝二度手間を避ける）----
  var pace = null;
  try { pace = refreshPaceBoard(); } catch (e) { add('pace_fail', '会員', 'high', 1, '消化ペースの集計に失敗: ' + e.message); }
  var meta = {}; try { meta = JSON.parse(_lbProp('LB_PACE_META') || '{}'); } catch (e) { meta = {}; }
  add('member_broken', '会員', 'high', Number(meta.brokenCount || 0),
      '残数を確定できない（契約データの不備。本人が予約できない恐れ）: ' + (meta.brokenNames || []).join('、'));
  add('member_nocontract', '会員', 'info', Number(meta.noContractCount || 0),
      '契約が見つからない（退会・契約切れなら正常）: ' + (meta.noContractNames || []).join('、'));

  // ---- 予約データ（重複・未紐付け）----
  try {
    var dh = debugDataHealth();
    add('resv_dup_ev', '予約', 'high', dh.dupEv.length, '同じ予定を重複取込＝残数が多重に減る: ' + dh.dupEv.join(' / '));
    add('resv_dup_slot', '予約', 'high', dh.dupSlot.length, '同一日時に2行＝実質の重複: ' + dh.dupSlot.join(' / '));
    add('resv_unlinked', '予約', 'warn', dh.unlinked, '未紐付け＝消化が計上されない: ' + (dh.unlinkedList || []).join(' / '));
    add('resv_future', '予約', 'info', dh.future.length, '予約窓より先の予約: ' + dh.future.join(' / '));
  } catch (e) { add('datahealth_fail', '予約', 'high', 1, '予約データの点検に失敗: ' + e.message); }

  // ---- カレンダーと台帳の整合 ----
  try {
    var oe = debugOrphanEvents();
    add('cal_orphan', 'カレンダー', 'warn', oe.orphanB1.length, '台帳に無い予定＝枠が売れない: ' + oe.orphanB1.join(' / '));
    add('cal_missing', 'カレンダー', 'high', oe.missingB1.length, '予定が無い予約＝二重予約のリスク: ' + oe.missingB1.join(' / '));
    add('cal_orphan_tr', 'カレンダー', 'warn', oe.orphanTrainer.length, '担当calの残骸: ' + oe.orphanTrainer.join(' / '));
    add('cal_missing_tr', 'カレンダー', 'warn', oe.missingTrainer.length, '担当calに予定が無い: ' + oe.missingTrainer.join(' / '));
    add('cal_manual', 'カレンダー', 'info', oe.manual.length, '手動作成（台帳に無い）: ' + oe.manual.join(' / '));
  } catch (e) { add('orphan_fail', 'カレンダー', 'high', 1, 'カレンダー突合に失敗: ' + e.message); }

  // ---- 通知（未達）----
  try {
    var bm = getBookingMetrics(1);
    var nf = bm.notifyFail || { total: 0, byReason: {}, byPurpose: {} };
    var rs = []; for (var k in nf.byReason) rs.push(k + ':' + nf.byReason[k]);
    add('notify_fail', '通知', 'high', nf.total, '昨日のLINE未達（401=トークン失効/403=ブロック/429=上限）: ' + rs.join(' / '));
    add('booking_error', '予約', 'warn', bm.byOutcome['SERVER_ERROR'] || 0, '昨日の予約の内部失敗');
  } catch (e) { add('metrics_fail', '通知', 'warn', 1, '実測ログの集計に失敗: ' + e.message); }

  // ---- LINE通数 ----
  try {
    var q = _lbQuotaFetch();
    if (q && q.ok && q.limited && q.left <= 0) add('quota_exhausted', '通知', 'high', 1, 'LINE通数が上限＝すべての通知が届きません');
    else if (q && q.ok && q.limited && q.pct >= 80) add('quota_near', '通知', 'warn', 1, 'LINE通数が' + q.pct + '%（残' + q.left + '通）');
  } catch (e) {}

  // ---- 定期処理が動いているか（止まっていても誰も気づけない）----
  try {
    var ss = _lbSheet(LB_SYNC_STATUS_SHEET);
    if (ss && ss.getLastRow() > 1) {
      var lastSync = _lbParseResvDate(ss.getRange(2, 1).getValue());
      if (lastSync && (now.getTime() - lastSync.getTime()) > 24 * 3600000) {
        add('sync_stale', '定期処理', 'high', 1, 'カレンダー同期が24時間以上動いていません（最終 ' + Utilities.formatDate(lastSync, tz, 'M/d HH:mm') + '）');
      }
    } else { add('sync_never', '定期処理', 'warn', 1, 'カレンダー同期の実行記録がありません'); }
  } catch (e) {}
  try {
    var rsh = _lbSheet(LB_REMINDER_STATUS_SHEET);
    if (rsh && rsh.getLastRow() > 1) {
      var lastRem = _lbParseResvDate(rsh.getRange(2, 1).getValue());
      if (lastRem && (now.getTime() - lastRem.getTime()) > 36 * 3600000) {
        add('reminder_stale', '定期処理', 'high', 1, '前日リマインドが36時間以上動いていません（最終 ' + Utilities.formatDate(lastRem, tz, 'M/d HH:mm') + '）');
      }
    }
  } catch (e) {}

  // ---- 記録（推移が見えるよう追記）----
  if (!dryRun) {
    try {
      var ss2 = _lbSs(); var sh = ss2.getSheetByName(LB_HEALTH_SHEET);
      if (!sh) { sh = ss2.insertSheet(LB_HEALTH_SHEET); sh.getRange(1, 1, 1, LB_HEALTH_COLS.length).setValues([LB_HEALTH_COLS]).setFontWeight('bold'); sh.setFrozenRows(1); }
      var stampCell2 = "'" + stamp;
      var rows = issues.length
        ? issues.map(function (x) { return [stampCell2, x.area, x.severity, x.count, x.detail]; })
        : [[stampCell2, '—', 'ok', 0, '問題なし']];
      sh.insertRowsAfter(1, rows.length);
      sh.getRange(2, 1, rows.length, LB_HEALTH_COLS.length).setValues(rows);
    } catch (e) { Logger.log('health_status記録失敗: ' + e.message); }
  }

  // ---- 悪化したときだけ知らせる（同じ問題を毎日送らない）----
  var prev = {}; try { prev = JSON.parse(_lbProp('LB_HEALTH_PREV') || '{}'); } catch (e) { prev = {}; }
  var worsened = issues.filter(function (x) { return x.severity !== 'info' && x.count > Number(prev[x.key] || 0); });
  var cur = {}; issues.forEach(function (x) { cur[x.key] = x.count; });
  if (!dryRun) { try { PropertiesService.getScriptProperties().setProperty('LB_HEALTH_PREV', JSON.stringify(cur)); } catch (e) {} }

  var report = ['【システム点検】' + stamp, ''];
  if (!issues.length) report.push('問題は見つかりませんでした。');
  ['high', 'warn', 'info'].forEach(function (sev) {
    var g = issues.filter(function (x) { return x.severity === sev; });
    if (!g.length) return;
    report.push((sev === 'high' ? '🔴 至急' : sev === 'warn' ? '⚠️ 要確認' : 'ℹ️ 参考') + '：');
    g.forEach(function (x) { report.push('・[' + x.area + '] ' + x.count + '件 ' + x.detail); });
    report.push('');
  });
  var txt = report.join('\n');
  Logger.log(txt);

  if (!dryRun && worsened.length) {
    var to = _lbAlertEmail();
    if (to) {
      var body = '前回より悪化した項目があります。\n\n'
        + worsened.map(function (x) { return '・[' + x.area + '] ' + x.detail + '（' + (prev[x.key] || 0) + '件 → ' + x.count + '件）'; }).join('\n')
        + '\n\n---- 全体 ----\n' + txt;
      try { GmailApp.sendEmail(to, '【要対処】システム点検で' + worsened.length + '件の悪化', body); }
      catch (e) { Logger.log('点検メール送信失敗: ' + e.message); }
    }
  }
  return { stamp: stamp, issues: issues, worsened: worsened.length, notified: (!dryRun && worsened.length > 0) };
}
// 送信も記録もせず、内容だけ確認する
function runHealthCheckDryRun() { return dailyHealthCheck(true); }

// ============================================================
// 消化ペースの週次レポート（トレーナーへLINE／オーナーへメール）
//   目的は「使い切れずに終わる会員を、まだ間に合ううちに拾う」こと。
//   声かけは関係性のあるトレーナーがやる方が効くので、システムは顧客に直接送らず**担当へ渡す**。
//   閾値は Script Property で調整可能（実データの分布を見てから決められるように）：
//     LB_PACE_WARN  … 要フォロー（既定 2.0＝週2回ペースが必要）
//     LB_PACE_ALERT … ほぼ間に合わない（既定 3.0＝週3回ペースが必要）
//   トリガーは setupLineTriggers（毎週月曜 8時）。
// ============================================================
//   LB_PACE_WARN  … 何回分の遅れで要フォローとするか（既定 1.0回）
//   LB_PACE_ALERT … 何回分の遅れで深刻とするか（既定 2.0回）
//   ※チケットは「期限30日以内に残あり＝🔴」「月1回ペースで間に合わない＝⚠️」の固定判定。
function _lbPaceThresholds() {
  function num(key, def) { var v = Number(_lbProp(key)); return (_lbIsFiniteNum(v) && v > 0) ? v : def; }
  return { warn: num('LB_PACE_WARN', 1), alert: num('LB_PACE_ALERT', 2) };
}
function weeklyPaceReport(dryRun) {
  var th = _lbPaceThresholds();
  var r = _lbCollectPace(true);   // 週次は最新の契約で判断する
  var byTrainer = {}, allLines = [];
  function mark(behind) { return behind >= th.alert ? '🔴' : '⚠️'; }
  function add(tid, line) { (byTrainer[tid] = byTrainer[tid] || []).push(line); allLines.push(line); }

  // 月額：均等ペース（月4回なら週1回）からの遅れで判定。予定どおりの会員は載せない。
  for (var i = 0; i < r.monthly.length; i++) {
    var x = r.monthly[i];
    if (x.behind < th.warn) continue;
    add(x.trainerId, mark(x.behind) + ' ' + x.name + '様　月' + x.quota + '回（週' + x.weekly + '回ペース）\n' +
      '　今月' + x.used + '回／本来' + x.should + '回 → ' + x.behind + '回分の遅れ（残' + x.rem + '回）');
  }
  // チケット：最低ライン＝月1回。期限が迫っている／月1回では間に合わない会員だけを載せる。
  for (var j = 0; j < r.ticket.length; j++) {
    var y = r.ticket[j];
    var urgent = (y.daysLeft != null && y.daysLeft <= 30);
    if (!urgent && !(y.needPerMonth > 1)) continue;
    add(y.trainerId, (urgent ? '🔴' : '⚠️') + ' ' + y.name + '様　チケット残' + y.rem + '回／期限' + y.expire +
      (y.daysLeft != null ? '（あと' + y.daysLeft + '日）' : '') + '\n' +
      '　月' + y.needPerMonth + '回ペースが必要' + (y.needPerMonth > 1 ? '＝月1回では使い切れません' : '') + (urgent ? '　※失効が近づいています' : ''));
  }

  // トレーナーへ（自分の担当分だけ・LINE）。該当が無いトレーナーには送らない＝無駄な通知を出さない。
  var sentTr = 0;
  for (var tid in byTrainer) {
    var lid = getTrainerLineId(tid);
    if (!lid) continue;
    var msg = '【今週のフォロー候補】\n消化が偏らないよう、ご予約のお声かけをお願いします。\n（月末にまとめて通うのではなく、均等なペースで習慣にしていただくのが目的です）\n\n' + byTrainer[tid].join('\n\n');
    if (!dryRun && _lbPush(lid, msg, 'pace_trainer')) sentTr++;
  }
  // オーナーへ（全体・メール＝LINE通数を消費しない）
  var body = '消化ペースの週次レポート\n今月の経過：' + r.month.elapsedPct + '%／残り' + r.month.daysLeft + '日\n'
    + '判定：月額＝均等ペース（月4回なら週1回）から' + th.warn + '回以上の遅れで要フォロー／' + th.alert + '回以上で深刻\n'
    + '　　　チケット＝最低ライン月1回。期限30日以内または月1回で間に合わない場合に掲載\n\n'
    + (allLines.length ? allLines.join('\n') : '該当なし（全員が間に合うペースです）')
    + '\n\n対象会員：' + r.checked + '名／今月の月額を消化済み：' + r.done + '名';
  var to = _lbAlertEmail();
  if (!dryRun && to) { try { GmailApp.sendEmail(to, '【消化ペース】要フォロー ' + allLines.length + '名', body); } catch (e) { Logger.log('ペースレポート送信失敗: ' + e.message); } }
  Logger.log(body);
  return { targets: allLines.length, trainersNotified: sentTr, checked: r.checked, dryRun: !!dryRun, thresholds: th };
}
// 送信せずに内容だけ確認する（GASエディタから実行）
function runPaceReportDryRun() { return weeklyPaceReport(true); }

// ============================================================
// 予約データの健康診断（★読み取りのみ）
//   debugOrphanEvents が見るのは「カレンダーと台帳の食い違い」だけ。
//   それとは別に、台帳の中だけで起きる損失がある：
//     ・同じ予約が二重に取り込まれる → 残数が多重に消化される（顧客の損）
//     ・残数計算が壊れて表示できない → 予約できない／過大に見える
//     ・未紐付けの予約が残る → 消化が計上されない（店舗の損）
//   月1回これを回せば、顧客からの申告を待たずに拾える。
// ============================================================
function debugDataHealth() {
  var tz = SETTINGS.TIMEZONE, now = new Date();
  // ★契約フォームは5分キャッシュされる。キャッシュを読むと「契約が見つからない会員」が実態より
  //   多く出て、1分後の再実行で結果が変わる（2026-09-15に実測：8秒/4名 → 59秒/0名）。
  //   診断は速度より正確さを取り、必ず実データを読む。
  try { CacheService.getScriptCache().remove('lb_contract_all'); } catch (e) {}
  var out = ['=== 予約データの健康診断 ' + Utilities.formatDate(now, tz, 'yyyy/MM/dd HH:mm') + '（読み取りのみ）==='];
  var dupEv = [], dupSlot = [], future = [];

  // ---- ① 台帳の重複（残数の多重消化）----
  var sh = _lbSheet(LINE_BOOKING.RESV_SHEET);
  if (sh && sh.getLastRow() > 1) {
    var v = sh.getRange(2, 1, sh.getLastRow() - 1, 14).getValues();
    var seenEv = {}, seenSlot = {};
    var horizon = _lbBookingHorizonEnd(now);
    for (var i = 0; i < v.length; i++) {
      var st = String(v[i][6]);
      if (st !== 'confirmed' && st !== 'consumed') continue;
      var cid = String(v[i][2]), nm = String(v[i][1]), evId = String(v[i][12] || '');
      var d = _lbParseResvDate(v[i][0]);
      var when = d ? Utilities.formatDate(d, tz, 'M/d HH:mm') : String(v[i][0]);
      // a) 同一カレンダー予定を2回取り込んでいる
      if (evId) {
        var k1 = evId + '|' + cid;
        if (seenEv[k1]) dupEv.push('行' + (i + 2) + ' ' + nm + ' ' + when + '（同じカレンダー予定を重複取込）');
        else seenEv[k1] = true;
      }
      // b) evIdが違っても「同じ人・同じ日時」で2行＝実質の重複（手動紐付けの多重実行など）
      if (d) {
        var k2 = Utilities.formatDate(d, tz, 'yyyyMMddHHmm') + '|' + String(nm).replace(/\s+/g, '').replace(/様+$/, '');
        if (seenSlot[k2]) dupSlot.push('行' + (i + 2) + ' ' + nm + ' ' + when + '（同一日時に2行）');
        else seenSlot[k2] = true;
      }
      // c) 予約窓より先の未来（固定枠の先取り等。想定外なら要確認）
      if (d && d > horizon && st === 'confirmed') future.push(nm + ' ' + Utilities.formatDate(d, tz, 'M/d HH:mm') + '（担当' + String(v[i][5] || '') + '／channel=' + String(v[i][9] || '不明') + '）');
    }
  }

  // ---- ② 残数が算出できない会員（予約できない／表示が壊れる）----
  var broken = [], noContract = [], checked = 0;
  var mapSh = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (mapSh && mapSh.getLastRow() > 1) {
    var mv = mapSh.getRange(2, 1, mapSh.getLastRow() - 1, MAP_COL.NOTE).getValues();
    for (var m = 0; m < mv.length; m++) {
      if (String(mv[m][MAP_COL.AUTH_STATE - 1]) !== 'verified') continue;
      var cname = String(mv[m][MAP_COL.NAME - 1] || ''); if (!cname) continue;
      var ccid = String(mv[m][MAP_COL.CUSTOMER_ID - 1] || '');
      checked++;
      try {
        var h = _lbBuildHome(ccid, cname);
        if (h && h.reviewRequired) broken.push(cname + '（' + ccid + '）');
        else if (!h || !h.type) noContract.push(cname);
      } catch (e) { broken.push(cname + '（' + ccid + '）※例外: ' + e.message); }
    }
  }

  // ---- ③ 未紐付け（消化が計上されないまま残っている）----
  var unlinked = 0, unlinkedList = [];
  var ush = _lbSheet('line_unlinked');
  if (ush && ush.getLastRow() > 1) {
    unlinked = ush.getLastRow() - 1;
    var uv = ush.getRange(2, 1, unlinked, 7).getValues();
    for (var ui = 0; ui < uv.length; ui++) {
      var _ud = _lbParseResvDate(uv[ui][0]);   // セルがDate型で返ると生の文字列になるため必ず整形する
      var _ul = _ud ? _lbFmtWhenJa(_ud) : String(uv[ui][0]);
      unlinkedList.push(_ul + ' ' + String(uv[ui][1]) + '（担当' + String(uv[ui][2] || '?') + '／' + String(uv[ui][3] || '?') + '）' + (uv[ui][6] ? ' ※' + String(uv[ui][6]) : ''));
    }
  }

  function section(title, arr, note) {
    out.push('');
    out.push(title + '：' + arr.length + '件' + (arr.length ? '' : ' ✅'));
    for (var i = 0; i < Math.min(arr.length, 20); i++) out.push('   ・' + arr[i]);
    if (arr.length > 20) out.push('   …ほか' + (arr.length - 20) + '件');
    if (arr.length && note) out.push('   → ' + note);
  }
  section('① 同じカレンダー予定の重複取込【残数が多重に減る】', dupEv, 'runDedupeReservations（dryRun=true）で確認→是正できます');
  section('② 同一日時に2行【実質の重複】', dupSlot, '手動紐付けの多重実行の疑い。内容を確認のうえ片方をchangedに');
  section('③ 残数を算出できない会員【予約できない/表示が壊れる】', broken, 'runRemainingDebug に氏名を入れて原因を特定してください（pack未入力・契約不備など）');
  section('④ 予約窓より先の予約', future, '固定枠の先取りなら正常。身に覚えが無ければ要確認');
  out.push('');
  out.push('契約が見つからない会員：' + noContract.length + '件' + (noContract.length ? '（' + noContract.slice(0, 10).join(', ') + '）＝退会・契約切れなら正常' : ' ✅'));
  out.push('');
  out.push('未紐付けの予約（line_unlinked）：' + unlinked + '件' + (unlinked ? ' → トレーナー管理画面「未紐付け予約を紐付ける」から会員を選ぶと残数に計上されます' : ' ✅'));
  for (var uj = 0; uj < Math.min(unlinkedList.length, 20); uj++) out.push('   ・' + unlinkedList[uj]);
  if (unlinkedList.length > 20) out.push('   …ほか' + (unlinkedList.length - 20) + '件');
  out.push('残数を確認した会員：' + checked + '名');
  var txt = out.join('\n');
  Logger.log(txt);
  _LB_DATA_HEALTH_TEXT = txt;   // ★文字列でも取れるようにする（作業依頼から中身を見るため）
  return { dupEv: dupEv, dupSlot: dupSlot, broken: broken, future: future, noContract: noContract, unlinked: unlinked, unlinkedList: unlinkedList, checked: checked };
}

// 健康診断の結果を文字列で返す（読み取りだけ）。
//   エディタを開かなくても中身を確認できるようにするため（2026-09-30）。
var _LB_DATA_HEALTH_TEXT = '';
function dataHealthText() {
  _LB_DATA_HEALTH_TEXT = '';
  try { debugDataHealth(); } catch (e) { return '健康診断に失敗しました: ' + (e && e.message); }
  return _LB_DATA_HEALTH_TEXT || '（結果を取得できませんでした）';
}

// 前日リマインドを今すぐ手動送信する（トリガー不発のリカバリ用・★実際に顧客とトレーナーへ送信されます）
function runRemindersNow() {
  var r = sendLineReminders();
  Logger.log('手動送信の結果: ' + JSON.stringify(r));
  return r;
}

// ============================================================
// セットアップ（オーナーがGASエディタで1回実行）
//   ・customer_line_map / trainer_master のヘッダ作成
//   ・LINE_CODE_SALT が無ければ生成
// ============================================================
// ============================================================
// テスト専用ヘルパー（通し検証用・staging環境でのみ動作）
// GASエディタから引数なしで実行 → ログに認証番号が出る → LIFFで入力
// ============================================================
function testLbIssueCode() {
  if (!PropertiesService.getScriptProperties().getProperty('STAGING_SPREADSHEET_ID')) {
    Logger.log('⛔ 拒否：STAGING_SPREADSHEET_ID未設定。本番環境ではテスト実行しません（本番SS汚染防止）。');
    return;
  }
  var r = issueVerifyCode({ customerId: 'TEST001', name: 'テスト太郎', phone: '09000000000' });
  Logger.log('✅ テスト会員の認証番号 = ' + (r && r.code) + '（有効期限 ' + (r && r.expiresAt) + '）');
  Logger.log(JSON.stringify(r));
  return r;
}

// 1F担当ブロック(Codex#1)の事前検証・読み取りのみ：1Fの3分割予約が既知担当に帰属するか、全員ブロック(blockAll)が0か。
//   ★PIIは出さない（顧客名を出さず 種別/担当姓/帰属先trainerId のみ）。フラグONの前にこれで安全確認。
function testLb1FBlock() {
  var now = new Date(), endD = new Date(now.getTime() + SETTINGS.SYNC_DAYS * 86400000);
  var surToId = {}; for (var i = 0; i < CALENDAR_IDS.TRAINERS.length; i++) { surToId[_lbNormTok(CALENDAR_IDS.TRAINERS[i].name.split(' ')[0])] = CALENDAR_IDS.TRAINERS[i].id; }
  var copts = { b1Id: CALENDAR_IDS.CAPACITY_B1, oneFId: CALENDAR_IDS.CAPACITY_1F, surToId: surToId, isMember: function () { return false; } };
  var cal = CalendarApp.getCalendarById(CALENDAR_IDS.CAPACITY_1F);
  if (!cal) { Logger.log('❌ 1Fカレンダー取得不能→フラグONは不可(fail-closedで全予約拒否になる)'); return; }
  var evs = cal.getEvents(now, endD);
  var total = evs.length, parsed = 0, byTid = { A: 0, B: 0, C: 0 }, blockAll = [];
  var modeCnt = {};
  for (var e = 0; e < evs.length; e++) {
    var cls = _lbClassifyBooking(String(evs[e].getTitle()), CALENDAR_IDS.CAPACITY_1F, copts);
    if (!cls.parsed) continue;
    parsed++;
    modeCnt[cls.mode] = (modeCnt[cls.mode] || 0) + 1;
    if (cls.trainerId) byTid[cls.trainerId] = (byTid[cls.trainerId] || 0) + 1;
    else blockAll.push('種別「' + cls.kind + '」担当姓「' + cls.sur + '」');   // 担当姓不明＝全員ブロック要因
  }
  var mc = []; for (var m in modeCnt) mc.push(m + ':' + modeCnt[m]);
  Logger.log('=== 1F担当ブロック 事前検証（未来' + SETTINGS.SYNC_DAYS + '日・読み取りのみ）===');
  Logger.log('1F総イベント: ' + total + ' / 3分割予約(帰属対象): ' + parsed + ' / 非予約(無視): ' + (total - parsed));
  Logger.log('担当帰属: A(中野)=' + (byTid.A || 0) + ' / B(鈴木)=' + (byTid.B || 0) + ' / C(沖)=' + (byTid.C || 0));
  Logger.log('mode内訳: ' + (mc.join(' / ') || 'なし'));
  Logger.log('★全員ブロック要因(担当姓不明): ' + blockAll.length + '件' + (blockAll.length ? ' → ' + blockAll.join(' / ') : ''));
  Logger.log(blockAll.length ? '⚠️ 担当姓不明が有る＝フラグONで該当時間帯が全トレーナー予約不可になる。1Fタイトルの姓を中野/鈴木/沖に是正してからON。' : '✅ 全員ブロック要因なし＝フラグONにしても過剰ブロックは起きない。');
  Logger.log('現在のLB_1F_TRAINER_BLOCK: ' + (String(PropertiesService.getScriptProperties().getProperty('LB_1F_TRAINER_BLOCK') || '(未設定=OFF)')));
}

// テスト専用・読み取りのみ：契約フォームSS（請求管理ブック1ch84の「フォームの回答」）の列構成を把握。
//   ★PIIの値は出力しない。列名・列数・件数のみ（残数参照の設計用）。
function testLbReadContractSheet() {
  var ss = SpreadsheetApp.openById('1ch84msnulH7HX5DZ82yd0nRl5Hm95Ho72J39WCNfVkc');
  var sheets = ss.getSheets();
  var sh = null;
  for (var i = 0; i < sheets.length; i++) { if (sheets[i].getName().indexOf('フォーム') >= 0) { sh = sheets[i]; break; } }
  if (!sh) { Logger.log('「フォーム」を含むシート未検出。全シート: ' + sheets.map(function (s) { return s.getName(); }).join(' / ')); return; }
  var lastCol = sh.getLastColumn();
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  Logger.log('=== シート「' + sh.getName() + '」の列構成（値は出しません・列名のみ）===');
  Logger.log('契約データ件数: ' + Math.max(0, sh.getLastRow() - 1) + ' 件 / 列数: ' + lastCol);
  for (var j = 0; j < headers.length; j++) { Logger.log((j + 1) + '列目: ' + headers[j]); }
}

// 移行Phase1・読み取りのみ：本番契約26行の「中身の品質」を検証（値は出さず・行番号とカウントのみ）。
//   目的：担当トレーナー／顧客ID(col18)／電話／種別／単価 が全行埋まっているか＝移行の前提を確定。
function testLbValidateContracts() {
  var sh = _lbContractSheet();
  if (!sh) { Logger.log('契約シート未検出'); return; }
  var last = sh.getLastRow(); if (last < 2) { Logger.log('契約データなし'); return; }
  var lastCol = sh.getLastColumn();
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  function col(sub) { for (var j = 0; j < headers.length; j++) { if (String(headers[j]).indexOf(sub) >= 0) return j; } return -1; }
  var cName = col('お客様名'), cType = col('種別'), cTr = col('担当'), cPhone = col('電話'),
      cPrice = col('単価'), cCid = col('顧客ID'), cStart = col('開始日'), cEnd = col('終了日');
  var vals = sh.getRange(2, 1, last - 1, lastCol).getValues();
  var n = vals.length;
  var blankName = [], blankTr = [], badTr = [], blankCid = [], blankPhone = [], blankType = [];
  var nameToCids = {};   // 正規化氏名→{cid:true} 同名で別IDが割れていないか
  for (var i = 0; i < n; i++) {
    var r = vals[i], rowNo = i + 2;
    var nm = cName >= 0 ? _lbNormName(r[cName]) : '';
    var tr = cTr >= 0 ? String(r[cTr] || '').trim() : '';
    var cid = cCid >= 0 ? String(r[cCid] || '').trim() : '';
    var ph = cPhone >= 0 ? _lbNormPhone(r[cPhone]) : '';
    var ty = cType >= 0 ? String(r[cType] || '').trim() : '';
    if (!nm) blankName.push(rowNo);
    if (!tr) blankTr.push(rowNo); else if (!_lbTrainerIdByName(tr)) badTr.push(rowNo);
    if (cCid < 0 || !cid) blankCid.push(rowNo);
    if (!ph) blankPhone.push(rowNo);
    if (!ty) blankType.push(rowNo);
    if (nm) { if (!nameToCids[nm]) nameToCids[nm] = {}; if (cid) nameToCids[nm][cid] = true; }
  }
  var splitNames = 0;
  for (var k in nameToCids) { if (Object.keys(nameToCids[k]).length > 1) splitNames++; }
  Logger.log('=== 契約データ品質検証（値は出さず・行番号のみ）===');
  Logger.log('総行数: ' + n + ' / 列: 担当=' + (cTr + 1) + ' 顧客ID=' + (cCid + 1) + ' 電話=' + (cPhone + 1) + ' 種別=' + (cType + 1));
  Logger.log('氏名なし: ' + blankName.length + (blankName.length ? ' 行' + blankName.join(',') : ''));
  Logger.log('担当なし: ' + blankTr.length + (blankTr.length ? ' 行' + blankTr.join(',') : '') + '（★オーナー整備必須：予約時のトレーナー割当キー）');
  Logger.log('担当が中野/鈴木/沖に一致しない: ' + badTr.length + (badTr.length ? ' 行' + badTr.join(',') : '') + '（★要名寄せ）');
  Logger.log('顧客ID記入済(col18): ' + (n - blankCid.length) + '/' + n + '（※システムが移行バッチで書き戻す列。現時点で空=正常。オーナー入力不要）');
  Logger.log('電話なし: ' + blankPhone.length + (blankPhone.length ? ' 行' + blankPhone.join(',') : '') + '（★オーナー整備必須：自己登録の照合キー）');
  Logger.log('種別なし: ' + blankType.length + (blankType.length ? ' 行' + blankType.join(',') : '') + '（★オーナー整備必須）');
  Logger.log('同名で顧客IDが2つ以上に割れている氏名: ' + splitNames + '件（>0なら同名別人か採番ミス・要確認）');
  Logger.log('=== 検証完了。★印(担当/電話/種別)の空=0 が Phase1 の合格条件。顧客IDは移行時に自動投入 ===');
}

// 移行Phase2の事前点検・読み取り中心：B1施設カレンダーの既存予約(種別_担当姓_顧客)を契約名と突合。
//   運用実態＝予約はB1に集約・担当はタイトルparts[1](姓)で表現・1Fは体験用で対象外（オーナー確認2026-08-05）。
//   種別別に「契約会員に一致/非会員」を集計。姓→trainerId不能も検出。不一致明細は sync_preview シートへbest-effort。
//   ログ主体（PIIなし）。line_reservations等の本番データは書かない。会員登録前でも実行可（契約名と突合）。
function testLbSyncPreview() {
  var csh = _lbContractSheet(); if (!csh) { Logger.log('契約シート未検出'); return; }
  var clast = csh.getLastRow(); if (clast < 2) { Logger.log('契約なし'); return; }
  var chead = csh.getRange(1, 1, 1, csh.getLastColumn()).getValues()[0];
  var nameCol = -1; for (var j = 0; j < chead.length; j++) { if (String(chead[j]).indexOf('お客様名') >= 0) { nameCol = j; break; } }
  if (nameCol < 0) { Logger.log('お客様名列なし'); return; }
  var cvals = csh.getRange(2, 1, clast - 1, csh.getLastColumn()).getValues();
  var contractNames = {}; for (var i = 0; i < cvals.length; i++) { var nm = _lbNormName(cvals[i][nameCol]); if (nm) contractNames[nm] = true; }
  var surToId = {}; for (var t = 0; t < CALENDAR_IDS.TRAINERS.length; t++) { surToId[CALENDAR_IDS.TRAINERS[t].name.split(' ')[0]] = CALENDAR_IDS.TRAINERS[t].id; }
  var copts = { b1Id: CALENDAR_IDS.CAPACITY_B1, oneFId: CALENDAR_IDS.CAPACITY_1F, surToId: surToId, isMember: function (c) { return !!contractNames[_lbNormName(c)]; } };
  var SESSION_KINDS = { '通常': 1, 'モニター': 1, 'オンライン': 1 };
  var now = new Date(), endD = new Date(now.getTime() + SETTINGS.SYNC_DAYS * 86400000), tz = SETTINGS.TIMEZONE;
  var scanTargets = [CALENDAR_IDS.CAPACITY_B1, CALENDAR_IDS.CAPACITY_1F];
  var scanned = 0, badTrainer = 0, unmatched = [];
  var sessMatched = {}, sessUnmatched = {}, nonSession = {};
  for (var s = 0; s < scanTargets.length; s++) {
    var cal = CalendarApp.getCalendarById(scanTargets[s]); if (!cal) continue;
    var evs = cal.getEvents(now, endD);
    for (var e = 0; e < evs.length; e++) {
      var cls = _lbClassifyBooking(String(evs[e].getTitle()), scanTargets[s], copts);
      if (!cls.parsed) continue;
      scanned++;
      if (!cls.trainerId) badTrainer++;
      if (!SESSION_KINDS[cls.kind]) { nonSession[cls.kind] = (nonSession[cls.kind] || 0) + 1; continue; }   // レンタル/体験＝非計上
      if (cls.isMemberSession) sessMatched[cls.kind] = (sessMatched[cls.kind] || 0) + 1;
      else { sessUnmatched[cls.kind] = (sessUnmatched[cls.kind] || 0) + 1; unmatched.push([Utilities.formatDate(evs[e].getStartTime(), tz, 'yyyy/MM/dd HH:mm'), cls.cname, cls.sur, cls.kind]); }
    }
  }
  var wrote = false;
  try {
    var ss = _lbSs(); var psh = ss.getSheetByName('sync_preview');
    if (psh) psh.clearContents(); else psh = ss.insertSheet('sync_preview');
    psh.getRange(1, 1, 1, 4).setValues([['予約日時', '顧客名(カレンダー)', '担当姓', '種別']]);
    if (unmatched.length) psh.getRange(2, 1, unmatched.length, 4).setValues(unmatched);
    wrote = true;
  } catch (ex) { Logger.log('sync_preview書込スキップ（SS一時エラー）: ' + ex.message); }
  function _fmt(o) { var a = [], tot = 0; for (var k in o) { a.push(k + ':' + o[k]); tot += o[k]; } return (a.length ? a.join(' / ') : 'なし') + '（計' + tot + '）'; }
  Logger.log('=== Phase2 同期プレビュー（B1＋1F・読み取り／書込はsync_previewのみ）===');
  Logger.log('3分割予約(未消化・未来' + SETTINGS.SYNC_DAYS + '日): ' + scanned + '件');
  Logger.log('会員セッション×契約一致（=同期対象）: ' + _fmt(sessMatched));
  Logger.log('会員セッション×契約に無い名前（要確認・表記ゆれ/契約漏れ）: ' + _fmt(sessUnmatched));
  Logger.log('非セッション（レンタル/体験＝残数計上せず）: ' + _fmt(nonSession));
  Logger.log('担当姓→trainerId変換不能: ' + badTrainer + '件（>0なら姓の表記ゆれ）');
  Logger.log(wrote ? '要確認明細 → sync_previewシート参照（PIIはシート内・オーナーのみ）' : '要確認明細のシート出力は今回スキップ（再実行で反映）');
  Logger.log('=== 同期対象＝会員セッション×契約一致。レンタル/体験は残数に数えない（容量/担当は別途エンジンで考慮）===');
}

// 移行Phase2の地ならし・読み取りのみ：既存カレンダーの実タイトル形式を監査。
//   ログは構造フィンガープリント（カテゴリ別カウント）のみ＝PIIをチャットに出さない。
//   全文は「title_audit」シート（予約管理SS内・オーナー自身が確認）へ。手動運用のタイトル形式を確定しPhase2方式を決める土台。
function testLbCalendarTitleAudit() {
  var now = new Date(), endD = new Date(now.getTime() + SETTINGS.SYNC_DAYS * 86400000), tz = SETTINGS.TIMEZONE;
  var cats = { shift: 0, consumed: 0, reserved: 0, check: 0, brk: 0, migrated: 0, other: 0 };
  var otherUnderscore = 0, otherSama = 0, otherPlain = 0, partsDist = {};
  var tok0 = {}, tok1 = {};   // 3分割OTHERの parts[0]/parts[1] 出現分布（種別語/担当名＝非PII）。parts[2]=顧客名は出さない。
  var rows = [];   // [カレンダー, 日時, タイトル全文, 分類] → title_audit シート（オーナー確認用）
  var scanTargets = [];
  for (var t = 0; t < CALENDAR_IDS.TRAINERS.length; t++) scanTargets.push({ label: CALENDAR_IDS.TRAINERS[t].name, email: CALENDAR_IDS.TRAINERS[t].email });
  scanTargets.push({ label: 'B1施設', email: CALENDAR_IDS.CAPACITY_B1 });
  var total = 0;
  for (var s = 0; s < scanTargets.length; s++) {
    var cal = CalendarApp.getCalendarById(scanTargets[s].email); if (!cal) continue;
    var evs = cal.getEvents(now, endD);
    for (var e = 0; e < evs.length; e++) {
      var title = String(evs[e].getTitle());
      total++;
      var cls;
      if (isShiftEvent(title)) { cats.shift++; cls = 'shift'; }
      else if (title.indexOf('[消化]') >= 0) { cats.consumed++; cls = 'consumed'; }
      else if (title.indexOf('[RESERVED]') === 0) { cats.reserved++; cls = 'reserved'; }
      else if (title.indexOf('✅') === 0) { cats.check++; cls = 'check'; }
      else if (title.indexOf('休憩') >= 0) { cats.brk++; cls = 'break'; }
      else if (title.indexOf('[MIGRATED]') >= 0) { cats.migrated++; cls = 'migrated'; }
      else {
        cats.other++; cls = 'OTHER';
        if (title.indexOf('_') >= 0) {
          otherUnderscore++; var pp = title.split('_'); partsDist[pp.length] = (partsDist[pp.length] || 0) + 1;
          if (pp.length === 3) { var a = pp[0].trim(), b = pp[1].trim(); tok0[a] = (tok0[a] || 0) + 1; tok1[b] = (tok1[b] || 0) + 1; }
        }
        else if (title.indexOf('様') >= 0) otherSama++;
        else otherPlain++;
      }
      if (cls === 'OTHER' || cls === 'reserved' || cls === 'check' || cls === 'consumed')
        rows.push([scanTargets[s].label, Utilities.formatDate(evs[e].getStartTime(), tz, 'yyyy/MM/dd HH:mm'), title, cls]);
    }
  }
  var ss = _lbSs();
  var ash = ss.getSheetByName('title_audit'); if (ash) ss.deleteSheet(ash); ash = ss.insertSheet('title_audit');
  ash.getRange(1, 1, 1, 4).setValues([['カレンダー', '日時', 'タイトル全文', '分類']]);
  if (rows.length) ash.getRange(2, 1, rows.length, 4).setValues(rows);
  var pd = []; for (var k in partsDist) pd.push(k + '分割:' + partsDist[k]);
  Logger.log('=== カレンダー・タイトル監査（未来' + SETTINGS.SYNC_DAYS + '日／トレーナー3＋B1・読み取りのみ）===');
  Logger.log('総イベント: ' + total);
  Logger.log('出勤シフト: ' + cats.shift + ' / [消化]: ' + cats.consumed + ' / [RESERVED]: ' + cats.reserved + ' / ✅: ' + cats.check + ' / 休憩: ' + cats.brk + ' / [MIGRATED]: ' + cats.migrated);
  Logger.log('★その他(予約候補・システム形式でない): ' + cats.other + '　内訳 _含む:' + otherUnderscore + '(' + pd.join(' ') + ') / 様含む:' + otherSama + ' / 素:' + otherPlain);
  function _fmtTok(o) { var a = []; for (var kk in o) a.push('「' + kk + '」:' + o[kk]); return a.join(' / '); }
  Logger.log('3分割OTHERの parts[0]（種別候補・非PII）: ' + _fmtTok(tok0));
  Logger.log('3分割OTHERの parts[1]（担当候補・非PII）: ' + _fmtTok(tok1));
  Logger.log('→ 予約実体(OTHER/RESERVED/✅/消化)の全文は title_audit シート参照（PIIはシート内・オーナーのみ）');
  Logger.log('=== ★その他が多い＝手動タイトル。形式を見てPhase2の取り込み方式を決める ===');
}

// 軽量版・カレンダーのみ走査（SpreadsheetApp不使用＝タイムアウト回避）。3分割OTHERタイトルの
//   parts[0]（種別候補）/parts[1]（担当候補）分布をログに出す。顧客名(parts[2])は出さない。形式確定用。
function testLbTitleTokens() {
  var now = new Date(), endD = new Date(now.getTime() + SETTINGS.SYNC_DAYS * 86400000);
  var tok0 = {}, tok1 = {}, other = 0, partsDist = {};
  var targets = [];
  for (var t = 0; t < CALENDAR_IDS.TRAINERS.length; t++) targets.push({ label: CALENDAR_IDS.TRAINERS[t].name.split(' ')[0] + 'cal', email: CALENDAR_IDS.TRAINERS[t].email });
  targets.push({ label: 'B1', email: CALENDAR_IDS.CAPACITY_B1 });
  targets.push({ label: '1F', email: CALENDAR_IDS.CAPACITY_1F });
  var perCal = {};   // カレンダー別 {shift, booking(3分割), other}
  for (var s = 0; s < targets.length; s++) {
    var cal = CalendarApp.getCalendarById(targets[s].email); if (!cal) continue;
    var evs = cal.getEvents(now, endD);
    var pc = perCal[targets[s].label] = { shift: 0, booking: 0, other: 0, total: evs.length };
    for (var e = 0; e < evs.length; e++) {
      var title = String(evs[e].getTitle());
      if (isShiftEvent(title) || title.indexOf('休憩') >= 0) { pc.shift++; continue; }
      if (title.indexOf('_') < 0) { other++; pc.other++; continue; }
      var pp = title.split('_'); partsDist[pp.length] = (partsDist[pp.length] || 0) + 1;
      if (pp.length === 3) { pc.booking++; var a = pp[0].trim(), b = pp[1].trim(); tok0[a] = (tok0[a] || 0) + 1; tok1[b] = (tok1[b] || 0) + 1; }
      else pc.other++;
    }
  }
  function _fmt(o) { var a = []; for (var kk in o) a.push('「' + kk + '」:' + o[kk]); return a.join(' / '); }
  var pd = []; for (var k in partsDist) pd.push(k + '分割:' + partsDist[k]);
  Logger.log('=== タイトル・トークン分布＋カレンダー別内訳（SS不使用）===');
  Logger.log('_区切り分布: ' + pd.join(' / ') + ' / _なし:' + other);
  Logger.log('3分割 parts[0]（種別・非PII）: ' + _fmt(tok0));
  Logger.log('3分割 parts[1]（担当姓・非PII）: ' + _fmt(tok1));
  for (var lbl in perCal) { var c = perCal[lbl]; Logger.log('[' + lbl + '] 総' + c.total + ' / 出勤シフト' + c.shift + ' / 予約(3分割)' + c.booking + ' / その他' + c.other); }
  Logger.log('=== ★予約(3分割)がどのカレンダーに載るか＝Phase2の同期対象カレンダーが確定 ===');
}

// 運用確認用・読み取りのみ：customer_line_map と line_reservations の最新行を表示（PIIはマスク）
function testLbInspect() {
  var ss = _lbSs();
  Logger.log('=== customer_line_map（最新5行）===');
  var map = ss.getSheetByName(LINE_BOOKING.MAP_SHEET);
  if (map && map.getLastRow() >= 2) {
    var from = Math.max(2, map.getLastRow() - 4);
    var mv = map.getRange(from, 1, map.getLastRow() - from + 1, MAP_COL.GOAL).getValues();
    mv.forEach(function (r) {
      var ph = String(r[MAP_COL.PHONE - 1] || '');
      var phMask = ph ? ('****' + ph.slice(-4)) : '(なし)';
      Logger.log('名前=' + r[MAP_COL.NAME - 1] + ' / cid=' + r[MAP_COL.CUSTOMER_ID - 1] +
        ' / 認証=' + r[MAP_COL.AUTH_STATE - 1] + ' / 種別=' + r[MAP_COL.CONTRACT_TYPE - 1] +
        ' / TEL=' + phMask + ' / email=' + (r[MAP_COL.EMAIL - 1] ? 'あり' : 'なし'));
    });
  } else Logger.log('（会員登録なし）');

  Logger.log('=== line_reservations（最新5行）===');
  var resv = ss.getSheetByName(LINE_BOOKING.RESV_SHEET);
  if (resv && resv.getLastRow() >= 2) {
    var rf = Math.max(2, resv.getLastRow() - 4);
    var rv = resv.getRange(rf, 1, resv.getLastRow() - rf + 1, 11).getValues();
    rv.forEach(function (r) {
      Logger.log('日時=' + r[0] + ' / 名前=' + r[1] + ' / status=' + r[6] +
        ' / channel=' + r[9] + ' / trainer=' + r[5] + ' / resId=' + r[8]);
    });
  } else Logger.log('（予約なし）');
  Logger.log('=== inspect 完了 ===');
}

// 会員登録の進捗（登録済◯/期待◯・未登録者一覧）。読み取りのみ。オンボード進捗把握用。
//   期待＝契約マスタで現在有効（終了日が空 or 未来）な契約を持つ会員（氏名＋電話末尾でユニーク化）。
//   登録済＝customer_line_map の verified（氏名正規化で照合）。同名は電話末尾で目視区別。
function testLbRegistrationProgress() {
  var csh = _lbContractSheet();
  if (!csh || csh.getLastRow() < 2) { Logger.log('契約シートが読めません'); return; }
  var lastCol = csh.getLastColumn();
  var cols = _lbContractCols(csh.getRange(1, 1, 1, lastCol).getValues()[0]);
  if (cols.name < 0) { Logger.log('契約シートに「お客様名」列がありません'); return; }
  var cVals = csh.getRange(2, 1, csh.getLastRow() - 1, lastCol).getValues();
  var cutMs = new Date().getTime() - 86400000;   // 昨日以前に終了＝失効として除外
  var expected = {};   // key=正規化氏名|電話末尾 → {name, phoneTail, trainer, types:{}}
  for (var i = 0; i < cVals.length; i++) {
    var r = cVals[i];
    var nm = (cols.name >= 0) ? String(r[cols.name] || '') : ''; if (!nm) continue;
    var type = (cols.type >= 0) ? String(r[cols.type] || '') : ''; if (!type) continue;   // 種別空＝契約行でない
    var endCell = (cols.end >= 0) ? r[cols.end] : '';
    if (endCell !== '' && endCell != null) {
      var endD = (endCell instanceof Date) ? endCell : new Date(endCell);
      if (!isNaN(endD.getTime()) && endD.getTime() < cutMs) continue;   // 失効
    }
    var ph = _lbNormPhone((cols.phone >= 0) ? r[cols.phone] : '');
    var pt = ph ? ph.slice(-4) : '(なし)';
    var key = _lbNormName(nm) + '|' + pt;
    if (!expected[key]) expected[key] = { name: nm, phoneTail: pt, trainer: (cols.trainer >= 0 ? String(r[cols.trainer] || '') : ''), types: {} };
    expected[key].types[type] = 1;
  }
  var reg = {};   // 正規化氏名 → true（verified）
  var msh = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (msh && msh.getLastRow() >= 2) {
    var mv = msh.getRange(2, 1, msh.getLastRow() - 1, MAP_COL.AUTH_STATE).getValues();   // AUTH_STATE(8列)まで読む（NAMEまでだと認証列がundefinedで全員未登録扱いになるバグ修正）
    for (var m = 0; m < mv.length; m++) {
      if (String(mv[m][MAP_COL.AUTH_STATE - 1]) !== 'verified') continue;
      reg[_lbNormName(mv[m][MAP_COL.NAME - 1])] = true;
    }
  }
  var keys = Object.keys(expected).sort(), done = [], missing = [];
  for (var e = 0; e < keys.length; e++) { var ex = expected[keys[e]]; (reg[_lbNormName(ex.name)] ? done : missing).push(ex); }
  Logger.log('=== 会員登録 進捗 ===');
  Logger.log('登録済 ' + done.length + ' / 期待 ' + keys.length + '名 （未登録 ' + missing.length + '名）');
  Logger.log('--- 未登録（要フォロー）---');
  if (!missing.length) Logger.log('（なし・全員登録済み）');
  missing.forEach(function (x) { Logger.log('・' + x.name + '（担当:' + (x.trainer || '?') + ' / TEL末尾:' + x.phoneTail + ' / ' + Object.keys(x.types).join(',') + '）'); });
  Logger.log('--- 登録済み ---');
  done.forEach(function (x) { Logger.log('・' + x.name + '（担当:' + (x.trainer || '?') + '）'); });
  Logger.log('=== 進捗 完了 ===');
}

// 読み取りのみ：登録でつまずく会員（＝現在有効な契約が無い＝selfRegister/予約が NOT_FOUND になる）をあぶり出す。
//   testLbRegistrationProgress は失効契約を"期待"から除外するため、契約切れの会員は一覧から消えて見えなくなる。
//   本関数はその盲点を埋め、「来店して登録しようとしても弾かれる会員」を最新契約終了日つきで洗い出す（佐野香奈子タイプ）。
function testLbRegistrationReadiness() {
  try { CacheService.getScriptCache().remove('lb_contract_all'); } catch (e) {}   // 常に最新の契約フォームを読む
  var csh = _lbContractSheet();
  if (!csh || csh.getLastRow() < 2) { Logger.log('契約シートが読めません'); return; }
  var lastCol = csh.getLastColumn();
  var cols = _lbContractCols(csh.getRange(1, 1, 1, lastCol).getValues()[0]);
  if (cols.name < 0) { Logger.log('契約シートに「お客様名」列がありません'); return; }
  var cVals = csh.getRange(2, 1, csh.getLastRow() - 1, lastCol).getValues();
  var now = new Date().getTime();
  function ymd(ms) { if (!ms) return '(終了日なし)'; var d = new Date(ms); return d.getFullYear() + '/' + ('0' + (d.getMonth() + 1)).slice(-2) + '/' + ('0' + d.getDate()).slice(-2); }
  var mem = {};   // key=正規化氏名|TEL末尾 → {name,phoneTail,trainer,types:{},hasActive,latestEnd}
  for (var i = 0; i < cVals.length; i++) {
    var r = cVals[i];
    var nm = String(r[cols.name] || ''); if (!nm) continue;
    var type = (cols.type >= 0) ? String(r[cols.type] || '') : ''; if (!type) continue;   // 種別空＝契約行でない
    var ph = _lbNormPhone((cols.phone >= 0) ? r[cols.phone] : '');
    var key = _lbNormName(nm) + '|' + (ph ? ph.slice(-4) : '(なし)');
    if (!mem[key]) mem[key] = { name: nm, phoneTail: ph ? ph.slice(-4) : '(なし)', trainer: (cols.trainer >= 0 ? String(r[cols.trainer] || '') : ''), types: {}, hasActive: false, latestEnd: 0, noEnd: false };
    mem[key].types[type] = 1;
    var start = cols.start >= 0 ? _lbParseResvDate(r[cols.start]) : null;
    var end = cols.end >= 0 ? _lbParseResvDate(r[cols.end]) : null;
    var startOk = !start || start.getTime() <= now;
    var endOk = !end || end.getTime() >= now;
    if (startOk && endOk) mem[key].hasActive = true;   // 現在有効な契約が1行でもあれば登録可
    if (!end) mem[key].noEnd = true; else if (end.getTime() > mem[key].latestEnd) mem[key].latestEnd = end.getTime();
  }
  var reg = {};
  var msh = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (msh && msh.getLastRow() >= 2) {
    var mv = msh.getRange(2, 1, msh.getLastRow() - 1, MAP_COL.AUTH_STATE).getValues();
    for (var m = 0; m < mv.length; m++) { if (String(mv[m][MAP_COL.AUTH_STATE - 1]) === 'verified') reg[_lbNormName(mv[m][MAP_COL.NAME - 1])] = true; }
  }
  var stuck = [], stuckReg = [];
  Object.keys(mem).forEach(function (k) {
    var x = mem[k];
    if (x.hasActive) return;   // 登録可＝問題なし
    (reg[_lbNormName(x.name)] ? stuckReg : stuck).push(x);
  });
  function line(x) { return '・' + x.name + '（担当:' + (x.trainer || '?') + ' / TEL末尾:' + x.phoneTail + ' / ' + Object.keys(x.types).join(',') + ' / 最新契約終了:' + (x.noEnd ? '(終了日なし)' : ymd(x.latestEnd)) + '）'; }
  Logger.log('=== 登録つまずき診断（現在有効な契約が無い会員）===');
  Logger.log('🔴 未登録＋有効契約なし（来店しても登録で弾かれる／9月契約の要否を判断）: ' + stuck.length + '名');
  if (!stuck.length) Logger.log('（なし）');
  stuck.sort(function (a, b) { return b.latestEnd - a.latestEnd; }).forEach(function (x) { Logger.log(line(x)); });   // 直近に切れた順＝現役の可能性が高い順
  Logger.log('🟡 登録済み＋有効契約なし（移行済みだが契約切れ・念のため確認）: ' + stuckReg.length + '名');
  stuckReg.forEach(function (x) { Logger.log(line(x)); });
  Logger.log('=== 診断 完了 ===（🟢有効契約ありの会員は testLbRegistrationProgress を参照）');
}

// 運用確認用・読み取りのみ：最新登録会員の残数内訳（契約開始・前月消化・繰越）を表示
// ★GASエディタから：下の 氏名 を書き換えて実行→その会員の残数内訳・不正フラグをログ出力（読み取りのみ）。
//   「残数が反映されない」原因（契約行なし／migrationGap／割当器ok=false／消化計上ズレ）を切り分ける。
// 「本人端末で残数が出ない」を診断：customer_line_map行(lineUserId/電話/認証/担当・同名複数も検出)＋契約フォームの電話有無。
//   GASエディタで下の氏名を書き換えて実行。selfRegisterが電話照合で失敗していないか等の切り分けに使う。
function debugMemberLink() {
  var 氏名 = '鈴木義堂';   // ← 確認したい会員名に書き換えて実行
  var target = _lbNormName(氏名);
  Logger.log('=== メンバー紐付け診断: ' + 氏名 + ' ===');
  var sh = _lbSheet(LINE_BOOKING.MAP_SHEET);
  var hit = 0;
  if (sh && sh.getLastRow() >= 2) {
    var v = sh.getRange(2, 1, sh.getLastRow() - 1, MAP_COL.GOAL).getValues();
    for (var i = 0; i < v.length; i++) {
      if (_lbNormName(v[i][MAP_COL.NAME - 1]) !== target) continue;
      hit++;
      var lu = String(v[i][MAP_COL.LINE_USER_ID - 1] || '');
      Logger.log('  map行' + (i + 2) + '：lineUserId=' + (lu ? (lu.slice(0, 8) + '…(紐付けあり)') : '❌空(本人端末に未紐付け)') +
        ' / customerId=' + v[i][MAP_COL.CUSTOMER_ID - 1] +
        ' / 電話=' + (v[i][MAP_COL.PHONE - 1] ? ('あり(' + String(v[i][MAP_COL.PHONE - 1]).slice(-4) + ')') : '❌空') +
        ' / 認証=' + v[i][MAP_COL.AUTH_STATE - 1] +
        ' / 担当=' + v[i][MAP_COL.TRAINER_ID - 1]);
    }
  }
  if (!hit) Logger.log('  ⚠️ customer_line_map に「' + 氏名 + '」の行なし');
  var c = _lbFindContract(氏名);
  if (!c) Logger.log('  契約フォーム：❌該当なし（氏名不一致の可能性）');
  else {
    var cp = (c.cols.phone >= 0) ? String(c.row[c.cols.phone] || '') : '';
    Logger.log('  契約フォーム：あり / 電話=' + (cp ? ('あり(' + _lbNormPhone(cp).slice(-4) + ')') : '❌空 ←本人のselfRegisterが NO_CONTRACT_PHONE で失敗する原因'));
  }
  Logger.log('→ 本人端末で残数が出ない典型原因： (a)lineUserId空=本人が登録できていない / (b)契約電話が空で照合不可 / (c)認証≠verified');
}

// 二重登録の統合：本人LINE(lineUserId)と予約を「残数を持つcustomerId」へ寄せ、余分な行を無効化(rejected)。
//   典型：契約電話が空でselfRegisterが既存会員にマッチできず新規customerIdを発番→残数(旧)とLINE(新)が分離。
//   ★GASエディタで下の keep/drop を確認して runMergeMemberLink を実行。冪等（再実行しても壊れない）。
function runMergeMemberLink() {
  var 残すCID = 'C20260826153232';   // ← 残数・移行残高を持つ側（LINEを寄せる先）
  var 消すCID = 'C20260911133249';   // ← 本人がselfRegisterで作った新規側（lineUserIdの出所）
  var r = mergeMemberLink(残すCID, 消すCID);
  Logger.log('=== runMergeMemberLink 結果 ===\n' + JSON.stringify(r));
  return r;
}
function mergeMemberLink(keepCid, dropCid) {
  keepCid = String(keepCid || ''); dropCid = String(dropCid || '');
  if (!keepCid || !dropCid || keepCid === dropCid) return { ok: false, code: 'BAD_ARGS' };
  var sh = _lbSheet(LINE_BOOKING.MAP_SHEET); if (!sh) return { ok: false, code: 'NO_MAP' };
  var lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    var last = sh.getLastRow(); if (last < 2) return { ok: false, code: 'EMPTY' };
    var v = sh.getRange(2, 1, last - 1, MAP_COL.GOAL).getValues();
    var keepRow = -1, dropRow = -1, dLu = '', dPhone = '';
    for (var i = 0; i < v.length; i++) {
      var cid = String(v[i][MAP_COL.CUSTOMER_ID - 1] || '');
      if (cid === keepCid) keepRow = i + 2;
      if (cid === dropCid) { dropRow = i + 2; dLu = String(v[i][MAP_COL.LINE_USER_ID - 1] || ''); dPhone = String(v[i][MAP_COL.PHONE - 1] || ''); }
    }
    if (keepRow < 0 || dropRow < 0) return { ok: false, code: 'ROW_NOT_FOUND', keepRow: keepRow, dropRow: dropRow };
    // keep行へ本人LINE・電話を寄せる（lineUserIdは値があるときだけ＝冪等／電話は空欄補完）
    if (dLu) sh.getRange(keepRow, MAP_COL.LINE_USER_ID).setValue(dLu);
    if (dPhone) _lbSetIfBlank(sh, keepRow, MAP_COL.PHONE, dPhone);
    sh.getRange(keepRow, MAP_COL.AUTH_STATE).setValue('verified');
    // line_reservations の dropCid 予約を keepCid へ付け替え（col3=customer_id）
    var resvSh = _lbSheet(LINE_BOOKING.RESV_SHEET), moved = 0;
    if (resvSh && resvSh.getLastRow() >= 2) {
      // C列(customer_id)だけでなく **D列(line_user_id)も揃える**。
      //   D列を放置すると「トレーナー画面には出るが本人のマイ予約に出ない」ズレが残る（2026-09-18に実害）。
      var rv = resvSh.getRange(2, 3, resvSh.getLastRow() - 1, 2).getValues();   // C:customer_id / D:line_user_id
      for (var j = 0; j < rv.length; j++) {
        if (String(rv[j][0]) !== dropCid && String(rv[j][0]) !== keepCid) continue;
        if (String(rv[j][0]) === dropCid) { resvSh.getRange(j + 2, 3).setValue(keepCid); moved++; }
        if (dLu && String(rv[j][1]) !== String(dLu)) resvSh.getRange(j + 2, 4).setValue(dLu);   // 本人のLINE IDへ揃える
      }
    }
    // drop行を無効化（lineUserId除去＋rejected＝本人LINEの二重紐付けを断つ）
    sh.getRange(dropRow, MAP_COL.LINE_USER_ID).setValue('');
    sh.getRange(dropRow, MAP_COL.AUTH_STATE).setValue('rejected');
    Logger.log('✅ 統合：' + dropCid + '→' + keepCid + ' / lineUserId寄せ=' + (dLu ? 'あり' : 'なし') + ' / 予約' + moved + '件付替 / drop行rejected');
    return { ok: true, keepCid: keepCid, dropCid: dropCid, movedReservations: moved };
  } finally { lock.releaseLock(); }
}

// ペア機能の一気通貫を「仮想顧客」で検証（本番SS/カレンダーへ一切書き込まない・純粋ロジック）。
//   種別=通常／コース=ペアの契約を組み、pack種別・2名/1名の消化枚数・カレンダー接頭辞をログに出す。
//   GASエディタで実行するだけ。合格＝「pack種別pair／2名で2枚／1名で1枚／接頭辞ペア_」。
function testPairFlow() {
  var headers = ['お客様名', '種別', 'コース', '残数方式', 'チケット枚数', '契約終了日', 'チケット単価', '1名来店時単価(ペアトレ)'];
  var cols = _lbContractCols(headers);
  var row = ['検証ペア子', '通常', 'ペアトレーニング', 'チケット', 4, '2026/12/31', 8000, 6000];
  var rows = [{ cols: cols, row: row, start: new Date('2026-07-01'), end: new Date('2026-12-31') }];
  var ent = _lbRowsToEntitlements(rows, 1).entitlements;
  Logger.log('=== ペア機能 仮想検証（本番未書込）===');
  if (!ent.packs.length) { Logger.log('❌ packが作られませんでした（コース列/期限/枚数を確認）'); return; }
  var pk = ent.packs[0], pid = pk.packId;
  Logger.log('① 契約(種別=通常/コース=ペア) → pack種別=「' + pk.kind + '」' + (pk.kind === 'pair' ? '✅' : '❌通常のまま') + ' / 枚数=' + pk.qty + ' / ペア単価=' + pk.unitPrice + ' / 1名来店単価=' + pk.normalUnitPrice);
  function used(att) {
    var r = _lbAllocateSessions('test', ent, [{ sessionId: 's1', startAt: new Date('2026-08-05T10:00:00+09:00').getTime(), channel: 'line', attendeeCount: att, packKind: 'pair' }], { asOfMonth: '2026-08' });
    var p = (r.perPack || []).filter(function (x) { return x.packId === pid; })[0];
    return p ? { used: p.used, rem: p.remaining, ok: r.ok } : { used: '-', rem: '-', ok: r.ok };
  }
  var u2 = used(2), u1 = used(1);
  Logger.log('② ペア予約(2名) → 消化' + u2.used + '枚 / 残' + u2.rem + '枚 ' + (u2.used === 2 ? '✅' : '❌'));
  Logger.log('③ 1名来店 → 消化' + u1.used + '枚 / 残' + u1.rem + '枚 ' + (u1.used === 1 ? '✅' : '❌'));
  var pfx = _lbBookTypePrefix('line', 'pair', '通常', 'ticket');
  Logger.log('④ カレンダー接頭辞 = 「' + pfx + '」' + (pfx === 'ペア_' ? '✅（タイトルはペア_始まり）' : '❌'));
  var allOk = (pk.kind === 'pair' && u2.used === 2 && u1.used === 1 && pfx === 'ペア_');
  Logger.log('=== 判定：' + (allOk ? '✅ 一気通貫OK（契約→ペアpack→2名2枚/1名1枚→タイトルペア_）' : '⚠️ 上の❌を確認') + ' ===');
  Logger.log('※これは仮想データの検証です。本番SS・カレンダーには何も書き込んでいません。');
}

// 指定会員の line_reservations 行を実データで一覧＋重複検出（二重取込の有無を目視確認）。
//   GASエディタで customerId を書き換えて実行。runRemainingDebug のヘッダに出る customerId を貼る。
function debugCustomerReservations() {
  var customerId = 'C20260913112249';   // ← 確認したい会員のcustomerId（今別府利江の例）
  var sh = _lbSheet(LINE_BOOKING.RESV_SHEET);
  if (!sh || sh.getLastRow() < 2) { Logger.log('line_reservations が空です'); return; }
  var v = sh.getRange(2, 1, sh.getLastRow() - 1, 15).getValues();
  Logger.log('=== ' + customerId + ' の line_reservations 行（実データ）===');
  var n = 0, keyCount = {};
  for (var i = 0; i < v.length; i++) {
    if (String(v[i][2]) !== customerId) continue;   // C列(index2)=customer_id
    n++;
    var dt = v[i][0], cname = v[i][1], trId = v[i][4], status = v[i][6], ch = v[i][9], evId = String(v[i][12] || ''), kind = v[i][13];
    var dtStr = '';
    try { dtStr = Utilities.formatDate((dt instanceof Date) ? dt : new Date(dt), SETTINGS.TIMEZONE, 'MM/dd HH:mm'); } catch (e) { dtStr = String(dt); }
    var key = dtStr + '|' + String(trId);
    if (status === 'confirmed' || status === 'consumed') keyCount[key] = (keyCount[key] || 0) + 1;   // 有効行のみ重複判定
    Logger.log('  行' + (i + 2) + '：' + dtStr + ' / 顧客名=「' + cname + '」/ 担当=' + trId + ' / status=' + status + ' / 種別=' + kind + ' / ch=' + ch + ' / evId=' + evId.slice(0, 14));
  }
  Logger.log('→ 計' + n + '行。');
  var dup = 0;
  for (var k in keyCount) if (keyCount[k] > 1) { Logger.log('  ⚠️ 重複疑い: 「' + k + '」が ' + keyCount[k] + '件（同一日時+担当のconfirmed/consumed）'); dup++; }
  if (!dup) Logger.log('  ✅ 有効行に重複なし（同一日時+担当の二重取込は見当たらない）');
}

// 同一calendar_event_id+customerIdのconfirmed/consumed重複を、1件だけ残して他をchangedに是正（残数の多重消化を戻す）。
//   GASエディタで customerId を設定して実行（空文字なら全会員が対象＝影響大なので通常は会員指定）。dryRunで先に確認。
function runDedupeReservations() {
  var customerId = 'C20260913112249';   // ← 是正したい会員のcustomerId（今別府利江の例／''で全会員）
  var dryRun = true;                     // ← まずtrueで確認→問題なければfalseで実行
  var sh = _lbSheet(LINE_BOOKING.RESV_SHEET);
  if (!sh || sh.getLastRow() < 2) { Logger.log('line_reservations が空です'); return; }
  var v = sh.getRange(2, 1, sh.getLastRow() - 1, 14).getValues();
  var seen = {}, targets = [];
  for (var i = 0; i < v.length; i++) {
    if (customerId && String(v[i][2]) !== customerId) continue;
    var st = String(v[i][6]), evId = String(v[i][12] || '');
    if (!evId || (st !== 'confirmed' && st !== 'consumed')) continue;
    var key = evId + '|' + String(v[i][2]);
    if (seen[key]) targets.push({ row: i + 2, resId: String(v[i][8]), dt: String(v[i][0]), name: String(v[i][1]) });   // 2件目以降＝重複
    else seen[key] = true;
  }
  Logger.log('=== 重複是正' + (dryRun ? '（DRYRUN・変更なし）' : '（実行）') + ' 対象=' + (customerId || '全会員') + ' ===');
  Logger.log('残す(1件目)=' + Object.keys(seen).length + '種 / changedにする重複=' + targets.length + '行');
  targets.forEach(function (t) { Logger.log('  行' + t.row + '：' + t.name + ' ' + t.dt + '（resId ' + t.resId + '）' + (dryRun ? ' ←changed予定' : ' →changed')); });
  if (dryRun) { Logger.log('→ 問題なければ dryRun=false に変えて再実行。'); return { dryRun: true, wouldChange: targets.length }; }
  targets.forEach(function (t) { sh.getRange(t.row, 7).setValue('changed'); sh.getRange(t.row, 9).setValue(t.resId + '|重複解消'); });
  Logger.log('✅ ' + targets.length + '行をchangedに是正（1件目のconfirmedは維持）。runRemainingDebugで残数を確認してください。');
  return { dryRun: false, changed: targets.length };
}

// 指定会員の予約(line_reservations)とmapの担当を、1人のトレーナーに統一（表示/残数の担当を揃える）。
//   ※カレンダー(トレーナーcal)側の予定移動やタイトルの担当姓修正は別途Google側で必要な場合がある。dryRun付。
function runSetCustomerTrainer() {
  var customerId = 'C20260913112249';   // ← 対象会員のcustomerId（今別府利江）
  var trainerId = 'B';                   // ← 統一する担当（A=中野／B=鈴木／C=沖）
  var dryRun = true;                     // ← まずtrueで確認→falseで実行
  var tr = _lbTrainerById(trainerId); if (!tr) { Logger.log('❌ 担当ID不正: ' + trainerId); return; }
  var sh = _lbSheet(LINE_BOOKING.RESV_SHEET), rows1 = [];
  if (sh && sh.getLastRow() >= 2) {
    var v = sh.getRange(2, 1, sh.getLastRow() - 1, 15).getValues();
    for (var i = 0; i < v.length; i++) {
      if (String(v[i][2]) !== customerId) continue;
      var st = String(v[i][6]); if (st !== 'confirmed' && st !== 'consumed') continue;
      if (String(v[i][4]) === trainerId) continue;   // 既にその担当
      rows1.push({ row: i + 2, from: String(v[i][4]), dt: String(v[i][0]) });
    }
  }
  var msh = _lbSheet(LINE_BOOKING.MAP_SHEET), mrow = -1, mfrom = '';
  if (msh && msh.getLastRow() >= 2) {
    var mv = msh.getRange(2, 1, msh.getLastRow() - 1, MAP_COL.NOTE).getValues();
    for (var j = 0; j < mv.length; j++) { if (String(mv[j][MAP_COL.CUSTOMER_ID - 1]) === customerId) { mrow = j + 2; mfrom = String(mv[j][MAP_COL.TRAINER_ID - 1]); break; } }
  }
  Logger.log('=== 担当統一' + (dryRun ? '（DRYRUN・変更なし）' : '（実行）') + ' ' + customerId + ' → ' + trainerId + '(' + tr.name + ') ===');
  rows1.forEach(function (r) { Logger.log('  予約 行' + r.row + '：' + r.dt + ' 担当' + r.from + '→' + trainerId); });
  Logger.log('  map行' + mrow + '：担当' + mfrom + (mfrom === trainerId ? '（変更なし）' : '→' + trainerId));
  if (dryRun) { Logger.log('→ 問題なければ dryRun=false で再実行。※カレンダーの予定の担当calは必要ならGoogle側で移動/タイトル担当姓を修正。'); return; }
  rows1.forEach(function (r) { sh.getRange(r.row, 5).setValue(trainerId); sh.getRange(r.row, 6).setValue(tr.name); });
  if (mrow > 0 && mfrom !== trainerId) msh.getRange(mrow, MAP_COL.TRAINER_ID).setValue(trainerId);
  Logger.log('✅ 予約' + rows1.length + '行・map' + (mrow > 0 && mfrom !== trainerId ? 1 : 0) + '行の担当を' + trainerId + '(' + tr.name + ')に統一しました。');
}

function runRemainingDebug() {
  var 氏名 = '森田';   // ← 会員登録名（部分一致で探索。フルネームが確実）
  try { CacheService.getScriptCache().remove('lb_contract_all'); } catch (e) {}
  var map = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (!map || map.getLastRow() < 2) { Logger.log('会員なし'); return; }
  var target = _lbNormName(氏名);
  var vals = map.getRange(2, 1, map.getLastRow() - 1, MAP_COL.NOTE).getValues(), hit = null;
  for (var i = 0; i < vals.length; i++) {
    if (_lbNormName(vals[i][MAP_COL.NAME - 1]).indexOf(target) >= 0 && String(vals[i][MAP_COL.AUTH_STATE - 1]) === 'verified') { hit = vals[i]; break; }
  }
  if (!hit) { Logger.log('⛔ 「' + 氏名 + '」に一致するverified会員が customer_line_map に見つかりません（登録名を確認）。'); return; }
  var customerId = String(hit[MAP_COL.CUSTOMER_ID - 1]), name = String(hit[MAP_COL.NAME - 1]);
  var cstat = String(hit[MAP_COL.CONTRACT_STAT - 1] || '');
  Logger.log('=== 残数デバッグ: ' + name + '（customerId=' + customerId + ' / 契約状態=' + (cstat || '(空)') + '）===');
  var rows = _lbContractRowsAll(name, _lbPhoneByCustomerId(customerId), false, customerId);
  if (rows.migrationGap) Logger.log('⚠️ migrationGap=true → 残数はREVIEW_REQUIRED（ID移行未完了行あり）。要データ整備。');
  if (!rows.length) { Logger.log('⛔ 有効契約行なし（fail-closed＝残数が出ない）。契約フォームの氏名/電話/契約期間を確認。'); return; }
  var sp = _lbSplitRemaining(rows, customerId);
  if (!sp._ok) Logger.log('⚠️ FAIL: 割当器ok=false（残数不正でREVIEW_REQUIRED）issues=' + JSON.stringify(sp._issues));
  var month = _lbCountReservations(customerId, 'month');
  Logger.log('当月消化(month)=' + month + ' / 月額枠=' + sp.avail + ' → 月額残=' + sp.monthlyRem + ' / チケット残=' + sp.ticketRem);
  Logger.log('▶ 予約可能残数(合計)=' + ((sp.monthlyRem || 0) + (sp.ticketRem || 0)));
  var sess = _lbResvSessions(customerId);
  Logger.log('line_reservations 計上セッション数=' + (sess === null ? '読取不可(残数不明)' : sess.length));
  rows.forEach(function (rr) { var cc = rr.cols, r = rr.row; Logger.log('  契約行: 種別=' + (cc.type >= 0 ? r[cc.type] : '') + ' / 方式=' + (cc.method >= 0 ? r[cc.method] : '') + ' / 頻度=' + (cc.freq >= 0 ? r[cc.freq] : '') + ' / チケット=' + (cc.ticket >= 0 ? r[cc.ticket] : '') + ' / 期間=' + (rr.start ? Utilities.formatDate(rr.start, SETTINGS.TIMEZONE, 'yyyy/MM/dd') : '') + '〜' + (rr.end ? Utilities.formatDate(rr.end, SETTINGS.TIMEZONE, 'yyyy/MM/dd') : '(終了日なし)')); });
}

function testLbRemainingDebug() {
  try { CacheService.getScriptCache().remove('lb_contract_all'); } catch (e) {}   // 診断は常に最新の契約フォームを読む（5分キャッシュ回避）
  var map = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (!map || map.getLastRow() < 2) { Logger.log('会員なし'); return; }
  var last = map.getRange(map.getLastRow(), 1, 1, MAP_COL.GOAL).getValues()[0];
  var customerId = last[MAP_COL.CUSTOMER_ID - 1];
  var name = last[MAP_COL.NAME - 1];
  var rows = _lbContractRowsAll(name, _lbPhoneByCustomerId(customerId), false, customerId);
  if (!rows.length) { Logger.log('契約なし（fail-closed対象）'); return; }
  var sp = _lbSplitRemaining(rows, customerId);
  var month = _lbCountReservations(customerId, 'month');
  if (!sp._ok) Logger.log('⚠️ FAIL: 割当器ok=false（残数不正）issues=' + JSON.stringify(sp._issues));   // M1
  Logger.log('=== 残数デバッグ（併存対応）: ' + name + ' ===');
  Logger.log('LINE登録日時: ' + last[MAP_COL.LINKED_AT - 1]);
  Logger.log('有効契約行数: ' + rows.length + '（月額:' + (sp.hasMonthly ? 'あり' : 'なし') + ' / チケット:' + (sp.hasTicket ? 'あり合計' + sp.ticketTotal + '枚' : 'なし') + '）');
  Logger.log('当月消化(month): ' + month);
  Logger.log('月額枠(頻度+繰越): ' + sp.avail + ' → 月額残: ' + sp.monthlyRem);
  Logger.log('チケット合計: ' + sp.ticketTotal + ' → チケット残: ' + sp.ticketRem);
  Logger.log('▶ 予約可能残数(合計): ' + ((sp.monthlyRem || 0) + sp.ticketRem) + '（月額' + (sp.monthlyRem || 0) + '＋チケット' + sp.ticketRem + '）');
  rows.forEach(function (rr) {
    var cc = rr.cols, r = rr.row;
    Logger.log('  行: 種別=' + (cc.type >= 0 ? r[cc.type] : '') + ' / 方式=' + (cc.method >= 0 ? r[cc.method] : '') +
      ' / 頻度=' + (cc.freq >= 0 ? r[cc.freq] : '') + ' / チケット=' + (cc.ticket >= 0 ? r[cc.ticket] : '') +
      ' / ' + (rr.start ? Utilities.formatDate(rr.start, SETTINGS.TIMEZONE, 'yyyy/MM/dd') : '') + '〜' + (rr.end ? Utilities.formatDate(rr.end, SETTINGS.TIMEZONE, 'yyyy/MM/dd') : ''));
  });
}

// reconciliation診断（読み取り専用・PIIマスク）：line_reservations 正本と B1カレンダーの乖離を検出。
//   ・GHOST：SSにconfirmed/consumedがあるのにカレンダー予定が無い（席が実際は空＝取りこぼし/補償ギャップ）
//   ・ORPHAN：カレンダーに _line 予定があるのにSSに予約が無い（席は埋まるが残数未計上＝部分失敗の孤児）
//   Codexの段階2→3繰越条件。オーナー/CEOがGASエディタで実行し、乖離があれば手当て。
function _lbReconcile(daysAhead) {
  daysAhead = daysAhead || 60;
  var now = new Date(), until = new Date(now.getTime() + daysAhead * 86400000);
  var mask = function (s) { s = String(s || ''); return s ? s.slice(0, 1) + '***' : '(空)'; };
  var tz = SETTINGS.TIMEZONE;
  var fmt = function (t) { return Utilities.formatDate(new Date(t), tz, 'MM/dd HH:mm'); };
  var ssRows = [];
  var sh = _lbSheet(LINE_BOOKING.RESV_SHEET);
  if (sh && sh.getLastRow() >= 2) {
    var vals = sh.getRange(2, 1, sh.getLastRow() - 1, 11).getValues();
    for (var i = 0; i < vals.length; i++) {
      var r = vals[i]; var st = String(r[6]); if (st !== 'confirmed' && st !== 'consumed') continue;
      if (String(r[9]) === 'transfer') continue;   // 振替は独立枠・在席照合の対象外
      var dt = _lbParseResvDate(r[0]); if (!dt) continue;
      if (dt.getTime() < now.getTime() || dt.getTime() > until.getTime()) continue;
      ssRows.push({ t: dt.getTime(), name: _lbNormName(r[1]), status: st });
    }
  }
  // カレンダーは状態別に分類：[RESERVED]→在席(reserved)／[消化]→消化(consumed)。正当な当日消化を誤検知しない（H-1）。
  var calItems = [];
  var calB1 = CalendarApp.getCalendarById(CALENDAR_IDS.CAPACITY_B1);
  var evs = calB1 ? calB1.getEvents(now, until) : [];
  for (var e = 0; e < evs.length; e++) {
    var title = evs[e].getTitle();
    if (title.indexOf('_line') < 0) continue;          // LINE予約のみ
    var cls, inner;
    if (title.indexOf('[消化]') === 0) { cls = 'consumed'; inner = title.replace('[消化]', '').trim(); }
    else if (title.indexOf('[RESERVED]') === 0) { cls = 'reserved'; inner = title.replace('[RESERVED]', '').trim(); }
    else continue;
    var parts = inner.split('_');
    calItems.push({ t: evs[e].getStartTime().getTime(), name: parts.length >= 3 ? _lbNormName(parts[2]) : '', cls: cls });
  }
  // status別に期待カレンダー種別を対応（confirmed↔reserved／consumed↔consumed）。60秒窓は境界含む。
  function findMatch(t, name, cls) { for (var k = 0; k < calItems.length; k++) if (!calItems[k]._used && calItems[k].cls === cls && calItems[k].name === name && Math.abs(calItems[k].t - t) <= 60000) return k; return -1; }
  var ghost = [], orphan = [];
  for (var s = 0; s < ssRows.length; s++) {
    var expect = (ssRows[s].status === 'confirmed') ? 'reserved' : 'consumed';
    var idx = findMatch(ssRows[s].t, ssRows[s].name, expect);
    if (idx < 0) ghost.push(ssRows[s]); else calItems[idx]._used = true;
  }
  for (var c = 0; c < calItems.length; c++) if (!calItems[c]._used) orphan.push(calItems[c]);
  Logger.log('=== reconciliation（今後' + daysAhead + '日・読み取り専用・オーナー診断）===');
  Logger.log('SS confirmed/consumed: ' + ssRows.length + ' / B1 _lineイベント(在席+消化): ' + calItems.length);
  Logger.log('⚠️ GHOST（SS予約ありカレンダー種別不一致/無し）: ' + ghost.length);
  ghost.slice(0, 10).forEach(function (g) { Logger.log('  ' + fmt(g.t) + ' ' + mask(g.name) + ' [' + g.status + ']'); });
  Logger.log('⚠️ ORPHAN（カレンダーありSS予約無し）: ' + orphan.length);
  orphan.slice(0, 10).forEach(function (o) { Logger.log('  ' + fmt(o.t) + ' ' + mask(o.name) + ' [' + o.cls + ']'); });
  return { ghost: ghost.length, orphan: orphan.length, ssCount: ssRows.length, calCount: calItems.length };
}

// 運用確認用・読み取りのみ：trainer_masterとCALENDAR_IDS.TRAINERSの照合＝トレーナー通知が飛ばない原因の切り分け
function testLbTrainers() {
  var sh = _lbSheet(LINE_BOOKING.TRAINER_SHEET);
  if (!sh || sh.getLastRow() < 2) { Logger.log('trainer_master なし/空'); return; }
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, TR_COL.ACTIVE).getValues();
  Logger.log('=== trainer_master（登録内容）===');
  vals.forEach(function (r) {
    var luid = String(r[TR_COL.LINE_USER_ID - 1] || '');
    Logger.log('trainer_id=' + r[TR_COL.TRAINER_ID - 1] + ' / name=' + r[TR_COL.NAME - 1] +
      ' / line_user_id=' + (luid ? (luid.slice(0, 8) + '…登録あり') : '❌未登録') + ' / active=' + r[TR_COL.ACTIVE - 1]);
  });
  Logger.log('=== 予約時の通知先（CALENDAR_IDS.TRAINERS × getTrainerLineId）===');
  CALENDAR_IDS.TRAINERS.forEach(function (t) {
    Logger.log('id=' + t.id + ' / name=' + t.name + ' / 通知先=' + (getTrainerLineId(t.id) ? '✅取得OK' : '❌空（通知が飛ばない）'));
  });
}

// テスト専用・読み取りのみ（書き込まない）：現在の実行環境とシート状態を診断
function testLbDiagnose() {
  var props = PropertiesService.getScriptProperties();
  var stagingId = props.getProperty('STAGING_SPREADSHEET_ID');
  var targetId = stagingId || SETTINGS.SPREADSHEET_ID;
  var env = stagingId ? '✅ STAGING（テストSS）' : '⚠️ 本番SS（STAGING_SPREADSHEET_ID未登録）';
  var ss = SpreadsheetApp.openById(targetId);
  var names = ss.getSheets().map(function (s) { return s.getName(); });
  Logger.log('環境: ' + env);
  Logger.log('対象SS ID: ' + targetId);
  Logger.log('customer_line_map: ' + (ss.getSheetByName(LINE_BOOKING.MAP_SHEET) ? 'あり' : '❌ なし'));
  Logger.log('trainer_master: ' + (ss.getSheetByName('trainer_master') ? 'あり' : '❌ なし'));
  Logger.log('line_reservations: ' + (ss.getSheetByName('line_reservations') ? 'あり' : '❌ なし'));
  Logger.log('全シート: ' + names.join(', '));
  Logger.log('--- Script Properties（値は出さず有無のみ）---');
  ['LINE_CHANNEL_ID','LINE_LIFF_ID','LINE_MESSAGING_TOKEN','LINE_ADMIN_TOKEN',
   'LINE_WEBHOOK_TOKEN','LINE_CODE_SALT','LINE_CHANNEL_ACCESS_TOKEN','STAGING_SPREADSHEET_ID'
  ].forEach(function (k) {
    Logger.log(k + ': ' + (props.getProperty(k) ? '✅あり' : '❌なし'));
  });
}

// ============================================================
// セルフテスト — バックエンドの主要ロジックをLIFF抜きで一括検証（読み取りのみ・副作用なし）
//   GASエディタで実行 → ログの ✅/❌ で健全性を確認。実機LIFFは最終の見た目確認だけに絞れる。
// ============================================================
// 日次reconcile（移行B3・読取専用）：カレンダー↔line_reservations↔未紐付けの乖離を照合。
//   (a)DBにevent_idありなのにB1に該当イベント無し（カレンダー削除の疑い）
//   (b)B1に_lineイベントありなのにDBに未収録（DB漏れ）(c)DB内のevent_id重複 (d)未紐付け残 (e)当日以降の負残数
//   安定化監視・GO判定の根拠。差分ゼロが健全。
function reconcileDaily() {
  var out = { calMissing: [], dbMissing: [], dupEvent: [], unlinked: 0, negativeRemaining: [] };
  var rsh = _lbSheet(LINE_BOOKING.RESV_SHEET);
  var now = new Date().getTime();
  var byEvent = {}, futureRows = [];
  if (rsh && rsh.getLastRow() >= 2) {
    var rv = rsh.getRange(2, 1, rsh.getLastRow() - 1, Math.max(14, rsh.getLastColumn())).getValues();
    for (var i = 0; i < rv.length; i++) {
      if (String(rv[i][6]) !== 'confirmed') continue;            // 今後のconfirmedのみ
      var dt = _lbParseResvDate(rv[i][0]); if (!dt || dt.getTime() < now) continue;
      var ev = String(rv[i][12] || '');                          // col13=calendar_event_id
      futureRows.push({ ev: ev, name: String(rv[i][1] || ''), when: _lbFmtResvLabel(rv[i][0]), cid: String(rv[i][2] || '') });
      if (ev) { if (byEvent[ev]) out.dupEvent.push(ev); else byEvent[ev] = true; }
    }
  }
  // B1カレンダーの今後の _line イベント
  var calB1 = CalendarApp.getCalendarById(CALENDAR_IDS.CAPACITY_B1);
  var evs = calB1.getEvents(new Date(now), new Date(now + 60 * 86400000));
  var calIds = {};
  for (var e = 0; e < evs.length; e++) {
    var t = evs[e].getTitle(); if (t.indexOf('_line') < 0) continue; if (t.indexOf('[消化]') === 0 || t.indexOf('✅') === 0) continue;
    var id = evs[e].getId(); calIds[id] = true;
    if (!byEvent[id]) out.dbMissing.push(_lbFmtResvLabel(Utilities.formatDate(evs[e].getStartTime(), SETTINGS.TIMEZONE, 'yyyy/MM/dd HH:mm')) + ' ' + t);
  }
  // DBにevent_idありなのにカレンダーに無い
  for (var f = 0; f < futureRows.length; f++) { if (futureRows[f].ev && !calIds[futureRows[f].ev]) out.calMissing.push(futureRows[f].name + ' ' + futureRows[f].when); }
  // 未紐付け
  var ush = _lbSheet('line_unlinked'); if (ush && ush.getLastRow() >= 2) out.unlinked = ush.getLastRow() - 1;
  // 負残数（verified会員）
  var mems = _lbActiveMembers();
  for (var m = 0; m < mems.length; m++) {
    var rows = _lbContractRowsAll(mems[m].name, _lbPhoneByCustomerId(mems[m].customerId), false, mems[m].customerId);
    if (!rows.length || rows.migrationGap) continue;
    var sp = _lbSplitRemaining(rows, mems[m].customerId);
    if (sp._ok && ((sp.monthlyRem != null && sp.monthlyRem < 0) || (sp.ticketRem != null && sp.ticketRem < 0))) out.negativeRemaining.push(mems[m].name + '(月' + sp.monthlyRem + '/券' + sp.ticketRem + ')');
  }
  var total = out.calMissing.length + out.dbMissing.length + out.dupEvent.length + out.unlinked + out.negativeRemaining.length;
  Logger.log('=== reconcileDaily === ' + (total === 0 ? '✅ 差分ゼロ' : '⚠️ 要確認 ' + total + '件'));
  if (out.calMissing.length) Logger.log('⚠️ カレンダーに無い(DB confirmed): ' + out.calMissing.join(' / '));
  if (out.dbMissing.length) Logger.log('⚠️ DB未収録のB1 _lineイベント: ' + out.dbMissing.join(' / '));
  if (out.dupEvent.length) Logger.log('⚠️ event_id重複: ' + out.dupEvent.join(','));
  if (out.unlinked) Logger.log('⚠️ 未紐付け(line_unlinked): ' + out.unlinked + '件');
  if (out.negativeRemaining.length) Logger.log('⚠️ 負の残数: ' + out.negativeRemaining.join(' / '));
  return { ok: total === 0, total: total, detail: out };
}

// 会員募集前セットアップ診断（引数なし）。値は出さず存在/読取可否のみ報告（機密は伏せる）。
//   会員登録E2Eの前提（LIFF/トークン/契約シート/環境モード）が揃っているかを一発で確認する。
function testLbSetupCheck() {
  function has(k) { return !!_lbProp(k); }
  Logger.log('=== LINE予約 セットアップ診断 ===');
  // 1) 環境モード（本番会員登録の前に staging系プロパティは必ずクリア）
  var staging = has('STAGING_SPREADSHEET_ID');
  Logger.log((staging ? '⚠️' : '✅') + ' 環境モード: ' + (staging ? 'STAGING（会員登録/予約が staging SS に入る＝本番募集前に STAGING_SPREADSHEET_ID を削除）' : '本番'));
  if (has('STAGING_CONTRACT_SS_ID')) Logger.log('⚠️ STAGING_CONTRACT_SS_ID 設定中＝契約照合が staging側。本番募集前に削除');
  // 2) 必須プロパティ（値は出さず存在のみ）
  Logger.log((has('LINE_LIFF_ID') ? '✅' : '❌') + ' LINE_LIFF_ID ' + (has('LINE_LIFF_ID') ? '設定済' : '未設定＝ミニアプリ起動不可'));
  Logger.log((has('LINE_CHANNEL_ACCESS_TOKEN') ? '✅' : '❌') + ' LINE_CHANNEL_ACCESS_TOKEN ' + (has('LINE_CHANNEL_ACCESS_TOKEN') ? '設定済' : '未設定＝ID token検証/通知不可'));
  Logger.log((has('LINE_CODE_SALT') ? '✅' : '⚠️') + ' LINE_CODE_SALT ' + (has('LINE_CODE_SALT') ? '設定済' : '未設定＝認証番号hash用'));
  Logger.log((has('LINE_WEBHOOK_TOKEN') ? '✅' : '⚠️') + ' LINE_WEBHOOK_TOKEN ' + (has('LINE_WEBHOOK_TOKEN') ? '設定済' : '未設定＝Webhook検証用(任意)'));
  // 3) Web App URL（LIFFエンドポイントがこのURLと一致している必要あり）
  try { Logger.log('📍 Web App URL（LIFFのエンドポイントURLがこれと一致か確認）: ' + ScriptApp.getService().getUrl()); } catch (e) { Logger.log('⚠️ Web App URL取得不可（デプロイ未/権限）: ' + e.message); }
  // 4) 契約シート（登録の名前+電話照合の元）
  var csh = _lbContractSheet();
  if (csh) { var cn = csh.getParent().getName(), rows = Math.max(0, csh.getLastRow() - 1); Logger.log((rows > 0 ? '✅' : '⚠️') + ' 契約シート読取可: 「' + cn + '」' + rows + '行' + (rows === 0 ? '（テスト契約1件を入れると登録照合できる）' : '')); }
  else Logger.log('❌ 契約シート読取不可（CONTRACT_SS_ID/権限）');
  // 5) 会員・トレーナー基盤
  Logger.log((_lbSheet(LINE_BOOKING.MAP_SHEET) ? '✅' : '❌') + ' customer_line_map シート');
  var tr = getTrainers(); Logger.log(((tr && tr.success && tr.trainers && tr.trainers.length) ? '✅' : '❌') + ' トレーナー登録: ' + ((tr && tr.trainers) ? tr.trainers.length : 0) + '名');
  Logger.log('=== 診断終了（❌/⚠️ を解消してから会員E2E）===');
  return { staging: staging, liff: has('LINE_LIFF_ID'), token: has('LINE_CHANNEL_ACCESS_TOKEN') };
}

function testLbSelfCheck() {
  var pass = 0, fail = 0;
  function check(name, cond) { Logger.log((cond ? '✅' : '❌') + ' ' + name); if (cond) pass++; else fail++; }

  // 1) 環境・シート
  check('staging環境である', !!_lbProp('STAGING_SPREADSHEET_ID'));
  check('customer_line_map あり', !!_lbSheet(LINE_BOOKING.MAP_SHEET));
  check('line_reservations あり', !!_lbSheet(LINE_BOOKING.RESV_SHEET));

  // 2) 前日17時判定（無料/消化の境界ロジック）
  var day2 = new Date(new Date().getTime() + 2 * 24 * 3600 * 1000); day2.setHours(10, 0, 0, 0);
  check('2日後10時の予約は無料キャンセル可', _lbIsFreeCancelWindow(day2) === true);
  var soon = new Date(new Date().getTime() + 3600 * 1000);
  check('1時間後の予約は消化(無料でない)', _lbIsFreeCancelWindow(soon) === false);

  // 3) 日付パース・整形
  check('文字列"2026/07/27 08:00"をDateに', _lbParseResvDate('2026/07/27 08:00') instanceof Date);
  check('Date型はそのまま通る', _lbParseResvDate(new Date()) instanceof Date);
  check('不正文字列はnull', _lbParseResvDate('xxx') === null);
  check('整形が「M月d日(曜) HH:mm」形式', /月.+日\(.\)\s\d{1,2}:\d{2}/.test(_lbFmtResvLabel('2026/07/27 08:00')));

  // 4) 主要ハンドラ関数の存在（handleLineGetのcaseが呼ぶ実体）
  ['getMemberStatus','verifyMembership','getTrainers','getTrainerSlots',
   'makeReservationLine','getMyReservations','cancelReservationLine','changeReservationLine'].forEach(function (fn) {
    check('関数 ' + fn + ' が存在', eval('typeof ' + fn) === 'function');   // 固定名の存在確認（安全）
  });

  // 5) トレーナー一覧が取れる
  var tr = getTrainers();
  check('getTrainers()がトレーナーを返す', tr && tr.success && tr.trainers && tr.trainers.length > 0);

  // 6) 残数チェックが応答する（契約未登録は degraded＝okで素通り＝移行期の設計どおり）
  var rem = getBookableRemaining('___nobody___', 'ticket', '___nobody___');
  check('getBookableRemaining が {ok} を返す', rem && typeof rem.ok === 'boolean');
  check('未登録顧客は degraded(ok=true)', rem.ok === true && rem.degraded === true);
  check('_lbCountReservations が数値を返す', typeof _lbCountReservations('___nobody___', 'future') === 'number');

  Logger.log('=== セルフテスト結果: ' + pass + '件合格 / ' + fail + '件失敗 ===');
  return { pass: pass, fail: fail };
}

// ============================================================
// 前日リマインダーのトリガー設定 — sendLineReminders を毎日12時に実行（重複登録を防止）
//   オーナーがGASエディタで1回実行するだけ。
// ============================================================
function setupLineTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var h = t.getHandlerFunction();
    if (h === 'sendLineReminders' || h === 'syncContractStatus' || h === 'dailySync' || h === 'checkLineQuota' || h === 'weeklyPaceReport' || h === 'refreshPaceBoard' || h === 'dailyHealthCheck') ScriptApp.deleteTrigger(t);   // 重複登録防止
  });
  ScriptApp.newTrigger('sendLineReminders').timeBased().everyDays(1).atHour(12).inTimezone(SETTINGS.TIMEZONE).create();
  ScriptApp.newTrigger('syncContractStatus').timeBased().everyDays(1).atHour(3).inTimezone(SETTINGS.TIMEZONE).create();   // 退会/失効の自動降格を毎日3時
  ScriptApp.newTrigger('dailySync').timeBased().everyHours(6).create();   // 移行(autoRollingMigrate)廃止後の恒久カレンダー同期（6時間毎）
  ScriptApp.newTrigger('checkLineQuota').timeBased().everyDays(1).atHour(8).inTimezone(SETTINGS.TIMEZONE).create();   // LINE通数の残量監視（8割/9.5割でメール警告）
  ScriptApp.newTrigger('refreshPaceBoard').timeBased().everyDays(1).atHour(6).inTimezone(SETTINGS.TIMEZONE).create();   // 消化ペースの集計（画面はこの結果を読むだけ＝一瞬）
  ScriptApp.newTrigger('dailyHealthCheck').timeBased().everyDays(1).atHour(7).inTimezone(SETTINGS.TIMEZONE).create();   // 会員/予約/カレンダー/通知の点検（悪化時だけメール）
  ScriptApp.newTrigger('weeklyPaceReport').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(8).inTimezone(SETTINGS.TIMEZONE).create();   // 消化ペースの週次フォロー候補
  Logger.log('✅ 前日リマインダー(12時)＋契約状態同期(3時)＋カレンダー同期(dailySync 6時間毎)＋LINE通数監視(8時)＋消化ペース集計(毎日6時)＋システム点検(毎日7時)＋週次フォロー(月曜8時)を設定しました。');
}

// ============================================================
// 移行(autoRollingMigrate)廃止後の恒久カレンダー同期。
//   syncExistingReservations を単独で回し、カレンダーの予約/セッションを会員の残数・マイ予約へ反映する。
//   移行完了後は残高再承認(runCutoverApprove)は不要なので呼ばない。トリガーは setupLineTriggers（6時間毎）。
//   失敗は sync_status シートに1行記録して黙って止まらない（migrate_status と同方針）。冪等（重複取込は同期側でdedup）。
// ============================================================
var LB_SYNC_STATUS_SHEET = 'sync_status';
function dailySync() {
  var r;
  try { r = syncExistingReservations(); } catch (e) { r = { success: false, code: 'EXCEPTION', message: e.message }; }
  try {
    var ss = _lbSs(); var sh = ss.getSheetByName(LB_SYNC_STATUS_SHEET) || ss.insertSheet(LB_SYNC_STATUS_SHEET);
    if (sh.getLastRow() === 0) { sh.getRange(1, 1, 1, 3).setValues([['実行時刻', '結果', '詳細']]).setFontWeight('bold'); sh.setFrozenRows(1); }
    var when = Utilities.formatDate(new Date(), SETTINGS.TIMEZONE, 'yyyy/MM/dd HH:mm');
    var okTxt = (r && r.success) ? ('✅同期' + (r.synced != null ? r.synced + '件' : '') + (r.unlinked ? '／未紐付け' + r.unlinked : '')) : ('⚠️' + (r && r.code ? r.code : 'error'));
    sh.insertRowsAfter(1, 1); sh.getRange(2, 1, 1, 3).setValues([["'" + when, okTxt, String(JSON.stringify(r)).slice(0, 500)]]);
  } catch (e2) { Logger.log('sync_status記録失敗: ' + e2.message); }
  Logger.log('dailySync: ' + JSON.stringify(r));
  return r;
}

function setupLineBookingSheets() {
  var ss = _lbSs();

  // 冪等化：既存シートでもヘッダーを常時設定し各段階でflush（タイムアウト中断からの再実行で修復可能）
  var map = ss.getSheetByName(LINE_BOOKING.MAP_SHEET) || ss.insertSheet(LINE_BOOKING.MAP_SHEET);
  map.getRange(1, 1, 1, MAP_COL.LANG).setValues([[
    'line_user_id','customer_id','顧客名','電話番号','reserved_trainer_id',
    '契約種別','contract_status','認証状態','紐付け日時','認証番号hash',
    '認証番号有効期限','認証試行回数','備考','email','birthday','goal','lang'
  ]]);
  SpreadsheetApp.flush();
  Logger.log('customer_line_map OK');

  var tr = ss.getSheetByName(LINE_BOOKING.TRAINER_SHEET) || ss.insertSheet(LINE_BOOKING.TRAINER_SHEET);
  tr.getRange(1, 1, 1, TR_COL.NAME_EN).setValues([[
    'line_user_id','trainer_id','name','role','active','name_en'
  ]]);
  if (tr.getLastRow() < 2) {   // トレーナー行が無ければ設定（既存のline_user_id登録があれば保持）
    var rows = CALENDAR_IDS.TRAINERS.map(function(t){ return ['', t.id, t.name, 'trainer', true, '']; });   // name_en は空欄（オーナーが後から記入）
    tr.getRange(2, 1, rows.length, TR_COL.NAME_EN).setValues(rows);
  }
  SpreadsheetApp.flush();
  Logger.log('trainer_master OK（line_user_id は登録待ち）');

  var resv = ss.getSheetByName(LINE_BOOKING.RESV_SHEET) || ss.insertSheet(LINE_BOOKING.RESV_SHEET);
  resv.getRange(1, 1, 1, 11).setValues([[
    '予約日時', '顧客名', 'customer_id', 'line_user_id', 'trainer_id',
    'トレーナー名', 'status', 'payment_flag', '備考', 'channel', '記録日時'
  ]]);
  SpreadsheetApp.flush();
  Logger.log('line_reservations OK');

  var salt = _lbProp('LINE_CODE_SALT');
  if (!salt) {
    var gen = Utilities.getUuid() + ':' + _lbRandomCode(8);
    PropertiesService.getScriptProperties().setProperty('LINE_CODE_SALT', gen);
    Logger.log('LINE_CODE_SALT 生成・保存');
  }
  Logger.log('=== setupLineBookingSheets 完了 ===');
}

// ============================================================
// staging用SS作成（憲法第13節・書き込みを伴うためテストSSで検証）
//   本番と同構造（ヘッダーのみ）の customer_line_map / trainer_master を新SSに作り、
//   STAGING_SPREADSHEET_ID を Script Properties に登録する。
// ============================================================
function setupStagingSpreadsheet() {
  var props = PropertiesService.getScriptProperties();
  var existing = props.getProperty('STAGING_SPREADSHEET_ID');
  if (existing) { Logger.log('staging SS 既存: ' + existing); return existing; }

  var ss = SpreadsheetApp.create('TOKOWAKA_LINE予約_staging（テスト用・本番データなし）');
  var map = ss.getSheets()[0].setName(LINE_BOOKING.MAP_SHEET);
  ss.getSheetByName(LINE_BOOKING.MAP_SHEET).getRange(1, 1, 1, MAP_COL.NOTE).setValues([[
    'line_user_id','customer_id','顧客名','電話番号','reserved_trainer_id',
    '契約種別','contract_status','認証状態','紐付け日時','認証番号hash',
    '認証番号有効期限','認証試行回数','備考'
  ]]);
  var tr = ss.insertSheet(LINE_BOOKING.TRAINER_SHEET);
  tr.getRange(1, 1, 1, TR_COL.NAME_EN).setValues([['line_user_id','trainer_id','name','role','active','name_en']]);

  var id = ss.getId();
  props.setProperty('STAGING_SPREADSHEET_ID', id);
  Logger.log('✅ staging SS 作成: ' + id);
  Logger.log('URL: ' + ss.getUrl());
  Logger.log('⚠️ 本番デプロイ環境では STAGING_SPREADSHEET_ID を設定しないこと。');
  return id;
}

// ============================================================
// ============  Phase 2: 予約コア（空き枠・予約確定）  ============
// ============================================================

// トレーナー3名リスト（LIFFのトレーナー先選択UI用）
// 未登録客の枠作成の担当選択用：全トレーナー(hidden中野含む)を返す。越権は_lbAdminSlotGuardが最終遮断（一般トレーナーは自分の担当枠のみ）。
function getAllTrainers(lineUserId) {
  var tr = requireTrainer(lineUserId); if (!tr) return { success: false, code: 'FORBIDDEN' };
  return { success: true, isOwner: _lbIsOwnerRole(tr), myTrainerId: String(tr.trainerId || ''),
    trainers: CALENDAR_IDS.TRAINERS.map(function (t) { return { id: t.id, name: t.name }; }) };
}

function getTrainers(lineUserId) {
  var lang = _lbMemberLang(lineUserId);   // 会員/トレーナーの言語で表示名を差し替え
  var enMap = _lbTrainerEnMap();
  // 会員の担当trainerId。hidden(中野=オーナー等)は原則非表示だが、【担当が本人の顧客＝固定客】にだけは選択肢に出す。
  var myTrainerId = '';
  var rec = getCustomerByLine(lineUserId);
  if (rec) myTrainerId = String(rec.data[MAP_COL.TRAINER_ID - 1] || '');
  return {
    success: true,
    trainers: CALENDAR_IDS.TRAINERS.filter(function (t) { return !t.hidden || String(t.id) === myTrainerId; }).map(function (t) { return { id: t.id, name: _lbTrainerNameLang(t.id, t.name, lang, enMap) }; })
  };
}
// オーナー/管理者ロールか（全顧客の閲覧・操作を許可）
function _lbIsOwnerRole(tr) { return !!(tr && (tr.role === 'owner' || tr.role === 'admin')); }
// 全verified会員（オーナーの全顧客ビュー用）
function _lbAllVerifiedCustomers() {
  var msh = _lbSheet(LINE_BOOKING.MAP_SHEET), out = [], seen = {};
  if (!msh || msh.getLastRow() < 2) return out;
  var mv = msh.getRange(2, 1, msh.getLastRow() - 1, MAP_COL.NOTE).getValues();
  for (var i = 0; i < mv.length; i++) {
    if (String(mv[i][MAP_COL.AUTH_STATE - 1]) !== 'verified') continue;
    var cid = String(mv[i][MAP_COL.CUSTOMER_ID - 1] || ''); if (!cid || seen[cid]) continue;
    seen[cid] = true;
    out.push({ customerId: cid, name: String(mv[i][MAP_COL.NAME - 1] || '') });
  }
  return out;
}

// 選択トレーナーの空き枠（既存 getCachedSlots を流用＝事前計算を直読み・TECH_SPEC §8.5）
function getTrainerSlots(body) {
  var trainerId = String((body && body.trainerId) || '');
  if (!trainerId) return { success: false, code: 'BAD_REQUEST', message: 'trainerId必須' };
  // 変更/振替時は自分の旧予定を除外してリアルタイム計算（キャッシュは元予定を含み22:00等が候補に出ない＝問題2）
  var exISO = body && body.excludeStartISO;
  if (exISO && !isNaN(new Date(exISO).getTime())) {
    var exMs = new Date(exISO).getTime();
    var rt = buildAvailableSlots(exMs).filter(function (s) { return String(s.trainerId) === trainerId; });
    return { success: true, slots: rt };
  }
  var slots = getCachedSlots(trainerId); // 既存グローバル（コード.js）: trainerIdでフィルタ済み
  return { success: true, slots: slots };
}

// CALENDAR_IDS.TRAINERS から id で引く
function _lbTrainerById(id) {
  var list = CALENDAR_IDS.TRAINERS.filter(function (t) { return t.id === id; });
  return list.length ? list[0] : null;
}

// 担当トレーナー名（契約フォーム）→ trainerId（CALENDAR_IDS.TRAINERSの名前と部分一致）
function _lbTrainerIdByName(name) {
  if (!name) return '';
  var n = _lbNormName(name);
  if (!n) return '';
  var hit = CALENDAR_IDS.TRAINERS.filter(function (t) {
    var tn = _lbNormName(t.name);
    return tn && (tn.indexOf(n) >= 0 || n.indexOf(tn) >= 0);
  });
  return hit.length ? hit[0].id : '';
}

// trainer_master から trainerId の line_user_id を引く（トレーナー通知用）
function getTrainerLineId(trainerId) {
  var sh = _lbSheet(LINE_BOOKING.TRAINER_SHEET);
  if (!sh) return '';
  var last = sh.getLastRow();
  if (last < 2) return '';
  var values = sh.getRange(2, 1, last - 1, TR_COL.ACTIVE).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][TR_COL.TRAINER_ID - 1]) === String(trainerId)) {
      return String(values[i][TR_COL.LINE_USER_ID - 1] || '');
    }
  }
  return '';
}

// 選択トレーナーが該当時間に予約可能か（出勤シフト内かつ未予約）をリアルタイム照合
// 既存 makeReservation 内 checkTrainerAvailable と同ロジック（isShiftEvent はコード.jsのグローバル）
function _lbCheckTrainerAvailable(trainer, start, end, excludeStart) {
  var cal = CalendarApp.getCalendarById(trainer.email);
  if (!cal) return false;
  var evs = cal.getEvents(start, end);
  var shifts = [], reserved = [];
  for (var j = 0; j < evs.length; j++) {
    var t = evs[j].getTitle();
    if (isShiftEvent(t)) {
      shifts.push({ start: evs[j].getStartTime(), end: evs[j].getEndTime() });
    } else if (_lbIsBusyTitle(t)) {   // 休憩・ブロックも埋まり扱い。判定は コード.js の1か所に寄せた（2026-10-02）
      if (excludeStart && evs[j].getStartTime().getTime() === excludeStart) continue;   // 変更/振替元(自分の旧予定)は除外（問題2）
      reserved.push({ start: evs[j].getStartTime(), end: evs[j].getEndTime() });
    }
  }
  var onShift = shifts.some(function (sh) { return start >= sh.start && end <= sh.end; });
  var notBooked = !reserved.some(function (r) { return start < r.end && end > r.start; });
  return onShift && notBooked;
}

// 1F担当ブロック(Codex#1)の点灯フラグ。既定OFF＝現行挙動（staging無し環境で安全にデプロイ→検証後にON）。
//   ONで空き枠エンジン・予約確定の両方が1Fオンライン等でトレーナーを塞ぐ。カットオーバー前にperf_test検証してON。
function _lb1FBlockEnabled() {
  try { return String(PropertiesService.getScriptProperties().getProperty('LB_1F_TRAINER_BLOCK') || '') === 'on'; } catch (e) { return false; }
}

// 1Fカレンダーの予約を担当姓で帰属し、トレーナー別busy＋帰属不能(fail-closed)を返す（Codex#1）。
//   オンライン等はB1容量を使わず担当トレーナーだけ塞ぐ運用。空き枠エンジン・予約確定検査の両方が共通利用。
//   1Fの予約(種別_担当姓_顧客の3分割)のみ対象＝1Fの非予約(打合せ等)は無視。担当姓不明はblockAll(全員ブロック=安全側)。
function _lb1FTrainerBusy(startD, endD) {
  var out = { ok: false, trainerBusy: {}, blockAll: [] };
  var surToId = {};
  for (var i = 0; i < CALENDAR_IDS.TRAINERS.length; i++) { var tr = CALENDAR_IDS.TRAINERS[i]; out.trainerBusy[tr.id] = []; surToId[_lbNormTok(tr.name.split(' ')[0])] = tr.id; }
  var copts = { b1Id: CALENDAR_IDS.CAPACITY_B1, oneFId: CALENDAR_IDS.CAPACITY_1F, surToId: surToId, isMember: function () { return false; } };
  try {
    var cal = CalendarApp.getCalendarById(CALENDAR_IDS.CAPACITY_1F);
    if (!cal) { Logger.log('⚠️ 1Fカレンダー取得不能（fail-closed）'); return out; }   // ok=false のまま返す（Codex#3・呼出側で予約拒否）
    var evs = cal.getEvents(startD, endD);
    for (var e = 0; e < evs.length; e++) {
      var cls = _lbClassifyBooking(String(evs[e].getTitle()), CALENDAR_IDS.CAPACITY_1F, copts);
      if (!cls.parsed) continue;                 // 1Fの非予約は無視（1Fは体験/オンライン用・容量には数えない）
      var evId = ''; try { evId = evs[e].getId(); } catch (x) {}
      var iv = { start: evs[e].getStartTime(), end: evs[e].getEndTime(), evId: evId };
      if (cls.trainerId) out.trainerBusy[cls.trainerId].push(iv);   // その担当を占有
      else out.blockAll.push(iv);                                    // 担当姓不明＝fail-closed（全員を塞ぎ二重予約を防ぐ）
    }
    out.ok = true;
  } catch (ex) { Logger.log('⚠️ 1F busy取得例外（fail-closed）: ' + ex.message); out.ok = false; }
  return out;
}

// [start,end) が busy区間リストと重なるか（exStart/exEvId＝自分の旧予定は除外）。
function _lbOverlapsBusy(list, startMs, endMs, exStartMs, exEvId) {
  for (var i = 0; i < list.length; i++) {
    var s = list[i].start.getTime(), e = list[i].end.getTime();
    if (exEvId && list[i].evId && list[i].evId === exEvId) continue;
    if (exStartMs && s === exStartMs) continue;
    if (s < endMs && e > startMs) return true;
  }
  return false;
}

// ============================================================
// 契約フォーム回答（請求ブック 1ch84）の参照ヘルパー
//   列は「ヘッダ名」で特定＝オーナーが列を並べ替えても追従（手動管理しやすさと両立）。
//   顧客照合＝お客様名（末尾「様」・空白を正規化）。契約期間内（開始≤今≤終了）の最新行を採用。
// ============================================================
function _lbContractSheet() {
  try {
    // staging検証時は STAGING_CONTRACT_SS_ID（隔離した契約シート）を読む。本番はCONTRACT_SS_ID固定。
    var id = _lbProp('STAGING_CONTRACT_SS_ID') || LINE_BOOKING.CONTRACT_SS_ID;
    var ss = SpreadsheetApp.openById(id);
    var sh = ss.getSheetByName('フォームの回答 1');   // 直接指定で高速化（getSheets全走査を回避）
    if (sh) return sh;
    var sheets = ss.getSheets();
    for (var i = 0; i < sheets.length; i++) { if (sheets[i].getName().indexOf('フォーム') >= 0) return sheets[i]; }
  } catch (e) { Logger.log('_lbContractSheet: ' + e.message); }
  return null;
}
// 厳密IDモード（顧客ID/pack_id列を有効化）は明示フィーチャーフラグでのみON。列見出しの有無を切替条件にしない
//   （設計整合スイープ発見3/4・鶏卵同型の罠回避：書き戻し未実装のまま列を足しても会員をロックアウトしない）。
//   有効化の前提＝(1)登録時の顧客ID書き戻し実装 (2)pack_id採番付きaddTicketRefill (3)全行バックフィル完了。
function _lbStrictIdMode() {
  try { return String(PropertiesService.getScriptProperties().getProperty('LB_STRICT_ID_MODE') || '') === 'on'; }
  catch (e) { return false; }
}
function _lbContractCols(headers) {
  function find(kw) { for (var i = 0; i < headers.length; i++) { if (String(headers[i]).indexOf(kw) >= 0) return i; } return -1; }
  var strict = _lbStrictIdMode();
  // チケット単価は「既存の単価欄」を流用（専用列があればそれを優先）。顧客ID/pack_idはstrictモード時のみ有効化。
  //   ※顧客ID列は「オーナー入力」ではなくシステムが登録時に書き戻す任意列（鶏卵回避）。既定(strict off)は customer_line_map id＋氏名/電話join。
  // ペア専用列「1名来店時単価（ペアトレ）」。単価フォールバック(find('単価'))がこの列を誤って掴むのを防ぐため
  //   除外して探す（同じセルにペア単価と通常単価を二重書きする事故＝Codex#6の封じ込め）。
  //   見出しの表記ゆれに強くするため「1名来店」で照合する。
  //   「1名来店」かつ「単価」を両方含む列だけを対象にする（備考等への誤マッチを防ぐ）。複数一致は曖昧＝-2で通知。
  var normalPrice = -1, _npHits = 0;
  for (var _h = 0; _h < headers.length; _h++) {
    var _hd = String(headers[_h]);
    if (_hd.indexOf('1名来店') >= 0 && _hd.indexOf('単価') >= 0) { if (normalPrice < 0) normalPrice = _h; _npHits++; }
  }
  if (_npHits > 1) normalPrice = -2;   // 見出しが重複＝どちらに書くべきか決められない（呼び出し側でfail-loud）
  // 単価フォールバックは「1名来店」を含む列を常に除外（ペア専用列を通常単価として拾わない）。
  function findPlainPrice() { for (var i = 0; i < headers.length; i++) { var h = String(headers[i]); if (h.indexOf('単価') >= 0 && h.indexOf('1名来店') < 0) return i; } return -1; }
  var tPrice = find('チケット単価'); if (tPrice < 0) tPrice = findPlainPrice();
  return { name: find('お客様名'), type: find('種別'), course: find('コース'), freq: find('頻度'), ticket: find('チケット枚数'), start: find('開始日'), end: find('契約終了日'), carry: find('繰越率'), carryCap: find('繰越上限'), phone: find('電話'), method: find('残数方式'), trainer: find('担当'),
    custId: strict ? find('顧客ID') : -1, ticketPrice: tPrice, packId: strict ? find('pack_id') : -1, normalPrice: normalPrice };
}
// 敬称を1つに畳んで付ける。顧客名に既に「様」が入っていても二重にならない（2026-09-16）。
//   カレンダータイトルの生成は必ずこれを通すこと（「様様_line」の再発防止）。
function _lbStripSama(name) { return String(name || '').replace(/[\s　]*様+[\s　]*$/, ''); }
function _lbWithSama(name) { return _lbStripSama(name) + '様'; }
// タイトル内の連続した敬称を1つに畳む（既存データの修復用）。
function _lbCollapseSama(title) { return String(title || '').replace(/様{2,}/g, '様'); }
function _lbNormName(s) { return String(s || '').replace(/\s+/g, '').replace(/様+$/, ''); }   // 「様様」も除去（2026-09-16）
// 顧客名で契約行を返す { row, cols, start, end } / 無ければ null（契約期間内・開始が最新の行）
function _lbFindContract(customerName, phone) {
  var cols, vals;
  var cache = CacheService.getScriptCache();
  var cached = cache.get('lb_contract_all');
  if (cached) {
    var d = JSON.parse(cached); cols = d.cols; vals = d.vals;   // 5分キャッシュ（請求ブックの重い読み込みを回避）
  } else {
    var sh = _lbContractSheet();
    if (!sh) return null;
    var last = sh.getLastRow();
    if (last < 2) return null;
    var lastCol = sh.getLastColumn();
    var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
    cols = _lbContractCols(headers);
    if (cols.name < 0) return null;
    vals = sh.getRange(2, 1, last - 1, lastCol).getValues();
    // TTL=1時間。請求ブックの全読み込みは重く（実測59秒）、記憶が切れた直後のアクセスは
    //   応答前に接続が切れることがある（深夜の会員登録で実際に発生・2026-09-16）。
    //   契約を追加した直後に反映されない副作用は、NOT_FOUND時のキャッシュ破棄で埋める（selfRegister）。
    try { cache.put('lb_contract_all', JSON.stringify({ cols: cols, vals: vals }), 3600); } catch (e) { Logger.log('契約キャッシュ失敗: ' + e.message); }
  }
  var target = _lbNormName(customerName);
  var normPhone = phone ? _lbNormPhone(phone) : '';
  var now = new Date().getTime();
  var best = null, bestStart = -1;
  var pMatch = null, pMatchStart = -1;
  for (var i = 0; i < vals.length; i++) {
    var r = vals[i];
    if (_lbNormName(r[cols.name]) !== target) continue;
    var start = cols.start >= 0 ? _lbParseResvDate(r[cols.start]) : null;
    var end = cols.end >= 0 ? _lbParseResvDate(r[cols.end]) : null;
    if (start && start.getTime() > now) continue;   // 契約開始前
    if (end && end.getTime() < now) continue;        // 契約終了後
    var st = start ? start.getTime() : 0;
    if (st >= bestStart) { bestStart = st; best = { row: r, cols: cols, start: start, end: end }; }
    // 同名区別：電話が渡され一致する行を優先（数値型セル対策で_lbNormPhone）
    if (normPhone && cols.phone >= 0 && _lbNormPhone(r[cols.phone]) === normPhone && st >= pMatchStart) {
      pMatchStart = st; pMatch = { row: r, cols: cols, start: start, end: end };
    }
  }
  return pMatch || best;   // 電話一致があれば同名別人と区別して優先。無ければ従来どおり最新start行
}

// 会員の全有効契約行（期間内）を返す。月額+チケット併存に対応。電話一致があれば同名を絞る。
function _lbContractRows(customerName, phone) {
  var cols, vals;
  var cache = CacheService.getScriptCache();
  var cached = cache.get('lb_contract_all');
  if (cached) { var d = JSON.parse(cached); cols = d.cols; vals = d.vals; }
  else {
    var sh = _lbContractSheet(); if (!sh) return [];
    var last = sh.getLastRow(); if (last < 2) return [];
    var lastCol = sh.getLastColumn();
    var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
    cols = _lbContractCols(headers); if (cols.name < 0) return [];
    vals = sh.getRange(2, 1, last - 1, lastCol).getValues();
    try { cache.put('lb_contract_all', JSON.stringify({ cols: cols, vals: vals }), 300); } catch (e) {}
  }
  var target = _lbNormName(customerName);
  var normPhone = phone ? _lbNormPhone(phone) : '';
  var now = new Date().getTime();
  var all = [], matched = [];
  for (var i = 0; i < vals.length; i++) {
    var r = vals[i];
    if (_lbNormName(r[cols.name]) !== target) continue;
    var start = cols.start >= 0 ? _lbParseResvDate(r[cols.start]) : null;
    var end = cols.end >= 0 ? _lbParseResvDate(r[cols.end]) : null;
    if (start && start.getTime() > now) continue;   // 契約開始前
    if (end && end.getTime() < now) continue;        // 契約終了後
    // 同名区別：電話が記入され「別人」の行のみ除外。電話一致 or 電話空（同一人物の月額/チケット別行）は含める。
    if (normPhone && cols.phone >= 0) {
      var rp = _lbNormPhone(r[cols.phone]);
      if (rp && rp !== normPhone) continue;   // 電話記入あり・不一致＝別人 → 除外
    }
    all.push({ row: r, cols: cols, start: start, end: end });
  }
  return all;
}

// line_reservations から本人の割当器session列を作る（confirmed/consumed・振替channel保持）
//   ＝旧 _lbCountReservations を割当器入力に置換（段階2）。純粋な変換は Allocate.js の _lbResvValsToSessions。
//   C2：正本シート欠落は null を返す（＝fail-closed シグナル）。空シート（存在・行なし）は [] と区別。
function _lbResvSessions(customerId) {
  var sh = _lbSheet(LINE_BOOKING.RESV_SHEET);
  if (!sh) return null;   // 正本シート欠落＝残数不明 → 上位で予約停止（満額復活を防ぐ）
  var last = sh.getLastRow(); if (last < 2) return [];
  var lastCol = Math.max(12, sh.getLastColumn());   // 専用session_id(col12)・attendee_count(col15)まで読む
  var vals = sh.getRange(2, 1, last - 1, lastCol).getValues();
  return _lbResvValsToSessions(vals, customerId, _lbParseResvDate);
}

// 事前読みした契約vals/colsから会員の契約行を絞る（締めのバッチ用＝シート再読込を避ける）。_lbContractRowsAllと同ロジック。
function _lbFilterContractRowsFrom(vals, cols, customerName, phone, customerId) {
  var target = _lbNormName(customerName);
  var normPhone = phone ? _lbNormPhone(phone) : '';
  var cid = (customerId != null && String(customerId) !== '') ? String(customerId).replace(/^\s+|\s+$/g, '') : '';
  var idMode = (cols.custId >= 0 && cid !== '');
  var all = [], gap = false;
  for (var i = 0; i < vals.length; i++) {
    var r = vals[i];
    if (idMode) {
      var rid = String(r[cols.custId] == null ? '' : r[cols.custId]).replace(/^\s+|\s+$/g, '');
      if (rid) { if (rid !== cid) continue; }
      else { if (_lbNormName(r[cols.name]) === target) gap = true; continue; }
    } else {
      if (_lbNormName(r[cols.name]) !== target) continue;
      if (normPhone && cols.phone >= 0) { var rp = _lbNormPhone(r[cols.phone]); if (rp && rp !== normPhone) continue; }
    }
    var start = cols.start >= 0 ? _lbParseResvDate(r[cols.start]) : null;
    var end = cols.end >= 0 ? _lbParseResvDate(r[cols.end]) : null;
    all.push({ row: r, cols: cols, start: start, end: end, idx: i });
  }
  return { rows: all, migrationGap: gap };
}

// 顧客名（又は顧客ID）で「全履歴の契約行」を返す（期間で切らない＝割当器の履歴再導出要件・H1）。
//   fresh=true でキャッシュ回避（M2）。customerId 指定＋「顧客ID」列に値がある行はID厳密一致（H3安定join）。
//   ID列が無い/行のIDが空なら従来の 氏名＋電話 にフォールバック。
function _lbContractRowsAll(customerName, phone, fresh, customerId) {
  var cols, vals;
  var cache = CacheService.getScriptCache();
  var cached = fresh ? null : cache.get('lb_contract_all');
  if (cached) { var d = JSON.parse(cached); cols = d.cols; vals = d.vals; }
  else {
    var sh = _lbContractSheet(); if (!sh) return [];
    var last = sh.getLastRow(); if (last < 2) return [];
    var lastCol = sh.getLastColumn();
    var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
    cols = _lbContractCols(headers); if (cols.name < 0) return [];
    vals = sh.getRange(2, 1, last - 1, lastCol).getValues();
    if (!fresh) { try { cache.put('lb_contract_all', JSON.stringify({ cols: cols, vals: vals }), 300); } catch (e) {} }
  }
  var target = _lbNormName(customerName);
  var normPhone = phone ? _lbNormPhone(phone) : '';
  var cid = (customerId != null && String(customerId) !== '') ? String(customerId).replace(/^\s+|\s+$/g, '') : '';
  var idMode = (cols.custId >= 0 && cid !== '');   // 顧客ID列あり＋ID指定＝厳密IDモード（移行後の正）
  var all = [], gap = false;
  for (var i = 0; i < vals.length; i++) {
    var r = vals[i];
    if (idMode) {
      var rid = String(r[cols.custId] == null ? '' : r[cols.custId]).replace(/^\s+|\s+$/g, '');
      if (rid) { if (rid !== cid) continue; }                       // ID一致行のみ採用（氏名不問・分裂/同名を解消・C-2）
      else { if (_lbNormName(r[cols.name]) === target) gap = true; continue; }   // ID空の同名行＝移行ギャップ（自動採用しない→fail-closed）
    } else {
      if (_lbNormName(r[cols.name]) !== target) continue;
      // 期間で切らない（過去・未来の契約行も割当器へ渡し、有効期間判定は割当器に委譲）。同名別人のみ電話で除外。
      if (normPhone && cols.phone >= 0) { var rp = _lbNormPhone(r[cols.phone]); if (rp && rp !== normPhone) continue; }
    }
    var start = cols.start >= 0 ? _lbParseResvDate(r[cols.start]) : null;
    var end = cols.end >= 0 ? _lbParseResvDate(r[cols.end]) : null;
    all.push({ row: r, cols: cols, start: start, end: end, idx: i });   // idx＝シート行順（互換合成pack_idの基）
  }
  all.migrationGap = gap;   // IDモードで同名の未採番行が残る＝移行未完了 → 呼び出し側で fail-closed
  return all;
}

// 契約行群を月額/チケットに分離し残数を計算（割当器 _lbComputeRemaining に委譲・段階2載せ替え）
//   targetDateMs 省略時は当日。月額優先→超過チケット・振替除外・繰越cap・base/carry・チケット期限gatingは割当器が一元管理。
//   カレンダータイトルの焼き込みでなく line_reservations 実績から都度導出（設計v2 §1）。表示用（決定は _lbBookability）。
// 移行棚卸しの会員opening（migration_balance・承認済みのみ）。無ければnull＝現行の履歴計算のまま（後方互換）。
//   列：customer_id / cutover_month / carry(月額繰越) / packs_json({packId:used}) / 基準日 / 承認者 / 承認日
var LB_MIGBAL_SHEET = 'migration_balance';
function _lbMemberOpening(customerId) {
  var sh = _lbSheet(LB_MIGBAL_SHEET); if (!sh || sh.getLastRow() < 2) return null;
  var v = sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues();
  for (var i = 0; i < v.length; i++) {
    if (String(v[i][0]) !== String(customerId)) continue;
    if (!String(v[i][5] || '') || !String(v[i][6] || '')) return null;   // 承認者・承認日が揃っていなければ使わない（未承認棚卸しは無効）
    var mk = _lbMonthKeyCell(v[i][1], SETTINGS.TIMEZONE);
    var carry = Number(v[i][2] || 0); if (!isFinite(carry)) carry = 0;
    var packs = {}; try { packs = v[i][3] ? JSON.parse(String(v[i][3])) : {}; } catch (e) { packs = {}; }
    var c = {}; c[mk] = carry;
    return { carry: c, packsUsed: packs, cutoverMonth: mk, recordsFrom: mk };
  }
  return null;
}

// 予約台帳（line_reservations）が記録を持ち始めた月。
//   これより前は、誰についても「予約0件＝来ていない」と判断できない。
//   8月以前の残は残数ログ（migration_balance）から引き継ぐ。
//   （2026-10-01 オーナー確定：「下限は予約台帳に入力がある9月から」）
var LB_RECORDS_FROM_DEFAULT = '2026-09';
function _lbRecordsFromMonth() {
  var v = '';
  try { v = String(_lbProp('LB_RECORDS_FROM_MONTH') || '').trim(); } catch (e) { v = ''; }
  return /^\d{4}-\d{2}$/.test(v) ? v : LB_RECORDS_FROM_DEFAULT;
}

// 残数計算に渡す「記録が完全な最古の月」。棚卸しがあればその月、無ければLINE会員登録の月。
//   繰越を契約開始月から数えるようにしたため、登録より前の月を「予約0件＝来ていない」と
//   誤判定しないための下限（2026-09-25 Codexレビュー指摘への対応）。
//   棚卸しが無い会員でも必ず下限が付くよう、opening が null でも recordsFrom だけのオブジェクトを返す。
function _lbMemberOpeningWithFloor(customerId) {
  var op = _lbMemberOpening(customerId);
  if (op && op.recordsFrom) return op;
  var linked = _lbLinkedAtMonth(customerId);
  if (!linked) return op;                       // 登録日時が読めなければ従来どおり
  if (!op) return { carry: {}, packsUsed: {}, cutoverMonth: undefined, recordsFrom: linked };
  op.recordsFrom = linked;
  return op;
}

// customer_line_map の登録日時から 'YYYY-MM' を得る（読めなければ null）
function _lbLinkedAtMonth(customerId) {
  try {
    var sh = _lbSheet(LINE_BOOKING.MAP_SHEET);
    if (!sh || sh.getLastRow() < 2) return null;
    var v = sh.getRange(2, 1, sh.getLastRow() - 1, MAP_COL.NOTE).getValues();
    for (var i = 0; i < v.length; i++) {
      if (String(v[i][MAP_COL.CUSTOMER_ID - 1]) !== String(customerId)) continue;
      var d = v[i][MAP_COL.LINKED_AT - 1];
      var t = (d && typeof d.getTime === 'function') ? d.getTime() : new Date(String(d)).getTime();
      if (!isFinite(t)) return null;
      return _lbMonthKeyJst(t);
    }
  } catch (e) { Logger.log('_lbLinkedAtMonth: ' + e.message); }
  return null;
}

// 予約作成の一元ゲート（移行B2・全作成経路 _lbReserveCore で適用）。
//   LB_BOOKING_FROZEN=true：全停止（kill switch・ロールバック用。閲覧/取消は別経路で可能）。
//   LB_ONBOARDING_MODE=true（移行中のみ）：施設カットオーバー(LB_FACILITY_LIVE=true)＋承認済み初期残高(migration_balance)の会員のみ予約可。
//   いずれも未設定＝現行挙動（verified会員は予約可）。後方互換。
function _lbBookingGate(customerId, channel) {
  if (channel === 'perf_test') return { ok: true };   // 内部self-check（残数プローブ）は対象外
  if (String(_lbProp('LB_BOOKING_FROZEN')) === 'true') return { ok: false, code: 'BOOKING_FROZEN', message: '現在ご予約を停止しています。復旧までしばらくお待ちください。' };
  if (String(_lbProp('LB_ONBOARDING_MODE')) === 'true') {
    if (String(_lbProp('LB_FACILITY_LIVE')) !== 'true') return { ok: false, code: 'NOT_LIVE', message: 'LINE予約の開始までもうしばらくお待ちください。' };
    if (!_lbMemberOpeningWithFloor(customerId)) return { ok: false, code: 'BALANCE_NOT_APPROVED', message: 'ご予約の準備中です。担当トレーナーへご確認ください。' };
  }
  return { ok: true };
}

//   sessionsCache＝既に読み込んだ予約履歴。翌月分をもう一度計算するときに渡すと、
//     line_reservations の読み込みが1回で済む（ホームで当月＋翌月の2回計算するため）。
function _lbSplitRemaining(rows, customerId, targetDateMs, sessionsCache) {
  var nowKey = _lbMonthKeyJst(new Date().getTime());
  var tMs = _lbIsFiniteNum(targetDateMs) ? targetDateMs : new Date().getTime();
  var sessions = sessionsCache || _lbResvSessions(customerId);
  if (sessions === null) return { hasMonthly: false, hasTicket: false, monthlyRow: null, monthlyRem: null,
    ticketTotal: 0, ticketRem: 0, freq: 0, avail: 0, _ok: false, _issues: [{ code: 'RESERVATION_SOURCE_UNAVAILABLE' }] };
  var a = _lbComputeRemaining(customerId, rows, sessions, nowKey, tMs, LINE_BOOKING.CARRYOVER_RATE, _lbMemberOpeningWithFloor(customerId));
  return { hasMonthly: a.hasMonthly, hasTicket: a.hasTicket, monthlyRow: null, _sessions: sessions,
    monthlyRem: a.monthlyRem, ticketTotal: a.ticketTotal, ticketRem: a.ticketRem, ticketPacks: a.ticketPacks || [],
    ticketRemPair: a.ticketRemPair || 0, ticketRemNormal: a.ticketRemNormal || 0, pairPackMax: a.pairPackMax || 0,   // ペア／通常の内訳（消化先の選択UI用）
    freq: a.freq, avail: a.avail, _ok: a.ok, _issues: a.issues };
}

// 顧客名から契約種別を引く（代行予約・変更でカレンダータイトルのプレフィックスを顧客ごとの種別に正す）
function _lbContractTypeOf(customerName) {
  var c = _lbFindContract(customerName);
  if (!c) return '';
  return String(c.cols.type >= 0 ? c.row[c.cols.type] : '');
}

// 月額の繰越（前月の未消化分を翌月へ・上限＝月回数×繰越率）
function _lbMonthlyCarryover(customerId, quota, rate, contractStart, linkedAt) {
  if (!(quota > 0)) return 0;
  var now = new Date();
  var prevMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
  // 契約開始が前月末以前でなければ繰越なし（当月開始の新規会員に前月繰越を誤付与しない）
  if (contractStart && contractStart.getTime() > prevMonthEnd.getTime()) return 0;
  // LINE登録が前月末以前でなければ繰越なし（移行期＝前月にLINEで予約できず記録が無いため、
  // 前月消化0を「未消化」と誤認して繰越を付けない）
  if (linkedAt) {
    var la = (linkedAt instanceof Date) ? linkedAt : _lbParseResvDate(linkedAt);
    if (la && la.getTime() > prevMonthEnd.getTime()) return 0;
  }
  var lastUsed = _lbCountReservations(customerId, 'lastmonth');
  var unused = Math.max(0, quota - lastUsed);
  return Math.min(unused, _lbResolveCarryCap(quota, null, rate));   // 頻度テーブル＋率fallback（残数の本則は割当器_lbComputeRemaining）
}

// 予約可能残数（契約フォーム回答を参照）。契約期間内の行が無ければ degraded＝skip（移行期は止めない）。
//   通常・モニター（月額）：頻度/月 − 当月消化／チケット：枚数 − 契約期間内消化。
//   ※当日キャンセルの消化計上（consumed）は次フェーズ。現在は confirmed 予約数で計算。
// customer_line_map から customerId → 電話番号を引く（同名会員を契約フォームの電話で区別するため）
function _lbPhoneByCustomerId(customerId) {
  if (!customerId) return '';
  var sh = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (!sh || sh.getLastRow() < 2) return '';
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, _lbMapWidth(sh)).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][MAP_COL.CUSTOMER_ID - 1]) === String(customerId)) return String(vals[i][MAP_COL.PHONE - 1] || '');
  }
  return '';
}

// customer_line_map から customerId → LINE登録日時を引く（移行期の繰越判定に使用）
function _lbLinkedAtByCustomerId(customerId) {
  if (!customerId) return '';
  var sh = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (!sh || sh.getLastRow() < 2) return '';
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, MAP_COL.LINKED_AT).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][MAP_COL.CUSTOMER_ID - 1]) === String(customerId)) return vals[i][MAP_COL.LINKED_AT - 1] || '';
  }
  return '';
}

// 予約可否＋残数。targetDateMs＝予約対象日（省略時は当日）。excludeStartMs＝変更元の旧枠開始（除外して判定）。
//   判定は「対象日時の仮セッションを割当器に入れて割り当たるか」（probe方式・C1）。表示残数は対象日有効分のみ。
//   attendeeCount＝ペアの来店人数(1/2・既定1)。packKind＝消化先の明示指定（'pair'/'normal'・省略時は実体から自動決定）。
//   ★消化先は契約種別の文字列ではなく「対象日に有効なpackの実体」で決める（最新契約行がペアというだけで
//     通常予約までペアpackを食う／逆にペアpackを持つのに使えない、を防ぐ・Codex指摘）。
function getBookableRemaining(customerId, contractType, customerName, targetDateMs, excludeStartMs, attendeeCount, packKind) {
  // fail-closed（総B/2-D）：氏名不明・契約未検出は予約拒否（無制限予約を防ぐ）。前提＝契約フォームに全会員の行があること。
  if (!customerName) return { ok: false, code: 'NO_CONTRACT', message: '契約情報が確認できません。担当トレーナーへご連絡ください。' };
  var isBooking = _lbIsFiniteNum(targetDateMs);   // 予約確定時は最新の契約を読む（M2：取消/訂正直後の古いキャッシュを避ける）
  var rows = _lbContractRowsAll(customerName, _lbPhoneByCustomerId(customerId), isBooking, customerId);   // 全履歴（H1）＋ID優先join（H3）
  if (rows.migrationGap) return { ok: false, code: 'REVIEW_REQUIRED', message: 'ご契約情報の確認が必要です。恐れ入りますが担当トレーナーへご連絡ください。' };   // C-2：ID移行未完了行あり
  if (!rows.length) return { ok: false, code: 'NO_CONTRACT', message: '有効なご契約が確認できません。契約状況をご確認のうえ、担当トレーナーへご連絡ください。' };
  var sessions = _lbResvSessions(customerId);
  if (sessions === null) return { ok: false, code: 'REVIEW_REQUIRED', message: '予約情報の確認ができません。恐れ入りますが担当トレーナーへご連絡ください。' }; // C2
  var nowKey = _lbMonthKeyJst(new Date().getTime());
  var tMs = isBooking ? targetDateMs : new Date().getTime();
  var rate = LINE_BOOKING.CARRYOVER_RATE;
  var opening = _lbMemberOpeningWithFloor(customerId);   // 移行棚卸しopening（承認済みのみ・無ければnull）を予約可否/残数に反映
  // ペア：来店人数と消化先(pair pack)をprobeへ渡す＝「合計残は足りるが単一packに2枚無い」も正しく不可になる。
  var wantAtt = (attendeeCount == null || attendeeCount === '') ? 1 : Number(attendeeCount);
  var disp = _lbComputeRemaining(customerId, rows, sessions, nowKey, tMs, rate, opening);   // 消化先の決定に実体（有効pack）を使うので先に算出
  var wantKind;
  if (packKind === 'pair' || packKind === 'normal') wantKind = packKind;                    // 明示指定が最優先
  else if (wantAtt === 2) wantKind = 'pair';                                                // 2名来店はペアpack以外あり得ない
  else {
    // 「通常経路が使えるか」は履歴に月額行があるかではなく“対象月に実際に使える枠があるか”で見る
    //   （過去に終了した月額契約が残っているだけでペア単独会員の予約を拒否しないため・Codex指摘）。
    var monthlyRoute = (disp.monthlyRem == null) ? !!disp.hasMonthly          // null＝degraded無制限（月額行あり）
      : (disp.monthlyRem > 0);
    var normalRoute = monthlyRoute || (disp.ticketRemNormal || 0) > 0;
    wantKind = (!normalRoute && (disp.ticketRemPair || 0) > 0) ? 'pair' : 'normal';
  }
  // ↑1名来店は既定で通常経路（月額→通常pack）＝ペアpackが無い会員の挙動は従来と完全に同一。
  //   通常経路が尽きている（or 無い）会員のときだけ 'pair'（＝1名来店＝通常単価計上）へ自動で倒す。
  var b = _lbBookability(customerId, rows, sessions, nowKey, tMs, rate, (_lbIsFiniteNum(excludeStartMs) ? excludeStartMs : undefined), opening, wantAtt, wantKind);
  if (b.code === 'INVALID_ATTENDEE_COUNT') return { ok: false, code: 'INVALID_ATTENDEE_COUNT', message: '来店人数の指定が不正です。' };
  // Codex条件：割当器 result.ok===true を厳守。不正入力（データ不整合・期限欠損）は fail-closed で予約拒否。
  if (!b.ok) return { ok: false, code: 'REVIEW_REQUIRED', message: 'ご契約情報の確認が必要です。恐れ入りますが担当トレーナーへご連絡ください。' };
  if (!b.canBook) return { ok: false, code: 'NO_REMAINING', message: (wantAtt > 1 ? 'ペアチケットの残数が不足しています（2名分が同一チケットに必要です）。' : '予約可能な残数がありません。') };
  if (b.degradedUnlimited) return { ok: true, remaining: null, consumeType: 'monthly', packKind: 'normal' };   // 移行期degraded＝無制限維持
  return { ok: true, remaining: (disp.monthlyRem || 0) + (disp.ticketRem || 0),
           monthlyRem: disp.monthlyRem, ticketRem: disp.ticketRem,
           ticketRemPair: disp.ticketRemPair, ticketRemNormal: disp.ticketRemNormal,
           packKind: wantKind, attendeeCount: wantAtt, consumeType: b.consumeType };
}

// 予約確定画面の選択肢を「予約対象日時ベース」で返す（ホームの当日基準の内訳で未来予約を縛らないため）。
//   会員本人＝自分の分。トレーナー＝customerId指定で代行対象顧客の分。返すのは選択UIの材料のみ（可否の最終判定は予約時）。
function getBookingOptions(lineUserId, startISO, customerId) {
  var startMs = new Date(startISO).getTime();
  if (!_lbIsFiniteNum(startMs)) return { success: false, code: 'BAD_REQUEST', message: '日時が不正です。' };
  var name = '', cid = '';
  var tr = getTrainerByLine(lineUserId);
  if (tr) {   // 代行：トレーナーは対象顧客を明示
    cid = String(customerId || ''); if (!cid) return { success: false, code: 'BAD_REQUEST' };
    // ★担当外の顧客の残数内訳（チケット残・ペア残・期限）を見せない（2026-10-03・Codexの再判定）。
    //   Worker側（compatBookingOptions）は 2026-09-29 に塞いだが、GAS側が塞がれていなかった。
    //   画面はWorkerが FORBIDDEN を返しても**GASへ落ちる**ので、両方塞がないと意味がない。
    if (!_lbTrainerMaySeeCustomer(tr, _lbCustOwnerOf(cid))) {
      return { success: false, code: 'FORBIDDEN', message: 'この会員は他のトレーナーの担当です。' };
    }
    var msh = _lbSheet(LINE_BOOKING.MAP_SHEET);
    if (msh && msh.getLastRow() >= 2) {
      var mv = msh.getRange(2, 1, msh.getLastRow() - 1, MAP_COL.NOTE).getValues();
      for (var i = 0; i < mv.length; i++) if (String(mv[i][MAP_COL.CUSTOMER_ID - 1]) === cid) { name = String(mv[i][MAP_COL.NAME - 1] || ''); break; }
    }
  } else {
    var rec = getCustomerByLine(lineUserId);
    if (!rec || String(rec.data[MAP_COL.AUTH_STATE - 1]) !== 'verified') return { success: false, code: 'NOT_VERIFIED' };
    cid = String(rec.data[MAP_COL.CUSTOMER_ID - 1]); name = String(rec.data[MAP_COL.NAME - 1] || '');
  }
  if (!name) return { success: false, code: 'NOT_FOUND' };
  var rows = _lbContractRowsAll(name, _lbPhoneByCustomerId(cid), false, cid);
  // データ不整合を「成功・権利なし」に化けさせない（確定直前まで予約できるように見せない）。
  if (rows.migrationGap) return { success: false, code: 'REVIEW_REQUIRED', message: 'ご契約情報の確認が必要です。恐れ入りますが担当トレーナーへご連絡ください。' };
  if (!rows.length) return { success: false, code: 'NO_CONTRACT', message: '有効なご契約が確認できません。担当トレーナーへご連絡ください。' };
  var sp = _lbSplitRemaining(rows, cid, startMs);   // ★対象日時基準（期限切れ・開始前を正しく除外）
  if (!sp._ok) return { success: false, code: 'REVIEW_REQUIRED', message: 'ご契約情報の確認が必要です。恐れ入りますが担当トレーナーへご連絡ください。' };
  var monthlyRoute = (sp.monthlyRem == null) ? !!sp.hasMonthly : (sp.monthlyRem > 0);
  // 対象日に有効なペアpackのうち最短の期限（FEFO順の先頭）。当日基準の期限を確定画面に出さないため。
  var pairExpire = '';
  var _bolang = _lbMemberLang(lineUserId);   // 会員/トレーナーの言語で期限ラベル
  var _tp = sp.ticketPacks || [];
  for (var p = 0; p < _tp.length; p++) if ((_tp[p].kind || 'normal') === 'pair') { pairExpire = _lbFmtDateOnly(new Date(_tp[p].expireMs), _bolang); break; }
  return { success: true, customerId: cid, startISO: String(startISO),
    pairRemaining: sp.ticketRemPair || 0, pairPackMax: sp.pairPackMax || 0, pairExpire: pairExpire,
    normalTicketRemaining: sp.ticketRemNormal || 0,
    hasNormalRoute: monthlyRoute || (sp.ticketRemNormal > 0) };
}

// line_reservations から本人の予約を数える
//   mode='future':未来 / 'month':当月 / 'contract':契約期間内（第3引数 contract{start,end}）
function _lbCountReservations(customerId, mode, contract) {
  var sh = _lbSheet(LINE_BOOKING.RESV_SHEET);
  if (!sh) return 0;
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var vals = sh.getRange(2, 1, last - 1, 11).getValues();
  var now = new Date(), y = now.getFullYear(), m = now.getMonth(), cnt = 0;
  var cStart = (contract && contract.start) ? contract.start.getTime() : null;
  var cEnd = (contract && contract.end) ? contract.end.getTime() : null;
  for (var i = 0; i < vals.length; i++) {
    var r = vals[i];
    if (String(r[2]) !== String(customerId)) continue;   // customer_id 列
    var _st = String(r[6]); if (_st !== 'confirmed' && _st !== 'consumed') continue;   // 予約中＋当日消化(consumed)を残数に計上（無料cancelledは戻す）
    if (String(r[9]) === 'transfer') continue;   // 振替(transfer)は残数を消化しない（当日消化済み＋5,500円別請求）
    var dt = _lbParseResvDate(r[0]);
    if (!dt) continue;
    if (mode === 'future') { if (dt.getTime() >= now.getTime()) cnt++; }
    else if (mode === 'contract') {
      var t = dt.getTime();
      if ((cStart === null || t >= cStart) && (cEnd === null || t <= cEnd)) cnt++;
    }
    else if (mode === 'lastmonth') {   // 前月の消化（繰越計算用）
      var lmY = (m === 0) ? y - 1 : y, lmM = (m === 0) ? 11 : m - 1;
      if (dt.getFullYear() === lmY && dt.getMonth() === lmM) cnt++;
    }
    else if (dt.getFullYear() === y && dt.getMonth() === m) cnt++;   // month
  }
  return cnt;
}

// 予約通知（新チャネルの Messaging API で個別 lineUserId へ push）
// ★既存 sendLineReservationNotice（旧通知bot・GROUP宛）とは別。新チャネルの LINE_MESSAGING_TOKEN を使う。
//   ★muteHttpExceptions のため LINE 側のエラー（トークン失効401・ブロック403・レート超過429）は
//     例外を投げない＝黙って届かない。ステータスを必ず検査し、失敗は実測ログ(booking_metrics)に残して可視化する。
//     戻り値 true=送信成功／false=未送信。予約処理は従来どおり通知失敗で覆さない（非致命）。
//   purpose: 用途タグ（reminder_customer / booking_trainer など）。プランの通数を何が食っているかを
//     用途別に数え、削る対象を数字で決められるようにする。省略時は 'other'。
function _lbPush(to, text, purpose) {
  var token = _lbProp('LINE_MESSAGING_TOKEN');
  if (!token || !to) { Logger.log('_lbPush skip: token/to無し'); return false; }   // 未設定＝意図的（staging等）なので記録しない
  try {
    var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({ to: to, messages: [{ type: 'text', text: text }] }),
      muteHttpExceptions: true
    });
    var code = 0;
    try { code = Number(res.getResponseCode()); } catch (eC) { code = 0; }
    // ★成功時は一切書き込まない。予約完了フロー（Lock内）でシート往復を増やさないため。
    //   送信した通数はLINEのquota APIが正として持ち、用途別の内訳は月次で既存データから再構成する。
    if (code === 200) return true;
    // 429＝短時間に送りすぎ（月間上限ではない。2026-09-18に実測：5,000通中249通で発生）。
    //   前日リマインドは対象者へ連続送信するためここで弾かれる。少し待って1回だけ送り直す。
    if (code === 429) {
      Utilities.sleep(1200);
      try {
        var res2 = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
          method: 'post', contentType: 'application/json',
          headers: { Authorization: 'Bearer ' + token },
          payload: JSON.stringify({ to: to, messages: [{ type: 'text', text: text }] }),
          muteHttpExceptions: true
        });
        if (Number(res2.getResponseCode()) === 200) { Logger.log('_lbPush 429→再送で成功'); return true; }
      } catch (eR) { Logger.log('_lbPush 再送エラー: ' + eR.message); }
    }
    var body = ''; try { body = String(res.getContentText()).slice(0, 200); } catch (eB) {}
    Logger.log('_lbPush 失敗 HTTP' + code + ': ' + body);
    _lbLogNotifyFail('HTTP_' + code, purpose);   // 失敗は稀＝書き込みコストが問題にならない
    return false;
  } catch (e) { Logger.log('_lbPush エラー: ' + e.message); _lbLogNotifyFail('EXCEPTION', purpose); return false; }
}

// reply（友だち追加あいさつ等・reply枠は無料）。follow直後の応答に使う。
function _lbReply(replyToken, text) {
  var token = _lbProp('LINE_MESSAGING_TOKEN');
  if (!token || !replyToken) { Logger.log('_lbReply skip: token/replyToken無し'); return; }
  try {
    UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({ replyToken: replyToken, messages: [{ type: 'text', text: text }] }),
      muteHttpExceptions: true
    });
  } catch (e) { Logger.log('_lbReply エラー: ' + e.message); }
}

// 友だち追加あいさつ文面（会員登録の入口＝LIFF URLへ誘導）
function _lbWelcomeText() {
  var liffId = _lbProp('LINE_LIFF_ID') || '2010827953-QgBQFzh9';
  return 'はじめまして。' + SETTINGS.GYM_NAME + 'です🌿\nご登録ありがとうございます。\n\n' +
    'まずは会員登録をお願いします。下記から、ご契約時のお名前・お電話番号などをご入力ください。\n\n' +
    '▼ 会員登録・ご予約はこちら\nhttps://liff.line.me/' + liffId + '\n\n' +
    '登録後は、LINEからいつでもセッションのご予約・変更・キャンセルができます。\nご不明な点は担当トレーナーへお気軽にどうぞ。';
}

function _lbNotifyReservation(customerLineUserId, trainer, start, end, customerName, channel, customerId) {
  var tz = SETTINGS.TIMEZONE;
  var dow = ['日', '月', '火', '水', '木', '金', '土'][start.getDay()];
  var s = Utilities.formatDate(start, tz, 'yyyy年MM月dd日') + '（' + dow + '）' + Utilities.formatDate(start, tz, 'HH:mm');
  var e = Utilities.formatDate(end, tz, 'HH:mm');
  var isTransfer = (channel === 'transfer');
  // 顧客へ完了push（代理予約で顧客のlineUserId未確定なら skip）
  if (customerLineUserId) {
    _lbPush(customerLineUserId, isTransfer
      ? '振替セッションを承りました。\n日時：' + s + '〜' + e + '\n担当：' + trainer.name + '\n場所：' + SETTINGS.GYM_NAME + '\n※振替料金 5,500円は別途ご請求します。'
      : 'ご予約を承りました。\n日時：' + s + '〜' + e + '\n担当：' + trainer.name + '\n場所：' + SETTINGS.GYM_NAME + '\nキャンセルは前日17時まで無料です。', 'booking_customer');
  }
  // 選択トレーナーへ通知push
  var trId = getTrainerLineId(trainer.id);
  if (trId) {
    var _remTxt = '';
    if (!isTransfer) {   // 振替は残数を消化しないため残数は載せない
      try {
        var _h = _lbBuildHome(customerId, customerName, null, start.getTime());   // 予約した日の月で出す
        if (_h && _h.type) {
          var _lines = [];
          // 予約が翌月以降なら「10月分：」のように月を明記する（今月の残数と取り違えないため）
          var _now = new Date();
          var _sameMonth = (start.getFullYear() === _now.getFullYear() && start.getMonth() === _now.getMonth());
          var _mPfx = _sameMonth ? '' : ((start.getMonth() + 1) + '月分　');
          if (_h.type === 'monthly' || _h.type === 'both') {
            var _quota = (_h.quota || 0) + (_h.carryover || 0);                       // 枠＝頻度＋繰越
            var _mRem = (_h.monthlyRemaining != null) ? _h.monthlyRemaining : 0;
            var _used = Math.max(0, _quota - _mRem);                                   // 対象月の消化数（枠−残）
            _lines.push(_mPfx + '月額：月' + (_h.quota || 0) + '回中' + _used + '回目（残' + _mRem + '回）'
              + ((_h.carryover || 0) > 0 ? '　※繰越' + _h.carryover + '回を含む' : ''));
          }
          if (_h.type === 'ticket' || _h.type === 'both') {
            var _tRem = (_h.type === 'ticket') ? _h.remaining : _h.ticketRemaining;
            var _tExp = (_h.type === 'ticket') ? _h.expire : _h.ticketExpire;
            _lines.push(_mPfx + 'チケット：残' + _tRem + '枚' + (_tExp ? '（期限 ' + _tExp + '）' : ''));
          }
          if (_lines.length) _remTxt = '\n【顧客の残り】\n' + _lines.join('\n');
        }
      } catch (e) { Logger.log('通知の残数取得失敗: ' + e.message); }
    }
    _lbPush(trId, (isTransfer ? '【振替予約】' : '【新規予約】') + customerName + '様\n日時：' + s + '〜' + e + _remTxt +
      (isTransfer ? '\n※振替セッション（5,500円・手動請求）' : ''), 'booking_trainer');
  }
}

// 予約確定の共通コア（会員本人・トレーナー代理の両方から呼ぶ）＝全予約経路の choke point。
//   薄いラッパで成否を実測ログに1行記録する（軽量・非致命）。ログ失敗は予約に影響させない。
function _lbReserveCore(custInfo, body, channel) {
  var r = _lbReserveCoreImpl(custInfo, body, channel);
  try { _lbLogOutcome((r && r.success) ? 'success' : ((r && r.code) || 'ERROR'), channel); } catch (e) { Logger.log('outcomeログ失敗（予約は継続）: ' + e.message); }
  return r;
}
// custInfo: { customerId, customerName, lineUserId(空可) }
function _lbReserveCoreImpl(custInfo, body, channel) {
  var _gate = _lbBookingGate(String(custInfo.customerId || ''), channel);   // 移行B2：kill switch＋オンボードゲート（通常/変更/振替/代行の全作成経路に適用）
  if (!_gate.ok) return { success: false, code: _gate.code, message: _gate.message };
  var trainer = _lbTrainerById(String(body.trainerId || ''));
  if (!trainer) return { success: false, code: 'BAD_REQUEST', message: 'トレーナーが不明です。' };
  var start = new Date(body.startISO);
  if (isNaN(start.getTime())) return { success: false, code: 'BAD_REQUEST', message: '予約時間が不正です。' };
  if (start <= new Date()) return { success: false, code: 'BAD_REQUEST', message: '過去の時間は予約できません。' };
  // 極端な未来日時のガード（残数割当器が対象月まで月単位でループ＝異常な遠未来でLock占有DoSになるのを遮断・Codex）。
  //   予約窓は当月〜翌月なので400日先で十分に余裕。全予約経路(単発/一括/代行)を保護。
  if (start.getTime() > new Date().getTime() + 400 * 86400000) return { success: false, code: 'BAD_REQUEST', message: 'ご予約は先すぎる日時です。' };
  // 受付締め切り（午前枠＝前日22時／それ以外＝開始3時間前）。トレーナー代理/テストは除外。
  //   表示(buildAvailableSlots)と同じ _lbBookingOpen を使う＝「見えているのに予約できない」を構造的に防ぐ。
  if (channel !== 'trainer_manual' && channel !== 'perf_test' &&
      !_lbBookingOpen(start.getTime(), new Date().getTime(), _lbBookingCfg(SETTINGS))) {
    return { success: false, code: 'TOO_SOON',
      message: _lbBookingDeadlineText(start.getTime(), _lbBookingCfg(SETTINGS)) + '別の時間をお選びください。' };
  }
  // 体験契約の会員がLINEから予約した場合も実際は90分押さえる（表示・案内は60分）。
  var _sessMins = (String((custInfo && custInfo.contractType) || '').indexOf('体験') >= 0)
    ? (SETTINGS.TRIAL_SESSION_MINUTES || SETTINGS.SESSION_MINUTES) : SETTINGS.SESSION_MINUTES;
  var end = new Date(start.getTime() + _sessMins * 60000);

  var lock = LockService.getScriptLock();
  var _lbOwnedLock = false;
  if (!lock.hasLock()) { lock.waitLock(10000); _lbOwnedLock = true; }   // 呼び出し側(change)が既にLock保持なら再取得せず＝変更を単一クリティカルセクションで原子化(C3)
  var _t0 = new Date().getTime();
  function _lap(n){ Logger.log('[perf] ' + n + ': ' + (new Date().getTime() - _t0) + 'ms'); }
  var rem;
  try {
    // 残数チェックをLock内で実施（TOCTOU解消・F2）。対象＝予約日時で判定（翌月先取り・チケット期限も正しく・C1）。
    //   振替＝当日消化済みの独立枠なのでスキップ。変更＝呼び出し側(changeReservationLine)が旧行を先に changed へ
    //   落として残数集合から除外済み＝ここで別途 exclude は渡さない（同時刻の別sessionを過剰除外しない・C3）。
    // ペア来店人数：1 or 2 の整数のみ（既定1）。黙って丸めない＝不正値は予約を通さない。
    //   「ペア会員かどうか」は契約種別の文字列でなく実体（有効なペアpack）で判定する＝probeに委ねる。
    var _att = (body.attendeeCount == null || body.attendeeCount === '') ? 1 : Number(body.attendeeCount);
    if (!(_att === 1 || _att === 2)) return { success: false, code: 'INVALID_ATTENDEE_COUNT', message: '来店人数の指定が不正です。' };
    var _kind = 'normal';
    if (channel !== 'transfer') {
      // 残数判定は probe 一本（合計残での通過を廃止：ペアは単一packに人数ぶんの空きが必要）
      rem = getBookableRemaining(custInfo.customerId, custInfo.contractType, custInfo.customerName, start.getTime(), undefined, _att, body.packKind);
      if (!rem.ok) return { success: false, code: rem.code || 'NO_REMAINING', message: rem.message || '予約可能な残数がありません。' };
      _kind = rem.packKind || 'normal';   // 実際に消化する種別＝カレンダー種別・記録(book_type)と厳密に一致させる
    }
    _lap('残数チェック');
    // 施設キャパシティ競合（★通常予約はB1=地下のみ使用。1Fは初回体験のみ。billingも[RESERVED]はB1のみ参照）
    var calB1 = CalendarApp.getCalendarById(CALENDAR_IDS.CAPACITY_B1);
    // [消化]は計上の証跡として残るが席は空き。施設キャパ判定からは除外（共通ルール）。
    // 変更/振替元(自分の旧予定)を空き判定から除外＝隣接/重複時刻への変更・振替を可能に（問題2）
    var exStart = body.excludeStartISO ? new Date(body.excludeStartISO).getTime() : null;
    var b1busy = calB1.getEvents(start, end).filter(function (ev) {
      if (ev.getTitle().indexOf('[消化]') === 0) return false;                       // [消化]は席開放
      if (exStart && ev.getStartTime().getTime() === exStart) return false;          // 自分の旧予定は除外
      // 境界で接するだけの予定は競合ではない（getEvents は end ちょうどに始まる予定も返す・2026-09-26）
      return _lbEventOverlaps(ev, start.getTime(), end.getTime());
    });
    if (b1busy.length > 0) {
      return { success: false, code: 'SLOT_TAKEN', message: 'この時間帯はすでに予約が入りました。別の時間をお選びください。' };
    }
    _lap('B1競合チェック');
    // 選択トレーナーのリアルタイム空き照合
    if (!_lbCheckTrainerAvailable(trainer, start, end, exStart)) {
      return { success: false, code: 'SLOT_TAKEN', message: 'この時間帯は選択されたトレーナーが対応できません。' };
    }
    // 1Fオンライン等でそのトレーナーが埋まっていないか（B1容量を使わない予約の二重防止・Codex#1）
    //   1F取得失敗は fail-closed で予約拒否。除外はstart時刻でなくcalendar_event_id一致のみ（変更元の誤除外防止・Codex#2）。
    if (_lb1FBlockEnabled()) {
      var _f1 = _lb1FTrainerBusy(start, end);
      if (!_f1.ok) return { success: false, code: 'SLOT_CHECK_UNAVAILABLE', message: '空き状況を確認できませんでした。時間をおいて再度お試しください。' };
      var _exEvId = body.excludeEventId ? String(body.excludeEventId) : '';
      if (_lbOverlapsBusy(_f1.trainerBusy[trainer.id] || [], start.getTime(), end.getTime(), null, _exEvId) ||
          _lbOverlapsBusy(_f1.blockAll, start.getTime(), end.getTime(), null, _exEvId)) {
        return { success: false, code: 'SLOT_TAKEN', message: 'この時間帯は選択されたトレーナーが対応できません。' };
      }
    }
    _lap('トレーナー空き照合');
    // カレンダー登録（TECH_SPEC §5・末尾 _line で billingパーサ非破壊）※B1のみ＋トレーナーカレンダー
    var lastName = trainer.name.split(' ')[0];
    // 予約種別プレフィックス：振替(channel) → レンタル(契約種別) → 通常 の優先順で決定。
    // レンタル＝トレーナーへの場所貸し。billing.gsがこのタイトルで2,000円計上・月額売上/トレーナー報酬から分離する。
    // 顧客体験（表示・通知・残数）は通常会員と一切変えず、カレンダータイトルのプレフィックスのみ切り替える。
    // 顧客ごとの契約種別をカレンダータイトルに反映（billingが種別別に計上）。優先＝振替>レンタル>モニター>通常。
    var ct = String(custInfo.contractType || '');
    var _consume = (typeof rem !== 'undefined' && rem && rem.consumeType) ? rem.consumeType : '';   // 併存会員の消化種別（月額優先→尽きたらチケット）
    var typePrefix = _lbBookTypePrefix(channel, _kind, ct, _consume);   // 純粋関数（Codex#3：消化連動・レンタルは月額消化時に計上しない）。テスト=booking-rules
    // F-6：staging中はカレンダーが本番共有のため、テストマーカー[TEST]を先頭に付す→billingが計上から除外
    //   （billingは[RESERVED]/[消化]===0で判定するため、[TEST]接頭辞は素通り＝集計対象外になる）。残数側はstaging SSで隔離済み。
    var _testPfx = _lbIsStaging() ? '[TEST] ' : '';
    var capTitle = _testPfx + '[RESERVED] ' + typePrefix + lastName + '_' + _lbWithSama(custInfo.customerName) + '_line';
    var desc = '担当：' + trainer.name + '\nchannel：' + channel + '\ncustomer_id：' + custInfo.customerId + (channel === 'transfer' ? '\n※振替セッション（5,500円・手動請求）' : '') + (custInfo.actingTrainer ? '\n代行実行：' + custInfo.actingTrainer + '(' + (custInfo.actingTrainerId || '') + ')' : '');   // 代行の監査（誰が代行したか）
    var capEv = calB1.createEvent(capTitle, start, end, { description: desc });
    var capEvId = '';
    try { capEvId = capEv.getId(); } catch (eId) { Logger.log('eventId捕捉失敗（予約は継続）: ' + eId.message); }   // billing載せ替えのID接合用（決定0043）
    _lap('B1カレンダー登録');
    var tcal = CalendarApp.getCalendarById(trainer.email);
    var tEv = tcal ? tcal.createEvent(_testPfx + '✅ ' + custInfo.customerName + '様｜セッション_line', start, end, { description: desc }) : null;   // 巻き戻し用に参照保持
    var tEvId = ''; try { tEvId = tEv ? String(tEv.getId()) : ''; } catch (eT) { tEvId = ''; }   // 変更時に旧枠削除から新枠を守るためのID
    _lap('トレーナーカレンダー登録');

    // line_reservations に記録（既存 reservations は触らない）
    var resId = recordReservationLine({
      customerId: custInfo.customerId, customerName: custInfo.customerName,
      lineUserId: custInfo.lineUserId || '', trainer: trainer, start: start, channel: channel,
      calendarEventId: capEvId, bookType: typePrefix.replace(/_$/, ''),   // 種別（通常/モニター/レンタル/チケット/振替/ペア）＝会員表示用
      attendeeCount: _att   // ペア来店人数（残数の人数回消化・billingの1名差額判定に使用）
    });
    _lap('SS記録');

    // ★体感短縮（TECH_SPEC §8.5）：重い空き枠再計算(invalidateCache)は確定フローから外し、warmupCache(10分毎)に委譲。
    //   表示反映は最大10分遅れるが、二重予約はB1競合＋リアルタイム照合(_lbCheckTrainerAvailable)で確実に防止済み。
    // 通知は非致命：予約行はコミット済みのため、通知が失敗しても success を覆さない（変更ロールバックの安全性の前提）。
    //   suppressNotify＝自動予約(固定パターン)等で個別通知を抑制し、呼出側でまとめて1通知する場合に立てる。
    if (!custInfo.suppressNotify) {
      try {
        _lbNotifyReservation(custInfo.lineUserId, trainer, start, end, custInfo.customerName, channel, custInfo.customerId);
      } catch (e2) { Logger.log('通知失敗（予約は確定済み）: ' + e2.message); }
    }
    _lap('通知push');

    return { success: true, reservationId: resId, trainerName: trainer.name, calendarEventId: capEvId, trainerEventId: tEvId };
  } catch (e) {
    Logger.log('_lbReserveCore エラー: ' + e.message);
    // 台帳記録(recordReservationLine)等で失敗した場合、作成済みカレンダー予定を巻き戻す。
    //   放置すると「カレンダーに[RESERVED]が残るが台帳に無い＝枠占有・過小消化」の孤児予約になる（Codex・全経路保護）。
    try { if (typeof capEv !== 'undefined' && capEv) capEv.deleteEvent(); } catch (rb1) { Logger.log('B1予定の巻き戻し失敗: ' + rb1.message); }
    try { if (typeof tEv !== 'undefined' && tEv) tEv.deleteEvent(); } catch (rb2) { Logger.log('トレーナー予定の巻き戻し失敗: ' + rb2.message); }
    return { success: false, code: 'SERVER_ERROR', message: e.message };
  } finally {
    if (_lbOwnedLock) lock.releaseLock();
  }
}

// 予約確定（会員本人・LIFF）
function makeReservationLine(lineUserId, body) {
  var rec = getCustomerByLine(lineUserId);
  if (!rec || String(rec.data[MAP_COL.AUTH_STATE - 1]) !== 'verified') return { success: false, code: 'NOT_VERIFIED', message: '会員登録が必要です。' };
  var cstat = String(rec.data[MAP_COL.CONTRACT_STAT - 1] || '');
  if (cstat && cstat !== 'active') return { success: false, code: 'CONTRACT_INACTIVE', message: '現在ご予約いただけない契約状態です。' };
  var _cn = String(rec.data[MAP_COL.NAME - 1] || '会員');
  return _lbReserveCore({
    customerId: String(rec.data[MAP_COL.CUSTOMER_ID - 1]),
    customerName: _cn,
    contractType: _lbContractTypeOf(_cn) || String(rec.data[MAP_COL.CONTRACT_TYPE - 1] || ''),   // 契約から最新種別（総括C：自己予約のタイトル/計上を正す）・無ければmap値
    lineUserId: lineUserId
  }, body, 'line');
}

// #6 繰り返し予約：同じ曜日・時刻でN回分を一括作成（定期イベントは使わず各回独立予約）。
//   残数・容量は各回 _lbReserveCore が判定。作成できた回/できなかった回を返す（部分成功）。全体を1Lockで直列化。
function makeRecurringReservationLine(lineUserId, body) {
  var rec = getCustomerByLine(lineUserId);
  if (!rec || String(rec.data[MAP_COL.AUTH_STATE - 1]) !== 'verified') return { success: false, code: 'NOT_VERIFIED', message: '会員登録が必要です。' };
  var cstat = String(rec.data[MAP_COL.CONTRACT_STAT - 1] || '');
  if (cstat && cstat !== 'active') return { success: false, code: 'CONTRACT_INACTIVE', message: '現在ご予約いただけない契約状態です。' };
  var _cn = String(rec.data[MAP_COL.NAME - 1] || '会員');
  var custInfo = { customerId: String(rec.data[MAP_COL.CUSTOMER_ID - 1]), customerName: _cn,
    contractType: _lbContractTypeOf(_cn) || String(rec.data[MAP_COL.CONTRACT_TYPE - 1] || ''), lineUserId: lineUserId };
  // 繰り返しは常に通常経路（1名・normal）で作る。ペアは来店人数を回ごとに選ぶ必要があるため、この経路では
  //   ペアpackを消化させない（契約種別の文字列で会員を弾くのではなく、消化先を固定して安全にする）。
  var start0 = new Date(body.startISO);
  if (isNaN(start0.getTime())) return { success: false, code: 'BAD_REQUEST', message: '予約時間が不正です。' };
  var occ = _lbRecurringStartMs(start0.getTime(), body.repeatCount, 7, 8);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { success: false, code: 'BUSY', message: '混み合っています。少し時間をおいて再度お試しください。' };
  var created = [], skipped = [];
  try {
    for (var k = 0; k < occ.length; k++) {
      var iso = new Date(occ[k]).toISOString();
      var r = _lbReserveCore(custInfo, { trainerId: body.trainerId, startISO: iso, attendeeCount: 1, packKind: 'normal' }, 'line');   // 同一Lockを共有・繰り返しは通常経路固定
      if (r && r.success) created.push({ startISO: iso });
      else skipped.push({ startISO: iso, code: (r && r.code) || 'ERROR', message: (r && r.message) || '' });
    }
  } finally { lock.releaseLock(); }
  return { success: created.length > 0, created: created, createdCount: created.length, skipped: skipped, skippedCount: skipped.length };
}

// ============================================================
// 振替権（#9・6日猶予）：当日キャンセルで1件付与・6日有効・使用で消費。専用シート transfer_credits。
//   列：customer_id(1) / granted_at(2) / expires_at(3) / used_at(4) / source_reservation_id(5)
// ============================================================
var LB_TCREDIT_SHEET = 'transfer_credits';
var LB_TRANSFER_GRACE_DAYS = 6;
function _lbTcreditSheet() {
  var ss = _lbSs(); var sh = ss.getSheetByName(LB_TCREDIT_SHEET);
  if (!sh) { sh = ss.insertSheet(LB_TCREDIT_SHEET); sh.getRange(1, 1, 1, 5).setValues([['customer_id', 'granted_at', 'expires_at', 'used_at', 'source_reservation_id']]); }
  return sh;
}
// 当日キャンセル時に振替権を1件付与（有効期限＝キャンセル日＋6日の終わり）。
//   source_reservation_id で冪等（同一キャンセルの再実行で二重付与しない・Codex#3,4）。Lockはキャンセル側/呼出側で担保。
function _lbGrantTransferCredit(customerId, sourceResId) {
  var tz = SETTINGS.TIMEZONE, now = new Date();
  var exp = new Date(now.getFullYear(), now.getMonth(), now.getDate() + LB_TRANSFER_GRACE_DAYS, 23, 59, 59);   // 6日後の終日まで有効
  var sh = _lbTcreditSheet();
  var src = String(sourceResId || '');
  if (src && sh.getLastRow() >= 2) {   // 冪等：同一source既存ならスキップ
    var ex = sh.getRange(2, 5, sh.getLastRow() - 1, 1).getValues();
    for (var i = 0; i < ex.length; i++) { if (String(ex[i][0]) === src) return; }
  }
  sh.appendRow([String(customerId), Utilities.formatDate(now, tz, 'yyyy/MM/dd HH:mm'), Utilities.formatDate(exp, tz, 'yyyy/MM/dd HH:mm'), '', src]);
}
// 会員の有効な振替権（未使用・未失効）を返す { available, nextExpiryMs, nextExpireLabel }。
function _lbTransferCreditsFor(customerId, lang) {
  var sh = _lbSheet(LB_TCREDIT_SHEET); if (!sh || sh.getLastRow() < 2) return { available: 0, nextExpiryMs: null, nextExpireLabel: '' };
  var v = sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues();
  var rows = [], cid = String(customerId);
  for (var i = 0; i < v.length; i++) {
    if (String(v[i][0]) !== cid) continue;
    var g = _lbParseResvDate(v[i][1]), e = _lbParseResvDate(v[i][2]), u = v[i][3] ? _lbParseResvDate(v[i][3]) : null;
    if (!v[i][3] && !e) Logger.log('⚠️ transfer_credits 行' + (i + 2) + ' 期限parse不能（cid=' + cid + '）→要確認。');   // 未使用なのに期限不正＝静かに消さず可視化（Codex#8）
    rows.push({ grantedMs: g ? g.getTime() : 0, expiresMs: e ? e.getTime() : 0, usedMs: u ? u.getTime() : 0, rowIndex: i + 2 });
  }
  var st = _lbTransferCreditState(rows, new Date().getTime());
  return { available: st.available, nextExpiryMs: st.nextExpiryMs, nextExpireLabel: st.nextExpiryMs ? _lbFmtDateShort(new Date(st.nextExpiryMs), lang) : '' };
}
// 有効な振替権を1件（最短失効を優先）消費して used_at を刻む。ok:false=有効な権利なし。rowIndexを返す（予約失敗時のrevert用）。
//   ★呼出側でScriptLockを保持したまま「再確認→消費→予約→（失敗なら復元）」を直列化すること（Codex#1,2）。
function _lbUseTransferCredit(customerId) {
  var sh = _lbSheet(LB_TCREDIT_SHEET); if (!sh || sh.getLastRow() < 2) return { ok: false };
  var v = sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues();
  var cid = String(customerId), nowMs = new Date().getTime(), best = -1, bestExp = null;
  for (var i = 0; i < v.length; i++) {
    if (String(v[i][0]) !== cid) continue;
    if (v[i][3]) continue;                                   // 使用済み
    var e = _lbParseResvDate(v[i][2]); var em = e ? e.getTime() : 0;
    if (!(em >= nowMs)) continue;                            // 失効
    if (bestExp === null || em < bestExp) { bestExp = em; best = i + 2; }   // 最短失効を消費
  }
  if (best < 0) return { ok: false };
  sh.getRange(best, 4).setValue(Utilities.formatDate(new Date(), SETTINGS.TIMEZONE, 'yyyy/MM/dd HH:mm'));
  return { ok: true, rowIndex: best };
}
// 消費した振替権を戻す（予約が成立しなかった時の補償・Codex#2）。同一Lock内で呼ぶ。
function _lbRevertTransferCredit(rowIndex) {
  if (!(rowIndex > 1)) return;
  var sh = _lbSheet(LB_TCREDIT_SHEET); if (!sh) return;
  sh.getRange(rowIndex, 4).setValue('');   // used_at をクリア＝未使用に戻す
}

// 振替の権利＝「当日消化した通常予約数 ＞ 既存の有効な振替数」。振替のキャンセル(consumed)は通常消化を増やさない＝
//   振替の振替(再振替)を止める。無料キャンセルの振替(cancelled)は権利を消費しない＝再申込可。
function _lbTransferEligibility(customerId) {
  var sh = _lbSheet(LINE_BOOKING.RESV_SHEET);
  if (!sh || sh.getLastRow() < 2) return { allowed: false, consumedRegular: 0, activeTransfer: 0 };
  var v = sh.getRange(2, 1, sh.getLastRow() - 1, Math.max(12, sh.getLastColumn())).getValues();
  var cr = 0, at = 0, cid = String(customerId);
  for (var i = 0; i < v.length; i++) {
    if (String(v[i][2]) !== cid) continue;                 // col3=customer_id
    var ch = String(v[i][9] || ''), st = String(v[i][6] || '');   // col10=channel, col7=status
    if (ch === 'transfer') { if (st === 'confirmed' || st === 'consumed') at++; }   // 有効な振替（当日消化した振替も権利を使い切る）
    else if (st === 'consumed') cr++;                       // 当日消化した通常予約＝振替の権利
  }
  return { allowed: cr > at, consumedRegular: cr, activeTransfer: at };
}

// 振替予約（当日消化後の振替・5,500円手動請求・残数は消化しない・タイトル「振替_」）
function makeTransferReservationLine(lineUserId, body) {
  var rec = getCustomerByLine(lineUserId);
  if (!rec || String(rec.data[MAP_COL.AUTH_STATE - 1]) !== 'verified') return { success: false, code: 'NOT_VERIFIED', message: '会員登録が必要です。' };
  var _cn2 = String(rec.data[MAP_COL.NAME - 1] || '会員');
  var customerId = String(rec.data[MAP_COL.CUSTOMER_ID - 1]);
  if (String(rec.data[MAP_COL.CONTRACT_STAT - 1] || '') === 'expired') return { success: false, code: 'CONTRACT_INACTIVE', message: '現在のご契約では振替をお受けできません。担当トレーナーへご連絡ください。' };   // 退会会員は不可（Codex#6）
  // #9：有効な振替権（当日キャンセルで付与・6日有効）がある時だけ振替可。ScriptLockで「消費→予約→失敗時復元」を原子化（Codex#1,2）。
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { success: false, code: 'BUSY', message: '混み合っています。少し時間をおいて再度お試しください。' };
  try {
    var use = _lbUseTransferCredit(customerId);   // 先に権利を確保（Lock内＝二重消費・二重予約を防止）
    if (!use.ok) return { success: false, code: 'NO_TRANSFER_ENTITLEMENT', message: '有効な振替権がありません。振替は当日キャンセルから6日以内にご利用いただけます。' };
    var res = _lbReserveCore({
      customerId: customerId,
      customerName: _cn2,
      contractType: _lbContractTypeOf(_cn2) || String(rec.data[MAP_COL.CONTRACT_TYPE - 1] || ''),
      lineUserId: lineUserId
    }, body, 'transfer');   // 同一Lockを共有（_lbReserveCoreはhasLock時に再取得しない）
    if (!(res && res.success)) _lbRevertTransferCredit(use.rowIndex);   // 予約不成立→権利を未使用に戻す
    return res;
  } finally {
    lock.releaseLock();
  }
}

// 予約確定（トレーナー代理・案B認証済 trainer・DESIGN §4.7）
function makeReservationLineProxy(trainer, body) {
  var customerId = String(body.customerId || '').trim();
  if (!customerId) return { success: false, code: 'BAD_REQUEST', message: '対象customerId必須' };
  // customer_line_map から顧客情報（line_user_id は無くても可＝LINE未登録顧客の代理）
  var sh = _lbSheet(LINE_BOOKING.MAP_SHEET);
  var name = '会員', custLine = '', custTrainerId = '', custType = '', custPhone = '', found = false;
  if (sh) {
    var last = sh.getLastRow();
    if (last >= 2) {
      var values = sh.getRange(2, 1, last - 1, MAP_COL.NOTE).getValues();
      for (var i = 0; i < values.length; i++) {
        if (String(values[i][MAP_COL.CUSTOMER_ID - 1]) === customerId) {
          name = String(values[i][MAP_COL.NAME - 1] || '会員');
          custLine = String(values[i][MAP_COL.LINE_USER_ID - 1] || '');
          custTrainerId = String(values[i][MAP_COL.TRAINER_ID - 1] || '');
          custType = String(values[i][MAP_COL.CONTRACT_TYPE - 1] || '');
          custPhone = String(values[i][MAP_COL.PHONE - 1] || '');
          found = true; break;
        }
      }
    }
  }
  if (!found) return { success: false, code: 'NOT_FOUND', message: '対象の会員が見つかりません。' };
  // 権限：この会員の担当トレーナーのみ代行可（担当未設定なら任意トレーナー可）。他担当への水平越権を遮断（Codex#8）。オーナーは全顧客可。
  if (!_lbTrainerMaySeeCustomer(trainer, custTrainerId)) return { success: false, code: 'FORBIDDEN', message: 'この会員の担当トレーナーのみ代行予約ができます。' };   // 判定は1か所に寄せる（名簿から読んだ直後＝実在は確認済み）
  var _ctFb = custType;   // 種別＝map優先（customerId精密）。空欄は電話で同名を絞った契約から（氏名単独フォールバックはしない・Codex#2）。
  if (!_ctFb) { var _c = _lbFindContract(name, custPhone); _ctFb = (_c && _c.cols.type >= 0) ? String(_c.row[_c.cols.type] || '') : ''; }
  return _lbReserveCore({ customerId: customerId, customerName: name, lineUserId: custLine, contractType: _ctFb,
    actingTrainer: (trainer && trainer.name) || '', actingTrainerId: (trainer && trainer.trainerId) || '' }, body, 'trainer_manual');
}

// 非LINE会員の代理登録：LINEを使わない/電話取得できない会員を customer_line_map に登録（line_user_idなし・verified）。
//   これでトレーナーの担当一覧に出て、代行予約＋残数追跡が可能になる。契約(氏名+電話)照合で実在会員のみ・冪等。
//   オーナーがGASエディタで実行、または管理UIから。generated customerId は selfRegister と同形式（C+時刻）。
// ★GASエディタから使う実行用ランナー：下の「氏名」「電話」を書き換えてこの関数を実行する。
//   （addOfflineMember を直接「実行」すると引数が渡らず何も起きないため、必ずこのランナーを使う）。
function runAddOfflineMember() {
  var 氏名 = '';   // ← 例：'山田太郎'（非LINE会員の氏名）
  var 電話 = '';   // ← 電話があれば入れる。無ければ空のまま
  if (!String(氏名).trim()) { Logger.log('⛔ 上の 氏名 に会員名を入れてから runAddOfflineMember を実行してください（addOfflineMemberの直接実行は不可）。'); return; }
  var r = addOfflineMember(氏名, 電話);
  Logger.log('addOfflineMember 結果: ' + JSON.stringify(r));
  return r;
}

function addOfflineMember(name, phone) {
  name = String(name || '').trim();
  if (!name) { Logger.log('⛔ addOfflineMember: 氏名が空です。GASエディタからは runAddOfflineMember（氏名を記入）を実行してください。'); return { success: false, code: 'BAD_REQUEST', message: '氏名を入れてください。' }; }
  var c = _lbFindContract(name, phone);
  if (!c) return { success: false, code: 'NOT_FOUND', message: '契約が見つかりません。氏名（＋電話）をご確認ください。' };
  var kind = (c.cols.type >= 0) ? String(c.row[c.cols.type] || '') : '';
  var trId = _lbTrainerIdByName((c.cols.trainer >= 0) ? String(c.row[c.cols.trainer] || '') : '');
  var sh = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (!sh) return { success: false, code: 'NO_SHEET', message: 'customer_line_map未作成' };
  var phoneN = _lbNormPhone(phone), targetName = _lbNormName(name);
  var lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    var last = sh.getLastRow();
    if (last >= 2) {   // 冪等：氏名(＋電話)一致の既存があればそのcustomerIdを返す
      var vals = sh.getRange(2, 1, last - 1, MAP_COL.NOTE).getValues();
      for (var i = 0; i < vals.length; i++) {
        if (_lbNormName(vals[i][MAP_COL.NAME - 1]) === targetName && (!phoneN || _lbNormPhone(vals[i][MAP_COL.PHONE - 1]) === phoneN)) {
          return { success: true, customerId: String(vals[i][MAP_COL.CUSTOMER_ID - 1]), name: name, existing: true };
        }
      }
    }
    var customerId = 'C' + Utilities.formatDate(new Date(), SETTINGS.TIMEZONE, 'yyyyMMddHHmmss');
    var row = sh.getLastRow() + 1;
    sh.getRange(row, MAP_COL.CUSTOMER_ID).setValue(sanitizeCell(customerId));
    sh.getRange(row, MAP_COL.NAME).setValue(sanitizeCell(name));
    if (phoneN) sh.getRange(row, MAP_COL.PHONE).setValue(phoneN);
    if (kind) sh.getRange(row, MAP_COL.CONTRACT_TYPE).setValue(sanitizeCell(kind));
    if (trId) sh.getRange(row, MAP_COL.TRAINER_ID).setValue(trId);
    sh.getRange(row, MAP_COL.AUTH_STATE).setValue('verified');   // LINE無しでも会員として扱う＝担当一覧・代行・残数が有効に
    sh.getRange(row, MAP_COL.LINKED_AT).setValue(Utilities.formatDate(new Date(), SETTINGS.TIMEZONE, 'yyyy/MM/dd HH:mm'));
    Logger.log('addOfflineMember: ' + name + ' を非LINE会員として登録（customerId=' + customerId + '・担当' + trId + '・種別' + kind + '）');
    return { success: true, customerId: customerId, name: name, existing: false };
  } finally { lock.releaseLock(); }
}

// ============================================================
// 未登録客の枠確保（LINE管理画面・トレーナー/オーナー限定）
//   予約枠(makeAdminBooking)：本予約書式 [RESERVED] 種別_担当姓_お名前様_line を B1＋トレーナーcal に作成。
//     customerId/契約は不要（カレンダーのみ）＝会員登録後に syncExistingReservations がフルネーム一致で
//     自動紐付け→残数へ計上。※体験/カウンセリングは同期の isSessionKind 外＝枠確保のみ（残数非計上・正当）。
//   ブロック(makeBlock)：ブロック_ラベル を B1＋トレーナーcal に作成＝施設/担当の枠を塞ぐ（空き枠から除外）。
//   どちらも二重予約チェック（B1競合＋トレーナー空き＋過去/horizon上限）を先に通す（fail-closed）。
//   台帳(line_reservations)には書かない＝残数モデルは触れず、カレンダーのみ。billingは[RESERVED]をB1で拾う。
// ============================================================
var LB_ADMIN_KINDS = { '体験':1, '通常':1, 'モニター':1, 'レンタル':1 };   // 未登録客の枠に使う実在種別のみ（billing CONTENT_TYPES準拠）。通常/モニターは登録後に残数計上、体験は枠確保のみ、レンタルは場所貸し(残数非計上・billing-2000)。チケットは通常の残数フローで扱う。

// 入力サニタイズ：'_'（書式区切り）を全角へ退避、改行除去、末尾「様」除去、数式無害化(sanitizeCell)。
function _lbAdminSanitize(s) {
  var t = String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').replace(/_/g, '＿');
  t = t.replace(/^\s+|\s+$/g, '').replace(/\s+/g, ' ');
  return String(sanitizeCell(t)).replace(/様+$/, '');
}

// 日時・トレーナー・権限・競合を検証（枠作成の共通ガード）。ok時 {ok,start,end,tr,calB1}。
// kind＝枠の種別。'体験' は実際に TRIAL_SESSION_MINUTES（90分）押さえる。
//   表示・案内は60分のままだが、カウンセリングと館内案内で実際は60分で終わらないため（2026-09-26）。
//   体験サイト(コード.js)だけに入れていたので、トレーナーが管理画面から取る枠が60分のままだった。
function _lbAdminSlotGuard(trainer, trainerId, startISO, kind) {
  var tr = _lbTrainerById(String(trainerId || ''));
  if (!tr) return { ok:false, code:'BAD_REQUEST', message:'担当が正しくありません。' };
  // 権限：オーナーは任意トレーナー可／一般トレーナーは自分の担当枠のみ（水平越権を遮断）
  if (!_lbIsOwnerRole(trainer) && String(tr.id) !== String((trainer && trainer.trainerId) || ''))
    return { ok:false, code:'FORBIDDEN', message:'ご自身の担当枠のみ作成できます。' };
  if (!startISO) return { ok:false, code:'BAD_REQUEST', message:'日時が指定されていません。' };
  var start = new Date(startISO);
  if (isNaN(start.getTime())) return { ok:false, code:'BAD_REQUEST', message:'日時が正しくありません。' };
  var nowMs = new Date().getTime();
  if (start.getTime() < nowMs) return { ok:false, code:'PAST_TIME', message:'過去の時間には作成できません。' };
  if (start.getTime() > nowMs + 400 * 86400000) return { ok:false, code:'TOO_FAR', message:'指定日時が遠すぎます。' };
  var _mins = (String(kind || '').indexOf('体験') >= 0)
    ? (SETTINGS.TRIAL_SESSION_MINUTES || SETTINGS.SESSION_MINUTES) : SETTINGS.SESSION_MINUTES;
  var end = new Date(start.getTime() + _mins * 60000);
  var calB1 = CalendarApp.getCalendarById(CALENDAR_IDS.CAPACITY_B1);
  if (!calB1) return { ok:false, code:'NO_CALENDAR', message:'カレンダーを取得できませんでした。' };
  // 施設B1(capacity-1)の競合のみで二重予約を防ぐ。出勤シフト内外は問わない＝トレーナーの意図的な枠確保
  //   （翌月シフト提出前の先取り・特別対応も許可）。[消化]は席開放で除外。
  var b1busy = calB1.getEvents(start, end).filter(function (ev) {
    if (String(ev.getTitle()).indexOf('[消化]') === 0) return false;
    return _lbEventOverlaps(ev, start.getTime(), end.getTime());   // 接するだけの予定は競合にしない（2026-09-26）
  });
  if (b1busy.length > 0) return { ok:false, code:'SLOT_TAKEN', message:'この時間帯はすでに予定が入っています。別の時間をお選びください。' };
  return { ok:true, start:start, end:end, tr:tr, calB1:calB1 };
}

function makeAdminBooking(trainer, body) {
  var custName = _lbAdminSanitize(body.customerName);
  var kind = String(body.kind || '通常').replace(/^\s+|\s+$/g, '');
  if (!custName) return { success:false, code:'BAD_REQUEST', message:'お名前を入力してください。' };
  if (!LB_ADMIN_KINDS[kind]) return { success:false, code:'BAD_KIND', message:'種別が正しくありません。' };
  var lock = LockService.getScriptLock(); if (!lock.tryLock(10000)) return { success:false, code:'BUSY', message:'混み合っています。少し待って再度お試しください。' };
  try {
    var g = _lbAdminSlotGuard(trainer, body.trainerId, body.startISO, kind);   // 体験は90分押さえる
    if (!g.ok) return { success:false, code:g.code, message:g.message };
    var lastName = g.tr.name.split(' ')[0];
    var _testPfx = _lbIsStaging() ? '[TEST] ' : '';
    var capTitle = _testPfx + '[RESERVED] ' + kind + '_' + lastName + '_' + _lbWithSama(custName) + '_line';
    var desc = '担当：' + g.tr.name + '\nchannel：admin_hold\n未登録客の枠確保（会員登録後に同期で残数計上）\n作成：' + ((trainer && trainer.name) || '') + '(' + ((trainer && trainer.trainerId) || '') + ')';
    g.calB1.createEvent(capTitle, g.start, g.end, { description: desc });
    var tcal = CalendarApp.getCalendarById(g.tr.email);
    if (tcal) tcal.createEvent(_testPfx + '✅ ' + custName + '様｜セッション_line', g.start, g.end, { description: desc });
    Logger.log('makeAdminBooking: ' + capTitle + ' @ ' + Utilities.formatDate(g.start, SETTINGS.TIMEZONE, 'MM/dd HH:mm'));
    return { success:true, title: capTitle, kind: kind, customerName: custName, trainerName: g.tr.name,
      start: Utilities.formatDate(g.start, SETTINGS.TIMEZONE, 'yyyy/MM/dd HH:mm') };
  } finally { lock.releaseLock(); }
}

// ============================================================
// 自分が作った「未登録客の枠」「ブロック」を一覧・削除する
//   これらは台帳に書かない＝顧客詳細のキャンセルでは消せず、Googleカレンダーを
//   直接開くしかなかった。管理画面で完結させる。
//   ★消せるのは admin_hold（未登録客の枠）と block（枠を塞ぐ）だけ。
//     会員の本予約は絶対に消さない（誤操作で予約を失わせない）。
//   ★一般トレーナーは自分が作ったものだけ。オーナー/管理者は全部。
// ============================================================
function _lbAdminSlotKind(desc) {
  var d = String(desc || '');
  if (d.indexOf('admin_hold') >= 0) return 'hold';
  if (d.indexOf('block：') >= 0) return 'block';
  return '';
}
function listAdminSlots(lineUserId) {
  var tr = requireTrainer(lineUserId);
  if (!tr) return { success: false, code: 'FORBIDDEN', message: 'トレーナーのみ利用できます。' };
  var isOwner = _lbIsOwnerRole(tr), tz = SETTINGS.TIMEZONE, now = new Date();
  var endD = new Date(now.getTime() + 120 * 86400000);   // 先の分も消せるよう広めに見る
  var cal = CalendarApp.getCalendarById(CALENDAR_IDS.CAPACITY_B1);
  if (!cal) return { success: false, code: 'NO_CALENDAR', message: 'カレンダーを取得できませんでした。' };
  var evs = cal.getEvents(now, endD), out = [];
  for (var i = 0; i < evs.length; i++) {
    var desc = ''; try { desc = String(evs[i].getDescription() || ''); } catch (e) {}
    var kind = _lbAdminSlotKind(desc);
    if (!kind) continue;
    // 一般トレーナーは自分が作ったものだけ（descの「作成：名前(ID)」で判定）
    if (!isOwner && desc.indexOf('(' + tr.trainerId + ')') < 0) continue;
    var st = evs[i].getStartTime();
    var id = ''; try { id = String(evs[i].getId()); } catch (e) { continue; }   // IDが取れない予定は対象外
    out.push({ id: id, kind: kind, title: String(evs[i].getTitle()),
               when: _lbFmtWhenJa(st), startISO: st.toISOString() });
  }
  out.sort(function (a, b) { return a.startISO < b.startISO ? -1 : 1; });
  return { success: true, isOwner: isOwner, slots: out };
}

function deleteAdminSlot(lineUserId, eventId) {
  var tr = requireTrainer(lineUserId);
  if (!tr) return { success: false, code: 'FORBIDDEN', message: 'トレーナーのみ利用できます。' };
  if (!eventId) return { success: false, code: 'BAD_REQUEST', message: '対象が指定されていません。' };
  var cal = CalendarApp.getCalendarById(CALENDAR_IDS.CAPACITY_B1);
  if (!cal) return { success: false, code: 'NO_CALENDAR', message: 'カレンダーを取得できませんでした。' };
  var ev = null; try { ev = cal.getEventById(String(eventId)); } catch (e) { ev = null; }
  if (!ev) return { success: false, code: 'NOT_FOUND', message: 'この予定は見つかりませんでした（既に削除された可能性があります）。' };

  var desc = ''; try { desc = String(ev.getDescription() || ''); } catch (e) {}
  var kind = _lbAdminSlotKind(desc);
  // ★本予約は絶対に消さない
  if (!kind) return { success: false, code: 'NOT_ADMIN_SLOT', message: 'これはお客様のご予約です。顧客の画面からキャンセルしてください。' };
  if (!_lbIsOwnerRole(tr) && desc.indexOf('(' + tr.trainerId + ')') < 0) {
    return { success: false, code: 'FORBIDDEN', message: 'ご自身が作成した枠のみ削除できます。' };
  }

  var title = String(ev.getTitle()), start = ev.getStartTime(), tz = SETTINGS.TIMEZONE;
  // 既に会員の予約として台帳に取り込まれていないか（取り込み後は残数に影響するため通常のキャンセル経路へ）
  var sh = _lbSheet(LINE_BOOKING.RESV_SHEET);
  if (sh && sh.getLastRow() > 1) {
    var key = Utilities.formatDate(start, tz, 'yyyyMMddHHmm');
    var v = sh.getRange(2, 1, sh.getLastRow() - 1, 11).getValues();
    for (var j = 0; j < v.length; j++) {
      if (String(v[j][6]) !== 'confirmed') continue;
      var d = _lbParseResvDate(v[j][0]);
      if (d && Utilities.formatDate(d, tz, 'yyyyMMddHHmm') === key) {
        return { success: false, code: 'ALREADY_LINKED',
                 message: 'この枠は既にお客様のご予約として登録されています（' + String(v[j][1]) + '様）。顧客の画面からキャンセルしてください。' };
      }
    }
  }

  // 担当カレンダー側の対になる予定も消す（枠作成時に同時刻で作っている）
  var removedTrainer = 0;
  for (var t = 0; t < CALENDAR_IDS.TRAINERS.length; t++) {
    var trn = CALENDAR_IDS.TRAINERS[t];
    if (!trn.email) continue;
    var tcal = null; try { tcal = CalendarApp.getCalendarById(trn.email); } catch (e) { tcal = null; }
    if (!tcal) continue;
    try {
      var end = new Date(start.getTime() + SETTINGS.SESSION_MINUTES * 60000);
      tcal.getEvents(start, end).forEach(function (te) {
        if (te.getStartTime().getTime() !== start.getTime()) return;   // 同時刻のみ
        var tt = String(te.getTitle());
        var same = (kind === 'block') ? (tt === title)
                 : (tt.indexOf('✅') === 0 && tt.indexOf('_line') >= 0);   // 枠はトレーナーcalでは ✅…_line
        if (!same) return;
        try { te.deleteEvent(); removedTrainer++; } catch (e2) { Logger.log('担当cal削除失敗: ' + e2.message); }
      });
    } catch (e3) { Logger.log('担当cal走査失敗: ' + e3.message); }
  }

  try { ev.deleteEvent(); } catch (e4) { return { success: false, code: 'DELETE_FAILED', message: '削除できませんでした：' + e4.message }; }
  Logger.log('deleteAdminSlot: ' + title + ' @ ' + Utilities.formatDate(start, tz, 'MM/dd HH:mm') + '（担当cal ' + removedTrainer + '件）');
  return { success: true, title: title, when: _lbFmtWhenJa(start), trainerRemoved: removedTrainer };
}

function makeBlock(trainer, body) {
  var label = _lbAdminSanitize(body.label);
  var lock = LockService.getScriptLock(); if (!lock.tryLock(10000)) return { success:false, code:'BUSY', message:'混み合っています。少し待って再度お試しください。' };
  try {
    var g = _lbAdminSlotGuard(trainer, body.trainerId, body.startISO);
    if (!g.ok) return { success:false, code:g.code, message:g.message };
    var _testPfx = _lbIsStaging() ? '[TEST] ' : '';
    var title = _testPfx + 'ブロック_' + (label || '仮押さえ');
    var desc = '担当：' + g.tr.name + '\nblock：枠確保（施設/担当）\n作成：' + ((trainer && trainer.name) || '') + '(' + ((trainer && trainer.trainerId) || '') + ')';
    g.calB1.createEvent(title, g.start, g.end, { description: desc });
    var tcal = CalendarApp.getCalendarById(g.tr.email);
    if (tcal) tcal.createEvent(title, g.start, g.end, { description: desc });
    Logger.log('makeBlock: ' + title + ' @ ' + Utilities.formatDate(g.start, SETTINGS.TIMEZONE, 'MM/dd HH:mm'));
    return { success:true, title: title, trainerName: g.tr.name,
      start: Utilities.formatDate(g.start, SETTINGS.TIMEZONE, 'yyyy/MM/dd HH:mm') };
  } finally { lock.releaseLock(); }
}

// 既存予約同期：トレーナーカレンダーの未来予約(種別_担当_顧客様)を読み、名前一致→line_reservationsに取り込み、
//   不一致(レンタル・表記ゆれ)→line_unlinkedシートに出力(手動紐付け用)。オーナーがGASエディタで実行。
// 既存予約同期（運用モデル確定版 2026-08-05）：B1＋1F施設カレンダーの `種別_担当姓_顧客` を読み、
//   会員セッション種別（通常/モニター/オンライン）のみを line_reservations に取り込む。レンタル/体験は非計上でスキップ。
//   担当はタイトルparts[1](姓)→trainerId。dedupは calendar_event_id（col13）。dryRun=true で書込ゼロのプレビュー。
//   会員照合＝登録済み(customer_line_map verified)のみ自動取込。未登録の会員セッション候補は line_unlinked へ（後で手動紐付け）。
function syncExistingReservations(dryRun) {
  var tz = SETTINGS.TIMEZONE;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { success: false, message: 'ロック取得失敗（他の処理が実行中）' };   // Codex#3：並行実行の二重取込を防止
  try {
    var resvSh = _lbSheet(LINE_BOOKING.RESV_SHEET);
    if (!resvSh) return { success: false, message: 'line_reservations未作成' };
    _lbEnsureResvSchema();   // 15列スキーマを保証（旧12列シートに col13-15 のヘッダを補う）
    var existing = {}, existingKey = {};                // existing=calendar_event_id取込済み判定／existingKey=内容キー(日時|顧客|担当)＝event ID欠落行の二重取込防止（当月過去取込の安全化・Codex）
    var rlast = resvSh.getLastRow();
    if (rlast >= 2) {
      var rvals = resvSh.getRange(2, 1, rlast - 1, 14).getValues();
      for (var i = 0; i < rvals.length; i++) {
        var ev13 = String(rvals[i][12] || ''); if (ev13) existing[ev13] = true;
        var st6 = String(rvals[i][6] || '');            // 有効行(confirmed/consumed)のみ内容dedup対象＝取消/変更済は再同期を妨げない
        if (st6 === 'confirmed' || st6 === 'consumed') { var _ed = _lbParseResvDate(rvals[i][0]); if (_ed) existingKey[Utilities.formatDate(_ed, tz, 'yyyyMMddHHmm') + '|' + _lbNormName(rvals[i][1]) + '|' + String(rvals[i][4] || '')] = true; }
      }
    }
    var surToId = {}, idToTrainer = {};
    for (var t0 = 0; t0 < CALENDAR_IDS.TRAINERS.length; t0++) { var tr0 = CALENDAR_IDS.TRAINERS[t0]; surToId[_lbNormTok(tr0.name.split(' ')[0])] = tr0.id; idToTrainer[tr0.id] = tr0; }
    // verified会員を氏名で一度だけロード（Codex NEW-1：分類のisMemberへ渡す＋同名一意判定に共用）。
    var memByName = {}, unverifiedNames = {};
    var mapSh = _lbSheet(LINE_BOOKING.MAP_SHEET);
    if (mapSh && mapSh.getLastRow() >= 2) {
      var mv = mapSh.getRange(2, 1, mapSh.getLastRow() - 1, MAP_COL.NOTE).getValues();
      for (var mi = 0; mi < mv.length; mi++) {
        var nm = _lbNormName(mv[mi][MAP_COL.NAME - 1]); if (!nm) continue;
        if (String(mv[mi][MAP_COL.AUTH_STATE - 1]) === 'verified') {
          (memByName[nm] = memByName[nm] || []).push({ customerId: String(mv[mi][MAP_COL.CUSTOMER_ID - 1]), lineUserId: String(mv[mi][MAP_COL.LINE_USER_ID - 1]) });
        } else { unverifiedNames[nm] = true; }
      }
    }
    var copts = { b1Id: CALENDAR_IDS.CAPACITY_B1, oneFId: CALENDAR_IDS.CAPACITY_1F, surToId: surToId, isMember: function (c) { return !!memByName[_lbNormName(c)]; } };
    // 同期の窓＝【今月の頭 〜 予約窓の地平(25日ゲート)】。前方は顧客が予約できる範囲に揃える（25日前は当月末まで／25日以降は翌月末まで）。
    //   後方を今月頭に拡張＝手動作成の"今月すでに過ぎたセッション"も残数へ計上。移行初期残高は当月始点で凍結＝当月分は二重計上にならない。
    //   ＝25日前は翌月(10月)を走査しない→翌月の定期予定で同期が止まらない（顧客は翌月をまだ予約できないので表示不要）。
    var now = new Date(), endD = _lbBookingHorizonEnd(now);
    var scanFrom = new Date(now.getFullYear(), now.getMonth(), 1);
    var scanTargets = [CALENDAR_IDS.CAPACITY_B1, CALENDAR_IDS.CAPACITY_1F];
    var appendRows = [], unlinked = [], synced = 0, scanned = 0, skippedNonSession = 0, badSur = 0, anomalies = 0, dupInWindow = 0, dupCrossCal = 0;
    var seenEv = {}, seenKey = {}, dupList = [];   // seenEv=同一evId(定期) / seenKey=B1↔1Fの別evID同一予約（日時+顧客+担当+種別）二次dedup（Codex#5）／dupList=定期の疑い一覧
    for (var s = 0; s < scanTargets.length; s++) {
      var cal = CalendarApp.getCalendarById(scanTargets[s]); if (!cal) continue;
      var evs = cal.getEvents(scanFrom, endD);   // 今月頭〜SYNC_DAYS先（過去の当月分も取込）
      for (var e = 0; e < evs.length; e++) {
        var cls = _lbClassifyBooking(String(evs[e].getTitle()), scanTargets[s], copts);   // 分類関数が唯一の正本（Codex#7）
        if (!cls.parsed) continue;
        var evId = evs[e].getId();
        if (seenEv[evId]) { dupInWindow++; if (dupList.length < 40) dupList.push(_lbFmtWhenJaPad(evs[e].getStartTime()) + '  ' + evs[e].getTitle()); continue; }   // 同一window内の重複（定期イベント等）検出＋一覧化
        seenEv[evId] = true;
        if (existing[evId]) continue;                                // 既に取込済み（calendar_event_id）
        var start = evs[e].getStartTime();
        // event ID欠落の既存台帳行との二重取込を防止（当月過去取込の安全化）：同一(日時|顧客|担当)が既にconfirmed/consumedであればスキップ。
        if (existingKey[Utilities.formatDate(start, tz, 'yyyyMMddHHmm') + '|' + _lbNormName(cls.cname) + '|' + cls.trainerId]) { dupCrossCal++; continue; }
        var contentKey = Utilities.formatDate(start, tz, 'yyyyMMddHHmm') + '|' + _lbNormName(cls.cname) + '|' + cls.trainerId + '|' + cls.kind;
        if (seenKey[contentKey]) { dupCrossCal++; continue; }        // B1↔1Fに別event IDで複製された同一予約の二重取込を防止（Codex#5）
        seenKey[contentKey] = true;
        // ★ペアは来店人数(1名/2名)がカレンダーから判定できない＝自動取込すると必ず1名で会計される（fail-open）。
        //   人数はトレーナーの手動紐付けで指定する運用に倒す（line_unlinkedへ）。isSessionKind skipより前に判定（Codex再#1）。
        if (cls.kind === 'ペア') {
          unlinked.push([Utilities.formatDate(start, tz, 'yyyy/MM/dd HH:mm'), cls.cname, cls.sur, cls.kind,
            evId, (cls.trainerId ? '' : '担当姓不明'), 'ペア＝来店人数(2名/1名)の指定が必要']);
          continue;
        }
        var isRental = (cls.kind === 'レンタル');   // レンタルは「登録済み会員」だけ取込（0円pack消化）＝純レンタル非会員はskip（Codex#1）
        if (!cls.isSessionKind && !isRental) { skippedNonSession++; continue; }   // 体験/カウンセリング/未知＝会員セッションでない
        scanned++;
        if (cls.anomaly) anomalies++;
        if (!cls.trainerId) badSur++;
        var nmk = _lbNormName(cls.cname);
        var mm = memByName[nmk] || [];                               // verified会員（全一致・事前ロード）
        if (mm.length === 1 && cls.trainerId && !cls.anomaly) {      // 一意一致＋担当確定＋異常なし のみ自動取込（Codex#9）
          var trainer = idToTrainer[cls.trainerId];
          var _isTransfer = (cls.kind === '振替');                   // 振替は当日消化済みの独立枠＝通常残数を再消化しない（Codex#5-new）
          appendRows.push([
            Utilities.formatDate(start, tz, 'yyyy/MM/dd HH:mm'), cls.cname, mm[0].customerId, mm[0].lineUserId,
            cls.trainerId, trainer.name, 'confirmed', (_isTransfer ? '振替5500(手動請求)' : ''), 'G' + Utilities.formatDate(start, tz, 'yyyyMMddHHmmss') + '_' + cls.trainerId,
            (_isTransfer ? 'transfer' : 'calendar_sync'), Utilities.formatDate(new Date(), tz, 'yyyy/MM/dd HH:mm'), 'S' + Utilities.getUuid(), evId, cls.kind, 1   // col15=来店人数（ペアはここに来ない＝常に1）
          ]);
          existing[evId] = true; synced++;
        } else if (isRental && mm.length === 0 && !unverifiedNames[nmk]) {
          skippedNonSession++;   // 純レンタル（契約/登録なし）＝非会員の場所貸し→unlinkせずskip（ノイズにしない）
        } else {
          var memNote = (mm.length > 1) ? '同名複数(' + mm.length + ')' : (unverifiedNames[nmk] ? '登録済み未認証' : '契約/登録なし');
          unlinked.push([Utilities.formatDate(start, tz, 'yyyy/MM/dd HH:mm'), cls.cname, cls.sur, cls.kind,
            evId, (cls.trainerId ? '' : '担当姓不明'), memNote + (cls.anomaly ? '/' + cls.anomaly : '')]);
        }
      }
    }
    // 定期イベント等でwindow内に同一evIdが複数＝一意キーとして破綻→fail-closed（Codex#8）。
    if (dupInWindow > 0) {
      Logger.log('❌ 同期中止: window内で同一calendar_event_idが' + dupInWindow + '件重複（定期イベントの疑い）。定期予約を単発化してから再実行。');
      Logger.log('--- 定期の疑いがある予定（Googleカレンダーで「単発の予定」に作り直しが必要）---');
      dupList.forEach(function (d) { Logger.log('  ・' + d); });
      return { success: false, code: 'DUP_EVENT_IN_WINDOW', dupInWindow: dupInWindow, scanned: scanned, dupSamples: dupList };
    }
    if (!dryRun) {
      if (appendRows.length) resvSh.getRange(resvSh.getLastRow() + 1, 1, appendRows.length, 15).setValues(appendRows);   // まとめてsetValues（Codex#3）※col15=attendee_count まで
      // line_unlinked は毎回clearContentsで再構築（削除→作成の消失窓を回避・Codex#11）
      var ss = _lbSs();
      var ush = ss.getSheetByName('line_unlinked') || ss.insertSheet('line_unlinked');
      ush.clearContents();
      ush.getRange(1, 1, 1, 7).setValues([['予約日時', '顧客名(カレンダー)', '担当姓', '種別', 'calendar_event_id', '担当メモ', '会員メモ']]);
      if (unlinked.length) ush.getRange(2, 1, unlinked.length, 7).setValues(unlinked);
    } else {
      // #7：dryRunは「取り込む予定」を sync_preview シートに明細出力（日時/顧客名/customerId/担当/種別）＝本番前に人が確認できる。
      try {
        var pss = _lbSs(); var psh = pss.getSheetByName('sync_preview') || pss.insertSheet('sync_preview');
        psh.clearContents();
        psh.getRange(1, 1, 1, 6).setValues([['予約日時', '顧客名', 'customer_id', 'trainer_id', '種別', 'channel']]);
        var prevRows = appendRows.map(function (r) { return [r[0], r[1], r[2], r[4], r[13], r[9]]; });   // 取込予定の要点
        if (prevRows.length) psh.getRange(2, 1, prevRows.length, 6).setValues(prevRows);
      } catch (ex) { Logger.log('sync_preview書込スキップ: ' + ex.message); }
    }
    Logger.log((dryRun ? '[dryRun] ' : '') + '同期: 会員セッション走査' + scanned + '件 / 取込' + synced + '件 / 未紐付け' + unlinked.length +
      '件 / 非セッション(レンタル/体験等)' + skippedNonSession + '件 / 担当姓不明' + badSur + '件 / 異常' + anomalies + '件 / window内重複' + dupInWindow + '件 / 施設間重複' + dupCrossCal + '件');
    return { success: true, dryRun: !!dryRun, scanned: scanned, synced: synced, unlinked: unlinked.length, skippedNonSession: skippedNonSession, badSur: badSur, anomalies: anomalies, dupInWindow: dupInWindow, dupCrossCal: dupCrossCal };
  } finally {
    lock.releaseLock();
  }
}

// line_reservations（A:K・11列）に記録。既存 reservations（マーケ分析用）は一切触らない。
// line_reservations の15列スキーマを保証（無ければ作成・旧12列シートには不足ヘッダを補う）。
//   予約作成・カレンダー同期・手動紐付けの「書き込む全経路」から必ず通す＝列の意味が不定な状態を作らない。
function _lbEnsureResvSchema() {
  var ss = _lbSs();
  var sh = ss.getSheetByName(LINE_BOOKING.RESV_SHEET);
  if (!sh) {
    sh = ss.insertSheet(LINE_BOOKING.RESV_SHEET);
    sh.getRange(1, 1, 1, 15).setValues([[
      '予約日時', '顧客名', 'customer_id', 'line_user_id', 'trainer_id',
      'トレーナー名', 'status', 'payment_flag', '備考', 'channel', '記録日時', 'session_id', 'calendar_event_id', 'book_type', 'attendee_count'
    ]]);
    return sh;
  }
  if (String(sh.getRange(1, 13).getValue() || '') !== 'calendar_event_id') sh.getRange(1, 13).setValue('calendar_event_id');   // 既存12列シートへ列追加（決定0043・billing ID接合用）
  if (String(sh.getRange(1, 14).getValue() || '') !== 'book_type') sh.getRange(1, 14).setValue('book_type');                    // 種別（表示用）列追加
  if (String(sh.getRange(1, 15).getValue() || '') !== 'attendee_count') sh.getRange(1, 15).setValue('attendee_count');          // ペア来店人数（既定1・#ペア）
  return sh;
}
function recordReservationLine(o) {
  var sh = _lbEnsureResvSchema();
  var tz = SETTINGS.TIMEZONE;
  // M1：resIdを全行一意に（秒＋UUID断片）。旧「分精度＋trainerId」は同分・同トレーナーで衝突し
  //   cancel/change の resId 照合が別行を掴む恐れがあった。既存行は旧形式のまま（完全一致照合なので互換）。
  // 永続化境界でも来店人数を厳密検証（1/2のみ）。別経路から不正値が入ると締めまで発覚しないため黙って矯正しない。
  var _ac = (o.attendeeCount == null || o.attendeeCount === '') ? 1 : Number(o.attendeeCount);
  if (!(_ac === 1 || _ac === 2)) throw new Error('INVALID_ATTENDEE_COUNT: ' + o.attendeeCount);
  var resId = 'L' + Utilities.formatDate(o.start, tz, 'yyyyMMddHHmmss') + '_' + o.trainer.id + '_' + Utilities.getUuid().slice(0, 8);
  // H-3：締めの参照キー用に不変の専用 session_id（col L=12）を作成時に一度だけ採番。resId(操作ID)とは別。
  var sessionId = 'S' + Utilities.getUuid();
  sh.appendRow([
    Utilities.formatDate(o.start, tz, 'yyyy/MM/dd HH:mm'),
    sanitizeCell(o.customerName),
    sanitizeCell(o.customerId),
    o.lineUserId || '',
    o.trainer.id,
    o.trainer.name,
    'confirmed',
    (o.channel === 'transfer' ? '振替5500(手動請求)' : ''),
    sanitizeCell(resId),
    o.channel,
    Utilities.formatDate(new Date(), tz, 'yyyy/MM/dd HH:mm'),
    sessionId,
    sanitizeCell(o.calendarEventId || ''),  // col13：B1カレンダーeventID（billing除外のID接合キー）
    sanitizeCell(o.bookType || ''),         // col14：種別（通常/モニター/レンタル/チケット/振替）＝会員表示用
    _ac   // col15：来店人数（ペア=2・既定1・上で1/2に検証済み）
  ]);
  return resId;
}

// 既存 line_reservations 行に calendar_event_id を後付け（決定0043・billing ID接合の前提）。
//   B1イベントを開始時刻+氏名+'_line'で高信頼1件一致のみ採番。0件/複数はskip＋ログ（曖昧は自動確定しない）。冪等（col13空のみ）。
function backfillCalendarEventIds() {
  var sh = _lbSheet(LINE_BOOKING.RESV_SHEET); if (!sh || sh.getLastRow() < 2) return { ok: true, filled: 0, skipped: 0, note: '対象行なし' };
  if (String(sh.getRange(1, 13).getValue() || '') !== 'calendar_event_id') sh.getRange(1, 13).setValue('calendar_event_id');
  var tz = SETTINGS.TIMEZONE, n = sh.getLastRow() - 1;
  var vals = sh.getRange(2, 1, n, 13).getValues();
  var targets = [], minMs = null, maxMs = null;
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][12] || '') !== '') continue;                 // 既に採番済みは触らない（冪等）
    var dt = _lbParseResvDate(vals[i][0]); if (!dt) continue;
    var ms = dt.getTime();
    targets.push({ rowIdx: i, ms: ms, name: String(vals[i][1] || '') });
    if (minMs == null || ms < minMs) minMs = ms;
    if (maxMs == null || ms > maxMs) maxMs = ms;
  }
  if (!targets.length) return { ok: true, filled: 0, skipped: 0, note: '未採番行なし' };
  var calB1 = CalendarApp.getCalendarById(CALENDAR_IDS.CAPACITY_B1);
  var evs = calB1.getEvents(new Date(minMs - 3600000), new Date(maxMs + 3600000));
  var byMs = {};
  for (var e = 0; e < evs.length; e++) {
    var t = evs[e].getTitle(); if (t.indexOf('_line') < 0) continue;   // LINE予約イベントのみ
    var k = evs[e].getStartTime().getTime();
    (byMs[k] = byMs[k] || []).push(evs[e]);
  }
  var filled = 0, skipped = 0, writes = [];
  for (var g = 0; g < targets.length; g++) {
    var tg = targets[g], cand = byMs[tg.ms] || [], hit = [];
    for (var c = 0; c < cand.length; c++) { var ct = cand[c].getTitle(); if (tg.name && ct.indexOf(tg.name) >= 0) hit.push(cand[c]); }
    if (hit.length === 1) { writes.push({ row: tg.rowIdx + 2, id: hit[0].getId() }); filled++; }
    else { skipped++; Logger.log('⚠️ backfill skip（' + hit.length + '件一致）: ' + tg.name + ' ' + Utilities.formatDate(new Date(tg.ms), tz, 'yyyy/MM/dd HH:mm') + ' → 手動照合'); }
  }
  for (var w = 0; w < writes.length; w++) sh.getRange(writes[w].row, 13).setValue(writes[w].id);
  Logger.log('backfillCalendarEventIds: 採番' + filled + '件 / skip' + skipped + '件（対象' + targets.length + '件）');
  return { ok: true, filled: filled, skipped: skipped, targets: targets.length };
}

// ============================================================
// 段階5-4：会計の月次締め（atomic close）— pt-gasが版付き割当結果を確定し billing が読む正本
//   line_allocations: type(manifest/detail) / run_id / month_key / state(STAGING/CLOSED/VOID) /
//     customer_id / payload(JSON {record,closing,...}) / checksum(SHA-256 of canonical) /
//     closed_at / member_count / computed_at / logic_version / input_hash
//   締めは script lock 下・STAGING追記→flush→再読込checksum検証→manifestをCLOSEDに(commit-last)。
//   1会員でも未裁定issueがあれば月全体を締めない(fail-closed)。CLOSED行はimmutable。
// ============================================================
var LB_ALLOC_SHEET = 'line_allocations';
function _lbAllocSheet() {
  var ss = _lbSs();
  var sh = ss.getSheetByName(LB_ALLOC_SHEET);
  if (!sh) {
    sh = ss.insertSheet(LB_ALLOC_SHEET);
    sh.getRange(1, 1, 1, 12).setValues([['type', 'run_id', 'month_key', 'state', 'customer_id', 'payload', 'checksum', 'closed_at', 'member_count', 'computed_at', 'logic_version', 'input_hash']]);
  }
  sh.getRange(1, 3, sh.getMaxRows(), 1).setNumberFormat('@');   // month_key列をテキスト固定＝'2026-07'の日付強制を防ぐ
  return sh;
}
// month_keyセルの正規化：Sheetsが'2026-07'を日付強制してもYYYY-MMへ戻す（型強制耐性・読取側の防波堤）
function _lbMonthKeyCell(x, tz) {
  if (Object.prototype.toString.call(x) === '[object Date]') return Utilities.formatDate(x, tz || 'Asia/Tokyo', 'yyyy-MM');
  var s = String(x).trim();
  var m = s.match(/^(\d{4})[\/\-](\d{1,2})/);
  return m ? (m[1] + '-' + ('0' + m[2]).slice(-2)) : s;
}
function _lbSha256Hex(str) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(str), Utilities.Charset.UTF_8);
  var hex = ''; for (var i = 0; i < bytes.length; i++) { var b = (bytes[i] + 256) % 256; hex += (b < 16 ? '0' : '') + b.toString(16); }
  return hex;
}
function _lbAllocRows(sh) { var last = sh.getLastRow(); if (last < 2) return []; return sh.getRange(2, 1, last - 1, 12).getValues(); }
function _lbFindClosedManifest(sh, monthKey) {
  var v = _lbAllocRows(sh);
  var tz = (sh.getParent && sh.getParent().getSpreadsheetTimeZone()) || 'Asia/Tokyo';
  for (var i = 0; i < v.length; i++) if (String(v[i][0]) === 'manifest' && _lbMonthKeyCell(v[i][2], tz) === String(monthKey) && String(v[i][3]) === 'CLOSED') return { row: i + 2, runId: String(v[i][1]), checksum: String(v[i][6]), memberCount: Number(v[i][8] || 0), logicVersion: String(v[i][10] || '') };
  return null;
}
function _lbClosedDetail(sh, monthKey, customerId) {
  var man = _lbFindClosedManifest(sh, monthKey); if (!man) return null;
  var v = _lbAllocRows(sh);
  // detailの版はmanifest（権威run）の版と完全一致を要求＝版混在runをpt-gas側でも受理しない（billingと判定を揃える）。
  for (var i = 0; i < v.length; i++) if (String(v[i][0]) === 'detail' && String(v[i][1]) === man.runId && String(v[i][4]) === String(customerId)) return { payload: String(v[i][5]), checksum: String(v[i][6]), logicVersion: String(v[i][10] || ''), manifestVersion: man.logicVersion };
  return null;
}
// 会員の当月opening＝前月CLOSEDの closing。checksum再検証で破損を検知（破損は締め側でfail-closed）。
function _lbOpeningForMonth(sh, customerId, monthKey) {
  var prev = _lbOrdToKey(_lbMonthOrd(monthKey) - 1);
  var det = _lbClosedDetail(sh, prev, customerId);
  if (!det) return {};   // 前月に該当会員のdetailなし＝繰越/pack残なし（新規/前月活動なし）
  var pl; try { pl = JSON.parse(det.payload); } catch (e) { return { _corrupt: true }; }
  if (!LB_ALLOC_ACCEPTED_VERSIONS[det.logicVersion] || det.logicVersion !== det.manifestVersion ||
      !_lbCanonicalVersionOk(det.logicVersion, pl.record)) return { _corrupt: true };   // 版混在／版と記録形式の食い違い＝checksum保護の抜け
  if (_lbSha256Hex(_lbAllocationCanonical(pl.record, pl.closing)) !== det.checksum) return { _corrupt: true };   // 前月detail改ざん/破損
  return pl.closing || {};
}
function _lbActiveMembers() {
  var sh = _lbSheet(LINE_BOOKING.MAP_SHEET); if (!sh || sh.getLastRow() < 2) return [];
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, MAP_COL.AUTH_STATE).getValues(), out = [];   // AUTH_STATE(8列)まで読む（NAME幅だと認証列undefinedで全員skip＝会員0になるバグ修正）
  for (var i = 0; i < vals.length; i++) { if (String(vals[i][MAP_COL.AUTH_STATE - 1]) !== 'verified') continue; out.push({ customerId: String(vals[i][MAP_COL.CUSTOMER_ID - 1]), name: String(vals[i][MAP_COL.NAME - 1] || '') }); }
  return out;
}

// opts.cutover=true＝最初の締め(前月CLOSED不要・opening=棚卸し or {})。既定は前月CLOSED必須(fail-closed)。
function closeAllocationMonth(monthKey, opts) {
  monthKey = String(monthKey || ''); opts = opts || {};
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)) return { success: false, code: 'BAD_MONTH', message: 'monthKeyは YYYY-MM' };
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var sh = _lbAllocSheet();
    if (_lbFindClosedManifest(sh, monthKey)) return { success: false, code: 'ALREADY_CLOSED', message: monthKey + ' は締め済み（immutable）' };
    // 前月CLOSED必須（cutover除く）。getClosedAllocationで manifest一意性・集約checksum・件数・全detailを検証した
    //   openingのみ採用（個別detailだけの検証では不十分・Codex）。前月未締め/破損は締めない（fail-open防止）。
    var prevKey = _lbOrdToKey(_lbMonthOrd(monthKey) - 1);
    var prevClosings = {};
    if (!opts.cutover) {
      var pc = getClosedAllocation(prevKey);
      if (!pc.ok) return { success: false, code: (pc.code === 'NOT_CLOSED' ? 'PREV_NOT_CLOSED' : 'PREV_' + pc.code), message: '前月(' + prevKey + ')の締めを検証できません: ' + (pc.message || pc.code) };
      prevClosings = pc.closings || {};
    }
    // 失敗残骸のSTAGING run を VOID 化（累積防止）
    _lbVoidStagingRuns(sh, monthKey);

    var tz = SETTINGS.TIMEZONE, carryRate = LINE_BOOKING.CARRYOVER_RATE;
    var closeOrd = _lbMonthOrd(monthKey);
    var y = parseInt(monthKey.slice(0, 4), 10), mm = parseInt(monthKey.slice(5, 7), 10);
    var cutoffMs = new Date(y, mm, 1).getTime() - 1;   // 月末JST（appsscript.json timeZone=Asia/Tokyo 前提）
    var rsh = _lbSheet(LINE_BOOKING.RESV_SHEET);
    if (!rsh) return { success: false, code: 'NO_RESV', message: 'line_reservations未作成＝会計不能（fail-closed）' };
    var rvals = (rsh.getLastRow() >= 2) ? rsh.getRange(2, 1, rsh.getLastRow() - 1, Math.max(12, rsh.getLastColumn())).getValues() : [];

    // 締め対象＝当月に活動(confirmed/consumed)した全 customer_id（退会者含む）∪ verified会員。名前はmap優先・無ければ予約行。
    var memberMap = {}, mems = _lbActiveMembers();
    for (var vm = 0; vm < mems.length; vm++) memberMap[mems[vm].customerId] = { customerId: mems[vm].customerId, name: mems[vm].name };
    for (var rv = 0; rv < rvals.length; rv++) {
      var st = String(rvals[rv][6]); if (st !== 'confirmed' && st !== 'consumed') continue;
      var dt = _lbParseResvDate(rvals[rv][0]); if (!dt || _lbMonthKeyJst(dt.getTime()) !== monthKey) continue;
      var cid = String(rvals[rv][2] || ''); if (!cid) continue;
      if (!memberMap[cid]) memberMap[cid] = { customerId: cid, name: String(rvals[rv][1] || '') };
    }
    // 前月CLOSED runの繰越保持者（当月活動なし）も締め集合に含める＝残高チェーンを切らさない（Codex）。
    //   氏名は customer_line_map から補完（契約照合に必要）。契約終了者は割当器でfreq0→carryOut0＝チェーン自然終了。
    if (!opts.cutover) {
      var nameById = {}, msh = _lbSheet(LINE_BOOKING.MAP_SHEET);
      if (msh && msh.getLastRow() >= 2) { var mvv = msh.getRange(2, 1, msh.getLastRow() - 1, _lbMapWidth(msh)).getValues(); for (var q = 0; q < mvv.length; q++) { var qc = String(mvv[q][MAP_COL.CUSTOMER_ID - 1] || ''); if (qc) nameById[qc] = String(mvv[q][MAP_COL.NAME - 1] || ''); } }
      for (var pcid in prevClosings) if (prevClosings.hasOwnProperty(pcid) && !memberMap[pcid]) memberMap[pcid] = { customerId: pcid, name: nameById[pcid] || '' };
    }
    var members = []; for (var mk in memberMap) if (memberMap.hasOwnProperty(mk)) members.push(memberMap[mk]);

    // 契約シートは1回だけ読む（6分制限・lock占有対策）→ pure filter を会員ごとに
    var csh = _lbContractSheet(); if (!csh || csh.getLastRow() < 2) return { success: false, code: 'NO_CONTRACT_SHEET' };
    var cLastCol = csh.getLastColumn();
    var cCols = _lbContractCols(csh.getRange(1, 1, 1, cLastCol).getValues()[0]);
    var cVals = csh.getRange(2, 1, csh.getLastRow() - 1, cLastCol).getValues();

    var runId = 'R' + Utilities.formatDate(new Date(), tz, 'yyyyMMddHHmmss') + '_' + Utilities.getUuid().slice(0, 6);
    var details = [], blocked = [];
    for (var i = 0; i < members.length; i++) {
      var mem = members[i];
      var fr = _lbFilterContractRowsFrom(cVals, cCols, mem.name, _lbPhoneByCustomerId(mem.customerId), mem.customerId);
      if (fr.migrationGap) { blocked.push({ customerId: mem.customerId, issues: [{ code: 'MIGRATION_GAP' }] }); continue; }
      // 会計projectionを当月分だけに絞る（前月以前は締め済みでopeningに凍結済＝二重・PRE_CUTOVER回避）
      var projAll = _lbBuildAccountingProjection(rvals, mem.customerId, cutoffMs, _lbParseResvDate);
      var sessMonth = [];
      for (var ps = 0; ps < projAll.sessions.length; ps++) { var sa = projAll.sessions[ps].startAt; if (typeof sa === 'number' && isFinite(sa) && _lbMonthKeyJst(sa) === monthKey) sessMonth.push(projAll.sessions[ps]); }
      // opening＝cutoverは棚卸し／通常は検証済み前月closings（getClosedAllocationで集約検証済）
      var opening = opts.cutover ? (opts.opening && opts.opening[mem.customerId] ? opts.opening[mem.customerId] : {}) : (prevClosings[mem.customerId] || {});
      opening = { carry: opening.carry, packsUsed: opening.packsUsed || opening.packs, cutoverMonth: monthKey };   // 当月を境界に（当月sessionのみなのでPRE_CUTOVER無し）
      var run = _lbBuildCloseRun(mem.customerId, fr.rows, sessMonth, opening, monthKey, carryRate, projAll.issues);
      if (!run.ok) { blocked.push({ customerId: mem.customerId, issues: run.issues }); continue; }
      var payload = JSON.stringify({ record: run.record, closing: run.closing, logicVersion: run.logicVersion, inputHash: run.inputHash });
      var checksum = _lbSha256Hex(_lbAllocationCanonical(run.record, run.closing));
      details.push(['detail', runId, monthKey, 'STAGING', mem.customerId, payload, checksum, '', '', Utilities.formatDate(new Date(), tz, 'yyyy/MM/dd HH:mm'), run.logicVersion, String(run.inputHash)]);
    }
    if (blocked.length) return { success: false, code: 'FAIL_CLOSED', message: blocked.length + '名に未裁定issue→月全体を締めません', blocked: blocked };
    // 先にdetailsをSTAGINGで追記（manifestはまだ書かない＝この時点では権威runは存在しない）
    if (details.length) sh.getRange(sh.getLastRow() + 1, 1, details.length, 12).setValues(details);
    SpreadsheetApp.flush();
    // 再読込検証（checksum再計算＋件数）
    var v = _lbAllocRows(sh), rr = [];
    for (var d = 0; d < v.length; d++) if (String(v[d][0]) === 'detail' && String(v[d][1]) === runId) rr.push({ customerId: String(v[d][4]), payload: String(v[d][5]), checksum: String(v[d][6]) });
    if (rr.length !== details.length) return { success: false, code: 'VERIFY_FAIL', message: '再読込件数不一致' };
    var aggParts = [];
    for (var e = 0; e < rr.length; e++) {
      var pl; try { pl = JSON.parse(rr[e].payload); } catch (ex) { return { success: false, code: 'VERIFY_FAIL', message: 'payload破損 ' + rr[e].customerId }; }
      var recheck = _lbSha256Hex(_lbAllocationCanonical(pl.record, pl.closing));
      if (recheck !== rr[e].checksum) return { success: false, code: 'VERIFY_FAIL', message: 'checksum不一致 ' + rr[e].customerId };
      aggParts.push(rr[e].customerId + ':' + recheck);
    }
    var aggChecksum = _lbSha256Hex(aggParts.sort().join('|'));
    // commit-last：manifestを直接CLOSEDで1回appendするのが締め確定点（これ以前にクラッシュしても権威runは無く安全）
    sh.appendRow(['manifest', runId, monthKey, 'CLOSED', '', '', aggChecksum, Utilities.formatDate(new Date(), tz, 'yyyy/MM/dd HH:mm'), details.length, Utilities.formatDate(new Date(), tz, 'yyyy/MM/dd HH:mm'), LB_ALLOC_LOGIC_VERSION, '']);
    return { success: true, monthKey: monthKey, runId: runId, members: details.length, checksum: aggChecksum };
  } finally { lock.releaseLock(); }
}
// 失敗残骸のSTAGING run（同月・未CLOSED）をVOID化（累積防止・監査に残す）
function _lbVoidStagingRuns(sh, monthKey) {
  var v = _lbAllocRows(sh);
  var tz = (sh.getParent && sh.getParent().getSpreadsheetTimeZone()) || 'Asia/Tokyo';
  for (var i = 0; i < v.length; i++) if (_lbMonthKeyCell(v[i][2], tz) === String(monthKey) && String(v[i][3]) === 'STAGING') sh.getRange(i + 2, 4).setValue('VOID');
}

// staging限定：shadow検証用の自己完結テストデータを staging SS に生成（本番契約に触れない）。
//   契約(フォームの回答1)＋会員(customer_line_map)＋7月予約(line_reservations)を作り、
//   STAGING_CONTRACT_SS_ID を staging SS に向ける。実行後：closeAllocationMonth('2026-07',{cutover:true})→lineRevenueShadow('2026-07')。
function seedShadowTest() {
  if (!_lbIsStaging()) { Logger.log('⛔ seedShadowTest は staging限定（STAGING_SPREADSHEET_ID未設定）'); return { success: false, code: 'NOT_STAGING' }; }
  var ss = _lbSs(), tz = SETTINGS.TIMEZONE;
  PropertiesService.getScriptProperties().setProperty('STAGING_CONTRACT_SS_ID', ss.getId());   // 契約もstaging SSから読む
  // 契約フォーム（テスト会員：月額4回¥10000＋チケット5枚¥8000・7月契約）
  var csh = ss.getSheetByName('フォームの回答 1') || ss.insertSheet('フォームの回答 1');
  csh.clearContents();
  csh.getRange(1, 1, 1, 9).setValues([['お客様名', '種別', '頻度', 'チケット枚数', '単価', '開始日', '契約終了日', '電話番号', '報酬割合']]);
  csh.getRange(2, 1, 2, 9).setValues([
    ['テスト太郎', '通常', 4, '', 10000, '2026/07/01', '2026/12/31', '09011112222', 40],
    ['テスト太郎', 'チケット', '', 5, 8000, '2026/07/01', '2026/12/31', '09011112222', 40]
  ]);
  // 会員（customer_line_map）
  var msh = ss.getSheetByName(LINE_BOOKING.MAP_SHEET) || ss.insertSheet(LINE_BOOKING.MAP_SHEET);
  if (msh.getLastRow() === 0) setupLineBookingSheets();   // ヘッダ整備
  msh = ss.getSheetByName(LINE_BOOKING.MAP_SHEET);
  var mrow = msh.getLastRow() + 1;
  msh.getRange(mrow, MAP_COL.LINE_USER_ID).setValue('Utest_shadow');
  msh.getRange(mrow, MAP_COL.CUSTOMER_ID).setValue('CTEST');
  msh.getRange(mrow, MAP_COL.NAME).setValue('テスト太郎');
  msh.getRange(mrow, MAP_COL.PHONE).setValue('09011112222');
  msh.getRange(mrow, MAP_COL.AUTH_STATE).setValue('verified');
  // 7月の予約（6件：月額4＋チケット2消化・全confirmed）
  var rsh = ss.getSheetByName(LINE_BOOKING.RESV_SHEET);
  if (!rsh) { rsh = ss.insertSheet(LINE_BOOKING.RESV_SHEET); rsh.getRange(1, 1, 1, 13).setValues([['予約日時', '顧客名', 'customer_id', 'line_user_id', 'trainer_id', 'トレーナー名', 'status', 'payment_flag', '備考', 'channel', '記録日時', 'session_id', 'calendar_event_id']]); }
  var rows = [];
  for (var d = 1; d <= 6; d++) rows.push(['2026/07/0' + d + ' 10:00', 'テスト太郎', 'CTEST', 'Utest_shadow', 'nakano', '中野', 'confirmed', '', 'Ltest' + d, 'line', '2026/07/0' + d + ' 09:00', 'Sseed' + d, 'evSeed' + d]);   // col13=合成eventID（2b疎通用）
  rsh.getRange(rsh.getLastRow() + 1, 1, rows.length, 13).setValues(rows);
  Logger.log('✅ seedShadowTest: 契約2行＋会員CTEST＋7月予約6件を staging SS(' + ss.getId() + ')に生成。STAGING_CONTRACT_SS_ID設定済。');
  Logger.log('次：closeAllocationMonth("2026-07",{cutover:true}) → billingで lineRevenueShadow("2026-07")。');
  Logger.log('期待＝月額売上40000/チケット売上16000。※報酬はREWARD_RATE_MISSING(テスト会員が本番顧客マスタに無いため・想定内。検証対象は売上)。');
  return { success: true, ssId: ss.getId() };
}

// cutover前の点検（読み取り専用・PIIマスク）：同一人物(氏名+電話一致)が複数の customer_id に分裂している登録を検出。
//   段階4の昇格判定で新規分裂は防止済だが、過去の分裂を統合前に洗い出す。統合は別途レビュー付き一括関数で。
function detectDuplicateRegistrations() {
  var sh = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (!sh || sh.getLastRow() < 2) { Logger.log('detectDuplicateRegistrations: map未作成/空'); return { success: true, dups: 0 }; }
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, _lbMapWidth(sh)).getValues();
  var byKey = {};   // 氏名+電話 → [customerId...]
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][MAP_COL.AUTH_STATE - 1]) !== 'verified') continue;
    var nm = _lbNormName(vals[i][MAP_COL.NAME - 1]), ph = _lbNormPhone(vals[i][MAP_COL.PHONE - 1]);
    if (!nm || !ph) continue;
    var key = nm + '|' + ph, cid = String(vals[i][MAP_COL.CUSTOMER_ID - 1] || '');
    if (!byKey[key]) byKey[key] = {};
    if (cid) byKey[key][cid] = true;
  }
  var mask = function (s) { s = String(s || ''); return s ? s.slice(0, 1) + '***' : '(空)'; };
  var dups = 0;
  Logger.log('=== 二重登録検出（読み取り専用）===');
  for (var k in byKey) if (byKey.hasOwnProperty(k)) {
    var ids = Object.keys(byKey[k]);
    if (ids.length > 1) { dups++; Logger.log('⚠️ ' + mask(k.split('|')[0]) + '（同一人物）→ customer_id ' + ids.length + '件に分裂: ' + ids.join(', ')); }
  }
  Logger.log('分裂登録: ' + dups + '件（統合はレビュー付き一括関数で・cutover前）');
  return { success: true, dups: dups };
}

// ================= 二重登録マージ（cutover前・破壊的・preview→hash承認→apply） =================
// ⚠️ draft：本番実行前に決定0044の残ハードニング必須（before-image/merge manifestでの部分適用復旧・
//   canonicalを契約側正規IDに合わせる・生年月日/メール等の第2要素確認・TOCTOUスナップショットhash）。
//   現状は cheap guard（hash文字列比較・空氏名電話fail-closed・cid複数グループabort・verified限定・CLOSED存在ガード・ScriptLock）まで。
// 同一人物(氏名+電話)が複数customer_idに分裂している場合、正規ID(最古LINKED_AT)へ統合。
//   customer_line_map と line_reservations の customer_id を書き換える。★締め前のみ安全（CLOSED記録は不変・後だとchecksum不整合）。
// マージ計画を構築（純粋に近い・map/予約から）。canonical=グループ内で最古LINKED_ATのcid（同点はcid昇順）。
function _lbBuildMergePlan() {
  var sh = _lbSheet(LINE_BOOKING.MAP_SHEET); if (!sh || sh.getLastRow() < 2) return { groups: [], fromTo: {}, hashInput: '', incomplete: [], conflict: [] };
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, MAP_COL.NOTE).getValues();
  var byKey = {}, cidKey = {}, incomplete = [];   // 氏名+電話 → { cid: earliestLinkedMs }／cid→key（矛盾検知）
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][MAP_COL.AUTH_STATE - 1]) !== 'verified') continue;
    var cid = String(vals[i][MAP_COL.CUSTOMER_ID - 1] || ''); if (!cid) continue;
    var nm = _lbNormName(vals[i][MAP_COL.NAME - 1]), ph = _lbNormPhone(vals[i][MAP_COL.PHONE - 1]);
    if (!nm || !ph) { incomplete.push(cid); continue; }   // 空氏名/電話＝fail-closed対象（silent skipで「分裂なし」誤判定を防ぐ・Codex#7）
    var la = _lbParseResvDate(vals[i][MAP_COL.LINKED_AT - 1]); var ms = (la && !isNaN(la.getTime())) ? la.getTime() : 8.64e15;
    var key = nm + '|' + ph;
    if (cidKey[cid] != null && cidKey[cid] !== key) { /* 同一cidが別グループ＝データ矛盾 */ } else cidKey[cid] = key;
    if (!byKey[key]) byKey[key] = {};
    if (byKey[key][cid] == null || ms < byKey[key][cid]) byKey[key][cid] = ms;
  }
  var groups = [], fromTo = {}, hashParts = [], conflict = [];
  for (var k in byKey) if (byKey.hasOwnProperty(k)) {
    var cids = Object.keys(byKey[k]); if (cids.length < 2) continue;
    cids.sort(function (a, b) { var d = byKey[k][a] - byKey[k][b]; return d !== 0 ? d : (a < b ? -1 : (a > b ? 1 : 0)); });   // 最古→cid昇順
    var canonical = cids[0], froms = cids.slice(1);
    for (var f = 0; f < froms.length; f++) {
      if (fromTo[froms[f]] != null && fromTo[froms[f]] !== canonical) { conflict.push(froms[f]); continue; }   // 同一from-cidが複数canonicalへ＝矛盾→中止対象
      fromTo[froms[f]] = canonical; hashParts.push(froms[f] + '>' + canonical);
    }
    groups.push({ key: k, canonical: canonical, from: froms });
  }
  hashParts.sort();
  return { groups: groups, fromTo: fromTo, hashInput: hashParts.join('|'), incomplete: incomplete, conflict: conflict };
}

// dry-run：統合計画と影響予約数を表示（書込なし）。maskで氏名を伏せる。
function previewMergeDuplicates() {
  var plan = _lbBuildMergePlan();
  if (plan.incomplete.length) Logger.log('⚠️ 氏名/電話欠損のverified会員 ' + plan.incomplete.length + '件＝マージ不可（補完後に再実行）: ' + plan.incomplete.join(','));
  if (plan.conflict.length) Logger.log('⚠️ 同一cidが複数グループに出現 ' + plan.conflict.length + '件＝データ矛盾（要人手）: ' + plan.conflict.join(','));
  if (!plan.groups.length) { Logger.log('previewMergeDuplicates: 分裂なし'); return { ok: plan.incomplete.length === 0 && plan.conflict.length === 0, groups: 0, incomplete: plan.incomplete.length, conflict: plan.conflict.length, hash: _lbHashStr('') }; }
  var rsh = _lbSheet(LINE_BOOKING.RESV_SHEET);
  var rvals = (rsh && rsh.getLastRow() >= 2) ? rsh.getRange(2, 1, rsh.getLastRow() - 1, Math.max(12, rsh.getLastColumn())).getValues() : [];
  var affected = {};
  for (var i = 0; i < rvals.length; i++) { var c = String(rvals[i][2] || ''); if (plan.fromTo[c]) affected[c] = (affected[c] || 0) + 1; }
  var mask = function (s) { s = String(s || ''); return s ? s.slice(0, 1) + '***' : '(空)'; };
  var hash = _lbHashStr(plan.hashInput);
  Logger.log('=== previewMergeDuplicates（書込なし）hash=' + hash + ' ===');
  for (var g = 0; g < plan.groups.length; g++) {
    var gr = plan.groups[g], cnt = 0; for (var q = 0; q < gr.from.length; q++) cnt += (affected[gr.from[q]] || 0);
    Logger.log('  ' + mask(gr.key.split('|')[0]) + ': ' + gr.from.join(',') + ' → ' + gr.canonical + '（予約' + cnt + '件を付替え）');
  }
  PropertiesService.getScriptProperties().setProperty('LB_MERGE_APPROVED', hash);
  Logger.log('→ 問題なければ runMergeDuplicatesApproved() で実行（内容確認後）');
  return { ok: true, groups: plan.groups.length, hash: hash };
}

// GASエディタRunボタン用（引数不可対応）：preview時に保存したhashで実行。run側で計画再構築しhash再照合（変化ならmismatch）。
function runMergeDuplicatesApproved() {
  var appr = String(_lbProp('LB_MERGE_APPROVED') || '');
  if (!appr) return { success: false, code: 'NO_PREVIEW', message: '先に previewMergeDuplicates() を実行し内容確認を' };
  return runMergeDuplicates(appr);
}

// 承認実行：hash一致を確認→ map と line_reservations の customer_id を canonical へ書換（ScriptLock・cutover前限定）。
function runMergeDuplicates(approvedHash) {
  var lock = LockService.getScriptLock(); if (!lock.tryLock(30000)) return { success: false, code: 'LOCKED' };
  try {
    var plan = _lbBuildMergePlan();
    if (plan.incomplete.length) return { success: false, code: 'INCOMPLETE_IDENTITY', detail: plan.incomplete, message: '氏名/電話欠損のverified会員あり→補完後に再実行' };
    if (plan.conflict.length) return { success: false, code: 'CID_GROUP_CONFLICT', detail: plan.conflict, message: '同一cidが複数グループ＝データ矛盾→人手解消' };
    if (!plan.groups.length) return { success: true, merged: 0, note: '分裂なし' };
    var hash = _lbHashStr(plan.hashInput);
    if (approvedHash == null || String(approvedHash) !== String(hash)) return { success: false, code: 'HASH_MISMATCH', currentHash: hash, message: '分裂状況が変化→再preview必須' };
    // 締め済みがあると checksum 不整合になるためガード（cutover前のみ許可）
    var ash = _lbAllocSheet();
    if (ash && ash.getLastRow() >= 2) { var av = _lbAllocRows(ash); for (var a = 0; a < av.length; a++) if (String(av[a][0]) === 'manifest' && String(av[a][3]) === 'CLOSED') return { success: false, code: 'ALREADY_CLOSED_EXISTS', message: 'CLOSED記録あり＝マージ不可（ID書換でchecksum不整合）。締め前に実施すべき' }; }
    // 1) line_reservations の customer_id 付替え
    var rsh = _lbSheet(LINE_BOOKING.RESV_SHEET), rMoved = 0;
    if (rsh && rsh.getLastRow() >= 2) {
      var rvals = rsh.getRange(2, 1, rsh.getLastRow() - 1, Math.max(12, rsh.getLastColumn())).getValues();
      for (var i = 0; i < rvals.length; i++) { var c = String(rvals[i][2] || ''); if (plan.fromTo[c]) { rsh.getRange(i + 2, 3).setValue(plan.fromTo[c]); rMoved++; } }
    }
    // 2) customer_line_map の customer_id を canonical へ統一（全行・監査のため行は残す）
    var msh = _lbSheet(LINE_BOOKING.MAP_SHEET), mMoved = 0;
    var mvals = msh.getRange(2, 1, msh.getLastRow() - 1, MAP_COL.NOTE).getValues(), pendingSkipped = 0;
    for (var j = 0; j < mvals.length; j++) {
      var mc = String(mvals[j][MAP_COL.CUSTOMER_ID - 1] || '');
      if (!plan.fromTo[mc]) continue;
      if (String(mvals[j][MAP_COL.AUTH_STATE - 1]) !== 'verified') { pendingSkipped++; continue; }   // pending/rejected（生きた認証コード等）は自動移行しない（Codex#6）
      msh.getRange(j + 2, MAP_COL.CUSTOMER_ID).setValue(plan.fromTo[mc]);
      var note = String(mvals[j][MAP_COL.NOTE - 1] || ''); msh.getRange(j + 2, MAP_COL.NOTE).setValue((note ? note + ' / ' : '') + 'merged<-' + mc);
      mMoved++;
    }
    if (pendingSkipped) Logger.log('⚠️ 非verifiedのfrom-cid行 ' + pendingSkipped + '件は自動移行せず（要人手確認）');
    Logger.log('runMergeDuplicates: 予約' + rMoved + '件・map' + mMoved + '行を canonical へ統合（hash=' + hash + '）');
    return { success: true, groups: plan.groups.length, reservationsMoved: rMoved, mapRowsMoved: mMoved, hash: hash };
  } finally { lock.releaseLock(); }
}

// shadow検証用：GASエディタのRunボタンは引数を渡せないため、引数なしで呼べるラッパー。
function testCloseShadowJuly() { var r = closeAllocationMonth('2026-07', { cutover: true }); Logger.log('closeAllocationMonth結果: ' + JSON.stringify(r)); return r; }

// ================= cutover棚卸しopening（決定0042・Codex10ゲート） =================
// 会計の最上流の根。cutover月M1日時点の凍結残をシートで受け、opening を組み立てて最初の締めに渡す。
//   1) setupCutoverInventorySheet(M) でシート自動生成（会員×契約から固定行・残だけ入力）
//   2) previewCutoverClose(M) で dry-run（issue/breakdown/inputHash を表示・書込なし）
//   3) runCutoverClose(M, hash) で hash一致を確認して cutover締めを実行
var LB_CUTOVER_SHEET = 'cutover_inventory';
var LB_RESIDUAL_INPUT_SHEET = '残数入力';   // オーナー保守の残数リスト（別タブ）。setupがK列へ自動注入する源（B案）。

// オーナー保守の残数リスト（別タブ '残数入力'）を読む。氏名(+電話末尾)で会員に突合。
//   ヘッダ（順不同）：氏名／電話末尾(任意)／月額繰越／残枚数(チケット・レンタル)。完全一致優先→部分一致（"上限""備考"等は除外）。
//   数値は非負整数のみ採用。不正値(負/小数/文字)は bad フラグで注入せず報告。同名・同キー重複は _dupKey で曖昧化。
//   返り値: { exists, err?, byKey, byName, nameCount, entries }。rec={name,phoneTail,monthly,ticket,bad,_dupKey,matched,usedMonthly,usedTicket}
function _lbReadResidualInputTab() {
  var ss = _lbSs();
  var aliases = [LB_RESIDUAL_INPUT_SHEET, '残数ログ', '残数リスト'];   // 別名も許容（オーナー命名ゆれ吸収）
  var sh = null;
  for (var a = 0; a < aliases.length; a++) { sh = ss.getSheetByName(aliases[a]); if (sh) break; }
  if (!sh) return { exists: false, byKey: {}, byName: {}, nameCount: {}, entries: [] };
  var lastCol = sh.getLastColumn();
  var hdr = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  function nrm(s) { return String(s == null ? '' : s).replace(/\s/g, ''); }
  function findCol(exacts, partials, excludes) {
    for (var i = 0; i < hdr.length; i++) if (exacts.indexOf(nrm(hdr[i])) >= 0) return i;   // 完全一致優先
    for (var i2 = 0; i2 < hdr.length; i2++) {
      var h = nrm(hdr[i2]), bad = false;
      for (var e2 = 0; e2 < (excludes || []).length; e2++) if (h.indexOf(excludes[e2]) >= 0) { bad = true; break; }
      if (bad) continue;
      for (var j = 0; j < partials.length; j++) if (h.indexOf(partials[j]) >= 0) return i2;
    }
    return -1;
  }
  var cN = findCol(['氏名', 'お客様名', '名前', '会員名'], ['氏名', '名前'], []);
  if (cN < 0) return { exists: true, err: 'NO_NAME_COL', byKey: {}, byName: {}, nameCount: {}, entries: [] };   // ヘッダ検査は行数に依らず先に行う
  var cP = findCol(['電話末尾', '電話番号末尾', '電話', '電話番号'], ['電話', 'tel', 'TEL'], []);
  var cM = findCol(['月額繰越', '月額繰越回数', '繰越回数', '繰越'], ['月額繰越', '繰越'], ['上限']);
  var cT = findCol(['残枚数', 'チケット残', 'レンタル残', '残数'], ['残枚数', '残'], ['備考', '前回', '上限']);
  if (sh.getLastRow() < 2) return { exists: true, byKey: {}, byName: {}, nameCount: {}, entries: [] };
  function numOrNull(cell) {   // 非負整数のみ採用。それ以外は {v:null, bad:true|false}
    if (cell === '' || cell == null) return { v: null, bad: false };
    var n = Number(cell);
    if (isFinite(n) && n >= 0 && Math.floor(n) === n) return { v: n, bad: false };
    return { v: null, bad: true };
  }
  var v = sh.getRange(2, 1, sh.getLastRow() - 1, lastCol).getValues();
  var byKey = {}, byName = {}, nameCount = {}, entries = [];
  for (var i = 0; i < v.length; i++) {
    var nm = String(v[i][cN] || '').replace(/^\s+|\s+$/g, ''); if (!nm) continue;
    var ph = (cP >= 0) ? _lbNormPhone(v[i][cP]) : '';
    var pt = ph ? ph.slice(-4) : '';
    var moR = (cM >= 0) ? numOrNull(v[i][cM]) : { v: null, bad: false };
    var tkR = (cT >= 0) ? numOrNull(v[i][cT]) : { v: null, bad: false };
    var nn = _lbNormName(nm);
    var rec = { name: nm, phoneTail: pt, monthly: moR.v, ticket: tkR.v, bad: (moR.bad || tkR.bad), matched: false, usedMonthly: false, usedTicket: false };
    var kk = nn + '|' + pt;
    if (byKey[kk]) { byKey[kk]._dupKey = true; rec._dupKey = true; }   // 同一キー重複＝曖昧
    byKey[kk] = rec;
    nameCount[nn] = (nameCount[nn] || 0) + 1;
    if (!byName[nn]) byName[nn] = rec;
    entries.push(rec);
  }
  return { exists: true, byKey: byKey, byName: byName, nameCount: nameCount, entries: entries };
}
var LB_CUTOVER_HEADER = ['customer_id', '氏名', '電話末尾', '区分', 'pack_id', '期限', 'qty', '単価', '月額頻度', 'carry上限(参考)', '残入力★未来予約を引く前(月額=繰越/チケット=残枚数)', '状態(空=未入力/数値=入力/対象外)'];

// 会員（customer_line_map verified）→ {cid:{monthlyRows,packs}}。契約シートは1回だけ読む。
function _lbCutoverEntByCustomer(monthKey) {
  var carryRate = LINE_BOOKING.CARRYOVER_RATE;
  var mems = _lbActiveMembers();
  var csh = _lbContractSheet(); if (!csh || csh.getLastRow() < 2) return { err: 'NO_CONTRACT_SHEET' };
  var cLastCol = csh.getLastColumn();
  var cCols = _lbContractCols(csh.getRange(1, 1, 1, cLastCol).getValues()[0]);
  var cVals = csh.getRange(2, 1, csh.getLastRow() - 1, cLastCol).getValues();
  var entByCustomer = {}, meta = {};
  for (var i = 0; i < mems.length; i++) {
    var m = mems[i];
    var fr = _lbFilterContractRowsFrom(cVals, cCols, m.name, _lbPhoneByCustomerId(m.customerId), m.customerId);
    var _re = _lbRowsToEntitlements(fr.rows, carryRate);
    var ent = _re.entitlements;
    if (_re.issues && _re.issues.length) ent._entIssues = _re.issues;   // 不正契約(繰越上限等)をcutoverでもfail-closedにするため伝播（Codex）
    entByCustomer[m.customerId] = ent;
    meta[m.customerId] = { name: m.name, phone: _lbPhoneByCustomerId(m.customerId), migrationGap: fr.migrationGap };
  }
  return { entByCustomer: entByCustomer, meta: meta, carryRate: carryRate };
}

// 棚卸しシートを会員×契約から自動生成（オーナーは残入力のみ。packIdは固定・手入力させない）。
function setupCutoverInventorySheet(monthKey) {
  monthKey = String(monthKey || '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)) { Logger.log('❌ BAD_MONTH: ' + monthKey + '（YYYY-MM形式で。例 2026-09）'); return { ok: false, code: 'BAD_MONTH', message: 'monthKeyは YYYY-MM（例 2026-09）' }; }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) { Logger.log('❌ LOCKED: 他の処理が実行中。少し待って再実行を'); return { ok: false, code: 'LOCKED', message: '他の処理が実行中です。少し待って再実行してください。' }; }
  try {
    var e = _lbCutoverEntByCustomer(monthKey); if (e.err) { Logger.log('❌ ' + e.err + '（契約シート読取不可等）'); return { ok: false, code: e.err }; }
    // 不正契約（繰越上限等の不正値・チケット期限欠損）があれば、既存シートを削除・再生成せず停止（fail-closed・Codex）。
    var entIssues = [];
    var _cidsChk = Object.keys(e.entByCustomer);
    for (var _ci = 0; _ci < _cidsChk.length; _ci++) {
      var _entChk = e.entByCustomer[_cidsChk[_ci]];
      if (_entChk && _entChk._entIssues && _entChk._entIssues.length) {
        for (var _ii = 0; _ii < _entChk._entIssues.length; _ii++) entIssues.push({ customerId: _cidsChk[_ci], code: _entChk._entIssues[_ii].code, detail: _entChk._entIssues[_ii].detail });
      }
    }
    if (entIssues.length) {
      Logger.log('❌ CONTRACT_ENTITLEMENT_INVALID（契約に不備あり・既存シート保護のため停止）:');
      entIssues.forEach(function (x) { Logger.log('  ・' + (e.meta[x.customerId] ? e.meta[x.customerId].name : x.customerId) + ' : ' + x.code + (x.code === 'TICKET_NO_EXPIRY' ? '（レンタル/チケットの契約終了日=有効期限が空欄）' : '') + ' ' + x.detail); });
      Logger.log('→ 上記会員の契約を修正してから再実行してください。');
      return { ok: false, code: 'CONTRACT_ENTITLEMENT_INVALID', message: '契約に不備があります（レンタル/チケットの契約終了日欠損・繰越上限の不正値等）。ログの会員を修正して再実行してください。既存の棚卸しシートは変更していません。', issues: entIssues };
    }
    var tz = SETTINGS.TIMEZONE;
    // オーナー保守の残数リスト（別タブ '残数入力'）を読み、登録済み会員のK列へ自動注入（B案）。
    var resid = _lbReadResidualInputTab();
    if (resid.err === 'NO_NAME_COL') { Logger.log('❌ RESIDUAL_TAB_NO_NAME: 「残数入力」タブに氏名列なし'); return { ok: false, code: 'RESIDUAL_TAB_NO_NAME', message: '「残数入力」タブに「氏名」列が見つかりません。ヘッダに氏名/月額繰越/残枚数を用意してください。既存の棚卸しシートは変更していません。' }; }
    // 前回失敗の残骸から復旧：正規が無くtmp/bakだけ残る状態なら、K/L退避の前に正規へ戻す（復旧値を確実に引き継ぐ・Codex）。
    var CN = LB_CUTOVER_SHEET, TMP = CN + '_tmp', BAK = CN + '_bak';
    var _ssR = _lbSs();
    if (!_ssR.getSheetByName(CN)) { var _rec0 = _ssR.getSheetByName(BAK) || _ssR.getSheetByName(TMP); if (_rec0) _rec0.setName(CN); }
    // 既存シートのK列(残入力)・L列(状態=対象外等)を退避＝リストに無い会員の手入力・対象外指定を消さない（保持・冪等性）。
    var prevInputs = {}, prevStatus = {};
    var _prevSh = _lbSs().getSheetByName(LB_CUTOVER_SHEET);
    if (_prevSh && _prevSh.getLastRow() >= 2) {
      var _pv = _prevSh.getRange(2, 1, _prevSh.getLastRow() - 1, LB_CUTOVER_HEADER.length).getValues();
      for (var _x = 0; _x < _pv.length; _x++) {
        var _pk = String(_pv[_x][0]) + '|' + String(_pv[_x][3]) + '|' + String(_pv[_x][4]);
        if (_pv[_x][10] !== '' && _pv[_x][10] != null) prevInputs[_pk] = _pv[_x][10];
        if (_pv[_x][11] !== '' && _pv[_x][11] != null) prevStatus[_pk] = _pv[_x][11];
      }
    }
    // 会員側の同名・同(氏名|末尾)衝突を事前集計＝別人へ複製注入するのを防ぐ（電話末尾4桁は衝突しうる）。
    var cids = Object.keys(e.entByCustomer).sort();
    var memNameCount = {}, memKeyCount = {};
    for (var mc = 0; mc < cids.length; mc++) {
      var _nn = _lbNormName(e.meta[cids[mc]].name), _pt = (e.meta[cids[mc]].phone || '').slice(-4);
      memNameCount[_nn] = (memNameCount[_nn] || 0) + 1;
      memKeyCount[_nn + '|' + _pt] = (memKeyCount[_nn + '|' + _pt] || 0) + 1;
    }
    // 厳格突合：残数側・会員側の双方が一意な時だけ注入。曖昧（同名/末尾不一致/重複/会員側衝突）は注入せず記録。
    var ambiguous = [];
    function residFor(name, phoneTail) {
      var nn = _lbNormName(name), cnt = resid.nameCount[nn] || 0;
      if (cnt === 0) return null;
      if (cnt === 1) {
        var only = resid.byName[nn];
        if (only._dupKey) { ambiguous.push(name + '(重複キー)'); return null; }
        if (phoneTail && only.phoneTail) {
          if (phoneTail !== only.phoneTail) { ambiguous.push(name + '(電話末尾不一致)'); return null; }
          if ((memKeyCount[nn + '|' + phoneTail] || 0) > 1) { ambiguous.push(name + '(会員側 同名+末尾 複数)'); return null; }   // 別人へ複製防止
          only.matched = true; return only;
        }
        if ((memNameCount[nn] || 0) > 1) { ambiguous.push(name + '(会員側 同名複数・末尾照合不可)'); return null; }   // 氏名のみ突合は会員が一意な時だけ
        only.matched = true; return only;
      }
      if (phoneTail) {
        var exact = resid.byKey[nn + '|' + phoneTail];
        if (exact && !exact._dupKey) {
          if ((memKeyCount[nn + '|' + phoneTail] || 0) > 1) { ambiguous.push(name + '(会員側 同名+末尾 複数)'); return null; }
          exact.matched = true; return exact;
        }
      }
      ambiguous.push(name + '(同名複数・特定不可)'); return null;   // 残数側 同名複数で末尾特定できない＝注入しない
    }
    var rows = [], filledMonthly = 0, filledTicket = 0, multiPackNames = [], defaultedFull = [];
    for (var c = 0; c < cids.length; c++) {
      var cid = cids[c], ent = e.entByCustomer[cid], mt = e.meta[cid];
      var phoneTail = (mt.phone || '').slice(-4);
      var rf = residFor(mt.name, phoneTail);
      var cover = _lbMonthlyCoverAtCutover(ent.monthlyRows || [], monthKey, e.carryRate);
      if (cover.has && cover.frequency > 0) {
        var cap = _lbResolveCarryCap(cover.frequency, cover.carryCap, cover.carryRate);   // 頻度テーブル＋顧客override（旧: floor×率）
        var mk = cid + '|月額|', kM = '', lM = '';
        if (rf && rf.monthly != null) { kM = rf.monthly; rf.usedMonthly = true; filledMonthly++; }   // リスト値注入時はL(対象外)をクリア
        else { if (prevInputs[mk] != null) kM = prevInputs[mk]; if (prevStatus[mk] != null) lM = prevStatus[mk]; }
        rows.push([cid, mt.name, phoneTail, '月額', '', '', '', '', cover.frequency, cap, kM, lM]);
      }
      var packs = ent.packs || [];
      var singlePack = (packs.length === 1);
      if (packs.length > 1 && rf && rf.ticket != null) multiPackNames.push(mt.name);   // 複数packは1数字で割れない→手動
      for (var p = 0; p < packs.length; p++) {
        var pk = packs[p];
        var exp = (pk.expiresAt != null && pk.expiresAt > -8e15) ? Utilities.formatDate(new Date(pk.expiresAt), tz, 'yyyy/MM/dd') : '';
        var tk = cid + '|チケット|' + pk.packId, kT = '', lT = '';
        if (rf && rf.ticket != null && singlePack) { kT = rf.ticket; rf.usedTicket = true; filledTicket++; }   // 単一packのみリスト値を自動注入・L対象外はクリア
        else if (rf && singlePack) { kT = pk.qty; rf.usedTicket = true; defaultedFull.push(mt.name + '(' + pk.qty + '枚)'); }   // 残数ログに"行あり・残枚数空欄"→契約枚数を残数に（オーナーが空欄にした意図＝前回保持値より優先）
        else { if (prevInputs[tk] != null) kT = prevInputs[tk]; if (prevStatus[tk] != null) lT = prevStatus[tk]; }
        // 契約枚数のdefaultは【単一packのみ】。複数packで空欄なら埋めない→previewのPACK_ROW_MISSINGで停止（消化済み全復活を防ぐ・Codex Critical）。
        if (kT === '' && lT === '' && singlePack) { kT = pk.qty; defaultedFull.push(mt.name + '(' + pk.qty + '枚)'); }
        rows.push([cid, mt.name, phoneTail, 'チケット', pk.packId, exp, pk.qty, (pk.unitPrice == null ? '' : pk.unitPrice), '', '', kT, lT]);
      }
    }
    // リスト検証の集計：不正値／今回シートに未反映（未登録・氏名不一致・提供値が会員側に当てはまらない）
    var badEntries = [], notReflected = [];
    for (var u = 0; u < resid.entries.length; u++) {
      var en = resid.entries[u];
      if (en.bad) badEntries.push(en.name);
      // 0は「注入不要」＝未反映扱いしない。非0の値が当たらなかった時だけ警告（登録待ち/氏名不一致/区分なし）。
      var hasM = (en.monthly != null && en.monthly > 0), hasT = (en.ticket != null && en.ticket > 0);
      if ((hasM || hasT) && (!en.matched || (hasM && !en.usedMonthly) || (hasT && !en.usedTicket))) notReflected.push(en.name);
    }
    var ss = _lbSs();
    // CN/TMP/BAK は上で定義済み。前回失敗からの復旧は prevInputs 読取り前に実施済み（K/L引継ぎ担保・Codex）。
    // 新データを一時シートへ作成（正規が在るので残骸tmpは破棄して良い）。
    var stTmp = ss.getSheetByName(TMP); if (stTmp) ss.deleteSheet(stTmp);
    var sh = ss.insertSheet(TMP);
    sh.getRange(1, 1, 1, LB_CUTOVER_HEADER.length).setValues([LB_CUTOVER_HEADER]).setFontWeight('bold');
    if (rows.length) sh.getRange(2, 1, rows.length, LB_CUTOVER_HEADER.length).setValues(rows);
    sh.setFrozenRows(1);
    sh.getRange(1, 11).setNote('★重要：ここには「点火時点(' + monthKey + '-01 00:00)の実残」を入れる＝未来予約を引く前の値。\n月額＝前月からの繰越回数（使い残し・上限はJ列参照）。\nチケット＝そのpackの残枚数。\n※点火後の残数＝ここの入力 −（同期＝syncExistingReservationsで取り込む未来予約数）。管理画面の"予約差引後"を入れると二重控除になるので注意。');
    // スワップ：旧正規→bak（正規が在る時のみ古いbakを消してから）→ tmp→正規 → 確認後bak削除。setName失敗時はbakを正規へ戻す。
    var oldCanon = ss.getSheetByName(CN);
    if (oldCanon) { var stBak = ss.getSheetByName(BAK); if (stBak) ss.deleteSheet(stBak); oldCanon.setName(BAK); }
    try { sh.setName(CN); }
    catch (swapErr) { if (!ss.getSheetByName(CN)) { var _b = ss.getSheetByName(BAK); if (_b) _b.setName(CN); } throw swapErr; }
    var doneBak = ss.getSheetByName(BAK); if (doneBak && ss.getSheetByName(CN)) ss.deleteSheet(doneBak);
    Logger.log('cutover_inventory を ' + rows.length + '行で生成（' + cids.length + '名・' + monthKey + '基準）。');
    if (resid.exists) {
      Logger.log('★残数リスト「' + LB_RESIDUAL_INPUT_SHEET + '」から自動注入：月額' + filledMonthly + '件／チケット' + filledTicket + '件。');
      if (notReflected.length) Logger.log('⚠️ リストにあるが未反映（未登録/氏名不一致/会員側に該当区分なし）' + notReflected.length + '名：' + notReflected.join('、'));
      if (ambiguous.length) Logger.log('⚠️ 曖昧で注入せず（同名・電話不一致・重複）：' + ambiguous.join('、'));
      if (multiPackNames.length) Logger.log('⚠️ 複数packのため自動注入せず手動入力要：' + multiPackNames.join('、'));
      if (badEntries.length) Logger.log('⚠️ 残数リストに不正値（負/小数/文字）' + badEntries.length + '名：' + badEntries.join('、') + ' ← 修正を');
      if (defaultedFull.length) Logger.log('ℹ️ 残数ログ空欄のため契約マスタのチケット枚数を残数として使用（消化前提なし）' + defaultedFull.length + '件：' + defaultedFull.join('、'));
    } else {
      var _names = _lbSs().getSheets().map(function (s) { return s.getName(); }).join(' / ');
      Logger.log('（残数リスト「' + LB_RESIDUAL_INPUT_SHEET + '」タブが見つかりません＝手入力モード。現在のタブ一覧: ' + _names);
      Logger.log(' → 残数リストを使うには、タブ名を正確に「' + LB_RESIDUAL_INPUT_SHEET + '」にしてください（前後の空白・全角半角に注意））');
    }
    Logger.log('★K列「残入力」＝点火時点の実残（未来予約を引く前）。月額=繰越回数／チケット=残枚数。');
    Logger.log('  順序：①旧受付停止→②syncExistingReservations→③この棚卸し入力→④previewCutoverClose→⑤approveMigrationBalance(hash)。');
    return { ok: true, monthKey: monthKey, members: cids.length, rows: rows.length,
      residualTab: resid.exists, filledMonthly: filledMonthly, filledTicket: filledTicket,
      notReflected: notReflected, ambiguous: ambiguous, multiPack: multiPackNames, badEntries: badEntries };
  } finally { lock.releaseLock(); }
}

// ── GASエディタのRunボタンは引数を渡せない。月を固定した実行用ラッパー（対象月を変えるならここを編集）──
var CUTOVER_MONTH = '2026-09';   // ← 点火月。10/1へ延期時は '2026-10' に変更
function runSetupCutover() { var r = setupCutoverInventorySheet(CUTOVER_MONTH); Logger.log('=== runSetupCutover(' + CUTOVER_MONTH + ') 結果 ===\n' + JSON.stringify(r)); return r; }
function runPreviewCutover() { var r = previewCutoverClose(CUTOVER_MONTH); Logger.log('=== runPreviewCutover(' + CUTOVER_MONTH + ') 結果 ===\n' + JSON.stringify(r)); return r; }
// ローリング一括移行：登録済み全員の残数を確定（setup→preview→承認を内部で一気に実行）。会員登録後にこれを1回叩くだけ。
//   preview に error（CARRY_EXCEEDS_CAP等）がある間は承認せず停止＝不正なまま確定しない。何度でも安全に再実行可。
function runCutoverApprove() {
  var s = setupCutoverInventorySheet(CUTOVER_MONTH);
  if (!s.ok) { Logger.log('❌ setup失敗（上のログの理由を修正して再実行）: ' + JSON.stringify(s)); return s; }
  Logger.log('setup: 会員' + s.members + '名／行' + s.rows + '／自動注入 月額' + s.filledMonthly + '・チケット' + s.filledTicket + (s.notReflected && s.notReflected.length ? '／未反映' + s.notReflected.length + '名(=未登録等・登録後に自動で入る)' : ''));
  var p = previewCutoverClose(CUTOVER_MONTH);
  if (!p.ok) { Logger.log('❌ preview: error ' + p.blockingCount + '件を解消してから再実行（上のログの[error]行を参照）'); return p; }
  try { SpreadsheetApp.flush(); Utilities.sleep(2000); } catch (e) { }   // 承認(migration_balanceの入替)前に小休止＝連続SS操作のタイムアウト緩和
  var a;
  try { a = approveMigrationBalance(CUTOVER_MONTH, '中野', p.inputHash); }
  catch (e2) { Logger.log('⚠️ 承認でSSタイムアウト等: ' + e2.message + ' → もう一度 runCutoverApprove を実行してください（setup/preview/hashは冪等）'); return { ok: false, code: 'EXCEPTION', message: e2.message }; }
  Logger.log('=== runCutoverApprove 結果 ===\n' + JSON.stringify(a));
  if (a.ok) Logger.log('✅ 登録済み ' + a.members + '名の残数(初期残高)を確定しました。以降この会員はLINEで正しい残数で予約できます。');
  return a;
}
// ローリング運用の"1ボタン"：①既存の未来予約を同期(残数から差し引く)→②残数の初期残高を確定。
//   会員を登録した後にこれを1回叩けば、登録済み全員が「残数−既存予約」の正しい状態になる。何度でも安全に再実行可。
function runRollingMigrate() {
  Logger.log('① 既存の未来予約を同期（登録済み会員ぶんをline_reservationsへ取込＝残数から差し引く土台）...');
  var sy;
  try { sy = syncExistingReservations(); Logger.log('  同期結果: ' + JSON.stringify(sy)); }
  catch (err) { Logger.log('  ❌ 同期で例外: ' + err.message + ' → 承認を中止（予約が引かれないまま承認しない）。原因を解消して再実行。'); return { ok: false, code: 'SYNC_EXCEPTION', message: err.message }; }
  if (!sy || sy.success !== true) { Logger.log('  ❌ 同期が未完了（' + (sy && sy.code ? sy.code : 'unknown') + '）→ 承認を中止。既存予約が残数に反映されないまま予約可能になるのを防ぐ。原因(定期イベント等)を解消して再実行。'); return { ok: false, code: 'SYNC_INCOMPLETE', sync: sy }; }
  if ((sy.unlinked || 0) > 0 || (sy.badSur || 0) > 0 || (sy.anomalies || 0) > 0) Logger.log('  ⚠️ 同期の要確認：未紐付け' + (sy.unlinked || 0) + '件／担当姓不明' + (sy.badSur || 0) + '件／異常' + (sy.anomalies || 0) + '件。未登録会員ぶんは正常だが、登録済み会員の予約が未紐付けなら残数から引かれない＝line_unlinkedシートを確認（姓のみタイトルは renameSurname 済みか）。');
  try { SpreadsheetApp.flush(); Utilities.sleep(3000); } catch (e) { }   // 同期直後の連続SS操作でタイムアウトしやすい→flush+小休止で緩和
  Logger.log('② 残数の初期残高を確定...');
  return runCutoverApprove();
}
// 定期予約(繰り返しイベント)を単発の予定に自動変換（同期を通すため）。破壊的なので dryRun=true で必ず先に確認。
//   同期windowと同じ範囲の「予約形式(種別_担当姓_顧客)の繰り返しイベント」の各回を単発予定として作成→元の定期シリーズを削除。
// 点火月(CUTOVER_MONTH)の末尾(月末23:59)を返す。定期の単発化/削除は「その月だけ」に限定＝10月以降は触らない。
function _lbCutoverMonthEnd() {
  var mk = CUTOVER_MONTH, y = parseInt(mk.slice(0, 4), 10), mo = parseInt(mk.slice(5, 7), 10);
  var nm = (mo === 12) ? ((y + 1) + '-01') : (y + '-' + (mo + 1 < 10 ? '0' + (mo + 1) : String(mo + 1)));
  return new Date(_lbFirstOfMonthMsJst(nm) - 1);
}
function convertRecurringBookingsToSingles(dryRun) {
  var tz = SETTINGS.TIMEZONE, now = new Date(), endD = _lbCutoverMonthEnd();   // 点火月の月末まで＝9月内のみ
  var cals = [CALENDAR_IDS.CAPACITY_B1, CALENDAR_IDS.CAPACITY_1F];
  var KINDS = { '通常': 1, 'モニター': 1, 'オンライン': 1, 'チケット': 1, '振替': 1, 'レンタル': 1, '体験': 1, 'カウンセリング': 1, 'ペア': 1, '招待': 1, '単発': 1 };
  function isBookingTitle(t) { var p = String(t == null ? '' : t).replace(/^\[RESERVED\]\s*/, '').replace(/^✅\s*/, '').split('_'); return p.length >= 3 && KINDS[_lbNormTok(p[0])]; }
  // 既存の単発(非recurring)を先に把握＝二重作成を防ぐ（冪等）。キー＝タイトル|開始ms
  var singleKeys = {}, occs = [];
  for (var c0 = 0; c0 < cals.length; c0++) {
    var calS = CalendarApp.getCalendarById(cals[c0]); if (!calS) continue;
    var evS = calS.getEvents(now, endD);
    for (var s0 = 0; s0 < evS.length; s0++) { var e0 = evS[s0]; if (e0.isRecurringEvent() || !isBookingTitle(e0.getTitle())) continue; singleKeys[e0.getTitle() + '|' + e0.getStartTime().getTime()] = 1; }
  }
  for (var c = 0; c < cals.length; c++) {
    var cal = CalendarApp.getCalendarById(cals[c]); if (!cal) continue;
    var evs = cal.getEvents(now, endD);
    for (var e = 0; e < evs.length; e++) {
      var ev = evs[e];
      if (!ev.isRecurringEvent() || !isBookingTitle(ev.getTitle())) continue;
      if (singleKeys[ev.getTitle() + '|' + ev.getStartTime().getTime()]) continue;   // 既に単発あり＝スキップ（冪等）
      occs.push({ calId: cals[c], title: ev.getTitle(), start: ev.getStartTime(), end: ev.getEndTime(), desc: ev.getDescription() || '', loc: ev.getLocation() || '' });
    }
  }
  Logger.log((dryRun ? '【DRYRUN・変更なし】' : '【実行】') + ' 単発を新規作成する対象 ' + occs.length + '件（既存単発と重複する回は除外・' + CUTOVER_MONTH + '月内のみ）');
  occs.forEach(function (o) { Logger.log('  ・' + _lbFmtWhenJaPad(o.start) + '  ' + o.title); });
  if (dryRun) { Logger.log('→ 問題なければ runConvertRecurring() で単発を作成 → その後 runDeleteFutureRecurring() で定期の未来回を削除。'); return { dryRun: true, toCreate: occs.length }; }
  var created = 0;
  for (var i = 0; i < occs.length; i++) { var o = occs[i]; var cal2 = CalendarApp.getCalendarById(o.calId); if (!cal2) continue; cal2.createEvent(o.title, o.start, o.end, { description: o.desc, location: o.loc }); created++; }
  Logger.log('✅ 単発 ' + created + '件を新規作成（既存単発は重複させず）。次に runDeleteFutureRecurring() で定期の未来回を削除してください。');
  return { dryRun: false, created: created };
}
function runConvertRecurringDryRun() { return convertRecurringBookingsToSingles(true); }
function runConvertRecurring() { return convertRecurringBookingsToSingles(false); }

// getEventSeriesById はID書式にうるさい。生ID／日時サフィックス除去／@google.com除去 の各組合せで粘る。
function _lbTryGetSeries(rid) {
  var base = String(rid || '');
  var cands = [base, base.replace(/_\d{8}T\d{6}Z?/, ''), base.replace(/@google\.com$/, ''), base.replace(/_\d{8}T\d{6}Z?/, '').replace(/@google\.com$/, '')];
  for (var i = 0; i < cands.length; i++) { if (!cands[i]) continue; try { var s = CalendarApp.getEventSeriesById(cands[i]); if (s) return s; } catch (x) { } }
  return null;
}
// 予約形式の「定期シリーズだけ」を削除（単発は作成済みなので作らない＝二重化の後始末）。dryRunで対象確認。
function deleteRecurringBookingSeries(dryRun) {
  var tz = SETTINGS.TIMEZONE, now = new Date(), endD = new Date(now.getTime() + SETTINGS.SYNC_DAYS * 86400000);
  var cals = [CALENDAR_IDS.CAPACITY_B1, CALENDAR_IDS.CAPACITY_1F];
  var KINDS = { '通常': 1, 'モニター': 1, 'オンライン': 1, 'チケット': 1, '振替': 1, 'レンタル': 1, '体験': 1, 'カウンセリング': 1, 'ペア': 1, '招待': 1, '単発': 1 };
  function isBookingTitle(t) { var p = String(t == null ? '' : t).replace(/^\[RESERVED\]\s*/, '').replace(/^✅\s*/, '').split('_'); return p.length >= 3 && KINDS[_lbNormTok(p[0])]; }
  var seen = {}, del = 0, fail = [];
  for (var c = 0; c < cals.length; c++) {
    var cal = CalendarApp.getCalendarById(cals[c]); if (!cal) continue;
    var evs = cal.getEvents(now, endD);
    for (var e = 0; e < evs.length; e++) {
      var ev = evs[e];
      if (!ev.isRecurringEvent() || !isBookingTitle(ev.getTitle())) continue;
      var rid = ev.getId(); if (seen[rid]) continue; seen[rid] = ev.getTitle();
      if (dryRun) continue;
      var series = _lbTryGetSeries(rid);
      if (series) { try { series.deleteEventSeries(); del++; } catch (x2) { fail.push(ev.getTitle() + ': ' + x2.message); } }
      else fail.push(ev.getTitle() + ': series取得不可（手動削除要）');
    }
  }
  var names = Object.keys(seen).map(function (k) { return seen[k]; });
  Logger.log((dryRun ? '【DRYRUN】' : '【実行】') + ' 定期シリーズ ' + names.length + '系統: ' + names.join(' / '));
  if (!dryRun) { Logger.log('✅ 削除 ' + del + '系統' + (fail.length ? (' / ⚠️失敗 ' + fail.length + '件（下記を手動削除）:\n  ' + fail.join('\n  ')) : '')); }
  return { dryRun: !!dryRun, series: names.length, deleted: del, failed: fail };
}
function runDeleteRecurringSeries() { return deleteRecurringBookingSeries(false); }

// 【安全版】定期予約の「未来の該当回だけ」を個別に削除（deleteEvent=この予定のみ）。過去には一切触れない（今日以降のwindowのみ走査）。
//   単発は作成済みなので作らない。isRecurringEventの回だけ消す＝作成した単発(非recurring)は残る。dryRunで対象確認。
function deleteFutureRecurringOccurrences(dryRun) {
  var tz = SETTINGS.TIMEZONE, now = new Date(), endD = _lbCutoverMonthEnd();   // 点火月の月末まで＝9月内のみ（10月以降の定期は残す）
  var cals = [CALENDAR_IDS.CAPACITY_B1, CALENDAR_IDS.CAPACITY_1F];
  var KINDS = { '通常': 1, 'モニター': 1, 'オンライン': 1, 'チケット': 1, '振替': 1, 'レンタル': 1, '体験': 1, 'カウンセリング': 1, 'ペア': 1, '招待': 1, '単発': 1 };
  function isBookingTitle(t) { var p = String(t == null ? '' : t).replace(/^\[RESERVED\]\s*/, '').replace(/^✅\s*/, '').split('_'); return p.length >= 3 && KINDS[_lbNormTok(p[0])]; }
  var del = 0, fail = [], list = [];
  for (var c = 0; c < cals.length; c++) {
    var cal = CalendarApp.getCalendarById(cals[c]); if (!cal) continue;
    var evs = cal.getEvents(now, endD);   // ★今日以降のみ＝過去は対象外
    for (var e = 0; e < evs.length; e++) {
      var ev = evs[e];
      if (!ev.isRecurringEvent() || !isBookingTitle(ev.getTitle())) continue;   // 定期の回のみ（作成済み単発は非recurring＝除外）
      list.push(_lbFmtWhenJaPad(ev.getStartTime()) + '  ' + ev.getTitle());
      if (dryRun) continue;
      try { ev.deleteEvent(); del++; } catch (x) { fail.push(ev.getTitle() + ' ' + Utilities.formatDate(ev.getStartTime(), tz, 'MM/dd HH:mm') + ': ' + x.message); }
    }
  }
  Logger.log((dryRun ? '【DRYRUN・変更なし】' : '【実行】') + ' 未来の定期回 ' + list.length + '件（今日以降のみ・過去は対象外）');
  list.forEach(function (d) { Logger.log('  ・' + d); });
  if (!dryRun) Logger.log('✅ 削除 ' + del + '件' + (fail.length ? (' / ⚠️失敗 ' + fail.length + '件:\n  ' + fail.join('\n  ')) : '') + ' → 9月は作成済みの単発だけが残ります。');
  return { dryRun: !!dryRun, occurrences: list.length, deleted: del, failed: fail };
}
function runDeleteFutureRecurringDryRun() { return deleteFutureRecurringOccurrences(true); }
function runDeleteFutureRecurring() { return deleteFutureRecurringOccurrences(false); }

// 予約タイトルの顧客名が「姓のみ(森田様)」の予約を、登録フルネーム(森田広海)に一括改名（同期でマッチさせる為）。
//   安全条件（Codex）：姓が【全verified会員中で一意】＋【担当も一致】の時だけ自動改名。曖昧は改名せずフラグ→手動。dryRunで必ず確認。
function renameSurnameTitlesToFullName(dryRun) {
  var tz = SETTINGS.TIMEZONE, now = new Date(), endD = new Date(now.getTime() + SETTINGS.SYNC_DAYS * 86400000);
  var cals = [CALENDAR_IDS.CAPACITY_B1, CALENDAR_IDS.CAPACITY_1F];
  var KINDS = { '通常': 1, 'モニター': 1, 'オンライン': 1, 'チケット': 1, '振替': 1, 'レンタル': 1, '体験': 1, 'カウンセリング': 1, 'ペア': 1, '招待': 1, '単発': 1 };
  function isBookingTitle(t) { var p = String(t == null ? '' : t).replace(/^\[RESERVED\]\s*/, '').replace(/^✅\s*/, '').split('_'); return p.length >= 3 && KINDS[_lbNormTok(p[0])]; }
  // 照合先＝契約マスタ全員（未登録会員のフルネームも含む）。氏名でユニーク化。担当は_lbTrainerIdByNameでidへ。
  var members = [], _seen = {};   // {norm, name, trainerId}
  var csh = _lbContractSheet();
  if (csh && csh.getLastRow() >= 2) {
    var _lc = csh.getLastColumn(), _cols = _lbContractCols(csh.getRange(1, 1, 1, _lc).getValues()[0]);
    if (_cols.name >= 0) {
      var _cv = csh.getRange(2, 1, csh.getLastRow() - 1, _lc).getValues();
      for (var mi = 0; mi < _cv.length; mi++) {
        var nm = String(_cv[mi][_cols.name] || '').replace(/^\s+|\s+$/g, ''); if (!nm) continue;
        var nn = _lbNormName(nm); if (!nn || _seen[nn]) continue; _seen[nn] = 1;
        var trId = (_cols.trainer >= 0) ? (_lbTrainerIdByName(String(_cv[mi][_cols.trainer] || '')) || '') : '';
        members.push({ norm: nn, name: nm, trainerId: trId });
      }
    }
  }
  var surToId = {}; for (var t = 0; t < CALENDAR_IDS.TRAINERS.length; t++) { var tr = CALENDAR_IDS.TRAINERS[t]; surToId[_lbNormTok(tr.name.split(' ')[0])] = tr.id; }
  var proposed = [], flagged = [], renamed = 0;
  for (var c = 0; c < cals.length; c++) {
    var cal = CalendarApp.getCalendarById(cals[c]); if (!cal) continue;
    var evs = cal.getEvents(now, endD);
    for (var e = 0; e < evs.length; e++) {
      var ev = evs[e], title = ev.getTitle();
      if (!isBookingTitle(title)) continue;
      var body = title.replace(/^\[RESERVED\]\s*/, '').replace(/^✅\s*/, ''), parts = body.split('_');
      if (parts.length < 3) continue;
      var sur = _lbNormTok(parts[1]), cust = parts.slice(2).join('_').replace(/^\s+|\s+$/g, ''), custNorm = _lbNormName(cust);
      if (!custNorm) continue;
      if (members.some(function (m) { return m.norm === custNorm; })) continue;   // 既にフルネーム一致＝skip
      var trId = surToId[sur] || '';
      var cand = members.filter(function (m) { return m.norm.length > custNorm.length && m.norm.indexOf(custNorm) === 0; });   // 姓prefix（全会員中）
      var candTr = cand.filter(function (m) { return trId && m.trainerId === trId; });
      var when = _lbFmtWhenJaPad(ev.getStartTime());
      if (cand.length === 1 && trId && candTr.length === 1) {   // 全会員中で姓一意＋担当一致 のみ自動改名
        var full = candTr[0].name, hadSama = /様\s*$/.test(cust);
        var newCust = full + ((hadSama && !/様\s*$/.test(full)) ? '様' : '');
        var newTitle = parts[0] + '_' + parts[1] + '_' + newCust;
        proposed.push(when + '  「' + title + '」 → 「' + newTitle + '」');
        if (!dryRun) { ev.setTitle(newTitle); renamed++; }
      } else if (cand.length > 0) {
        flagged.push(when + '  「' + title + '」（候補' + cand.length + '名・担当一致' + candTr.length + '名＝要手動）');
      }
    }
  }
  Logger.log((dryRun ? '【DRYRUN・変更なし】' : '【実行】') + ' フルネーム改名 対象' + proposed.length + '件 / 曖昧(手動要)' + flagged.length + '件');
  proposed.forEach(function (p) { Logger.log('  ・' + p); });
  if (flagged.length) { Logger.log('--- 曖昧で自動改名せず（手動で直す）---'); flagged.forEach(function (f) { Logger.log('  ⚠️ ' + f); }); }
  if (!dryRun) Logger.log('✅ ' + renamed + '件を改名。次に runRollingMigrate で同期すれば予約が残数から差し引かれます。');
  return { dryRun: !!dryRun, proposed: proposed.length, flagged: flagged.length, renamed: renamed };
}
function runRenameSurnameDryRun() { return renameSurnameTitlesToFullName(true); }
function runRenameSurname() { return renameSurnameTitlesToFullName(false); }

// 時間トリガーから呼ぶ自動移行。runRollingMigrateを実行し、結果を migrate_status シートに1行記録（黙って止まらない）。
//   ※トリガー登録はGASエディタの「トリガー」画面で autoRollingMigrate を時間主導・30分毎に設定（新スコープ不要）。
var LB_MIGRATE_STATUS_SHEET = 'migrate_status';
function autoRollingMigrate() {
  var r;
  // 同期＋残数確定（新規登録会員の既存カレンダー予約も差し引く／同期失敗なら承認しない・Codex）。
  //   タイムアウト時はEXCEPTION＝次回30分後に自動再試行。同期未完了(定期イベント等)はSYNC_INCOMPLETEで通知。
  try { r = runRollingMigrate(); } catch (e) { r = { ok: false, code: 'EXCEPTION', message: e.message }; }
  try {
    var ss = _lbSs(); var sh = ss.getSheetByName(LB_MIGRATE_STATUS_SHEET) || ss.insertSheet(LB_MIGRATE_STATUS_SHEET);
    if (sh.getLastRow() === 0) { sh.getRange(1, 1, 1, 4).setValues([['実行時刻', '結果', '要約', '詳細']]).setFontWeight('bold'); sh.setFrozenRows(1); }
    var when = Utilities.formatDate(new Date(), SETTINGS.TIMEZONE, 'yyyy/MM/dd HH:mm');
    var okTxt = (r && r.ok) ? '✅OK' : (r && r.code === 'EXCEPTION' ? '↻一時失敗(次回再試行)' : '⚠️停止');
    var summary = (r && r.ok) ? (r.members + '名の残数を確定') : ((r && r.code === 'EXCEPTION') ? '一時的エラー（' + (r.message || '') + '）→次回自動再試行' : '停止: ' + (r && r.code ? r.code : 'error') + '（要修正）');
    sh.insertRowsAfter(1, 1); sh.getRange(2, 1, 1, 4).setValues([[when, okTxt, summary, String(JSON.stringify(r)).slice(0, 500)]]);
  } catch (e2) { Logger.log('migrate_status記録失敗: ' + e2.message); }
  // データ不備(preview error等)のみ通知＝要修正。一時的タイムアウト(EXCEPTION)は次回30分後に自動再試行するので通知しない（誤アラート防止）。
  if (r && !r.ok && r.code !== 'EXCEPTION') throw new Error('自動残数移行が停止: ' + r.code + ' — migrate_statusと preview の[error]行を確認し、契約/残数を修正してください。');
  return r;
}

// 棚卸しシート → inv マップ。空セル=blank（≠0）、数値=input、「対象外」=na を厳守。
function _lbReadCutoverInventory() {
  var ss = _lbSs(); var sh = ss.getSheetByName(LB_CUTOVER_SHEET);
  if (!sh || sh.getLastRow() < 2) return null;
  var v = sh.getRange(2, 1, sh.getLastRow() - 1, LB_CUTOVER_HEADER.length).getValues();
  var inv = {};
  for (var i = 0; i < v.length; i++) {
    var cid = String(v[i][0] || '').replace(/^\s+|\s+$/g, ''); if (!cid) continue;
    var name = String(v[i][1] || ''), kind = String(v[i][3] || ''), pid = String(v[i][4] || '');
    var rawIn = v[i][10], stText = String(v[i][11] || '').replace(/^\s+|\s+$/g, '');
    var status, val = null;
    if (stText === '対象外') status = 'na';
    else if (rawIn === '' || rawIn == null) status = 'blank';
    else if (isFinite(Number(rawIn))) { status = 'input'; val = Number(rawIn); }
    else status = 'blank';
    if (!inv[cid]) inv[cid] = { name: name, monthly: null, packs: {} };
    if (kind === '月額') inv[cid].monthly = { status: status, carry: val };
    else if (kind === 'チケット' && pid) inv[cid].packs[pid] = { status: status, remaining: val };
  }
  return inv;
}

// opening の安定ハッシュ（承認と実行の同一性担保・gate9）。
function _lbCutoverOpeningHash(opening) {
  var cids = Object.keys(opening).sort(), parts = [];
  for (var c = 0; c < cids.length; c++) {
    var op = opening[cids[c]];
    var ck = Object.keys(op.carry || {}).sort().map(function (k) { return k + '=' + op.carry[k]; }).join(',');
    var pk = Object.keys(op.packsUsed || {}).sort().map(function (k) { return k + '=' + op.packsUsed[k]; }).join(',');
    parts.push(cids[c] + '|carry:' + ck + '|packs:' + pk + '|cm:' + op.cutoverMonth);
  }
  return _lbHashStr(parts.join('||'));
}

// dry-run：opening を組み立て、issue/breakdown/inputHash を表示（書込なし）。オーナーはこれで確認してから承認。
function previewCutoverClose(monthKey) {
  monthKey = String(monthKey || '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)) return { ok: false, code: 'BAD_MONTH' };
  var e = _lbCutoverEntByCustomer(monthKey); if (e.err) return { ok: false, code: e.err };
  var inv = _lbReadCutoverInventory(); if (!inv) return { ok: false, code: 'NO_INVENTORY', message: 'cutover_inventory未作成→setupCutoverInventorySheet(' + monthKey + ')を先に' };
  var r = _lbBuildCutoverOpening(inv, e.entByCustomer, monthKey, e.carryRate);
  var hash = _lbCutoverOpeningHash(r.opening);
  Logger.log('=== previewCutoverClose ' + monthKey + ' ===');
  Logger.log('ok=' + r.ok + ' / blocking(error)=' + r.blockingCount + ' / inputHash=' + hash);
  for (var i = 0; i < r.issues.length; i++) Logger.log('  [' + r.issues[i].severity + '] ' + r.issues[i].code + ' : ' + r.issues[i].detail);
  for (var b = 0; b < r.breakdown.length; b++) {
    var bk = r.breakdown[b];
    var mline = bk.monthly ? ('月額 頻度' + bk.monthly.frequency + '/上限' + bk.monthly.cap + '/繰越' + bk.monthly.carry) : '月額なし';
    var pline = bk.packs.map(function (x) { return x.packId + ':残' + x.remaining + '/使用' + x.used + (x.expired ? '(失効)' : ''); }).join(' ');
    var _fut = _lbCountReservations(bk.customerId, 'future');   // #6：同期済みの未来予約＝棚卸し入力からこの分だけ点火後に引かれる（二重控除チェック）
    Logger.log('  ' + bk.customerId + ' ' + bk.name + ' | ' + mline + ' | ' + pline + ' | 未来予約' + _fut + '件(点火後この分が残数から減る)');
  }
  if (r.ok) {
    Logger.log('→ 問題なし。inputHash = ' + hash);
    Logger.log('  ・残数の初期残高を確定： approveMigrationBalance("' + monthKey + '", "承認者名", "' + hash + '")');
    Logger.log('  ・会計を締める（段階5）： runCutoverClose("' + monthKey + '", ' + hash + ')');
    Logger.log('  ※このhashは今の棚卸し内容に対応。棚卸しを変えたら再度previewして新しいhashで承認すること。');
  } else Logger.log('→ error ' + r.blockingCount + '件を解消してから再preview。');
  return { ok: r.ok, monthKey: monthKey, inputHash: hash, blockingCount: r.blockingCount, issues: r.issues };
}

// 承認実行：opening を再構築し inputHash 一致を確認（gate9）→ cutover締め。preview で出た hash を渡す。
function runCutoverClose(monthKey, approvedHash) {
  monthKey = String(monthKey || '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)) return { success: false, code: 'BAD_MONTH' };
  var e = _lbCutoverEntByCustomer(monthKey); if (e.err) return { success: false, code: e.err };
  var inv = _lbReadCutoverInventory(); if (!inv) return { success: false, code: 'NO_INVENTORY' };
  var r = _lbBuildCutoverOpening(inv, e.entByCustomer, monthKey, e.carryRate);
  if (!r.ok) return { success: false, code: 'OPENING_HAS_ERRORS', blockingCount: r.blockingCount, issues: r.issues };
  var hash = _lbCutoverOpeningHash(r.opening);
  if (approvedHash == null || String(approvedHash) !== String(hash)) return { success: false, code: 'HASH_MISMATCH', message: '承認hash(' + approvedHash + ')≠現在(' + hash + ')。棚卸しが変わった→再preview必須', currentHash: hash };
  Logger.log('runCutoverClose: opening検証OK（hash=' + hash + '）→ closeAllocationMonth(' + monthKey + ', cutover)');
  return closeAllocationMonth(monthKey, { cutover: true, opening: r.opening });
}

// GASエディタRunボタン用（引数不可対応）：月は Script Property LB_TARGET_MONTH(YYYY-MM)、hashはpreview時に保存→approvedで実行。
//   runは runCutoverClose 内で opening を再構築しhash再照合するため、preview後に棚卸しが変われば自動でmismatch（安全）。
function previewCutoverCloseTarget() {
  var mk = _lbProp('LB_TARGET_MONTH'); if (!mk) { Logger.log('⛔ Script Property LB_TARGET_MONTH を YYYY-MM で設定してください'); return { ok: false, code: 'NO_TARGET_MONTH' }; }
  var r = previewCutoverClose(mk);
  if (r.ok) { PropertiesService.getScriptProperties().setProperty('LB_CUTOVER_APPROVED', mk + '|' + r.inputHash); Logger.log('→ 内容OKなら runCutoverCloseTarget() で締め実行'); }
  return r;
}
function runCutoverCloseTarget() {
  var mk = _lbProp('LB_TARGET_MONTH'); if (!mk) return { success: false, code: 'NO_TARGET_MONTH' };
  var appr = String(_lbProp('LB_CUTOVER_APPROVED') || '').split('|');
  if (appr[0] !== mk || !appr[1]) return { success: false, code: 'NO_PREVIEW', message: '先に previewCutoverCloseTarget() を実行し内容確認を' };
  return runCutoverClose(mk, appr[1]);
}

// 会員残数の初期残高を確定＝migration_balance へ承認付きで書込む（移行B1）。会計棚卸しツールの opening を再利用。
//   前提：setupCutoverInventorySheet(月) で棚卸しシート生成→残数入力→previewCutoverClose(月) で内容確認済み。
//   これ以降 _lbBuildHome/getBookableRemaining が承認済みopeningを使う（月次遷移・繰越・pack単位で正しく算出）。
//   ★expectedHash 必須（Codex#5）：previewCutoverClose(月) が出す inputHash を渡す＝preview後に棚卸しが変わっていないことを保証。
//     不一致なら承認せず INVENTORY_CHANGED。書込はtemp→swap（旧migration_balanceを残したまま新規に書き、成功後に入替＝失敗時のopening喪失を防ぐ）。
function approveMigrationBalance(monthKey, approver, expectedHash) {
  monthKey = String(monthKey || '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)) return { ok: false, code: 'BAD_MONTH', message: 'monthKeyは YYYY-MM' };
  approver = String(approver || '').trim(); if (!approver) return { ok: false, code: 'NO_APPROVER', message: '承認者名を渡してください' };
  expectedHash = String(expectedHash == null ? '' : expectedHash).trim();
  if (!expectedHash) return { ok: false, code: 'NO_PREVIEW_HASH', message: '先に previewCutoverClose(' + monthKey + ') を実行し、表示された inputHash を第3引数で渡してください（棚卸しの改変を防ぐため）。' };
  var e = _lbCutoverEntByCustomer(monthKey); if (e.err) return { ok: false, code: e.err };
  var inv = _lbReadCutoverInventory(); if (!inv) return { ok: false, code: 'NO_INVENTORY', message: '先に setupCutoverInventorySheet(' + monthKey + ') と残数入力を' };
  var r = _lbBuildCutoverOpening(inv, e.entByCustomer, monthKey, e.carryRate);
  if (!r.ok) return { ok: false, code: 'OPENING_HAS_ERRORS', blockingCount: r.blockingCount, issues: r.issues };
  var hash = _lbCutoverOpeningHash(r.opening);
  if (String(hash) !== expectedHash) return { ok: false, code: 'INVENTORY_CHANGED', message: 'previewCutoverClose以降に棚卸しが変更されています。再度previewして最新のinputHashで承認してください。', currentHash: hash };
  var tz = SETTINGS.TIMEZONE, today = Utilities.formatDate(new Date(), tz, 'yyyy/MM/dd');
  var rows = [], cids = Object.keys(r.opening).sort();
  for (var c = 0; c < cids.length; c++) {
    var cid = cids[c], op = r.opening[cid], carry = (op.carry && op.carry[monthKey] != null) ? op.carry[monthKey] : 0;
    rows.push([cid, monthKey, carry, JSON.stringify(op.packsUsed || {}), today, approver, today, (e.meta[cid] ? e.meta[cid].name : '')]);
  }
  // 承認のwrite+swapをScriptLockで直列化（二重実行の_new競合を防ぐ・Codex#3）。
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok: false, code: 'BUSY', message: '他の処理が実行中です。少し待って再度お試しください。' };
  try {
    var ss = _lbSs(), tmpName = LB_MIGBAL_SHEET + '_new', bakName = LB_MIGBAL_SHEET + '_bak';
    var tOld = ss.getSheetByName(tmpName); if (tOld) ss.deleteSheet(tOld);
    var bOld = ss.getSheetByName(bakName); if (bOld) ss.deleteSheet(bOld);   // 前回失敗の残骸を掃除
    var tmp = ss.insertSheet(tmpName);
    tmp.getRange(1, 1, 1, 8).setValues([['customer_id', 'cutover_month', 'carry', 'packs_json', '基準日', '承認者', '承認日', '氏名']]).setFontWeight('bold');
    tmp.getRange(1, 2, tmp.getMaxRows(), 1).setNumberFormat('@');
    if (rows.length) tmp.getRange(2, 1, rows.length, 8).setValues(rows);
    if (tmp.getLastRow() !== rows.length + 1) { ss.deleteSheet(tmp); return { ok: false, code: 'WRITE_FAILED', message: '書込検証に失敗（旧migration_balanceは保持）。再実行してください。' }; }
    // swap：旧→_bak にrename → _new→正規名 → _bak削除。setName失敗時は _bak→正規名 で復元（正規名が消えない）。
    var old = ss.getSheetByName(LB_MIGBAL_SHEET);
    if (old) old.setName(bakName);
    try { tmp.setName(LB_MIGBAL_SHEET); }
    catch (swapErr) {
      var b = ss.getSheetByName(bakName); if (b) b.setName(LB_MIGBAL_SHEET);   // 旧を正規名へ復元
      try { ss.deleteSheet(tmp); } catch (x) {}
      return { ok: false, code: 'SWAP_FAILED', message: '入替に失敗（旧migration_balanceを復元）。再実行してください。' };
    }
    var b2 = ss.getSheetByName(bakName); if (b2) ss.deleteSheet(b2);   // 新が正規名に付いた後で旧を削除
    Logger.log('approveMigrationBalance: ' + rows.length + '名の初期残高を承認（' + monthKey + '基準・承認者' + approver + '・hash' + hash + '）');
    return { ok: true, monthKey: monthKey, members: rows.length, approver: approver, hash: hash };
  } finally {
    lock.releaseLock();
  }
}

// cutover前に1回実行：line_reservationsの専用session_id列(col12)が空の既存行にUUIDを一括採番。
//   これを実行しないと、旧行/sync行がresIdフォールバックのまま締めキーに使われる（不安定）。冪等（空行のみ採番）。
function backfillSessionIds() {
  var sh = _lbSheet(LINE_BOOKING.RESV_SHEET);
  if (!sh || sh.getLastRow() < 2) return { success: true, filled: 0, message: '対象なし' };
  var last = sh.getLastRow();
  var col = sh.getRange(2, 12, last - 1, 1).getValues();   // col12=session_id
  var filled = 0;
  for (var i = 0; i < col.length; i++) {
    if (String(col[i][0] || '') === '') { sh.getRange(i + 2, 12).setValue('S' + Utilities.getUuid()); filled++; }
  }
  Logger.log('backfillSessionIds: ' + filled + '行に採番');
  return { success: true, filled: filled };
}

// billing/確認用：CLOSED月の割当結果を読む（権威run一意・checksum再検証・fail-loud）。
function getClosedAllocation(monthKey) {
  var sh = _lbAllocSheet();
  var tz = (sh.getParent && sh.getParent().getSpreadsheetTimeZone()) || 'Asia/Tokyo';
  var v = _lbAllocRows(sh), manifests = [];
  for (var i = 0; i < v.length; i++) if (String(v[i][0]) === 'manifest' && _lbMonthKeyCell(v[i][2], tz) === String(monthKey) && String(v[i][3]) === 'CLOSED') manifests.push({ runId: String(v[i][1]), checksum: String(v[i][6]), memberCount: Number(v[i][8] || 0), logicVersion: String(v[i][10] || '') });
  if (manifests.length === 0) return { ok: false, code: 'NOT_CLOSED', message: monthKey + ' は未締め' };
  if (manifests.length > 1) return { ok: false, code: 'AMBIGUOUS_RUN', message: monthKey + ' にCLOSED run複数（要調査）' };
  var man = manifests[0], recs = [], aggParts = [], closings = {};
  if (!LB_ALLOC_ACCEPTED_VERSIONS[man.logicVersion]) return { ok: false, code: 'LOGIC_VERSION_MISMATCH', message: 'manifest ' + man.logicVersion };
  for (var d = 0; d < v.length; d++) if (String(v[d][0]) === 'detail' && String(v[d][1]) === man.runId) {
    var pl; try { pl = JSON.parse(String(v[d][5])); } catch (e) { return { ok: false, code: 'PAYLOAD_CORRUPT', message: String(v[d][4]) }; }
    var _lv = String(v[d][10] || '');
    if (_lv !== man.logicVersion) return { ok: false, code: 'LOGIC_VERSION_MISMATCH', message: String(v[d][4]) + ' ' + _lv + '!=' + man.logicVersion };   // 版混在run＝破損
    if (!_lbCanonicalVersionOk(_lv, pl.record)) return { ok: false, code: 'CANONICAL_VERSION_MISMATCH', message: String(v[d][4]) };   // 版と記録形式の食い違い
    var recheck = _lbSha256Hex(_lbAllocationCanonical(pl.record, pl.closing));
    if (recheck !== String(v[d][6])) return { ok: false, code: 'CHECKSUM_FAIL', message: String(v[d][4]) };
    recs.push(pl.record); closings[String(v[d][4])] = pl.closing || {}; aggParts.push(String(v[d][4]) + ':' + recheck);
  }
  if (recs.length !== man.memberCount) return { ok: false, code: 'COUNT_FAIL', message: '件数不一致' };
  if (_lbSha256Hex(aggParts.sort().join('|')) !== man.checksum) return { ok: false, code: 'AGG_CHECKSUM_FAIL' };
  return { ok: true, monthKey: monthKey, runId: man.runId, records: recs, closings: closings };
}

// ============================================================
// マイ予約一覧 — 会員本人の「未来かつconfirmed」の予約を返す
//   line_reservations 未生成（未予約）でも success:true・空配列を返す（エラーにしない）
// ============================================================
function getMyReservations(lineUserId) {
  var lang = _lbMemberLang(lineUserId);   // 会員の表示言語（dateLabel/statusLabel/トレーナー名を言語化）
  var _rec = getCustomerByLine(lineUserId);
  var _myCid = _rec ? String(_rec.data[MAP_COL.CUSTOMER_ID - 1] || '') : '';   // D列が空でも拾えるようにする
  var enMap = _lbTrainerEnMap();
  var sh = _lbSheet(LINE_BOOKING.RESV_SHEET);
  if (!sh) return { success: true, reservations: [], history: [] };
  var last = sh.getLastRow();
  if (last < 2) return { success: true, reservations: [], history: [] };
  var values = sh.getRange(2, 1, last - 1, Math.max(14, sh.getLastColumn())).getValues();
  var now = new Date().getTime();
  var upcoming = [], history = [];
  for (var i = 0; i < values.length; i++) {
    var r = values[i];
    // ★line_user_id（D列）だけで絞ると、D列が空/古い行が本人に見えない。
    //   二重登録の統合や、本人未登録の時点で同期された予約がこれに該当する
    //   （トレーナー画面は customer_id で引くため「トレーナーには見えて本人に見えない」ズレになる）。
    //   customer_id は会員に一意なので、どちらか一致すれば本人の予約として扱う。
    if (String(r[3]) !== String(lineUserId) && !(_myCid && String(r[2]) === _myCid)) continue;
    var st = String(r[6]);                               // status 列
    var dt = _lbParseResvDate(r[0]);                     // 予約日時 列
    if (!dt) continue;
    var isTransfer = (String(r[9]) === 'transfer');
    var bookType = String(r[13] || '');                  // col14=種別（表示用）。振替はisTransferで判定するのでそちら優先。
    if (st === 'confirmed' && dt.getTime() >= now) {
      // 今後のご予約（変更・キャンセルの対象）
      upcoming.push({
        reservationId: String(r[8]), trainerId: String(r[4]),
        dateLabel: _lbFmtResvLabel(r[0], lang), trainerName: _lbTrainerNameLang(String(r[4]), String(r[5]), lang, enMap), status: st,
        startISO: dt.toISOString(),   // 変更/振替時に自分の旧予定を空き判定から除外するため
        freeCancel: _lbIsFreeCancelWindow(dt), transfer: isTransfer, bookType: bookType, _sort: dt.getTime()
      });
    } else if (st === 'confirmed' && dt.getTime() < now) {
      // 実施済み（過去のconfirmed）＝消化した記録
      history.push({ dateLabel: _lbFmtResvLabel(r[0], lang), trainerName: _lbTrainerNameLang(String(r[4]), String(r[5]), lang, enMap),
        statusLabel: isTransfer ? _lbSt(lang,'st_transfer_done') : _lbSt(lang,'st_done'), _sort: dt.getTime() });
    } else if (st === 'consumed') {
      // 当日キャンセル（消化）＝顧客が忘れないよう記録に残す。振替も「当日キャンセル」と明記（実施済みと誤認させない）。
      history.push({ dateLabel: _lbFmtResvLabel(r[0], lang), trainerName: _lbTrainerNameLang(String(r[4]), String(r[5]), lang, enMap),
        statusLabel: isTransfer ? _lbSt(lang,'st_transfer_sameday') : _lbSt(lang,'st_sameday_used'), _sort: dt.getTime() });
    }
    // cancelled(前日までの無料取消)・changed は消化していないので履歴に出さない
  }
  upcoming.sort(function (a, b) { return a._sort - b._sort; });   // 近い順
  history.sort(function (a, b) { return b._sort - a._sort; });    // 新しい順（最近の記録が上）
  upcoming.forEach(function (o) { delete o._sort; });
  history.forEach(function (o) { delete o._sort; });
  return { success: true, reservations: upcoming, history: history };
}

// ============================================================
// トレーナー管理ページ — 担当の「今後かつconfirmed」の予約一覧
//   顧客名を含む（担当トレーナー本人のみ閲覧可＝getTrainerByLineで認証）。
//   トレーナーはこの一覧から時刻変更・キャンセルを行い、Google直接編集を廃止する（状態乖離の防止）。
// ============================================================
function getTrainerReservations(lineUserId) {
  var tr = getTrainerByLine(lineUserId);
  if (!tr) return { success: false, code: 'FORBIDDEN', message: 'トレーナー権限が必要です。' };
  var isOwner = _lbIsOwnerRole(tr);   // オーナーは全顧客・全予約を閲覧
  var customers = isOwner ? _lbAllVerifiedCustomers() : _lbTrainerCustomers(tr.trainerId);   // 担当顧客＋担当なし（予約の有無に関係なく customer_line_map の trainer_id から）
  var _custIds = {}; customers.forEach(function (c) { _custIds[c.customerId] = true; });   // 担当なし含む顧客の予約も一覧に出すため
  var sh = _lbSheet(LINE_BOOKING.RESV_SHEET);
  if (!sh) return { success: true, trainerName: tr.name, reservations: [], customers: customers };
  var last = sh.getLastRow();
  if (last < 2) return { success: true, trainerName: tr.name, reservations: [], customers: customers };
  var values = sh.getRange(2, 1, last - 1, 11).getValues();
  var now = new Date().getTime();
  var list = [];
  for (var i = 0; i < values.length; i++) {
    var r = values[i];
    if (!isOwner && String(r[4]) !== String(tr.trainerId) && !_custIds[String(r[2])]) continue;   // 予約担当が自分／顧客が担当(担当なし含む)に居る（オーナーは全員）
    if (String(r[6]) !== 'confirmed') continue;                // status 列
    var dt = _lbParseResvDate(r[0]);
    if (!dt || dt.getTime() < now) continue;                   // 今後のみ
    list.push({
      reservationId: String(r[8]), dateLabel: _lbFmtResvLabel(r[0]),
      customerName:  String(r[1]), customerId: String(r[2]),
      // ★この予約の担当（2026-10-03・Codexの最終判定）。
      //   一覧には「自分の担当顧客が、別のトレーナーで取った予約」も出る。
      //   ところが変更・取消は**その予約の担当**しかできない。
      //   画面がボタンを出し分けられるよう、誰の予約かを返す。
      trainerId:     String(r[4] || ''),
      startISO: dt.toISOString(),   // 代行変更時に旧予定を空き判定から除外（問題2）
      freeCancel: _lbIsFreeCancelWindow(dt),
      transfer: (String(r[9]) === 'transfer'), _sort: dt.getTime()
    });
  }
  list.sort(function (a, b) { return a._sort - b._sort; });
  list.forEach(function (o) { delete o._sort; });
  return { success: true, trainerName: tr.name, reservations: list, customers: customers };
}

// 担当トレーナーの顧客（予約の有無に関係なく）＝customer_line_mapのverified×trainer_id一致。代行/管理の顧客選択に使う。
function _lbTrainerCustomers(trainerId) {
  var msh = _lbSheet(LINE_BOOKING.MAP_SHEET), out = [], seen = {};
  if (!msh || msh.getLastRow() < 2) return out;
  var mv = msh.getRange(2, 1, msh.getLastRow() - 1, MAP_COL.NOTE).getValues();
  for (var i = 0; i < mv.length; i++) {
    if (String(mv[i][MAP_COL.AUTH_STATE - 1]) !== 'verified') continue;
    var _tid = String(mv[i][MAP_COL.TRAINER_ID - 1] || '');
    if (_tid !== String(trainerId) && _tid !== '') continue;   // 担当が自分 or 担当なし（空）＝担当なしは全トレーナーの一覧に表示
    var cid = String(mv[i][MAP_COL.CUSTOMER_ID - 1] || ''); if (!cid || seen[cid]) continue;
    seen[cid] = true;
    out.push({ customerId: cid, name: String(mv[i][MAP_COL.NAME - 1] || '') });
  }
  return out;
}

// この顧客を見てよいトレーナーか（2026-10-03）。
//   規則は代行予約の判定（makeReservationLineProxy）とそろえる：
//     オーナー             … 全員を見てよい
//     顧客の担当が未設定   … どのトレーナーが見てもよい（指名ではないため）
//     顧客の担当が自分     … 見てよい
//     顧客の担当が他の人   … **見てはいけない**
//   他のトレーナーの担当顧客を見せない理由は、契約行から報酬割合が読めるため
//   （2026-09-29 オーナー決定）。
//   ★この関数は「map に載っている担当トレーナーID」を受け取る。シートを二度読まない。
function _lbTrainerMaySeeCustomer(tr, ownerTrainerId) {
  if (!tr) return false;
  // ★「判定できない」（顧客が見つからない・シートが読めない）は**誰にも通さない。**
  //   オーナーより先に見る（2026-10-03・Codexの4回目の判定）。
  //   後ろに置くと、オーナーが実在しない顧客IDで体組成を書けてしまい、
  //   誰のものでもない記録が残る。権限の話ではなくデータの整合の話。
  if (ownerTrainerId === null || ownerTrainerId === undefined) return false;
  if (_lbIsOwnerRole(tr)) return true;
  var owner = String(ownerTrainerId);
  if (!owner) return true;                                  // 実在して担当なし＝誰が見てもよい
  return owner === String((tr && tr.trainerId) || '');
}

// トレーナー用：指定顧客の残数(home)を返す。担当トレーナー（と担当なしの顧客）のみ閲覧可。
function getCustomerHomeForTrainer(lineUserId, customerId) {
  var tr = getTrainerByLine(lineUserId);
  if (!tr) return { success: false, code: 'FORBIDDEN', message: 'トレーナー権限が必要です。' };
  customerId = String(customerId || '');
  if (!customerId) return { success: false, code: 'BAD_REQUEST' };
  var name = '', ownerTid = '', msh = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (msh && msh.getLastRow() >= 2) {
    var mv = msh.getRange(2, 1, msh.getLastRow() - 1, MAP_COL.NOTE).getValues();
    for (var i = 0; i < mv.length; i++) {
      if (String(mv[i][MAP_COL.CUSTOMER_ID - 1]) === customerId) {
        name = String(mv[i][MAP_COL.NAME - 1] || '');
        ownerTid = String(mv[i][MAP_COL.TRAINER_ID - 1] || '');   // 担当トレーナー（空＝未設定）
        break;
      }
    }
  }
  if (!name) return { success: false, code: 'NOT_FOUND', message: '顧客が見つかりません。' };
  // ★担当外の顧客の残数を見せない（2026-10-03・Codexの最終判定で見つかった越権）。
  //   それまでは「トレーナーであること」しか見ておらず、顧客IDを知っていれば
  //   他のトレーナーの担当顧客の残数を取得できた。
  //   Worker側（canSeeCustomer）は 2026-09-29 に塞いだが、**GAS側が塞がれていなかった。**
  //   画面はWorkerが答えられないときGASへ落ちるので、両方塞がないと意味がない。
  if (!_lbTrainerMaySeeCustomer(tr, ownerTid)) {
    return { success: false, code: 'FORBIDDEN', message: 'この会員は他のトレーナーの担当です。' };
  }
  return { success: true, name: name, home: _lbBuildHome(customerId, name) };
}

// 未紐付け予約（同期でline_unlinkedに落ちた分）の一覧＋会員候補を返す（トレーナー/管理者用）
function getUnlinkedReservations(lineUserId) {
  var tr = getTrainerByLine(lineUserId);
  if (!tr) return { success: false, code: 'FORBIDDEN', message: 'トレーナー権限が必要です。' };
  var ss = _lbSs();
  var ush = ss.getSheetByName('line_unlinked');
  var list = [];
  if (ush && ush.getLastRow() >= 2) {
    var vals = ush.getRange(2, 1, ush.getLastRow() - 1, 5).getValues();
    for (var i = 0; i < vals.length; i++) {
      if (!vals[i][4]) continue;
      list.push({ dateLabel: String(vals[i][0]), customerName: String(vals[i][1]), trainerName: String(vals[i][2]), kind: String(vals[i][3]), resId: String(vals[i][4]) });
    }
  }
  var members = [];
  var msh = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (msh && msh.getLastRow() >= 2) {
    var mv = msh.getRange(2, 1, msh.getLastRow() - 1, MAP_COL.NOTE).getValues();
    for (var j = 0; j < mv.length; j++) {
      if (String(mv[j][MAP_COL.AUTH_STATE - 1]) === 'verified')
        members.push({ customerId: String(mv[j][MAP_COL.CUSTOMER_ID - 1]), name: String(mv[j][MAP_COL.NAME - 1]) });
    }
  }
  return { success: true, unlinked: list, members: members };
}

// 未紐付け予約を指定会員に紐付け→line_reservationsへ取り込み、line_unlinkedから除去（トレーナー/管理者用）
//   attendeeCount＝ペア種別のときのみ必須（1/2）。カレンダーからは人数が判らないため紐付け時に確定させる。
function linkUnlinkedReservation(lineUserId, resId, customerId, attendeeCount) {
  var tr = getTrainerByLine(lineUserId);
  if (!tr) return { success: false, code: 'FORBIDDEN', message: 'トレーナー権限が必要です。' };
  resId = String(resId || ''); customerId = String(customerId || '');
  if (!resId || !customerId) return { success: false, code: 'BAD_REQUEST', message: '予約と会員を指定してください。' };
  var ss = _lbSs();
  var ush = ss.getSheetByName('line_unlinked');
  if (!ush || ush.getLastRow() < 2) return { success: false, code: 'NOT_FOUND', message: '未紐付けリストがありません。' };
  var vals = ush.getRange(2, 1, ush.getLastRow() - 1, 5).getValues();
  var row = -1, rec = null;
  for (var i = 0; i < vals.length; i++) { if (String(vals[i][4]) === resId) { row = i + 2; rec = vals[i]; break; } }
  if (!rec) return { success: false, code: 'NOT_FOUND', message: '対象の未紐付け予約が見つかりません。' };
  var msh = _lbSheet(LINE_BOOKING.MAP_SHEET);
  var member = null;
  if (msh && msh.getLastRow() >= 2) {
    var mv = msh.getRange(2, 1, msh.getLastRow() - 1, MAP_COL.NOTE).getValues();
    for (var j = 0; j < mv.length; j++) { if (String(mv[j][MAP_COL.CUSTOMER_ID - 1]) === customerId) { member = { lineUserId: String(mv[j][MAP_COL.LINE_USER_ID - 1]), name: String(mv[j][MAP_COL.NAME - 1]) }; break; } }
  }
  if (!member) return { success: false, code: 'NOT_FOUND', message: '会員が見つかりません。' };
  var start = _lbParseResvDate(rec[0]);
  var m = resId.match(/_([^_]+)$/); var tId = m ? m[1] : tr.trainerId;   // resId=G日時_trainerId から担当を復元
  // ★種別(rec[3])・calendar_event_id(rec[4])・来店人数を必ず引き継ぐ。落とすと締めで種別normal/1名に化け、
  //   eventID欠落でbillingの二重計上除外も組めない（Codex指摘）。
  var kind = String(rec[3] || '');
  var att = 1;
  if (kind.indexOf('ペア') >= 0) {
    att = (attendeeCount == null || attendeeCount === '') ? null : Number(attendeeCount);
    if (!(att === 1 || att === 2)) return { success: false, code: 'ATTENDEE_COUNT_REQUIRED', message: 'ペアの予約は来店人数（2名／1名）を指定してください。' };
  }
  var evId = String(rec[4] || '');
  var resvSh = _lbEnsureResvSchema();   // 15列スキーマを保証してから書く
  // 多重取込防止：同じcalendar_event_idが既にconfirmed/consumedで台帳にあれば再紐付けしない（linkの複数回実行で重複行→残数の多重消化を防ぐ）。
  if (evId) {
    var _rl = resvSh.getLastRow();
    if (_rl >= 2) {
      var _rv = resvSh.getRange(2, 1, _rl - 1, 14).getValues();
      for (var _k = 0; _k < _rv.length; _k++) {
        var _st = String(_rv[_k][6]);
        if (String(_rv[_k][12]) === evId && (_st === 'confirmed' || _st === 'consumed')) {
          ush.deleteRow(row);   // 未紐付けリストからは消す（重複表示を止める）＝押しても増えない
          return { success: true, alreadyLinked: true, message: 'この予約は既に紐付け済みです。' };
        }
      }
    }
  }
  resvSh.appendRow([
    Utilities.formatDate(start, SETTINGS.TIMEZONE, 'yyyy/MM/dd HH:mm'), member.name, customerId, member.lineUserId,
    tId, String(rec[2]), 'confirmed', '', resId, 'manual_link', Utilities.formatDate(new Date(), SETTINGS.TIMEZONE, 'yyyy/MM/dd HH:mm'), 'S' + Utilities.getUuid(),
    evId, kind, att
  ]);
  ush.deleteRow(row);
  if (member.lineUserId) { var _ml = _lbMemberLang(member.lineUserId); _lbPush(member.lineUserId, _lbSt(_ml, 'push_booked', { dt: _lbFmtResvLabel(rec[0], _ml) }), 'booking_customer'); }
  return { success: true };
}

// チケット補充：契約フォームに新行（チケット枚数・有効期限=今日＋⌈枚数/2⌉ヶ月）を追加。残数方式=チケット。トレーナー用。
//   単価＝トレーナーが毎回入力（必須）。月額会員のチケット購入にも対応（契約に単価が無くても安全）。空欄放置=会計PRICE_MISSINGを防ぐ。
//   有効期限＝expireISO指定があればそれ、無ければ今日＋⌈枚数/2⌉ヶ月。購入パックごとに独立（既存packの期限は不変）。
//   pair=trueでペアチケット：種別=ペア・qty=人数回(枚数×2)・ペア単価(unitPrice)＋通常単価(normalUnitPrice)。1名来店の差額算定に使う。
// この会員が「レンタル契約」を持つか（期間問わず・種別に'レンタル'）。0円補充フラグのサーバ検証用（Codex越権対策）。
// 読み取りのみ診断：会員が「0円補充可(レンタル契約あり)」と判定されるか、契約マスタの行を並べて可視化。
//   引数は customerId でも 会員名 でもOK（どちらでヒットするか自動判定）。
function testLbRentalCheck(idOrName) {
  try { CacheService.getScriptCache().remove('lb_contract_all'); } catch (e) {}
  var name = '', phone = '', kind = '';
  var q = String(idOrName || '').trim(), qn = _lbNormName(q);
  var msh = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (msh && msh.getLastRow() >= 2) {
    var mv = msh.getRange(2, 1, msh.getLastRow() - 1, MAP_COL.NOTE).getValues();
    for (var i = 0; i < mv.length; i++) {
      if (String(mv[i][MAP_COL.CUSTOMER_ID - 1]) === q || _lbNormName(mv[i][MAP_COL.NAME - 1]) === qn) {
        name = String(mv[i][MAP_COL.NAME - 1] || ''); phone = String(mv[i][MAP_COL.PHONE - 1] || ''); kind = String(mv[i][MAP_COL.CONTRACT_TYPE - 1] || ''); break;
      }
    }
  }
  if (!name) { name = q; Logger.log('※customer_line_mapに未登録。引数を会員名として契約マスタを直接照合します（電話なし）。'); }
  Logger.log('=== レンタル判定チェック ===');
  Logger.log('会員: ' + name + ' / 電話(map): ' + phone + ' / 種別(map): ' + kind);
  var sh = _lbContractSheet();
  if (!sh || sh.getLastRow() < 2) { Logger.log('契約シートが読めません'); return; }
  var lastCol = sh.getLastColumn(), cols = _lbContractCols(sh.getRange(1, 1, 1, lastCol).getValues()[0]);
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, lastCol).getValues();
  var tn = _lbNormName(name), hit = 0;
  Logger.log('--- 契約マスタ内の同名行 ---');
  for (var r = 0; r < vals.length; r++) {
    if (_lbNormName(vals[r][cols.name]) !== tn) continue;
    hit++;
    var ty = String(cols.type >= 0 ? vals[r][cols.type] : ''), ph = String(cols.phone >= 0 ? vals[r][cols.phone] : ''), me = String(cols.method >= 0 ? vals[r][cols.method] : '');
    Logger.log('・種別=「' + ty + '」/ 電話=「' + ph + '」/ 残数方式=「' + me + '」/ レンタル含む=' + (ty.indexOf('レンタル') >= 0));
  }
  if (!hit) Logger.log('（同名の契約行なし＝氏名不一致。契約マスタの「お客様名」と会員名の表記を確認）');
  Logger.log('--- 判定結果 ---');
  Logger.log('_lbAnyContractIsRental = ' + _lbAnyContractIsRental(name, phone) + '（true=0円補充OK / false=PRICE_REQUIRED）');
  Logger.log('=== 完了 ===');
}
function _lbAnyContractIsRental(name, phone) {
  var sh = _lbContractSheet(); if (!sh || sh.getLastRow() < 2) return false;
  var lastCol = sh.getLastColumn(), cols = _lbContractCols(sh.getRange(1, 1, 1, lastCol).getValues()[0]);
  if (cols.name < 0 || cols.type < 0) return false;
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, lastCol).getValues();
  var tn = _lbNormName(name), pn = phone ? _lbNormPhone(phone) : '';
  for (var i = 0; i < vals.length; i++) {
    if (_lbNormName(vals[i][cols.name]) !== tn) continue;
    // 電話で"別人"を除外：契約行の電話が非空かつ会員電話と不一致ならskip（同名別人のレンタル行を誤採用しない・Codex fail-open対策）。
    //   空欄はオフライン/複数契約(月額に電話・レンタル行は電話なし)として氏名一致で許容。
    if (pn && cols.phone >= 0) { var rp = _lbNormPhone(vals[i][cols.phone]); if (rp && rp !== pn) continue; }
    if (String(vals[i][cols.type] || '').indexOf('レンタル') >= 0) return true;
  }
  return false;
}
function addTicketRefill(lineUserId, customerId, tickets, unitPrice, expireISO, pair, normalUnitPrice, rental) {
  Logger.log('[REFILL v3] 受信: customerId=' + customerId + ' unitPrice=' + unitPrice + ' pair=' + pair + ' rental=' + rental + ' tickets=' + tickets);   // 配信バージョン確認用（実行数ログにこの行が出れば最新コードが稼働）
  var tr = getTrainerByLine(lineUserId);
  if (!tr) return { success: false, code: 'FORBIDDEN', message: 'トレーナー権限が必要です。' };
  tickets = Number(tickets);
  if (!_lbIsFiniteNum(tickets) || tickets <= 0 || Math.floor(tickets) !== tickets || tickets > 50) return { success: false, code: 'BAD_REQUEST', message: 'チケット枚数を選んでください（1〜50の整数）。' };   // 非有限/小数/巨大値を弾く（Codex）
  // ★doGet経由のパラメータは全て"文字列"。pair="false"を !! で true 化するとLINEからの非ペア補充が
  //   誤ってペア扱いになり、単価0でPRICE_REQUIRED(ペア単価要求)になる（エディタは真偽値なので再現しない実バグ）。
  var isPair = (pair === true || String(pair) === 'true' || String(pair) === '1');
  unitPrice = Number(unitPrice);
  if (!_lbIsFiniteNum(unitPrice) || unitPrice < 0) return { success: false, code: 'PRICE_REQUIRED', message: (isPair ? 'ペア単価' : 'チケット単価') + 'を入力してください。' };   // 非有限/負は不可（0円可否は種別確定後に判定・Codex）
  if (isPair) {
    if (!(unitPrice > 0)) return { success: false, code: 'PRICE_REQUIRED', message: 'ペア単価を入力してください。' };
    normalUnitPrice = Number(normalUnitPrice);
    if (!_lbIsFiniteNum(normalUnitPrice) || !(normalUnitPrice > 0)) return { success: false, code: 'PRICE_REQUIRED', message: '通常単価（1名来店の差額算定用）を入力してください。' };
    if (!(normalUnitPrice >= unitPrice)) return { success: false, code: 'PRICE_INVALID', message: '通常単価はペア単価（1名あたり）以上で入力してください。' };   // 差額が負＝1名来店が割安になる矛盾
  }
  var name = '', phone = '', custTrainerId = '', custType = '';
  var msh = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (msh && msh.getLastRow() >= 2) {
    var mv = msh.getRange(2, 1, msh.getLastRow() - 1, MAP_COL.NOTE).getValues();
    for (var i = 0; i < mv.length; i++) {
      if (String(mv[i][MAP_COL.CUSTOMER_ID - 1]) === String(customerId)) {
        name = String(mv[i][MAP_COL.NAME - 1]); phone = String(mv[i][MAP_COL.PHONE - 1] || '');
        custTrainerId = String(mv[i][MAP_COL.TRAINER_ID - 1] || ''); custType = String(mv[i][MAP_COL.CONTRACT_TYPE - 1] || '');   // customerId精密（同名回避）＋担当照合
        break;
      }
    }
  }
  if (!name) return { success: false, code: 'NOT_FOUND', message: '会員が見つかりません。' };
  // 権限：この会員の担当トレーナーのみ補充可（担当未設定なら任意トレーナー可）。他担当への水平越権を遮断（Codex#4）。オーナーは全顧客可。
  if (!_lbTrainerMaySeeCustomer(tr, custTrainerId)) return { success: false, code: 'FORBIDDEN', message: 'この会員の担当トレーナーのみチケット補充ができます。' };   // 判定は1か所に寄せる（名簿から読んだ直後＝実在は確認済み）
  var contract = _lbFindContract(name, phone);   // 期限計算等の参照用（電話で同名を絞る・Codex#2）
  // 種別＝customer_line_map の契約種別（customerId精密＝同名で別会員の種別を誤採用しない・Codex#4）。
  //   空欄時は電話で絞った契約から（氏名単独フォールバックはしない・Codex#2）。
  var kind = custType || ((contract && contract.cols.type >= 0) ? String(contract.row[contract.cols.type] || '') : '');
  // ★通常チケットの追加で既存の「ペア」種別を引き継がない（引き継ぐと通常枚数・通常単価欠損のまま
  //   ペアpackとして扱われ、1名来店の締めが PAIR_NORMAL_PRICE_MISSING で止まる・Codex指摘）。
  if (!isPair && kind.indexOf('ペア') >= 0) kind = 'チケット';
  // 0円はレンタル会員のみ許可（レンタル＝売上はcount×2000で別計上・チケット売上0）。通常/チケット/月額は誤0円によるサイレント売上0を防ぐため>0必須。
  //   種別判定＝会員データ(map/契約)由来。判定が外れる場合に備え、トレーナーが「レンタル(0円)」を明示チェックした時(rental=true)も0円を許可（明示宣言＝サイレントでない）。
  //   0円可否は【契約マスタのレンタル種別】でのみ判定（非pairで単価0の時だけ検証）。mapのstale種別やrentalフラグ単独に依存しない（Codex越権対策）。
  if (!isPair && !(unitPrice > 0)) {
    if (!_lbAnyContractIsRental(name, phone)) {
      Logger.log('❌ 0円拒否(PRICE_REQUIRED): name=' + name + ' / phone=' + phone + ' / mapKind=' + kind + ' → 契約マスタに「種別」がレンタルの行が見つからない。testLbRentalCheck(\'' + customerId + '\') で契約行を確認。');
      return { success: false, code: 'PRICE_REQUIRED', message: 'チケット単価を入力してください（0円はレンタル契約の会員のみ）。' };
    }
    unitPrice = 0;   // レンタルは0円で確定（負や空は上で弾き済み）
    if (kind.indexOf('レンタル') < 0) kind = 'レンタル';   // 0円確定＝会計上レンタルに固定（mapがstaleで種別が通常でも正す・Codex）
  }
  var sh = _lbContractSheet();
  if (!sh) return { success: false, code: 'NO_SHEET', message: '契約フォームが見つかりません。' };
  var lastCol = sh.getLastColumn();
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var cols = _lbContractCols(headers);
  // 単価の置き場が無いまま行を作ると、予約は通るのに締めが TICKET_PRICE_MISSING で月全体停止する＝先に止める。
  if (cols.ticketPrice < 0) return { success: false, code: 'SCHEMA_MISSING', message: '契約フォームに単価列（チケット単価 or 単価）がありません。列を追加してから再実行してください。' };
  // ペアは通常単価の置き場（専用列）が無いと会計が組めない＝行を作らずここで止める（黙って単価列へ二重書きしない）。
  if (isPair && cols.normalPrice === -2) return { success: false, code: 'SCHEMA_AMBIGUOUS', message: '契約フォームに「1名来店…単価」列が複数あります。1つに統一してから再実行してください。' };
  if (isPair && cols.normalPrice < 0) return { success: false, code: 'SCHEMA_MISSING', message: '契約フォームに「1名来店時単価（ペアトレ）」列がありません。列を追加してから再実行してください。' };
  if (isPair && cols.normalPrice === cols.ticketPrice) return { success: false, code: 'SCHEMA_MISSING', message: '「1名来店時単価（ペアトレ）」列がチケット単価列と重複しています。列見出しを分けてください。' };
  var today = new Date();
  var expire = null;
  if (expireISO) { expire = _lbParseResvDate(expireISO) || new Date(expireISO); if (isNaN(expire.getTime())) expire = null; }   // トレーナー指定の期限を優先
  if (!expire) { var months = tickets; expire = new Date(today.getFullYear(), today.getMonth() + months, today.getDate()); }   // 既定＝月1回消化ペース＝枚数ヶ月後（8回→8ヶ月）
  var expireStr = Utilities.formatDate(expire, SETTINGS.TIMEZONE, 'yyyy/MM/dd');
  // ★各購入は独立pack（新規行）として発行。既存packの枚数加算・期限延長はしない（Codex：期限延長副作用の除去・移行B）。
  //   期限・単価の異なる複数packが正しく併存し、割当器がFEFO（期限順）で消化する。追加購入＝新pack。
  var rowArr = [];
  for (var k = 0; k < lastCol; k++) rowArr.push('');
  var qty = isPair ? tickets * 2 : tickets;   // ペアは人数回（2名×回数）
  if (cols.name >= 0)   rowArr[cols.name]   = name;
  if (cols.type >= 0)   rowArr[cols.type]   = isPair ? 'ペア' : kind;   // ペアは種別=ペア（予約時のペア判定・計上）
  if (cols.ticket >= 0) rowArr[cols.ticket] = qty;
  if (cols.start >= 0)  rowArr[cols.start]  = Utilities.formatDate(today, SETTINGS.TIMEZONE, 'yyyy/MM/dd');
  if (cols.end >= 0)    rowArr[cols.end]    = expireStr;
  if (cols.method >= 0) rowArr[cols.method] = 'チケット';   // ペアもpack管理（method=チケット）
  if (cols.phone >= 0 && phone) rowArr[cols.phone] = phone;   // 会員の電話を記入（併存の照合安定化）
  if (cols.packId >= 0) rowArr[cols.packId] = 'PK' + Utilities.formatDate(today, SETTINGS.TIMEZONE, 'yyyyMMddHHmmss') + '_' + Utilities.getUuid().slice(0, 4);   // 新pack固有ID（会計join用）
  // 単価＝トレーナー入力（必須・上で検証済み）。月額会員の月額単価を誤って拾わないよう自動フォールバックはしない。
  if (cols.ticketPrice >= 0) rowArr[cols.ticketPrice] = unitPrice;   // 通常＝チケット単価／ペア＝ペア単価
  if (isPair) rowArr[cols.normalPrice] = normalUnitPrice;   // 1名来店の通常単価＝専用列（上でスキーマ検証済み）
  sh.appendRow(rowArr);
  try { CacheService.getScriptCache().remove('lb_contract_all'); } catch (e) {}   // 残数キャッシュ破棄→即反映
  return { success: true, tickets: qty, pair: isPair, total: qty, expire: Utilities.formatDate(expire, SETTINGS.TIMEZONE, 'yyyy年M月d日') };
}

function _lbParseResvDate(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;   // セルが日付型で返る場合
  var m = String(v).match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  var d = new Date(v);                                           // 最後の手段
  return isNaN(d.getTime()) ? null : d;
}

function _lbFmtResvLabel(s, lang) {
  var d = _lbParseResvDate(s);
  if (!d) return String(s);
  var _l = _lbNormLang(lang);
  if (_l === 'en') {
    var mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
    var dowE = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
    return mon + ' ' + d.getDate() + ' (' + dowE + ') ' + Utilities.formatDate(d, SETTINGS.TIMEZONE, 'HH:mm');
  }
  if (_l === 'zh-Hant') {
    var dowT = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'][d.getDay()];
    return Utilities.formatDate(d, SETTINGS.TIMEZONE, 'M月d日') + '(' + dowT + ') ' + Utilities.formatDate(d, SETTINGS.TIMEZONE, 'HH:mm');
  }
  if (_l === 'zh') {
    var dowZ = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
    return Utilities.formatDate(d, SETTINGS.TIMEZONE, 'M月d日') + '(' + dowZ + ') ' + Utilities.formatDate(d, SETTINGS.TIMEZONE, 'HH:mm');
  }
  var dow = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return Utilities.formatDate(d, SETTINGS.TIMEZONE, 'M月d日') + '(' + dow + ') ' +
         Utilities.formatDate(d, SETTINGS.TIMEZONE, 'HH:mm');
}
// 期限など日付のみの短縮ラベル（「M月d日」/「Mon d」）
function _lbFmtDateShort(v, lang) {
  var d = _lbParseResvDate(v);
  if (!d) return String(v || '');
  if (_lbNormLang(lang) === 'en') return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()] + ' ' + d.getDate();
  return Utilities.formatDate(d, SETTINGS.TIMEZONE, 'M月d日');
}
// ===== 通知/ラベルの言語 =====
function _lbNormLang(v) {
  var s = String(v || '').toLowerCase();
  if (s.indexOf('zh') === 0) return /hant|-tw|-hk|-mo|_tw|_hk|_mo|traditional/.test(s) ? 'zh-Hant' : 'zh';
  if (s.indexOf('en') === 0) return 'en';
  return 'ja';
}
// customer_line_map の LANG 列から会員の言語を引く（既定 ja）。lineUserId 優先、無ければ customerId。
function _lbMemberLang(lineUserId, customerId) {
  try {
    var sh = _lbSheet(LINE_BOOKING.MAP_SHEET);
    if (!sh || sh.getLastRow() < 2) return 'ja';
    var vals = sh.getRange(2, 1, sh.getLastRow() - 1, MAP_COL.LANG).getValues();
    for (var i = 0; i < vals.length; i++) {
      var luid = String(vals[i][MAP_COL.LINE_USER_ID - 1] || '');
      var cid = String(vals[i][MAP_COL.CUSTOMER_ID - 1] || '');
      if ((lineUserId && luid === String(lineUserId)) || (!lineUserId && customerId && cid === String(customerId))) {
        return _lbNormLang(vals[i][MAP_COL.LANG - 1]);
      }
    }
  } catch (e) { Logger.log('_lbMemberLang: ' + e.message); }
  return 'ja';
}
// 会員の表示/通知言語を保存（登録済みの行のみ更新。未登録は何もしない＝登録時に確定）。
function setMemberLang(lineUserId, lang) {
  var l = _lbNormLang(lang);
  var sh = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (!sh || sh.getLastRow() < 2) return { success: true, saved: false };
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, _lbMapWidth(sh)).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][MAP_COL.LINE_USER_ID - 1] || '') === String(lineUserId)) {
      sh.getRange(i + 2, MAP_COL.LANG).setValue(l);
      return { success: true, saved: true, lang: l };
    }
  }
  return { success: true, saved: false, lang: l };   // 未登録＝行なし（selfRegisterで確定）
}
// サーバ側の通知/ラベル文言（顧客向けpush・statusLabel）。UI文字列はフロントのI18Nが担当。
var _LB_ST = {
  st_transfer_done:  { ja:'振替・実施済み', en:'Transfer · done', zh:'改期・已完成', 'zh-Hant':'改期・已完成' },
  st_done:           { ja:'実施済み', en:'Done', zh:'已完成', 'zh-Hant':'已完成' },
  st_transfer_sameday:{ ja:'振替セッション（当日キャンセル）', en:'Transfer session (same-day cancel)', zh:'改期课程（当天取消）', 'zh-Hant':'改期課程（當天取消）' },
  st_sameday_used:   { ja:'当日キャンセル（消化）', en:'Same-day cancel (used)', zh:'当天取消（已消耗）', 'zh-Hant':'當天取消（已消耗）' },
  name_suffix:       { ja:' 様', en:'', zh:'', 'zh-Hant':'' },
  // 前日リマインダー（顧客向け）
  rem_title:         { ja:'【明日のご予約】', en:"[Tomorrow's booking]", zh:'【明日的预约】', 'zh-Hant':'【明日的預約】' },
  rem_title_transfer:{ ja:'【明日の振替セッション】', en:"[Tomorrow's transfer session]", zh:'【明日的改期课程】', 'zh-Hant':'【明日的改期課程】' },
  rem_datetime:      { ja:'日時：', en:'Date/Time: ', zh:'时间：', 'zh-Hant':'時間：' },
  rem_trainer:       { ja:'担当：', en:'Trainer: ', zh:'教练：', 'zh-Hant':'教練：' },
  rem_place:         { ja:'場所：', en:'Location: ', zh:'地点：', 'zh-Hant':'地點：' },
  gym_name:          { ja:'TOKOWAKA 吉祥寺', en:'TOKOWAKA Kichijoji', zh:'TOKOWAKA 吉祥寺', 'zh-Hant':'TOKOWAKA 吉祥寺' },
  rem_status:        { ja:'ご利用状況：', en:'Your balance: ', zh:'使用情况：', 'zh-Hant':'使用情況：' },
  rem_arrive:        { ja:'当日は、お時間ちょうどを目安にお越しいただけますとスムーズにご案内できます。', en:'Arriving right on time on the day helps us guide you smoothly.', zh:'当天请尽量准时到店，以便我们顺利为您安排。', 'zh-Hant':'當天請盡量準時蒞臨，以便我們順利為您安排。' },
  rem_footer:        { ja:'お気をつけてお越しください。', en:'We look forward to seeing you.', zh:'请注意安全，期待您的到来。', 'zh-Hant':'請注意安全，期待您的蒞臨。' },
  rem_free_cancel:   { ja:'キャンセルは前日17時まで無料です。', en:'Free cancellation until 17:00 the day before.', zh:'前一天17点前可免费取消。', 'zh-Hant':'前一天17點前可免費取消。' },
  zan_ticket:        { ja:'チケット残り{n}回', en:'{n} tickets left', zh:'剩余次卡{n}次', 'zh-Hant':'剩餘堂數{n}次' },
  zan_ticket_exp:    { ja:'（有効期限 {e}）', en:' (expires {e})', zh:'（有效期 {e}）', 'zh-Hant':'（有效期限 {e}）' },
  zan_monthly:       { ja:'今月{used}回 / 月{q}回{carry}{rem}', en:'{used} used / {q} per month{carry}{rem}', zh:'本月{used}次 / 每月{q}次{carry}{rem}', 'zh-Hant':'本月{used}次 / 每月{q}次{carry}{rem}' },
  zan_carry:         { ja:'＋繰越{c}回', en:' + {c} carried', zh:' + 结转{c}次', 'zh-Hant':' + 結轉{c}次' },
  zan_rem:           { ja:'（残り{r}回）', en:' ({r} left)', zh:'（剩余{r}次）', 'zh-Hant':'（剩餘{r}次）' },
  // 予約確定/変更/キャンセルの顧客通知
  push_booked:       { ja:'ご予約を登録しました。\n日時：{dt}\nLINEの「予約を確認する」からご確認いただけます。', en:'Your booking is confirmed.\nDate/Time: {dt}\nYou can check it from "View my bookings" in LINE.', zh:'您的预约已确认。\n时间：{dt}\n可通过LINE的“查看我的预约”确认。', 'zh-Hant':'您的預約已確認。\n時間：{dt}\n可透過LINE的「查看我的預約」確認。' },
  push_changed:      { ja:'ご予約の時間を変更しました。\n変更前：{old}\n変更後：{new}\n担当：{trainer}', en:'Your booking time was changed.\nBefore: {old}\nAfter: {new}\nTrainer: {trainer}', zh:'您的预约时间已更改。\n更改前：{old}\n更改后：{new}\n教练：{trainer}', 'zh-Hant':'您的預約時間已變更。\n變更前：{old}\n變更後：{new}\n教練：{trainer}' },
  push_change_penalty:{ ja:'\n（当日変更のため1回分の消化となります）', en:'\n(Same-day change: counts as one used session)', zh:'\n（当天更改将消耗一次）', 'zh-Hant':'\n（當天變更將消耗一次）' },
  push_cancelled:    { ja:'ご予約を取り消しました。\n日時：{dt}\n担当：{trainer}', en:'Your booking was cancelled.\nDate/Time: {dt}\nTrainer: {trainer}', zh:'您的预约已取消。\n时间：{dt}\n教练：{trainer}', 'zh-Hant':'您的預約已取消。\n時間：{dt}\n教練：{trainer}' },
  push_cancel_free:  { ja:'\n（前日17時までのため無料です）', en:'\n(Free: before 17:00 the day before)', zh:'\n（前一天17点前免费）', 'zh-Hant':'\n（前一天17點前免費）' },
  push_cancel_penalty:{ ja:'\n（当日取消のため1回分の消化となります）', en:'\n(Same-day cancellation: counts as one used session)', zh:'\n（当天取消将消耗一次）', 'zh-Hant':'\n（當天取消將消耗一次）' }
};
function _lbSt(lang, key, vars) {
  var e = _LB_ST[key]; var s = e ? (e[_lbNormLang(lang)] != null ? e[_lbNormLang(lang)] : e.ja) : key;
  if (typeof s === 'string' && vars) s = s.replace(/\{(\w+)\}/g, function(_, k){ return (vars[k] != null) ? vars[k] : ''; });
  return s;
}
// trainer_master の {trainerId: 英語名} マップ（顧客向け表示の言語差し替え用・空欄は除外）。
function _lbTrainerEnMap() {
  var out = {};
  try {
    var sh = _lbSheet(LINE_BOOKING.TRAINER_SHEET);
    if (!sh || sh.getLastRow() < 2 || sh.getLastColumn() < TR_COL.NAME_EN) return out;
    var vals = sh.getRange(2, 1, sh.getLastRow() - 1, TR_COL.NAME_EN).getValues();
    for (var i = 0; i < vals.length; i++) {
      var tid = String(vals[i][TR_COL.TRAINER_ID - 1] || '');
      var en = String(vals[i][TR_COL.NAME_EN - 1] || '').trim();
      if (tid && en) out[tid] = en;
    }
  } catch (e) { Logger.log('_lbTrainerEnMap: ' + e.message); }
  return out;
}
// 顧客の言語に応じたトレーナー表示名。en かつ英語名があれば英語名、無ければ日本語名。
//   enMap を渡せばシート再読込を避けられる（一覧・ループ用）。
function _lbTrainerNameLang(trainerId, jaName, lang, enMap) {
  if (_lbNormLang(lang) === 'ja') return jaName;   // en/zh は英語名を使う（オーナー方針：トレーナー名は英語でOK）
  var m = enMap || _lbTrainerEnMap();
  return (trainerId && m[String(trainerId)]) ? m[String(trainerId)] : jaName;
}

// 日付のみ整形（Date型セル/文字列 → 「2026年10月26日」/「Oct 26, 2026」）
function _lbFmtDateOnly(v, lang) {
  var d = _lbParseResvDate(v);
  if (!d) return String(v);
  if (_lbNormLang(lang) === 'en') return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
  return Utilities.formatDate(d, SETTINGS.TIMEZONE, 'yyyy年M月d日');
}

// ============================================================
// キャンセル — 本人の confirmed 予約を取消
//   前日17:00まで＝無料／それ以降（当日等）＝1回消化（DESIGN v3・decisions/0031）
// ============================================================
function _lbIsFreeCancelWindow(start) {
  var deadline = new Date(start.getFullYear(), start.getMonth(), start.getDate() - 1, 17, 0, 0);
  return new Date().getTime() < deadline.getTime();
}

// カレンダー（B1・トレーナー）から該当予約の予定を削除（末尾_line＋顧客名で照合）
//   exclude: { eventIds:[...], startMs:n } ＝ 削除してはいけない予定。
//   ★時間変更では「旧枠の削除範囲(開始から60分)」に新枠が重なるのが日常的（同じ日の近い時刻へ
//     ずらす変更が最も多い）。顧客名一致だけで消すと、直前に作った新枠まで巻き込んで消してしまい、
//     「台帳には予約があるのにカレンダーに無い＝枠が二重に売れる」状態を作る（2026-09-15 実害を検出）。
function _lbDeleteReservationEvents(customerName, trainer, start, exclude) {
  var end = new Date(start.getTime() + SETTINGS.SESSION_MINUTES * 60000);
  exclude = exclude || {};
  var exIds = {}; (exclude.eventIds || []).forEach(function (x) { if (x) exIds[String(x)] = true; });
  var exStart = Number(exclude.startMs || 0);
  // isTrainer=true（トレーナーcal）では ✅ が予約本体（`✅ 顧客名様｜セッション_line`）＝削除する。
  //   isTrainer=false（B1）では ✅ 完了マークは触らない（B1の予約は[RESERVED]始まり）。[消化]は両方触らない。
  //   出勤シフトは顧客名を含まないので下の顧客名照合で自然に除外される。
  function delMatch(cal, isTrainer) {
    if (!cal) return;
    cal.getEvents(start, end).forEach(function (ev) {
      var t = ev.getTitle();
      if (t.indexOf('[消化]') === 0) return;                        // 消化済みは触らない（B1/トレーナー共通）
      if (!isTrainer && t.indexOf('✅') === 0) return;              // B1側の✅完了だけスキップ（トレーナーcalの✅予約は削除）
      // 変更で作ったばかりの新枠は守る：IDで一致判定し、IDが取れない環境では開始時刻で判定する。
      var _evId = ''; try { _evId = String(ev.getId()); } catch (eI) { _evId = ''; }
      if (_evId && exIds[_evId]) return;
      if (exStart && ev.getStartTime().getTime() === exStart) return;
      // 5-A修正：_line有無で照合せず顧客名で照合（sync由来の既存予約=_line無しもカレンダー削除）
      if (t.indexOf(customerName) >= 0) {
        try { ev.deleteEvent(); } catch (e) { Logger.log('event削除失敗: ' + e.message); }
      }
    });
  }
  try { delMatch(CalendarApp.getCalendarById(CALENDAR_IDS.CAPACITY_B1), false); } catch (e) { Logger.log('B1削除: ' + e.message); }
  if (trainer && trainer.email) {
    try { delMatch(CalendarApp.getCalendarById(trainer.email), true); } catch (e) { Logger.log('trainer削除: ' + e.message); }
  }
}

// 当日消化：B1予定は先頭を [消化] にリネーム（削除しない＝billing計上・空き枠系からは除外）、
//   トレーナーの実セッション ✅ は削除（実施されないため）。共通ルール「[消化]＝空き枠系で空き・計上系で生存」。
function _lbConsumeReservationEvents(customerName, trainer, start) {
  var end = new Date(start.getTime() + SETTINGS.SESSION_MINUTES * 60000);
  try {
    var calB1 = CalendarApp.getCalendarById(CALENDAR_IDS.CAPACITY_B1);
    if (calB1) calB1.getEvents(start, end).forEach(function (ev) {
      var t = ev.getTitle();
      if (t.indexOf('[消化]') === 0 || t.indexOf('✅') === 0) return;      // 既に消化済み・完了は触らない
      // 5-A修正：_line有無で照合せず顧客名で照合（sync由来もカレンダーを[消化]化）
      if (t.indexOf(customerName) >= 0) {
        try { ev.setTitle(t.replace(/^\[RESERVED\]\s*/, '') .replace(/^/, '[消化] ')); }
        catch (e) { Logger.log('消化リネーム失敗: ' + e.message); }
      }
    });
  } catch (e) { Logger.log('B1消化: ' + e.message); }
  if (trainer && trainer.email) {
    try {
      var tcal = CalendarApp.getCalendarById(trainer.email);
      if (tcal) tcal.getEvents(start, end).forEach(function (ev) {
        var t = ev.getTitle();
        if (t.indexOf('[消化]') === 0) return;   // 消化済みは触らない（✅は予約本体＝トレーナーの実セッションなので削除する）
        if (t.indexOf(customerName) >= 0) {
          try { ev.deleteEvent(); } catch (e) { Logger.log('trainer消化削除失敗: ' + e.message); }
        }
      });
    } catch (e) { Logger.log('trainer消化: ' + e.message); }
  }
}

function cancelReservationLine(lineUserId, reservationId) {
  reservationId = String(reservationId || '').trim();
  if (!reservationId) return { success: false, code: 'BAD_REQUEST', message: '予約IDがありません。' };
  var rec = getCustomerByLine(lineUserId);
  var _actorTrainer = getTrainerByLine(lineUserId);   // トレーナーも操作可（管理ページ）＝会員verified必須の対象外。行単位で担当を再検証する。
  if (!_actorTrainer && (!rec || String(rec.data[MAP_COL.AUTH_STATE - 1]) !== 'verified')) return { success: false, code: 'NOT_VERIFIED', message: '会員登録が必要です。' };

  // ★「表そのものが読めない」と「その予約が見つからない」を分ける（2026-10-04）。
  //   画面は NOT_FOUND を「すでに取り消されている」と受け取って、
  //   その旨を案内する（一覧は写しなので、別の端末が先に取り消すと残って見えるため）。
  //   表が壊れているときに同じコードを返すと、**壊れているのに
  //   「すでに取り消されています」と案内してしまう。**
  var sh = _lbSheet(LINE_BOOKING.RESV_SHEET);
  if (!sh) return { success: false, code: 'NO_SHEET', message: '予約の台帳が読めません。恐れ入りますが担当トレーナーへご連絡ください。' };
  var last = sh.getLastRow();
  if (last < 2) return { success: false, code: 'NOT_FOUND', message: '予約が見つかりません。' };

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var values = sh.getRange(2, 1, last - 1, 11).getValues();
    // H-2：旧形式resIdの重複で別行を掴むのを防ぐ。完全一致が2件以上なら fail-closed。
    var _mc = 0; for (var _m = 0; _m < values.length; _m++) if (String(values[_m][8]) === reservationId) _mc++;
    if (_mc > 1) return { success: false, code: 'AMBIGUOUS_RESERVATION_ID', message: '予約の特定ができません。恐れ入りますが担当トレーナーへご連絡ください。' };
    for (var i = 0; i < values.length; i++) {
      var r = values[i];
      if (String(r[8]) !== reservationId) continue;               // 備考＝resId
      // 本人（顧客）または担当トレーナーのみ操作可（トレーナー管理ページ対応）
      var _actorTr = getTrainerByLine(lineUserId);
      var _isOwner = String(r[3]) === String(lineUserId);
      var _isTrainer = _actorTr && String(r[4]) === String(_actorTr.trainerId);
      if (!_isOwner && !_isTrainer && !_lbIsOwnerRole(_actorTr)) return { success: false, code: 'FORBIDDEN', message: 'この予約は操作できません。' };   // オーナーは全予約を操作可
      if (String(r[6]) !== 'confirmed') return { success: false, code: 'ALREADY', message: 'この予約は既に取消・変更済みです。' };
      var start = _lbParseResvDate(r[0]);
      if (!start) return { success: false, code: 'SERVER_ERROR', message: '予約日時を解釈できません。' };
      if (start.getTime() < new Date().getTime()) return { success: false, code: 'PAST', message: '過ぎた予約は取消できません。' };

      var free = _lbIsFreeCancelWindow(start);
      var customerName = String(r[1]);
      var trainer = _lbTrainerById(String(r[4]));

      // 無料＝両方削除（枠開放・計上なし）／当日消化＝B1を[消化]化（billing計上・空き枠系から除外）・トレーナー✅削除
      if (free) _lbDeleteReservationEvents(customerName, trainer, start);
      else _lbConsumeReservationEvents(customerName, trainer, start);

      var row = i + 2;
      sh.getRange(row, 7).setValue(free ? 'cancelled' : 'consumed');   // 無料=cancelled(残数が戻る)／当日=consumed(消化計上=戻さない)
      sh.getRange(row, 9).setValue(reservationId + (free ? '|無料取消' : '|当日消化取消'));  // 備考に記録
      // #9：当日キャンセル（消化）で振替権を1件付与（6日有効）。振替予約のキャンセルには付与しない（再振替ループ防止）。
      if (!free && String(r[9] || '') !== 'transfer') _lbGrantTransferCredit(String(r[2]), reservationId);
      // （回数券の実消化は残数管理フェーズで payment_flag/請求連携。ここでは記録＋penalty返却のみ）

      var s = _lbFmtResvLabel(r[0]);   // トレーナー通知用（日本語）
      var _cl = _lbMemberLang(String(r[3]));
      _lbPush(String(r[3]), _lbSt(_cl, 'push_cancelled', { dt: _lbFmtResvLabel(r[0], _cl), trainer: (trainer ? _lbTrainerNameLang(trainer.id, trainer.name, _cl) : '') }) +
        _lbSt(_cl, free ? 'push_cancel_free' : 'push_cancel_penalty'), 'cancel_customer');
      if (trainer) {
        var trId = getTrainerLineId(trainer.id);
        if (trId) _lbPush(trId, '【予約キャンセル】' + customerName + '様\n日時：' + s + (free ? '\n（無料取消）' : '\n（当日消化）'), 'cancel_trainer');
      }

      return { success: true, penalty: !free };
    }
    return { success: false, code: 'NOT_FOUND', message: '予約が見つかりません。' };
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// 時間変更 — 同トレーナーの別時刻へ。新枠を先に確保し、成功したら旧を changed に。
//   前日17:00まで＝無料／以降＝1回消化。Lockは _lbReserveCore に委譲（ネスト回避）。
// ============================================================
function changeReservationLine(lineUserId, reservationId, newStartISO) {
  reservationId = String(reservationId || '').trim();
  if (!reservationId || !newStartISO) return { success: false, code: 'BAD_REQUEST', message: '変更に必要な情報が不足しています。' };
  var rec = getCustomerByLine(lineUserId);
  var _actorTrainerC = getTrainerByLine(lineUserId);   // トレーナーも操作可（管理ページ）＝会員verified必須の対象外。行単位で担当を再検証する。
  if (!_actorTrainerC && (!rec || String(rec.data[MAP_COL.AUTH_STATE - 1]) !== 'verified')) return { success: false, code: 'NOT_VERIFIED', message: '会員登録が必要です。' };
  var sh = _lbSheet(LINE_BOOKING.RESV_SHEET);
  if (!sh) return { success: false, code: 'NO_SHEET', message: '予約の台帳が読めません。恐れ入りますが担当トレーナーへご連絡ください。' };   // ★表が壊れているのを「すでに取り消されている」と見せない（2026-10-04）
  var last = sh.getLastRow();
  if (last < 2) return { success: false, code: 'NOT_FOUND', message: '予約が見つかりません。' };

  // 旧予約を検索・事前検証（本人/担当・振替不可・過去不可等）。confirmedの最終判定は後段のLock内で再検証する。
  //   ★col15(attendee_count)まで読む：ペアの来店人数を変更後の新枠へ引き継ぐ（落とすと2名→1名に巻き戻る）。
  var values = sh.getRange(2, 1, last - 1, Math.max(11, sh.getLastColumn())).getValues();
  // H-2：旧形式resIdの重複で別行を掴むのを防ぐ。完全一致が2件以上なら fail-closed。
  var _mc = 0; for (var _m = 0; _m < values.length; _m++) if (String(values[_m][8]) === reservationId) _mc++;
  if (_mc > 1) return { success: false, code: 'AMBIGUOUS_RESERVATION_ID', message: '予約の特定ができません。恐れ入りますが担当トレーナーへご連絡ください。' };
  var row = -1, r = null;
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][8]) === reservationId) { row = i + 2; r = values[i]; break; }
  }
  if (!r) return { success: false, code: 'NOT_FOUND', message: '予約が見つかりません。' };
  // 本人（顧客）または担当トレーナーのみ操作可（トレーナー管理ページ対応）
  var _actorTr = getTrainerByLine(lineUserId);
  var _isOwner = String(r[3]) === String(lineUserId);
  var _isTrainer = _actorTr && String(r[4]) === String(_actorTr.trainerId);
  if (!_isOwner && !_isTrainer && !_lbIsOwnerRole(_actorTr)) return { success: false, code: 'FORBIDDEN', message: 'この予約は操作できません。' };   // オーナーは全予約を操作可
  if (String(r[6]) !== 'confirmed') return { success: false, code: 'ALREADY', message: 'この予約は既に取消・変更済みです。' };
  if (String(r[9]) === 'transfer') return { success: false, code: 'NO_TRANSFER_CHANGE', message: '振替セッションは変更できません。キャンセルのうえ、改めてお申し込みください。' };   // 要望1：振替の振替禁止
  var oldStart = _lbParseResvDate(r[0]);
  if (!oldStart) return { success: false, code: 'SERVER_ERROR', message: '予約日時を解釈できません。' };
  if (oldStart.getTime() < new Date().getTime()) return { success: false, code: 'PAST', message: '過ぎた予約は変更できません。' };

  var free = _lbIsFreeCancelWindow(oldStart);
  // 当日（前日17時以降）の変更は不可 → キャンセル(1消化)＋振替(5,500円)に統一（オーナー運用・二重防御）
  if (!free) return { success: false, code: 'SAME_DAY', message: '当日の変更はできません。キャンセルのうえ振替セッションをお申し込みください。' };
  var customerName = String(r[1]);
  var trainer = _lbTrainerById(String(r[4]));

  // 変更全体を単一Lockで原子化（並行二重変更を防ぐ・C3）。_lbReserveCore は hasLock を見て再取得しない。
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  var made;
  try {
    // Lock内で旧行の現在statusを再検証（TOCTOU：別の変更/キャンセルが先行していれば中止）
    if (String(sh.getRange(row, 7).getValue()) !== 'confirmed') return { success: false, code: 'ALREADY', message: 'この予約は既に取消・変更済みです。' };
    // 旧行を先に changed（＝残数判定から除外＋二重confirmed防止）。以降 core コミット前の失敗は confirmed へ補償。
    sh.getRange(row, 7).setValue('changed');
    try { SpreadsheetApp.flush(); } catch (eF) { sh.getRange(row, 7).setValue('confirmed'); return { success: false, code: 'SERVER_ERROR', message: eF.message }; }
    try {
      made = _lbReserveCore(
        { customerId: String(r[2]), customerName: customerName, lineUserId: String(r[3]), contractType: _lbContractTypeOf(customerName) },
        { trainerId: String(r[4]), startISO: newStartISO, excludeStartISO: oldStart.toISOString(),
          // 変更は「日時だけ」が不変条件。会計属性（来店人数・消化先）は旧行から復元して持ち越す。
          //   packKindを渡さないと月額＋ペア併存会員の「ペア1名」予約が変更で月額/通常packへ変質する。
          attendeeCount: ((r[14] === '' || r[14] == null) ? 1 : Number(r[14])),
          packKind: (String(r[13] || '').indexOf('ペア') >= 0 ? 'pair' : 'normal') },   // 問題2：自分の旧予定を空き判定から除外
        'change'
      );
    } catch (eC) { sh.getRange(row, 7).setValue('confirmed'); return { success: false, code: 'SERVER_ERROR', message: eC.message }; }  // core例外＝新行未コミット→旧復活
    if (!made.success) { sh.getRange(row, 7).setValue('confirmed'); return made; }   // 新行未コミット→旧復活（残数中立）
    // ここで新枠はコミット済み。以降の失敗は旧を changed のまま維持＝残数二重計上なし（旧カレンダー残置は再照合で回収）。
    //   新枠(made)のカレンダー予定を削除対象から除外する。渡さないと「10時→10時半」のような
    //   近接時刻への変更で、作ったばかりの新枠を旧枠の削除が巻き込む。
    try {
      _lbDeleteReservationEvents(customerName, trainer, oldStart,
        { eventIds: [made.calendarEventId, made.trainerEventId], startMs: new Date(newStartISO).getTime() });
    } catch (eD) { Logger.log('旧予定削除失敗（予約変更は確定済み）: ' + eD.message); }
    try { sh.getRange(row, 9).setValue(reservationId + '|→' + made.reservationId + (free ? '|無料変更' : '|当日消化変更')); } catch (eN) {}
  } finally {
    lock.releaseLock();
  }

  var _cl = _lbMemberLang(String(r[3]));
  _lbPush(String(r[3]), _lbSt(_cl, 'push_changed', { old: _lbFmtResvLabel(r[0], _cl), new: _lbFmtResvLabel(new Date(newStartISO), _cl), trainer: (trainer ? _lbTrainerNameLang(trainer.id, trainer.name, _cl) : '') }) +
    (free ? '' : _lbSt(_cl, 'push_change_penalty')), 'change_customer');
  if (trainer) {
    var trId = getTrainerLineId(trainer.id);
    if (trId) _lbPush(trId, '【予約変更】' + customerName + '様\n変更前：' + _lbFmtResvLabel(r[0]) + '\n変更後：' + _lbFmtResvLabel(new Date(newStartISO)), 'change_trainer');
  }

  return { success: true, penalty: !free, newReservationId: made.reservationId };
}

// ============================================================
// テスト用：会員認証番号を発行してログに表示（GASエディタから実行）
//   staging（STAGING_SPREADSHEET_ID設定時）ではテストSSに書かれる。
//   本番の番号発行は issueVerifyCode を管理トークン経由で呼ぶ。
// ============================================================
function testIssueMemberCode() {
  var r = issueVerifyCode({ customerId: 'TEST001', name: 'テスト会員', phone: '09000000000' });
  Logger.log('=== テスト認証番号 ===');
  Logger.log('customerId: ' + r.customerId);
  Logger.log('認証番号: ' + r.code + '  （有効期限: ' + r.expiresAt + '）');
  Logger.log('↑この番号をLIFFの会員登録画面に入力してください（10分有効）');
  return r;
}

// ============================================================
// テスト用：予約確定の各ステップ所要時間を計測（GASエディタから実行）
//   ★実カレンダー(B1・中野)にテスト予約が作られます → 実行後にカレンダーから削除してください。
//   verifyLineIdToken（LINE認証往復）は含みません（_lbReserveCoreの内訳を測る）。
// ============================================================
function testReservePerf() {
  var trainer = CALENDAR_IDS.TRAINERS[0]; // 中野A
  // 3日後の空いていそうな時間（重複したら別時間に変えて再実行）
  var start = new Date();
  start.setDate(start.getDate() + 3);
  start.setHours(10, 0, 0, 0);
  var body = { trainerId: trainer.id, startISO: start.toISOString() };
  var custInfo = { customerId: 'PERF001', customerName: 'perf計測', lineUserId: '' };
  Logger.log('=== 予約確定の所要時間計測 開始 ===');
  var whole = new Date().getTime();
  var r = _lbReserveCore(custInfo, body, 'perf_test');
  Logger.log('[perf] _lbReserveCore 全体: ' + (new Date().getTime() - whole) + 'ms');
  Logger.log('結果: ' + JSON.stringify(r));
  Logger.log('※ カレンダーにできたテスト予約（' + Utilities.formatDate(start, SETTINGS.TIMEZONE, 'M/d HH:mm') + ' 中野）を削除してください');
  return r;
}

// ============================================================
// 固定パターン自動予約（毎月20日=シフト提出リマインド → 25日=翌月解禁＋固定枠を自動予約）
//   シート recurring_patterns：会員が「毎週◯曜◯時・担当◯」を登録 → 毎月25日に翌月分をまとめて自動予約。
//   取れない回（枠埋まり/シフトなし/残数不足）はスキップし、会員へ「別の時間を選んでください」と通知する。
//   1顧客が複数パターン可。冪等＝last_booked_month（翌月キー）で二重予約を防止。
// ============================================================
var LB_RECUR_SHEET = 'recurring_patterns';
var RP_COL = { PATTERN_ID:1, CUSTOMER_ID:2, WEEKDAY:3, TIME:4, TRAINER_ID:5, ACTIVE:6, SOURCE:7, CREATED_AT:8, LAST_MONTH:9, NOTE:10 };

function _lbTruthy(v) { var s = String(v).toLowerCase(); return v === true || s === 'true' || s === '1' || s === '有効' || s === 'yes' || s === 'active'; }
function _lbValidWeekday(w) { var n = Number(w); return _lbIsFiniteNum(n) && n >= 0 && n <= 6 && Math.floor(n) === n; }
function _lbValidTimeHHmm(s) { return /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(s == null ? '' : s)); }

// 同期用：**シートを作らずに**取るだけ（2026-10-03・Codexの4回目の判定）。
//   _lbRecurSheet は無ければ新規作成する。押し出しがこれを使うと、
//   元シートが誤って消えたときに空シートが生まれ、「本当に0件」として
//   D1の固定枠を全部消してしまう。読むだけのときはこちらを使う。
function _lbRecurSheetReadOnly() {
  try { return _lbSs().getSheetByName(LB_RECUR_SHEET) || null; } catch (e) { return null; }
}

function _lbRecurSheet() {
  var ss = _lbSs(); var sh = ss.getSheetByName(LB_RECUR_SHEET);
  if (!sh) {
    sh = ss.insertSheet(LB_RECUR_SHEET);
    sh.getRange(1, 1, 1, 10).setValues([['pattern_id', 'customer_id', 'weekday', 'time', 'trainer_id', 'active', 'source', 'created_at', 'last_booked_month', 'note']]);
  }
  return sh;
}

// 権限判定のために「この顧客の担当は誰か」を引く（2026-10-03・Codexの再判定）。
//   ★_lbCustTrainerId との違い：**顧客が見つからない／シートが読めないときに null を返す。**
//     _lbCustTrainerId は同じ場合も '' を返すため、権限判定に使うと
//     「担当なし＝誰が見てもよい」と解釈され、**実在しない顧客IDを投げれば通る**（fail-open）。
//     権限の判定にはこちらだけを使う。_lbCustTrainerId は通知先を引くなど
//     「担当が分かれば足りる」用途に限る。
//   返り値： trainerId（担当あり） ／ ''（実在して担当なし） ／ null（判定できない）
function _lbCustOwnerOf(customerId) {
  var cid = String(customerId || '');
  if (!cid) return null;
  var sh = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (!sh || sh.getLastRow() < 2) return null;           // 読めない＝判定できない
  var v = sh.getRange(2, 1, sh.getLastRow() - 1, _lbMapWidth(sh)).getValues();
  for (var i = 0; i < v.length; i++) {
    if (String(v[i][MAP_COL.CUSTOMER_ID - 1]) === cid) return String(v[i][MAP_COL.TRAINER_ID - 1] || '');
  }
  return null;                                           // 見つからない＝判定できない
}

// customer_line_map から customerId の担当trainer_idを引く（通知先など）
function _lbCustTrainerId(customerId) {
  if (!customerId) return '';
  var sh = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (!sh || sh.getLastRow() < 2) return '';
  var v = sh.getRange(2, 1, sh.getLastRow() - 1, _lbMapWidth(sh)).getValues();
  for (var i = 0; i < v.length; i++) { if (String(v[i][MAP_COL.CUSTOMER_ID - 1]) === String(customerId)) return String(v[i][MAP_COL.TRAINER_ID - 1] || ''); }
  return '';
}

// customerId から予約コア用の custInfo を組む（verified会員のみ。自動予約で使用）
function _lbCustInfoById(customerId) {
  var sh = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (!sh || sh.getLastRow() < 2) return null;
  var v = sh.getRange(2, 1, sh.getLastRow() - 1, MAP_COL.NOTE).getValues();
  for (var i = 0; i < v.length; i++) {
    if (String(v[i][MAP_COL.CUSTOMER_ID - 1]) !== String(customerId)) continue;
    if (String(v[i][MAP_COL.AUTH_STATE - 1]) !== 'verified') return null;   // 未認証は自動予約しない
    var cstat = String(v[i][MAP_COL.CONTRACT_STAT - 1] || '');
    if (cstat && cstat !== 'active') return null;                            // 退会/失効は自動予約しない
    var nm = String(v[i][MAP_COL.NAME - 1] || '会員');
    // 契約種別＝map優先(customerId精密)。空欄は電話で同名を絞った契約から（氏名単独の誤分類/同名別人を防ぐ・proxyと同方針）。
    var _ct = String(v[i][MAP_COL.CONTRACT_TYPE - 1] || '');
    if (!_ct) { var _c = _lbFindContract(nm, String(v[i][MAP_COL.PHONE - 1] || '')); _ct = (_c && _c.cols.type >= 0) ? String(_c.row[_c.cols.type] || '') : ''; }
    return { customerId: String(customerId), customerName: nm, contractType: _ct,
      lineUserId: String(v[i][MAP_COL.LINE_USER_ID - 1] || '') };
  }
  return null;
}

// 指定年月(1-indexed)の、指定曜日・時刻の全日付を返す（Dateの配列）
function _lbDatesOfWeekdayInMonth(year, month1, weekday, timeHHmm) {
  var p = String(timeHHmm || '0:0').split(':'); var hh = Number(p[0]) || 0, mm = Number(p[1]) || 0;
  var out = [], d = new Date(year, month1 - 1, 1);
  while (d.getMonth() === month1 - 1) {
    if (d.getDay() === weekday) out.push(new Date(year, month1 - 1, d.getDate(), hh, mm, 0));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

// パターンのラベル（「毎週火曜 10:00」/「Every Tue 10:00」/中文）
function _lbRecurLabel(weekday, time, lang) {
  var _l = _lbNormLang(lang);
  if (_l === 'en') return 'Every ' + ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][weekday] + ' ' + time;
  if (_l === 'zh-Hant') return '每週' + ['日', '一', '二', '三', '四', '五', '六'][weekday] + ' ' + time;
  if (_l === 'zh') return '每周' + ['日', '一', '二', '三', '四', '五', '六'][weekday] + ' ' + time;
  return '毎週' + ['日', '月', '火', '水', '木', '金', '土'][weekday] + '曜 ' + time;
}

// 追加の共通処理（バリデーション＋dedup＋append）。source: customer/trainer/owner
function _lbAddRecurPattern(customerId, body, source) {
  if (!customerId) return { success: false, code: 'BAD_REQUEST', message: '対象顧客が不明です。' };
  var _wdRaw = (body.weekday == null) ? '' : String(body.weekday).trim();
  if (_wdRaw === '') return { success: false, code: 'BAD_REQUEST', message: '曜日を選んでください。' };   // 空を Number('')===0（日曜）に化けさせない（Codex#8）
  var weekday = Number(_wdRaw), time = String(body.time == null ? '' : body.time).trim(), trainerId = String(body.trainerId == null ? '' : body.trainerId).trim();
  if (!_lbValidWeekday(weekday)) return { success: false, code: 'BAD_REQUEST', message: '曜日の指定が不正です。' };
  if (!_lbValidTimeHHmm(time)) return { success: false, code: 'BAD_REQUEST', message: '時刻の指定が不正です。' };
  var hh = Number(time.split(':')[0]);
  if (hh < SETTINGS.BUSINESS_START || hh > SETTINGS.BUSINESS_END - 1) return { success: false, code: 'BAD_REQUEST', message: '営業時間内の時刻をお選びください。' };
  var _tr = _lbTrainerById(trainerId);
  // trainerId空＝「担当なし固定枠」＝autoBookRecurringPatternsがシフトインのトレーナーへ均等割当（許可）。
  // hidden(中野=オーナー)は原則固定予約させない（顧客選択除外の迂回防止・Codex#6）。ただし【担当が本人の顧客＝固定客】のみ許可。
  if (trainerId && (!_tr || (_tr.hidden && String(trainerId) !== _lbCustTrainerId(customerId)))) return { success: false, code: 'BAD_REQUEST', message: 'トレーナーの指定が不正です。' };
  if (!_lbCustInfoById(customerId)) return { success: false, code: 'NOT_FOUND', message: '対象の会員が見つかりません。' };
  var sh = _lbRecurSheet();
  var lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    if (sh.getLastRow() >= 2) {   // dedup：同一 customer+weekday+time+trainer の有効行が既にあれば返す
      var v = sh.getRange(2, 1, sh.getLastRow() - 1, 10).getValues();
      for (var i = 0; i < v.length; i++) {
        if (String(v[i][RP_COL.CUSTOMER_ID - 1]) === String(customerId) && Number(v[i][RP_COL.WEEKDAY - 1]) === weekday &&
            String(v[i][RP_COL.TIME - 1]) === time && String(v[i][RP_COL.TRAINER_ID - 1]) === trainerId && _lbTruthy(v[i][RP_COL.ACTIVE - 1])) {
          return { success: true, patternId: String(v[i][RP_COL.PATTERN_ID - 1]), existing: true };
        }
      }
    }
    var pid = 'P-' + Utilities.getUuid();
    sh.appendRow([pid, String(customerId), weekday, time, trainerId, true, source, Utilities.formatDate(new Date(), SETTINGS.TIMEZONE, 'yyyy/MM/dd HH:mm'), '', '']);
    return { success: true, patternId: pid };
  } finally { lock.releaseLock(); }
}

function _lbListRecurFor(customerId, lang) {
  var sh = _lbSheet(LB_RECUR_SHEET); if (!sh || sh.getLastRow() < 2) return [];
  var v = sh.getRange(2, 1, sh.getLastRow() - 1, 10).getValues(), out = [];
  for (var i = 0; i < v.length; i++) {
    if (String(v[i][RP_COL.CUSTOMER_ID - 1]) !== String(customerId)) continue;
    var wd = Number(v[i][RP_COL.WEEKDAY - 1]), tm = String(v[i][RP_COL.TIME - 1]), trId = String(v[i][RP_COL.TRAINER_ID - 1]);
    out.push({ patternId: String(v[i][RP_COL.PATTERN_ID - 1]), weekday: wd, time: tm, trainerId: trId,
      active: _lbTruthy(v[i][RP_COL.ACTIVE - 1]), source: String(v[i][RP_COL.SOURCE - 1]), label: _lbRecurLabel(wd, tm, lang) });
  }
  return out;
}

// パターン行の解決＋管理権限判定（会員本人／担当トレーナー／オーナー）
// ★返り値： {sh,rowIndex,row}（見つかった） ／ null（行が無い） ／ false（表が読めない）
//   表が読めないことと、行が無いことを分ける（2026-10-04・Codex指摘）。
//   画面は「行が無い」を**すでに削除されている**と受け取って案内するので、
//   表が壊れているときに同じ返し方をすると、壊れているのに
//   「すでに削除されています」と案内してしまう。
function _lbRecurRowByPattern(patternId) {
  var sh = _lbSheet(LB_RECUR_SHEET);
  if (!sh) return false;                       // 表そのものが無い／読めない
  if (sh.getLastRow() < 2) return null;        // 表はあるが1件も無い
  var v = sh.getRange(2, 1, sh.getLastRow() - 1, 10).getValues();
  for (var i = 0; i < v.length; i++) { if (String(v[i][RP_COL.PATTERN_ID - 1]) === String(patternId)) return { sh: sh, rowIndex: i + 2, row: v[i] }; }
  return null;
}
// このトレーナー/オーナーが対象顧客の固定枠を操作できるか（担当 or owner）。※固定枠は顧客の自己操作不可（オーナー方針2026-09-03）。
function _lbTrainerCanManageRecur(lineUserId, customerId) {
  var tr = requireTrainer(lineUserId);   // トレーナー/オーナー（active・fail-closed）以外は不可
  if (!tr) return null;
  // ★判定は _lbTrainerMaySeeCustomer に一本化する（2026-10-03・Codexの4回目の判定）。
  //   ここだけ緩い版（_lbCustTrainerId）を使っており、名簿が読めないときに
  //   「担当なし」と解釈されて**担当外の顧客の固定枠を削除できる**状態だった。
  if (!_lbTrainerMaySeeCustomer(tr, _lbCustOwnerOf(customerId))) return null;
  return tr;
}

// ---- トレーナー/オーナー（固定枠の設定・登録・削除はトレーナーアカウント限定）----
function addRecurringPatternByTrainer(lineUserId, customerId, body) {
  var tr = requireTrainer(lineUserId); if (!tr) return { success: false, code: 'FORBIDDEN' };
  // 判定は _lbTrainerMaySeeCustomer に一本化する（同じ規則を2通り書かない）。
  if (!_lbTrainerMaySeeCustomer(tr, _lbCustOwnerOf(customerId))) {
    return { success: false, code: 'FORBIDDEN', message: 'この会員の担当トレーナーのみ登録できます。' };
  }
  return _lbAddRecurPattern(String(customerId), body, _lbIsOwnerRole(tr) ? 'owner' : 'trainer');
}
function listRecurringPatternsByTrainer(lineUserId, customerId) {
  var tr = requireTrainer(lineUserId); if (!tr) return { success: false, code: 'FORBIDDEN' };
  // 判定は _lbTrainerMaySeeCustomer に一本化する（同じ規則を2通り書かない）。
  if (!_lbTrainerMaySeeCustomer(tr, _lbCustOwnerOf(customerId))) return { success: false, code: 'FORBIDDEN' };
  return { success: true, patterns: _lbListRecurFor(String(customerId), 'ja') };
}

// ---- 削除（担当トレーナー／オーナー限定）----
function deleteRecurringPattern(lineUserId, patternId) {
  var hit = _lbRecurRowByPattern(patternId);
  if (hit === false) return { success: false, code: 'NO_SHEET', message: '固定枠の台帳が読めません。恐れ入りますが担当トレーナーへご連絡ください。' };
  if (!hit) return { success: false, code: 'NOT_FOUND', message: 'パターンが見つかりません。' };
  var cid = String(hit.row[RP_COL.CUSTOMER_ID - 1]);
  if (!_lbTrainerCanManageRecur(lineUserId, cid)) return { success: false, code: 'FORBIDDEN' };
  var lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    var re = _lbRecurRowByPattern(patternId);   // Lock内で再解決（行ズレ防止）
    if (re === false) return { success: false, code: 'NO_SHEET' };
    if (!re) return { success: false, code: 'NOT_FOUND' };
    re.sh.deleteRow(re.rowIndex);
  } finally { lock.releaseLock(); }
  return { success: true };
}

// ============================================================
// 毎月25日：翌月分の固定枠を自動予約（時間主導トリガー autoBookRecurringPatterns）
// ============================================================
// 担当なし固定枠の割当：指定日時に「シフトイン（出勤かつ空き）」のトレーナーから、当バッチの割当回数が最小の群を取り、その中からランダムに1人選ぶ（均等＋分散）。
//   hidden(中野=オーナー)は自動割当の対象外。誰もシフトインしていなければ ''（呼出側でスキップ）。
function _lbPickBalancedTrainer(start, assignCount) {
  var end = new Date(start.getTime() + SETTINGS.SESSION_MINUTES * 60000);
  var cands = [];
  for (var i = 0; i < CALENDAR_IDS.TRAINERS.length; i++) {
    var tr = CALENDAR_IDS.TRAINERS[i];
    if (tr.hidden) continue;                                   // オーナー(中野)は自動割当しない
    if (_lbCheckTrainerAvailable(tr, start, end, null)) cands.push(tr.id);   // 出勤シフト内かつ未予約
  }
  if (!cands.length) return '';
  var minC = Infinity;
  for (var j = 0; j < cands.length; j++) { var c = assignCount[cands[j]] || 0; if (c < minC) minC = c; }
  var pool = cands.filter(function (id) { return (assignCount[id] || 0) === minC; });   // 割当回数が最小の群
  return pool[Math.floor(Math.random() * pool.length)];       // 同数はランダムで分散
}

function autoBookRecurringPatterns() {
  var now = new Date();
  var targetY = now.getFullYear() + (now.getMonth() === 11 ? 1 : 0);   // 翌月の年
  var targetM = (now.getMonth() + 1) % 12 + 1;                          // 翌月(1-indexed)
  var targetKey = ('' + targetY) + '-' + ('0' + targetM).slice(-2);     // 冪等キー yyyy-MM
  var sh = _lbRecurSheet();
  if (sh.getLastRow() < 2) { Logger.log('autoBookRecurring: パターンなし'); return { customers: 0 }; }
  var v = sh.getRange(2, 1, sh.getLastRow() - 1, 10).getValues();
  var byCustomer = {}, order = [], assignCount = {};   // assignCount=担当なし固定枠のシフトイン均等割当カウント（当バッチ）
  for (var i = 0; i < v.length; i++) {
    if (!_lbTruthy(v[i][RP_COL.ACTIVE - 1])) continue;
    if (String(v[i][RP_COL.LAST_MONTH - 1]) === targetKey) continue;   // 当該月は予約済み（冪等・再実行安全）
    var cid = String(v[i][RP_COL.CUSTOMER_ID - 1]);
    var weekday = Number(v[i][RP_COL.WEEKDAY - 1]), time = String(v[i][RP_COL.TIME - 1]), trainerId = String(v[i][RP_COL.TRAINER_ID - 1]);
    if (!byCustomer[cid]) { byCustomer[cid] = { booked: [], skipped: [], rows: [] }; order.push(cid); }
    byCustomer[cid].rows.push(i + 2);
    var dates = _lbDatesOfWeekdayInMonth(targetY, targetM, weekday, time);
    for (var d = 0; d < dates.length; d++) {
      var startDate = dates[d];
      if (startDate.getTime() <= now.getTime()) continue;   // 過去・当日以前はスキップ
      var custInfo = _lbCustInfoById(cid);
      if (!custInfo) { byCustomer[cid].skipped.push({ start: startDate, code: 'MEMBER_UNAVAILABLE' }); continue; }
      var useTrainer = trainerId;
      if (!useTrainer) {   // 担当なし固定枠＝その日時にシフトインのトレーナーへ均等ランダムに割当
        useTrainer = _lbPickBalancedTrainer(startDate, assignCount);
        if (!useTrainer) { byCustomer[cid].skipped.push({ start: startDate, code: 'NO_TRAINER_ON_SHIFT' }); continue; }
      }
      custInfo.suppressNotify = true;   // 個別通知を抑制→まとめて1通知
      var r = _lbReserveCore(custInfo, { trainerId: useTrainer, startISO: startDate.toISOString(), attendeeCount: 1, packKind: 'normal' }, 'line');
      if (r && r.success) { byCustomer[cid].booked.push({ start: startDate, trainerId: useTrainer }); if (!trainerId) assignCount[useTrainer] = (assignCount[useTrainer] || 0) + 1; }
      else byCustomer[cid].skipped.push({ start: startDate, code: (r && r.code) || 'ERROR', trainerId: useTrainer });
    }
  }
  for (var k = 0; k < order.length; k++) {
    var c2 = order[k], agg = byCustomer[c2];
    for (var ri = 0; ri < agg.rows.length; ri++) sh.getRange(agg.rows[ri], RP_COL.LAST_MONTH).setValue(targetKey);   // 冪等マーク
    try { _lbNotifyAutoBook(c2, agg.booked, agg.skipped); } catch (e) { Logger.log('自動予約通知失敗(' + c2 + '): ' + e.message); }
  }
  Logger.log('autoBookRecurringPatterns 完了: ' + order.length + '顧客 / 対象月 ' + targetKey);
  return { customers: order.length, month: targetKey };
}

// 自動予約の結果を通知（会員＝本人言語／担当トレーナー＋オーナー＝集計）
function _lbNotifyAutoBook(customerId, booked, skipped) {
  var ci = _lbCustInfoById(customerId);
  var name = ci ? ci.customerName : String(customerId);
  var lineUserId = ci ? ci.lineUserId : '';
  var lang = _lbMemberLang(lineUserId, customerId);
  var _l = _lbNormLang(lang);
  function labels(arr) { return arr.map(function (x) { return '・' + _lbFmtResvLabel(x.start.toISOString(), lang); }); }
  // 会員へ
  if (lineUserId) {
    var head = { ja: '来月分のご予約を自動でお取りしました。', en: 'We have auto-booked your sessions for next month.', zh: '已为您自动预约下月的课程。', 'zh-Hant': '已為您自動預約下月的課程。' }[_l];
    var okH = { ja: '【ご予約】', en: '[Booked]', zh: '【已预约】', 'zh-Hant': '【已預約】' }[_l];
    var ngH = { ja: '【お取りできませんでした】別の時間をお選びください：', en: '[Could not book] Please pick another time:', zh: '【无法预约】请另选时间：', 'zh-Hant': '【無法預約】請另選時間：' }[_l];
    var msg = head;
    if (booked.length) msg += '\n\n' + okH + '\n' + labels(booked).join('\n');
    if (skipped.length) msg += '\n\n' + ngH + '\n' + labels(skipped).join('\n');
    _lbPush(lineUserId, msg, 'autobook_customer');
  }
  // 担当トレーナー＋オーナーへ集計
  var summary = '【自動予約】' + name + '様\n予約' + booked.length + '件 / 取れず' + skipped.length + '件';
  if (skipped.length) summary += '\n未予約：\n' + skipped.map(function (x) { return '・' + _lbFmtResvLabel(x.start.toISOString(), 'ja') + '（' + (x.code || '') + '）'; }).join('\n');
  var notified = {};
  var trId = getTrainerLineId(_lbCustTrainerId(customerId));   // 担当トレーナー
  if (trId) { _lbPush(trId, summary, 'autobook_trainer'); notified[trId] = true; }
  var owners = _lbOwnerLineIds();                              // オーナー/管理者
  for (var i = 0; i < owners.length; i++) { if (owners[i] && !notified[owners[i]]) { _lbPush(owners[i], summary, 'autobook_trainer'); notified[owners[i]] = true; } }
}

// trainer_master から owner/admin ロールの line_user_id を集める（自動予約サマリーの宛先）
function _lbOwnerLineIds() {
  var sh = _lbSheet(LINE_BOOKING.TRAINER_SHEET); if (!sh || sh.getLastRow() < 2) return [];
  var v = sh.getRange(2, 1, sh.getLastRow() - 1, TR_COL.NAME_EN).getValues(), out = [];
  for (var i = 0; i < v.length; i++) {
    var role = String(v[i][TR_COL.ROLE - 1] || '');
    if ((role === 'owner' || role === 'admin') && _lbTruthy(v[i][TR_COL.ACTIVE - 1])) {
      var lid = String(v[i][TR_COL.LINE_USER_ID - 1] || ''); if (lid) out.push(lid);
    }
  }
  return out;
}

// ============================================================
// 毎月20日：全トレーナーへ「翌月シフト提出」リマインド（時間主導トリガー sendShiftReminders）
// ============================================================
function sendShiftReminders() {
  var now = new Date();
  var y = now.getFullYear() + (now.getMonth() === 11 ? 1 : 0);
  var m = (now.getMonth() + 1) % 12 + 1;   // 翌月(1-indexed)
  var sh = _lbSheet(LINE_BOOKING.TRAINER_SHEET); if (!sh || sh.getLastRow() < 2) { Logger.log('sendShiftReminders: trainer_master無し'); return; }
  var v = sh.getRange(2, 1, sh.getLastRow() - 1, TR_COL.NAME_EN).getValues(), sent = 0;
  for (var i = 0; i < v.length; i++) {
    var lid = String(v[i][TR_COL.LINE_USER_ID - 1] || '');
    if (!lid || !_lbTruthy(v[i][TR_COL.ACTIVE - 1])) continue;
    _lbPush(lid, '【シフト提出のお願い】\n' + y + '年' + m + '月のシフトを、今月25日の顧客予約解禁までにご提出ください。\n提出後、25日に固定枠のお客様の翌月予約が自動で入ります。', 'shift_trainer');
    sent++;
  }
  Logger.log('sendShiftReminders: ' + sent + '名へ送信');
  return { sent: sent };
}

// 月次トリガー登録（20日=シフトリマインド / 25日=自動予約）。重複登録防止つき。setupLineTriggers と分離。
function setupRecurringTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var h = t.getHandlerFunction();
    if (h === 'sendShiftReminders' || h === 'autoBookRecurringPatterns') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendShiftReminders').timeBased().onMonthDay(20).atHour(10).inTimezone(SETTINGS.TIMEZONE).create();
  ScriptApp.newTrigger('autoBookRecurringPatterns').timeBased().onMonthDay(25).atHour(6).inTimezone(SETTINGS.TIMEZONE).create();
  Logger.log('✅ 月次トリガー設定：20日10時=シフトリマインド / 25日6時=固定枠の翌月自動予約');
}

// ============================================================
// 一括予約（まとめて予約）：選択した複数日時を【1つのScriptLockで直列予約】。各回 _lbReserveCore が残数/枠を再判定。
//   残数超過・枠埋まりの回はスキップ＋理由。通知は1通に集約。会員本人＋トレーナー代行の両対応。
//   バッチは通常経路固定（1名・normal）。ペア/振替は特殊なので従来どおり個別予約。
// ============================================================
var LB_BATCH_MAX = 12;   // 1回の一括予約で処理する上限（URL長・実行時間の安全弁。残数でも自然に制限）

function _lbParseItems(s) { try { var a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }

function _lbBatchReserve(custInfo, items, channel) {
  if (!items || !items.length) return { success: false, code: 'BAD_REQUEST', message: '予約する日時が選択されていません。' };
  if (items.length > LB_BATCH_MAX) return { success: false, code: 'TOO_MANY', message: '一度に予約できるのは' + LB_BATCH_MAX + '件までです。分けてお試しください。' };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { success: false, code: 'BUSY', message: '混み合っています。少し時間をおいて再度お試しください。' };
  var _ci = {}; for (var kk in custInfo) _ci[kk] = custInfo[kk];
  _ci.suppressNotify = true;   // 個別通知を抑制→まとめて1通知
  var created = [], skipped = [];
  try {
    for (var i = 0; i < items.length; i++) {
      var it = items[i] || {};
      var r = _lbReserveCore(_ci, { trainerId: it.trainerId, startISO: it.startISO, attendeeCount: 1, packKind: 'normal' }, channel);   // 同一Lock共有・通常経路固定
      if (r && r.success) created.push({ startISO: it.startISO, trainerId: it.trainerId, trainerName: r.trainerName });
      else skipped.push({ startISO: it.startISO, trainerId: it.trainerId, code: (r && r.code) || 'ERROR', message: (r && r.message) || '' });
      // 直前の予約行を確定→次の残数判定が確実に見える（残数の二重取り防止）。flush失敗時は「中断」する：
      //   例外を投げると確定済み予約が「リクエスト失敗」に見え利用者が二重申込→過大予約になるため、
      //   ここで打ち切り、それまでのcreated/skippedを正常返却する（残数の整合が保てない状態で次へ進めない・Codex）。
      try { SpreadsheetApp.flush(); } catch (fe) { Logger.log('一括予約 flush失敗→残りを中断: ' + fe.message); break; }
    }
  } finally { lock.releaseLock(); }
  try { _lbNotifyBatch(custInfo, created, skipped); } catch (e) { Logger.log('一括予約通知失敗: ' + e.message); }
  return { success: created.length > 0, created: created, createdCount: created.length, skipped: skipped, skippedCount: skipped.length };
}

// 会員本人（LIFF）
function makeBatchReservationLine(lineUserId, body) {
  var rec = getCustomerByLine(lineUserId);
  if (!rec || String(rec.data[MAP_COL.AUTH_STATE - 1]) !== 'verified') return { success: false, code: 'NOT_VERIFIED', message: '会員登録が必要です。' };
  var cstat = String(rec.data[MAP_COL.CONTRACT_STAT - 1] || '');
  if (cstat && cstat !== 'active') return { success: false, code: 'CONTRACT_INACTIVE', message: '現在ご予約いただけない契約状態です。' };
  var _cn = String(rec.data[MAP_COL.NAME - 1] || '会員');
  return _lbBatchReserve({
    customerId: String(rec.data[MAP_COL.CUSTOMER_ID - 1]), customerName: _cn,
    contractType: _lbContractTypeOf(_cn) || String(rec.data[MAP_COL.CONTRACT_TYPE - 1] || ''), lineUserId: lineUserId
  }, (body && body.items) || [], 'line');
}

// トレーナー代行（担当 or オーナーのみ）
function makeBatchReservationLineProxy(trainer, body) {
  var customerId = String((body && body.customerId) || '').trim();
  if (!customerId) return { success: false, code: 'BAD_REQUEST', message: '対象customerId必須' };
  var sh = _lbSheet(LINE_BOOKING.MAP_SHEET);
  var name = '会員', custLine = '', custTrainerId = '', custType = '', custPhone = '', found = false;
  if (sh && sh.getLastRow() >= 2) {
    var values = sh.getRange(2, 1, sh.getLastRow() - 1, MAP_COL.NOTE).getValues();
    for (var i = 0; i < values.length; i++) {
      if (String(values[i][MAP_COL.CUSTOMER_ID - 1]) === customerId) {
        name = String(values[i][MAP_COL.NAME - 1] || '会員'); custLine = String(values[i][MAP_COL.LINE_USER_ID - 1] || '');
        custTrainerId = String(values[i][MAP_COL.TRAINER_ID - 1] || ''); custType = String(values[i][MAP_COL.CONTRACT_TYPE - 1] || '');
        custPhone = String(values[i][MAP_COL.PHONE - 1] || ''); found = true; break;
      }
    }
  }
  if (!found) return { success: false, code: 'NOT_FOUND', message: '対象の会員が見つかりません。' };
  if (!_lbTrainerMaySeeCustomer(trainer, custTrainerId)) return { success: false, code: 'FORBIDDEN', message: 'この会員の担当トレーナーのみ代行予約ができます。' };   // 判定は1か所に寄せる（名簿から読んだ直後＝実在は確認済み）
  var _ctFb = custType;
  if (!_ctFb) { var _c = _lbFindContract(name, custPhone); _ctFb = (_c && _c.cols.type >= 0) ? String(_c.row[_c.cols.type] || '') : ''; }
  return _lbBatchReserve({ customerId: customerId, customerName: name, lineUserId: custLine, contractType: _ctFb,
    actingTrainer: (trainer && trainer.name) || '', actingTrainerId: (trainer && trainer.trainerId) || '' }, (body && body.items) || [], 'trainer_manual');
}

// 一括予約の結果通知（会員＝本人言語／担当トレーナー＝集計・4言語）
function _lbNotifyBatch(custInfo, created, skipped) {
  var lineUserId = custInfo.lineUserId || '';
  var lang = _lbMemberLang(lineUserId, custInfo.customerId);
  var _l = _lbNormLang(lang);
  function labels(arr) { return arr.map(function (x) { return '・' + _lbFmtResvLabel(x.startISO, lang); }); }
  if (lineUserId) {
    var head = { ja: 'ご予約を承りました。', en: 'Your bookings are confirmed.', zh: '已为您预约。', 'zh-Hant': '已為您預約。' }[_l];
    var okH = { ja: '【ご予約】', en: '[Booked]', zh: '【已预约】', 'zh-Hant': '【已預約】' }[_l];
    var ngH = { ja: '【お取りできませんでした】別の時間をお選びください：', en: '[Could not book] Please pick another time:', zh: '【无法预约】请另选时间：', 'zh-Hant': '【無法預約】請另選時間：' }[_l];
    var msg = head;
    if (created.length) msg += '\n\n' + okH + '\n' + labels(created).join('\n');
    if (skipped.length) msg += '\n\n' + ngH + '\n' + labels(skipped).join('\n');
    _lbPush(lineUserId, msg, 'batch_customer');
  }
  var trId = getTrainerLineId(_lbCustTrainerId(custInfo.customerId));
  if (trId) {
    var s = '【まとめて予約】' + custInfo.customerName + '様\n予約' + created.length + '件 / 取れず' + skipped.length + '件';
    if (created.length) s += '\n' + created.map(function (x) { return '・' + _lbFmtResvLabel(x.startISO, 'ja'); }).join('\n');
    _lbPush(trId, s, 'batch_trainer');
  }
}

// ============================================================
// 予約成否の実測ログ（内部失敗率・枠競合率を数字で把握）。全予約経路の choke point (_lbReserveCore) から記録。
//   軽量方針：1予約＝小さな1行 append（読み取りなし）。カレンダー処理に比べ誤差レベルの負荷。
//   outcome: success / SERVER_ERROR(内部失敗＝孤児が出うる稀ケース) / SLOT_TAKEN(枠競合) / NO_REMAINING(残数切れ) / TOO_SOON / BAD_REQUEST 等
// ============================================================
var LB_METRICS_SHEET = 'booking_metrics';

function _lbMetricsSheet() {
  var ss = _lbSs(); var sh = ss.getSheetByName(LB_METRICS_SHEET);
  if (!sh) { sh = ss.insertSheet(LB_METRICS_SHEET); sh.getRange(1, 1, 1, 4).setValues([['ts', 'date', 'outcome', 'channel']]); }
  return sh;
}
// 通知(push)の失敗を実測ログに記録。予約の成否率を歪めないよう outcome に NOTIFY_FAIL_ 接頭辞を付け、
//   getBookingMetrics 側で予約集計から分離して notifyFail として数える。記録自体の失敗は無視（非致命）。
function _lbLogNotifyFail(reason, purpose) {
  try { _lbLogOutcome('NOTIFY_FAIL_' + String(reason || '?'), String(purpose || 'push')); } catch (e) { Logger.log('通知失敗ログの記録に失敗: ' + e.message); }
}
function _lbLogOutcome(outcome, channel) {
  var tz = SETTINGS.TIMEZONE, now = new Date();
  _lbMetricsSheet().appendRow([Utilities.formatDate(now, tz, 'yyyy/MM/dd HH:mm:ss'), Utilities.formatDate(now, tz, 'yyyy-MM-dd'), String(outcome || ''), String(channel || '')]);
}

// 直近 sinceDays 日の成否を集計（date列=yyyy-MM-dd の辞書比較でフィルタ＝日付parse不要で軽い）。
function getBookingMetrics(sinceDays) {
  var days = (_lbIsFiniteNum(Number(sinceDays)) && Number(sinceDays) > 0) ? Number(sinceDays) : 7;
  var sh = _lbSheet(LB_METRICS_SHEET); if (!sh || sh.getLastRow() < 2) return { total: 0, byOutcome: {}, byChannel: {}, notifyFail: { total: 0, byReason: {}, byPurpose: {} }, days: days };
  var cutoff = Utilities.formatDate(new Date(new Date().getTime() - days * 86400000), SETTINGS.TIMEZONE, 'yyyy-MM-dd');
  var v = sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues();
  var byOutcome = {}, byChannel = {}, total = 0, nfTotal = 0, nfByReason = {}, nfByPurpose = {};
  for (var i = 0; i < v.length; i++) {
    if (String(v[i][1]) < cutoff) continue;   // yyyy-MM-dd の辞書比較＝時系列比較
    var oc = String(v[i][2] || '?'), ch = String(v[i][3] || '?');
    if (oc.indexOf('NOTIFY_FAIL_') === 0) {   // 通知失敗は予約成否と別勘定（成功率を歪めない）
      var rs = oc.slice('NOTIFY_FAIL_'.length) || '?';
      nfByReason[rs] = (nfByReason[rs] || 0) + 1; nfByPurpose[ch] = (nfByPurpose[ch] || 0) + 1; nfTotal++; continue;
    }
    byOutcome[oc] = (byOutcome[oc] || 0) + 1; byChannel[ch] = (byChannel[ch] || 0) + 1; total++;
  }
  return { total: total, byOutcome: byOutcome, byChannel: byChannel, notifyFail: { total: nfTotal, byReason: nfByReason, byPurpose: nfByPurpose }, days: days };
}

// 直近7日の成否レポート（GASエディタから実行、または週次トリガーで）。数字で失敗率を把握。
function weeklyBookingMetrics() {
  var m = getBookingMetrics(7);
  function pct(n) { return m.total ? (Math.round(n / m.total * 1000) / 10) + '%' : '0%'; }
  var succ = m.byOutcome['success'] || 0, internal = m.byOutcome['SERVER_ERROR'] || 0;
  var taken = m.byOutcome['SLOT_TAKEN'] || 0, noRem = m.byOutcome['NO_REMAINING'] || 0;
  Logger.log('=== 予約実測（直近7日）total=' + m.total + ' ===');
  Logger.log('✅ 成功: ' + succ + '（' + pct(succ) + '）');
  Logger.log('⚠️ 内部失敗 SERVER_ERROR: ' + internal + '（' + pct(internal) + '）← 孤児が出うる稀ケース。ここが高ければ要調査');
  Logger.log('🟡 枠競合 SLOT_TAKEN: ' + taken + '（' + pct(taken) + '）← 他の方が先に予約（正常）');
  Logger.log('🟡 残数切れ NO_REMAINING: ' + noRem + '（' + pct(noRem) + '）');
  var others = [];
  for (var k in m.byOutcome) { if (['success', 'SERVER_ERROR', 'SLOT_TAKEN', 'NO_REMAINING'].indexOf(k) < 0) others.push(k + ':' + m.byOutcome[k] + '(' + pct(m.byOutcome[k]) + ')'); }
  if (others.length) Logger.log('その他: ' + others.join(' / '));
  // LINE通知の未達（予約自体は成立している）。0以外なら顧客が予約内容を受け取れていない＝要対処。
  var nf = m.notifyFail || { total: 0, byReason: {} };
  if (nf.total) {
    var reasons = []; for (var rk in nf.byReason) reasons.push(rk + ':' + nf.byReason[rk]);
    Logger.log('🔴 LINE通知の未達: ' + nf.total + '件（' + reasons.join(' / ') + '）← 401=トークン失効/403=ブロック/429=送信上限。予約は成立済み');
  } else {
    Logger.log('✅ LINE通知の未達: 0件');
  }
  return m;
}

// ============================================================
// オーナー(中野=hidden)の固定客向け予約枠を【曜日別】に絞る（B方式・曜日別）。
//   シフト(出勤)は新規対応用に大量に残しつつ、固定客に"見せる"枠だけ曜日ごとに制御。
//   設定：Script Property OWNER_SLOT_WINDOW = 曜日(0=日..6=土)→ルールのマップ。
//     ルール {"from":17,"to":24}＝その時刻帯[from〜to)のみ表示 ／ "all"＝カレンダー通り(制限なし) ／ 曜日キー無し＝非表示。
//   例：{"1":{"from":17,"to":24},"2":{"from":17,"to":24},"4":{"from":17,"to":24},"5":{"from":17,"to":24},"6":"all"}
//       ＝月火木金は17時〜／土は終日／水(3)・日(0)は非表示。
//   未設定(null)＝制限なし（従来どおり全シフトが枠に）。中野以外(非hidden)には一切影響しない。
// ============================================================
function _lbOwnerSlotWindow() {
  try {
    var raw = _lbProp('OWNER_SLOT_WINDOW');
    if (!raw) return null;
    var w = JSON.parse(raw);
    if (!w || typeof w !== 'object') return null;
    return w;   // 曜日(文字列/数値キー) -> {from,to} | 'all'
  } catch (e) { Logger.log('OWNER_SLOT_WINDOW parse失敗→制限なし: ' + e.message); return null; }
}
// 枠の開始 st が表示対象か（純関数・テスト可）。win=null は制限なし＝常にtrue。時刻はJST（GASのDateは script timezone）。
//   その曜日のルール：無し→非表示(false) ／ 'all'/true→制限なし(true) ／ {from,to}→ h∈[from,to)。
function _lbInOwnerWindow(st, win) {
  if (!win) return true;
  var rule = win[String(st.getDay())];
  if (rule === undefined || rule === null) return false;   // その曜日はルール無し＝非表示
  if (rule === 'all' || rule === true) return true;        // カレンダー通り
  var h = st.getHours();
  return h >= Number(rule.from) && h < Number(rule.to);
}
// 設定用。byDay＝{0..6 -> {from,to} | 'all' | null}。null/未指定の曜日は非表示。
function setOwnerSlotWindow(byDay) {
  var clean = {};
  for (var k in byDay) { if (byDay[k] !== null && byDay[k] !== undefined) clean[String(k)] = byDay[k]; }
  PropertiesService.getScriptProperties().setProperty('OWNER_SLOT_WINDOW', JSON.stringify(clean));
  Logger.log('✅ 中野の固定客向け枠(曜日別)を設定：' + JSON.stringify(clean) + '（記載の無い曜日＝非表示）');
}
function clearOwnerSlotWindow() { PropertiesService.getScriptProperties().deleteProperty('OWNER_SLOT_WINDOW'); Logger.log('✅ 中野の曜日フィルタを解除（全シフトが枠に戻る）'); }
// ★GASエディタから使う設定ランナー：下の曜日別ルールを書き換えて実行するだけ。
//   {from:17,to:24}＝その時刻〜 ／ 'all'＝カレンダー通り ／ null＝非表示。
function runSetOwnerSlotWindow() {
  var 設定 = {
    0: null,                 // 日：非表示
    1: { from: 17, to: 24 }, // 月：17時〜
    2: { from: 17, to: 24 }, // 火：17時〜
    3: null,                 // 水：非表示
    4: { from: 17, to: 24 }, // 木：17時〜
    5: { from: 17, to: 24 }, // 金：17時〜
    6: 'all'                 // 土：カレンダー通り（終日）
  };
  setOwnerSlotWindow(設定);
}

// 予約窓/同期の共通"地平"（25日ゲート）：当月末まで／毎月25日以降は翌月末まで。buildAvailableSlots と syncExistingReservations で共用。
function _lbBookingHorizonEnd(now) {
  now = now || new Date();
  var hzMonth = (now.getDate() >= 25) ? now.getMonth() + 1 : now.getMonth();
  return new Date(now.getFullYear(), hzMonth + 1, 0, 23, 59, 59);   // その月の末日23:59
}

// ============================================================
// 診断：移行(autoRollingMigrate)とカレンダー同期(dailySync)のどちらが動いているかを確認する
//   読み取り専用。シート・カレンダー・トリガーを一切変更しない。
//   2026-09-16 追加。Googleからの実行失敗通知（autoRollingMigrate）の原因切り分け用。
// ============================================================
function diagnoseLbSyncHealth() {
  Logger.log('========== トリガー一覧 ==========');
  var triggers = ScriptApp.getProjectTriggers();
  var found = {};
  if (triggers.length === 0) {
    Logger.log('  ⚠️ トリガーが1件も登録されていません');
  }
  triggers.forEach(function (t) {
    var h = t.getHandlerFunction();
    found[h] = (found[h] || 0) + 1;
    Logger.log('  ・' + h + '（' + t.getEventType() + '）');
  });

  Logger.log('');
  Logger.log('========== 判定 ==========');
  if (found['autoRollingMigrate']) {
    Logger.log('  ⚠️ autoRollingMigrate がまだ登録されています（' + found['autoRollingMigrate'] + '件）');
    Logger.log('     → 移行は2026-09-10に廃止済み。これが失敗通知の発生源。トリガー画面から削除してください');
  } else {
    Logger.log('  ✅ autoRollingMigrate は登録されていません（移行は停止済み＝正しい状態）');
  }
  if (found['dailySync']) {
    Logger.log('  ✅ dailySync が登録されています（' + found['dailySync'] + '件）＝カレンダー同期は継続中');
  } else {
    Logger.log('  🔴 dailySync が登録されていません＝カレンダー同期が止まっています');
    Logger.log('     → setupLineTriggers() を実行してください（6時間毎の同期が復活します）');
  }
  ['sendLineReminders', 'syncContractStatus', 'checkLineQuota'].forEach(function (h) {
    Logger.log((found[h] ? '  ✅ ' : '  ⚠️ ') + h + (found[h] ? ' 登録あり' : ' 登録なし'));
  });

  Logger.log('');
  Logger.log('========== sync_status（カレンダー同期の実行履歴・最新5件）==========');
  _lbDumpStatusSheet(LB_SYNC_STATUS_SHEET, 5, 3);

  Logger.log('');
  Logger.log('========== migrate_status（移行の実行履歴・最新5件）==========');
  _lbDumpStatusSheet(LB_MIGRATE_STATUS_SHEET, 5, 4);

  Logger.log('');
  Logger.log('※ sync_status の最新行が6時間以内なら同期は生きています。');
  Logger.log('※ migrate_status が9/10以降で止まっていれば、移行は正しく停止しています。');
}

function _lbDumpStatusSheet(sheetName, rows, cols) {
  try {
    var sh = _lbSs().getSheetByName(sheetName);
    if (!sh) { Logger.log('  （' + sheetName + ' シートが存在しません）'); return; }
    var last = sh.getLastRow();
    if (last < 2) { Logger.log('  （記録がありません）'); return; }
    var n = Math.min(rows, last - 1);
    var v = sh.getRange(2, 1, n, cols).getValues();
    for (var i = 0; i < v.length; i++) {
      var when = v[i][0];
      var whenTxt = (when instanceof Date)
        ? Utilities.formatDate(when, SETTINGS.TIMEZONE, 'yyyy/MM/dd HH:mm')
        : String(when);
      Logger.log('  ' + whenTxt + ' | ' + v[i][1] + ' | ' + String(v[i][2] || '').slice(0, 120));
    }
    // 最新行の経過時間
    var top = v[0][0];
    var topDate = (top instanceof Date) ? top : new Date(String(top).replace(/\//g, '-'));
    if (!isNaN(topDate.getTime())) {
      var hours = Math.floor((new Date().getTime() - topDate.getTime()) / 3600000);
      Logger.log('  → 最新記録は ' + hours + ' 時間前');
    }
  } catch (e) {
    Logger.log('  読み取り失敗: ' + e.message);
  }
}

// ============================================================
// 既存カレンダーの「様様」修復（2026-09-16）
//   生成側は _lbWithSama で再発防止済み。既に作られてしまったタイトルをここで畳む。
//   対象：地下キャパ・1F・トレーナー全員のカレンダー
//   影響：タイトルのみ。日時・説明・イベントIDは変更しない。
//     ・billing → clientName が「今別府利江様様」→「今別府利江様」になり、正規化後に完全一致する（照合が改善する）
//     ・line_reservations → calendar_event_id で紐付いているためタイトル変更の影響を受けない
//     ・syncExistingReservations → 取込済み判定も event ID ベースなので影響なし
//   ※必ず runFixDoubleSamaDryRun() で一覧を確認してから runFixDoubleSama() を実行すること。
// ============================================================
function fixDoubleSamaTitles(dryRun, monthsBack, monthsForward) {
  var back = (monthsBack == null) ? 3 : monthsBack;
  var fwd  = (monthsForward == null) ? 3 : monthsForward;
  var now = new Date();
  var from = new Date(now.getFullYear(), now.getMonth() - back, 1);
  var to   = new Date(now.getFullYear(), now.getMonth() + fwd + 1, 0, 23, 59, 59);
  var tz = SETTINGS.TIMEZONE;

  var targets = [
    { id: CALENDAR_IDS.CAPACITY_B1, label: '地下キャパ' },
    { id: CALENDAR_IDS.CAPACITY_1F, label: '1F' }
  ];
  for (var t = 0; t < CALENDAR_IDS.TRAINERS.length; t++) {
    var tr = CALENDAR_IDS.TRAINERS[t];
    targets.push({ id: tr.email || tr.id, label: 'トレーナー(' + tr.name + ')' });
  }

  Logger.log('=== 「様様」修復 ' + (dryRun ? '【ドライラン：変更しません】' : '【実行】') + ' ===');
  Logger.log('対象期間: ' + Utilities.formatDate(from, tz, 'yyyy/MM/dd') + ' 〜 ' + Utilities.formatDate(to, tz, 'yyyy/MM/dd'));

  var hits = [], fixed = 0, failed = 0;

  for (var i = 0; i < targets.length; i++) {
    var cal = CalendarApp.getCalendarById(targets[i].id);
    if (!cal) { Logger.log('  ⚠️ カレンダー取得不可: ' + targets[i].label); continue; }
    var evs;
    try { evs = cal.getEvents(from, to); } catch (e) { Logger.log('  ⚠️ 取得失敗 ' + targets[i].label + ': ' + e.message); continue; }

    for (var e2 = 0; e2 < evs.length; e2++) {
      var title = evs[e2].getTitle();
      if (!/様{2,}/.test(title)) continue;
      var next = _lbCollapseSama(title);
      var when = Utilities.formatDate(evs[e2].getStartTime(), tz, 'yyyy/MM/dd HH:mm');
      hits.push({ cal: targets[i].label, when: when, before: title, after: next });

      if (!dryRun) {
        try { evs[e2].setTitle(next); fixed++; }
        catch (e3) { failed++; Logger.log('  ❌ 変更失敗: ' + title + ' : ' + e3.message); }
      }
    }
  }

  Logger.log('');
  if (hits.length === 0) {
    Logger.log('✅ 「様様」のタイトルは見つかりませんでした。');
  } else {
    Logger.log('検出 ' + hits.length + '件:');
    for (var h = 0; h < hits.length; h++) {
      Logger.log('  [' + hits[h].cal + '] ' + hits[h].when);
      Logger.log('      before: ' + hits[h].before);
      Logger.log('      after : ' + hits[h].after);
    }
  }
  Logger.log('');
  if (dryRun) {
    Logger.log('※ ドライランです。実際に直すには runFixDoubleSama() を実行してください。');
  } else {
    Logger.log('修復 ' + fixed + '件 / 失敗 ' + failed + '件');
    if (failed > 0) throw new Error('「様様」修復に失敗が ' + failed + '件あります（上のログを確認）');
  }
  return { dryRun: !!dryRun, detected: hits.length, fixed: fixed, failed: failed };
}

function runFixDoubleSamaDryRun() { return fixDoubleSamaTitles(true); }
function runFixDoubleSama() { return fixDoubleSamaTitles(false); }

// ───────────────────────────────────────────────────────────
// FEFO優先（2026-09-24）の影響点検：本番反映前に1回だけ実行する。
//   当月末で失効するチケットを月額より先に消化する変更で、既存会員の残数がどう変わるかを新旧で比較する。
//   読み取りのみ・書き込みなし。差分が出た会員は名指しで出すので、反映前にオーナーが確認できる。
// 実行: GASエディタで debugFefoImpact を選んで実行 → 実行ログを見る
// ───────────────────────────────────────────────────────────
function debugFefoImpact() {
  var tz = SETTINGS.TIMEZONE;
  var now = new Date(), nowMs = now.getTime();
  var nowKey = _lbMonthKeyJst(nowMs);
  var rate = LINE_BOOKING.CARRYOVER_RATE;
  var mapSh = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (!mapSh || mapSh.getLastRow() < 2) { Logger.log('会員がいません。'); return; }

  var mv = mapSh.getRange(2, 1, mapSh.getLastRow() - 1, MAP_COL.NOTE).getValues();
  var members = 0, compared = 0, skipped = [], diffs = [];
  for (var i = 0; i < mv.length; i++) {
    if (String(mv[i][MAP_COL.AUTH_STATE - 1]) !== 'verified') continue;
    var nm = String(mv[i][MAP_COL.NAME - 1] || ''); if (!nm) continue;
    var cid = String(mv[i][MAP_COL.CUSTOMER_ID - 1] || '');
    members++;
    var rows, sessions, opening;
    try {
      rows = _lbContractRowsAll(nm, _lbPhoneByCustomerId(cid), false, cid);
      if (!rows || !rows.length || rows.migrationGap) { skipped.push(nm + '（契約なし/要確認）'); continue; }
      sessions = _lbResvSessions(cid);
      if (sessions === null) { skipped.push(nm + '（予約情報を読めない）'); continue; }
      opening = _lbMemberOpening(cid);
    } catch (e) { skipped.push(nm + '（' + e.message + '）'); continue; }

    // 今月と翌月の両方を見る（翌月＝25日以降にホームへ出す残数）
    var checks = [{ label: '今月', ms: nowMs }, { label: '翌月', ms: new Date(now.getFullYear(), now.getMonth() + 1, 15, 12, 0, 0).getTime() }];
    for (var c = 0; c < checks.length; c++) {
      var neo, old;
      try {
        neo = _lbComputeRemaining(cid, rows, sessions, nowKey, checks[c].ms, rate, opening);
        old = _lbComputeRemaining(cid, rows, sessions, nowKey, checks[c].ms, rate, opening, true);
      } catch (e2) { skipped.push(nm + '（計算エラー: ' + e2.message + '）'); break; }
      compared++;
      var nM = (neo.monthlyRem == null) ? -1 : Number(neo.monthlyRem), nT = Number(neo.ticketRem || 0);
      var oM = (old.monthlyRem == null) ? -1 : Number(old.monthlyRem), oT = Number(old.ticketRem || 0);
      if (nM !== oM || nT !== oT) {
        diffs.push({ name: nm, when: checks[c].label,
          oldM: oM, oldT: oT, newM: nM, newT: nT,
          oldSum: Math.max(0, oM) + oT, newSum: Math.max(0, nM) + nT });
      }
    }
  }

  Logger.log('════════ FEFO優先の影響点検 ════════');
  Logger.log('点検時点: ' + Utilities.formatDate(now, tz, 'yyyy/MM/dd HH:mm'));
  Logger.log('会員数: ' + members + '名 / 比較した月: ' + compared + '件（1名あたり今月・翌月の2件）');
  Logger.log('');
  if (!diffs.length) {
    Logger.log('✅ 残数が変わる会員はいません。そのまま本番反映して問題ありません。');
  } else {
    Logger.log('⚠️ 残数の内訳が変わる会員: ' + diffs.length + '件');
    Logger.log('（合計が同じなら「どちらから引くか」が変わっただけ＝予約できる回数は不変。合計が増えていれば顧客の失権が減った＝改善）');
    Logger.log('');
    for (var d = 0; d < diffs.length; d++) {
      var x = diffs[d];
      var sign = (x.newSum > x.oldSum) ? '↑改善' : (x.newSum < x.oldSum ? '↓要確認' : '→内訳のみ');
      Logger.log('  ' + x.name + '（' + x.when + '）' + sign
        + '  旧: 月額' + (x.oldM < 0 ? '—' : x.oldM) + '/チケット' + x.oldT + '（計' + x.oldSum + '）'
        + ' → 新: 月額' + (x.newM < 0 ? '—' : x.newM) + '/チケット' + x.newT + '（計' + x.newSum + '）');
    }
    var worse = diffs.filter(function (y) { return y.newSum < y.oldSum; });
    Logger.log('');
    Logger.log(worse.length ? ('❌ 予約できる回数が減る会員が ' + worse.length + '件あります。反映前に原因を確認してください。')
      : '✅ 予約できる回数が減る会員はいません（内訳の変化のみ、または改善）。');
  }
  if (skipped.length) {
    Logger.log('');
    Logger.log('（比較できなかった会員 ' + skipped.length + '名）');
    for (var s = 0; s < skipped.length; s++) Logger.log('  - ' + skipped[s]);
  }
  Logger.log('════════════════════════════════════');
}

// ───────────────────────────────────────────────────────────
// 繰越の計算範囲を「契約開始月」まで広げた場合の影響点検（2026-09-25）。
//   いまは「予約のある月＋当月＋対象月」しか数えていないため、1件も予約が無い月は
//   枠を使ったことすら計算されず、その月の未消化が翌月へ繰り越されない。
//   契約が始まっている以上、来なかった月にも枠は発生している＝契約開始月から数えるのが正しい。
//   本番で既定にする前に、誰の残数がいくつ変わるかをこの関数で確認する。読み取りのみ。
// 実行: GASエディタで debugCarryRangeImpact を選んで実行 → 実行ログを見る
// ───────────────────────────────────────────────────────────
function debugCarryRangeImpact() {
  var tz = SETTINGS.TIMEZONE;
  var now = new Date(), nowMs = now.getTime();
  var nowKey = _lbMonthKeyJst(nowMs);
  var rate = LINE_BOOKING.CARRYOVER_RATE;
  var mapSh = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (!mapSh || mapSh.getLastRow() < 2) { Logger.log('会員がいません。'); return; }

  var mv = mapSh.getRange(2, 1, mapSh.getLastRow() - 1, MAP_COL.NOTE).getValues();
  var members = 0, skipped = [], diffs = [], noChange = 0;
  for (var i = 0; i < mv.length; i++) {
    if (String(mv[i][MAP_COL.AUTH_STATE - 1]) !== 'verified') continue;
    var nm = String(mv[i][MAP_COL.NAME - 1] || ''); if (!nm) continue;
    var cid = String(mv[i][MAP_COL.CUSTOMER_ID - 1] || '');
    members++;
    var rows, sessions, opening;
    try {
      rows = _lbContractRowsAll(nm, _lbPhoneByCustomerId(cid), false, cid);
      if (!rows || !rows.length || rows.migrationGap) { skipped.push(nm + '（契約なし/要確認）'); continue; }
      sessions = _lbResvSessions(cid);
      if (sessions === null) { skipped.push(nm + '（予約情報を読めない）'); continue; }
      opening = _lbMemberOpening(cid);
    } catch (e) { skipped.push(nm + '（' + e.message + '）'); continue; }

    var checks = [{ label: '今月', ms: nowMs }, { label: '翌月', ms: new Date(now.getFullYear(), now.getMonth() + 1, 15, 12, 0, 0).getTime() }];
    var hit = false;
    for (var c = 0; c < checks.length; c++) {
      var oldR, newR;
      try {
        oldR = _lbComputeRemaining(cid, rows, sessions, nowKey, checks[c].ms, rate, opening);
        newR = _lbComputeRemaining(cid, rows, sessions, nowKey, checks[c].ms, rate, opening, false, true);
      } catch (e2) { skipped.push(nm + '（計算エラー: ' + e2.message + '）'); hit = true; break; }
      var o = (oldR.monthlyRem == null) ? -1 : Number(oldR.monthlyRem);
      var n = (newR.monthlyRem == null) ? -1 : Number(newR.monthlyRem);
      if (o !== n) {
        hit = true;
        diffs.push({ name: nm, when: checks[c].label, old: o, neo: n,
          hasOpening: !!opening, freq: newR.freq || 0 });
      }
    }
    if (!hit) noChange++;
  }

  Logger.log('════════ 繰越の計算範囲を契約開始月に広げた場合の影響 ════════');
  Logger.log('点検時点: ' + Utilities.formatDate(now, tz, 'yyyy/MM/dd HH:mm'));
  Logger.log('会員数: ' + members + '名 / 残数が変わらない会員: ' + noChange + '名');
  Logger.log('');
  if (!diffs.length) {
    Logger.log('✅ 残数が変わる会員はいません。そのまま既定にして問題ありません。');
  } else {
    Logger.log('⚠️ 残数が変わる会員: ' + diffs.length + '件');
    Logger.log('（増える＝1ヶ月まるごと来店が無く、繰越を取りこぼしていた方。減る＝要確認）');
    Logger.log('');
    var up = 0, down = 0;
    for (var d = 0; d < diffs.length; d++) {
      var x = diffs[d];
      var mark = (x.neo > x.old) ? '↑' : '↓要確認';
      if (x.neo > x.old) up++; else down++;
      Logger.log('  ' + mark + ' ' + x.name + '（' + x.when + '・月' + x.freq + '回）'
        + '  ' + (x.old < 0 ? '—' : x.old) + ' → ' + (x.neo < 0 ? '—' : x.neo) + ' 回'
        + (x.hasOpening ? '  ※棚卸しあり' : ''));
    }
    Logger.log('');
    Logger.log('増える: ' + up + '件 / 減る: ' + down + '件');
    Logger.log(down ? '❌ 減る会員がいます。原因を確認してから既定にしてください。'
      : '✅ 減る会員はいません（取りこぼしていた繰越が戻るだけ）。');
  }
  if (skipped.length) {
    Logger.log('');
    Logger.log('（点検できなかった会員 ' + skipped.length + '名）');
    for (var s = 0; s < skipped.length; s++) Logger.log('  - ' + skipped[s]);
  }
  Logger.log('══════════════════════════════════════════════');
}
