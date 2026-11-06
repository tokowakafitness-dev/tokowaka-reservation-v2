// 種目の一覧（全員で共有・部位つき）と自重（重量0）を、本物の SQLite に 0001〜0028 の migration を流して入口（index.js）から通す・2026-11-06
//   実行: node worker/test/karte-exercises.test.js
//
//   ★D1 の身代わり（配列）では CHECK・PRIMARY KEY が再現しない＝node:sqlite に全 migration を流す
//   ★守り（許可表・Origin・トークン10分・二重送信）は index.js と runWrite にある＝入口から通す
//   ★会員・トレーナーの名前・ID は架空の値だけ


import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';
import { KARTE_HANDLERS, isKarteWrite } from '../src/routes/karte.js';
import { isAllowed } from '../src/perms.js';
import { EXERCISE_PARTS, EXERCISE_LIMITS, normalizeExerciseName } from '../src/lib/karte-exercises.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const W = join(HERE, '..');
const ORIGIN = 'https://reservation.tokowaka-gym.com';
const CHANNEL = '1234567890';
const SECRET = 'TEST-SECRET';

let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) pass++; else { fail++; console.log(`❌ ${name}${detail ? '\n   ' + detail : ''}`); } }

// ---------------- D1 の身代わり（実物の SQLite・全 migration）----------------
function makeEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(W, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(join(W, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    try { db.exec(readFileSync(join(W, 'migrations', f), 'utf8')); } catch (e) {
      if (!/duplicate column/.test(e.message)) throw e;
    }
  }
  const exec = (q, args, how) => {
    const st = db.prepare(q);
    if (how === 'first') { const r = st.get(...args); return r === undefined ? null : Object.assign({}, r); }
    if (how === 'all') return { results: st.all(...args).map((r) => Object.assign({}, r)) };
    const r = st.run(...args);
    return { meta: { changes: Number(r.changes) } };
  };
  const env = { LINE_CHANNEL_ID: CHANNEL, SHARED_SECRET: SECRET, _db: db, _kv: {} };
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

// ---------------- トークン（ES256）----------------
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pubJwk = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'k1', alg: 'ES256' };
async function token(sub, iatOffsetS = 0, noIat = false) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: 'ES256', kid: 'k1', typ: 'JWT' }));
  const p = { iss: 'https://access.line.me', aud: CHANNEL, sub, exp: now + 3600 };
  if (!noIat) p.iat = now - iatOffsetS;
  const pl = b64u(JSON.stringify(p));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(h + '.' + pl));
  return h + '.' + pl + '.' + b64u(sig);
}

// ---------------- 見本 ----------------
const env = makeEnv();
env._kv['jwks:line'] = JSON.stringify({ keys: [pubJwk] });
const NOW = Date.now();
const d = env._db;
d.exec(`INSERT INTO trainers (trainer_id, name, line_user_id, role, active) VALUES
  ('T1', '一郎', 'U_T1', 'trainer', 1), ('T2', '二郎', 'U_T2', 'trainer', 1), ('OWN', '店主', 'U_OWN', 'owner', 1)`);
d.exec(`INSERT INTO customers (customer_id, name, line_user_id, default_trainer_id, birthday, created_at, updated_at) VALUES
  ('C1', '会員一', 'U_C1', 'T1', '1990-05-01', 1, 1), ('C2', '会員二', NULL, 'T2', NULL, 1, 1), ('C3', '会員三', NULL, NULL, NULL, 1, 1)`);
const fresh = () => d.exec(`INSERT INTO sync_state (key, synced_at, rows, ok) VALUES ('customers', ${Date.now()}, 3, 1), ('trainers', ${Date.now()}, 3, 1), ('reservations', ${Date.now()}, 0, 1)
  ON CONFLICT(key) DO UPDATE SET synced_at = excluded.synced_at`);
fresh();

