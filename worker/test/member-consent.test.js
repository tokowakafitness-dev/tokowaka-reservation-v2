// 設計44 会員画面の同意（m_myConsent・m_saveConsent）と、AI 振り分けの同意の関門：本物の SQLite に全 migration を流し、入口（index.js）から通す・2026-11-13
//   実行: node worker/test/member-consent.test.js
//
//   ★身代わりは fetch（Anthropic API）だけ。同意の無い会員で呼ばれないことを確かめる
//   ★会員・トレーナーは架空（甲野一郎・乙川二郎 等）。customer_id は C1〜C5

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';
import { isAllowed } from '../src/perms.js';
import { CONSENT_DOCS, CONSENT_VALID_REC } from '../src/lib/consent-docs.js';
import { buildKarteAiHealth } from '../src/lib/karte-ai-health.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const W = join(HERE, '..');
const ROOT = join(W, '..');
const ORIGIN = 'https://reservation.tokowaka-gym.com';
const CHANNEL = '1234567890';
const HV = CONSENT_DOCS.health.ver, RV = CONSENT_DOCS.rec_ai.ver;

let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) pass++; else { fail++; console.log(`❌ ${name}${detail ? '\n   ' + detail : ''}`); } }

// ---------------- D1（実物の SQLite・全 migration）----------------
const db = new DatabaseSync(':memory:');
db.exec(readFileSync(join(W, 'schema.sql'), 'utf8'));
for (const f of readdirSync(join(W, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
  try { db.exec(readFileSync(join(W, 'migrations', f), 'utf8')); } catch (e) { if (!/duplicate column/.test(e.message)) throw e; }
}
let dbFail = null;   // この文字列を含む SQL で例外
const exec = (q, args, how) => {
  if (dbFail && q.indexOf(dbFail) >= 0) throw new Error('D1 down');
  const st = db.prepare(q);
  if (how === 'first') { const r = st.get(...args); return r === undefined ? null : Object.assign({}, r); }
  if (how === 'all') return { results: st.all(...args).map((r) => Object.assign({}, r)) };
  const r = st.run(...args);
  return { meta: { changes: Number(r.changes) } };
};
const env = { LINE_CHANNEL_ID: CHANNEL, _kv: {} };
env.KV = { async get(k, t) { const v = env._kv[k]; return v == null ? null : (t === 'json' ? JSON.parse(v) : v); }, async put(k, v) { env._kv[k] = v; } };
env.DB = {
  prepare(q) { return { _q: q, _args: [], bind(...a) { this._args = a; return this; }, async run() { return exec(q, this._args, 'run'); }, async first() { return exec(q, this._args, 'first'); }, async all() { return exec(q, this._args, 'all'); } }; },
  async batch(stmts) { db.exec('BEGIN'); try { const o = stmts.map((s) => exec(s._q, s._args, 'run')); db.exec('COMMIT'); return o; } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; } },
};
const q1 = (sql, ...a) => { const r = db.prepare(sql).get(...a); return r ? Object.assign({}, r) : null; };
const qa = (sql, ...a) => db.prepare(sql).all(...a).map((r) => Object.assign({}, r));

// ---------------- トークン ----------------
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
env._kv['jwks:line'] = JSON.stringify({ keys: [{ ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'k1', alg: 'ES256' }] });
async function token(sub, iatAge = 0) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: 'ES256', kid: 'k1', typ: 'JWT' }));
  const pl = b64u(JSON.stringify({ iss: 'https://access.line.me', aud: CHANNEL, sub, exp: now + 3600, iat: now - iatAge }));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(h + '.' + pl));
  return h + '.' + pl + '.' + b64u(sig);
}

// ---------------- 見本（架空）----------------
db.exec(`INSERT INTO trainers (trainer_id, name, line_user_id, role, active) VALUES ('A', '乙川 二郎', 'U_TA', 'owner', 1), ('T2', '丁村 三郎', 'U_T2', 'trainer', 1)`);
const custs = [['C1', 'A'], ['C2', 'T2'], ['C3', 'A'], ['C4', 'A'], ['C5', '']];
for (const [id, t] of custs) db.exec(`INSERT INTO customers (customer_id, name, kana, line_user_id, default_trainer_id, created_at, updated_at) VALUES ('${id}', '甲野 一郎', 'コウノ イチロウ', 'U_${id}', '${t}', 1, 1)`);
const now0 = Date.now();
db.exec(`INSERT INTO sync_state (key, synced_at, rows, ok) VALUES ('customers', ${now0}, 5, 1), ('trainers', ${now0}, 2, 1), ('reservations', ${now0}, 0, 1)`);
const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
for (const [id] of custs) db.prepare(`INSERT INTO member_home (customer_id, payload, computed_at) VALUES (?, ?, ?)`).run(id, JSON.stringify({ currentMonth: today.slice(0, 7), current: { type: null } }), Date.now());

