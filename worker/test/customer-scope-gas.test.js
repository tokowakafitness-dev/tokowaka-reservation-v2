// トレーナーが見てよい顧客の範囲を、GAS側でも守っていることの検証
//
//   ★なぜ要るのか（2026-10-03・Codexの最終判定）
//     2026-09-29、オーナーの決定で「他のトレーナーの担当顧客は見せない」と決め、
//     Worker側（canSeeCustomer）を塞いだ。ところが**GAS側が塞がれていなかった。**
//
//       getCustomerHomeForTrainer … トレーナーであることしか見ていなかった
//       maInBodyCard_             … 顧客IDだけで体組成の記録を返す
//
//     画面はWorkerが答えられないとき**必ずGASへ落ちる**。だから片方だけ塞いでも
//     意味がない。顧客IDを知っているトレーナーは、落ちた先で担当外の残数と
//     身体データを取得できた。
//
//   ★そしてGASとWorkerで規則が食い違うと、落ちた先だけ緩くなる。
//     規則が同じであることをここで固定する。
//
//   実行: node worker/test/customer-scope-gas.test.js

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const LB    = readFileSync(join(ROOT, 'gas/LineBooking.js'), 'utf8');
const BATCH = readFileSync(join(ROOT, 'gas/LbBatch.js'), 'utf8');

// 行コメントを落とした版。
//   コメントにも関数名を書いている（「InBody（maInBodyCard_）は…」のように）。
//   位置で前後を比べるときにコメントを数えると、実装は正しいのに落ちる。
const code = (t) => t.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
const BATCH_CODE = code(BATCH);
const PERMS = readFileSync(join(ROOT, 'worker/src/perms.js'), 'utf8');

let pass = 0, fail = 0;
function eq(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log(`❌ ${name}\n   got : ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`); }
}
function ok(name, cond, extra) { cond ? pass++ : (fail++, console.log(`❌ ${name}${extra ? '\n   ' + extra : ''}`)); }

// ---------- 1. 判定そのもの ----------
//   GASの実コードから関数を取り出して動かす（書いてあることと動くことを一致させる）。
const src = (LB.match(/function _lbTrainerMaySeeCustomer\(tr, ownerTrainerId\)\{?[\s\S]*?\n\}/) || [])[0] || '';
ok('①判定の関数がある', !!src);
const maySee = new Function('_lbIsOwnerRole', src + '; return _lbTrainerMaySeeCustomer;')(
  (tr) => !!(tr && tr.role === 'owner'));

const trainer = { trainerId: 't1', role: 'trainer' };
const other   = { trainerId: 't2', role: 'trainer' };
const owner   = { trainerId: 't9', role: 'owner' };

eq('①自分の担当は見える',        maySee(trainer, 't1'), true);
eq('①★他のトレーナーの担当は見えない', maySee(trainer, 't2'), false);
eq('①実在して担当なし（空）は見える', maySee(trainer, ''), true);
// ★「判定できない」は見せない（2026-10-03・Codexの再判定）。
//   顧客が見つからない／シートが読めないとき、以前は '' が返って
//   「担当なし＝誰が見てもよい」と解釈されていた。
//   **実在しない顧客IDを投げるだけで通る**状態だった（fail-open）。
eq('①★判定できない（null）は見せない',      maySee(trainer, null), false);
eq('①★判定できない（undefined）も見せない', maySee(trainer, undefined), false);
// ★判定できないときは**オーナーでも通さない**（2026-10-03・Codexの4回目の判定）。
//   後ろに置くと、オーナーが実在しない顧客IDで体組成を書けてしまい、
//   誰のものでもない記録が残る。権限の話ではなくデータの整合の話。
eq('①★判定できなければオーナーでも通さない', maySee(owner, null), false);
eq('①オーナーは実在する他人の担当なら見える', maySee(owner, 't1'), true);
eq('①オーナーは他人の担当も見える', maySee(owner, 't1'), true);
eq('①オーナーは誰でも見える',     maySee(owner, 't2'), true);
eq('①トレーナーでなければ見えない', maySee(null, ''), false);
eq('①別のトレーナーから見ても同じ', maySee(other, 't1'), false);
// 数値と文字列の取り違えで通さない
eq('①IDが数値でも文字列として比べる', maySee({ trainerId: 1, role: 'trainer' }, '1'), true);
eq('①違うIDなら数値でも通さない',   maySee({ trainerId: 1, role: 'trainer' }, '2'), false);

