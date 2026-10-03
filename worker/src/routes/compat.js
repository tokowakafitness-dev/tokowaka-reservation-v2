// GASと同じ形で返す層。
//
// なぜこうするか：
//   画面（LIFF）の描画コードを書き換えずに、通信先だけを差し替えたい。
//   形を変えると、表示・分岐・言語まで全部を追いかけることになり、壊す余地が増える。
//   だから「中身はD1から、形はGASのまま」にして、画面から見て違いが無い状態にする。
//
// 日時はすべて日本時間で扱う。ここを取り違えると、前日17時の締め切りや
// 「M月d日(曜)」の表示が1日ずれる。

import { canSeeCustomer, customerScopeSql } from '../perms.js';

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

// 役割と担当の写しが古いかどうか。
//   ★なぜ要るのか（2026-10-03・Codexの最終判定）
//     Workerは「誰がトレーナーか」「誰が誰の担当か」をD1だけで決めている。
//     その写しが古いと、次のことが起きる。
//       ・会員登録した直後、別の端末では「未登録のお客様」と判定される
//       ・担当を変えた直後、前の担当トレーナーがまだその顧客を見られる
//       ・**同期が止まると、古い権限が無期限に残る**
//     残数や予約一覧には鮮度の判定があるのに、**権限そのものには無かった。**
//     古い権限で正しい残数を返しても意味がない。ここが一番外側の関門。
export async function rolesTooOld(env) {
  if (await listTooOld(env, 'customers')) return true;
  return await listTooOld(env, 'trainers');
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

// 写しが古すぎるときは null を返す＝画面はGASに聞き直す。
async function readHomeSafe(env, customerId, targetMs) {
  const { readHome, HOME_TTL_HARD_MS } = await import('./boot.js');
  const home = await readHome(env, customerId, targetMs);
  if (!home) return null;
  if (home.ageMs != null && home.ageMs > HOME_TTL_HARD_MS) return null;
  return home;
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
// 一覧ものの鮮度（2026-09-29）
//
//   予約は15分ごと、固定枠は15分ごとに押し出している。
//   「同期がN分前」なら保証できるのは「直近N分の書き込みが写しに無い」ことだけ。
//   Nが大きくなったら答えない。押し出しが止まったまま古い一覧を返し続けると、
//   取り消した予約が残る／新しい予約が出ない、が起きる。
//   ★いつ同期したか分からないときも答えない（記録が無い＝信用できない）。
// ---------------------------------------------------------------
const LIST_TTL_MS = {
  reservations: 20 * 60 * 1000,
  recurring:    30 * 60 * 1000,
  // ★役割と担当（誰がトレーナーか・誰の担当か）の写し（2026-10-03・Codexの最終判定）。
  //   15分ごとに全件を同期している。2回ぶん待っても届かないなら、写しを信用しない。
  customers:    30 * 60 * 1000,
  trainers:     30 * 60 * 1000,
};
async function listTooOld(env, key) {
  try {
    const r = await env.DB.prepare('SELECT synced_at FROM sync_state WHERE key = ?').bind(key).first();
    const at = Number((r && r.synced_at) || 0);
    if (!at) return true;
    return (Date.now() - at) > (LIST_TTL_MS[key] || 20 * 60 * 1000);
  } catch (_) { return true; }
}

// ---------------------------------------------------------------
// getTrainerReservations と同じ形（担当予約の管理）
// ---------------------------------------------------------------
export async function compatTrainerReservations({ env, who, body }) {
  if (await listTooOld(env, 'reservations')) return { _fallback: true };
  const owner = who.role === 'owner';
  const lang = String(body.lang || 'ja');
  const now = Date.now();

  // 担当の顧客＋担当が決まっていない顧客（オーナーは全員）
  const scope = customerScopeSql(who);
  const custSql = owner
    ? `SELECT customer_id, name FROM customers
        WHERE contract_status IS NULL OR contract_status <> '退会' ORDER BY name`
    : `SELECT customer_id, name FROM customers
        WHERE ${scope.where} AND (contract_status IS NULL OR contract_status <> '退会')
        ORDER BY name`;
  const resvSql = owner
    ? `SELECT reservation_id, customer_id, customer_name, start_at, channel, trainer_id
         FROM reservations WHERE start_at >= ? AND status = 'booked' ORDER BY start_at`
    // ★GAS側と同じ範囲にする（2026-10-03・Codexの4回目の判定）。
    //   GAS：予約の担当が自分 **または** 顧客が自分の担当（担当なしを含む）
    //   以前はここが「予約の担当が自分」だけで、Worker経由にした瞬間に
    //   **自分の顧客の予約が一覧から消える**（他のトレーナーが代行した分など）。
    //   見える範囲が経路によって変わるのは、それ自体が不具合。
    //   なお操作（キャンセル・変更）の権限はGAS側が予約行ごとに判定するので、
    //   ここで広く見えても、他人の担当予約を動かせるわけではない。
    : `SELECT reservation_id, customer_id, customer_name, start_at, channel, trainer_id
         FROM reservations
        WHERE start_at >= ? AND status = 'booked'
          AND (trainer_id = ?
               OR customer_id IN (SELECT customer_id FROM customers WHERE ${scope.where}))
        ORDER BY start_at`;

  const [custs, resv] = await Promise.all([
    owner ? env.DB.prepare(custSql).all() : env.DB.prepare(custSql).bind(...scope.args).all(),
    owner ? env.DB.prepare(resvSql).bind(now).all()
          : env.DB.prepare(resvSql).bind(now, who.trainerId, ...scope.args).all(),
  ]);

  const reservations = (resv.results || []).map((r) => ({
    // ★この値は、画面がそのままGASへ渡してキャンセル・変更に使う。
    //   GASは予約シートの備考欄でこの値を照合するので、
    //   押し出し側（PushToEdge.js）が備考欄のresIdを reservation_id に入れている。
    //   ここで別の値に差し替えてはいけない。
    reservationId: String(r.reservation_id),
    // ★この予約の担当（2026-10-03・Codexの最終判定）。
    //   一覧には「自分の担当顧客が、別のトレーナーで取った予約」も出る。
    //   ところが変更・取消は**その予約の担当**しかできない（GASが拒む）。
    //   これが無いと「ボタンは出るのに押すと断られる」ことになる。
    trainerId: String(r.trainer_id || ''),
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
export async function compatCustomerHome({ env, body, who }) {
  const customerId = String(body.customerId || '');
  if (!customerId) return { _fallback: true };
  if (!(await canSeeCustomer(env, who, customerId))) return { _forbidden: true };
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
export async function compatRecurringList({ env, body, who }) {
  const customerId = String(body.customerId || '');
  if (!customerId) return { patterns: [] };
  if (!(await canSeeCustomer(env, who, customerId))) return { _forbidden: true };
  if (await listTooOld(env, 'recurring')) return { _fallback: true };
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
  // ★閲覧範囲の確認。ここが抜けていて、トレーナーが顧客IDを指定すれば
  //   担当外の顧客のチケット残数・期限・ペア残数を取得できた（2026-09-29）。
  if (!(await canSeeCustomer(env, who, customerId))) return { _forbidden: true };

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
// getMyReservations と同じ形（会員のマイ予約）
//
//   今後のご予約  … status=confirmed かつ未来
//   これまでの記録 … 過去のconfirmed（実施済み）と consumed（当日キャンセル＝消化）
//   cancelled（前日までの無料取消）と changed は記録に出さない。消化していないため。
// ---------------------------------------------------------------
const ST = {
  st_transfer_done:    { ja: '振替・実施済み', en: 'Transfer · done', zh: '改期・已完成', 'zh-Hant': '改期・已完成' },
  st_done:             { ja: '実施済み', en: 'Done', zh: '已完成', 'zh-Hant': '已完成' },
  st_transfer_sameday: { ja: '振替セッション（当日キャンセル）', en: 'Transfer session (same-day cancel)',
                         zh: '改期课程（当天取消）', 'zh-Hant': '改期課程（當天取消）' },
  st_sameday_used:     { ja: '当日キャンセル（消化）', en: 'Same-day cancel (used)',
                         zh: '当天取消（已消耗）', 'zh-Hant': '當天取消（已消耗）' },
};
function st(key, lang) {
  const e = ST[key] || {};
  return e[lang] || e.ja || '';
}

export async function compatMyReservations({ env, who, body }) {
  if (!who.customerId) return { _fallback: true };
  if (await listTooOld(env, 'reservations')) return { _fallback: true };
  const lang = String(body.lang || 'ja');
  const now = Date.now();

  const [rows, trainers] = await Promise.all([
    env.DB.prepare(
      `SELECT reservation_id, trainer_id, start_at, status, channel, book_type
         FROM reservations WHERE customer_id = ? ORDER BY start_at`
    ).bind(who.customerId).all(),
    env.DB.prepare('SELECT trainer_id, name, name_en FROM trainers').all(),
  ]);

  const nameOf = {};
  for (const t of (trainers.results || [])) {
    nameOf[String(t.trainer_id)] = (lang === 'en' && t.name_en) ? t.name_en : (t.name || '');
  }

  const upcoming = [], history = [];
  for (const r of (rows.results || [])) {
    const isTransfer = String(r.channel || '') === 'transfer';
    const trainerName = nameOf[String(r.trainer_id)] || '';
    const label = resvLabel(r.start_at, lang);

    if (r.status === 'booked' && r.start_at >= now) {
      upcoming.push({
        reservationId: String(r.reservation_id),
        dateLabel: label,
        trainerName,
        status: 'confirmed',                       // 画面はGASの値を見るのでそろえる
        startISO: new Date(r.start_at).toISOString(),
        freeCancel: isFreeCancel(r.start_at, now),
        transfer: isTransfer,
        bookType: String(r.book_type || ''),
        _sort: r.start_at,
      });
    } else if (r.status === 'booked' && r.start_at < now) {
      history.push({ dateLabel: label, trainerName,
        statusLabel: st(isTransfer ? 'st_transfer_done' : 'st_done', lang), _sort: r.start_at });
    } else if (r.status === 'consumed') {
      history.push({ dateLabel: label, trainerName,
        statusLabel: st(isTransfer ? 'st_transfer_sameday' : 'st_sameday_used', lang), _sort: r.start_at });
    }
    // cancelled / changed は出さない
  }

  upcoming.sort((a, b) => a._sort - b._sort);      // 近い順
  history.sort((a, b) => b._sort - a._sort);       // 新しい順
  upcoming.forEach((o) => { delete o._sort; });
  history.forEach((o) => { delete o._sort; });

  return { reservations: upcoming, history };
}

// ---------------------------------------------------------------
// getTrainerSlots と同じ形
//
//   ★中身は routeSlots（三段構え）に委ねる（2026-10-03）。
//     以前はここで slots_cache を直接読んでいた。つまり**顧客の画面は②だけを見ており、
//     ①（calendar_events から計算する経路）が1ミリも効いていなかった。**
//     画面（liff/index.html）が呼ぶのは c_trainerSlots → ここ、の一本道なので、
//     ここを繋ぎ変えない限り①は誰にも届かない。
//
//   ★この関数の責務は「形を GAS のまま保つこと」だけにする。
//     ・空き枠を選ぶ判断（どの経路から・どの枠を落とすか）… routeSlots
//     ・締め切りの判定                                    … 下の isSlotOpen（routeSlots が使う）
//     ・GAS と同じ形に直す                                … ここ
//     判断をここにも書くと、同じ枠が経路によって出たり出なかったりする。
//
//   ★返す形は**一切変えない**。画面は res.slots（date/startTime/endTime/startISO…）だけを
//     読み、失敗（_fallback）は index.js が success:false + code:'FALLBACK' に直して
//     画面がGASへ落ちる。source や stale のような新しい項目はここでは出さない。
//     どの経路で返したかを見たいときは、同じ routeSlots を直接叩く窓口（action:'slots'）を使う。
// ---------------------------------------------------------------
export async function compatTrainerSlots({ env, body, who }) {
  const trainerId = String(body.trainerId || who.trainerId || '');
  if (!trainerId) return { _fallback: true };

  // ---- 引数の違いを吸収する ----
  //   画面は excludeStartISO（ISO文字列）を送り、routeSlots は excludeStartMs（ミリ秒）を見る。
  //   読めない日時は 0（＝除外なし）へ。以前も new Date('...').getTime() が NaN になり、
  //   `if (exMs && ...)` で除外なしに倒れていた。そこを変えない。
  const exISO = String(body.excludeStartISO || '');
  const exMs = exISO ? new Date(exISO).getTime() : 0;
  const excludeStartMs = isFinite(exMs) ? exMs : 0;

  // ★excludeStartMs は**必ずここで上書きする。**
  //   画面が直接 excludeStartMs を送っても効かせない（以前は見ていなかった項目なので、
  //   ここで通すと「この入口で除外できる枠」が増える＝挙動が変わる）。
  const { routeSlots, SLOT_SOURCE } = await import('./slots.js');
  const r = await routeSlots({ env, who, body: { ...body, trainerId, excludeStartMs } });

  // ---- 「答えない」の決め方（以前の条件をそのまま移す）----
  //   以前：写しが無い／payload が読めない／computed_at が無い／20分より古い → _fallback
  //   いま：
  //     source:'none'            … 写しが無い／読めない      （以前の _fallback と同じ）
  //     source:'cache' + stale   … computed_at が無い／20分超（以前の _fallback と同じ。
  //                                 境界も CACHE_STALE_MS = 20分で揃えてある）
  //     source:'calendar'        … ①で計算できた。stale は立たない（鮮度は readCalendar が見る）
  //   ★stale だけで決めない。code（trainerId が無い等）と source も見る。
  //     routeSlots は「枠は返すが stale」という返し方をするので、ここで落とさないと
  //     古い枠をそのまま見せてしまう（＝表示されているのに取れない）。
  if (!r || r.code) return { _fallback: true };
  if (r.source === SLOT_SOURCE.NONE) return { _fallback: true };
  if (r.source === SLOT_SOURCE.CACHE && r.stale) return { _fallback: true };

  // 画面に渡す computedAt は必ず数値。無ければ答えない（以前と同じ）。
  const computedAt = Number(r.computedAt || 0);
  if (!computedAt) return { _fallback: true };

  // ★ここで締め切りをもう一度判定しない。routeSlots が keepSlot（この下の isSlotOpen）で
  //   すでに絞っている。二重に判定すると、excludeStartISO で残した「自分の枠」まで
  //   落としてしまう（予約変更ができなくなる）。
  const slots = (r.slots || []).map((s) => ({
    date: s.date, dayOfWeek: s.dayOfWeek, startTime: s.startTime, endTime: s.endTime,
    startISO: s.startISO, endISO: s.endISO,
    trainerName: s.trainerName, trainerId: s.trainerId, trialOk: s.trialOk,
  }));

  return { slots, computedAt, ageMs: Date.now() - computedAt };
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

// ===============================================================
// line_boot / line_customerCard と同じ形（まとめ取得）
// ===============================================================
//
//   ★なぜ要るのか（2026-10-03 の実測）
//     本番の計測で、通信15回のうち**86%がGASの3回**だった。
//       boot 6,168ms ／ customerCard 5,565ms ／ customerCard 8,312ms ＝ 20,045ms
//       （Workerの3回は 1,255 + 805 + 321 ＝ 2,381ms）
//     ところが画面の _fetchBoot / _fetchCustomerCard は _apiGas を直接呼んでおり、
//     api() も _apiSend も通らない。つまり ?edge=1 を入れてもこの2回はGASのままで、
//     体感速度は一切変わらなかった。ここを塞がない限り軽量化は完成しない。
//
//   ★中身は新規実装ではない。
//     必要な部品（memberStatus / trainers / 予約一覧 / 顧客ホーム / 固定枠）は
//     すべて上の compat* に在る。ここはそれを**束ねるだけ**。
//     2026-09-29 に見つかった3つの穴（残数の鮮度・予約オプションの閲覧範囲・
//     予約一覧と固定枠の鮮度）は、各 compat* の側で塞いである。束ねても効き続ける。
//
//   ★役割に応じた削り落とし（perms.js の redact）は入れ子も辿るので、
//     parts に束ねても同じように効く。粗利や報酬が parts 経由で漏れることはない。
//
//   ★1つ転んでも残りは返す（GASの lbBoot と同じ作法）。
//     転んだパートには PART_FAILED を入れる。画面はそれだけを個別に取り直し、
//     その取得はGASへ行く。**全部が止まるより、1つだけ遅いほうがよい。**

// パートを1つ組み立てる。答えられないものは PART_FAILED にする。
//   ★ここで「空の成功」を作らない。_fallback を {success:true} に化かすと、
//     画面が「0件」や「残数なし」をそのまま表示してしまう。
async function _part(parts, name, fn, arg) {
  try {
    const r = await fn(arg);
    parts[name] = (!r || r._fallback || r._forbidden)
      ? { success: false, code: 'PART_FAILED' }
      : { success: true, ...r };
  } catch (e) {
    console.warn('batch part', name, e && e.message);
    parts[name] = { success: false, code: 'PART_FAILED' };
  }
}

export async function compatBoot(arg) {
  const parts = {};

  // 会員状態はまとめの前提。ここが答えられないなら、まとめ全体を諦めてGASに任せる。
  //   （success:true のまま転んだ中身を返すと、画面がそれを会員状態として解釈して
  //     起動できなくなる。GAS側で 2026-09-29 に Codex が指摘したのと同じ理由。）
  const ms = await compatMemberStatus(arg);
  if (!ms || ms._fallback || ms._forbidden) return { _fallback: true };
  parts.memberStatus = { success: true, ...ms };

  // 残りは同時に取る（D1は並べて引ける。順に待つ理由がない）
  if (ms.role === 'trainer') {
    await Promise.all([
      _part(parts, 'trainerReservations', compatTrainerReservations, arg),
      _part(parts, 'trainers', compatTrainers, arg),
    ]);
  } else if (ms.verified) {
    await Promise.all([
      _part(parts, 'myReservations', compatMyReservations, arg),
      _part(parts, 'trainers', compatTrainers, arg),
    ]);
  }
  return { parts };
}

export async function compatCustomerCard(arg) {
  const customerId = String((arg.body && arg.body.customerId) || '');
  if (!customerId) return { _fallback: true };
  // ★閲覧範囲は compatCustomerHome / compatRecurringList の中でも確かめるが、
  //   ここでも先に1回見る。見てよい相手でないなら、3つとも走らせる意味がない。
  if (!(await canSeeCustomer(arg.env, arg.who, customerId))) return { _forbidden: true };

  const parts = {};
  await Promise.all([
    _part(parts, 'customerHome', compatCustomerHome, arg),
    _part(parts, 'recurring', compatRecurringList, arg),
  ]);

  // InBody（maInBodyCard）はWorkerに無い。meal-ai の別系統で、D1に写しを持っていない。
  //   ★ここで空の成功を作らない。PART_FAILED にして、画面にGASから取り直させる。
  //     「実測はまだありません」と嘘を出すより、1回だけGASに行くほうがよい。
  parts.inBody = { success: false, code: 'PART_FAILED' };

  return { parts };
}
