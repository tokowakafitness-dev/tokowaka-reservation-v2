// 設計45b（M3）：予約・取消の LINE 通知を応答の後ろへ回す（GAS を node で動かして入口から通す）
//   実行: node worker/test/gas-notify-defer.test.js
//
//   ① スイッチがオフ：送る相手・文・順序・_lbPush の引数が今と同じ／待ちを作らない
//   ② スイッチがオン：応答の前に送らない（予約2通・取消の会員）／その枠のトレーナーは応答の前／待ちの文は今と1文字も同じ／トリガーを作る前に待ちへ入る
//   ③ 今の経路に倒れる：トリガーを作れない（取り戻して送る）・ロック失敗・上限超え・壊れた待ち（書き換えない）・振り分けの例外・対象外の操作
//   ④ 送る側：AFTER は全部・TICK は90秒・WARM は5分より古いもの／送った項目を消す／失敗は notify_retry に1行／二重に取らない／
//      期限切れの取り分けは alert で送らない（重複は追記しない）／30分より古いものは pending で引き渡す／送る間ロックを持たない
//   ⑤ FLUSH：取消・変更の後、その予約の確定の通知を捨てる（取り分け中だけ待つ・ロックを持たずに）／境界
//   ⑥ 配線：一回限りトリガー・5分ごと・10分ごと・新しいトリガー0本・文面を送る側で作らない
//   ⑦ 日次点検と記録（数だけ・LINE ID と本文を出さない）
//   ★値は架空（個人情報を書かない）
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LB = readFileSync(join(ROOT, 'gas/LineBooking.js'), 'utf8');
const PE = readFileSync(join(ROOT, 'gas/PushToEdge.js'), 'utf8');
const CODE = readFileSync(join(ROOT, 'gas/コード.js'), 'utf8');
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
const LB_FNS = ['handleLineGet', '_lbNotifyDeferOn', '_lbNotifyHoldStart', '_lbNotifyHolding', '_lbPushOrHold', '_lbNotifyHoldPersist',
  '_lbNotifyHoldSettle', '_lbNdParse', '_lbNdMarkBad', '_lbUtf8Len', '_lbNdCount', '_lbNdHandover', '_lbNdRemove', '_lbNdRelease',
  '_lbNotifyDeferRun', '_lbNotifyDeferDrain', '_lbNotifyDeferFlushRes', 'lbNotifyDeferDailyMaint', 'lbNotifyDeferDailyCheck',
  '_lbNotifyDeferSummaryText', '_lbPush', '_lbNqOnFail', '_lbNqDefer', '_lbNqAppendRow', '_lbNqPolicy', '_lbNqCol', '_lbNqRetryable',
  '_lbNotifyReservation', '_lbCxlAfter', '_lbCxlLogErr'];
const LB_VARS = ['LB_NQ', 'LB_NOTIFY_DEFER', 'LB_NOTIFY_DEFER_OPS', 'LB_NOTIFY_DEFER_KINDS', 'LB_NOTIFY_DEFER_MAXES', 'LB_CXL_KEYS', 'LB_CXL_BUDGET',
  '_LB_NOTIFY_HOLD', '_LB_NOTIFY_PERSISTED', '_LB_CAL_SCHEDULED'];

const U_CUS = 'U' + 'c'.repeat(32), U_TR = 'U' + 't'.repeat(32), U_OWN = 'U' + 'o'.repeat(32);

