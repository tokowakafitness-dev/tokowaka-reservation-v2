// 体の記録を D1 に置く（設計28 3-1）・2026-11-03
//   実行: node worker/test/body-d1.test.js
//
//   1. ★合成が GAS と同じ答え：gas/MealAi.js の maReadBody_ と maReadGoal_ を**元のコードのまま** vm で動かし、
//      ランダムな行で Worker の synthesizeBody / pickGoalLine と突き合わせる（目で見比べない）
//   2. /body/write（GAS からの転送）：体重・InBody・体脂肪率（d1 の行を更新／known で作る／どちらも無ければ NEED_WEIGHT_FIRST）・
//      sheet の行は書き換えない・二重送信
//   3. /body/freeze：begin → rows（ハッシュ・位置）→ copied（全部写したか）→ verified、/body/series（sheet だけで計算）

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';
import worker from '../src/index.js';
import { synthesizeBody, pickGoalLine } from '../src/lib/body-series.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const W = join(HERE, '..');
const ROOT = join(W, '..');
const SECRET = 'TEST-SECRET';
let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) pass++; else { fail++; console.log(`❌ ${name}${detail ? '\n   ' + detail : ''}`); } }

// ================= 1. GAS と同じ答え =================
const MA = readFileSync(join(ROOT, 'gas/MealAi.js'), 'utf8');
function extract(name) {
  const at = MA.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('not found ' + name);
  let i = MA.indexOf('{', at), depth = 0;
  for (; i < MA.length; i++) { if (MA[i] === '{') depth++; else if (MA[i] === '}') { depth--; if (depth === 0) break; } }
  return MA.slice(at, i + 1);
}
const ctx = vm.createContext({
  maDateStr_: (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : ''),
  maShiftDays_: () => '0000-01-01',
  maToday_: () => '2099-12-31',
});
vm.runInContext(extract('maReadBody_') + '\n' + extract('maReadGoal_'), ctx);

function sheetOf(rows) {
  return { getLastRow: () => rows.length + 1,
           getRange: (from, col, n, w) => ({ getValues: () => rows.slice(from - 2, from - 2 + n).map((r) => { const x = r.slice(0, w); while (x.length < w) x.push(''); return x; }) }) };
}
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const maybe = (p, f) => (rnd() < p ? f() : '');

//   body_log の行 → D1 の行（/body/freeze の toStmt と同じ写し方：Number(x)||null）
const toD1 = (r, i) => ({ id: i + 1, origin: 'sheet', sheet_order: i, customer_id: r[0], measured_date: r[1],
  source_raw: String(r[7] || ''), weight_kg: Number(r[2]) || null, body_fat_pct: Number(r[3]) || null,
  lean_kg: Number(r[4]) || null, body_water_l: Number(r[5]) || null, visceral_fat: Number(r[6]) || null });

let mismatch = 0, compared = 0;
for (let t = 0; t < 300; t++) {
  const rows = [];
  const n = 1 + Math.floor(rnd() * 25);
  for (let i = 0; i < n; i++) {
    rows.push([pick(['C1', 'C2']), '2026-10-' + String(1 + Math.floor(rnd() * 6)).padStart(2, '0'),
      maybe(0.8, () => Math.round((50 + rnd() * 40) * 10) / 10), maybe(0.5, () => Math.round((10 + rnd() * 25) * 10) / 10),
      maybe(0.3, () => Math.round((40 + rnd() * 30) * 10) / 10), maybe(0.3, () => Math.round((30 + rnd() * 20) * 10) / 10),
      maybe(0.3, () => 1 + Math.floor(rnd() * 15)), pick(['inbody', 'self', 'inbody_manual', '', 'line']), 'x', '', '']);
  }
  const gas = ctx.maReadBody_(sheetOf(rows), 'C1', 3650);
  const mine = synthesizeBody(rows.map(toD1).filter((r) => r.customer_id === 'C1'));
  //   比べる鍵：GAS が持つものだけ（d・w・pbf・lean・tbw・vis・fat と出所 s）
  const norm = (arr) => JSON.stringify(arr.map((r) => {
    const o = { d: r.d }; for (const k of ['w', 'pbf', 'lean', 'tbw', 'vis', 'fat']) if (r[k] != null) o[k] = r[k];
    const s = {}; for (const k of ['w', 'pbf', 'lean', 'tbw', 'vis', 'fat']) if (r.s && r.s[k]) s[k] = r.s[k]; o.s = s; return o;
  }));
  compared++;
  if (norm(gas) !== norm(mine)) { if (mismatch < 2) console.log('  GAS :', norm(gas).slice(0, 300), '\n  mine:', norm(mine).slice(0, 300)); mismatch++; }
}
ok(`1-1 ★体の記録の合成が GAS と同じ（ランダム ${compared} 通り）`, mismatch === 0, `不一致 ${mismatch}`);

