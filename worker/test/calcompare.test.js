// ①の突き合わせ（POST /calcompare ／ GET /calcompare/status）の検証
//   設計：ops/design/01-calendar-to-d1.md §12（比較の記録）／§11
//
//   ここで固定したいのは、①の完了判断そのものを誤らせる6つ：
//     ① 合言葉のない経路を作らない
//     ② 一致したら matched=1、食い違ったら matched=0 で**食い違った時間帯が diff に入る**
//     ③ D1が使えないときは「不一致」ではなく **matched=NULL（比較できなかった）**
//        （混ぜると、D1が7分古いだけで「GASと違う」に見えて永久に完了しない。
//          逆に、使えない状態を一致と数えると**間違った状態で切り替えてしまう**）
//     ④ diff に氏名・タイトルが入らない。長さに上限が効く
//     ⑤ **既存のテーブルを1行も変えない**（compare_log 以外に書かない）
//     ⑥ 「連続7日間」の数え方（1日でも不一致／日付が飛んだら途切れる／当日は数えない）
//
//   D1の身代わりは node:sqlite（実物のSQLite）。schema.sql をそのまま流す。
//   世代は handleCalSync に実際に押し出して作る（手でINSERTすると、
//   公開の作法が違っていても気づけない）。
//
//   実行: node worker/test/calcompare.test.js（node:sqlite を使うので Node 22.5 以上）

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { handleCalCompare, summarizeDays, jstDayKey, compareSlots, _forTest }
  from '../src/routes/calcompare.js';
import { handleCalSync, _forTest as _calsync } from '../src/routes/calsync.js';
import { slotsFromEvents, jstParts, jstMs, jstDateStr, jstTimeStr } from '../src/lib/calslots.js';

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
// D1の身代わり（実物のSQLite）。calsync.test.js と同じ作り
// ------------------------------------------------------------
function makeEnv(opts = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const env = {
    SHARED_SECRET: opts.secret === undefined ? SECRET : opts.secret,
    _db: db, _sql: [],
    _failOn: opts.failOn || null,
    _failAfter: opts.failAfter == null ? 0 : opts.failAfter,
  };
  const exec = (q, args, how) => {
    env._sql.push({ q, args });
    if (env._failOn && env._failOn.test(q)) {
      if (env._failAfter > 0) env._failAfter--;
      else throw new Error('SIMULATED_DB_FAILURE');
    }
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

const rows = (env, q, ...a) => env._db.prepare(q).all(...a).map((r) => Object.assign({}, r));
const one = (env, q, ...a) => { const r = env._db.prepare(q).get(...a); return r === undefined ? null : Object.assign({}, r); };
const logs = (env) => rows(env, 'SELECT at, generation, trainer_id, kind, gas_count, d1_count, diff, matched FROM compare_log ORDER BY trainer_id, id');
const logCount = (env) => one(env, 'SELECT COUNT(*) AS n FROM compare_log').n;

// 既存のテーブルの指紋（比較の前後で1文字も変わってはいけない）
function fingerprint(env) {
  return JSON.stringify({
    active: rows(env, 'SELECT * FROM calendar_active ORDER BY id'),
    snap: rows(env, 'SELECT * FROM calendar_snapshot ORDER BY generation'),
    events: rows(env, 'SELECT * FROM calendar_events ORDER BY generation, calendar_id, event_id'),
  });
}
// compare_log 以外に書いた文が1つでもあれば落とす
function writesOutsideCompareLog(env) {
  return env._sql
    .map((s) => String(s.q).trim())
    .filter((q) => /^(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE)/i.test(q))
    .filter((q) => !/compare_log/i.test(q));
}

// ------------------------------------------------------------
// 試験データ
//   ★日付は「いまから5日後」で作る。固定の日付にすると、その日を過ぎた瞬間に
//     締め切り（開始180分前）で枠が0件になり、試験が意味を失う。
// ------------------------------------------------------------
const DAY = 86400000;
const NOW = Date.now();
const TODAY0 = (() => { const p = jstParts(NOW); return jstMs(p.year, p.month, p.day, 0, 0); })();
const D0 = TODAY0 + 5 * DAY;                    // 比較する日（JSTの00:00）
const H_START = TODAY0;                         // 地平
const H_END = TODAY0 + 40 * DAY;
const at = (h, m) => D0 + h * 3600000 + (m || 0) * 60000;

const B1 = 'b1@group.calendar.google.com';
const TA = 'a@group.calendar.google.com';
const TB = 'b@group.calendar.google.com';
const TC = 'c@group.calendar.google.com';

const CALS = [
  { calendarId: B1, role: 'capacity_b1' },
  { calendarId: TA, role: 'trainer', trainerId: 'A' },
  { calendarId: TB, role: 'trainer', trainerId: 'B' },
  { calendarId: TC, role: 'trainer', trainerId: 'C' },
];
const REQUIRED = [
  { calendarId: B1, role: 'capacity_b1' },
  { calendarId: TA, role: 'trainer', trainerId: 'A' },
  { calendarId: TB, role: 'trainer', trainerId: 'B' },
  { calendarId: TC, role: 'trainer', trainerId: 'C' },
];
// ★氏名を入れておく。これが compare_log に1文字も出ないことを検査する
const NAME_A = '田中 太郎（氏名が漏れていないかの目印）';
const TRAINERS = [
  { id: 'A', name: NAME_A, hidden: false },
  { id: 'B', name: '鈴木 次郎', hidden: false },
  { id: 'C', name: '沖 三郎', hidden: false },
];

// 押し出す予定（calsync が受ける形。readCalendar が返す形とキー名が同じ）
const SHIFT_A = { calendarId: TA, eventId: 'sA', role: 'trainer', trainerId: 'A',
                  effect: 'shift', reason: 'shift', startAt: at(7), endAt: at(23), allDay: 0 };
const SHIFT_B = { calendarId: TB, eventId: 'sB', role: 'trainer', trainerId: 'B',
                  effect: 'shift', reason: 'shift', startAt: at(9), endAt: at(18), allDay: 0 };
// Cの出勤は比較する日の外（翌日）。範囲内の枠は0件になる＝「0件どうしの一致」も記録される
const SHIFT_C = { calendarId: TC, eventId: 'sC', role: 'trainer', trainerId: 'C',
                  effect: 'shift', reason: 'shift', startAt: at(7) + DAY, endAt: at(18) + DAY, allDay: 0 };
const RESV_A = { calendarId: TA, eventId: 'rA', role: 'trainer', trainerId: 'A',
                 effect: 'busy', reason: 'reserved', startAt: at(12), endAt: at(13), allDay: 0 };
const ROOM = { calendarId: B1, eventId: 'room1', role: 'capacity_b1', trainerId: null,
               effect: 'room_busy', reason: 'room', startAt: at(15), endAt: at(16), allDay: 0 };
// B1の [消化]（effect=ignore）。readCalendar が落とすので、どちらの枠にも影響しない
const CONSUMED = { calendarId: B1, eventId: 'c1', role: 'capacity_b1', trainerId: null,
                   effect: 'ignore', reason: 'consumed', startAt: at(19), endAt: at(20), allDay: 0 };

const EVENTS = [SHIFT_A, SHIFT_B, SHIFT_C, RESV_A, ROOM, CONSUMED];

function syncPayload(over = {}) {
  return Object.assign({
    horizonStart: H_START, horizonEnd: H_END, ruleVersion: 1, flag1f: 'off',
    calendars: CALS, events: EVENTS, contentHash: 'a'.repeat(64), invalid: [],
  }, over);
}

// 世代を1つ公開した env を作る
async function seeded(opts = {}) {
  // わざとの失敗は押し出しが済んでから効かせる（世代が無いと比較に入れない）
  const env = makeEnv(Object.assign({}, opts, { failOn: null }));
  const res = await handleCalSync(
    new Request('https://x/calsync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ingest-Secret': SECRET },
      body: JSON.stringify(syncPayload(opts.sync || {})),
    }), env);
  const body = await res.json();
  if (res.status !== 200 || body.mode !== 'published') {
    throw new Error('seed failed: ' + res.status + ' ' + JSON.stringify(body).slice(0, 300));
  }
  env._sql.length = 0;          // 以降の書き込みだけを見たい
  if (opts.failOn) env._failOn = opts.failOn;
  return env;
}