function make(opt = {}) {
  let nowMs = opt.now || Date.UTC(2026, 10, 16, 3, 0);
  const props = Object.assign({}, opt.props || {});
  if (opt.on) props.LB_NOTIFY_DEFER = '1';
  const log = [], pushes = [], nqRows = [];
  let lockDepth = 0, uuid = 0;
  const pushResult = opt.pushResult || (() => ({ ok: true, code: 200, body: '', uncertain: false }));
  class FD extends Date { constructor(...a) { if (a.length === 0) super(nowMs); else super(...a); } static now() { return nowMs; } }
  const nqSheet = {
    appendRow: (r) => { if (opt.nqAppendThrow) throw new Error('x'); nqRows.push(r.slice()); log.push('nq:' + r[7]); },
    getLastRow: () => nqRows.length + 1,
    getRange: (r, c, n, m) => ({ getValues: () => nqRows.slice(r - 2, r - 2 + n).map((x) => x.slice(c - 1, c - 1 + m)) }),
  };
  const ctx = {
    String, Number, JSON, Math, Object, Array, isFinite, Date: FD,
    Logger: { log: () => {} },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (k in props ? props[k] : null),
      setProperty: (k, v) => { if (opt.propWriteFail && k === 'LB_NOTIFY_PENDING') throw new Error('w'); props[k] = String(v); },
      deleteProperty: (k) => { delete props[k]; },
    }) },
    Utilities: { formatDate: (d) => new Date(d.getTime() + 9 * H).toISOString().slice(0, 10), getUuid: () => 'u' + (++uuid),
                 sleep: (ms) => { if (lockDepth) log.push('SLEEP_IN_LOCK'); nowMs += ms; if (opt.onSleep) opt.onSleep(ctx, props); } },
    _lbDwLocked: (fn, w) => {
      if (opt.lockFail && opt.lockFail(w)) { log.push('lockfail:' + w); return null; }
      lockDepth++; try { return fn(); } finally { lockDepth--; }
    },
    _lbPushOnce: (to, text, o) => { if (lockDepth) log.push('PUSH_IN_LOCK'); pushes.push({ to, text, purpose: o.purpose, nr: o.noInlineRetry }); log.push('push:' + o.purpose); nowMs += 300; return pushResult(to, text, o); },
    _lbLogNotifyFail: () => {}, _lbNqEmergency: () => log.push('emergency'), _lbIsStaging: () => false,
    _lbIsFiniteNum: (v) => typeof v === 'number' && isFinite(v),
    _lbSs: () => ({ getSheetByName: (n) => (n === 'notify_retry' && !opt.noNqSheet ? nqSheet : null) }),
    _calsyncAutoOn: () => opt.calsync !== false,
    _LB_WRITE_CUST: null,
    verifyLineIdToken: () => ({ ok: true, lineUserId: opt.actor || U_CUS }),
    _lbWpStart: () => {}, _lbWpMark: (s) => log.push('mark:' + s), _lbWpFinish: () => {},
    edgeAfterWrite: () => { log.push('edge'); if (opt.calOk !== false) { ctx._LB_CAL_SCHEDULED = true; vm.runInContext('_LB_CAL_SCHEDULED = true;', ctx); } if (opt.onEdge) opt.onEdge(ctx, props); },
    SETTINGS: { TIMEZONE: 'Asia/Tokyo', GYM_NAME: 'テストジム' },
    getTrainerLineId: (id) => { log.push('trLine'); return id === 'T2' ? U_OWN : U_TR; },
    _lbTrainerRemainText: () => { log.push('remainText'); return '\n【顧客の残り】\n月額：月4回中2回目（残2回）'; },
    _lbCustTrainerId: () => opt.ownTid || 'T1',
    _lbMemberLang: () => 'ja', _lbTrainerNameLang: (id, nm) => nm,
    _lbSt: (l, k) => '[' + k + ']', _lbFmtResvLabel: () => '11/20(金) 10:00',
    _lbCnMark: () => {}, _lbCnReady: () => ({ ok: true, sheet: {} }), _lbCnMaintain: () => {},
    _lbLogOutcome: (c) => log.push('outcome:' + c),
    _lbEdgeDeferParse: null,
    _lbDispatch: (params, action) => opt.dispatch(ctx, action),
  };
  vm.createContext(ctx);
  vm.runInContext(LB_VARS.map((n) => pluckVar(LB, n)).join('') + LB_FNS.map((n) => pluckFn(LB, n)).join('\n') + pluckFn(PE, '_lbEdgeDeferParse'), ctx);
  return { ctx, props, log, pushes, nqRows, setNow: (v) => { nowMs = v; }, adv: (ms) => { nowMs += ms; }, now: () => nowMs };
}
const start = new Date(Date.UTC(2026, 10, 20, 1, 0)), end = new Date(Date.UTC(2026, 10, 20, 2, 0));
const TRAINER = { id: 'T1', name: 'テスト 講師' };
// 予約：本物の _lbNotifyReservation を、書き込みの関数と同じ引数で呼ぶ
const book = (resId = 'R1', channel = 'line') => (ctx) => { ctx._lbNotifyReservation(U_CUS, TRAINER, start, end, 'テスト 太郎', channel, 'C1', resId); return { success: true, reservationId: resId }; };
// 取消：本物の _lbCxlAfter
const cxlD = (o = {}) => Object.assign({ resId: 'R1', customerId: 'C1', start, rawStart: start, customerName: 'テスト 太郎', trainer: TRAINER, slotTrainerId: 'T1',
  free: true, ownerApplied: false, actor: 'customer', key: '', note: '', saved: false, cnOk: false, customerLineId: U_CUS }, o);
const cancel = (o) => (ctx) => { ctx._lbCxlAfter(cxlD(o), Date.now()); return { success: true }; };
const pend = (props) => JSON.parse(props.LB_NOTIFY_PENDING || '[]');
const cnt = (props) => { const o = JSON.parse(props.LB_NOTIFY_DEFER_COUNT || '{}'); return o[Object.keys(o).sort().pop()] || {}; };

// 今の文（スイッチがオフで送られる文）を基準にする
const base = make({ dispatch: book() });
base.ctx.handleLineGet({ action: 'line_makeReservationLine' });
const BASE_PUSHES = base.pushes.map((p) => JSON.stringify(p));
const baseC = make({ dispatch: cancel({ key: 'work' }), ownTid: 'T2' });
baseC.ctx.handleLineGet({ action: 'line_cancelReservation' });
const BASE_CXL = baseC.pushes.map((p) => JSON.stringify(p));

// ================= ① スイッチがオフ =================
console.log('=== ① スイッチがオフ ===');
{
  ok('①-1 予約：会員 → トレーナーの2通・今の引数（429で粘る＝noInlineRetry なし）', base.pushes.length === 2 && base.pushes[0].purpose === 'booking_customer' && base.pushes[1].purpose === 'booking_trainer' && !base.pushes[0].nr && !base.pushes[1].nr, JSON.stringify(base.pushes));
  ok('①-2 待ちを作らない・数えない', !base.props.LB_NOTIFY_PENDING && !base.props.LB_NOTIFY_DEFER_COUNT);
  ok('①-3 予約の送信は応答の前（edgeAfterWrite より前）', base.log.indexOf('push:booking_trainer') < base.log.indexOf('edge'), base.log.join(','));
  ok('①-4 取消：その枠 → 担当 → 会員・noInlineRetry', baseC.pushes.map((p) => p.purpose + ':' + p.to.slice(0, 2)).join(',') === 'cancel_trainer:Ut,cancel_trainer:Uo,cancel_customer:Uc' && baseC.pushes.every((p) => p.nr === true), JSON.stringify(baseC.pushes));
  ok('①-5 ★残数の文は会員の通知の後・トレーナーの LINE ID の後（今と同じ順序）', base.log.join(',').indexOf('push:booking_customer,mark:notify,trLine,mark:notify,remainText,mark:notifyCalc,push:booking_trainer') >= 0 || base.log.join(',').indexOf('push:booking_customer,trLine,mark:notify,remainText,mark:notifyCalc,push:booking_trainer') >= 0, base.log.join(','));
}

