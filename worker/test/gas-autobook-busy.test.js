// 設計47 §7：固定枠の自動予約（autoBookRecurringPatterns）が予約のロックの混雑（BUSY）に当たったとき（2026-11-20）
//   実行: node worker/test/gas-autobook-busy.test.js
//
//   入口から（autoBookRecurringPatterns・lbAutoBookRetry を呼ぶ）。身代わりは台帳・予約の芯・お知らせ・トリガー・時計だけ
//   ① BUSY が1回で解ける → 間隔をあけて取り直して取れる・冪等マークが付く・お知らせに BUSY が無い・保留0・取り直しの予約なし
//   ② BUSY が続く → 3回取り直して保留：冪等マークを付けない・お知らせを送らない（skipped に BUSY が載らない）・件数に足さない
//      ほかの会員は今どおり取れて、マークもお知らせも付く。保留の人数を残し、一回限りトリガー（lbAutoBookRetry）を1つ予約
//   ③ 取り直し（lbAutoBookRetry）：前の実行で取れた枠は本人の予約として見分けて二重に取らない・残りを取る・お知らせは1回
//   ④ 別の月の保留・保留0なら取り直さない／1つの月に4回まで／トリガーを作れないときは予約なしで残す
//   ⑤ 4分を過ぎたら取り直さず、残りの会員を保留にする（6分の上限）
//   ⑥ 日次点検：保留があれば warn（人数・手動で再実行）
//   ★値は架空（個人情報を書かない）
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { pluckFnFrom as pluckFn, pluckVarFrom as pluckVar } from './_gas-lock-src.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LB = readFileSync(join(process.env.GAS_DIR || join(ROOT, 'gas'), 'LineBooking.js'), 'utf8');
let pass = 0, fail = 0;
function ok(name, cond, why) { if (cond) pass++; else { fail++; console.log(`❌ ${name}`); if (why) console.log(`   ${why}`); } }
const pad = (n) => ('0' + n).slice(-2);
const RP_COL = { PATTERN_ID: 1, CUSTOMER_ID: 2, WEEKDAY: 3, TIME: 4, TRAINER_ID: 5, ACTIVE: 6, SOURCE: 7, CREATED_AT: 8, LAST_MONTH: 9, NOTE: 10 };
const RT = 'var _LB_RECUR_TZ = null;\n' + pluckFn(LB, '_lbRecurTz') + '\n' + pluckFn(LB, '_lbRecurTime');

