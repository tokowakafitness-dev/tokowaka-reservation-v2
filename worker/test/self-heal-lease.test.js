// 自己修理 P1：同時に1本だけ（借りる印）と見張り（2026-11-23）
//   実行: node worker/test/self-heal-lease.test.js
//   I-H20 点検・修理は同時に1本だけ。印は35分・段ごとに延長。ScriptLock は印を取る・放す瞬間だけ
//   I-H21 副作用の直前に印の owner を確かめ、違えば止まる
//   I-H22 壊れた印は期限切れとみなさず見送り、lease_broken を記録（lbNudgeDaily がメール）
//   I-H26 印の owner は実行ごとに一意（check_id と別）
//   I-H27 期限切れの印を持つ実行は、owner が一致しても副作用をしない
//   I-H24 Nudge は DONE 未設定の間「途中で落ちた」を出さない・正常完走で誤報しない
//   I-H16 lbSelfHeal の完走を翌日の点検が、点検の完走を lbNudgeDaily が確かめる
//   ★値はすべて架空
import vm from 'node:vm';
import { makeWorld, run, status, incRows, incOf, removeTrigger, countTrigger, tally, lease, NUDGE } from './_self-heal-harness.js';
import { pluckFnFrom as pluckFn } from './_gas-lock-src.js';

const t = tally();
const ok = t.ok;
const H = 3600000, MIN = 60000;

console.log('=== I-H20 同時に1本だけ・段ごとに延長 ===');
{
  const w = makeWorld({ props: { SELF_HEAL_MODE: 'on' } });
  removeTrigger(w, 'dailySync');
  const seen = [];
  //   点検の段の途中で、30分ずつ時計を進めながら別の実行を起こす（延長が無ければ2回目で期限が切れる）
  for (const fn of ['debugDataHealth', 'debugOrphanEvents', 'getBookingMetrics', '_lbQuotaFetch']) {
    w.hooks[fn] = () => {
      w.now += 30 * MIN;
      seen.push(['heal', run(w, 'lbSelfHeal').gate]);
      seen.push(['check', run(w, 'dailyHealthCheck').skipped]);
    };
  }
  const r = run(w, 'dailyHealthCheck');
  ok('I-H20-1 ★点検が段を進める間（合計2時間）、修理も別の点検も印を取れない', seen.length === 8 && seen.every((x) => x[1] === 'skip_held' || x[1] === 'held'), JSON.stringify(seen));
  ok('I-H20-2 その間トリガーは足されていない', w.created.length === 0);
  ok('I-H20-3 点検そのものは最後まで来て保存した', r.saved && r.saved.saved === true, JSON.stringify(r.saved));
  ok('I-H20-4 終わったら印は消える', lease(w) === null);
  ok('I-H20-5 見送りを数えた（8回）', JSON.parse(w.props.LB_HEALTH_SKIP).count === 8, w.props.LB_HEALTH_SKIP);
  //   印の期限は 35 分
  const w2 = makeWorld();
  let L = null;
  w2.hooks.debugDataHealth = () => { L = lease(w2); };
  run(w2, 'dailyHealthCheck');
  ok('I-H20-6 印の期限は「いま＋35分」', L && L.until === w2.now + 35 * MIN && L.entry === 'check', JSON.stringify(L));
  //   ScriptLock が取れなければ見送り（lock_busy）・何も書かない
  const w3 = makeWorld(); w3.lockBusy = true;
  const r3 = run(w3, 'dailyHealthCheck');
  ok('I-H20-7 ScriptLock が取れなければ点検は走らない（lock_busy）', r3.skipped === 'lock_busy' && !w3.props.LB_HEALTH_LAST && !w3.props.LB_HEALTH_STATUS);
  //   ScriptLock を長く持たない：本物のソースで tryLock に渡すのは LOCK_MS（300ms）だけ・waitLock を使わない
  const blk = (await import('./_self-heal-harness.js')).healBlock();
  ok('I-H20-8 ScriptLock は tryLock(300ms) だけ（waitLock を使わない）', /LOCK_MS: 300,/.test(blk) && /tryLock\(LB_HEAL\.LOCK_MS\)/.test(blk) && !/waitLock/.test(blk));
}