// ---------------- Anthropic の身代わり ----------------
const calls = [];
globalThis.fetch = async (url, opt) => {
  calls.push(String(url));
  return { status: 200, json: async () => ({ stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: JSON.stringify({ exercises: [], coaching: [], hearing: [], caution: [], member_message: '', member_todo: [] }) }] }) };
};
// ---------------- console ----------------
const logs = [];
const origErr = console.error;
console.error = (...a) => logs.push(a.map(String).join(' '));

async function call(sub, action, body = {}, o = {}) {
  const tok = await token(sub, o.iatAge || 0);
  const headers = { 'Content-Type': 'application/json' };
  if (o.origin !== null) headers.Origin = o.origin || ORIGIN;
  const path = action === 'k_aiDraft' ? '/karte/ai-draft' : '/';
  const res = await worker.fetch(new Request('https://w.example' + path, { method: 'POST', headers, body: JSON.stringify({ action, idToken: tok, ...body }) }), env, { waitUntil() {} });
  const raw = await res.text();
  let j = {}; try { j = JSON.parse(raw); } catch (_) {}
  return { status: res.status, raw, ...j };
}
const setMode = (m, list) => { env.MEMBER_CONSENT = m; env.MEMBER_CONSENT_TRAINERS = list || ''; };
const save = (sub, answers, vers, o) => call(sub, 'm_saveConsent', { answers, vers: vers || Object.fromEntries(Object.keys(answers).map((k) => [k, CONSENT_DOCS[k].ver])) }, o);
const counts = () => ({ c: q1('SELECT COUNT(*) n FROM karte_consent').n, r: q1('SELECT COUNT(*) n FROM karte_consent_rec').n,
                        l: q1('SELECT COUNT(*) n FROM karte_consent_log').n, a: q1('SELECT COUNT(*) n FROM karte_consent_answers').n });
const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);

// ================= A 許可表・入口 =================
{
  ok('A1 許可表：m_myConsent・m_saveConsent は customer だけ', isAllowed('m_myConsent', 'customer') && isAllowed('m_saveConsent', 'customer')
     && !isAllowed('m_myConsent', 'trainer') && !isAllowed('m_saveConsent', 'owner') && !isAllowed('m_saveConsent', 'guest'));
  setMode('on');
  const tr = await call('U_TA', 'm_myConsent');
  ok('A2 トレーナー（オーナー）は 403', tr.status === 403);
  const noOrigin = await save('U_C1', { health: 'agreed' }, null, { origin: null });
  const badOrigin = await save('U_C1', { health: 'agreed' }, null, { origin: 'https://evil.example' });
  ok('A3 ★m_saveConsent：Origin 欠落・不一致は 403・何も書かない', noOrigin.status === 403 && badOrigin.status === 403 && counts().c === 0, JSON.stringify([noOrigin.status, badOrigin.status]));
  const stale = await save('U_C1', { health: 'agreed' }, null, { iatAge: 3700 });
  ok('A4 ★m_saveConsent：iat が1時間より古いと 401 STALE_TOKEN', stale.status === 401 && stale.detail === 'STALE_TOKEN');
  const readNoOrigin = await call('U_C1', 'm_myConsent', {}, { origin: null });
  ok('A5 m_myConsent（読み取り）は Origin を要求しない', readNoOrigin.status === 200, readNoOrigin.raw);
  //   役割の写しが古い → 503（FALLBACK にしない）
  db.exec(`UPDATE sync_state SET synced_at = 1 WHERE key = 'customers'`);
  const rs1 = await call('U_C1', 'm_myConsent'); const rs2 = await save('U_C1', { health: 'agreed' });
  db.exec(`UPDATE sync_state SET synced_at = ${Date.now()} WHERE key = 'customers'`);
  ok('A6 ★役割の写しが古いと m_ は 503 ROLES_STALE（FALLBACK ではない）', rs1.status === 503 && rs1.code === 'ROLES_STALE' && rs2.status === 503 && rs2.code !== 'FALLBACK', JSON.stringify([rs1.status, rs1.code, rs2.code]));
  env.EDGE_READS = 'off';
  const er = await call('U_C1', 'm_myConsent');
  delete env.EDGE_READS;
  ok('A7 ★EDGE_READS=off でも m_ は FALLBACK にならない', er.status === 200 && er.code !== 'FALLBACK');
  //   body の customerId で他人を指せない（入口が customer の他人指定を403・窓口は body を読まない）
  const other = await call('U_C1', 'm_myConsent', { customerId: 'C2' });
  ok('A8 body の customerId で他人を指すと 403', other.status === 403);
  //   共通の catch で m_ の message を出さない
  logs.length = 0; dbFail = 'FROM customers WHERE customer_id';
  const ex = await call('U_C1', 'm_myConsent');
  dbFail = null;
  ok('A9 ★読めないときは 503 CONSENT_UNAVAILABLE・console に ID も message も無い', ex.status === 503 && !logs.join('\n').includes('C1') && !logs.join('\n').includes('D1 down'), ex.raw + ' / ' + logs.join(' | '));
}

