// 予約画面の「次の週へ」で、予約できる最終日（25日以降は翌月末）の週まで進めるかを確かめる。
//   実行: node worker/test/liff-week-horizon.test.js
//
// ★なぜ要るのか（2026-10-31）
//   10/31（土）に見ると 11/22〜11/28 の週で止まり、11/29・11/30 が表示できなかった。
//   週は日曜始まりなのに、上限を「今日から何週」で数えていた（30日÷7＝4 → 今週の日曜から4週先＝11/22の週）。
//   GAS 側の期間（_lbBookingHorizonEnd）は 11/30 まで枠を作っていた＝画面だけが届かなかった。
//
//   ① 本番の HTML から maxWeekOffset と nextWeek の処理を取り出し、2026〜2028年の毎日で
//      「最終日を含む週まで進める」「その次の週へは進めない」
//   ② 10/31（土）の実例：11/29〜12/5 の週へ進める
//   ③ 期間は GAS の _lbBookingHorizonEnd と同じ最終日
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

process.env.TZ = 'Asia/Tokyo';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HTML = readFileSync(join(ROOT, 'liff/index.html'), 'utf8');
const LB = readFileSync(join(ROOT, 'gas/LineBooking.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, why) { if (cond) pass++; else { fail++; if (fail <= 10) { console.log(`❌ ${name}`); if (why) console.log(`   ${why}`); } } }

const fnSrc = HTML.match(/function maxWeekOffset\(now\)\{[\s\S]*?\n  \}/);
const handlerSrc = HTML.match(/on\('nextWeek', function\(\)\{[\s\S]*?\n  \}\);/);
const gasHz = LB.match(/function _lbBookingHorizonEnd\(now\) \{[\s\S]*?\n\}/);
ok('取り出し：maxWeekOffset', !!fnSrc);
ok('取り出し：nextWeek の処理', !!handlerSrc);
ok('取り出し：GAS _lbBookingHorizonEnd', !!gasHz);

// 「今日」を差し替えて、nextWeek を押せなくなるまで押し続ける＝画面で届く最後の週
function reachable(nowMs) {
  const handlers = {};
  const state = { weekOffset: 0 };
  class FakeDate extends Date { constructor(...a) { if (a.length === 0) super(nowMs); else super(...a); } static now() { return nowMs; } }
  const ctx = { Math, state, Date: FakeDate, renderWeek: () => {}, on: (id, fn) => { handlers[id] = fn; } };
  vm.createContext(ctx);
  vm.runInContext(fnSrc[0] + '\n' + handlerSrc[0] + '\n' + gasHz[0], ctx);
  for (let i = 0; i < 20; i++) handlers.nextWeek();
  // renderWeek と同じ計算で、届いた週の日曜〜土曜
  const base = new Date(nowMs); base.setHours(0, 0, 0, 0);
  base.setDate(base.getDate() - base.getDay() + state.weekOffset * 7);
  const last = new Date(base); last.setDate(base.getDate() + 6); last.setHours(23, 59, 59);
  return { first: base, last, hz: vm.runInContext('_lbBookingHorizonEnd(new Date(' + nowMs + '))', ctx) };
}

if (fnSrc && handlerSrc && gasHz) {
  console.log('=== ① 2026〜2028年の毎日 ===');
  for (let t = new Date(2026, 0, 1, 10).getTime(); t < new Date(2029, 0, 1).getTime(); t += 86400000) {
    const r = reachable(t);
    const label = new Date(t).toISOString().slice(0, 10);
    ok(`①-a ${label} 最終日の週まで届く`, r.last.getTime() >= r.hz.getTime(), `届く週 ${r.first.toDateString()}〜${r.last.toDateString()} / 最終日 ${r.hz.toDateString()}`);
    ok(`①-b ${label} その先の週へは進まない`, r.first.getTime() <= r.hz.getTime(), `届く週 ${r.first.toDateString()} / 最終日 ${r.hz.toDateString()}`);
  }

  console.log('=== ② 10/31（土）の実例 ===');
  const r = reachable(new Date(2026, 9, 31, 10).getTime());
  ok('②-1 ★11/29〜12/5 の週へ進める', r.first.getMonth() === 10 && r.first.getDate() === 29, r.first.toDateString());
  const r2 = reachable(new Date(2026, 9, 24, 10).getTime());
  ok('②-2 10/24（25日前）は10月末を含む週まで', r2.first.getMonth() === 9 && r2.first.getDate() === 25, r2.first.toDateString());
}

console.log((fail === 0 ? '✅ ' : '⚠️ ') + `予約画面の週送りの上限 検証: ${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
