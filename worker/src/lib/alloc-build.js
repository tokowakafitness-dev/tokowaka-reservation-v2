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
 *   ★「消してから入れる」。
 *     `INSERT OR IGNORE` だけだと、**壊れはしないが正しくもならない**。
 *     既にある引当は無視されるので、契約を直して流し直しても消化先が古いまま残る。
 *     一方で枠（quota）は流すたびに最新になるため、**枠は新しく used は古い**という
 *     ちぐはぐな状態が生まれ、残数が実際とずれる（Codex関門②の指摘・2026-10-07）。
 *
 *     DELETE → INSERT にすると、返却のトリガーが used を戻し、消費のトリガーが入れ直す。
 *     どちらも同じバッチの中なので、途中で止まれば両方とも無かったことになる。
 *
 *   ★消す範囲は「この会員の、この期間の引当」だけ。
 *     他の会員や他の月の引当に触れない。
 */
export function allocationInsertStatements(built, nowMs, scope) {
  const stmts = [];

  // ① まず消す（返却のトリガーが used を戻す）
  if (scope && scope.customerId && scope.fromMonth && scope.toMonth) {
    //   月額は month_key で、チケット・振替は予約の月で絞れないため、
    //   **この会員の引当のうち、今回作り直す予約のぶんだけ**を消す。
    //   作り直す予約の一覧は built.rows に入っている。
    const ids = built.rows.map((r) => r.reservationId);
    if (ids.length) {
      stmts.push({
        sql: `DELETE FROM reservation_allocations
               WHERE customer_id = ? AND reservation_id IN (${ids.map(() => '?').join(',')})`,
        args: [scope.customerId, ...ids],
      });
    }
  }

  // ② 入れ直す
  for (const r of built.rows) {
    stmts.push({
      sql: `INSERT OR IGNORE INTO reservation_allocations
              (reservation_id, customer_id, source, month_key, pack_id, units, decided_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [r.reservationId, r.customerId, r.source, r.monthKey, r.packId, r.units, nowMs],
    });
  }
  return stmts;
}

export { monthKeyJst };
