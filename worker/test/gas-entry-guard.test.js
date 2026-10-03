// 顧客IDを受け取るGASの入口が、1つ残らず認可を通ることの検証
//
//   ★なぜこれが要るのか（2026-10-03・本質的な対処）
//     この日、顧客の閲覧範囲の穴を4回にわたって塞いだ。そのたびに
//     「これで全部です」と報告し、そのたびにCodexが別の入口を見つけた。
//
//       1回目 … 残数（getCustomerHomeForTrainer）
//       2回目 … 体組成の読み取り・書き込み、予約オプション
//       3回目 … 判定そのものが fail-open（実在しない顧客IDで通る）
//       4回目 … 固定枠の追加・削除だけ緩い判定が残っていた
//
//     原因は**人が目で探して「全部直した」と言っていたこと**。
//     入口は37あり、そのうち顧客IDを受け取るものは機械で数えられる。
//     数えられるものを人が数えてはいけない。
//
//   ★この検査が守ること
//     新しい入口を足して認可を書き忘れたら、**その時点で落ちる。**
//     例外にしたいものは、理由を書いて下の表に載せる。
//     「理由を書く」こと自体が、例外を増やしにくくする。
//
//   実行: node worker/test/gas-entry-guard.test.js

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const FILES = ['gas/LineBooking.js', 'gas/LbBatch.js', 'gas/MealAi.js'];
const SRC = Object.fromEntries(FILES.map((f) => [f, readFileSync(join(ROOT, f), 'utf8')]));
const ALL = FILES.map((f) => SRC[f]).join('\n');
const LB = SRC['gas/LineBooking.js'];
// コメントを落とした版。コメントに関数名が書いてあるだけで「守っている」と見なさない。
const ALL_CODE = FILES.map((f) => SRC[f].split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')).join('\n');

let pass = 0, fail = 0;
function eq(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log(`❌ ${name}\n   got : ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`); }
}
function ok(name, cond, extra) { cond ? pass++ : (fail++, console.log(`❌ ${name}${extra ? '\n   ' + extra : ''}`)); }

// 認可の正本。ここを通らずに顧客の情報へ触れてはいけない。
const GUARD = '_lbTrainerMaySeeCustomer';

// ---- 例外（理由を書くこと。書けないものは例外にしない）----
const EXEMPT = {
  line_linkUnlinked:
    '未紐付け予約の紐付けは全トレーナーの受付業務（決定0066）。' +
    '紐付けを判断できるのはその日に施術したトレーナー本人で、' +
    '一覧に出るのは氏名とIDだけ（契約・報酬に触れない）。',
  // ★下の2つは「認可が無い」のではなく、**別の規則で守っている**。
  //   予約の取消・変更は「顧客の担当」ではなく「その予約行の担当トレーナー」で決まる。
  //   代行で入れた予約を、顧客の担当でない人が取り消せる必要があるため。
  //   規則が違うものを同じ検査に入れると、どちらかが必ず歪む。
  //   代わりに下の⑤で「予約行の担当を見ていること」を個別に確かめる。
  line_cancelReservation:
    '予約の取消は「予約行の担当トレーナーまたはオーナー」で判定する（顧客の担当ではない）。' +
    '代行で入れた予約を、顧客の担当でない人が取り消せる必要があるため。⑤で別途検査。',
  line_changeReservation:
    '予約の変更も「予約行の担当トレーナーまたはオーナー」で判定する。⑤で別途検査。',
};

// ★外から来る入口は1か所ではない（2026-10-03・Codexの5回目の判定）。
//   予約側（line_*）だけを見ていたため、meal-ai 側（ma_*）の別dispatchを見落とし、
//   担当外の顧客の体組成の履歴と、記録のある全顧客の一覧が見える状態が残っていた。
//   **入口の集合そのものを取り違えていた。** 新しい窓口が増えたらここに足す。
const DISPATCHES = [
  { file: 'gas/LineBooking.js', prefix: 'line_' },
  { file: 'gas/MealAi.js',      prefix: 'ma_' },
];

// 顧客に作用する識別子。**顧客IDだけではない。**
//   固定枠の削除は patternId、予約の取消・変更は resId から顧客を逆引きする。
//   「顧客IDを受け取るか」で数えると、これらを見落とす。
const CUSTOMER_KEYS = /params\.(customerId|patternId|resId|reservationId)/;

// 行コメントを落とす。コメントに関数名を書いただけで「守っている」と誤判定しないため。
const stripComments = (t) => t.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

