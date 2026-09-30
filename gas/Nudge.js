// ============================================================
// 予約を促すリマインド（Nudge）— 顧客への「次の予約」を促す発信をここに1本化する
//
//   オーナーと詰め切った結果、送るものは4種になった（2026-09-30 確定仕様）。
//   同じ日に複数当たったら、**優先順位が上のものだけ**を送る（1人1日1通）。
//
//   ┌順┬種別───────────┬条件────────────────────────────────────────────┐
//   │1 │transfer 振替の案内 │昨日の予約が当日キャンセルで、振替権が未使用かつ有効期限内       │
//   │2 │month_open 翌月解放 │毎月25日・契約が有効                                    │
//   │3 │visit_b 来店翌日B   │昨日実際に来店・今月の未来予約が0件・月額残 > 0             │
//   │4 │visit_a 来店翌日A   │昨日実際に来店・今月の未来予約が1件以上・月額残 > 0・前回から7日以上│
//   └──┴──────────────┴────────────────────────────────────────────────┘
//
// ★当日キャンセルと実来店の見分け方（ここが本ファイルの肝）
//   予約台帳では当日キャンセルも `consumed` として残るため、状態だけでは来店と区別できない。
//   `transfer_credits`（当日キャンセルで1件付与・6日有効）の source_reservation_id に
//   昨日の予約IDが載っていれば**当日キャンセル**、載っていなければ**実来店**と判定する。
//   ※台帳の備考列は取消時に「resId|当日消化取消」となるため、'|' の手前で切って突き合わせる。
//
// ★設計の柱（ここを崩すと顧客に実害が出る）
//   ① 既定は「送らない」。Script Properties の LB_REMIND_ON が '1' のときだけ実送信する。
//      顧客への発信はオーナー承認が必要（憲法第3節-3）。CEO/CIの判断で有効化しない。
//   ② 「送らずに一覧するだけ」を主たる入口にする（lbNudgePreview）。
//      4種それぞれ何人が対象か、除外理由の内訳、優先順位で見送った分まで出す。
//   ③ 1人1日1通。優先順位で1つに絞る。絞って送らなかったものも一覧には出す。
//   ④ visit_a だけ同じ人へ7日空ける（nudge_log で抑止）。他の種別に週の上限は設けない。
//      month_open は「その月に送ったか」で冪等にする。
//   ⑤ トリガーは1日1回だけ（lbNudgeDaily）。
//      このシステムでは以前1分/10分ごとのトリガーを増やした結果、GASの応答が2倍以上遅くなり
//      顧客に実害が出た。分/時間ごとのトリガーはこのファイルに一切書かない（回帰テストで固定）。
//   ⑥ 出力に個人情報を残さない。一覧・ログ・戻り値は顧客IDの下4桁だけで示し、氏名と
//      lineUserId は外へ出さない（_lbNudgeMask / _lbNudgePublic）。
//   ⑦ fail-closed。名簿・予約台帳・振替権シートのいずれかが読めなければ1通も送らない。
//      1人分のデータ不備では止めず、その行だけ記録して他の会員の分は続ける（sendLineReminders と同方針）。
//
// ★言い回しの決まり（オーナー指示）
//   ・「消える」「残りわずか」などマイナス表現を使わない
//   ・「下記よりどうぞ」ではなく「下記よりお待ちしております」
//   ・敬体。上品なトーンを保つ
//   ・transfer には残数の話を入れない（振替のことだけにする）
//
// ★Script Properties（すべて省略可・既定値はコード側。値はオーナーが決める）
//   LB_REMIND_ON            '1' のときだけ実送信。未設定＝一覧のみ（既定）
//   LB_NUDGE_OPEN_DAY       翌月分の解放日（既定 25）
//   LB_NUDGE_VISIT_A_DAYS   visit_a を同じ人へ再送するまでの間隔（既定 7）
//   LB_NUDGE_MAX_PER_RUN    1回の実行で送る上限（既定 50・初回有効化の暴走防止）
// ============================================================

var LB_NUDGE_LOG_SHEET = 'nudge_log';   // 送信記録（再送抑止の正本）
var LB_NUDGE_LOG_COLS = 6;              // 送信日時 / 種別 / customer_id / 対象キー / 結果 / 詳細
var LB_NUDGE_LOG_SCAN = 3000;           // 再送判定で見る直近行数（新しい行が上＝これで足りる）

// 既定値。プロパティで上書きできるが、「送らない」側の既定は変えない。
var LB_NUDGE_DEFAULTS = { openDay: 25, visitADays: 7, maxPerRun: 50 };

var LB_NUDGE_KIND = {
  TRANSFER:   'nudge_transfer',
  MONTH_OPEN: 'nudge_month_open',
  VISIT_B:    'nudge_visit_b',
  VISIT_A:    'nudge_visit_a'
};
// ★優先順位。同じ日に複数当たったら、この並びで先頭のものだけを送る。
var LB_NUDGE_ORDER = [LB_NUDGE_KIND.TRANSFER, LB_NUDGE_KIND.MONTH_OPEN, LB_NUDGE_KIND.VISIT_B, LB_NUDGE_KIND.VISIT_A];
var LB_NUDGE_LABEL = {
  nudge_transfer:   '① 振替のご案内',
  nudge_month_open: '② 翌月分の解放',
  nudge_visit_b:    '③ 来店翌日B（今月の予約なし）',
  nudge_visit_a:    '④ 来店翌日A（今月の予約あり）'
};

