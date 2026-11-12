// 顧客カルテ（設計28・段1＝トレーナー画面だけ）・2026-11-03
//
//   入口（index.js）で済んでいること：LINE の ID トークンの検証・役割の確定・許可表（k_ は trainer/owner だけ）・
//     役割の鮮度（古ければ403）・停止スイッチ KARTE・書き込みの Origin の完全一致・トークンの新しさ（10分）・本文16KB
//
//   ここで守ること
//     ・閲覧の範囲を2つに分ける（4-2）：
//         共有（メモ・トレーニング・目標・安全面・体の記録）＝トレーナー全員（オーナー決定）
//         担当（契約・残数・連絡先・一覧）＝担当＋担当なし（オーナーは全員）＝既存 canSeeCustomer
//     ・書き込みは「回数の先行 batch」→「本体の batch（全部か無か）」（4-5）
//         本体の失敗は見張りの表（karte_guard）の CHECK 違反で batch 全体を巻き戻し、制約の名前で理由を返す
//     ・健康情報（安全面）は同意の記録があるときだけ。書く・読むの条件を SQL に置く（3-3）
//     ・二重送信は karte_requests（本体と同じ batch の最後）。同じ鍵の再送は保存した成功の応答を返す
//     ・誰がいつ開いた・書いたを karte_access_log に（中身は書かない・best effort）

import { canSeeCustomer } from '../perms.js';
import { synthesizeBody, pickGoalLine } from '../lib/body-series.js';
import { normalizeHearing, normalizePainMap, normalizeReasons, normalizeTag, parseJsonCol, has, HEARING_REVISION_SQL } from '../lib/karte-hearing.js';
import { buildMemberKarte } from '../lib/member-karte.js';
import { EXERCISE_LIMITS, normalizeExerciseName, normalizePart } from '../lib/karte-exercises.js';

export const KARTE_LIMITS = {
  BODY_BYTES: 16 * 1024,
  TOKEN_MAX_AGE_S: 3600,   // 2026-11-06 オーナー承認（決定0142）で10分→1時間＝LINE の ID トークンの有効期限。exp は auth.js が別に見る。LIFF は開いたままトークンが新しくならず、10分では施術中に保存できなかった
  RATE_PER_WINDOW: 60,
  WINDOW_MS: 10 * 60 * 1000,
  NOTE_CHARS: 2000,
  TEXT_CHARS: 500,
  EXERCISES: 20,
  SETS_PER_EXERCISE: 10,   // ord（その回の何番目の種目か）ごと。同じ名前の2つの種目は別々に数える（設計38）
  DROPS_PER_SET: 3,        // 1つの本セットのドロップの段（設計38）
  ASSIST_MAX: 100,         // 補助の回数（reps と同じ上限・回数に足さない）
  TOTAL_SETS: 60,          // 1回の記録の合計（設計33・本文16KB の余裕）。設計38 からドロップの段も1つと数える
  PAGE: 20,
  BOARD_PAGE: 50,
  //   会員に見せる文（設計35）。表の CHECK と同じ上限
  MEMBER_MESSAGE: 400,
  MEMBER_TODO: 3,
  MEMBER_TODO_CHARS: 60,
  MEMBER_TAGS: 6,
  MEMBER_TAG_CHARS: 12,
};

//   カルテの窓口の版（設計31）。画面はこれが自分の想定以上のときだけ新しい項目を保存する
//   （新しい画面が古い Worker に当たると、新しい項目が黙って捨てられ「保存しました」と出るため・関門②）
//   ★応答で返すのは karteSchemaFor(env, who) の結果だけ。この定数は「この Worker が受け付けられる最大」
export const KARTE_SCHEMA = 33;   // 33＝トレーニングの新しい項目（補助・無理やり・ドロップ・数字の無い種目＝設計38）
const KARTE_SCHEMA_BASE = 32;     // 32＝お客様に見える欄（設計35 C2）。古い Worker に member を送らせない

/**
 * トレーニングの新しい項目を受け付けるか（設計38 §3-7・I72）。判定はこの1か所だけ
 *   KARTE_TRAINING_EXT が厳密に 'on'＝全員／厳密に 'allow'＝KARTE_TRAINING_EXT_TRAINERS に trainer_id が完全一致で載っている人だけ
 *   それ以外（'off'・未設定・打ち間違い・trainer_id が空）は偽＝止まる側に倒れる
 */
export function trainingExtOn(env, who) {
  const mode = String((env && env.KARTE_TRAINING_EXT) || '');
  if (mode === 'on') return true;
  if (mode !== 'allow') return false;
  const tid = String((who && who.trainerId) || '');
  if (!tid) return false;
  const list = String((env && env.KARTE_TRAINING_EXT_TRAINERS) || '').split(',').map((x) => x.trim()).filter((x) => x !== '');
  return list.indexOf(tid) >= 0;
}
/** 応答に載せる窓口の版。切替が偽なら32（画面は新しい項目を出さない・送らない）、真なら33 */
export function karteSchemaFor(env, who) {
  return trainingExtOn(env, who) ? KARTE_SCHEMA : KARTE_SCHEMA_BASE;
}

/**
 * 録音の文字起こしの AI 下書き（設計39・I76）を受け付けるか。判定はこの1か所だけ（trainingExtOn と同じ形）
 *   KARTE_AI_DRAFT が厳密に 'on'＝全員／厳密に 'allow'＝KARTE_AI_DRAFT_TRAINERS に trainer_id が完全一致の人だけ。それ以外は偽
 */
export function aiDraftOn(env, who) {
  const mode = String((env && env.KARTE_AI_DRAFT) || '');
  if (mode === 'on') return true;
  if (mode !== 'allow') return false;
  const tid = String((who && who.trainerId) || '');
  if (!tid) return false;
  const list = String((env && env.KARTE_AI_DRAFT_TRAINERS) || '').split(',').map((x) => x.trim()).filter((x) => x !== '');
  return list.indexOf(tid) >= 0;
}
/** 画面にボタンを出してよいか＝切替が開いていて鍵が登録されている（真偽値だけ返す・鍵の値は出さない） */
export function aiDraftReady(env, who) {
  return aiDraftOn(env, who) && !!(env && env.ANTHROPIC_API_KEY);
}

export function isKarteWrite(action) {
  //   ★k_aiDraft（設計39）は D1 に書かないが、外部へ送り費用がかかる＝Origin の完全一致と iat 1時間の守りを掛ける（runWrite は通らない）
  return /^k_(save|add|edit|delete|record)/.test(String(action || '')) || String(action || '') === 'k_aiDraft';
}

// ---------------------------------------------------------------- 小さな道具
const err = (code, status, detail) => ({ _error: code, _status: status, detail });
const GUARD_CODES = [
  ['KARTE_GUARD_RATE', 'RATE_LIMITED', 429, 'rate_limited'],
  ['KARTE_GUARD_TARGET', 'NOT_FOUND', 404, 'not_found'],
  ['KARTE_GUARD_OWNER', 'FORBIDDEN', 403, 'denied'],
  ['KARTE_GUARD_CONSENT', 'NO_CONSENT', 403, 'no_consent'],
  ['KARTE_GUARD_REV', 'CONFLICT', 409, 'conflict'],
  ['KARTE_GUARD_STATE', 'BAD_STATE', 409, 'conflict'],
  ['KARTE_GUARD_READY', 'BODY_NOT_READY', 409, 'denied'],
];
/** エラー文に既知の制約の名前が**含まれるか**だけを見る。無ければ null（推測しない＝500） */
export function guardOf(e) {
  const msg = String((e && e.message) || e || '');
  for (const g of GUARD_CODES) if (msg.indexOf(g[0]) >= 0) return { code: g[1], status: g[2], log: g[3] };
  return null;
}
const S = (sql, ...args) => ({ sql, args });

function jstToday(nowMs) {
  const d = new Date(Number(nowMs) + 9 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
/** 実在する YYYY-MM-DD か（2026-13-01 や 2026-02-30 を繰り上げで受けない） */
export function isRealDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}
/** 実在し、JST で今日以前 */
export function isPastOrToday(s, nowMs) {
  return isRealDate(s) && String(s) <= jstToday(nowMs || Date.now());
}
function text(v, max) {
  if (v == null || v === '') return null;
  const t = String(v);
  if (t.length > max) throw new RangeError('TOO_LONG');
  return t;
}
function numOrNull(v, min, max, dec) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new RangeError('OUT_OF_RANGE');
  const f = Math.pow(10, dec);
  return Math.round(n * f) / f;
}
async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function newId() { return crypto.randomUUID(); }

// 推定1RM（Epley）。回数1は重量そのもの・13回以上は出さない・重量0は0
export function e1rm(weight, reps) {
  const w = Number(weight), r = Number(reps);
  if (!(w >= 0) || !(r >= 1)) return null;
  if (r > 12) return null;
  if (r === 1) return Math.round(w * 10) / 10;
  return Math.round(w * (1 + r / 30) * 10) / 10;
}

// ---------------------------------------------------------------- 閲覧の範囲
/** 共有の範囲：トレーナー・オーナーで、顧客が実在する */
export async function canSeeKarteShared(env, who, customerId) {
  if (!customerId) return false;
  if (who.role !== 'trainer' && who.role !== 'owner') return false;
  const row = await env.DB.prepare('SELECT 1 AS x FROM customers WHERE customer_id = ?').bind(String(customerId)).first();
  return !!row;
}

