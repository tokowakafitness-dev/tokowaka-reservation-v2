// 設計54 S1a：write-shadow の Worker 側（本物の SQLite に schema と全 migration を流して入口 /writeshadow から通す）
//   実行: node worker/test/write-shadow.test.js
//
//   ① 判定：GAS 成功・D1 で B1 が埋まり → diff_b1・gas_ok_worker_ng／GAS 断り（b1）・D1 で空き → gas_ng_worker_ok（危険側）
//   ② 自分の予定・自分の行は予約ID・予定IDで外す。★別の会員が同じ時刻に入っている（本物の二重予約）は外さず食い違い
//   ③ 判定できない・範囲外は一致にも食い違いにも数えない：鮮度（w_stale）・カレンダーが7分を超えて古い（u_cal_stale・6分59秒は判定）・
//      範囲外（x_scope）・自分のIDが欠けた成功（u_self_id・I-H は無いので設計54 ④-i）・too_long・BUSY
//   ④ 3つの表に顧客ID・予約ID・予定ID・名前の列が無い（I84・PRAGMA table_info で列名を固定）
//   ⑤ 行の鍵 n で二重に入らない（同じ n を2回送っても1行・2回目も acked）
//   ⑥ 残数：allocate.js の _lbBookability（同じファイル）で、月4回の契約に4件入っていれば diff_remain／GAS と同じ種別（pk）が無ければ u_remain_kind
//   ⑦ スイッチ WRITE_SHADOW が "on" でなければ記録しない（acked は返す）・合言葉が無ければ 401
//   ⑧ status：件数・分布だけ（ID・時刻の生の値・tid を返さない）・M3 の fresh_delay_log
//   ⑨ I85：判定は単一ソースを import している（書き写していない）・GAS の段の語と Worker の語が同じ集合・繰越率が GAS と同じ
//   ★値は架空（個人情報を書かない）
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { handleWriteShadow } from '../src/routes/write-shadow.js';
import { handleCalSync } from '../src/routes/calsync.js';
import { WS_GAS_AT, _forTest, noteFreshDelay } from '../src/lib/write-shadow.js';
import { FRESH_MS } from '../src/lib/calread.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const W = join(HERE, '..');
const ROOT = join(W, '..');
const SECRET = 'S';
let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) pass++; else { fail++; console.log(`❌ ${name}${detail ? '\n   ' + detail : ''}`); } }

const B1 = 'b1@group.calendar.google.com', TC = 't1@group.calendar.google.com';
const HOUR = 3600000, DAY = 86400000;
const NOW = Date.now();
const S = (Math.floor(NOW / HOUR) + 30) * HOUR, E = S + HOUR;   // 30時間後の1時間（地平の中）

