// 設計39 の続き（2026-11-12）：①トレーナーの読み（かな）を伏せる ②AI 振り分けの記録を日次点検に載せる
//   実行: node worker/test/karte-ai-kana-health.test.js
//
//   K 読み（かな）：GAS の名簿（見出し kana の列）→ 押し出し → /ingest → D1 trainers.kana → k_aiDraft の伏せる処理（入口から）
//   H 点検の窓口：/quota/status?karteai=1（合言葉）→ 前日（JST）の結果別件数・確かめられない数字の割合・回数・上限・読みの登録数
//   G GAS の判定：lbKarteAiDailyCheck（off で0件＝未使用の info・失敗が続いたら warn）・dailyHealthCheck の配線
//   ★名前は架空（乙川 二郎・おとかわ じろう・丁村 三郎）。実在のトレーナー・会員を書かない（I73）

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';
import worker from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const W = join(HERE, '..');
const ROOT = join(W, '..');
const ORIGIN = 'https://reservation.tokowaka-gym.com';
const CHANNEL = '1234567890';
const SECRET = 'TEST-INGEST-SECRET';

let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) pass++; else { fail++; console.log(`❌ ${name}${detail ? '\n   ' + detail : ''}`); } }

// ---------------- D1（実物の SQLite・全 migration）----------------
const db = new DatabaseSync(':memory:');
db.exec(readFileSync(join(W, 'schema.sql'), 'utf8'));
for (const f of readdirSync(join(W, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
  try { db.exec(readFileSync(join(W, 'migrations', f), 'utf8')); } catch (e) { if (!/duplicate column/.test(e.message)) throw e; }
}
let dbFail = null;
const exec = (q, args, how) => {
  if (dbFail && q.indexOf(dbFail) >= 0) throw new Error('D1 down');
  const st = db.prepare(q);
  if (how === 'first') { const r = st.get(...args); return r === undefined ? null : Object.assign({}, r); }
  if (how === 'all') return { results: st.all(...args).map((r) => Object.assign({}, r)) };
  const r = st.run(...args);
  return { meta: { changes: Number(r.changes) } };
};
const env = { LINE_CHANNEL_ID: CHANNEL, SHARED_SECRET: SECRET, _kv: {} };
env.KV = { async get(k, t) { const v = env._kv[k]; return v == null ? null : (t === 'json' ? JSON.parse(v) : v); }, async put(k, v) { env._kv[k] = v; } };
env.DB = {
  prepare(q) { return { _q: q, _args: [], bind(...a) { this._args = a; return this; }, async run() { return exec(q, this._args, 'run'); }, async first() { return exec(q, this._args, 'first'); }, async all() { return exec(q, this._args, 'all'); } }; },
  async batch(stmts) { db.exec('BEGIN'); try { const o = stmts.map((s) => exec(s._q, s._args, 'run')); db.exec('COMMIT'); return o; } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; } },
};
const q1 = (sql, ...a) => { const r = db.prepare(sql).get(...a); return r ? Object.assign({}, r) : null; };

// ---------------- トークン ----------------
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

// ---------------- GAS（PushToEdge.js）を vm で読む ----------------
const PE = readFileSync(join(ROOT, 'gas/PushToEdge.js'), 'utf8');
const LB = readFileSync(join(ROOT, 'gas/LineBooking.js'), 'utf8');
function pluckFn(src, name) {
  const m = src.match(new RegExp('\\nfunction ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('見つからない: ' + name);
  return m[0];
}
function gasCtx(sheetRows) {
  const ctx = {
    String, Number, JSON, Math, Object, isFinite,
    TR_COL: { LINE_USER_ID: 1, TRAINER_ID: 2, NAME: 3, ROLE: 4, ACTIVE: 5, NAME_EN: 6 },
    LINE_BOOKING: { TRAINER_SHEET: 'trainer_master' },
    CALENDAR_IDS: { TRAINERS: [{ id: 'T1', name: '乙川', calendarId: 'cal-t1' }, { id: 'HID', name: '店主', calendarId: 'cal-h', hidden: true }] },
    _edgeIdOrNull: (v) => (v ? String(v) : null),
    _lbTruthy: (v) => v === true || String(v).toLowerCase() === 'true',
    _lbSheet: () => (sheetRows == null ? null : {
      getLastRow: () => sheetRows.length,
      getLastColumn: () => Math.max(...sheetRows.map((r) => r.length)),
      getRange: (r, c, nr, nc) => ({ getValues: () => sheetRows.slice(r - 1, r - 1 + nr).map((row) => { const o = []; for (let i = 0; i < nc; i++) o.push(row[c - 1 + i] === undefined ? '' : row[c - 1 + i]); return o; }) }),
    }),
  };
  vm.createContext(ctx);
  for (const n of ['_edgeTrainerKanaCol', '_edgeTrainerKana', '_edgeTrainers', 'lbKarteAiDailyCheck']) vm.runInContext(pluckFn(PE, n), ctx);
  return ctx;
}
const HEAD6 = ['line_user_id', 'trainer_id', 'name', 'role', 'active', 'name_en'];

// ================= K1 GAS：名簿の見出し kana の列だけを読む =================
{
  const rowsOf = (head, data) => gasCtx([head].concat(data))._edgeTrainers();
  const byId = (rows) => { const o = {}; for (const r of rows) o[r.trainer_id] = r; return o; };
  const a = byId(rowsOf(HEAD6.concat(['kana']), [['U_T1', 'T1', '乙川 二郎', 'trainer', true, '', ' おとかわ じろう '], ['U_T2', 'T2', '丁村 三郎', 'trainer', true, '', '']]));
  ok('K1-1 ★見出し kana の列の値を送る（前後の空白は落とす）', a.T1.kana === 'おとかわ じろう', JSON.stringify(a.T1));
  ok('K1-2 空欄は空文字（伏せない＝今と同じ）', a.T2.kana === '');
  ok('K1-3 カレンダー定義にしか無いトレーナーは空文字', a.HID && a.HID.kana === '');
  const b = byId(rowsOf(HEAD6, [['U_T1', 'T1', '乙川 二郎', 'trainer', true, '']]));
  ok('K1-4 ★見出しに kana が無い名簿＝全員空文字・他の列は今と同じ', b.T1.kana === '' && b.T1.name === '乙川 二郎' && b.T1.active === 1 && b.T1.line_user_id === 'U_T1');
  const c = byId(rowsOf(HEAD6.concat(['メモ', ' KANA ']), [['U_T1', 'T1', '乙川 二郎', 'trainer', true, '', '別の値', 'オトカワ ジロウ']]));
  ok('K1-5 ★位置を決め打ちしない：G に別の列があっても見出し kana（大文字・空白を無視）の列を読む', c.T1.kana === 'オトカワ ジロウ', JSON.stringify(c.T1));
  const d = byId(rowsOf(['line_user_id', 'trainer_id', 'kana', 'role', 'active', 'name_en'], [['U_T1', 'T1', 'おとかわ', 'trainer', true, '']]));
  ok('K1-6 A〜F（既存の列）の見出しが kana でも読まない', d.T1.kana === '');
  const e = byId(rowsOf(HEAD6.concat(['kana']), [['U_T1', 'T1', '乙川 二郎', 'trainer', true, '', 'あ'.repeat(41)]]));
  ok('K1-7 41字以上は送らない（空文字）', e.T1.kana === '');
  const g = gasCtx([]);
  const bads = ['10', 'kg', 'セット10', 'おとかわ1', 'メモ：おとかわ', 'ー', '・ '];
  ok('K1-9 ★かな以外（数字・英字・漢字・記号）を含む値・かなが1字も無い値は送らない（関門② 高2）', bads.every((x) => g._edgeTrainerKana(x) === ''), bads.filter((x) => g._edgeTrainerKana(x) !== '').join(','));
  ok('K1-10 かな・長音・中黒・空白は通す（NFKC：半角カナは全角へ・全角空白は半角へ）', g._edgeTrainerKana('オトカワ・ジロー') === 'オトカワ・ジロー' && g._edgeTrainerKana('ｵﾄｶﾜ') === 'オトカワ' && g._edgeTrainerKana('おとかわ　じろう') === 'おとかわ じろう');
  ok('K1-8 シートが無いときもカレンダー定義のトレーナーは kana 空で返す（今と同じ）', (() => { const r = byId(gasCtx(null)._edgeTrainers()); return r.T1 && r.T1.kana === ''; })());
}

// ================= K2 /ingest → D1 trainers.kana =================
async function ingest(rows) {
  const res = await worker.fetch(new Request('https://w.example/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ingest-Secret': SECRET },
    body: JSON.stringify({ kind: 'trainers', scope: 'all', batchId: Date.now(), rows, final: true }) }), env, { waitUntil() {} });
  return { status: res.status, body: await res.text() };
}
{
  const base = [
    { trainer_id: 'T1', name: '乙川 二郎', name_en: '', calendar_id: '', line_user_id: 'U_T1', role: 'trainer', active: 1, hidden: 0, kana: 'おとかわ じろう' },
    { trainer_id: 'T2', name: '丁村 三郎', name_en: '', calendar_id: '', line_user_id: 'U_T2', role: 'trainer', active: 1, hidden: 0, kana: '' },
    { trainer_id: 'OWN', name: '店主', name_en: '', calendar_id: '', line_user_id: 'U_OWN', role: 'owner', active: 1, hidden: 1, kana: '' },
  ];
  const r = await ingest(base);
  ok('K2-1 ★kana つきの押し出しが通り D1 に入る', r.status === 200 && (q1(`SELECT kana FROM trainers WHERE trainer_id='T1'`) || {}).kana === 'おとかわ じろう', r.status + ' ' + r.body.slice(0, 200));
  //   古い GAS（kana を送らない）でも通る＝NULL（GAS の反映より Worker が先に出る）
  const old = base.map((x) => { const o = Object.assign({}, x); delete o.kana; return o; });
  const r2 = await ingest(old);
  ok('K2-2 ★kana を送らない古い GAS の押し出しも通る（kana は NULL）', r2.status === 200 && q1(`SELECT kana FROM trainers WHERE trainer_id='T1'`).kana === null, r2.status + ' ' + r2.body.slice(0, 200));
  await ingest(base);
}

// ================= K3 k_aiDraft：読みを伏せて送る（入口から）=================
db.exec(`INSERT INTO customers (customer_id, name, kana, line_user_id, default_trainer_id, created_at, updated_at) VALUES ('C1', '甲野 一郎', 'コウノ イチロウ', 'U_C1', 'T1', 1, 1)`);
const nowMs = Date.now();
db.exec(`INSERT OR REPLACE INTO sync_state (key, synced_at, rows, ok) VALUES ('customers', ${nowMs}, 1, 1), ('trainers', ${nowMs}, 3, 1), ('reservations', ${nowMs}, 0, 1)`);
const calls = [];
const draft = () => ({
  exercises: [{ name: 'ベンチプレス', heard: 'ベンチプレス', note: '', sets: [
    { weight_kg: 20, reps: 10, evidence: '20キロで10回', note: '' },
    { weight_kg: 60, reps: 5, evidence: '次60キロで5回', note: '' }] }],
  coaching: [], hearing: [], caution: [], member_message: '', member_todo: [],
});
globalThis.fetch = async (url, opt) => {
  calls.push({ url: String(url), raw: opt.body });
  return { status: 200, json: async () => ({ stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 }, content: [{ type: 'text', text: JSON.stringify(draft()) }] }) };
};
const ON = { KARTE_AI_DRAFT: 'allow', KARTE_AI_DRAFT_TRAINERS: 'T1', ANTHROPIC_API_KEY: 'TEST-KEY-NOT-REAL' };
const setEnv = (o) => { for (const k of ['KARTE_AI_DRAFT', 'KARTE_AI_DRAFT_TRAINERS', 'ANTHROPIC_API_KEY', 'KARTE_AI_MODEL', 'KARTE_AI_DAILY_MAX']) delete env[k]; Object.assign(env, o); };
const SPOKEN = 'おとかわです。じろうって呼んでください。オトカワが担当します。ベンチプレス20キロで10回。';
async function aiCall(text) {
  const tok = await token('U_T1');
  const res = await worker.fetch(new Request('https://w.example/karte/ai-draft', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ action: 'k_aiDraft', idToken: tok, customerId: 'C1', text, known: ['ベンチプレス'] }) }), env, { waitUntil() {} });
  const raw = await res.text(); let j = {}; try { j = JSON.parse(raw); } catch (_) {}
  return { status: res.status, raw, ...j };
}
{
  setEnv(ON);
  const r = await aiCall(SPOKEN);
  const sent = calls.length ? calls[calls.length - 1].raw : '';
  ok('K3-1 成功 200', r.status === 200 && r.success === true, r.raw.slice(0, 200));
  ok('K3-2 ★トレーナーの読み（ひらがな・カタカナ・名だけ）を伏せて送る', calls.length === 1 && !sent.includes('おとかわ') && !sent.includes('オトカワ') && !sent.includes('じろう') && sent.includes('〔トレーナー〕'),
     ['おとかわ', 'オトカワ', 'じろう'].filter((x) => sent.includes(x)).join(','));
  ok('K3-3 数字の照合は伏せた文字起こしのまま通る（20×10 は確かめたセット）', r.draft && r.draft.exercises[0].sets.length === 1 && r.draft.exercises[0].unverified.length === 1);
  const lg = q1('SELECT * FROM karte_ai_log ORDER BY id DESC LIMIT 1');
  ok('K3-4 ★記録に確かめたセット数（n_sets）と確かめられない数（n_unverified）が残る・中身は無い', lg && lg.result === 'ok' && lg.n_sets === 1 && lg.n_unverified === 1 && !JSON.stringify(lg).includes('おとかわ'), JSON.stringify(lg));
  //   読みが空・NULL＝今と同じ（伏せられない・止めない）
  db.exec(`UPDATE trainers SET kana = NULL`);
  await aiCall(SPOKEN);
  const sent2 = calls[calls.length - 1].raw;
  ok('K3-5 ★読みが登録されていなければ今と同じ（送る・かな書きは残る＝画面の案内のとおり）', calls.length === 2 && sent2.includes('おとかわ'));
  db.exec(`UPDATE trainers SET kana = '' WHERE trainer_id = 'T1'`);
  const r6 = await aiCall(SPOKEN);
  ok('K3-6 読みが空文字でも同じ・落ちない', r6.status === 200 && calls.length === 3);
  //   ★D1 に数字の読みが入っても（古い・壊れた押し出し）伏せる処理に使わない＝根拠の数字を消さない
  db.exec(`UPDATE trainers SET kana = '10' WHERE trainer_id = 'T1'`);
  const r7 = await aiCall(SPOKEN);
  ok('K3-7 ★かな以外の読み（10）は使わない：20キロで10回は確かめたセットのまま', r7.status === 200 && calls[calls.length - 1].raw.includes('10回') && r7.draft.exercises[0].sets.length === 1, r7.raw.slice(0, 200));
  db.exec(`UPDATE trainers SET kana = 'おとかわ じろう' WHERE trainer_id = 'T1'`);
}

