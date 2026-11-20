// 設計45：写しの送信を応答の後ろへ回す（GAS を node で動かして入口から通す）
//   実行: node worker/test/gas-edge-defer.test.js
//
//   ① スイッチがオフ：edgeAfterWrite は今と同じ順序（積む → 写しと予約一覧）・印も待ちも作らない・設計43 B の印も今と同じ
//   ② スイッチがオン：積む → 待ち → 印だけ・写しは送らない・同期済みと名乗らない・名簿を読み直さない
//   ③ どれか1つでもできなければ今の経路（トリガー・番号・待ち・印）・対象外の操作は今の経路
//   ④ 待ちの送信：送れた会員だけ外す・番号が上がったら外さない・失敗は残す・TICK は90秒より古いものだけ・24時間で捨てる
//   ⑤ 一回限りトリガー：待ちの送信が最初・掃除は自分の triggerUid だけ（無ければ今のまま全部）
//   ⑥ 写しの番号は台帳を読む前に読む（呼ばれた順で確かめる）・_edgePushRows の載せ方・coveredCustomers
//   ⑦ 新しいトリガーは0本
//   ⑧ 日次点検（後ろ回しの待ち・回数／I79 の見張り）
//   ★値は架空（個人情報を書かない）
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PE = readFileSync(join(ROOT, 'gas/PushToEdge.js'), 'utf8');
let pass = 0, fail = 0;
function ok(name, cond, why) { if (cond) pass++; else { fail++; console.log(`❌ ${name}`); if (why) console.log(`   ${why}`); } }
function pluckFn(src, name) {
  const m = src.match(new RegExp('\\nfunction ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('見つからない: ' + name);
  return m[0];
}
function pluckVar(src, name) {
  const m = src.match(new RegExp('\\nvar ' + name + ' = [\\s\\S]*?;\\n'));
  if (!m) throw new Error('見つからない: ' + name);
  return m[0];
}
const H = 3600000;
const DEFER_FNS = ['_lbEdgeDeferOn', '_lbEdgePendingParse', '_lbEdgePendingAdd', '_lbEdgePendingDone', '_edgeSendMark',
  '_lbEdgeDeferParse', '_lbEdgeDeferCount', '_lbEdgePendingDrain', 'lbEdgeDeferDailyCheck', 'lbWriteCoversDailyCheck', '_edgeCoveredCustomers', 'edgeAfterWrite'];

function make(opt = {}) {
  let nowMs = opt.now || Date.UTC(2026, 10, 16, 3, 0);
  const props = Object.assign({}, opt.props || {});
  if (opt.on) props.LB_EDGE_DEFER = '1';
  const log = [], posts = [];
  class FD extends Date { constructor(...a) { if (a.length === 0) super(nowMs); else super(...a); } static now() { return nowMs; } }
  const ctx = {
    String, Number, JSON, Math, Object, isFinite, Date: FD,
    Logger: { log: () => {} },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (k in props ? props[k] : null),
      setProperty: (k, v) => { props[k] = String(v); },
    }) },
    Utilities: { formatDate: (d, tz, fmt) => { const j = new Date(d.getTime() + 9 * H); return j.toISOString().slice(0, 10); } },
    _edgeProp: (k) => (k in props ? props[k] : null),
    _edgeEnabled: () => opt.edgeOn !== false,
    _lbDwLocked: (fn) => (opt.lockFail ? null : fn()),
    _lbScheduleCalSync: () => { log.push('schedule'); return opt.calOk !== false; },
    lbDwEnqueue: () => { log.push('enqueue'); return opt.seq === undefined ? 41 : opt.seq; },
    getCustomerByLine: () => { log.push('map'); return { data: ['U', 'C0001', 'テスト 太郎'] }; },
    MAP_COL: { CUSTOMER_ID: 2, NAME: 3 },
    _edgeNameByCustomerId: () => { log.push('name'); return 'テスト 太郎'; },
    _edgeSendAfterWrite: (cid, nm, seq) => { log.push('send:' + cid + ':' + seq); if (opt.onSend) opt.onSend(ctx, props); return { home: opt.home !== false, reservations: opt.resv !== false, bothFailed: false }; },
    _edgePost: (b) => { posts.push(b); log.push('post:' + b.kind + ':' + (b.rows || []).length); return { success: opt.markOk !== false }; },
    _LB_WRITE_CUST: opt.writeCust === undefined ? { id: 'C0001' } : opt.writeCust,
    _lbWpMark: (s) => log.push('mark:' + s),
  };
  vm.createContext(ctx);
  vm.runInContext(pluckVar(PE, 'EDGE_AFTER_WRITE') + pluckVar(PE, 'EDGE_CALSYNC_AFTER') + pluckVar(PE, 'EDGE_SLOTS_ONLY_LAG')
    + pluckVar(PE, 'LB_EDGE_DEFER') + pluckVar(PE, 'LB_EDGE_DEFER_KINDS') + pluckVar(PE, 'EDGE_COVERED_MAX')
    + DEFER_FNS.map((n) => pluckFn(PE, n)).join('\n'), ctx);
  return { ctx, props, log, posts, setNow: (v) => { nowMs = v; }, adv: (ms) => { nowMs += ms; } };
}
const U = 'U' + '0'.repeat(32);
const pend = (props) => JSON.parse(props.LB_EDGE_PENDING || '{}');
const cnt = (props) => { const o = JSON.parse(props.LB_EDGE_DEFER_COUNT || '{}'); return o[Object.keys(o)[0]] || {}; };

