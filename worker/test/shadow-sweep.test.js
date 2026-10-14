// shadow を毎日まとめて取る（sweep・設計19）を動かして確かめる。
//   実行: node worker/test/shadow-sweep.test.js
//
// ★設計で関門①を9往復した穴を、1つずつ動かして固定する：
//   作り直さない／一時的な見送りは当日中に再試行／完了は「一覧の最後まで」かつ「再試行が空」／
//   期限切れは時間帯の判定より先／月初は計画的な見送り／同時に1つだけ（リース）／
//   古い実行は書き戻さない／時間の締切／合格は値と配線の AND

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { classifySweep, runSweep, SWEEP_MAX } from '../src/lib/shadow-sweep.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PE = readFileSync(join(ROOT, 'gas/PushToEdge.js'), 'utf8');
const EA = readFileSync(join(ROOT, 'gas/EdgeAudit.js'), 'utf8');
let pass = 0, fail = 0;
function ok(name, cond, why) {
  if (cond) { pass++; return; }
  fail++; console.log(`❌ ${name}`); if (why) console.log(`   ${why}`);
}
function pluckFn(src, name) {
  const m = src.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('見つからない: ' + name);
  return m[0];
}

// ============================================================
console.log('=== 1. Worker：結末の分け方と窓口 ===');
{
  ok('1-1 done:true は完了', classifySweep({ done: true }) === 'completed');
  ok('1-2 no_slot は当日は再試行しない', classifySweep({ done: false, why: 'no_slot' }) === 'terminal');
  ok('1-3 bad_args は再試行しない（実装の誤り）', classifySweep({ done: false, why: 'bad_args' }) === 'terminal');
  ok('1-4 ★それ以外は全部再試行（slot_failed・behind・写しの鮮度・知らない理由）',
     ['slot_failed', 'behind', 'copy_stale_for_compare', 'version_changed_during_shadow', 'batch_failed', 'xyz', ''].every((w) => classifySweep({ done: false, why: w }) === 'retry'));
  ok('1-5 1ページの上限は4名', SWEEP_MAX === 4);
  const off = await runSweep({ LB_D1_REMAIN_MODE: 'off' }, {});
  ok('1-6 shadow モードでなければ何もしない', off.skipped === 'MODE_OFF');
  // D1 が落ちる env：readHomeDiag が投げる → 会員ごとに try で再試行へ
  const ids = ['C001', 'C002', 'C003', 'C004'];
  const env = { LB_D1_REMAIN_MODE: 'shadow', DB: { prepare: (q) => ({ bind() { return this; },
    async all() { if (/calc_contract_rows/.test(q)) return { results: ids.map((x) => ({ customer_id: x })) }; throw new Error('boom'); },
    async first() { if (/COUNT\(DISTINCT/.test(q)) return { n: 41 }; throw new Error('boom'); },
    async run() { throw new Error('boom'); } }), batch: async () => { throw new Error('boom'); } } };
  const r = await runSweep(env, { skip: 'C002' });
  ok('1-7 ★1名の失敗で止めない（全員の結末が返る）', r.members.length === 4, JSON.stringify(r.members));
  ok('1-8 ★待ち行列の会員は呼ばずに再試行へ（dw_queued）', r.members[1].why === 'dw_queued' && r.retry.includes('C002'));
  ok('1-9 失敗した会員は再試行へ（完了にしない）', r.completedIds.length === 0 && r.retry.length === 4);
  ok('1-10 表示用の会員IDは末尾4桁', r.members.every((m) => /^\*\d{3,4}|^\*C\d{3}$/.test(m.id) || m.id.startsWith('*')) && !r.members.some((m) => m.id === 'C001'));
  ok('1-11 最初のページは対象の人数を返す', r.target === 41);
  ok('1-12 ちょうど4名なら続き（next）がある', r.next === 'C004');
  const onlyR = await runSweep(env, { only: 'C003', after: 'zzz' });
  ok('1-13 only は指定の会員だけ・続きは無い', onlyR.customers === 1 && onlyR.next === null);
}

// ============================================================
console.log('=== 2. GAS：sweep の状態の動き ===');
const H = 3600000;
// 2026-10-20(火) 05:30 JST をローカル時刻で作る（テスト機は JST 前提の formatDate を使う）
function jst(y, mo, d, h, mi) { return Date.UTC(y, mo - 1, d, h - 9, mi); }
function fmtJst(ms, pat) {
  const d = new Date(ms + 9 * H);
  const map = { yyyy: d.getUTCFullYear(), MM: String(d.getUTCMonth() + 1).padStart(2, '0'), dd: String(d.getUTCDate()).padStart(2, '0') };
  if (pat === 'H') return String(d.getUTCHours());
  if (pat === 'd') return String(d.getUTCDate());
  return `${map.yyyy}-${map.MM}-${map.dd}`;
}
function makeGas(opts) {
  const clock = { now: opts.now };
  class FakeDate extends Date { constructor(...a) { if (a.length) super(...a); else super(clock.now); } static now() { return clock.now; } }
  const props = new Map(Object.entries(opts.props || {}));
  const calls = [];
  const lock = { held: false };
  const ctx = {
    Date: FakeDate, JSON, Math, String, Number, Object, Array, Error, encodeURIComponent,
    Logger: { log: () => {} },
    SETTINGS: { TIMEZONE: 'Asia/Tokyo' },
    Utilities: { formatDate: (d, tz, pat) => fmtJst(d.getTime(), pat), getUuid: (() => { let n = 0; return () => 'tok' + (++n); })() },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (props.has(k) ? props.get(k) : null), setProperty: (k, v) => props.set(k, String(v)), deleteProperty: (k) => props.delete(k) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => { if (lock.held) return false; lock.held = true; return true; }, releaseLock: () => { lock.held = false; } }) },
    _edgeProp: (k) => (k === 'EDGE_URL' ? 'https://w' : 'sec'),
    _lbDwReadQueue: () => opts.queue || {},
    UrlFetchApp: { fetch: (url) => {
      calls.push(url);
      const r = opts.respond(url, calls.length, ctx, clock, props);
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify(r) };
    } },
  };
  vm.createContext(ctx);
  const names = ['_sweepRead', '_sweepReadSafe', '_sweepReadLease', '_sweepReadState', '_sweepLast', '_sweepWithLease', '_sweepCall', '_edgeMaybeShadowSweep'];
  vm.runInContext(PE.match(/var LB_SWEEP = \{[\s\S]*?\n\};/)[0], ctx);
  for (const n of names) vm.runInContext(pluckFn(PE, n), ctx);
  return { ctx, props, calls, clock, lock, run: (o) => ctx._edgeMaybeShadowSweep(Object.assign({ pushOk: true, startedAt: clock.now }, o || {})) };
}
const T530 = jst(2026, 10, 20, 5, 30);
const page = (ids, extra) => Object.assign({ ok: true, completedIds: ids, terminalIds: [], retry: [], done: { completed: ids.length, diffs: 0 }, why: {}, next: null }, extra || {});
const J = (props, k) => JSON.parse(props.get(k) || 'null');
{
  // 一覧2ページ・全員完了
  const g = makeGas({ now: T530, respond: (url, n) => (n === 1 ? page(['A', 'B', 'C', 'D'], { next: 'D', target: 6 }) : page(['E', 'F'])) });
  const r = g.run();
  ok('2-1 一覧を最後まで回って完了の印', r.done === true && g.props.get('LB_SHADOW_SWEEP_DAY') === '2026-10-20');
  const last = J(g.props, 'LB_SHADOW_SWEEP_LAST');
  ok('2-2 心拍に比べ終わった人数と対象', last.result === 'done' && last.completed === 6 && last.target === 6);
  ok('2-3 リースを返す', !g.props.has('LB_SHADOW_SWEEP_LEASE'));
  const r2 = g.run();
  ok('2-4 同じ日の2回目は何もしない', r2.skipped === 'DONE_TODAY' && g.calls.length === 2);
}
{
  // 再試行：1回目で C が behind → 完了にしない → 次の回で only=C → 完了
  let phase = 1;
  const g = makeGas({ now: T530, respond: (url) => {
    if (/only=/.test(url)) return page(['C']);
    return page(['A', 'B'], { retry: ['C'], why: { behind: 1 } });
  } });
  const r1 = g.run();
  ok('2-5 ★再試行が残っていれば完了にしない', !r1.done && !g.props.has('LB_SHADOW_SWEEP_DAY') && J(g.props, 'LB_SHADOW_SWEEP_STATE').retry[0] === 'C');
  g.clock.now += 30 * 60000;
  const r2 = g.run();
  ok('2-6 次の回で再試行を先に（only=）→ 空になって完了', r2.done === true && /only=C/.test(g.calls[g.calls.length - 1]) && g.props.get('LB_SHADOW_SWEEP_DAY') === '2026-10-20');
  ok('2-7 この回で一覧は呼び直さない（終わっている）', g.calls.filter((u) => /after=/.test(u)).length === 1);
}
{
  // no_slot：再試行から外す（完了には数えない）
  const g = makeGas({ now: T530, respond: (url) => (/only=/.test(url)
    ? page([], { terminalIds: ['C'], why: { no_slot: 1 } })
    : page(['A'], { retry: ['C'] })) });
  g.run(); g.clock.now += 30 * 60000; const r = g.run();
  ok('2-8 ★no_slot（terminalIds）は再試行から外れて完了できる', r.done === true);
  ok('2-9 完了には数えない', J(g.props, 'LB_SHADOW_SWEEP_LAST').completed === 1 && J(g.props, 'LB_SHADOW_SWEEP_LAST').terminal === 1);
}
{
  // ★再試行が収まらないまま7時を過ぎる → expired（時間帯の判定より先・1回だけ）
  const g = makeGas({ now: T530, respond: () => page([], { retry: ['C'] }) });
  g.run();
  g.clock.now = jst(2026, 10, 20, 7, 10);
  const r = g.run({ pushOk: false });
  const last = J(g.props, 'LB_SHADOW_SWEEP_LAST');
  ok('2-10 ★7時以後は押し出しが失敗しても expired を残す', r.skipped === 'AFTER_WINDOW' && last.result === 'expired' && last.retry === 1);
  const at = last.at; g.clock.now += 30 * 60000; g.run();
  ok('2-11 expired は1日1回だけ書く', J(g.props, 'LB_SHADOW_SWEEP_LAST').at === at);
  // 翌日：前日の状態を捨てる
  g.clock.now = jst(2026, 10, 21, 5, 30);
  g.run({ pushOk: false });
  ok('2-12 ★翌日は前日の状態を捨てる（再試行を持ち越さない）', !g.props.has('LB_SHADOW_SWEEP_STATE'));
}
{
  const g = makeGas({ now: jst(2026, 11, 1, 5, 30), respond: () => page(['A']) });
  const r = g.run();
  ok('2-13 月の1日は動かさず、計画的な見送りを心拍に残す', r.skipped === 'MONTH_FIRST' && J(g.props, 'LB_SHADOW_SWEEP_LAST').result === 'MONTH_FIRST' && g.calls.length === 0);
}
{
  const g = makeGas({ now: jst(2026, 10, 20, 4, 40), respond: () => page(['A']) });
  ok('2-14 5時前は何もしない', g.run().skipped === 'BEFORE_WINDOW' && g.calls.length === 0);
  g.clock.now = T530;
  ok('2-15 ★押し出しが失敗した回は比べ始めない', g.run({ pushOk: false }).skipped === 'PUSH_NOT_OK' && g.calls.length === 0);
}
{
  // ★同時に1つだけ：通信中に別の実行が来ても見送る
  let nested = null;
  const g = makeGas({ now: T530, respond: (url, n, ctx) => {
    if (!nested) nested = ctx._edgeMaybeShadowSweep({ pushOk: true, startedAt: Date.now() });
    return page(['A']);
  } });
  g.run();
  ok('2-16 ★別の実行はリースが有効な間は見送る', nested && nested.skipped === 'LEASE_BUSY');
}
{
  // ★古い実行は書き戻さない：通信中にリースが切れて別の実行が取った
  const g = makeGas({ now: T530, respond: (url, n, ctx, clock, props) => {
    props.set('LB_SHADOW_SWEEP_LEASE', JSON.stringify({ token: 'other', until: clock.now + 600000 }));
    return page(['A'], { next: 'A' });
  } });
  const r = g.run();
  ok('2-17 ★リースを失った実行は状態を書かない', r.stopped === 'LEASE_LOST' && !g.props.has('LB_SHADOW_SWEEP_STATE'));
  ok('2-18 他人のリースを消さない', J(g.props, 'LB_SHADOW_SWEEP_LEASE').token === 'other');
}
{
  // 時間の締切：押し出しで270秒使った後は新しいページを始めない
  const g = makeGas({ now: T530, respond: () => page(['A']) });
  const r = g.run({ startedAt: T530 - 275000 });
  ok('2-19 ★締切の30秒前を過ぎたら新しいページを始めない', r.stopped === 'TIME' && g.calls.length === 0);
}
{
  const s = pluckFn(PE, 'pushToEdgeHome');
  ok('2-20 ★押し出しの成否にかかわらず、ロックの外で必ず呼ぶ',
     /var pushed = _edgeLocked\(_pushToEdgeHomeImpl\);\s*(\/\/[^\n]*\n\s*)*try \{ _edgeMaybeShadowSweep\(\{ pushOk: !!\(pushed && pushed\.ok === true\), startedAt: t0 \}\); \}/.test(s));
  ok('2-21 押し出しは成否を返す', /return \{ ok: true, result: n \};/.test(pluckFn(PE, '_pushToEdgeHomeImpl')) && /return \{ ok: false, reason:/.test(pluckFn(PE, '_pushToEdgeHomeImpl')));
}

{
  // ★7時の期限切れもリースを確かめる：実行中（6:59に始めた）のものがいれば書かない
  const g = makeGas({ now: jst(2026, 10, 20, 7, 0), respond: () => page(['A']) });
  g.props.set('LB_SHADOW_SWEEP_LEASE', JSON.stringify({ token: 'A', until: g.clock.now + 5 * 60000 }));
  g.props.set('LB_SHADOW_SWEEP_STATE', JSON.stringify({ day: '2026-10-20', after: 'X', listDone: false, retry: ['C'], completed: 3, terminal: 0, diffs: 0, why: {}, target: null }));
  const r = g.run({ pushOk: false });
  ok('2-22 ★実行中のリースがあれば7時の期限切れを書かない', r.skipped === 'LEASE_BUSY' && !g.props.has('LB_SHADOW_SWEEP_LAST'));
  g.clock.now += 6 * 60000;
  const r2 = g.run({ pushOk: false });
  ok('2-23 リースの期限後は期限切れを書く', r2.skipped === 'AFTER_WINDOW' && J(g.props, 'LB_SHADOW_SWEEP_LAST').result === 'expired');
}
{
  // ★壊れた STATE は「無い」とみなさない
  const g = makeGas({ now: T530, respond: () => page(['A']) });
  g.props.set('LB_SHADOW_SWEEP_STATE', '{broken');
  const r = g.run();
  ok('2-24 ★壊れた状態では比べず、上書きもしない', r.skipped === 'STATE_BROKEN' && g.calls.length === 0 && g.props.get('LB_SHADOW_SWEEP_STATE') === '{broken');
  ok('2-25 心拍に STATE_BROKEN を残す（点検が知らせる）', J(g.props, 'LB_SHADOW_SWEEP_LAST').result === 'STATE_BROKEN');
}
{
  // ★形まで確かめる：JSON として読めても型が違えば壊れている
  const shapes = [['{}', 'STATE が空のオブジェクト'], ['{"day":"2026-10-20","after":"","listDone":false,"retry":"C001","completed":0,"terminal":0,"diffs":0,"why":{}}', 'retry が文字列'],
                  ['{"day":"2026-10-20","after":"","listDone":false,"retry":[],"completed":"x","terminal":0,"diffs":0,"why":{}}', '数が数でない']];
  for (const [raw, label] of shapes) {
    const g = makeGas({ now: T530, respond: () => page(['A']) });
    g.props.set('LB_SHADOW_SWEEP_STATE', raw);
    const r = g.run();
    ok('2-28 ★' + label + 'なら STATE_BROKEN・上書きしない', r.skipped === 'STATE_BROKEN' && g.props.get('LB_SHADOW_SWEEP_STATE') === raw && g.calls.length === 0);
  }
  for (const raw of ['{}', '{"token":"x","until":"abc"}', '{"token":123,"until":99999999999999}']) {
    const g = makeGas({ now: T530, respond: () => page(['A']) });
    g.props.set('LB_SHADOW_SWEEP_LEASE', raw);
    const r = g.run();
    ok('2-29 ★形の壊れたリース（' + raw + '）は取らない', r.skipped === 'LEASE_BUSY' && g.calls.length === 0 && g.props.get('LB_SHADOW_SWEEP_LEASE') === raw);
  }
}
{
  // 通信の失敗：理由を残し、保存済みの状態は失わない
  let n0 = 0;
  const g = makeGas({ now: T530, respond: (url, n) => { if (n === 2) throw new Error('net'); return page(['A'], { next: 'A' }); } });
  const r = g.run();
  const st = J(g.props, 'LB_SHADOW_SWEEP_STATE');
  ok('2-26 通信の失敗は理由を残して抜ける（それまでの状態は保たれる）', r.stopped === 'CALL_FAILED' && st.after === 'A' && st.completed === 1 && st.why.sweep_call_failed === 1, JSON.stringify(st));
}
{
  const s = pluckFn(PE, 'pushToEdgeHome');
  ok('2-27 押し出しが止まっていても期限切れ等のために呼ぶ', /if \(!_edgeEnabled\(\)\) \{[\s\S]*?_edgeMaybeShadowSweep\(\{ pushOk: false, reason: 'EDGE_OFF', startedAt: t0 \}\)/.test(s));
}

// ============================================================
console.log('=== 3. 合格は値と配線の AND（W6）===');
{
  function judge(r) {
    const ctx = { String, Number, Math, Object, JSON, encodeURIComponent, Logger: { log: () => {} }, LB_AUDIT_BUILD: 't', _edgeQuotaStatus: () => r };
    vm.createContext(ctx);
    vm.runInContext(pluckFn(EA, 'shadowStatusText'), ctx);
    return ctx.shadowStatusText({ shadow: true, from: '2026-10-20' });
  }
  const base = { day: '2026-10-22', from: '2026-10-20', preflight: { mode: 'shadow', tables: {} },
    total: { attempted: 130, completed: 123, failed: 0, incomplete: 0, diffFields: 0, comparedMembers: 41, targetMembers: 41 },
    diffFields: {}, entries: { sweep: { completed: 123 } } };
  const t1 = judge(Object.assign({}, base, { wiring: { boot: 0, compat_member: 0, compat_home: 0 }, wiringOk: false }));
  ok('3-1 ★sweep だけで回数・人数を満たしても合格にしない', /①値の確認: ✅　②配線の確認: ⬜/.test(t1) && !/✅ 合格の形です/.test(t1), t1.split('\n').slice(-12).join('\n'));
  ok('3-2 入口0回の警告が出る', /②顧客の入口で一度も比べ終わっていない: boot \/ compat_member \/ compat_home/.test(t1));
  const t2 = judge(Object.assign({}, base, { wiring: { boot: 1, compat_member: 3, compat_home: 2 }, wiringOk: true }));
  ok('3-3 値と配線がそろえば合格', /✅ 合格の形です/.test(t2));
  const t3 = judge(Object.assign({}, base, { total: Object.assign({}, base.total, { completed: 20 }), wiring: { boot: 0, compat_member: 1, compat_home: 1 }, wiringOk: false }));
  ok('3-4 ★入口0回の警告は不合格の理由が他にあっても出る', /一度も比べ終わっていない: boot/.test(t3));
  ok('3-5 期間を表示する', /2026-10-20 〜 2026-10-22/.test(t2));
}

console.log('');
console.log(`${fail ? '❌' : '✅'} shadow のまとめた比較 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
