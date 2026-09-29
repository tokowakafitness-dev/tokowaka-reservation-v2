// 照合専用の入口の検証。
//   ここは合言葉で守られた内部用。時計や既定値の違いを「実装の差」に見せないため、
//   nowKey・繰越率・時点はGASから受け取り、こちらでは決めない。
//   実行: node worker/test/verify-endpoint.test.js
import { handleCalc } from '../src/routes/verify.js';

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else { fail++; console.log(`❌ ${name}\n   got : ${g}\n   want: ${w}`); }
}
const COLS = { name: 1, type: 2, course: 5, freq: 8, ticket: 6, start: 10, end: 11,
               carry: -1, carryCap: 20, phone: 15, method: 16, trainer: 3,
               custId: -1, ticketPrice: 19, packId: -1, normalPrice: 17 };
const jst = (y, m, d, h = 12) => Date.UTC(y, m - 1, d, h - 9);
function crow(o) {
  const r = new Array(23).fill('');
  r[COLS.name] = '山田太郎様'; r[COLS.type] = '通常'; r[COLS.method] = o.method || '月額';
  if (o.freq != null) r[COLS.freq] = o.freq;
  return r;
}
function env(opts = {}) {
  const contracts = opts.contracts || [{ idx: 0, row_json: JSON.stringify(crow({ method: '月額', freq: 6 })),
    start_ms: jst(2026, 9, 1), end_ms: jst(2027, 3, 31) }];
  return {
    SHARED_SECRET: 'S',
    DB: { prepare(q) { return {
      bind() { return this; },
      async first() {
        if (/calc_meta/.test(q)) return { payload: JSON.stringify({ cols: COLS, headers: [] }) };
        return null;
      },
      async all() {
        if (/calc_contract_rows/.test(q)) return { results: contracts };
        if (/calc_reservation_rows/.test(q)) return { results: [] };
        if (/sync_state/.test(q)) return { results: ['calcContracts', 'calcReservations', 'opening']
          .map((k) => ({ key: k, synced_at: Date.now() })) };
        return { results: [] };
      },
    }; } },
  };
}
const req = (body, secret) => new Request('https://x/calc', {
  method: 'POST',
  headers: secret === undefined ? { 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json', 'X-Ingest-Secret': secret },
  body: JSON.stringify(body),
});
const j = async (r) => [r.status, await r.json()];
const OK = { customerId: 'c1', times: [jst(2026, 9, 20)], nowKey: '2026-09', carryRate: 1 / 3 };

// ---------- 1. 合言葉 ----------
eq('★合言葉なしは通らない', (await j(await handleCalc(req(OK), env())))[0], 403);
eq('★違う合言葉は通らない', (await j(await handleCalc(req(OK, 'X'), env())))[0], 403);
eq('正しければ通る', (await j(await handleCalc(req(OK, 'S'), env())))[0], 200);

// ---------- 2. 判断材料はGASから受け取る（こちらで決めない）----------
{
  const [, b1] = await j(await handleCalc(req({ ...OK, nowKey: '' }, 'S'), env()));
  eq('★今の月を渡さなければ計算しない', b1.code, 'BAD_NOW_KEY');
  const [, b2] = await j(await handleCalc(req({ ...OK, carryRate: 0 }, 'S'), env()));
  eq('★繰越率を渡さなければ計算しない', b2.code, 'BAD_CARRY_RATE');
  const [, b3] = await j(await handleCalc(req({ ...OK, times: [] }, 'S'), env()));
  eq('★時点を渡さなければ計算しない', b3.code, 'NO_TIMES');
  const [, b4] = await j(await handleCalc(req({ ...OK, customerId: '' }, 'S'), env()));
  eq('顧客を渡さなければ計算しない', b4.code, 'NO_CUSTOMER');
}

// ---------- 3. 材料が揃っているかも返す（入力のずれを先に検出するため）----------
{
  const [, b] = await j(await handleCalc(req({ ...OK, times: [jst(2026, 9, 20), jst(2026, 10, 20)] }, 'S'), env()));
  eq('★契約の行数を返す', b.contractRows, 1);
  eq('★予約の件数を返す', b.sessions, 0);
  eq('★棚卸しの有無を返す', b.hasOpening, false);
  eq('★時点の数だけ結果を返す', b.results.length, 2);
  eq('計算が成立している', b.results[0].ok, true);
  eq('9月は月6回', b.results[0].monthlyRem, 6);
}

// ---------- 4. 一度に多すぎる時点は受けない ----------
{
  const many = Array.from({ length: 100 }, (_, i) => jst(2026, 9, 1) + i * 86400000);
  const [, b] = await j(await handleCalc(req({ ...OK, times: many }, 'S'), env()));
  eq('★上限で打ち切る', b.results.length, 40);
}

console.log(`\n照合の入口 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
