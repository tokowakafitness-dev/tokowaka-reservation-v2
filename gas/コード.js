// ============================================================
// TOKOWAKA 予約システム - code.gs ※JSONP対応版
// アカウント: tokowaka.fitness@gmail.com
// ============================================================

var CALENDAR_IDS = {
  CAPACITY_B1: '8b94ca044fc753d8be315cdbb318ae52f9aae985a518d0a852aa9e111aca403a@group.calendar.google.com',
  CAPACITY_1F: 'c9ba13caaee9973847a6768762582f1fc8e540aa74f648289d6e525eaae3612f@group.calendar.google.com',
  TRAINERS: [
    { id:'A', name:'中野 龍之介',  sheetName:'slots_nakano', email:'75199d0479652a61f08e044d8fab405a5e125640fcea65bdbf0fa62b8ef2a819@group.calendar.google.com', hidden:true },   // オーナー＝顧客のトレーナー選択には出さない
    { id:'B', name:'鈴木 神海感留', sheetName:'slots_suzuki', email:'4a3cfdf07eff0e3abe3b8dc32748eaa2f269ca91d0cacd45265df3e1a1f19e4a@group.calendar.google.com' },
    { id:'C', name:'沖 孟',        sheetName:'slots_oki',    email:'8549b7e79a39bf109f41a0ae75c275257ca8ae000566efb839ec89d44974a358@group.calendar.google.com' }
  ]
};

var SETTINGS = {
  SESSION_MINUTES:  60,           // 会員セッションの長さ／顧客への表示（体験も表示はこれ）
  TRIAL_SESSION_MINUTES: 90,      // 新規体験で実際に押さえる時間。カウンセリング・案内を含むため表示より長く確保する（2026-09-25 オーナー指示）
  INTERVAL_MINUTES: 60,   // 9月1日以降の刻み（毎時ちょうど・7:00,8:00…）※吸着統合で未使用
  PICKER_STEP_MINUTES: 15,   // 空きブロック内の開始時刻の刻み（顧客が任意の開始を選べる・15分単位）
  HOURLY_FROM: '2026/09/01',   // この日以降の予約枠は毎時ちょうど。それ以前（移行期＝8月中）は15分刻み（既存の任意時刻予約に噛み合わせる）
  BOOKING_LEAD_MINUTES: 180,   // 当日予約は開始3時間前で締め切る（直前予約の防止）
  MORNING_UNTIL_HOUR: 12,          // 「午前枠」の定義＝この時刻より前に始まる枠（12＝正午前が午前扱い）
  MORNING_PREV_DEADLINE_HOUR: 22,  // 午前枠は前日この時刻で締め切る。トレーナーが前夜に翌日の朝を確定できるようにするため（0で無効化＝従来の3時間前のみ）
  BUSINESS_START:   7,
  BUSINESS_END:     24,
  SYNC_DAYS:        30,
  WORKING_DAYS:     [0,1,2,3,4,5,6],
  TIMEZONE:         'Asia/Tokyo',
  GYM_NAME:         'パーソナルジムTOKOWAKA 吉祥寺',
  GYM_ADDRESS:      '東京都武蔵野市吉祥寺東町2丁目17-7 VILLA BUONAMICO 103',
  GYM_PHONE:        '070-3549-8168',
  CACHE_KEY:        'available_slots_v1',
  CACHE_SECONDS:    660,
  SPREADSHEET_ID:   '1X3I2Q2ICd02yC8kxuEYKlbTGTWyoKIvsv87NL2bYol0',
  SHEET_NAME:       'slots'
};

// ── LINE設定 ──
var LINE_CONFIG = {
  TOKEN:    PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_ACCESS_TOKEN'),
  GROUP_ID: 'Cf9c97e22f3e375940a96e80d5f53623c'
};

