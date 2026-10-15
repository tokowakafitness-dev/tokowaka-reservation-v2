// コードが使う shadow の入口の名前が、D1 の表の CHECK に全部入っているか（2026-10-15）。
//   実行: node worker/test/shadow-entry-check.test.js
//
// ★なぜ要るのか
//   設計19で入口 'sweep' を足したが、remain_shadow_slot の CHECK が3つの入口しか許さず、
//   10/15 朝の初回は 41名全員の枠を取る INSERT が弾かれた（slot_failed 123回）。
//   テストは D1 を身代わりにしていて、本物の表の制約を見ていなかった。
//   ★列に新しい値を足すときは、表の制約も同時に変える。それを機械で止める。
//
//   見方：migrations を番号順に読み、remain_shadow_slot（作り直しの _new も含む）の
//   **最後の定義**の CHECK を取り出す。コードの入口（顧客の3つ＋sweep）が全部入っていること。
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CUSTOMER_ENTRIES } from '../src/lib/shadow-status.js';
import { SWEEP_ENTRY } from '../src/lib/shadow-sweep.js';
import { SLOT_TABLE } from '../src/lib/remain-shadow.js';
import { DatabaseSync } from 'node:sqlite';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function ok(name, cond, why) { if (cond) { pass++; return; } fail++; console.log(`❌ ${name}`); if (why) console.log(`   ${why}`); }

const files = readdirSync(join(ROOT, 'migrations')).filter((f) => /\.sql$/.test(f)).sort();
let lastCheck = null, lastFile = null;
for (const f of files) {
  const sql = readFileSync(join(ROOT, 'migrations', f), 'utf8').replace(/--[^\n]*/g, '');
  const re = new RegExp('CREATE TABLE(?: IF NOT EXISTS)?\\s+' + SLOT_TABLE + '\\s*\\(([\\s\\S]*?)\\n\\);', 'g');
  let m;
  while ((m = re.exec(sql))) {
    const c = m[1].match(/CHECK\s*\(\s*entry\s+IN\s*\(([^)]*)\)\s*\)/);
    lastCheck = c ? c[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')) : null;
    lastFile = f;
  }
}
ok('1 枠の表（' + SLOT_TABLE + '）の定義が migrations にある', lastFile != null);
const used = CUSTOMER_ENTRIES.concat([SWEEP_ENTRY]);
ok('2 ★コードが使う入口と表の CHECK が完全に一致する（CHECK が無いのも不合格）',
   Array.isArray(lastCheck) && lastCheck.length === used.length && used.every((e) => lastCheck.includes(e)),
   `最後の定義 ${lastFile} の CHECK=${JSON.stringify(lastCheck)} / コード=${JSON.stringify(used)}`);
ok('3 schema.sql に別の定義が無い（あると新しい環境で古い制約に戻る）', !/remain_shadow_slot/.test(readFileSync(join(ROOT, 'schema.sql'), 'utf8')));

// ★コードの SQL が見ている表が SLOT_TABLE と同じ（文字のずれで別の表を見ない）
const SH = readFileSync(join(ROOT, 'src/lib/remain-shadow.js'), 'utf8');
const ST = readFileSync(join(ROOT, 'src/lib/shadow-status.js'), 'utf8');
const shTables = [...SH.matchAll(/(?:INSERT INTO|FROM)\s+(remain_shadow_slot\w*)/g)].map((m) => m[1]);
ok('4 枠を取る SQL は全部 SLOT_TABLE を見る', shTables.length >= 5 && shTables.every((t) => t === SLOT_TABLE), JSON.stringify(shTables));
ok('5 集計も SLOT_TABLE を見る（古い表を見ない）', !/FROM remain_shadow_slot\b(?!2)/.test(ST) && /\$\{SLOT_TABLE\}/.test(ST));

// ★本物の SQLite で migration を流す（D1 の身代わりが制約を再現しなかったのが事故の原因）
{
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(ROOT, 'migrations/0015_remain_shadow.sql'), 'utf8'));
  db.prepare("INSERT INTO remain_shadow_slot VALUES ('2026-10-14','C1','boot','time:08-15',1)").run();
  db.prepare("INSERT INTO remain_shadow_slot VALUES ('2026-10-14','C2','compat_home','time:16-23',2)").run();
  let rejectedBefore = false; try { db.prepare("INSERT INTO remain_shadow_slot VALUES ('2026-10-15','C1','sweep','time:00-07',3)").run(); } catch (_) { rejectedBefore = true; }
  ok('6 古い表は sweep を弾く（事故の再現）', rejectedBefore);
  const m18 = readFileSync(join(ROOT, 'migrations/0018_shadow_slot_allow_sweep.sql'), 'utf8');
  db.exec(m18);
  const n = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  ok('7 ★古い表は消えずに残る', n('remain_shadow_slot') === 2);
  ok('8 ★記録は新しい表へ全部移る（件数が一致）', n(SLOT_TABLE) === 2);
  db.exec(m18);
  ok('9 もう一度流しても同じ（重ならない）', n(SLOT_TABLE) === 2);
  db.prepare(`INSERT INTO ${SLOT_TABLE} VALUES ('2026-10-15','C1','sweep','time:00-07',3)`).run();
  ok('10 新しい表は sweep を受け付ける', n(SLOT_TABLE) === 3);
  let bad = false; try { db.prepare(`INSERT INTO ${SLOT_TABLE} VALUES ('2026-10-15','C1','xxx','time:00-07',4)`).run(); } catch (_) { bad = true; }
  ok('11 知らない入口は弾く', bad);
}

console.log(`${fail ? '❌' : '✅'} shadow の入口と表の制約 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
