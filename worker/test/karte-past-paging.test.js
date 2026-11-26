// 設計62 段1（記録・指導の履歴のページ送り・全期間の集計・1件の読み直し）を、本物の SQLite に schema.sql と全 migration を流し、入口（index.js）から通す・2026-11-25
//   実行: node worker/test/karte-past-paging.test.js
//   ★D1 の身代わり（配列）では CHECK・部分 UNIQUE・見張り（karte_guard）が再現しない＝node:sqlite に全 migration を流す
//   ★守り（許可表・Origin・トークン・二重送信・回数・切替）は index.js と runWrite にある＝入口から通す
//   ★会員・トレーナーの名前・ID は架空の値だけ

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';
import { trainingAggregates, PAST_LIMITS, parseCursor, traceSession, windowStart, cursorOf } from '../src/routes/karte.js';
import { buildMemberKarte } from '../src/lib/member-karte.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const W = join(HERE, '..');
const ORIGIN = 'https://reservation.tokowaka-gym.com';
const CHANNEL = '1234567890';
const MIG_DIR = join(W, 'migrations');

let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) pass++; else { fail++; console.log(`❌ ${name}${detail ? '\n   ' + detail : ''}`); } }

// ---------------- D1 の身代わり（実物の SQLite）----------------
//   upto：その名前より前の migration だけ流す（T1 で 0029 を自分で流すため）
function makeDb(upto) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(W, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(MIG_DIR).filter((x) => x.endsWith('.sql')).sort()) {
    if (upto && f >= upto) continue;
    try { db.exec(readFileSync(join(MIG_DIR, f), 'utf8')); } catch (e) {
      if (!/duplicate column/.test(e.message)) throw e;
    }
  }
  return db;
}
//   env._hook(q, args) → null（そのまま）／[[q, args], …]（その文の代わりに流す。空配列＝落とす）
function makeEnv() {
  const db = makeDb();
  const env = { LINE_CHANNEL_ID: CHANNEL, _db: db, _kv: {}, _hook: null };
  const run1 = (q, args, how) => {
    const st = db.prepare(q);
    if (how === 'first') { const r = st.get(...args); return r === undefined ? null : Object.assign({}, r); }
    if (how === 'all') return { results: st.all(...args).map((r) => Object.assign({}, r)) };
    const r = st.run(...args);
    return { meta: { changes: Number(r.changes) } };
  };
  const exec = (q, args, how) => {
    if (env._hook && how === 'run') {
      const rep = env._hook(q, args);
      if (rep) { let last = { meta: { changes: 0 } }; for (const [q2, a2] of rep) last = run1(q2, a2, 'run'); return last; }
    }
    return run1(q, args, how);
  };
  env.KV = { async get(k, t) { const v = env._kv[k]; return v == null ? null : (t === 'json' ? JSON.parse(v) : v); }, async put(k, v) { env._kv[k] = v; } };
  env.DB = {
    prepare(q) {
      if (env._tick) env._tick(q);
      const boom = env._failRe && env._failRe.test(q);
      if (boom) return { _q: q, _args: [], bind() { return this; }, async run() { throw new Error('D1_ERROR'); }, async first() { throw new Error('D1_ERROR'); }, async all() { throw new Error('D1_ERROR'); } };
      return { _q: q, _args: [], bind(...a) { this._args = a; return this; },
               async run() { return exec(q, this._args, 'run'); }, async first() { return exec(q, this._args, 'first'); },
               async all() { return exec(q, this._args, 'all'); } };
    },
    async batch(stmts) {
      db.exec('BEGIN');
      try { const out = stmts.map((s) => exec(s._q, s._args, 'run')); db.exec('COMMIT'); return out; }
      catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
    },
  };
  return env;
}
const q1 = (env, sql, ...a) => { const r = env._db.prepare(sql).get(...a); return r ? Object.assign({}, r) : null; };
const qn = (env, sql, ...a) => Number(q1(env, sql, ...a).n);
const qa = (env, sql, ...a) => env._db.prepare(sql).all(...a).map((r) => Object.assign({}, r));

// ---------------- トークン（ES256）----------------
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pubJwk = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'k1', alg: 'ES256' };
async function token(sub) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: 'ES256', kid: 'k1', typ: 'JWT' }));
  const pl = b64u(JSON.stringify({ iss: 'https://access.line.me', aud: CHANNEL, sub, exp: now + 3600, iat: now }));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(h + '.' + pl));
  return h + '.' + pl + '.' + b64u(sig);
}

// ---------------- 見本 ----------------
const env = makeEnv();
env._kv['jwks:line'] = JSON.stringify({ keys: [pubJwk] });
const d = env._db;
d.exec(`INSERT INTO trainers (trainer_id, name, line_user_id, role, active) VALUES
  ('t1', '見本一郎', 'U_t1', 'trainer', 1), ('t2', '見本二郎', 'U_t2', 'trainer', 1), ('t3', '見本三郎', 'U_t3', 'trainer', 1), ('OWN', '見本店主', 'U_OWN', 'owner', 1)`);