// ------------------------------------------------------------
// 文面（4言語）。ここだけ見れば全文が分かるようにしてある。
//   ・氏名は入れない（宛先は1:1のトーク＝本人にしか届かない。出力・ログをPIIゼロに保つため）
//   ・差し込み：{facts}=残数の一文（下の _lbNudgeFactsText が組み立てる）
//     {month}=対象の月 / {pattern}=固定枠 / {quota}=押さえていただきたい回数
//     {next}=次のご予約の日時 / {expire}=振替の期限 / {url}=予約画面
// ------------------------------------------------------------
var _LB_NUDGE_MSG = {
  // 残数の一文（{facts} に入る）。★繰越の行は月末が近いときだけ足す。
  facts_remain: {
    ja:        '今月はあと {remain}回 ご利用いただけます。（残り{days}日）',
    en:        'You have {remain} session(s) left this month ({days} days remaining).',
    zh:        '本月还可使用 {remain}次（剩余{days}天）。',
    'zh-Hant': '本月還可使用 {remain}次（剩餘{days}天）。'
  },
  // 「先月から○回繰り越しました」（その月に初めて送るとき・15日までだけ）
  facts_carried_in: {
    ja:        '先月分から {carried}回 繰り越しました。',
    en:        '{carried} session(s) were carried over from last month.',
    zh:        '上月结转了 {carried}次。',
    'zh-Hant': '上月結轉了 {carried}次。'
  },
  facts_carry: {
    ja:        'うち {carry}回 は繰り越し可能です。',
    en:        'Of these, {carry} can be carried over to next month.',
    zh:        '其中 {carry}次 可结转至下月。',
    'zh-Hant': '其中 {carry}次 可結轉至下月。'
  },

  // ① 振替の案内（★残数の話は入れない。振替のことだけにする＝オーナー指示）
  transfer: {
    ja: '振替が1回ご利用いただけます。\n' +
        '\n' +
        '昨日のご予約は当日のお取り消しのため、1回分の消化となりました。\n' +
        'かわりに振替を1回、{expire}まで ご利用いただけます。\n' +
        '\n' +
        '▼ ご予約\n' +
        '{url}',
    en: 'You have one transfer session available.\n' +
        '\n' +
        "Yesterday's booking was cancelled on the day, so it was counted as one session used.\n" +
        'In its place, you may use one transfer session until {expire}.\n' +
        '\n' +
        '▼ Book\n' +
        '{url}',
    zh: '您可使用1次转期。\n' +
        '\n' +
        '昨日的预约因当日取消，已计为1次消耗。\n' +
        '作为替代，您可在{expire}之前使用1次转期。\n' +
        '\n' +
        '▼ 预约\n' +
        '{url}',
    'zh-Hant': '您可使用1次轉期。\n' +
        '\n' +
        '昨日的預約因當日取消，已計為1次消耗。\n' +
        '作為替代，您可在{expire}之前使用1次轉期。\n' +
        '\n' +
        '▼ 預約\n' +
        '{url}'
  },
  // ② 翌月の解放（固定枠あり）— 25日に autoBookRecurringPatterns が翌月分を自動予約済み
  month_open_fixed: {
    ja: '{month}分のご予約が可能になりました。\n' +
        '\n' +
        'ご登録の固定枠（{pattern}）は、{month}分を自動でお取りしました。\n' +
        'ご変更が必要でしたら、下記よりお願いいたします。\n' +
        '\n' +
        '{facts}\n' +
        '\n' +
        '▼ ご予約・ご変更\n' +
        '{url}',
    en: 'Bookings for {month} are now open.\n' +
        '\n' +
        'Your regular slot ({pattern}) has been booked for {month} automatically.\n' +
        'If you would like to change it, please use the link below.\n' +
        '\n' +
        '{facts}\n' +
        '\n' +
        '▼ Book or change\n' +
        '{url}',
    zh: '{month}的预约已开放。\n' +
        '\n' +
        '您登记的固定时段（{pattern}），{month}的课程已自动为您预约。\n' +
        '如需变更，敬请从下方办理。\n' +
        '\n' +
        '{facts}\n' +
        '\n' +
        '▼ 预约・变更\n' +
        '{url}',
    'zh-Hant': '{month}的預約已開放。\n' +
        '\n' +
        '您登記的固定時段（{pattern}），{month}的課程已自動為您預約。\n' +
        '如需變更，敬請從下方辦理。\n' +
        '\n' +
        '{facts}\n' +
        '\n' +
        '▼ 預約・變更\n' +
        '{url}'
  },
  // ②' 翌月の解放（固定枠なし）— 先着順であることを伝え、まとめて押さえていただく
  month_open_free: {
    ja: '{month}分のご予約が可能になりました。\n' +
        '\n' +
        'ご希望のお時間は先着順です。\n' +
        '徐々にご予約可能な枠が少なくなってまいりますので、\n' +
        'まずはなるべくお早めに{quota}回分お押さえいただくことをおすすめいたします。\n' +
        '\n' +
        '{facts}\n' +
        '\n' +
        '▼ ご予約\n' +
        '{url}',
    en: 'Bookings for {month} are now open.\n' +
        '\n' +
        'Preferred times are taken on a first-come basis.\n' +
        'Available slots become fewer as the days pass, so we recommend\n' +
        'securing your {quota} session(s) as early as you can.\n' +
        '\n' +
        '{facts}\n' +
        '\n' +
        '▼ Book\n' +
        '{url}',
    zh: '{month}的预约已开放。\n' +
        '\n' +
        '您希望的时段按先后顺序安排。\n' +
        '可预约的时段会逐渐减少，\n' +
        '建议您尽早先行预约 {quota}次。\n' +
        '\n' +
        '{facts}\n' +
        '\n' +
        '▼ 预约\n' +
        '{url}',
    'zh-Hant': '{month}的預約已開放。\n' +
        '\n' +
        '您希望的時段按先後順序安排。\n' +
        '可預約的時段會逐漸減少，\n' +
        '建議您盡早先行預約 {quota}次。\n' +
        '\n' +
        '{facts}\n' +
        '\n' +
        '▼ 預約\n' +
        '{url}'
  },
  // ③ 来店翌日B（今月の予約なし）
  visit_b: {
    ja: '昨日はお疲れさまでした。\n' +
        '\n' +
        '{facts}\n' +
        '\n' +
        '次回のご予約がお決まりでなければ、下記よりお待ちしております。\n' +
        '\n' +
        '▼ ご予約\n' +
        '{url}',
    en: 'Thank you for your session yesterday.\n' +
        '\n' +
        '{facts}\n' +
        '\n' +
        'If your next session is not yet decided, we will be glad to welcome you below.\n' +
        '\n' +
        '▼ Book\n' +
        '{url}',
    zh: '昨日辛苦了。\n' +
        '\n' +
        '{facts}\n' +
        '\n' +
        '若下次的预约尚未确定，敬请从下方预约，我们恭候您的光临。\n' +
        '\n' +
        '▼ 预约\n' +
        '{url}',
    'zh-Hant': '昨日辛苦了。\n' +
        '\n' +
        '{facts}\n' +
        '\n' +
        '若下次的預約尚未確定，敬請從下方預約，我們恭候您的光臨。\n' +
        '\n' +
        '▼ 預約\n' +
        '{url}'
  },
  // ④ 来店翌日A（今月の予約あり）
  visit_a: {
    ja: '昨日はお疲れさまでした。\n' +
        '\n' +
        '{facts}\n' +
        '\n' +
        '次のご予約は {next} に承っております。\n' +
        'もう一度、今月中にいかがでしょうか。\n' +
        '\n' +
        '▼ ご予約\n' +
        '{url}',
    en: 'Thank you for your session yesterday.\n' +
        '\n' +
        '{facts}\n' +
        '\n' +
        'Your next session is reserved for {next}.\n' +
        'Would you care to join us once more within this month?\n' +
        '\n' +
        '▼ Book\n' +
        '{url}',
    zh: '昨日辛苦了。\n' +
        '\n' +
        '{facts}\n' +
        '\n' +
        '您的下次预约为 {next}。\n' +
        '本月要不要再来一次呢。\n' +
        '\n' +
        '▼ 预约\n' +
        '{url}',
    'zh-Hant': '昨日辛苦了。\n' +
        '\n' +
        '{facts}\n' +
        '\n' +
        '您的下次預約為 {next}。\n' +
        '本月要不要再來一次呢。\n' +
        '\n' +
        '▼ 預約\n' +
        '{url}'
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

// 「10月」/「October」/「10月」。文面の {month} に差し込む。
function _lbNudgeMonthLabel(month1, lang) {
  var l = _lbNormLang(lang);
  if (l === 'en') return ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][month1 - 1];
  return month1 + '月';
}

// 予約画面（LIFF）の入口。_lbWelcomeText と同じ組み立て。
function _lbNudgeLiffUrl() {
  var liffId = _lbProp('LINE_LIFF_ID') || '2010827953-QgBQFzh9';
  return 'https://liff.line.me/' + liffId;
}

// 種別＋差し込み値 → 本文。month_open だけ固定枠の有無で辞書キーが分かれる。
function _lbNudgeText(kind, lang, v) {
  var vars = {
    month: v.monthLabel, pattern: v.pattern, remain: v.remain, carry: v.carry, days: v.days,
    facts: v.facts || '',                      // 残数の一文（繰越の行は月末が近いときだけ入る）
    quota: v.quota, next: v.next, expire: v.expire, url: _lbNudgeLiffUrl()
  };
  if (kind === LB_NUDGE_KIND.TRANSFER)   return _lbNudgeMsg(lang, 'transfer', vars);
  if (kind === LB_NUDGE_KIND.MONTH_OPEN) return _lbNudgeMsg(lang, v.pattern ? 'month_open_fixed' : 'month_open_free', vars);
  if (kind === LB_NUDGE_KIND.VISIT_B)    return _lbNudgeMsg(lang, 'visit_b', vars);
  return _lbNudgeMsg(lang, 'visit_a', vars);
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
    openDay:    _lbNudgeNum('LB_NUDGE_OPEN_DAY', LB_NUDGE_DEFAULTS.openDay),
    visitADays: _lbNudgeNum('LB_NUDGE_VISIT_A_DAYS', LB_NUDGE_DEFAULTS.visitADays),
    maxPerRun:  _lbNudgeNum('LB_NUDGE_MAX_PER_RUN', LB_NUDGE_DEFAULTS.maxPerRun)
  };
}

