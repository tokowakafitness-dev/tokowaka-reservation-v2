// カルテの種目の一覧（全トレーナー・全顧客で共有）と部位の分類・2026-11-06
//
//   ★正本はここ。画面（liff/karte.js の PART_KEYS）と表の CHECK（migrations/0028_karte_exercises.sql）は
//     この鍵と同じ（検査で一致を確かめる＝liff-karte-exercises.test.js）
//   ★種目名は自由文。健康の言葉を入れる場所ではない（I55）。意味の判定はしない（いまのセットの保存と同じ扱い）
//   ★名前の正規化は「前後の空白を落とす・1〜50字」だけ（全角・半角はそのまま）。
//     セットの保存（k_addTraining）は画面が trim した名前を text(…, 50) で受けている＝同じ名前が同じ行に当たる

export const EXERCISE_PARTS = [
  ['chest', '胸'], ['legs', '脚・尻'], ['back', '背中'], ['shoulder', '肩'], ['arm', '腕'], ['core', '体幹'], ['other', 'その他'],
];
export const EXERCISE_LIMITS = { NAME_CHARS: 50, MAX_ROWS: 500 };

const bad = (code) => { throw new RangeError(code); };

/** 種目名：文字列・前後の空白を落として1〜50字。それ以外は 400 */
export function normalizeExerciseName(v) {
  if (typeof v !== 'string') bad('EXERCISE');
  const t = v.trim();
  if (!t || t.length > EXERCISE_LIMITS.NAME_CHARS) bad('EXERCISE');
  return t;
}
/** 部位の鍵：固定表にあるものだけ。それ以外は 400 */
export function normalizePart(v) {
  if (typeof v !== 'string' || !EXERCISE_PARTS.some((p) => p[0] === v)) bad('PART');
  return v;
}
