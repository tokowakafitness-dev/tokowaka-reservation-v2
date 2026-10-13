// 通知が届かなかったとき、相手が何と言ったかを残す（2026-10-13）
//
//   ★なぜ要るのか
//     2026-10-08 と 2026-10-12 に、どちらも **429で4件**のLINEが届かなかった。
//     10-08 のあと待ち時間を 1.2秒→3秒→6秒 の3回に増やしたが、**また同じ4件が落ちた**。
//     ＝**効かなかった対処を繰り返した。** 原因が分かっていないまま直そうとしたため。
//
//     LINEは429の本文に理由を返す（月間上限なのか、短時間の送りすぎなのか）。
//     それを Logger にしか出していなかったので、翌朝の点検では理由が分からなかった。
//
//   実行: node worker/test/notify-fail-detail.test.js

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LB = readFileSync(join(ROOT, 'gas/LineBooking.js'), 'utf8');
const strip = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map((ln) => ln.replace(/\/\/.*$/, '')).join('\n');
const S = strip(LB);

let pass = 0, fail = 0;
function ok(name, cond, why) {
  if (cond) { pass++; return; }
  fail++;
  console.log(`❌ ${name}`);
  if (why) console.log(`   ${why}`);
}

// ---------- 1. 残す ----------
ok('①★相手の応答を記録に残す',
   /_lbLogNotifyFail\('HTTP_' \+ code, purpose, body\)/.test(S),
   '件数だけでは「上限」か「送りすぎ」かが決まらない');
ok('①例外のときも理由を残す',
   /_lbLogNotifyFail\('EXCEPTION', purpose, String\(e && e\.message\)\)/.test(S));
ok('①★5列目に書く（集計を壊さない）',
   /String\(detail == null \? '' : detail\)\.slice\(0, 200\)/.test(S),
   'getBookingMetrics は4列しか読まないので、足しても壊れない');
ok('①長さを切る', /\.slice\(0, 200\)/.test(S));

// ---------- 2. 読む ----------
ok('②理由を読み出す関数がある', /function getNotifyFailDetails\(sinceDays\)/.test(S));
ok('②★新しいものを残す（空で上書きしない）',
   /if \(dt\) out\[rs\] = dt;/.test(S),
   '理由の無い行で、せっかくの理由を消さない');
ok('②列が増えても読める',
   /var w = Math\.max\(5, sh\.getLastColumn\(\)\);/.test(S));

// ---------- 3. 点検のメールに出す ----------
ok('③★点検が理由を載せる',
   /★相手の応答: /.test(S) && /getNotifyFailDetails\(2\)/.test(S),
   '件数だけ報せても、同じ対処を繰り返すことになる');
ok('③記録が無いときは「まだありません」と書く',
   /（理由の記録はまだありません。次回から出ます）/.test(S),
   '空欄だと「理由が無い」のか「仕組みが無い」のか分からない');
ok('③★見出しを「上限」から「上限か送りすぎ」に直した',
   /429=上限か送りすぎ/.test(S),
   '429は上限とは限らない。2026-09-18 に 249\\/5000 で出ている');

// ---------- 4. 既存を壊していない ----------
ok('④集計は4列のまま読む',
   /sh\.getRange\(2, 1, sh\.getLastRow\(\) - 1, 4\)\.getValues\(\)/.test(S),
   '5列目を読み始めると、古い4列の行で落ちる');
ok('④★待ち時間のリトライは残っている',
   /var waits = \[1200, 3000, 6000\];/.test(S),
   '効いていないが、消すと悪化する（成功している回もある）');

console.log(`${fail ? '❌' : '✅'} 通知失敗の理由 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
