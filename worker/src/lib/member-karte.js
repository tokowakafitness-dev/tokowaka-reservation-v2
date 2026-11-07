// 会員に見せるカルテを組み立てる（設計35 会員画面 C2・改訂1〜3）・2026-11-06
//
//   ★会員本人（c_myKarte）と、トレーナーの「お客様の見え方」（k_memberPreview）は**この関数だけ**を通る
//     （I-M7＝見え方が食い違わない）。呼ぶ側で項目を足したり削ったりしない。
//
//   ★返す項目は「足す一覧（allowlist）」で作る（I-M2）。k_ の応答を流用して落とす（redact）形にしない。
//     SQL の段階で列を選ぶ（改訂1-8）。全部の列を取る書き方をしない。
//     このファイルには社内メモ・健康情報・同意・セットのメモ・金額の表名や列名を**書かない**
//     （member-karte.test.js がソースを文字列で検査する。説明のコメントにも書かない）。
//
//   ★倒れる向き（設計35 §1）：判定できないものは null／空配列。推測で埋めない。
//     体の記録は verified の凍結＋d1 だけ（I51）。契約は計算の材料がそろって新しいときだけ（I53）。
//
//   customerId は呼ぶ側が確定させたもの（会員なら who.customerId、トレーナーなら共有の範囲を通した顧客）。

import { synthesizeBody, compareRows } from './body-series.js';
import { readCalcInputStatus } from './remain-read-on.js';

export const MEMBER_LIMITS = {
  SERIES: 24,       // 推移（古い→新しい）
  RECENT: 10,       // 最近の記録（新しい→古い）
  SESSIONS: 20,     // トレーニング（新しい→古い）
  BEST: 50,         // 自己ベストの種目数
  NOTES: 20,        // 「お客様へ」の履歴（新しい→古い）
};

const DAY_MS = 86400000;

function jstDate(ms) {
  const d = new Date(Number(ms) + 9 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
const isYmd = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
/** 有限の数だけ数として返す（文字の数は数に直す）。それ以外は null */
function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}
function strOrNull(v) {
  if (v == null) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
}
/** 文字の配列の JSON 列 → 配列（壊れていれば空） */
function strArray(s) {
  if (s == null) return [];
  try {
    const a = JSON.parse(String(s));
    return Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x !== '') : [];
  } catch (_) { return []; }
}

// ---------------------------------------------------------------- 目標
async function readGoal(db, cid) {
  //   ★ヒアリングは目標体重の1項目だけを SQL で取り出す（JSON 全体を読まない・改訂1-8）
  const r = await db.prepare(
    `SELECT goal_deadline, json_extract(hearing_json, '$.targetWeight') AS target_weight
       FROM karte_profile WHERE customer_id = ?`
  ).bind(cid).first();
  return {
    targetWeight: r ? numOrNull(r.target_weight) : null,
    deadline: r && isYmd(r.goal_deadline) ? r.goal_deadline : null,
  };
}

// ---------------------------------------------------------------- 体の記録（I51）
async function readBody(db, cid) {
  const empty = { latest: null, prev: null, series: [], recent: [], goalLine: null };
  const fz = await db.prepare(
    `SELECT freeze_id FROM body_freeze WHERE state = 'verified' ORDER BY started_at DESC LIMIT 1`
  ).first();
  if (!fz) return empty;   // ★切り替えが確かめられていない＝何も見せない
  const like = String(fz.freeze_id) + ':%';
  const [rows, goals] = await Promise.all([
    //   並べ替え（後勝ち）に要る id・origin・sheet_order と、見せる3項目だけ
    db.prepare(
      `SELECT id, origin, sheet_order, measured_date, weight_kg, body_fat_pct, skeletal_muscle_kg
         FROM body_measurements
        WHERE customer_id = ? AND deleted_at IS NULL
          AND (origin = 'd1' OR (origin = 'sheet' AND origin_key LIKE ?))`
    ).bind(cid, like).all(),
    db.prepare(
      `SELECT id, origin, sheet_order, kind, start_date, end_date, start_weight, target_weight
         FROM body_goals
        WHERE customer_id = ? AND deleted_at IS NULL AND kind = 'meal_goal'
          AND (origin = 'd1' OR (origin = 'sheet' AND origin_key LIKE ?))`
    ).bind(cid, like).all(),
  ]);
  //   1日1点（同じ日は項目ごとに後勝ち・空欄で上書きしない＝k_body と同じ合成）
  const days = synthesizeBody((rows && rows.results) || [])
    .map((r) => ({ date: r.d, weight: numOrNull(r.w), fat: numOrNull(r.pbf), muscle: numOrNull(r.smm) }))
    .filter((p) => p.weight != null || p.fat != null || p.muscle != null);
  const series = days.slice(-MEMBER_LIMITS.SERIES);
  const recent = days.slice().reverse().slice(0, MEMBER_LIMITS.RECENT);
  //   目標線：meal_goal の最後の行。4つ揃わなければ出さない（期の線は会員画面では使わない）
  const gl = ((goals && goals.results) || []).slice().sort(compareRows);
  const g = gl.length ? gl[gl.length - 1] : null;
  let goalLine = null;
  if (g && isYmd(g.start_date) && isYmd(g.end_date) && numOrNull(g.start_weight) != null && numOrNull(g.target_weight) != null) {
    goalLine = { startDate: g.start_date, endDate: g.end_date, startWeight: numOrNull(g.start_weight), targetWeight: numOrNull(g.target_weight) };
  }
  return {
    latest: days.length ? days[days.length - 1] : null,
    prev: days.length > 1 ? days[days.length - 2] : null,
    series, recent, goalLine,
  };
}

