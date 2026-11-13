// 設計39 録音の文字起こしの AI 下書き（k_aiDraft・I76）：本物の SQLite に全 migration を流し、入口（index.js）から通す・2026-11-12
//   実行: node worker/test/karte-ai.test.js
//
//   ★身代わりは fetch（Anthropic API）だけ。送った本文・ヘッダを記録して確かめる
//   ★文字起こし・名前は架空（甲野一郎・乙川二郎・丙田）。実在の会員・録音の内容を書かない（I73）

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';
import { isKarteWrite, aiDraftOn } from '../src/routes/karte.js';
import { isAllowed } from '../src/perms.js';
import { AI_HEALTH, verifySet, makeMasker, AI_SCHEMA, AI_LIMITS } from '../src/routes/karte-ai.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const W = join(HERE, '..');
const ROOT = join(W, '..');
const ORIGIN = 'https://reservation.tokowaka-gym.com';
const CHANNEL = '1234567890';

let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) pass++; else { fail++; console.log(`❌ ${name}${detail ? '\n   ' + detail : ''}`); } }

// ---------------- D1（実物の SQLite・全 migration）----------------
const db = new DatabaseSync(':memory:');
db.exec(readFileSync(join(W, 'schema.sql'), 'utf8'));
for (const f of readdirSync(join(W, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
  try { db.exec(readFileSync(join(W, 'migrations', f), 'utf8')); } catch (e) { if (!/duplicate column/.test(e.message)) throw e; }
}
let dbFail = null;   // 'usage' を入れると karte_ai_usage の文で例外
const exec = (q, args, how) => {
  if (dbFail && q.indexOf(dbFail) >= 0) throw new Error('D1 down ' + TRANSCRIPT_SECRET);
  const st = db.prepare(q);
  if (how === 'first') { const r = st.get(...args); return r === undefined ? null : Object.assign({}, r); }
  if (how === 'all') return { results: st.all(...args).map((r) => Object.assign({}, r)) };
  const r = st.run(...args);
  return { meta: { changes: Number(r.changes) } };
};
const env = { LINE_CHANNEL_ID: CHANNEL, _kv: {} };
env.KV = { async get(k, t) { const v = env._kv[k]; return v == null ? null : (t === 'json' ? JSON.parse(v) : v); }, async put(k, v) { env._kv[k] = v; kvPuts.push(k); } };
const kvPuts = [];
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
db.exec(`INSERT INTO trainers (trainer_id, name, line_user_id, role, active) VALUES ('T1', '乙川 二郎', 'U_T1', 'trainer', 1), ('T2', '丁村 三郎', 'U_T2', 'trainer', 1), ('OWN', '店主', 'U_OWN', 'owner', 1)`);
db.exec(`INSERT INTO customers (customer_id, name, kana, line_user_id, default_trainer_id, created_at, updated_at) VALUES ('C1', '甲野 一郎', 'コウノ イチロウ', 'U_C1', 'T1', 1, 1)`);
//   設計44：AI へ送るのは録音・AI の同意が有効な会員だけ。C1 は同意済み（同意の関門そのものの検査は member-consent.test.js の G 節）
db.exec(`INSERT INTO karte_consent_rec (customer_id, state, changed_at, method, recorded_by, doc_ver) VALUES ('C1', 'agreed', 1, 'line', '@member', 'rec_ai-2026-11-12')`);
const now = Date.now();
db.exec(`INSERT INTO sync_state (key, synced_at, rows, ok) VALUES ('customers', ${now}, 1, 1), ('trainers', ${now}, 3, 1), ('reservations', ${now}, 0, 1)`);

const TRANSCRIPT_SECRET = '選挙の話なんですけど架空党が';   // 雑談（思想信条）＝どこにも残ってはいけない文字列
const T1 = [
  '乙川です、今日もよろしくお願いします。甲野さん、最近どうですか。こうのさんって呼んでいいですか。',
  '仕事が忙しくて睡眠が5時間くらいです。',
  'じゃあベンチプレスからいきましょう。20キロで10回。次30キロで5回。次55キロで5回いきます。',
  '肘を張りすぎないように意識しましょう。',
  'スカルフラッシュ、10キロで12回。',
  '腰が少し痛いです。',
  '昨日の' + TRANSCRIPT_SECRET + '色々と。丙田さんもそう言ってました。',
  '電話は090-0000-0000、メールは koho@example.com です。',
  'プッシュアップは自重で15回。',
].join('\n');

// ---------------- Anthropic の身代わり ----------------
const calls = [];
let reply = null;   // (req) => { status, json } | 'throw' | 'abort' | 'badjson'
const okDraft = () => ({
  exercises: [
    { name: 'ベンチプレス', heard: 'ベンチプレス', note: '', sets: [
      { weight_kg: 20, reps: 10, evidence: '20キロで10回', note: '' },
      { weight_kg: 30, reps: 5, evidence: '次30キロで5回', note: '' },
      { weight_kg: 55, reps: 5, evidence: '次55キロで5回いきます', note: '予告' },
      { weight_kg: 60, reps: 5, evidence: '次60キロで5回', note: '' }] },          // ★文字起こしに無い根拠
    { name: 'スカルクラッシャー', heard: 'スカルフラッシュ', note: '', sets: [{ weight_kg: 10, reps: 12, evidence: 'スカルフラッシュ、10キロで12回', note: '' }] },
    { name: 'プッシュアップ', heard: 'プッシュアップ', note: '', sets: [{ weight_kg: null, reps: 15, evidence: 'プッシュアップは自重で15回', note: '' }] }],
  coaching: ['肘を張りすぎないように意識する'],
  hearing: ['仕事が忙しく睡眠は5時間くらい'],
  caution: ['腰が少し痛い'],
  member_message: '今日はベンチプレスのフォームが安定していました。',
  member_todo: ['睡眠を6時間とる'],
});
let lastMaskedSent = '';
globalThis.fetch = async (url, opt) => {
  const req = JSON.parse(opt.body);
  calls.push({ url: String(url), headers: opt.headers, req, raw: opt.body });
  lastMaskedSent = req.messages[0].content;
  const r = reply ? reply(req) : { status: 200, json: { stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 300 }, content: [{ type: 'text', text: JSON.stringify(okDraft()) }] } };
  if (r === 'throw') throw new Error('network ' + TRANSCRIPT_SECRET);
  if (r === 'abort') { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
  if (r === 'badjson') return { status: 200, json: async () => { throw new SyntaxError('Unexpected token in ' + TRANSCRIPT_SECRET); } };
  return { status: r.status, json: async () => JSON.parse(JSON.stringify(r.json)) };
};
const textReply = (obj, extra) => () => ({ status: 200, json: Object.assign({ stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 }, content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] }, extra || {}) });

