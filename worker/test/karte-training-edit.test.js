// 保存したトレーニングの記録を直す（設計58・k_editTraining）を、本物の SQLite に schema.sql と全 migration を流し、入口（index.js）から通す・2026-11-25
//   実行: node worker/test/karte-training-edit.test.js
//   ★D1 の身代わり（配列）では CHECK・部分 UNIQUE・見張り（karte_guard）が再現しない＝node:sqlite に全 migration を流す
//   ★守り（許可表・Origin・トークン・二重送信・回数・切替）は index.js と runWrite にある＝入口から通す
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

// ================= E1 名前・許可表・Origin（I89・H11） =================
{
  ok('E1 ★k_editTraining は isKarteWrite に当たる（Origin・iat の守りが掛かる）・update は当たらない', isKarteWrite('k_editTraining') === true && isKarteWrite('k_updateTraining') === false);
  ok('E1 許可表：trainer・owner は可・customer は不可', isAllowed('k_editTraining', 'trainer') && isAllowed('k_editTraining', 'owner') && !isAllowed('k_editTraining', 'customer'));
  clearRate();
  const a = await add('U_t1', 'C1', dayOffset(-5), P1);
  const before = counts();
  const payload = JSON.stringify({ action: 'k_editTraining', idToken: await token('U_t1'), sessionId: a.sessionId, rev: 1, sessionDate: dayOffset(-5), items: P1, clientReqId: crid() });
  const res = await worker.fetch(new Request('https://w.example/', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: payload }), env, { waitUntil() {} });
  ok('E1 ★Origin 違いは 403・何も変わらない', res.status === 403 && same(counts(), before) && live(a.sessionId));
}

// ================= E2 切替（I89・H12） =================
{
  clearRate();
  const a = await add('U_t1', 'C1', dayOffset(-6), P1);
  const before = counts();
  env.KARTE_TRAINING_EDIT = 'off';
  const r1 = await edit('U_t1', { sessionId: a.sessionId, rev: 1, sessionDate: dayOffset(-6), items: P1 });
  const t1 = await tr('U_t1', 'C1');
  env.KARTE_TRAINING_EDIT = 'allow'; env.KARTE_TRAINING_EDIT_TRAINERS = 't2, t3';
  const r2 = await edit('U_t1', { sessionId: a.sessionId, rev: 1, sessionDate: dayOffset(-6), items: P1 });
  const t2 = await tr('U_t1', 'C1');
  ok('E2 ★off・allow で未許可：409 TRAINING_EDIT_OFF・5つの表も「お客様へ」も変わらない・k_training の trainingEdit は false',
     r1.status === 409 && r1.code === 'TRAINING_EDIT_OFF' && r2.status === 409 && r2.code === 'TRAINING_EDIT_OFF' && same(counts(), before) && live(a.sessionId)
     && t1.trainingEdit === false && t2.trainingEdit === false, JSON.stringify([r1, r2]));
  env.KARTE_TRAINING_EDIT_TRAINERS = 't1';
  const t3 = await tr('U_t1', 'C1');
  const id = crid();
  const r3 = await edit('U_t1', { sessionId: a.sessionId, rev: 1, sessionDate: dayOffset(-6), items: P1.slice(1) }, { clientReqId: id });
  ok('E2 allow で許可：trainingEdit は true・直せる', t3.trainingEdit === true && r3.status === 200 && r3.replaced === a.sessionId && live(r3.sessionId) && !live(a.sessionId), JSON.stringify(r3));
  //   ★replay は切替より前：on で直せた要求を off の後に送り直しても成功を返す（「直っていない」と伝えない）
  env.KARTE_TRAINING_EDIT = 'off';
  const r4 = await edit('U_t1', { sessionId: a.sessionId, rev: 1, sessionDate: dayOffset(-6), items: P1.slice(1) }, { clientReqId: id });
  ok('E2 ★off の後の同じ要求の送り直しは replay の成功（切替の判定は replay の後）', r4.status === 200 && r4.replayed === true && r4.sessionId === r3.sessionId, JSON.stringify(r4));
  for (const v of [undefined, '', 'ON', 'on ', 'true']) { if (v === undefined) delete env.KARTE_TRAINING_EDIT; else env.KARTE_TRAINING_EDIT = v; ok('E2 打ち間違い・未設定は閉じる：' + JSON.stringify(v), trainingEditOn(env, { trainerId: 't1' }) === false); }
  env.KARTE_TRAINING_EDIT = 'on'; delete env.KARTE_TRAINING_EDIT_TRAINERS;
}

