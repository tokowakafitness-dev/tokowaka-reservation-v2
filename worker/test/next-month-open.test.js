// 設計57：翌月の空き枠の見張り（日次点検・2026-11-25・関門② 再審で読み方を変えた）
//   実行: node worker/test/next-month-open.test.js
//   入口から通す：本物の dailyHealthCheck（gas/LineBooking.js）→ 本物の lbNextMonthOpenCheck → 本物の _lbNextMonthOpenRead
//     → 本物の枠の計算 buildAvailableSlots（gas/コード.js）→ 身代わりのカレンダー（_self-heal-harness.js）
//   ★公開シートは一切読まない（身代わりは開いたら落ちる）
//   I86 ① 24日までは何も読まず何も出さない ② 25日以降、顧客向け（非表示でない）トレーナーの翌月の枠のある日が0日なら
//       next_month_slots_none（出勤の日数も出す） ③ 枠があれば出さない（next_month_open は記録だけ）
//       ④ 顧客向けトレーナーのカレンダーが読めない・時間が足りない → 0日と言わず next_month_slots_unknown
//       ⑤ 点検そのものが落ちたら next_month_check_fail・段に印を付けない ⑥ 出すのは日数と記号だけ ⑦ シートを読まない・書かない
//   ★値はすべて架空（トレーナーは記号 A/B/C だけ）
import { makeWorld, run, makeCtx, status, incOf, tally } from './_self-heal-harness.js';

process.env.TZ = 'Asia/Tokyo';   // GAS のスクリプトの時間帯（JST）と同じにする
const t = tally();
const ok = t.ok;
const H = 3600000;
const at = (y, m, d, h = 7, mi = 5) => Date.UTC(y, m - 1, d, h - 9, mi);   // JST の日時
//   出勤（10〜20時）を y年m月の d0〜d1 日に
const shifts = (y, m, d0, d1, title = '出勤') => Array.from({ length: d1 - d0 + 1 }, (_, i) => ({ title, start: at(y, m, d0 + i, 10, 0), end: at(y, m, d0 + i, 20, 0) }));
const keysOf = (r) => (r.issues || []).filter((x) => /^next_month_/.test(x.key));
const one = (r, k) => (r.issues || []).find((x) => x.key === k);
const dry = (o) => { const w = makeWorld(o); const r = run(w, 'dailyHealthCheck', true); return { w, r }; };

console.log('=== ① 24日までは読まない・出さない ===');
{
  const { w, r } = dry({ now: at(2026, 11, 24, 7, 5), data: { nmo: { events: {} } } });   // 翌月の出勤0でも
  ok('①-1 24日 7:05：next_month_* は1つも出ない', keysOf(r).length === 0, JSON.stringify(keysOf(r)));
  ok('①-2 ★24日はカレンダーを読まない（重さを足さない）', !w.calls.getCalendarById, JSON.stringify(w.calls));
  ok('①-3 24日 23:59 も出さない', keysOf(dry({ now: at(2026, 11, 24, 23, 59), data: { nmo: { events: {} } } }).r).length === 0);
}

