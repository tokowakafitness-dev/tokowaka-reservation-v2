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
  /SELECT quota, coverage, used FROM monthly_quota\n\s*WHERE customer_id = \? AND month_key = \? AND built_version = \?/.test(V)
  && /SELECT total, used, opening_used FROM ticket_packs/.test(V),
  'ここで計算し直すと、同じコードの比較になり意味が無い');
//   ★顧客に出るのと**同じ条件**で見る（2026-10-09・設計13）。
//     読み取りをD1へ向けたあとは「いまの世代の行」だけが顧客に出る。
//     照合が全世代を見ていると、消えた契約の古い行で食い違いが出続け、
//     本物の食い違いが埋もれる。
ok('①★チケットも世代で絞る',
  /AND valid_from <= \? AND valid_to >= \? AND built_version = \?/.test(V));
ok('①★追いついていない会員は「不一致」ではなく「飛ばした」',
  /if \(!isFresh\(ver0\)\) \{/.test(V) && /VERSION_/.test(V),
  '作り直しの途中を不一致として数えると、本物の食い違いが埋もれる');
ok('①世代は入力を読む前に取る',
  V.indexOf('readSyncVersion(env, cid)') < V.indexOf('loadCalcInput(env, cid)'));

// ---------- 1-b. ★主キーの集合を照合する（切り替えの合格条件）----------
//   顧客の読み取り経路で見るのは**件数**だけ。それでは次が通ってしまう。
//     当月以外の月額行が欠けている／余っている
//     期限切れ・開始前のパックの主キーが違う
//     同じ枚数の別パックに入れ替わっている
//   （当月の残数はたまたま一致するので、残数の比較では見えない）
ok('①-b★計算が作るべき主キーを組み立てている', /buildQuotaForCustomer\(cid, input\.rows/.test(V));
ok('①-b★D1の同じ世代の主キーを読む',
  /SELECT month_key FROM monthly_quota WHERE customer_id = \? AND built_version = \?/.test(V)
  && /SELECT pack_id FROM ticket_packs WHERE customer_id = \? AND built_version = \?/.test(V));
ok('①-b★足りないものと余っているものを両方見る',
  /missing: want\.filter/.test(V) && /extra: got\.filter/.test(V),
  '欠けだけを見ると、別のパックに入れ替わった状態が通る');
ok('①-b★合わなければ「飛ばした」ではなく**不一致**にする',
  /out\.keyMismatch = \(out\.keyMismatch \|\| 0\) \+ 1;/.test(V) && /out\.pageOk = false;[\s\S]{0,200}keyMismatchDetail/.test(V),
  '合わないまま切り替えてはいけない');
//   ★範囲はURLで渡さない（2026-10-09・関門②の2周目）。
//     範囲は会員ごと・実行ごとに違う（全員ぶんは当月〜翌月、二重書きは recordsFrom〜当月+2）。
//     URLで渡すと推測になり、正しいD1の行を「欠けている／余っている」と誤って判定する。
ok('①-b★作り直しが保存した範囲を使う',
  /fromMonth: ver0\.fromMonth, toMonth: ver0\.toMonth/.test(V)
  && !/keysFrom/.test(V) && !/searchParams\.get\('from'\)/.test(V));
ok('①-b★範囲が保存されていなければ合格にしない',
  /out\.keyRangeMissing = \(out\.keyRangeMissing \|\| 0\) \+ 1;\n\s*out\.pageOk = false;/.test(V),
  '「検査が走らなかった」を「一致した」と読ませてはいけない');
ok('①-b★照合が走った数を出す', /out\.keyChecked = \(out\.keyChecked \|\| 0\) \+ 1;/.test(V),
  '0件なら合格にしてはいけない');
//   ★一致したときだけ数えると、全員が不一致のとき keyChecked が0になり、
//     「合わない」と「1人も走っていない」が同時に出て読めない（関門②の3周目）。
ok('①-b★一致・不一致にかかわらず数える',
  V.indexOf('out.keyChecked = (out.keyChecked || 0) + 1;') < V.indexOf('const mk = diffKeys('),
  'D1の主キーを読み終えた時点で数える');
ok('①-b★数えるのは1箇所だけ',
  (V.match(/out\.keyChecked = \(out\.keyChecked \|\| 0\) \+ 1;/g) || []).length === 1);
ok('①-b★計算に問題があるときは比べない',
  /if \(b2\.issues\.length\) \{/.test(V) && /KEY_EXPECTATION_NOT_OK/.test(V),
  '問題のある月を除いた途中までの集合を「作るべき集合」として比べてはいけない');
ok('①-b そのときも合格にしない',
  /KEY_EXPECTATION_NOT_OK[\s\S]{0,120}out\.pageOk = false;/.test(V));
ok('①-b 氏名を出さない', /customerId: mask\(cid\)/.test(V));

// ---------- 1-b2. ★GAS側が照合の結果を合否に入れているか ----------
//   ★Workerが keyMismatch を返しても、GASが見ていなければ「✅ 全員で一致しました」と出る。
//     2026-10-09・関門②の指摘：まさにその状態だった。
{
  const GAS = readFileSync(join(ROOT, 'gas/PushToEdge.js'), 'utf8');
  ok('①-b2 ページをまたいで数える',
     /total\.keyMismatch \+= Number\(r\.keyMismatch \|\| 0\);/.test(GAS)
     && /total\.keyChecked \+= Number\(r\.keyChecked \|\| 0\);/.test(GAS));
  ok('①-b2★合否の条件に入れる', /&& v\.keyMismatch === 0 && v\.keyRangeMissing === 0 && v\.keyChecked > 0/.test(GAS));
  ok('①-b2★「1人も走っていない」を一致と読ませない',
     /v\.keyChecked > 0/.test(GAS) && /照合が1人も走っていない/.test(GAS));
  ok('①-b2 合わない会員を表示する', /主キーの集合が合わない会員/.test(GAS));
  ok('①-b2 詳細は増えすぎないように止める', /total\.keyDetail\.length < 20/.test(GAS));
}

// ---------- 1-c. ★いまの世代の数え方（quotaStatus）----------
{
  const Q2 = readFileSync(join(ROOT, 'worker/src/routes/quota.js'), 'utf8');
  ok('①-c★追いついている会員の行だけを「いまの世代」と数える',
     (Q2.match(/v\.built_version > 0 AND v\.source_version = v\.built_version/g) || []).length === 2,
     'source > built の会員は、世代が一致していても読み取りの対象外（isFresh が false）');
}
ok('①月額は 枠−使った数', /Number\(mq\.quota\) - Number\(mq\.used\)/.test(V));
//   ★契約が対象月を覆っていない月は、繰越が残っていても 0 を見せる。
//     計算側（Allocate.js の monthlyRem）がそうしているため、同じ規則にする。
//     quota をそのまま読むと「残り1」に見えて食い違う（全パターン検証 A5 で発覚）。経緯は 0012。
ok('①★契約の覆い方で3つに分ける',
  /cov === 'limited'/.test(V) && /cov === 'uncovered'/.test(V) && /cov === 'unlimited'/.test(V),
  '1bitだと「頻度未設定（上限なし）」を「契約が切れた（残数0）」と取り違える');
ok('①★coverage が入っていない行は一致と数えない',
  /coverageMissing/.test(V) && /COVERAGE_NOT_SET/.test(V),
  'この列を足す前の行には uncovered も unlimited も混ざっている。既定値で埋めると誤って一致する');
//   ★表全体を見る2つの検査（Codex関門②の5回目）。
//     枠の作り直しは UPSERT だけで、生成対象から外れた古い行を消さない。
//     孤児検査は「契約が消えた会員」しか見ないので、残った行は別に数える。
ok('①★表全体で coverage が NULL の行を数える',
  /FROM monthly_quota WHERE coverage IS NULL/.test(V) && /staleCoverage/.test(V),
  '作り直しで取り残された行は、照合した月の外にあると見つからない');
ok('①★表全体で used > quota の行を数える（unlimited も含む）',
  /FROM monthly_quota WHERE used > quota/.test(V) && /quotaInvariantBroken/.test(V),
  'unlimited を overUsedMonths から外したので、ここが無いと引当の異常に気づけない');
ok('①★どちらも不合格にする',
  /if \(out\.staleCoverage \|\| out\.quotaInvariantBroken\) out\.pageOk = false;/.test(V));
ok('①★判定の名前にも出す',
  /HAS_STALE_COVERAGE/.test(V) && /QUOTA_INVARIANT_BROKEN/.test(V),
  '数だけ返して判定名に出さないと、読み手が合格と思い込む');
ok('①★月額の使いすぎも数える',
  /Number\(mq\.used\) > Number\(mq\.quota\)/.test(V) && /overUsedMonths/.test(V),
  '見せる残数は uncovered で0・unlimited で null になるので、表示では超過が消える');
ok('①チケットは有効なぶんの残りを足す',
  /valid_from <= \? AND valid_to >= \?/.test(V),
  '期限切れ・開始前のパックを数えると、計算側（ticketRem）とずれる');
ok('①★移行前に使った枚数も引く',
  /Number\(p\.total\) - Number\(p\.opening_used \|\| 0\) - Number\(p\.used\)/.test(V),
  '台帳は9月からだが店舗は3月オープン。3〜8月の消化を引かないと残りが多く見える');
ok('①★使いすぎを0に丸めて隠さない',
  /if \(rest < 0\) overUse \+= -rest;/.test(V) && /out\.pageOk = false;/.test(V),
  '丸めると計算側も0なので「一致」と出て、買った枚数を超えて使っている異常が見えなくなる');

// ---------- 2. 「枠が無い」と「残り0」を取り違えない ----------
ok('②★枠の行が無ければ null（月額契約が無いの意味）',
  /let d1Monthly = null[\s\S]{0,400}?if \(mq\) \{/.test(V)
  && /else if \(cov === 'unlimited'\) d1Monthly = null;/.test(V),
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
ok('⑩★使いすぎも条件に入れる', /&& v\.overUsedPacks === 0/.test(GAS),
  '書き込みを止める前に入った壊れた値は残る。読み取りをD1へ向ける前に必ず見つける');
ok('⑩★表全体の2つの検査も条件に入れる',
  /&& v\.staleCoverage === 0 && v\.quotaInvariantBroken === 0/.test(GAS),
  '最後のページでしか返らない値なので、入れ忘れると黙って通る');
ok('⑩★表全体の検査は足さずに置き換える',
  /if \(r\.staleCoverage != null\) total\.staleCoverage = Number\(r\.staleCoverage\);/.test(GAS),
  '全表の件数をページごとに足すと、ページ数ぶん多く数えてしまう');
ok('⑩★検査が走っていない（null）ときも合格にしない',
  /v\.staleCoverage === 0/.test(GAS) && /v\.quotaInvariantBroken === 0/.test(GAS),
  '初期値は null。=== 0 なので null では合格にならない');
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