//   2026-10-25 06:00 に走らせて 11月を取る。busy(cid, startISO, n) が真のあいだ BUSY
function world({ rows, busy = () => false, props = {}, startMs = new Date(2026, 9, 25, 6).getTime(), triggerThrows = false, slowReserveMs = 0, onReserve = null, leaseLock = 'ok' }) {
  let nowMs = startMs;
  const st = { rows: rows.map((r) => r.slice()), ledger: {}, calls: [], sleeps: [], notices: [], props: Object.assign({}, props), triggers: [], created: 0, deleted: 0, enq: [], lockOwner: null, uuid: 0, inner: [] };
  class FD extends Date { constructor(...a) { if (a.length === 0) super(nowMs); else super(...a); } static now() { return nowMs; } }
  const n = {};
  const ctx = {
    String, Number, isNaN, isFinite, Math, JSON, Object, Array, Date: FD, RP_COL,
    SETTINGS: { TIMEZONE: 'Asia/Tokyo', SESSION_MINUTES: 60 },
    Utilities: { formatDate: (d, tz, f) => (f === 'HH:mm' ? pad(d.getHours()) + ':' + pad(d.getMinutes()) : String(d)), sleep: (ms) => { st.sleeps.push(ms); nowMs += ms; }, getUuid: () => 'tok-' + (++st.uuid) },
    //   リースを取る・返す瞬間だけの ScriptLock（再入しない身代わり：持っているのに取ろうとしたら例外）
    LockService: { getScriptLock: () => ({ tryLock: () => { if (leaseLock === 'false') return false; if (leaseLock === 'throw') throw new Error('Lock service boom'); if (st.lockOwner) throw new Error('REENTRANT'); st.lockOwner = 'me'; return true; }, releaseLock: () => { st.lockOwner = null; }, hasLock: () => st.lockOwner === 'me' }) },
    _lbSs: () => ({ getSpreadsheetTimeZone: () => 'Asia/Tokyo' }),
    Logger: { log: () => {} },
    _lbTruthy: (v) => v === true, LB_AUTOBOOK_RESULT_PREFIX: 'LB_AUTOBOOK_RESULT_',
    _lbRecurSheet: () => ({ getLastRow: () => st.rows.length + 1, getRange: (r, c) => ({ getValues: () => st.rows.map((x) => x.slice()), setValue: (v) => { st.rows[r - 2][c - 1] = v; } }) }),
    _lbResvSessions: (cid) => (st.ledger[cid] || []).map((ms) => ({ startAt: ms, channel: 'line' })),
    _lbCustInfoById: (cid) => ({ customerId: cid, customerName: 'テスト', contractType: '' }), _lbPickBalancedTrainer: () => 'B',
    getBookableRemaining: () => ({ ok: true, monthlyRem: null }),
    _lbReserveCore: (ci, body) => {
      const key = ci.customerId + '|' + body.startISO;
      n[key] = (n[key] || 0) + 1;
      st.calls.push(key);
      nowMs += 10 + slowReserveMs;
      if (onReserve) onReserve(ctx, st, key, n[key]);
      if (busy(ci.customerId, body.startISO, n[key])) { nowMs += 10000; return { success: false, code: 'BUSY', message: '混み合っています' }; }
      if ((st.ledger[ci.customerId] || []).includes(new Date(body.startISO).getTime())) return { success: false, code: 'SLOT_TAKEN' };   // 同じ枠はもう取れない
      (st.ledger[ci.customerId] = st.ledger[ci.customerId] || []).push(new Date(body.startISO).getTime());
      return { success: true };
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in st.props ? st.props[k] : null), setProperty: (k, v) => { st.props[k] = String(v); }, deleteProperty: (k) => { delete st.props[k]; } }) },
    ScriptApp: {
      getProjectTriggers: () => st.triggers.map((h) => ({ getHandlerFunction: () => h })),
      deleteTrigger: (t) => { const i = st.triggers.indexOf(t.getHandlerFunction()); if (i >= 0) { st.triggers.splice(i, 1); st.deleted++; } },
      newTrigger: (h) => ({ timeBased: () => ({ after: (ms) => ({ create: () => { if (triggerThrows) throw new Error('上限'); st.triggers.push(h); st.created++; st.lastAfter = ms; } }) }) }),
    },
    _lbDwMarkDirty: () => {}, lbDwEnqueue: (c) => { st.enq.push(c); return 1; },
    _lbNotifyAutoBook: (c, b, s) => st.notices.push({ c, b, s }),
  };
  vm.createContext(ctx);
  const oneLine = (nm) => { const m = LB.match(new RegExp('\\nfunction ' + nm + '\\(\\) \\{[^\\n]*\\}\\n')); if (!m) throw new Error('見つからない: ' + nm); return m[0]; };
  vm.runInContext([RT, pluckFn(LB, '_lbDatesOfWeekdayInMonth'), oneLine('autoBookRecurringPatterns'), pluckFn(LB, '_lbAutoBookRun'),
    pluckVar(LB, 'LB_AUTOBOOK_HELD_PROP'), pluckVar(LB, 'LB_AB_RETRY'), pluckVar(LB, 'LB_AB_LEASE'),
    pluckFn(LB, '_lbAutoBookTargetKey'), pluckFn(LB, '_lbAutoBookHeldNote'), pluckFn(LB, '_lbAutoBookRetryClean'), oneLine('lbAutoBookRetry'),
    pluckFn(LB, '_lbAutoBookEntry'), pluckFn(LB, '_lbAbLeaseTake'), pluckFn(LB, '_lbAbLeaseRelease'), pluckFn(LB, '_lbAbNoteLeaseSkip'),
    pluckFn(LB, '_lbAutoBookRowPending'), pluckFn(LB, '_lbAutoBookPendingCount'), pluckFn(LB, 'lbAutoBookDailyCheck')].join('\n'), ctx);
  return { ctx, st, adv: (ms) => { nowMs += ms; }, setNow: (ms) => { nowMs = ms; } };
}
//   C1：火曜 9:00（11月は 3・10・17・24）／C2：木曜 9:00
const ROWS = () => [['P-1', 'C1', 2, '09:00', 'B', true, '', '', '', ''], ['P-2', 'C2', 4, '09:00', 'B', true, '', '', '', '']];
const held = (st) => JSON.parse(st.props.LB_AUTOBOOK_HELD || 'null');
const noticeOf = (st, cid) => st.notices.filter((x) => x.c === cid);
const isoOf = (d) => new Date(2026, 10, d, 9).toISOString();

