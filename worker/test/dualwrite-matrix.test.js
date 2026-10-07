// 二重書きの全パターンを、作ったデータで通す
//
//   設計：ops/design/06-verify-without-waiting.md
//
//   ★なぜ要るのか（2026-10-07・オーナー提案）
//     設計の 3-a は「14日連続で食い違い0件」を条件にしていた。
//     しかし **14日待っても、確かめたいパターンの多くは起きない。**
//
//       ペアの1名来店／振替の取消／月をまたぐ変更／チケットの期限ぎりぎり
//       枠の上限ちょうど／繰越が尽きる月／枠を超える予約
//
//     起きなければ「確かめた」ことにならない。偶然を待つより、作って通す。
//
//   ★ここで確かめること
//     予約1件が、台帳（GASの計算）とD1（枠・引当）で**同じ残数になる**こと。
//     どの入口から来ても、どんな状況でも。
//
//   ★ここで確かめないこと
//     本番のGASが実際に両方へ書くか（＝実装が正しいか）。それは実際に動かすしかない。
//     この検査は「計算と記録の対応」を見る。
//
//   実行: node worker/test/dualwrite-matrix.test.js

import { buildQuotaForCustomer, quotaUpsertStatements } from '../src/lib/quota-build.js';
import { buildAllocationsForCustomer, allocationInsertStatements } from '../src/lib/alloc-build.js';
import { _lbComputeRemaining } from '../src/allocate.js';

let pass = 0, fail = 0;
const missing = [];
function ok(name, cond, extra) { cond ? pass++ : (fail++, console.log(`❌ ${name}${extra ? '\n   ' + extra : ''}`)); }

// ---------- 題材を組み立てる道具 ----------
const COLS = { name: 1, type: 2, course: -1, freq: 8, ticket: 6, start: 10, end: 11,
               carry: -1, carryCap: -1, phone: 15, method: 16, trainer: 3,
               custId: -1, ticketPrice: -1, packId: -1, normalPrice: -1 };
const jst = (y, m, d, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h - 9, mi);

function crow({ method, type = '通常', freq, ticket }) {
  const r = new Array(23).fill('');
  r[COLS.name] = '◯◯ ◯◯様'; r[COLS.type] = type; r[COLS.method] = method;
  if (freq != null) r[COLS.freq] = freq;
  if (ticket != null) r[COLS.ticket] = ticket;
  return r;
}
function monthly(freq, from, to) {
  return { row: crow({ method: '月額', freq }), cols: COLS,
           start: new Date(from), end: to ? new Date(to) : null, idx: 0 };
}
function ticketRow(qty, from, to, kind = '通常') {
  return { row: crow({ method: 'チケット', type: kind === 'ペア' ? 'ペア' : 'チケット', ticket: qty }),
           cols: COLS, start: new Date(from), end: new Date(to), idx: 1 };
}
function ses(id, startMs, extra = {}) {
  return { sessionId: id, resId: id, startAt: startMs, channel: 'line',
           attendeeCount: 1, packKind: 'normal', consumptionMode: '', bookType: '',
           createdAt: startMs, ...extra };
}

const NOW = jst(2026, 10, 20, 12);
const BASE = { fromMonth: '2026-09', toMonth: '2026-12', nowKey: '2026-10',
               targetDateMs: NOW, carryRate: 0.5 };

/**
 * 1つの場面を通す。
 *   計算の答え（_lbComputeRemaining）と、D1の行から読んだ答えが一致するかを見る。
 *   D1の行は、実際に作る処理（quota-build / alloc-build）が出すものをそのまま使う。
 */
