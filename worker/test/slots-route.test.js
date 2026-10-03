// 空き枠を「配る経路」の検証（三段構え・2026-10-03）
//
//   ① calendar_events から計算   … source:'calendar'
//   ② slots_cache（GASの写し）    … source:'cache' ＋ fallbackReason
//   ③ GASへ落ちる                … stale:true（判断するのはフロント）
//
//   ここで固定したいのは、顧客に見える誤りに直結するもの：
//     ① **0件と「分からない」を混ぜない。** ②も無いときは stale:true を立てる。
//        混ぜると、障害が「空きがありません」に化けて黙って予約を失う。
//     ② **どの経路で返したか（source）と、①を使わなかった理由（fallbackReason）が必ず返る。**
//        どちらで動いているか分からない状態にしない。黙って②に落ちない。
//     ③ **締め切りの判定が経路で変わらない。** ①と②が同じ枠の集合を返すこと。
//        変わると「見えているのに予約できない」「①では見えるが②では見えない」が起きる。
//     ④ **hidden なトレーナーの枠が ownerWindow で絞られる。**
//        絞られないと、固定枠の持ち主の枠が本来出ない曜日・時間帯に出る。
//     ⑤ **既定では①を使わない**（段階導入）。
//
//   D1の身代わりは node:sqlite（実物のSQLite）で、schema.sql をそのまま流す
//   （calsync.test.js / calread.test.js と同じ方針）。
//
//   ★時刻は実時刻（Date.now()）で組む。routeSlots は Date.now() を使うので、
//     試験用の抜け道（body で now を渡す等）を本番の経路に作らない。
//     そのぶん、締め切りの境界は「実時刻からの相対」で作る。
//
//   実行: node worker/test/slots-route.test.js（node:sqlite を使うので Node 22.5 以上）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { routeSlots, SLOT_SOURCE, SLOT_FALLBACK, CACHE_STALE_MS, _forTest as _slots } from '../src/routes/slots.js';
import { readCalendar, FRESH_MS, _forTest as _calread } from '../src/lib/calread.js';
import { jstParts, jstMs } from '../src/lib/calslots.js';
import { CAL_ROLE, EV_KIND } from '../src/lib/calclass.js';
import { handleCalSync, _forTest as _calsync } from '../src/routes/calsync.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(HERE, '..', 'schema.sql'), 'utf8');
const SECRET = 'TEST-SECRET';

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else { fail++; console.log(`❌ ${name}\n   got : ${g}\n   want: ${w}`); }
}
function ok(name, cond, detail) {
  if (cond) pass++; else { fail++; console.log(`❌ ${name}${detail ? '\n   ' + detail : ''}`); }
}

// ------------------------------------------------------------
// D1の身代わり（実物のSQLite）
// ------------------------------------------------------------
function makeEnv(vars = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const env = Object.assign({ SHARED_SECRET: SECRET, _db: db }, vars);
  const exec = (q, args, how) => {
    const st = db.prepare(q);
    if (how === 'first') { const r = st.get(...args); return r === undefined ? null : r; }
    if (how === 'all') return { results: st.all(...args) };
    const r = st.run(...args);
    return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  };
  env.DB = {
    prepare(q) {
      return {
        _q: q, _args: [],
        bind(...a) { this._args = a; return this; },
        async run() { return exec(q, this._args, 'run'); },
        async first() { return exec(q, this._args, 'first'); },
        async all() { return exec(q, this._args, 'all'); },
      };
    },
    async batch(stmts) {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => exec(s._q, s._args, 'run'));
        db.exec('COMMIT');
        return out;
      } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
    },
  };
  return env;
}

const MIN = 60000, HOUR = 3600000, DAY = 86400000;

const B1 = 'b1@group.calendar.google.com';
const TA = 'a@group.calendar.google.com';
const TO = 'o@group.calendar.google.com';
const HASH = 'a'.repeat(64);

// ------------------------------------------------------------
// 締め切りの規則を**この試験のなかで独立に書き下す**
//   （compat.js の実装を import して比べると、同じ式を同じ式と比べるだけになる）
//   規則：開始の180分前まで。開始がJSTの12時より前の枠は「前日22時」とのどちらか早いほうまで。
// ------------------------------------------------------------
function expectedOpen(startMs, now) {
  let deadline = startMs - 180 * MIN;
  const p = jstParts(startMs);
  if (p.hours < 12) {
    const prev = jstMs(p.year, p.month, p.day, 22, 0) - DAY;
    deadline = Math.min(deadline, prev);
  }
  return now < deadline;
}

// JSTの壁時計で「n日後のh時」
function jstAt(nowMs, dayOffset, hour) {
  const p = jstParts(nowMs);
  return jstMs(p.year, p.month, p.day + dayOffset, hour, 0);
}

// ------------------------------------------------------------
// 世代・予定・トレーナー・写しを置く
// ------------------------------------------------------------
function calsJson(list) {
  const out = list.slice().sort((a, b) => (a.calendar_id < b.calendar_id ? -1 : 1));
  return JSON.stringify(out);
}
const DEFAULT_CALS = [
  { calendar_id: B1, role: CAL_ROLE.CAPACITY_B1, trainer_id: null },
  { calendar_id: TA, role: CAL_ROLE.TRAINER, trainer_id: 'A' },
  { calendar_id: TO, role: CAL_ROLE.TRAINER, trainer_id: 'O' },
];

function putTrainers(env, list) {
  for (const t of list) {
    env._db.prepare(
      'INSERT INTO trainers (trainer_id, name, calendar_id, role, active, hidden) VALUES (?, ?, ?, ?, 1, ?)'
    ).run(t.id, t.name, t.calendarId == null ? null : t.calendarId, 'trainer', t.hidden ? 1 : 0);
  }
}

