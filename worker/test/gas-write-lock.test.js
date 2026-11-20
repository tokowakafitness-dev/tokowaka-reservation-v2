// 設計47 A2：書き込みのロック待ちの時間切れは BUSY で返す（何も書かない）・ロックの競合を数える（2026-11-20）
//   実行: node worker/test/gas-write-lock.test.js
//
//   ① 別の実行が ScriptLock を持った状態で、入口から10関数すべてを呼ぶ → BUSY・1セルも書かない・記録の busy が入口ごとに1増える
//      verifyMembership は doGet・doPost・liffApi の3入口／保守関数 mergeMemberLink・addOfflineMember は直接
//   ② ロックを取った後の例外は BUSY にしない（THROW のまま投げ直す）・その経路でも数を書く・ロックは放してある
//   ③ 変更から予約の芯（既にロックを持つ）：芯は取り直さない（再入の tryLock は身代わりが例外にする）・数えない・ロックは持ったまま
//   ⑤ ロックの前に台帳・名簿へ書く文が無い（①で書き込み0回）
//   ⑨ 記録に会員ID・LINE ID・予約ID・例外の文が入らない
//   ⑫ 記録の Properties が例外を投げても、BUSY の応答・例外・ロックの状態が変わらない（fault injection）
//   ★LockService の身代わりは再入を許さない（GAS の未確認の仕様を真にしない）：
//     実行ごとに持ち主を持ち、同じ実行で持っているのに tryLock／waitLock を呼んだら例外を投げる
//   ★値は架空（個人情報を書かない）
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { writeLockSrc, pluckFnFrom as pluckFn, pluckVarFrom as pluckVar } from './_gas-lock-src.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GAS = process.env.GAS_DIR || join(ROOT, 'gas');   // 赤を確かめるときは反映前の版を指す
const LB = readFileSync(join(GAS, 'LineBooking.js'), 'utf8');
const CODE = readFileSync(join(GAS, 'コード.js'), 'utf8');
let pass = 0, fail = 0;
function ok(name, cond, why) { if (cond) pass++; else { fail++; console.log(`❌ ${name}`); if (why) console.log(`   ${why}`); } }

const LUID = 'U' + '0'.repeat(32);
const DAY = 86400000;

