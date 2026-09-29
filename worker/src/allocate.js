// _lbAllocateSessions — 作り直し設計v2 段階1：残数・請求の共通コア（純粋関数）
// 【重要】金額を一切出さない。利用権（月額枠／チケットpack）へのセッション割当のみ。
//   会計方針（消化時×単価 等）は上位層の責務（design-coexist-rebuild-v2.md §4-A）。
// GAS(V8)にもNodeにもそのまま載る ES5 スタイル（var/function・テンプレートリテラル不使用）。
// 【単一ソース】このファイルは clasp が GAS へ push し、GASはグローバル結合で LineBooking.js から直接呼べる。
//   同時に Node が require して検証する（末尾 module.exports は GAS では typeof module==='undefined' で不活性）。
//   ＝本番と検証が同一ファイル・ドリフト不可能（Codex警告のコピー版ずれを構造的に解消）。
// 検証: node 30_projects/personal-training/line-booking/test/allocate.test.js（＋ adapter.test.js）
//
// v2（Codex敵対チェック反映・要修正→堅牢版）：入力検証・fail-loud・base/carry分離・
//   決定論的canonical出力・logicVersion/inputHash を実装。
//   不変条件：入力sessionは必ず ちょうど1件 perSession に現れる（黙殺しない）。
//   fail-loud：不正入力は消化せず ok=false＋issues（顧客単位で上位が停止）。

// alloc-2：ペア（人数回消化・pack種別分離・締めdetailの人数/価格snapshot）を含む版。
//   既存CLOSED（alloc-1）はrecord.canonicalVersion無し＝旧canonicalで検証し続ける（_lbAllocationCanonicalが版で分岐）。
// alloc-3（2026-09-25）：FEFO優先／未来月の繰越受け取りと先取り調整／消化順の月別分岐／
//   繰越の計算範囲を契約開始月から——いずれも割当結果を変えるため版を上げる。
//   過去の締め（alloc-1/alloc-2）は ACCEPTED_VERSIONS で読み取りを維持する。
var LB_ALLOC_LOGIC_VERSION = 'alloc-3';
var LB_ALLOC_CANONICAL_VERSION = 2;                                        // 新規締めが record.canonicalVersion に焼く版
var LB_ALLOC_ACCEPTED_VERSIONS = { 'alloc-1': true, 'alloc-2': true, 'alloc-3': true };   // billingが読み取りを許容する版（過去締めを壊さない）

// ---- 小ヘルパ（純粋・GAS互換） ----
function _lbIsFiniteNum(x) { return typeof x === 'number' && isFinite(x); }
function _lbIsNonNegInt(x) { return _lbIsFiniteNum(x) && x >= 0 && Math.floor(x) === x; }

// JST(UTC+9) の 'YYYY-MM' 月キー
function _lbMonthKeyJst(ms) {
  var d = new Date(ms + 9 * 3600 * 1000); // UTC内部値を+9してUTCゲッターで読む＝JST壁時計
  var y = d.getUTCFullYear();
  var m = d.getUTCMonth() + 1;
  return y + '-' + (m < 10 ? '0' + m : '' + m);
}
function _lbMonthOrd(key) { var p = String(key).split('-'); return parseInt(p[0], 10) * 12 + (parseInt(p[1], 10) - 1); }
function _lbOrdToKey(ord) { var y = Math.floor(ord / 12); var m = (ord % 12) + 1; return y + '-' + (m < 10 ? '0' + m : '' + m); }
function _lbValidMonthKey(k) { return typeof k === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(k); }

// 決定論的な文字列ハッシュ（djb2・GAS互換）→ 8桁hex
function _lbHashStr(s) {
  var h = 5381;
  for (var i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) & 0xffffffff; }
  var u = h >>> 0;
  var hex = u.toString(16);
  while (hex.length < 8) hex = '0' + hex;
  return hex;
}

// その月に有効な月額/モニター契約行を選ぶ。複数競合（同一serviceFrom）は conflict フラグを返す。
function _lbMonthlyForMonth(monthlyRows, monthKey) {
  var ord = _lbMonthOrd(monthKey);
  var applicable = [];
  for (var i = 0; i < monthlyRows.length; i++) {
    var r = monthlyRows[i];
    var fromOrd = (r._fromOrd != null) ? r._fromOrd : -1e9;
    var toOrd = (r._toOrd != null) ? r._toOrd : 1e9;
    if (ord >= fromOrd && ord <= toOrd) applicable.push(r);
  }
  if (!applicable.length) return { row: null, conflict: false };
  // 最新serviceFromを採用。ただし同一serviceFromで内容（frequency）が割れたら conflict。
  applicable.sort(function (a, b) { return (b._fromOrd || -1e9) - (a._fromOrd || -1e9); });
  var top = applicable[0];
  var conflict = false;
  for (var j = 1; j < applicable.length; j++) {
    if ((applicable[j]._fromOrd || -1e9) === (top._fromOrd || -1e9) &&
        (applicable[j].frequency !== top.frequency ||
         _lbResolveCarryCap(applicable[j].frequency, applicable[j].carryCap, applicable[j].carryRate) !== _lbResolveCarryCap(top.frequency, top.carryCap, top.carryRate))) { conflict = true; break; }   // 実効capで比較（同値overrideを誤conflictにしない・Codex Medium）
  }
  return { row: top, conflict: conflict };
}

// FEFO 順（expiresAt, availableAt, packId）の全順序
// 合成pack ID `CT<from>_<to>_<idx>` の末尾idxを除いた安定prefix `CT<from>_<to>` を返す（チケット追加でidxがずれても不変）。
//   rawPid（明示pack_id・CT始まりでない）は不変idなのでそのまま返す＝完全一致のみで扱う。
function _lbPackPrefix(packId) { var s = String(packId); return /^CT\d/.test(s) ? s.replace(/_\d+$/, '') : s; }

function _lbPackOrder(packs) {
  var idx = [];
  for (var i = 0; i < packs.length; i++) idx.push(i);
  idx.sort(function (a, b) {
    var pa = packs[a], pb = packs[b];
    if (pa.expiresAt !== pb.expiresAt) return pa.expiresAt - pb.expiresAt;
    if (pa.availableAt !== pb.availableAt) return pa.availableAt - pb.availableAt;
    var ka = String(pa.packId), kb = String(pb.packId);
    return ka < kb ? -1 : (ka > kb ? 1 : 0);
  });
  return idx;
}

// 当月末で失効するpackが「いま消化可能か」。月額より先に使うべき権利があるかの判定（FEFO優先）。
//   チケットは期限を過ぎると全損。月額の未消化はcap内で翌月へ生き残る。
//   よって当月失効のpackを先に使うほうが、失効する総量は常に同等以下になる（min(未消化,cap)の凹性）。
//   期限が翌月以降のpackは対象外＝急いで使う必要がなく、従来どおり月額を先に消化する。
function _lbExpiringPackAvailable(packs, packOrder, ses, monthKey, wantKind) {
  for (var q = 0; q < packOrder.length; q++) {
    var pk = packs[packOrder[q]];
    if (pk.kind !== wantKind) continue;
    if (pk.used + 1 > pk.qty) continue;                       // 残なし
    if (ses.startAt < pk.availableAt) continue;               // 開始前
    if (ses.startAt > pk.expiresAt) continue;                 // 期限切れ
    if (_lbMonthKeyJst(pk.expiresAt) === monthKey) return true;   // 当月末で切れる＝最優先
  }
  return false;
}

// 月額繰越の上限（頻度→上限回数テーブル・オーナー実態確定 2026-08-27）。
//   優先順：個別override（契約マスタ「繰越上限」列）＞頻度テーブル＞率fallback（テーブル外の頻度のみ）。
//   ※上限＝MAX。実際の繰越は min(未消化base, 上限)。旧「率(1/3)」は月2=0・月12=4となり実態(1・3)とズレるため置換。
var LB_CARRY_CAP_TABLE = { 2: 1, 4: 1, 6: 2, 8: 2, 12: 3 };
function _lbResolveCarryCap(frequency, carryCapOverride, carryRate) {
  if (carryCapOverride != null && carryCapOverride >= 0) return Math.floor(carryCapOverride);   // 顧客別override
  if (LB_CARRY_CAP_TABLE[frequency] != null) return LB_CARRY_CAP_TABLE[frequency];              // 頻度テーブル
  return Math.floor((Number(frequency) || 0) * (Number(carryRate) || 0));                        // テーブル外頻度は従来率
}

