// 空き枠。GASが作った枠をKVから返すだけ。
//
//   枠の中身（出勤シフト − 予約 = 空きブロックを端から60分刻み）はGASの吸着方式のまま。
//   ここでは「作る」ことはせず、押し出されたものを配るだけにする＝エッジで20〜40ms。
//
//   ★表示はKV、確定はD1（第2段階）。KVは書いてから各拠点に行き渡るまで数秒かかるため、
//     二重予約の判定に使ってはいけない。この分担は現在のGAS（キャッシュ表示＋
//     カレンダーのリアルタイム照合）と同じ考え方で、照合先が速くなるだけ。

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

export async function routeSlots({ body, env, who }) {
  const trainerId = String(body.trainerId || who.trainerId || '');
  if (!trainerId) return { code: 'BAD_REQUEST', slots: [] };

  const raw = await env.KV.get('slots:' + trainerId, 'json');
  if (!raw) return { slots: [], stale: true, computedAt: null };

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
    // 予約画面が続けて必要とするもの（GASでは getBookingOptions として別通信だった）
    options: raw.optionsByCustomer && who.customerId ? (raw.optionsByCustomer[who.customerId] || null) : null,
  };
}