// 顧客IDの下4桁だけを見せる（氏名・全体IDを出力に残さない・要件8）
function _lbNudgeMask(customerId) {
  var s = String(customerId || '');
  return '*' + (s.length > 4 ? s.slice(-4) : s);
}

function _lbNudgeMonthKey(d) { return d.getFullYear() + '-' + ((d.getMonth() + 1) < 10 ? '0' : '') + (d.getMonth() + 1); }

// その日の 00:00（JST）。「昨日」の範囲を暦日で切るために使う。
function _lbNudgeDayStart(d, offsetDays) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + (offsetDays || 0), 0, 0, 0).getTime();
}
// 今月の終わり（23:59:59）。「今月の未来予約」と「残り日数」の両方で使う。
function _lbNudgeMonthEnd(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59).getTime(); }
// 今月の残り日数（今日を含む）。9/26 なら 30-26+1 = 5日。
function _lbNudgeDaysLeft(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() - d.getDate() + 1; }
// 翌月の中旬（＝確実にその月）。残数を「翌月時点」で出すために使う（_lbBuildHome と同じ手）。
function _lbNudgeNextMonthDate(now) { return new Date(now.getFullYear(), now.getMonth() + 1, 15, 12, 0, 0); }

// 台帳の備考列は取消時に「resId|当日消化取消」となる。突き合わせは '|' の手前だけで行う。
function _lbNudgeResId(v) { return String(v || '').split('|')[0]; }

// 対象一覧から内部情報（lineUserId・生の顧客ID・本文）を落とす。外へ返すのは必ずこれを通す。
function _lbNudgePublic(plan) {
  function pub(t) {
    var o = { id: t.id, kind: t.kind, lang: t.lang };
    // 差し込んだ事実だけ返す（すべて下4桁IDに紐づく非PII）。本文と宛先は外へ出さない。
    if (t.remain != null)  o.remain = t.remain;
    if (t.carry != null)   o.carry = t.carry;
    if (t.days != null)    o.days = t.days;
    if (t.expire)          o.expire = t.expire;
    if (t.next)            o.next = t.next;
    if (t.pattern != null) o.pattern = t.pattern;
    if (t.quota)           o.quota = t.quota;
    return o;
  }
  return {
    code: plan.code, conf: plan.conf, month: plan.month, isOpenDay: plan.isOpenDay,
    examined: plan.examined, counts: plan.counts, skipped: plan.skipped, rowErrors: plan.rowErrors,
    targets: plan.targets.map(pub),
    demoted: plan.demoted.map(function (d) { return { id: d.id, kind: d.kind, insteadOf: d.insteadOf }; })
  };
}

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

