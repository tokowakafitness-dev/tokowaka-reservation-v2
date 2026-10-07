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
  //   computed … 計算が最後まで通ったか。false のときは**何も消さない**。
  //     ok:false は「予約が0件」ではなく「計算できなかった」。
  //     消してしまうと、その会員の引当が全部消え、used が0になって残数が実際より多く見える。
  const out = { rows: [], computed: false, skippedUnallocated: 0, issues: [] };

  const res = _lbComputeRemaining(
    customerId, rows, sessions, nowKey, targetDateMs, carryRate, opening,
    /* legacyMonthlyFirst */ false, /* carryFromContractStart */ true,
  );

  // ★計算が「要確認」なら引当を作らない（fail-closed）。
  //   割り当ての結論そのものが信用できない状態で行を作ると、used が実際とずれる。
  if (!res || res.ok === false) {
    out.issues.push({ customerId, code: 'REMAINING_NOT_OK', detail: JSON.stringify((res && res.issues) || []) });
    return out;   // computed は false のまま＝呼び出し側は何も消さない
  }
  out.computed = true;

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
 *   ★「全部消してから、全部入れる」。
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

  // ① まず、対象期間の引当を**全部消す**（返却のトリガーが used を戻す）
  //
  //   ★「今回見た予約を残す」形にしてはいけない（Codex関門②・4回目）。
  //     NOT IN で残すと、消化先が月額→チケットに変わった予約の古い引当が消えず、
  //     INSERT OR IGNORE も既存行として無視する。**最初の問題に戻る。**
  //     全部消して全部入れ直せば、消化先の変更も、消えた予約も、超過に転じた予約も、
  //     すべて1つの形で正しくなる。
  //
  //   ★消すのは「計算が最後まで通ったとき」だけ。
  //     ok:false は「予約が0件」ではなく「計算できなかった」。
  //     そこで消すと、その会員の引当が全部消えて used が0になり、
  //     残数が実際より**多く**見える＝枠を超えて予約できてしまう。
  if (scope && scope.customerId && scope.fromMonth && scope.toMonth) {
    if (!built.computed) return [];   // 計算できていない＝この会員には何もしない
    stmts.push({
      sql: `DELETE FROM reservation_allocations
             WHERE customer_id = ? AND resv_month >= ? AND resv_month <= ?`,
      args: [scope.customerId, scope.fromMonth, scope.toMonth],
    });
  }

  // ② 入れ直す
  for (const r of built.rows) {
    stmts.push({
      // 直前に全部消しているので衝突しない。OR IGNORE にすると、
      //   消し損ねたときに**黙って古い行が残る**。衝突したら止めるのが正しい。
      sql: `INSERT INTO reservation_allocations
              (reservation_id, customer_id, source, month_key, pack_id, units, resv_month, decided_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [r.reservationId, r.customerId, r.source, r.monthKey, r.packId, r.units, r.resvMonth, nowMs],
    });
  }
  return stmts;
}

export { monthKeyJst };
