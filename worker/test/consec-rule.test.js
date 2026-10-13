// 同じトレーナーの連続を3時間で区切る（設計18）を、動かして確かめる。
//   実行: node worker/test/consec-rule.test.js
//
// ★ルール（2026-10-13 オーナー確定）
//   1. すでに3時間続いている予約のすぐ前・すぐ後は15分あける（3時間を超える伸ばし方は不可）
//   2. すき間を埋める予約は、つながっても5時間まで可（1より優先）
//   3. どんな場合も連続5時間を超えない
//   連続＝同じトレーナーのセッション間が15分未満。体験は数えない。顧客が自分で取る予約だけ。
//
// ★この1つの関数が画面の枠と予約の確定の両方を決める。境界を1つ間違えると、
//   顧客に4時間連続を取らせるか、取れるはずの枠を消す。

import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const B = require_(join(ROOT, 'gas/BookingRules.js'));

let pass = 0, fail = 0;
function ok(name, cond, why) {
  if (cond) { pass++; return; }
  fail++; console.log(`❌ ${name}`); if (why) console.log(`   ${why}`);
}

const M = 60000;
const BASE = Date.UTC(2026, 9, 20, 0, 0);                // 基準（時刻は「分」で書く）
const t = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return BASE + (h * 60 + m) * M; };
const ses = (...pairs) => pairs.map(([a, b]) => ({ start: t(a), end: t(b) }));
const V = (sessions, a, b, opt) => B._lbConsecVerdict(sessions, t(a), t(b), opt);

// ============================================================
console.log('=== 1. オーナーの例（設計18 §1 の表）===');
{
  const run = ses(['10:00', '11:00'], ['11:00', '12:00'], ['12:00', '13:00']);
  ok('1-1 10-13 の直後 13:00 は取れない', V(run, '13:00', '14:00').ok === false);
  ok('1-2 13:15 は取れる', V(run, '13:15', '14:15').ok === true);
  ok('1-3 直前 9:00 は取れない', V(run, '09:00', '10:00').ok === false);
  ok('1-4 8:45 は取れる', V(run, '08:45', '09:45').ok === true);
  ok('1-5 7:45 は取れる', V(run, '07:45', '08:45').ok === true);
  const gap1 = ses(['09:00', '10:00'], ['10:00', '11:00'], ['12:00', '13:00']);
  const g1 = V(gap1, '11:00', '12:00');
  ok('1-6 9-11 と 12-13 の間 11:00 は取れる（すき間埋め・4時間）', g1.ok === true && g1.side === 'both' && g1.lengthMin === 240);
  const gap2 = ses(['09:00', '10:00'], ['10:00', '11:00'], ['11:00', '12:00'], ['13:00', '14:00']);
  const g2 = V(gap2, '12:00', '13:00');
  ok('1-7 ★9-12 と 13-14 の間 12:00 は取れる（ルール2優先・5時間）', g2.ok === true && g2.side === 'both' && g2.lengthMin === 300,
     'オーナー確定（2026-10-13）：すき間埋めは3時間の直後でも5時間まで可');
  const gap3 = ses(['09:00', '12:00'], ['13:00', '15:00']);
  ok('1-8 9-12 と 13-15 の間 12:00 は取れない（6時間＝ルール3）', V(gap3, '12:00', '13:00').ok === false);
  const half = ses(['10:00', '11:00'], ['11:00', '12:00'], ['12:00', '12:30']);
  ok('1-9 ★2.5時間に60分足して3.5時間は取れない（オーナー確定：15分あける）', V(half, '12:30', '13:30').ok === false);
  ok('1-10 2.5時間に30分足して3時間ちょうどは取れる', V(half, '12:30', '13:00').ok === true);
}

