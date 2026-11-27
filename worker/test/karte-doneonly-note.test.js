// 数字の無い種目（実施のみ）のメモ（設計67・karte_tr_ex_notes）を、本物の SQLite に schema.sql と全 migration を流し、入口（index.js）から通す・2026-11-26
//   実行: node worker/test/karte-doneonly-note.test.js
//   ★守ること：doneOnly の種目だけにメモ（3経路 k_addTraining・k_editTraining・k_importDay で同じ）・数字のある種目には 400・空は鍵が無いのと同じ
//     ・exNote はトレーナーごとの受付（切替）と同じ判定・会員のカルテに出ない・推移・自己ベスト・月ごとの1行が変わらない・既存の要求のハッシュが変わらない
//   ★会員・トレーナーの名前・ID は架空の値だけ

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import worker from '../src/index.js';
import { isKarteWrite, editTrainingStmts, normalizeTraining, trainingEditOn } from '../src/routes/karte.js';
import { buildMemberKarte } from '../src/lib/member-karte.js';
import { isAllowed } from '../src/perms.js';

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
const tr = async (as, cid) => call(as, 'k_training', { customerId: cid });
const live = (sid) => !!q1(env, `SELECT 1 x FROM karte_tr_sessions WHERE session_id = ? AND deleted_at IS NULL`, sid);
//   k_training の1回から id・作成時刻を除いた形（往復の比べに使う）
const shape = (s) => ({ date: s.session_date, author: s.author_trainer_id, ex: s.exercises || null,
  sets: (s.sets || []).map((x) => ({ exercise: x.exercise, set_no: x.set_no, w: x.weight_kg, r: x.reps, note: x.note, ord: x.ord, a: x.assist_reps, f: x.forced, d: x.drops })) });
const findS = (r, sid) => (r.sessions || []).filter((s) => s.session_id === sid)[0] || null;

env.KARTE_TRAINING_EXT = 'on';
env.KARTE_TRAINING_EDIT = 'on';


const nrows = () => qa(env, `SELECT session_id, ord, note FROM karte_tr_ex_notes ORDER BY session_id, ord`);
const PL = (note) => [{ exercise: 'スクワット', sets: [{ weight: 40, reps: 10 }] }, Object.assign({ exercise: '腸腰筋ストレッチ', sets: [], doneOnly: true }, note === undefined ? {} : { note })];