// ---------------------------------------------------------------- 記録（best effort）
export async function logAccess(env, who, customerId, section, action, result, reqId) {
  try {
    await env.DB.prepare(
      `INSERT INTO karte_access_log (at, trainer_id, role, customer_id, section, action, result, req_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(Date.now(), String(who.trainerId || ''), String(who.role || ''), customerId ? String(customerId) : null,
           section || null, action, result, reqId || null).run();
  } catch (_) {
    //   ★中身は出さない。書けなかった回数は日次点検で数える（console の件数）
    try { console.error('[karte] access_log write failed', action, result); } catch (_) {}
  }
}

// ---------------------------------------------------------------- 見張りの文
const G = {
  target: (cid) => S(`INSERT INTO karte_guard (target) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM customers WHERE customer_id = ?)`, cid),
  consent: (cid) => S(`INSERT INTO karte_guard (consent) SELECT 1 WHERE NOT EXISTS (
                         SELECT 1 FROM karte_consent WHERE customer_id = ? AND kind = 'health' AND state = 'agreed')`, cid),
  // rev が 0 ＝まだ行が無いはず／1以上＝その rev の行があるはず
  rev: (table, keyCol, key, rev) => (Number(rev) > 0
    ? S(`INSERT INTO karte_guard (rev) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM ${table} WHERE ${keyCol} = ? AND rev = ?)`, key, Number(rev))
    : S(`INSERT INTO karte_guard (rev) SELECT 1 WHERE EXISTS (SELECT 1 FROM ${table} WHERE ${keyCol} = ?)`, key)),
  // 削除されていない行がある（無ければ 404）
  rowLive: (table, idCol, id) => S(`INSERT INTO karte_guard (target) SELECT 1 WHERE NOT EXISTS (
                                      SELECT 1 FROM ${table} WHERE ${idCol} = ? AND deleted_at IS NULL)`, id),
  // 書いた本人かオーナー
  author: (table, idCol, id, authorCol, who) => (who.role === 'owner'
    ? S(`SELECT 1`)
    : S(`INSERT INTO karte_guard (perm) SELECT 1 WHERE NOT EXISTS (
           SELECT 1 FROM ${table} WHERE ${idCol} = ? AND ${authorCol} = ?)`, id, String(who.trainerId || ''))),
  // 担当＋担当なし（オーナーは全員）
  assigned: (cid, who) => (who.role === 'owner'
    ? S(`SELECT 1`)
    : S(`INSERT INTO karte_guard (perm) SELECT 1 WHERE NOT EXISTS (
           SELECT 1 FROM customers WHERE customer_id = ?
              AND (default_trainer_id IS NULL OR default_trainer_id = '' OR default_trainer_id = ?))`,
        cid, String(who.trainerId || ''))),
  // ★会員に見せる枚の顧客・日付が、参照先の生きた session と一致する（設計35 改訂2-4）。違えば batch 全体を戻す
  mnoteMatch: (mnoteId) => S(`INSERT INTO karte_guard (target) SELECT 1 FROM karte_member_notes m
                                WHERE m.mnote_id = ? AND m.session_id IS NOT NULL
                                  AND NOT EXISTS (SELECT 1 FROM karte_tr_sessions s
                                                   WHERE s.session_id = m.session_id AND s.customer_id = m.customer_id
                                                     AND s.session_date = m.session_date AND s.deleted_at IS NULL)`, mnoteId),
  // 体の記録の切り替え（凍結）が済んでいる
  ready: () => S(`INSERT INTO karte_guard (ready) SELECT 1 WHERE NOT EXISTS (
                    SELECT 1 FROM body_freeze WHERE state IN ('frozen', 'copying', 'copied', 'verified'))`),
  // ★トレーニングの1回の形（設計38 §3-3・I65b）。Worker が組んだ行の自己矛盾を batch の最後に確かめる二重の守り
  //   どれか1つでも当たれば BAD_STATE で batch 全体が戻る。NULL を比べる箇所は IS／IS NOT／COALESCE（= は NULL で素通りする）
  //   expect：Worker が数えた行数（本セット・ドロップ・種目）。ドロップは session を持たないので、別の回へ付いたものは数で捕まえる
  trShape: (sid, expect) => S(`WITH p AS (SELECT ? AS sid, ? AS n_sets, ? AS n_drops, ? AS n_ex)
    INSERT INTO karte_guard (state) SELECT 1 FROM p WHERE ${TR_SHAPE_CONDS.map((x) => `(${x[1]})`).join('\n       OR ')}`,
    sid, expect.sets, expect.drops, expect.exercises),
};
//   trShape の条件（設計38 §3-3 の番号）。[名前, 条件]。1行1条件＝1つずつ外して検査が落ちることを確かめられる形にしておく
//   ★条件は重なっている（同じ壊れ方を2つ以上で捕まえる）。どの条件も実際に当たることは検査（karte-training-ext T16c）で確かめる
export const TR_SHAPE_CONDS = [
  // 0 数：本セット・ドロップ・種目が Worker の数えた数と違う（行を落とした・別の回へ付いた）
  ['n_sets', `(SELECT COUNT(*) FROM karte_tr_sets t WHERE t.session_id IS p.sid) IS NOT p.n_sets`],
  ['n_drops', `(SELECT COUNT(*) FROM karte_tr_drops dr JOIN karte_tr_sets t ON t.set_id IS dr.set_id WHERE t.session_id IS p.sid) IS NOT p.n_drops`],
  ['n_ex', `(SELECT COUNT(*) FROM karte_tr_exercises x WHERE x.session_id IS p.sid) IS NOT p.n_ex`],
  // 1 本セットの行数と付加の行数が違う
  ['ext_count', `(SELECT COUNT(*) FROM karte_tr_sets t WHERE t.session_id IS p.sid) IS NOT (SELECT COUNT(*) FROM karte_tr_set_ext e WHERE e.session_id IS p.sid)`],
  // 2 付加の指す先：付加の無い本セット
  ['set_without_ext', `EXISTS (SELECT 1 FROM karte_tr_sets t WHERE t.session_id IS p.sid
             AND NOT EXISTS (SELECT 1 FROM karte_tr_set_ext e WHERE e.set_id IS t.set_id))`],
  //   親の無い付加
  ['ext_without_parent', `EXISTS (SELECT 1 FROM karte_tr_set_ext e WHERE e.session_id IS p.sid
             AND NOT EXISTS (SELECT 1 FROM karte_tr_sets t WHERE t.set_id IS e.set_id))`],
  //   別の session を指す付加（付加の側・本セットの側のどちらから見ても）
  ['ext_other_session', `EXISTS (SELECT 1 FROM karte_tr_set_ext e JOIN karte_tr_sets t ON t.set_id IS e.set_id
            WHERE (e.session_id IS p.sid OR t.session_id IS p.sid)
              AND (t.session_id IS NOT e.session_id OR e.session_id IS NOT p.sid))`],
  //   種目の不一致：付加の (session_id, ord) に種目の行が無い、または本セットの種目名と違う
  ['ext_exercise', `EXISTS (SELECT 1 FROM karte_tr_set_ext e JOIN karte_tr_sets t ON t.set_id IS e.set_id
            WHERE e.session_id IS p.sid
              AND NOT EXISTS (SELECT 1 FROM karte_tr_exercises x
                               WHERE x.session_id IS e.session_id AND x.ord IS e.ord AND x.exercise IS t.exercise))`],
  // 3 ord が1からの連続でない（種目の行が無い回も当たる＝新しい回が古い回として読まれない）
  //   （GROUP BY の無い HAVING は古い SQLite で通らないので、数・最大・最小をそれぞれ引く）
  ['ord_seq', `(SELECT COUNT(*) FROM karte_tr_exercises x WHERE x.session_id IS p.sid) = 0
     OR (SELECT COUNT(*) FROM karte_tr_exercises x WHERE x.session_id IS p.sid) IS NOT (SELECT MAX(x.ord) FROM karte_tr_exercises x WHERE x.session_id IS p.sid)
     OR (SELECT MIN(x.ord) FROM karte_tr_exercises x WHERE x.session_id IS p.sid) IS NOT 1`],
  // 4 本セットの set_no が ord の中で重複している、または1からの連続でない
  ['set_no_seq', `EXISTS (SELECT 1 FROM karte_tr_set_ext e JOIN karte_tr_sets t ON t.set_id IS e.set_id WHERE e.session_id IS p.sid
           GROUP BY e.ord HAVING COUNT(*) IS NOT COUNT(DISTINCT t.set_no) OR MAX(t.set_no) IS NOT COUNT(*))`],
  // 5 done_only の値：数字の無い種目に本セットがある／数字の無い種目でないのに本セットが無い
  ['done_with_sets', `EXISTS (SELECT 1 FROM karte_tr_exercises x WHERE x.session_id IS p.sid AND COALESCE(x.done_only, 0) = 1
             AND EXISTS (SELECT 1 FROM karte_tr_set_ext e WHERE e.session_id IS x.session_id AND e.ord IS x.ord))`],
  ['sets_missing', `EXISTS (SELECT 1 FROM karte_tr_exercises x WHERE x.session_id IS p.sid AND x.done_only IS NULL
             AND NOT EXISTS (SELECT 1 FROM karte_tr_set_ext e WHERE e.session_id IS x.session_id AND e.ord IS x.ord))`],
  // 6 ドロップの段が親ごとに1からの連続でない（親が別の回の本セットになったものは n_drops の数で捕まえる）
  ['drop_seq', `EXISTS (SELECT 1 FROM karte_tr_drops dr JOIN karte_tr_sets t ON t.set_id IS dr.set_id WHERE t.session_id IS p.sid
           GROUP BY dr.set_id HAVING COUNT(*) IS NOT MAX(dr.drop_seq) OR MIN(dr.drop_seq) IS NOT 1)`],
  // 7 合計（本セット＋ドロップ）が60を超える／ord が20を超える（CHECK と Worker の検査に加えて三重目）
  ['total', `(SELECT COUNT(*) FROM karte_tr_sets t WHERE t.session_id IS p.sid)
     + (SELECT COUNT(*) FROM karte_tr_drops dr JOIN karte_tr_sets t ON t.set_id IS dr.set_id WHERE t.session_id IS p.sid) > ${KARTE_LIMITS.TOTAL_SETS}`],
  ['ord_max', `COALESCE((SELECT MAX(x.ord) FROM karte_tr_exercises x WHERE x.session_id IS p.sid), 0) > ${KARTE_LIMITS.EXERCISES}`],
];

// ---------------------------------------------------------------- 書き込みの流れ
async function readReq(env, tid, action, crid) {
  return env.DB.prepare(
    `SELECT payload_hash, http_status, result_code, result_json FROM karte_requests
      WHERE trainer_id = ? AND action = ? AND client_req_id = ?`
  ).bind(tid, action, crid).first();
}
//   alt：保存済みの行と照合してよい旧いハッシュ（設計38 §3-4。条件を満たす要求のときだけ runWrite が渡す）
function replay(prev, hash, alt) {
  if (prev.payload_hash !== hash && !(alt || []).includes(prev.payload_hash)) return err('REQ_REUSED', 409);
  let r = {};
  try { r = prev.result_json ? JSON.parse(prev.result_json) : {}; } catch (_) { r = {}; }
  return { ...r, replayed: true };
}

/**
 * spec = { action, customerId, payload, plan(now) → { stmts:[{sql,args}], result:{…}（安全な項目だけ）, resultSql?:'…' } }
 *   altPayloads?：保存済みの行と照合してもよい旧い形のハッシュの元（保存するのは常に payload のハッシュ・設計38 §3-4）
 *   extUsed?   ：トレーニングの新しい項目を使っている（切替が偽なら replay の後・回数の前に 409・設計38 §3-7）
 */
async function runWrite(c, spec) {
  const { env, who, body } = c;
  const crid = String(body.clientReqId || '');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(crid)) return err('BAD_REQUEST', 400, 'clientReqId');
  const tid = String(who.trainerId || '');
  if (!tid) return err('FORBIDDEN', 403);
  const hash = await sha256(JSON.stringify(spec.payload));
  const alt = [];
  for (const p of (spec.altPayloads || [])) alt.push(await sha256(JSON.stringify(p)));

  //   ① 同じ要求が既に完了していれば、保存した成功を返す（本体を読み直さない）
  const prev = await readReq(env, tid, spec.action, crid);
  if (prev) return replay(prev, hash, alt);

  //   ①-2 新しい項目の受付（設計38 §3-7）。★replay より後：on で保存できた要求を off の後に送り直しても「保存できていない」と伝えない
  //        回数の先行 batch より前：何も書かない。どのトレーナーが許可されているかは返さない
  if (spec.extUsed && !trainingExtOn(env, who)) {
    await logAccess(env, who, spec.customerId, spec.section, spec.action, 'denied', crid);
    return err('TRAINING_EXT_OFF', 409);
  }

  //   ② 回数（本体とは別の先行 batch。通ったら1回を消費し、本体が失敗しても戻さない）
  const win = Math.floor(Date.now() / KARTE_LIMITS.WINDOW_MS) * KARTE_LIMITS.WINDOW_MS;
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO karte_rate (trainer_id, window_start, n) VALUES (?, ?, 1)
                      ON CONFLICT(trainer_id, window_start) DO UPDATE SET n = n + 1`).bind(tid, win),
      env.DB.prepare(`INSERT INTO karte_guard (rate) SELECT 1 WHERE
                        (SELECT n FROM karte_rate WHERE trainer_id = ? AND window_start = ?) > ?`)
        .bind(tid, win, KARTE_LIMITS.RATE_PER_WINDOW),
    ]);
  } catch (e) {
    const g = guardOf(e);
    await logAccess(env, who, spec.customerId, spec.section, spec.action, g ? g.log : 'error', crid);
    return g ? err(g.code, g.status) : err('INTERNAL', 500);
  }

  //   ③ 本体（全部か無か）。最後に karte_requests
  const now = Date.now();
  let plan;
  try { plan = spec.plan(now); } catch (e) { return err('BAD_REQUEST', 400, e && e.message); }
  const resultJson = JSON.stringify(plan.result || {});
  const reqSql = plan.resultSql
    ? S(`INSERT INTO karte_requests (trainer_id, action, client_req_id, payload_hash, http_status, result_code, result_json, done_at)
         VALUES (?, ?, ?, ?, 200, 'OK', ${plan.resultSql}, ?)`, tid, spec.action, crid, hash, now)
    : S(`INSERT INTO karte_requests (trainer_id, action, client_req_id, payload_hash, http_status, result_code, result_json, done_at)
         VALUES (?, ?, ?, ?, 200, 'OK', ?, ?)`, tid, spec.action, crid, hash, resultJson, now);
  const stmts = plan.stmts.concat([reqSql]);
  try {
    await env.DB.batch(stmts.map((x) => env.DB.prepare(x.sql).bind(...x.args)));
  } catch (e) {
    const g = guardOf(e);
    if (g) {
      await logAccess(env, who, spec.customerId, spec.section, spec.action, g.log, crid);
      return err(g.code, g.status);
    }
    //   並行して同じ鍵が先に完了した＝引き直して同じ判定
    if (/karte_requests/.test(String(e && e.message))) {
      const p2 = await readReq(env, tid, spec.action, crid);
      if (p2) return replay(p2, hash, alt);
    }
    await logAccess(env, who, spec.customerId, spec.section, spec.action, 'error', crid);
    try { console.error('[karte] write failed', spec.action); } catch (_) {}
    return err('INTERNAL', 500);
  }
  await logAccess(env, who, spec.customerId, spec.section, spec.action, 'ok', crid);
  if (plan.resultSql) {
    const saved = await readReq(env, tid, spec.action, crid);
    try { return saved && saved.result_json ? JSON.parse(saved.result_json) : {}; } catch (_) { return {}; }
  }
  return plan.result || {};
}

