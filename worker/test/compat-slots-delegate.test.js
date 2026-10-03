// 顧客の画面が見る空き枠を、三段構え（routeSlots）に繋いだことの検証（2026-10-03）
//
//   画面の一本道： liff/index.html → action:'line_getTrainerSlots'
//                 → EDGE_MAP で 'c_trainerSlots' → index.js → compatTrainerSlots
//   ここが繋がっていなかった間、①（calendar_events から計算する経路）は
//   誰にも届いていなかった。繋いだ以上、**繋いだことで答えが変わっていないこと**を
//   ここで固定する。
//
//   ★この試験でいちばん大事なのは「いまと同じ答えを返すこと」。
//     そのために、**委譲前の実装をこのファイルに丸ごと写して**（下の oldCompatTrainerSlots）
//     同じ入力を両方に与え、1枠ずつ突き合わせる。
//     写しは当時のコードそのまま。締め切りの判定だけは当時と同じ関数
//     （compat.js の _forTest.isSlotOpen。当時のファイル内 isSlotOpen と同一）を使う。
//
//   見ているもの
//     1. ②（slots_cache）で動いているとき、委譲前と**1枠も違わない**
//     2. 返す項目の名前が変わっていない（slots / computedAt / ageMs / _fallback）
//     3. excludeStartISO が効く（予約変更のとき自分の枠が残る＝締め切りを二重に見ていない）
//     4. _fallback が立つ条件が変わっていない（20分・computed_at 無し・写し無し・壊れた写し）
//     5. ①が有効なとき①で答える（②が無くても答えられる）
//     6. ①が使えないとき②に落ちる
//     7. ②も無いとき、**0件と「分からない」が区別できる**
//
//   実行: node worker/test/compat-slots-delegate.test.js（①の検証で node:sqlite を使う）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { compatTrainerSlots, _forTest as _compat } from '../src/routes/compat.js';
import { routeSlots, SLOT_SOURCE, SLOT_FALLBACK, _forTest as _slots } from '../src/routes/slots.js';
import { CAL_ROLE, EV_KIND } from '../src/lib/calclass.js';
import { jstParts, jstMs } from '../src/lib/calslots.js';

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else { fail++; console.log(`❌ ${name}\n   got : ${g}\n   want: ${w}`); }
}
function ok(name, cond, detail) {
  if (cond) pass++; else { fail++; console.log(`❌ ${name}${detail ? '\n   ' + detail : ''}`); }
}

const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const LEAD = 180 * MIN;

// ============================================================
// 委譲前の実装（2026-10-03 以前の compatTrainerSlots をそのまま写したもの）
//   ★ここは直さない。これが「いまと同じ答え」の基準そのもの。
// ============================================================
async function oldCompatTrainerSlots({ env, body, who }) {
  const isSlotOpen = _compat.isSlotOpen;                 // 当時のファイル内 isSlotOpen と同一
  const trainerId = String(body.trainerId || who.trainerId || '');
  if (!trainerId) return { _fallback: true };
  const row = await env.DB.prepare('SELECT payload, computed_at FROM slots_cache WHERE trainer_id = ?')
    .bind(trainerId).first();
  if (!row) return { _fallback: true };
  let raw;
  try { raw = JSON.parse(row.payload); } catch (_) { return { _fallback: true }; }

  const computedAt = Number(row.computed_at || 0);
  if (!computedAt) return { _fallback: true };
  if (Date.now() - computedAt > 20 * 60 * 1000) return { _fallback: true };

  const now = Date.now();
  const cfg = raw.rules || { leadMinutes: 180, morningUntilHour: 12, prevDeadlineHour: 22 };
  const exISO = String(body.excludeStartISO || '');
  const exMs = exISO ? new Date(exISO).getTime() : 0;

  const slots = (raw.slots || []).filter((s) => {
    if (exMs && s.startMs === exMs) return true;
    if (s.startMs <= now) return false;
    return isSlotOpen(s.startMs, now, cfg);
  }).map((s) => ({
    date: s.date, dayOfWeek: s.dayOfWeek, startTime: s.startTime, endTime: s.endTime,
    startISO: s.startISO, endISO: s.endISO,
    trainerName: s.trainerName, trainerId: s.trainerId, trialOk: s.trialOk,
  }));

  return { slots, computedAt, ageMs: Date.now() - computedAt };
}

