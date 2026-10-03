// 空き枠を配る。**三段構えにする**（2026-10-03）。
//
//   ① calendar_events から計算する   … 最新・最速（5分ごと＋予約直後に更新される）
//   ② slots_cache（GASが計算した写し）… ①が使えないとき（10分ごとに更新される）
//   ③ GASへ落ちる                     … ②も無い／古いとき。**判断するのはフロント**。
//                                        ここは stale を立てて知らせるだけ。
//
//   ★なぜ①へ切り替えるのか（オーナー判断）
//     ②のままだと、空き枠を計算するのはGASであり続ける。つまりGASを外せない。
//     ①はカレンダーの予定だけをD1に持ち、計算はWorkerが行う。
//
//   ★なぜ②③を残すのか
//     顧客が「空き枠が出ない」状態にしてはいけない。①が使えない理由は必ずある
//     （鮮度切れ・地平外・規則の版違い・構成の入れ替わり）。そのとき黙って0件を返すと、
//     障害が「空きがありません」に化けて予約を黙って失う。
//
//   ★絶対に守っていること
//     1. **どの経路で返したかを source で返す。** どちらで動いているか分からない状態にしない。
//     2. **①が使えなかった理由を fallbackReason で返す。** 黙って②に落ちない。
//     3. **締め切りの判定は compat.js の isSlotOpen 1つだけ。**（下の keepSlot）
//        経路で判定が変わると「見えているのに予約できない」が起きる。
//     4. **0件と「分からない」を同じ見た目にしない。** 計算できないときは stale を立てる。
//     5. **既定では①を使わない**（段階導入。下の useCalendarPath）。
//
//   ★計算そのものはここに書かない。
//     可否判定と取得 … worker/src/lib/calread.js（readCalendar）
//     空き枠の生成   … worker/src/lib/calslots.js（slotsFromEvents）
//     どちらも**使うだけ**。本番で14時点一致・9月の実データで9時点一致・手元52件一致まで
//     検証が済んでいる（ops/design/01-calendar-to-d1.md §12）。ここは「配る経路」だけを作る。
//
//   ★これは「表示用」であって、二重予約の判定には使わない。
//     確定の判定は第2段階でD1の予約表に対して行う。

// ★readHome の読み込みが抜けていた（2026-10-03 発見）。
//   routeBookingOptions は `readHome` を呼ぶのに import が無く、呼ばれた瞬間に
//   ReferenceError になる（＝予約オプションが必ず500）。この作業で見つけたので入れた。
//   customer.js / compat.js と同じ関数・同じ引数（env, customerId, targetMs）。
import { readHome } from './boot.js';
import { readCalendar } from '../lib/calread.js';
import { slotsFromEvents, jstParts, jstMs } from '../lib/calslots.js';
import { CAL_ROLE } from '../lib/calclass.js';

// 締め切りの判定は compat.js に一本化する。
//   以前はここにも同じ判定があり、設定値の解釈が違っていた
//   （0 を「無効」とみなすか「前日0時」とみなすか）。同じ枠でも経路によって
//   表示可否が変わるため、判定は1つだけにする。
//   ★①（カレンダーから計算）でも**同じこれを使う**。calslots.js にも同等の
//     bookingOpen があるが、2つ目の締め切り判定を経路に増やさない（下の BYPASS_NOW_MS）。
import { _forTest as _rules } from './compat.js';
const isOpen = (startMs, now, cfg) => _rules.isSlotOpen(startMs, now, cfg);

// どの経路で返したか
export const SLOT_SOURCE = {
  CALENDAR: 'calendar',   // ① calendar_events から計算した
  CACHE: 'cache',         // ② slots_cache から返した
  NONE: 'none',           // ②も無い／読めない＝答えられていない（stale:true が立つ）
};

// ①を使わなかった理由。**この集合の外の値を返さない。**
//   stale / horizon / rule / flag / calendars / missing は calread の理由そのまま。
export const SLOT_FALLBACK = {
  OFF: 'off',             // ③段階導入：まだ有効にしていない（既定）
  MISSING: 'missing',     // 公開中の使える世代が無い／トレーナーの行が無い
  STALE: 'stale',         // checked_at が古い（または未来に振れている）
  RULE: 'rule',           // 分類規則の版が違う／固定枠の設定が読めない
  FLAG: 'flag',           // 1Fフラグが取得時と食い違う
  CALENDARS: 'calendars', // 必要なカレンダーが世代に入っていない／トレーナーのカレンダー未設定
  HORIZON: 'horizon',     // 要求した範囲が地平に収まっていない
  ERROR: 'error',         // 計算の途中で例外になった（①の不具合で②を止めない）
};

