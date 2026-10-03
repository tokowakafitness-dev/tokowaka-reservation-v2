// 残数の月選び。ここを間違えると「予約できるのにできないと言う」「取れないのに取れると言う」
// のどちらかが起きる。25日以降は9月の残数と10月の残数が別物になるため、境目を機械で固定する。
//   実行: node worker/test/home-month.test.js
import { readHome } from '../src/routes/boot.js';
import { homePayload } from './_home-fixture.js';

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else { fail++; console.log(`❌ ${name}\n   got : ${g}\n   want: ${w}`); }
}

// 9月＝月6回・残1／10月＝月6回・残6 を持っている会員
const payload = homePayload({
  current: { monthlyRemaining: 1, carryover: 0 },
  next:    { monthlyRemaining: 6, carryover: 1 },
});

// syncedAt を省くと computedAt と同じ扱い（＝押し出し直後）
function envWith(p, computedAt = Date.now(), syncedAt) {
  return {
    DB: {
      prepare(q) {
        const isSync = /sync_state/.test(q);
        return {
          bind() { return this; },
          async first() {
            if (isSync) return { synced_at: syncedAt === undefined ? computedAt : syncedAt };
            return p ? { payload: p, computed_at: computedAt } : null;
          },
        };
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
    current: { type: 'monthly', quota: 6, monthlyRemaining: 1, active: true, carryover: 0,
               thisMonth: 0, ticketTotal: 0, ticketRemaining: 0, pairRemaining: 0, pairPackMax: 0,
               normalTicketRemaining: 0, hasNormalRoute: true, ticketPacks: [], remaining: 1 }, next: null,
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

// ---------- 9. 鮮度は「その行がいつ計算されたか」で見る ----------
//   ★2026-09-29 に方針を反転させた。
//     もとは「中身が変わらない行は書き直さないので、全体の押し出し時刻で見る」としていたが、
//     押し出しは6分で打ち切られ、計算に失敗した会員は飛ばされる。
//     全体の時刻で見ると、届かなかった会員の古い行まで「たった今の情報」に若返り、
//     40分の安全弁が働かなかった（本番で見つかった穴）。
//     いまは押し出しのたびに全員ぶんの computed_at を書き直している（39行）。
{
  const rowOld = Date.now() - 6 * 60 * 60 * 1000;      // この会員の行は6時間前
  const pushedJustNow = Date.now() - 30 * 1000;        // 全体の押し出しは30秒前
  const h = await readHome(envWith(payload, rowOld, pushedJustNow), 'c1');
  eq('★行が古ければ、全体が新しくても古いと判断する', h.stale, true);
  eq('★返す時刻はその行の時刻', h.computedAt, rowOld);
}
{
  // 押し出しが止まっていれば、当然ながら古いと判断する
  const stopped = Date.now() - 3 * 60 * 60 * 1000;
  const h = await readHome(envWith(payload, stopped, stopped), 'c1');
  eq('★押し出しが止まっていれば古いと判断する', h.stale, true);
}
{
  // 行が新しければ答える（誤検知で毎回GASへ落ちないこと）
  const fresh = Date.now() - 60 * 1000;
  const h = await readHome(envWith(payload, fresh, fresh), 'c1');
  eq('★行が新しければ新しい扱い', h.stale, false);
}

console.log(`\n残数の月選び 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