// ================= B 切替（勧誘と新しい同意にだけ効く）=================
{
  setMode('off');
  const r = await call('U_C1', 'm_myConsent');
  ok('B1 off：同意の記録が無い会員は 503 MEMBER_CONSENT_OFF（文面を返さない）', r.status === 503 && r.code === 'MEMBER_CONSENT_OFF' && !r.raw.includes('Anthropic'));
  const s = await save('U_C1', { health: 'agreed' });
  ok('B2 off：新しい同意は 503・何も書かない', s.status === 503 && counts().c === 0);
  setMode('allow', 'A');
  const a1 = await call('U_C1', 'm_myConsent'); const a2 = await call('U_C2', 'm_myConsent'); const a5 = await call('U_C5', 'm_myConsent');
  ok('B3 allow：担当が一覧にある会員だけ full。担当違い・担当なしは 503', a1.status === 200 && a1.mode === 'full' && a2.status === 503 && a5.status === 503, JSON.stringify([a1.status, a2.status, a5.status]));
  setMode('allow', ' A , X ');
  ok('B4 allow：一覧の空白は無視・完全一致', (await call('U_C1', 'm_myConsent')).mode === 'full');
  setMode('Allow', 'A');
  ok('B5 打ち間違い（Allow）は off', (await call('U_C1', 'm_myConsent')).status === 503);
}

// ================= C 文面・ask の規則 =================
{
  setMode('on');
  const r = await call('U_C1', 'm_myConsent');
  ok('C1 文面は2つ・版つき・本文は consent-docs のまま', r.docs.length === 2 && r.docs[0].ver === HV && r.docs[1].ver === RV && same(r.docs[1].paragraphs, CONSENT_DOCS.rec_ai.paragraphs));
  ok('C2 記録の無い会員は両方を ask', same(r.ask, ['health', 'rec_ai']) && r.state.health.state === 'none' && r.state.rec_ai.state === 'none');
  //   紙で同意済み（版なし）→ health は出さない
  db.exec(`INSERT INTO karte_consent (customer_id, kind, state, changed_at, method, recorded_by) VALUES ('C3', 'health', 'agreed', 1, 'paper', 'A')`);
  const r3 = await call('U_C3', 'm_myConsent');
  ok('C3 紙で同意済みの健康情報は ask に入らない（有効）', same(r3.ask, ['rec_ai']) && r3.state.health.current === true && r3.state.health.byMember === false);
  //   撤回済みは出さない
  db.exec(`INSERT INTO karte_consent (customer_id, kind, state, changed_at, method, recorded_by) VALUES ('C4', 'health', 'revoked', 1, NULL, 'A')`);
  const r4 = await call('U_C4', 'm_myConsent');
  ok('C4 撤回済みは ask に入らない', same(r4.ask, ['rec_ai']));
  ok('C5 応答に LINE の ID・氏名・trainer_id を出さない', !r.raw.includes('U_C1') && !r.raw.includes('甲野') && !/"recorded_by"|"A"/.test(r.raw));
}