// ②の写しが古いと見なす境界。
//   compat.js の compatTrainerSlots が使っている20分と同じ値にそろえる。
//   ★ここで**枠を落とさない。** 古い枠も返したうえで stale を立て、
//     GASへ落ちるかどうかはフロントに決めさせる。落とすと「0件」に見えてしまう。
export const CACHE_STALE_MS = 20 * 60 * 1000;

const DEFAULT_RULES = { leadMinutes: 180, morningUntilHour: 12, prevDeadlineHour: 22 };

// ★calslots.js の内側の締め切り判定を通り抜けさせるための「now」。
//   buildSlots は nowMs を bookingOpen にしか使わない。0 を渡すと
//   未来の枠はすべて通り、締め切りの判定は下の keepSlot（compat.js の isSlotOpen）
//   **1つだけ**になる。
//   なぜそうするのか：①の中と②の後で別々に締め切りを判定すると、設定値の解釈が
//   少しでも違った瞬間に「①では見えるが②では見えない」「見えているのに予約できない」が
//   起きる。判定は1つに寄せる。
const BYPASS_NOW_MS = 0;

// 分類規則の版。**GAS の LB_CALSYNC_RULE_VERSION と同じ値でなければならない。**
//   違えば readCalendar が reason:'rule' を返し、①は使われない（＝②へ落ちる・安全側）。
const DEFAULT_RULE_VERSION = 1;

export async function routeSlots({ body, env, who }) {
  const trainerId = String(body.trainerId || who.trainerId || '');
  if (!trainerId) return { code: 'BAD_REQUEST', slots: [] };

  const now = Date.now();

  // ---- ②の写しは**必ず先に読む** ----
  //   理由は2つ。
  //     1. 締め切りの設定（rules）はGASが写しに入れてくる。①でも同じ cfg を使いたい。
  //        別の既定値で計算すると、経路によって境界の枠の表示可否が変わる。
  //     2. ①が使えなかったとき、もう一度D1を読みに行かずに②へ落ちられる。
  const cached = await readCache(env, trainerId);
  const cfg = (cached && cached.rules) || DEFAULT_RULES;

  // 予約変更のとき、自分がいま押さえている枠は残す（締め切りを過ぎていても選ばせる）。
  const excludeStart = Number(body.excludeStartMs || 0);
  const keepSlot = (startMs) => {
    const ms = Number(startMs);
    if (!isFinite(ms)) return false;
    if (excludeStart && ms === excludeStart) return true;
    if (ms <= now) return false;
    return isOpen(ms, now, cfg);
  };

  // ---- ① calendar_events から計算する ----
  let fallbackReason = SLOT_FALLBACK.OFF;
  let generation = null;
  if (useCalendarPath(body, env)) {
    let built;
    try {
      built = await slotsFromCalendar(env, { trainerId, now, keepSlot });
    } catch (e) {
      // ①の不具合で②を止めない。ここで止めると顧客は空き枠を1つも見られない。
      console.warn('slots calendar', e && e.message);
      built = { reason: SLOT_FALLBACK.ERROR };
    }
    generation = built.generation == null ? null : built.generation;
    if (built.slots) {
      return {
        trainerId,
        slots: built.slots,
        source: SLOT_SOURCE.CALENDAR,
        computedAt: built.checkedAt,
        ageMs: now - built.checkedAt,
        stale: false,
        generation,
      };
    }
    fallbackReason = built.reason;
  }

  // ---- ② slots_cache から返す ----
  if (!cached) {
    // ③へ。**0件ではなく「分からない」。** フロントは stale を見てGASへ落ちる。
    return {
      trainerId,
      slots: [],
      source: SLOT_SOURCE.NONE,
      computedAt: null,
      ageMs: null,
      stale: true,
      fallbackReason,
      generation,
    };
  }

  const ageMs = cached.computedAt ? now - cached.computedAt : null;
  // 写しが古い／計算時刻が無い＝②も信用できない。枠は返すが stale を立てる（③の判断材料）。
  const cacheStale = ageMs == null || ageMs > CACHE_STALE_MS;

  return {
    trainerId,
    slots: cached.slots.filter((s) => keepSlot(s && s.startMs)),
    source: SLOT_SOURCE.CACHE,
    computedAt: cached.computedAt,
    ageMs,
    stale: cacheStale,
    fallbackReason,
    generation,
  };
}