let reqSeq = 0;
const crid = () => 'req-' + (++reqSeq).toString().padStart(6, '0');
async function call(as, action, body = {}, o = {}) {
  const tok = await token(as, o.iatAge || 0, o.noIat);
  const payload = JSON.stringify({ action, idToken: tok, ...body });
  const headers = { 'Content-Type': 'application/json' };
  if (o.origin !== null) headers.Origin = o.origin || ORIGIN;
  const res = await worker.fetch(new Request('https://w.example/', { method: 'POST', headers, body: o.raw || payload }), env, { waitUntil() {} });
  let j = {};
  try { j = await res.json(); } catch (_) {}
  return { status: res.status, ...j };
}
const today = (() => { const t = new Date(Date.now() + 9 * 3600000); return t.toISOString().slice(0, 10); })();
const dayOffset = (n) => { const t = new Date(Date.now() + 9 * 3600000 + n * 86400000); return t.toISOString().slice(0, 10); };

const MIG = readFileSync(join(W, 'migrations/0028_karte_exercises.sql'), 'utf8');

// ================= E1. 表の制約（本物の SQLite） =================
{
  const tryIns = (name, part) => { try { d.prepare(`INSERT INTO karte_exercises (name, part, created_by, created_at) VALUES (?, ?, 'T1', 1)`).run(name, part); return true; } catch (e) { return false; } };
  ok('E1-1 部位の鍵は CHECK（知らない鍵は入らない）', !tryIns('チェック用A', 'legs_x') && !tryIns('チェック用B', '胸'));
  ok('E1-2 正しい鍵は入る・同じ名前は PRIMARY KEY で弾く', tryIns('チェック用C', 'chest') && !tryIns('チェック用C', 'arm'));
  ok('E1-3 名前は1〜50字・前後に空白を持たない（二重の守り）', !tryIns('', 'chest') && !tryIns('x'.repeat(51), 'chest') && !tryIns(' 前に空白', 'chest') && tryIns('x'.repeat(50), 'chest'));
  ok('E1-4 part は NOT NULL', !tryIns('チェック用D', null));
  d.exec(`DELETE FROM karte_exercises`);
  //   ★PART の鍵：Worker の固定表と表の CHECK が同じ（画面との一致は liff-karte-exercises.test.js）
  const m = /part IN \(([^)]*)\)/.exec(MIG);
  const sqlKeys = m ? m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')) : [];
  ok('E1-5 ★部位の鍵：lib/karte-exercises.js と migration の CHECK が同じ（順番も）', JSON.stringify(sqlKeys) === JSON.stringify(EXERCISE_PARTS.map((p) => p[0])), JSON.stringify(sqlKeys));
}

// ================= E2. 許可表と窓口の表 =================
ok('E2-1 ★k_exercises・k_saveExercise は許可表（trainer/owner だけ）と窓口の表の両方にある',
   ['k_exercises', 'k_saveExercise'].every((a) => isAllowed(a, 'trainer') && isAllowed(a, 'owner') && !isAllowed(a, 'customer') && !isAllowed(a, 'guest') && typeof KARTE_HANDLERS[a] === 'function'));
ok('E2-2 ★k_saveExercise は書き込み（Origin・トークン10分の守り）・k_exercises は読み', isKarteWrite('k_saveExercise') && !isKarteWrite('k_exercises'));
ok('E2-3 名前の正規化：前後の空白だけ落とす・全角半角はそのまま', normalizeExerciseName('  ＡＢケーブル  ') === 'ＡＢケーブル' && (() => { try { normalizeExerciseName('   '); return false; } catch (e) { return true; } })());