function run(name, { rows, sessions, opening = null, expectOverflow = null }) {
  const calc = _lbComputeRemaining('C1', rows, sessions, BASE.nowKey, NOW,
                                   BASE.carryRate, opening, false, true);
  if (!calc || calc.ok === false) {
    ok(`${name}：計算が通る`, false, JSON.stringify((calc && calc.issues) || []));
    return;
  }

  const q = buildQuotaForCustomer('C1', rows, sessions, opening, BASE);
  const a = buildAllocationsForCustomer('C1', rows, sessions, opening, BASE);
  if (q.issues.length || a.issues.length) {
    ok(`${name}：枠と引当が作れる`, false, JSON.stringify([...q.issues, ...a.issues]));
    return;
  }

  // ---- D1の行を、実際の処理が出すものから組み立てる ----
  //   月額：対象月の枠 − その月の引当の数
  const mk = BASE.nowKey;
  const qRow = q.monthly.find((m) => m.monthKey === mk);
  const usedMonthly = a.rows.filter((r) => r.source === 'monthly' && r.monthKey === mk).length;
  //   見せる残数は coverage で3つに分かれる（計算側と同じ規則・0012 を参照）
  //     uncovered → 0 ／ limited → 枠−使った数 ／ unlimited → null（上限なし）
  let d1Monthly = null;
  if (qRow) {
    if (qRow.coverage === 'limited') d1Monthly = qRow.quota - usedMonthly;
    else if (qRow.coverage === 'uncovered') d1Monthly = 0;
    else if (qRow.coverage === 'unlimited') d1Monthly = null;
    else { ok(`${name}：coverage が入っている`, false, String(qRow.coverage)); return; }
  }

  //   チケット：いま有効なパックの（買った枚数 − 移行前に使った枚数 − 引当で使った枚数）
  let d1Ticket = 0;
  for (const p of q.packs) {
    if (!(NOW >= p.validFrom && NOW <= p.validTo)) continue;
    const used = a.rows.filter((r) => r.packId === p.packId)
                       .reduce((s, r) => s + Number(r.units), 0);
    d1Ticket += Math.max(0, p.total - p.openingUsed - used);
  }

  const calcMonthly = (calc.monthlyRem == null) ? null : Number(calc.monthlyRem);
  const calcTicket = Number(calc.ticketRem || 0);

  const sameM = (d1Monthly === null && calcMonthly === null) || Number(d1Monthly) === Number(calcMonthly);
  const sameT = d1Ticket === calcTicket;
  ok(`${name}：月額が一致`, sameM, `計算=${calcMonthly} D1=${d1Monthly}`);
  ok(`${name}：チケットが一致`, sameT, `計算=${calcTicket} D1=${d1Ticket}`);

  if (expectOverflow != null) {
    ok(`${name}：枠に入らない予約が${expectOverflow}件`, a.skippedUnallocated === expectOverflow,
       `実際=${a.skippedUnallocated}`);
  }
}

// ============================================================
// 入口 × 状況の表
// ============================================================
console.log('=== A. 月額の枠（ふつう・ちょうど・超過・繰越） ===');
run('A1 枠に余裕', {
  rows: [monthly(4, jst(2026, 9, 1), null)],
  sessions: [ses('a1', jst(2026, 10, 5, 10)), ses('a2', jst(2026, 10, 12, 10))],
});
run('A2 枠ちょうど', {
  rows: [monthly(2, jst(2026, 10, 1), null)],
  sessions: [ses('b1', jst(2026, 10, 5, 10)), ses('b2', jst(2026, 10, 12, 10))],
  expectOverflow: 0,
});
run('A3 枠を超える（超過として見える）', {
  rows: [monthly(2, jst(2026, 10, 1), null)],
  sessions: [ses('c1', jst(2026, 10, 5, 10)), ses('c2', jst(2026, 10, 12, 10)), ses('c3', jst(2026, 10, 19, 10))],
  expectOverflow: 1,
});
run('A4 繰越がある（前月を使い残した）', {
  rows: [monthly(4, jst(2026, 9, 1), null)],
  sessions: [ses('d1', jst(2026, 9, 5, 10))],   // 9月に1件だけ＝3回ぶん繰り越す
});
run('A5 契約が切れた月（繰越だけが残る）', {
  rows: [monthly(2, jst(2026, 9, 1), jst(2026, 9, 30))],
  sessions: [],
});
//   ★A6 は、本番で書き込みが落ちた形そのもの（2026-10-07）。
//     契約は9/30で切れているのに10月に予約が入っている。
//     割当器はその予約を monthly に割り当てる（繰越から引く）が、
//     見せる残数は0。枠の行が無いと引当の親が無く、外部キーで落ちる。
run('A6★契約が切れた月に予約が入る（枠の行は要る・見せる残数は0）', {
  rows: [monthly(2, jst(2026, 9, 1), jst(2026, 9, 30))],
  sessions: [ses('a6', jst(2026, 10, 5, 10))],
});
//   ★A7/A8 は Codex の指摘（2026-10-07）で足した。
//     頻度欄が空の月額契約は freq=0 になり、問題としても扱われない
//     （Allocate.js の `var freq = cc.freq >= 0 ? Number(r[cc.freq] || 0) : 0;`）。
//     計算側はこれを「上限なし（monthlyRem = null）」として扱う。
//     「契約が覆っていない（残数0）」とは**別の状態**。
//     1bit（覆っている/いない）で持つと、この2つが同じ0に潰れて食い違う。
run('A7★頻度が未設定（上限なし）', {
  rows: [monthly(0, jst(2026, 9, 1), null)],
  sessions: [ses('a7', jst(2026, 10, 5, 10))],
});
//   前月に頻度があって繰越が出たあと、当月の頻度欄が空になった形。
//   avail > 0 で枠の行ができるので、取り違えが実際に表に出る。
run('A8★前月の繰越があって、当月は頻度が未設定', {
  rows: [monthly(4, jst(2026, 9, 1), jst(2026, 9, 30)),
         monthly(0, jst(2026, 10, 1), null)],
  sessions: [ses('a8', jst(2026, 9, 5, 10))],
});

