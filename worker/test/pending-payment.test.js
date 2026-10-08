// 支払い待ち（枠を超えて押さえた予約）の扱いを固定する。
//   実行: node worker/test/pending-payment.test.js
//
// ★オーナーの運用（2026-10-08）
//   未登録顧客の予定を作るとき、既存顧客の未払いチケット分を先に押さえる。
//   次回のセッションで支払いをいただき、**トレーナーが確認してからチケットを付与**して相殺する。
//   → 枠を超えた予約（unallocated）は**異常ではなく「支払い待ち」**。
//
// ★ただし締めは待ってくれない。
//   相殺しないまま月が終わると、1名でも未裁定で**月全体が締まらない**（FAIL_CLOSED）。
//   月初に締めようとして初めて止まるのでは遅い。月末が近いうちに気づける必要がある。

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const EA = readFileSync(join(ROOT, 'gas/EdgeAudit.js'), 'utf8');
const LB = readFileSync(join(ROOT, 'gas/LineBooking.js'), 'utf8');
const AL = readFileSync(join(ROOT, 'gas/Allocate.js'), 'utf8');
const EJ = readFileSync(join(ROOT, 'gas/EdgeJob.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  cond ? pass++ : (fail++, console.log(`❌ ${name}${extra ? '\n   ' + extra : ''}`));
}

console.log('=== 1. 異常ではなく「支払い待ち」として見せる ===');
ok('①表の印が「支払い待ち」', /支払い待ち' \+ _unCur \+ '件（チケット付与で相殺）/.test(EA));
ok('①★「超過」だけの表示に戻っていない',
  !/flags\.push\('今月が' \+ _unCur \+ '件超過'\)/.test(EA),
  '異常に見えると、オーナーの確認の手間が増え、本物の異常が埋もれる');
ok('①相殺のしかたを書いている', /チケット付与で相殺/.test(EA));

console.log('=== 2. 締めが止まる前に気づける ===');
ok('②月末が近いときだけ出す', /_daysLeft <= 7/.test(LB));
ok('②★3日以内は high にする', /_daysLeft <= 3 \? 'high' : 'warn'/.test(LB));
ok('②日次点検に出る', /pending_payment_overage/.test(LB));
ok('②★「月全体が締まりません」と書いている',
  /1名でも残っていれば月全体が締まりません/.test(LB),
  '何が起きるかを書かないと、優先度が伝わらない');
ok('②誰が該当するかを出す', /meta\.pendingPayNames/.test(LB));
ok('②点検そのものが失敗しても気づける', /pending_payment_check_fail/.test(LB));
ok('②表にも月末までの日数を出す', /月末まで' \+ _dLeft \+ '日/.test(EA));
//   ★件数が同じでも、3日以内になれば必ず知らせる（Codex関門②）。
//     悪化の判定は「同じ名前の件数が増えたか」だけを見るので、
//     warn のまま件数が変わらないと high のメールが飛ばない。
ok('②★3日以内は名前を分けて必ず知らせる',
  /pending_payment_overage_urgent/.test(LB)
  && /_daysLeft <= 3\) \? 'pending_payment_overage_urgent' : 'pending_payment_overage'/.test(LB),
  '締まらなくなる予告は、件数ではなく日付で強くする必要がある');
//   ★集計が走っていなければ 0件と言わない（Codex関門②）
ok('②★分からないときは「分からない」と出す',
  /pending_payment_unknown/.test(LB)
  && /meta\.pendingPayMembers == null/.test(LB),
  '「読めなかった」を「支払い待ちは無い」と言うと、締まらなくなる直前に気づけない');

console.log('=== 3. 数え方（走査は1回だけ） ===');
//   ★別に走査を足すと、全会員の契約と予約をもう一度読む（33名で60秒級・契約の全読込は実測59秒）。
//     消化ペースの集計が既に全会員を走っていて、home には overageCount がある。それを足すだけ。
ok('③消化ペースの走査の中で数える', /var pendingPay = \{ members: 0, sessions: 0, names: \[\] \};/.test(LB));
ok('③★既にある overageCount を使う（数え方を二通り作らない）',
  /Number\(\(h && h\.overageCount\) \|\| 0\)/.test(LB),
  'home の overageCount は「割り当てられなかった予約」を入力の誤りを除いて数えている');
ok('③集計に保存する', /pendingPayMembers: \(r\.pendingPay \|\| \{\}\)\.members \|\| 0/.test(LB));
ok('③日次点検は保存された値を読む（自分で走査しない）',
  /meta\.pendingPayMembers/.test(LB) && !/_lbPendingPaymentCount/.test(LB),
  '走査を足すと日次点検がGASの6分制限に近づく');
ok('③★入力の誤りは超過に数えない（既存の規則）',
  /LB_OVERAGE_REASONS\[String\(ps\.reason\)\]/.test(LB),
  'チケットの期限切れ・使い切り・枠不足だけを数える');

console.log('=== 4. 相殺の仕組み（チケット付与）===');
ok('④付与はチケット種別で作る（月額を押しのけない）',
  /rowArr\[cols\.type\]\s*=\s*isPair \? 'ペア'/.test(LB),
  '種別=通常で作ると billing が月額契約を押しのけ、売上¥0になる（2026-09に実際に発生）');
ok('④付与の開始日は購入日', /rowArr\[cols\.start\]\s*=\s*Utilities\.formatDate\(today/.test(LB));
ok('④★割当は日付順＝超過は月の後ろに寄る',
  /unallocated/.test(AL),
  '超過が後ろに寄るので、次回セッションでの付与（購入日から）でも相殺できる');

console.log('=== 5. ★支払い待ちは「請求から消える」のではなく「旧経路で請求する」 ===');
//   ★オーナーの問い「超過のまま月を跨ぐと会計上問題があるのか」に事実で答えるため、
//     ここを検査で固定する（2026-10-08）。
ok('⑤締めの売上計算では未割当を対象外にする',
  /d\.alloc === 'transfer' \|\| d\.alloc === 'unallocated'\) continue;/.test(AL),
  '新しい締めの経路では売上に乗らない');
ok('⑤★カレンダー経路からは外さない（＝旧billingで請求する）',
  /if \(alloc !== 'monthly' && alloc !== 'pack'\) \{ skippedNonRev\+\+; continue; \}/.test(AL),
  '外すと請求が消える。振替（手動請求）と同じ扱いで、意図的に残している');
ok('⑤その意図がコメントに書いてある',
  /振替=手動請求\)・unallocated は/.test(AL) && /カレンダー経路のまま維持し除外しない/.test(AL));

console.log('=== 6. 締めの状態を読める窓口（事実で答えるため）===');
ok('⑥締めの状態を出す関数がある', /function closingStatusText\(\)/.test(EA));
ok('⑥作業依頼から呼べる', /args && args\.closing\) return _ejScrub\(closingStatusText\(\)\)/.test(EJ));
ok('⑥一度も締めていない場合をはっきり書く',
  /締めを一度も実行していません/.test(EA),
  '締めを回していないなら「月全体が締まらない」は現に起きていない');
ok('⑥締めは手で実行するものだと書いてある', /締めは手で実行するものです/.test(EA));

console.log('');
console.log(`${fail ? '❌' : '✅'} 支払い待ちの扱い 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