console.log('=== ① BUSY が1回で解ける ===');
{
  const w = world({ rows: ROWS(), busy: (cid, iso, k) => cid === 'C1' && iso === isoOf(10) && k === 1 });
  w.ctx.autoBookRecurringPatterns();
  ok('①-1 間隔（3秒）をあけて取り直し、取れた', JSON.stringify(w.st.sleeps) === JSON.stringify([3000]) && (w.st.ledger.C1 || []).length === 4, JSON.stringify({ s: w.st.sleeps, l: (w.st.ledger.C1 || []).length }));
  ok('①-2 冪等マークが付く', w.st.rows[0][RP_COL.LAST_MONTH - 1] === '2026-11');
  const nc = noticeOf(w.st, 'C1');
  ok('①-3 お知らせは1回・4回取れた・BUSY は載らない', nc.length === 1 && nc[0].b.length === 4 && nc[0].s.length === 0, JSON.stringify(nc));
  ok('①-4 保留0・取り直しの予約なし', held(w.st) && held(w.st).n === 0 && w.st.created === 0, JSON.stringify(held(w.st)));
}

console.log('=== ② BUSY が続く ===');
{
  const w = world({ rows: ROWS(), busy: (cid, iso) => cid === 'C1' && iso === isoOf(10) });
  const r = w.ctx.autoBookRecurringPatterns();
  ok('②-1 3回取り直した（3秒・6秒・10秒）', JSON.stringify(w.st.sleeps) === JSON.stringify([3000, 6000, 10000]), JSON.stringify(w.st.sleeps));
  ok('②-2 ★その会員の残りの枠は今回は取らない（次の実行で）', !w.st.calls.includes('C1|' + isoOf(17)) && !w.st.calls.includes('C1|' + isoOf(24)), w.st.calls.join(','));
  ok('②-3 ★冪等マークを付けない', w.st.rows[0][RP_COL.LAST_MONTH - 1] === '', JSON.stringify(w.st.rows[0]));
  ok('②-4 ★お知らせを送らない（BUSY が skipped に載ることもない）', noticeOf(w.st, 'C1').length === 0 && !w.st.notices.some((x) => x.s.some((y) => y.code === 'BUSY')), JSON.stringify(w.st.notices));
  ok('②-5 取れた1枠（11/3）は写しへ積む', w.st.enq.includes('C1'));
  ok('②-6 件数（25日のお知らせが読む）に保留の会員を足さない', !('C1' in JSON.parse(w.st.props['LB_AUTOBOOK_RESULT_2026-11'] || '{}')) && ('C2' in JSON.parse(w.st.props['LB_AUTOBOOK_RESULT_2026-11'] || '{}')));
  ok('②-7 ほかの会員（C2）は今どおり：4回取れ・マーク・お知らせ', (w.st.ledger.C2 || []).length === 4 && w.st.rows[1][RP_COL.LAST_MONTH - 1] === '2026-11' && noticeOf(w.st, 'C2').length === 1);
  const h = held(w.st);
  ok('②-8 保留の人数を残す（会員IDを持たない）', h && h.n === 1 && h.m === '2026-11' && h.tries === 1 && h.sched === true && !/C1|C2/.test(w.st.props.LB_AUTOBOOK_HELD), w.st.props.LB_AUTOBOOK_HELD);
  ok('②-9 一回限りトリガー lbAutoBookRetry を1つ（15分後）', w.st.created === 1 && w.st.triggers.filter((x) => x === 'lbAutoBookRetry').length === 1 && w.st.lastAfter === 900000);
  ok('②-10 戻り値に保留の人数', r && r.held === 1);

}
console.log('=== ③ 取り直し ===');
{
  //   ③ は混雑が解けた世界でもう一度通す（同じ台帳・同じ行・同じ Properties を引き継ぐ）
  const a = world({ rows: ROWS(), busy: (cid, iso) => cid === 'C1' && iso === isoOf(10) });
  a.ctx.autoBookRecurringPatterns();
  const b = world({ rows: a.st.rows, props: a.st.props, startMs: new Date(2026, 9, 25, 6, 15).getTime() });
  b.st.ledger = JSON.parse(JSON.stringify(a.st.ledger));
  b.st.triggers = a.st.triggers.slice().concat(['autoBookRecurringPatterns']);
  b.ctx.lbAutoBookRetry({ triggerUid: 'x' });
  const c1 = b.st.calls.filter((x) => x.startsWith('C1|'));
  ok('③-1 ★前の実行で取れた 11/3 は取り直さない（二重予約しない）', !c1.includes('C1|' + isoOf(3)), c1.join(','));
  ok('③-2 残り（11/10・17・24）を取る', JSON.stringify(c1) === JSON.stringify(['C1|' + isoOf(10), 'C1|' + isoOf(17), 'C1|' + isoOf(24)]), c1.join(','));
  ok('③-3 台帳の C1 は4件ちょうど', (b.st.ledger.C1 || []).length === 4, JSON.stringify(b.st.ledger.C1));
  ok('③-4 C2 は前の実行でマーク済み＝触らない', !b.st.calls.some((x) => x.startsWith('C2|')));
  const nc = noticeOf(b.st, 'C1');
  ok('③-5 お知らせは取り終えた実行で1回（取れていた 11/3 を含む4回）', nc.length === 1 && nc[0].b.length === 4 && nc[0].b.filter((x) => x.already).length === 1 && nc[0].s.length === 0, JSON.stringify(nc));
  ok('③-6 冪等マークが付く・保留0', b.st.rows[0][RP_COL.LAST_MONTH - 1] === '2026-11' && held(b.st).n === 0, JSON.stringify(held(b.st)));
  ok('③-7 ★取り直しのトリガーは消し、月の定期（autoBookRecurringPatterns）は残す', !b.st.triggers.includes('lbAutoBookRetry') && b.st.triggers.includes('autoBookRecurringPatterns'), JSON.stringify(b.st.triggers));
  ok('③-8 件数は取り終えた実行で足す（C1 b=4）', (JSON.parse(b.st.props['LB_AUTOBOOK_RESULT_2026-11'] || '{}').C1 || {}).b === 4, b.st.props['LB_AUTOBOOK_RESULT_2026-11']);
  //   もう一度走っても何もしない（冪等）
  const before = b.st.calls.length;
  b.ctx.autoBookRecurringPatterns();
  ok('③-9 さらに再実行しても何も取らない', b.st.calls.length === before);
}