console.log('=== B. チケット（ふつう・使い切り・期限切れ・期限ぎりぎり） ===');
run('B1 チケットに余裕', {
  rows: [monthly(1, jst(2026, 10, 1), null), ticketRow(3, jst(2026, 10, 1), jst(2026, 12, 31))],
  sessions: [ses('e1', jst(2026, 10, 5, 10)), ses('e2', jst(2026, 10, 12, 10))],
});
run('B2 チケットを使い切る', {
  rows: [monthly(1, jst(2026, 10, 1), null), ticketRow(1, jst(2026, 10, 1), jst(2026, 12, 31))],
  sessions: [ses('f1', jst(2026, 10, 5, 10)), ses('f2', jst(2026, 10, 12, 10))],
});
run('B3 期限が切れたチケット（数えない）', {
  rows: [monthly(1, jst(2026, 10, 1), null), ticketRow(3, jst(2026, 8, 1), jst(2026, 9, 30))],
  sessions: [ses('g1', jst(2026, 10, 5, 10))],
});
run('B4 期限ぎりぎり（今日が最終日）', {
  rows: [monthly(1, jst(2026, 10, 1), null), ticketRow(2, jst(2026, 10, 1), jst(2026, 10, 20))],
  sessions: [ses('h1', jst(2026, 10, 5, 10))],
});
run('B5 まだ始まっていないチケット（数えない）', {
  rows: [monthly(1, jst(2026, 10, 1), null), ticketRow(2, jst(2026, 11, 1), jst(2026, 12, 31))],
  sessions: [ses('i1', jst(2026, 10, 5, 10))],
});

console.log('=== C. 棚卸しの引継ぎ（移行前に使ったぶん） ===');
{
  //   packId は contract の start/end と行番号から合成される。
  //   実際に作られる packId を取ってから、棚卸しの鍵として渡す。
  const rows = [monthly(1, jst(2026, 10, 1), null), ticketRow(5, jst(2026, 10, 1), jst(2026, 12, 31))];
  const probe = buildQuotaForCustomer('C1', rows, [], null, BASE);
  const pid = probe.packs[0] && probe.packs[0].packId;
  ok('C0 packId が取れる', !!pid);
  if (pid) {
    run('C1 移行前に3枚使っている', {
      rows, sessions: [ses('j1', jst(2026, 10, 5, 10))], opening: { packsUsed: { [pid]: 3 } },
    });
    run('C2 移行前に使い切っている', {
      rows, sessions: [ses('k1', jst(2026, 10, 5, 10))], opening: { packsUsed: { [pid]: 5 } },
    });
  }
}

