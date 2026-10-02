// ① カレンダー → D1 の読み取り側の検証（設計 ops/design/01-calendar-to-d1.md §7）
//
//   ここで固定したいのは、顧客に見える誤りに直結する4つ：
//     ① 「使えるが予定が0件（＝本当に空いている）」と「そもそも使えない（＝分からない）」を
//        区別できること。これを混ぜると、障害が「空きがありません」に化けて黙って予約を失う。
//     ② 可否判定と予定の取得が**1回のSQL**であること。2回に分けると、その間に
//        §8の削除が走って「使ってよい」と答えた直後に予定が消え、やはり空きなしに化ける。
//     ③ 鮮度・規則の版・1Fフラグ・カレンダー構成・地平の5つが**それぞれ独立に**効くこと。
//        1つでも抜けると「古いものが新しく見える」状態になる。
//     ④ 重なりの判定が calclass と同じであること（接するだけは重ならない・1msでも重なる）。
//
//   D1の身代わりは node:sqlite（実物のSQLite）で作り、schema.sql をそのまま流す。
//   手書きの身代わりだと LEFT JOIN の挙動を自分で書くことになり、**検査したいSQLそのものが
//   検査されない。**（calsync.test.js と同じ方針）
//
//   実行: node worker/test/calread.test.js（node:sqlite を使うので Node 22.5 以上）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readCalendar, FRESH_MS, MAX_CLOCK_SKEW_MS, CALREAD_REASON, _forTest } from '../src/lib/calread.js';
import { CAL_ROLE, EV_KIND } from '../src/lib/calclass.js';
import { handleCalSync } from '../src/routes/calsync.js';

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
// D1の身代わり（実物のSQLite）。発行されたSQLを数える。
// ------------------------------------------------------------
function makeEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const env = { SHARED_SECRET: SECRET, _db: db, _sql: [] };
  const exec = (q, args, how) => {
    env._sql.push({ q, args });
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

// ------------------------------------------------------------
// 値（calsync.test.js と同じ地平を使う）
// ------------------------------------------------------------
const B1 = 'b1@group.calendar.google.com';
const F1 = '1f@group.calendar.google.com';
const TA = 'a@group.calendar.google.com';
const TB = 'b@group.calendar.google.com';
const TC = 'c@group.calendar.google.com';
const H_START = 1791100800000;
const H_END = 1793779200000;
const RULE = 1;
const NOW = H_START + 3600000;
const Q_FROM = H_START + 36000000;          // 10:00
const Q_TO = Q_FROM + 7200000;              // 12:00
const HASH = 'a'.repeat(64);

// 世代に入っている構成（calsync が書く正規形：calendar_id 順・snake_case）
function calsJson(extra) {
  const list = [
    { calendar_id: B1, role: CAL_ROLE.CAPACITY_B1, trainer_id: null },
    { calendar_id: TA, role: CAL_ROLE.TRAINER, trainer_id: 'A' },
    { calendar_id: TB, role: CAL_ROLE.TRAINER, trainer_id: 'B' },
    { calendar_id: TC, role: CAL_ROLE.TRAINER, trainer_id: 'C' },
  ].concat(extra || []);
  list.sort((a, b) => (a.calendar_id < b.calendar_id ? -1 : a.calendar_id > b.calendar_id ? 1 : 0));
  return JSON.stringify(list);
}

// 呼び出し側が渡す「必要なカレンダー」（役割・担当まで指定して構成の入れ替わりも見る）
const REQUIRED = [
  { calendarId: B1, role: CAL_ROLE.CAPACITY_B1 },
  { calendarId: TA, role: CAL_ROLE.TRAINER, trainerId: 'A' },
  { calendarId: TB, role: CAL_ROLE.TRAINER, trainerId: 'B' },
  { calendarId: TC, role: CAL_ROLE.TRAINER, trainerId: 'C' },
];

function addGen(env, over = {}) {
  const g = Object.assign({
    status: 'ready', horizonStart: H_START, horizonEnd: H_END, ruleVersion: RULE,
    flag1f: 'off', calendars: calsJson(), contentHash: HASH, builtAt: NOW, createdAt: NOW,
  }, over);
  const r = env._db.prepare(
    `INSERT INTO calendar_snapshot
       (status, horizon_start, horizon_end, calendars, rule_version, flag_1f, content_hash, built_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(g.status, g.horizonStart, g.horizonEnd, g.calendars, g.ruleVersion, g.flag1f,
        g.contentHash, g.builtAt, g.createdAt);
  return Number(r.lastInsertRowid);
}

function addEvents(env, gen, list) {
  const st = env._db.prepare(
    `INSERT INTO calendar_events
       (generation, calendar_id, event_id, role, trainer_id, effect, reason, start_at, end_at, all_day)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const e of list) {
    st.run(gen, e.calendarId, e.eventId, e.role, e.trainerId == null ? null : e.trainerId,
           e.effect, e.reason, e.startAt, e.endAt, e.allDay == null ? 0 : e.allDay);
  }
}

function activate(env, gen, checkedAt) {
  env._db.prepare('UPDATE calendar_active SET generation = ?, checked_at = ? WHERE id = 1')
    .run(gen, checkedAt === undefined ? NOW : checkedAt);
}

// 「公開中の ready な世代が1つある」状態を作る
function ready(env, over = {}, events = []) {
  const gen = addGen(env, over);
  if (events.length) addEvents(env, gen, events);
  activate(env, gen, over.checkedAt === undefined ? NOW : over.checkedAt);
  return gen;
}

async function read(env, over = {}) {
  env._sql.length = 0;
  return readCalendar(env, Object.assign({
    fromMs: Q_FROM, toMs: Q_TO, ruleVersion: RULE, flag1f: 'off',
    requiredCalendars: REQUIRED, nowMs: NOW,
  }, over));
}

// 枠の中にある、ふつうの予定
function ev(over) {
  return Object.assign({
    calendarId: TA, eventId: 'e1', role: CAL_ROLE.TRAINER, trainerId: 'A',
    effect: EV_KIND.BUSY, reason: 'reserved',
    startAt: Q_FROM + 600000, endAt: Q_FROM + 3600000, allDay: 0,
  }, over);
}

// ============================================================
// 1. 公開中の世代が無い → missing（★「空きなし」と区別する）
// ============================================================
{
  const env = makeEnv();
  const r = await read(env);
  eq('★公開中の世代が無ければ使えない', [r.usable, r.reason], [false, CALREAD_REASON.MISSING]);
  ok('★使えないときに events を返さない（0件＝空きなしに化けない）', r.events === undefined);

  // calendar_active の行そのものが無い（seed が流れていない）
  env._db.exec('DELETE FROM calendar_active');
  const r2 = await read(env);
  eq('公開中の行そのものが無くても missing', [r2.usable, r2.reason], [false, CALREAD_REASON.MISSING]);
}
// 公開中として指された世代の行が消えている（結合の相手がいない）
{
  const env = makeEnv();
  const gen = ready(env);
  env._db.prepare('DELETE FROM calendar_snapshot WHERE generation = ?').run(gen);
  const r = await read(env);
  eq('★世代の行が消えていれば missing（予定だけ残っていても使わない）',
     [r.usable, r.reason], [false, CALREAD_REASON.MISSING]);
}

// ============================================================
// 2. status が ready でない → 使えない
// ============================================================
for (const st of ['building', 'rejected']) {
  const env = makeEnv();
  ready(env, { status: st }, [ev({})]);
  const r = await read(env);
  eq(`★status=${st} の世代は使わない`, [r.usable, r.reason], [false, CALREAD_REASON.MISSING]);
  ok(`status=${st} のとき events を返さない`, r.events === undefined);
}

// ============================================================
// 3. 鮮度（checked_at）— 境界を固定する
// ============================================================
{
  const env = makeEnv();
  ready(env, {}, [ev({})]);

  const cases = [
    ['1分59秒前は使える', 119000, true],
    ['★ちょうど2分前は使える（境界を含む）', FRESH_MS, true],
    ['★2分1秒前は使えない', FRESH_MS + 1000, false],
    ['★1ミリ秒でも2分を超えたら使えない', FRESH_MS + 1, false],
  ];
  for (const [name, age, want] of cases) {
    activate(env, 1, NOW - age);
    const r = await read(env);
    if (want) eq(name, r.usable, true);
    else eq(name, [r.usable, r.reason], [false, CALREAD_REASON.STALE]);
  }

  // checked_at が無い（公開の途中で壊れた）→ 鮮度が確かめられない＝使わない
  activate(env, 1, null);
  const r0 = await read(env);
  eq('★checked_at が無ければ stale（新しい扱いにしない）',
     [r0.usable, r0.reason], [false, CALREAD_REASON.STALE]);

  // 時計が狂って未来の checked_at を書かれても、永久に新鮮にしない（fail-closed）
  activate(env, 1, NOW + MAX_CLOCK_SKEW_MS + 1000);
  const rf = await read(env);
  eq('★未来に振れた checked_at は stale', [rf.usable, rf.reason], [false, CALREAD_REASON.STALE]);
  activate(env, 1, NOW + 1000);
  eq('わずかな時計のずれは許す', (await read(env)).usable, true);
}

// ============================================================
// 4. 分類規則の版が違う → rule
// ============================================================
{
  const env = makeEnv();
  ready(env, { ruleVersion: RULE }, [ev({})]);
  eq('規則の版が一致すれば使える', (await read(env)).usable, true);
  const r = await read(env, { ruleVersion: RULE + 1 });
  eq('★規則の版が違えば使わない（effect の意味が変わる）',
     [r.usable, r.reason], [false, CALREAD_REASON.RULE]);
}

// ============================================================
// 5. 1Fフラグ — 「on なら使わない」ではなく「食い違っていたら使わない」
//    （設計 §7 の記述は1Fを分類できなかった頃のもの。2026-10-02 に正しくなった）
// ============================================================
{
  const env = makeEnv();
  ready(env, { flag1f: 'off' }, [ev({})]);
  eq('off で取った世代を off の設定で読む → 使える', (await read(env, { flag1f: 'off' })).usable, true);
  const r1 = await read(env, { flag1f: 'on' });
  eq('★off→on（設定が変わったのにデータは1F抜き）は使わない',
     [r1.usable, r1.reason], [false, CALREAD_REASON.FLAG]);
}
{
  const env = makeEnv();
  // 1Fが on のときは1Fカレンダーも構成に入る
  const cals = calsJson([{ calendar_id: F1, role: CAL_ROLE.CAPACITY_1F, trainer_id: null }]);
  ready(env, { flag1f: 'on', calendars: cals }, [ev({})]);
  eq('★on で取った世代を on の設定で読む → 使える（on でも使う）',
     (await read(env, { flag1f: 'on' })).usable, true);
  const r2 = await read(env, { flag1f: 'off' });
  eq('★on→off（1F入りのデータを1Fなしの設定で読む）は使わない',
     [r2.usable, r2.reason], [false, CALREAD_REASON.FLAG]);
}

// ============================================================
// 6. 必要なカレンダーが欠けている → calendars
// ============================================================
{
  const env = makeEnv();
  // B1を欠いた世代。これを使うと、部屋が埋まっている時間を3人分まとめて「空いています」にする
  const noB1 = JSON.stringify(JSON.parse(calsJson()).filter((c) => c.calendar_id !== B1));
  ready(env, { calendars: noB1 }, [ev({})]);
  const r = await read(env);
  eq('★B1を欠いた世代は使わない', [r.usable, r.reason], [false, CALREAD_REASON.CALENDARS]);
  eq('足りないカレンダーを記録に残す', r.detail, { missing: [B1] });
}
{
  const env = makeEnv();
  ready(env, {}, [ev({})]);
  // トレーナーが入れ替わった（idは同じで担当が違う）→ 構成が違う
  const r = await read(env, {
    requiredCalendars: REQUIRED.map((c) => (c.calendarId === TA ? { calendarId: TA, role: CAL_ROLE.TRAINER, trainerId: 'Z' } : c)),
  });
  eq('★担当が食い違う構成は使わない', [r.usable, r.reason], [false, CALREAD_REASON.CALENDARS]);
  const r2 = await read(env, { requiredCalendars: [{ calendarId: B1, role: CAL_ROLE.TRAINER }] });
  eq('★役割が食い違う構成は使わない', [r2.usable, r2.reason], [false, CALREAD_REASON.CALENDARS]);
  // id だけ渡す形も使える（役割を書かなければ id の有無だけ見る）
  eq('idだけの一覧でも判定できる', (await read(env, { requiredCalendars: [B1, TA, TB, TC] })).usable, true);
  // 世代に余分なカレンダーが入っているのは構わない（必要なものが全部あればよい）
  const env2 = makeEnv();
  ready(env2, { calendars: calsJson([{ calendar_id: F1, role: CAL_ROLE.CAPACITY_1F, trainer_id: null }]) }, []);
  eq('必要なものが揃っていれば余分は構わない', (await read(env2)).usable, true);
}
{
  const env = makeEnv();
  ready(env, { calendars: '{壊れたJSON' }, [ev({})]);
  const r = await read(env);
  eq('★構成が読めない世代は使わない（fail-closed）', [r.usable, r.reason], [false, CALREAD_REASON.CALENDARS]);
}
{
  const env = makeEnv();
  ready(env, {}, []);
  let threw = '';
  try { await read(env, { requiredCalendars: [] }); } catch (e) { threw = e.message; }
  eq('★必要なカレンダーを空で渡させない（検査なしで通るのを防ぐ）', threw, 'CALREAD_NO_REQUIRED_CALENDARS');
}

// ============================================================
// 7. 地平 — 要求が [horizon_start, horizon_end) に完全に入っているか
// ============================================================
{
  const env = makeEnv();
  ready(env, {}, []);
  const cases = [
    ['★地平とちょうど同じ範囲は使える', H_START, H_END, true],
    ['地平の内側は使える', H_START + 1, H_END - 1, true],
    ['★前にはみ出す（地平の始まりより前）', H_START - 1, H_START + 3600000, false],
    ['★後ろにはみ出す（地平の終わりより後）', H_END - 3600000, H_END + 1, false],
    ['★両方にはみ出す', H_START - 1, H_END + 1, false],
    ['★地平の外側（翌月。25日に地平が伸びていない状態）', H_END, H_END + 86400000, false],
  ];
  for (const [name, f, t, want] of cases) {
    const r = await read(env, { fromMs: f, toMs: t });
    if (want) eq(name, r.usable, true);
    else eq(name, [r.usable, r.reason], [false, CALREAD_REASON.HORIZON]);
  }
}

// ============================================================
// 8. ★「使えるが予定が0件」と「そもそも使えない」を区別する（§7の要点）
// ============================================================
{
  const env = makeEnv();
  ready(env, {}, []);                                   // 予定を1件も入れない
  const r = await read(env);
  eq('★使えるが予定が0件 → usable:true / events:[]', [r.usable, r.events], [true, []]);
  ok('世代の番号を返す（突き合わせの記録に使う）', r.generation === 1);
  eq('確認時刻と地平も返す', [r.checkedAt, r.horizonStart, r.horizonEnd], [NOW, H_START, H_END]);

  // 予定はあるが、要求した範囲には1件も無い（＝本当に空いている）
  addEvents(env, 1, [ev({ eventId: 'far', startAt: H_START, endAt: H_START + 3600000 })]);
  const r2 = await read(env);
  eq('★範囲の外に予定があっても usable:true / events:[]', [r2.usable, r2.events], [true, []]);

  // 使えないときと形が違うこと（呼び出し側が取り違えようがない）
  const env2 = makeEnv();
  const bad = await read(env2);
  ok('★「空きなし」と「分からない」は形が違う',
     r.usable === true && Array.isArray(r.events) && bad.usable === false && bad.events === undefined);
}

// ============================================================
// 9. ★可否判定と取得が1回のSQL（§7：間に世代が消されるのを防ぐ）
// ============================================================
{
  const env = makeEnv();
  ready(env, {}, [ev({}), ev({ eventId: 'e2' })]);
  const r = await read(env);
  eq('使えることを確認', r.usable, true);
  eq('★発行したSQLは1回だけ', env._sql.length, 1);

  const r2 = await read(env, { ruleVersion: RULE + 9 });   // 使えない場合も1回
  eq('使えない判定でも1回', [r2.usable, env._sql.length], [false, 1]);

  const r3 = await read(env, { nowMs: NOW + FRESH_MS + 1 });
  eq('鮮度切れでも1回', [r3.reason, env._sql.length], [CALREAD_REASON.STALE, 1]);

  ok('★1回のSQLで calendar_active と結合している（別々に読んでいない）',
     /calendar_active\s+a/.test(_forTest.READ_SQL) && /LEFT JOIN calendar_snapshot/.test(_forTest.READ_SQL)
     && /LEFT JOIN calendar_events/.test(_forTest.READ_SQL));
  // WHERE 句（WHERE から ORDER BY まで）に予定の条件が無いこと。
  //   ここに start_at / effect を置くと LEFT JOIN が内部結合に退化し、
  //   「使えるが0件」が1行も返らなくなって missing と見分けがつかなくなる。
  const whereClause = _forTest.READ_SQL.split(/\bWHERE\b/)[1].split(/\bORDER BY\b/)[0];
  ok('★予定の絞り込みは ON 句（WHERE に置くと「使えるが0件」が消える）',
     !/start_at|end_at|effect/.test(whereClause), whereClause);
}

// ============================================================
// 10. 重なりの判定（calclass の overlaps と同じ：接するだけは重ならない）
// ============================================================
{
  const env = makeEnv();
  const gen = ready(env, {}, [
    ev({ eventId: 'before_touch', startAt: Q_FROM - 3600000, endAt: Q_FROM }),          // 接するだけ
    ev({ eventId: 'after_touch', startAt: Q_TO, endAt: Q_TO + 3600000 }),               // 接するだけ
    ev({ eventId: 'overlap_1ms_head', startAt: Q_FROM - 3600000, endAt: Q_FROM + 1 }),  // 1ms重なる
    ev({ eventId: 'overlap_1ms_tail', startAt: Q_TO - 1, endAt: Q_TO + 3600000 }),      // 1ms重なる
    ev({ eventId: 'inside', startAt: Q_FROM + 600000, endAt: Q_FROM + 1200000 }),       // 内包される
    ev({ eventId: 'covers', startAt: Q_FROM - 7200000, endAt: Q_TO + 7200000 }),        // 範囲を覆う
  ]);
  const r = await read(env);
  eq('★接するだけは含まない／1msでも重なれば含む／内包・被覆も含む',
     r.events.map((e) => e.eventId).sort(),
     ['covers', 'inside', 'overlap_1ms_head', 'overlap_1ms_tail']);
  ok('時間の順に並んでいる（突き合わせを安定させる）',
     r.events.every((e, i) => i === 0 || r.events[i - 1].startAt <= e.startAt));
  ok('世代は1つだけ使っている', gen === 1);

  // 幅0の要求は「範囲」として誤り。黙って0件にしない（空きなしに化ける）
  let threw = '';
  try { await read(env, { fromMs: Q_FROM, toMs: Q_FROM }); } catch (e) { threw = e.message; }
  eq('★幅0の要求は落とす', threw, 'CALREAD_EMPTY_RANGE');
  let threw2 = '';
  try { await read(env, { fromMs: Q_TO, toMs: Q_FROM }); } catch (e) { threw2 = e.message; }
  eq('★逆向きの要求は落とす', threw2, 'CALREAD_EMPTY_RANGE');
  for (const bad of [null, undefined, '1791100800000', NaN]) {
    let t = '';
    try { await read(env, { fromMs: bad }); } catch (e) { t = e.message; }
    ok(`★ミリ秒として読めない要求は落とす（${String(bad)}）`, t === 'CALREAD_BAD_RANGE', t);
  }
}

// ============================================================
// 11. 取り出した予定の形（role / effect / trainerId を必ず含める）
//     ★1Fの取り違えを防ぐための形。role だけで判断させない。
// ============================================================
{
  const env = makeEnv();
  ready(env, { flag1f: 'on', calendars: calsJson([{ calendar_id: F1, role: CAL_ROLE.CAPACITY_1F, trainer_id: null }]) }, [
    ev({ eventId: 'shiftA', effect: EV_KIND.SHIFT, reason: 'shift' }),
    ev({ calendarId: B1, eventId: 'room', role: CAL_ROLE.CAPACITY_B1, trainerId: null,
         effect: EV_KIND.ROOM_BUSY, reason: 'room', startAt: Q_FROM, endAt: Q_FROM + 1800000, allDay: 0 }),
    ev({ calendarId: F1, eventId: 'onlineA', role: CAL_ROLE.CAPACITY_1F, trainerId: 'A',
         effect: EV_KIND.BUSY, reason: 'online', startAt: Q_FROM, endAt: Q_FROM + 1800000 }),
    ev({ calendarId: F1, eventId: 'onlineX', role: CAL_ROLE.CAPACITY_1F, trainerId: null,
         effect: EV_KIND.ROOM_BUSY, reason: 'online_unknown', startAt: Q_FROM, endAt: Q_FROM + 1800000 }),
    ev({ calendarId: TB, eventId: 'allday', trainerId: 'B', effect: EV_KIND.BUSY, reason: 'block',
         startAt: Q_FROM - 36000000, endAt: Q_FROM + 50400000, allDay: 1 }),
  ]);
  const r = await read(env, { flag1f: 'on' });
  const byId = new Map(r.events.map((e) => [e.eventId, e]));
  eq('5件とも取れている', r.events.length, 5);
  ok('★すべての予定に role がある', r.events.every((e) => typeof e.role === 'string' && e.role));
  ok('★すべての予定に effect がある', r.events.every((e) => typeof e.effect === 'string' && e.effect));
  ok('★trainerId の列が必ずある（無いときは null。undefined にしない）',
     r.events.every((e) => 'trainerId' in e && (e.trainerId === null || typeof e.trainerId === 'string')));
  eq('★1Fの担当つきは「そのトレーナーだけ」と読める形（role=capacity_1f / effect=busy / 担当あり）',
     [byId.get('onlineA').role, byId.get('onlineA').effect, byId.get('onlineA').trainerId],
     [CAL_ROLE.CAPACITY_1F, EV_KIND.BUSY, 'A']);
  eq('★1Fの担当不明は全員を塞ぐと読める形（effect=room_busy / 担当なし）',
     [byId.get('onlineX').role, byId.get('onlineX').effect, byId.get('onlineX').trainerId],
     [CAL_ROLE.CAPACITY_1F, EV_KIND.ROOM_BUSY, null]);
  eq('★B1の部屋の埋まりは role で1Fと区別できる',
     [byId.get('room').role, byId.get('room').effect, byId.get('room').trainerId],
     [CAL_ROLE.CAPACITY_B1, EV_KIND.ROOM_BUSY, null]);
  eq('列の名前と型（氏名・タイトルは無い）', Object.keys(byId.get('shiftA')).sort(),
     ['allDay', 'calendarId', 'effect', 'endAt', 'eventId', 'reason', 'role', 'startAt', 'trainerId']);
  eq('終日は1で返る', byId.get('allday').allDay, 1);
  ok('★氏名・タイトルを返さない', JSON.stringify(r).indexOf('title') < 0);
}

// ============================================================
// 12. effect=ignore は返さない（[消化] が「席が埋まっている」に化けない）
// ============================================================
{
  const env = makeEnv();
  ready(env, {}, [
    ev({ calendarId: B1, eventId: 'consumed', role: CAL_ROLE.CAPACITY_B1, trainerId: null,
         effect: EV_KIND.IGNORE, reason: 'consumed' }),
    ev({ eventId: 'busyA' }),
  ]);
  const r = await read(env);
  eq('★ignore は返さない（行があるから塞がっている、と書かれても壊れない）',
     r.events.map((e) => e.eventId), ['busyA']);

  // ignore しかない時間帯は「使えるが0件」
  const env2 = makeEnv();
  ready(env2, {}, [ev({ calendarId: B1, eventId: 'consumed', role: CAL_ROLE.CAPACITY_B1,
                        trainerId: null, effect: EV_KIND.IGNORE, reason: 'consumed' })]);
  const r2 = await read(env2);
  eq('★[消化] だけの時間帯は usable:true / events:[]', [r2.usable, r2.events], [true, []]);
}

// ============================================================
// 13. ★公開中でない世代の予定が混ざらない（世代を2つ作って確認）
// ============================================================
{
  const env = makeEnv();
  const g1 = addGen(env, {});
  addEvents(env, g1, [ev({ eventId: 'old1' }), ev({ eventId: 'old2' })]);
  const g2 = addGen(env, {});
  addEvents(env, g2, [ev({ eventId: 'new1' })]);

  activate(env, g2, NOW);
  const r = await read(env);
  eq('★公開中の世代の予定だけを返す', [r.generation, r.events.map((e) => e.eventId)], [g2, ['new1']]);

  activate(env, g1, NOW);
  const r2 = await read(env);
  eq('公開を戻せば前の世代の予定を返す', [r2.generation, r2.events.map((e) => e.eventId).sort()],
     [g1, ['old1', 'old2']]);

  // 公開中が ready でない世代に向いていたら、別の ready な世代の予定を拾わない
  env._db.prepare("UPDATE calendar_snapshot SET status = 'building' WHERE generation = ?").run(g1);
  const r3 = await read(env);
  eq('★公開中が ready でないとき、他の世代の予定を代わりに使わない',
     [r3.usable, r3.reason, r3.events], [false, CALREAD_REASON.MISSING, undefined]);
}

// ============================================================
// 14. 判定の順序（複数当たっても理由が決まる）
// ============================================================
{
  const env = makeEnv();
  ready(env, { ruleVersion: 9, flag1f: 'on', calendars: '[]' }, []);
  activate(env, 1, NOW - FRESH_MS - 1000);
  const r = await read(env, { fromMs: H_START - 1, toMs: H_END + 1 });
  eq('★すべて外れているときは最初の理由（鮮度）を返す', r.reason, CALREAD_REASON.STALE);
  activate(env, 1, NOW);                                   // 鮮度だけ直す
  const r2 = await read(env, { fromMs: H_START - 1, toMs: H_END + 1 });
  eq('鮮度が通れば次は規則の版', r2.reason, CALREAD_REASON.RULE);
  // 1つずつ直していくと、順に次の理由が出る（＝5つの判定が独立に効いている）
  const r3 = await read(env, { ruleVersion: 9, fromMs: H_START - 1, toMs: H_END + 1 });
  eq('規則の版が通れば次は1Fフラグ', r3.reason, CALREAD_REASON.FLAG);
  const r4 = await read(env, { ruleVersion: 9, flag1f: 'on', fromMs: H_START - 1, toMs: H_END + 1 });
  eq('1Fフラグが通れば次は構成', r4.reason, CALREAD_REASON.CALENDARS);
  env._db.prepare('UPDATE calendar_snapshot SET calendars = ? WHERE generation = 1').run(calsJson());
  const r5 = await read(env, { ruleVersion: 9, flag1f: 'on', fromMs: H_START - 1, toMs: H_END + 1 });
  eq('構成が通れば次は地平', r5.reason, CALREAD_REASON.HORIZON);
  // ★構成が空（calendars='[]'）の世代でも、必要なものを1つでも求めれば落ちる
  ok('★どの理由でも events は返さない',
     [r, r2, r3, r4, r5].every((x) => x.usable === false && x.events === undefined));
}

// ============================================================
// 15. 引数の検証（呼び出し側の不具合を reason に混ぜない）
// ============================================================
{
  const env = makeEnv();
  ready(env, {}, []);
  const bad = [
    [{ ruleVersion: 1.5 }, 'CALREAD_BAD_RULE_VERSION'],
    [{ ruleVersion: '1' }, 'CALREAD_BAD_RULE_VERSION'],
    [{ flag1f: '' }, 'CALREAD_BAD_FLAG_1F'],
    [{ flag1f: 'ON' }, 'CALREAD_BAD_FLAG_1F'],
    [{ flag1f: true }, 'CALREAD_BAD_FLAG_1F'],
    [{ nowMs: 'now' }, 'CALREAD_BAD_NOW'],
    [{ requiredCalendars: [''] }, 'CALREAD_BAD_REQUIRED_CALENDAR'],
    [{ requiredCalendars: [{ role: 'trainer' }] }, 'CALREAD_BAD_REQUIRED_CALENDAR'],
  ];
  for (const [over, want] of bad) {
    let got = '';
    try { await read(env, over); } catch (e) { got = e.message; }
    eq(`★壊れた引数は落とす（${JSON.stringify(over)}）`, got, want);
  }
}

// ============================================================
// 16. 書き込む側（calsync）と通しで合うか
//     ★列名・役割・効果・担当がそのまま往復すること。身代わりでは検査できない。
// ============================================================
{
  const env = makeEnv();
  const CALS = [
    { calendarId: B1, role: CAL_ROLE.CAPACITY_B1 },
    { calendarId: TA, role: CAL_ROLE.TRAINER, trainerId: 'A' },
    { calendarId: TB, role: CAL_ROLE.TRAINER, trainerId: 'B' },
    { calendarId: TC, role: CAL_ROLE.TRAINER, trainerId: 'C' },
  ];
  const base = (o) => Object.assign({
    calendarId: TA, eventId: 'x', role: CAL_ROLE.TRAINER, trainerId: 'A',
    effect: EV_KIND.BUSY, reason: 'reserved',
    startAt: Q_FROM + 600000, endAt: Q_FROM + 1800000, allDay: 0,
  }, o);
  const body = {
    horizonStart: H_START, horizonEnd: H_END, ruleVersion: RULE, flag1f: 'off',
    calendars: CALS, contentHash: HASH, invalid: [],
    events: [
      base({ eventId: 'sA', effect: EV_KIND.SHIFT, reason: 'shift' }),
      base({ calendarId: TB, eventId: 'sB', trainerId: 'B', effect: EV_KIND.SHIFT, reason: 'shift' }),
      base({ calendarId: TC, eventId: 'sC', trainerId: 'C', effect: EV_KIND.SHIFT, reason: 'shift' }),
      base({ eventId: 'rA' }),
      base({ calendarId: B1, eventId: 'room1', role: CAL_ROLE.CAPACITY_B1, trainerId: null,
             effect: EV_KIND.ROOM_BUSY, reason: 'room' }),
    ],
  };
  const res = await handleCalSync(new Request('https://x/calsync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ingest-Secret': SECRET },
    body: JSON.stringify(body),
  }), env);
  const pub = await res.json();
  eq('calsync が公開した', [res.status, pub.mode], [200, 'published']);

  const r = await read(env, { nowMs: Date.now() });
  eq('★書いた直後は使える', r.usable, true);
  eq('★書いた形がそのまま読める', r.events.map((e) => [e.eventId, e.role, e.effect, e.trainerId]).sort(),
     [['rA', CAL_ROLE.TRAINER, EV_KIND.BUSY, 'A'],
      ['room1', CAL_ROLE.CAPACITY_B1, EV_KIND.ROOM_BUSY, null],
      ['sA', CAL_ROLE.TRAINER, EV_KIND.SHIFT, 'A'],
      ['sB', CAL_ROLE.TRAINER, EV_KIND.SHIFT, 'B'],
      ['sC', CAL_ROLE.TRAINER, EV_KIND.SHIFT, 'C']].sort());
  eq('★calsync が書いた構成の表記で可否判定が通る（snake_case の往復）', r.usable, true);

  // 2分以上経ったら、同じ世代でも使えない（GASが止まったときの振る舞い）
  const stale = await read(env, { nowMs: Date.now() + FRESH_MS + 1000 });
  eq('★押し出しが止まれば使えなくなる（誤った空き枠を出さない）',
     [stale.usable, stale.reason], [false, CALREAD_REASON.STALE]);
}

// ============================================================
// 17. 部品（構成の比較）
// ============================================================
{
  eq('idだけ・snake_case・camelCase を同じ形に直す',
     _forTest.normalizeRequired([TA, { calendarId: TB, role: 'trainer', trainerId: 'B' },
                                 { calendar_id: B1, role: 'capacity_b1' }]),
     [{ calendar_id: TA, role: null, trainer_id: null },
      { calendar_id: TB, role: 'trainer', trainer_id: 'B' },
      { calendar_id: B1, role: 'capacity_b1', trainer_id: null }]);
  eq('必要なものが全部あれば null',
     _forTest.missingCalendars(calsJson(), _forTest.normalizeRequired([B1, TA])), null);
  eq('読めないJSONは「足りない」に倒す',
     _forTest.missingCalendars('nope', _forTest.normalizeRequired([B1])), { parse: false });
  eq('配列でないJSONも「足りない」',
     _forTest.missingCalendars('{"calendar_id":"x"}', _forTest.normalizeRequired([B1])), { parse: false });
}

console.log(`\nカレンダー読み取り（可否判定＋取得） 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
