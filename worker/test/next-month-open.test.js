// 設計57：翌月の空き枠の見張り（日次点検・2026-11-25）
//   実行: node worker/test/next-month-open.test.js
//   入口から通す：本物の dailyHealthCheck（gas/LineBooking.js）→ 本物の lbNextMonthOpenCheck → 本物の _lbNextMonthOpenRead
//     → 身代わりの公開シート（枠の2列・meta!A1）とトレーナーのカレンダー（_self-heal-harness.js）
//   I86 ① 24日までは何も読まず何も出さない ② 25日以降、顧客向け（非表示でない）トレーナーの翌月の枠のある日が0日なら
//       next_month_slots_none（出勤の日数も出す） ③ 枠があれば出さない（next_month_open は記録だけ）
//       ④ 写しが翌月を覆う時刻より前・古い・読めない・時間が足りない → 0日と言わず next_month_slots_unknown
//       ⑤ 点検そのものが落ちたら next_month_check_fail・段に印を付けない ⑥ 出すのは日数と記号だけ
//   ★値はすべて架空（トレーナーは記号 A/B/C だけ）
import { makeWorld, run, makeCtx, status, incOf, tally } from './_self-heal-harness.js';

process.env.TZ = 'Asia/Tokyo';   // GAS のスクリプトの時間帯（JST）と同じにする
const t = tally();
const ok = t.ok;
const at = (y, m, d, h = 7, mi = 5) => Date.UTC(y, m - 1, d, h - 9, mi);   // JST の日時
const iso = (ms) => new Date(ms).toISOString();
const days = (y, m, n, h = 10) => Array.from({ length: n }, (_, i) => at(y, m, i + 1, h, 0));
const keysOf = (r) => (r.issues || []).filter((x) => /^next_month_/.test(x.key));
const one = (r, k) => (r.issues || []).find((x) => x.key === k);
//   今月の枠（11/26〜30・B）＝公開シートが書き直し中ではない（0行ではない）印。翌月の判定には数えない
const NOV = days(2026, 11, 30).slice(25).map((ms) => [iso(ms), 'B']);

console.log('=== ① 24日までは読まない・出さない ===');
{
  const w = makeWorld({ now: at(2026, 11, 24, 7, 5), data: { nmo: { slots: NOV, events: {} } } });   // 翌月の枠0でも
  const r = run(w, 'dailyHealthCheck', true);
  ok('①-1 24日 7:05：next_month_* は1つも出ない', keysOf(r).length === 0, JSON.stringify(keysOf(r)));
  ok('①-2 ★24日は公開シートもカレンダーも読まない（重さを足さない）', !w.calls.openById && !w.calls.getCalendarById, JSON.stringify(w.calls));
  const w2 = makeWorld({ now: at(2026, 11, 24, 23, 59), data: { nmo: { slots: NOV, events: {} } } });
  ok('①-3 24日 23:59 も出さない', keysOf(run(w2, 'dailyHealthCheck', true)).length === 0);
}