console.log('=== ④ 取り直さないとき・回数の上限・作れないとき ===');
{
  //   対象月の固定枠が全部済んでいる（未完了0）ときの取り直し
  const DONE = () => ROWS().map((r) => { const x = r.slice(); x[RP_COL.LAST_MONTH - 1] = '2026-11'; return x; });
  const w = world({ rows: DONE(), props: { LB_AUTOBOOK_HELD: JSON.stringify({ m: '2026-10', n: 2, tries: 1 }) } });
  const r = w.ctx.lbAutoBookRetry();
  ok('④-1 別の月の保留（未完了0）なら何もしない', r && r.skipped === true && w.st.calls.length === 0);
  const w2 = world({ rows: DONE(), props: { LB_AUTOBOOK_HELD: JSON.stringify({ m: '2026-11', n: 0, tries: 1 }) } });
  ok('④-2 保留0（未完了0）なら何もしない', w2.ctx.lbAutoBookRetry().skipped === true && w2.st.calls.length === 0);
  const w3 = world({ rows: ROWS(), busy: (cid) => cid === 'C1', props: { LB_AUTOBOOK_HELD: JSON.stringify({ m: '2026-11', n: 1, tries: 4 }) } });
  w3.ctx.autoBookRecurringPatterns();
  ok('④-3 1つの月に4回まで（5回目は予約しない・保留は残す）', w3.st.created === 0 && held(w3.st).n === 1 && held(w3.st).tries === 4 && held(w3.st).sched === false, JSON.stringify(held(w3.st)));
  const w4 = world({ rows: ROWS(), busy: (cid) => cid === 'C1', triggerThrows: true });
  w4.ctx.autoBookRecurringPatterns();
  ok('④-4 トリガーを作れなければ予約なしで保留を残す（点検が知らせる）', held(w4.st).n === 1 && held(w4.st).sched === false && held(w4.st).tries === 0, JSON.stringify(held(w4.st)));
}

