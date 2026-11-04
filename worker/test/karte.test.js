// 顧客カルテ（設計28・段1）を、本物の SQLite に全 migration を流し、**入口（index.js）から**通す。
//   実行: node worker/test/karte.test.js
//
// ★なぜ入口から通すか
//   守り（許可表・役割の鮮度・停止スイッチ・Origin・トークンの新しさ・本文の大きさ）は index.js にあり、
//   窓口を直接呼ぶ検査ではどれも通らない（部品ではなく配線を検査する）。
//   トークンは検査の中で作った ES256 の鍵で署名し、JWKS を KV の身代わりに入れる。

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';
import { e1rm, isRealDate, isPastOrToday, withdrawnDate } from '../src/routes/karte.js';

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

// ================= 1. 入口の守り =================
{
  const r1 = await call('U_C1', 'k_summary', { customerId: 'C1' });
  ok('1-1 会員（customer）はカルテに届かない', r1.status === 403 && r1.code === 'FORBIDDEN', JSON.stringify(r1));
  const r2 = await call('U_GUEST', 'k_summary', { customerId: 'C1' });
  ok('1-2 未登録（guest）も届かない', r2.status === 403);
  const r3 = await call('U_T2', 'k_summary', { customerId: 'C1' });
  ok('1-3 トレーナーは担当外でも概要に届く（共有の範囲）', r3.status === 200 && r3.success && r3.customer && r3.customer.customerId === 'C1', JSON.stringify(r3).slice(0, 200));
  ok('1-3b 担当外なので assigned=false', r3.assigned === false);
  ok('1-3c ★担当外には契約の状態・連絡先・残数を返さない', r3.customer.contractStatus === undefined
     && !('phone' in r3.customer) && !('email' in r3.customer) && !('home' in r3), JSON.stringify(r3.customer));
  const r3d = await call('U_T1', 'k_summary', { customerId: 'C1' });
  ok('1-3d 担当には契約の状態を返す', 'contractStatus' in r3d.customer);

  env.KARTE = 'off';
  const r4 = await call('U_T1', 'k_summary', { customerId: 'C1' });
  ok('1-4 停止スイッチ KARTE=off で止まる', r4.status === 503 && r4.code === 'KARTE_OFF');
  delete env.KARTE;

  const w = { customerId: 'C1', sessionDate: today, body: 'メモ', clientReqId: crid() };
  const r5 = await call('U_T1', 'k_addNote', w, { origin: 'https://evil.example' });
  ok('1-5 書き込みは許可外の Origin で403', r5.status === 403 && r5.detail === 'ORIGIN');
  const r6 = await call('U_T1', 'k_addNote', { ...w, clientReqId: crid() }, { origin: null });
  ok('1-6 Origin が無くても403', r6.status === 403);
  const r7 = await call('U_T1', 'k_addNote', { ...w, clientReqId: crid() }, { iatAge: 601 });
  ok('1-7 発行から10分を超えたトークンは書けない', r7.status === 401 && r7.detail === 'STALE_TOKEN');
  const r8 = await call('U_T1', 'k_addNote', { ...w, clientReqId: crid() }, { noIat: true });
  ok('1-8 iat の無いトークンは書けない', r8.status === 401);
  const r8b = await call('U_T1', 'k_summary', { customerId: 'C1' }, { iatAge: 3000 });
  ok('1-8b 読み取りはトークンの新しさを問わない（有効期限内なら）', r8b.status === 200);

  d.exec(`UPDATE sync_state SET synced_at = 1 WHERE key = 'trainers'`);
  const r9 = await call('U_T1', 'k_summary', { customerId: 'C1' });
  ok('1-9 役割の写しが古いと403（GAS へ落とす道が無いので答えない）', r9.status === 403 && r9.detail === 'ROLES_STALE');
  fresh();

  const big = JSON.stringify({ action: 'k_summary', idToken: await token('U_T1'), pad: 'x'.repeat(17 * 1024) });
  const r10 = await call('U_T1', 'k_summary', {}, { raw: big });
  ok('1-10 16KB を超える本文は JSON を読む前に413', r10.status === 413 && r10.code === 'TOO_LARGE');

  const pre = await worker.fetch(new Request('https://w.example/', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }), env, {});
  ok('1-11 許可外の Origin の事前確認は403・CORS ヘッダなし', pre.status === 403 && !pre.headers.get('Access-Control-Allow-Origin'));
}