// ── APIエントリーポイント（JSONP対応）──
function doGet(e) {
  var params    = e && e.parameter ? e.parameter : {};
  var action    = params.action   || '';
  var trainerId = params.trainer  || '';
  var callback  = params.callback || ''; // JSONP用

  // ── LINE予約LIFF（会員向けミニアプリ）── ※既存の web体験予約(action系)には影響しない
  if (params.view === 'liff') {
    var tpl = HtmlService.createTemplateFromFile('LiffApp');
    tpl.liffId = PropertiesService.getScriptProperties().getProperty('LINE_LIFF_ID') || '';
    return tpl.evaluate()
      .setTitle('TOKOWAKA予約')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  var result;
  try {
    if      (action === 'ping')            { result = { ok:true, ts:new Date().getTime() }; }
    else if (action === 'getSlots')        { result = getCachedSlots(trainerId); }
    else if (action === 'makeReservation') { result = makeReservation(JSON.parse(params.params || '{}')); }
    else if (action.indexOf('line_') === 0){ result = handleLineGet(params); }  // LINE予約(LIFF)のJSONP窓口 → LineBooking.js
    else if (action.indexOf('ma_') === 0)  { result = maHandleGet(params); }    // meal-ai グラフLIFF の窓口 → MealAi.js
    else                                   { result = { error: 'unknown action' }; }
  } catch(err) {
    result = { error: err.message };
  }
  var json = JSON.stringify(result);
  // callbackがある場合はJSONP形式（インアプリブラウザ対応）
  if (callback) {
    return ContentService.createTextOutput(callback + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json)
    .setMimeType(ContentService.MimeType.TEXT);
}

// ── 空き枠専用の「公開SS」を自動作成（個人情報なし）──
// オーナーがGASエディタで1回だけ実行する。作成後、IDが Script Properties に登録される。
function setupPublicSlotsSpreadsheet() {
  var props = PropertiesService.getScriptProperties();
  var existing = props.getProperty('PUBLIC_SLOTS_SPREADSHEET_ID');
  if (existing) {
    Logger.log('既に作成済みです。ID: ' + existing);
    return existing;
  }
  var ss = SpreadsheetApp.create('TOKOWAKA予約_空き枠公開用（個人情報なし）');
  ss.getSheets()[0].setName('slots');
  var id = ss.getId();
  props.setProperty('PUBLIC_SLOTS_SPREADSHEET_ID', id);
  Logger.log('✅ 公開用・空き枠SSを作成しました（個人情報は一切含みません）');
  Logger.log('ID : ' + id);
  Logger.log('URL: ' + ss.getUrl());
  Logger.log('次の手順：①このSSを「リンクを知る全員（閲覧者）」に共有 → ②warmupCache を1回実行して空き枠を書き込む → ③予約フロントの SS_ID をこのIDに差し替え');
  return id;
}

// ── スプレッドシートに空き枠を書き込む ──
function writeToSpreadsheet(slots) {
  try {
    // 空き枠は「公開SS（PUBLIC_SLOTS_SPREADSHEET_ID）」へ。未設定なら従来のSSへフォールバック
    var slotsSsId = PropertiesService.getScriptProperties().getProperty('PUBLIC_SLOTS_SPREADSHEET_ID') || SETTINGS.SPREADSHEET_ID;
    var ss = SpreadsheetApp.openById(slotsSsId);
    var sheet = ss.getSheetByName(SETTINGS.SHEET_NAME);
    if (!sheet) { sheet = ss.insertSheet(SETTINGS.SHEET_NAME); }
    sheet.clearContents();
    // 9列目 trial_ok＝体験90分を確保できる枠か（2026-09-25）。既存8列の並びは変えない＝フロントの列参照を壊さない。
    sheet.getRange(1,1,1,9).setValues([['date','dayOfWeek','startTime','endTime','startISO','endISO','trainerName','trainerId','trial_ok']]);
    if (slots.length > 0) {
      var rows = slots.map(function(s){
        return [s.date, s.dayOfWeek, s.startTime, s.endTime, s.startISO, s.endISO, s.trainerName||'', s.trainerId||'', (s.trialOk === false ? 'no' : 'yes')];
      });
      sheet.getRange(2,1,rows.length,9).setValues(rows);
    }
    for (var t = 0; t < CALENDAR_IDS.TRAINERS.length; t++) {
      var trainer = CALENDAR_IDS.TRAINERS[t];
      var trainerSlots = slots.filter(function(s){ return s.trainerId === trainer.id; });
      var tSheet = ss.getSheetByName(trainer.sheetName);
      if (!tSheet) { tSheet = ss.insertSheet(trainer.sheetName); }
      tSheet.clearContents();
      tSheet.getRange(1,1,1,9).setValues([['date','dayOfWeek','startTime','endTime','startISO','endISO','trainerName','trainerId','trial_ok']]);
      if (trainerSlots.length > 0) {
        var tRows = trainerSlots.map(function(s){
          return [s.date, s.dayOfWeek, s.startTime, s.endTime, s.startISO, s.endISO, s.trainerName||'', s.trainerId||'', (s.trialOk === false ? 'no' : 'yes')];
        });
        tSheet.getRange(2,1,tRows.length,9).setValues(tRows);
      }
      Logger.log(trainer.name + 'シート書き込み: ' + trainerSlots.length + '件');
    }
    var metaSheet = ss.getSheetByName('meta');
    if (!metaSheet) metaSheet = ss.insertSheet('meta');
    metaSheet.getRange('A1').setValue(new Date().toISOString());
    Logger.log('スプレッドシート書き込み完了: ' + slots.length + '件');
  } catch(e) {
    Logger.log('スプレッドシート書き込みエラー: ' + e.message);
  }
}

// 締切を過ぎた枠をいま時点で落とす（2026-09-25 Codexレビュー指摘）。
//   枠はwarmupCache(10分毎)で作るため、生成時に除外しただけでは 22:00 直後の最大10分間、
//   朝の枠がキャッシュに残って見えてしまう。読み出しのたびに現在時刻で再判定する。
function _lbDropClosedSlots(slots) {
  if (!slots || !slots.length) return slots || [];
  var nowMs = new Date().getTime(), cfg = _lbBookingCfg(SETTINGS);
  return slots.filter(function (s) {
    var t = new Date(s.startISO).getTime();
    return isNaN(t) ? true : _lbBookingOpen(t, nowMs, cfg);   // 日時を解釈できない行は落とさない（従来どおり出す）
  });
}

// ── キャッシュ管理 ──
function getCachedSlots(trainerId) {
  var cache  = CacheService.getScriptCache();
  // トレーナー指定時はトレーナー別キャッシュ（全SYNC_DAYS期間・各1/3で軽い）→15-28日先も出る。
  if (trainerId) {
    // 未知trainerIdは即空返し（毎回全構築の高負荷/DoSを防ぐ）
    var _known = CALENDAR_IDS.TRAINERS.some(function (tt) { return String(tt.id) === String(trainerId); });
    if (!_known) { Logger.log('未知trainerId: ' + trainerId + ' → 空返し'); return []; }
    var tc = cache.get(SETTINGS.CACHE_KEY + '_t_' + trainerId);
    if (tc) { var ts = _lbDropClosedSlots(JSON.parse(tc)); Logger.log('トレーナー別キャッシュヒット: ' + ts.length + '件（締切済みを除外後）'); return ts; }
    Logger.log('トレーナー別キャッシュミス → 1回構築して絞る');
    var built = buildAndCacheSlots();   // 全構築は1回だけ。結果から絞る（二重構築しない）
    return _lbDropClosedSlots(built.filter(function (s) { return String(s.trainerId) === String(trainerId); }));
  }
  var cached = cache.get(SETTINGS.CACHE_KEY);
  if (cached) { var slots = _lbDropClosedSlots(JSON.parse(cached)); Logger.log('キャッシュヒット: ' + slots.length + '件（締切済みを除外後）'); return slots; }
  Logger.log('キャッシュミス → 取得');
  return buildAndCacheSlots();
}

function buildAndCacheSlots() {
  var slots = buildAvailableSlots();
  var cache = CacheService.getScriptCache();

  // 共有キャッシュ（trainer未指定のfallback用）は直近14日のみ（100KB上限対策）
  var cacheDeadline = new Date();
  cacheDeadline.setDate(cacheDeadline.getDate() + 14);
  var cacheSlots = slots.filter(function(s) { return new Date(s.startISO) <= cacheDeadline; })
    .map(function(s) {   // trialOk は体験サイト専用（SS経由）。キャッシュ(100KB上限)には載せない
      return { date: s.date, dayOfWeek: s.dayOfWeek, startTime: s.startTime, endTime: s.endTime,
               startISO: s.startISO, endISO: s.endISO, trainerName: s.trainerName, trainerId: s.trainerId };
    });
  try {
    var json = JSON.stringify(cacheSlots);
    cache.put(SETTINGS.CACHE_KEY, json, SETTINGS.CACHE_SECONDS);
    Logger.log('共有キャッシュ保存: ' + cacheSlots.length + '件 / ' + Math.round(json.length/1024) + 'KB');
  } catch(e) { Logger.log('共有キャッシュ保存エラー: ' + e.message); }

  // トレーナー別キャッシュ＝各トレーナーの全SYNC_DAYS期間（各1/3で軽い→15-28日先も予約可）。
  //   全トレーナーを毎回上書き（0件は空配列・95KB超はkey削除）＝古いkeyを残さない（stale防止・Codex）。
  var byT = {};
  for (var i = 0; i < slots.length; i++) { var t = String(slots[i].trainerId || ''); if (!t) continue; if (!byT[t]) byT[t] = []; byT[t].push(slots[i]); }
  var allTids = CALENDAR_IDS.TRAINERS.map(function (tt) { return String(tt.id); });
  for (var a = 0; a < allTids.length; a++) {
    var tid = allTids[a], key = SETTINGS.CACHE_KEY + '_t_' + tid, arr = byT[tid] || [];
    try {
      var tj = JSON.stringify(arr);
      if (tj.length < 95000) cache.put(key, tj, SETTINGS.CACHE_SECONDS);
      else { cache.remove(key); Logger.log('⚠️ トレーナー' + tid + 'のキャッシュ95KB超→key削除（miss時に構築+絞る）'); }
    } catch (e2) { cache.remove(key); Logger.log('トレーナー別キャッシュ保存エラー(' + tid + ')→key削除: ' + e2.message); }
  }
  writeToSpreadsheet(slots);
  return slots;
}

function invalidateCache() {
  CacheService.getScriptCache().remove(SETTINGS.CACHE_KEY);
  Logger.log('キャッシュ破棄 → 再構築');
  buildAndCacheSlots();
}

function warmupCache() {
  Logger.log('=== ウォームアップ開始 ' + new Date() + ' ===');
  buildAndCacheSlots();
  Logger.log('=== ウォームアップ完了 ===');
}

// ── 「埋まり」として扱うタイトルか判定（2026-10-02）──
//   予約・実施済みに加えて、休憩とブロックも席を塞ぐ。
//   表示（buildAvailableSlots）と確定（checkTrainerAvailable / _lbCheckTrainerAvailable）で
//   条件がずれると、画面に出ない枠が確定できたり、その逆が起きる。だから1か所で決める。
function _lbIsBusyTitle(title) {
  var t = String(title || '');
  return t.indexOf('[RESERVED]') === 0
      || t.indexOf('✅') === 0
      || t.indexOf('休憩') >= 0
      || t.indexOf('ブロック') >= 0;
}

// ── 「実際のセッション」のタイトルか判定（2026-10-02）──
//   埋まり（_lbIsBusyTitle）とは目的が違う。
//   埋まり＝席を塞ぐか（休憩・ブロックも塞ぐので含む）。
//   セッション＝トレーナーが実際に施術しているか（休憩・ブロックは含まない）。
//   連続セッションを数えるときは、休憩を挟めば質は回復するので「区切り」として扱う。
//   ここを混ぜると「休んでいる日の前後の枠まで落ちる」制限になってしまう。
function _lbIsSessionTitle(title) {
  var t = String(title || '');
  if (t.indexOf('休憩') >= 0 || t.indexOf('ブロック') >= 0) return false;   // 施術ではない
  return t.indexOf('[RESERVED]') === 0 || t.indexOf('✅') === 0;
}

// ── 「出勤可能」系タイトルか判定 ──
function isShiftEvent(title) {
  var keywords = ['出勤可能', '出勤', 'シフト', 'available', 'AVAILABLE'];
  for (var i = 0; i < keywords.length; i++) {
    if (title.indexOf(keywords[i]) !== -1) return true;
  }
  return false;
}

// ── 空き枠を構築 ──
// 区間 base(start/end) から busyList（重なる予約・施設埋まり）を引いて「空きブロック」の配列を返す。
//   吸着方式の中核：出勤シフトから予約を引いた連続空きを求め、各ブロックの端から60分刻みで枠を出す。
function _lbSubtractIntervals(base, busyList) {
  var bs = base.start.getTime(), be = base.end.getTime();
  var busies = [];
  for (var i = 0; i < busyList.length; i++) {
    var s = busyList[i].start.getTime(), e = busyList[i].end.getTime();
    if (s < be && e > bs) busies.push({ s: Math.max(s, bs), e: Math.min(e, be) });   // baseと重なる部分だけ
  }
  busies.sort(function(a, b){ return a.s - b.s; });
  var merged = [];
  for (var j = 0; j < busies.length; j++) {
    if (merged.length && busies[j].s <= merged[merged.length - 1].e) merged[merged.length - 1].e = Math.max(merged[merged.length - 1].e, busies[j].e);
    else merged.push({ s: busies[j].s, e: busies[j].e });
  }
  var free = [], cur = bs;
  for (var k = 0; k < merged.length; k++) {
    if (merged[k].s > cur) free.push({ start: new Date(cur), end: new Date(merged[k].s) });
    cur = Math.max(cur, merged[k].e);
  }
  if (cur < be) free.push({ start: new Date(cur), end: new Date(be) });
  return free;
}

//   nowMsOpt（省略可）… 「いま」を指定して計算する。突き合わせ専用。
//     D1の答えと比べるとき、時点をずらして「25日の解放」「月またぎ」「締め切りの境界」を
//     狙って踏むために使う。**省略時はこれまでどおり現在時刻**なので、既存の呼び出しは変わらない。
//     ★本番の空き枠生成からは渡さないこと（渡すと顧客に過去や未来の枠を見せる）。
function buildAvailableSlots(excludeStartMs, nowMsOpt) {
  var _wt = new Date().getTime();
  function _wlap(n){ Logger.log('[warmup] ' + n + ': ' + (new Date().getTime() - _wt) + 'ms'); }
  var now     = (nowMsOpt != null) ? new Date(nowMsOpt) : new Date();
  // 予約可能な窓＝【当月末まで／毎月25日以降は翌月末まで解禁】（20日シフト提出→25日翌月解禁の運用）。同期も同じ地平を共用。
  //   例：9/1〜9/24＝9月末まで／9/25〜＝10月末まで／10/25〜＝11月末まで。
  var endDate  = _lbBookingHorizonEnd(now);   // 共通ヘルパー（syncと単一ソース）
  var tz = SETTINGS.TIMEZONE;
  // 変更/振替時、自分の旧予定(同開始時刻)を空き判定から除外＝元の時間帯を振替枠として選べるように（問題2）
  function _notExcluded(ev){ return !(excludeStartMs && ev.getStartTime().getTime() === excludeStartMs); }

  var calB1    = CalendarApp.getCalendarById(CALENDAR_IDS.CAPACITY_B1);
  // [消化]は計上の証跡として残るが席は空き。施設キャパから除外（共通ルール）
  // 1-A/1-B：通常予約はB1のみ。1F(MT・体験用)は空き判定に使わない（無駄なAPI呼び出しも除去）
  var eventsB1 = calB1.getEvents(now, endDate).filter(function(ev){ return ev.getTitle().indexOf('[消化]') !== 0 && _notExcluded(ev); }).map(function(ev){ return { start:ev.getStartTime(), end:ev.getEndTime() }; });
  Logger.log('キャパシティ 地下=' + eventsB1.length + '件');
  // 1Fオンライン等はB1容量を使わないが担当トレーナーを塞ぐ→トレーナー別busyに合算（Codex#1）。担当姓不明はblockAll(全員)。
  //   フラグ LB_1F_TRAINER_BLOCK=on のときだけ適用（既定OFF＝現行挙動・staging無し環境で安全にデプロイ）。
  //   取得失敗時：表示は1F反映なしの楽観生成とし、確定側 _lbReserveCore が fail-closed で最終担保（表示の全面停止は避ける）。
  //   1F側は「自分の旧予定」除外をしない（LINE変更元はB1イベントのため・Codex#2）。
  var _use1F = (typeof _lb1FBlockEnabled === 'function') && _lb1FBlockEnabled();
  var f1busy = _use1F ? _lb1FTrainerBusy(now, endDate) : { ok: true, trainerBusy: {}, blockAll: [] };
  if (_use1F && !f1busy.ok) Logger.log('⚠️ 1F busy取得不可：空き枠は1F反映なしで生成（確定時に再検査でfail-closed）');
  var f1BlockAll = (f1busy.blockAll || []).map(function(iv){ return { start: iv.start, end: iv.end }; });
  _wlap('キャパgetEvents(2回)');

  var trainerShifts   = {};
  var trainerReserved = {};

  for (var t = 0; t < CALENDAR_IDS.TRAINERS.length; t++) {
    var tr  = CALENDAR_IDS.TRAINERS[t];
    var cal = CalendarApp.getCalendarById(tr.email);
    if (!cal) {
      Logger.log('カレンダー取得失敗: ' + tr.name);
      trainerShifts[tr.id]   = [];
      trainerReserved[tr.id] = [];
      continue;
    }
    var events   = cal.getEvents(now, endDate);
    var shifts   = [];
    var reserved = [];
    for (var j = 0; j < events.length; j++) {
      var ev    = events[j];
      var title = ev.getTitle();
      if (isShiftEvent(title)) {
        shifts.push({ start: ev.getStartTime(), end: ev.getEndTime() });
      } else if (_lbIsBusyTitle(title) && _notExcluded(ev)) {
        reserved.push({ start: ev.getStartTime(), end: ev.getEndTime() });   // 予約・実施済み・休憩・ブロックは「埋まり」＝空きブロックから除外（吸着で休憩後から詰まる）。変更/振替元は除外
      }
    }
    trainerShifts[tr.id]   = shifts;
    trainerReserved[tr.id] = reserved;
    Logger.log(tr.name + ': 出勤可能=' + shifts.length + '件 / 予約済=' + reserved.length + '件');
  }

  _wlap('トレーナーgetEvents(3名)');
  var allSlots  = [];
  var sessionMs = SETTINGS.SESSION_MINUTES * 60000;
  var trialMs   = (SETTINGS.TRIAL_SESSION_MINUTES || SETTINGS.SESSION_MINUTES) * 60000;   // 体験の実確保（表示より長い）
  var pickStep  = (SETTINGS.PICKER_STEP_MINUTES || 15) * 60000;   // 開始時刻の刻み（ブロック内で任意開始）
  var nowMs     = now.getTime();

  // 吸着方式：各トレーナーの出勤シフトから「予約＋施設埋まり」を引いた空きブロックを作り、
  //   各ブロックの端から60分刻みで枠を出す。既存予約(任意時刻)に自然に噛み合い、無駄は各ブロック端の最小値に限定。
  var ownerWin = _lbOwnerSlotWindow();   // 中野(hidden)の固定客向け枠を曜日×時間帯に絞る（未設定＝制限なし）
  for (var ti = 0; ti < CALENDAR_IDS.TRAINERS.length; ti++) {
    var trainer = CALENDAR_IDS.TRAINERS[ti];
    var shifts  = trainerShifts[trainer.id] || [];
    // B1施設(全員)＋自分のトレーナーcal予約＋1Fで自分に帰属する予約(オンライン等)＋1F帰属不能(全員)
    var f1mine  = ((f1busy.trainerBusy || {})[trainer.id] || []).map(function(iv){ return { start: iv.start, end: iv.end }; });
    var busy    = (trainerReserved[trainer.id] || []).concat(eventsB1).concat(f1mine).concat(f1BlockAll);   // 1FオンラインでそのトレーナーをブロックしB1二重予約を防ぐ（Codex#1）
    for (var si = 0; si < shifts.length; si++) {
      var shiftEndMs = shifts[si].end.getTime();   // 退勤時刻。体験90分がここを超えるのは許す（下の trialOk）
      var freeBlocks = _lbSubtractIntervals(shifts[si], busy);
      for (var bi = 0; bi < freeBlocks.length; bi++) {
        var blk = freeBlocks[bi];
        // 残り時間で刻みを動的に切替：2枠以上残る区間は60分刻みで詰めて予約（断片化防止＝2枠確保）／
        //   最後の1枠になったら15分刻みで営業終了まで柔軟に選択（例 20:30-23:00→20:30/21:30/21:45/22:00）
        var blockEnd = blk.end.getTime();
        for (var cur = blk.start.getTime(); cur + sessionMs <= blockEnd;
             cur += ((blockEnd - cur) >= 2 * sessionMs ? sessionMs : pickStep)) {
          if (!_lbBookingOpen(cur, nowMs, _lbBookingCfg(SETTINGS))) continue;   // 締め切り済みの枠は出さない（午前枠＝前日22時／他＝3時間前）
          var st = new Date(cur), en = new Date(cur + sessionMs);
          if (trainer.hidden && !_lbInOwnerWindow(st, ownerWin)) continue;   // 中野(hidden)は設定した曜日×時間帯の枠だけ固定客に見せる
          // 体験は90分押さえる。会員(LINE)は60分のまま全枠見えるので、ここでは除外せずフラグだけ持たせる。
          //   ただし「ブロックの終わりが退勤時刻」の場合は超過を許す（2026-09-25 オーナー判断）。
          //   22時台の枠が全滅していたのはシフト終端(23時)が理由で、他のお客様とぶつかるわけではないため。
          //   体験不可にするのは「後ろ90分に他の予約が入っている」ときだけにする。
          var trialOk = ((cur + trialMs) <= blockEnd)
            || ((blockEnd === shiftEndMs) && (cur + sessionMs) <= blockEnd);
          allSlots.push({
            date:        Utilities.formatDate(st, tz, 'yyyy/MM/dd'),
            dayOfWeek:   ['日','月','火','水','木','金','土'][st.getDay()],
            startTime:   Utilities.formatDate(st, tz, 'HH:mm'),
            endTime:     Utilities.formatDate(en, tz, 'HH:mm'),
            startISO:    st.toISOString(),
            endISO:      en.toISOString(),
            trainerName: trainer.name,
            trainerId:   trainer.id,
            trialOk:     trialOk
          });
        }
      }
    }
  }
  _wlap('吸着枠計算');
  // 体験に出せる枠（90分確保できる枠）の割合をログに残す＝シフト終端や既存予約で体験枠が細っていないか監視する
  var _trialNg = 0;
  for (var _q = 0; _q < allSlots.length; _q++) if (allSlots[_q].trialOk === false) _trialNg++;
  Logger.log('空き枠構築完了: ' + allSlots.length + '件（うち体験に出せる枠: ' + (allSlots.length - _trialNg)
    + '件 / 90分取れず体験不可: ' + _trialNg + '件）');
  return allSlots;
}

// ── 入力検証＋レート制限（無認証エンドポイントの乱用・偽予約スパム対策）──
// しきい値は安全側の上限。実際の予約ボリュームに応じてオーナーが調整可。
function validateAndRateLimit(params) {
  params = params || {};
  var name  = String(params.customerName  || '').trim();
  var email = String(params.customerEmail || '').trim();
  var phone = toHalfWidth(String(params.customerPhone || '').trim()); // 全角数字入力の客を弾かない
  var note  = String(params.customerNote  || '').trim();

  if (!name || !email || !phone) return { ok:false, message:'お名前・メール・電話番号は必須です。' };
  if (name.length > 40 || email.length > 100 || phone.length > 20 || note.length > 500)
    return { ok:false, message:'入力内容が長すぎます。ご確認ください。' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return { ok:false, message:'メールアドレスの形式が正しくありません。' };
  if (!/^[0-9+\-()\s]{9,20}$/.test(phone))
    return { ok:false, message:'電話番号の形式が正しくありません。' };
  if (!params.startISO || isNaN(new Date(params.startISO).getTime()))
    return { ok:false, message:'予約時間が正しくありません。' };

  var cache = CacheService.getScriptCache();

  // ① 全体スロットリング：直近1時間で最大30件（通常運用を大きく超える安全上限）
  var gKey = 'rl_global';
  var gCnt = parseInt(cache.get(gKey) || '0', 10);
  if (gCnt >= 30)
    return { ok:false, message:'現在アクセスが集中しています。恐れ入りますが、しばらくしてからお試しください。' };
  cache.put(gKey, String(gCnt + 1), 3600);

  // ② 同一メール／電話：直近6時間で最大3件
  var eKey = 'rl_e_' + email.toLowerCase();
  var pKey = 'rl_p_' + phone.replace(/[^0-9]/g, '');
  if (parseInt(cache.get(eKey) || '0', 10) >= 3 || parseInt(cache.get(pKey) || '0', 10) >= 3)
    return { ok:false, message:'短時間に同じご連絡先での予約が続いています。恐れ入りますが、お電話（' + SETTINGS.GYM_PHONE + '）でご連絡ください。' };

  return { ok:true, cache:cache, eKey:eKey, pKey:pKey };
}

function markReservationSuccess(guard) {
  try {
    var c = guard.cache;
    c.put(guard.eKey, String(parseInt(c.get(guard.eKey) || '0', 10) + 1), 21600); // 6時間
    c.put(guard.pKey, String(parseInt(c.get(guard.pKey) || '0', 10) + 1), 21600);
  } catch (e) { Logger.log('レート制限カウンタ加算エラー: ' + e.message); }
}

// ── 全角英数記号→半角（電話番号などの表記ゆれ吸収）──
function toHalfWidth(s) {
  return String(s)
    .replace(/[０-９！-～]/g, function(c){ return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
    .replace(/　/g, ' ');
}

// ── シート書き込みの数式インジェクション無害化（= + - @ 始まりを無効化）──
function sanitizeCell(v) {
  v = String(v == null ? '' : v);
  return /^[=+\-@]/.test(v) ? "'" + v : v;
}

// ── reCAPTCHA v3 検証（Secretは Script Properties: RECAPTCHA_SECRET）──
// 段階導入：Secret未設定なら素通し（レート制限が受け皿）。設定後に本発効。
function verifyRecaptcha(token) {
  var secret = PropertiesService.getScriptProperties().getProperty('RECAPTCHA_SECRET');
  if (!secret) return { ok:true };            // 未設定＝無効（デプロイしても予約は止まらない）
  if (!token)  return { ok:false, message:'認証に失敗しました。ページを再読み込みのうえ、もう一度お試しください。' };
  try {
    var res  = UrlFetchApp.fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'post',
      payload: { secret: secret, response: token },
      muteHttpExceptions: true
    });
    var data = JSON.parse(res.getContentText());
    // 甘めの閾値0.3（レート制限との多層防御で正規客の誤ブロックを回避）
    if (data && data.success && (typeof data.score !== 'number' || data.score >= 0.3)) {
      return { ok:true, score:data.score };
    }
    return { ok:false, message:'自動送信の疑いがあり受け付けできませんでした。恐れ入りますが、お電話（' + SETTINGS.GYM_PHONE + '）でもご予約いただけます。' };
  } catch(e) {
    Logger.log('reCAPTCHA検証エラー: ' + e.message);
    return { ok:true, degraded:true };        // 検証系の障害時は予約を止めない（可用性優先）
  }
}

// ── 予約確定 ──
function makeReservation(params) {
  // ── reCAPTCHA（人間確認・ボット遮断の最終形）──
  var human = verifyRecaptcha(params.recaptchaToken);
  if (!human.ok) return { success:false, message: human.message };

  // ── 受付締め切り（午前枠＝前日22時／それ以外＝開始3時間前）──
  //   枠表示(buildAvailableSlots)と同じ _lbBookingOpen を使う。確定側に無いと、
  //   締切前に取得したCSVを開いたまま送信する／startISOを直接POSTする経路で成立してしまう
  //   （2026-09-25 Codexレビュー指摘。トレーナー就寝後に朝の予約が入る事故をここで止める）。
  var _bkStart = new Date(params.startISO);
  if (!isNaN(_bkStart.getTime())) {
    var _bkCfg = _lbBookingCfg(SETTINGS);
    if (!_lbBookingOpen(_bkStart.getTime(), new Date().getTime(), _bkCfg)) {
      return { success: false, message: _lbBookingDeadlineText(_bkStart.getTime(), _bkCfg) + '別のお時間をお選びください。' };
    }
  }

  // ── 入力検証＋レート制限（無認証エンドポイント乱用・偽予約スパム対策）──
  var guard = validateAndRateLimit(params);
  if (!guard.ok) return { success:false, message: guard.message };

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var start = new Date(params.startISO);
    // 体験は表示60分・確保90分（2026-09-25）。end＝実際に押さえる終了（カレンダー・空き照合・台帳）。
    //   endShown＝お客様にお伝えする終了（60分）。混同すると「90分と案内してしまう」ので変数を分ける。
    var end      = new Date(start.getTime() + SETTINGS.TRIAL_SESSION_MINUTES * 60000);
    var endShown = new Date(start.getTime() + SETTINGS.SESSION_MINUTES * 60000);
    var tz    = SETTINGS.TIMEZONE;

    var calB1      = CalendarApp.getCalendarById(CALENDAR_IDS.CAPACITY_B1);
    var cal1F      = CalendarApp.getCalendarById(CALENDAR_IDS.CAPACITY_1F);
    // [消化]は席が空くため施設キャパから除外（共通ルール）
    var _noConsumed = function(ev){ return ev.getTitle().indexOf('[消化]') !== 0; };
    // 境界で接するだけの予定は競合ではない（getEvents は end ちょうどに始まる予定も返す・2026-09-26）
    var _ovl = function (ev) { return _noConsumed(ev) && _lbEventOverlaps(ev, start.getTime(), end.getTime()); };
    var conflictB1 = calB1.getEvents(start, end).filter(_ovl);
    var conflict1F = cal1F.getEvents(start, end).filter(_ovl);
    if (conflictB1.length > 0 || conflict1F.length > 0) {
      return { success:false, message:'この時間帯はすでに予約が入りました。別の時間をお選びください。' };
    }

    var targetTrainerId = params.trainerId || '';
    var assigned = null;

    function checkTrainerAvailable(tr) {
      var cal = CalendarApp.getCalendarById(tr.email);
      if (!cal) return false;
      var evs    = cal.getEvents(start, end);
      var shifts = [], reserved = [];
      for (var j = 0; j < evs.length; j++) {
        var t = evs[j].getTitle();
        if (isShiftEvent(t)) {
          shifts.push({ start: evs[j].getStartTime(), end: evs[j].getEndTime() });
        } else if (_lbIsBusyTitle(t)) {
          // ★休憩・ブロックも「埋まり」（2026-10-02）。
          //   ここが [RESERVED]/✅ だけを見ていたため、トレーナーが自分のカレンダーに
          //   作ったブロックや休憩に新規体験が入ってしまっていた。
          //   空き枠の表示側（buildAvailableSlots）はブロックを除外しているのに、
          //   確定側の判定がそれより緩く、表示と確定が食い違っていた。
          //   判定は1か所（_lbIsBusyTitle）に寄せ、表示と確定でずれないようにする。
          reserved.push({ start: evs[j].getStartTime(), end: evs[j].getEndTime() });
        }
      }
      var s = start, e = end;
      // 出勤内かは表示どおりの60分で見る＝退勤時刻ぎりぎりの枠も体験を受けられる（90分の超過は許す・2026-09-25）。
      // 他のお客様の予約との重なりは、実際に押さえる90分で見る＝ぶつかる枠は確実に弾く。
      var onShift   = shifts.some(function(sh){ return s >= sh.start && endShown <= sh.end; });
      var notBooked = !reserved.some(function(r){ return s < r.end && e > r.start; });
      return onShift && notBooked;
    }

    if (targetTrainerId) {
      for (var t = 0; t < CALENDAR_IDS.TRAINERS.length; t++) {
        var tr = CALENDAR_IDS.TRAINERS[t];
        if (tr.id !== targetTrainerId) continue;
        if (checkTrainerAvailable(tr)) { assigned = tr; break; }
      }
    } else {
      // 優先順位：沖(C) > 中野(A) > 鈴木(B)
      var priorityOrder = ['C', 'A', 'B'];
      for (var p = 0; p < priorityOrder.length; p++) {
        var tr = CALENDAR_IDS.TRAINERS.filter(function(t){ return t.id === priorityOrder[p]; })[0];
        if (tr && checkTrainerAvailable(tr)) { assigned = tr; break; }
      }
    }

    if (!assigned) {
      return { success:false, message:'この時間帯は対応できるトレーナーがいません。別の時間をお選びください。' };
    }

    // ① キャパシティカレンダーに登録
    var reserveTitle = '[RESERVED] 体験_' + assigned.name.split(' ')[0] + '_' + _lbWithSama(params.customerName);   // 敬称は1つに畳む（2026-09-16）
    var reserveDesc  = '担当：' + assigned.name + '\nTEL：' + params.customerPhone + '\nEmail：' + params.customerEmail + (params.customerNote ? '\n備考：' + params.customerNote : '');
    calB1.createEvent(reserveTitle, start, end, { description: reserveDesc });
    cal1F.createEvent(reserveTitle, start, end, { description: reserveDesc });

    // ② トレーナーカレンダーに登録
    var trainerCal = CalendarApp.getCalendarById(assigned.email);
    if (trainerCal) {
      trainerCal.createEvent(
        '✅ ' + params.customerName + '様｜カウンセリング',
        start, end,
        { description: '担当：' + assigned.name + '\nお客様：' + params.customerName + ' 様\nTEL：' + params.customerPhone + '\nEmail：' + params.customerEmail + (params.customerNote ? '\n備考：' + params.customerNote : '') }
      );
    }

    // ③ スタッフLINEグループへ通知
    sendLineReservationNotice(params, assigned, start, end);

    // ④ お客様へ確認メール送信
    sendCustomerMail(params, assigned, start, endShown);   // お客様への案内は60分表示（確保は90分）

    // ⑤ スプレッドシートに記録
    recordReservation(params, assigned, start, endShown);   // 台帳は表示と同じ60分（実際の確保90分はカレンダー側が持つ）

    // ⑥ キャッシュ更新
    invalidateCache();

    // ⑦ レート制限カウンタ加算（予約成立時のみ）
    markReservationSuccess(guard);

    return { success:true, trainerName: assigned.name, trainerId: assigned.id };

  } catch(e) {
    return { success:false, message: e.message };
  } finally {
    lock.releaseLock();
  }
}

// ── スタッフLINEグループへ予約通知 ──
function sendLineReservationNotice(params, trainer, start, end) {
  var tz  = SETTINGS.TIMEZONE;
  var dow = ['日','月','火','水','木','金','土'][start.getDay()];
  var s   = Utilities.formatDate(start, tz, 'yyyy年MM月dd日') + '（' + dow + '）' + Utilities.formatDate(start, tz, 'HH:mm');
  var e   = Utilities.formatDate(end,   tz, 'HH:mm');

  var utmSource   = params.utmSource   || 'direct';
  var utmMedium   = params.utmMedium   || 'none';
  var utmCampaign = params.utmCampaign || 'none';

  var text =
    '【新規体験予約】\n\n' +
    'お名前：' + params.customerName + ' 様\n' +
    '日時：' + s + '〜' + e + '\n' +
    '担当：' + trainer.name + '\n' +
    '電話：' + params.customerPhone + '\n' +
    (params.customerNote ? '備考：' + params.customerNote + '\n' : '') +
    '\n流入元\n' +
    'ソース：' + utmSource + '\n' +
    'メディア：' + utmMedium + '\n' +
    'キャンペーン：' + utmCampaign + '\n' +
    (params.utmContent ? '広告CR：' + params.utmContent + '\n' : '') +
    (params.diagId     ? '診断ID：' + params.diagId     + '\n' : '') +
    (params.refDomain  ? '参照元：' + params.refDomain  + '\n' : '') +
    (params.gclid      ? '※Google広告クリック\n'                  : '') +
    '\nよろしくお願いします🙏';

  try {
    UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + LINE_CONFIG.TOKEN },
      payload: JSON.stringify({
        to: LINE_CONFIG.GROUP_ID,
        messages: [{ type: 'text', text: text }]
      }),
      muteHttpExceptions: true
    });
    Logger.log('LINE通知送信完了');
  } catch(err) {
    Logger.log('LINE通知エラー: ' + err.message);
  }
}

