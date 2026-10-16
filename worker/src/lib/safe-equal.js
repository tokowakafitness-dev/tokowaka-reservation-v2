/**
 * 合言葉の照合。長さや中身で**処理時間が変わらない**ように比べる。
 * 普通の === は一致しない位置で打ち切るため、時間差から1文字ずつ当てられる。
 *
 * ⚠️ 2026-10-16 時点で、同じ関数が routes/ の5ファイルに別々に書かれている
 *    （calcompare / ingest / verify / jobs / calsync）。
 *    新しく書くものはここを使う。既存5つを寄せる作業は別途。
 */
export function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a || ''));
  const y = new TextEncoder().encode(String(b || ''));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}