// ================= ② スイッチがオン =================
console.log('=== ② スイッチがオン ===');
{
  const t = make({ on: true, dispatch: book() });
  const res = t.ctx.handleLineGet({ action: 'line_makeReservationLine' });
  ok('②-1 ★応答の前に LINE を送らない', t.pushes.length === 0, JSON.stringify(t.pushes));
  const q = pend(t.props);
  ok('②-2 待ちに2通（会員 → トレーナー）', q.length === 2 && q[0].p === 'booking_customer' && q[1].p === 'booking_trainer', JSON.stringify(q.map((x) => x.p)));
  ok('②-3 ★待ちの文と宛先は今の文と1文字も同じ', JSON.stringify(q.map((x) => JSON.stringify({ to: x.to, text: x.text, purpose: x.p, nr: x.nr ? true : false }))) === JSON.stringify(BASE_PUSHES), JSON.stringify(q));
  ok('②-4 ★残数の文は応答の前に作る（書き込みの時点で固定）', t.log.indexOf('remainText') >= 0 && t.log.indexOf('remainText') < t.log.indexOf('edge'));
  ok('②-5 ★トリガーを作る前に待ちへ入る', t.log.indexOf('mark:notifyQ') < t.log.indexOf('edge'), t.log.join(','));
  ok('②-6 応答は変えない', res && res.success === true && !('notifyDeferred' in res));
  ok('②-7 数える held=2', cnt(t.props).held === 2, JSON.stringify(cnt(t.props)));
  ok('②-8 ctx（予約ID・会員・開始）を持つ', q[0].c.resId === 'R1' && q[0].c.customerId === 'C1' && q[0].c.startMs === start.getTime());

  // 取消：その枠のトレーナーは応答の前、担当と会員は後ろ
  const c = make({ on: true, dispatch: cancel({ key: 'work' }), ownTid: 'T2' });
  c.ctx.handleLineGet({ action: 'line_cancelReservation' });
  ok('②-9 ★取消：その枠のトレーナーだけ応答の前', c.pushes.length === 1 && c.pushes[0].to === U_TR && c.pushes[0].purpose === 'cancel_trainer', JSON.stringify(c.pushes));
  const cq = pend(c.props);
  ok('②-10 取消：担当と会員が待ちに（今の文と同じ・noInlineRetry）', cq.length === 2 && JSON.stringify(cq.map((x) => JSON.stringify({ to: x.to, text: x.text, purpose: x.p, nr: x.nr ? true : false }))) === JSON.stringify(BASE_CXL.slice(1)), JSON.stringify(cq));
  ok('②-11 取消：保留は CXL_NOTIFY_SLOW に数えない', !c.log.some((x) => x === 'outcome:CXL_NOTIFY_SLOW'), c.log.join(','));
  // relayed：ひとことを保存して、担当へ保留した → 会員の文に「お伝えします」
  const r = make({ on: true, dispatch: cancel({ note: 'テスト', saved: true }), ownTid: 'T2' });
  r.ctx.handleLineGet({ action: 'line_cancelReservation' });
  ok('②-12 保留は relayed で「送った」と同じ扱い', pend(r.props).some((x) => x.p === 'cancel_customer' && x.text.indexOf('[push_cancel_note_relayed]') >= 0));
  // 振替・代行も対象
  const tr = make({ on: true, dispatch: book('R2', 'transfer') });
  tr.ctx.handleLineGet({ action: 'line_makeTransferReservation' });
  ok('②-13 振替も後ろへ', tr.pushes.length === 0 && pend(tr.props).length === 2);
  const px = make({ on: true, dispatch: book() });
  px.ctx.handleLineGet({ action: 'line_makeReservationLineProxy' });
  ok('②-14 代行も後ろへ', px.pushes.length === 0 && pend(px.props).length === 2);
  const of = make({ on: true, dispatch: cancel({ actor: 'owner' }) });
  of.ctx.handleLineGet({ action: 'line_ownerFreeCancel' });
  ok('②-15 オーナーの無料取消：その枠は前・会員は後ろ', of.pushes.length === 1 && pend(of.props).length === 1 && pend(of.props)[0].p === 'cancel_customer');
}

