import { isFreshVersion } from './fresh.js';
// 会員ごとの世代（段階3-b 手順1・2026-10-09）
//
//   「このD1の行は、いまの入力から作り直したものか」を判定する土台。
//   なぜ時刻では判定できないかは migrations/0014 のコメントに書いた。
//
//   ★ここは文（SQL）を**組み立てて返す**だけにしてある。
//     呼ぶ側が、行の書き込みと同じ batch に入れられるようにするため。
//     別の batch にすると「行は書けたが世代は増えていない」状態が残り、
//     古い行を「新しい」と判定して顧客に見せる経路ができる。

// 計算の入力になる表だけを数える。
//   ★ここに無い表（予約の写し・残数の写し・体組成など）が変わっても世代は増やさない。
//     増やしすぎると source > built が常態化し、いつまでもD1から答えられない
//     ＝3-b が働かなくなる。逆に入れ忘れると古い値を顧客に出す。
//     どちらも害があるので、loadCalcInput が読んでいる表と**1対1で合わせる**。
export const QUOTA_INPUT_KINDS = {
  calcContracts: 1,     // calc_contract_rows
  calcReservations: 1,  // calc_reservation_rows
  opening: 1,           // member_opening
};

// 全員ぶんを進める入力（会員で分かれていないもの）
//   calc_meta は契約表の列の並び。変わると全員の計算が変わる。
export const QUOTA_INPUT_GLOBAL_KINDS = { calcMeta: 1 };

/** 入力の種別が世代に関わるか */
export function affectsQuotaInput(kind) {
  return !!QUOTA_INPUT_KINDS[String(kind || '')];
}
export function affectsQuotaInputGlobally(kind) {
  return !!QUOTA_INPUT_GLOBAL_KINDS[String(kind || '')];
}

/**
 * その会員の source_version を1つ進める文。
 *   既に行があれば +1、無ければ 1 から始める（0 にしない。
 *   0 のままだと built_version の既定値 0 と一致し「新しい」と誤判定する）。
 */
export function bumpSourceStatement(customerId, nowMs) {
  return {
    sql: `INSERT INTO customer_sync_version
            (customer_id, source_version, built_version, source_at, updated_at)
          VALUES (?, 1, 0, ?, ?)
          ON CONFLICT(customer_id) DO UPDATE SET
            source_version = customer_sync_version.source_version + 1,
            source_at = excluded.source_at,
            updated_at = excluded.updated_at`,
    args: [String(customerId), Number(nowMs), Number(nowMs)],
  };
}

/**
 * 全員の source_version を1つ進める文（会員で分かれていない入力が変わったとき）。
 *   ★行が無い会員は進まない。進める必要も無い（まだ一度も作り直していない
 *     ＝built_version が無いので、どちらにしても答えない側に倒れる）。
 */
export function bumpAllSourceStatement(nowMs) {
  return {
    sql: `UPDATE customer_sync_version
             SET source_version = source_version + 1,
                 source_at = ?, updated_at = ?`,
    args: [Number(nowMs), Number(nowMs)],
  };
}

/**
 * 作り直しが取り込んだ世代を書く文。version は**作り直しが読んだ** source_version。
 *
 *   ★この1文の中で「いまの source_version」と比べる（2026-10-09・Codex関門②の2周目）。
 *
 *   なぜ外で比べてはいけないか：
 *     作り直しが同時に2本走ると、**古い方が後に書き終わる**ことがある。
 *       A が世代10を読む → 入力が来て11 → B が11を読んで枠を書き built=11 →
 *       A が古い枠で上書き → A の markBuilt が MAX(11,10)=11 のまま
 *       ＝**行は世代10の内容なのに source===built で「新しい」と見える。**
 *     書いたあとに読み直して倒す作りにもしてみたが、**batch が終わってから
 *     倒すまでに窓が開く**。その間にWorkerが終われば、誤った「新しい」が残り続ける。
 *     さらに、倒す文は正しい方のビルドを倒しうる。
 *
 *   だから枠・引当と**同じ batch の中で**判定する：
 *     いまの source が、自分が読んだ世代と同じ   → built を進める（＝自分が最後に書いた）
 *     違う                                       → built を 0 に落とす（＝答えない）
 *   どちらの順序で終わっても、**最後に枠を書いた方の世代**が印として残る。
 *
 *   ★MAX は同じ世代から同時に作り直した2本のためだけに残す（巻き戻し防止）。
 */
