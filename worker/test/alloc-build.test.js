// 既存の予約から「引当」を作る処理の検証
//
//   ★なぜ要るのか
//     引当を入れるとトリガーが `used` を増やす。つまり**引当の作り方が残数を決める**。
//     1件多ければ残数が1回減り、1件少なければ1回増える。顧客に直接見える。
//
//   ★ここで確かめたいこと
//     ① 既存の割当（allocate.js の perSession）をそのまま写していること。決め直していないこと
//     ② 割り当たらなかった予約（超過）は行を作らないこと
//     ③ 同じ予約を二度入れても used が二重に増えないこと（INSERT OR IGNORE）
//
//   実行: node worker/test/alloc-build.test.js

import { buildAllocationsForCustomer, allocationInsertStatements } from '../src/lib/alloc-build.js';

let pass = 0, fail = 0;
function ok(name, cond, extra) { cond ? pass++ : (fail++, console.log(`❌ ${name}${extra ? '\n   ' + extra : ''}`)); }
function eq(name, got, want) { ok(name, String(got) === String(want), `期待=${want} 実際=${got}`); }

// ---------- 題材（quota-build.test.js と同じ作り） ----------
const COLS = { name: 1, type: 2, course: -1, freq: 8, ticket: 6, start: 10, end: 11,
               carry: -1, carryCap: -1, phone: 15, method: 16, trainer: 3,
               custId: -1, ticketPrice: -1, packId: -1, normalPrice: -1 };
function crow({ method, type = '通常', freq, ticket }) {
  const r = new Array(23).fill('');
  r[COLS.name] = '◯◯ ◯◯様'; r[COLS.type] = type; r[COLS.method] = method;
  if (freq != null) r[COLS.freq] = freq;
  if (ticket != null) r[COLS.ticket] = ticket;
  return r;
}
const jst = (y, m, d, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h - 9, mi);

//   月額2回（10/01〜）＋ チケット1枚（10/01〜12/31）
const CONTRACTS = [
  { row: crow({ method: '月額', freq: 2 }), cols: COLS,
    start: new Date(jst(2026, 10, 1)), end: null, idx: 0 },
  { row: crow({ method: 'チケット', type: 'チケット', ticket: 1 }), cols: COLS,
    start: new Date(jst(2026, 10, 1)), end: new Date(jst(2026, 12, 31)), idx: 1 },
];
function ses(id, startMs, extra = {}) {
  return { sessionId: id, resId: id, startAt: startMs, channel: 'line',
    attendeeCount: 1, packKind: 'normal', consumptionMode: '', bookType: '',
    createdAt: startMs, ...extra };
}
const OPTS = { fromMonth: '2026-10', toMonth: '2026-11',
               nowKey: '2026-10', targetDateMs: jst(2026, 10, 20, 12), carryRate: 0.5 };

// ============================================================
console.log('=== 1. 枠のぶんは月額、あふれたぶんはチケット ===');
{
  // 月額2回・チケット1枚に対して、予約3件
  const b = buildAllocationsForCustomer('C1', CONTRACTS,
    [ses('r1', jst(2026, 10, 5, 10)), ses('r2', jst(2026, 10, 12, 10)), ses('r3', jst(2026, 10, 19, 10))],
    null, OPTS);
  eq('①問題なし', b.issues.length, 0);
  eq('①3件とも引当ができる', b.rows.length, 3);
  eq('①月額が2件', b.rows.filter((r) => r.source === 'monthly').length, 2);
  eq('①チケットが1件', b.rows.filter((r) => r.source === 'ticket').length, 1);
  ok('①月額には月が入る', b.rows.filter((r) => r.source === 'monthly').every((r) => r.monthKey === '2026-10'));
  ok('①チケットには pack が入る', b.rows.filter((r) => r.source === 'ticket').every((r) => !!r.packId && !r.monthKey));
  eq('①超過は無い', b.skippedUnallocated, 0);
}

console.log('=== 2. ★あふれた予約は行を作らない（超過として見えるように） ===');
{
  // 枠3回ぶん（月額2＋チケット1）に対して、予約5件
  const many = [1, 2, 3, 4, 5].map((i) => ses('x' + i, jst(2026, 10, i * 3, 10)));
  const b = buildAllocationsForCustomer('C1', CONTRACTS, many, null, OPTS);
  eq('②引当は3件だけ', b.rows.length, 3);
  eq('②★あふれた2件は行にしない', b.skippedUnallocated, 2);
  ok('②それは問題として扱わない（超過は正常な状態）', b.issues.length === 0,
    '超過は決定0068で「防ぐのではなく見せる」と決まっている');
}

console.log('=== 3. 対象の範囲の外は写さない ===');
{
  const b = buildAllocationsForCustomer('C1', CONTRACTS,
    [ses('r1', jst(2026, 10, 5, 10)), ses('r9', jst(2026, 12, 5, 10))], null, OPTS);
  ok('③12月の予約は入らない', b.rows.every((r) => r.reservationId !== 'r9'));
  eq('③10月の予約は入る', b.rows.filter((r) => r.reservationId === 'r1').length, 1);
}

