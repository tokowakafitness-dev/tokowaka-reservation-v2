// 超過を顧客の画面に出すことの検証（2026-10-04 オーナー要望）
//
//   枠にもチケットにも割り当たらなかった予約が「超過」。
//   それまでは残数が0で止まるだけで、超過は画面のどこにも出なかった
//   （monthlyRemaining は quota - used で、used は月額に割り当たった分だけ）。
//
//   ★いちばん危ないのは、既存の数字を負数にしてしまうこと。
//     monthlyRemaining は予約の可否・締め・請求・リマインドの文面・D1の写しが使っている。
//     負数にすると「今月はあと -2回ご利用いただけます」という案内が出る（Codexの関門①で指摘）。
//     だから**表示専用の値を新しく作り、顧客の画面だけがそれを読む**。
//
//   実行: node worker/test/overage-display.test.js

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const LB   = readFileSync(join(ROOT, 'gas/LineBooking.js'), 'utf8');
const HTML = readFileSync(join(ROOT, 'liff/index.html'), 'utf8');
const NUDGE = readFileSync(join(ROOT, 'gas/Nudge.js'), 'utf8');
const PUSH = readFileSync(join(ROOT, 'gas/PushToEdge.js'), 'utf8');

let pass = 0, fail = 0;
function eq(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log(`❌ ${name}\n   got : ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`); }
}
function ok(name, cond, extra) { cond ? pass++ : (fail++, console.log(`❌ ${name}${extra ? '\n   ' + extra : ''}`)); }

// ---------- ① 表示専用の値が増えていること ----------
ok('①超過の件数を返す', /overageCount: _lbOverageOf\(sp, _ovKey\)/.test(LB));
ok('①表示用の残りを返す', /displayRemaining:/.test(LB));
ok('①支払いの要否を返す', /paymentRequired: _lbOverageOf\(sp, _ovKey\) > 0/.test(LB));

// ---------- ② ★既存の数字を負数にしていないこと ----------
//   ここが壊れると、リマインド・締め・請求・D1の写しに負数が流れる。
{
  //   ファイル全体で見る。返り値のブロックを正規表現で切り出すと、
  //   書式が変わっただけで落ちる（検査したいのは書式ではなく中身）。
  ok('②★monthlyRemaining は従来のまま', /monthlyRemaining: sp\.monthlyRem,/.test(LB));
  ok('②★ticketRemaining は従来のまま', /ticketRemaining: sp\.ticketRem,/.test(LB));
  ok('②★remaining は従来のまま',
     /remaining: \(type === 'ticket'\) \? sp\.ticketRem : sp\.monthlyRem,/.test(LB));
  // 既存キーに引き算を入れていないこと
  ok('②★既存キーから超過を引いていない',
     !/monthlyRemaining: [^,\n]*_lbOverageOf/.test(LB) && !/remaining: [^,\n]*_lbOverageOf/.test(LB));
}

// ---------- ③ ★リマインドが新しい値を読まないこと ----------
//   毎月25日の案内は remain をそのまま文面に差し込む。
//   新しい値を読むと「今月はあと -2回ご利用いただけます」が出る。
ok('③★リマインドが表示用の値を読んでいない',
  !/displayRemaining|overageCount|paymentRequired/.test(NUDGE));

// ---------- ④ 対象の月だけを数えること ----------
//   他の月の超過を混ぜると、顧客の画面が理由なく赤くなる。
{
  const fn = (LB.match(/function _lbOverageOf\(sp, monthKey\)[\s\S]*?\n\}/) || [])[0] || '';
  ok('④超過を数える関数がある', !!fn);
  ok('④★対象の月だけ数える', /String\(ps\.monthKey\) !== String\(monthKey\)\) continue/.test(fn));
  ok('④割り当たらなかったものだけ数える', /ps\.alloc !== 'unallocated'\) continue/.test(fn));
  // ★入力の誤り（人数が不正・種別が不明など）を「お支払いが必要な超過」に混ぜない
  ok('④★入力の誤りを超過に混ぜない', /LB_OVERAGE_REASONS\[String\(ps\.reason\)\]\) continue/.test(fn));
  ok('④数える理由を列挙してある', /var LB_OVERAGE_REASONS = \{[^}]+\}/.test(LB));
  // 計算が信用できないときは数えない
  ok('④計算が信用できなければ0', /!sp\._ok \|\| !sp\._perSession/.test(fn));
}

// ---------- ⑤ 月のキーを正しく渡していること ----------
//   `month` は「今月の予約件数」であって月ではない。実際そこを一度取り違えた。
ok('⑤月のキーを別に作っている', /var _ovKey = _lbMonthKeyJst\(new Date\(\)\.getTime\(\)\)/.test(LB));
ok('⑤★件数を月のキーとして渡していない', !/_lbOverageOf\(sp, month\)/.test(LB));

// ---------- ⑥ 画面が表示専用の値を読むこと ----------
ok('⑥画面が超過の件数を読む', /var _ov = Number\(h\.overageCount \|\| 0\)/.test(HTML));
ok('⑥★超過があればマイナスで出す', /var _shown = \(_ov > 0\) \? -_ov : mp\.total/.test(HTML));
ok('⑥理由と支払いの要否を添える', /t\('overage_note', \{ n: _ov \}\)/.test(HTML));
// 文言が4言語そろっていること
eq('⑥文言が4言語ぶんある', (HTML.match(/overage_note:/g) || []).length, 4);
// 「超過」と「お支払い」の両方を伝えること（どちらか欠けると意味が通らない）
{
  const ja = (HTML.match(/overage_note:'([^']*)'/) || [])[1] || '';
  ok('⑥日本語が超過に触れている', /超過/.test(ja), ja);
  ok('⑥日本語が支払いに触れている', /お支払い/.test(ja), ja);
}

// ---------- ⑦ D1の写しに新しい値が載ること（画面がWorker経由でも出るように）----------
//   押し出しは _lbBuildHome の返り値をそのまま写すので、載るはず。
//   ★ここが載っていないと、Worker経由の画面だけ超過が出ない（経路で見え方が変わる）。
ok('⑦押し出しがホームの返り値をそのまま写している',
  /payload: JSON\.stringify\(\{ currentMonth: curKey, nextMonth: nextKey, current: cur, next: nxt \}\)/.test(PUSH));

console.log(`\n${fail ? '❌' : '✅'} 超過の表示 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