// ---- 世界：実行ごとの ScriptLock・台帳・Properties ----
function world(opt = {}) {
  const st = { owner: null, cur: 'me', tryCalls: 0, reentrant: 0, writes: 0, writeLog: [], props: Object.assign({}, opt.props || {}), order: [] };
  const lockObj = () => ({
    hasLock: () => st.owner === st.cur,
    tryLock: () => {
      st.tryCalls++;
      if (st.owner === st.cur) { st.reentrant++; throw new Error('REENTRANT_TRY'); }
      if (st.owner) return false;
      st.owner = st.cur; st.order.push('lock'); return true;
    },
    waitLock: () => {
      if (st.owner === st.cur) { st.reentrant++; throw new Error('REENTRANT_WAIT'); }
      if (st.owner) throw new Error('Lock timeout: another process was holding the lock for too long.');
      st.owner = st.cur; st.order.push('lock');
    },
    releaseLock: () => { if (st.owner === st.cur) { st.owner = null; st.order.push('release'); } },
  });
  const w = (what) => { st.writes++; st.writeLog.push(what); };
  const future = new Date(Date.now() + 5 * DAY);
  const resvRow = [future, 'テスト 太郎', 'C1', LUID, 'T1', '', 'confirmed', '', 'R1', 'line', '', '', '', '', 1];
  const mkSheet = (rows) => ({
    getLastRow: () => rows.length + 1, getLastColumn: () => 15,
    getRange: (r, c, nr, nc) => ({
      getValues: () => rows.map((x) => x.slice(0, Math.max(nc || 15, 15))),
      getValue: () => { if (opt.throwOnRead) throw new Error('read boom 090-0000-0000'); return (rows[r - 2] || [])[c - 1]; },
      setValue: () => w('setValue'), setValues: () => w('setValues'), clearContent: () => w('clear'),
    }),
    appendRow: () => w('appendRow'), deleteRow: () => w('deleteRow'), insertRowAfter: () => w('insert'),
  });
  const resvSheet = mkSheet([resvRow]);
  const mapSheet = mkSheet([['C1', 'テスト 太郎', '', '', '', '', '', '', '', '', '', '', '']]);
  const out = {
    String, Number, JSON, Math, Object, Array, Date, RegExp, Error, isFinite, isNaN, parseInt, parseFloat, encodeURIComponent,
    Logger: { log: () => {} }, console,
    LockService: { getScriptLock: lockObj },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => { if (opt.propsThrow) throw new Error('p'); return (k in st.props ? st.props[k] : null); },
      setProperty: (k, v) => { if (opt.propsThrow) throw new Error('s'); st.order.push('set:' + k + (st.owner ? ':LOCKED' : '')); st.props[k] = String(v); },
      deleteProperty: (k) => { delete st.props[k]; },
    }) },
    Utilities: { formatDate: (d) => new Date(d.getTime() + 9 * 3600000).toISOString().slice(0, 10) },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {} }) },
    ContentService: { MimeType: { JAVASCRIPT: 'js', TEXT: 'text' }, createTextOutput: (s) => ({ s, setMimeType() { return this; } }) },
    LB_HEALTH_BUILD: '2026-11-20a テスト',
    SETTINGS: { SESSION_MINUTES: 60, TRIAL_SESSION_MINUTES: 90, BUSINESS_START: 7, BUSINESS_END: 24 },
    verifyLineIdToken: () => ({ ok: true, lineUserId: LUID }),
    edgeAfterWrite: () => {}, _lbNotifyHoldStart: () => {}, _lbNotifyHoldPersist: () => {}, _lbNotifyHoldSettle: () => {},
    _lbJson: (o) => o,
    _lbSheet: (name) => (/reserv/.test(String(name)) ? resvSheet : mapSheet),
    _lbRecurSheet: () => mkSheet([['P1', 'C1', 1, '10:00', 'T1', true]]),
    getCustomerByLine: () => ({ row: 2, data: (() => { const d = new Array(20).fill(''); d[out.MAP_COL.AUTH_STATE - 1] = 'verified'; d[out.MAP_COL.CUSTOMER_ID - 1] = 'C1'; d[out.MAP_COL.NAME - 1] = 'テスト 太郎'; return d; })() }),
    getTrainerByLine: () => ({ trainerId: 'T1', role: 'owner' }),
    requireTrainer: () => ({ trainerId: 'T1', role: 'owner' }),
    _lbIsOwnerRole: () => true, _lbTrainerMaySeeCustomer: () => true, _lbCustOwnerOf: () => 'T1', _lbTrainerCanManageRecur: () => true,
    _lbFindVerifiedByLine: () => null,
    _lbFindContract: () => ({ cols: { phone: 0, type: 1, trainer: 2 }, row: ['09000000000', '通常', 'テスト トレーナー'] }),
    _lbNormPhone: (s) => String(s || '').replace(/\D/g, ''), _lbNormName: (s) => String(s || ''), _lbRegFail: (c, m) => ({ success: false, code: c, message: m }),
    _lbTrainerIdByName: () => 'T1', _lbTrainerById: () => ({ trainerId: 'T1', name: 'テスト トレーナー' }),
    _lbContractTypeOf: () => '', _lbBookingGate: () => ({ ok: true }), _lbBookingOpen: () => true, _lbBookingCfg: () => ({}), _lbHorizonGate: () => null,
    _lbCxlExpect: () => '', _lbCxlNormalize: () => ({}), _lbCnReady: () => true, _lbCustOwnerMap: () => ({}),
    _lbParseResvDate: (v) => new Date(v), _lbIsFreeCancelWindow: () => true,
    _lbValidWeekday: () => true, _lbValidTimeHHmm: () => true, _lbRecurTime: (s) => s, _lbCustInfoById: () => ({ customerId: 'C1' }), _lbCustTrainerId: () => 'T1',
    _lbRecurRowByPattern: () => ({ rowIndex: 2, row: ['P1', 'C1', 1, '10:00', 'T1', true] }),
    _lbLogOutcome: () => {}, _lbConsecMode: () => 'off',
  };
  //   ★知らない名前は「何も返さない関数」にする（ロックの前の部品だけを手で与え、残りはここに落ちる）
  const ctx = new Proxy(out, {
    has: () => true,
    get: (t, k) => {
      if (k in t) return t[k];
      if (typeof k === 'symbol' || k in globalThis) return globalThis[k];
      const f = function () { return undefined; };
      t[k] = f; return f;
    },
  });
  vm.createContext(ctx);
  const LB_FNS = ['handleLineGet', '_lbDispatch', '_lbWpStart', '_lbWpMark', '_lbWpCode', '_lbWpRow', '_lbWpStagesOf', '_lbWpValidRow', '_lbWpFinish',
    'doPost', 'liffApi', 'verifyMembership', 'selfRegister', 'mergeMemberLink', 'addOfflineMember', 'makeReservationLine', '_lbReserveCore', '_lbReserveCoreImpl',
    'cancelReservationLine', 'undoSameDayCancel', 'changeReservationLine', 'addRecurringPatternByTrainer', '_lbAddRecurPattern', 'deleteRecurringPattern'];
  let src = pluckVar(LB, 'LINE_BOOKING') + pluckVar(LB, 'MAP_COL') + pluckVar(LB, 'RP_COL') + pluckVar(LB, 'LB_WP') + pluckVar(LB, 'LB_WP_CODES')
    + 'var _LB_WP = null;\nvar _LB_WRITE_CUST = null;\nvar _LB_NOTIFY_HOLD = null;\n';
  try { src += writeLockSrc(LB); } catch (e) { /* 反映前の版には無い（赤を確かめるとき） */ }
  src += LB_FNS.map((n) => pluckFn(LB, n)).join('\n') + pluckFn(CODE, 'doGet');
  vm.runInContext(src, ctx);
  const run = (fn) => { try { return { r: fn() }; } catch (e) { return { e }; } };
  return { ctx, st, run, out };
}
const parseGet = (o) => (o && typeof o.s === 'string') ? JSON.parse(o.s) : o;
const count = (st) => { try { return JSON.parse(st.props.LB_WRITE_LOCK_COUNT || '{}'); } catch (e) { return null; } };
const todayOf = (st) => { const c = count(st); const k = Object.keys(c || {}); return k.length ? c[k[k.length - 1]] : {}; };
const wpLast = (st) => { try { return JSON.parse(st.props.LB_WRITE_PERF).items[0]; } catch (e) { return null; } };

