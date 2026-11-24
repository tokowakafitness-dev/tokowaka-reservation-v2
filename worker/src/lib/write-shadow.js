// 設計54 S1a：予約の確定を Worker でも D1 で判定して、GAS の答えと比べる（計測だけ・顧客の答えは変えない）
//
//   ★判定は既存の単一ソースを呼ぶだけ（I85）。ここに書き写さない：
//     鮮度          … lib/fresh.js（I31）＋ lib/remain-read-on.js の readCalcInputStatus（I53）
//     カレンダー    … lib/calread.js の readCalendar（鮮度の境界 FRESH_MS＝7分もそのまま）
//     分類          … calread が返す role / effect（lib/calclass.js の値）
//     残数          … allocate.js の _lbBookability（GAS と同じファイル）。入力は calc.js の loadCalcInput
//   ★判定できない（u_*）・範囲外（x_*）・D1 が新しくない（w_stale）は一致にも食い違いにも数えない（calcompare の規則4）。
//   ★顧客ID・予約ID・予定IDは判定に使うだけで返り値に入れない（I84）。
import { readCalendar, FRESH_MS } from './calread.js';
import { CAL_ROLE, EV_KIND } from './calclass.js';
import { isFresh, readSyncVersion } from './sync-version.js';
import { readCalcInputStatus } from './remain-read-on.js';
import { loadCalcInput } from '../calc.js';
import { _lbBookability } from '../allocate.js';
import { ruleVersionOf, flag1fOf } from '../routes/slots.js';

export const WS_OPS = ['reserve', 'proxy', 'batch', 'transfer', 'change', 'autobook', 'recurring', 'other'];
//   GAS の「どこで決まったか」の語（gas/LineBooking.js _lbReserveCoreImpl の _LB_WS.at と同じ集合・検査で突き合わせる）
export const WS_GAS_AT = ['gate', 'bad', 'deadline', 'horizon', 'busy', 'att', 'remain', 'cap', 'b1', 'trainer', 'f1', 'consec', 'write', 'ok'];
const SCOPE_AT = { gate: 1, bad: 1, deadline: 1, horizon: 1, att: 1, cap: 1, write: 1 };   // S1a では判定しない段（S1b で移植）
const CARRY_RATE = 1 / 3;   // GAS の LINE_BOOKING.CARRYOVER_RATE と同じ（write-shadow.test.js がソースで突き合わせる）
export const WS_MAX_ID = 120;

const ID_RE = /^C\d{6,20}$/;
const isMs = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const str = (v, max) => (typeof v === 'string' && v.length > 0 && v.length <= (max || WS_MAX_ID)) ? v : '';

function monthKeyJst(ms) {
  const d = new Date(ms + 9 * 3600000);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}
export function jstDay(ms) { return new Date(ms + 9 * 3600000).toISOString().slice(0, 10); }
export function jstHour(ms) { return new Date(ms + 9 * 3600000).getUTCHours(); }

// GAS が積んだ1件を、判定に使える形に直す（壊れていれば null）
export function normalizeItem(x) {
  if (!x || typeof x !== 'object') return null;
  const n = str(x.n, 16);
  if (!/^[0-9a-f]{6,16}$/.test(n)) return null;
  const op = WS_OPS.indexOf(x.op) >= 0 ? x.op : 'other';
  const at = WS_GAS_AT.indexOf(x.at) >= 0 ? x.at : '';
  return {
    n, op, at,
    ok: x.ok === 1 || x.ok === true,
    code: str(x.code, 40),
    cid: (typeof x.cid === 'string' && ID_RE.test(x.cid)) ? x.cid : '',
    rid: str(x.rid), xr: str(x.xr), eb: str(x.eb), et: str(x.et),
    tid: str(x.tid, 40),
    s: isMs(x.s) ? x.s : null, e: isMs(x.e) ? x.e : null, ex: isMs(x.ex) ? x.ex : null,
    att: (x.att === 2) ? 2 : 1,
    pk: (x.pk === 'pair' || x.pk === 'normal') ? x.pk : '',
    cm: typeof x.cm === 'string' ? x.cm.slice(0, 8) : '',
    t: isMs(x.t) ? x.t : null,
    stale: x.stale === 1,
    tooLong: x.too_long === 1,
  };
}