// ---------------- console を捕まえる ----------------
const logs = [];
const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
function capture(on) {
  if (on) { console.error = (...a) => logs.push(a.map(String).join(' ')); console.warn = console.error; console.info = console.error; }
  else Object.assign(console, { error: orig.error, warn: orig.warn, info: orig.info });
}

async function call(as, body, o = {}) {
  const tok = await token(as, o.iatAge || 0);
  const payload = o.raw || JSON.stringify({ action: 'k_aiDraft', idToken: tok, customerId: 'C1', text: T1, known: ['ベンチプレス', 'スカルクラッシャー', 'プッシュアップ'], ...body });
  const headers = { 'Content-Type': 'application/json' };
  if (o.origin !== null) headers.Origin = o.origin || ORIGIN;
  const res = await worker.fetch(new Request('https://w.example' + (o.path == null ? '/karte/ai-draft' : o.path), { method: 'POST', headers, body: payload }), env, { waitUntil() {} });
  const raw = await res.text();
  let j = {}; try { j = JSON.parse(raw); } catch (_) {}
  return { status: res.status, cache: res.headers.get('Cache-Control'), raw, ...j };
}
const setEnv = (o) => { for (const k of ['KARTE_AI_DRAFT', 'KARTE_AI_DRAFT_TRAINERS', 'ANTHROPIC_API_KEY', 'KARTE_AI_MODEL', 'KARTE_AI_DAILY_MAX']) delete env[k]; Object.assign(env, o); };
const ON = { KARTE_AI_DRAFT: 'allow', KARTE_AI_DRAFT_TRAINERS: 'T1', ANTHROPIC_API_KEY: 'TEST-KEY-NOT-REAL' };
const usage = () => { const r = q1('SELECT SUM(n) AS n FROM karte_ai_usage'); return r && r.n ? r.n : 0; };
const lastLog = () => q1('SELECT * FROM karte_ai_log ORDER BY id DESC LIMIT 1');

