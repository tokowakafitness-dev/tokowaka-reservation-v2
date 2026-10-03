// 自動休憩：休憩の区間を決める純粋関数の検証（決定0063・設計 ops/design/03-auto-break.md）
//
//   ★なぜ純粋関数にしたか
//     「カレンダーを読まないと確認できない形にしない」（設計§6-9）。
//     塊の終わり・休憩の長さ・次の埋まりの開始・シフトの終わりだけで決まるようにして、
//     本番のカレンダーに1件も書かずにここで確かめきる。
//
//   ★設計書が挙げた「わざと壊して検知するか」を、そのままテストにしてある（§8）。
//     しきい値を本数で数える／1日1件に制限する／clipをやめる／
//     休憩の長さを隙間より長くする ―― いずれもここで落ちる。
//
//   実行: node worker/test/auto-break-rules.test.js

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const R = require('../../gas/BookingRules.js');

let pass = 0, fail = 0;
function eq(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log(`❌ ${name}\n   got : ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`); }
}
function ok(name, cond, extra) { cond ? pass++ : (fail++, console.log(`❌ ${name}${extra ? '\n   ' + extra : ''}`)); }

const MIN = 60000;
const D = (h, m) => new Date(2026, 9, 10, h, m || 0).getTime();   // 2026-10-10 JST

// ---------- 1. ★しきい値は「以上」で数える ----------
//   `>` だと 10:00-13:00（ちょうど180分）の3連続で休憩が入らない。
//   実測の「180分以上 6件」はこの数え方。数え方を2通りにしない（設計§5）。
eq('①180分ちょうどで入れる', R._lbAutoBreakNeeded(180, 180), true);
eq('①181分でも入れる', R._lbAutoBreakNeeded(181, 180), true);
eq('①179分では入れない', R._lbAutoBreakNeeded(179, 180), false);
eq('①240分（4時間連続・実測2件）で入れる', R._lbAutoBreakNeeded(240, 180), true);
// ★本数で数えていないこと。体験90分×2本＝180分でも入る（設計§10-1）。
eq('①体験90分×2本＝180分でも入れる（本数ではなく時間）', R._lbAutoBreakNeeded(90 + 90, 180), true);
eq('①60分×2本＝120分では入れない', R._lbAutoBreakNeeded(120, 180), false);
eq('①しきい値が壊れていたら入れない', R._lbAutoBreakNeeded(999, NaN), false);
eq('①長さが壊れていたら入れない', R._lbAutoBreakNeeded(null, 180), false);

// ---------- 2. ★不変条件：休憩の長さ ≦ 隙間 ----------
//   これが崩れると休憩が次のセッションに重なる（設計§6-9）。黙って壊れた状態で動かさない。
eq('②既定（15分・隙間15分）は通る',
  R._lbAutoBreakCfgCheck({ limitMin: 180, breakMin: 15, gapMin: 15 }).ok, true);
eq('②休憩10分・隙間15分も通る',
  R._lbAutoBreakCfgCheck({ limitMin: 180, breakMin: 10, gapMin: 15 }).ok, true);
eq('②★休憩30分・隙間15分は無効にする',
  R._lbAutoBreakCfgCheck({ limitMin: 180, breakMin: 30, gapMin: 15 }),
  { ok: false, reason: 'break_longer_than_gap' });
eq('②しきい値が0以下なら無効',
  R._lbAutoBreakCfgCheck({ limitMin: 0, breakMin: 15, gapMin: 15 }).reason, 'bad_limit');
eq('②休憩が0分なら無効',
  R._lbAutoBreakCfgCheck({ limitMin: 180, breakMin: 0, gapMin: 15 }).reason, 'bad_break');
eq('②隙間が負なら無効',
  R._lbAutoBreakCfgCheck({ limitMin: 180, breakMin: 15, gapMin: -1 }).reason, 'bad_gap');
eq('②設定が空なら無効', R._lbAutoBreakCfgCheck(null).ok, false);
eq('②文字列で入っていても読む（プロパティは文字列で来る）',
  R._lbAutoBreakCfgCheck({ limitMin: '180', breakMin: '15', gapMin: '15' }).ok, true);
// 既定値がそのまま不変条件を満たしていること
ok('②既定値そのものが不変条件を満たす',
  R._lbAutoBreakCfgCheck(R.LB_AUTO_BREAK_DEFAULTS).ok === true);
ok('②既定のしきい値は180分（実測で決めた値）', R.LB_AUTO_BREAK_DEFAULTS.limitMin === 180);