function _lbAllocateSessions(customerId, entitlements, sessions, options) {
  var issues = [];
  function issue(code, detail) { issues.push({ code: code, detail: detail || '' }); }
  var ok = true;

  entitlements = (entitlements == null) ? {} : entitlements;
  options = (options == null) ? {} : options;
  var legacyMonthlyFirst = (options.legacyMonthlyFirst === true);   // 検証・ロールバック専用（本番は常にfalse＝FEFO優先）
  // 繰越の計算範囲を「契約開始月」まで遡るか（2026-09-25 オーナー提案・既定はまだfalse）。
  //   従来は「予約のある月＋当月＋対象月」しか見ていないため、1件も予約が無い月は枠を使ったことすら
  //   計算されず、その月の未消化が翌月へ繰り越されなかった（1ヶ月まるごと来なかった会員が繰越を失う）。
  //   契約が始まっている以上、来なかった月にも枠は発生している＝契約開始月から数えるのが正しい。
  //   2026-09-25 debugCarryRangeImpact で全37名を点検：変わるのは1名のみ・増えるだけで減る会員は0。
  //   よって既定を true にした。false を明示すると従来（予約のある月だけ）に戻せる。
  var carryFromContractStart = (options.carryFromContractStart !== false);
  // 記録が完全な最古の月（'YYYY-MM'）。これより前へは遡らない（2026-09-25 Codexレビュー）。
  //   LINE予約の記録しか持たないため、会員登録より前の月は「予約0件」でも来ていないとは限らない。
  //   遡って「未消化」と誤認すると、実際には使った枠が繰越として復活してしまう。
  var recordsFromOrd = null;
  if (options.recordsFromMonth != null) {
    if (_lbValidMonthKey(options.recordsFromMonth)) recordsFromOrd = _lbMonthOrd(options.recordsFromMonth);
    else { issue('INVALID_INPUT', 'recordsFromMonth bad'); ok = false; }
  }
  if (typeof entitlements !== 'object') { issue('INVALID_INPUT', 'entitlements not object'); entitlements = {}; ok = false; }

  // customerId
  if (typeof customerId !== 'string' || customerId === '') { issue('CUSTOMER_ID_MISSING', ''); ok = false; }

  // containers 型検証
  var rawMonthly = entitlements.monthlyRows;
  var rawPacks = entitlements.packs;
  var rawOpening = entitlements.openingCarry;
  if (rawMonthly != null && Object.prototype.toString.call(rawMonthly) !== '[object Array]') { issue('INVALID_INPUT', 'monthlyRows not array'); ok = false; rawMonthly = []; }
  if (rawPacks != null && Object.prototype.toString.call(rawPacks) !== '[object Array]') { issue('INVALID_INPUT', 'packs not array'); ok = false; rawPacks = []; }
  if (rawOpening != null && typeof rawOpening !== 'object') { issue('INVALID_INPUT', 'openingCarry not object'); ok = false; rawOpening = {}; }
  rawMonthly = rawMonthly || []; rawPacks = rawPacks || []; rawOpening = rawOpening || {};

  var carryRateDefault = (1 / 3);
  if (options.carryRateDefault != null) {
    if (_lbIsFiniteNum(options.carryRateDefault) && options.carryRateDefault >= 0 && options.carryRateDefault <= 1) carryRateDefault = options.carryRateDefault;
    else { issue('INVALID_INPUT', 'carryRateDefault out of [0,1]'); ok = false; }
  }
  var asOfOrd = (options.asOfMonth != null) ? (_lbValidMonthKey(options.asOfMonth) ? _lbMonthOrd(options.asOfMonth) : null) : null;
  if (options.asOfMonth != null && asOfOrd == null) { issue('INVALID_INPUT', 'asOfMonth bad'); ok = false; }

  // ---- 月額行 正規化・検証 ----
  var monthlyRows = [];
  for (var mi = 0; mi < rawMonthly.length; mi++) {
    var r = rawMonthly[mi] || {};
    var freqOk = _lbIsNonNegInt(r.frequency);
    var rate = (r.carryRate == null) ? carryRateDefault : r.carryRate;
    var rateOk = _lbIsFiniteNum(rate) && rate >= 0 && rate <= 1;
    var fromOk = _lbIsFiniteNum(r.serviceFrom);
    var toOk = _lbIsFiniteNum(r.serviceTo);
    if (!freqOk || !rateOk) { issue('INVALID_ENTITLEMENT', 'monthly[' + mi + '] frequency/carryRate'); ok = false; continue; }
    if ((r.serviceFrom != null && !fromOk) || (r.serviceTo != null && !toOk)) { issue('INVALID_ENTITLEMENT', 'monthly[' + mi + '] service dates'); ok = false; continue; }
    if (fromOk && toOk && r.serviceFrom > r.serviceTo) { issue('INVALID_ENTITLEMENT', 'monthly[' + mi + '] serviceFrom>serviceTo'); ok = false; continue; }
    var capOv = null;   // 繰越上限の顧客別override（契約「繰越上限」列・非負整数のみ・空欄=頻度テーブル）
    if (r.carryCap != null) {
      if (_lbIsNonNegInt(r.carryCap)) capOv = r.carryCap;
      else { issue('INVALID_ENTITLEMENT', 'monthly[' + mi + '] carryCap'); ok = false; continue; }
    }
    monthlyRows.push({ frequency: r.frequency, carryRate: rate, carryCap: capOv,
      _fromOrd: fromOk ? _lbMonthOrd(_lbMonthKeyJst(r.serviceFrom)) : null,
      _toOrd: toOk ? _lbMonthOrd(_lbMonthKeyJst(r.serviceTo)) : null });
  }

  // ---- pack 正規化・検証・一意性。openingPacks[packId]=締め済み消化枚数(cutover opening)を初期usedに ----
  var openingPacks = (entitlements.openingPacks && typeof entitlements.openingPacks === 'object') ? entitlements.openingPacks : {};
  var packs = [];
  var packIdSeen = {};
  for (var pi = 0; pi < rawPacks.length; pi++) {
    var p = rawPacks[pi] || {};
    var pidOk = (typeof p.packId === 'string' && p.packId !== '');
    var qtyOk = _lbIsNonNegInt(p.qty);
    var avOk = _lbIsFiniteNum(p.availableAt);
    var exOk = _lbIsFiniteNum(p.expiresAt);
    if (!pidOk) { issue('INVALID_ENTITLEMENT', 'pack[' + pi + '] packId'); ok = false; continue; }
    if (packIdSeen[p.packId]) { issue('DUPLICATE_PACK_ID', p.packId); ok = false; continue; }
    packIdSeen[p.packId] = true;
    if (!qtyOk || !avOk || !exOk || p.availableAt > p.expiresAt) { issue('INVALID_ENTITLEMENT', 'pack ' + p.packId + ' qty/dates'); ok = false; continue; }
    // pack種別：'pair'(ペアチケット＝人数回)／'normal'(通常)。未指定は 'normal'（後方互換）。不正値はfail-loud。
    var pKind = (p.kind == null || p.kind === '') ? 'normal' : String(p.kind);
    if (pKind !== 'normal' && pKind !== 'pair') { issue('INVALID_ENTITLEMENT', 'pack ' + p.packId + ' kind=' + pKind); ok = false; continue; }
    // opening消化の初期usedは packId 確定後に一括で割り当てる（idxずれ吸収・下の「opening解決」ブロック）。
    packs.push({ packId: p.packId, qty: p.qty, availableAt: p.availableAt, expiresAt: p.expiresAt, used: 0, kind: pKind });
  }
  var packOrder = _lbPackOrder(packs);

  // ---- openingCarry 検証・cutover月決定 ----
  var openingCarry = {};
  var cutoverOrd = null;
  for (var ok2 in rawOpening) {
    if (!rawOpening.hasOwnProperty(ok2)) continue;
    if (!_lbValidMonthKey(ok2) || !_lbIsNonNegInt(rawOpening[ok2])) { issue('INVALID_INPUT', 'openingCarry ' + ok2); ok = false; continue; }
    openingCarry[ok2] = rawOpening[ok2];
    var oOrd = _lbMonthOrd(ok2);
    if (cutoverOrd == null || oOrd < cutoverOrd) cutoverOrd = oOrd;
  }
  // 明示cutover境界（月額carryと独立・openingPacksだけ渡す締めでも過去sessionの二重消化を防ぐ）
  if (options.cutoverMonth != null) {
    if (_lbValidMonthKey(options.cutoverMonth)) cutoverOrd = _lbMonthOrd(options.cutoverMonth);
    else { issue('INVALID_INPUT', 'cutoverMonth'); ok = false; }
  }
  // ---- opening解決：締め時点の消化枚数(openingPacks)を現在のpackへ割り当てる（idxずれ吸収・案B）----
  //   完全一致を最優先。合成ID(CT<from>_<to>_<idx>)はチケット追加でidxがずれるため、末尾idxを除いた
  //   prefix(CT<from>_<to>)が「一意に」一致する現在packへ割り当てる（openingを付け替えずそのまま使える）。
  //   prefixが複数packに一致（同一from/toの重複pack）＝曖昧、またはどれにも一致しない＝消滅pack は fail-loud
  //   （残数の取り違えより停止を選ぶ＝会計の安全側。従来動作を維持）。数値/範囲(<=qty)の検証も従来どおり。
  if (entitlements.openingPacks != null && typeof entitlements.openingPacks !== 'object') { issue('INVALID_INPUT', 'openingPacks not object'); ok = false; }
  else {
    var _packByPrefix = {};
    for (var _pp = 0; _pp < packs.length; _pp++) {
      var _pfx = _lbPackPrefix(packs[_pp].packId);
      if (_pfx !== packs[_pp].packId) (_packByPrefix[_pfx] = _packByPrefix[_pfx] || []).push(packs[_pp]);   // 合成IDのみprefix索引に登録（rawPidは完全一致専用）
    }
    for (var _opk in openingPacks) {
      if (!openingPacks.hasOwnProperty(_opk)) continue;
      var _oused = openingPacks[_opk], _tgt = null;
      if (packIdSeen[_opk]) { for (var _q = 0; _q < packs.length; _q++) { if (packs[_q].packId === _opk) { _tgt = packs[_q]; break; } } }   // ①完全一致
      else { var _kpfx = _lbPackPrefix(_opk); if (_kpfx !== _opk) { var _cand = _packByPrefix[_kpfx] || []; if (_cand.length === 1) _tgt = _cand[0]; } }   // ②prefix一致（一意のときだけ）
      if (!_tgt) { issue('INVALID_INPUT', 'openingPacks unknown pack ' + _opk); ok = false; continue; }   // 消滅pack/曖昧＝停止（安全側）
      if (!(_lbIsNonNegInt(_oused) && _oused <= _tgt.qty)) { issue('INVALID_INPUT', 'openingPacks ' + _opk); ok = false; continue; }
      _tgt.used = _oused;
    }
  }

  // ---- session 正規化・検証・一意性・振替分離 ----
  var perSession = [];
  var byMonth = {};
  var sessArr;
  if (sessions == null) sessArr = [];
  else if (Object.prototype.toString.call(sessions) !== '[object Array]') { issue('INVALID_INPUT', 'sessions not array'); ok = false; sessArr = []; }
  else sessArr = sessions;

  var sidSeen = {};
  for (var s = 0; s < sessArr.length; s++) {
    var sn = sessArr[s];
    if (sn == null || typeof sn !== 'object') { issue('INVALID_SESSION', 'index ' + s); ok = false; perSession.push({ sessionId: null, monthKey: null, alloc: 'unallocated', reason: 'INVALID_SESSION' }); continue; }
    var sid = sn.sessionId;
    if (typeof sid !== 'string' || sid === '') { issue('INVALID_SESSION', 'sessionId index ' + s); ok = false; perSession.push({ sessionId: (sid == null ? null : sid), monthKey: null, alloc: 'unallocated', reason: 'INVALID_SESSION' }); continue; }
    if (sidSeen[sid]) { issue('DUPLICATE_SESSION_ID', sid); ok = false; perSession.push({ sessionId: sid, monthKey: null, alloc: 'unallocated', reason: 'INVALID_INPUT' }); continue; }
    sidSeen[sid] = true;
    if (!_lbIsFiniteNum(sn.startAt)) { issue('INVALID_SESSION', 'startAt ' + sid); ok = false; perSession.push({ sessionId: sid, monthKey: null, alloc: 'unallocated', reason: 'INVALID_START_AT' }); continue; }
    var ch = sn.channel;
    if (ch !== 'line' && ch !== 'transfer') { issue('INVALID_SESSION', 'channel ' + sid); ok = false; perSession.push({ sessionId: sid, monthKey: _lbMonthKeyJst(sn.startAt), alloc: 'unallocated', reason: 'INVALID_CHANNEL' }); continue; }
    var mk = _lbMonthKeyJst(sn.startAt);
    if (ch === 'transfer') { perSession.push({ sessionId: sid, monthKey: mk, alloc: 'transfer' }); continue; }
    // cutover境界前は割当対象外（seedより前を遡らない）
    if (cutoverOrd != null && _lbMonthOrd(mk) < cutoverOrd) { issue('PRE_CUTOVER', sid); perSession.push({ sessionId: sid, monthKey: mk, alloc: 'unallocated', reason: 'PRE_CUTOVER' }); continue; }
    // ペア属性の検証（fail-loud）。来店人数は 1 or 2 の整数のみ（未指定=1）。0/負/小数/999/文字列は黙って1にしない。
    var pkw = (sn.packKind == null || sn.packKind === '') ? 'normal' : String(sn.packKind);
    if (pkw !== 'normal' && pkw !== 'pair') { issue('INVALID_SESSION', 'packKind ' + sid); ok = false; perSession.push({ sessionId: sid, monthKey: mk, alloc: 'unallocated', reason: 'INVALID_PACK_KIND' }); continue; }
    var cmw = (sn.consumptionMode == null || sn.consumptionMode === '') ? '' : String(sn.consumptionMode);
    if (cmw !== '' && cmw !== 'pack' && cmw !== 'monthly') { issue('INVALID_SESSION', 'consumptionMode ' + sid); ok = false; perSession.push({ sessionId: sid, monthKey: mk, alloc: 'unallocated', reason: 'INVALID_CONSUMPTION_MODE' }); continue; }
    var uni;
    if (sn.attendeeCount == null || sn.attendeeCount === '') uni = 1;
    else {
      var _u = Number(sn.attendeeCount);
      if (!(_lbIsFiniteNum(_u) && (_u === 1 || _u === 2))) { issue('INVALID_ATTENDEE_COUNT', sid); ok = false; perSession.push({ sessionId: sid, monthKey: mk, alloc: 'unallocated', reason: 'INVALID_ATTENDEE_COUNT' }); continue; }
      uni = _u;
    }
    if (uni === 2 && pkw !== 'pair') { issue('INVALID_ATTENDEE_COUNT', sid + ' 2名はペアpackのみ'); ok = false; perSession.push({ sessionId: sid, monthKey: mk, alloc: 'unallocated', reason: 'INVALID_ATTENDEE_COUNT' }); continue; }
    if (!byMonth[mk]) byMonth[mk] = [];
    byMonth[mk].push({ sessionId: sid, startAt: sn.startAt, units: uni, packKind: pkw, consumptionMode: cmw });   // ペア人数/種別を消化ロジックへ持ち回る
  }

  // ---- asOfMonth 必須性：割当対象月がある時は未来月判定に必須 ----
  var hasMonths = false;
  for (var hk in byMonth) if (byMonth.hasOwnProperty(hk)) { hasMonths = true; break; }
  if (hasMonths && asOfOrd == null) { issue('MISSING_AS_OF_MONTH', ''); ok = false; }

  // ---- 月レンジ決定 ----
  var ords = [];
  for (var k in byMonth) if (byMonth.hasOwnProperty(k)) ords.push(_lbMonthOrd(k));
  if (cutoverOrd != null) ords.push(cutoverOrd);
  if (asOfOrd != null) ords.push(asOfOrd);
  // throughMonth：予約対象月がまだ予約ゼロでも残数を出すためレンジを延ばす（段階2アダプタ用）
  var throughOrd = null;
  if (options.throughMonth != null) {
    if (_lbValidMonthKey(options.throughMonth)) { throughOrd = _lbMonthOrd(options.throughMonth); ords.push(throughOrd); }
    else { issue('INVALID_INPUT', 'throughMonth bad'); ok = false; }
  }
  var perMonth = [];
  if (ords.length) {
    var minOrd = Math.min.apply(null, ords);
    if (carryFromContractStart) {
      // 契約（月額行）の開始月まで遡る。移行棚卸し(cutover)がある会員は下でcutover月が優先される＝
      //   LINE導入前の記録が無い期間を「来ていない」と誤判定しない。
      for (var _mi = 0; _mi < monthlyRows.length; _mi++) {
        var _fo = monthlyRows[_mi]._fromOrd;
        if (_lbIsFiniteNum(_fo) && _fo < minOrd) minOrd = _fo;
      }
      // 記録が完全な月より前へは遡らない（会員登録前の月を「来ていない」と誤判定しないため）
      if (recordsFromOrd != null && minOrd < recordsFromOrd) minOrd = recordsFromOrd;
    }
    if (cutoverOrd != null) minOrd = cutoverOrd; // cutoverがあれば開始はcutover月（それ以前は上でPRE_CUTOVER）
    var maxOrd = Math.max.apply(null, ords);

    // 翌月以降が当月から繰り越して使った回数。当月の消化に足し戻して二重取りを防ぐ（2026-09-25）。
    //   例：9月残4・繰越上限2の会員が25日に10月へ2回ぶん予約 → 9月に使えるのは残2。
    //   繰越は「当月の枠を翌月へ回す」ものなので、回した分は当月では使えない。
    //   carryOut が futureCarryUsed に依存するため、2パス回して収束させる（1パス目で見積もり→2パス目で確定）。
    //   どの月の枠を先取りしたかを月ごとに持つ（2026-09-25 Codexレビュー）。
    //   合算にすると、11月が10月の枠から繰り越して使った分まで当月(9月)から引いてしまう。
    //   carryUsed は必ず「前月の枠」の消費なので ord-1 に紐付ける。
    var futureCarryTaken = {};   // ord（先取りされた月） -> 回数
    var packUsed0 = packs.map(function (pp) { return pp.used; });   // opening適用後の初期used（パス間で復元）
    var issues0 = issues.length, ok0 = ok;
    var perSession0 = perSession.length;   // 月ループより前に積まれた分（振替など）は消さない
    for (var pass = 0; pass < 2; pass++) {
    perMonth = [];
    perSession.length = perSession0;
    for (var _pr = 0; _pr < packs.length; _pr++) packs[_pr].used = packUsed0[_pr];
    issues.length = issues0; ok = ok0;   // パスをやり直すので検出済みissueも積み直す（重複計上しない）
    var passCarryTaken = {};
    var prev = null; // {carryOut}
    for (var ord = minOrd; ord <= maxOrd; ord++) {
      var monthKey = _lbOrdToKey(ord);
      var sel = _lbMonthlyForMonth(monthlyRows, monthKey);
      if (sel.conflict) { issue('REVIEW_REQUIRED', 'conflicting monthly rows @' + monthKey); ok = false; }
      var mr = sel.row;
      var frequency = mr ? mr.frequency : 0;
      var carryRate = mr ? mr.carryRate : carryRateDefault;
      var carryCap = mr ? mr.carryCap : null;   // 顧客別override（無ければテーブル/率）
      var isFuture = (asOfOrd != null && ord > asOfOrd);

      // 優先順：未来月0 → cutover seed → 前月carryOut（Codex再チェック反映）
      var carryIn;
      if (isFuture) {
        // 未来月も前月の繰越を受け取る（2026-09-25 オーナー指示）。25日に翌月の予約が開くのに
        //   繰越分だけ使えないのは実害だったため。当月の枠を先取りした分は下で当月の消化に足し戻す。
        carryIn = (prev != null) ? prev.carryOut : 0;
        if (openingCarry[monthKey] != null) { issue('INVALID_INPUT', 'openingCarry on future month ' + monthKey); ok = false; }   // seed混入は不正（従来どおり）
      } else if (openingCarry[monthKey] != null) carryIn = openingCarry[monthKey]; // cutover seed唯一源（前月に関係なく権威）
      else if (prev != null) carryIn = prev.carryOut;                         // 前月未消化base（cap済）
      else carryIn = 0;

      var base = frequency;
      var quota = base + carryIn;
      var list = (byMonth[monthKey] || []).slice().sort(function (a, b) {
        if (a.startAt !== b.startAt) return a.startAt - b.startAt;
        return a.sessionId < b.sessionId ? -1 : (a.sessionId > b.sessionId ? 1 : 0);
      });

      var used = 0, carryUsed = 0, baseUsed = 0;
      for (var li = 0; li < list.length; li++) {
        var ses = list[li];
        var units = ses.units;                                   // 来店人数ぶん消化（既定1＝従来通り・検証済み）
        var wantKind = ses.packKind;                             // 'pair' は必ずペアpackから（通常packと相互消化しない）
        // 消化先は予約時に確定した属性で決める（締めで再導出しない）。ペア＝常にpack（月額に吸われない・1名来店でも）。
        var forcePack = (ses.consumptionMode === 'pack') || (wantKind === 'pair');
        // FEFO優先（2026-09-24）：当月末で失効するpackが使えるなら、月額より先に消化する（顧客の失権を最小化）。
        //   options.legacyMonthlyFirst=true で旧挙動（月額を常に先）に戻せる＝新旧の差分点検とロールバック用。
        if (!legacyMonthlyFirst && !forcePack && units === 1 && _lbExpiringPackAvailable(packs, packOrder, ses, monthKey, wantKind)) forcePack = true;
        if (used < quota && units === 1 && !forcePack) {   // 月額はunits=1かつ非ペアのみ
          used++;
          // 消化順（2026-09-25）：
          //   当月＝繰越から先に使う（use-it-or-lose-it。繰越は当月末で完全に失効するため）。
          //   翌月以降＝その月の枠から先に使い、足りなくなってから当月の繰越を引く。
          //     25日に翌月の予約を入れただけで当月の残が削られると、当月に来たい分まで取れなくなるため。
          //     翌月の枠を使い切るまでは当月の残は動かない。
          if (isFuture) { if (baseUsed < base) baseUsed++; else carryUsed++; }
          else { if (carryUsed < carryIn) carryUsed++; else baseUsed++; }
          perSession.push({ sessionId: ses.sessionId, monthKey: monthKey, alloc: 'monthly' });
        } else {
          // pack FEFO＋不成立理由の分類（ペアは units 枚ぶんの空きを要求・同kind内でのみ消化）
          var assigned = null, sawNotYet = false, sawExpired = false, sawExhausted = false, sawAny = false, sawKindMismatch = false;
          for (var q = 0; q < packOrder.length; q++) {
            var pk = packs[packOrder[q]];
            if (pk.kind !== wantKind) { sawKindMismatch = true; continue; }   // 種別違いのpackは消化対象外（ペア⇔通常の相互消化を禁止）
            sawAny = true;
            if (pk.used + units > pk.qty) { sawExhausted = true; continue; }   // units枚ぶんの残がある単一packが必要
            if (ses.startAt < pk.availableAt) { sawNotYet = true; continue; }
            if (ses.startAt > pk.expiresAt) { sawExpired = true; continue; }
            pk.used += units; assigned = pk.packId; break;
          }
          if (assigned != null) {
            var pa = { sessionId: ses.sessionId, monthKey: monthKey, alloc: 'pack', packId: assigned, units: units };
            if (wantKind !== 'normal') pa.packKind = wantKind;   // 通常は従来出力のまま（golden非破壊）
            perSession.push(pa);
          } else {
            var reason = !sawAny ? (sawKindMismatch ? 'PACK_KIND_UNAVAILABLE' : 'NO_ENTITLEMENT')
              : sawExhausted ? 'PACK_EXHAUSTED'
              : sawNotYet ? 'PACK_NOT_YET_AVAILABLE'
              : sawExpired ? 'PACK_EXPIRED' : 'NO_ENTITLEMENT';
            var ua = { sessionId: ses.sessionId, monthKey: monthKey, alloc: 'unallocated', reason: reason };
            if (wantKind !== 'normal') ua.packKind = wantKind;
            perSession.push(ua);
          }
        }
      }

      // 翌月以降が繰り越して使った分は「当月の枠を先取りした」ことになるので、当月の消化に足し戻す。
      //   これが無いと、当月にも満額使えてしまい同じ枠を二度使える（2026-09-25）。
      var carryForward = 0;
      var _taken = futureCarryTaken[ord] || 0;
      if (_taken > 0 && asOfOrd != null && ord >= asOfOrd) {   // 過去月の実績は確定済み＝触らない（締めが動かない）
        carryForward = Math.min(_taken, Math.max(0, base - baseUsed));   // その月の未消化baseを超えては先取りできない
        used += carryForward;
        baseUsed += carryForward;
      }
      // 翌月以降が使った繰越は「前月(ord-1)の枠」の先取り。その月に足し戻す。
      if (isFuture && carryUsed > 0) passCarryTaken[ord - 1] = (passCarryTaken[ord - 1] || 0) + carryUsed;

      var carryRemaining = carryIn - carryUsed;
      var baseRemaining = base - baseUsed;
      var monthlyRemaining = quota - used;
      var cap = _lbResolveCarryCap(base, carryCap, carryRate);   // 頻度テーブル＋顧客override（旧: floor(base×rate)）
      var carryOut = Math.min(baseRemaining + carryForward, cap); if (carryOut < 0) carryOut = 0;   // 未消化base（先取り分を戻して評価）のみ翌月へ
      perMonth.push({ monthKey: monthKey, frequency: frequency, carryIn: carryIn, quota: quota,
        baseUsed: baseUsed, baseRemaining: baseRemaining, carryUsed: carryUsed, carryRemaining: carryRemaining,
        monthlyUsed: used, monthlyRemaining: monthlyRemaining, carryOut: carryOut,
        carryForward: carryForward });   // 翌月へ先取りで回した回数（0なら従来どおり）
      prev = { carryOut: carryOut };
    }
    var _a = [], _b = [];
    for (var _k1 in passCarryTaken) _a.push(_k1 + ':' + passCarryTaken[_k1]);
    for (var _k2 in futureCarryTaken) _b.push(_k2 + ':' + futureCarryTaken[_k2]);
    if (_a.sort().join('|') === _b.sort().join('|')) break;   // 収束＝先取りの内訳が変わらなくなった
    futureCarryTaken = passCarryTaken;
    }
  }

  // ---- canonical 出力並び（入力順不変性） ----
  perSession.sort(function (a, b) {
    var ma = a.monthKey || '~', mb = b.monthKey || '~';
    if (ma !== mb) return ma < mb ? -1 : 1;
    var sa = String(a.sessionId), sb = String(b.sessionId);
    return sa < sb ? -1 : (sa > sb ? 1 : 0);
  });
  var perPack = packs.map(function (p) { return { packId: p.packId, qty: p.qty, used: p.used, remaining: Math.max(0, p.qty - p.used), kind: p.kind }; })
    .sort(function (a, b) { return a.packId < b.packId ? -1 : (a.packId > b.packId ? 1 : 0); });

  // ---- inputHash（正規化・入力順非依存） ----
  var canon = JSON.stringify({
    c: customerId,
    m: monthlyRows.map(function (r) { return [r.frequency, r.carryRate, r.carryCap, r._fromOrd, r._toOrd]; }).sort(),
    p: packs.map(function (p) { return [p.packId, p.qty, p.availableAt, p.expiresAt, p.kind]; }).sort(),
    o: Object.keys(openingCarry).sort().map(function (kk) { return [kk, openingCarry[kk]]; }),
    op: Object.keys(openingPacks).sort().map(function (kk) { return [kk, openingPacks[kk]]; }),   // opening pack消化もhashに含める（価格でなく状態変化の検知）
    s: sessArr.filter(function (x) { return x && typeof x === 'object'; }).map(function (x) { return [String(x.sessionId), x.startAt, x.channel, (Number(x.attendeeCount) === 2) ? 2 : 1, String(x.packKind || 'normal'), String(x.consumptionMode || '')]; }).sort(),
    a: options.asOfMonth || null, cm: options.cutoverMonth || null, r: carryRateDefault,
    lmf: legacyMonthlyFirst ? 1 : 0,
    // 出力月数と割当結果を変えるので同一性判定に含める（2026-09-25 Codexレビュー）
    tm: options.throughMonth || null, cfs: carryFromContractStart ? 1 : 0, rf: (recordsFromOrd == null ? null : recordsFromOrd)
  });

  return { ok: ok, issues: issues, perSession: perSession, perMonth: perMonth, perPack: perPack,
    logicVersion: LB_ALLOC_LOGIC_VERSION, inputHash: _lbHashStr(canon) };
}

