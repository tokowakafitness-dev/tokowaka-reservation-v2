// 「答えられなかったもの」が空の成功になっていないかの検証（2026-10-03・Codexレビュー）
//
//   ★なぜ要るのか
//     Workerが答えられないときはGASへ落ちる作りになっており、_fallback も _part も
//     正しく fail-closed だった。ところが**その手前**で、形の壊れた写しを
//     「読めた」として受け取ってしまう経路が残っていた。
//
//       member_home に {"current":{}}      → pairRemaining || 0 で「残り0回」
//       slots_cache に {"rules":{...}}     → slots が無いので「空きがありません」
//
//     どちらも computed_at が新しければ鮮度の安全弁も働かない。
//     **遅いより悪い。** 欠けているものを 0 に変換しない。
//
//     あわせて、予約一覧の鮮度が「1人ぶんの押し出し」で若返る問題も固定する。
//     これは残数で禁止した 2026-09-29 の穴と同じ形が、別の表で残っていたもの。
//
//   実行: node worker/test/empty-success-guard.test.js

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readHome } from '../src/routes/boot.js';
import { _forTest as slotsTest } from '../src/routes/slots.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');

let pass = 0, fail = 0;
function eq(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log(`❌ ${name}\n   got : ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`); }
}
function ok(name, cond, extra) { cond ? pass++ : (fail++, console.log(`❌ ${name}${extra ? '\n   ' + extra : ''}`)); }

const now = Date.now();
function envWithHome(payload, computedAt) {
  return { DB: { prepare: () => ({ bind: () => ({
    first: async () => ({ payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
                          computed_at: computedAt == null ? now - 60000 : computedAt }) }) }) } };
}

// ---------- 1. ★壊れた残数を「残り0回」にしない ----------
const GOOD = { currentMonth: '2026-10', nextMonth: '2026-11',
               current: { type: 'monthly', quota: 6, monthlyRemaining: 3, ticketPacks: [], pairRemaining: 1 },
               next: { type: 'monthly', quota: 6, monthlyRemaining: 6, ticketPacks: [] } };
{
  const h = await readHome(envWithHome(GOOD), 'c1');
  ok('①正常な写しは読める', h && h.monthlyRemaining === 3, JSON.stringify(h));
}
for (const [label, payload] of [
  ['中身が空（{}）',            { currentMonth: '2026-10', current: {} }],
  ['current が配列',            { currentMonth: '2026-10', current: [] }],
  ['current が文字列',          { currentMonth: '2026-10', current: 'こわれた' }],
  ['current が数値',            { currentMonth: '2026-10', current: 1 }],
  ['type のキーが無い',         { currentMonth: '2026-10', current: { quota: 6, monthlyRemaining: 3 } }],
]) {
  const h = await readHome(envWithHome(payload), 'c1');
  eq(`①★${label} は読めなかったことにする`, h, null);
}
// 契約が無い会員（type:null）は**正常**。ここまで弾くと全員GASに落ちる。
{
  const h = await readHome(envWithHome({ currentMonth: '2026-10', current: { type: null, active: false } }), 'c1');
  ok('①契約の無い会員（type:null）は正常として読める', h !== null, JSON.stringify(h));
}
// JSONとして読めないものは当然null
{
  const h = await readHome(envWithHome('{こわれた'), 'c1');
  eq('①JSONとして読めなければ読めなかったことにする', h, null);
}

// ---------- 2. ★壊れた枠の写しを「空きがありません」にしない ----------
if (slotsTest && slotsTest.readCache) {
  const envSlots = (payload) => ({ DB: { prepare: () => ({ bind: () => ({
    first: async () => ({ payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
                          computed_at: now - 60000 }) }) }) } });
  {
    const c = await slotsTest.readCache(envSlots({ rules: {}, slots: [{ startMs: now + 86400000 }] }), 't1');
    ok('②正常な写しは読める', c && Array.isArray(c.slots) && c.slots.length === 1);
  }
  for (const [label, payload] of [
    ['slots のキーが無い', { rules: { leadMinutes: 180 } }],
    ['slots が配列でない', { slots: {} }],
    ['slots が文字列',     { slots: 'こわれた' }],
    ['payload が配列',     [] ],
    ['payload が "[]"',    '[]' ],
  ]) {
    const c = await slotsTest.readCache(envSlots(payload), 't1');
    eq(`②★${label} は読めなかったことにする`, c, null);
  }
  // 本当に空き0件のときは「0件」で正しい（分からないと混ぜない）
  {
    const c = await slotsTest.readCache(envSlots({ rules: {}, slots: [] }), 't1');
    ok('②本当に0件なら0件として読める（分からないと混ぜない）',
       c && Array.isArray(c.slots) && c.slots.length === 0, JSON.stringify(c));
  }
} else {
  ok('②写しの読み取りが検査できる形で公開されている', false, '_forTest.readCache が無い');
}

// ---------- 3. ★1人ぶんの押し出しで全体の同期時刻を押さないこと ----------
//   予約の直後には対象の顧客1人ぶんだけを押し出し、それにも final が付く。
//   以前はそれでも sync_state を押していたため、定期の全体同期が止まっていても
//   誰か1人が予約するたびに予約一覧全体が「たったいま同期した」ことになっていた。
{
  const SRC = readFileSync(join(ROOT, 'worker/src/routes/ingest.js'), 'utf8');
  ok('③★差分の押し出しでは全体の同期時刻を押さない',
     !/\} else if \(body\.final\) \{/.test(SRC),
     '`} else if (body.final) {` が残っている＝差分でも押している');
  ok('③完全同期のときは押す', /\} else if \(body\.final && full\) \{/.test(SRC));
  ok('③消す処理は完全同期のときだけ', /body\.final && full && !conf\.keepStale/.test(SRC));
}

console.log(`\n${fail ? '❌' : '✅'} 空の成功を作らない 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
