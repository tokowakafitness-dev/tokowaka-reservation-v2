// 二重書きの待ち行列を**実際に動かして**確かめる。
//   実行: node worker/test/dualwrite-queue.test.js
//
// ★なぜ必要か（2026-10-08・Codex関門②）
//   文字列の検査（dualwrite-entries.test.js）では、次のような**動き**を確かめられない。
//     ・処理中（取り置き中）の会員に新しい予約が入っても、取り置きが残るか
//     ・期限が切れた取り置きは取り直せるか
//     ・処理中に更新されたら、外さずに取り置きだけ外すか
//     ・容量を超えたら古い順に落ちるか
//   実際に、取り置きを足したのに積むときに消す実装を書いてしまった。
//   **文字列では「書いてある」ことしか見えない。動かして確かめる。**
//
//   GASの道具（PropertiesService / LockService / Logger）を身代わりに差し替え、
//   gas/DualWrite.js をそのまま読み込んで動かす。

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
//   ★二重書きは gas/PushToEdge.js の中の節（DUALWRITE:BEGIN〜END）。
//     独立ファイルにすると、GASの反映の許可一覧（ワークフロー）と一致せず
//     反映が全体ごと止まる（2026-10-08 に実際に止まった）。
//     ここでは節だけを切り出して動かす（PushToEdge.js 全体を動かすには
//     シートやカレンダーの身代わりが大量に必要になる）。
const SRC = (() => {
  const all = readFileSync(join(ROOT, 'gas/PushToEdge.js'), 'utf8');
  const a = all.indexOf('// ===== DUALWRITE:BEGIN =====');
  const b = all.indexOf('// ===== DUALWRITE:END =====');
  if (a < 0 || b < 0) throw new Error('二重書きの節が見つかりません（印を変えたらここも直す）');
  return all.slice(a, b);
})();

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  cond ? pass++ : (fail++, console.log(`❌ ${name}${extra ? '\n   ' + extra : ''}`));
}
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  g === w ? pass++ : (fail++, console.log(`❌ ${name}\n   got : ${g}\n   want: ${w}`));
}

// ---- GASの道具の身代わり ----
function makeGas(opts = {}) {
  const props = new Map();
  let lockHeld = false;
  let lockFails = opts.lockFails || 0;
  const logs = [];
  const g = {
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => { props.set(k, String(v)); },
      }),
    },
    LockService: {
      getScriptLock: () => ({
        tryLock() {
          if (lockFails > 0) { lockFails--; return false; }
          if (lockHeld) return false;     // 既に誰かが握っている
          lockHeld = true; return true;
        },
        releaseLock() { lockHeld = false; },
      }),
    },
    Logger: { log: (m) => logs.push(String(m)) },
    SETTINGS: { TIMEZONE: 'Asia/Tokyo' },
    Utilities: { formatDate: () => '10/08 12:00' },
    // 二重書きの本体は使わないが、読み込み時に参照されないよう用意しておく
    _edgeEnabled: () => true,
    _edgeProp: () => '',
    _edgePost: () => ({ success: true }),
    _edgeCalcReservations: () => [],
    _lbMonthKeyJst: () => '2026-10',
    _lbMemberOpeningWithFloor: () => ({ recordsFrom: '2026-09' }),
    _edgeQuotaVerify: () => ({ done: true, checked: 0, differ: 0, skipped: 0 }),
    UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200, getContentText: () => '{"ok":true}' }) },
  };
  //   gas/DualWrite.js をそのまま評価し、中の関数を取り出す
  const names = ['LB_DW', 'lbDwEnqueue', '_lbDwClaim', '_lbDwDone', '_lbDwRelease',
                 '_lbDwReleaseMany', '_lbDwReadQueue', '_lbDwWriteQueue', 'lbDualWriteStatusText'];
  const keys = Object.keys(g);
  const fn = new Function(...keys, `${SRC}\n;return {${names.join(',')}};`);
  const api = fn(...keys.map((k) => g[k]));
  return { ...api, props, logs, raw: () => props.get(api.LB_DW.QUEUE_PROP) };
}

const NOW = () => Date.now();