console.log('=== ② 25日・翌月の枠が0日なら出す ===');
{
  const { r } = dry({ now: at(2026, 11, 25), data: { nmo: { events: { B: shifts(2026, 11, 25, 30) } } } });   // 今月の出勤だけ
  const x = one(r, 'next_month_slots_none');
  ok('②-1 ★25日 7:05・翌月の出勤0＝枠0日 → next_month_slots_none（warn・件数1・段は翌月の解放）',
     x && x.severity === 'warn' && x.count === 1 && x.stage === '翌月の解放', JSON.stringify(keysOf(r)));
  ok('②-2 詳細に月・0日・出勤の日数（記号ごと）が出る', x && /^12月/.test(x.detail) && x.detail.indexOf('出勤のある日 0日') >= 0 && x.detail.indexOf('B:0') >= 0, x && x.detail);
  ok('②-3 facts は no_shift', x && JSON.stringify(x.safe) === '{"facts":["no_shift"]}', JSON.stringify(x && x.safe));
  ok('②-4 判定できた日は unknown も open も出さない', !one(r, 'next_month_slots_unknown') && !one(r, 'next_month_open'));

  //   出勤はあるのに全部予約・ブロックで埋まっている（本物の計算で枠が0になる）
  const busy = shifts(2026, 12, 1, 20).map((e) => ({ title: 'ブロック', start: e.start, end: e.end }));
  const { r: r2 } = dry({ now: at(2026, 11, 26), data: { nmo: { events: { B: shifts(2026, 12, 1, 20).concat(busy) } } } });
  const x2 = one(r2, 'next_month_slots_none');
  ok('②-5 ★出勤20日・全部ブロックで埋まる → none（not_covered・B:20）', x2 && JSON.stringify(x2.safe.facts) === '["not_covered"]' && x2.detail.indexOf('B:20') >= 0 && x2.detail.indexOf('出勤のある日 20日') >= 0, x2 && x2.detail);

  //   施設（B1）が埋まっていても枠は0（本物の計算が B1 を引く）
  const b1 = shifts(2026, 12, 1, 5).map((e) => ({ title: '[RESERVED] 架空', start: e.start, end: e.end }));
  const { r: rb } = dry({ now: at(2026, 11, 25), data: { nmo: { events: { B: shifts(2026, 12, 1, 5), B1: b1 } } } });
  ok('②-6 施設（B1）が全部埋まっている → none（枠の計算と同じ）', !!one(rb, 'next_month_slots_none'), JSON.stringify(keysOf(rb)));

  //   非表示（オーナーと同じ形）のトレーナーにだけ枠がある＝顧客向けは0日
  const { r: r3 } = dry({ now: at(2026, 11, 25), data: { nmo: { events: { A: shifts(2026, 12, 1, 31) } } } });
  const x3 = one(r3, 'next_month_slots_none');
  ok('②-7 ★非表示のトレーナーの枠だけ（31日）でも、顧客向けが0日なら出す（全体 31日／顧客向け 0日）', x3 && x3.detail.indexOf('全体 31日／顧客向け 0日') >= 0, x3 && x3.detail);

  //   予約・休憩は出勤に数えない（枠の計算と同じ isShiftEvent）
  const { r: r4 } = dry({ now: at(2026, 11, 25), data: { nmo: { events: { C: [{ title: '[RESERVED] 架空', start: at(2026, 12, 3, 10, 0), end: at(2026, 12, 3, 11, 0) }, { title: '休憩', start: at(2026, 12, 4, 12, 0), end: at(2026, 12, 4, 13, 0) }] } } } });
  const x4 = one(r4, 'next_month_slots_none');
  ok('②-8 予約・休憩は出勤に数えない（C:0）', x4 && x4.detail.indexOf('C:0') >= 0 && JSON.stringify(x4.safe.facts) === '["no_shift"]', x4 && x4.detail);

  //   年をまたぐ（12/31 → 1月）・12月の出勤は数えない
  const { r: r5 } = dry({ now: at(2026, 12, 31, 7, 5), data: { nmo: { events: { B: shifts(2026, 12, 1, 31) } } } });
  const x5 = one(r5, 'next_month_slots_none');
  ok('②-9 12/31：翌年1月の枠が0日なら出す（12月の枠は数えない）', x5 && /^1月/.test(x5.detail), x5 && x5.detail);
  //   翌々月の出勤は数えない
  ok('②-10 翌々月の出勤は翌月に数えない', !!one(dry({ now: at(2026, 11, 25), data: { nmo: { events: { B: shifts(2027, 1, 1, 10) } } } }).r, 'next_month_slots_none'));
}

console.log('=== ③ 枠があれば出さない ===');
{
  const { w, r } = dry({ now: at(2026, 11, 25) });   // 既定＝翌月に B の出勤が28日（10〜20時）
  const o = one(r, 'next_month_open');
  ok('③-1 ★25日・翌月の枠あり → none も unknown も出ない', !one(r, 'next_month_slots_none') && !one(r, 'next_month_slots_unknown'), JSON.stringify(keysOf(r)));
  ok('③-2 記録（info）に顧客向けの枠のある日数（件数＝28）と出勤の日数が出る', o && o.severity === 'info' && o.count === 28 && o.detail.indexOf('出勤のある日 28日') >= 0, o && o.detail);
  ok('③-3 ★12/1 の午前の枠も数える（いまを翌月1日の3時間前に置く＝前日22時締めの前）', !!o && (() => {
    const w2 = makeWorld({ now: at(2026, 11, 25), data: { nmo: { events: { B: [{ title: '出勤', start: at(2026, 12, 1, 7, 0), end: at(2026, 12, 1, 9, 0) }] } } } });
    const o2 = one(run(w2, 'dailyHealthCheck', true), 'next_month_open');
    return o2 && o2.count === 1;
  })());
  const { r: r2 } = dry({ now: at(2026, 11, 25), data: { nmo: { events: { C: [{ title: '出勤', start: at(2026, 12, 15, 10, 0), end: at(2026, 12, 15, 11, 0) }] } } } });
  ok('③-4 顧客向けの枠が1日（1枠）でもあれば none を出さない', !one(r2, 'next_month_slots_none') && one(r2, 'next_month_open').count === 1);
  ok('③-5 枠の計算が読む範囲は 11/30 21:00〜12/31 23:59:59（翌月だけ＋前夜3時間）', (w.calReads || []).every((x) => x[1] === at(2026, 11, 30, 21, 0) && x[2] === at(2026, 12, 31, 23, 59) + 59000), JSON.stringify(w.calReads));
}