function cidOf(body) { return String(body.customerId || ''); }

// ================================================================ 書き込み
//   ★要求に鍵が無い列は変えない（古い画面＝キャッシュからの保存で、新しい項目を消さない・設計31 関門①1）
//     null・空は「消す」。鍵が無いときだけ「そのまま」
function dateOrNull(v) {
  if (v == null || v === '') return null;
  if (!isRealDate(v)) throw new RangeError('BAD_DATE');
  return String(v);
}
const PROFILE_COLS = [
  ['goal_text', 'goalText', (v) => text(v, KARTE_LIMITS.TEXT_CHARS)],
  ['goal_value', 'goalValue', (v) => numOrNull(v, -1000, 1000, 1)],
  ['goal_unit', 'goalUnit', (v) => text(v, 20)],
  ['goal_deadline', 'goalDeadline', dateOrNull],
  ['motive', 'motive', (v) => text(v, KARTE_LIMITS.TEXT_CHARS)],
  ['history', 'history', (v) => text(v, KARTE_LIMITS.TEXT_CHARS)],
  ['hearing_json', 'hearing', normalizeHearing],
];
const SAFETY_COLS = [
  ['conditions', 'conditions', (v) => text(v, KARTE_LIMITS.TEXT_CHARS)],
  ['injuries', 'injuries', (v) => text(v, KARTE_LIMITS.TEXT_CHARS)],
  ['pain_sites', 'painSites', (v) => text(v, KARTE_LIMITS.TEXT_CHARS)],
  ['medication', 'medication', (v) => text(v, KARTE_LIMITS.TEXT_CHARS)],
  ['restrictions', 'restrictions', (v) => text(v, KARTE_LIMITS.TEXT_CHARS)],
  ['pain_json', 'painMap', normalizePainMap],
  ['diagnosis', 'diagnosis', (v) => text(v, KARTE_LIMITS.TEXT_CHARS)],
];
/** 要求から、鍵がある列だけ読む。{ values:{col:値}, present:{col:true} } */
export function readPresent(body, cols) {
  const values = {}, present = {};
  for (const [col, key, fn] of cols) {
    if (!has(body, key)) continue;
    values[col] = fn(body[key]);
    present[col] = true;
  }
  if (!Object.keys(present).length) throw new RangeError('EMPTY');
  return { values, present };
}
/** INSERT の値・ON CONFLICT で「鍵があった列だけ置き換える」SET 句 */
function upsertParts(table, cols, f) {
  const names = cols.map((x) => x[0]);
  return {
    names: names.join(', '),
    marks: names.map(() => '?').join(', '),
    vals: names.map((n) => (f.present[n] ? f.values[n] : null)),
    sets: names.map((n) => `${n} = CASE WHEN ? = 1 THEN excluded.${n} ELSE ${table}.${n} END`).join(', '),
    flags: names.map((n) => (f.present[n] ? 1 : 0)),
  };
}

async function saveProfile(c) {
  const cid = cidOf(c.body);
  if (!(await canSeeKarteShared(c.env, c.who, cid))) return err('NOT_FOUND', 404);
  const b = c.body;
  let f;
  try { f = readPresent(b, PROFILE_COLS); } catch (e) { return err('BAD_REQUEST', 400, e.message); }
  const rev = Number(b.rev || 0);
  const tid = String(c.who.trainerId || '');
  const u = upsertParts('karte_profile', PROFILE_COLS, f);
  return runWrite(c, {
    action: 'k_saveProfile', section: 'profile', customerId: cid, payload: { cid, f, rev },
    plan: (now) => ({
      stmts: [
        G.target(cid),
        G.rev('karte_profile', 'customer_id', cid, rev),
        //   ★控えにヒアリングの自由文は入れない（選択肢と数値だけ・関門①4）
        S(`INSERT INTO karte_revisions (table_name, row_id, rev, before_json, changed_by, changed_at)
           SELECT 'karte_profile', customer_id, rev,
                  json_object('goal_text', goal_text, 'goal_value', goal_value, 'goal_unit', goal_unit,
                              'goal_deadline', goal_deadline, 'motive', motive, 'history', history,
                              'hearing', ${HEARING_REVISION_SQL}), ?, ?
             FROM karte_profile WHERE customer_id = ?`, tid, now, cid),
        S(`INSERT INTO karte_profile (customer_id, ${u.names}, rev, updated_by, updated_at)
           VALUES (?, ${u.marks}, 1, ?, ?)
           ON CONFLICT(customer_id) DO UPDATE SET ${u.sets},
             rev = karte_profile.rev + 1, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
          cid, ...u.vals, tid, now, ...u.flags),
      ],
      result: { rev: rev + 1 },
    }),
  });
}

async function saveConsent(c) {
  const cid = cidOf(c.body);
  if (!(await canSeeKarteShared(c.env, c.who, cid))) return err('NOT_FOUND', 404);
  const state = String(c.body.state || '');
  const method = c.body.method == null ? null : String(c.body.method);
  if (state !== 'agreed' && state !== 'revoked') return err('BAD_REQUEST', 400, 'state');
  if (method !== null && method !== 'paper' && method !== 'line') return err('BAD_REQUEST', 400, 'method');
  const tid = String(c.who.trainerId || '');
  return runWrite(c, {
    action: 'k_saveConsent', section: 'consent', customerId: cid, payload: { cid, state, method },
    plan: (now) => {
      const stmts = [
        G.target(cid),
        S(`INSERT INTO karte_consent (customer_id, kind, state, changed_at, method, recorded_by)
           VALUES (?, 'health', ?, ?, ?, ?)
           ON CONFLICT(customer_id, kind) DO UPDATE SET state = excluded.state, changed_at = excluded.changed_at,
             method = excluded.method, recorded_by = excluded.recorded_by`, cid, state, now, method, tid),
        S(`INSERT INTO karte_consent_log (customer_id, kind, state, at, method, recorded_by)
           VALUES (?, 'health', ?, ?, ?, ?)`, cid, state, now, method, tid),
      ];
      //   ★撤回は同じ batch で安全面の中身を消す（再同意しても戻らない＝聞き取り直す）
      if (state === 'revoked') stmts.push(S(`DELETE FROM karte_safety WHERE customer_id = ?`, cid));
      return { stmts, result: { state } };
    },
  });
}

async function saveSafety(c) {
  const cid = cidOf(c.body);
  if (!(await canSeeKarteShared(c.env, c.who, cid))) return err('NOT_FOUND', 404);
  const b = c.body;
  let f;
  try { f = readPresent(b, SAFETY_COLS); } catch (e) { return err('BAD_REQUEST', 400, e.message); }
  const rev = Number(b.rev || 0);
  const tid = String(c.who.trainerId || '');
  const u = upsertParts('karte_safety', SAFETY_COLS, f);
  return runWrite(c, {
    //   ★payload の hash には中身が入るが、karte_requests に保存するのは hash と rev だけ。控え（revisions）にも入れない
    action: 'k_saveSafety', section: 'safety', customerId: cid, payload: { cid, f, rev },
    plan: (now) => ({
      stmts: [
        G.target(cid),
        G.consent(cid),
        G.rev('karte_safety', 'customer_id', cid, rev),
        //   ★書く文そのものにも同意を条件にする（見張りと二重。どちらかが抜けても書かない）
        S(`INSERT INTO karte_safety (customer_id, ${u.names}, source, rev, updated_by, updated_at)
           SELECT ?, ${u.marks}, 'trainer', 1, ?, ?
            WHERE EXISTS (SELECT 1 FROM karte_consent WHERE customer_id = ? AND kind = 'health' AND state = 'agreed')
           ON CONFLICT(customer_id) DO UPDATE SET ${u.sets},
             source = 'trainer', rev = karte_safety.rev + 1, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
          cid, ...u.vals, tid, now, cid, ...u.flags),
      ],
      result: { rev: rev + 1 },
    }),
  });
}

async function addNote(c) {
  const cid = cidOf(c.body);
  if (!(await canSeeKarteShared(c.env, c.who, cid))) return err('NOT_FOUND', 404);
  const b = c.body, L = KARTE_LIMITS;
  let f;
  try {
    if (!isPastOrToday(b.sessionDate)) throw new RangeError('BAD_DATE');
    const cond = b.condition == null || b.condition === '' ? null : String(b.condition);
    if (cond !== null && !['good', 'normal', 'bad'].includes(cond)) throw new RangeError('BAD_CONDITION');
    f = { session_date: String(b.sessionDate), condition: cond, body: text(b.body, L.NOTE_CHARS), next_plan: text(b.nextPlan, L.TEXT_CHARS),
          tag: normalizeTag(b.tag), reasons_json: normalizeReasons(b.reasons), next_check: text(b.nextCheck, L.TEXT_CHARS) };
    if (!f.body && !f.next_plan && !f.condition && !f.reasons_json && !f.next_check) throw new RangeError('EMPTY');
  } catch (e) { return err('BAD_REQUEST', 400, e.message); }
  const tid = String(c.who.trainerId || '');
  const id = newId();
  return runWrite(c, {
    action: 'k_addNote', section: 'notes', customerId: cid, payload: { cid, f },
    plan: (now) => ({
      stmts: [
        G.target(cid),
        S(`INSERT INTO karte_notes (note_id, customer_id, session_date, condition, body, next_plan, tag, reasons_json, next_check, author_trainer_id, rev, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`, id, cid, f.session_date, f.condition, f.body, f.next_plan, f.tag, f.reasons_json, f.next_check, tid, now),
      ],
      result: { noteId: id, rev: 1 },
    }),
  });
}

async function noteCustomer(env, noteId) {
  const r = await env.DB.prepare('SELECT customer_id FROM karte_notes WHERE note_id = ?').bind(String(noteId)).first();
  return r ? String(r.customer_id) : '';
}

async function editNote(c) {
  const b = c.body, L = KARTE_LIMITS;
  const noteId = String(b.noteId || '');
  const cid = await noteCustomer(c.env, noteId);
  if (!cid || !(await canSeeKarteShared(c.env, c.who, cid))) return err('NOT_FOUND', 404);
  let f;
  try {
    const cond = b.condition == null || b.condition === '' ? null : String(b.condition);
    if (cond !== null && !['good', 'normal', 'bad'].includes(cond)) throw new RangeError('BAD_CONDITION');
    f = { condition: cond, body: text(b.body, L.NOTE_CHARS), next_plan: text(b.nextPlan, L.TEXT_CHARS),
          //   ★新しい列は鍵があるときだけ変える（古い画面の編集で消さない）
          tag: has(b, 'tag') ? normalizeTag(b.tag) : undefined,
          reasons_json: has(b, 'reasons') ? normalizeReasons(b.reasons) : undefined,
          next_check: has(b, 'nextCheck') ? text(b.nextCheck, L.TEXT_CHARS) : undefined };
  } catch (e) { return err('BAD_REQUEST', 400, e.message); }
  const rev = Number(b.rev || 0);
  if (!(rev > 0)) return err('BAD_REQUEST', 400, 'rev');
  const keep = (k) => (f[k] === undefined ? 0 : 1);
  const tid = String(c.who.trainerId || '');
  const reason = c.who.role === 'owner' ? text(b.reason, L.TEXT_CHARS) : null;
  return runWrite(c, {
    action: 'k_editNote', section: 'notes', customerId: cid, payload: { noteId, f, rev, reason },
    plan: (now) => ({
      stmts: [
        G.rowLive('karte_notes', 'note_id', noteId),
        G.author('karte_notes', 'note_id', noteId, 'author_trainer_id', c.who),
        G.rev('karte_notes', 'note_id', noteId, rev),
        S(`INSERT INTO karte_revisions (table_name, row_id, rev, before_json, changed_by, changed_at, reason)
           SELECT 'karte_notes', note_id, rev, json_object('condition', condition, 'body', body, 'next_plan', next_plan, 'tag', tag, 'reasons', reasons_json, 'next_check', next_check), ?, ?, ?
             FROM karte_notes WHERE note_id = ?`, tid, now, reason, noteId),
        S(`UPDATE karte_notes SET condition = ?, body = ?, next_plan = ?,
              tag = CASE WHEN ? = 1 THEN ? ELSE tag END,
              reasons_json = CASE WHEN ? = 1 THEN ? ELSE reasons_json END,
              next_check = CASE WHEN ? = 1 THEN ? ELSE next_check END,
              rev = rev + 1, edited_at = ?, edited_by = ?
            WHERE note_id = ? AND rev = ? AND deleted_at IS NULL`, f.condition, f.body, f.next_plan,
          keep('tag'), f.tag === undefined ? null : f.tag, keep('reasons_json'), f.reasons_json === undefined ? null : f.reasons_json,
          keep('next_check'), f.next_check === undefined ? null : f.next_check, now, tid, noteId, rev),
      ],
      result: { noteId, rev: rev + 1 },
    }),
  });
}