// 予定ID（calendar_events の event_id は「予定ID#開始ms」）の # より前
const evBase = (id) => String(id || '').split('#')[0];

/**
 * 1件を判定する。返り値は記録の行（顧客ID・予約ID・予定IDは入れない）。
 *   opts: { now, trainer:{calendarId}, b1CalendarId }
 */
export async function judgeItem(env, it, opts) {
  const o = opts || {};
  const t0 = Date.now();
  const now = typeof o.now === 'number' ? o.now : t0;
  const base = { verdict: 'u_bad', side: null, reason: null, d1Ms: null, allocMs: null, calAgeMs: null };
  const done = (v) => Object.assign(base, v, { totalMs: Date.now() - t0 });

  if (it.tooLong) return done({ verdict: 'x_too_long' });
  if (it.stale) return done({ verdict: 'u_stale_unsent' });
  if (it.code === 'BUSY' || it.at === 'busy') return done({ verdict: 'x_busy' });
  if (!it.at || SCOPE_AT[it.at]) return done({ verdict: 'x_scope', reason: it.at || 'none' });
  if (it.at === 'f1') return done({ verdict: 'x_f1' });
  //   連続ルール：モードが off 以外で、その要求に効く（cm の末尾が 1）なら判定しない
  if (it.at === 'consec' || (/^(on|dry)1$/.test(it.cm))) return done({ verdict: 'x_consec' });
  //   GAS が残数で断ったが、残数がない以外の理由（契約が見つからない・確認が要る）は比べられない
  if (it.at === 'remain' && !it.ok && it.code !== 'NO_REMAINING') return done({ verdict: 'x_scope', reason: 'remain_other' });
  if (!it.cid || !it.tid || !it.s || !it.e || !(it.s < it.e)) return done({ verdict: 'u_bad' });
  //   自分の予約を外せない成功は判定しない（自分の予定と重なって必ず「Worker 断り」に見える）
  if (it.ok && (!it.rid || !it.eb || !it.et)) return done({ verdict: 'u_self_id' });

  // ---- 鮮度（I31・I53）。新しくなければ S3/S4 は「少し時間をおいて」と返す＝w_stale ----
  const tD = Date.now();
  let fresh = false, freshWhy = 'ok';
  try {
    const ci = await readCalcInputStatus(env, now);
    if (ci !== 'ok') freshWhy = ci;
    else {
      const v = await readSyncVersion(env, it.cid);
      fresh = isFresh(v);
      if (!fresh) freshWhy = 'not_fresh';
    }
  } catch (_) { freshWhy = 'read_failed'; }
  if (!fresh) return done({ verdict: 'w_stale', reason: freshWhy, d1Ms: Date.now() - tD });

  // ---- カレンダー（readCalendar をそのまま・FRESH_MS＝7分）----
  const required = [];
  if (o.trainer && o.trainer.calendarId) required.push({ calendarId: o.trainer.calendarId, role: CAL_ROLE.TRAINER, trainerId: it.tid });
  if (o.b1CalendarId) required.push({ calendarId: o.b1CalendarId, role: CAL_ROLE.CAPACITY_B1 });
  if (!required.length || !(o.trainer && o.trainer.calendarId)) return done({ verdict: 'u_cal_read', reason: 'no_trainer_calendar', d1Ms: Date.now() - tD });
  let cal;
  try {
    cal = await readCalendar(env, { fromMs: it.s, toMs: it.e, ruleVersion: ruleVersionOf(env), flag1f: flag1fOf(env), requiredCalendars: required, nowMs: now });
  } catch (_) { return done({ verdict: 'u_cal_read', reason: 'throw', d1Ms: Date.now() - tD }); }
  if (!cal.usable) return done({ verdict: 'u_cal_stale', reason: String(cal.reason || 'unknown'), d1Ms: Date.now() - tD });
  const calAgeMs = now - Number(cal.checkedAt);

  const own = new Set([evBase(it.eb), evBase(it.et)].filter(Boolean));
  const overlaps = (ev) => ev.startAt < it.e && ev.endAt > it.s;
  const notOwn = (ev) => !own.has(evBase(ev.eventId)) && !(it.ex && ev.startAt === it.ex);
  //   GAS と同じ規則：B1 は [消化] 以外の予定が重なれば埋まり（readCalendar が ignore を落としている）
  const b1Busy = cal.events.some((ev) => ev.role === CAL_ROLE.CAPACITY_B1 && ev.effect === EV_KIND.ROOM_BUSY && overlaps(ev) && notOwn(ev));
  //   トレーナー：1つの出勤の中に収まる・埋まり（休憩・ブロック・予約）が重ならない（_lbCheckTrainerAvailable と同じ）
  const mine = cal.events.filter((ev) => ev.role === CAL_ROLE.TRAINER && ev.trainerId === it.tid);
  const shiftOk = mine.some((ev) => ev.effect === EV_KIND.SHIFT && ev.startAt <= it.s && ev.endAt >= it.e);
  const trainerBusy = mine.some((ev) => ev.effect === EV_KIND.BUSY && overlaps(ev) && notOwn(ev));

  // ---- 残数（GAS が残数の判定まで進んだとき・振替は残数を見ない）----
  let remainOk = true, allocMs = null;
  const reached = ['remain', 'b1', 'trainer', 'ok'].indexOf(it.at) >= 0;
  if (reached && it.op !== 'transfer') {
    if (!it.pk) return done({ verdict: 'u_remain_kind', d1Ms: Date.now() - tD, calAgeMs });
    const input = await loadCalcInput(env, it.cid);
    if (!input || !input.ok) return done({ verdict: 'u_remain_input', reason: String((input && input.reason) || 'none').slice(0, 30), d1Ms: Date.now() - tD, calAgeMs });
    const drop = new Set([it.rid, it.xr].filter(Boolean));
    const sessions = input.sessions.filter((x) => !drop.has(String(x.resId || '')));
    const tA = Date.now();
    let b;
    try { b = _lbBookability(it.cid, input.rows, sessions, monthKeyJst(it.t || now), it.s, CARRY_RATE, it.ex || undefined, input.opening, it.att, it.pk); }
    catch (_) { b = null; }
    allocMs = Date.now() - tA;
    if (!b || !b.ok) return done({ verdict: 'u_remain_input', reason: 'alloc', d1Ms: Date.now() - tD, allocMs, calAgeMs });
    remainOk = !!b.canBook;
  }
  const d1Ms = Date.now() - tD - (allocMs || 0);

  // ---- 比べる（GAS の順：残数 → B1 → トレーナー）----
  const wAxis = !remainOk ? 'remain' : b1Busy ? 'b1' : !shiftOk ? 'shift' : trainerBusy ? 'busy' : '';
  const gAxis = it.ok ? '' : it.at;   // remain / b1 / trainer
  const sameAxis = (g, w) => g === w || (g === 'trainer' && (w === 'shift' || w === 'busy'));
  let verdict, side = null;
  if (!gAxis && !wAxis) verdict = 'match_ok';
  else if (gAxis && wAxis) verdict = sameAxis(gAxis, wAxis) ? 'match_ng' : 'diff_ng_reason';
  else if (!gAxis) { verdict = 'diff_' + wAxis; side = 'gas_ok_worker_ng'; }
  else { verdict = 'diff_' + (gAxis === 'trainer' ? 'busy' : gAxis); side = 'gas_ng_worker_ok'; }
  return done({ verdict, side, d1Ms, allocMs, calAgeMs });
}

