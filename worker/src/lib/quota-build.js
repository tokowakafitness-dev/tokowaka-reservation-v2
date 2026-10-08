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

import { _lbRowsToEntitlements, _lbComputeRemaining, _lbPackPrefix } from '../allocate.js';

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

    // 枠を作るかどうかは **計算側の monthlyRem の出し方に合わせる**（2026-10-07）。
    //
    //   経緯：最初は `freq`（その月の契約の頻度）だけを見ていた。
    //     契約が切れた月でも繰越が残っていれば割当器が monthly と判定するため、
    //     枠の行が無く外部キーが通らず、本番の書き込みが落ちた。
    //     そこで `avail`（頻度＋繰越）に変えたが、**今度は計算と食い違った。**
    //
    //   ★計算側の決まり（allocate.js の monthlyRem・2026-10-08 時点）：
    //       契約が無い                  → null（月額の契約が無い。**これだけが null**）
    //       契約が対象月を覆わない      → **0**（繰越があっても使えない）
    //       覆っている（頻度0を含む）   → 枠 − 使った数
    //     ★頻度0は「その月の付与が0回」＝枠は繰越ぶんだけ（設計08・オーナー承認）。
    //       以前は「上限なし（null）」として扱っていた。
    //
    //   つまり **契約が対象月を覆っていなければ、繰越が残っていても残数は0**。
    //   業務上「契約が切れたら使えない」ということ。D1もそれに合わせる。
    //   ただし枠の行そのものは作る（下の coverage を参照）。
    if (!res.hasMonthly) continue;

    const quota = Number(res.avail);
    if (!quota) continue;   // その月に使える回数が無い＝枠は無い

    //   ★契約が対象月を覆っていない月でも、**枠の行は作る**。
    //     作らないと引当の親が無く、外部キーで落ちる（本番で実際に落ちた）。
    //     そのうえで「どう覆っているか」を3状態で持ち、見せる残数は読む側で決める。
    //       uncovered  契約が覆っていない  → 見せる残数 0
    //       limited    覆っている          → 見せる残数 quota − used
    //     ★'unlimited' は 2026-10-08 以降**作られない**（頻度0は「月0回」＝limited）。
    //       それより前に作った行がD1に残りうるので、列と照合側は3状態を扱えるままにする。
    //     1bit（覆っている/いない）では unlimited を uncovered と混同する（0012 に詳述）。
    //     ★計算側（_lbComputeRemaining）が返す coverage をそのまま使う。
    //       ここで freq から導き直すと、同じ取り違えを繰り返す。
    const coverage = res.coverage;
    if (coverage !== 'uncovered' && coverage !== 'limited' && coverage !== 'unlimited') {
      out.issues.push({ customerId, monthKey: mk, code: 'BAD_COVERAGE', detail: String(coverage) });
      continue;
    }
    if (!Number.isFinite(quota) || quota < 0) {
      out.issues.push({ customerId, monthKey: mk, code: 'BAD_QUOTA', detail: String(res.avail) });
      continue;
    }
    out.monthly.push({ customerId, monthKey: mk, quota, coverage });
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

  //   ★棚卸しの鍵を、いまの pack へ**計算側とまったく同じやり方で**割り当てる。
  //     合成ID（CT<from>_<to>_<idx>）はチケットを足すと末尾の番号がずれる。
  //     完全一致だけで引くと、ずれた分が 0 になり、**使えないチケットが使えるように見える**
  //     （Codex関門②の指摘・2026-10-07）。
  //     計算側は「完全一致 → 末尾を除いた prefix が一意に一致」の順で解決している
  //     （allocate.js の opening解決）。同じ関数（_lbPackPrefix）を使って揃える。
  const packsForOpening = (ent && ent.entitlements && ent.entitlements.packs) || [];
  const byPrefix = {};
  for (const pk of packsForOpening) {
    const pfx = _lbPackPrefix(pk.packId);
    if (pfx !== pk.packId) (byPrefix[pfx] = byPrefix[pfx] || []).push(pk);   // 合成IDだけ索引に入れる
  }
  const openingByPackId = {};
  for (const key of Object.keys(openingPacks)) {
    const n = Math.max(0, Number(openingPacks[key] || 0));
    if (packsForOpening.some((x) => x.packId === key)) { openingByPackId[key] = n; continue; }   // ①完全一致
    const kpfx = _lbPackPrefix(key);
    if (kpfx !== key) {
      const cand = byPrefix[kpfx] || [];
      if (cand.length === 1) { openingByPackId[cand[0].packId] = n; continue; }                  // ②prefix が一意に一致
    }
    //   どれにも当たらない／曖昧 ＝ 計算側は停止する（fail-loud）。ここでも問題として残す。
    out.issues.push({ customerId, code: 'OPENING_PACK_UNRESOLVED', detail: key });
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
      //   移行前に既に使っていた枚数。無ければ0。
      //   計算側は opening <= 買った枚数 を要求して、超えたら停止する。ここでも同じにする。
      openingUsed: (() => {
        const n = Math.max(0, Number(openingByPackId[String(p.packId)] || 0));
        if (n > total) { out.issues.push({ customerId, code: 'OPENING_OVER_TOTAL', detail: `${p.packId} ${n}>${total}` }); return total; }
        return n;
      })(),
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
      sql: `INSERT INTO monthly_quota (customer_id, month_key, quota, coverage, used, updated_at)
            VALUES (?, ?, ?, ?, 0, ?)
            ON CONFLICT(customer_id, month_key) DO UPDATE SET
              quota = excluded.quota, coverage = excluded.coverage,
              updated_at = excluded.updated_at`,
      args: [m.customerId, m.monthKey, m.quota, m.coverage, nowMs],
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
