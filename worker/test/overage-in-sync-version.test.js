// 設計27：支払い待ちを世代の行に書く（チケットだけの会員にも残す）・2026-11-03
//   実行: node worker/test/overage-in-sync-version.test.js
//
// ★なぜ要るのか
//   D1 は支払い待ちを月額の枠の行にしか持たず、チケットだけの会員は常に 0 だった
//   （11/2・11/3 の shadow で *4717 が 写し=1 / D1=0）。
//   ここでは「書く側」を確かめる：JSON の形・競合で倒すと消えること・2経路の配線。
import { readFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { overageJson, markBuiltStatement, bumpSourceStatement } from '../src/lib/sync-version.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
let pass = 0, fail = 0;
function ok(name, cond, extra) { cond ? pass++ : (fail++, console.log(`❌ ${name}${extra ? '\n   ' + extra : ''}`)); }

// ---------- 1. JSON の形 ----------
const al = { computed: true, overageByMonth: { '2026-11': 1 } };
const j = JSON.parse(overageJson(al, '2026-11', '2026-10', '2026-12'));
ok('①asOf は今の月', j.asOf === '2026-11');
ok('①★範囲の全月を0も含めて書く（欠けと0を区別するため）',
   JSON.stringify(j.m) === JSON.stringify({ '2026-10': 0, '2026-11': 1, '2026-12': 0 }), JSON.stringify(j.m));
ok('①年をまたぐ', Object.keys(JSON.parse(overageJson(al, '2026-12', '2026-12', '2027-01')).m).join() === '2026-12,2027-01');
ok('①★計算が通っていなければ null（答えない側）', overageJson({ computed: false, overageByMonth: {} }, '2026-11', '2026-11', '2026-11') === null);
ok('①引当が無ければ null', overageJson(null, '2026-11', '2026-11', '2026-11') === null);
ok('①範囲が壊れていれば null', overageJson(al, '2026-11', '2026-12', '2026-11') === null && overageJson(al, '2026-11', '', '2026-11') === null);

// ---------- 2. 世代の行に書く・競合で倒すと NULL ----------
const DB = join(mkdtempSync(join(tmpdir(), 'ovsv-')), 't.db');
const sql = (t) => execFileSync('sqlite3', [DB], { input: t, encoding: 'utf8' });
const rd = (p) => readFileSync(join(ROOT, p), 'utf8');
sql(rd('worker/migrations/0014_customer_sync_version.sql'));
sql(rd('worker/migrations/0016_row_generation.sql').split('\n').filter((l) => /^ALTER TABLE customer_sync_version/.test(l)).join('\n'));
sql(rd('worker/migrations/0020_write_seq.sql'));
sql(rd('worker/migrations/0024_sync_overage.sql'));
function fill(st) {
  let i = 0;
  return st.sql.replace(/\?/g, () => {
    const v = st.args[i++];
    if (v === null || v === undefined) return 'NULL';
    return (typeof v === 'number') ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
  }) + ';';
}
const got = (cid) => sql(`SELECT built_version, COALESCE(built_overage_json,'<NULL>') FROM customer_sync_version WHERE customer_id='${cid}';`).trim();
const OJ = overageJson(al, '2026-11', '2026-11', '2026-12');
sql(fill(bumpSourceStatement('C1', 1000)));
sql(fill(markBuiltStatement('C1', 1, 2000, { quotaRows: 0, packRows: 1, fromMonth: '2026-11', toMonth: '2026-12', overageJson: OJ })));
ok('②世代が合えば JSON を書く', got('C1') === `1|${OJ}`, got('C1'));
//   入力が来て世代が進んだあとに、古い世代の作り直しが書き終わる → built=0・JSON も NULL
sql(fill(bumpSourceStatement('C1', 3000)));
sql(fill(markBuiltStatement('C1', 1, 4000, { quotaRows: 0, packRows: 1, fromMonth: '2026-11', toMonth: '2026-12', overageJson: OJ })));
ok('②★競合で世代を 0 に倒すと JSON も NULL', got('C1') === '0|<NULL>', got('C1'));
//   overageJson を渡さない作り直し → NULL（読む側は答えない）
sql(fill(markBuiltStatement('C1', 2, 5000, { quotaRows: 0, packRows: 1, fromMonth: '2026-11', toMonth: '2026-12' })));
ok('②渡さなければ NULL', got('C1') === '2|<NULL>', got('C1'));
//   ★作り直しの番号は、結果（成功・競合）にかかわらず毎回1つ進む（関門②）
const rev = (cid) => Number(sql(`SELECT built_rev FROM customer_sync_version WHERE customer_id='${cid}';`).trim());
const r0 = rev('C1');
sql(fill(markBuiltStatement('C1', 2, 6000, { quotaRows: 0, packRows: 1, fromMonth: '2026-11', toMonth: '2026-12', overageJson: OJ })));
ok('②★同じ世代で作り直しても番号は進む', rev('C1') === r0 + 1, `${r0} → ${rev('C1')}`);
sql(fill(markBuiltStatement('C1', 1, 7000, { quotaRows: 0, packRows: 1, fromMonth: '2026-11', toMonth: '2026-12', overageJson: OJ })));
ok('②競合で倒しても番号は進む', rev('C1') === r0 + 2);
sql(fill(markBuiltStatement('C9', 0, 8000, { quotaRows: 0, packRows: 0, fromMonth: '2026-11', toMonth: '2026-11', overageJson: null })));
ok('②新しい行は 1 から', rev('C9') === 1);
ok('①暦に無い月では作らない', overageJson(al, '2026-11', '2026-11', '2026-13') === null);

// ---------- 3. ★配線：2つの作り直しの経路が JSON を渡している ----------
const Q = rd('worker/src/routes/quota.js'), R = rd('worker/src/routes/quota-rebuild.js');
ok('③/quota/build が渡す', /markBuiltStatement\(cid, ver0\.sourceVersion, now, \{[\s\S]{0,600}?overageJson: overageJson\(cb\.al, nowMonthKeyJst\(now\), from, to\)/.test(Q));
ok('③/quota/rebuild が渡す', /markBuiltStatement\(cid, expected, now, \{[\s\S]{0,300}?overageJson: overageJson\(cb\.al, jstMonthKeyOf\(now\), from, to\)/.test(R));
ok('③markBuilt を呼ぶ場所は2つだけ（増えたらここで気づく）',
   (Q.match(/markBuiltStatement\(/g) || []).length === 1 && (R.match(/markBuiltStatement\(/g) || []).length === 1);

console.log(`\n${fail ? '❌' : '✅'} 支払い待ちを世代の行に 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