console.log('=== ② 25日・翌月の枠が0日なら出す ===');
{
  //   今月の枠だけある（翌月は0）・出勤も0
  const w = makeWorld({ now: at(2026, 11, 25), data: { nmo: { slots: days(2026, 11, 30).slice(25).map((ms) => [iso(ms), 'B']), events: {} } } });
  const r = run(w, 'dailyHealthCheck', true);
  const x = one(r, 'next_month_slots_none');
  ok('②-1 ★25日 7:05・翌月の枠0日 → next_month_slots_none（warn・件数1・段は翌月の解放）',
     x && x.severity === 'warn' && x.count === 1 && x.stage === '翌月の解放', JSON.stringify(keysOf(r)));
  ok('②-2 詳細に月・0日・出勤の日数（記号ごと）が出る', x && /^12月/.test(x.detail) && x.detail.indexOf('出勤のある日 0日') >= 0 && x.detail.indexOf('B:0') >= 0, x && x.detail);
  ok('②-3 facts は no_shift（出勤も0日）', x && JSON.stringify(x.safe) === '{"facts":["no_shift"]}', JSON.stringify(x && x.safe));
  ok('②-4 判定できた日は unknown を出さない・記録（open）も出さない', !one(r, 'next_month_slots_unknown') && !one(r, 'next_month_open'));

  //   出勤はあるのに枠が0（予定名の取り違え・枠の作り直しが翌月を覆っていない）
  const w2 = makeWorld({ now: at(2026, 11, 26), data: { nmo: { slots: NOV, events: { B: days(2026, 12, 20, 9).map((ms) => ({ title: '出勤', start: ms })) } } } });
  const x2 = one(run(w2, 'dailyHealthCheck', true), 'next_month_slots_none');
  ok('②-5 出勤20日・枠0日 → none（facts not_covered・B:20 が出る）', x2 && JSON.stringify(x2.safe.facts) === '["not_covered"]' && x2.detail.indexOf('B:20') >= 0 && x2.detail.indexOf('出勤のある日 20日') >= 0, x2 && x2.detail);

  //   非表示（オーナーと同じ形）のトレーナーにだけ枠がある＝顧客向けは0日
  const w3 = makeWorld({ now: at(2026, 11, 25), data: { nmo: { slots: days(2026, 12, 31).map((ms) => [iso(ms), 'A']) } } });
  const x3 = one(run(w3, 'dailyHealthCheck', true), 'next_month_slots_none');
  ok('②-6 ★非表示のトレーナーの枠だけ（31日）でも、顧客向けが0日なら出す（全体 31日／顧客向け 0日）', x3 && x3.detail.indexOf('全体 31日／顧客向け 0日') >= 0, x3 && x3.detail);

  //   出勤の予定名でないもの（予約・休憩）は出勤に数えない＝枠の計算と同じ isShiftEvent
  const w4 = makeWorld({ now: at(2026, 11, 25), data: { nmo: { slots: NOV, events: { C: [{ title: '[RESERVED] 架空', start: at(2026, 12, 3, 10, 0) }, { title: '休憩', start: at(2026, 12, 4, 12, 0) }] } } } });
  const x4 = one(run(w4, 'dailyHealthCheck', true), 'next_month_slots_none');
  ok('②-7 予約・休憩は出勤に数えない（C:0）', x4 && x4.detail.indexOf('C:0') >= 0 && JSON.stringify(x4.safe.facts) === '["no_shift"]', x4 && x4.detail);

  //   年をまたぐ（12/31 → 1月）
  const w5 = makeWorld({ now: at(2026, 12, 31, 7, 5), data: { nmo: { slots: days(2026, 12, 31).map((ms) => [iso(ms), 'B']), events: {} } } });
  const x5 = one(run(w5, 'dailyHealthCheck', true), 'next_month_slots_none');
  ok('②-8 12/31：翌年1月の枠が0日なら出す（12月の枠は数えない）', x5 && /^1月/.test(x5.detail), x5 && x5.detail);
  //   翌々月の枠は数えない
  const w6 = makeWorld({ now: at(2026, 11, 25), data: { nmo: { slots: days(2027, 1, 10).map((ms) => [iso(ms), 'B']) } } });
  ok('②-9 翌々月の枠は翌月に数えない', !!one(run(w6, 'dailyHealthCheck', true), 'next_month_slots_none'));
}

console.log('=== ③ 枠があれば出さない ===');
{
  const w = makeWorld({ now: at(2026, 11, 25) });   // 既定＝翌月に B の枠と出勤が28日
  const r = run(w, 'dailyHealthCheck', true);
  const o = one(r, 'next_month_open');
  ok('③-1 ★25日・翌月の枠あり → none も unknown も出ない', !one(r, 'next_month_slots_none') && !one(r, 'next_month_slots_unknown'), JSON.stringify(keysOf(r)));
  ok('③-2 記録（info）に顧客向けの枠のある日数（件数＝28）と出勤の日数が出る', o && o.severity === 'info' && o.count === 28 && o.detail.indexOf('出勤のある日 28日') >= 0, o && o.detail);
  const w2 = makeWorld({ now: at(2026, 11, 25), data: { nmo: { slots: [[iso(at(2026, 12, 15, 10, 0)), 'C']], events: {} } } });
  ok('③-3 顧客向けの枠が1日でもあれば none を出さない', !one(run(w2, 'dailyHealthCheck', true), 'next_month_slots_none'));
  const w3 = makeWorld({ now: at(2026, 11, 25), data: { nmo: { slots: [[new Date(at(2026, 12, 15, 10, 0)), 'C']], events: {} } } });
  ok('③-4 枠の開始がシートで日付型になっていても数える', one(run(w3, 'dailyHealthCheck', true), 'next_month_open').count === 1);
}