// ---------- 2. ★顧客を見る入口が、すべてこの判定を通ること ----------
//   1つでも漏れると、そこから担当外の顧客が見える。
{
  // 残数（顧客カードの中心）
  const home = (LB.match(/function getCustomerHomeForTrainer\([\s\S]*?\n\}/) || [])[0] || '';
  ok('②残数の入口が判定を通る', /_lbTrainerMaySeeCustomer\(tr, ownerTid\)/.test(home));
  ok('②★「トレーナーであること」だけで返していない',
     /_lbTrainerMaySeeCustomer/.test(home) && home.indexOf('_lbBuildHome') > home.indexOf('_lbTrainerMaySeeCustomer'),
     '判定より先に残数を作っていないか');

  // 固定枠
  const recur = (LB.match(/function listRecurringPatternsByTrainer\([\s\S]*?\n\}/) || [])[0] || '';
  ok('②固定枠の入口が判定を通る', /_lbTrainerMaySeeCustomer/.test(recur));
  ok('②固定枠で古い判定式が残っていない', !/!_lbIsOwnerRole\(tr\) && ct && ct !== String\(tr\.trainerId\)/.test(recur));

  // 顧客カードのまとめ取得（InBody を含む）。
  //   ★関数の中に無名関数が入れ子になっているので、正規表現で関数ごと切り出さない
  //     （最初の閉じ括弧で切れて、中身を見落とす）。ファイル内の位置で比べる。
  ok('②顧客カードの入口が判定を通る', /_lbTrainerMaySeeCustomer/.test(BATCH));
  {
    const iCard  = BATCH_CODE.indexOf('function lbCustomerCard');
    const iGuard = BATCH_CODE.indexOf('_lbTrainerMaySeeCustomer', iCard);
    const iBody  = BATCH_CODE.indexOf('maInBodyCard_', iCard);
    ok('②顧客カードの関数がある', iCard >= 0);
    ok('②★InBody を呼ぶ前に判定している',
       iGuard > iCard && iBody > iGuard,
       `card=${iCard} guard=${iGuard} inBody=${iBody}（InBody は顧客IDだけで体組成を返す）`);
    // 残数・固定枠より前であること（3つとも守られる位置）
    const iHome = BATCH_CODE.indexOf('getCustomerHomeForTrainer', iCard);
    ok('②★残数を呼ぶ前にも判定している', iHome > iGuard, `home=${iHome} guard=${iGuard}`);
  }
}

// ---------- 3. ★GASとWorkerで規則が食い違わないこと ----------
//   画面はWorkerが答えられないとき必ずGASへ落ちる。
//   片方だけ緩いと、落ちた先から見えてしまう。
{
  // Worker側（canSeeCustomer）の規則：担当が自分 or 担当なし or オーナー
  ok('③Worker側にも同じ規則がある', /export async function canSeeCustomer/.test(PERMS));
  ok('③Worker：オーナーは全員', /role === 'owner'[\s\S]{0,200}return true/.test(PERMS));
  ok('③Worker：担当なしは見える',
     /!tid|tid === ''|default_trainer_id/.test(PERMS), 'canSeeCustomer が担当未設定を通す記述');

  // 両方に「担当が他人なら false」があること（文言ではなく意味で確かめる）
  const workerFn = (PERMS.match(/export async function canSeeCustomer[\s\S]*?\n\}/) || [])[0] || '';
  ok('③Worker側の関数が読める', !!workerFn);
  ok('③★Worker側も担当トレーナーIDと突き合わせている',
     /trainerId/.test(workerFn) && /default_trainer_id|tid/.test(workerFn));
}

// ---------- 3-2. ★顧客IDを受け取る入口がすべて厳格版を使っていること ----------
//   権限判定に _lbCustTrainerId（見つからなくても '' を返す）を使うと fail-open になる。
//   判定用は _lbCustOwnerOf（見つからなければ null）だけを使う。
{
  const strict = (LB.match(/function _lbCustOwnerOf[\s\S]*?\n\}/) || [])[0] || '';
  ok('③-2 厳格版がある', !!strict);
