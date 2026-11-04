// 棚卸しの材料（_edgeOpening）は、1名でも読めなければ送らない（設計30・Codex 関門②）・2026-11-04
//   実行: node worker/test/gas-opening-fail.test.js
//   ★抜かしたまま scope:'all' で送ると Worker が「全件届いた」と印を押し、古い棚卸しで D1 が答え続ける
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const PE = readFileSync(join(ROOT, 'gas/PushToEdge.js'), 'utf8');
const LB = readFileSync(join(ROOT, 'gas/LineBooking.js'), 'utf8');
let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) pass++; else { fail++; console.log(`❌ ${name}${detail ? '\n   ' + detail : ''}`); } }
function pluckFn(src, name) {
  const m = src.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('見つからない: ' + name);
  return m[0];
}
function load(opening) {
  const ctx = { _lbMemberOpeningWithFloor: opening, JSON, String, Error };
  vm.createContext(ctx);
  vm.runInContext(pluckFn(PE, '_edgeOpening'), ctx);
  return ctx;
}
const CS = [{ customer_id: 'C20260101000001' }, { customer_id: 'C20260101000002' }, { customer_id: 'C20260101000003' }];

{
  const c = load((cid) => (cid.endsWith('2') ? null : { carry: {}, packsUsed: {} }));
  const out = c._edgeOpening(CS);
  ok('1 棚卸しが無い会員（null）は正常に抜かす', out.length === 2 && out.every((r) => r.customer_id !== 'C20260101000002'));
}
{
  const c = load((cid) => { if (cid.endsWith('3')) throw new Error('read'); return { carry: {} }; });
  let err = null;
  try { c._edgeOpening(CS); } catch (e) { err = e; }
  ok('2 ★1名でも読めなければ全体を中止（送らない＝印が進まない）', err && /1名/.test(err.message), err && err.message);
  ok('3 ★中止の理由に氏名・フルIDを出さない（下4桁だけ）', err && err.message.includes('*0003') && !err.message.includes('C20260101000003'));
}
{
  ok('4 呼び出し側は同じ step で4つを順に送る（棚卸しが throw すれば印は進まない）',
     /step\('計算入力'[\s\S]{0,700}_edgePushRowsF\('opening', _edgeOpening\(customers\)/.test(PE));
  ok('5 ★契約の照合の失敗ログに氏名を出さない', !/契約の照合に失敗（' \+ name/.test(PE) && /契約の照合に失敗（\*' \+ String\(cid\)\.slice\(-4\)/.test(PE));
  ok('6 ★チケット補充の受信ログにフル顧客IDを出さない', /\[REFILL v3\] 受信: customerId=\*' \+ String\(customerId\)\.slice\(-4\)/.test(LB));
}
// ---------- 日次点検：材料4つの印（Worker と同じ規則） ----------
{
  const ctx = { JSON, String, Error, Math, isFinite, Date, LB_CALC_INPUT_KEYS: null };
  vm.createContext(ctx);
  vm.runInContext("var LB_CALC_INPUT_KEYS = ['calcContracts', 'calcMeta', 'calcReservations', 'opening'];", ctx);
  vm.runInContext(pluckFn(PE, 'lbCalcInputStatus'), ctx);
  const T = 1793771490063, all = (o = {}) => Object.assign({ calcContracts: T, calcMeta: T, calcReservations: T, opening: T }, o);
  ok('7 4つそろって10分前なら ok', ctx.lbCalcInputStatus(all(), T + 600000).status === 'ok');
  ok('8 ★棚卸しだけ前の回なら split（Worker が写しに倒している状態を知らせる）', ctx.lbCalcInputStatus(all({ opening: T - 900000 }), T).status === 'split');
  ok('9 ★45分ちょうどで stale', ctx.lbCalcInputStatus(all(), T + 45 * 60000).status === 'stale' && ctx.lbCalcInputStatus(all(), T + 45 * 60000 - 1).status === 'ok');
  ok('10 ★欠けは unknown', ctx.lbCalcInputStatus(all({ calcMeta: undefined }), T).status === 'unknown' && ctx.lbCalcInputStatus(all({ opening: null }), T).status === 'unknown');
  ok('11 未来5分超は unknown', ctx.lbCalcInputStatus(all(), T - 5 * 60000 - 1).status === 'unknown');
  //   Worker 側の規則と同じ数字か（45分・5分・4つの鍵）
  const RO = readFileSync(join(ROOT, 'worker/src/lib/remain-read-on.js'), 'utf8');
  ok('12 ★Worker と同じ鍵・同じ45分・同じ5分', /CALC_INPUT_KEYS = \['calcContracts', 'calcMeta', 'calcReservations', 'opening'\]/.test(RO)
     && /CALC_INPUT_MAX_AGE_MS = 45 \* 60 \* 1000/.test(RO) && /CALC_INPUT_FUTURE_MS = 5 \* 60 \* 1000/.test(RO)
     && /nowMs - at >= 45 \* 60000/.test(PE) && /at > nowMs \+ 5 \* 60000/.test(PE));
  //   入口から：lbContractInputCheck が /health の印を読んで high を出す
  const h = { sync: [{ key: 'calcContracts', synced_at: Date.now() - 60000 }, { key: 'calcMeta', synced_at: Date.now() - 60000 },
                     { key: 'calcReservations', synced_at: Date.now() - 60000 }, { key: 'opening', synced_at: Date.now() - 60000 - 900000 }] };
  const c2 = { JSON, String, Error, Math, isFinite, Date, Number,
    _edgeCustomers: () => [], _lbContractRowsAll: () => [],
    _edgeProp: () => 'https://edge.example',
    UrlFetchApp: { fetch: () => ({ getContentText: () => JSON.stringify(h) }) } };
  vm.createContext(c2);
  vm.runInContext("var LB_CALC_INPUT_KEYS = ['calcContracts', 'calcMeta', 'calcReservations', 'opening'];", c2);
  vm.runInContext(pluckFn(PE, 'lbCalcInputStatus'), c2);
  vm.runInContext(pluckFn(PE, 'lbContractInputCheck'), c2);
  const out = c2.lbContractInputCheck();
  const hit = out.find((x) => x.key === 'calc_input_split');
  ok('13 ★日次点検が「棚卸しだけ届いていない」を high で出す', hit && hit.severity === 'high' && /opening=1[56]分前/.test(hit.detail), JSON.stringify(out));
}
{
  ok('14 ★0円拒否のログに氏名・電話・フルIDを出さない', !/0円拒否\(PRICE_REQUIRED\): name=' \+ name/.test(LB) && !/phone=' \+ phone \+ ' \/ mapKind/.test(LB) && !/testLbRentalCheck\(\\\\'' \+ customerId/.test(LB));
  ok('15 ★報酬割合の警告に氏名を出さない', !/報酬割合を読めず空のまま行を作ります（' \+ name/.test(LB));
  ok('16 ★契約の照合の失敗に元の例外本文を付けない', !/契約の照合に失敗（\*' \+ String\(cid\)\.slice\(-4\) \+ '）: ' \+ e\.message/.test(PE));
}

console.log(`\n${fail ? '❌' : '✅'} 棚卸しの送信（設計30） 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
