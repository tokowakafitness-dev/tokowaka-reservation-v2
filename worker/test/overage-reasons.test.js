// 「支払い待ち」として数える理由が2箇所で一致していることを固定する。
//   実行: node worker/test/overage-reasons.test.js
//
// ★なぜ要るのか（2026-10-09）
//   同じ一覧が2箇所にある。
//     GAS   LB_OVERAGE_REASONS（画面と点検で使う）
//     Worker OVERAGE_REASONS（D1の枠の行に書く値を作る）
//   片方だけ変えると、**顧客に見える「支払い待ち」の数が食い違う。**
//   許可リストが3箇所にあって1つだけ直し忘れた事故（2026-10-07）と同じ形。
//
// ★入力の誤り（契約の不備など）は数えない。
//   数えると「支払えば解決する」と誤って案内することになる。

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const LB = readFileSync(join(ROOT, 'gas/LineBooking.js'), 'utf8');
const AB = readFileSync(join(ROOT, 'worker/src/lib/alloc-build.js'), 'utf8');
const QB = readFileSync(join(ROOT, 'worker/src/lib/quota-build.js'), 'utf8');
const MG = readFileSync(join(ROOT, 'worker/migrations/0013_quota_base_freq_overage.sql'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  cond ? pass++ : (fail++, console.log(`❌ ${name}${extra ? '\n   ' + extra : ''}`));
}
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  g === w ? pass++ : (fail++, console.log(`❌ ${name}\n   got : ${g}\n   want: ${w}`));
}

function keysOf(src, name) {
  const m = src.match(new RegExp(`${name} = \\{([\\s\\S]*?)\\};`));
  if (!m) return null;
  return (m[1].match(/^\s*([A-Z_]+):/gm) || []).map((x) => x.replace(/[:\s]/g, '')).sort();
}

console.log('=== 1. ★2箇所の一覧が一致していること ===');
{
  const g = keysOf(LB, 'LB_OVERAGE_REASONS');
  const w = keysOf(AB, 'OVERAGE_REASONS');
  ok('①GAS側が読める', Array.isArray(g) && g.length > 0);
  ok('①Worker側が読める', Array.isArray(w) && w.length > 0);
  eq('①★中身が同じ', w, g);
  eq('①5つある', (g || []).length, 5);
}

console.log('=== 2. 入力の誤りは数えない ===');
ok('②その理由を書いている',
  /入力の誤りは数えない/.test(AB),
  '数えると「支払えば解決する」と誤って案内する');
ok('②GAS側も同じ趣旨', /入力の誤りは数えない/.test(LB));

console.log('=== 3. 月ごとに数えて枠の行へ移す ===');
ok('③月ごとに数える', /out\.overageByMonth\[mk\] = \(out\.overageByMonth\[mk\] \|\| 0\) \+ 1;/.test(AB));
ok('③理由で絞ってから数える',
  /if \(OVERAGE_REASONS\[String\(ps\.reason \|\| ''\)\]\) \{[\s\S]{0,120}?overageByMonth/.test(AB));
ok('③初期値がある', /overageByMonth: \{\},/.test(AB));

console.log('=== 4. 枠の行に書く（頻度と支払い待ち）===');
ok('④頻度を持たせる', /baseFreq: Number\(res\.freq \|\| 0\)/.test(QB));
ok('④★頻度が無いと繰越が作れないと書いている',
  /頻度が無いと繰越が作れない/.test(QB),
  'quota 全部を繰越として見せてしまう');
ok('④両方を書く文になっている',
  /base_freq = excluded\.base_freq, overage = excluded\.overage/.test(QB));
ok('④★used には触れない（不変条件）',
  !/DO UPDATE SET[\s\S]{0,300}?\bused\s*=/.test(QB),
  'used を動かすのはトリガーだけ');

console.log('=== 5. 列の作り（読む側が「入っていない」を見分けられること）===');
ok('⑤base_freq は NULL 許容（まだ作り直していないが分かる）',
  /ADD COLUMN base_freq INTEGER;/.test(MG) && !/base_freq INTEGER NOT NULL/.test(MG));
ok('⑤★その理由を書いている',
  /NULL のうちは「まだ作り直していない」と分かるようにする/.test(MG),
  '作り直す前は carryover が過大に見える（quota − 0 = quota）');
ok('⑤overage は 0 が自然な初期値', /ADD COLUMN overage INTEGER NOT NULL DEFAULT 0;/.test(MG));

console.log('');
console.log(`${fail ? '❌' : '✅'} 支払い待ちの数え方 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
