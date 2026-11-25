// 担当予約の一覧（c_trainerReservations）の顧客に担当（defaultTrainerId）を載せる（設計60）
//   実行: node worker/test/proxy-default-trainer.test.js
//
//   ★担当は customers.default_trainer_id（customer_line_map の E列 trainer_id の写し・PushToEdge）。
//     顧客の写しが古い／同期の記録が無いときは鍵ごと載せない＝画面は「分からない」として印を出さない。
//     予約一覧そのものは今までどおり答える（担当の鮮度で一覧を落とさない）。名前・ID は架空。
import * as compat from '../src/routes/compat.js';

let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) pass++; else { fail++; console.log(`❌ ${name}${detail ? '\n   ' + detail : ''}`); } }

const now = Date.now(), MIN = 60000;
function makeEnv(syncAges) {
  const seen = [];
  return {
    seen,
    DB: {
      prepare(q) {
        return {
          _args: [],
          bind(...a) { this._args = a.map(String); return this; },
          async first() {
            if (/sync_state/.test(q)) {
              const m = q.match(/key = '(\w+)'/);
              const key = m ? m[1] : this._args[0];
              const age = syncAges[key];
              return age == null ? null : { synced_at: now - age };
            }
            return null;
          },
          async all() {
            seen.push(q);
            if (/FROM reservations/.test(q)) return { results: [] };
            if (/FROM customers/.test(q)) {
              const hasCol = /default_trainer_id FROM customers/.test(q);
              return { results: [
                Object.assign({ customer_id: 'C1', name: '架空客A' }, hasCol ? { default_trainer_id: 'T3' } : {}),
                Object.assign({ customer_id: 'C2', name: '架空客B' }, hasCol ? { default_trainer_id: null } : {}),
              ] };
            }
            return { results: [] };
          },
        };
      },
    },
  };
}
const trainer = { role: 'trainer', trainerId: 'T1' };
const owner = { role: 'owner', trainerId: 'T0' };

for (const [label, who] of [['トレーナー', trainer], ['オーナー', owner]]) {
  {
    const r = await compat.compatTrainerReservations({ env: makeEnv({ reservations: 2 * MIN, customers: 5 * MIN }), who, body: {} });
    ok(`1-1 ★${label}：顧客の写しが新しければ担当を載せる`, !r._fallback && r.customers[0].defaultTrainerId === 'T3', JSON.stringify(r.customers));
    ok(`1-2 ${label}：担当なしは空文字（分からないと区別する）`, r.customers[1].defaultTrainerId === '' && 'defaultTrainerId' in r.customers[1]);
    ok(`1-3 ${label}：顧客の形は増やすだけ（customerId・name は今のまま）`, r.customers[0].customerId === 'C1' && r.customers[0].name === '架空客A');
  }
  {
    const r = await compat.compatTrainerReservations({ env: makeEnv({ reservations: 2 * MIN, customers: 45 * MIN }), who, body: {} });
    ok(`2-1 ★${label}：顧客の写しが古ければ担当の鍵ごと載せない（一覧は答える）`, !r._fallback && r.customers.length === 2 && r.customers.every((c) => !('defaultTrainerId' in c)), JSON.stringify(r));
  }
  {
    const r = await compat.compatTrainerReservations({ env: makeEnv({ reservations: 2 * MIN }), who, body: {} });
    ok(`2-2 ★${label}：顧客の同期の記録が無ければ載せない`, !r._fallback && r.customers.every((c) => !('defaultTrainerId' in c)), JSON.stringify(r.customers));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
