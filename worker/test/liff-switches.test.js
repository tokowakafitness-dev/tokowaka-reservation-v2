// 顧客の画面の「切り替え」が、意図した範囲だけに効いていることを機械で止める検査
//
//   2026-10-03、オーナーに「?cal=1 を付けて確かめてください」とお願いした。
//   ところが liff/index.html の _apiSend は `if (!EDGE_ON) p = _apiGas(params);` で
//   分岐しており、EDGE_ON（既定 false）が偽なら _edgeTry に入らない。
//   つまり **?cal=1 は一度も効かず、確認が空振りした**。
//   「残数は正常」と見えたのも、従来どおりGASで計算していたからにすぎない。
//
//   さらに同じ形の誤りを一度踏んでいる。2026-09-29、EDGE_ON を止めたつもりで
//   `EDGE_ON = localStorage.getItem('lb_edge') !== '0'` と書いており、
//   鍵が無い端末は '0' ではないため **全員 ON のまま**だった。
//
//   どちらも「切り替えを書いたが、効く範囲が意図と違う」。読んで気づくことに頼らない。
//
//   実行: node worker/test/liff-switches.test.js

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const HTML = readFileSync(join(ROOT, 'liff/index.html'), 'utf8');

// 行コメントを落とした版。
//   過去の誤りは「以前こう書いていた」とコメントに残してある（消すと同じ穴を踏む）。
//   そのままだと「禁じた形が無いこと」の検査が記録に当たってしまうので、
//   “いま動くコード”だけを見る版を用意する。
const CODE = HTML.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

let pass = 0, fail = 0;
function ok(n, c) { if (c) pass++; else { fail++; console.log('❌ ' + n); } }
function eq(n, g, w) {
  if (JSON.stringify(g) === JSON.stringify(w)) pass++;
  else { fail++; console.log('❌ ' + n + '\n   got : ' + JSON.stringify(g) + '\n   want: ' + JSON.stringify(w)); }
}

// ---------- ① 確かめていないものを既定で出さない ----------
//   USE_CAL（空き枠をD1から計算）はまだ確認中。既定がONだと全員に出てしまう。
ok('①USE_CAL の既定は false', /var\s+USE_CAL\s*=\s*false\s*;/.test(HTML));

