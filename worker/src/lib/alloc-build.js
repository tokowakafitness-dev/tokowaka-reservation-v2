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
 *   rows … [{ reservationId, customerId, source, monthKey, packId, units, resvMonth }]
 */
export function buildAllocationsForCustomer(customerId, rows, sessions, opening, opts) {
  const { fromMonth, toMonth, nowKey, targetDateMs, carryRate } = opts;
  //   seenIds … 今回「見た」予約のID。行を作らなかったもの（超過・問題あり）も含める。
  //   ★消す対象はこれ。行を作る予約（rows）だけを消すと、
  //     **前回は引当があったが今回は超過に転じた予約**の古い引当が残り、used が過大になる。
  const out = { rows: [], seenIds: [], skippedUnallocated: 0, issues: [] };

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

    // ★対象の範囲に入った時点で「見た」とみなす。この先どう転んでも、古い引当は消す。
    out.seenIds.push(String(ps.sessionId));

    // 割り当たらなかった＝枠を使っていない。行を作らない（超過として見えるようにする）。
    if (ps.alloc === 'unallocated') { out.skippedUnallocated++; continue; }

    // 振替は枠もチケットも使わない。引当の行としては残すが、親は指さない。
    if (ps.alloc === 'transfer') {
      out.rows.push({ reservationId: String(ps.sessionId), customerId,
                      source: 'transfer', monthKey: null, packId: null, units: 1, resvMonth: mk });
      continue;
    }

    if (ps.alloc === 'monthly') {
      out.rows.push({ reservationId: String(ps.sessionId), customerId,
                      source: 'monthly', monthKey: mk, packId: null, units: 1, resvMonth: mk });
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
                      source, monthKey: null, packId: String(ps.packId), units, resvMonth: mk });
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
  //
  //   ★消し方は「期間で絞って、今回見なかったものを落とす」（差分）。
  //     「今回見た予約を消す」だけでは足りない。次のどれも seenIds に現れないため：
  //       ・予約が削除された
  //       ・日付が変わって対象期間の外へ移った
  //       ・計算が要確認（ok:false）で perSession が出なかった
  //     これらの古い引当が残ると used が過大になり、**残数が実際より少なく見えて
  //     予約できなくなる**（Codex関門②の指摘・2026-10-07）。
  //
  //   resv_month（予約が属する月）で期間を絞る。month_key は月額専用なので使えない。
  if (scope && scope.customerId && scope.fromMonth && scope.toMonth) {
    const keep = (built.seenIds && built.seenIds.length) ? built.seenIds : [];
    const notIn = keep.length ? ` AND reservation_id NOT IN (${keep.map(() => '?').join(',')})` : '';
    stmts.push({
      sql: `DELETE FROM reservation_allocations
             WHERE customer_id = ? AND resv_month >= ? AND resv_month <= ?${notIn}`,
      args: [scope.customerId, scope.fromMonth, scope.toMonth, ...keep],
    });
  }

  // ② 入れ直す
  for (const r of built.rows) {
    stmts.push({
      sql: `INSERT OR IGNORE INTO reservation_allocations
              (reservation_id, customer_id, source, month_key, pack_id, units, resv_month, decided_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [r.reservationId, r.customerId, r.source, r.monthKey, r.packId, r.units, r.resvMonth, nowMs],
    });
  }
  return stmts;
}

export { monthKeyJst };