// ================= ③ 今の経路に倒れる =================
console.log('=== ③ 今の経路に倒れる ===');
{
  const nt = make({ on: true, dispatch: book(), calOk: false });
  nt.ctx.handleLineGet({ action: 'line_makeReservationLine' });
  ok('③-1 ★トリガーを作れない → 取り戻して今の経路で送る（同じ文）', JSON.stringify(nt.pushes.map((p) => JSON.stringify(p))) === JSON.stringify(BASE_PUSHES) && pend(nt.props).length === 0, JSON.stringify(nt.pushes));
  ok('③-2 数える inline_noTrigger=2・held なし', cnt(nt.props).inline_noTrigger === 2 && !cnt(nt.props).held, JSON.stringify(cnt(nt.props)));
  const lf = make({ on: true, dispatch: book(), lockFail: (w) => w === 3000 });
  lf.ctx.handleLineGet({ action: 'line_makeReservationLine' });
  ok('③-3 待ちのロックが取れない → 今の経路（同じ文）', JSON.stringify(lf.pushes.map((p) => JSON.stringify(p))) === JSON.stringify(BASE_PUSHES) && cnt(lf.props).inline_pendFail === 2, JSON.stringify(cnt(lf.props)));
  const full = make({ on: true, dispatch: book(), props: { LB_NOTIFY_PENDING: JSON.stringify(Array.from({ length: 15 }, (_, i) => ({ id: 'q' + i, at: Date.UTC(2026, 10, 16, 3, 0), to: U_CUS, text: 'x', p: 'booking_customer', c: {}, nr: 0, li: '', lu: 0 }))) } });
  full.ctx.handleLineGet({ action: 'line_makeReservationLine' });
  ok('③-4 上限（16件）を超える → 今の経路・待ちは変えない', full.pushes.length === 2 && pend(full.props).length === 15);
  const big = make({ on: true, dispatch: book(), props: { LB_NOTIFY_PENDING: JSON.stringify([{ id: 'q0', at: Date.UTC(2026, 10, 16, 3, 0), to: U_CUS, text: 'あ'.repeat(2600), p: 'booking_customer', c: {}, nr: 0, li: '', lu: 0 }]) } });
  big.ctx.handleLineGet({ action: 'line_makeReservationLine' });
  ok('③-5 UTF-8 で 8,000 バイトを超える → 今の経路', big.pushes.length === 2 && pend(big.props).length === 1);
  const bad = make({ on: true, dispatch: book(), props: { LB_NOTIFY_PENDING: '[{"id":' } });
  bad.ctx.handleLineGet({ action: 'line_makeReservationLine' });
  ok('③-6 ★壊れた待ちは書き換えない・今の経路・印を立てる', bad.props.LB_NOTIFY_PENDING === '[{"id":' && bad.pushes.length === 2 && /^\d+\|\d+$/.test(bad.props.LB_NOTIFY_PENDING_BAD || ''), bad.props.LB_NOTIFY_PENDING_BAD);
  const th = make({ on: true, dispatch: (ctx) => { book()(ctx); throw new Error('boom'); } });
  let thrown = false; try { th.ctx.handleLineGet({ action: 'line_makeReservationLine' }); } catch (e) { thrown = true; }
  ok('③-7 ★振り分けが例外 → 投げ直す前に保留を送る', thrown && th.pushes.length === 2 && cnt(th.props).inline_throw === 2, JSON.stringify(cnt(th.props)));
  const ch = make({ on: true, dispatch: book() });
  ch.ctx.handleLineGet({ action: 'line_changeReservation' });
  ok('③-8 対象外の操作（変更）は今の経路', ch.pushes.length === 2 && !ch.props.LB_NOTIFY_PENDING);
  const cs = make({ on: true, dispatch: book(), calsync: false });
  cs.ctx.handleLineGet({ action: 'line_makeReservationLine' });
  ok('③-9 一回限りトリガーを作れない設定（calsync が止まっている）は今の経路', cs.pushes.length === 2 && !cs.props.LB_NOTIFY_PENDING);
  // トリガーから呼ばれた通知（要求の外）は今のまま
  const tg = make({ on: true });
  tg.ctx._lbNotifyReservation(U_CUS, TRAINER, start, end, 'テスト 太郎', 'line', 'C1', 'R9');
  ok('③-10 要求の外（トリガー等）は今のまま送る', tg.pushes.length === 2);
  // 取り戻すときに別の実行が既に取っていた分は送らない
  const race = make({ on: true, dispatch: book(), calOk: false, onEdge: (ctx, props) => { const q = JSON.parse(props.LB_NOTIFY_PENDING); q[0].li = 'other'; q[0].lu = Date.now() + 300000; props.LB_NOTIFY_PENDING = JSON.stringify(q); } });
  race.ctx.handleLineGet({ action: 'line_makeReservationLine' });
  ok('③-11 取り戻し：別の実行が取り分け中の項目は送らない（その実行が送る）', race.pushes.length === 1 && race.pushes[0].purpose === 'booking_trainer' && pend(race.props).length === 1, JSON.stringify(race.pushes));
}