// ================= 2. メモ・二重送信・rev・権限 =================
let noteId;
{
  const id = crid();
  const a = await call('U_T1', 'k_addNote', { customerId: 'C1', sessionDate: today, condition: 'good', body: '胸の日', nextPlan: '脚', clientReqId: id });
  ok('2-1 メモを書ける', a.status === 200 && a.noteId && a.rev === 1, JSON.stringify(a));
  noteId = a.noteId;
  const b = await call('U_T1', 'k_addNote', { customerId: 'C1', sessionDate: today, condition: 'good', body: '胸の日', nextPlan: '脚', clientReqId: id });
  ok('2-2 同じ鍵・同じ中身の再送は保存した結果（1件のまま）', b.status === 200 && b.replayed && b.noteId === noteId
     && q1(env, `SELECT COUNT(*) n FROM karte_notes`).n === 1);
  const c = await call('U_T1', 'k_addNote', { customerId: 'C1', sessionDate: today, body: '別の中身', clientReqId: id });
  ok('2-3 同じ鍵で中身が違えば REQ_REUSED', c.status === 409 && c.code === 'REQ_REUSED');
  const fut = await call('U_T1', 'k_addNote', { customerId: 'C1', sessionDate: dayOffset(2), body: 'x', clientReqId: crid() });
  ok('2-4 未来の日付は書けない', fut.status === 400);
  const nf = await call('U_T1', 'k_addNote', { customerId: 'NOPE', sessionDate: today, body: 'x', clientReqId: crid() });
  ok('2-5 存在しない顧客には書けない', nf.status === 404);

  const e1 = await call('U_T2', 'k_editNote', { noteId, rev: 1, body: '書き換え', clientReqId: crid() });
  ok('2-6 書いた本人以外のトレーナーは編集できない', e1.status === 403 && e1.code === 'FORBIDDEN');
  const e2 = await call('U_T1', 'k_editNote', { noteId, rev: 1, body: '直した', clientReqId: crid() });
  ok('2-7 本人は編集できる（rev 2）', e2.status === 200 && e2.rev === 2);
  const e3 = await call('U_T1', 'k_editNote', { noteId, rev: 1, body: '古い rev', clientReqId: crid() });
  ok('2-8 古い rev は CONFLICT', e3.status === 409 && e3.code === 'CONFLICT');
  ok('2-8b 編集前の中身が履歴に残る', q1(env, `SELECT COUNT(*) n FROM karte_revisions WHERE table_name = 'karte_notes'`).n === 1);
  const e4 = await call('U_OWN', 'k_editNote', { noteId, rev: 2, body: 'オーナーが直した', reason: '誤字', clientReqId: crid() });
  ok('2-9 オーナーは他人のメモも直せる', e4.status === 200 && e4.rev === 3);
  const list = await call('U_T2', 'k_notes', { customerId: 'C1' });
  ok('2-10 担当外のトレーナーもメモを読める（共有）', list.status === 200 && list.notes.length === 1 && list.notes[0].body === 'オーナーが直した');
  ok('2-11 閲覧が記録に残る（中身は書かない）', q1(env, `SELECT COUNT(*) n FROM karte_access_log WHERE action = 'k_notes' AND result = 'ok'`).n >= 1
     && !q1(env, `SELECT 1 x FROM karte_access_log WHERE section LIKE '%オーナー%'`));
}

// ================= 3. 安全面（同意） =================
{
  const s0 = await call('U_T1', 'k_saveSafety', { customerId: 'C1', rev: 0, injuries: '右膝', clientReqId: crid() });
  ok('3-1 同意なしでは書けない（NO_CONSENT）', s0.status === 403 && s0.code === 'NO_CONSENT');
  ok('3-1b 何も書かれていない', !q1(env, `SELECT 1 x FROM karte_safety WHERE customer_id = 'C1'`));
  const k1 = await call('U_T1', 'k_saveConsent', { customerId: 'C1', state: 'agreed', method: 'paper', clientReqId: crid() });
  ok('3-2 同意を記録できる', k1.status === 200 && k1.state === 'agreed');
  const s1 = await call('U_T1', 'k_saveSafety', { customerId: 'C1', rev: 0, injuries: '右膝', restrictions: 'ジャンプ不可', clientReqId: crid() });
  ok('3-3 同意があれば書ける', s1.status === 200 && s1.rev === 1, JSON.stringify(s1));
  const r1 = await call('U_T2', 'k_safety', { customerId: 'C1' });
  ok('3-4 担当外のトレーナーも読める（共有）', r1.status === 200 && r1.safety && r1.safety.injuries === '右膝');
  const sum = await call('U_T1', 'k_summary', { customerId: 'C1' });
  ok('3-5 概要には要点（制限）だけ', sum.safetyBrief && sum.safetyBrief.restrictions === 'ジャンプ不可' && sum.safetyBrief.injuries === undefined);
  ok('3-6 安全面の中身は履歴に入らない', !q1(env, `SELECT 1 x FROM karte_revisions WHERE table_name = 'karte_safety'`));
  const k2 = await call('U_T1', 'k_saveConsent', { customerId: 'C1', state: 'revoked', method: 'paper', clientReqId: crid() });
  ok('3-7 撤回すると中身が消える', k2.status === 200 && !q1(env, `SELECT 1 x FROM karte_safety WHERE customer_id = 'C1'`));
  const r2 = await call('U_T1', 'k_safety', { customerId: 'C1' });
  ok('3-8 撤回後は返らない', r2.status === 200 && r2.safety === null && r2.consent === 'revoked');
  const s2 = await call('U_T1', 'k_saveSafety', { customerId: 'C1', rev: 0, injuries: '右膝', clientReqId: crid() });
  ok('3-9 撤回後は書けない', s2.status === 403 && s2.code === 'NO_CONSENT');
  ok('3-10 同意の履歴が2行', q1(env, `SELECT COUNT(*) n FROM karte_consent_log WHERE customer_id = 'C1'`).n === 2);
}

