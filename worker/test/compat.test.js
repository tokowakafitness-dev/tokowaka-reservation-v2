// GAS互換層の検証。画面はここが返す形をそのまま描くので、
// 日付の表示・キャンセル無料の境目・締め切りがGASと1文字でも違うと事故になる。
//   実行: node worker/test/compat.test.js
import { resvLabel, isFreeCancel, _forTest } from '../src/routes/compat.js';

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else { fail++; console.log(`❌ ${name}\n   got : ${g}\n   want: ${w}`); }
}
// 日本時間の日時をミリ秒に
const jstMs = (y, m, d, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h - 9, mi);

// ---------- 1. 予約の日付表示（GASの _lbFmtResvLabel と同じ）----------
eq('日本語の表示', resvLabel(jstMs(2026, 10, 6, 19, 30), 'ja'), '10月6日(火) 19:30');
eq('1桁の時刻は0を付ける', resvLabel(jstMs(2026, 10, 6, 9, 5), 'ja'), '10月6日(火) 09:05');
eq('英語の表示', resvLabel(jstMs(2026, 10, 6, 19, 30), 'en'), 'Oct 6 (Tue) 19:30');
eq('簡体字の表示', resvLabel(jstMs(2026, 10, 6, 19, 30), 'zh'), '10月6日(周二) 19:30');
eq('繁体字の表示', resvLabel(jstMs(2026, 10, 6, 19, 30), 'zh-Hant'), '10月6日(週二) 19:30');
eq('言語を渡さなければ日本語', resvLabel(jstMs(2026, 10, 6, 19, 30)), '10月6日(火) 19:30');

// ---------- 2. 日をまたぐところ（世界標準時で見ると前日に見える）----------
eq('★深夜0時半は当日の表示', resvLabel(jstMs(2026, 10, 1, 0, 30), 'ja'), '10月1日(木) 00:30');
eq('★23時は当日の表示', resvLabel(jstMs(2026, 9, 30, 23, 0), 'ja'), '9月30日(水) 23:00');

// ---------- 3. キャンセル無料の境目（前日17時・日本時間）----------
{
  const start = jstMs(2026, 10, 6, 19, 0);            // 10/6 19:00 の予約
  eq('★前日16時59分は無料', isFreeCancel(start, jstMs(2026, 10, 5, 16, 59)), true);
  eq('★前日17時ちょうどは無料でない', isFreeCancel(start, jstMs(2026, 10, 5, 17, 0)), false);
  eq('★前日17時1分は無料でない', isFreeCancel(start, jstMs(2026, 10, 5, 17, 1)), false);
  eq('2日前は無料', isFreeCancel(start, jstMs(2026, 10, 4, 23, 0)), true);
  eq('当日は無料でない', isFreeCancel(start, jstMs(2026, 10, 6, 9, 0)), false);
}
// 月初の予約＝前日は前月末
{
  const start = jstMs(2026, 10, 1, 10, 0);
  eq('★10/1の予約は9/30 17時が境目（前）', isFreeCancel(start, jstMs(2026, 9, 30, 16, 59)), true);
  eq('★10/1の予約は9/30 17時が境目（後）', isFreeCancel(start, jstMs(2026, 9, 30, 17, 0)), false);
}

// ---------- 4. 枠の締め切り（3時間前／午前枠は前日22時）----------
{
  const { isSlotOpen } = _forTest;
  const cfg = { leadMinutes: 180, morningUntilHour: 12, prevDeadlineHour: 22 };

  const noon = jstMs(2026, 10, 6, 14, 0);                         // 午後の枠
  eq('3時間1分前は取れる', isSlotOpen(noon, jstMs(2026, 10, 6, 10, 59), cfg), true);
  eq('★3時間前ちょうどは取れない', isSlotOpen(noon, jstMs(2026, 10, 6, 11, 0), cfg), false);

  const morning = jstMs(2026, 10, 6, 8, 0);                       // 午前の枠
  eq('★午前枠は前日21時59分なら取れる', isSlotOpen(morning, jstMs(2026, 10, 5, 21, 59), cfg), true);
  eq('★午前枠は前日22時で締め切る', isSlotOpen(morning, jstMs(2026, 10, 5, 22, 0), cfg), false);
  eq('★午前枠は当日朝5時でも取れない（3時間前より前でも）',
     isSlotOpen(morning, jstMs(2026, 10, 6, 4, 0), cfg), false);

  const late = jstMs(2026, 10, 6, 12, 0);                          // 正午＝午前ではない
  eq('正午の枠は午前扱いにしない', isSlotOpen(late, jstMs(2026, 10, 5, 23, 0), cfg), true);

  // ★GASでは 0 は「無効化」ではなく前日0時。コード.js のコメント（0で無効化）と
  //   実装が食い違っているが、挙動を変えないようWorkerも実装に合わせる。
  const zero = { leadMinutes: 180, morningUntilHour: 12, prevDeadlineHour: 0 };
  eq('★0は前日0時（無効化ではない）', isSlotOpen(morning, jstMs(2026, 10, 5, 23, 0), zero), false);

  // 午前ルールを本当に止めるには morningUntilHour を0にする（GASと同じ）
  const off = { leadMinutes: 180, morningUntilHour: 0, prevDeadlineHour: 22 };
  eq('午前ルールを止めれば3時間前だけ', isSlotOpen(morning, jstMs(2026, 10, 6, 4, 0), off), true);
  // 24以上は不正＝午前ルールを使わない（GASと同じ）
  const bad = { leadMinutes: 180, morningUntilHour: 24, prevDeadlineHour: 22 };
  eq('★24以上は午前扱いにしない（全枠が午前になるのを防ぐ）',
     isSlotOpen(jstMs(2026, 10, 6, 20, 0), jstMs(2026, 10, 6, 10, 0), bad), true);
}

console.log(`\nGAS互換層 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
