// 頻度0は「上限なし」ではなく「月0回」── 残数と**予約可否**を直接確かめる。
//   実行: node worker/test/freq-zero.test.js
//
// ★なぜ必要か（2026-10-08）
//   それまで頻度0は「上限なし」として扱われ、予約可否が**無条件に true** だった
//   （`degradedUnlimited`）。その結果：
//     会員の画面   予約できる残り = 0
//     実際の予約   何回でも通る
//   表示と実際が逆向きにずれていた。1名（会員#4537・2026年10月）で実際に起きていた。
//
//   オーナーの判断：頻度0は「その月の付与が0回」という意思表示。
//     9月まで月2回 → 10月は契約未定だが期間中として扱いたいので頻度0で登録し、
//     9月の繰越1回だけを使う。
//   設計：ops/design/08-freq-zero-means-zero.md
//
// ★`_lbBookability`（予約可否の核）を直接呼ぶテストは、これが最初。
//   残数の表示だけ見ていると「表示は0なのに予約が通る」ずれに気づけない。

import { _lbComputeRemaining, _lbBookability, _lbMonthlyCoverage, _lbRowsToEntitlements,
         _lbResvValsToSessions } from '../src/allocate.js';
import { buildQuotaForCustomer } from '../src/lib/quota-build.js';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  cond ? pass++ : (fail++, console.log(`❌ ${name}${extra ? '\n   ' + extra : ''}`));
}
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  g === w ? pass++ : (fail++, console.log(`❌ ${name}\n   got : ${g}\n   want: ${w}`));
}

const jst = (y, m, d, h = 0) => Date.UTC(y, m - 1, d, h - 9, 0, 0);
const COLS = { method: 0, freq: 1, ticket: 2, type: 3, carry: 4, carryCap: 5, ticketPrice: 6 };
//   freq に '' を渡せる（空欄＝入力漏れ）ことが要点。Number('' || 0) で 0 になる。
function crow(o) {
  const r = [];
  r[0] = o.method || ''; r[1] = (o.freq === undefined ? '' : o.freq);
  r[2] = (o.ticket == null ? '' : o.ticket); r[3] = o.type || '';
  r[4] = ''; r[5] = (o.carryCap == null ? '' : o.carryCap); r[6] = '';
  return r;
}
const monthly = (freq, from, to, carryCap) =>
  ({ row: crow({ method: '月額', freq, carryCap }), cols: COLS,
     start: new Date(from), end: to ? new Date(to) : null, idx: 0 });
const ticketRow = (qty, from, to, kind = '通常') =>
  ({ row: crow({ method: 'チケット', type: kind === 'ペア' ? 'ペア' : 'チケット', ticket: qty }),
     cols: COLS, start: new Date(from), end: new Date(to), idx: 1 });
const ses = (id, startMs, extra = {}) =>
  ({ sessionId: id, resId: id, startAt: startMs, channel: 'line', attendeeCount: 1,
     packKind: 'normal', consumptionMode: '', bookType: '', status: 'confirmed', ...extra });

const NOW = jst(2026, 10, 20, 12);
const RATE = 0.5;
const remain = (rows, sessions) =>
  _lbComputeRemaining('C1', rows, sessions, '2026-10', NOW, RATE, null, false, true);
//   予約可否：対象日時に1枠取れるか
//   引数は (customerId, rows, sessions, nowKey, targetDateMs, carryRate,
//           excludeStartMs, opening, attendeeCount, packKind, carryFromContractStart)
const canBook = (rows, sessions, opts = {}) =>
  _lbBookability('C1', rows, sessions, '2026-10', opts.at || jst(2026, 10, 25, 10), RATE,
                 undefined, null, opts.attendeeCount, opts.packKind, true);