// ================= ① スイッチがオフ =================
console.log('=== ① スイッチがオフ ===');
{
  const t = make({});
  const res = { success: true };   // 予約：応答に会員IDが無い
  t.ctx.edgeAfterWrite('line_makeReservationLine', {}, res, U);
  ok('①-1 ★今と同じ順序：トリガー → 名簿で会員を特定 → 積む → 写しと予約一覧（印も待ちも作らない）',
     t.log.filter((x) => !/^mark:/.test(x)).join(',') === 'schedule,map,enqueue,send:C0001:41' && !t.props.LB_EDGE_PENDING && t.posts.length === 0, t.log.join(','));
  ok('①-2 ★設計43 B の印は今と同じ（枠以外は同期済み・書き込み時刻）', res.edgeSyncedExceptSlots === true && typeof res.edgeWriteAt === 'number' && res.edgeSynced === false, JSON.stringify(res));
  ok('①-3 書き込みの関数の会員IDは使わない（今と同じ名簿の読み）', t.log.includes('map'));
  ok('①-4 回数を数えない（オフ）', !t.props.LB_EDGE_DEFER_COUNT);
  const c = make({});
  const r2 = { success: true, customerId: 'C0002' };
  c.ctx.edgeAfterWrite('line_cancelReservation', {}, r2, U);
  ok('①-5 取消（応答に会員ID）：氏名を名簿から引いてから積む（今と同じ）', c.log.filter((x) => !/^mark:/.test(x)).join(',') === 'schedule,name,enqueue,send:C0002:41', c.log.join(','));
}

