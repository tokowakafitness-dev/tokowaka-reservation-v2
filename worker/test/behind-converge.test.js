// 遅れている会員が必ず追いつく（設計16の収束経路・2026-10-11）
//
//   ★なぜ要るのか
//     `calcMeta`（契約表の列の並び）が一度でも本当に変わると、**全員の世代が進む**。
//     キューに積むのは「その会員に何か起きたとき」の3箇所だけなので、
//     活動のない会員は正当な変更のあとも**永久に追いつかない**。
//     実測でも、比べられる会員が 40名 → 3名 に落ちていた。
//
//   ★芯：修復は**積むだけ**。作り直しは既存の drain に任せる。
//     自分で作り直すと、入力がまだ届いていない窓で
//     **古い入力に「最新」の印を付ける**（＝顧客の残数が1回多く見える）。
//     関門①でこの穴を作りかけて止められた。
//
//   実行: node worker/test/behind-converge.test.js

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rd = (p) => readFileSync(join(ROOT, p), 'utf8');
const strip = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map((ln) => ln.replace(/\/\/.*$/, '')).join('\n');

const PUSH = rd('gas/PushToEdge.js');
const HEALTH = rd('gas/LineBooking.js');
const QUOTA = rd('worker/src/routes/quota.js');

let pass = 0, fail = 0;
function ok(name, cond, why) {
  if (cond) { pass++; return; }
  fail++;
  console.log(`❌ ${name}`);
  if (why) console.log(`   ${why}`);
}

const ensure = strip(PUSH.slice(PUSH.indexOf('function _lbDwEnsureQueuedInLock(ids) {'),
                                PUSH.indexOf('function lbDwEnqueue(')));
const pull = strip(PUSH.slice(PUSH.indexOf('function lbDwPullBehind() {'),
                              PUSH.indexOf('function lbDwEnsureQueued(')));

// ---------- 1. 積むだけ（作り直さない） ----------
ok('①★修復の経路は作り直しを呼ばない',
   !/quota\/build/.test(pull) && !/_edgeQuotaBuildOne/.test(pull),
   '自分で作り直すと、入力が届いていない窓で古い入力に「最新」の印を付ける');
ok('①積むのは既存の drain に任せる形',
   /_lbDwEnsureQueuedInLock\(ids\)/.test(pull),
   'drain が「台帳を読む → 入力を送る → 正しい範囲で作り直す」を既に行っている');