// ================= D 保存 =================
{
  setMode('on');
  const before = counts();
  const s1 = await save('U_C1', { health: 'agreed', rec_ai: 'declined' });
  const c1 = q1(`SELECT state, method, recorded_by FROM karte_consent WHERE customer_id = 'C1'`);
  ok('D1 health agreed → karte_consent（line・@member）＋ log ＋ 回答（版）。rec_ai declined は回答だけ', s1.status === 200 && c1.state === 'agreed' && c1.method === 'line' && c1.recorded_by === '@member'
     && !q1(`SELECT 1 x FROM karte_consent_rec WHERE customer_id = 'C1'`)
     && same(qa(`SELECT kind, answer, doc_ver FROM karte_consent_answers WHERE customer_id = 'C1' ORDER BY id`), [{ kind: 'health', answer: 'agreed', doc_ver: HV }, { kind: 'rec_ai', answer: 'declined', doc_ver: RV }])
     && counts().l === before.l + 1, s1.raw);
  ok('D2 保存後の ask は空（declined はこの版ではもう出さない）・health は会員の最新の版', same(s1.ask, []) && s1.state.health.byMember === true && s1.state.health.current === true);
  const at1 = q1(`SELECT changed_at FROM karte_consent WHERE customer_id = 'C1'`).changed_at;
  const c0 = counts();
  const s2 = await save('U_C1', { health: 'agreed', rec_ai: 'declined' });
  ok('D3 ★再送は状態・log・回答に何も書かない（最初の時刻が残る）', s2.status === 200 && same(counts(), c0) && q1(`SELECT changed_at FROM karte_consent WHERE customer_id = 'C1'`).changed_at === at1);
  ok('D4 再送でも監査（access_log）には残る・中身は無い', q1(`SELECT COUNT(*) n FROM karte_access_log WHERE action = 'm_saveConsent' AND customer_id = 'C1' AND result = 'ok'`).n >= 2
     && qa(`SELECT * FROM karte_access_log WHERE action = 'm_saveConsent'`).every((x) => x.section === 'consent' && x.role === 'customer' && x.trainer_id === null && x.req_id === null));
  //   health の declined の再送も何も書かない（C2：健康情報の記録なし）
  await save('U_C2', { health: 'declined' });
  const cd = counts();
  const sd = await save('U_C2', { health: 'declined' });
  ok('D3b ★health の declined の再送は回答に何も書かない', sd.status === 200 && same(counts(), cd) && q1(`SELECT COUNT(*) n FROM karte_consent_answers WHERE customer_id = 'C2' AND kind = 'health'`).n === 1);
  //   declined は同意済みの状態を変えない
  const s3 = await save('U_C3', { health: 'declined' });
  ok('D5 ★declined は紙の同意（agreed）を変えない', s3.status === 200 && q1(`SELECT state FROM karte_consent WHERE customer_id = 'C3'`).state === 'agreed');
  //   紙の agreed → 会員の agreed は版つきに置き換える
  const s4 = await save('U_C3', { health: 'agreed' });
  ok('D6 紙で同意済みに会員が同意すると、版つきの会員の記録に置き換わる', s4.status === 200 && q1(`SELECT recorded_by FROM karte_consent WHERE customer_id = 'C3'`).recorded_by === '@member');
  //   health の revoked は受けない
  const c5 = counts();
  const s5 = await save('U_C1', { health: 'revoked' });
  ok('D7 ★会員画面から健康情報の撤回は 400・何も書かない（健康情報を消さない）', s5.status === 400 && same(counts(), c5) && q1(`SELECT state FROM karte_consent WHERE customer_id = 'C1'`).state === 'agreed');
  //   版の違い
  const s6 = await save('U_C2', { rec_ai: 'agreed' }, { rec_ai: 'rec_ai-1999-01-01' });
  ok('D8 版が現行と違うと 409 DOC_CHANGED・何も書かない', s6.status === 409 && s6.code === 'DOC_CHANGED' && same(counts(), c5));
  //   知らない鍵・値
  const bad = [
    await call('U_C1', 'm_saveConsent', { answers: { health: 'agreed' }, vers: { health: HV }, customerId: 'C1' }),
    await call('U_C1', 'm_saveConsent', { answers: { photo: 'agreed' }, vers: { photo: 'x' } }),
    await call('U_C1', 'm_saveConsent', { answers: {}, vers: {} }),
    await call('U_C1', 'm_saveConsent', { answers: { rec_ai: 'agreed' }, vers: {} }),
    await call('U_C1', 'm_saveConsent', { answers: { rec_ai: 'yes' }, vers: { rec_ai: RV } }),
    await call('U_C1', 'm_saveConsent', { answers: { rec_ai: 'agreed' }, vers: { rec_ai: RV, health: HV } }),
    await call('U_C1', 'm_saveConsent', { answers: [], vers: {} }),
  ];
  ok('D9 知らない鍵（customerId 含む）・知らない kind・空・版なし・知らない値・余分な版・配列は 400 か 403', bad.every((x) => x.status === 400 || x.status === 403) && same(counts(), c5), JSON.stringify(bad.map((x) => x.status)));
  //   rec_ai：同意 → 撤回（再送）→ 同意したことの無い人の撤回
  const r1 = await save('U_C1', { rec_ai: 'agreed' });
  const row = q1(`SELECT state, doc_ver, recorded_by FROM karte_consent_rec WHERE customer_id = 'C1'`);
  ok('D10 rec_ai agreed → karte_consent_rec（版つき）＋ log', r1.status === 200 && row.state === 'agreed' && row.doc_ver === RV && row.recorded_by === '@member' && r1.state.rec_ai.current === true);
  const r2 = await save('U_C1', { rec_ai: 'revoked' });
  const r2b = await save('U_C1', { rec_ai: 'revoked' });
  ok('D11 rec_ai revoked → revoked。再送は何も書かない', r2.status === 200 && q1(`SELECT state FROM karte_consent_rec WHERE customer_id = 'C1'`).state === 'revoked' && r2b.status === 200
     && q1(`SELECT COUNT(*) n FROM karte_consent_answers WHERE customer_id = 'C1' AND answer = 'revoked'`).n === 1);
  const c7 = counts();
  const r3 = await save('U_C2', { rec_ai: 'revoked' });
  ok('D12 ★同意したことの無い人の撤回は 409 CONFLICT・何も書かない', r3.status === 409 && r3.code === 'CONFLICT' && same(counts(), c7), r3.raw);
  //   回数の守り
  db.exec(`DELETE FROM karte_consent_answers WHERE customer_id = 'C5'`);
  for (let i = 0; i < 20; i++) db.prepare(`INSERT INTO karte_consent_answers (customer_id, kind, answer, doc_ver, at) VALUES ('C5', 'rec_ai', 'declined', 'old', ?)`).run(Date.now());
  const rl = await save('U_C5', { health: 'agreed' });
  ok('D13 直近10分の回答が20行を超えるなら 429・何も書かない', rl.status === 429 && !q1(`SELECT 1 x FROM karte_consent WHERE customer_id = 'C5'`));
  db.exec(`DELETE FROM karte_consent_answers WHERE customer_id = 'C5'`);
  //   ★並行した送信でも上限を超えない（判定と書き込みが同じ batch・関門② 中）
  for (let i = 0; i < 19; i++) db.prepare(`INSERT INTO karte_consent_answers (customer_id, kind, answer, doc_ver, at) VALUES ('C5', 'rec_ai', 'declined', 'old', ?)`).run(Date.now());
  const par = await Promise.all([save('U_C5', { health: 'declined' }), save('U_C5', { rec_ai: 'declined' }), save('U_C5', { health: 'agreed' })]);
  const nAfter = q1(`SELECT COUNT(*) n FROM karte_consent_answers WHERE customer_id = 'C5'`).n;
  ok('D13b ★並行した3つの送信でも直近10分の回答は20行を超えない（超える送信は 429）', nAfter <= 20 && par.some((x) => x.status === 429), JSON.stringify([nAfter, par.map((x) => x.status)]));
  db.exec(`DELETE FROM karte_consent_answers WHERE customer_id = 'C5'`); db.exec(`DELETE FROM karte_consent WHERE customer_id = 'C5'`);
  //   CHECK：rec に declined は入らない／answers の kind・answer
  const throws = (f) => { try { f(); return false; } catch (_) { return true; } };
  ok('D14 CHECK：karte_consent_rec に declined は入らない・answers に知らない kind/answer は入らない',
     throws(() => db.exec(`INSERT INTO karte_consent_rec (customer_id, state, changed_at, recorded_by) VALUES ('Z', 'declined', 1, 'x')`))
     && throws(() => db.exec(`INSERT INTO karte_consent_answers (customer_id, kind, answer, doc_ver, at) VALUES ('Z', 'photo', 'agreed', 'v', 1)`))
     && throws(() => db.exec(`INSERT INTO karte_consent_answers (customer_id, kind, answer, doc_ver, at) VALUES ('Z', 'health', 'maybe', 'v', 1)`)));
}

