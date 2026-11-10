// 2026-11-10：契約の終了日を「その日の日本時間 23:59:59.999 まで有効」にした（以前は終了日の 0時で外れていた）。
//   実行: node worker/test/contract-end-day.test.js
//
//   ① _lbFindContract：終了日の当日（昼・23:59）は有効・翌日 0時を過ぎたら外れる
//   ② 月の境目：チケット行（〜11/30）と月額行（12/1〜）。11/30 はチケット行・12/1 は月額行（重ならない・空かない）
//   ③ _lbContractRows：同じ境目
//   ④ 終了日のセルに時刻（23:59）が入っていても、翌日まで延びない
//   ⑤ 月額の種別（予約日時と終了日）：終了日の夜の予約も月額として数える（4441行の比較）
//   ★文字列は架空（実在の会員の名前を書かない）
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LB = readFileSync(join(ROOT, 'gas/LineBooking.js'), 'utf8');
let pass = 0, fail = 0;
function ok(name, cond, why) { if (cond) pass++; else { fail++; console.log(`❌ ${name}`); if (why) console.log(`   ${why}`); } }
function pluckFn(src, name) {
  const m = src.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('見つからない: ' + name);
  return m[0];
}

const H = 3600000, DAY = 86400000;
//   日本時間の y/m/d h:mi を UTC のミリ秒で作る（端末の時間帯に依らない）
const jst = (y, m, d, h = 0, mi = 0, s = 0) => Date.UTC(y, m - 1, d, h, mi, s) - 9 * H;

function ctxAt(nowMs, rows) {
  class FD extends Date {
    constructor(...a) { if (a.length === 0) super(nowMs); else super(...a); }
    static now() { return nowMs; }
  }
  const ctx = { String, Number, JSON, Math, Date: FD, Logger: { log: () => {} },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {} }) },
    _lbContractSheet: () => ({ getLastRow: () => rows.length + 1, getLastColumn: () => 5,
      getRange: (r) => ({ getValues: () => (r === 1 ? [['お客様名', '開始日', '終了日', '電話', '種別']] : rows) }) }),
    _lbContractCols: () => ({ name: 0, start: 1, end: 2, phone: 3, type: 4 }),
    //   セルは日付型で返る想定（そのまま Date）
    _lbParseResvDate: (v) => (v instanceof Date ? v : (v === '' || v == null ? null : new Date(v))),
    _lbNormPhone: (p) => String(p || '').replace(/\D/g, '') };
  vm.createContext(ctx);
  vm.runInContext(['_lbNormName', '_lbEndOfJstDayMs', '_lbFindContract', '_lbContractRows'].map((n) => pluckFn(LB, n)).join('\n'), ctx);
  return ctx;
}
const D = (ms) => new Date(ms);

console.log('=== ① 終了日の当日 ===');
{
  const rows = [['月末 太郎', D(jst(2026, 11, 1)), D(jst(2026, 11, 30)), '09011110000', 'チケット']];
  ok('①-1 ★終了日の当日 15:00 は有効（以前は 0時で外れていた）', !!ctxAt(jst(2026, 11, 30, 15), rows)._lbFindContract('月末 太郎'));
  ok('①-2 終了日の当日 23:59:30 も有効', !!ctxAt(jst(2026, 11, 30, 23, 59, 30), rows)._lbFindContract('月末 太郎'));
  ok('①-3 翌日 0:00:01 は外れる', ctxAt(jst(2026, 12, 1, 0, 0, 1), rows)._lbFindContract('月末 太郎') === null);
}

console.log('=== ② 月の境目（チケット〜11/30・月額 12/1〜） ===');
{
  const rows = [
    ['境目 花子', D(jst(2026, 11, 10)), D(jst(2026, 11, 30)), '09022220000', 'チケット'],
    ['境目 花子', D(jst(2026, 12, 1)), D(jst(2027, 5, 31)), '09022220000', '通常'],
  ];
  const a = ctxAt(jst(2026, 11, 30, 20), rows)._lbFindContract('境目 花子');
  ok('②-1 ★11/30 の夜はチケット行（契約が無い時間が無い）', a && a.row[4] === 'チケット', JSON.stringify(a && a.row));
  const b = ctxAt(jst(2026, 12, 1, 7), rows)._lbFindContract('境目 花子');
  ok('②-2 12/1 の朝は月額行', b && b.row[4] === '通常', JSON.stringify(b && b.row));
}

