// 顧客IDを受け取るGASの入口が、1つ残らず認可を通ることの検証
//
//   ★なぜこれが要るのか（2026-10-03・本質的な対処）
//     この日、顧客の閲覧範囲の穴を4回にわたって塞いだ。そのたびに
//     「これで全部です」と報告し、そのたびにCodexが別の入口を見つけた。
//
//       1回目 … 残数（getCustomerHomeForTrainer）
//       2回目 … 体組成の読み取り・書き込み、予約オプション
//       3回目 … 判定そのものが fail-open（実在しない顧客IDで通る）
//       4回目 … 固定枠の追加・削除だけ緩い判定が残っていた
//
//     原因は**人が目で探して「全部直した」と言っていたこと**。
//     入口は37あり、そのうち顧客IDを受け取るものは機械で数えられる。
//     数えられるものを人が数えてはいけない。
//
//   ★この検査が守ること
//     新しい入口を足して認可を書き忘れたら、**その時点で落ちる。**
//     例外にしたいものは、理由を書いて下の表に載せる。
//     「理由を書く」こと自体が、例外を増やしにくくする。
//
//   実行: node worker/test/gas-entry-guard.test.js

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const FILES = ['gas/LineBooking.js', 'gas/LbBatch.js', 'gas/MealAi.js'];
const SRC = Object.fromEntries(FILES.map((f) => [f, readFileSync(join(ROOT, f), 'utf8')]));
const ALL = FILES.map((f) => SRC[f]).join('\n');
const LB = SRC['gas/LineBooking.js'];

let pass = 0, fail = 0;
function eq(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log(`❌ ${name}\n   got : ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`); }
}
function ok(name, cond, extra) { cond ? pass++ : (fail++, console.log(`❌ ${name}${extra ? '\n   ' + extra : ''}`)); }

// 認可の正本。ここを通らずに顧客の情報へ触れてはいけない。
const GUARD = '_lbTrainerMaySeeCustomer';

// ---- 例外（理由を書くこと。書けないものは例外にしない）----
const EXEMPT = {
  line_linkUnlinked:
    '未紐付け予約の紐付けは全トレーナーの受付業務（決定0066）。' +
    '紐付けを判断できるのはその日に施術したトレーナー本人で、' +
    '一覧に出るのは氏名とIDだけ（契約・報酬に触れない）。',
};

// ---- dispatch を case ごとに切り出す ----
function entries() {
  const i0 = LB.indexOf("case 'line_");
  const body = LB.slice(i0);
  const marks = [...body.matchAll(/case '(line_\w+)':/g)];
  const out = [];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index;
    const end = (i + 1 < marks.length) ? marks[i + 1].index : start + 2000;
    out.push({ name: marks[i][1], block: body.slice(start, end) });
  }
  return out;
}

// ---- その入口が呼ぶ関数の本体に認可があるか ----
function guardedByCallee(block) {
  // ブロックから呼び出している関数名を拾う（params.xxx や String( は除く）
  const names = [...block.matchAll(/\b([a-zA-Z_]\w*)\s*\(/g)].map((m) => m[1])
    .filter((n) => !['String', 'Number', 'if', 'for', 'switch', 'return', 'catch', 'function'].includes(n));
  for (const n of new Set(names)) {
    const m = ALL.match(new RegExp('function ' + n + '\\([\\s\\S]*?\\n\\}', ''));
    if (m && m[0].includes(GUARD)) return n;
  }
  return null;
}

const list = entries();
ok('①入口を切り出せた', list.length >= 30, `${list.length}件`);

// 顧客IDを受け取る入口だけを見る
const takesCustomer = list.filter((e) => /params\.customerId/.test(e.block));
ok('①顧客IDを受け取る入口がある', takesCustomer.length >= 8, `${takesCustomer.length}件`);

const unguarded = [];
for (const e of takesCustomer) {
  if (EXEMPT[e.name]) continue;                     // 理由を書いた例外
  if (e.block.includes(GUARD)) continue;            // 入口そのもので守っている
  if (guardedByCallee(e.block)) continue;           // 呼ぶ先で守っている
  unguarded.push(e.name);
}
eq('①★顧客IDを受け取る入口がすべて認可を通る', unguarded.sort(), []);

// ---- ② 例外は「理由が書いてある」ものだけ ----
for (const [name, why] of Object.entries(EXEMPT)) {
  ok(`②例外 ${name} に理由がある`, typeof why === 'string' && why.length > 30);
  ok(`②例外 ${name} が実在する入口である`, list.some((e) => e.name === name), '消えた入口が表に残っている');
}
// 例外を増やしすぎていないこと（増えるときは必ず人の目に触れる）
ok('②例外は1つだけ', Object.keys(EXEMPT).length === 1,
   `いまの例外: ${Object.keys(EXEMPT).join(', ')}`);

// ---- ③ 認可の規則が1か所にしかないこと ----
//   同じ意味の式を別に書くと、片方だけ直して「統一した」と誤解する。
//   実際この日、固定枠だけ古い式が残っていたのを4回目で指摘された。
{
  // 「オーナーでなく、担当が設定されていて、自分でない」という形の独自判定
  const custom = [...ALL.matchAll(/_lbIsOwnerRole\([a-z_]+\)\s*&&\s*\w*[Tt]rainerId\s*&&/g)];
  eq('③★顧客の担当を見る独自の判定式が残っていない', custom.map((m) => m[0]), []);
}
ok('③認可の関数が1つだけ定義されている',
  (ALL.match(new RegExp('function ' + GUARD + '\\(', 'g')) || []).length === 1);

// ---- ④ 認可に使う「担当は誰か」は厳格版だけ ----
//   緩い版（見つからなくても '' を返す）を使うと、実在しない顧客IDで通る。
{
  const calls = [...ALL.matchAll(new RegExp(GUARD + '\\(([^,]+),\\s*([^)]+)\\)', 'g'))]
                  .map((m) => m[2].trim());   // 第2引数＝「この顧客の担当は誰か」
  ok('④認可の呼び出しを拾えた', calls.length >= 8, `${calls.length}件`);
  const loose = calls.filter((a) => /_lbCustTrainerId\(/.test(a));
  eq('④★緩い版を認可に使っていない', loose, []);
}

console.log(`\n${fail ? '❌' : '✅'} GASの入口の守り 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
