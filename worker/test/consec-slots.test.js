// 連続ルール（設計18）を組み込んだ「枠の計算（buildAvailableSlots）」を、GASのコードのまま動かして確かめる。
//   実行: node worker/test/consec-slots.test.js
//
// ★確かめること
//   C6  スイッチが off のとき、枠は**変更前のコードと1件も違わない**（ランダムな予定 500 通り）
//   C7  on のとき、オーナーの例どおり 13:15・8:45・7:45 が出て、13:00・9:00 は顧客に出さない
//   C5  on でもトレーナーに見える枠は減らない（変更前の枠 ⊆ on の枠）
//   ほか 体験を挟む・別トレーナーの体験・変更（excludeStart）
//
// ★変更前のコードは worker/test/fixtures/code-before-consec.js.txt（2026-10-13 の HEAD）。
//   比べる相手を固定しないと「off で同じ」を確かめられない。

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require_ = createRequire(import.meta.url);
const BR_SRC = readFileSync(join(ROOT, 'gas/BookingRules.js'), 'utf8');
const NEW_SRC = readFileSync(join(ROOT, 'gas/コード.js'), 'utf8');
const OLD_SRC = readFileSync(join(ROOT, 'worker/test/fixtures/code-before-consec.js.txt'), 'utf8');

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
const NAMES_OLD = ['buildAvailableSlots', '_lbSubtractIntervals', '_lbIsBusyTitle', '_lbIsSessionTitle', 'isShiftEvent'];
const NAMES_NEW = NAMES_OLD.concat(['_lbMakeSlot', '_lbApplyConsecToSlots']);

const M = 60000, H = 60 * M;
// ★日本時間で書く（GAS は Asia/Tokyo で動く）。テストの時刻はローカル時刻として作る
const DAY = new Date(2026, 9, 20, 0, 0, 0).getTime();          // 10/20（火）0:00
const NOW = new Date(2026, 9, 17, 9, 0, 0).getTime();          // 3日前＝締め切りに当たらない
const at = (hhmm, dayOff = 0) => { const [h, m] = hhmm.split(':').map(Number); return DAY + dayOff * 24 * H + (h * 60 + m) * M; };
const pad = (n) => String(n).padStart(2, '0');
function fmt(d, pat) {
  return pat.replace('yyyy', d.getFullYear()).replace('MM', pad(d.getMonth() + 1)).replace('dd', pad(d.getDate()))
    .replace('HH', pad(d.getHours())).replace('mm', pad(d.getMinutes()));
}

const TRAINERS = [
  { id: 'T1', name: '鈴木 一郎', email: 'suzuki@cal' },
  { id: 'T2', name: '沖 二郎', email: 'oki@cal' },
  { id: 'T3', name: '中野 三郎', email: 'nakano@cal', hidden: true },
];

