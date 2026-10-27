// レンタル→月額へ移る月：レンタルのチケットと月額が同じ月に並ぶ。予約タイトルの種別が正しく付くかを入口から確かめる。
//   実行: node worker/test/rental-to-monthly.test.js
//
// ★なぜ要るのか（2026-10-27）
//   オーナー：「レンタルから月額に入る顧客がいる。11月はレンタルのチケット3枚と月額が同時並行でできるか？精算は？」
//   残数の計算は両方を扱える（FEFO＝11月末で切れるレンタルのチケットから先に使う）。
//   しかし予約タイトルの種別は「開始日が最も新しい有効な契約行」（_lbFindContract）の種別で決めていた。
//     10月中に取る11月の予約 → 月額行（11/1開始）はまだ始まっていない → レンタル行 → レンタル_（正しい）
//     11/1以降に取る予約     → 月額行が最新 → '通常' → レンタル枠を使っても チケット_
//   billing（カレンダー経路）は チケット_ を月額契約と照合して月額単価で計上する（2026-10-05 の照合拡張）。
//   ＝店舗売上とトレーナー報酬が立ち、レンタル料¥2,000が消える。顧客には見えないが、締めの金額が狂う。
//   直し方：予約時に「実際に使ったpackがレンタルか」を割当器から返し、それで種別を決める。
//
//   ① 割当器：レンタルpack＋月額の月で、使ったpackがレンタルかを返す（月額消化は null）
//   ② 入口から：getBookableRemaining（本物）→ 種別。11/1以降（契約行が月額）でもレンタル枠は レンタル_
//   ③ 種別の決め方：使ったpackが分かればそれで決める／分からなければ従来どおり
//   ④ 配線：予約の本体が rem.consumeRental を種別に渡している
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { _lbBookability } from '../src/allocate.js';

