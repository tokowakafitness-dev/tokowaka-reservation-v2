// ============================================================
// 予約を促すリマインド（Nudge）— 顧客への「催促」系の発信をここに1本化する
//
//   A. 予約が途切れている方へ（lbNudgeIdleRun）
//      直近の来店から一定日数が経ち、かつ未来の予約が1件も無い会員へ、予約を促す。
//      セッション後にトレーナーが次回予約を案内しているが、その場で取らない方が忘れてしまう。
//
//   B. 毎月25日「翌月分の予約が解放されました」（lbNudgeMonthOpenRun）
//      20日にシフト提出 → 25日に翌月分が解禁される運用。翌月に使える回数がある会員へ知らせる。
//      ホームの残数は「今日」基準なので、25日以降は「今月0回」と見えて予約できないと誤解される
//      （next-month-notice.test.js と同じ実害の、通知側からの手当て）。
//
// ★設計の柱（ここを崩すと顧客に実害が出る）
//   ① 既定は「送らない」。Script Properties の LB_REMIND_ON が '1' のときだけ実送信する。
//      顧客への発信はオーナー承認が必要（憲法第3節-3）。CEO/CIの判断で有効化しない。
//   ② 「送らずに一覧するだけ」を主たる入口にする（lbNudgePreview）。
//      オーナーが中身を見て文面と条件を決めるまでは、これしか使わない。
//   ③ 同じ人へ繰り返さない。nudge_log に送信記録を残し、A は日数、B は「その月に送ったか」で抑止する。
//   ④ トリガーは1日1回だけ（lbNudgeDaily）。
//      このシステムでは以前1分/10分ごとのトリガーを増やした結果、GASの応答が2倍以上遅くなり
//      顧客に実害が出た。分/時間ごとのトリガーはこのファイルに一切書かない（回帰テストで固定）。
//   ⑤ 出力に個人情報を残さない。一覧・ログ・戻り値は顧客IDの下4桁だけで示し、氏名と
//      lineUserId は外へ出さない（_lbNudgeMask / _lbNudgePublic）。
//   ⑥ fail-closed。名簿や予約台帳が読めない＝誰が対象か判断できない、なので送らない。
//      1人分のデータ不備では止めず、その行だけ記録して他の会員の分は続ける（sendLineReminders と同方針）。
//
// ★Script Properties（すべて省略可・既定値はコード側。値はオーナーが決める）
//   LB_REMIND_ON            '1' のときだけ実送信。未設定＝一覧のみ（既定）
//   LB_NUDGE_IDLE_DAYS      A：最終来店から何日で促すか（既定 3）
//   LB_NUDGE_IDLE_MAX_DAYS  A：これより長く空いた人は対象外（既定 0＝上限なし）
//   LB_NUDGE_COOLDOWN_DAYS  A：同じ人へ再送するまでの間隔（既定 14）
//   LB_NUDGE_OPEN_DAY       B：翌月分の解放日（既定 25）
//   LB_NUDGE_MAX_PER_RUN    1回の実行で送る上限（既定 50・初回有効化の暴走防止）
// ============================================================

var LB_NUDGE_LOG_SHEET = 'nudge_log';   // 送信記録（再送抑止の正本）
var LB_NUDGE_LOG_COLS = 6;              // 送信日時 / 種別 / customer_id / 対象キー / 結果 / 詳細
var LB_NUDGE_LOG_SCAN = 3000;           // 再送判定で見る直近行数（新しい行が上＝これで足りる）

// 既定値。プロパティで上書きできるが、「送らない」側の既定は変えない。
var LB_NUDGE_DEFAULTS = { idleDays: 3, idleMaxDays: 0, cooldownDays: 14, openDay: 25, maxPerRun: 50 };

var LB_NUDGE_KIND = { IDLE: 'nudge_idle', MONTH_OPEN: 'nudge_month_open' };

