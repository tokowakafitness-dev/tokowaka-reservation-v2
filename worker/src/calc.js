// D1の写しから、残数計算の入力を組み立てる。
//
//   ★ここが一番壊れやすい。計算本体（allocate.js）はGASと1文字も同じだが、
//     入力の作り方がずれれば、同じ関数でも違う答えが出る。
//     GAS側（_lbSplitRemaining）が何を渡しているかと、1対1で対応させること。
//
//   GAS側:
//     rows     = _lbContractRowsAll(...)  … [{ row, cols, start:Date, end:Date, idx }]
//     sessions = _lbResvSessions(customerId) … _lbResvValsToSessions(台帳の値, id, 日付の解釈)
//     opening  = _lbMemberOpeningWithFloor(customerId)
//     → _lbComputeRemaining(customerId, rows, sessions, nowKey, tMs, 繰越率, opening)

import { _lbComputeRemaining, _lbResvValsToSessions } from './allocate.js';

const DAY = 86400000;

// GASと同じ「その月」の出し方（日本時間）
function monthKeyJst(ms) {
  const d = new Date(ms + 9 * 3600000);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

/**
 * 計算に必要な材料を、写しから読み出す。
 * 足りないもの・古すぎるものがあれば null を返す＝画面はGASに聞き直す。
 */
export async function loadCalcInput(env, customerId) {
  const [meta, contractRows, resvRows, opening, sync] = await Promise.all([
    env.DB.prepare("SELECT payload FROM calc_meta WHERE key = 'contract_cols'").first(),
    env.DB.prepare(
      `SELECT idx, row_json, start_ms, end_ms FROM calc_contract_rows
        WHERE customer_id = ? ORDER BY idx`                      // ★行順が束の見分けに効く
    ).bind(customerId).all(),
    env.DB.prepare(
      'SELECT row_json FROM calc_reservation_rows WHERE customer_id = ?'
    ).bind(customerId).all(),
    env.DB.prepare('SELECT payload FROM member_opening WHERE customer_id = ?').bind(customerId).first(),
    env.DB.prepare("SELECT key, synced_at FROM sync_state WHERE key IN ('calcContracts','calcReservations','opening')").all(),
  ]);

  if (!meta) return { ok: false, reason: 'NO_META' };

  let cols;
  try { cols = JSON.parse(meta.payload).cols; } catch (_) { return { ok: false, reason: 'BAD_META' }; }
  if (!cols || cols.name == null) return { ok: false, reason: 'BAD_META' };

  // 3つとも新しくないと計算しない。契約だけ新しく予約が古い、の組み合わせで誤った残数を出さないため。
  const now = Date.now();
  const bykey = {};
  for (const r of (sync.results || [])) bykey[r.key] = Number(r.synced_at || 0);
  for (const k of ['calcContracts', 'calcReservations', 'opening']) {
    if (!bykey[k]) return { ok: false, reason: 'NOT_SYNCED:' + k };
    if (now - bykey[k] > 2 * 3600000) return { ok: false, reason: 'STALE:' + k };   // 2時間以上古い
  }

  const rows = [];
  for (const r of (contractRows.results || [])) {
    let vals;
    try { vals = JSON.parse(r.row_json); } catch (_) { return { ok: false, reason: 'BAD_CONTRACT_ROW' }; }
    rows.push({
      row: vals,
      cols,
      start: (r.start_ms == null) ? null : new Date(Number(r.start_ms)),
      end:   (r.end_ms   == null) ? null : new Date(Number(r.end_ms)),
      idx: Number(r.idx),
    });
  }

  // 予約は「台帳の行の並び」をそのまま渡す。GASと同じ関数で組み立てる。
  //   日付欄はGASが解釈したミリ秒で入っているので、そのまま Date にする。
  const vals = [];
  for (const r of (resvRows.results || [])) {
    try { vals.push(JSON.parse(r.row_json)); } catch (_) { return { ok: false, reason: 'BAD_RESV_ROW' }; }
  }
  const sessions = _lbResvValsToSessions(vals, customerId, (v) => (v == null ? null : new Date(Number(v))));

  let openingObj = null;
  if (opening) { try { openingObj = JSON.parse(opening.payload); } catch (_) { openingObj = null; } }

  return { ok: true, rows, sessions, opening: openingObj, syncedAt: Math.min(...Object.values(bykey)) };
}

/**
 * GASの _lbSplitRemaining と同じものを返す。
 *   targetMs を渡すと「その日時に予約するとき」の残数になる（月をまたぐ判定に効く）。
 */
export async function splitRemaining(env, customerId, targetMs, carryRate) {
  const input = await loadCalcInput(env, customerId);
  if (!input.ok) return { _unavailable: input.reason };

  const now = Date.now();
  const nowKey = monthKeyJst(now);
  const tMs = (typeof targetMs === 'number' && isFinite(targetMs)) ? targetMs : now;
  const rate = (typeof carryRate === 'number' && carryRate > 0) ? carryRate : 1 / 3;

  const a = _lbComputeRemaining(customerId, input.rows, input.sessions, nowKey, tMs, rate, input.opening);

  return {
    hasMonthly: a.hasMonthly, hasTicket: a.hasTicket, monthlyRow: null, _sessions: input.sessions,
    monthlyRem: a.monthlyRem, ticketTotal: a.ticketTotal, ticketRem: a.ticketRem,
    ticketPacks: a.ticketPacks || [],
    ticketRemPair: a.ticketRemPair || 0, ticketRemNormal: a.ticketRemNormal || 0,
    pairPackMax: a.pairPackMax || 0,
    freq: a.freq, avail: a.avail, _ok: a.ok, _issues: a.issues,
    _raw: a,                                 // 突合のために計算結果そのものも返す
    _syncedAt: input.syncedAt,
  };
}

export const _forTest = { monthKeyJst, DAY };
