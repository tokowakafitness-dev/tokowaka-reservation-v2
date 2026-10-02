// ① カレンダー → D1 の読み取り側（「D1を使ってよいか」と「予定」を1回で取る）
//   設計：ops/design/01-calendar-to-d1.md §7（可否判定）／§4（D1の形）／§2（地平）
//
//   **すべての読み取りが必ずこの関数を通る。**（§7）
//   空き枠の生成（calslots.js）も、GASとの突き合わせ（§12）も、ここを通る。
//
//   ★なぜ1回のSQLなのか（§7「読み取りは1回のSQLでまとめて取る」）
//     可否判定と予定の取得を別々のSQLにすると、その**間に世代が消される**（§8の削除が走る）。
//     「使ってよい」と答えた直後に予定が0件になり、**「空きなし」に化ける。**
//     だから calendar_active との結合で一度に取る。
//
//   ★なぜ LEFT JOIN なのか
//     単純な内部結合だと「使えるが予定が0件」と「そもそも使えない」が**どちらも0行**になり、
//     見分けがつかない（§7が明記している要点）。
//     calendar_active を起点に LEFT JOIN すると、使える世代があれば予定が0件でも
//     必ず1行返る（予定の列が NULL）。これで
//       「空きなし（usable:true, events:[]）」と「分からない（usable:false）」を区別できる。
//     ここを取り違えると、顧客には同じ「空きがありません」に見える。**それをしない。**
//
//   ★分類の条件をここに書き写さない。worker/src/lib/calclass.js を使う（EV_KIND / isMs）。
//     重なりの判定も calclass の overlaps と同じ式にする（接するだけは重ならない）。
//   ★氏名・タイトルはD1に無い（§4）。だから返す形にも無い。
//
//   ★1Fの扱い（2026-10-02 修正）— 呼び出し側が取り違えると最も害が大きい点
//     1Fはオンライン・体験用で、**B1の席は使わない。** GASが分類して送ってくるので、
//     D1には役割と効果の組み合わせとして入っている。意味は effect で決まる：
//       role='capacity_b1' / effect='room_busy'              … 部屋の容量＝**全トレーナーを塞ぐ**
//       role='capacity_1f' / effect='busy'   + trainerId     … **そのトレーナーだけ**を塞ぐ
//       role='capacity_1f' / effect='room_busy'              … 担当不明＝**全員を塞ぐ**（fail-closed）
//       role='trainer'     / effect='shift'                  … その中でだけ予約できる
//       role='trainer'     / effect='busy'                   … そのトレーナーが埋まっている
//     **「room_busy なら部屋が埋まる」と素朴に書くと、1Fのオンライン1件でB1の枠が全部消える。**
//     判断は effect（と trainerId）で行い、role だけで決めない。
//     この関数は予定をそのまま返すが、**role / effect / trainerId を必ず入れて返す**ので、
//     呼び出し側は欠けた情報を推測せずに済む。

import { EV_KIND, isMs } from './calclass.js';

// §5/§7：鮮度の上限。正常時の目標が1分、上限2分（§5「誰が呼ぶか」）。
//   ちょうど2分は使える（境界は含む）。2分を**超えたら**使わない。
export const FRESH_MS = 120000;

// 未来に振れた checked_at で「永久に新しい」状態を作らせない（fail-closed）。
//   書き込み側の時計が狂っていると、古い世代が新鮮なまま使われ続ける。
export const MAX_CLOCK_SKEW_MS = 60000;

// 公開された世代だけを使う（§5-7：公開＝status を ready にして active を差し替える）
const STATUS_READY = 'ready';

// 使えない理由（§7）。この集合の外の値を返さない。
export const CALREAD_REASON = {
  MISSING: 'missing',       // 公開中の使える世代が無い（active が空／世代が消えた／status が ready でない）
  STALE: 'stale',           // checked_at が古い（または未来に振れている）
  RULE: 'rule',             // 分類規則の版が今のコードと違う
  FLAG: 'flag',             // 取得時の1Fフラグと現在の設定が食い違う
  CALENDARS: 'calendars',   // 必要なカレンダーが世代に入っていない
  HORIZON: 'horizon',       // 要求された範囲が地平に収まっていない
};