console.log('=== 1. 積む・取り置く・外す ===');
{
  const t = makeGas();
  ok('①積める', t.lbDwEnqueue('C1') === true);
  const c1 = t._lbDwClaim(5);
  eq('①1名取り置けた', c1.items.map((x) => x.customerId), ['C1']);
  eq('①待っている人数も返る', c1.total, 1);
  eq('①version は1', c1.items[0].version, 1);
  eq('①外せる', t._lbDwDone('C1', 1), 'DONE');
  eq('①空になった', Object.keys(t._lbDwReadQueue()).length, 0);
}

console.log('=== 2. ★取り置き中は他の実行が取れない ===');
{
  const t = makeGas();
  t.lbDwEnqueue('C1');
  const a = t._lbDwClaim(5);
  eq('②Aが取り置いた', a.items.length, 1);
  const b = t._lbDwClaim(5);
  eq('②★Bは取れない（同じ会員を二重に処理しない）', b.items.length, 0);
  eq('②★ただし待っている人数は正直に返す（0と言わない）', b.total, 1);
}

console.log('=== 3. ★処理中に予約が入っても取り置きは消えない（今回の最重要）===');
{
  const t = makeGas();
  t.lbDwEnqueue('C1');
  const a = t._lbDwClaim(5);                    // Aが version 1 を取り置く
  t.lbDwEnqueue('C1');                          // 処理中に新しい予約
  const q = t._lbDwReadQueue();
  eq('③version が上がった', q.C1.version, 2);
  ok('③★取り置きが残っている', Number(q.C1.leaseUntil || 0) > NOW(),
     '消えると、Bが version 2 を取り、AとBが並んで書いて古いAが最後に残り得る');
  const b = t._lbDwClaim(5);
  eq('③★Bはまだ取れない', b.items.length, 0);

  //   Aが終わる。version が変わっているので外さず、取り置きだけ外す
  eq('③Aの完了は REQUEUED', t._lbDwDone('C1', a.items[0].version), 'REQUEUED');
  const q2 = t._lbDwReadQueue();
  eq('③会員は残っている', Object.keys(q2), ['C1']);
  ok('③★取り置きが外れた（次の実行がすぐ取れる）', q2.C1.leaseUntil === undefined);
  const b2 = t._lbDwClaim(5);
  eq('③Bが version 2 を取れる', b2.items.map((x) => x.version), [2]);
}

console.log('=== 4. 期限が切れた取り置きは取り直せる ===');
{
  const t = makeGas();
  t.lbDwEnqueue('C1');
  t._lbDwClaim(5);
  //   期限を過去にする＝落ちた実行のもの
  const q = t._lbDwReadQueue();
  q.C1.leaseUntil = NOW() - 1000;
  t._lbDwWriteQueue(q);
  const again = t._lbDwClaim(5);
  eq('④取り直せる', again.items.length, 1);
  ok('④期限は実行の上限（6分）より長い', t.LB_DW.LEASE_MS > 6 * 60 * 1000,
     `LEASE_MS=${t.LB_DW.LEASE_MS}`);
}

console.log('=== 5. 失敗したら取り置きだけ外す（会員は残す）===');
{
  const t = makeGas();
  t.lbDwEnqueue('C1'); t.lbDwEnqueue('C2');
  t._lbDwClaim(5);
  eq('⑤まとめて外せる', t._lbDwReleaseMany(['C1', 'C2']), 'RELEASED');
  const q = t._lbDwReadQueue();
  eq('⑤2名とも残っている', Object.keys(q).sort(), ['C1', 'C2']);
  ok('⑤取り置きは外れた', q.C1.leaseUntil === undefined && q.C2.leaseUntil === undefined);
  eq('⑤すぐ取り直せる', t._lbDwClaim(5).items.length, 2);
}

console.log('=== 6. ★壊れた待ち行列を空で上書きしない ===');
{
  const t = makeGas();
  t.lbDwEnqueue('C1');
  t.props.set(t.LB_DW.QUEUE_PROP, '{これは壊れたJSON');
  eq('⑥壊れていたら null', t._lbDwReadQueue(), null);
  ok('⑥積むのを中止する', t.lbDwEnqueue('C2') === false);
  eq('⑥★中身を上書きしていない', t.props.get(t.LB_DW.QUEUE_PROP), '{これは壊れたJSON');
  ok('⑥溢れとして記録する', Number(t.props.get(t.LB_DW.OVERFLOW_PROP) || 0) > 0);
  eq('⑥取り置きもしない', t._lbDwClaim(5), null);
  eq('⑥外すのも中止する', t._lbDwDone('C1', 1), 'BROKEN');
}