// ═══ 段階2アダプタ（純粋・Node検証可）：現行データ形 → 割当器入力 → 残数 ═══
//   LineBooking.js の GAS ラッパー（_lbSplitRemaining 等）がこれらを呼ぶ（同一ファイル・単一ソース）。

// 契約行（{row, cols, start:Date, end:Date}）→ entitlements＋issues。cols=_lbContractColsのindex。
function _lbRowsToEntitlements(rows, carryRateDefault) {
  var monthlyRows = [], packs = [], hasMonthly = false, hasTicket = false, ticketTotal = 0, issues = [];
  for (var i = 0; i < (rows || []).length; i++) {
    var rr = rows[i], cc = rr.cols, r = rr.row;
    var mv = (cc.method >= 0) ? r[cc.method] : ''; var method = (mv == null) ? '' : String(mv);
    var tv = (cc.type >= 0) ? r[cc.type] : ''; var type = (tv == null) ? '' : String(tv);
    var cv = (cc.course >= 0) ? r[cc.course] : ''; var course = (cv == null) ? '' : String(cv);   // コース列も「ペア」判定に使う（種別=通常でもコース=ペアならペアpack）
    // H3：どちらかが「チケット」を含めばチケット（取りこぼし防止）。矛盾（片方だけ月額系明示）はチケット優先で安全側。
    var isT = (method.indexOf('チケット') >= 0) || (type.indexOf('チケット') >= 0);
    var startMs = rr.start ? rr.start.getTime() : null;
    var endMs = rr.end ? rr.end.getTime() : null;
    if (isT) {
      hasTicket = true;
      var qty = cc.ticket >= 0 ? Number(r[cc.ticket] || 0) : 0;
      ticketTotal += qty;
      // H4：チケットは期限必須。期限欠損はpackを作らず fail-closed（残数に載せない＋ok=false）。
      if (endMs == null) { issues.push({ code: 'TICKET_NO_EXPIRY', detail: 'row' + i }); continue; }
      // 期限は「終了日のJST終端(23:59:59.999)まで有効」。時刻成分に依らず当日終端に正規化
      //   （0時セルで当日午後が切れる／既に23:59:59のセルで翌日まで延びる、の両境界を回避）。
      var _jst = endMs + 9 * 3600000;
      var expEnd = (Math.floor(_jst / 86400000) * 86400000 - 9 * 3600000) + 86399999;
      // pack_id：列があれば「不変idの唯一の正本」。列ありで空欄＝採番漏れ→fail-closed（packを作らない・C-1）。
      //   列なし互換期間のみ、シート行idxで合成（＝残数計算専用。会計の永続idにはしない・単価join不可）。
      var packId;
      if (cc.packId >= 0) {
        var rawPid = (r[cc.packId] == null) ? '' : String(r[cc.packId]).replace(/^\s+|\s+$/g, '');
        if (rawPid === '') { issues.push({ code: 'PACK_ID_MISSING', detail: 'row' + i }); continue; }
        packId = rawPid;
      } else {
        packId = 'CT' + (startMs || 0) + '_' + endMs + '_' + ((rr.idx != null) ? rr.idx : i);   // 互換合成（残数専用）
      }
      // チケット単価（段階5会計用・列があれば取り込む）。不正値/非数はnull化（NaN混入を防ぐ・M-1）。
      //   単価の妥当性の厳密検証は段階5会計で fail-closed（残数に不要のため段階2/3では停止しない）。
      var unitPrice = null;
      if (cc.ticketPrice >= 0 && r[cc.ticketPrice] !== '' && r[cc.ticketPrice] != null) {
        var _up = Number(r[cc.ticketPrice]); unitPrice = (isFinite(_up) && _up >= 0) ? _up : null;
      }
      // pack種別：契約行の種別が「ペア」ならペアpack（人数回・単価はper person）。通常packとは相互消化しない。
      var pkKind = (type.indexOf('ペア') >= 0 || course.indexOf('ペア') >= 0) ? 'pair' : 'normal';   // 種別orコースに「ペア」＝ペアpack（コース欄でペアを表す運用に対応）
      // 1名来店時の通常単価（ペア専用列）。ペア単価との差額＝1名来店の追加請求。欠損は締めで fail-loud（残数は止めない）。
      var normalUnitPrice = null;
      // 列見出しが曖昧(-2＝「1名来店…単価」が複数)なら、どこに通常単価があるか決められない＝この時点で止める
      //   （締めまで持ち越すと月全体が止まるため、予約可否の段階で fail-closed にする）。
      if (pkKind === 'pair' && cc.normalPrice === -2) { issues.push({ code: 'SCHEMA_AMBIGUOUS', detail: 'row' + i + ' 1名来店単価列が複数' }); }
      if (pkKind === 'pair' && cc.normalPrice >= 0 && r[cc.normalPrice] !== '' && r[cc.normalPrice] != null) {
        var _np = Number(r[cc.normalPrice]); normalUnitPrice = (isFinite(_np) && _np >= 0) ? _np : null;
      }
      packs.push({ packId: packId, qty: qty, availableAt: (startMs != null ? startMs : -8.64e15), expiresAt: expEnd, unitPrice: unitPrice, kind: pkKind, normalUnitPrice: normalUnitPrice });
    } else {
      hasMonthly = true;
      var freq = cc.freq >= 0 ? Number(r[cc.freq] || 0) : 0;
      var rate = (cc.carry >= 0 && Number(r[cc.carry]) > 0) ? Number(r[cc.carry]) : carryRateDefault;
      // 繰越上限の顧客別override（契約マスタ「繰越上限」列）。空欄=頻度テーブル適用。非負整数のみ採用。
      //   1.5・"abc"・-1 等の不正値は黙って丸め/null化せず INVALID_ENTITLEMENT で fail-loud（Codex High）。
      var capOv = null;
      if (cc.carryCap >= 0 && r[cc.carryCap] !== '' && r[cc.carryCap] != null) {
        var _cap = Number(r[cc.carryCap]);
        if (isFinite(_cap) && _cap >= 0 && Math.floor(_cap) === _cap) capOv = _cap;
        else issues.push({ code: 'INVALID_ENTITLEMENT', detail: 'carryCap row' + i + '=' + r[cc.carryCap] });
      }
      // 月額単価（段階5会計用・「単価」欄）。不正/非数はnull（締め時にfail-closed判定）。
      var mUp = null;
      if (cc.ticketPrice >= 0 && r[cc.ticketPrice] !== '' && r[cc.ticketPrice] != null) {
        var _mp = Number(r[cc.ticketPrice]); mUp = (isFinite(_mp) && _mp >= 0) ? _mp : null;
      }
      // 月額は開区間許容（ongoing契約＝serviceTo無しは正当）。startのみ欠損も従来運用で許容。
      monthlyRows.push({ frequency: freq, carryRate: rate, carryCap: capOv, serviceFrom: startMs, serviceTo: endMs, unitPrice: mUp });
    }
  }
  return { entitlements: { monthlyRows: monthlyRows, packs: packs }, hasMonthly: hasMonthly, hasTicket: hasTicket, ticketTotal: ticketTotal, issues: issues };
}