console.log('=== I-H21 副作用の直前に owner を確かめる ===');
{
  const w = makeWorld({ data: { quota: { ok: true, limited: true, left: 0, pct: 100 } } });
  //   最後の段（契約の入力）で、別の実行が印を奪った（期限内）
  w.hooks.lbContractInputCheck = () => { w.props.LB_HEALTH_LEASE = JSON.stringify({ owner: 'other', until: w.now + 30 * MIN, entry: 'heal' }); };
  const r = run(w, 'dailyHealthCheck');
  ok('I-H21-1 ★印を失った点検はその時点で終える（要約・完走の印を書かない・leaseLost）', !w.props.LB_HEALTH_STATUS && !w.props.LB_HEALTH_DONE && r.leaseLost === true && r.skipped === 'lost', JSON.stringify(r));
  ok('I-H21-2 台帳を作らない・オーナーへ送らない', !w.sheets.incidents && !w.mails.some((m) => /オーナーにしかできないこと/.test(m.subject)) && w.pushes.length === 0);
  ok('I-H21-3 他人の印は消さない', lease(w) && lease(w).owner === 'other');
  ok('I-H21-4 ★既存の副作用もしない（health_status の追記・LB_HEALTH_PREV・悪化メール）', !w.sheets.health_status && !w.props.LB_HEALTH_PREV && w.mails.length === 0, JSON.stringify({ hs: !!w.sheets.health_status, prev: w.props.LB_HEALTH_PREV, m: w.mails.length }));
  //   通知の後ろ回しの引き渡し（lbNotifyDeferDailyMaint）の直前に奪われた → 呼ばない
  const wm = makeWorld();
  let maint = 0;
  wm.hooks.lbAutoBookHeldDailyCheck = null;
  wm.hooks.lbCalSlotsDailyCheck = () => { wm.props.LB_HEALTH_LEASE = JSON.stringify({ owner: 'other', until: wm.now + 30 * MIN, entry: 'heal' }); };
  wm.hooks.lbNotifyDeferDailyMaint = () => { maint++; };
  run(wm, 'dailyHealthCheck');
  const wc = makeWorld(); run(wc, 'dailyHealthCheck');
  ok('I-H21-8 ★lbNotifyDeferDailyMaint の直前に確かめる（奪われていれば呼ばない・陽性の対照：普段は1回呼ぶ）', maint === 0 && (wm.calls.lbNotifyDeferDailyMaint || 0) === 0 && !wm.sheets.health_status && wc.calls.lbNotifyDeferDailyMaint === 1);
  //   最後の段の後（悪化の記録 LB_HEALTH_PREV を書くとき）に奪われた → 保存の入口の確認で止まる
  const w1 = makeWorld();
  w1.hooks.setProperty = (k) => { if (k === 'LB_HEALTH_PREV' && w1.depth === 1) w1.props.LB_HEALTH_LEASE = JSON.stringify({ owner: 'other', until: w1.now + 30 * MIN, entry: 'heal' }); };
  const r1 = run(w1, 'dailyHealthCheck');
  ok('I-H21-7 ★段を全部終えた後に奪われても、次の書き込みの直前（悪化メール・保存）で止まる', !w1.props.LB_HEALTH_STATUS && !w1.props.LB_HEALTH_DONE && !w1.sheets.incidents && r1.leaseLost === true, JSON.stringify(r1));
  //   ★早い段で奪われた → 以降の段を走らせない（段ごとの確認で終える）
  const w6 = makeWorld();
  w6.hooks.debugDataHealth = () => { w6.props.LB_HEALTH_LEASE = JSON.stringify({ owner: 'other', until: w6.now + 30 * MIN, entry: 'heal' }); };
  const r6 = run(w6, 'dailyHealthCheck');
  ok('I-H21-10 ★印を失った段の次の段から先を走らせない（契約の入力・二重書きの点検を呼ばない）', r6.leaseLost === true && !w6.calls.lbContractInputCheck && !w6.calls.lbDwDailyCheck, JSON.stringify(w6.calls));
  //   ★「記録」の段に入った直後に奪われた → health_status の追記の直前の確認で止まる
  const w7 = makeWorld();
  w7.hooks.setProperty = (k, v) => { if (k === 'LB_HEALTH_STEP' && /^記録@/.test(String(v)) && w7.depth === 1) w7.props.LB_HEALTH_LEASE = JSON.stringify({ owner: 'other', until: w7.now + 30 * MIN, entry: 'heal' }); };
  run(w7, 'dailyHealthCheck');
  ok('I-H21-11 ★health_status の追記の直前に確かめる', !w7.sheets.health_status && !w7.props.LB_HEALTH_PREV);
  //   ★LB_HEALTH_PREV を書いた直後に奪われた（悪化あり）→ 悪化メールの直前の確認で止まる
  const w8 = makeWorld({ data: { quota: { ok: true, limited: true, left: 0, pct: 100 } } });
  w8.hooks.setProperty = (k) => { if (k === 'LB_HEALTH_PREV' && w8.depth === 1) w8.props.LB_HEALTH_LEASE = JSON.stringify({ owner: 'other', until: w8.now + 30 * MIN, entry: 'heal' }); };
  run(w8, 'dailyHealthCheck');
  const w8c = makeWorld({ data: { quota: { ok: true, limited: true, left: 0, pct: 100 } } }); run(w8c, 'dailyHealthCheck');
  ok('I-H21-12 ★悪化メールの直前に確かめる（陽性の対照：奪われなければ悪化メールが出る）', w8.mails.length === 0 && w8c.mails.some((m) => /悪化/.test(m.subject)), JSON.stringify(w8c.mails.map((m) => m.subject)));
  //   ★health_status を書いた直後に奪われた → LB_HEALTH_PREV の直前の確認で止まる
  const { makeSheet } = await import('./_self-heal-harness.js');
  const w9 = makeWorld();
  w9.sheets.health_status = makeSheet('health_status', [['点検時刻', '区分', '重大度', '件数', '内容']]);
  w9.sheets.health_status.onWrite = () => { w9.props.LB_HEALTH_LEASE = JSON.stringify({ owner: 'other', until: w9.now + 30 * MIN, entry: 'heal' }); };
  run(w9, 'dailyHealthCheck');
  ok('I-H21-13 ★LB_HEALTH_PREV の直前に確かめる', w9.sheets.health_status.data.length >= 2 && !w9.props.LB_HEALTH_PREV);
  //   保存の途中（要約を書いた直後）に奪われた → SINCE・台帳・DONE を書かない
  const w5 = makeWorld();
  w5.hooks.setProperty = (k) => { if (k === 'LB_HEALTH_STATUS' && w5.depth === 1) w5.props.LB_HEALTH_LEASE = JSON.stringify({ owner: 'other', until: w5.now + 30 * MIN, entry: 'heal' }); };
  const r5 = run(w5, 'dailyHealthCheck');
  ok('I-H21-9 ★_lbHealthSave の各書き込みの直前に確かめる（要約の後に奪われたら SINCE・台帳・DONE なし）', !w5.props.LB_HEALTH_SINCE && !w5.sheets.incidents && !w5.props.LB_HEALTH_DONE && r5.saved && r5.saved.saved === false, JSON.stringify(r5.saved));
  //   ★DONE を書いた直後に奪われた → 完走は確定済み。確かめ直さない（SKIP を数えない・saved:true）＝関門②2回目 CEO 裁定
  const w5d = makeWorld();
  w5d.hooks.setProperty = (k) => { if (k === 'LB_HEALTH_DONE' && w5d.depth === 1) w5d.props.LB_HEALTH_LEASE = JSON.stringify({ owner: 'other', until: w5d.now - 1, entry: 'heal' }); };
  const r5d = run(w5d, 'dailyHealthCheck');
  ok('I-H21-14 ★DONE の後は確かめ直さない（DONE・SKIP・戻り値が矛盾しない）', !!w5d.props.LB_HEALTH_DONE && !w5d.props.LB_HEALTH_SKIP && r5d.saved && r5d.saved.saved === true, JSON.stringify({ s: r5d.saved, k: w5d.props.LB_HEALTH_SKIP }));
  //   ★通知の対象がある world で、DONE の直後に印が期限切れ（または奪われた）→ SKIP を数えない・通知は deferred_lease・saved:true（関門②3回目）
  for (const [label, steal] of [['期限切れ', (w) => { w.now += 40 * MIN; }], ['奪われた', (w) => { w.props.LB_HEALTH_LEASE = JSON.stringify({ owner: 'other', until: w.now + 30 * MIN, entry: 'heal' }); }]]) {
    const setTimeout0 = (f) => f();
    const wn = makeWorld({ data: { emailFailing: 1, quota: { ok: true, limited: true, left: 0, pct: 100 } } });   // 即時 LINE ＋ まとめメールの対象
    wn.hooks.setProperty = (k) => { if (k === 'LB_HEALTH_DONE' && wn.depth === 1) setTimeout0(() => steal(wn)); };
    const rn = run(wn, 'dailyHealthCheck');
    const owner = wn.mails.filter((m) => /予約システムの点検/.test(m.subject));
    const row = incOf(wn, 'notify_alert_unsent')[0];
    ok(`I-H21-14b（${label}）★DONE の後に印を失っても SKIP は増えず・通知は送らず deferred_lease・saved:true`,
       !!wn.props.LB_HEALTH_DONE && !wn.props.LB_HEALTH_SKIP && rn.saved.saved === true && rn.saved.notified.code === 'deferred_lease' && rn.saved.notified.deferred >= 1
       && wn.pushes.length === 0 && owner.length === 0 && row.notify_state === '' && row.notify_tries === 0,
       JSON.stringify({ s: rn.saved, k: wn.props.LB_HEALTH_SKIP, p: wn.pushes.length, m: owner.length, row }));
  }
  //   修理の途中で奪われた → 以降のトリガーを足さない
  const w2 = makeWorld({ props: { SELF_HEAL_MODE: 'on' } });
  removeTrigger(w2, 'dailySync'); removeTrigger(w2, 'syncContractStatus');
  run(w2, 'dailyHealthCheck'); w2.now += H;
  w2.hooks.create = () => { w2.props.LB_HEALTH_LEASE = JSON.stringify({ owner: 'other', until: w2.now + 30 * MIN, entry: 'check' }); };
  const h = run(w2, 'lbSelfHeal');
  ok('I-H21-5 ★1本目を作った後に奪われたら、2本目を作らない', w2.created.length === 1, JSON.stringify(w2.created.map((c) => c.name)));
  ok('I-H21-6 結果は lease_lost', JSON.stringify(h.actions).indexOf('lease_lost') >= 0, JSON.stringify(h.actions));
}

