// ============================================================
// GAS の「空き枠」を Node で再現する土台（ハーネス）
//
//   なぜ要るか：
//     Googleカレンダー → Cloudflare D1 へ移し、D1 から空き枠を出す実装に切り替える。
//     切り替えの条件は「D1 が出す空き枠が、いま GAS が出している空き枠と1件も違わない」こと。
//     本番で突き合わせてから気づくのでは遅い。だから GAS の答えを Node 上で再現し、
//     実装中いつでも機械で突き合わせられる土台をここに置く。
//
//   正本は GAS（gas/コード.js の buildAvailableSlots）。このファイルは「写し」ではなく「取り出し」。
//     条件は書き写さない。GAS のソースから関数そのものを抜いて評価し、
//     module.exports を持つ gas/BookingRules.js は require してそのまま使う。
//     ここで書くのは「GAS API に依存して取り出せない部分」＝ buildAvailableSlots の
//     カレンダー取得とループ本体だけ。
//
//   使い方（ライブラリ）:
//     import { gasBuildSlots, diffSlots } from './gas-slots-harness.js';
//     const slots = gasBuildSlots({ nowMs, horizonEndMs, trainers, shifts, busy, roomBusy, ... });
//
//   自己テスト: node worker/test/gas-slots-harness.js
// ============================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const GAS = join(HERE, '../../gas');
const require_ = createRequire(import.meta.url);

// ------------------------------------------------------------
// ① GAS から「そのまま使えるもの」を取り出す
// ------------------------------------------------------------

// (a) gas/BookingRules.js は module.exports を持つ＝require できる。締め切り判定はここが正本。
export const BR = require_(join(GAS, 'BookingRules.js'));
const _lbBookingOpen = BR._lbBookingOpen;     // 締め切り（午前枠＝前日22時／他＝開始180分前）
const _lbBookingCfg = BR._lbBookingCfg;       // SETTINGS → cfg
const _lbJstParts = BR._lbJstParts;           // JST壁時計の読み取り
const _lbJstMs = BR._lbJstMs;                 // JST壁時計 → epoch ms

// (b) コード.js / LineBooking.js は GAS API に依存して丸ごと読めない。必要な関数・定数だけ抜く。
function pluck(src, pattern, what) {
  const m = src.match(pattern);
  if (!m) throw new Error('GASに ' + what + ' が見つかりません（ハーネスが追従できていない）');
  return m[0];
}
function pluckFn(src, name) {
  return pluck(src, new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'), name);
}
function pluckVar(src, name) {
  return pluck(src, new RegExp('var ' + name + ' = \\{[\\s\\S]*?\\n\\};'), name);
}

const CODE = readFileSync(join(GAS, 'コード.js'), 'utf8');
const LINEBOOKING = readFileSync(join(GAS, 'LineBooking.js'), 'utf8');

const ctx = { console, String, Number, Math, Date, isFinite, JSON };
ctx.global = ctx;
vm.createContext(ctx);
// 設定値（刻み・セッション長・締め切り）とトレーナー定義は GAS の宣言をそのまま評価する＝値を書き写さない
vm.runInContext(pluckVar(CODE, 'SETTINGS'), ctx, { filename: 'SETTINGS.js' });
vm.runInContext(pluckVar(CODE, 'CALENDAR_IDS'), ctx, { filename: 'CALENDAR_IDS.js' });
vm.runInContext(pluckFn(CODE, '_lbSubtractIntervals'), ctx, { filename: '_lbSubtractIntervals.js' });
vm.runInContext(pluckFn(LINEBOOKING, '_lbInOwnerWindow'), ctx, { filename: '_lbInOwnerWindow.js' });

/** GAS の SETTINGS そのもの（刻み・セッション長・締め切り設定の正本） */
export const GAS_SETTINGS = ctx.SETTINGS;
/** GAS の CALENDAR_IDS.TRAINERS から id/name/hidden だけを取った既定のトレーナー一覧（順序も GAS と同じ） */
export const GAS_TRAINERS = ctx.CALENDAR_IDS.TRAINERS.map((t) => ({ id: t.id, name: t.name, hidden: !!t.hidden }));
/** GAS の区間引き算（出勤シフト − 埋まり → 空きブロック）。GASソースから取り出したもの */
export const gasSubtractIntervals = ctx._lbSubtractIntervals;
/** GAS のオーナー枠フィルタ（曜日×時間帯）。GASソースから取り出したもの */
const _lbInOwnerWindow = ctx._lbInOwnerWindow;
/** GAS の締め切り判定（BookingRules.js を require したもの） */
export const gasBookingOpen = _lbBookingOpen;
/** SETTINGS から作る既定の締め切り設定 */
export function gasBookingCfg(settings) {
  return _lbBookingCfg(settings || GAS_SETTINGS);
}

// ------------------------------------------------------------
// ② GAS API に依存して取り出せない部分（ここだけがハーネス自前の実装）
//    対応元：gas/コード.js buildAvailableSlots（257行付近）のカレンダー取得＋枠生成ループ
// ------------------------------------------------------------

// GAS では st.getDay() / st.getHours() / Utilities.formatDate が script timezone（Asia/Tokyo）で動く。
// Node のローカルTZに引きずられないよう、JST の壁時計を返す Date 風オブジェクトを渡す。
function jstClock(ms) {
  const p = _lbJstParts(ms);
  const dow = new Date(Date.UTC(p.y, p.mo, p.d)).getUTCDay();
  return {
    getDay: () => dow,
    getHours: () => p.h,
    getMinutes: () => p.mi,
    parts: p,
    dow,
  };
}
const DOW_JA = ['日', '月', '火', '水', '木', '金', '土'];
const pad2 = (n) => (n < 10 ? '0' + n : String(n));

// 入力の区間を {startMs, endMs} に正規化。ms数値 / Date / ISO文字列 / {startMs,endMs} を受ける。
function toMs(v, where) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const t = new Date(v).getTime();
    if (!isNaN(t)) return t;
  }
  throw new Error('時刻として読めません（' + where + '）: ' + String(v));
}
function normIv(iv, where) {
  const s = iv.startMs != null ? iv.startMs : iv.start;
  const e = iv.endMs != null ? iv.endMs : iv.end;
  return { startMs: toMs(s, where + '.start'), endMs: toMs(e, where + '.end') };
}
function normIvList(list, where) {
  return (list || []).map((iv, i) => normIv(iv, where + '[' + i + ']'));
}
// GAS の CalendarApp.getEvents(now, endDate) は「範囲に少しでも触れる予定」を返す（境界で接するだけも返る）。
// 取得範囲の再現はこの寛容な判定で行う（引き算側で base にクリップされるので、
// 接するだけの予定を混ぜても結果は変わらない＝安全側の上位集合）。
function touchesWindow(iv, fromMs, toMsV) {
  if (fromMs != null && iv.endMs < fromMs) return false;
  if (toMsV != null && iv.startMs > toMsV) return false;
  return true;
}
// _lbSubtractIntervals は Date を持つ {start,end} を要求する
const toDateIv = (iv) => ({ start: new Date(iv.startMs), end: new Date(iv.endMs) });