d.exec(`INSERT INTO customers (customer_id, name, line_user_id, default_trainer_id, created_at, updated_at) VALUES
  ('C1', '見本会員一', NULL, 't1', 1, 1), ('C2', '見本会員二', NULL, 't2', 1, 1), ('C3', '見本会員三', NULL, NULL, 1, 1), ('C4', '見本会員四', NULL, NULL, 1, 1)`);
const fresh = () => d.exec(`INSERT INTO sync_state (key, synced_at, rows, ok) VALUES ('customers', ${Date.now()}, 4, 1), ('trainers', ${Date.now()}, 4, 1), ('reservations', ${Date.now()}, 0, 1)
  ON CONFLICT(key) DO UPDATE SET synced_at = excluded.synced_at`);
fresh();

let reqSeq = 0;
const crid = () => 'xreq-' + (++reqSeq).toString().padStart(6, '0');
async function call(as, action, body = {}) {
  const payload = JSON.stringify({ action, idToken: await token(as), ...body });
  const res = await worker.fetch(new Request('https://w.example/', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: payload }), env, { waitUntil() {} });
  let j = {};
  try { j = await res.json(); } catch (_) {}
  return { status: res.status, ...j };
}
const clearRate = () => d.exec('DELETE FROM karte_rate');
const jstDay = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
const NOW = Date.now();
const dayOffset = (n) => jstDay(NOW + n * 86400000);
const today = dayOffset(0);
const add = (as, cid, date, items, extra = {}) => call(as, 'k_addTraining', { customerId: cid, sessionDate: date, items, clientReqId: extra.clientReqId || crid(), ...extra });
const counts = () => ({
  sessions: qn(env, `SELECT COUNT(*) n FROM karte_tr_sessions`), sets: qn(env, `SELECT COUNT(*) n FROM karte_tr_sets`),
  ext: qn(env, `SELECT COUNT(*) n FROM karte_tr_set_ext`), drops: qn(env, `SELECT COUNT(*) n FROM karte_tr_drops`),
  ex: qn(env, `SELECT COUNT(*) n FROM karte_tr_exercises`), mnotes: qn(env, `SELECT COUNT(*) n FROM karte_member_notes`),
  live: qn(env, `SELECT COUNT(*) n FROM karte_tr_sessions WHERE deleted_at IS NULL`), rv: qn(env, `SELECT COUNT(*) n FROM karte_revisions`),
});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const P1 = [
  { exercise: '腸腰筋ストレッチ', sets: [], doneOnly: true },
  { exercise: 'フロアアブ', sets: [{ weight: 0, reps: 10 }, { weight: 10, reps: 10, drops: [{ weight: 0, reps: 10 }, { weight: 5, reps: 8, assist: 2 }] }] },
  { exercise: 'ヒップリフト', sets: [{ weight: 30, reps: 10, note: '見本のメモ' }, { weight: 50, reps: 10, assist: 5 }, { weight: 80, reps: 5, forced: true }] },
  { exercise: 'ヒップリフト', sets: [{ weight: 40, reps: 12 }] },
];
const edit = (as, body, extra = {}) => call(as, 'k_editTraining', { clientReqId: extra.clientReqId || crid(), ...body });

env.KARTE_TRAINING_EXT = 'on';
env.KARTE_TRAINING_EDIT = 'on';
d.exec(`INSERT INTO customers (customer_id, name, line_user_id, default_trainer_id, created_at, updated_at) VALUES
  ('P1', '見本会員五', NULL, 't1', 1, 1), ('P2', '見本会員六', NULL, 't1', 1, 1), ('P3', '見本会員七', NULL, 't1', 1, 1),
  ('P4', '見本会員八', NULL, 't1', 1, 1), ('P5', '見本会員九', NULL, 't1', 1, 1), ('P6', '見本会員十', NULL, 't1', 1, 1), ('P7', '見本会員十一', NULL, 't1', 1, 1)`);
