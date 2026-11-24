// 自己修理 P1 の検査の身代わり（2026-11-23）
//   ★本物の gas/LineBooking.js から dailyHealthCheck と自己修理の塊（「自己修理 P1（AI なし）」から
//     「消化ペースの週次レポート」の手前まで）と cancel_notes の部品を取り出し、Node の vm で動かす。
//   ★実行（run）のたびに新しい vm の文脈を作る＝GAS の「実行ごとに大域変数が初めから」と同じ。
//     スクリプトのプロパティ・シート・トリガー・時計は world に持ち、実行をまたいで共有する。
//   ★値はすべて架空（個人情報を書かない）
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { pluckFnFrom as pluckFn, pluckVarFrom as pluckVar } from './_gas-lock-src.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GAS = process.env.GAS_DIR || join(ROOT, 'gas');
export const LB = readFileSync(join(GAS, 'LineBooking.js'), 'utf8');
export const NUDGE = readFileSync(join(GAS, 'Nudge.js'), 'utf8');
const ALLOC = readFileSync(join(GAS, 'Allocate.js'), 'utf8');
const CODE = readFileSync(join(GAS, 'コード.js'), 'utf8');   // 設計57：枠の計算 buildAvailableSlots とその部品
const BR = createRequire(import.meta.url)(join(GAS, 'BookingRules.js'));   // 締め切りの判定（module.exports を持つ）

//   自己修理の塊（本物のソースの区切りで切る）
export function healBlock(src = LB) {
  const a = src.indexOf('// 自己修理 P1（AI なし）');
  const b = src.indexOf('// 消化ペースの週次レポート');
  if (a < 0 || b < 0 || b < a) throw new Error('自己修理の塊が見つからない');
  //   直前の区切り線（// ===）の行から始める
  return src.slice(src.lastIndexOf('\n', a - 2), src.lastIndexOf('\n// ====', b));
}

export const JST = 9 * 3600000;
const pad = (n) => ('0' + n).slice(-2);
function fmt(d, tz, f) {
  const j = new Date(d.getTime() + JST);
  const Y = j.getUTCFullYear(), M = j.getUTCMonth() + 1, D = j.getUTCDate(), h = j.getUTCHours(), m = j.getUTCMinutes();
  return f.replace('yyyy', Y).replace('MM', pad(M)).replace('dd', pad(D)).replace('HH', pad(h)).replace('mm', pad(m))
    .replace(/\bM\b/, M).replace(/\bd\b/, D);
}

// ---------- シートの身代わり ----------
export function makeSheet(name, rows = []) {
  const s = { name, data: rows.map((r) => r.slice()), writes: 0 };
  s.getName = () => s.name;
  s.getLastRow = () => s.data.length;
  s.getLastColumn = () => s.data.reduce((m, r) => Math.max(m, r.length), 0);
  s.getRange = (r, c, nr = 1, nc = 1) => ({
    getValues() {
      const out = [];
      for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) { const v = (s.data[r - 1 + i] || [])[c - 1 + j]; row.push(v === undefined ? '' : v); } out.push(row); }
      return out;
    },
    getValue() { return this.getValues()[0][0]; },
    setValues(v) {
      if (s.failNext) { s.failNext = false; throw new Error('実行が落ちた（書き込みの途中）'); }
      s.writes++;
      for (let i = 0; i < nr; i++) { while (s.data.length < r + i) s.data.push([]); for (let j = 0; j < nc; j++) s.data[r - 1 + i][c - 1 + j] = v[i][j]; }
      if (s.onWrite) s.onWrite();
      return this;
    },
    setValue(x) { return this.setValues([[x]]); },
    setFontWeight() { return this; },
    clearContent() { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) if (s.data[r - 1 + i]) s.data[r - 1 + i][c - 1 + j] = ''; return this; },
  });
  s.insertRowsAfter = (after, n) => { s.data.splice(after, 0, ...Array.from({ length: n }, () => [])); };
  s.setFrozenRows = () => {};
  s.clear = () => { s.data = []; };
  return s;
}

export const CN_HEAD = ['res_id', 'cancelled_at', 'start_at', 'trainer_id', 'customer_id', 'actor', 'outcome', 'transfer',
  'reason_key', 'trainer_reason', 'note', 'note_purged_at', 'notified', 'ids_purged_at'];

