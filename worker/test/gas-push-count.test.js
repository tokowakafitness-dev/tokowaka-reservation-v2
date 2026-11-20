// 設計47：押し出しのロックの所有権方式と、握った時間の記録（2026-11-20）
//   実行: node worker/test/gas-push-count.test.js
//
//   ⑦ 所有権方式：(a) 外側が持っていれば取り直さず、戻った後も外側が持っている (b) 持たなければ取って放す (c) 他が持てば見送る
//   ⑧ 記録：n・holdMax・over10Sum・skip。本体が例外を投げた回も数え、放した後に同じ例外を投げ直す。
//      ★呼ばれた順は「本体の終わり → releaseLock → setProperty」。残数の押し出しは home に入り OTHER に入らない
//   ⑨ 記録に個人情報が入らない
//   ⑫ 記録が例外を投げても、戻り値・例外・ロックの解放が変わらない（fault injection）
//   ⑭ 作業依頼の中の押し出し：ロックを放した直後に一度だけ全部書く・報告を変えない・_EJ_IN_RUN は必ず偽に戻る
//   ⑮ 作業依頼の外の入れ子は nested_
//   ★LockService の身代わりは再入を許さない（同じ実行で持っているのに tryLock を呼ぶと例外）
//   ★値は架空（個人情報を書かない）
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { writeLockSrc, pluckFnFrom as pluckFn, pluckVarFrom as pluckVar } from './_gas-lock-src.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GAS = process.env.GAS_DIR || join(ROOT, 'gas');
const LB = readFileSync(join(GAS, 'LineBooking.js'), 'utf8');
const PE = readFileSync(join(GAS, 'PushToEdge.js'), 'utf8');
const EJ = readFileSync(join(GAS, 'EdgeJob.js'), 'utf8');
let pass = 0, fail = 0;
function ok(name, cond, why) { if (cond) pass++; else { fail++; console.log(`❌ ${name}`); if (why) console.log(`   ${why}`); } }

