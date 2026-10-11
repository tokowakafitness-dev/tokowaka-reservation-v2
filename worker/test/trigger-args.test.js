// トリガーから呼ばれる関数の引数（2026-10-11）
//
//   ★なぜ要るのか
//     **時間主導のトリガーは、第1引数にイベントオブジェクトを渡す。**
//     これを知らずに `function dailyHealthCheck(dryRun)` と書いていたため、
//     トリガーから呼ばれると dryRun にオブジェクトが入り、オブジェクトは真なので
//     **dryRun が常に真**になっていた。
//
//     結果（3つとも、2026-10-11 まで誰も気づかなかった）：
//       dailyHealthCheck   記録もメールも一度も出ていない＝点検が機能していなかった
//       weeklyPaceReport   トレーナーへのLINEもメールも一度も送られていない
//       lbNudgeDaily       new Date(オブジェクト) ＝ Invalid Date／差が NaN
//                          ＝振替・月初・来店後の声かけが**一度も動いていなかった**
//                          （届いていた「予約リマインド」は別関数 sendLineReminders）
//
//     ★どれも**静かに壊れていた**。止まらず、エラーも出ず、
//       「悪化したときだけ鳴る」作りなので沈黙が正常と区別できなかった。
//
//   ★ここで見るのは「引数を取るな」ではない。
//     引数を取ってよいが、**イベントオブジェクトが来ても正しく倒れること**を見る。
//
//   ★関門②の指摘で2回直した
//     ① 定義を見つけられなかった関数を黙って飛ばしていた（見失っても落ちない）
//     ② 許可の正規表現が**第1引数の名前に結び付いていなかった**
//        （本文のどこかに `(別の変数 === true)` があれば通ってしまう）
//
//   実行: node worker/test/trigger-args.test.js

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GAS = join(ROOT, 'gas');
const files = readdirSync(GAS).filter((f) => f.endsWith('.js'));
const SRC = {};
for (const f of files) SRC[f] = readFileSync(join(GAS, f), 'utf8');
const ALL = Object.values(SRC).join('\n');

let pass = 0, fail = 0;
function ok(name, cond, why) {
  if (cond) { pass++; return; }
  fail++;
  console.log(`❌ ${name}`);
  if (why) console.log(`   ${why}`);
}

// ---------- 1. 期待する一覧は**複製しない**（EdgeAudit の expect を読む） ----------
//   ★同じ一覧を2箇所に書くと、片方だけ直した日に黙ってずれる。
const audit = SRC['EdgeAudit.js'];
const expStart = audit.indexOf('  var expect = [');
const expectBlock = audit.slice(expStart, audit.indexOf('\n  ];', expStart));
const expected = new Set((expectBlock.match(/\['([A-Za-z0-9_]+)',/g) || [])
  .map((x) => x.replace(/\['|',/g, '')));
ok('①期待する一覧を読めている', expected.size >= 15,
   `読めたのは ${expected.size} 個。EdgeAudit.js の var expect = [...] の形が変わった可能性`);

// ---------- 2. newTrigger を**全部**名前に解決する（解決できなければ落とす） ----------
const calls = ALL.match(/ScriptApp\.newTrigger\(\s*[^)]+\)/g) || [];
const registered = new Set();
const unresolved = [];
for (const c of calls) {
  const inner = c.replace(/^ScriptApp\.newTrigger\(\s*/, '').replace(/\s*\)$/, '').trim();
  const lit = /^'([A-Za-z0-9_]+)'$/.exec(inner);
  if (lit) { registered.add(lit[1]); continue; }
  //   定数経由（例：LB_CALSYNC.TICK_HANDLER）。定義を引く
  const prop = inner.split('.').pop();
  const def = new RegExp(`${prop}:\\s*'([A-Za-z0-9_]+)'`).exec(ALL);
  if (def) { registered.add(def[1]); continue; }
  unresolved.push(inner);
}
ok('②★newTrigger の対象を全部名前に解決できる', unresolved.length === 0,
   unresolved.length
     ? `解決できない登録: ${unresolved.join(', ')}\n`
       + '     解決できないものを飛ばすと、この検査は新しい登録形式を見逃す'
     : '');

// ---------- 3. 期待と実際が**完全一致**（取りこぼしを許さない） ----------
//
//   ★一回限りのトリガー（.after(ms)）もここに出てくる。
//     定期の一覧（EdgeAudit の expect）には載らないが、
//     **これらも第1引数にイベントオブジェクトを受ける**ので検査の対象である。
//     新しいものが増えたらここで落ちる＝分類するまで通らない。
const ONE_SHOT = new Set([
  '_lbSyncAfterRegister',   // 会員登録の直後に1回
  '_lbWarmContract',        // 契約の読み込みを温める1回
  '_lbCalSyncAfterWrite',   // 書き込みの直後にカレンダー同期を1回
]);

const missing = [...expected].filter((n) => !registered.has(n));
const extra = [...registered].filter((n) => !expected.has(n) && !ONE_SHOT.has(n));
const goneOneShot = [...ONE_SHOT].filter((n) => !registered.has(n));
ok('③★コードが登録する集合と、分類した集合が一致する',
   missing.length === 0 && extra.length === 0 && goneOneShot.length === 0,
   (missing.length ? `定期の期待にあるのに登録が無い: ${missing.join(', ')}\n     ` : '')
   + (extra.length ? `登録があるのに分類されていない: ${extra.join(', ')}\n     `
       + '（定期なら EdgeAudit の expect へ、一回限りなら ONE_SHOT へ入れる）\n     ' : '')
   + (goneOneShot.length ? `ONE_SHOT にあるのに登録が無い: ${goneOneShot.join(', ')}` : ''));

// ---------- 4. 第1引数を取る関数は、**その引数名**で安全に受けているか ----------
//
//   ★許可する形だけを並べる（ブラックリストにしない）。
//     「危ない書き方」を挙げる方式は、言い換えで素通りする。
//   ★引数名を正規表現に埋め込む。本文の別の変数では通らない。
function safeFor(arg) {
  const a = arg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    //   明示的に true のときだけ dry-run として扱う
    new RegExp(`=\\s*\\(\\s*${a}\\s*===\\s*true\\s*\\)`),
    //   数値だけを受け付ける
    new RegExp(`typeof\\s+${a}\\s*===\\s*'number'\\s*&&\\s*isFinite\\(\\s*${a}\\s*\\)`),
  ];
}

