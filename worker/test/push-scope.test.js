// 押し出しの「全件を走査したか」と「古い行を消してよいか」を分けたことの検証
//
//   ★なぜ分けたか（2026-10-03・Codexの設計レビュー）
//     以前は `full` ひとつで両方を表していた。そのため
//       ・15分ごとの同期（全件を送っているのに full=false）
//       ・予約直後の1人ぶん（full=false）
//     が区別できず、Worker側で全体の同期時刻を押す条件を作れなかった。
//     結果、1人が予約するたびに予約一覧全体が「たったいま同期した」ことになり、
//     他の顧客の古い予約を新しいものとして返しうる状態だった。
//
//   ★既定値を持たせない理由
//     既定を 'partial' にすると、新しい呼び出しを足したときに書き忘れても
//     黙って「同期時刻を押さない」状態になり、遅くなった理由が分からなくなる。
//     **安全に失敗することと、黙って劣化することは別。** 書き忘れは例外で止める。
//
//   実行: node worker/test/push-scope.test.js

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const SRC = readFileSync(join(ROOT, 'gas/PushToEdge.js'), 'utf8');

let pass = 0, fail = 0;
function eq(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log(`❌ ${name}\n   got : ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`); }
}
function ok(name, cond, extra) { cond ? pass++ : (fail++, console.log(`❌ ${name}${extra ? '\n   ' + extra : ''}`)); }

// ---------- 1. 書き忘れを例外で止めること ----------
ok('①scope が無ければ例外', /scope !== 'all' && scope !== 'partial'[\s\S]{0,200}throw new Error/.test(SRC));
ok('①★矛盾（消すのに全件でない）も例外', /full && scope !== 'all'[\s\S]{0,200}throw new Error/.test(SRC));
ok('①既定値を持たせていない', !/scope\s*=\s*_o\.scope\s*\|\|/.test(SRC) && !/scope:\s*full\s*\?/.test(SRC));
ok('①送信に scope を載せている', (SRC.match(/scope:\s*scope/g) || []).length >= 2);

// ---------- 2. ★すべての呼び出しが scope を書いていること ----------
//   1つでも漏れると、その表だけ同期時刻が押されず、理由の分からない遅さになる。
{
  const calls = [...SRC.matchAll(/_edgePushRowsF?\((?!kind)[^;]*?\);/gs)].map((m) => m[0]);
  ok('②呼び出しを拾えた', calls.length >= 10, `${calls.length}個`);
  // 値は 'all' / 'partial' の直書きでも、条件式（_done ? 'all' : 'partial'）でもよい。
  //   どちらにせよ、その2つ以外の値が入る書き方は認めない。
  const hasScope = (c) => /scope:\s*[^,}]+/.test(c) && /'all'|'partial'/.test(c);
  const noScope = calls.filter((c) => !hasScope(c))
                       .map((c) => c.replace(/\s+/g, ' ').slice(0, 70));
  eq('②★scope を書いていない呼び出しが無い', noScope, []);
}

// ---------- 3. 全件走査かどうかが、実態と合っていること ----------
//   ここを取り違えると「全件のつもりで一部しか送っていない」まま同期時刻が押され、
//   古い行が新しいものとして残る。1人ぶんの押し出しで起きていた事故と同じ形。
ok("③予約直後の1人ぶんは partial",
  /_edgePushRows\('reservations', mine, Date\.now\(\), \{ scope: 'partial' \}\)/.test(SRC));
ok("③1トレーナーぶんの枠も partial",
  /_edgePushRows\('slots', mine, Date\.now\(\), \{ scope: 'partial' \}\)/.test(SRC));
ok("③1人ぶんの残数も partial",
  /_edgePushRows\('home', rows, Date\.now\(\), \{ scope: 'partial' \}\)/.test(SRC));