console.log('=== ⑤ 4分を過ぎたら ===');
{
  //   1回の予約に70秒かかる世界：C1 の4枠で4分を超え、C2 は保留になる
  const w = world({ rows: ROWS(), slowReserveMs: 70000 });
  w.ctx.autoBookRecurringPatterns();
  ok('⑤-1 4分を過ぎた後の会員（C2）は試さずに保留（マークなし・お知らせなし）', !w.st.calls.some((x) => x.startsWith('C2|')) && w.st.rows[1][RP_COL.LAST_MONTH - 1] === '' && noticeOf(w.st, 'C2').length === 0 && held(w.st).n === 1, JSON.stringify({ calls: w.st.calls, h: held(w.st) }));
  //   走り始めから4分近くで BUSY：取り直しは時間の内だけ
  const w3 = world({ rows: ROWS(), busy: (cid, iso) => cid === 'C1' && iso === isoOf(3), slowReserveMs: 235000 });
  w3.ctx.autoBookRecurringPatterns();
  ok('⑤-2 4分を過ぎたら取り直さない（sleep しない）', w3.st.sleeps.length === 0 && held(w3.st).n >= 1, JSON.stringify({ s: w3.st.sleeps, h: held(w3.st) }));
}

console.log('=== ⑥ 日次点検（保留） ===');
{
  const w = world({ rows: ROWS(), props: { LB_AUTOBOOK_HELD: JSON.stringify({ m: '2026-11', n: 2, tries: 4, sched: false }) } });
  const chk = (props, ms) => w.ctx.lbAutoBookDailyCheck(ms, (k) => (k in props ? props[k] : null), () => 0);
  const r = chk(w.st.props, new Date(2026, 9, 26, 7).getTime());
  const a = r.find((x) => x.key === 'autobook_held');
  ok('⑥-1 保留があれば warn（人数・手動で再実行）', a && a.severity === 'warn' && a.count === 2 && /固定枠の自動予約を混雑で保留した会員 2 名/.test(a.detail) && /手動で autoBookRecurringPatterns を再実行/.test(a.detail), JSON.stringify(a));
  const r0 = chk({ LB_AUTOBOOK_HELD: JSON.stringify({ m: '2026-11', n: 0 }) }, new Date(2026, 9, 26, 7).getTime());
  ok('⑥-2 保留0なら鳴らさない', !r0.some((x) => x.key === 'autobook_held'));
}

