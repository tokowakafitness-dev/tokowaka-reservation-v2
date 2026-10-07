// 枠を作る窓口が、守られていることを固定する
//
//   ★なぜ要るのか
//     枠（monthly_quota / ticket_packs）は**すべての残数の土台**。
//     引当はこの行を親として見るので、枠を作り直せる人は残数そのものを壊せる。
//     お客様のブラウザからも、トレーナーの画面からも呼べてはならない。
//
//   ★既定が「書かない」であること
//     本番の実データで試す窓口なので、うっかり叩いただけで枠が書き換わると困る。
//     dry=0 を明示したときだけ書く。
//
//   実行: node worker/test/quota-route.test.js

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const ROUTE = readFileSync(join(ROOT, 'worker/src/routes/quota.js'), 'utf8');
const INDEX = readFileSync(join(ROOT, 'worker/src/index.js'), 'utf8');
const BUILD = readFileSync(join(ROOT, 'worker/src/lib/quota-build.js'), 'utf8');
const ALLOC = readFileSync(join(ROOT, 'worker/src/lib/alloc-build.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) { cond ? pass++ : (fail++, console.log(`❌ ${name}${extra ? '\n   ' + extra : ''}`)); }

// ---------- 1. 合言葉なしでは通らない ----------
ok('①両方の窓口が合言葉を確かめる',
  /export async function buildQuota\(request, env\) \{\s*\n\s*const deny = requireSecret\(request, env\);/.test(ROUTE)
  && /export async function quotaStatus\(request, env\) \{\s*\n\s*const deny = requireSecret\(request, env\);/.test(ROUTE),
  '枠を作り直せる人は、残数そのものを壊せる');
ok('①合言葉が未設定なら動かない', /if \(!secret\) return json\(\{ ok: false, reason: 'SECRET_NOT_SET' \}, 503\)/.test(ROUTE));
ok('①合わなければ403', /reason: 'FORBIDDEN' \}, 403\)/.test(ROUTE));
ok('①時間差の出ない比較をしている', /diff \|= \(x\[i\] \|\| 0\) \^ \(y\[i\] \|\| 0\)/.test(ROUTE),
  '素朴な === だと、合言葉を1文字ずつ当てられる');
ok('①ingest と同じヘッダ名を使う', /request\.headers\.get\('X-Ingest-Secret'\)/.test(ROUTE));

// ---------- 2. 既定は「書かない」 ----------
ok('②★dry が既定', /const dry = url\.searchParams\.get\('dry'\) !== '0';/.test(ROUTE),
  'うっかり叩いただけで枠が書き換わると、全員の残数が動く');
ok('②書くのは dry でないときだけ', /if \(!dry\) \{[\s\S]{0,200}?env\.DB\.batch/.test(ROUTE));

// ---------- 3. 顧客の情報を出さない ----------
ok('③顧客IDは下4桁だけ', /function mask\(id\)/.test(ROUTE) && /'\*' \+ s\.slice\(-4\)/.test(ROUTE));
ok('③結果に生の顧客IDを入れない',
  /summary\.skipped\.push\(\{ customerId: mask\(cid\)/.test(ROUTE)
  && /summary\.issues\.push\(\{ \.\.\.is, customerId: mask\(is\.customerId\) \}\)/.test(ROUTE));
ok('③氏名を出す経路が無い', !/customer_name|\.name\b/.test(ROUTE));

// ---------- 4. ルーティングに繋がっている ----------
ok('④2つの道が通っている',
  /url\.pathname === '\/quota\/build'/.test(INDEX) && /url\.pathname === '\/quota\/status'/.test(INDEX));
ok('④読み込まれている', /import \{ buildQuota, quotaStatus \} from '\.\/routes\/quota\.js';/.test(INDEX));

// ---------- 5. ★used に触れない（設計の不変条件） ----------
ok('⑤★更新で used を書き換えない',
  !/DO UPDATE SET[\s\S]{0,200}?used\s*=/.test(BUILD),
  '既にある枠の used を書き換えると、使った数が消える。動かすのはトリガーだけ');
ok('⑤新しく作るときだけ used=0', /VALUES \(\?, \?, \?, 0, \?\)/.test(BUILD));
ok('⑤枠を直接UPDATEする文が無い',
  !/UPDATE monthly_quota|UPDATE ticket_packs/.test(BUILD) && !/UPDATE monthly_quota|UPDATE ticket_packs/.test(ROUTE),
  'アプリ側のSQLに枠のUPDATEが現れたら、それは設計からの逸脱');

// ---------- 6. 計算入力が古ければ枠を作らない ----------
ok('⑥入力が揃わない会員は飛ばす', /if \(!input\.ok\) \{[\s\S]{0,300}?summary\.skipped\.push/.test(ROUTE),
  '古い契約で枠を作ると、そこから作られる引当も残数もずれる');

// ---------- 7. 範囲の指定が壊れていたら止まる ----------
ok('⑦月の形と前後関係を見る',
  /!\/\^\\d\{4\}-\\d\{2\}\$\/\.test\(from\) \|\| !\/\^\\d\{4\}-\\d\{2\}\$\/\.test\(to\) \|\| from > to/.test(ROUTE));

// ---------- 8. 一度に処理する人数を区切る ----------
//   ★会員1人につき loadCalcInput が5本のクエリを投げる。39名を一気に回すと200を超え、
//     Workerのサブリクエスト上限に当たる。しかも会員ごとに書くので、途中で止まると
//     **一部の会員だけ枠が書かれた状態**になる（2026-10-07 Codex関門②の指摘）。
ok('⑧区切りの指定がある', /const limit = Math\.max\(1, Math\.min\(Number\(url\.searchParams\.get\('limit'\) \|\| 5\) \|\| 5, 8\)\)/.test(ROUTE));
ok('⑧★上限は8（1+8×5+8=49でサブリクエスト上限50に収まる）', /, 8\)\)/.test(ROUTE),
  '最初は上限25にしていたが、10名で61回になり超過する。数え方を間違えていた');
ok('⑧失敗したときのやり直し位置を返す', /retryFrom: after,/.test(ROUTE),
  '失敗したページは next を返さないので、呼ぶ側が直前の after を覚えている必要がある');
ok('⑧★二度処理しても壊れないことを書いてある', /UPSERT なので、同じ会員を二度処理しても結果は変わらない/.test(ROUTE));
ok('⑧続きの位置を受け取る', /const after = \(url\.searchParams\.get\('after'\) \|\| ''\)\.trim\(\);/.test(ROUTE));
ok('⑧★問い合わせ自体を区切る',
  /WHERE customer_id > \? ORDER BY customer_id LIMIT \?/.test(ROUTE),
  '全件取ってから切ると、読み取りの量は減らない');
ok('⑧続きの印を返す', /summary\.next = \(ids\.length === limit\) \? ids\[ids\.length - 1\] : null;/.test(ROUTE));
ok('⑧終わったことが分かる', /summary\.done = \(summary\.next === null\);/.test(ROUTE));
ok('⑧1人を指定したときは区切らない', /} else \{\s*\n\s*summary\.done = true;/.test(ROUTE));

// ---------- 9. 引当を作るとき ----------
//   ★枠だけ作って引当を作らないと used が0のまま＝「誰も使っていない」ことになる。
//     逆に引当を二度入れると used が二重に増える＝残数が実際より減る。
ok('⑨引当は明示したときだけ作る', /const withAlloc = url\.searchParams\.get\('alloc'\) === '1';/.test(ROUTE),
  '枠だけ作り直したい場面があるので、別の指定にしておく');
ok('⑨★枠と引当を同じ書き込みで入れる', /quotaUpsertStatements\(built, now\)\.concat\(allocStmts\)/.test(ROUTE),
  '枠が先・引当が後。引当のINSERTは枠の行を親として見る');
ok('⑨入れ直しは OR IGNORE にしない', /INSERT INTO reservation_allocations/.test(ALLOC) && !/INSERT OR IGNORE INTO reservation_allocations/.test(ALLOC),
  '全部消したあとなので衝突しない。OR IGNORE だと消し損ねたとき黙って古い行が残る');
ok('⑨★流し直すと正しくなる（対象期間を全部消して入れ直す）',
  /DELETE FROM reservation_allocations[\s\S]{0,160}?WHERE customer_id = \? AND resv_month >= \? AND resv_month <= \?/.test(ALLOC)
  && !/reservation_id NOT IN/.test(ALLOC)
  && /allocationInsertStatements\(al, now, \{ customerId: cid, fromMonth: from, toMonth: to \}\)/.test(ROUTE),
  'NOT IN で残すと、消化先が変わった予約の古い引当が消えず、INSERT OR IGNORE も無視する');
ok('⑨★計算できなかった会員には何もしない',
  /if \(!built\.computed\) return \[\];/.test(ALLOC),
  'ok:false は「予約が0件」ではなく「計算できなかった」。消すと used が0になり、枠を超えて予約できてしまう');
ok('⑨★予約の月を別に持つ',
  /resvMonth: mk/.test(ALLOC) && /resv_month/.test(ALLOC),
  'month_key は月額専用。チケットや振替がどの月の予約かを持たないと、期間で絞れない');
ok('⑨あふれた予約は行にしない', /if \(ps\.alloc === 'unallocated'\) \{ out\.skippedUnallocated\+\+; continue; \}/.test(ALLOC),
  '超過は「防ぐのではなく見せる」（決定0068）。行を作ると超過が見えなくなる');
ok('⑨あふれた件数を返す', /summary\.overflow \+= al\.skippedUnallocated;/.test(ROUTE));
ok('⑨計算が要確認なら引当を作らない', /code: 'REMAINING_NOT_OK'/.test(ALLOC));
ok('⑨★割り当て方を決め直していない',
  !/used\s*[<>+]/.test(ALLOC) && /_lbComputeRemaining/.test(ALLOC),
  'ここで決め直すと、GASの残数とD1の残数が実装の違いでずれる');

console.log('');
console.log(`${fail ? '❌' : '✅'} 枠を作る窓口 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
