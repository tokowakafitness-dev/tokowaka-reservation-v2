// 自己修理 P1：修理の側（トリガーを足すだけ・cancel_notes・モード・回数・既存の作り方との一致）（2026-11-23）
//   実行: node worker/test/self-heal-repair.test.js
//   I-H3  修理は既存の setup* を呼ばない・トリガーを消さない
//   I-H4  足すのは 0 本の処理名だけ。作る直前と直後に数える。直後に 2 本以上なら消さずに escalated
//   I-H5  足した後の総数は 18 本以下（普段の本数を超えない）。超えるなら足さずに escalated
//   I-H6  修理の途中で落ちても、修理前にあったトリガーは残る
//   I-H7  mode 未設定・不正値・イベントの引数 → practice
//   I-H8  要約.check_id === LB_HEALTH_DONE・completed・26 時間以内でなければ修理しない
//   I-H9  同じ案件の修理は 3 回まで（呼ぶ前に +1）／練習は attempts を使わない
//   I-H12 予約の行・残数の材料・顧客に届くものを書く処理を A から呼ばない
//   I-H17 cancel_notes の回復は _lbCnHealth().ready でだけ
//   I-H18 LB_HEAL_SCHEDULE が既存 setup* の作り方と一致
//   ★値はすべて架空
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { makeWorld, run, makeCtx, status, incOf, removeTrigger, countTrigger, tally, makeSheet, CN_HEAD, healBlock, ROOT, LB } from './_self-heal-harness.js';
import { pluckFnFrom as pluckFn } from './_gas-lock-src.js';

const t = tally();
const ok = t.ok;
const H = 3600000;
const on = (o = {}) => makeWorld(Object.assign({}, o, { props: Object.assign({ SELF_HEAL_MODE: 'on' }, o.props || {}) }));
function checkThenHeal(w) { run(w, 'dailyHealthCheck'); w.now += H; return run(w, 'lbSelfHeal'); }