// ============================================================
// ②だけを持つ env（slots_cache の1行しか要らない。速いので総当たりに使う）
// ============================================================
function cacheEnv(row, vars = {}) {
  const env = Object.assign({}, vars);
  env.DB = {
    prepare(q) {
      return {
        bind() { return this; },
        async first() { return /slots_cache/.test(q) ? row : null; },
        async all() { return { results: [] }; },
      };
    },
  };
  return env;
}
const cacheRow = (payload, computedAt) => ({
  payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
  computed_at: computedAt,
});

// ============================================================
// 突き合わせ（委譲前 ⇄ 委譲後）
// ============================================================
//   ageMs は「いま何分前の写しか」を測り直した値なので、2回の呼び出しで数ミリずれる。
//   そこだけは許容幅で見て、他は完全一致を要求する。
function sameAnswer(name, oldR, newR) {
  const norm = (r) => ({
    keys: Object.keys(r).sort(),
    fallback: r._fallback === true,
    slots: r.slots === undefined ? null : r.slots,
    computedAt: r.computedAt === undefined ? null : r.computedAt,
  });
  eq(name, norm(newR), norm(oldR));
  if (!oldR._fallback) {
    const d = Math.abs(Number(newR.ageMs) - Number(oldR.ageMs));
    ok(`${name}／ageMs が同じ尺度`, isFinite(d) && d <= 2000,
       `old=${oldR.ageMs} new=${newR.ageMs}`);
  }
}

// ============================================================
// 突き合わせに使う枠（締め切りの境界・過去・壊れた値をわざと混ぜる）
//   ★境界ちょうどは使わない。2回の呼び出しの間に時計が進むと、
//     実装の違いではなく時計の差で結果が割れてしまう。前後5秒にずらす。
// ============================================================
function slotList(now) {
  const mk = (startMs, label) => ({
    startMs,
    startISO: typeof startMs === 'number' ? new Date(startMs).toISOString() : String(startMs),
    endISO: typeof startMs === 'number' ? new Date(startMs + HOUR).toISOString() : '',
    date: '2026/10/02', dayOfWeek: '金', startTime: label, endTime: label + '+1',
    trainerName: '鈴木', trainerId: 't1', trialOk: label !== 'past',
  });
  const p = jstParts(now);
  const jstAt = (dayOffset, hour) => jstMs(p.year, p.month, p.day + dayOffset, hour, 0);
  return [
    mk(now - HOUR, 'past'),                       // 過去＝出ない
    mk(now + LEAD - 5000, 'deadline-just-over'),  // 締め切りを5秒過ぎた＝出ない
    mk(now + LEAD + 5000, 'deadline-just-under'), // 締め切り5秒前＝出る
    mk(jstAt(2, 14), 'afternoon-d2'),             // 2日後の午後＝出る
    mk(jstAt(2, 8), 'morning-d2'),                // 2日後の午前＝前日22時の規則が効く側
    mk(jstAt(1, 10), 'morning-d1'),               // 翌日の午前＝今の時刻によって変わる
    mk(now + 20 * DAY, 'far'),                    // 先の枠＝出る
    mk(undefined, 'no-startMs'),                  // 壊れた写し（startMs が無い）
    mk(String(now + 21 * DAY), 'startMs-string'), // 壊れた写し（startMs が文字列）
  ];
}

