// 保全部隊が予約システムの要約を読む口（会社の設計 maintenance-squad-read-endpoint.md・決定0208・2026-11-27）
//
//   POST /squad/digest      GAS → 要約（1日2回）・心拍（1時間に1回）。合言葉 X-Ingest-Secret
//   GET  /squad/status      部隊（Mac の台本）が読む。読むだけの鍵 X-Squad-Read-Key（Worker には SHA-256 だけ）
//   POST /squad/report      部隊の報告（④・列挙と件数だけ）。同じ部隊の鍵・★SQUAD_REPORT="on" のときだけ
//   POST /squad/report/ack  GAS が報告を LINE／メールで届けた結果。合言葉
//
//   ★倒れる向き：古い・未完走・心拍切れは中身を出さない（state=stale）。判定できなければ答えない
//   ★off・鍵の欄が空・形の違う鍵・違う鍵では D1 に1回も触れない（I-SQ4）
//   ★部隊の鍵では予約・残数・顧客の表に書けない。書けるのは squad_reads の加算と squad_report だけ（I-SQ2・報告は列挙だけ）
//   ★CORS は返さない（ブラウザから呼ばせない）

import { safeEqual } from '../lib/safe-equal.js';
import {
  SQ_SCHEMA, SQ_MAX_BYTES, sqRebuildDigest, sqRebuildBeat, sqRebuildReport, sqParseStrict, sqStringify, SQ_ENUM, isMs,
} from '../lib/squad-schema.js';

export const SQ = {
  READ_MAX: 200,                // 鍵が合った読み取りの1日の上限
  REPORT_MAX: 6,                // 報告の1日の上限（部隊の起動は1日5回まで・決定0200）
  BEAT_OLD_MS: 2 * 3600000,     // 心拍がこれより古い＝GAS が止まっている
  DIGEST_OLD_MS: 26 * 3600000,  // 要約がこれより古い（LB_HEAL.FRESH_MS と同じ線）
  QUIET_MS: 26 * 3600000,       // 部隊がこれより長く読んでいない＝squad_quiet
  FUTURE_MS: 5 * 60000,         // snap_at の未来の許容
  PAST_MS: 2 * 3600000,         // snap_at の過去の許容
  REPORT_HAND_MS: 24 * 3600000, // これより古い報告は渡さない
  REHAND_MS: 2 * 3600000,       // 渡したのに ack が無いまま、これだけたったら渡し直す
  HAND_MAX: 3,                  // 渡す回数の上限
};

const json = (b, s = 200) => new Response(JSON.stringify(b), {
  status: s, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});
const isOff = (env) => String((env && env.SQUAD_READ) || '') === 'off';
const reportOn = (env) => String((env && env.SQUAD_REPORT) || '') === 'on';
export const jstDay = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
function keyHashes(env) {
  return [env && env.SQUAD_READ_KEY_SHA256, env && env.SQUAD_READ_KEY_SHA256_NEXT]
    .map((x) => String(x || '').trim().toLowerCase()).filter((h) => /^[0-9a-f]{64}$/.test(h));
}
async function sha256hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

//   部隊の鍵の照合。★この関数の中で env.DB に触れない（I-SQ4）。null＝通ってよい
//   順序：off → 欄が空 → 形 → 2つの欄と定数時間で照合（関門① 中2）
export async function squadKeyDeny(request, env) {
  if (isOff(env)) return json({ ok: false, code: 'SQUAD_OFF' }, 503);
  const hs = keyHashes(env);
  if (!hs.length) return json({ ok: false, code: 'SQUAD_CLOSED' }, 503);
  const k = request.headers.get('X-Squad-Read-Key') || '';
  if (!/^[0-9a-f]{48}$/.test(k)) return json({ ok: false, code: 'FORBIDDEN' }, 403);
  const got = await sha256hex(k);
  let hit = false;
  for (const h of hs) hit = safeEqual(got, h) || hit;   // ★両方とも比べる（どちらで当たったかで時間を変えない）
  return hit ? null : json({ ok: false, code: 'FORBIDDEN' }, 403);
}
//   GAS の合言葉（書く側・ack）。★部隊の鍵とは別のヘッダ。D1 に触れない
function secretDeny(request, env) {
  if (isOff(env)) return json({ ok: false, code: 'SQUAD_OFF' }, 503);
  if (!env || !env.SHARED_SECRET) return json({ ok: false, code: 'SECRET_NOT_SET' }, 503);
  if (!safeEqual(request.headers.get('X-Ingest-Secret') || '', env.SHARED_SECRET)) return json({ ok: false, code: 'FORBIDDEN' }, 403);
  return null;
}