// ================= ④ 送る側 =================
console.log('=== ④ 送る側 ===');
{
  const t = make({ on: true, dispatch: book() });
  t.ctx.handleLineGet({ action: 'line_makeReservationLine' });
  t.adv(30000);
  t.ctx._lbNotifyDeferDrain('TICK', 30000, 90000);
  ok('④-1 TICK は90秒より新しいものを送らない', t.pushes.length === 0 && pend(t.props).length === 2);
  t.ctx._lbNotifyDeferDrain('WARM', 30000, 300000);
  ok('④-2 WARM は5分より新しいものを送らない', t.pushes.length === 0);
  t.ctx._lbNotifyDeferDrain('AFTER', 30000, 0);
  ok('④-3 ★AFTER は全部送る・順序は会員 → トレーナー・今と同じ引数', JSON.stringify(t.pushes.map((p) => JSON.stringify(p))) === JSON.stringify(BASE_PUSHES), JSON.stringify(t.pushes));
  ok('④-4 送った項目は消える', pend(t.props).length === 0);
  ok('④-5 ★送る間ロックを持たない', !t.log.includes('PUSH_IN_LOCK'));
  const c = cnt(t.props);
  ok('④-6 数える sentAfter=2・maxAgeMs・sendMs', c.sentAfter === 2 && c.maxAgeMs >= 30000 && c.sendN === 2 && c.sendMsSum >= 600 && c.sendMsMax >= 300, JSON.stringify(c));
  t.ctx._lbNotifyDeferDrain('AFTER', 30000, 0);
  ok('④-7 ★二度目は送らない（二重送信なし）', t.pushes.length === 2);

  // LINE が失敗 → _lbPush が notify_retry に1行・待ちからは消える
  const f = make({ on: true, dispatch: book(), pushResult: () => ({ ok: false, code: 500, body: '', uncertain: false }) });
  f.ctx.handleLineGet({ action: 'line_makeReservationLine' });
  f.ctx._lbNotifyDeferDrain('AFTER', 30000, 0);
  ok('④-8 ★失敗は notify_retry に1通1行（pending）・待ちから消える', f.nqRows.length === 2 && f.nqRows.every((r) => r[7] === 'pending') && pend(f.props).length === 0 && cnt(f.props).sendFail === 2, JSON.stringify(f.nqRows.map((r) => r[7])));
  f.ctx._lbNotifyDeferDrain('AFTER', 30000, 0);
  ok('④-9 失敗した通知をもう一度送らない（送り直しは notify_retry だけ）', f.pushes.length === 2 + 0 && f.nqRows.length === 2);

  // 2つの実行：片方が取り分けている間、もう片方は取らない
  const two = make({ on: true, dispatch: book() });
  two.ctx.handleLineGet({ action: 'line_makeReservationLine' });
  let inner = 0;
  const orig = two.ctx._lbPushOnce;
  two.ctx._lbPushOnce = (to, text, o) => { if (!inner) { inner = 1; two.ctx._lbNotifyDeferDrain('TICK', 30000, 0); } return orig(to, text, o); };
  vm.runInContext('', two.ctx);
  two.ctx._lbNotifyDeferDrain('AFTER', 30000, 0);
  ok('④-10 ★取り分け中の項目を別の実行が取らない（各1回・引き渡しもしない）', two.pushes.length === 2 && two.pushes[0].purpose === 'booking_customer' && two.pushes[1].purpose === 'booking_trainer' && two.nqRows.length === 0 && pend(two.props).length === 0, JSON.stringify([two.pushes.map((p) => p.purpose), two.nqRows.length]));

  // 期限切れの取り分け → 送らずに alert（重複は追記しない）
  const nowMs = Date.UTC(2026, 10, 16, 3, 0);
  const item = (id, o = {}) => Object.assign({ id, at: nowMs - 60000, to: U_CUS, text: 'ご予約を承りました。', p: 'booking_customer', c: { resId: 'R1', customerId: 'C1', startMs: start.getTime() }, nr: 0, li: '', lu: 0 }, o);
  const ll = make({ props: { LB_NOTIFY_PENDING: JSON.stringify([item('q1', { li: 'dead', lu: nowMs - 1 })]) } });
  ll.ctx._lbNotifyDeferDrain('TICK', 30000, 90000);
  ok('④-11 ★期限切れの取り分けは送らず alert（id D+待ちのid・delivery_unknown）', ll.pushes.length === 0 && ll.nqRows.length === 1 && ll.nqRows[0][0] === 'Dq1' && ll.nqRows[0][7] === 'alert' && /delivery_unknown/.test(ll.nqRows[0][11]) && pend(ll.props).length === 0 && cnt(ll.props).leaseLost === 1, JSON.stringify(ll.nqRows));
  const ll2 = make({ props: { LB_NOTIFY_PENDING: JSON.stringify([item('q1', { li: 'dead', lu: nowMs - 1 })]) } });
  ll2.nqRows.push(Array.from({ length: 17 }, (_, i) => (i === 0 ? 'Dq1' : '')));
  ll2.ctx._lbNotifyDeferDrain('TICK', 30000, 90000);
  ok('④-12 ★同じ id の行が既にあれば追記しない（引き渡しは冪等）・待ちからは消す', ll2.nqRows.length === 1 && pend(ll2.props).length === 0);
  // 30分より古い → pending で引き渡し（送らない）
  const old = make({ props: { LB_NOTIFY_PENDING: JSON.stringify([item('q2', { at: nowMs - 31 * 60000 })]) } });
  old.ctx._lbNotifyDeferDrain('TICK', 30000, 90000);
  ok('④-13 ★30分より古いものは送らず pending で引き渡す（送る前に I17 の確認が走る）', old.pushes.length === 0 && old.nqRows.length === 1 && old.nqRows[0][0] === 'Dq2' && old.nqRows[0][7] === 'pending' && pend(old.props).length === 0 && cnt(old.props).handover === 1, JSON.stringify(old.nqRows));
  const nosh = make({ noNqSheet: true, props: { LB_NOTIFY_PENDING: JSON.stringify([item('q2', { at: nowMs - 31 * 60000 })]) } });
  nosh.ctx._lbNotifyDeferDrain('TICK', 30000, 90000);
  ok('④-14 引き渡せなければ待ちに残す（取り分けを戻す＝黙って消さない）', pend(nosh.props).length === 1 && !pend(nosh.props)[0].li);
  // 予算切れ：送らずに取り分けを戻す
  const bud = make({ props: { LB_NOTIFY_PENDING: JSON.stringify([item('a'), item('b'), item('c')]) } });
  bud.ctx._lbNotifyDeferDrain('AFTER', 500, 0);
  ok('④-15 予算を超えた分は送らず取り分けを戻す（次の回が送る）', bud.pushes.length === 2 && pend(bud.props).length === 1 && pend(bud.props)[0].id === 'c' && !pend(bud.props)[0].li, JSON.stringify(pend(bud.props)));
  // 送った後に消すロックが取れない → 取り分けのまま（期限後に alert）
  const rm = make({ props: { LB_NOTIFY_PENDING: JSON.stringify([item('a')]) }, lockFail: (w) => w === 5000 });
  rm.ctx._lbNotifyDeferDrain('AFTER', 30000, 0);
  ok('④-16 送った後に消せない → 取り分けのまま残る（送り直さない）', rm.pushes.length === 1 && pend(rm.props).length === 1 && pend(rm.props)[0].li);
  rm.adv(6 * 60000);
  rm.ctx._lbNotifyDeferDrain('AFTER', 30000, 0);
  ok('④-17 ★期限の後もう一度送らない（alert へ）', rm.pushes.length === 1 && rm.nqRows.length === 1 && rm.nqRows[0][7] === 'alert');
  // 空なら何も読まない（ロックを取らない）
  const empty = make({});
  empty.ctx._lbNotifyDeferDrain('TICK', 30000, 90000);
  ok('④-18 待ちが空ならロックを取らない', !empty.log.some((x) => /^lock/.test(x)) && empty.pushes.length === 0);
}

