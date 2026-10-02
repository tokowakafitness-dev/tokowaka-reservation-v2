// ① カレンダー → D1 の受け取り口の検証（設計 ops/design/01-calendar-to-d1.md 第4版）
//
//   ここで固定したいのは、顧客に見える誤りに直結する4つ：
//     ① 合言葉のない経路を作らない
//     ② 中身が同じなら世代を増やさず checked_at だけ更新する
//        （取り違えると、2分変更がないだけでD1が使えなくなる／逆に古い世代が
//          新しく見えて翌月の要求が永久にGASへ落ち続ける）
//     ③ 公開前の検査が1つずつ効く。落ちたら公開中の世代は前のまま
//     ④ 書き込みが途中で失敗しても、公開中の世代は壊れない
//
//   D1の身代わりは node:sqlite（実物のSQLite）で作る。手書きの身代わりだと
//   「公開中の世代を除外する」「新しい順に3つ残す」といった削除の条件を
//   JSで並行実装することになり、検査したいSQLそのものが検査されない。
//   schema.sql をそのまま流し込むので、スキーマの誤りもここで落ちる。
//
//   実行: node worker/test/calsync.test.js（node:sqlite を使うので Node 22.5 以上）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { handleCalSync, _forTest } from '../src/routes/calsync.js';
import { _safeEqualForTest } from '../src/routes/ingest.js';

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
function makeEnv(opts = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const env = {
    SHARED_SECRET: opts.secret === undefined ? SECRET : opts.secret,
    _db: db, _sql: [],
    _hook: opts.hook || null,              // 並行する押し出しを割り込ませる
    _failOn: opts.failOn || null,          // わざと失敗させる文
    _failAfter: opts.failAfter == null ? 0 : opts.failAfter,
  };
  const exec = (q, args, how) => {
    env._sql.push({ q, args });
    if (env._hook) env._hook(q, db, args);
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
const active = (env) => one(env, 'SELECT generation, checked_at FROM calendar_active WHERE id = 1');
const snaps = (env) => rows(env, 'SELECT generation, status, built_at, created_at, reject_reasons, warnings FROM calendar_snapshot ORDER BY generation');
const evCount = (env, gen) => one(env, 'SELECT COUNT(*) AS n FROM calendar_events WHERE generation = ?', gen).n;

// ------------------------------------------------------------
// GASが送ってくる形
// ------------------------------------------------------------
const B1 = 'b1@group.calendar.google.com';
const TA = 'a@group.calendar.google.com';
const TB = 'b@group.calendar.google.com';
const TC = 'c@group.calendar.google.com';
const H_START = 1791100800000;        // 設計の例と同じ値
const H_END = 1793779200000;
const HASH = 'a'.repeat(64);
const HASH2 = 'b'.repeat(64);

const CALS = [
  { calendarId: B1, role: 'capacity_b1' },
  { calendarId: TA, role: 'trainer', trainerId: 'A' },
  { calendarId: TB, role: 'trainer', trainerId: 'B' },
  { calendarId: TC, role: 'trainer', trainerId: 'C' },
];

function ev(over) {
  return Object.assign({
    calendarId: TA, eventId: 'e1', role: 'trainer', trainerId: 'A',
    effect: 'busy', reason: 'reserved',
    startAt: H_START + 36000000, endAt: H_START + 39600000, allDay: 0,
  }, over);
}
// 3人全員に出勤がある、通る形
function baseEvents() {
  return [
    ev({ calendarId: TA, eventId: 'sA', trainerId: 'A', effect: 'shift', reason: 'shift' }),
    ev({ calendarId: TB, eventId: 'sB', trainerId: 'B', effect: 'shift', reason: 'shift' }),
    ev({ calendarId: TC, eventId: 'sC', trainerId: 'C', effect: 'shift', reason: 'shift' }),
    ev({ calendarId: TA, eventId: 'rA', trainerId: 'A', effect: 'busy', reason: 'reserved' }),
    ev({ calendarId: TB, eventId: 'bB', trainerId: 'B', effect: 'busy', reason: 'break' }),
    ev({ calendarId: B1, eventId: 'room1', role: 'capacity_b1', trainerId: null,
         effect: 'room_busy', reason: 'room' }),
  ];
}
function payload(over = {}) {
  return Object.assign({
    horizonStart: H_START, horizonEnd: H_END, ruleVersion: 1, flag1f: 'off',
    calendars: CALS, events: baseEvents(), contentHash: HASH, invalid: [],
  }, over);
}
//   secret に null を渡すと合言葉のヘッダそのものを付けない
function req(body, secret) {
  const h = { 'Content-Type': 'application/json' };
  if (secret != null) h['X-Ingest-Secret'] = secret;
  return new Request('https://x/calsync', { method: 'POST', headers: h, body: JSON.stringify(body) });
}
const send = async (env, body, secret = SECRET) => {
  const res = await handleCalSync(req(body, secret), env);
  return [res.status, await res.json()];
};
const codes = (b) => (b.reasons || []).map((r) => r.code).sort();
const warns = (b) => (b.warnings || []).map((w) => w.code).sort();

// ============================================================
// 1. 合言葉（ingest.js と同じ作法）
// ============================================================
{
  const env = makeEnv();
  eq('★合言葉なしでは受け付けない', (await send(env, payload(), null))[0], 403);
  eq('★違う合言葉でも受け付けない', (await send(env, payload(), 'WRONG'))[0], 403);
  eq('★合言葉なしでは1行も書かない', snaps(env).length, 0);
  eq('正しい合言葉なら受け付ける', (await send(env, payload()))[0], 200);
}
{
  const env = makeEnv({ secret: '' });
  eq('★合言葉が未設定なら何も受けない', (await send(env, payload(), 'anything'))[0], 503);
}
// 合言葉の比較が ingest.js と同じ答えになること（写したものが黙って食い違わないように）
{
  const pairs = [['abc', 'abc'], ['abc', 'abcd'], ['abc', 'abd'], ['', ''], ['', 'a'], ['あ', 'あ']];
  let same = true;
  for (const [a, b] of pairs) same = same && (_forTest.safeEqual(a, b) === _safeEqualForTest(a, b));
  ok('★合言葉の比較が ingest.js と同じ答えを出す', same);
}

// ============================================================
// 2. 形の検証（押し出す側が壊れている。世代としては記録しない）
// ============================================================
{
  const env = makeEnv();
  const bad = [
    ['BAD_HORIZON', { horizonStart: H_END, horizonEnd: H_START }],
    ['BAD_HORIZON', { horizonStart: null }],
    ['BAD_HORIZON', { horizonEnd: 'x' }],
    ['BAD_RULE_VERSION', { ruleVersion: 0 }],
    ['BAD_RULE_VERSION', { ruleVersion: '1' }],
    ['BAD_FLAG_1F', { flag1f: '' }],
    ['BAD_FLAG_1F', { flag1f: 'ON' }],
    ['BAD_CONTENT_HASH', { contentHash: '' }],
    ['BAD_CONTENT_HASH', { contentHash: 'A'.repeat(64) }],     // 大文字は受けない
    ['BAD_CONTENT_HASH', { contentHash: 'a'.repeat(63) }],
    ['BAD_CALENDARS', { calendars: [] }],
    ['BAD_CALENDARS', { calendars: 'x' }],
    ['EVENTS_NOT_ARRAY', { events: null }],
  ];
  for (const [code, over] of bad) {
    const [s, b] = await send(env, payload(over));
    eq(`★${code}（${JSON.stringify(over)}）`, [s, b.code], [400, code]);
  }
  eq('★形が違うものは世代を作らない', snaps(env).length, 0);
  eq('★形が違うものは公開中の世代を動かさない', active(env).generation, null);
}
{
  const env = makeEnv();
  const many = Array.from({ length: _forTest.MAX_EVENTS_TOTAL + 1 }, (_, i) => ev({ eventId: 'e' + i }));
  const [s, b] = await send(env, payload({ events: many }));
  eq('★多すぎる予定は受けない', [s, b.code], [413, 'TOO_MANY']);
}

// ============================================================
// 3. 初めての公開
// ============================================================
{
  const env = makeEnv();
  const [s, b] = await send(env, payload());
  eq('初回は公開される', [s, b.success, b.mode], [200, true, 'published']);
  eq('世代は1つ', snaps(env).length, 1);
  eq('status は ready', snaps(env)[0].status, 'ready');
  eq('公開中の世代が差し替わる', active(env).generation, b.generation);
  eq('予定が全部入る', evCount(env, b.generation), 6);
  ok('checked_at が入る', active(env).checked_at > 0);
  eq('警告は無い', warns(b), []);
  // 役割と効果がそのまま入っていること（氏名は入らない）
  const room = one(env, 'SELECT role, trainer_id, effect, reason FROM calendar_events WHERE event_id = ?', 'room1');
  eq('部屋の予定は role=capacity_b1 / trainer_id は空', [room.role, room.trainer_id, room.effect], ['capacity_b1', null, 'room_busy']);
}

// ============================================================
// 4. 中身が前回と同じなら世代を増やさない（★ここが一番大事）
// ============================================================
{
  const env = makeEnv();
  const [, first] = await send(env, payload());
  const builtAt = snaps(env)[0].built_at;
  const before = active(env).checked_at;
  const mark = env._sql.length;                 // ここから2回目の押し出し
  await new Promise((r) => setTimeout(r, 5));

  const [s, b] = await send(env, payload());
  eq('★同じ中身なら世代を増やさない', [s, b.mode, b.generation], [200, 'unchanged', first.generation]);
  eq('★世代は1つのまま', snaps(env).length, 1);
  eq('★built_at は動かさない（世代を作っていないので）', snaps(env)[0].built_at, builtAt);
  ok('★checked_at は毎回更新する（鮮度はこちらで見る）', active(env).checked_at > before,
     `before=${before} after=${active(env).checked_at}`);
  eq('★予定は書き直さない', evCount(env, first.generation), 6);
  // 2回目で走った書き込みを数える（1,440回/日の押し出しでD1の書き込み枠を食い潰さないため）
  const second = env._sql.slice(mark);
  const w = (re) => second.filter((x) => re.test(x.q)).length;
  eq('★変更がない回に書くのは checked_at の1行だけ',
     [w(/UPDATE calendar_active SET checked_at/), w(/INSERT INTO calendar_events/),
      w(/INSERT INTO calendar_snapshot/), w(/DELETE FROM/)], [1, 0, 0, 0]);
}

// ---- 取得仕様が変われば、ハッシュが同じでも新しい世代を作る ----
//   ★content_hash だけで判定すると、25日に地平が伸びてもその範囲に予定が無ければ
//     「同じ」と見えて horizon_end が古いまま checked_at だけ新しくなる。
//     すると翌月の要求が永久にGASへ落ち続ける。
{
  const cases = [
    ['地平の始まりが変わった', { horizonStart: H_START - 86400000 }],
    ['地平の終わりが伸びた', { horizonEnd: H_END + 86400000 * 31 }],
    ['規則の版が上がった', { ruleVersion: 2 }],
    ['1Fフラグが変わった', { flag1f: 'on' }],
    ['カレンダーが増えた', { calendars: CALS.concat([{ calendarId: 'd@x', role: 'trainer', trainerId: 'D' }]) }],
    ['カレンダーの役割が入れ替わった', {
      calendars: [{ calendarId: B1, role: 'capacity_b1' },
                  { calendarId: TA, role: 'trainer', trainerId: 'A' },
                  { calendarId: TB, role: 'trainer', trainerId: 'B' },
                  { calendarId: TC, role: 'trainer', trainerId: 'Z' }],
      events: baseEvents().map((e) => (e.calendarId === TC ? Object.assign({}, e, { trainerId: 'Z' }) : e)),
    }],
  ];
  for (const [name, over] of cases) {
    const env = makeEnv();
    const [, first] = await send(env, payload());
    const [s, b] = await send(env, payload(over));   // contentHash は同じ
    eq(`★${name} → ハッシュが同じでも新しい世代を作る`,
       [s, b.mode, b.generation > first.generation], [200, 'published', true]);
    eq(`★${name} → 公開中の世代も差し替わる`, active(env).generation, b.generation);
  }
}
{
  // 並びだけが違うカレンダー一覧は「同じ構成」とみなす（正規化しているため）
  const env = makeEnv();
  await send(env, payload());
  const [, b] = await send(env, payload({ calendars: CALS.slice().reverse() }));
  eq('★並び順だけの違いで世代を増やさない', b.mode, 'unchanged');
}
{
  // 中身の印が変われば当然新しい世代
  const env = makeEnv();
  const [, first] = await send(env, payload());
  const [, b] = await send(env, payload({ contentHash: HASH2 }));
  eq('中身の印が変われば新しい世代', [b.mode, b.generation > first.generation], ['published', true]);
}

// ============================================================
// 5. 公開前の検査（§6）。1つずつ、わざと壊して拒否されることを確かめる
// ============================================================
async function rejectCase(name, over, wantCode, baseOver) {
  const env = makeEnv();
  const [, first] = await send(env, payload(baseOver || {}));   // まず正しい世代を公開しておく
  const gen0 = active(env).generation;
  const checked0 = active(env).checked_at;

  const [s, b] = await send(env, payload(Object.assign({ contentHash: HASH2 }, over)));
  eq(`★${name} → 拒否する`, [s, b.code, codes(b).includes(wantCode)], [422, 'REJECTED', true]);
  eq(`★${name} → 公開中の世代は前のまま`, active(env).generation, gen0);
  eq(`★${name} → checked_at も動かさない（確認できていないので）`, active(env).checked_at, checked0);
  const rejected = snaps(env).filter((x) => x.status === 'rejected');
  eq(`${name} → 落ちた世代は残す（原因を追うため）`, rejected.length, 1);
  ok(`${name} → 理由を記録する`, /\[\{"code":/.test(rejected[0].reject_reasons || ''));
  eq(`★${name} → 落ちた世代の予定は書かない`, evCount(env, rejected[0].generation), 0);
  eq(`${name} → 前の世代の予定は残る`, evCount(env, gen0), (payload(baseOver || {}).events).length);
  return { env, first, body: b };
}

// GASが「壊れている」と言ってきた予定が1件でもあれば公開しない
await rejectCase('GASが壊れた予定を報告した',
  { invalid: [{ calendarId: TA, eventId: 'x', reason: 'REVERSED' }] }, 'GAS_INVALID_EVENTS');

// 取得：必要なカレンダーが揃っていない
await rejectCase('B1（部屋）が無い', {
  calendars: CALS.filter((c) => c.role !== 'capacity_b1'),
  events: baseEvents().filter((e) => e.calendarId !== B1),
}, 'CAPACITY_B1_MISSING');
await rejectCase('トレーナーのカレンダーが足りない', {
  calendars: CALS.filter((c) => c.calendarId !== TC),
  events: baseEvents().filter((e) => e.calendarId !== TC),
}, 'TRAINER_CALENDARS_MISSING');
await rejectCase('同じカレンダーが2回入っている',
  { calendars: CALS.concat([{ calendarId: B1, role: 'capacity_b1' }]) }, 'DUPLICATE_CALENDAR');
await rejectCase('トレーナーのカレンダーにIDが無い', {
  calendars: [{ calendarId: B1, role: 'capacity_b1' },
              { calendarId: TA, role: 'trainer' },
              { calendarId: TB, role: 'trainer', trainerId: 'B' },
              { calendarId: TC, role: 'trainer', trainerId: 'C' }],
}, 'CALENDAR_TRAINER_ID_MISSING');

// ★役割の綴り違いを通すと、部屋の予定が「席が空いている」と判定されて二重予約になる。
//   判定は calclass.js の classifyEvent に任せる（知らない役割で落ちる）。
await rejectCase('役割の綴りが CAL_ROLE と違う（room）', {
  calendars: [{ calendarId: B1, role: 'room' },
              { calendarId: TA, role: 'trainer', trainerId: 'A' },
              { calendarId: TB, role: 'trainer', trainerId: 'B' },
              { calendarId: TC, role: 'trainer', trainerId: 'C' }],
  events: baseEvents().map((e) => (e.calendarId === B1 ? Object.assign({}, e, { role: 'room' }) : e)),
}, 'UNKNOWN_ROLE');
await rejectCase('予定の役割が CAL_ROLE に無い',
  { events: baseEvents().concat([ev({ eventId: 'zz', role: 'trainer_x' })]) }, 'ROLE_CONFLICT');

// 中身
await rejectCase('同じ (calendar_id, event_id) が重複している',
  { events: baseEvents().concat([ev({ eventId: 'rA' })]) }, 'DUPLICATE_EVENT');
for (const [name, over] of [
  ['終わりが始まりより前', { startAt: H_START + 7200000, endAt: H_START + 3600000 }],
  ['幅0', { startAt: H_START + 3600000, endAt: H_START + 3600000 }],
  ['日時が整数でない', { startAt: '1791151200000' }],
  ['日時が欠けている', { startAt: undefined }],
  ['日時が null', { endAt: null }],
]) {
  await rejectCase('壊れた日時（' + name + '）',
    { events: baseEvents().concat([ev({ eventId: 'brk', ...over })]) }, 'BAD_INTERVAL');
}
await rejectCase('地平とまったく重ならない予定がある',
  { events: baseEvents().concat([ev({ eventId: 'past', startAt: H_START - 7200000, endAt: H_START - 3600000 })]) },
  'OUT_OF_HORIZON');
await rejectCase('地平の終わりより後ろの予定がある',
  { events: baseEvents().concat([ev({ eventId: 'future', startAt: H_END, endAt: H_END + 3600000 })]) },
  'OUT_OF_HORIZON');
await rejectCase('一覧に無いカレンダーの予定が混ざっている',
  { events: baseEvents().concat([ev({ eventId: 'ghost', calendarId: 'evil@x' })]) }, 'UNDECLARED_CALENDAR');
await rejectCase('担当が一覧と食い違う',
  { events: baseEvents().concat([ev({ eventId: 'mix', trainerId: 'B' })]) }, 'TRAINER_ID_CONFLICT');
await rejectCase('部屋の予定に shift が付いている',
  { events: baseEvents().map((e) => (e.calendarId === B1 ? Object.assign({}, e, { effect: 'shift' }) : e)) },
  'EFFECT_ROLE_MISMATCH');
await rejectCase('トレーナーの予定に room_busy が付いている',
  { events: baseEvents().concat([ev({ eventId: 'rb', effect: 'room_busy', reason: 'room' })]) },
  'EFFECT_ROLE_MISMATCH');
await rejectCase('知らない効果',
  { events: baseEvents().concat([ev({ eventId: 'unk', effect: 'free' })]) }, 'EFFECT_ROLE_MISMATCH');
await rejectCase('終日の印が 0/1 でない',
  { events: baseEvents().concat([ev({ eventId: 'ad', allDay: true })]) }, 'BAD_ALL_DAY');
await rejectCase('埋まりの理由が無い',
  { events: baseEvents().concat([ev({ eventId: 'nr', reason: '' })]) }, 'REASON_MISSING');
await rejectCase('予定のIDが無い',
  { events: baseEvents().concat([ev({ eventId: '' })]) }, 'EVENT_KEY_MISSING');

// 運用：トレーナー3人全員の出勤が0件
await rejectCase('全員の出勤が0件',
  { events: baseEvents().filter((e) => e.effect !== 'shift') }, 'NO_SHIFTS');

// 1カレンダー5,000件を超えたら公開しない（§5）
{
  const over = { events: baseEvents().concat(
    Array.from({ length: _forTest.MAX_EVENTS_PER_CALENDAR + 1 }, (_, i) => ev({ eventId: 'm' + i }))) };
  const env = makeEnv();
  await send(env, payload());
  const [s, b] = await send(env, payload(Object.assign({ contentHash: HASH2 }, over)));
  eq('★1カレンダーが5,000件を超えたら公開しない', [s, codes(b).includes('CALENDAR_TOO_MANY')], [422, true]);
}

// 理由に氏名・タイトルを残さない（§4）
{
  const env = makeEnv();
  await send(env, payload());
  const dirty = ev({ eventId: 'ghost', calendarId: 'evil@x', title: '山田太郎', summary: '山田太郎 60分' });
  const [, b] = await send(env, payload({ contentHash: HASH2, events: baseEvents().concat([dirty]) }));
  const stored = JSON.stringify(snaps(env).filter((x) => x.status === 'rejected'));
  ok('★拒否の理由に氏名を残さない', stored.indexOf('山田') < 0 && JSON.stringify(b.reasons).indexOf('山田') < 0);
}

// 落ちた世代が増えても、公開中の世代は動かない
{
  const env = makeEnv();
  const [, first] = await send(env, payload());
  for (let i = 0; i < 3; i++) {
    await send(env, payload({ contentHash: HASH2, invalid: [{ calendarId: TA, eventId: 'x' + i, reason: 'REVERSED' }] }));
  }
  eq('★何度拒否されても公開中の世代は前のまま', active(env).generation, first.generation);
  eq('落ちた世代は3つ残る', snaps(env).filter((x) => x.status === 'rejected').length, 3);
}

// ============================================================
// 6. 警告（公開はするが記録して知らせる）
// ============================================================
{
  const env = makeEnv();
  const [s, b] = await send(env, payload({
    events: baseEvents().filter((e) => !(e.effect === 'shift' && e.trainerId === 'C')),
  }));
  eq('★1人だけ出勤0件なら公開する（休業がありうる）', [s, b.mode], [200, 'published']);
  eq('★ただし警告として知らせる', warns(b), ['SHIFT_ZERO_SOME']);
  ok('★警告を世代に記録する', /SHIFT_ZERO_SOME/.test(snaps(env)[0].warnings || ''));
}
{
  const env = makeEnv();
  await send(env, payload({ events: baseEvents().concat(
    Array.from({ length: 20 }, (_, i) => ev({ eventId: 'x' + i }))) }));
  const [, b] = await send(env, payload({ contentHash: HASH2 }));   // 26件 → 6件
  eq('★件数が半分以下に減ったら警告する', warns(b).includes('COUNT_DROP'), true);
}
{
  const env = makeEnv();
  const [, b] = await send(env, payload({ flag1f: 'on' }));
  eq('★1Fフラグが on なら警告する（D1の空き枠は使わせない）', warns(b).includes('FLAG_1F_ON'), true);
  eq('公開そのものは止めない', b.mode, 'published');
}

// ============================================================
// 7. 古い世代を消す（§8）
// ============================================================
{
  const env = makeEnv();
  const now = Date.now();
  const ins = (gen, status, createdAt) => env._db.prepare(
    `INSERT INTO calendar_snapshot (generation, status, horizon_start, horizon_end, calendars,
       rule_version, flag_1f, content_hash, built_at, created_at)
     VALUES (?, ?, ?, ?, '[]', 1, 'off', ?, ?, ?)`
  ).run(gen, status, H_START, H_END, HASH, createdAt, createdAt);
  const insEv = (gen) => env._db.prepare(
    `INSERT INTO calendar_events (generation, calendar_id, event_id, role, trainer_id, effect, reason,
       start_at, end_at, all_day) VALUES (?, ?, 'e', 'trainer', 'A', 'busy', 'reserved', ?, ?, 0)`
  ).run(gen, TA, H_START, H_START + 1);
  for (const g of [1, 2, 3, 4, 5]) { ins(g, 'ready', now - 3600000); insEv(g); }
  ins(10, 'rejected', now - 25 * 3600000);
  ins(11, 'rejected', now - 3600000);
  ins(12, 'building', now - 30 * 60000);
  ins(13, 'building', now - 1000);

  await _forTest.cleanupGenerations(env, 1, now);     // 公開中が 1（新しい順では残らない位置）
  const left = snaps(env).map((x) => x.generation);
  eq('★公開中の世代は、古くても消さない', left.includes(1), true);
  eq('★ready は新しい順に3つ残す', [left.includes(3), left.includes(4), left.includes(5)], [true, true, true]);
  eq('★それ以外の ready は消す', left.includes(2), false);
  eq('★消した世代の予定も消す', evCount(env, 2), 0);
  eq('★残した世代の予定は消さない', [evCount(env, 1), evCount(env, 5)], [1, 1]);
  eq('★24時間を過ぎた rejected は消す', left.includes(10), false);
  eq('★24時間以内の rejected は残す（原因を追うため）', left.includes(11), true);
  const st = (g) => (snaps(env).find((x) => x.generation === g) || {}).status;
  eq('★放置された building は rejected にして原因を残す', st(12), 'rejected');
  ok('★その理由も書く', /ABANDONED_BUILDING/.test((snaps(env).find((x) => x.generation === 12) || {}).reject_reasons || ''));
  eq('★作りかけの building は触らない', st(13), 'building');
}
{
  // 公開中の世代が building だった場合も消さない（ありえないが、条件の確認）
  const env = makeEnv();
  const now = Date.now();
  env._db.prepare(
    `INSERT INTO calendar_snapshot (generation, status, horizon_start, horizon_end, calendars,
       rule_version, flag_1f, content_hash, built_at, created_at)
     VALUES (7, 'building', ?, ?, '[]', 1, 'off', ?, ?, ?)`
  ).run(H_START, H_END, HASH, now - 3600000, now - 3600000);
  await _forTest.cleanupGenerations(env, 7, now);
  eq('★公開中は building でも rejected にしない', snaps(env)[0].status, 'building');
}
{
  // 掃除が失敗しても公開は成功させる（§8）
  const env = makeEnv({ failOn: /DELETE FROM calendar_events/ });
  const [s, b] = await send(env, payload());
  eq('★掃除の失敗で公開を失敗させない', [s, b.mode], [200, 'published']);
  eq('公開中の世代は差し替わっている', active(env).generation, b.generation);
}

// ============================================================
// 8. 公開の瞬間に条件を確かめる（巻き戻しを防ぐ）
// ============================================================
{
  // 予定を書いている最中に、別の押し出しが公開してしまった場合
  const env = makeEnv();
  const [, first] = await send(env, payload());
  let done = false;
  env._hook = (q, db) => {
    if (!done && /INSERT INTO calendar_events/.test(q)) {
      done = true;
      db.prepare('UPDATE calendar_active SET generation = 999 WHERE id = 1').run();
    }
  };
  const [s, b] = await send(env, payload({ contentHash: HASH2 }));
  eq('★公開中の世代が変わっていたら公開しない', [s, b.code], [409, 'PUBLISH_RACE']);
  eq('★古い結果で巻き戻さない', active(env).generation, 999);
  eq('★公開できなかった世代は building のまま残る',
     (snaps(env).find((x) => x.generation === b.generation) || {}).status, 'building');
}
{
  // 変更が無くて checked_at だけ更新するときも、同じ条件を付ける
  const env = makeEnv();
  await send(env, payload());
  env._hook = (q, db) => {
    if (/UPDATE calendar_active SET checked_at/.test(q)) {
      db.prepare('UPDATE calendar_active SET generation = 888 WHERE id = 1').run();
    }
  };
  const [s, b] = await send(env, payload());
  eq('★変更がない回も条件付きで更新する', [s, b.code], [409, 'PUBLISH_RACE']);
}

// ============================================================
// 9. 書き込みの途中で失敗しても、公開中の世代は壊れない
// ============================================================
{
  const big = baseEvents().concat(Array.from({ length: 120 }, (_, i) => ev({ eventId: 'big' + i })));
  const env = makeEnv({ failOn: /INSERT INTO calendar_events/, failAfter: _forTest.INSERT_CHUNK });
  const [, first] = await send(env, payload());          // まず正しい世代を公開
  const gen0 = active(env).generation;
  const checked0 = active(env).checked_at;

  const [s, b] = await send(env, payload({ contentHash: HASH2, events: big }));
  eq('★途中で失敗したら500を返す', [s, b.code], [500, 'INTERNAL']);
  eq('★公開中の世代は前のまま', active(env).generation, gen0);
  eq('★checked_at も動かない', active(env).checked_at, checked0);
  eq('★前の世代の予定は無傷', evCount(env, gen0), 6);
  const half = snaps(env).find((x) => x.generation !== gen0);
  eq('★書きかけの世代は building のまま（公開されない）', half.status, 'building');
  ok('★書きかけの世代は中途半端に残るが、公開中ではない', evCount(env, half.generation) < big.length);
}

// ============================================================
// 10. タイトル・氏名をD1に持たない（設計 §4）
// ============================================================
{
  const env = makeEnv();
  const cols = (t) => rows(env, `SELECT name FROM pragma_table_info(?)`, t).map((r) => r.name);
  const ev1 = cols('calendar_events');
  eq('★予定の表は分類の結果だけを持つ', ev1,
     ['generation', 'calendar_id', 'event_id', 'role', 'trainer_id', 'effect', 'reason',
      'start_at', 'end_at', 'all_day']);
  ok('★タイトルを入れる列が無い', !ev1.some((c) => /title|summary|name|member|customer/.test(c)));
  ok('★世代の表にもタイトルを入れる列が無い',
     !cols('calendar_snapshot').some((c) => /title|summary|name|member|customer/.test(c)));
  // GASが誤ってタイトルを混ぜて送ってきても、保存しない
  const [, b] = await send(env, payload({
    events: baseEvents().map((e) => Object.assign({}, e, { title: '山田太郎' })),
  }));
  const dump = JSON.stringify(rows(env, 'SELECT * FROM calendar_events WHERE generation = ?', b.generation));
  ok('★送られてきたタイトルは保存しない', dump.indexOf('山田') < 0);
}

// ============================================================
// 11. 遅れて届いた押し出しで鮮度を偽らない（pushedAt は任意）
// ============================================================
{
  const env = makeEnv();
  await send(env, payload());
  const checked0 = active(env).checked_at;
  const [s, b] = await send(env, payload({ pushedAt: Date.now() - _forTest.MAX_PUSH_AGE_MS - 1000 }));
  eq('★2分より古い押し出しは受けない', [s, b.code], [409, 'STALE_PUSH']);
  eq('★checked_at を新しくしない', active(env).checked_at, checked0);
  const [s2, b2] = await send(env, payload({ pushedAt: Date.now() }));
  eq('直前の押し出しなら受ける', [s2, b2.mode], [200, 'unchanged']);
}

// ============================================================
// 12. 検査の部品（calclass に判定を任せていること）
// ============================================================
{
  const effTrainer = [..._forTest.allowedEffects('trainer')].sort();
  const effRoom = [..._forTest.allowedEffects('capacity_b1')].sort();
  eq('★トレーナーで出る効果は calclass が決める', effTrainer, ['busy', 'ignore', 'shift']);
  eq('★部屋で出る効果は calclass が決める', effRoom, ['ignore', 'room_busy']);
  let threw = false;
  try { _forTest.allowedEffects('room'); } catch (_) { threw = true; }
  ok('★知らない役割は calclass が落とす（fail-closed）', threw);
}
{
  const n = _forTest.normalizeCalendars([
    { calendarId: 'z@x', role: 'trainer', trainerId: 'Z' },
    { calendarId: 'a@x', role: 'capacity_b1' },
  ]);
  eq('★構成は calendar_id 順・キーの順も固定（文字列1回で比べられる）', n,
     [{ calendar_id: 'a@x', role: 'capacity_b1', trainer_id: null },
      { calendar_id: 'z@x', role: 'trainer', trainer_id: 'Z' }]);
}

// ============================================================
// ★1Fカレンダーを含む押し出し（2026-10-02）
//
//   本番は LB_1F_TRAINER_BLOCK=on なので、1Fを含む押し出しが毎分来る。
//   それなのに1Fを含むテストが1件も無かった。
//   実際、1Fの分岐で宣言していない変数を参照しており、
//   **1Fを含む押し出しが来た瞬間に 500 で全部落ちる**状態だった。
//   本番で踏んでいなかったのは、1Fをまだ送っていなかったから。
//
//   1Fは「予定ごとに担当が変わる」唯一の役割なので、他と同じ検査にかけられない。
//   ここを塞いでおかないと、1Fを有効にした瞬間にD1が永久に止まる。
// ============================================================
const F1 = 'f1@group.calendar.google.com';
const CALS_1F = CALS.concat([{ calendarId: F1, role: 'capacity_1f' }]);

function events1F(extra = []) {
  return baseEvents().concat(extra);
}
function payload1F(over = {}) {
  return payload(Object.assign({ calendars: CALS_1F, flag1f: 'on' }, over));
}

{
  // ① 担当が分かるオンライン（busy + trainerId）＝通る
  const env = makeEnv();
  const body = payload1F({
    events: events1F([ev({ calendarId: F1, eventId: 'f1a', role: 'capacity_1f',
                           trainerId: 'B', effect: 'busy', reason: 'online' })]),
    contentHash: 'c'.repeat(64)
  });
  const [st, b] = await send(env, body);
  eq('★1Fの担当つきオンラインは通る', [st, b.success], [200, true]);
  ok('★500で落ちない（宣言していない変数を参照していないか）', st !== 500);
  ok('★拒否されていない', b.code !== 'REJECTED');
  // 実際に公開されたこと（公開中の世代が立っている）
  const act = one(env, 'SELECT generation FROM calendar_active WHERE id = 1');
  ok('★公開中の世代が立つ', act && act.generation != null);
}
{
  // ② 担当が分からないオンライン（room_busy + 担当なし）＝通る
  const env = makeEnv();
  const body = payload1F({
    events: events1F([ev({ calendarId: F1, eventId: 'f1b', role: 'capacity_1f',
                           trainerId: null, effect: 'room_busy', reason: 'online_unknown' })]),
    contentHash: 'd'.repeat(64)
  });
  const [st, b] = await send(env, body);
  eq('★1Fの担当不明は通る（全員を塞ぐ）', [st, b.success], [200, true]);
  ok('★拒否されていない', b.code !== 'REJECTED');
}
{
  // ③ busy なのに担当がない＝拒否（誰を塞ぐか決まらない）
  const env = makeEnv();
  const body = payload1F({
    events: events1F([ev({ calendarId: F1, eventId: 'f1c', role: 'capacity_1f',
                           trainerId: null, effect: 'busy', reason: 'online' })]),
    contentHash: 'e'.repeat(64)
  });
  const [st, b] = await send(env, body);
  eq('★1Fのbusyに担当がなければ拒否', [st, b.code], [422, 'REJECTED']);
  ok('★理由は TRAINER_ID_MISSING',
     (b.reasons || []).some(r => r.code === 'TRAINER_ID_MISSING'));
}
{
  // ④ room_busy なのに担当がある＝拒否（全員を塞ぐのか1人なのか決まらない）
  const env = makeEnv();
  const body = payload1F({
    events: events1F([ev({ calendarId: F1, eventId: 'f1d', role: 'capacity_1f',
                           trainerId: 'B', effect: 'room_busy', reason: 'online_unknown' })]),
    contentHash: 'f'.repeat(64)
  });
  const [st, b] = await send(env, body);
  eq('★1Fのroom_busyに担当があれば拒否', [st, b.code], [422, 'REJECTED']);
  ok('★理由は TRAINER_ID_UNEXPECTED',
     (b.reasons || []).some(r => r.code === 'TRAINER_ID_UNEXPECTED'));
}
{
  // ⑤ 1Fに shift は無い（出勤はトレーナーのカレンダーだけ）
  const env = makeEnv();
  const body = payload1F({
    events: events1F([ev({ calendarId: F1, eventId: 'f1e', role: 'capacity_1f',
                           trainerId: null, effect: 'shift', reason: 'shift' })]),
    contentHash: '1'.repeat(64)
  });
  const [st, b] = await send(env, body);
  eq('★1Fのshiftは拒否', [st, b.code], [422, 'REJECTED']);
  ok('★理由は EFFECT_ROLE_MISMATCH',
     (b.reasons || []).some(r => r.code === 'EFFECT_ROLE_MISMATCH'));
}
{
  // ⑥ B1の担当つきは拒否（部屋に担当の概念がない）
  const env = makeEnv();
  const body = payload({
    events: baseEvents().concat([ev({ calendarId: B1, eventId: 'r2', role: 'capacity_b1',
                                      trainerId: 'B', effect: 'room_busy', reason: 'room' })]),
    contentHash: '2'.repeat(64)
  });
  const [st, b] = await send(env, body);
  eq('★B1に担当があれば拒否', [st, b.code], [422, 'REJECTED']);
}
{
  // ⑦ トレーナーのカレンダーは宣言と突き合わせる（1Fだけが例外）
  const env = makeEnv();
  const body = payload({
    events: baseEvents().concat([ev({ calendarId: TA, eventId: 'x1', trainerId: 'B' })]),
    contentHash: '3'.repeat(64)
  });
  const [st, b] = await send(env, body);
  eq('★トレーナーの担当が宣言と違えば拒否', [st, b.code], [422, 'REJECTED']);
  ok('★理由は TRAINER_ID_CONFLICT',
     (b.reasons || []).some(r => r.code === 'TRAINER_ID_CONFLICT'));
}
{
  // ⑧ 1Fを含む押し出しが、実際にD1に入って読み出せる
  const env = makeEnv();
  const body = payload1F({
    events: events1F([ev({ calendarId: F1, eventId: 'f1f', role: 'capacity_1f',
                           trainerId: 'C', effect: 'busy', reason: 'online' })]),
    contentHash: '4'.repeat(64)
  });
  const [st, b8] = await send(env, body);
  eq('★1Fを含む世代が公開される', [st, b8.code !== 'REJECTED'], [200, true]);
  const f1rows = rows(env, 'SELECT role, trainer_id, effect FROM calendar_events WHERE calendar_id = ?', F1);
  eq('★1Fの予定が1件入る', f1rows.length, 1);
  eq('★担当つきで入る', [f1rows[0].role, f1rows[0].trainer_id, f1rows[0].effect],
     ['capacity_1f', 'C', 'busy']);
}

console.log(`\nカレンダー受け取り口 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
