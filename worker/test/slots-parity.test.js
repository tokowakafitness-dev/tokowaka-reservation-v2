// D1から出した空き枠が、GASの答えと1件も違わないことの検証
//
//   ① カレンダー→D1 の完了条件は「GASとD1が連続7日間一致すること」。
//   本番で突き合わせてから誤りに気づくのでは遅いので、**実装と同時にここで比べる**。
//
//   GASの答えは worker/test/gas-slots-harness.js が再現する（GASのソースから
//   締め切り・区間の引き算・固定枠の判定を取り出して使っている）。
//   こちらは worker/src/lib/calslots.js が D1の予定から出す。
//   **同じ状況を両方に与えて、1枠ずつ突き合わせる。**
//
//   実行: node worker/test/slots-parity.test.js

import { gasBuildSlots, diffSlots } from './gas-slots-harness.js';
import { slotsFromEvents, jstMs, jstParts, bookingOpen, bookingDeadlineMs, inOwnerWindow } from '../src/lib/calslots.js';
import { CAL_ROLE, EV_KIND } from '../src/lib/calclass.js';

let pass = 0, fail = 0;
function ok(n, c) { if (c) pass++; else { fail++; console.log('❌ ' + n); } }
function eq(n, g, w) {
  const G = JSON.stringify(g), W = JSON.stringify(w);
  if (G === W) pass++; else { fail++; console.log('❌ ' + n + '\n   got : ' + G + '\n   want: ' + W); }
}

// ------------------------------------------------------------
// 日本時間で時刻を作る（両方に同じ値を渡す）
// ------------------------------------------------------------
const D = (day, h, m) => jstMs(2026, 11, day, h, m || 0);     // 2026年11月（締め切りを気にせず先の日付で試す）
const TRAINERS = [
  { id: 'B', name: '鈴木 神海感留', hidden: false },
  { id: 'C', name: '沖 孟', hidden: false }
];
const NOW = D(1, 0, 0);     // 11/1 0:00。以降の枠はすべて締め切り前

// D1の形（events）から、ハーネスに渡すGASの形へ変換する。
//   ★この変換が「D1の形をどう読むか」の仕様そのもの。ここを間違えると
//     実装が正しくても比較が成立しない。だから変換も素直に書く。
function toGasShape(events) {
  const shifts = {}, busy = {}, roomBusy = [], oneFBusy = {}, oneFBlockAll = [];
  for (const t of TRAINERS) { shifts[t.id] = []; busy[t.id] = []; oneFBusy[t.id] = []; }
  for (const e of events) {
    const iv = { start: e.startAt, end: e.endAt };
    if (e.role === CAL_ROLE.TRAINER) {
      if (e.effect === EV_KIND.SHIFT) shifts[e.trainerId].push(iv);
      else if (e.effect === EV_KIND.BUSY) busy[e.trainerId].push(iv);
    } else if (e.role === CAL_ROLE.CAPACITY_B1) {
      if (e.effect === EV_KIND.ROOM_BUSY) roomBusy.push(iv);
    } else if (e.role === CAL_ROLE.CAPACITY_1F) {
      if (e.effect === EV_KIND.BUSY && e.trainerId) oneFBusy[e.trainerId].push(iv);
      else if (e.effect === EV_KIND.ROOM_BUSY) oneFBlockAll.push(iv);
    }
  }
  return { shifts, busy, roomBusy, oneFBusy, oneFBlockAll };
}

// 同じ状況を両方に与えて比べる
function parity(name, events, extra) {
  const o = extra || {};
  const g = toGasShape(events);
  const gasSlots = gasBuildSlots(Object.assign({
    nowMs: NOW, trainers: TRAINERS, ownerWindow: o.ownerWindow || null, fetchWindow: false
  }, g));
  const mine = slotsFromEvents(events, {
    nowMs: NOW, trainers: TRAINERS, ownerWindow: o.ownerWindow || null
  });
  const d = diffSlots(gasSlots, mine);
  if (d.equal) { pass++; return; }
  fail++;
  console.log('❌ ' + name);
  if (d.onlyInGas.length) console.log('   GASだけにある: ' + d.onlyInGas.slice(0, 5).join(' / '));
  if (d.onlyInOther.length) console.log('   D1だけにある: ' + d.onlyInOther.slice(0, 5).join(' / '));
  if (d.trialOkMismatch && d.trialOkMismatch.length) {
    console.log('   体験の可否が違う: ' + d.trialOkMismatch.slice(0, 5).join(' / '));
  }
}