// ---------- 3. ふつうに入る場合 ----------
{
  const r = R._lbAutoBreakClip({ runEndMs: D(13), breakMin: 15, nextBusyMs: D(14), shiftEndMs: D(21) });
  eq('③13:00終わり→13:00〜13:15', [r.ok, r.startMs, r.endMs, r.minutes, r.clipped],
     [true, D(13), D(13, 15), 15, false]);
}
{
  // 次の埋まりが無い（その日の最後）／シフトの終わりだけある
  const r = R._lbAutoBreakClip({ runEndMs: D(13), breakMin: 15, nextBusyMs: null, shiftEndMs: D(21) });
  eq('③次の予定が無くてもシフト内なら入る', [r.ok, r.minutes], [true, 15]);
}
{
  const r = R._lbAutoBreakClip({ runEndMs: D(13), breakMin: 15, nextBusyMs: null, shiftEndMs: null });
  eq('③シフトが分からなくても入る（分からない＝制限しない）', [r.ok, r.minutes], [true, 15]);
}

// ---------- 4. ★シフトの終わりで切る ----------
//   塊が退勤ちょうどに終わると休憩がシフト外に出る。意味のない予定を増やさない（設計§6-9）。
{
  const r = R._lbAutoBreakClip({ runEndMs: D(21), breakMin: 15, nextBusyMs: null, shiftEndMs: D(21) });
  eq('④★退勤ちょうどに終わったら入れない', [r.ok, r.reason], [false, 'skip_outside_shift']);
}
{
  // 実測にあった 17:00〜21:00 の形。21:10 退勤なら10分だけ入る
  const r = R._lbAutoBreakClip({ runEndMs: D(21), breakMin: 15, nextBusyMs: null, shiftEndMs: D(21, 10) });
  eq('④シフト終わりで切って10分にする', [r.ok, r.minutes, r.clipped], [true, 10, true]);
  eq('④切った終わりはシフトの終わり', r.endMs, D(21, 10));
}
{
  const r = R._lbAutoBreakClip({ runEndMs: D(21, 30), breakMin: 15, nextBusyMs: null, shiftEndMs: D(21) });
  eq('④すでにシフトを過ぎていたら入れない', [r.ok, r.reason], [false, 'skip_outside_shift']);
}

// ---------- 5. ★次の埋まりで切る ----------
//   いまは 休憩15分 ≦ 隙間15分 なので必ず収まるが、設定で壊せる。壊れたときに重ねない。
{
  const r = R._lbAutoBreakClip({ runEndMs: D(13), breakMin: 30, nextBusyMs: D(13, 15), shiftEndMs: D(21) });
  eq('⑤★次の予定で切って15分にする（重ねない）', [r.ok, r.minutes, r.clipped], [true, 15, true]);
  eq('⑤切った終わりは次の予定の開始', r.endMs, D(13, 15));
}
{
  const r = R._lbAutoBreakClip({ runEndMs: D(13), breakMin: 15, nextBusyMs: D(13), shiftEndMs: D(21) });
  eq('⑤隙間が無ければ入れない', [r.ok, r.reason], [false, 'skip_no_room']);
}
{
  // 両方で切られるとき、短いほうが勝つ
  const r = R._lbAutoBreakClip({ runEndMs: D(13), breakMin: 30, nextBusyMs: D(13, 20), shiftEndMs: D(13, 10) });
  eq('⑤シフトと次の予定の両方があれば短いほうで切る', [r.ok, r.minutes], [true, 10]);
}

// ---------- 6. 壊れた入力で書きにいかない ----------
for (const [label, opts] of [
  ['終わりが無い', { breakMin: 15 }],
  ['終わりが文字列', { runEndMs: 'ごみ', breakMin: 15 }],
  ['休憩の長さが無い', { runEndMs: D(13) }],
  ['休憩が0分', { runEndMs: D(13), breakMin: 0 }],
  ['休憩が負', { runEndMs: D(13), breakMin: -15 }],
  ['引数そのものが無い', null],
]) {
  const r = R._lbAutoBreakClip(opts);
  ok(`⑥${label}なら入れない`, r.ok === false, JSON.stringify(r));
}
// ★null を 1970年として扱っていないこと（この取り違えを過去に何度も踏んでいる）
{
  const r = R._lbAutoBreakClip({ runEndMs: null, breakMin: 15 });
  eq('⑥★終わりが null でも1970年に書きにいかない', r.ok, false);
}