console.log('=== ④ 判定できないときは 0日と言わない ===');
{
  const base = { slots: NOV, events: {} };   // 読めれば none になる中身
  const cases = [
    ['④-1 写しが25日0時より前（24日23:55）＝翌月を覆っていない', { meta: iso(at(2026, 11, 24, 23, 55)) }, 'stale'],
    ['④-2 写しが4時間前', { meta: iso(at(2026, 11, 25, 3, 0)) }, 'stale'],
    ['④-3 meta が無い', { meta: null }, 'stale'],
    ['④-4 meta が壊れている', { meta: 'こわれた値' }, 'stale'],
    ['④-5 公開シートの枠のタブが無い', { slots: null }, 'unreadable'],
  ];
  for (const [name, o, why] of cases) {
    const w = makeWorld({ now: at(2026, 11, 25), data: { nmo: Object.assign({}, base, o) } });
    const r = run(w, 'dailyHealthCheck', true);
    const u = one(r, 'next_month_slots_unknown');
    ok(name + ' → unknown（' + why + '）・none は出さない', u && !one(r, 'next_month_slots_none') && JSON.stringify(u.safe.facts) === JSON.stringify([why]), JSON.stringify(keysOf(r)));
  }
  //   ★3時間以内でも、地平が伸びる前（24日）に作った写しは翌月を覆っていない
  {
    const w = makeWorld({ now: at(2026, 11, 25, 1, 0), data: { nmo: Object.assign({}, base, { meta: iso(at(2026, 11, 24, 23, 55)) }) } });
    const r = run(w, 'dailyHealthCheck', true);
    const u = one(r, 'next_month_slots_unknown');
    ok('④-1b ★25日 1:00・写しは65分前だが24日 23:55（地平が伸びる前）→ unknown（stale）・none は出さない', u && !one(r, 'next_month_slots_none') && JSON.stringify(u.safe.facts) === '["stale"]', JSON.stringify(keysOf(r)));
  }
  //   meta がシートの日付型で返っても読める
  const w = makeWorld({ now: at(2026, 11, 25), data: { nmo: { meta: new Date(at(2026, 11, 25, 6, 50)), slots: NOV, events: {} } } });
  ok('④-6 meta が日付型でも新しさを読める（none になる）', !!one(run(w, 'dailyHealthCheck', true), 'next_month_slots_none'));
  //   時間が足りない（日次点検がもう4分以上使った）→ 読まずに unknown
  const w2 = makeWorld({ now: at(2026, 11, 25) });
  const c = makeCtx(w2);
  let read = 0;
  const fake = () => { read++; return { builtAtMs: w2.now, metaBefore: w2.now, metaAfter: w2.now, totalRows: NOV.length, slots: NOV, shifts: { A: [], B: [], C: [] } }; };
  const r2 = c.lbNextMonthOpenCheck(w2.now, 4 * 60000 + 1, fake);
  ok('④-7 ★日次点検が4分を超えていたら読まずに unknown（no_time）', r2 && r2.kind === 'unknown' && JSON.stringify(r2.safe.facts) === '["no_time"]' && read === 0, JSON.stringify(r2));
  const r3 = c.lbNextMonthOpenCheck(w2.now, 4 * 60000, fake);
  ok('④-8 4分ちょうどまでは読む', r3 && r3.kind === 'none' && read === 1, JSON.stringify(r3));
  //   ★顧客向けトレーナーのカレンダーが1本でも読めなければ、原因を確定できない＝unknown（関門②）
  const w3 = makeWorld({ now: at(2026, 11, 25), data: { nmo: { slots: NOV, events: {}, calNull: ['C'] } } });
  const r3b = run(w3, 'dailyHealthCheck', true), u3 = one(r3b, 'next_month_slots_unknown');
  ok('④-9 ★顧客向けトレーナー（C）のカレンダーが読めない・枠0日 → none ではなく unknown（cal_unreadable）', u3 && !one(r3b, 'next_month_slots_none') && JSON.stringify(u3.safe.facts) === '["cal_unreadable"]' && u3.detail.indexOf('C:0') < 0, JSON.stringify(keysOf(r3b)));
  //   非表示（A）だけ読めないなら、顧客向けで判定できる＝none
  const w4 = makeWorld({ now: at(2026, 11, 25), data: { nmo: { slots: NOV, events: {}, calNull: ['A'] } } });
  const x4 = one(run(w4, 'dailyHealthCheck', true), 'next_month_slots_none');
  ok('④-10 非表示（A）のカレンダーだけ読めないなら none（「読めない A」と書く）', x4 && x4.detail.indexOf('読めない A') >= 0, x4 && x4.detail);
  //   ★公開シートの書き直し中（関門②）
  const wE = makeWorld({ now: at(2026, 11, 25), data: { nmo: { slots: [], events: {} } } });
  const rE = run(wE, 'dailyHealthCheck', true), uE = one(rE, 'next_month_slots_unknown');
  ok('④-11 ★slots が全体で0行（消した直後）→ unknown（rewriting）・none は出さない', uE && !one(rE, 'next_month_slots_none') && JSON.stringify(uE.safe.facts) === '["rewriting"]', JSON.stringify(keysOf(rE)));
  //   見出しだけ（0行）も同じ
  const wH2 = makeWorld({ now: at(2026, 11, 25), data: { nmo: { slots: [], events: { B: [] } } } });
  ok('④-12 見出しだけ（データ0行）も unknown', !!one(run(wH2, 'dailyHealthCheck', true), 'next_month_slots_unknown'));
  let n = 0;
  const t1 = iso(at(2026, 11, 25, 6, 50)), t2 = iso(at(2026, 11, 25, 7, 0));
  const wM = makeWorld({ now: at(2026, 11, 25), data: { nmo: { meta: () => (n++ === 0 ? t1 : t2), slots: NOV, events: {} } } });
  const rM = run(wM, 'dailyHealthCheck', true), uM = one(rM, 'next_month_slots_unknown');
  ok('④-13 ★slots を読む前と後で meta が変わった（読みの途中で書き直された）→ unknown（rewriting）', uM && !one(rM, 'next_month_slots_none') && JSON.stringify(uM.safe.facts) === '["rewriting"]' && n === 2, JSON.stringify(keysOf(rM)) + ' n=' + n);
  //   部分（今月の枠だけ・翌月が欠けた）で meta の前後が同じ＝書き終えた枠＝none（writeToSpreadsheet は全行を1回の setValues で書く）
  let n2 = 0;
  const wP = makeWorld({ now: at(2026, 11, 25), data: { nmo: { meta: () => { n2++; return t1; }, slots: NOV, events: {} } } });
  ok('④-14 meta の前後が同じなら判定する（none）・meta は2回読む', !!one(run(wP, 'dailyHealthCheck', true), 'next_month_slots_none') && n2 === 2, 'n2=' + n2);
}

