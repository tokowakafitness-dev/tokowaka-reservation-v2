// 空き枠。GASが作った枠をKVから返すだけ。
//
//   枠の中身（出勤シフト − 予約 = 空きブロックを端から60分刻み）はGASの吸着方式のまま。
//   ここでは「作る」ことはせず、押し出されたものを配るだけにする＝エッジで20〜40ms。
//
//   ★これは「表示用の写し」であって、二重予約の判定には使わない。
//     確定の判定は第2段階でD1の予約表に対して行う。現在のGAS（キャッシュ表示＋
//     カレンダーのリアルタイム照合）と同じ分担で、照合先が速くなるだけ。
//   ★当初KVに置く設計だったが、KVの書き込みは1日1,000回まで。
//     4名を5分ごとに更新すると1,152回で超えるため、D1に置いた（1日10万回まで無料）。

function jstParts(ms) {
  const d = new Date(ms + 9 * 3600 * 1000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
}

// 午前枠は前日22時で締め切る（2026-09-24 オーナー決定）。表示からも落とす。
function isOpen(startMs, now, cfg) {
  const lead = (cfg.leadMinutes || 180) * 60 * 1000;
  let deadline = startMs - lead;
  const p = jstParts(startMs);
  if (p.h < (cfg.morningUntilHour || 12)) {
    // 前日の22時
    const prev = new Date(Date.UTC(p.y, p.mo, p.d, cfg.prevDeadlineHour || 22, 0) - 9 * 3600 * 1000);
    prev.setUTCDate(prev.getUTCDate() - 1);
    deadline = Math.min(deadline, prev.getTime());
  }
  return now < deadline;
}

import { readHome } from './boot.js';

export async function routeSlots({ body, env, who }) {
  const trainerId = String(body.trainerId || who.trainerId || '');
  if (!trainerId) return { code: 'BAD_REQUEST', slots: [] };

  const row = await env.DB.prepare(
    'SELECT payload, computed_at FROM slots_cache WHERE trainer_id = ?'
  ).bind(trainerId).first();
  if (!row) return { slots: [], stale: true, computedAt: null };
  let raw;
  try { raw = JSON.parse(row.payload); } catch (_) { return { slots: [], stale: true, computedAt: null }; }
  raw.computedAt = row.computed_at;

  const now = Date.now();
  const cfg = raw.rules || { leadMinutes: 180, morningUntilHour: 12, prevDeadlineHour: 22 };
  const excludeStart = Number(body.excludeStartMs || 0);   // 予約変更のとき、自分の枠は残す

  const slots = (raw.slots || []).filter((s) => {
    if (s.startMs === excludeStart) return true;
    if (s.startMs <= now) return false;
    return isOpen(s.startMs, now, cfg);
  });

  return {
    trainerId,
    slots,
    computedAt: raw.computedAt || null,
    ageMs: raw.computedAt ? now - raw.computedAt : null,
  };
}

/**
 * 「この日時に予約するとき、何から消化されるか」を返す。
 *   GASでは getBookingOptions として別に5.1秒かけていた通信。
 *   残数は予約する日の月で決まるため、その月の写しから組み立てる。
 *   持っていない月なら null を返し、画面はGASに聞き直す（間違った選択肢を出さない）。
 */
export async function routeBookingOptions({ body, env, who }) {
  const customerId = String(body.customerId || who.customerId || '');
  if (!customerId) return { code: 'BAD_REQUEST', options: null };

  const startMs = Number(body.startMs || 0);
  if (!startMs) return { code: 'BAD_REQUEST', options: null };

  const home = await readHome(env, customerId, startMs);
  if (!home) return { options: null, fallback: true };   // その月を持っていない＝GASに聞いて

  const monthlyLeft = home.monthlyRemaining != null ? home.monthlyRemaining : 0;
  const pairLeft = home.pairRemaining || 0;
  const normalTicketLeft = home.normalTicketRemaining || 0;

  return {
    options: {
      month: home.month,
      hasNormalRoute: !!home.hasNormalRoute,
      monthlyRemaining: monthlyLeft,
      ticketRemaining: home.ticketRemaining != null ? home.ticketRemaining : 0,
      pairRemaining: pairLeft,
      pairPackMax: home.pairPackMax || 0,
      normalTicketRemaining: normalTicketLeft,
      isPair: pairLeft > 0,
      carryover: home.carryover || 0,
      quota: home.quota || 0,
      transferCredits: home.transferCredits || null,
    },
    stale: home.stale,
    computedAt: home.computedAt,
  };
}