console.log('=== ④ 判定できないときは 0日と言わない ===');
{
  //   ★顧客向けトレーナーのカレンダーが1本でも読めない → unknown
  const { r } = dry({ now: at(2026, 11, 25), data: { nmo: { events: {}, calNull: ['C'] } } });
  const u = one(r, 'next_month_slots_unknown');
  ok('④-1 ★顧客向けトレーナー（C）のカレンダーが読めない・枠0日 → none ではなく unknown（cal_unreadable）', u && !one(r, 'next_month_slots_none') && JSON.stringify(u.safe.facts) === '["cal_unreadable"]' && u.detail.indexOf('C:0') < 0, JSON.stringify(keysOf(r)));
  //   非表示（A）だけ読めないなら顧客向けで判定できる
  const x2 = one(dry({ now: at(2026, 11, 25), data: { nmo: { events: {}, calNull: ['A'] } } }).r, 'next_month_slots_none');
  ok('④-2 非表示（A）のカレンダーだけ読めないなら none（「読めない A」と書く）', x2 && x2.detail.indexOf('読めない A') >= 0, x2 && x2.detail);
  //   読めないカレンダーがあっても、顧客向けの枠があれば open
  ok('④-3 C が読めなくても B に枠があれば open', !!one(dry({ now: at(2026, 11, 25), data: { nmo: { calNull: ['C'] } } }).r, 'next_month_open'));
  //   時間が足りない → 読まずに unknown
  const w2 = makeWorld({ now: at(2026, 11, 25) });
  const c = makeCtx(w2);
  let read = 0;
  const fake = () => { read++; return { slots: [], shifts: { A: [], B: [], C: [] } }; };
  const r2 = c.lbNextMonthOpenCheck(w2.now, 3 * 60000, fake);
  ok('④-4 ★点検の経過が3分ちょうどなら数え始めず unknown（no_time）', r2 && r2.kind === 'unknown' && JSON.stringify(r2.safe.facts) === '["no_time"]' && read === 0, JSON.stringify(r2));
  const r3 = c.lbNextMonthOpenCheck(w2.now, 3 * 60000 - 1000, fake);
  ok('④-5 2分59秒なら数える', r3 && r3.kind === 'none' && read === 1, JSON.stringify(r3));
  //   遅いカレンダー（1本20秒×4本）→ かかった秒数が詳細に残る
  const { r: rs } = dry({ now: at(2026, 11, 25), data: { nmo: { calDelayMs: 20000 } } });
  const os = one(rs, 'next_month_open');
  ok('④-5b ★かかった時間（80秒）を詳細に残す', os && os.detail.indexOf('数えるのに80秒') >= 0, os && os.detail);
  const { r: rs2 } = dry({ now: at(2026, 11, 25), data: { nmo: { events: {}, calDelayMs: 15000 } } });
  ok('④-5c none の詳細にも残す（60秒）', (one(rs2, 'next_month_slots_none') || {}).detail.indexOf('数えるのに60秒') >= 0, JSON.stringify(keysOf(rs2)));
  //   読んだ記録が残っていない（計算が途中で読みを残さなかった）→ 全員読めない扱い＝unknown
  const r4 = c._lbNextMonthOpenRead && (() => { const cc = makeCtx(makeWorld({ now: at(2026, 11, 25) })); cc.buildAvailableSlots = () => []; return cc.lbNextMonthOpenCheck(at(2026, 11, 25), 0); })();
  ok('④-6 出勤を読んだ記録が無ければ 0日と言わない（unknown）', r4 && r4.kind === 'unknown', JSON.stringify(r4));
}