// ================= 4. 範囲（契約・一覧） =================
{
  d.exec(`INSERT INTO calc_meta (key, payload) VALUES ('contract_cols', '${JSON.stringify({ cols: { name: 1, type: 2, course: 5, freq: 8, ticket: 6, start: 10, end: 11, method: 16, trainer: 3, ticketPrice: 19 } })}')`);
  const row = new Array(23).fill(''); row[2] = 'チケット'; row[6] = 8; row[19] = 99999; row[3] = '一郎';
  d.prepare(`INSERT INTO calc_contract_rows (row_key, customer_id, idx, row_json, start_ms, end_ms) VALUES (?, ?, ?, ?, ?, ?)`)
    .run('C1#1', 'C1', 1, JSON.stringify(row), NOW - 86400000, NOW + 10 * 86400000);
  const c1 = await call('U_T2', 'k_contract', { customerId: 'C1' });
  ok('4-1 担当外のトレーナーは契約を見られない', c1.status === 403);
  const c2 = await call('U_T1', 'k_contract', { customerId: 'C1' });
  ok('4-2 担当は契約を見られる（金額の列は出ない）', c2.status === 200 && c2.contracts.length === 1 && c2.contracts[0].tickets === 8
     && !JSON.stringify(c2).includes('99999'), JSON.stringify(c2));
  const b2 = await call('U_T2', 'k_board', {});
  const ids2 = (b2.customers || []).map((x) => x.customerId).sort().join(',');
  ok('4-3 一覧は担当＋担当なし（T2 は C2・C3）', b2.status === 200 && ids2 === 'C2,C3', ids2);
  const bo = await call('U_OWN', 'k_board', {});
  ok('4-4 オーナーの一覧は全員', (bo.customers || []).length === 3);
  ok('4-5 一覧に金額・健康情報は出ない', !JSON.stringify(bo).includes('99999') && !JSON.stringify(bo).includes('右膝'));
  const f1 = (bo.customers || []).find((x) => x.customerId === 'C1').flags;
  ok('4-6 契約の完全同期が無ければ「確認中」（問題なしにしない）', f1.contractEnding === 'unknown', JSON.stringify(f1));
  ok('4-7 体の記録の切り替え前は「準備中」', f1.recordStale === 'preparing');
}

