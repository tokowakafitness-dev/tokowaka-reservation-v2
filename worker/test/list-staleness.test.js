// 予約一覧・固定枠にも鮮度の判定があるかを固定する。
//
//   2026-09-29 に本番で見つかった穴：
//     40分の判定は残数の入口にしか無く、予約一覧・トレーナー画面・固定枠には
//     鮮度の判定が一切無かった。押し出しが止まっても古い写しを返し続けるため、
//     「取り消した予約が一覧に残る」「新しい予約が出ない」が起きる。
//
//   予約は15分ごとに押し出している。同期がN分前なら、
//   「直近N分の書き込みが写しに無い」ことしか保証できない。
//   Nが大きくなったら答えないのが正しい。
//
//   実行: node worker/test/list-staleness.test.js
import * as compat from '../src/routes/compat.js';

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log(`❌ ${name}\n   got : ${g}\n   want: ${w}`); }
}

const now = Date.now(), MIN = 60000;
const RESV = [{ reservation_id: 'r1', trainer_id: 't1', customer_id: 'c1', customer_name: 'テスト',
                start_at: now + 86400000, status: 'booked', channel: 'line', book_type: '' }];

function makeEnv(syncAges) {
  return {
    DB: {
      prepare(q) {
        return {
          _args: [],
          bind(...a) { this._args = a.map(String); return this; },
          async first() {
            if (/sync_state/.test(q)) {
              // key は '...' の直書きでも ? の束縛でも拾えるようにする
              const m = q.match(/key = '(\w+)'/);
              const key = m ? m[1] : this._args[0];
              const age = syncAges[key];
              return age == null ? null : { synced_at: now - age };
            }
            if (/FROM customers WHERE customer_id/.test(q)) return { default_trainer_id: 't1' };
            if (/member_home/.test(q)) return null;
            return null;
          },
          async all() {
            if (/FROM reservations/.test(q)) return { results: RESV };
            if (/FROM trainers/.test(q)) return { results: [{ trainer_id: 't1', name: 'T1' }] };
            if (/FROM customers/.test(q)) return { results: [{ customer_id: 'c1', name: 'テスト' }] };
            if (/recurring_patterns/.test(q)) return { results: [] };
            return { results: [] };
          },
        };
      },
    },
  };
}

const member  = { role: 'customer', customerId: 'c1' };
const trainer = { role: 'trainer', trainerId: 't1' };

// ---------- 1. 新しければ答える ----------
{
  const r = await compat.compatMyReservations({ env: makeEnv({ reservations: 2 * MIN }), who: member, body: {} });
  eq('2分前の写しなら答える', Array.isArray(r.reservations), true);
}
{
  const r = await compat.compatTrainerReservations({ env: makeEnv({ reservations: 2 * MIN }), who: trainer, body: {} });
  eq('トレーナー画面も答える', r._fallback === true, false);
}

// ---------- 2. ★古ければ答えない（GASへ落とす） ----------
{
  const r = await compat.compatMyReservations({ env: makeEnv({ reservations: 25 * MIN }), who: member, body: {} });
  eq('★25分前ならGASへ落とす', r._fallback, true);
}
{
  const r = await compat.compatTrainerReservations({ env: makeEnv({ reservations: 25 * MIN }), who: trainer, body: {} });
  eq('★トレーナー画面も25分前ならGASへ落とす', r._fallback, true);
}

// ---------- 3. ★同期の記録が無ければ答えない ----------
{
  const r = await compat.compatMyReservations({ env: makeEnv({}), who: member, body: {} });
  eq('★いつ同期したか分からなければ答えない', r._fallback, true);
}

// ---------- 4. 固定枠にも鮮度の判定がある ----------
{
  const r = await compat.compatRecurringList({ env: makeEnv({ recurring: 5 * MIN }), who: trainer, body: { customerId: 'c1' } });
  eq('固定枠：新しければ答える', r._fallback === true, false);
}
{
  const r = await compat.compatRecurringList({ env: makeEnv({ recurring: 40 * MIN }), who: trainer, body: { customerId: 'c1' } });
  eq('★固定枠：古ければGASへ落とす', r._fallback, true);
}

// ---------- 5. 古いときに中身を漏らさない ----------
{
  const r = await compat.compatMyReservations({ env: makeEnv({ reservations: 60 * MIN }), who: member, body: {} });
  eq('★落とすときは中身を返さない', Object.keys(r).filter((k) => !k.startsWith('_')).length, 0);
}

console.log(`\n一覧の鮮度 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