// ---------------------------------------------------------------- トレーニング
async function readTraining(db, cid) {
  const ss = await db.prepare(
    `SELECT session_id, session_date FROM karte_tr_sessions
      WHERE customer_id = ? AND deleted_at IS NULL
      ORDER BY session_date DESC, created_at DESC LIMIT ${MEMBER_LIMITS.SESSIONS}`
  ).bind(cid).all();
  const sessions = (ss && ss.results) || [];
  //   ★無理やりのセットは会員に出さない（設計38 §6-3・オーナー確定・I67）。出さない集合は SQL の WHERE で決める
  //     ＝日別・自己ベスト・推移が同じ集合から作られ、食い違わない。印の列は WHERE と JOIN の条件にだけ書き、SELECT 句には書かない
  //   自己ベスト：生きた記録すべてから、種目ごとに重さ最大→同じなら回数最大→同じなら早い日。本セットだけ（ドロップは別の表）
  const bestQ = db.prepare(
    `SELECT exercise, weight_kg, reps, session_date FROM (
       SELECT t.exercise, t.weight_kg, t.reps, s.session_date,
              ROW_NUMBER() OVER (PARTITION BY t.exercise ORDER BY t.weight_kg DESC, t.reps DESC, s.session_date ASC) AS rn
         FROM karte_tr_sets t JOIN karte_tr_sessions s ON s.session_id = t.session_id
         LEFT JOIN karte_tr_set_ext e ON e.set_id = t.set_id
        WHERE s.customer_id = ? AND s.deleted_at IS NULL AND e.forced IS NULL)
      WHERE rn = 1 ORDER BY exercise LIMIT ${MEMBER_LIMITS.BEST}`
  ).bind(cid).all();
  if (!sessions.length) {
    await bestQ;
    return { sessions: [], best: [] };
  }
  const ids = sessions.map((x) => x.session_id);
  const ph = ids.map(() => '?').join(',');
  const [st, xs, ds, tg, bs] = await Promise.all([
    //   ★セットは種目・番号・重さ・回数・補助だけ（セットに付けた文は読まない）。
    //     新しい回（付加あり）は ord の順、古い回は ord が NULL＝今までどおり入力の順（set_id の順）
    db.prepare(
      `SELECT t.set_id, t.session_id, t.exercise, t.set_no, t.weight_kg, t.reps, e.ord, e.assist_reps
         FROM karte_tr_sets t LEFT JOIN karte_tr_set_ext e ON e.set_id = t.set_id
        WHERE t.session_id IN (${ph}) AND e.forced IS NULL ORDER BY t.session_id, e.ord, t.set_id`
    ).bind(...ids).all(),
    //   種目の並び（新しい形の回だけ行がある）
    db.prepare(
      `SELECT session_id, ord, exercise, done_only FROM karte_tr_exercises
        WHERE session_id IN (${ph}) ORDER BY session_id, ord`
    ).bind(...ids).all(),
    //   ドロップ：その段が無理やりでなく、親の本セットも無理やりでないものだけ
    db.prepare(
      `SELECT d.set_id, d.weight_kg, d.reps, d.assist_reps
         FROM karte_tr_drops d JOIN karte_tr_sets t ON t.set_id = d.set_id
         LEFT JOIN karte_tr_set_ext e ON e.set_id = d.set_id
        WHERE t.session_id IN (${ph}) AND d.forced IS NULL AND e.forced IS NULL ORDER BY d.set_id, d.drop_seq`
    ).bind(...ids).all(),
    //   日のタグ＝その session に付いた生きた枚の tags
    db.prepare(
      `SELECT session_id, tags_json FROM karte_member_notes
        WHERE customer_id = ? AND deleted_at IS NULL AND session_id IN (${ph})`
    ).bind(cid, ...ids).all(),
    bestQ,
  ]);
  const setsBy = {};
  for (const s of ((st && st.results) || [])) (setsBy[s.session_id] = setsBy[s.session_id] || []).push(s);
  const exBy = {};
  for (const x of ((xs && xs.results) || [])) (exBy[x.session_id] = exBy[x.session_id] || []).push(x);
  const dropBy = {};
  for (const d of ((ds && ds.results) || [])) {
    (dropBy[d.set_id] = dropBy[d.set_id] || []).push({ weight: numOrNull(d.weight_kg), reps: numOrNull(d.reps), assist: numOrNull(d.assist_reps) });
  }
  //   セット { setNo, weight, reps, assist }。ドロップがあるときだけ drops（古い会員の画面はドロップが見えないだけ）
  const setOut = (s) => {
    const o = { setNo: numOrNull(s.set_no), weight: numOrNull(s.weight_kg), reps: numOrNull(s.reps), assist: numOrNull(s.assist_reps) };
    if (dropBy[s.set_id]) o.drops = dropBy[s.set_id];
    return o;
  };
  const tagsBy = {};
  for (const t of ((tg && tg.results) || [])) tagsBy[t.session_id] = strArray(t.tags_json);
  const out = sessions.map((se) => {
    const items = [];
    const xl = exBy[se.session_id];
    if (xl) {
      //   新しい形の回：ord の順。同じ名前の2つの種目は2行。数字の無い種目は「実施」
      //   ★本セットが全部出せない種目（全部無理やり）は、数字の無い種目でなければ種目ごと出さない（名前だけの空の行を出さない）
      const byOrd = {};
      for (const s of (setsBy[se.session_id] || [])) (byOrd[s.ord] = byOrd[s.ord] || []).push(s);
      for (const x of xl) {
        if (x.done_only === 1) { items.push({ exercise: String(x.exercise), sets: [], done: true }); continue; }
        const ss = byOrd[x.ord] || [];
        if (ss.length) items.push({ exercise: String(x.exercise), sets: ss.map(setOut) });
      }
    } else {
      const at = {};
      for (const s of (setsBy[se.session_id] || [])) {
        const ex = String(s.exercise);
        if (!(ex in at)) { at[ex] = items.length; items.push({ exercise: ex, sets: [] }); }
        items[at[ex]].sets.push(setOut(s));
      }
    }
    return { date: se.session_date, items, tags: tagsBy[se.session_id] || [] };
  });
  const best = ((bs && bs.results) || []).map((b) => ({
    exercise: String(b.exercise), weight: numOrNull(b.weight_kg), reps: numOrNull(b.reps), date: b.session_date,
  }));
  return { sessions: out, best };
}

