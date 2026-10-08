// 書き込みの入口が「どの会員か」を伝えられるかを固定する。
//   実行: node worker/test/entry-customer-id.test.js
//
// ★なぜ要るのか（2026-10-08・実際に穴が1つ見つかった）
//   二重書きは `edgeAfterWrite` が会員を特定できて初めて働く。特定の順序は3段：
//     ① res.customerId（書き込みの結果が返す）
//     ② params.customerId（呼び出しが渡す）
//     ③ getCustomerByLine(lineUserId)（**呼んだ人**から引く）
//
//   ③は「会員本人が操作した」ときだけ正しい。
//   **トレーナーが代わりに操作すると、③はトレーナーを指すので会員が特定できない。**
//   取消と変更がまさにそれで、`{ success: true, penalty: !free }` しか返していなかった。
//   → トレーナーが取り消すと**D1の引当が更新されないまま残る。**
//     翌朝の照合で食い違いとして出るだけで、その間ずっと古い残数がD1に入る。
//
//   この検査は「トレーナーも操作できる入口」が①か②で会員を伝えることを固定する。

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const LB = readFileSync(join(ROOT, 'gas/LineBooking.js'), 'utf8');
const PE = readFileSync(join(ROOT, 'gas/PushToEdge.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  cond ? pass++ : (fail++, console.log(`❌ ${name}${extra ? '\n   ' + extra : ''}`));
}
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  g === w ? pass++ : (fail++, console.log(`❌ ${name}\n   got : ${g}\n   want: ${w}`));
}

//   関数の本体を切り出す（function 行から、次の行頭 } まで）
function body(name) {
  const i = LB.indexOf(`function ${name}(`);
  if (i < 0) return '';
  const rest = LB.slice(i);
  const j = rest.indexOf('\n}');
  return j < 0 ? rest : rest.slice(0, j);
}

console.log('=== 1. 会員の特定の順序（3段）===');
ok('①res.customerId を最初に見る', /var cid = String\(res\.customerId \|\| params\.customerId \|\| ''\)/.test(PE));
ok('①最後は呼んだ人から引く', /var m = getCustomerByLine\(lineUserId\)/.test(PE));
ok('①★特定できなければ何もしない（黙って終わる）',
  /会員が特定できず写しを直せません/.test(PE),
  'ここで止まると二重書きも積まれない＝D1が古いまま残る');

console.log('=== 2. ★トレーナーも操作できる入口は、会員IDを返すか渡すこと ===');
//   「トレーナーも操作できる」＝ getTrainerByLine で操作者を見ている入口
const trainerOperable = ['cancelReservationLine', 'changeReservationLine'];
for (const fn of trainerOperable) {
  const b = body(fn);
  ok(`②${fn} はトレーナーも操作できる`,
    /getTrainerByLine\(lineUserId\)/.test(b),
    'この前提が変わったら、この検査の対象も見直す');
  ok(`②★${fn} が成功時に customerId を返す`,
    /success: true[\s\S]{0,300}?customerId: String\(r\[2\] \|\| ''\)/.test(b),
    '返さないと、トレーナーが操作したときにD1が更新されない');
}

console.log('=== 3. 呼び出しが会員を渡している入口 ===');
//   res で返さなくても、params.customerId があれば②で特定できる
for (const [action, fn] of [
  ['line_linkUnlinked', 'linkUnlinkedReservation'],
  ['line_addTicketRefill', 'addTicketRefill'],
  ['line_makeReservationLineProxy', 'makeReservationLineProxy'],
  ['line_makeBatchReservationProxy', 'makeBatchReservationLineProxy'],
]) {
  const re = new RegExp(`case '${action}'[\\s\\S]{0,400}?params\\.customerId`);
  ok(`③${action} は params.customerId を渡す`, re.test(LB),
     'res で返さない入口は、呼び出しで渡さないと特定できない');
}

console.log('=== 3-b. 固定枠の入口（Codex関門②で漏れを指摘された2つ）===');
//   ★「16キーを全部分類した」と言うなら、本当に全部見ていること。
//     私は2つ（固定枠の追加・削除）を分類から落としていた。
ok('③-b 固定枠の追加は params.customerId を渡す',
  /case 'line_addRecurringPatternByTrainer'[\s\S]{0,300}?params\.customerId/.test(LB));