// ================= M 本番の反映の順序（schema.sql → migrations を1回ずつ・エラーを握りつぶさない）=================
{
  //   ★worker-deploy.yml は既存の D1 に schema.sql を流してから未適用の migration を流す（set -e）。
  //     CREATE TABLE IF NOT EXISTS は既存の表に列を足さない＝0031/0032 の ALTER は重複しない（関門② 指摘1 を実測で確かめた）
  const m = new DatabaseSync(':memory:');
  const cur = readFileSync(join(W, 'schema.sql'), 'utf8');
  const old = cur.split('\n').filter((l) => !/^\s+kana\s+TEXT,.*migration 0031/.test(l)).join('\n');   // trainers の行だけ（customers.kana は残す）
  ok('M0 古い schema.sql（kana の行を除いたもの）を作れた', old !== cur);
  m.exec(old);
  for (const f of readdirSync(join(W, 'migrations')).filter((x) => x.endsWith('.sql') && x < '0031').sort()) {
    try { m.exec(readFileSync(join(W, 'migrations', f), 'utf8')); } catch (e) { if (!/duplicate column/.test(e.message)) throw e; }
  }
  const cols = (t) => m.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name);
  const had = cols('trainers').includes('kana');
  m.exec(cur);   // 新しい schema.sql を既存の D1 に
  const afterSchema = cols('trainers').includes('kana');
  let err = '';
  try { for (const f of ['0031_trainers_kana.sql', '0032_karte_ai_log_sets.sql']) m.exec(readFileSync(join(W, 'migrations', f), 'utf8')); } catch (e) { err = e.message; }
  ok('M1 ★既存の D1：schema.sql では kana が足されず、0031・0032 がエラーなく通り、列がそろう', !had && !afterSchema && !err && cols('trainers').includes('kana') && cols('karte_ai_log').includes('n_sets'), JSON.stringify({ had, afterSchema, err }));
}