// ================= D2 健康情報の会員の版（回答を件数で切らない・関門② 中）=================
{
  setMode('on');
  //   C4 の health を会員の古い版の同意にする（回答は200件より多く、最新の health agreed は古い版）
  db.exec(`DELETE FROM karte_consent WHERE customer_id = 'C4'`);
  db.exec(`INSERT INTO karte_consent (customer_id, kind, state, changed_at, method, recorded_by) VALUES ('C4', 'health', 'agreed', 1, 'line', '@member')`);
  db.prepare(`INSERT INTO karte_consent_answers (customer_id, kind, answer, doc_ver, at) VALUES ('C4', 'health', 'agreed', 'health-1999-01-01', 1)`).run();
  for (let i = 0; i < 250; i++) db.prepare(`INSERT INTO karte_consent_answers (customer_id, kind, answer, doc_ver, at) VALUES ('C4', 'rec_ai', 'declined', 'rec-old', ?)`).run(100 + i);
  const r = await call('U_C4', 'm_myConsent');
  ok('D2-1 ★会員の古い版の同意は、回答が200件を超えても「最新でない」＝ask に入る（紙と取り違えない）', r.status === 200 && r.state.health.current === false && r.ask.includes('health'), r.raw.slice(0, 300));
  const s = await save('U_C4', { health: 'agreed' });
  ok('D2-2 古い版に同意している会員の再同意は書く（再送とみなさない）', s.status === 200 && q1(`SELECT doc_ver FROM karte_consent_answers WHERE customer_id = 'C4' AND kind = 'health' ORDER BY id DESC LIMIT 1`).doc_ver === HV && s.state.health.current === true);
  //   会員の記録なのに回答が無い（不整合）→ 最新とみなさない
  db.exec(`DELETE FROM karte_consent_answers WHERE customer_id = 'C4'`);
  const r2 = await call('U_C4', 'm_myConsent');
  ok('D2-3 会員の記録なのに対応する回答が無ければ「最新でない」', r2.state.health.current === false);
  db.exec(`DELETE FROM karte_consent WHERE customer_id = 'C4'`); db.exec(`DELETE FROM karte_consent_answers WHERE customer_id = 'C4'`);
}