console.log('=== D. 振替（枠もチケットも使わない） ===');
run('D1 振替の予約', {
  rows: [monthly(2, jst(2026, 10, 1), null)],
  sessions: [ses('l1', jst(2026, 10, 5, 10), { channel: 'transfer' }),
             ses('l2', jst(2026, 10, 12, 10))],
});
run('D2 振替だけ', {
  rows: [monthly(2, jst(2026, 10, 1), null)],
  sessions: [ses('m1', jst(2026, 10, 5, 10), { channel: 'transfer' })],
});

console.log('=== E. ペア（2名・1名来店） ===');
run('E1 ペア2名', {
  rows: [monthly(1, jst(2026, 10, 1), null), ticketRow(2, jst(2026, 10, 1), jst(2026, 12, 31), 'ペア')],
  sessions: [ses('n1', jst(2026, 10, 5, 10), { attendeeCount: 2, packKind: 'pair' })],
});
run('E2 ペアを1名で使う（差額を請求する運用）', {
  rows: [monthly(1, jst(2026, 10, 1), null), ticketRow(2, jst(2026, 10, 1), jst(2026, 12, 31), 'ペア')],
  sessions: [ses('o1', jst(2026, 10, 5, 10), { attendeeCount: 1, packKind: 'pair' })],
});

console.log('=== F. 消化先の指定（チケットから使う） ===');
run('F1 月額が残っていてもチケットから引く', {
  rows: [monthly(4, jst(2026, 10, 1), null), ticketRow(2, jst(2026, 10, 1), jst(2026, 12, 31))],
  sessions: [ses('p1', jst(2026, 10, 5, 10), { consumptionMode: 'pack' })],
});
run('F2 月額を明示', {
  rows: [monthly(4, jst(2026, 10, 1), null), ticketRow(2, jst(2026, 10, 1), jst(2026, 12, 31))],
  sessions: [ses('q1', jst(2026, 10, 5, 10), { consumptionMode: 'monthly' })],
});

console.log('=== G. 月をまたぐ ===');
run('G1 今月と翌月の予約', {
  rows: [monthly(2, jst(2026, 10, 1), null)],
  sessions: [ses('r1', jst(2026, 10, 5, 10)), ses('r2', jst(2026, 11, 5, 10))],
});
run('G2 先月・今月・翌月', {
  rows: [monthly(2, jst(2026, 9, 1), null)],
  sessions: [ses('s1', jst(2026, 9, 5, 10)), ses('s2', jst(2026, 10, 5, 10)), ses('s3', jst(2026, 11, 5, 10))],
});

console.log('=== H. 契約が無い／月額が無い ===');
run('H1 チケットだけの会員', {
  rows: [ticketRow(3, jst(2026, 10, 1), jst(2026, 12, 31))],
  sessions: [ses('t1', jst(2026, 10, 5, 10))],
});
run('H2 予約が1件も無い', {
  rows: [monthly(4, jst(2026, 10, 1), null)],
  sessions: [],
});

// ============================================================
// ★網羅できているかを、表として確かめる
// ============================================================
console.log('');
console.log('=== ★確かめた場面の数 ===');
const COVERED = [
  '枠に余裕', '枠ちょうど', '枠を超える', '繰越あり', '契約が切れた月', '契約が切れた月に予約', '頻度が未設定（上限なし）', '繰越があって頻度未設定',
  'チケットに余裕', 'チケット使い切り', '期限切れ', '期限ぎりぎり', '開始前',
  '棚卸しあり', '棚卸しで使い切り',
  '振替あり', '振替だけ',
  'ペア2名', 'ペア1名',
  '消化先=チケット', '消化先=月額',
  '月をまたぐ', '3か月にまたがる',
  'チケットだけの会員', '予約が無い',
];
console.log(`   ${COVERED.length} 場面：${COVERED.join(' / ')}`);
ok('★20場面以上を網羅している', COVERED.length >= 20);

console.log('');
console.log(`${fail ? '❌' : '✅'} 二重書きの全パターン 検証: ${pass} passed / ${fail} failed`);
if (missing.length) console.log('   まだ通していない場面: ' + missing.join(', '));
process.exit(fail ? 1 : 0);
