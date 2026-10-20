// D1 の枠・引当から顧客に答えてよいか（「新しい」と名乗れるか）の定義。★ここ1か所だけ（設計20 §7-7 の3）
//
//   ★なぜ1か所か
//     この判定は、残数の読み取り（remain-from-d1.js）・状態の報告（routes/quota.js）・
//     修復の巡回（/quota/behind）・shadow の preflight（shadow-status.js）の4か所で使う。
//     2026-10-20 まで各所に手書きで複製されていた。1か所だけ直すと、
//     「読み取りは答えないのに、修復は拾わない」会員が永久に取り残される（関門①の指摘）。
//
//   ★条件
//     source_version === built_version  … 入力が変わった後に作り直している
//     built_version > 0                 … 一度は作り直している（0===0 を新しいと読まない）
//     built_covers_seq >= dirty_seq     … 最後の書き込み（通し番号）より後の台帳から作り直している
//
//   このファイルは他を import しない（remain-from-d1.js と sync-version.js の両方から使うため・輪を作らない）。

/** SQL の条件。alias を渡すと「v.source_version」のように表の別名を付ける（JOIN で列名がぶつかるため） */
export function freshSqlFor(alias) {
  const a = alias ? alias + '.' : '';
  return `(${a}source_version = ${a}built_version AND ${a}built_version > 0 AND ${a}built_covers_seq >= ${a}dirty_seq)`;
}

/** SQL の条件（customer_sync_version の列名で書く）。WHERE / CASE に埋め込む */
export const FRESH_SQL = freshSqlFor('');

/** 新しいと名乗れない（修復の巡回が拾う対象） */
export const NOT_FRESH_SQL = `(NOT ${FRESH_SQL})`;

/**
 * JS 側の同じ判定。値は readSyncVersion / readSyncVersionForRemain が返す形。
 *   ★列が無い（migration 0020 の前）・値が読めないときは 0 とみなす＝いまと同じ判定
 *     （dirty も covers も 0 なら 0 >= 0 で、従来の source/built の判定だけが効く）
 */
export function isFreshVersion(v) {
  if (!v) return false;
  const s = Number(v.sourceVersion || 0);
  const b = Number(v.builtVersion || 0);
  const covers = Number(v.coversSeq || 0);
  const dirty = Number(v.dirtySeq || 0);
  if (!(b > 0)) return false;
  if (s !== b) return false;
  return covers >= dirty;
}

/** 新しくない理由（読み取りの状態に使う）。新しければ 'ok' */
export function freshStatus(v) {
  if (!v) return 'no_version_row';
  const s = Number(v.sourceVersion || 0);
  const b = Number(v.builtVersion || 0);
  if (!(b > 0)) return 'not_built';
  if (s !== b) return 'behind';
  if (Number(v.coversSeq || 0) < Number(v.dirtySeq || 0)) return 'behind_write';
  return 'ok';
}
