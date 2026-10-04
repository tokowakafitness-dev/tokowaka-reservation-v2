// 残数の計算が、GASとWorkerで1文字も違わないことの検査
//
//   ★なぜ要るのか（2026-10-04）
//     残数の計算は gas/Allocate.js と worker/src/allocate.js の**2か所にある**。
//     ファイル内のコメントは「line-booking/test/allocate-worker-drift.test.js が毎回照合する」と
//     書いているが、**そのテストはこのリポジトリに存在しなかった。** 照合が回っていなかった。
//     実際、2026-10-03 に createdAt を GAS 側だけに足して、Worker 側が取り残されていた。
//
//     「同じものが2か所にあって、1つだけ古い」——今日1日で何度も踏んだ形そのもの。
//     残数は顧客のお金に直結する。片方だけ直すと、経路によって答えが変わる。
//
//   ★許される差分は「読み込みの作法」だけ
//     Worker は ESM なので末尾に export が要る。計算の中身は1行も違ってはいけない。
//
//   実行: node worker/test/allocate-drift.test.js

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');

let pass = 0, fail = 0;
function eq(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log(`❌ ${name}\n   got : ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`); }
}
function ok(name, cond, extra) { cond ? pass++ : (fail++, console.log(`❌ ${name}${extra ? '\n   ' + extra : ''}`)); }

// 行コメント・空行を落とし、インデントを揃える（書式の違いは差分と見なさない）
function body(p) {
  return readFileSync(join(ROOT, p), 'utf8').split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//'));
}

const G = body('gas/Allocate.js');
const W = body('worker/src/allocate.js');

ok('①両方のファイルが読める', G.length > 500 && W.length > 500, `GAS=${G.length} Worker=${W.length}`);

// Worker 側の末尾の export ブロックだけを取り除く（ESMの作法。計算ではない）
const iExport = W.findIndex((l) => l.startsWith('export {'));
ok('②Worker側に export がある（ESMの作法）', iExport > 0);
const Wcore = iExport > 0 ? W.slice(0, iExport) : W;

// ★ここが本体：計算の中身が1行も違わないこと
{
  const n = Math.max(G.length, Wcore.length);
  const diffs = [];
  for (let i = 0; i < n; i++) {
    if (G[i] !== Wcore[i]) {
      diffs.push(`${i + 1}行目\n     GAS   : ${String(G[i]).slice(0, 110)}\n     Worker: ${String(Wcore[i]).slice(0, 110)}`);
      if (diffs.length >= 3) break;
    }
  }
  eq('③★残数の計算がGASとWorkerで完全に同じ', diffs, []);
  eq('③行数も同じ', [G.length, Wcore.length], [G.length, G.length]);
}

// ④ 版の印が一致していること（片方だけ上げると、気づかないまま別物になる）
for (const key of ['LB_ALLOC_LOGIC_VERSION', 'LB_ALLOC_CANONICAL_VERSION']) {
  const g = (G.find((l) => l.includes(key + ' =')) || '').replace(/\s/g, '');
  const w = (Wcore.find((l) => l.includes(key + ' =')) || '').replace(/\s/g, '');
  ok(`④${key} が両方にある`, !!g && !!w, `GAS=${g} Worker=${w}`);
  eq(`④★${key} が一致する`, g, w);
}

// ⑤ 誤った案内が残っていないこと
//   「line-booking/test/allocate-worker-drift.test.js が照合する」と書いてあったが、
//   そのテストは存在しなかった。**無い仕組みを指すコメントは、無いより悪い。**
{
  const raw = readFileSync(join(ROOT, 'worker/src/allocate.js'), 'utf8')
            + readFileSync(join(ROOT, 'gas/Allocate.js'), 'utf8');
  // ★「いま照合している」と**断定している行**だけを見る。
  //   過去にそう書いてあった、という記録は残してよい（残さないと同じ過ちを繰り返す）。
  //   今日ここで一度、記録の文字列が検査に当たって落ちた。検査する対象を取り違えない。
  const claims = raw.split('\n').filter((l) => /照合します/.test(l));
  const bad = claims.filter((l) => !/worker\/test\/allocate-drift\.test\.js/.test(l))
                    .map((l) => l.trim().slice(0, 90));
  eq('⑤★「照合します」と書いてある行が、実在するテストを指している', bad, []);
  // そのテストが本当に在ること
  ok('⑤指しているテストが実在する',
     existsSync(join(ROOT, 'worker/test/allocate-drift.test.js')));
}

console.log(`\n${fail ? '❌' : '✅'} 残数の計算の一致 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
