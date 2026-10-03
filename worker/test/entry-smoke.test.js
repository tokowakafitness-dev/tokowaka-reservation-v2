// すべての入口を、正常系で実際に呼ぶ。
//
//   2026-09-29：compatTrainerSlots が正常系で必ず ReferenceError になる状態で
//   本番へ出しかけた。鮮度の変数名を直したときに return 行を直し忘れたためだが、
//   既存テストはこの関数を一度も呼んでおらず（中の isSlotOpen しか見ていない）、
//   13本すべて緑のまま通り抜けた。
//
//   個々の規則を細かく試す前に、「そもそも呼べるか」を全部の入口で確かめる。
//   ここが薄いと、どれだけ細かいテストを足しても意味がない。
//
//   実行: node worker/test/entry-smoke.test.js
import * as compat from '../src/routes/compat.js';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) pass++;
  else { fail++; console.log(`❌ ${name}${extra ? '\n   ' + extra : ''}`); }
}

const now = Date.now();
const HOME = JSON.stringify({
  currentMonth: '2026-09', nextMonth: '2026-10',
  current: { type: 'monthly', quota: 6, monthlyRemaining: 3, ticketPacks: [], pairRemaining: 1 },
  next:    { type: 'monthly', quota: 6, monthlyRemaining: 6, ticketPacks: [] },
});
const SLOTS = JSON.stringify({
  rules: { leadMinutes: 180, morningUntilHour: 12, prevDeadlineHour: 22 },
  slots: [{
    startMs: now + 3 * 86400000, date: '2026-10-02', dayOfWeek: '金',
    startTime: '10:00', endTime: '11:00',
    startISO: new Date(now + 3 * 86400000).toISOString(),
    endISO: new Date(now + 3 * 86400000 + 3600000).toISOString(),
    trainerName: '鈴木', trainerId: 't1', trialOk: true,
  }],
});

function env() {
  return {
    DB: {
      prepare(q) {
        return {
          _a: [],
          bind(...a) { this._a = a.map(String); return this; },
          async first() {
            if (/sync_state/.test(q)) return { synced_at: now - 60000 };
            if (/FROM customers WHERE customer_id/.test(q) && /default_trainer_id/.test(q)) return { default_trainer_id: 't1' };
            if (/SELECT name FROM customers/.test(q)) return { name: '山田 太郎' };
            if (/member_home/.test(q)) return { payload: HOME, computed_at: now - 60000 };
            if (/slots_cache/.test(q)) return { payload: SLOTS, computed_at: now - 60000 };
            return null;
          },
          async all() {
            if (/FROM trainers/.test(q)) return { results: [{ trainer_id: 't1', name: '鈴木', name_en: 'Suzuki', active: 1, hidden: 0, id: 't1' }] };
            if (/FROM reservations/.test(q)) return { results: [{
              reservation_id: 'r1', customer_id: 'c1', customer_name: '山田 太郎', trainer_id: 't1',
              start_at: now + 86400000, status: 'booked', channel: 'line', book_type: '通常',
            }] };
            if (/FROM customers/.test(q)) return { results: [{ customer_id: 'c1', name: '山田 太郎' }] };
            if (/recurring_patterns/.test(q)) return { results: [{ pattern_id: 'p1', customer_id: 'c1', trainer_id: 't1', weekday: 1, time: '10:00' }] };
            return { results: [] };
          },
        };
      },
    },
  };
}

const member  = { role: 'customer', customerId: 'c1', lineUserId: 'U1' };
const trainer = { role: 'trainer',  trainerId: 't1' };
const owner   = { role: 'owner',    trainerId: 't9' };

// 入口 → 正常系の呼び方。★新しい入口を足したらここにも足すこと。
const CALLS = [
  ['compatTrainers',            { who: member,  body: {} }],
  ['compatTrainerSlots',        { who: member,  body: { trainerId: 't1' } }],
  ['compatTrainerSlots(変更時)', { who: member,  body: { trainerId: 't1', excludeStartISO: new Date(now + 3 * 86400000).toISOString() } }, 'compatTrainerSlots'],
  ['compatCustomerHome',        { who: member,  body: { customerId: 'c1' } }],
  ['compatBookingOptions',      { who: member,  body: { customerId: 'c1', startISO: new Date(now + 86400000).toISOString() } }],
  ['compatMyReservations',      { who: member,  body: {} }],
  ['compatTrainerReservations', { who: trainer, body: {} }],
  ['compatTrainerReservations(オーナー)', { who: owner, body: {} }, 'compatTrainerReservations'],
  ['compatRecurringList',       { who: trainer, body: { customerId: 'c1' } }],
  ['compatMemberStatus',        { who: member,  body: {} }],
  // まとめ取得（2026-10-03）。会員とトレーナーで中身が分かれるので両方通す。
  ['compatBoot(会員)',           { who: member,  body: {} }, 'compatBoot'],
  ['compatBoot(トレーナー)',      { who: trainer, body: {} }, 'compatBoot'],
  ['compatCustomerCard',        { who: trainer, body: { customerId: 'c1' } }],
];

for (const [label, args, realName] of CALLS) {
  const fn = compat[realName || label];
  if (typeof fn !== 'function') { ok(`${label} が存在する`, false); continue; }
  let r, err = null;
  try { r = await fn({ env: env(), ...args }); } catch (e) { err = e; }
  ok(`★${label} が例外を出さずに返る`, !err, err && (err.message + '\n   ' + String(err.stack).split('\n')[1]));
  if (err) continue;
  ok(`${label} が何かを返す`, r && typeof r === 'object');
  // 正常系なので、写しが無い・古いを理由に落ちていないこと
  ok(`★${label} が正常系でGASへ落ちない`, r && r._fallback !== true,
     r && r._fallback ? '（_fallback: true が返った）' : '');
  ok(`${label} が拒否されない`, r && r._forbidden !== true);
}

// 入口の数え漏れを防ぐ（export と この表を突き合わせる）
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/routes/compat.js', import.meta.url), 'utf8');
  const exported = [...src.matchAll(/export async function (compat\w+)\(/g)].map((m) => m[1]).sort();
  const covered = [...new Set(CALLS.map(([l, , r]) => r || l))].sort();
  ok('★すべての入口がこの表に載っている', JSON.stringify(exported) === JSON.stringify(covered),
     `export: ${exported.join(',')}\n   表  : ${covered.join(',')}`);
}

console.log(`\n入口の素通し 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
