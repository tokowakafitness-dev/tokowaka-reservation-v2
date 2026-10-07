// D1の枠と引当から出した残数が、計算と一致するかを突き合わせる
//
//   ★既存の照合（routes/verify.js）とは別のことを見る
//     既存    GASの計算 vs Workerの計算   … 同じコードを回すので、合って当然
//     ここ    計算の答え vs D1の行         … **別々の仕組みが同じ答えに至るか**
//
//   ★なぜこれが要るのか
//     D1を正本にするとは「残数を計算で出す」のをやめて「行から読む」ことである。
//     行から読んだ値が計算と違えば、顧客の残数が変わる。
//     段階3-b（読み取りをD1へ向ける）に進んでよいかは、ここが一致するかで決まる。
//
//   読み取りだけ。何も書き換えない。

import { loadCalcInput } from '../calc.js';
import { _lbComputeRemaining } from '../allocate.js';

function nowMonthKeyJst(ms) {
  const d = new Date(ms + 9 * 3600000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function mask(id) {
  const s = String(id || '');
  return s ? '*' + s.slice(-4) : '';
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status, headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function requireSecret(request, env) {
  const secret = env.SHARED_SECRET || '';
  if (!secret) return json({ ok: false, reason: 'SECRET_NOT_SET' }, 503);
  const given = request.headers.get('X-Ingest-Secret') || '';
  const x = new TextEncoder().encode(given);
  const y = new TextEncoder().encode(secret);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  if (diff !== 0) return json({ ok: false, reason: 'FORBIDDEN' }, 403);
  return null;
}

/**
 * GET /quota/verify?month=2026-10&limit=5&after=...
 *
 *   会員ごとに
 *     計算の答え … _lbComputeRemaining（GASと1行ずつ揃えてある）
 *     D1の行     … monthly_quota.quota - used ／ ticket_packs の有効なぶんの残り
 *   を比べる。
 */
export async function verifyQuota(request, env) {
  const deny = requireSecret(request, env);
  if (deny) return deny;

  const url = new URL(request.url);
  const now = Date.now();
  const month = (url.searchParams.get('month') || nowMonthKeyJst(now)).trim();
  const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 5) || 5, 8));
  const after = (url.searchParams.get('after') || '').trim();
  const carryRate = Number(url.searchParams.get('rate') || '') || 1 / 3;

  if (!/^\d{4}-\d{2}$/.test(month)) return json({ ok: false, reason: 'BAD_MONTH', month }, 400);

  const r = await env.DB.prepare(
    `SELECT DISTINCT customer_id FROM calc_contract_rows
      WHERE customer_id > ? ORDER BY customer_id LIMIT ?`
  ).bind(after, limit).all();
  const ids = (r.results || []).map((x) => String(x.customer_id)).filter(Boolean);

  const out = {
    ok: true, month, customers: ids.length, checked: 0,
    agree: 0, differ: 0, skipped: 0,
    diffs: [],          // 食い違った会員（氏名は出さない）
    next: null, done: false,
  };

  for (const cid of ids) {
    const input = await loadCalcInput(env, cid);
    if (!input.ok) { out.skipped++; continue; }

    // ---- ① 計算の答え ----
    const a = _lbComputeRemaining(cid, input.rows, input.sessions, nowMonthKeyJst(now), now,
                                  carryRate, input.opening, false, true);
    if (!a || a.ok === false) { out.skipped++; continue; }

    // ---- ② D1の行から読んだ答え ----
    const [mq, tp] = await Promise.all([
      env.DB.prepare('SELECT quota, used FROM monthly_quota WHERE customer_id = ? AND month_key = ?')
        .bind(cid, month).first(),
      env.DB.prepare(
        `SELECT total, used FROM ticket_packs
          WHERE customer_id = ? AND valid_from <= ? AND valid_to >= ?`
      ).bind(cid, now, now).all(),
    ]);

    //   月額：枠が無い月は「月額の契約が無い」とみなす（計算側の null に合わせる）
    const d1Monthly = mq ? (Number(mq.quota) - Number(mq.used)) : null;
    //   チケット：いま有効なパックの残りを足す（計算側 ticketRem と同じ数え方）
    let d1Ticket = 0;
    for (const p of (tp.results || [])) d1Ticket += Math.max(0, Number(p.total) - Number(p.used));

    const calcMonthly = (a.monthlyRem == null) ? null : Number(a.monthlyRem);
    const calcTicket = Number(a.ticketRem || 0);

    out.checked++;
    const sameMonthly = (d1Monthly === null && calcMonthly === null) || (Number(d1Monthly) === Number(calcMonthly));
    const sameTicket = (d1Ticket === calcTicket);

    if (sameMonthly && sameTicket) { out.agree++; continue; }

    out.differ++;
    out.diffs.push({
      customerId: mask(cid),
      monthly: { calc: calcMonthly, d1: d1Monthly },
      ticket: { calc: calcTicket, d1: d1Ticket },
      //   ★食い違いの手がかり。枠がそもそも無いのか、使った数がずれているのか
      quotaRow: mq ? { quota: Number(mq.quota), used: Number(mq.used) } : null,
      packRows: (tp.results || []).length,
    });
  }

  out.next = (ids.length === limit) ? ids[ids.length - 1] : null;
  out.done = (out.next === null);
  if (out.differ) out.ok = false;   // 1人でも食い違えば「合っていない」
  return json(out);
}
