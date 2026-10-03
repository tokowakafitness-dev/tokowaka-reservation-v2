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

console.log((fail ? '❌' : '✅') + ' liff-confirm-timeout: ' + pass + '件合格' + (fail ? ' / ' + fail + '件失敗' : ''));
process.exit(fail ? 1 : 0);