export function markBuiltStatement(customerId, version, nowMs, rows, opts) {
  //   ★通し番号（設計20・決定0091）。/quota/rebuild だけが coversSeq を渡す。
  //     ほかの作り直し（/quota/build・深夜・作業依頼）は渡さない＝built_covers_seq を**変えない**（§7-1 の4）。
  //     渡したときも、source の比較に通ったときだけ MAX で進める（競合で built=0 に倒すときは動かさない）。
  const cs = (opts && Number.isSafeInteger(opts.coversSeq) && opts.coversSeq > 0) ? opts.coversSeq : null;
  //   ★書いた行数も一緒に入れる（2026-10-09・設計13）。
  //     枠とパックを**別々に**数える。1つの合計にすると
  //     「枠が1行足りず、パックが1行多い」が打ち消し合って通る。
  //   ★読む側は、読めた行数がこれと一致しないときだけ「答えない」。
  //     そうしないと、行に世代を書き忘れたとき
  //     **月額会員の画面から残数が消える**（0行でも「契約なし」として答えてしまう）。
  const qr = (rows && rows.quotaRows != null) ? Number(rows.quotaRows) : null;
  const pr = (rows && rows.packRows != null) ? Number(rows.packRows) : null;
  //   ★どの範囲で作ったかも保存する。照合が主キーの集合を突き合わせるのに要る
  //     （範囲は会員ごと・実行ごとに違うので、あとから推測できない）。
  const fm = (rows && rows.fromMonth) ? String(rows.fromMonth) : null;
  const tm = (rows && rows.toMonth) ? String(rows.toMonth) : null;
  return {
    sql: `INSERT INTO customer_sync_version
            (customer_id, source_version, built_version, built_at, updated_at,
             built_quota_rows, built_pack_rows, built_from_month, built_to_month, built_covers_seq)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(customer_id) DO UPDATE SET
            --   ★built_covers_seq と dirty_since は built_version より**前**に書く（SQLite の UPDATE SET は
            --     右辺に更新前の値を使うので順番は結果に影響しないが、読み手のために判定の元を先に置く）
            built_covers_seq = CASE
              WHEN ? IS NOT NULL AND customer_sync_version.source_version = excluded.built_version
                THEN MAX(customer_sync_version.built_covers_seq, ?)
              ELSE customer_sync_version.built_covers_seq
            END,
            dirty_since = CASE
              WHEN ? IS NOT NULL AND customer_sync_version.source_version = excluded.built_version
                   AND MAX(customer_sync_version.built_covers_seq, ?) >= customer_sync_version.dirty_seq
                THEN NULL
              ELSE customer_sync_version.dirty_since
            END,
            built_version = CASE
              WHEN customer_sync_version.source_version = excluded.built_version
                THEN MAX(customer_sync_version.built_version, excluded.built_version)
              ELSE 0
            END,
            built_at = CASE
              WHEN customer_sync_version.source_version = excluded.built_version
                   AND excluded.built_version > customer_sync_version.built_version
                THEN excluded.built_at ELSE customer_sync_version.built_at END,
            --   ★競合で世代を 0 に倒すときは、件数も NULL に落とす。
            --     でないと「世代0・件数あり」というちぐはぐな行が残る。
            built_quota_rows = CASE
              WHEN customer_sync_version.source_version = excluded.built_version
                THEN excluded.built_quota_rows ELSE NULL END,
            built_pack_rows = CASE
              WHEN customer_sync_version.source_version = excluded.built_version
                THEN excluded.built_pack_rows ELSE NULL END,
            built_from_month = CASE
              WHEN customer_sync_version.source_version = excluded.built_version
                THEN excluded.built_from_month ELSE NULL END,
            built_to_month = CASE
              WHEN customer_sync_version.source_version = excluded.built_version
                THEN excluded.built_to_month ELSE NULL END,
            updated_at = excluded.updated_at`,
    args: [String(customerId), Number(version), Number(version), Number(nowMs), Number(nowMs),
           qr, pr, fm, tm, cs == null ? 0 : cs,
           cs, cs, cs, cs],
  };
}