/**
 * gas/コード.js buildAvailableSlots と同じ空き枠を返す（純粋関数・カレンダーAPIを呼ばない）。
 *
 * @param {object} input
 * @param {number} input.nowMs            「いま」。締め切り判定と取得範囲の始点に使う（必須）
 * @param {number} [input.horizonEndMs]   地平の終わり。取得範囲の終点（省略＝範囲で絞らない）
 * @param {Array}  [input.trainers]       [{id, name, hidden}]。順序も GAS の TRAINERS 順に合わせる（既定＝GAS_TRAINERS）
 * @param {object} [input.shifts]         {trainerId: [{start,end}, ...]} 出勤シフト（isShiftEvent 該当イベント）
 * @param {object} [input.busy]           {trainerId: [{start,end}, ...]} そのトレーナーcalの埋まり（_lbIsBusyTitle 該当）
 * @param {Array}  [input.roomBusy]       [{start,end}] B1施設の埋まり（[消化]除外済み・全トレーナーに効く）
 * @param {object} [input.oneFBusy]       {trainerId: [{start,end}]} 1Fで担当が特定できる予定（そのトレーナーだけ塞ぐ）
 * @param {Array}  [input.oneFBlockAll]   [{start,end}] 1Fで担当不明（全トレーナーを塞ぐ）
 * @param {object|null} [input.ownerWindow] hidden トレーナーの曜日×時間帯（null/未指定＝制限なし）
 * @param {number} [input.sessionMinutes] 既定 SETTINGS.SESSION_MINUTES
 * @param {number} [input.trialMinutes]   既定 SETTINGS.TRIAL_SESSION_MINUTES || SESSION_MINUTES
 * @param {number} [input.pickerStepMinutes] 既定 SETTINGS.PICKER_STEP_MINUTES || 15
 * @param {object} [input.bookingCfg]     締め切り設定（既定＝_lbBookingCfg(SETTINGS)）
 * @param {boolean} [input.fetchWindow]   取得範囲で入力を絞るか（既定 true。入力が既に絞られているなら false でも同じ）
 * @returns {Array<{startISO,endISO,startMs,endMs,trainerId,trainerName,trialOk,date,dayOfWeek,startTime,endTime}>}
 *          並び順も GAS と同じ（トレーナー順 → シフト順 → ブロック順 → 開始時刻昇順）
 */
