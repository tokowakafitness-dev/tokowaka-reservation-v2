// 設計54 S1a：write-shadow の窓口（合言葉 X-Ingest-Secret・I15）
//   POST /writeshadow         … GAS が booking_metrics の6列目から拾った材料を送る。1件ずつ判定して記録し、記録した・記録済みの n を返す
//   GET  /writeshadow/status  … 日次点検・作業依頼が読む。件数・分布・固定の語だけ（ID・時刻の生の値は返さない）
//
//   ★スイッチ WRITE_SHADOW（wrangler.toml の [vars]）が厳密に "on" のときだけ判定して記録する。
//     それ以外は記録せずに n を全部「受け取った」と返す（GAS の待ちを溜めない・顧客IDは送る側で消える）。
//   ★顧客ID・予約ID・予定IDは判定に使うだけで記録しない（I84）。
import { safeEqual } from '../lib/safe-equal.js';
import { normalizeItem, judgeItem, jstDay, jstHour, arrivalDanger } from '../lib/write-shadow.js';

const MAX_ITEMS = 50;
const BUDGET_MS = 10000;           // 50件で10秒を超えたら残りを受け取らずに返す（GAS は返った n だけ印を付ける）
const KEEP_LOG_DAYS = 14, KEEP_OTHER_DAYS = 30, PURGE_MAX = 50;
const STAT_KEYS = ['lock_miss', 'write_conflict', 'write_skip', 'stale', 'record_fail', 'cursor_reset', 'scan_more', 'too_long', 'unparsed'];

function jsonRes(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
export function writeShadowOn(env) { return String((env && env.WRITE_SHADOW) || '') === 'on'; }

export async function handleWriteShadow(request, env) {
  if (!env || !env.SHARED_SECRET || !safeEqual(request.headers.get('X-Ingest-Secret'), env.SHARED_SECRET)) {
    return jsonRes({ success: false, code: 'UNAUTHORIZED' }, 401);
  }
  const url = new URL(request.url);
  if (url.pathname === '/writeshadow/status') {
    if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
    return jsonRes(await writeShadowStatus(env, Date.now()));
  }
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  let body;
  try { body = await request.json(); } catch (_) { return jsonRes({ success: false, code: 'BAD_JSON' }, 400); }
  const items = Array.isArray(body && body.items) ? body.items.slice(0, MAX_ITEMS) : [];
  const drain = (body && (body.drain === 'AFTER' || body.drain === 'TICK' || body.drain === 'JOB')) ? body.drain : null;
  const build = typeof (body && body.build) === 'string' ? body.build.slice(0, 40) : null;
  const now = Date.now();

  //   送る側の数（ロックが取れなかった・競合・期限で消した ほか）。日×種類に足す
  const stat = (body && body.stat && typeof body.stat === 'object') ? body.stat : {};
  const statStmts = [];
  for (const k of STAT_KEYS) {
    const v = Number(stat[k]);
    if (Number.isSafeInteger(v) && v > 0 && v < 100000) {
      statStmts.push(env.DB.prepare(
        'INSERT INTO write_shadow_stat (day, key, n) VALUES (?, ?, ?) ON CONFLICT(day, key) DO UPDATE SET n = n + excluded.n'
      ).bind(jstDay(now), k, v));
    }
  }
  if (statStmts.length && writeShadowOn(env)) { try { await env.DB.batch(statStmts); } catch (_) {} }

  if (!writeShadowOn(env)) {
    return jsonRes({ success: true, mode: 'off', acked: items.map((x) => (x && typeof x.n === 'string') ? x.n : null).filter(Boolean) });
  }

  const acked = [], rejected = [];
  const b1 = String(env.CAL_B1_CALENDAR_ID || '');
  const trCache = {};
  let recordFail = 0;
  for (const raw of items) {
    if (Date.now() - now > BUDGET_MS) break;
    const it = normalizeItem(raw);
    if (!it) { rejected.push(String((raw && raw.n) || '').slice(0, 16)); continue; }
    //   既に記録済みなら判定しない（n で冪等）
    const seen = await env.DB.prepare('SELECT 1 AS x FROM write_shadow_log WHERE n = ?').bind(it.n).first();
    if (seen) { acked.push(it.n); continue; }
    if (it.tid && !(it.tid in trCache)) {
      try {
        const tr = await env.DB.prepare('SELECT calendar_id FROM trainers WHERE trainer_id = ?').bind(it.tid).first();
        trCache[it.tid] = tr && tr.calendar_id ? { calendarId: String(tr.calendar_id) } : null;
      } catch (_) { trCache[it.tid] = null; }
    }
    let j;
    try { j = await judgeItem(env, it, { now, trainer: trCache[it.tid] || null, b1CalendarId: b1 }); }
    catch (_) { j = { verdict: 'u_bad', side: null, reason: 'throw', d1Ms: null, allocMs: null, calAgeMs: null, totalMs: null }; }
    const t = it.t || now;
    try {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO write_shadow_log
           (n, day, hour, op, gas_ok, gas_at, verdict, side, reason, tid, s, e, t, lag_ms, cal_age_ms, d1_ms, alloc_ms, total_ms, drain, build, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(it.n, jstDay(t), jstHour(t), it.op, it.ok ? 1 : 0, it.at || 'none', j.verdict, j.side, j.reason,
             it.tid || null, it.s, it.e, it.t, it.t ? Math.max(0, now - it.t) : null,
             j.calAgeMs, j.d1Ms, j.allocMs, j.totalMs, drain, build, now).run();
      acked.push(it.n);
    } catch (_) { recordFail++; }
  }
  if (recordFail) {
    try {
      await env.DB.prepare('INSERT INTO write_shadow_stat (day, key, n) VALUES (?, ?, ?) ON CONFLICT(day, key) DO UPDATE SET n = n + excluded.n')
        .bind(jstDay(now), 'record_fail', recordFail).run();
    } catch (_) {}
  }
  return jsonRes({ success: true, mode: 'on', acked, rejected: rejected.length });
}

function pct(arr, p) {
  if (!arr.length) return null;
  const a = arr.slice().sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(p * (a.length - 1) + 0.5))];
}