const shift = (tid, day, h1, h2) => ({
  role: CAL_ROLE.TRAINER, trainerId: tid, effect: EV_KIND.SHIFT, reason: 'shift',
  startAt: D(day, h1), endAt: D(day, h2)
});
const resv = (tid, day, h1, h2) => ({
  role: CAL_ROLE.TRAINER, trainerId: tid, effect: EV_KIND.BUSY, reason: 'reserved',
  startAt: D(day, h1), endAt: D(day, h2)
});
const brk = (tid, day, h1, m1, h2, m2) => ({
  role: CAL_ROLE.TRAINER, trainerId: tid, effect: EV_KIND.BUSY, reason: 'break',
  startAt: D(day, h1, m1), endAt: D(day, h2, m2)
});
const room = (day, h1, h2) => ({
  role: CAL_ROLE.CAPACITY_B1, trainerId: null, effect: EV_KIND.ROOM_BUSY, reason: 'room',
  startAt: D(day, h1), endAt: D(day, h2)
});
const online = (tid, day, h1, h2) => ({
  role: CAL_ROLE.CAPACITY_1F, trainerId: tid, effect: EV_KIND.BUSY, reason: 'online',
  startAt: D(day, h1), endAt: D(day, h2)
});
const onlineUnknown = (day, h1, h2) => ({
  role: CAL_ROLE.CAPACITY_1F, trainerId: null, effect: EV_KIND.ROOM_BUSY, reason: 'online_unknown',
  startAt: D(day, h1), endAt: D(day, h2)
});

// ============================================================
// ① 基本
// ============================================================
parity('①出勤だけ・埋まりなし', [shift('B', 5, 7, 23)]);
parity('①出勤なし＝枠なし', []);
parity('①真ん中に予約1件', [shift('B', 5, 7, 23), resv('B', 5, 12, 13)]);
parity('①端に予約', [shift('B', 5, 7, 23), resv('B', 5, 7, 9)]);
parity('①両端に予約', [shift('B', 5, 7, 23), resv('B', 5, 7, 9), resv('B', 5, 21, 23)]);
parity('①全部埋まり', [shift('B', 5, 7, 23), resv('B', 5, 7, 23)]);
parity('①2人ぶん', [shift('B', 5, 7, 23), shift('C', 5, 9, 18), resv('C', 5, 12, 13)]);

// ============================================================
// ② 刻みの切り替え（60分 → 最後の1枠は15分）
// ============================================================
parity('②20:30-23:00（15分刻みになる）', [shift('B', 5, 7, 23), resv('B', 5, 7, 20), brk('B', 5, 20, 0, 20, 30)]);
parity('②ちょうど120分の空き', [shift('B', 5, 7, 9)]);
parity('②119分の空き（最初から15分刻み）', [shift('B', 5, 7, 9), brk('B', 5, 8, 59, 9, 0)]);
parity('②ちょうど60分の空き', [shift('B', 5, 7, 8)]);
parity('②59分の空き（枠なし）', [shift('B', 5, 7, 8), brk('B', 5, 7, 59, 8, 0)]);

// ============================================================
// ③ 休憩・ブロックで吸着する
// ============================================================
parity('③休憩の後ろから詰まる', [shift('B', 5, 7, 23), brk('B', 5, 12, 0, 13, 0)]);
parity('③30分の休憩で端がずれる', [shift('B', 5, 7, 23), brk('B', 5, 12, 0, 12, 30)]);
parity('③休憩が2つ', [shift('B', 5, 7, 23), brk('B', 5, 10, 0, 11, 0), brk('B', 5, 15, 0, 15, 30)]);

// ============================================================
// ④ 部屋（B1）は全員に効く
// ============================================================
parity('④B1の埋まりは2人とも塞ぐ', [shift('B', 5, 7, 23), shift('C', 5, 7, 23), room(5, 12, 13)]);
parity('④B1が全日埋まり', [shift('B', 5, 7, 23), shift('C', 5, 7, 23), room(5, 7, 23)]);

// ============================================================
// ⑤ 1F（ここを取り違えると枠が全部消える）
// ============================================================
parity('⑤1Fのオンラインは担当だけを塞ぐ',
  [shift('B', 5, 7, 23), shift('C', 5, 7, 23), online('B', 5, 12, 13)]);
parity('⑤1Fで担当が分からなければ全員',
  [shift('B', 5, 7, 23), shift('C', 5, 7, 23), onlineUnknown(5, 12, 13)]);
parity('⑤1Fと部屋が混ざる',
  [shift('B', 5, 7, 23), shift('C', 5, 7, 23), online('B', 5, 10, 11), room(5, 15, 16)]);

// ============================================================
// ⑥ シフトが重複している（GASはまとめない）
// ============================================================
parity('⑥同じシフトが2件（枠が重複する）', [shift('B', 5, 7, 12), shift('B', 5, 7, 12)]);
parity('⑥重なるシフト2件', [shift('B', 5, 7, 12), shift('B', 5, 10, 15)]);