// ---------------------------------------------------------------- 「お客様へ」
async function readMemberNotes(db, cid, opts) {
  //   ★session のある枚は、生きた session（同じ顧客）があるときだけ（改訂2-1＝消し忘れがあっても会員に出ない）
  //   ★担当は名簿の表示名に直す。ID は返さない
  const r = await db.prepare(
    `SELECT m.mnote_id, m.session_id, m.session_date, m.message, m.todo_json, m.tags_json, m.author_trainer_id, m.rev,
            tr.name AS trainer_name
       FROM karte_member_notes m
       LEFT JOIN karte_tr_sessions s ON s.session_id = m.session_id AND s.deleted_at IS NULL AND s.customer_id = m.customer_id
       LEFT JOIN trainers tr ON tr.trainer_id = m.author_trainer_id
      WHERE m.customer_id = ? AND m.deleted_at IS NULL
        AND (m.session_id IS NULL OR s.session_id IS NOT NULL)
      ORDER BY m.session_date DESC, m.created_at DESC LIMIT ${MEMBER_LIMITS.NOTES}`
  ).bind(cid).all();
  const me = String((opts && opts.viewerTrainerId) || '');
  return ((r && r.results) || []).map((n) => {
    const o = { date: n.session_date, message: strOrNull(n.message), todo: strArray(n.todo_json), trainerName: strOrNull(n.trainer_name) };
    if (opts && opts.includeIds) {
      o.mnoteId = n.mnote_id;
      o.rev = numOrNull(n.rev);
      o.sessionId = n.session_id || null;
      o.authorIsMe = me !== '' && String(n.author_trainer_id || '') === me;
      o.tags = strArray(n.tags_json);   // 「直す」でその枚のタグを出す（日付から推測しない＝同じ日に2回でも取り違えない・Codex 関門②）
    }
    return o;
  });
}

