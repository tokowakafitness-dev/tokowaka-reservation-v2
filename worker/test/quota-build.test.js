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
  //   ★opening_used は別の列。used（引当が動かす数）とは意味が違う。
  //     検査が列名の一部で誤って反応しないよう、単語の境界で見る。
  ok('④★チケット：更新で used に触れない', !/DO UPDATE SET[\s\S]*\bused\s*=/.test(packSql),
    'opening_used（移行前に使った枚数）は更新してよい。used（引当が動かす数）に触れてはいけない');
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

console.log('=== 8. ★契約が切れても、繰越が残る月には枠を作る ===');
//   ★2026-10-07 の本番で落ちた形。
//     契約が10月で切れていても、9月までの繰越が残っていれば10月の予約は月額から引かれる。
//     割当器はそれを monthly と判定するのに、枠の行が無いと引当の外部キーが通らず、
//     書き込みがバッチごと落ちる。
//     「契約の頻度があるか」ではなく「その月に使える回数があるか」で決める。
{
  // 月額2回の契約が 2026-09-30 で終了。10月は契約が無いが、9月の未消化が繰り越される。
  const ended = [
    { row: crow({ method: '月額', freq: 2 }), cols: COLS,
      start: new Date(jst(2026, 8, 1)), end: new Date(jst(2026, 9, 30)), idx: 0 },
  ];
  const b = buildQuotaForCustomer('C8', ended, [], null,
    { ...OPTS, fromMonth: '2026-09', toMonth: '2026-10' });
  const sep = b.monthly.find((m) => m.monthKey === '2026-09');
  const oct = b.monthly.find((m) => m.monthKey === '2026-10');
  ok('⑧9月（契約がある月）の枠はある', !!sep);
  ok('⑧★10月（契約は切れたが繰越がある月）の枠もある', !!oct,
    'ここが無いと、割当器が monthly と判定した予約の引当が作れず、書き込みが落ちる');
  if (oct) ok('⑧その枠は繰越ぶん', oct.quota > 0, `quota=${oct.quota}`);
}

console.log('=== 9. 使える回数が0の月には枠を作らない ===');
{
  // とっくに終わった契約。繰越も尽きている
  const old = [
    { row: crow({ method: '月額', freq: 2 }), cols: COLS,
      start: new Date(jst(2026, 1, 1)), end: new Date(jst(2026, 2, 28)), idx: 0 },
  ];
  const b = buildQuotaForCustomer('C8', old, [], null,
    { ...OPTS, fromMonth: '2026-10', toMonth: '2026-11' });
  eq('⑨枠を作らない', b.monthly.length, 0);
  // 「枠が無い」と「枠が0」を区別する。0の行を作ると、引当のEXISTSは通るのに
  // 条件で弾かれ、どちらの状態か分からなくなる。
}

console.log('=== 10. ★棚卸しの引継ぎ（移行前に使った枚数）を持ち回る ===');
//   店舗は3月オープンだが、LINE予約の台帳は9月から。3〜8月の消化は棚卸しで引き継ぐ。
//   計算側はそれを「使った数の初期値」にしている（allocate.js の openingPacks）。
//   D1側も持たないと残りが多く見え、使えないはずのチケットが使えてしまう。
{
  const withOpening = buildQuotaForCustomer('C1', CONTRACTS, [], 
    { packsUsed: {} }, OPTS);
  ok('⑩棚卸しが空なら0', withOpening.packs.every((p) => p.openingUsed === 0));

  //   棚卸しに「このpackを2枚使った」と記録がある場合
  const pid = withOpening.packs[0] && withOpening.packs[0].packId;
  ok('⑩packId が取れる', !!pid);
  if (pid) {
    const b2 = buildQuotaForCustomer('C1', CONTRACTS, [], { packsUsed: { [pid]: 2 } }, OPTS);
    const p2 = b2.packs.find((x) => x.packId === pid);
    eq('⑩★移行前の2枚が入る', p2 && p2.openingUsed, 2);

    const st = quotaUpsertStatements(b2, 1000);
    const packSql = st.find((x) => x.sql.includes('ticket_packs')).sql;
    ok('⑩★更新で opening_used も直す', /opening_used = excluded\.opening_used/.test(packSql),
      '棚卸しが直ったら反映されないと、古い引継ぎのまま残る');
    ok('⑩★used には触れない', !/DO UPDATE SET[\s\S]*\bused = /.test(packSql),
      '使った数を動かすのはトリガーだけ、という不変条件を守る');
  }
}

console.log('=== 11. ★チケットを足して合成IDがずれても、棚卸しが追従する ===');
//   合成ID（CT<from>_<to>_<idx>）はチケットを足すと末尾の番号がずれる。
//   完全一致だけで引くと、ずれた分が0になり**使えないチケットが使えるように見える**
//   （Codex関門②の指摘）。計算側は「完全一致 → prefix が一意に一致」で解決している。
{
  const b = buildQuotaForCustomer('C1', CONTRACTS, [], null, OPTS);
  const pid = b.packs[0].packId;
  ok('⑪合成IDである', /^CT\d+_\d+_\d+$/.test(pid), `packId=${pid}`);

  //   棚卸しの鍵が、末尾の番号だけ違う形で記録されている場合
  const shifted = pid.replace(/_\d+$/, '_99');
  const b2 = buildQuotaForCustomer('C1', CONTRACTS, [], { packsUsed: { [shifted]: 2 } }, OPTS);
  const p2 = b2.packs.find((x) => x.packId === pid);
  eq('⑪★末尾がずれても引き継がれる', p2 && p2.openingUsed, 2);
  eq('⑪問題として残らない', b2.issues.filter((x) => x.code === 'OPENING_PACK_UNRESOLVED').length, 0);

  //   どれにも当たらない鍵は、計算側と同じく問題として残す（黙って0にしない）
  const b3 = buildQuotaForCustomer('C1', CONTRACTS, [], { packsUsed: { 'CT1_2_0': 1 } }, OPTS);
  ok('⑪★当たらない鍵は問題として残す',
    b3.issues.some((x) => x.code === 'OPENING_PACK_UNRESOLVED'),
    '黙って0にすると、使ったはずの枚数が復活する');
}

console.log('=== 12. 棚卸しが買った枚数を超えていたら問題にする ===');
{
  const b = buildQuotaForCustomer('C1', CONTRACTS, [], null, OPTS);
  const pid = b.packs[0].packId;
  const total = b.packs[0].total;
  const b2 = buildQuotaForCustomer('C1', CONTRACTS, [], { packsUsed: { [pid]: total + 5 } }, OPTS);
  ok('⑫問題として残す', b2.issues.some((x) => x.code === 'OPENING_OVER_TOTAL'),
    '計算側も opening <= 買った枚数 を要求して、超えたら停止する');
  const p2 = b2.packs.find((x) => x.packId === pid);
  eq('⑫買った枚数で止める', p2 && p2.openingUsed, total);
}

console.log('');
console.log(`${fail ? '❌' : '✅'} 枠を作る処理 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
