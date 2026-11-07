// トレーニングの記録の新しい項目（設計38：種目の並び・数字の無い種目・補助・無理やり・ドロップ・受付の切替）を、
// 本物の SQLite に schema.sql と 0001〜0029 の migration を流し、入口（index.js）から通す・2026-11-07
//   実行: node worker/test/karte-training-ext.test.js
//
//   ★D1 の身代わり（配列）では CHECK・PRIMARY KEY・NOT NULL・見張り（karte_guard）が再現しない＝node:sqlite に全 migration を流す
//   ★守り（許可表・Origin・トークン・二重送信・回数・切替）は index.js と runWrite にある＝入口から通す
//   ★会員・トレーナーの名前・ID は架空の値だけ
//   ★T16 は Worker が組んだ文を身代わりの中で1か所ずつ壊し（env._hook）、見張り（trShape）が batch 全体を戻すかを見る

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import worker from '../src/index.js';
import { KARTE_HANDLERS, isKarteWrite, KARTE_SCHEMA, TR_SHAPE_CONDS, trainingExtOn, karteSchemaFor } from '../src/routes/karte.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const W = join(HERE, '..');
const ORIGIN = 'https://reservation.tokowaka-gym.com';
const CHANNEL = '1234567890';
const MIG_DIR = join(W, 'migrations');
const MIG29 = readFileSync(join(MIG_DIR, '0029_karte_tr_ext.sql'), 'utf8');
const KSRC = readFileSync(join(W, 'src/routes/karte.js'), 'utf8');

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
});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

//   設計38 §1 のオーナーの例（P1）を確定した構造にしたもの
const P1 = [
  { exercise: '腸腰筋ストレッチ', sets: [], doneOnly: true },
  { exercise: 'アーチスクワット', sets: [], doneOnly: true },
  { exercise: 'フロアアブ', sets: [{ weight: 0, reps: 10 }, { weight: 10, reps: 10, drops: [{ weight: 0, reps: 10 }] }, { weight: 10, reps: 10, drops: [{ weight: 0, reps: 10 }] }] },
  { exercise: 'ヒップリフト', sets: [{ weight: 30, reps: 10 }, { weight: 50, reps: 10, assist: 5 }, { weight: 80, reps: 5, forced: true }, { weight: 60, reps: 10, assist: 5 }, { weight: 60, reps: 10, assist: 5 }] },
  { exercise: 'ラットプルダウン', sets: [{ weight: 10, reps: 10 }, { weight: 15, reps: 10 }, { weight: 20, reps: 10 }] },
  { exercise: 'ドンキーキック', sets: [{ weight: 60, reps: 10 }, { weight: 80, reps: 10 }] },
  { exercise: 'ルーマニアン片足', sets: [{ weight: 9, reps: 10 }, { weight: 14, reps: 10 }] },
];
//   設計38 より前の画面（buildPayload）の出力の形：exercise・sets／weight・reps・note だけ
const OLD = [{ exercise: 'スクワット', sets: [{ weight: 40, reps: 10, note: '見本のメモ' }, { weight: 50, reps: 8 }] }, { exercise: 'ベンチプレス', sets: [{ weight: 30, reps: 10 }] }];

//   設計38 より前の Worker が書いた回（3つの表に行が無い）を作る
function oldSession(sid, cid, date, sets) {
  d.prepare(`INSERT INTO karte_tr_sessions (session_id, customer_id, session_date, author_trainer_id, rev, created_at) VALUES (?, ?, ?, 't1', 1, ?)`).run(sid, cid, date, Date.now());
  for (const s of sets) d.prepare(`INSERT INTO karte_tr_sets (session_id, exercise, set_no, weight_kg, reps, note) VALUES (?, ?, ?, ?, ?, NULL)`).run(sid, s[0], s[1], s[2], s[3]);
}