// ============================================================
console.log('=== 1. ★頻度0・繰越なし → 枠0・予約できない ===');
{
  //   9月に契約開始・頻度0。繰越の元になる枠が無いので、使えるものが何も無い。
  const rows = [monthly(0, jst(2026, 10, 1), null)];
  const r = remain(rows, []);
  eq('①残数は0（nullではない）', r.monthlyRem, 0);
  eq('①覆い方は limited', r.coverage, 'limited');
  eq('①枠は0', r.avail, 0);
  const b = canBook(rows, []);
  eq('①★予約できない', b.canBook, false);
  ok('①上限なしという概念が返らない', b.degradedUnlimited === undefined);
}

console.log('=== 2. ★頻度0・繰越あり → 繰越ぶんだけ使える（実データの形）===');
{
  //   9月まで月2回 → 10月は頻度0。9月に1件だけ使ったので繰越が出る。
  const rows = [monthly(2, jst(2026, 9, 1), jst(2026, 9, 30), 2),
                monthly(0, jst(2026, 10, 1), jst(2026, 10, 31), 2)];
  const r0 = remain(rows, [ses('s1', jst(2026, 9, 5, 10))]);
  ok('②枠は繰越ぶん（1以上）', Number(r0.avail) > 0, `avail=${r0.avail}`);
  eq('②覆い方は limited', r0.coverage, 'limited');
  eq('②残数は枠−使った数', r0.monthlyRem, Number(r0.avail));

  //   繰越を使い切るまでは予約できる
  const b1 = canBook(rows, [ses('s1', jst(2026, 9, 5, 10))]);
  eq('②★繰越が残っていれば予約できる', b1.canBook, true);
  eq('②消化先は月額', b1.consumeType, 'monthly');

  //   使い切ったら予約できない（★これが直したかった穴）
  const used = [ses('s1', jst(2026, 9, 5, 10))];
  for (let i = 0; i < Number(r0.avail); i++) used.push(ses('u' + i, jst(2026, 10, 5 + i, 10)));
  const r1 = remain(rows, used);
  eq('②使い切ると残数0', r1.monthlyRem, 0);
  const b2 = canBook(rows, used);
  eq('②★使い切ったら予約できない（以前は無制限に通っていた）', b2.canBook, false);
}

console.log('=== 3. 空欄と 0 は同じ扱い（区別できないので同じになる）===');
{
  const zero  = [monthly(0, jst(2026, 10, 1), null)];
  const blank = [monthly(undefined, jst(2026, 10, 1), null)];   // freq=''（空欄）
  const rz = remain(zero, []), rb = remain(blank, []);
  eq('③残数が同じ', [rz.monthlyRem, rb.monthlyRem], [0, 0]);
  eq('③覆い方が同じ', [rz.coverage, rb.coverage], ['limited', 'limited']);
  eq('③★どちらも予約できない（空欄でも上限なしにならない）',
     [canBook(zero, []).canBook, canBook(blank, []).canBook], [false, false]);
  //   空欄であること自体は台帳の検査で指摘する（_contractOddities）。予約は止めない方針。
}

console.log('=== 4. 頻度0でもチケットがあれば予約できる（経路が別）===');
{
  const rows = [monthly(0, jst(2026, 10, 1), null),
                ticketRow(2, jst(2026, 10, 1), jst(2026, 12, 31))];
  const r = remain(rows, []);
  eq('④月額の残数は0', r.monthlyRem, 0);
  eq('④チケットは2', r.ticketRem, 2);
  const b = canBook(rows, []);
  eq('④★予約できる', b.canBook, true);
  eq('④消化先はチケット', b.consumeType, 'ticket');
}

console.log('=== 5. ペア（上限なしの例外を消しても壊れない）===');
{
  //   以前は「頻度0は上限なし。ただしペアは対象外」という例外があった。
  //   概念を消したので、ペアは通常どおり「ペアのチケットがあるか」だけで決まる。
  const noPack = [monthly(0, jst(2026, 10, 1), null)];
  eq('⑤ペアのチケットが無ければ2名は不可',
     canBook(noPack, [], { attendeeCount: 2, packKind: 'pair' }).canBook, false);
  eq('⑤ペアのチケットが無ければ1名でもペア指定は不可',
     canBook(noPack, [], { attendeeCount: 1, packKind: 'pair' }).canBook, false);

  const withPair = [monthly(0, jst(2026, 10, 1), null),
                    ticketRow(2, jst(2026, 10, 1), jst(2026, 12, 31), 'ペア')];
  eq('⑤ペアのチケットがあれば2名は可',
     canBook(withPair, [], { attendeeCount: 2, packKind: 'pair' }).canBook, true);
  eq('⑤ペアのチケットがあれば1名も可',
     canBook(withPair, [], { attendeeCount: 1, packKind: 'pair' }).canBook, true);
}

