// 設計20（決定0091）の GAS 側を、実際に動かして確かめる。
//   実行: node worker/test/gas-1020.test.js
//
//   ① 通し番号：全体で1本・増えるだけ・**番号を先に保存**・壊れた値を0に戻さない
//   ② 取り置いたときの番号を固定して rebuild に送る（途中で読み直さない）
//   ③ 修復の巡回は、新しく足すときだけ番号を発行する
//   ④ 後追い処理は1名につき /quota/rebuild を1回。読めない入力は送らない。大きすぎる会員は外して記録
//   ⑤ 書き込み直後：積んだ番号を写し（home）の送信に載せる。home 以外には載せない

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PE = readFileSync(join(ROOT, 'gas/PushToEdge.js'), 'utf8');
const LB = readFileSync(join(ROOT, 'gas/LineBooking.js'), 'utf8');
const DW = (() => {
  const a = PE.indexOf('// ===== DUALWRITE:BEGIN =====');
  const b = PE.indexOf('// ===== DUALWRITE:END =====');
  return PE.slice(a, b);
})();
let pass = 0, fail = 0;
function ok(name, cond, why) { if (cond) pass++; else { fail++; console.log(`❌ ${name}`); if (why) console.log(`   ${why}`); } }
function pluckFn(src, name) {
  const m = src.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('見つからない: ' + name);
  return m[0];
}

function makeGas(o = {}) {
  const props = new Map(Object.entries(o.props || {}));
  const writes = [];   // setProperty の順番
  const fetches = [];
  const logs = [];
  let lockHeld = false;
  const g = {
    _opCalls: 0,
    String, Number, JSON, Object, Array, Math, Date, isFinite,
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (props.has(k) ? props.get(k) : null),
      setProperty: (k, v) => {
        if (o.failSet && o.failSet(k)) throw new Error('quota');
        writes.push(k); props.set(k, String(v));
      },
    }) },
    LockService: { getScriptLock: () => ({ tryLock() { if (lockHeld) return false; lockHeld = true; return true; }, releaseLock() { lockHeld = false; } }) },
    Logger: { log: (m) => logs.push(String(m)) },
    SETTINGS: { TIMEZONE: 'Asia/Tokyo' },
    Utilities: { formatDate: () => '10/20 12:00' },
    _edgeEnabled: () => true,
    _edgeProp: (k) => (k === 'EDGE_URL' ? 'https://w' : 'S'),
    _edgePost: () => ({ success: true }),
    _edgeCalcReservations: () => {
      if (o.onLedgerRead) o.onLedgerRead(props);   // 取り置いた後・台帳を読む時点で別の書き込みが来た状態を作る
      return (o.ledger === undefined ? [{ customer_id: 'C1', row_key: 'r1', row_json: '[1]' }] : o.ledger);
    },
    _edgeCalcContracts: (cs) => (o.contracts === undefined ? [{ row_key: cs[0].customer_id + '#3', customer_id: cs[0].customer_id, idx: 3, row_json: '[]' }] : (typeof o.contracts === 'function' ? o.contracts() : o.contracts)),
    _edgeWithSheetCache: (fn) => fn(),
    _edgeNameByCustomerId: () => '山田太郎',
    _lbMonthKeyJst: () => '2026-10',
    _lbMemberOpeningWithFloor: () => {
      g._opCalls = (g._opCalls || 0) + 1;
      if (o.openingThrows) throw new Error('read');
      if (o.openingThrowsOnCall && g._opCalls === o.openingThrowsOnCall) throw new Error('read');
      return o.opening === undefined ? { recordsFrom: '2026-09' } : o.opening;
    },
    _edgeQuotaVerify: () => ({ done: true, checked: 0, differ: 0, skipped: 0 }),
    UrlFetchApp: { fetch: (url, opt) => {
      fetches.push({ url, body: opt && opt.payload ? JSON.parse(opt.payload) : null });
      const r = o.respond ? o.respond(url) : { code: 200, body: { ok: true, blocked: false, ms: 10, statements: 9 } };
      return { getResponseCode: () => r.code, getContentText: () => JSON.stringify(r.body) };
    } },
  };
  const names = ['LB_DW', 'lbDwEnqueue', '_lbDwClaim', '_lbDwDone', '_lbDwReadQueue', '_lbDwWriteQueue',
                 '_lbDwNextSeqInLock', '_lbDwEnsureQueuedInLock', '_lbDwLocked', 'lbDualWriteDrain', '_edgeRebuildOne'];
  const keys = Object.keys(g);
  const fn = new Function(...keys, `${DW}\n;return {${names.join(',')}};`);
  const api = fn(...keys.map((k) => g[k]));
  return { ...api, props, writes, fetches, logs, q: () => JSON.parse(props.get(api.LB_DW.QUEUE_PROP) || '{}') };
}