console.log('=== 7. ★容量と人数の上限 ===');
{
  const t = makeGas();
  for (let i = 0; i < t.LB_DW.MAX_QUEUE + 20; i++) t.lbDwEnqueue('C2026' + (10000000 + i));
  const q = t._lbDwReadQueue();
  ok('⑦人数の上限を超えない', Object.keys(q).length <= t.LB_DW.MAX_QUEUE,
     `入っている人数=${Object.keys(q).length} / 上限=${t.LB_DW.MAX_QUEUE}`);
  ok('⑦★いちばん新しいものは残る（いま積んだぶんを捨てない）',
     !!q['C2026' + (10000000 + t.LB_DW.MAX_QUEUE + 19)]);
  ok('⑦捨てた件数を記録している', Number(t.props.get(t.LB_DW.OVERFLOW_PROP) || 0) > 0);

  //   ★Script Properties は1つの値が9KBまで。全部が取り置き中でも収まること
  const q2 = t._lbDwReadQueue();
  for (const k of Object.keys(q2)) q2[k].leaseUntil = NOW() + 600000;
  const bytes = Buffer.byteLength(JSON.stringify(q2), 'utf8');
  ok('⑦★全部取り置き中でも9KBに収まる', bytes < 9216, `${bytes} bytes`);
}

console.log('=== 7-b. ★容量の境目が実際に動く場面（Codex関門②の3回目）===');
{
  //   取り置きも容量削りも「古い順」。素朴に削ると**いま取り置いた会員が最初に捨てられ**、
  //   呼ぶ側はそれを処理し続ける（終わったときには待ち行列に居ない＝約束が破れる）。
  //   長い会員IDで容量を超えさせ、取り置きが守られることを確かめる。
  const t = makeGas();
  const q = {};
  const long = (i) => 'C' + String(i).padStart(4, '0') + 'X'.repeat(70);   // 1件あたり長い
  for (let i = 0; i < 80; i++) q[long(i)] = { version: 1, queuedAt: 1000 + i };
  t.props.set(t.LB_DW.QUEUE_PROP, JSON.stringify(q));
  const bytes0 = Buffer.byteLength(JSON.stringify(q), 'utf8');
  ok('⑦-b まず容量を超えている状態を作れた', bytes0 > 8500, `${bytes0} bytes`);

  const c = t._lbDwClaim(5);
  const after = t._lbDwReadQueue();
  const afterBytes = Buffer.byteLength(JSON.stringify(after), 'utf8');
  ok('⑦-b 書いたあとは容量に収まっている', afterBytes <= 8500, `${afterBytes} bytes`);
  ok('⑦-b 何人かは捨てられた', Object.keys(after).length < 80);

  //   ★ここが本題：処理対象として返した会員が、全員まだ待ち行列に居ること
  const missing = c.items.filter((x) => !after[x.customerId]).map((x) => x.customerId);
  eq('⑦-b ★処理対象の会員は全員まだ待ち行列に居る', missing, []);
  ok('⑦-b 処理対象は取り置かれている',
     c.items.every((x) => Number(after[x.customerId].leaseUntil || 0) > NOW()));
  ok('⑦-b 残り人数は実際の人数', c.total === Object.keys(after).length,
     `total=${c.total} / 実際=${Object.keys(after).length}`);
  ok('⑦-b 捨てた件数を記録している', Number(t.props.get(t.LB_DW.OVERFLOW_PROP) || 0) > 0);
  //   ★守る仕組みが効いていること。守らないと、取り置いた5名が最初に捨てられ、
  //     処理対象が0名になる（＝容量が詰まっているあいだ、二重書きが1名も進まない）。
  //     上の「処理対象は全員待ち行列に居る」は、捨てられたぶんを外す処理で保たれるので、
  //     守る仕組みを外しても通ってしまう。**だから人数で別に確かめる。**
  eq('⑦-b ★取り置いた5名が守られる（処理が止まらない）', c.items.length, 5);
}

