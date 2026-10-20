// POST /quota/rebuild ― 1名の計算入力を受け取り、入れ替え・作り直し・記録を1つの batch で行う（設計20・決定0091）
//
// ★なぜ要るのか
//   二重書きの後追い処理は、予約の入力だけを送って作り直していた。契約（チケット追加）は15分ごとの
//   定期送信でしか届かないので、**古い契約のまま作り直して「新しい」と名乗っていた**（10/18 の食い違い）。
//   入力を種類ごとに別の送信で届けると、途中の混ざった状態を「新しい」と名乗れる（関門①2回目）。
//   だから1回の送信で全部受け取り、**入力の入れ替え・作り直し・記録を同じ batch に入れる。** 途中の状態が存在しない。
//
// ★通し番号（seq）
//   GAS が「台帳を読む前に」読んだ書き込みの通し番号。作り直しが成功したら built_covers_seq を MAX で進める。
//   新しいと名乗るのは built_covers_seq >= dirty_seq のときだけ（fresh.js）。
//   走っている後追い処理が古い台帳で作り直しても、その後の書き込みの番号に届かないので名乗らない。
//
// ★世代（§7-1）
//   開始時に ver0 を読み、batch の中で source を +1 する＝期待する世代は ver0+1。
//   枠・パックの行も ver0+1 で書き、markBuilt は「いまの source が ver0+1」のときだけ built を進める。
//   途中で別の入力（定期送信・calcMeta）が来て source が進んでいれば built=0（名乗らない）。
//
// ★個人情報（§7-4）
//   本文の契約行には氏名・電話が入る。エラー応答は { code, kind, count } だけ。本文・行・例外を応答にもログにも出さない。
//   計算の issue は code だけに縮める（detail・予約ID・pack_id・row_json を返さない）。

import { requireSecret, mask, computeCustomerBuild } from './quota.js';
import { assembleCalcInput } from '../calc.js';
import { customerReplaceStatements } from './ingest.js';
import { readSyncVersion, markBuiltStatement, bumpSourceStatement } from '../lib/sync-version.js';
import { quotaUpsertStatements, clearGenerationStatements } from '../lib/quota-build.js';

//   ★大きさの上限（§7-3）。いまの最大の会員（契約4行・予約30件前後）の十倍以上の余裕を取る
export const REBUILD_LIMITS = {
  BODY_BYTES: 256 * 1024,
  CONTRACT_ROWS: 60,
  RESV_ROWS: 500,
  STATEMENTS: 1500,   // 計算した後・書く前に数える（1予約から複数の文ができるため）
};

const MONTH_RE = /^\d{4}-\d{2}$/;