// ================= E3. 入口の守り =================
{
  const w = { name: 'ケーブルクロス', part: 'chest' };
  const c1 = await call('U_C1', 'k_saveExercise', { ...w, clientReqId: crid() });
  const g1 = await call('U_GUEST', 'k_exercises', {});
  ok('E3-1 会員・未登録は届かない（403）', c1.status === 403 && g1.status === 403, JSON.stringify([c1, g1]));
  const st = await call('U_T1', 'k_saveExercise', { ...w, clientReqId: crid() }, { iatAge: 3601 });
  ok('E3-2 ★発行から1時間を超えたトークンでは書けない（I46・決定0142）', st.status === 401 && st.detail === 'STALE_TOKEN', JSON.stringify(st));
  const og = await call('U_T1', 'k_saveExercise', { ...w, clientReqId: crid() }, { origin: 'https://evil.example' });
  ok('E3-3 許可外の Origin は403', og.status === 403 && og.detail === 'ORIGIN');
  ok('E3-4 ここまで1行も書いていない', q1(env, `SELECT COUNT(*) n FROM karte_exercises`).n === 0);
}

// ================= E4. 追加・部位の変更・二重送信 =================
{
  const id1 = crid();
  const a = await call('U_T1', 'k_saveExercise', { name: '  ケーブルクロス ', part: 'chest', clientReqId: id1 });
  ok('E4-1 追加できる（前後の空白は落とす）', a.status === 200 && a.success && a.name === 'ケーブルクロス' && a.part === 'chest', JSON.stringify(a));
  const row = q1(env, `SELECT * FROM karte_exercises WHERE name = 'ケーブルクロス'`);
  ok('E4-2 書いたのは誰か・いつか', row && row.part === 'chest' && row.created_by === 'T1' && row.created_at > 0 && row.deleted_at == null);
  const r2 = await call('U_T1', 'k_saveExercise', { name: '  ケーブルクロス ', part: 'chest', clientReqId: id1 });
  ok('E4-3 ★同じ送信番号・同じ中身は保存した応答（二重にならない）', r2.status === 200 && r2.replayed === true && q1(env, `SELECT COUNT(*) n FROM karte_exercises`).n === 1);
  const r3 = await call('U_T1', 'k_saveExercise', { name: 'ケーブルクロス', part: 'arm', clientReqId: id1 });
  ok('E4-4 ★同じ送信番号で中身が違えば REQ_REUSED（409）・書き換えない', r3.status === 409 && r3.code === 'REQ_REUSED' && q1(env, `SELECT part FROM karte_exercises WHERE name = 'ケーブルクロス'`).part === 'chest');
  const r4 = await call('U_T2', 'k_saveExercise', { name: 'ケーブルクロス', part: 'shoulder', clientReqId: crid() });
  const row4 = q1(env, `SELECT * FROM karte_exercises WHERE name = 'ケーブルクロス'`);
  ok('E4-5 ★別のトレーナーが部位を変えられる（共有の分類）・作った人は残り、変えた人を記録', r4.status === 200 && row4.part === 'shoulder' && row4.created_by === 'T1' && row4.updated_by === 'T2');
  const rv = q1(env, `SELECT * FROM karte_revisions WHERE table_name = 'karte_exercises' ORDER BY id DESC LIMIT 1`);
  ok('E4-6 変える前の部位を控える（名前と部位だけ）', rv && rv.row_id === 'ケーブルクロス' && JSON.parse(rv.before_json).part === 'chest' && rv.changed_by === 'T2', JSON.stringify(rv));
  for (const [label, body] of [['知らない部位', { name: 'X1', part: 'neck' }], ['部位なし', { name: 'X2' }], ['空の名前', { name: '   ', part: 'chest' }],
                               ['51字', { name: 'あ'.repeat(51), part: 'chest' }], ['名前が文字でない', { name: 12, part: 'chest' }], ['知らない鍵', { name: 'X3', part: 'chest', note: '腰痛' }]]) {
    const r = await call('U_T1', 'k_saveExercise', { ...body, clientReqId: crid() });
    ok('E4-7 400：' + label, r.status === 400 && r.code === 'BAD_REQUEST', JSON.stringify(r));
  }
  ok('E4-8 400 では書かない', q1(env, `SELECT COUNT(*) n FROM karte_exercises`).n === 1);
  d.exec(`UPDATE karte_exercises SET deleted_at = 5 WHERE name = 'ケーブルクロス'`);
  const r5 = await call('U_T1', 'k_saveExercise', { name: 'ケーブルクロス', part: 'back', clientReqId: crid() });
  ok('E4-9 消した行は書き直すと生き返る', r5.status === 200 && q1(env, `SELECT deleted_at d, part FROM karte_exercises WHERE name = 'ケーブルクロス'`).d == null);
}