async function deleteNote(c) {
  const b = c.body;
  const noteId = String(b.noteId || '');
  const cid = await noteCustomer(c.env, noteId);
  if (!cid || !(await canSeeKarteShared(c.env, c.who, cid))) return err('NOT_FOUND', 404);
  const rev = Number(b.rev || 0);
  if (!(rev > 0)) return err('BAD_REQUEST', 400, 'rev');
  let reason = null;
  try { reason = text(b.reason, KARTE_LIMITS.TEXT_CHARS); } catch (e) { return err('BAD_REQUEST', 400, e.message); }
  const tid = String(c.who.trainerId || '');
  return runWrite(c, {
    action: 'k_deleteNote', section: 'notes', customerId: cid, payload: { noteId, rev, reason },
    plan: (now) => ({
      stmts: [
        G.rowLive('karte_notes', 'note_id', noteId),
        G.author('karte_notes', 'note_id', noteId, 'author_trainer_id', c.who),
        G.rev('karte_notes', 'note_id', noteId, rev),
        S(`INSERT INTO karte_revisions (table_name, row_id, rev, before_json, changed_by, changed_at, reason)
           SELECT 'karte_notes', note_id, rev, json_object('condition', condition, 'body', body, 'next_plan', next_plan, 'tag', tag, 'reasons', reasons_json, 'next_check', next_check), ?, ?, ?
             FROM karte_notes WHERE note_id = ?`, tid, now, reason, noteId),
        S(`UPDATE karte_notes SET deleted_at = ?, deleted_by = ?, rev = rev + 1 WHERE note_id = ? AND rev = ?`, now, tid, noteId, rev),
      ],
      result: { noteId, deleted: true },
    }),
  });
}

//   トレーニングの要求の鍵（設計38 §3-3）。★知らない鍵は 400（SET_KEY）。古い画面が送る鍵（exercise・sets／weight・reps・note）は全部ここにある
const TR_ITEM_KEYS = ['exercise', 'sets', 'doneOnly'];
const TR_SET_KEYS = ['weight', 'reps', 'note', 'assist', 'forced', 'drops'];
const TR_DROP_KEYS = ['weight', 'reps', 'assist', 'forced'];   // drop に note・drops は持たない
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
function onlyKeys(o, keys) {
  for (const k of Object.keys(o)) if (keys.indexOf(k) < 0) throw new RangeError('SET_KEY');
}
/** 新しい鍵（doneOnly・assist・forced・drops）を1つでも使っているか。★鍵があれば値に関わらず「使っている」（ドロップの中の鍵は drops がある時点で使っている） */
export function trainingExtUsed(items) {
  return (Array.isArray(items) ? items : []).some((it) => has(it, 'doneOnly')
    || (Array.isArray(it && it.sets) && it.sets.some((st) => has(st, 'assist') || has(st, 'forced') || has(st, 'drops'))));
}
/** 新しい鍵を使う要求の重さ：0.1 刻みでなければ丸めずに 400（設計38 §3-3。古い形の要求は今までどおり numOrNull で丸める） */
function weightStrict(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 500) throw new RangeError('OUT_OF_RANGE');
  if (Math.abs(n * 10 - Math.round(n * 10)) > 1e-9) throw new RangeError('SET_VALUE');
  return Math.round(n * 10) / 10;
}
function repsOf(v) {
  const r = Number(v);
  if (!Number.isInteger(r) || r < 1 || r > 100) throw new RangeError('SET_VALUE');
  return r;
}
//   補助は 1〜100 の整数だけ・無理やりは true だけ（false・1・"true" は 400）。鍵が無ければ印なし＝null
function assistOf(o) {
  if (!has(o, 'assist')) return null;
  if (!Number.isInteger(o.assist) || o.assist < 1 || o.assist > KARTE_LIMITS.ASSIST_MAX) throw new RangeError('SET_VALUE');
  return o.assist;
}
function forcedOf(o) {
  if (!has(o, 'forced')) return null;
  if (o.forced !== true) throw new RangeError('SET_VALUE');
  return 1;
}

/**
 * トレーニングの要求を行の形に直す（設計38 §3-3）。種目の並び i を ord、ord の中の本セットの並びを set_no、ドロップの並びを drop_seq
 *   返す値：{ extUsed, items:[{ exercise, done_only, sets:[{ set_no, weight_kg, reps, note, assist_reps, forced, drops:[…] }] }], total }
 *   不正は RangeError（理由の鍵）。合計の上限（TOTAL_SETS）は呼ぶ側が専用のコードで返す
 */
export function normalizeTraining(rawItems) {
  const L = KARTE_LIMITS;
  const items = Array.isArray(rawItems) ? rawItems : [];
  if (!items.length || items.length > L.EXERCISES) throw new RangeError('ITEMS');
  const extUsed = trainingExtUsed(items);
  const weightOf = (v) => (extUsed ? weightStrict(v) : numOrNull(v, 0, 500, 1));
  const out = [];
  let total = 0;
  for (const it of items) {
    if (isObj(it)) onlyKeys(it, TR_ITEM_KEYS);
    const ex = text(it && it.exercise, 50);
    if (!ex) throw new RangeError('EXERCISE');
    //   ★種目の並びの表は前後に空白を持たない（CHECK）。画面は trim して送る＝前後に空白のある名前は 400 にする（黙って直さない）
    if (ex !== ex.trim()) throw new RangeError('EXERCISE');
    const ss = Array.isArray(it.sets) ? it.sets : [];
    let doneOnly = null;
    if (has(it, 'doneOnly')) {
      if (it.doneOnly !== true || ss.length) throw new RangeError('DONE_ONLY');   // doneOnly は sets:[] のときだけ
      doneOnly = 1;
    } else if (!ss.length) throw new RangeError('SETS');
    if (ss.length > L.SETS_PER_EXERCISE) throw new RangeError('SETS');
    const sets = ss.map((st, i) => {
      if (isObj(st)) onlyKeys(st, TR_SET_KEYS);
      const w = weightOf(st && st.weight);
      if (w === null) throw new RangeError('SET_VALUE');
      const r = repsOf(st && st.reps);
      const assist = assistOf(st), forced = forcedOf(st);
      let drops = [];
      if (has(st, 'drops')) {
        if (!Array.isArray(st.drops) || st.drops.length > L.DROPS_PER_SET) throw new RangeError('DROPS');
        drops = st.drops.map((dp, k) => {
          if (!isObj(dp)) throw new RangeError('SET_VALUE');
          onlyKeys(dp, TR_DROP_KEYS);
          const dw = weightStrict(dp.weight);
          if (dw === null) throw new RangeError('SET_VALUE');
          return { drop_seq: k + 1, weight_kg: dw, reps: repsOf(dp.reps), assist_reps: assistOf(dp), forced: forcedOf(dp) };
        });
      }
      total += 1 + drops.length;
      return { set_no: i + 1, weight_kg: w, reps: r, note: text(st.note, 200), assist_reps: assist, forced, drops };
    });
    out.push({ exercise: ex, done_only: doneOnly, sets });
  }
  return { extUsed, items: out, total };
}
/** 新しいハッシュの元（設計38 §3-4）。新しい鍵は値があるときだけ載せる */
function trainingHashItems(items) {
  return items.map((it) => {
    const o = { exercise: it.exercise };
    if (it.done_only) o.doneOnly = true;
    o.sets = it.sets.map((s) => {
      const so = { weight_kg: s.weight_kg, reps: s.reps, note: s.note };
      if (s.assist_reps != null) so.assist = s.assist_reps;
      if (s.forced) so.forced = true;
      if (s.drops.length) {
        so.drops = s.drops.map((d) => {
          const dob = { weight_kg: d.weight_kg, reps: d.reps };
          if (d.assist_reps != null) dob.assist = d.assist_reps;
          if (d.forced) dob.forced = true;
          return dob;
        });
      }
      return so;
    });
    return o;
  });
}

async function addTraining(c) {
  const cid = cidOf(c.body);
  if (!(await canSeeKarteShared(c.env, c.who, cid))) return err('NOT_FOUND', 404);
  const b = c.body, L = KARTE_LIMITS;
  let tr;
  try {
    if (!isPastOrToday(b.sessionDate)) throw new RangeError('BAD_DATE');
    tr = normalizeTraining(b.items);
  } catch (e) { return err('BAD_REQUEST', 400, e.message); }
  //   ★合計の上限は正規化の後に数える。専用のコードで返す（画面が「合計60セットまで」と出せるように・関門①）。設計38 からドロップの段も数える
  if (tr.total > L.TOTAL_SETS) return err('TOTAL_SETS', 400);
  //   お客様に見える欄（設計35 改訂1-2）。正規化してハッシュに必ず含める（無ければ null・改訂2-5）
  let member;
  try { member = has(b, 'member') ? normalizeMember(b.member) : null; } catch (e) { return err('BAD_REQUEST', 400, e.message); }
  const tid = String(c.who.trainerId || '');
  const sid = newId();
  const mid = member ? newId() : null;
  const date = String(b.sessionDate);
  //   旧ハッシュ（設計38 より前の {cid, date, sets, member}）。照合してよいのは、新しい鍵を使わず、
  //   同じ種目名が2つ以上の種目に無い要求だけ（旧ハッシュは種目の境目を持たない＝曖昧なら 409・I69）
  const names = tr.items.map((x) => x.exercise);
  const oldOk = !tr.extUsed && new Set(names).size === names.length;
  const oldSets = [];
  for (const it of tr.items) for (const s of it.sets) oldSets.push({ exercise: it.exercise, set_no: s.set_no, weight_kg: s.weight_kg, reps: s.reps, note: s.note });
  let nSets = 0, nDrops = 0;
  for (const it of tr.items) for (const s of it.sets) { nSets++; nDrops += s.drops.length; }
  //   親の指し方：本セットの INSERT の直後に、その回の最大の set_id（＝直前に入れた行）を引く。
  //   見えなければ MAX は NULL＝付加・ドロップの NOT NULL で batch 全体が失敗する（黙って誤った親を指さない・設計38 §3-1・§11-1）
  const parent = `FROM karte_tr_sets WHERE session_id = ?`;
  const rows = [];
  tr.items.forEach((it, i) => {
    const ord = i + 1;
    rows.push(S(`INSERT INTO karte_tr_exercises (session_id, ord, exercise, done_only) VALUES (?, ?, ?, ?)`, sid, ord, it.exercise, it.done_only));
    for (const x of it.sets) {
      rows.push(S(`INSERT INTO karte_tr_sets (session_id, exercise, set_no, weight_kg, reps, note)
                   VALUES (?, ?, ?, ?, ?, ?)`, sid, it.exercise, x.set_no, x.weight_kg, x.reps, x.note));
      rows.push(S(`INSERT INTO karte_tr_set_ext (set_id, session_id, ord, assist_reps, forced)
                   SELECT MAX(set_id), ?, ?, ?, ? ${parent}`, sid, ord, x.assist_reps, x.forced, sid));
      for (const dp of x.drops) {
        rows.push(S(`INSERT INTO karte_tr_drops (set_id, drop_seq, weight_kg, reps, assist_reps, forced)
                     SELECT MAX(set_id), ?, ?, ?, ?, ? ${parent}`, dp.drop_seq, dp.weight_kg, dp.reps, dp.assist_reps, dp.forced, sid));
      }
    }
  });
  return runWrite(c, {
    action: 'k_addTraining', section: 'training', customerId: cid,
    payload: { v: 2, cid, date, items: trainingHashItems(tr.items), member },
    altPayloads: oldOk ? [{ cid, date, sets: oldSets, member }] : [],
    extUsed: tr.extUsed,
    plan: (now) => ({
      stmts: [
        G.target(cid),
        S(`INSERT INTO karte_tr_sessions (session_id, customer_id, session_date, author_trainer_id, rev, created_at)
           VALUES (?, ?, ?, ?, 1, ?)`, sid, cid, date, tid, now),
        //   ★古い形の要求も3つの表に行を作る（ord は並び・印なし）＝新しい回の読み方を1つにする（設計38 §3-3）
        ...rows,
        //   ★同じ batch で枚を書く＝トレーニングと全部か無か（作成者は送ったトレーナー・改訂2-2）
        ...(member ? [
          S(`INSERT INTO karte_member_notes (mnote_id, customer_id, session_id, session_date, message, todo_json, tags_json,
                                             author_trainer_id, rev, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`, mid, cid, sid, date, member.message, member.todo_json, member.tags_json, tid, now, now),
          G.mnoteMatch(mid),
        ] : []),
        G.trShape(sid, { sets: nSets, drops: nDrops, exercises: tr.items.length }),
      ],
      result: member ? { sessionId: sid, rev: 1, mnoteId: mid, mnoteRev: 1 } : { sessionId: sid, rev: 1 },
    }),
  });
}