const future = new Date(Date.now() + 3 * DAY).toISOString();
//   入口と呼び方（op は記録の名前）
const CASES = [
  { name: '予約（doGet→handleLineGet→makeReservationLine→芯）', op: 'reserve', get: { action: 'line_makeReservationLine', trainerId: 'T1', startISO: future } },
  { name: '会員の取消', op: 'cancel', get: { action: 'line_cancelReservation', reservationId: 'R1' } },
  { name: 'オーナーの無料取消', op: 'cancel', get: { action: 'line_ownerFreeCancel', reservationId: 'R1' } },
  { name: '変更', op: 'change', get: { action: 'line_changeReservation', reservationId: 'R1', newStartISO: future } },
  { name: '当日取消を無料に直す', op: 'undoSdc', get: { action: 'line_undoSameDayCancel', reservationId: 'R1' } },
  { name: '固定枠の追加', op: 'recurAdd', get: { action: 'line_addRecurringPatternByTrainer', customerId: 'C1', weekday: '1', time: '10:00', trainerId: '' } },
  { name: '固定枠の削除', op: 'recurDel', get: { action: 'line_deleteRecurringPattern', patternId: 'P1' } },
  { name: '自己登録', op: 'selfReg', get: { action: 'line_selfRegister', name: 'テスト 太郎', phone: '090-0000-0000', email: 'a@example.invalid', birthday: '2000-01-01', goal: 'x' } },
  { name: '会員の紐付け（doGet）', op: 'verify', get: { action: 'line_verifyMembership', code: '123456' } },
];

