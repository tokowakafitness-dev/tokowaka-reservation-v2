// 残数の月選び。ここを間違えると「予約できるのにできないと言う」「取れないのに取れると言う」
// のどちらかが起きる。25日以降は9月の残数と10月の残数が別物になるため、境目を機械で固定する。
//   実行: node worker/test/home-month.test.js
import { readHome } from '../src/routes/boot.js';

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else { fail++; console.log(`❌ ${name}\n   got : ${g}\n   want: ${w}`); }
}

// 9月＝月6回・残1／10月＝月6回・残6 を持っている会員
const payload = JSON.stringify({
  currentMonth: '2026-09',
  nextMonth: '2026-10',
  current: { type: 'monthly', quota: 6, monthlyRemaining: 1, carryover: 0 },
  next:    { type: 'monthly', quota: 6, monthlyRemaining: 6, carryover: 1 },
});

function envWith(p, computedAt = Date.now()) {
  return {
    DB: {
      prepare() {
        return { bind() { return this; }, async first() { return p ? { payload: p, computed_at: computedAt } : null; } };
      },
    },
  };
}
// JSTの日時をミリ秒で
const jst = (y, m, d, h = 12) => Date.UTC(y, m - 1, d, h - 9);

// ---------- 1. 日時を渡さなければ今月 ----------
{
  const h = await readHome(envWith(payload), 'c1');
  eq('日時なしは今月の残数', [h.month, h.monthlyRemaining], ['2026-09', 1]);
}

// ---------- 2. 9月の予約は9月の残数 ----------
{
  const h = await readHome(envWith(payload), 'c1', jst(2026, 9, 28));
  eq('★9月28日の予約は9月の残数（1回）', [h.month, h.monthlyRemaining], ['2026-09', 1]);
}

// ---------- 3. 10月の予約は10月の残数 ----------
{
  const h = await readHome(envWith(payload), 'c1', jst(2026, 10, 5));
  eq('★10月5日の予約は10月の残数（6回）', [h.month, h.monthlyRemaining], ['2026-10', 6]);
  eq('★繰越も10月のものを返す', h.carryover, 1);
}

// ---------- 4. 月の境目（JSTで判定する）----------
{
  // 9/30 23:00 JST は9月。UTCだと9/30 14:00 で同じ日だが、時差で取り違えないこと
  const h1 = await readHome(envWith(payload), 'c1', jst(2026, 9, 30, 23));
  eq('★9/30 23時はまだ9月', h1.month, '2026-09');
  // 10/1 00:30 JST は10月。UTCだと9/30 15:30 なので、UTCで見ると9月に見えてしまう
  const h2 = await readHome(envWith(payload), 'c1', jst(2026, 10, 1, 0.5));
  eq('★10/1 0時半はもう10月（UTCで見ると9月に見える）', h2.month, '2026-10');
}

// ---------- 5. 持っていない月は答えない ----------
{
  const h = await readHome(envWith(payload), 'c1', jst(2026, 11, 5));
  eq('★翌々月は答えない（間違った残数を返さない）', h, null);
}

// ---------- 6. 翌月分が作れていなければ答えない ----------
{
  const p2 = JSON.stringify({
    currentMonth: '2026-09', nextMonth: '2026-10',
    current: { type: 'monthly', quota: 6, monthlyRemaining: 1 }, next: null,
  });
  const h = await readHome(envWith(p2), 'c1', jst(2026, 10, 5));
  eq('★翌月分が無ければ答えない', h, null);
  const h0 = await readHome(envWith(p2), 'c1');
  eq('今月分は返せる', h0.monthlyRemaining, 1);
}

// ---------- 7. 写しが無い・壊れている ----------
{
  eq('★写しが無ければ答えない', await readHome(envWith(null), 'c1'), null);
  eq('★壊れていれば答えない', await readHome(envWith('{壊れ'), 'c1'), null);
  eq('顧客IDが無ければ答えない', await readHome(envWith(payload), ''), null);
}

// ---------- 8. 古さを伝える ----------
{
  const fresh = await readHome(envWith(payload, Date.now() - 60 * 1000), 'c1');
  eq('1分前は新しい', fresh.stale, false);
  const old = await readHome(envWith(payload, Date.now() - 30 * 60 * 1000), 'c1');
  eq('★30分前は古いと伝える', old.stale, true);
}

console.log(`\n残数の月選び 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