function putGeneration(env, over = {}) {
  const now = over.now == null ? Date.now() : over.now;
  const r = env._db.prepare(
    `INSERT INTO calendar_snapshot
       (status, horizon_start, horizon_end, calendars, rule_version, flag_1f, content_hash,
        owner_window, built_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    over.status || 'ready',
    over.horizonStart, over.horizonEnd,
    over.calendars == null ? calsJson(DEFAULT_CALS) : over.calendars,
    over.ruleVersion == null ? 1 : over.ruleVersion,
    over.flag1f || 'off',
    HASH,
    over.ownerWindow === undefined ? null : over.ownerWindow,
    now, now
  );
  const gen = Number(r.lastInsertRowid);
  env._db.prepare('UPDATE calendar_active SET generation = ?, checked_at = ? WHERE id = 1')
    .run(over.activeGeneration === undefined ? gen : over.activeGeneration,
         over.checkedAt == null ? now : over.checkedAt);
  return gen;
}

let evSeq = 0;
function putEvent(env, gen, e) {
  env._db.prepare(
    `INSERT INTO calendar_events
       (generation, calendar_id, event_id, role, trainer_id, effect, reason, start_at, end_at, all_day)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
  ).run(gen, e.calendarId, e.eventId || ('e' + (++evSeq)), e.role, e.trainerId == null ? null : e.trainerId,
        e.effect, e.reason || 'shift', e.startAt, e.endAt);
}
const putShift = (env, gen, calId, tid, startAt, endAt) =>
  putEvent(env, gen, { calendarId: calId, role: CAL_ROLE.TRAINER, trainerId: tid,
                       effect: EV_KIND.SHIFT, reason: 'shift', startAt, endAt });

function putCache(env, trainerId, startList, computedAt, rules) {
  const slots = startList.map((ms) => ({
    startMs: ms, startISO: new Date(ms).toISOString(), endISO: new Date(ms + HOUR).toISOString(),
    trainerId, trainerName: 'cache', trialOk: true,
    date: '', dayOfWeek: '', startTime: '', endTime: '',
  }));
  env._db.prepare('INSERT OR REPLACE INTO slots_cache (trainer_id, payload, computed_at) VALUES (?, ?, ?)')
    .run(trainerId, JSON.stringify({ trainerId, slots, rules: rules || null }), computedAt);
}

const starts = (r) => (r.slots || []).map((s) => Number(s.startMs)).sort((a, b) => a - b);

// ============================================================
// 1. 固定枠の設定（ownerWindow）をD1に持つ
// ============================================================
{
  // --- 形の検証（純関数）---
  const n = _calsync.normalizeOwnerWindow;
  eq('★送られてこない（古いGAS）→ NULL＝制限なし', n(undefined), { json: null });
  eq('★null → NULL＝制限なし', n(null), { json: null });
  eq('正しい形を受ける', n({ 1: { from: 17, to: 24 }, 6: 'all' }).json,
     '{"1":{"from":17,"to":24},"6":"all"}');
  eq('曜日の順を固定する（同じ設定で世代を作り直さない）',
     n({ 6: 'all', 1: { from: 17, to: 24 } }).json, '{"1":{"from":17,"to":24},"6":"all"}');
  eq('GASの true は all に直して受ける', n({ 0: true }).json, '{"0":"all"}');
  eq('★全曜日 null は {}（＝1枠も出さない）。NULL（制限なし）にしない',
     n({ 0: null, 3: null }).json, '{}');
  eq('0時〜24時は通る', n({ 2: { from: 0, to: 24 } }).json, '{"2":{"from":0,"to":24}}');

  const bad = [
    ['配列', [1, 2]],
    ['文字列', 'all'],
    ['数値', 7],
    ['曜日が範囲外(7)', { 7: 'all' }],
    ['曜日が曜日でない', { mon: 'all' }],
    ['曜日が負', { '-1': 'all' }],
    ['fromが文字列', { 1: { from: '17', to: 24 } }],
    ['toが25', { 1: { from: 17, to: 25 } }],
    ['fromが-1', { 1: { from: -1, to: 24 } }],
    ['fromが小数', { 1: { from: 17.5, to: 24 } }],
    ['fromが無い', { 1: { to: 24 } }],
    ['値が数値', { 1: 17 }],
    ['値が配列', { 1: [17, 24] }],
    ['値が知らない文字列', { 1: 'always' }],
  ];
  let allRejected = true, which = [];
  for (const [label, v] of bad) {
    const r = n(v);
    if (r.code !== 'BAD_OWNER_WINDOW') { allRejected = false; which.push(label); }
  }
  ok('★壊れた値をすべて拒否する', allRejected, which.join(' / '));
}