// ================= E5. 読み：表の生きた行だけ（記録の自由文は読まない＝CEO 決定・関門②） =================
{
  d.exec(`DELETE FROM karte_rate`);
  const t1 = await call('U_T2', 'k_addTraining', { customerId: 'C2', sessionDate: today, clientReqId: crid(),
    items: [{ exercise: 'ケトルベルスイング', sets: [{ weight: 16, reps: 15 }] }, { exercise: 'ケーブルクロス', sets: [{ weight: 10, reps: 12 }] }] });
  d.exec(`INSERT INTO karte_exercises (name, part, created_by, created_at, deleted_at) VALUES ('消した種目', 'arm', 'T1', 1, 9)`);
  const ex = await call('U_T1', 'k_exercises', {});
  const by = Object.fromEntries((ex.exercises || []).map((x) => [x.name, x.part]));
  ok('E5-1 ★記録にしか無い名前（自由文）は返さない＝顧客と切り離して全員に並べない', t1.status === 200 && ex.status === 200 && !('ケトルベルスイング' in by), JSON.stringify(ex));
  ok('E5-2 表にある種目は表の部位で1つだけ', by['ケーブルクロス'] === 'back' && ex.exercises.filter((x) => x.name === 'ケーブルクロス').length === 1);
  ok('E5-3 消した行は返さない', !('消した種目' in by));
  ok('E5-4 上限の印（truncated=false）と版・部位は必ず鍵（null を返さない）', ex.truncated === false && typeof ex.karteSchema === 'number' && ex.exercises.every((x) => typeof x.part === 'string'));
  const ow = await call('U_OWN', 'k_exercises', {});
  ok('E5-5 オーナーも読める', ow.status === 200 && ow.exercises.length === ex.exercises.length);
  ok('E5-6 ★読みの SQL は karte_tr_sets を走査しない', !/karte_tr_sets/.test(readFileSync(join(W, 'src/routes/karte.js'), 'utf8').split('async function exercises(c)')[1].split('async function saveExercise')[0]));
}