// line_reservations vals（A:K 2次元）＋ customerId → 割当器sessions（本人・confirmed/consumed）
//   session_id は resId(col8=備考の先頭・'|'前の不変部分)で安定化（段階1a）。行順に依存しない＝
//   段階5でbillingが締めスナップショットをsession_idで参照できる。resId欠落の旧行は 'row'+i にフォールバック。
function _lbResvValsToSessions(vals, customerId, parseDate) {
  var out = [];
  for (var i = 0; i < (vals || []).length; i++) {
    var r = vals[i];
    if (String(r[2]) !== String(customerId)) continue;      // col2=customer_id
    var st = String(r[6]); if (st !== 'confirmed' && st !== 'consumed') continue; // col6=status
    var ch = (String(r[9]) === 'transfer') ? 'transfer' : 'line';  // col9=channel
    var dt = parseDate ? parseDate(r[0]) : new Date(r[0]);  // col0=予約日時
    var sidCol = String(r[11] == null ? '' : r[11]).replace(/^\s+|\s+$/g, '');   // col11=専用session_id(不変・H-3)
    var rid = String(r[8] == null ? '' : r[8]).split('|')[0].replace(/^\s+|\s+$/g, '');   // col8=備考(resId・cancel/change後は'|'付き)
    // col13=book_type（'ペア'＝ペアpack消化）・col14=attendee_count（来店人数）。黙って1へ丸めず、そのまま割当器の検証に渡す。
    var bt = String(r[13] == null ? '' : r[13]);
    var pkw = (bt.indexOf('ペア') >= 0) ? 'pair' : 'normal';
    var att = (r[14] === '' || r[14] == null) ? 1 : Number(r[14]);   // 列なし/空＝1（後方互換）
    out.push({ sessionId: sidCol || rid || ('row' + i), resId: rid, startAt: (dt && !isNaN(dt.getTime())) ? dt.getTime() : NaN, channel: ch,
      attendeeCount: att, packKind: pkw, consumptionMode: (pkw === 'pair' ? 'pack' : ''), bookType: bt });
  }
  return out;
}

// 対象月をカバーする月額行の最大frequency（null=カバー行なし・0=freq未設定degraded）
function _lbMonthlyCoverage(monthlyRows, monthKey) {
  var tOrd = _lbMonthOrd(monthKey), covFreq = null;
  for (var m = 0; m < (monthlyRows || []).length; m++) {
    var mr = monthlyRows[m];
    var fO = mr.serviceFrom != null ? _lbMonthOrd(_lbMonthKeyJst(mr.serviceFrom)) : -1e9;
    var tO = mr.serviceTo != null ? _lbMonthOrd(_lbMonthKeyJst(mr.serviceTo)) : 1e9;
    if (tOrd >= fO && tOrd <= tO) { if (covFreq == null || mr.frequency > covFreq) covFreq = mr.frequency; }
  }
  return covFreq;
}

// 表示用残数（純粋）。targetDateMs＝対象日（チケットは対象日に有効なpackのみ計上＝C1表示側）。
function _lbComputeRemaining(customerId, rows, sessions, nowKey, targetDateMs, carryRate, opening, legacyMonthlyFirst, carryFromContractStart) {
  var ent = _lbRowsToEntitlements(rows, carryRate);
  if (opening) {   // 移行棚卸しのopening（cutoverMonth時点の凍結残）を割当器へ＝会員残数と会計を単一の消化モデルに統一
    ent.entitlements.openingCarry = opening.carry || {};
    ent.entitlements.openingPacks = opening.packsUsed || opening.packs || {};
  }
  var tKey = _lbMonthKeyJst(targetDateMs);
  var res = _lbAllocateSessions(String(customerId || 'unknown'), ent.entitlements, sessions,
    { asOfMonth: nowKey, throughMonth: tKey, carryRateDefault: carryRate, cutoverMonth: (opening ? opening.cutoverMonth : undefined),
      legacyMonthlyFirst: (legacyMonthlyFirst === true),
      carryFromContractStart: (carryFromContractStart !== false),
      recordsFromMonth: (opening ? opening.recordsFrom : undefined) });   // 既定＝契約開始月から数える（falseで従来範囲に戻せる）
  var pm = null;
  for (var i = 0; i < res.perMonth.length; i++) if (res.perMonth[i].monthKey === tKey) { pm = res.perMonth[i]; break; }
  // チケット残は「対象日に有効なpack」のみ合計（期限外・開始前は数えない）
  var packDates = {};
  for (var p = 0; p < ent.entitlements.packs.length; p++) { var pk = ent.entitlements.packs[p]; packDates[pk.packId] = pk; }
  var ticketRem = 0, ticketPacks = [], ticketRemPair = 0, ticketRemNormal = 0, pairPackMax = 0;
  for (var j = 0; j < res.perPack.length; j++) {
    var pd = packDates[res.perPack[j].packId];
    if (pd && targetDateMs >= pd.availableAt && targetDateMs <= pd.expiresAt) {
      ticketRem += res.perPack[j].remaining;
      if ((pd.kind || 'normal') === 'pair') {
        ticketRemPair += res.perPack[j].remaining;
        if (res.perPack[j].remaining > pairPackMax) pairPackMax = res.perPack[j].remaining;   // 単一packの最大残＝2名来店の可否素材
      } else ticketRemNormal += res.perPack[j].remaining;
      if (res.perPack[j].remaining > 0) ticketPacks.push({ remaining: res.perPack[j].remaining, expireMs: pd.expiresAt, kind: (pd.kind || 'normal') });   // #3：pack別の残枚数と期限
    }
  }
  ticketPacks.sort(function (a, b) { return a.expireMs - b.expireMs; });   // FEFO＝先に切れる順
  var covFreq = _lbMonthlyCoverage(ent.entitlements.monthlyRows, tKey);
  var monthlyRem;
  if (!ent.hasMonthly) monthlyRem = null;
  else if (covFreq == null) monthlyRem = 0;          // 契約が対象月をカバーしない
  else if (covFreq > 0) monthlyRem = pm ? pm.monthlyRemaining : 0;
  else monthlyRem = null;                            // freq未設定＝degraded無制限
  return { ok: res.ok && ent.issues.length === 0, issues: res.issues.concat(ent.issues),
    hasMonthly: ent.hasMonthly, hasTicket: ent.hasTicket,
    monthlyRem: monthlyRem, ticketTotal: ent.ticketTotal, ticketRem: ticketRem, ticketPacks: ticketPacks,
    ticketRemPair: ticketRemPair, ticketRemNormal: ticketRemNormal, pairPackMax: pairPackMax,   // ペア=人数回残（表示用・可否判定は_lbBookability）
    freq: covFreq || 0, avail: pm ? pm.quota : 0 };
}