const RULES = [
  ['rules 無し（GASの既定と同じ）', undefined],
  ['rules そのまま', { leadMinutes: 180, morningUntilHour: 12, prevDeadlineHour: 22 }],
  ['午前の規則を止めた rules', { leadMinutes: 180, morningUntilHour: 0, prevDeadlineHour: 22 }],
  ['締め切りが30分の rules', { leadMinutes: 30, morningUntilHour: 12, prevDeadlineHour: 22 }],
  ['前日0時の rules（0は無効ではない）', { leadMinutes: 180, morningUntilHour: 12, prevDeadlineHour: 0 }],
];

// ------------------------------------------------------------
// 1. ②で動いているとき、委譲前と1枠も違わない
// ------------------------------------------------------------
{
  const now = Date.now();
  for (const [label, rules] of RULES) {
    const payload = { trainerId: 't1', slots: slotList(now), rules };
    const row = cacheRow(payload, now - 60000);
    const body = { trainerId: 't1' };
    const who = { role: 'customer', customerId: 'c1' };
    const oldR = await oldCompatTrainerSlots({ env: cacheEnv(row), body, who });
    const newR = await compatTrainerSlots({ env: cacheEnv(row), body, who });
    sameAnswer(`★②で同じ答え（${label}）`, oldR, newR);
    ok(`★②で枠が1つは出ている（${label}）`, (newR.slots || []).length > 0,
       JSON.stringify(newR).slice(0, 160));
  }
}

// ------------------------------------------------------------
// 2. excludeStartISO（予約変更のとき自分の枠を残す）
// ------------------------------------------------------------
{
  const now = Date.now();
  const list = slotList(now);
  const payload = { trainerId: 't1', slots: list, rules: null };
  const row = cacheRow(payload, now - 60000);
  const who = { role: 'customer', customerId: 'c1' };

  const EXCL = [
    ['除外なし', ''],
    ['過去の自分の枠を除外指定', new Date(now - HOUR).toISOString()],
    ['締め切りを過ぎた自分の枠を除外指定', new Date(now + LEAD - 5000).toISOString()],
    ['もともと出る枠を除外指定', new Date(now + 20 * DAY).toISOString()],
    ['写しに無い日時を除外指定', new Date(now + 400 * DAY).toISOString()],
    ['読めない日時', 'not-a-date'],
    ['空文字と同じ扱いになる0', 0],
  ];
  for (const [label, exISO] of EXCL) {
    const body = { trainerId: 't1', excludeStartISO: exISO };
    const oldR = await oldCompatTrainerSlots({ env: cacheEnv(row), body, who });
    const newR = await compatTrainerSlots({ env: cacheEnv(row), body, who });
    sameAnswer(`★除外の扱いが同じ（${label}）`, oldR, newR);
  }

  // 「残る」こと自体も直接見る（締め切りを二重に判定していたら落ちる）
  const times = async (exISO) => {
    const r = await compatTrainerSlots({
      env: cacheEnv(row), who, body: { trainerId: 't1', excludeStartISO: exISO },
    });
    return (r.slots || []).map((s) => s.startTime);
  };
  const base = await times('');
  const kept = await times(new Date(now + LEAD - 5000).toISOString());
  ok('★締め切り後の枠は、ふだんは出ない', base.indexOf('deadline-just-over') < 0, base.join(','));
  ok('★★除外指定した自分の枠は締め切り後でも残る（予約変更ができる）',
     kept.indexOf('deadline-just-over') >= 0, kept.join(','));
  const keptPast = await times(new Date(now - HOUR).toISOString());
  ok('★除外指定なら過去の自分の枠も残る（委譲前と同じ）',
     keptPast.indexOf('past') >= 0, keptPast.join(','));
}