fresh();
//   直接入れる（API の上限・回数制限を通さず、並びの境の形を作るため）。sets：[[種目, 重さ, 回数], …]
let seq = 0;
function ins(cid, date, created, sets = [['ベンチプレス', 60, 10]], id) {
  const sid = id || 'S' + String(++seq).padStart(6, '0');
  d.prepare(`INSERT INTO karte_tr_sessions (session_id, customer_id, session_date, author_trainer_id, rev, created_at) VALUES (?, ?, ?, 't1', 1, ?)`).run(sid, cid, date, created);
  sets.forEach((x, i) => d.prepare(`INSERT INTO karte_tr_sets (session_id, exercise, set_no, weight_kg, reps) VALUES (?, ?, ?, ?, ?)`).run(sid, x[0], i + 1, x[1], x[2]));
  return sid;
}
function insNote(cid, date, created, id) {
  const nid = id || 'N' + String(++seq).padStart(6, '0');
  d.prepare(`INSERT INTO karte_notes (note_id, customer_id, session_date, body, author_trainer_id, rev, created_at) VALUES (?, ?, ?, '見本のメモ', 't1', 1, ?)`).run(nid, cid, date, created);
  return nid;
}
const ids = (r) => (r.sessions || []).map((x) => x.session_id);
const sqlOrder = (cid) => qa(env, `SELECT session_id FROM karte_tr_sessions WHERE customer_id = ? AND deleted_at IS NULL ORDER BY session_date DESC, created_at DESC, session_id DESC`, cid).map((x) => x.session_id);
//   初回 → R のカーソルで最後まで → older:true → O のカーソルで最後まで。系列ごとの id の並びを返す
async function pageAll(action, cid, key) {
  const pick = (r) => (r[key] || []).map((x) => x.session_id || x.note_id);
  const recent = [], older = []; let n = 0;
  let r = await call('U_t2', action, { customerId: cid });
  const first = r;
  for (;;) { recent.push(...pick(r)); if (!r.more || ++n > 30) break; r = await call('U_t2', action, { customerId: cid, cursor: r.nextCursor }); }
  const lastR = r;
  r = await call('U_t2', action, { customerId: cid, older: true });
  for (;;) { older.push(...pick(r)); if (!r.more || ++n > 60) break; r = await call('U_t2', action, { customerId: cid, cursor: r.nextCursor }); }
  return { first, recent, older, lastR, lastO: r };
}
const B = windowStart(NOW);   // 今の境界（Worker と同じ関数・同じ時計）
const inWin = (n) => dayOffset(-n);          // 1〜50日前は必ず境界以後（月初でも境界は59日以上前）
const outWin = (n) => dayOffset(-(100 + n));  // 100日より前は必ず境界より前（境界は最大でも92日前）

// ================= P1・B7・B8 系列ごとのページ送り：R は境界より前へ進まない・O は境界より前だけ・同じ日の境（I93） =================
{
  //   境界以後102回：50日×2回＋51日前に同じ作成時刻の3回（100件目と101件目の境）
  for (let i = 0; i < 50; i++) { ins('P1', inWin(i + 1), 2000 + i * 2); ins('P1', inWin(i + 1), 2001 + i * 2); }
  for (const id of ['SAME-a', 'SAME-b', 'SAME-c']) ins('P1', inWin(51), 500, [['スクワット', 80, 5]], id);
  for (let i = 0; i < 6; i++) ins('P1', outWin(i), 400 - i);
  const all = sqlOrder('P1');
  const { first, recent, older, lastR, lastO } = await pageAll('k_training', 'P1', 'sessions');
  const wantR = qa(env, `SELECT session_id FROM karte_tr_sessions WHERE customer_id = 'P1' AND session_date >= ? ORDER BY session_date DESC, created_at DESC, session_id DESC`, B).map((x) => x.session_id);
  ok('P1 ★初回は境界以後だけ・上限100・boundary・older', first.status === 200 && first.boundary === B && first.sessions.length === 100 && first.more === true && first.older === true
     && first.sessions.every((x) => x.session_date >= B) && parseCursor(first.nextCursor).kind === 'R' && parseCursor(first.nextCursor).b === B, JSON.stringify([first.boundary, first.sessions.length, first.more, first.older, first.nextCursor]));
  ok('P1 ★R の系列は境界以後を全件・重複なし・順序どおり（同じ日・同じ作成時刻が100件目と101件目にまたがる）', recent.length === 103 && new Set(recent).size === 103 && same(recent, wantR), JSON.stringify(recent.slice(98)));
  ok('B7 ★R を読み切ると more:false・境界より前の行が1つも混ざらない', lastR.more === false && lastR.nextCursor === null && recent.every((id) => wantR.indexOf(id) >= 0)
     && qa(env, `SELECT session_date d FROM karte_tr_sessions WHERE session_id IN (${recent.map(() => '?').join(',')})`, ...recent).every((x) => x.d >= B));
  ok('B8 ★O は境界より前だけ・R と O は交わらない・合わせると全部', older.length === 6 && lastO.more === false && older.every((id) => wantR.indexOf(id) < 0) && same(recent.concat(older), all), JSON.stringify(older));
  for (let i = 0; i < 100; i++) ins('P2', inWin(1 + (i % 50)), 100 + i);
  const r2 = await call('U_t2', 'k_training', { customerId: 'P2' });
  ok('P3 境界以後がちょうど100回なら more は偽・nextCursor は null・境界より前が無ければ older は偽', r2.more === false && r2.nextCursor === null && r2.sessions.length === 100 && r2.older === false, JSON.stringify([r2.more, r2.older]));
}