// ------------------------------------------------------------
// 文面（4言語）。オーナーが直す前提の草案。ここだけ見れば全文が分かるようにしてある。
//   ・氏名は入れない（宛先は1:1のトーク＝本人にしか届かない。出力・ログをPIIゼロに保つため）
//   ・{d}=空いた日数 / {m}=月 / {n}=予約できる回数 / {u}=予約画面のURL
// ------------------------------------------------------------
var _LB_NUDGE_MSG = {
  idle_title: {
    ja: '【次回のご予約について】',
    en: '[Booking your next session]',
    zh: '【关于下次预约】',
    'zh-Hant': '【關於下次預約】'
  },
  idle_body: {
    ja: '前回のご来店から{d}日が経ちました。次のご予約がまだ入っていないようです。',
    en: "It has been {d} days since your last session, and we don't see a booking coming up.",
    zh: '距离上次到店已过{d}天，目前还没有看到您的下次预约。',
    'zh-Hant': '距離上次蒞臨已過{d}天，目前還沒有看到您的下次預約。'
  },
  idle_reason: {
    ja: '間隔が空くほど、積み上げた成果は戻りやすくなります。週のペースを保つことが一番の近道です。',
    en: 'The longer the gap, the more of your progress slips away. Keeping a steady weekly rhythm is the fastest route.',
    zh: '间隔越久，已积累的成果越容易回退。保持每周的节奏是最快的捷径。',
    'zh-Hant': '間隔越久，已累積的成果越容易回退。保持每週的節奏是最快的捷徑。'
  },
  idle_cta: {
    ja: '▼ご予約はこちら（1分ほどで完了します）',
    en: '▼ Book here (takes about a minute)',
    zh: '▼ 请从这里预约（约1分钟即可完成）',
    'zh-Hant': '▼ 請從這裡預約（約1分鐘即可完成）'
  },
  idle_tail: {
    ja: 'ご都合が合わない、体調が優れないなどございましたら、担当トレーナーへお気軽にご相談ください。',
    en: 'If the timing is difficult or you are not feeling well, please let your trainer know any time.',
    zh: '如时间不便或身体不适，请随时联系您的教练。',
    'zh-Hant': '如時間不便或身體不適，請隨時聯繫您的教練。'
  },
  open_title: {
    ja: '【{m}月分のご予約を受付開始しました】',
    en: '[Bookings for {m} are now open]',
    zh: '【{m}月的预约已开放】',
    'zh-Hant': '【{m}月的預約已開放】'
  },
  open_body: {
    ja: '{m}月のセッションがご予約いただけるようになりました。ご予約可能回数は{n}回です。',
    en: 'Sessions for {m} can now be booked. You have {n} session(s) available.',
    zh: '{m}月的课程现已可以预约。您可预约{n}次。',
    'zh-Hant': '{m}月的課程現已可以預約。您可預約{n}次。'
  },
  open_reason: {
    ja: 'ご希望のお時間は早い順に埋まります。先に{m}月分をまとめてお取りいただくと、ペースが崩れません。',
    en: 'Popular times fill up first. Booking your {m} sessions together keeps your rhythm steady.',
    zh: '热门时段会先被预约。建议先把{m}月的课程一并预约，以保持节奏。',
    'zh-Hant': '熱門時段會先被預約。建議先把{m}月的課程一併預約，以保持節奏。'
  },
  open_cta: {
    ja: '▼ご予約はこちら（まとめて予約もできます）',
    en: '▼ Book here (you can book several at once)',
    zh: '▼ 请从这里预约（可批量预约）',
    'zh-Hant': '▼ 請從這裡預約（可批次預約）'
  },
  open_tail: {
    ja: 'ご希望の時間が空いていない場合は、担当トレーナーへご相談ください。',
    en: 'If your preferred time is unavailable, please ask your trainer.',
    zh: '如所需时段已满，请联系您的教练。',
    'zh-Hant': '如所需時段已滿，請聯繫您的教練。'
  }
};

// 文面の取り出し（_lbSt と同じ作り。辞書だけ別にして、LineBooking.js を太らせない）
function _lbNudgeMsg(lang, key, vars) {
  var e = _LB_NUDGE_MSG[key];
  var l = _lbNormLang(lang);
  var s = e ? (e[l] != null ? e[l] : e.ja) : key;
  if (typeof s === 'string' && vars) s = s.replace(/\{(\w+)\}/g, function (_, k) { return (vars[k] != null) ? vars[k] : ''; });
  return s;
}