// ------------------------------------------------------------
// 3. _fallback が立つ条件（20分・computed_at 無し・写し無し・壊れた写し）
// ------------------------------------------------------------
{
  const now = Date.now();
  const list = slotList(now);
  const who = { role: 'customer', customerId: 'c1' };
  const body = { trainerId: 't1' };
  const payload = { trainerId: 't1', slots: list, rules: null };

  const CASES = [
    ['写しが1分前', cacheRow(payload, now - MIN), false],
    ['写しが19分前', cacheRow(payload, now - 19 * MIN), false],
    ['★写しが20分−5秒前＝まだ答える', cacheRow(payload, now - (20 * MIN - 5000)), false],
    ['★写しが20分+5秒前＝答えない', cacheRow(payload, now - (20 * MIN + 5000)), true],
    ['写しが2時間前＝答えない', cacheRow(payload, now - 2 * HOUR), true],
    ['★computed_at が0＝答えない', cacheRow(payload, 0), true],
    ['★computed_at が無い＝答えない', cacheRow(payload, null), true],
    ['★computed_at が数でない＝答えない', cacheRow(payload, 'あ'), true],
    ['写しの行が無い＝答えない', null, true],
    ['★payload が壊れている＝答えない', { payload: '{壊れ', computed_at: now - MIN }, true],
  ];
  for (const [label, row, wantFallback] of CASES) {
    const oldR = await oldCompatTrainerSlots({ env: cacheEnv(row), body, who });
    const newR = await compatTrainerSlots({ env: cacheEnv(row), body, who });
    sameAnswer(`★_fallback の条件が同じ（${label}）`, oldR, newR);
    eq(`${label} → _fallback=${wantFallback}`, newR._fallback === true, wantFallback);
  }

  // trainerId が無い（画面が送らず who にも無い）
  {
    const row = cacheRow(payload, now - MIN);
    const oldR = await oldCompatTrainerSlots({ env: cacheEnv(row), body: {}, who });
    const newR = await compatTrainerSlots({ env: cacheEnv(row), body: {}, who });
    sameAnswer('★trainerId が無ければ答えない（同じ）', oldR, newR);
    eq('trainerId が無い → _fallback', newR._fallback, true);
  }
  // trainerId が who から来る（トレーナー自身の画面）
  {
    const row = cacheRow(payload, now - MIN);
    const w2 = { role: 'trainer', trainerId: 't1' };
    const oldR = await oldCompatTrainerSlots({ env: cacheEnv(row), body: {}, who: w2 });
    const newR = await compatTrainerSlots({ env: cacheEnv(row), body: {}, who: w2 });
    sameAnswer('★who.trainerId でも同じ答え', oldR, newR);
    ok('who.trainerId で枠が出る', (newR.slots || []).length > 0);
  }
  // ★画面が excludeStartMs を直接送っても効かせない（以前は見ていなかった項目）
  {
    const row = cacheRow(payload, now - MIN);
    const b = { trainerId: 't1', excludeStartMs: now + LEAD - 5000 };
    const oldR = await oldCompatTrainerSlots({ env: cacheEnv(row), body: b, who });
    const newR = await compatTrainerSlots({ env: cacheEnv(row), body: b, who });
    sameAnswer('★excludeStartMs を直接送っても答えは変わらない', oldR, newR);
    ok('★excludeStartMs 直送りでは締め切り後の枠は残らない',
       (newR.slots || []).every((s) => s.startTime !== 'deadline-just-over'));
  }
}

// ------------------------------------------------------------
// 4. 返す項目の名前（画面が読んでいるもの）が変わっていない
// ------------------------------------------------------------
{
  const now = Date.now();
  const row = cacheRow({ trainerId: 't1', slots: slotList(now), rules: null }, now - MIN);
  const r = await compatTrainerSlots({
    env: cacheEnv(row), body: { trainerId: 't1' }, who: { role: 'customer', customerId: 'c1' },
  });
  eq('★応答の項目は slots / computedAt / ageMs の3つだけ',
     Object.keys(r).sort(), ['ageMs', 'computedAt', 'slots']);
  eq('★1枠の項目が変わっていない', Object.keys(r.slots[0]).sort(),
     ['date', 'dayOfWeek', 'endISO', 'endTime', 'startISO', 'startTime',
      'trainerId', 'trainerName', 'trialOk'].sort());
  ok('★startMs は画面に出さない（委譲前と同じ）', r.slots.every((s) => !('startMs' in s)));
  ok('computedAt は数', typeof r.computedAt === 'number' && r.computedAt > 0);
  ok('ageMs は数', typeof r.ageMs === 'number');
}

