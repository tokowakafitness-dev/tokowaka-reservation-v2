// D1に写した予定から、空き枠を作る（① カレンダー→D1 の中核）
//
//   目的は「速くすること」ではなく「**GASと1件も違わない答えを出すこと**」。
//   速度が20倍になっても、空き枠が1件違えば顧客は予約できない。
//   違いが出たら、こちらが正しくてもGASに合わせる（切り替えは別の段で判断する）。
//
//   ★ハーネス（worker/test/gas-slots-harness.js）がGASの答えを再現する。
//     テストは両者を1件ずつ突き合わせる。どちらかを直したら必ず差分が出る。
//
//   ここは純粋な関数だけ。D1もカレンダーも触らない（取得は calread.js の責務）。

import { EV_KIND, CAL_ROLE, isMs } from './calclass.js';

// ============================================================
// 日本時間（JST）の読み取り
//
//   ★GASのスクリプトは Asia/Tokyo で動くので、getDay() / getHours() が日本時間を返す。
//     Worker は UTC なので、同じコードを書くと**時刻が9時間ずれる**。
//     固定枠の曜日×時間帯の判定が丸ごと壊れ、顧客に出す枠が変わる。
//     日本は夏時間が無いので、UTC+9 の固定でよい。
// ============================================================
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function jstParts(ms) {
  const d = new Date(Number(ms) + JST_OFFSET_MS);
  return {
    year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
    hours: d.getUTCHours(), minutes: d.getUTCMinutes(), dayOfWeek: d.getUTCDay()
  };
}

// JSTの壁時計からミリ秒へ
export function jstMs(y, mo, d, h, mi) {
  return Date.UTC(y, mo - 1, d, h || 0, mi || 0, 0) - JST_OFFSET_MS;
}

const WEEK_JA = ['日', '月', '火', '水', '木', '金', '土'];
function p2(n) { return (n < 10 ? '0' : '') + n; }

export function jstDateStr(ms) { const p = jstParts(ms); return p.year + '/' + p2(p.month) + '/' + p2(p.day); }
export function jstTimeStr(ms) { const p = jstParts(ms); return p2(p.hours) + ':' + p2(p.minutes); }
export function jstDayOfWeek(ms) { return WEEK_JA[jstParts(ms).dayOfWeek]; }

// ============================================================
// 締め切り（GAS の BookingRules.js と同じ答えを出すこと）
//
//   ★ここは条件の書き写しになる。Worker から GAS のファイルは読み込めないため。
//     だからテストで「GASの _lbBookingOpen と同じ答えか」を1件ずつ突き合わせる。
// ============================================================
export const BOOKING_DEFAULTS = { leadMinutes: 180, morningUntilHour: 12, prevDeadlineHour: 22 };

// その枠は午前枠か（前日締め切りの対象か）
export function isMorningSlot(startMs, cfg) {
  const c = cfg || BOOKING_DEFAULTS;
  return jstParts(startMs).hours < c.morningUntilHour;
}

// その枠の受付締め切り
export function bookingDeadlineMs(startMs, cfg) {
  const c = cfg || BOOKING_DEFAULTS;
  const lead = Number(startMs) - c.leadMinutes * 60000;
  if (!isMorningSlot(startMs, c)) return lead;
  // 午前枠は「前日のこの時刻」と「開始の180分前」の早いほうで締まる
  const p = jstParts(startMs);
  const prev = jstMs(p.year, p.month, p.day, c.prevDeadlineHour, 0) - 24 * 60 * 60 * 1000;
  return Math.min(prev, lead);
}

// いまその枠を予約できるか
export function bookingOpen(startMs, nowMs, cfg) {
  return Number(nowMs) < bookingDeadlineMs(startMs, cfg);
}