console.log('=== I-H22 壊れた印 ===');
{
  const now = makeWorld().now;
  const cases = [['JSON が壊れている', '{owner:'], ['until が文字', JSON.stringify({ owner: 'x', until: 'abc' })], ['until が NaN（null）', JSON.stringify({ owner: 'x', until: null })],
    ['owner が空', JSON.stringify({ owner: '', until: now + MIN })], ['遠い未来（3時間後）', JSON.stringify({ owner: 'x', until: now + 3 * H })], ['配列', '[1,2]']];
  for (const [name, raw] of cases) {
    const w = makeWorld({ props: { LB_HEALTH_LEASE: raw } });
    const r = run(w, 'dailyHealthCheck');
    const h = run(w, 'lbSelfHeal');
    ok(`I-H22 ${name}：点検も修理も取らずに見送る・印はそのまま・lease_broken`,
       r.skipped === 'lease_broken' && h.gate === 'skip_lease_broken' && w.props.LB_HEALTH_LEASE === raw && JSON.parse(w.props.LB_HEALTH_SKIP).why === 'lease_broken' && !w.props.LB_HEALTH_LAST,
       JSON.stringify({ r: r.skipped, h: h.gate, s: w.props.LB_HEALTH_SKIP }));
  }
  const w = makeWorld({ props: { LB_HEALTH_LEASE: JSON.stringify({ owner: 'x', until: now - MIN }) } });
  const r = run(w, 'dailyHealthCheck');
  ok('I-H22-対照 期限を過ぎた（壊れていない）印は取れる', !r.skipped && r.saved.saved === true);
}

