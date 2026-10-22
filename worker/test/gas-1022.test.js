// 設計21（決定0092）の GAS 側を、実際に動かして確かめる。
//   実行: node worker/test/gas-1022.test.js
//
//   ① 予約一覧の送信にも番号を載せる・予約0件でも送る（rows:[]・customerId）
//   ② 写しと予約一覧の送信結果を共通の関数で持ち、両方失敗のときだけ記録する
//   ③ 両方失敗の記録の保存規則（24時間・満杯でも既存は更新・入れ替えと overflow・壊れた値）
//   ④ 許可表の作業依頼：下4桁 → 名簿でちょうど1名のときだけ足す・出力にフル ID を出さない

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PE = readFileSync(join(ROOT, 'gas/PushToEdge.js'), 'utf8');
const LB = readFileSync(join(ROOT, 'gas/LineBooking.js'), 'utf8');
let pass = 0, fail = 0;
function ok(name, cond, why) { if (cond) pass++; else { fail++; console.log(`❌ ${name}`); if (why) console.log(`   ${why}`); } }
function pluckFn(src, name) {
  const m = src.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('見つからない: ' + name);
  return m[0];
}
function props(init) {
  const m = new Map(Object.entries(init || {}));
  return { m, svc: { getScriptProperties: () => ({ getProperty: (k) => (m.has(k) ? m.get(k) : null), setProperty: (k, v) => m.set(k, String(v)) }) } };
}

console.log('=== ① 予約一覧の送信 ===');
{
  const mk = (resv, postOk = true) => {
    const posts = [], rowsCalls = [];
    const ctx = { String, Number, Math, Date,
      _edgeReservations: () => resv,
      _edgePost: (b) => { posts.push(b); return { success: postOk }; },
      _edgePushRows: (k, rows, b, o) => { rowsCalls.push({ k, n: rows.length, o }); if (!postOk) throw new Error('x'); return '1件'; } };
    vm.createContext(ctx); vm.runInContext(pluckFn(PE, '_edgePushReservationsFor'), ctx);
    return { f: ctx._edgePushReservationsFor, posts, rowsCalls };
  };
  let t = mk([]);
  ok('①-1 ★予約0件でも番号があれば送る（rows:[]・customerId・dirtySeq）', t.f('C1', 7) === true && t.posts.length === 1
     && t.posts[0].rows.length === 0 && t.posts[0].customerId === 'C1' && t.posts[0].dirtySeq === 7 && t.posts[0].scope === 'partial', JSON.stringify(t.posts));
  t = mk([]);
  ok('①-2 予約0件・番号なしは送らない（成功）', t.f('C1', null) === true && t.posts.length === 0);
  t = mk([], false);
  ok('①-3 ★送れなかったら false（成功扱いにしない）', t.f('C1', 7) === false);
  t = mk([{ customer_id: 'C1' }, { customer_id: 'C2' }]);
  ok('①-4 予約があれば本人の分を番号と会員つきで送る', t.f('C1', 7) === true && t.rowsCalls[0].n === 1
     && t.rowsCalls[0].o.dirtySeq === 7 && t.rowsCalls[0].o.customerId === 'C1', JSON.stringify(t.rowsCalls));
  t = mk(null);
  ok('①-5 台帳が読めなければ false', t.f('C1', 7) === false);
  //   _edgePushRows：予約一覧は会員つきでだけ番号を載せる
  const posts = [];
  const ctx = { String, Number, JSON, Object, Array, Math, Date, Logger: { log: () => {} },
    EDGE: { CHUNK: 100 }, _edgeDedupe: (k, r) => r, _edgePost: (b) => { posts.push(b); return { success: true }; } };
  vm.createContext(ctx); vm.runInContext(pluckFn(PE, '_edgePushRows'), ctx);
  ctx._edgePushRows('reservations', [{ customer_id: 'C1' }], 1, { scope: 'partial', dirtySeq: 5, customerId: 'C1' });
  ctx._edgePushRows('reservations', [{ customer_id: 'C1' }], 2, { scope: 'partial', dirtySeq: 5 });
  ok('①-6 予約一覧の送信に番号と会員を載せる', posts[0].dirtySeq === 5 && posts[0].customerId === 'C1');
  ok('①-7 会員が無ければ番号を載せない（Worker が断るため）', !('dirtySeq' in posts[1]));
}