console.log('=== 2. 境界（連続のつながり方）===');
{
  const run = ses(['10:00', '13:00']);
  ok('2-1 ★ちょうど15分あいたら別の連続', V(run, '13:15', '14:15').side === 'none');
  ok('2-2 14分なら同じ連続', V(run, '13:14', '14:14').side === 'one' && V(run, '13:14', '14:14').ok === false);
  ok('2-3 0分（接する）は同じ連続', V(run, '13:00', '14:00').side === 'one');
  const two = ses(['10:00', '12:00']);
  ok('2-4 2時間に1時間足して3時間ちょうどは取れる（180は可）', V(two, '12:00', '13:00').ok === true && V(two, '12:00', '13:00').lengthMin === 180);
  const g = ses(['08:00', '10:00'], ['11:00', '14:00']);
  ok('2-5 すき間埋めで5時間を1分でも超えたら取れない', V(ses(['08:00', '10:00'], ['11:00', '13:01']), '10:00', '11:00').ok === false);
  ok('2-6 すき間埋めで5時間ちょうどは取れる', V(ses(['08:00', '10:00'], ['11:00', '13:00']), '10:00', '11:00').ok === true);
  ok('2-7 どこにもつながらない枠は取れる', V(g, '15:00', '16:00').ok === true && V(g, '15:00', '16:00').side === 'none');
  ok('2-8 existingMin：片側なら伸ばす前の幅', V(ses(['10:00', '12:00']), '12:00', '13:00').existingMin === 120);
  ok('2-9 existingMin：すき間埋めは null', V(g, '10:00', '11:00').existingMin === null);
  ok('2-10 同じ日に2回3時間連続があっても、それぞれ区切る',
     V(ses(['07:00', '10:00'], ['14:00', '17:00']), '10:00', '11:00').ok === false && V(ses(['07:00', '10:00'], ['14:00', '17:00']), '17:00', '18:00').ok === false);
  ok('2-11 連続の鎖（14分ずつ空いて続く）も1つの連続として数える',
     V(ses(['10:00', '11:00'], ['11:14', '12:14'], ['12:28', '13:00']), '13:00', '14:00').lengthMin === 240);
  const far = ses(['10:00', '12:00'], ['12:15', '13:15']);
  const vf = V(far, '09:00', '10:00');
  ok('2-12 ★鎖の向こう側でちょうど15分あいた予定は、連続の長さに入れない', vf.lengthMin === 180 && vf.ok === true,
     `lengthMin=${vf.lengthMin}（12:15〜は別の連続。入れると255分で弾いてしまう）`);
  const lr = B._lbConsecLongRuns(ses(['10:00', '12:00'], ['12:15', '13:15']));
  ok('2-13 3時間以上の連続を拾うときも、ちょうど15分で区切る', lr.length === 0);
}

console.log('=== 3. 読めないときは答えない（MODEL §0）===');
{
  ok('3-1 枠の開始≧終了は invalid・取れない', V([], '10:00', '10:00').invalid === true && V([], '10:00', '10:00').ok === false);
  ok('3-2 セッションに読めない時刻があれば invalid', B._lbConsecVerdict([{ start: 'x', end: t('10:00') }], t('11:00'), t('12:00')).invalid === true);
  ok('3-3 知らない方式は invalid', V([], '10:00', '11:00', { oneSideMode: 'nope' }).invalid === true);
}

console.log('=== 4. 片側の方式は切り替えられる（C11）===');
{
  const run = ses(['10:00', '13:00']);
  const half = ses(['10:00', '12:30']);
  const lit = { oneSideMode: 'existing_run_under_180' };
  ok('4-1 ★どちらの方式でも 10-13 に 13-14 は取れない', V(run, '13:00', '14:00').ok === false && V(run, '13:00', '14:00', lit).ok === false,
     '上限を300にしただけだとここまで通る（関門①）');
  ok('4-2 字面の方式なら 2.5時間＋60分は取れる', V(half, '12:30', '13:30', lit).ok === true);
  ok('4-3 既定は result_max_180', B.LB_CONSEC_DEFAULTS.ONE_SIDE_MODE === 'result_max_180');
}