console.log('=== ⑤ 点検そのものが落ちたら ===');
{
  const w = makeWorld({ now: at(2026, 11, 25), data: { throwIn: { openById: '架空の例外の文 090-0000-0000' } } });
  const r = run(w, 'dailyHealthCheck');
  const f = one(r, 'next_month_check_fail');
  ok('⑤-1 next_month_check_fail（warn）・例外の文は出さない', f && f.severity === 'warn' && f.detail.indexOf('090-0000') < 0 && f.detail.indexOf('架空の例外') < 0, f && f.detail);
  ok('⑤-2 ★段「翌月の解放」に完走の印を付けない（閉じない）', (status(w).checked || r.checked || []).indexOf('翌月の解放') < 0, JSON.stringify(r.checked));
  ok('⑤-3 台帳に AB として開く', incOf(w, 'next_month_check_fail').length === 1 && incOf(w, 'next_month_check_fail')[0].cls === 'AB', JSON.stringify(incOf(w, 'next_month_check_fail')));
}

console.log('=== ⑥ 本番の実行（要約・台帳）・出すのは日数と記号だけ ===');
{
  const w = makeWorld({ now: at(2026, 11, 25), data: { nmo: { slots: NOV, events: {} } } });
  const r = run(w, 'dailyHealthCheck');
  const it = (status(w).items || []).find((x) => x.k === 'next_month_slots_none');
  ok('⑥-1 要約に facts（no_shift）つきで載る', it && it.c === 1 && JSON.stringify(it.f) === '["no_shift"]', JSON.stringify(it));
  ok('⑥-2 台帳に B として開く', incOf(w, 'next_month_slots_none').length === 1 && incOf(w, 'next_month_slots_none')[0].cls === 'B');
  ok('⑥-3 段「翌月の解放」は完走（checked）', (r.checked || []).indexOf('翌月の解放') >= 0, JSON.stringify(r.checked));
  ok('⑥-4 悪化のメールに載る（初回）', w.mails.some((m) => m.body.indexOf('顧客が予約できる空き枠のある日が0日') >= 0));
  //   翌日も同じなら件数1のまま＝メールを毎日送らない
  w.now += 24 * 3600000; w.mails = [];
  run(w, 'dailyHealthCheck');
  ok('⑥-5 翌日も0日のまま → 悪化ではないのでメールしない（同じ問題を毎日送らない）', !w.mails.some((m) => m.body.indexOf('空き枠のある日が0日') >= 0), JSON.stringify(w.mails.map((m) => m.subject)));
  //   ★出力に氏名・予定名が入らない（予定名に架空の顧客名を入れても詳細に出ない）
  const w2 = makeWorld({ now: at(2026, 11, 25), data: { nmo: { slots: NOV, events: { B: [{ title: '出勤 テスト 太郎', start: at(2026, 12, 2, 9, 0) }] } } } });
  const x2 = one(run(w2, 'dailyHealthCheck', true), 'next_month_slots_none');
  ok('⑥-6 予定名（架空の名前入り）は詳細に出ない・数だけ', x2 && x2.detail.indexOf('テスト') < 0 && x2.detail.indexOf('B:1') >= 0, x2 && x2.detail);
}

