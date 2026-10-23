// 2026-10-23：会員登録で「契約情報が見つかりません」になる件（開始日がこれから先の契約）を、動かして確かめる。
//   実行: node worker/test/gas-1023.test.js
//
//   ① _lbFindContract：既定は今までどおり（開始前は対象外）。allowFuture のときだけ開始前の契約も対象。終わった契約はどちらも対象外
//   ② selfRegister は allowFuture と電話番号を渡す。失敗は REGISTER_<理由> として記録する（氏名・電話は残さない）
//   ③ 予約の成否の集計（getBookingMetrics）に登録の失敗を混ぜない
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

console.log('=== ① 契約の探し方 ===');
{
  const DAY = 86400000, now = Date.now();
  const iso = (ms) => { const d = new Date(ms); return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() + ' 00:00'; };
  //   列：0 お客様名・1 開始日・2 終了日・3 電話
  const rows = [
    ['新規 花子', iso(now + 6 * DAY), '', '09011112222'],         // これから始まる
    ['終了 太郎', iso(now - 90 * DAY), iso(now - 10 * DAY), '09033334444'],   // 終わった
    ['継続 次郎', iso(now - 30 * DAY), '', '09055556666'],
    ['同名 三郎', iso(now - 30 * DAY), '', '09077778888'],
    ['同名 三郎', iso(now - 20 * DAY), '', '09099990000'],
  ];
  const ctx = { String, Number, JSON, Date, Logger: { log: () => {} },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {} }) },
    _lbContractSheet: () => ({ getLastRow: () => rows.length + 1, getLastColumn: () => 4,
      getRange: (r, c, nr, nc) => ({ getValues: () => (r === 1 ? [['お客様名', '開始日', '終了日', '電話']] : rows) }) }),
    _lbContractCols: () => ({ name: 0, start: 1, end: 2, phone: 3 }),
    _lbParseResvDate: (v) => { const m = String(v).match(/(\d+)\/(\d+)\/(\d+)/); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; },
    _lbNormPhone: (p) => String(p || '').replace(/\D/g, '').replace(/^0/, '') };
  vm.createContext(ctx);
  vm.runInContext(pluckFn(LB, '_lbNormName') + '\n' + pluckFn(LB, '_lbFindContract'), ctx);
  ok('①-1 既定（残数や予約の判定）は開始前の契約を対象にしない＝今までどおり', ctx._lbFindContract('新規 花子') === null);
  const f = ctx._lbFindContract('新規花子様', '090-1111-2222', { allowFuture: true });
  ok('①-2 ★登録の照合（allowFuture）は開始前の契約も見つける', f && f.row[0] === '新規 花子');
  ok('①-3 終わった契約はどちらでも対象外', ctx._lbFindContract('終了 太郎') === null && ctx._lbFindContract('終了 太郎', null, { allowFuture: true }) === null);
  ok('①-4 期間中の契約は今までどおり', ctx._lbFindContract('継続 次郎').row[0] === '継続 次郎');
  ok('①-5 同じ名前は電話が一致する行を優先', ctx._lbFindContract('同名 三郎', '09077778888', { allowFuture: true }).row[3] === '09077778888');
  ok('①-6 allowFuture は true の完全一致だけ', ctx._lbFindContract('新規 花子', null, { allowFuture: 'true' }) === null);
}

console.log('=== ② 登録の配線と失敗の記録 ===');
{
  const sr = pluckFn(LB, 'selfRegister');
  ok('②-1 ★登録は allowFuture と電話を渡して探す', /var c = _lbFindContract\(name, phone, \{ allowFuture: true \}\);/.test(sr));
  ok('②-2 ★既定の呼び出しには allowFuture を付けていない（登録以外の判定を変えない）',
     (LB.match(/allowFuture: true/g) || []).length === 1);
  for (const code of ['NOT_FOUND', 'NO_CONTRACT_PHONE', 'PHONE_MISMATCH', 'AMBIGUOUS_MEMBER', 'VERIFY_REQUIRED']) {
    ok(`②-3 失敗 ${code} を記録する`, new RegExp(`_lbRegFail\\('${code}'`).test(sr));
  }
  const logs = [];
  const ctx = { _lbLogOutcome: (o, ch, d) => logs.push([o, ch, d]) };
  vm.createContext(ctx); vm.runInContext(pluckFn(LB, '_lbRegFail'), ctx);
  const r = ctx._lbRegFail('NOT_FOUND', 'msg');
  ok('②-4 記録は理由のコードだけ（氏名・電話を残さない）・応答は今までどおり', JSON.stringify(logs) === JSON.stringify([['REGISTER_NOT_FOUND', 'selfRegister', '']])
     && r.success === false && r.code === 'NOT_FOUND' && r.message === 'msg');
}

console.log('=== ③ 集計を混ぜない ===');
{
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  const today = day(Date.now());
  const vals = [['t', today, 'OK', 'line'], ['t', today, 'REGISTER_NOT_FOUND', 'selfRegister'], ['t', today, 'REGISTER_NOT_FOUND', 'selfRegister'], ['t', today, 'CONSEC_DRY_OK', 'line']];
  const ctx = { String, Number, Date, isFinite, LB_METRICS_SHEET: 'm', SETTINGS: { TIMEZONE: 'Asia/Tokyo' }, _lbIsFiniteNum: (x) => typeof x === 'number' && isFinite(x),
    Utilities: { formatDate: (d) => day(d.getTime()) }, _lbDateKey: (v) => String(v),
    _lbSheet: () => ({ getLastRow: () => vals.length + 1, getRange: () => ({ getValues: () => vals }) }) };
  vm.createContext(ctx); vm.runInContext(pluckFn(LB, 'getBookingMetrics'), ctx);
  const bm = ctx.getBookingMetrics(1);
  ok('③-1 ★登録の失敗は予約の成否に混ぜない', bm.total === 1 && !bm.byOutcome.REGISTER_NOT_FOUND && bm.register.REGISTER_NOT_FOUND === 2, JSON.stringify(bm));
  ok('③-2 点検に出す（register_fail）', /add\('register_fail', '会員', 'warn', _rgn,/.test(LB));
}

console.log(`\n${fail ? '❌' : '✅'} 10/23 会員登録 検証: ${pass} passed / ${fail} failed`);
if (fail) process.exit(1);