// ============================================================
// ⑦ 固定枠の持ち主（hidden）
// ============================================================
{
  const hiddenTrainers = [{ id: 'A', name: '中野 龍之介', hidden: true }];
  const ev = [{ role: CAL_ROLE.TRAINER, trainerId: 'A', effect: EV_KIND.SHIFT, reason: 'shift',
               startAt: D(5, 7), endAt: D(5, 23) }];
  const win = { '4': { from: 17, to: 24 } };    // 11/5 は木曜（4）
  const g = { shifts: { A: [{ start: D(5, 7), end: D(5, 23) }] }, busy: { A: [] },
              roomBusy: [], oneFBusy: { A: [] }, oneFBlockAll: [] };
  const gasSlots = gasBuildSlots(Object.assign({ nowMs: NOW, trainers: hiddenTrainers, ownerWindow: win, fetchWindow: false }, g));
  const mine = slotsFromEvents(ev, { nowMs: NOW, trainers: hiddenTrainers, ownerWindow: win });
  const d = diffSlots(gasSlots, mine);
  ok('⑦固定枠の持ち主は曜日×時間帯で絞られる（GASと一致）', d.equal);
  ok('⑦17時より前の枠は出ない', mine.every(s => jstParts(s.startMs).hours >= 17));
}

// ============================================================
// ⑧ 締め切り（いまの時刻で枠が落ちる）
// ============================================================
{
  // 11/5 12:00 を「いま」とする。当日の午後の枠は180分前で締まる
  const now2 = D(5, 12, 0);
  const ev = [shift('B', 5, 7, 23)];
  const g = toGasShape(ev);
  const gasSlots = gasBuildSlots(Object.assign({ nowMs: now2, trainers: TRAINERS, fetchWindow: false }, g));
  const mine = slotsFromEvents(ev, { nowMs: now2, trainers: TRAINERS });
  const d = diffSlots(gasSlots, mine);
  ok('⑧締め切りを過ぎた枠が落ちる（GASと一致）', d.equal);
  ok('⑧15時より前の枠は出ない（180分前で締まる）',
     mine.every(s => s.startMs >= now2 + 180 * 60000));
}

// ============================================================
// ⑨ 締め切りの判定そのものがGASと同じか（境界）
// ============================================================
{
  // 午前枠（開始が12時より前）は前日22時で締まる
  const morning = D(6, 9, 0);
  const prev22 = D(5, 22, 0);
  ok('⑨午前枠は前日22時で締まる', bookingDeadlineMs(morning) === prev22);
  ok('⑨前日22時の1ミリ秒前なら取れる', bookingOpen(morning, prev22 - 1));
  ok('⑨前日22時ちょうどは取れない', !bookingOpen(morning, prev22));

  // 午後枠は180分前
  const afternoon = D(6, 15, 0);
  ok('⑨午後枠は180分前で締まる', bookingDeadlineMs(afternoon) === afternoon - 180 * 60000);
  ok('⑨180分前の1ミリ秒前なら取れる', bookingOpen(afternoon, afternoon - 180 * 60000 - 1));
  ok('⑨180分前ちょうどは取れない', !bookingOpen(afternoon, afternoon - 180 * 60000));

  // 正午は午前枠ではない
  ok('⑨正午は午前枠ではない', bookingDeadlineMs(D(6, 12, 0)) === D(6, 12, 0) - 180 * 60000);
  // 深夜0:30は180分前が勝つ（前日21:30）
  ok('⑨深夜0時半は180分前が勝つ', bookingDeadlineMs(D(6, 0, 30)) === D(6, 0, 30) - 180 * 60000);
}

// ============================================================
// ⑩ 日本時間で判定しているか（ここを誤ると9時間ずれる）
// ============================================================
{
  // 日本時間の 2026/11/05 09:00 = UTC 2026/11/05 00:00
  const ms = jstMs(2026, 11, 5, 9, 0);
  const p = jstParts(ms);
  eq('⑩日本時間で読める', { y: p.year, mo: p.month, d: p.day, h: p.hours }, { y: 2026, mo: 11, d: 5, h: 9 });
  ok('⑩曜日も日本時間（11/5は木曜）', p.dayOfWeek === 4);
  // 日本時間の 2026/11/06 08:00（UTCでは11/5 23:00＝前日）
  const p2 = jstParts(jstMs(2026, 11, 6, 8, 0));
  ok('⑩UTCで前日になる時刻でも日本の日付で読む', p2.day === 6 && p2.hours === 8);
  // 固定枠の判定も日本時間
  ok('⑩固定枠の判定も日本時間', inOwnerWindow(jstMs(2026, 11, 6, 18, 0), { '5': { from: 17, to: 24 } }));
  ok('⑩固定枠は「時」だけ見る（16:30は落ちる）',
     !inOwnerWindow(jstMs(2026, 11, 6, 16, 30), { '5': { from: 17, to: 24 } }));
  ok('⑩固定枠は「時」だけ見る（17:45は通る）',
     inOwnerWindow(jstMs(2026, 11, 6, 17, 45), { '5': { from: 17, to: 24 } }));
}

