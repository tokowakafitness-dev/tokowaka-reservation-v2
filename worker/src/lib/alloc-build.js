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
//   ★「支払い待ち」として数える理由（GAS の LB_OVERAGE_REASONS と同じ）。
//     入力の誤り（契約の不備など）は数えない。数えると、支払えば解決すると
//     誤って案内することになる。2つの場所に同じ一覧があるので、
//     片方だけ変えないよう検査で固定する（worker/test/overage-reasons.test.js）。
const OVERAGE_REASONS = {
  NO_ENTITLEMENT: 1,          // 使える権利がそもそも無い
  PACK_EXHAUSTED: 1,          // チケットを使い切った
  PACK_EXPIRED: 1,            // チケットの期限が切れていた
  PACK_NOT_YET_AVAILABLE: 1,  // チケットがまだ有効でない（開始日より前の予約）
  PACK_KIND_UNAVAILABLE: 1,   // 種別が合わない（ペア券しか無いのに1名で取った等）
};

export function buildAllocationsForCustomer(customerId, rows, sessions, opening, opts) {
  const { fromMonth, toMonth, nowKey, targetDateMs, carryRate } = opts;
  //   seenIds … 今回「見た」予約のID。行を作らなかったもの（超過・問題あり）も含める。
  //   ★消す対象はこれ。行を作る予約（rows）だけを消すと、
  //     **前回は引当があったが今回は超過に転じた予約**の古い引当が残り、used が過大になる。
  //   computed … 計算が最後まで通ったか。false のときは**何も消さない**。
  //     ok:false は「予約が0件」ではなく「計算できなかった」。
  //     消してしまうと、その会員の引当が全部消え、used が0になって残数が実際より多く見える。
  //   recordsFrom … その会員の「記録開始月」。これより前は完全な予約履歴として扱わない。
  //     ★ここより前に引当が残っていること自体が不整合（2026-10-08・Codex関門①）。
  //       いまの削除は期間内だけなので届かない。recordsFrom は棚卸しの承認・登録月・
  //       LINKED_AT の書き換えで**後から縮む**ため、縮んだぶんが取り残される。
  //   maxResvMonth … その会員の予約がある最も先の月。削除範囲の上端をここまで広げる。
  //     「当月+2」と決め打つと、それより先の予約の引当が取り残される。
  const out = { rows: [], computed: false, skippedUnallocated: 0, issues: [],
                //   月ごとの支払い待ち件数（枠の行に書く・設計10）
                overageByMonth: {},
                recordsFrom: (opening && opening.recordsFrom) ? String(opening.recordsFrom) : null,
                maxResvMonth: null };

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
    //   行を作らない予約（超過・問題あり）も含めて最大月を見る。
    //   削除範囲の上端なので、広いほうに倒す。
    if (/^\d{4}-\d{2}$/.test(mk) && (out.maxResvMonth == null || mk > out.maxResvMonth)) {
      out.maxResvMonth = mk;
    }
    if (!mk || mk < String(fromMonth) || mk > String(toMonth)) continue;   // 対象の範囲だけ

    // 割り当たらなかった＝枠を使っていない。行を作らない（超過として見えるようにする）。
    if (ps.alloc === 'unallocated') {
      out.skippedUnallocated++;
      //   ★月ごとに数える（2026-10-09・段階3-b のため）。
      //     未割当の予約は**引当の行が作られない**ので、D1の3表に現れない。
      //     顧客の画面に出す「支払い待ち」を作るには、枠の行に持たせるしかない。
      //   ★数え方を GAS の _lbOverageOf と同じ規則にする（LB_OVERAGE_REASONS）。
      //     **入力の誤りは数えない。** 数えると、契約の不備を「支払い待ち」として
      //     顧客に見せてしまう（支払えば解決する、という誤った案内になる）。
      if (OVERAGE_REASONS[String(ps.reason || '')]) {
        out.overageByMonth[mk] = (out.overageByMonth[mk] || 0) + 1;
      }
      continue;
    }

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
    //   ★上端は「指定された期間の終わり」と「その会員の予約の最も先の月」の広いほう。
    //     期間を当月+2などと決め打つと、それより先の予約の引当が取り残される
    //     （2026-10-08・Codex関門①）。
    const delTo = (built.maxResvMonth && built.maxResvMonth > scope.toMonth)
      ? built.maxResvMonth : scope.toMonth;
    stmts.push({
      sql: `DELETE FROM reservation_allocations
             WHERE customer_id = ? AND resv_month >= ? AND resv_month <= ?`,
      args: [scope.customerId, scope.fromMonth, delTo],
    });

    //   ★記録開始月より前に残っている引当も消す（2026-10-08・Codex関門①）。
    //     上の削除は期間で絞るので届かない。recordsFrom は固定ではなく、
    //     棚卸しの承認・会員の登録月・LINKED_AT の書き換えで**後から縮む**。
    //     縮んだぶんの古い引当が残ると、used が過大なまま＝残数が実際より少なく見える。
    //     記録開始月より前は「完全な予約履歴として扱わない領域」なので、
    //     引当が存在すること自体が不整合。
    //     ★recordsFrom が分からないときは消さない（範囲が決まらないのに消すほうが危険）。
    if (built.recordsFrom && /^\d{4}-\d{2}$/.test(built.recordsFrom)) {
      stmts.push({
        sql: `DELETE FROM reservation_allocations
               WHERE customer_id = ? AND resv_month < ?`,
        args: [scope.customerId, built.recordsFrom],
      });
    }

    // ★期間の外に残っている「いま入れようとしている予約」も消す（Codex関門②・5回目）。
    //   予約の日付が期間の外から中へ変わると、古い引当は期間外のまま残る。
    //   上の DELETE は期間で絞るので届かず、同じ主キーの INSERT が衝突して
    //   **バッチ全体が失敗する**＝流し直しが通らず、古い状態のまま止まる。
    //   入れる予約のIDで直接消しておけば、どこに残っていても片づく。
    //   ★差し込みの数に上限がある（D1）。多すぎると文が通らないので小分けにする。
    //     1顧客の引当がこの数を超えることは当面無いが、無言で落ちるより分けておく。
    //   ★ここで消すのは「この会員の」引当だけ。予約IDが別の会員へ移った場合は
    //     消せず衝突するが、実務上その経路は無い（IDは予約に紐づき、会員は変わらない）。
    //     起きたらバッチ全体が失敗して止まるので、黙って壊れることはない。
    const ids = built.rows.map((r) => r.reservationId);
    const CHUNK = 80;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const part = ids.slice(i, i + CHUNK);
      stmts.push({
        sql: `DELETE FROM reservation_allocations
               WHERE customer_id = ? AND reservation_id IN (${part.map(() => '?').join(',')})`,
        args: [scope.customerId, ...part],
      });
    }
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