// ================= 5. 体の記録（切り替え前は書けない） =================
{
  const m0 = await call('U_T1', 'k_addMeasurement', { customerId: 'C1', measuredDate: today, values: { weight_kg: 70 }, clientReqId: crid() });
  ok('5-1 切り替え前は BODY_NOT_READY（シートと並行させない）', m0.status === 409 && m0.code === 'BODY_NOT_READY');
  ok('5-1b 何も書かれていない', q1(env, `SELECT COUNT(*) n FROM body_measurements`).n === 0);
  d.exec(`INSERT INTO body_freeze (freeze_id, state, counts_json, hashes_json, copied_json, started_at) VALUES ('fz000001', 'frozen', '{}', '{}', '{}', ${NOW})`);
  const m1 = await call('U_T1', 'k_addMeasurement', { customerId: 'C1', measuredDate: today, values: { weight_kg: 70, body_fat_pct: 20, waist_cm: 80 }, clientReqId: crid() });
  ok('5-2 切り替え後は書ける（id が返る）', m1.status === 200 && Number(m1.id) > 0, JSON.stringify(m1));
  ok('5-3 除脂肪が計算で補われる', q1(env, `SELECT lean_kg FROM body_measurements WHERE id = ?`, m1.id).lean_kg === 56);
  const m2 = await call('U_T1', 'k_addMeasurement', { customerId: 'C1', measuredDate: today, values: { waist_cm: 300 }, clientReqId: crid() });
  ok('5-4 範囲外は書けない', m2.status === 400);
  const bd = await call('U_T1', 'k_body', { customerId: 'C1' });
  ok('5-5 verified になるまでは「からだ」は準備中', bd.status === 200 && bd.ready === false);
  d.exec(`UPDATE body_freeze SET state = 'verified'`);
  const bd2 = await call('U_T2', 'k_body', { customerId: 'C1' });
  ok('5-6 verified 後は担当外のトレーナーも読める', bd2.ready === true && bd2.rows.length === 1 && bd2.rows[0].w === 70 && bd2.rows[0].waist === 80 && bd2.rows[0].fat === 14, JSON.stringify(bd2.rows));
  //   ★verified の凍結の後に、別の凍結（copying）の未確認の写しがあっても一覧に混ざらない
  d.exec(`INSERT INTO body_freeze (freeze_id, state, counts_json, hashes_json, copied_json, started_at) VALUES ('fz000002', 'copying', '{}', '{}', '{}', ${NOW + 1})`);
  d.exec(`INSERT INTO body_measurements (customer_id, measured_date, source_raw, origin, origin_key, sheet_order, weight_kg, created_at, updated_at)
          VALUES ('C3', '${today}', 'self', 'sheet', 'fz000002:body_log:0', 0, 60, 1, 1)`);
  const bo2 = await call('U_OWN', 'k_board', {});
  const c3f = (bo2.customers || []).find((x) => x.customerId === 'C3').flags;
  ok('5-6b 未確認の凍結の写しは一覧の最終測定日に混ざらない', c3f.recordStale === 'none', JSON.stringify(c3f));
  const bd3 = await call('U_T1', 'k_body', { customerId: 'C3' });
  ok('5-6c 未確認の凍結の写しは「からだ」にも出ない', bd3.ready === true && bd3.rows.length === 0, JSON.stringify(bd3.rows));
  const del1 = await call('U_T2', 'k_deleteMeasurement', { id: m1.id, rev: 1, clientReqId: crid() });
  ok('5-7 入れた本人以外は消せない', del1.status === 403);
  const del2 = await call('U_T1', 'k_deleteMeasurement', { id: m1.id, rev: 1, clientReqId: crid() });
  ok('5-8 本人は消せる・読まれなくなる', del2.status === 200 && (await call('U_T1', 'k_body', { customerId: 'C1' })).rows.length === 0);
}

// ================= 6. トレーニング =================
{
  const t1 = await call('U_T1', 'k_addTraining', { customerId: 'C1', sessionDate: today, clientReqId: crid(),
    items: [{ exercise: 'ベンチプレス', sets: [{ weight: 40, reps: 10 }, { weight: 45, reps: 8 }, { weight: 50, reps: 13 }] }] });
  ok('6-1 1行1セットで書ける（重量・回数がセットごとに違う）', t1.status === 200 && q1(env, `SELECT COUNT(*) n FROM karte_tr_sets`).n === 3, JSON.stringify(t1));
  const tr = await call('U_T2', 'k_training', { customerId: 'C1' });
  const best = (tr.best || []).find((x) => x.exercise === 'ベンチプレス');
  ok('6-2 その日の推定1RMの最大（13回は出さない）', best && best.e1rm === 57, JSON.stringify(tr.best));
  const bad = await call('U_T1', 'k_addTraining', { customerId: 'C1', sessionDate: today, clientReqId: crid(), items: [{ exercise: 'x', sets: new Array(11).fill({ weight: 1, reps: 1 }) }] });
  ok('6-3 1種目11セットは書けない', bad.status === 400);
  ok('6-4 推定1RM：回数1は重量・12回まで・13回は出さない・重量0は0', e1rm(100, 1) === 100 && e1rm(100, 12) === 140 && e1rm(100, 13) === null && e1rm(0, 5) === 0);
}