// ============================================================
// 区間の引き算（calclass.js の subtractIntervals と同じ考え方だが、
//   ここは GAS の _lbSubtractIntervals と答えを合わせる責務を持つ）
// ============================================================
export function subtractBusy(base, busyList) {
  const bS = Number(base && base.start), bE = Number(base && base.end);
  if (!isFinite(bS) || !isFinite(bE) || bE <= bS) return [];

  const cut = [];
  for (let i = 0; i < (busyList || []).length; i++) {
    const s = Number(busyList[i].start), e = Number(busyList[i].end);
    if (!isFinite(s) || !isFinite(e)) continue;
    if (!(s < bE && e > bS)) continue;              // base と重ならないものは捨てる（GASと同じ条件）
    cut.push({ start: Math.max(s, bS), end: Math.min(e, bE) });
  }
  cut.sort((a, b) => a.start - b.start);

  const merged = [];
  for (let i = 0; i < cut.length; i++) {
    const last = merged[merged.length - 1];
    if (last && cut[i].start <= last.end) { if (cut[i].end > last.end) last.end = cut[i].end; }
    else merged.push({ start: cut[i].start, end: cut[i].end });
  }

  const free = [];
  let cur = bS;
  for (let i = 0; i < merged.length; i++) {
    if (merged[i].start > cur) free.push({ start: cur, end: merged[i].start });
    if (merged[i].end > cur) cur = merged[i].end;
  }
  if (cur < bE) free.push({ start: cur, end: bE });
  return free;
}

// 固定枠の持ち主（hidden なトレーナー）を、曜日×時間帯で絞る
//   ★「時」だけで判定する（分は見ない）。GASの _lbInOwnerWindow と同じ。
//     16:30開始は {from:17} で落ち、17:45開始は通る。
export function inOwnerWindow(startMs, win) {
  if (!win) return true;                            // 設定が無ければ制限なし
  const p = jstParts(startMs);
  const w = win[String(p.dayOfWeek)];
  if (w == null) return false;                      // その曜日は出さない
  if (w === 'all') return true;
  const from = Number(w.from), to = Number(w.to);
  if (!isFinite(from) || !isFinite(to)) return true;
  return p.hours >= from && p.hours < to;
}

// ============================================================
// D1の予定を、トレーナーごとの「出勤」と「埋まり」に振り分ける
//
//   ★1Fの扱いを間違えない（2026-10-02に実際に間違えた）。
//     capacity_b1 の room_busy … 部屋そのもの。**全トレーナー**を塞ぐ
//     capacity_1f の busy      … オンライン。**そのトレーナーだけ**を塞ぐ
//     capacity_1f の room_busy … 担当が読めなかった。**全員**を塞ぐ（fail-closed）
//     ここを「room_busy なら全員」と一括りにすると、オンライン1件でB1の枠が全部消える。
// ============================================================
export function splitEvents(events, trainerIds) {
  const shifts = {}, busy = {}, roomBusy = [];
  for (const id of trainerIds) { shifts[id] = []; busy[id] = []; }

  for (const ev of (events || [])) {
    // ★Number() を通さない。Number(null)・Number('')・Number(false) は 0 になり、
    //   isFinite(0) は真なので「読めた」ことになってしまう。
    //   欠損が1970年1月1日として扱われ、「1970年から今まで埋まっている」巨大な区間が
    //   できて、そのトレーナーの枠が全部消える。欠損値1つで予約できなくなる。
    if (!isMs(ev.startAt) || !isMs(ev.endAt)) continue;
    const iv = { start: ev.startAt, end: ev.endAt };

    if (ev.role === CAL_ROLE.TRAINER) {
      if (ev.effect === EV_KIND.SHIFT) { if (shifts[ev.trainerId]) shifts[ev.trainerId].push(iv); }
      else if (ev.effect === EV_KIND.BUSY) { if (busy[ev.trainerId]) busy[ev.trainerId].push(iv); }
      continue;
    }

    if (ev.role === CAL_ROLE.CAPACITY_B1) {
      if (ev.effect === EV_KIND.ROOM_BUSY) roomBusy.push(iv);     // 席そのもの＝全員
      continue;
    }

    if (ev.role === CAL_ROLE.CAPACITY_1F) {
      // 担当が分かっていればその人だけ。分からなければ全員（fail-closed）。
      if (ev.effect === EV_KIND.BUSY && ev.trainerId && busy[ev.trainerId]) busy[ev.trainerId].push(iv);
      else if (ev.effect === EV_KIND.ROOM_BUSY) roomBusy.push(iv);
      continue;
    }
  }
  return { shifts, busy, roomBusy };
}