// --- /calsync が受け取って保存し、readCalendar が返す ---
{
  const H_START = 1791100800000, H_END = 1793779200000;
  const CALS = [
    { calendarId: B1, role: 'capacity_b1' },
    { calendarId: TA, role: 'trainer', trainerId: 'A' },
    { calendarId: 'b@x', role: 'trainer', trainerId: 'B' },
    { calendarId: 'c@x', role: 'trainer', trainerId: 'C' },
  ];
  const mkEv = (o) => Object.assign({
    calendarId: TA, eventId: 'e1', role: 'trainer', trainerId: 'A',
    effect: 'shift', reason: 'shift',
    startAt: H_START + 36000000, endAt: H_START + 39600000, allDay: 0,
  }, o);
  const events = () => [
    mkEv({ calendarId: TA, eventId: 'sA', trainerId: 'A' }),
    mkEv({ calendarId: 'b@x', eventId: 'sB', trainerId: 'B' }),
    mkEv({ calendarId: 'c@x', eventId: 'sC', trainerId: 'C' }),
  ];
  const payload = (over = {}) => Object.assign({
    horizonStart: H_START, horizonEnd: H_END, ruleVersion: 1, flag1f: 'off',
    calendars: CALS, events: events(), contentHash: HASH, invalid: [],
  }, over);
  const send = async (env, body) => {
    const res = await handleCalSync(new Request('https://x/calsync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ingest-Secret': SECRET },
      body: JSON.stringify(body),
    }), env);
    return [res.status, await res.json()];
  };
  const stored = (env) => env._db.prepare(
    'SELECT owner_window AS w FROM calendar_snapshot WHERE generation = (SELECT generation FROM calendar_active WHERE id = 1)'
  ).get().w;

  {
    const env = makeEnv();
    const [st] = await send(env, payload());
    eq('ownerWindow を送らない押し出しも通る（古いGAS）', st, 200);
    eq('★送られなければ NULL（制限なし）', stored(env), null);
  }
  {
    const env = makeEnv();
    const [st] = await send(env, payload({ ownerWindow: { 1: { from: 17, to: 24 }, 6: 'all' } }));
    eq('ownerWindow を送ると通る', st, 200);
    eq('★そのまま保存される', stored(env), '{"1":{"from":17,"to":24},"6":"all"}');
  }
  {
    const env = makeEnv();
    const [st, b] = await send(env, payload({ ownerWindow: { 9: 'all' } }));
    eq('★壊れた ownerWindow は 400 で落とす', [st, b.code], [400, 'BAD_OWNER_WINDOW']);
    eq('★落ちた押し出しは世代を1つも作らない',
       env._db.prepare('SELECT COUNT(*) AS n FROM calendar_snapshot').get().n, 0);
  }
  {
    // ★設定だけ変えたとき（予定は同じ＝contentHash も同じ）に新しい世代が公開されること。
    //   比べていないと checked_at だけが進み、新しい設定が永久に反映されない。
    const env = makeEnv();
    await send(env, payload({ ownerWindow: { 1: 'all' } }));
    const gen1 = env._db.prepare('SELECT generation FROM calendar_active WHERE id = 1').get().generation;
    const [, same] = await send(env, payload({ ownerWindow: { 1: 'all' } }));
    eq('設定も予定も同じなら世代を増やさない', same.mode, 'unchanged');
    const [, changed] = await send(env, payload({ ownerWindow: { 1: { from: 17, to: 24 } } }));
    eq('★ownerWindow だけ変わったら公開し直す', changed.mode, 'published');
    ok('★新しい世代になっている', Number(changed.generation) > Number(gen1));
    eq('★新しい設定が入っている', stored(env), '{"1":{"from":17,"to":24}}');
  }
  {
    // 設定を外した（null に戻した）ときも反映されること
    const env = makeEnv();
    await send(env, payload({ ownerWindow: { 1: 'all' } }));
    const [, r] = await send(env, payload({ ownerWindow: null }));
    eq('★設定を外したら公開し直す', r.mode, 'published');
    eq('★NULL に戻る', stored(env), null);
  }

  // --- readCalendar が返す ---
  {
    const env = makeEnv();
    await send(env, payload({ ownerWindow: { 1: { from: 17, to: 24 }, 6: 'all' } }));
    const read = await readCalendar(env, {
      fromMs: H_START + 36000000, toMs: H_START + 39600000, ruleVersion: 1, flag1f: 'off',
      requiredCalendars: [{ calendarId: TA, role: 'trainer', trainerId: 'A' }],
      nowMs: env._db.prepare('SELECT checked_at AS c FROM calendar_active WHERE id = 1').get().c,
    });
    ok('readCalendar が使えると答える', read.usable === true, JSON.stringify(read.reason || ''));
    eq('★readCalendar が ownerWindow を返す', read.ownerWindow, { 1: { from: 17, to: 24 }, 6: 'all' });
    eq('読めたときは ownerWindowError が立たない', read.ownerWindowError, false);
  }
  {
    const env = makeEnv();
    await send(env, payload());
    const read = await readCalendar(env, {
      fromMs: H_START + 36000000, toMs: H_START + 39600000, ruleVersion: 1, flag1f: 'off',
      requiredCalendars: [{ calendarId: TA, role: 'trainer', trainerId: 'A' }],
      nowMs: env._db.prepare('SELECT checked_at AS c FROM calendar_active WHERE id = 1').get().c,
    });
    eq('★設定が無ければ ownerWindow は null（制限なし）', read.ownerWindow, null);
  }
  // 壊れた値がD1に残っていた場合（直接書き換えられた・古い形式）
  {
    const p = _calread.parseOwnerWindow;
    eq('NULL は制限なし', p(null), { value: null, error: false });
    eq('JSON は読む', p('{"1":"all"}'), { value: { 1: 'all' }, error: false });
    eq('★読めない値を null（制限なし）に倒さない', p('{oops'), { value: null, error: true });
    eq('★配列も読めない扱い', p('[1,2]'), { value: null, error: true });
    eq('★空文字も読めない扱い', p(''), { value: null, error: true });
  }
}