function makeEnv(vars = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(W, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(join(W, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    try { db.exec(readFileSync(join(W, 'migrations', f), 'utf8')); } catch (e) { if (!/duplicate column/.test(e.message)) throw e; }
  }
  const env = Object.assign({ SHARED_SECRET: SECRET, WRITE_SHADOW: 'on', CAL_B1_CALENDAR_ID: B1, _db: db }, vars);
  const exec = (q, a, how) => {
    const st = db.prepare(q);
    if (how === 'first') { const r = st.get(...a); return r === undefined ? null : Object.assign({}, r); }
    if (how === 'all') return { results: st.all(...a).map((r) => Object.assign({}, r)) };
    const r = st.run(...a); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  };
  env.DB = {
    prepare(q) { return { _q: q, _a: [], bind(...a) { this._a = a; return this; },
      async run() { return exec(q, this._a, 'run'); }, async first() { return exec(q, this._a, 'first'); },
      async all() { return exec(q, this._a, 'all'); } }; },
    async batch(ss) { db.exec('BEGIN'); try { const o = ss.map((s) => exec(s._q, s._a, 'run')); db.exec('COMMIT'); return o; }
                      catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; } },
  };
  return env;
}

const CID = 'C5400000000001', CID2 = 'C5400000000002';
const CALS = JSON.stringify([
  { calendar_id: B1, role: 'capacity_b1', trainer_id: null },
  { calendar_id: TC, role: 'trainer', trainer_id: 'T1' },
].sort((a, b) => (a.calendar_id < b.calendar_id ? -1 : 1)));

function seed(env, o = {}) {
  const d = env._db;
  d.prepare("INSERT INTO trainers (trainer_id, name, calendar_id, role, active, hidden) VALUES ('T1', 'テスト', ?, 'trainer', 1, 0)").run(TC);
  const checked = o.checkedAt == null ? NOW - 60000 : o.checkedAt;
  const r = d.prepare(`INSERT INTO calendar_snapshot (status, horizon_start, horizon_end, calendars, rule_version, flag_1f, content_hash, owner_window, built_at, created_at)
                       VALUES ('ready', ?, ?, ?, 1, 'off', ?, NULL, ?, ?)`).run(NOW - DAY, NOW + 40 * DAY, CALS, 'a'.repeat(64), checked, checked);
  const gen = Number(r.lastInsertRowid);
  d.prepare('UPDATE calendar_active SET generation = ?, checked_at = ? WHERE id = 1').run(gen, checked);
  const ev = (cal, id, role, tid, effect, s, e) => d.prepare(`INSERT INTO calendar_events (generation, calendar_id, event_id, role, trainer_id, effect, reason, start_at, end_at, all_day)
                                                          VALUES (?, ?, ?, ?, ?, ?, 'x', ?, ?, 0)`).run(gen, cal, id, role, tid, effect, s, e);
  ev(TC, 'shift1#1', 'trainer', 'T1', 'shift', S - 3 * HOUR, E + 3 * HOUR);   // 出勤
  for (const x of (o.events || [])) ev(x.cal, x.id, x.role, x.tid || null, x.effect, x.s, x.e);
  //   材料4つの回（I53）と世代（I31）
  for (const k of ['calcContracts', 'calcMeta', 'calcReservations', 'opening']) {
    d.prepare('INSERT OR REPLACE INTO sync_state (key, synced_at, rows, ok) VALUES (?, ?, 1, 1)').run(k, o.calcAt == null ? NOW - 60000 : o.calcAt);
  }
  for (const c of [CID, CID2]) {
    d.prepare(`INSERT INTO customer_sync_version (customer_id, source_version, built_version, updated_at, dirty_seq, built_covers_seq)
               VALUES (?, 3, ?, 1, 0, 0)`).run(c, o.stale ? 2 : 3);
  }
  d.prepare(`INSERT INTO calc_meta (key, payload) VALUES ('contract_cols', ?)`).run(JSON.stringify({ cols: { name: 1, type: 2, reward: 4, course: 5, ticket: 6, freq: 8, start: 10, end: 11, trainer: 3, method: 16, ticketPrice: 19 } }));
  const crow = new Array(23).fill('');
  crow[1] = '見本一'; crow[2] = '月額'; crow[3] = '一郎'; crow[5] = 'ベーシック'; crow[8] = 4;
  d.prepare(`INSERT INTO calc_contract_rows (row_key, customer_id, idx, row_json, start_ms, end_ms) VALUES (?, ?, 1, ?, ?, ?)`)
    .run(CID + '#1', CID, JSON.stringify(crow), monthStartJst(S), NOW + 300 * DAY);   // その月の初めから（前の月からの繰越を作らない）
  //   予約（台帳の行の形）：o.sessions 件を S と同じ月に
  const ms0 = S;
  (o.sessions || []).forEach((x, i) => {
    const row = [x.at || (monthStartJst(ms0) + (i + 1) * 2 * HOUR), '見本一', CID, '', 'T1', 'テスト', 'confirmed', '', x.rid || ('L' + i), 'line', '', 'S' + i, '', '', 1];
    d.prepare('INSERT INTO calc_reservation_rows (row_key, customer_id, row_json, synced_at) VALUES (?, ?, ?, 1)').run('r' + i, CID, JSON.stringify(row));
  });
}

function monthStartJst(ms) { const d = new Date(ms + 9 * HOUR); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - 9 * HOUR; }
let N = 0;
const nk = () => ('ab' + String(++N).padStart(6, '0'));
const item = (o) => Object.assign({ n: nk(), op: 'reserve', ok: 1, code: '', at: 'ok', cid: CID, tid: 'T1', s: S, e: E, att: 1, pk: 'normal', cm: '', t: NOW - 5000,
  rid: 'Lown', eb: 'evB1own@google.com', et: 'evTown@google.com' }, o);
async function post(env, items, headers) {
  const res = await handleWriteShadow(new Request('https://x/writeshadow', { method: 'POST',
    headers: Object.assign({ 'X-Ingest-Secret': SECRET, 'Content-Type': 'application/json' }, headers || {}),
    body: JSON.stringify({ items, drain: 'AFTER', build: 'test' }) }), env);
  return { status: res.status, body: await res.json() };
}
const row = (env, n) => { const r = env._db.prepare('SELECT * FROM write_shadow_log WHERE n = ?').get(n); return r ? Object.assign({}, r) : null; };

console.log('=== ① 判定と向き（危険側・安全側） ===');
{
  const env = makeEnv(); seed(env, { events: [{ cal: B1, id: 'other#1', role: 'capacity_b1', effect: 'room_busy', s: S, e: E }] });
  const a = item(); await post(env, [a]);
  const r = row(env, a.n);
  ok('①-1 GAS 成功・D1 で B1 が別の予定で埋まり → diff_b1・gas_ok_worker_ng（安全側）', r && r.verdict === 'diff_b1' && r.side === 'gas_ok_worker_ng', JSON.stringify(r));
}
{
  const env = makeEnv(); seed(env);
  const a = item({ ok: 0, code: 'SLOT_TAKEN', at: 'b1', rid: '', eb: '', et: '' }); await post(env, [a]);
  const r = row(env, a.n);
  ok('①-2 ★GAS は B1 で断り・D1 では空き → diff_b1・gas_ng_worker_ok（危険側）', r && r.verdict === 'diff_b1' && r.side === 'gas_ng_worker_ok', JSON.stringify(r));
  const b = item(); await post(env, [b]);
  ok('①-3 両方通す → match_ok', row(env, b.n).verdict === 'match_ok', JSON.stringify(row(env, b.n)));
}
{
  const env = makeEnv(); seed(env, { events: [{ cal: TC, id: 'brk#1', role: 'trainer', tid: 'T1', effect: 'busy', s: S + 15 * 60000, e: S + 30 * 60000 }] });
  const a = item({ ok: 0, code: 'SLOT_TAKEN', at: 'trainer', rid: '', eb: '', et: '' }); await post(env, [a]);
  ok('①-4 GAS はトレーナーで断り・D1 で休憩が重なる → match_ng（軸が同じ）', row(env, a.n).verdict === 'match_ng', JSON.stringify(row(env, a.n)));
  const b = item(); await post(env, [b]);
  ok('①-5 GAS 成功・D1 で休憩が重なる → diff_busy・gas_ok_worker_ng', row(env, b.n).verdict === 'diff_busy' && row(env, b.n).side === 'gas_ok_worker_ng');
}

console.log('=== ② 自分の予約は ID で外す・本物の二重予約は外さない ===');
{
  const env = makeEnv(); seed(env, { events: [
    { cal: B1, id: 'evB1own@google.com#' + S, role: 'capacity_b1', effect: 'room_busy', s: S, e: E },
    { cal: TC, id: 'evTown@google.com#' + S, role: 'trainer', tid: 'T1', effect: 'busy', s: S, e: E },
  ] });
  const a = item(); await post(env, [a]);
  ok('②-1 自分の B1・トレーナーの予定（予定IDの # の前が一致）を外して match_ok', row(env, a.n).verdict === 'match_ok', JSON.stringify(row(env, a.n)));
}
{
  const env = makeEnv(); seed(env, { events: [
    { cal: B1, id: 'evB1own@google.com#' + S, role: 'capacity_b1', effect: 'room_busy', s: S, e: E },
    { cal: B1, id: 'evB1other@google.com#' + S, role: 'capacity_b1', effect: 'room_busy', s: S, e: E },   // ★別の会員が同じ時刻
    { cal: TC, id: 'evTown@google.com#' + S, role: 'trainer', tid: 'T1', effect: 'busy', s: S, e: E },
  ] });
  const a = item(); await post(env, [a]);
  ok('②-2 ★同じトレーナー・同じ時刻にもう1件（本物の二重予約）→ 外さずに diff_b1（「1件外す」推定ではない）', row(env, a.n).verdict === 'diff_b1', JSON.stringify(row(env, a.n)));
}

console.log('=== ③ 判定できない・範囲外 ===');
{
  const env = makeEnv(); seed(env, { stale: true });
  const a = item(); await post(env, [a]);
  ok('③-1 世代が新しくない → w_stale（一致にも食い違いにも数えない）', row(env, a.n).verdict === 'w_stale' && row(env, a.n).side === null, JSON.stringify(row(env, a.n)));
}
{
  const env = makeEnv(); seed(env, { checkedAt: NOW - FRESH_MS - 60000 });
  const a = item(); await post(env, [a]);
  ok('③-2 カレンダーが7分を超えて古い → u_cal_stale（理由 stale）', row(env, a.n).verdict === 'u_cal_stale' && row(env, a.n).reason === 'stale', JSON.stringify(row(env, a.n)));
}
{
  const env = makeEnv(); seed(env, { checkedAt: Date.now() - FRESH_MS + 2000 });
  const a = item(); await post(env, [a]);
  ok('③-3 6分58秒なら判定する（境界は readCalendar の FRESH_MS＝7分のまま）', row(env, a.n).verdict === 'match_ok', JSON.stringify(row(env, a.n)));
  ok('③-3b FRESH_MS は7分', FRESH_MS === 7 * 60000 && _forTest.FRESH_MS === FRESH_MS);
}
{
  const env = makeEnv(); seed(env);
  const cases = [
    [{ ok: 0, code: 'TOO_SOON', at: 'deadline', rid: '', eb: '', et: '' }, 'x_scope'],
    [{ ok: 0, code: 'BUSY', at: 'busy', rid: '', eb: '', et: '' }, 'x_busy'],
    [{ ok: 0, code: 'SLOT_CHECK_UNAVAILABLE', at: 'f1', rid: '', eb: '', et: '' }, 'x_f1'],
    [{ cm: 'on1' }, 'x_consec'],
    [{ et: '' }, 'u_self_id'],
    [{ too_long: 1 }, 'x_too_long'],
    [{ ok: 0, code: 'REVIEW_REQUIRED', at: 'remain', rid: '', eb: '', et: '' }, 'x_scope'],
  ];
  for (const [o, want] of cases) {
    const a = item(o); await post(env, [a]);
    ok(`③-4 ${JSON.stringify(o)} → ${want}`, row(env, a.n) && row(env, a.n).verdict === want, JSON.stringify(row(env, a.n)));
  }
  const all = env._db.prepare("SELECT COUNT(*) AS n FROM write_shadow_log WHERE side IS NOT NULL").get().n;
  ok('③-5 範囲外・判定できないものに向き（side）が付かない', all === 0, String(all));
}

console.log('=== ④ 列の名前（I84） ===');
{
  const env = makeEnv();
  const cols = (t) => env._db.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name);
  const banned = /customer|cid|rid|resv|reservation|event|eb$|et$|name|title|line/i;
  for (const t of ['write_shadow_log', 'write_shadow_stat', 'calendar_arrival_log', 'fresh_delay_log']) {
    const c = cols(t);
    ok(`④ ${t} に顧客ID・予約ID・予定ID・名前の列が無い`, c.length > 0 && !c.some((x) => banned.test(x)), c.join(','));
  }
  ok('④-2 write_shadow_log の列の集合を固定', cols('write_shadow_log').join(',') ===
     'n,day,hour,op,gas_ok,gas_at,verdict,side,reason,tid,s,e,t,lag_ms,cal_age_ms,d1_ms,alloc_ms,total_ms,drain,build,created_at', cols('write_shadow_log').join(','));
  let threw = false;
  try { env._db.prepare("INSERT INTO write_shadow_log (n, day, hour, op, gas_ok, gas_at, verdict, created_at) VALUES ('abcdef01', 'd', 1, 'reserve', 1, 'ok', 'nope', 1)").run(); } catch (_) { threw = true; }
  ok('④-3 verdict の CHECK が知らない値を断る（本物の SQLite）', threw);
}

