// 契約から「枠」を作る処理の検証
//
//   設計：ops/design/04-booking-to-d1.md 第3版 第3節
//
//   ★なぜ要るのか
//     D1で残数を守るには、まず「枠」が行として存在していなければならない。
//     引当のINSERTは `WHERE EXISTS (SELECT 1 FROM monthly_quota ...)` で親を見るので、
//     枠の行が無い月は**どんな予約も作れない**（fail-closed）。
//     逆に、枠の大きさを間違えると**残数そのものが狂う**。
//
//   ★ここで確かめたいこと
//     ① 既存の計算（allocate.js）の結果をそのまま読み替えていること。計算し直していないこと
//     ② used を書かないこと（使った数を動かすのはトリガーだけ、という不変条件）
//     ③ 計算が「要確認」のときは枠を作らないこと（壊れた枠から壊れた残数が生まれる）
//
//   実行: node worker/test/quota-build.test.js

import { buildQuotaForCustomer, quotaUpsertStatements, nextMonthKey, inRange } from '../src/lib/quota-build.js';

let pass = 0, fail = 0;
function ok(name, cond, extra) { cond ? pass++ : (fail++, console.log(`❌ ${name}${extra ? '\n   ' + extra : ''}`)); }
function eq(name, got, want) { ok(name, String(got) === String(want), `期待=${want} 実際=${got}`); }

// ---------- 題材（remaining-at.test.js と同じ作り・実在の会員#2412 の形） ----------
const COLS = { name: 1, type: 2, course: -1, freq: 8, ticket: 6, start: 10, end: 11,
               carry: -1, carryCap: -1, phone: 15, method: 16, trainer: 3,
               custId: -1, ticketPrice: -1, packId: -1, normalPrice: -1 };

function crow({ method, type = '通常', freq, ticket }) {
  const r = new Array(23).fill('');
  r[COLS.name] = '◯◯ ◯◯様';
  r[COLS.type] = type;
  r[COLS.method] = method;
  if (freq != null) r[COLS.freq] = freq;
  if (ticket != null) r[COLS.ticket] = ticket;
  return r;
}
const jst = (y, m, d, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h - 9, mi);

//   契約：月額8回（2026/05/01〜2026/11/01）＋ チケット3枚（2026/09/15〜2026/12/15）
const CONTRACTS = [
  { row: crow({ method: '月額', freq: 8 }), cols: COLS,
    start: new Date(jst(2026, 5, 1)), end: new Date(jst(2026, 11, 1)), idx: 0 },
  { row: crow({ method: 'チケット', type: 'チケット', ticket: 3 }), cols: COLS,
    start: new Date(jst(2026, 9, 15)), end: new Date(jst(2026, 12, 15)), idx: 1 },
];

function ses(id, startMs) {
  return { sessionId: id, resId: id, startAt: startMs, channel: 'line',
    attendeeCount: 1, packKind: 'normal', consumptionMode: '', bookType: '', createdAt: startMs };
}

const OPTS = {
  fromMonth: '2026-09', toMonth: '2026-11',
  nowKey: '2026-10', targetDateMs: jst(2026, 10, 15, 12), carryRate: 0.5,
};

// ============================================================
console.log('=== 1. 月額の枠が、計算の結果どおりに作られる ===');
{
  const b = buildQuotaForCustomer('C1', CONTRACTS, [], null, OPTS);
  eq('①問題なく作れる（issues なし）', b.issues.length, 0);
  ok('①月額の枠が月ごとに並ぶ', b.monthly.length >= 2, `実際=${b.monthly.length}件`);

  const oct = b.monthly.find((m) => m.monthKey === '2026-10');
  ok('①10月の枠がある', !!oct);
  // ★枠は「頻度＋繰越」。予約が0件だと毎月使い切らないので繰越が発生する。
  //   頻度8・繰越上限2 → 10月の枠は10。「頻度＝枠」ではない。
  if (oct) eq('①10月の枠は10（頻度8＋繰越2）', oct.quota, 10);
  ok('①会員IDが入る', b.monthly.every((m) => m.customerId === 'C1'));
}

console.log('=== 2. 対象の範囲だけを切り出す ===');
{
  const b = buildQuotaForCustomer('C1', CONTRACTS, [], null,
    { ...OPTS, fromMonth: '2026-10', toMonth: '2026-10' });
  eq('②1か月ぶんだけ', b.monthly.length, 1);
  eq('②その月', b.monthly[0].monthKey, '2026-10');
}