// ============================================================
// ⑪ 体験（90分）の可否
// ============================================================
parity('⑪後ろ90分が空いている', [shift('B', 5, 7, 23)]);
parity('⑪後ろに予約があって90分取れない', [shift('B', 5, 7, 23), resv('B', 5, 10, 11)]);
parity('⑪退勤時刻で終わるブロック（超過を許す）', [shift('B', 5, 7, 8)]);
{
  // 退勤時刻ちょうどで終わる最後の枠は、60分しか残っていなくても体験可
  const ev = [shift('B', 5, 7, 23), resv('B', 5, 7, 22)];
  const mine = slotsFromEvents(ev, { nowMs: NOW, trainers: TRAINERS });
  const last = mine[mine.length - 1];
  ok('⑪退勤時刻で終わる最後の枠は体験可', last && last.trialOk === true);
}
{
  // 後ろに予約があるとブロック終端が退勤時刻でなくなり、体験不可になる
  const ev = [shift('B', 5, 7, 23), resv('B', 5, 7, 21), resv('B', 5, 22, 23)];
  const mine = slotsFromEvents(ev, { nowMs: NOW, trainers: TRAINERS });
  const at21 = mine.find(s => jstParts(s.startMs).hours === 21);
  ok('⑪後ろに予約があれば体験不可', at21 && at21.trialOk === false);
}

// ============================================================
// ⑫ D1の形を取り違えない（1Fを部屋扱いしない）
// ============================================================
{
  const ev = [shift('B', 5, 7, 12), shift('C', 5, 7, 12), online('B', 5, 9, 10)];
  const mine = slotsFromEvents(ev, { nowMs: NOW, trainers: TRAINERS });
  const bAt9 = mine.find(s => s.trainerId === 'B' && jstParts(s.startMs).hours === 9);
  const cAt9 = mine.find(s => s.trainerId === 'C' && jstParts(s.startMs).hours === 9);
  ok('⑫1Fのオンラインは担当の枠だけ消す', !bAt9);
  ok('⑫★もう一方のトレーナーの枠は消えない', !!cAt9);
}
{
  const ev = [shift('B', 5, 7, 12), shift('C', 5, 7, 12), onlineUnknown(5, 9, 10)];
  const mine = slotsFromEvents(ev, { nowMs: NOW, trainers: TRAINERS });
  ok('⑫担当不明の1Fは全員の枠を消す（fail-closed）',
     !mine.find(s => jstParts(s.startMs).hours === 9));
}
{
  // ignore（[消化]）は塞がない
  const ev = [shift('B', 5, 7, 12),
              { role: CAL_ROLE.CAPACITY_B1, trainerId: null, effect: EV_KIND.IGNORE, reason: 'consumed',
                startAt: D(5, 9), endAt: D(5, 10) }];
  const mine = slotsFromEvents(ev, { nowMs: NOW, trainers: TRAINERS });
  ok('⑫[消化]は席を塞がない', !!mine.find(s => jstParts(s.startMs).hours === 9));
}

// ============================================================
// ⑬ 壊れた入力で落ちない
// ============================================================
{
  const bad = [shift('B', 5, 7, 12),
               { role: CAL_ROLE.TRAINER, trainerId: 'B', effect: EV_KIND.BUSY, reason: 'reserved',
                 startAt: null, endAt: D(5, 10) },
               { role: CAL_ROLE.TRAINER, trainerId: 'Z', effect: EV_KIND.BUSY, reason: 'reserved',
                 startAt: D(5, 9), endAt: D(5, 10) }];
  let threw = false, out = [];
  try { out = slotsFromEvents(bad, { nowMs: NOW, trainers: TRAINERS }); } catch (e) { threw = true; }
  ok('⑬壊れた予定があっても落ちない', !threw);
  ok('⑬知らないトレーナーの予定は無視する', out.length > 0);
  ok('⑬時刻が壊れた予定は塞がない（枠が残る）',
     !!out.find(s => jstParts(s.startMs).hours === 9));
}

console.log('\nD1とGASの空き枠の一致 検証: ' + pass + ' passed / ' + fail + ' failed');
process.exit(fail ? 1 : 0);