// 予約画面（LIFF）の入口。_lbWelcomeText と同じ組み立て。
function _lbNudgeLiffUrl() {
  var liffId = _lbProp('LINE_LIFF_ID') || '2010827953-QgBQFzh9';
  return 'https://liff.line.me/' + liffId;
}

function _lbNudgeIdleText(lang, daysIdle) {
  return _lbNudgeMsg(lang, 'idle_title') +
    '\n' + _lbNudgeMsg(lang, 'idle_body', { d: daysIdle }) +
    '\n' + _lbNudgeMsg(lang, 'idle_reason') +
    '\n\n' + _lbNudgeMsg(lang, 'idle_cta') +
    '\n' + _lbNudgeLiffUrl() +
    '\n\n' + _lbNudgeMsg(lang, 'idle_tail');
}

function _lbNudgeOpenText(lang, month, total) {
  return _lbNudgeMsg(lang, 'open_title', { m: month }) +
    '\n' + _lbNudgeMsg(lang, 'open_body', { m: month, n: total }) +
    '\n' + _lbNudgeMsg(lang, 'open_reason', { m: month }) +
    '\n\n' + _lbNudgeMsg(lang, 'open_cta') +
    '\n' + _lbNudgeLiffUrl() +
    '\n\n' + _lbNudgeMsg(lang, 'open_tail');
}

// ------------------------------------------------------------
// 小道具
// ------------------------------------------------------------
// 実送信の可否。既定は無効＝一覧だけ。オーナーが承認してプロパティを立てるまで送らない。
function _lbNudgeEnabled() { return _lbProp('LB_REMIND_ON') === '1'; }

// 数値プロパティ（空欄・壊れ値は既定へ倒す＝設定ミスで暴走しない）
function _lbNudgeNum(key, def) {
  var v = _lbProp(key);
  if (v === null || v === undefined || String(v) === '') return def;
  var n = Number(v);
  return (isFinite(n) && n >= 0) ? Math.floor(n) : def;
}

function _lbNudgeConf() {
  return {
    idleDays:     _lbNudgeNum('LB_NUDGE_IDLE_DAYS', LB_NUDGE_DEFAULTS.idleDays),
    idleMaxDays:  _lbNudgeNum('LB_NUDGE_IDLE_MAX_DAYS', LB_NUDGE_DEFAULTS.idleMaxDays),
    cooldownDays: _lbNudgeNum('LB_NUDGE_COOLDOWN_DAYS', LB_NUDGE_DEFAULTS.cooldownDays),
    openDay:      _lbNudgeNum('LB_NUDGE_OPEN_DAY', LB_NUDGE_DEFAULTS.openDay),
    maxPerRun:    _lbNudgeNum('LB_NUDGE_MAX_PER_RUN', LB_NUDGE_DEFAULTS.maxPerRun)
  };
}

// 顧客IDの下4桁だけを見せる（氏名・全体IDを出力に残さない・要件8）
function _lbNudgeMask(customerId) {
  var s = String(customerId || '');
  return '*' + (s.length > 4 ? s.slice(-4) : s);
}

// 対象一覧から内部情報（lineUserId・生の顧客ID）を落とす。外へ返すのは必ずこれを通す。
function _lbNudgePublic(plan) {
  var out = { kind: plan.kind, code: plan.code, month: plan.month, conf: plan.conf,
              skipped: plan.skipped, rowErrors: plan.rowErrors, examined: plan.examined, targets: [] };
  for (var i = 0; i < plan.targets.length; i++) {
    var t = plan.targets[i], o = { id: t.id, lang: t.lang };
    if (t.daysIdle != null) o.daysIdle = t.daysIdle;
    if (t.total != null) o.total = t.total;
    out.targets.push(o);
  }
  return out;
}

function _lbNudgeMonthKey(d) { return d.getFullYear() + '-' + ((d.getMonth() + 1) < 10 ? '0' : '') + (d.getMonth() + 1); }

// 翌月の中旬（＝確実にその月）。残数を「翌月時点」で出すために使う（_lbBuildHome と同じ手）。
function _lbNudgeNextMonthDate(now) { return new Date(now.getFullYear(), now.getMonth() + 1, 15, 12, 0, 0); }