async function deleteTraining(c) {
  const b = c.body;
  const sid = String(b.sessionId || '');
  const r = await c.env.DB.prepare('SELECT customer_id FROM karte_tr_sessions WHERE session_id = ?').bind(sid).first();
  const cid = r ? String(r.customer_id) : '';
  if (!cid || !(await canSeeKarteShared(c.env, c.who, cid))) return err('NOT_FOUND', 404);
  const rev = Number(b.rev || 0);
  if (!(rev > 0)) return err('BAD_REQUEST', 400, 'rev');
  const tid = String(c.who.trainerId || '');
  return runWrite(c, {
    action: 'k_deleteTraining', section: 'training', customerId: cid, payload: { sid, rev },
    plan: (now) => ({
      stmts: [
        G.rowLive('karte_tr_sessions', 'session_id', sid),
        G.author('karte_tr_sessions', 'session_id', sid, 'author_trainer_id', c.who),
        G.rev('karte_tr_sessions', 'session_id', sid, rev),
        S(`UPDATE karte_tr_sessions SET deleted_at = ?, deleted_by = ?, rev = rev + 1 WHERE session_id = ? AND rev = ?`, now, tid, sid, rev),
        //   ★同じ session の生きた「お客様へ」も同じ batch で論理削除（片方だけ残らない・設計35 改訂2-1）
        S(`UPDATE karte_member_notes SET deleted_at = ?, deleted_by = ?, rev = rev + 1, updated_at = ?
            WHERE session_id = ? AND deleted_at IS NULL`, now, tid, now, sid),
      ],
      result: { sessionId: sid, deleted: true },
    }),
  });
}

// ================================================================ 会員に見せる文（設計35）
/**
 * お客様に見える欄を正規化する（改訂2-5）。中身が全部空なら null（＝枚を作らない）
 *   message：前後の空白を落とし、空は null・400字まで
 *   todo・tags：文字の配列。前後の空白を落とし空要素を捨てる・空配列は null。件数と字数の上限
 *   知らない鍵・型違い・上限超えは RangeError（400）
 */
export function normalizeMember(m) {
  if (m == null) return null;
  const f = normalizeMemberFields(m);
  if (f.message === null && f.todo_json === null && f.tags_json === null) return null;
  return f;
}
/** 項目ごとの正規化だけ（全部空でも null にしない）。編集で「1項目だけ消す」に使う */
function normalizeMemberFields(m) {
  if (typeof m !== 'object' || Array.isArray(m)) throw new RangeError('MEMBER');
  for (const k of Object.keys(m)) if (!['message', 'todo', 'tags'].includes(k)) throw new RangeError('MEMBER_KEY');
  const L = KARTE_LIMITS;
  let message = null;
  if (m.message != null) {
    if (typeof m.message !== 'string') throw new RangeError('MESSAGE');
    const t = m.message.trim();
    if (t.length > L.MEMBER_MESSAGE) throw new RangeError('MESSAGE_TOO_LONG');
    message = t === '' ? null : t;
  }
  const list = (v, maxN, maxChars, code) => {
    if (v == null) return null;
    if (!Array.isArray(v)) throw new RangeError(code);
    const out = [];
    for (const x of v) {
      if (x == null) continue;
      if (typeof x !== 'string') throw new RangeError(code);
      const t = x.trim();
      if (t === '') continue;
      if (t.length > maxChars) throw new RangeError(code + '_TOO_LONG');
      out.push(t);
    }
    if (out.length > maxN) throw new RangeError(code + '_TOO_MANY');
    return out.length ? out : null;
  };
  const todo = list(m.todo, L.MEMBER_TODO, L.MEMBER_TODO_CHARS, 'TODO');
  const tags = list(m.tags, L.MEMBER_TAGS, L.MEMBER_TAG_CHARS, 'TAGS');
  return { message, todo_json: todo ? JSON.stringify(todo) : null, tags_json: tags ? JSON.stringify(tags) : null };
}

/**
 * 「お客様の見え方」（改訂1-1・2-3）。共有の範囲を通した顧客を、会員と同じ組み立て関数で返す。
 *   契約は担当の範囲（canSeeCustomer）を通るときだけ問い合わせる。MEMBER_KARTE には止められない
 */
async function memberPreview(c) {
  const cid = cidOf(c.body);
  if (!(await canSeeKarteShared(c.env, c.who, cid))) {
    await logAccess(c.env, c.who, cid, 'member_preview', 'k_memberPreview', 'denied');
    return err('FORBIDDEN', 403);
  }
  const contractAllowed = await canSeeCustomer(c.env, c.who, cid);
  const out = await buildMemberKarte(c.env, cid, { includeContract: contractAllowed === true, includeIds: true,
                                                   viewerTrainerId: String(c.who.trainerId || '') });
  await logAccess(c.env, c.who, cid, 'member_preview', 'k_memberPreview', 'ok');
  return out;
}

async function mnoteRow(env, mnoteId) {
  if (!mnoteId) return null;
  return env.DB.prepare('SELECT customer_id, author_trainer_id FROM karte_member_notes WHERE mnote_id = ?').bind(String(mnoteId)).first();
}

/**
 * 保存（改訂3-1 の3つの形）。曖昧な形は 400
 *   ① 新規・トレーニングなし：rev=0・customerId・sessionDate（sessionId・mnoteId は送らない）
 *   ② 新規・既存のトレーニングに追加：rev=0・sessionId（customerId・sessionDate・mnoteId は送らない）
 *        顧客と日付は参照先の生きた session から引く。生きた枚が既にある＝409／session が無い・消えている・範囲外＝404
 *   ③ 編集：mnoteId・今の rev（>0）（sessionId・sessionDate・customerId は送らない）。本人か owner だけ
 *   中身は message・todo・tags（③は鍵がある項目だけ置き換える＝I54 と同じ）
 */
async function saveMemberNote(c) {
  const b = c.body;
  const p = (k) => has(b, k);
  const rev = b.rev;
  if (!Number.isInteger(rev) || rev < 0) return err('BAD_REQUEST', 400, 'rev');
  //   content：項目ごとに正規化した値（新規は全部空なら 400・編集は最後の状態を見張りで確かめる）
  let content;
  try {
    const m = {};
    for (const k of ['message', 'todo', 'tags']) if (p(k)) m[k] = b[k];
    if (!Object.keys(m).length) return err('BAD_REQUEST', 400, 'EMPTY');
    content = normalizeMemberFields(m);
    content.present = { message: p('message'), todo: p('todo'), tags: p('tags') };
  } catch (e) { return err('BAD_REQUEST', 400, e.message); }
  const allEmpty = content.message === null && content.todo_json === null && content.tags_json === null;
  const tid = String(c.who.trainerId || '');

  if (rev === 0) {
    if (p('mnoteId')) return err('BAD_REQUEST', 400, 'SHAPE');
    if (p('sessionId') === p('customerId')) return err('BAD_REQUEST', 400, 'SHAPE');   // 両方・どちらも無い
    if (allEmpty) return err('BAD_REQUEST', 400, 'EMPTY');
    const mid = newId();
    const ins = (tail) => `INSERT INTO karte_member_notes (mnote_id, customer_id, session_id, session_date,
        message, todo_json, tags_json, author_trainer_id, rev, created_at, updated_at) ${tail}`;
    if (p('customerId')) {
      //   ① トレーニングなし
      if (p('sessionDate') === false) return err('BAD_REQUEST', 400, 'SHAPE');
      //   ★トレーニングの無い枚は、文か次回までにが要る（タグだけでは会員のどこにも出ない・Codex 関門②）
      if (content.message === null && content.todo_json === null) return err('BAD_REQUEST', 400, 'NEED_TEXT');
      const cid = cidOf(b);
      if (!isPastOrToday(b.sessionDate)) return err('BAD_REQUEST', 400, 'BAD_DATE');
      if (!(await canSeeKarteShared(c.env, c.who, cid))) return err('NOT_FOUND', 404);
      const date = String(b.sessionDate);
      return runWrite(c, {
        action: 'k_saveMemberNote', section: 'member_note', customerId: cid,
        payload: { form: 'day', cid, date, m: [content.message, content.todo_json, content.tags_json] },
        plan: (now) => ({
          stmts: [
            G.target(cid),
            S(ins(`VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 1, ?, ?)`), mid, cid, date, content.message, content.todo_json, content.tags_json, tid, now, now),
          ],
          result: { mnoteId: mid, rev: 1 },
        }),
      });
    }
    //   ② 既存のトレーニングに追加
    if (p('sessionDate')) return err('BAD_REQUEST', 400, 'SHAPE');
    const sid = String(b.sessionId || '');
    const se = sid ? await c.env.DB.prepare('SELECT customer_id FROM karte_tr_sessions WHERE session_id = ? AND deleted_at IS NULL').bind(sid).first() : null;
    const cid = se ? String(se.customer_id) : '';
    if (!cid || !(await canSeeKarteShared(c.env, c.who, cid))) return err('NOT_FOUND', 404);
    return runWrite(c, {
      action: 'k_saveMemberNote', section: 'member_note', customerId: cid,
      payload: { form: 'session', sid, m: [content.message, content.todo_json, content.tags_json] },
      plan: (now) => ({
        stmts: [
          G.rowLive('karte_tr_sessions', 'session_id', sid),
          //   生きた枚が既にある＝409（部分 UNIQUE より先に、理由の分かる形で止める）
          S(`INSERT INTO karte_guard (rev) SELECT 1 WHERE EXISTS (
               SELECT 1 FROM karte_member_notes WHERE session_id = ? AND deleted_at IS NULL)`, sid),
          //   ★顧客と日付は session から引く（要求からは受け取らない）
          S(ins(`SELECT ?, s.customer_id, s.session_id, s.session_date, ?, ?, ?, ?, 1, ?, ?
                   FROM karte_tr_sessions s WHERE s.session_id = ? AND s.deleted_at IS NULL`),
            mid, content.message, content.todo_json, content.tags_json, tid, now, now, sid),
          G.mnoteMatch(mid),
        ],
        result: { mnoteId: mid, rev: 1 },
      }),
    });
  }

  //   ③ 編集
  if (!p('mnoteId') || p('sessionId') || p('sessionDate') || p('customerId')) return err('BAD_REQUEST', 400, 'SHAPE');
  const mnoteId = String(b.mnoteId || '');
  const row = await mnoteRow(c.env, mnoteId);
  const cid = row ? String(row.customer_id) : '';
  if (!cid || !(await canSeeKarteShared(c.env, c.who, cid))) return err('NOT_FOUND', 404);
  const override = c.who.role === 'owner' && String(row.author_trainer_id || '') !== tid;
  const f = (k) => (content.present[k] ? 1 : 0);
  return runWrite(c, {
    action: 'k_saveMemberNote', section: override ? 'member_note_owner_override' : 'member_note', customerId: cid,
    payload: { form: 'edit', mnoteId, rev, m: [content.message, content.todo_json, content.tags_json], pr: content.present },
    plan: (now) => ({
      stmts: [
        G.rowLive('karte_member_notes', 'mnote_id', mnoteId),
        G.author('karte_member_notes', 'mnote_id', mnoteId, 'author_trainer_id', c.who),
        G.rev('karte_member_notes', 'mnote_id', mnoteId, rev),
        S(`UPDATE karte_member_notes SET
              message = CASE WHEN ? = 1 THEN ? ELSE message END,
              todo_json = CASE WHEN ? = 1 THEN ? ELSE todo_json END,
              tags_json = CASE WHEN ? = 1 THEN ? ELSE tags_json END,
              rev = rev + 1, updated_at = ?, updated_by = ?
            WHERE mnote_id = ? AND rev = ? AND deleted_at IS NULL`,
          f('message'), content.message, f('todo'), content.todo_json, f('tags'), content.tags_json, now, tid, mnoteId, rev),
        //   編集の後も全部空にはしない（鍵の無い項目が残っていれば可）。トレーニングの無い枚は文か次回までにを残す（タグだけは会員に出ない）
        S(`INSERT INTO karte_guard (state) SELECT 1 FROM karte_member_notes
            WHERE mnote_id = ? AND message IS NULL AND todo_json IS NULL AND (tags_json IS NULL OR session_id IS NULL)`, mnoteId),
      ],
      result: { mnoteId, rev: rev + 1 },
    }),
  });
}

