// shadow を毎日まとめて取る（sweep）・設計19（第8版・関門①を9往復で通過）
//
//   ★比べ方・記録・見送り（写しの鮮度・世代・枠）は runShadow の既存どおり。作り直さない。
//     食い違いはそのまま記録され、合格を止める（偽物かもしれなくても）。
//   ★顧客に返す値は変えない（観測だけ）。何があっても例外を外へ出さない（会員ごとに try）。
//   ★1回は最大4名（1名で D1 の文が約10）。

import { runShadow, SHADOW_MODE_ON } from './remain-shadow.js';
import { readHomeDiag } from '../routes/boot.js';

export const SWEEP_ENTRY = 'sweep';
export const SWEEP_MAX = 4;

function mask(id) { const s = String(id || ''); return s ? '*' + s.slice(-4) : ''; }
function idList(v, max) {
  return String(v || '').split(',').map((x) => x.trim()).filter((x) => /^[A-Za-z0-9_-]{1,64}$/.test(x)).slice(0, max);
}

// 結末の分け方（設計19 §2-1）。列挙の漏れを避けるため「それ以外は全部再試行」
export function classifySweep(r) {
  if (r && r.done === true) return 'completed';
  const why = String((r && r.why) || '');
  if (why === 'no_slot') return 'terminal';       // その日の枠を使い切った＝当日は再試行しない
  if (why === 'bad_args') return 'terminal';      // 実装の誤り＝再試行しても直らない
  return 'retry';
}

export async function runSweep(env, opts) {
  const o = opts || {};
  const mode = String((env && env.LB_D1_REMAIN_MODE) || 'off');
  if (mode !== SHADOW_MODE_ON) return { ok: true, skipped: 'MODE_OFF' };
  const nowMs = Number(o.nowMs || Date.now());
  const limit = Math.max(1, Math.min(Number(o.limit || SWEEP_MAX) || SWEEP_MAX, SWEEP_MAX));
  const only = idList(o.only, SWEEP_MAX);
  const skip = new Set(idList(o.skip, 500));
  const after = String(o.after || '');

  let ids;
  if (only.length) ids = only;
  else {
    //   ★対象は合格の分母と同じ（calc_contract_rows の会員）
    const r = await env.DB.prepare(
      `SELECT DISTINCT customer_id FROM calc_contract_rows WHERE customer_id > ? ORDER BY customer_id LIMIT ?`
    ).bind(after, limit).all();
    ids = (r.results || []).map((x) => String(x.customer_id)).filter(Boolean);
  }

  //   最初のページ（after 無し・only 無し）でだけ対象の人数を返す（点検で「比べ終わった < 対象」を見るため）
  let target = null;
  if (!only.length && !after) {
    try { const t = await env.DB.prepare('SELECT COUNT(DISTINCT customer_id) AS n FROM calc_contract_rows').first(); target = Number((t && t.n) || 0); } catch (_) {}
  }
  const out = { ok: true, target, customers: ids.length, members: [], completedIds: [], terminalIds: [], retry: [],
                done: { completed: 0, diffs: 0 }, why: {}, anomaly: 0,
                next: (!only.length && ids.length === limit) ? ids[ids.length - 1] : null };
  for (const cid of ids) {
    let r;
    if (skip.has(cid)) r = { done: false, why: 'dw_queued' };   // 台帳の変化が D1 に届いていない＝呼ばない（記録しない）
    else {
      try {
        const d = await readHomeDiag(env, cid, nowMs);
        r = await runShadow(env, { customerId: cid, entry: SWEEP_ENTRY, copyDiag: d, nowMs, targetMs: nowMs, lang: 'ja' });
      } catch (e) {
        r = { done: false, why: 'sweep_threw' };
        try { console.error('[sweep] 想定外', String((e && e.message) || e)); } catch (_) {}
      }
    }
    const c = classifySweep(r);
    out.members.push({ id: mask(cid), done: r.done === true, why: r.done ? null : String(r.why || '') });
    if (c === 'completed') { out.completedIds.push(cid); out.done.completed++; out.done.diffs += Number(r.diffs || 0); }
    else {
      out.why[String(r.why || '?')] = (out.why[String(r.why || '?')] || 0) + 1;
      if (c === 'terminal') { out.terminalIds.push(cid); if (r.why === 'bad_args') out.anomaly++; }
      else out.retry.push(cid);
    }
  }
  return out;
}
