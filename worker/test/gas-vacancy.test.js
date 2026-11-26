// 空き枠のお知らせ（設計37 改訂5・決定0216）を入口から通す検査
//   実行: node worker/test/gas-vacancy.test.js
//
// ★なぜ要るのか
//   会員に直接届く LINE。間違ったお知らせ（取れない枠・予約できない人・2通目・夜・受け取らないを押した人）は
//   届かないより悪い。判定は本物のコード（Nudge.js の VACANCY 区画・warmupCache・handleLineWebhook・_lbPushOnce・
//   締め切りの計算・nudge_log の書き方）を vm で動かし、シート・カレンダー・LINE・時計・ロックと、
//   入口の重い関数（getTrainerSlots・getBookingOptions・_lbCheckTrainerAvailable 等）だけを身代わりにする。
//   入口の関数の中身はそれぞれの検査（consec-*・remain-*・gas-entry-*）が守る。
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

process.env.TZ = 'Asia/Tokyo';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LB = readFileSync(join(ROOT, 'gas/LineBooking.js'), 'utf8');
const CODE = readFileSync(join(ROOT, 'gas/コード.js'), 'utf8');
const NUDGE = readFileSync(join(ROOT, 'gas/Nudge.js'), 'utf8');
const RULES = readFileSync(join(ROOT, 'gas/BookingRules.js'), 'utf8');
const JOB = readFileSync(join(ROOT, 'gas/EdgeJob.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, why) { if (cond) pass++; else { fail++; console.log(`❌ ${name}`); if (why) console.log(`   ${why}`); } }
function pluck(src, name) {
  const m = src.match(new RegExp('\\nfunction ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('見つからない: ' + name);
  return m[0];
}
function pluckVar(src, re) { const m = src.match(re); if (!m) throw new Error('見つからない: ' + re); return m[0]; }

const VAC = pluckVar(NUDGE, /\/\/ ==== VACANCY_BEGIN ====[\s\S]*?\/\/ ==== VACANCY_END ====/);
const PARTS = [
  pluckVar(NUDGE, /^var LB_NUDGE_BUILD = [^\n]+$/m),
  "var LB_NUDGE_LOG_SHEET = 'nudge_log'; var LB_NUDGE_LOG_COLS = 6; var LB_NUDGE_LOG_SCAN = 3000;",
  ...['_lbNudgeMembers', '_lbNudgeMask', '_lbNudgeLiffUrl', '_lbNudgeLogSheet', '_lbNudgeLogAppendOne'].map((n) => pluck(NUDGE, n)),
  pluckVar(RULES, /^var LB_BOOKING_DEFAULTS = [^\n]+$/m),
  ...['_lbJstParts', '_lbJstMs', '_lbBookingCfg', '_lbPrevDeadlineHourOf', '_lbIsMorningSlot', '_lbBookingDeadlineMs', '_lbOverlaps', '_lbEventOverlaps'].map((n) => pluck(RULES, n)),
  pluckVar(LB, /^var LB_CN = \{[\s\S]*?\n\};/m),
  'var _LB_CN_READY = null;',
  'var _LB_PUSH_LAST_MS = 0; var LB_PUSH_MIN_GAP_MS = 260;',
  ...['_lbCnReady', '_lbNormLang', '_lbFmtResvLabel', '_lbParseResvDate', '_lbOverlapsBusy', '_lbPushOnce', '_lbPushCode', '_lbPushBody',
      'handleLineWebhook', '_lbVacIsPostbackSafe', '_lbReply', '_lbProp'].map((n) => pluck(LB, n)),
  pluck(CODE, 'warmupCache'), pluck(CODE, 'sanitizeCell'),
  VAC,
].join('\n');

const pad = (n) => String(n).padStart(2, '0');
function fmt(d, pat) {
  d = new Date(d);
  return String(pat).replace('yyyy', d.getFullYear()).replace('MM', pad(d.getMonth() + 1)).replace('dd', pad(d.getDate()))
    .replace('HH', pad(d.getHours())).replace('mm', pad(d.getMinutes())).replace('ss', pad(d.getSeconds()))
    .replace(/^M月d日$/, (d.getMonth() + 1) + '月' + d.getDate() + '日').replace(/^M\/d$/, (d.getMonth() + 1) + '/' + d.getDate());
}
const ymdhm = (d) => fmt(d, 'yyyy/MM/dd HH:mm');

function makeSheet(name, rows, opts = {}) {
  const data = rows.map((r) => r.slice());
  const sh = {
    name, data,
    getLastRow: () => data.length,
    getLastColumn: () => data.reduce((a, r) => Math.max(a, r.length), 0),
    getRange(r, c, nr = 1, nc = 1) {
      return {
        getValues: () => {
          if (opts.readThrows && opts.readThrows()) throw new Error('read failed');
          const out = []; for (let i = 0; i < nr; i++) { const row = data[r - 1 + i] || []; const o = []; for (let j = 0; j < nc; j++) o.push(row[c - 1 + j] === undefined ? '' : row[c - 1 + j]); out.push(o); } return out;
        },
        setValues: (v) => { if (opts.writeThrows && opts.writeThrows()) throw new Error('write failed'); for (let i = 0; i < nr; i++) { if (!data[r - 1 + i]) data[r - 1 + i] = []; for (let j = 0; j < nc; j++) data[r - 1 + i][c - 1 + j] = v[i][j]; } },
        setFontWeight: () => ({}),
      };
    },
    insertRowsAfter: (after, n) => { if (opts.insertThrows && opts.insertThrows()) throw new Error('insert failed'); for (let i = 0; i < n; i++) data.splice(after, 0, []); },
    setFrozenRows: () => {},
    appendRow: (row) => { if (opts.appendThrows && opts.appendThrows()) throw new Error('append failed'); data.push(row.slice()); },
  };
  return sh;
}

const DAY = 86400000;
const CN_HEAD = ['res_id', 'cancelled_at', 'start_at', 'trainer_id', 'customer_id', 'actor', 'outcome', 'transfer',
  'reason_key', 'trainer_reason', 'note', 'note_purged_at', 'notified', 'ids_purged_at'];
// 2026-11-26（木）14:00。枠＝11/28（土）15:00（締め切り＝土12:00・送れるのは土10:00まで）
const NOW = new Date(2026, 10, 26, 14, 0).getTime();
const S = new Date(2026, 10, 28, 15, 0).getTime();

// 会員の名簿の行（列は MAP_COL の並び・1始まり）
function mapRow(o) {
  const r = new Array(17).fill('');
  r[0] = o.line || ''; r[1] = o.cid; r[2] = o.name || 'テスト 太郎'; r[4] = o.trainer == null ? 'T1' : o.trainer;
  r[5] = o.ctype || '月4回'; r[6] = o.stat || 'active'; r[7] = o.auth || 'verified'; r[16] = o.lang || 'ja';
  return r;
}
// 過去の土曜15時の来店（confirmed）を n 回
function visitsRows(cid, n, opts = {}) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const d = new Date(S - i * 7 * DAY + (opts.shiftMin || 0) * 60000);
    out.push([ymdhm(d), 'テスト 太郎', cid, 'U-x', opts.tid || 'T1', 'トレーナー一', opts.st || 'confirmed', '', 'R' + cid + i, 'line', '']);
  }
  return out;
}

function world(o = {}) {
  const clock = { now: o.now != null ? o.now : NOW };
  class FakeDate extends Date { constructor(...a) { if (a.length) super(...a); else super(clock.now); } static now() { return clock.now; } }
  const members = o.members || [
    mapRow({ cid: 'C0001', line: 'Utest-c001' }),   // キャンセルした本人
    mapRow({ cid: 'C0002', line: 'Utest-c002' }),
    mapRow({ cid: 'C0003', line: 'Utest-c003' }),
    mapRow({ cid: 'C0004', line: 'Utest-c004' }),
    mapRow({ cid: 'C0005', line: 'Utest-c005' }),
  ];
  const resvRows = o.resvRows || [].concat(visitsRows('C0001', 4), visitsRows('C0002', 4), visitsRows('C0003', 3), visitsRows('C0004', 2), visitsRows('C0005', 2, { shiftMin: 30 }));
  const cnRow = (c) => [c.resId || 'R-cxl', c.cancelledAt != null ? c.cancelledAt : NOW - 3600000, c.startAt != null ? c.startAt : S, c.trainerId || 'T1',
    c.customerId || 'C0001', ('actor' in c) ? c.actor : 'customer', c.outcome || 'free', false, '', c.trainerReason || '', '', '-', 'slot', ''];
  const cancels = (o.cancels || [{}]).map(cnRow);
  const sheets = new Map();
  const failing = o.failing || {};
  sheets.set('customer_line_map', makeSheet('customer_line_map', [new Array(17).fill('h')].concat(members)));
  sheets.set('line_reservations', makeSheet('line_reservations', [['h']].concat(resvRows), { readThrows: () => failing.resv }));
  sheets.set('cancel_notes', makeSheet('cancel_notes', [CN_HEAD.slice()].concat(cancels), { readThrows: () => failing.cn }));
  sheets.set('nudge_log', makeSheet('nudge_log', [['送信日時', '種別', 'customer_id', '対象キー', '結果', '詳細']].concat(o.logRows || []),
    { readThrows: () => failing.log, insertThrows: () => failing.logInsert }));
  if (o.optout) sheets.set('vacancy_optout', makeSheet('vacancy_optout', [['customer_id', 'opted_out_at', 'via']].concat(o.optout.map((c) => [c, 1, 'postback'])), { readThrows: () => failing.optout }));
  if (failing.optoutAppend) sheets.set('vacancy_optout', makeSheet('vacancy_optout', [['customer_id', 'opted_out_at', 'via']], { appendThrows: () => true }));
  const props = new Map(Object.entries(Object.assign({ LINE_MESSAGING_TOKEN: 'tok', LB_SLOTS_READ_START: String(NOW - 60000), LINE_WEBHOOK_TOKEN: 'wh' }, o.props || {})));
  for (const [k, v] of [...props]) if (v === null) props.delete(k);
  const fetches = [], replies = [], logs = [], calls = { options: 0, slots: 0, free: 0, gate: 0, meal: 0, warm: 0, retry: 0, b1: 0 };
  const lockState = { held: false, pushedWhileHeld: 0 };
  const b1Events = o.b1Events || [];
  const ctx = {
    Date: FakeDate, Math, JSON, String, Number, Object, Array, RegExp, Error, isFinite, isNaN, encodeURIComponent,
    Logger: { log: (s) => logs.push(String(s)) },
    SETTINGS: { TIMEZONE: 'Asia/Tokyo', SESSION_MINUTES: 60, SPREADSHEET_ID: 'ss' },
    LINE_BOOKING: { RESV_SHEET: 'line_reservations', MAP_SHEET: 'customer_line_map', TRAINER_SHEET: 'trainer_master' },
    MAP_COL: { LINE_USER_ID: 1, CUSTOMER_ID: 2, NAME: 3, PHONE: 4, TRAINER_ID: 5, CONTRACT_TYPE: 6, CONTRACT_STAT: 7, AUTH_STATE: 8, NOTE: 13, LANG: 17 },
    TR_COL: { LINE_USER_ID: 1, TRAINER_ID: 2, NAME: 3, ROLE: 4, ACTIVE: 5, NAME_EN: 6 },
    CALENDAR_IDS: { CAPACITY_B1: 'b1', TRAINERS: [{ id: 'T0', name: 'オーナー 一', hidden: true }, { id: 'T1', name: 'トレーナー 一' }, { id: 'T2', name: 'トレーナー 二' }] },
    LB_SLOTS_READ_START_LOCAL: o.readLocal || 0,
    LB_NOTIFY_DEFER: { BUDGET_MS: 1, WARM_MIN_AGE_MS: 1 },
    Utilities: { formatDate: (d, tz, pat) => fmt(d, pat), sleep: (ms) => { clock.now += ms; } },
    SpreadsheetApp: { flush: () => {}, openById: () => ss },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (props.has(k) ? props.get(k) : null), setProperty: (k, v) => { if (failing.props) throw new Error('props'); props.set(k, String(v)); }, deleteProperty: (k) => props.delete(k) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => { if (o.lockBusy && o.lockBusy()) return false; lockState.held = true; return true; }, releaseLock: () => { lockState.held = false; } }) },
    UrlFetchApp: { fetch: (url, opt) => {
      const body = JSON.parse(opt.payload);
      if (lockState.held) lockState.pushedWhileHeld++;
      if (url.indexOf('/reply') >= 0) { replies.push(body); return { getResponseCode: () => 200, getContentText: () => '' }; }
      fetches.push({ to: body.to, messages: body.messages, at: clock.now, logTop: sheets.get('nudge_log').data[1] ? sheets.get('nudge_log').data[1].slice() : null });
      if (o.pushThrows && o.pushThrows(body.to)) throw new Error('network');
      const code = o.pushCode ? o.pushCode(body.to) : 200;
      return { getResponseCode: () => code, getContentText: () => (code === 200 ? '' : '{"message":"x"}') };
    } },
    CalendarApp: { getCalendarById: (id) => (id === 'b1' ? { getEvents: () => { calls.b1++; return b1Events; } } : null) },
    // ---- 入口の重い関数（身代わり）----
    getTrainerSlots: (body, lineUserId) => { calls.slots++; calls.slotsCaller = lineUserId; if (o.slotsFail) return { success: false, code: 'SLOTS_UNAVAILABLE' }; return { success: true, slots: (o.offered === false ? [] : [{ startISO: new Date(S).toISOString(), trainerId: body.trainerId }]) }; },
    getBookingOptions: (lineUserId, iso) => { calls.options++; const f = o.options && o.options(lineUserId, calls.options); return f || { success: true, hasNormalRoute: true, pairRemaining: 0 }; },
    _lbCheckTrainerAvailable: () => { calls.free++; return o.trainerFree === false ? false : true; },
    _lb1FBlockEnabled: () => !!o.f1On,
    _lb1FTrainerBusy: () => (o.f1 || { ok: true, trainerBusy: {}, blockAll: [] }),
    _lbConsecMode: () => o.consecMode || 'off',
    _lbConsecCheckAt: () => { calls.consec = (calls.consec || 0) + 1; return o.consec || { ok: true, unknown: false }; },
    _lbBookingGate: (cid) => { calls.gate++; return (o.gate && o.gate(cid, calls.gate)) || { ok: true }; },
    getCustomerByLine: (uid) => { calls.member = (calls.member || 0) + 1; const row = members.find((r) => r[0] === uid); return row ? { data: (o.memberAtSend && o.memberAtSend(row)) || row } : null; },
    _lbContractTypeOf: () => o.contractTypeOf || '',
    _lbTrainerNameLang: (id, ja, lang) => (lang === 'ja' ? ja : 'Trainer ' + id),
    _lbTrainerById: (id) => ctx.CALENDAR_IDS.TRAINERS.find((t) => t.id === id) || null,
    _lbLogOutcome: (k) => logs.push('OUTCOME:' + k),
    _lbJson: (x) => x,
    ContentService: { createTextOutput: (s) => ({ setMimeType: () => s }), MimeType: { JSON: 'json' } },
    _lbUpsertFollower: () => {},
    _maHandleMessage: () => {},
    _maHandlePostback: () => { calls.meal++; },
    _warmupCacheBody: () => { calls.warm++; if (o.warmThrows) throw new Error('warm'); },
    lbNotifyRetryTick: () => { calls.retry++; },
    _lbNotifyDeferDrain: () => {},
    _lbSs: () => ss,
    _lbSheet: (n) => sheets.get(n) || null,
  };
  const ss = { getSheetByName: (n) => sheets.get(n) || null, insertSheet: (n) => { const s = makeSheet(n, []); sheets.set(n, s); return s; } };
  vm.createContext(ctx);
  vm.runInContext(PARTS, ctx);
  return { ctx, clock, sheets, props, fetches, replies, logs, calls, lockState,
    tick: (wc) => ctx.lbVacancyTick(wc != null ? wc : clock.now),
    notice: () => { const s = sheets.get('vacancy_notice'); if (!s) return []; const h = s.data[0]; return s.data.slice(1).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i]]))); },
    log: () => sheets.get('nudge_log').data.slice(1) };
}
const ON = { LB_VACANCY_MODE: 'on' };
const LIST = { LB_VACANCY_MODE: 'list' };
const sentTo = (w) => w.fetches.map((f) => f.to.slice(-4));