//   架空の名前・連絡先（I-H1 の走査に使う。どれも実在しない形）
export const FAKE = {
  name: 'テスト 太郎', name2: 'テスト 花子', roman: 'Taro Tesuto', phone: '090-0000-0000',
  email: 'nobody@example.invalid', lineId: 'U0000000000000000000000000000000a', note: '架空のひとこと本文', event: 'EVT-yotei-0000-dummy',
};

// ---------- 世界（実行をまたいで共有する状態） ----------
export function makeWorld(o = {}) {
  const now0 = o.now != null ? o.now : Date.UTC(2026, 10, 23, 7 - 9, 5);   // 2026-11-23 07:05 JST
  const w = {
    now: now0,
    //   既定は「ほぼ問題なし」（押し出しの元栓が開いている・shadow のまとめた比較が新しい）
    props: Object.assign({ EDGE_PUSH_ON: '1', EDGE_URL: 'https://edge.example.invalid', EDGE_SECRET: 'x', EDGE_JOB_ON: '1',
                           LB_SHADOW_SWEEP_LAST: JSON.stringify({ at: now0 - 3600000, result: 'MODE_OFF' }) }, o.props || {}),
    sheets: {},
    triggers: (o.triggers || defaultTriggers()).map((h) => ({ h })),
    created: [], deleted: [], forbidden: [], mails: [], pushes: [], nqOnFail: 0, uuid: 0,
    lockBusy: false, pushOk: o.pushOk !== false,
    hooks: {}, calls: {}, depth: 0,   // 名前 → 関数（身代わりの途中で呼ぶ・同時実行の再現に使う）
    data: Object.assign({
      paceMeta: { brokenCount: 0, brokenNames: [], brokenIds: [], noContractCount: 0, noContractNames: [], pendingPayMembers: 0, pendingPaySessions: 0 },
      dataHealth: { dupEv: [], dupSlot: [], unlinked: 0, unlinkedList: [], future: [], transferAll: 0, transferThisMonth: 0 },
      orphan: { orphanB1: [], missingB1: [], orphanTrainer: [], missingTrainer: [], manual: [] },
      quota: { ok: true, limited: true, left: 500, pct: 10 },
      emailFailing: 0,
      throwIn: {},   // 身代わりの名前 → 例外の文
    }, o.data || {}),
  };
  w.sheets.sync_status = makeSheet('sync_status', [['実行時刻'], ['RECENT']]);   // いつ読んでも1時間前（日をまたぐ検査で鮮度の key を出さない）
  w.sheets.cancel_notes = makeSheet('cancel_notes', [CN_HEAD]);
  w.sheets.trainer_master = makeSheet('trainer_master', [['line_user_id', 'trainer_id', 'name', 'role', 'active', 'name_en']]
    .concat(o.trainers || [[FAKE.lineId, 'T1', 'テスト', 'owner', true, '']]));
  if (o.noTrainerSheet) delete w.sheets.trainer_master;
  for (const k of Object.keys(o.sheets || {})) w.sheets[k] = o.sheets[k];
  return w;
}
export function defaultTriggers() {
  return ['dailyHealthCheck', 'lbNudgeDaily', 'sendLineReminders', 'pushToEdgeLight', 'pushToEdgeFullSync', 'dailySync',
    'edgeJobPoll', 'syncContractStatus', 'refreshPaceBoard', 'checkLineQuota', 'weeklyPaceReport', 'pushToEdgeSlots',
    'pushToEdgeHome', 'warmupCache'];   // 14本
}