// ── 予約データ記録 ──
function recordReservation(params, trainer, start, end) {
  try {
    var ss = SpreadsheetApp.openById(SETTINGS.SPREADSHEET_ID);
    var sheet = ss.getSheetByName('reservations');
    // 末尾に列を追加する形にする（既存11列の位置は変えない＝過去データに影響しない）
    var RES_HEADERS = [
      '予約日時', 'お客様名', 'メール', '電話', '担当トレーナー', 'トレーナーID',
      '備考', 'utm_source', 'utm_medium', 'utm_campaign', '記録日時',
      '広告CR', '診断ID', 'gclid', '参照元'
    ];
    if (!sheet) {
      sheet = ss.insertSheet('reservations');
      sheet.getRange(1,1,1,RES_HEADERS.length).setValues([RES_HEADERS]);
    } else {
      // 列を増やした際に既存シートのヘッダーを補う（不足分を右端に足すだけ・既存列は触らない）
      var lastCol = sheet.getLastColumn();
      if (lastCol > 0 && lastCol < RES_HEADERS.length) {
        sheet.getRange(1, lastCol + 1, 1, RES_HEADERS.length - lastCol)
             .setValues([RES_HEADERS.slice(lastCol)]);
      }
    }
    var tz = SETTINGS.TIMEZONE;
    sheet.appendRow([
      Utilities.formatDate(start, tz, 'yyyy/MM/dd HH:mm'),
      sanitizeCell(params.customerName),
      sanitizeCell(params.customerEmail),
      sanitizeCell(params.customerPhone),
      trainer.name,
      trainer.id,
      sanitizeCell(params.customerNote || ''),
      sanitizeCell(params.utmSource   || 'direct'),
      sanitizeCell(params.utmMedium   || 'none'),
      sanitizeCell(params.utmCampaign || 'none'),
      Utilities.formatDate(new Date(), tz, 'yyyy/MM/dd HH:mm'),
      sanitizeCell(params.utmContent || ''),   // 広告CR＝Metaの広告名（どのCR由来かの特定）
      sanitizeCell(params.diagId     || ''),   // 診断ID（診断ログと突合して行動を追う）
      sanitizeCell(params.gclid      || ''),   // Google広告のクリックID（オフラインCVインポート用）
      sanitizeCell(params.refDomain  || '')    // 参照元ドメイン（LPで捕捉した真の流入元）
    ]);
  } catch(e) {
    Logger.log('予約記録エラー: ' + e.message);
  }
}