// ================= ② スイッチがオン =================
console.log('=== ② スイッチがオン ===');
{
  const t = make({ on: true });
  const res = { success: true };
  t.ctx.edgeAfterWrite('line_makeReservationLine', {}, res, U);
  ok('②-1 ★積む → 待ち → 印だけ（写しと予約一覧は送らない）', t.log.filter((x) => !/^mark:/.test(x)).join(',') === 'schedule,enqueue,post:reservations:0', t.log.join(','));
  ok('②-2 ★印は予約0件の形・番号つき・covers を載せない', t.posts.length === 1 && t.posts[0].scope === 'partial' && t.posts[0].customerId === 'C0001' && t.posts[0].dirtySeq === 41 && !('coversSeq' in t.posts[0]), JSON.stringify(t.posts));
  ok('②-3 ★待ちに会員と番号（時刻）', pend(t.props).C0001 && pend(t.props).C0001.seq === 41, t.props.LB_EDGE_PENDING);
  ok('②-4 ★同期済みと名乗らない（edgeSynced false・edgeSyncedExceptSlots を付けない＝画面は今と同じ35分 GAS）', res.edgeSynced === false && !('edgeSyncedExceptSlots' in res) && !('edgeWriteAt' in res), JSON.stringify(res));
  ok('②-5 ★名簿を読み直さない（会員は書き込みの関数から・氏名も引かない）', !t.log.includes('map') && !t.log.includes('name'));
  ok('②-6 段の印 edgeQ・edgeMark', t.log.includes('mark:edgeQ') && t.log.includes('mark:edgeMark'));
  ok('②-7 回数 deferred', cnt(t.props).deferred === 1, t.props.LB_EDGE_DEFER_COUNT);
  for (const op of ['line_cancelReservation', 'line_changeReservation', 'line_makeBatchReservation', 'line_makeTransferReservation', 'line_ownerFreeCancel', 'line_ownerFreeChange', 'line_makeReservationLineProxy', 'line_makeBatchReservationProxy']) {
    const x = make({ on: true });
    x.ctx.edgeAfterWrite(op, {}, { success: true, customerId: 'C0003' }, U);
    ok('②-8 ' + op + ' も後ろへ回す', !x.log.some((l) => /^send:/.test(l)) && pend(x.props).C0003);
  }
  const f = make({ on: true });
  f.ctx.edgeAfterWrite('line_cancelReservation', {}, { success: false, code: 'NOT_FOUND' }, U);
  ok('②-9 失敗した書き込みでは何もしない', f.log.length === 0);
}

// ================= ③ 今の経路へ倒れる =================
console.log('=== ③ 今の経路へ ===');
{
  const run = (o, op = 'line_cancelReservation') => { const t = make(Object.assign({ on: true }, o)); const res = { success: true, customerId: 'C0004' }; t.ctx.edgeAfterWrite(op, {}, res, U); return { t, res }; };
  let a = run({ calOk: false });
  ok('③-1 ★一回限りトリガーを作れない → 今の経路（写しと予約一覧を応答の前に）', a.t.log.some((l) => l === 'send:C0004:41') && cnt(a.t.props).inline_noTrigger === 1 && a.res.edgeSyncedExceptSlots === true, a.t.log.join(','));
  a = run({ seq: false });
  ok('③-2 番号を積めない → 今の経路', a.t.log.some((l) => /^send:C0004/.test(l)) && cnt(a.t.props).inline_noSeq === 1 && !a.t.props.LB_EDGE_PENDING);
  a = run({ lockFail: true });
  ok('③-3 待ちに足せない（ロック）→ 今の経路', a.t.log.some((l) => /^send:C0004/.test(l)) && cnt(a.t.props).inline_pendFail === 1);
  const full = {}; for (let i = 0; i < 30; i++) full['C9' + String(i).padStart(4, '0')] = { seq: 1, at: 1 };
  a = run({ props: { LB_EDGE_PENDING: JSON.stringify(full) } });
  ok('③-4 待ちが満杯 → 今の経路（追い出さない）', a.t.log.some((l) => /^send:C0004/.test(l)) && cnt(a.t.props).inline_pendFail === 1 && Object.keys(pend(a.t.props)).length === 30);
  a = run({ markOk: false });
  ok('③-5 ★印を送れない → 今の経路（待ちは残る＝後でもう一度送るだけ）', a.t.log.some((l) => /^send:C0004/.test(l)) && cnt(a.t.props).inline_markFail === 1 && pend(a.t.props).C0004, a.t.log.join(','));
  a = run({}, 'line_addTicketRefill');
  ok('③-6 対象外の操作（チケット追加）は今の経路・数えない', a.t.log.some((l) => /^send:C0004/.test(l)) && !a.t.props.LB_EDGE_DEFER_COUNT && a.res.edgeSynced === true);
  a = run({}, 'line_makeBlock');
  ok('③-7 対象外の操作（ブロック）は今の経路', a.t.log.some((l) => /^send:C0004/.test(l)) && !a.t.props.LB_EDGE_PENDING);
  const w = make({ on: true, writeCust: null, calOk: false });
  w.ctx.edgeAfterWrite('line_makeReservationLine', {}, { success: true }, U);
  ok('③-8 書き込みの関数の会員IDが無ければ今どおり名簿で特定', w.log.includes('map') && w.log.some((l) => /^send:C0001/.test(l)), w.log.join(','));
  const m = make({ on: true, calOk: false });
  m.ctx.edgeAfterWrite('line_makeReservationLine', {}, { success: true }, U);
  ok('③-9 書き込みの関数の会員IDで特定して今の経路に倒れたら、氏名は名簿の同じ会員から引く', m.log.filter((x) => !/^mark:/.test(x)).join(',') === 'schedule,enqueue,map,send:C0001:41', m.log.join(','));
}