// ---------------------------------------------------------------- 契約（I53 を満たすときだけ）
async function readContract(env, cid, nowMs) {
  const db = env.DB;
  //   ★計算の材料4つが同じ回で45分未満でなければ答えない（I53 の判定をそのまま使う）
  if ((await readCalcInputStatus(env, nowMs)) !== 'ok') return null;
  const meta = await db.prepare(`SELECT payload FROM calc_meta WHERE key = 'contract_cols'`).first();
  if (!meta) return null;
  let cols = null;
  try { cols = JSON.parse(meta.payload).cols; } catch (_) { cols = null; }
  if (!cols || typeof cols !== 'object') return null;
  const idx = (k) => (Number.isInteger(cols[k]) && cols[k] >= 0 ? cols[k] : -1);
  //   ★行の全体（金額・支払いを含む）を読まない。会員に見せる列だけを SQL で取り出す（改訂1-8・Codex 関門②）
  const KEYS = ['type', 'course', 'freq', 'trainer', 'ticket'];
  const sel = KEYS.map((k) => (idx(k) >= 0 ? `json_extract(row_json, '$[${idx(k)}]') AS c_${k}` : `NULL AS c_${k}`)).join(', ');
  //   契約期間内で開始が最新の行（GAS の _lbFindContract と同じ選び方）。終了日はその日の終わりまで有効
  const row = await db.prepare(
    `SELECT ${sel}, start_ms, end_ms FROM calc_contract_rows
      WHERE customer_id = ? AND start_ms IS NOT NULL AND start_ms <= ?
        AND (end_ms IS NULL OR end_ms + ${DAY_MS} > ?)
      ORDER BY start_ms DESC LIMIT 1`
  ).bind(cid, nowMs, nowMs).first();
  if (!row) return null;
  const pick = (k) => (row['c_' + k] === undefined ? null : row['c_' + k]);
  //   担当：行の文字を名簿の表示名に直す（ID か表示名がちょうど1人に当たるときだけ）。行の文字はそのまま出さない
  let trainerName = null;
  const raw = strOrNull(pick('trainer'));
  if (raw) {
    const t = await db.prepare(`SELECT name FROM trainers WHERE trainer_id = ? OR name = ? LIMIT 2`).bind(raw, raw).all();
    const hit = (t && t.results) || [];
    if (hit.length === 1) trainerName = strOrNull(hit[0].name);
  }
  const freqRaw = pick('freq');
  return {
    type: strOrNull(pick('type')),
    course: strOrNull(pick('course')),
    freq: numOrNull(freqRaw) != null ? numOrNull(freqRaw) : strOrNull(freqRaw),
    trainerName,
    //   ★期間の列が契約表に無ければ推定しない（改訂1-5）。値は GAS が解釈したミリ秒から日本時間の日付へ
    startDate: idx('start') >= 0 && row.start_ms != null ? jstDate(row.start_ms) : null,
    endDate: idx('end') >= 0 && row.end_ms != null ? jstDate(row.end_ms) : null,
    tickets: numOrNull(pick('ticket')),
  };
}

/**
 * 会員に見せるカルテ（設計35 の応答の形）
 *   opts.includeContract  true のときだけ契約の表を問い合わせる（false なら SQL を1本も出さない・改訂2-3）
 *   opts.includeIds       k_memberPreview のときだけ true（notes に mnoteId・rev・sessionId・authorIsMe）
 *   opts.viewerTrainerId  authorIsMe の判定に使う（includeIds のときだけ）
 */
export async function buildMemberKarte(env, customerId, opts) {
  const o = opts || {};
  const cid = String(customerId || '');
  const db = env.DB;
  const now = typeof o.nowMs === 'number' ? o.nowMs : Date.now();
  const [goal, body, training, notes, contract] = await Promise.all([
    readGoal(db, cid),
    readBody(db, cid),
    readTraining(db, cid),
    readMemberNotes(db, cid, { includeIds: o.includeIds === true, viewerTrainerId: o.viewerTrainerId }),
    o.includeContract === true ? readContract(env, cid, now) : Promise.resolve(null),
  ]);
  return { goal, body, training, notes, contract };
}