//   Nudge.js の見張り（本物）を動かす
function nudgeCtx(props, now) {
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
  vm.runInContext([pluckFn(NUDGE, '_lbNudgeWatchHealthCheck'), pluckFn(NUDGE, '_lbNudgeWatchHealthCrash'), pluckFn(NUDGE, '_lbNudgeWatchLease')].join('\n'), ctx);
  ctx._lbNudgeWatchHealthCheck(now);
  return st;
}
console.log('=== I-H22 壊れた印は lbNudgeDaily がメール ===');
{
  const now = Date.UTC(2026, 10, 23, 1);
  const base = { LB_HEALTH_LAST: String(now - 3 * H), LB_HEALTH_DONE: String(now - 3 * H), LB_HEALTH_WATCH_FROM: '1' };
  const a = nudgeCtx(Object.assign({ LB_HEALTH_SKIP: JSON.stringify({ count: 2, why: 'lease_broken' }) }, base), now);
  ok('I-H22-m1 lease_broken が数えられていれば固定の文でメール（LB_HEALTH_LEASE を消すよう案内）', a.mails.length === 1 && /LB_HEALTH_LEASE を削除/.test(a.mails[0].b), JSON.stringify(a.mails));
  const b = nudgeCtx(Object.assign({ LB_HEALTH_SKIP: JSON.stringify({ count: 2, why: 'lease_broken' }), LB_HEALTH_LEASE_ALERT_AT: String(now - H) }, base), now);
  ok('I-H22-m2 1日1回まで', b.mails.length === 0);
  const c = nudgeCtx(Object.assign({ LB_HEALTH_SKIP: JSON.stringify({ count: 2, why: 'held' }) }, base), now);
  ok('I-H22-m3 held の見送りではメールしない', c.mails.length === 0);
}