// ---------- 7. ★冪等キー：同じ日に2回でも別の休憩 ----------
//   実測で「同じ日に2回3連続が起きた日」が1日ある。1日1件に制限する作りは不可（設計§6-2）。
{
  const k1 = R._lbAutoBreakKey('t1', D(13));
  const k2 = R._lbAutoBreakKey('t1', D(19));
  ok('⑦★同じ日の2つの塊が別のキーになる', k1 !== k2, `${k1} / ${k2}`);
  eq('⑦同じ塊なら同じキー', R._lbAutoBreakKey('t1', D(13)), k1);
  ok('⑦トレーナーが違えば別のキー', R._lbAutoBreakKey('t2', D(13)) !== k1);
  eq('⑦トレーナーが空ならキーを作らない', R._lbAutoBreakKey('', D(13)), '');
  eq('⑦終わりが壊れていたらキーを作らない', R._lbAutoBreakKey('t1', NaN), '');
  eq('⑦終わりが null でもキーを作らない', R._lbAutoBreakKey('t1', null), '');
}

// ---------- 8. ★掃除は「切った後どうし」で比べる ----------
//   「塊の終わり＋15分」で比べると、シフト終わりで10分に切られた休憩を
//   毎日「違う」と判断して消してしまう（設計§6-11）。
{
  const planned = R._lbAutoBreakClip({ runEndMs: D(21), breakMin: 15, shiftEndMs: D(21, 10) });
  const onCal   = { startMs: D(21), endMs: D(21, 10) };          // 実際に入っている（10分に切られた）
  ok('⑧★切られた休憩を「違う」と判定しない', R._lbAutoBreakSame(planned, onCal));

  const naive = { startMs: D(21), endMs: D(21, 15) };            // 切る前の素朴な15分
  ok('⑧切る前の形とは一致しない（だから素朴な比較では消してしまう）',
     !R._lbAutoBreakSame(naive, onCal));

  ok('⑧片方が無ければ一致しない', !R._lbAutoBreakSame(null, onCal));
  ok('⑧両方無ければ一致しない', !R._lbAutoBreakSame(null, null));
  ok('⑧1分でもずれたら一致しない',
     !R._lbAutoBreakSame({ startMs: D(21), endMs: D(21, 10) }, { startMs: D(21), endMs: D(21, 11) }));

  // ★欠けた時刻どうしを「同じ」と判定しない。Number(null) は 0 なので
  //   素朴に書くと null 同士が一致し、**誤って消す**側の事故になる。
  ok('⑧★欠けた時刻どうしを一致と見なさない',
     !R._lbAutoBreakSame({ startMs: null, endMs: null }, { startMs: null, endMs: null }));
  ok('⑧★片方が欠けていれば一致しない',
     !R._lbAutoBreakSame({ startMs: null, endMs: null }, onCal));
  ok('⑧★終わりだけ欠けていても一致しない',
     !R._lbAutoBreakSame({ startMs: D(21), endMs: null }, { startMs: D(21), endMs: null }));
  ok('⑧空文字も一致しない',
     !R._lbAutoBreakSame({ startMs: '', endMs: '' }, { startMs: '', endMs: '' }));
}

// ---------- 10. 時刻として読めるかの判定そのもの ----------
//   欠損を1970年として扱わないための関門。ここが緩むと全部が緩む。
eq('⑩数値は読める', R._lbMsOk(1760000000000), true);
eq('⑩文字列の数値も読める（設定は文字列で来る）', R._lbMsOk('1760000000000'), true);
eq('⑩★null は読めない', R._lbMsOk(null), false);
eq('⑩★undefined は読めない', R._lbMsOk(undefined), false);
eq('⑩★空文字は読めない', R._lbMsOk(''), false);
eq('⑩文字は読めない', R._lbMsOk('ごみ'), false);
eq('⑩NaN は読めない', R._lbMsOk(NaN), false);
eq('⑩無限大は読めない', R._lbMsOk(Infinity), false);
eq('⑩0 は読める（1970年そのものを指定した場合は通す）', R._lbMsOk(0), true);

// ---------- 9. 実測の形をそのまま通す ----------
//   過去30日の実測：180分以上6件・うち240分以上2件・休憩を含む予定0件
{
  const cfg = R._lbAutoBreakCfgCheck(R.LB_AUTO_BREAK_DEFAULTS);
  const cases = [
    ['10:00-13:00（60分×3本）', 10, 13, true],
    ['17:00-21:00（4時間連続）', 17, 21, true],
    ['10:00-12:00（2時間）',     10, 12, false],
  ];
  for (const [label, sh, eh, want] of cases) {
    const span = (D(eh) - D(sh)) / MIN;
    eq(`⑨${label} → 休憩を入れる=${want}`, R._lbAutoBreakNeeded(span, cfg.limitMin), want);
  }
}

console.log(`\n${fail ? '❌' : '✅'} 自動休憩（純粋関数） 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