// ================= E 切替が閉じていても録音・AI の撤回はできる =================
{
  setMode('on');
  await save('U_C4', { rec_ai: 'agreed' });
  setMode('off');
  const r = await call('U_C4', 'm_myConsent');
  ok('E1 ★off でも録音・AI に同意している本人には revoke_only（rec_ai の文面と状態だけ・ask は空）', r.status === 200 && r.mode === 'revoke_only' && r.docs.length === 1 && r.docs[0].kind === 'rec_ai'
     && same(r.ask, []) && !r.state.health, r.raw);
  const s1 = await save('U_C4', { rec_ai: 'agreed' });
  const s2 = await save('U_C4', { health: 'agreed', rec_ai: 'revoked' });
  ok('E2 off：同意・declined・他の kind を混ぜた送信は 503', s1.status === 503 && s2.status === 503 && q1(`SELECT state FROM karte_consent_rec WHERE customer_id = 'C4'`).state === 'agreed');
  const s3 = await save('U_C4', { rec_ai: 'revoked' });
  ok('E3 ★off：rec_ai の撤回は受ける', s3.status === 200 && s3.mode === 'revoke_only' && q1(`SELECT state FROM karte_consent_rec WHERE customer_id = 'C4'`).state === 'revoked');
  const r2 = await call('U_C4', 'm_myConsent');
  ok('E4 撤回した後は off なら 503（もう勧誘しない）', r2.status === 503);
}

// ================= F 起動の印（compatMemberStatus・c_boot）=================
{
  setMode('on');
  const on = await call('U_C2', 'c_memberStatus');
  ok('F1 on：memberConsent=true（真偽値）', on.status === 200 && on.memberConsent === true, on.raw.slice(0, 200));
  setMode('allow', 'A');
  ok('F2 allow：担当が一覧にある会員は true・担当違いで同意なしは false', (await call('U_C3', 'c_memberStatus')).memberConsent === true && (await call('U_C2', 'c_memberStatus')).memberConsent === false);
  setMode('off');
  db.exec(`INSERT OR REPLACE INTO karte_consent_rec (customer_id, state, changed_at, method, recorded_by, doc_ver) VALUES ('C2', 'agreed', 1, 'line', '@member', '${RV}')`);
  ok('F3 ★off：録音・AI に同意している本人は true（撤回の入口）', (await call('U_C2', 'c_memberStatus')).memberConsent === true);
  dbFail = 'FROM karte_consent_rec WHERE customer_id';
  const u = await call('U_C2', 'c_memberStatus');
  const ub = await call('U_C2', 'c_boot');
  dbFail = null;
  ok('F4 ★同意の表が読めなければ "unknown"（偽に潰さない）・起動そのものは落とさない', u.status === 200 && u.verified === true && u.memberConsent === 'unknown', u.raw.slice(0, 200));
  ok('F5 c_boot の memberStatus にも乗る', ub.status === 200 && ub.parts && ub.parts.memberStatus && ub.parts.memberStatus.memberConsent === 'unknown', ub.raw.slice(0, 200));
  db.exec(`DELETE FROM karte_consent_rec WHERE customer_id = 'C2'`);
}