// ================= E3 日付・空・形（H14） =================
{
  clearRate();
  const a = await add('U_t1', 'C1', dayOffset(-7), P1);
  const before = counts();
  const f = await edit('U_t1', { sessionId: a.sessionId, rev: 1, sessionDate: dayOffset(1), items: P1 });
  const e = await edit('U_t1', { sessionId: a.sessionId, rev: 1, sessionDate: dayOffset(-7), items: [] });
  const z = await edit('U_t1', { sessionId: a.sessionId, rev: 0, sessionDate: dayOffset(-7), items: P1 });
  ok('E3 未来の日付・空の items・rev 0 は 400・何も変わらない', f.status === 400 && f.detail === 'BAD_DATE' && e.status === 400 && z.status === 400 && same(counts(), before) && live(a.sessionId), JSON.stringify([f, e, z]));
}

// ================= E4 本体の最後の見張りで失敗 → 全部戻る（H3） =================
{
  clearRate();
  const a = await add('U_t1', 'C1', dayOffset(-8), P1, { member: { message: '見本のお客様への文' } });
  //   ★壊れたデータ：枚の顧客を session と違う値にする（文11は session_id と日付しか直さない＝見張り12で必ず戻る）
  d.prepare(`UPDATE karte_member_notes SET customer_id = 'C3' WHERE mnote_id = ?`).run(a.mnoteId);
  const before = counts();
  const r = await edit('U_t1', { sessionId: a.sessionId, rev: 1, sessionDate: dayOffset(-8), items: P1.slice(1) });
  ok('E4 ★見張り12で失敗：404・古い session は生きたまま・新しい行は0・枚もそのまま・karte_revisions も増えない', r.status === 404 && same(counts(), before) && live(a.sessionId)
     && q1(env, `SELECT session_id FROM karte_member_notes WHERE mnote_id = ?`, a.mnoteId).session_id === a.sessionId
     && qn(env, `SELECT COUNT(*) n FROM karte_revisions WHERE row_id = ?`, a.sessionId) === 0, JSON.stringify(r));
  d.prepare(`UPDATE karte_member_notes SET customer_id = 'C1' WHERE mnote_id = ?`).run(a.mnoteId);
}

// ================= E5 文6が0行 → 見張り7で全部戻る（H3・文の組み立てを直接流す） =================
{
  clearRate();
  const a = await add('U_t1', 'C1', dayOffset(-9), P1);
  const t = normalizeTraining(P1.slice(1));
  const { stmts } = editTrainingStmts({ old: a.sessionId, rev: 1, sid: 'E5-NEW', cid: 'C1', tid: 't1', now: Date.now(), date: dayOffset(-9), tr: t, who: { role: 'trainer', trainerId: 't1' } });
  const i6 = stmts.findIndex((x) => /INSERT INTO karte_tr_sessions/.test(x.sql));
  const zero = stmts.slice(); zero[i6] = { sql: stmts[i6].sql.replace('deleted_at IS NULL', 'deleted_at IS NULL AND 0'), args: stmts[i6].args };
  const before = counts();
  let msg = '';
  d.exec('BEGIN');
  try { for (const x of zero) d.prepare(x.sql).run(...x.args); d.exec('COMMIT'); } catch (e) { msg = e.message; try { d.exec('ROLLBACK'); } catch (_) {} }
  ok('E5 ★文6を0行にすると BAD_STATE（KARTE_GUARD_STATE）で全体が戻る・子の4表の行数が変わらない', /KARTE_GUARD_STATE/.test(msg) && same(counts(), before) && live(a.sessionId), msg);
  ok('E5 文の組み立ては文6の直後に見張り（state）を置いている', /INSERT INTO karte_guard \(state\)/.test(stmts[i6 + 1].sql) && /karte_tr_sessions WHERE session_id = \? AND customer_id = \?/.test(stmts[i6 + 1].sql));
}

