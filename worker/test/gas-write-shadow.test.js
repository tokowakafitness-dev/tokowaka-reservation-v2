// 設計54 S1a：write-shadow の GAS 側（本物のソースから関数を取り出し、vm で入口から通す）
//   実行: node worker/test/gas-write-shadow.test.js
//
//   ① I83：handleLineGet の予約の入口から通し、6列目の有無で返り値と身代わり（カレンダー・台帳）への呼び出しが同じ。
//      6列目を作る処理が落ちても5列の行が書かれ、予約は成功
//   ② 分岐ごとの「どこで決まったか」（b1・trainer・remain＋種別・deadline・ok と自分の ID）
//   ③ 6列目の中身：氏名・LINE の ID・予定名が無い／許可した鍵だけ／1,000文字以内（超えたら n と too_long だけ）
//   ④ 送る段は一回限りトリガー・5分ごとの同期の最後・経過が4分（tick は3分）以上なら何もしない
//   ④-c 3つの出口（認証の失敗・例外を投げ直す・通常）／BUSY の行は at=busy
//   ④-d〜④-k 送る側：続きから読む・n で冪等・照合（skip／conflict）では sent を付けない・カーソルが崩れたら送らない・
//      ロックが取れなければ何もしない・2時間超は stale の印を残して進む・Worker への報告が落ちても印から数えられる
//   ④-f 保護：確かめられないなら置かない（blockedAt）・置いたら2回目は何もしない・印つきの保護だけ外す
//   ④-l booking_metrics に書けなかった事実を数える（失敗のときだけ・Property も落ちたら元の例外のまま）
//   ⑤ 独立の検知の時刻の境目（23:49 入る／23:50 入らない／00:10:00 入る／00:10:01 入らない・Date 値と文字列・形の違う文字列・00:10 前の実行）
//   ⑥ I83：顧客の要求の経路で LockService・PropertiesService の呼び出しが増えていない
//   ⑦ トリガーの集合は変わらない（新しいトリガーを作らない）
//   ★値は架空（個人情報を書かない）
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { writeLockSrc, pluckFnFrom as pluckFn, pluckVarFrom as pluckVar } from './_gas-lock-src.js';
import { makeWorld, run as hrun, incOf, status as hstatus } from './_self-heal-harness.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GAS = process.env.GAS_DIR || join(ROOT, 'gas');
const LB = readFileSync(join(GAS, 'LineBooking.js'), 'utf8');
const PE = readFileSync(join(GAS, 'PushToEdge.js'), 'utf8');
let pass = 0, fail = 0;
function ok(name, cond, why) { if (cond) pass++; else { fail++; console.log(`❌ ${name}`); if (why) console.log(`   ${why}`); } }

const LUID = 'U' + '0'.repeat(32);
const NAME = 'テスト 太郎';
const H = 3600000, DAY = 86400000;
const JST = 9 * H;

// ---- JST の formatDate / parseDate（SETTINGS.TIMEZONE＝Asia/Tokyo の身代わり）----
function fmt(d, tz, f) {
  const x = new Date(d.getTime() + JST);
  const p = (n) => String(n).padStart(2, '0');
  return f.replace('yyyy', x.getUTCFullYear()).replace('MM', p(x.getUTCMonth() + 1)).replace('dd', p(x.getUTCDate()))
    .replace('HH', p(x.getUTCHours())).replace('mm', p(x.getUTCMinutes())).replace('ss', p(x.getUTCSeconds()))
    .replace(/^H$/, String(x.getUTCHours()));
}
function parse(s, tz, f) {
  const m = s.match(/^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) throw new Error('parse');
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - JST);
}