console.log('=== 6. ★返す頻度は「枠を決めた行」のもの（最大ではない）===');
{
  //   以前は覆っている行の**最大**の頻度を返していた。枠は「開始がいちばん新しい行」で
  //   計算するので食い違い、画面の内訳で繰越が負になり得た。
  //     05/01〜07/05 頻度4 ／ 07/05〜09/30 頻度2 → 7月は両方が覆う
  const rows = [monthly(4, jst(2026, 5, 1), jst(2026, 7, 5)),
                monthly(2, jst(2026, 7, 5), jst(2026, 9, 30))];
  const ent = _lbRowsToEntitlements(rows, RATE);
  eq('⑥7月は「開始が新しい行」の頻度2（最大の4ではない）',
     _lbMonthlyCoverage(ent.entitlements.monthlyRows, '2026-07'), 2);
  eq('⑥6月は頻度4（覆っているのはその行だけ）',
     _lbMonthlyCoverage(ent.entitlements.monthlyRows, '2026-06'), 4);
  eq('⑥覆っていない月は null', _lbMonthlyCoverage(ent.entitlements.monthlyRows, '2026-11'), null);

  //   頻度0の行が新しい場合も、0が返る（最大の2ではない）
  const rows2 = [monthly(2, jst(2026, 9, 1), jst(2026, 10, 31)),
                 monthly(0, jst(2026, 10, 1), jst(2026, 10, 31))];
  const ent2 = _lbRowsToEntitlements(rows2, RATE);
  eq('⑥★新しい行が頻度0なら0が返る', _lbMonthlyCoverage(ent2.entitlements.monthlyRows, '2026-10'), 0);
}

console.log('=== 7. 画面の内訳で繰越が負にならない ===');
{
  //   LineBooking は quota=freq / carryover=avail−freq として出す。
  //   freq が枠を決めた行と違うと、繰越が負になる。
  const rows = [monthly(4, jst(2026, 5, 1), jst(2026, 7, 5)),
                monthly(2, jst(2026, 7, 5), null)];
  const r = _lbComputeRemaining('C1', rows, [], '2026-07', jst(2026, 7, 20, 12), RATE, null, false, true);
  ok('⑦繰越が負にならない', Number(r.avail) - Number(r.freq) >= 0,
     `avail=${r.avail} freq=${r.freq} 繰越=${Number(r.avail) - Number(r.freq)}`);
}

console.log('=== 8. 契約が覆っていない月は0のまま（変えていない）===');
{
  const rows = [monthly(2, jst(2026, 9, 1), jst(2026, 9, 30))];
  const r = remain(rows, []);
  eq('⑧残数は0', r.monthlyRem, 0);
  eq('⑧覆い方は uncovered', r.coverage, 'uncovered');
}

console.log('=== 9. 月額契約が無ければ null（null の意味は1つに戻った）===');
{
  const rows = [ticketRow(1, jst(2026, 10, 1), jst(2026, 12, 31))];
  const r = remain(rows, []);
  eq('⑨月額の残数は null', r.monthlyRem, null);
  eq('⑨月額契約は無い', r.hasMonthly, false);
}