/** いまの世代を読む（行が無ければ 0/0） */
export async function readSyncVersion(env, customerId) {
  const r = await env.DB.prepare(
    `SELECT source_version, built_version, source_at, built_at,
            built_quota_rows, built_pack_rows, built_from_month, built_to_month,
            dirty_seq, built_covers_seq, dirty_since
       FROM customer_sync_version WHERE customer_id = ?`
  ).bind(String(customerId)).first();
  if (!r) return { sourceVersion: 0, builtVersion: 0, sourceAt: null, builtAt: null,
                   quotaRows: null, packRows: null, fromMonth: null, toMonth: null,
                   dirtySeq: 0, coversSeq: 0, dirtySince: null, exists: false };
  return {
    dirtySeq: Number(r.dirty_seq || 0),
    coversSeq: Number(r.built_covers_seq || 0),
    dirtySince: r.dirty_since == null ? null : Number(r.dirty_since),
    sourceVersion: Number(r.source_version || 0),
    builtVersion: Number(r.built_version || 0),
    sourceAt: r.source_at == null ? null : Number(r.source_at),
    builtAt: r.built_at == null ? null : Number(r.built_at),
    quotaRows: r.built_quota_rows == null ? null : Number(r.built_quota_rows),
    packRows: r.built_pack_rows == null ? null : Number(r.built_pack_rows),
    fromMonth: r.built_from_month == null ? null : String(r.built_from_month),
    toMonth: r.built_to_month == null ? null : String(r.built_to_month),
    exists: true,
  };
}

/**
 * D1の行から顧客に答えてよいか。
 *   ★行が無い（exists=false）ときは答えない。
 *     「まだ一度も作り直していない」のと「作り直し済み」を 0===0 で
 *     同じに扱うと、枠が無い会員に 0回 と答えてしまう。
 */
export function isFresh(v) {
  if (!v || !v.exists) return false;
  return isFreshVersion(v);   // ★定義は fresh.js の1か所だけ（設計20 §7-7 の3）
}

/**
 * 書き込みがあったことを記録する文（設計20 §2-2・決定0091）。写し（home）の送信と**同じ batch** に入れる。
 *   dirty_seq は MAX で更新する＝同じ写しを再送しても変わらない（+1 にすると再送で二重に進む・関門①）。
 *   dirty_since は「追いついていた状態から初めて外れた」ときだけ今の時刻。追加の書き込みでは動かさない。
 *   ★行が無い会員にも 0/0 の行を作る。作らないと、新しい会員の最初の作り直しが古い台帳で行を作ったとき
 *     （書き込みの印が「行が無い」で落ちた後）に、古いのに新しいと名乗れる。
 *     0/0 の行は not_built＝答えない。修復の巡回（/quota/behind）は source_version > 0 の会員だけを拾う
 *     （一度も計算入力が来ていない会員＝契約の無い会員を15分ごとに積み続けないため）。
 */
export function dirtyStatement(customerId, seq, nowMs) {
  return {
    sql: `INSERT INTO customer_sync_version
            (customer_id, source_version, built_version, updated_at, dirty_seq, built_covers_seq, dirty_since)
          VALUES (?, 0, 0, ?, ?, 0, ?)
          ON CONFLICT(customer_id) DO UPDATE SET
            dirty_since = CASE
              WHEN customer_sync_version.dirty_since IS NOT NULL THEN customer_sync_version.dirty_since
              WHEN MAX(customer_sync_version.dirty_seq, excluded.dirty_seq) > customer_sync_version.built_covers_seq
                THEN excluded.updated_at
              ELSE NULL
            END,
            dirty_seq = MAX(customer_sync_version.dirty_seq, excluded.dirty_seq),
            updated_at = excluded.updated_at`,
    args: [String(customerId), Number(nowMs), Number(seq), Number(nowMs)],
  };
}

/* 2026-10-09：forceStaleStatement（書いたあとに倒す文）は捨てた。
 *   batch の外で倒すと窓が開き、正しい方のビルドを倒す経路もできる。
 *   判定は markBuiltStatement の中（枠と同じ batch）で行う。
 */
