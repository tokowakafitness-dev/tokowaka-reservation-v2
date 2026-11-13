// 設計43 B：書き込みの後の画面の動き（全体の印・枠待ちの印・書き込み中の数）を、本番の画面で入口から通す検査
//   実行: node worker/test/liff-write-latency.test.js
//
//   ★部品ではなく入口から：本番の liff/index.html のスクリプトを丸ごと jsdom で走らせ、本物の api() → _apiSend → _edgeTry を通す。
//     身代わりにするのは LINE の SDK（liff）・GAS への JSONP（_apiOnce）・Worker への fetch・起動のまとめ取得（fetchBoot）だけ。
//   1. スイッチ（?wl=1）が無ければ今と同じ（書き込みの後35分すべて GAS）
//   2. ?wl=1：枠以外は Worker・枠は slotsAfter を付けて聞き、同じ値の確認が返ったときだけ使う
//   3. 古い GAS・壊れた書き込み時刻・既存の edgeSynced・並行する書き込み・古い応答で基準を下げない
//   ★値は架空（個人情報を書かない）

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const require = createRequire(join(homedir(), '.cache/claude-node/package.json'));
const { JSDOM } = require('jsdom');
const HTML = readFileSync(join(ROOT, 'liff/index.html'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) pass++; else { fail++; console.log(`❌ ${name}${detail ? '\n   ' + detail : ''}`); } }
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 12; i++) await tick(); }

const BODY = HTML.slice(HTML.indexOf('<body'), HTML.indexOf('<script'));
const S0 = HTML.indexOf('<script>\n') + 9;
const S1 = HTML.indexOf('</script>', S0);
let SRC = HTML.slice(S0, S1);
const ONCE_HEAD = '  function _apiOnce(params){\n';
const BOOT_HEAD = '  function fetchBoot(){\n';
ok('0-1 本番のスクリプトから _apiOnce と fetchBoot の入口が1つずつ見つかる', SRC.split(ONCE_HEAD).length === 2 && SRC.split(BOOT_HEAD).length === 2);
SRC = SRC.replace(ONCE_HEAD, '  function _apiOnce(params){ return window.__gas(params); }\n  function __realOnce(params){\n')
         .replace(BOOT_HEAD, '  function fetchBoot(){ return window.__boot(); }\n  function __realBoot(){\n');

const W1 = 1795000000000, W2 = 1795000100000;
const HOME = { success: true, verified: true, name: '会員 見本', defaultTrainerId: 'T1', isPair: false, hasNormalRoute: true, home: { type: null } };

function boot(o = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head>' + BODY + '</html>', { runScripts: 'outside-only', url: o.url || 'https://reservation.tokowaka-gym.com/liff/', pretendToBeVisual: true });
  const w = dom.window;
  w.gas = []; w.edge = [];
  w.alert = () => {}; w.confirm = () => true;
  w.Element.prototype.getClientRects = function () { return [{}]; };
  w.__gasH = o.gas || {};
  w.__gas = (p) => {
    w.gas.push(JSON.parse(JSON.stringify(p)));
    const h = w.__gasH[p.action];
    const v = typeof h === 'function' ? h(p) : (h || { success: true });
    return (v && typeof v.then === 'function') ? v : Promise.resolve(JSON.parse(JSON.stringify(v)));
  };
  w.__edgeH = o.edge || {};
  w.fetch = (url, init) => {
    const b = JSON.parse(init.body);
    w.edge.push(b);
    const h = w.__edgeH[b.action];
    const v = typeof h === 'function' ? h(b) : (h || { success: true });
    return Promise.resolve({ json: () => Promise.resolve(JSON.parse(JSON.stringify(v))) });
  };
  w.__boot = () => Promise.resolve(HOME);
  w.liff = { init: () => Promise.resolve(), isLoggedIn: () => true, getIDToken: () => 'tok', getAppLanguage: () => 'ja', getLanguage: () => 'ja', closeWindow() {}, isInClient: () => true };
  w.eval(SRC + '\n;window.__g = { api: api, _edgeSlotsWait: _edgeSlotsWait, _edgeSlotsMark: _edgeSlotsMark, _edgeSlotsClear: _edgeSlotsClear, _edgeStaleUntil: _edgeStaleUntil, WL_ON: WL_ON };');
  return w;
}
async function fresh(o) { const w = boot(o); await settle(); w.gas.length = 0; w.edge.length = 0; return w; }
const CXL_OK = (extra) => Object.assign({ success: true, penalty: false, customerId: 'C0001', edgeSynced: false }, extra || {});
const SYNCED = { edgeSyncedExceptSlots: true, edgeWriteAt: W1 };
const viaGas = (w, a) => w.gas.some((p) => p.action === a);
const viaEdge = (w, a) => w.edge.find((b) => b.action === a);
const reset = (w) => { w.gas.length = 0; w.edge.length = 0; };