// ------------------------------------------------------------
// 5. 0件と「分からない」が区別できる
// ------------------------------------------------------------
{
  const now = Date.now();
  const who = { role: 'customer', customerId: 'c1' };
  const body = { trainerId: 't1' };

  const emptyRow = cacheRow({ trainerId: 't1', slots: [], rules: null }, now - MIN);
  const empty = await compatTrainerSlots({ env: cacheEnv(emptyRow), body, who });
  eq('★新しい写しで本当に0件なら「0件」と答える', [empty._fallback, empty.slots.length],
     [undefined, 0]);
  sameAnswer('★0件のときも委譲前と同じ',
             await oldCompatTrainerSlots({ env: cacheEnv(emptyRow), body, who }), empty);

  const none = await compatTrainerSlots({ env: cacheEnv(null), body, who });
  eq('★写しが無いときは0件ではなく「分からない」', [none._fallback, none.slots], [true, undefined]);

  // ★ここが顧客に効く差：index.js は _fallback を success:false + FALLBACK に直し、
  //   画面はGASへ聞き直す。slots:[] を返したら「空きがありません」と表示される。
  ok('★「分からない」に slots を入れない（0件に化けさせない）', !('slots' in none));
}

// ------------------------------------------------------------
// 6. 委譲前と**わざと変えたところ**（壊れた写しのときだけ・安全側へ）
//
//   総当たりで探して見つかった差はここだけ。いずれも「壊れた payload」の場合で、
//   委譲前は**顧客に0件（＝空きがありません）を見せていた**か、500 になっていた。
//   委譲後は「分からない」に倒してGASへ逃がす。
//     payload が null   … 旧：TypeError（500）→ 新：_fallback
//     payload が数・文字列 … 旧：0件（！）     → 新：_fallback
//   ★それ以外（正常な写し・rules 無し・壊れたJSON・古い写し）は完全に一致する。
// ------------------------------------------------------------
{
  const now = Date.now();
  const body = { trainerId: 't1' };
  const w = { role: 'customer', customerId: 'c1' };
  for (const [label, payload] of [['null', 'null'], ['数', '5'], ['文字列', '"x"']]) {
    const r = await compatTrainerSlots({
      env: cacheEnv({ payload, computed_at: now - MIN }), body, who: w,
    });
    eq(`★写しが壊れている（${label}）→ 0件ではなく「分からない」`,
       [r._fallback, r.slots], [true, undefined]);
  }
}

// ============================================================
// ①（calendar_events から計算）へ繋がっていること
//   D1の身代わりは node:sqlite（slots-route.test.js と同じ方針）
// ============================================================
const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(HERE, '..', 'schema.sql'), 'utf8');
const B1 = 'b1@group.calendar.google.com';
const TA = 'a@group.calendar.google.com';
const HASH = 'a'.repeat(64);

function makeEnv(vars = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const env = Object.assign({ SHARED_SECRET: 'TEST-SECRET', _db: db }, vars);
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
  };
  return env;
}