console.log('=== ⑦ 実行全体の排他（リース） ===');
{
  //   定期の実行の最初の予約の最中に、取り直し（lbAutoBookRetry）と手動の実行が割り込む（2本同時の身代わり）
  let fired = false;
  const w = world({ rows: ROWS(), props: { LB_AUTOBOOK_HELD: JSON.stringify({ m: '2026-11', n: 1, tries: 1 }) },
    onReserve: (ctx, st, key, k) => { if (!fired) { fired = true; st.inner.push(ctx.lbAutoBookRetry()); st.inner.push(ctx.autoBookRecurringPatterns()); } } });
  w.ctx.autoBookRecurringPatterns();
  ok('⑦-1 ★割り込んだ2つの実行はリースを取れず何もしない', w.st.inner.length === 2 && w.st.inner.every((x) => x && x.skipped === true && x.reason === 'LEASE_LIVE'), JSON.stringify(w.st.inner));
  ok('⑦-2 お知らせは会員ごとに1回', noticeOf(w.st, 'C1').length === 1 && noticeOf(w.st, 'C2').length === 1, JSON.stringify(w.st.notices.map((x) => x.c)));
  const res = JSON.parse(w.st.props['LB_AUTOBOOK_RESULT_2026-11'] || '{}');
  ok('⑦-3 件数は1回だけ（C1 b=4・C2 b=4）', (res.C1 || {}).b === 4 && (res.C2 || {}).b === 4, JSON.stringify(res));
  ok('⑦-4 二重予約なし・SLOT_TAKEN を skipped にしない', (w.st.ledger.C1 || []).length === 4 && !w.st.notices.some((x) => x.s.length), JSON.stringify(w.st.notices));
  ok('⑦-5 取り直しのトリガーは0本（保留0）', w.st.triggers.filter((x) => x === 'lbAutoBookRetry').length === 0);
  ok('⑦-6 リースは返してある・何もしなかった回を数える', !('LB_AUTOBOOK_LEASE' in w.st.props) && /^2\|/.test(w.st.props.LB_AUTOBOOK_LEASE_SKIP || ''), JSON.stringify(w.st.props.LB_AUTOBOOK_LEASE_SKIP));
}
{
  //   保留が残る実行の最中に取り直しが割り込んでも、トリガーは1本
  let fired = false;
  const w = world({ rows: ROWS(), busy: (cid) => cid === 'C1', onReserve: (ctx, st) => { if (!fired) { fired = true; st.inner.push(ctx.lbAutoBookRetry()); } } });
  w.ctx.autoBookRecurringPatterns();
  ok('⑦-7 保留が残っても取り直しのトリガーは1本', w.st.triggers.filter((x) => x === 'lbAutoBookRetry').length === 1 && w.st.created === 1, JSON.stringify(w.st.triggers));
}
{
  const NOW = new Date(2026, 9, 25, 6).getTime();
  const w = world({ rows: ROWS(), props: { LB_AUTOBOOK_LEASE: JSON.stringify({ token: 'old', until: NOW - 1, at: NOW - 9 * 60000 }) } });
  const r = w.ctx.autoBookRecurringPatterns();
  ok('⑦-8 期限切れのリースは奪って走る（落ちた実行で止まり続けない）・終わったら返す', r && !r.skipped && noticeOf(w.st, 'C1').length === 1 && !('LB_AUTOBOOK_LEASE' in w.st.props), JSON.stringify(r));
  const w2 = world({ rows: ROWS(), props: { LB_AUTOBOOK_LEASE: JSON.stringify({ token: 'other', until: NOW + 60000, at: NOW }) } });
  const r2 = w2.ctx.autoBookRecurringPatterns();
  ok('⑦-9 生きているリースがあれば何もしない（予約0・お知らせ0）', r2 && r2.skipped === true && w2.st.calls.length === 0 && w2.st.notices.length === 0 && JSON.parse(w2.st.props.LB_AUTOBOOK_LEASE).token === 'other');
  const w3 = world({ rows: ROWS(), props: { LB_AUTOBOOK_LEASE: '{壊れた' } });
  const r3 = w3.ctx.autoBookRecurringPatterns();
  ok('⑦-10 壊れたリースは奪って走る', r3 && !r3.skipped && w3.st.notices.length === 2);
  //   実行の途中で（期限切れで）別の実行にリースを奪われた → 返すとき token が違うので消さない
  let done = false;
  const w4 = world({ rows: ROWS(), onReserve: (ctx, st) => { if (!done) { done = true; st.props.LB_AUTOBOOK_LEASE = JSON.stringify({ token: 'thief', until: NOW + 99999999, at: NOW }); } } });
  w4.ctx.autoBookRecurringPatterns();
  ok('⑦-11 ★返すとき token が自分のものでなければ消さない', JSON.parse(w4.st.props.LB_AUTOBOOK_LEASE || '{}').token === 'thief', w4.st.props.LB_AUTOBOOK_LEASE);
  ok('⑦-12 リースを取る・返す瞬間のロックは放してある', w4.st.lockOwner === null && w.st.lockOwner === null);
}