console.log('=== ② 送信結果を共通の関数で ===');
{
  const run = (home, resv) => {
    const noted = [];
    const ctx = { pushToEdgeHomeFor: () => { if (home === 'throw') throw new Error('x'); return home; },
                  _edgePushReservationsFor: () => resv, _lbNoteBothFail: (c) => noted.push(c) };
    vm.createContext(ctx); vm.runInContext(pluckFn(PE, '_edgeSendAfterWrite'), ctx);
    return { r: ctx._edgeSendAfterWrite('C1', 'x', 3), noted };
  };
  let x = run(false, true);
  ok('②-1 写しだけ失敗では記録しない', !x.r.bothFailed && x.noted.length === 0);
  x = run(true, false);
  ok('②-2 予約一覧だけ失敗では記録しない', !x.r.bothFailed && x.noted.length === 0);
  x = run(false, false);
  ok('②-3 ★両方失敗のときだけ記録する', x.r.bothFailed && x.noted.join() === 'C1');
  x = run('throw', false);
  ok('②-4 例外も失敗として数える', x.r.bothFailed && x.noted.length === 1);
  ok('②-5 ★中央出口も中央出口外も同じ関数を使う',
     /var _sent = _edgeSendAfterWrite\(cid, nm,/.test(PE) && /return _edgeSendAfterWrite\(customerId, nm, seq\);/.test(PE));
}

console.log('=== ③ 両方失敗の記録の保存規則 ===');
{
  const mk = (init, opts = {}) => {
    const p = props(init);
    const ctx = { String, Number, JSON, Object, Math, Date, Array, isFinite, PropertiesService: p.svc,
      LockService: { getScriptLock: () => ({ hasLock: () => !!opts.held, tryLock: () => opts.lockFail ? false : true, releaseLock: () => {} }) },
      LB_BOTH_FAIL_PROP: 'LB_EDGE_AFTER_WRITE_BOTH_FAIL', LB_BOTH_FAIL_MAX: 20 };
    vm.createContext(ctx); vm.runInContext(pluckFn(PE, '_lbNoteBothFail'), ctx);
    return { f: ctx._lbNoteBothFail, p: p.m, get: () => JSON.parse(p.m.get('LB_EDGE_AFTER_WRITE_BOTH_FAIL') || '{}') };
  };
  const now = 1_800_000_000_000;
  let t = mk();
  t.f('C1', now); t.f('C1', now + 1000);
  ok('③-1 同じ会員は回数と最後の時刻を更新', t.get().items.C1.n === 2 && t.get().items.C1.first === now && t.get().items.C1.last === now + 1000);
  const full = { items: {}, overflow: 0 };
  for (let i = 0; i < 20; i++) full.items['C' + i] = { first: now - i, last: now - i, n: 1 };
  t = mk({ LB_EDGE_AFTER_WRITE_BOTH_FAIL: JSON.stringify(full) });
  t.f('C5', now + 5);
  ok('③-2 ★満杯でも既にいる会員は更新される', t.get().items.C5.n === 2 && Object.keys(t.get().items).length === 20 && t.get().overflow === 0);
  t.f('CNEW', now + 6);
  ok('③-3 ★新しい会員で満杯なら最も古い項目と入れ替え overflow が増える', t.get().items.CNEW && !t.get().items.C19 && t.get().overflow === 1, JSON.stringify(Object.keys(t.get().items)));
  t.f('CNEW2', now + 7);
  ok('③-4 overflow は減らない', t.get().overflow === 2);
  t = mk({ LB_EDGE_AFTER_WRITE_BOTH_FAIL: JSON.stringify({ items: { COLD: { first: 1, last: now - 90000000, n: 3 } }, overflow: 0 }) });
  t.f('C1', now);
  ok('③-5 24時間より古い項目は除く', !t.get().items.COLD && t.get().items.C1);
  t = mk({ LB_EDGE_AFTER_WRITE_BOTH_FAIL: '{壊れた' });
  t.f('C1', now);
  ok('③-6 ★壊れた値は BROKEN を残し、書き換えない（調べるために残す）', /^1800000000000 BAD_JSON/.test(t.p.get('LB_EDGE_AFTER_WRITE_BOTH_FAIL_BROKEN') || '')
     && t.p.get('LB_EDGE_AFTER_WRITE_BOTH_FAIL') === '{壊れた');
  for (const [bad, why] of [[JSON.stringify({ items: [], overflow: 0 }), 'BAD_ITEMS'], [JSON.stringify({ items: {}, overflow: 'x' }), 'BAD_OVERFLOW'],
                            [JSON.stringify([1]), 'BAD_SHAPE'], [JSON.stringify({ items: {}, overflow: -1 }), 'BAD_OVERFLOW']]) {
    t = mk({ LB_EDGE_AFTER_WRITE_BOTH_FAIL: bad });
    const r = t.f('C1', now);
    ok('③-6b ★形が壊れていたら（' + why + '）書き換えず BROKEN', r === false && (t.p.get('LB_EDGE_AFTER_WRITE_BOTH_FAIL_BROKEN') || '').indexOf(why) > 0
       && t.p.get('LB_EDGE_AFTER_WRITE_BOTH_FAIL') === bad, t.p.get('LB_EDGE_AFTER_WRITE_BOTH_FAIL_BROKEN'));
  }
  t = mk({}, { lockFail: true });
  ok('③-6c ★ロックが取れなければ書き換えず BROKEN（LOCK_MISS）', t.f('C1', now) === false && !t.p.get('LB_EDGE_AFTER_WRITE_BOTH_FAIL')
     && /LOCK_MISS/.test(t.p.get('LB_EDGE_AFTER_WRITE_BOTH_FAIL_BROKEN') || ''));
  t = mk({}, { held: true, lockFail: true });
  ok('③-6d 既にロックを持っていれば書ける', t.f('C1', now) === true && t.get().items.C1);
  ok('③-7 ★点検の出力は下4桁だけ', /'会員#' \+ String\(_bk\)\.slice\(-4\)/.test(LB) && !/push\(_bk \+/.test(LB));
}

console.log('=== ④ 許可表の作業依頼 ===');
{
  const mk = (customers, resp) => {
    const calls = [];
    const ctx = { String, Number, JSON, Math,
      _edgeProp: (k) => (k === 'EDGE_URL' ? 'https://w' : 'S'),
      _edgeCustomers: () => customers,
      UrlFetchApp: { fetch: (u, o) => { calls.push({ u, body: JSON.parse(o.payload) }); return { getResponseCode: () => 200, getContentText: () => JSON.stringify(resp || { ok: true, changed: 1 }) }; } } };
    vm.createContext(ctx);
    vm.runInContext(pluckFn(PE, '_edgeRemainAllowCall') + '\n' + pluckFn(PE, '_edgeD1AllowText'), ctx);
    return { f: ctx._edgeD1AllowText, calls };
  };
  let t = mk([{ customer_id: 'C20260903214526' }, { customer_id: 'C20260913112249' }]);
  const o1 = t.f({ d1Allow: '*4526' });
  ok('④-1 ★名簿でちょうど1名ならフル ID を本文で送る', t.calls.length === 1 && t.calls[0].body.action === 'add' && t.calls[0].body.customerId === 'C20260903214526');
  ok('④-2 ★結果にフル ID を出さない', o1.indexOf('C20260903214526') < 0 && o1.indexOf('*4526') >= 0, o1);
  t = mk([{ customer_id: 'C11114526' }, { customer_id: 'C22224526' }]);
  const o2 = t.f({ d1Allow: '*4526' });
  ok('④-3 ★2名いれば何もしない', t.calls.length === 0 && /2名/.test(o2) && o2.indexOf('C1111') < 0);
  t = mk(null);
  ok('④-4 名簿が読めなければ何もしない', t.f({ d1Allow: '*4526' }).indexOf('読めません') >= 0 && t.calls.length === 0);
  t = mk([]);
  ok('④-5 形が違えば何もしない', t.f({ d1Allow: '4526' }).indexOf('形が違います') >= 0 && t.calls.length === 0);
  t = mk([], { ok: true, changed: 1 });
  t.f({ d1Remove: '*4526' });
  ok('④-6 外すときは下4桁だけを送る（名簿を引かない）', t.calls[0].body.action === 'remove' && t.calls[0].body.customer === '*4526' && !('customerId' in t.calls[0].body));
}

console.log(`\n${fail ? '❌' : '✅'} 設計21 GAS 側 検証: ${pass} passed / ${fail} failed`);
if (fail) process.exit(1);
