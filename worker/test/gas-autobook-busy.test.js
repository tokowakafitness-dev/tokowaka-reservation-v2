// 設計47 §7：固定枠の自動予約（autoBookRecurringPatterns）が予約のロックの混雑（BUSY）に当たったとき（2026-11-20・簡素版）
//   実行: node worker/test/gas-autobook-busy.test.js
//
//   入口から（autoBookRecurringPatterns を呼ぶ）。身代わりは台帳・予約の芯・お知らせ・時計だけ
//   ① BUSY が1回で解ける → 間隔をあけて取り直して取れる・冪等マークが付く・お知らせに BUSY が無い・保留の記録なし
//   ② BUSY が続く → 3回取り直して保留：冪等マークを付けない・お知らせを送らない（BUSY が載らない）・件数に足さない・保留の記録
//      ほかの会員は今どおり。保留の warn が出る
//   ③ 再実行（人が GAS エディタで）：前に取れた枠は本人の予約として見分けて二重に取らない・お知らせ1回・保留0で記録が消え warn も消える
//   ④ 月をまたいでも：別の対象月の実行が保留0で終わっても、前の対象月の保留の warn は消えない
//   ⑤ 4分を過ぎたら取り直さず、残りの会員を保留にする（6分の上限）
//   ⑥ トリガーを作らない
//   ★値は架空（個人情報を書かない）
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { pluckFnFrom as pluckFn, pluckVarFrom as pluckVar } from './_gas-lock-src.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LB = readFileSync(join(process.env.GAS_DIR || join(ROOT, 'gas'), 'LineBooking.js'), 'utf8');
let pass = 0, fail = 0;
function ok(name, cond, why) { if (cond) pass++; else { fail++; console.log(`❌ ${name}`); if (why) console.log(`   ${why}`); } }
const pad = (n) => ('0' + n).slice(-2);
const RP_COL = { PATTERN_ID: 1, CUSTOMER_ID: 2, WEEKDAY: 3, TIME: 4, TRAINER_ID: 5, ACTIVE: 6, SOURCE: 7, CREATED_AT: 8, LAST_MONTH: 9, NOTE: 10 };
const RT = 'var _LB_RECUR_TZ = null;\n' + pluckFn(LB, '_lbRecurTz') + '\n' + pluckFn(LB, '_lbRecurTime');

