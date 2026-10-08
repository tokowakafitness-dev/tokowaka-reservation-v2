// 二重書きの入口が揃っているかを機械で固定する。
//   実行: node worker/test/dualwrite-entries.test.js
//
// ★なぜ必要か（2026-10-08・Codex関門①）
//   私は「16の入口に配線済み」と理解していたが、`edgeAfterWrite` の呼び出しは
//   中央出口の1箇所だけで、16はその出口が通す action の許可リストの数だった。
//   **中央出口を通らずに予約台帳を書く経路が4つあった。**
//
//   許可リストが3箇所にあって1つだけ直し忘れ、作業依頼が黙って止まった事故
//   （2026-10-07）と同じ形。**「呼び出し箇所を数える」検査では意味が無い。**
//   数えるべきものを5つに分けて固定する。

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const LB = readFileSync(join(ROOT, 'gas/LineBooking.js'), 'utf8');
const PE = readFileSync(join(ROOT, 'gas/PushToEdge.js'), 'utf8');
//   二重書きは PushToEdge.js の中の節（独立ファイルにすると反映が止まる・2026-10-08）
const DW = (() => {
  const a = PE.indexOf('// ===== DUALWRITE:BEGIN =====');
  const b = PE.indexOf('// ===== DUALWRITE:END =====');
  if (a < 0 || b < 0) throw new Error('二重書きの節が見つかりません');
  return PE.slice(a, b);
})();

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  cond ? pass++ : (fail++, console.log(`❌ ${name}${extra ? '\n   ' + extra : ''}`));
}
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  g === w ? pass++ : (fail++, console.log(`❌ ${name}\n   got : ${g}\n   want: ${w}`));
}