// ---- 世界 ----
function world(opt = {}) {
  const st = { owner: null, cur: 'me', props: Object.assign({}, opt.props || {}), metrics: [], resv: [], calls: [], propCalls: 0, lockCalls: 0,
               created: [], userLock: null, posts: [], protections: [], editorsRemoved: 0 };
  const lockObj = () => ({
    tryLock: () => { st.lockCalls++; if (st.owner) return false; st.owner = st.cur; return true; },
    waitLock: () => { st.lockCalls++; if (st.owner) throw new Error('timeout'); st.owner = st.cur; },
    releaseLock: () => { if (st.owner === st.cur) st.owner = null; }, hasLock: () => st.owner === st.cur,
  });
  const userLock = () => ({
    tryLock: () => { if (opt.userLockBusy) return false; st.userLock = 'held'; return true; },
    releaseLock: () => { st.userLock = null; },
  });
  //   booking_metrics の身代わり（行の配列）
  const mkMetrics = () => ({
    getLastRow: () => st.metrics.length + 1,
    getLastColumn: () => 6,
    appendRow: (row) => { if (opt.appendThrow) { const e = new Error('You are trying to edit a protected cell'); e.name = 'Exception'; throw e; } st.metrics.push(row.slice()); },
    getRange: (r, c, nr, nc) => ({
      getValue: () => { const row = st.metrics[r - 2] || []; return row[c - 1] == null ? '' : row[c - 1]; },
      getValues: () => { const out = []; for (let i = 0; i < (nr || 1); i++) { const row = st.metrics[r - 2 + i] || []; const v = []; for (let j = 0; j < (nc || 1); j++) v.push(row[c - 1 + j] == null ? '' : row[c - 1 + j]); out.push(v); } return out; },
      setValue: (v) => { if (opt.beforeSet) opt.beforeSet(r); if (opt.setThrow) throw new Error('set'); const row = st.metrics[r - 2]; row[c - 1] = v; },
    }),
    getProtections: () => st.protections,
    protect: () => { const pr = mkProt(); st.protections.push(pr); return pr; },
    getName: () => 'booking_metrics', getMaxRows: () => 1000, getMaxColumns: () => 26,
  });
  const mkProt = () => {
    const pr = { desc: '', warn: true, eds: ['owner', 'other'], dom: true, removed: false,
      setDescription(d) { this.desc = d; return this; }, getDescription() { return this.desc; },
      setWarningOnly(w) { this.warn = w; return this; }, isWarningOnly() { return this.warn; },
      addEditor(u) { if (this.eds.indexOf(u) < 0) this.eds.push(u); return this; },
      removeEditors(list) { st.editorsRemoved++; this.eds = this.eds.filter((e) => e === 'owner' || e === 'me'); return this; },
      getEditors() { return this.eds.slice(); }, canDomainEdit() { return this.dom; }, setDomainEdit(b) { this.dom = b; return this; },
      remove() { this.removed = true; st.protections = st.protections.filter((x) => x !== pr); } };
    return pr;
  };
  const metricsSheet = mkMetrics();
  const resvSheet = { getLastRow: () => st.resv.length + 1, getRange: (r, c, nr, nc) => ({
    getValues: () => st.resv.slice(r - 2, r - 2 + nr).map((row) => row.slice(c - 1, c - 1 + nc)) }) };
  const calEvent = (title, s, e, id) => ({ getTitle: () => title, getStartTime: () => new Date(s), getEndTime: () => new Date(e), getId: () => id });
  const out = {
    String, Number, JSON, Math, Object, Array, Date, RegExp, Error, isFinite, isNaN, parseInt, parseFloat, encodeURIComponent,
    Logger: { log: () => {} }, console,
    LockService: { getScriptLock: lockObj, getUserLock: userLock },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => { st.propCalls++; if (opt.propsThrow) throw new Error('p'); return (k in st.props ? st.props[k] : null); },
      setProperty: (k, v) => { st.propCalls++; if (opt.propsThrow) throw new Error('s'); st.props[k] = String(v); },
      deleteProperty: (k) => { st.propCalls++; delete st.props[k]; },
    }) },
    Utilities: { formatDate: fmt, parseDate: parse, getUuid: () => { if (opt.uuidThrow) throw new Error('uuid'); return (Math.random().toString(16).slice(2) + '00000000').slice(0, 8) + '-0000-4000-8000-000000000000'; } },
    SpreadsheetApp: { ProtectionType: { SHEET: 'SHEET' } },
    Session: { getEffectiveUser: () => 'me' },
    ScriptApp: { getProjectTriggers: () => (opt.triggers || ['lbCalSyncTick', 'dailyHealthCheck', 'edgeJobPoll', 'autoBookRecurringPatterns']).map((h) => ({ getHandlerFunction: () => h })) },
    UrlFetchApp: { fetch: (url, o) => {
      const body = JSON.parse(o.payload || '{}');
      st.posts.push({ url, body });
      if (opt.postFail) return { getResponseCode: () => 503, getContentText: () => '{}' };
      const acked = (body.items || []).map((x) => x.n).filter((n) => !(opt.noAck || []).includes(n));
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ success: true, acked }) };
    } },
    SETTINGS: { SESSION_MINUTES: 60, TRIAL_SESSION_MINUTES: 90, TIMEZONE: 'Asia/Tokyo' },
    LINE_BOOKING: { RESV_SHEET: 'line_reservations', CARRYOVER_RATE: 1 / 3 },
    CALENDAR_IDS: { CAPACITY_B1: 'b1' },
    LB_METRICS_SHEET: 'booking_metrics',
    verifyLineIdToken: () => (opt.authFail ? { ok: false } : { ok: true, lineUserId: LUID }),
    _lbDispatch: null,
    edgeAfterWrite: () => {}, _lbNotifyHoldStart: () => {}, _lbNotifyHoldPersist: () => {}, _lbNotifyHoldSettle: () => {},
    _lbMetricsSheet: () => metricsSheet,
    _lbSheet: (n) => (n === 'booking_metrics' ? metricsSheet : n === 'line_reservations' ? resvSheet : null),
    _lbBookingGate: () => ({ ok: true }), _lbTrainerById: () => ({ id: 'T1', name: 'テスト トレーナー', email: 'tcal' }),
    _lbBookingOpen: () => !opt.tooSoon, _lbBookingCfg: () => ({}), _lbBookingDeadlineText: () => '', _lbHorizonGate: () => null,
    getBookableRemaining: () => (opt.noRemain ? { ok: false, code: 'NO_REMAINING', packKind: 'pair' } : { ok: true, packKind: 'normal', consumeType: '', monthlyType: '' }),
    _lbIsFiniteNum: (x) => typeof x === 'number' && isFinite(x),
    CalendarApp: { getCalendarById: (id) => ({
      getEvents: () => (id === 'b1' && opt.b1Busy ? [calEvent('[RESERVED] x', Date.now() + 2 * DAY, Date.now() + 2 * DAY + H, 'busy1')] : []),
      createEvent: (t, s, e) => { st.created.push({ id, t }); return { getId: () => (id === 'b1' ? 'evB1@google.com' : 'evT@google.com'), deleteEvent: () => {} }; },
    }) },
    _lbEventOverlaps: () => true,
    _lbCheckTrainerAvailable: () => !opt.trainerBusy,
    _lb1FBlockEnabled: () => false,
    _lbConsecMode: () => 'off',
    _lbBookTypePrefix: () => '通常_', _lbIsStaging: () => false, _lbWithSama: (n) => n + '様',
    recordReservationLine: () => { st.calls.push('record'); return 'L20261126100000_T1_abcdef12'; },
    _lbNotifyReservation: () => { st.calls.push('notify'); },
    _lbResvSessions: () => [],
    _lbCalSlotsSameUser: () => (opt.sameUser || 'same'),
    _edgeEnabled: () => opt.edgeOff ? false : true,
    _edgeProp: (k) => (k === 'EDGE_URL' ? 'https://edge.example' : k === 'EDGE_SECRET' ? 'x' : ''),
    _lbErrType: (e) => { const n = String((e && e.name) || ''); return /^[A-Za-z]{1,40}$/.test(n) ? n : 'Error'; },
    _lbConsecDryRecord: () => {},
  };
  const ctx = new Proxy(out, {
    has: () => true,
    get: (t, k) => {
      if (k in t) return t[k];
      if (typeof k === 'symbol' || k in globalThis) return globalThis[k];
      const f = function () { return undefined; }; t[k] = f; return f;
    },
  });
  vm.createContext(ctx);
  let src = pluckVar(LB, 'LB_WP') + pluckVar(LB, 'LB_WP_CODES') + pluckVar(PE, 'LB_WS') + pluckVar(PE, 'LB_WS_BUILD') + pluckVar(PE, 'LB_WS_CORE_CHANNELS')
    + 'var _LB_WP = null;\nvar _LB_WS = null;\nvar _LB_WRITE_CUST = null;\nvar _LB_NOTIFY_HOLD = null;\n' + writeLockSrc(LB);
  src += ['handleLineGet', '_lbWpStart', '_lbWpMark', '_lbWpCode', '_lbWpRow', '_lbWpStagesOf', '_lbWpValidRow', '_lbWpFinish',
          'makeReservationLine', '_lbReserveCore', '_lbReserveCoreImpl', '_lbLogOutcome'].map((n) => pluckFn(LB, n)).join('\n');
  src += ['_lbWsOpOf', '_lbWsId', '_lbWsFacts', '_lbMetricsWriteFailNote', 'lbWriteShadowSetOn', 'lbWriteShadowSetOff', '_lbWsOn', '_lbWsDay',
          '_lbWsStatRead', '_lbWsStatWrite', '_lbWsStatBump', '_lbWsStatEdit', '_lbWsParse', '_lbWsStrip', '_lbWsSame5', '_lbWsRewrite',
          '_lbWsProtectionOf', '_lbWsProtState', '_lbWsPrecheckCore', 'setupMetricsProtection', '_lbWsUnprotect', '_lbWsProtectExpected',
          '_lbWsNoteUser', '_lbWsTick', '_lbWsRun', '_lbWsStatOut', '_lbWsFlushStat', '_lbWsPost', '_lbWsCellMs', '_lbWsDayStartMs',
          '_lbWsIndependentCheck', '_lbWsFailConsume'].map((n) => pluckFn(PE, n)).join('\n');
  vm.runInContext(src, ctx);
  out._lbDispatch = opt.dispatch || ((params, action, luid) => out.makeReservationLine(luid, params));
  out.getCustomerByLine = () => ({ row: 2, data: [] });
  return { ctx, st, out };
}
//   makeReservationLine は名簿を読む。ここでは芯を直接呼ぶ入口の身代わりを使う
function reserveVia(w, body) {
  w.out.makeReservationLine = (luid, b) => w.ctx._lbReserveCore({ customerId: 'C5400000000001', customerName: NAME, lineUserId: LUID, contractType: '月額' }, b, 'line');
  return w.ctx.handleLineGet(Object.assign({ action: 'line_makeReservationLine', idToken: 'x' }, body));
}
const future = () => new Date(Date.now() + 2 * DAY).toISOString();
const ws = (row) => { const c = row && row[5]; return (typeof c === 'string' && c.indexOf('ws1') === 0) ? JSON.parse(c.slice(3)) : null; };

