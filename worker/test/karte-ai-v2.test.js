// 設計49 AI の下書き v2（推論・要約 → カルテの形・数字4状態・ストリーミング）：本物の SQLite に全 migration を流し、入口（index.js）から通す・2026-11-20
//   実行: node worker/test/karte-ai-v2.test.js
//
//   ★身代わりは fetch（Anthropic API の SSE）だけ。送った本文を記録して確かめる
//   ★文字起こし・名前は架空（甲野一郎・乙川二郎）。実在の会員・録音の内容を書かない（I73）

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';
import { aiFormat } from '../src/routes/karte.js';
import { AI_V2_LIMITS, AI_SCHEMA_V2, aiEffort, aiEffortBad } from '../src/routes/karte-ai-v2.js';
import { buildKarteAiHealth } from '../src/lib/karte-ai-health.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const W = join(HERE, '..');
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
const SECRET = '選挙の話なんですけど架空党が';
let dbFail = null;
const exec = (q, args, how) => {
  if (dbFail && q.indexOf(dbFail) >= 0) throw new Error('D1 down ' + SECRET);
  const st = db.prepare(q);
  if (how === 'first') { const r = st.get(...args); return r === undefined ? null : Object.assign({}, r); }
  if (how === 'all') return { results: st.all(...args).map((r) => Object.assign({}, r)) };
  const r = st.run(...args);
  return { meta: { changes: Number(r.changes) } };
};
const env = { LINE_CHANNEL_ID: CHANNEL, _kv: {} };
env.KV = { async get(k, t) { const v = env._kv[k]; return v == null ? null : (t === 'json' ? JSON.parse(v) : v); }, async put(k, v) { env._kv[k] = v; kvPuts.push([k, v]); } };
const kvPuts = [];
env.DB = {
  prepare(q) { return { _q: q, _args: [], bind(...a) { this._args = a; return this; }, async run() { return exec(q, this._args, 'run'); }, async first() { return exec(q, this._args, 'first'); }, async all() { return exec(q, this._args, 'all'); } }; },
  async batch(stmts) { db.exec('BEGIN'); try { const o = stmts.map((s) => exec(s._q, s._args, 'run')); db.exec('COMMIT'); return o; } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; } },
};
const q1 = (sql, ...a) => { const r = db.prepare(sql).get(...a); return r ? Object.assign({}, r) : null; };
const qa = (sql, ...a) => db.prepare(sql).all(...a).map((r) => Object.assign({}, r));

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
env._kv['jwks:line'] = JSON.stringify({ keys: [{ ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'k1', alg: 'ES256' }] });
async function token(sub) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: 'ES256', kid: 'k1', typ: 'JWT' }));
  const pl = b64u(JSON.stringify({ iss: 'https://access.line.me', aud: CHANNEL, sub, exp: now + 3600, iat: now }));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(h + '.' + pl));
  return h + '.' + pl + '.' + b64u(sig);
}
db.exec(`INSERT INTO trainers (trainer_id, name, line_user_id, role, active) VALUES ('T1', '乙川 二郎', 'U_T1', 'trainer', 1)`);
db.exec(`INSERT INTO customers (customer_id, name, kana, line_user_id, default_trainer_id, created_at, updated_at) VALUES ('C1', '甲野 一郎', 'コウノ イチロウ', 'U_C1', 'T1', 1, 1)`);
db.exec(`INSERT INTO karte_consent_rec (customer_id, state, changed_at, method, recorded_by, doc_ver) VALUES ('C1', 'agreed', 1, 'line', '@member', 'rec_ai-2026-11-12')`);
const now0 = Date.now();
db.exec(`INSERT INTO sync_state (key, synced_at, rows, ok) VALUES ('customers', ${now0}, 1, 1), ('trainers', ${now0}, 1, 1), ('reservations', ${now0}, 0, 1)`);

const T1 = [
  '甲野さん、今日もよろしくお願いします。',
  'ベンチプレス 50キロで10回。',
  '同じ重さでもう1セット、8回。',
  '仕事が忙しくて睡眠が5時間くらいです。',
  'スクワットは膝が少し痛いので軽めに、30キロ。',
  '昨日の' + SECRET + '色々と。',
].join('\n');

