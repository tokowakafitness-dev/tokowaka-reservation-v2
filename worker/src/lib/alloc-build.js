// 既存の予約から「引当」を作る（段階3-a の土台・2026-10-07）
//
//   設計：ops/design/04-booking-to-d1.md 第3版 第3節・第10節
//
//   ★何をするところか
//     いま枠（monthly_quota / ticket_packs）はあるが、`used` は 0 のまま。
//     実際には予約が入って消化されているので、その1件ずつを**引当の行**にする。
//     引当を入れるとトリガーが `used` を増やす＝実際の値になる。
//
//   ★ここで割り当て方を決め直さない
//     どの予約がどこから引かれたかは、既に `allocate.js` が決めている（`perSession`）。
//     ここで決め直すと、GASの残数とD1の残数が「実装の違い」でずれる。
//     **既存の結論をそのまま行に写すだけ。**
//
//   ★割り当たらなかった予約（unallocated）は行を作らない
//     残数が足りずに超過している予約がこれにあたる（決定0068：超過は見せる）。
//     引当が無い＝枠を使っていない、という記録になり、超過として数えられる。
//     行を作ってしまうと、枠を超えて used が増え、超過が見えなくなる。

import { _lbComputeRemaining } from '../allocate.js';

/** 'YYYY-MM'（JST） */
function monthKeyJst(ms) {
  const d = new Date(ms + 9 * 3600000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * 1人ぶんの引当を組み立てる。
 *
 * @returns {{rows: Array, skippedUnallocated: number, issues: Array}}
 *   rows … [{ reservationId, customerId, source, monthKey, packId, units }]
 */
export function buildAllocationsForCustomer(customerId, rows, sessions, opening, opts) {
  const { fromMonth, toMonth, nowKey, targetDateMs, carryRate } = opts;
  const out = { rows: [], skippedUnallocated: 0, issues: [] };

  const res = _lbComputeRemaining(
    customerId, rows, sessions, nowKey, targetDateMs, carryRate, opening,
    /* legacyMonthlyFirst */ false, /* carryFromContractStart */ true,
  );

  // ★計算が「要確認」なら引当を作らない（fail-closed）。
  //   割り当ての結論そのものが信用できない状態で行を作ると、used が実際とずれる。
  if (!res || res.ok === false) {
    out.issues.push({ customerId, code: 'REMAINING_NOT_OK', detail: JSON.stringify((res && res.issues) || []) });
    return out;
  }

  const per = Array.isArray(res.perSession) ? res.perSession : [];
  for (const ps of per) {
    if (!ps || !ps.sessionId) continue;
    const mk = String(ps.monthKey || '');
    if (!mk || mk < String(fromMonth) || mk > String(toMonth)) continue;   // 対象の範囲だけ

    // 割り当たらなかった＝枠を使っていない。行を作らない（超過として見えるようにする）。
    if (ps.alloc === 'unallocated') { out.skippedUnallocated++; continue; }

    // 振替は枠もチケットも使わない。引当の行としては残すが、親は指さない。
    if (ps.alloc === 'transfer') {
      out.rows.push({ reservationId: String(ps.sessionId), customerId,
                      source: 'transfer', monthKey: null, packId: null, units: 1 });
      continue;
    }

    if (ps.alloc === 'monthly') {
      out.rows.push({ reservationId: String(ps.sessionId), customerId,
                      source: 'monthly', monthKey: mk, packId: null, units: 1 });
      continue;
    }

    if (ps.alloc === 'pack') {
      if (!ps.packId) { out.issues.push({ customerId, code: 'PACK_ID_MISSING', detail: String(ps.sessionId) }); continue; }
      // ペアは人数ぶん引く（2名=2・1名=1）。通常は1。
      const units = Number(ps.units != null ? ps.units : 1);
      const source = (ps.packKind === 'pair') ? 'pair' : 'ticket';
      if (!Number.isFinite(units) || units < 1 || (source !== 'pair' && units !== 1) || (source === 'pair' && units > 2)) {
        out.issues.push({ customerId, code: 'BAD_UNITS', detail: `${ps.sessionId}=${ps.units}` });
        continue;
      }
      out.rows.push({ reservationId: String(ps.sessionId), customerId,
                      source, monthKey: null, packId: String(ps.packId), units });
      continue;
    }

    out.issues.push({ customerId, code: 'UNKNOWN_ALLOC', detail: `${ps.sessionId}=${ps.alloc}` });
  }

  return out;
}

/**
 * 引当をD1へ入れる文を組み立てる。
 *
 *   ★INSERT OR IGNORE にする。
 *     reservation_id は主キーなので、同じ予約を二度入れようとしても2件目は何もしない。
 *     ここで `ON CONFLICT DO UPDATE` にすると、**トリガーが二度動いて used が二重に増える**。
 *     （作り直したいときは、先に消してから入れる＝返却のトリガーが正しく戻す）
 */
export function allocationInsertStatements(built, nowMs) {
  return built.rows.map((r) => ({
    sql: `INSERT OR IGNORE INTO reservation_allocations
            (reservation_id, customer_id, source, month_key, pack_id, units, decided_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [r.reservationId, r.customerId, r.source, r.monthKey, r.packId, r.units, nowMs],
  }));
}

export { monthKeyJst };