let evSeq = 0;
function world(vars = {}, opts = {}) {
  const env = makeEnv(vars);
  const now = Date.now();
  const { fromMs, toMs } = _slots.slotsRange(now);

  env._db.prepare(
    'INSERT INTO trainers (trainer_id, name, calendar_id, role, active, hidden) VALUES (?, ?, ?, ?, 1, 0)'
  ).run('t1', '鈴木', opts.noCalendar ? null : TA, 'trainer');

  const cals = [
    { calendar_id: B1, role: CAL_ROLE.CAPACITY_B1, trainer_id: null },
    { calendar_id: TA, role: CAL_ROLE.TRAINER, trainer_id: 't1' },
  ].sort((a, b) => (a.calendar_id < b.calendar_id ? -1 : 1));

  const r = env._db.prepare(
    `INSERT INTO calendar_snapshot
       (status, horizon_start, horizon_end, calendars, rule_version, flag_1f, content_hash,
        owner_window, built_at, created_at)
     VALUES ('ready', ?, ?, ?, 1, 'off', ?, NULL, ?, ?)`
  ).run(fromMs, toMs, JSON.stringify(cals), HASH, now, now);
  const gen = Number(r.lastInsertRowid);
  env._db.prepare('UPDATE calendar_active SET generation = ?, checked_at = ? WHERE id = 1')
    .run(gen, now);

  // 2日後の 13:00〜17:00（JST）に出勤 → 13/14/15/16 時の4枠（締め切りは余裕で前）
  const p = jstParts(now);
  const s = jstMs(p.year, p.month, p.day + 2, 13, 0);
  const e = jstMs(p.year, p.month, p.day + 2, 17, 0);
  env._db.prepare(
    `INSERT INTO calendar_events
       (generation, calendar_id, event_id, role, trainer_id, effect, reason, start_at, end_at, all_day)
     VALUES (?, ?, ?, ?, ?, ?, 'shift', ?, ?, 0)`
  ).run(gen, TA, 'e' + (++evSeq), CAL_ROLE.TRAINER, 't1', EV_KIND.SHIFT, s, e);

  return { env, now, gen, shiftStart: s, checkedAt: now };
}

function putCache(env, trainerId, startList, computedAt) {
  const slots = startList.map((ms) => ({
    startMs: ms, startISO: new Date(ms).toISOString(), endISO: new Date(ms + HOUR).toISOString(),
    trainerId, trainerName: '写し', trialOk: true,
    date: '2026/10/02', dayOfWeek: '金', startTime: 'cache', endTime: 'cache+1',
  }));
  env._db.prepare('INSERT OR REPLACE INTO slots_cache (trainer_id, payload, computed_at) VALUES (?, ?, ?)')
    .run(trainerId, JSON.stringify({ trainerId, slots, rules: null }), computedAt);
}

const who = { role: 'customer', customerId: 'c1' };

// --- ①が有効なとき①で答える ---
{
  const w = world({ SLOTS_FROM_CALENDAR: 'on', CAL_B1_CALENDAR_ID: B1 });
  putCache(w.env, 't1', [w.shiftStart], w.now);          // 写しには1枠だけ

  const direct = await routeSlots({ body: { trainerId: 't1' }, env: w.env, who });
  eq('★同じ入力で routeSlots は source:calendar と答える', direct.source, SLOT_SOURCE.CALENDAR);

  const r = await compatTrainerSlots({ body: { trainerId: 't1' }, env: w.env, who });
  eq('①でも _fallback は立たない', r._fallback, undefined);
  eq('★①の枠がそのまま画面の形で返る（出勤4時間＝4枠）', (r.slots || []).length, 4);
  eq('★①の枠もGASと同じ項目で返る', Object.keys(r.slots[0]).sort(),
     ['date', 'dayOfWeek', 'endISO', 'endTime', 'startISO', 'startTime',
      'trainerId', 'trainerName', 'trialOk'].sort());
  ok('★①の枠は写し（startTime:cache）ではない',
     r.slots.every((s) => s.startTime !== 'cache'), JSON.stringify(r.slots[0]));
  eq('★computedAt は①の確認時刻', r.computedAt, w.checkedAt);
  ok('①の並びは早い順', r.slots.map((s) => s.startISO).join(',')
     === r.slots.map((s) => s.startISO).slice().sort().join(','));

  // body.useCalendar でも①になる（オーナーの端末だけで試す経路）
  const w2 = world({ CAL_B1_CALENDAR_ID: B1 });
  putCache(w2.env, 't1', [w2.shiftStart], w2.now);
  const viaBody = await compatTrainerSlots({
    body: { trainerId: 't1', useCalendar: true }, env: w2.env, who,
  });
  eq('★body.useCalendar:true でも①の枠が返る', (viaBody.slots || []).length, 4);
  const off = await compatTrainerSlots({ body: { trainerId: 't1' }, env: w2.env, who });
  eq('★既定（useCalendar なし）では②のまま＝いまの顧客の答えが変わらない',
     (off.slots || []).map((s) => s.startTime), ['cache']);
}

