// 2026-10-14 朝の点検で見つかった2つの穴を固定する。
//   実行: node worker/test/health-1014.test.js
//
// ① 未登録のお客様の仮押さえ（makeAdminBooking・channel：admin_hold）を「担当calの残骸」と誤報していた。
//    施設cal側は説明欄で除外していたのに、トレーナーcal側は見ていなかった（10/22 野崎様・10/29 名取様）。
// ② 二重書きの待ち行列の処理が、失敗した会員と理由を記録に残していなかった（実行ログだけ）。
//    18時間残った1名が誰でなぜかを、別の窓口から探す必要があった（検証用の会員の登録日時が空だった）。

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LB = readFileSync(join(ROOT, 'gas/LineBooking.js'), 'utf8');
const PE = readFileSync(join(ROOT, 'gas/PushToEdge.js'), 'utf8');
let pass = 0, fail = 0;
function ok(name, cond, why) {
  if (cond) { pass++; return; }
  fail++; console.log(`❌ ${name}`); if (why) console.log(`   ${why}`);
}
function pluckFn(src, name) {
  const m = src.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('見つからない: ' + name);
  return m[0];
}

console.log('=== ① 仮押さえを残骸と呼ばない ===');
{
  const f = pluckFn(LB, 'debugOrphanEvents');
  ok('①-1 施設cal側は admin_hold を除外している（前から）', /if \(desc\.indexOf\('admin_hold'\) >= 0\) \{ hold\+\+; continue; \}/.test(f));
  ok('①-2 ★トレーナーcal側も admin_hold を除外する',
     /var _td = ''; try \{ _td = String\(tEvs\[x\]\.getDescription\(\) \|\| ''\); \} catch \(eD\) \{\}\s*if \(_td\.indexOf\('admin_hold'\) >= 0\) continue;\s*orphanTr\.push/.test(f),
     'トレーナーが取った新規体験の仮押さえを「残骸」と報告していた');
  ok('①-3 説明欄を読むのは台帳に無いものだけ（全予定で読まない＝点検を重くしない）',
     f.indexOf('if (!ledger[kt]) {') > 0 && f.indexOf('if (!ledger[kt]) {') < f.indexOf('var _td'));
  const mk = pluckFn(LB, 'makeAdminBooking');
  ok('①-4 仮押さえはトレーナーcalにも admin_hold の説明欄を付けて作る（除外の前提）',
     /channel：admin_hold/.test(mk) && /tcal\.createEvent\([^)]*\{ description: desc \}\)/.test(mk));
}

console.log('=== ② 二重書きの失敗した会員と理由を残す ===');
{
  const ctx = {
    String, Number, JSON, Object, Array, Math, Date,
    Logger: { log: () => {} },
    _lbMemberOpeningWithFloor: () => null,
    _lbDwMonthKeyAhead: () => '2026-12', _lbDwMaxResvMonth: () => null, _edgeNameByCustomerId: () => 'x',
    _edgeProp: () => 'https://x',
    LB_DW: { MONTHS_AHEAD: 2 },
    UrlFetchApp: { fetch: () => { throw new Error('should not fetch'); } },
  };
  vm.createContext(ctx);
  //   2026-10-20 設計20：_edgeQuotaBuildOne は消した。_edgeRebuildOne が同じ理由を残す
  vm.runInContext("var _LB_DW_WHY = '';\n" + pluckFn(PE, '_edgeRebuildOne'), ctx);
  const r = ctx._edgeRebuildOne('CVERIFY0000001', [], 5);
  ok('②-1 ★記録開始月が無ければ、理由 NO_RECORDS_FROM を残して失敗', r === 'FAIL' && /^NO_RECORDS_FROM/.test(ctx._LB_DW_WHY), ctx._LB_DW_WHY);
  const d = pluckFn(PE, 'lbDualWriteDrain');
  ok('②-2 会員ごとに理由を空にしてから処理する（前の会員の理由を引き継がない）', /_LB_DW_WHY = '';\s*var rb = 'ERROR';/.test(d));
  ok('②-3 ★失敗した会員と理由を記録に残す（最大5名）', /if \(failedWho\.length < 5\) failedWho\.push\(cid \+ ':' \+ \(_LB_DW_WHY \|\| '\?'\)\);/.test(d)
     && /failed: failed, failedWho: failedWho,/.test(d));
  ok('②-4 状態表示に出る', /失敗した会員と理由: ' \+ last\.failedWho\.join/.test(pluckFn(PE, 'lbDualWriteStatusText')));
  ok('②-5 ★点検（メール）にも出る', /直近の失敗: ' \+ l\.failedWho\.join/.test(pluckFn(PE, 'lbDwDailyCheck')));
}

console.log('');
console.log(`${fail ? '❌' : '✅'} 10/14 の点検の穴 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