console.log('=== ① 通し番号 ===');
{
  const t = makeGas();
  const a = t.lbDwEnqueue('C1'), b = t.lbDwEnqueue('C2'), c = t.lbDwEnqueue('C1');
  ok('①-1 積むたびに番号が増える（全体で1本）', a === 1 && b === 2 && c === 3, `${a},${b},${c}`);
  ok('①-2 待ち行列の行に最新の番号が載る', t.q().C1.seq === 3 && t.q().C2.seq === 2, JSON.stringify(t.q()));
  ok('①-3 ★番号を先に保存してから待ち行列を保存する',
     t.writes.indexOf('LB_DW_SEQ') >= 0 && t.writes.indexOf('LB_DW_SEQ') < t.writes.indexOf(t.LB_DW.QUEUE_PROP), t.writes.join(','));
  const t2 = makeGas({ props: { LB_DW_SEQ: 'abc' } });
  const r2 = t2.lbDwEnqueue('C1');
  ok('①-4 ★壊れた番号は0に戻さず、積まない（溢れとして数える）', r2 === false && t2.props.get('LB_DW_SEQ') === 'abc'
     && Number(t2.props.get(t2.LB_DW.OVERFLOW_PROP)) === 1, String(r2));
  const t3 = makeGas({ failSet: (k) => k === 'LB_DW_SEQ' });
  ok('①-5 番号の保存に失敗したら積まない', t3.lbDwEnqueue('C1') === false && !t3.props.get(t3.LB_DW.QUEUE_PROP));
}

console.log('=== ② 取り置いた番号を固定する ===');
{
  const t = makeGas();
  t.lbDwEnqueue('C1');                                    // seq=1
  const cl = t._lbDwClaim(5);
  ok('②-1 取り置きの結果に番号が載る', cl.items.length === 1 && cl.items[0].seq === 1, JSON.stringify(cl));
  //   番号が無い古い行（反映前に積まれた）
  const t2 = makeGas({ props: { LB_DW_SEQ: '7' } });
  t2.props.set(t2.LB_DW.QUEUE_PROP, JSON.stringify({ C9: { version: 2, queuedAt: 1 } }));
  const cl2 = t2._lbDwClaim(5);
  ok('②-2 番号の無い古い行は、いまの番号で取り置く', cl2.items[0].seq === 7, JSON.stringify(cl2));
  const t3 = makeGas();
  t3.props.set(t3.LB_DW.QUEUE_PROP, JSON.stringify({ C9: { version: 2, queuedAt: 1 } }));
  const cl3 = t3._lbDwClaim(5);
  ok('②-3 いまの番号が0なら1つ発行して使う', cl3.items[0].seq === 1 && t3.props.get('LB_DW_SEQ') === '1');
  //   ★処理中に書き込みが来ても、送るのは取り置いたときの番号
  //   ★取り置いた後（台帳を読む時点）で、別の会員への書き込みで全体の番号が 9 に進んだ状態を作る
  const t4 = makeGas({ respond: () => ({ code: 200, body: { ok: true, blocked: false } }),
                       onLedgerRead: (props) => props.set('LB_DW_SEQ', '9') });
  t4.lbDwEnqueue('C1');                                   // seq=1
  const origFetch = t4.fetches;
  const run = t4.lbDualWriteDrain(5);
  ok('②-4 後追い処理は1名につき1回だけ送る', origFetch.length === 1 && /\/quota\/rebuild$/.test(origFetch[0].url), JSON.stringify(origFetch.map((x) => x.url)));
  ok('②-5 ★送る番号は取り置いたときの番号', origFetch[0].body.seq === 1, JSON.stringify(origFetch[0].body.seq));
  ok('②-6 契約・予約・棚卸しを一緒に送る', Array.isArray(origFetch[0].body.contracts) && Array.isArray(origFetch[0].body.reservations)
     && 'opening' in origFetch[0].body && run.done === 1, JSON.stringify(run));
}
{
  //   ★処理の途中で同じ会員に書き込み → 送る番号は古いまま・終わったら REQUEUED
  const t = makeGas();
  t.lbDwEnqueue('C1');                                    // seq=1, version=1
  let midWrite = false;
  const t2 = makeGas({ respond: () => {
    if (!midWrite) { midWrite = true; t2.lbDwEnqueue('C1'); }   // 送信中に新しい書き込み（seq=2, version=2）
    return { code: 200, body: { ok: true, blocked: false } };
  } });
  t2.lbDwEnqueue('C1');
  const r = t2.lbDualWriteDrain(5);
  ok('②-7 ★途中で書き込みが来たら、送ったのは古い番号で REQUEUED（次の処理で新しい番号）',
     t2.fetches[0].body.seq === 1 && r.requeued === 1 && t2.q().C1 && t2.q().C1.seq === 2, JSON.stringify(r));
}

