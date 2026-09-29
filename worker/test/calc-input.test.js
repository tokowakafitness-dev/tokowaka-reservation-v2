// 写しから計算の入力を組み立てる部分の検証。
//
//   計算本体はGASと1文字も同じなので、ここがずれなければ答えも同じになる。
//   逆にここがずれると、同じ関数でも違う残数が出る。一番危ない箇所。
//
//   実行: node worker/test/calc-input.test.js
import { loadCalcInput, splitRemaining } from '../src/calc.js';

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else { fail++; console.log(`❌ ${name}\n   got : ${g}\n   want: ${w}`); }
}

// 契約シートの列の位置（実データに合わせた並び）
const COLS = { name: 1, type: 2, course: 5, freq: 8, ticket: 6, start: 10, end: 11,
               carry: -1, carryCap: 20, phone: 15, method: 16, trainer: 3,
               custId: -1, ticketPrice: 19, packId: -1, normalPrice: 17 };

const jst = (y, m, d, h = 12) => Date.UTC(y, m - 1, d, h - 9);

// 契約シートの1行（23列）を作る
function crow(o) {
  const r = new Array(23).fill('');
  r[COLS.name] = o.name || '山田太郎様';
  r[COLS.type] = o.type || '通常';
  r[COLS.method] = o.method || '月額';
  if (o.freq != null) r[COLS.freq] = o.freq;
  if (o.ticket != null) r[COLS.ticket] = o.ticket;
  if (o.price != null) r[COLS.ticketPrice] = o.price;
  return r;
}
// 予約台帳の1行（15列・日付欄はミリ秒）
function rrow(o) {
  const r = new Array(15).fill('');
  r[0] = o.ms; r[2] = o.cid || 'c1'; r[6] = o.status || 'confirmed';
  r[8] = o.resId || 'r1'; r[9] = o.channel || 'line'; r[11] = o.sid || '';
  r[13] = o.bookType || ''; r[14] = o.attendee == null ? '' : o.attendee;
  return r;
}

function makeEnv({ contracts = [], resv = [], opening = null, meta = true, synced = Date.now() } = {}) {
  return {
    DB: {
      prepare(q) {
        return {
          _a: null,
          bind(...a) { this._a = a; return this; },
          async first() {
            if (/calc_meta/.test(q)) return meta ? { payload: JSON.stringify({ cols: COLS, headers: [] }) } : null;
            if (/member_opening/.test(q)) return opening ? { payload: JSON.stringify(opening) } : null;
            return null;
          },
          async all() {
            if (/calc_contract_rows/.test(q)) return { results: contracts };
            if (/calc_reservation_rows/.test(q)) return { results: resv };
            if (/sync_state/.test(q)) {
              return { results: ['calcContracts', 'calcReservations', 'opening']
                .map((k) => ({ key: k, synced_at: synced })) };
            }
            return { results: [] };
          },
        };
      },
    },
  };
}

// ---------- 1. 材料が揃わなければ計算しない ----------
{
  eq('★見出しの写しが無ければ計算しない',
     (await loadCalcInput(makeEnv({ meta: false }), 'c1')).reason, 'NO_META');
  eq('★押し出しが2時間より古ければ計算しない',
     (await loadCalcInput(makeEnv({ synced: Date.now() - 3 * 3600000 }), 'c1')).reason,
     'STALE:calcContracts');
  const r = await splitRemaining(makeEnv({ meta: false }), 'c1');
  eq('★答えられないときは理由を返す（画面はGASへ落ちる）', r._unavailable, 'NO_META');
}

// ---------- 2. 月額の残数 ----------
{
  const env = makeEnv({
    contracts: [{ idx: 0, row_json: JSON.stringify(crow({ method: '月額', freq: 6 })),
                  start_ms: jst(2026, 9, 1), end_ms: jst(2027, 3, 31) }],
    resv: [
      { row_json: JSON.stringify(rrow({ ms: jst(2026, 9, 3), resId: 'a' })) },
      { row_json: JSON.stringify(rrow({ ms: jst(2026, 9, 9), resId: 'b' })) },
    ],
  });
  const r = await splitRemaining(env, 'c1', jst(2026, 9, 20));
  eq('★月6回で2回使えば残4回', [r.freq, r.monthlyRem], [6, 4]);
  eq('計算が成立している', r._ok, true);
}

// ---------- 3. 契約終了日が空欄でも継続として扱う ----------
//   実データに12件ある。列に変換していたら落ちていた分岐。
{
  const env = makeEnv({
    contracts: [{ idx: 0, row_json: JSON.stringify(crow({ method: '月額', freq: 4 })),
                  start_ms: jst(2026, 9, 1), end_ms: null }],
    resv: [],
  });
  const r = await splitRemaining(env, 'c1', jst(2026, 11, 5));
  // 9月・10月に来ていないので、繰越の上限(月4回なら1回)が乗って5回になる
  eq('★終了日が空欄なら翌々月も有効', [r.freq, r.monthlyRem], [4, 5]);
}

// ---------- 4. チケットは行順で束を見分ける ----------
//   pack_id列が無いため、契約シートの行順が識別子の一部になっている。
{
  const mk = (idx, qty, end) => ({
    idx, row_json: JSON.stringify(crow({ method: 'チケット', ticket: qty, price: 5000 })),
    start_ms: jst(2026, 9, 1), end_ms: end,
  });
  const env = makeEnv({
    contracts: [mk(0, 4, jst(2026, 10, 31)), mk(1, 8, jst(2026, 12, 31))],
    resv: [{ row_json: JSON.stringify(rrow({ ms: jst(2026, 9, 10), resId: 'a' })) }],
  });
  const r = await splitRemaining(env, 'c1', jst(2026, 9, 20));
  eq('★2つの束の合計から1回消化', [r.ticketTotal, r.ticketRem], [12, 11]);
  eq('束が2つある', r.ticketPacks.length, 2);
  eq('★先に期限が切れる束から使う', r.ticketPacks[0].remaining, 3);
}