// ── お客様への確認メール ──
function sendCustomerMail(params, trainer, start, end) {
  var s      = Utilities.formatDate(start, SETTINGS.TIMEZONE, 'yyyy年MM月dd日（E）HH:mm');
  var e      = Utilities.formatDate(end,   SETTINGS.TIMEZONE, 'HH:mm');
  var mapUrl = 'https://share.google/WT75kEhN0OnW3SFd9';

  var body =
    params.customerName + ' 様\n\n' +
    'お世話になります。\n' +
    SETTINGS.GYM_NAME + 'の中野と申します。\n\n' +
    'この度は体験トレーニングのご予約をいただき、\n' +
    '誠にありがとうございます！\n\n' +
    '当日の詳細をお送りいたします。\n\n' +
    '◼️ 日時\n' +
    s + '〜 所要時間：60分\n' +
    'お時間ちょうど〜5分前頃にお越しください。\n\n' +
    '◼️ 場所\n' +
    SETTINGS.GYM_ADDRESS + '\n' +
    mapUrl + '\n\n' +
    '吉祥寺駅からサンロード商店街を通り抜け、住宅街をまっすぐお進みください。' +
    '後藤歯科医院の左横道に入り、右手に出てくる白いガラス張りの建物の奥にございます。' +
    '（吉祥寺駅より徒歩約10分）\n\n' +
    '◼️ 持ち物\n' +
    '手ぶらでOKです。\n' +
    'ウォーターサーバー・上下ウェア・シューズの貸し出しをご用意しておりますので、' +
    'お気軽にご利用ください。ご自身のものをお持ちいただいても構いません。\n\n' +
    '◼️ 体験料金\n' +
    '無料\n' +
    '※ 時期のキャンペーンにより条件が異なります。\n\n' +
    '◼️ 事前カウンセリングフォームのご記入のお願い\n' +
    '当日、より充実したセッションをご提供するために、\n' +
    '事前にお客様のお身体の状態やご要望をお聞かせいただけますと幸いです。\n' +
    'お時間のある際に、当日までにご回答いただけますと大変助かります。\n\n' +
    '▼ カウンセリングフォーム（所要3〜5分）\n' +
    'https://forms.gle/2FgagsPeXwwyVZf49\n\n' +
    'キャンセルやお時間の変更等がございましたら、\n' +
    '必ず事前にご連絡ください。\n\n' +
    '当日を楽しみにお待ちしております。\n' +
    'どうぞよろしくお願いいたします。\n\n' +
    '━━━━━━━━━━━━━━━\n' +
    SETTINGS.GYM_NAME + '\n' +
    'Tel : ' + SETTINGS.GYM_PHONE + '\n' +
    SETTINGS.GYM_ADDRESS + '\n' +
    '━━━━━━━━━━━━━━━';

  GmailApp.sendEmail(
    params.customerEmail,
    '【ご予約確認】体験トレーニングのご予約ありがとうございます | ' + SETTINGS.GYM_NAME,
    body,
    { name: SETTINGS.GYM_NAME }
  );
}