const offenders = [];
const checkedWithArgs = [];
for (const name of registered) {
  let body = null, file = null, firstArg = null;
  for (const f of files) {
    const i = SRC[f].indexOf(`function ${name}(`);
    if (i < 0) continue;
    const head = SRC[f].slice(i, SRC[f].indexOf('\n', i));
    const args = head.slice(head.indexOf('(') + 1, head.indexOf(')')).trim();
    file = f;
    if (!args) { body = ''; break; }                  // 引数なし＝問題なし
    firstArg = args.split(',')[0].trim();
    const rest = SRC[f].slice(i);
    const nextFn = rest.indexOf('\nfunction ', 1);
    body = nextFn > 0 ? rest.slice(0, nextFn) : rest;
    break;
  }
  //   ★定義が見つからなければ**落とす**（飛ばさない）。
  if (body === null) { offenders.push(`${name}（定義が見つからない）`); continue; }
  if (body === '') continue;                          // 引数なし
  checkedWithArgs.push(name);
  if (safeFor(firstArg).some((re) => re.test(body))) continue;
  offenders.push(`${file}: ${name}(${firstArg})`);
}

ok('④★第1引数を取るトリガー関数は、イベントオブジェクトでも正しく倒れる',
   offenders.length === 0,
   offenders.length
     ? `安全な受け取り方が無い:\n     ${offenders.join('\n     ')}\n`
       + '     時間主導のトリガーは第1引数にイベントオブジェクトを渡す。\n'
       + '     `x != null` や `if (!x)` で判定すると、オブジェクトが常に真になる。\n'
       + '     許可する形（引数名そのもので書くこと）:\n'
       + '       var dryRun = (dryRunArg === true);\n'
       + "       typeof nowMs === 'number' && isFinite(nowMs)"
     : '');
ok('④引数を取る関数を実際に見ている', checkedWithArgs.length >= 3,
   `見たのは ${checkedWithArgs.length} 個（${checkedWithArgs.join(', ')}）。`
   + '0個なら、この検査は何も守っていない');

// ---------- 5. 直した3つが、直ったままであること ----------
ok('⑤点検は明示的な true だけを dry-run にする',
   /function dailyHealthCheck\(dryRunArg\) \{[\s\S]{0,2000}?var dryRun = \(dryRunArg === true\);/
     .test(SRC['LineBooking.js']));
ok('⑤週次レポートも同じ',
   /function weeklyPaceReport\(dryRunArg\) \{[\s\S]{0,600}?var dryRun = \(dryRunArg === true\);/
     .test(SRC['LineBooking.js']));
ok('⑤声かけは数値だけを受け付ける',
   /var ms = \(typeof nowMs === 'number' && isFinite\(nowMs\)\) \? nowMs : new Date\(\)\.getTime\(\);/
     .test(SRC['Nudge.js']));

// ---------- 6. 手で dry-run する入口は残っている ----------
ok('⑥手で確かめる入口が残っている',
   /function runHealthCheckDryRun\(\) \{ return dailyHealthCheck\(true\); \}/.test(SRC['LineBooking.js'])
   && /function runPaceReportDryRun\(\) \{ return weeklyPaceReport\(true\); \}/.test(SRC['LineBooking.js']),
   '本番で試す回数を減らすために要る');

console.log(`${fail ? '❌' : '✅'} トリガーの引数 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