//   既定は 2026-10-25 06:00 に走らせて 11月を取る。busy(cid, startISO, n) が真のあいだ BUSY
function world({ rows, busy = () => false, props = {}, startMs = new Date(2026, 9, 25, 6).getTime(), slowReserveMs = 0, ledger = {} }) {
  let nowMs = startMs;
  const st = { rows: rows.map((r) => r.slice()), ledger: JSON.parse(JSON.stringify(ledger)), calls: [], sleeps: [], notices: [], props: Object.assign({}, props), triggers: 0, enq: [] };
  class FD extends Date { constructor(...a) { if (a.length === 0) super(nowMs); else super(...a); } static now() { return nowMs; } }
  const n = {};
  const ctx = {
    String, Number, isNaN, isFinite, Math, JSON, Object, Array, Date: FD, RP_COL,
    SETTINGS: { TIMEZONE: 'Asia/Tokyo', SESSION_MINUTES: 60 },
    Utilities: { formatDate: (d, tz, f) => (f === 'HH:mm' ? pad(d.getHours()) + ':' + pad(d.getMinutes()) : String(d)), sleep: (ms) => { st.sleeps.push(ms); nowMs += ms; } },
    _lbSs: () => ({ getSpreadsheetTimeZone: () => 'Asia/Tokyo' }),
    Logger: { log: () => {} },
    _lbTruthy: (v) => v === true, LB_AUTOBOOK_RESULT_PREFIX: 'LB_AUTOBOOK_RESULT_',
    _lbRecurSheet: () => ({ getLastRow: () => st.rows.length + 1, getRange: (r, c) => ({ getValues: () => st.rows.map((x) => x.slice()), setValue: (v) => { st.rows[r - 2][c - 1] = v; } }) }),
    _lbResvSessions: (cid) => (st.ledger[cid] || []).map((ms) => ({ startAt: ms, channel: 'line' })),
    _lbCustInfoById: (cid) => ({ customerId: cid, customerName: 'テスト', contractType: '' }), _lbPickBalancedTrainer: () => 'B',
    getBookableRemaining: () => ({ ok: true, monthlyRem: null }),
    _lbReserveCore: (ci, body) => {
      const key = ci.customerId + '|' + body.startISO;
      n[key] = (n[key] || 0) + 1;
      st.calls.push(key);
      nowMs += 10 + slowReserveMs;
      if (busy(ci.customerId, body.startISO, n[key])) { nowMs += 10000; return { success: false, code: 'BUSY', message: '混み合っています' }; }
      if ((st.ledger[ci.customerId] || []).includes(new Date(body.startISO).getTime())) return { success: false, code: 'SLOT_TAKEN' };
      (st.ledger[ci.customerId] = st.ledger[ci.customerId] || []).push(new Date(body.startISO).getTime());
      return { success: true };
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in st.props ? st.props[k] : null), setProperty: (k, v) => { st.props[k] = String(v); }, deleteProperty: (k) => { delete st.props[k]; } }) },
    ScriptApp: { newTrigger: () => { st.triggers++; return { timeBased: () => ({ after: () => ({ create: () => {} }) }) }; }, getProjectTriggers: () => [], deleteTrigger: () => {} },
    _lbDwMarkDirty: () => {}, lbDwEnqueue: (c) => { st.enq.push(c); return 1; },
    _lbNotifyAutoBook: (c, b, s) => st.notices.push({ c, b, s }),
  };
  vm.createContext(ctx);
  vm.runInContext([RT, pluckFn(LB, '_lbDatesOfWeekdayInMonth'), pluckFn(LB, 'autoBookRecurringPatterns'),
    pluckVar(LB, 'LB_AUTOBOOK_HELD_PROP'), pluckFn(LB, '_lbAutoBookHeldNote'), pluckFn(LB, 'lbAutoBookHeldDailyCheck')].join('\n'), ctx);
  return { ctx, st };
}
//   C1：火曜 9:00（11月は 3・10・17・24）／C2：木曜 9:00
const ROWS = () => [['P-1', 'C1', 2, '09:00', 'B', true, '', '', '', ''], ['P-2', 'C2', 4, '09:00', 'B', true, '', '', '', '']];
const noticeOf = (st, cid) => st.notices.filter((x) => x.c === cid);
const isoOf = (d) => new Date(2026, 10, d, 9).toISOString();
const warns = (w) => w.ctx.lbAutoBookHeldDailyCheck((k) => (k in w.st.props ? w.st.props[k] : null));

console.log('=== ① BUSY が1回で解ける ===');
{
  const w = world({ rows: ROWS(), busy: (cid, iso, k) => cid === 'C1' && iso === isoOf(10) && k === 1 });
  w.ctx.autoBookRecurringPatterns();
  ok('①-1 間隔（3秒）をあけて取り直し、取れた', JSON.stringify(w.st.sleeps) === JSON.stringify([3000]) && (w.st.ledger.C1 || []).length === 4, JSON.stringify({ s: w.st.sleeps, l: (w.st.ledger.C1 || []).length }));
  ok('①-2 冪等マークが付く', w.st.rows[0][RP_COL.LAST_MONTH - 1] === '2026-11');
  const nc = noticeOf(w.st, 'C1');
  ok('①-3 お知らせは1回・4回取れた・BUSY は載らない', nc.length === 1 && nc[0].b.length === 4 && nc[0].s.length === 0, JSON.stringify(nc));
  ok('①-4 保留の記録なし・warn なし', !('LB_AUTOBOOK_HELD' in w.st.props) && warns(w).length === 0, w.st.props.LB_AUTOBOOK_HELD);
}