// 予約可否判定（純粋・C1/C3の核）：対象日時の仮セッションを割当器に投入し monthly/pack に割り当たるかで判定。
//   excludeStartMs＝変更元の旧セッション開始（そのsessionを除外して判定＝変更の残数中立を正しく評価）。
//   degraded（対象月カバー＆freq未設定）は無制限として probe より優先。
//   attendeeCount/packKind＝ペア予約の来店人数(1/2)と消化先。probeを本番と同一属性で投入するので、
//   「合計残は足りるが単一packに2枚無い」「ペアpackが期限切れで通常packだけ残る」も正しく不可になる。
function _lbBookability(customerId, rows, sessions, nowKey, targetDateMs, carryRate, excludeStartMs, opening, attendeeCount, packKind, carryFromContractStart) {
  var ent = _lbRowsToEntitlements(rows, carryRate);
  if (opening) {   // 移行棚卸しのopeningを反映＝移行残高を超えて予約できないようにする
    ent.entitlements.openingCarry = opening.carry || {};
    ent.entitlements.openingPacks = opening.packsUsed || opening.packs || {};
  }
  var tKey = _lbMonthKeyJst(targetDateMs);
  var covFreq = _lbMonthlyCoverage(ent.entitlements.monthlyRows, tKey);
  var degradedUnlimited = ent.hasMonthly && (covFreq === 0);   // 対象月カバー行あり・freq未設定
  // 旧枠を除外（変更）。同時刻の複数除外を防ぐため、一致する非振替sessionを「1件だけ」除外。
  var base = [], excluded = false;
  for (var i = 0; i < (sessions || []).length; i++) {
    if (!excluded && excludeStartMs != null && sessions[i].startAt === excludeStartMs && sessions[i].channel !== 'transfer') { excluded = true; continue; }
    base.push(sessions[i]);
  }
  var opt = { asOfMonth: nowKey, throughMonth: tKey, carryRateDefault: carryRate, cutoverMonth: (opening ? opening.cutoverMonth : undefined),
    carryFromContractStart: (carryFromContractStart !== false),
    recordsFromMonth: (opening ? opening.recordsFrom : undefined) };   // 残数表示と予約可否で同じ範囲を使う
  function _allocatedCount(list) {
    var res = _lbAllocateSessions(String(customerId || 'unknown'), ent.entitlements, list, opt);
    var n = 0, probeSes = null;
    for (var s = 0; s < res.perSession.length; s++) {
      var ps = res.perSession[s];
      if (ps.alloc === 'monthly' || ps.alloc === 'pack') n++;
      if (ps.sessionId === '__probe__') probeSes = ps;
    }
    return { ok: res.ok, n: n, probeAlloc: probeSes ? probeSes.alloc : null, probe: probeSes };
  }
  // ペア属性の検証（不正はここで打ち切り＝割当器へ不正入力を流さない）
  var wantKind = (packKind === 'pair') ? 'pair' : 'normal';
  var wantUnits = (attendeeCount == null || attendeeCount === '') ? 1 : Number(attendeeCount);
  if (!(wantUnits === 1 || wantUnits === 2) || (wantUnits === 2 && wantKind !== 'pair')) {
    return { ok: false, issues: ent.issues.concat([{ code: 'INVALID_ATTENDEE_COUNT', detail: String(attendeeCount) }]),
      canBook: false, consumeType: '', degradedUnlimited: false, code: 'INVALID_ATTENDEE_COUNT' };
  }
  var before = _allocatedCount(base);
  var probe = { sessionId: '__probe__', startAt: targetDateMs, channel: 'line',
    attendeeCount: wantUnits, packKind: wantKind, consumptionMode: (wantKind === 'pair' ? 'pack' : '') };
  var after = _allocatedCount(base.concat([probe]));
  // 純増判定：probe追加で割当総数がちょうど+1（＝誰も押し出さずに実際に1枠増える）なら予約可。
  //   ペアは加えて「ペアpackへ人数ぶん割り当たったこと」を要求（合計残での通過を防ぐ）。
  var canBook, consumeType;
  if (degradedUnlimited && wantKind !== 'pair') { canBook = true; consumeType = 'monthly'; }   // ペアはdegraded無制限の対象外（pack必須）
  else {
    canBook = (after.n === before.n + 1);
    if (canBook && wantKind === 'pair') {
      var pp = after.probe;
      canBook = !!(pp && pp.alloc === 'pack' && (pp.units == null ? 1 : pp.units) === wantUnits && (pp.packKind || 'normal') === 'pair');
    }
    consumeType = canBook ? (after.probeAlloc === 'monthly' ? 'monthly' : (after.probeAlloc === 'pack' ? 'ticket' : '')) : '';
  }
  return { ok: after.ok && ent.issues.length === 0, issues: ent.issues,
    canBook: canBook, consumeType: consumeType, degradedUnlimited: (degradedUnlimited && wantKind !== 'pair') };
}

// ═══ 段階5-2：会計projection（純粋・Node検証可・H-1境界）＝残数projectionと厳密に分ける ═══
//   会計は「実施済(過去confirmed)＋consumed」のみ。**未来confirmedは実施でないので除外**（残数は含めるが会計は含めない）。
//   当日キャンセル(consumed)は不変の実施イベント。振替はchannel保持で分離（billingが手動請求）。cutoffMs=会計基準時刻(JST)。
//   session_idは安定(resId基準)。返り値に status/trainerId/startAt を持たせ、締めrunのdetail/報酬に使う。
function _lbBuildAccountingProjection(vals, customerId, cutoffMs, parseDate) {
  var out = [], issues = [], seen = {};
  if (!(typeof cutoffMs === 'number' && isFinite(cutoffMs))) issues.push({ code: 'INVALID_CUTOFF', detail: '' });
  for (var i = 0; i < (vals || []).length; i++) {
    var r = vals[i];
    if (String(r[2]) !== String(customerId)) continue;      // col2=customer_id
    var st = String(r[6]);                                    // col6=status
    if (st !== 'confirmed' && st !== 'consumed') continue;
    var dt = parseDate ? parseDate(r[0]) : new Date(r[0]);   // col0=予約日時
    var startAt = (dt && !isNaN(dt.getTime())) ? dt.getTime() : NaN;
    if (!(typeof startAt === 'number' && isFinite(startAt))) { issues.push({ code: 'INVALID_START_AT', detail: 'row' + i }); }
    // 未来confirmedは会計対象外（まだ実施していない）。consumedは常に会計対象（不変な実施イベント）。
    if (st === 'confirmed' && (!(typeof startAt === 'number' && isFinite(startAt)) || (typeof cutoffMs === 'number' && startAt > cutoffMs))) continue;
    var ch = (String(r[9]) === 'transfer') ? 'transfer' : 'line';   // col9=channel
    var sidCol = String(r[11] == null ? '' : r[11]).replace(/^\s+|\s+$/g, '');   // col11=専用session_id(不変・H-3)
    var rid = String(r[8] == null ? '' : r[8]).split('|')[0].replace(/^\s+|\s+$/g, '');   // col8=備考(resId)
    var sid = sidCol || rid || ('row' + i);
    if (!sidCol && !rid) issues.push({ code: 'SESSION_ID_FALLBACK', detail: 'row' + i });   // 専用列もresIdも無い＝締めキー不可（この月は締め禁止）
    if (seen[sid]) issues.push({ code: 'DUPLICATE_SESSION_ID', detail: sid }); else seen[sid] = true;
    var trId = String(r[4] == null ? '' : r[4]);              // col4=trainer_id
    // ★ペア：来店人数(col14)と消化種別(col13 book_type)を会計へ貫通させる（落とすと2名来店が1名消化に巻き戻る）。
    var bt2 = String(r[13] == null ? '' : r[13]);
    var pk2 = (bt2.indexOf('ペア') >= 0) ? 'pair' : 'normal';
    var at2 = (r[14] === '' || r[14] == null) ? 1 : Number(r[14]);
    out.push({ sessionId: sid, resId: rid, startAt: startAt, channel: ch, status: st, trainerId: trId,
      attendeeCount: at2, packKind: pk2, consumptionMode: (pk2 === 'pair' ? 'pack' : ''), bookType: bt2 });
  }
  return { sessions: out, issues: issues };
}

// ═══ 段階5準備：版付き割当結果レコード生成（純粋・Node検証可）＝billingが読む"確定した割当" ═══
//   会計は「消化(実施)時点×単価」で認識（design §4-A）。sessionsは呼び出し側が会計projection
//   （実施済+consumed・振替除外は割当器が担当）で渡す。カレンダータイトルを会計根拠にしない（§1）。
//   戻り値：月ごとのレコード配列。billingはこれを customer_id×month_key で読み、金額を算出する。
function _lbBuildAllocationRecords(customerId, contractRows, sessions, asOfMonthKey, carryRate) {
  var ent = _lbRowsToEntitlements(contractRows, carryRate);
  // 会計は確定済み(過去)月を対象。asOfは最新月以上にして未来月ゼロ化を無効化＝繰越を全月正常に流す。
  var asOf = asOfMonthKey;
  if (!asOf) {
    var maxMs = null;
    for (var q = 0; q < (sessions || []).length; q++) { var sa = sessions[q].startAt; if (typeof sa === 'number' && isFinite(sa) && (maxMs == null || sa > maxMs)) maxMs = sa; }
    asOf = (maxMs != null) ? _lbMonthKeyJst(maxMs) : null;
  }
  var res = _lbAllocateSessions(String(customerId || 'unknown'), ent.entitlements, sessions, { asOfMonth: asOf, carryRateDefault: carryRate });
  var priceByPack = {};
  for (var p = 0; p < ent.entitlements.packs.length; p++) priceByPack[ent.entitlements.packs[p].packId] = ent.entitlements.packs[p].unitPrice;
  // 月ごとに集計
  var byMonth = {};
  for (var s = 0; s < res.perSession.length; s++) {
    var ps = res.perSession[s];
    if (ps.alloc === 'transfer') continue;   // 振替は独立利用権（会計は別途手動請求）
    var mk = ps.monthKey; if (!mk) { mk = '_invalid'; }
    if (!byMonth[mk]) byMonth[mk] = { monthKey: mk, customerId: String(customerId || ''), monthlyConsumed: 0, ticket: {}, unallocated: 0 };
    if (ps.alloc === 'monthly') byMonth[mk].monthlyConsumed++;
    else if (ps.alloc === 'pack') { var pid = ps.packId; byMonth[mk].ticket[pid] = (byMonth[mk].ticket[pid] || 0) + 1; }
    else byMonth[mk].unallocated++;
  }
  var records = [];
  for (var k in byMonth) {
    if (!byMonth.hasOwnProperty(k)) continue;
    var rec = byMonth[k];
    var ticketLines = [];
    var tk = Object.keys(rec.ticket).sort();
    for (var t = 0; t < tk.length; t++) ticketLines.push({ packId: tk[t], unitPrice: (priceByPack[tk[t]] == null ? null : priceByPack[tk[t]]), count: rec.ticket[tk[t]] });
    records.push({ monthKey: rec.monthKey, customerId: rec.customerId, monthlyConsumed: rec.monthlyConsumed,
      ticketLines: ticketLines, unallocated: rec.unallocated,
      logicVersion: res.logicVersion, inputHash: res.inputHash, ok: res.ok && ent.issues.length === 0 });
  }
  records.sort(function (a, b) { return a.monthKey < b.monthKey ? -1 : (a.monthKey > b.monthKey ? 1 : 0); });
  return records;
}