// ---------- 許可リストと中央出口の case を取り出す ----------
const afterWriteKeys = (() => {
  const m = PE.match(/var EDGE_AFTER_WRITE = \{([\s\S]*?)\};/);
  if (!m) return null;
  return (m[1].match(/([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g) || []).map((x) => x.replace(/\s*:$/, ''));
})();

const dispatchCases = (() => {
  const i = LB.indexOf('function _lbDispatch');
  if (i < 0) return null;
  //   次の関数定義までを _lbDispatch の本体とみなす
  const rest = LB.slice(i + 10);
  const j = rest.search(/\nfunction /);
  const body = j < 0 ? rest : rest.slice(0, j);
  return (body.match(/case\s+'([a-zA-Z_][a-zA-Z0-9_]*)'/g) || [])
    .map((x) => x.replace(/case\s+'/, '').replace(/'$/, ''));
})();

console.log('=== 1. 許可リストと中央出口の case が食い違っていないこと ===');
{
  ok('①許可リストが読める', Array.isArray(afterWriteKeys) && afterWriteKeys.length > 0);
  ok('①中央出口の case が読める', Array.isArray(dispatchCases) && dispatchCases.length > 0);
  //   ★許可リストにあるのに中央出口に無い＝綴り違い。**黙って写しが直らない。**
  const missing = (afterWriteKeys || []).filter((k) => !(dispatchCases || []).includes(k));
  eq('①★許可リストの全部が中央出口にある', missing, []);
}

console.log('=== 2. 予約台帳を書き換える操作が、許可リストに載っていること ===');
{
  //   ここに挙げるのは「台帳・契約・紐付けを書き換える」操作。
  //   読み取りだけの操作（getTrainers 等）は載っていなくてよい。
  //   ★新しい書き込みの case を足したら、この一覧にも足す。**足し忘れると残数が古いまま出る。**
  const writes = [
    'line_makeReservationLine', 'line_makeReservationLineProxy',
    'line_makeRecurringReservation', 'line_makeBatchReservation',
    'line_makeBatchReservationProxy', 'line_makeTransferReservation',
    'line_cancelReservation', 'line_changeReservation',
    'line_makeAdminBooking', 'line_makeBlock', 'line_deleteAdminSlot',
    'line_addTicketRefill', 'line_linkUnlinked', 'line_selfRegister',
    'line_addRecurringPatternByTrainer', 'line_deleteRecurringPattern',
  ];
  const notAllowed = writes.filter((k) => !(afterWriteKeys || []).includes(k));
  eq('②★書き換える操作は全部が許可リストにある', notAllowed, []);
  //   逆に、許可リストに載っているのにこの一覧に無いもの＝一覧の更新漏れ
  const notListed = (afterWriteKeys || []).filter((k) => !writes.includes(k));
  eq('②許可リスト側に余りが無い（一覧の更新漏れ）', notListed, []);
}

console.log('=== 3. 中央出口を通らない書き込み経路が、待ち行列へ積んでいること ===');
{
  //   ★Codex関門①で判明した4つ。どれも台帳に予約を書くのに中央出口を通らない。
  ok('③-A doPost が写しを直す（旧経路だが公開Web Appで到達可能）',
    /edgeAfterWrite\('line_' \+ action, body, _res, lineUserId\)/.test(LB),
    'doPost は makeReservationLine を直接呼ぶ。通さないとD1に伝わらない');
  ok('③-B liffApi が写しを直す',
    /edgeAfterWrite\('line_' \+ action, body, res, lineUserId\)/.test(LB));
  ok('③-C カレンダー取込（dailySync）が取り込んだ会員を積む',
    /appendRows\[_dw\]\[2\]/.test(LB) && /lbDwEnqueue\(_dwCid\)/.test(LB),
    '6時間ごとに予約を台帳へ足す。積まないと翌日の完全同期まで引当に入らない');
  ok('③-D 固定枠の自動予約が、予約できた会員だけ積む',
    /if \(agg\.booked\.length\) \{[\s\S]{0,200}?lbDwEnqueue\(c2\)/.test(LB),
    'order には予約できなかった会員も入る。全員積むと無駄な作り直しが走る');
  ok('③中央出口そのものも積む', /lbDwEnqueue\(cid\)/.test(PE));
}

console.log('=== 4. 予約を作る中核を直接呼んでいる場所が増えていないこと ===');
{
  //   _lbReserveCore を直接呼ぶ場所が増えたら、そこも積む必要がある。
  //   数を固定して、増えたら気づけるようにする。
  const calls = (LB.match(/_lbReserveCore\(/g) || []).length;
  ok('④_lbReserveCore を呼ぶ箇所の数が想定どおり', calls <= 12,
     `見つかった数=${calls}。増えたなら、その経路が待ち行列へ積んでいるか確かめる`);
}

console.log('=== 5. 待ち行列の作り（設計の不変条件） ===');
{
  ok('⑤★会員IDの配列ではなく version 付き',
    /version:\s*\(cur && Number\(cur\.version\) \|\| 0\) \+ 1/.test(DW),
    '配列だと、処理中に入った予約が「既に居る」ので積まれず、成功で外されて永遠に消える');
  ok('⑤★外すときに version を照合する',
    /if \(Number\(cur\.version\) !== Number\(version\)\) \{/.test(DW)
    && /return 'REQUEUED';/.test(DW));
  ok('⑤★読む→直す→書くをロックで囲む',
    /_lbDwLocked\(function \(\) \{[\s\S]{0,400}?_lbDwReadQueue\(\)[\s\S]{0,800}?_lbDwWriteQueue\(q\)/.test(DW),
    '個々の setProperty は原子的だが全体は原子的でない。囲わないと会員IDが失われる');
  ok('⑤★ロックが取れなかったら記録する（黙って落とさない）',
    /ロックが取れず積めませんでした/.test(DW) && /OVERFLOW_PROP/.test(DW));
  ok('⑤★溢れたら件数を記録する', /OVERFLOW_PROP,\s*String\(over\)/.test(DW));
  ok('⑤1回で処理する人数に上限がある（6分の実行制限）',
    /MAX_PER_RUN:\s*\d+/.test(DW));

  ok('⑤★新しいトリガーを作らない（上限20本）',
    !/ScriptApp\.newTrigger/.test(DW),
    'コード上のトリガーは21ハンドラ分ある。相乗りで済ませる');
  ok('⑤速い道に相乗りしている（書き込みの1秒後）',
    /function _lbCalSyncAfterWrite\(\)[\s\S]{0,600}?lbDualWriteDrain\(\)/.test(PE));
  ok('⑤心拍に相乗りしている（15分ごと）',
    /function pushToEdgeLight\(\)[\s\S]{0,900}?lbDualWriteDrain\(\)/.test(PE));
}

console.log('=== 6. 計算入力の送り方（取り違えると予約が消える） ===');
{
  //   台帳は処理本体で1回だけ読み、読めなければ何も送らずに戻す（⑪でも固定）
  ok('⑥★読めなかった（null）ら送らない',
    /function _edgePushCalcResvFor\(customerId, all\) \{\s*\n\s*if \(all == null\) return false;/.test(DW),
    '`(… || []).filter()` と書くと、読めなかった null が空配列に化けて全部消える');
  ok('⑥0件でも送る（最後の1件の取消が伝わる）',
    /mine が0件でも送る/.test(DW));
  ok('⑥会員ぶんの入れ替えとして送る',
    /scope: 'customer'/.test(DW) && /customerId: String\(customerId\)/.test(DW));
  ok('⑥★計算入力を先に入れ替え、そのあと枠を作り直す',
    /okResv = _edgePushCalcResvFor\(cid, all\)[\s\S]{0,400}?if \(okResv\)[\s\S]{0,200}?_edgeQuotaBuildOne\(cid, all\)/.test(DW),
    '逆にすると古い予約で引当を作る');
  ok('⑥両方成功しなければ待ち行列から外さない',
    /if \(okResv && okQuota\)/.test(DW));
}

console.log('=== 7. 枠を作り直す範囲 ===');
{
  ok('⑦記録開始月から作る', /op\.recordsFrom/.test(DW));
  ok('⑦★記録開始月が分からなければ作り直さない',
    /記録開始月が分からないので枠は作り直しません/.test(DW),
    '範囲が決まらないのに書くほうが危険');
  ok('⑦★予約が先にあればそこまで広げる',
    /if \(maxMk && maxMk > to\) to = maxMk;/.test(DW),
    '当月+2と決め打つと、それより先の予約の引当が作れず NO_QUOTA_ROW で止まる');
  ok('⑦問題が記録されていたら成功としない',
    /body\.issues && body\.issues\.length/.test(DW) && /body\.skipped && body\.skipped\.length/.test(DW),
    'Workerは問題があればその会員を書かない。成功扱いにすると外してしまう');
}

console.log('=== 8. 日次の点検（14日待つ代わり） ===');
{
  ok('⑧日次点検に相乗りしている（新しいトリガーを作らない）',
    /lbDwDailyCheck\(\)/.test(LB) && /'二重書き'/.test(LB));
  ok('⑧点検そのものが失敗しても気づける',
    /dualwrite_check_fail/.test(LB),
    '黙って通ると「問題なし」と出てしまう');
  //   見つけるべきもの。1つでも抜けると、その異常に気づかないまま3-bへ進む
  for (const key of ['dualwrite_queue', 'dualwrite_overflow', 'dualwrite_verify_fail',
                     'dualwrite_verify_partial', 'dualwrite_differ', 'dualwrite_skipped',
                     'dualwrite_over_packs', 'dualwrite_over_months',
                     'dualwrite_coverage', 'dualwrite_invariant', 'dualwrite_orphans']) {
    ok(`⑧${key} を見ている`, new RegExp(`key: '${key}'`).test(DW));
  }
  ok('⑧★食い違いは high（警告で埋もれさせない）',
    /key: 'dualwrite_differ', severity: 'high'/.test(DW));
  ok('⑧照合が失敗したらそこで返す（続けて誤った「問題なし」を出さない）',
    /dualwrite_verify_fail[\s\S]{0,200}?return out;/.test(DW));
}

console.log('=== 9. ★同じ会員を2つの実行が同時に処理しないこと（Codex関門②）===');
{
  //   ただ読むだけだと、こうなる：
  //     Aが version 1 を取り古い内容で書き始める → 新しい予約で version 2
  //     → Bが version 2 を取り新しい内容で書く → Bが先に終わる
  //     → **Aの古い内容が後から上書きし、待ち行列は空になる**
  //   「全削除→全挿入」は同じ入力なら冪等だが、違う世代同士は順序が入れ替わる。
  ok('⑨★取り置き（claim）してから処理する',
    /function _lbDwClaim\(limit\)/.test(DW) && !/function _lbDwPeek/.test(DW),
    '読むだけ（peek）では、同じ会員を2つの実行が同時に処理できる');
  ok('⑨★取り置きはロックの中で行う',
    /function _lbDwClaim\(limit\) \{\s*\n\s*return _lbDwLocked\(/.test(DW));
  ok('⑨期限内の取り置きは飛ばす',
    /if \(lease > now\) continue;/.test(DW));
  ok('⑨★期限は実行の上限（6分）＋余裕',
    /LEASE_MS: 10 \* 60 \* 1000/.test(DW),
    'ちょうど6分だと境目が弱い。落ちた実行の通信やロック解放が終わったと言い切れない');
  //   ★今回いちばん重いところ。取り置きを足したのに、積むときに消していた（Codex関門②の2回目）
  ok('⑨★積むときに有効な取り置きを引き継ぐ',
    /if \(cur && Number\(cur\.leaseUntil \|\| 0\) > Date\.now\(\)\) next\.leaseUntil = cur\.leaseUntil;/.test(DW),
    '消すと、処理中の会員を別の実行が取れて、防ごうとした競合がそのまま再発する');
  ok('⑨★取り置きはまとめて外す（1名ずつだとロック待ちで更に時間を使う）',
    /function _lbDwReleaseMany\(customerIds\)/.test(DW)
    && /_lbDwReleaseMany\(rest\);/.test(DW) && /_lbDwReleaseMany\(back\);/.test(DW));
  ok('⑨★全員が処理中のとき「残り0」と報告しない',
    /return \{ done: 0, left: queued, allLeased: queued > 0 \};/.test(DW));
  ok('⑨★既に消えていたら成功に数えず異常として記録する',
    /anomaly\+\+;/.test(DW) && /取り置きが破れています/.test(DW),
    'D1には書けているが、取り置いた世代を安全に終えたとは言えない');
  ok('⑨失敗したら取り置きを外す（6分待たない）',
    /function _lbDwRelease\(customerId\)/.test(DW) && /_lbDwRelease\(cid\);/.test(DW));
  ok('⑨処理中に更新されたら取り置きを外して残す',
    /return 'REQUEUED'/.test(DW) && /delete cur\.leaseUntil;/.test(DW));
  ok('⑨★外せなかった（ロックが取れない）ときは成功に数えない',
    /else \{ failed\+\+;[\s\S]{0,120}?外せませんでした/.test(DW),
    '成功に数えると「終わった」と記録され、追えなくなる');
}

console.log('=== 10. ★待ち行列が壊れたとき（Codex関門②）===');
{
  ok('⑩壊れていたら null を返す（空と区別する）',
    /Logger\.log\('\[dw\] 待ち行列が読めませんでした（中止します）/.test(DW),
    '{} を返すと、次の enqueue がその空を保存し、待っていた会員が全部消える');
  ok('⑩積むのを中止して記録する', /return 'BROKEN'/.test(DW) && /if \(r === 'BROKEN'\)/.test(DW));
  ok('⑩日次点検で気づける', /dualwrite_queue_broken/.test(DW));
  ok('⑩状態表示でも分かる', /待ち行列が壊れています/.test(DW));
  //   ★容量（2026-10-08・Codex関門②で計算した）
  //     Script Properties は1つの値が9KBまで。顧客IDは 'C'+14桁。実測：
  //       200名・全部取り置き中 → 16,601 bytes ★超える
  //        80名・全部取り置き中 →  6,641 bytes
  ok('⑩人数の上限が容量に収まる値',
    /MAX_QUEUE: 80,/.test(DW),
    '200名だと全部取り置き中で16.6KB。Script Properties の上限9KBを超える');
  ok('⑩★書く直前にバイト数も見る',
    /var LIMIT = 8500;/.test(DW) && /_bytes\(json\) > LIMIT/.test(DW),
    '人数だけでは守れない（項目が増える・顧客IDが長くなる）。'
    + '文字数で測ると、日本語など1文字が複数バイトの値が入ったとき足りない');
  ok('⑩容量で捨てたぶんも記録する',
    /待ち行列が容量を超えたので古い/.test(DW) && /OVERFLOW_PROP/.test(DW));
}

console.log('=== 12. ★台帳がヘッダだけ（予約0件）は正常として扱う（Codex関門②）===');
{
  ok('⑫ヘッダだけなら空配列を返す',
    /var last = sh\.getLastRow\(\); if \(last < 2\) return \[\];/.test(PE),
    'null にすると「読めなかった」と同じ扱いになり、二重書きが永遠に進まない');
  ok('⑫シートが無いときは null のまま（送らない）',
    /if \(!sh\) return null;\s*\/\/ シートが無い／読めない＝送らない/.test(PE));
}

console.log('=== 11. ★1回の実行が長くなりすぎないこと（Codex関門②）===');
{
  ok('⑪台帳は1回だけ読む',
    /all = _edgeCalcReservations\(\);/.test(DW)
    && /_edgePushCalcResvFor\(cid, all\)/.test(DW)
    && /_edgeQuotaBuildOne\(cid, all\)/.test(DW),
    '会員ごとに読み直すと5名で10回。読んだ時点が会員ごとにずれる');
  ok('⑪読めなかったら何も送らず戻す',
    /LEDGER_UNREADABLE/.test(DW) && /台帳が読めないので今回は見送ります/.test(DW));
  ok('⑪★人数だけでなく時間でも縛る',
    /BUDGET_MS/.test(DW) && /Date\.now\(\) - t0 > LB_DW\.BUDGET_MS/.test(DW),
    '1名が重いと、人数の上限内でも6分に届く');
  ok('⑪かかった時間を記録する（実機で測れるようにする）',
    /ms: ms/.test(DW) && /Logger\.log\('\[dw\] ' \+ ms \+ 'ms/.test(DW));
  ok('⑪★心拍は押し出しが落ちても動く',
    /try \{ pushToEdgeAll\(false\); \} catch[\s\S]{0,400}?try \{ lbDualWriteDrain\(\); \}/.test(PE),
    '同じ try に入れると、押し出しが落ちると心拍まで届かない');
}

console.log('=== 13. ★反映が入ったかを一目で確かめられること ===');
{
  //   2026-10-08、新しいファイル（DualWrite.js）が許可一覧に無くて反映が止まっていたのに、
  //   出力が前日と同じで区別がつかなかった。版の印が無いと「反映したつもり」に気づけない。
  ok('⑬版の印がある', /var LB_EDGE_BUILD = '[^']+';/.test(PE));
  ok('⑬状態の出力に版の印を載せる', /o\.push\('版の印: ' \+ LB_EDGE_BUILD\);/.test(PE));
  ok('⑬二重書きの状態も同じ窓口で見える', /o\.push\(lbDualWriteStatusText\(\)\);/.test(PE));
  ok('⑬状態が読めなくても窓口ごと落ちない',
    /状態が読めませんでした: /.test(PE),
    '待ち行列が壊れていても、枠の状態を見る窓口そのものは使えなければならない');
}

console.log('=== 14. ★GASのファイルが反映の許可一覧と揃っていること ===');
{
  //   ★2026-10-08 の失敗そのもの。
  //     新しいファイル（DualWrite.js）が許可一覧に無く、反映が「想定外のファイルが
  //     あります」で**全体ごと止まった。** しかも出力が前日と同じで気づけなかった。
  //     許可一覧は「増減させるときは人間のレビューが入る」ための安全装置なので
  //     CEOの権限では直せない。**だからここで、押す前に気づけるようにする。**
  const WF = (() => {
    try { return readFileSync(join(ROOT, '.github/workflows/gas-deploy.yml'), 'utf8'); }
    catch (_) { return ''; }
  })();
  ok('⑭反映のワークフローが読める', !!WF);
  if (WF) {
    const m = WF.match(/const allowed = \[([\s\S]*?)\]\.sort\(\);/);
    ok('⑭許可一覧が読める', !!m);
    const allowed = m ? (m[1].match(/'([^']+)'/g) || []).map((x) => x.replace(/'/g, '')) : [];
    const pushable = (n) => /\.(js|gs|ts|html)$/i.test(n) || n === 'appsscript.json';
    const found = readdirSync(join(ROOT, 'gas')).filter(pushable);
    const extra = found.filter((f) => !allowed.includes(f));
    const missing = allowed.filter((f) => !found.includes(f));
    eq('⑭★許可一覧に無いGASファイルが無い（あると反映が全体ごと止まる）', extra, []);
    eq('⑭★許可一覧にあるのに存在しないファイルが無い（あると本番から関数が消える）', missing, []);
  }
}

console.log('');
console.log(`${fail ? '❌' : '✅'} 二重書きの入口 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