// ── 前日リマインドメール送信 ──
function sendReminderMails() {
  try {
    var ss    = SpreadsheetApp.openById(SETTINGS.SPREADSHEET_ID);
    var sheet = ss.getSheetByName('reservations');
    if (!sheet) { Logger.log('reservationsシートが存在しません'); return; }

    var tz       = SETTINGS.TIMEZONE;
    var tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    var data = sheet.getDataRange().getValues();
    var sent = 0;

    var tomorrowStart = new Date(tomorrow); tomorrowStart.setHours(0,0,0,0);
    var tomorrowEnd   = new Date(tomorrow); tomorrowEnd.setHours(23,59,59,999);

    for (var i = 1; i < data.length; i++) {
      var row           = data[i];
      var reservedAt    = row[0];
      var customerName  = row[1] || '';
      var customerEmail = row[2] || '';
      var trainerName   = row[4] || '';

      if (!customerEmail) continue;

      var reservedDate;
      if (reservedAt instanceof Date) {
        reservedDate = reservedAt;
      } else {
        reservedDate = new Date(reservedAt);
      }
      if (isNaN(reservedDate.getTime())) continue;
      if (reservedDate < tomorrowStart || reservedDate > tomorrowEnd) continue;

      var dow = ['日','月','火','水','木','金','土'][reservedDate.getDay()];
      var dateLabel = (reservedDate.getMonth()+1) + '月' + reservedDate.getDate() + '日（' + dow + '）' +
                      Utilities.formatDate(reservedDate, tz, 'HH:mm');
      var mapUrl = 'https://share.google/WT75kEhN0OnW3SFd9';

      var body =
        customerName + ' 様\n\n' +
        'お世話になります。\n' +
        SETTINGS.GYM_NAME + 'の中野と申します。\n\n' +
        '明日のご予約についてご確認のご連絡です。\n\n' +
        '◼️ 日時\n' +
        dateLabel + '〜 所要時間：60分\n' +
        'お時間ちょうど〜5分前頃にお越しください。\n\n' +
        '◼️ 担当トレーナー\n' +
        trainerName + '\n\n' +
        '◼️ 場所\n' +
        SETTINGS.GYM_ADDRESS + '\n' +
        mapUrl + '\n\n' +
        '吉祥寺駅からサンロード商店街を通り抜け、住宅街をまっすぐお進みください。' +
        '後藤歯科医院の左横道に入り、右手に出てくる白いガラス張りの建物の奥にございます。' +
        '（吉祥寺駅より徒歩約10分）\n\n' +
        '◼️ 持ち物\n' +
        '手ぶらでOKです。\n' +
        'ウォーターサーバー・上下ウェア・シューズの貸し出しをご用意しておりますので、' +
        'お気軽にご利用ください。ご自身のものをお持ちいただいても構いません。\n\n' +
        '◼️ 体験料金\n' +
        '無料\n' +
        '※ 時期のキャンペーンにより条件が異なります。\n\n' +
        '◼️ 事前カウンセリングフォームについて\n' +
        'まだご回答いただいていない方は、カウンセリング時までにご回答いただけますと幸いです。\n' +
        'お客様のお身体の状態やご要望をあらかじめ把握することで、\n' +
        '当日のセッションをよりお客様に合った内容でご提供できます。\n\n' +
        '▼ カウンセリングフォーム（所要3〜5分）\n' +
        'https://forms.gle/2FgagsPeXwwyVZf49\n\n' +
        'キャンセルやお時間の変更等がございましたら、\n' +
        '必ず事前にご連絡ください。\n\n' +
        '明日お会いできることを楽しみにしております。\n' +
        'どうぞよろしくお願いいたします。\n\n' +
        '━━━━━━━━━━━━━━━\n' +
        SETTINGS.GYM_NAME + '\n' +
        'Tel : ' + SETTINGS.GYM_PHONE + '\n' +
        SETTINGS.GYM_ADDRESS + '\n' +
        '━━━━━━━━━━━━━━━';

      GmailApp.sendEmail(
        customerEmail,
        '【明日のご予約確認】体験トレーニングのご予約について | ' + SETTINGS.GYM_NAME,
        body,
        { name: SETTINGS.GYM_NAME }
      );
      sent++;
      Logger.log('リマインド送信: ' + customerName + ' / ' + customerEmail);
    }
    Logger.log('リマインドメール送信完了: ' + sent + '件');
  } catch(e) {
    Logger.log('リマインドメールエラー: ' + e.message);
  }
}