// ---------- 5. 棚卸し（繰越の初期値）を渡す ----------
//   39名中31名がこれに依存している。渡し忘れると残数が丸ごと変わる。
{
  const contracts = [{ idx: 0, row_json: JSON.stringify(crow({ method: '月額', freq: 4 })),
                       start_ms: jst(2026, 3, 1), end_ms: jst(2027, 3, 31) }];
  const withOpening = await splitRemaining(
    makeEnv({ contracts, resv: [], opening: { carry: { '2026-09': 2 }, packsUsed: {}, cutoverMonth: '2026-09' } }),
    'c1', jst(2026, 9, 20));
  const without = await splitRemaining(makeEnv({ contracts, resv: [] }), 'c1', jst(2026, 9, 20));
  eq('★棚卸しがあると繰越2回が乗る', withOpening.avail, 6);
  eq('★棚卸しが無いと結果が変わる（渡し忘れは事故）', without.avail !== withOpening.avail, true);
}

// ---------- 6. 予約の状態の扱い ----------
{
  const contracts = [{ idx: 0, row_json: JSON.stringify(crow({ method: '月額', freq: 6 })),
                       start_ms: jst(2026, 9, 1), end_ms: jst(2027, 3, 31) }];
  const env = makeEnv({
    contracts,
    resv: [
      { row_json: JSON.stringify(rrow({ ms: jst(2026, 9, 3), resId: 'a', status: 'confirmed' })) },
      { row_json: JSON.stringify(rrow({ ms: jst(2026, 9, 4), resId: 'b', status: 'consumed' })) },
    ],
  });
  const r = await splitRemaining(env, 'c1', jst(2026, 9, 20));
  eq('★確定も当日キャンセル（消化）も1回として数える', r.monthlyRem, 4);
}

// ---------- 7. 他人の予約は数えない ----------
{
  const env = makeEnv({
    contracts: [{ idx: 0, row_json: JSON.stringify(crow({ method: '月額', freq: 6 })),
                  start_ms: jst(2026, 9, 1), end_ms: jst(2027, 3, 31) }],
    resv: [
      { row_json: JSON.stringify(rrow({ ms: jst(2026, 9, 3), resId: 'a', cid: 'c1' })) },
      { row_json: JSON.stringify(rrow({ ms: jst(2026, 9, 4), resId: 'b', cid: 'c2' })) },
    ],
  });
  const r = await splitRemaining(env, 'c1', jst(2026, 9, 20));
  eq('★他人の予約は数えない', r.monthlyRem, 5);
}

// ---------- 8. 突合のために計算結果そのものも返す ----------
{
  const env = makeEnv({
    contracts: [{ idx: 0, row_json: JSON.stringify(crow({ method: '月額', freq: 6 })),
                  start_ms: jst(2026, 9, 1), end_ms: jst(2027, 3, 31) }],
    resv: [{ row_json: JSON.stringify(rrow({ ms: jst(2026, 9, 3), resId: 'a' })) }],
  });
  const r = await splitRemaining(env, 'c1', jst(2026, 9, 20));
  // 突合では、この丸ごとをGASの結果と突き合わせる。
  //   残数が同じでも「月額から引いたのかチケットから引いたのか」が違えば、
  //   monthlyRem と ticketPacks の残が食い違うので検出できる。
  eq('★計算結果を丸ごと返す（突合に使う）',
     ['ok', 'issues', 'hasMonthly', 'hasTicket', 'monthlyRem', 'ticketTotal', 'ticketRem',
      'ticketPacks', 'ticketRemPair', 'ticketRemNormal', 'pairPackMax', 'freq', 'avail']
       .every((k) => k in r._raw), true);
  eq('束ごとの残も入っている', Array.isArray(r._raw.ticketPacks), true);
  eq('問題があれば理由が入る', Array.isArray(r._raw.issues), true);
}

// ---------- 9. 消化先が違えば検出できる ----------
//   残数の合計が同じでも、月額から引いたのかチケットから引いたのかが違えば、
//   内訳が食い違う。突合はこの内訳まで見る。
{
  const contracts = [
    { idx: 0, row_json: JSON.stringify(crow({ method: '月額', freq: 2 })),
      start_ms: jst(2026, 9, 1), end_ms: jst(2027, 3, 31) },
    { idx: 1, row_json: JSON.stringify(crow({ method: 'チケット', ticket: 3, price: 5000 })),
      start_ms: jst(2026, 9, 1), end_ms: jst(2026, 12, 31) },
  ];
  const env = makeEnv({
    contracts,
    resv: [{ row_json: JSON.stringify(rrow({ ms: jst(2026, 9, 10), resId: 'a' })) }],
  });
  const r = await splitRemaining(env, 'c1', jst(2026, 9, 20));
  const total = (r.monthlyRem || 0) + (r.ticketRem || 0);
  eq('合計は4回', total, 4);
  eq('★内訳まで分かる（どちらから引いたかが見える）',
     [r.monthlyRem, r.ticketRem], [1, 3]);
}

console.log(`\n計算の入力の組み立て 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
