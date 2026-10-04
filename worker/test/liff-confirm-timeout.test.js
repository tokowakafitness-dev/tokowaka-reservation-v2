// 予約の確定がタイムアウトしたとき、二重予約にならないことを機械で止める検査
//
//   2026-10-03、オーナーの端末で「通信に失敗しました：サーバー応答がタイムアウトしました」
//   が出たにもかかわらず、**予約は入っていた**。
//   _rawApi はGASの応答を20秒で見切って reject するが、サーバー側の処理は続いており、
//   そのあと成立する。ところが確定の catch は失敗と断定して
//   `btn.disabled=false` でボタンを押せる状態に戻していた。
//   顧客がもう一度押せば**二重予約**になる。取り返しがつかないのはこちら側。
//
//   同じ日の計測で、GASは boot 6.1秒・customerCard 8.3秒かかっていた。
//   確定はさらに重いので、20秒超えは例外ではなく起こりうる。
//
//   実行: node worker/test/liff-confirm-timeout.test.js

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const HTML = readFileSync(join(ROOT, 'liff/index.html'), 'utf8');

let pass = 0, fail = 0;
function ok(n, c) { if (c) pass++; else { fail++; console.log('❌ ' + n); } }
function eq(n, g, w) {
  if (JSON.stringify(g) === JSON.stringify(w)) pass++;
  else { fail++; console.log('❌ ' + n + '\n   got : ' + JSON.stringify(g) + '\n   want: ' + JSON.stringify(w)); }
}

// 確定ボタンの catch の中だけを取り出す
const confirmCatch = (HTML.match(/\}\)\.catch\(function\(e\)\{\s*\n\s*\/\/ ★ボタンをここで戻さない[\s\S]*?\n      \}\);\n  \}\);/) || [])[0] || '';

// ---------- ① 失敗と断定してボタンを戻していないこと ----------
ok('①確定の catch が見つかる', !!confirmCatch);
// 確かめる前（_verifyBooked を呼ぶまで）に、ボタンを戻したり失敗と言ったりしていないこと。
//   ここだけを見る。他の操作（枠を作る・塞ぐ等）の catch は対象ではない。
const beforeVerify = confirmCatch.split('_verifyBooked(')[0];
ok('①確かめる前にボタンを戻していない', !/btn\.disabled\s*=\s*false/.test(beforeVerify));
ok('①確かめる前に comm_fail を出していない', !/comm_fail/.test(beforeVerify));
ok('①まず「確認しています」を出す', /cf_verifying/.test(confirmCatch));
ok('①確かめる関数を呼んでいる', /_verifyBooked\(req\)/.test(confirmCatch));

// ---------- ② 3つの結果で振る舞いが分かれること ----------
ok('②入っていたら完了画面へ', /found\s*===\s*true[\s\S]*?show\('s-done'\)/.test(confirmCatch));
ok('②入っていなければ押し直せる', /found\s*===\s*false[\s\S]*?btn\.disabled\s*=\s*false/.test(confirmCatch));
ok('②入っていなければ専用の文面を出す', /found\s*===\s*false[\s\S]*?cf_verify_none/.test(confirmCatch));

// 不明（null）のときにボタンを戻していないこと。
//   catch の中で disabled=false にしてよいのは false の枝だけ。
const enables = (confirmCatch.match(/btn\.disabled\s*=\s*false/g) || []).length;
eq('②ボタンを戻すのは「入っていなかった」ときと「成功」のときだけ（2か所）', enables, 2);
ok('②不明のときは専用の文面を出す', /cf_verify_unknown/.test(confirmCatch));
const unknownTail = confirmCatch.split(/cf_verify_unknown/)[0].split(/found\s*===\s*false/)[1] || '';
ok('②不明の枝に disabled=false が無い', !/btn\.disabled\s*=\s*false/.test(unknownTail.split('return;')[1] || ''));

