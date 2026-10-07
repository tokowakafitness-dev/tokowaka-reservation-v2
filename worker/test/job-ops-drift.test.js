// 作業依頼の「許可リスト」が3箇所で揃っていることを固定する
//
//   ★なぜ要るのか（2026-10-07）
//     新しい作業（quotaBuild）を足したとき、**3箇所あるうち2箇所しか直さなかった。**
//     GASとWorkerには足したが、GitHub Actions のワークフローに足し忘れた。
//     結果、依頼を push しても「許可されていない作業です」で止まり、
//     Workerには登録されず、`/jobs/<id>` は NOT_FOUND を返した。
//     **どこにも異常が出ず、ただ何も起きなかった。** 原因に辿り着くまで往復した。
//
//   ★3箇所がばらばらだと何が起きるか
//     ワークフローに無い  … 依頼が登録されない（今回これ）
//     Workerに無い        … 登録が 400 で弾かれる
//     GASに無い           … 拾われたあと例外になり、failed で返る
//     どれも「作業が実行されない」だが、止まる場所が違うので原因が見えにくい。
//
//   ★ワークフローはCEOのPATでは変更できない（意図的な防御）。
//     だからこそ、ずれていることを**機械で検知**できなければならない。
//     足りないときは、オーナーに1行の修正をお願いする。
//
//   実行: node worker/test/job-ops-drift.test.js

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');

let pass = 0, fail = 0;
function ok(name, cond, extra) { cond ? pass++ : (fail++, console.log(`❌ ${name}${extra ? '\n   ' + extra : ''}`)); }

// ---------- ① Worker の許可リスト ----------
const JOBS = readFileSync(join(ROOT, 'worker/src/routes/jobs.js'), 'utf8');
const mWorker = JOBS.match(/const OPS = new Set\(\[([^\]]+)\]\)/);
ok('①Workerの許可リストが読める', !!mWorker);
const workerOps = mWorker ? mWorker[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : [];

// ---------- ② GAS の許可リスト（switch の case） ----------
const EJ = readFileSync(join(ROOT, 'gas/EdgeJob.js'), 'utf8');
//   _ejRun の switch から case を拾う。default は数えない。
const gasOps = [...EJ.matchAll(/case '([A-Za-z]+)':/g)].map((m) => m[1]);
ok('②GASの許可リストが読める', gasOps.length > 0);

// ---------- ③ GitHub Actions の許可リスト ----------
const WF = readFileSync(join(ROOT, '.github/workflows/edge-job.yml'), 'utf8');
const mWf = WF.match(/^\s*([A-Za-z|]+)\) : ;;/m);
ok('③ワークフローの許可リストが読める', !!mWf, 'case の行の形が変わった可能性');
const wfOps = mWf ? mWf[1].split('|').map((s) => s.trim()).filter(Boolean) : [];

// ---------- ★3つが揃っているか ----------
const sortU = (a) => [...new Set(a)].sort();
const W = sortU(workerOps), G = sortU(gasOps), F = sortU(wfOps);

ok('★WorkerとGASが一致する', JSON.stringify(W) === JSON.stringify(G),
  `Worker=${W.join(',')}\n   GAS   =${G.join(',')}`);
ok('★ワークフローとWorkerが一致する', JSON.stringify(F) === JSON.stringify(W),
  `ワークフロー=${F.join(',')}\n   Worker      =${W.join(',')}\n`
  + '   ★ワークフローはCEOのPATでは直せない。足りなければオーナーに\n'
  + '     .github/workflows/edge-job.yml の case 行へ1語足すようお願いすること');

// ---------- 書き込みを伴う作業が、読み取り専用に紛れていないか ----------
const mWrite = JOBS.match(/const WRITE_OPS = new Set\(\[([^\]]+)\]\)/);
ok('書き込みの作業リストが読める', !!mWrite);
const writeOps = mWrite ? mWrite[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : [];
ok('書き込みの作業は、許可リストにも載っている',
  writeOps.every((op) => W.includes(op)),
  `WRITE_OPS=${writeOps.join(',')}`);

console.log('');
console.log(`${fail ? '❌' : '✅'} 作業依頼の許可リスト 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