console.log('=== ③ _lbContractRows（全部の有効な行） ===');
{
  const rows = [
    ['境目 花子', D(jst(2026, 11, 10)), D(jst(2026, 11, 30)), '09022220000', 'チケット'],
    ['境目 花子', D(jst(2026, 12, 1)), D(jst(2027, 5, 31)), '09022220000', '通常'],
  ];
  const a = ctxAt(jst(2026, 11, 30, 20), rows)._lbContractRows('境目 花子', '09022220000');
  ok('③-1 ★11/30 の夜はチケット行が入る（以前は0行）', a.length === 1 && a[0].row[4] === 'チケット', JSON.stringify(a.map((x) => x.row[4])));
  const b = ctxAt(jst(2026, 12, 1, 0, 0, 1), rows)._lbContractRows('境目 花子', '09022220000');
  ok('③-2 12/1 0:00:01 は月額行だけ', b.length === 1 && b[0].row[4] === '通常', JSON.stringify(b.map((x) => x.row[4])));
}

console.log('=== ④ セルに時刻が入っている ===');
{
  const rows = [['時刻 次郎', D(jst(2026, 11, 1)), D(jst(2026, 11, 30, 23, 59)), '09033330000', 'チケット']];
  ok('④-1 終了日 23:59 のセル：翌日 0:30 には外れる（翌日まで延びない）', ctxAt(jst(2026, 12, 1, 0, 30), rows)._lbFindContract('時刻 次郎') === null);
  ok('④-2 同じセル：当日 23:59:50 は有効', !!ctxAt(jst(2026, 11, 30, 23, 59, 50), rows)._lbFindContract('時刻 次郎'));
  const ctx = ctxAt(0, []);
  ok('④-3 _lbEndOfJstDayMs は 0時と 23:59 のどちらも同じ当日の終わり', ctx._lbEndOfJstDayMs(D(jst(2026, 11, 30))) === jst(2026, 12, 1) - 1 && ctx._lbEndOfJstDayMs(D(jst(2026, 11, 30, 23, 59))) === jst(2026, 12, 1) - 1);
}

console.log('=== ⑤ 月額の種別（予約日時と終了日） ===');
{
  //   4441行の比較を本番のコードから取り出して、同じ式で確かめる（配線：式が書き換わっていれば落ちる）
  ok('⑤-1 ★予約の種別の比較は当日の終わりで比べる', /if \(_rr\.end && _lbEndOfJstDayMs\(_rr\.end\) < tMs\) continue;/.test(LB));
  ok('⑤-2 ★終了日の 0時と比べる形が残っていない（3か所とも直した）', !/end\.getTime\(\) < now\) continue;/.test(LB) && !/_rr\.end\.getTime\(\) < tMs/.test(LB));
}

console.log('=== ⑥ 本物の _lbParseResvDate を通す（文字列のセル・日付型のセル） ===');
{
  //   GAS のスクリプトの時間帯は Asia/Tokyo（appsscript.json）。この検査を走らせる端末が日本時間のときだけ、文字列の解釈を確かめる
  if (new Date(2026, 10, 30).getTimezoneOffset() !== -540) console.log('   （端末が日本時間でないため ⑥ は飛ばします）');
  else {
    const real = (rows) => { const c = ctxAt(0, rows); return c; };
    const mk = (nowMs, rows) => {
      class FD extends Date { constructor(...a) { if (a.length === 0) super(nowMs); else super(...a); } static now() { return nowMs; } }
      const ctx = { String, Number, JSON, Math, Date: FD, Logger: { log: () => {} },
        CacheService: { getScriptCache: () => ({ get: () => null, put: () => {} }) },
        _lbContractSheet: () => ({ getLastRow: () => rows.length + 1, getLastColumn: () => 5, getRange: (r) => ({ getValues: () => (r === 1 ? [['お客様名', '開始日', '終了日', '電話', '種別']] : rows) }) }),
        _lbContractCols: () => ({ name: 0, start: 1, end: 2, phone: 3, type: 4 }),
        _lbNormPhone: (p) => String(p || '').replace(/\D/g, '') };
      vm.createContext(ctx);
      vm.runInContext(['_lbNormName', '_lbEndOfJstDayMs', '_lbParseResvDate', '_lbFindContract'].map((n) => pluckFn(LB, n)).join('\n'), ctx);
      return ctx;
    };
    for (const [label, endCell] of [['文字列 2026/11/30', '2026/11/30'], ['文字列 2026/11/30 00:00', '2026/11/30 00:00'], ['日付型', new Date(2026, 10, 30)]]) {
      const rows = [['本物 四郎', '2026/11/01', endCell, '09044440000', 'チケット']];
      ok('⑥ ' + label + '：当日 20時は有効', !!mk(jst(2026, 11, 30, 20), rows)._lbFindContract('本物 四郎'));
      ok('⑥ ' + label + '：翌日 0:00:01 は外れる', mk(jst(2026, 12, 1, 0, 0, 1), rows)._lbFindContract('本物 四郎') === null);
    }
  }
  ok('⑦ 診断（testLbRegistrationReadiness）も当日の終わりで比べる', /var endOk = !end \|\| _lbEndOfJstDayMs\(end\) >= now;/.test(LB));
}

console.log(`\n${fail ? '❌' : '✅'} 契約の終了日（当日の終わりまで有効） 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