capture(true);

// ================= A 切替・鍵 =================
{
  ok('A0 許可表は trainer/owner だけ・isKarteWrite に当たる', isAllowed('k_aiDraft', 'trainer') && isAllowed('k_aiDraft', 'owner') && !isAllowed('k_aiDraft', 'customer') && isKarteWrite('k_aiDraft'));
  setEnv({ ANTHROPIC_API_KEY: 'TEST-KEY-NOT-REAL' });
  const r0 = await call('U_T1', {});
  ok('A1 ★切替なし（既定）＝503 AI_NOT_CONFIGURED・外へ送らない・数えない', r0.status === 503 && r0.code === 'AI_NOT_CONFIGURED' && r0.detail === 'OFF' && calls.length === 0 && usage() === 0, JSON.stringify(r0));
  ok('A1b 記録は off（trainer_id つき・中身なし）', lastLog() && lastLog().result === 'off' && lastLog().trainer_id === 'T1');
  for (const v of ['ON', 'allow ', 'true', '1']) { setEnv({ KARTE_AI_DRAFT: v, KARTE_AI_DRAFT_TRAINERS: 'T1', ANTHROPIC_API_KEY: 'x' }); ok('A2 打ち間違い「' + v + '」は off', !aiDraftOn(env, { trainerId: 'T1' })); }
  setEnv(ON);
  const r2 = await call('U_T2', {});
  ok('A3 allow で一覧に無いトレーナーは 503・送らない', r2.status === 503 && r2.detail === 'OFF' && calls.length === 0);
  setEnv({ KARTE_AI_DRAFT: 'on' });
  const r3 = await call('U_T1', {});
  ok('A4 ★鍵が無ければ 503 NO_KEY・送らない・数えない', r3.status === 503 && r3.detail === 'NO_KEY' && calls.length === 0 && usage() === 0);
}
// ================= A5 k_training の aiDraft =================
{
  setEnv({});
  const off = await call('U_T1', {}, { raw: JSON.stringify({ action: 'k_training', idToken: await token('U_T1'), customerId: 'C1' }), path: '/' });
  setEnv(ON);
  const on = await call('U_T1', {}, { raw: JSON.stringify({ action: 'k_training', idToken: await token('U_T1'), customerId: 'C1' }), path: '/' });
  const on2 = await call('U_T2', {}, { raw: JSON.stringify({ action: 'k_training', idToken: await token('U_T2'), customerId: 'C1' }), path: '/' });
  ok('A5 ★k_training の aiDraft：既定 false／allow の本人 true／一覧に無い人 false（鍵の値は出さない）', off.aiDraft === false && on.aiDraft === true && on2.aiDraft === false && !on.raw.includes('TEST-KEY'), JSON.stringify([off.aiDraft, on.aiDraft, on2.aiDraft]));
}

