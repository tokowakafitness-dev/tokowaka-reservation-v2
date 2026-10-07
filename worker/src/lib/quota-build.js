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

    // 契約がその月を覆っていなければ枠は無い（freq=0・avail=0）。行を作らない。
    //   作ってしまうと「枠0の月」ができ、引当のEXISTSは通るが条件で弾かれる＝
    //   「枠が無い」と「枠が0」が区別できなくなる。
    if (!res.hasMonthly || !Number(res.freq)) continue;

    const quota = Number(res.avail);
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
      sql: `INSERT INTO ticket_packs (pack_id, customer_id, kind, total, used, valid_from, valid_to, updated_at)
            VALUES (?, ?, ?, ?, 0, ?, ?, ?)
            ON CONFLICT(pack_id) DO UPDATE SET
              customer_id = excluded.customer_id, kind = excluded.kind, total = excluded.total,
              valid_from = excluded.valid_from, valid_to = excluded.valid_to,
              updated_at = excluded.updated_at`,
      args: [p.packId, p.customerId, p.kind, p.total, p.validFrom, p.validTo, nowMs],
    });
  }
  return stmts;
}

export { nextMonthKey, inRange };