// ============================================================
// ③ 段階導入：既定では①を使わない
// ============================================================
//
//   SLOTS_FROM_CALENDAR（環境変数）
//     未設定 / ''  … body.useCalendar === true のときだけ①を使う（オーナーの端末だけで試す）
//     'on'         … 全員①を使う
//     'off'        … 誰も①を使わない（**body より強い**。止めるための一行）
//
//   ★なぜ既定を off にするのか
//     まずオーナーの端末だけで確認し、数日見てから全員に広げるため。
//     ①が静かに間違っていたら、顧客は「取れるはずの枠が無い」状態になる。
//     それに気づくのは顧客より先であるべきで、そのための段階がこれ。
export function useCalendarPath(body, env) {
  const sw = String((env && env.SLOTS_FROM_CALENDAR) || '');
  if (sw === 'on') return true;
  if (sw === 'off') return false;
  return !!(body && body.useCalendar === true);
}

// ============================================================
// ① calendar_events から計算する
// ============================================================
//
//   返す形
//     { slots: [...], checkedAt, generation }                 … 計算できた
//     { reason: <SLOT_FALLBACK のどれか>, generation|null }    … 使えなかった（②へ）
//
//   ★「使えない」と「0件」を混ぜない。
//     使えないときは slots を**入れない**（reason だけ）。空配列を入れると、
//     呼び出し側が「0件＝空きなし」と書いた瞬間に障害が「空きがありません」に化ける。
//     readCalendar が usable:false のとき events を返さないのと同じ理由。
async function slotsFromCalendar(env, { trainerId, now, keepSlot }) {
  // ---- そのトレーナーの行（hidden と calendar_id が要る）----
  //   hidden … 固定枠の持ち主。曜日×時間帯で絞る対象（calslots の inOwnerWindow）
  //   calendar_id … その人のカレンダーが世代に入っているかを確かめる相手
  const tr = await env.DB.prepare(
    'SELECT trainer_id AS id, name, hidden, calendar_id FROM trainers WHERE trainer_id = ?'
  ).bind(trainerId).first();
  if (!tr) return { reason: SLOT_FALLBACK.MISSING, generation: null };

  // ★カレンダーIDが分からないトレーナーで①を使わない。
  //   使ってしまうと「必要なカレンダーの検査なし」になり、**その人のカレンダーが
  //   世代に入っていない世代でも空き枠を出す**＝出勤が0件に見えて「空きがありません」。
  const calId = String(tr.calendar_id || '');
  if (!calId) return { reason: SLOT_FALLBACK.CALENDARS, generation: null };

  const required = [{ calendarId: calId, role: CAL_ROLE.TRAINER, trainerId }];
  // B1（部屋の容量）は calsync の検査が「ちょうど1つ」を強制しているので、
  //   公開された世代には必ず入っている。設定されていれば念のためここでも見る。
  //   ★B1が欠けた世代を使うと、部屋が埋まっている時間を「空いています」と出す。
  const b1 = String((env && env.CAL_B1_CALENDAR_ID) || '');
  if (b1) required.push({ calendarId: b1, role: CAL_ROLE.CAPACITY_B1 });

  const { fromMs, toMs } = slotsRange(now);

  const read = await readCalendar(env, {
    fromMs, toMs,
    ruleVersion: ruleVersionOf(env),
    flag1f: flag1fOf(env),
    requiredCalendars: required,
    nowMs: now,
  });
  if (!read.usable) return { reason: read.reason, generation: read.generation };

  // 固定枠の設定が保存されているのに読めない＝どの曜日に出してよいか分からない。
  //   ★null（制限なし）へ倒さない。倒すと、固定枠の持ち主の枠が本来出ない
  //     曜日・時間帯に出る。読めないなら①を使わず②へ落ちる。
  if (read.ownerWindowError) return { reason: SLOT_FALLBACK.RULE, generation: read.generation };

  const trainers = [{
    id: trainerId,
    name: String(tr.name || ''),
    hidden: !!Number(tr.hidden),
  }];

  const built = slotsFromEvents(read.events, {
    nowMs: BYPASS_NOW_MS,            // 締め切りは keepSlot（compat.js）1つに寄せる
    trainers,
    ownerWindow: read.ownerWindow || null,
  });

  const slots = built
    .filter((s) => keepSlot(s.startMs))
    .sort((a, b) => a.startMs - b.startMs);

  return { slots, checkedAt: read.checkedAt, generation: read.generation };
}

// ============================================================
// 部品
// ============================================================