// ================= B 入口の守り =================
setEnv(ON);
{
  const tok = await token('U_T1');
  const r1 = await call('U_T1', {}, { path: '/' });
  ok('B1 ★k_aiDraft を通常のパスで送ると 400 BAD_PATH', r1.status === 400 && r1.code === 'BAD_PATH', JSON.stringify(r1));
  const r2 = await call('U_T1', {}, { raw: JSON.stringify({ action: 'k_training', idToken: tok, customerId: 'C1' }) });
  ok('B2 ★/karte/ai-draft で他の action は 400 BAD_PATH（大きい枠を流用させない）', r2.status === 400 && r2.code === 'BAD_PATH');
  const big = 'あ'.repeat(6000);   // 18KB（通常の枠16KB を超え、AI の枠128KB 以内）
  const r3 = await call('U_T1', { text: big }, { path: '/' });
  const r3b = await call('U_T1', { text: 'ベンチ' + big });
  ok('B3 16KB を超える本文：通常のパスは 413・専用のパスは通る', r3.status === 413 && r3b.status !== 413, JSON.stringify([r3.status, r3b.status]));
  const huge = 'あ'.repeat(45000);
  const r4 = await call('U_T1', { text: huge });
  ok('B4 128KB を超えると 413 TOO_LARGE', r4.status === 413 && r4.code === 'TOO_LARGE');
  const n0 = calls.length;
  const r5 = await call('U_T1', {}, { origin: 'https://evil.example' });
  const r6 = await call('U_T1', {}, { iatAge: 3700 });
  ok('B5 ★Origin 違い 403・古いトークン 401（送らない）', r5.status === 403 && r6.status === 401 && calls.length === n0, JSON.stringify([r5.status, r6.status]));
  const r7 = await call('U_C1', {});
  ok('B6 会員は 403', r7.status === 403);
  const r8 = await call('U_T1', { customerId: 'C_NONE' });
  ok('B7 存在しない顧客は 404・送らない', r8.status === 404 && calls.length === n0);
  const r9 = await call('U_T1', { extra: 1 });
  const r10 = await call('U_T1', { known: ['ok', ''] });
  const r11 = await call('U_T1', { known: new Array(601).fill('x') });
  ok('B8 知らない鍵・不正な known は 400', r9.status === 400 && r10.status === 400 && r11.status === 400);
  const u0 = usage();
  const r12 = await call('U_T1', { text: 'い'.repeat(30001) });
  ok('B9 3万字を超えると 413 AI_TOO_LONG・送らない・数えない', r12.status === 413 && r12.code === 'AI_TOO_LONG' && calls.length === n0 && usage() === u0, JSON.stringify(r12));
}

// ================= D 送った中身（氏名を伏せる・API の形）=================
{
  const r = await call('U_T1', { known: ['ベンチプレス', 'スカルクラッシャー', 'プッシュアップ', '甲野さん専用', '乙川 二郎の種目'] });
  ok('D0 成功 200', r.status === 200 && r.success === true && r.draft, JSON.stringify(r).slice(0, 300));
  const c = calls[calls.length - 1];
  ok('D1 ★送り先・ヘッダ（x-api-key・anthropic-version 2026-10-21）', c.url === 'https://api.anthropic.com/v1/messages' && c.headers['x-api-key'] === 'TEST-KEY-NOT-REAL' && c.headers['anthropic-version'] === '2026-10-21' && c.headers['content-type'] === 'application/json');
  ok('D2 ★model は既定 claude-sonnet-5-5・構造化出力（output_config.format json_schema）・effort low・tool_choice なし・temperature なし',
     c.req.model === 'claude-sonnet-5-5' && c.req.output_config.format.type === 'json_schema' && c.req.output_config.effort === 'low' && !('tool_choice' in c.req) && !('temperature' in c.req) && !('thinking' in c.req) && c.req.max_tokens === 8000);
  const sent = c.raw;
  ok('D3 ★送った本文に会員・トレーナーの名前（漢字・かな・カナ）・第三者の敬称つきの名前・電話・メールが無い',
     ['甲野', '一郎', 'こうの', 'コウノ', '乙川', '二郎', '丙田', '090-0000-0000', 'koho@example.com'].every((x) => !sent.includes(x)),
     ['甲野', '一郎', 'こうの', 'コウノ', '乙川', '二郎', '丙田', '090-0000-0000', 'koho@example.com'].filter((x) => sent.includes(x)).join(','));
  ok('D4 伏せた語に置き換わっている', lastMaskedSent.includes('〔会員〕') && lastMaskedSent.includes('〔トレーナー〕') && lastMaskedSent.includes('〔人〕') && lastMaskedSent.includes('〔番号〕') && lastMaskedSent.includes('〔メール〕'));
  ok('D5 ★known の名前らしい印・名前を含む種目は送らない', !sent.includes('専用') && !sent.includes('の種目') && sent.includes('スカルクラッシャー'));
  setEnv({ ...ON, KARTE_AI_MODEL: 'claude-haiku-5-5' }); await call('U_T1', {});
  const mh = calls[calls.length - 1].req.model;
  setEnv({ ...ON, KARTE_AI_MODEL: 'gpt-x' }); await call('U_T1', {});
  ok('D6 モデルは厳密に haiku のときだけ切り替わる・他は既定', mh === 'claude-haiku-5-5' && calls[calls.length - 1].req.model === 'claude-sonnet-5-5');
  setEnv(ON);
  db.exec(`UPDATE trainers SET name_en = 'Jiro Otsukawa' WHERE trainer_id = 'T1'`);
  await call('U_T1', { text: T1 + '\nJiro Otsukawa です。' });
  ok('D3b ★トレーナーの英字名（trainers.name_en）も入口から伏せて送る', !calls[calls.length - 1].raw.includes('Otsukawa'));
  db.exec(`UPDATE trainers SET name_en = NULL`);
  const s = JSON.stringify(AI_SCHEMA);
  ok('D7 出力の形は additionalProperties:false（全オブジェクト）', (s.match(/"type":"object"/g) || []).length === (s.match(/"additionalProperties":false/g) || []).length);
}