// ================= 1. スイッチが無ければ今と同じ =================
{
  const w = await fresh({ gas: { line_cancelReservation: CXL_OK(SYNCED) } });
  ok('1-0 既定はオフ', w.__g.WL_ON === false);
  await w.__g.api({ action: 'line_cancelReservation', reservationId: 'R1' }); reset(w);
  await w.__g.api({ action: 'line_getMyReservations' });
  await w.__g.api({ action: 'line_getTrainerSlots', trainerId: 'T1' });
  ok('1-1 ★オフ：印が来ても予約一覧・枠とも GAS（今と同じ35分）', viaGas(w, 'line_getMyReservations') && viaGas(w, 'line_getTrainerSlots') && w.edge.length === 0, JSON.stringify(w.edge));
  ok('1-2 オフでは枠待ちの印を作らない', w.__g._edgeSlotsWait() === null);
}

// ================= 2. ?wl=1 =================
{
  const w = await fresh({ url: 'https://reservation.tokowaka-gym.com/liff/?wl=1', gas: { line_cancelReservation: CXL_OK(SYNCED) },
    edge: { c_myReservations: { success: true, reservations: [], history: [] }, c_trainerSlots: { success: true, slots: [], computedAt: 1 } } });
  ok('2-0 ?wl=1 で有効・端末に保存', w.__g.WL_ON === true && w.localStorage.getItem('lb_wl') === '1');
  await w.__g.api({ action: 'line_cancelReservation', reservationId: 'R1' });
  ok('2-1 ★全体の印が外れ、枠待ちの印（書き込み時刻）が付く', !(w.__g._edgeStaleUntil() > Date.now()) && w.__g._edgeSlotsWait() && w.__g._edgeSlotsWait().after === W1);
  reset(w);
  await w.__g.api({ action: 'line_getMyReservations' });
  ok('2-2 ★予約一覧は Worker（GAS に行かない）', !!viaEdge(w, 'c_myReservations') && !viaGas(w, 'line_getMyReservations'));
  ok('2-3 予約一覧には slotsAfter を付けない', !('slotsAfter' in viaEdge(w, 'c_myReservations')));
  reset(w);
  await w.__g.api({ action: 'line_getTrainerSlots', trainerId: 'T1' });
  ok('2-4 ★枠は Worker に slotsAfter=書き込み時刻 を付けて聞く', viaEdge(w, 'c_trainerSlots') && viaEdge(w, 'c_trainerSlots').slotsAfter === W1);
  ok('2-5 ★確認（slotsAfterOk）が無い答え（古い Worker）は使わず GAS・枠待ちは残る', viaGas(w, 'line_getTrainerSlots') && w.__g._edgeSlotsWait().after === W1);
  reset(w);
  w.__edgeH.c_trainerSlots = { success: true, slots: [], computedAt: 1, slotsAfterOk: W1 - 1 };
  await w.__g.api({ action: 'line_getTrainerSlots', trainerId: 'T1' });
  ok('2-6 ★違う値の確認も使わない', viaGas(w, 'line_getTrainerSlots') && w.__g._edgeSlotsWait() !== null);
  reset(w);
  w.__edgeH.c_trainerSlots = { success: false, code: 'FALLBACK' };
  await w.__g.api({ action: 'line_getTrainerSlots', trainerId: 'T1' });
  ok('2-7 Worker が答えなければ GAS・枠待ちは残る', viaGas(w, 'line_getTrainerSlots') && w.__g._edgeSlotsWait() !== null);
  reset(w);
  w.__edgeH.c_trainerSlots = { success: true, slots: [], computedAt: 1, slotsAfterOk: W1 };
  const r = await w.__g.api({ action: 'line_getTrainerSlots', trainerId: 'T1' });
  ok('2-8 ★同じ値の確認が返れば使い、枠待ちの印を消す', !viaGas(w, 'line_getTrainerSlots') && r.slotsAfterOk === W1 && w.__g._edgeSlotsWait() === null && w.localStorage.getItem('lb_edge_slots') === null);
  reset(w);
  w.__edgeH.c_trainerSlots = { success: true, slots: [], computedAt: 1 };
  await w.__g.api({ action: 'line_getTrainerSlots', trainerId: 'T1' });
  ok('2-9 追いついた後は slotsAfter を付けない（今と同じ聞き方）', viaEdge(w, 'c_trainerSlots') && !('slotsAfter' in viaEdge(w, 'c_trainerSlots')) && !viaGas(w, 'line_getTrainerSlots'));
  reset(w);
  await w.__g.api({ action: 'line_getTrainerSlots', trainerId: 'T1', slotsAfter: 1 });
  ok('2-10 呼ぶ側の slotsAfter は送らない（印が無いのに比べさせない）', !('slotsAfter' in viaEdge(w, 'c_trainerSlots')));
}
{
  const w = await fresh({ url: 'https://reservation.tokowaka-gym.com/liff/?wl=1', gas: { line_cancelReservation: CXL_OK(SYNCED) } });
  await w.__g.api({ action: 'line_cancelReservation', reservationId: 'R1' }); reset(w);
  for (const a of ['line_getMemberStatus', 'line_getBookingOptions', 'line_getCustomerHome', 'line_getTrainerReservations']) await w.__g.api({ action: a, customerId: 'C0001', startISO: '2026-12-01T01:00:00.000Z' });
  ok('2-11 会員状態・予約の選択肢・ホーム・トレーナーの予約は Worker', ['c_memberStatus', 'c_bookingOptions', 'c_customerHome', 'c_trainerReservations'].every((a) => viaEdge(w, a)) && w.gas.length === 0, JSON.stringify(w.gas.map((x) => x.action)));
  ok('2-12 枠待ちは35分で切れる（期限は端末の時刻＋35分）', Math.abs(w.__g._edgeSlotsWait().until - (Date.now() + 35 * 60000)) < 5000);
}

