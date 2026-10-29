// 中野の月曜を終日開ける（2026-10-29 オーナー指示）。1曜日だけを変え、他の曜日は本番の値のまま残すかを確かめる。
//   実行: node worker/test/owner-monday.test.js
//
// ★なぜ要るのか
//   固定客に見せる中野の枠は Script Property OWNER_SLOT_WINDOW（曜日→ルール）で絞っている。
//   本番の値はリポジトリから読めない。全曜日を既定で上書きする runSetOwnerSlotWindow を使うと、
//   本番で別の曜日を変えていたときに黙って巻き戻る。だから「読んでから1曜日だけ差し替える」関数にした。
//   未設定のまま1曜日だけ書くと、他の曜日が全部「非表示」になり枠が一斉に消える＝書かずに止める。
//
//   ① 入口から：runOpenOwnerMonday（本物）→ 保存された値。月曜だけ 'all'、他は元のまま
//   ② 書かない場合：未設定・壊れた値・不正な曜日／ルール
//   ③ 保存された値が GAS と Worker の両方で「月曜の朝も出る」になる（Worker は検証を通る）
//   ④ 既定のランナー（runSetOwnerSlotWindow）も月曜は終日
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { inOwnerWindow } from '../src/lib/calslots.js';
import { normalizeOwnerWindow } from '../src/routes/calsync.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LB = readFileSync(join(ROOT, 'gas/LineBooking.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, why) { if (cond) pass++; else { fail++; console.log(`❌ ${name}`); if (why) console.log(`   ${why}`); } }
function pluckFn(src, name) {
  const m = src.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('見つからない: ' + name);
  return m[0];
}

// 本物の関数を、身代わりの Script Properties の上で動かす
function gas(initial) {
  const store = {};
  if (initial !== undefined) store.OWNER_SLOT_WINDOW = initial;
  let writes = 0;
  const ctx = {
    JSON, Math, Number, String, Array, isFinite, Logger: { log: () => {} },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (k in store ? store[k] : null),
      setProperty: (k, v) => { writes++; store[k] = v; },
      deleteProperty: (k) => { delete store[k]; },
    }) },
  };
  vm.createContext(ctx);
  const names = ['_lbProp', '_lbOwnerSlotWindow', '_lbInOwnerWindow', 'setOwnerSlotWindow', 'runSetOwnerSlotWindow',
    '_lbOwnerRuleOk', '_lbOwnerWindowWithDay', 'setOwnerSlotDay', 'runOpenOwnerMonday', 'runOpenOwnerTuesday'];
  vm.runInContext(names.map((n) => (n === '_lbProp' ? LB.match(/function _lbProp\(key\) \{[^\n]*\}/)[0] : pluckFn(LB, n))).join('\n'), ctx);
  return { ctx, store, writes: () => writes };
}

// いまの本番と同じ形（9/6 の既定）＋本番で別の曜日を変えていた想定（水曜 10-12 を追加）
const LIVE = JSON.stringify({ 1: { from: 17, to: 24 }, 2: { from: 17, to: 24 }, 3: { from: 10, to: 12 }, 4: { from: 17, to: 24 }, 5: { from: 17, to: 24 }, 6: 'all' });
// JST の日時（GAS の Date は script timezone＝JST。テストは TZ に依らないよう getDay/getHours を固定値で持つ）
const at = (dow, h) => ({ getDay: () => dow, getHours: () => h });
const jstMs = (y, m, d, h) => Date.UTC(y, m - 1, d, h - 9, 0, 0);

