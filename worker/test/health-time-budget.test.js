// 日次点検の時間の上限（2026-11-28）
//   実行: node worker/test/health-time-budget.test.js
//   背景：11/26 07:52 を最後に dailyHealthCheck が完走していない。11/28 は始まったが最後まで来ず（見立て＝実行時間の上限で打ち切られた）、
//         打ち切られた実行の借りる印（LB_HEALTH_LEASE・35分）が残って作業依頼の点検が held で見送られた。11/27 は印を取る
//         ScriptLock の1回の 300ms で lock_busy になり、その日の点検が消えた。
//   不変条件：I-H36（T1〜T3・T6・T7）・I-H20（T4・T5：印の期限10分・印を取るロックの試し直し）
//   入口から通す：本物の dailyHealthCheck（_self-heal-harness.js の vm）。時計は w.now（身代わりの段で進める）
//   T1 普段は完走し、段ごとの経過を全部 LB_HEALTH_STEP に残す
//   T2 ★開始から4分を過ぎたら次の段に入らない：記録とメールはする・要約・台帳・DONE は書かない・印を放す
//   T3 打ち切った回は、見ていない段の key の前回の数を消さない（次に完走したとき同じ数を「悪化」として送り直さない）
//   T4 印を取る ScriptLock が混んでいれば数回試す（全部だめなら今どおり lock_busy）
//   T5 印は10分＝時間切れで残った印は10分で切れ、次の点検・作業依頼が取れる
//   T6 試し実行（作業依頼 health）は段ごとの経過を返す・LB_HEALTH_STEP は書かない
//   T7 Nudge の「途中で」のメールに段ごとの経過が載り、打ち切りと落ちたのを見分ける
//   ★値はすべて架空
import vm from 'node:vm';
import { makeWorld, run, status, incRows, lease, tally, NUDGE } from './_self-heal-harness.js';
import { pluckFnFrom as pluckFn } from './_gas-lock-src.js';

const t = tally();
const ok = t.ok;
const MIN = 60000, H = 3600000;

console.log('=== T1 普段は完走し、段ごとの経過を全部残す ===');
{
  const w = makeWorld();
  const r = run(w, 'dailyHealthCheck');
  ok('T1-1 完走（要約・DONE を書く・打ち切りなし）', r.saved && r.saved.saved === true && !!w.props.LB_HEALTH_DONE && r.partial === '', JSON.stringify({ s: r.saved, p: r.partial }));
  const st = String(w.props.LB_HEALTH_STEP || '');
  ok('T1-2 ★LB_HEALTH_STEP に最初の段から最後の段まで全部ある（直近6段ではない）',
     /開始=\d+/.test(st) && /会員データ=\d+/.test(st) && /保全部隊の見張り=\d+/.test(st) && /^記録@/.test(st), st);
  ok('T1-3 打ち切りの印は無い', !/打ち切り/.test(st) && !r.issues.some((x) => x.key === 'health_partial'));
  ok('T1-4 返り値に段の一覧', Array.isArray(r.steps) && r.steps.length >= 20, JSON.stringify(r.steps));
}

console.log('=== T2 開始から4分を過ぎたら次の段に入らない ===');
{
  const w = makeWorld({ data: { dataHealth: { dupEv: [], dupSlot: [], unlinked: 0, unlinkedList: [], future: [], transferAll: 3, transferThisMonth: 1 } } });   // 打ち切りより前の段（予約データ）の項目
  w.hooks.debugOrphanEvents = () => { w.now += 5 * MIN; };   // カレンダーの段が5分かかった
  const t0 = w.now;
  const r = run(w, 'dailyHealthCheck');
  ok('T2-1 ★「通知」の段で打ち切った', r.partial === '通知', JSON.stringify({ p: r.partial, s: r.steps }));
  ok('T2-2 ★後ろの段は呼ばない', !w.calls.getBookingMetrics && !w.calls.lbContractInputCheck && !w.calls.lbWriteShadowDailyCheck && !w.calls._edgeQuotaStatus,
     JSON.stringify(w.calls));
  ok('T2-3 ★要約・DONE・台帳を書かない（完走の印の意味は変えない）', !w.props.LB_HEALTH_DONE && !w.props.LB_HEALTH_STATUS && incRows(w).length === 0 && r.saved === null,
     JSON.stringify({ d: w.props.LB_HEALTH_DONE, s: !!w.props.LB_HEALTH_STATUS }));
  ok('T2-4 開始の印（LAST）は書いている＝LAST > DONE で Nudge が鳴る', w.props.LB_HEALTH_LAST === String(t0));
  const hs = JSON.stringify((w.sheets.health_status || { data: [] }).data);
  ok('T2-5 ★記録（health_status）に打ち切りと、打ち切りより前の段で見つけた問題が載る', /「通知」から先の段を見ずに打ち切りました/.test(hs) && /振替で取られた予約が累計3件/.test(hs), hs.slice(0, 400));
  ok('T2-6 ★悪化のメールが出る（打ち切りを含む）', w.mails.some((m) => /システム点検で/.test(m.subject) && /打ち切りました/.test(m.body)), JSON.stringify(w.mails.map((m) => m.subject)));
  ok('T2-7 LB_HEALTH_STEP は「打ち切り@通知」で始まり、各段の経過が残る', /^打ち切り@通知@\d+ms→記録@/.test(w.props.LB_HEALTH_STEP || '') && /カレンダー=\d+/.test(w.props.LB_HEALTH_STEP), w.props.LB_HEALTH_STEP);
  ok('T2-8 ★印を放した（後続の点検・作業依頼が held にならない）', lease(w) === null);
  ok('T2-9 見送りとして数えない（打ち切りは見送りではない）', !w.props.LB_HEALTH_SKIP, w.props.LB_HEALTH_SKIP);
  const det = (r.issues.find((x) => x.key === 'health_partial') || {}).detail || '';
  ok('T2-10 打ち切りの文は段の名前と秒数だけ（例外の文・氏名を出さない）', /開始から300秒/.test(det) && !/テスト|U0000|@/.test(det), det);
  //   翌日：普通に完走すれば DONE が進み、打ち切りの key は消える
  w.now += 24 * H; delete w.hooks.debugOrphanEvents;
  const r2 = run(w, 'dailyHealthCheck');
  ok('T2-11 次に完走すれば DONE が進む', r2.saved && r2.saved.saved === true && w.props.LB_HEALTH_DONE === String(r2.checkId));
  ok('T2-12 完走した要約に health_partial は無い', !(status(w).items || []).some((x) => x.k === 'health_partial'));
}