// ================= E6 顧客・作者・作成時刻は古い行から／customerId・member は受け取らない（H4） =================
{
  clearRate();
  const a = await add('U_t1', 'C1', dayOffset(-11), P1);
  const before = counts();
  const r1 = await edit('U_t1', { sessionId: a.sessionId, rev: 1, sessionDate: dayOffset(-11), items: P1, customerId: 'C2' });
  const r2 = await edit('U_t1', { sessionId: a.sessionId, rev: 1, sessionDate: dayOffset(-11), items: P1, member: { message: 'x' } });
  ok('E6 ★customerId・member があれば 400 SHAPE・何も変わらない', r1.status === 400 && r1.detail === 'SHAPE' && r2.status === 400 && r2.detail === 'SHAPE' && same(counts(), before), JSON.stringify([r1, r2]));
  const o = q1(env, `SELECT customer_id, author_trainer_id, created_at FROM karte_tr_sessions WHERE session_id = ?`, a.sessionId);
  const r = await edit('U_OWN', { sessionId: a.sessionId, rev: 1, sessionDate: dayOffset(-12), items: P1.slice(2) });
  const n = q1(env, `SELECT customer_id, author_trainer_id, created_at, session_date, rev FROM karte_tr_sessions WHERE session_id = ?`, r.sessionId);
  ok('E6 ★オーナーが直しても、新しい session の顧客・作者・作成時刻は古い行と同じ（日付だけ新しい）・rev 1', r.status === 200 && n.customer_id === o.customer_id
     && n.author_trainer_id === o.author_trainer_id && n.created_at === o.created_at && n.session_date === dayOffset(-12) && n.rev === 1, JSON.stringify([r, n]));
  ok('E6 オーナーが他人の記録を直したら記録の印は training_owner_override', qn(env, `SELECT COUNT(*) n FROM karte_access_log WHERE action = 'k_editTraining' AND section = 'training_owner_override' AND result = 'ok'`) >= 1);
}

// ================= E7 作者でないトレーナー（H5） =================
{
  clearRate();
  const a = await add('U_t1', 'C3', dayOffset(-13), P1);   // C3 は担当なし＝t2 にも見える
  const before = counts();
  const r = await edit('U_t2', { sessionId: a.sessionId, rev: 1, sessionDate: dayOffset(-13), items: P1.slice(1) });
  ok('E7 ★作者でないトレーナーは 403・何も変わらない', r.status === 403 && same(counts(), before) && live(a.sessionId), JSON.stringify(r));
}