/** 削除（本人か owner。owner が他人の枚を消すときは section に上書きの印・改訂2-2・3-2） */
async function deleteMemberNote(c) {
  const b = c.body;
  const mnoteId = String(b.mnoteId || '');
  const row = await mnoteRow(c.env, mnoteId);
  const cid = row ? String(row.customer_id) : '';
  if (!cid || !(await canSeeKarteShared(c.env, c.who, cid))) return err('NOT_FOUND', 404);
  const rev = b.rev;
  if (!Number.isInteger(rev) || rev <= 0) return err('BAD_REQUEST', 400, 'rev');
  const tid = String(c.who.trainerId || '');
  const override = c.who.role === 'owner' && String(row.author_trainer_id || '') !== tid;
  return runWrite(c, {
    action: 'k_deleteMemberNote', section: override ? 'member_note_owner_override' : 'member_note', customerId: cid,
    payload: { mnoteId, rev },
    plan: (now) => ({
      stmts: [
        G.rowLive('karte_member_notes', 'mnote_id', mnoteId),
        G.author('karte_member_notes', 'mnote_id', mnoteId, 'author_trainer_id', c.who),
        G.rev('karte_member_notes', 'mnote_id', mnoteId, rev),
        S(`UPDATE karte_member_notes SET deleted_at = ?, deleted_by = ?, rev = rev + 1, updated_at = ?
            WHERE mnote_id = ? AND rev = ?`, now, tid, now, mnoteId, rev),
      ],
      result: { mnoteId, deleted: true },
    }),
  });
}

//   体の記録の値（D1 の列名で受ける）。範囲は migration の CHECK と同じ
export const MEASURE_RANGES = {
  weight_kg: [20, 250, 1], body_fat_pct: [3, 60, 1], lean_kg: [10, 150, 1], body_water_l: [5, 100, 1],
  visceral_fat: [1, 30, 0], skeletal_muscle_kg: [5, 80, 1], chest_cm: [50, 180, 1], arm_cm: [15, 70, 1],
  waist_cm: [40, 180, 1], hip_cm: [50, 180, 1], thigh_cm: [25, 100, 1],
};
export function readMeasureValues(src) {
  const v = {};
  let filled = 0;
  for (const k of Object.keys(MEASURE_RANGES)) {
    const [mn, mx, dec] = MEASURE_RANGES[k];
    v[k] = numOrNull(src ? src[k] : null, mn, mx, dec);
    if (v[k] !== null) filled++;
  }
  if (!filled) throw new RangeError('EMPTY');
  //   体重と体脂肪率があって除脂肪が空なら計算で補う（MealAi.js 1353 と同じ）
  if (v.weight_kg && v.body_fat_pct && v.lean_kg === null) v.lean_kg = Math.round(v.weight_kg * (1 - v.body_fat_pct / 100) * 10) / 10;
  return v;
}
const MCOLS = Object.keys(MEASURE_RANGES);

async function addMeasurement(c) {
  const cid = cidOf(c.body);
  if (!(await canSeeKarteShared(c.env, c.who, cid))) return err('NOT_FOUND', 404);
  let v;
  try {
    if (!isPastOrToday(c.body.measuredDate)) throw new RangeError('BAD_DATE');
    v = readMeasureValues(c.body.values || {});
  } catch (e) { return err('BAD_REQUEST', 400, e.message); }
  const tid = String(c.who.trainerId || '');
  const date = String(c.body.measuredDate);
  const crid = String(c.body.clientReqId || '');
  return runWrite(c, {
    action: 'k_addMeasurement', section: 'body', customerId: cid, payload: { cid, date, v },
    plan: (now) => ({
      stmts: [
        G.target(cid),
        //   ★切り替え（凍結）の前は書かない（シートと並行させない・設計28 3-1）
        G.ready(),
        S(`INSERT INTO body_measurements (customer_id, measured_date, source_raw, origin, ${MCOLS.join(', ')},
                                          entered_by, client_req_id, created_at, updated_at, rev)
           VALUES (?, ?, 'trainer:inbody', 'd1', ${MCOLS.map(() => '?').join(', ')}, ?, ?, ?, ?, 1)`,
          cid, date, ...MCOLS.map((k) => v[k]), tid, crid, now, now),
      ],
      //   作った行の id は書き込みの中で決まる＝同じ batch の karte_requests に last_insert_rowid() で残す
      resultSql: `json_object('id', last_insert_rowid(), 'rev', 1)`,
    }),
  });
}

async function deleteMeasurement(c) {
  const id = Number(c.body.id);
  if (!Number.isSafeInteger(id) || id <= 0) return err('BAD_REQUEST', 400, 'id');
  const r = await c.env.DB.prepare('SELECT customer_id FROM body_measurements WHERE id = ?').bind(id).first();
  const cid = r ? String(r.customer_id) : '';
  if (!cid || !(await canSeeKarteShared(c.env, c.who, cid))) return err('NOT_FOUND', 404);
  const rev = Number(c.body.rev || 0);
  if (!(rev > 0)) return err('BAD_REQUEST', 400, 'rev');
  const tid = String(c.who.trainerId || '');
  return runWrite(c, {
    action: 'k_deleteMeasurement', section: 'body', customerId: cid, payload: { id, rev },
    plan: (now) => ({
      stmts: [
        G.rowLive('body_measurements', 'id', id),
        //   入れた本人かオーナー（シートから写した行は entered_by が人の名前＝オーナーだけが消せる）
        G.author('body_measurements', 'id', id, 'entered_by', c.who),
        G.rev('body_measurements', 'id', id, rev),
        S(`UPDATE body_measurements SET deleted_at = ?, deleted_by = ?, rev = rev + 1, updated_at = ? WHERE id = ? AND rev = ?`, now, tid, now, id, rev),
      ],
      result: { id, deleted: true },
    }),
  });
}

async function saveGoalLine(c) {
  const cid = cidOf(c.body);
  if (!(await canSeeKarteShared(c.env, c.who, cid))) return err('NOT_FOUND', 404);
  const b = c.body;
  let f;
  try {
    if (!isRealDate(b.startDate) || !isRealDate(b.endDate) || String(b.startDate) >= String(b.endDate)) throw new RangeError('BAD_DATE');
    f = { start_date: String(b.startDate), end_date: String(b.endDate),
          start_weight: numOrNull(b.startWeight, 20, 250, 1), target_weight: numOrNull(b.targetWeight, 20, 250, 1) };
    if (f.start_weight === null || f.target_weight === null) throw new RangeError('WEIGHT');
  } catch (e) { return err('BAD_REQUEST', 400, e.message); }
  const tid = String(c.who.trainerId || '');
  return runWrite(c, {
    action: 'k_saveGoalLine', section: 'body', customerId: cid, payload: { cid, f },
    plan: (now) => ({
      stmts: [
        G.target(cid),
        G.ready(),
        //   ★上書きせず積む（読むときは最後の行＝GAS の meal_goals と同じ）
        S(`INSERT INTO body_goals (customer_id, kind, start_date, end_date, start_weight, target_weight, origin, rev, updated_by, updated_at)
           VALUES (?, 'meal_goal', ?, ?, ?, ?, 'd1', 1, ?, ?)`, cid, f.start_date, f.end_date, f.start_weight, f.target_weight, tid, now),
      ],
      resultSql: `json_object('id', last_insert_rowid())`,
    }),
  });
}

//   退会の記録（3年の起算日だけの正本・設計28 §6）
const MEMBER_VALID_CTE = `
  WITH v AS (
    SELECT e.id, e.kind, e.effective_date, e.recorded_at FROM karte_membership_events e
     WHERE e.customer_id = ? AND e.kind IN ('withdrawn', 'rejoined')
       AND NOT EXISTS (SELECT 1 FROM karte_membership_events x WHERE x.kind = 'cancel' AND x.target_event_id = e.id)
  ), last AS (SELECT id, kind, effective_date FROM v ORDER BY effective_date DESC, recorded_at DESC, id DESC LIMIT 1)`;

async function recordMembership(c) {
  const cid = cidOf(c.body);
  if (!(await canSeeKarteShared(c.env, c.who, cid))) return err('NOT_FOUND', 404);
  const kind = String(c.body.kind || '');
  if (!['withdrawn', 'rejoined', 'cancel'].includes(kind)) return err('BAD_REQUEST', 400, 'kind');
  if (kind === 'cancel' && c.who.role !== 'owner') return err('FORBIDDEN', 403);
  let eff = null, target = null, reason = null;
  try {
    reason = text(c.body.reason, KARTE_LIMITS.TEXT_CHARS);
    if (kind === 'cancel') {
      target = Number(c.body.targetEventId);
      if (!Number.isSafeInteger(target) || target <= 0 || !reason) throw new RangeError('CANCEL_ARGS');
    } else {
      if (!isPastOrToday(c.body.effectiveDate)) throw new RangeError('BAD_DATE');
      eff = String(c.body.effectiveDate);
    }
  } catch (e) { return err('BAD_REQUEST', 400, e.message); }
  const tid = String(c.who.trainerId || '');
  const cond = kind === 'withdrawn'
    ? `(NOT EXISTS (SELECT 1 FROM last) OR ((SELECT kind FROM last) = 'rejoined' AND (SELECT effective_date FROM last) <= ?))`
    : kind === 'rejoined'
      ? `((SELECT kind FROM last) = 'withdrawn' AND (SELECT effective_date FROM last) <= ?)`
      : `((SELECT id FROM last) = ?)`;
  const condArg = kind === 'cancel' ? target : eff;
  return runWrite(c, {
    action: 'k_recordMembership', section: 'membership', customerId: cid, payload: { cid, kind, eff, target, reason },
    plan: (now) => ({
      stmts: [
        G.target(cid),
        G.assigned(cid, c.who),
        S(`${MEMBER_VALID_CTE} INSERT INTO karte_guard (state) SELECT 1 WHERE NOT ${cond}`, cid, condArg),
        S(`INSERT INTO karte_membership_events (customer_id, kind, effective_date, target_event_id, recorded_by, recorded_at, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?)`, cid, kind, eff, target, tid, now, reason),
      ],
      resultSql: `json_object('id', last_insert_rowid(), 'kind', '${kind}')`,
    }),
  });
}

/** 起算日（有効な行の最後が withdrawn ならその日）。読み取り用 */
export async function withdrawnDate(env, cid) {
  const r = await env.DB.prepare(`${MEMBER_VALID_CTE} SELECT id, kind, effective_date FROM last`).bind(cid).first();
  return r && r.kind === 'withdrawn' ? { id: r.id, date: r.effective_date } : (r ? { id: r.id, date: null, kind: r.kind } : null);
}

