// 設計71：顧客名簿の検索をひらがなでも当てる（2026-11-28 オーナー指示）
//   実行: node worker/test/cust-search-kana.test.js
//
//   G GAS：名簿 customer_line_map の見出し kana の列（R 以降）だけを読む → getTrainerReservations の customers と押し出しの行に kana
//   W Worker：押し出し（/ingest）→ D1 customers.kana → compatTrainerReservations の customers に kana。★GAS と同じ鍵・同じ値
//   S 画面：本番の liff/index.html を jsdom で走らせ、トレーナーの顧客一覧の検索欄に打つ（入口から）
//   ★名前は架空（山田 太郎 など）。実在の会員を書かない（I73）

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';
import worker from '../src/index.js';
import * as compat from '../src/routes/compat.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const W = join(HERE, '..');
const ROOT = join(W, '..');
const SECRET = 'TEST-INGEST-SECRET';

let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) pass++; else { fail++; console.log(`❌ ${name}${detail ? '\n   ' + detail : ''}`); } }

// ================= G GAS =================
const PE = readFileSync(join(ROOT, 'gas/PushToEdge.js'), 'utf8');
const LB = readFileSync(join(ROOT, 'gas/LineBooking.js'), 'utf8');
function pluckFn(src, name) {
  const m = src.match(new RegExp('\\nfunction ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('見つからない: ' + name);
  return m[0];
}
const MAP_COL = vm.runInNewContext('(' + (LB.match(/\nvar MAP_COL = (\{[\s\S]*?\});/) || [])[1] + ')');
const HEAD17 = ['line_user_id', 'customer_id', 'name', 'phone', 'trainer_id', 'contract_type', 'contract_stat', 'auth_state', 'linked_at',
  'code_hash', 'code_expire', 'try_count', 'note', 'email', 'birthday', 'goal', 'lang'];
ok('G0 名簿の列（MAP_COL）を本番のコードから読めた・A〜Q の17列', MAP_COL && MAP_COL.LANG === 17 && HEAD17.length === 17);
//   1行＝[A..Q] ＋ 後ろの列
function mrow(cid, name, tid, extra, auth) {
  const r = ['U' + cid, cid, name, '', tid, '', 'active', auth || 'verified', '', '', '', '', '', '', '', '', ''];
  return r.concat(extra || []);
}
function gasCtx(rows) {
  const ctx = {
    String, Number, JSON, Math, Object, Date, isFinite,
    MAP_COL, LINE_BOOKING: { MAP_SHEET: 'customer_line_map' },
    _edgeIdOrNull: (v) => (v ? String(v) : null),
    _lbSheet: () => (rows == null ? null : {
      getLastRow: () => rows.length,
      getLastColumn: () => Math.max(...rows.map((r) => r.length)),
      getRange: (r, c, nr, nc) => ({ getValues: () => rows.slice(r - 1, r - 1 + nr).map((row) => { const o = []; for (let i = 0; i < nc; i++) o.push(row[c - 1 + i] === undefined ? '' : row[c - 1 + i]); return o; }) }),
    }),
  };
  vm.createContext(ctx);
  for (const n of ['_edgeTrainerKana', '_edgeCustomers', '_edgeVerifiedLineByRow']) vm.runInContext(pluckFn(PE, n), ctx);
  for (const n of ['_lbCustKanaCol', '_lbTrainerCustomers', '_lbAllVerifiedCustomers']) vm.runInContext(pluckFn(LB, n), ctx);
  return ctx;
}
const byId = (arr, k) => { const o = {}; for (const r of arr) o[r[k || 'customerId']] = r; return o; };
const SHEET = [HEAD17.concat(['kana']),
  mrow('C1', '山田 太郎', 'T1', [' やまだ たろう ']),
  mrow('C2', '鈴木 花子', '', ['スズキ ハナコ']),
  mrow('C3', '佐藤 次郎', 'T1', ['']),
  mrow('C4', 'タナカ イチロウ', 'T1', []),
  mrow('C5', '高橋 三郎', 'T1', ['たかはし3']),
  mrow('C6', '伊藤 四郎', 'T2', ['いとう しろう']),
  mrow('C7', '渡辺 五郎', 'T1', ['わたなべ'], 'pending'),
];
{
  const g = gasCtx(SHEET);
  const mine = byId(g._lbTrainerCustomers('T1'));
  ok('G1-1 ★担当の一覧に kana（前後の空白は落とす）', mine.C1 && mine.C1.kana === 'やまだ たろう', JSON.stringify(mine.C1));
  ok('G1-2 カタカナの読みはそのまま', mine.C2 && mine.C2.kana === 'スズキ ハナコ');
  ok('G1-3 空欄・列が短い行は空文字', mine.C3.kana === '' && mine.C4.kana === '');
  ok('G1-4 ★かな以外（数字）を含む読みは空文字（照合に使わない）', mine.C5.kana === '');
  ok('G1-5 担当の範囲は今と同じ（他の担当・未照合は出ない）', !mine.C6 && !mine.C7 && Object.keys(mine).length === 5, Object.keys(mine).join(','));
  ok('G1-6 鍵は customerId・name・kana の3つだけ', Object.keys(mine.C1).sort().join(',') === 'customerId,kana,name');
  const all = byId(g._lbAllVerifiedCustomers());
  ok('G1-7 オーナーの一覧にも kana・範囲は今と同じ', all.C6 && all.C6.kana === 'いとう しろう' && !all.C7 && Object.keys(all).length === 6);
  const push = byId(g._edgeCustomers(), 'customer_id');
  ok('G1-8 ★押し出しの行にも同じ kana（未照合の行も行は送る＝今と同じ）', push.C1.kana === 'やまだ たろう' && push.C5.kana === '' && push.C7 && push.C7.kana === 'わたなべ', JSON.stringify(push.C1));
}
{
  const noKana = [HEAD17].concat(SHEET.slice(1).map((r) => r.slice(0, 17)));
  const g = gasCtx(noKana);
  const mine = g._lbTrainerCustomers('T1');
  ok('G2-1 ★見出しに kana が無い名簿＝全員 kana は空文字・名前は今と同じ', mine.length === 5 && mine.every((c) => c.kana === '') && byId(mine).C1.name === '山田 太郎');
  ok('G2-2 押し出しも空文字', g._edgeCustomers().every((c) => c.kana === ''));
  const inA = [HEAD17.slice(0, 2).concat(['kana']).concat(HEAD17.slice(3))].concat([mrow('C1', 'やまだ', 'T1')]);
  ok('G2-3 A〜Q（既存の列）の見出しが kana でも読まない', gasCtx(inA)._lbTrainerCustomers('T1')[0].kana === '');
  const other = [HEAD17.concat(['メモ', ' KANA '])].concat([mrow('C1', '山田 太郎', 'T1', ['べつ', 'ヤマダ'])]);
  ok('G2-4 位置を決め打ちしない：R に別の列があっても見出し kana（大文字・空白を無視）の列を読む', gasCtx(other)._lbTrainerCustomers('T1')[0].kana === 'ヤマダ');
  ok('G2-5 名簿が無い／見出しだけ＝空（今と同じ）', gasCtx(null)._lbTrainerCustomers('T1').length === 0 && gasCtx([HEAD17])._lbAllVerifiedCustomers().length === 0);
}

// ================= W Worker（実物の SQLite・全 migration）=================
const db = new DatabaseSync(':memory:');
db.exec(readFileSync(join(W, 'schema.sql'), 'utf8'));
for (const f of readdirSync(join(W, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
  try { db.exec(readFileSync(join(W, 'migrations', f), 'utf8')); } catch (e) { if (!/duplicate column/.test(e.message)) throw e; }
}
const exec = (q, args, how) => {
  const st = db.prepare(q);
  if (how === 'first') { const r = st.get(...args); return r === undefined ? null : Object.assign({}, r); }
  if (how === 'all') return { results: st.all(...args).map((r) => Object.assign({}, r)) };
  const r = st.run(...args);
  return { meta: { changes: Number(r.changes) } };
};
const env = { SHARED_SECRET: SECRET, _kv: {} };
env.KV = { async get(k, t) { const v = env._kv[k]; return v == null ? null : (t === 'json' ? JSON.parse(v) : v); }, async put(k, v) { env._kv[k] = v; } };
env.DB = {
  prepare(q) { return { _q: q, _args: [], bind(...a) { this._args = a; return this; }, async run() { return exec(q, this._args, 'run'); }, async first() { return exec(q, this._args, 'first'); }, async all() { return exec(q, this._args, 'all'); } }; },
  async batch(stmts) { db.exec('BEGIN'); try { const o = stmts.map((s) => exec(s._q, s._args, 'run')); db.exec('COMMIT'); return o; } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; } },
};
async function ingest(rows) {
  const res = await worker.fetch(new Request('https://w.example/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ingest-Secret': SECRET },
    body: JSON.stringify({ kind: 'customers', scope: 'all', batchId: Date.now(), rows, final: true }) }), env, { waitUntil() {} });
  return { status: res.status, body: await res.text() };
}
const fresh = () => { const n = Date.now(); db.exec(`INSERT OR REPLACE INTO sync_state (key, synced_at, rows, ok) VALUES ('customers', ${n}, 1, 1), ('trainers', ${n}, 1, 1), ('reservations', ${n}, 0, 1)`); };
const TR = { role: 'trainer', trainerId: 'T1', name: '架空一郎' };
const OWN = { role: 'owner', trainerId: 'OWN', name: '店主' };
const pick = (arr) => arr.map((c) => ({ customerId: c.customerId, name: c.name, kana: c.kana })).sort((a, b) => (a.customerId < b.customerId ? -1 : 1));
{
  const g = gasCtx(SHEET);
  const r = await ingest(g._edgeCustomers());
  fresh();
  ok('W1-0 押し出しが通る', r.status === 200, r.status + ' ' + r.body.slice(0, 200));
  const wt = await compat.compatTrainerReservations({ env, who: TR, body: {}, ctx: { waitUntil() {} } });
  ok('W1-1 D1 から答えた（落ちていない）', wt && !wt._fallback && Array.isArray(wt.customers), JSON.stringify(wt).slice(0, 200));
  const wc = byId(wt.customers || []);
  ok('W1-2 ★Worker の customers に kana（GAS と同じ値）', wc.C1 && wc.C1.kana === 'やまだ たろう' && wc.C3 && wc.C3.kana === '', JSON.stringify(wc.C1));
  //   ★同じ鍵・同じ値：GAS の一覧と、Worker の一覧の customerId/name/kana を突き合わせる（範囲は Worker が退会で絞る・未照合は D1 に行があるので Worker 側の範囲で比べる）
  const gasMine = byId(g._lbTrainerCustomers('T1'));
  const both = (wt.customers || []).filter((c) => gasMine[c.customerId]);
  ok('W1-3 ★GAS と Worker で、同じ会員の name と kana が一致する（担当の一覧）', both.length === 5 && JSON.stringify(pick(both)) === JSON.stringify(pick(Object.values(gasMine))), JSON.stringify(pick(both)) + '\n   ' + JSON.stringify(pick(Object.values(gasMine))));
  ok('W1-4 ★どちらも kana の鍵を必ず持つ（空でも文字列）', (wt.customers || []).every((c) => typeof c.kana === 'string') && Object.values(gasMine).every((c) => typeof c.kana === 'string'));
  const wo = await compat.compatTrainerReservations({ env, who: OWN, body: {}, ctx: { waitUntil() {} } });
  const gasAll = byId(g._lbAllVerifiedCustomers());
  const bothO = (wo.customers || []).filter((c) => gasAll[c.customerId]);
  ok('W1-5 ★オーナーの一覧でも一致する', bothO.length === 6 && JSON.stringify(pick(bothO)) === JSON.stringify(pick(Object.values(gasAll))));
  //   古い GAS（kana を送らない）＝NULL → 空文字
  const old = g._edgeCustomers().map((x) => { const o = Object.assign({}, x); delete o.kana; return o; });
  const r2 = await ingest(old); fresh();
  const w2 = await compat.compatTrainerReservations({ env, who: TR, body: {}, ctx: { waitUntil() {} } });
  ok('W1-6 ★kana を送らない古い GAS の押し出しでも通り、Worker は kana を空文字で返す', r2.status === 200 && (w2.customers || []).length >= 5 && (w2.customers || []).every((c) => c.kana === ''), JSON.stringify(w2.customers).slice(0, 200));
}

// ================= S 画面（入口から）=================
const require = createRequire(join(homedir(), '.cache/claude-node/package.json'));
const { JSDOM } = require('jsdom');
const HTML = readFileSync(join(ROOT, 'liff/index.html'), 'utf8');
const STYLE = HTML.slice(HTML.indexOf('<style>') + 7, HTML.indexOf('</style>'));
const BODY = HTML.slice(HTML.indexOf('<body'), HTML.indexOf('<script'));
const S0 = HTML.indexOf('<script>\n') + 9;
let SRC = HTML.slice(S0, HTML.indexOf('</script>', S0));
const API_HEAD = '  function api(params){\n';
const BOOT_HEAD = '  function fetchBoot(){\n';
ok('S0 本番のスクリプトから api と fetchBoot の入口が1つずつ見つかる', SRC.split(API_HEAD).length === 2 && SRC.split(BOOT_HEAD).length === 2);
SRC = SRC.replace(API_HEAD, '  function api(params){ return window.__api(params); }\n  function __realApi(params){\n')
         .replace(BOOT_HEAD, '  function fetchBoot(){ return window.__boot(); }\n  function __realBoot(){\n');
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 12; i++) await tick(); }
const CUSTS = [
  { customerId: 'C1', name: '山田 太郎', kana: 'やまだ たろう' },
  { customerId: 'C2', name: '鈴木 花子', kana: 'スズキ ハナコ' },
  { customerId: 'C3', name: '佐藤 次郎', kana: '' },
  { customerId: 'C4', name: 'タナカ イチロウ' },
];
function bootT(custs) {
  const dom = new JSDOM('<!doctype html><html><head><style>' + STYLE + '</style></head>' + BODY + '</html>', { runScripts: 'outside-only', url: 'https://reservation.tokowaka-gym.com/liff/', pretendToBeVisual: true });
  const w = dom.window;
  w.confirm = () => true; w.alert = () => {};
  const st = w.setTimeout.bind(w); w.setTimeout = (f, ms) => st(f, Math.min(ms || 0, 3));
  try { w.localStorage.setItem('tkw_lang', 'ja'); } catch (e) {}
  const H = { line_getTrainerReservations: { success: true, reservations: [], customers: custs }, line_getTrainers: { success: true, trainers: [] } };
  w.__api = (p) => Promise.resolve(JSON.parse(JSON.stringify(H[p.action] || { success: true })));
  w.__boot = () => Promise.resolve({ success: true, role: 'trainer', trainerId: 'T1', trainerName: '架空一郎', isOwner: false });
  w.liff = { init: () => Promise.resolve(), isLoggedIn: () => true, getIDToken: () => 'tok', getAppLanguage: () => 'ja', getLanguage: () => 'ja', closeWindow() {}, isInClient: () => true };
  w.eval(SRC);
  return w;
}
const searchBox = (w) => w.document.querySelector('#tadminList input[aria-label="顧客名で検索"]');
function shown(w, q) {
  const s = searchBox(w);
  s.value = q; s.dispatchEvent(new w.Event('input', { bubbles: true }));
  return [...w.document.querySelectorAll('#tadminList .slist .srow')].filter((b) => b.style.display !== 'none' && b.querySelector('.nm'))
    .map((b) => b.querySelector('.nm').textContent.replace(/ 様$/, '')).join('|');
}
{
  const w = bootT(CUSTS); await settle();
  ok('S1-0 トレーナーの顧客一覧と検索欄が出る', !!searchBox(w), [...w.document.querySelectorAll('.screen')].filter((s) => !s.hidden).map((s) => s.id).join(','));
  const cases = [
    ['やまだ', '山田 太郎'], ['ヤマダ', '山田 太郎'], ['ﾔﾏﾀﾞ', '山田 太郎'], ['山田　太郎', '山田 太郎'], ['山田太郎', '山田 太郎'],
    ['やまだたろう', '山田 太郎'], ['ヤマダ　タロウ', '山田 太郎'], ['たろう', '山田 太郎'],
    ['すずき', '鈴木 花子'], ['ｽｽﾞｷ', '鈴木 花子'],
    ['佐藤', '佐藤 次郎'], ['さとう', ''],
    ['たなか', 'タナカ イチロウ'], ['ﾀﾅｶｲﾁﾛｳ', 'タナカ イチロウ'],
    ['', '山田 太郎|鈴木 花子|佐藤 次郎|タナカ イチロウ'], ['　 ', '山田 太郎|鈴木 花子|佐藤 次郎|タナカ イチロウ'],
  ];
  for (const [q, want] of cases) {
    const got = shown(w, q);
    ok('S1 「' + q + '」→「' + want + '」', got === want, '実際：' + got);
  }
  const txt = w.document.getElementById('tadminList').textContent;
  ok('S1-9 ★読みは画面に出さない（照合にだけ使う）', !txt.includes('やまだ') && !txt.includes('スズキ'));
}
{
  //   ★古い GAS の応答（kana の鍵が無い）＝今どおり漢字で探せる・落ちない
  const w = bootT(CUSTS.map((c) => ({ customerId: c.customerId, name: c.name }))); await settle();
  ok('S2-1 kana が無くても漢字で当たる', shown(w, '山田') === '山田 太郎');
  ok('S2-2 kana が無ければ、ひらがなは名前のかなにだけ当たる（今の名前だけで探す動き＋表記ゆれ）', shown(w, 'やまだ') === '' && shown(w, 'たなか') === 'タナカ イチロウ');
}

console.log(`${fail ? '❌' : '✅'} cust-search-kana: ${pass} 通過 / ${fail} 失敗`);
process.exit(fail ? 1 : 0);