// ------------------------------------------------------------
// 送信記録（nudge_log）— 再送抑止の正本。氏名は書かない（customer_id のみ）。
// ------------------------------------------------------------
function _lbNudgeLogSheet() {
  var ss = _lbSs();
  var sh = ss.getSheetByName(LB_NUDGE_LOG_SHEET) || ss.insertSheet(LB_NUDGE_LOG_SHEET);
  if (sh.getLastRow() === 0 || sh.getLastColumn() < LB_NUDGE_LOG_COLS) {
    sh.getRange(1, 1, 1, LB_NUDGE_LOG_COLS)
      .setValues([['送信日時', '種別', 'customer_id', '対象キー', '結果', '詳細']]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

// 種別ごとに「誰へ・いつ・どの月分を送ったか」を引く。
//   結果が sent の行だけ数える＝未達（LINE側で弾かれた）は送ったことにしない＝翌日また試せる。
function _lbNudgeLogRead(kind) {
  var out = {};
  try {
    var sh = _lbSheet(LB_NUDGE_LOG_SHEET);
    if (!sh || sh.getLastRow() < 2) return out;
    var n = Math.min(LB_NUDGE_LOG_SCAN, sh.getLastRow() - 1);
    var v = sh.getRange(2, 1, n, LB_NUDGE_LOG_COLS).getValues();
    for (var i = 0; i < v.length; i++) {
      if (String(v[i][1]) !== kind) continue;
      if (String(v[i][4]) !== 'sent') continue;
      var cid = String(v[i][2] || ''); if (!cid) continue;
      var e = out[cid] || (out[cid] = { lastMs: null, keys: {} });
      var d = _lbParseResvDate(String(v[i][0] || '').replace(/^'/, ''));   // 文字列固定のため先頭 ' を外す
      if (d) { var ms = d.getTime(); if (e.lastMs === null || ms > e.lastMs) e.lastMs = ms; }
      var k = String(v[i][3] || ''); if (k) e.keys[k] = true;
    }
  } catch (e) { Logger.log('nudge_log 読み取り失敗（送信は中止せず、この実行では抑止を効かせない）: ' + e.message); }
  return out;
}

// まとめて1回で書く（1人ずつ insert すると人数ぶんシート往復が増える）
function _lbNudgeLogWrite(kind, rows, nowMs) {
  if (!rows || !rows.length) return;
  try {
    var sh = _lbNudgeLogSheet();
    var when = Utilities.formatDate(new Date(nowMs), SETTINGS.TIMEZONE, 'yyyy/MM/dd HH:mm');
    var out = rows.map(function (r) {
      return ["'" + when, kind, r.customerId, r.key || '', r.result, String(r.detail || '').slice(0, 200)];
    });
    sh.insertRowsAfter(1, out.length);   // 新しい行を上に（reminder_status と同方針）
    sh.getRange(2, 1, out.length, LB_NUDGE_LOG_COLS).setValues(out);
  } catch (e) { Logger.log('nudge_log 記録失敗: ' + e.message); }
}

// ------------------------------------------------------------
// 会員名簿と予約台帳（どちらも1回だけ読む）
// ------------------------------------------------------------
// 名簿。読めなければ null（＝誰が対象か判断できない → 送らない）
function _lbNudgeMembers() {
  var sh = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (!sh) return null;
  var last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, MAP_COL.LANG).getValues();
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    var r = vals[i];
    out.push({
      lineUserId:   String(r[MAP_COL.LINE_USER_ID - 1] || ''),
      customerId:   String(r[MAP_COL.CUSTOMER_ID - 1] || ''),
      name:         String(r[MAP_COL.NAME - 1] || ''),
      contractStat: String(r[MAP_COL.CONTRACT_STAT - 1] || ''),
      authState:    String(r[MAP_COL.AUTH_STATE - 1] || ''),
      lang:         _lbNormLang(r[MAP_COL.LANG - 1])
    });
  }
  return out;
}

// 予約台帳から会員ごとに「最後の来店」と「未来の予約の数」を作る。読めなければ null。
//   有効な行＝confirmed（予約中）／consumed（消化済み）。cancelled・changed は来店にも未来にも数えない。
function _lbNudgeResvIndex(nowMs) {
  var sh = _lbSheet(LINE_BOOKING.RESV_SHEET);
  if (!sh) return null;
  var last = sh.getLastRow();
  if (last < 2) return {};
  var vals = sh.getRange(2, 1, last - 1, Math.max(12, sh.getLastColumn())).getValues();
  var idx = {};
  for (var i = 0; i < vals.length; i++) {
    var r = vals[i];
    var st = String(r[6]);
    if (st !== 'confirmed' && st !== 'consumed') continue;
    var cid = String(r[2] || ''); if (!cid) continue;
    var dt = _lbParseResvDate(r[0]); if (!dt) continue;
    var t = dt.getTime();
    var e = idx[cid] || (idx[cid] = { lastMs: null, futureCount: 0 });
    if (t <= nowMs) { if (e.lastMs === null || t > e.lastMs) e.lastMs = t; }
    else e.futureCount++;
  }
  return idx;
}

// 名簿の行が「そもそも発信していい相手か」。ここを緩めない（未認証・契約切れへは送らない）。
function _lbNudgeEligible(m, skipped) {
  if (!m.customerId)                { skipped.noCustomerId++; return false; }
  if (m.authState !== 'verified')   { skipped.notVerified++;  return false; }
  if (m.contractStat !== 'active')  { skipped.notActive++;    return false; }   // 空欄も対象外（判定不能＝送らない）
  if (!m.lineUserId)                { skipped.noLine++;       return false; }
  return true;
}

// 対象日時点で予約に使える回数。null＝算出できない（送らない側に倒す）
function _lbNudgeAvailable(m, targetMs) {
  var h = _lbBuildHome(m.customerId, m.name, m.lang, targetMs);
  if (!h || !h.type) return 0;                     // 契約なし／要確認 → 促す相手ではない
  var mr = (h.monthlyRemaining == null) ? null : Number(h.monthlyRemaining);
  var tr = Number(h.ticketRemaining || 0);
  if (h.type === 'ticket') return tr;
  if (mr === null) return null;                    // 月額枠が不明（degraded）＝判定保留
  return mr + tr;
}

// ============================================================
// A. 予約が途切れている方の一覧（送らない）
// ============================================================
function lbNudgePlanIdle(nowMs) {
  var now = (nowMs != null) ? new Date(nowMs) : new Date();   // 引数はテスト／確認で「今」を固定するため。本番は省略。
  var ms = now.getTime();
  var conf = _lbNudgeConf();
  var plan = { kind: LB_NUDGE_KIND.IDLE, code: 'OK', conf: conf, targets: [], rowErrors: [], examined: 0,
               skipped: { noCustomerId: 0, notVerified: 0, notActive: 0, noLine: 0, noHistory: 0,
                          hasFuture: 0, tooSoon: 0, tooOld: 0, noQuota: 0, quotaUnknown: 0, cooldown: 0 } };

  var members = _lbNudgeMembers();
  if (members === null) { plan.code = 'NO_MAP_SHEET'; return plan; }
  var resv = _lbNudgeResvIndex(ms);
  if (resv === null) { plan.code = 'NO_RESV_SHEET'; return plan; }   // 台帳が無い＝来店も未来も分からない → 送らない
  var log = _lbNudgeLogRead(LB_NUDGE_KIND.IDLE);

  for (var i = 0; i < members.length; i++) {
    var m = members[i];
    plan.examined++;
    try {
      if (!_lbNudgeEligible(m, plan.skipped)) continue;
      var e = resv[m.customerId];
      if (!e || e.lastMs === null) { plan.skipped.noHistory++; continue; }   // 一度も来ていない＝この施策の対象外
      if (e.futureCount > 0)       { plan.skipped.hasFuture++; continue; }   // 次が入っている＝促す必要がない
      var daysIdle = Math.floor((ms - e.lastMs) / 86400000);
      if (daysIdle < conf.idleDays) { plan.skipped.tooSoon++; continue; }
      if (conf.idleMaxDays > 0 && daysIdle > conf.idleMaxDays) { plan.skipped.tooOld++; continue; }
      var le = log[m.customerId];
      if (le && le.lastMs !== null && (ms - le.lastMs) < conf.cooldownDays * 86400000) { plan.skipped.cooldown++; continue; }
      var avail = _lbNudgeAvailable(m, ms);
      if (avail === null) { plan.skipped.quotaUnknown++; continue; }
      if (avail <= 0)     { plan.skipped.noQuota++; continue; }               // 使える回数が無い人に「予約して」と言わない
      plan.targets.push({ id: _lbNudgeMask(m.customerId), lang: m.lang, daysIdle: daysIdle,
                          _to: m.lineUserId, _cid: m.customerId, _key: '', _text: _lbNudgeIdleText(m.lang, daysIdle) });
    } catch (err) {
      // ★1人分の不備（残数データ不整合など）で全員分を止めない。氏名は残さない。
      plan.rowErrors.push(_lbNudgeMask(m.customerId) + ': ' + err.message);
      Logger.log('nudge(idle) 1件失敗（他は継続）: ' + err.message);
    }
  }
  return plan;
}

// ============================================================
// B. 翌月分の解放案内の一覧（送らない）
// ============================================================
function lbNudgePlanMonthOpen(nowMs) {
  var now = (nowMs != null) ? new Date(nowMs) : new Date();
  var ms = now.getTime();
  var conf = _lbNudgeConf();
  var nm = _lbNudgeNextMonthDate(now);
  var plan = { kind: LB_NUDGE_KIND.MONTH_OPEN, code: 'OK', conf: conf, month: nm.getMonth() + 1,
               monthKey: _lbNudgeMonthKey(nm), targets: [], rowErrors: [], examined: 0,
               skipped: { noCustomerId: 0, notVerified: 0, notActive: 0, noLine: 0,
                          noQuota: 0, quotaUnknown: 0, alreadyThisMonth: 0 } };

  var members = _lbNudgeMembers();
  if (members === null) { plan.code = 'NO_MAP_SHEET'; return plan; }
  var log = _lbNudgeLogRead(LB_NUDGE_KIND.MONTH_OPEN);

  for (var i = 0; i < members.length; i++) {
    var m = members[i];
    plan.examined++;
    try {
      if (!_lbNudgeEligible(m, plan.skipped)) continue;
      var le = log[m.customerId];
      if (le && le.keys[plan.monthKey]) { plan.skipped.alreadyThisMonth++; continue; }   // その月は送り済み＝冪等
      var avail = _lbNudgeAvailable(m, nm.getTime());   // 「翌月時点」で使える回数（今月の残数ではない）
      if (avail === null) { plan.skipped.quotaUnknown++; continue; }
      if (avail <= 0)     { plan.skipped.noQuota++; continue; }
      plan.targets.push({ id: _lbNudgeMask(m.customerId), lang: m.lang, total: avail,
                          _to: m.lineUserId, _cid: m.customerId, _key: plan.monthKey,
                          _text: _lbNudgeOpenText(m.lang, plan.month, avail) });
    } catch (err) {
      plan.rowErrors.push(_lbNudgeMask(m.customerId) + ': ' + err.message);
      Logger.log('nudge(monthOpen) 1件失敗（他は継続）: ' + err.message);
    }
  }
  return plan;
}

// ============================================================
// 送信（ここだけが実際にLINEへ出す。既定は無効なので何もしない）
// ============================================================
function _lbNudgeSend(plan, nowMs) {
  var res = { success: true, kind: plan.kind, enabled: _lbNudgeEnabled(), sent: 0, failed: 0, deferred: 0,
              plan: _lbNudgePublic(plan) };
  if (plan.code !== 'OK') { Logger.log('nudge 中止: ' + plan.code); return res; }
  if (!res.enabled) {
    // ★既定の道。ここで必ず止まる。記録も残さない（あとで有効にしたとき抑止が誤作動しないように）。
    Logger.log('nudge ' + plan.kind + ' は無効（LB_REMIND_ON≠1）。対象' + plan.targets.length + '名を一覧しただけで送信していません。');
    return res;
  }
  var cap = plan.conf.maxPerRun;
  var rows = [];
  for (var i = 0; i < plan.targets.length; i++) {
    var t = plan.targets[i];
    if (cap > 0 && (res.sent + res.failed) >= cap) { res.deferred++; continue; }   // 残りは翌日の実行へ
    var ok = false;
    try { ok = _lbPush(t._to, t._text, plan.kind); } catch (e) { Logger.log('nudge push例外: ' + e.message); }
    if (ok) res.sent++; else res.failed++;
    rows.push({ customerId: t._cid, key: t._key, result: ok ? 'sent' : 'failed', detail: ok ? '' : 'push未達' });
    Utilities.sleep(250);   // 連続送信で429を招かない間隔（sendLineReminders と同じ）
  }
  _lbNudgeLogWrite(plan.kind, rows, nowMs != null ? nowMs : new Date().getTime());
  Logger.log('nudge ' + plan.kind + ': ' + JSON.stringify({ sent: res.sent, failed: res.failed, deferred: res.deferred }));
  return res;
}

function lbNudgeIdleRun(nowMs)      { var ms = (nowMs != null) ? nowMs : new Date().getTime(); return _lbNudgeSend(lbNudgePlanIdle(ms), ms); }
function lbNudgeMonthOpenRun(nowMs) { var ms = (nowMs != null) ? nowMs : new Date().getTime(); return _lbNudgeSend(lbNudgePlanMonthOpen(ms), ms); }

// ============================================================
// ★オーナー確認用：送らずに「誰に何を送るか」だけ出す（主たる納品物）
//   GASエディタで lbNudgePreview を実行 → ログに一覧が出る。1通も送らない。
// ============================================================
function lbNudgePlan(nowMs) {
  var ms = (nowMs != null) ? nowMs : new Date().getTime();
  return { asOf: Utilities.formatDate(new Date(ms), SETTINGS.TIMEZONE, 'yyyy/MM/dd HH:mm'),
           enabled: _lbNudgeEnabled(),
           idle: _lbNudgePublic(lbNudgePlanIdle(ms)),
           monthOpen: _lbNudgePublic(lbNudgePlanMonthOpen(ms)) };
}

function lbNudgePreview(nowMs) {
  var ms = (nowMs != null) ? nowMs : new Date().getTime();
  var conf = _lbNudgeConf();
  var out = [];
  out.push('=== 予約を促すリマインド 一覧（送信しません） ' + Utilities.formatDate(new Date(ms), SETTINGS.TIMEZONE, 'yyyy/MM/dd HH:mm') + ' ===');
  out.push('実送信: ' + (_lbNudgeEnabled() ? '⚠️ 有効（LB_REMIND_ON=1）' : '無効（既定）— この一覧を見て決めてください'));
  out.push('設定: 途切れ' + conf.idleDays + '日／再送間隔' + conf.cooldownDays + '日／解放日' + conf.openDay + '日／1回上限' + conf.maxPerRun + '通'
    + (conf.idleMaxDays > 0 ? '／空き上限' + conf.idleMaxDays + '日' : '／空き上限なし'));
  out.push('※氏名は出しません。会員は顧客IDの下4桁で示します。');

  var a = lbNudgePlanIdle(ms);
  out.push('');
  out.push('── A. 予約が途切れている方（' + a.code + '）: ' + a.targets.length + '名 ／ 名簿' + a.examined + '件を確認');
  for (var i = 0; i < a.targets.length; i++) out.push('   ・' + a.targets[i].id + '（' + a.targets[i].lang + '・最終来店から' + a.targets[i].daysIdle + '日）');
  if (!a.targets.length) out.push('   （該当なし）');
  out.push('   対象外: ' + _lbNudgeSkipText(a.skipped));
  if (a.rowErrors.length) out.push('   ⚠️ 判定できなかった会員: ' + a.rowErrors.join(' / '));
  if (a.targets.length) { out.push('   ▼送る文面（日本語）'); out.push(_lbNudgeIndent(_lbNudgeIdleText('ja', a.targets[0].daysIdle))); }

  var b = lbNudgePlanMonthOpen(ms);
  out.push('');
  out.push('── B. ' + b.month + '月分の予約解放（' + b.code + '）: ' + b.targets.length + '名 ／ 名簿' + b.examined + '件を確認');
  for (var j = 0; j < b.targets.length; j++) out.push('   ・' + b.targets[j].id + '（' + b.targets[j].lang + '・' + b.targets[j].total + '回 予約可）');
  if (!b.targets.length) out.push('   （該当なし）');
  out.push('   対象外: ' + _lbNudgeSkipText(b.skipped));
  if (b.rowErrors.length) out.push('   ⚠️ 判定できなかった会員: ' + b.rowErrors.join(' / '));
  if (b.targets.length) { out.push('   ▼送る文面（日本語）'); out.push(_lbNudgeIndent(_lbNudgeOpenText('ja', b.month, b.targets[0].total))); }

  var txt = out.join('\n');
  Logger.log(txt);
  return txt;
}

var _LB_NUDGE_SKIP_LABEL = {
  noCustomerId: '顧客ID未設定', notVerified: '未認証', notActive: '契約が有効でない', noLine: 'LINE未連携',
  noHistory: '来店履歴なし', hasFuture: '次の予約が入っている', tooSoon: 'まだ日数が経っていない',
  tooOld: '空きすぎ（上限超え）', noQuota: '使える回数が0', quotaUnknown: '残数が算出できない',
  cooldown: '前回の案内から日が浅い', alreadyThisMonth: 'その月は送信済み'
};
function _lbNudgeSkipText(skipped) {
  var parts = [];
  for (var k in skipped) if (skipped[k]) parts.push((_LB_NUDGE_SKIP_LABEL[k] || k) + ' ' + skipped[k] + '名');
  return parts.length ? parts.join(' / ') : 'なし';
}
function _lbNudgeIndent(s) { return String(s).split('\n').map(function (l) { return '      | ' + l; }).join('\n'); }

// ============================================================
// 1日1回のトリガーの入口（★これ以外のトリガーは作らない）
//   ・A は毎日（条件側で「空いた日数」と再送間隔が効くので、毎日回しても増えない）
//   ・B は解放日（既定25日）だけ。取り逃しても月キーで冪等なので、翌日以降の実行でも二重にならない。
// ============================================================
function lbNudgeDaily(nowMs) {
  var ms = (nowMs != null) ? nowMs : new Date().getTime();
  var now = new Date(ms);
  var conf = _lbNudgeConf();
  var res = { asOf: Utilities.formatDate(now, SETTINGS.TIMEZONE, 'yyyy/MM/dd HH:mm'), enabled: _lbNudgeEnabled() };
  try { res.idle = lbNudgeIdleRun(ms); } catch (e) { res.idleError = e.message; Logger.log('lbNudgeDaily idle失敗: ' + e.message); }
  if (now.getDate() === conf.openDay) {
    try { res.monthOpen = lbNudgeMonthOpenRun(ms); } catch (e2) { res.monthOpenError = e2.message; Logger.log('lbNudgeDaily monthOpen失敗: ' + e2.message); }
  }
  Logger.log('lbNudgeDaily: ' + JSON.stringify({ enabled: res.enabled,
    idle: res.idle ? { sent: res.idle.sent, failed: res.idle.failed } : null,
    monthOpen: res.monthOpen ? { sent: res.monthOpen.sent, failed: res.monthOpen.failed } : null }));
  return res;
}

// ------------------------------------------------------------
// トリガー登録（★オーナー承認後に、オーナーが1回だけ実行する。ここでは登録しない）
//   1日1回だけ。分ごと・時間ごとは作らない（過去に応答が2倍以上遅くなり顧客に実害が出た）。
//   時刻は既定10時。オーナーが決めたら atHour の数字を直す。
// ------------------------------------------------------------
function setupNudgeTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'lbNudgeDaily') ScriptApp.deleteTrigger(t);   // 重複登録防止
  });
  ScriptApp.newTrigger('lbNudgeDaily').timeBased().everyDays(1).atHour(10).inTimezone(SETTINGS.TIMEZONE).create();
  Logger.log('✅ 予約を促すリマインドを毎日10時に設定しました（実送信は LB_REMIND_ON=1 のときだけ）');
}