// ================= E 出力の検証 =================
{
  const r = await call('U_T1', {});
  const d = r.draft;
  const bp = d.exercises[0];
  ok('E1 ★根拠のあるセットだけ sets（20×10・30×5・55×5）・根拠の無い 60×5 は unverified', JSON.stringify(bp.sets.map((x) => [x.w, x.r])) === '[[20,10],[30,5],[55,5]]' && bp.unverified.length === 1 && bp.unverified[0].w === 60, JSON.stringify(bp));
  ok('E2 自重は根拠に「自重」があるときだけ（プッシュアップ null×15）', d.exercises[2].sets.length === 1 && d.exercises[2].sets[0].w === null && d.exercises[2].sets[0].r === 15);
  ok('E3 返す evidence は文字起こしから切り出したもの', bp.sets[0].evidence === '20キロで10回');
  ok('E4 ★応答に文字起こしの雑談・伏せた文字起こし・API の生の応答が無い・no-store', !r.raw.includes(TRANSCRIPT_SECRET) && !r.raw.includes('〔メール〕') && !r.raw.includes('stop_reason') && r.cache === 'no-store');
  const lg = lastLog();
  ok('E5 記録：ok・モデル・文字数・トークン・種目数・unverified 数・版の印（中身なし）', lg.result === 'ok' && lg.model === 'claude-sonnet-5-5' && lg.chars_in === T1.length && lg.in_tokens === 1000 && lg.n_ex === 3 && lg.n_unverified === 1 && /設計39/.test(lg.build), JSON.stringify(lg));
}
// ---- E3 数値の根拠（verifySet・入口の検査に加えて境界を細かく）----
{
  const M = (ev) => ev;
  const V = (w, r, ev, src) => verifySet({ weight_kg: w, reps: r, evidence: ev }, src == null ? ev : src);
  ok('E3-1 55＝55.0', !!V(55, 5, '55.0キロで5回'));
  ok('E3-2 55 と 55.5・55.04 は不一致', !V(55, 5, '55.5キロで5回') && !V(55, 5, '55.04キロで5回'));
  ok('E3-3 回数 5 と 52.5 は不一致', !V(52.5, 5, '52.5キロで15回'));
  ok('E3-4 重さと回数が同じ値：トークン1つで不一致・2つで一致', !V(10, 10, '10回やりました') && !!V(10, 10, '10キロで10回'));
  ok('E3-5 全角数字は NFKC で一致', !!V(20, 10, '２０キロで１０回', '２０キロで１０回'.normalize('NFKC')));
  ok('E3-6 根拠が文字起こしに無い・80字超は不一致', !V(20, 10, '20キロで10回', 'ほかの文') && !V(20, 10, '20キロで10回' + 'あ'.repeat(80), '20キロで10回' + 'あ'.repeat(80)));
  ok('E3-7 0.1 刻みでない重さ（52.25）・回数0・101 は不一致', !V(52.25, 5, '52.25キロで5回') && !V(20, 0, '20キロで0回') && !V(20, 101, '20キロで101回'));
  ok('E3-8 自重の明示語が無い null は不一致', !V(null, 15, '15回') && !!V(null, 15, '自重で15回'));
  ok('E3-9 155 の中の 55 は数えない', !V(55, 5, '155キロで5回'));
  void M;
}
// ---- E4 健康語の移し方 ----
{
  const base = okDraft();
  base.coaching = ['フォームを意識', '肩に違和感がある'];
  base.member_message = '腰の痛みに気をつけて';
  base.member_todo = ['ストレッチ 2分', '病院に行く', '水を飲む'];
  base.exercises[0].note = '膝が痛い';
  base.exercises[0].sets[0].note = '手首の痛み';
  base.caution = ['肩に違和感がある'];
  reply = textReply(base);
  const r = await call('U_T1', {});
  const d = r.draft;
  ok('E4-1 ★健康語の文は caution へ移り、元の場所から消える（member_message は ""・todo は該当だけ外し順序を保つ・note は空）',
     d.member_message === '' && JSON.stringify(d.member_todo) === JSON.stringify(['ストレッチ 2分', '水を飲む']) && JSON.stringify(d.coaching) === JSON.stringify(['フォームを意識']) &&
     d.exercises[0].note === '' && d.exercises[0].sets[0].note === '' &&
     d.caution.includes('ベンチプレス:膝が痛い') && d.caution.includes('ベンチプレス:手首の痛み') && d.caution.includes('病院に行く') && d.caution.filter((x) => x === '肩に違和感がある').length === 1, JSON.stringify(d));
  const b2 = okDraft(); b2.caution = Array.from({ length: 20 }, (_, i) => '注意' + i); b2.hearing = ['頭痛がある'];
  reply = textReply(b2);
  const r2 = await call('U_T1', {});
  const b3 = okDraft(); b3.caution = Array.from({ length: 19 }, (_, i) => '注意' + i).concat(['頭痛がある']); b3.hearing = ['頭痛がある'];
  reply = textReply(b3);
  const r3 = await call('U_T1', {});
  ok('E4-2 ★caution 20件＋移す1件は AI_BAD_OUTPUT（切らない）／重複を1つにして20件なら成功', r2.status === 502 && r2.code === 'AI_BAD_OUTPUT' && r3.status === 200 && r3.draft.caution.length === 20, JSON.stringify([r2.status, r3.status]));
  ok('E4-3 ★画面の MEMO_HEALTH と Worker の式が同じ（G）', (() => {
    const src = readFileSync(join(ROOT, 'liff/karte.js'), 'utf8');
    const m = /var MEMO_HEALTH = \/(.+)\/;/.exec(src);
    return m && m[1] === AI_HEALTH.source;
  })());
  reply = null;
}
// ---- E5 上限・失敗 ----
{
  const tooMany = okDraft(); tooMany.exercises = Array.from({ length: 21 }, () => ({ name: 'ベンチプレス', heard: '', note: '', sets: [] }));
  const cases = [
    ['上限（21種目）', textReply(tooMany), 502, 'AI_BAD_OUTPUT', 'bad_output'],
    ['壊れた JSON の文', textReply('{"exercises": ['), 502, 'AI_BAD_OUTPUT', 'bad_output'],
    ['refusal', textReply(okDraft(), { stop_reason: 'refusal' }), 502, 'AI_REFUSED', 'refused'],
    ['max_tokens', textReply(okDraft(), { stop_reason: 'max_tokens' }), 502, 'AI_TRUNCATED', 'truncated'],
    ['HTTP 500', () => ({ status: 500, json: { error: { message: 'x ' + TRANSCRIPT_SECRET } } }), 502, 'AI_HTTP', 'http_error'],
    ['時間切れ', () => 'abort', 504, 'AI_TIMEOUT', 'timeout'],
    ['通信の例外', () => 'throw', 502, 'AI_HTTP', 'http_error'],
    ['応答の本文が JSON でない', () => 'badjson', 502, 'AI_BAD_OUTPUT', 'bad_output'],
  ];
  for (const [nm, rp, st, code, res] of cases) {
    reply = rp;
    const r = await call('U_T1', {});
    ok('E5 ' + nm + ' → ' + st + ' ' + code + '・記録 ' + res + '・応答に本文なし', r.status === st && r.code === code && lastLog().result === res && !r.raw.includes(TRANSCRIPT_SECRET), JSON.stringify([r.status, r.code, lastLog().result]));
  }
  reply = null;
  //   D1 の例外（回数の文）＝API を呼ばない・503
  const n0 = calls.length;
  dbFail = 'karte_ai_usage';
  const r = await call('U_T1', {});
  dbFail = null;
  ok('E5-D1 ★回数を数えられない＝503 AI_UNAVAILABLE・API を呼ばない', r.status === 503 && r.code === 'AI_UNAVAILABLE' && calls.length === n0, JSON.stringify(r));
  //   マスクの途中の例外（customers の読み取り）＝500 AI_ERROR・message を出さない
  dbFail = 'FROM customers WHERE customer_id';
  const r2 = await call('U_T1', {});
  dbFail = null;
  ok('E5-D2 ★途中の例外は 500 AI_ERROR（固定のコード）・記録 error', r2.status === 500 && r2.code === 'AI_ERROR' && lastLog().result === 'error', JSON.stringify(r2));
}