console.log('=== T2b 打ち切りの境目（4分ちょうどで次の段に入らない・手前なら入る）===');
{
  const w = makeWorld();
  w.hooks.debugOrphanEvents = () => { w.now += 4 * MIN - 1; };
  const r = run(w, 'dailyHealthCheck');
  ok('T2b-1 4分の手前なら次の段に入る', r.partial !== '通知' && w.calls.getBookingMetrics === 1, JSON.stringify({ p: r.partial }));
  const w2 = makeWorld();
  w2.hooks.debugOrphanEvents = () => { w2.now += 4 * MIN; };
  const r2 = run(w2, 'dailyHealthCheck');
  ok('T2b-2 4分ちょうどで打ち切る', r2.partial === '通知' && !w2.calls.getBookingMetrics);
}

console.log('=== T3 打ち切った回は見ていない段の前回の数を消さない ===');
{
  const w = makeWorld({ data: { ws: { danger: 2, notRunning: 0, partial: 0, backlog: 0, unprotected: 0, protectBlocked: 0, writeFail: 0, failSeen: 0 } } });
  run(w, 'dailyHealthCheck');   // 1日目：完走・ws_danger 2
  ok('T3-1 1日目に ws_danger を数えた', JSON.parse(w.props.LB_HEALTH_PREV).ws_danger === 2, w.props.LB_HEALTH_PREV);
  w.now += 24 * H; w.mails = [];
  w.hooks.debugOrphanEvents = () => { w.now += 5 * MIN; };
  run(w, 'dailyHealthCheck');   // 2日目：打ち切り（書き込みの比較の段は見ていない）
  ok('T3-2 ★打ち切った回も ws_danger の前回の数を残す', JSON.parse(w.props.LB_HEALTH_PREV).ws_danger === 2, w.props.LB_HEALTH_PREV);
  w.now += 24 * H; w.mails = []; delete w.hooks.debugOrphanEvents;
  run(w, 'dailyHealthCheck');   // 3日目：完走・ws_danger は同じ 2
  const worse = w.mails.filter((m) => /悪化/.test(m.subject)).map((m) => m.body.split('---- 全体 ----')[0]).join('\n');
  ok('T3-3 ★次に完走したとき、同じ数を「悪化」として送り直さない（悪化の欄に ws_danger が無い）', !/危険側の食い違い/.test(worse), worse);
  ok('T3-4 完走した回は今どおり（打ち切りの key は残らない）', !('health_partial' in JSON.parse(w.props.LB_HEALTH_PREV)), w.props.LB_HEALTH_PREV);
}

console.log('=== T4 印を取る ScriptLock が混んでいれば数回試す ===');
{
  const w = makeWorld();
  w.lockBusyFn = (n) => n <= 2;   // 最初の2回は予約などが持っている
  const r = run(w, 'dailyHealthCheck');
  ok('T4-1 ★2回混んでいても3回目で取れて完走する', !r.skipped && r.saved && r.saved.saved === true, JSON.stringify(r.skipped || r.saved));
  const w2 = makeWorld(); w2.lockBusy = true;
  const r2 = run(w2, 'dailyHealthCheck');
  ok('T4-2 ずっと混んでいれば今どおり lock_busy（何も書かない）', r2.skipped === 'lock_busy' && !w2.props.LB_HEALTH_LAST && w2.lockN === 6, JSON.stringify({ s: r2.skipped, n: w2.lockN }));
  ok('T4-3 見送りを数える（翌日の health_skipped）', JSON.parse(w2.props.LB_HEALTH_SKIP || '{}').why === 'lock_busy');
  //   修理（lbSelfHeal）は今どおり1回だけ（10時のうながしの予算を待ちで使わない）
  const w3 = makeWorld({ props: { SELF_HEAL_MODE: 'on' } }); w3.lockBusy = true;
  const n0 = w3.lockN || 0;
  run(w3, 'lbSelfHeal');
  ok('T4-4 修理の印は1回だけ試す（今どおり）', (w3.lockN || 0) - n0 === 1, String((w3.lockN || 0) - n0));
}