//   目標線
let gm = 0, gc = 0;
for (let t = 0; t < 300; t++) {
  const goals = [], phases = [];
  const ng = Math.floor(rnd() * 3), np = Math.floor(rnd() * 4);
  for (let i = 0; i < ng; i++) {
    const r = new Array(18).fill('');
    r[0] = pick(['C1', 'C2']); r[2] = maybe(0.9, () => '2026-09-0' + (1 + Math.floor(rnd() * 5))); r[3] = maybe(0.9, () => '2027-0' + (1 + Math.floor(rnd() * 5)) + '-01');
    r[8] = maybe(0.85, () => 60 + Math.floor(rnd() * 20)); r[10] = maybe(0.85, () => 55 + Math.floor(rnd() * 20));
    goals.push(r);
  }
  for (let i = 0; i < np; i++) {
    const r = new Array(17).fill('');
    r[0] = pick(['C1', 'C1', 'C2']); r[1] = 1 + Math.floor(rnd() * 3); r[3] = maybe(0.9, () => '2026-1' + Math.floor(rnd() * 3) + '-01');
    r[4] = maybe(0.8, () => '2027-0' + (1 + Math.floor(rnd() * 8)) + '-01'); r[6] = maybe(0.7, () => 60 + Math.floor(rnd() * 20));
    r[7] = maybe(0.85, () => 55 + Math.floor(rnd() * 20)); r[13] = pick(['', '', '無効', '確定']);
    phases.push(r);
  }
  const ss = { getSheetByName: (nm) => (nm === 'meal_goals' ? { getLastRow: () => goals.length + 1, getRange: (a, b, n, w) => ({ getValues: () => goals.slice(0, n).map((x) => x.slice(0, w)) }) }
                                       : nm === 'goal_phases' ? { getLastRow: () => phases.length + 1, getRange: (a, b, n, w) => ({ getValues: () => phases.slice(0, n).map((x) => x.slice(0, w)) }) } : null) };
  const g = ctx.maReadGoal_(ss, 'C1');
  const d = (x) => (/^\d{4}-\d{2}-\d{2}$/.test(String(x || '')) ? String(x) : null);
  const n = (x) => (Number(x) || null);
  const d1 = [
    ...goals.map((r, i) => ({ kind: 'meal_goal', customer_id: r[0], start_date: d(r[2]), end_date: d(r[3]), start_weight: n(r[8]), target_weight: n(r[10]), origin: 'sheet', sheet_order: i })),
    ...phases.map((r, i) => ({ kind: 'phase', customer_id: r[0], phase_no: Number(r[1]) || 0, state: String(r[13] || ''), start_date: d(r[3]), end_date: d(r[4]), start_weight: n(r[6]), target_weight: n(r[7]), origin: 'sheet', sheet_order: 1000 + i })),
  ].filter((r) => r.customer_id === 'C1');
  const mine = pickGoalLine(d1);
  const a = g ? JSON.stringify(g.line) : 'null';
  const b = mine ? JSON.stringify(mine.points) : 'null';
  gc++;
  if (a !== b) { if (gm < 2) console.log('  GAS goal :', a, '\n  mine goal:', b); gm++; }
}
ok(`1-2 ★目標線が GAS と同じ（ランダム ${gc} 通り）`, gm === 0, `不一致 ${gm}`);
ok('1-3 d1 の行はシートの行より後（同じ日なら d1 が勝つ）',
   synthesizeBody([{ id: 99, origin: 'd1', measured_date: '2026-10-01', source_raw: 'self', weight_kg: 71 },
                   { id: 1, origin: 'sheet', sheet_order: 5, measured_date: '2026-10-01', source_raw: 'inbody', weight_kg: 70 }])[0].w === 71);

