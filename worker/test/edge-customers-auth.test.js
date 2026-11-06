// 会員の LINE ID は照合済み（verified）の行だけ D1 へ送る（設計35 改訂1-6・2026-11-06）
//
//   ★なぜ要るのか
//     Worker の resolveRole は customers.line_user_id だけで customer と決める（auth_state を見ない）。
//     押し出し（_edgeCustomers）が pending／rejected／merged の行の LINE ID まで送っていたため、
//     未承認の人が D1 では会員として扱われる経路があった。
//
//   本物の gas/PushToEdge.js から関数を取り出し、シートの身代わりで動かす。
//   ★氏名・フルIDは書かない（値はすべて架空の記号）。
//
//   実行: node worker/test/edge-customers-auth.test.js

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PE = readFileSync(join(ROOT, 'gas/PushToEdge.js'), 'utf8');
const LB = readFileSync(join(ROOT, 'gas/LineBooking.js'), 'utf8');
const EJ = readFileSync(join(ROOT, 'gas/EdgeJob.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, why) {
  if (cond) { pass++; return; }
  fail++; console.log(`❌ ${name}`); if (why) console.log(`   ${why}`);
}
function pluckFn(src, name) {
  const m = src.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('見つからない: ' + name);
  return m[0];
}
function pluckVar(src, name) {
  const m = src.match(new RegExp('var ' + name + ' = (\\{[\\s\\S]*?\\n\\}|\'[^\']*\');'));
  if (!m) throw new Error('見つからない: ' + name);
  return m[0];
}

// ---------- シートの身代わり ----------
//   MAP_COL は本物（LineBooking.js）から取る。列の番号を検査側で決め打ちしない。
const mapCtx = {}; vm.createContext(mapCtx); vm.runInContext(pluckVar(LB, 'MAP_COL'), mapCtx);
const MAP_COL = mapCtx.MAP_COL;
const WIDTH = 17;
function row({ line = '', cid = '', auth = '' }) {
  const r = new Array(WIDTH).fill('');
  r[MAP_COL.LINE_USER_ID - 1] = line;
  r[MAP_COL.CUSTOMER_ID - 1] = cid;
  r[MAP_COL.NAME - 1] = 'N';
  r[MAP_COL.AUTH_STATE - 1] = auth;
  r[MAP_COL.LINKED_AT - 1] = new Date(1700000000000);
  return r;
}
function env(rows, { noSheet = false } = {}) {
  const sheet = {
    getLastRow: () => rows.length + 1,
    getLastColumn: () => WIDTH,
    getRange: (r, c, nr, nc) => ({ getValues: () => rows.slice(r - 2, r - 2 + nr).map((x) => x.slice(c - 1, c - 1 + nc)) }),
  };
  const ctx = {
    String, Number, Object, Array, Date, Math, JSON,
    Logger: { log: () => {} },
    MAP_COL, LINE_BOOKING: { MAP_SHEET: 'customer_line_map' },
    _lbSheet: () => (noSheet ? null : sheet),
  };
  vm.createContext(ctx);
  vm.runInContext(pluckVar(PE, 'LB_EDGE_BUILD'), ctx);
  for (const n of ['_edgeIdOrNull', '_edgeVerifiedLineByRow', '_edgeCustomers', '_edgeCustomersForPush',
                   '_edgeAuthAudit', '_edgeAuthAuditText']) vm.runInContext(pluckFn(PE, n), ctx);
  return ctx;
}

// 架空の LINE ID（形だけ U+32桁）
const L = (c) => 'U' + c.repeat(32);
const ROWS = [
  row({ line: L('a'), cid: 'C01', auth: 'verified' }),
  row({ line: L('b'), cid: 'C02', auth: 'pending' }),
  row({ line: L('c'), cid: 'C03', auth: 'rejected' }),
  row({ line: '',     cid: 'C04', auth: 'verified' }),     // LINE を使わない会員（代理登録）
  row({ line: L('d'), cid: 'C05', auth: 'pending' }),      // 同じ LINE ID の pending 行（先）
  row({ line: L('d'), cid: 'C06', auth: 'verified' }),     // 同じ LINE ID の verified 行（後）
  row({ line: L('e'), cid: 'C07', auth: 'verified' }),     // verified が2行（先）
  row({ line: L('e'), cid: 'C08', auth: 'verified' }),     // verified が2行（後）
  row({ line: L('f'), cid: 'C09', auth: 'merged' }),
  row({ line: L('g'), cid: '',    auth: 'verified' }),     // customer_id の無い行は送らない（今までどおり）
  row({ line: ' ' + L('h') + ' ', cid: 'C10', auth: 'verified' }),   // 前後の空白は落とす
];

console.log('=== 1. _edgeCustomers：送る line_user_id ===');
{
  const ctx = env(ROWS);
  const out = ctx._edgeCustomers();
  const by = Object.fromEntries(out.map((r) => [r.customer_id, r.line_user_id]));
  ok('1-1 verified は LINE ID を送る', by.C01 === L('a'));
  ok('1-2 ★pending は null', by.C02 === null, String(by.C02));
  ok('1-3 ★rejected は null', by.C03 === null);
  ok('1-4 LINE ID の無い verified は null', by.C04 === null);
  ok('1-5 ★同じ ID の pending 行は null・verified 行が送る', by.C05 === null && by.C06 === L('d'));
  ok('1-6 ★verified が2行なら先の行だけ（getCustomerByLine と同じ）', by.C07 === L('e') && by.C08 === null);
  ok('1-7 merged は null', by.C09 === null);
  ok('1-8 前後の空白は落として送る', by.C10 === L('h'));
  ok('1-9 ★行そのものは全部送る（customer_id の無い行だけ除く）',
     out.length === 10 && out.map((r) => r.customer_id).join(',') === 'C01,C02,C03,C04,C05,C06,C07,C08,C09,C10',
     out.map((r) => r.customer_id).join(','));
  const ids = out.map((r) => r.line_user_id).filter(Boolean);
  ok('1-10 ★送る LINE ID に重複が無い（D1 の UNIQUE を破らない）', new Set(ids).size === ids.length, ids.join(','));
  ok('1-11 他の列は今までどおり', out[0].name === 'N' && out[0].created_at === 1700000000000 && out[0].updated_at === 1700000000000);
  ok('1-12 シートが読めなければ null（0件と言わない）', env([], { noSheet: true })._edgeCustomers() === null);
}

console.log('=== 2. 押し出しの順（外す行を先に）===');
{
  const ctx = env(ROWS);
  const out = ctx._edgeCustomers();
  const p = ctx._edgeCustomersForPush(out);
  const firstLine = p.findIndex((r) => r.line_user_id);
  ok('2-1 null の行が全部先', p.slice(firstLine).every((r) => r.line_user_id) && p.slice(0, firstLine).every((r) => !r.line_user_id));
  ok('2-2 行の数は変えない', p.length === out.length);
  ok('2-3 _edgeCustomers 自体の順は変えない（残数の続き番号のため）', out[0].customer_id === 'C01' && out[1].customer_id === 'C02');
  ok('2-4 null は null のまま', ctx._edgeCustomersForPush(null) === null);
  ok('2-5 ★配線：customers の押し出しは _edgeCustomersForPush を通す',
     /_edgePushRowsF\('customers', _edgeCustomersForPush\(customers\),/.test(PE)
     && (PE.match(/_edgePushRowsF\('customers'/g) || []).length === 1);

  // 本物の SQLite で、ingest と同じ形の upsert を1つの transaction で順に流す。
  //   D1 に「pending の行が L(d) を持ったまま」残っているところへ、verified の行が L(d) を取りに来る。
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE customers (customer_id TEXT PRIMARY KEY, line_user_id TEXT UNIQUE, synced_at INTEGER)`);
  db.exec(`INSERT INTO customers VALUES ('C05', '${L('d')}', 1), ('C06', NULL, 1)`);
  const up = db.prepare(`INSERT INTO customers (customer_id, line_user_id, synced_at) VALUES (?, ?, ?)
     ON CONFLICT(customer_id) DO UPDATE SET line_user_id = excluded.line_user_id, synced_at = excluded.synced_at
     WHERE customers.synced_at IS NULL OR excluded.synced_at >= customers.synced_at`);
  function apply(rows) {
    db.exec('BEGIN');
    try { for (const r of rows) up.run(r.customer_id, r.line_user_id, 2); db.exec('COMMIT'); return true; }
    catch (e) { db.exec('ROLLBACK'); return false; }
  }
  const pair = out.filter((r) => r.customer_id === 'C05' || r.customer_id === 'C06');
  ok('2-6 （前提）verified を先に書くと UNIQUE で落ちる', apply([pair[1], pair[0]]) === false);
  ok('2-7 ★外す行を先に並べれば通る', apply(ctx._edgeCustomersForPush([pair[1], pair[0]])) === true);
  const got = db.prepare('SELECT customer_id, line_user_id FROM customers ORDER BY customer_id').all();
  ok('2-8 D1 では verified の行だけが LINE ID を持つ', got[0].line_user_id === null && got[1].line_user_id === L('d'), JSON.stringify(got.map((g) => !!g.line_user_id)));
}

console.log('=== 3. _edgeAuthAudit：件数だけ ===');
{
  const ctx = env(ROWS);
  const r = ctx._edgeAuthAudit();
  ok('3-1 会員の行', r.rows === 10);
  ok('3-2 ★verified でなく LINE ID あり（pending2・rejected1・merged1）', r.unverifiedWithLine === 4, String(r.unverifiedWithLine));
  ok('3-3 verified で LINE ID あり', r.verifiedWithLine === 5, String(r.verifiedWithLine));
  ok('3-4 同じ LINE ID が複数行', r.dupLineIds === 2, String(r.dupLineIds));
  ok('3-5 うち verified が複数', r.dupVerifiedLineIds === 1);
  ok('3-6 LINE ID を付けて送る行（_edgeCustomers と一致）',
     r.sentLine === 4 && r.sentLine === ctx._edgeCustomers().filter((x) => x.line_user_id).length);
  ok('3-7 返す鍵は件数だけ', Object.keys(r).sort().join(',') === 'dupLineIds,dupVerifiedLineIds,rows,sentLine,unverifiedWithLine,verifiedWithLine');
  const t = ctx._edgeAuthAuditText();
  ok('3-8 ★文面に LINE ID・customer_id・氏名が出ない', !/U[0-9a-f]{8}/.test(t) && !/C0\d|C10/.test(t) && !/N様|：N/.test(t), t);
  ok('3-9 文面に版の印', t.indexOf(ctx.LB_EDGE_BUILD) >= 0);
  ok('3-10 読めなければ null・文面は「数えていません」', env([], { noSheet: true })._edgeAuthAudit() === null
     && /数えていません/.test(env([], { noSheet: true })._edgeAuthAuditText()));
  ok('3-11 ログに出さない（Logger を呼ばない）', !/Logger\.log/.test(pluckFn(PE, '_edgeAuthAudit')) && !/Logger\.log/.test(pluckFn(PE, '_edgeAuthAuditText')));
}

console.log('=== 4. 作業依頼の窓口（remaining の authAudit）===');
{
  ok('4-1 新しい op を足していない（許可一覧3箇所の変更が要らない）',
     !/case 'authAudit'/.test(EJ));
  const ctx = env(ROWS);
  ctx._ejScrub = (s) => '[scrubbed]' + s;
  vm.runInContext(pluckFn(EJ, '_ejRunInner'), ctx);
  const out = ctx._ejRunInner('remaining', { authAudit: 1 });
  ok('4-2 ★remaining {authAudit} で件数の文面が返り、_ejScrub を通る', /^\[scrubbed\]/.test(out) && /verified でなく LINE ID あり 4/.test(out), out);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