// ================================================================ 読み取り
async function readSection(c, section, fn) {
  const cid = cidOf(c.body);
  if (!(await canSeeKarteShared(c.env, c.who, cid))) {
    await logAccess(c.env, c.who, cid, section, 'k_' + section, 'not_found');
    return err('NOT_FOUND', 404);
  }
  const out = await fn(cid);
  await logAccess(c.env, c.who, cid, section, 'k_' + section, 'ok');
  return out;
}

function ageOf(birthday, nowMs) {
  if (!isRealDate(birthday)) return null;
  const t = jstToday(nowMs);
  let a = Number(t.slice(0, 4)) - Number(birthday.slice(0, 4));
  if (t.slice(5) < String(birthday).slice(5)) a--;
  return a;
}

async function bodyReady(env) {
  const r = await env.DB.prepare(`SELECT freeze_id FROM body_freeze WHERE state = 'verified' ORDER BY started_at DESC LIMIT 1`).first();
  return r ? String(r.freeze_id) : null;
}

/** 読む行：verified の凍結から写した行＋凍結より後の d1 の行（削除済みを除く） */
async function bodyRows(env, cid, freezeId) {
  const r = await env.DB.prepare(
    `SELECT * FROM body_measurements
      WHERE customer_id = ? AND deleted_at IS NULL
        AND (origin = 'd1' OR (origin = 'sheet' AND origin_key LIKE ?))`
  ).bind(cid, freezeId + ':%').all();
  return r.results || [];
}
async function goalRows(env, cid, freezeId) {
  const r = await env.DB.prepare(
    `SELECT * FROM body_goals WHERE customer_id = ? AND deleted_at IS NULL
        AND (origin = 'd1' OR (origin = 'sheet' AND origin_key LIKE ?))`
  ).bind(cid, freezeId + ':%').all();
  return r.results || [];
}

function noteOut(n) {
  const o = Object.assign({}, n, { reasons: parseJsonCol(n.reasons_json) || [] });
  delete o.reasons_json;
  return o;
}

async function summary(c) {
  return readSection(c, 'summary', async (cid) => {
    const env = c.env, now = Date.now();
    const assigned = await canSeeCustomer(env, c.who, cid);
    const [cust, profile, consent, safety, lastNote, nextResv] = await Promise.all([
      env.DB.prepare(`SELECT customer_id, name, birthday, default_trainer_id, contract_status FROM customers WHERE customer_id = ?`).bind(cid).first(),
      env.DB.prepare(`SELECT goal_text, goal_value, goal_unit, goal_deadline, motive, history, hearing_json, rev, updated_at FROM karte_profile WHERE customer_id = ?`).bind(cid).first(),
      env.DB.prepare(`SELECT state, changed_at, method FROM karte_consent WHERE customer_id = ? AND kind = 'health'`).bind(cid).first(),
      //   ★安全面は同意があるときだけ（JOIN を SQL に置く）。概要には要点（制限と痛む部位）だけ
      env.DB.prepare(`SELECT s.restrictions, s.pain_sites, s.pain_json, s.diagnosis, s.medication FROM karte_safety s JOIN karte_consent k
                        ON k.customer_id = s.customer_id AND k.kind = 'health' AND k.state = 'agreed'
                       WHERE s.customer_id = ?`).bind(cid).first(),
      env.DB.prepare(`SELECT note_id, session_date, condition, body, next_plan, tag, reasons_json, next_check, author_trainer_id FROM karte_notes
                       WHERE customer_id = ? AND deleted_at IS NULL ORDER BY session_date DESC, created_at DESC LIMIT 1`).bind(cid).first(),
      env.DB.prepare(`SELECT start_at, trainer_id FROM reservations WHERE customer_id = ? AND status = 'booked' AND start_at >= ?
                       ORDER BY start_at LIMIT 1`).bind(cid, now).first(),
    ]);
    if (!cust) return err('NOT_FOUND', 404);
    return {
      karteSchema: karteSchemaFor(c.env, c.who),
      customer: { customerId: cust.customer_id, name: cust.name, age: ageOf(cust.birthday, now),
                  trainerId: cust.default_trainer_id || null,
                  //   ★契約の状態は担当（＋担当なし・オーナー）だけ（設計28 4-2）
                  ...(assigned ? { contractStatus: cust.contract_status || null } : {}) },
      assigned,
      profile: profile ? Object.assign({}, profile, { hearing: parseJsonCol(profile.hearing_json), hearing_json: undefined }) : null,
      consent: consent ? { state: consent.state, changedAt: consent.changed_at, method: consent.method } : { state: 'none' },
      safetyBrief: safety ? { restrictions: safety.restrictions, painSites: safety.pain_sites, pain: parseJsonCol(safety.pain_json) || [],
                              diagnosis: safety.diagnosis, medication: safety.medication } : null,
      lastNote: lastNote ? noteOut(lastNote) : null,
      nextReservation: nextResv ? { startAt: nextResv.start_at, trainerId: nextResv.trainer_id } : null,
    };
  });
}

async function notes(c) {
  return readSection(c, 'notes', async (cid) => {
    const before = String(c.body.before || '');
    const r = await c.env.DB.prepare(
      `SELECT note_id, session_date, condition, body, next_plan, tag, reasons_json, next_check, author_trainer_id, rev, created_at, edited_at
         FROM karte_notes WHERE customer_id = ? AND deleted_at IS NULL ${before ? 'AND session_date < ?' : ''}
        ORDER BY session_date DESC, created_at DESC LIMIT ${KARTE_LIMITS.PAGE}`
    ).bind(...(before ? [cid, before] : [cid])).all();
    return { karteSchema: karteSchemaFor(c.env, c.who), notes: (r.results || []).map(noteOut) };
  });
}

async function training(c) {
  return readSection(c, 'training', async (cid) => {
    const before = String(c.body.before || '');
    const ss = await c.env.DB.prepare(
      `SELECT session_id, session_date, author_trainer_id, rev, created_at FROM karte_tr_sessions
        WHERE customer_id = ? AND deleted_at IS NULL ${before ? 'AND session_date < ?' : ''}
        ORDER BY session_date DESC, created_at DESC LIMIT ${KARTE_LIMITS.PAGE}`
    ).bind(...(before ? [cid, before] : [cid])).all();
    const sessions = ss.results || [];
    if (!sessions.length) return { karteSchema: karteSchemaFor(c.env, c.who), aiDraft: aiDraftReady(c.env, c.who), sessions: [], best: [] };   // ★空でも版を返す
    //   ★3つの表（種目の並び・付加・ドロップ）は生きた session の id を通してだけ読む（設計38 I70）
    const ids = sessions.map((x) => x.session_id);
    const ph = ids.map(() => '?').join(',');
    const [st, xs, ds] = await Promise.all([
      //   並び：新しい回（付加あり）は ord, set_no。古い回は ord が NULL＝今までどおり exercise, set_no
      c.env.DB.prepare(
        `SELECT t.set_id, t.session_id, t.exercise, t.set_no, t.weight_kg, t.reps, t.note, e.ord, e.assist_reps, e.forced
           FROM karte_tr_sets t LEFT JOIN karte_tr_set_ext e ON e.set_id = t.set_id
          WHERE t.session_id IN (${ph}) ORDER BY t.session_id, e.ord, t.exercise, t.set_no`
      ).bind(...ids).all(),
      c.env.DB.prepare(
        `SELECT session_id, ord, exercise, done_only FROM karte_tr_exercises WHERE session_id IN (${ph}) ORDER BY session_id, ord`
      ).bind(...ids).all(),
      c.env.DB.prepare(
        `SELECT d.set_id, d.drop_seq, d.weight_kg, d.reps, d.assist_reps, d.forced
           FROM karte_tr_drops d JOIN karte_tr_sets t ON t.set_id = d.set_id
          WHERE t.session_id IN (${ph}) ORDER BY d.set_id, d.drop_seq`
      ).bind(...ids).all(),
    ]);
    //   新しい形の回か古い回かは「種目の並びの行があるか」だけで決める（設計38 §3-5）
    const exBy = {};
    for (const x of (xs.results || [])) (exBy[x.session_id] = exBy[x.session_id] || []).push({ ord: x.ord, exercise: x.exercise, doneOnly: x.done_only === 1 });
    const dropBy = {};
    for (const d of (ds.results || [])) {
      (dropBy[d.set_id] = dropBy[d.set_id] || []).push({ weight_kg: d.weight_kg, reps: d.reps, assist_reps: d.assist_reps, forced: d.forced === 1 });
    }
    const by = {};
    for (const s of (st.results || [])) {
      //   ★古い回のセットは今までと同じ鍵だけ（set_id は返さない）。新しい回は ord・補助・無理やり（真偽値）・ドロップを足す
      //     ★ドロップは本セットの下にだけ置く（平らな配列に混ぜない＝古い画面が本セットと数えない）
      const o = { session_id: s.session_id, exercise: s.exercise, set_no: s.set_no, weight_kg: s.weight_kg, reps: s.reps, note: s.note,
                  e1rm: e1rm(s.weight_kg, s.reps) };
      if (exBy[s.session_id]) Object.assign(o, { ord: s.ord, assist_reps: s.assist_reps, forced: s.forced === 1, drops: dropBy[s.set_id] || [] });
      (by[s.session_id] = by[s.session_id] || []).push(o);
    }
    //   グラフ：種目名ごとに、その日の推定1RMの最大。★本セットだけ（ドロップは別の表）・無理やりを除く・回数は自分の回数（I66）
    const best = [];
    for (const se of sessions) {
      const day = {};
      for (const s of (by[se.session_id] || [])) {
        if (s.forced === true) continue;
        if (s.e1rm != null && (!(s.exercise in day) || s.e1rm > day[s.exercise])) day[s.exercise] = s.e1rm;
      }
      for (const ex of Object.keys(day)) best.push({ d: se.session_date, exercise: ex, e1rm: day[ex] });
    }
    return { karteSchema: karteSchemaFor(c.env, c.who), aiDraft: aiDraftReady(c.env, c.who),   // 設計39：AI の振り分けのボタンを出すか（真偽値だけ）
             sessions: sessions.map((x) => (exBy[x.session_id]
               ? { ...x, sets: by[x.session_id] || [], exercises: exBy[x.session_id] }
               : { ...x, sets: by[x.session_id] || [] })), best };
  });
}

async function safety(c) {
  return readSection(c, 'safety', async (cid) => {
    const r = await c.env.DB.prepare(
      `SELECT s.conditions, s.injuries, s.pain_sites, s.medication, s.restrictions, s.pain_json, s.diagnosis, s.source, s.rev, s.updated_at
         FROM karte_safety s JOIN karte_consent k ON k.customer_id = s.customer_id AND k.kind = 'health' AND k.state = 'agreed'
        WHERE s.customer_id = ?`
    ).bind(cid).first();
    const k = await c.env.DB.prepare(`SELECT state FROM karte_consent WHERE customer_id = ? AND kind = 'health'`).bind(cid).first();
    return { karteSchema: karteSchemaFor(c.env, c.who), consent: k ? k.state : 'none', safety: r ? Object.assign({}, r, { pain: parseJsonCol(r.pain_json) || [], pain_json: undefined }) : null };
  });
}

async function bodySection(c) {
  return readSection(c, 'body', async (cid) => {
    const fz = await bodyReady(c.env);
    if (!fz) return { ready: false, rows: [], goal: null, raw: [] };
    const [rows, goals] = await Promise.all([bodyRows(c.env, cid, fz), goalRows(c.env, cid, fz)]);
    //   raw：削除・編集のための行（新しい順・20件）
    const raw = rows.slice().sort((a, b) => (a.measured_date < b.measured_date ? 1 : -1)).slice(0, KARTE_LIMITS.PAGE)
      .map((r) => ({ id: r.id, d: r.measured_date, origin: r.origin, rev: r.rev, enteredBy: r.origin === 'd1' ? r.entered_by : null,
                     ...Object.fromEntries(MCOLS.map((k) => [k, r[k]])) }));
    return { ready: true, rows: synthesizeBody(rows), goal: pickGoalLine(goals), raw };
  });
}