// ── parkfit予約一括移行（手動実行・1回のみ）──
function migrateParkfitReservations() {
  var PARKFIT_CALENDAR_ID = 'parkfit.kichijoji@gmail.com';
  var START_DATE = new Date('2026-02-01T00:00:00+09:00');
  var END_DATE   = new Date('2026-03-30T23:59:59+09:00');
  var tz = SETTINGS.TIMEZONE;
  try {
    var parkfitCal = CalendarApp.getCalendarById(PARKFIT_CALENDAR_ID);
    if (!parkfitCal) { Logger.log('parkfitカレンダーが取得できません。'); return; }
    var calB1 = CalendarApp.getCalendarById(CALENDAR_IDS.CAPACITY_B1);
    if (!calB1) { Logger.log('地下キャパシティカレンダーが取得できません。'); return; }
    var events = parkfitCal.getEvents(START_DATE, END_DATE);
    Logger.log('parkfitイベント取得: ' + events.length + '件');
    var migrated = 0, skipped = 0;
    for (var i = 0; i < events.length; i++) {
      var ev    = events[i];
      var title = ev.getTitle();
      var start = ev.getStartTime();
      var end   = ev.getEndTime();
      var existing = calB1.getEvents(start, end);
      if (existing.length > 0) { skipped++; continue; }
      calB1.createEvent('[MIGRATED] ' + title, start, end, { description: 'parkfitから移行 / 元タイトル：' + title });
      migrated++;
    }
    Logger.log('移行: ' + migrated + '件 / スキップ: ' + skipped + '件');
  } catch(e) {
    Logger.log('移行エラー: ' + e.message);
  }
}