// ================= 2・3. 入口（/body/write・/body/freeze・/body/series） =================
function makeEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(W, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(join(W, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    try { db.exec(readFileSync(join(W, 'migrations', f), 'utf8')); } catch (e) { if (!/duplicate column/.test(e.message)) throw e; }
  }
  const exec = (q, args, how) => {
    const st = db.prepare(q);
    if (how === 'first') { const r = st.get(...args); return r === undefined ? null : Object.assign({}, r); }
    if (how === 'all') return { results: st.all(...args).map((r) => Object.assign({}, r)) };
    const r = st.run(...args); return { meta: { changes: Number(r.changes) } };
  };
  const env = { SHARED_SECRET: SECRET, _db: db };
  env.DB = { prepare(q) { return { _q: q, _args: [], bind(...a) { this._args = a; return this; }, async run() { return exec(q, this._args, 'run'); },
                                   async first() { return exec(q, this._args, 'first'); }, async all() { return exec(q, this._args, 'all'); } }; },
             async batch(stmts) { db.exec('BEGIN'); try { const o = stmts.map((s) => exec(s._q, s._args, 'run')); db.exec('COMMIT'); return o; } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; } } };
  db.exec(`INSERT INTO customers (customer_id, name, created_at, updated_at) VALUES ('C1', 'x', 1, 1), ('C2', 'y', 1, 1)`);
  return env;
}
const env = makeEnv();
const q1 = (sql, ...a) => { const r = env._db.prepare(sql).get(...a); return r ? Object.assign({}, r) : null; };
async function post(path, body, secret = SECRET) {
  const res = await worker.fetch(new Request('https://w.example' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ingest-Secret': secret }, body: JSON.stringify(body) }), env, {});
  let j = {}; try { j = await res.json(); } catch (_) {}
  return { status: res.status, ...j };
}
{
  const r0 = await post('/body/write', { op: 'addWeight', channel: 'line', clientReqId: 'evt-00000001:w', customerId: 'C1', date: '2026-11-03', weightKg: 70 }, 'WRONG');
  ok('2-0 合言葉が違えば403', r0.status === 403);
  const r1 = await post('/body/write', { op: 'addWeight', channel: 'line', clientReqId: 'evt-00000001:w', customerId: 'C1', date: '2026-11-03', weightKg: 70 });
  ok('2-1 切り替え前（凍結が無い）は書かない', r1.status === 409 && r1.code === 'BODY_NOT_READY', JSON.stringify(r1));

  //   凍結を始める
  const counts = { body_log: 3, meal_goals: 1, goal_phases: 0 }, hashes = { body_log: 'h1', meal_goals: 'h2', goal_phases: 'h3' };
  ok('3-1 begin', (await post('/body/freeze', { op: 'begin', freezeId: 'fz20261103', counts, hashes })).ok === true);
  ok('3-2 同じ freezeId の begin は409', (await post('/body/freeze', { op: 'begin', freezeId: 'fz20261103', counts, hashes })).status === 409);
  const rowsBL = [['C1', '2026-11-03', 69.5, 20, '', '', '', 'inbody', 'T', '', ''], ['', '', '', '', '', '', '', '', '', '', ''], ['C1', '2026-11-02', 70, '', '', '', '', 'self', 'line', '', '']];
  const bad = await post('/body/freeze', { op: 'rows', freezeId: 'fz20261103', sheet: 'body_log', startOrder: 0, rows: rowsBL, hashNow: 'h1' });
  ok('3-3 写す（空行は写さないが順番は進む）', bad.ok === true && bad.copied === 3 && q1(`SELECT COUNT(*) n FROM body_measurements WHERE origin = 'sheet'`).n === 2, JSON.stringify(bad));
  const pos = await post('/body/freeze', { op: 'rows', freezeId: 'fz20261103', sheet: 'meal_goals', startOrder: 5, rows: [], hashNow: 'h2' });
  ok('3-4 位置が違えば受けない', pos.status === 409 && pos.code === 'BAD_POSITION');
  const early = await post('/body/freeze', { op: 'state', freezeId: 'fz20261103', state: 'copied' });
  ok('3-5 全シートを写すまでは copied にできない', early.status === 409 && early.code === 'NOT_COMPLETE');
  const mg = new Array(18).fill(''); mg[0] = 'C1'; mg[1] = '氏名は写さない'; mg[2] = '2026-09-01'; mg[3] = '2027-03-01'; mg[8] = 72; mg[10] = 65;
  ok('3-6 目標を写す（氏名は写さない）', (await post('/body/freeze', { op: 'rows', freezeId: 'fz20261103', sheet: 'meal_goals', startOrder: 0, rows: [mg], hashNow: 'h2' })).ok === true
     && !JSON.stringify(env._db.prepare('SELECT * FROM body_goals').all()).includes('氏名'));
  await post('/body/freeze', { op: 'rows', freezeId: 'fz20261103', sheet: 'goal_phases', startOrder: 0, rows: [], hashNow: 'h3' });

  //   凍結が始まったので書ける
  const w1 = await post('/body/write', { op: 'addWeight', channel: 'line', clientReqId: 'evt-00000002:w', customerId: 'C1', date: '2026-11-03', weightKg: 71 });
  ok('2-2 体重を書ける（d1）', w1.ok === true && w1.result && w1.result.id > 0, JSON.stringify(w1));
  const w1b = await post('/body/write', { op: 'addWeight', channel: 'line', clientReqId: 'evt-00000002:w', customerId: 'C1', date: '2026-11-03', weightKg: 71 });
  ok('2-3 同じ webhookEventId の再送は二重にならない', w1b.ok && w1b.replayed && q1(`SELECT COUNT(*) n FROM body_measurements WHERE origin = 'd1'`).n === 1);
  const f1 = await post('/body/write', { op: 'addFat', channel: 'line', clientReqId: 'evt-00000003:f', customerId: 'C1', date: '2026-11-03', fatPct: 25 });
  ok('2-4 体脂肪率は d1 の行に足される（除脂肪は同じ文で計算）', f1.ok && f1.result.fatPct === 25 && f1.result.leanKg === 53.3, JSON.stringify(f1));
  ok('2-5 sheet の行（凍結から写した行）は書き換えない', q1(`SELECT body_fat_pct FROM body_measurements WHERE origin = 'sheet' AND measured_date = '2026-11-03'`).body_fat_pct === 20);
  const f2 = await post('/body/write', { op: 'addFat', channel: 'line', clientReqId: 'evt-00000004:f', customerId: 'C1', date: '2026-11-02', fatPct: 22, knownWeightKg: 70 });
  ok('2-6 その日の d1 の行が無ければ known_weight_kg で作る（体重はシートにあった）', f2.ok && f2.result.weightKg === 70 && f2.result.fatPct === 22
     && q1(`SELECT COUNT(*) n FROM body_measurements WHERE origin = 'd1' AND measured_date = '2026-11-02'`).n === 1, JSON.stringify(f2));
  const f3 = await post('/body/write', { op: 'addFat', channel: 'line', clientReqId: 'evt-00000005:f', customerId: 'C1', date: '2026-11-01', fatPct: 22 });
  ok('2-7 どちらも無ければ「先に体重を」（何も書かない）', f3.status === 404 && f3.code === 'NEED_WEIGHT_FIRST'
     && !q1(`SELECT 1 x FROM body_requests WHERE client_req_id = 'evt-00000005:f'`));
  const ib = await post('/body/write', { op: 'addInBody', channel: 'gas_inbody', clientReqId: 'liff-0000000006', customerId: 'C1', date: '2026-11-03', values: { weight_kg: 71.2, body_fat_pct: 24 }, enteredBy: '一郎' });
  ok('2-8 古い画面の InBody も D1 へ', ib.ok === true && q1(`SELECT source_raw FROM body_measurements WHERE id = ?`, ib.result.id).source_raw === 'inbody');
  const oor = await post('/body/write', { op: 'addWeight', channel: 'line', clientReqId: 'evt-00000007:w', customerId: 'C1', date: '2026-11-03', weightKg: 900 });
  ok('2-9 範囲外は書かない', oor.status === 400);

  //   ハッシュが変わったら failed
  const env2 = env; // 同じ環境で別の freeze を試す
  await post('/body/freeze', { op: 'begin', freezeId: 'fzbroken01', counts: { body_log: 1, meal_goals: 0, goal_phases: 0 }, hashes: { body_log: 'A', meal_goals: 'B', goal_phases: 'C' } });
  const hc = await post('/body/freeze', { op: 'rows', freezeId: 'fzbroken01', sheet: 'body_log', startOrder: 0, rows: [], hashNow: 'CHANGED' });
  ok('3-7 凍結用シートが変わっていたら failed', hc.status === 409 && hc.code === 'HASH_CHANGED' && q1(`SELECT state FROM body_freeze WHERE freeze_id = 'fzbroken01'`).state === 'failed');

  ok('3-8 copied', (await post('/body/freeze', { op: 'state', freezeId: 'fz20261103', state: 'copied' })).ok === true);
  //   突き合わせ用：sheet の行だけで計算
  const ser = await post('/body/series', { mode: 'sheet', freezeId: 'fz20261103', customerId: 'C1' });
  ok('3-9 /body/series（sheet だけ）は凍結した中身の答え', ser.ok && ser.rows.length === 2 && ser.rows.find((r) => r.d === '2026-11-03').w === 69.5
     && ser.goal && ser.goal.points.length === 2, JSON.stringify(ser).slice(0, 300));
  const live0 = await post('/body/series', { mode: 'live', customerId: 'C1' });
  ok('3-10a ★verified の前の live は凍結の写しを返さない（d1 だけ）', live0.ok && live0.freezeId === null && !live0.rows.some((r) => r.d === '2026-11-02' && r.s && r.s.w === 's' && r.w === 70 && !r.pbf), JSON.stringify(live0.rows));
  ok('3-11 verified', (await post('/body/freeze', { op: 'state', freezeId: 'fz20261103', state: 'verified' })).ok === true);
  const live = await post('/body/series', { mode: 'live', customerId: 'C1' });
  ok('3-10 /body/series（live）は verified の写し＋d1（同じ日は d1 が後勝ち）', live.ok && live.freezeId === 'fz20261103' && live.rows.find((r) => r.d === '2026-11-03').w === 71.2, JSON.stringify(live.rows));
  ok('3-12 verified から copying へは戻れない', (await post('/body/freeze', { op: 'state', freezeId: 'fz20261103', state: 'copying' })).status === 409);
}

console.log(`\n${fail ? '❌' : '✅'} 体の記録を D1 に 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