// ---- dispatch を case ごとに切り出す ----
function entries() {
  const out = [];
  for (const d of DISPATCHES) {
    const src = SRC[d.file];
    const i0 = src.indexOf("case '" + d.prefix);
    if (i0 < 0) continue;
    const body = src.slice(i0);
    const re = new RegExp("case '(" + d.prefix + "\\w+)':", 'g');
    const marks = [...body.matchAll(re)];
    for (let i = 0; i < marks.length; i++) {
      const start = marks[i].index;
      // 最後の case は「次の case が無い」ので、switch の終わりまでを見る。
      //   固定長で切ると、dispatch が伸びたときに取りこぼす。
      const end = (i + 1 < marks.length) ? marks[i + 1].index
                : (body.indexOf('default:', start) > 0 ? body.indexOf('default:', start) : body.length);
      out.push({ name: marks[i][1], file: d.file, block: stripComments(body.slice(start, end)) });
    }
  }
  return out;
}

// ---- その入口が呼ぶ関数の本体に認可があるか ----
function guardedByCallee(block) {
  // ブロックから呼び出している関数名を拾う（params.xxx や String( は除く）
  const names = [...block.matchAll(/\b([a-zA-Z_]\w*)\s*\(/g)].map((m) => m[1])
    .filter((n) => !['String', 'Number', 'if', 'for', 'switch', 'return', 'catch', 'function'].includes(n));
  for (const n of new Set(names)) {
    const m = ALL_CODE.match(new RegExp('function ' + n + '\\([\\s\\S]*?\\n\\}', ''));
    if (m && m[0].includes(GUARD)) return n;
    // 1段だけ辿る。入口 → 薄い包み → 本体、という形が実際にある
    //   （line_deleteRecurringPattern → deleteRecurringPattern → _lbTrainerCanManageRecur）
    if (m) {
      const inner = [...m[0].matchAll(/\b([a-zA-Z_]\w*)\s*\(/g)].map((x) => x[1]);
      for (const k of new Set(inner)) {
        const mk = ALL_CODE.match(new RegExp('function ' + k + '\\([\\s\\S]*?\\n\\}', ''));
        if (mk && mk[0].includes(GUARD)) return n + ' → ' + k;
      }
    }
  }
  return null;
}

const list = entries();
ok('①入口を切り出せた', list.length >= 30, `${list.length}件`);

// 顧客IDを受け取る入口だけを見る
// ★`params` を丸ごと渡す入口も数える（2026-10-03）。
//   `case 'ma_series': return maApiSeries_(uid, params, tr);` のように書かれていると、
//   入口の行には customerId が現れない。**呼び先が顧客IDを読むかどうかで判断する。**
//   これを入れるまで、体組成グラフの入口が対象から漏れていた
//   （認可を外しても検査が気づかなかった）。
function touchesCustomer(e) {
  if (CUSTOMER_KEYS.test(e.block)) return true;
  // 「params を**丸ごと**引数として渡している」ときだけ呼び先を追う。
  //   `selfRegister(lineUserId, { name: params.name, ... })` のように項目を選んで
  //   渡している場合は、入口が顧客IDを受け取っていないので対象にしない
  //   （会員が自分を登録する操作で、トレーナーの担当とは無関係）。
  if (!/\(\s*[\w.]+\s*,\s*params\s*[,)]|\(\s*params\s*[,)]/.test(e.block)) return false;
  const names = [...e.block.matchAll(/\b([a-zA-Z_]\w*)\s*\(/g)].map((m) => m[1])
    .filter((n) => !['String', 'Number', 'if', 'for', 'switch', 'return', 'catch', 'function'].includes(n));
  for (const n of new Set(names)) {
    const m = ALL_CODE.match(new RegExp('function ' + n + '\\([\\s\\S]*?\\n\\}', ''));
    if (m && /params\.customerId|\.customerId/.test(m[0])) return true;
  }
  return false;
}
const takesCustomer = list.filter(touchesCustomer);
ok('①顧客IDを受け取る入口がある', takesCustomer.length >= 8, `${takesCustomer.length}件`);

const unguarded = [];
for (const e of takesCustomer) {
  if (EXEMPT[e.name]) continue;                     // 理由を書いた例外
  if (e.block.includes(GUARD)) continue;            // 入口そのもので守っている
  if (guardedByCallee(e.block)) continue;           // 呼ぶ先で守っている
  unguarded.push(e.name);
}
eq('①★顧客IDを受け取る入口がすべて認可を通る', unguarded.sort(), []);

// ---- ② 例外は「理由が書いてある」ものだけ ----
for (const [name, why] of Object.entries(EXEMPT)) {
  ok(`②例外 ${name} に理由がある`, typeof why === 'string' && why.length > 30);
  ok(`②例外 ${name} が実在する入口である`, list.some((e) => e.name === name), '消えた入口が表に残っている');
}
// 例外を増やしすぎていないこと（増えるときは必ず人の目に触れる）
ok('②例外は3つまで', Object.keys(EXEMPT).length <= 3,
   `いまの例外: ${Object.keys(EXEMPT).join(', ')}`);

// ---------- ⑤ 例外にしたものが、別の規則でちゃんと守られていること ----------
//   「例外」が「無防備」になっていないかを確かめる。ここが無いと例外表は逃げ道になる。
{
  const LBC = stripComments(LB);
  for (const name of ['cancelReservationLine', 'changeReservationLine']) {
    const fn = (LBC.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}')) || [])[0] || '';
    ok(`⑤${name} の本体が読める`, !!fn);
    // 予約行から担当トレーナーを取り出して、自分かオーナーかを見ていること
    ok(`⑤★${name} が予約行の担当で判定している`,
       /_lbIsOwnerRole/.test(fn) && /trainerId/.test(fn),
       fn.slice(0, 200));
  }
  // 未紐付けはトレーナーであることだけを見る（決定0066の明示的な例外）
  const link = (LBC.match(/function linkUnlinkedReservation[\s\S]*?\n\}/) || [])[0] || '';
  ok('⑤未紐付けは少なくともトレーナーであることを確かめている',
     /getTrainerByLine|requireTrainer/.test(link));
}

// ---- ③ 認可の規則が1か所にしかないこと ----
//   同じ意味の式を別に書くと、片方だけ直して「統一した」と誤解する。
//   実際この日、固定枠だけ古い式が残っていたのを4回目で指摘された。
{
  // 「オーナーでなく、担当が設定されていて、自分でない」という形の独自判定
  const custom = [...ALL.matchAll(/_lbIsOwnerRole\([a-z_]+\)\s*&&\s*\w*[Tt]rainerId\s*&&/g)];
  eq('③★顧客の担当を見る独自の判定式が残っていない', custom.map((m) => m[0]), []);
}
ok('③認可の関数が1つだけ定義されている',
  (ALL.match(new RegExp('function ' + GUARD + '\\(', 'g')) || []).length === 1);

// ---- ④ 認可に使う「担当は誰か」は厳格版だけ ----
//   緩い版（見つからなくても '' を返す）を使うと、実在しない顧客IDで通る。
{
  const calls = [...ALL.matchAll(new RegExp(GUARD + '\\(([^,]+),\\s*([^)]+)\\)', 'g'))]
                  .map((m) => m[2].trim());   // 第2引数＝「この顧客の担当は誰か」
  ok('④認可の呼び出しを拾えた', calls.length >= 8, `${calls.length}件`);
  const loose = calls.filter((a) => /_lbCustTrainerId\(/.test(a));
  eq('④★緩い版を認可に使っていない', loose, []);
}

// ---------- 6. ★顧客の一覧を返す入口（識別子を受け取らないので上では数えられない）----------
//   「顧客IDを受け取るか」で数えると、一覧を返す入口は1つも引っかからない。
//   実際 ma_myMembers は記録のある顧客を**全員**返しており、どのトレーナーからも
//   他の担当の顧客の氏名と測定履歴が見えていた（2026-10-03・Codexの5回目の判定）。
//   こういう入口は機械で見分けられないので、**名指しで並べて**絞り込みを確かめる。
//   新しく一覧を返す入口を作ったら、ここに足す。
const LIST_ENTRIES = {
  ma_myMembers:                { fn: 'maTrainerMembers_',     why: '体組成の記録がある顧客の一覧' },
  line_getTrainerReservations: { fn: 'getTrainerReservations', why: '担当予約と顧客の一覧' },
};
for (const [name, e] of Object.entries(LIST_ENTRIES)) {
  const body = (stripComments(ALL).match(new RegExp('function ' + e.fn + '\\([\\s\\S]*?\\n\\}')) || [])[0] || '';
  ok(`⑥${name} の本体が読める（${e.why}）`, !!body);
  // オーナーかどうかで分け、一般トレーナーは担当の集合で絞っていること
  ok(`⑥★${name} がオーナーと一般を分けている`, /_lbIsOwnerRole/.test(body), body.slice(0, 150));
  ok(`⑥★${name} が担当の集合で絞っている`, /_lbTrainerCustomers/.test(body), body.slice(0, 150));
}

console.log(`\n${fail ? '❌' : '✅'} GASの入口の守り 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