// 「GASが出した空き枠」。D1と同じ計算で作り、必要なら壊して食い違いを作る。
//   ★ここで calslots を使うのは、この試験の目的が**比較と記録の作法**だからである。
//     GASとD1の答えが本当に一致するかは worker/test/slots-parity.test.js の責務。
function gasSlots(nowMs, events) {
  return slotsFromEvents((events || EVENTS).filter((e) => e.effect !== 'ignore')
      .filter((e) => e.startAt < D0 + DAY && e.endAt > D0),
    { nowMs, trainers: TRAINERS, ownerWindow: null })
    .map((s) => ({ startMs: s.startMs, trainerId: s.trainerId, trialOk: s.trialOk }));
}

function comparePayload(over = {}) {
  const nowMs = over.nowMs == null ? Date.now() : over.nowMs;
  const base = {
    fromMs: D0, toMs: D0 + DAY, ruleVersion: 1, flag1f: 'off', nowMs,
    trainers: TRAINERS, ownerWindow: null, requiredCalendars: REQUIRED,
    slots: gasSlots(nowMs),
  };
  return Object.assign(base, over, { nowMs });
}

function req(body, secret, path = '/calcompare', method = 'POST') {
  const h = { 'Content-Type': 'application/json' };
  if (secret != null) h['X-Ingest-Secret'] = secret;
  const init = { method, headers: h };
  if (method === 'POST') init.body = JSON.stringify(body == null ? {} : body);
  return new Request('https://x' + path, init);
}
const send = async (env, body, secret = SECRET) => {
  const res = await handleCalCompare(req(body, secret), env);
  return [res.status, await res.json()];
};
const getStatus = async (env, query = '', secret = SECRET) => {
  const res = await handleCalCompare(req(null, secret, '/calcompare/status' + query, 'GET'), env);
  return [res.status, await res.json()];
};

const fmt = (ms) => jstDateStr(ms) + ' ' + jstTimeStr(ms);

// ============================================================
// 0. 前提（試験データが意味のある枠を作っていること）
// ============================================================
{
  const g = gasSlots(Date.now());
  ok('前提：Aに枠が出る', g.filter((s) => s.trainerId === 'A').length > 5,
     'A=' + g.filter((s) => s.trainerId === 'A').length);
  ok('前提：Bにも枠が出る', g.filter((s) => s.trainerId === 'B').length > 3);
  eq('前提：Cは範囲外なので0件', g.filter((s) => s.trainerId === 'C').length, 0);
}

// ============================================================
// 1. 合言葉（calsync.js と同じ作法）
// ============================================================
{
  const env = await seeded();
  eq('★合言葉なしでは受け付けない', (await send(env, comparePayload(), null))[0], 403);
  eq('★違う合言葉でも受け付けない', (await send(env, comparePayload(), 'WRONG'))[0], 403);
  eq('★合言葉なしでは1行も記録しない', logCount(env), 0);
  eq('★statusも合言葉なしでは受け付けない', (await getStatus(env, '', null))[0], 403);
  eq('★statusも違う合言葉では受け付けない', (await getStatus(env, '', 'WRONG'))[0], 403);
  eq('正しい合言葉なら受け付ける', (await send(env, comparePayload()))[0], 200);
}
{
  const env = await seeded();
  env.SHARED_SECRET = '';          // 押し出しは済ませてから合言葉を外す
  eq('合言葉が設定されていなければ動かさない', (await send(env, comparePayload(), ''))[0], 503);
  eq('合言葉が未設定なら1行も記録しない', logCount(env), 0);
}
{
  const env = await seeded();
  const r1 = await handleCalCompare(req(null, SECRET, '/calcompare', 'GET'), env);
  eq('GET /calcompare は受けない', r1.status, 405);
  const r2 = await handleCalCompare(req({}, SECRET, '/calcompare/status', 'POST'), env);
  eq('POST /calcompare/status は受けない', r2.status, 405);
  eq('方式違いでは1行も記録しない', logCount(env), 0);
}
{
  eq('★safeEqual は calsync.js と同じ答えを出す（合言葉の作法が食い違わない）',
     [['a', 'a'], ['a', 'b'], ['a', 'aa'], ['', ''], ['', 'a']].map(([x, y]) => _forTest.safeEqual(x, y)),
     [['a', 'a'], ['a', 'b'], ['a', 'aa'], ['', ''], ['', 'a']].map(([x, y]) => _calsync.safeEqual(x, y)));
}