console.log('=== ⑦ 配線：新しいトリガー・op を足さない／読む範囲は翌月だけ ===');
{
  const w = makeWorld({ now: at(2026, 11, 25) });
  const before = w.triggers.length;
  w.data.nmo = { events: {} };
  const c = makeCtx(w);
  const rg = c._lbNextMonthRange(new Date(w.now));
  ok('⑦-1 翌月の範囲は 12/1 0:00 〜 12/31 23:59:59（_lbBookingHorizonEnd と同じ）',
     rg && rg.from.getTime() === at(2026, 12, 1, 0, 0) && rg.to.getTime() === at(2026, 12, 31, 23, 59) + 59000 && rg.key === '2026-12', rg && JSON.stringify([iso(rg.from.getTime()), iso(rg.to.getTime())]));
  ok('⑦-2 24日は範囲なし（null）', c._lbNextMonthRange(new Date(at(2026, 11, 24, 23, 59))) === null);
  run(w, 'dailyHealthCheck', true);
  ok('⑦-3 点検でトリガーを作らない', w.triggers.length === before && w.created.length === 0);
  ok('⑦-4 カレンダーはトレーナーの数（3）だけ読む', w.calls.getCalendarById === 3, String(w.calls.getCalendarById));
}

t.end('設計57 翌月の空き枠の見張り');