console.log('=== 10. ★D1の枠に unlimited を作らない ===');
{
  const BASE = { fromMonth: '2026-09', toMonth: '2026-12', nowKey: '2026-10',
                 targetDateMs: NOW, carryRate: RATE };
  const cases = [
    ['頻度0・繰越なし', [monthly(0, jst(2026, 10, 1), null)], []],
    ['頻度0・繰越あり', [monthly(2, jst(2026, 9, 1), jst(2026, 9, 30), 2),
                        monthly(0, jst(2026, 10, 1), jst(2026, 10, 31), 2)],
                       [ses('s1', jst(2026, 9, 5, 10))]],
    ['空欄', [monthly(undefined, jst(2026, 10, 1), null)], []],
  ];
  for (const [name, rows, sessions] of cases) {
    const q = buildQuotaForCustomer('C1', rows, sessions, null, BASE);
    eq(`⑩${name}：問題なし`, q.issues, []);
    const bad = q.monthly.filter((m) => m.coverage === 'unlimited');
    eq(`⑩★${name}：unlimited の枠を作らない`, bad, []);
    ok(`⑩${name}：作る枠は limited か uncovered だけ`,
       q.monthly.every((m) => m.coverage === 'limited' || m.coverage === 'uncovered'),
       JSON.stringify(q.monthly));
  }
}

// ============================================================
// ★Codex関門③で挙がった、顧客に見える経路（2026-10-08）
// ============================================================
console.log('=== 11. ★予約の変更（旧予約を外せば取り直せる）===');
{
  //   本番の変更は「旧予約を先に changed にしてから、通常の残数判定へ通す」作り。
  //   頻度0・枠1・使用1 の状態でも、旧予約が消化から外れれば残数が1に戻るので取り直せる。
  const rows = [monthly(2, jst(2026, 9, 1), jst(2026, 9, 30), 2),
                monthly(0, jst(2026, 10, 1), jst(2026, 10, 31), 2)];
  const sept = ses('s1', jst(2026, 9, 5, 10));
  const oct10 = ses('o1', jst(2026, 10, 10, 15));

  eq('⑪使い切っていれば新規は取れない', canBook(rows, [sept, oct10]).canBook, false);
  eq('⑪★旧予約を外せば取り直せる（変更が通る）', canBook(rows, [sept]).canBook, true);
  //   除外の引数を使う経路でも同じ（純粋関数側はこちらを使う）
  const b = _lbBookability('C1', rows, [sept, oct10], '2026-10', jst(2026, 10, 10, 15),
                           RATE, jst(2026, 10, 10, 15), null, undefined, undefined, true);
  eq('⑪★excludeStartMs で旧予約を除いても取れる', b.canBook, true);
}

console.log('=== 12. ★取消したあと（無料なら取り直せる・当日消化なら取れない）===');
{
  const rows = [monthly(2, jst(2026, 9, 1), jst(2026, 9, 30), 2),
                monthly(0, jst(2026, 10, 1), jst(2026, 10, 31), 2)];
  const sept = ses('s1', jst(2026, 9, 5, 10));
  //   ★本番と同じ経路で確かめる（2026-10-08・Codex関門③の2回目）。
  //     純粋関数は status を見ない。台帳の行を `_lbResvValsToSessions` に通して初めて
  //     「無料取消＝cancelled は落ちる／当日取消＝consumed は残る」が効く。
  //     以前は sessions を手で足し引きしていただけで、**status の選別を検査していなかった。**
  //
  //     台帳の列（使うところだけ）：0=予約日時 2=顧客ID 6=状態 8=備考 9=入口 11=session_id
  const ledger = (id, startMs, status) => {
    const r = [];
    r[0] = new Date(startMs); r[2] = 'C1'; r[6] = status; r[8] = id; r[9] = 'line'; r[11] = id;
    return r;
  };
  const toSessions = (vals) =>
    _lbResvValsToSessions(vals, 'C1', (v) => (v instanceof Date ? v : new Date(v)));

  //   9月の1件（消化）＋10/10の1件。10/10 を無料取消すると cancelled になる
  const free = toSessions([ledger('s1', jst(2026, 9, 5, 10), 'consumed'),
                           ledger('o1', jst(2026, 10, 10, 15), 'cancelled')]);
  eq('⑫無料取消（cancelled）は残数の元データから落ちる', free.length, 1);
  eq('⑫★無料取消のあとは取り直せる', canBook(rows, free).canBook, true);

  //   当日取消は consumed のまま残る＝枠を消化したまま
  const sameDay = toSessions([ledger('s1', jst(2026, 9, 5, 10), 'consumed'),
                              ledger('o1', jst(2026, 10, 10, 15), 'consumed')]);
  eq('⑫当日取消（consumed）は残る', sameDay.length, 2);
  eq('⑫★当日取消のあとは通常の予約が取れない', canBook(rows, sameDay).canBook, false,
     '振替権での予約は別経路で、残数判定を通らない');

  //   変更で付く 'changed' も落ちる（旧予約が消化から外れる＝取り直せる）
  const changed = toSessions([ledger('s1', jst(2026, 9, 5, 10), 'consumed'),
                              ledger('o1', jst(2026, 10, 10, 15), 'changed')]);
  eq('⑫変更で changed になった旧予約も落ちる', changed.length, 1);
  eq('⑫★だから変更が通る', canBook(rows, changed).canBook, true);
}