console.log('=== I-H24 Nudge：途中で落ちた・移行の猶予 ===');
{
  const now = Date.UTC(2026, 10, 23, 1);
  const a = nudgeCtx({ LB_HEALTH_LAST: String(now - 3 * H), LB_HEALTH_DONE: String(now - 3 * H), LB_HEALTH_WATCH_FROM: '1' }, now);
  ok('I-H24-n1 正常に完走（DONE >= LAST）なら誤報しない', a.mails.length === 0);
  const b = nudgeCtx({ LB_HEALTH_LAST: String(now - 3 * H), LB_HEALTH_WATCH_FROM: '1' }, now);
  ok('I-H24-n2 ★DONE が未設定の間（反映直後）は「途中で落ちた」を出さない', b.mails.length === 0);
  const c = nudgeCtx({ LB_HEALTH_LAST: String(now - 3 * H), LB_HEALTH_DONE: String(now - 27 * H), LB_HEALTH_WATCH_FROM: '1' }, now);
  ok('I-H24-n3 LAST > DONE かつ2時間超なら「途中で落ちています」', c.mails.length === 1 && /途中で落ちています/.test(c.mails[0].s), JSON.stringify(c.mails));
  const d = nudgeCtx({ LB_HEALTH_LAST: String(now - 1 * H), LB_HEALTH_DONE: String(now - 25 * H), LB_HEALTH_WATCH_FROM: '1' }, now);
  ok('I-H24-n4 2時間以内（まだ走っているかもしれない）は出さない', d.mails.length === 0);
  const e = nudgeCtx({ LB_HEALTH_LAST: String(now - 40 * H), LB_HEALTH_DONE: String(now - 40 * H), LB_HEALTH_WATCH_FROM: '1' }, now);
  ok('I-H16-n1 点検が36時間以上走っていなければ今までどおり「止まっています」', e.mails.length === 1 && /日次点検が止まっています/.test(e.mails[0].s), JSON.stringify(e.mails.map((m) => m.s)));
}

console.log('=== I-H26 印の owner は実行ごとに一意 ===');
{
  const w = makeWorld();
  let L1 = null, inner = null, L1after = null;
  //   同じミリ秒（時計を止めたまま）にもう1本起動する
  w.hooks.debugDataHealth = () => { L1 = lease(w); inner = run(w, 'dailyHealthCheck'); L1after = lease(w); };
  const r = run(w, 'dailyHealthCheck');
  ok('I-H26-1 owner は check_id と別（実行ごとの乱数）', L1 && L1.owner !== String(r.checkId) && /^uuid-/.test(L1.owner), JSON.stringify(L1));
  ok('I-H26-2 ★同じ時刻に起動した2本目は見送り、1本目の印を消さない', inner && inner.skipped === 'held' && L1after && L1after.owner === L1.owner);
  ok('I-H26-3 1本目は最後まで来て保存した', r.saved && r.saved.saved === true);
  //   check_id が同じでも owner は違う（2回の取得で別の値）
  const w2 = makeWorld();
  const c = (await import('./_self-heal-harness.js')).makeCtx(w2);
  const a = c._lbLeaseAcquire('check'); c._lbLeaseRelease(a.owner);
  const b = c._lbLeaseAcquire('check');
  ok('I-H26-4 同じ時刻の2回の取得で owner が違う', a.ok && b.ok && a.owner !== b.owner);
  ok('I-H26-5 他人の owner では放せない', (c._lbLeaseRelease(a.owner), lease(w2) && lease(w2).owner === b.owner));
}

