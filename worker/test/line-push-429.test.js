// LINEの送信が 429（短時間に送りすぎ）で落ちないようにする守りを固定する。
//   実行: node worker/test/line-push-429.test.js
//
// ★なぜ要るのか（2026-10-09・日次点検が見つけた）
//   2026-10-08に顧客へのLINEが4件届かなかった（HTTP_429）。
//   月の枠は 5,000通中162通＝97%余っていたので、**月間上限ではなく集中送信**が原因。
//   前日リマインドやリマインドは対象者へ連続で送るため、ここで弾かれる。
//   429は「送れていない」＝顧客に届かない。粘る価値がある。

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const LB = readFileSync(join(ROOT, 'gas/LineBooking.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  cond ? pass++ : (fail++, console.log(`❌ ${name}${extra ? '\n   ' + extra : ''}`));
}

console.log('=== 1. そもそも429を出さない（送る側で間隔を空ける）===');
ok('①最小の間隔が定数で決まっている', /var LB_PUSH_MIN_GAP_MS = 260;/.test(LB));
ok('①★前回の送信からの間隔を見て、足りないぶんだけ待つ',
  /if \(_gap >= 0 && _gap < LB_PUSH_MIN_GAP_MS\) Utilities\.sleep\(LB_PUSH_MIN_GAP_MS - _gap\)/.test(LB),
  '固定で待つと、単発の予約通知まで毎回遅くなる');
ok('①1件目は待たない', /if \(_LB_PUSH_LAST_MS\) \{/.test(LB),
  '単発の予約通知を遅くしない');
ok('①送った時刻を覚える', /_LB_PUSH_LAST_MS = Date\.now\(\);/.test(LB));
ok('①実行時間への影響を書いている', /6分の制限に対して十分小さい/.test(LB));

console.log('=== 2. それでも429なら粘る ===');
ok('②★待ち時間を段階的に伸ばす', /var waits = \[1200, 3000, 6000\];/.test(LB),
  '1.2秒で1回だけでは足りなかった（2026-10-08に4件落ちた）');
ok('②3回まで送り直す', /for \(var wi = 0; wi < waits\.length; wi\+\+\)/.test(LB));
ok('②★429以外は待っても直らないので打ち切る',
  /if \(c2 !== 429\) break;/.test(LB),
  '401（トークン失効）や403（ブロック）は待っても通らない');
ok('②何回目で成功したかを残す', /回目・' \+ waits\[wi\] \+ 'ms待ち/.test(LB));
ok('②★3回でも届かなければ、用途つきで残す',
  /3回送り直しても届きませんでした（用途: /.test(LB),
  '何の通知が届かなかったかが分からないと、人が代わりに連絡できない');

console.log('=== 3. 届かなかったことが点検に出る ===');
ok('③未達を high で出す', /add\('notify_fail', '通知', 'high'/.test(LB));
ok('③★用途も出す', /nf\.byPurpose/.test(LB) && /用途: /.test(LB));
ok('③送り直しが必要だと書いている', /送り直さないと届きません/.test(LB));

console.log('');
console.log(`${fail ? '❌' : '✅'} LINEの429対策 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