// ================= P2・B9・B12 壊れた要求・月が替わったカーソル（I93） =================
{
  const prevB = windowStart(NOW - 31 * 86400000);
  const bad = [
    { cursor: `R|${B}|2026-02-30|1|a` }, { cursor: 'x' }, { cursor: `R|${B}|2026-01-01|abc|a` }, { cursor: `R|${B}|2026-01-01|1|a b` }, { cursor: 5 },
    { cursor: '2026-01-01|1|a' },   // WIP の3要素の形（main に出ていない＝互換の外）
    { cursor: `M|2026-01|2026-01-05|1|a` }, { cursor: `X|${B}|2026-01-01|1|a` },
    { before: '2026-13-01' }, { before: 7 }, { sessionId: 'a b' }, { older: false }, { older: 'true' }, { month: '2026-01' },
    { cursor: cursorOf('R', B, '2026-01-01', 1, 'a'), before: '2026-01-01' }, { cursor: cursorOf('R', B, '2026-01-01', 1, 'a'), sessionId: 'S1' },
    { before: '2026-01-01', sessionId: 'S1' }, { older: true, before: '2026-01-01' }, { older: true, sessionId: 'S1' },
  ];
  const rs = [];
  for (const b of bad) rs.push((await call('U_t2', 'k_training', { customerId: 'P1', ...b })).status);
  ok('P2/B12 ★k_training：壊れたカーソル・WIP の3要素の形・M の系列・before・sessionId・older の型違い・month・形の鍵の同時は 400', rs.every((x) => x === 400), JSON.stringify(rs));
  const ns = [];
  for (const b of [{ cursor: 'x' }, { sessionId: 'S1' }, { month: '2026-01' }, { older: 1 }, { cursor: cursorOf('O', B, '2026-01-01', 1, 'a'), before: '2026-01-01' }, { older: true, before: 'y' }, { before: 'y' }]) ns.push((await call('U_t2', 'k_notes', { customerId: 'P1', ...b })).status);
  ok('P2/B12 k_notes：壊れたカーソル・sessionId・month（段2 まで受けない）・older の型違い・同時・壊れた before は 400', ns.every((x) => x === 400), JSON.stringify(ns));
  const m1 = await call('U_t2', 'k_training', { customerId: 'P1', cursor: cursorOf('R', prevB, inWin(5), 1, 'a') });
  const m2 = await call('U_t2', 'k_training', { customerId: 'P1', cursor: cursorOf('O', prevB, outWin(1), 1, 'a') });
  const m3 = await call('U_t2', 'k_notes', { customerId: 'P1', cursor: cursorOf('R', prevB, inWin(5), 1, 'a') });
  ok('B9 ★前の月の境界で発行したカーソル（R・O・指導の履歴）は 409 BOUNDARY_MOVED', prevB !== B && m1.status === 409 && m1.code === 'BOUNDARY_MOVED' && m2.status === 409 && m3.status === 409, JSON.stringify([prevB, m1.status, m1.code]));
  const blank = await call('U_t2', 'k_training', { customerId: 'P1', before: '' });
  ok('P2 旧画面の before:""（空）は「無い」＝初回', blank.status === 200 && blank.boundary === B && 'older' in blank);
}