console.log('=== I-H27 期限切れの印を持つ実行は副作用をしない ===');
{
  const w = makeWorld();
  //   最後の段で 40 分止まった（延長されないまま期限を過ぎた・owner は自分のまま）
  w.hooks.lbContractInputCheck = () => { w.now += 40 * MIN; };
  const r = run(w, 'dailyHealthCheck');
  ok('I-H27-1 ★owner が一致しても期限を過ぎていれば要約・台帳・完走の印・health_status を書かない', !w.props.LB_HEALTH_STATUS && !w.props.LB_HEALTH_DONE && !w.sheets.incidents && !w.sheets.health_status && r.leaseLost === true, JSON.stringify(r));
  ok('I-H27-2 期限切れを見送りとして数える（why=expired）', JSON.parse(w.props.LB_HEALTH_SKIP || '{}').why === 'expired', w.props.LB_HEALTH_SKIP);
  //   修理：作る直前に期限を過ぎていれば作らない
  const w2 = makeWorld({ props: { SELF_HEAL_MODE: 'on' } });
  removeTrigger(w2, 'dailySync');
  run(w2, 'dailyHealthCheck'); w2.now += H;
  let n = 0;
  w2.hooks.getProjectTriggers = () => { if (++n === 1) w2.now += 40 * MIN; };   // 数えた直後に 40 分止まった
  const h = run(w2, 'lbSelfHeal');
  ok('I-H27-3 ★修理も期限を過ぎたらトリガーを作らない', w2.created.length === 0 && countTrigger(w2, 'dailySync') === 0, JSON.stringify(h));
  //   副作用の直前に「その場で 35 分延長」している
  const w3 = makeWorld({ props: { SELF_HEAL_MODE: 'on' } });
  removeTrigger(w3, 'dailySync');
  run(w3, 'dailyHealthCheck'); w3.now += H;
  let Lc = null;
  w3.hooks.create = () => { Lc = lease(w3); };
  run(w3, 'lbSelfHeal');
  ok('I-H27-4 作る直前に印を「いま＋35分」へ延ばしている', Lc && Lc.until === w3.now + 35 * MIN && Lc.entry === 'heal', JSON.stringify(Lc));
}