// ============================================================
// 2. 空き枠を配る経路（三段構え）
// ============================================================
//
//   出勤を3つ置く。どの枠が出るかは実時刻で決まるので、期待値も実時刻から組む。
//     shift1 … ちょうど「いまから180分後」に始まる2時間 → 枠は T と T+60分
//               ★T は**ちょうど締め切り**（now === T-180分）なので、必ず出ない
//     shift2 … 「前日22時」の規則が効く側の午前（10:00〜12:00 JST）→ 枠は 10:00 と 11:00
//     shift3 … 2日後の午後（14:00〜16:00 JST）→ 枠は 14:00 と 15:00（必ず出る）
function makeWorld(vars = {}, opts = {}) {
  const env = makeEnv(vars);
  const now = Date.now();
  const { fromMs, toMs } = _slots.slotsRange(now);

  putTrainers(env, [
    { id: 'A', name: 'トレーナーA', calendarId: TA, hidden: 0 },
    { id: 'O', name: 'オーナー', calendarId: TO, hidden: 1 },
  ]);

  const gen = putGeneration(env, Object.assign({
    horizonStart: fromMs, horizonEnd: toMs, now,
  }, opts.gen || {}));

  // ちょうど締め切りの枠を作る（分の端数は落とす。枠の刻みは60分なので先頭だけ見る）
  const T = now + 180 * MIN;
  const shift1 = [T, T + 2 * HOUR];
  // 「前日22時」の規則が効きうる午前。今日の10時がもう過ぎていれば翌日にする。
  const morningDay = now < jstAt(now, 0, 10) ? 0 : 1;
  const shift2 = [jstAt(now, morningDay, 10), jstAt(now, morningDay, 12)];
  const shift3 = [jstAt(now, 2, 14), jstAt(now, 2, 16)];

  const candidates = [T, T + HOUR, shift2[0], shift2[0] + HOUR, shift3[0], shift3[0] + HOUR];

  for (const [s, e] of [shift1, shift2, shift3]) {
    putShift(env, gen, TA, 'A', s, e);
    putShift(env, gen, TO, 'O', s, e);
  }

  return { env, now, gen, fromMs, toMs, T, candidates, shift2, shift3 };
}

// --- ③ 段階導入：既定では①を使わない ---
{
  const w = makeWorld();
  putCache(w.env, 'A', [w.shift3[0]], w.now);

  const off = await routeSlots({ body: { trainerId: 'A' }, env: w.env, who: {} });
  eq('★既定では①を使わない（source は cache）', off.source, SLOT_SOURCE.CACHE);
  eq('★理由は off（段階導入）', off.fallbackReason, SLOT_FALLBACK.OFF);

  const on = await routeSlots({ body: { trainerId: 'A', useCalendar: true }, env: w.env, who: {} });
  eq('★body.useCalendar:true で①を使う', on.source, SLOT_SOURCE.CALENDAR);
  ok('★①では写しに無い枠まで出る', starts(on).length > starts(off).length,
     `calendar=${starts(on).length} cache=${starts(off).length}`);
  eq('①のときは fallbackReason を付けない', on.fallbackReason, undefined);
}
{
  const w = makeWorld({ SLOTS_FROM_CALENDAR: 'on' });
  putCache(w.env, 'A', [w.shift3[0]], w.now);
  const r = await routeSlots({ body: { trainerId: 'A' }, env: w.env, who: {} });
  eq('★環境変数 on で全員①になる', r.source, SLOT_SOURCE.CALENDAR);
}
{
  const w = makeWorld({ SLOTS_FROM_CALENDAR: 'off' });
  putCache(w.env, 'A', [w.shift3[0]], w.now);
  const r = await routeSlots({ body: { trainerId: 'A', useCalendar: true }, env: w.env, who: {} });
  eq('★環境変数 off は body より強い（止めるための一行）', r.source, SLOT_SOURCE.CACHE);
  eq('止めたときの理由も off', r.fallbackReason, SLOT_FALLBACK.OFF);
}
{
  const u = _slots.useCalendarPath;
  eq('未設定＋指定なし → 使わない', u({}, {}), false);
  eq('未設定＋useCalendar:true → 使う', u({ useCalendar: true }, {}), true);
  eq('useCalendar は true 以外を受けない', u({ useCalendar: 'true' }, {}), false);
  eq('useCalendar:1 も受けない', u({ useCalendar: 1 }, {}), false);
}

// --- ①が使えるときの中身・戻り値の形 ---
{
  const w = makeWorld();
  putCache(w.env, 'A', [w.shift3[0]], w.now);
  const r = await routeSlots({ body: { trainerId: 'A', useCalendar: true }, env: w.env, who: {} });

  eq('★既存の戻り値の形が壊れていない（trainerId）', r.trainerId, 'A');
  ok('★slots がある', Array.isArray(r.slots));
  ok('★computedAt がある（世代を確認した時刻）', typeof r.computedAt === 'number');
  ok('★ageMs がある', typeof r.ageMs === 'number' && r.ageMs >= 0);
  eq('★①のときは stale を立てない', r.stale, false);
  ok('世代を返す', typeof r.generation === 'number');

  const s0 = r.slots[0];
  const keys = ['startMs', 'startISO', 'endISO', 'date', 'dayOfWeek', 'startTime', 'endTime',
                'trainerId', 'trainerName', 'trialOk'];
  eq('★画面が読む項目が全部ある', keys.filter((k) => !(k in s0)), []);
  eq('トレーナー名はD1の名簿から入る', s0.trainerName, 'トレーナーA');

  // 期待する枠：候補のうち「未来」かつ「締め切り前」のもの
  const want = w.candidates.filter((ms) => ms > w.now && expectedOpen(ms, w.now)).sort((a, b) => a - b);
  eq('★①が出す枠が、締め切りの規則どおり', starts(r), want);
  ok('★ちょうど180分前の枠は出ない', !starts(r).includes(w.T));
  ok('2日後の午後の枠は出る', starts(r).includes(w.shift3[0]));
}