// ================= 7. 退会の記録 =================
{
  const p1 = await call('U_T2', 'k_recordMembership', { customerId: 'C1', kind: 'withdrawn', effectiveDate: dayOffset(-10), clientReqId: crid() });
  ok('7-1 担当外のトレーナーは記録できない', p1.status === 403);
  const w1 = await call('U_T1', 'k_recordMembership', { customerId: 'C1', kind: 'withdrawn', effectiveDate: dayOffset(-10), clientReqId: crid() });
  ok('7-2 担当は退会を記録できる', w1.status === 200 && w1.kind === 'withdrawn', JSON.stringify(w1));
  const w2 = await call('U_T1', 'k_recordMembership', { customerId: 'C1', kind: 'withdrawn', effectiveDate: dayOffset(-5), clientReqId: crid() });
  ok('7-3 退会の後に退会は記録できない（起算日を動かせない）', w2.status === 409 && w2.code === 'BAD_STATE');
  const r0 = await call('U_T1', 'k_recordMembership', { customerId: 'C1', kind: 'rejoined', effectiveDate: dayOffset(-20), clientReqId: crid() });
  ok('7-4 最後の行より前の日付には差し込めない', r0.status === 409);
  const fut = await call('U_T1', 'k_recordMembership', { customerId: 'C1', kind: 'rejoined', effectiveDate: dayOffset(3), clientReqId: crid() });
  ok('7-5 未来の日付は記録できない', fut.status === 400);
  const bad = await call('U_T1', 'k_recordMembership', { customerId: 'C1', kind: 'rejoined', effectiveDate: '2026-13-01', clientReqId: crid() });
  ok('7-6 実在しない日付は記録できない', bad.status === 400);
  const r1 = await call('U_T1', 'k_recordMembership', { customerId: 'C1', kind: 'rejoined', effectiveDate: dayOffset(-2), clientReqId: crid() });
  ok('7-7 退会の後は再入会を記録できる', r1.status === 200);
  const c0 = await call('U_T1', 'k_recordMembership', { customerId: 'C1', kind: 'cancel', targetEventId: r1.id, reason: '誤り', clientReqId: crid() });
  ok('7-8 取り消しはオーナーだけ', c0.status === 403);
  const c1 = await call('U_OWN', 'k_recordMembership', { customerId: 'C1', kind: 'cancel', targetEventId: w1.id, reason: '途中', clientReqId: crid() });
  ok('7-9 途中の行は取り消せない（最後の1行だけ）', c1.status === 409 && c1.code === 'BAD_STATE');
  const c2 = await call('U_OWN', 'k_recordMembership', { customerId: 'C1', kind: 'cancel', targetEventId: r1.id, reason: '誤記録', clientReqId: crid() });
  ok('7-10 最後の行（再入会）は取り消せる', c2.status === 200);
  const wd = await withdrawnDate(env, 'C1');
  ok('7-11 再入会を取り消すと起算日が退会の日に戻る', wd && wd.date === dayOffset(-10), JSON.stringify(wd));
  const c3 = await call('U_OWN', 'k_recordMembership', { customerId: 'C1', kind: 'cancel', targetEventId: r1.id, reason: '二重', clientReqId: crid() });
  ok('7-12 取り消し済みは二度取り消せない', c3.status === 409);
}

// ================= 8. 回数の制限（61回目は一切変化なし） =================
{
  d.exec(`DELETE FROM karte_rate`);
  const before = q1(env, `SELECT COUNT(*) n FROM karte_notes`).n;
  let last;
  for (let i = 0; i < 61; i++) last = await call('U_T2', 'k_addNote', { customerId: 'C3', sessionDate: today, body: 'n' + i, clientReqId: crid() });
  const after = q1(env, `SELECT COUNT(*) n FROM karte_notes`).n;
  ok('8-1 61回目は429', last.status === 429 && last.code === 'RATE_LIMITED', JSON.stringify(last));
  ok('8-2 61回目は本体も requests も書かれない（60件だけ増える）', after - before === 60, `${before} → ${after}`);
  const again = await call('U_T2', 'k_addNote', { customerId: 'C3', sessionDate: today, body: 'more', clientReqId: crid() });
  ok('8-3 上限のあとも止まり続ける（数は60で止まる＝越えた要求は加算ごと巻き戻る）', again.status === 429 && q1(env, `SELECT n FROM karte_rate WHERE trainer_id = 'T2'`).n === 60);
  //   本体で失敗した要求（同意なし）も1回に数える＝試行回数の制限
  d.exec(`DELETE FROM karte_rate`);
  await call('U_T2', 'k_saveSafety', { customerId: 'C3', rev: 0, injuries: 'x', clientReqId: crid() });
  ok('8-4 本体で失敗した要求も1回に数える', q1(env, `SELECT n FROM karte_rate WHERE trainer_id = 'T2'`).n === 1);
}