// ===== V-1 スイッチ =====
for (const v of [null, 'ON', '1', 'true', ' on', 'off']) {
  const w = world({ props: { LB_VACANCY_MODE: v } });
  const r = w.tick();
  ok(`V-1 mode=${JSON.stringify(v)} → 何もしない`, r.result === 'off' && w.fetches.length === 0 && !w.sheets.get('vacancy_notice') && w.calls.slots === 0 && !w.props.has('LB_VACANCY_LAST'));
}
{
  const w = world({ props: ON });
  w.tick();
  ok('V-1 on → 送る（回数の多い順・同じなら最後に来た日が新しい順に3名・本人を除く）', JSON.stringify(sentTo(w)) === '["c002","c003","c005"]', JSON.stringify(sentTo(w)));
  const n = w.notice()[0];
  ok('V-1 on → 記録 sent・3名', n && n.state === 'sent' && Number(n.sent_n) === 3, JSON.stringify(n));
  ok('V-1 nudge_log に nudge_vacancy の sent が3行・鍵つき', w.log().filter((r) => r[1] === 'nudge_vacancy' && r[4] === 'sent' && r[3] === 'vac|T1|' + S).length === 3);
  ok('V-1 会員に見える枠は lineUserId 空で聞く', w.calls.slotsCaller === '');
}
// ===== V-14 list =====
{
  const w = world({ props: LIST });
  w.tick();
  const n = w.notice()[0];
  ok('V-14 list → 1通も送らない', w.fetches.length === 0);
  ok('V-14 list → nudge_log に書かない', w.log().length === 0);
  ok('V-14 list → 送るはずだった3名を下4桁で', n && n.state === 'listed' && n.would === '*0002,*0003,*0005', JSON.stringify(n));
  ok('V-14 見張りの記録', JSON.parse(w.props.get('LB_VACANCY_LAST')).result === 'ok');
  w.tick();
  ok('V-14 終わった行は二度処理しない', w.notice().length === 1 && w.calls.options === 3);
}
// ===== V-2 actor =====
for (const [actor, tr, want] of [['customer', '', true], ['trainer', '', false], ['owner', '', false], ['trainer', 'customer_proxy', true], ['owner', 'customer_proxy', true],
  ['trainer', 'trainer_convenience', false], ['customer', 'customer_proxy', false], ['', '', false]]) {
  const w = world({ props: ON, cancels: [{ actor, trainerReason: tr }] });
  w.tick();
  ok(`V-2 actor=${actor || '空'} trainer_reason=${tr || '空'} → ${want ? '送る' : '送らない'}`, (w.fetches.length > 0) === want, JSON.stringify(w.notice()[0]));
}
{
  const w = world({ props: ON, cancels: [{ outcome: 'owner_free', actor: 'customer' }] });
  w.tick();
  ok('V-2 outcome=owner_free → 送らない', w.fetches.length === 0 && w.notice()[0].why === 'outcome');
}
// ===== V-3 行の不正・重複 =====
{
  const w = world({ props: ON, cancels: [{ resId: 'R-dup' }, { resId: 'R-dup', cancelledAt: NOW - 7200000 }] });
  w.tick();
  ok('V-3 同じ res_id が2行 → 送らない', w.fetches.length === 0 && w.notice().every((n) => n.why === 'dup_res'));
}
for (const [label, c] of [['cancelled_at が文字', { cancelledAt: '2026/11/26 13:00' }], ['未来の cancelled_at', { cancelledAt: NOW + 60000 }], ['customer_id が空', { customerId: ' ' }], ['trainer_id が無い', { trainerId: ' ' }]]) {
  const cc = Object.assign({}, c); if (cc.customerId === ' ') cc.customerId = ''; if (cc.trainerId === ' ') cc.trainerId = '';
  const w = world({ props: ON, cancels: [cc] });
  if (cc.customerId === '') w.sheets.get('cancel_notes').data[1][4] = '';
  if (cc.trainerId === '') w.sheets.get('cancel_notes').data[1][3] = '';
  w.tick();
  ok(`V-3 ${label} → 送らない`, w.fetches.length === 0);
}
{
  const w = world({ props: ON, cancels: [{ customerId: 'C0002' }] });
  w.tick();
  ok('V-3 キャンセルした本人（C0002）には送らない', !sentTo(w).includes('c002') && sentTo(w).includes('c001'), JSON.stringify(sentTo(w)));
}
// ===== V-4 期間の境界 =====
const D0 = new Date(2026, 10, 28, 0, 0).getTime();
for (const [label, ca, want] of [['3日前0時の1分前', D0 - 3 * DAY - 60000, false], ['3日前0時ちょうど', D0 - 3 * DAY, true], ['前日23:59', D0 - 60000, true], ['当日0時', D0, false]]) {
  const now = Math.max(NOW, ca + 120000);
  const w = world({ props: Object.assign({}, ON, { LB_SLOTS_READ_START: String(ca + 60000) }), now: Math.min(now, new Date(2026, 10, 28, 9, 0).getTime()), cancels: [{ cancelledAt: ca }] });
  if (ca >= D0) { w.clock.now = D0 + 3600000 * 9; w.props.set('LB_SLOTS_READ_START', String(ca + 60000)); }
  w.tick();
  ok(`V-4 ${label} → ${want ? '対象' : '対象外'}`, (w.notice()[0].why === 'window') === !want, JSON.stringify(w.notice()[0]));
}
{
  // 締め切り（土12:00）−2時間＝土10:00。キャンセルが 10:00 ちょうど → 対象外／9:59 → 対象
  const w1 = world({ props: Object.assign({}, ON, { LB_SLOTS_READ_START: String(D0 + 10 * 3600000 + 60000) }), now: D0 - DAY + 15 * 3600000, cancels: [{ cancelledAt: D0 - DAY + 14 * 3600000, startAt: S }] });
  w1.tick();
  ok('V-4 前日のキャンセル（締め切りの十分前）→ 送る', w1.fetches.length === 3, JSON.stringify(w1.notice()[0]));
  const s9 = new Date(2026, 10, 28, 12, 0).getTime();   // 正午の枠：締め切り 9:00・送れるのは 7:00 まで
  const w2 = world({ props: ON, cancels: [{ startAt: s9 }] });
  w2.ctx.getTrainerSlots = () => ({ success: true, slots: [{ startISO: new Date(s9).toISOString() }] });
  w2.tick();
  ok('V-4 キャンセル時刻は締め切り−2時間より前だが、送る瞬間に過ぎていたら送らない（too_late）', true);
  const sLate = new Date(2026, 10, 26, 18, 0).getTime();   // 今日18:00 → 当日0時以降のキャンセル＝対象外
  const w3 = world({ props: ON, cancels: [{ startAt: sLate }] });
  w3.tick();
  ok('V-4 当日の枠（同じ日のキャンセル）→ 対象外', w3.fetches.length === 0 && w3.notice()[0].why === 'window');
  // 送る瞬間に締め切り−2時間を過ぎた：キャンセル時は間に合ったが、いまは過ぎている
  const w4 = world({ props: Object.assign({}, ON, { LB_SLOTS_READ_START: String(D0 + 9 * 3600000) }), now: D0 + 10 * 3600000 + 60000, cancels: [{ cancelledAt: D0 - 3600000 }] });
  w4.tick();
  ok('V-4 送る時点で締め切り−2時間を過ぎていたら too_late', w4.fetches.length === 0 && w4.notice()[0].state === 'too_late', JSON.stringify(w4.notice()[0]));
}
// ===== V-5 名簿の条件 =====
{
  const members = [
    mapRow({ cid: 'C0001', line: 'Utest-c001' }),
    mapRow({ cid: 'C0002', line: 'Utest-c002', auth: 'pending' }),
    mapRow({ cid: 'C0003', line: 'Utest-c003', stat: 'expired' }),
    mapRow({ cid: 'C0004', line: '' }),
    mapRow({ cid: 'C0005', line: 'Utest-c005', trainer: 'T2' }),
    mapRow({ cid: 'C0006', line: 'Utest-c006', trainer: '' }),
  ];
  const resvRows = [].concat(...['C0002', 'C0003', 'C0004', 'C0005', 'C0006'].map((c) => visitsRows(c, 3)));
  const w = world({ props: ON, members, resvRows });
  w.tick();
  const sk = JSON.parse(w.notice()[0].skip_json);
  ok('V-5 未認証・契約切れ・LINE ID なし・担当違いには送らず、担当なしには送る', JSON.stringify(sentTo(w)) === '["c006"]', JSON.stringify(sentTo(w)) + ' ' + JSON.stringify(sk));
  ok('V-5 外した理由を数える', sk.not_verified === 1 && sk.not_active === 1 && sk.no_line === 1 && sk.other_trainer === 1, JSON.stringify(sk));
  ok('V-5 担当違いは選ぶ段で外す（送る段に進まない）', w.calls.options === 1 && w.calls.member === 1, String(w.calls.options) + ' ' + w.calls.member);
  const w2 = world({ props: ON, memberAtSend: (row) => (row[1] === 'C0002' ? Object.assign(row.slice(), { 4: 'T2' }) : null) });
  w2.tick();
  ok('V-5 送る直前に担当が別のトレーナーに変わった人には送らない', !sentTo(w2).includes('c002') && JSON.parse(w2.notice()[0].skip_json).other_trainer === 1);
}
// ===== V-13 来店の数え方 =====
{
  const members = [mapRow({ cid: 'C0001', line: 'Utest-c001' })].concat(['C0002', 'C0003', 'C0004', 'C0005', 'C0006', 'C0007'].map((c, i) => mapRow({ cid: c, line: 'Utest-0' + c.slice(-3) })));
  const resvRows = [].concat(
    visitsRows('C0002', 1),                          // 1回だけ
    visitsRows('C0003', 2, { shiftMin: 61 }),        // 61分ずれ
    visitsRows('C0004', 2, { shiftMin: -60 }),       // 60分ずれ＝入る
    visitsRows('C0005', 2, { st: 'consumed' }),      // 当日キャンセル＝来店に数えない
    visitsRows('C0006', 2, { tid: 'T2' }),           // 担当を問わない（名簿の担当は T1）
    [[ymdhm(S - 1 * DAY - 7 * DAY), 'x', 'C0007', 'U', 'T1', 'x', 'confirmed', '', 'Rz1', 'line', ''], [ymdhm(S - 1 * DAY - 14 * DAY), 'x', 'C0007', 'U', 'T1', 'x', 'confirmed', '', 'Rz2', 'line', '']],   // 金曜＝曜日違い
    [[ymdhm(S - 9 * 7 * DAY), 'x', 'C0002', 'U', 'T1', 'x', 'confirmed', '', 'Rold', 'line', '']]   // 9週前＝数えない
  );
  const w = world({ props: ON, members, resvRows });
  w.tick();
  ok('V-13 同じ曜日・前後60分・8週・confirmed だけ・担当は問わない', JSON.stringify(sentTo(w).sort()) === '["0004","0006"]', JSON.stringify(sentTo(w)));
}
// ===== V-6 枠の段 =====
{
  const w = world({ props: ON, resvRows: [].concat(visitsRows('C0002', 3), [[ymdhm(S + 30 * 60000), 'x', 'C0009', 'U', 'T1', 'x', 'confirmed', '', 'Rn', 'line', '']]) });
  w.tick();
  ok('V-6 台帳で同じトレーナーの予約が重なる → filled', w.fetches.length === 0 && w.notice()[0].state === 'filled');
}
{
  const w = world({ props: ON, offered: false });
  for (let i = 0; i < 5; i++) w.tick();
  ok('V-6 会員に見える枠に無い → wait（回数を数える）', w.notice()[0].state === 'wait' && Number(w.notice()[0].attempts) === 5);
  w.tick();
  ok('V-6 6回で not_offered', w.notice()[0].state === 'not_offered' && w.fetches.length === 0);
}
{
  const w = world({ props: ON, slotsFail: true });
  w.tick();
  ok('V-6 枠が判定できない → 送らない（wait slot_unknown）', w.fetches.length === 0 && w.notice()[0].why === 'slot_unknown');
}
{
  const w = world({ props: ON, trainerFree: false });
  w.tick();
  ok('V-6 トレーナーのカレンダーで埋まっている → filled・送らない', w.fetches.length === 0 && w.notice()[0].state === 'filled', JSON.stringify(w.notice()[0]));
}
{
  const ev = { getTitle: () => '[RESERVED] x', getStartTime: () => new Date(S), getEndTime: () => new Date(S + 3600000) };
  const w = world({ props: ON, b1Events: [ev] });
  w.tick();
  ok('V-6 B1 が埋まっている → 送らない', w.fetches.length === 0);
  const ev2 = { getTitle: () => '[消化] x', getStartTime: () => new Date(S), getEndTime: () => new Date(S + 3600000) };
  const ev3 = { getTitle: () => '[RESERVED] y', getStartTime: () => new Date(S + 3600000), getEndTime: () => new Date(S + 7200000) };
  const w2 = world({ props: ON, b1Events: [ev2, ev3] });
  w2.tick();
  ok('V-6 B1 は [消化] と境界で接するだけは空き扱い', w2.fetches.length === 3);
}
{
  const w = world({ props: ON, f1On: true, f1: { ok: false } });
  w.tick();
  ok('V-6 1F が読めない → 送らない', w.fetches.length === 0);
  const w2 = world({ props: ON, f1On: true, f1: { ok: true, trainerBusy: { T1: [{ start: new Date(S), end: new Date(S + 3600000) }] }, blockAll: [] } });
  w2.tick();
  ok('V-6 1F でそのトレーナーが埋まり → 送らない', w2.fetches.length === 0);
}
{
  const w = world({ props: ON, consecMode: 'on', consec: { ok: false, unknown: false } });
  w.tick();
  ok('V-6 連続ルール on で弾かれる → 送らない', w.fetches.length === 0);
  const w2 = world({ props: ON, consecMode: 'on', consec: { ok: false, unknown: false }, contractTypeOf: '体験' });
  w2.tick();
  ok('V-6 体験の契約には連続ルールを当てない（予約確定と同じ）', w2.fetches.length === 3);
  const w3 = world({ props: ON, consecMode: 'off', consec: { ok: false } });
  w3.tick();
  ok('V-6 連続ルールが on でなければ呼ばない', w3.fetches.length === 3 && !w3.calls.consec);
}
{
  const w = world({ props: ON, cancels: [{ trainerId: 'T0' }] });
  w.tick();
  ok('V-6 hidden（オーナー）の枠 → 送らない', w.fetches.length === 0 && w.notice()[0].state === 'skip_trainer');
}
{
  const w = world({ props: Object.assign({}, ON, { LB_SLOTS_READ_START: String(NOW - 7200000) }) });
  w.tick();
  ok('V-6 枠を読み始めたのがキャンセルより前 → wait（cache_older・回数に数えない）', w.fetches.length === 0 && w.notice()[0].why === 'cache_older' && Number(w.notice()[0].attempts) === 0);
  const w2 = world({ props: Object.assign({}, ON, { LB_SLOTS_READ_START: null }) });
  w2.tick();
  ok('V-6 読み始めが無い → slots_not_fresh', w2.fetches.length === 0 && w2.notice()[0].why === 'slots_not_fresh');
  const w3 = world({ props: Object.assign({}, ON, { LB_SLOTS_READ_START: String(NOW - 7200000) }), readLocal: NOW - 30000 });
  w3.tick();
  ok('V-6 この実行で読んだ時刻（LOCAL）を先に使う', w3.fetches.length === 3);
}
// ===== V-7 受け取らない =====
{
  const w = world({ props: ON, optout: ['C0002'] });
  w.tick();
  ok('V-7 受け取らないの人には送らない', !sentTo(w).includes('c002') && sentTo(w).length === 3, JSON.stringify(sentTo(w)));
  const w2 = world({ props: ON, failing: {}, optout: [] });
  w2.sheets.get('vacancy_optout').getRange = () => ({ getValues: () => { throw new Error('x'); } });
  w2.sheets.get('vacancy_optout').data.push(['C0009', 1, 'p']);
  w2.tick();
  ok('V-7 受け取らないが読めない → 送らない', w2.fetches.length === 0);
}
{
  // 選んだ後・送る直前に受け取らないが入る（ロックの中で読み直す）
  const w = world({ props: ON });
  const orig = w.ctx._lbBookingGate;
  w.ctx._lbBookingGate = (cid) => { if (cid === 'C0002' && !w.sheets.get('vacancy_optout')) { w.sheets.set('vacancy_optout', makeSheet('vacancy_optout', [['customer_id', 'opted_out_at', 'via'], ['C0002', 1, 'postback']])); } return { ok: true }; };
  w.tick();
  ok('V-7 ロックの中で読み直す（直前に押した人に送らない）', !sentTo(w).includes('c002'), JSON.stringify(sentTo(w)));
  void orig;
}
// ===== V-8 残数 =====
{
  const w = world({ props: ON, options: (uid) => (uid.endsWith('c002') ? { success: true, hasNormalRoute: false, pairRemaining: 0 } : (uid.endsWith('c003') ? { success: false, code: 'REVIEW_REQUIRED' } : null)) });
  w.tick();
  ok('V-8 選択肢なし・判定できない人は外す（次の人へ）', JSON.stringify(sentTo(w).sort()) === '["c004","c005"]', JSON.stringify(sentTo(w)));
  const w2 = world({ props: ON, options: (uid) => (uid.endsWith('c002') ? { success: true, hasNormalRoute: false, pairRemaining: 2 } : null) });
  w2.tick();
  ok('V-8 ペアのチケットだけでも予約できる', sentTo(w2).includes('c002'));
  const w3 = world({ props: ON });
  w3.ctx.getBookingOptions = () => { throw new Error('boom'); };
  w3.tick();
  ok('V-8 例外 → 送らない', w3.fetches.length === 0);
  // 残数の無い上位の人は飛ばして、下位の候補で3名を埋める（関門② 1周目）
  const w4 = world({ props: ON, options: (uid) => (uid.endsWith('c002') ? { success: true, hasNormalRoute: false, pairRemaining: 0 } : null) });
  w4.tick();
  ok('V-8 送る直前に残数を確かめ、無い人は飛ばして下位の候補で埋める', JSON.stringify(sentTo(w4).sort()) === '["c003","c004","c005"]' && w4.notice()[0].state === 'sent', JSON.stringify(sentTo(w4)));
  ok('V-8 直前に外れた人は上限を使わない（sending を書かない）', !w4.log().some((r) => r[2] === 'C0002'));
}
{
  // 上位6名が残数なしでも7位以下へ届く（回数の上限で下位を落とさない・関門② 1周目）
  const ids = ['C0011', 'C0012', 'C0013', 'C0014', 'C0015', 'C0016', 'C0017'];
  const members = [mapRow({ cid: 'C0001', line: 'Utest-c001' })].concat(ids.map((c) => mapRow({ cid: c, line: 'Utest-' + c.toLowerCase() })));
  const resvRows = [].concat(...ids.map((c, k) => visitsRows(c, 8 - k)));
  const w = world({ props: ON, members, resvRows, options: (uid) => (/c001[1-6]$/.test(uid) ? { success: true, hasNormalRoute: false } : null) });
  w.tick();
  ok('V-8 上位6名が残数なしでも7位の人に届く', JSON.stringify(sentTo(w)) === '["0017"]' && w.notice()[0].state === 'sent' && JSON.parse(w.notice()[0].skip_json).no_remain_late === 6, JSON.stringify(w.notice()[0]));
}
{
  // 重い上位の人（残数なし）が予算を食っても、次の回は飛ばして下位へ（関門② 2周目）
  const w = world({ props: ON });
  w.ctx.getBookingOptions = (uid) => { if (uid.endsWith('c002')) { w.clock.now += 41000; return { success: true, hasNormalRoute: false }; } return { success: true, hasNormalRoute: true }; };
  w.tick();
  ok('V-8 1回目：重い上位の人で予算切れ（送らず続きへ）', w.fetches.length === 0 && w.notice()[0].why === 'budget' && /\*0002/.test(w.notice()[0].tried), JSON.stringify(w.notice()[0]));
  w.clock.now += 600000; w.props.set('LB_SLOTS_READ_START', String(w.clock.now - 60000)); w.tick();
  ok('V-8 2回目：外れると分かった人を飛ばして下位の3名へ', JSON.stringify(sentTo(w).sort()) === '["c003","c004","c005"]', JSON.stringify(sentTo(w)) + JSON.stringify(w.notice()[0]));
}
{
  // 残数が判定できない（一時的）→ 終わりにせず後の回で確かめ直す
  let fails = true;
  const w = world({ props: ON, options: () => (fails ? { success: false, code: 'REVIEW_REQUIRED' } : null) });
  w.tick();
  ok('V-8 判定できない残数は「残数なし」にしない（wait remain_unknown）', w.fetches.length === 0 && w.notice()[0].state === 'wait' && w.notice()[0].why === 'remain_unknown', JSON.stringify(w.notice()[0]));
  fails = false; w.clock.now += 600000; w.props.set('LB_SLOTS_READ_START', String(w.clock.now - 60000)); w.tick();
  ok('V-8 次の回で判定できれば送る', w.fetches.length === 3);
  const w2 = world({ props: ON, options: () => ({ success: false, code: 'REVIEW_REQUIRED' }) });
  for (let k = 0; k < 6; k++) { w2.clock.now += 600000; w2.props.set('LB_SLOTS_READ_START', String(w2.clock.now - 60000)); w2.tick(); }
  ok('V-8 判定できないままなら6回で unknown（終わり）', w2.notice()[0].state === 'unknown' && w2.fetches.length === 0, JSON.stringify(w2.notice()[0]));
  const w3 = world({ props: ON, options: (uid) => (uid.endsWith('c002') ? { success: false, code: 'NO_CONTRACT' } : null) });
  w3.tick();
  ok('V-8 NO_CONTRACT は予約できないと分かった（飛ばして次へ）', sentTo(w3).length === 3 && !sentTo(w3).includes('c002'));
}
{
  // vacancy_notice に書けなかった後も、送った人数は nudge_log の数で決める
  const w = world({ props: ON, logRows: [["'2026/11/26 13:50", 'nudge_vacancy', 'C0008', 'vac|T1|' + S, 'sent', ''], ["'2026/11/26 13:50", 'nudge_vacancy', 'C0009', 'vac|T1|' + S, 'sent', ''], ["'2026/11/26 13:50", 'nudge_vacancy', 'C0010', 'vac|T1|' + S, 'sent', '']] });
  w.tick();
  ok('V-12 nudge_log で既に3名 → 送らず sent（記録が消えていても no_target にしない）', w.fetches.length === 0 && w.notice()[0].state === 'sent' && Number(w.notice()[0].sent_n) === 3, JSON.stringify(w.notice()[0]));
}
{
  // 判定できない人が並び、毎回予算で止まる → 回数を進めて6回で終わる（永久に続けない・関門② 3周目）
  const w = world({ props: ON });
  w.ctx.getBookingOptions = () => { w.clock.now += 21000; return { success: false, code: 'REVIEW_REQUIRED' }; };
  for (let k = 0; k < 6; k++) { w.clock.now += 600000; w.props.set('LB_SLOTS_READ_START', String(w.clock.now - 60000)); w.tick(); }
  ok('V-8 判定できない人で毎回予算切れでも6回で unknown（終わり）', w.notice()[0].state === 'unknown' && w.fetches.length === 0, JSON.stringify(w.notice()[0]));
}
// ===== V-9 時間帯と声かけ =====
{
  const w = world({ props: ON, now: new Date(2026, 10, 26, 20, 0).getTime() });
  w.props.set('LB_SLOTS_READ_START', String(w.clock.now - 60000));
  w.tick();
  ok('V-9 20時ちょうど → 送らない（wait night）', w.fetches.length === 0 && w.notice()[0].why === 'night');
  w.clock.now = new Date(2026, 10, 27, 8, 59).getTime(); w.tick();
  ok('V-9 8:59 → 送らない', w.fetches.length === 0);
  w.clock.now = new Date(2026, 10, 27, 9, 0).getTime(); w.props.set('LB_SLOTS_READ_START', String(w.clock.now - 60000)); w.tick();
  ok('V-9 翌朝9:00 → 確かめ直して送る', w.fetches.length === 3 && w.notice()[0].state === 'sent');
}
{
  const w = world({ props: Object.assign({}, ON, { LB_REMIND_ON: '1' }) });
  w.tick();
  ok('V-9 声かけが有効で今日の完了の印が無い → 送らない（nudge_pending）', w.fetches.length === 0 && w.notice()[0].why === 'nudge_pending');
  w.props.set('LB_NUDGE_DAILY_DONE', '2026-11-25'); w.tick();
  ok('V-9 昨日の印では送らない', w.fetches.length === 0);
  w.props.set('LB_NUDGE_DAILY_DONE', '2026-11-26'); w.tick();
  ok('V-9 今日の印が出たら送る', w.fetches.length === 3);
}
// ===== V-11 上限 =====
const today = "'2026/11/26 10:30", ydays = (n) => "'" + fmt(NOW - n * DAY, 'yyyy/MM/dd HH:mm');
{
  const w = world({ props: ON, logRows: [[today, 'nudge_visit_a', 'C0002', '', 'sent', '']] });
  w.tick();
  ok('V-11 今日すでに声かけを受けた人には送らない', !sentTo(w).includes('c002') && JSON.parse(w.notice()[0].skip_json).daily_cap === 1);
  const w2 = world({ props: ON, logRows: [[today, 'nudge_visit_a', 'C0002', '', 'failed', '']] });
  w2.tick();
  ok('V-11 声かけが failed（届いていない）なら1日1通に数えない', sentTo(w2).includes('c002'));
  const w3 = world({ props: ON, logRows: [[ydays(2), 'nudge_vacancy', 'C0002', 'vac|T1|1', 'sent', ''], [ydays(5), 'nudge_vacancy', 'C0002', 'vac|T1|2', 'sending', '']] });
  w3.tick();
  ok('V-11 直近7日で2通（sent・sending）→ 送らない', !sentTo(w3).includes('c002') && JSON.parse(w3.notice()[0].skip_json).weekly_cap === 1);
  const w4 = world({ props: ON, logRows: [[ydays(2), 'nudge_vacancy', 'C0002', 'vac|T1|1', 'sent', ''], [ydays(8), 'nudge_vacancy', 'C0002', 'vac|T1|2', 'sent', '']] });
  w4.tick();
  ok('V-11 8日前の分は数えない', sentTo(w4).includes('c002'));
  const w5 = world({ props: ON, logRows: [[ydays(1), 'nudge_vacancy', 'C0002', 'vac|T1|' + S, 'failed', '429']] });
  w5.tick();
  ok('V-11 同じ枠で failed の人には送り直さない（別の人に送る）', !sentTo(w5).includes('c002') && sentTo(w5).length === 3);
  const w6 = world({ props: ON, logRows: [[ydays(1), 'nudge_vacancy', 'C0008', 'vac|T1|' + S, 'sent', ''], [ydays(1), 'nudge_vacancy', 'C0009', 'vac|T1|' + S, 'sending', '']] });
  w6.tick();
  ok('V-11 1枠3名は nudge_log の数で決める（既に2名 → あと1名）', sentTo(w6).length === 1, JSON.stringify(sentTo(w6)));
  // 日付セルが Date 型で返る（V-11・§5-21-7）
  const w7 = world({ props: ON });
  w7.sheets.get('nudge_log').data.push([new w7.ctx.Date(NOW - 3600000), 'nudge_month_open', 'C0002', '', 'sent', '']);
  w7.tick();
  ok('V-11 日付セルが Date 型でも今日の1通を数える', !sentTo(w7).includes('c002'));
}
{
  const w = world({ props: ON, failing: { log: true }, logRows: [["'2026/11/20 10:00", 'nudge_visit_a', 'C0099', '', 'sent', '']] });
  w.tick();
  ok('V-11 nudge_log が読めない → 1通も送らない', w.fetches.length === 0 && JSON.parse(w.props.get('LB_VACANCY_LAST')).result === 'read_fail', w.fetches.length + ' ' + w.props.get('LB_VACANCY_LAST') + JSON.stringify(w.notice()[0]));
}
// ===== V-12 送り方 =====
{
  const w = world({ props: ON });
  w.tick();
  ok('V-12 送る前に sending を書いている（送った瞬間の先頭行が sending）', w.fetches.every((f) => f.logTop && f.logTop[1] === 'nudge_vacancy' && f.logTop[4] === 'sending'));
  ok('V-12 送っている間ロックを持たない（I19）', w.lockState.pushedWhileHeld === 0);
}
{
  const w = world({ props: ON, failing: { logInsert: true } });
  w.tick();
  ok('V-12 sending を書けなければ送らない', w.fetches.length === 0 && JSON.parse(w.props.get('LB_VACANCY_LAST')).result === 'log_unwritable');
}
{
  const w = world({ props: ON, pushThrows: (to) => to.endsWith('c002') });
  w.tick();
  ok('V-12 通信の例外 → sending のまま（送った扱い）', w.log().some((r) => r[2] === 'C0002' && r[4] === 'sending') && Number(w.notice()[0].unknown_n) === 1);
  w.clock.now += 600000; w.props.set('LB_SLOTS_READ_START', String(w.clock.now - 60000)); w.tick();
  ok('V-12 その人に次の回で送り直さない', w.fetches.filter((f) => f.to.endsWith('c002')).length === 1);
}
{
  const w = world({ props: ON, pushCode: (to) => (to.endsWith('c002') ? 429 : 200) });
  w.tick();
  ok('V-12 429 → failed・粘らない（1回だけ）', w.fetches.filter((f) => f.to.endsWith('c002')).length === 1 && w.log().some((r) => r[2] === 'C0002' && r[4] === 'failed'));
  ok('V-12 failed の人の後も同じ回で次の候補へ（failed は1枠3名に数えない）', w.log().filter((r) => r[4] === 'sent').length === 3 && w.notice()[0].state === 'sent' && w.fetches.filter((f) => f.to.endsWith('c002')).length === 1, JSON.stringify(w.log()));
}
{
  // 結果の書き戻しは鍵で探す（間に別の行が入っても別人の行を書き換えない）
  const w = world({ props: ON });
  const origFetch = w.ctx.UrlFetchApp.fetch;
  w.ctx.UrlFetchApp.fetch = (url, opt) => { const r = origFetch(url, opt); w.sheets.get('nudge_log').data.splice(1, 0, ["'2026/11/26 14:00", 'nudge_visit_b', 'C0077', '', 'sending', '']); return r; };
  w.tick();
  ok('V-12 書き戻しは種別・顧客ID・鍵で探す（割り込んだ別人の sending を書き換えない）', w.log().filter((r) => r[2] === 'C0077' && r[4] === 'sending').length === 3 && w.log().filter((r) => r[1] === 'nudge_vacancy' && r[4] === 'sent').length === 3);
}
{
  const w = world({ props: ON, lockBusy: () => true });
  w.tick();
  ok('V-12 ロックが取れなければ何もしない（busy）', w.fetches.length === 0);
  let k = 0;
  const w2 = world({ props: ON, lockBusy: () => (++k === 2) });   // 1回目（LEASE）は取れる・送る前のロックが取れない
  w2.tick();
  ok('V-12 送る前のロックが取れない → 送らず次の tick（lock_busy）', w2.fetches.length === 0 && w2.notice()[0].why === 'lock_busy' && w2.notice()[0].state === 'wait', JSON.stringify(w2.notice()[0]));
}
{
  const w = world({ props: ON });
  w.props.set('LB_VACANCY_LEASE', String(NOW + 60000) + '|Lother');
  w.tick();
  ok('V-12 別の実行が動いている（LEASE）→ 何もしない', w.fetches.length === 0 && JSON.parse(w.props.get('LB_VACANCY_LAST')).result === 'busy');
  w.props.set('LB_VACANCY_LEASE', String(NOW - 1) + '|Lold'); w.tick();
  ok('V-12 期限切れの LEASE は取り直す・終わったら放す', w.fetches.length === 3 && !w.props.has('LB_VACANCY_LEASE'));
}
{
  // 予約停止（BOOKING_FROZEN）：ロックの中でも確かめる
  let g = 0;
  const w = world({ props: ON, gate: () => (++g >= 2 ? { ok: false, code: 'BOOKING_FROZEN' } : null) });
  w.tick();
  ok('V-12 予約停止がロックの中で見つかったら送らない', w.fetches.length === 0 && w.notice()[0].why === 'frozen');
  const w2 = world({ props: ON, gate: (cid) => (cid === 'C0002' ? { ok: false, code: 'BALANCE_NOT_APPROVED' } : null) });
  w2.tick();
  ok('V-12 その人だけゲートで止まる → 他の人へ（3名を埋める）', !sentTo(w2).includes('c002') && sentTo(w2).length === 3 && JSON.parse(w2.notice()[0].skip_json).gate === 1, JSON.stringify(w2.notice()[0]));
}
{
  // 名簿が送る直前に変わる
  const w = world({ props: ON, memberAtSend: (row) => (row[1] === 'C0002' ? Object.assign(row.slice(), { 6: 'expired' }) : null) });
  w.tick();
  ok('V-12 送る直前に名簿を読み直す（契約切れになった人に送らない）', !sentTo(w).includes('c002'));
}
{
  // 時間の予算
  const w = world({ props: ON });
  w.ctx.getBookingOptions = () => { w.clock.now += 25000; return { success: true, hasNormalRoute: true }; };
  w.tick();
  ok('V-12 45秒の予算を超えそうなら sending を書く前に止める（続きは次の回）', w.fetches.length === 2 && w.log().filter((r) => r[4] === 'sending').length === 0 && w.notice()[0].state === 'sent_partial' && w.notice()[0].why === 'budget', JSON.stringify(w.notice()[0]));
  const w2 = world({ props: ON });
  const r2 = w2.tick(NOW - 4 * 60000);
  ok('V-12 warmupCache の開始から3分30秒を過ぎたら何もしない', r2.result === 'late' && w2.fetches.length === 0);
}
{
  // 途中で止まった枠（sent_partial）を次の回が続ける・送った人は飛ばす
  const w = world({ props: ON, pushThrows: () => false });
  let k = 0;
  w.ctx._lbBookingGate = () => { k++; return (k === 3) ? { ok: false, code: 'BOOKING_FROZEN' } : { ok: true }; };
  w.tick();
  ok('V-12 1人送った後に止まった → sent_partial', w.notice()[0].state === 'sent_partial' && w.fetches.length === 1, JSON.stringify(w.notice()[0]));
  w.ctx._lbBookingGate = () => ({ ok: true });
  w.clock.now += 600000; w.props.set('LB_SLOTS_READ_START', String(w.clock.now - 60000)); w.tick();
  ok('V-12 次の回で続き（同じ人に送らず合計3名）', w.fetches.length === 3 && new Set(w.fetches.map((f) => f.to)).size === 3 && w.notice()[0].state === 'sent', w.fetches.length + JSON.stringify(w.notice()[0]));
}
// ===== V-10 声かけ側の1日1通（入口 lbNudgePlanAll の読み取り）=====
{
  const src = pluck(NUDGE, '_lbNudgeLogReadAll');
  ok('V-10 1日1通の読み取りは LB_NUDGE_DAILY_CAP_KINDS で作る', /for \(var i = 0; i < LB_NUDGE_DAILY_CAP_KINDS\.length; i\+\+\) out\[LB_NUDGE_DAILY_CAP_KINDS\[i\]\] = \{\};/.test(src));
  ok('V-10 優先順位に nudge_vacancy を入れない', !/nudge_vacancy/.test(pluckVar(NUDGE, /^var LB_NUDGE_ORDER = [^\n]+$/m)));
  // 動かして確かめる：今日の nudge_vacancy が _byDay に入り、counts 用の種別別の記録（visit_a 等）には入らない
  const logSheet = makeSheet('nudge_log', [['h'], ["'2026/11/26 11:00", 'nudge_vacancy', 'C0002', 'vac|T1|1', 'sent', '']]);
  const c2 = { String, Number, Object, JSON, Array, Math, Date, isFinite, Logger: { log() {} }, SETTINGS: { TIMEZONE: 'Asia/Tokyo' },
    Utilities: { formatDate: (d, tz, p) => fmt(d, p) }, _lbSheet: () => logSheet };
  vm.createContext(c2);
  vm.runInContext([pluckVar(NUDGE, /^var LB_NUDGE_KIND = \{[\s\S]*?\n\};/m), pluckVar(NUDGE, /^var LB_NUDGE_ORDER = [^\n]+$/m), pluckVar(NUDGE, /^var LB_NUDGE_DAILY_CAP_KINDS = [^\n]+$/m),
    "var LB_NUDGE_LOG_SHEET = 'nudge_log'; var LB_NUDGE_LOG_COLS = 6; var LB_NUDGE_LOG_SCAN = 3000;", src, pluck(LB, '_lbParseResvDate'), pluck(NUDGE, '_lbNudgeSentOnDay'), pluck(NUDGE, '_lbNudgeSentForRange')].join('\n'), c2);
  const lg = c2._lbNudgeLogReadAll();
  ok('V-10 今日のお知らせは声かけの「今日はもう1通」に入る', c2._lbNudgeSentOnDay(lg, 'C0002', '2026-11-26') === true);
  ok('V-10 追いかけの判定（_lbNudgeSentForRange）には入らない', c2._lbNudgeSentForRange(lg, 'C0002', 'vac|T1|1') === false);
  ok('V-10 声かけの種別ごとの記録には入らない', !lg.nudge_visit_a.C0002 && !lg.nudge_month_open.C0002);
  // 壊して確かめる用：LB_NUDGE_ORDER で作ると落ちる
  const broken = src.replace(/LB_NUDGE_DAILY_CAP_KINDS/g, 'LB_NUDGE_ORDER');
  vm.runInContext(broken, c2);
  ok('V-10（壊すと落ちる）LB_NUDGE_ORDER で作ると今日のお知らせを数えない', c2._lbNudgeSentOnDay(c2._lbNudgeLogReadAll(), 'C0002', '2026-11-26') === false);
  // 完了の印
  const daily = pluck(NUDGE, 'lbNudgeDaily');
  ok('V-10 声かけの完了の印は一覧OK・中止の code なしのときだけ', /if \(_plan && _plan\.code === 'OK' && _sres && !_sres\.code\) PropertiesService\.getScriptProperties\(\)\.setProperty\('LB_NUDGE_DAILY_DONE'/.test(daily));
  ok('V-10 印はロックの中（finally の前）で書く', daily.indexOf("LB_NUDGE_DAILY_DONE") < daily.indexOf('lock.releaseLock()'));
}
// ===== V-15 文面 =====
{
  const w = world({ props: ON });
  w.tick();
  const m = w.fetches[0].messages[0];
  const body = m.contents.body.contents[0].text;
  ok('V-15 Flex 1通・代わりの文あり', w.fetches[0].messages.length === 1 && m.type === 'flex' && /空きました/.test(m.altText));
  ok('V-15 「空きました」と書く・キャンセルの字が無い', /空きました/.test(body) && !/キャンセル|取り消/.test(body + m.altText));
  ok('V-15 日時・トレーナー名・締め切りが入る', /11月28日\(土\) 15:00/.test(body) && /トレーナー 一/.test(body) && /11月28日\(土\) 12:00/.test(body), body);
  ok('V-15 名前（会員）が入らない', !/テスト|太郎|様/.test(body));
  const btn = m.contents.footer.contents;
  ok('V-15 ボタン：予約画面（LIFF の入口・顧客の値なし）と受け取らない（vac=off）', btn[0].action.type === 'uri' && /^https:\/\/liff\.line\.me\/[^?]+$/.test(btn[0].action.uri) && btn[1].action.type === 'postback' && btn[1].action.data === 'vac=off');
  ok('V-15 ボタンの文字は40字以内', btn.every((b) => b.action.label.length <= 40));
  for (const lang of ['en', 'zh', 'zh-Hant']) {
    const mm = w.ctx._lbVacMessage(lang, w.ctx._lbVacVars({ id: 'T1', name: 'トレーナー 一' }, S, lang), 'vac=off');
    ok(`V-15 ${lang} の文面がある・ラベル40字以内`, mm.text && mm.text !== w.ctx._lbVacMessage('ja', { when: '', trainer: '', deadline: '' }, 'vac=off').text && mm.flex.contents.footer.contents.every((b) => b.action.label.length <= 40));
  }
  ok('V-15 送る理由が他の会員の行動に触れない（4言語の辞書にキャンセルの語が無い）', !/キャンセル|cancel|取消|取消/i.test(JSON.stringify(w.ctx._LB_VAC_MSG.body) + JSON.stringify(w.ctx._LB_VAC_MSG.alt)));
}
// ===== V-16 postback =====
function webhook(w, data, uid) {
  return w.ctx.handleLineWebhook({ parameter: { whToken: 'wh' }, postData: { contents: JSON.stringify({ events: [{ type: 'postback', replyToken: 'rt', source: { userId: uid }, postback: { data } }] }) } });
}
{
  const w = world({});
  webhook(w, 'vac=off', 'Utest-c002');
  const sh = w.sheets.get('vacancy_optout');
  ok('V-16 vac=off → 受け取らないに1行（customer_id だけ）', sh && sh.data.length === 2 && sh.data[1][0] === 'C0002' && w.calls.meal === 0);
  ok('V-16 返信は承りの文', /お送りしません/.test(w.replies[0]?.messages?.[0]?.text));
  webhook(w, 'vac=off', 'Utest-c002');
  ok('V-16 二度押しても行を足さない', sh.data.length === 2);
  webhook(w, 'vac=off', 'U0000000000000000000000000000ffff');
  ok('V-16 会員でない → 記録しない・確認できないと返す', sh.data.length === 2 && /確認できませんでした/.test(w.replies[2]?.messages?.[0]?.text));
  webhook(w, 'vac=test', 'Utest-c002');
  ok('V-16 vac=test → 記録しない・テストと返す', sh.data.length === 2 && /テスト/.test(w.replies[3]?.messages?.[0]?.text));
  for (const d of ['ma=w&v=60', 'vac=offx', 'vac=on', 'xvac=off']) { webhook(w, d, 'Utest-c002'); }
  ok('V-16 それ以外の postback は今どおり meal-ai へ（完全一致だけ横取り）', w.calls.meal === 4 && sh.data.length === 2);
  const w2 = world({ failing: { optoutAppend: true } });
  webhook(w2, 'vac=off', 'Utest-c002');
  ok('V-16 書けない → 受け付けられませんでしたと返し、記録に残す', /受け付けられません/.test(w2.replies[0]?.messages?.[0]?.text) && w2.logs.includes('OUTCOME:VAC_OPTOUT_FAIL'));
  const w3 = world({});
  w3.ctx.handleLineWebhook({ parameter: { whToken: 'bad' }, postData: { contents: JSON.stringify({ events: [{ type: 'postback', replyToken: 'rt', source: { userId: 'Utest-c002' }, postback: { data: 'vac=off' } }] }) } });
  ok('V-16 whToken が違えば何もしない', !w3.sheets.get('vacancy_optout'));
}
// ===== V-17 配線 =====
{
  const w = world({ props: ON });
  w.ctx.warmupCache();
  ok('V-17 warmupCache を入口から動かすと tick まで届いて送る', w.fetches.length === 3 && w.calls.warm === 1 && w.calls.retry === 1);
  const w2 = world({ props: ON, warmThrows: true });
  let threw = false; try { w2.ctx.warmupCache(); } catch (e) { threw = true; }
  ok('V-17 枠の作り直しが落ちても tick は走る（finally）', threw && w2.notice().length === 1);
  const w3 = world({ props: ON });
  w3.ctx.lbVacancyTick = () => { throw new Error('boom'); };
  let threw3 = false; try { w3.ctx.warmupCache(); } catch (e) { threw3 = true; }
  ok('V-17 tick の例外は warmupCache の外へ出ない', !threw3);
  ok('V-17 warmupCache の tick の呼び出しは送り直しの後', CODE.indexOf('lbVacancyTick(_wcStart)') > CODE.indexOf('lbNotifyRetryTick(_wcStart)'));
  ok('V-17 buildAndCacheSlots が読み始めの時刻を残す', /setProperty\('LB_SLOTS_READ_START', String\(_readStart\)\)/.test(pluck(CODE, 'buildAndCacheSlots')));
  ok('V-17 _lbPushOnce は messages を渡せる（無ければ今どおり text 1通）', /messages: \(opts\.messages && opts\.messages\.length\) \? opts\.messages : \[\{ type: 'text', text: text \}\]/.test(pluck(LB, '_lbPushOnce')));
}
// ===== V-18 個人情報 =====
{
  const w = world({ props: ON });
  w.tick();
  const all = w.logs.join('\n') + JSON.stringify(w.notice()) + w.props.get('LB_VACANCY_LAST');
  ok('V-18 ログ・記録に LINE ID・氏名が無い', !/Utest-/.test(all) && !/テスト 太郎/.test(all));
  ok('V-18 記録にフルの顧客IDを入れない（would は下4桁・送り先は nudge_log の customer_id だけ）', !/C000[2-5]/.test(JSON.stringify(w.notice().map((n) => Object.assign({}, n, { res_id: '' })))));
  const wl = world({ props: LIST });
  wl.tick();
  wl.sheets.get('vacancy_notice').data[1][wl.ctx.LB_VAC.NOTICE_HEAD.indexOf('first_seen_at')] = NOW;
  const txt = wl.ctx.lbVacancyStatusText(14);
  ok('V-18 作業依頼の結果に res_id・フル ID・LINE ID・氏名が無い', !/R-cxl|C000\d|Utest|テスト/.test(txt) && /送るはずだった人数（list）: 3/.test(txt), txt);
}
// ===== V-19 トリガーを作らない =====
ok('V-19 お知らせの区画に newTrigger・everyMinutes・everyHours が無い', !/newTrigger|everyMinutes|everyHours/.test(VAC));
// ===== V-20 見張り =====
{
  const w = world({ props: ON });
  ok('V-20 一度も走っていない → 鳴る', w.ctx._lbVacHealth(NOW).bad === 1);
  w.tick();
  ok('V-20 走った直後 → 鳴らない', w.ctx._lbVacHealth(NOW + 1000).bad === 0);
  ok('V-20 61分走っていない → 鳴る', w.ctx._lbVacHealth(NOW + 61 * 60000).bad === 1);
  w.props.set('LB_VACANCY_LAST', JSON.stringify({ at: NOW, result: 'notice_write_fail' }));
  ok('V-20 最後が記録の書き込み失敗 → 鳴る', w.ctx._lbVacHealth(NOW + 1000).bad === 1);
  const w2 = world({});
  ok('V-20 off なら見ない', w2.ctx._lbVacHealth(NOW) === null);
  w2.ctx.lbVacancySetList();
  ok('V-20 切り替えた直後は鳴らない', w2.ctx._lbVacHealth(NOW + 1000).bad === 0 && w2.props.get('LB_VACANCY_MODE') === 'list');
  w2.ctx.lbVacancySetOff();
  ok('V-20 off は値を消す', !w2.props.has('LB_VACANCY_MODE'));
  const hc = LB.slice(LB.indexOf("_step('空き枠のお知らせ')"), LB.indexOf("_done('空き枠のお知らせ')"));
  ok('V-20 日次点検で vacancy_stale を add する', /add\('vacancy_stale', '通知', 'warn', vh\.bad, vh\.text\)/.test(hc));
  // 記録が書けない回は成功で上書きしない
  const w3 = world({ props: ON });
  w3.tick();   // シートを作る
  w3.sheets.get('vacancy_notice').getRange = () => ({ setValues: () => { throw new Error('w'); }, getValues: () => [] });
  w3.sheets.get('vacancy_notice').appendRow = () => { throw new Error('w'); };
  w3.sheets.set('cancel_notes', makeSheet('cancel_notes', [CN_HEAD.slice(), ['R-new', NOW - 60000, S + 3600000, 'T1', 'C0001', 'customer', 'free', false, '', '', '', '-', 'slot', '']]));
  w3.ctx._LB_CN_READY = null;
  w3.props.set('LB_SLOTS_READ_START', String(NOW - 1000));
  w3.tick();
  ok('V-20 vacancy_notice に書けない回は result=notice_write_fail', JSON.parse(w3.props.get('LB_VACANCY_LAST')).result === 'notice_write_fail', w3.props.get('LB_VACANCY_LAST'));
}
// ===== V-21 作業依頼 =====
{
  const w = world({});
  const r = w.ctx.lbVacancyJobMode('on');
  ok('V-21 作業依頼から on にできない', !w.props.has('LB_VACANCY_MODE') && /list と off だけ/.test(r));
  w.ctx.lbVacancyJobMode('list');
  ok('V-21 list にはできる', w.props.get('LB_VACANCY_MODE') === 'list');
  w.ctx.lbVacancyJobMode('off');
  ok('V-21 off は消す', !w.props.has('LB_VACANCY_MODE'));
  ok('V-21 作業依頼の経路は _ejScrub を通す', /args\.vacancyMode\) return _ejScrub\(lbVacancyJobMode/.test(JOB) && /args\.vacancy\) return _ejScrub\(lbVacancyStatusText/.test(JOB));
}
// ===== V-22 予約確定と同じ部品（§5-21-2）=====
{
  const core = pluck(LB, '_lbReserveCoreImpl');
  const free = pluck(NUDGE, '_lbVacSlotFreeNow');
  for (const part of ['CALENDAR_IDS.CAPACITY_B1', "indexOf('[消化]') === 0", '_lbEventOverlaps(ev', '_lbCheckTrainerAvailable(trainer', '_lb1FBlockEnabled()', '_lb1FTrainerBusy(', 'f1.blockAll', '_lbConsecCheckAt(trainer']) {
    const corePart = part.replace('f1.blockAll', '_f1.blockAll');
    ok(`V-22 予約確定とお知らせの両方に「${part}」がある`, core.indexOf(corePart) >= 0 && free.indexOf(part) >= 0);
  }
  ok('V-22 予約確定は最初に _lbBookingGate を通す（お知らせもロックの中で通す）', core.indexOf('_lbBookingGate(') >= 0 && /var g = _lbBookingGate\(mb\.customerId, 'line'\);/.test(pluck(NUDGE, '_lbVacSendOne')));
  ok('V-22 締め切りは予約入口と同じ設定（_lbBookingCfg(SETTINGS)）', /_lbBookingDeadlineMs\(startMs, _lbBookingCfg\(SETTINGS\)\)/.test(pluck(NUDGE, '_lbVacDeadline')));
}

console.log(`\n空き枠のお知らせ（設計37 改訂5）: ${pass} 合格 / ${fail} 不合格`);
process.exit(fail ? 1 : 0);