// ================= G AI 振り分けの同意の関門（k_aiDraft・I76-8）=================
{
  Object.assign(env, { KARTE_AI_DRAFT: 'allow', KARTE_AI_DRAFT_TRAINERS: 'A', ANTHROPIC_API_KEY: 'TEST-KEY-NOT-REAL' });
  const usage = () => { const r = q1('SELECT SUM(n) AS n FROM karte_ai_usage'); return r && r.n ? r.n : 0; };
  const send = (cid) => call('U_TA', 'k_aiDraft', { customerId: cid, text: '20キロで10回', known: [] });
  const n0 = calls.length, u0 = usage(), l0 = q1('SELECT COUNT(*) n FROM karte_ai_log').n;
  db.exec(`DELETE FROM karte_consent_rec WHERE customer_id IN ('C2','C3','C5')`);
  const none = await send('C5');
  db.exec(`INSERT INTO karte_consent_rec (customer_id, state, changed_at, method, recorded_by, doc_ver) VALUES ('C2', 'revoked', 1, 'line', '@member', '${RV}')`);
  const rev = await send('C2');
  db.exec(`INSERT INTO karte_consent_rec (customer_id, state, changed_at, method, recorded_by, doc_ver) VALUES ('C3', 'agreed', 1, 'line', '@member', 'rec_ai-1999-01-01')`);
  const old = await send('C3');
  ok('G1 ★同意なし・撤回・古い版は 403 NO_CONSENT・Anthropic を呼ばない・回数を数えない', [none, rev, old].every((x) => x.status === 403 && x.code === 'NO_CONSENT') && calls.length === n0 && usage() === u0, JSON.stringify([none.status, rev.status, old.status, calls.length - n0]));
  ok('G2 同意の2つは karte_ai_log に書かず（CHECK に無い）access_log に no_consent', q1('SELECT COUNT(*) n FROM karte_ai_log').n === l0
     && q1(`SELECT COUNT(*) n FROM karte_access_log WHERE action = 'k_aiDraft' AND result = 'no_consent'`).n === 3);
  dbFail = 'FROM karte_consent_rec WHERE customer_id';
  const err = await send('C4');
  dbFail = null;
  ok('G3 ★同意の表が読めなければ 503 AI_UNAVAILABLE（CONSENT）・呼ばない・数えない', err.status === 503 && err.code === 'AI_UNAVAILABLE' && err.detail === 'CONSENT' && calls.length === n0 && usage() === u0);
  //   同意あり → 送る
  db.exec(`UPDATE karte_consent_rec SET state = 'agreed', doc_ver = '${RV}' WHERE customer_id = 'C3'`);
  const yes = await send('C3');
  ok('G4 同意（有効な版）があれば今どおり送る', yes.status === 200 && calls.length === n0 + 1 && usage() === u0 + 1, yes.raw.slice(0, 200));
  //   トレーニングを読んだ後に撤回 → 古い画面から送っても止まる
  const tr = await call('U_TA', 'k_training', { customerId: 'C3' });
  await call('U_C3', 'm_myConsent');
  setMode('on'); await save('U_C3', { rec_ai: 'revoked' });
  const stale = await send('C3');
  ok('G5 ★k_training は aiConsent:agreed を返したが、その後の撤回で k_aiDraft は 403（サーバーの判定だけが関門）', tr.aiConsent === 'agreed' && stale.status === 403 && calls.length === n0 + 1, JSON.stringify([tr.aiConsent, stale.status]));
  const tr2 = await call('U_TA', 'k_training', { customerId: 'C3' });
  ok('G6 撤回の後の k_training は aiConsent:none', tr2.aiConsent === 'none');
  delete env.KARTE_AI_DRAFT;
  const tr3 = await call('U_TA', 'k_training', { customerId: 'C3' });
  ok('G7 AI が使えない（切替 off）ときは aiConsent を読まない（undefined）', tr3.aiConsent === undefined && tr3.aiDraft === false);
  //   日次点検
  const h = await buildKarteAiHealth(env, Date.now() + 86400000);
  ok('G8 日次点検：前日の no_consent の件数と有効な同意の数（数だけ）', h.karteAi.consent.table === 'ok' && h.karteAi.consent.noConsent === 4 && typeof h.karteAi.consent.recAgreed === 'number' && !JSON.stringify(h).includes('C3'), JSON.stringify(h.karteAi.consent));
  dbFail = 'FROM karte_consent_rec WHERE state';
  const he = await buildKarteAiHealth(env, Date.now() + 86400000);
  dbFail = null;
  ok('G9 読めなければ error（0 と言わない）', he.karteAi.consent.table === 'error' && he.karteAi.consent.recAgreed === undefined);
}

// ================= H トレーナーの記録（k_saveConsent・k_summary）=================
{
  let n = 0; const rid = () => 'req-consent-' + String(++n).padStart(4, '0');
  //   C1：会員画面で健康情報に同意済み → 紙の同意を重ねると CONFLICT
  const crid = rid();
  const a = await call('U_TA', 'k_saveConsent', { customerId: 'C1', state: 'agreed', method: 'paper', clientReqId: crid });
  ok('H1 ★同意済みに同意を重ねると 409 CONFLICT（会員の版つきの記録を紙で置き換えない）', a.status === 409 && a.code === 'CONFLICT' && q1(`SELECT recorded_by FROM karte_consent WHERE customer_id = 'C1'`).recorded_by === '@member', a.raw);
  //   C5：未同意 → 紙で同意（今どおり）→ 同じ clientReqId の再送は replay
  const crid2 = rid();
  const b1 = await call('U_TA', 'k_saveConsent', { customerId: 'C5', state: 'agreed', method: 'paper', clientReqId: crid2 });
  const b2 = await call('U_TA', 'k_saveConsent', { customerId: 'C5', state: 'agreed', method: 'paper', clientReqId: crid2 });
  ok('H2 未同意の紙の同意は今どおり・同じ要求の再送は replay（CONFLICT にならない）', b1.status === 200 && b2.status === 200 && b2.replayed === true, JSON.stringify([b1.raw, b2.raw]));
  //   rec_ai：トレーナーは撤回だけ
  const rAgree = await call('U_TA', 'k_saveConsent', { customerId: 'C4', kind: 'rec_ai', state: 'agreed', clientReqId: rid() });
  const rMethod = await call('U_TA', 'k_saveConsent', { customerId: 'C4', kind: 'rec_ai', state: 'revoked', method: 'paper', clientReqId: rid() });
  const rKind = await call('U_TA', 'k_saveConsent', { customerId: 'C4', kind: 'photo', state: 'revoked', clientReqId: rid() });
  ok('H3 トレーナーは録音・AI の同意を記録できない（400）・method つき・知らない kind も 400', rAgree.status === 400 && rMethod.status === 400 && rKind.status === 400);
  const rNo = await call('U_TA', 'k_saveConsent', { customerId: 'C5', kind: 'rec_ai', state: 'revoked', clientReqId: rid() });
  ok('H4 同意の無い会員の録音・AI の撤回は 409 CONFLICT', rNo.status === 409 && rNo.code === 'CONFLICT');
  db.exec(`INSERT OR REPLACE INTO karte_consent_rec (customer_id, state, changed_at, method, recorded_by, doc_ver) VALUES ('C5', 'agreed', 1, 'line', '@member', '${RV}')`);
  const rOk = await call('U_TA', 'k_saveConsent', { customerId: 'C5', kind: 'rec_ai', state: 'revoked', clientReqId: rid() });
  ok('H5 ★店頭の撤回：トレーナーが録音・AI の撤回を記録できる（log にも残る）', rOk.status === 200 && q1(`SELECT state, recorded_by FROM karte_consent_rec WHERE customer_id = 'C5'`).recorded_by === 'A'
     && q1(`SELECT COUNT(*) n FROM karte_consent_log WHERE customer_id = 'C5' AND kind = 'rec_ai' AND state = 'revoked'`).n === 1);
  //   k_summary：byMember・recConsent（版は返さない）
  const sm = await call('U_TA', 'k_summary', { customerId: 'C1' });
  ok('H6 k_summary：consent.byMember・recConsent（state・日付・byMember）。版は返さない', sm.status === 200 && sm.consent.byMember === true && sm.recConsent && sm.recConsent.state === 'revoked' && sm.recConsent.byMember === true
     && !sm.raw.includes(RV) && !sm.raw.includes(HV), sm.raw.slice(0, 300));
  dbFail = 'FROM karte_consent_rec WHERE customer_id';
  const sm2 = await call('U_TA', 'k_summary', { customerId: 'C1' });
  dbFail = null;
  ok('H7 録音・AI の同意が読めなければ recConsent は unknown（同意なしと言わない）', sm2.status === 200 && sm2.recConsent.state === 'unknown');
}