export const _forTest = { monthKeyJst, evBase, CARRY_RATE, FRESH_MS };

/**
 * M3：会員が「新しくない」から「新しい」に戻った瞬間に、新しくなかった長さを1行残す（設計54 §2-3）。
 *   ver0＝書く前・after＝書いた後（readSyncVersion の形）。どちらかが無ければ何もしない。
 *   ★失敗しても呼び出し元（作り直し）の結果を変えない（例外を外へ出さない）。WRITE_SHADOW が "on" のときだけ書く。
 */
export async function noteFreshDelay(env, ver0, after, now) {
  try {
    if (String((env && env.WRITE_SHADOW) || '') !== 'on') return false;
    if (!ver0 || !after || isFresh(ver0) || !isFresh(after)) return false;
    const dirty = Number(ver0.dirtySeq || 0) > Number(ver0.coversSeq || 0);
    const since = dirty ? ver0.dirtySince : ver0.sourceAt;
    if (!isMs(since) || since > now) return false;
    await env.DB.prepare('INSERT INTO fresh_delay_log (day, cause, delay_ms, created_at) VALUES (?, ?, ?, ?)')
      .bind(jstDay(now), dirty ? 'dirty' : 'source', now - since, now).run();
    return true;
  } catch (_) { return false; }
}

