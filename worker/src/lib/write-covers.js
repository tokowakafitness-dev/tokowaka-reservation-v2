// 設計45・I79：写しが「書き込みの印」を含んでいるか（門）
//
//   会員 X が「閉じている」＝ dirty_seq > 0 かつ（covers が NULL か dirty_seq > covers）。
//     home の covers で閉じた会員 … 残数（D1 から作った値も写しも・振替権も）を答えない
//     resv の covers で閉じた会員 … 予約から作った値（予約一覧・今後の件数・次回予約）を答えない
//   ★NULL は閉じる側（MODEL §8）。読めなければ全員閉じる（MODEL §0）。
//   ★値を読む前と読んだ後の2回見る（関門① 3周目）。後の門は「値の読み取りが全部終わった後・応答を組み立てる前」（4周目の条件）
//
//   このファイルは他の routes を import しない（boot.js・compat.js・karte.js・customer.js から使うため）。

import { dayKeyJst, DAILY_CAP } from './remain-read-on.js';

export const COVERS_KINDS = ['home', 'resv'];
export const COVERS_ENTRY = 'covers';                  // remain_source_daily の entry
export const COVERS_WHY = ['home', 'resv', 'read_failed'];

/** SQL の条件（customer_sync_version の列名で書く）。kind = 'home' | 'resv'。alias を渡すと「v.」を付ける */
export function closedSqlFor(kind, alias) {
  if (!COVERS_KINDS.includes(kind)) throw new Error('BAD_KIND');
  const a = alias ? alias + '.' : '';
  return `(${a}dirty_seq > 0 AND (${a}${kind}_covers_seq IS NULL OR ${a}dirty_seq > ${a}${kind}_covers_seq))`;
}

/** JS 側の同じ判定（純粋）。row は customer_sync_version の1行（無ければ開いている＝dirty 0） */
export function isClosed(row, kind) {
  if (!row) return false;
  const d = Number(row.dirty_seq || 0);
  if (!(d > 0)) return false;
  const c = row[kind + '_covers_seq'];
  if (c === null || c === undefined) return true;
  const n = Number(c);
  if (!Number.isFinite(n)) return true;
  return d > n;
}

const CHUNK = 80;   // D1 の差し込み数の上限に合わせる（alloc-build.js と同じ線）

/**
 * 会員の集合について、閉じている会員を返す。
 *   { home:Set, resv:Set, failed:boolean }。failed のときは「全員閉じている」とみなすこと（呼ぶ側は any() を使う）
 */
export async function coversGate(env, customerIds) {
  const ids = Array.from(new Set((customerIds || []).map((x) => String(x || '').trim()).filter(Boolean)));
  const out = { home: new Set(), resv: new Set(), failed: false };
  if (!ids.length) return out;
  try {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const part = ids.slice(i, i + CHUNK);
      const ph = part.map(() => '?').join(',');
      const r = await env.DB.prepare(
        `SELECT customer_id, dirty_seq, home_covers_seq, resv_covers_seq
           FROM customer_sync_version WHERE customer_id IN (${ph})`
      ).bind(...part).all();
      for (const row of (r.results || [])) {
        const id = String(row.customer_id);
        if (isClosed(row, 'home')) out.home.add(id);
        if (isClosed(row, 'resv')) out.resv.add(id);
      }
    }
  } catch (_) {
    out.failed = true;
  }
  return out;
}

/** 1人の会員について、その種類が閉じているか（読めなければ true） */
export async function oneClosed(env, customerId, kind) {
  const id = String(customerId || '').trim();
  if (!id) return false;   // 会員が無い経路は門の対象外（呼ぶ側が別の理由で答えない）
  const g = await coversGate(env, [id]);
  if (g.failed) return true;
  return g[kind].has(id);
}

/** 誰か1人でも resv が閉じているか（トレーナー・オーナーの一覧用。読めなければ true）
 *   ★顧客表（customers）に在る会員だけを見る。顧客表から消えた会員の古い行が残っていると、
 *     その会員の covers は二度と進まず（全体の送信の coveredCustomers に出てこない）一覧が永久に GAS へ落ちるため。
 *     消えた会員の予約の行は完全同期が消す（その会員の予約は一覧に出ない） */
export async function anyResvClosed(env) {
  try {
    const r = await env.DB.prepare(
      `SELECT 1 AS x FROM customer_sync_version v JOIN customers c ON c.customer_id = v.customer_id
        WHERE ${closedSqlFor('resv', 'v')} LIMIT 1`
    ).first();
    return !!r;
  } catch (_) { return true; }
}

/** 門で答えなかった回を数える（remain_source_daily・1日 DAILY_CAP まで）。例外を外へ出さない */
export async function countCovers(env, ctx, why) {
  const w = COVERS_WHY.includes(why) ? why : 'read_failed';
  const run = async () => {
    try {
      const day = dayKeyJst(Date.now());
      const r = await env.DB.prepare(
        `INSERT INTO remain_source_daily (day, entry, source, n)
           SELECT ?, ?, ?, 1
            WHERE (SELECT COALESCE(SUM(n), 0) FROM remain_source_daily
                    WHERE day = ? AND entry = ? AND source NOT LIKE '\\_%' ESCAPE '\\') < ?
         ON CONFLICT(day, entry, source) DO UPDATE SET n = n + 1`
      ).bind(day, COVERS_ENTRY, w, day, COVERS_ENTRY, DAILY_CAP).run();
      if (!Number((r && r.meta && r.meta.changes) || 0)) {
        await env.DB.prepare(
          "INSERT OR IGNORE INTO remain_source_daily (day, entry, source, n) VALUES (?, ?, '_dropped', 1)"
        ).bind(day, COVERS_ENTRY).run();
      }
    } catch (_) { /* 数えられなくても答えは変えない */ }
  };
  try {
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(run()); else await run();
  } catch (_) {}
}

/**
 * ingest が写しと同じ batch に積む文（covers を置き換え・since を付け外し）。★dirty の文の後ろに積む（関門① 2周目 中3）
 *   後から書いた方で置き換える（MAX にしない）。行の無い会員は 0 行＝何もしない（dirty も 0 なので開いている）
 */
export function coversStatement(kind, customerId, coversSeq, nowMs) {
  if (!COVERS_KINDS.includes(kind)) throw new Error('BAD_KIND');
  const col = kind + '_covers_seq', since = kind + '_blocked_since';
  return {
    sql: `UPDATE customer_sync_version SET
            ${since} = CASE WHEN dirty_seq > 0 AND dirty_seq > ? THEN COALESCE(${since}, ?) ELSE NULL END,
            ${col} = ?
          WHERE customer_id = ?`,
    args: [Number(coversSeq), Number(nowMs), Number(coversSeq), String(customerId)],
  };
}

/** 本文の coversSeq（正の安全な整数だけ）。無い＝null・壊れている＝'bad' */
export function parseCoversSeq(v) {
  if (v === undefined || v === null) return null;
  if (!Number.isSafeInteger(v) || v <= 0) return 'bad';
  return v;
}

export const COVERED_MAX = 2000;
export const CUSTOMER_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