console.log('=== 4. 入れる文の形（★二度入れても二重に増えない） ===');
{
  const b = buildAllocationsForCustomer('C1', CONTRACTS, [ses('r1', jst(2026, 10, 5, 10))], null, OPTS);
  const st = allocationInsertStatements(b, 1000, { customerId: 'C1', fromMonth: '2026-10', toMonth: '2026-11' });
  eq('④消す文＋入れる文', st.length, 2);
  eq('④消す文の引数は 会員1＋期間2', st[0].args.length, 3);
  ok('④予約の月を入れる', /resv_month/.test(st[1].sql) && st[1].args.includes('2026-10'),
    'month_key は月額専用。チケットや振替がどの月の予約かを別に持たないと、期間で絞れない');
  ok('④★先に消す（流し直したとき消化先の変更が反映される）',
    /^DELETE FROM reservation_allocations/.test(st[0].sql.trim()),
    'INSERT OR IGNORE だけだと壊れはしないが正しくもならない。枠は新しく used は古いまま');
  ok('④★対象期間の引当を全部消してから入れ直す',
    /WHERE customer_id = \? AND resv_month >= \? AND resv_month <= \?/.test(st[0].sql)
    && !/NOT IN/.test(st[0].sql),
    'NOT IN で残すと、消化先が変わった予約の古い引当が消えず、INSERT OR IGNORE も無視する＝最初の問題に戻る');
  ok('④他の月・他の会員には触れない', /customer_id = \? AND resv_month >= \? AND resv_month <= \?/.test(st[0].sql));
  ok('④★入れ直しは OR IGNORE にしない', !/INSERT OR IGNORE/.test(st[1].sql),
    '全部消したあとなので衝突しない。OR IGNORE だと消し損ねたとき黙って古い行が残る');
  ok('④列を明示している', /\(reservation_id, customer_id, source, month_key, pack_id, units, resv_month, decided_at\)/.test(st[1].sql));
  eq('④引数の数', st[1].args.length, 8);
  // 範囲を渡さなければ消さない（既存の呼び方を壊さない）
  eq('④範囲が無ければ入れるだけ', allocationInsertStatements(b, 1000).length, 1);
}

console.log('=== 5. 計算が「要確認」なら引当を作らない ===');
{
  const broken = [
    { row: crow({ method: 'チケット', type: 'チケット', ticket: 2 }), cols: COLS,
      start: new Date(jst(2026, 10, 1)), end: null, idx: 0 },   // 期限が無い＝TICKET_NO_EXPIRY
  ];
  const b = buildAllocationsForCustomer('C9', broken, [ses('r1', jst(2026, 10, 5, 10))], null, OPTS);
  ok('⑤問題として報告される', b.issues.length > 0, JSON.stringify(b.issues));
  eq('⑤★行を作らない', b.rows.length, 0);
}

console.log('=== 6. 振替は枠もチケットも使わない ===');
{
  const b = buildAllocationsForCustomer('C1', CONTRACTS,
    [ses('t1', jst(2026, 10, 5, 10), { channel: 'transfer' })], null, OPTS);
  eq('⑥引当はできる', b.rows.length, 1);
  eq('⑥source は transfer', b.rows[0].source, 'transfer');
  ok('⑥親を指さない', b.rows[0].monthKey === null && b.rows[0].packId === null,
    '振替は月額の枠もチケットも減らさない');
}

console.log('=== 7. ★計算できなかったときは何も消さない ===');
{
  const broken = [
    { row: crow({ method: 'チケット', type: 'チケット', ticket: 2 }), cols: COLS,
      start: new Date(jst(2026, 10, 1)), end: null, idx: 0 },   // 期限なし＝計算が止まる
  ];
  const b = buildAllocationsForCustomer('C9', broken, [ses('r1', jst(2026, 10, 5, 10))], null, OPTS);
  ok('⑦計算できていない', b.computed === false);
  const st = allocationInsertStatements(b, 1000, { customerId: 'C9', fromMonth: '2026-10', toMonth: '2026-11' });
  eq('⑦★文を1つも出さない（消さない・入れない）', st.length, 0);
  // ok:false は「予約が0件」ではなく「計算できなかった」。
  // ここで消すと、その会員の引当が全部消えて used が0になり、
  // 残数が実際より**多く**見える＝枠を超えて予約できてしまう。
}

console.log('=== 8. 超過に転じた予約は行を作らない（全消しするので古い引当も残らない）===');
{
  const many = [1, 2, 3, 4, 5].map((i) => ses('y' + i, jst(2026, 10, i * 3, 10)));
  const b = buildAllocationsForCustomer('C1', CONTRACTS, many, null, OPTS);
  ok('⑧計算は通っている', b.computed === true);
  eq('⑧行は3件', b.rows.length, 3);
  eq('⑧あふれた2件', b.skippedUnallocated, 2);
  const st = allocationInsertStatements(b, 1000, { customerId: 'C1', fromMonth: '2026-10', toMonth: '2026-11' });
  eq('⑧消す文1＋入れる文3', st.length, 4);
}

console.log('');
console.log(`${fail ? '❌' : '✅'} 引当を作る処理 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