// ---------------- SSE の身代わり ----------------
const enc = new TextEncoder();
const ev = (type, data) => 'event: ' + type + '\ndata: ' + JSON.stringify(Object.assign({ type }, data)) + '\n\n';
function sseText(jsonText, o = {}) {
  const parts = [ev('message_start', { message: { usage: { input_tokens: 1234 } } }), ev('ping', {})];
  if (o.thinking) parts.push(ev('content_block_start', { index: 0, content_block: { type: 'thinking' } }), ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: '考え中' + SECRET } }), ev('content_block_stop', { index: 0 }));
  const ti = o.thinking ? 1 : 0;
  parts.push(ev('content_block_start', { index: ti, content_block: { type: 'text', text: '' } }));
  const step = o.step || 7;
  for (let i = 0; i < jsonText.length; i += step) parts.push(ev('content_block_delta', { index: ti, delta: { type: 'text_delta', text: jsonText.slice(i, i + step) } }));
  parts.push(ev('content_block_stop', { index: ti }), ev('message_delta', { delta: { stop_reason: o.stop || 'end_turn' }, usage: { output_tokens: 567 } }));
  if (!o.noStop) parts.push(ev('message_stop', {}));
  if (o.after) parts.push(o.after);
  return parts.join('');
}
//   バイト列を細切れ（マルチバイトの途中で切る）にして流す
function streamOf(str, chunk = 5) {
  const b = enc.encode(str);
  let i = 0;
  return new ReadableStream({ pull(c) { if (i >= b.length) { c.close(); return; } c.enqueue(b.slice(i, i + chunk)); i += chunk; } });
}
const calls = [];
let reply = null;
const okDraft = () => ({
  summary: { flow: ['ベンチプレスを50キロで2セット行った', 'スクワットは軽めにした'] },
  exercises: [
    { name: 'ベンチプレス', heard: 'ベンチプレス', note: '', sets: [
      { weight_kg: 50, reps: 10, basis: 'said', evidence: 'ベンチプレス 50キロで10回', unsure: '', note: '' },
      { weight_kg: 50, reps: 8, basis: 'inferred', evidence: '同じ重さでもう1セット、8回', unsure: '', note: '' },
      { weight_kg: 60, reps: 5, basis: 'said', evidence: '60キロで5回', unsure: '', note: '' }] },
    { name: 'スクワット', heard: 'スクワット', note: '', sets: [
      { weight_kg: 30, reps: 10, basis: 'inferred', evidence: 'スクワットは膝が少し痛いので軽めに、30キロ', unsure: '', note: '' }] }],
  condition: ['睡眠不足で疲れ気味', '〔人〕と食事に行ったと話していた'],
  caution: ['膝が少し痛い'],
  coaching: ['肩甲骨を寄せたまま下ろす'],
  hearing: ['仕事が忙しく睡眠は5時間くらい'],
  next_actions: ['次回はベンチプレスを52.5キロで'],
  member_message: 'フォームが安定してきました。',
  member_todo: ['睡眠を6時間とる'],
  unclear: [{ text: '2セット目が予告か実施か分からない', evidence: '同じ重さでもう1セット' }],
});
globalThis.fetch = async (url, opt) => {
  const req = JSON.parse(opt.body);
  calls.push({ url: String(url), req, raw: opt.body, signal: opt.signal });
  const r = reply ? await reply(req, opt) : null;
  if (r && r.throwErr) throw r.throwErr;
  if (r && r.response) return r.response;
  if (req.stream) return new Response(streamOf(sseText(JSON.stringify(r && r.draft ? r.draft : okDraft()), (r && r.sse) || {})), { status: 200 });
  return new Response(JSON.stringify({ stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 }, content: [{ type: 'text', text: JSON.stringify({ exercises: [], coaching: [], hearing: [], caution: [], member_message: '', member_todo: [] }) }] }), { status: 200 });
};
const logs = [];
const orig = { error: console.error, warn: console.warn, info: console.info, log: console.log };
console.error = (...a) => logs.push(a.map(String).join(' ')); console.warn = console.error; console.info = console.error;