// ---- E6 関門② 高1：根拠の抜き出しに健康語 → 根拠を出さず caution へ・セットは確かめられないセット ----
{
  const b = okDraft();
  b.exercises[0].sets.push({ weight_kg: 10, reps: 12, evidence: '膝が痛いので10キロで12回', note: '' });   // ★数字も文字起こしに在る（健康語だけが理由で外れることを確かめる）
  reply = textReply(b);
  const r = await call('U_T1', { text: T1 + '\n膝が痛いので10キロで12回にします。' });
  const bp = r.draft.exercises[0];
  ok('E6-1 ★健康語の根拠のセットは sets に入らず unverified（根拠は空）・その文は caution へ', !bp.sets.some((x) => x.r === 12) && bp.unverified.some((x) => x.r === 12 && x.evidence === '') && r.draft.caution.some((x) => x.includes('膝が痛いので10キロで12回')) && !JSON.stringify(r.draft.exercises).includes('痛'), JSON.stringify(r.draft).slice(0, 400));
  reply = null;
}
// ---- G4 関門② 高2：電話の形・ひらがなの名前・英字名 ----
{
  const m = makeMasker([{ name: 'Jiro Otsukawa', tag: '〔トレーナー〕' }]);
  ok('G4-1 電話：空白・括弧・国番号の形も伏せる', ['090 0000 0000', '+81 90 0000 0000', '03(0000)0000', '03（0000）0000'].every((x) => m('番号は' + x + 'です') === '番号は〔番号〕です'), ['090 0000 0000', '+81 90 0000 0000', '03(0000)0000'].map((x) => m(x)).join(' / '));
  ok('G4-1b ★電話の後ろの改行・空白の先の数字を飲み込まない（電話は伏せ、数字は残す）',
     m('電話は09012345678\n55キロで5回') === '電話は〔番号〕\n55キロで5回' && m('090-0000-0000 20回') === '〔番号〕 20回' && m('090-0000-0000 080-0000-0000') === '〔番号〕 〔番号〕' && m('55キロで5回 100キロで10回 2026') === '55キロで5回 100キロで10回 2026',
     [m('電話は09012345678\n55キロで5回'), m('090-0000-0000 20回'), m('090-0000-0000 080-0000-0000')].join(' / '));
  const ph3 = ['+81 (0)90 0000 0000', '+81(0)90-0000-0000', '090 - 0000 - 0000', '03 - 0000 - 0000'];
  ok('G4-1c ★国番号の (0)・空白をはさむハイフンも伏せ、後ろの改行＋数字は残す', ph3.every((x) => m(x + '\n55キロで5回') === '〔番号〕\n55キロで5回'), ph3.map((x) => m(x + '\n55キロで5回')).join(' / '));
  ok('G4-2 ひらがなの名前＋敬称は〔人〕・「ちゃんと」は残す', m('たなかさんが') === '〔人〕が' && m('しっかりちゃんと') === 'しっかりちゃんと', m('たなかさんが') + ' ' + m('しっかりちゃんと'));
  ok('G4-3 英字名も伏せる・重さと回数は伏せない', m('Jiro Otsukawa です') === '〔トレーナー〕 です' && m('55キロで5回・100キロ') === '55キロで5回・100キロ');
}