// ================= ④ 待ちの送信 =================
console.log('=== ④ 待ちの送信 ===');
{
  const base = Date.UTC(2026, 10, 16, 3, 0);
  const mk = (o = {}) => make(Object.assign({ props: { LB_EDGE_PENDING: JSON.stringify({ C0001: { seq: 5, at: base - 1000 }, C0002: { seq: 6, at: base - 200000 } }) }, now: base }, o));
  let t = mk();
  let r = t.ctx._lbEdgePendingDrain('AFTER', 60000, 0);
  ok('④-1 ★送れた会員を外す・古い順・番号と氏名で送る', r.sent === 2 && Object.keys(pend(t.props)).length === 0 && t.log.filter((l) => /^send:/.test(l)).join(',') === 'send:C0002:6,send:C0001:5', t.log.join(','));
  ok('④-2 回数 sentAfter・最大の遅れ', cnt(t.props).sentAfter === 2 && cnt(t.props).maxAgeMs === 200000, t.props.LB_EDGE_DEFER_COUNT);
  t = mk({ home: false });
  r = t.ctx._lbEdgePendingDrain('AFTER', 60000, 0);
  ok('④-3 ★片方でも送れなければ残す・sendFail', r.failed === 2 && Object.keys(pend(t.props)).length === 2 && cnt(t.props).sendFail === 2);
  t = mk({ onSend: (ctx, props) => { const q = JSON.parse(props.LB_EDGE_PENDING); if (q.C0002) q.C0002.seq = 9; props.LB_EDGE_PENDING = JSON.stringify(q); } });
  t.ctx._lbEdgePendingDrain('AFTER', 60000, 0);
  ok('④-4 ★送っている間に番号が上がったら外さない（次の送信が新しい番号で送る）', pend(t.props).C0002 && pend(t.props).C0002.seq === 9, t.props.LB_EDGE_PENDING);
  t = mk();
  t.ctx._lbEdgePendingDrain('TICK', 60000, 90000);
  ok('④-5 ★TICK は90秒より古い待ちだけ', t.log.filter((l) => /^send:/.test(l)).join(',') === 'send:C0002:6' && pend(t.props).C0001 && cnt(t.props).sentTick === 1, t.log.join(','));
  t = make({ props: { LB_EDGE_PENDING: JSON.stringify({ C0001: { seq: 5, at: base - 25 * H } }) }, now: base });
  t.ctx._lbEdgePendingDrain('TICK', 60000, 90000);
  ok('④-6 24時間より古い待ちは送らず捨てて数える', !t.log.some((l) => /^send:/.test(l)) && !pend(t.props).C0001 && cnt(t.props).dropped === 1);
  t = make({ props: { LB_EDGE_PENDING: '{壊れ' }, now: base });
  r = t.ctx._lbEdgePendingDrain('AFTER', 60000, 0);
  ok('④-7 壊れた待ちは送らず、時刻だけ印（中身を写さない）', r.skipped === 'BROKEN' && /^\d+$/.test(t.props.LB_EDGE_PENDING_BAD || '') && !/壊れ/.test(Object.keys(t.props).filter((k) => k !== 'LB_EDGE_PENDING').map((k) => t.props[k]).join('')));
  t = make({ props: { LB_EDGE_PENDING: '{壊れ' }, on: true });
  t.ctx.edgeAfterWrite('line_cancelReservation', {}, { success: true, customerId: 'C0005' }, U);
  ok('④-8 壊れた待ちに足すときは作り直す（印だけ残す）', pend(t.props).C0005 && Object.keys(pend(t.props)).length === 1 && /^\d+$/.test(t.props.LB_EDGE_PENDING_BAD || ''));
  t = mk({ edgeOn: false });
  ok('④-9 押し出しの元栓が閉じていれば送らない', t.ctx._lbEdgePendingDrain('AFTER', 60000, 0).skipped === 'EDGE_OFF');
}