console.log('=== ① I83：6列目の有無で答えと副作用が同じ ===');
{
  const a = world(); const ra = reserveVia(a, { trainerId: 'T1', startISO: future() });
  const b = world({ uuidThrow: true }); const rb = reserveVia(b, { trainerId: 'T1', startISO: future() });
  ok('①-1 返り値が同じ（成功・同じ鍵）', ra.success === true && rb.success === true && JSON.stringify(Object.keys(ra).sort()) === JSON.stringify(Object.keys(rb).sort()), JSON.stringify([ra, rb]));
  ok('①-2 カレンダー・台帳・通知の呼び出しが同じ', JSON.stringify(a.st.created) === JSON.stringify(b.st.created) && JSON.stringify(a.st.calls) === JSON.stringify(b.st.calls));
  ok('①-3 6列目を作れたときは6列・作れないときは今と同じ5列（予約は成功）', a.st.metrics[0].length === 6 && b.st.metrics[0].length === 5, JSON.stringify([a.st.metrics[0].length, b.st.metrics[0].length]));
  ok('⑥ ★顧客の要求の経路で Properties・Lock の呼び出し回数が増えていない', a.st.propCalls === b.st.propCalls && a.st.lockCalls === b.st.lockCalls, JSON.stringify([a.st.propCalls, b.st.propCalls, a.st.lockCalls, b.st.lockCalls]));
}