ok("③15分ごとの全件同期は all", /_edgePushRowsF\('reservations', _edgeReservations\(\), batchId, \{ scope: 'all'/.test(SRC));
ok("③枠だけの同期（全トレーナー）も all", /_edgePushRowsF\('slots', _edgeSlotRows\(\), batchId, \{ scope: 'all'/.test(SRC));

// ★残数は時間切れで途中までしか送れないことがある。
//   「全件処理から呼ばれた」ことは全件を見終えたことを意味しない（Codex指摘）。
ok('③★残数は全員ぶん送れたときだけ all',
  /_done = \(rows\.length >= all\.length\)[\s\S]{0,300}scope: _done \? 'all' : 'partial'/.test(SRC));
ok('③★時間切れなら古い行も消さない',
  /deleteStale: !!full && _done/.test(SRC));

// ---------- 4. 「消す」のは全件走査のときだけ ----------
{
  const calls = [...SRC.matchAll(/\{ scope: '(\w+)', deleteStale: ([^}]+) \}/g)];
  const bad = calls.filter(([, scope, del]) => scope !== 'all' && !/false/.test(del))
                   .map(([all]) => all);
  eq('④★一部しか送っていないのに消す指定が無い', bad, []);
}

// ---------- 5. 位置引数の名残が無いこと ----------
//   `_edgePushRows(kind, rows, batchId, full)` の形が1つでも残ると、
//   full（真偽値）が opts として渡り、scope が undefined になって例外で止まる。
//   例外で止まるのは安全側だが、本番の押し出しが丸ごと止まるので事前に潰す。
ok('⑤真偽値をそのまま渡している呼び出しが無い',
  !/_edgePushRowsF?\([^;]*?,\s*(full|true|false)\s*\)/.test(SRC));
ok('⑤入口の引数名が opts になっている', /function _edgePushRows\(kind, rows, batchId, opts\)/.test(SRC));
ok('⑤薄い包みも opts を素通しする', /function _edgePushRowsF\(kind, rows, batchId, opts\)/.test(SRC));

// ---------- 6. ★消えたものが写しに残らないこと（2026-10-03・Codexの最終判定）----------
//
//   顧客が「キャンセルしたのに予約が残っている」「削除したのに固定枠がある」と
//   見える状態を作らない。表によって「消えたことの伝え方」が違うので、
//   それぞれに合った手段を取っているかを確かめる。

// 予約：行は消えず、状態が変わる（confirmed → cancelled / changed）。
//   だから**状態をそのまま写せば**消えたことが伝わる。削除は要らない。
ok('⑥予約は取消・変更の状態も写している',
  /\(st === 'cancelled'\) \? 'cancelled'/.test(SRC) && /\(st === 'changed'\)\s+\? 'changed'/.test(SRC));
ok('⑥予約を「予約中だけ」に絞って写していない',
  !/if \(st !== 'confirmed'\) continue/.test(SRC));

// 固定枠：**行ごと消える**（deleteRecurringPattern が deleteRow する）。
//   状態では表せないので、ふだんの同期でも「含まれなかった行＝消えた行」として落とす。
ok('⑥★固定枠はふだんの同期でも消す',
  /_edgePushRowsF\('recurring', _edgeRecurring\(\), batchId, \{ scope: 'all', deleteStale: true \}\)/.test(SRC));

// ★そのためには「読めなかった」と「本当に0件」を区別しなければならない。
//   読めなかったときに 0件 を送ると、**全件が消える。**
{
  const fn = (SRC.match(/function _edgeRecurring\(\)[\s\S]*?\n\}/) || [])[0] || '';
  ok('⑥固定枠の取り出しが読める', !!fn);
  ok('⑥★読めなかったら null（送信ごと中止）', /if \(!sh\) return null;/.test(fn));
  ok('⑥本当に0件なら空配列', /getLastRow\(\) < 2\) return \[\];/.test(fn));
  ok('⑥★「読めない」と「0件」を同じ返り値にしていない',
     !/if \(!sh \|\| sh\.getLastRow\(\) < 2\) return \[\];/.test(fn));
}

// 予約も同じ作法（読めなかったら null）になっていること
ok('⑥予約も読めなかったら null', /if \(!sh\) return null;[\s\S]{0,120}getLastRow\(\) < 2\) return null;/.test(SRC));

// ★消す指定を持つのは固定枠と日次完全同期だけ。他の表に広げない。
//   予約や顧客で毎回消すと、一時的に読めなかっただけで全件が消える危険がある。
{
  const always = [...SRC.matchAll(/_edgePushRowsF\('(\w+)',[^;]*?deleteStale: true/gs)].map((m) => m[1]);
  eq('⑥ふだんの同期で消すのは固定枠だけ', always, ['recurring']);
}

console.log(`\n${fail ? '❌' : '✅'} 押し出しの走査範囲 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