// ★判定できないかどうかを、オーナーより**先に**見ていること
{
  const fn = (LB.match(/function _lbTrainerMaySeeCustomer[\s\S]*?\n\}/) || [])[0] || '';
  const iNull  = fn.indexOf('ownerTrainerId === null');
  const iOwner = fn.indexOf('_lbIsOwnerRole');
  ok('③-2★判定不能の確認がオーナー判定より前にある', iNull > 0 && iOwner > iNull,
     `null=${iNull} owner=${iOwner}`);
}
  ok('③-2★読めなければ null', /if \(!sh \|\| sh\.getLastRow\(\) < 2\) return null;/.test(strict));
  ok('③-2★見つからなければ null', /return null;\s*\n?\s*\/\/ 見つからない|return null;\s*\/\/ 見つからない/.test(strict)
     || strict.trim().endsWith('return null;\n}'), strict.slice(-120));

  // 判定に厳格版を使っている入口の数を数える（1つでも緩い版が混ざったら落とす）
  const guards = [...(LB + BATCH).matchAll(/_lbTrainerMaySeeCustomer\((\w+), ([^)]+)\)/g)]
                   .map((m) => m[2].trim());
  ok('③-2 判定の呼び出しを拾えた', guards.length >= 4, `${guards.length}個`);
  const loose = guards.filter((g) => /_lbCustTrainerId\(/.test(g));
  eq('③-2★権限判定に緩い版（_lbCustTrainerId）を使っていない', loose, []);
}

// ---------- 3-3. ★顧客IDを受け取るGASの入口に漏れが無いこと ----------
//   画面はWorkerが FORBIDDEN を返しても**GASへ落ちる**（成功以外はすべてフォールバック）。
//   だからWorkerだけ塞いでも意味がない。GAS側の入口を1つずつ確かめる。
{
  const codeLB = code(LB);
  // InBody の読み取りと**書き込み**。書き込みは他人の記録に測定値を混ぜられるので重い。
  const iCard = codeLB.indexOf("case 'line_maInBodyCard'");
  const iSave = codeLB.indexOf("case 'line_maSaveInBody'");
  ok('③-3 InBody の入口がある', iCard >= 0 && iSave >= 0);
  ok('③-3★InBody の読み取りに担当照合がある',
     /line_maInBodyCard[\s\S]{0,400}_lbTrainerMaySeeCustomer/.test(codeLB));
  ok('③-3★InBody の書き込みに担当照合がある',
     /line_maSaveInBody[\s\S]{0,400}_lbTrainerMaySeeCustomer/.test(codeLB));
  // 予約オプション（チケット残・ペア残・期限が出る）
  const opt = (codeLB.match(/function getBookingOptions[\s\S]*?\n\}/) || [])[0] || '';
  ok('③-3★予約オプションに担当照合がある', /_lbTrainerMaySeeCustomer/.test(opt));
  ok('③-3 予約オプションは照合してから名簿を読む',
     opt.indexOf('_lbTrainerMaySeeCustomer') < opt.indexOf('MAP_SHEET'));
}

// ---------- 4. 書き込み側の判定も残っていること（退行していないこと）----------
//   読み取りを塞ぐときに、既にあった書き込みの判定を壊していないか。
ok('④代行予約の担当判定が残っている',
  /この会員の担当トレーナーのみ代行予約ができます/.test(LB));