// ================= ⑤ 一回限りトリガー =================
console.log('=== ⑤ 一回限りトリガー ===');
{
  const order = [];
  let deleted = [];
  const trig = (uid) => ({ getHandlerFunction: () => '_lbCalSyncAfterWrite', getUniqueId: () => uid });
  const ctx = {
    String, Logger: { log: () => {} },
    LB_CALSYNC: { AFTER_HANDLER: '_lbCalSyncAfterWrite' }, LB_EDGE_DEFER: { AFTER_BUDGET_MS: 60000, TICK_MIN_AGE_MS: 90000 },
    _lbEdgePendingDrain: (who, b, min) => { order.push('edge:' + who + ':' + min); },
    _lbCalSyncCore: () => { order.push('core'); return { ok: true }; },
    lbDualWriteDrain: () => order.push('drain'),
    _lbCalSlotsAfter: () => order.push('slots'),
    _lbCalSlotsWired: () => order.push('wired'),
    ScriptApp: { getProjectTriggers: () => [trig('u1'), trig('u2'), { getHandlerFunction: () => 'pushToEdgeSlots', getUniqueId: () => 'x' }],
                 deleteTrigger: (t) => deleted.push(t.getUniqueId()) },
  };
  vm.createContext(ctx);
  vm.runInContext(['_lbCleanCalSyncAfterTriggers', '_lbCalSyncAfterWrite', 'lbCalSyncTick'].map((n) => pluckFn(PE, n)).join('\n'), ctx);
  ctx._lbCalSyncAfterWrite({ triggerUid: 'u2' });
  ok('⑤-1 ★待ちの写しの送信が最初（同期・二重書き・枠より前）', order.join(',') === 'edge:AFTER:0,core,drain,slots', order.join(','));
  ok('⑤-2 ★掃除は自分の triggerUid だけ（実行中に別の書き込みが作った次のトリガーを消さない）', deleted.join(',') === 'u2', deleted.join(','));
  deleted = []; order.length = 0;
  ctx._lbCalSyncAfterWrite();
  ok('⑤-3 イベントが無い（手で実行）ときは今のまま同名を全部消す', deleted.join(',') === 'u1,u2', deleted.join(','));
  deleted = [];
  ctx._lbCalSyncAfterWrite({ triggerUid: 7 });
  ok('⑤-4 triggerUid が文字列でなければ今のまま全部（真偽で判定しない）', deleted.join(',') === 'u1,u2', deleted.join(','));
  order.length = 0;
  ctx.lbCalSyncTick();
  ok('⑤-5 ★5分ごと：90秒より古い待ちを最初に拾う', order[0] === 'edge:TICK:90000', order.join(','));
}