// 全種別を1回のシート読みで引く（種別ごとに読み直すと人数ぶん往復が増える）。
//   結果が sent の行だけ数える＝未達（LINE側で弾かれた）は送ったことにしない＝翌日また試せる。
function _lbNudgeLogReadAll() {
  var out = {};
  for (var i = 0; i < LB_NUDGE_ORDER.length; i++) out[LB_NUDGE_ORDER[i]] = {};
  try {
    var sh = _lbSheet(LB_NUDGE_LOG_SHEET);
    if (!sh || sh.getLastRow() < 2) return out;
    var n = Math.min(LB_NUDGE_LOG_SCAN, sh.getLastRow() - 1);
    var v = sh.getRange(2, 1, n, LB_NUDGE_LOG_COLS).getValues();
    for (var r = 0; r < v.length; r++) {
      var kind = String(v[r][1]);
      if (!out[kind]) continue;
      if (String(v[r][4]) !== 'sent') continue;
      var cid = String(v[r][2] || ''); if (!cid) continue;
      var e = out[kind][cid] || (out[kind][cid] = { lastMs: null, keys: {} });
      var d = _lbParseResvDate(String(v[r][0] || '').replace(/^'/, ''));   // 文字列固定のため先頭 ' を外す
      if (d) { var ms = d.getTime(); if (e.lastMs === null || ms > e.lastMs) e.lastMs = ms; }
      var k = String(v[r][3] || ''); if (k) e.keys[k] = true;
    }
  } catch (e) { Logger.log('nudge_log 読み取り失敗（送信は中止せず、この実行では抑止を効かせない）: ' + e.message); }
  return out;
}

// まとめて1回で書く（1人ずつ insert すると人数ぶんシート往復が増える）
function _lbNudgeLogWrite(rows, nowMs) {
  if (!rows || !rows.length) return;
  try {
    var sh = _lbNudgeLogSheet();
    var when = Utilities.formatDate(new Date(nowMs), SETTINGS.TIMEZONE, 'yyyy/MM/dd HH:mm');
    var out = rows.map(function (r) {
      return ["'" + when, r.kind, r.customerId, r.key || '', r.result, String(r.detail || '').slice(0, 200)];
    });
    sh.insertRowsAfter(1, out.length);   // 新しい行を上に（reminder_status と同方針）
    sh.getRange(2, 1, out.length, LB_NUDGE_LOG_COLS).setValues(out);
  } catch (e) { Logger.log('nudge_log 記録失敗: ' + e.message); }
}

// ------------------------------------------------------------
// 判定に必要な事実を、シートごとに1回だけ読む
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

// 予約台帳から会員ごとに「昨日の消化（＝来店 or 当日キャンセル）」と「今月の未来予約」を作る。
//   読めなければ null（＝来店したかも未来があるかも分からない → 送らない）。
//   未来は confirmed だけ（cancelled/changed は数えない）。
//
//   ★昨日の来店は confirmed と consumed の**両方**を数える（2026-09-30 修正）。
//     予約台帳の実データは confirmed 253件 / consumed 6件で、来店しても状態は
//     ほとんど confirmed のまま残る。消化の計上は、残数計算の側が
//     「過去の confirmed も消化とみなす」（LineBooking.js の
//     `if (st !== 'confirmed' && st !== 'consumed') continue;`）ことで成立している。
//     ここだけ consumed に限っていたため、実際に来店された方を1人も拾えていなかった。
//     **消化の定義はシステム全体で1つにする。**
function _lbNudgeResvIndex(now) {
  var sh = _lbSheet(LINE_BOOKING.RESV_SHEET);
  if (!sh) return null;
  var last = sh.getLastRow();
  if (last < 2) return {};
  var nowMs = now.getTime();
  var yStart = _lbNudgeDayStart(now, -1), yEnd = _lbNudgeDayStart(now, 0);
  var monthEnd = _lbNudgeMonthEnd(now);
  var vals = sh.getRange(2, 1, last - 1, Math.max(12, sh.getLastColumn())).getValues();
  var idx = {};
  for (var i = 0; i < vals.length; i++) {
    var r = vals[i];
    var cid = String(r[2] || ''); if (!cid) continue;
    var dt = _lbParseResvDate(r[0]); if (!dt) continue;
    var t = dt.getTime(), st = String(r[6]);
    var e = idx[cid] || (idx[cid] = { yesterday: [], futureThisMonth: 0, nextRaw: null, nextMs: null });
    if ((st === 'confirmed' || st === 'consumed') && t >= yStart && t < yEnd) {
      e.yesterday.push(_lbNudgeResId(r[8]));   // 備考＝予約ID。振替権の source と突き合わせる
    } else if (st === 'confirmed' && t > nowMs && t <= monthEnd) {
      e.futureThisMonth++;
      if (e.nextMs === null || t < e.nextMs) { e.nextMs = t; e.nextRaw = r[0]; }
    }
  }
  return idx;
}

// 振替権シート。
//   ★「シートが無い」と「ブックが開けない」を分ける（2026-09-30）。
//     - ブックが開けない → 判断できない → null（送らない・fail-closed）
//     - ブックは開けるがシートが無い → **当日キャンセルが一度も無い**ということ。
//       事実として「振替権0件」と分かるので、空として扱ってよい。
//     ここを一緒くたに止めていたため、有効化の前にオーナーがGASエディタで
//     シートを作る作業が必要になっていた。その作業を無くす。
function _lbNudgeTcreditIndex() {
  var ss;
  try { ss = _lbSs(); } catch (e) { return null; }      // ブックが開けない＝判断できない
  if (!ss) return null;
  var sh = ss.getSheetByName(LB_TCREDIT_SHEET);
  if (!sh) return {};                                    // シートが無い＝振替権0件（事実）
  var last = sh.getLastRow();
  if (last < 2) return {};
  var v = sh.getRange(2, 1, last - 1, 5).getValues();
  var idx = {};
  for (var i = 0; i < v.length; i++) {
    var cid = String(v[i][0] || ''); if (!cid) continue;
    var g = _lbParseResvDate(v[i][1]), ex = _lbParseResvDate(v[i][2]), u = v[i][3] ? _lbParseResvDate(v[i][3]) : null;
    var e = idx[cid] || (idx[cid] = { rows: [], sources: {} });
    e.rows.push({ grantedMs: g ? g.getTime() : 0, expiresMs: ex ? ex.getTime() : 0, usedMs: u ? u.getTime() : 0 });
    var src = String(v[i][4] || ''); if (src) e.sources[src] = true;
  }
  return idx;
}

// 固定枠（recurring_patterns）。無ければ「固定枠なし」として扱う（fail-closed の対象ではない）。
function _lbNudgeRecurIndex() {
  var idx = {};
  try {
    var sh = _lbSheet(LB_RECUR_SHEET);
    if (!sh || sh.getLastRow() < 2) return idx;
    var v = sh.getRange(2, 1, sh.getLastRow() - 1, 10).getValues();
    for (var i = 0; i < v.length; i++) {
      if (!_lbTruthy(v[i][RP_COL.ACTIVE - 1])) continue;
      var cid = String(v[i][RP_COL.CUSTOMER_ID - 1] || ''); if (!cid) continue;
      (idx[cid] || (idx[cid] = [])).push({ weekday: Number(v[i][RP_COL.WEEKDAY - 1]), time: String(v[i][RP_COL.TIME - 1]) });
    }
  } catch (e) { Logger.log('recurring_patterns 読み取り失敗（固定枠なしとして続行）: ' + e.message); }
  return idx;
}

// 名簿の行が「そもそも発信していい相手か」。ここを緩めない（未認証・契約切れへは送らない）。
function _lbNudgeEligible(m, skipped) {
  // ★人数だけでは「誰が落ちたか」を追えない。顧客IDの下4桁も控える（氏名は出さない）。
  //   2026-09-30：オーナーの「9/29は8名来ている」と一覧の7名が合わず、
  //   どこで誰が落ちたのかを人数からは特定できなかったため。
  function drop(key) { (skipped._who[key] = skipped._who[key] || []).push(_lbNudgeMask(m.customerId)); }
  if (!skipped._who) skipped._who = {};
  if (!m.customerId)                { skipped.noCustomerId++; return false; }   // IDが無いので控えようがない
  if (m.authState !== 'verified')   { skipped.notVerified++;  drop('notVerified'); return false; }
  if (m.contractStat !== 'active')  { skipped.notActive++;    drop('notActive');   return false; }   // 空欄も対象外（判定不能＝送らない）
  if (!m.lineUserId)                { skipped.noLine++;       drop('noLine');      return false; }
  return true;
}

// 繰越上限。優先順：契約マスタ「繰越上限」列 ＞ 頻度テーブル（Allocate.js）＞ 率fallback。
//   契約が引けなかった場合はテーブルへ倒す（表示を0にするより実態に近い側へ倒す）。
function _lbNudgeCarryCap(m, quota) {
  var ov = null;
  try {
    var c = _lbFindContract(m.name, _lbPhoneByCustomerId(m.customerId));
    if (c && c.cols && c.cols.carryCap >= 0) {
      var raw = c.row[c.cols.carryCap];
      if (raw !== '' && raw != null) { var n = Number(raw); if (isFinite(n) && n >= 0) ov = Math.floor(n); }
    }
  } catch (e) { Logger.log('繰越上限の契約参照に失敗（頻度テーブルで続行）: ' + e.message); }
  return _lbResolveCarryCap(quota, ov, LINE_BOOKING.CARRYOVER_RATE);
}

// 残数の一文を組み立てる。
//   ★繰越の行は「月末が近いとき」だけ出す（2026-09-30 オーナー判断）。
//     月初に「うち1回は繰り越し可能です」と出しても行動につながらない。
//     31日も残っているのに繰越の話をすると、むしろ「来月に回してよい」と読める。
//     月末が近づいて初めて、繰り越せる回数が意味を持つ。
var LB_NUDGE_CARRY_SHOW_DAYS = 10;   // 残りこの日数以内なら繰越の行を出す

function _lbNudgeFactsText(lang, f, carriedIn) {
  var lines = [];
  // ★「先月から繰り越しました」は、その月にその方へ初めて送るとき、かつ15日までだけ。
  //   得た感じがあるので月の前半の行動につながる。後半に言っても古い話になる。
  //   （2026-09-30 オーナー判断：「その月にその方へ初めて送るとき、かつ15日まで」）
  if (carriedIn > 0) lines.push(_lbNudgeMsg(lang, 'facts_carried_in', { carried: carriedIn }));
  lines.push(_lbNudgeMsg(lang, 'facts_remain', { remain: f.remain, days: f.days }));
  // 繰越の行は月末が近いときだけ（月初に言っても「来月に回してよい」と読める）
  if (f.carry > 0 && f.days <= LB_NUDGE_CARRY_SHOW_DAYS) {
    lines.push(_lbNudgeMsg(lang, 'facts_carry', { carry: f.carry }));
  }
  return lines.join('\n');
}

// その月にその方へ「まだ一度も送っていない」か。送信記録で見る。
var LB_NUDGE_CARRIED_IN_UNTIL_DAY = 15;   // この日までなら繰越の報告を添える
function _lbNudgeFirstOfMonth(logs, customerId, now) {
  if (now.getDate() > LB_NUDGE_CARRIED_IN_UNTIL_DAY) return false;
  var mk = _lbNudgeMonthKey(now);
  for (var k = 0; k < LB_NUDGE_ORDER.length; k++) {
    var e = logs[LB_NUDGE_ORDER[k]] && logs[LB_NUDGE_ORDER[k]][String(customerId)];
    if (e && e.lastMs && _lbNudgeMonthKey(new Date(e.lastMs)) === mk) return false;   // 今月すでに送っている
  }
  return true;
}

// 共通して入れる事実（transfer を除く3種で使う）。
//   remain=今月の月額残 / carry=そのうち繰り越せる回数 / days=今月の残り日数。
//   remain が null＝残数を算出できない（degraded）＝送らない側へ倒す。
function _lbNudgeFacts(m, now) {
  var h = _lbBuildHome(m.customerId, m.name, m.lang, now.getTime());
  if (!h || !h.type) return { remain: null, carry: 0, days: _lbNudgeDaysLeft(now), quota: 0, carriedIn: 0 };
  var remain = (h.monthlyRemaining == null) ? null : Number(h.monthlyRemaining);
  var quota = Number(h.quota || 0);
  var carry = (remain == null) ? 0 : Math.max(0, Math.min(remain, _lbNudgeCarryCap(m, quota)));
  // carriedIn＝今月に繰り越されてきた回数（先月の余り）。月の前半に一度だけ伝える。
  var carriedIn = Math.max(0, Number(h.carryover || 0));
  return { remain: remain, carry: carry, days: _lbNudgeDaysLeft(now), quota: quota, carriedIn: carriedIn };
}

// 翌月に押さえていただきたい回数（②'固定枠なしの {quota}）。翌月時点の月額残が本命、
//   取れなければ契約の頻度へ倒す（0回分お押さえください、という文面を出さないため）。
function _lbNudgeNextQuota(m, now, fallbackQuota) {
  try {
    var h = _lbBuildHome(m.customerId, m.name, m.lang, _lbNudgeNextMonthDate(now).getTime());
    if (h && h.type && h.monthlyRemaining != null && Number(h.monthlyRemaining) > 0) return Number(h.monthlyRemaining);
  } catch (e) { Logger.log('翌月の回数算出に失敗（契約頻度で代用）: ' + e.message); }
  return fallbackQuota;
}

// ============================================================
// 対象の一覧（送らない）— 4種をまとめて1回の走査で作り、1人1通に絞る
// ============================================================
function lbNudgePlanAll(nowMs) {
  var now = (nowMs != null) ? new Date(nowMs) : new Date();   // 引数はテスト／確認で「今」を固定するため。本番は省略。
  var ms = now.getTime();
  var conf = _lbNudgeConf();
  var nm = _lbNudgeNextMonthDate(now);
  var plan = {
    code: 'OK', conf: conf, asOf: Utilities.formatDate(now, SETTINGS.TIMEZONE, 'yyyy/MM/dd HH:mm'),
    isOpenDay: (now.getDate() === conf.openDay), month: nm.getMonth() + 1, monthKey: _lbNudgeMonthKey(nm),
    examined: 0, targets: [], demoted: [], rowErrors: [],
    counts: { nudge_transfer: 0, nudge_month_open: 0, nudge_visit_b: 0, nudge_visit_a: 0 },
    skipped: { noCustomerId: 0, notVerified: 0, notActive: 0, noLine: 0,
               transferUsed: 0, transferExpired: 0, transferNone: 0,
               monthAlreadySent: 0, visitATooSoon: 0, noRemain: 0, remainUnknown: 0, noEvent: 0 }
  };

  var members = _lbNudgeMembers();
  if (members === null) { plan.code = 'NO_MAP_SHEET'; return plan; }
  var resv = _lbNudgeResvIndex(now);
  if (resv === null) { plan.code = 'NO_RESV_SHEET'; return plan; }      // 台帳が無い＝来店も未来も分からない → 送らない
  var tc = _lbNudgeTcreditIndex();
  if (tc === null) { plan.code = 'NO_TCREDIT_SHEET'; return plan; }     // 振替権が無い＝当日キャンセルと来店を区別できない → 送らない
  var recur = _lbNudgeRecurIndex();
  var log = _lbNudgeLogReadAll();

  for (var i = 0; i < members.length; i++) {
    var m = members[i];
    plan.examined++;
    try {
      if (!_lbNudgeEligible(m, plan.skipped)) continue;

      var ev = resv[m.customerId] || { yesterday: [], futureThisMonth: 0, nextRaw: null, nextMs: null };
      var tce = tc[m.customerId] || { rows: [], sources: {} };

      // 昨日の消化を「当日キャンセル」と「実来店」に割る。振替権の source に載っていれば当日キャンセル。
      var sameDayCancel = false, visited = false;
      for (var y = 0; y < ev.yesterday.length; y++) {
        if (ev.yesterday[y] && tce.sources[ev.yesterday[y]]) sameDayCancel = true; else visited = true;
      }

      var cand = [], reasons = [], facts = null;
      function needFacts() { if (facts === null) facts = _lbNudgeFacts(m, now); return facts; }

      // ── ① transfer：当日キャンセル＋振替権が未使用かつ有効期限内 ──
      if (sameDayCancel) {
        var st = _lbTransferCreditState(tce.rows, ms);
        if (st.available > 0) {
          cand.push({ kind: LB_NUDGE_KIND.TRANSFER, key: '',
                      expire: _lbFmtDateShort(new Date(st.nextExpiryMs), m.lang) });
        } else {
          var usedAny = false, expiredAny = false;
          for (var c = 0; c < tce.rows.length; c++) {
            if (tce.rows[c].usedMs) usedAny = true;
            else if (!(tce.rows[c].expiresMs >= ms)) expiredAny = true;
          }
          reasons.push(usedAny ? 'transferUsed' : (expiredAny ? 'transferExpired' : 'transferNone'));
        }
      }

      // ── ② month_open：解放日（既定25日）・契約有効（eligible で確認済み） ──
      if (plan.isOpenDay) {
        var le = log[LB_NUDGE_KIND.MONTH_OPEN][m.customerId];
        if (le && le.keys[plan.monthKey]) { reasons.push('monthAlreadySent'); }
        else {
          var f2 = needFacts();
          if (f2.remain === null) reasons.push('remainUnknown');
          else {
            var pats = recur[m.customerId] || [];
            var label = pats.map(function (p) { return _lbRecurLabel(p.weekday, p.time, m.lang); }).join('／');
            cand.push({ kind: LB_NUDGE_KIND.MONTH_OPEN, key: plan.monthKey, pattern: label,
                        quota: label ? 0 : _lbNudgeNextQuota(m, now, f2.quota) });   // 固定枠ありの文面に {quota} は出ない
          }
        }
      }

      // ── ③④ visit_b / visit_a：昨日「実際に来店」した方だけ ──
      //   ★当日キャンセルの方はここに来ない。振替（①）だけをお送りする。
      if (visited) {
        var f3 = needFacts();
        if (f3.remain === null) reasons.push('remainUnknown');
        else if (f3.remain <= 0) reasons.push('noRemain');
        else if (ev.futureThisMonth === 0) {
          cand.push({ kind: LB_NUDGE_KIND.VISIT_B, key: '' });
        } else {
          var la = log[LB_NUDGE_KIND.VISIT_A][m.customerId];
          if (la && la.lastMs !== null && (ms - la.lastMs) < conf.visitADays * 86400000) reasons.push('visitATooSoon');
          else cand.push({ kind: LB_NUDGE_KIND.VISIT_A, key: '', next: _lbFmtResvLabel(ev.nextRaw, m.lang) });
        }
      }

      if (!cand.length) {
        // 近いところまで来た理由を1つだけ数える（1人が複数のバケツに入らないようにする）。
        plan.skipped[reasons.length ? reasons[0] : 'noEvent']++;
        continue;
      }

      // ── 優先順位で1通に絞る。絞って送らなかったものは demoted として一覧に出す ──
      cand.sort(function (a, b) { return LB_NUDGE_ORDER.indexOf(a.kind) - LB_NUDGE_ORDER.indexOf(b.kind); });
      var win = cand[0];
      var f = needFacts();
      var v = {
        monthLabel: _lbNudgeMonthLabel(plan.month, m.lang),
        pattern: win.pattern || '', quota: win.quota || 0,
        remain: f.remain, carry: f.carry, days: f.days,
        // 残数の一文。繰越の行は月末が近いときだけ、
        //   「先月から繰り越しました」は今月はじめての案内かつ15日までだけ。
        facts: _lbNudgeFactsText(m.lang, f,
                 _lbNudgeFirstOfMonth(log, m.customerId, now) ? f.carriedIn : 0),
        next: win.next || '', expire: win.expire || ''
      };
      plan.counts[win.kind]++;
      plan.targets.push({
        id: _lbNudgeMask(m.customerId), kind: win.kind, lang: m.lang,
        remain: (win.kind === LB_NUDGE_KIND.TRANSFER) ? null : f.remain,   // transfer に残数の話は入れない（オーナー指示）
        carry:  (win.kind === LB_NUDGE_KIND.TRANSFER) ? null : f.carry,
        days:   (win.kind === LB_NUDGE_KIND.TRANSFER) ? null : f.days,
        expire: v.expire, next: v.next, pattern: v.pattern, quota: v.quota,
        _to: m.lineUserId, _cid: m.customerId, _key: win.key, _text: _lbNudgeText(win.kind, m.lang, v)
      });
      for (var d = 1; d < cand.length; d++) {
        plan.demoted.push({ id: _lbNudgeMask(m.customerId), kind: cand[d].kind, insteadOf: win.kind });
      }
    } catch (err) {
      // ★1人分の不備（残数データ不整合など）で全員分を止めない。氏名は残さない。
      plan.rowErrors.push(_lbNudgeMask(m.customerId) + ': ' + err.message);
      Logger.log('nudge 1件失敗（他は継続）: ' + err.message);
    }
  }
  return plan;
}

// ============================================================
// 送信（ここだけが実際にLINEへ出す。既定は無効なので何もしない）
// ============================================================
function _lbNudgeSend(plan, nowMs) {
  var res = { success: true, enabled: _lbNudgeEnabled(), sent: 0, failed: 0, deferred: 0, plan: _lbNudgePublic(plan) };
  if (plan.code !== 'OK') { Logger.log('nudge 中止（fail-closed）: ' + plan.code); return res; }
  if (!res.enabled) {
    // ★既定の道。ここで必ず止まる。記録も残さない（あとで有効にしたとき抑止が誤作動しないように）。
    Logger.log('nudge は無効（LB_REMIND_ON≠1）。対象' + plan.targets.length + '名を一覧しただけで送信していません。');
    return res;
  }
  var cap = plan.conf.maxPerRun;
  var rows = [];
  for (var i = 0; i < plan.targets.length; i++) {
    var t = plan.targets[i];
    if (cap > 0 && (res.sent + res.failed) >= cap) { res.deferred++; continue; }   // 残りは翌日の実行へ
    var ok = false;
    try { ok = _lbPush(t._to, t._text, t.kind); } catch (e) { Logger.log('nudge push例外: ' + e.message); }
    if (ok) res.sent++; else res.failed++;
    rows.push({ kind: t.kind, customerId: t._cid, key: t._key, result: ok ? 'sent' : 'failed', detail: ok ? '' : 'push未達' });
    Utilities.sleep(250);   // 連続送信で429を招かない間隔（sendLineReminders と同じ）
  }
  _lbNudgeLogWrite(rows, nowMs != null ? nowMs : new Date().getTime());
  Logger.log('nudge: ' + JSON.stringify({ sent: res.sent, failed: res.failed, deferred: res.deferred, counts: plan.counts }));
  return res;
}

// ============================================================
// ★オーナー確認用：送らずに「誰に何を送るか」だけ出す（主たる入口）
//   GASエディタで lbNudgePreview を実行 → ログに一覧が出る。1通も送らない。
// ============================================================
function lbNudgePlan(nowMs) {
  var ms = (nowMs != null) ? nowMs : new Date().getTime();
  var plan = lbNudgePlanAll(ms);
  var pub = _lbNudgePublic(plan);
  pub.asOf = plan.asOf;
  pub.enabled = _lbNudgeEnabled();
  return pub;
}

var _LB_NUDGE_SKIP_LABEL = {
  noCustomerId: '顧客ID未設定', notVerified: '未認証', notActive: '契約が有効でない', noLine: 'LINE未連携',
  transferUsed: '振替権を使用済み', transferExpired: '振替権が期限切れ', transferNone: '振替権の記録なし',
  monthAlreadySent: 'その月は送信済み', visitATooSoon: '前回の来店翌日Aから日が浅い',
  noRemain: '月額残が0', remainUnknown: '残数が算出できない', noEvent: '該当する出来事なし'
};
function _lbNudgeSkipText(skipped) {
  var parts = [];
  for (var k in skipped) {
    if (k === '_who' || !skipped[k]) continue;
    var who = (skipped._who && skipped._who[k]) ? '（' + skipped._who[k].join(' ') + '）' : '';
    parts.push((_LB_NUDGE_SKIP_LABEL[k] || k) + ' ' + skipped[k] + '名' + who);
  }
  return parts.length ? parts.join(' / ') : 'なし';
}
function _lbNudgeIndent(s) { return String(s).split('\n').map(function (l) { return '      | ' + l; }).join('\n'); }

function lbNudgePreview(nowMs) {
  var ms = (nowMs != null) ? nowMs : new Date().getTime();
  var plan = lbNudgePlanAll(ms);
  var conf = plan.conf;
  var out = [];
  out.push('=== 予約を促すリマインド 一覧（送信しません） ' + plan.asOf + ' ===');
  out.push('実送信: ' + (_lbNudgeEnabled() ? '⚠️ 有効（LB_REMIND_ON=1）' : '無効（既定）— この一覧を見て決めてください'));
  out.push('設定: 解放日' + conf.openDay + '日（本日は' + (plan.isOpenDay ? '解放日です' : '解放日ではありません') + '）／来店翌日Aの間隔' + conf.visitADays + '日／1回上限' + conf.maxPerRun + '通');
  out.push('※氏名は出しません。会員は顧客IDの下4桁で示します。');
  if (plan.code !== 'OK') {
    out.push('');
    out.push('⛔ 中止（fail-closed）: ' + plan.code + ' — 必要なシートが読めないため1通も出しません。');
    var stop = out.join('\n'); Logger.log(stop); return stop;
  }
  out.push('');
  out.push('── 名簿' + plan.examined + '件を確認 ／ 送る対象 ' + plan.targets.length + '名（1人1日1通）');

  for (var k = 0; k < LB_NUDGE_ORDER.length; k++) {
    var kind = LB_NUDGE_ORDER[k];
    var list = plan.targets.filter(function (t) { return t.kind === kind; });
    out.push('');
    out.push(LB_NUDGE_LABEL[kind] + ': ' + list.length + '名');
    if (!list.length) { out.push('   （該当なし）'); continue; }
    for (var j = 0; j < list.length; j++) {
      var t = list[j], detail = [];
      if (t.remain != null) detail.push('今月残' + t.remain + '回');
      if (t.carry != null)  detail.push('繰越可' + t.carry + '回');
      if (t.expire)         detail.push('振替期限' + t.expire);
      if (t.next)           detail.push('次回' + t.next);
      if (t.pattern)        detail.push('固定枠' + t.pattern);
      out.push('   ・' + t.id + '（' + t.lang + (detail.length ? '・' + detail.join('・') : '') + '）');
    }
    out.push('   ▼送る文面（日本語）');
    out.push(_lbNudgeIndent(_lbNudgeSampleText(kind, plan, list[0])));
  }

  out.push('');
  out.push('── 優先順位で見送り: ' + (plan.demoted.length || 'なし'));
  for (var d = 0; d < plan.demoted.length; d++) {
    out.push('   ・' + plan.demoted[d].id + ' ' + LB_NUDGE_LABEL[plan.demoted[d].kind] + '（' + LB_NUDGE_LABEL[plan.demoted[d].insteadOf] + 'を送るため）');
  }
  out.push('── 対象外: ' + _lbNudgeSkipText(plan.skipped));
  if (plan.rowErrors.length) out.push('── ⚠️ 判定できなかった会員: ' + plan.rowErrors.join(' / '));

  var txt = out.join('\n');
  Logger.log(txt);
  return txt;
}

// 一覧に載せる日本語サンプル（実際に送るのは会員ごとの言語の文面）。
function _lbNudgeSampleText(kind, plan, t) {
  return _lbNudgeText(kind, 'ja', {
    monthLabel: _lbNudgeMonthLabel(plan.month, 'ja'), pattern: t.pattern || '',
    quota: t.quota || 0, remain: t.remain, carry: t.carry, days: t.days,
    next: t.next || '', expire: t.expire || ''
  });
}

// ============================================================
// 1日1回のトリガーの入口（★これ以外のトリガーは作らない）
//   4種すべてをこの1回でまとめて判定する。month_open は解放日（既定25日）だけ内部で当たる。
// ============================================================
function lbNudgeDaily(nowMs) {
  var ms = (nowMs != null) ? nowMs : new Date().getTime();
  return _lbNudgeSend(lbNudgePlanAll(ms), ms);
}

// ------------------------------------------------------------
// 初回だけ：判定に使うシートを用意する（fail-closed で止まらないように）
//   transfer_credits は当日キャンセルが1件も無いと存在しない。存在しないと全リマインドが止まる
//   仕様（要件9）なので、有効化の前に1回だけ実行して空のシートを作っておく。
// ------------------------------------------------------------
function lbNudgeSetupSheets() {
  _lbTcreditSheet();       // transfer_credits（当日キャンセルの見分けに必須）
  _lbNudgeLogSheet();      // nudge_log（送信記録・再送抑止の正本）
  Logger.log('✅ transfer_credits / nudge_log を確認しました（無ければ作成済み）');
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