// ── トリガーセットアップ ──
//
//   ★★この関数は**実行してはいけない**（2026-10-09・Codex関門①で発覚）。
//     作られた当時はトリガーが3本しか無かった。いまは18本ある。
//     `getProjectTriggers()` を**名前で絞らずに全部消し、3本しか戻さない。**
//     実行すると次が丸ごと止まる：
//       押し出し（写しの更新・二重書き）／作業依頼／カレンダー同期／
//       予約のうながし／固定枠の自動予約／シフト連絡／日次点検／完全同期
//     ＝顧客の残数が固まり、リマインドが届かず、予約が自動で作られない。
//
//   ★しかも日次点検が「setupTriggers を実行し直すと戻ります」と案内していた
//     （2026-10-09 に修正）。**案内どおりに実行すると大事故になる。**
//
//   残す理由：消すと「昔の記録に出てくる関数が無い」ことになり、
//   調べる人が混乱する。**実行を拒否する形で残す。**
function setupTriggers() {
  var msg = '🚨 この関数は実行できません。'
    + '名前で絞らずに全部のトリガーを消し、3本しか戻さないためです'
    + '（いま18本あります）。'
    + '必要な定期処理を入れ直すには、用途ごとの関数を使ってください：'
    + 'setupEdgeTrigger（押し出し）／setupEdgeJobTrigger（作業依頼）／'
    + 'setupCalSyncTrigger（カレンダー同期）／setupNudgeTrigger（うながし）／'
    + 'setupRecurringTriggers（固定枠・シフト）／setupLineTriggers（その他）。';
  Logger.log(msg);
  throw new Error(msg);
}