export function gasBuildSlots(input) {
  const inp = input || {};
  if (inp.nowMs == null) throw new Error('nowMs は必須です（締め切り判定に使う）');
  const nowMs = toMs(inp.nowMs, 'nowMs');
  const horizonEndMs = inp.horizonEndMs == null ? null : toMs(inp.horizonEndMs, 'horizonEndMs');
  const useWindow = inp.fetchWindow !== false;
  const winFrom = useWindow ? nowMs : null;
  const winTo = useWindow ? horizonEndMs : null;

  const trainers = inp.trainers || GAS_TRAINERS;
  const sessionMs = (inp.sessionMinutes != null ? inp.sessionMinutes : GAS_SETTINGS.SESSION_MINUTES) * 60000;
  const trialMs =
    (inp.trialMinutes != null
      ? inp.trialMinutes
      : GAS_SETTINGS.TRIAL_SESSION_MINUTES || GAS_SETTINGS.SESSION_MINUTES) * 60000;
  const pickStep = (inp.pickerStepMinutes != null ? inp.pickerStepMinutes : GAS_SETTINGS.PICKER_STEP_MINUTES || 15) * 60000;
  if (!(sessionMs > 0) || !(pickStep > 0)) throw new Error('sessionMinutes / pickerStepMinutes は正の値が必要です');
  const cfg = inp.bookingCfg || gasBookingCfg();
  const ownerWin = inp.ownerWindow == null ? null : inp.ownerWindow;

  const roomBusy = normIvList(inp.roomBusy, 'roomBusy').filter((iv) => touchesWindow(iv, winFrom, winTo));
  const blockAll = normIvList(inp.oneFBlockAll, 'oneFBlockAll').filter((iv) => touchesWindow(iv, winFrom, winTo));

  const out = [];
  for (let ti = 0; ti < trainers.length; ti++) {
    const trainer = trainers[ti];
    const tid = String(trainer.id);
    const shifts = normIvList((inp.shifts || {})[tid], 'shifts.' + tid).filter((iv) => touchesWindow(iv, winFrom, winTo));
    // 埋まりの合算（GAS と同じ順序・同じ4系統）：
    //   そのトレーナーcalの埋まり ＋ B1施設(全員) ＋ 1Fで自分に帰属 ＋ 1Fで担当不明(全員)
    const mine = normIvList((inp.busy || {})[tid], 'busy.' + tid).filter((iv) => touchesWindow(iv, winFrom, winTo));
    const f1mine = normIvList((inp.oneFBusy || {})[tid], 'oneFBusy.' + tid).filter((iv) => touchesWindow(iv, winFrom, winTo));
    const busy = mine.concat(roomBusy).concat(f1mine).concat(blockAll).map(toDateIv);

    for (let si = 0; si < shifts.length; si++) {
      const shiftEndMs = shifts[si].endMs; // 退勤時刻。体験90分がここを超えるのは許す（trialOk）
      const freeBlocks = gasSubtractIntervals(toDateIv(shifts[si]), busy);
      for (let bi = 0; bi < freeBlocks.length; bi++) {
        const blockEnd = freeBlocks[bi].end.getTime();
        // 残り時間で刻みを動的に切替：2枠以上残る区間は60分刻み／最後の1枠になったら15分刻み
        for (
          let cur = freeBlocks[bi].start.getTime();
          cur + sessionMs <= blockEnd;
          cur += blockEnd - cur >= 2 * sessionMs ? sessionMs : pickStep
        ) {
          if (!_lbBookingOpen(cur, nowMs, cfg)) continue; // 締め切り済みの枠は出さない
          const clock = jstClock(cur);
          if (trainer.hidden && !_lbInOwnerWindow(clock, ownerWin)) continue; // hidden は曜日×時間帯だけ
          // 体験は90分押さえる。ただし「ブロックの終わりが退勤時刻」なら60分でも可。
          const trialOk = cur + trialMs <= blockEnd || (blockEnd === shiftEndMs && cur + sessionMs <= blockEnd);
          const endMs = cur + sessionMs;
          const ep = _lbJstParts(endMs);
          out.push({
            date: clock.parts.y + '/' + pad2(clock.parts.mo + 1) + '/' + pad2(clock.parts.d),
            dayOfWeek: DOW_JA[clock.dow],
            startTime: pad2(clock.parts.h) + ':' + pad2(clock.parts.mi),
            endTime: pad2(ep.h) + ':' + pad2(ep.mi),
            startISO: new Date(cur).toISOString(),
            endISO: new Date(endMs).toISOString(),
            startMs: cur,
            endMs: endMs,
            trainerName: trainer.name,
            trainerId: trainer.id,
            trialOk: trialOk,
          });
        }
      }
    }
  }
  return out;
}