console.log('=== I-H3 setup* を呼ばない・トリガーを消さない ===');
{
  const w = on();
  for (const h of ['dailySync', 'lbNudgeDaily', 'edgeJobPoll', 'pushToEdgeLight']) removeTrigger(w, h);
  const before = w.triggers.map((x) => x.h).slice();
  const h = checkThenHeal(w);
  ok('I-H3-1 ★setup*・deleteTrigger・dailySync を呼んでいない（呼ぶと落ちる身代わり）', w.forbidden.length === 0, w.forbidden.join(','));
  ok('I-H3-2 前からあったトリガーは全部残っている', before.every((x) => countTrigger(w, x) >= 1));
  ok('I-H3-3 足りない4つを1本ずつ足した', ['dailySync', 'lbNudgeDaily', 'edgeJobPoll', 'pushToEdgeLight'].every((x) => countTrigger(w, x) === 1) && w.created.length === 4,
     JSON.stringify({ c: w.created.map((x) => x.name), a: h.actions }));
  //   本物のソース：修理の塊に deleteTrigger と setup*（作る関数・cancel_notes を除く）の呼び出しが無い
  const blk = healBlock().replace(/\/\/[^\n]*/g, '');
  const calls = (blk.match(/\bsetup[A-Za-z]*\(/g) || []).filter((x) => !/^setupCancelNotesSheet\(|^setupSelfHealTrigger\(/.test(x));
  ok('I-H3-4 修理の塊に deleteTrigger が無い', !/deleteTrigger/.test(blk));
  ok('I-H3-5 修理の塊が呼ぶ setup* は setupCancelNotesSheet だけ（setupSelfHealTrigger は定義）', calls.length === 0, calls.join(','));
}

console.log('=== I-H4 0本の処理名だけ・直前と直後に数える ===');
{
  //   直前に別の処理が1本作った（数えた後・作る前）
  const w = on();
  removeTrigger(w, 'dailySync');
  run(w, 'dailyHealthCheck'); w.now += H;
  let n = 0;
  w.hooks.getProjectTriggers = () => { if (++n === 2) w.triggers.push({ h: 'dailySync' }); };   // 1回目＝計画・2回目＝作る直前
  run(w, 'lbSelfHeal');
  ok('I-H4-1 ★作る直前に数え直し、別の処理が作っていれば作らない', w.created.length === 0 && countTrigger(w, 'dailySync') === 1, String(w.created.length));
  //   直後に2本（作っている間に別の処理も作った）
  const w2 = on();
  removeTrigger(w2, 'dailySync');
  run(w2, 'dailyHealthCheck'); w2.now += H;
  w2.hooks.create = (name) => { w2.triggers.push({ h: name }); };
  const h2 = run(w2, 'lbSelfHeal');
  const row = incOf(w2, 'trigger_missing')[0];
  ok('I-H4-2 ★作った後に2本あれば消さない', countTrigger(w2, 'dailySync') === 2 && w2.forbidden.length === 0);
  ok('I-H4-3 escalated・last_action=dup_after', row.status === 'escalated' && row.last_action === 'dup_after', JSON.stringify(row));
  //   1本あるもの（重複していない）には触らない
  const w3 = on();
  w3.triggers.push({ h: 'lbNudgeDaily' });   // 2本＝trigger_dup（B）
  removeTrigger(w3, 'dailySync');
  checkThenHeal(w3);
  ok('I-H4-4 足すのは 0 本の処理名だけ（重複している処理名は B のまま触らない）', countTrigger(w3, 'lbNudgeDaily') === 2 && w3.created.map((x) => x.name).join() === 'dailySync'
     && incOf(w3, 'trigger_dup')[0].cls === 'B');
}

console.log('=== I-H5 足した後の総数は18本以下 ===');
{
  for (const [extra, want] of [[3, true], [4, true], [5, false]]) {
    //   既定14本から dailySync を抜いて13本。extra 本の一回限りを足す → 足した後 = 14 + extra
    const w = on();
    removeTrigger(w, 'dailySync');
    for (let i = 0; i < extra; i++) w.triggers.push({ h: '_lbWarmContract' });
    const after = w.triggers.length + 1;
    checkThenHeal(w);
    const row = incOf(w, 'trigger_missing')[0];
    if (want) ok(`I-H5 足した後 ${after}本：足す`, countTrigger(w, 'dailySync') === 1, JSON.stringify(row));
    else ok(`I-H5 ★足した後 ${after}本：足さずに escalated（skip_near_limit）`, countTrigger(w, 'dailySync') === 0 && row.status === 'escalated' && row.last_action === 'skip_near_limit', JSON.stringify(row));
  }
}

console.log('=== I-H5 作った後の総数が18本を超えたら消さずに escalated ===');
{
  const w = on();
  removeTrigger(w, 'dailySync');
  for (let i = 0; i < 4; i++) w.triggers.push({ h: '_lbWarmContract' });   // 17本 → 足すと18本（足してよい）
  run(w, 'dailyHealthCheck'); w.now += H;
  w.hooks.create = () => { w.triggers.push({ h: '_lbWarmContract' }); };   // 作っている間に別の処理が一回限りを1本作った
  run(w, 'lbSelfHeal');
  const row = incOf(w, 'trigger_missing')[0];
  ok('I-H5-a ★作った後の総数が18本を超えたら escalated（over_limit_after）・消さない', row.status === 'escalated' && row.last_action === 'over_limit_after' && countTrigger(w, 'dailySync') === 1 && w.forbidden.length === 0, JSON.stringify(row));
}

console.log('=== I-H31 修理の時間の予算（min(4分, 5分 − うながしにかかった時間)） ===');
{
  const w = on();
  removeTrigger(w, 'dailySync');
  run(w, 'dailyHealthCheck'); w.now += H;
  const done0 = w.props.LB_SELFHEAL_DONE;
  const r = run(w, 'lbSelfHeal', w.now - 4.5 * 60000);   // うながしに4分30秒＝残り30秒
  ok('I-H31-1 ★予算が60秒未満なら修理を始めない（作らない・台帳を触らない・完走の印なし）', r.gate === 'skip_no_time' && w.created.length === 0 && incOf(w, 'trigger_missing')[0].attempts === 0 && w.props.LB_SELFHEAL_DONE === done0, JSON.stringify(r));
  const sk = JSON.parse(w.props.LB_HEALTH_SKIP || '{}');
  ok('I-H31-2 no_time を数える（entry=heal）', sk.why === 'no_time' && sk.entry === 'heal', w.props.LB_HEALTH_SKIP);
  const r2 = run(w, 'lbSelfHeal', w.now - 2 * 60000);
  ok('I-H31-3 うながしに2分なら予算は3分で修理する', r2.budgetMs === 3 * 60000 && w.created.length === 1, JSON.stringify(r2));
  const w2 = on();
  ok('I-H31-4 開始時刻が無い（直接・イベント）なら予算は4分', run(w2, 'lbSelfHeal').budgetMs === 4 * 60000 && run(w2, 'lbSelfHeal', { triggerUid: 'x' }).budgetMs === 4 * 60000);
  //   予算を使い切ったら次の案件へ進まない
  const w3 = on();
  removeTrigger(w3, 'dailySync');
  w3.sheets.cancel_notes = (await import('./_self-heal-harness.js')).makeSheet('cancel_notes', []);
  run(w3, 'dailyHealthCheck'); w3.now += H;
  w3.hooks.setProperty = (k) => { if (k === 'LB_HEALTH_LEASE') w3.now += 50000; };   // 印に触るたびに50秒かかる（遅い日）
  const r3 = run(w3, 'lbSelfHeal', w3.now - 3 * 60000);   // 予算2分
  ok('I-H31-5 予算を超えたら残りの案件は次回へ', r3.budget === true && r3.actions.length < 2, JSON.stringify(r3));
}

console.log('=== I-H6 修理の途中で落ちても前からあったトリガーは残る ===');
{
  const w = on();
  removeTrigger(w, 'dailySync'); removeTrigger(w, 'lbNudgeDaily');
  const before = w.triggers.map((x) => x.h).slice();
  run(w, 'dailyHealthCheck'); w.now += H;
  let n = 0;
  w.hooks.create = () => { if (++n === 2) w.data.throwIn.create = 'boom'; };
  const h = run(w, 'lbSelfHeal');
  ok('I-H6-1 ★作成の途中で例外：前からあったトリガーは全部残る', before.every((x) => countTrigger(w, x) >= 1) && w.forbidden.length === 0);
  ok('I-H6-2 例外を外へ出さず、結果を台帳に（create_failed）', incOf(w, 'trigger_missing')[0].last_action === 'create_failed', JSON.stringify(h));
  ok('I-H6-3 修理の完走の印は残る（例外で落ちていない）', !!w.props.LB_SELFHEAL_DONE);
}

console.log('=== I-H7 モード ===');
{
  for (const [label, mode, arg] of [['未設定', undefined, undefined], ['不正値 ON', 'ON', undefined], ['不正値 true', 'true', undefined],
    ['イベントの引数（未設定）', undefined, { triggerUid: '1', authMode: 'FULL' }], ['引数 true（未設定）', undefined, true]]) {
    const w = makeWorld({ props: mode == null ? {} : { SELF_HEAL_MODE: mode } });
    removeTrigger(w, 'dailySync');
    run(w, 'dailyHealthCheck'); w.now += H;
    const r = run(w, 'lbSelfHeal', arg);
    const row = incOf(w, 'trigger_missing')[0];
    ok(`I-H7 ${label} → practice（作らない・attempts を使わない・would_attempts=1）`, r.mode === 'practice' && w.created.length === 0 && row.attempts === 0 && row.would_attempts === 1
       && row.status === 'open' && row.last_action === 'practice_add_trigger:dailySync', JSON.stringify({ r, row }));
  }
  const w = makeWorld({ props: { SELF_HEAL_MODE: 'off' } });
  removeTrigger(w, 'dailySync');
  run(w, 'dailyHealthCheck'); w.now += H;
  const r = run(w, 'lbSelfHeal');
  ok('I-H7-off 何もしない（台帳も触らない）・心拍は残す', r.mode === 'off' && w.created.length === 0 && incOf(w, 'trigger_missing')[0].would_attempts === 0 && !!w.props.LB_SELFHEAL_DONE);
  ok('I-H7-src 第1引数は数（うながしの開始時刻）のときだけ使う', /\nfunction lbSelfHeal\(nudgeStartMs\) \{/.test(LB) && /typeof nudgeStartMs === 'number' && isFinite\(nudgeStartMs\)/.test(LB));
}

console.log('=== I-H8 完走した最新の点検の結果だけを使う ===');
{
  //   要約だけ書いて落ちた（DONE が進んでいない）
  const w = on();
  removeTrigger(w, 'dailySync');
  run(w, 'dailyHealthCheck');
  const s = status(w); s.check_id += 1000; w.props.LB_HEALTH_STATUS = JSON.stringify(s);   // DONE より新しい要約＝台帳・DONE の前に落ちた
  w.now += H;
  const inc0 = JSON.stringify(w.sheets.incidents.data);
  const r = run(w, 'lbSelfHeal');
  ok('I-H8-1 ★要約.check_id !== DONE なら何もしない（台帳も触らない）', r.gate === 'not_done' && w.created.length === 0 && JSON.stringify(w.sheets.incidents.data) === inc0, JSON.stringify(r));
  ok('I-H8-2 心拍は残す', !!w.props.LB_SELFHEAL_DONE && !!w.props.LB_SELFHEAL_LAST);
  //   古い要約（27時間前）
  const w2 = on();
  removeTrigger(w2, 'dailySync');
  run(w2, 'dailyHealthCheck'); w2.now += 27 * H;
  const r2 = run(w2, 'lbSelfHeal');
  ok('I-H8-3 26時間より古い要約では修理しない', r2.gate === 'stale' && w2.created.length === 0);
  //   completed が真でない
  const w3 = on();
  removeTrigger(w3, 'dailySync');
  run(w3, 'dailyHealthCheck');
  const s3 = status(w3); s3.completed = 'yes'; w3.props.LB_HEALTH_STATUS = JSON.stringify(s3); w3.now += H;
  ok('I-H8-4 completed が true でなければ修理しない', run(w3, 'lbSelfHeal').gate === 'not_completed' && w3.created.length === 0);
  //   要約が無い・壊れている
  const w4 = on(); w4.props.LB_HEALTH_STATUS = '{x'; w4.props.LB_HEALTH_DONE = '1';
  ok('I-H8-5 要約が壊れていれば修理しない', run(w4, 'lbSelfHeal').gate === 'status_broken');
}

console.log('=== I-H9 3回まで・呼ぶ前に +1・練習は attempts を使わない ===');
{
  const w = on();
  removeTrigger(w, 'dailySync');
  //   作ってもすぐ消える（直らない）
  w.hooks.create = () => { w.data.throwIn.create = null; };
  const att = [];
  for (let d = 0; d < 5; d++) {
    run(w, 'dailyHealthCheck'); w.now += H;
    run(w, 'lbSelfHeal'); removeTrigger(w, 'dailySync'); w.now += 23 * H;
    att.push(incOf(w, 'trigger_missing')[0].attempts);
  }
  run(w, 'dailyHealthCheck');
  const row = incOf(w, 'trigger_missing')[0];
  ok('I-H9-1 ★3回で止まる（4回目以降は作らない）', w.created.length === 3 && JSON.stringify(att) === '[1,2,3,3,3]', JSON.stringify({ c: w.created.length, att }));
  ok('I-H9-2 3回でも残れば escalated', row.status === 'escalated', JSON.stringify(row));
  //   修理の途中で落ちた回も数える
  const w2 = on();
  removeTrigger(w2, 'dailySync');
  w2.data.throwIn.create = 'boom';
  checkThenHeal(w2);
  ok('I-H9-3 ★作成が例外でも attempts は +1（呼ぶ前に数える）', incOf(w2, 'trigger_missing')[0].attempts === 1);
  //   練習は attempts を使わず、would_attempts も3回で止まる
  const w3 = makeWorld();
  removeTrigger(w3, 'dailySync');
  for (let d = 0; d < 5; d++) { run(w3, 'dailyHealthCheck'); w3.now += H; run(w3, 'lbSelfHeal'); w3.now += 23 * H; }
  const r3 = incOf(w3, 'trigger_missing')[0];
  ok('I-H9-4 練習は attempts 0・would_attempts は3で止まる・status は open のまま', r3.attempts === 0 && r3.would_attempts === 3 && r3.status === 'open' && w3.created.length === 0, JSON.stringify(r3));
}

console.log('=== I-H12 顧客に触れる処理を A から呼ばない ===');
{
  const blk = healBlock().replace(/\/\/[^\n]*/g, '');
  const bad = ['dailySync(', 'syncExistingReservations(', 'lbDwEnsureQueued(', '_lbReserveCore(', '_lbPush(', 'sendLineReminders(', 'refreshPaceBoard(', 'dailyHealthCheck(', 'UrlFetchApp'].filter((x) => blk.indexOf(x) >= 0);
  ok('I-H12-1 修理の塊に予約・残数・顧客への送信の呼び出しが無い', bad.length === 0, bad.join(','));
  const w = on();
  removeTrigger(w, 'dailySync'); removeTrigger(w, 'sendLineReminders');
  w.sheets.cancel_notes = makeSheet('cancel_notes', []);
  checkThenHeal(w);
  ok('I-H12-2 実際に動かしても呼ばない（呼ぶと落ちる身代わり）', w.forbidden.length === 0 && w.created.length === 2, w.forbidden.join(','));
}

console.log('=== I-H17 cancel_notes の回復は _lbCnHealth().ready でだけ ===');
{
  //   空のシートで見出しが違う → 書き直す → 次の点検で fixed
  const w = on();
  w.sheets.cancel_notes = makeSheet('cancel_notes', [['res_id', 'ちがう']]);
  const h = checkThenHeal(w);
  ok('I-H17-1 空なら見出しを書き直す（rewrote）', JSON.stringify(h.actions) === '["cancel_notes_unready:setup_cancel_notes:rewrote"]' && h.after && h.after.cancelNotesReady === true, JSON.stringify(h));
  w.now += 23 * H; run(w, 'dailyHealthCheck');
  ok('I-H17-2 次の点検で ready なら fixed', incOf(w, 'cancel_notes_unready')[0].status === 'fixed');
  //   データ行があって見出しが違う → 触らない・escalated・閉じない
  const w2 = on();
  const rows = [['res_id', 'ちがう'], ['R1', 1]];
  w2.sheets.cancel_notes = makeSheet('cancel_notes', rows);
  const h2 = checkThenHeal(w2);
  ok('I-H17-3 ★データ行があれば書き換えない（mismatch）', JSON.stringify(w2.sheets.cancel_notes.data) === JSON.stringify(rows) && JSON.stringify(h2.actions) === '["cancel_notes_unready:setup_cancel_notes:mismatch"]', JSON.stringify(h2));
  ok('I-H17-4 escalated', incOf(w2, 'cancel_notes_unready')[0].status === 'escalated');
  w2.now += 23 * H; run(w2, 'dailyHealthCheck');
  ok('I-H17-5 ★シートはあるが見出し違いのままなら閉じない（ready でない）', incOf(w2, 'cancel_notes_unready')[0].status === 'escalated'
     && JSON.stringify(status(w2).items.find((x) => x.k === 'cancel_notes_unready').f) === '["mismatch"]');
  //   シートが無い → 作る
  const w3 = on(); delete w3.sheets.cancel_notes;
  const h3 = checkThenHeal(w3);
  ok('I-H17-6 シートが無ければ作る（created）・facts は missing だった', JSON.stringify(h3.actions) === '["cancel_notes_unready:setup_cancel_notes:created"]'
     && JSON.stringify(w3.sheets.cancel_notes.data[0]) === JSON.stringify(CN_HEAD));
}

console.log('=== I-H18 LB_HEAL_SCHEDULE が既存の setup* と同じ組み立て ===');
{
  //   既存の設定関数を記録用の身代わり ScriptApp で実際に動かす
  const GAS = process.env.GAS_DIR || join(ROOT, 'gas');
  const NUD = readFileSync(join(GAS, 'Nudge.js'), 'utf8'), PE = readFileSync(join(GAS, 'PushToEdge.js'), 'utf8'), EJ = readFileSync(join(GAS, 'EdgeJob.js'), 'utf8');
  const made = [];
  const builder = (name) => { const calls = []; const b = new Proxy({}, { get: (_, m) => (m === 'create' ? () => { made.push({ name, calls }); return {}; } : (...a) => { calls.push([m, ...a]); return b; }) }); return b; };
  const props = { EDGE_URL: 'https://edge.example.invalid', EDGE_SECRET: 'x' };
  const ctx = {
    SETTINGS: { TIMEZONE: 'Asia/Tokyo' }, Logger: { log: () => {} }, JSON, String,
    ScriptApp: { getProjectTriggers: () => [], deleteTrigger: () => {}, newTrigger: builder, WeekDay: { MONDAY: 'MONDAY' } },
    PropertiesService: { getScriptProperties: () => ({ setProperty: () => {}, getProperty: (k) => props[k] || null }) },
    _edgeProp: (k) => props[k] || '', _ejPost: () => ({ success: true }), EJ: { ENABLED_PROP: 'EDGE_JOB_ON' },
  };
  vm.createContext(ctx);
  vm.runInContext([pluckFn(LB, 'setupLineTriggers'), pluckFn(NUD, 'setupNudgeTrigger'), pluckFn(PE, 'setupEdgeTrigger'), pluckFn(EJ, 'setupEdgeJobTrigger')].join('\n'), ctx);
  for (const f of ['setupLineTriggers', 'setupNudgeTrigger', 'setupEdgeTrigger', 'setupEdgeJobTrigger']) ctx[f]();
  const norm = (calls) => JSON.stringify(calls.filter((c) => c[0] !== 'timeBased').map((c) => JSON.stringify(c)).sort());
  const fromSetup = {}; for (const m of made) fromSetup[m.name] = norm(m.calls);
  made.length = 0;
  const c2 = makeCtx(makeWorld());
  c2.ScriptApp.newTrigger = builder;
  const targets = c2.LB_HEAL_TARGETS;
  for (const n of targets) c2.LB_HEAL_SCHEDULE[n]().create();
  const fromHeal = {}; for (const m of made) fromHeal[m.name] = norm(m.calls);
  const diff = targets.filter((n) => !fromSetup[n] || fromSetup[n] !== fromHeal[n]);
  ok('I-H18-1 ★7つとも既存の setup* と同じ組み立て（処理名・周期・時刻・時間帯）', diff.length === 0 && targets.length === 7,
     diff.map((n) => `${n}: setup=${fromSetup[n]} heal=${fromHeal[n]}`).join('\n   '));
  ok('I-H18-2 対象は必須一覧の8つから dailyHealthCheck を除いた7つ', JSON.stringify(targets.slice().sort()) === JSON.stringify(['dailySync', 'edgeJobPoll', 'lbNudgeDaily', 'pushToEdgeFullSync', 'pushToEdgeLight', 'sendLineReminders', 'syncContractStatus']));
  //   必須一覧（dailyHealthCheck の _need）と揃っている
  const nb = LB.slice(LB.indexOf('    var _need = ['), LB.indexOf('    ];', LB.indexOf('    var _need = [')));
  const need = (nb.match(/\['([A-Za-z]+)',/g) || []).map((x) => x.slice(2, -2));
  ok('I-H18-3 必須一覧（_need）＝ dailyHealthCheck ＋ 修理の7つ', JSON.stringify(need.filter((x) => x !== 'dailyHealthCheck').sort()) === JSON.stringify(targets.slice().sort()), need.join(','));
  ok('I-H18-4 setupCalSyncTrigger（lbCalSyncTick）は対象外', targets.indexOf('lbCalSyncTick') < 0);
}

console.log('=== 設定が無い・作業依頼を止めている ===');
{
  const w = on({ props: { EDGE_URL: '' } });
  removeTrigger(w, 'pushToEdgeLight'); removeTrigger(w, 'dailySync');
  checkThenHeal(w);
  const row = incOf(w, 'trigger_missing')[0];
  ok('設定-1 EDGE_URL が無ければ押し出しは足さず escalated（ほかは足す）', countTrigger(w, 'pushToEdgeLight') === 0 && countTrigger(w, 'dailySync') === 1 && row.status === 'escalated' && row.last_action === 'skip_no_config', JSON.stringify(row));
  const w2 = on({ props: { EDGE_JOB_ON: '0' } });
  removeTrigger(w2, 'edgeJobPoll');
  checkThenHeal(w2);
  ok('設定-2 作業依頼の見回りを止めている（EDGE_JOB_ON≠1）なら足さない', countTrigger(w2, 'edgeJobPoll') === 0 && incOf(w2, 'trigger_missing')[0].last_action === 'skip_no_config');
}

console.log('=== 専用のトリガーを作らない（lbNudgeDaily に相乗り・CEO 裁定 2026-11-23） ===');
{
  ok('相乗り-1 setupSelfHealTrigger は無い・lbSelfHeal のトリガーを作る呼び出しが無い', !/function setupSelfHealTrigger/.test(LB) && !/newTrigger\('lbSelfHeal'\)/.test(LB));
}

t.end('自己修理 P1 修理の側');