// ---------- ③-0 ★「一覧に無い」を失敗と断定しないこと（Codex指摘・2026-10-03） ----------
//   20秒で見切ったあともサーバー側の処理は続いており、照合がそれを追い越すことがある。
//   そこで押し直せるようにすると、追い越した直後に成立して二重予約になる。
{
  const v = (HTML.match(/function _verifyBooked\(req\)\{[\s\S]*?\n  \}/) || [])[0] || '';
  ok('③-0 間を置いて見直す', /_delay\(VERIFY_RETRY_MS\)[\s\S]{0,40}look/.test(v));
  ok('③-0 待ち時間が定数で定義されている', /var VERIFY_RETRY_MS = \d+;/.test(HTML));
  ok('③-0★2回とも無ければ「確かめられない」に倒す',
     /second === true\) \? true : null/.test(v));
  ok('③-0★照合そのものが false を返して終わる道が無い',
     !/return\s+first;/.test(v) && !/then\(look\)\.then\(function\(second\)\{\s*return second;/.test(v));

  // ★代行は顧客まで確かめる。時刻だけだと、別の顧客の同時刻の予約を
  //   「自分が入れたもの」と取り違えて完了画面を出す（入っていないのに完了＝致命的）。
  ok('③-0★代行は対象の顧客を控える', /wantCustomer = state\.proxyMode/.test(v));
  ok('③-0★顧客が違えば飛ばす', /wantCustomer && String\([\s\S]{0,40}customerId[\s\S]{0,30}!== wantCustomer\) continue/.test(v));
  ok('③-0 本人のときは顧客で絞らない（空なら素通し）', /wantCustomer &&/.test(v));
}

// ---------- ③ 確かめ方が「読めなかった」を成功に倒していないこと ----------
const verify = (HTML.match(/function _verifyBooked\(req\)\{[\s\S]*?\n  \}/) || [])[0] || '';
ok('③_verifyBooked がある', !!verify);
ok('③日時が無ければ不明（null）', /if \(!want\) return Promise\.resolve\(null\)/.test(verify));
ok('③応答が読めなければ不明（null）', /res\.success !== true[\s\S]{0,40}return null/.test(verify));
ok('③通信が転んだら不明（null）', /catch\(function\(\)\{ return null; \}\)/.test(verify));
ok('③代行はトレーナーの予約表を見る', /state\.proxyMode[\s\S]{0,80}getTrainerReservations/.test(verify));
ok('③本人は自分の予約表を見る', /getMyReservations/.test(verify));
ok('③変更のときは新しい日時で照合する', /req\.newStartISO/.test(verify));

// ---------- ④ 日時の照合が表記の揺れに強いこと ----------
//   GASは toISOString()（UTC表記）で返し、画面が送るのはローカル表記のことがある。
//   文字列のまま比べると、同じ時刻を別物と見て「入っていない」と誤答する。
const sameStart = (HTML.match(/function _sameStart\(a, b\)\{[\s\S]*?\n  \}/) || [])[0] || '';
ok('④_sameStart がある', !!sameStart);
ok('④文字列ではなく時刻で比べている', /new Date\(String\(a[\s\S]{0,120}getTime\(\)/.test(sameStart));
ok('④不正な日付を一致と見なさない', /isFinite\(x\) && isFinite\(y\)/.test(sameStart));

// 実際に動かす
const _sameStart = new Function('a', 'b', sameStart.replace(/^function _sameStart\(a, b\)\{/, '').replace(/\}$/, ''));
eq('④UTC表記とローカル表記が同じ時刻なら一致',
  _sameStart('2026-10-10T07:00:00+09:00', '2026-10-09T22:00:00.000Z'), true);
eq('④同じ表記は一致', _sameStart('2026-10-10T07:00:00+09:00', '2026-10-10T07:00:00+09:00'), true);
eq('④1分ずれていれば不一致',
  _sameStart('2026-10-10T07:00:00+09:00', '2026-10-10T07:01:00+09:00'), false);
eq('④空は不一致', _sameStart('', ''), false);
eq('④壊れた値は不一致', _sameStart('ごみ', '2026-10-10T07:00:00+09:00'), false);
eq('④null は不一致', _sameStart(null, null), false);

// ---------- ⑤ 文言が4言語そろっていること ----------
//   1つでも欠けると、その言語の顧客に空の帯が出る。
for (const key of ['cf_verifying', 'cf_verify_none', 'cf_verify_unknown']) {
  const n = (HTML.match(new RegExp(key + ':', 'g')) || []).length;
  eq('⑤' + key + ' が4言語ぶんある', n, 4);
}
// 不明のときの文面は「確認してから」と伝えるものであること（押し直しを促さない）
const jaUnknown = (HTML.match(/cf_verify_unknown:'([^']*)'/) || [])[1] || '';
ok('⑤不明の文面が「確認」を促している', /確認/.test(jaUnknown));
ok('⑤不明の文面が二重予約に触れている', /二重/.test(jaUnknown));

// ---------- ⑥ ★すでに取り消された予約を「失敗」と見せないこと（2026-10-04）----------
//   一覧は写し（D1）から来るので、別の端末やトレーナーが先に取り消すと、
//   こちらの画面にはまだ残って見える（最大20分）。
//   それを押したときに「キャンセルに失敗しました」と出すと、
//   **すでに望みどおりになっているのに、失敗したように見える。**
{
  const LB = readFileSync(join(ROOT, 'gas/LineBooking.js'), 'utf8');

  ok('⑥判定の関数がある', /function _alreadyGone\(res\)/.test(HTML));
  // ★判定に使うのは「もう取消済み」と「その予約が無い」だけ。
  //   台帳そのものが読めない場合を混ぜると、壊れているのに
  //   「すでに取り消されています」と案内してしまう。
  {
    const fn = (HTML.match(/function _alreadyGone\(res\)\{[\s\S]*?\n  \}/) || [])[0] || '';
    ok('⑥判定の中身が読める', !!fn);
    ok('⑥★見るのは ALREADY と NOT_FOUND だけ',
       /c === 'ALREADY' \|\| c === 'NOT_FOUND'/.test(fn));
    ok('⑥★台帳が読めない場合を混ぜていない', !/NO_SHEET/.test(fn));
    ok('⑥権限が無い場合も混ぜていない', !/FORBIDDEN/.test(fn));
  }

  // ★GAS側で「台帳が読めない」を別のコードにしていること。
  //   ここを分けないと、画面がいくら気をつけても取り違える。
  ok('⑥★取消：台帳が読めないときは別のコード',
     /function cancelReservationLine[\s\S]{0,900}code: 'NO_SHEET'/.test(LB));
  ok('⑥★変更：台帳が読めないときも別のコード',
     /function changeReservationLine[\s\S]{0,900}code: 'NO_SHEET'/.test(LB));

  // 3つの入口すべてで使っていること（1つでも漏れるとそこだけ失敗に見える）
  ok('⑥トレーナーの取消で使っている', /_alreadyGone\(res\)[\s\S]{0,160}loadTrainerReservations/.test(HTML));
  ok('⑥会員の取消で使っている', /_alreadyGone\(res\)[\s\S]{0,160}loadMyReservations/.test(HTML));
  ok('⑥固定枠の削除で使っている', /_alreadyGone\(r\)[\s\S]{0,160}_buildRecurSection/.test(HTML));

  // ★一覧を取り直すこと。伝えるだけだと、古い一覧が残って同じことを繰り返す。
  ok('⑥取消のあと一覧を取り直す', /already_gone'\)\); loadTrainerReservations\(\)/.test(HTML));

  // ★案内を出してから一覧を取り直すと、取り直しが画面を切り替えて**案内が消える**
  //   （2026-10-04・Codex指摘）。読む間もなく消えるので、確実に目に入る出し方にする。
  //   showError は画面を切り替えるだけなので、その直後に読み込みを始めると消える。
  for (const m of (HTML.match(/_alreadyGone\(\w+\)\)[^\n]*/g) || [])) {
    ok('⑥★案内が消えない出し方になっている（' + m.slice(0, 40) + '…）',
       !/showError\(t\('already_gone/.test(m), m);
  }
  ok('⑥会員の取消も確実に目に入る出し方', /_alreadyGone\(res\)\) \{ _edgeMarkStale\(\); window\.alert\(t\('already_gone'\)\); loadMyReservations/.test(HTML));

  // ★固定枠も「書き込み直後はGASに聞く」対象に入っていること（2026-10-04・Codex指摘）。
  //   入っていないと、削除した直後に取り直してもWorkerへ行き、
  //   D1がまだ古ければ**削除したはずの枠がまた出る。**
  //   「一覧を最新にしました」と案内しているのに最新でない、という形になる。
  ok('⑥★固定枠が書き込み直後の対象に入っている',
     /EDGE_HOME_ACTIONS[\s\S]{0,600}listRecurringPatternsByTrainer:1/.test(HTML));

  // ★固定枠の台帳が読めない場合も、別のコードにしていること
  ok('⑥★固定枠：台帳が読めないときは別のコード',
     /function deleteRecurringPattern[\s\S]{0,400}hit === false[\s\S]{0,120}NO_SHEET/.test(LB));
  ok('⑥固定枠：行を探す関数が3つの結果を返す',
     /if \(!sh\) return false;[\s\S]{0,160}getLastRow\(\) < 2\) return null;/.test(LB));
  // Lock内の再解決でも同じ分け方をしていること（片方だけ直すと、そこだけ誤案内が残る）
  ok('⑥固定枠：Lock内の再解決も分けている',
     /re === false\) return \{ success: false, code: 'NO_SHEET' \}/.test(LB));
  // ★写しが古いと分かった直後なので、しばらくGASに聞く
  ok('⑥★写しを信用しない印を立てる', /_alreadyGone\(res\)\) \{ _edgeMarkStale\(\)/.test(HTML));

  // 文言が4言語そろっていること
  for (const key of ['already_gone', 'already_gone_recur']) {
    const n = (HTML.match(new RegExp(key + ':', 'g')) || []).length;
    eq('⑥' + key + ' が4言語ぶんある', n, 4);
  }
  // 「失敗」と書いていないこと（失敗ではないため）
  const ja = (HTML.match(/already_gone:'([^']*)'/) || [])[1] || '';
  ok('⑥日本語の文面に「失敗」と書いていない', !/失敗/.test(ja), ja);
  ok('⑥日本語の文面が「すでに取り消されている」と伝える', /すでに取り消/.test(ja), ja);
}

console.log((fail ? '❌' : '✅') + ' liff-confirm-timeout: ' + pass + '件合格' + (fail ? ' / ' + fail + '件失敗' : ''));
process.exit(fail ? 1 : 0);