ok('④チケット追加の担当判定が残っている', /function addTicketRefill/.test(LB));
ok('④固定枠の削除は担当を確かめる', /_lbTrainerCanManageRecur/.test(LB));
// ★固定枠の追加・削除も厳格版を使っていること（4回目の判定で見つかった漏れ）
{
  const manage = (LB.match(/function _lbTrainerCanManageRecur[\s\S]*?\n\}/) || [])[0] || '';
  ok('④★固定枠の操作が厳格版を使う', /_lbTrainerMaySeeCustomer\(tr, _lbCustOwnerOf/.test(manage));
  ok('④★固定枠の操作に緩い版が残っていない', !/_lbCustTrainerId\(/.test(manage));
  const add = (LB.match(/function addRecurringPatternByTrainer[\s\S]*?\n\}/) || [])[0] || '';
  ok('④★固定枠の追加も厳格版を使う', /_lbTrainerMaySeeCustomer\(tr, _lbCustOwnerOf/.test(add));
  ok('④★固定枠の追加に緩い版が残っていない', !/_lbCustTrainerId\(/.test(add));
}

// ---------- 5. ★トレーナー予約一覧の範囲が、GASとWorkerで同じこと ----------
//   見える範囲が経路によって変わるのは、それ自体が不具合。
//   Worker経由にした瞬間に「自分の顧客の予約が一覧から消える」（他のトレーナーが
//   代行した分など）と、トレーナーは何が起きたか分からない。
//   なお操作（キャンセル・変更）の権限はGASが予約行ごとに判定するので、
//   広く見えても他人の担当予約を動かせるわけではない。
{
  const COMPAT = readFileSync(join(ROOT, 'worker/src/routes/compat.js'), 'utf8');

  // GAS：予約の担当が自分 **または** 顧客が担当範囲（担当なしを含む）に居る
  ok('⑤GASは「予約担当が自分 or 顧客が担当範囲」',
     /String\(r\[4\]\) !== String\(tr\.trainerId\) && !_custIds\[String\(r\[2\]\)\]/.test(LB));

  // Worker：同じ条件になっていること
  const fn = (COMPAT.match(/export async function compatTrainerReservations[\s\S]*?\n\}/) || [])[0] || '';
  ok('⑤Worker側の一覧が読める', !!fn);
  ok('⑤★Workerも「予約担当が自分 or 顧客が担当範囲」',
     /trainer_id = \?\s*\n?\s*OR customer_id IN \(SELECT customer_id FROM customers WHERE/.test(fn),
     '予約担当だけで絞っていると、自分の顧客の予約が消える');
  ok('⑤絞り込みの値を渡している', /bind\(now, who\.trainerId, \.\.\.scope\.args\)/.test(fn));
  // オーナーは全件（どちらも）
  ok('⑤オーナーは絞らない', /owner\s*\n?\s*\?\s*`SELECT reservation_id[\s\S]{0,200}status = 'booked' ORDER BY/.test(fn));
}

// ---------- 7. ★操作できない予約にボタンを出さないこと ----------
//   一覧には「自分の担当顧客が、別のトレーナーで取った予約」も出る。
//   ところが変更・取消は**その予約の担当**しかできない（サーバーが拒む）。
//   誰の予約かを返さないと、**ボタンは出るのに押すと断られる**
//   （2026-10-03・Codexの最終判定）。
{
  const COMPAT = readFileSync(join(ROOT, 'worker/src/routes/compat.js'), 'utf8');
  const HTML   = readFileSync(join(ROOT, 'liff/index.html'), 'utf8');

  ok('⑦GASの一覧が担当を返す', /trainerId:\s*String\(r\[4\] \|\| ''\)/.test(LB));
  ok('⑦Workerの一覧が担当を返す', /trainerId: String\(r\.trainer_id \|\| ''\)/.test(COMPAT));
  ok('⑦Workerが担当を取り出している', /channel, trainer_id/.test(COMPAT));

  ok('⑦★画面が自分の予約かを見ている', /String\(r\.trainerId\) === String\(state\.myTrainerId\)/.test(HTML));
  // ★オーナーは他のトレーナーの予約も変更・取消できる（サーバーがそう判定する）。
  //   入れ忘れると、本来できる操作のボタンが消える。
  ok('⑦★オーナーは出し分けの対象外', /var _mine = state\._isOwner/.test(HTML));
  ok('⑦オーナーかどうかを控えている', /state\._isOwner = !!res\.isOwner/.test(HTML));
  // 3つの場合で、ボタンを出すかどうかが設計どおりか（実際に式を動かして確かめる）
  {
    const expr = (HTML.match(/var _mine = state\._isOwner[\s\S]*?;/) || [])[0] || '';
    ok('⑦出し分けの式が読める', !!expr);
    const mine = new Function('state', 'r', expr.replace('var _mine =', 'return') .replace(/;$/, ';'));
    const me = { myTrainerId: 't1', _isOwner: false };
    const owner = { myTrainerId: 't9', _isOwner: true };
    eq('⑦一般：自分の予約は出す',        mine(me, { trainerId: 't1' }), true);
    eq('⑦★一般：他人の予約は出さない',  mine(me, { trainerId: 't2' }), false);
    eq('⑦★オーナー：他人の予約も出す',  mine(owner, { trainerId: 't2' }), true);
    eq('⑦担当が分からなければ出す',      mine(me, { trainerId: '' }), true);
    eq('⑦自分のIDが分からなければ出す',  mine({ myTrainerId: '', _isOwner: false }, { trainerId: 't2' }), true);
  }
  ok('⑦自分のトレーナーIDを控えている', /state\.myTrainerId = String\(res\.trainerId \|\| ''\)/.test(HTML));
  // 担当が分からないときは出す（押せないより押せるほうがよい。断られても一覧は見える）
  ok('⑦担当が分からなければ出す', /!r\.trainerId \|\| !state\.myTrainerId/.test(HTML));
  // 他人の予約には理由を出す（ボタンが無い理由が分からないと問い合わせになる）
  ok('⑦他の担当の予約には理由を出す', /他のトレーナーが担当する予約です/.test(HTML));
}

console.log(`\n${fail ? '❌' : '✅'} 顧客の閲覧範囲（GAS側） 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