async function call(body, o = {}) {
  const tok = await token('U_T1');
  const base = { action: 'k_aiDraft', idToken: tok, customerId: 'C1', text: T1, known: ['ベンチプレス', 'スクワット'] };
  const payload = JSON.stringify(Object.assign(base, body));
  const res = await worker.fetch(new Request('https://w.example/karte/ai-draft', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: payload }), env, { waitUntil() {} });
  const raw = await res.text();
  let j = {}; try { j = JSON.parse(raw); } catch (_) {}
  return { status: res.status, raw, ...j };
}
const ON = { KARTE_AI_DRAFT: 'allow', KARTE_AI_DRAFT_TRAINERS: 'T1', ANTHROPIC_API_KEY: 'TEST-KEY-NOT-REAL' };
const setEnv = (o) => { for (const k of ['KARTE_AI_DRAFT', 'KARTE_AI_DRAFT_TRAINERS', 'ANTHROPIC_API_KEY', 'KARTE_AI_FORMAT', 'KARTE_AI_EFFORT']) delete env[k]; Object.assign(env, { KARTE_AI_DAILY_MAX: '500' }, o); };
const V2 = { ...ON, KARTE_AI_FORMAT: 'v2' };
const usage = () => { const r = q1('SELECT SUM(n) AS n FROM karte_ai_usage'); return r && r.n ? r.n : 0; };
const lastLog = () => q1('SELECT * FROM karte_ai_log ORDER BY id DESC LIMIT 1');
const lastV2 = () => q1('SELECT * FROM karte_ai_log_v2 ORDER BY id DESC LIMIT 1');
const nV2 = () => q1('SELECT COUNT(*) AS n FROM karte_ai_log_v2').n;
const LOG12 = ['id', 'at', 'trainer_id', 'model', 'chars_in', 'ms', 'result', 'in_tokens', 'out_tokens', 'n_ex', 'n_unverified', 'build', 'n_sets'];
const allText = () => JSON.stringify(qa('SELECT * FROM karte_ai_log')) + JSON.stringify(qa('SELECT * FROM karte_access_log')) + JSON.stringify(kvPuts) + logs.join('\n');