console.log('=== T5 時間切れで残った印は10分で切れる ===');
{
  //   打ち切られた実行（finally が走らない）を再現：本物の点検の段の途中の印を写し取り、走り終えた後に戻す（＝放されなかった印）
  const w = makeWorld();
  let snap = null, tSnap = 0;
  w.hooks.debugOrphanEvents = () => { snap = w.props.LB_HEALTH_LEASE; tSnap = w.now; };
  run(w, 'dailyHealthCheck', true);
  delete w.hooks.debugOrphanEvents;
  w.props.LB_HEALTH_LEASE = snap;
  ok('T5-0 段の途中で印を持っていた（写し取れた）', !!snap && JSON.parse(snap).entry === 'check_dry', String(snap));
  w.now = tSnap + 9 * MIN;
  const r1 = run(w, 'dailyHealthCheck', true);
  ok('T5-1 9分後はまだ held（生きているかもしれない）', r1.skipped === 'held');
  w.now = tSnap + 11 * MIN;
  const r2 = run(w, 'dailyHealthCheck', true);
  ok('T5-2 ★11分後は取れる（35分待たない）', !r2.skipped && Array.isArray(r2.issues), JSON.stringify(r2.skipped));
}

console.log('=== T6 試し実行は段ごとの経過を返す・LB_HEALTH_STEP は書かない ===');
{
  const w = makeWorld();
  w.props.LB_HEALTH_STEP = '前の本番の記録';
  w.hooks.debugOrphanEvents = () => { w.now += 5 * MIN; };
  const r = run(w, 'dailyHealthCheck', true);
  ok('T6-1 試し実行も打ち切り、段の一覧と打ち切った段を返す', r.partial === '通知' && r.steps.some((x) => /^カレンダー=\d+$/.test(x)) && r.steps.indexOf('通知=cut') >= 0, JSON.stringify(r.steps));
  ok('T6-2 試し実行は LB_HEALTH_STEP・LAST を書かない', w.props.LB_HEALTH_STEP === '前の本番の記録' && !w.props.LB_HEALTH_LAST);
  ok('T6-3 試し実行は記録・メールをしない', !w.sheets.health_status && w.mails.length === 0);
}

console.log('=== T7 Nudge のメールに段ごとの経過が載る ===');
{
  function nudge(props, now) {
    const st = { props: Object.assign({}, props), mails: [] };
    const ctx = {
      String, Number, Math, JSON, Date, isFinite,
      SETTINGS: { TIMEZONE: 'Asia/Tokyo' }, Logger: { log: () => {} },
      Utilities: { formatDate: (d) => new Date(d).toISOString() },
      _lbProp: (k) => (k in st.props ? st.props[k] : null),
      PropertiesService: { getScriptProperties: () => ({ setProperty: (k, v) => { st.props[k] = String(v); } }) },
      _lbAlertEmail: () => 'owner@example.invalid',
      GmailApp: { sendEmail: (to, s, b) => st.mails.push({ s, b }) },
    };
    vm.createContext(ctx);
    vm.runInContext(pluckFn(NUDGE, '_lbNudgeWatchHealthCrash'), ctx);
    ctx._lbNudgeWatchHealthCrash(now, Number(props.LB_HEALTH_LAST));
    return st;
  }
  const now = Date.UTC(2026, 10, 28, 1);
  const base = { LB_HEALTH_LAST: String(now - 3 * H), LB_HEALTH_DONE: String(now - 51 * H) };
  const a = nudge(Object.assign({ LB_HEALTH_STEP: '打ち切り@通知@300000ms→記録@300001ms / 開始=0 カレンダー=1000 通知=cut 記録=300001' }, base), now);
  ok('T7-1 ★打ち切りなら「打ち切られています」・段ごとの経過が本文に載る', a.mails.length === 1 && /打ち切られています/.test(a.mails[0].b) && /カレンダー=1000/.test(a.mails[0].b), JSON.stringify(a.mails));
  const b = nudge(Object.assign({ LB_HEALTH_STEP: '世代の追いつき@200000ms / 開始=0 世代の追いつき=200000' }, base), now);
  ok('T7-2 落ちたなら今どおり「途中で落ちています」・最後に入った段が載る', b.mails.length === 1 && /途中で落ちています/.test(b.mails[0].b) && /世代の追いつき=200000/.test(b.mails[0].b), JSON.stringify(b.mails));
  const c = nudge(base, now);
  ok('T7-3 記録が無くても今どおり送る', c.mails.length === 1 && !/段ごとの経過/.test(c.mails[0].b));
}

t.end('日次点検の時間の上限');
