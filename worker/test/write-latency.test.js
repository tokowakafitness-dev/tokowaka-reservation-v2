// 設計43 B：書き込みの後、残数・予約一覧は Worker に戻し、枠だけ「書き込みの後に読み始めた写し」と比べられたときに Worker から出す
//   実行: node worker/test/write-latency.test.js
//
//   ① GAS edgeAfterWrite（本物を走らせる）：edgeSyncedExceptSlots / edgeWriteAt を名乗る条件（操作・写し・予約一覧・通し番号）
//   ② GAS 枠の写し：読み始めの時刻は作りたての枠のときだけ・全トレーナーの行に同じ値・pushToEdgeSlots から配線
//   ③ Worker compatTrainerSlots（本物の SQLite に slots_cache と remain_source_daily）：slotsAfter の判定・数え方・無いときは今と同じ
//   ④ 日次点検：slots_after を残数の「写しに落ちた」に混ぜない
//   ★値は架空（個人情報を書かない）
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { routeSlots } from '../src/routes/slots.js';
import { compatTrainerSlots, parseSlotsAfter, judgeSlotsAfter, SLOTS_AFTER_MARGIN_MS, SLOTS_AFTER_WHY } from '../src/routes/compat.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const W = join(ROOT, 'worker');
const PE = readFileSync(join(ROOT, 'gas/PushToEdge.js'), 'utf8');
const CO = readFileSync(join(ROOT, 'gas/コード.js'), 'utf8');
const LB = readFileSync(join(ROOT, 'gas/LineBooking.js'), 'utf8');
let pass = 0, fail = 0;
function ok(name, cond, why) { if (cond) pass++; else { fail++; console.log(`❌ ${name}`); if (why) console.log(`   ${why}`); } }
function pluckFn(src, name) {
  const m = src.match(new RegExp('\\nfunction ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('見つからない: ' + name);
  return m[0];
}
function pluckVar(src, name) {
  const m = src.match(new RegExp('\\nvar ' + name + ' = [\\s\\S]*?;\\n'));
  if (!m) throw new Error('見つからない: ' + name);
  return m[0];
}

// ================= ① edgeAfterWrite =================
function gasEdge(opt = {}) {
  const NOW = 1795000000000;
  const ctx = {
    String, Number, JSON, Math, Object, Date: class extends Date { static now() { return NOW; } },
    Logger: { log: () => {} },
    _edgeEnabled: () => opt.edgeOn !== false,
    _lbScheduleCalSync: () => {},
    getCustomerByLine: () => null,
    MAP_COL: { CUSTOMER_ID: 1, NAME: 2 },
    _edgeNameByCustomerId: () => 'テスト 太郎',
    lbDwEnqueue: () => { if (opt.enqThrow) throw new Error('q'); return opt.seq === undefined ? 7 : opt.seq; },
    _edgeSendAfterWrite: () => ({ home: opt.home !== false, reservations: opt.resv !== false, bothFailed: false }),
  };
  vm.createContext(ctx);
  vm.runInContext(pluckVar(PE, 'EDGE_AFTER_WRITE') + pluckVar(PE, 'EDGE_CALSYNC_AFTER') + pluckVar(PE, 'EDGE_SLOTS_ONLY_LAG') + pluckFn(PE, 'edgeAfterWrite'), ctx);
  return { ctx, NOW };
}
console.log('=== ① edgeAfterWrite ===');
{
  const run = (action, opt, res) => { const g = gasEdge(opt); const r = res || { success: true, customerId: 'C0001' }; g.ctx.edgeAfterWrite(action, {}, r, 'U' + '0'.repeat(32)); return { r, NOW: g.NOW }; };
  const a = run('line_cancelReservation', {});
  ok('①-1 ★取消・写しと予約一覧を送れた・番号が数値 → 枠以外は同期済み・書き込み時刻', a.r.edgeSyncedExceptSlots === true && a.r.edgeWriteAt === a.NOW && a.r.edgeSynced === false, JSON.stringify(a.r));
  for (const op of ['line_makeReservationLine', 'line_changeReservation', 'line_makeBatchReservation', 'line_makeTransferReservation', 'line_ownerFreeCancel', 'line_ownerFreeChange', 'line_makeReservationLineProxy', 'line_makeBatchReservationProxy']) {
    ok('①-2 ' + op + ' も名乗る', run(op, {}).r.edgeSyncedExceptSlots === true);
  }
  for (const op of ['line_addRecurringPatternByTrainer', 'line_deleteRecurringPattern', 'line_makeBlock', 'line_makeAdminBooking', 'line_deleteAdminSlot', 'line_undoSameDayCancel', 'line_makeRecurringReservation']) {
    const x = run(op, {}).r;
    ok('①-3 ★' + op + ' は名乗らない（固定枠・トレーナーの枠一覧の写しを送っていない）', x.edgeSyncedExceptSlots === undefined && x.edgeWriteAt === undefined);
  }
  ok('①-4 ★写しを送れなければ名乗らない', run('line_cancelReservation', { home: false }).r.edgeSyncedExceptSlots === undefined);
  ok('①-5 ★予約一覧を送れなければ名乗らない', run('line_cancelReservation', { resv: false }).r.edgeSyncedExceptSlots === undefined);
  for (const seq of [false, 'BROKEN', 'SEQ_FAILED']) ok('①-6 ★番号を積めない（' + seq + '）なら名乗らない（D1 の残数が古いまま答え得る）', run('line_cancelReservation', { seq }).r.edgeSyncedExceptSlots === undefined);
  ok('①-7 積む例外でも名乗らない', run('line_cancelReservation', { enqThrow: true }).r.edgeSyncedExceptSlots === undefined);
  ok('①-8 失敗した書き込みでは名乗らない', run('line_cancelReservation', {}, { success: false, code: 'ALREADY' }).r.edgeSyncedExceptSlots === undefined);
  ok('①-9 押し出し全体が止まっていれば名乗らない', run('line_cancelReservation', { edgeOn: false }).r.edgeSyncedExceptSlots === undefined);
  ok('①-10 会員が特定できなければ名乗らない', run('line_cancelReservation', {}, { success: true }).r.edgeSyncedExceptSlots === undefined);
  ok('①-11 既存の edgeSynced はチケット追加で今までどおり真', run('line_addTicketRefill', {}).r.edgeSynced === true);
  ok('①-12 書き込み時刻は関数の入口（書き込みの処理が返った後）で取る', /function edgeAfterWrite\([^)]*\) \{[^\n]*\n(\s*\/\/[^\n]*\n)*\s*var _writeAt = Date\.now\(\);\s*try \{/.test(pluckFn(PE, 'edgeAfterWrite')));
}

// ================= ② 枠の写しの読み始め =================
console.log('=== ② 枠の写し ===');
{
  const ctx = {
    String, Number, JSON, Math, Object, Date,
    Logger: { log: () => {} },
    CALENDAR_IDS: { TRAINERS: [{ id: 'T1' }, { id: 'T2' }] },
    SETTINGS: {},
    _lbDropClosedSlots: (x) => x,
    _lbTrainerSlotsAll: () => ({ slots: [] }),
    _lbConsecMode: () => 'off',
    _edgeProp: () => '111',
  };
  vm.createContext(ctx);
  vm.runInContext("var _LB_SLOTS_CONSEC_BUILT = '';\n" + pluckFn(PE, '_edgeConsecModeFor') + pluckFn(PE, '_edgeSlotRows'), ctx);
  const fresh = [{ trainerId: 'T1', startISO: '2026-12-01T01:00:00.000Z', endISO: '2026-12-01T02:00:00.000Z' }];
  const rows = ctx._edgeSlotRows(1795000005000, fresh, 1795000000000);
  const pl = rows.map((r) => JSON.parse(r.payload));
  ok('②-1 ★作りたての枠なら全トレーナーの行に同じ readStartAt・builtAt', pl.length === 2 && pl.every((p) => p.readStartAt === 1795000000000 && p.builtAt === 1795000005000), JSON.stringify(pl));
  const noFresh = ctx._edgeSlotRows(1795000005000, null, 1795000000000).map((r) => JSON.parse(r.payload));
  ok('②-2 ★キャッシュから読む経路は読み始めを載せない', noFresh.every((p) => !('readStartAt' in p)));
  ok('②-3 読み始めが渡されなければ載せない', ctx._edgeSlotRows(1795000005000, fresh).map((r) => JSON.parse(r.payload)).every((p) => !('readStartAt' in p)));
  ok('②-4 壊れた値（0・小数・文字）は載せない', [0, 1.5, '1795000000000', -1].every((v) => ctx._edgeSlotRows(1, fresh, v).map((r) => JSON.parse(r.payload)).every((p) => !('readStartAt' in p))));
  const ps = pluckFn(PE, 'pushToEdgeSlots');
  ok('②-5 pushToEdgeSlots：作り直せたときの読み始めを、作り直せなければ 0 を渡す',
     /builtAt = Number\(LB_SLOTS_BUILT_AT_LOCAL \|\| 0\);[\s\S]{0,200}readStartAt = Number\(LB_SLOTS_READ_START_LOCAL \|\| 0\);/.test(ps) && /if \(!builtSlots\) readStartAt = 0;/.test(ps)
     && /_pushToEdgeSlotsImpl\(builtAt, builtSlots, readStartAt\)/.test(ps));
  ok('②-6 _pushToEdgeSlotsImpl → _edgeSendSlots → _edgeSlotRows へ配線', /_edgeSendSlots\(builtAt, builtSlots, \{ batchId: Date\.now\(\), deleteStale: true, readStartAt: readStartAt \}\)/.test(pluckFn(PE, '_pushToEdgeSlotsImpl'))
     && /_edgeSlotRows\(builtAt, builtSlots, opts\.readStartAt\)/.test(pluckFn(PE, '_edgeSendSlots')));
  const bc = pluckFn(CO, 'buildAndCacheSlots');
  ok('②-7 ★読み始めは buildAvailableSlots を呼ぶ直前に取る', /var _readStart = Date\.now\(\);\s*var slots = buildAvailableSlots\(\);\s*LB_SLOTS_READ_START_LOCAL = _readStart;/.test(bc));
  ok('②-8 巻き戻し防止（builtAt の比較）は変えていない', /if \(builtAt > 0 && builtAt < last\)/.test(pluckFn(PE, '_edgeSendSlots')));
}

// ================= ③ Worker =================
function makeEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(W, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(join(W, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    try { db.exec(readFileSync(join(W, 'migrations', f), 'utf8')); } catch (e) { if (!/duplicate column/.test(e.message)) throw e; }
  }
  const exec = (q, a, how) => {
    const st = db.prepare(q);
    if (how === 'first') { const r = st.get(...a); return r === undefined ? null : r; }
    if (how === 'all') return { results: st.all(...a) };
    const r = st.run(...a); return { meta: { changes: Number(r.changes) } };
  };
  return { _db: db, DB: { prepare(q) { return { _a: [], bind(...a) { this._a = a; return this; },
    async run() { return exec(q, this._a, 'run'); }, async first() { return exec(q, this._a, 'first'); }, async all() { return exec(q, this._a, 'all'); } }; } } };
}
const ctxOf = () => { const p = []; return { waitUntil: (x) => p.push(Promise.resolve(x)), _wait: () => Promise.all(p) }; };
const NOW = Date.now();
const SLOT = { startMs: NOW + 3 * 86400000, startISO: new Date(NOW + 3 * 86400000).toISOString(), endISO: new Date(NOW + 3 * 86400000 + 3600000).toISOString(),
  date: '2026/12/01', dayOfWeek: '火', startTime: '10:00', endTime: '11:00', trainerName: '鈴木', trainerId: 't1', trialOk: true };
function putSlots(env, extra, computedAt) {
  const payload = Object.assign({ trainerId: 't1', slots: [SLOT], rules: { leadMinutes: 180, morningUntilHour: 12, prevDeadlineHour: 22 }, builtAt: NOW - 50000 }, extra);
  env._db.prepare('INSERT OR REPLACE INTO slots_cache (trainer_id, payload, computed_at, synced_at) VALUES (?, ?, ?, ?)').run('t1', JSON.stringify(payload), computedAt || NOW - 30000, 1);
}
const counts = (env) => Object.fromEntries(env._db.prepare("SELECT source, n FROM remain_source_daily WHERE entry = 'slots_after'").all().map((r) => [r.source, r.n]));
const member = { role: 'customer', customerId: 'c1' };

console.log('=== ③ Worker ===');
{
  const W0 = NOW - 60000;   // 書き込みの時刻
  // 答える
  {
    const env = makeEnv(); putSlots(env, { readStartAt: W0 + SLOTS_AFTER_MARGIN_MS }); const c = ctxOf();
    const r = await compatTrainerSlots({ env, body: { trainerId: 't1', slotsAfter: W0 }, who: member, ctx: c }); await c._wait();
    ok('③-1 ★読み始め ≧ 書き込み＋2秒 → 答え、slotsAfterOk に同じ値', !r._fallback && r.slotsAfterOk === W0 && r.slots.length === 1, JSON.stringify(r));
    ok('③-2 ok を1回数える', counts(env).ok === 1, JSON.stringify(counts(env)));
  }
  // 答えない
  const cases = [
    ['③-3 ★読み始めが書き込み＋2秒より前（書き込みより前に読み始めた写し）→ behind', { readStartAt: W0 + SLOTS_AFTER_MARGIN_MS - 1 }, W0, 'behind'],
    ['③-4 ★読み始めが無い（古い GAS・前のキャッシュ）→ no_read_start', {}, W0, 'no_read_start'],
    ['③-5 読み始めが壊れている（文字）→ no_read_start', { readStartAt: String(W0 + 9000) }, W0, 'no_read_start'],
    ['③-6 slotsAfter が壊れている → bad_param', { readStartAt: W0 + 9000 }, 'abc', 'bad_param'],
    ['③-7 slotsAfter が小数 → bad_param', { readStartAt: W0 + 9000 }, W0 + 0.5, 'bad_param'],
    ['③-8 slotsAfter が範囲外 → bad_param', { readStartAt: W0 + 9000 }, 123, 'bad_param'],
  ];
  for (const [name, extra, sa, why] of cases) {
    const env = makeEnv(); putSlots(env, extra); const c = ctxOf();
    const r = await compatTrainerSlots({ env, body: { trainerId: 't1', slotsAfter: sa }, who: member, ctx: c }); await c._wait();
    ok(name, r._fallback === true && !('slotsAfterOk' in r) && counts(env)[why] === 1, JSON.stringify({ r, c: counts(env) }));
  }
  {
    const env = makeEnv(); putSlots(env, { readStartAt: W0 + 9000 }, NOW - 25 * 60000); const c = ctxOf();
    const r = await compatTrainerSlots({ env, body: { trainerId: 't1', slotsAfter: W0 }, who: member, ctx: c }); await c._wait();
    ok('③-9 写しが古い（20分超）なら今までどおり答えない・no_answer に数える', r._fallback === true && counts(env).no_answer === 1, JSON.stringify(counts(env)));
  }
  {
    const env = makeEnv(); putSlots(env, { readStartAt: W0 + 9000 }); const c = ctxOf();
    const r = await compatTrainerSlots({ env, body: { trainerId: 't1', slotsAfter: W0, excludeStartISO: SLOT.startISO }, who: member, ctx: c }); await c._wait();
    ok('③-10 今までの判定（連続ルール等）は残る：既存の答えが返る条件では答える', !r._fallback && r.slotsAfterOk === W0);
  }
  ok('③-11 ①（カレンダーから計算）の答えは calendar_path で答えない', judgeSlotsAfter({ source: 'calendar', readStartAt: W0 + 9000 }, W0, 'cache') === 'calendar_path');
  // 無いときは今と同じ
  {
    const env = makeEnv(); putSlots(env, { readStartAt: W0 + 9000 }); const c = ctxOf();
    const withNone = await compatTrainerSlots({ env, body: { trainerId: 't1' }, who: member, ctx: c }); await c._wait();
    const env2 = makeEnv(); putSlots(env2, {}); const c2 = ctxOf();
    const old = await compatTrainerSlots({ env: env2, body: { trainerId: 't1' }, who: member, ctx: c2 });
    ok('③-12 ★slotsAfter が無ければ答えの鍵は今と同じ（slotsAfterOk・readStartAt を出さない）・数えない',
       JSON.stringify(Object.keys(withNone).sort()) === JSON.stringify(['ageMs', 'computedAt', 'slots']) && JSON.stringify(Object.keys(old).sort()) === JSON.stringify(Object.keys(withNone).sort())
       && Object.keys(counts(env)).length === 0, JSON.stringify(withNone));
    ok('③-13 slotsAfter が空文字・null も「無い」扱い', parseSlotsAfter('') === null && parseSlotsAfter(null) === null && parseSlotsAfter(undefined) === null);
  }
  ok('③-14 数える理由は固定の集合', JSON.stringify(SLOTS_AFTER_WHY) === JSON.stringify(['ok', 'bad_param', 'no_answer', 'calendar_path', 'no_read_start', 'behind']));
  {
    const env = makeEnv(); putSlots(env, { readStartAt: W0 + 9000 });
    for (let i = 0; i < 501; i++) env._db.prepare("INSERT OR REPLACE INTO remain_source_daily (day, entry, source, n) VALUES (?, 'slots_after', 'ok', ?)").run(new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10), 500);
    const r = await compatTrainerSlots({ env, body: { trainerId: 't1', slotsAfter: W0 }, who: member });
    ok('③-15 1日500件を超えても答えは変えず、_dropped を1回だけ', !r._fallback && counts(env)._dropped === 1 && counts(env).ok === 500, JSON.stringify(counts(env)));
  }
  {
    const env = makeEnv(); putSlots(env, { readStartAt: W0 + 9000 });
    env.DB = { prepare(q) { return { bind() { return this; },
      async first() { if (/slots_cache/.test(q)) return { payload: JSON.stringify({ trainerId: 't1', slots: [SLOT], readStartAt: W0 + 9000 }), computed_at: NOW - 1000 }; return null; },
      async all() { return { results: [] }; }, async run() { throw new Error('D1 down'); } }; } };
    const r = await compatTrainerSlots({ env, body: { trainerId: 't1', slotsAfter: W0 }, who: member });
    ok('③-16 数える書き込みが落ちても答えは変えない', !r._fallback && r.slotsAfterOk === W0);
  }
}

{
  //   readCache 自身も数値型だけを通す（compat の判定と二重の守り・どちらか一方が外れても落ちる）
  for (const [v, want] of [[1795000000000, 1795000000000], ['1795000000000', null], [0, null], [1.5, null], [undefined, null]]) {
    const env = makeEnv(); putSlots(env, v === undefined ? {} : { readStartAt: v });
    const r = await routeSlots({ env, body: { trainerId: 't1' }, who: member, internal: { readStartAt: true } });
    ok('③-17 routeSlots の readStartAt（内部の呼び出し）：' + JSON.stringify(v) + ' → ' + want, r.readStartAt === want, JSON.stringify(r.readStartAt));
  }
  //   ★公開の窓口（slots / mySlots＝index.js から internal なしで呼ぶ）の答えは今と同じ（readStartAt を出さない・関門② 中1）
  const env = makeEnv(); putSlots(env, { readStartAt: 1795000000000 });
  const pub = await routeSlots({ env, body: { trainerId: 't1' }, who: member });
  const env2 = makeEnv(); putSlots(env2, {});
  const pub0 = await routeSlots({ env: env2, body: { trainerId: 't1' }, who: member });
  ok('③-18 ★公開の routeSlots は readStartAt を出さず、鍵の並びは写しに読み始めが無いときと同じ', !('readStartAt' in pub) && JSON.stringify(Object.keys(pub)) === JSON.stringify(Object.keys(pub0)), JSON.stringify(Object.keys(pub)));
  const IDX = readFileSync(join(ROOT, 'worker/src/index.js'), 'utf8');
  ok('③-19 index.js は routeSlots に internal を渡さない（内部の時刻を外へ出す入口を作らない）', !/internal/.test(IDX));
  ok('③-20 Worker の版を上げた', /export const WORKER_BUILD = '2026-11-13c/.test(IDX));
}

// ================= ④ 日次点検 =================
console.log('=== ④ 日次点検 ===');
{
  ok('④-1 ★残数の出どころの集計から slots_after を外す', /if \(_yd\[_yi\]\.entry === 'slots_after'\) continue;/.test(LB));
  ok('④-2 slots_after を別の行（母数と倒れた理由）で出す', /add\('slots_after', 'D1', 'info', _saOk,/.test(LB));
}

console.log(`\n${pass} 通過 / ${fail} 失敗`);
if (fail) process.exit(1);
