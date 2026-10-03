// 枠を超えて予約が入っていることに気づける検査
//
//   ★なぜ要るのか（2026-10-03）
//     会員#2412 で、10月の枠8回に対して10件の予約が入っていた。
//     残数の計算は正しく0回を出していたが、**予約の受付が通りすぎていた。**
//     そしてオーナーが気づいたのは偶然で、気づかなければそのままだった。
//     超過は顧客との金銭の話になる（今回は請求で解決したが、毎回そうとは限らない）。
//
//   ★原因を1つ塞ぐことと、気づける状態にしておくことは別。
//     原因は1つとは限らず、別の経路でまた起こりうる。
//     毎日見る残数の一覧に出しておけば、何が原因でも目に入る。
//
//   実行: node worker/test/quota-overrun.test.js

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const SRC = readFileSync(join(ROOT, 'gas/EdgeAudit.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) { cond ? pass++ : (fail++, console.log(`❌ ${name}${extra ? '\n   ' + extra : ''}`)); }

// ---------- 1. 超過を見ていること ----------
ok('①今月の超過を見ている', /curShow > avail/.test(SRC));
ok('①翌月の超過も見ている', /nextShow > availNext/.test(SRC));
ok('①何件超えているかを出す', /件超過/.test(SRC));
ok('①警告の並びに載せている', /flags\.push\('今月が'/.test(SRC) && /flags\.push\('翌月が'/.test(SRC));

// ---------- 2. ★使う変数が、定義より後で使われていること ----------
//   JavaScript の var は巻き上げられるので、定義より前で使っても
//   エラーにならず **undefined** になる。超過があっても黙って見逃す。
//   実際この検査を足したとき、最初に書いた位置が定義より前だった。
{
  const iCur  = SRC.indexOf('var curShow =');
  const iNext = SRC.indexOf('var nextShow =');
  const uCur  = SRC.indexOf('curShow > avail');
  const uNext = SRC.indexOf('nextShow > availNext');
  ok('②今月の件数が定義されている', iCur > 0);
  ok('②翌月の件数が定義されている', iNext > 0);
  ok('②★今月の超過は定義の後で見ている', uCur > iCur, `定義=${iCur} 使用=${uCur}`);
  ok('②★翌月の超過は定義の後で見ている', uNext > iNext, `定義=${iNext} 使用=${uNext}`);
}

// ---------- 3. 読み取れなかったときに「超過なし」と言わないこと ----------
//   予約表が読めなかったら件数は null になる。
//   null を 0 として比べると「0件 ≦ 枠」で**超過なしに見える**。
ok('③★件数が無いときは超過と判定しない',
  /curShow != null && curShow > avail/.test(SRC));
ok('③★翌月も同じ', /nextShow != null && nextShow > availNext/.test(SRC));
ok('③予約表が読めたときだけ今月を見る', /rvalsOk && avail != null && curShow != null/.test(SRC));

// ---------- 4. 予約が「いつ取られたか」も出していること ----------
//   枠を超えていたとき、先に取ったのか後から増えたのかは
//   取得の時刻が無いと切り分けられない。
ok('④取得の時刻を出している', /' \/ 取得=' \+ _ca/.test(SRC));
ok('④★月をまたいで取られた予約に印を付ける', /◀前の月に取得/.test(SRC));
ok('④印の判定が月の比較になっている',
  /_lbMonthKeyJst\(x\.createdAt\) !== keys\[k\]/.test(SRC));
ok('④時刻が無ければ「不明」と書く（0扱いにしない）', /x\.createdAt \? Utilities\.formatDate/.test(SRC));

console.log(`\n${fail ? '❌' : '✅'} 枠の超過に気づく 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