// ---------- 1回の実行 ----------
//   fn: 'dailyHealthCheck' | 'lbSelfHeal' | 'lbHealAddMissingTriggers' など
//   ★途中の処理（hooks）は一番外側の実行でだけ起こす（内側の実行がまた hooks を呼んで再帰しないため）
export function run(w, fn, ...args) {
  const ctx = makeCtx(w);
  w.depth = (w.depth || 0) + 1;
  try { return ctx[fn](...args); } finally { w.depth--; }
}
export function makeCtx(w) {
  const forbid = (name) => () => { w.forbidden.push(name); throw new Error('呼んではいけない: ' + name); };
  const top = () => (w.depth || 0) <= 1;
  const hook = (name, f) => (...a) => { w.calls[name] = (w.calls[name] || 0) + 1; if (w.hooks[name] && top()) w.hooks[name](...a); if (w.data.throwIn[name]) throw new Error(w.data.throwIn[name]); return f(...a); };
  class FD extends Date { constructor(...a) { if (a.length === 0) super(w.now); else super(...a); } static now() { return w.now; } }
  const ss = {
    getSheetByName: (n) => w.sheets[n] || null,
    insertSheet: (n) => { w.sheets[n] = makeSheet(n); return w.sheets[n]; },
    getSpreadsheetTimeZone: () => 'Asia/Tokyo',
  };
  const trig = (h) => ({ getHandlerFunction: () => h.h, getEventType: () => 'CLOCK' });
  //   トリガーの組み立てを記録する身代わり
  const builder = (name) => {
    const calls = [];
    const b = new Proxy({}, { get: (_, m) => {
      if (m === 'create') return () => { if (w.hooks.create && top()) w.hooks.create(name); if (w.data.throwIn.create) throw new Error(w.data.throwIn.create); w.triggers.push({ h: name }); w.created.push({ name, calls }); return {}; };
      return (...a) => { calls.push([m, ...a]); return b; };
    } });
    return b;
  };
  //   ---- 設計57：カレンダーの身代わり（枠の計算 buildAvailableSlots は本物を動かす）----
  //   既定＝「いまの翌月に B の出勤（10:00〜20:00）が毎日（1〜28日）」。w.data.nmo で上書きする
  //     { events: { B: [{title, start, end}], B1: [...] }, calNull: ['C'] }   ★公開シートは身代わりを置かない（読んだら落ちる）
  const nmoDefaultShifts = () => {
    const j = new Date(w.now + JST), y = j.getUTCFullYear(), m = j.getUTCMonth() + 1;   // 翌月（JST）
    const out = [];
    for (let d = 1; d <= 28; d++) out.push({ title: '出勤', start: Date.UTC(y, m, d, 10 - 9, 0), end: Date.UTC(y, m, d, 20 - 9, 0) });
    return out;
  };
  const nmo = () => w.data.nmo || {};
  const nmoCal = (id) => {
    const o = nmo(), tid = String(id).replace('cal-', '').toUpperCase();
    if ((o.calNull || []).indexOf(tid) >= 0) return null;
    const evs = o.events ? (o.events[tid] || []) : (tid === 'B' ? nmoDefaultShifts() : []);
    return { getEvents: (from, to) => { w.calReads = (w.calReads || []).concat([[tid, from.getTime(), to.getTime()]]);
      return evs.filter((e) => e.start < to.getTime() && (e.end || e.start + 3600000) > from.getTime())
        .map((e) => ({ getTitle: () => e.title, getStartTime: () => new FD(e.start), getEndTime: () => new FD(e.end || e.start + 3600000) })); } };
  };
  const ctx = {
    String, Number, isNaN, isFinite, Math, JSON, Object, Array, RegExp, Error, Date: FD, parseInt,
    SETTINGS: { TIMEZONE: 'Asia/Tokyo', SPREADSHEET_ID: 'x', SESSION_MINUTES: 60, TRIAL_SESSION_MINUTES: 90, PICKER_STEP_MINUTES: 15 },
    //   設計57：翌月の空き枠の見張り。トレーナーは架空の記号だけ（A は非表示＝オーナーと同じ形）
    CALENDAR_IDS: { CAPACITY_B1: 'cal-b1', TRAINERS: [{ id: 'A', name: 'A', email: 'cal-a', hidden: true }, { id: 'B', name: 'B', email: 'cal-b' }, { id: 'C', name: 'C', email: 'cal-c' }] },
    //   ★公開シートは読まない（設計57 関門② 再審）。開いたら数えて落とす
    SpreadsheetApp: { openById: hook('openById', () => { throw new Error('公開シートを開いてはいけない'); }) },
    CalendarApp: { getCalendarById: hook('getCalendarById', (id) => nmoCal(id)) },
    _lbBookingCfg: BR._lbBookingCfg, _lbBookingOpen: BR._lbBookingOpen,
    LINE_BOOKING: { TRAINER_SHEET: 'trainer_master', MAP_SHEET: 'customer_line_map' },
    TR_COL: { LINE_USER_ID: 1, TRAINER_ID: 2, NAME: 3, ROLE: 4, ACTIVE: 5, NAME_EN: 6 },
    Logger: { log: () => {} },
    Utilities: { formatDate: fmt, getUuid: () => 'uuid-' + (++w.uuid) + '-' + Math.random().toString(16).slice(2, 8), sleep: () => {} },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (k in w.props ? w.props[k] : null),
      setProperty: (k, v) => { if (w.hooks.setProperty) w.hooks.setProperty(k, v); w.props[k] = String(v); },
      deleteProperty: (k) => { delete w.props[k]; },
    }) },
    //   lockBusyFn(n)：n 回目の tryLock を混んでいる（予約などが持っている）ことにする
    LockService: { getScriptLock: () => ({ tryLock: () => { w.lockN = (w.lockN || 0) + 1; return !(w.lockBusy || (w.lockBusyFn && w.lockBusyFn(w.lockN))); }, releaseLock: () => {} }) },
    ScriptApp: {
      getProjectTriggers: hook('getProjectTriggers', () => w.triggers.map(trig)),
      newTrigger: (name) => builder(name),
      deleteTrigger: forbid('deleteTrigger'),
      WeekDay: { MONDAY: 'MONDAY' },
    },
    GmailApp: { sendEmail: (to, subject, body) => { if (w.data.mailThrows) throw new Error('mail'); w.mails.push({ to, subject, body }); } },
    _lbSs: () => ss,
    _lbSheet: (n) => ss.getSheetByName(n),
    _lbAlertEmail: () => 'owner@example.invalid',
    _lbIsStaging: () => false,
    //   ---- 点検が呼ぶ部品（身代わり）----
    refreshPaceBoard: hook('refreshPaceBoard', () => { w.props.LB_PACE_META = JSON.stringify(w.data.paceMeta); return { rows: 0 }; }),
    debugDataHealth: hook('debugDataHealth', () => w.data.dataHealth),
    debugOrphanEvents: hook('debugOrphanEvents', () => w.data.orphan),
    getBookingMetrics: hook('getBookingMetrics', () => ({ notifyFail: { total: 0, byReason: {}, byPurpose: {} }, byOutcome: {}, register: {}, consec: {}, cxl: {} })),
    getNotifyFailDetails: () => ({}),
    _lbNqStatus: () => ({ completedAgeMin: 5, startedAgeMin: 5, lockMissAgeMin: null, lastError: '', pending: 0, emailFailing: w.data.emailFailing, writeFail: '0' }),
    LB_NQ: { FAIL_PROP: 'LB_NQ_FAIL' },
    _lbConsecMode: () => 'off', _lbConsecPerf: () => ({ n: 0 }),
    _lbQuotaFetch: hook('_lbQuotaFetch', () => w.data.quota),
    LB_SYNC_STATUS_SHEET: 'sync_status', LB_REMINDER_STATUS_SHEET: 'reminder_status', LB_ALLOC_SHEET: 'alloc',
    _lbParseResvDate: (v) => (v === 'RECENT' ? new Date(w.now - 3600000) : new Date(v)),
    _edgeQuotaStatus: hook('_edgeQuotaStatus', () => ({ syncVersion: { table: 'ok', stale: 0 }, remainRead: null, preflight: { mode: 'off' } })),
    lbWriteCoversDailyCheck: () => [],
    lbDwDailyCheck: hook('lbDwDailyCheck', () => w.data.dw || []),
    lbCalSlotsDailyCheck: hook('lbCalSlotsDailyCheck', () => []), lbEdgeDeferDailyCheck: () => [], lbNotifyDeferDailyMaint: hook('lbNotifyDeferDailyMaint', () => {}), lbNotifyDeferDailyCheck: () => [],
    lbAutoBookHeldDailyCheck: () => [], lbLockCountDailyCheck: () => [], lbKarteAiDailyCheck: hook('lbKarteAiDailyCheck', () => []),
    lbContractInputCheck: hook('lbContractInputCheck', () => []),
    //   設計54 S1a：書き込みの比較（既定は何も無い）・保護を外す（呼ばれたら数える）
    lbWriteShadowDailyCheck: hook('lbWriteShadowDailyCheck', () => (w.data.ws || { danger: 0, notRunning: 0, partial: 0, backlog: 0, unprotected: 0, protectBlocked: 0, writeFail: 0, failSeen: 0 })),
    _lbWsUnprotect: hook('_lbWsUnprotect', () => { w.wsUnprotect = (w.wsUnprotect || 0) + 1; return true; }), _lbWsFailConsume: () => {},
    //   ---- 通知 ----
    _lbPushOnce: (to, text, opts) => { w.pushes.push({ to, text, opts }); if (w.hooks.push && top()) w.hooks.push(to, text); return w.pushOk ? { ok: true, code: 200 } : { ok: false, code: 500 }; },
    _lbPush: forbid('_lbPush'),
    _lbNqOnFail: () => { w.nqOnFail++; throw new Error('_lbNqOnFail を呼んではいけない'); },
    //   ---- 修理から呼んではいけないもの（I-H3・I-H12）----
    setupLineTriggers: forbid('setupLineTriggers'), setupNudgeTrigger: forbid('setupNudgeTrigger'), setupEdgeTrigger: forbid('setupEdgeTrigger'),
    setupEdgeJobTrigger: forbid('setupEdgeJobTrigger'), setupCalSyncTrigger: forbid('setupCalSyncTrigger'), setupRecurringTriggers: forbid('setupRecurringTriggers'),
    setupTriggers: forbid('setupTriggers'), setupBasicTriggersOnly: forbid('setupBasicTriggersOnly'),
    dailySync: forbid('dailySync'), syncExistingReservations: forbid('syncExistingReservations'), lbDwEnsureQueued: forbid('lbDwEnsureQueued'),
    _lbReserveCore: forbid('_lbReserveCore'), sendLineReminders: forbid('sendLineReminders'),
  };
  vm.createContext(ctx);
  const src = [
    pluckFn(LB, '_lbProp'), pluckFn(ALLOC, '_lbIsFiniteNum'), pluckFn(LB, '_lbTruthy'),
    pluckVar(LB, 'LB_HEALTH_BUILD'), pluckVar(LB, 'LB_HEALTH_SHEET'), pluckVar(LB, 'LB_HEALTH_COLS'),
    LB.slice(LB.indexOf('\nvar LB_CN = {'), LB.indexOf('\n//   見出しの確認。', LB.indexOf('\nvar LB_CN = {'))),
    pluckFn(LB, '_lbCnReady'), pluckFn(LB, '_lbCnHealth'), pluckFn(LB, 'setupCancelNotesSheet'),
    pluckFn(LB, 'dailyHealthCheck'), pluckFn(LB, 'runHealthCheckDryRun'),
    pluckFn(LB, '_lbBookingHorizonEnd'), pluckVar(LB, 'LB_NMO'), pluckFn(LB, '_lbNextMonthRange'), pluckFn(LB, '_lbNextMonthOpenRead'),
    pluckFn(LB, 'lbNextMonthOpenCheck'), pluckFn(CODE, 'isShiftEvent'),
    //   枠の計算は本物（コード.js）。書き込み（buildAndCacheSlots・writeToSpreadsheet）は取り込まない
    pluckVar(CODE, 'LB_SLOTS_READ_LOCAL'), pluckFn(CODE, 'buildAvailableSlots'), pluckFn(CODE, '_lbSubtractIntervals'),
    pluckFn(CODE, '_lbMakeSlot'), pluckFn(CODE, '_lbIsBusyTitle'), pluckFn(LB, '_lbOwnerSlotWindow'), pluckFn(LB, '_lbInOwnerWindow'),
    healBlock(),
  ].join('\n');
  vm.runInContext(src, ctx);
  return ctx;
}

