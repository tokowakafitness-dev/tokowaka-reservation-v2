// 顧客を1人開いたときの一括取得。
//   いまGASで4回・16.7秒かかっている範囲（InBody・残数・固定枠・名簿）を1回にまとめる。

import { readHome } from './boot.js';

export async function routeCustomerDetail({ body, env, who }) {
  const customerId = String(body.customerId || (who.role === 'customer' ? who.customerId : ''));
  if (!customerId) return { code: 'BAD_REQUEST', customer: null };

  const [cust, home, bodyRows, recur, resv] = await Promise.all([
    env.DB.prepare(
      `SELECT customer_id, name, kana, phone, email, birthday, default_trainer_id,
              contract_status, lang, goal, note
         FROM customers WHERE customer_id = ?`
    ).bind(customerId).first(),
    readHome(env, customerId),
    env.DB.prepare(
      `SELECT record_id, measured_at, weight_kg, body_fat_pct, muscle_kg, note
         FROM body_records WHERE customer_id = ?
        ORDER BY measured_at DESC LIMIT 12`
    ).bind(customerId).all(),
    env.DB.prepare(
      `SELECT pattern_id, trainer_id, weekday, time
         FROM recurring_patterns WHERE customer_id = ? AND active = 1
        ORDER BY weekday, time`
    ).bind(customerId).all(),
    env.DB.prepare(
      `SELECT reservation_id, trainer_id, start_at, end_at, kind, attendee_count, status
         FROM reservations
        WHERE customer_id = ? AND start_at >= ? AND status = 'booked'
        ORDER BY start_at LIMIT 20`
    ).bind(customerId, Date.now()).all(),
  ]);

  if (!cust) return { code: 'NOT_FOUND', customer: null };

  return {
    customer: cust,
    home,
    bodyRecords: bodyRows.results || [],
    recurring: recur.results || [],
    reservations: resv.results || [],
  };
}

// 契約の履歴（金額を含む）。許可表により trainer / owner しか到達しない。
// 粗利は perms.js の redact がトレーナーには落とす。
export async function routeContractList({ body, env, who }) {
  const customerId = String(body.customerId || '');
  if (!customerId) return { code: 'BAD_REQUEST', contracts: [] };

  const r = await env.DB.prepare(
    `SELECT contract_id, course, mode, freq, tickets, unit_price AS unitPrice,
            monthly_price AS monthlyPrice, pair, rental, start_date AS startDate,
            end_date AS endDate, carry_cap AS carryCap, trainer_id AS trainerId,
            reward_rate AS rewardRate, join_fee AS joinFee, status,
            created_by AS createdBy, created_at AS createdAt,
            approved_by AS approvedBy, approved_at AS approvedAt
       FROM contracts WHERE customer_id = ?
      ORDER BY start_date DESC, created_at DESC`
  ).bind(customerId).all();

  const rows = r.results || [];

  // 粗利はオーナーにだけ計算して載せる。トレーナー向けには計算自体をしない。
  const FLOOR = { 'フルサポート': 5000, '通常': 3000, 'レンタル': 0, 'モニター': 3000 };
  const withMargin = rows.map((c) => {
    const unit = c.unitPrice || 0;
    const pay = Math.max(unit * ((c.rewardRate || 35) / 100), FLOOR[c.course] || 0);
    if (who.role !== 'owner') return { ...c, trainerPay: Math.round(pay) };
    return {
      ...c,
      trainerPay: Math.round(pay),
      grossAmount: Math.round(unit - pay),
      grossMargin: unit > 0 ? Math.round(((unit - pay) / unit) * 1000) / 10 : null,
    };
  });

  return { contracts: withMargin };
}