//   昔の3本だけを入れ直したいとき用（★全部消さない）。
//   名前で絞って、その3つだけを作り直す。
function setupBasicTriggersOnly() {
  var names = { warmupCache: 1, sendReminderMails: 1, sendLineReminders: 1 };
  var all = ScriptApp.getProjectTriggers(), removed = 0;
  for (var i = 0; i < all.length; i++) {
    if (names[all[i].getHandlerFunction()]) { ScriptApp.deleteTrigger(all[i]); removed++; }
  }
  ScriptApp.newTrigger('warmupCache').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('sendReminderMails').timeBased().everyDays(1).atHour(9).inTimezone(SETTINGS.TIMEZONE).create();
  ScriptApp.newTrigger('sendLineReminders').timeBased().everyDays(1).atHour(12).inTimezone(SETTINGS.TIMEZONE).create();
  var line = '基本の3本を入れ直しました（消した ' + removed + ' 本・ほかのトリガーには触っていません）';
  Logger.log(line);
  return line;
}

function testLineNotice() {
  var start = new Date();
  var end   = new Date(start.getTime() + 75 * 60000);
  var params = { customerName: 'テスト', customerPhone: '090-0000-0000', customerNote: '' };
  var trainer = CALENDAR_IDS.TRAINERS[1];
  sendLineReservationNotice(params, trainer, start, end);
}

function testCustomerMail() {
  var start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(11, 0, 0, 0);
  var end = new Date(start.getTime() + SETTINGS.SESSION_MINUTES * 60000);

  var params = {
    customerName:  'テスト 太郎',
    customerEmail: 'tokowaka.fitness@gmail.com',  // 送信先（必要に応じて変更）
    customerPhone: '090-0000-0000',
    customerNote:  'テスト送信です'
  };
  var trainer = CALENDAR_IDS.TRAINERS[1]; // 鈴木
  sendCustomerMail(params, trainer, start, end);
  Logger.log('テストメール送信完了: tokowaka.fitness@gmail.com');
}

function authorizeAll() {
  UrlFetchApp.fetch('https://www.google.com');
}