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

// ---------- ① 既定は必ず OFF ----------
//   既定がONだと、確かめる前に全員に出る。
ok('①EDGE_ON の既定は false', /var\s+EDGE_ON\s*=\s*false\s*;/.test(HTML));
ok('①USE_CAL の既定は false', /var\s+USE_CAL\s*=\s*false\s*;/.test(HTML));

// ---------- ② 「鍵が無ければON」になっていない ----------
//   2026-09-29に実際に踏んだ形。=== '1' 以外で有効にしてはいけない。
ok('②EDGE_ON は lb_edge === \'1\' のときだけ有効',
  /EDGE_ON\s*=\s*\(localStorage\.getItem\('lb_edge'\)\s*===\s*'1'\)/.test(HTML));
ok('②USE_CAL は lb_cal === \'1\' のときだけ有効',
  /USE_CAL\s*=\s*\(localStorage\.getItem\('lb_cal'\)\s*===\s*'1'\)/.test(HTML));
ok('②「!== \'0\'」で有効にしている箇所が無い（コメントの記録は除く）',
  !/getItem\('lb_(edge|cal)'\)\s*!==\s*'0'/.test(CODE));

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
                 getTrainerSlots:1, getMyReservations:1, getTrainerReservations:1 };
  if (HOME[plain] && writeRecently) return false;            // 書き込み直後はGAS
  const MAP = { getMemberStatus:1, getTrainers:1, getTrainerSlots:1, getBookingOptions:1,
                getTrainerReservations:1, getCustomerHome:1,
                listRecurringPatternsByTrainer:1, getMyReservations:1 };
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
eq('④?cal=1：取消は行かない',                goesToWorker('cancelReservation', calOnly), false);

// 何も付けない端末（＝顧客全員）は、1つもWorkerへ行かない
const plainDev = { EDGE_ON: false, USE_CAL: false, writeRecently: false };
for (const a of ['getTrainerSlots','getMemberStatus','getBookingOptions','getMyReservations',
                 'getCustomerHome','getTrainers','makeReservation']) {
  eq('⑤既定の端末：' + a + ' はGASのまま', goesToWorker(a, plainDev), false);
}

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
ok('⑦計測パネルが読み込みを描いている', /_perfRender[\s\S]{0,1200}_perfBoot\(\)/.test(HTML));

console.log((fail ? '❌' : '✅') + ' liff-switches: ' + pass + '件合格' + (fail ? ' / ' + fail + '件失敗' : ''));
process.exit(fail ? 1 : 0);
