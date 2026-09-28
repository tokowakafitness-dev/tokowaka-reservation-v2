// GASと同じ形で返す層。
//
// なぜこうするか：
//   画面（LIFF）の描画コードを書き換えずに、通信先だけを差し替えたい。
//   形を変えると、表示・分岐・言語まで全部を追いかけることになり、壊す余地が増える。
//   だから「中身はD1から、形はGASのまま」にして、画面から見て違いが無い状態にする。
//
// 日時はすべて日本時間で扱う。ここを取り違えると、前日17時の締め切りや
// 「M月d日(曜)」の表示が1日ずれる。

const JST = 9 * 3600 * 1000;
const DOW = { ja: ['日', '月', '火', '水', '木', '金', '土'],
              en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
              zh: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
              'zh-Hant': ['週日', '週一', '週二', '週三', '週四', '週五', '週六'] };
const MON_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function jst(ms) {
  const d = new Date(ms + JST);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(),
           h: d.getUTCHours(), mi: d.getUTCMinutes(), dow: d.getUTCDay() };
}
const p2 = (n) => String(n).padStart(2, '0');

/** GASの _lbFmtResvLabel と同じ表示（M月d日(曜) HH:mm） */
export function resvLabel(ms, lang) {
  const t = jst(ms);
  const hm = `${p2(t.h)}:${p2(t.mi)}`;
  if (lang === 'en') return `${MON_EN[t.mo]} ${t.d} (${DOW.en[t.dow]}) ${hm}`;
  const dow = (DOW[lang] || DOW.ja)[t.dow];
  return `${t.mo + 1}月${t.d}日(${dow}) ${hm}`;
}

/** GASの _lbIsFreeCancelWindow と同じ規則：前日17時（日本時間）より前なら無料 */
export function isFreeCancel(startMs, nowMs) {
  const t = jst(startMs);
  const deadline = Date.UTC(t.y, t.mo, t.d - 1, 17, 0) - JST;
  return (nowMs == null ? Date.now() : nowMs) < deadline;
}

// ---------------------------------------------------------------
// getMemberStatus と同じ形
// ---------------------------------------------------------------
export async function compatMemberStatus({ env, who }) {
  if (who.role === 'trainer' || who.role === 'owner') {
    return { verified: true, role: 'trainer', trainerName: who.name,
             trainerId: who.trainerId, isOwner: who.role === 'owner' };
  }
  if (who.role !== 'customer') return { verified: false };

  const [cust, home] = await Promise.all([
    env.DB.prepare(
      `SELECT customer_id, name, contract_status, contract_type, default_trainer_id
         FROM customers WHERE customer_id = ?`
    ).bind(who.customerId).first(),
    readHomeSafe(env, who.customerId),
  ]);
  if (!cust) return { verified: false };
  if (!home) return { _fallback: true };          // 残数が無い＝画面はGASに聞き直す

  return {
    verified: true,
    onboarding: false,
    name: cust.name,
    customerId: cust.customer_id,
    contractStatus: cust.contract_status || '',
    contractType: cust.contract_type || '',
    defaultTrainerId: cust.default_trainer_id || '',
    isPair: (home.pairRemaining || 0) > 0,
    hasNormalRoute: !!home.hasNormalRoute,
    pairRemaining: home.pairRemaining || 0,
    pairPackMax: home.pairPackMax || 0,
    transferCredits: home.transferCredits || { available: 0 },
    home,
  };
}

async function readHomeSafe(env, customerId, targetMs) {
  const { readHome } = await import('./boot.js');
  return readHome(env, customerId, targetMs);
}

// ---------------------------------------------------------------
// getTrainers と同じ形
// ---------------------------------------------------------------
export async function compatTrainers({ env, who }) {
  const r = await env.DB.prepare(
    'SELECT trainer_id AS id, name, hidden FROM trainers WHERE active = 1 ORDER BY name'
  ).all();
  const mine = String(who.trainerId || '');
  const trainers = (r.results || [])
    .filter((t) => !t.hidden || String(t.id) === mine)
    .map((t) => ({ id: t.id, name: t.name }));
  return { trainers };
}