// ================= ⑤ FLUSH =================
console.log('=== ⑤ FLUSH ===');
{
  const nowMs = Date.UTC(2026, 10, 16, 3, 0);
  const item = (id, o = {}) => Object.assign({ id, at: nowMs - 10000, to: U_TR, text: '【新規予約】', p: 'booking_trainer', c: { resId: 'R1', customerId: 'C1', startMs: start.getTime() }, nr: 0, li: '', lu: 0 }, o);
  const t = make({ on: true, dispatch: cancel(), props: { LB_NOTIFY_PENDING: JSON.stringify([item('a'), item('b', { p: 'booking_customer' }), item('x', { c: { resId: 'R2', customerId: 'C1', startMs: 1 } })]) } });
  t.ctx.handleLineGet({ action: 'line_cancelReservation' });
  const q = pend(t.props);
  ok('⑤-1 ★取消の後、その予約の確定の通知は捨てる（送らない）', !t.pushes.some((p) => /^booking_/.test(p.purpose)) && !q.some((x) => x.c.resId === 'R1' && /^booking_/.test(x.p)), JSON.stringify(t.pushes));
  ok('⑤-2 別の予約IDの通知は捨てない（取り直した新しい予約）', q.some((x) => x.id === 'x'));
  ok('⑤-3 数える staleDropped=2', cnt(t.props).staleDropped === 2, JSON.stringify(cnt(t.props)));
  ok('⑤-4 その枠のトレーナーへの取消は応答の前に送る', t.pushes.length === 1 && t.pushes[0].purpose === 'cancel_trainer');
  ok('⑤-5 取消の通知そのもの（cancel_*）は捨てない', q.some((x) => x.p === 'cancel_customer'));
  // 取り分け中：ロックを持たずに待ち、消えたら進む
  const w = make({ on: true, dispatch: cancel(), props: { LB_NOTIFY_PENDING: JSON.stringify([item('a', { li: 'other', lu: nowMs + 300000 })]) },
    onSleep: (ctx, props) => { if (!ctx.__n) { ctx.__n = 1; } else { const qq = JSON.parse(props.LB_NOTIFY_PENDING).filter((x) => x.id !== 'a'); props.LB_NOTIFY_PENDING = JSON.stringify(qq); } } });
  w.ctx.handleLineGet({ action: 'line_cancelReservation' });
  ok('⑤-6 ★取り分け中のその予約の通知は捨てずに待つ・待つ間ロックを持たない', !w.log.includes('SLEEP_IN_LOCK') && w.log.filter((x) => x === 'push:cancel_trainer').length === 1 && !cnt(w.props).flushTimeout, w.log.join(','));
  ok('⑤-7 待ってから取消をトレーナーへ（順序）', w.log.lastIndexOf('push:cancel_trainer') > 0);
  const to = make({ on: true, dispatch: cancel(), props: { LB_NOTIFY_PENDING: JSON.stringify([item('a', { li: 'other', lu: nowMs + 300000 })]) } });
  const t0 = to.now();
  to.ctx.handleLineGet({ action: 'line_cancelReservation' });
  ok('⑤-8 ★消えなければ最大2秒で進み flushTimeout に数える', cnt(to.props).flushTimeout === 1 && to.now() - t0 < 2000 + 1500, String(to.now() - t0));
  // 予算が残っていなければ待たない
  const nb = make({ on: true, props: { LB_NOTIFY_PENDING: JSON.stringify([item('a', { li: 'other', lu: nowMs + 300000 })]) } });
  const s0 = nb.now();
  nb.ctx._lbNotifyDeferFlushRes('R1', s0 - 10500);
  ok('⑤-9 受付12秒の予算の残りが2秒未満なら待たない', nb.now() - s0 < 300 && cnt(nb.props).flushTimeout === 1, String(nb.now() - s0));
  // 待ちが空なら Property を読むだけ
  const e = make({ on: true });
  e.ctx._lbNotifyDeferFlushRes('R1', e.now());
  ok('⑤-10 待ちが空ならロックを取らない', !e.log.some((x) => /^lock/.test(x)));
  const kc = make({ props: { LB_NOTIFY_PENDING: JSON.stringify([item('k', { p: 'cancel_customer', to: U_CUS })]) } });
  kc.ctx._lbNotifyDeferFlushRes('R1', kc.now());
  ok('⑤-14 ★捨てるのは確定の通知（booking_*）だけ・同じ予約IDでも取消の通知は捨てない', pend(kc.props).length === 1 && !cnt(kc.props).staleDropped);
  // 配線：取消は _lbCxlAfter の最初（その枠より前）・変更は通知の前・どちらも台帳の確定とロック解放の後
  const cxlSrc = pluckFn(LB, '_lbCxlAfter');
  ok('⑤-11 ★FLUSH は _lbCxlAfter の中で、その枠のトレーナーより前', cxlSrc.indexOf('_lbNotifyDeferFlushRes(d.resId, t0)') > 0 && cxlSrc.indexOf('_lbNotifyDeferFlushRes(d.resId, t0)') < cxlSrc.indexOf("send('slot'"));
  const chSrc = pluckFn(LB, 'changeReservationLine');
  const iFl = chSrc.indexOf('_lbNotifyDeferFlushRes(reservationId)'), iRel = chSrc.indexOf('lock.releaseLock();'), iPush = chSrc.indexOf("'change_customer'");
  ok('⑤-12 ★変更の FLUSH はロックの解放の後・変更の通知の前（失敗して return する経路より後）', iFl > iRel && iFl < iPush && iFl > chSrc.indexOf('if (!made.success)'), [iFl, iRel, iPush].join(','));
  const cnSrc = pluckFn(LB, 'cancelReservationLine');
  ok('⑤-13 取消の _lbCxlAfter はロックの解放の後（成立したときだけ）', cnSrc.indexOf('_lbCxlAfter(done') > cnSrc.indexOf('lock.releaseLock();') && cnSrc.indexOf("if (!done) return") < cnSrc.indexOf('_lbCxlAfter(done'));
}