console.log('=== ⑧ 状態で見る検出（未完了の固定枠）＋始められなかった定期の取り直し ===');
const AT7 = new Date(2026, 9, 25, 7).getTime();
const pendWarn = (w, ms) => (w.ctx.lbAutoBookDailyCheck(ms || AT7, (k) => (k in w.st.props ? w.st.props[k] : null), (d) => w.ctx._lbAutoBookPendingCount(d)) || []).find((x) => x.key === 'autobook_pending');
for (const mode of ['false', 'throw']) {
  const w = world({ rows: ROWS(), leaseLock: mode });
  let r; try { r = w.ctx.autoBookRecurringPatterns(); } catch (e) { r = { threw: String(e) }; }   // 例外が外へ出たら落とす
  const why = mode === 'false' ? 'LOCK_BUSY' : 'LOCK_ERROR';
  ok(`⑧-${mode}-1 リースの ScriptLock が ${mode === 'false' ? '取れない' : '例外'}：何もせず終わる（例外を外へ出さない）・理由 ${why}`, r && r.skipped === true && r.reason === why && w.st.calls.length === 0, JSON.stringify(r));
  ok(`⑧-${mode}-2 始められなかった回を理由つきで残す（run・${why}・取り直しを作った）`, new RegExp('^1\\|\\d+\\|run\\|' + why + '\\|retry$').test(w.st.props.LB_AUTOBOOK_LEASE_SKIP || ''), w.st.props.LB_AUTOBOOK_LEASE_SKIP);
  ok(`⑧-${mode}-3 ★25日の定期が始められなければ15分後の取り直しを1本作る`, w.st.triggers.filter((x) => x === 'lbAutoBookRetry').length === 1 && w.st.lastAfter === 900000);
  const pw = pendWarn(w);
  ok(`⑧-${mode}-4 ★点検：未完了2件で warn（会員IDなし）・始められなかった回も同じ段に出る`, pw && pw.severity === 'warn' && pw.count === 2 && /未完了 2件/.test(pw.detail) && /始められなかった回 1/.test(pw.detail) && !/C1|C2/.test(pw.detail), JSON.stringify(pw));
}
{
  //   強制終了の身代わり：本体の途中で止まり、finally も末尾（保留の記録）も走らない＝C1 だけ印が付き、リースが残る
  const w = world({ rows: ROWS() });
  w.ctx.autoBookRecurringPatterns();
  const NOW = new Date(2026, 9, 25, 6).getTime();
  w.st.rows[1][RP_COL.LAST_MONTH - 1] = '';                       // C2 の行は印が付く前に止まった
  w.st.props.LB_AUTOBOOK_LEASE = JSON.stringify({ token: 'dead', until: NOW + 8 * 60000, at: NOW });   // 返されないまま
  delete w.st.props.LB_AUTOBOOK_HELD;                              // 末尾の記録も書かれない
  const pw = pendWarn(w);
  ok('⑧-kill-1 ★強制終了相当：未完了1件で warn・リースが残っていることも同じ段に出る', pw && pw.count === 1 && /リースが残っている/.test(pw.detail), JSON.stringify(pw));
  //   リースの期限が過ぎた後の取り直し（保留の記録は無いが、25日以降で未完了がある）→ 取り終える
  w.setNow(NOW + 20 * 60000);
  const r = w.ctx.lbAutoBookRetry();
  ok('⑧-kill-2 保留の記録が無くても、25日以降で未完了があれば取り直しが走る', r && !r.skipped, JSON.stringify(r));
  ok('⑧-kill-3 ★取り終えたら未完了0で warn が消える', !pendWarn(w, new Date(2026, 9, 25, 7, 30).getTime()) && w.st.rows[1][RP_COL.LAST_MONTH - 1] === '2026-11');
  ok('⑧-kill-4 二重予約なし（C1・C2 とも4件）', (w.st.ledger.C1 || []).length === 4 && (w.st.ledger.C2 || []).length === 4);
}
{
  const w = world({ rows: ROWS() });
  ok('⑧-5 走る前（25日 7時・未完了2件）は warn', (pendWarn(w) || {}).count === 2);
  w.ctx.autoBookRecurringPatterns();
  ok('⑧-6 ★完了後は未完了0で warn が消える', !pendWarn(w));
  const w2 = world({ rows: ROWS() });
  ok('⑧-7 25日より前は未完了でも鳴らさない（まだ取る日ではない）', !pendWarn(w2, new Date(2026, 9, 24, 7).getTime()));
  const w3 = world({ rows: ROWS(), startMs: new Date(2026, 9, 20, 6).getTime() });
  ok('⑧-8 25日より前の取り直しは、保留が無ければ何もしない（先の月を早く取らない）', w3.ctx.lbAutoBookRetry().skipped === true && w3.st.calls.length === 0);
  ok('⑧-9 点検は本体と同じ判定の関数（_lbAutoBookRowPending）を使う', /_lbAutoBookRowPending\(v\[i\], targetKey\)/.test(LB) && /_lbAutoBookRowPending\(v\[i\], key\)/.test(LB));
}

console.log(`\n${fail ? '❌' : '✅'} 設計47 自動予約の混雑 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