//   本文を上限つきで読む（§3-3-2）。★圧縮は読む前に 415・Content-Length の超過は読まずに 413・
//     ストリームで byteLength を足し 65,537 に達したら reader.cancel() して 413（arrayBuffer() で全部を読まない）
export async function readLimited(request, max = SQ_MAX_BYTES) {
  const ce = String(request.headers.get('Content-Encoding') || '').trim().toLowerCase();
  if (ce && ce !== 'identity') return { status: 415 };
  const cl = request.headers.get('Content-Length');
  if (cl !== null && cl !== '' && Number(cl) > max) return { status: 413 };
  if (!request.body) return { text: '' };
  const reader = request.body.getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { try { await reader.cancel(); } catch (_) {} return { status: 413 }; }
    parts.push(value);
  }
  const buf = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.byteLength; }
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf) }; } catch (_) { return { status: 400 }; }
}

async function countRejected(env, kind) {
  try { await env.DB.prepare('UPDATE squad_digest SET rejected = MIN(rejected + 1, 1000000) WHERE kind = ?').bind(kind).run(); } catch (_) {}
}

// ---------- POST /squad/digest（GAS）----------
const UPSERT = `INSERT INTO squad_digest(kind, received_at, snap_at, check_id, gas_build, body, rejected)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)
ON CONFLICT(kind) DO UPDATE SET
  received_at = CASE WHEN squad_digest.snap_at <= squad_digest.received_at + 300000
                       AND excluded.snap_at = squad_digest.snap_at
                       AND excluded.body = squad_digest.body
                     THEN squad_digest.received_at
                     ELSE excluded.received_at END,
  snap_at = excluded.snap_at, check_id = excluded.check_id,
  gas_build = excluded.gas_build, body = excluded.body
WHERE squad_digest.snap_at > squad_digest.received_at + 300000
   OR ((excluded.snap_at > squad_digest.snap_at
        OR (excluded.snap_at = squad_digest.snap_at AND excluded.body = squad_digest.body))
       AND (excluded.check_id IS NULL OR squad_digest.check_id IS NULL OR excluded.check_id >= squad_digest.check_id))
RETURNING kind`;