console.log('=== ③ 修復の巡回の番号 ===');
{
  const t = makeGas({ props: { LB_DW_SEQ: '10' } });
  t.lbDwEnqueue('C1');                                     // seq=11
  const before = t.q().C1.seq;
  const r = t._lbDwLocked(function () { return t._lbDwEnsureQueuedInLock(['C1', 'C2']); });
  ok('③-1 新しく足す会員にだけ番号を発行する', r.status === 'ADDED' && r.added === 1 && t.q().C2.seq === 12, JSON.stringify(r) + JSON.stringify(t.q()));
  ok('③-2 ★既にいる会員の番号は書き換えない', t.q().C1.seq === before);
  const r2 = t._lbDwLocked(function () { return t._lbDwEnsureQueuedInLock(['C1']); });
  ok('③-3 全員いれば番号を発行しない', r2.status === 'EXISTS' && t.props.get('LB_DW_SEQ') === '12');
}

console.log('=== ④ 1名の作り直し（_edgeRebuildOne）===');
{
  const t = makeGas({ openingThrows: true });
  ok('④-1 ★棚卸しが読めない（例外）ときは送らない', t._edgeRebuildOne('C1', [], 3) === 'FAIL' && t.fetches.length === 0);
  //   棚卸しは1回だけ読み、記録開始月に使ったものをそのまま送る（関門②：2回読むと食い違いうる）
  const tb = makeGas({ openingThrowsOnCall: 2, opening: { recordsFrom: '2026-09', carry: { x: 1 } } });
  const rb = tb._edgeRebuildOne('C1', [], 3);
  ok('④-1b 棚卸しは1回だけ読み、そのまま送る', rb === 'OK' && tb.fetches.length === 1
     && JSON.parse(tb.fetches[0].body.opening.payload).carry.x === 1, rb);
  const t2 = makeGas({ contracts: null });
  ok('④-2 契約が読めないときは送らない', t2._edgeRebuildOne('C1', [], 3) === 'FAIL' && t2.fetches.length === 0);
  const t3 = makeGas({ contracts: () => { throw new Error('契約の照合に失敗（山田太郎）'); } });
  t3._edgeRebuildOne('C1', [], 3);
  ok('④-3 契約が紐付けられないときは送らない・理由に氏名を残さない', t3.fetches.length === 0 && t3.logs.join('').indexOf('山田') < 0);
  const t4 = makeGas();
  ok('④-4 台帳が null なら送らない', t4._edgeRebuildOne('C1', null, 3) === 'FAIL' && t4.fetches.length === 0);
  ok('④-5 番号が無ければ送らない', t4._edgeRebuildOne('C1', [], 0) === 'FAIL' && t4.fetches.length === 0);
  const t5 = makeGas({ opening: null });
  t5._edgeRebuildOne('C1', [], 3);
  ok('④-6 棚卸しが無い（null）は送る＝記録開始月が無いので作らない', t5.fetches.length === 0);
  const t6 = makeGas();
  const r6 = t6._edgeRebuildOne('C1', [{ customer_id: 'C2', row_key: 'x', row_json: '[]' }, { customer_id: 'C1', row_key: 'y', row_json: '[]' }], 3);
  ok('④-7 予約は本人の分だけ送る', r6 === 'OK' && t6.fetches[0].body.reservations.length === 1 && t6.fetches[0].body.reservations[0].row_key === 'y');
  const t7 = makeGas({ respond: () => ({ code: 413, body: { ok: false, code: 'TOO_LARGE', kind: 'reservations', count: 900 } }) });
  ok('④-8 大きすぎれば TOO_LARGE', t7._edgeRebuildOne('C1', [], 3) === 'TOO_LARGE');
  const t8 = makeGas({ respond: () => ({ code: 200, body: { ok: true, blocked: true, issues: [{ code: 'OPENING_PACK_UNRESOLVED' }] } }) });
  ok('④-9 問題があれば成功としない', t8._edgeRebuildOne('C1', [], 3) === 'FAIL');
  //   ★大きすぎる会員は待ち行列から外し、点検用に下4桁で残す
  const t9 = makeGas({ respond: () => ({ code: 413, body: { ok: false, code: 'TOO_LARGE' } }) });
  t9.lbDwEnqueue('C20260903214526');
  t9.lbDualWriteDrain(5);
  const tl = JSON.parse(t9.props.get('LB_DW_TOO_LARGE') || '[]');
  ok('④-10 ★大きすぎる会員は待ち行列から外し、下4桁で記録する（再試行の輪にしない）',
     !t9.q().C20260903214526 && tl.length === 1 && tl[0].who === '会員#4526', JSON.stringify(tl));
  //   ★ログに本文を出さない
  const t10 = makeGas({ respond: () => ({ code: 500, body: { ok: false, code: 'X', detail: '山田太郎様' } }) });
  t10._edgeRebuildOne('C1', [], 3);
  ok('④-11 ★応答の本文をログに出さない', t10.logs.join('').indexOf('山田') < 0);
}