console.log('=== I-H30 ロックが取れない（busy）と印を失った（lost）を分ける ===');
{
  //   点検中、印の確認のたびに1回おきにロックが混んでいる（予約などが ScriptLock を持っている）
  const w = makeWorld();
  let n0 = 0;
  w.hooks.debugDataHealth = () => { n0 = w.lockN; w.lockBusyFn = (n) => n % 2 === 0; };   // 取った後から1回おきに busy
  const r = run(w, 'dailyHealthCheck');
  ok('I-H30-1 ★点検中に毎回 busy が挟まっても完走する（要約・DONE・台帳・health_status）', r.saved && r.saved.saved === true && !!w.props.LB_HEALTH_DONE && !!w.sheets.health_status && w.lockN - n0 > 20, JSON.stringify({ s: r.saved, n: w.lockN - n0 }));
  ok('I-H30-2 busy だけでは見送りとして数えない（期限まで余裕がある）', !w.props.LB_HEALTH_SKIP, w.props.LB_HEALTH_SKIP);
  ok('I-H30-3 終われば印を放す（ロックが混んでいても3回まで試す）', lease(w) === null);
  //   busy が続き、手元の期限の残りが5分を切った → 副作用をせずに終える
  const w2 = makeWorld({ data: { quota: { ok: true, limited: true, left: 0, pct: 100 } } });
  w2.hooks.debugDataHealth = () => { w2.lockBusy = true; };
  w2.hooks.lbContractInputCheck = () => { w2.now += 31 * MIN; };   // 延ばせないまま31分（残り4分）
  const r2 = run(w2, 'dailyHealthCheck');
  ok('I-H30-4 ★busy が続いて期限が近づいたら副作用をしない（health_status・要約・DONE・メールなし）', r2.leaseLost === true && r2.skipped === 'lock_busy' && !w2.sheets.health_status && !w2.props.LB_HEALTH_STATUS && !w2.props.LB_HEALTH_DONE && w2.mails.length === 0, JSON.stringify(r2));
  ok('I-H30-5 busy で終えた回は why=lock_busy で数える', JSON.parse(w2.props.LB_HEALTH_SKIP || '{}').why === 'lock_busy', w2.props.LB_HEALTH_SKIP);
  //   busy が続いても期限まで余裕があるうちは続ける（30分経過＝残り5分ちょうどまでは続く）
  const w3 = makeWorld();
  w3.hooks.lbKarteAiDailyCheck = () => { w3.lockBusy = true; };   // 通知の後ろ回しの引き渡し（副作用）より後の段から busy
  w3.hooks.lbContractInputCheck = () => { w3.now += 29 * MIN; };
  const r3 = run(w3, 'dailyHealthCheck');
  //   ★LINE は1通ごとに直前に確かめる：1通目を送った直後に印を奪われたら2通目を送らない
  const wq = makeWorld({ data: { emailFailing: 1 }, trainers: [['U0000000000000000000000000000000b', 'T1', 'テスト', 'owner', true, ''], ['U0000000000000000000000000000000c', 'T2', 'テスト', 'owner', true, '']] });
  wq.hooks.push = () => { wq.props.LB_HEALTH_LEASE = JSON.stringify({ owner: 'other', until: wq.now + 30 * MIN, entry: 'heal' }); };
  const rq = run(wq, 'dailyHealthCheck');
  ok('I-H21-15 ★LINE の各送信の直前に確かめる（1通目の後に奪われたら2通目を送らない・SKIP に数えない）', wq.pushes.length === 1 && rq.saved.saved === true && !wq.props.LB_HEALTH_SKIP, JSON.stringify({ p: wq.pushes.length, s: rq.saved, k: wq.props.LB_HEALTH_SKIP }));
  ok('I-H30-6 ★busy が続くと：段の進行（読み取り）は続く（契約の入力まで呼ぶ）が、副作用は延長できないのでしない（期限の残りが十分でも health_status・要約なし）',
     w3.calls.lbContractInputCheck === 1 && !w3.sheets.health_status && !w3.props.LB_HEALTH_STATUS && r3.leaseLost === true && r3.skipped === 'lock_busy', JSON.stringify({ r3, c: w3.calls.lbContractInputCheck }));
  //   busy で段を進めた後、副作用の直前にはロックが空いた → 延長できたので書く
  const w3b = makeWorld();
  w3b.hooks.lbKarteAiDailyCheck = () => { w3b.lockBusy = true; };   // 通知の後ろ回しの引き渡し（副作用）より後の段から busy
  w3b.hooks.lbContractInputCheck = () => { w3b.now += 29 * MIN; w3b.lockBusy = false; };
  const r3b = run(w3b, 'dailyHealthCheck');
  ok('I-H30-6b busy で段を進めた後、副作用の直前に延長できれば書く（完走）', r3b.saved && r3b.saved.saved === true && !!w3b.sheets.health_status, JSON.stringify(r3b.saved || r3b));
  //   ★busy で続けた後、5分を切った状態で副作用の直前に来て、1回目は busy・2回目で空いた → 延長できたので書く（3回まで試す）
  const w3c = makeWorld();
  w3c.hooks.lbKarteAiDailyCheck = () => { w3c.lockBusy = true; };   // 通知の後ろ回しの引き渡し（副作用）より後の段から busy
  w3c.hooks.lbContractInputCheck = () => { w3c.now += 31 * MIN; w3c.lockBusy = false; const n0 = w3c.lockN; w3c.lockBusyFn = (n) => n === n0 + 1; };
  const r3c = run(w3c, 'dailyHealthCheck');
  ok('I-H30-6c 副作用の直前は tryLock を3回まで試す（1回 busy でも延長できれば書く）', r3c.saved && r3c.saved.saved === true, JSON.stringify(r3c.saved || r3c));
  //   修理は strict：作る直前に busy なら作らない・次回へ・lock_busy を数える・完走の印を書かない
  const w4 = makeWorld({ props: { SELF_HEAL_MODE: 'on' } });
  removeTrigger(w4, 'dailySync');
  run(w4, 'dailyHealthCheck'); w4.now += H;
  w4.hooks.getProjectTriggers = () => { w4.lockBusy = true; };
  const done0 = w4.props.LB_SELFHEAL_DONE;
  const h4 = run(w4, 'lbSelfHeal');
  ok('I-H30-7 ★修理は busy なら副作用をしない（作らない）', w4.created.length === 0 && JSON.stringify(h4.actions).indexOf('lease_lost') >= 0, JSON.stringify(h4));
  ok('I-H30-8 修理の busy も lock_busy で数え、完走の印を書かない', JSON.parse(w4.props.LB_HEALTH_SKIP || '{}').why === 'lock_busy' && w4.props.LB_SELFHEAL_DONE === done0, w4.props.LB_HEALTH_SKIP);
}