// ================= T1〜T5 migration（I65） =================
{
  const db = makeDb('0029');
  const setsSql0 = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'karte_tr_sets'`).get().sql;
  const first = MIG29.split(/;\s*\n/)[0] + ';';
  let err = '';
  try { db.exec(first); db.exec(MIG29); db.exec(MIG29); } catch (e) { err = e.message; }
  const objs = db.prepare(`SELECT type, name FROM sqlite_master WHERE name IN ('karte_tr_exercises', 'karte_tr_set_ext', 'karte_tr_drops', 'idx_karte_set_ext_session')`).all();
  ok('T1 ★0029：先頭の1文だけ→全体→全体がすべて通り、3つの表と索引が1つずつある', err === '' && /CREATE TABLE IF NOT EXISTS karte_tr_exercises/.test(first)
     && objs.length === 4 && objs.filter((o) => o.type === 'table').length === 3 && objs.filter((o) => o.type === 'index').length === 1, err || JSON.stringify(objs));
  const code = MIG29.replace(/--.*$/gm, '');
  ok('T1b ★0029 のソースに ALTER・DROP が無い（CREATE … IF NOT EXISTS だけ。説明のコメントは除いて見る）', !/\bALTER\b/i.test(code) && !/\bDROP\b/i.test(code)
     && (code.match(/\bCREATE\b/g) || []).length === (code.match(/\bCREATE (TABLE|INDEX) IF NOT EXISTS\b/g) || []).length);
  ok('T1b 0025 の karte_tr_sets の定義が 0029 の前後で同じ', db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'karte_tr_sets'`).get().sql === setsSql0);
  //   T1c：MAX(set_id) が NULL のとき、番号が自動で振られず NOT NULL で失敗する
  const extSql = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'karte_tr_set_ext'`).get().sql;
  const thr = (sql) => { try { db.prepare(sql).run(); return false; } catch (e) { return /NOT NULL/.test(e.message); } };
  const a = thr(`INSERT INTO karte_tr_set_ext (set_id, session_id, ord, assist_reps, forced) SELECT MAX(set_id), 'S', 1, NULL, NULL FROM karte_tr_sets WHERE session_id = '存在しない'`);
  const b = thr(`INSERT INTO karte_tr_drops (set_id, drop_seq, weight_kg, reps, assist_reps, forced) SELECT MAX(set_id), 1, 0, 10, NULL, NULL FROM karte_tr_sets WHERE session_id = '存在しない'`);
  const typ = db.prepare(`SELECT type FROM pragma_table_info('karte_tr_set_ext') WHERE name = 'set_id'`).get().type;
  ok('T1c ★付加・ドロップに NULL の親を入れると NOT NULL で失敗する（番号が自動で振られない）', a && b
     && db.prepare(`SELECT COUNT(*) n FROM karte_tr_set_ext`).get().n === 0 && db.prepare(`SELECT COUNT(*) n FROM karte_tr_drops`).get().n === 0);
  ok('T1c ★付加の set_id は INTEGER PRIMARY KEY でない（rowid の別名にしない）', typ === 'INT' && !/set_id\s+INTEGER\s+(NOT\s+NULL\s+)?PRIMARY\s+KEY/i.test(extSql), typ + ' / ' + extSql);

  const t = (sql, ...a2) => { try { db.prepare(sql).run(...a2); return true; } catch (_) { return false; } };
  const ext = (sid2, assist, forced) => t(`INSERT INTO karte_tr_set_ext (set_id, session_id, ord, assist_reps, forced) VALUES (?, 'S', 1, ?, ?)`, sid2, assist, forced);
  ok('T2 CHECK：assist_reps 0／101 は入らない・1／100 は入る', !ext(901, 0, null) && !ext(902, 101, null) && ext(903, 1, null) && ext(904, 100, null));
  ok('T3 CHECK：forced 0／2 は入らない・NULL／1 は入る', !ext(905, null, 0) && !ext(906, null, 2) && ext(907, null, 1) && ext(908, null, null));
  const drop = (seq, a2, f) => t(`INSERT INTO karte_tr_drops (set_id, drop_seq, weight_kg, reps, assist_reps, forced) VALUES (1, ?, 0, 10, ?, ?)`, seq, a2, f);
  ok('T4 CHECK：drop_seq 0／4 は入らない・ドロップの assist 0・forced 2 も入らない', !drop(0, null, null) && !drop(4, null, null) && !drop(1, 0, null) && !drop(1, null, 2) && drop(3, null, null));
  const xr = (ord, name, done) => t(`INSERT INTO karte_tr_exercises (session_id, ord, exercise, done_only) VALUES ('S', ?, ?, ?)`, ord, name, done);
  ok('T5 CHECK：ord 0／21 は入らない・種目名の前後の空白・51字・done_only 0 も入らない', !xr(0, 'a', null) && !xr(21, 'a', null) && !xr(2, ' a', null)
     && !xr(3, 'あ'.repeat(51), null) && !xr(4, 'a', 0) && xr(20, 'a', 1));
  ok('T5 CHECK：付加の ord 0／21 も入らない', !t(`INSERT INTO karte_tr_set_ext (set_id, session_id, ord) VALUES (950, 'S', 0)`) && !t(`INSERT INTO karte_tr_set_ext (set_id, session_id, ord) VALUES (951, 'S', 21)`));
}

env.KARTE_TRAINING_EXT = 'on';

// ================= T6〜T15b 受ける形（I65b） =================
let p1sid;
{
  clearRate();
  const r = await add('U_t1', 'C1', dayOffset(-10), OLD);
  const keys = Object.keys(r).filter((k) => k !== 'status' && k !== 'success').sort();
  ok('T6 ★古い形の要求は 200・答えは {sessionId, rev} だけ（1文字も変えない）', r.status === 200 && same(keys, ['rev', 'sessionId']) && r.rev === 1, JSON.stringify(r));
  const sid = r.sessionId;
  ok('T6 古い形でも3つの表に行ができる（ord は並び・印なし）', same(qa(env, `SELECT ord, exercise, done_only FROM karte_tr_exercises WHERE session_id = ? ORDER BY ord`, sid),
       [{ ord: 1, exercise: 'スクワット', done_only: null }, { ord: 2, exercise: 'ベンチプレス', done_only: null }])
     && qn(env, `SELECT COUNT(*) n FROM karte_tr_set_ext WHERE session_id = ? AND assist_reps IS NULL AND forced IS NULL`, sid) === 3
     && qn(env, `SELECT COUNT(*) n FROM karte_tr_sets WHERE session_id = ?`, sid) === 3);

  const p = await add('U_t1', 'C1', dayOffset(-9), P1);
  p1sid = p.sessionId;
  const c = (sql) => qn(env, sql, p1sid);
  ok('T7 ★例（P1）：種目7（数字の無い種目2）・本セット15・付加15・ドロップ2・補助3・無理やり1', p.status === 200
     && c(`SELECT COUNT(*) n FROM karte_tr_exercises WHERE session_id = ?`) === 7 && c(`SELECT COUNT(*) n FROM karte_tr_exercises WHERE session_id = ? AND done_only = 1`) === 2
     && c(`SELECT COUNT(*) n FROM karte_tr_sets WHERE session_id = ?`) === 15 && c(`SELECT COUNT(*) n FROM karte_tr_set_ext WHERE session_id = ?`) === 15
     && c(`SELECT COUNT(*) n FROM karte_tr_drops dr JOIN karte_tr_sets t ON t.set_id = dr.set_id WHERE t.session_id = ?`) === 2
     && c(`SELECT COUNT(*) n FROM karte_tr_set_ext WHERE session_id = ? AND assist_reps = 5`) === 3 && c(`SELECT COUNT(*) n FROM karte_tr_set_ext WHERE session_id = ? AND forced = 1`) === 1, JSON.stringify(p));
  const fs = q1(env, `SELECT t.weight_kg w, t.reps r, t.set_no, e.ord FROM karte_tr_set_ext e JOIN karte_tr_sets t ON t.set_id = e.set_id WHERE e.session_id = ? AND e.forced = 1`, p1sid);
  const dr = qa(env, `SELECT t.weight_kg pw, t.set_no, dr.drop_seq, dr.weight_kg w, dr.reps r FROM karte_tr_drops dr JOIN karte_tr_sets t ON t.set_id = dr.set_id WHERE t.session_id = ? ORDER BY t.set_no`, p1sid);
  ok('T7 印は入力したセットにだけ（無理やり＝ヒップリフト3本目 80×5・ドロップ＝フロアアブ2・3本目の下に 0×10）', fs && fs.w === 80 && fs.r === 5 && fs.set_no === 3 && fs.ord === 4
     && same(dr, [{ pw: 10, set_no: 2, drop_seq: 1, w: 0, r: 10 }, { pw: 10, set_no: 3, drop_seq: 1, w: 0, r: 10 }]), JSON.stringify([fs, dr]));

  const before = counts();
  const t8 = await add('U_t1', 'C1', today, [{ exercise: 'プランク', doneOnly: true, sets: [{ weight: 0, reps: 10 }] }]);
  ok('T8 doneOnly とセットの両方は 400 DONE_ONLY・行が増えない', t8.status === 400 && t8.detail === 'DONE_ONLY' && same(counts(), before), JSON.stringify(t8));
  const t8b = await add('U_t1', 'C1', today, [{ exercise: 'プランク', doneOnly: false, sets: [] }]);
  ok('T8 doneOnly は true だけ（false は 400 DONE_ONLY）', t8b.status === 400 && t8b.detail === 'DONE_ONLY');
  const t9 = await add('U_t1', 'C1', today, [{ exercise: 'プランク', sets: [] }]);
  ok('T9 doneOnly なしの sets:[] は今までどおり 400 SETS', t9.status === 400 && t9.detail === 'SETS');
  for (const [label, items] of [['セット rpe', [{ exercise: 'a', sets: [{ weight: 1, reps: 1, rpe: 8 }] }]],
                                ['ドロップ note', [{ exercise: 'a', sets: [{ weight: 1, reps: 1, drops: [{ weight: 0, reps: 5, note: 'x' }] }] }]],
                                ['ドロップ drops', [{ exercise: 'a', sets: [{ weight: 1, reps: 1, drops: [{ weight: 0, reps: 5, drops: [] }] }] }]],
                                ['種目 memo', [{ exercise: 'a', memo: '見本', sets: [{ weight: 1, reps: 1 }] }]],
                                ['古い形のセットにも知らない鍵', [{ exercise: 'a', sets: [{ weight: 1, reps: 1, rir: 2 }] }]]]) {
    const r2 = await add('U_t1', 'C1', today, items);
    ok('T10 ★知らない鍵は 400 SET_KEY：' + label, r2.status === 400 && r2.detail === 'SET_KEY', JSON.stringify(r2));
  }
  for (const v of [false, 1, 'true']) {
    const r2 = await add('U_t1', 'C1', today, [{ exercise: 'a', sets: [{ weight: 1, reps: 1, forced: v }] }]);
    const r3 = await add('U_t1', 'C1', today, [{ exercise: 'a', sets: [{ weight: 1, reps: 1, drops: [{ weight: 0, reps: 1, forced: v }] }] }]);
    ok(`T11 forced=${JSON.stringify(v)} は 400（true だけ）・ドロップの中も`, r2.status === 400 && r3.status === 400);
  }
  for (const v of [0, 101, 2.5, '5', null]) {
    const r2 = await add('U_t1', 'C1', today, [{ exercise: 'a', sets: [{ weight: 1, reps: 1, assist: v }] }]);
    ok(`T11b assist=${JSON.stringify(v)} は 400（1〜100 の整数だけ）`, r2.status === 400 && r2.detail === 'SET_VALUE');
  }
  const d4 = [1, 2, 3, 4].map((i) => ({ weight: 10 - i, reps: 10 }));
  const t12 = await add('U_t1', 'C1', today, [{ exercise: 'カール', sets: [{ weight: 20, reps: 10, drops: d4 }] }]);
  const t12b = await add('U_t1', 'C1', today, [{ exercise: 'カール', sets: [{ weight: 20, reps: 10, drops: 'x' }] }]);
  ok('T12 ドロップ4段・配列でないドロップは 400 DROPS', t12.status === 400 && t12.detail === 'DROPS' && t12b.status === 400 && t12b.detail === 'DROPS');
  const s11 = Array.from({ length: 11 }, () => ({ weight: 20, reps: 10 }));
  const t13 = await add('U_t1', 'C1', today, [{ exercise: 'スクワット', sets: s11 }]);
  const s10d = Array.from({ length: 10 }, () => ({ weight: 20, reps: 10, drops: [{ weight: 10, reps: 10 }, { weight: 5, reps: 10 }] }));
  const t13b = await add('U_t1', 'C2', today, [{ exercise: 'スクワット', sets: s10d }]);
  ok('T13 ord ごとの本セット11は 400 SETS・本セット10＋ドロップ20（合計30）は通る', t13.status === 400 && t13.detail === 'SETS' && t13b.status === 200, JSON.stringify([t13, t13b]));
  const ten2 = () => Array.from({ length: 10 }, () => ({ weight: 20, reps: 10, drops: [{ weight: 10, reps: 10 }, { weight: 5, reps: 10 }] }));
  clearRate();
  const t14ok = await add('U_t1', 'C2', today, [{ exercise: 'A', sets: ten2() }, { exercise: 'B', sets: ten2() }]);
  const b61 = ten2(); b61[0].drops.push({ weight: 1, reps: 10 });
  const before14 = counts();
  const t14 = await add('U_t1', 'C2', today, [{ exercise: 'A', sets: ten2() }, { exercise: 'B', sets: b61 }]);
  ok('T14 ★合計60（ドロップを含む）は通り、61は 400 TOTAL_SETS・行が増えない', t14ok.status === 200 && t14.status === 400 && t14.code === 'TOTAL_SETS' && same(counts(), before14), JSON.stringify([t14ok.status, t14]));
  const i21 = Array.from({ length: 21 }, (_, i) => ({ exercise: '種目' + i, sets: [], doneOnly: true }));
  const t15 = await add('U_t1', 'C2', today, i21);
  const t15ok = await add('U_t1', 'C2', today, i21.slice(0, 20));
  ok('T15 種目21は 400 ITEMS（数字の無い種目も数える）・20は通る', t15.status === 400 && t15.detail === 'ITEMS' && t15ok.status === 200, JSON.stringify([t15, t15ok.status]));
  const t15b = await add('U_t1', 'C2', today, [{ exercise: 'スクワット', sets: [{ weight: 12.25, reps: 10, assist: 2 }] }]);
  const t15c = await add('U_t1', 'C2', today, [{ exercise: 'スクワット', sets: [{ weight: 10, reps: 10, drops: [{ weight: 7.25, reps: 10 }] }] }]);
  const t15d = await add('U_t1', 'C2', today, [{ exercise: 'スクワット', sets: [{ weight: 12.25, reps: 10 }] }]);
  const w15 = t15d.sessionId ? q1(env, `SELECT weight_kg w FROM karte_tr_sets WHERE session_id = ?`, t15d.sessionId).w : null;
  const t15e = await add('U_t1', 'C2', today, [{ exercise: 'スクワット', sets: [{ weight: 12.5, reps: 10, forced: true }] }]);
  ok('T15b ★新しい鍵を使う要求の 12.25（ドロップの 7.25 も）は丸めずに 400 SET_VALUE／古い形の 12.25 は今までどおり 12.3 で保存／12.5 は通る',
     t15b.status === 400 && t15b.detail === 'SET_VALUE' && t15c.status === 400 && t15c.detail === 'SET_VALUE' && t15d.status === 200 && w15 === 12.3 && t15e.status === 200, JSON.stringify([t15b, t15c, w15, t15e.status]));
  const t15f = await add('U_t1', 'C2', today, [{ exercise: ' スクワット', sets: [{ weight: 10, reps: 10 }] }]);
  ok('T15c 前後に空白のある種目名は 400 EXERCISE（種目の並びの表の CHECK と同じ・黙って直さない）', t15f.status === 400 && t15f.detail === 'EXERCISE');
}

// ================= T16 見張り trShape（壊して batch 全体が戻ること） =================
{
  clearRate();
  //   設計38 より前の回（別の顧客）。差し替えの先に使う
  oldSession('OLDS1', 'C3', dayOffset(-30), [['ベンチプレス', 1, 40, 10], ['ベンチプレス', 2, 45, 8]]);
  const oldSet = q1(env, `SELECT MAX(set_id) m FROM karte_tr_sets WHERE session_id = 'OLDS1'`).m;
  //   新しい形で保存した別の回（先に保存した回）
  const prior = await add('U_t1', 'C3', dayOffset(-20), [{ exercise: 'ランジ', sets: [{ weight: 10, reps: 10, drops: [{ weight: 5, reps: 10 }] }] }]);
  const snapshot = (sid) => JSON.stringify({
    sets: qa(env, `SELECT * FROM karte_tr_sets WHERE session_id = ? ORDER BY set_id`, sid),
    ext: qa(env, `SELECT * FROM karte_tr_set_ext WHERE session_id = ? OR set_id IN (SELECT set_id FROM karte_tr_sets WHERE session_id = ?) ORDER BY set_id`, sid, sid),
    drops: qa(env, `SELECT dr.* FROM karte_tr_drops dr JOIN karte_tr_sets t ON t.set_id = dr.set_id WHERE t.session_id = ? ORDER BY dr.set_id, dr.drop_seq`, sid),
    ex: qa(env, `SELECT * FROM karte_tr_exercises WHERE session_id = ? ORDER BY ord`, sid),
  });
  const snapOld = snapshot('OLDS1'), snapPrior = snapshot(prior.sessionId);
  const ITEMS = [
    { exercise: 'スクワット', sets: [{ weight: 50, reps: 10 }, { weight: 60, reps: 8, drops: [{ weight: 40, reps: 10 }, { weight: 20, reps: 10 }] }] },
    { exercise: 'ベンチプレス', sets: [{ weight: 30, reps: 10, assist: 2 }] },
    { exercise: 'プランク', sets: [], doneOnly: true },
  ];
  const fired = new Set();
  //   見張りの文が来たら、条件を1つずつ同じ状態で評価して、どれが当たったかを控える（T16c）
  const probe = (q, args) => {
    if (!/INSERT INTO karte_guard \(state\) SELECT 1 FROM p/.test(q)) return;
    for (const [key, cond] of TR_SHAPE_CONDS) {
      const v = d.prepare(`WITH p AS (SELECT ? AS sid, ? AS n_sets, ? AS n_drops, ? AS n_ex) SELECT (${cond}) AS v FROM p`).get(...args).v;
      if (v) fired.add(key);
    }
  };
  let nth = 0;
  const once = (re, n, fn) => (q, args) => { probe(q, args); if (re.test(q) && ++nth === n) return fn(q, args); return null; };
  const isEx = /^INSERT INTO karte_tr_exercises/, isSet = /^INSERT INTO karte_tr_sets/, isExt = /^INSERT INTO karte_tr_set_ext/, isDrop = /^INSERT INTO karte_tr_drops/;
  const BREAKS = [
    ['付加を1行落とす', once(isExt, 1, () => [])],
    ['親の無い付加を1行余分に足す', once(isExt, 1, (q, a) => [[q, a], [`INSERT INTO karte_tr_set_ext (set_id, session_id, ord) VALUES (987654, ?, 1)`, [a[0]]]])],
    ['★付加の set_id だけを別の session の set_id に差し替える', once(isExt, 2, (q, a) => [[`INSERT INTO karte_tr_set_ext (set_id, session_id, ord, assist_reps, forced) VALUES (?, ?, ?, ?, ?)`, [oldSet, a[0], a[1], a[2], a[3]]]])],
    ['★付加の親を引く session を別の回にする（MAX が別の回の行を指す）', once(isExt, 1, (q, a) => [[q, [a[0], a[1], a[2], a[3], 'OLDS1']]])],
    ['付加の session_id だけを別の回にする', once(isExt, 1, (q, a) => [[q, ['OLDS1', a[1], a[2], a[3], a[4]]]])],
    ['ord を飛ばす（2つ目の種目と付加を ord 3 に）', (q, a) => { probe(q, a); if ((isEx.test(q) || isExt.test(q)) && a[1] === 2) return [[q, [a[0], 3, ...a.slice(2)]]]; if ((isEx.test(q) || isExt.test(q)) && a[1] === 3) return [[q, [a[0], 4, ...a.slice(2)]]]; return null; }],
    ['本セットを1行余分に足す（付加つき・Worker の数と合わない）', once(isExt, 1, (q, a) => [[q, a],
      [`INSERT INTO karte_tr_sets (session_id, exercise, set_no, weight_kg, reps) VALUES (?, 'スクワット', 3, 1, 1)`, [a[0]]],
      [`INSERT INTO karte_tr_set_ext (set_id, session_id, ord) SELECT MAX(set_id), ?, 1 FROM karte_tr_sets WHERE session_id = ?`, [a[0], a[0]]]])],
    ['set_no を重ねる', once(isSet, 2, (q, a) => [[q, [a[0], a[1], 1, ...a.slice(3)]]])],
    ['drop_seq を飛ばす', once(isDrop, 2, (q, a) => [[q, [3, ...a.slice(1)]]])],
    ['数字の無い種目の印をセットのある種目に付ける', once(isEx, 1, (q, a) => [[q, [a[0], a[1], a[2], 1]]])],
    ['数字の無い種目の印を外す', once(isEx, 3, (q, a) => [[q, [a[0], a[1], a[2], null]]])],
    ['★ドロップの親を別の回へ', once(isDrop, 1, (q, a) => [[q, [...a.slice(0, 5), 'OLDS1']]])],
    ['★2段目のドロップの親を別の回へ（残った段は1からの連続のまま＝数でしか捕まらない）', once(isDrop, 2, (q, a) => [[q, [...a.slice(0, 5), 'OLDS1']]])],
    ['数字の無い種目の行を1つ余分に足す（並びは連続のまま＝数でしか捕まらない）', once(isEx, 3, (q, a) => [[q, a], [q, [a[0], 4, '余分な種目', 1]]])],
    ['本セットの種目名を変える', once(isSet, 1, (q, a) => [[q, [a[0], '別の種目', ...a.slice(2)]]])],
    ['種目の並びの名前を変える', once(isEx, 2, (q, a) => [[q, [a[0], a[1], 'ベンチ', a[3]]]])],
    ['種目の並びの行を全部落とす（古い回として読まれる）', (q, a) => { probe(q, a); return isEx.test(q) ? [] : null; }],
  ];
  for (const [label, hook] of BREAKS) {
    clearRate();
    nth = 0;
    const before = counts();
    env._hook = hook;
    const r = await add('U_t1', 'C4', dayOffset(-1), ITEMS);
    env._hook = null;
    ok(`T16 ★trShape：${label} → BAD_STATE（409）で batch 全体が戻る`, r.status === 409 && r.code === 'BAD_STATE' && same(counts(), before), JSON.stringify([r, counts(), before]));
  }
  ok('T16 ★差し替えの破壊の後も、別の回（古い回・先に保存した回）の行が1つも変わっていない', snapshot('OLDS1') === snapOld && snapshot(prior.sessionId) === snapPrior);
  //   壊さなければ通る（見張りが常に止める飾りでない証拠）
  clearRate();
  env._hook = (q, a) => { probe(q, a); return null; };
  const good = await add('U_t1', 'C4', dayOffset(-1), ITEMS);
  env._hook = null;
  ok('T16 壊さなければ同じ要求が通る', good.status === 200, JSON.stringify(good));
  //   合計60超え・ord 20超えは Worker の検査と CHECK で先に止まる＝見張りの三重目は手で作った状態で当てる
  {
    const sid = 'HAND60';
    d.exec('BEGIN');
    d.prepare(`INSERT INTO karte_tr_sessions (session_id, customer_id, session_date, author_trainer_id, rev, created_at) VALUES (?, 'C4', ?, 't1', 1, 1)`).run(sid, today);
    d.prepare(`INSERT INTO karte_tr_exercises (session_id, ord, exercise) VALUES (?, 1, 'x')`).run(sid);
    for (let i = 1; i <= 61; i++) {
      d.prepare(`INSERT INTO karte_tr_sets (session_id, exercise, set_no, weight_kg, reps) VALUES (?, 'x', ?, 1, 1)`).run(sid, ((i - 1) % 10) + 1);
      d.prepare(`INSERT INTO karte_tr_set_ext (set_id, session_id, ord) SELECT MAX(set_id), ?, 1 FROM karte_tr_sets WHERE session_id = ?`).run(sid, sid);
    }
    probe(`INSERT INTO karte_guard (state) SELECT 1 FROM p`, [sid, 61, 0, 1]);
    d.exec('ROLLBACK');
  }
  const ALL = TR_SHAPE_CONDS.map((x) => x[0]);
  const never = ALL.filter((k) => !fired.has(k) && k !== 'ord_max');
  ok('T16c ★見張りのどの条件も、壊した状態のどれかで実際に当たる（当たらない条件＝飾りが無い。ord_max は CHECK で作れない）', never.length === 0, '当たらなかった条件: ' + never.join(','));
  ok('T16c 条件の一覧（設計38 §3-3 の7条件＋数の照合）が欠けていない', same(ALL, ['n_sets', 'n_drops', 'n_ex', 'ext_count', 'set_without_ext', 'ext_without_parent', 'ext_other_session',
     'ext_exercise', 'ord_seq', 'set_no_seq', 'done_with_sets', 'sets_missing', 'drop_seq', 'total', 'ord_max']), ALL.join(','));
  ok('T16d 見張りは batch の最後（karte_requests の直前）・NULL 比較に = を使わない', /G\.trShape\(sid, \{[^}]*\}\),\n\s*\],\n\s*result:/.test(KSRC)
     && TR_SHAPE_CONDS.every(([, c]) => !/session_id\s*=\s*p\.sid|\.ord\s*=\s*e\.ord|\.set_id\s*=\s*/.test(c)));
}

// ================= T17〜T18 =================
{
  clearRate();
  const before = counts();
  let n = 0;
  env._hook = (q) => (/^INSERT INTO karte_tr_set_ext/.test(q) && ++n === 1 ? [] : null);
  const r = await add('U_t1', 'C1', dayOffset(-2), P1, { member: { message: '見本の伝言' } });
  env._hook = null;
  ok('T17 ★member つきでも全部か無か（見張りで戻ると「お客様へ」も残らない）', r.status === 409 && r.code === 'BAD_STATE' && same(counts(), before), JSON.stringify(r));
  const r2 = await add('U_t1', 'C1', dayOffset(-2), P1, { member: { message: '見本の伝言' } });
  ok('T17 壊さなければ member つきで通る（答えの鍵は今までどおり）', r2.status === 200 && r2.mnoteId && r2.mnoteRev === 1
     && same(Object.keys(r2).filter((k) => k !== 'status' && k !== 'success').sort(), ['mnoteId', 'mnoteRev', 'rev', 'sessionId']), JSON.stringify(r2));
  const r3 = await add('U_t1', 'C1', dayOffset(-3), [
    { exercise: 'スクワット', sets: [{ weight: 50, reps: 10 }, { weight: 55, reps: 8 }] }, { exercise: 'ベンチプレス', sets: [{ weight: 30, reps: 10 }] },
    { exercise: 'ランジ', sets: [{ weight: 10, reps: 10 }] }, { exercise: 'カール', sets: [{ weight: 8, reps: 12 }] },
    { exercise: 'スクワット', sets: [{ weight: 40, reps: 12 }, { weight: 40, reps: 12 }, { weight: 40, reps: 10 }] }]);
  const rows = qa(env, `SELECT e.ord, t.set_no, t.weight_kg w FROM karte_tr_set_ext e JOIN karte_tr_sets t ON t.set_id = e.set_id WHERE e.session_id = ? AND t.exercise = 'スクワット' ORDER BY e.ord, t.set_no`, r3.sessionId);
  ok('T18 ★同じ種目名が1回に2度→ord 1 と ord 5 の別の行・set_no はそれぞれ1から', r3.status === 200
     && same(rows.map((x) => [x.ord, x.set_no]), [[1, 1], [1, 2], [5, 1], [5, 2], [5, 3]])
     && same(qa(env, `SELECT ord FROM karte_tr_exercises WHERE session_id = ? AND exercise = 'スクワット' ORDER BY ord`, r3.sessionId).map((x) => x.ord), [1, 5]), JSON.stringify(rows));
}

// ================= T19〜T24 読む側（k_training） =================
{
  clearRate();
  d.exec(`DELETE FROM karte_tr_sessions WHERE customer_id = 'C2'`);
  //   古い回：入力の順が名前順でない（ローイング→アブ）
  oldSession('OLDC2', 'C2', dayOffset(-15), [['ローイング', 1, 30, 10], ['ローイング', 2, 35, 8], ['アブ', 1, 0, 20]]);
  const nw = await add('U_t1', 'C2', dayOffset(-5), [
    { exercise: 'ローイング', sets: [{ weight: 40, reps: 8 }, { weight: 45, reps: 5, forced: true }] },
    { exercise: 'アブ', sets: [{ weight: 10, reps: 10, drops: [{ weight: 0, reps: 10, assist: 3, forced: true }] }] },
    { exercise: 'ストレッチ', sets: [], doneOnly: true },
    { exercise: 'ローイング', sets: [{ weight: 30, reps: 12, assist: 4 }] },
    { exercise: 'デッドリフト', sets: [{ weight: 120, reps: 1, forced: true }] },
  ]);
  const tr = await call('U_t2', 'k_training', { customerId: 'C2' });
  const sNew = tr.sessions.find((s) => s.session_id === nw.sessionId);
  const sOld = tr.sessions.find((s) => s.session_id === 'OLDC2');
  ok('T19 ★新しい回は ord・set_no の順（入力の順）', sNew && same(sNew.sets.map((x) => [x.ord, x.exercise, x.set_no]),
     [[1, 'ローイング', 1], [1, 'ローイング', 2], [2, 'アブ', 1], [4, 'ローイング', 1], [5, 'デッドリフト', 1]]), JSON.stringify(sNew && sNew.sets));
  ok('T19 ★古い回は今までどおり exercise・set_no の順・鍵も今までと同じ（ord・drops・exercises を足さない）', sOld
     && same(sOld.sets.map((x) => [x.exercise, x.set_no]), [['アブ', 1], ['ローイング', 1], ['ローイング', 2]])
     && sOld.sets.every((x) => same(Object.keys(x).sort(), ['e1rm', 'exercise', 'note', 'reps', 'session_id', 'set_no', 'weight_kg'])) && !('exercises' in sOld), JSON.stringify(sOld));
  const ab = sNew.sets.find((x) => x.exercise === 'アブ');
  ok('T20 ★sets は本セットだけ（ドロップを平らな配列に混ぜない）・ドロップは本セットの下', sNew.sets.length === 5 && same(ab.drops, [{ weight_kg: 0, reps: 10, assist_reps: 3, forced: true }])
     && sNew.sets.filter((x) => x.exercise !== 'アブ').every((x) => same(x.drops, [])), JSON.stringify(ab));
  ok('T20 新しい回のセットに ord・assist_reps・forced（真偽値）', sNew.sets[1].forced === true && sNew.sets[0].forced === false && sNew.sets[3].assist_reps === 4 && sNew.sets[0].assist_reps === null && !('set_id' in sNew.sets[0]));
  ok('T20 ★exercises は新しい回だけ（数字の無い種目を含む・同じ名前の2つ）', same(sNew.exercises, [{ ord: 1, exercise: 'ローイング', doneOnly: false }, { ord: 2, exercise: 'アブ', doneOnly: false },
     { ord: 3, exercise: 'ストレッチ', doneOnly: true }, { ord: 4, exercise: 'ローイング', doneOnly: false }, { ord: 5, exercise: 'デッドリフト', doneOnly: false }]), JSON.stringify(sNew.exercises));
  const bNew = tr.best.filter((b) => b.d === dayOffset(-5));
  const row = bNew.find((b) => b.exercise === 'ローイング');
  ok('T21 ★best（推定1RM）に無理やりが入らない（45×5 でなく 40×8＝50.7）', row && row.e1rm === 50.7, JSON.stringify(bNew));
  ok('T22 best は補助を足さない（30×12 は 42。補助4を足した 16回にしない）・ドロップ（別の表）は入らない', bNew.find((b) => b.exercise === 'アブ').e1rm === 13.3);
  ok('T23 ★無理やりだけの種目は best に出ない', !bNew.some((b) => b.exercise === 'デッドリフト') && !bNew.some((b) => b.exercise === 'ストレッチ'));
  ok('T24 ★同じ名前の2つの ord は種目名でまとめる（その日の最大＝1つの行）', bNew.filter((b) => b.exercise === 'ローイング').length === 1);
}

// ================= T25〜T27b ハッシュの互換（I69） =================
{
  clearRate();
  const sha = (o) => createHash('sha256').update(JSON.stringify(o)).digest('hex');
  //   設計38 より前の Worker が保存した行（旧ハッシュ {cid, date, sets, member}）を作る
  const putOld = (k, cid, date, items, result) => {
    const sets = [];
    for (const it of items) it.sets.forEach((s, i) => sets.push({ exercise: it.exercise, set_no: i + 1, weight_kg: s.weight, reps: s.reps, note: s.note == null ? null : s.note }));
    d.prepare(`INSERT INTO karte_requests (trainer_id, action, client_req_id, payload_hash, http_status, result_code, result_json, done_at) VALUES ('t1', 'k_addTraining', ?, ?, 200, 'OK', ?, 1)`)
      .run(k, sha({ cid, date, sets, member: null }), JSON.stringify(result));
  };
  const k25 = crid();
  putOld(k25, 'C1', dayOffset(-4), OLD, { sessionId: 'OLD-SAVED', rev: 1 });
  const before = counts();
  const r25 = await add('U_t1', 'C1', dayOffset(-4), OLD, { clientReqId: k25 });
  ok('T25 ★旧ハッシュの行に、同じ古い形の要求→replayed（保存した答え・何も書かない）', r25.status === 200 && r25.replayed === true && r25.sessionId === 'OLD-SAVED' && same(counts(), before), JSON.stringify(r25));
  const plus = JSON.parse(JSON.stringify(OLD)); plus[0].sets[1].assist = 3;
  const r26 = await add('U_t1', 'C1', dayOffset(-4), plus, { clientReqId: k25 });
  ok('T26 同じ鍵で補助を足した要求→409 REQ_REUSED', r26.status === 409 && r26.code === 'REQ_REUSED', JSON.stringify(r26));
  const k27 = crid();
  const a = await add('U_t1', 'C1', dayOffset(-4), P1, { clientReqId: k27 });
  const b = await add('U_t1', 'C1', dayOffset(-4), JSON.parse(JSON.stringify(P1)), { clientReqId: k27 });
  ok('T27 新しい形の要求の再送→replayed（同じ sessionId・二重にならない）', a.status === 200 && b.replayed === true && b.sessionId === a.sessionId
     && qn(env, `SELECT COUNT(*) n FROM karte_tr_sessions WHERE session_id = ?`, a.sessionId) === 1);
  const k27c = crid();
  const c1 = await add('U_t1', 'C1', dayOffset(-4), OLD, { clientReqId: k27c });
  const c2 = await add('U_t1', 'C1', dayOffset(-4), OLD, { clientReqId: k27c });
  ok('T27 古い形の要求を新しい Worker で保存→同じ要求の再送も replayed（新しいハッシュで一致）', c1.status === 200 && c2.replayed === true && c2.sessionId === c1.sessionId);
  //   T27b：同じ種目名が2つの種目にある古い形。旧ハッシュは境目を持たない＝別の分け方と同じになりうる
  const DUP = [{ exercise: 'スクワット', sets: [{ weight: 50, reps: 10 }] }, { exercise: 'ベンチプレス', sets: [{ weight: 30, reps: 10 }] }, { exercise: 'スクワット', sets: [{ weight: 40, reps: 12 }] }];
  const k27b = crid();
  putOld(k27b, 'C1', dayOffset(-4), DUP, { sessionId: 'OLD-DUP', rev: 1 });
  const before27 = counts();
  const r27b = await add('U_t1', 'C1', dayOffset(-4), DUP, { clientReqId: k27b });
  ok('T27b ★同じ種目名が2つの種目にある古い形：旧ハッシュの行と一致しても replayed にせず 409', r27b.status === 409 && r27b.code === 'REQ_REUSED' && same(counts(), before27), JSON.stringify(r27b));
}

// ================= T28〜T29 削除（I70） =================
{
  clearRate();
  const r = await add('U_t1', 'C4', dayOffset(-6), [{ exercise: '消える種目', sets: [{ weight: 10, reps: 10, drops: [{ weight: 5, reps: 10 }] }] }, { exercise: '消える実施', sets: [], doneOnly: true }]);
  const v1 = await call('U_t1', 'k_training', { customerId: 'C4' });
  const pv1 = await call('U_t1', 'k_memberPreview', { customerId: 'C4' });
  ok('T28 消す前は k_training・会員の見え方の両方に出る', JSON.stringify(v1).includes('消える種目') && JSON.stringify(pv1.training).includes('消える実施'));
  const del = await call('U_t1', 'k_deleteTraining', { sessionId: r.sessionId, rev: 1, clientReqId: crid() });
  const v2 = await call('U_t1', 'k_training', { customerId: 'C4' });
  const pv2 = await call('U_t1', 'k_memberPreview', { customerId: 'C4' });
  ok('T28 ★回を消すと k_training・buildMemberKarte から exercises・drops も消える', del.status === 200 && !JSON.stringify(v2).includes('消える') && !JSON.stringify(pv2.training).includes('消える'), JSON.stringify(v2).slice(0, 300));
  ok('T29 消した回の3つの表の行は残る（読まれないだけ）', qn(env, `SELECT COUNT(*) n FROM karte_tr_exercises WHERE session_id = ?`, r.sessionId) === 2
     && qn(env, `SELECT COUNT(*) n FROM karte_tr_set_ext WHERE session_id = ?`, r.sessionId) === 1
     && qn(env, `SELECT COUNT(*) n FROM karte_tr_drops dr JOIN karte_tr_sets t ON t.set_id = dr.set_id WHERE t.session_id = ?`, r.sessionId) === 1);
}

// ================= T30〜T35 受付の切替（I72） =================
const ASSIST = [{ exercise: 'ヒップリフト', sets: [{ weight: 50, reps: 10, assist: 5 }] }];
const READS = Object.keys(KARTE_HANDLERS).filter((a) => !isKarteWrite(a));
async function schemas(as) {
  const out = {};
  for (const a of READS) {
    const r = await call(as, a, { customerId: 'C1' });
    if ('karteSchema' in r) out[a] = r.karteSchema;
  }
  const empty = await call(as, 'k_training', { customerId: 'C3x' });
  return { out, emptyOk: empty.status === 404 };
}
{
  clearRate();
  env.KARTE_TRAINING_EXT = 'off';
  const before = counts();
  const rate0 = qn(env, `SELECT COALESCE(SUM(n), 0) n FROM karte_rate`);
  const r = await add('U_t1', 'C1', today, ASSIST);
  ok('T30 ★off：補助つきの要求は 409 TRAINING_EXT_OFF・答えは {success:false, code} だけ', r.status === 409 && r.code === 'TRAINING_EXT_OFF' && r.success === false
     && same(Object.keys(r).sort(), ['code', 'status', 'success']), JSON.stringify(r));
  ok('T30 ★off：3つの表にも karte_tr_sets にも行が増えない・回数（karte_rate）も増えない', same(counts(), before) && qn(env, `SELECT COALESCE(SUM(n), 0) n FROM karte_rate`) === rate0);
  const lg = q1(env, `SELECT result, action, section FROM karte_access_log ORDER BY id DESC LIMIT 1`);
  ok('T30 access_log は denied', lg && lg.result === 'denied' && lg.action === 'k_addTraining', JSON.stringify(lg));
  const o = await add('U_t1', 'C1', today, OLD);
  ok('T30 ★off でも旧形の要求は 200（3つの表の行も作る）', o.status === 200 && qn(env, `SELECT COUNT(*) n FROM karte_tr_exercises WHERE session_id = ?`, o.sessionId) === 2);

  //   T31：karteSchema を返す窓口は KARTE_HANDLERS の読みの窓口から機械で集める
  const offS = await schemas('U_t1');
  env.KARTE_TRAINING_EXT = 'on';
  const onS = await schemas('U_t1');
  const names = Object.keys(offS.out).sort();
  ok('T31 ★karteSchema を返す窓口は5つ（概要・メモ・トレーニング・安全面・種目の一覧）', same(names, ['k_exercises', 'k_notes', 'k_safety', 'k_summary', 'k_training']) && same(Object.keys(onS.out).sort(), names), names.join(','));
  ok('T31 ★off のとき全部32／on のとき全部33', Object.values(offS.out).every((v) => v === 32) && Object.values(onS.out).every((v) => v === 33) && KARTE_SCHEMA === 33, JSON.stringify([offS.out, onS.out]));
  env.KARTE_TRAINING_EXT = 'off';
  const e0 = await call('U_t1', 'k_training', { customerId: 'C3' });
  d.exec(`UPDATE karte_tr_sessions SET deleted_at = 1 WHERE customer_id = 'C3'`);
  const e1 = await call('U_t1', 'k_training', { customerId: 'C3' });
  env.KARTE_TRAINING_EXT = 'on';
  const e2 = await call('U_t1', 'k_training', { customerId: 'C3' });
  ok('T31 記録が0件の k_training も切替に従う（32／33）', e0.karteSchema === 32 && e1.karteSchema === 32 && e1.sessions.length === 0 && e2.karteSchema === 33);
  ok('T31 ★ソースに karteSchema: KARTE_SCHEMA（定数のまま返す）が残っていない・6か所が karteSchemaFor', !/karteSchema:\s*KARTE_SCHEMA\b/.test(KSRC)
     && (KSRC.match(/karteSchema: karteSchemaFor\(c\.env, c\.who\)/g) || []).length === 6);

  clearRate();
  env.KARTE_TRAINING_EXT = 'allow';
  env.KARTE_TRAINING_EXT_TRAINERS = 't1, t2';
  const a1 = await add('U_t1', 'C1', today, ASSIST);
  const s1 = await call('U_t1', 'k_training', { customerId: 'C1' });
  const a3 = await add('U_t3', 'C1', today, ASSIST);
  const s3 = await call('U_t3', 'k_training', { customerId: 'C1' });
  const a2 = await add('U_t2', 'C1', today, ASSIST);
  ok('T32 ★allow＋"t1, t2"：t1・t2 は 200・karteSchema 33／t3 は 409・karteSchema 32（前後の空白を許す）', a1.status === 200 && s1.karteSchema === 33 && a2.status === 200
     && a3.status === 409 && a3.code === 'TRAINING_EXT_OFF' && s3.karteSchema === 32, JSON.stringify([a1.status, s1.karteSchema, a2.status, a3, s3.karteSchema]));
  for (const list of ['t', 't1x', 'T1', 'xt1', '']) {
    env.KARTE_TRAINING_EXT_TRAINERS = list;
    const r2 = await add('U_t1', 'C1', today, ASSIST);
    ok(`T32 ★部分一致・大文字違い・空の一覧は許さない（TRAINERS="${list}"）`, r2.status === 409 && r2.code === 'TRAINING_EXT_OFF');
  }
  delete env.KARTE_TRAINING_EXT_TRAINERS;
  ok('T32 TRAINERS が未設定でも全員 409', (await add('U_t1', 'C1', today, ASSIST)).status === 409);
  env.KARTE_TRAINING_EXT_TRAINERS = 't1';
  ok('T32 trainer_id が空の人は許さない（判定の関数）', trainingExtOn(env, { trainerId: '' }) === false && trainingExtOn(env, {}) === false && trainingExtOn(env, { trainerId: 't1' }) === true);

  for (const v of ['ON', 'true', 'allow ', ' on', '1', '', undefined]) {
    if (v === undefined) delete env.KARTE_TRAINING_EXT; else env.KARTE_TRAINING_EXT = v;
    const r2 = await add('U_t1', 'C1', today, ASSIST);
    const s2 = await call('U_t1', 'k_summary', { customerId: 'C1' });
    ok(`T33 ★値の打ち間違い（${JSON.stringify(v)}）は off と同じ（409・karteSchema 32）`, r2.status === 409 && r2.code === 'TRAINING_EXT_OFF' && s2.karteSchema === 32 && karteSchemaFor(env, { trainerId: 't1' }) === 32);
  }
  delete env.KARTE_TRAINING_EXT_TRAINERS;

  clearRate();
  env.KARTE_TRAINING_EXT = 'on';
  const k34 = crid();
  const on1 = await add('U_t1', 'C1', today, ASSIST, { clientReqId: k34 });
  env.KARTE_TRAINING_EXT = 'off';
  const off1 = await add('U_t1', 'C1', today, ASSIST, { clientReqId: k34 });
  ok('T34 ★on で保存した要求を off に替えてから同じ送信番号・同じ中身で送る→replayed（409 にしない）', on1.status === 200 && off1.status === 200 && off1.replayed === true && off1.sessionId === on1.sessionId, JSON.stringify([on1, off1]));
  const off2 = await add('U_t1', 'C1', today, [{ exercise: 'ヒップリフト', sets: [{ weight: 50, reps: 10, assist: 6 }] }], { clientReqId: k34 });
  ok('T34 中身が違えば今までどおり REQ_REUSED（切替より先に replay が判定する）', off2.status === 409 && off2.code === 'REQ_REUSED');

  const before35 = counts();
  for (const [label, items] of [
    ['doneOnly だけ', [{ exercise: 'ストレッチ', sets: [], doneOnly: true }]],
    ['drops だけ', [{ exercise: 'カール', sets: [{ weight: 20, reps: 10, drops: [{ weight: 10, reps: 10 }] }] }]],
    ['空の drops だけ', [{ exercise: 'カール', sets: [{ weight: 20, reps: 10, drops: [] }] }]],
    ['ドロップの中の assist だけ', [{ exercise: 'カール', sets: [{ weight: 20, reps: 10, drops: [{ weight: 10, reps: 10, assist: 2 }] }] }]],
    ['ドロップの中の forced だけ', [{ exercise: 'カール', sets: [{ weight: 20, reps: 10, drops: [{ weight: 10, reps: 3, forced: true }] }] }]],
    ['forced だけ', [{ exercise: 'カール', sets: [{ weight: 20, reps: 3, forced: true }] }]],
    ['旧形の種目に混ぜた1つ', [...OLD, { exercise: 'ストレッチ', sets: [], doneOnly: true }]],
  ]) {
    const r2 = await add('U_t1', 'C1', today, items);
    ok(`T35 ★off：${label} の要求も 409（新しい鍵の判定に抜けが無い）`, r2.status === 409 && r2.code === 'TRAINING_EXT_OFF', JSON.stringify(r2));
  }
  ok('T35 409 のとき行は増えない', same(counts(), before35));
}

console.log(`\n${fail ? '❌' : '✅'} トレーニングの新しい項目（設計38・入口から） 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