console.log('=== 13. ★締めへの影響（頻度を揃えても結果は変わらない／超過は止まる）===');
{
  //   太田さん型：10月を2本の月額行が覆う（頻度4が10/11まで・頻度2が10/13から）。
  //   枠は以前から「開始がいちばん新しい行」で計算している＝締めの結果は変わらない。
  const ota = [monthly(4, jst(2026, 7, 11), jst(2026, 10, 11)),
               monthly(2, jst(2026, 10, 13), null)];
  const r = _lbComputeRemaining('C1', ota, [], '2026-10', NOW, RATE, null, false, true);
  eq('⑬返す頻度は最新の行の2（最大の4ではない）', r.freq, 2);
  ok('⑬★画面の繰越が負にならない', Number(r.avail) - Number(r.freq) >= 0,
     `avail=${r.avail} freq=${r.freq}`);

  //   片山さん型：頻度8・枠8に予約10。超過2件は割り当たらない＝締めが止まる材料。
  //   ★この会員は頻度0ではないので、今回の変更の影響を受けない。
  //   ★契約を10月開始にする（9月があると繰越が乗って枠が8を超え、超過が出ない）。
  const kata = [monthly(8, jst(2026, 10, 1), null)];
  const many = [];
  for (let i = 0; i < 10; i++) many.push(ses('k' + i, jst(2026, 10, i + 1, 10)));
  const rk = _lbComputeRemaining('C1', kata, many, '2026-10', NOW, RATE, null, false, true);
  eq('⑬枠は8', rk.avail, 8);
  const unalloc = (rk.perSession || []).filter((x) => x.alloc === 'unallocated').length;
  eq('⑬★超過2件は割り当たらない（締めが止まる材料）', unalloc, 2);
  eq('⑬残数は0で止まる（超過は残数に出ない）', rk.monthlyRem, 0);
}

console.log('=== 14. ★翌月を覆う契約が無ければ、翌月の残数は0（案内を送らない材料）===');
{
  //   夏目さん型：10月までの契約しか無い。11月は覆われない。
  const rows = [monthly(2, jst(2026, 9, 1), jst(2026, 9, 30), 2),
                monthly(0, jst(2026, 10, 1), jst(2026, 10, 31), 2)];
  const nov = _lbComputeRemaining('C1', rows, [ses('s1', jst(2026, 9, 5, 10))],
                                  '2026-11', jst(2026, 11, 10, 12), RATE, null, false, true);
  eq('⑭11月の覆い方は uncovered', nov.coverage, 'uncovered');
  eq('⑭★11月の残数は0（null ではない）', nov.monthlyRem, 0);
  ok('⑭月額契約そのものは在る', nov.hasMonthly === true,
     '「月額契約なし」ではなく「その月を覆っていない」。リマインドは翌月の残数で判断する');
}

console.log('');
console.log(`${fail ? '❌' : '✅'} 頻度0は月0回 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