console.log('=== ⑤ 点検そのものが落ちたら ===');
{
  const w = makeWorld({ now: at(2026, 11, 25), data: { throwIn: { getCalendarById: '架空の例外の文 090-0000-0000' } } });
  const r = run(w, 'dailyHealthCheck');
  const f = one(r, 'next_month_check_fail');
  ok('⑤-1 next_month_check_fail（warn）・例外の文は出さない', f && f.severity === 'warn' && f.detail.indexOf('090-0000') < 0 && f.detail.indexOf('架空の例外') < 0, f && f.detail);
  ok('⑤-2 ★段「翌月の解放」に完走の印を付けない（閉じない）', (r.checked || []).indexOf('翌月の解放') < 0, JSON.stringify(r.checked));
  ok('⑤-3 台帳に AB として開く', incOf(w, 'next_month_check_fail').length === 1 && incOf(w, 'next_month_check_fail')[0].cls === 'AB');
}

console.log('=== ⑥ 本番の実行（要約・台帳）・出すのは日数と記号だけ ===');
{
  const w = makeWorld({ now: at(2026, 11, 25), data: { nmo: { events: {} } } });
  const r = run(w, 'dailyHealthCheck');
  const it = (status(w).items || []).find((x) => x.k === 'next_month_slots_none');
  ok('⑥-1 要約に facts（no_shift）つきで載る', it && it.c === 1 && JSON.stringify(it.f) === '["no_shift"]', JSON.stringify(it));
  ok('⑥-2 台帳に B として開く', incOf(w, 'next_month_slots_none').length === 1 && incOf(w, 'next_month_slots_none')[0].cls === 'B');
  ok('⑥-3 段「翌月の解放」は完走（checked）', (r.checked || []).indexOf('翌月の解放') >= 0, JSON.stringify(r.checked));
  ok('⑥-4 悪化のメールに載る（初回）', w.mails.some((m) => m.body.indexOf('顧客が予約できる空き枠のある日が0日') >= 0));
  w.now += 24 * H; w.mails = [];
  run(w, 'dailyHealthCheck');
  ok('⑥-5 翌日も0日のまま → 悪化ではないのでメールしない', !w.mails.some((m) => m.body.indexOf('空き枠のある日が0日') >= 0), JSON.stringify(w.mails.map((m) => m.subject)));
  //   予定名に架空の名前を入れても詳細に出ない
  const { r: r2 } = dry({ now: at(2026, 11, 25), data: { nmo: { events: { B: [{ title: '出勤 テスト 太郎', start: at(2026, 12, 2, 10, 0), end: at(2026, 12, 2, 20, 0) }, { title: 'ブロック', start: at(2026, 12, 2, 10, 0), end: at(2026, 12, 2, 20, 0) }] } } } });
  const x2 = one(r2, 'next_month_slots_none');
  ok('⑥-6 予定名（架空の名前入り）は詳細に出ない・数だけ', x2 && x2.detail.indexOf('テスト') < 0 && x2.detail.indexOf('B:1') >= 0, x2 && x2.detail);
}

console.log('=== ⑦ 配線：シートを読まない・トリガーを作らない・範囲 ===');
{
  const w = makeWorld({ now: at(2026, 11, 25) });
  const before = w.triggers.length;
  const r = run(w, 'dailyHealthCheck', true);
  ok('⑦-1 ★公開シート（SpreadsheetApp.openById）を一度も開かない', !w.calls.openById && !one(r, 'next_month_check_fail'), JSON.stringify(w.calls));
  ok('⑦-2 点検でトリガーを作らない', w.triggers.length === before && w.created.length === 0);
  ok('⑦-3 ★カレンダーは施設1本＋トレーナー3本を1回ずつ（出勤は枠の計算の読みを使い回す＝二重に読まない）', w.calls.getCalendarById === 4 && (w.calReads || []).length === 4, String(w.calls.getCalendarById) + ' ' + JSON.stringify(w.calReads));
  const c = makeCtx(w);
  const rg = c._lbNextMonthRange(new Date(w.now));
  ok('⑦-4 翌月の範囲は 12/1 0:00 〜 12/31 23:59:59（_lbBookingHorizonEnd と同じ）',
     rg && rg.from.getTime() === at(2026, 12, 1, 0, 0) && rg.to.getTime() === at(2026, 12, 31, 23, 59) + 59000 && rg.key === '2026-12');
  ok('⑦-5 24日は範囲なし（null）', c._lbNextMonthRange(new Date(at(2026, 11, 24, 23, 59))) === null);
}

t.end('設計57 翌月の空き枠の見張り');