// --- ★①と②で同じ枠が出る（経路で表示可否が変わらない）---
{
  const w = makeWorld();
  // GASが同じ候補を写しに入れた状態を作る
  putCache(w.env, 'A', w.candidates, w.now);
  const a = await routeSlots({ body: { trainerId: 'A', useCalendar: true }, env: w.env, who: {} });
  const b = await routeSlots({ body: { trainerId: 'A' }, env: w.env, who: {} });
  eq('①と②で経路が違う', [a.source, b.source], [SLOT_SOURCE.CALENDAR, SLOT_SOURCE.CACHE]);
  eq('★★締め切りの判定が経路で変わらない（同じ枠の集合）', starts(a), starts(b));
  ok('★締め切りを過ぎた枠が②でも出ない', !starts(b).includes(w.T));
  ok('★返した枠はすべて締め切り前', starts(a).every((ms) => expectedOpen(ms, w.now)));
  ok('★返した枠はすべて未来', starts(a).every((ms) => ms > w.now));
}

// --- ★「前日◯時」の規則が①でも効く（実時刻に依存しない形で固定する）---
//
//   実時刻で試験すると、「前日22時」が効く場面（22時〜翌10時）にしか当たらない。
//   そこで**締め切りの設定そのもの**を動かして、どの時刻に実行しても必ず効く形にする。
//   設定はGASが写し（slots_cache.payload.rules）に入れてくるものを使う
//   ＝①も②も同じ cfg で判定していることが、これで同時に固定される。
//
//   枠は「翌日の6時と7時」。
//     morningUntilHour = 7 … 6時は午前枠 → 締め切りは「前日0時」＝すでに過ぎている → 出ない
//                            7時は午前枠でない（7 < 7 は偽）→ 締め切りは開始の180分前 → 出る
//     morningUntilHour = 6 … どちらも午前枠でない → 両方出る
//   ★prevDeadlineHour = 0 を使う理由：「前日0時」はいつ実行しても必ず過去。
//     実時刻に左右されずに「前日の締め切りが効いた」ことだけを見られる。
{
  const mkWorld = (rules) => {
    const env = makeEnv();
    const now = Date.now();
    const { fromMs, toMs } = _slots.slotsRange(now);
    putTrainers(env, [{ id: 'A', name: 'トレーナーA', calendarId: TA, hidden: 0 }]);
    const gen = putGeneration(env, { horizonStart: fromMs, horizonEnd: toMs, now });
    const s = jstAt(now, 1, 6);                       // 翌日 06:00 JST
    putShift(env, gen, TA, 'A', s, jstAt(now, 1, 8)); // 〜08:00 → 枠は 06:00 と 07:00
    putCache(env, 'A', [s, s + HOUR], now, rules);
    return { env, s };
  };
  const cfgOn = { leadMinutes: 180, morningUntilHour: 7, prevDeadlineHour: 0 };
  const cfgOff = { leadMinutes: 180, morningUntilHour: 6, prevDeadlineHour: 0 };

  {
    const w = mkWorld(cfgOn);
    const a = await routeSlots({ body: { trainerId: 'A', useCalendar: true }, env: w.env, who: {} });
    const b = await routeSlots({ body: { trainerId: 'A' }, env: w.env, who: {} });
    eq('★「前日◯時」を過ぎた午前枠が①で出ない', starts(a), [w.s + HOUR]);
    eq('★「前日◯時」を過ぎた午前枠が②でも出ない', starts(b), [w.s + HOUR]);
    eq('★①の締め切りの設定が写しの rules を使っている', starts(a), starts(b));
  }
  {
    const w = mkWorld(cfgOff);
    const a = await routeSlots({ body: { trainerId: 'A', useCalendar: true }, env: w.env, who: {} });
    const b = await routeSlots({ body: { trainerId: 'A' }, env: w.env, who: {} });
    eq('★午前枠でなければ①で出る（境界は「より小さい」）', starts(a), [w.s, w.s + HOUR]);
    eq('★②でも同じ', starts(b), [w.s, w.s + HOUR]);
  }
}

// --- ★excludeStartMs（予約変更のとき自分の枠を残す）が①で効く ---
{
  const w = makeWorld();
  putCache(w.env, 'A', w.candidates, w.now);
  const without = await routeSlots({ body: { trainerId: 'A', useCalendar: true }, env: w.env, who: {} });
  ok('前提：ちょうど締め切りの枠は出ていない', !starts(without).includes(w.T));

  const withEx = await routeSlots({
    body: { trainerId: 'A', useCalendar: true, excludeStartMs: w.T }, env: w.env, who: {},
  });
  ok('★①でも excludeStartMs の枠は残る', starts(withEx).includes(w.T),
     JSON.stringify(starts(withEx)));
  const cacheEx = await routeSlots({
    body: { trainerId: 'A', excludeStartMs: w.T }, env: w.env, who: {},
  });
  eq('★②と同じ結果になる', starts(withEx), starts(cacheEx));
}

// --- ★trainerId で絞る ---
{
  const w = makeWorld();
  putCache(w.env, 'A', w.candidates, w.now);
  putCache(w.env, 'O', w.candidates, w.now);
  const a = await routeSlots({ body: { trainerId: 'A', useCalendar: true }, env: w.env, who: {} });
  ok('★Aの枠だけ返る', a.slots.every((s) => s.trainerId === 'A') && a.slots.length > 0);
  const o = await routeSlots({ body: { trainerId: 'O', useCalendar: true }, env: w.env, who: {} });
  ok('★Oの枠だけ返る', o.slots.every((s) => s.trainerId === 'O') && o.slots.length > 0);
  const viaWho = await routeSlots({ body: { useCalendar: true }, env: w.env, who: { trainerId: 'A' } });
  eq('body に無ければ who.trainerId を使う（従来どおり）', viaWho.trainerId, 'A');
  const none = await routeSlots({ body: {}, env: w.env, who: {} });
  eq('トレーナーが決まらなければ BAD_REQUEST（従来どおり）', [none.code, none.slots], ['BAD_REQUEST', []]);
}