// ============================================================
// 2. 形の検証（壊れた要求を「不一致」として記録しない）
// ============================================================
{
  const env = await seeded();
  const cases = [
    ['BAD_JSON', null, 400, 'bad-json'],
    ['BAD_RANGE（逆向き）', comparePayload({ fromMs: D0 + DAY, toMs: D0 }), 400],
    ['BAD_RANGE（幅0）', comparePayload({ toMs: D0 }), 400],
    ['BAD_RANGE（整数でない）', comparePayload({ fromMs: 1.5 }), 400],
    ['BAD_RULE_VERSION', comparePayload({ ruleVersion: 0 }), 400],
    ['BAD_FLAG_1F', comparePayload({ flag1f: 'maybe' }), 400],
    ['BAD_CALENDARS（空）', comparePayload({ requiredCalendars: [] }), 400],
    ['BAD_TRAINERS（空）', comparePayload({ trainers: [] }), 400],
    ['BAD_TRAINER_ID', comparePayload({ trainers: [{ name: 'x' }] }), 400],
    ['DUPLICATE_TRAINER', comparePayload({ trainers: [{ id: 'A' }, { id: 'A' }] }), 400],
    ['SLOTS_NOT_ARRAY', comparePayload({ slots: 'x' }), 400],
    ['BAD_SLOTS（開始時刻が無い）', comparePayload({ slots: [{ trainerId: 'A' }] }), 400],
    ['BAD_SLOTS（トレーナーが無い）', comparePayload({ slots: [{ startMs: at(10) }] }), 400],
    ['BAD_OWNER_WINDOW', comparePayload({ ownerWindow: 'mon' }), 400],
    ['BAD_NOW', comparePayload({ nowMs: 'x' }), 400],
    ['TOO_MANY_TRAINERS', comparePayload({ trainers: Array.from({ length: 51 }, (_, i) => ({ id: 't' + i })) }), 413],
  ];
  for (const [name, body, want, raw] of cases) {
    let res;
    if (raw === 'bad-json') {
      res = await handleCalCompare(new Request('https://x/calcompare', {
        method: 'POST', headers: { 'X-Ingest-Secret': SECRET }, body: '{',
      }), env);
    } else {
      res = await handleCalCompare(req(body, SECRET), env);
    }
    eq('形の検証：' + name, res.status, want);
  }
  eq('★壊れた要求は1行も記録しない（GASの不具合をD1の不一致に見せない）', logCount(env), 0);
}
{
  // 古い nowMs は受けない（鮮度の判定が実際より甘くなる）
  const env = await seeded();
  const [s, b] = await send(env, comparePayload({ nowMs: Date.now() - 10 * 60000 }));
  eq('★2分より古い nowMs は受けない', s, 409);
  eq('古い nowMs の code', b.code, 'STALE_NOW');
  eq('古い nowMs でも1行も記録しない', logCount(env), 0);
}
{
  // ★時点をずらした突き合わせ（sweep）では、ずれを許す（2026-10-03）
  //
  //   7日間待つ代わりに「いま」を1〜7日前・25日・月末などにずらして比べる。
  //   ずれを拒否すると狙った時点を1つも試せない。実際、本番の最初の実行で
  //   13時点すべてが STALE_NOW で落ちた。
  //   安全性：nowMs は「GASが空き枠を計算した時点」であって鮮度の判定には使わない
  //   （鮮度は calendar_active.checked_at で見る）。古い nowMs で鮮度は偽れない。
  const env = await seeded();
  const day = 24 * 60 * 60 * 1000;
  for (const [name, back] of [['1日前', day], ['7日前', 7 * day], ['30日前', 30 * day]]) {
    const [s2, b2] = await send(env, comparePayload({ nowMs: Date.now() - back, sweep: true }));
    ok('★sweep なら ' + name + ' でも受ける', s2 === 200 && b2.code !== 'STALE_NOW');
  }
  // 未来にずらすのも許す（25日の解放・月末を先取りで試すため）
  const [s3, b3] = await send(env, comparePayload({ nowMs: Date.now() + 20 * day, sweep: true }));
  ok('★sweep なら未来にずらしても受ける', s3 === 200 && b3.code !== 'STALE_NOW');

  // ★鮮度は実時刻で見る／空き枠の計算だけ、ずらした時刻を使う（2026-10-03）
  //
  //   nowMs は「GASが空き枠を計算した時点」であって、D1が新しいかどうかとは関係ない。
  //   鮮度の判定に nowMs を渡すと、「1日前から見ればD1は1日先のデータ」となって
  //   必ず stale になり、狙った時点を1つも比べられない（本番で実際にそうなった）。
  {
    const SRC = readFileSync(join(HERE, '../src/routes/calcompare.js'), 'utf8');
    ok('★鮮度の判定には実時刻を渡す', /nowMs: at,\s*\/\/ 鮮度は実時刻で見る/.test(SRC));
    ok('★空き枠の計算にはずらした時刻を渡す',
       /slotsFromEvents\(read\.events, \{\s*nowMs, trainers/.test(SRC));
    ok('★理由を書いている', /nowMs は「GASが空き枠を計算した時点」/.test(SRC));
  }
  // 実際に動かして確かめる：7日前でも比較できる（stale にならない）
  for (const [name, back] of [['1日前', day], ['7日前', 7 * day], ['30日前', 30 * day]]) {
    const [s8, b8] = await send(env, comparePayload({ nowMs: Date.now() - back, sweep: true }));
    ok('★sweep の ' + name + ' が stale にならない',
       s8 === 200 && b8.compared !== false);
  }
  {
    const [s9, b9] = await send(env, comparePayload({ nowMs: Date.now() + 20 * day, sweep: true }));
    ok('★未来にずらしても stale にならない', s9 === 200 && b9.compared !== false);
  }

  // sweep を立てなければ、これまでどおり拒否する（本番の押し出しは守る）
  const [s4, b4] = await send(env, comparePayload({ nowMs: Date.now() - day }));
  eq('★sweep なしなら従来どおり拒否', [s4, b4.code], [409, 'STALE_NOW']);
  const [s5, b5] = await send(env, comparePayload({ nowMs: Date.now() - day, sweep: false }));
  eq('★sweep:false でも拒否', [s5, b5.code], [409, 'STALE_NOW']);
  // 文字列の 'true' などで通らない（厳密に true のときだけ）
  const [s6, b6] = await send(env, comparePayload({ nowMs: Date.now() - day, sweep: 'true' }));
  eq('★sweep が true 以外なら拒否', [s6, b6.code], [409, 'STALE_NOW']);
  const [s7, b7] = await send(env, comparePayload({ nowMs: Date.now() - day, sweep: 1 }));
  eq('★sweep が 1 でも拒否', [s7, b7.code], [409, 'STALE_NOW']);
}

// ============================================================
// 3. 一致したとき（matched=1・トレーナーごとに1行・diff は残さない）
// ============================================================
{
  const env = await seeded();
  const before = fingerprint(env);
  const [s, b] = await send(env, comparePayload());
  eq('一致：200で返る', s, 200);
  eq('一致：compared', b.compared, true);
  eq('★一致：matched', b.matched, true);

  const L = logs(env);
  eq('★一致：トレーナーごとに1行（3人＝3行）', L.length, 3);
  eq('★一致：トレーナーの並び', L.map((r) => r.trainer_id), ['A', 'B', 'C']);
  eq('★一致：すべて matched=1', L.map((r) => r.matched), [1, 1, 1]);
  eq('★一致：diff は残さない', L.map((r) => r.diff), [null, null, null]);
  eq('一致：kind は slots', [...new Set(L.map((r) => r.kind))], ['slots']);
  ok('一致：gas_count と d1_count が同じ', L.every((r) => r.gas_count === r.d1_count),
     JSON.stringify(L.map((r) => [r.gas_count, r.d1_count])));
  eq('一致：範囲外のCも0件どうしで記録される', L.filter((r) => r.trainer_id === 'C')[0].gas_count, 0);
  eq('一致：1回の実行は同じ at を共有する', new Set(L.map((r) => r.at)).size, 1);
  const gen = one(env, 'SELECT generation FROM calendar_active WHERE id = 1').generation;
  eq('一致：世代を記録する', [...new Set(L.map((r) => r.generation))], [gen]);

  eq('★既存のテーブルを1行も変えない', fingerprint(env), before);
  eq('★compare_log 以外に書く文が1つも無い', writesOutsideCompareLog(env), []);
}

// ============================================================
// 4. 食い違ったとき（matched=0・食い違った時間帯が diff に入る）
// ============================================================
{
  const env = await seeded();
  const before = fingerprint(env);
  const p = comparePayload();
  // GASから12:00の枠（Aの予約の直後）を1つ落とす → D1だけにある
  const target = p.slots.filter((x) => x.trainerId === 'A').map((x) => x.startMs).sort((a, b) => a - b)[2];
  p.slots = p.slots.filter((x) => !(x.trainerId === 'A' && x.startMs === target));
  // GASにだけある枠を1つ足す（D1は出さない時刻）
  const extra = at(10, 7);
  p.slots.push({ startMs: extra, trainerId: 'B', trialOk: true });

  const [s, b] = await send(env, p);
  eq('食い違い：200で返る', s, 200);
  eq('★食い違い：matched は false', b.matched, false);

  const L = logs(env);
  eq('食い違い：3行', L.length, 3);
  const A = L.find((r) => r.trainer_id === 'A');
  const B = L.find((r) => r.trainer_id === 'B');
  const C = L.find((r) => r.trainer_id === 'C');
  eq('★食い違い：Aは matched=0', A.matched, 0);
  eq('★食い違い：Bも matched=0', B.matched, 0);
  eq('★食い違いの無いCは matched=1', C.matched, 1);
  eq('★食い違いの無いCには diff を残さない', C.diff, null);

  const dA = JSON.parse(A.diff);
  eq('★Aの diff は「D1だけにある」1件', dA.counts.onlyD1, 1);
  eq('★Aの diff に食い違った時間帯が入る', dA.onlyD1, [fmt(target)]);
  eq('AのdiffにonlyGasは入らない', dA.onlyGas, undefined);
  const dB = JSON.parse(B.diff);
  eq('★Bの diff は「GASだけにある」1件', dB.counts.onlyGas, 1);
  eq('★Bの diff に食い違った時間帯が入る', dB.onlyGas, [fmt(extra)]);
  eq('Bの gas_count は d1_count より1つ多い', B.gas_count - B.d1_count, 1);

  eq('★食い違っても既存のテーブルを変えない', fingerprint(env), before);
  eq('★食い違っても compare_log 以外に書かない', writesOutsideCompareLog(env), []);
}

// ============================================================
// 5. trialOk（体験の可否）の食い違いを別に数える
// ============================================================
{
  const env = await seeded();
  const p = comparePayload();
  const first = p.slots.filter((x) => x.trainerId === 'A').sort((a, b) => a.startMs - b.startMs)[0];
  first.trialOk = !first.trialOk;

  const [, b] = await send(env, p);
  const A = logs(env).find((r) => r.trainer_id === 'A');
  eq('★trialOk が違えば matched=0', A.matched, 0);
  const d = JSON.parse(A.diff);
  eq('★trialOk の食い違いを別に数える', d.counts.trial, 1);
  eq('★trialOk の食い違いは時刻だけで記録する', d.trial, [{ at: fmt(first.startMs), gas: first.trialOk, d1: !first.trialOk }]);
  eq('trialOk の食い違いは枠の有無には数えない', [d.counts.onlyGas, d.counts.onlyD1], [0, 0]);
  eq('trialOk が違えば応答も matched:false', b.matched, false);
  eq('★trialOk が違っても件数は同じ', A.gas_count, A.d1_count);
}

// ============================================================
// 6. 同じ枠が2度出たとき（出勤の重複登録）
//    鍵の集合は変わらないので一致のままだが、件数として見える
// ============================================================
{
  const env = await seeded();
  const p = comparePayload();
  const dup = p.slots.filter((x) => x.trainerId === 'A')[0];
  p.slots.push({ startMs: dup.startMs, trainerId: 'A', trialOk: dup.trialOk });
  await send(env, p);
  const A = logs(env).find((r) => r.trainer_id === 'A');
  eq('重複は一致の判定を変えない（diffSlots と同じ扱い）', A.matched, 1);
  eq('重複は件数に出る', A.gas_count - A.d1_count, 1);
  eq('★重複は diff に件数として残る（黙って消さない）', JSON.parse(A.diff).counts.gasDupe, 1);
}

// ============================================================
// 7. D1が使えないとき＝「比較できなかった」（不一致と混ぜない）
// ============================================================
{
  // ① 鮮度切れ
  const env = await seeded();
  env._db.prepare('UPDATE calendar_active SET checked_at = ? WHERE id = 1').run(Date.now() - 30 * 60000);
  const before = fingerprint(env);
  env._sql.length = 0;
  const p = comparePayload();
  const [s, b] = await send(env, p);
  eq('鮮度切れ：200で返る（比較の失敗ではない）', s, 200);
  eq('★鮮度切れ：compared は false', b.compared, false);
  eq('★鮮度切れ：理由を返す', b.reason, 'stale');

  const L = logs(env);
  eq('★鮮度切れ：記録は1行だけ', L.length, 1);
  eq('★鮮度切れ：matched は NULL（0ではない＝不一致と混ぜない）', L[0].matched, null);
  eq('★鮮度切れ：kind で見分けられる', L[0].kind, 'slots_skipped');
  eq('鮮度切れ：トレーナーごとではない', L[0].trainer_id, null);
  eq('鮮度切れ：D1の件数は入れない', L[0].d1_count, null);
  eq('鮮度切れ：GASの件数は残す', L[0].gas_count, p.slots.length);
  eq('★鮮度切れ：理由を diff に残す', JSON.parse(L[0].diff).skip, 'stale');
  eq('★使えないときも既存のテーブルを変えない', fingerprint(env), before);
  eq('★使えないときも compare_log 以外に書かない', writesOutsideCompareLog(env), []);
}
{
  // ② 地平の外
  const env = await seeded();
  const [, b] = await send(env, comparePayload({ fromMs: H_END, toMs: H_END + DAY }));
  eq('★地平の外：horizon として記録', b.reason, 'horizon');
  const L = logs(env);
  eq('地平の外：matched は NULL', L[0].matched, null);
  eq('地平の外：1行だけ', L.length, 1);
}
{
  // ③ 公開された世代が無い（calsync を1回も通していない）
  const env = makeEnv();
  const [s, b] = await send(env, comparePayload());
  eq('世代が無い：200で返る', s, 200);
  eq('★世代が無い：missing として記録', b.reason, 'missing');
  eq('世代が無い：matched は NULL', logs(env)[0].matched, null);
}
{
  // ④ 分類規則の版が違う
  const env = await seeded();
  const [, b] = await send(env, comparePayload({ ruleVersion: 2 }));
  eq('★規則の版が違う：rule として記録', b.reason, 'rule');
  eq('規則の版が違う：matched は NULL', logs(env)[0].matched, null);
}
{
  // ⑤ 1Fフラグが食い違う
  const env = await seeded();
  const [, b] = await send(env, comparePayload({ flag1f: 'on' }));
  eq('★1Fフラグが食い違う：flag として記録', b.reason, 'flag');
  eq('1Fフラグが食い違う：matched は NULL', logs(env)[0].matched, null);
}
{
  // ⑥ 必要なカレンダーが欠けている
  const env = await seeded();
  const [, b] = await send(env, comparePayload({
    requiredCalendars: REQUIRED.concat([{ calendarId: 'zz@x', role: 'trainer', trainerId: 'Z' }]),
  }));
  eq('★カレンダーが欠けている：calendars として記録', b.reason, 'calendars');
  eq('カレンダーが欠けている：matched は NULL', logs(env)[0].matched, null);
}
{
  // ★「比較できなかった」行は、連続日数の「一致」にも「不一致」にも数えない
  const env = await seeded();
  env._db.prepare('UPDATE calendar_active SET checked_at = ? WHERE id = 1').run(Date.now() - 30 * 60000);
  await send(env, comparePayload());
  const [, st] = await getStatus(env, '?minRuns=1&days=2');
  const today = st.days.find((d) => d.date === jstDayKey(Date.now()));
  eq('★比較できなかった実行は runs に数えない', today.runs, 0);
  eq('★比較できなかった実行は unavailable に数える', today.unavailable, 1);
  eq('★比較できなかった実行は mismatched にも数えない', today.mismatched, 0);
}

// ============================================================
// 8. 氏名・タイトルを残さない（§12★）
// ============================================================
{
  const env = await seeded();
  const p = comparePayload();
  // わざと大きく食い違わせて、diff に中身を詰めさせる
  p.slots = p.slots.filter((x) => x.trainerId !== 'A');
  await send(env, p);
  const dump = JSON.stringify(rows(env, 'SELECT * FROM compare_log'));
  ok('★compare_log に氏名が1文字も入らない', dump.indexOf('田中') < 0 && dump.indexOf(NAME_A) < 0, dump.slice(0, 400));
  ok('★compare_log に他のトレーナーの氏名も入らない', dump.indexOf('鈴木') < 0 && dump.indexOf('沖') < 0);
  ok('★diff に「氏名」らしき日本語が入らない（時刻と件数だけ）',
     /^[\x20-\x7e]*$/.test(logs(env).map((r) => r.diff || '').join('')),
     logs(env).map((r) => r.diff).join(' | ').slice(0, 300));
  // タイトルはそもそもD1に無い（calsync が保存しない）。念のため予約の痕跡も見る
  ok('★compare_log に [RESERVED] 等のタイトルが入らない',
     dump.indexOf('RESERVED') < 0 && dump.indexOf('消化') < 0 && dump.indexOf('休憩') < 0);
}

// ============================================================
// 9. diff の上限（長くなりすぎない）
// ============================================================
{
  const env = await seeded();
  const p = comparePayload();
  // D1が出さない時刻を100件ぶんGASに足す（7分すぎの枠は吸着方式では出ない）
  for (let h = 7; h < 23; h++) {
    for (const m of [7, 17, 27, 37, 47, 57]) p.slots.push({ startMs: at(h, m), trainerId: 'A', trialOk: true });
  }
  await send(env, p);
  const A = logs(env).find((r) => r.trainer_id === 'A');
  const d = JSON.parse(A.diff);
  eq('★diff に入れる時間帯は20件まで', d.onlyGas.length, _forTest.DIFF_MAX_ITEMS);
  eq('★件数は正しく残す（96件）', d.counts.onlyGas, 96);
  eq('★切り詰めたことが分かる', d.truncated, true);
  ok('★diff の長さに上限が効く', A.diff.length <= _forTest.DIFF_MAX_CHARS, 'len=' + A.diff.length);
}
{
  // 上限を超える量でも、件数だけに落ちて必ず収まる
  const many = Array.from({ length: 5000 }, (_, i) => at(0) + i * 60000);
  const s = _forTest.buildDiff({
    matched: false,
    counts: { onlyGas: many.length, onlyD1: 0, trial: 0, gasDupe: 0, d1Dupe: 0 },
    items: { onlyGas: many, onlyD1: [], trial: [] },
  });
  ok('★極端な食い違いでも diff は上限に収まる', s.length <= _forTest.DIFF_MAX_CHARS, 'len=' + s.length);
  eq('★極端なときは件数だけ残す', JSON.parse(s).counts.onlyGas, 5000);
  eq('一致したら diff は null', _forTest.buildDiff({
    matched: true, counts: { onlyGas: 0, onlyD1: 0, trial: 0, gasDupe: 0, d1Dupe: 0 },
    items: { onlyGas: [], onlyD1: [], trial: [] },
  }), null);
}

// ============================================================
// 10. 突き合わせの鍵（トレーナー×開始時刻）と範囲の端
// ============================================================
{
  const g = [{ startMs: at(10), trainerId: 'A', trialOk: true }];
  const d = [{ startMs: at(10), trainerId: 'B', trialOk: true }];
  const r = compareSlots(g, d, ['A', 'B'], D0, D0 + DAY);
  eq('★鍵はトレーナー×開始時刻（同じ時刻でも別人なら別の枠）',
     r.trainers.map((x) => [x.trainerId, x.counts.onlyGas, x.counts.onlyD1]),
     [['A', 1, 0], ['B', 0, 1]]);
}
{
  const r = compareSlots(
    [{ startMs: at(10), trainerId: 'A', trialOk: true }, { startMs: D0 - 3600000, trainerId: 'A', trialOk: true }],
    [{ startMs: at(10), trainerId: 'A', trialOk: true }, { startMs: D0 + DAY, trainerId: 'A', trialOk: true }],
    ['A'], D0, D0 + DAY);
  eq('★範囲の外の枠は両方とも比較に入れない（端の作りの違いを不一致にしない）',
     r.trainers[0].matched, true);
  eq('範囲外の件数は別に数える', [r.gasOutOfRange, r.d1OutOfRange], [1, 1]);
  eq('範囲内の件数だけを記録する', [r.trainers[0].gasCount, r.trainers[0].d1Count], [1, 1]);
}
{
  const r = compareSlots([{ startMs: at(10), trainerId: 'Z', trialOk: true }], [], ['A'], D0, D0 + DAY);
  eq('★一覧に無いトレーナーの枠も取りこぼさない（行を作って不一致にする）',
     r.trainers.map((x) => [x.trainerId, x.matched]), [['A', true], ['Z', false]]);
}

// ============================================================
// 11. 連続7日間の数え方（①を完了してよいかの判断）
// ============================================================
function run(day, matched) {       // その日の1回の実行（12:00）
  return { at: day + 12 * 3600000, kind: 'slots', n: 3, min_matched: matched ? 1 : 0 };
}
const DATES = (n, endDay) => Array.from({ length: n }, (_, i) => jstDayKey(endDay - (n - 1 - i) * DAY));
{
  const today = TODAY0;
  const dates = DATES(14, today);
  const todayKey = jstDayKey(today);

  // 直前7日すべて一致 → ready
  let groups = [];
  for (let i = 1; i <= 7; i++) groups.push(run(today - i * DAY, true));
  let s = summarizeDays(groups, { dates, todayKey, minRuns: 1, needDays: 7 });
  eq('★7日続けて一致したら連続7日', s.consecutiveDays, 7);
  eq('★7日続けて一致したら ready', s.ready, true);

  // 3日だけ → まだ
  groups = [];
  for (let i = 1; i <= 3; i++) groups.push(run(today - i * DAY, true));
  s = summarizeDays(groups, { dates, todayKey, minRuns: 1, needDays: 7 });
  eq('3日なら連続3日', s.consecutiveDays, 3);
  eq('★3日では ready にしない', s.ready, false);

  // 真ん中に不一致 → そこで途切れる
  groups = [];
  for (let i = 1; i <= 7; i++) groups.push(run(today - i * DAY, i !== 4));
  s = summarizeDays(groups, { dates, todayKey, minRuns: 1, needDays: 7 });
  eq('★1日でも不一致があれば途切れる', s.consecutiveDays, 3);
  eq('不一致の日は allMatched が偽', s.days.find((d) => d.date === jstDayKey(today - 4 * DAY)).allMatched, false);
  eq('不一致の日の mismatched', s.days.find((d) => d.date === jstDayKey(today - 4 * DAY)).mismatched, 1);

  // 日付が飛ぶ（4日前の記録が無い）→ そこで途切れる
  groups = [];
  for (let i = 1; i <= 7; i++) if (i !== 4) groups.push(run(today - i * DAY, true));
  s = summarizeDays(groups, { dates, todayKey, minRuns: 1, needDays: 7 });
  eq('★日付が飛んだら途切れる（見ていない日を一致と数えない）', s.consecutiveDays, 3);
  eq('記録が無い日は runs=0', s.days.find((d) => d.date === jstDayKey(today - 4 * DAY)).runs, 0);

  // 当日は未完なので数えない
  groups = [run(today, true)];
  for (let i = 1; i <= 7; i++) groups.push(run(today - i * DAY, true));
  s = summarizeDays(groups, { dates, todayKey, minRuns: 1, needDays: 7 });
  eq('★当日は連続日数に数えない（まだ1日ぶん揃っていない）', s.consecutiveDays, 7);
  eq('当日も days には載せる', s.days.find((d) => d.date === todayKey).runs, 1);

  // 昨日が不一致なら、当日が一致していても0
  groups = [run(today, true), run(today - DAY, false)];
  s = summarizeDays(groups, { dates, todayKey, minRuns: 1, needDays: 7 });
  eq('★直前の日が不一致なら連続0', s.consecutiveDays, 0);

  // 最低サンプル数に届かない日は「一致した日」にしない
  groups = [];
  for (let i = 1; i <= 7; i++) groups.push(run(today - i * DAY, true));
  s = summarizeDays(groups, { dates, todayKey, minRuns: 2, needDays: 7 });
  eq('★最低サンプル数に届かない日は数えない', s.consecutiveDays, 0);

  // 比較できなかった実行は、不一致にはしないが実行回数にも入れない
  groups = [{ at: (today - DAY) + 12 * 3600000, kind: 'slots_skipped', n: 1, min_matched: null },
            run(today - 2 * DAY, true)];
  s = summarizeDays(groups, { dates, todayKey, minRuns: 1, needDays: 7 });
  const y = s.days.find((d) => d.date === jstDayKey(today - DAY));
  eq('★比較できなかった日は runs=0 / unavailable=1', [y.runs, y.unavailable, y.mismatched], [0, 1, 0]);
  eq('★比較できなかった日では連続が途切れる（一致の証拠が無い）', s.consecutiveDays, 0);
}

// ============================================================
// 12. GET /calcompare/status（実物のD1から数える）
// ============================================================
{
  const env = await seeded();
  const ins = env._db.prepare(
    'INSERT INTO compare_log (at, generation, trainer_id, kind, gas_count, d1_count, diff, matched) VALUES (?,?,?,?,?,?,?,?)');
  const addRun = (day, matched) => {
    const t = day + 12 * 3600000;
    for (const tid of ['A', 'B', 'C']) ins.run(t, 1, tid, 'slots', 5, 5, null, matched ? 1 : 0);
  };
  for (let i = 1; i <= 7; i++) addRun(TODAY0 - i * DAY, true);

  const [s, b] = await getStatus(env, '?minRuns=1&days=14');
  eq('status：200で返る', s, 200);
  eq('★status：連続7日を数える', b.consecutiveDays, 7);
  eq('★status：①を完了してよいかが一目で分かる', b.ready, true);
  eq('status：見た日数ぶん返す', b.days.length, 14);
  eq('status：判定の条件も返す', [b.minRuns, b.needDays], [1, 7]);
  const yd = b.days.find((d) => d.date === jstDayKey(TODAY0 - DAY));
  eq('status：1日のまとまり', [yd.runs, yd.matched, yd.mismatched, yd.allMatched], [1, 1, 0, true]);

  // 1人でも違えばその実行は不一致（MIN(matched) で畳む）
  const t = (TODAY0 - 3 * DAY) + 15 * 3600000;
  ins.run(t, 1, 'A', 'slots', 5, 4, '{"counts":{"onlyD1":1}}', 0);
  ins.run(t, 1, 'B', 'slots', 5, 5, null, 1);
  ins.run(t, 1, 'C', 'slots', 5, 5, null, 1);
  const [, b2] = await getStatus(env, '?minRuns=1&days=14');
  eq('★status：1人でも違えばその日で途切れる', b2.consecutiveDays, 2);
  eq('status：その日は mismatched に数える',
     b2.days.find((d) => d.date === jstDayKey(TODAY0 - 3 * DAY)).mismatched, 1);

  eq('status：既定の最低サンプル数は厳しい（1回では ready にしない）',
     (await getStatus(env, '?days=14'))[1].ready, false);
  eq('status：見る日数の指定が壊れていたら受けない', (await getStatus(env, '?days=0'))[0], 400);
  eq('status：最低サンプル数の指定が壊れていたら受けない', (await getStatus(env, '?minRuns=abc'))[0], 400);
  eq('status：nowMs が空でも1970年を見に行かない', (await getStatus(env, '?nowMs='))[1].consecutiveDays, 0);
  eq('status：nowMs が壊れていたら受けない', (await getStatus(env, '?nowMs=0'))[0], 400);
  eq('★status は読み取りだけ（1行も書かない）', writesOutsideCompareLog(env), []);
  ok('★status は compare_log にも書かない',
     env._sql.filter((x) => /^(INSERT|UPDATE|DELETE)/i.test(String(x.q).trim())).length === 0);
}
{
  // nowMs で「今日」をずらして数えられる（調査用）
  const env = await seeded();
  const ins = env._db.prepare(
    'INSERT INTO compare_log (at, generation, trainer_id, kind, gas_count, d1_count, diff, matched) VALUES (?,?,?,?,?,?,?,?)');
  for (let i = 1; i <= 8; i++) ins.run(TODAY0 - i * DAY + 12 * 3600000, 1, 'A', 'slots', 5, 5, null, 1);
  const [, b] = await getStatus(env, '?minRuns=1&days=14&nowMs=' + (TODAY0 - DAY));
  eq('status：nowMs で基準日をずらせる', b.consecutiveDays, 7);
}

// ============================================================
// 13. 比較が失敗しても500で済み、D1は壊れない
// ============================================================
{
  const env = await seeded({ failOn: /INSERT INTO compare_log/ });
  const before = fingerprint(env);
  const [s, b] = await send(env, comparePayload());
  eq('★記録に失敗したら500（黙って成功にしない）', s, 500);
  eq('失敗の code', b.code, 'INTERNAL');
  eq('★記録に失敗してもD1は壊れない', fingerprint(env), before);
  eq('★記録に失敗しても compare_log 以外に書かない', writesOutsideCompareLog(env), []);
  eq('★失敗した記録は1行も残らない（batchごと巻き戻る）', logCount(env), 0);
}
{
  const env = await seeded({ failOn: /FROM calendar_active/ });
  const before = fingerprint(env);
  const [s] = await send(env, comparePayload());
  eq('★読み取りに失敗したら500', s, 500);
  eq('★読み取りに失敗してもD1は壊れない', fingerprint(env), before);
  eq('読み取りに失敗したら1行も記録しない', logCount(env), 0);
}
{
  const env = await seeded({ failOn: /FROM compare_log/ });
  const [s] = await getStatus(env, '?minRuns=1');
  eq('★status が失敗しても500で済む', s, 500);
}
{
  // 比較を2回続けても、公開中の世代は動かない（表示にも予約にも影響しない）
  const env = await seeded();
  const before = fingerprint(env);
  await send(env, comparePayload());
  await send(env, comparePayload());
  eq('★何回比較しても公開中の世代は動かない', fingerprint(env), before);
  eq('2回ぶん記録される', logCount(env), 6);
}

// ============================================================
// ★/calcompare/direct — 予定を直接受け取る（D1に触らない・2026-10-03）
//
//   D1経由では、D1が持っている地平の中しか比べられない。地平は「いま」で決まるので、
//   25日の翌月解放や月末の地平の伸びを比べられなかった（horizon で落ちた）。
//   9月のデータをD1へ押し出すと公開中の世代が9月になって本番が壊れるので、
//   予定をそのまま受け取って同じ計算をする経路を作った。
//
//   ★この経路の生命線は「D1に一切触らないこと」。触ると本番を壊す。
// ============================================================
{
  const env = await seeded();
  const base = comparePayload();
  const directBody = {
    fromMs: base.fromMs, toMs: base.toMs, nowMs: base.nowMs,
    trainers: base.trainers, ownerWindow: base.ownerWindow,
    events: [], slots: [],
  };
  const sendDirect = async (e, b) => {
    const req = new Request('https://x/calcompare/direct', {
      method: 'POST', headers: { 'X-Ingest-Secret': SECRET, 'content-type': 'application/json' },
      body: JSON.stringify(b),
    });
    const res = await handleCalCompare(req, e);
    return [res.status, await res.json()];
  };

  // ① 認証
  {
    const req = new Request('https://x/calcompare/direct', { method: 'POST', body: '{}' });
    const res = await handleCalCompare(req, env);
    eq('★direct：合言葉なしは受けない', res.status, 403);
  }

  // ② ★D1に一切触らない（ここが生命線）
  {
    const before = env._sql.length;
    const genBefore = one(env, 'SELECT generation FROM calendar_active WHERE id = 1');
    const logBefore = logCount(env);
    const [st] = await sendDirect(env, directBody);
    eq('★direct：成功する', st, 200);
    eq('★★direct：D1に1回もSQLを発行しない', env._sql.length - before, 0);
    eq('★direct：公開中の世代が変わらない',
       one(env, 'SELECT generation FROM calendar_active WHERE id = 1').generation,
       genBefore.generation);
    eq('★direct：compare_log にも残さない（連続日数の証拠にしない）', logCount(env), logBefore);
  }

  // ③ 時点も範囲も自由に選べる（D1の地平に縛られない）
  {
    const day = 24 * 60 * 60 * 1000;
    const far = { ...directBody, nowMs: directBody.nowMs - 40 * day,
                  fromMs: directBody.fromMs - 40 * day, toMs: directBody.toMs - 40 * day };
    const [st2, b2] = await sendDirect(env, far);
    eq('★direct：40日前でも比較できる（horizon で落ちない）', [st2, b2.compared], [200, true]);
    ok('★direct：reason を返さない（比較できなかった扱いにしない）', b2.reason === undefined);
  }

  // ④ 実際に突き合わせる（一致・食い違い）
  {
    const H = (h) => Date.UTC(2026, 10, 5, h - 9, 0, 0);     // JST
    const ev = [
      { role: 'trainer', trainerId: 'A', effect: 'shift', reason: 'shift', startAt: H(7), endAt: H(23) },
    ];
    const nowMs = Date.UTC(2026, 10, 1, 0, 0, 0);
    const payloadBase = {
      fromMs: H(0), toMs: H(24), nowMs,
      trainers: [{ id: 'A', hidden: false }], ownerWindow: null, events: ev,
    };
    // Worker が出す枠をそのまま渡せば一致する
    const [, probe] = await sendDirect(env, { ...payloadBase, slots: [] });
    ok('★direct：GASが0枠ならD1の枠数が出る', probe.d1Count > 0);
    eq('★direct：0枠と突き合わせれば食い違う', probe.matched, false);
  }

  // ⑤ 壊れた要求は受けない
  {
    for (const [name, over, want] of [
      ['範囲が逆', { fromMs: directBody.toMs, toMs: directBody.fromMs }, 400],
      ['nowMs が無い', { nowMs: null }, 400],
      ['events が配列でない', { events: 'x' }, 400],
      ['slots が配列でない', { slots: 'x' }, 400],
      ['events が多すぎる', { events: new Array(20001).fill({}) }, 413],
    ]) {
      const [st3] = await sendDirect(env, { ...directBody, ...over });
      eq('★direct：' + name + ' は受けない', st3, want);
    }
  }

  // ⑥ 経路が登録されている
  {
    const IDX = readFileSync(join(HERE, '../src/index.js'), 'utf8');
    ok('★direct：経路が登録されている', /'\/calcompare\/direct'/.test(IDX));
  }
}

console.log(`\n①の突き合わせ 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