console.log('=== ① 入口から：runOpenOwnerMonday ===');
{
  const g = gas(LIVE);
  const r = g.ctx.runOpenOwnerMonday();
  ok('①-1 書いた', r.ok === true && g.writes() === 1, JSON.stringify(r));
  const saved = JSON.parse(g.store.OWNER_SLOT_WINDOW);
  ok('①-2 ★月曜は終日', saved['1'] === 'all', JSON.stringify(saved));
  const before = JSON.parse(LIVE);
  ok('①-3 ★他の曜日は本番の値のまま（本番で足した水曜も残る）',
    ['0', '2', '3', '4', '5', '6'].every((k) => JSON.stringify(saved[k]) === JSON.stringify(before[k])), JSON.stringify(saved));
  ok('①-4 日曜（キー無し）は増えない', !('0' in saved));
  const win = g.ctx._lbOwnerSlotWindow();
  ok('①-5 ★月曜9時が出る（GAS）', g.ctx._lbInOwnerWindow(at(1, 9), win) === true);
  ok('①-6 火曜9時は出ないまま（GAS）', g.ctx._lbInOwnerWindow(at(2, 9), win) === false);
  ok('①-7 日曜は出ないまま（GAS）', g.ctx._lbInOwnerWindow(at(0, 18), win) === false);
  //   2回走らせても同じ
  g.ctx.runOpenOwnerMonday();
  ok('①-8 2回走らせても同じ値', g.store.OWNER_SLOT_WINDOW === JSON.stringify(saved));
}

console.log('=== ② 書かない場合 ===');
{
  const g = gas(undefined);
  const r = g.ctx.runOpenOwnerMonday();
  ok('②-1 ★未設定なら書かない（書くと他の曜日が全部消える）', r.ok === false && r.reason === 'UNSET' && g.writes() === 0 && !('OWNER_SLOT_WINDOW' in g.store));
  const g2 = gas('{壊れ');
  const r2 = g2.ctx.runOpenOwnerMonday();
  ok('②-2 壊れた値なら書かない', r2.ok === false && r2.reason === 'UNREADABLE' && g2.writes() === 0 && g2.store.OWNER_SLOT_WINDOW === '{壊れ');
  ok('②-3 配列なら書かない', gas('[1]').ctx.runOpenOwnerMonday().reason === 'UNREADABLE');
  //   ★一部だけ壊れた値（Codex 関門②）：Worker が拒否する形が1つでもあれば書かない
  for (const [name, v] of [['曜日以外のキー', { 1: { from: 17, to: 24 }, x: 'all' }], ['無効な文字列', { 1: { from: 17, to: 24 }, 2: 'broken' }],
    ['from 欠損', { 1: { from: 17, to: 24 }, 2: { to: 24 } }], ['小数', { 1: { from: 17, to: 24 }, 2: { from: 17.5, to: 24 } }], ['範囲外', { 2: { from: 17, to: 25 } }]]) {
    const gx = gas(JSON.stringify(v));
    ok('②-2b 一部壊れ（' + name + '）なら書かない', gx.ctx.runOpenOwnerMonday().reason === 'UNREADABLE' && gx.writes() === 0);
  }
  //   GAS が受ける true は通す（Worker も 'all' として受ける）
  ok('②-2c 既存の true は通す', gas(JSON.stringify({ 1: { from: 17, to: 24 }, 6: true })).ctx.runOpenOwnerMonday().ok === true);
  const g3 = gas(LIVE);
  ok('②-4 曜日 7 は拒否', g3.ctx.setOwnerSlotDay(7, 'all').reason === 'BAD_DAY' && g3.writes() === 0);
  ok('②-5 from>=to は拒否', g3.ctx.setOwnerSlotDay(1, { from: 24, to: 17 }).reason === 'BAD_RULE');
  ok('②-6 to>24 は拒否', g3.ctx.setOwnerSlotDay(1, { from: 9, to: 25 }).reason === 'BAD_RULE');
  ok('②-6b 小数の時刻は拒否（Worker が受けない）', g3.ctx.setOwnerSlotDay(1, { from: 9.5, to: 12 }).reason === 'BAD_RULE');
  ok('②-6c 文字の時刻は拒否', g3.ctx.setOwnerSlotDay(1, { from: '9', to: '12' }).reason === 'BAD_RULE');
  ok('②-7 文字列ルールは拒否', g3.ctx.setOwnerSlotDay(1, 'everything').reason === 'BAD_RULE' && g3.writes() === 0);
  //   null＝その曜日を非表示に（戻す用途）
  const r4 = g3.ctx.setOwnerSlotDay(1, null);
  ok('②-8 null はその曜日だけ消す', r4.ok && !('1' in JSON.parse(g3.store.OWNER_SLOT_WINDOW)) && '2' in JSON.parse(g3.store.OWNER_SLOT_WINDOW));
  const r5 = g3.ctx.setOwnerSlotDay(1, { from: 17, to: 24 });
  ok('②-9 元に戻せる（17時〜）', r5.ok && JSON.stringify(JSON.parse(g3.store.OWNER_SLOT_WINDOW)['1']) === '{"from":17,"to":24}');
}