// ②の写しを読む。読めなければ null（＝②が無い）。
async function readCache(env, trainerId) {
  const row = await env.DB.prepare(
    'SELECT payload, computed_at FROM slots_cache WHERE trainer_id = ?'
  ).bind(trainerId).first();
  if (!row) return null;
  let raw;
  try { raw = JSON.parse(row.payload); } catch (_) { return null; }
  // ★配列も typeof では 'object' なので、ここで弾かないと素通りする（2026-10-03）。
  //   payload が "[]" のとき raw.slots は undefined → 空配列になり、
  //   新しい computed_at とあわせて「0件＝空きがありません」として顧客に出る。
  //   写しが壊れているときは「分からない」として退避させる（0件と同じ見た目にしない）。
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  // ★`slots` が配列で入っていなければ、写しとして壊れている（2026-10-03・Codex指摘）。
  //   以前はここで空配列に倒していたため、`{"rules":{...}}` のような中途半端な写しが
  //   新しい computed_at とあわせて「空きがありません」として顧客に出た。
  //   **欠けているものを 0件 に変換しない。** 分からないなら分からないと言う。
  if (!Array.isArray(raw.slots)) return null;
  const computedAt = Number(row.computed_at);
  return {
    slots: raw.slots,
    rules: (raw.rules && typeof raw.rules === 'object') ? raw.rules : null,
    computedAt: isFinite(computedAt) && computedAt > 0 ? computedAt : null,
  };
}

// ①で要求する範囲。**GASが取っている地平と同じ式にする。**
//   GAS: horizonStart = 今日 00:00（JST）
//        horizonEnd   = _lbBookingHorizonEnd(now)
//                     = (日が25以上なら翌月) の月末 23:59:59（JST）
//   ★同じ式にしないと readCalendar が毎回 horizon で落ち、①が永久に使われない。
//   ★25日を越えた瞬間に地平が翌月末まで伸びる。GASの作り直しが間に合っていない間は
//     horizon で落ちて②へ退避する（＝正しい fail-closed）。
export function slotsRange(nowMs) {
  const p = jstParts(nowMs);
  const fromMs = jstMs(p.year, p.month, p.day, 0, 0);
  // jstMs(y, mo, 0, ...) は「mo-1 月の末日」。だから mo に p.month+1(+1) を渡す。
  //   秒まで合わせる（GASは 23:59:59）。jstMs は秒を取らないので足す。
  const toMs = jstMs(p.year, p.month + 1 + (p.day >= 25 ? 1 : 0), 0, 23, 59) + 59000;
  return { fromMs, toMs };
}

// 分類規則の版。環境変数で上げられるようにしておく（GAS側を上げたら揃えるため）。
//   読めない値は既定へ倒す。**0や負は使わない**（readCalendar が throw する）。
export function ruleVersionOf(env) {
  const v = Number((env && env.CAL_RULE_VERSION) || NaN);
  return (isFinite(v) && Math.floor(v) === v && v >= 1) ? v : DEFAULT_RULE_VERSION;
}

// 現在の1Fフラグ（GAS の LB_1F_TRAINER_BLOCK と揃える）。既定は off（GASの既定と同じ）。
//   食い違えば readCalendar が reason:'flag' を返し、①は使われない（安全側）。
export function flag1fOf(env) {
  return String((env && env.CAL_FLAG_1F) || '') === 'on' ? 'on' : 'off';
}

/**
 * 「この日時に予約するとき、何から消化されるか」を返す。
 *   GASでは getBookingOptions として別に5.1秒かけていた通信。
 *   残数は予約する日の月で決まるため、その月の写しから組み立てる。
 *   持っていない月なら null を返し、画面はGASに聞き直す（間違った選択肢を出さない）。
 */
export async function routeBookingOptions({ body, env, who }) {
  const customerId = String(body.customerId || who.customerId || '');
  if (!customerId) return { code: 'BAD_REQUEST', options: null };

  const startMs = Number(body.startMs || 0);
  if (!startMs) return { code: 'BAD_REQUEST', options: null };

  const home = await readHome(env, customerId, startMs);
  if (!home) return { options: null, fallback: true };   // その月を持っていない＝GASに聞いて

  const monthlyLeft = home.monthlyRemaining != null ? home.monthlyRemaining : 0;
  const pairLeft = home.pairRemaining || 0;
  const normalTicketLeft = home.normalTicketRemaining || 0;

  return {
    options: {
      month: home.month,
      hasNormalRoute: !!home.hasNormalRoute,
      monthlyRemaining: monthlyLeft,
      ticketRemaining: home.ticketRemaining != null ? home.ticketRemaining : 0,
      pairRemaining: pairLeft,
      pairPackMax: home.pairPackMax || 0,
      normalTicketRemaining: normalTicketLeft,
      isPair: pairLeft > 0,
      carryover: home.carryover || 0,
      quota: home.quota || 0,
      transferCredits: home.transferCredits || null,
    },
    stale: home.stale,
    computedAt: home.computedAt,
  };
}

export const _forTest = {
  useCalendarPath, slotsRange, ruleVersionOf, flag1fOf, readCache,
  CACHE_STALE_MS, BYPASS_NOW_MS, DEFAULT_RULE_VERSION, DEFAULT_RULES,
};