// 判定の順序（最初に当たった理由を返す）。
//   どれも「使わない」結論は同じなので、原因が分かりやすい順に見る。
//   missing → stale → rule → flag → calendars → horizon
//
// ★予定の絞り込みは ON 句に置く（WHERE に置くと LEFT JOIN が内部結合に退化し、
//   「使えるが0件」が1行も返らなくなって missing と区別できなくなる）。
//   重なりの条件は calclass の overlaps と同じ：start < 要求の終わり AND end > 要求の始まり。
//   接するだけ（end === 要求の始まり）は重ならない。
//   effect='ignore' は空き枠に影響しない（B1の [消化] 等）。呼び出し側が
//   「行があるから塞がっている」と素朴に書いても壊れないように、ここで落とす。
export const READ_SQL = `
SELECT a.generation   AS generation,
       a.checked_at   AS checked_at,
       s.status       AS status,
       s.horizon_start AS horizon_start,
       s.horizon_end   AS horizon_end,
       s.rule_version  AS rule_version,
       s.flag_1f       AS flag_1f,
       s.calendars     AS calendars,
       e.calendar_id  AS calendar_id,
       e.event_id     AS event_id,
       e.role         AS role,
       e.trainer_id   AS trainer_id,
       e.effect       AS effect,
       e.reason       AS reason,
       e.start_at     AS start_at,
       e.end_at       AS end_at,
       e.all_day      AS all_day
  FROM calendar_active a
  LEFT JOIN calendar_snapshot s ON s.generation = a.generation
  LEFT JOIN calendar_events   e ON e.generation = a.generation
                              AND e.start_at < ? AND e.end_at > ?
                              AND e.effect <> ?
 WHERE a.id = 1
 ORDER BY e.start_at, e.end_at, e.calendar_id, e.event_id`;