// --- ★hidden なトレーナーの枠が ownerWindow で絞られる ---
{
  // 設定が無いとき＝絞られない
  const w0 = makeWorld();
  putCache(w0.env, 'O', [], w0.now);
  const all = await routeSlots({ body: { trainerId: 'O', useCalendar: true }, env: w0.env, who: {} });
  eq('①で動いている', all.source, SLOT_SOURCE.CALENDAR);
  ok('★設定が無ければ hidden なトレーナーも絞られない', starts(all).length > 0);

  // 2日後（shift3＝14:00〜16:00）の曜日だけ 15時〜 に絞る
  const dow = String(jstParts(w0.shift3[0]).dayOfWeek);
  const win = JSON.stringify({ [dow]: { from: 15, to: 24 } });
  const w1 = makeWorld({}, { gen: { ownerWindow: win } });
  putCache(w1.env, 'O', [], w1.now);
  const narrowed = await routeSlots({ body: { trainerId: 'O', useCalendar: true }, env: w1.env, who: {} });
  eq('★設定した曜日・時間帯の枠だけになる', starts(narrowed), [w1.shift3[0] + HOUR]);
  ok('★14時の枠（設定より前）は出ない', !starts(narrowed).includes(w1.shift3[0]));

  // 同じ世代でも hidden でないトレーナーは絞られない
  const notHidden = await routeSlots({ body: { trainerId: 'A', useCalendar: true }, env: w1.env, who: {} });
  ok('★hidden でないトレーナーは ownerWindow で絞られない',
     starts(notHidden).includes(w1.shift3[0]), JSON.stringify(starts(notHidden)));

  // '{}'＝どの曜日にもルールが無い → 1枠も出さない（NULL＝制限なしと区別される）
  const w2 = makeWorld({}, { gen: { ownerWindow: '{}' } });
  putCache(w2.env, 'O', [], w2.now);
  const empty = await routeSlots({ body: { trainerId: 'O', useCalendar: true }, env: w2.env, who: {} });
  eq('★{} は「1枠も出さない」（NULL と意味が違う）', starts(empty), []);

  // 'all' はその曜日を丸ごと通す
  const w3 = makeWorld({}, { gen: { ownerWindow: JSON.stringify({ [dow]: 'all' }) } });
  putCache(w3.env, 'O', [], w3.now);
  const allDay = await routeSlots({ body: { trainerId: 'O', useCalendar: true }, env: w3.env, who: {} });
  eq("★'all' はその曜日を丸ごと通す", starts(allDay),
     [w3.shift3[0], w3.shift3[0] + HOUR]);
}

// --- ★①が使えない理由ごとに正しく退避する ---
{
  const cases = [
    ['stale',     { checkedAt: Date.now() - FRESH_MS - 1000 },                 SLOT_FALLBACK.STALE],
    ['rule',      { ruleVersion: 2 },                                          SLOT_FALLBACK.RULE],
    ['flag',      { flag1f: 'on' },                                            SLOT_FALLBACK.FLAG],
    ['missing',   { activeGeneration: null },                                  SLOT_FALLBACK.MISSING],
    ['missing(status)', { status: 'building' },                                SLOT_FALLBACK.MISSING],
  ];
  for (const [label, over, want] of cases) {
    const w = makeWorld({}, { gen: over });
    putCache(w.env, 'A', [w.shift3[0]], w.now);
    const r = await routeSlots({ body: { trainerId: 'A', useCalendar: true }, env: w.env, who: {} });
    eq(`★${label} のとき②へ退避する`, [r.source, r.fallbackReason], [SLOT_SOURCE.CACHE, want]);
    eq(`★${label} でも枠は返る（顧客に0件を見せない）`, starts(r), [w.shift3[0]]);
  }
  // horizon は世代の地平を要求より狭くする
  {
    const now = Date.now();
    const { toMs } = _slots.slotsRange(now);
    const w = makeWorld({}, { gen: { horizonEnd: toMs - 1 } });
    putCache(w.env, 'A', [w.shift3[0]], w.now);
    const r = await routeSlots({ body: { trainerId: 'A', useCalendar: true }, env: w.env, who: {} });
    eq('★horizon のとき②へ退避する', [r.source, r.fallbackReason],
       [SLOT_SOURCE.CACHE, SLOT_FALLBACK.HORIZON]);
  }
  // calendars は世代の構成からトレーナーのカレンダーを外す
  {
    const w = makeWorld({}, { gen: { calendars: calsJson([
      { calendar_id: B1, role: CAL_ROLE.CAPACITY_B1, trainer_id: null },
      { calendar_id: TO, role: CAL_ROLE.TRAINER, trainer_id: 'O' },
    ]) } });
    putCache(w.env, 'A', [w.shift3[0]], w.now);
    const r = await routeSlots({ body: { trainerId: 'A', useCalendar: true }, env: w.env, who: {} });
    eq('★calendars のとき②へ退避する', [r.source, r.fallbackReason],
       [SLOT_SOURCE.CACHE, SLOT_FALLBACK.CALENDARS]);
  }
  // 担当が入れ替わっている構成も通さない
  {
    const w = makeWorld({}, { gen: { calendars: calsJson([
      { calendar_id: B1, role: CAL_ROLE.CAPACITY_B1, trainer_id: null },
      { calendar_id: TA, role: CAL_ROLE.TRAINER, trainer_id: 'O' },
      { calendar_id: TO, role: CAL_ROLE.TRAINER, trainer_id: 'A' },
    ]) } });
    putCache(w.env, 'A', [w.shift3[0]], w.now);
    const r = await routeSlots({ body: { trainerId: 'A', useCalendar: true }, env: w.env, who: {} });
    eq('★担当の入れ替わりも通さない', r.fallbackReason, SLOT_FALLBACK.CALENDARS);
  }
  // トレーナーの行が無い／カレンダーIDが無い
  {
    const w = makeWorld();
    putCache(w.env, 'Z', [w.shift3[0]], w.now);
    const r = await routeSlots({ body: { trainerId: 'Z', useCalendar: true }, env: w.env, who: {} });
    eq('★名簿に無いトレーナーは①を使わない', [r.source, r.fallbackReason],
       [SLOT_SOURCE.CACHE, SLOT_FALLBACK.MISSING]);
  }
  {
    const w = makeWorld();
    putTrainers(w.env, [{ id: 'N', name: 'カレンダー未設定', calendarId: '', hidden: 0 }]);
    putCache(w.env, 'N', [w.shift3[0]], w.now);
    const r = await routeSlots({ body: { trainerId: 'N', useCalendar: true }, env: w.env, who: {} });
    eq('★カレンダーIDが無いトレーナーは①を使わない', [r.source, r.fallbackReason],
       [SLOT_SOURCE.CACHE, SLOT_FALLBACK.CALENDARS]);
  }
  // B1 を環境変数で指定したとき、B1 を欠いた世代を通さない
  {
    const w = makeWorld({ CAL_B1_CALENDAR_ID: B1 }, { gen: { calendars: calsJson([
      { calendar_id: TA, role: CAL_ROLE.TRAINER, trainer_id: 'A' },
      { calendar_id: TO, role: CAL_ROLE.TRAINER, trainer_id: 'O' },
    ]) } });
    putCache(w.env, 'A', [w.shift3[0]], w.now);
    const r = await routeSlots({ body: { trainerId: 'A', useCalendar: true }, env: w.env, who: {} });
    eq('★B1を欠いた世代を通さない（部屋の埋まりを見落とさない）', r.fallbackReason,
       SLOT_FALLBACK.CALENDARS);
  }
  // 固定枠の設定が読めない世代は①を使わない（null＝制限なしに倒さない）
  {
    const w = makeWorld({}, { gen: { ownerWindow: '{oops' } });
    putCache(w.env, 'O', [w.shift3[0]], w.now);
    const r = await routeSlots({ body: { trainerId: 'O', useCalendar: true }, env: w.env, who: {} });
    eq('★ownerWindow が読めない世代は①を使わない', [r.source, r.fallbackReason],
       [SLOT_SOURCE.CACHE, SLOT_FALLBACK.RULE]);
  }
}