console.log('=== 3. チケットの枠（買った単位がそのまま1行） ===');
{
  const b = buildQuotaForCustomer('C1', CONTRACTS, [], null, OPTS);
  eq('③チケットが1組', b.packs.length, 1);
  const p = b.packs[0];
  eq('③枚数は契約のまま', p.total, 3);
  eq('③種類は通常', p.kind, 'normal');
  ok('③期限が入る', p.validTo > jst(2026, 12, 14), `validTo=${p.validTo}`);
  ok('③開始が入る', p.validFrom >= jst(2026, 9, 14), `validFrom=${p.validFrom}`);
}

console.log('=== 4. ★used を書かない（枠を動かすのはトリガーだけ） ===');
{
  const b = buildQuotaForCustomer('C1', CONTRACTS, [], null, OPTS);
  const stmts = quotaUpsertStatements(b, 1000);
  ok('④文が組み立てられる', stmts.length > 0);

  const monthlySql = stmts.find((s) => s.sql.includes('monthly_quota')).sql;
  const packSql = stmts.find((s) => s.sql.includes('ticket_packs')).sql;

  ok('④★月額：更新で used に触れない', !/DO UPDATE SET[\s\S]*used/.test(monthlySql),
    '既にある枠の used を書き換えると、使った数が消える');
  ok('④★チケット：更新で used に触れない', !/DO UPDATE SET[\s\S]*used/.test(packSql));
  ok('④新しく作るときだけ used=0', /VALUES \(\?, \?, \?, 0, \?\)/.test(monthlySql));
  ok('④枠の大きさは更新する', /quota = excluded\.quota/.test(monthlySql));
  ok('④チケットの枚数も更新する', /total = excluded\.total/.test(packSql));
}

console.log('=== 5. 予約があると、その月の枠はどう変わるか ===');
//   ★枠（quota）は「使える上限」。予約があっても quota は減らない。
//     減るのは used（トリガーが動かす）。ここを取り違えると残数が二重に減る。
{
  const withSessions = buildQuotaForCustomer('C1', CONTRACTS,
    [ses('s1', jst(2026, 10, 3, 10)), ses('s2', jst(2026, 10, 10, 10))], null, OPTS);
  const oct = withSessions.monthly.find((m) => m.monthKey === '2026-10');
  ok('⑤10月の枠がある', !!oct);
  if (oct) eq('⑤★予約が2件あっても枠は10のまま（減るのは used）', oct.quota, 10);
  ok('⑤作る文に used の更新が無い',
    !/DO UPDATE SET[\s\S]*used/.test(quotaUpsertStatements(withSessions, 1).find((s) => s.sql.includes('monthly_quota')).sql));
}

console.log('=== 6. 計算が「要確認」なら枠を作らない（fail-closed） ===');
{
  // 契約行が壊れている題材：チケットなのに期限が無い（TICKET_NO_EXPIRY）
  const broken = [
    { row: crow({ method: 'チケット', type: 'チケット', ticket: 2 }), cols: COLS,
      start: new Date(jst(2026, 9, 1)), end: null, idx: 0 },
  ];
  const b = buildQuotaForCustomer('C9', broken, [], null, OPTS);
  ok('⑥問題として報告される', b.issues.length > 0, JSON.stringify(b.issues));
  eq('⑥★チケットの枠を作らない', b.packs.length, 0);
}

console.log('=== 7. 月のキーを進める／範囲を見る ===');
{
  eq('⑦12月の次は翌年1月', nextMonthKey('2026-12'), '2027-01');
  eq('⑦ふつうの月', nextMonthKey('2026-09'), '2026-10');
  ok('⑦範囲の中', inRange('2026-10', '2026-09', '2026-11'));
  ok('⑦範囲の外（前）', !inRange('2026-08', '2026-09', '2026-11'));
  ok('⑦範囲の外（後）', !inRange('2026-12', '2026-09', '2026-11'));
  ok('⑦両端を含む', inRange('2026-09', '2026-09', '2026-11') && inRange('2026-11', '2026-09', '2026-11'));
}

console.log('');
console.log(`${fail ? '❌' : '✅'} 枠を作る処理 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