export async function handleSquadDigest(request, env) {
  const deny = secretDeny(request, env);
  if (deny) return deny;
  const rd = await readLimited(request);
  if (rd.status) return json({ ok: false, code: rd.status === 415 ? 'ENCODING' : (rd.status === 413 ? 'TOO_LARGE' : 'BAD_BODY') }, rd.status);
  const p = sqParseStrict(rd.text);
  const kind = (p.ok && p.value && (p.value.kind === 'digest' || p.value.kind === 'beat')) ? p.value.kind : null;
  if (!kind) { await countRejected(env, 'digest'); return json({ ok: false, code: 'BAD_JSON' }, 400); }
  const r = kind === 'digest' ? sqRebuildDigest(p.value) : sqRebuildBeat(p.value);
  if (!r.ok) { await countRejected(env, kind); return json({ ok: false, code: 'BAD_SHAPE', field: r.why }, 400); }
  const now = Date.now();
  const snap = r.body.snap_at;
  //   ★自己申告の未来値・古すぎる値は D1 の UPSERT より前に拒否（前の行を残す・I-SQ3）
  if (snap > now + SQ.FUTURE_MS || snap < now - SQ.PAST_MS) { await countRejected(env, kind); return json({ ok: false, code: 'SNAP_RANGE' }, 409); }
  const body = sqStringify(r.body);
  let row = null;
  try {
    row = await env.DB.prepare(UPSERT).bind(kind, now, snap, kind === 'digest' ? r.body.check_id : null, r.body.gas_build, body).first();
  } catch (_) { return json({ ok: false, code: 'DB_UNAVAILABLE' }, 503); }
  //   ★行が返らない＝古い・同値で本文違い・check_id の後退。後追いの SELECT で理由を推測しない（関門①4回目）
  if (!row) { await countRejected(env, kind); return json({ ok: false, code: 'REJECTED' }, 409); }
  const out = { ok: true, kind };
  //   ④ 心拍の応答で、まだ渡していない部隊の報告を1回だけ渡す（SQUAD_REPORT=on のときだけ）
  if (kind === 'beat' && reportOn(env)) {
    try {
      //   ★ack が無いまま REHAND_MS たった報告は渡し直す（最大 HAND_MAX 回）。応答が GAS に届かなかった・配達の前に落ちた回を
      //     失わないため（関門② 中1）。二重に届くのは GAS 側が報告の番号で止める（CacheService・_lbSquadDeliver）
      const rp = await env.DB.prepare(
        `UPDATE squad_report SET handed_at = ?1, hand_n = hand_n + 1
          WHERE id = 1 AND ack_at IS NULL AND received_at > ?2
            AND (handed_at IS NULL OR (handed_at < ?3 AND hand_n < ${SQ.HAND_MAX}))
          RETURNING run_id, body`
      ).bind(now, now - SQ.REPORT_HAND_MS, now - SQ.REHAND_MS).first();
      if (rp) {
        const pr = sqParseStrict(String(rp.body || ''));
        const rr = pr.ok ? sqRebuildReport(pr.value) : { ok: false };
        if (rr.ok) out.report = rr.body;
      }
    } catch (_) { /* 報告を渡せなくても心拍は受けた */ }
  }
  return json(out);
}

// ---------- GET /squad/status（部隊）----------
function rowBody(row, kind) {
  if (!row) return null;
  const p = sqParseStrict(String(row.body || ''));
  if (!p.ok) return { bad: true };
  const r = kind === 'digest' ? sqRebuildDigest(p.value) : sqRebuildBeat(p.value);
  return r.ok ? { body: r.body } : { bad: true };
}
const nz = (v) => (typeof v === 'number' ? v : 0);
//   未完走（§3-5）：snap_at の新しい側の印で判定する（同時刻は要約の勝ち）
export function sqNotCompleted(dg, bt) {
  if (bt.snap_at > dg.snap_at) {
    return nz(bt.health_last) > nz(bt.health_done) || bt.health_done !== dg.check_id || nz(bt.heal_last) > nz(bt.heal_done);
  }
  return dg.completed !== true || dg.gate !== 'ok' || dg.health_done !== dg.check_id
    || nz(dg.health_last) > nz(dg.health_done) || nz(dg.heal_last) > nz(dg.heal_done);
}

