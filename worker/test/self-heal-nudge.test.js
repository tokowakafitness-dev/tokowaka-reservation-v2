// 自己修理 P1：lbNudgeDaily（10時）の最後に lbSelfHeal を相乗り（CEO 裁定 2026-11-23）
//   実行: node worker/test/self-heal-nudge.test.js
//   ★本物の lbNudgeDaily・_lbNudgeThenSelfHeal（Nudge.js）と本物の lbSelfHeal（LineBooking.js）を同じ vm で動かす
//   I-H29 うながしの結果・送信に一切影響しない／lbSelfHeal の例外がうながし側に漏れない／うながしが全部終わった後（ロックを放した後）に呼ぶ
//   ★値はすべて架空
import vm from 'node:vm';
import { makeWorld, makeCtx, incOf, removeTrigger, countTrigger, run, tally, NUDGE } from './_self-heal-harness.js';
import { pluckFnFrom as pluckFn } from './_gas-lock-src.js';

const t = tally();
const ok = t.ok;
const H = 3600000;

//   world の中で lbNudgeDaily を動かす。うながしの部品は身代わり（順序を記録）
function nudge(w, o = {}) {
  const ctx = makeCtx(w);
  const log = [];
  let lockHeld = false;
  Object.assign(ctx, {
    LB_NUDGE_LOCK_WAIT_MS: 15000,
    _lbNudgeWatchHealthCheck: () => log.push('watch'),
    _lbNudgeEnabled: () => true,
    _lbNudgeLogLockMiss: () => log.push('lockMiss'),
    _lbNudgeNoteOpenMiss: () => {},
    lbNudgePlanAll: () => { log.push('plan'); return { isOpenDay: false }; },
    _lbNudgeSend: (plan, ms, locked) => {
      log.push('send');
      if (o.sendMs) w.now += o.sendMs;
      if (o.sendThrows) throw new Error('send');
      return { success: true, sent: 3, failed: 0, deferred: 0, marker: 'NUDGE' };
    },
  });
  //   うながしのロック（ScriptLock）。自己修理の印も同じ LockService を使う＝持っている間は自己修理が印を取れない
  const realLock = ctx.LockService;
  ctx.LockService = { getScriptLock: () => ({
    tryLock: (ms) => {
      if (ms === 15000) { if (o.nudgeLockBusy) return false; lockHeld = true; log.push('lock'); return true; }
      if (lockHeld) { log.push('healLockWhileHeld'); return false; }
      return realLock.getScriptLock().tryLock(ms);
    },
    releaseLock: () => { if (lockHeld) { lockHeld = false; log.push('unlock'); } },
  }) };
  vm.runInContext([pluckFn(NUDGE, 'lbNudgeDaily'), pluckFn(NUDGE, '_lbNudgeThenSelfHeal')].join('\n'), ctx);
  if (o.healThrows) ctx.lbSelfHeal = () => { log.push('heal'); throw new Error('自己修理が落ちた'); };
  else { const real = ctx.lbSelfHeal; ctx.lbSelfHeal = (...a) => { log.push('heal'); return real(...a); }; }
  w.depth = (w.depth || 0) + 1;
  let res, err = null;
  try { res = ctx.lbNudgeDaily(o.arg); } catch (e) { err = e; } finally { w.depth--; }
  return { res, err, log };
}

console.log('=== I-H29 相乗り ===');
{
  const w = makeWorld({ props: { SELF_HEAL_MODE: 'on' } });
  removeTrigger(w, 'dailySync');
  run(w, 'dailyHealthCheck'); w.now += 3 * H;
  const r = nudge(w, { arg: { triggerUid: 'x' } });
  ok('I-H29-1 ★うながしの戻り値はそのまま', r.res && r.res.marker === 'NUDGE' && r.res.sent === 3 && !r.err, JSON.stringify(r));
  ok('I-H29-2 ★順序：見張り → ロック → 一覧 → 送信 → ロックを放す → 自己修理（全部終わった後）', r.log.join(',') === 'watch,lock,plan,send,unlock,heal', r.log.join(','));
  ok('I-H29-3 自己修理は実際に動いた（足りないトリガーを足した・完走の印）', countTrigger(w, 'dailySync') === 1 && !!w.props.LB_SELFHEAL_DONE && incOf(w, 'trigger_missing')[0].attempts === 1);
  //   自己修理が例外
  const w2 = makeWorld();
  const r2 = nudge(w2, { healThrows: true });
  ok('I-H29-4 ★自己修理の例外はうながし側に漏れない（戻り値はそのまま）', !r2.err && r2.res && r2.res.marker === 'NUDGE' && r2.log[r2.log.length - 1] === 'heal', JSON.stringify(r2));
  //   うながしがロックを取れなかった（早く戻る）ときも、自己修理は呼ぶ・戻り値はそのまま
  const w3 = makeWorld();
  const r3 = nudge(w3, { nudgeLockBusy: true });
  ok('I-H29-5 うながしが ALREADY_RUNNING で戻っても戻り値はそのまま・自己修理は呼ぶ', r3.res && r3.res.code === 'ALREADY_RUNNING' && r3.log.indexOf('heal') >= 0 && r3.log.indexOf('send') < 0, r3.log.join(','));
  //   うながしが例外 → 今までどおり外へ出る（握りつぶさない）
  const w4 = makeWorld();
  const r4 = nudge(w4, { sendThrows: true });
  ok('I-H29-6 うながしの例外は今までどおり外へ出る（相乗りが握りつぶさない）', r4.err && r4.err.message === 'send' && r4.log.indexOf('unlock') >= 0, String(r4.err));
  ok('I-H29-7 自己修理がうながしのロックを持ったまま走らない', r.log.indexOf('healLockWhileHeld') < 0 && r3.log.indexOf('healLockWhileHeld') < 0);
  //   うながしに4分30秒かかった → 修理は始めない（no_time）・うながしの戻り値はそのまま
  const w5 = makeWorld({ props: { SELF_HEAL_MODE: 'on' } });
  removeTrigger(w5, 'dailySync');
  run(w5, 'dailyHealthCheck'); w5.now += 3 * H;
  const r5 = nudge(w5, { sendMs: 4.5 * 60000 });
  ok('I-H29-9（I-H31）★うながしの開始時刻を渡す：うながしが長ければ修理を始めない（no_time）', r5.res.marker === 'NUDGE' && w5.created.length === 0 && JSON.parse(w5.props.LB_HEALTH_SKIP || '{}').why === 'no_time', JSON.stringify({ r5, s: w5.props.LB_HEALTH_SKIP, c: w5.created.length }));
  //   本物のソース：finally で値を返さない（戻り値を書き換えない）
  const body = pluckFn(NUDGE, 'lbNudgeDaily');
  const fin = body.slice(body.lastIndexOf('} finally {'));
  ok('I-H29-8 最後の finally は _lbNudgeThenSelfHeal(_t0) を呼ぶだけ（return を書かない）', /_lbNudgeThenSelfHeal\(_t0\);/.test(fin) && !/return/.test(fin), fin);
}

t.end('自己修理 P1 うながしへの相乗り');