console.log('=== ② どこで決まったか ===');
{
  const cases = [
    [{}, 'ok'], [{ b1Busy: true }, 'b1'], [{ trainerBusy: true }, 'trainer'], [{ noRemain: true }, 'remain'], [{ tooSoon: true }, 'deadline'],
  ];
  for (const [o, want] of cases) {
    const w = world(o); reserveVia(w, { trainerId: 'T1', startISO: future() });
    const x = ws(w.st.metrics[0]);
    ok(`②-${want} at=${want}`, x && x.at === want, JSON.stringify(x));
    if (want === 'ok') ok('②-ok 成功は自分の予約ID・予定ID（B1・トレーナー）を持つ', x.rid && x.eb === 'evB1@google.com' && x.et === 'evT@google.com' && x.ok === 1 && x.pk === 'normal');
    if (want === 'remain') ok('②-remain 残数で断ったときも GAS が決めた種別（pk）を持つ', x.pk === 'pair' && x.code === 'NO_REMAINING' && x.ok === 0);
  }
  const w = world(); w.st.owner = 'other';
  reserveVia(w, { trainerId: 'T1', startISO: future() });
  const x = ws(w.st.metrics[0]);
  ok('④-c BUSY の行は at=busy・code=BUSY（Worker は x_busy・母数から外す）', x && x.at === 'busy' && x.code === 'BUSY', JSON.stringify(x));
}

console.log('=== ③ 6列目の中身 ===');
{
  const w = world(); reserveVia(w, { trainerId: 'T1', startISO: future() });
  const cell = w.st.metrics[0][5];
  ok('③-1 氏名・LINE の ID・予定名（✅・[RESERVED]）が無い', cell.indexOf(NAME) < 0 && cell.indexOf(LUID) < 0 && !/✅|RESERVED|様/.test(cell), cell);
  const keys = Object.keys(JSON.parse(cell.slice(3)));
  const allowed = w.ctx.LB_WS.KEYS;
  ok('③-2 許可した鍵だけ', keys.every((k) => allowed.includes(k)), keys.join(','));
  ok('③-3 1,000文字以内', cell.length <= 1000, String(cell.length));
  const big = w.ctx._lbWsFacts({ customerId: 'C5400000000001' }, { trainerId: 'T1', startISO: future(), wsOldRid: 'x'.repeat(119) },
    'line', { success: true, reservationId: 'r'.repeat(119), calendarEventId: 'e'.repeat(119), trainerEventId: 't'.repeat(119) });
  const bigTooLong = (() => { w.ctx.LB_WS.MAX_CHARS = 200; const s = w.ctx._lbWsFacts({ customerId: 'C5400000000001' }, { trainerId: 'T1', startISO: future() }, 'line', { success: true, reservationId: 'r'.repeat(100), calendarEventId: 'e'.repeat(100), trainerEventId: 't'.repeat(100) }); w.ctx.LB_WS.MAX_CHARS = 1000; return s; })();
  ok('③-4 ID が上限（120）近くでも1,000文字に届かない', big.length <= 1000, String(big.length));
  ok('④-j 超えたら n と too_long だけ（母数に残る）', /"too_long":1/.test(bigTooLong) && !/"cid"/.test(bigTooLong), bigTooLong);
  const codeOther = w.ctx._lbWsFacts({ customerId: 'C5400000000001' }, { trainerId: 'T1', startISO: future() }, 'line', { success: false, code: 'SOMETHING_NEW' });
  ok('③-5 code は LB_WP_CODES の外なら OTHER', JSON.parse(codeOther.slice(3)).code === 'OTHER');
  ok('③-6 perf_test は6列目を作らない', w.ctx._lbWsFacts({ customerId: 'C5400000000001' }, {}, 'perf_test', { success: true }) === null);
}

