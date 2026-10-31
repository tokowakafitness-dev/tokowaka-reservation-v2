// 予約できる最終日（25日以降は翌月末）より先の予約を、本人の操作ならサーバーで止めるかを確かめる（設計25）。
//   実行: node worker/test/booking-horizon-gate.test.js
//
// ★なぜ要るのか（2026-10-31）
//   画面は最終日より先を灰色で押せなくした（オーナー：先も表示してよい・予約はできないこと）。
//   サーバー（_lbReserveCoreImpl）は最終日を見ておらず、画面を通さなければ先の予約も作れた。
//   一方、繰り返し予約の2回目以降・固定枠の自動予約・代行は先を作る必要がある（同じ channel 'line' を通る）。
//
//   ① 判定の本体：_lbReserveCoreImpl（本物）に印つき／印なしで最終日の前後を渡す
//   ② 入口：単発・まとめて（本人）は印つき、代行は印なし。body に印を入れても効かない
//   ③ 繰り返し：1回目が先なら1件も作らない／2回目以降も先の回は作らない（2026-10-31 オーナー指摘）・件数を分けて返す
//   ④ 振替：先なら振替権を使わずに止める
//   ⑤ 変更：本人のときだけ印（トレーナーが他人の予約を変えるときは付けない）
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

process.env.TZ = 'Asia/Tokyo';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LB = readFileSync(join(ROOT, 'gas/LineBooking.js'), 'utf8');
const BR = readFileSync(join(ROOT, 'gas/BookingRules.js'), 'utf8');
const HTML = readFileSync(join(ROOT, 'liff/index.html'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, why) { if (cond) pass++; else { fail++; console.log(`❌ ${name}`); if (why) console.log(`   ${why}`); } }
function pluck(src, name) {
  const m = src.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('見つからない: ' + name);
  return m[0];
}
const MAP_COL_SRC = LB.match(/var MAP_COL = \{[\s\S]*?\n\};/)[0];

const NOW = new Date(2026, 9, 31, 10).getTime();            // 10/31 10:00 JST → 最終日 11/30
const LAST_OK = new Date(2026, 10, 30, 23, 0).toISOString(); // 11/30 23:00
const FIRST_NG = new Date(2026, 11, 1, 0, 0).toISOString();  // 12/1 0:00
const MID = new Date(2026, 10, 10, 10).toISOString();        // 11/10
class FakeDate extends Date { constructor(...a) { if (a.length === 0) super(NOW); else super(...a); } static now() { return NOW; } }
const PASSED = 'PASSED_GATE';
let ctxGate = () => null;

// ---------- ① 判定の本体 ----------
function core(custInfo, startISO, channel) {
  const ctx = {
    Date: FakeDate, Math, String, Number, isNaN, SETTINGS: { SESSION_MINUTES: 60 },
    _lbBookingGate: () => ({ ok: true }), _lbTrainerById: () => ({ id: 't1' }),
    _lbBookingOpen: () => true, _lbBookingCfg: () => ({}), _lbBookingDeadlineText: () => '',
    LockService: { getScriptLock: () => { throw new Error(PASSED); } },   // 関門を越えたらここで止める
  };
  vm.createContext(ctx);
  vm.runInContext([pluck(LB, '_lbBookingHorizonEnd'), pluck(LB, '_lbHorizonGate'), pluck(LB, '_lbReserveCoreImpl')].join('\n'), ctx);
  try { return ctx._lbReserveCoreImpl(custInfo, { trainerId: 't1', startISO }, channel); } catch (e) { return { passed: e.message === PASSED, err: e.message }; }
}
console.log('=== ① 判定の本体 ===');
{
  const ng = core({ customerId: 'c1', enforceHorizon: true }, FIRST_NG, 'line');
  ok('①-1 ★印つき・12/1 0:00 は止める', ng.code === 'NOT_OPEN_YET', JSON.stringify(ng));
  ok('①-2 案内は「12月1日のご予約は、11月25日から」', ng.message === '12月1日のご予約は、11月25日から受け付けます。', ng.message);
  ok('①-3 印つき・11/30 23:00 は通す', core({ customerId: 'c1', enforceHorizon: true }, LAST_OK, 'line').passed === true);
  ok('①-4 ★印なし（自動予約・代行）・12/1 は通す', core({ customerId: 'c1' }, FIRST_NG, 'line').passed === true);
  ok('①-5 印が true 以外（文字列）は効かない＝本人の印は真偽値だけ', core({ customerId: 'c1', enforceHorizon: 'yes' }, FIRST_NG, 'line').passed === true);
}

// ---------- ②〜④ 入口 ----------
function entry(fnNames, call, { coreImpl, extra = {} } = {}) {
  const seen = []; let creditUsed = false;
  const mapRow = ['U1', 'c1', '会員', '', '', '通常', 'active', 'verified'];
  const ctx = {
    Date: FakeDate, Math, String, Number, isNaN, JSON, Logger: { log: () => {} },
    LB_BATCH_MAX: 10,
    getCustomerByLine: () => ({ data: mapRow }), _lbContractTypeOf: () => '通常',
    _lbContractRowsAll: () => [{ start: new Date(2026, 0, 1), end: null }], _lbPhoneByCustomerId: () => '', _lbInSomeContractPeriod: () => true,
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {}, hasLock: () => true }) },
    SpreadsheetApp: { flush: () => {} },
    _lbUseTransferCredit: () => { creditUsed = true; return { ok: true, rowIndex: 2 }; }, _lbRevertTransferCredit: () => {},
    _lbNotifyBatch: () => {}, _lbNotifyRecurring: () => {},
    _lbReserveCore: (ci, body, ch) => { seen.push({ flag: ci.enforceHorizon, startISO: body.startISO, ch }); return coreImpl ? coreImpl(ci, body) : { success: true }; },
    ...extra,
  };
  vm.createContext(ctx);
  vm.runInContext([MAP_COL_SRC, pluck(LB, '_lbBookingHorizonEnd'), pluck(LB, '_lbHorizonGate'), pluck(BR, '_lbRecurringStartMs'),
    pluck(LB, '_lbContractEndOfDayMs'), ...fnNames.map((n) => pluck(LB, n))].join('\n'), ctx);
  const r = call(ctx);
  return { r, seen, creditUsed };
}
console.log('=== ② 単発・まとめて・代行 ===');
{
  const a = entry(['makeReservationLine'], (c) => c.makeReservationLine('U1', { trainerId: 't1', startISO: MID, enforceHorizon: false }));
  ok('②-1 ★単発（本人）は印つき・body の false で外れない', a.seen.length === 1 && a.seen[0].flag === true, JSON.stringify(a.seen));
  const b = entry(['_lbBatchReserve', 'makeBatchReservationLine'], (c) => c.makeBatchReservationLine('U1', { items: [{ trainerId: 't1', startISO: MID }, { trainerId: 't1', startISO: FIRST_NG }] }));
  ok('②-2 ★まとめて（本人）は全件に印', b.seen.length === 2 && b.seen.every((x) => x.flag === true), JSON.stringify(b.seen));
  //   代行：入口は名簿の読み方が別なので、印を付けないことを本文で確かめる
  const proxy = pluck(LB, 'makeReservationLineProxy') + pluck(LB, 'makeBatchReservationLineProxy');
  ok('②-3 代行（単発・まとめて）は印を付けない', !/enforceHorizon/.test(proxy));
  const auto = pluck(LB, 'autoBookRecurringPatterns');
  ok('②-4 固定枠の自動予約は印を付けない', !/enforceHorizon/.test(auto));
}
console.log('=== ③ 繰り返し ===');
{
  //   ★2026-10-31 お客様向けは廃止。本番の値は false で、何も作らない
  ok('③-0a ★本番のスイッチは false', /\nvar LB_CUSTOMER_RECURRING = false;/.test(LB));
  const off = entry(['makeRecurringReservationLine'], (c) => c.makeRecurringReservationLine('U1', { trainerId: 't1', startISO: MID, repeatCount: 4 }), { extra: { LB_CUSTOMER_RECURRING: false } });
  ok('③-0b ★スイッチ false → RECURRING_DISABLED・1件も作らない', off.r.code === 'RECURRING_DISABLED' && off.seen.length === 0, JSON.stringify(off));
  ok('③-0c ★画面：選択欄のスイッチは false', /var SHOW_CUSTOMER_REPEAT = false;/.test(HTML));
  const guard = HTML.indexOf("if (!SHOW_CUSTOMER_REPEAT || state.packKind === 'pair') return;"), build = HTML.indexOf("rc.id='cfRepeatWrap'");
  ok('③-0d ★画面：選択欄を作る前でスイッチが止める', guard > 0 && build > guard && build - guard < 400, `${guard} / ${build}`);
  //   以下はスイッチを戻したとき（中身の検査を残す）
  const ng = entry(['makeRecurringReservationLine'], (c) => c.makeRecurringReservationLine('U1', { trainerId: 't1', startISO: FIRST_NG, repeatCount: 4 }), { extra: { LB_CUSTOMER_RECURRING: true } });
  ok('③-1 ★1回目が 12/1 → 1件も作らない', ng.r.code === 'NOT_OPEN_YET' && ng.seen.length === 0, JSON.stringify({ r: ng.r, seen: ng.seen }));
  //   各回は本物の関門で判定する（核の代わりに _lbHorizonGate を印つきで当てる）
  const coreLike = (ci, body) => (ci.enforceHorizon === true && ctxGate(body.startISO)) || { success: true };
  const okk = entry(['makeRecurringReservationLine'], (c) => { ctxGate = (iso) => c._lbHorizonGate(new Date(iso).getTime()); return c.makeRecurringReservationLine('U1', { trainerId: 't1', startISO: new Date(2026, 10, 23, 10).toISOString(), repeatCount: 4 }); }, { coreImpl: coreLike, extra: { LB_CUSTOMER_RECURRING: true } });
  ok('③-2 ★全回に印', okk.seen.length === 4 && okk.seen.every((x) => x.flag === true), JSON.stringify(okk.seen));
  ok('③-3 ★11/23・11/30 は作る、12/7・12/14 は作らない', okk.r.createdCount === 2 && okk.r.skippedCount === 2, JSON.stringify(okk.r));
  ok('③-4 先の回は NOT_OPEN_YET として数える', okk.r.notOpenCount === 2 && okk.r.skipped.every((x) => x.code === 'NOT_OPEN_YET'), JSON.stringify(okk.r.skipped));
}
console.log('=== ④ 振替 ===');
{
  const ng = entry(['_lbInSomeContractPeriod', 'makeTransferReservationLine'], (c) => c.makeTransferReservationLine('U1', { trainerId: 't1', startISO: FIRST_NG }));
  ok('④-1 ★12/1 → 止める', ng.r.code === 'NOT_OPEN_YET', JSON.stringify(ng.r));
  ok('④-2 ★振替権を使わない', ng.creditUsed === false && ng.seen.length === 0);
  const okk = entry(['_lbInSomeContractPeriod', 'makeTransferReservationLine'], (c) => c.makeTransferReservationLine('U1', { trainerId: 't1', startISO: MID }));
  ok('④-3 11/10 → 印つきで予約へ', okk.seen.length === 1 && okk.seen[0].flag === true && okk.seen[0].ch === 'transfer', JSON.stringify(okk.seen));
}
console.log('=== ⑤ 変更 ===');
{
  //   変更の入口は台帳・カレンダーに広く触るため、本人判定が連続ルールと同じ式であることを本文で固定する
  const ch = pluck(LB, 'changeReservationLine');
  ok('⑤-1 ★本人のときだけ印（予約の持ち主の LINE と操作者が一致）', /enforceHorizon:\s*\(String\(r\[3\]\) === String\(lineUserId\)\)/.test(ch));
  ok('⑤-2 連続ルールと同じ判定', /consecRule:\s*\(String\(r\[3\]\) === String\(lineUserId\)\)/.test(ch));
}

console.log((fail === 0 ? '✅ ' : '⚠️ ') + `最終日より先の予約（サーバー） 検証: ${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