// ================= E8・E9 二重送信（H6） =================
{
  clearRate();
  const a = await add('U_t1', 'C1', dayOffset(-14), P1);
  const id = crid();
  const body = { sessionId: a.sessionId, rev: 1, sessionDate: dayOffset(-14), items: P1.slice(1) };
  const r1 = await edit('U_t1', body, { clientReqId: id });
  const mid = counts();
  const r2 = await edit('U_t1', body, { clientReqId: id });
  ok('E8 ★同じ番号で2回：新しい session は1つ・2回目は replayed で同じ id', r1.status === 200 && r2.status === 200 && r2.replayed === true && r2.sessionId === r1.sessionId && same(counts(), mid)
     && qn(env, `SELECT COUNT(*) n FROM karte_tr_sessions WHERE customer_id = 'C1' AND session_date = ? AND deleted_at IS NULL`, dayOffset(-14)) === 1);
  const r3 = await edit('U_t1', { ...body, items: P1.slice(2) }, { clientReqId: id });
  ok('E9 ★同じ番号で別の中身（items が違う）：409 REQ_REUSED・何も変わらない', r3.status === 409 && r3.code === 'REQ_REUSED' && same(counts(), mid), JSON.stringify(r3));

  // E10 直した後に古い rev・古い id でもう一度（H7）／E13 古い id に削除（H13）
  const r4 = await edit('U_t1', { sessionId: a.sessionId, rev: 1, sessionDate: dayOffset(-14), items: P1 });
  const r5 = await call('U_t1', 'k_deleteTraining', { sessionId: a.sessionId, rev: 2, clientReqId: crid() });
  ok('E10 ★置き換え済みの古い id を直す：404・最新は生きたまま', r4.status === 404 && live(r1.sessionId), JSON.stringify(r4));
  ok('E13 ★置き換え済みの古い id を消す：404・最新は生きたまま', r5.status === 404 && live(r1.sessionId), JSON.stringify(r5));
  const r6 = await edit('U_t1', { sessionId: r1.sessionId, rev: 2, sessionDate: dayOffset(-14), items: P1 });
  ok('E10 最新の id でも rev が違えば 409・最新は変わらない', r6.status === 409 && live(r1.sessionId), JSON.stringify(r6));
}

// ================= E11・E12 「お客様へ」の付け替え（H8） =================
{
  clearRate();
  const a = await add('U_t1', 'C4', dayOffset(-15), P1, { member: { message: '見本のお客様への文', tags: ['脚'] } });
  const r = await edit('U_t1', { sessionId: a.sessionId, rev: 1, sessionDate: dayOffset(-15), items: P1.slice(2) });
  const m = q1(env, `SELECT session_id, session_date, rev, updated_by, author_trainer_id FROM karte_member_notes WHERE mnote_id = ?`, a.mnoteId);
  const mk = await buildMemberKarte(env, 'C4', {});
  ok('E11 ★枚は新しい session に付き替わる（生きた枚は1枚・rev+1・updated_by は直した人・作者はそのまま）', r.status === 200 && m.session_id === r.sessionId && m.rev === 2 && m.updated_by === 't1' && m.author_trainer_id === 't1'
     && qn(env, `SELECT COUNT(*) n FROM karte_member_notes WHERE customer_id = 'C4' AND deleted_at IS NULL`) === 1, JSON.stringify(m));
  ok('E11 ★会員の画面に「お客様へ」と日のタグが出続ける', mk.notes.length === 1 && mk.notes[0].message === '見本のお客様への文' && mk.training.sessions.length === 1 && same(mk.training.sessions[0].tags, ['脚']), JSON.stringify(mk.notes));
  const r2 = await edit('U_t1', { sessionId: r.sessionId, rev: 1, sessionDate: dayOffset(-16), items: P1.slice(2) });
  const m2 = q1(env, `SELECT session_id, session_date FROM karte_member_notes WHERE mnote_id = ?`, a.mnoteId);
  const mk2 = await buildMemberKarte(env, 'C4', {});
  ok('E12 ★日付を変えて直すと、枚の日付も新しい日に移り、会員の画面でも新しい日に出る', r2.status === 200 && m2.session_id === r2.sessionId && m2.session_date === dayOffset(-16)
     && mk2.notes[0].date === dayOffset(-16) && mk2.training.sessions[0].date === dayOffset(-16), JSON.stringify([r2, m2]));
}

