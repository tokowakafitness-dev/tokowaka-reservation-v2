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

// ---------- ⑤ 同期の間隔と、鮮度の判定が食い違わないこと ----------
//
//   2026-10-02：GASの定期同期を1分ごとで登録したが、TOKOWAKAのGASは無料アカウントで
//   実行枠が1日90分しかない。1440回×数秒で枠を使い切り、**リマインド・予約通知・
//   残数の押し出しが全部止まる**ところだった。5分ごとに緩めた。
//
//   そのとき鮮度（FRESH_MS）を2分のままにすると、更新直後の2分しか使えず
//   残り3分はGASへ落ちる＝D1を作った意味がなくなる。
//   **どちらか片方だけを変えると壊れる**ので、関係を機械で止める。
{
  const PUSH = readFileSync(join(ROOT, 'gas/PushToEdge.js'), 'utf8');
  const READ = readFileSync(join(ROOT, 'worker/src/lib/calread.js'), 'utf8');

  const everyMin = Number((PUSH.match(/EVERY_MINUTES:\s*(\d+)/) || [])[1]);
  const freshExpr = (READ.match(/export const FRESH_MS = ([^;]+);/) || [])[1];
  const freshMs = freshExpr ? Function('return (' + freshExpr + ')')() : NaN;

  ok('⑤同期の間隔が設定から読める', Number.isFinite(everyMin));
  ok('⑤鮮度が設定から読める', Number.isFinite(freshMs));

  // 鮮度は「間隔＋実行の揺れ」より長くないと、D1がほぼ常に使えない
  ok('⑤鮮度は同期の間隔より長い（' + everyMin + '分 < ' + (freshMs / 60000) + '分）',
     freshMs > everyMin * 60000);
  // ただし長すぎると古い空き枠を見せることになる。いまのキャッシュ（11分）より短く保つ
  ok('⑤鮮度は11分より短い（いまのキャッシュより新しい）', freshMs < 11 * 60 * 1000);
  // 間隔の2倍までを目安にする（1回失敗しても次で拾える）
  ok('⑤鮮度は同期の間隔の2倍以内（失敗1回は吸収し、2回続けば落とす）',
     freshMs <= everyMin * 60000 * 2);

  // 無料アカウントの実行枠に収まるか（1日90分）
  const runsPerDay = (24 * 60) / everyMin;
  const secPerRun = 5;                                  // 本番実測：カレンダー5本・344件で約4秒。余裕を見て5秒
  const minPerDay = runsPerDay * secPerRun / 60;
  ok('⑤1日の実行時間が無料枠90分に収まる（約' + Math.round(minPerDay) + '分）', minPerDay < 90);
  // 他の処理（edgeJobPoll など）と合わせても余裕があること。半分以下を目安にする
  ok('⑤他の定期処理と合わせても余裕がある（枠の半分以下）', minPerDay < 45);

  // 1分ごとに戻していないこと（戻すと枠を超える）
  ok('⑤1分ごとに戻していない', !/everyMinutes\(1\)\.create\(\);[\s\S]{0,80}TICK_HANDLER/.test(PUSH));
  ok('⑤間隔は設定から読む（直書きしない）',
     /everyMinutes\(LB_CALSYNC\.EVERY_MINUTES\)/.test(PUSH));
}

console.log('\n設定の食い違い 検証: ' + pass + ' passed / ' + fail + ' failed');
process.exit(fail ? 1 : 0);