// cals: { email: [{title, start, end}] }（ms）
function makeEnv(src, names, cals, mode) {
  const ev = (e) => ({ getTitle: () => e.title, getStartTime: () => new Date(e.start), getEndTime: () => new Date(e.end) });
  const ctx = {
    Date, Math, JSON, String, Number, isFinite, Object, Array, console,
    Logger: { log: () => {} },
    Utilities: { formatDate: (d, tz, pat) => fmt(d, pat) },
    CalendarApp: { getCalendarById: (id) => ({ getEvents: (s, e) => (cals[id] || []).filter((x) => x.start < e.getTime() && x.end > s.getTime()).map(ev) }) },
    CALENDAR_IDS: { CAPACITY_B1: 'b1@cal', TRAINERS },
    SETTINGS: { TIMEZONE: 'Asia/Tokyo', SESSION_MINUTES: 60, TRIAL_SESSION_MINUTES: 90, PICKER_STEP_MINUTES: 15, MORNING_UNTIL_HOUR: 12, MORNING_PREV_DEADLINE_HOUR: 22 },
    _lbBookingHorizonEnd: () => new Date(DAY + 3 * 24 * H),
    _lbOwnerSlotWindow: () => null,
    _lbInOwnerWindow: () => true,
    _lbConsecMode: () => mode,
  };
  vm.createContext(ctx);
  vm.runInContext(BR_SRC.replace(/if \(typeof module[\s\S]*$/, ''), ctx);
  for (const n of names) vm.runInContext(pluckFn(src, n), ctx);
  return ctx;
}
const run = (src, names, cals, mode, ex) => makeEnv(src, names, cals, mode).buildAvailableSlots(ex || undefined, NOW);
const OLD = (cals) => run(OLD_SRC, NAMES_OLD, cals, 'off');
const NEW = (cals, mode, ex) => run(NEW_SRC, NAMES_NEW, cals, mode, ex);
const key = (s) => `${s.trainerId}|${s.startISO}|${s.endISO}|${s.trialOk}`;
const startsOf = (slots, tid) => slots.filter((s) => s.trainerId === tid).map((s) => s.startTime);

// 予定を作る道具
const shift = (a, b, d = 0) => ({ title: '出勤可能', start: at(a, d), end: at(b, d) });
const sess = (a, b, d = 0, name = 'Aさま') => ({ title: `✅ ${name}｜セッション_line`, start: at(a, d), end: at(b, d) });
const b1 = (kind, sur, a, b, d = 0) => ({ title: `[RESERVED] ${kind}_${sur}_客様_line`, start: at(a, d), end: at(b, d) });

// ============================================================
console.log('=== 1. ★off は変更前と1件も違わない（C6）===');
{
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  let diffs = 0, total = 0, firstDiff = '';
  for (let k = 0; k < 500; k++) {
    const cals = { 'b1@cal': [] };
    for (const tr of TRAINERS) {
      const list = [];
      for (let d = 0; d < 3; d++) {
        const sh = 7 + rnd(3), eh = 20 + rnd(4);
        list.push(shift(`${sh}:00`, `${eh}:00`, d));
        let t = sh * 60 + rnd(4) * 15;
        while (t < eh * 60 - 60) {
          if (rnd(3) === 0) {
            const len = rnd(4) === 0 ? 90 : 60;
            const a = `${Math.floor(t / 60)}:${pad(t % 60)}`, bb = `${Math.floor((t + len) / 60)}:${pad((t + len) % 60)}`;
            list.push(rnd(6) === 0 ? { title: '休憩', start: at(a, d), end: at(bb, d) } : sess(a, bb, d));
            if (rnd(2) === 0) cals['b1@cal'].push(b1(rnd(5) === 0 ? '体験' : '通常', tr.name.split(' ')[0], a, bb, d));
          }
          t += 60 + rnd(3) * 15;
        }
      }
      cals[tr.email] = list;
    }
    const o = OLD(cals).map(key), n = NEW(cals, 'off').map(key);
    total += o.length;
    if (JSON.stringify(o) !== JSON.stringify(n)) { diffs++; if (!firstDiff) firstDiff = `例${k}: 旧${o.length}件 新${n.length}件`; }
    const nOn = NEW(cals, 'dry');
    if (JSON.stringify(o) !== JSON.stringify(nOn.map(key)) || nOn.some((s) => 'consecOk' in s)) { diffs++; if (!firstDiff) firstDiff = `dry 例${k}`; }
  }
  ok('1-1 ★off と dry の枠は、変更前のコードと順番まで同じ（500通り）', diffs === 0, firstDiff);
  ok('1-2 比べた枠が十分ある', total > 10000, `枠 ${total} 件`);
  const offOne = NEW({ 'b1@cal': [], 'suzuki@cal': [shift('07:00', '23:00')] }, 'off');
  ok('1-3 off の枠に consecOk の項目が無い', offOne.length > 0 && offOne.every((s) => !('consecOk' in s)));
}

console.log('=== 2. on：オーナーの例（C7）===');
{
  const cals = {
    'b1@cal': [b1('通常', '鈴木', '10:00', '11:00'), b1('通常', '鈴木', '11:00', '12:00'), b1('通常', '鈴木', '12:00', '13:00')],
    'suzuki@cal': [shift('07:00', '23:00'), sess('10:00', '11:00'), sess('11:00', '12:00'), sess('12:00', '13:00')],
  };
  const on = NEW(cals, 'on');
  const mine = on.filter((s) => s.trainerId === 'T1');
  const cust = mine.filter((s) => s.consecOk === true).map((s) => s.startTime);
  const all = mine.map((s) => s.startTime);
  ok('2-1 ★顧客に 13:15 が出る', cust.includes('13:15'), JSON.stringify(cust));
  ok('2-2 ★顧客に 8:45 と 7:45 が出る', cust.includes('08:45') && cust.includes('07:45'), JSON.stringify(cust));
  ok('2-3 ★顧客に 13:00 と 9:00 は出ない', !cust.includes('13:00') && !cust.includes('09:00'));
  ok('2-4 on の枠は全部に真偽値の consecOk', mine.every((s) => typeof s.consecOk === 'boolean'));
  const old = OLD(cals).filter((s) => s.trainerId === 'T1').map(key);
  const onKeys = new Set(mine.map(key));
  ok('2-5 ★トレーナーに見える枠は減らない（変更前 ⊆ on）', old.every((k) => onKeys.has(k)),
     '13:00・9:00 も consecOk:false で残る（代行で取れる）');
  ok('2-6 時刻の順に並んでいる', all.join(',') === [...all].sort().join(','));
  ok('2-7 沖さん（予定なし）の枠は全部顧客に出る', on.filter((s) => s.trainerId === 'T2').every((s) => s.consecOk === true));
}
{
  // すき間埋め（ルール2）
  const cals = {
    'b1@cal': [],
    'suzuki@cal': [shift('07:00', '23:00'), sess('09:00', '10:00'), sess('10:00', '11:00'), sess('11:00', '12:00'), sess('13:00', '14:00')],
  };
  const cust = NEW(cals, 'on').filter((s) => s.trainerId === 'T1' && s.consecOk === true).map((s) => s.startTime);
  ok('2-8 ★9-12 と 13-14 の間の 12:00 は顧客に出る（すき間埋め5時間）', cust.includes('12:00'), JSON.stringify(cust));
}
{
  // 体験を挟む
  const cals = {
    'b1@cal': [b1('通常', '鈴木', '09:00', '10:00'), b1('体験', '鈴木', '10:00', '11:30'), b1('通常', '鈴木', '11:30', '12:30')],
    'suzuki@cal': [shift('07:00', '23:00'), sess('09:00', '10:00'), { title: '✅ 体験様｜カウンセリング', start: at('10:00'), end: at('11:30') }, sess('11:30', '12:30')],
  };
  const cust = NEW(cals, 'on').filter((s) => s.trainerId === 'T1' && s.consecOk === true).map((s) => s.startTime);
  ok('2-9 ★体験は数えない（3.5時間埋まっていても通常2本＝12:30 は取れる）', cust.includes('12:30'), JSON.stringify(cust));
  const calsOther = JSON.parse(JSON.stringify(cals));
  calsOther['b1@cal'][1] = b1('体験', '沖', '10:00', '11:30');
  const cust2 = NEW(calsOther, 'on').filter((s) => s.trainerId === 'T1' && s.consecOk === true).map((s) => s.startTime);
  ok('2-10 ★別のトレーナー（沖）の体験なら、鈴木さんの10:00は数える（12:30 は取れない）', !cust2.includes('12:30'), JSON.stringify(cust2));
}
{
  // 変更：自分の旧予定は数えない
  const cals = {
    'b1@cal': [],
    'suzuki@cal': [shift('07:00', '23:00'), sess('10:00', '11:00'), sess('11:00', '12:00'), sess('12:00', '13:00')],
  };
  const cust = NEW(cals, 'on', at('12:00')).filter((s) => s.trainerId === 'T1' && s.consecOk === true).map((s) => s.startTime);
  ok('2-11 変更（12:00 の予約を動かす）では 12:00〜 を選べる（自分の旧予定は数えない）', cust.includes('12:00'), JSON.stringify(cust));
}
{
  // セッションが読めない（時刻が壊れた予定）→ その人の枠は顧客に出さない
  const cals = {
    'b1@cal': [],
    'suzuki@cal': [shift('07:00', '23:00'), { title: '✅ 壊れ｜セッション_line', start: at('12:00'), end: at('12:00') }],
  };
  const mine = NEW(cals, 'on').filter((s) => s.trainerId === 'T1');
  ok('2-12 ★セッションが読めなければ、その人の枠は全部 consecOk:false（答えない側）', mine.length > 0 && mine.every((s) => s.consecOk === false));
}

console.log('');
console.log(`${fail ? '❌' : '✅'} 連続ルール（枠の計算） 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