// ================= ⑥ 配線 =================
console.log('=== ⑥ 配線 ===');
{
  const order = [];
  const ctx = { String, Logger: { log: () => {} }, LB_CALSYNC: { AFTER_HANDLER: '_lbCalSyncAfterWrite' }, LB_EDGE_DEFER: { AFTER_BUDGET_MS: 60000, TICK_MIN_AGE_MS: 90000 },
    LB_NOTIFY_DEFER: { BUDGET_MS: 30000, TICK_MIN_AGE_MS: 90000, WARM_MIN_AGE_MS: 300000 },
    _lbEdgePendingDrain: (who, b, min) => order.push('edge:' + who + ':' + min),
    _lbNotifyDeferDrain: (who, b, min) => order.push('notify:' + who + ':' + min),
    _lbCalSyncCore: () => { order.push('core'); return { ok: true }; }, lbDualWriteDrain: () => order.push('drain'),
    _lbCalSlotsAfter: () => order.push('slots'), _lbCalSlotsWired: () => order.push('wired'),
    ScriptApp: { getProjectTriggers: () => [], deleteTrigger: () => {} } };
  vm.createContext(ctx);
  vm.runInContext(['_lbCleanCalSyncAfterTriggers', '_lbCalSyncAfterWrite', 'lbCalSyncTick'].map((n) => pluckFn(PE, n)).join('\n'), ctx);
  ctx._lbCalSyncAfterWrite({ triggerUid: 'u1' });
  ok('⑥-1 ★一回限りトリガー：写しの待ち → 通知の待ち（年齢0）→ 同期', order.slice(0, 3).join(',') === 'edge:AFTER:0,notify:AFTER:0,core', order.join(','));
  order.length = 0;
  ctx.lbCalSyncTick();
  ok('⑥-2 5分ごと：通知の待ちは90秒より古いもの・同期より前', order.indexOf('notify:TICK:90000') >= 0 && order.indexOf('notify:TICK:90000') < order.indexOf('core'), order.join(','));
  const wc = pluckFn(CODE, 'warmupCache');
  ok('⑥-3 10分ごと（warmupCache）：送り直しの後に5分より古いもの・例外を外へ出さない', /lbNotifyRetryTick\(_wcStart\)[\s\S]*try \{ _lbNotifyDeferDrain\('WARM', LB_NOTIFY_DEFER\.BUDGET_MS, LB_NOTIFY_DEFER\.WARM_MIN_AGE_MS\); \} catch/.test(wc));
  const all = [LB, PE, CODE].join('\n');
  ok('⑥-4 新しいトリガー0本（このファイル群で newTrigger の対象に _lbNotify を作らない）', !/newTrigger\([^)]*Notify/i.test(all));
  ok('⑥-5 ★_lbScheduleCalSync は作れたときだけ _LB_CAL_SCHEDULED を立てる', /\.after\(1000\)\.create\(\);\s*_LB_CAL_SCHEDULED = true;[^\n]*\n\s*return true;/.test(pluckFn(PE, '_lbScheduleCalSync')));
  const run = pluckFn(LB, '_lbNotifyDeferRun');
  ok('⑥-6 ★送る側は文面を作らない（待ちの text をそのまま _lbPush へ）', /_lbPush\(it2\.to, it2\.text, it2\.p, it2\.c,/.test(run) && !/_lbTrainerRemainText|_lbSt\(|_lbFmtResvLabel/.test(run));
  const hg = pluckFn(LB, 'handleLineGet');
  ok('⑥-7 handleLineGet：待ちへ → edgeAfterWrite → 片付け の順', hg.indexOf('_lbNotifyHoldPersist()') < hg.indexOf('edgeAfterWrite(') && hg.indexOf('edgeAfterWrite(') < hg.indexOf('_lbNotifyHoldSettle(true)'));
  ok('⑥-8 dailyHealthCheck が引き渡しと点検を呼ぶ', /lbNotifyDeferDailyMaint\(/.test(LB) && /lbNotifyDeferDailyCheck\(Date\.now\(\)/.test(LB));
}

// ================= ⑦ 日次点検と記録 =================
console.log('=== ⑦ 日次点検と記録 ===');
{
  const now = Date.UTC(2026, 10, 16, 3, 0);
  const y = new Date(now - 86400000 + 9 * H).toISOString().slice(0, 10);
  const get = (o) => (k) => (k in o ? o[k] : null);
  const t = make({});
  const chk = t.ctx.lbNotifyDeferDailyCheck;
  ok('⑦-1 スイッチがオフで待ちも空なら何も言わない', chk(now, get({ LB_NOTIFY_DEFER_COUNT: JSON.stringify({ [y]: { leaseLost: 1 } }) })).length === 0);
  ok('⑦-2 ★待ちが壊れていれば high（スイッチに関係なく）', chk(now, get({ LB_NOTIFY_PENDING: '{x' })).some((x) => x.key === 'notify_defer_pending_broken' && x.severity === 'high'));
  const oldq = JSON.stringify([{ id: 'q', at: now - 11 * 60000, to: U_CUS, text: 'x', p: 'booking_customer', c: {}, nr: 0, li: '', lu: 0 }]);
  const r1 = chk(now, get({ LB_NOTIFY_PENDING: oldq }));
  ok('⑦-3 待ちに10分より古い項目 → warn（スイッチに関係なく）', r1.some((x) => x.key === 'notify_defer_pending_old' && x.severity === 'warn'));
  ok('⑦-4 ★点検の文に LINE ID・本文を出さない', !JSON.stringify(r1).includes(U_CUS) && !JSON.stringify(chk(now, get({ LB_NOTIFY_PENDING: '{x' }))).includes('{x'));
  const r2 = chk(now, get({ LB_NOTIFY_DEFER: '1', LB_NOTIFY_DEFER_COUNT: JSON.stringify({ [y]: { held: 10, inline_noTrigger: 2, inline_pendFail: 2, leaseLost: 1, handover: 1, flushTimeout: 1, maxAgeMs: 11 * 60000, lockMsMax: 1500 } }) }));
  const keys = r2.map((x) => x.key).sort().join(',');
  ok('⑦-5 昨日の leaseLost・handover・flushTimeout・遅れ・ロック・後ろへ回せなかった割合 → warn', ['notify_defer_inline', 'notify_defer_lease_lost', 'notify_defer_handover', 'notify_defer_flush_timeout', 'notify_defer_slow', 'notify_defer_lock_slow'].every((k) => keys.includes(k)), keys);
  ok('⑦-6 待ちの壊れた印（24時間以内）→ high', chk(now, get({ LB_NOTIFY_PENDING_BAD: (now - H) + '|10' })).some((x) => x.key === 'notify_defer_pending_rebuilt' && x.severity === 'high'));

  // 日次の手入れ：30分超の引き渡し・壊れた値は24時間後に消す（中身を出さない）
  const m = make({ props: { LB_NOTIFY_PENDING: '[{"id":', LB_NOTIFY_PENDING_BAD: (now - 25 * H) + '|7' } });
  m.ctx.lbNotifyDeferDailyMaint();
  ok('⑦-7 ★壊れた値は24時間後に消す（時刻と長さだけ残す）', !('LB_NOTIFY_PENDING' in m.props) && cnt(m.props).badCleared === 1);
  const m2 = make({ props: { LB_NOTIFY_PENDING: '[{"id":', LB_NOTIFY_PENDING_BAD: (now - 2 * H) + '|7' } });
  m2.ctx.lbNotifyDeferDailyMaint();
  ok('⑦-8 24時間以内の壊れた値は残す（オーナーが確かめられる）', m2.props.LB_NOTIFY_PENDING === '[{"id":');
  const m3 = make({ props: { LB_NOTIFY_PENDING: JSON.stringify([{ id: 'q9', at: now - 40 * 60000, to: U_CUS, text: 'x', p: 'booking_customer', c: { resId: 'R1', customerId: 'C1', startMs: start.getTime() }, nr: 0, li: '', lu: 0 }]) } });
  m3.ctx.lbNotifyDeferDailyMaint();
  ok('⑦-9 ★日次の手入れも30分超を引き渡す（送る側が止まっていても Script Properties に残さない）', m3.nqRows.length === 1 && m3.nqRows[0][0] === 'Dq9' && pend(m3.props).length === 0 && m3.pushes.length === 0);

  // 作業依頼の結果（数だけ）
  const s = make({ props: { LB_NOTIFY_PENDING: oldq, LB_NOTIFY_DEFER: '1', LB_NOTIFY_DEFER_COUNT: JSON.stringify({ [y]: { held: 3, sentAfter: 3, sendN: 3, sendMsSum: 900, sendMsMax: 400 } }) } });
  const txt = s.ctx._lbNotifyDeferSummaryText();
  ok('⑦-10 作業依頼の結果：待ちの件数・最古・昨日の数（LINE ID・本文なし）', /待ち 1件/.test(txt) && /最古 11分/.test(txt) && /held=3/.test(txt) && !txt.includes(U_CUS), txt);
  ok('⑦-11 writePerfText がこの要約を載せる', /_lbNotifyDeferSummaryText\(\)/.test(pluckFn(LB, 'writePerfText')));
  // 段：notifyCalc・notifyQ を後ろに足す（旧い並び11も読む）
  const st = (LB.match(/STAGES: \[([^\]]*)\]/) || [])[1] || '';
  ok('⑦-12 段 notifyCalc・notifyQ を後ろに足す', /'member', 'edgeMark', 'notifyCalc', 'notifyQ'$/.test(st.trim()), st);
  ok('⑦-13 Script Properties の待ちは会員の氏名・電話の欄を持たない（to・text・p・c・nr・li・lu・id・at だけ）', (() => {
    const t2 = make({ on: true, dispatch: book() }); t2.ctx.handleLineGet({ action: 'line_makeReservationLine' });
    return pend(t2.props).every((x) => Object.keys(x).sort().join(',') === 'at,c,id,li,lu,nr,p,text,to' && Object.keys(x.c).sort().join(',') === 'customerId,resId,startMs');
  })());
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