// ================= P16a 要求の形（k_training） =================
{
  const f = await call('U_t2', 'k_training', { customerId: 'P1' });
  const pg = await call('U_t2', 'k_training', { customerId: 'P1', cursor: f.nextCursor });
  const od = await call('U_t2', 'k_training', { customerId: 'P1', older: true });
  const bf = await call('U_t2', 'k_training', { customerId: 'P1', before: inWin(10) });
  const one = await call('U_t2', 'k_training', { customerId: 'P1', sessionId: 'SAME-b' });
  const noAgg = (r) => ['bestAll', 'seriesAll', 'allDates', 'agg', 'older'].every((k) => !(k in r));
  const all = await call('U_t2', 'k_trainingAll', { customerId: 'P1' });
  ok('P16a ★初回（形の鍵なし・旧画面の customerId だけ）は一覧と older だけ・全期間の集計は別の窓口 k_trainingAll（関門② 中2）', f.status === 200 && 'older' in f && !('agg' in f) && !('bestAll' in f)
     && all.status === 200 && all.agg && all.agg.best === 'ok' && all.agg.series === 'ok' && all.agg.dates === 'ok' && Array.isArray(all.bestAll) && !('sessions' in all), JSON.stringify(Object.keys(all)));
  const allBad = [];
  for (const b of [{ cursor: 'x' }, { older: true }, { before: '2026-01-01' }, { sessionId: 'S1' }, { month: '2026-01' }]) allBad.push((await call('U_t2', 'k_trainingAll', { customerId: 'P1', ...b })).status);
  const allOther = await call('U_t2', 'k_trainingAll', { customerId: 'NO-SUCH' });
  const lg = q1(env, `SELECT section, action, result FROM karte_access_log WHERE action LIKE 'k_training%' AND section <> 'training' ORDER BY id DESC LIMIT 1`);
  ok('P16a access_log の action は窓口の名前と同じ k_trainingAll（中身は書かない）', lg && lg.action === 'k_trainingAll' && lg.section === 'trainingAll', JSON.stringify(lg));
  ok('P16a k_trainingAll に形の鍵を送ったら 400・見えない会員は 404', allBad.every((x) => x === 400) && allOther.status === 404, JSON.stringify([allBad, allOther.status]));
  ok('P16a ★R のページ送り・older・前回の読み足しには集計が付かない・前回の読み足しは nextCursor を返さない', pg.status === 200 && noAgg(pg) && od.status === 200 && noAgg(od) && bf.status === 200 && noAgg(bf)
     && pg.sessions.length === 3 && bf.nextCursor === null && od.sessions.length === 6 && od.sessions.every((x) => x.session_date < B));
  ok('P16a ★1件の読み直しは extra と trace だけ（20回も集計も返さない）', one.status === 200 && noAgg(one) && !('sessions' in one) && one.trace === 'live' && one.extra && one.extra.session_id === 'SAME-b'
     && one.extra.sets.length === 1 && 'trainingEdit' in one && 'karteSchema' in one, JSON.stringify(one).slice(0, 300));
}

// ================= B10 1つの要求の途中で月替わりの時刻をまたいでも、行・older・boundary・カーソルの境界が同じ（I93） =================
{
  const realNow = Date.now;
  const T0 = Date.UTC(2026, 10, 30, 14, 59, 59, 500);   // 2026-11-30 23:59:59.5 JST → 境界 2026-09-01
  const T1 = Date.UTC(2026, 10, 30, 15, 0, 1, 0);       // 2026-12-01 00:00:01 JST → 境界 2026-10-01
  let clock = T0;
  Date.now = () => clock;
  try {
    fresh();
    for (let i = 0; i < 101; i++) ins('P7', '2026-11-' + String(1 + (i % 25)).padStart(2, '0'), 3000 + i);
    ins('P7', '2026-09-15', 10, [['デッドリフト', 120, 3]], 'P7-SEP');   // 古い境界の中・新しい境界の外
    env._tick = (q) => { if (/FROM karte_tr_sessions\s+WHERE customer_id = \? AND deleted_at IS NULL AND session_date >= \?/.test(q)) clock = T1; };   // 境界を決めた後（行を読む文の準備の時点）に時計を進める＝older・集計・カーソルは進んだ後に作られる
    const r = await call('U_t2', 'k_training', { customerId: 'P7' });
    env._tick = null;
    const cu = parseCursor(r.nextCursor);
    ok('B10 ★要求の途中で月が替わっても、応答の boundary・発行したカーソルの境界は要求の冒頭の値（2026-09-01）', r.status === 200 && clock === T1 && r.boundary === '2026-09-01' && cu && cu.b === '2026-09-01', JSON.stringify([r.status, r.boundary, r.nextCursor]));
    ok('B10 ★older も同じ境界で数える（9/1 より前は無い＝偽。新しい境界なら 9/15 で真になる）', r.older === false, String(r.older));
    clock = T1; fresh();
    const r2 = await call('U_t2', 'k_training', { customerId: 'P7', cursor: r.nextCursor });
    ok('B10 月が替わった後にそのカーソルを使うと 409（初回から読み直させる）', r2.status === 409 && r2.code === 'BOUNDARY_MOVED');
    const r3 = await call('U_t2', 'k_training', { customerId: 'P7', older: true });
    ok('B10 月が替わった後の older は新しい境界（10/1）より前＝9/15 の回が出る', r3.status === 200 && r3.boundary === '2026-10-01' && r3.sessions.some((x) => x.session_id === 'P7-SEP'));
  } finally { Date.now = realNow; env._tick = null; fresh(); }
}

// ================= P9 前回の読み足し：D 当日を1件も含まない（§4-6・I59） =================
{
  const D = dayOffset(-50);
  for (let i = 0; i < 21; i++) ins('P3', D, 9000 + i);
  const prev = ins('P3', dayOffset(-51), 100, [['デッドリフト', 100, 5]]);
  ins('P3', dayOffset(-49), 100);
  const r = await call('U_t2', 'k_training', { customerId: 'P3', before: D });
  ok('P9 ★D 当日に21件・D−1 に1件 → before:D は D 当日を含まず D−1 が先頭（カーソルで読み足すと D 当日で埋まる）', r.status === 200 && r.sessions.length === 1 && r.sessions[0].session_id === prev
     && r.sessions.every((x) => x.session_date < D) && r.nextCursor === null, JSON.stringify(ids(r)));
}