// ============================================================
// 空き枠を作る
//
//   吸着方式：出勤シフトから埋まりを引いた「空きブロック」の端から枠を出す。
//   刻みは動的：2枠以上残る区間は60分、最後の1枠になったら15分。
// ============================================================
export function buildSlots(opts) {
  const o = opts || {};
  const nowMs = Number(o.nowMs);
  const sessionMs = (o.sessionMinutes || 60) * 60000;
  const trialMs = (o.trialMinutes || 90) * 60000;
  const stepMs = (o.pickerStepMinutes || 15) * 60000;
  const cfg = o.bookingCfg || BOOKING_DEFAULTS;
  const ownerWindow = o.ownerWindow || null;
  const trainers = o.trainers || [];

  const out = [];
  for (const tr of trainers) {
    const shiftList = (o.shifts && o.shifts[tr.id]) || [];
    // そのトレーナーの埋まり ＋ 部屋の埋まり（全員ぶん）
    const busyList = ((o.busy && o.busy[tr.id]) || []).concat(o.roomBusy || []);

    for (const sh of shiftList) {
      // ★シフト同士をまとめない。GASはシフトを1件ずつ独立に処理するので、
      //   出勤イベントが重複して登録されていると同じ枠が2回出る。
      //   こちらでまとめると件数が合わなくなる（差分の原因になる）。
      const shiftEndMs = Number(sh.end);
      const free = subtractBusy(sh, busyList);

      for (const blk of free) {
        const blockEnd = blk.end;
        for (let cur = blk.start; cur + sessionMs <= blockEnd;
             cur += ((blockEnd - cur) >= 2 * sessionMs ? sessionMs : stepMs)) {
          // ★締め切りで落ちても刻みはずれない（continue は増分を飛ばさない）
          if (!bookingOpen(cur, nowMs, cfg)) continue;
          if (tr.hidden && !inOwnerWindow(cur, ownerWindow)) continue;

          // 体験は90分押さえる。ただしブロックの終わりが退勤時刻なら超過を許す。
          //   ★ここは**ミリ秒の完全一致**で見る。秒やミリ秒を丸めると
          //     この救済だけが効かなくなり、22時台の体験枠が消える。
          const trialOk = ((cur + trialMs) <= blockEnd)
            || ((blockEnd === shiftEndMs) && (cur + sessionMs) <= blockEnd);

          out.push({
            startMs: cur, endMs: cur + sessionMs,
            startISO: new Date(cur).toISOString(),
            endISO: new Date(cur + sessionMs).toISOString(),
            trainerId: tr.id, trainerName: tr.name || '',
            trialOk: trialOk,
            date: jstDateStr(cur), dayOfWeek: jstDayOfWeek(cur),
            startTime: jstTimeStr(cur), endTime: jstTimeStr(cur + sessionMs)
          });
        }
      }
    }
  }
  return out;
}

// D1から取った予定をそのまま渡して空き枠を出す（呼び出し側の入口）
export function slotsFromEvents(events, opts) {
  const o = opts || {};
  const trainers = o.trainers || [];
  const { shifts, busy, roomBusy } = splitEvents(events, trainers.map(t => t.id));
  return buildSlots(Object.assign({}, o, { shifts, busy, roomBusy }));
}