// --- ★③ 写しも無い／古い：0件と「分からない」を区別する ---
{
  const w = makeWorld();   // 写しを置かない
  const r = await routeSlots({ body: { trainerId: 'A' }, env: w.env, who: {} });
  eq('★②が無いとき stale:true が立つ', r.stale, true);
  eq('★経路は none（答えられていない）', r.source, SLOT_SOURCE.NONE);
  eq('★枠は空', r.slots, []);
  eq('★computedAt は null', r.computedAt, null);
  eq('理由も返る', r.fallbackReason, SLOT_FALLBACK.OFF);
}
{
  // ①も使えず②も無い → stale:true ＋ ①の理由
  const w = makeWorld({}, { gen: { checkedAt: Date.now() - FRESH_MS - 1000 } });
  const r = await routeSlots({ body: { trainerId: 'A', useCalendar: true }, env: w.env, who: {} });
  eq('★①も②も無いとき stale:true ＋ 理由', [r.stale, r.source, r.fallbackReason],
     [true, SLOT_SOURCE.NONE, SLOT_FALLBACK.STALE]);
}
{
  // ★①が使えて、本当に空きが0件のとき。**stale を立てない。**
  //   ここで stale を立てると「分からない」と区別できず、無意味にGASへ落ちる。
  const env = makeEnv();
  const now = Date.now();
  const { fromMs, toMs } = _slots.slotsRange(now);
  putTrainers(env, [{ id: 'A', name: 'トレーナーA', calendarId: TA, hidden: 0 }]);
  putGeneration(env, { horizonStart: fromMs, horizonEnd: toMs, now });   // 予定を1件も入れない
  putCache(env, 'A', [], now);
  const r = await routeSlots({ body: { trainerId: 'A', useCalendar: true }, env, who: {} });
  eq('★①で本当に0件のときは stale を立てない', [r.source, r.slots, r.stale],
     [SLOT_SOURCE.CALENDAR, [], false]);
}
{
  // 「本当に0件」と「分からない」の区別
  const w = makeWorld();
  putCache(w.env, 'A', [], w.now);       // 写しはあるが枠は0件
  const r = await routeSlots({ body: { trainerId: 'A' }, env: w.env, who: {} });
  eq('★本当に0件のときは stale を立てない', [r.slots, r.stale, r.source],
     [[], false, SLOT_SOURCE.CACHE]);
}
{
  // 写しが古い＝②も信用できない。枠は返すが stale を立てる（③の判断材料）
  const w = makeWorld();
  putCache(w.env, 'A', [w.shift3[0]], w.now - CACHE_STALE_MS - 1000);
  const r = await routeSlots({ body: { trainerId: 'A' }, env: w.env, who: {} });
  eq('★写しが古いと stale が立つ', r.stale, true);
  eq('★★それでも枠は落とさない（0件に見せない）', starts(r), [w.shift3[0]]);
  ok('ageMs が返る', r.ageMs > CACHE_STALE_MS);
}
{
  // 写しが壊れている（JSONとして読めない）→ 「分からない」
  const w = makeWorld();
  w.env._db.prepare('INSERT INTO slots_cache (trainer_id, payload, computed_at) VALUES (?, ?, ?)')
    .run('A', '{broken', w.now);
  const r = await routeSlots({ body: { trainerId: 'A' }, env: w.env, who: {} });
  eq('★読めない写しは「分からない」扱い（従来どおり stale:true・0件）',
     [r.slots, r.stale, r.source], [[], true, SLOT_SOURCE.NONE]);
}