// ================= P4・P5 全期間の自己ベスト（会員と同じ関数・同点は早い日・無理やりを除く）（I66・I94） =================
{
  clearRate();
  await add('U_t1', 'P4', dayOffset(-3), [{ exercise: 'ベンチプレス', sets: [{ weight: 100, reps: 3, forced: true }, { weight: 60, reps: 10 }] }]);
  await add('U_t1', 'P4', dayOffset(-9), [{ exercise: 'ベンチプレス', sets: [{ weight: 60, reps: 10 }] }]);
  //   25回前にしか無い種目（1ページ目の20回の外）
  ins('P4', dayOffset(-200), 1, [['レッグプレス', 140, 8]]);
  for (let i = 0; i < 24; i++) ins('P4', dayOffset(-(100 + i)), 10 + i, [['ベンチプレス', 40, 10]]);
  const r = Object.assign(await call('U_t2', 'k_training', { customerId: 'P4' }), await call('U_t2', 'k_trainingAll', { customerId: 'P4' }));
  const mk = await buildMemberKarte(env, 'P4', {});
  const bp = (r.bestAll || []).filter((x) => x.exercise === 'ベンチプレス')[0];
  const mbp = mk.training.best.filter((x) => x.exercise === 'ベンチプレス')[0];
  ok('P4 ★トレーナーの全期間の自己ベストは無理やりを除き、同点は早い日（会員の画面と同じ答え）', bp && bp.w === 60 && bp.r === 10 && bp.d === dayOffset(-9)
     && mbp && mbp.weight === 60 && mbp.reps === 10 && mbp.date === bp.d, JSON.stringify([bp, mbp]));
  const toM = (x) => ({ exercise: x.exercise, w: x.w, r: x.r, d: x.d });
  const fromM = mk.training.best.map((x) => ({ exercise: x.exercise, w: x.weight, r: x.reps, d: x.date }));
  ok('P4 ★全種目で会員の自己ベストと一致', same((r.bestAll || []).map(toM), fromM), JSON.stringify([r.bestAll, fromM]));
  const lp = (r.bestAll || []).filter((x) => x.exercise === 'レッグプレス')[0];
  const lps = (r.seriesAll || []).filter((x) => x.exercise === 'レッグプレス');
  ok('P5 ★3か月より前（詳しい一覧の外）にしか無い種目も自己ベスト・推移に出る', r.sessions.length === 2 && !r.sessions.some((s) => s.sets.some((x) => x.exercise === 'レッグプレス'))
     && lp && lp.w === 140 && lps.length === 1 && lps[0].d === dayOffset(-200), JSON.stringify([lp, lps]));
  ok('P5 allDates は [{d, n}]・新しい順', Array.isArray(r.allDates) && r.allDates[0].d === dayOffset(-3) && r.allDates.every((x) => typeof x.n === 'number'), JSON.stringify(r.allDates.slice(0, 3)));
}

// ================= P11 集計の1つだけ失敗 → その値は null・unavailable・20回は返る（I94） =================
{
  env._failRe = /ROW_NUMBER\(\) OVER/;
  const r = Object.assign(await call('U_t2', 'k_training', { customerId: 'P4' }), await call('U_t2', 'k_trainingAll', { customerId: 'P4' }));
  env._failRe = /GROUP BY session_date/;
  const r2 = await call('U_t2', 'k_trainingAll', { customerId: 'P4' });
  env._failRe = null;
  ok('P11 ★自己ベストの読みが失敗：bestAll は null（空配列にしない）・agg.best=unavailable・推移と詳しい一覧は返る', r.status === 200 && r.bestAll === null && r.agg.best === 'unavailable'
     && Array.isArray(r.seriesAll) && r.agg.series === 'ok' && r.sessions.length === 2, JSON.stringify(r.agg));
  ok('P11 ★日付の読みが失敗：allDates は null・agg.dates=unavailable（集計の窓口は 200 のまま）', r2.status === 200 && r2.allDates === null && r2.agg.dates === 'unavailable' && r2.agg.best === 'ok', JSON.stringify(r2.agg));
}