// ================= ⑥ 写しの番号 =================
console.log('=== ⑥ 写しの番号 ===');
{
  //   pushToEdgeHomeFor・_edgePushReservationsFor：番号を台帳を読む前に読む
  const order = [], rowsCalls = [];
  const ctx = { String, Number, Math, Date, Logger: { log: () => {} },
    _edgeEnabled: () => true,
    _edgeCoversSeqNow: () => { order.push('cv'); return 12; },
    _edgeHomeRows: () => { order.push('homeRows'); return [{ customer_id: 'C1' }]; },
    _edgeReservations: () => { order.push('resvRows'); return [{ customer_id: 'C1' }, { customer_id: 'C2' }]; },
    _edgePushRows: (k, rows, b, o) => { rowsCalls.push({ k, o }); return '1件'; },
    _edgePost: () => ({ success: true }) };
  vm.createContext(ctx);
  vm.runInContext(['pushToEdgeHomeFor', '_edgePushReservationsFor'].map((n) => pluckFn(PE, n)).join('\n'), ctx);
  ctx.pushToEdgeHomeFor('C1', 'テスト 太郎', 5);
  ctx._edgePushReservationsFor('C1', 5);
  ok('⑥-1 ★番号は台帳を読む前（写し・予約一覧とも）', order.join(',') === 'cv,homeRows,cv,resvRows', order.join(','));
  ok('⑥-2 写しにも予約一覧にも番号を渡す', rowsCalls[0].o.coversSeq === 12 && rowsCalls[1].o.coversSeq === 12 && rowsCalls[1].o.customerId === 'C1', JSON.stringify(rowsCalls));
  //   全体の押し出しの予約一覧・残数の押し出し：番号を読む位置を字面で固定（入口の関数が大きいため）
  ok('⑥-3 ★全体の予約一覧：番号 → 台帳 → coveredCustomers', /var _cv = _edgeCoversSeqNow\(\);\s*var _rv = _edgeReservations\(\);\s*var _cov = \(_cv != null\) \? _edgeCoveredCustomers\(customers, _rv\) : null;/.test(PE));
  ok('⑥-4 ★残数の押し出し：番号を読んでから作る', /var _cv = _edgeCoversSeqNow\(\);[^\n]*\n\s*var rows = _edgeWithSheetCache\(function \(\) \{\s*return _edgeWithResvCache\(function \(\) \{ return _edgeHomeRows\(ids, deadline\); \}\);/.test(PE));

  //   _edgePushRows の載せ方
  const posts = [];
  const c2 = { String, Number, JSON, Object, Array, Math, Date, Logger: { log: () => {} }, EDGE: { CHUNK: 2 },
    _edgeDedupe: (k, r) => r, _edgePost: (b) => { posts.push(b); return { success: true, written: (b.rows || []).length }; } };
  vm.createContext(c2);
  vm.runInContext(pluckFn(PE, '_edgePushRows'), c2);
  const R = (n, cid) => Array.from({ length: n }, (_, i) => ({ reservation_id: 'R' + i, customer_id: cid || ('C' + i) }));
  c2._edgePushRows('home', R(3), 1, { scope: 'partial', coversSeq: 9 });
  ok('⑥-5 home は毎回の batch に番号', posts.length === 2 && posts.every((p) => p.coversSeq === 9), JSON.stringify(posts.map((p) => p.coversSeq)));
  posts.length = 0;
  c2._edgePushRows('reservations', R(3, 'C1'), 2, { scope: 'partial', coversSeq: 9, customerId: 'C1' });
  ok('⑥-6 ★予約一覧（一部）は最後の batch にだけ番号と会員', posts.length === 2 && !('coversSeq' in posts[0]) && posts[1].coversSeq === 9 && posts[1].customerId === 'C1', JSON.stringify(posts.map((p) => [p.coversSeq, p.customerId])));
  posts.length = 0;
  c2._edgePushRows('reservations', R(3), 3, { scope: 'all', coversSeq: 9, coveredCustomers: ['C0', 'C1', 'C2', 'C9'] });
  ok('⑥-7 ★全体の予約一覧は最後の batch にだけ番号と coveredCustomers', posts.length === 2 && !('coveredCustomers' in posts[0]) && posts[1].coversSeq === 9 && posts[1].coveredCustomers.length === 4, JSON.stringify(posts.map((p) => [p.coversSeq, (p.coveredCustomers || []).length])));
  posts.length = 0;
  c2._edgePushRows('reservations', R(1), 4, { scope: 'all', coversSeq: 9 });
  ok('⑥-8 coveredCustomers が無い全体送信には番号を載せない（covers を立てられない）', !('coversSeq' in posts[0]));
  posts.length = 0;
  c2._edgePushRows('trainers', R(1), 5, { scope: 'all', coversSeq: 9 });
  ok('⑥-9 home・reservations 以外には載せない', !('coversSeq' in posts[0]));

  const t = make({});
  ok('⑥-10 coveredCustomers：顧客と予約の会員の和・重複なし・形の外れたIDは入れない',
     JSON.stringify(t.ctx._edgeCoveredCustomers([{ customer_id: 'C1' }, { customer_id: 'テスト' }, { customer_id: ' C2 ' }], [{ customer_id: 'C1' }, { customer_id: 'C3' }])) === JSON.stringify(['C1', 'C2', 'C3']));
  ok('⑥-11 顧客か予約が読めなければ載せない', t.ctx._edgeCoveredCustomers(null, []) === null && t.ctx._edgeCoveredCustomers([], null) === null);
  ok('⑥-12 2,000人を超えたら載せない', t.ctx._edgeCoveredCustomers(Array.from({ length: 2001 }, (_, i) => ({ customer_id: 'C' + i })), []) === null);
}

// ================= ⑦ 新しいトリガーは0本 =================
console.log('=== ⑦ トリガー ===');
{
  const GAS = join(ROOT, 'gas');
  const all = readdirSync(GAS).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(GAS, f), 'utf8')).join('\n');
  const handlers = (all.match(/ScriptApp\.newTrigger\(\s*([^)]+)\)/g) || []).map((x) => x.replace(/ScriptApp\.newTrigger\(\s*|\s*\)$/g, '')).sort();
  const uniq = Array.from(new Set(handlers));
  //   ★設計45 の前と同じ集合（増えたら落とす。新しい定期処理は既存に相乗りする・上限20本）
  const BEFORE = ["'_lbSyncAfterRegister'", "'_lbWarmContract'", "'autoBookRecurringPatterns'", "'checkLineQuota'", "'dailyHealthCheck'", "'dailySync'",
    "'edgeJobPoll'", "'lbNudgeDaily'", "'pushToEdgeFullSync'", "'pushToEdgeHome'", "'pushToEdgeLight'", "'pushToEdgeSlots'", "'refreshPaceBoard'",
    "'sendLineReminders'", "'sendReminderMails'", "'sendShiftReminders'", "'syncContractStatus'", "'warmupCache'", "'weeklyPaceReport'",
    'LB_CALSYNC.AFTER_HANDLER', 'LB_CALSYNC.TICK_HANDLER',
    'LB_AB_RETRY.HANDLER'].sort();   // 設計47 §7：固定枠の自動予約の取り直し（一回限り・保留があるときだけ）。定期のトリガーは増やしていない
  ok('⑦-1 ★トリガーを作る呼び出しの集合が設計45 の前と同じ（新しいトリガー0本）', JSON.stringify(uniq) === JSON.stringify(BEFORE), JSON.stringify(uniq));
  const block = PE.slice(PE.indexOf('// 設計45 写しの送信を応答の後ろへ回す'), PE.indexOf('// 振り分けの出口から呼ぶ。'));
  ok('⑦-2 後ろ回しの部品はトリガーを作らない', block.length > 1000 && !/newTrigger/.test(block));
}

