// ① カレンダー → D1 の「突き合わせ」（POST /calcompare ／ GET /calcompare/status）
//   設計：ops/design/01-calendar-to-d1.md §12（比較の記録）／§11（読み取りのみだから影響しない）
//
//   ①の**完了条件**は「GASとD1の答えが連続7日間一致すること」（§12）。
//   手元の突き合わせ（worker/test/slots-parity.test.js）は52件すべて一致しているが、
//   **本番のカレンダーには想定外の形が必ずある。** そこを7日間見てから、
//   読み取りをD1に切り替える（切り替えるのは③であって①ではない）。
//
//   ここの仕事は2つだけ：
//     POST /calcompare         … GASが出した空き枠を受け取り、同じ条件でD1から出した
//                                空き枠と突き合わせて compare_log に記録する
//     GET  /calcompare/status  … 「連続何日一致したか」を返す（①を完了してよいかの判断材料）
//
//   ★絶対に守ること（設計 §11・§12）
//     1. **読み取りだけ。** 書くのは compare_log だけ。既存のテーブル
//        （calendar_snapshot / calendar_active / calendar_events）には一切触らない。
//     2. **氏名・タイトルを残さない。** 空き枠は時刻とトレーナーIDだけ。
//        GASは trainers[].name を送ってくるが、ここでは**受け取った時点で捨てる**
//        （slotsFromEvents には name:'' を渡す）。名前が diff に混ざる道を構造的に閉じる。
//     3. **比較が失敗しても何も壊さない。** 比較は表示にも予約にも影響しない。
//        例外は500で返して終わり。D1は壊れない。
//     4. **「一致しなかった」と「比較できなかった」を混ぜない。**
//        D1が使えない（鮮度切れ・地平外・規則違い等）ときは、不一致として記録せず
//        kind='slots_skipped' / matched=NULL で**理由を**記録する。
//        ここを混ぜると、D1が7分以上古いだけで「GASと違う」に見え、
//        永久に完了条件を満たせない（あるいは逆に、使えない状態を一致と数えてしまう）。
//
//   ★分類も空き枠の生成もここに書き写さない。
//     可否判定と取得 … worker/src/lib/calread.js（readCalendar）
//     空き枠の生成   … worker/src/lib/calslots.js（slotsFromEvents）
//     どちらも中身を変えない。**使うだけ。**

import { readCalendar } from '../lib/calread.js';
import { slotsFromEvents, jstParts, jstMs, jstDateStr, jstTimeStr } from '../lib/calslots.js';

// ---- 上限（§11：比較が資源を食って本体を遅くしない）-------------------------
const MAX_SLOTS = 20000;              // 1回に受ける空き枠の数（地平2ヶ月×3人なら数百件）
const MAX_TRAINERS = 50;              // トレーナーの数
const DIFF_MAX_ITEMS = 20;            // diff に入れる時間帯の数（最初の20件＋件数）
const DIFF_MAX_CHARS = 4000;          // diff の文字数。超えたら件数だけに落とす
const MAX_NOW_SKEW_MS = 120000;       // GASの nowMs と server の時計のずれの許容（§5の上限2分に合わせる）
const INSERT_CHUNK = 50;              // D1のbatchに1度に渡す文の数（calsync.js と同じ）

// ---- 「連続7日間」の既定値（§12 ①の完了条件）--------------------------------
export const NEED_DAYS = 7;           // 連続7日間
// 最低サンプル数（§12）。GASの定期同期は5分ごと＝1日288回。
//   288を要求するとトリガーの揺れ1回で途切れるので、約7割の200回を既定にする。
//   厳しく見たいときは ?minRuns=288 で上げられる。
export const MIN_RUNS_PER_DAY = 200;
const STATUS_DEFAULT_WINDOW_DAYS = 14;   // 連続7日を判定するには7日より広く見る必要がある
const STATUS_MAX_WINDOW_DAYS = 60;

// compare_log.kind（§12）
export const KIND_SLOTS = 'slots';            // 比較した（matched は 0 / 1）
export const KIND_SKIPPED = 'slots_skipped';  // 比較できなかった（matched は NULL）