ok('③-b ★固定枠の削除は res で会員IDを返す',
  /function deleteRecurringPattern\([\s\S]{0,1200}?return \{ success: true, customerId: cid \};/.test(LB),
  '呼び出しは customerId を渡さない。返さないと操作したトレーナーを会員と見てしまう');
ok('③-b 削除は引当を変えないと明記',
  /固定枠の削除そのものは引当を変えない/.test(LB),
  '何のために返すのかを書いておく（将来「不要では」と消されないため）');
//   ★許可リストの16キーを全部、この検査で触っていること
{
  const m = PE.match(/var EDGE_AFTER_WRITE = \{([\s\S]*?)\};/);
  const keys = m ? (m[1].match(/([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g) || []).map((x) => x.replace(/\s*:$/, '')) : [];
  eq('③-b 許可リストは16キー', keys.length, 16);
  //   この検査ファイルが各キーに触れているか（名前の一部で照合）
  const notCovered = keys.filter((k) => {
    const fn = k.replace(/^line_/, '');
    return !(new RegExp(fn, 'i').test(readFileSync(join(ROOT, 'worker/test/entry-customer-id.test.js'), 'utf8')));
  });
  eq('③-b ★全キーをこの検査で触っている', notCovered, []);
}

console.log('=== 4. 会員が居ない入口（特定できないのが正しい）===');
//   未登録客の枠確保・ブロック枠は会員が無い。引当も要らない（consumes_quota=0）。
//   ここで会員が特定されないのは**正常**。だから res も params も customerId を持たない。
//   ★deleteAdminSlot も同じ（未登録客の枠・ブロック枠を消す。会員が居ない）。
//     検査が「全キーを触っていない」と教えてくれて初めて気づいた（2026-10-08）。
for (const fn of ['makeAdminBooking', 'makeBlock', 'deleteAdminSlot']) {
  const b = body(fn);
  ok(`④${fn} は会員IDを返さない（会員が居ないので正しい）`,
    !/customerId:/.test(b));
}
ok('④その2つは許可リストに載っている（写しの更新は走る）',
  /line_makeAdminBooking: 1/.test(PE) && /line_makeBlock: 1/.test(PE),
  'カレンダーが変わるので空き枠の作り直しは必要。引当だけが要らない');

console.log('=== 4-b. 自分で会員IDを作る入口 ===');
//   会員登録（selfRegister）は、そこで会員IDが決まる。だから res で返すのが唯一の道。
{
  const b = body('selfRegister');
  ok('④-b selfRegister は res で会員IDを返す',
    /success: true, verified: true, customerId: customerId/.test(b),
    '登録した本人のLINEから引くこともできるが、作った直後は res が確実');
}

console.log('=== 5. 会員本人しか操作しない入口（③で足りる）===');
//   本人のLINEから呼ばれるので、getCustomerByLine で正しく引ける
for (const fn of ['makeRecurringReservationLine', 'makeBatchReservationLine',
                  'makeTransferReservationLine', 'makeReservationLine']) {
  const b = body(fn);
  ok(`⑤${fn} は本人のLINEから会員を引く`,
    /getCustomerByLine\(lineUserId\)/.test(b),
    '本人操作だけなら③で足りる。トレーナーも操作できるようになったら②の対象へ移す');
  ok(`⑤${fn} はトレーナーを操作者として見ていない`,
    !/getTrainerByLine\(lineUserId\)/.test(b),
    'トレーナーも操作できるなら、customerId を返す必要がある');
}

console.log('=== 6. ★押し出しの元栓が切れたら気づけること ===');
//   ★EDGE_PUSH_ON が '1' でなければ、写しの押し出しも二重書きも**丸ごと動かない。**
//     既定は停止（安全側）なので、切れたことに誰も気づかない経路があった（2026-10-08 に発見）。
//     切れると D1 は止まった時点の値で固まる。読み取りをD1へ向けたあとなら
//     **顧客に古い残数を見せ続ける。**
ok('⑥元栓の判定は1箇所', /function _edgeEnabled\(\) \{ return _edgeProp\('EDGE_PUSH_ON'\) === '1'; \}/.test(PE));
//   ★条件式と出力を**ひと続きで**見る。別々に見ると、条件を if (false) に
//     差し替えても両方の文字列が残って通ってしまう（実際に通った）。
ok('⑥★日次点検で元栓を見る',
  /if \(_lbProp\('EDGE_PUSH_ON'\) !== '1'\) \{[\s\S]{0,200}?add\('edge_push_off'/.test(LB),
  '照合は「計算とD1が合うか」しか見ない。元栓そのものを見る必要がある');
ok('⑥★いちばん高い重大度で出す',
  /add\('edge_push_off', 'D1', 'high'/.test(LB));
ok('⑥何が止まるかを書いている',
  /写しの更新と二重書きが\*\*丸ごと止まっています。\*\*/.test(LB));
ok('⑥直し方を書いている', /Script Properties で EDGE_PUSH_ON を 1 にしてください/.test(LB));

console.log('=== 6-b. ★定期処理（トリガー）が揃っているか見ること ===');
//   ★いままで塞いだ見張りは、どれも「定期処理が動いている」ことが前提。
//     トリガーが消えると、その処理が黙って止まる。トリガーそのものを数えるのが確実。
ok('⑥-b トリガーを数える', /ScriptApp\.getProjectTriggers\(\)/.test(LB));
ok('⑥-b ★無いものを high で出す',
  /add\('trigger_missing', '定期処理', 'high'/.test(LB)
  && /_missing\.length\) \{/.test(LB));
ok('⑥-b 直し方を書いている', /setupTriggers を実行し直すと戻ります/.test(LB));
//   ★止まったら困るものを漏らさない。止まったときに何が起きるかも書く
for (const h of ['dailyHealthCheck', 'lbNudgeDaily', 'sendLineReminders',
                 'pushToEdgeLight', 'pushToEdgeFullSync', 'dailySync',
                 'edgeJobPoll', 'syncContractStatus']) {
  ok(`⑥-b ${h} を必須に入れている`, new RegExp(`\\['${h}',`).test(LB));
}
ok('⑥-b ★この点検そのものも必須に入れている（自分が止まることも見る）',
  /\['dailyHealthCheck',\s*'この点検そのもの。止まるとすべての見張りが黙る'\]/.test(LB));
ok('⑥-b ★上限に近いと出す（新しいトリガーが黙って作れなくなる）',
  /_trs\.length >= 18\) \{[\s\S]{0,200}?trigger_near_limit/.test(LB),
  '上限に当たると二重書きの速い道などが黙って止まる');
ok('⑥-b ★二重登録も出す（同じ人に2通届く）',
  /trigger_dup/.test(LB) && /_have\[_k\] > 1/.test(LB));
ok('⑥-b 点検そのものが失敗しても気づける', /trigger_check_fail/.test(LB));

console.log('=== 7. 日次点検の版の印 ===');
ok('⑦版の印がある', /var LB_HEALTH_BUILD = '[^']+';/.test(LB),
  '直したのに結果が変わらないとき、反映されていないのか本当に変わらないのかを見分ける');

console.log('');
console.log(`${fail ? '❌' : '✅'} 入口が会員を伝えられるか 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