/**
 * M2：人が入れた予定（トレーナーのカレンダーの 出勤・休憩・ブロック）が D1 に届くまでの遅れを残す（設計54 §2-2・§3-4）。
 *   calsync の差分（tryPatch の insRows・updRows・delRows）から呼ぶ。GAS は予定ごとに updatedAt（getLastUpdated のミリ秒）を送る。
 *   ★updatedAt が前回の同期の時刻より新しいものだけ数える（反映直後の一斉の記録を出さない）。消えた予定は「前回の同期から」の上限値。
 *   ★window_hits：その予定の「最終更新〜到着」の間に、同じトレーナー・重なる時間で GAS が通した確定の数（write_shadow_log から）
 *   ★失敗しても呼び出し元（同期）の結果を変えない。1回50行まで
 */
const HUMAN_REASON = { shift: 'shift', break: 'break', block: 'block' };
export async function noteArrivals(env, events, patch, prevCheckedAt, now) {
  try {
    if (!patch || !isMs(prevCheckedAt) || !(prevCheckedAt < now)) return 0;
    const byKey = new Map();
    for (const e of (events || [])) byKey.set(String(e.calendarId) + '\u0000' + String(e.eventId), e);
    const out = [];
    const take = (kind, r, since) => {
      if (out.length >= 50 || String(r.role) !== 'trainer') return;
      const cls = HUMAN_REASON[String(r.reason)];
      if (!cls) return;
      out.push({ kind, cls, tid: r.trainer_id == null ? null : String(r.trainer_id), s: Number(r.start_at), e: Number(r.end_at), since });
    };
    for (const r of (patch.insRows || []).concat(patch.updRows || [])) {
      const ev = byKey.get(String(r.calendar_id) + '\u0000' + String(r.event_id));
      const u = ev && ev.updatedAt;
      if (!isMs(u) || u <= prevCheckedAt || u > now) continue;
      take((patch.insRows || []).indexOf(r) >= 0 ? 'add' : 'change', r, u);
    }
    for (const r of (patch.delRows || [])) take('remove', r, prevCheckedAt);
    for (const a of out) {
      let hits = 0;
      try {
        const h = await env.DB.prepare(
          'SELECT COUNT(*) AS n FROM write_shadow_log WHERE tid = ? AND gas_ok = 1 AND s < ? AND e > ? AND t >= ? AND t <= ?'
        ).bind(a.tid, a.e, a.s, a.since, now).first();
        hits = Number((h && h.n) || 0);
      } catch (_) { hits = 0; }
      await env.DB.prepare(
        'INSERT INTO calendar_arrival_log (day, kind, cls, tid, s, e, delay_ms, window_hits, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(jstDay(now), a.kind, a.cls, a.tid, a.s, a.e, now - a.since, hits, now).run();
    }
    return out.length;
  } catch (_) { return 0; }
}
//   危険な当たり：休憩・ブロックの追加／変更、出勤の削除／変更（古い D1 では通してしまう向き）
export function arrivalDanger(kind, cls) {
  return ((kind === 'add' || kind === 'change') && (cls === 'break' || cls === 'block'))
      || (cls === 'shift' && (kind === 'remove' || kind === 'change'));
}
