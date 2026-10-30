// 予約画面の「次の週へ」で、予約できる最終日（25日以降は翌月末）の週まで進めるかを確かめる。
//   実行: node worker/test/liff-week-horizon.test.js
//
// ★なぜ要るのか（2026-10-31）
//   10/31（土）に見ると 11/22〜11/28 の週で止まり、11/29・11/30 が表示できなかった。
//   週は日曜始まりなのに、上限を「今日から何週」で数えていた（30日÷7＝4 → 今週の日曜から4週先＝11/22の週）。
//   GAS 側の期間（_lbBookingHorizonEnd）は 11/30 まで枠を作っていた＝画面だけが届かなかった。
//
//   ★2026-10-31 オーナー：最終日より先も表示してよい・予約はできないこと → 表示は最終日の翌月末まで、先の日は灰色で押せない
//
//   ① 本番の HTML から bookingHorizon・maxWeekOffset・nextWeek を取り出し、2026〜2028年の毎日で
//      「最終日の翌月末を含む週まで進める」「その次の週へは進めない」「最終日は GAS _lbBookingHorizonEnd と同じ日」
//   ② 10/31（土）の実例：12/27〜1/2 の週まで進める
//   ③ 描画（renderWeek を本物のまま動かす）：最終日より先の日は灰色・○にならない（枠が届いても）・案内文の日付
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

const hzSrc = HTML.match(/function bookingHorizon\(now\)\{[\s\S]*?\n  \}/);
const fnSrc0 = HTML.match(/function maxWeekOffset\(now\)\{[\s\S]*?\n  \}/);
const fnSrc = (hzSrc && fnSrc0) ? [hzSrc[0] + '\n' + fnSrc0[0]] : null;
const renderSrc = HTML.match(/function renderWeek\(\)\{[\s\S]*?\n  \}\n/);
ok('取り出し：renderWeek', !!renderSrc);
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
  const hz = vm.runInContext('_lbBookingHorizonEnd(new Date(' + nowMs + '))', ctx);
  const liffHz = vm.runInContext('bookingHorizon(new Date(' + nowMs + '))', ctx);
  return { first: base, last, hz, liffHz, viewEnd: new Date(hz.getFullYear(), hz.getMonth() + 2, 0, 23, 59, 59) };
}

if (fnSrc && handlerSrc && gasHz) {
  console.log('=== ① 2026〜2028年の毎日 ===');
  for (let t = new Date(2026, 0, 1, 10).getTime(); t < new Date(2029, 0, 1).getTime(); t += 86400000) {
    const r = reachable(t);
    const label = new Date(t).toISOString().slice(0, 10);
    ok(`①-a ${label} 最終日の翌月末の週まで届く`, r.last.getTime() >= r.viewEnd.getTime(), `届く週 ${r.first.toDateString()}〜${r.last.toDateString()} / 表示の端 ${r.viewEnd.toDateString()}`);
    ok(`①-b ${label} その先の週へは進まない`, r.first.getTime() <= r.viewEnd.getTime(), `届く週 ${r.first.toDateString()} / 表示の端 ${r.viewEnd.toDateString()}`);
    ok(`①-c ${label} 最終日が GAS と同じ日`, r.liffHz.toDateString() === r.hz.toDateString(), `${r.liffHz.toDateString()} / ${r.hz.toDateString()}`);
  }

  console.log('=== ② 10/31（土）の実例 ===');
  const r = reachable(new Date(2026, 9, 31, 10).getTime());
  ok('②-1 ★12/27〜1/2 の週まで進める', r.first.getMonth() === 11 && r.first.getDate() === 27, r.first.toDateString());
  const r2 = reachable(new Date(2026, 9, 24, 10).getTime());
  ok('②-2 10/24（25日前）は11月末を含む週まで', r2.first.getMonth() === 10 && r2.first.getDate() === 29, r2.first.toDateString());
}

// renderWeek を本物のまま動かす（表は文字列で受け取る）
function render(nowMs, weekOffset, slots) {
  const wrap = { innerHTML: '', querySelectorAll: () => [] };
  const els = { gridWrap: wrap, weekLabel: { textContent: '' } };
  class FakeDate extends Date { constructor(...a) { if (a.length === 0) super(nowMs); else super(...a); } static now() { return nowMs; } }
  const ctx = {
    Math, String, Object, parseInt, Date: FakeDate,
    state: { weekOffset, slots, batchMode: false, batchSel: {} },
    document: { getElementById: (id) => els[id] },
    BUSINESS_START: 7, BUSINESS_END: 24,
    t: (k, v) => k + JSON.stringify(v || {}),
    mdLabel: (d) => (d.getMonth() + 1) + '/' + d.getDate(),
    dow: (i) => '日月火水木金土'[i],
    fmtDate: (d) => d.getFullYear() + '/' + ('0' + (d.getMonth() + 1)).slice(-2) + '/' + ('0' + d.getDate()).slice(-2),
  };
  vm.createContext(ctx);
  vm.runInContext(hzSrc[0] + '\n' + renderSrc[0], ctx);
  ctx.renderWeek();
  return wrap.innerHTML;
}

if (hzSrc && renderSrc) {
  console.log('=== ③ 描画 ===');
  const NOW = new Date(2026, 9, 31, 10).getTime();   // 10/31（土）・最終日 11/30
  //   11/30（予約できる）と 12/1（まだ）に枠があることにする＝12/1 は万一届いた枠
  const slots = [
    { date: '2026/11/30', startTime: '10:00', startISO: '2026-11-30T10:00:00+09:00' },
    { date: '2026/12/01', startTime: '10:00', startISO: '2026-12-01T10:00:00+09:00' },
  ];
  const h = render(NOW, 5, slots);   // 11/29〜12/5 の週
  ok('③-1 ★11/30 の枠は ○（押せる）', h.includes('data-key="2026/11/30#10"'), h.slice(0, 300));
  ok('③-2 ★12/1 の枠は ○ にならない（押せない）', !h.includes('data-key="2026/12/01#10"'));
  const ths = h.match(/<th[^>]*>[^<]*<br>/g) || [];
  ok('③-3 見出し：11/29・11/30 は灰色でない、12/1〜12/5 は灰色', ths.length === 7
    && !/cell-closed/.test(ths[0]) && !/cell-closed/.test(ths[1]) && ths.slice(2).every((x) => /cell-closed/.test(x)), JSON.stringify(ths));
  ok('③-4 案内文：12/1以降は11/25から', /week_not_open\{"date":"12\/1","open":"11\/25"\}/.test(h), (h.match(/week_not_open[^<]*/) || [''])[0]);
  const h0 = render(NOW, 0, slots);   // 今週
  ok('③-5 灰色の日が無い週は案内文を出さない', !h0.includes('week_not_open') && !h0.includes('cell-closed'));
  const h9 = render(NOW, 9, []);     // 12/27〜1/2 の週
  ok('③-6 その先の週も全部灰色', (h9.match(/class="cell-open"/g) || []).length === 0 && /week_not_open/.test(h9));
  const hb = render(new Date(2026, 9, 20, 10).getTime(), 2, [{ date: '2026/11/02', startTime: '10:00', startISO: 'x' }]);   // 10/20・最終日 10/31・11/1〜11/7 の週
  ok('③-7 ★25日前（10/20）は11月が灰色・11/1以降は10/25から', !hb.includes('cell-open') && /"date":"11\/1","open":"10\/25"/.test(hb), (hb.match(/week_not_open[^<]*/) || [''])[0]);
}

console.log((fail === 0 ? '✅ ' : '⚠️ ') + `予約画面の週送りの上限 検証: ${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