// ---------- 読み出しの小道具 ----------
export function status(w) { return JSON.parse(w.props.LB_HEALTH_STATUS || 'null'); }
export function incRows(w) {
  const sh = w.sheets.incidents;
  if (!sh) return [];
  const head = sh.data[0];
  return sh.data.slice(1).map((r) => { const o = {}; head.forEach((h, i) => { o[h] = r[i] === undefined ? '' : r[i]; }); return o; });
}
export function incOf(w, key) { return incRows(w).filter((r) => r.key === key); }
export function lease(w) { return w.props.LB_HEALTH_LEASE ? JSON.parse(w.props.LB_HEALTH_LEASE) : null; }
export function removeTrigger(w, h) { w.triggers = w.triggers.filter((t) => t.h !== h); }
export function countTrigger(w, h) { return w.triggers.filter((t) => t.h === h).length; }

export function tally() {
  const t = { pass: 0, fail: 0 };
  t.ok = (name, cond, why) => { if (cond) t.pass++; else { t.fail++; console.log(`❌ ${name}`); if (why) console.log(`   ${why}`); } };
  t.end = (label) => { console.log(`\n${t.fail ? '❌' : '✅'} ${label}: ${t.pass} passed / ${t.fail} failed`); process.exit(t.fail ? 1 : 0); };
  return t;
}