// ================= ⑧ 日次点検 =================
console.log('=== ⑧ 日次点検 ===');
{
  const now = Date.UTC(2026, 10, 16, 0, 0);
  const t = make({ now });
  const get = (p) => (k) => (k in p ? p[k] : null);
  const y = new Date(now - 86400000 + 9 * H).toISOString().slice(0, 10);
  ok('⑧-1 スイッチがオフなら何も言わない', t.ctx.lbEdgeDeferDailyCheck(now, get({ LB_EDGE_DEFER_COUNT: JSON.stringify({ [y]: { sendFail: 3 } }) })).length === 0);
  const r = t.ctx.lbEdgeDeferDailyCheck(now, get({ LB_EDGE_DEFER: '1',
    LB_EDGE_PENDING: JSON.stringify({ C1: { seq: 1, at: now - 11 * 60000 }, C2: { seq: 1, at: now - 60000 } }),
    LB_EDGE_DEFER_COUNT: JSON.stringify({ [y]: { deferred: 10, sendFail: 1, maxAgeMs: 11 * 60000, inline_noTrigger: 4 } }) }));
  const keys = r.map((x) => x.key).sort().join(',');
  ok('⑧-2 ★10分より古い待ち・送れなかった回・遅れ・後ろへ回せなかった回（2割超）', keys === 'edge_defer_inline,edge_defer_pending_old,edge_defer_send_fail,edge_defer_slow', keys);
  ok('⑧-3 ★会員IDを出さない', !JSON.stringify(r).includes('C1'));
  ok('⑧-4 待ちが壊れていれば high', t.ctx.lbEdgeDeferDailyCheck(now, get({ LB_EDGE_DEFER: '1', LB_EDGE_PENDING: '{x' })).some((x) => x.key === 'edge_defer_pending_broken' && x.severity === 'high'));
  const sv = (w) => ({ table: 'ok', writeCovers: w });
  ok('⑧-5 反映前の Worker（欄が無い）は何も言わない', t.ctx.lbWriteCoversDailyCheck({ table: 'ok' }, now).length === 0);
  ok('⑧-6 欄が読めなければ warn', t.ctx.lbWriteCoversDailyCheck(sv({ table: 'missing' }), now).some((x) => x.key === 'covers_unreadable'));
  const w = t.ctx.lbWriteCoversDailyCheck(sv({ table: 'ok', homeClosed: 2, homeOldestSince: now - 70 * 60000, resvClosed: 1, resvOldestSince: now - 12 * 60000, homeRemnant: 0, resvRemnant: 3 }), now);
  ok('⑧-7 ★閉じている最長：60分で high・10分で warn・移行の残りは warn', w.some((x) => x.key === 'covers_home_stuck' && x.severity === 'high') && w.some((x) => x.key === 'covers_resv_slow' && x.severity === 'warn')
     && w.some((x) => x.key === 'covers_resv_remnant' && x.count === 3), JSON.stringify(w));
  //   ★2026-11-18：問題なしのときは info を1行だけ出す（動いたことが分かるように）。warn・high は出さない
  const w5 = t.ctx.lbWriteCoversDailyCheck(sv({ table: 'ok', homeClosed: 1, homeOldestSince: now - 5 * 60000 }), now);
  ok('⑧-8 閉じていても5分なら warn・high を言わない（info だけ）', w5.length === 1 && w5[0].key === 'covers_ok' && w5[0].severity === 'info', JSON.stringify(w5));
  ok('⑧-9 ★問題なしの info に数（閉じている・移行の残り）が載る・会員IDなし', /残数 閉じている 1名・移行の残り 0名／予約一覧 閉じている 0名・移行の残り 0名/.test(w5[0].detail) && !/C\d/.test(w5[0].detail), w5[0].detail);
  ok('⑧-10 問題があるときは info を出さない', !w.some((x) => x.key === 'covers_ok'));
  const w0 = t.ctx.lbWriteCoversDailyCheck(sv({ table: 'ok', homeClosed: 0, resvClosed: 0, homeRemnant: 0, resvRemnant: 0 }), now);
  ok('⑧-11 全部0でも info が1行（何も出ない＝動いていない、と区別できる）', w0.length === 1 && w0[0].key === 'covers_ok' && w0[0].count === 1, JSON.stringify(w0));
}

console.log(`\n${fail ? '❌' : '✅'} 設計45 写しの送信を応答の後ろへ（GAS） 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