// ================= H 点検の窓口（/quota/status?karteai=1）=================
const H = 3600000;
function jstMidnight(ms) { const d = new Date(ms + 9 * H); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 9 * H; }
const today0 = jstMidnight(Date.now());
const yday0 = today0 - 24 * H;
const ydayKey = (() => { const d = new Date(yday0 + 9 * H); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`; })();
async function status(q, secret = SECRET) {
  const res = await worker.fetch(new Request('https://w.example/quota/status' + q, { method: 'GET', headers: { 'X-Ingest-Secret': secret } }), env, { waitUntil() {} });
  const raw = await res.text(); let j = {}; try { j = JSON.parse(raw); } catch (_) {}
  return { status: res.status, raw, j };
}
function addLog(at, result, o = {}) {
  db.prepare(`INSERT INTO karte_ai_log (at, trainer_id, model, chars_in, ms, result, n_ex, n_unverified, n_sets, build) VALUES (?, 'T1', 'm', 10, 5, ?, ?, ?, ?, 'b')`)
    .run(at, result, o.nEx == null ? null : o.nEx, o.nUnv == null ? null : o.nUnv, o.nSets === undefined ? null : o.nSets);
}
{
  const bad = await status('?karteai=1', 'WRONG');
  ok('H0 ★合言葉が違えば 403', bad.status === 403);
  db.exec('DELETE FROM karte_ai_log'); db.exec('DELETE FROM karte_ai_usage');
  setEnv({});
  const a = await status('?karteai=1');
  const k = a.j.karteAi || {};
  ok('H1 ★切替 off・前日0件：mode off・total 0・table ok', a.status === 200 && k.mode === 'off' && k.total === 0 && k.table === 'ok' && k.day === ydayKey, a.raw.slice(0, 300));
  ok('H1b 読みの登録数（有効なトレーナー3名のうち未登録2名）', k.kana && k.kana.table === 'ok' && k.kana.active === 3 && k.kana.missing === 2, JSON.stringify(k.kana));
  //   前日の範囲だけ数える（今日・一昨日は数えない）
  addLog(yday0 + 1000, 'ok', { nEx: 2, nUnv: 1, nSets: 3 });
  addLog(yday0 + 2000, 'ok', { nEx: 1, nUnv: 3, nSets: 1 });
  addLog(yday0 + 3000, 'ok', { nEx: 1, nUnv: 2 });            // 古い版（n_sets NULL）＝割合に入れない
  addLog(yday0 + 4000, 'http_error');
  addLog(yday0 + 5000, 'refused');
  addLog(yday0 + 6000, 'daily_limit');
  addLog(yday0 + 7000, 'off');
  addLog(today0 - 1, 'timeout');                             // 前日の最後の1ミリ秒
  addLog(today0, 'error');                                   // 今日＝数えない
  addLog(yday0 - 1, 'bad_output');                           // 一昨日＝数えない
  db.prepare('INSERT INTO karte_ai_usage (day, n) VALUES (?, ?)').run(ydayKey, 30);
  setEnv(ON);
  const b = await status('?karteai=1');
  const kb = b.j.karteAi || {};
  const br = kb.byResult || {};
  ok('H2 ★前日（JST）の結果別件数', br.ok === 3 && br.http_error === 1 && br.refused === 1 && br.daily_limit === 1 && br.off === 1 && br.timeout === 1 && !br.error && !br.bad_output && kb.total === 8, JSON.stringify(br));
  ok('H3 ★確かめられない数字の割合＝n_sets のある成功だけ（4/(4+4)）・数えた成功の回数', kb.unverified && kb.unverified.unv === 4 && kb.unverified.sets === 4 && kb.unverified.runs === 2 && kb.unverified.runsNoSets === 1, JSON.stringify(kb.unverified));
  ok('H4 ★1日の回数（API の前に数えた回数）と上限・到達', kb.usage === 30 && kb.dailyMax === 30 && kb.limitHit === true, JSON.stringify([kb.usage, kb.dailyMax, kb.limitHit]));
  ok('H5 mode allow・許可の人数だけ（trainer_id を出さない）・鍵の有無は真偽値だけ', kb.mode === 'allow' && kb.allowCount === 1 && kb.keySet === true && !b.raw.includes('T1') && !b.raw.includes('TEST-KEY'), b.raw.slice(0, 400));
  ok('H6 ★氏名・読みが出ない', !b.raw.includes('乙川') && !b.raw.includes('おとかわ') && !b.raw.includes('丁村'));
  //   表が読めない＝答えない（0件と言わない）
  db.exec(`UPDATE trainers SET kana = '10' WHERE trainer_id = 'T2'`);
  const kb2 = (await status('?karteai=1')).j.karteAi || {};
  ok('H6b ★伏せる処理が使わない読み（10）は未登録と数える（点検と伏せる処理の判定が同じ）', kb2.kana && kb2.kana.missing === 2 && kb2.kana.active === 3, JSON.stringify(kb2.kana));
  db.exec(`UPDATE trainers SET kana = '' WHERE trainer_id = 'T2'`);
  dbFail = 'FROM karte_ai_log';
  const c = await status('?karteai=1');
  ok('H7 ★記録が読めないときは table error・total を出さない（0件と答えない）', c.status === 200 && c.j.karteAi && c.j.karteAi.table === 'error' && c.j.karteAi.total == null && c.j.karteAi.mode === 'allow', c.raw.slice(0, 300));
  dbFail = 'FROM trainers';
  const d = await status('?karteai=1');
  ok('H8 読みの登録数が読めないときは kana.table error（数を出さない）', d.j.karteAi && d.j.karteAi.kana && d.j.karteAi.kana.table === 'error' && d.j.karteAi.kana.missing == null);
  dbFail = null;
  db.exec('DELETE FROM karte_ai_usage');
  const e = await status('?karteai=1');
  ok('H9 上限に当たっていなければ limitHit は daily_limit の記録だけで決まる（usage 0）', e.j.karteAi.usage === 0 && e.j.karteAi.limitHit === true);
  db.exec(`DELETE FROM karte_ai_log WHERE result = 'daily_limit'`);
  const f = await status('?karteai=1');
  ok('H10 daily_limit も無く回数も上限未満なら limitHit false', f.j.karteAi.limitHit === false);
  const plain = await status('');
  ok('H11 クエリなしの /quota/status は今のまま（karteAi を足さない）', plain.status === 200 && !('karteAi' in plain.j));
}

// ================= G GAS の判定 lbKarteAiDailyCheck =================
{
  const g = gasCtx([]);
  const chk = (st) => JSON.parse(JSON.stringify(g.lbKarteAiDailyCheck(st)));
  const keys = (out) => out.map((x) => x.key + ':' + x.severity);
  const base = (o) => ({ karteAi: Object.assign({ table: 'ok', day: '2026-11-11', mode: 'off', allowCount: 0, keySet: false, total: 0, byResult: {}, unverified: { unv: 0, sets: 0, runs: 0, runsNoSets: 0 }, usage: 0, dailyMax: 30, limitHit: false, kana: { table: 'ok', active: 3, missing: 3 }, build: 'x' }, o) });
  const g1 = chk(base({}));
  ok('G1 ★off で0件＝「未使用」の info だけ（注意にしない）', keys(g1).join() === 'karte_ai_unused:info' && /未使用/.test(g1[0].detail), JSON.stringify(g1));
  const g2 = chk(base({ mode: 'allow', keySet: true, total: 4, byResult: { ok: 4 }, unverified: { unv: 1, sets: 9, runs: 4, runsNoSets: 0 }, usage: 4, kana: { table: 'ok', active: 3, missing: 0 } }));
  ok('G2 使った日：結果別の件数・確かめられない割合（10%）・回数を info で出す・注意なし', keys(g2).join() === 'karte_ai_counts:info' && g2[0].count === 4 && /ok:4/.test(g2[0].detail) && /10%/.test(g2[0].detail) && /4\/30/.test(g2[0].detail), JSON.stringify(g2));
  const g3 = chk(base({ mode: 'on', keySet: true, total: 5, byResult: { ok: 2, http_error: 2, timeout: 1 }, usage: 5, kana: { table: 'ok', active: 3, missing: 0 } }));
  ok('G3 ★失敗が続いた（失敗3回以上かつ半分以上）＝warn karte_ai_fail', keys(g3).indexOf('karte_ai_fail:warn') >= 0 && g3.find((x) => x.key === 'karte_ai_fail').count === 3, JSON.stringify(g3));
  const g3b = chk(base({ mode: 'on', keySet: true, total: 8, byResult: { ok: 6, http_error: 2 }, usage: 8, kana: { table: 'ok', active: 3, missing: 0 } }));
  ok('G3b 失敗2回（6回成功）は注意にしない', keys(g3b).indexOf('karte_ai_fail:warn') < 0);
  const g3c = chk(base({ mode: 'on', keySet: true, total: 6, byResult: { ok: 3, refused: 1, bad_output: 1, unavailable: 1 }, usage: 6, kana: { table: 'ok', active: 3, missing: 0 } }));
  ok('G3c 断られた・出力が壊れた・D1 の数えが不明も失敗に数える（3/6）', keys(g3c).indexOf('karte_ai_fail:warn') >= 0);
  const g4 = chk(base({ mode: 'on', keySet: true, total: 1, byResult: { daily_limit: 1 }, usage: 30, limitHit: true, kana: { table: 'ok', active: 3, missing: 0 } }));
  ok('G4 ★上限到達＝warn karte_ai_limit', keys(g4).indexOf('karte_ai_limit:warn') >= 0);
  const g5 = chk(base({ mode: 'allow', keySet: true, total: 1, byResult: { ok: 1 }, usage: 1, kana: { table: 'ok', active: 3, missing: 1 } }));
  ok('G5 ★切替が開いているのに読みが未登録のトレーナーがいる＝warn（かな書きが伏せられずに送られる）', keys(g5).indexOf('karte_ai_kana_missing:warn') >= 0 && g5.find((x) => x.key === 'karte_ai_kana_missing').count === 1);
  ok('G5b off のときは読みの未登録を注意にしない（未使用の行に添えるだけ）', keys(g1).indexOf('karte_ai_kana_missing:warn') < 0 && /読み/.test(g1[0].detail));
  const g6 = chk(base({ mode: 'on', keySet: false, total: 0, kana: { table: 'ok', active: 3, missing: 0 } }));
  ok('G6 ★切替が開いているのに鍵が無い＝warn karte_ai_no_key', keys(g6).indexOf('karte_ai_no_key:warn') >= 0);
  const g7 = chk(base({ mode: 'on', keySet: true, total: 0, kana: { table: 'ok', active: 3, missing: 0 } }));
  ok('G7 切替 on で0件＝info（誰も押していない）・未使用とは言わない', keys(g7).join() === 'karte_ai_idle:info', JSON.stringify(g7));
  const g8 = chk({ karteAi: { table: 'error', mode: 'on', kana: { table: 'ok', active: 3, missing: 0 } } });
  ok('G8 ★切替が開いていて記録が読めない＝warn（0件と言わない）', keys(g8).join() === 'karte_ai_unreadable:warn', JSON.stringify(g8));
  const g9 = chk({ karteAi: { table: 'error', mode: 'off', kana: { table: 'ok', active: 3, missing: 3 } } });
  ok('G9 off で記録が読めない＝info（未使用とは言わない）', keys(g9).join() === 'karte_ai_unreadable:info' && !/未使用/.test(g9[0].detail));
  const g10 = chk({ ok: true, monthly: 1 });
  ok('G10 ★窓口が karteAi を返さない（Worker が古い）＝warn karte_ai_unreadable', keys(g10).join() === 'karte_ai_unreadable:warn');
  const g11 = chk(base({ mode: 'on', keySet: true, total: 1, byResult: { ok: 1 }, usage: 1, kana: { table: 'error' } }));
  ok('G11 切替が開いていて読みの登録数が読めない＝warn', keys(g11).indexOf('karte_ai_kana_missing:warn') >= 0);
  const g12 = chk(base({ mode: 'off', total: 2, byResult: { off: 2 } }));
  ok('G12 off でも記録があれば件数を info で出す（古い画面が押した）・注意なし', keys(g12).join() === 'karte_ai_counts:info');
  ok('G13 出力に trainer_id・氏名を入れない（返すのは key・severity・count・detail）', g5.every((x) => Object.keys(x).sort().join() === 'count,detail,key,severity'));
}

// ================= G-wire dailyHealthCheck の配線 =================
{
  const fn = pluckFn(LB, 'dailyHealthCheck');
  ok('GW1 ★dailyHealthCheck が窓口（?karteai=1）を読み lbKarteAiDailyCheck の結果を add する', /lbKarteAiDailyCheck\(_edgeQuotaStatus\('\?karteai=1'\)\)/.test(fn) && /_step\('カルテのAI'\)/.test(fn));
  ok('GW2 窓口が読めないときも点検は続ける（catch で warn）', /karte_ai_check_fail/.test(fn));
  const builds = JSON.parse(readFileSync(join(HERE, 'expected-builds.json'), 'utf8'));
  ok('GW3 版の印：LB_HEALTH_BUILD・LB_EDGE_BUILD が expected-builds.json と一致し、2026-11-12 の版', LB.includes(`var LB_HEALTH_BUILD = '${builds.LB_HEALTH_BUILD}'`) && PE.includes(`var LB_EDGE_BUILD = '${builds.LB_EDGE_BUILD}'`) && /^2026-11-12/.test(builds.LB_HEALTH_BUILD) && /^2026-11-12/.test(builds.LB_EDGE_BUILD));
}

console.log(`karte-ai-kana-health: ${pass} 合格 / ${fail} 不合格`);
if (fail) process.exit(1);