console.log('=== ⑤ 書き込み直後の写しに番号を載せる ===');
{
  //   _edgePushRows：home にだけ載せる
  const posts = [];
  const ctx = { String, Number, JSON, Object, Array, Math, Date, Logger: { log: () => {} },
    EDGE: { CHUNK: 100 }, _edgeDedupe: (k, r) => r, _edgePost: (b) => { posts.push(b); return { success: true, written: 1 }; } };
  vm.createContext(ctx);
  vm.runInContext(pluckFn(PE, '_edgePushRows'), ctx);
  ctx._edgePushRows('home', [{ customer_id: 'C1' }], 1, { scope: 'partial', dirtySeq: 5 });
  ctx._edgePushRows('home', [{ customer_id: 'C1' }], 2, { scope: 'partial', dirtySeq: null });
  ctx._edgePushRows('reservations', [{ customer_id: 'C1' }], 3, { scope: 'partial', dirtySeq: 5 });
  ok('⑤-1 ★home の送信に番号を明示的に載せる', posts[0].dirtySeq === 5, JSON.stringify(posts[0]));
  ok('⑤-2 番号が無ければ載せない（定期の写しと同じ）', !('dirtySeq' in posts[1]));
  ok('⑤-3 home 以外には載せない', !('dirtySeq' in posts[2]));
  //   edgeAfterWrite：積んだ番号を写しに渡す（順番は 積む → 写し）
  const calls = [];
  const ctx2 = { String, Number, Logger: { log: () => {} },
    EDGE_AFTER_WRITE: { line_addTicketRefill: 1 }, EDGE_CALSYNC_AFTER: {},
    _edgeEnabled: () => true, _lbScheduleCalSync: () => {}, getCustomerByLine: () => null, MAP_COL: {},
    _edgeNameByCustomerId: () => 'x',
    lbDwEnqueue: (cid) => { calls.push('enqueue'); return 42; },
    pushToEdgeHomeFor: (cid, nm, seq) => { calls.push('home:' + seq); return true; },
    _edgePushReservationsFor: () => true };
  vm.createContext(ctx2);
  vm.runInContext(pluckFn(PE, 'edgeAfterWrite'), ctx2);
  ctx2.edgeAfterWrite('line_addTicketRefill', { customerId: 'C1' }, { success: true, customerId: 'C1' }, 'U1');
  ok('⑤-4 ★積んだ番号を写しに渡す（積む → 写し）', calls.join(',') === 'enqueue,home:42', calls.join(','));
  const calls2 = [];
  ctx2.lbDwEnqueue = () => { calls2.push('enqueue'); return false; };
  ctx2.pushToEdgeHomeFor = (cid, nm, seq) => { calls2.push('home:' + seq); return true; };
  ctx2.edgeAfterWrite('line_addTicketRefill', { customerId: 'C1' }, { success: true, customerId: 'C1' }, 'U1');
  ok('⑤-5 積めなかったら番号は載せない（写しは送る）', calls2.join(',') === 'enqueue,home:null', calls2.join(','));
  //   中央出口を通らない書き込み（カレンダー取込・固定枠の自動予約）
  ok('⑤-6 ★カレンダー取込も積んだ番号を写しに載せる', /var _dwSeq = lbDwEnqueue\(_dwCid\);\s*_lbDwMarkDirty\(_dwCid, _dwSeq\);/.test(LB));
  ok('⑤-7 ★固定枠の自動予約も同じ', /_lbDwMarkDirty\(c2, lbDwEnqueue\(c2\)\)/.test(LB));
  const ctx3 = { Logger: { log: () => {} }, _edgeNameByCustomerId: () => 'x', pushToEdgeHomeFor: () => { throw new Error('x'); } };
  vm.createContext(ctx3);
  vm.runInContext(pluckFn(PE, '_lbDwMarkDirty'), ctx3);
  ok('⑤-8 印の送信が失敗しても例外を外に出さない', ctx3._lbDwMarkDirty('C1', 3) === false);
  ok('⑤-9 番号が無ければ何もしない', ctx3._lbDwMarkDirty('C1', false) === false);
}

console.log(`\n${fail ? '❌' : '✅'} 設計20 GAS 側 検証: ${pass} passed / ${fail} failed`);
if (fail) process.exit(1);
