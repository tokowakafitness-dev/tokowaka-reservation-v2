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
// ★本番とまったく同じ形にする。項目は gas/LineBooking.js の _lbBuildHome の返り値から取った
//   （type / active / quota / carryover / monthlyRemaining / ticketRemaining /
//     pairRemaining / pairPackMax / normalTicketRemaining / hasNormalRoute / ticketPacks ...）。
//   ここを本番より緩く作ると、「テストは通るのに本番のデータが弾かれる」ことに気づけない。
const MONTHLY = { type: 'monthly', active: true, quota: 6, carryover: 0, thisMonth: 2,
                  monthlyRemaining: 3, ticketTotal: 0, ticketRemaining: 0,
                  pairRemaining: 0, pairPackMax: 0, normalTicketRemaining: 0,
                  hasNormalRoute: true, ticketPacks: [], remaining: 3 };
const GOOD = { currentMonth: '2026-10', nextMonth: '2026-11',
               current: MONTHLY, next: { ...MONTHLY, monthlyRemaining: 6 } };
{
  const h = await readHome(envWithHome(GOOD), 'c1');
  ok('①本番と同じ形の写しは読める', h && h.monthlyRemaining === 3, JSON.stringify(h));
}
// チケット会員・併用会員も通ること（締めすぎていないこと）
{
  const ticket = { ...MONTHLY, type: 'ticket', monthlyRemaining: null,
                   ticketRemaining: 5, ticketPacks: [{ remaining: 5, expire: '2026-12-31', kind: 'normal' }] };
  const h = await readHome(envWithHome({ currentMonth: '2026-10', current: ticket }), 'c1');
  ok('①チケット会員も読める', h !== null, JSON.stringify(h));
  const both = { ...MONTHLY, type: 'both', ticketRemaining: 2,
                 ticketPacks: [{ remaining: 2, expire: '2026-12-31', kind: 'pair' }] };
  const h2 = await readHome(envWithHome({ currentMonth: '2026-10', current: both }), 'c1');
  ok('①併用会員も読める', h2 !== null, JSON.stringify(h2));
}
// ★月額の回数が null（上限なしの契約）は正常。キーごと無いのが異常。
{
  const h = await readHome(envWithHome({ currentMonth: '2026-10',
    current: { ...MONTHLY, monthlyRemaining: null } }), 'c1');
  ok('①回数が null（上限なし）は正常として読める', h !== null, JSON.stringify(h));
}
for (const [label, payload] of [
  ['中身が空（{}）',            { currentMonth: '2026-10', current: {} }],
  ['current が配列',            { currentMonth: '2026-10', current: [] }],
  ['current が文字列',          { currentMonth: '2026-10', current: 'こわれた' }],
  ['current が数値',            { currentMonth: '2026-10', current: 1 }],
  ['type のキーが無い',         { currentMonth: '2026-10', current: { quota: 6, monthlyRemaining: 3 } }],
  // ★種別だけ合っていて中身が欠けている形（Codexの2回目の指摘）。
  //   これが素通りすると、既定値で 0 に落ちて「残り0回」として顧客に出る。
  ['種別だけで中身が無い',      { currentMonth: '2026-10', current: { type: 'monthly' } }],
  ['チケットの種別だけ',        { currentMonth: '2026-10', current: { type: 'ticket' } }],
  ['知らない種別',              { currentMonth: '2026-10', current: { type: 'unknown', hasNormalRoute: true, ticketPacks: [], monthlyRemaining: 3, ticketRemaining: 0 } }],
  ['回数のキーごと無い（月額）', { currentMonth: '2026-10', current: { type: 'monthly', hasNormalRoute: true, ticketPacks: [], ticketRemaining: 0 } }],
  ['残枚数のキーごと無い（券）', { currentMonth: '2026-10', current: { type: 'ticket', hasNormalRoute: true, ticketPacks: [], monthlyRemaining: null } }],
  ['チケットの一覧が配列でない', { currentMonth: '2026-10', current: { ...{ type: 'monthly', hasNormalRoute: true, monthlyRemaining: 3, ticketRemaining: 0 }, ticketPacks: null } }],
  ['通常経路の印が真偽値でない', { currentMonth: '2026-10', current: { type: 'monthly', hasNormalRoute: 'yes', ticketPacks: [], monthlyRemaining: 3, ticketRemaining: 0 } }],
]) {
  const h = await readHome(envWithHome(payload), 'c1');
  eq(`①★${label} は読めなかったことにする`, h, null);
}
// 契約が無い会員（type:null）は**正常**。ここまで弾くと全員GASに落ちる。
{
  const h = await readHome(envWithHome({ currentMonth: '2026-10', current: { type: null } }), 'c1');
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
  // ★押す条件は「final かつ 全件を走査し終えた」。deleteStale では救済しない
  //   （OR にすると、scope を書き忘れた呼び出しが deleteStale 経由で素通りする）。
  //   実際の振る舞いは worker/test/ingest.test.js が動かして確かめている。
  //   ここはその条件が**式として1本に保たれている**ことだけを見る。
  ok('③全件を走査し終えたときだけ押す',
     /const sweptAll = body\.final === true && scope === 'all'/.test(SRC));
  ok('③消す処理は全件走査＋消す指定のときだけ', /sweptAll && full && !conf\.keepStale/.test(SRC));
  ok('③押す判定が1か所にまとまっている',
     (SRC.match(/await stampSync\(/g) || []).length === 2,
     `stampSync の呼び出しが ${(SRC.match(/await stampSync\(/g) || []).length} 箇所`);
}

// ---------- 4. ★役割と担当の写しが古ければ、何も答えないこと ----------
//   Workerは「誰がトレーナーか」「誰が誰の担当か」をD1だけで決めている。
//   残数や予約一覧には鮮度の判定があるのに、**権限そのものには無かった**
//   （2026-10-03・Codexの最終判定）。古い権限のうえで正しい残数を返しても意味がない。
//     ・会員登録した直後、別の端末では「未登録のお客様」になる
//     ・担当を変えた直後、前の担当トレーナーがまだその顧客を見られる
//     ・**同期が止まると、古い権限が無期限に残る**
{
  const INDEX  = readFileSync(join(ROOT, 'worker/src/index.js'), 'utf8');
  const COMPAT = readFileSync(join(ROOT, 'worker/src/routes/compat.js'), 'utf8');

  ok('④役割の鮮度を見る関数がある', /export async function rolesTooOld/.test(COMPAT));
  ok('④顧客の写しの寿命が決まっている', /customers:\s*\d+ \* 60 \* 1000/.test(COMPAT));
  ok('④トレーナーの写しの寿命が決まっている', /trainers:\s*\d+ \* 60 \* 1000/.test(COMPAT));
  ok('④★入口で鮮度を見ている', /rolesTooOld\(env\)/.test(INDEX));
  ok('④古ければGASへ落とす', /ROLES_STALE/.test(INDEX));

  // ★許可表の照合より**前**に見ること。古い役割で許可を判定しても意味がない。
  const iStale = INDEX.indexOf('rolesTooOld');
  const iPerm  = INDEX.indexOf('isAllowed(action, who.role)');
  ok('④★許可の判定より前に鮮度を見る', iStale > 0 && iPerm > iStale, `stale=${iStale} perm=${iPerm}`);

  // 寿命は同期の間隔（15分）より長いこと。短いと毎回GASに落ちて高速化が消える。
  const ms = (k) => {
    const m2 = COMPAT.match(new RegExp(k + ':\\s*(\\d+) \\* 60 \\* 1000'));
    return m2 ? Number(m2[1]) : 0;
  };
  ok('④寿命が同期の間隔より長い（customers）', ms('customers') >= 30, `${ms('customers')}分`);
  ok('④寿命が同期の間隔より長い（trainers）', ms('trainers') >= 30, `${ms('trainers')}分`);
}

console.log(`\n${fail ? '❌' : '✅'} 空の成功を作らない 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