console.log('=== ② BUSY が続く ===');
let afterBusy = null;
{
  const w = world({ rows: ROWS(), busy: (cid, iso) => cid === 'C1' && iso === isoOf(10) });
  const r = w.ctx.autoBookRecurringPatterns();
  ok('②-1 3回取り直した（3秒・6秒・10秒）', JSON.stringify(w.st.sleeps) === JSON.stringify([3000, 6000, 10000]), JSON.stringify(w.st.sleeps));
  ok('②-2 その会員の残りの枠は今回は取らない（次の実行で）', !w.st.calls.includes('C1|' + isoOf(17)) && !w.st.calls.includes('C1|' + isoOf(24)), w.st.calls.join(','));
  ok('②-3 ★冪等マークを付けない', w.st.rows[0][RP_COL.LAST_MONTH - 1] === '', JSON.stringify(w.st.rows[0]));
  ok('②-4 ★お知らせを送らない（BUSY が skipped に載ることもない）', noticeOf(w.st, 'C1').length === 0 && !w.st.notices.some((x) => x.s.some((y) => y.code === 'BUSY')), JSON.stringify(w.st.notices));
  ok('②-5 取れた1枠（11/3）は写しへ積む', w.st.enq.includes('C1'));
  const res = JSON.parse(w.st.props['LB_AUTOBOOK_RESULT_2026-11'] || '{}');
  ok('②-6 ★件数に保留の会員を足さない', !('C1' in res) && ('C2' in res), JSON.stringify(res));
  ok('②-7 ほかの会員（C2）は今どおり：4回取れ・マーク・お知らせ', (w.st.ledger.C2 || []).length === 4 && w.st.rows[1][RP_COL.LAST_MONTH - 1] === '2026-11' && noticeOf(w.st, 'C2').length === 1);
  const h = JSON.parse(w.st.props.LB_AUTOBOOK_HELD || '{}');
  ok('②-8 保留の記録：対象月・人数・時刻（会員IDなし）', h['2026-11'] && h['2026-11'].n === 1 && typeof h['2026-11'].at === 'number' && !/C1|C2/.test(w.st.props.LB_AUTOBOOK_HELD), w.st.props.LB_AUTOBOOK_HELD);
  const ws = warns(w);
  ok('②-9 ★保留の warn「対象月 2026-11 …保留した会員 1 名・GAS エディタで autoBookRecurringPatterns を再実行」', ws.length === 1 && ws[0].severity === 'warn' && ws[0].count === 1
     && /対象月 2026-11 の固定枠の自動予約を混雑で保留した会員 1 名・GAS エディタで autoBookRecurringPatterns を再実行/.test(ws[0].detail), JSON.stringify(ws));
  ok('②-10 戻り値に保留の人数', r && r.held === 1);
  afterBusy = w.st;
}

console.log('=== ③ 再実行（同じ日・混雑が解けた） ===');
{
  const w = world({ rows: afterBusy.rows, props: afterBusy.props, ledger: afterBusy.ledger, startMs: new Date(2026, 9, 25, 9).getTime() });
  w.ctx.autoBookRecurringPatterns();
  const c1 = w.st.calls.filter((x) => x.startsWith('C1|'));
  ok('③-1 ★前に取れた 11/3 は取り直さない（二重予約しない）', !c1.includes('C1|' + isoOf(3)), c1.join(','));
  ok('③-2 残り（11/10・17・24）を取る', JSON.stringify(c1) === JSON.stringify(['C1|' + isoOf(10), 'C1|' + isoOf(17), 'C1|' + isoOf(24)]), c1.join(','));
  ok('③-3 台帳の C1 は4件ちょうど', (w.st.ledger.C1 || []).length === 4);
  ok('③-4 C2 は前の実行でマーク済み＝触らない', !w.st.calls.some((x) => x.startsWith('C2|')));
  const nc = noticeOf(w.st, 'C1');
  ok('③-5 お知らせは取り終えた実行で1回（取れていた 11/3 を含む4回）', nc.length === 1 && nc[0].b.length === 4 && nc[0].b.filter((x) => x.already).length === 1 && nc[0].s.length === 0, JSON.stringify(nc));
  ok('③-6 ★保留0で記録が消え、warn も消える', !('LB_AUTOBOOK_HELD' in w.st.props) && warns(w).length === 0, w.st.props.LB_AUTOBOOK_HELD);
  ok('③-7 件数は取り終えた実行で足す（C1 b=4）', (JSON.parse(w.st.props['LB_AUTOBOOK_RESULT_2026-11'] || '{}').C1 || {}).b === 4);
}