export async function handleSquadStatus(request, env, workerBuild = '') {
  const deny = await squadKeyDeny(request, env);
  if (deny) return deny;
  const now = Date.now();
  let cnt = null;
  try {
    //   ★読み→比べ→書きに分けない。日替わり行の作成と「上限未満なら加算」を1つの文で（関門① 中3）
    cnt = await env.DB.prepare(
      `INSERT INTO squad_reads(day, n, last_read_at) VALUES(?, 1, ?)
       ON CONFLICT(day) DO UPDATE SET n = n + 1, last_read_at = excluded.last_read_at
       WHERE squad_reads.n < ${SQ.READ_MAX} RETURNING n`
    ).bind(jstDay(now), now).first();
  } catch (_) { return json({ ok: false, code: 'DB_UNAVAILABLE' }, 503); }
  if (!cnt) return json({ ok: false, code: 'TOO_MANY' }, 429);   // ★null は許可にしない
  let rows, rep;
  try {
    rows = (await env.DB.prepare('SELECT kind, received_at, snap_at, check_id, gas_build, body, rejected FROM squad_digest').all()).results || [];
    rep = await env.DB.prepare('SELECT run_id, handed_at, ack_at, ack_code FROM squad_report WHERE id = 1').first();
  } catch (_) { return json({ ok: false, code: 'DB_UNAVAILABLE' }, 503); }
  const dRow = rows.find((x) => x.kind === 'digest') || null;
  const bRow = rows.find((x) => x.kind === 'beat') || null;
  const dg = rowBody(dRow, 'digest'), bt = rowBody(bRow, 'beat');
  let state = 'fresh', reason = null;
  if (!dRow && !bRow) { state = 'none'; reason = 'never_received'; }
  else if ((dg && dg.bad) || (bt && bt.bad)) { state = 'stale'; reason = 'schema_mismatch'; }
  else if (!bRow || now - Number(bRow.received_at) > SQ.BEAT_OLD_MS) { state = 'stale'; reason = 'beat_old'; }
  else if (!dRow) { state = 'stale'; reason = 'never_received'; }
  else if (now - Number(dRow.received_at) > SQ.DIGEST_OLD_MS) { state = 'stale'; reason = 'digest_old'; }
  else if (sqNotCompleted(dg.body, bt.body)) { state = 'stale'; reason = 'not_completed'; }
  const okMs = (v) => (isMs(Number(v)) ? Number(v) : null);
  const age = (v) => (okMs(v) === null ? null : Math.max(0, Math.min(1e6, Math.floor((now - Number(v)) / 60000))));
  const newer = (dRow && bRow) ? (Number(bRow.snap_at) > Number(dRow.snap_at) ? bRow : dRow) : (dRow || bRow);
  const dBody = dg && dg.body ? dg.body : null;
  let report_state = 'none';
  if (rep) report_state = rep.handed_at == null ? 'pending' : (rep.ack_at == null ? 'handed' : (rep.ack_code === 'failed' ? 'failed' : 'delivered'));
  const out = {
    ok: true, schema: SQ_SCHEMA, worker_build: String(workerBuild).slice(0, 11), now,
    state, stale_reason: reason,
    digest_received_at: dRow ? okMs(dRow.received_at) : null, digest_age_min: dRow ? age(dRow.received_at) : null,
    beat_received_at: bRow ? okMs(bRow.received_at) : null, beat_age_min: bRow ? age(bRow.received_at) : null,
    gas_build: newer && typeof newer.gas_build === 'string' && /^\d{4}-\d{2}-\d{2}[a-z]?$/.test(newer.gas_build) ? newer.gas_build : null,
    check_id: dBody ? dBody.check_id : null,
    gate: dBody ? (SQ_ENUM.gate.indexOf(dBody.gate) >= 0 ? dBody.gate : null) : null,
    reads_today: Number(cnt.n),
    digest_rejected: Math.min(1e6, nz(dRow && Number(dRow.rejected)) + nz(bRow && Number(bRow.rejected))),
    report_state, report_id: rep ? okMs(rep.run_id) : null,
  };
  if (state === 'fresh') out.digest = dBody;   // ★fresh のときだけ中身を載せる（I-SQ3）
  const text = sqStringify(out);
  if (new TextEncoder().encode(text).length > SQ_MAX_BYTES) {
    console.error('squad_status', 'digest_too_large');
    return json({ ok: false, code: 'TOO_LARGE' }, 500);   // ★切り詰めない
  }
  return new Response(text, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

// ---------- POST /squad/report（部隊・④）----------
export async function handleSquadReport(request, env) {
  if (isOff(env)) return json({ ok: false, code: 'SQUAD_OFF' }, 503);
  if (!reportOn(env)) return json({ ok: false, code: 'REPORT_OFF' }, 503);   // ★D1 より前に止める
  const deny = await squadKeyDeny(request, env);
  if (deny) return deny;
  const rd = await readLimited(request, 4096);
  if (rd.status) return json({ ok: false, code: 'BAD_BODY' }, rd.status);
  const p = sqParseStrict(rd.text, 4096);
  const r = p.ok ? sqRebuildReport(p.value) : { ok: false, why: p.why };
  if (!r.ok) return json({ ok: false, code: 'BAD_SHAPE', field: r.why }, 400);
  const now = Date.now();
  if (r.body.run_id > now + SQ.FUTURE_MS || r.body.run_id < now - SQ.PAST_MS) return json({ ok: false, code: 'RUN_RANGE' }, 409);
  let row = null;
  try {
    row = await env.DB.prepare(
      `INSERT INTO squad_report(id, run_id, body, received_at, handed_at, ack_at, ack_code, day, n_today)
       VALUES (1, ?1, ?2, ?3, NULL, NULL, NULL, ?4, 1)
       ON CONFLICT(id) DO UPDATE SET run_id = excluded.run_id, body = excluded.body, received_at = excluded.received_at,
         handed_at = NULL, hand_n = 0, ack_at = NULL, ack_code = NULL,
         n_today = CASE WHEN squad_report.day = excluded.day THEN squad_report.n_today + 1 ELSE 1 END, day = excluded.day
       WHERE (squad_report.day <> excluded.day OR squad_report.n_today < ${SQ.REPORT_MAX}) AND excluded.run_id > squad_report.run_id
       RETURNING n_today`
    ).bind(r.body.run_id, sqStringify(r.body), now, jstDay(now)).first();
  } catch (_) { return json({ ok: false, code: 'DB_UNAVAILABLE' }, 503); }
  if (!row) return json({ ok: false, code: 'REPORT_REJECTED' }, 429);   // 1日の上限・古い番号
  return json({ ok: true, id: r.body.run_id, n_today: Number(row.n_today) });
}

// ---------- POST /squad/report/ack（GAS）----------
export async function handleSquadReportAck(request, env) {
  const deny = secretDeny(request, env);
  if (deny) return deny;
  const rd = await readLimited(request, 1024);
  if (rd.status) return json({ ok: false, code: 'BAD_BODY' }, rd.status);
  const p = sqParseStrict(rd.text, 1024);
  const v = p.ok ? p.value : null;
  if (!v || typeof v !== 'object' || !isMs(v.id) || SQ_ENUM.ack.indexOf(v.code) < 0) return json({ ok: false, code: 'BAD_SHAPE' }, 400);
  let row = null;
  try {
    row = await env.DB.prepare(
      'UPDATE squad_report SET ack_at = ?1, ack_code = ?2 WHERE id = 1 AND run_id = ?3 AND handed_at IS NOT NULL AND ack_at IS NULL RETURNING run_id'
    ).bind(Date.now(), v.code, v.id).first();
    if (!row) {
      //   ★同じ番号で既に ack 済み（渡し直しの後に GAS が覚えた結果で送り直した）は成功。それ以外（古い番号・まだ渡していない）は 409
      const cur = await env.DB.prepare('SELECT run_id, ack_at FROM squad_report WHERE id = 1').first();
      if (cur && Number(cur.run_id) === v.id && cur.ack_at != null) return json({ ok: true, already: true });
    }
  } catch (_) { return json({ ok: false, code: 'DB_UNAVAILABLE' }, 503); }
  return row ? json({ ok: true }) : json({ ok: false, code: 'NOT_HANDED' }, 409);
}

// ---------- /quota/status?squad=1（GAS の日次点検・squad_quiet）----------
//   合言葉は呼ぶ側（quotaStatus）で確かめ済み。★off なら D1 に触れずに read_on=false
export async function squadQuietStatus(env, now = Date.now()) {
  const readOn = !isOff(env) && keyHashes(env).length > 0;
  if (!readOn) return { ok: true, squad: { read_on: false, last_read_at: null, quiet: false } };
  const r = await env.DB.prepare('SELECT MAX(last_read_at) AS t FROM squad_reads').first();
  const t = r && isMs(Number(r.t)) ? Number(r.t) : null;
  //   ★一度も読まれていない（設置前）は quiet にしない＝設置の確認は CEO の段取り（maintenance-squad.md）
  return { ok: true, squad: { read_on: true, last_read_at: t, quiet: t !== null && now - t > SQ.QUIET_MS } };
}