// ---------------------------------------------------------------
// getTrainerReservations と同じ形（担当予約の管理）
// ---------------------------------------------------------------
export async function compatTrainerReservations({ env, who, body }) {
  const owner = who.role === 'owner';
  const lang = String(body.lang || 'ja');
  const now = Date.now();

  const custSql = owner
    ? `SELECT customer_id, name FROM customers
        WHERE contract_status IS NULL OR contract_status <> '退会' ORDER BY name`
    : `SELECT customer_id, name FROM customers
        WHERE default_trainer_id = ? AND (contract_status IS NULL OR contract_status <> '退会')
        ORDER BY name`;
  const resvSql = owner
    ? `SELECT reservation_id, customer_id, customer_name, start_at, channel
         FROM reservations WHERE start_at >= ? AND status = 'booked' ORDER BY start_at`
    : `SELECT reservation_id, customer_id, customer_name, start_at, channel
         FROM reservations WHERE start_at >= ? AND status = 'booked' AND trainer_id = ?
         ORDER BY start_at`;

  const [custs, resv] = await Promise.all([
    owner ? env.DB.prepare(custSql).all() : env.DB.prepare(custSql).bind(who.trainerId).all(),
    owner ? env.DB.prepare(resvSql).bind(now).all()
          : env.DB.prepare(resvSql).bind(now, who.trainerId).all(),
  ]);

  const reservations = (resv.results || []).map((r) => ({
    reservationId: String(r.reservation_id),
    dateLabel: resvLabel(r.start_at, lang),
    customerName: String(r.customer_name || ''),
    customerId: String(r.customer_id || ''),
    startISO: new Date(r.start_at).toISOString(),
    freeCancel: isFreeCancel(r.start_at, now),
    transfer: String(r.channel || '') === 'transfer',
    _sort: r.start_at,
  }));

  const customers = (custs.results || []).map((c) => ({
    customerId: String(c.customer_id), name: String(c.name || ''),
  }));

  return { trainerName: who.name, reservations, customers };
}

// ---------------------------------------------------------------
// getCustomerHome と同じ形
// ---------------------------------------------------------------
export async function compatCustomerHome({ env, body }) {
  const customerId = String(body.customerId || '');
  if (!customerId) return { _fallback: true };
  const [cust, home] = await Promise.all([
    env.DB.prepare('SELECT name FROM customers WHERE customer_id = ?').bind(customerId).first(),
    readHomeSafe(env, customerId),
  ]);
  if (!cust || !home) return { _fallback: true };
  return { name: cust.name, home };
}

// ---------------------------------------------------------------
// listRecurringPatternsByTrainer と同じ形
// ---------------------------------------------------------------
export async function compatRecurringList({ env, body }) {
  const customerId = String(body.customerId || '');
  if (!customerId) return { patterns: [] };
  const r = await env.DB.prepare(
    `SELECT pattern_id, customer_id, trainer_id, weekday, time
       FROM recurring_patterns WHERE customer_id = ? AND active = 1
      ORDER BY weekday, time`
  ).bind(customerId).all();
  const lang = String(body.lang || 'ja');
  const dows = DOW[lang] || DOW.ja;
  const patterns = (r.results || []).map((p) => ({
    patternId: String(p.pattern_id),
    customerId: String(p.customer_id),
    trainerId: String(p.trainer_id || ''),
    weekday: p.weekday,
    time: String(p.time || ''),
    label: `毎週${dows[p.weekday]}曜 ${p.time}`,
  }));
  return { patterns };
}