// ============================================================
// 入口
// ============================================================
//
// readCalendar(env, { fromMs, toMs, ruleVersion, flag1f, requiredCalendars, nowMs })
//
//   fromMs / toMs      … 要求する範囲（半開区間 [fromMs, toMs)・epoch ms）
//   ruleVersion        … 今のコードの分類規則の版（整数）
//   flag1f             … 現在の LB_1F_TRAINER_BLOCK（'on' / 'off'）
//   requiredCalendars  … 必要なカレンダー。文字列（id）でも
//                        { calendarId, role, trainerId } でもよい。
//                        role / trainerId を書いた分は**一致も見る**（構成の入れ替わりを通さない）
//   nowMs              … 現在時刻（省略時は Date.now()。鮮度の境界を試験で固定するため）
//
// 返す形（§7）
//   { usable: true,  events: [...], generation, checkedAt, horizonStart, horizonEnd }
//   { usable: false, reason: 'stale'|'horizon'|'rule'|'flag'|'missing'|'calendars', generation, ... }
//
//   events の1件
//     { calendarId, eventId, role, trainerId, effect, reason, startAt, endAt, allDay }
//     ★氏名・タイトルは無い（D1に持っていない）。
//     ★role / effect / trainerId は必ず入る（欠けた情報を呼び出し側に推測させない）。
//
//   **usable:false のとき events は返さない。** 空配列を返すと、呼び出し側が
//   「0件＝空きなし」と書いた瞬間に「分からない」が「空きなし」に化ける（§7）。
//   呼び出し側は usable を見て、false ならGASへ落とす（または明示的なエラー）。
//
//   引数が壊れているときは throw する（＝呼び出し側の不具合。reason では表さない）。
export async function readCalendar(env, opts) {
  const o = opts || {};
  const fromMs = o.fromMs, toMs = o.toMs;
  if (!isMs(fromMs) || !isMs(toMs)) throw new Error('CALREAD_BAD_RANGE');
  if (!(fromMs < toMs)) throw new Error('CALREAD_EMPTY_RANGE');     // 幅0・逆向きは要求として誤り

  const ruleVersion = o.ruleVersion;
  if (!(typeof ruleVersion === 'number' && isFinite(ruleVersion) && Math.floor(ruleVersion) === ruleVersion)) {
    throw new Error('CALREAD_BAD_RULE_VERSION');
  }
  const flag1f = String(o.flag1f == null ? '' : o.flag1f);
  if (flag1f !== 'on' && flag1f !== 'off') throw new Error('CALREAD_BAD_FLAG_1F');

  // ★空の一覧を通さない。通すと「必要なカレンダーの検査なし」になり、
  //   B1を欠いた世代でも使えてしまう（部屋の埋まりを3人分まとめて見落とす）。
  const required = normalizeRequired(o.requiredCalendars);
  if (!required.length) throw new Error('CALREAD_NO_REQUIRED_CALENDARS');

  const now = o.nowMs == null ? Date.now() : o.nowMs;
  if (!isMs(now)) throw new Error('CALREAD_BAD_NOW');

  // ---- 可否判定と予定を1回のSQLで取る（§7）----
  const res = await env.DB.prepare(READ_SQL).bind(toMs, fromMs, EV_KIND.IGNORE).all();
  const rows = (res && Array.isArray(res.results)) ? res.results : (Array.isArray(res) ? res : []);

  // calendar_active の行そのものが無い（schema.sql の seed が流れていない）
  const gate = rows.length ? rows[0] : null;
  if (!gate) return unusable(CALREAD_REASON.MISSING, null, { active: false });

  const generation = gate.generation == null ? null : Number(gate.generation);
  // 公開中の世代が無い／世代の行が消えている（結合の相手がいない）／公開されていない
  if (generation == null) return unusable(CALREAD_REASON.MISSING, null, { active: true });
  if (gate.status == null) return unusable(CALREAD_REASON.MISSING, generation, { snapshot: false });
  const status = String(gate.status);
  if (status !== STATUS_READY) return unusable(CALREAD_REASON.MISSING, generation, { status });

  // ---- 鮮度（§4：鮮度は checked_at で見る。built_at で見ない）----
  const checkedAt = gate.checked_at == null ? null : Number(gate.checked_at);
  if (checkedAt == null || !isMs(checkedAt)) {
    return unusable(CALREAD_REASON.STALE, generation, { checkedAt: null });
  }
  const ageMs = now - checkedAt;
  if (ageMs > FRESH_MS || ageMs < -MAX_CLOCK_SKEW_MS) {
    return unusable(CALREAD_REASON.STALE, generation, { ageMs });
  }

  // ---- 分類規則の版（違えば effect の意味が違う）----
  if (Number(gate.rule_version) !== ruleVersion) {
    return unusable(CALREAD_REASON.RULE, generation, { was: Number(gate.rule_version), now: ruleVersion });
  }

  // ---- 1Fフラグ（§7の訂正・2026-10-02）----
  //   設計書は「1Fが on なら使わない」と書いているが、それは1Fを分類できなかった頃の記述。
  //   いまは role='capacity_1f' として正しく分類して持てる。だから正しい判定は
  //   「**取得時と現在の設定が食い違っていたら使わない**」。
  //   食い違ったまま使うと、1Fを数える設定なのに1Fの予定が入っていない世代（または逆）で
  //   空き枠を出すことになる。
  if (String(gate.flag_1f) !== flag1f) {
    return unusable(CALREAD_REASON.FLAG, generation, { was: String(gate.flag_1f), now: flag1f });
  }

  // ---- 必要なカレンダーが全部入っているか（§7）----
  const miss = missingCalendars(gate.calendars, required);
  if (miss) return unusable(CALREAD_REASON.CALENDARS, generation, miss);

  // ---- 地平に完全に入っているか（§7★）----
  //   25日に地平が伸びたのに作り直しが失敗していると、checked_at は新しいのに
  //   翌月のデータが無い、という状態になりうる。**必ず地平を見る。**
  const hS = Number(gate.horizon_start), hE = Number(gate.horizon_end);
  if (!isMs(hS) || !isMs(hE) || !(fromMs >= hS && toMs <= hE)) {
    return unusable(CALREAD_REASON.HORIZON, generation, { horizonStart: hS, horizonEnd: hE, fromMs, toMs });
  }

  // ---- 使える。予定を返す（0件もありうる＝「本当に空いている」）----
  const events = [];
  for (const r of rows) {
    if (r.event_id == null) continue;          // LEFT JOIN の相手なし（予定が0件）
    events.push({
      calendarId: String(r.calendar_id),
      eventId: String(r.event_id),
      role: String(r.role),
      trainerId: r.trainer_id == null ? null : String(r.trainer_id),
      effect: String(r.effect),
      reason: String(r.reason),
      startAt: Number(r.start_at),
      endAt: Number(r.end_at),
      allDay: Number(r.all_day),
    });
  }

  return {
    usable: true,
    generation,
    checkedAt,
    horizonStart: hS,
    horizonEnd: hE,
    events,
  };
}