// ---- N1 k_addTraining：doneOnly の種目のメモ → 表に1行・k_training の exercises[].note・exNote ----
{
  clearRate();
  const r = await add('U_t1', 'C1', dayOffset(-3), PL('  架空の伸ばし方のメモ  '));
  ok('N1-1 doneOnly のメモつきで保存できる', r.status === 200, JSON.stringify(r));
  const row = nrows().filter((x) => x.session_id === r.sessionId);
  ok('N1-2 ★表に1行（ord 2・前後の空白を落とす）', same(row, [{ session_id: r.sessionId, ord: 2, note: '架空の伸ばし方のメモ' }]), JSON.stringify(row));
  const t = await tr('U_t1', 'C1'), s = findS(t, r.sessionId);
  ok('N1-3 ★k_training：exNote は真・その回の exercises の2つ目に note・1つ目には鍵が無い', t.exNote === true && !!s && s.exercises[1].note === '架空の伸ばし方のメモ' && !('note' in s.exercises[0]), JSON.stringify(s && s.exercises));
  //   集計（推移・自己ベスト）は本セットだけ＝メモの有無で変わらない
  clearRate();
  const r2 = await add('U_t1', 'C1', dayOffset(-2), PL());
  const t2 = await tr('U_t1', 'C1');
  ok('N1-4 ★自己ベスト（best）は本セットだけ：メモつき実施のみの種目は出ず、スクワットの値はメモの有無で同じ', (t2.best || []).length >= 2 && t2.best.every((b) => b.exercise === 'スクワット' && b.e1rm === t.best[0].e1rm), JSON.stringify([t.best, t2.best]));
  ok('N1-5 メモが無い回の exercises には note の鍵が無い', !('note' in findS(t2, r2.sessionId).exercises[1]));
  //   会員のカルテに出ない（I-M3）
  const mk = await buildMemberKarte(env, 'C1');
  ok('N1-6 ★会員のカルテ（buildMemberKarte）に種目のメモが出ない', !JSON.stringify(mk).includes('架空の伸ばし方のメモ'), JSON.stringify(mk).slice(0, 200));
}
// ---- N2 400：数字のある種目に note・文字列でない・200字超え ----
{
  for (const [label, items] of [
    ['数字のある種目に note', [{ exercise: 'スクワット', sets: [{ weight: 40, reps: 10 }], note: '架空' }]],
    ['note が数値', PL(5)],
    ['note が201字', PL('あ'.repeat(201))],
  ]) {
    clearRate();
    const before = counts(), n0 = nrows().length;
    const r = await add('U_t1', 'C1', dayOffset(-4), items);
    ok('N2 ★' + label + ' → 400 EX_NOTE・何も書かない', r.status === 400 && /EX_NOTE/.test(JSON.stringify(r)) && same(counts(), before) && nrows().length === n0, JSON.stringify(r));
  }
  clearRate();
  const r = await add('U_t1', 'C1', dayOffset(-4), PL('あ'.repeat(200)));
  ok('N2 200字ちょうどは入る', r.status === 200);
}
// ---- N3 空・空白だけは鍵が無いのと同じ（切替が閉じていても 409 にならない・ハッシュも同じ） ----
{
  env.KARTE_TRAINING_EXT = 'off';
  clearRate();
  const items = [{ exercise: 'スクワット', sets: [{ weight: 40, reps: 10 }], note: '   ' }];
  const r = await add('U_t1', 'C1', dayOffset(-5), items);
  ok('N3-1 ★切替が閉じていても空白だけの note は新しい鍵と数えない（200・行なし）', r.status === 200 && !nrows().some((x) => x.session_id === r.sessionId), JSON.stringify(r));
  const t = await tr('U_t1', 'C1');
  ok('N3-2 ★切替が閉じていれば exNote は偽（画面はメモの欄を出さない・送らない）', t.exNote === false && t.karteSchema === 32, JSON.stringify([t.exNote, t.karteSchema]));
  clearRate();
  const r2 = await add('U_t1', 'C1', dayOffset(-5), PL('架空'));
  ok('N3-3 切替が閉じているとき doneOnly＋メモは 409（今の doneOnly と同じ）', r2.status === 409, JSON.stringify(r2));
  env.KARTE_TRAINING_EXT = 'on';
  //   同じ clientReqId で note:'' と鍵なしを送る＝同じ要求として replay（ハッシュが同じ）
  clearRate();
  const id = crid();
  const a = await add('U_t1', 'C1', dayOffset(-6), PL(), { clientReqId: id });
  const b = await add('U_t1', 'C1', dayOffset(-6), PL(''), { clientReqId: id });
  ok('N3-4 ★note:"" は鍵が無いのと同じハッシュ（同じ番号の再送が replay になる）', a.status === 200 && b.status === 200 && b.sessionId === a.sessionId, JSON.stringify([a, b]));
  const c = await add('U_t1', 'C1', dayOffset(-6), PL('架空の別のメモ'), { clientReqId: id });
  ok('N3-5 同じ番号でメモを変えると 409（今どおり）', c.status === 409, JSON.stringify(c));
}
// ---- N4 k_editTraining：メモは新しい版に付く・古い版の行は残る・外したら付かない ----
{
  clearRate();
  const r = await add('U_t1', 'C1', dayOffset(-8), PL('架空の最初のメモ'));
  const t0 = findS(await tr('U_t1', 'C1'), r.sessionId);
  clearRate();
  const e = await edit('U_t1', { sessionId: r.sessionId, rev: t0.rev, sessionDate: dayOffset(-8), items: PL('架空の直したメモ') });
  ok('N4-1 直す：200・新しい版', e.status === 200 && e.sessionId && e.sessionId !== r.sessionId, JSON.stringify(e));
  const s1 = findS(await tr('U_t1', 'C1'), e.sessionId);
  ok('N4-2 ★新しい版の exercises に直したメモ', !!s1 && s1.exercises[1].note === '架空の直したメモ', JSON.stringify(s1 && s1.exercises));
  ok('N4-3 古い版の行は論理削除した回に残る（前の版として）', nrows().some((x) => x.session_id === r.sessionId && x.note === '架空の最初のメモ'));
  clearRate();
  const e2 = await edit('U_t1', { sessionId: e.sessionId, rev: s1.rev, sessionDate: dayOffset(-8), items: PL() });
  const s2 = findS(await tr('U_t1', 'C1'), e2.sessionId);
  ok('N4-4 メモを外して直すと新しい版には付かない', e2.status === 200 && !('note' in s2.exercises[1]) && !nrows().some((x) => x.session_id === e2.sessionId));
}
// ---- N5 k_importDay：同じ守り ----
{
  clearRate();
  const r = await call('U_t1', 'k_importDay', { customerId: 'C1', sessionDate: dayOffset(-40), items: PL('架空の取り込みのメモ'), clientReqId: crid() });
  ok('N5-1 ★過去分の取り込みでも doneOnly のメモが入る', r.status === 200 && nrows().some((x) => x.note === '架空の取り込みのメモ'), JSON.stringify(r));
  clearRate();
  const bad = await call('U_t1', 'k_importDay', { customerId: 'C1', sessionDate: dayOffset(-41), items: [{ exercise: 'スクワット', sets: [{ weight: 40, reps: 10 }], note: '架空' }], clientReqId: crid() });
  ok('N5-2 過去分の取り込みでも数字のある種目の note は 400', bad.status === 400, JSON.stringify(bad));
}

console.log(`\n${fail ? '❌' : '✅'} 数字の無い種目のメモ（設計67・入口から） 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