// ═══ 段階5-3：締めrun純粋builder（Node検証可）＝session明細＋carry/pack凍結＋単価snapshot＋trainer別 ═══
//   opening={carry:{monthKey:n}, packs:{packId:used}, cutoverMonth:'YYYY-MM'}（前締め月の閉状態 or cutover棚卸し）。
//   sessions=会計projection（実施済+consumed・trainerId付き）。billingはこの記録から売上/報酬を算出（現在フォームを引き直さない）。
//   closeMonth＝締める対象月(単月締め)。sessionsは cutoverMonth..closeMonth の会計projection（呼び出し側でcutoff=closeMonth末）。
//   projectionIssues＝projectionが返したissue（cutoff不正・重複session等）を締めに合流。
//   戻り値：record(closeMonth単月)＋closing{carryNext,packsUsed}(翌月opening用・packは"使用済枚数")＋ok/issues。
function _lbBuildCloseRun(customerId, contractRows, sessions, opening, closeMonth, carryRate, projectionIssues) {
  opening = opening || {};
  var ent = _lbRowsToEntitlements(contractRows, carryRate);
  var issues = (ent.issues || []).concat(projectionIssues || []);
  // 対象月(closeMonth)以降のsessionは締めから除外（closingのpack使用数を将来月で汚さない）。
  var closeOrd = _lbMonthOrd(closeMonth);
  var useSessions = [];
  for (var f = 0; f < (sessions || []).length; f++) {
    var fs = sessions[f], fsa = fs.startAt;
    if (typeof fsa === 'number' && isFinite(fsa) && _lbMonthOrd(_lbMonthKeyJst(fsa)) > closeOrd) continue;   // 未来月は締め対象外
    useSessions.push(fs);
  }
  var trainerBySid = {}, startBySid = {}, statusBySid = {}, channelBySid = {};
  for (var s = 0; s < useSessions.length; s++) { var se = useSessions[s]; trainerBySid[se.sessionId] = se.trainerId || ''; startBySid[se.sessionId] = se.startAt; statusBySid[se.sessionId] = se.status || ''; channelBySid[se.sessionId] = se.channel || ''; }
  var res = _lbAllocateSessions(String(customerId || 'unknown'),
    { monthlyRows: ent.entitlements.monthlyRows, packs: ent.entitlements.packs, openingCarry: opening.carry || {}, openingPacks: opening.packsUsed || opening.packs || {} },
    useSessions, { asOfMonth: closeMonth, cutoverMonth: opening.cutoverMonth, carryRateDefault: carryRate });
  issues = issues.concat(res.issues || []);   // allocator自身のissueも締めに合流

  var packPrice = {}, packNormalPrice = {}, packKindById = {};
  for (var p = 0; p < ent.entitlements.packs.length; p++) {
    var _pk = ent.entitlements.packs[p];
    packPrice[_pk.packId] = _pk.unitPrice;                    // 通常＝1回単価／ペア＝1名あたり単価
    packNormalPrice[_pk.packId] = (_pk.normalUnitPrice == null ? null : _pk.normalUnitPrice);   // ペアの1名来店時の通常単価
    packKindById[_pk.packId] = _pk.kind || 'normal';
  }
  // covering月額行の単価。同一max serviceFromで単価が割れたら曖昧＝fail-loud。
  function monthlyPriceFor(monthKey) {
    var ord = _lbMonthOrd(monthKey), bestFrom = -1e18, price = null, ambiguous = false, found = false;
    for (var m = 0; m < ent.entitlements.monthlyRows.length; m++) {
      var mr = ent.entitlements.monthlyRows[m];
      var fO = mr.serviceFrom != null ? _lbMonthOrd(_lbMonthKeyJst(mr.serviceFrom)) : -1e9;
      var tO = mr.serviceTo != null ? _lbMonthOrd(_lbMonthKeyJst(mr.serviceTo)) : 1e9;
      if (ord < fO || ord > tO) continue;
      if (fO > bestFrom) { bestFrom = fO; price = (mr.unitPrice == null ? null : mr.unitPrice); found = true; ambiguous = false; }
      else if (fO === bestFrom && found && mr.unitPrice !== price) ambiguous = true;
    }
    return { price: found ? price : null, ambiguous: ambiguous, hasMonthly: found };
  }

  // closeMonth単月の明細集計
  var mp = monthlyPriceFor(closeMonth);
  var det = [], monthlyConsumed = 0, ticket = {}, unalloc = 0, transfer = 0, trainer = {}, trainerMissing = false;
  for (var i = 0; i < res.perSession.length; i++) {
    var ps = res.perSession[i]; if (ps.monthKey !== closeMonth) continue;
    var tr = trainerBySid[ps.sessionId] || '';
    function _tr() { if (!trainer[tr]) trainer[tr] = { monthly: 0, ticket: 0 }; return trainer[tr]; }
    var d = { sessionId: ps.sessionId, alloc: ps.alloc, trainerId: tr, channel: channelBySid[ps.sessionId] || '', startAt: (startBySid[ps.sessionId] != null ? startBySid[ps.sessionId] : null), status: statusBySid[ps.sessionId] || '' };
    if (ps.alloc !== 'unallocated' && !tr) trainerMissing = true;   // 報酬計算にtrainer必須
    if (ps.alloc === 'transfer') { transfer++; }
    else if (ps.alloc === 'monthly') { monthlyConsumed++; _tr().monthly++; d.unitPriceSnapshot = mp.price; }
    else if (ps.alloc === 'pack') {
      var _u = (ps.units != null ? ps.units : 1);                                   // 消化枚数（ペア2名=2・1名=1）
      var _k = ps.packKind || packKindById[ps.packId] || 'normal';
      var _pu = (packPrice[ps.packId] == null ? null : packPrice[ps.packId]);       // ペア＝1名あたり単価
      var _nu = (packNormalPrice[ps.packId] == null ? null : packNormalPrice[ps.packId]);
      if (!ticket[ps.packId]) ticket[ps.packId] = { count: 0, units: 0, kind: _k };
      ticket[ps.packId].count++; ticket[ps.packId].units += _u;
      _tr().ticket++; d.packId = ps.packId; d.units = _u; d.packKind = _k;
      if (_k === 'pair') {
        // 認識売上＝2名来店:ペア単価×2／1名来店:通常単価(=ペア単価+差額)。根拠はdetailに全部残す（後から検算可能に）。
        d.pairUnitPriceSnapshot = _pu; d.normalUnitPriceSnapshot = _nu;
        if (_u === 2) { d.unitPriceSnapshot = (_pu == null ? null : _pu * 2); d.surchargeSnapshot = 0; }
        else {
          d.unitPriceSnapshot = _nu;
          d.surchargeSnapshot = (_nu == null || _pu == null) ? null : (_nu - _pu);
          if (_nu == null) issues.push({ code: 'PAIR_NORMAL_PRICE_MISSING', detail: ps.packId });   // 1名来店の差額算定不能＝締めない
          else if (_pu != null && _nu < _pu) issues.push({ code: 'PAIR_PRICE_INCONSISTENT', detail: ps.packId + ' 通常単価<ペア単価' });
        }
      } else d.unitPriceSnapshot = _pu;
    }
    else { unalloc++; d.reason = ps.reason; }
    det.push(d);
  }
  var pmv = null; for (var pm = 0; pm < res.perMonth.length; pm++) if (res.perMonth[pm].monthKey === closeMonth) { pmv = res.perMonth[pm]; break; }
  if (trainerMissing) issues.push({ code: 'TRAINER_MISSING', detail: closeMonth });
  var ticketLines = [], tks = Object.keys(ticket).sort();
  for (var t = 0; t < tks.length; t++) {
    var up = (packPrice[tks[t]] == null ? null : packPrice[tks[t]]);
    // count＝session件数（明細⇔集計の整合検証キー・従来通り）／units＝消化枚数合計（ペアで count と乖離する）
    ticketLines.push({ packId: tks[t], unitPrice: up, count: ticket[tks[t]].count, units: ticket[tks[t]].units, kind: ticket[tks[t]].kind });
    if (up == null) issues.push({ code: 'TICKET_PRICE_MISSING', detail: tks[t] });
  }

  // fail-closed材料：単価欠損・曖昧・未割当・0件でない月額なのに単価null
  if (mp.ambiguous) issues.push({ code: 'MONTHLY_PRICE_AMBIGUOUS', detail: closeMonth });
  if (monthlyConsumed > 0 && mp.price == null) issues.push({ code: 'MONTHLY_PRICE_MISSING', detail: closeMonth });
  if (unalloc > 0) issues.push({ code: 'UNALLOCATED_SESSION', detail: closeMonth });

  var record = { monthKey: closeMonth, customerId: String(customerId || ''),
    canonicalVersion: LB_ALLOC_CANONICAL_VERSION,   // 新規締めは新canonical（既存alloc-1記録はこの欄が無く旧canonicalで検証され続ける）
    monthlyConsumed: monthlyConsumed, monthlyUnitPrice: mp.price,
    carryIn: (pmv && pmv.carryIn != null ? pmv.carryIn : 0), carryOut: (pmv && pmv.carryOut != null ? pmv.carryOut : 0),
    ticketLines: ticketLines, transferCount: transfer, unallocated: unalloc,
    trainerBreakdown: trainer, details: det };

  // closing：翌月opening用。pack は"使用済枚数"(=qty-remaining)で返す（openingPacksがusedを期待するため復活を防ぐ）。
  var packsUsed = {};
  for (var pr = 0; pr < res.perPack.length; pr++) packsUsed[res.perPack[pr].packId] = res.perPack[pr].used;
  var nextOrd = _lbMonthOrd(closeMonth) + 1;
  var closing = { carry: {}, packsUsed: packsUsed, cutoverMonth: _lbOrdToKey(nextOrd) };   // 次月opening用（packsUsed=使用済枚数・別名廃止でchecksum死角を無くす）
  closing.carry[_lbOrdToKey(nextOrd)] = record.carryOut;

  return { customerId: String(customerId || ''), closeMonth: closeMonth, record: record, closing: closing,
    logicVersion: res.logicVersion, inputHash: res.inputHash, ok: (res.ok && issues.length === 0), issues: issues };
}

// cutover月1日00:00 JST（openingの評価時点＝この時刻より前の残を凍結）。
function _lbFirstOfMonthMsJst(monthKey) {
  var y = parseInt(String(monthKey).slice(0, 4), 10), m = parseInt(String(monthKey).slice(5, 7), 10);
  return Date.UTC(y, m - 1, 1) - 9 * 3600000;   // 00:00 JST = UTC前日15:00
}
// cutover月に有効(covering)な月額行から頻度・carryRateを取る（serviceFrom/To・最新from優先・曖昧はfail-loud）。
function _lbMonthlyCoverAtCutover(monthlyRows, monthKey, carryRateDefault) {
  var ord = _lbMonthOrd(monthKey), bestFrom = -1e18, chosen = null, ambiguous = false;
  for (var i = 0; i < (monthlyRows || []).length; i++) {
    var mr = monthlyRows[i];
    var fO = mr.serviceFrom != null ? _lbMonthOrd(_lbMonthKeyJst(mr.serviceFrom)) : -1e9;
    var tO = mr.serviceTo != null ? _lbMonthOrd(_lbMonthKeyJst(mr.serviceTo)) : 1e9;
    if (ord < fO || ord > tO) continue;
    if (fO > bestFrom) { bestFrom = fO; chosen = mr; ambiguous = false; }
    else if (fO === bestFrom && chosen && (mr.frequency !== chosen.frequency ||
      _lbResolveCarryCap(mr.frequency, mr.carryCap, mr.carryRate) !== _lbResolveCarryCap(chosen.frequency, chosen.carryCap, chosen.carryRate))) ambiguous = true;   // 実効capで比較（Codex Medium）
  }
  if (!chosen) return { has: false, frequency: 0, carryRate: carryRateDefault, carryCap: null, ambiguous: false };
  var rate = (chosen.carryRate == null) ? carryRateDefault : chosen.carryRate;
  return { has: true, frequency: Number(chosen.frequency || 0), carryRate: rate, carryCap: (chosen.carryCap != null ? chosen.carryCap : null), ambiguous: ambiguous };
}