{
  //   ★修理の完走の印は、印を放す前に・延長できたときだけ書く（関門②4回目）。印を取った後のロックが全部 busy なら書かない
  const w5 = makeWorld({ props: { SELF_HEAL_MODE: 'practice' } });
  run(w5, 'dailyHealthCheck'); w5.now += H;
  const done0 = w5.props.LB_SELFHEAL_DONE;
  const n0 = w5.lockN; w5.lockBusyFn = (n) => n > n0 + 1;   // 印を取る1回目だけ通す
  run(w5, 'lbSelfHeal');
  w5.lockBusyFn = null; w5.lockBusy = false;
  const w5c = makeWorld({ props: { SELF_HEAL_MODE: 'practice' } });
  run(w5c, 'dailyHealthCheck'); w5c.now += H; run(w5c, 'lbSelfHeal');
  ok('I-H21-16 ★修理の完走の印は延長できたときだけ（陽性の対照：通常は書く）', w5.props.LB_SELFHEAL_DONE === done0 && !!w5c.props.LB_SELFHEAL_DONE, JSON.stringify({ d: w5.props.LB_SELFHEAL_DONE, c: w5c.props.LB_SELFHEAL_DONE }));
}

console.log('=== I-H16 lbSelfHeal の完走を翌日の点検が確かめる ===');
{
  const w = makeWorld({ props: { SELF_HEAL_MODE: 'practice' } });
  run(w, 'dailyHealthCheck');
  ok('I-H16-1 一度も完走していなくても、見張りを始めて26時間は鳴らさない', !status(w).items.some((x) => x.k === 'selfheal_stale'));
  w.now += 27 * H; run(w, 'dailyHealthCheck');
  ok('I-H16-2 26時間を過ぎても完走の記録が無ければ selfheal_stale（B）', (status(w).items.find((x) => x.k === 'selfheal_stale') || {}).cls === 'B');
  w.now += H; run(w, 'lbSelfHeal'); w.now += H; run(w, 'dailyHealthCheck');
  ok('I-H16-3 lbSelfHeal が完走すれば消え、台帳は閉じる', !status(w).items.some((x) => x.k === 'selfheal_stale') && incOf(w, 'selfheal_stale')[0].status === 'fixed');
  w.now += 27 * H; run(w, 'dailyHealthCheck');
  ok('I-H16-4 完走が26時間より古ければまた出る', status(w).items.some((x) => x.k === 'selfheal_stale'));
  w.props.SELF_HEAL_MODE = 'off'; w.now += H; run(w, 'dailyHealthCheck');
  ok('I-H16-5 off なら見張らない', !status(w).items.some((x) => x.k === 'selfheal_stale'));
  //   練習が14日を超えたら info
  const w2 = makeWorld({ props: { SELF_HEAL_MODE: 'practice' } });
  run(w2, 'lbSelfHeal'); w2.now += 15 * 24 * H; run(w2, 'lbSelfHeal'); w2.now += H; run(w2, 'dailyHealthCheck');
  ok('I-H16-6 練習が14日を超えたら selfheal_practice_long（info・案件にしない）', (status(w2).items.find((x) => x.k === 'selfheal_practice_long') || {}).cls === 'info' && incOf(w2, 'selfheal_practice_long').length === 0);
}

t.end('自己修理 P1 印と見張り');