// ================= V2-1 形式の選び方 =================
{
  setEnv(V2);
  const r = await call({ client_ai_format: 2 });
  const c = calls[calls.length - 1];
  ok('V2-1 ★設定 v2＋client_ai_format:2 → v2 の要求（stream・max_tokens 16000・effort low 既定・v2 の形）', r.status === 200 && r.draft && r.draft.v === 2 && c.req.stream === true && c.req.max_tokens === 16000 && c.req.output_config.effort === 'low' && JSON.stringify(c.req.output_config.format.schema) === JSON.stringify(AI_SCHEMA_V2), JSON.stringify(r).slice(0, 300));
  const n0 = calls.length;
  for (const [label, env2, body] of [['設定 v2・client なし（旧画面の形）', V2, {}], ['設定 v2・client "2"（文字列）', V2, { client_ai_format: '2' }], ['設定 v2・client 1', V2, { client_ai_format: 1 }], ['設定なし・client 2', ON, { client_ai_format: 2 }], ['設定 v1・client 2', { ...ON, KARTE_AI_FORMAT: 'v1' }, { client_ai_format: 2 }]]) {
    setEnv(env2);
    const v0 = nV2();
    const x = await call(body);
    const cc = calls[calls.length - 1];
    ok('V2-1 ' + label + ' → v1（非ストリーミング・effort low・8000・応答に v が無い・別表に行を足さない）', x.status === 200 && x.draft && !('v' in x.draft) && !cc.req.stream && cc.req.max_tokens === 8000 && cc.req.output_config.effort === 'low' && nV2() === v0, JSON.stringify([x.status, x.draft && x.draft.v, cc.req.stream]));
  }
  ok('V2-12 ★旧画面と同じ鍵だけの要求は、設定が v2 でも v1 を受け取る（上の1件目）', calls.length === n0 + 5);
}
// ================= V2-1b 考える量 =================
{
  const cases = [['low', 'low', false], ['medium', 'medium', false], [undefined, 'low', false], ['', 'low', true], ['Medium', 'low', true], ['MEDIUM', 'low', true], ['Low', 'low', true], ['high', 'low', true], [' medium', 'low', true], ['medium ', 'low', true], ['medium\n', 'low', true]];
  for (const [v, want, warn] of cases) {
    const e2 = v === undefined ? {} : { KARTE_AI_EFFORT: v };
    ok('V2-1b effort ' + JSON.stringify(v) + ' → ' + want + (warn ? '（warn）' : ''), aiEffort(e2) === want && aiEffortBad(e2) === warn);
  }
  setEnv({ ...V2, KARTE_AI_EFFORT: 'medium' });
  const r = await call({ client_ai_format: 2 });
  ok('V2-1b medium が要求・応答・記録で一致', calls[calls.length - 1].req.output_config.effort === 'medium' && r.draft.effort === 'medium' && lastV2().effort === 'medium');
  setEnv({ ...ON, KARTE_AI_EFFORT: 'medium' });
  const v0 = nV2();
  await call({});
  ok('V2-1b v1 には効かない（low のまま・別表に行を足さない）', calls[calls.length - 1].req.output_config.effort === 'low' && nV2() === v0);
}
// ================= V2-10 形式の設定の打ち間違い =================
{
  for (const v of ['V2', '2', 'v3', ' v2', 'v2 ']) {
    setEnv({ ...ON, KARTE_AI_FORMAT: v });
    const n0 = calls.length, u0 = usage();
    const r = await call({ client_ai_format: 2 });
    ok('V2-10 ★形式 ' + JSON.stringify(v) + ' は閉じる（503 FORMAT・送らない・数えない）', r.status === 503 && r.code === 'AI_NOT_CONFIGURED' && r.detail === 'FORMAT' && calls.length === n0 && usage() === u0, JSON.stringify(r));
  }
  ok('V2-10 未設定・空文字は v1', aiFormat({}) === 'v1' && aiFormat({ KARTE_AI_FORMAT: '' }) === 'v1' && aiFormat({ KARTE_AI_FORMAT: 'V2' }) === null);
  setEnv({ ...ON, KARTE_AI_FORMAT: 'v3' });
  const tok = await token('U_T1');
  const res = await worker.fetch(new Request('https://w.example/', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ action: 'k_training', idToken: tok, customerId: 'C1' }) }), env, { waitUntil() {} });
  const j = await res.json();
  ok('V2-10 形式が不正なら起動の印 aiDraft も偽（ボタンが出ない）', j.aiDraft === false, JSON.stringify(j).slice(0, 200));
}
// ================= V2-4〜8・V2-9・V2-21 出力の検証 =================
setEnv(V2);
{
  const r = await call({ client_ai_format: 2, clientReqId: 'req_ABC-123' });
  const d = r.draft;
  const bp = d.exercises[0].sets;
  ok('V2-4 ★match：数字が根拠のトークンに在る（50×10）', bp[0].status === 'match' && bp[0].w === 50 && bp[0].r === 10 && bp[0].evidence === 'ベンチプレス 50キロで10回', JSON.stringify(bp[0]));
  ok('V2-5 ★inferred：根拠は在るが 50 が根拠に無い（50×8）・数字は返る', bp[1].status === 'inferred' && bp[1].w === 50 && bp[1].r === 8, JSON.stringify(bp[1]));
  ok('V2-6 ★nobasis：根拠が文字起こしに無い（60×5）・数字は返る（欄に入れる・D2）', bp[2].status === 'nobasis' && bp[2].w === 60 && bp[2].r === 5, JSON.stringify(bp[2]));
  const sq = d.exercises[1].sets[0];
  ok('V2-8・V2-21 ★根拠に健康語 → healthHidden（w/r null・evidence/unsure 空）・文は caution へ', sq.status === 'healthHidden' && sq.w === null && sq.r === null && sq.evidence === '' && sq.unsure === '' && d.caution.some((t) => t.indexOf('スクワット:') === 0 && t.includes('痛い')), JSON.stringify(sq) + JSON.stringify(d.caution));
  ok('V2-9 ★〔人〕を含む文は消えない（人名で採用は止めない）', d.condition.includes('〔人〕と食事に行ったと話していた'));
  ok('V2-9 要約が返る・応答に文字起こしの雑談・伏せた語・生の応答・考えの差分が無い', d.summary.length === 2 && !r.raw.includes(SECRET) && !r.raw.includes('〔会員〕') && !r.raw.includes('stop_reason') && !r.raw.includes('考え中'));
  const lg = lastV2(), base = lastLog();
  ok('V2-11 ★別表 karte_ai_log_v2：effort・番号・状態ごとの数・ストリームのイベント数とバイト数（中身なし）', lg.result === 'ok' && lg.effort === 'low' && lg.client_req_id === 'req_ABC-123' && lg.n_sets === 1 && lg.n_inferred === 1 && lg.n_nobasis === 1 && lg.n_health_hidden === 1 && lg.n_unclear === 1 && lg.n_summary === 2 && lg.stream_events > 5 && lg.stream_bytes > 100, JSON.stringify(lg));
  ok('V2-11 ★基本の記録 karte_ai_log も1行（12列の形のまま・トークン数）', base.result === 'ok' && base.in_tokens === 1234 && base.out_tokens === 567 && base.n_sets === 1 && base.n_unverified === 3 && JSON.stringify(Object.keys(base)) === JSON.stringify(LOG12), JSON.stringify(base));
  await call({ client_ai_format: 2, clientReqId: 'bad id with space' });
  ok('V2-11 番号の形が違えば記録しない（400 にもしない）', lastV2().result === 'ok' && lastV2().client_req_id === null);
  ok('V2-11 karte_requests に k_aiDraft の行が無い', qa(`SELECT * FROM karte_requests WHERE action = 'k_aiDraft'`).length === 0);
}
{
  //   V2-7 unsure があれば一致でも inferred／V2-9 全自由文の表を1行ずつ（健康語は caution へ・元から消える）
  const H = '腰が痛い';
  reply = () => ({ draft: Object.assign(okDraft(), {
    summary: { flow: ['ウォームアップをした', '途中で' + H + 'と話した'] },
    exercises: [{ name: 'ベンチプレス', heard: 'ベンチプレス', note: H + 'ので浅め', sets: [
      { weight_kg: 50, reps: 10, basis: 'said', evidence: 'ベンチプレス 50キロで10回', unsure: '予告かもしれない', note: '' },
      { weight_kg: 50, reps: 10, basis: 'said', evidence: 'ベンチプレス 50キロで10回', unsure: '', note: H },
      { weight_kg: 50, reps: 10, basis: 'said', evidence: 'ベンチプレス 50キロで10回', unsure: '薬を飲んだ後', note: '' }] }],
    condition: ['疲れ気味', '頭痛がある'], coaching: ['肩を下げる', '熱がある日は休む'], hearing: ['睡眠5時間', '通院中'],
    next_actions: ['スクワット', '病院の後に再開'], member_message: '体調に気をつけて', member_todo: ['ストレッチ', '薬を飲む'],
    unclear: [{ text: '痺れの話が途中で切れた', evidence: 'x' }, { text: '回数が不明', evidence: '腰が痛い' }],
  }) });
  const r = await call({ client_ai_format: 2 });
  const d = r.draft;
  ok('V2-7 ★unsure があれば数字が一致しても inferred', d.exercises[0].sets[0].status === 'inferred', JSON.stringify(d.exercises[0].sets[0]));
  const rows = [
    ['summary.flow', !d.summary.some((t) => t.includes(H))],
    ['exercises.note', d.exercises[0].note === ''],
    ['sets.note（セットは残る）', d.exercises[0].sets[1].note === '' && d.exercises[0].sets[1].status === 'match'],
    ['sets.unsure → healthHidden', d.exercises[0].sets[2].status === 'healthHidden' && d.exercises[0].sets[2].unsure === ''],
    ['condition', d.condition.length === 1 && d.condition[0] === '疲れ気味'],
    ['coaching', d.coaching.length === 1],
    ['hearing', d.hearing.length === 1],
    ['next_actions', d.next_actions.length === 1],
    ['member_message', d.member_message === ''],
    ['member_todo', d.member_todo.length === 1],
    ['unclear.text', d.unclear.length === 1 && d.unclear[0].text === '回数が不明'],
    ['unclear.evidence', d.unclear[0].evidence === ''],
  ];
  for (const [label, cond] of rows) ok('V2-9 ★健康語の表：' + label, cond, JSON.stringify(d).slice(0, 600));
  ok('V2-9 移した文は caution に（種目の欄は「種目名：」つき・再マスクの NFKC で半角の「:」）', d.caution.includes('ベンチプレス:' + H + 'ので浅め') && d.caution.includes('頭痛がある') && d.caution.includes('ベンチプレス:薬を飲んだ後'), JSON.stringify(d.caution));
  reply = () => ({ draft: Object.assign(okDraft(), { summary: { flow: ['甲野 一郎さんがベンチプレスをした'] }, coaching: ['乙川 二郎が見ていた'] }) });
  const r2 = await call({ client_ai_format: 2 });
  ok('V2-9 ★登録済みの名前は出力でも伏せる（再マスク）', !r2.raw.includes('甲野') && !r2.raw.includes('乙川') && r2.draft.summary[0].includes('〔会員〕'), r2.raw.slice(0, 300));
  reply = null;
}
// ================= V2-3 上限 =================
{
  const L = AI_V2_LIMITS;
  const tryDraft = async (patch) => { reply = () => ({ draft: Object.assign(okDraft(), patch) }); const r = await call({ client_ai_format: 2 }); reply = null; return r; };
  const many = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  ok('V2-3 caution（AI 直接）20件は通る・21件は AI_BAD_OUTPUT', (await tryDraft({ caution: many(20, (i) => 'c' + i) })).status === 200 && (await tryDraft({ caution: many(21, (i) => 'c' + i) })).code === 'AI_BAD_OUTPUT');
  //   okDraft のスクワットの根拠（健康語）が1件移る＝20＋9＋1＝30
  ok('V2-3 ★caution（移した後）30件は通る・31件は AI_BAD_OUTPUT', (await tryDraft({ caution: many(20, (i) => 'c' + i), coaching: many(9, (i) => '痛い' + i) })).status === 200 && (await tryDraft({ caution: many(20, (i) => 'c' + i), coaching: many(10, (i) => '痛い' + i) })).code === 'AI_BAD_OUTPUT');
  ok('V2-3 要約12件・各120字は通る／13件・121字・合計1000字超は落ちる', (await tryDraft({ summary: { flow: many(8, () => 'あ'.repeat(120)) } })).status === 200 && (await tryDraft({ summary: { flow: many(13, () => 'a') } })).code === 'AI_BAD_OUTPUT' && (await tryDraft({ summary: { flow: ['あ'.repeat(121)] } })).code === 'AI_BAD_OUTPUT' && (await tryDraft({ summary: { flow: many(9, () => 'あ'.repeat(120)) } })).code === 'AI_BAD_OUTPUT');
  ok('V2-3 次回やること5件・合計500字以内は通る／6件・合計超は落ちる', (await tryDraft({ next_actions: many(5, () => 'あ'.repeat(99)) })).status === 200 && (await tryDraft({ next_actions: many(6, () => 'a') })).code === 'AI_BAD_OUTPUT' && (await tryDraft({ next_actions: many(5, () => 'あ'.repeat(100)) })).code === 'AI_BAD_OUTPUT');
  ok('V2-3 unsure 121字・unclear 11件は落ちる', (await tryDraft({ exercises: [{ name: 'ベンチプレス', heard: '', note: '', sets: [{ weight_kg: 50, reps: 10, basis: 'said', evidence: 'x', unsure: 'あ'.repeat(121), note: '' }] }] })).code === 'AI_BAD_OUTPUT' && (await tryDraft({ unclear: many(11, () => ({ text: 'a', evidence: '' })) })).code === 'AI_BAD_OUTPUT');
  void L;
}
// ================= V2-2 SSE の読み方 =================
{
  const T = JSON.stringify(okDraft());
  const sseReply = (str, chunk) => () => ({ response: new Response(streamOf(str, chunk), { status: 200 }) });
  reply = sseReply(sseText(T, { thinking: true, step: 3 }), 1);
  const r1 = await call({ client_ai_format: 2 });
  ok('V2-2 ★1バイトずつ（マルチバイトの途中で切れる）・考えのブロックつきでも1回だけ正しく読む', r1.status === 200 && r1.draft.summary.length === 2 && !r1.raw.includes('考え中'), JSON.stringify(r1).slice(0, 200));
  const head = ev('message_start', { message: { usage: {} } });
  const bads = [
    ['開始の重複', head + head + sseText(T).slice(head.length)],
    ['閉じたブロックへの差分', sseText(T).replace(ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 567 } }), ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'x' } }))],
    ['stop の後のデータ', sseText(T, { after: ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }) })],
    ['未知の型', sseText(T).replace(ev('ping', {}), ev('mystery', {}))],
    ['開いていない index', sseText(T).replace('"index":0,"delta"', '"index":7,"delta"')],
    ['壊れた UTF-8', null],
  ];
  for (const [label, str] of bads) {
    if (str === null) {
      const b = enc.encode(sseText(T));
      const broken = new Uint8Array(b.length + 2); broken.set(b.slice(0, 200)); broken.set([0xE3, 0x28], 200); broken.set(b.slice(200), 202);
      reply = () => ({ response: new Response(new ReadableStream({ start(c) { c.enqueue(broken); c.close(); } }), { status: 200 }) });
    } else reply = sseReply(str, 64);
    const r = await call({ client_ai_format: 2 });
    ok('V2-2 ★' + label + ' → AI_BAD_OUTPUT・記録は bad_output', r.status === 502 && r.code === 'AI_BAD_OUTPUT' && lastLog().result === 'bad_output', JSON.stringify(r));
  }
  const saveL = { ...AI_V2_LIMITS };
  AI_V2_LIMITS.SSE_BYTES = 2000; reply = sseReply(sseText(T), 256);
  const rb = await call({ client_ai_format: 2 });
  AI_V2_LIMITS.SSE_BYTES = saveL.SSE_BYTES; AI_V2_LIMITS.SSE_EVENTS = 10;
  const re = await call({ client_ai_format: 2 });
  AI_V2_LIMITS.SSE_EVENTS = saveL.SSE_EVENTS; AI_V2_LIMITS.SSE_EVENT_BYTES = 50;
  reply = sseReply(sseText(T, { step: 200 }), 64);
  const rx = await call({ client_ai_format: 2 });
  AI_V2_LIMITS.SSE_EVENT_BYTES = saveL.SSE_EVENT_BYTES;
  ok('V2-2 ★累積バイト・イベント件数・1イベントの大きさの上限を超えると AI_BAD_OUTPUT', rb.code === 'AI_BAD_OUTPUT' && re.code === 'AI_BAD_OUTPUT' && rx.code === 'AI_BAD_OUTPUT', JSON.stringify([rb.code, re.code, rx.code]));
  reply = sseReply(sseText(T, { noStop: true }), 64);
  const rn = await call({ client_ai_format: 2 });
  ok('V2-15 ★message_stop が来ずに終わる → AI_BAD_OUTPUT NO_STOP・記録される', rn.code === 'AI_BAD_OUTPUT' && rn.detail === 'NO_STOP' && lastLog().result === 'bad_output');
  reply = sseReply(head + ev('error', { error: { type: 'overloaded_error', message: 'busy ' + SECRET } }), 64);
  const rerr = await call({ client_ai_format: 2 });
  reply = sseReply(head + ev('error', { error: { type: 'weird ' + SECRET } }), 64);
  const rerr2 = await call({ client_ai_format: 2 });
  ok('V2-16 ★SSE の error → AI_HTTP・detail は許可リストの語だけ（本文を出さない）', rerr.code === 'AI_HTTP' && rerr.detail === 'overloaded_error' && rerr2.detail === 'stream_error' && lastLog().result === 'http_error' && !rerr.raw.includes(SECRET) && !rerr2.raw.includes(SECRET));
  reply = sseReply(sseText(T, { stop: 'refusal' }), 64);
  const rr = await call({ client_ai_format: 2 });
  reply = sseReply(sseText(T, { stop: 'max_tokens' }), 64);
  const rt = await call({ client_ai_format: 2 });
  ok('V2-2 stop_reason refusal／max_tokens は今と同じコード', rr.code === 'AI_REFUSED' && rt.code === 'AI_TRUNCATED');
  reply = () => ({ response: new Response('{"error":{"message":"' + SECRET + '"}}', { status: 529 }) });
  const r529 = await call({ client_ai_format: 2 });
  ok('V2-2 200 以外は AI_HTTP（状態番号だけ）', r529.code === 'AI_HTTP' && r529.detail === '529' && !r529.raw.includes(SECRET));
  reply = null;
  ok('V2-2 ★console・D1・KV に文字起こしの雑談・考えの差分・SSE の本文が無い', !allText().includes(SECRET) && !allText().includes('考え中') && !allText().includes('同じ重さでもう1セット'));
}
// ================= V2-13・V2-14 打ち切り・切断 =================
{
  const save = AI_V2_LIMITS.TIMEOUT_MS;
  AI_V2_LIMITS.TIMEOUT_MS = 30;
  reply = (req, opt) => new Promise((_, rej) => { opt.signal.addEventListener('abort', () => { const e = new Error('aborted ' + SECRET); e.name = 'AbortError'; rej(e); }); }).catch((e) => ({ throwErr: e }));
  const r = await call({ client_ai_format: 2 });
  ok('V2-14 ★Worker の締切（身代わりで 30ms）→ 504 AI_TIMEOUT・終了処理で記録される', r.status === 504 && r.code === 'AI_TIMEOUT' && lastLog().result === 'timeout' && !r.raw.includes(SECRET), JSON.stringify(r));
  //   読み取りの途中で打ち切られる（応答の本文が止まったまま）
  reply = (req, opt) => ({ response: new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(ev('message_start', { message: { usage: {} } }))); opt.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; c.error(e); }); } }), { status: 200 }) });
  const r2 = await call({ client_ai_format: 2 });
  ok('V2-13 ★ストリームの途中で打ち切り（切断と同じ形）→ AI_TIMEOUT・記録される・途中の出力は返さない', r2.code === 'AI_TIMEOUT' && lastLog().result === 'timeout' && !r2.draft, JSON.stringify(r2));
  AI_V2_LIMITS.TIMEOUT_MS = save;
  reply = null;
}
// ================= V2-17 記録の失敗・V2-18 強制終了・V2-19 日次点検 =================
{
  dbFail = 'INSERT INTO karte_ai_log';
  const r = await call({ client_ai_format: 2 });
  dbFail = null;
  ok('V2-17 ★記録（D1）が失敗しても応答は変わらない・console は固定の文だけ', r.status === 200 && r.draft && logs.some((x) => x.includes('[karte-ai] log write failed')) && !logs.join('\n').includes(SECRET));
  //   強制終了の模擬：Anthropic が返らないまま要求を捨てる（終了処理まで届かない）
  db.exec('DELETE FROM karte_ai_log'); db.exec('DELETE FROM karte_ai_log_v2'); db.exec('DELETE FROM karte_ai_usage');
  await call({ client_ai_format: 2 });
  reply = () => new Promise(() => {});
  void call({ client_ai_format: 2 });
  await new Promise((r2) => setTimeout(r2, 50));
  reply = null;
  ok('V2-18 ★終了処理まで届かない要求：回数は1増え、記録は残らない（基本の記録も別表も1行のまま）', usage() === 2 && qa('SELECT * FROM karte_ai_log').length === 1 && nV2() === 1, JSON.stringify([usage(), qa('SELECT result FROM karte_ai_log')]));
  const h = (await buildKarteAiHealth({ ...env, ...V2 }, Date.now() + 24 * 3600000)).karteAi;
  ok('V2-19 ★日次点検：lost（usage − 終了処理まで届いた数）＝1・形式別の成功・形式と考える量の設定', h.table === 'ok' && h.lost === 1 && h.okByFmt.v2 === 1 && h.format === 'v2' && h.formatBad === false && h.effort === 'low' && h.effortBad === false, JSON.stringify(h));
  const hb = (await buildKarteAiHealth({ ...env, ...ON, KARTE_AI_FORMAT: 'v3', KARTE_AI_EFFORT: 'MEDIUM' }, Date.now() + 24 * 3600000)).karteAi;
  ok('V2-19 形式・考える量の打ち間違いは formatBad・effortBad', hb.formatBad === true && hb.format === 'bad' && hb.effortBad === true);
  //   v1 の呼び出しを1回足す（基本の記録だけ・別表は増えない）＝lost は2つの表を足さずに数える
  setEnv(ON); await call({}); setEnv(V2);
  const hv = (await buildKarteAiHealth({ ...env, ...V2 }, Date.now() + 24 * 3600000)).karteAi;
  ok('V2-19 ★v1 と v2 が混ざっても lost は基本の記録だけで数える（usage 3・届いた 2 ＝ 1）・形式別の内訳 v1 1／v2 1', hv.lost === 1 && hv.usage === 3 && hv.okByFmt.v1 === 1 && hv.okByFmt.v2 === 1, JSON.stringify(hv));
  db.exec('DELETE FROM karte_ai_log_v2');
  const hz = (await buildKarteAiHealth({ ...env, ...V2 }, Date.now() + 24 * 3600000)).karteAi;
  ok('V2-19 ★設定が v2 なのに成功が全部 v1 なら v2Zero（画面の版の取り違え）', hz.v2Zero === true);
}