// ---------- 2. lbDwEnqueue ではなく専用の操作 ----------
ok('②★既存項目の version を触らない',
   !/version:\s*\(cur/.test(ensure) && /if \(!q\[ids\[k\]\]\) missing\.push/.test(ensure),
   '既にいる会員の version を +1 すると、処理中の会員の成功した仕事が捨てられる');
ok('②★既存項目の queuedAt を触らない',
   !/queuedAt = Date\.now\(\);\s*$/m.test(ensure.replace(/q\[missing\[c\]\] = \{ version: 1, queuedAt: Date\.now\(\) \};/g, '')),
   '取り出しは queuedAt の古い順。押し直すと列の後ろへ送られる');
ok('②新規の形は version:1・leaseUntil なし',
   /q\[missing\[c\]\] = \{ version: 1, queuedAt: Date\.now\(\) \};/.test(ensure),
   '取り置きは _lbDwClaim の役目。1から始めれば実データの変更が修復に埋もれない');

// ---------- 3. 容量（人数とバイト数の両方・壊さない） ----------
ok('③★人数は「まだいない人数」で数える',
   /Object\.keys\(q\)\.length \+ missing\.length > room/.test(ensure),
   '2名とも既にいれば増える人数は0');
ok('③★実データ用に枠を残す',
   /var room = LB_DW\.MAX_QUEUE - 10;/.test(ensure));
ok('③★バイト数も書く前に測る',
   /_lbDwBytes\(JSON\.stringify\(probe\)\) > LB_DW_QUEUE_BYTES_LIMIT/.test(ensure),
   '人数の上限だけでは守れない（コード自身がそう書いている）');
ok('③★超えたら足さない（削って収めない）',
   /return \{ status: 'CAPACITY'/.test(ensure) && !/dropped/.test(ensure),
   '溢れると古い順に捨てる＝先に待っていた予約・取消の会員が消える');
ok('③バイト数の数え方と上限は1箇所',
   (PUSH.match(/function _lbDwBytes\(/g) || []).length === 1
   && (PUSH.match(/var LB_DW_QUEUE_BYTES_LIMIT = /g) || []).length === 1,
   '2箇所に書くと、片方だけ直した日に黙ってずれる');

// ---------- 4. 状態で返す（栞を進めるかが変わる） ----------
for (const st of ['ADDED', 'EXISTS', 'CAPACITY', 'BROKEN', 'WRITE_FAILED', 'LOCKED']) {
  ok(`④状態 ${st} を返す`, new RegExp(`'${st}'`).test(ensure + strip(PUSH.slice(
    PUSH.indexOf('function lbDwEnsureQueued(customerIds) {'),
    PUSH.indexOf('function lbDwEnqueue(')))));
}
ok('④★壊れている・書けない・ロックが取れないときは栞を進めない',
   /if \(er\.status === 'BROKEN' \|\| er\.status === 'WRITE_FAILED'\) return er;/.test(pull)
   && /if \(r === null\) return \{ status: 'LOCKED' \};/.test(pull),
   '進めると、その会員は1周するまで再試行されない');
ok('④★Worker が失敗したら栞を進めない',
   /return \{ skipped: 'FETCH_FAILED' \};/.test(pull)
   && /return \{ skipped: \(body && body\.code\) \|\| 'BAD_BODY' \};/.test(pull));

// ---------- 4-b. 栞を進めなかったことを嘘なく出す（関門②の指摘） ----------
ok('④-b★栞の保存に失敗したら別の状態を返す',
   /return \{ status: 'CURSOR_WRITE_FAILED'/.test(pull),
   '元の状態を返すと、ログ上は栞が進んだように見えて診断で迷う');
ok('④-b★ログは実際に進んだかを出す',
   /のまま（進めていません）/.test(pull));
ok('④-b容量不足を数えられなかった回を握り潰さない',
   /容量不足の回数を記録できませんでした/.test(PUSH),
   '数えられなかった回は、容量不足を見張れない回になる');

// ---------- 5. 栞（飢えない・順序） ----------
ok('⑤★栞より後ろから引く',
   /&after=' \+ encodeURIComponent\(before\)/.test(pull),
   '先頭N名がいつも失敗しても、1周すれば後ろの会員に届く');
ok('⑤★末尾に到達したら栞を空に戻す',
   /var nextCursor = body\.done \? '' : String\(body\.next \|\| ''\);/.test(pull));
ok('⑤★通信中はロックを持たない',
   pull.indexOf('UrlFetchApp.fetch') < pull.indexOf('_lbDwLocked'),
   '15秒のロック待ちを食い潰す');
ok('⑤★ロックを取ってから栞を再確認する',
   /if \(now !== before\) return \{ status: 'CURSOR_CHANGED' \};/.test(pull),
   '別の実行が先に進めていたら、取ってきた結果は捨てる');
ok('⑤★キューを書いてから栞を書く',
   pull.indexOf('_lbDwEnsureQueuedInLock(ids)') < pull.indexOf('setProperty(LB_DW_BEHIND_PROP'),
   '逆だと「キューを書けず栞だけ進む」＝その区間が1周まで飛ばされる');
ok('⑤容量で積めなかった回も栞は進む',
   /if \(er\.status === 'CAPACITY'\)/.test(pull)
   && pull.indexOf("er.status === 'CAPACITY'") < pull.indexOf('setProperty(LB_DW_BEHIND_PROP'),
   '同じ区間で足踏みしない');

// ---------- 6. 誰が呼ぶか（新しいトリガーを作らない） ----------
const light = strip(PUSH.slice(PUSH.indexOf('function pushToEdgeLight() {'),
                               PUSH.indexOf('function pushToEdgeHome(')));
ok('⑥★15分ごとの押し出しから呼ぶ', /lbDwPullBehind\(\);/.test(light),
   '新しいトリガーを作らない（18/20）');
ok('⑥★drain の前に呼ぶ',
   light.indexOf('lbDwPullBehind()') < light.indexOf('lbDualWriteDrain()'),
   '積んだぶんがこの回の drain で処理され始める');
ok('⑥★キューが空かどうかを条件にしない',
   !/todo|queued/.test(light),
   '`todo` が空でも「全員が取り置き中」のことがあり、修復が永久に走らない');
ok('⑥別の try で囲む（落ちても drain は動かす）',
   /try \{ lbDwPullBehind\(\); \} catch/.test(light));

// ---------- 7. 1回に拾う人数 ----------
ok('⑦★初期値は2（drainの5枠のうち実データに3枠残す）',
   /var LB_DW_BEHIND_N = 2;/.test(PUSH));

// ---------- 8. 窓口（Worker側） ----------
ok('⑧★滞留の長さを返す',
   /SELECT MIN\(source_at\) AS oldest/.test(QUOTA)
   && /behindOldestSourceAt/.test(QUOTA),
   '件数だけでは「同じ5名が居座っている」を検知できない');
ok('⑧★時刻が無い会員を別に数える',
   /SUM\(CASE WHEN source_at IS NULL THEN 1 ELSE 0 END\) AS noAt/.test(QUOTA)
   && /behindSourceAtMissing/.test(QUOTA),
   'MIN() は NULL を無視する。全部 NULL だと滞留が判定できない（migration 0017 は NULL で作る）');

// ---------- 9. 見張り（点検） ----------
ok('⑨★滞留で鳴る', /gen_behind_stuck/.test(HEALTH));
ok('⑨★時刻が無いことで鳴る', /gen_behind_no_time/.test(HEALTH),
   '「時刻が無いから新しい扱い」ではなく「判定できないから警告」へ倒す');
ok('⑨★容量で積めなかった回数で鳴る', /gen_behind_capacity/.test(HEALTH));
ok('⑨件数そのものは info（それ単独では鳴らさない）',
   /add\('gen_behind', 'D1', 'info'/.test(HEALTH),
   '前日より増えたかは既存の悪化判定が見る');
ok('⑨滞留のしきい値は6時間', /_hrs >= 6/.test(HEALTH));

console.log(`${fail ? '❌' : '✅'} 遅れている会員の収束 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
