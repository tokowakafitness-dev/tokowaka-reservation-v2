// トリガーの安全（2026-10-09・Codex関門①で発覚）
//
//   ★何が危なかったか
//     `setupTriggers()` は作られた当時トリガーが3本しか無かった。いまは18本ある。
//     `getProjectTriggers()` を**名前で絞らずに全部消し、3本しか戻さない。**
//     実行すると押し出し・作業依頼・カレンダー同期・うながし・固定枠の自動予約・
//     日次点検が丸ごと止まる＝顧客の残数が固まり、リマインドが届かない。
//
//     ★そして**日次点検が「setupTriggers を実行し直すと戻ります」と案内していた。**
//       案内どおりに実行すると大事故になる。
//
//   実行: node worker/test/trigger-safety.test.js

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const rd = (p) => readFileSync(join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) { cond ? pass++ : (fail++, console.log(`❌ ${name}${extra ? '\n   ' + extra : ''}`)); }

const CODE = rd('gas/コード.js');
const LB = rd('gas/LineBooking.js');

// ---------- 1. 全部消す関数が実行できないこと ----------
ok('①★setupTriggers は実行を拒否する',
   /function setupTriggers\(\) \{[\s\S]{0,900}?throw new Error\(msg\);/.test(CODE),
   '名前で絞らずに全部消し、3本しか戻さない');
ok('①★全部消すループが残っていない',
   !/function setupTriggers\(\) \{\n  var triggers = ScriptApp\.getProjectTriggers\(\);\n  for \(var i = 0; i < triggers\.length; i\+\+\) ScriptApp\.deleteTrigger\(triggers\[i\]\);/.test(CODE));
ok('①代わりの関数は名前で絞る',
   /function setupBasicTriggersOnly\(\)/.test(CODE)
   && /if \(names\[all\[i\]\.getHandlerFunction\(\)\]\)/.test(CODE),
   'その3つだけを作り直し、ほかには触らない');
ok('①何本消したかを返す', /消した ' \+ removed \+ ' 本・ほかのトリガーには触っていません/.test(CODE));

// ---------- 2. 点検が危険な案内をしないこと ----------
ok('②★「setupTriggers を実行し直す」と案内していない',
   !/setupTriggers を実行し直すと戻ります/.test(LB),
   '案内どおりに実行すると、押し出し・作業依頼・点検そのものが止まる');
ok('②★実行しないよう明示している',
   /★setupTriggers は実行しないでください（全部消して3本しか戻しません）/.test(LB));
ok('②用途ごとの関数を名指しで案内する',
   /setupEdgeTrigger/.test(LB) && /setupEdgeJobTrigger/.test(LB)
   && /setupCalSyncTrigger/.test(LB) && /setupNudgeTrigger/.test(LB)
   && /setupRecurringTriggers/.test(LB) && /setupLineTriggers/.test(LB));
ok('②版の印を上げている', /LB_HEALTH_BUILD = '2026-10-10a/.test(LB));

// ---------- 3. ★月次のものを日次と混同しないこと（私の誤り）----------
//   atHour だけを見て onMonthDay を見ていなかった。
//   設計どおり実装すると**全トレーナーに毎日LINEが飛ぶ**（送信済み判定が無い）。
{
  //   ★実際の定義は setupRecurringTriggers（LineBooking.js:7177）の1箇所にある
  const setup = LB.slice(LB.indexOf('function setupRecurringTriggers()'),
                         LB.indexOf('function setupRecurringTriggers()') + 900);
  ok('③★シフト連絡は毎月20日10時',
     /newTrigger\('sendShiftReminders'\)\.timeBased\(\)\.onMonthDay\(20\)\.atHour\(10\)/.test(setup),
     '毎日ではない。毎日呼ぶと全トレーナーに毎日LINEが飛ぶ（送信済み判定が無い）');
  ok('③★固定枠の自動予約は毎月25日6時',
     /newTrigger\('autoBookRecurringPatterns'\)\.timeBased\(\)\.onMonthDay\(25\)\.atHour\(6\)/.test(setup),
     '毎日ではない');
  ok('③シフト連絡に送信済みの判定が無い（だから毎日呼んではいけない）',
     !/shift_sent|_lbShiftSent|sentThisMonth/.test(LB.slice(LB.indexOf('function sendShiftReminders'),
                                                            LB.indexOf('function sendShiftReminders') + 1200)),
     '束ねるなら、日付で絞るか送信済み印を足すのが前提');
  //   ★日次のものと束ねるときは、必ず日付で絞る（まだ束ねていないので、
  //     束ねる実装が入ったらこの検査を「日付の判定がある」に変える）
  ok('③いまは束ねていない（毎日呼ぶ実装が入っていない）',
     !/function lbDaily6\(/.test(LB) && !/function lbDaily10\(/.test(LB),
     '束ねるなら JST の日付で絞る実装と同時に入れる');
}

console.log(`\n${fail ? '❌' : '✅'} トリガーの安全 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