// ================= V2-22 未設定なら v1 の応答とログが変わらない =================
{
  setEnv(ON);
  const v0 = nV2();
  const r = await call({ client_ai_format: 2 });
  const base = lastLog();
  ok('V2-22 ★KARTE_AI_FORMAT 未設定：応答の draft に v が無い・鍵は v1 の6つだけ', r.status === 200 && JSON.stringify(Object.keys(r.draft)) === JSON.stringify(['exercises', 'coaching', 'hearing', 'caution', 'member_message', 'member_todo']), JSON.stringify(Object.keys(r.draft || {})));
  ok('V2-22 ★karte_ai_log の列は今の13列（id＋12列・0032 の n_sets）のまま・別表に行を足さない', JSON.stringify(qa('PRAGMA table_info(karte_ai_log)').map((c) => c.name)) === JSON.stringify(LOG12) && nV2() === v0 && base.result === 'ok', JSON.stringify(qa('PRAGMA table_info(karte_ai_log)').map((c) => c.name)));
  const SRCW = readFileSync(join(W, 'src/routes/karte-ai.js'), 'utf8');
  ok('V2-22 karte_ai_log の INSERT は従来の12列', /INSERT INTO karte_ai_log \(at, trainer_id, model, chars_in, ms, result, in_tokens, out_tokens, n_ex, n_unverified, n_sets, build\)\s+VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?\)/.test(SRCW));
}
// ================= V2-23 migration 0035 は何度流しても同じ =================
{
  const MIG = readFileSync(join(W, 'migrations/0035_karte_ai_log_v2.sql'), 'utf8').replace(/--.*$/gm, '');
  ok('V2-23 ★0035 は CREATE … IF NOT EXISTS だけ（既存の表に ALTER しない）', !/ALTER\s+TABLE/i.test(MIG) && (MIG.match(/CREATE (TABLE|INDEX)/g) || []).length === (MIG.match(/CREATE (TABLE|INDEX) IF NOT EXISTS/g) || []).length && (MIG.match(/CREATE (TABLE|INDEX)/g) || []).length >= 1);
  let twice = true; try { db.exec(readFileSync(join(W, 'migrations/0035_karte_ai_log_v2.sql'), 'utf8')); db.exec(readFileSync(join(W, 'migrations/0035_karte_ai_log_v2.sql'), 'utf8')); } catch (_) { twice = false; }
  ok('V2-23 ★0035 を2回（さらに）流してもエラーにならない（印を書けなかった次の実行と同じ）', twice);
}

Object.assign(console, orig);
console.log(`karte-ai-v2: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
