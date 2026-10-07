// 契約から「枠」を作る（D1の monthly_quota / ticket_packs を埋めるための純粋関数）
//
//   設計：ops/design/04-booking-to-d1.md 第3版 第3節
//
//   ★なぜ要るのか
//     D1で残数を守るには、まず「枠」が行として存在していなければならない。
//     引当のINSERTは `WHERE EXISTS (SELECT 1 FROM monthly_quota ...)` で親を見るので、
//     枠の行が無い月は**どんな予約も作れない**（fail-closed）。
//
//   ★ここで計算し直さない
//     残数の計算は既に `allocate.js` にあり、GASと1行ずつ揃えてある（allocate-drift の検査）。
//     ここで別の計算を書くと、2つの計算がずれる。**既存の結果を読み替えるだけにする。**
//
//   ★使うのは quota（枠の大きさ）だけで、used は入れない
//     used は引当のトリガーが動かす。ここで入れると二重に数える。
//     既存の予約から引当を作る工程（移行）が、used を正しい値にする。

import { _lbRowsToEntitlements, _lbComputeRemaining } from '../allocate.js';

/** 'YYYY-MM' を1つ進める */
function nextMonthKey(monthKey) {
  const [y, m] = String(monthKey).split('-').map(Number);
  return m >= 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** monthKey が from〜to（両端含む）の範囲に入っているか */
function inRange(monthKey, from, to) {
  return String(monthKey) >= String(from) && String(monthKey) <= String(to);
}

/**
 * 1人ぶんの枠を作る。
 *
 * @param {string} customerId
 * @param {Array}  rows        契約行（`_lbRowsToEntitlements` が受け取る形）
 * @param {Array}  sessions    予約（`_lbComputeRemaining` が受け取る形）
 * @param {object} opening     棚卸し（無ければ null）
 * @param {object} opts        { fromMonth, toMonth, nowKey, targetDateMs, carryRate }
 * @returns {{monthly: Array, packs: Array, issues: Array}}
 *   monthly … [{ customerId, monthKey, quota }]
 *   packs   … [{ packId, customerId, kind, total, validFrom, validTo }]
 *   issues  … 計算が「要確認」を返したときの理由。**空でないときは枠を作らない**
 */
/** 'YYYY-MM' の月の真ん中（15日12時JST）。その月を対象に計算させるための時刻。 */
function midOfMonthMs(monthKey) {
  const [y, m] = String(monthKey).split('-').map(Number);
  return Date.UTC(y, m - 1, 15, 3, 0);   // JST 12:00
}

/**
 * 1人ぶんの枠を作る。
 *
 *   ★月ごとに計算を呼ぶ。
 *     `_lbComputeRemaining` は**対象の月1つぶん**しか返さない（`avail` がその月の枠）。
 *     月をまたぐ枠を取るには、対象の時刻を月ごとに変えて呼ぶしかない。
 *     内部の月別の結果（perMonth）は公開されていないので、そこに手を伸ばさない。
 *     1人あたり数か月ぶん＝数回の呼び出しで済み、計算は純粋関数なので軽い。
 *
 * @param {string} customerId
 * @param {Array}  rows        契約行（`_lbRowsToEntitlements` が受け取る形）
 * @param {Array}  sessions    予約（`_lbComputeRemaining` が受け取る形）
 * @param {object} opening     棚卸し（無ければ null）
 * @param {object} opts        { fromMonth, toMonth, nowKey, carryRate }
 * @returns {{monthly: Array, packs: Array, issues: Array}}
 */
export function buildQuotaForCustomer(customerId, rows, sessions, opening, opts) {
  const { fromMonth, toMonth, nowKey, carryRate } = opts;
  const out = { monthly: [], packs: [], issues: [] };

  // ---- 月額の枠（月ごとに1回ずつ計算する）----
  let hasMonthly = false;
  for (let mk = String(fromMonth), guard = 0; mk <= String(toMonth) && guard < 36; mk = nextMonthKey(mk), guard++) {
    const res = _lbComputeRemaining(
      customerId, rows, sessions, nowKey, midOfMonthMs(mk), carryRate, opening,
      /* legacyMonthlyFirst */ false, /* carryFromContractStart */ true,
    );

    // ★計算が「要確認」なら、その月の枠を作らない（fail-closed）。
    //   壊れた枠を作ると、そこから作られる引当も残数も全部ずれる。
    //   作らなければ、その会員はD1では予約できない＝移行期はGASが受け持つ。
    if (!res || res.ok === false) {
      out.issues.push({ customerId, monthKey: mk, code: 'REMAINING_NOT_OK',
                        detail: JSON.stringify((res && res.issues) || []) });
      continue;
    }
    if (res.hasMonthly) hasMonthly = true;

    // 枠を作るかどうかは **avail（頻度＋繰越）** で決める（2026-10-07 修正）。
    //
    //   ★以前は `freq`（その月の契約の頻度）だけを見ていた。
    //     しかし契約が切れた月でも、**前月までの繰越が残っていれば月額から引ける**。
    //     割当器はそれを正しく monthly と判定するのに、枠の行が無いので
    //     引当の外部キーが通らず、本番の書き込みが落ちた（会員1名で確認）。
    //
    //   「契約の頻度があるか」ではなく「その月に使える回数があるか」が、枠の有無。
    //   avail が 0 なら、その月は1回も使えない＝枠の行を作らない。
    if (!res.hasMonthly) continue;

    const quota = Number(res.avail);
    if (!quota) continue;   // その月に使える回数が無い＝枠は無い
    if (!Number.isFinite(quota) || quota < 0) {
      out.issues.push({ customerId, monthKey: mk, code: 'BAD_QUOTA', detail: String(res.avail) });
      continue;
    }
    out.monthly.push({ customerId, monthKey: mk, quota });
  }

  // ---- チケット（契約行から直接作る。買った単位がそのまま1行）----
  const ent = _lbRowsToEntitlements(rows, carryRate);
  if (ent && ent.issues && ent.issues.length) {
    // 契約の読み取りに問題があるなら、チケットの枠は作らない。
    out.issues.push({ customerId, code: 'ENTITLEMENT_ISSUES', detail: JSON.stringify(ent.issues) });
    return out;
  }
  // ★棚卸しの引継ぎ（移行前に既に使っていた枚数）を拾う。
  //   計算側はこれを「使った数の初期値」にしている（allocate.js の openingPacks）。
  //   D1側は引当だけが used を増やすので、これを別に持たないと残りが多く見える。
  //   店舗は3月オープンだが台帳は9月から。3〜8月の消化はここに入っている。
  const openingPacks = (opening && (opening.packsUsed || opening.packs)) || {};

  const packs = (ent && ent.entitlements && ent.entitlements.packs) || [];
  for (const p of packs) {
    if (!p || !p.packId) continue;
    const total = Number(p.qty);
    if (!Number.isFinite(total) || total < 0) {
      out.issues.push({ customerId, code: 'BAD_PACK_QTY', detail: `${p.packId}=${p.qty}` });
      continue;
    }
    out.packs.push({
      packId: String(p.packId),
      customerId,
      kind: (p.kind === 'pair') ? 'pair' : 'normal',
      total,
      // availableAt は「開始が無い」場合に -8.64e15 が入る（allocate.js:538）。
      // そのまま入れると日付として扱えないので 0 に寄せる。
      validFrom: (p.availableAt > -8e15) ? Number(p.availableAt) : 0,
      validTo: Number(p.expiresAt),
      //   移行前に既に使っていた枚数。無ければ0。
      openingUsed: Math.max(0, Number(openingPacks[String(p.packId)] || 0)),
    });
  }

  return out;
}

/**
 * 枠をD1へ書くための文を組み立てる。
 *
 *   ★`used` を書かない。既にある行の `used` を壊さないため。
 *     枠の大きさ（quota / total）だけを更新する。
 *     使った数はトリガーだけが動かす（設計の不変条件）。
 */
export function quotaUpsertStatements(built, nowMs) {
  const stmts = [];
  for (const m of built.monthly) {
    stmts.push({
      sql: `INSERT INTO monthly_quota (customer_id, month_key, quota, used, updated_at)
            VALUES (?, ?, ?, 0, ?)
            ON CONFLICT(customer_id, month_key) DO UPDATE SET
              quota = excluded.quota, updated_at = excluded.updated_at`,
      args: [m.customerId, m.monthKey, m.quota, nowMs],
    });
  }
  for (const p of built.packs) {
    stmts.push({
      //   opening_used は「移行前に既に使っていた枚数」。棚卸しが直れば更新される。
      //   used（引当で増える数）には触れない＝設計の不変条件を守る。
      sql: `INSERT INTO ticket_packs (pack_id, customer_id, kind, total, used, opening_used, valid_from, valid_to, updated_at)
            VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
            ON CONFLICT(pack_id) DO UPDATE SET
              customer_id = excluded.customer_id, kind = excluded.kind, total = excluded.total,
              opening_used = excluded.opening_used,
              valid_from = excluded.valid_from, valid_to = excluded.valid_to,
              updated_at = excluded.updated_at`,
      args: [p.packId, p.customerId, p.kind, p.total, p.openingUsed, p.validFrom, p.validTo, nowMs],
    });
  }
  return stmts;
}

export { nextMonthKey, inRange };