function res(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
const fail = (code, status, extra) => res(Object.assign({ ok: false, code }, extra || {}), status);

export async function quotaRebuild(request, env) {
  const deny = requireSecret(request, env);
  if (deny) return deny;
  const t0 = Date.now();

  // ---- 本文（大きさ → JSON）----
  const len = Number(request.headers.get('content-length') || 0);
  if (len > REBUILD_LIMITS.BODY_BYTES) return fail('TOO_LARGE', 413, { kind: 'body' });
  let text;
  try { text = await request.text(); } catch (_) { return fail('BAD_BODY', 400); }
  //   ★文字数ではなく UTF-8 のバイト数で測る（契約行は日本語。String.length は UTF-16 の単位・関門②）
  if (new TextEncoder().encode(text).byteLength > REBUILD_LIMITS.BODY_BYTES) return fail('TOO_LARGE', 413, { kind: 'body' });
  let body;
  try { body = JSON.parse(text); } catch (_) { return fail('BAD_JSON', 400); }   // ★本文を返さない
  if (!body || typeof body !== 'object') return fail('BAD_JSON', 400);

  // ---- 入力の検査（§7-4 の12）----
  const cid = String(body.customerId || '').trim();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(cid)) return fail('BAD_CUSTOMER', 400);
  const seq = body.seq;
  if (!Number.isSafeInteger(seq) || seq <= 0) return fail('BAD_SEQ', 400);
  const from = String(body.from || ''), to = String(body.to || '');
  if (!MONTH_RE.test(from) || !MONTH_RE.test(to) || from > to) return fail('BAD_RANGE', 400);
  const carryRate = (typeof body.carryRate === 'number' && body.carryRate > 0 && body.carryRate <= 1) ? body.carryRate : 1 / 3;

  const contracts = body.contracts, reservations = body.reservations;
  if (!Array.isArray(contracts) || !Array.isArray(reservations)) return fail('BAD_INPUT', 400);
  if (contracts.length > REBUILD_LIMITS.CONTRACT_ROWS) return fail('TOO_LARGE', 413, { kind: 'contracts', count: contracts.length });
  if (reservations.length > REBUILD_LIMITS.RESV_ROWS) return fail('TOO_LARGE', 413, { kind: 'reservations', count: reservations.length });
  //   ★1行でも他の会員の行があれば全体を断る（混ざった行だけ捨てない）
  const idxSeen = new Set();
  for (const r of contracts) {
    if (!r || typeof r !== 'object' || String(r.customer_id) !== cid) return fail('CUSTOMER_MISMATCH', 400, { kind: 'contracts' });
    if (!r.row_key || typeof r.row_json !== 'string') return fail('BAD_INPUT', 400, { kind: 'contracts' });
    if (!Number.isSafeInteger(r.idx) || r.idx < 0 || idxSeen.has(r.idx)) return fail('BAD_INPUT', 400, { kind: 'contracts' });
    idxSeen.add(r.idx);
  }
  for (const r of reservations) {
    if (!r || typeof r !== 'object' || String(r.customer_id) !== cid) return fail('CUSTOMER_MISMATCH', 400, { kind: 'reservations' });
    if (!r.row_key || typeof r.row_json !== 'string') return fail('BAD_INPUT', 400, { kind: 'reservations' });
  }
  let openingRows = [];
  if (body.opening != null) {
    const o = body.opening;
    if (typeof o !== 'object' || String(o.customer_id) !== cid || typeof o.payload !== 'string') {
      return fail('CUSTOMER_MISMATCH', 400, { kind: 'opening' });
    }
    openingRows = [o];
  }

  // ---- 読む（列の並び・いまの世代）----
  let meta, ver0;
  try {
    meta = await env.DB.prepare("SELECT payload FROM calc_meta WHERE key = 'contract_cols'").first();
    ver0 = await readSyncVersion(env, cid);
  } catch (_) { return fail('READ_FAILED', 503); }
  //   ★列の並びが読めない・壊れているなら何も書かない（§7-1 の6）
  if (!meta) return fail('NO_META', 409);
  let cols;
  try { cols = JSON.parse(meta.payload).cols; } catch (_) { return fail('BAD_META', 409); }
  if (!cols || cols.name == null) return fail('BAD_META', 409);

  // ---- 計算（/quota/build と同じ関数）----
  const input = assembleCalcInput(cid, cols, contracts, reservations, openingRows.length ? openingRows[0].payload : null);
  if (!input.ok) return fail(String(input.reason || 'BAD_INPUT'), 400);
  const now = Date.now();
  let cb;
  try { cb = computeCustomerBuild(cid, input, { from, to, now, carryRate, withAlloc: true }); }
  catch (_) { return fail('BUILD_FAILED', 500); }
  const built = cb.built;
  const blocked = !!(built.issues.length || cb.allocIssues.length);

  // ---- 文を組み立てる（§7-1 の2 の順番）----
  const batchId = now;
  const expected = Number(ver0.sourceVersion || 0) + 1;
  const stmts = [];
  try {
    stmts.push(...customerReplaceStatements(env, 'calcContracts', cid, contracts, batchId));
    stmts.push(...customerReplaceStatements(env, 'calcReservations', cid, reservations, batchId));
    stmts.push(...customerReplaceStatements(env, 'opening', cid, openingRows, batchId));
  } catch (_) { return fail('BUILD_FAILED', 500); }
  const bump = bumpSourceStatement(cid, now);
  stmts.push(env.DB.prepare(bump.sql).bind(...bump.args));
  const inputStmtCount = stmts.length;

  //   ★問題があれば入力だけ入れ替えて世代を進める（作り直しの記録はしない＝名乗らない）。
  //     いまの /quota/build も問題のある会員は書かない（I5）。入力は新しくしておく（定期送信と同じ状態）
  if (!blocked) {
    const gen = clearGenerationStatements(cid)
      .concat(quotaUpsertStatements(built, now, expected))
      .concat(cb.allocStmts);
    for (const g of gen) stmts.push(env.DB.prepare(g.sql).bind(...(g.args || [])));
    const mk = markBuiltStatement(cid, expected, now, {
      quotaRows: built.monthly.length, packRows: built.packs.length, fromMonth: from, toMonth: to,
    }, { coversSeq: seq });
    stmts.push(env.DB.prepare(mk.sql).bind(...mk.args));
  }

  //   ★書く前に文の数を数える（§7-3 の9）
  if (stmts.length > REBUILD_LIMITS.STATEMENTS) {
    return fail('TOO_LARGE', 413, { kind: 'statements', count: stmts.length });
  }

  try {
    await env.DB.batch(stmts);
  } catch (_) {
    //   ★元の例外を出さない（行の中身が入りうる）。batch は全部か無しか
    return fail('WRITE_FAILED', 503);
  }

  //   書いた後の状態（名乗れるか）を返す。★読み直しに失敗しても書き込みは済んでいる
  let after = null;
  try { after = await readSyncVersion(env, cid); } catch (_) { after = null; }
  return res({
    ok: true,
    customer: mask(cid),
    blocked,
    //   ★issue は code だけ（§7-4 の13）
    issues: blocked ? built.issues.map((x) => ({ code: x.code })).concat(cb.allocIssues.map((x) => ({ code: x.code, at: 'alloc' }))) : [],
    statements: stmts.length,
    inputRows: inputStmtCount,
    quotaRows: built.monthly.length,
    packRows: built.packs.length,
    allocRows: cb.al ? cb.al.rows.length : 0,
    overflow: cb.al ? cb.al.skippedUnallocated : 0,
    expected,
    builtVersion: after ? after.builtVersion : null,
    coversSeq: after ? after.coversSeq : null,
    dirtySeq: after ? after.dirtySeq : null,
    ms: Date.now() - t0,
  });
}