const INSERT_SQL = `INSERT INTO compare_log
  (at, generation, trainer_id, kind, gas_count, d1_count, diff, matched)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

// 連続日数を数えるための読み取り。
//   1回の実行はトレーナーごとに複数行だが、同じ `at` を共有する。
//   だから `at` で畳んで「1回の実行」に戻す。
//   MIN(matched) が 1 ＝ その実行は全トレーナー一致。0 が1つでもあれば不一致。
//   ★同じ `at` に別の実行が重なったら MIN は 0 に倒れる（fail-closed）。
export const STATUS_SQL = `SELECT at, kind, COUNT(*) AS n, MIN(matched) AS min_matched
  FROM compare_log
 WHERE at >= ? AND at < ? AND kind IN (?, ?)
 GROUP BY at, kind
 ORDER BY at`;

// ============================================================
// 小道具（calsync.js と同じ作法。この作業では他のファイルを触らないため写した）
// ============================================================

// 長さと中身の両方で時間差が出ない比較（合言葉の推測を助けない）
//   ★ingest.js / calsync.js / jobs.js / verify.js と同じ実装。
//     test/calcompare.test.js が calsync.js の実装と答えが一致することを検査しているので、
//     黙って食い違うことはない。
function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a || ''));
  const y = new TextEncoder().encode(String(b || ''));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

function jsonRes(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function isInt(v) {
  return typeof v === 'number' && isFinite(v) && Math.floor(v) === v;
}

// JSTの日付（'YYYY-MM-DD'）。日の区切りは**日本時間**で見る。
//   UTCで区切ると、日本の朝9時までが前日に数えられて「連続7日間」がずれる。
export function jstDayKey(ms) {
  const p = jstParts(ms);
  const p2 = (n) => (n < 10 ? '0' : '') + n;
  return p.year + '-' + p2(p.month) + '-' + p2(p.day);
}

// JSTのその日の00:00
function jstDayStartMs(ms) {
  const p = jstParts(ms);
  return jstMs(p.year, p.month, p.day, 0, 0);
}

// diff に入れる時刻の表し方。**時刻だけ。** 氏名・タイトルは入れない（§12★）。
//   トレーナーは行の trainer_id が持っているので、ここには入れない。
function fmtAt(ms) {
  return jstDateStr(ms) + ' ' + jstTimeStr(ms);
}

// ============================================================
// 突き合わせ（純粋な関数。D1もネットワークも触らない）
// ============================================================
//
// 鍵は **トレーナー × 開始時刻**（test/gas-slots-harness.js の slotKey と同じ考え方）。
//   終了時刻は開始＋セッション長で決まるので鍵に入れない。
//   trialOk は鍵ではなく**同じ鍵の中身の食い違い**として別に数える（§12の要求）。
//
// ★範囲の端で切る理由
//   D1の予定は「範囲に重なるもの」を取る（calread の重なり条件）。だから
//   7:00-23:00の出勤は、範囲が12:00からでも丸ごと入ってきて、7:00の枠が出る。
//   GASは要求された範囲の枠だけを送る。切らずに比べると**毎回必ず不一致**になり、
//   本当の食い違いが埋もれる。だから両方を [fromMs, toMs) の開始時刻で切って比べる。
//
// 返す形（トレーナーごとに1つ。compare_log の1行に対応する）
//   { trainerId, gasCount, d1Count, matched,
//     counts: { onlyGas, onlyD1, trial, gasDupe, d1Dupe },
//     items:  { onlyGas:[ms], onlyD1:[ms], trial:[{ startMs, gas, d1 }] } }
export function compareSlots(gasSlots, d1Slots, trainerIds, fromMs, toMs) {
  const ids = new Set((trainerIds || []).map((t) => String(t)));

  const take = (list, pick) => {
    const byTrainer = new Map();     // trainerId -> Map(startMs -> trialOk)
    const raw = new Map();           // trainerId -> 範囲内の生の件数（重複を含む）
    const dupe = new Map();          // trainerId -> 同じ鍵が2度出た数
    let outOfRange = 0;
    for (const s of (list || [])) {
      const { trainerId, startMs, trialOk } = pick(s);
      if (!(startMs >= fromMs && startMs < toMs)) { outOfRange++; continue; }
      ids.add(trainerId);
      raw.set(trainerId, (raw.get(trainerId) || 0) + 1);
      if (!byTrainer.has(trainerId)) byTrainer.set(trainerId, new Map());
      const b = byTrainer.get(trainerId);
      // ★同じ鍵が2度出ることは実際にある（出勤イベントが重複登録されていると
      //   GASは同じ枠を2回出す。calslots.js も同じ答えを出すようにしてある）。
      //   鍵の集合は変わらないので一致の判定には使わないが、**件数として見える**ようにする。
      if (b.has(startMs)) dupe.set(trainerId, (dupe.get(trainerId) || 0) + 1);
      else b.set(startMs, trialOk);
    }
    return { byTrainer, raw, dupe, outOfRange };
  };

  const gas = take(gasSlots, (s) => ({
    trainerId: String(s.trainerId), startMs: Number(s.startMs), trialOk: !!s.trialOk,
  }));
  const d1 = take(d1Slots, (s) => ({
    trainerId: String(s.trainerId), startMs: Number(s.startMs), trialOk: !!s.trialOk,
  }));

  const out = [];
  for (const tid of [...ids].sort()) {
    const g = gas.byTrainer.get(tid) || new Map();
    const d = d1.byTrainer.get(tid) || new Map();
    const onlyGas = [], onlyD1 = [], trial = [];
    for (const [ms, gTrial] of g) {
      if (!d.has(ms)) onlyGas.push(ms);
      else if (gTrial !== d.get(ms)) trial.push({ startMs: ms, gas: gTrial, d1: d.get(ms) });
    }
    for (const ms of d.keys()) if (!g.has(ms)) onlyD1.push(ms);
    onlyGas.sort((a, b) => a - b);
    onlyD1.sort((a, b) => a - b);
    trial.sort((a, b) => a.startMs - b.startMs);

    out.push({
      trainerId: tid,
      gasCount: gas.raw.get(tid) || 0,
      d1Count: d1.raw.get(tid) || 0,
      // ★trialOk の食い違いも「一致していない」に数える。
      //   体験が押さえられるかは顧客が予約できるかそのものなので、
      //   時刻が揃っていても別に数えて**一致とは呼ばない**。
      matched: onlyGas.length === 0 && onlyD1.length === 0 && trial.length === 0,
      counts: {
        onlyGas: onlyGas.length, onlyD1: onlyD1.length, trial: trial.length,
        gasDupe: gas.dupe.get(tid) || 0, d1Dupe: d1.dupe.get(tid) || 0,
      },
      items: { onlyGas, onlyD1, trial },
    });
  }
  return { trainers: out, gasOutOfRange: gas.outOfRange, d1OutOfRange: d1.outOfRange };
}

// 1行の diff を作る。**食い違った時間帯だけ。氏名・タイトルは入らない**（§12★）。
//   長さの上限を2段で掛ける：
//     ① 各種類ごとに最初の DIFF_MAX_ITEMS 件（件数は counts に残る）
//     ② それでも長ければ件数だけに落とす（truncated: true）
//   上限が無いと、1件の設定違いで数千件ずれたときに compare_log が一気に膨らむ。
export function buildDiff(r) {
  const c = r.counts;
  if (r.matched && !c.gasDupe && !c.d1Dupe) return null;    // 一致したら diff は残さない

  const body = { counts: c };
  if (c.onlyGas) body.onlyGas = r.items.onlyGas.slice(0, DIFF_MAX_ITEMS).map(fmtAt);
  if (c.onlyD1) body.onlyD1 = r.items.onlyD1.slice(0, DIFF_MAX_ITEMS).map(fmtAt);
  if (c.trial) {
    body.trial = r.items.trial.slice(0, DIFF_MAX_ITEMS)
      .map((t) => ({ at: fmtAt(t.startMs), gas: t.gas, d1: t.d1 }));
  }
  if (c.onlyGas > DIFF_MAX_ITEMS || c.onlyD1 > DIFF_MAX_ITEMS || c.trial > DIFF_MAX_ITEMS) {
    body.truncated = true;
  }
  let s = JSON.stringify(body);
  if (s.length > DIFF_MAX_CHARS) s = JSON.stringify({ counts: c, truncated: true });
  return s;
}

// 比較できなかったときの記録（§12・「不一致」と混ぜない）。
//   readCalendar の detail は数値とカレンダーIDだけ（氏名・タイトルは元から無い）。
export function buildSkipDiff(read) {
  const body = { skip: String(read.reason) };
  if (read.detail) body.detail = read.detail;
  let s = JSON.stringify(body);
  if (s.length > DIFF_MAX_CHARS) s = JSON.stringify({ skip: String(read.reason), truncated: true });
  return s;
}

// ============================================================
// 入口
// ============================================================
export async function handleCalCompare(request, env) {
  const url = new URL(request.url);
  const isStatus = url.pathname === '/calcompare/status';
  try {
    if (isStatus) {
      if (request.method !== 'GET') return jsonRes({ success: false, code: 'METHOD_NOT_ALLOWED' }, 405);
      return await calcompareStatus(request, env, url);
    }
    if (request.method !== 'POST') return jsonRes({ success: false, code: 'METHOD_NOT_ALLOWED' }, 405);
    return await calcompare(request, env);
  } catch (e) {
    // ★ここで止める。比較の失敗を外へ出さない（§11：表示に影響させない）。
    //   合言葉を通った相手（GAS）しか到達しないので、原因は返す（直せるほうがよい）。
    console.error('calcompare', e && e.stack);
    return jsonRes({ success: false, code: 'INTERNAL', detail: String((e && e.message) || e).slice(0, 300) }, 500);
  }
}

function auth(request, env) {
  const secret = env.SHARED_SECRET || '';
  if (!secret) return jsonRes({ success: false, code: 'SECRET_NOT_SET' }, 503);
  if (!safeEqual(request.headers.get('X-Ingest-Secret') || '', secret)) {
    return jsonRes({ success: false, code: 'FORBIDDEN' }, 403);
  }
  return null;
}

// ------------------------------------------------------------
// POST /calcompare
// ------------------------------------------------------------
async function calcompare(request, env) {
  const bad = auth(request, env);
  if (bad) return bad;

  let body;
  try { body = await request.json(); } catch (_) { return jsonRes({ success: false, code: 'BAD_JSON' }, 400); }

  // ---- 形の検証。ここで落ちたものは記録しない（押し出す側が壊れている）----
  //   ★壊れた要求を「不一致」として記録しない。記録すると、GASの不具合が
  //     「D1が違う」に見えて原因を取り違える。
  const fromMs = body.fromMs, toMs = body.toMs;
  if (!isInt(fromMs) || !isInt(toMs) || toMs <= fromMs) return jsonRes({ success: false, code: 'BAD_RANGE' }, 400);
  const ruleVersion = body.ruleVersion;
  if (!isInt(ruleVersion) || ruleVersion < 1) return jsonRes({ success: false, code: 'BAD_RULE_VERSION' }, 400);
  const flag1f = String(body.flag1f == null ? '' : body.flag1f);
  if (flag1f !== 'on' && flag1f !== 'off') return jsonRes({ success: false, code: 'BAD_FLAG_1F' }, 400);
  if (!Array.isArray(body.requiredCalendars) || body.requiredCalendars.length === 0) {
    return jsonRes({ success: false, code: 'BAD_CALENDARS' }, 400);
  }
  if (!Array.isArray(body.trainers) || body.trainers.length === 0) {
    return jsonRes({ success: false, code: 'BAD_TRAINERS' }, 400);
  }
  if (body.trainers.length > MAX_TRAINERS) return jsonRes({ success: false, code: 'TOO_MANY_TRAINERS' }, 413);
  if (!Array.isArray(body.slots)) return jsonRes({ success: false, code: 'SLOTS_NOT_ARRAY' }, 400);
  if (body.slots.length > MAX_SLOTS) return jsonRes({ success: false, code: 'TOO_MANY' }, 413);
  if (body.ownerWindow != null && typeof body.ownerWindow !== 'object') {
    return jsonRes({ success: false, code: 'BAD_OWNER_WINDOW' }, 400);
  }

  // ★氏名をここで捨てる（§12★）。name は受け取るが、どこにも渡さない。
  //   slotsFromEvents には name:'' を渡す。これで氏名が diff に混ざる道が無くなる。
  const trainers = [];
  const seen = new Set();
  for (const t of body.trainers) {
    const id = t && t.id != null ? String(t.id) : '';
    if (!id) return jsonRes({ success: false, code: 'BAD_TRAINER_ID' }, 400);
    if (seen.has(id)) return jsonRes({ success: false, code: 'DUPLICATE_TRAINER' }, 400);
    seen.add(id);
    trainers.push({ id, name: '', hidden: !!(t && t.hidden) });
  }

  for (const s of body.slots) {
    if (!s || !isInt(s.startMs) || s.trainerId == null || String(s.trainerId) === '') {
      return jsonRes({ success: false, code: 'BAD_SLOTS' }, 400);
    }
  }

  // nowMs はGASが「自分が空き枠を出した時刻」として送る。
  //   ★GASの nowMs をそのまま使う。締め切り（開始180分前・午前枠は前日22時）は
  //     now で決まるので、こちらで Date.now() を使うと**時計のずれだけで**
  //     境界の枠が毎回食い違い、本当の食い違いが埋もれる。
  //   ★ただし、ずれが大きい要求は受けない。古い nowMs を使うと鮮度の判定（calread）が
  //     実際より甘くなる。上限は §5 と同じ2分。
  const nowMs = body.nowMs;
  if (!isInt(nowMs)) return jsonRes({ success: false, code: 'BAD_NOW' }, 400);
  const at = Date.now();
  // ★時点をずらした突き合わせでは、nowMs は意図的にずれる（2026-10-03）。
  //   7日間待つ代わりに「いま」を1〜7日前・25日・月末などにずらして比べるので、
  //   ずれを拒否すると狙った時点を1つも試せない。実際、最初の実行で13時点すべてが
  //   STALE_NOW で落ちた。
  //   sweep:true を明示したときだけ、ずれを許す。
  //   安全性：nowMs は「GASが空き枠を計算した時点」であって、D1の鮮度判定には使わない
  //   （鮮度は calendar_active.checked_at で見る）。だから古い nowMs で鮮度を偽ることはできない。
  //   突き合わせは compare_log に記録するだけで、表示にも予約にも影響しない。
  const sweep = body.sweep === true;
  if (!sweep && Math.abs(at - nowMs) > MAX_NOW_SKEW_MS) {
    return jsonRes({ success: false, code: 'STALE_NOW', skewMs: at - nowMs }, 409);
  }

  // ---- D1を読む（§7：すべての読み取りが readCalendar を通る）----
  //   ★鮮度の判定には **実時刻** を渡す（2026-10-03）。
  //     nowMs は「GASが空き枠を計算した時点」であって、D1が新しいかどうかとは関係ない。
  //     時点をずらした突き合わせで nowMs をそのまま渡すと、
  //     「1日前から見ればD1は1日先のデータ」となって必ず stale になり、
  //     狙った時点を1つも比べられない（実際そうなった）。
  //     ずらした時刻を使うのは**空き枠の計算（締め切り判定）だけ**。
  const read = await readCalendar(env, {
    fromMs, toMs, ruleVersion, flag1f,
    requiredCalendars: body.requiredCalendars,
    nowMs: at,          // 鮮度は実時刻で見る
  });

  // ---- 使えないなら比較せず、理由を記録する（「不一致」と混ぜない）----
  if (!read.usable) {
    await insertRows(env, [{
      at, generation: read.generation, trainerId: null, kind: KIND_SKIPPED,
      gasCount: body.slots.length, d1Count: null, diff: buildSkipDiff(read), matched: null,
    }]);
    return jsonRes({
      success: true, compared: false, at,
      reason: read.reason, generation: read.generation, detail: read.detail || null,
      gasCount: body.slots.length,
    });
  }

  // ---- 同じ条件でD1から空き枠を出す（calslots.js を使うだけ）----
  const d1Slots = slotsFromEvents(read.events, {
    nowMs, trainers, ownerWindow: body.ownerWindow || null,
  });

  // ---- 突き合わせる ----
  const cmp = compareSlots(body.slots, d1Slots, trainers.map((t) => t.id), fromMs, toMs);

  // ---- 記録する（トレーナーごとに1行）----
  const rows = cmp.trainers.map((r) => ({
    at, generation: read.generation, trainerId: r.trainerId, kind: KIND_SLOTS,
    gasCount: r.gasCount, d1Count: r.d1Count,
    diff: buildDiff(r), matched: r.matched ? 1 : 0,
  }));
  await insertRows(env, rows);

  const allMatched = cmp.trainers.every((r) => r.matched);
  return jsonRes({
    success: true, compared: true, at,
    generation: read.generation, checkedAt: read.checkedAt,
    matched: allMatched,
    gasCount: cmp.trainers.reduce((n, r) => n + r.gasCount, 0),
    d1Count: cmp.trainers.reduce((n, r) => n + r.d1Count, 0),
    gasOutOfRange: cmp.gasOutOfRange, d1OutOfRange: cmp.d1OutOfRange,
    trainers: cmp.trainers.map((r) => ({
      trainerId: r.trainerId, gasCount: r.gasCount, d1Count: r.d1Count,
      matched: r.matched, counts: r.counts,
      // GASがログに出せるように、食い違った時間帯の頭だけ返す（氏名は無い）
      onlyGas: r.items.onlyGas.slice(0, DIFF_MAX_ITEMS).map(fmtAt),
      onlyD1: r.items.onlyD1.slice(0, DIFF_MAX_ITEMS).map(fmtAt),
      trial: r.items.trial.slice(0, DIFF_MAX_ITEMS).map((t) => ({ at: fmtAt(t.startMs), gas: t.gas, d1: t.d1 })),
    })),
  });
}

// compare_log にだけ書く。**他のテーブルには触らない。**
async function insertRows(env, rows) {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const stmts = rows.slice(i, i + INSERT_CHUNK).map((r) => env.DB.prepare(INSERT_SQL).bind(
      r.at, r.generation == null ? null : r.generation, r.trainerId, r.kind,
      r.gasCount == null ? null : r.gasCount, r.d1Count == null ? null : r.d1Count,
      r.diff, r.matched == null ? null : r.matched
    ));
    if (stmts.length) await env.DB.batch(stmts);
  }
}

// ------------------------------------------------------------
// GET /calcompare/status — 「連続7日間一致」を数える（§12 ①の完了条件）
// ------------------------------------------------------------
//
//   ?days=14      見る日数（既定14。連続7日を判定するには7日より広く見る）
//   ?minRuns=200  その日を「一致した日」と呼ぶのに必要な実行回数（既定200＝5分ごとの約7割）
//   ?nowMs=...    「今日」をずらす（試験と調査のため。読み取りだけなので害は無い）
//
//   数え方
//     1回の実行＝同じ `at` を持つ行のまとまり。トレーナー全員が matched=1 なら
//     「その実行は一致」。1人でも違えば不一致。
//     kind='slots_skipped'（比較できなかった）は**不一致に数えない**が、
//     実行回数にも数えないので、最低サンプル数に届かず「一致した日」にはならない。
//     ＝「比較できていない日」で7日を埋めることはできない。
//
//     当日は未完なので連続日数には数えない（最低サンプル数に届かないため）。
//     days には当日も途中の数字として載せる。
async function calcompareStatus(request, env, url) {
  const bad = auth(request, env);
  if (bad) return bad;

  const q = url.searchParams;
  const windowDays = intParam(q.get('days'), STATUS_DEFAULT_WINDOW_DAYS, 1, STATUS_MAX_WINDOW_DAYS);
  if (windowDays == null) return jsonRes({ success: false, code: 'BAD_DAYS' }, 400);
  const minRuns = intParam(q.get('minRuns'), MIN_RUNS_PER_DAY, 1, 100000);
  if (minRuns == null) return jsonRes({ success: false, code: 'BAD_MIN_RUNS' }, 400);
  // ★空文字を Number() に通さない（Number('') は 0 になり、1970年を見に行く）
  const rawNow = q.get('nowMs');
  const nowMs = (rawNow == null || rawNow === '') ? Date.now() : Number(rawNow);
  if (!isInt(nowMs) || nowMs <= 0) return jsonRes({ success: false, code: 'BAD_NOW' }, 400);

  // 見る範囲（JSTの日の境目で切る）
  const todayStart = jstDayStartMs(nowMs);
  const DAY = 86400000;
  const windowStart = todayStart - (windowDays - 1) * DAY;
  const windowEnd = todayStart + DAY;

  const dates = [];
  for (let i = 0; i < windowDays; i++) dates.push(jstDayKey(windowStart + i * DAY));

  const res = await env.DB.prepare(STATUS_SQL)
    .bind(windowStart, windowEnd, KIND_SLOTS, KIND_SKIPPED).all();
  const groups = (res && Array.isArray(res.results)) ? res.results : (Array.isArray(res) ? res : []);

  const out = summarizeDays(groups, { dates, todayKey: jstDayKey(nowMs), minRuns, needDays: NEED_DAYS });
  return jsonRes(Object.assign({ success: true, now: nowMs, windowDays }, out));
}

function intParam(raw, dflt, min, max) {
  if (raw == null || raw === '') return dflt;
  const n = Number(raw);
  if (!isInt(n) || n < min || n > max) return null;
  return n;
}

// 日ごとにまとめて、連続日数を数える（純粋な関数。試験で直接叩ける）
//   groups … STATUS_SQL の結果（{ at, kind, n, min_matched }）
export function summarizeDays(groups, params) {
  const { dates, todayKey, minRuns, needDays } = params;
  const map = new Map(dates.map((d) => [d, { date: d, runs: 0, matched: 0, mismatched: 0, unavailable: 0 }]));

  for (const g of (groups || [])) {
    const day = map.get(jstDayKey(Number(g.at)));
    if (!day) continue;                       // 範囲外（起こらないが念のため）
    if (String(g.kind) === KIND_SKIPPED) { day.unavailable++; continue; }
    day.runs++;
    if (Number(g.min_matched) === 1) day.matched++;
    else day.mismatched++;                    // 1人でも違えばその実行は不一致
  }

  const days = dates.map((d) => {
    const x = map.get(d);
    // 「一致した日」＝ 不一致が1回も無く、かつ最低サンプル数に届いている
    x.allMatched = x.runs >= minRuns && x.mismatched === 0;
    return x;
  });

  // 連続日数は新しい日から遡って数える。当日は未完なので数えない。
  //   ★行が1つも無い日は runs=0 で allMatched が偽になり、そこで途切れる。
  //     （日付が飛んだら途切れる＝「見ていない日」を一致と数えない）
  let consecutiveDays = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].date === todayKey) continue;
    if (days[i].allMatched) consecutiveDays++;
    else break;
  }

  return { days, consecutiveDays, ready: consecutiveDays >= needDays, minRuns, needDays };
}

export const _forTest = {
  safeEqual, compareSlots, buildDiff, buildSkipDiff, summarizeDays, jstDayKey, fmtAt,
  intParam, MAX_SLOTS, MAX_TRAINERS, DIFF_MAX_ITEMS, DIFF_MAX_CHARS, MAX_NOW_SKEW_MS,
  NEED_DAYS, MIN_RUNS_PER_DAY, KIND_SLOTS, KIND_SKIPPED, STATUS_DEFAULT_WINDOW_DAYS,
};