// cutover棚卸し → opening構築（純粋・Node検証可）。会計の最上流の根。決定0042のCodex10ゲートを実装。
//   inv: { customerId: { name, monthly:{status, carry}, packs:{ packId:{status, remaining} } } }
//     status: 'input'(数値入力) / 'zero'(確認済み0) / 'na'(対象外・期限切れ承認) / 'blank'(未入力)。blank≠0を厳守。
//   entByCustomer: { customerId: {monthlyRows, packs} }（_lbRowsToEntitlements の entitlements）
//   monthKey: cutover月 'YYYY-MM'。opening＝この月1日00:00 JST時点の凍結残。
//   返り値: { ok, opening:{cid:{carry:{monthKey:n}, packsUsed:{packId:used}, cutoverMonth}}, issues, breakdown, blockingCount }
function _lbBuildCutoverOpening(inv, entByCustomer, monthKey, carryRateDefault) {
  inv = inv || {}; entByCustomer = entByCustomer || {};
  if (carryRateDefault == null) carryRateDefault = 1;
  if (!_lbValidMonthKey(monthKey)) return { ok: false, opening: {}, issues: [{ customerId: '', code: 'BAD_MONTH', detail: String(monthKey) }], breakdown: [], blockingCount: 1 };
  var cutoverMs = _lbFirstOfMonthMsJst(monthKey);
  var opening = {}, issues = [], breakdown = [];
  function err(cid, code, detail) { issues.push({ customerId: cid, code: code, detail: detail, severity: 'error' }); }
  function warn(cid, code, detail) { issues.push({ customerId: cid, code: code, detail: detail, severity: 'warning' }); }

  var cids = Object.keys(entByCustomer).sort();
  for (var c = 0; c < cids.length; c++) {
    var cid = cids[c], ent = entByCustomer[cid] || {}, row = inv[cid] || null;
    var cover = _lbMonthlyCoverAtCutover(ent.monthlyRows || [], monthKey, carryRateDefault);
    var packs = ent.packs || [];
    var bk = { customerId: cid, name: (row && row.name) || '', monthly: null, packs: [] };
    var carryMap = {}, packsUsed = {};

    // ---- 契約entitlementの不正（繰越上限等の不正値）＝この会員をfail-closed（黙って正常扱いしない・Codex）----
    if (ent._entIssues && ent._entIssues.length) {
      for (var ei = 0; ei < ent._entIssues.length; ei++) err(cid, 'CONTRACT_ENTITLEMENT_INVALID', cid + ' ' + ent._entIssues[ei].code + ':' + ent._entIssues[ei].detail);
    }

    // ---- 会員未棚卸し（entitlementはあるがinv行が無い）＝完全性違反（silent carry=0を防ぐ）----
    //   ただし契約(月額freq>0/pack)が全く無い会員＝移行対象外（トレーナー/テスト登録・契約終了）→エラーにせずスキップ。
    if (!row) {
      var _hasEnt = (cover.has && cover.frequency > 0) || packs.length > 0;
      if (!_hasEnt) continue;
      err(cid, 'MEMBER_NOT_INVENTORIED', cid); breakdown.push(bk); continue;
    }

    // ---- 月額 ----
    if (cover.has && cover.frequency > 0) {
      var cap = _lbResolveCarryCap(cover.frequency, cover.carryCap, cover.carryRate);   // 頻度テーブル＋顧客override（棚卸し画面表示と同一・旧floor×率の食い違い是正・Codex Critical）
      var mo = row.monthly || { status: 'blank' };
      bk.monthly = { frequency: cover.frequency, carryRate: cover.carryRate, carryCap: (cover.carryCap != null ? cover.carryCap : null), cap: cap, status: mo.status, carry: null };
      if (cover.ambiguous) err(cid, 'MONTHLY_COVER_AMBIGUOUS', monthKey);
      if (mo.status === 'blank') err(cid, 'CARRY_BLANK', cid + ' 月額繰越が未入力（0なら確認済み0を選択）');
      else if (mo.status === 'na') err(cid, 'MONTHLY_NA_CONTRADICTS_CONTRACT', cid + ' 契約は月額だが対象外指定');
      else {
        var carry = (mo.status === 'zero') ? 0 : Number(mo.carry);
        if (!_lbIsNonNegInt(carry)) err(cid, 'CARRY_INVALID', cid + ' 繰越=' + mo.carry);
        else if (carry > cap) err(cid, 'CARRY_EXCEEDS_CAP', cid + ' 繰越' + carry + ' > 上限' + cap + '（黙って切らない。繰越上限テーブル/繰越上限列を確認）');
        else { carryMap[monthKey] = carry; bk.monthly.carry = carry; }
      }
    } else if (row.monthly && row.monthly.status === 'input' && Number(row.monthly.carry) > 0) {
      err(cid, 'CARRY_WITHOUT_MONTHLY', cid + ' 月額契約なしに繰越入力');   // 併用取り違えの検知
    }

    // ---- pack（チケット）----
    var invPacks = (row.packs || {});
    var entPackIds = {};
    for (var p = 0; p < packs.length; p++) {
      var pk = packs[p], pid = pk.packId; entPackIds[pid] = true;
      var pr = invPacks[pid] || { status: 'blank' };
      var expired = (pk.expiresAt != null && pk.expiresAt < cutoverMs);
      var pb = { packId: pid, qty: pk.qty, expiresAt: pk.expiresAt, expired: expired, unitPrice: pk.unitPrice, status: pr.status, remaining: null, used: null };
      if (pr.status === 'blank') err(cid, 'PACK_ROW_MISSING', cid + '/' + pid + ' 残枚数が未入力');
      else if (pr.status === 'na') { packsUsed[pid] = pk.qty; pb.remaining = 0; pb.used = pk.qty; warn(cid, 'PACK_MARKED_NA', cid + '/' + pid + ' 対象外＝残0扱い'); }
      else {
        var rem = (pr.status === 'zero') ? 0 : Number(pr.remaining);
        if (!_lbIsNonNegInt(rem) || rem > pk.qty) err(cid, 'PACK_REMAINING_INVALID', cid + '/' + pid + ' 残=' + pr.remaining + ' (qty=' + pk.qty + ')');
        else {
          packsUsed[pid] = pk.qty - rem; pb.remaining = rem; pb.used = pk.qty - rem;
          if (expired && rem > 0) err(cid, 'EXPIRED_PACK_HAS_REMAINING', cid + '/' + pid + ' 期限切れpackに残' + rem + '（対象外指定 or 残0へ）');
        }
      }
      bk.packs.push(pb);
    }
    // inv側に契約外のpackId＝未知/取り違えの疑い（silentに全会計を壊す）
    for (var ip in invPacks) if (invPacks.hasOwnProperty(ip) && !entPackIds[ip]) err(cid, 'PACK_UNKNOWN', cid + '/' + ip + ' 契約に無いpackId');

    opening[cid] = { carry: carryMap, packsUsed: packsUsed, cutoverMonth: monthKey };
    breakdown.push(bk);
  }

  // inv側にentitlement外のcustomer＝棚卸し対象取り違え
  for (var ivc in inv) if (inv.hasOwnProperty(ivc) && !entByCustomer[ivc]) err(ivc, 'CUSTOMER_NOT_IN_SCOPE', ivc + ' はcutover対象外');

  var blocking = 0; for (var e = 0; e < issues.length; e++) if (issues[e].severity === 'error') blocking++;
  return { ok: blocking === 0, opening: opening, issues: issues, breakdown: breakdown, blockingCount: blocking };
}

// 締め記録 → LINE会員の売上・トレーナー報酬（純粋・Node検証可）。billングがCLOSED記録から会計を算出する核。
//   売上＝消化×単価snapshot（発生主義の管理会計）。報酬＝各セッションの売上×報酬割合、担当トレーナー別。
//   rewardRate＝顧客マスタの報酬割合(%)。単価null/未割当があれば issues（会計はfail-loud）。振替・入会金・紹介は別計上。
function _lbRevenueFromRecord(record, rewardRate) {
  record = record || {};
  var rate = (typeof rewardRate === 'number' && isFinite(rewardRate) && rewardRate >= 0) ? rewardRate : null;
  var issues = [];
  var mp = record.monthlyUnitPrice;
  var monthlyRevenue = 0, ticketRevenue = 0, rewardByTrainer = {};
  var details = record.details || [];
  var monthlyCnt = 0, packCnt = {};   // 明細⇔集計の整合検証用
  for (var i = 0; i < details.length; i++) {
    var d = details[i];
    if (d.alloc === 'transfer' || d.alloc === 'unallocated') continue;   // 振替=別請求／未割当=会計対象外(締めで既にfail-closed材料)
    if (d.alloc !== 'monthly' && d.alloc !== 'pack') { issues.push({ code: 'UNKNOWN_ALLOC', detail: String(d.alloc) }); continue; }   // 未知種別=会計不能
    var price = (d.alloc === 'monthly') ? mp : d.unitPriceSnapshot;
    if (price == null) { issues.push({ code: 'PRICE_MISSING', detail: String(d.sessionId) }); continue; }
    if (!(typeof price === 'number' && isFinite(price) && price >= 0)) { issues.push({ code: 'PRICE_INVALID', detail: String(d.sessionId) }); continue; }
    if (d.alloc === 'monthly') { monthlyRevenue += price; monthlyCnt++; }
    else { ticketRevenue += price; packCnt[d.packId] = (packCnt[d.packId] || 0) + 1; }
    if (rate != null) {
      var tr = String(d.trainerId || '');
      if (!tr) { issues.push({ code: 'TRAINER_MISSING', detail: String(d.sessionId) }); }
      else { if (!rewardByTrainer[tr]) rewardByTrainer[tr] = 0; rewardByTrainer[tr] += Math.floor(price * rate / 100); }
    }
  }
  // 明細⇔集計の内部整合（記録破損/改ざん検知）：monthlyConsumed と ticketLines が明細と一致するか
  if (record.monthlyConsumed != null && record.monthlyConsumed !== monthlyCnt) issues.push({ code: 'DETAIL_MISMATCH_MONTHLY', detail: String(record.monthlyConsumed) + '!=' + monthlyCnt });
  var tls = record.ticketLines || [];
  for (var tlx = 0; tlx < tls.length; tlx++) if ((packCnt[tls[tlx].packId] || 0) !== tls[tlx].count) issues.push({ code: 'DETAIL_MISMATCH_TICKET', detail: String(tls[tlx].packId) });
  if (rate == null && (monthlyRevenue > 0 || ticketRevenue > 0)) issues.push({ code: 'REWARD_RATE_MISSING', detail: String(record.customerId || '') });
  return { customerId: String(record.customerId || ''), monthKey: String(record.monthKey || ''),
    monthlyRevenue: monthlyRevenue, ticketRevenue: ticketRevenue, totalRevenue: monthlyRevenue + ticketRevenue,
    rewardByTrainer: rewardByTrainer, transferCount: record.transferCount || 0, issues: issues, ok: issues.length === 0 };
}

// billing本番載せ替え2b（純粋・Node検証可・決定0043）：CLOSED記録のsession群→カレンダーeventID除外集合を構築。
//   氏名でなくID接合。未linkのsession（col13空）はfail-loud（=旧経路で二重計上する危険を止める）。
//   closedRecords: [{customerId, details:[{sessionId, alloc}]}]（alloc=monthly/pack/transfer/unallocated）
//   sessionEventMap: { sessionId: calendarEventId }（line_reservations col12→col13）
//   返り値: { excludeEventIds:{eventId:true}, issues:[{code,customerId,detail}], sessionCount, linkedCount, ok }
//   ★除外対象は alloc=monthly/pack のみ（＝CLOSEDが売上を注入する分）。transfer(振替=手動請求)・unallocated は
//   カレンダー経路のまま維持し除外しない（Codexゲート3：項目の巻き込み消失を防ぐ）。monthly/packは要link（未linkはfail-loud）。
function _lbBuildSessionExclusion(closedRecords, sessionEventMap) {
  closedRecords = closedRecords || []; sessionEventMap = sessionEventMap || {};
  var exclude = {}, issues = [], sessionCount = 0, linked = 0, skippedNonRev = 0, seenEvent = {};
  for (var r = 0; r < closedRecords.length; r++) {
    var rec = closedRecords[r] || {}, cid = String(rec.customerId || ''), det = rec.details || [];
    for (var d = 0; d < det.length; d++) {
      var alloc = String(det[d].alloc || '');
      if (alloc !== 'monthly' && alloc !== 'pack') { skippedNonRev++; continue; }   // 振替・未割当はカレンダー経路のまま
      var sid = String(det[d].sessionId || ''); if (!sid) { issues.push({ code: 'DETAIL_NO_SESSION_ID', customerId: cid, detail: 'record' + r }); continue; }
      sessionCount++;
      var ev = sessionEventMap.hasOwnProperty(sid) ? String(sessionEventMap[sid] || '') : '';
      if (!ev) { issues.push({ code: 'UNLINKED_SESSION', customerId: cid, detail: sid + '（col13空＝eventID未記録。backfill必須）' }); continue; }
      if (seenEvent[ev]) { issues.push({ code: 'DUP_EVENT_LINK', customerId: cid, detail: ev + ' が複数sessionに紐付く' }); continue; }
      seenEvent[ev] = true; exclude[ev] = true; linked++;
    }
  }
  return { excludeEventIds: exclude, issues: issues, sessionCount: sessionCount, linkedCount: linked, skippedNonRev: skippedNonRev, ok: issues.length === 0 };
}