// --- ①が有効でも②が無くても答えられる（①は写しに依存しない）---
{
  const w = world({ SLOTS_FROM_CALENDAR: 'on', CAL_B1_CALENDAR_ID: B1 });
  const r = await compatTrainerSlots({ body: { trainerId: 't1' }, env: w.env, who });
  eq('★①が動いていれば写しが無くても答える', [(r.slots || []).length, r._fallback], [4, undefined]);
}

// --- ①が使えないとき②に落ちる ---
{
  // カレンダーIDが無いトレーナー → ①は使わない（reason:'calendars'）
  const w = world({ SLOTS_FROM_CALENDAR: 'on', CAL_B1_CALENDAR_ID: B1 }, { noCalendar: true });
  putCache(w.env, 't1', [w.shiftStart], w.now);

  const direct = await routeSlots({ body: { trainerId: 't1' }, env: w.env, who });
  eq('①が使えない理由は calendars', [direct.source, direct.fallbackReason],
     [SLOT_SOURCE.CACHE, SLOT_FALLBACK.CALENDARS]);

  const r = await compatTrainerSlots({ body: { trainerId: 't1' }, env: w.env, who });
  eq('★①が使えなければ②の枠を返す（0件にしない）',
     (r.slots || []).map((s) => s.startTime), ['cache']);
  eq('②で答えたときも _fallback は立たない（写しは新しい）', r._fallback, undefined);
}

// --- ②も古い／無いとき＝「分からない」（①も使えない）---
{
  const w = world({ SLOTS_FROM_CALENDAR: 'on', CAL_B1_CALENDAR_ID: B1 }, { noCalendar: true });
  putCache(w.env, 't1', [w.shiftStart], w.now - (20 * MIN + 5000));
  const r = await compatTrainerSlots({ body: { trainerId: 't1' }, env: w.env, who });
  eq('★①が使えず②も古い → 答えない', [r._fallback, r.slots], [true, undefined]);
}
{
  const w = world({ SLOTS_FROM_CALENDAR: 'on', CAL_B1_CALENDAR_ID: B1 }, { noCalendar: true });
  const r = await compatTrainerSlots({ body: { trainerId: 't1' }, env: w.env, who });
  eq('★①が使えず②も無い → 答えない（0件ではない）', [r._fallback, r.slots], [true, undefined]);
}

// --- ①が例外になっても②へ逃げる（顧客を0件にしない）---
{
  const w = world({ SLOTS_FROM_CALENDAR: 'on', CAL_B1_CALENDAR_ID: B1 });
  putCache(w.env, 't1', [w.shiftStart], w.now);
  const realPrepare = w.env.DB.prepare.bind(w.env.DB);
  w.env.DB.prepare = (q) => {
    if (/calendar_events/.test(q)) throw new Error('boom');
    return realPrepare(q);
  };
  const warn = console.warn;
  console.warn = () => {};                 // ①の警告は想定どおりなので黙らせる
  const r = await compatTrainerSlots({ body: { trainerId: 't1' }, env: w.env, who });
  console.warn = warn;
  eq('★①が壊れても②の枠を返す', (r.slots || []).map((s) => s.startTime), ['cache']);
}

console.log(`\n空き枠の繋ぎ込み 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