console.log('=== ① 別の実行がロックを持つ → BUSY・何も書かない・数える（入口から） ===');
for (const c of CASES) {
  const w = world();
  w.st.owner = 'other';
  const x = w.run(() => parseGet(w.ctx.doGet({ parameter: Object.assign({ idToken: 'x' }, c.get) })));
  const r = x.r || {};
  ok(`①-${c.op} ${c.name}：BUSY`, r.success === false && r.code === 'BUSY' && /混み合って/.test(String(r.message || '')), JSON.stringify(x.e ? String(x.e) : r));
  ok(`①-${c.op} ${c.name}：台帳・名簿に1セルも書いていない（⑤）`, w.st.writes === 0, w.st.writeLog.join(','));
  const t = todayOf(w.st);
  ok(`①-${c.op} ${c.name}：記録の busy が1・n が1（flush が出口で走る）`, t[c.op] && t[c.op].busy === 1 && t[c.op].n === 1, JSON.stringify(count(w.st)));
  ok(`①-${c.op} ${c.name}：ロックは他の実行のまま`, w.st.owner === 'other');
}
{
  //   書き込みの段の記録（設計43）にも BUSY で残る（対象の op）
  const w = world(); w.st.owner = 'other';
  w.run(() => parseGet(w.ctx.doGet({ parameter: { idToken: 'x', action: 'line_changeReservation', reservationId: 'R1', newStartISO: future } })));
  const row = wpLast(w.st);
  ok('①-wp 変更の BUSY は LB_WRITE_PERF にコード BUSY で残る（許可リストの BUSY・最後の印は handleLineGet の other）', row && row[3] === 'BUSY', JSON.stringify(row));
}
{
  //   verifyMembership の残り2入口（旧経路・公開 Web App で到達可能）
  const w1 = world(); w1.st.owner = 'other';
  const r1 = w1.run(() => w1.ctx.doPost({ postData: { contents: JSON.stringify({ action: 'verifyMembership', idToken: 'x', code: '123456' }) }, parameter: {} }));
  ok('①-verify doPost：BUSY', r1.r && r1.r.code === 'BUSY', JSON.stringify(r1.r || String(r1.e)));
  ok('①-verify doPost：数が書かれる（doPost の出口の flush）', (todayOf(w1.st).verify || {}).busy === 1, JSON.stringify(count(w1.st)));
  const w2 = world(); w2.st.owner = 'other';
  const r2 = w2.run(() => JSON.parse(w2.ctx.liffApi(JSON.stringify({ action: 'verifyMembership', idToken: 'x', code: '123456' }))));
  ok('①-verify liffApi：BUSY', r2.r && r2.r.code === 'BUSY', JSON.stringify(r2.r || String(r2.e)));
  ok('①-verify liffApi：数が書かれる（liffApi の出口の flush）', (todayOf(w2.st).verify || {}).busy === 1, JSON.stringify(count(w2.st)));
  ok('①-verify 3入口とも書き込み0', w1.st.writes === 0 && w2.st.writes === 0);
}
{
  //   保守関数（エディタから直接）
  const w = world(); w.st.owner = 'other';
  const r = w.run(() => w.ctx.mergeMemberLink('C1', 'C2'));
  ok('①-merge mergeMemberLink：{ok:false, code:BUSY}・書き込み0・数える', r.r && r.r.ok === false && r.r.code === 'BUSY' && w.st.writes === 0 && (todayOf(w.st).merge || {}).busy === 1, JSON.stringify(r.r || String(r.e)) + JSON.stringify(count(w.st)));
  const w2 = world(); w2.st.owner = 'other';
  const r2 = w2.run(() => w2.ctx.addOfflineMember('テスト 太郎', '090-0000-0000'));
  ok('①-offline addOfflineMember：BUSY・書き込み0・数える', r2.r && r2.r.code === 'BUSY' && w2.st.writes === 0 && (todayOf(w2.st).offline || {}).busy === 1, JSON.stringify(r2.r || String(r2.e)) + JSON.stringify(count(w2.st)));
}

console.log('=== ② ロックを取った後の例外は BUSY にしない ===');
{
  const w = world({ throwOnRead: true });
  const x = w.run(() => parseGet(w.ctx.doGet({ parameter: { idToken: 'x', action: 'line_changeReservation', reservationId: 'R1', newStartISO: future } })));
  const r = x.r || {};
  ok('②-1 変更：ロックの中の読みの例外は {error}（doGet の catch）・BUSY ではない', r.code !== 'BUSY' && typeof r.error === 'string', JSON.stringify(r));
  const row = wpLast(w.st);
  ok('②-2 書き込みの段の記録は THROW', row && row[3] === 'THROW', JSON.stringify(row));
  const t = todayOf(w.st).change || {};
  ok('②-3 その経路でも数を書く（n=1・busy=0）＝handleLineGet の catch の flush', t.n === 1 && t.busy === 0, JSON.stringify(count(w.st)));
  ok('②-4 ロックは放してある', w.st.owner === null);
  ok('②-5 ★例外の文（電話の形）は記録に入らない', !/090|boom/.test(JSON.stringify(w.st.props)));
}

