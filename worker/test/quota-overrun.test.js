// 枠を超えて予約が入っていることに気づける検査
//
//   ★なぜ要るのか（2026-10-03）
//     会員#2412 で、10月の枠8回に対して10件の予約が入っていた。
//     残数の計算は正しく0回を出していたが、**予約の受付が通りすぎていた。**
//     そしてオーナーが気づいたのは偶然で、気づかなければそのままだった。
//
//   ★なぜ数え方を作り直したか（2026-10-04）
//     最初は「月額の枠 < 予約の件数」で数えた。**チケットを見ていなかった。**
//     月額3回＋チケット2枚の会員が4件予約していると「1件超過」と誤って出した。
//     誤検知はオーナーの確認の手間を増やすだけでなく、本物の超過をその中に埋もれさせる。
//
//     正しいのは「割り当てられなかった予約の数」を見ること。
//     割当器は、月額にもチケットにも割り当たらなかった予約を unallocated にする。
//     ★ところがそれは残数のどこにも現れない（monthlyRem は quota - used で、
//       used は月額に割り当たった分だけ）。だから「枠8に予約10」でも残数は0で止まる。
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

// ---------- 1. ★超過は「割り当たらなかった予約の数」で見ること ----------
ok('①割当の結果を見ている', /_ps\.alloc !== 'unallocated'/.test(SRC));
ok('①今月と翌月を分けて数えている',
  /_ps\.monthKey === nowKey\) _unCur\+\+/.test(SRC) && /_ps\.monthKey === nextKey\) _unNext\+\+/.test(SRC));
//   ★文言を変えた（2026-10-08・オーナー説明）。
//     枠を超えた予約は異常ではなく「支払い待ち」。未登録顧客の予定を作るとき、
//     既存顧客の未払いチケット分を先に押さえる運用がある。
//     次回のセッションで支払いをいただき、チケットを付与して相殺する。
//     「超過」とだけ出すと異常に見え、オーナーの確認の手間が増えて本物の異常が埋もれる。
ok('①何件あるかを出す', /'支払い待ち' \+ _unCur \+ '件（チケット付与で相殺）'/.test(SRC));
ok('①翌月も出す', /'翌月の支払い待ち' \+ _unNext \+ '件'/.test(SRC));
ok('①★月末が近いときは締まらないことを書く',
  /月末まで' \+ _dLeft \+ '日・このままだと月全体が締まりません/.test(SRC),
  '相殺しないまま月が終わると、1名でも未裁定で月全体が締まらない');

// ★月額の枠と件数を直接比べる古い判定が残っていないこと（これが誤検知の正体）
ok('①★「枠 < 予約件数」で超過と決めていない',
  !/curShow > avail/.test(SRC) && !/nextShow > availNext/.test(SRC),
  'チケットを持つ会員で必ず誤検知する');

// ---------- 2. 「枠と残りが合わない」もチケットを含めて数えること ----------
ok('②割当の結果の件数と突き合わせている',
  /if \(curN !== _sumCur\) flags\.push\('枠と残りが合わない'\)/.test(SRC));
ok('②★「枠 − 残り」と直接比べる古い判定が残っていない',
  !/curN !== \(avail - rem\)/.test(SRC),
  'チケットで消化した予約がこの式に入らない');

// ---------- 3. 計算の返り値に割当の結果が入っていること ----------
{
  const AL = readFileSync(join(ROOT, 'gas/Allocate.js'), 'utf8');
  const LB = readFileSync(join(ROOT, 'gas/LineBooking.js'), 'utf8');
  const WK = readFileSync(join(ROOT, 'worker/src/allocate.js'), 'utf8');
  ok('③計算が割当の結果を返す', /perSession: res\.perSession/.test(AL));
  ok('③★Worker側も同じ（片方だけ直さない）', /perSession: res\.perSession/.test(WK));
  ok('③残数の入口が素通しする', /_perSession: a\.perSession/.test(LB));
}

// ---------- 4. 読み取れなかったときに「超過なし」と言わないこと ----------
//   割当の結果が無いのに「0件超過」と見なすと、黙って見逃す。
ok('④割当の結果が無ければ数えない', /if \(rvalsOk && sp && sp\._perSession\)/.test(SRC));
ok('④合計の検査も同じ条件',
  /if \(rvalsOk && sp && sp\._perSession && avail != null && rem != null\)/.test(SRC));

// ---------- 5. 予約が「いつ・どこから」入ったかも出していること ----------
//   枠を超えていたとき、先に取ったのか後から増えたのか、
//   どの入口から入ったのかが分からないと原因を切り分けられない。
ok('⑤取得の時刻を出している', /' \/ 取得=' \+ _ca/.test(SRC));
ok('⑤★月をまたいで取られた予約に印を付ける', /◀前の月に取得/.test(SRC));
ok('⑤★どの入口から入ったかを出す', /' \/ 入口=' \+ _via/.test(SRC));
ok('⑤時刻が無ければ「不明」と書く（0扱いにしない）', /x\.createdAt \? Utilities\.formatDate/.test(SRC));

console.log(`\n${fail ? '❌' : '✅'} 枠の超過に気づく 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