// ================= 3. 倒れる向き =================
for (const [name, res] of [
  ['3-1 ★古い GAS（印が無い）→ 今と同じ35分', CXL_OK()],
  ['3-2 ★書き込み時刻が文字 → 今と同じ', CXL_OK({ edgeSyncedExceptSlots: true, edgeWriteAt: String(W1) })],
  ['3-3 書き込み時刻が小数 → 今と同じ', CXL_OK({ edgeSyncedExceptSlots: true, edgeWriteAt: W1 + 0.5 })],
  ['3-4 印が true 以外（"true"）→ 今と同じ', CXL_OK({ edgeSyncedExceptSlots: 'true', edgeWriteAt: W1 })],
  ['3-5 失敗の応答 → 今と同じ', { success: false, code: 'ALREADY', edgeSyncedExceptSlots: true, edgeWriteAt: W1 }],
]) {
  const w = await fresh({ url: 'https://reservation.tokowaka-gym.com/liff/?wl=1', gas: { line_cancelReservation: res } });
  await w.__g.api({ action: 'line_cancelReservation', reservationId: 'R1' }); reset(w);
  await w.__g.api({ action: 'line_getMyReservations' });
  ok(name, viaGas(w, 'line_getMyReservations') && w.edge.length === 0 && w.__g._edgeSlotsWait() === null);
}
{
  const w = await fresh({ url: 'https://reservation.tokowaka-gym.com/liff/?wl=1', gas: { line_addTicketRefill: { success: true, edgeSynced: true } } });
  await w.__g.api({ action: 'line_addTicketRefill', customerId: 'C0001' }); reset(w);
  await w.__g.api({ action: 'line_getTrainerSlots', trainerId: 'T1' });
  ok('3-6 既存の edgeSynced（チケット追加）は今までどおり全部解除・枠待ちは作らない', viaEdge(w, 'c_trainerSlots') && !('slotsAfter' in viaEdge(w, 'c_trainerSlots')));
}
{
  //   ★並行する書き込み：1件目の応答が来た時点で2件目が途中なら、全体の印を外さない
  let release;
  const slow = new Promise((r) => { release = r; });
  const w = await fresh({ url: 'https://reservation.tokowaka-gym.com/liff/?wl=1', gas: {
    line_cancelReservation: CXL_OK(SYNCED),
    line_changeReservation: () => slow.then(() => CXL_OK()) } });
  const p2 = w.__g.api({ action: 'line_changeReservation', reservationId: 'R2', newStartISO: '2026-12-02T01:00:00.000Z' });
  await settle();
  await w.__g.api({ action: 'line_cancelReservation', reservationId: 'R1' });
  ok('3-7 ★別の書き込みが途中なら全体の印を外さない（枠待ちも作らない）', w.__g._edgeStaleUntil() > Date.now() && w.__g._edgeSlotsWait() === null);
  release(); await p2; await settle();
  reset(w);
  await w.__g.api({ action: 'line_getMyReservations' });
  ok('3-8 2件目の応答に印が無ければ35分のまま', viaGas(w, 'line_getMyReservations'));
  //   2件目が失敗（例外）しても数が減る
  const w2 = await fresh({ url: 'https://reservation.tokowaka-gym.com/liff/?wl=1', gas: {
    line_changeReservation: () => Promise.reject(new Error('net')), line_cancelReservation: CXL_OK(SYNCED) } });
  try { await w2.__g.api({ action: 'line_changeReservation', reservationId: 'R2', newStartISO: 'x' }); } catch (e) {}
  await w2.__g.api({ action: 'line_cancelReservation', reservationId: 'R1' });
  ok('3-9 失敗した書き込みのあとも数は戻る（次の書き込みで解除できる）', w2.__g._edgeSlotsWait() && w2.__g._edgeSlotsWait().after === W1);
}
{
  const w = await fresh({ url: 'https://reservation.tokowaka-gym.com/liff/?wl=1' });
  w.__g._edgeSlotsMark(W2);
  w.__g._edgeSlotsMark(W1);
  ok('3-10 ★後から来た古い書き込み時刻で基準を下げない', w.__g._edgeSlotsWait().after === W2);
  w.__g._edgeSlotsClear(W1);
  ok('3-11 ★古い基準の確認では消さない', w.__g._edgeSlotsWait() && w.__g._edgeSlotsWait().after === W2);
  w.localStorage.setItem('lb_edge_slots', 'abc|def');
  ok('3-12 壊れた印は無いものとする（枠は今と同じ聞き方＝全体の印が無ければ Worker の普通の判定）', w.__g._edgeSlotsWait() === null);
  w.localStorage.setItem('lb_edge_slots', String(Date.now() - 1) + '|' + W1);
  ok('3-13 期限切れの印は無いものとする', w.__g._edgeSlotsWait() === null);
}
{
  const w = await fresh({ url: 'https://reservation.tokowaka-gym.com/liff/?wl=0' });
  ok('3-14 ?wl=0 で戻る', w.__g.WL_ON === false && w.localStorage.getItem('lb_wl') === null);
}
{
  //   ★書けないのに読める端末（容量・プライベート）：枠待ちの印が残せなければ全体の印を外さない
  const w = await fresh({ url: 'https://reservation.tokowaka-gym.com/liff/?wl=1', gas: { line_cancelReservation: CXL_OK(SYNCED) } });
  const proto = Object.getPrototypeOf(w.localStorage), realSet = proto.setItem;
  proto.setItem = function (k, v) { if (k === 'lb_edge_slots') throw new Error('QuotaExceeded'); return realSet.call(this, k, v); };
  await w.__g.api({ action: 'line_cancelReservation', reservationId: 'R1' }); reset(w);
  await w.__g.api({ action: 'line_getTrainerSlots', trainerId: 'T1' });
  await w.__g.api({ action: 'line_getMyReservations' });
  ok('3-15 ★枠待ちの印を書けなければ全体の印は外さない（枠も一覧も GAS＝今と同じ）', viaGas(w, 'line_getTrainerSlots') && viaGas(w, 'line_getMyReservations') && w.edge.length === 0, JSON.stringify(w.edge.map((b) => b.action)));
  proto.setItem = realSet;
}

console.log(`\n${pass} 通過 / ${fail} 失敗`);
if (fail) process.exit(1);