function world(opt = {}) {
  let nowMs = 1795000000000;
  class FD extends Date { constructor(...a) { if (a.length === 0) super(nowMs); else super(...a); } static now() { return nowMs; } }
  const st = { owner: null, cur: 'me', tryCalls: 0, reentrant: 0, props: {}, order: [], posts: [] };
  const lockObj = () => ({
    hasLock: () => st.owner === st.cur,
    tryLock: () => {
      st.tryCalls++;
      if (st.owner === st.cur) { st.reentrant++; throw new Error('REENTRANT_TRY'); }
      if (st.owner) return false;
      st.owner = st.cur; st.order.push('lock'); return true;
    },
    releaseLock: () => { if (st.owner === st.cur) { st.owner = null; st.order.push('release'); } },
  });
  const impl = (ms, label) => () => { nowMs += ms; st.order.push('body:' + label); if (opt.bodyThrow && opt.bodyThrow[label]) throw opt.bodyThrow[label]; return 'ok-' + label; };
  const out = {
    String, Number, JSON, Math, Object, Array, RegExp, Error, isFinite, Date: FD, console,
    Logger: { log: () => {} },
    LockService: { getScriptLock: lockObj },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => { if (opt.propsThrow === true) throw new Error('p'); return (k in st.props ? st.props[k] : null); },   // 鍵を指定したときは書くときだけ投げる
      setProperty: (k, v) => {
        st.order.push('set:' + k + (st.owner ? ':LOCKED' : ''));
        if (opt.propsThrow && (opt.propsThrow === true || opt.propsThrow === k)) throw new Error('s');
        st.props[k] = String(v);
      },
    }) },
    Utilities: { formatDate: (d) => new Date(d.getTime() + 9 * 3600000).toISOString().slice(0, 10) },
    LB_JOB_BUILD: '2026-11-20a テスト',
    _edgeEnabled: () => true,
    _pushToEdgeAllImpl: impl(opt.allMs == null ? 15000 : opt.allMs, 'all'),
    _pushToEdgeSlotsImpl: impl(2000, 'slots'),
    _pushToEdgeHomeImpl: impl(0, 'home'),
    buildAndCacheSlots: () => [], _edgeMaybeShadowSweep: () => {},
    _ejOn: () => true, _edgeProp: (k) => ({ EDGE_URL: 'https://example.invalid', EDGE_SECRET: 'x' })[k] || null,
    _ejNoteOk: () => {}, _ejNoteFail: () => 0, _ejNoteLockMiss: () => {}, _ejScrub: (s) => String(s),
    _ejPost: (b) => { st.posts.push(JSON.parse(JSON.stringify(b))); if (b.action === 'claim') return { success: true, job: opt.job }; return { success: true }; },
    _ejRunInner: (op) => (opt.jobBody ? opt.jobBody(out, st) : ''),
    adv: (ms) => { nowMs += ms; },
  };
  const ctx = new Proxy(out, {
    has: () => true,
    get: (t, k) => {
      if (k in t) return t[k];
      if (typeof k === 'symbol' || k in globalThis) return globalThis[k];
      const f = function () { return undefined; }; t[k] = f; return f;
    },
  });
  vm.createContext(ctx);
  let src = "var LB_EDGE_SKIP_PROP = 'LB_EDGE_LOCK_SKIPS';\n";
  try {
    src += writeLockSrc(LB) + pluckVar(PE, 'LB_EDGE_KINDS') + 'var _EDGE_PUSH_TALLY = null;\nvar _EJ_IN_RUN = false;\n'
      + ['_edgeKindOf', '_edgeNestedPrefix', '_edgeTallyKey', '_edgeTallyRun', '_edgeTallySkip', '_edgePushFlush'].map((n) => pluckFn(PE, n)).join('\n')
      + pluckFn(EJ, '_ejPushFlush');
  } catch (e) { /* 反映前の版には無い（赤を確かめるとき） */ }
  src += ['_edgeRecordLockSkip', '_edgeLocked', 'pushToEdgeAll', 'pushToEdgeAllText', 'pushToEdgeLight', 'pushToEdgeSlots', 'pushToEdgeHome'].map((n) => pluckFn(PE, n)).join('\n')
    + ['_ejRun', 'edgeJobPoll'].map((n) => pluckFn(EJ, n)).join('\n');
  vm.runInContext(src, ctx);
  const run = (fn) => { try { return { r: fn() }; } catch (e) { return { e }; } };
  const rec = () => { try { const o = JSON.parse(st.props.LB_EDGE_PUSH_COUNT || '{}'); const k = Object.keys(o).sort(); return k.length ? o[k[k.length - 1]] : {}; } catch (e) { return null; } };
  return { ctx, st, run, rec, out };
}
const idx = (arr, s) => arr.indexOf(s);