console.log('=== ③ 変更から予約の芯（既にロックを持つ）===');
{
  const w = world();
  w.st.owner = 'me';   // 変更がロックを持っている状態
  const x = w.run(() => w.ctx._lbReserveCoreImpl({ customerId: 'C1', customerName: 'テスト 太郎', contractType: '', lineUserId: LUID }, { trainerId: 'T1', startISO: future }, 'change'));
  ok('③-1 芯は tryLock／waitLock を呼ばない（呼べば身代わりが REENTRANT を投げる）', w.st.reentrant === 0 && w.st.tryCalls === 0, String(x.e || '') + ' try=' + w.st.tryCalls);
  ok('③-2 芯はロックを放さない（外側＝変更のロック）', w.st.owner === 'me');
  w.run(() => w.ctx._lbWlFlush());
  ok('③-3 取り直さない回は数えない（reserve が無い）', !(todayOf(w.st).reserve), JSON.stringify(count(w.st)));
}

console.log('=== ⑨ 記録に個人情報が入らない ===');
{
  const all = [];
  for (const c of CASES) { const w = world(); w.st.owner = 'other'; w.run(() => w.ctx.doGet({ parameter: Object.assign({ idToken: 'x' }, c.get) })); all.push(w.st.props.LB_WRITE_LOCK_COUNT || ''); }
  const s = all.join('\n');
  ok('⑨-1 LINE ID・会員ID・予約ID・電話・メールが無い', s.length > 0 && !/U0000|"C1"|C1[,}]|R1|P1|090|example/.test(s), s.slice(0, 300));
  ok('⑨-2 鍵は許可リストの op だけ', [...s.matchAll(/"([A-Za-z_]+)":\{/g)].every((m) => /^(reserve|cancel|change|undoSdc|recurAdd|recurDel|verify|selfReg|merge|offline|OTHER)$/.test(m[1])), s.slice(0, 300));
}

console.log('=== ⑫ 記録が例外を投げても結果は変わらない（fault injection） ===');
{
  const a = world(); a.st.owner = 'other';
  const ra = a.run(() => parseGet(a.ctx.doGet({ parameter: { idToken: 'x', action: 'line_cancelReservation', reservationId: 'R1' } })));
  const b = world({ propsThrow: true }); b.st.owner = 'other';
  const rb = b.run(() => parseGet(b.ctx.doGet({ parameter: { idToken: 'x', action: 'line_cancelReservation', reservationId: 'R1' } })));
  ok('⑫-1 BUSY の応答が同じ', JSON.stringify(ra.r) === JSON.stringify(rb.r) && rb.r && rb.r.code === 'BUSY', JSON.stringify([ra.r, rb.r]));
  ok('⑫-2 ロックの状態が同じ（他の実行のまま）', b.st.owner === 'other');
  const c = world({ throwOnRead: true, propsThrow: true });
  const rc = c.run(() => parseGet(c.ctx.doGet({ parameter: { idToken: 'x', action: 'line_changeReservation', reservationId: 'R1', newStartISO: future } })));
  ok('⑫-3 ロックを取った後の例外も同じ形（{error}）・ロックは放してある', rc.r && typeof rc.r.error === 'string' && c.st.owner === null, JSON.stringify(rc.r || String(rc.e)));
  const d = world({ propsThrow: true }); d.st.owner = 'other';
  const rd = d.run(() => d.ctx.mergeMemberLink('C1', 'C2'));
  ok('⑫-4 保守関数も同じ（{ok:false, code:BUSY}）', rd.r && rd.r.code === 'BUSY', JSON.stringify(rd.r || String(rd.e)));
}

console.log('=== 記録の書き方（_lbLcMerge） ===');
{
  const w = world();
  w.st.props.LB_WRITE_LOCK_COUNT = '{壊れた';
  w.run(() => { w.ctx._lbWlTally('cancel', false, 0); w.ctx._lbWlFlush(); });
  ok('M-1 壊れた記録は上書きしない・BAD に鍵と理由と時刻だけ', w.st.props.LB_WRITE_LOCK_COUNT === '{壊れた' && /^LB_WRITE_LOCK_COUNT\|BAD_JSON\|\d+$/.test(w.st.props.LB_LOCK_COUNT_BAD || ''), w.st.props.LB_LOCK_COUNT_BAD);
  const w2 = world();
  w2.run(() => { w2.ctx._lbWlTally('cancel', true, 30); w2.ctx._lbWlTally('cancel', true, 70); w2.ctx._lbWlTally('cancel', false, 0); w2.ctx._lbWlFlush(); w2.ctx._lbWlFlush(); });
  const t = todayOf(w2.st).cancel || {};
  ok('M-2 足し算（n・busy）と最大（waitMax）・2回目の flush は何も書かない（空にしてある）', t.n === 3 && t.busy === 1 && t.waitMax === 70, JSON.stringify(count(w2.st)));
  w2.run(() => { w2.ctx._lbWlTally('ほかの名前', true, 1); });
  ok('M-3 許可リストに無い op は呼び出し側（_lbTakeWriteLock）で OTHER に寄せる', /var key = LB_LC\.WRITE_OPS\[op\] \? op : 'OTHER';/.test(pluckFn(LB, '_lbTakeWriteLock')));
}