const require = createRequire(import.meta.url);
const R = require('../../gas/BookingRules.js');
const P = R._lbBookTypePrefix;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LB = readFileSync(join(ROOT, 'gas/LineBooking.js'), 'utf8');
const AL = readFileSync(join(ROOT, 'gas/Allocate.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, why) { if (cond) pass++; else { fail++; console.log(`❌ ${name}`); if (why) console.log(`   ${why}`); } }
function pluckFn(src, name) {
  const m = src.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('見つからない: ' + name);
  return m[0];
}

const jst = (y, m, d, h = 0) => Date.UTC(y, m - 1, d, h - 9, 0, 0);
const COLS = { method: 0, freq: 1, ticket: 2, type: 3, carry: 4, carryCap: 5, ticketPrice: 6 };
function crow(o) {
  const r = [];
  r[0] = o.method || ''; r[1] = (o.freq === undefined ? '' : o.freq);
  r[2] = (o.ticket == null ? '' : o.ticket); r[3] = o.type || '';
  r[4] = ''; r[5] = ''; r[6] = '';
  return r;
}
//   実データの形：レンタル行＝残数方式チケット・種別レンタル・0円／月額行＝11/1開始
const rentalRow = (qty, from, to) => ({ row: crow({ method: 'チケット', type: 'レンタル', ticket: qty }), cols: COLS, start: new Date(from), end: new Date(to), idx: 0 });
const paidTicketRow = (qty, from, to) => ({ row: crow({ method: 'チケット', type: 'チケット', ticket: qty }), cols: COLS, start: new Date(from), end: new Date(to), idx: 2 });
const monthlyRow = (freq, from) => ({ row: crow({ method: '月額', type: '通常', freq }), cols: COLS, start: new Date(from), end: null, idx: 1 });
const ses = (id, ms) => ({ sessionId: id, resId: id, startAt: ms, channel: 'line', attendeeCount: 1, packKind: 'normal', consumptionMode: '', status: 'confirmed' });

const ROWS = [rentalRow(3, jst(2026, 10, 1), jst(2026, 11, 30)), monthlyRow(4, jst(2026, 11, 1))];
const book = (rows, sessions, nowKey, at) => _lbBookability('C1', rows, sessions, nowKey, at, 0.5, undefined, null, 1, 'normal', true);

console.log('=== ① 割当器：使ったpackがレンタルか ===');
{
  const b = book(ROWS, [], '2026-11', jst(2026, 11, 3, 10));
  ok('①-1 11月最初の予約は予約できる', b.canBook === true);
  ok('①-2 ★11月末で切れるレンタルのチケットから使う（FEFO）', b.consumeType === 'ticket', b.consumeType);
  ok('①-3 ★使ったのはレンタルのpack', b.consumeRental === true, String(b.consumeRental));
  //   レンタル3枚を使い切った後は月額
  const used3 = [3, 4, 5].map((d) => ses('s' + d, jst(2026, 11, d, 10)));
  const b2 = book(ROWS, used3, '2026-11', jst(2026, 11, 20, 10));
  ok('①-4 レンタル3枚の後は月額', b2.canBook === true && b2.consumeType === 'monthly', b2.consumeType);
  ok('①-5 月額のときは見ない（null）', b2.consumeRental === null, String(b2.consumeRental));
  //   11月に取れる合計は 3＋4＝7回
  const used7 = [3, 4, 5, 6, 7, 8, 9].map((d) => ses('s' + d, jst(2026, 11, d, 10)));
  ok('①-6 ★11月はレンタル3＋月額4＝7回まで', book(ROWS, used7.slice(0, 6), '2026-11', jst(2026, 11, 25, 10)).canBook === true
     && book(ROWS, used7, '2026-11', jst(2026, 11, 25, 10)).canBook === false);
  //   有料の追加チケット（種別チケット）は false
  const rowsPaid = [paidTicketRow(3, jst(2026, 10, 1), jst(2026, 11, 30)), monthlyRow(4, jst(2026, 11, 1))];
  const b3 = book(rowsPaid, [], '2026-11', jst(2026, 11, 3, 10));
  ok('①-7 有料チケットを使ったときは false', b3.consumeType === 'ticket' && b3.consumeRental === false, b3.consumeType + '/' + b3.consumeRental);
  //   予約できないときは null
  ok('①-8 予約できないときは null', book(ROWS, used7, '2026-11', jst(2026, 11, 25, 10)).consumeRental === null);
}

console.log('=== ② 入口から：getBookableRemaining（本物）→ 種別 ===');
function runGBR(rows, sessions, nowMs, at) {
  const ctx = { Math, JSON, Object, String, Number, isFinite, isNaN, Array,
    Date: class extends Date { constructor(...a) { if (a.length === 0) super(nowMs); else super(...a); } static now() { return nowMs; } },
    Logger: { log: () => {} }, LINE_BOOKING: { CARRYOVER_RATE: 0.5 },
    _lbContractRowsAll: () => rows, _lbPhoneByCustomerId: () => '', _lbResvSessions: () => sessions,
    _lbMemberOpeningWithFloor: () => null };
  vm.createContext(ctx);
  vm.runInContext(AL.replace(/if \(typeof module[\s\S]*$/, '') + '\n' + pluckFn(LB, '_lbMonthlyResumesAfter') + '\n' + pluckFn(LB, 'getBookableRemaining'), ctx);
  return ctx.getBookableRemaining('C1', '', 'テスト', at);
}
{
  //   11/2 に 11/3 の予約を取る＝契約行の最新は月額（ct='通常'）。これが壊れていた経路
  const rem = runGBR(ROWS, [], jst(2026, 11, 2, 12), jst(2026, 11, 3, 10));
  ok('②-1 予約できる', rem.ok === true, JSON.stringify(rem).slice(0, 200));
  ok('②-2 ★消化はチケット・使ったのはレンタル', rem.consumeType === 'ticket' && rem.consumeRental === true, rem.consumeType + '/' + rem.consumeRental);
  ok('②-3 月額の種別は通常', rem.monthlyType === '通常');
  const pfx = P('line', rem.packKind, '通常', rem.consumeType, rem.monthlyType, rem.consumeRental);
  ok('②-4 ★11/1以降に取ってもレンタル枠は レンタル_', pfx === 'レンタル_', pfx);
  ok('②-5 （直す前の呼び方なら チケット_ になっていた）', P('line', rem.packKind, '通常', rem.consumeType, rem.monthlyType) === 'チケット_');
  //   レンタルを使い切った後の予約は月額＝通常_
  const used3 = [3, 4, 5].map((d) => ses('s' + d, jst(2026, 11, d, 10)));
  const rem2 = runGBR(ROWS, used3, jst(2026, 11, 2, 12), jst(2026, 11, 20, 10));
  ok('②-6 レンタルを使い切った後は 通常_', P('line', rem2.packKind, '通常', rem2.consumeType, rem2.monthlyType, rem2.consumeRental) === '通常_', rem2.consumeType);
  //   10月中に11月を取る（月額行は未開始＝ct はレンタル）も レンタル_
  const rem3 = runGBR(ROWS, [], jst(2026, 10, 27, 12), jst(2026, 11, 3, 10));
  ok('②-7 10月中に取る11月の予約も レンタル_', P('line', rem3.packKind, 'レンタル', rem3.consumeType, rem3.monthlyType, rem3.consumeRental) === 'レンタル_', rem3.consumeType + '/' + rem3.consumeRental);
}

console.log('=== ③ 種別の決め方 ===');
ok('③-1 使ったpackがレンタル → レンタル_（契約行が通常でも）', P('line', 'normal', '通常', 'ticket', '通常', true) === 'レンタル_');
ok('③-2 ★レンタル会員が有料チケットを使った → チケット_', P('line', 'normal', 'レンタル', 'ticket', '', false) === 'チケット_');
ok('③-3 分からない（null）→ 従来どおり（契約行レンタル）', P('line', 'normal', 'レンタル', 'ticket', '', null) === 'レンタル_');
ok('③-4 分からない（undefined）→ 従来どおり（契約行通常）', P('line', 'normal', '通常', 'ticket', '通常') === 'チケット_');
ok('③-5 月額の消化は使ったpackを見ない', P('line', 'normal', 'レンタル', 'monthly', '通常', true) === '通常_');
ok('③-6 振替・ペアが優先', P('transfer', 'normal', '通常', 'ticket', '', true) === '振替_' && P('line', 'pair', '通常', 'ticket', '', true) === 'ペア_');

console.log('=== ④ 配線 ===');
{
  const core = pluckFn(LB, '_lbReserveCoreImpl');
  ok('④-1 予約の本体が rem.consumeRental を種別に渡す', /_rentalPack\s*=\s*\(typeof rem !== 'undefined' && rem\) \? rem\.consumeRental/.test(core)
     && /_lbBookTypePrefix\(channel, _kind, ct, _consume, _mct, _rentalPack\)/.test(core));
  ok('④-2 getBookableRemaining が consumeRental を返す', /consumeRental: b\.consumeRental/.test(pluckFn(LB, 'getBookableRemaining')));
}

console.log((fail === 0 ? '✅ ' : '⚠️ ') + `レンタル→月額の月 検証: ${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