// ================= 10. ヒアリング・痛みの身体図・指導の履歴（設計31） =================
{
  d.exec(`DELETE FROM karte_rate`);
  d.exec(`INSERT INTO customers (customer_id, name, line_user_id, default_trainer_id, birthday, created_at, updated_at) VALUES ('C4', '会員四', NULL, 'T1', NULL, 1, 1)`);
  const H = { purposes: ['strength', 'diet'], slimAreas: ['thigh', 'belly'], motivation: 7, targetWeight: 54.04, targetFat: 24,
              exerciseNow: '  週1 ウォーキング ', exercisePast: 'ヨガ', sleep: '6時間', meals: '1日2食' };
  const p1 = await call('U_T1', 'k_saveProfile', { customerId: 'C4', rev: 0, goalText: '水着を着たい', goalDeadline: '2027-03-31', hearing: H, clientReqId: crid() });
  ok('10-1 ヒアリングを保存できる', p1.status === 200 && p1.success, JSON.stringify(p1));
  const row = q1(env, `SELECT hearing_json, goal_text, goal_value FROM karte_profile WHERE customer_id = 'C4'`);
  const hj = JSON.parse(row.hearing_json);
  ok('10-2 ★正規化：目的は固定表の順・部位は受け取った順・数値は小数1桁・自由文は前後の空白を除く',
     JSON.stringify(hj.purposes) === '["diet","strength"]' && JSON.stringify(hj.slimAreas) === '["thigh","belly"]'
     && hj.targetWeight === 54 && hj.exerciseNow === '週1 ウォーキング', row.hearing_json);
  //   古い画面（hearing の鍵が無い）から保存しても消えない
  const p2 = await call('U_T1', 'k_saveProfile', { customerId: 'C4', rev: 1, motive: '自信', clientReqId: crid() });
  const row2 = q1(env, `SELECT hearing_json, goal_text, motive FROM karte_profile WHERE customer_id = 'C4'`);
  ok('10-3 ★鍵が無い列は変えない（古い画面の保存でヒアリング・理想を消さない）', p2.success && row2.hearing_json === row.hearing_json && row2.goal_text === '水着を着たい' && row2.motive === '自信', JSON.stringify(row2));
  //   null は消す（空のヒアリングは NULL）
  await call('U_T1', 'k_saveProfile', { customerId: 'C4', rev: 2, hearing: { purposes: [], exerciseNow: '  ' }, clientReqId: crid() });
  ok('10-4 ★中身が空のヒアリングは NULL で保存（一覧の「未記入」と一致）', q1(env, `SELECT hearing_json FROM karte_profile WHERE customer_id = 'C4'`).hearing_json === null);
  await call('U_T1', 'k_saveProfile', { customerId: 'C4', rev: 3, hearing: H, clientReqId: crid() });
  //   不正な入力は 400
  const badCases = [
    { purposes: ['diet', 'diet'] }, { purposes: ['unknown'] }, { slimAreas: ['belly', 'arm', 'hip', 'calf'] },
    { motivation: 11 }, { motivation: '7' }, { motivation: 6.5 }, { targetWeight: 10 }, { exerciseNow: 'あ'.repeat(101) },
    { extra: 1 }, ['diet'],
  ];
  let allBad = true, which = '';
  for (const bc of badCases) {
    const r = await call('U_T1', 'k_saveProfile', { customerId: 'C4', rev: 4, hearing: bc, clientReqId: crid() });
    if (r.status !== 400) { allBad = false; which = JSON.stringify(bc) + ' → ' + r.status; break; }
  }
  ok('10-5 ★重複・知らない鍵・範囲外・型違い・余計な鍵は 400', allBad, which);
  //   控えに自由文を残さない
  const revs = d.prepare(`SELECT before_json FROM karte_revisions WHERE table_name = 'karte_profile' AND row_id = 'C4'`).all().map((x) => x.before_json).join('\n');
  ok('10-6 ★改訂の控えにヒアリングの自由文が入らない（選択肢と数値だけ）', revs.includes('"motivation":7') && !revs.includes('ウォーキング') && !revs.includes('6時間'), revs.slice(0, 300));

  //   痛みの身体図（健康情報）
  const PM = [{ region: 'lower_back', level: 4, symptom: '朝が強い' }, { region: 'shoulder_r', level: 6, symptom: '腕を上げると違和感' }];
  const s0 = await call('U_T1', 'k_saveSafety', { customerId: 'C4', rev: 0, painMap: PM, clientReqId: crid() });
  ok('10-7 ★同意が無いと痛みの身体図は書けない', s0.status === 403 && s0.code === 'NO_CONSENT' && !q1(env, `SELECT 1 AS x FROM karte_safety WHERE customer_id = 'C4'`));
  await call('U_T1', 'k_saveConsent', { customerId: 'C4', state: 'agreed', method: 'paper', clientReqId: crid() });
  const s1 = await call('U_T1', 'k_saveSafety', { customerId: 'C4', rev: 0, painMap: PM, diagnosis: 'なし', restrictions: '肩より上の挙上を避ける', clientReqId: crid() });
  const sr = q1(env, `SELECT pain_json, diagnosis FROM karte_safety WHERE customer_id = 'C4'`);
  ok('10-8 同意があれば書ける・部位は固定表の順', s1.success && JSON.parse(sr.pain_json).map((x) => x.region).join(',') === 'shoulder_r,lower_back', JSON.stringify(sr));
  const s2 = await call('U_T1', 'k_saveSafety', { customerId: 'C4', rev: 1, medication: 'なし', clientReqId: crid() });
  ok('10-9 ★painMap・diagnosis の鍵が無い保存では消さない', s2.success && q1(env, `SELECT pain_json FROM karte_safety WHERE customer_id = 'C4'`).pain_json === sr.pain_json);
  const pbad = [[{ region: 'knee_r', level: 0 }], [{ region: 'knee_r', level: 3 }, { region: 'knee_r', level: 4 }], [{ region: 'x', level: 3 }],
                [{ region: 'knee_r', level: 3, note: 'x' }], [{ region: 'knee_r', level: '3' }], { region: 'knee_r' }];
  let pAll = true, pw = '';
  for (const pb of pbad) {
    const r = await call('U_T1', 'k_saveSafety', { customerId: 'C4', rev: 2, painMap: pb, clientReqId: crid() });
    if (r.status !== 400) { pAll = false; pw = JSON.stringify(pb) + ' → ' + r.status; break; }
  }
  ok('10-10 ★痛みの不正（強さ0・部位の重複・知らない部位・余計な鍵・文字の強さ・配列でない）は 400', pAll, pw);
  const sm = await call('U_T2', 'k_summary', { customerId: 'C4' });
  ok('10-11b 概要・メモ・安全面に窓口の版（31）', sm.karteSchema === 31);
  ok('10-11 概要に痛み・診断・服薬・ヒアリング（同意があるとき・トレーナー全員）', sm.success && sm.safetyBrief && sm.safetyBrief.pain.length === 2
     && sm.safetyBrief.diagnosis === 'なし' && sm.profile.hearing && sm.profile.hearing.motivation === 7 && !('hearing_json' in sm.profile), JSON.stringify(sm.safetyBrief));
  //   一覧の印（担当 T1）
  const bd = await call('U_T1', 'k_board', {});
  const f4 = (bd.customers || []).find((x) => x.customerId === 'C4').flags;
  ok('10-12 ★一覧：注意あり（真偽だけ）・ヒアリング済み・同意済み', f4.caution === true && f4.hearingMissing === false && f4.consentPending === false
     && !JSON.stringify(bd).includes('shoulder') && !JSON.stringify(bd).includes('違和感'), JSON.stringify(f4));
  const f1 = (bd.customers || []).find((x) => x.customerId === 'C1').flags;
  ok('10-13 一覧：未記入・同意待ちの印', f1.hearingMissing === true && typeof f1.consentPending === 'boolean', JSON.stringify(f1));
  //   撤回で痛みも消え、一覧の注意も消える
  await call('U_T1', 'k_saveConsent', { customerId: 'C4', state: 'revoked', clientReqId: crid() });
  const bd2 = await call('U_T1', 'k_board', {});
  ok('10-14 ★撤回で痛み・診断ごと消え、注意ありも消える', !q1(env, `SELECT 1 AS x FROM karte_safety WHERE customer_id = 'C4'`)
     && (bd2.customers || []).find((x) => x.customerId === 'C4').flags.caution === false);
  //   同意の撤回後に安全面を残したまま同意行だけ戻しても、注意ありは同意の JOIN の中で決まる
  d.exec(`INSERT INTO karte_safety (customer_id, pain_json, rev, updated_by, updated_at) VALUES ('C4', '[{"region":"neck","level":2,"symptom":null}]', 1, 'T1', 1)`);
  const bd3 = await call('U_T1', 'k_board', {});
  ok('10-15 ★同意が agreed でなければ、行があっても注意ありにしない', (bd3.customers || []).find((x) => x.customerId === 'C4').flags.caution === false);
  d.exec(`DELETE FROM karte_safety WHERE customer_id = 'C4'`);

  //   指導の履歴
  const n1 = await call('U_T1', 'k_addNote', { customerId: 'C4', sessionDate: today, tag: 'body', reasons: ['self_training_up', 'snack_down'], nextCheck: '夕食のタンパク質', nextPlan: '月-1kg', clientReqId: crid() });
  ok('10-16 タグ・理由・次回確かめることだけでも保存できる', n1.success, JSON.stringify(n1));
  const nl = await call('U_T2', 'k_notes', { customerId: 'C4' });
  const nn = (nl.notes || [])[0] || {};
  const sf = await call('U_T1', 'k_safety', { customerId: 'C4' });
  ok('10-17b メモ・安全面の応答にも窓口の版（31）', nl.karteSchema === 31 && sf.karteSchema === 31);
  ok('10-17 ★理由は固定表の順で返す・生の JSON 列は返さない', nn.tag === 'body' && JSON.stringify(nn.reasons) === '["snack_down","self_training_up"]' && nn.next_check === '夕食のタンパク質' && !('reasons_json' in nn), JSON.stringify(nn));
  const nb = await call('U_T1', 'k_addNote', { customerId: 'C4', sessionDate: today, reasons: ['medication_changed'], clientReqId: crid() });
  ok('10-18 ★健康の理由（固定表に無い）は 400', nb.status === 400);
  const nt = await call('U_T1', 'k_addNote', { customerId: 'C4', sessionDate: today, tag: 'health', body: 'x', clientReqId: crid() });
  ok('10-19 知らないタグは 400', nt.status === 400);
  //   古い画面の編集でタグ・理由を消さない
  const ed = await call('U_T1', 'k_editNote', { noteId: n1.noteId, rev: 1, body: '追記', nextPlan: '月-1kg', clientReqId: crid() });
  const er = q1(env, `SELECT tag, reasons_json, next_check, body FROM karte_notes WHERE note_id = ?`, n1.noteId);
  ok('10-20 ★鍵が無い編集ではタグ・理由・次回確かめることを消さない', ed.success && er.tag === 'body' && er.reasons_json && er.next_check === '夕食のタンパク質' && er.body === '追記', JSON.stringify(er));
  const nrev = d.prepare(`SELECT before_json FROM karte_revisions WHERE table_name = 'karte_notes' AND row_id = ?`).all(n1.noteId).map((x) => x.before_json).join('');
  ok('10-21 編集の控えにタグ・理由も残る', nrev.includes('"tag":"body"') && nrev.includes('snack_down'), nrev);
  //   DB の CHECK（Worker を通らない書き込みでも、知らないタグは入らない）
  let threw = false; try { d.exec(`UPDATE karte_notes SET tag = 'health' WHERE note_id = '${n1.noteId}'`); } catch (_) { threw = true; }
  ok('10-22 ★表の CHECK が知らないタグを弾く', threw);

  //   本文16KB：全項目を最大にした正規の要求が収まる
  const big = { purposes: ['diet', 'bodymake', 'strength', 'posture', 'condition', 'stamina', 'health', 'sports'], slimAreas: ['face', 'arm', 'chest'],
                motivation: 10, targetWeight: 250, targetFat: 60, exerciseNow: '漢'.repeat(100), exercisePast: '漢'.repeat(100), sleep: '漢'.repeat(100), meals: '漢'.repeat(100) };
  const bigReq = JSON.stringify({ action: 'k_saveProfile', idToken: 'x'.repeat(1200), customerId: 'C4', rev: 9, clientReqId: 'k'.repeat(64),
    goalText: '漢'.repeat(500), goalDeadline: '2027-03-31', goalValue: 999, goalUnit: '漢'.repeat(20), motive: '漢'.repeat(500), history: '漢'.repeat(500), hearing: big });
  const bigPain = JSON.stringify({ action: 'k_saveSafety', idToken: 'x'.repeat(1200), customerId: 'C4', rev: 9, clientReqId: 'k'.repeat(64),
    conditions: '漢'.repeat(500), injuries: '漢'.repeat(500), painSites: '漢'.repeat(500), medication: '漢'.repeat(500), restrictions: '漢'.repeat(500), diagnosis: '漢'.repeat(500),
    painMap: Array.from({ length: 12 }, (_, i) => ({ region: ['neck', 'shoulder_r', 'shoulder_l', 'upper_back', 'lower_back', 'elbow_r', 'elbow_l', 'wrist_r', 'wrist_l', 'hip_r', 'hip_l', 'knee_r'][i], level: 10, symptom: '漢'.repeat(80) })) });
  ok('10-23 ★最大の正規の要求が本文16KB以内（UTF-8 のバイト数）', Buffer.byteLength(bigReq) <= 16384 && Buffer.byteLength(bigPain) <= 16384, `${Buffer.byteLength(bigReq)} / ${Buffer.byteLength(bigPain)}`);
}

// ================= 9. 日付の道具 =================
ok('9-1 実在しない日付を繰り上げで受けない', !isRealDate('2026-13-01') && !isRealDate('2026-02-30') && isRealDate('2028-02-29') && !isRealDate('2027-02-29'));
ok('9-2 今日以前（JST）', isPastOrToday(today) && !isPastOrToday(dayOffset(1)));

console.log(`\n${fail ? '❌' : '✅'} 顧客カルテ（入口から） 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