// ---------- ② ★既定の値と、鍵の読み方が食い違っていないこと ----------
//   2026-09-29、既定 false のつもりで `!== '0'` と書き、鍵が無い端末は '0' ではないため
//   **全員ONのまま**だった。止めたつもりが止まっていなかった。
//   既定と式のどちらを変えても、もう片方を変え忘れると同じ事故になる。だから対で検査する。
{
  const defOn = /var\s+EDGE_ON\s*=\s*true\s*;/.test(CODE);
  const defOff = /var\s+EDGE_ON\s*=\s*false\s*;/.test(CODE);
  ok('②EDGE_ON の既定が true か false のどちらかで書かれている', defOn !== defOff);

  const byNotZero = /EDGE_ON\s*=\s*\(localStorage\.getItem\('lb_edge'\)\s*!==\s*'0'\)/.test(CODE);
  const byIsOne   = /EDGE_ON\s*=\s*\(localStorage\.getItem\('lb_edge'\)\s*===\s*'1'\)/.test(CODE);
  ok('②鍵の読み方が1通りに決まっている', byNotZero !== byIsOne);

  // 既定ONなら「'0' でなければ有効」、既定OFFなら「'1' のときだけ有効」。
  ok('②★既定と鍵の読み方が一致している',
     (defOn && byNotZero) || (defOff && byIsOne),
     `既定=${defOn ? 'ON' : 'OFF'} ／ 読み方=${byNotZero ? "!== '0'" : "=== '1'"}`);

  // 既定ONのときは、止める道（?edge=0）が鍵を**書く**側でなければ効かない。
  if (defOn) {
    ok('②★?edge=0 が鍵を書いて止める', /edge=0[\s\S]{0,120}setItem\('lb_edge', '0'\)/.test(CODE));
    ok('②★?edge=1 が鍵を書いて戻す', /edge=1[\s\S]{0,120}setItem\('lb_edge', '1'\)/.test(CODE));
    ok('②★鍵が読めない端末でも ?edge=0 が効く',
       /catch \(e\) \{ EDGE_ON = !\/\[\?&#\]edge=0\//.test(CODE));
    // 既定ONで removeItem を使うと、?edge=1 のあと鍵が消えて「既定ON」に戻るだけになり、
    // 一見動くが意図が崩れる。保存する側で統一する。
    ok('②既定ONでは鍵を消す書き方を使わない', !/removeItem\('lb_edge'\)/.test(CODE));
  }
}
ok('②USE_CAL は lb_cal === \'1\' のときだけ有効（既定OFFと対）',
  /USE_CAL\s*=\s*\(localStorage\.getItem\('lb_cal'\)\s*===\s*'1'\)/.test(HTML));
ok('②USE_CAL を「!== \'0\'」で有効にしていない',
  !/getItem\('lb_cal'\)\s*!==\s*'0'/.test(CODE));

// ---------- ③ USE_CAL は Worker 全体の切り替えと独立に効く ----------
//   ここが今日の空振りの正体。EDGE_ON が偽でも、枠だけは試せなければ確認できない。
const useEdgeLine = (HTML.match(/var\s+useEdge\s*=\s*([^;]+);/) || [])[1] || '';
ok('③useEdge が定義されている', !!useEdgeLine);
ok('③useEdge に EDGE_ON が入っている', /EDGE_ON/.test(useEdgeLine));
ok('③useEdge に USE_CAL が入っている', /USE_CAL/.test(useEdgeLine));
ok('③_apiSend の分岐が useEdge を見ている', /if\s*\(!useEdge\)\s*p\s*=\s*_apiGas\(params\);/.test(HTML));
ok('③EDGE_ON を直接見る古い分岐が残っていない', !/if\s*\(!EDGE_ON\)\s*p\s*=\s*_apiGas\(params\);/.test(HTML));

// ---------- ④ USE_CAL が広がる先は「空き枠」だけ ----------
//   EDGE_ON を止めた理由は残数・予約オプション・予約一覧・固定枠の穴であって、
//   空き枠とは関係がない。USE_CAL でそれらまで開いてはいけない。
ok('④useEdge の USE_CAL は getTrainerSlots に限定されている',
  /USE_CAL\s*&&\s*plain\s*===\s*'getTrainerSlots'/.test(useEdgeLine));

// 実際の分岐を同じ形で動かして、どの操作が Worker へ行くかを表で固定する。
const EDGE_WRITE_ACTIONS = (function () {
  const m = HTML.match(/var\s+EDGE_WRITE_ACTIONS\s*=\s*(\/\^[^\n]+?\/)\s*;/);
  if (!m) return null;
  // eslint-disable-next-line no-eval
  return eval(m[1]);
})();
ok('④書き込みの一覧が読み取れた', !!EDGE_WRITE_ACTIONS);

// _apiSend と _edgeTry の、Workerへ行くかどうかだけを取り出した形
function goesToWorker(plain, { EDGE_ON, USE_CAL, writeRecently }) {
  const useEdge = EDGE_ON || (USE_CAL && plain === 'getTrainerSlots');
  if (!useEdge) return false;
  if (EDGE_WRITE_ACTIONS.test(plain)) return false;          // 書き込みは必ずGAS
  const HOME = { getMemberStatus:1, getCustomerHome:1, getBookingOptions:1,
                 getTrainerSlots:1, getMyReservations:1, getTrainerReservations:1,
                 boot:1, customerCard:1 };
  if (HOME[plain] && writeRecently) return false;            // 書き込み直後はGAS
  const MAP = { getMemberStatus:1, getTrainers:1, getTrainerSlots:1, getBookingOptions:1,
                getTrainerReservations:1, getCustomerHome:1,
                listRecurringPatternsByTrainer:1, getMyReservations:1,
                boot:1, customerCard:1 };
  return !!MAP[plain];
}

const calOnly = { EDGE_ON: false, USE_CAL: true, writeRecently: false };
eq('④?cal=1：空き枠は Worker へ行く',        goesToWorker('getTrainerSlots', calOnly), true);
eq('④?cal=1：残数は Worker へ行かない',      goesToWorker('getMemberStatus', calOnly), false);
eq('④?cal=1：予約オプションは行かない',      goesToWorker('getBookingOptions', calOnly), false);
eq('④?cal=1：予約一覧は行かない',            goesToWorker('getMyReservations', calOnly), false);
eq('④?cal=1：固定枠の一覧は行かない',        goesToWorker('listRecurringPatternsByTrainer', calOnly), false);
eq('④?cal=1：ホームは行かない',              goesToWorker('getCustomerHome', calOnly), false);
eq('④?cal=1：予約の確定は行かない',          goesToWorker('makeReservation', calOnly), false);
// まとめ取得も「空き枠だけ」の原則から外れない。?cal=1 では通さない。
eq('④?cal=1：起動のまとめ取得は行かない',    goesToWorker('boot', calOnly), false);
eq('④?cal=1：顧客カードのまとめ取得も行かない', goesToWorker('customerCard', calOnly), false);
eq('④?cal=1：取消は行かない',                goesToWorker('cancelReservation', calOnly), false);

// ★2026-10-03 既定が ON になったので、「何も付けない端末」の期待は変わった。
//   ここで検査するのは「?edge=0 で止めた端末」＝1つもWorkerへ行かないこと。
//   止める道が効かなくなったら、全員を元に戻す手段が無くなる。
const plainDev = { EDGE_ON: false, USE_CAL: false, writeRecently: false };
for (const a of ['getTrainerSlots','getMemberStatus','getBookingOptions','getMyReservations',
                 'getCustomerHome','getTrainers','makeReservation','boot','customerCard']) {
  eq('⑤?edge=0 で止めた端末：' + a + ' はGASのまま', goesToWorker(a, plainDev), false);
}

// ---------- ⑧ まとめ取得が Worker を通る道にあること ----------
//   2026-10-03、ここが _apiGas 直行だったため、?edge=1 を入れても起動の6.1秒と
//   顧客カードの5.5〜8.3秒は一切縮まらなかった。本番の通信の86%がこの2つだった。
ok('⑧窓口の表に起動のまとめ取得がある', /boot:\s*'c_boot'/.test(CODE));
ok('⑧窓口の表に顧客カードのまとめ取得がある', /customerCard:\s*'c_customerCard'/.test(CODE));
ok('⑧起動のまとめ取得が _apiGas 直行でない', !/var p = _apiGas\(\{ action:'line_boot' \}\)/.test(CODE));
ok('⑧顧客カードが _apiGas 直行でない', !/p = _apiGas\(\{ action:'line_customerCard'/.test(CODE));
ok('⑧起動のまとめ取得が _apiSend を通る', /_apiSend\(\{ action:'line_boot' \}, 'boot'\)/.test(CODE));
ok('⑧顧客カードが _apiSend を通る', /_apiSend\(\{ action:'line_customerCard'[^)]*\}, 'customerCard'\)/.test(CODE));
// 残数を含むので、書き込み直後に写しを使わない対象に入っていること
ok('⑧書き込み直後は起動のまとめ取得もGASへ', /EDGE_HOME_ACTIONS[\s\S]{0,400}boot:1/.test(CODE));
ok('⑧書き込み直後は顧客カードもGASへ', /EDGE_HOME_ACTIONS[\s\S]{0,400}customerCard:1/.test(CODE));

// Worker を有効にした端末では通ること（＝繋がっていることの確認）
const edgeOn = { EDGE_ON: true, USE_CAL: false, writeRecently: false };
eq('⑧?edge=1：起動のまとめ取得が Worker へ行く', goesToWorker('boot', edgeOn), true);
eq('⑧?edge=1：顧客カードも Worker へ行く', goesToWorker('customerCard', edgeOn), true);
eq('⑧書き込み直後は Worker へ行かない',
  goesToWorker('boot', { EDGE_ON: true, USE_CAL: false, writeRecently: true }), false);

// ---------- ⑥ 書き込み直後は、枠も写しを使わない ----------
//   自分が取った枠が「まだ空いている」と見えるのを防ぐ。USE_CAL でも外れてはいけない。
eq('⑥書き込み直後は ?cal=1 でも枠はGASへ落ちる',
  goesToWorker('getTrainerSlots', { EDGE_ON: false, USE_CAL: true, writeRecently: true }), false);

// ---------- ⑦ 計測が「経路」と「読み込み」を出すこと ----------
//   どちらで動いているか分からないまま確認すると、今日のような空振りをまた起こす。
ok('⑦経路を出す関数がある', /function\s+_perfRoute\s*\(/.test(HTML));
ok('⑦経路に Worker の状態が出る', /_perfRoute[\s\S]{0,400}EDGE_ON/.test(HTML));
ok('⑦経路にカレンダー計算の状態が出る', /_perfRoute[\s\S]{0,400}USE_CAL/.test(HTML));
ok('⑦初回の読み込みを出す関数がある', /function\s+_perfBoot\s*\(/.test(HTML));
ok('⑦読み込みに書体の時間が入る', /_perfBoot[\s\S]{0,900}fonts\\\.\(googleapis\|gstatic\)/.test(HTML));
ok('⑦読み込みにLINEの部品の時間が入る', /_perfBoot[\s\S]{0,900}sdk\\\.js/.test(HTML));
ok('⑦計測パネルが経路を描いている', /_perfRender[\s\S]{0,1200}_perfRoute\(\)/.test(HTML));
// 版の印。端末が古いHTMLを掴んでいるのか、仕掛けが効いていないのかを切り分けるために要る。
ok('⑦版の印が定義されている', /var LIFF_BUILD = '[^']+'/.test(CODE));

// ---------- ⑨ Workerを使わなかった理由が必ず残ること ----------
//   成功だけを記録していたため、内訳に boot だけが出ているとき
//   「呼ばなかった」のか「呼んで断られた」のかが区別できなかった（2026-10-03）。
//   失敗が黙って消えるのは計測のいちばん悪い欠陥。Codexの指摘で入れた。
ok('⑨使わなかった理由を残す関数がある', /function _edgeSkip\(plain, why\)/.test(CODE));
ok('⑨書き込み直後は理由を残す',
  /EDGE_HOME_ACTIONS\[plain\][\s\S]{0,200}_edgeSkip\(plain, '書き込み直後/.test(CODE));
ok('⑨窓口に無いときも理由を残す', /_edgeSkip\(plain, '窓口なし'\)/.test(CODE));
ok('⑨断られたら理由と時間を残す', /_perfAdd\('edgeNG:' \+ plain[\s\S]{0,120}j\.code/.test(CODE));
ok('⑨通信が転んでも理由と時間を残す', /AbortError[\s\S]{0,160}_perfAdd\('edgeNG:'/.test(CODE));
// 黙って null を返す道が残っていないこと（理由を残さず捨てない）
{
  const fn = (HTML.match(/function _edgeTry\(params\)\{[\s\S]*?\n  \}/) || [])[0] || '';
  const silent = (fn.match(/return null;/g) || []).length;
  const voiced = (fn.match(/_edgeSkip\(/g) || []).length + (fn.match(/_perfAdd\('edgeNG:/g) || []).length;
  ok('⑨理由を残さず捨てる道が無い', silent <= voiced + 1,
     `return null が${silent}個、理由を残すのが${voiced}個（+1は書き込みの道）`);
}
ok('⑦経路に版の印が出る', /_perfRoute[\s\S]{0,600}LIFF_BUILD/.test(HTML));
ok('⑦計測パネルが読み込みを描いている', /_perfRender[\s\S]{0,1200}_perfBoot\(\)/.test(HTML));

console.log((fail ? '❌' : '✅') + ' liff-switches: ' + pass + '件合格' + (fail ? ' / ' + fail + '件失敗' : ''));
process.exit(fail ? 1 : 0);