console.log('=== ⑤ n で冪等 ===');
{
  const env = makeEnv(); seed(env);
  const a = item();
  const r1 = await post(env, [a]); const r2 = await post(env, [a]);
  const n = env._db.prepare('SELECT COUNT(*) AS n FROM write_shadow_log WHERE n = ?').get(a.n).n;
  ok('⑤ 同じ n を2回送っても1行・2回とも acked', n === 1 && r1.body.acked.includes(a.n) && r2.body.acked.includes(a.n), JSON.stringify([r1.body, r2.body, n]));
}

console.log('=== ⑥ 残数（allocate.js の _lbBookability） ===');
{
  const env = makeEnv(); seed(env, { sessions: [{}, {}, {}, {}] });   // 月4回の契約に同じ月4件
  const a = item({ rid: 'Lnew' }); await post(env, [a]);
  ok('⑥-1 月4回に4件入っている → diff_remain・gas_ok_worker_ng', row(env, a.n).verdict === 'diff_remain' && row(env, a.n).side === 'gas_ok_worker_ng', JSON.stringify(row(env, a.n)));
  const b = item({ rid: 'L3' }); await post(env, [b]);
  ok('⑥-2 そのうち1件が自分の予約（rid が一致）なら外して match_ok', row(env, b.n).verdict === 'match_ok', JSON.stringify(row(env, b.n)));
  const c = item({ pk: '' }); await post(env, [c]);
  ok('⑥-3 GAS が決めた種別（pk）が無ければ u_remain_kind', row(env, c.n).verdict === 'u_remain_kind', JSON.stringify(row(env, c.n)));
  const d = item({ op: 'transfer', rid: 'Lnew' }); await post(env, [d]);
  ok('⑥-4 振替は残数を見ない → match_ok', row(env, d.n).verdict === 'match_ok', JSON.stringify(row(env, d.n)));
}

