// 取り込み口が書こうとする列が、実際の表にあるか照合する。
//
//   2026-09-28、同じ見落としを2回やった：
//     recurring_patterns と body_records にだけ synced_at が無く、
//     その表だけ「HTTP 500」で取り込めなかった。本番に出すまで気づけなかった。
//   人が表ごとに見比べるのをやめ、ここで機械に照合させる。
//
//   実行: node worker/test/schema-match.test.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { _TABLES_FOR_TEST } from '../src/routes/ingest.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) pass++;
  else { fail++; console.log(`❌ ${name}${detail ? '\n   ' + detail : ''}`); }
}

// SQLの本文から「表ごとの列名」を読み取る
function parseSchema(sql) {
  const tables = {};
  const re = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\n\);/g;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const name = m[1];
    const cols = m[2]
      .split('\n')
      .map((l) => l.replace(/--.*$/, '').trim())
      .filter((l) => l && !/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(l))
      .map((l) => (l.match(/^(\w+)/) || [])[1])
      .filter(Boolean);
    tables[name] = cols;
  }
  return tables;
}

const schema = parseSchema(fs.readFileSync(path.join(here, '..', 'schema.sql'), 'utf8'));

ok('schema.sql から表を読めた', Object.keys(schema).length >= 8,
   '読めた表: ' + Object.keys(schema).join(', '));

for (const [kind, conf] of Object.entries(_TABLES_FOR_TEST)) {
  const cols = schema[conf.table];
  ok(`${kind} → 表 ${conf.table} が存在する`, !!cols);
  if (!cols) continue;

  // 書き込む列がすべて存在するか
  const missing = conf.cols.filter((c) => !cols.includes(c));
  ok(`★${kind}: 書き込む列がすべて表にある`, missing.length === 0,
     missing.length ? `${conf.table} に無い列: ${missing.join(', ')}` : '');

  // 取り込み口は必ず synced_at を書く（これが2回とも原因だった）
  ok(`★${kind}: 表に synced_at がある`, cols.includes('synced_at'),
     cols.includes('synced_at') ? '' : `${conf.table} に synced_at が無い → 取り込みが必ず失敗する`);

  // 主キーが列に含まれているか
  ok(`${kind}: 主キー ${conf.key} が表にある`, cols.includes(conf.key));
}

// 移行ファイルが作り直す表にも synced_at があるか（0001 で recurring を作り直した際の再発防止）
const migDir = path.join(here, '..', 'migrations');
if (fs.existsSync(migDir)) {
  const migSql = fs.readdirSync(migDir).sort()
    .map((f) => fs.readFileSync(path.join(migDir, f), 'utf8')).join('\n');
  const newTables = parseSchema(migSql);
  // 移行で作った一時表（*_nofk 等）のうち、最終的に取り込み先になるものを確認
  const renamed = [...migSql.matchAll(/ALTER TABLE\s+(\w+)\s+RENAME TO\s+(\w+)/g)]
    .map((m) => ({ from: m[1], to: m[2] }));
  for (const r of renamed) {
    const conf = Object.values(_TABLES_FOR_TEST).find((t) => t.table === r.to);
    if (!conf) continue;
    const cols = newTables[r.from];
    if (!cols) continue;
    // ALTER で後から足す場合もあるので、移行全体で足されていれば良しとする
    const added = new RegExp(`ALTER TABLE ${r.to} ADD COLUMN synced_at`).test(migSql);
    ok(`★移行で作り直した ${r.to} に synced_at がある`, cols.includes('synced_at') || added,
       `${r.from} の列: ${cols.join(', ')}`);
  }
}

console.log(`\n表と取り込み口の照合: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