//   契約：計算用に写した契約の行から、金額を含まない項目だけ（担当＋担当なし・オーナーは全員）
async function contract(c) {
  const cid = cidOf(c.body);
  if (!(await canSeeCustomer(c.env, c.who, cid))) {
    await logAccess(c.env, c.who, cid, 'contract', 'k_contract', 'denied');
    return err('FORBIDDEN', 403);
  }
  const [meta, rows] = await Promise.all([
    c.env.DB.prepare(`SELECT payload FROM calc_meta WHERE key = 'contract_cols'`).first(),
    c.env.DB.prepare(`SELECT row_json, start_ms, end_ms FROM calc_contract_rows WHERE customer_id = ? ORDER BY start_ms DESC`).bind(cid).all(),
  ]);
  let cols = null;
  try { cols = meta ? JSON.parse(meta.payload).cols : null; } catch (_) { cols = null; }
  if (!cols) return { contracts: [], note: 'NO_META' };
  const pick = (r, k) => (cols[k] != null && cols[k] >= 0 ? r[cols[k]] : null);
  const out = [];
  for (const x of (rows.results || [])) {
    let r;
    try { r = JSON.parse(x.row_json); } catch (_) { continue; }
    out.push({ type: pick(r, 'type'), course: pick(r, 'course'), method: pick(r, 'method'), freq: pick(r, 'freq'),
               tickets: pick(r, 'ticket'), trainer: pick(r, 'trainer'), startMs: x.start_ms, endMs: x.end_ms });
  }
  await logAccess(c.env, c.who, cid, 'contract', 'k_contract', 'ok');
  return { contracts: out };
}

//   一覧（担当＋担当なし・オーナーは全員）。印と名前だけ（金額・種別は出さない。健康は「注意あり」の真偽だけ・設計31）
async function board(c) {
  const env = c.env, who = c.who, now = Date.now();
  const scope = who.role === 'owner' ? { where: '', args: [] }
    : { where: `AND (default_trainer_id IS NULL OR default_trainer_id = '' OR default_trainer_id = ?)`, args: [String(who.trainerId || '')] };
  const after = String(c.body.after || '');
  const cs = await env.DB.prepare(
    `SELECT customer_id, name FROM customers WHERE 1 = 1 ${scope.where} ${after ? 'AND customer_id > ?' : ''}
      ORDER BY customer_id LIMIT ${KARTE_LIMITS.BOARD_PAGE + 1}`
  ).bind(...scope.args, ...(after ? [after] : [])).all();
  const list = (cs.results || []);
  const more = list.length > KARTE_LIMITS.BOARD_PAGE;
  const page = list.slice(0, KARTE_LIMITS.BOARD_PAGE);
  if (!page.length) return { customers: [], next: null };
  const ids = page.map((x) => x.customer_id);
  const ph = ids.map(() => '?').join(',');
  const [sync, nextR, lastM, ends, homes, fz, kp] = await Promise.all([
    env.DB.prepare(`SELECT key, synced_at FROM sync_state WHERE key IN ('reservations', 'calcContracts')`).all(),
    env.DB.prepare(`SELECT customer_id, MIN(start_at) AS t FROM reservations WHERE customer_id IN (${ph}) AND status = 'booked' AND start_at >= ? GROUP BY customer_id`).bind(...ids, now).all(),
    //   ★最終測定日も「verified の凍結から写した行＋d1」だけ（未確認の写しを混ぜない・I51）
    bodyReady(env).then((vf) => env.DB.prepare(
      `SELECT customer_id, MAX(measured_date) AS d FROM body_measurements WHERE customer_id IN (${ph}) AND deleted_at IS NULL
          AND (origin = 'd1' OR (origin = 'sheet' AND origin_key LIKE ?)) GROUP BY customer_id`).bind(...ids, (vf || '__none__') + ':%').all()),
    env.DB.prepare(`SELECT r.customer_id, MAX(r.end_ms) AS e FROM calc_contract_rows r JOIN customer_sync_version v ON v.customer_id = r.customer_id
                     WHERE r.customer_id IN (${ph}) AND v.source_version = v.built_version AND v.built_version > 0 GROUP BY r.customer_id`).bind(...ids).all(),
    env.DB.prepare(`SELECT customer_id, payload, computed_at FROM member_home WHERE customer_id IN (${ph})`).bind(...ids).all(),
    bodyReady(env),
    //   ★ヒアリング・同意・注意あり（設計31）。注意ありは健康由来の印＝同意の JOIN の中で SQL が決める（部位や強さは返さない）
    env.DB.prepare(
      `SELECT c.customer_id,
              (SELECT p.hearing_json IS NOT NULL FROM karte_profile p WHERE p.customer_id = c.customer_id) AS hearing,
              (SELECT k.state FROM karte_consent k WHERE k.customer_id = c.customer_id AND k.kind = 'health') AS consent,
              EXISTS (SELECT 1 FROM karte_safety s JOIN karte_consent k2
                        ON k2.customer_id = s.customer_id AND k2.kind = 'health' AND k2.state = 'agreed'
                       WHERE s.customer_id = c.customer_id
                         AND (s.pain_json IS NOT NULL OR (s.restrictions IS NOT NULL AND s.restrictions <> ''))) AS caution
         FROM customers c WHERE c.customer_id IN (${ph})`).bind(...ids).all(),
  ]);
  const kBy = {}; for (const r of (kp.results || [])) kBy[r.customer_id] = r;
  const syncAt = {}; for (const s of (sync.results || [])) syncAt[s.key] = Number(s.synced_at || 0);
  const resvFresh = now - (syncAt.reservations || 0) <= 30 * 60 * 1000;
  const contractsFresh = now - (syncAt.calcContracts || 0) <= 26 * 3600 * 1000;
  const nextBy = {}; for (const r of (nextR.results || [])) nextBy[r.customer_id] = r.t;
  const lastBy = {}; for (const r of (lastM.results || [])) lastBy[r.customer_id] = r.d;
  const endBy = {}; for (const r of (ends.results || [])) endBy[r.customer_id] = r.e;
  const homeBy = {}; for (const r of (homes.results || [])) homeBy[r.customer_id] = r;
  const HOME_HARD = 40 * 60 * 1000;
  const today = jstToday(now);
  const out = page.map((cu) => {
    const id = cu.customer_id;
    const flags = {};
    //   次の予約が無い（予約の写しが30分以内に同期されているときだけ判定）
    flags.noNextBooking = resvFresh ? !nextBy[id] : 'unknown';
    //   記録が止まっている（体の記録の切り替えが verified のときだけ。30日以上 or 記録なし）
    if (!fz) flags.recordStale = 'preparing';
    else if (!lastBy[id]) flags.recordStale = 'none';
    else flags.recordStale = (Date.parse(today) - Date.parse(lastBy[id])) / 86400000 >= 30;
    //   契約の終了が近い（30日以内）。世代が新しく、完全同期が26時間以内のときだけ
    if (!contractsFresh || !(id in endBy)) flags.contractEnding = 'unknown';
    else flags.contractEnding = endBy[id] != null && endBy[id] - now <= 30 * 86400000 && endBy[id] >= now - 86400000;
    //   支払い待ち（残数の写し。40分を超えたら答えない＝readHomeSafe と同じ上限）
    const h = homeBy[id];
    if (!h || now - Number(h.computed_at || 0) > HOME_HARD) flags.paymentPending = 'unknown';
    else {
      try { const p = JSON.parse(h.payload); flags.paymentPending = !!(p && p.current && p.current.paymentRequired); }
      catch (_) { flags.paymentPending = 'unknown'; }
    }
    const k = kBy[id] || {};
    flags.hearingMissing = !k.hearing;
    flags.consentPending = k.consent !== 'agreed';
    flags.caution = !!k.caution;
    return { customerId: id, name: cu.name, flags };
  });
  await logAccess(env, who, null, 'board', 'k_board', 'ok');
  return { customers: out, next: more ? page[page.length - 1].customer_id : null };
}

// ================================================================ 種目の一覧（全員で共有・部位つき）2026-11-06
//   ★共有の範囲（トレーナー全員）。顧客に結び付かない＝customerId を取らない
//   ★読みは表（karte_exercises の生きた行）だけ。記録（karte_tr_sets）の自由文は読まない（CEO 決定・関門②）：
//     全セットの走査の負荷（索引なし・タブを開くたび）と、自由文に混じった個人・健康の情報が顧客と切り離されて全員に並ぶのを避ける。
//     既存の記録の名前は、その顧客の「最近の種目」（k_training）にだけ出る
async function exercises(c) {
  const env = c.env, L = EXERCISE_LIMITS;
  const t = await env.DB.prepare(
    `SELECT name, part FROM karte_exercises WHERE deleted_at IS NULL ORDER BY name LIMIT ${L.MAX_ROWS + 1}`
  ).all();
  const rows = (t.results || []).map((r) => ({ name: String(r.name), part: String(r.part) }));
  await logAccess(env, c.who, null, 'exercises', 'k_exercises', 'ok');
  return { karteSchema: karteSchemaFor(c.env, c.who), exercises: rows.slice(0, L.MAX_ROWS), truncated: rows.length > L.MAX_ROWS };
}

//   書き込み：追加、または部位の変更（名前と部位だけ）。消した行（deleted_at）は書き直すと生き返る
//     ★同時に2人が部位を変えたら後の方が残る（rev は持たない＝種目の部位は共有の分類で、取り合いの害が小さい）
async function saveExercise(c) {
  const b = c.body, L = EXERCISE_LIMITS;
  let name, part;
  try {
    for (const k of Object.keys(b)) if (['action', 'idToken', 'clientReqId', 'name', 'part'].indexOf(k) < 0) throw new RangeError('UNKNOWN_KEY');
    name = normalizeExerciseName(b.name);
    part = normalizePart(b.part);
  } catch (e) { return err('BAD_REQUEST', 400, e.message); }
  //   表の上限（読みの上限と同じ）。★「同名の生きた行が無い」ときに数える（消した行の復活も生きた行を1つ増やす・関門②）。
  //     並行の取りこぼしは batch の見張りでもう一度、同じ条件で止める
  const have = await c.env.DB.prepare('SELECT 1 AS x FROM karte_exercises WHERE name = ? AND deleted_at IS NULL').bind(name).first();
  if (!have) {
    const n = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM karte_exercises WHERE deleted_at IS NULL').first();
    if (n && Number(n.n) >= L.MAX_ROWS) return err('EX_LIMIT', 409);
  }
  const tid = String(c.who.trainerId || '');
  return runWrite(c, {
    action: 'k_saveExercise', section: 'exercises', customerId: null, payload: { name, part },
    plan: (now) => ({
      stmts: [
        S(`INSERT INTO karte_guard (state) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM karte_exercises WHERE name = ? AND deleted_at IS NULL)
             AND (SELECT COUNT(*) FROM karte_exercises WHERE deleted_at IS NULL) >= ?`, name, L.MAX_ROWS),
        //   変える前の部位を控える（名前と部位だけ）
        S(`INSERT INTO karte_revisions (table_name, row_id, rev, before_json, changed_by, changed_at)
           SELECT 'karte_exercises', name, 0, json_object('part', part, 'deleted_at', deleted_at), ?, ?
             FROM karte_exercises WHERE name = ?`, tid, now, name),
        S(`INSERT INTO karte_exercises (name, part, created_by, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET part = excluded.part, updated_by = ?, updated_at = ?, deleted_at = NULL`,
          name, part, tid, now, tid, now),
      ],
      result: { name, part },
    }),
  });
}

export const KARTE_HANDLERS = {
  k_exercises: exercises,
  k_saveExercise: saveExercise,
  k_summary: summary,
  k_notes: notes,
  k_training: training,
  k_safety: safety,
  k_body: bodySection,
  k_contract: contract,
  k_board: board,
  k_saveProfile: saveProfile,
  k_saveConsent: saveConsent,
  k_saveSafety: saveSafety,
  k_addNote: addNote,
  k_editNote: editNote,
  k_deleteNote: deleteNote,
  k_addTraining: addTraining,
  k_deleteTraining: deleteTraining,
  k_addMeasurement: addMeasurement,
  k_deleteMeasurement: deleteMeasurement,
  k_saveGoalLine: saveGoalLine,
  k_recordMembership: recordMembership,
  k_memberPreview: memberPreview,
  k_saveMemberNote: saveMemberNote,
  k_deleteMemberNote: deleteMemberNote,
};