console.log('=== ⑦ 所有権方式 ===');
{
  const a = world();
  a.st.owner = 'me';   // 外側（作業依頼と同じ形）がロックを持つ
  const r = a.run(() => a.ctx.pushToEdgeAll(false));
  ok('⑦-a1 外側が持っていれば tryLock を呼ばない（再入しない）', a.st.tryCalls === 0 && a.st.reentrant === 0, String(r.e || ''));
  ok('⑦-a2 ★戻った後も外側がロックを持っている（hasLock===true）', a.st.owner === 'me' && a.ctx.LockService.getScriptLock().hasLock() === true);
  ok('⑦-a3 本体は走った', r.r === 'ok-all', JSON.stringify(r));
  const b = world();
  const rb = b.run(() => b.ctx.pushToEdgeAll(false));
  ok('⑦-b1 外側が持たなければ取って走らせ、放す（hasLock===false）', rb.r === 'ok-all' && b.st.owner === null && idx(b.st.order, 'lock') < idx(b.st.order, 'body:all') && idx(b.st.order, 'body:all') < idx(b.st.order, 'release'), b.st.order.join(','));
  const c = world();
  c.st.owner = 'other';
  const rc = c.run(() => c.ctx.pushToEdgeAll(false));
  ok('⑦-c1 他の実行が持てば見送る（undefined・本体は走らない）', rc.r === undefined && !rc.e && idx(c.st.order, 'body:all') < 0, JSON.stringify(rc) + c.st.order.join(','));
  ok('⑦-c2 見送りを数える（skip）・既存の LB_EDGE_LOCK_SKIPS も増える', (c.rec().all || {}).skip === 1 && /^1\|/.test(c.st.props.LB_EDGE_LOCK_SKIPS || ''), JSON.stringify(c.rec()));
  const s = c.run(() => c.ctx.pushToEdgeSlots());
  ok('⑦-c3 枠の押し出しの見送りは今までどおり LOCK_SKIP', s.r === 'LOCK_SKIP', JSON.stringify(s));
}

console.log('=== ⑧ 握った時間の記録 ===');
{
  const w = world();
  w.run(() => w.ctx.pushToEdgeLight());
  const a = w.rec().all || {};
  ok('⑧-1 light（pushToEdgeAll）：n=1・holdMax=15000・over10Sum=5000・thrown=0', a.n === 1 && a.holdMax === 15000 && a.holdSum === 15000 && a.over10Sum === 5000 && a.thrown === 0, JSON.stringify(w.rec()));
  ok('⑧-2 ★順序：本体の終わり → release → setProperty（ロックの外）', (() => { const o = w.st.order; const b = idx(o, 'body:all'), rl = idx(o, 'release'), sp = idx(o, 'set:LB_EDGE_PUSH_COUNT'); return b >= 0 && rl > b && sp > rl; })() && !w.st.order.includes('set:LB_EDGE_PUSH_COUNT:LOCKED'), w.st.order.join(','));
  w.run(() => w.ctx.pushToEdgeSlots());
  ok('⑧-3 slots：holdMax=2000・over10Sum=0', (w.rec().slots || {}).holdMax === 2000 && (w.rec().slots || {}).over10Sum === 0, JSON.stringify(w.rec()));
  w.run(() => w.ctx.pushToEdgeHome());
  ok('⑧-4 ★残数の押し出しは home に入り OTHER に入らない', (w.rec().home || {}).n === 1 && !('OTHER' in w.rec()), JSON.stringify(w.rec()));
  w.run(() => w.ctx.pushToEdgeLight());
  ok('⑧-5 足し算と最大（2回目）', (w.rec().all || {}).n === 2 && (w.rec().all || {}).holdSum === 30000 && (w.rec().all || {}).over10Sum === 10000, JSON.stringify(w.rec()));
}
{
  const E = new Error('push boom');
  const w = world({ allMs: 12000, bodyThrow: { all: E } });
  const r = w.run(() => w.ctx.pushToEdgeAll(false));
  ok('⑧-6 ★本体の例外は同じオブジェクトのまま投げ直す', r.e === E, String(r.e));
  const a = w.rec().all || {};
  ok('⑧-7 ★例外の回も記録：n=1・thrown=1・holdMax=12000・over10Sum=2000', a.n === 1 && a.thrown === 1 && a.holdMax === 12000 && a.over10Sum === 2000, JSON.stringify(w.rec()));
  ok('⑧-8 例外の回も順序は 本体 → release → setProperty・ロックは放してある', (() => { const o = w.st.order; return idx(o, 'release') > idx(o, 'body:all') && idx(o, 'set:LB_EDGE_PUSH_COUNT') > idx(o, 'release'); })() && w.st.owner === null, w.st.order.join(','));
}