// ================= C 1日の上限 =================
{
  db.exec('DELETE FROM karte_ai_usage');
  setEnv({ ...ON, KARTE_AI_DAILY_MAX: '3' });
  const st = [];
  for (let i = 0; i < 3; i++) st.push((await call('U_T1', {})).status);
  const n0 = calls.length;
  const r = await call('U_T1', {});
  ok('C1 ★上限ちょうどで 429 AI_DAILY_LIMIT・API を呼ばない', JSON.stringify(st) === '[200,200,200]' && r.status === 429 && r.code === 'AI_DAILY_LIMIT' && calls.length === n0 && usage() === 3, JSON.stringify([st, r.status, usage()]));
  setEnv({ ...ON, KARTE_AI_DAILY_MAX: '2' });
  const r2 = await call('U_T1', {});
  ok('C2 上限を下げて既に n>max の日も止まる', r2.status === 429 && usage() === 3);
  setEnv({ ...ON, KARTE_AI_DAILY_MAX: 'abc' });
  db.exec('DELETE FROM karte_ai_usage');
  ok('C3 不正な上限は既定（30）', (await call('U_T1', {})).status === 200);
  setEnv(ON);
}

// ================= F ★どこにも残らない =================
{
  const tables = qa(`SELECT name FROM sqlite_master WHERE type='table'`).map((x) => x.name);
  let dump = '';
  for (const t of tables) { try { dump += JSON.stringify(qa(`SELECT * FROM "${t}"`)); } catch (_) {} }
  const marks = [TRANSCRIPT_SECRET, '肘を張りすぎない', '睡眠を6時間', '腰が少し痛い', '〔会員〕', 'スカルフラッシュ'];
  ok('F1 ★D1 の全表に文字起こし・伏せた文・AI の文が無い', marks.every((x) => !dump.includes(x)), marks.filter((x) => dump.includes(x)).join(','));
  ok('F2 ★console に文字起こし・AI の文・例外の message が無い（失敗の経路も通した後）', logs.every((l) => marks.every((x) => !l.includes(x))), logs.filter((l) => marks.some((x) => l.includes(x))).join('\n'));
  ok('F3 KV に何も書いていない', kvPuts.length === 0);
  ok('F4 ★karte_requests・karte_rate に k_aiDraft の行が無い', q1(`SELECT COUNT(*) AS n FROM karte_requests WHERE action = 'k_aiDraft'`).n === 0 && q1('SELECT COUNT(*) AS n FROM karte_rate').n === 0);
  ok('F5 監査（access_log）には section ai_draft・customer_id だけ', q1(`SELECT COUNT(*) AS n FROM karte_access_log WHERE action = 'k_aiDraft' AND section = 'ai_draft'`).n > 0);
  ok('F6 karte_ai_log の result は失敗も残る（off・no_key・timeout・bad_output…）', ['off', 'no_key', 'timeout', 'bad_output', 'refused', 'daily_limit', 'unavailable', 'error', 'ok'].every((x) => q1('SELECT COUNT(*) AS n FROM karte_ai_log WHERE result = ?', x).n > 0));
}
// ---- G マスク（部品の境界）----
{
  const m = makeMasker([{ name: '甲野 一郎', tag: '〔会員〕' }, { name: 'コウノ イチロウ', tag: '〔会員〕' }, { name: '林 一', tag: '〔トレーナー〕' }]);
  ok('G1 1字の部分は敬称つきのときだけ伏せる', m('林さんと林檎') === '〔トレーナー〕と林檎', m('林さんと林檎'));
  ok('G2 ひらがなの読みも伏せる（カナ⇄かな）・一般の敬称つきの名前は〔人〕', m('こうのいちろう') === '〔会員〕' && m('戊井さんが') === '〔人〕が');
  ok('G3 AI_LIMITS の文字数（3万字）', AI_LIMITS.TEXT_CHARS === 30000);
}

capture(false);
console.log(`karte-ai: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
