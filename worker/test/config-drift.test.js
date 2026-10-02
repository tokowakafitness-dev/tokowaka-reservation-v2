// 設定の食い違いを機械で止める検査
//
//   2026-10-02、オーナーに「D1にテーブルを作ってください」とお願いし、
//   package.json に書かれていたコマンドをそのままお渡しした。
//   ところがそのコマンドのDB名は `tokowaka` で、Workerが実際に使うのは
//   `tokowaka-apac` だった。**別のデータベースにテーブルを40個作ってしまった。**
//   しかもデプロイのワークフローが schema.sql を自動で流すので、
//   そもそも手で流す必要がなかった。
//
//   原因は「同じ設定が3か所（wrangler.toml / ワークフロー / package.json）に
//   書かれていて、1つだけ古かった」こと。人が気づくのを期待してはいけない。
//
//   実行: node worker/test/config-drift.test.js

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');

let pass = 0, fail = 0;
function ok(n, c) { if (c) pass++; else { fail++; console.log('❌ ' + n); } }
function eq(n, g, w) {
  if (JSON.stringify(g) === JSON.stringify(w)) pass++;
  else { fail++; console.log('❌ ' + n + '\n   got : ' + JSON.stringify(g) + '\n   want: ' + JSON.stringify(w)); }
}

const TOML = readFileSync(join(ROOT, 'worker/wrangler.toml'), 'utf8');
const WF   = readFileSync(join(ROOT, '.github/workflows/worker-deploy.yml'), 'utf8');
const PKG  = readFileSync(join(ROOT, 'worker/package.json'), 'utf8');

// ---------- ① D1の名前が3か所で一致していること ----------
const tomlName = (TOML.match(/database_name\s*=\s*"([^"]+)"/) || [])[1];
const wfName   = (WF.match(/D1_NAME:\s*(\S+)/) || [])[1];

ok('①wrangler.toml にD1の名前がある', !!tomlName);
ok('①ワークフローにD1の名前がある', !!wfName);
eq('①Workerがバインドする名前と、ワークフローが流す先が同じ', tomlName, wfName);

// package.json に「別の名前でD1を叩くコマンド」が残っていないこと。
//   ここが古いまま残っていたのが、今回オーナーに誤った手順を渡した原因。
const d1Cmds = PKG.match(/wrangler d1 execute\s+(\S+)/g) || [];
for (const c of d1Cmds) {
  const name = c.replace(/wrangler d1 execute\s+/, '');
  ok('①package.json のD1コマンドが正しい名前を使う: ' + name, name === tomlName);
}

// ---------- ② 手で流す必要がないことが分かる形になっていること ----------
ok('②デプロイのワークフローが schema.sql を流す',
   /wrangler d1 execute\s+"\$D1_NAME"\s+--remote\s+--file=schema\.sql/.test(WF));
ok('②worker/ の変更でワークフローが動く', /paths:[\s\S]{0,80}'worker\/\*\*'/.test(WF));
// package.json の schema は「手で流すな」と言うだけにしてある
ok('②package.json の schema は手で流させない',
   !/^\s*"schema":\s*"wrangler d1 execute/m.test(PKG));

// ---------- ③ D1のIDを人が貼る運用になっていないこと ----------
//   貼り間違いが起きるので、ワークフローが名前から引いて差し込む作りになっている
ok('③wrangler.toml のIDは置き場所だけ（人が貼らない）',
   /database_id\s*=\s*"PASTE_D1_ID_HERE"/.test(TOML));
ok('③ワークフローが名前からIDを引く', /d1\s+list[\s\S]{0,400}select\(\.name==\$n\)/.test(WF));

// ---------- ④ 新しい経路がワークフローの対象に入っていること ----------
const INDEX = readFileSync(join(ROOT, 'worker/src/index.js'), 'utf8');
ok('④/calsync の経路が登録されている', /url\.pathname === '\/calsync'/.test(INDEX));
ok('④/calsync は POST だけ受ける', /'\/calsync'[\s\S]{0,200}request\.method !== 'POST'/.test(INDEX));
ok('④/calsync の実装を読み込んでいる', /from '\.\/routes\/calsync\.js'/.test(INDEX));

console.log('\n設定の食い違い 検証: ' + pass + ' passed / ' + fail + ' failed');
process.exit(fail ? 1 : 0);