// ------------------------------------------------------------
// ③ 突き合わせ用のヘルパー（D1 の答えと1件ずつ比べる）
// ------------------------------------------------------------

/** 枠の同一性キー（トレーナー × 開始時刻） */
export function slotKey(s) {
  const ms = s.startMs != null ? s.startMs : new Date(s.startISO).getTime();
  return String(s.trainerId) + '|' + new Date(ms).toISOString();
}

/**
 * GAS側の枠と別実装（D1側）の枠を突き合わせる。1件も違わないことの検査に使う。
 * @returns {{equal:boolean, onlyInGas:Array, onlyInOther:Array, trialOkMismatch:Array}}
 */
export function diffSlots(gasSlots, otherSlots) {
  const A = new Map((gasSlots || []).map((s) => [slotKey(s), s]));
  const B = new Map((otherSlots || []).map((s) => [slotKey(s), s]));
  const onlyInGas = [];
  const onlyInOther = [];
  const trialOkMismatch = [];
  for (const [k, a] of A) {
    if (!B.has(k)) onlyInGas.push(k);
    else if (!!a.trialOk !== !!B.get(k).trialOk) trialOkMismatch.push({ key: k, gas: !!a.trialOk, other: !!B.get(k).trialOk });
  }
  for (const k of B.keys()) if (!A.has(k)) onlyInOther.push(k);
  return {
    equal: onlyInGas.length === 0 && onlyInOther.length === 0 && trialOkMismatch.length === 0,
    onlyInGas,
    onlyInOther,
    trialOkMismatch,
  };
}

/** JST の壁時計から epoch ms（テスト・比較の入力を書きやすくするため。mo は1起点） */
export function jstMs(y, mo, d, h, mi) {
  return _lbJstMs(y, mo - 1, d, h, mi || 0);
}
/** 枠配列 → 'HH:mm' の配列（検査結果を読みやすくする） */
export function startTimes(slots) {
  return slots.map((s) => s.startTime);
}