// ================= E14 同じ日の並び（H15）・E15 監査に中身を入れない（H17）・E16 古い数字が残らない（H16） =================
{
  clearRate();
  const day = dayOffset(-20);
  const a = await add('U_t3', 'C3', day, [{ exercise: 'スクワット', sets: [{ weight: 100, reps: 5 }] }]);
  await new Promise((res) => setTimeout(res, 5));
  const b = await add('U_t3', 'C3', day, [{ exercise: 'ベンチプレス', sets: [{ weight: 40, reps: 10 }] }]);
  const before = (await tr('U_t3', 'C3')).sessions.filter((s) => s.session_date === day).map((s) => s.sets[0].exercise);
  const r = await edit('U_t3', { sessionId: a.sessionId, rev: 1, sessionDate: day, items: [{ exercise: 'スクワット', sets: [{ weight: 60, reps: 5, note: '見本のメモ' }] }] });
  const t = await tr('U_t3', 'C3');
  const after = t.sessions.filter((s) => s.session_date === day).map((s) => s.sets[0].exercise);
  ok('E14 ★同じ日に2回ある日の1回を直しても、k_training の並びが変わらない', r.status === 200 && same(before, after) && after.length === 2, JSON.stringify([before, after]));
  const rv = q1(env, `SELECT before_json, reason, changed_by FROM karte_revisions WHERE table_name = 'karte_tr_sessions' AND row_id = ?`, a.sessionId);
  const bj = JSON.parse(rv.before_json);
  ok('E15 ★karte_revisions の before_json の鍵は replaced_by・session_date だけ（中身を入れない）・reason は edit', same(Object.keys(bj).sort(), ['replaced_by', 'session_date']) && bj.replaced_by === r.sessionId && rv.reason === 'edit' && rv.changed_by === 't3', rv.before_json);
  const mk = await buildMemberKarte(env, 'C3', {});
  const bestSq = (mk.training.best || []).filter((x) => x.exercise === 'スクワット')[0];
  const trBest = (t.best || []).filter((x) => x.exercise === 'スクワット').map((x) => x.e1rm);
  ok('E16 ★重さを下げて直すと、会員の自己ベスト・k_training のグラフに古い数字（100kg）が出ない', bestSq && bestSq.weight === 60 && trBest.every((v) => v < 100) && trBest.length === 1, JSON.stringify([bestSq, trBest]));
  ok('E16 前の版は論理削除した行として残る（子の行も残る）', qn(env, `SELECT COUNT(*) n FROM karte_tr_sets WHERE session_id = ? AND weight_kg = 100`, a.sessionId) === 1 && !live(a.sessionId) && live(b.sessionId));
}

// ================= E17 新しい鍵の受付（ext） =================
{
  clearRate();
  const a = await add('U_t1', 'C1', dayOffset(-21), P1.slice(2));
  env.KARTE_TRAINING_EXT = 'off';
  const before = counts();
  const r = await edit('U_t1', { sessionId: a.sessionId, rev: 1, sessionDate: dayOffset(-21), items: P1 });
  ok('E17 ★新しい鍵を含む直しは ext が閉じていれば 409 TRAINING_EXT_OFF・何も変わらない', r.status === 409 && r.code === 'TRAINING_EXT_OFF' && same(counts(), before) && live(a.sessionId), JSON.stringify(r));
  const r2 = await edit('U_t1', { sessionId: a.sessionId, rev: 1, sessionDate: dayOffset(-21), items: [{ exercise: 'スクワット', sets: [{ weight: 40, reps: 10 }] }] });
  ok('E17 古い形（新しい鍵なし）の直しは ext に関わらず通る', r2.status === 200, JSON.stringify(r2));
  env.KARTE_TRAINING_EXT = 'on';
}