// ================= I 文面の版の固定 =================
{
  const h = (d) => createHash('sha256').update(JSON.stringify([d.title, d.paragraphs, d.check])).digest('hex');
  const PIN = {
    'health-2026-11-04': '84a170b60b7e64875996929887adc817929ab13513421e060c0778e2a0e4134b',
    'rec_ai-2026-11-12': '83ad0787ad3b01599cb4ae25dc3c5e42fecfb736f7e8038099237b9d9c532e90',
  };
  for (const k of ['health', 'rec_ai']) {
    const d = CONSENT_DOCS[k];
    ok(`I1 ★${k}：版 ${d.ver} の文面は固定（文を変えたら版を上げ、ここに新しい版の印を足す）`, PIN[d.ver] === h(d), `${d.ver} → ${h(d)}`);
    ok(`I2 ${k}：空欄（［ ］）が残っていない`, !JSON.stringify(d).includes('［') && !JSON.stringify(d).includes('］'));
  }
  ok('I3 AI の関門で有効な版は現行の録音・AI の版だけ', same(CONSENT_VALID_REC, [RV]));
  ok('I4 rec_ai の文面に委託先・国・保存期間・学習の扱いがある', /Anthropic, PBC（アメリカ合衆国）/.test(CONSENT_DOCS.rec_ai.paragraphs.join('')) && /30日以内に削除/.test(CONSENT_DOCS.rec_ai.paragraphs.join('')) && /AI の学習に使わず/.test(CONSENT_DOCS.rec_ai.paragraphs.join('')));
}

// ================= J 設定と地図 =================
{
  const TOML = readFileSync(join(W, 'wrangler.toml'), 'utf8');
  ok('J1 wrangler.toml：MEMBER_CONSENT は既定 off・担当の一覧は空', /^MEMBER_CONSENT = "off"$/m.test(TOML) && /^MEMBER_CONSENT_TRAINERS = ""$/m.test(TOML));
  const MODEL = readFileSync(join(ROOT, 'ops/MODEL.md'), 'utf8');
  ok('J2 地図：karte_consent_rec・karte_consent_answers と I-CS の不変条件が載っている', MODEL.includes('karte_consent_rec') && MODEL.includes('karte_consent_answers') && /\| I-CS1 \|/.test(MODEL));
  const MIG = readFileSync(join(W, 'migrations/0033_member_consent.sql'), 'utf8').replace(/--.*$/gm, '');
  ok('J3 ★0033 は CREATE … IF NOT EXISTS だけ（ALTER しない＝何度流しても同じ）', !/ALTER\s+TABLE/i.test(MIG) && (MIG.match(/CREATE (TABLE|INDEX)/g) || []).length === (MIG.match(/CREATE (TABLE|INDEX) IF NOT EXISTS/g) || []).length);
  //   0033 を2回流しても通る
  let twice = true; try { db.exec(readFileSync(join(W, 'migrations/0033_member_consent.sql'), 'utf8')); } catch (_) { twice = false; }
  ok('J4 0033 を2回流してもエラーにならない', twice);
}

console.error = origErr;
console.log(`member-consent: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