console.log('=== ⑦ スイッチ・合言葉 ===');
{
  const env = makeEnv({ WRITE_SHADOW: '' }); seed(env);
  const a = item(); const r = await post(env, [a]);
  ok('⑦-1 WRITE_SHADOW 未設定 → 記録しない・acked は返す（GAS の待ちを溜めない）', r.body.mode === 'off' && r.body.acked.includes(a.n) && !row(env, a.n));
  const env2 = makeEnv(); seed(env2);
  const r2 = await post(env2, [item()], { 'X-Ingest-Secret': 'wrong' });
  ok('⑦-2 合言葉が違えば 401', r2.status === 401);
  const env3 = makeEnv({ WRITE_SHADOW: 'On' }); seed(env3);
  const r3 = await post(env3, [item()]);
  ok('⑦-3 "on" と厳密に一致しなければ off', r3.body.mode === 'off');
}

console.log('=== ⑧ status・M3 ===');
{
  const env = makeEnv(); seed(env);
  await post(env, [item(), item({ ok: 0, code: 'SLOT_TAKEN', at: 'b1', rid: '', eb: '', et: '' })]);
  const res = await handleWriteShadow(new Request('https://x/writeshadow/status', { headers: { 'X-Ingest-Secret': SECRET } }), env);
  const st = await res.json();
  const txt = JSON.stringify(st);
  ok('⑧-1 status は件数と分布（当日に2件・危険側1）', Object.values(st.days).some((d) => d.n === 2 && d.side.gas_ng_worker_ok === 1), txt.slice(0, 400));
  ok('⑧-2 status に顧客ID・予約ID・予定ID・トレーナーID・開始時刻が出ない', !/C54|Lown|evB1|evT|"T1"|"tid"|"s":/.test(txt), txt.slice(0, 400));
  const v0 = { sourceVersion: 3, builtVersion: 3, dirtySeq: 5, coversSeq: 4, dirtySince: NOW - 90000, exists: true };
  const v1 = { sourceVersion: 3, builtVersion: 3, dirtySeq: 5, coversSeq: 5, dirtySince: null, exists: true };
  const w1 = await noteFreshDelay(env, v0, v1, NOW);
  const w2 = await noteFreshDelay(env, v1, v1, NOW);
  const rows = env._db.prepare('SELECT cause, delay_ms FROM fresh_delay_log').all().map((r) => Object.assign({}, r));
  ok('⑧-3 M3：新しくない→新しいに戻ったときだけ1行（dirty・90秒）・戻らなければ0行', w1 === true && w2 === false && rows.length === 1 && rows[0].cause === 'dirty' && rows[0].delay_ms === 90000, JSON.stringify(rows));
  const off = makeEnv({ WRITE_SHADOW: '' });
  ok('⑧-4 M3 もスイッチが off なら書かない', (await noteFreshDelay(off, v0, v1, NOW)) === false);
}

