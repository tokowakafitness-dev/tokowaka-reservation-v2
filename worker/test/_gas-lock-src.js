// 設計47：書き込みのロックの部品（_lbTakeWriteLock 等）を GAS のソースから取り出して返す（検査の vm に一緒に読ませる）
//   ★本物のソースから取り出す（写しを持たない）。関数を足したらここにも足す
export function pluckFnFrom(src, name) {
  const m = src.match(new RegExp('\\nfunction ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('見つからない: ' + name);
  return m[0];
}
export function pluckVarFrom(src, name) {
  const m = src.match(new RegExp('\\nvar ' + name + ' = [\\s\\S]*?;\\n'));
  if (!m) throw new Error('見つからない: ' + name);
  return m[0];
}
export const WRITE_LOCK_FNS = ['_lbUtf8Bytes', '_lbLcDay', '_lbLcMerge', '_lbTakeWriteLock', '_lbWlTally', '_lbWlTallyErr', '_lbWlBusy', '_lbWlFlush'];
export function writeLockSrc(LB) {
  return pluckVarFrom(LB, 'LB_LC') + 'var _LB_LOCK_TALLY = null;\n' + WRITE_LOCK_FNS.map((n) => pluckFnFrom(LB, n)).join('\n') + '\n';
}
