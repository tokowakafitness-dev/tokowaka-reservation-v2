// 連続ルール（設計18）：GAS の入口（顧客にだけ絞る）・確定時の判定・どの経路に効くかを確かめる。
//   実行: node worker/test/consec-gas-entry.test.js

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LB = readFileSync(join(ROOT, 'gas/LineBooking.js'), 'utf8');
const BR = readFileSync(join(ROOT, 'gas/BookingRules.js'), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((ln) => ln.replace(/\/\/.*$/, '')).join('\n');
const S = strip(LB);

let pass = 0, fail = 0;
function ok(name, cond, why) {
  if (cond) { pass++; return; }
  fail++; console.log(`❌ ${name}`); if (why) console.log(`   ${why}`);
}
function pluckFn(src, name) {
  const m = src.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('見つからない: ' + name);
  return m[0];
}
function bodyOf(name) { return pluckFn(S, name); }

// ============================================================
console.log('=== 1. 顧客にだけ絞る（getTrainerSlots）===');
function slotsEnv({ mode, cached, built, trainerLines = [], trainerThrows = false, exFresh }) {
  const log = { rebuilt: 0 };
  const ctx = {
    String, Number, Object, Array, Date, isNaN, Math, JSON,
    Logger: { log: () => {} },
    _lbProp: (k) => (k === 'LB_CONSEC_RULE' ? mode : ''),
    getCachedSlots: () => cached,
    buildAndCacheSlots: () => { log.rebuilt++; return built; },
    buildAvailableSlots: () => exFresh,
    _lbDropClosedSlots: (x) => x,
    getTrainerByLine: (id) => { if (trainerThrows) throw new Error('sheet'); return trainerLines.includes(id) ? { name: 'T' } : null; },
  };
  vm.createContext(ctx);
  for (const n of ['getTrainerSlots', '_lbTrainerSlotsAll', '_lbConsecMode', '_lbConsecAllMarked', '_lbIsTrainerCaller']) vm.runInContext(pluckFn(LB, n), ctx);
  return { ctx, log };
}
const sl = (i, c) => Object.assign({ trainerId: 't1', startISO: `2026-10-20T0${i}:00:00.000Z`, startTime: String(i) }, c === undefined ? {} : { consecOk: c });
const T = (r) => (r.slots || []).map((s) => s.startTime).join(',');
{
  const marked = [sl(1, true), sl(2, false), sl(3, true)];
  let e = slotsEnv({ mode: 'on', cached: marked });
  ok('1-1 ★on・顧客：consecOk === true だけ', T(e.ctx.getTrainerSlots({ trainerId: 't1' }, 'Ucust')) === '1,3');
  e = slotsEnv({ mode: 'on', cached: marked, trainerLines: ['Utr'] });
  ok('1-2 ★on・トレーナー：全部', T(e.ctx.getTrainerSlots({ trainerId: 't1' }, 'Utr')) === '1,2,3');
  e = slotsEnv({ mode: 'on', cached: marked, trainerThrows: true });
  ok('1-3 トレーナー表が読めなければ顧客として絞る', T(e.ctx.getTrainerSlots({ trainerId: 't1' }, 'Utr')) === '1,3');
  e = slotsEnv({ mode: 'off', cached: [sl(1), sl(2)] });
  ok('1-4 off：今のまま', T(e.ctx.getTrainerSlots({ trainerId: 't1' }, 'Ucust')) === '1,2');
  e = slotsEnv({ mode: 'dry', cached: [sl(1), sl(2)] });
  ok('1-5 dry：今のまま', T(e.ctx.getTrainerSlots({ trainerId: 't1' }, 'Ucust')) === '1,2');
  e = slotsEnv({ mode: 'on', cached: [sl(1), sl(2)], built: [sl(1, false), sl(2, true)] });
  const r6 = e.ctx.getTrainerSlots({ trainerId: 't1' }, 'Ucust');
  ok('1-6 ★on 直後の印の無い古いキャッシュは作り直して絞る', e.log.rebuilt === 1 && T(r6) === '2', JSON.stringify(r6));
  e = slotsEnv({ mode: 'on', cached: [sl(1)], built: [sl(1)] });
  const r7 = e.ctx.getTrainerSlots({ trainerId: 't1' }, 'Ucust');
  ok('1-7 ★作り直しても印が無ければ、枠を返さず失敗で答える（全部見せない・0件と言わない）', r7.success === false && r7.code === 'SLOTS_UNAVAILABLE');
  e = slotsEnv({ mode: 'on', exFresh: [sl(1, true), sl(2, false)] });
  ok('1-8 変更（その場計算）も顧客には絞る', T(e.ctx.getTrainerSlots({ trainerId: 't1', excludeStartISO: '2026-10-20T01:00:00.000Z' }, 'Ucust')) === '1');
  e = slotsEnv({ mode: 'on', cached: [] });
  ok('1-9 0件は 0件で答える', e.ctx.getTrainerSlots({ trainerId: 't1' }, 'Ucust').success === true);
  e = slotsEnv({ mode: 'ON!', cached: [sl(1)] });
  ok('1-10 知らない値は off', T(e.ctx.getTrainerSlots({ trainerId: 't1' }, 'Ucust')) === '1');
  ok('1-11 ★3つの入口すべてが検証済みの lineUserId を渡す',
     /_res = getTrainerSlots\(body, lineUserId\);/.test(S) && /res = getTrainerSlots\(body, lineUserId\);/.test(S)
     && /getTrainerSlots\(\{ trainerId: params\.trainerId, excludeStartISO: params\.excludeStartISO \}, lineUserId\)/.test(S)
     && (S.match(/getTrainerSlots\(/g) || []).length === 4,   // 定義1＋入口3
     'body の lineUserId を使うと、顧客がトレーナーのふりをして全部の枠を見られる');
}

// ============================================================
console.log('=== 2. 確定時の判定（_lbConsecCheckAt）===');
{
  const M = 60000, D = new Date(2026, 9, 20, 0, 0).getTime();
  const at = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return D + (h * 60 + m) * M; };
  function env(trainerEv, b1Ev, opt = {}) {
    const ev = (e) => ({ getTitle: () => e.title, getStartTime: () => new Date(e.start), getEndTime: () => new Date(e.end) });
    const ctx = {
      String, Number, Object, Array, Date, Math, JSON, isFinite,
      Logger: { log: () => {} },
      CALENDAR_IDS: { CAPACITY_B1: 'b1', TRAINERS: [{ id: 'T1', name: '鈴木 一郎', email: 'suz' }, { id: 'T2', name: '沖 二郎', email: 'oki' }] },
      CalendarApp: { getCalendarById: (id) => {
        if (opt.throwOn === id) return { getEvents: () => { throw new Error('read'); } };
        if (opt.nullOn === id) return null;
        const list = id === 'b1' ? b1Ev : trainerEv;
        return { getEvents: (s, e) => list.filter((x) => x.start < e.getTime() && x.end > s.getTime()).map(ev) };
      } },
      _lbIsSessionTitle: (t) => /^(\[RESERVED\]|✅)/.test(t) && !/休憩|ブロック/.test(t),
    };
    vm.createContext(ctx);
    vm.runInContext(BR.replace(/if \(typeof module[\s\S]*$/, ''), ctx);
    vm.runInContext(pluckFn(LB, '_lbConsecCheckAt'), ctx);
    return ctx;
  }
  const s = (a, b, n = 'A') => ({ title: `✅ ${n}様｜セッション_line`, start: at(a), end: at(b) });
  const tr = { id: 'T1', name: '鈴木 一郎', email: 'suz' };
  const run = [s('10:00', '11:00'), s('11:00', '12:00'), s('12:00', '13:00')];
  let c = env(run, []);
  ok('2-1 ★10-13 の直後 13:00 は弾く', c._lbConsecCheckAt(tr, new Date(at('13:00')), new Date(at('14:00')), null).ok === false);
  ok('2-2 13:15 は通す', c._lbConsecCheckAt(tr, new Date(at('13:15')), new Date(at('14:15')), null).ok === true);
  c = env([s('10:00', '11:00'), { title: '✅ 体験様｜カウンセリング', start: at('11:00'), end: at('12:30') }, s('12:30', '13:30')],
          [{ title: '[RESERVED] 体験_鈴木_体験様', start: at('11:00'), end: at('12:30') }]);
  ok('2-3 ★体験は数えない', c._lbConsecCheckAt(tr, new Date(at('13:30')), new Date(at('14:30')), null).ok === true);
  c = env(run, [], { throwOn: 'b1' });
  const u = c._lbConsecCheckAt(tr, new Date(at('13:15')), new Date(at('14:15')), null);
  ok('2-4 ★B1 が読めなければ unknown（弾く側）', u.ok === false && u.unknown === true);
  c = env(run, [], { nullOn: 'suz' });
  ok('2-5 トレーナーcalが取れなければ unknown', c._lbConsecCheckAt(tr, new Date(at('13:15')), new Date(at('14:15')), null).unknown === true);
  c = env(run, []);
  ok('2-6 変更：自分の旧予定（12:00）は数えない', c._lbConsecCheckAt(tr, new Date(at('12:15')), new Date(at('13:15')), at('12:00')).ok === true);
}

// ============================================================
console.log('=== 3. どの経路に効くか（C4）===');
{
  ok('3-1 顧客の単発予約', /'line'\);\s*\}/.test(bodyOf('makeReservationLine')) && /consecRule: true/.test(bodyOf('makeReservationLine')));
  ok('3-2 顧客の繰り返し予約', /consecRule: true/.test(bodyOf('makeRecurringReservationLine')));
  ok('3-3 顧客のまとめて予約', /consecRule: true/.test(bodyOf('makeBatchReservationLine')));
  ok('3-4 顧客の振替', /consecRule: true/.test(bodyOf('makeTransferReservationLine')));
  ok('3-5 ★予約の変更は「操作者＝予約の持ち主」のときだけ', /consecRule: \(String\(r\[3\]\) === String\(lineUserId\)\)/.test(bodyOf('changeReservationLine')),
     'トレーナーが他人の予約を変えるときは当てない');
  ok('3-6 ★代行には効かない', !/consecRule/.test(bodyOf('makeReservationLineProxy')) && !/consecRule/.test(bodyOf('makeBatchReservationLineProxy')));
  ok('3-7 ★固定枠の自動予約には効かない', !/consecRule/.test(bodyOf('autoBookRecurringPatterns')));
  const core = bodyOf('_lbReserveCoreImpl');
  ok('3-8 確定時の判定は consecRule === true のときだけ・体験の契約は除く',
     /if \(custInfo\.consecRule === true && String\(custInfo\.contractType \|\| ''\)\.indexOf\('体験'\) < 0\)/.test(core));
  ok('3-9 ★判定はカレンダーを作る前', core.indexOf('_lbConsecCheckAt(') > 0 && core.indexOf('_lbConsecCheckAt(') < core.indexOf('calB1.createEvent('));
  ok('3-10 読めないときは SLOT_CHECK_UNAVAILABLE で弾く（on）', /if \(_cv\.unknown\) return \{ success: false, code: 'SLOT_CHECK_UNAVAILABLE'/.test(core));
  ok('3-11 ★ロックの中で判定するのは on のときだけ', /var _cm = _lbConsecMode\(\);\s*if \(_cm === 'on'\) \{/.test(core) && !/DRY_/.test(core),
     'dry をロックの中で判定すると、結果を変えないのに同時に予約した人を待たせる（関門③）');
  const wrap = bodyOf('_lbReserveCore');
  ok('3-11b ★dry は予約が成立した後（ロックの外）で記録だけ',
     /if \(r && r\.success && custInfo && custInfo\.consecRule === true/.test(wrap) && /if \(_lbConsecMode\(\) === 'dry'\) _lbConsecDryRecord\(body, channel\);/.test(wrap)
     && wrap.indexOf('_lbConsecDryRecord') > wrap.indexOf('_lbReserveCoreImpl('));
  const dry = bodyOf('_lbConsecDryRecord');
  ok('3-11c dry の判定は、いま作った予約と旧予定の両方を連続から外す', /var ex = \[st\.getTime\(\)\];/.test(dry) && /ex\.push\(ox\)/.test(dry));
  ok('3-11d 判定にかかった時間を残す（ms=）', /' ms=' \+ \(Date\.now\(\) - t0\)/.test(dry) && /' ms=' \+ \(Date\.now\(\) - _cvT0\)/.test(core));
  const sw = bodyOf('_lbConsecSwitch');
  ok('3-11e ★切り替えたらその場で枠を作り直して写しを送る', /p\.setProperty\('LB_CONSEC_RULE', mode\);[\s\S]*pushToEdgeSlots\(\);/.test(sw),
     '次の定期処理まで最大10分、画面と判定がずれる（関門③）');
  ok('3-11f 切り替えの関数は引数なしで押せる（GAS エディタは引数を渡せない）',
     /function lbConsecSetOff\(\) \{ return _lbConsecSwitch\('off'\); \}/.test(S) && /function lbConsecSetDry\(\) \{ return _lbConsecSwitch\('dry'\); \}/.test(S) && /function lbConsecSetOn\(\)  \{ return _lbConsecSwitch\('on'\); \}/.test(S));
  // 切り替えを動かす：今回の送信が成功したときだけ ✅、失敗なら元に戻して送り直す
  function swEnv(pushBehaviors) {
    const props = new Map([['LB_CONSEC_RULE', 'off'], ['LB_SLOTS_CONSEC_SENT', 'off|' + (Date.now() - 60000)]]);
    let call = 0;
    const c = {
      String, Number, Date, Math,
      Logger: { log: () => {} },
      PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props.get(k) || null, setProperty: (k, v) => props.set(k, String(v)) }) },
      _lbProp: (k) => props.get(k) || '',
      pushToEdgeSlots: () => {
        const b = pushBehaviors[call++];
        if (b === 'ok') props.set('LB_SLOTS_CONSEC_SENT', (props.get('LB_CONSEC_RULE') === 'on' ? 'on' : 'off') + '|' + Date.now());
        if (b === 'throw') throw new Error('push');
      },
    };
    vm.createContext(c);
    vm.runInContext(pluckFn(LB, '_lbConsecMode') + '\n' + pluckFn(LB, '_lbConsecSwitch'), c);
    return { c, props };
  }
  {
    const { c, props } = swEnv(['ok']);
    const m = c._lbConsecSwitch('on');
    ok('3-11g 送れたら ✅ でスイッチは on', /✅/.test(m) && props.get('LB_CONSEC_RULE') === 'on');
  }
  {
    const { c, props } = swEnv(['silent', 'ok']);     // 今回の送信は記録を残さず失敗（直前の off 記録は残っている）
    const m = c._lbConsecSwitch('dry');
    ok('3-11h ★今回送れていなければ、直前の記録があっても ✅ にしない', !/✅/.test(m) && /❌/.test(m), m);
  }
  {
    const { c, props } = swEnv(['throw', 'ok']);
    const m = c._lbConsecSwitch('on');
    ok('3-11i ★on に切り替えて送れなければ、スイッチを元（off）に戻して送り直す', props.get('LB_CONSEC_RULE') === 'off' && /戻しの写し: off/.test(m), m);
  }
  ok('3-12 CONSEC_ の記録は予約の成否の集計に混ぜない', /if \(oc\.indexOf\('CONSEC_'\) === 0\) \{ consec\[oc\]/.test(bodyOf('getBookingMetrics')));
  const batch = bodyOf('_lbBatchReserve');
  ok('3-13 まとめて予約は custInfo を写して使う（consecRule が引き継がれる）', /for \(var kk in custInfo\) _ci\[kk\] = custInfo\[kk\];/.test(batch));
}

// ============================================================
console.log('=== 4. 関門②で直したもの ===');
{
  const PE = strip(readFileSync(join(ROOT, 'gas/PushToEdge.js'), 'utf8'));
  const rowsFn = pluckFn(PE, '_edgeSlotRows'), sendFn = pluckFn(PE, '_edgeSendSlots');
  ok('4-1 ★写しを組み立てる処理は「送った」記録を書かない', !/LB_SLOTS_CONSEC_SENT/.test(rowsFn),
     '組み立てた時点で書くと、送信が失敗し続けても見張りが黙る');
  ok('4-2 ★送れた後（_edgePushRowsF が戻った後）にだけ記録する',
     sendFn.indexOf("_edgePushRowsF('slots'") > 0 && sendFn.indexOf('LB_SLOTS_CONSEC_SENT') > sendFn.indexOf("_edgePushRowsF('slots'"));
  ok('4-3 送る前に控えを空にする（前の実行の値で記録しない）', /_LB_SLOTS_CONSEC_BUILT = '';\s*var n = _edgePushRowsF/.test(sendFn));
  const core = bodyOf('_lbReserveCore');
  ok('4-4 ★連続ルールで弾いた分は SLOT_TAKEN として二重に数えない', /if \(r && r\._skipOutcome\) delete r\._skipOutcome;/.test(core));
  ok('4-5 弾くときは _skipOutcome を付ける', (bodyOf('_lbReserveCoreImpl').match(/_skipOutcome: true/g) || []).length === 2);
  const LIFF = readFileSync(join(ROOT, 'liff/index.html'), 'utf8');
  ok('4-6 ★取れなかった枠のまま押し直させない', /state\.slotTakenKey = slotKeyOf\(state\.selected\);[^\n]*\n\s*btn\.disabled = true;/.test(LIFF));
  ok('4-7 あとから選択肢の取得が終わっても有効に戻さない', /b\.disabled = !\(state\.optReady && !state\.optError\) \|\| taken;/.test(LIFF));
  // 画面の関数を取り出して動かす（状態遷移と後着の競合）
  const fnSrc = (name) => { const m = LIFF.match(new RegExp('function ' + name + '\\([^)]*\\)\\{[\\s\\S]*?\\n  \\}')); if (!m) throw new Error(name); return m[0]; };
  {
    const btn = { disabled: false };
    const c = { state: { optReady: true, optError: '', trainerId: 'A' }, document: { getElementById: () => btn } };
    vm.createContext(c);
    vm.runInContext(fnSrc('slotKeyOf') + '\n' + fnSrc('setConfirmEnabled'), c);
    c.state.selected = { trainerId: 'A', startISO: '2026-10-20T01:00:00Z' };
    c.state.slotTakenKey = c.slotKeyOf(c.state.selected);
    c.setConfirmEnabled();
    const aDisabled = btn.disabled;
    c.state.selected = { trainerId: 'B', startISO: '2026-10-20T01:00:00Z' };
    c.setConfirmEnabled();
    ok('4-9 ★A の10:00 で取れなかった後、B の10:00 は押せる（時刻だけで止めない）', aDisabled === true && btn.disabled === false);
  }
  {
    let resolveOld;
    const calls = [];
    const c = {
      state: { trainerId: 'A', excludeStartISO: '', slots: ['old'] },
      api: (req) => { calls.push(req); return new Promise((r) => { if (!resolveOld) resolveOld = r; else r({ success: true, slots: ['new'] }); }); },
      renderWeek: () => {}, renderBatchBar: () => {},
    };
    vm.createContext(c);
    vm.runInContext(fnSrc('refreshSlotsQuietly'), c);
    c.refreshSlotsQuietly();                                   // 裏の取り直しを開始（まだ返らない）
    c.state.excludeStartISO = '2026-10-21T01:00:00Z';          // 同じトレーナーで変更モードへ
    c.state.slotsGen += 1; c.state.slots = ['change-mode'];    // loadSlots が番号を進めて新しい一覧を出した
    resolveOld({ success: true, slots: ['stale'] });           // 古い取り直しが後から返る
    await new Promise((r) => setTimeout(r, 0));
    ok('4-10 ★古い取り直しの結果で、新しい一覧を上書きしない', JSON.stringify(c.state.slots) === '["change-mode"]', JSON.stringify(c.state.slots));
  }
  ok('4-11 loadSlots が番号を進める', /function loadSlots\(\)\{\s*state\.slotsGen = \(state\.slotsGen \|\| 0\) \+ 1;/.test(LIFF));
  ok('4-8 別の枠を選べば openConfirm がボタンを作り直す', /function openConfirm\(slot\)\{\s*state\.selected = slot;[\s\S]{0,4000}setConfirmEnabled\(\);/.test(LIFF));
}

console.log('');
console.log(`${fail ? '❌' : '✅'} 連続ルール（GAS の入口と確定） 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