// ============================================================
// 部品
// ============================================================

// usable:false の形を1か所で作る。
//   ★events を入れない（入れると「0件＝空きなし」に化ける道ができる）。
//   detail は記録用。氏名・タイトルは元から無いので入りようがない。
function unusable(reason, generation, detail) {
  const out = { usable: false, reason, generation: generation == null ? null : generation };
  if (detail) out.detail = detail;
  return out;
}

// 必要なカレンダーの一覧を正規形にする。
//   文字列（id だけ）でも { calendarId, role, trainerId } でもよい。
//   snake_case（calendar_id / trainer_id）でも受ける（世代のJSONをそのまま渡せるように）。
//   ★role / trainerId を省いた分は「id があればよい」。書いた分は一致も見る。
export function normalizeRequired(list) {
  const out = [];
  for (const c of (Array.isArray(list) ? list : [])) {
    if (typeof c === 'string') {
      if (!c) throw new Error('CALREAD_BAD_REQUIRED_CALENDAR');
      out.push({ calendar_id: c, role: null, trainer_id: null });
      continue;
    }
    const o = c || {};
    const id = o.calendarId != null ? o.calendarId : o.calendar_id;
    if (id == null || String(id) === '') throw new Error('CALREAD_BAD_REQUIRED_CALENDAR');
    const role = o.role == null || o.role === '' ? null : String(o.role);
    const tidRaw = o.trainerId != null ? o.trainerId : o.trainer_id;
    const tid = tidRaw == null || tidRaw === '' ? null : String(tidRaw);
    out.push({ calendar_id: String(id), role, trainer_id: tid });
  }
  return out;
}

// 世代の calendars（JSON）に必要なものが全部入っているか。
//   入っていなければ、足りないものを表す小さな物を返す（＝使えない）。入っていれば null。
//   ★JSONが読めないときも「足りない」に倒す（fail-closed）。構成が確かめられない世代は使わない。
export function missingCalendars(calendarsJson, required) {
  let list;
  try { list = JSON.parse(String(calendarsJson == null ? '' : calendarsJson)); }
  catch (_) { return { parse: false }; }
  if (!Array.isArray(list)) return { parse: false };

  const byId = new Map();
  for (const c of list) {
    const o = c || {};
    const id = o.calendar_id == null ? '' : String(o.calendar_id);
    if (!id) continue;
    byId.set(id, {
      role: o.role == null ? '' : String(o.role),
      trainer_id: o.trainer_id == null || o.trainer_id === '' ? null : String(o.trainer_id),
    });
  }

  const missing = [], mismatched = [];
  for (const need of required) {
    const got = byId.get(need.calendar_id);
    if (!got) { missing.push(need.calendar_id); continue; }
    if (need.role != null && got.role !== need.role) { mismatched.push(need.calendar_id); continue; }
    if (need.trainer_id != null && got.trainer_id !== need.trainer_id) mismatched.push(need.calendar_id);
  }
  if (!missing.length && !mismatched.length) return null;
  const out = {};
  if (missing.length) out.missing = missing;
  if (mismatched.length) out.mismatched = mismatched;
  return out;
}

export const _forTest = { normalizeRequired, missingCalendars, unusable, READ_SQL, STATUS_READY };