console.log('=== 5. 体験の見分け方（C3）===');
{
  const sc = B._lbConsecSurCount([{ name: '鈴木 一郎' }, { name: '沖 二郎' }, { name: '中野 三郎' }]);
  ok('5-1 LINE の体験', B._lbConsecIsTrialFor('[RESERVED] 体験_鈴木_山田花子様_line', '鈴木', sc) === true);
  ok('5-2 HP の体験', B._lbConsecIsTrialFor('[RESERVED] 体験_鈴木_山田花子様', '鈴木', sc) === true);
  ok('5-3 ★ホットペッパーの体験（別リポジトリ hpb-mail-to-calendar が作る形）', B._lbConsecIsTrialFor('[RESERVED] HPB体験_鈴木_山田花子様', '鈴木', sc) === true,
     '_lbClassifyBooking は完全一致の「体験」だけ。ここは「含む」で拾う');
  ok('5-4 ★別のトレーナーの体験は外さない', B._lbConsecIsTrialFor('[RESERVED] 体験_沖_山田花子様', '鈴木', sc) === false);
  ok('5-5 通常は体験ではない', B._lbConsecIsTrialFor('[RESERVED] 通常_鈴木_山田花子様_line', '鈴木', sc) === false);
  ok('5-6 [消化] は見ない', B._lbConsecIsTrialFor('[消化] [RESERVED] 体験_鈴木_山田花子様', '鈴木', sc) === false);
  const dup = B._lbConsecSurCount([{ name: '鈴木 一郎' }, { name: '鈴木 次郎' }]);
  ok('5-7 ★同じ姓が2人いたら曖昧＝体験とみなさない（数える側）', B._lbConsecIsTrialFor('[RESERVED] 体験_鈴木_山田花子様', '鈴木', dup) === false);
  ok('5-8 姓が読めない形は体験とみなさない', B._lbConsecIsTrialFor('[RESERVED] 体験', '鈴木', sc) === false);
  ok('5-9 staging の [TEST] 前置も読む', B._lbConsecIsTrialFor('[TEST] [RESERVED] 体験_鈴木_山田様', '鈴木', sc) === true);

  const isSession = (title) => /^(\[RESERVED\]|✅)/.test(title) && !/休憩|ブロック/.test(title);
  const tr = [
    { title: '✅ Aさま｜セッション_line', start: t('09:00'), end: t('10:00') },
    { title: '✅ 体験さま｜カウンセリング', start: t('10:00'), end: t('11:30') },
    { title: '✅ Bさま｜セッション_line', start: t('11:30'), end: t('12:30') },
    { title: '休憩', start: t('12:30'), end: t('12:45') },
    { title: '出勤可能', start: t('07:00'), end: t('23:00') },
  ];
  const b1 = [
    { title: '[RESERVED] 通常_鈴木_A様_line', start: t('09:00'), end: t('10:00') },
    { title: '[RESERVED] 体験_鈴木_体験様', start: t('10:00'), end: t('11:30') },
    { title: '[RESERVED] 通常_鈴木_B様_line', start: t('11:30'), end: t('12:30') },
  ];
  const got = B._lbConsecSessionsOf(tr, b1, '鈴木', sc, isSession, null);
  ok('5-10 ★体験を挟むと連続が区切られる（体験は数えない）', got.length === 2 && got[0].start === t('09:00') && got[1].start === t('11:30'));
  ok('5-11 休憩・出勤可能はセッションではない', got.every((x) => x.end - x.start === 60 * M));
  const other = B._lbConsecSessionsOf(
    [{ title: '✅ Cさま｜オンライン', start: t('10:00'), end: t('11:00') }],
    [{ title: '[RESERVED] 体験_沖_D様', start: t('10:00'), end: t('11:30') }], '鈴木', sc, isSession, null);
  ok('5-12 ★B1 で沖さんの体験・1F で鈴木さんの通常が同じ時刻でも、鈴木さんの通常は数える', other.length === 1,
     '時刻の重なりだけで決めると外してしまう（関門①）');
  const ex = B._lbConsecSessionsOf(tr, b1, '鈴木', sc, isSession, t('09:00'));
  ok('5-13 変更のとき自分の旧予定は数えない', ex.length === 1 && ex[0].start === t('11:30'));
  const ex2 = B._lbConsecSessionsOf(tr, b1, '鈴木', sc, isSession, [t('09:00'), t('11:30')]);
  ok('5-14 除外は配列でも受ける（dry の後判定：旧予定といま作った予約）', ex2.length === 0);
}

console.log('=== 6. 追加の枠の開始（on のとき・設計18 §3-3）===');
{
  const runs = B._lbConsecLongRuns(ses(['10:00', '11:00'], ['11:00', '12:00'], ['12:00', '13:00']));
  ok('6-1 3時間以上の連続を拾う', runs.length === 1 && runs[0].start === t('10:00') && runs[0].end === t('13:00'));
  ok('6-2 2時間の連続は拾わない', B._lbConsecLongRuns(ses(['10:00', '12:00'])).length === 0);
  // 出勤 7:00〜23:00・ほかに予定なし
  const fits = (st) => st >= t('07:00') && st + 60 * M <= t('10:00') || st >= t('13:00') && st + 60 * M <= t('23:00');
  const xs = B._lbConsecExtraStarts(runs, 60, fits).map((ms) => new Date(ms).toISOString().slice(11, 16));
  ok('6-3 ★13:15・8:45・7:45 が出る', xs.includes('13:15') && xs.includes('08:45') && xs.includes('07:45'), JSON.stringify(xs));
  ok('6-4 ブロックの先頭を割らない（6:45 は出ない）', !xs.includes('06:45'));
  const fits2 = (st) => (st >= t('08:00') && st + 60 * M <= t('10:00')) || (st >= t('13:00') && st + 60 * M <= t('23:00'));
  const xs2 = B._lbConsecExtraStarts(runs, 60, fits2).map((ms) => new Date(ms).toISOString().slice(11, 16));
  ok('6-5 収まらないところで前への列挙を止める（別のブロックへ飛ばない）', xs2.includes('08:45') && !xs2.includes('07:45'));
}

console.log('');
console.log(`${fail ? '❌' : '✅'} 連続ルール（判定の部品） 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
