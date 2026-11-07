// /health に版の印が載ることを入口から確かめる（2026-11-07）
//   実行: node worker/test/worker-build.test.js
import worker, { WORKER_BUILD } from '../src/index.js';

let fail = 0;
const ok = (name, cond, d) => { if (!cond) { fail++; console.log(`❌ ${name}${d ? '\n   ' + d : ''}`); } };
const env = { DB: { prepare() { return { all: async () => ({ results: [] }) }; } } };
const res = await worker.fetch(new Request('https://x.example/health'), env, { waitUntil() {} });
const body = await res.json();
ok('B-1 版の印は日付で始まる', /^\d{4}-\d{2}-\d{2}/.test(WORKER_BUILD), WORKER_BUILD);
ok('B-2 /health の応答に build が載る', body.build === WORKER_BUILD, JSON.stringify(body));
ok('B-3 /health は個人情報を返さない（ok・now・build・sync だけ）', Object.keys(body).sort().join() === 'build,now,ok,sync', Object.keys(body).join());
console.log(fail ? `worker-build: ${fail} 失敗` : 'worker-build: 全部通過');
process.exit(fail ? 1 : 0);