console.log('=== ③ Worker も同じ値で月曜の朝を出す ===');
{
  const g = gas(LIVE);
  g.ctx.runOpenOwnerMonday();
  const payload = JSON.parse(JSON.stringify(g.ctx._lbOwnerSlotWindow()));   // PushToEdge が送る形
  const n = normalizeOwnerWindow(payload);
  ok('③-1 ★Worker の検証を通る（落ちると公開が止まる）', n && n.ok !== false && n.error == null, JSON.stringify(n));
  const win = JSON.parse(n.json);
  //   2026-11-02 は月曜、11-03 は火曜
  ok('③-2 ★Worker：月曜9時が出る', inOwnerWindow(jstMs(2026, 11, 2, 9), win) === true);
  ok('③-3 Worker：火曜9時は出ない', inOwnerWindow(jstMs(2026, 11, 3, 9), win) === false);
  ok('③-4 Worker：火曜18時は出る', inOwnerWindow(jstMs(2026, 11, 3, 18), win) === true);
}

console.log('=== ④ 既定のランナー ===');
{
  const g = gas(undefined);
  g.ctx.runSetOwnerSlotWindow();
  const saved = JSON.parse(g.store.OWNER_SLOT_WINDOW);
  ok('④-1 runSetOwnerSlotWindow も月曜は終日（後で走らせても17時〜に戻らない）', saved['1'] === 'all', JSON.stringify(saved));
  ok('④-2 ★火曜も終日（2026-10-29）', saved['2'] === 'all', JSON.stringify(saved));
  ok('④-3 他の既定は変えていない', JSON.stringify(saved['4']) === '{"from":17,"to":24}' && saved['6'] === 'all' && !('3' in saved) && !('0' in saved));
}

console.log('=== ⑤ 火曜 ===');
{
  const g = gas(LIVE);
  g.ctx.runOpenOwnerMonday();
  const r = g.ctx.runOpenOwnerTuesday();
  const saved = JSON.parse(g.store.OWNER_SLOT_WINDOW);
  ok('⑤-1 ★火曜は終日・月曜も終日のまま', r.ok && saved['2'] === 'all' && saved['1'] === 'all', JSON.stringify(saved));
  ok('⑤-2 他の曜日は本番の値のまま', JSON.stringify(saved['3']) === '{"from":10,"to":12}' && JSON.stringify(saved['4']) === '{"from":17,"to":24}' && !('0' in saved));
  const win = JSON.parse(normalizeOwnerWindow(JSON.parse(g.store.OWNER_SLOT_WINDOW)).json);
  ok('⑤-3 ★Worker：火曜9時が出る', inOwnerWindow(jstMs(2026, 11, 3, 9), win) === true);
  ok('⑤-4 Worker：木曜9時は出ない', inOwnerWindow(jstMs(2026, 11, 5, 9), win) === false);
}

console.log((fail === 0 ? '✅ ' : '⚠️ ') + `中野の月曜 検証: ${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
