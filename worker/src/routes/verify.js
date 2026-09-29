// 照合専用の入口（2026-09-29）
//
//   GASの計算結果とWorkerの計算結果を突き合わせるためだけに使う。
//   ★時計のずれや既定値の違いを「実装の差」に見せないため、
//     「いつを今とするか(nowKey)」「繰越率」「どの時点を計算するか」は
//     すべてGASから受け取る。こちらでは決めない。
//
//   認証はID Tokenではなく合言葉。お客様のブラウザからは呼ばせない。

import { loadCalcInput } from '../calc.js';
import { _lbComputeRemaining } from '../allocate.js';

function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a || ''));
  const y = new TextEncoder().encode(String(b || ''));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}
const json = (b, s = 200) => new Response(JSON.stringify(b), {
  status: s, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

const MAX_TIMES = 40;

export async function handleCalc(request, env) {
  try {
    const secret = env.SHARED_SECRET || '';
    if (!secret) return json({ success: false, code: 'SECRET_NOT_SET' }, 503);
    if (!safeEqual(request.headers.get('X-Ingest-Secret') || '', secret)) {
      return json({ success: false, code: 'FORBIDDEN' }, 403);
    }

    let body;
    try { body = await request.json(); } catch (_) { return json({ success: false, code: 'BAD_JSON' }, 400); }

    const customerId = String(body.customerId || '');
    if (!customerId) return json({ success: false, code: 'NO_CUSTOMER' }, 400);
    const times = Array.isArray(body.times) ? body.times.slice(0, MAX_TIMES) : [];
    if (!times.length) return json({ success: false, code: 'NO_TIMES' }, 400);
    const nowKey = String(body.nowKey || '');
    if (!/^\d{4}-\d{2}$/.test(nowKey)) return json({ success: false, code: 'BAD_NOW_KEY' }, 400);
    const carryRate = Number(body.carryRate);
    if (!(isFinite(carryRate) && carryRate > 0)) return json({ success: false, code: 'BAD_CARRY_RATE' }, 400);

    const input = await loadCalcInput(env, customerId);
    if (!input.ok) return json({ success: false, code: 'NO_INPUT', detail: input.reason }, 200);

    const results = times.map((t) => {
      const tMs = Number(t);
      if (!isFinite(tMs)) return null;
      return _lbComputeRemaining(customerId, input.rows, input.sessions, nowKey, tMs, carryRate, input.opening);
    });

    return json({
      success: true,
      customerId,
      contractRows: input.rows.length,
      sessions: input.sessions.length,
      hasOpening: !!input.opening,
      results,
    });
  } catch (e) {
    return json({ success: false, code: 'INTERNAL', detail: String((e && e.message) || e).slice(0, 300) }, 500);
  }
}