// ================= E21 往復：直さずに同じ中身で直す → 会員・トレーナーの見え方が同じ（H1） =================
{
  clearRate();
  const a = await add('U_t1', 'C2', dayOffset(-22), P1);
  // C2 は t2 担当。作者は t1（共有の範囲で見える）
  const t0 = findS(await tr('U_t1', 'C2'), a.sessionId);
  const mk0 = await buildMemberKarte(env, 'C2', {});
  const r = await edit('U_t1', { sessionId: a.sessionId, rev: 1, sessionDate: dayOffset(-22), items: P1 });
  const t1 = findS(await tr('U_t1', 'C2'), r.sessionId);
  const mk1 = await buildMemberKarte(env, 'C2', {});
  ok('E21 ★同じ中身で直すと、k_training の1回（種目の並び・セット・メモ・補助・無理やり・ドロップ）が id 以外同じ', r.status === 200 && same(shape(t0), shape(t1)), JSON.stringify([shape(t0), shape(t1)]).slice(0, 600));
  ok('E21 ★会員の画面（日別・自己ベスト）も同じ', same(mk0.training, mk1.training), JSON.stringify([mk0.training, mk1.training]).slice(0, 600));
  // E21b 古い回（3つの表の行が無い回）を直す → 新しい形になり ord が送った順
  const sid = 'E21B-OLD';
  d.prepare(`INSERT INTO karte_tr_sessions (session_id, customer_id, session_date, author_trainer_id, rev, created_at) VALUES (?, 'C2', ?, 't1', 1, ?)`).run(sid, dayOffset(-23), Date.now());
  d.prepare(`INSERT INTO karte_tr_sets (session_id, exercise, set_no, weight_kg, reps, note) VALUES (?, 'ベンチプレス', 1, 30, 10, NULL), (?, 'スクワット', 1, 40, 10, NULL)`).run(sid, sid);
  const r2 = await edit('U_t1', { sessionId: sid, rev: 1, sessionDate: dayOffset(-23), items: [{ exercise: 'スクワット', sets: [{ weight: 40, reps: 10 }] }, { exercise: 'ベンチプレス', sets: [{ weight: 30, reps: 10 }] }] });
  ok('E21b 古い回を直すと新しい形（ord は送った順）', r2.status === 200 && same(qa(env, `SELECT ord, exercise FROM karte_tr_exercises WHERE session_id = ? ORDER BY ord`, r2.sessionId), [{ ord: 1, exercise: 'スクワット' }, { ord: 2, exercise: 'ベンチプレス' }]), JSON.stringify(r2));
}

// ================= E32 部分 UNIQUE（新しい session に生きた枚が既にある壊れたデータ）→ 全体が戻る =================
{
  clearRate();
  const a = await add('U_t1', 'C1', dayOffset(-24), P1, { member: { message: '見本の文' } });
  d.prepare(`INSERT INTO karte_member_notes (mnote_id, customer_id, session_id, session_date, message, author_trainer_id, rev, created_at, updated_at) VALUES ('E32-M', 'C1', 'E32-NEW', ?, '見本', 't1', 1, 1, 1)`).run(dayOffset(-24));
  const t = normalizeTraining(P1.slice(1));
  const { stmts } = editTrainingStmts({ old: a.sessionId, rev: 1, sid: 'E32-NEW', cid: 'C1', tid: 't1', now: Date.now(), date: dayOffset(-24), tr: t, who: { role: 'trainer', trainerId: 't1' } });
  const before = counts();
  let msg = '';
  d.exec('BEGIN');
  try { for (const x of stmts) d.prepare(x.sql).run(...x.args); d.exec('COMMIT'); } catch (e) { msg = e.message; try { d.exec('ROLLBACK'); } catch (_) {} }
  ok('E32 部分 UNIQUE に当たると全体が戻る（古い session は生きたまま・枚も元の session）', /UNIQUE/.test(msg) && same(counts(), before) && live(a.sessionId)
     && q1(env, `SELECT session_id FROM karte_member_notes WHERE mnote_id = ?`, a.mnoteId).session_id === a.sessionId, msg);
  d.prepare(`DELETE FROM karte_member_notes WHERE mnote_id = 'E32-M'`).run();
}

console.log(`${fail ? '❌' : '✅'} 保存した記録を直す（設計58・Worker） 検証: ${pass} passed / ${fail} failed`);
if (fail) process.exit(1);