// ---------------------------------------------------------------
// getBookingOptions と同じ形（予約する日時の消化先）
// ---------------------------------------------------------------
export async function compatBookingOptions({ env, who, body }) {
  const customerId = String(body.customerId || who.customerId || '');
  const startISO = String(body.startISO || '');
  const startMs = startISO ? new Date(startISO).getTime() : Number(body.startMs || 0);
  if (!customerId || !startMs || isNaN(startMs)) return { _fallback: true };

  const home = await readHomeSafe(env, customerId, startMs);
  if (!home) return { _fallback: true };          // その月を持っていない＝GASに聞き直す

  // 対象日に有効なペアpackのうち、いちばん早く切れるものの期限
  let pairExpire = '';
  for (const p of (home.ticketPacks || [])) {
    if ((p.kind || 'normal') === 'pair') { pairExpire = p.expire || ''; break; }
  }
  return {
    customerId,
    startISO: startISO || new Date(startMs).toISOString(),
    pairRemaining: home.pairRemaining || 0,
    pairPackMax: home.pairPackMax || 0,
    pairExpire,
    normalTicketRemaining: home.normalTicketRemaining || 0,
    hasNormalRoute: !!home.hasNormalRoute,
  };
}

// ---------------------------------------------------------------
// getTrainerSlots と同じ形
// ---------------------------------------------------------------
export async function compatTrainerSlots({ env, body, who }) {
  const trainerId = String(body.trainerId || who.trainerId || '');
  if (!trainerId) return { _fallback: true };
  const row = await env.DB.prepare(
    'SELECT payload, computed_at FROM slots_cache WHERE trainer_id = ?'
  ).bind(trainerId).first();
  if (!row) return { _fallback: true };
  let raw;
  try { raw = JSON.parse(row.payload); } catch (_) { return { _fallback: true }; }

  // 写しが古すぎるときは答えない。空き枠は予約で変わるため、古い枠を見せると
  // 「表示されているのに取れない」が起きる。
  const age = Date.now() - (row.computed_at || 0);
  if (age > 20 * 60 * 1000) return { _fallback: true };

  const now = Date.now();
  const cfg = raw.rules || { leadMinutes: 180, morningUntilHour: 12, prevDeadlineHour: 22 };
  const exISO = String(body.excludeStartISO || '');
  const exMs = exISO ? new Date(exISO).getTime() : 0;

  const slots = (raw.slots || []).filter((s) => {
    if (exMs && s.startMs === exMs) return true;
    if (s.startMs <= now) return false;
    return isSlotOpen(s.startMs, now, cfg);
  }).map((s) => ({
    date: s.date, dayOfWeek: s.dayOfWeek, startTime: s.startTime, endTime: s.endTime,
    startISO: s.startISO, endISO: s.endISO,
    trainerName: s.trainerName, trainerId: s.trainerId, trialOk: s.trialOk,
  }));

  return { slots, computedAt: row.computed_at, ageMs: age };
}

// 午前枠は前日22時で締め切る（GASの BookingRules.js と同じ規則）
function isSlotOpen(startMs, now, cfg) {
  const lead = (cfg.leadMinutes || 180) * 60000;
  let deadline = startMs - lead;
  const t = jst(startMs);
  const mUntil = Number(cfg.morningUntilHour);
  const prevH = Number(cfg.prevDeadlineHour);
  // GASの _lbIsMorningSlot と同じ条件にそろえる：
  //   morningUntilHour は 1〜23 のときだけ有効（24以上だと全枠が午前になってしまう）
  //   prevDeadlineHour は 0〜23 が有効。0は「無効化」ではなく前日0時を意味する
  //   （コード.js のコメントは「0で無効化」とあるが、実装はそうなっていない）
  if (isFinite(mUntil) && mUntil > 0 && mUntil <= 23
      && isFinite(prevH) && prevH >= 0 && prevH <= 23 && t.h < mUntil) {
    const prev = Date.UTC(t.y, t.mo, t.d - 1, prevH, 0) - JST;
    deadline = Math.min(deadline, prev);
  }
  return now < deadline;
}

export const _forTest = { jst, resvLabel, isFreeCancel, isSlotOpen };
