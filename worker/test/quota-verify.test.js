// D1の行と計算の突き合わせが、意味のある比較になっていることを固定する
//
//   ★なぜ要るのか
//     D1を正本にするとは「残数を計算で出す」のをやめて「行から読む」こと。
//     行から読んだ値が計算と違えば、顧客の残数が変わる。
//     段階3-b（読み取りをD1へ向ける）に進んでよいかは、この照合が一致するかで決まる。
//
//   ★既存の照合（routes/verify.js）と混同しない
//     既存    GASの計算 vs Workerの計算   … 同じコードを回すので、合って当然
//     ここ    計算の答え vs D1の行         … 別々の仕組みが同じ答えに至るか
//     既存だけを見て「一致した」と判断すると、D1の行が壊れていても気づけない。
//
//   実行: node worker/test/quota-verify.test.js

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const V = readFileSync(join(ROOT, 'worker/src/routes/quota-verify.js'), 'utf8');
const INDEX = readFileSync(join(ROOT, 'worker/src/index.js'), 'utf8');
const GAS = readFileSync(join(ROOT, 'gas/PushToEdge.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) { cond ? pass++ : (fail++, console.log(`❌ ${name}${extra ? '\n   ' + extra : ''}`)); }

// ---------- 1. 比べているものが正しい ----------
ok('①計算の答えを出している', /_lbComputeRemaining\(cid, input\.rows, input\.sessions/.test(V));
ok('①★D1の行から読んでいる（計算し直していない）',
  /SELECT quota, used FROM monthly_quota WHERE customer_id = \? AND month_key = \?/.test(V)
  && /SELECT total, used FROM ticket_packs/.test(V),
  'ここで計算し直すと、同じコードの比較になり意味が無い');
ok('①月額は 枠−使った数', /Number\(mq\.quota\) - Number\(mq\.used\)/.test(V));
ok('①チケットは有効なぶんの残りを足す',
  /valid_from <= \? AND valid_to >= \?/.test(V)
  && /Math\.max\(0, Number\(p\.total\) - Number\(p\.used\)\)/.test(V),
  '期限切れ・開始前のパックを数えると、計算側（ticketRem）とずれる');

// ---------- 2. 「枠が無い」と「残り0」を取り違えない ----------
ok('②★枠の行が無ければ null（月額契約が無いの意味）',
  /const d1Monthly = mq \? \(Number\(mq\.quota\) - Number\(mq\.used\)\) : null;/.test(V),
  '0 にすると「月額契約があって残り0」と区別できない');
ok('②計算側の null と突き合わせる',
  /\(d1Monthly === null && calcMonthly === null\) \|\| \(Number\(d1Monthly\) === Number\(calcMonthly\)\)/.test(V));

// ---------- 3. 1人でも違えば「合っていない」 ----------
ok('③★食い違いがあれば落とす', /if \(out\.differ\) out\.pageOk = false;/.test(V),
  '「だいたい合っている」で先に進むと、その人の残数が変わる');
ok('③食い違った会員を名指しで返す', /out\.diffs\.push\(\{/.test(V));
ok('③手がかりを添える（枠の行があるか・使った数）',
  /quotaRow: mq \? \{ quota: Number\(mq\.quota\), used: Number\(mq\.used\) \} : null/.test(V),
  '数が違うだけでは、枠が無いのか使った数がずれたのか分からない');

// ---------- 4. 比べられなかった人を「一致」に数えない ----------
ok('④入力が揃わなければ skipped', /if \(!input\.ok\) \{ out\.skipped\+\+;/.test(V));
ok('④★計算できなければ skipped（一致に数えない）',
  /if \(!a \|\| a\.ok === false\) \{ out\.skipped\+\+;/.test(V),
  '計算できない人を「一致」に入れると、合っている人数が水増しされる');

// ---------- 5. 守り ----------
ok('⑤合言葉で守る', /const deny = requireSecret\(request, env\);/.test(V));
ok('⑤読み取りだけ（書き込む文が無い）',
  !/INSERT |UPDATE |DELETE /.test(V), '照合で書き換えてはいけない');
ok('⑤氏名を出さない', /function mask\(id\)/.test(V) && !/customer_name/.test(V));

// ---------- 6. 人数で区切る ----------
ok('⑥区切りがある', /Math\.min\(Number\(url\.searchParams\.get\('limit'\) \|\| 5\) \|\| 5, 8\)/.test(V));
ok('⑥続きの印を返す', /out\.next = \(ids\.length === limit\) \? ids\[ids\.length - 1\] : null;/.test(V));

// ---------- 7. 道が通っている ----------
ok('⑦ルーティングにある', /url\.pathname === '\/quota\/verify'/.test(INDEX));
ok('⑦既存の /verify とは別の道', /url\.pathname === '\/quota\/verify'/.test(INDEX) && /verifyQuota/.test(INDEX));

// ---------- 8. ★「一致した」と誤認する経路を塞ぐ ----------
//   Codex関門②の指摘（2026-10-07）。どれも「合格」と出してはいけない状態。
ok('⑧★今月以外は比べない',
  /if \(month !== nowMonthKeyJst\(now\)\)/.test(V) && /ONLY_CURRENT_MONTH/.test(V),
  'D1は指定月を読み、計算はいまの残数を返す。別の月を比べて、たまたま同じなら「一致」と出る');
ok('⑧★比べられない人がいたら合格にしない', /if \(out\.skipped\) out\.pageOk = false;/.test(V));
ok('⑧★1人も比べていなければ合格にしない', /if \(!out\.checked\) out\.pageOk = false;/.test(V));
ok('⑧★途中までなら合格にしない', /if \(!out\.done\) out\.pageOk = false;/.test(V));
ok('⑧比べられなかった理由を残す', /out\.skippedWhy\[input\.reason\]/.test(V),
  '件数だけだと、なぜ比べられなかったのか追えない');
ok('⑧★判定の名前が「このページ限り」と分かる',
  /out\.pageVerdict = out\.pageOk \? 'PAGE_AGREE'/.test(V)
  && !/AGREE_ALL/.test(V),
  'ok / AGREE_ALL という名前だと、Workerを直接読む人が全体の合否と誤認する');

// ---------- 9. ★D1にだけ残った行（孤児）を見つける ----------
//   比べているのは計算側に居る会員だけ。契約が消えた会員の枠や引当がD1に残っていても、
//   会員ごとの比較には現れない。段階3-bでD1を直接読むなら、その行も読まれる。
ok('⑨孤児の枠を数える',
  /FROM monthly_quota\s*\n\s*WHERE customer_id NOT IN \(SELECT DISTINCT customer_id FROM calc_contract_rows\)/.test(V));
ok('⑨孤児の引当を数える',
  /FROM reservation_allocations\s*\n\s*WHERE customer_id NOT IN \(SELECT DISTINCT customer_id FROM calc_contract_rows\)/.test(V));
ok('⑨★孤児があれば合格にしない',
  /if \(out\.orphans\.quotaRows \|\| out\.orphans\.packRows \|\| out\.orphans\.allocRows\) out\.pageOk = false;/.test(V));

// ---------- 10. ★全ページを集計して判断する（ページ単位で判断しない） ----------
//   Codex関門②の2回目。ページごとの判定を見ると、前のページの食い違いを見落とす。
//   最後のページ単体が「一致」でも、2ページ目に食い違いがあれば全体は一致ではない。
ok('⑩★全体の合否を示す名前を返さない',
  !/\bout\.ok\b/.test(V) && /pageOk: true/.test(V),
  'ok という名前が残っていると、このページだけの結果を全体の合否と読んでしまう');
ok('⑩★呼ぶ側が全ページを集計して判断する',
  /var allGood = v\.done && v\.checked > 0 && v\.differ === 0 && v\.skipped === 0/.test(GAS),
  'ページごとの pageOk を見て決めると、前のページの食い違いを見落とす');
ok('⑩★孤児も条件に入れる',
  /&& v\.orphans && !v\.orphans\.quotaRows && !v\.orphans\.packRows && !v\.orphans\.allocRows/.test(GAS));
ok('⑩合格でないときは理由を全部並べる',
  /まだ「全員一致」とは言えません/.test(GAS)
  && /最後まで到達していない/.test(GAS) && /食い違いが/.test(GAS) && /比べられなかった人が/.test(GAS));
ok('⑩★D1へ向けてはいけないと書いてある', /残数の読み取りをD1へ向けてはいけません/.test(GAS));
ok('⑩比べられなかった理由をページ間で足す',
  /total\.skippedWhy\[w\] = \(total\.skippedWhy\[w\] \|\| 0\) \+ Number\(r\.skippedWhy\[w\] \|\| 0\)/.test(GAS));

// ---------- 11. 孤児の検査に3つの表すべてを含める ----------
ok('⑪枠・チケット・引当の3つを数える',
  /FROM monthly_quota\s*\n\s*WHERE customer_id NOT IN/.test(V)
  && /FROM ticket_packs\s*\n\s*WHERE customer_id NOT IN/.test(V)
  && /FROM reservation_allocations\s*\n\s*WHERE customer_id NOT IN/.test(V),
  'チケットが抜けていた（Codex指摘）。1つでも漏れると、そこに残った行が見えない');

console.log('');
console.log(`${fail ? '❌' : '✅'} D1と計算の突き合わせ 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
