// 打ち手A（2026-11-18）：印だけ（行0件）の送信では表の全行 SELECT を省く。I79 の順序は変えない
//   実行: node worker/test/ingest-mark-only.test.js
//   本物の SQLite に全 migration を流し、handleIngest の入口から通す。SQL を全部記録して数える。
//
//   ① 予約一覧の印だけ（rows:[]・customerId・dirtySeq）… reservations の全行 SELECT が0回・dirty_seq が立つ・covers は触らない（閉じる）
//   ② home の印だけ（rows:[]・dirtySeq）… member_home の全行 SELECT が0回・200
//   ③ 行のある送信は従来どおり読む（同じ行を2回送ると2回目は skipped=1・世代を進めない）
//   ④ 完全同期で0件（EMPTY_SOURCE）も読まずに従来の応答
//   ★値は架空（個人情報を書かない）
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { handleIngest } from '../src/routes/ingest.js';
import { isClosed } from '../src/lib/write-covers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const W = join(HERE, '..');
const SECRET = 'S';
let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) pass++; else { fail++; console.log(`❌ ${name}${detail ? '\n   ' + detail : ''}`); } }

function makeEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(W, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(join(W, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    try { db.exec(readFileSync(join(W, 'migrations', f), 'utf8')); } catch (e) { if (!/duplicate column/.test(e.message)) throw e; }
  }
  const env = { SHARED_SECRET: SECRET, _db: db, _log: [] };
  const exec = (q, a, how) => {
    env._log.push(q.replace(/\s+/g, ' ').trim());
    const st = db.prepare(q);
    if (how === 'first') { const r = st.get(...a); return r === undefined ? null : Object.assign({}, r); }
    if (how === 'all') return { results: st.all(...a).map((r) => Object.assign({}, r)) };
    const r = st.run(...a); return { meta: { changes: Number(r.changes) } };
  };
  env.DB = {
    prepare(q) { return { _q: q, _a: [], bind(...a) { this._a = a; return this; },
      async run() { return exec(q, this._a, 'run'); }, async first() { return exec(q, this._a, 'first'); },
      async all() { return exec(q, this._a, 'all'); } }; },
    async batch(ss) { db.exec('BEGIN'); try { const o = ss.map((s) => exec(s._q, s._a, 'run')); db.exec('COMMIT'); return o; }
                      catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; } },
  };
  return env;
}
const NOW = Date.now();
const C1 = 'C1800000000001', C2 = 'C1800000000002';
function seed(env) {
  const d = env._db;
  for (const id of [C1, C2]) {
    d.prepare('INSERT INTO customers (customer_id, name, default_trainer_id, created_at, updated_at) VALUES (?, ?, ?, 1, 1)').run(id, 'テスト 太郎', 'T1');
    d.prepare('INSERT INTO member_home (customer_id, payload, computed_at, synced_at) VALUES (?, ?, ?, 1)').run(id, '{}', NOW - 60000);
  }
  d.prepare(`INSERT INTO reservations (reservation_id, customer_id, customer_name, trainer_id, start_at, end_at, kind, status, created_at, synced_at)
             VALUES ('R1', ?, 'テスト 太郎', 'T1', ?, ?, 'normal', 'booked', 1, 1)`).run(C1, NOW + 86400000, NOW + 86400000 + 3600000);
}
let BATCH = Date.now() + 1000;
async function ingest(env, body) {
  const res = await handleIngest(new Request('https://x/ingest', { method: 'POST', headers: { 'X-Ingest-Secret': SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ batchId: ++BATCH }, body)) }), env);
  let j = {}; try { j = await res.json(); } catch (_) {}
  return { status: res.status, ...j };
}
const fullSelects = (env, table) => env._log.filter((q) => new RegExp(`^SELECT .* FROM ${table}$`).test(q)).length;
const sv = (env, id) => { const r = env._db.prepare('SELECT * FROM customer_sync_version WHERE customer_id = ?').get(id); return r ? Object.assign({}, r) : null; };
const resvRow = (id, cid) => ({ reservation_id: id, customer_id: cid, customer_name: 'テスト 太郎', trainer_id: 'T1',
  start_at: NOW + 2 * 86400000, end_at: NOW + 2 * 86400000 + 3600000, kind: 'normal', attendee_count: 1, status: 'booked', created_at: 1 });

console.log('=== ① 予約一覧の印だけ ===');
{
  const env = makeEnv(); seed(env);
  const r = await ingest(env, { kind: 'reservations', rows: [], final: true, scope: 'partial', customerId: C2, dirtySeq: 11 });
  const v = sv(env, C2);
  ok('①-1 200・dirtied=1', r.status === 200 && r.success === true && r.dirtied === 1, JSON.stringify(r));
  ok('①-2 ★reservations の全行 SELECT を読まない', fullSelects(env, 'reservations') === 0, env._log.join('\n   '));
  ok('①-3 ★I79：dirty_seq が立つ・covers は触らない（閉じる）', v && v.dirty_seq === 11 && v.resv_covers_seq === null && isClosed(v, 'resv') && isClosed(v, 'home'), JSON.stringify(v));
  ok('①-4 会員の実在確認は従来どおり読む（1行の SELECT）', env._log.some((q) => /^SELECT 1 AS x FROM customers WHERE customer_id = \?$/.test(q)));
  ok('①-5 既存の予約行は消えない', env._db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n === 1);
}

console.log('=== ② home の印だけ ===');
{
  const env = makeEnv(); seed(env);
  const r = await ingest(env, { kind: 'home', rows: [], final: true, scope: 'partial', dirtySeq: 5 });
  ok('②-1 200', r.status === 200 && r.success === true, JSON.stringify(r));
  ok('②-2 ★member_home の全行 SELECT を読まない', fullSelects(env, 'member_home') === 0, env._log.join('\n   '));
  ok('②-3 写しは消えない', env._db.prepare('SELECT COUNT(*) AS n FROM member_home').get().n === 2);
}

console.log('=== ③ 行のある送信は従来どおり ===');
{
  const env = makeEnv(); seed(env);
  const r1 = await ingest(env, { kind: 'reservations', rows: [resvRow('R9', C2)], final: true, scope: 'partial', customerId: C2, dirtySeq: 3 });
  ok('③-1 行がある送信は全行 SELECT を読む', fullSelects(env, 'reservations') === 1 && r1.written === 1, JSON.stringify(r1));
  const srcBefore = sv(env, C2).source_version;
  const r2 = await ingest(env, { kind: 'reservations', rows: [resvRow('R9', C2)], final: true, scope: 'partial', customerId: C2, dirtySeq: 4 });
  ok('③-2 同じ行の2回目は書かない（skipped=1・世代を進めない）', r2.skipped === 1 && r2.written === 0 && r2.bumped === 0 && sv(env, C2).source_version === srcBefore, JSON.stringify({ r2, v: sv(env, C2) }));
  ok('③-3 印は2回目でも立つ', sv(env, C2).dirty_seq === 4);
}

console.log('=== ④ 完全同期で0件 ===');
{
  const env = makeEnv(); seed(env);
  const r = await ingest(env, { kind: 'reservations', rows: [], final: true, scope: 'all', deleteStale: true });
  ok('④-1 EMPTY_SOURCE で止める（従来どおり）・全行を読まない', r.skippedDelete === 'EMPTY_SOURCE' && fullSelects(env, 'reservations') === 0
     && env._db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n === 1, JSON.stringify(r));
}

console.log(`\n${fail ? '❌' : '✅'} ingest-mark-only: ${pass} 通過 / ${fail} 失敗`);
process.exit(fail ? 1 : 0);