// ================= P12・P13・P17 上限と打ち切り（小さな上限で関数を直接） =================
{
  const L = { ...PAST_LIMITS, BEST_TRAINER: 3, SERIES_SESSIONS: 3, DATES: 2 };
  ins('P5', dayOffset(-1), 1, [['A種目', 10, 10], ['B種目', 10, 10], ['C種目', 10, 10]]);
  const a3 = await trainingAggregates(env, 'P5', L);
  ok('P12/P17 ちょうど上限（3種目・1日・1回）は ok・打ち切りなし', a3.agg.best === 'ok' && a3.bestAll.length === 3 && a3.agg.series === 'ok' && a3.agg.dates === 'ok' && a3.seriesFrom === dayOffset(-1), JSON.stringify(a3.agg));
  ins('P5', dayOffset(-2), 2, [['D種目', 10, 10]]);
  ins('P5', dayOffset(-3), 3, [['E種目', 10, 10]]);
  const a5 = await trainingAggregates(env, 'P5', L);
  ok('P12 ★上限+1 種目 → bestTruncated（agg.best=truncated）・返すのは上限まで', a5.agg.best === 'truncated' && a5.bestAll.length === 3, JSON.stringify(a5.agg));
  ok('P17 ★日付 3日で上限2 → truncated・2日だけ', a5.agg.dates === 'truncated' && a5.allDates.length === 2);
  ok('P17 session ちょうど3件は推移の打ち切りなし', a5.agg.series === 'ok' && a5.seriesFrom === dayOffset(-3));
  //   4件目が別の日 → 先頭3件（-1・-2・-3）
  ins('P5', dayOffset(-4), 4, [['F種目', 10, 10]]);
  const a6 = await trainingAggregates(env, 'P5', L);
  ok('P17 ★4件目が別の日 → truncated・先頭3件の日まで（-4 は含まない）', a6.agg.series === 'truncated' && a6.seriesFrom === dayOffset(-3) && !a6.seriesAll.some((x) => x.d === dayOffset(-4)), JSON.stringify(a6.seriesAll));
  //   P13：3件目と4件目が同じ日 → その日を丸ごと外す。含めた日の値は全セットから
  ins('P6', dayOffset(-1), 50, [['ベンチプレス', 60, 1]]);
  ins('P6', dayOffset(-1), 40, [['ベンチプレス', 80, 1]]);   // 同じ日の2件目に最大
  ins('P6', dayOffset(-2), 30, [['ベンチプレス', 50, 1]]);
  ins('P6', dayOffset(-2), 20, [['ベンチプレス', 90, 1]]);   // 4件目＝3件目と同じ日
  const a7 = await trainingAggregates(env, 'P6', L);
  const v1 = a7.seriesAll.filter((x) => x.d === dayOffset(-1))[0];
  ok('P13 ★打ち切りが同じ日の途中に来る → その日（-2）は丸ごと外れ、含めた日（-1）は全セットから（80）', a7.agg.series === 'truncated' && a7.seriesFrom === dayOffset(-1)
     && !a7.seriesAll.some((x) => x.d === dayOffset(-2)) && v1 && v1.e1rm === 80, JSON.stringify(a7.seriesAll));
}