console.log('=== 日次点検（lbLockCountDailyCheck・3-8） ===');
{
  const ctx = { String, Number, JSON, Math, Object, isFinite, Date, Utilities: { formatDate: (d) => new Date(d.getTime() + 9 * 3600000).toISOString().slice(0, 10) } };
  vm.createContext(ctx);
  let ok0 = true;
  try { vm.runInContext(pluckVar(LB, 'LB_LC') + pluckFn(LB, '_lbLcDay') + pluckFn(LB, 'lbLockCountDailyCheck'), ctx); } catch (e) { ok0 = false; }
  ok('D-0 点検の関数がある', ok0);
  if (ok0) {
    const NOW = Date.UTC(2026, 10, 21, 0, 0);   // JST 11/21 9:00
    const Y = '2026-11-20', D2 = '2026-11-19';
    const chk = (props) => ctx.lbLockCountDailyCheck(NOW, (k) => (k in props ? props[k] : null));
    const keyOf = (r) => r.map((x) => x.key + ':' + x.severity).sort().join(',');
    const a = chk({ LB_WRITE_LOCK_COUNT: JSON.stringify({ [Y]: { change: { n: 12, busy: 3, waitMax: 900 } } }),
                    LB_EDGE_PUSH_COUNT: JSON.stringify({ [D2]: { all: { n: 1 } }, [Y]: { all: { n: 4, thrown: 1, holdMax: 400000, holdSum: 500000, over10Sum: 120000 }, nested_all: { n: 1 } } }) });
    ok('D-1 BUSY・10秒超・例外・長すぎ・入れ子をそれぞれ warn', keyOf(a) === ['push_hold_long:warn', 'push_lock_over10:warn', 'push_nested_unexpected:warn', 'push_thrown:warn', 'write_lock_busy:warn'].sort().join(','), keyOf(a));
    const busy = a.find((x) => x.key === 'write_lock_busy');
    ok('D-2 ★表示は「対象10操作のロック競合（全書き込みのロックではない・下限）」と op ごとの busy/n', busy && /対象10操作のロック競合（全書き込みのロックではない・下限）/.test(busy.detail) && /change 3\/12/.test(busy.detail), busy && busy.detail);
    ok('D-3 10秒超の秒数（120秒）', (a.find((x) => x.key === 'push_lock_over10') || {}).count === 120);
    ok('D-4 記録がまだ無い（反映前）は info だけ', keyOf(chk({})) === 'push_count_none:info', keyOf(chk({})));
    ok('D-5 前に記録があるのに昨日が無い＝押し出しが走った証拠が無い → high', keyOf(chk({ LB_EDGE_PUSH_COUNT: JSON.stringify({ [D2.replace('19', '18')]: { all: { n: 1 } } }) })) === 'push_count_missing:high');
    ok('D-6 反映した日（今日だけ）は鳴らさない', keyOf(chk({ LB_EDGE_PUSH_COUNT: JSON.stringify({ '2026-11-21': { all: { n: 1 } } }) })) === '');
    ok('D-7 壊れた記録・BAD は high（中身は写さない）', keyOf(chk({ LB_WRITE_LOCK_COUNT: '{x', LB_LOCK_COUNT_BAD: 'LB_EDGE_PUSH_COUNT|TOO_BIG|1' })) === ['lock_count_bad:high', 'push_count_none:info', 'write_lock_count_unreadable:high'].sort().join(','));
    ok('D-8 何も起きていなければ空', keyOf(chk({ LB_WRITE_LOCK_COUNT: JSON.stringify({ [Y]: { cancel: { n: 5, busy: 0 } } }), LB_EDGE_PUSH_COUNT: JSON.stringify({ [Y]: { slots: { n: 140, holdMax: 2100, over10Sum: 0 } } }) })) === '');
  }
}

console.log(`\n${fail ? '❌' : '✅'} 設計47 書き込みのロック 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