console.log('=== 7-c. ★守っても収まらないときの約束（捨てたIDを返す）===');
{
  //   守る仕組みが効いているあいだ、捨てられたぶんを外す処理は出番が無い（二重の備え）。
  //   だから出番が来る形＝**守る会員だけで容量を超える**場面で、直接確かめる。
  const t = makeGas();
  const q = {};
  const huge = (i) => 'C' + String(i).padStart(3, '0') + 'Y'.repeat(900);   // 1件で900バイト超
  const ids = [];
  for (let i = 0; i < 12; i++) { const k = huge(i); q[k] = { version: 1, queuedAt: 1000 + i }; ids.push(k); }
  const before = Buffer.byteLength(JSON.stringify(q), 'utf8');
  ok('⑦-c 守る会員だけで容量を超える状態', before > 8500, `${before} bytes`);

  const dropped = t._lbDwWriteQueue(q, ids);   // 全員を守る指定
  ok('⑦-c ★守れなかったぶんは捨てたIDとして返す', dropped.length > 0, `捨てた=${dropped.length}`);
  const after = Buffer.byteLength(JSON.stringify(t._lbDwReadQueue()), 'utf8');
  ok('⑦-c 書いたあとは容量に収まっている', after <= 8500, `${after} bytes`);
  ok('⑦-c 捨てたIDは待ち行列に居ない',
     dropped.every((k) => !t._lbDwReadQueue()[k]));
  //   ★1件だけでも超えるなら、その1件も捨てる（keys.length > 1 だと最後の1件を守れない）
  const t2 = makeGas();
  const one = {}; one['C' + 'Z'.repeat(9000)] = { version: 1, queuedAt: 1 };
  const d2 = t2._lbDwWriteQueue(one, []);
  eq('⑦-c ★1件だけで超える場合もその1件を捨てる', d2.length, 1);
  eq('⑦-c 待ち行列は空になる', Object.keys(t2._lbDwReadQueue()).length, 0);
}

console.log('=== 7-d. ★文字数ではなくバイト数で測る（Codex関門②の4回目）===');
{
  //   日本語など1文字が3バイトになる値が入ったとき、文字数で測ると9KBを超える。
  //   いまの顧客IDは 'C'＋数字14桁なので一致するが、将来のために固定する。
  const t = makeGas();
  const q = {};
  //   1件あたり 'あ' 300文字＝900バイト。10件で9,000バイト（文字数なら3,000）
  for (let i = 0; i < 10; i++) q['C' + String(i) + 'あ'.repeat(300)] = { version: 1, queuedAt: i };
  const chars = JSON.stringify(q).length;
  const bytes = Buffer.byteLength(JSON.stringify(q), 'utf8');
  ok('⑦-d 文字数では収まるがバイト数では超える状態', chars <= 8500 && bytes > 8500,
     `文字数=${chars} / バイト数=${bytes}`);
  const dropped = t._lbDwWriteQueue(q, []);
  ok('⑦-d ★バイト数で見て捨てている', dropped.length > 0, `捨てた=${dropped.length}`);
  const after = Buffer.byteLength(JSON.stringify(t._lbDwReadQueue()), 'utf8');
  ok('⑦-d 書いたあとはバイト数で収まっている', after <= 8500, `${after} bytes`);
}

console.log('=== 8. ロックが取れないときは積めたと言わない ===');
{
  const t = makeGas({ lockFails: 1 });
  ok('⑧積めなかったことを返す', t.lbDwEnqueue('C1') === false);
  ok('⑧記録している', Number(t.props.get(t.LB_DW.OVERFLOW_PROP) || 0) > 0);
}

console.log('=== 9. 空の会員IDは積まない ===');
{
  const t = makeGas();
  ok('⑨空は積まない', t.lbDwEnqueue('') === false && t.lbDwEnqueue(null) === false);
  eq('⑨待ち行列は空のまま', Object.keys(t._lbDwReadQueue()).length, 0);
}

console.log('');
console.log(`${fail ? '❌' : '✅'} 二重書きの待ち行列（動かして確認） 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