// billing載せ替え2b注入（純粋・Node検証可・決定0043）：CLOSED記録→billing明細行の材料を生成。
//   monthly/packのsessionだけを明細化（振替等は対象外＝除外もしないのでカレンダー経路が計上）。
//   meta[cid] = { name, contentType(月額会員の表示種別 通常/モニター/レンタル), rewardRate(%) }
//   trainerNameById = { trainerId: billing表示名 }（line_trainers→billing名。未対応は TRAINER_UNMAPPED でfail-loud）
//   返り値: { rows:[{startAt, contentType, trainerName, clientName, unitPrice, rewardRate, rewardAmount}],
//            issues, monthlyRevenue, ticketRevenue, rewardByTrainer, ok }
function _lbBuildLineInjectionRows(closedRecords, meta, trainerNameById) {
  closedRecords = closedRecords || []; meta = meta || {}; trainerNameById = trainerNameById || {};
  var rows = [], issues = [], mRev = 0, tRev = 0, rewardByTrainer = {};
  for (var r = 0; r < closedRecords.length; r++) {
    var rec = closedRecords[r] || {}, cid = String(rec.customerId || ''), det = rec.details || [];
    var mt = meta[cid] || {}, cname = String(mt.name || ''), rate = mt.rewardRate;
    for (var d = 0; d < det.length; d++) {
      var alloc = String(det[d].alloc || ''); if (alloc !== 'monthly' && alloc !== 'pack') continue;
      if (!(typeof det[d].startAt === 'number' && isFinite(det[d].startAt))) { issues.push({ code: 'INVALID_STARTAT', customerId: cid, detail: String(det[d].sessionId || '') }); continue; }   // 日付欠損は店舗売上だけ乗りトレーナー報酬から落ちる（Codex#3）
      var tid = String(det[d].trainerId || '');
      var tname = trainerNameById.hasOwnProperty(tid) ? String(trainerNameById[tid] || '') : '';
      if (!tname) { issues.push({ code: 'TRAINER_UNMAPPED', customerId: cid, detail: tid + '（line_trainers→billing名の対応なし）' }); continue; }
      var price = det[d].unitPriceSnapshot;
      if (price == null || !(typeof price === 'number' && isFinite(price))) { issues.push({ code: 'PRICE_MISSING', customerId: cid, detail: alloc + ' ' + String(det[d].sessionId || '') }); continue; }
      if (rate == null || !(typeof rate === 'number' && isFinite(rate))) { issues.push({ code: 'RATE_MISSING', customerId: cid, detail: cname }); continue; }
      // 月額の表示種別は 通常/モニター のみ許容。レンタル等は店舗売上計算(count×2000で単価無視・報酬符号逆)と齟齬＝fail-loud（Codex#2）
      if (alloc === 'monthly' && mt.contentType !== '通常' && mt.contentType !== 'モニター') { issues.push({ code: 'MONTHLY_TYPE_INVALID', customerId: cid, detail: cname + '＝' + String(mt.contentType) }); continue; }
      var contentType = (alloc === 'pack') ? 'チケット' : (mt.contentType || '通常');
      var rewardAmount = Math.floor(price * rate / 100);
      rows.push({ startAt: det[d].startAt, contentType: contentType, trainerName: tname, clientName: cname,
        unitPrice: price, rewardRate: rate, rewardAmount: rewardAmount });
      if (alloc === 'pack') tRev += price; else mRev += price;
      rewardByTrainer[tname] = (rewardByTrainer[tname] || 0) + rewardAmount;
    }
  }
  return { rows: rows, issues: issues, monthlyRevenue: mRev, ticketRevenue: tRev, rewardByTrainer: rewardByTrainer, ok: issues.length === 0 };
}

// 締め記録の正規化文字列（純粋・決定論的）＝checksumの素。金額全項目＋closing（次月opening）も含める
//   （closingを改変すると翌月の残数/pack使用が壊れるため・Codex指摘）。GAS側はSHA-256して保存・billングは再計算検証。
// logicVersion（manifest/detail列）と record.canonicalVersion の組合せ検証。
//   これが無いと「manifestはalloc-2なのにpayloadはcanonicalVersion欠落」を受理し、units/packKind/ペア価格が
//   checksum保護の外に落ちる（＝改ざん・欠落を検知できない）。両方向の食い違いを fail-loud にする。
function _lbCanonicalVersionOk(logicVersion, record) {
  var cv = (record && record.canonicalVersion != null) ? Number(record.canonicalVersion) : 1;
  if (String(logicVersion) === 'alloc-1') return cv === 1;
  if (String(logicVersion) === 'alloc-2') return cv === 2;
  return false;
}

//   ★版分岐（決定：ペア会計）：v1記録（canonicalVersion欄なし）は旧canonicalのまま＝既存CLOSEDのchecksumを壊さない。
//   v2記録のみ units/packKind/価格snapshot を含む新canonical（ペアの人数・差額が改ざん検知の対象に入る）。
function _lbAllocationCanonical(record, closing) {
  record = record || {}; closing = closing || {};
  var ver = Number(record.canonicalVersion || 1); if (!(ver === 2)) ver = 1;
  var tl = (record.ticketLines || []).map(function (l) {
    return (ver === 2)
      ? [String(l.packId), l.unitPrice == null ? 'null' : l.unitPrice, l.count, (l.units == null ? l.count : l.units), String(l.kind || 'normal')]
      : [String(l.packId), l.unitPrice == null ? 'null' : l.unitPrice, l.count];
  });
  tl.sort();
  var tb = record.trainerBreakdown || {};
  var tbk = Object.keys(tb).sort().map(function (k) { return [k, tb[k].monthly || 0, tb[k].ticket || 0]; });
  var det = (record.details || []).map(function (d) {
    var base = [String(d.sessionId), String(d.alloc), String(d.packId || ''), String(d.trainerId || ''), (d.unitPriceSnapshot == null ? 'null' : d.unitPriceSnapshot)];
    if (ver === 2) {
      base.push((d.units == null ? 1 : d.units), String(d.packKind || 'normal'),
        (d.pairUnitPriceSnapshot == null ? 'null' : d.pairUnitPriceSnapshot),
        (d.normalUnitPriceSnapshot == null ? 'null' : d.normalUnitPriceSnapshot),
        (d.surchargeSnapshot == null ? 'null' : d.surchargeSnapshot));
    }
    return base;
  });
  det.sort();
  var cpk = closing.packsUsed || closing.packs || {};
  var cp = Object.keys(cpk).sort().map(function (k) { return [k, cpk[k]]; });
  var cc = closing.carry || {};
  var ccar = Object.keys(cc).sort().map(function (k) { return [k, cc[k]]; });
  if (ver === 2) {
    return JSON.stringify({
      v: 2,
      m: String(record.monthKey || ''), c: String(record.customerId || ''),
      mc: record.monthlyConsumed || 0, mp: record.monthlyUnitPrice == null ? 'null' : record.monthlyUnitPrice,
      ci: record.carryIn || 0, co: record.carryOut || 0, tl: tl, tr: record.transferCount || 0,
      ua: record.unallocated || 0, tb: tbk, d: det, cp: cp, ccar: ccar, cm: String(closing.cutoverMonth || '')
    });
  }
  return JSON.stringify({
    m: String(record.monthKey || ''), c: String(record.customerId || ''),
    mc: record.monthlyConsumed || 0, mp: record.monthlyUnitPrice == null ? 'null' : record.monthlyUnitPrice,
    ci: record.carryIn || 0, co: record.carryOut || 0, tl: tl, tr: record.transferCount || 0,
    ua: record.unallocated || 0, tb: tbk, d: det, cp: cp, ccar: ccar, cm: String(closing.cutoverMonth || '')
  });
}

// ═══ 段階4：会員登録の昇格判定（純粋・Node検証可）＝customer_id安定化 ═══
//   customer_id は登録時に発行（＝鶏卵回避）。この関数が「新規発行/既存ID再利用/更新/再バインド認証必須/曖昧」を決める。
// entries: 正規化済み customer_line_map 行 [{ rowIndex, lineUserId, customerId, name, phone, authState }]（name/phoneは正規化済み）
// 戻り値 action:
//   'idempotent'      … この lineUserId が既に verified（何もしない・そのID返す）
//   'update'          … この lineUserId の pending/follow 行を更新（rowIndex, customerId）
//   'reuse'           … 本人(氏名+電話一致)の未linkの既存行を再利用（分裂させない・rowIndex, customerId）
//   'rebind_required' … 本人が別 lineUserId で既に verified（機種変/乗っ取りの区別のため認証番号必須）
//   'ambiguous'       … 同名+同電話が複数の異なる customer_id に一致（誤混入防止・fail-closed）
//   'new'             … 該当なし（呼び出し側が新IDを採番）
function _lbResolveRegistration(entries, lineUserId, name, phone) {
  entries = entries || [];
  var mine = null;
  for (var i = 0; i < entries.length; i++) if (String(entries[i].lineUserId) === String(lineUserId) && entries[i].lineUserId) { mine = entries[i]; break; }
  if (mine && mine.authState === 'verified') return { action: 'idempotent', customerId: mine.customerId, rowIndex: mine.rowIndex };

  // 本人候補＝氏名+電話が一致する行
  var persons = [];
  for (var j = 0; j < entries.length; j++) { var e = entries[j]; if (e.name === name && e.phone === phone) persons.push(e); }
  // 異なる customer_id の数（空IDは除く）
  var idSet = {};
  for (var k = 0; k < persons.length; k++) { var cid = String(persons[k].customerId || ''); if (cid) idSet[cid] = true; }
  var distinctIds = Object.keys(idSet);
  if (distinctIds.length > 1) return { action: 'ambiguous' };   // 同名+同電話が複数IDに一致 → fail-closed

  // 別 lineUserId で既に verified（本人）＝再バインド → 認証番号必須
  for (var v = 0; v < persons.length; v++) {
    if (persons[v].authState === 'verified' && persons[v].lineUserId && String(persons[v].lineUserId) !== String(lineUserId)) {
      return { action: 'rebind_required', customerId: persons[v].customerId };
    }
  }
  // この lineUserId の pending/follow 行 → 更新（IDは自身 or 本人の既存ID）
  if (mine) return { action: 'update', customerId: mine.customerId || (distinctIds[0] || null), rowIndex: mine.rowIndex };
  // 本人の未link行（issueVerifyCodeで先行作成された行等）があればID再利用＝分裂防止
  for (var u = 0; u < persons.length; u++) { if (!persons[u].lineUserId) return { action: 'reuse', customerId: persons[u].customerId, rowIndex: persons[u].rowIndex }; }
  return { action: 'new', customerId: null };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { _lbAllocateSessions: _lbAllocateSessions, _lbMonthKeyJst: _lbMonthKeyJst, _lbHashStr: _lbHashStr,
    _lbRowsToEntitlements: _lbRowsToEntitlements, _lbResvValsToSessions: _lbResvValsToSessions,
    _lbComputeRemaining: _lbComputeRemaining, _lbBookability: _lbBookability, _lbMonthlyCoverage: _lbMonthlyCoverage,
    _lbResolveRegistration: _lbResolveRegistration, _lbBuildAllocationRecords: _lbBuildAllocationRecords,
    _lbBuildAccountingProjection: _lbBuildAccountingProjection, _lbBuildCloseRun: _lbBuildCloseRun,
    _lbAllocationCanonical: _lbAllocationCanonical, _lbCanonicalVersionOk: _lbCanonicalVersionOk, _lbRevenueFromRecord: _lbRevenueFromRecord,
    _lbBuildCutoverOpening: _lbBuildCutoverOpening, _lbMonthlyCoverAtCutover: _lbMonthlyCoverAtCutover,
    _lbFirstOfMonthMsJst: _lbFirstOfMonthMsJst, _lbBuildSessionExclusion: _lbBuildSessionExclusion,
    _lbBuildLineInjectionRows: _lbBuildLineInjectionRows,
    _lbResolveCarryCap: _lbResolveCarryCap, LB_CARRY_CAP_TABLE: LB_CARRY_CAP_TABLE,
    LB_ALLOC_LOGIC_VERSION: LB_ALLOC_LOGIC_VERSION, LB_ALLOC_CANONICAL_VERSION: LB_ALLOC_CANONICAL_VERSION,
    LB_ALLOC_ACCEPTED_VERSIONS: LB_ALLOC_ACCEPTED_VERSIONS };
}

// ============================================================
// ここから下は Workers 用の書き出しです（コピー元の pt-gas/Allocate.js には存在しません）。
//   ★この行より上は pt-gas/Allocate.js と1文字も違ってはいけません。
//     ずれると、GASとWorkerで残数が静かに食い違います。
//     line-booking/test/allocate-worker-drift.test.js が毎回照合します。
// ============================================================
export {
  _lbRowsToEntitlements, _lbResvValsToSessions, _lbComputeRemaining, _lbBookability,
  _lbMonthlyCoverage, _lbResolveRegistration, _lbBuildAllocationRecords,
  _lbAllocationCanonical, _lbResolveCarryCap,
  LB_CARRY_CAP_TABLE, LB_ALLOC_LOGIC_VERSION, LB_ALLOC_CANONICAL_VERSION, LB_ALLOC_ACCEPTED_VERSIONS,
};