console.log('=== ④ 送る段の位置と残り時間 ===');
{
  const after = pluckFn(PE, '_lbCalSyncAfterWrite'), tick = pluckFn(PE, 'lbCalSyncTick');
  const lastStmt = (f) => f.trim().split('\n').filter((l) => l.trim() && !/^\s*\/\//.test(l)).slice(-2, -1)[0] || '';
  ok('④-1 一回限りトリガーの最後の文が _lbWsTick(\'AFTER\')（写しの待ち・通知・同期・二重書き・枠の後）', /_lbWsTick\('AFTER'/.test(lastStmt(after)) && after.indexOf('_lbCalSlotsAfter(r') < after.indexOf("_lbWsTick('AFTER'"), lastStmt(after));
  ok('④-2 5分ごとの同期でも枠の後・return の直前', tick.indexOf("_lbCalSlotsAfter(r, 'TICK')") < tick.indexOf("_lbWsTick('TICK'") && tick.indexOf("_lbWsTick('TICK'") < tick.lastIndexOf('return r;'));
  const w = world();
  ok('④-3 経過4分（AFTER）・3分（TICK）以上なら何もしない（ロックも取らない）', w.ctx._lbWsTick('AFTER', Date.now() - 4 * 60000) === 'no_time'
     && w.ctx._lbWsTick('TICK', Date.now() - 3 * 60000) === 'no_time' && w.st.userLock === null);
}

console.log('=== ④-c 3つの出口 ===');
{
  const w = world({ authFail: true }); reserveVia(w, { trainerId: 'T1', startISO: future() });
  ok('④-c1 認証の失敗の直接の return では行を書かない', w.st.metrics.length === 0);
  const w2 = world({ dispatch: () => { throw new Error('boom'); } });
  let threw = null; try { w2.ctx.handleLineGet({ action: 'line_makeReservationLine', idToken: 'x' }); } catch (e) { threw = e; }
  ok('④-c2 例外を投げ直す出口：同じ例外が外へ出て、行を書かない', threw && threw.message === 'boom' && w2.st.metrics.length === 0);
}

// ---- 送る側の身代わりのシート ----
function rowsWith(w, list) {
  for (const o of list) {
    const t = o.t || Date.now() - 60000;
    w.st.metrics.push([fmt(new Date(t), '', 'yyyy/MM/dd HH:mm:ss'), fmt(new Date(t), '', 'yyyy-MM-dd'), o.outcome || 'success', 'line', '',
      o.cell === undefined ? 'ws1' + JSON.stringify(Object.assign({ n: o.n, op: 'reserve', ok: 1, at: 'ok', cid: 'C5400000000001', t }, o.extra || {})) : o.cell]);
  }
}
const protectOk = (w) => { const pr = { desc: 'lb-write-shadow-v1', warn: false, eds: ['owner'], dom: false, getDescription() { return this.desc; }, isWarningOnly() { return this.warn; }, getEditors() { return this.eds; }, canDomainEdit() { return this.dom; }, remove() { w.st.protections = []; } }; w.st.protections.push(pr); };

console.log('=== ④-d〜④-k 送る側 ===');
{
  const w = world({ props: { LB_WS_ON: 'on' } }); protectOk(w);
  rowsWith(w, [{ n: 'aa000001' }, { n: 'aa000002' }, { cell: '' }, { n: 'aa000003' }]);
  const r = w.ctx._lbWsTick('TICK', Date.now());
  const sent = w.st.posts[0] && w.st.posts[0].body.items.map((x) => x.n);
  ok('④-d1 6列目つきの行を送る（6列目の無い行は飛ばす）', JSON.stringify(sent) === '["aa000001","aa000002","aa000003"]', JSON.stringify(sent));
  ok('④-d2 記録したと返った行は顧客IDが消え sent:1', w.st.metrics.filter((x) => ws(x)).every((x) => ws(x).sent === 1 && !('cid' in ws(x))), JSON.stringify(w.st.metrics.map((x) => x[5])));
  const cur = JSON.parse(w.st.props.LB_WS_CURSOR);
  ok('④-d3 カーソルは最後の行まで進む', cur.row === 5, JSON.stringify(cur));
  w.ctx._lbWsTick('TICK', Date.now());
  ok('④-d4 次の回は何も送らない（続きから）', w.st.posts.length === 1, String(w.st.posts.length));
}
{
  const w = world({ props: { LB_WS_ON: 'on' }, noAck: ['bb000002'] }); protectOk(w);
  rowsWith(w, [{ n: 'bb000001' }, { n: 'bb000002' }, { n: 'bb000003' }]);
  w.ctx._lbWsTick('TICK', Date.now());
  const cur = JSON.parse(w.st.props.LB_WS_CURSOR);
  ok('④-e1 記録されなかった行（bb000002）でカーソルが止まる（その手前まで）', cur.row === 2, JSON.stringify(cur));
  ok('④-e2 止まった行は sent が付かず顧客IDが残る（次の回に送る）', ws(w.st.metrics[1]).sent === undefined && ws(w.st.metrics[1]).cid);
}
{
  const w = world({ props: { LB_WS_ON: 'on' } }); protectOk(w);
  rowsWith(w, [{ n: 'cc000001' }]);
  //   ★照合の間の手編集：読み直しと書く間に行の1列目を変える → 書いた後の照合で conflict・sent を付けない
  w.out.UrlFetchApp.fetch = ((orig) => (url, o) => { const res = orig(url, o); w.st.metrics[0][0] = '2000/01/01 00:00:00'; return res; })(w.out.UrlFetchApp.fetch);
  w.ctx._lbWsTick('TICK', Date.now());
  const x = ws(w.st.metrics[0]);
  ok('④-h1 送った後に行が動いた（1列目が変わった）→ skip・sent を付けない・カーソルも進めない', x.sent === undefined && !w.st.props.LB_WS_CURSOR, JSON.stringify([x, w.st.props.LB_WS_CURSOR]));
  const stat = JSON.parse(w.st.props.LB_WS_STAT || '{}');
  ok('④-h2 書かなかった数（write_skip）を数える', JSON.stringify(stat).indexOf('write_skip') >= 0, JSON.stringify(stat));
}
{
  const w = world({ props: { LB_WS_ON: 'on' }, beforeSet: (r) => {} }); protectOk(w);
  rowsWith(w, [{ n: 'cd000001' }]);
  w.out._lbWsRewriteOrig = w.ctx._lbWsRewrite;
  //   書いた直後に別の行の中身へ差し替わる（数十ミリ秒の窓）→ conflict
  const sh = w.ctx._lbSheet('booking_metrics');
  const r0 = sh.getRange(2, 1, 1, 6).getValues()[0];
  const origSet = sh.getRange;
  const res = (() => { const save = w.st.metrics[0].slice(); const out = w.ctx._lbWsRewrite({ getRange: (r, c, nr, nc) => {
    const g = origSet(r, c, nr, nc); return { getValues: g.getValues, setValue: (v) => { g.setValue(v); w.st.metrics[0][0] = 'moved'; } }; } }, 2, r0, 'cd000001', 'ws1{"n":"cd000001","sent":1}'); w.st.metrics[0] = save; return out; })();
  ok('④-h3 書いた後に確かめられない → conflict（直さない）', res === 'conflict', res);
}
{
  const w = world({ props: { LB_WS_ON: 'on', LB_WS_CURSOR: JSON.stringify({ row: 2, t: 'not-the-same' }) } }); protectOk(w);
  rowsWith(w, [{ n: 'dd000001' }, { n: 'dd000002' }]);
  w.ctx._lbWsTick('TICK', Date.now());
  const stat = JSON.parse(w.st.props.LB_WS_STAT || '{}');
  ok('④-g カーソルの行の時刻が合わない（行が動いた）→ 送らない・mismatchAt・cursor_reset', w.st.posts.length === 0 && stat.mismatchAt > 0 && JSON.stringify(stat).indexOf('cursor_reset') >= 0, JSON.stringify(stat));
}
{
  const w = world({ props: { LB_WS_ON: 'on' }, userLockBusy: true }); protectOk(w);
  rowsWith(w, [{ n: 'ee000001' }]);
  const r = w.ctx._lbWsTick('TICK', Date.now());
  ok('④-d5 UserLock が取れなければ何もしない（次の回に続きから）', r === 'lock_miss' && w.st.posts.length === 0 && !w.st.props.LB_WS_CURSOR);
}
{
  const w = world({ props: {} });   // スイッチ off・保護なし
  rowsWith(w, [{ n: 'ff000001', t: Date.now() - 3 * H }, { n: 'ff000002' }]);
  w.ctx._lbWsTick('TICK', Date.now());
  const x0 = ws(w.st.metrics[0]), x1 = ws(w.st.metrics[1]);
  ok('④-k1 ★スイッチ off・保護なしでも、2時間超の行は stale:1 の印を残して顧客IDを消す', x0.stale === 1 && !('cid' in x0), JSON.stringify(x0));
  ok('④-k2 新しい行は送らず（off）顧客IDは残る・カーソルはその手前で止まる', x1.cid && JSON.parse(w.st.props.LB_WS_CURSOR).row === 2 && w.st.posts.length === 0, JSON.stringify([x1, w.st.props.LB_WS_CURSOR]));
  const w2 = world({ props: { LB_WS_ON: 'on' }, postFail: true }); protectOk(w2);
  rowsWith(w2, [{ n: 'ff000003', t: Date.now() - 3 * H }]);
  w2.ctx._lbWsTick('TICK', Date.now());
  ok('④-k3 Worker への報告が落ちても、stale の印は行に残る（日次点検が印から数える）', ws(w2.st.metrics[0]).stale === 1);
  const w3 = world({ props: { LB_WS_ON: 'on' } }); protectOk(w3);
  rowsWith(w3, [{ n: 'ff000004', t: Date.now() - 3 * H }]);
  w3.st.metrics[0][0] = w3.st.metrics[0][0];
  const sh3 = w3.ctx._lbSheet('booking_metrics');
  w3.out.UrlFetchApp = w3.out.UrlFetchApp;
  //   書く前の照合が合わない（読んだ後に1列目が変わる）→ その行で止まる
  const origGet = sh3.getRange;
  let n = 0;
  w3.out._lbSheet = () => ({ getLastRow: sh3.getLastRow, getProtections: sh3.getProtections, getRange: (r, c, nr, nc) => {
    const g = origGet(r, c, nr, nc);
    if (nr === 1 && nc === 6 && ++n === 1) return { getValues: () => { const v = g.getValues(); v[0][0] = 'changed'; return v; }, setValue: g.setValue, getValue: g.getValue };
    return g; } });
  w3.ctx._lbWsTick('TICK', Date.now());
  ok('④-k4 書く前の照合が合わない → 書かずにその行でカーソルが止まる', ws(w3.st.metrics[0]).stale === undefined && !w3.st.props.LB_WS_CURSOR, JSON.stringify([w3.st.metrics[0][5], w3.st.props.LB_WS_CURSOR]));
}

console.log('=== ④-f 保護 ===');
{
  const w = world({ triggers: ['lbCalSyncTick', 'dailyHealthCheck'] });
  w.st.props.LB_WS_STAT = JSON.stringify({ userSame: { v: 'same', at: Date.now() } });
  const r = w.ctx.setupMetricsProtection();
  ok('④-f1 見えないトリガーがある → 保護を置かない・blockedAt', r.ok === false && w.st.protections.length === 0 && JSON.parse(w.st.props.LB_WS_STAT).blockedAt > 0, JSON.stringify(r));
  const w2 = world();
  const r2 = w2.ctx.setupMetricsProtection();
  ok('④-f2 Web アプリの実行者がまだ観測されていない（unknown）→ 置かない', r2.ok === false && r2.item1 === null);
  const w3 = world(); w3.st.props.LB_WS_STAT = JSON.stringify({ userSame: { v: 'same', at: Date.now() } });
  const r3 = w3.ctx.setupMetricsProtection();
  const r4 = w3.ctx.setupMetricsProtection();
  ok('④-f3 確かめられる範囲が通れば置く（警告だけでない・ドメインの編集なし）・2回目は何もしない（保護は1つ）',
     r3.ok === true && r4.already === true && w3.st.protections.length === 1 && w3.st.protections[0].warn === false && w3.st.protections[0].dom === false, JSON.stringify([r3, r4]));
  w3.st.protections.push({ getDescription: () => 'someone-else', remove() {} });
  w3.ctx._lbWsUnprotect();
  ok('④-f4 外すのは印つきの保護だけ（ほかの保護は残す）', w3.st.protections.length === 1 && w3.st.protections[0].getDescription() === 'someone-else');
}

console.log('=== ④-l 書けなかった事実を数える ===');
{
  const w = world({ appendThrow: true });
  const r = reserveVia(w, { trainerId: 'T1', startISO: future() });
  const f = JSON.parse(w.st.props.LB_METRICS_WRITE_FAIL || 'null');
  ok('④-l1 appendRow が断られても予約は成功・件数と型名だけが残る（例外の文は残らない）', r.success === true && f && f.n === 1 && f.type === 'Exception' && JSON.stringify(f).indexOf('protected') < 0, JSON.stringify(f));
  const w2 = world();
  reserveVia(w2, { trainerId: 'T1', startISO: future() });
  ok('④-l2 成功した appendRow では LB_METRICS_WRITE_FAIL を触らない', !('LB_METRICS_WRITE_FAIL' in w2.st.props));
  const w3 = world({ appendThrow: true, propsThrow: true });
  let thrown = null;
  try { w3.ctx._lbLogOutcome('success', 'line', '', 'ws1{}'); } catch (e) { thrown = e; }
  ok('④-l3 ★Property も例外になる → 元の appendRow の例外がそのまま投げ直される（記録の例外に置き換わらない）', thrown && /protected/.test(thrown.message), String(thrown));
}

console.log('=== ⑤ 独立の検知の時刻の境目 ===');
{
  //   基準：当日 07:00（JST）に動く日次点検
  const today0 = (() => { const d = new Date(Date.now() + JST); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - JST; })();
  const y0 = today0 - DAY;
  const at = (ms) => fmt(new Date(ms), '', 'yyyy/MM/dd HH:mm');
  const atS = (ms) => fmt(new Date(ms), '', 'yyyy/MM/dd HH:mm:ss');
  const run = (resv, metrics, nowMs) => {
    const w = world();
    w.st.resv = resv.map((x) => { const r = new Array(15).fill(''); r[9] = x.ch || 'line'; r[10] = x.at; return r; });
    w.st.metrics = metrics.map((x) => [x.at, '', x.outcome || 'success', x.ch || 'line', '']);
    return w.ctx._lbWsIndependentCheck(nowMs == null ? today0 + 7 * H : nowMs);
  };
  const r1 = run([{ at: at(y0 + 23 * H + 49 * 60000) }], []);
  ok('⑤-1 台帳 23:49 は L に入る・outcome 無し → fail', r1.L === 1 && r1.M === 0 && r1.fail === true, JSON.stringify(r1));
  const r2 = run([{ at: at(y0 + 23 * H + 50 * 60000) }], []);
  ok('⑤-2 台帳 23:50 は L に入らない', r2.L === 0 && r2.fail === false, JSON.stringify(r2));
  const r3 = run([{ at: at(y0 + 23 * H + 49 * 60000) }], [{ at: atS(today0 + 10 * 60000) }]);
  ok('⑤-3 outcome 00:10:00 は M に入る', r3.M === 1 && r3.fail === false, JSON.stringify(r3));
  const r4 = run([{ at: at(y0 + 23 * H + 49 * 60000) }], [{ at: atS(today0 + 10 * 60000 + 1000) }]);
  ok('⑤-4 outcome 00:10:01 は M に入らない', r4.M === 0 && r4.fail === true, JSON.stringify(r4));
  const r5 = run([{ at: new Date(y0 + 12 * H) }], [{ at: new Date(y0 + 12 * H + 5000) }]);
  ok('⑤-5 Date 値のセルでも数える', r5.L === 1 && r5.M === 1 && r5.fail === false, JSON.stringify(r5));
  const r6 = run([{ at: '昨日のどこか' }], []);
  ok('⑤-6 形に合わない文字列は数えず unparsed', r6.L === 0 && r6.unparsed === 1, JSON.stringify(r6));
  const r7 = run([{ at: at(y0 + 12 * H) }], [], today0 + 5 * 60000);
  ok('⑤-7 当日 00:10 より前の実行（手動）では比べない', r7.checked === false && r7.fail === false, JSON.stringify(r7));
  const r8 = run([{ at: at(y0 + 23 * H + 59 * 60000) }], [{ at: atS(today0 + 30000) }]);
  ok('⑤-8 境目：台帳 23:59・outcome 翌 00:00:30 の1件だけ → 出さない', r8.fail === false, JSON.stringify(r8));
  const r9 = run([1, 2, 3, 4, 5].map((i) => ({ at: at(y0 + i * H) })), [1, 2, 3].map((i) => ({ at: atS(y0 + i * H + 1000) })));
  ok('⑤-9 台帳5件・outcome 3件（0.6）→ fail', r9.fail === true, JSON.stringify(r9));
  const r10 = run([1, 2, 3, 4, 5].map((i) => ({ at: at(y0 + i * H), ch: 'sync' })), []);
  ok('⑤-10 _lbReserveCore の channel 以外（取込など）は数えない', r10.L === 0 && r10.fail === false, JSON.stringify(r10));
}

console.log('=== ⑧ 日次点検の段「書き込みの比較」（本物の dailyHealthCheck・自己修理の身代わり） ===');
{
  const w = makeWorld({ data: { ws: { danger: 0, notRunning: 0, partial: 0, backlog: 0, unprotected: 0, protectBlocked: 0, writeFail: 2, failSeen: 2, writeFailWhy: 'recorded:Exception/append' } } });
  hrun(w, 'dailyHealthCheck');
  const st = hstatus(w) || {};
  ok('⑧-1 書けなかった事実があれば metrics_write_fail（B）を出し、印つきの保護を外す（自己修理のモードに関係なく）',
     w.wsUnprotect === 1 && incOf(w, 'metrics_write_fail').length === 1 && incOf(w, 'metrics_write_fail')[0].cls === 'B', JSON.stringify([w.wsUnprotect, incOf(w, 'metrics_write_fail')]));
  ok('⑧-2 段「書き込みの比較」は完走の印（checked）に付く', Array.isArray(st.checked) && st.checked.indexOf('書き込みの比較') >= 0, JSON.stringify(st.checked));
  const w2 = makeWorld();
  hrun(w2, 'dailyHealthCheck');
  ok('⑧-3 何も無ければ外さない・key を出さない', !w2.wsUnprotect && incOf(w2, 'metrics_write_fail').length === 0);
  const w3 = makeWorld({ data: { ws: { danger: 1, notRunning: 0, partial: 0, backlog: 0, unprotected: 1, protectBlocked: 0, writeFail: 0, failSeen: 0 } } });
  hrun(w3, 'dailyHealthCheck');
  ok('⑧-4 危険側の食い違い・保護の崩れは key を出すが、保護は外さない（外すのは書けなかったときだけ）',
     incOf(w3, 'ws_danger').length === 1 && incOf(w3, 'metrics_unprotected').length === 1 && !w3.wsUnprotect);
  const w4 = makeWorld({ data: { throwIn: {} } });
  w4.hooks.lbWriteShadowDailyCheck = () => { throw new Error('boom 090-0000-0000'); };
  hrun(w4, 'dailyHealthCheck');
  const st4 = hstatus(w4) || {};
  ok('⑧-5 点検そのものが落ちたら ws_check_fail・段に印を付けない（閉じない）・例外の文は出さない',
     incOf(w4, 'ws_check_fail').length === 1 && (st4.checked || []).indexOf('書き込みの比較') < 0 && JSON.stringify(w4.props).indexOf('090-0000') < 0, JSON.stringify(st4.checked));
}

console.log('=== ⑨ M2：最終更新の時刻は中身の印に入れない（I74 を変えない） ===');
{
  const ctx = { Utilities: { DigestAlgorithm: { SHA_256: 1 }, Charset: { UTF_8: 1 }, computeDigest: (a, s) => Array.from(Buffer.from(s)).slice(0, 32) } };
  vm.createContext(ctx);
  vm.runInContext(pluckFn(PE, '_calsyncHash'), ctx);
  const base = { calendarId: 'c', eventId: 'e#1', effect: 'busy', reason: 'break', startAt: 1, endAt: 2, allDay: 0 };
  ok('⑨-1 updatedAt だけが違う送り物は中身の印が同じ（unchanged のまま＝枠の押し出しを増やさない）',
     ctx._calsyncHash([Object.assign({ updatedAt: 1 }, base)]) === ctx._calsyncHash([Object.assign({ updatedAt: 999 }, base)]));
  const bp = pluckFn(PE, 'buildCalSyncPayload');
  ok('⑨-2 最終更新は LB_WS_ON が on のときだけ・トレーナーの 出勤・休憩・ブロック だけに足す', /_wsLu && cals\[c\]\.role === 'trainer' && \(cls\.reason === 'shift' \|\| cls\.reason === 'break' \|\| cls\.reason === 'block'\)/.test(PE) && /getLastUpdated\(\)/.test(PE) && /var _wsLu = \(typeof _lbWsOn === 'function'\) && _lbWsOn\(\);/.test(bp));
}

console.log('=== ⑦ トリガーを作らない ===');
{
  const sec = PE.slice(PE.indexOf('// ===== WRITESHADOW:BEGIN ====='), PE.indexOf('// ===== WRITESHADOW:END ====='));
  ok('⑦ write-shadow の節は newTrigger を呼ばない・ScriptLock を使わない（UserLock だけ）', sec.length > 1000 && !/newTrigger/.test(sec) && !/getScriptLock/.test(sec));
}

console.log(`\n${fail ? '❌' : '✅'} 設計54 write-shadow（GAS）: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