// ================= E6. 上限（500） =================
{
  d.exec(`DELETE FROM karte_rate`);
  d.exec(`DELETE FROM karte_exercises`);
  const st = d.prepare(`INSERT INTO karte_exercises (name, part, created_by, created_at) VALUES (?, 'other', 'T1', 1)`);
  for (let i = 0; i < EXERCISE_LIMITS.MAX_ROWS; i++) st.run('上限用' + String(i).padStart(3, '0'));
  d.exec(`INSERT INTO karte_exercises (name, part, created_by, created_at, deleted_at) VALUES ('消して復活', 'arm', 'T1', 1, 9)`);
  const nw = await call('U_T1', 'k_saveExercise', { name: '501番目', part: 'chest', clientReqId: crid() });
  ok('E6-1 ★500件で新しい名前は EX_LIMIT（409）・書かない', nw.status === 409 && nw.code === 'EX_LIMIT' && !q1(env, `SELECT 1 x FROM karte_exercises WHERE name = '501番目'`), JSON.stringify(nw));
  const rv = await call('U_T1', 'k_saveExercise', { name: '消して復活', part: 'chest', clientReqId: crid() });
  ok('E6-1b ★消した行の復活も生きた行を増やす＝500件なら EX_LIMIT（上限を超えない）', rv.status === 409 && rv.code === 'EX_LIMIT' && q1(env, `SELECT deleted_at d FROM karte_exercises WHERE name = '消して復活'`).d === 9, JSON.stringify(rv));
  const up = await call('U_T1', 'k_saveExercise', { name: '上限用000', part: 'arm', clientReqId: crid() });
  ok('E6-2 生きている名前の部位の変更は通る', up.status === 200 && q1(env, `SELECT part FROM karte_exercises WHERE name = '上限用000'`).part === 'arm');
  ok('E6-2b 上限のまま（500）', q1(env, `SELECT COUNT(*) n FROM karte_exercises WHERE deleted_at IS NULL`).n === 500);
  //   見張り：先の数え上げをすり抜けても（並行）batch の中で同じ条件で止める。本番の文を取り出して本物の SQLite で動かす
  const SRC = readFileSync(join(W, 'src/routes/karte.js'), 'utf8');
  const gm = /S\(`(INSERT INTO karte_guard \(state\)[^`]*)`, name, L\.MAX_ROWS\)/.exec(SRC.split('async function saveExercise(c)')[1] || '');
  const runGuard = (nm) => { try { d.prepare(gm[1]).run(nm, EXERCISE_LIMITS.MAX_ROWS); return 'pass'; } catch (e) { return /KARTE_GUARD_STATE/.test(e.message) ? 'stop' : e.message; } };
  ok('E6-4 ★batch の見張り：新しい名前・消した行の復活は止め、生きている名前の変更は通す', !!gm && runGuard('新しい名前') === 'stop' && runGuard('消して復活') === 'stop' && runGuard('上限用001') === 'pass', gm ? [runGuard('新しい名前'), runGuard('消して復活'), runGuard('上限用001')].join(',') : 'no guard');
  st.run('上限用500');
  const ex = await call('U_T1', 'k_exercises', {});
  ok('E6-3 ★読みは500件まで・入りきらなければ truncated', ex.exercises.length === EXERCISE_LIMITS.MAX_ROWS && ex.truncated === true, ex.exercises.length + ' ' + ex.truncated);
  d.exec(`DELETE FROM karte_exercises WHERE name LIKE '上限用%' OR name = '消して復活'`);
}

// ================= E7. 自重（重量0）は全層を通る =================
{
  d.exec(`DELETE FROM karte_rate`);
  const r = await call('U_T1', 'k_addTraining', { customerId: 'C1', sessionDate: today, clientReqId: crid(),
    items: [{ exercise: 'ディップス', sets: [{ weight: 0, reps: 12 }, { weight: 0, reps: 10 }] }] });
  ok('E7-1 ★重量0（自重）を保存できる', r.status === 200 && q1(env, `SELECT COUNT(*) n FROM karte_tr_sets WHERE exercise = 'ディップス' AND weight_kg = 0`).n === 2, JSON.stringify(r));
  const n = await call('U_T1', 'k_addTraining', { customerId: 'C1', sessionDate: today, clientReqId: crid(), items: [{ exercise: 'ディップス', sets: [{ weight: null, reps: 12 }] }] });
  ok('E7-2 重量 null は今までどおり 400（画面が空を 0 にして送る）', n.status === 400);
  const tr = await call('U_T1', 'k_training', { customerId: 'C1' });
  const s0 = (tr.sessions || []).find((s) => (s.sets || []).some((x) => x.exercise === 'ディップス'));
  ok('E7-3 読みでも 0 のまま返る', s0 && s0.sets.filter((x) => x.exercise === 'ディップス').every((x) => x.weight_kg === 0));
  const pv = await call('U_T1', 'k_memberPreview', { customerId: 'C1' });
  const it = pv.training && (pv.training.sessions || []).flatMap((s) => s.items || []).find((x) => x.exercise === 'ディップス');
  ok('E7-4 ★会員のカルテの組み立て（buildMemberKarte）も 0 を 0 で返す（画面が「自重」と出す）', it && it.sets.every((x) => x.weight === 0), JSON.stringify(pv.training && pv.training.sessions).slice(0, 300));
}

console.log(`\n${fail ? '❌' : '✅'} 種目の一覧・自重（入口から） 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