// ================= P14 1件の読み直し：置き換わった版をたどる・消えた・たどれない（I95） =================
{
  clearRate();
  const a = await add('U_t1', 'P6', dayOffset(-20), [{ exercise: 'ベンチプレス', sets: [{ weight: 60, reps: 10 }] }]);
  const e1 = await edit('U_t1', { sessionId: a.sessionId, rev: 1, sessionDate: dayOffset(-20), items: [{ exercise: 'ベンチプレス', sets: [{ weight: 62.5, reps: 10 }] }] });
  const e2 = await edit('U_t1', { sessionId: e1.sessionId, rev: 1, sessionDate: dayOffset(-20), items: [{ exercise: 'ベンチプレス', sets: [{ weight: 65, reps: 10 }] }] });
  const r = await call('U_t2', 'k_training', { customerId: 'P6', sessionId: a.sessionId });
  ok('P14 ★2回直された最初の id → 最新の版が extra・trace=replaced・replacedFrom は最初の id', e2.status === 200 && r.status === 200 && r.trace === 'replaced' && r.extra && r.extra.session_id === e2.sessionId
     && r.replacedFrom === a.sessionId && r.extra.sets[0].weight_kg === 65, JSON.stringify(r).slice(0, 300));
  const b = await add('U_t1', 'P6', dayOffset(-21), [{ exercise: 'ベンチプレス', sets: [{ weight: 60, reps: 10 }] }]);
  await call('U_t1', 'k_deleteTraining', { sessionId: b.sessionId, rev: 1, clientReqId: crid() });
  const rd = await call('U_t2', 'k_training', { customerId: 'P6', sessionId: b.sessionId });
  ok('P14 ★本当に消えた → extra:null・trace=deleted', rd.status === 200 && rd.extra === null && rd.trace === 'deleted', JSON.stringify(rd));
  const other = ins('P5', dayOffset(-5), 9);
  const ro = await call('U_t2', 'k_training', { customerId: 'P6', sessionId: other });
  ok('P14 ★最初の id が他の会員の session → deleted（どの会員かを区別しない・中身を返さない）', ro.extra === null && ro.trace === 'deleted');
  const rn = await call('U_t2', 'k_training', { customerId: 'P6', sessionId: 'NO-SUCH' });
  ok('P14 無い id → deleted', rn.extra === null && rn.trace === 'deleted');
  //   たどれない：控えを作って形を壊す
  const forge = (from, to) => d.prepare(`INSERT INTO karte_revisions (table_name, row_id, rev, before_json, changed_by, changed_at, reason) VALUES ('karte_tr_sessions', ?, 1, json_object('replaced_by', ?), 't1', ?, 'edit')`).run(from, to, Date.now());
  const del = (sid) => d.prepare(`UPDATE karte_tr_sessions SET deleted_at = 1 WHERE session_id = ?`).run(sid);
  const x1 = ins('P6', dayOffset(-60), 1); del(x1); forge(x1, other);   // 他の会員を指す
  const y1 = ins('P6', dayOffset(-61), 1), y2 = ins('P6', dayOffset(-61), 2); del(y1); del(y2); forge(y1, y2); forge(y2, y1);   // 循環
  const z0 = ins('P6', dayOffset(-62), 1); del(z0); forge(z0, z0);   // 自分を指す
  const w0 = ins('P6', dayOffset(-63), 1); del(w0); forge(w0, 'bad id!');   // 形の違い
  //   6段（上限5の外）と5段（上限ちょうど）
  const chain = (n, base) => { const c = []; for (let i = 0; i <= n; i++) c.push(ins('P6', dayOffset(-base), i + 1)); for (let i = 0; i < n; i++) { del(c[i]); forge(c[i], c[i + 1]); } return c; };
  const c6 = chain(6, 70), c5 = chain(5, 71);
  const res = {};
  for (const [k, sid] of [['other', x1], ['cycle', y1], ['self', z0], ['shape', w0], ['six', c6[0]]]) res[k] = await call('U_t2', 'k_training', { customerId: 'P6', sessionId: sid });
  const r5 = await call('U_t2', 'k_training', { customerId: 'P6', sessionId: c5[0] });
  ok('P14 ★たどった先が他の会員・循環・自分を指す・形の違い・6段 → extra:null・trace=broken（他の会員の中身を返さない）',
     Object.values(res).every((x) => x.status === 200 && x.extra === null && x.trace === 'broken'), JSON.stringify(Object.fromEntries(Object.entries(res).map(([k, v]) => [k, [v.trace, v.extra && v.extra.session_id]]))));
  //   ★応答を組む段も customer_id で読み直す（二重の守り）。たどる関数そのものも他の会員で止まることを固定する
  const tx = await traceSession(env, 'P6', x1);
  ok('P14 ★たどる関数そのものが、他の会員を指す控えで broken（応答の段の守りに頼らない）', tx.sid === null && tx.trace === 'broken', JSON.stringify(tx));
  ok('P14 ★5段（上限ちょうど）はたどれる', r5.trace === 'replaced' && r5.extra && r5.extra.session_id === c5[5], JSON.stringify([r5.trace, r5.extra && r5.extra.session_id]));
}

// ================= P10 指導の履歴：初回は境界以後・O の系列は同じ日・同じ作成時刻が20件目と21件目にまたがっても全部 =================
{
  for (let i = 0; i < 5; i++) insNote('P2', inWin(i + 1), 5000 + i);
  for (let i = 0; i < 19; i++) insNote('P2', outWin(i + 1), 1000 - i);
  for (const id of ['NSAME-a', 'NSAME-b', 'NSAME-c']) insNote('P2', outWin(40), 500, id);
  const { first, recent, older, lastO } = await pageAll('k_notes', 'P2', 'notes');
  const want = qa(env, `SELECT note_id FROM karte_notes WHERE customer_id = 'P2' AND deleted_at IS NULL ORDER BY session_date DESC, created_at DESC, note_id DESC`).map((x) => x.note_id);
  ok('P10 ★指導の履歴の初回は境界以後だけ（5件）・boundary・older', first.status === 200 && first.boundary === B && first.notes.length === 5 && first.older === true && first.more === false && recent.length === 5);
  ok('P10 ★O の系列：同じ日・同じ作成時刻が20件目と21件目にまたがっても全件・重複なし・順序どおり・R と合わせると全部', older.length === 22 && new Set(older).size === 22 && same(recent.concat(older), want) && lastO.more === false, JSON.stringify(older.slice(18)));
  const b = await call('U_t2', 'k_notes', { customerId: 'P2', before: outWin(10) });
  ok('P16b k_notes の before だけ（旧互換）は D より前だけ・集計も older も付かない', b.status === 200 && b.notes.every((n) => n.session_date < outWin(10)) && !('older' in b) && b.nextCursor === null);
}

console.log(`${fail ? '❌' : '✅'} 記録の全期間表示（設計62 段1・Worker） 検証: ${pass} passed / ${fail} failed`);
if (fail) process.exit(1);