// ============================================================
// 自己テスト（node worker/test/gas-slots-harness.js）
//   土台そのものが GAS と同じ答えを返すことを固定する。
//   境界（ちょうど60分・ちょうど退勤時刻・ちょうど締め切り）を重点的に置く。
// ============================================================
function runSelfTest() {
  let pass = 0;
  const fails = [];
  function eq(name, got, want) {
    const G = JSON.stringify(got);
    const W = JSON.stringify(want);
    if (G === W) pass++;
    else fails.push(name + '\n   got : ' + G + '\n   want: ' + W);
  }
  function ok(name, cond) {
    if (cond) pass++;
    else fails.push(name);
  }

  const T = [{ id: 'B', name: '鈴木 神海感留', hidden: false }];
  const TT = [
    { id: 'B', name: '鈴木 神海感留', hidden: false },
    { id: 'C', name: '沖 孟', hidden: false },
  ];
  const OWNER = [{ id: 'A', name: '中野 龍之介', hidden: true }];
  // 締め切りが効かない十分前の「いま」（構造の検査で締め切りに邪魔されないため）
  const NOW_FAR = jstMs(2026, 10, 1, 9, 0);
  const HZ = jstMs(2026, 10, 31, 23, 59);
  // 2026-10-05=月 / 2026-10-07=水 / 2026-10-20=火
  const D = (h, mi) => jstMs(2026, 10, 20, h, mi || 0);
  const MON = (h, mi) => jstMs(2026, 10, 5, h, mi || 0);
  const WED = (h, mi) => jstMs(2026, 10, 7, h, mi || 0);

  function build(over) {
    return gasBuildSlots(Object.assign({ nowMs: NOW_FAR, horizonEndMs: HZ, trainers: T }, over));
  }

  // --- 0. 取り出しが成立していること ---------------------------------
  // GAS側のループ本体だけは取り出せない＝手で移している。だからGASの原文が変わったら気づけるようにする。
  //   ここが落ちたら、GASの buildAvailableSlots が変わっている＝このハーネスを追従させるまで信用できない。
  const MIRRORED = [
    // 枠の条件と刻みの動的切替
    'for (var cur = blk.start.getTime(); cur + sessionMs <= blockEnd;',
    'cur += ((blockEnd - cur) >= 2 * sessionMs ? sessionMs : pickStep)) {',
    // 締め切り
    'if (!_lbBookingOpen(cur, nowMs, _lbBookingCfg(SETTINGS))) continue;',
    // hidden × ownerWindow
    'if (trainer.hidden && !_lbInOwnerWindow(st, ownerWin)) continue;',
    // trialOk
    'var trialOk = ((cur + trialMs) <= blockEnd)',
    '|| ((blockEnd === shiftEndMs) && (cur + sessionMs) <= blockEnd);',
    // 埋まりの合算（4系統・この順）
    'var busy    = (trainerReserved[trainer.id] || []).concat(eventsB1).concat(f1mine).concat(f1BlockAll);',
    // 長さの出どころ
    'var sessionMs = SETTINGS.SESSION_MINUTES * 60000;',
    'var trialMs   = (SETTINGS.TRIAL_SESSION_MINUTES || SETTINGS.SESSION_MINUTES) * 60000;',
    'var pickStep  = (SETTINGS.PICKER_STEP_MINUTES || 15) * 60000;',
    // ブロック生成と退勤時刻
    'var shiftEndMs = shifts[si].end.getTime();',
    'var freeBlocks = _lbSubtractIntervals(shifts[si], busy);',
  ];
  const drifted = MIRRORED.filter((s) => CODE.indexOf(s) < 0);
  eq('⓪ GASの buildAvailableSlots 原文と乖離していない（乖離したらここが落ちる）', drifted, []);

  ok('GASのSETTINGSを取り出せる（60分/90分/15分/180分）',
    GAS_SETTINGS.SESSION_MINUTES === 60 && GAS_SETTINGS.TRIAL_SESSION_MINUTES === 90 &&
    GAS_SETTINGS.PICKER_STEP_MINUTES === 15 && GAS_SETTINGS.BOOKING_LEAD_MINUTES === 180);
  ok('GASのTRAINERSを取り出せる（中野だけhidden）',
    GAS_TRAINERS.length === 3 && GAS_TRAINERS[0].hidden === true &&
    GAS_TRAINERS[1].hidden === false && GAS_TRAINERS[2].hidden === false);
  ok('_lbSubtractIntervals / _lbInOwnerWindow / _lbBookingOpen が揃っている',
    typeof gasSubtractIntervals === 'function' && typeof _lbInOwnerWindow === 'function' &&
    typeof _lbBookingOpen === 'function');

  // --- 1. シフト7:00-23:00・埋まりなし → 60分刻みで16枠 --------------
  const s1 = build({ shifts: { B: [{ start: D(7), end: D(23) }] } });
  eq('① 7:00-23:00・埋まりなし＝16枠が毎時ちょうど', startTimes(s1),
    ['07:00','08:00','09:00','10:00','11:00','12:00','13:00','14:00',
     '15:00','16:00','17:00','18:00','19:00','20:00','21:00','22:00']);
  eq('① 枠の終わりは開始+60分', s1[0].endTime, '08:00');
  eq('① 日付・曜日はJSTで入る', [s1[0].date, s1[0].dayOfWeek], ['2026/10/20', '火']);

  // --- 2. 真ん中に予約1件 → ブロックが2つに割れ、それぞれの端から詰まる ---
  const s2 = build({ shifts: { B: [{ start: D(7), end: D(23) }] }, busy: { B: [{ start: D(12), end: D(13) }] } });
  eq('② 12:00-13:00の予約でブロックが2つに割れる', startTimes(s2),
    ['07:00','08:00','09:00','10:00','11:00',                      // 7:00-12:00（最後は11:00で終端ぴったり）
     '13:00','14:00','15:00','16:00','17:00','18:00','19:00','20:00','21:00','22:00']);
  const s2b = build({ shifts: { B: [{ start: D(7), end: D(23) }] }, busy: { B: [{ start: D(12, 30), end: D(13, 30) }] } });
  eq('② 端が30分ずれても各ブロックの端から詰まる（吸着）', startTimes(s2b),
    ['07:00','08:00','09:00','10:00','11:00','11:15','11:30',      // 7:00-12:30 の端から（最後の1枠は15分刻み）
     '13:30','14:30','15:30','16:30','17:30','18:30','19:30','20:30','21:30','21:45','22:00']);

  // --- 3. 最後の1枠が15分刻みになる（仕様の例） ----------------------
  const s3 = build({ shifts: { B: [{ start: D(20, 30), end: D(23) }] } });
  eq('③ 20:30-23:00 → 20:30/21:30/21:45/22:00', startTimes(s3), ['20:30','21:30','21:45','22:00']);

  // --- 3b. 刻み切替のちょうど境界 ------------------------------------
  eq('③b ちょうど60分のブロック＝1枠だけ',
    startTimes(build({ shifts: { B: [{ start: D(10), end: D(11) }] } })), ['10:00']);
  eq('③b 59分のブロック＝0枠',
    startTimes(build({ shifts: { B: [{ start: D(10), end: D(10, 59) }] } })), []);
  eq('③b ちょうど120分＝60分刻みで2枠（15分刻みに落ちない）',
    startTimes(build({ shifts: { B: [{ start: D(10), end: D(12) }] } })), ['10:00','11:00']);
  eq('③b 119分＝最初から15分刻み（11:00は60分取れず出ない）',
    startTimes(build({ shifts: { B: [{ start: D(10), end: D(11, 59) }] } })),
    ['10:00','10:15','10:30','10:45']);
  eq('③b 接するだけの埋まりはブロックを削らない',
    startTimes(build({ shifts: { B: [{ start: D(12), end: D(13) }] }, busy: { B: [{ start: D(11), end: D(12) }] } })),
    ['12:00']);

  // --- 4. 休憩が入ると、その後ろから詰まる（吸着） -------------------
  const s4 = build({ shifts: { B: [{ start: D(7), end: D(23) }] }, busy: { B: [{ start: D(9, 30), end: D(10, 15) }] } });
  eq('④ 休憩9:30-10:15 → 前は8:30まで・後ろは10:15から詰まる', startTimes(s4),
    ['07:00','08:00','08:15','08:30',                               // 7:00-9:30
     '10:15','11:15','12:15','13:15','14:15','15:15','16:15','17:15','18:15','19:15','20:15','21:15',
     '21:30','21:45','22:00']);                                     // 10:15-23:00（終端で15分刻みへ）

  // --- 5. trialOk -----------------------------------------------------
  const t5a = build({ shifts: { B: [{ start: D(7), end: D(23) }] } });
  eq('⑤ ブロックの終わり＝退勤時刻なら、後ろ90分が無くても60分でtrue',
    t5a.filter((s) => s.trialOk === false).length, 0);
  ok('⑤ 22:00の枠もtrue（退勤23時を超えるが許す）', t5a[15].startTime === '22:00' && t5a[15].trialOk === true);
  const t5b = build({ shifts: { B: [{ start: D(7), end: D(23) }] }, busy: { B: [{ start: D(13), end: D(14) }] } });
  eq('⑤ 後ろに予約があるブロックは90分取れる枠だけtrue',
    t5b.filter((s) => s.trialOk).map((s) => s.startTime),
    ['07:00','08:00','09:00','10:00','11:00',                       // 11:00+90=12:30 ≦ 13:00
     '14:00','15:00','16:00','17:00','18:00','19:00','20:00','21:00','22:00']);
  eq('⑤ 90分取れない枠はfalse（12:00は12:00+90=13:30>13:00）',
    t5b.filter((s) => !s.trialOk).map((s) => s.startTime), ['12:00']);
  const t5c = build({ shifts: { B: [{ start: D(7), end: D(13, 30) }] } });
  eq('⑤ ちょうど90分前の枠はtrue（12:00+90=13:30＝ブロック終端）',
    t5c.filter((s) => s.trialOk === false).length, 0);
  const t5d = build({ shifts: { B: [{ start: D(7), end: D(23) }] }, busy: { B: [{ start: D(22, 30), end: D(23) }] } });
  // ブロック終端22:30≠退勤23:00 → 90分ルールのみ。21:00は21:00+90=22:30でちょうど収まるのでtrue。
  eq('⑤ 退勤直前が埋まるとブロック終端≠退勤時刻→90分ルールのみ', t5d.filter((s) => !s.trialOk).map((s) => s.startTime),
    ['21:15','21:30']);
  ok('⑤ ちょうど90分収まる21:00はtrue（境界）', t5d.some((s) => s.startTime === '21:00' && s.trialOk === true));

  // --- 6. B1の埋まりは全トレーナーに効く ------------------------------
  const s6 = gasBuildSlots({ nowMs: NOW_FAR, horizonEndMs: HZ, trainers: TT,
    shifts: { B: [{ start: D(7), end: D(10) }], C: [{ start: D(7), end: D(10) }] },
    roomBusy: [{ start: D(8), end: D(9) }] });
  eq('⑥ B1の8:00-9:00でB・Cの両方が割れる',
    [startTimes(s6.filter((s) => s.trainerId === 'B')), startTimes(s6.filter((s) => s.trainerId === 'C'))],
    [['07:00','09:00'], ['07:00','09:00']]);

  // --- 7. 1F：担当が特定できる予定はそのトレーナーだけ／担当不明は全員 ---
  const s7 = gasBuildSlots({ nowMs: NOW_FAR, horizonEndMs: HZ, trainers: TT,
    shifts: { B: [{ start: D(7), end: D(10) }], C: [{ start: D(7), end: D(10) }] },
    oneFBusy: { B: [{ start: D(8), end: D(9) }] } });
  eq('⑦ 1Fで担当Bの予定＝Bだけ割れる（Cは無傷）',
    [startTimes(s7.filter((s) => s.trainerId === 'B')), startTimes(s7.filter((s) => s.trainerId === 'C'))],
    [['07:00','09:00'], ['07:00','08:00','09:00']]);
  const s7b = gasBuildSlots({ nowMs: NOW_FAR, horizonEndMs: HZ, trainers: TT,
    shifts: { B: [{ start: D(7), end: D(10) }], C: [{ start: D(7), end: D(10) }] },
    oneFBlockAll: [{ start: D(8), end: D(9) }] });
  eq('⑦ 1Fで担当不明＝全員が割れる',
    [startTimes(s7b.filter((s) => s.trainerId === 'B')), startTimes(s7b.filter((s) => s.trainerId === 'C'))],
    [['07:00','09:00'], ['07:00','09:00']]);

  // --- 8. hidden トレーナーは ownerWindow の外では枠が出ない ----------
  const win = { 1: { from: 17, to: 24 }, 6: 'all' };   // 月=17時〜／土=終日／他=非表示
  const s8 = gasBuildSlots({ nowMs: NOW_FAR, horizonEndMs: HZ, trainers: OWNER,
    shifts: { A: [{ start: MON(7), end: MON(23) }] }, ownerWindow: win });
  eq('⑧ 月曜は17時以降だけ', startTimes(s8), ['17:00','18:00','19:00','20:00','21:00','22:00']);
  const s8b = gasBuildSlots({ nowMs: NOW_FAR, horizonEndMs: HZ, trainers: OWNER,
    shifts: { A: [{ start: WED(7), end: WED(23) }] }, ownerWindow: win });
  eq('⑧ ルール無しの曜日（水）は0枠', startTimes(s8b), []);
  const s8c = gasBuildSlots({ nowMs: NOW_FAR, horizonEndMs: HZ, trainers: OWNER,
    shifts: { A: [{ start: MON(7), end: MON(23) }] }, ownerWindow: null });
  eq('⑧ ownerWindow未設定＝制限なし（16枠）', s8c.length, 16);
  const s8d = gasBuildSlots({ nowMs: NOW_FAR, horizonEndMs: HZ, trainers: T,
    shifts: { B: [{ start: WED(7), end: WED(23) }] }, ownerWindow: win });
  eq('⑧ 非hiddenはownerWindowの影響を受けない', s8d.length, 16);
  const s8e = gasBuildSlots({ nowMs: NOW_FAR, horizonEndMs: HZ, trainers: OWNER,
    shifts: { A: [{ start: MON(16, 30), end: MON(19) }] }, ownerWindow: win });
  // 吸着は16:30から刻む（16:30/17:30/17:45/18:00）。窓は「開始時刻の時(h)が17以上」で判定されるので16:30だけ落ちる。
  eq('⑧ 境界：16:30は窓外で落ち、刻みはずれない', startTimes(s8e), ['17:30','17:45','18:00']);

  // --- 9. 締め切り：午前枠＝前日22時／それ以外＝180分前 ---------------
  //   deadline は「この時刻以降は不可」。nowMs < deadline のときだけ出る。
  const am = { shifts: { B: [{ start: D(7), end: D(8) }] }, trainers: T, horizonEndMs: HZ };
  eq('⑨ 午前7:00枠：前日21:59は出る', startTimes(gasBuildSlots(Object.assign({ nowMs: jstMs(2026, 10, 19, 21, 59) }, am))), ['07:00']);
  eq('⑨ 午前7:00枠：前日22:00ちょうどで消える（境界）', startTimes(gasBuildSlots(Object.assign({ nowMs: jstMs(2026, 10, 19, 22, 0) }, am))), []);
  const pm = { shifts: { B: [{ start: D(13), end: D(14) }] }, trainers: T, horizonEndMs: HZ };
  eq('⑨ 13:00枠：9:59（180分前の1分前）は出る', startTimes(gasBuildSlots(Object.assign({ nowMs: D(9, 59) }, pm))), ['13:00']);
  eq('⑨ 13:00枠：10:00ちょうど（180分前）で消える（境界）', startTimes(gasBuildSlots(Object.assign({ nowMs: D(10, 0) }, pm))), []);
  eq('⑨ 正午12:00は午前枠ではない（MORNING_UNTIL_HOUR=12は未満）',
    startTimes(gasBuildSlots({ nowMs: D(8, 59), trainers: T, horizonEndMs: HZ, shifts: { B: [{ start: D(12), end: D(13) }] } })), ['12:00']);
  eq('⑨ 11:00枠（午前）は当日8:00でも消える＝前日22時で締まっている',
    startTimes(gasBuildSlots({ nowMs: D(8, 0), trainers: T, horizonEndMs: HZ, shifts: { B: [{ start: D(11), end: D(12) }] } })), []);
  // 午前枠は「前日22時」と「180分前」の早いほう。深夜枠は180分前のほうが早い。
  const mid = { shifts: { B: [{ start: D(0, 30), end: D(1, 30) }] }, trainers: T, horizonEndMs: HZ };
  eq('⑨ 0:30枠：前日21:29は出る（早いほう＝180分前=21:30）', startTimes(gasBuildSlots(Object.assign({ nowMs: jstMs(2026, 10, 19, 21, 29) }, mid))), ['00:30']);
  eq('⑨ 0:30枠：前日21:30ちょうどで消える（Math.minの分岐）', startTimes(gasBuildSlots(Object.assign({ nowMs: jstMs(2026, 10, 19, 21, 30) }, mid))), []);
  // 締め切りで枠が落ちても、刻みの進み方は変わらない（GASは continue＝forの増分は実行される）
  //   13:00-17:00・いま11:30 → 13:00(締切10:00)と14:00(締切11:00)は落ち、15:00/16:00は毎時ちょうどのまま残る
  eq('⑨ 締め切りで枠が落ちても刻みはずれない',
    startTimes(gasBuildSlots({ nowMs: D(11, 30), trainers: T, horizonEndMs: HZ, shifts: { B: [{ start: D(13), end: D(17) }] } })),
    ['15:00','16:00']);
  // 午前枠は前日22時で締まるので、当日の朝はいくら早くても出ない（寝坊事故の再発防止）
  eq('⑨ 当日7:00時点で、その日の午前シフトは全滅する',
    startTimes(gasBuildSlots({ nowMs: D(7, 0), trainers: T, horizonEndMs: HZ, shifts: { B: [{ start: D(9), end: D(12) }] } })),
    []);

  // --- 10. 突き合わせヘルパー ------------------------------------------
  const base = build({ shifts: { B: [{ start: D(7), end: D(10) }] } });
  ok('⑩ diffSlots：同じなら equal=true', diffSlots(base, base.slice()).equal);
  const dropped = diffSlots(base, base.slice(1));
  ok('⑩ diffSlots：欠けを onlyInGas で拾う', !dropped.equal && dropped.onlyInGas.length === 1 && dropped.onlyInOther.length === 0);
  const flipped = base.map((s, i) => (i === 0 ? Object.assign({}, s, { trialOk: !s.trialOk }) : s));
  ok('⑩ diffSlots：trialOk の食い違いを拾う', diffSlots(base, flipped).trialOkMismatch.length === 1);
  ok('⑩ slotKey はトレーナー×開始で一意', slotKey(base[0]) !== slotKey(Object.assign({}, base[0], { trainerId: 'C' })));

  // --- 11. 入力の形：ms / Date / ISO のどれでも同じ答え -----------------
  const i1 = build({ shifts: { B: [{ start: D(7), end: D(10) }] } });
  const i2 = build({ shifts: { B: [{ start: new Date(D(7)), end: new Date(D(10)) }] } });
  const i3 = build({ shifts: { B: [{ start: new Date(D(7)).toISOString(), end: new Date(D(10)).toISOString() }] } });
  eq('⑪ ms/Date/ISO で同じ答え', [startTimes(i2), startTimes(i3)], [startTimes(i1), startTimes(i1)]);
  // GAS は getEvents(now, endDate) の範囲外のシフトを見ない
  eq('⑪ 地平より後のシフトは取得範囲外＝0枠',
    startTimes(gasBuildSlots({ nowMs: NOW_FAR, horizonEndMs: jstMs(2026, 10, 10, 23, 59), trainers: T,
      shifts: { B: [{ start: D(7), end: D(10) }] } })), []);
  // GASはシフトを1件ずつ独立に処理する＝出勤イベントが重複して登録されていると枠も重複する（仕様ではなく素の挙動）。
  // D1側で「シフトをマージしてから引く」と答えが変わる。ここを固定しておく。
  eq('⑪ 出勤イベントが重複登録されていると枠も重複する（GASの素の挙動）',
    startTimes(gasBuildSlots({ nowMs: NOW_FAR, horizonEndMs: HZ, trainers: T,
      shifts: { B: [{ start: D(7), end: D(9) }, { start: D(7), end: D(9) }] } })),
    ['07:00','08:00','07:00','08:00']);
  eq('⑪ シフト全体が埋まっていれば0枠',
    startTimes(build({ shifts: { B: [{ start: D(7), end: D(9) }] }, busy: { B: [{ start: D(6), end: D(10) }] } })), []);
  eq('⑪ 複数シフト・複数ブロックの並び順はGAS順（トレーナー→シフト→開始）',
    startTimes(gasBuildSlots({ nowMs: NOW_FAR, horizonEndMs: HZ, trainers: T,
      shifts: { B: [{ start: D(7), end: D(9) }, { start: D(18), end: D(20) }] } })),
    ['07:00','08:00','18:00','19:00']);

  console.log((fails.length ? '❌' : '✅') + ' gas-slots-harness: ' + pass + '件合格 / ' + fails.length + '件失敗');
  for (const f of fails) console.log('❌ ' + f);
  return fails.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runSelfTest() ? 1 : 0;
}