console.log('=== ⑩ M2：人が入れた予定が D1 に届くまでの遅れ（calsync の差分から） ===');
{
  const env = makeEnv();
  env._db.prepare("INSERT INTO trainers (trainer_id, name, calendar_id, role, active, hidden) VALUES ('T1', 'テスト', ?, 'trainer', 1, 0)").run(TC);
  const T2C = 't2@group.calendar.google.com', T3C = 't3@group.calendar.google.com';
  const cals = [{ calendarId: B1, role: 'capacity_b1', trainerId: null }, { calendarId: TC, role: 'trainer', trainerId: 'T1' },
                { calendarId: T2C, role: 'trainer', trainerId: 'T2' }, { calendarId: T3C, role: 'trainer', trainerId: 'T3' }];
  const other = { calendarId: T2C, eventId: 'sh2@google.com#' + S, role: 'trainer', trainerId: 'T2', effect: 'shift', reason: 'shift', startAt: S, endAt: E, allDay: 0, updatedAt: NOW - DAY };
  const shift = { calendarId: TC, eventId: 'sh@google.com#' + (S - 3 * HOUR), role: 'trainer', trainerId: 'T1', effect: 'shift', reason: 'shift', startAt: S - 3 * HOUR, endAt: E + 3 * HOUR, allDay: 0, updatedAt: NOW - DAY };
  const send = async (events, hash) => {
    const res = await handleCalSync(new Request('https://x/calsync', { method: 'POST', headers: { 'X-Ingest-Secret': SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify({ horizonStart: NOW - DAY, horizonEnd: NOW + 40 * DAY, ruleVersion: 1, flag1f: 'off', contentHash: hash, calendars: cals, events, invalid: [] }) }), env);
    return res.json();
  };
  const r1 = await send([shift, other], 'a'.repeat(64));
  //   前回の同期は10分前だったことにする
  env._db.prepare('UPDATE calendar_active SET checked_at = ? WHERE id = 1').run(NOW - 10 * 60000);
  //   その間に GAS が通した確定（同じトレーナー・重なる時間）
  env._db.prepare(`INSERT INTO write_shadow_log (n, day, hour, op, gas_ok, gas_at, verdict, tid, s, e, t, created_at)
                   VALUES ('cd000001', 'd', 1, 'reserve', 1, 'ok', 'match_ok', 'T1', ?, ?, ?, 1)`).run(S, E, NOW - 60000);
  const brk = { calendarId: TC, eventId: 'brk@google.com#' + S, role: 'trainer', trainerId: 'T1', effect: 'busy', reason: 'break', startAt: S, endAt: S + 30 * 60000, allDay: 0, updatedAt: NOW - 120000 };
  const old = { calendarId: TC, eventId: 'old@google.com#' + (S + 5 * HOUR), role: 'trainer', trainerId: 'T1', effect: 'busy', reason: 'reserved', startAt: S + 5 * HOUR, endAt: S + 6 * HOUR, allDay: 0 };
  const r2 = await send([shift, other, brk, old], 'b'.repeat(64));
  const rows = env._db.prepare('SELECT kind, cls, tid, delay_ms, window_hits FROM calendar_arrival_log').all().map((r) => Object.assign({}, r));
  ok('⑩-1 差分で入った休憩だけ1行（予約の ✅ は数えない・最終更新が前回の同期より古い出勤は数えない）', r1.success && r2.mode === 'patched' && rows.length === 1 && rows[0].kind === 'add' && rows[0].cls === 'break', JSON.stringify([r1.mode, r2.mode, rows]));
  ok('⑩-2 遅れ＝到着 − 最終更新（約120秒）・窓の当たり1件', rows[0] && rows[0].delay_ms >= 120000 && rows[0].delay_ms < 130000 && rows[0].window_hits === 1, JSON.stringify(rows));
  //   ★前回の同期を1分前に置く（r2 と r3 が同じ1ミリ秒に入ると noteArrivals の prevCheckedAt < now が偽になり記録されない＝時々落ちていた・2026-11-25）
  env._db.prepare('UPDATE calendar_active SET checked_at = ? WHERE id = 1').run(Date.now() - 60000);
  const r3 = await send([other, brk, old], 'c'.repeat(64));   // T1 の出勤が消えた
  const rows3 = env._db.prepare("SELECT kind, cls FROM calendar_arrival_log WHERE kind = 'remove'").all().map((r) => Object.assign({}, r));
  ok('⑩-3 出勤が消えたら remove（上限値＝前回の同期から）', r3.mode === 'patched' && rows3.length === 1 && rows3[0].cls === 'shift', JSON.stringify([r3, rows3]));
  const st = await (await handleWriteShadow(new Request('https://x/writeshadow/status', { headers: { 'X-Ingest-Secret': SECRET } }), env)).json();
  ok('⑩-4 status の当たりは当日の分を前日として読まない（前日0件）', st.arrival && st.arrival.n === 0, JSON.stringify(st.arrival));
  const off = makeEnv({ WRITE_SHADOW: '' });
  off._db.prepare("INSERT INTO trainers (trainer_id, name, calendar_id, role, active, hidden) VALUES ('T1', 'テスト', ?, 'trainer', 1, 0)").run(TC);
  const sendOff = async (events, hash) => (await handleCalSync(new Request('https://x/calsync', { method: 'POST', headers: { 'X-Ingest-Secret': SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify({ horizonStart: NOW - DAY, horizonEnd: NOW + 40 * DAY, ruleVersion: 1, flag1f: 'off', contentHash: hash, calendars: cals, events, invalid: [] }) }), off)).json();
  await sendOff([shift, other], 'a'.repeat(64)); off._db.prepare('UPDATE calendar_active SET checked_at = ? WHERE id = 1').run(NOW - 10 * 60000);
  await sendOff([shift, other, brk], 'b'.repeat(64));
  ok('⑩-5 WRITE_SHADOW が off なら記録しない（同期は今どおり）', off._db.prepare('SELECT COUNT(*) AS n FROM calendar_arrival_log').get().n === 0);
}

console.log('=== ⑨ I85：単一ソース・語の一致 ===');
{
  const src = readFileSync(join(W, 'src/lib/write-shadow.js'), 'utf8');
  ok('⑨-1 readCalendar・_lbBookability・loadCalcInput・isFresh・readCalcInputStatus を import して使う（書き写していない）',
     /import \{ readCalendar/.test(src) && /import \{ _lbBookability \} from '\.\.\/allocate\.js'/.test(src) && /import \{ loadCalcInput \}/.test(src)
     && /import \{ isFresh, readSyncVersion \}/.test(src) && /import \{ readCalcInputStatus \}/.test(src));
  ok('⑨-2 Worker に FRESH_MS・分類の規則を別に持たない', !/7 \* 60 \* 1000|isShiftTitle|isBusyTitle/.test(src));
  const gas = readFileSync(join(ROOT, 'gas/PushToEdge.js'), 'utf8');
  const m = gas.match(/AT: \[([^\]]+)\]/);
  const gasAt = m ? m[1].split(',').map((x) => x.trim().replace(/'/g, '')) : [];
  ok('⑨-3 GAS の LB_WS.AT と Worker の WS_GAS_AT が同じ集合', JSON.stringify(gasAt.slice().sort()) === JSON.stringify(WS_GAS_AT.slice().sort()), gasAt.join(','));
  const lb = readFileSync(join(ROOT, 'gas/LineBooking.js'), 'utf8');
  const marks = [...new Set((lb.match(/_LB_WS\.at = '([a-z0-9]+)'/g) || []).map((x) => x.match(/'([a-z0-9]+)'/)[1]).concat(['gate']))].sort();
  ok('⑨-4 _lbReserveCoreImpl が付ける段の語は全部 WS_GAS_AT にある', marks.every((x) => WS_GAS_AT.includes(x)) && marks.length >= 13, marks.join(','));
  ok('⑨-5 繰越率は GAS の LINE_BOOKING.CARRYOVER_RATE（1/3）と同じ', /CARRYOVER_RATE: 1 \/ 3,/.test(lb) && Math.abs(_forTest.CARRY_RATE - 1 / 3) < 1e-12);
}

console.log(`\n${fail ? '❌' : '✅'} 設計54 write-shadow（Worker）: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
