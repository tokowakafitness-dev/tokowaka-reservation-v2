// 検証用の会員を作る処理の守りを固定する。
//   実行: node worker/test/verify-member.test.js
//
// ★なぜ要るのか（設計 ops/design/09-entry-verify-run.md）
//   自然には起きない6つの入口（代行・一括・振替・未登録客・ブロック・後付け紐付け）を
//   通して二重書きを確かめたい。うち4つは会員が必要。
//   実在の会員を使うと、**取消が失敗したときその方の残数が狂ったまま残る。**
//   だから触っても誰も困らない会員を1人だけ作る（オーナー承認・2026-10-08）。
//
// ★本番のシートに行を足す処理なので、守りを機械で固定する。

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const EA = readFileSync(join(ROOT, 'gas/EdgeAudit.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  cond ? pass++ : (fail++, console.log(`❌ ${name}${extra ? '\n   ' + extra : ''}`));
}

console.log('=== 1. 通知が実在の誰かに飛ぶ経路を作らない ===');
ok('①★LINEには連携しない',
  /★LINE_USER_ID は空のまま＝LINE未連携/.test(EA)
  && !/row\[MAP_COL\.LINE_USER_ID - 1\]\s*=/.test(EA),
  'LINEのIDを入れると、通知の止め忘れで実在の誰かに届きうる');

console.log('=== 2. 何度実行しても増えない ===');
ok('②名簿は顧客IDで重複を見る',
  /String\(mv\[i\]\[MAP_COL\.CUSTOMER_ID - 1\]\) === LB_VERIFY_CUSTOMER_ID/.test(EA));
ok('②既にあれば何もしない', /名簿：すでにあります（何もしません）/.test(EA));
ok('②契約も重複を見る', /契約：すでにあります（何もしません）/.test(EA));

console.log('=== 3. 一目で分かる名前にする ===');
ok('③氏名に「予約しないでください」が入る',
  /LB_VERIFY_NAME = '検証用（予約しないでください）'/.test(EA),
  '各種の一覧に1名増えるので、見分けられないと混乱する');
ok('③備考にも理由を書く', /検証用。段階3-aの入口確認に使う。予約を入れないでください。/.test(EA));

console.log('=== 4. 読めなければ書かない ===');
ok('④名簿が読めなければ中止', /名簿が読めません。中止します。/.test(EA));
ok('④契約の見出しが読めなければ中止',
  /契約シートの見出しが読めません/.test(EA)
  && /cols\.name < 0 \|\| cols\.method < 0 \|\| cols\.freq < 0 \|\| cols\.start < 0/.test(EA),
  '列を間違えて書くと、他の会員の計算まで巻き込む');

console.log('=== 5. 契約の中身（あとで困らない値にする）===');
ok('⑤月額・頻度8', /crow\[cols\.freq\]\s*=\s*8;/.test(EA));
ok('⑤★頻度を多めにする理由を書いている',
  /振替の下準備で1回消費する/.test(EA));
ok('⑤開始は今月初日・終了は空（継続）',
  /new Date\(now\.getFullYear\(\), now\.getMonth\(\), 1\)/.test(EA));
ok('⑤★単価を入れる（締めで全員を止めないため）',
  /crow\[cols\.ticketPrice\] = 10800/.test(EA)
  && /MONTHLY_PRICE_MISSING で月全体が止まる/.test(EA),
  '単価が無いと、もし将来この月を締めたとき検証用の1名が全員を止める');

console.log('=== 6. 照合の計算に乗る状態にする ===');
ok('⑥照合済み扱いにする', /row\[MAP_COL\.AUTH_STATE - 1\]\s*=\s*'verified'/.test(EA));
ok('⑥契約状況は active', /row\[MAP_COL\.CONTRACT_STAT - 1\]\s*=\s*'active'/.test(EA));

console.log('');
console.log(`${fail ? '❌' : '✅'} 検証用の会員 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