console.log('=== ④ 月をまたいでも ===');
{
  //   11/1：対象月は12月。12月分は保留0で終わる。11月分の保留の warn は消えない（記録の対象月で出す）
  const w = world({ rows: afterBusy.rows, props: afterBusy.props, ledger: afterBusy.ledger, startMs: new Date(2026, 10, 1, 6).getTime() });
  w.ctx.autoBookRecurringPatterns();
  const h = JSON.parse(w.st.props.LB_AUTOBOOK_HELD || '{}');
  ok('④-1 ★別の対象月（2026-12）の実行が保留0で終わっても、2026-11 の保留は残る', h['2026-11'] && h['2026-11'].n === 1 && !h['2026-12'], w.st.props.LB_AUTOBOOK_HELD);
  const ws = warns(w);
  ok('④-2 ★月をまたいでも warn が出る（対象月 2026-11）', ws.length === 1 && /対象月 2026-11/.test(ws[0].detail), JSON.stringify(ws));
  //   12月分も保留になった → 2つの月が並ぶ
  const w2 = world({ rows: afterBusy.rows, props: afterBusy.props, ledger: afterBusy.ledger, startMs: new Date(2026, 10, 25, 6).getTime(), busy: (cid) => cid === 'C2' });
  w2.ctx.autoBookRecurringPatterns();
  const ws2 = warns(w2).map((x) => x.detail.slice(0, 11));
  ok('④-3 2つの対象月の保留は別々に出る（上書きしない）', JSON.stringify(ws2) === JSON.stringify(['対象月 2026-11', '対象月 2026-12']), JSON.stringify(ws2));
  ok('④-4 壊れた記録は warn（中身は写さない）', w.ctx.lbAutoBookHeldDailyCheck(() => '{x')[0].key === 'autobook_held_unreadable');
}

console.log('=== ⑤ 4分を過ぎたら ===');
{
  const w = world({ rows: ROWS(), slowReserveMs: 70000 });
  w.ctx.autoBookRecurringPatterns();
  ok('⑤-1 4分を過ぎた後の会員（C2）は試さずに保留（マークなし・お知らせなし・記録）', !w.st.calls.some((x) => x.startsWith('C2|')) && w.st.rows[1][RP_COL.LAST_MONTH - 1] === '' && noticeOf(w.st, 'C2').length === 0 && JSON.parse(w.st.props.LB_AUTOBOOK_HELD)['2026-11'].n === 1, JSON.stringify(w.st.calls));
  const w3 = world({ rows: ROWS(), busy: (cid, iso) => cid === 'C1' && iso === isoOf(3), slowReserveMs: 235000 });
  w3.ctx.autoBookRecurringPatterns();
  ok('⑤-2 4分を過ぎたら取り直さない（sleep しない）', w3.st.sleeps.length === 0 && JSON.parse(w3.st.props.LB_AUTOBOOK_HELD || '{}')['2026-11'], JSON.stringify(w3.st.sleeps));
}

console.log('=== ⑥ トリガーを作らない ===');
{
  const w = world({ rows: ROWS(), busy: (cid) => cid === 'C1' });
  w.ctx.autoBookRecurringPatterns();
  ok('⑥-1 保留があってもトリガーを作らない（取り直しは人が再実行）', w.st.triggers === 0);
}

console.log(`\n${fail ? '❌' : '✅'} 設計47 自動予約の混雑 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