// --- ①の計算が例外になっても②を止めない ---
{
  const w = makeWorld();
  putCache(w.env, 'A', [w.shift3[0]], w.now);
  const orig = w.env.DB.prepare.bind(w.env.DB);
  w.env.DB.prepare = (q) => {
    if (/FROM calendar_active/.test(q)) throw new Error('SIMULATED');
    return orig(q);
  };
  const r = await routeSlots({ body: { trainerId: 'A', useCalendar: true }, env: w.env, who: {} });
  eq('★①が例外になっても②から返す', [r.source, r.fallbackReason],
     [SLOT_SOURCE.CACHE, SLOT_FALLBACK.ERROR]);
  eq('★枠は返る', starts(r), [w.shift3[0]]);
}

// ============================================================
// 3. ①で要求する範囲が、GASの地平と同じ式であること
// ============================================================
{
  const r = _slots.slotsRange;
  // 2026-10-10 12:00 JST → 今日00:00 〜 10月末23:59:59
  const a = r(jstMs(2026, 10, 10, 12, 0));
  eq('範囲の始まりは今日の00:00（JST）', a.fromMs, jstMs(2026, 10, 10, 0, 0));
  eq('範囲の終わりは今月末の23:59:59（JST）', a.toMs, jstMs(2026, 10, 31, 23, 59) + 59000);
  // 25日以降は翌月末まで（翌月解放）
  const b = r(jstMs(2026, 10, 25, 9, 0));
  eq('★25日になったら翌月末まで伸びる', b.toMs, jstMs(2026, 11, 30, 23, 59) + 59000);
  const c = r(jstMs(2026, 10, 24, 23, 59));
  eq('★24日はまだ今月末まで', c.toMs, jstMs(2026, 10, 31, 23, 59) + 59000);
  // 年をまたぐ
  const d = r(jstMs(2026, 12, 26, 9, 0));
  eq('★年をまたいでも崩れない', d.toMs, jstMs(2027, 1, 31, 23, 59) + 59000);
  const e = r(jstMs(2027, 2, 1, 9, 0));
  eq('うるう年でない2月は28日まで', e.toMs, jstMs(2027, 2, 28, 23, 59) + 59000);
  const f = r(jstMs(2028, 2, 1, 9, 0));
  eq('うるう年の2月は29日まで', f.toMs, jstMs(2028, 2, 29, 23, 59) + 59000);
  // JSTの日付で区切る（UTCで切ると日本の朝9時までが前日になる）
  const g = r(jstMs(2026, 10, 10, 0, 30));
  eq('★JSTの00:30でも「今日」は10日', g.fromMs, jstMs(2026, 10, 10, 0, 0));
}

// 規則の版・1Fフラグの読み取り
{
  eq('規則の版は既定1', _slots.ruleVersionOf({}), 1);
  eq('環境変数で上げられる', _slots.ruleVersionOf({ CAL_RULE_VERSION: '3' }), 3);
  eq('★壊れた値は既定へ倒す', _slots.ruleVersionOf({ CAL_RULE_VERSION: 'x' }), 1);
  eq('★0や負は使わない（readCalendar が throw する）', _slots.ruleVersionOf({ CAL_RULE_VERSION: '0' }), 1);
  eq('1Fフラグは既定 off', _slots.flag1fOf({}), 'off');
  eq('on を受ける', _slots.flag1fOf({ CAL_FLAG_1F: 'on' }), 'on');
  eq('★知らない値は off（GASの既定と同じ）', _slots.flag1fOf({ CAL_FLAG_1F: 'ON' }), 'off');
}

// ============================================================
// ★壊れた写しで「0件」を顧客に見せない（2026-10-03）
//
//   payload が "[]" のとき、配列も typeof では 'object' なので素通りし、
//   raw.slots が undefined → 空配列になって、新しい computed_at とあわせて
//   **「空きがありません」として顧客に出る**経路があった。
//   0件と「分からない」を同じ見た目にしない。
// ============================================================
{
  const putRaw = (env, payload) => {
    env._db.prepare('INSERT OR REPLACE INTO slots_cache (trainer_id, payload, computed_at) VALUES (?, ?, ?)')
      .run('B', payload, Date.now());
  };
  for (const [name, payload] of [
    ['配列', '[]'],
    ['要素の入った配列', '[{"startMs":1}]'],
    ['数値', '5'],
    ['文字列', '"x"'],
    ['null', 'null'],
    ['真偽値', 'true'],
    ['壊れたJSON', '{'],
  ]) {
    const env = makeEnv();
    putRaw(env, payload);
    const r = await routeSlots({ body: { trainerId: 'B' }, env, who: {} });
    eq('★壊れた写し（' + name + '）は「分からない」として退避する',
       [r.source, r.stale], ['none', true]);
  }
  // 正しい写しは従来どおり答える（上の検査が厳しすぎないこと）
  {
    const env = makeEnv();
    putCache(env, 'B', [], Date.now());
    const r = await routeSlots({ body: { trainerId: 'B' }, env, who: {} });
    eq('★中身が空の正しい写しは「0件」と答える', [r.source, r.stale], ['cache', false]);
  }
}

console.log(`\n${fail === 0 ? '✅' : '❌'} slots-route: ${pass} 件合格 / ${fail} 件不合格`);
process.exit(fail === 0 ? 0 : 1);
