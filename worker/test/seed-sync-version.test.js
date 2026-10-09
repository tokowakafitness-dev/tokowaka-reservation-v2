// 世代の初期化（migration 0017）を本物のSQLiteで動かす
//
//   ★なぜ本物で動かすのか
//     この migration の正しさは **SQL の意味**にある（DO UPDATE の WHERE が
//     「0/0 の行だけ」を選べるか）。字面では分からない。
//     2026-10-09、最初に `ON CONFLICT DO NOTHING` で書いて**何も起きない**ものを
//     作りかけた（最初の作り直しが既に 0/0 の行を作っていた）。
//
//   実行: node worker/test/seed-sync-version.test.js

import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const rd = (p) => readFileSync(join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) { cond ? pass++ : (fail++, console.log(`❌ ${name}${extra ? '\n   ' + extra : ''}`)); }

const DIR = mkdtempSync(join(tmpdir(), 'seed-'));
const DB = join(DIR, 't.db');
const sql = (t) => execFileSync('sqlite3', [DB], { input: t, encoding: 'utf8' });

//   世代の表（0014＋0016の該当列）と、計算入力の契約行の表を作る
sql(rd('worker/migrations/0014_customer_sync_version.sql'));
sql(rd('worker/migrations/0016_row_generation.sql')
  .split('\n').filter((l) => /^ALTER TABLE customer_sync_version/.test(l)).join('\n'));
sql(`CREATE TABLE calc_contract_rows (row_key TEXT PRIMARY KEY, customer_id TEXT, idx INT, row_json TEXT);`);

//   対象の会員（契約行がある）
sql(`INSERT INTO calc_contract_rows VALUES
  ('r1','C_NONE',0,'{}'), ('r2','C_ZERO',0,'{}'), ('r3','C_ZERO',1,'{}'),
  ('r4','C_MID',0,'{}'), ('r5','C_FRESH',0,'{}'), ('r6','',0,'{}'), ('r7',NULL,0,'{}');`);

//   いまの世代の状態を作る
//     C_NONE  … 行が無い（作り直しをまだ一度もしていない）
//     C_ZERO  … ★0/0（最初の作り直しが作った状態。ここが本番の40名）
//     C_MID   … 3/0（入力は進んだが作り直していない）
//     C_FRESH … 3/3（追いついている）
//     C_OTHER … 契約行が無いのに世代の行がある（対象外）
sql(`INSERT INTO customer_sync_version (customer_id, source_version, built_version, built_at, updated_at)
      VALUES ('C_ZERO',0,0,NULL,NULL), ('C_MID',3,0,NULL,NULL), ('C_FRESH',3,3,1,1), ('C_OTHER',5,5,1,1);`);

const SEED = rd('worker/migrations/0017_seed_sync_version.sql');
ok('文に DO UPDATE がある（DO NOTHING では何も起きない）',
   /ON CONFLICT\(customer_id\) DO UPDATE SET/.test(SEED) && !/DO NOTHING/.test(SEED.split('INSERT INTO')[1] || ''),
   '最初の作り直しが既に 0/0 の行を作っているため');
sql(SEED);

const row = (cid) => {
  const out = sql(`SELECT source_version, built_version FROM customer_sync_version WHERE customer_id='${cid}';`).trim();
  return out ? out.split('|').map(Number) : null;
};

ok('①行が無い会員 → 1/0', String(row('C_NONE')) === '1,0', String(row('C_NONE')));
ok('②★0/0 の会員 → 1/0（これが本番の40名）', String(row('C_ZERO')) === '1,0', String(row('C_ZERO')));
ok('③3/0 の会員は触らない', String(row('C_MID')) === '3,0', String(row('C_MID')));
ok('④3/3 の会員は触らない', String(row('C_FRESH')) === '3,3', String(row('C_FRESH')));
ok('⑤契約行が無い会員は触らない', String(row('C_OTHER')) === '5,5', String(row('C_OTHER')));
ok('⑤空の会員IDの行は作らない',
   sql(`SELECT COUNT(*) FROM customer_sync_version WHERE customer_id='' OR customer_id IS NULL;`).trim() === '0');
ok('⑤同じ会員の契約行が2つあっても1行だけ',
   sql(`SELECT COUNT(*) FROM customer_sync_version WHERE customer_id='C_ZERO';`).trim() === '1');

//   ★もう一度流しても変わらない（冪等）
sql(SEED);
ok('⑥★2回流しても変わらない',
   String(row('C_NONE')) === '1,0' && String(row('C_ZERO')) === '1,0'
   && String(row('C_MID')) === '3,0' && String(row('C_FRESH')) === '3,3');

//   ★seed の直後は「答えない」こと（built > 0 が要る）
{
  const { isFresh } = await import('../src/lib/sync-version.js');
  ok('⑦★seed の直後は答えない',
     isFresh({ sourceVersion: 1, builtVersion: 0, exists: true }) === false,
     '顧客に古い値を出す方向には一切動かない');
  ok('⑦作り直したあとは答える',
     isFresh({ sourceVersion: 1, builtVersion: 1, exists: true }) === true);
}

//   ★次の作り直しで built=1 になること（markBuiltStatement の CASE）
{
  const { markBuiltStatement } = await import('../src/lib/sync-version.js');
  const st = markBuiltStatement('C_ZERO', 1, 9999, { quotaRows: 2, packRows: 1, fromMonth: '2026-09', toMonth: '2026-12' });
  let i = 0;
  const filled = st.sql.replace(/\?/g, () => {
    const v = st.args[i++];
    return v === null || v === undefined ? 'NULL' : (typeof v === 'number' ? String(v) : `'${v}'`);
  });
  sql(filled + ';');
  ok('⑧★作り直すと built=1 になって答えられる', String(row('C_ZERO')) === '1,1', String(row('C_ZERO')));
  ok('⑧行数と範囲も入る',
     sql(`SELECT built_quota_rows, built_pack_rows, built_from_month, built_to_month
            FROM customer_sync_version WHERE customer_id='C_ZERO';`).trim() === '2|1|2026-09|2026-12');
}

//   ★地図に書いてあるか
{
  const DOC = rd('ops/MODEL.md');
  ok('⑨地図が「pushAll では進まないことがある」と書いている',
     /実際にD1へ書いた会員だけ|変更なしの行は/.test(DOC),
     '2026-10-09、地図は「pushAll ← source_version が進む」と書いていた（事実と違った）');
  ok('⑨地図に後付けの手順（bootstrap）がある', /世代表を既存の入力へ後付けするとき/.test(DOC));
  ok('⑨不変条件に入っている', /I16/.test(DOC));
}

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${fail ? '❌' : '✅'} 世代の初期化 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