/** 件数・分布・固定の語だけ。前日と当日。ID・時刻の生の値は返さない */
export async function writeShadowStatus(env, now) {
  const today = jstDay(now), yday = jstDay(now - 86400000);
  //   古い行を消す（1回50行まで）
  try {
    await env.DB.prepare(`DELETE FROM write_shadow_log WHERE n IN (SELECT n FROM write_shadow_log WHERE created_at < ? LIMIT ${PURGE_MAX})`)
      .bind(now - KEEP_LOG_DAYS * 86400000).run();
    for (const tb of ['calendar_arrival_log', 'fresh_delay_log']) {
      await env.DB.prepare(`DELETE FROM ${tb} WHERE id IN (SELECT id FROM ${tb} WHERE created_at < ? LIMIT ${PURGE_MAX})`)
        .bind(now - KEEP_OTHER_DAYS * 86400000).run();
    }
  } catch (_) {}
  const out = { on: writeShadowOn(env), days: {} };
  for (const day of [yday, today]) {
    const rows = await env.DB.prepare(
      'SELECT op, hour, verdict, side, total_ms, alloc_ms, d1_ms, lag_ms, drain FROM write_shadow_log WHERE day = ?'
    ).bind(day).all();
    const list = (rows && rows.results) || [];
    const byVerdict = {}, byOpVerdict = {}, byOpHour = {}, side = { gas_ok_worker_ng: 0, gas_ng_worker_ok: 0 };
    const total = [], alloc = [], d1 = [], lagAfter = [];
    for (const r of list) {
      byVerdict[r.verdict] = (byVerdict[r.verdict] || 0) + 1;
      const k = r.op + ':' + r.verdict; byOpVerdict[k] = (byOpVerdict[k] || 0) + 1;
      const h = r.op + '@' + r.hour; byOpHour[h] = (byOpHour[h] || 0) + 1;
      if (r.side && side[r.side] != null) side[r.side]++;
      if (typeof r.total_ms === 'number') total.push(r.total_ms);
      if (typeof r.alloc_ms === 'number') alloc.push(r.alloc_ms);
      if (typeof r.d1_ms === 'number') d1.push(r.d1_ms);
      if (r.drain === 'AFTER' && typeof r.lag_ms === 'number') lagAfter.push(r.lag_ms);
    }
    const st = await env.DB.prepare('SELECT key, n FROM write_shadow_stat WHERE day = ?').bind(day).all();
    const stat = {};
    for (const r of ((st && st.results) || [])) stat[r.key] = Number(r.n || 0);
    out.days[day] = {
      n: list.length, byVerdict, byOpVerdict, byOpHour, side, stat,
      totalMs: { p50: pct(total, 0.5), p95: pct(total, 0.95), max: total.length ? Math.max(...total) : null },
      allocMs: { p50: pct(alloc, 0.5), p95: pct(alloc, 0.95) },
      d1Ms: { p50: pct(d1, 0.5), p95: pct(d1, 0.95) },
      lagAfterMs: { p50: pct(lagAfter, 0.5), p95: pct(lagAfter, 0.95), max: lagAfter.length ? Math.max(...lagAfter) : null },
    };
  }
  //   M3：契約の入力が D1 に届くまで（前日）
  try {
    const fd = await env.DB.prepare('SELECT cause, delay_ms FROM fresh_delay_log WHERE day = ?').bind(yday).all();
    const ds = ((fd && fd.results) || []).map((r) => Number(r.delay_ms)).filter((x) => x >= 0);
    out.freshDelay = { n: ds.length, p50: pct(ds, 0.5), p95: pct(ds, 0.95), max: ds.length ? Math.max(...ds) : null };
  } catch (_) { out.freshDelay = null; }
  //   M2：直接入れた予定が届くまで（前日）
  try {
    const ca = await env.DB.prepare('SELECT kind, cls, delay_ms, window_hits FROM calendar_arrival_log WHERE day = ?').bind(yday).all();
    const l = (ca && ca.results) || [];
    const ds = l.map((r) => Number(r.delay_ms)).filter((x) => x >= 0);
    out.arrival = { n: l.length, p95: pct(ds, 0.95), max: ds.length ? Math.max(...ds) : null,
                    hits: l.reduce((a, r) => a + Number(r.window_hits || 0), 0),
                    dangerHits: l.reduce((a, r) => a + (arrivalDanger(r.kind, r.cls) ? Number(r.window_hits || 0) : 0), 0) };
  } catch (_) { out.arrival = null; }
  return out;
}