console.log('=== ⑨ 個人情報 ===');
{
  const w = world();
  w.run(() => { w.ctx.pushToEdgeLight(); w.ctx.pushToEdgeSlots(); w.ctx.pushToEdgeHome(); });
  const s = JSON.stringify(w.st.props);
  ok('⑨-1 記録は固定の名前と数だけ（会員ID・LINE ID・例外の文が無い）', !/U0000|C\d|boom|example/.test(s) && [...(w.st.props.LB_EDGE_PUSH_COUNT || '').matchAll(/"([A-Za-z_]+)":\{/g)].every((m) => /^(slots|all|home|fullSync|OTHER|jobHold|(job|nested)_(slots|all|home|fullSync|OTHER))$/.test(m[1])), s.slice(0, 300));
}

console.log('=== ⑫ 記録が例外を投げても変わらない ===');
{
  const w = world({ propsThrow: 'LB_EDGE_PUSH_COUNT' });
  const r = w.run(() => w.ctx.pushToEdgeAll(false));
  ok('⑫-1 戻り値が同じ・ロックは放してある', r.r === 'ok-all' && w.st.owner === null, JSON.stringify(r));
  const E = new Error('push boom');
  const w2 = world({ propsThrow: true, allMs: 12000, bodyThrow: { all: E } });
  const r2 = w2.run(() => w2.ctx.pushToEdgeAll(false));
  ok('⑫-2 本体の例外も同じオブジェクト・ロックは放してある', r2.e === E && w2.st.owner === null, String(r2.e));
  const w3 = world({ propsThrow: true }); w3.st.owner = 'other';
  const r3 = w3.run(() => w3.ctx.pushToEdgeSlots());
  ok('⑫-3 見送りの戻り値も同じ（LOCK_SKIP）', r3.r === 'LOCK_SKIP', JSON.stringify(r3));
}

console.log('=== ⑭ 作業依頼の中の押し出し ===');
const JOB = { op: 'pushAll', isWrite: true, requestId: 'q1', args: {} };
function jobRun(opt) {
  const w = world(Object.assign({ job: JOB }, opt));
  const r = w.run(() => w.ctx.edgeJobPoll());
  const report = w.st.posts.find((p) => p.action === 'report') || null;
  return { w, r, report };
}
{
  //   (a) 押し出しが成功した後、作業の後続が例外
  const a = jobRun({ jobBody: (o) => { o.pushToEdgeAllText(); throw new Error('after push boom'); } });
  const o = a.w.st.order;
  const sets = o.filter((x) => x.startsWith('set:LB_EDGE_PUSH_COUNT'));
  ok('⑭-a1 ★ロックを放した後に一度だけ書く（ロックの中では0回）', sets.length === 1 && sets[0] === 'set:LB_EDGE_PUSH_COUNT' && idx(o, 'set:LB_EDGE_PUSH_COUNT') > idx(o, 'release'), o.join(','));
  const rc = a.w.rec();
  ok('⑭-a2 job_all（n=1）と jobHold（thrown=1）が入る・all（作業依頼の外の名前）には入らない', (rc.job_all || {}).n === 1 && (rc.jobHold || {}).n === 1 && (rc.jobHold || {}).thrown === 1 && !rc.all && !rc.nested_all, JSON.stringify(rc));
  ok('⑭-a3 報告は ok:false・error に作業の例外', a.report && a.report.ok === false && /after push boom/.test(a.report.error || ''), JSON.stringify(a.report));
  ok('⑭-a4 ★_EJ_IN_RUN===false（例外のあと）', a.w.ctx._EJ_IN_RUN === false);
  ok('⑭-a5 作業依頼のロックは放してある', a.w.st.owner === null);
  //   記録が無い（書けない）場合と報告が同じ
  const a2 = jobRun({ propsThrow: 'LB_EDGE_PUSH_COUNT', jobBody: (o2) => { o2.pushToEdgeAllText(); throw new Error('after push boom'); } });
  ok('⑭-a6 記録が書けなくても報告（ok/error/result）は同じ', JSON.stringify([a.report.ok, a.report.error, a.report.result]) === JSON.stringify([a2.report.ok, a2.report.error, a2.report.result]), JSON.stringify([a.report, a2.report]));
}
{
  //   (b) 1回の作業依頼で押し出し2回
  const b = jobRun({ jobBody: (o) => { o.pushToEdgeAllText(); o.adv(1000); o.pushToEdgeAllText(); return 'done'; } });
  const sets = b.w.st.order.filter((x) => x.startsWith('set:LB_EDGE_PUSH_COUNT'));
  ok('⑭-b1 全部溜めて一度だけ書く（job_all n=2・holdSum=30000）', sets.length === 1 && (b.w.rec().job_all || {}).n === 2 && (b.w.rec().job_all || {}).holdSum === 30000, JSON.stringify(b.w.rec()) + sets.join(','));
  ok('⑭-b2 報告は ok:true・result に作業の結果', b.report && b.report.ok === true && /done/.test(b.report.result || ''), JSON.stringify(b.report));
  ok('⑭-b3 _EJ_IN_RUN===false（成功のあと）', b.w.ctx._EJ_IN_RUN === false);
  ok('⑭-b4 jobHold は作業依頼がロックを持った時間（押し出し2回＋間＝31000以上）', (b.w.rec().jobHold || {}).holdMax >= 31000 && (b.w.rec().jobHold || {}).thrown === 0, JSON.stringify(b.w.rec()));
}
{
  //   (c) flush の setProperty が例外
  const c = jobRun({ propsThrow: 'LB_EDGE_PUSH_COUNT', jobBody: (o) => { o.pushToEdgeAllText(); return 'done'; } });
  const base = jobRun({ jobBody: (o) => { o.pushToEdgeAllText(); return 'done'; } });
  const sets = c.w.st.order.filter((x) => x.startsWith('set:LB_EDGE_PUSH_COUNT'));
  ok('⑭-c1 書こうとしたのは放した後の一度だけ', sets.length === 1 && sets[0] === 'set:LB_EDGE_PUSH_COUNT', c.w.st.order.join(','));
  ok('⑭-c2 報告は記録が書けた場合と同じ（ok:true）', c.report && c.report.ok === true && JSON.stringify([c.report.ok, c.report.error, c.report.result]) === JSON.stringify([base.report.ok, base.report.error, base.report.result]), JSON.stringify([c.report, base.report]));
  ok('⑭-c3 _EJ_IN_RUN===false（flush の例外のあと）', c.w.ctx._EJ_IN_RUN === false);
  ok('⑭-c4 ロックは放してある', c.w.st.owner === null);
  //   作業依頼の後で同じ実行の中から呼んでも、前の溜めを二度書かない
  c.w.run(() => c.w.ctx._edgePushFlush());
  ok('⑭-c5 書いた（試みた）後は溜めが空＝二度書かない', c.w.st.order.filter((x) => x.startsWith('set:LB_EDGE_PUSH_COUNT')).length === 1);
}

console.log('=== ⑮ 作業依頼の外の入れ子は nested_ ===');
{
  const j = jobRun({ jobBody: (o) => { o.pushToEdgeAllText(); return 'done'; } });
  //   続けて同じ実行の中で、印なしで外側がロックを取ってから押し出しを呼ぶ
  j.w.st.owner = 'me';
  j.w.run(() => j.w.ctx.pushToEdgeAll(false));
  j.w.st.owner = null;
  j.w.run(() => j.w.ctx._edgePushFlush());
  const rc = j.w.rec();
  ok('⑮-1 ★印なしの入れ子は nested_all に入り、job_all は増えない', (rc.nested_all || {}).n === 1 && (rc.job_all || {}).n === 1, JSON.stringify(rc));
}

console.log(`\n${fail ? '❌' : '✅'} 設計47 押し出しのロックと記録 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
