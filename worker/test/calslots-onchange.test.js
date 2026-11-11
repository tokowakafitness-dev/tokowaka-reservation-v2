// 設計42：カレンダーが変わったら、空き枠をすぐ押し出す（2026-11-11）
//   実行: node worker/test/calslots-onchange.test.js
//
//   ① 押し出す条件：patched / published だけ（unchanged・知らない mode・失敗は押し出さない）
//   ② 入口から通す：lbCalSyncTick → 同期 → 配線の印 → 押し出し。予約直後は 同期→二重書き→掃除→押し出し の順
//   ③ 目標予算（送り終えた実測の合計）・栓・実行ユーザーの食い違い・壊れた記録・ロックが取れない
//   ④ 結果の分類（固定の表）・pushToEdgeSlots が状態を返す
//   ⑤ 日次点検（昨日のキーを JST で読む・stale は害なし・配線の印）
//   ⑥ 新しいトリガーを作らない
//   ★値は架空（個人情報を書かない）
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PE = readFileSync(join(ROOT, 'gas/PushToEdge.js'), 'utf8');
const LB = readFileSync(join(ROOT, 'gas/LineBooking.js'), 'utf8');
let pass = 0, fail = 0;
function ok(name, cond, why) { if (cond) pass++; else { fail++; console.log(`❌ ${name}`); if (why) console.log(`   ${why}`); } }
function pluckFn(src, name) {
  const m = src.match(new RegExp('\\nfunction ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('見つからない: ' + name);
  return m[0];
}
function pluckVar(src, name) {
  const m = src.match(new RegExp('\\nvar ' + name + ' = [\\s\\S]*?;\\n'));
  if (!m) throw new Error('見つからない: ' + name);
  return m[0];
}

const H = 3600000, DAY = 86400000;
const jst = (y, m, d, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi) - 9 * H;
const FNS = ['_lbCalSlotsDayKey', '_lbCalSlotsShouldRun', '_lbCalSlotsClassify', '_lbCalSlotsParse', '_lbCalSlotsDay',
  '_lbCalSlotsPrune', '_lbCalSlotsProp', '_lbCalSlotsWired', '_lbCalSlotsSameUser',
  '_lbCalSlotsWithRecord', '_lbCalSlotsLost', '_lbCalSlotsAfter', 'lbCalSlotsDailyCheck', 'lbCalSyncTick', '_lbCalSyncAfterWrite'];

function make(opt = {}) {
  let nowMs = opt.now || jst(2026, 11, 11, 15, 0);
  const props = Object.assign({}, opt.props || {});
  const log = [];
  let lockOk = opt.lockOk !== false;
  class FD extends Date { constructor(...a) { if (a.length === 0) super(nowMs); else super(...a); } static now() { return nowMs; } }
  const ctx = {
    String, Number, JSON, Math, Object, isFinite, Date: FD,
    Logger: { log: () => {} },
    LB_HEALTH_BUILD: '2026-11-11a テスト',
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (k in props ? props[k] : null),
      setProperty: (k, v) => { props[k] = String(v); },
    }) },
    LockService: { getUserLock: () => ({ tryLock: () => lockOk, releaseLock: () => {} }) },
    ScriptApp: { getProjectTriggers: () => { if (opt.triggersThrow) throw new Error('t'); return (opt.triggers || ['lbCalSyncTick', 'pushToEdgeSlots']).map((h) => ({ getHandlerFunction: () => h })); } },
    _edgeEnabled: () => opt.edgeOn !== false,
    _edgeProp: (k) => (k === 'LB_CALSYNC_ON' ? (opt.calsyncOn === false ? '0' : '1') : ''),
    pushCalSync: () => { log.push('pushCalSync'); return opt.sync || { ok: true, result: { mode: 'published' } }; },
    _calsyncNote: () => {},
    Utilities: {
      formatDate: (d, tz, fmt) => {
        if (tz !== 'Asia/Tokyo' || fmt !== 'yyyy-MM-dd') throw new Error('想定外の formatDate: ' + tz + ' ' + fmt);
        const j = new Date(d.getTime() + 9 * H);
        return j.getUTCFullYear() + '-' + String(j.getUTCMonth() + 1).padStart(2, '0') + '-' + String(j.getUTCDate()).padStart(2, '0');
      },
      DigestAlgorithm: { SHA_256: 'sha' },
      computeDigest: (_a, s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return [h & 255, (h >> 8) & 255, (h >> 16) & 255, (h >> 24) & 255].map((b) => (b > 127 ? b - 256 : b)); },
    },
    pushToEdgeSlots: () => { log.push('slots'); nowMs += (opt.slotsMs || 25000); if (opt.slotsThrow) throw new Error('x'); return opt.slotsRes === undefined ? 12 : opt.slotsRes; },
    ...(opt.realCore ? {} : { _lbCalSyncCore: () => { log.push('core'); return opt.sync || { ok: true, result: { mode: 'published' } }; } }),
    lbDualWriteDrain: () => { log.push('drain'); },
    _lbCleanCalSyncAfterTriggers: () => { log.push('clean'); },
  };
  vm.createContext(ctx);
  const fns = opt.realCore ? FNS.concat(['_lbCalSyncCore']) : FNS;
  vm.runInContext(pluckVar(PE, 'LB_CALSYNC') + pluckVar(PE, 'LB_CALSLOTS') + pluckVar(PE, 'LB_CALSLOTS_KINDS') + fns.map((n) => pluckFn(PE, n)).join('\n'), ctx);
  return { ctx, props, log, setNow: (v) => { nowMs = v; }, setLock: (v) => { lockOk = v; } };
}
const rec = (props) => JSON.parse(props.LB_CALSLOTS_COUNT || '{}');

console.log('=== ① 押し出す条件 ===');
{
  const { ctx } = make();
  ok('①-1 published は押し出す', ctx._lbCalSlotsShouldRun({ ok: true, result: { mode: 'published' } }) === true);
  ok('①-2 patched は押し出す', ctx._lbCalSlotsShouldRun({ ok: true, result: { mode: 'patched' } }) === true);
  ok('①-3 ★unchanged は押し出さない（第1版はここで常に真＝5分ごとに押し出していた）', ctx._lbCalSlotsShouldRun({ ok: true, result: { mode: 'unchanged' } }) === false);
  ok('①-4 知らない mode は押し出さない', ctx._lbCalSlotsShouldRun({ ok: true, result: { mode: 'weird' } }) === false);
  ok('①-5 mode が無い（旧い応答）は押し出さない', ctx._lbCalSlotsShouldRun({ ok: true, result: {} }) === false);
  ok('①-6 失敗（HTTP_422 等）は押し出さない', ctx._lbCalSlotsShouldRun({ ok: false, code: 'HTTP_422' }) === false);
  ok('①-7 null は押し出さない', ctx._lbCalSlotsShouldRun(null) === false);
}

console.log('=== ② 入口から通す ===');
{
  const t = make();
  t.ctx.lbCalSyncTick();
  ok('②-1 ★5分ごと：同期のあと枠を押し出す', t.log.join(',') === 'core,slots', t.log.join(','));
  const r = rec(t.props)['2026-11-11'];
  ok('②-2 件数：changed 1・sent 1・usedMs 25000', r && r.changed === 1 && r.sent === 1 && r.usedMs === 25000, JSON.stringify(r));
  ok('②-3 配線の印を書く（版|時刻）', /^2026-11-11a\|\d+$/.test(t.props.LB_CALSLOTS_WIRED || ''), t.props.LB_CALSLOTS_WIRED);
  ok('②-4 最後の1回を固定の形で残す', /^\d+\|sent\|25000$/.test(t.props.LB_CALSLOTS_LAST || ''), t.props.LB_CALSLOTS_LAST);
  ok('②-5 5分ごとの経路はトリガーの見え方を確かめない（自分がそのトリガー）', (() => { const x = make({ triggers: [] }); x.ctx.lbCalSyncTick(); return x.log.join(',') === 'core,slots'; })());

  const u = make({ sync: { ok: true, result: { mode: 'unchanged' } } });
  u.ctx.lbCalSyncTick();
  ok('②-6 5分ごと：unchanged なら押し出さない（配線の印は書く）', u.log.join(',') === 'core' && !!u.props.LB_CALSLOTS_WIRED, u.log.join(','));

  const a = make();
  a.ctx._lbCalSyncAfterWrite();
  ok('②-7 ★予約直後：同期→二重書き→掃除→押し出し（押し出しが速い道を待たせない）', a.log.join(',') === 'core,drain,clean,slots', a.log.join(','));
  ok('②-8 予約直後は配線の印（WIRED）を書かない＝5分ごとの配線だけを見張る', !a.props.LB_CALSLOTS_WIRED);

  const e = make();
  e.ctx._lbCalSyncCore = () => { throw new Error('boom'); };
  e.ctx._lbCalSyncAfterWrite();
  ok('②-9 予約直後の同期が例外でも、二重書きと掃除は走り、押し出しはしない', e.log.join(',') === 'drain,clean', e.log.join(','));

  //   本物の _lbCalSyncCore を通す（早い return の経路が変わっていないこと）
  const c1 = make({ realCore: true });
  const r1 = c1.ctx.lbCalSyncTick();
  ok('②-10 本物の同期を通して published なら押し出す', c1.log.join(',') === 'pushCalSync,slots' && r1.ok === true, c1.log.join(','));
  const c2 = make({ realCore: true, edgeOn: false });
  ok('②-11 元栓が閉じていれば EDGE_OFF・同期も押し出しもしない', c2.ctx.lbCalSyncTick().code === 'EDGE_OFF' && c2.log.length === 0);
  const c3 = make({ realCore: true, calsyncOn: false });
  ok('②-12 同期の栓が 0 なら CALSYNC_OFF・押し出さない', c3.ctx.lbCalSyncTick().code === 'CALSYNC_OFF' && c3.log.length === 0);
  const c4 = make({ realCore: true, lockOk: false });
  ok('②-13 前の同期が動いていれば BUSY・押し出さない', c4.ctx.lbCalSyncTick().code === 'BUSY' && c4.log.length === 0);
  const c5 = make({ realCore: true });
  c5.ctx._lbCalSyncAfterWrite();
  ok('②-14 予約直後も本物の同期を通して押し出す', c5.log.join(',') === 'pushCalSync,drain,clean,slots', c5.log.join(','));
}

console.log('=== ③ 予算・栓・ユーザー・記録・ロック ===');
{
  const day = '2026-11-11';
  const b = make({ props: { LB_CALSLOTS_COUNT: JSON.stringify({ [day]: { usedMs: 1800000 } }) } });
  ok('③-1 ★使った時間が30分に達していたら押し出さない', b.ctx._lbCalSlotsAfter({ ok: true, result: { mode: 'published' } }) === 'capped' && b.log.length === 0);
  ok('③-2 capped を数える', rec(b.props)[day].capped === 1, b.props.LB_CALSLOTS_COUNT);
  const b2 = make({ props: { LB_CALSLOTS_COUNT: JSON.stringify({ [day]: { usedMs: 1799999 } }) } });
  b2.ctx._lbCalSlotsAfter({ ok: true, result: { mode: 'patched' } });
  ok('③-3 30分未満なら押し出す（境界）', b2.log.join(',') === 'slots');

  const off = make({ props: { LB_CALSLOTS_ON: '0' } });
  ok('③-4 栓が 0 なら押し出さない', off.ctx._lbCalSlotsAfter({ ok: true, result: { mode: 'published' } }) === 'off' && off.log.length === 0);

  const um = make({ triggers: ['pushToEdgeSlots'] });
  um.ctx._lbCalSyncAfterWrite();
  ok('③-5 ★予約直後の実行から5分ごとのトリガーが見えない（別のユーザー）なら押し出さない', um.log.join(',') === 'core,drain,clean', um.log.join(','));
  ok('③-6 食い違いを記録の異常に残す', /\|TICK_NOT_VISIBLE$/.test(um.props.LB_CALSLOTS_RECORD_ERROR || ''));
  const u1 = make({ triggersThrow: true });
  ok('③-7 トリガーを読めないときも押し出さない（USER_UNKNOWN）', u1.ctx._lbCalSlotsAfter({ ok: true, result: { mode: 'published' } }, 'AFTER') === 'user' && u1.log.length === 0 && /\|USER_UNKNOWN$/.test(u1.props.LB_CALSLOTS_RECORD_ERROR || ''));

  const bad = make({ props: { LB_CALSLOTS_COUNT: '{壊れた' } });
  ok('③-8 ★記録が壊れていたらこの回は押し出さない', bad.ctx._lbCalSlotsAfter({ ok: true, result: { mode: 'published' } }) === 'bad' && bad.log.length === 0);
  ok('③-9 壊れた記録を退避して {} に作り直す', bad.props.LB_CALSLOTS_COUNT === '{}' && bad.props.LB_CALSLOTS_COUNT_BAD === '{壊れた' && /\|BAD_JSON$/.test(bad.props.LB_CALSLOTS_RECORD_ERROR || ''));
  bad.ctx._lbCalSlotsAfter({ ok: true, result: { mode: 'published' } });
  ok('③-10 次の回からは押し出しが再開する', bad.log.join(',') === 'slots');

  const nl = make({ lockOk: false });
  ok('③-11 ロックが取れなければ押し出さず、件数が欠けた印を残す', nl.ctx._lbCalSlotsAfter({ ok: true, result: { mode: 'published' } }) === 'nolock' && nl.log.length === 0 && !!nl.props.LB_CALSLOTS_COUNT_LOST);
  ok('③-12 ロックが取れないとき壊れた記録を作り直さない', (() => { const x = make({ lockOk: false, props: { LB_CALSLOTS_COUNT: '{壊れた' } }); x.ctx._lbCalSlotsAfter({ ok: true, result: { mode: 'published' } }); return x.props.LB_CALSLOTS_COUNT === '{壊れた'; })());

  const st = make();
  const r0 = st.ctx._lbCalSlotsAfter({ ok: true, result: { mode: 'published' } });
  ok('③-13 呼ぶ直前に開始の時刻を書く（終わらなかった回を見分ける）', !!st.props.LB_CALSLOTS_LAST_START && r0 === 'sent');

  const slow = make({ slotsMs: 116000 });
  slow.ctx._lbCalSlotsAfter({ ok: true, result: { mode: 'published' } });
  ok('③-14 115秒を超えた回は slow を数える', rec(slow.props)[day].slow === 1);

  for (const [label, raw] of [['usedMs が文字列', { [day]: { usedMs: 'broken' } }], ['負の値', { [day]: { usedMs: -1 } }],
    ['日の行が配列', { [day]: [1] }], ['日の行が数値', { [day]: 5 }], ['全体が配列', [1]]]) {
    const x = make({ props: { LB_CALSLOTS_COUNT: JSON.stringify(raw) } });
    ok('③-15 ★数値の破損も壊れた記録として扱う：' + label, x.ctx._lbCalSlotsAfter({ ok: true, result: { mode: 'published' } }) === 'bad' && x.log.length === 0);
  }
}

console.log('=== ④ 分類と戻り値 ===');
{
  const { ctx } = make();
  const C = (v) => ctx._lbCalSlotsClassify(v);
  ok('④-1 件数（0 も）は sent', C(12) === 'sent' && C(0) === 'sent');
  ok('④-2 LOCK_SKIP は lockSkip', C('LOCK_SKIP') === 'lockSkip');
  ok('④-3 STALE_SNAPSHOT は stale', C('STALE_SNAPSHOT') === 'stale');
  ok('④-4 UNKNOWN_SNAPSHOT・RECORD_FAILED・ERROR・未知・undefined は error',
     ['UNKNOWN_SNAPSHOT', 'RECORD_FAILED', 'ERROR', 'EDGE_OFF', undefined, null, NaN].every((v) => C(v) === 'error'));
  const ls = make({ slotsRes: 'LOCK_SKIP' });
  ls.ctx._lbCalSlotsAfter({ ok: true, result: { mode: 'published' } });
  ok('④-5 ロック見送りを数える', rec(ls.props)['2026-11-11'].lockSkip === 1);
  const th = make({ slotsThrow: true });
  ok('④-6 押し出しが例外でも外へ出さず error と数える', th.ctx._lbCalSlotsAfter({ ok: true, result: { mode: 'published' } }) === 'error' && rec(th.props)['2026-11-11'].error === 1);
  const ps = pluckFn(PE, 'pushToEdgeSlots');
  ok('④-7 pushToEdgeSlots はロック見送りで LOCK_SKIP を返す', /return \(r === undefined\) \? 'LOCK_SKIP' : r;/.test(ps));
  ok('④-8 pushToEdgeSlots は元栓が閉じていると EDGE_OFF を返す', /if \(!_edgeEnabled\(\)\) return 'EDGE_OFF';/.test(ps));
  const im = pluckFn(PE, '_pushToEdgeSlotsImpl');
  ok('④-9 _pushToEdgeSlotsImpl は件数を返し、例外で ERROR を返す', /return n;/.test(im) && /return 'ERROR';/.test(im));
}

console.log('=== ⑤ 記録の日付と日次点検 ===');
{
  const { ctx } = make();
  ok('⑤-1 日付は JST（UTC 15:30 は翌日）', ctx._lbCalSlotsDayKey(Date.UTC(2026, 10, 11, 15, 30)) === '2026-11-12');
  const r = ctx._lbCalSlotsPrune({ '2026-11-08': {}, '2026-11-09': {}, '2026-11-10': {}, '2026-11-11': {}, junk: 1 });
  ok('⑤-2 直近3日だけ残す・形の違うキーは消す', Object.keys(r).sort().join(',') === '2026-11-09,2026-11-10,2026-11-11', Object.keys(r).join(','));

  const now = jst(2026, 11, 12, 6, 30);
  const base = { LB_CALSYNC_LAST_OK: String(now - 60000), LB_CALSLOTS_WIRED: '2026-11-11a|' + (now - 120000) };
  const chk = (extra) => ctx.lbCalSlotsDailyCheck(now, (k) => ({ ...base, ...extra })[k] ?? null).map((x) => x.key + ':' + x.severity);
  ok('⑤-3 正常なら何も出さない', chk({}).length === 0, chk({}).join(','));
  ok('⑤-4 ★配線の印が無い → high', chk({ LB_CALSLOTS_WIRED: null }).includes('calslots_unwired:high'));
  ok('⑤-5 配線の印の版が違う（旧い版の反映漏れ）→ high', chk({ LB_CALSLOTS_WIRED: '2026-11-10a|' + (now - 1000) }).includes('calslots_unwired:high'));
  ok('⑤-6 配線の印が30分より古い → high', chk({ LB_CALSLOTS_WIRED: '2026-11-11a|' + (now - 31 * 60000) }).includes('calslots_unwired:high'));
  ok('⑤-7 同期そのものが止まっているときは unwired を出さない（同期の見張りの担当）', !chk({ LB_CALSYNC_LAST_OK: String(now - 20 * 60000), LB_CALSLOTS_WIRED: null }).includes('calslots_unwired:high'));
  const yk = '2026-11-11', tk = '2026-11-12';
  const C = (y, t) => chk({ LB_CALSLOTS_COUNT: JSON.stringify({ [yk]: y, ...(t ? { [tk]: t } : {}) }) });
  ok('⑤-8 ★昨日 変更があったのに送れていない → high', C({ changed: 4, error: 4 }).includes('calslots_none_sent:high'));
  ok('⑤-9 ★stale だけの日は送れていない扱いにしない（新しい枠を送り済み）', !C({ changed: 2, stale: 2 }).includes('calslots_none_sent:high'));
  ok('⑤-10 ★今日（0時〜6:30）の記録が始まっていても昨日のキーを読む', C({ changed: 3 }, { changed: 1, sent: 1 }).includes('calslots_none_sent:high'));
  ok('⑤-11 失敗3回以上 → warn', C({ changed: 5, sent: 2, error: 3 }).includes('calslots_error:warn'));
  ok('⑤-12 予算で見送った → warn', C({ changed: 5, sent: 5, capped: 1 }).includes('calslots_capped:warn'));
  ok('⑤-13 ロック見送りが変更の2割以上 → warn', C({ changed: 5, sent: 4, lockSkip: 1 }).includes('calslots_lockskip:warn'));
  ok('⑤-14 使った時間が30分超 → warn', C({ changed: 5, sent: 5, usedMs: 1800001 }).includes('calslots_over:warn'));
  ok('⑤-15 記録の異常（24時間以内）→ high', chk({ LB_CALSLOTS_RECORD_ERROR: (now - 3600000) + '|BAD_JSON' }).includes('calslots_record:high'));
  ok('⑤-16 記録の異常が24時間より前なら出さない', !chk({ LB_CALSLOTS_RECORD_ERROR: (now - 25 * H) + '|BAD_JSON' }).includes('calslots_record:high'));
  ok('⑤-17 件数の記録が壊れている → high', chk({ LB_CALSLOTS_COUNT: '{x' }).includes('calslots_record:high'));
  ok('⑤-18 始めたまま終わっていない → warn', chk({ LB_CALSLOTS_LAST_START: String(now - 11 * 60000), LB_CALSLOTS_LAST: (now - 20 * 60000) + '|sent|1' }).includes('calslots_unfinished:warn'));
  ok('⑤-19 件数を書けなかった（24時間以内）→ warn', chk({ LB_CALSLOTS_COUNT_LOST: String(now - 1000) }).includes('calslots_lost:warn'));
  ok('⑤-20 日次点検から呼ばれている（配線）', /lbCalSlotsDailyCheck\(Date\.now\(\), function \(k\) \{ return _lbProp\(k\); \}\)/.test(LB));
}

console.log('=== ⑥ 新しいトリガーを作らない ===');
{
  const s = PE.indexOf('// 設計42 カレンダーが変わったら'), e = PE.indexOf('\n// 同期の後に呼ぶ入口');
  const block = PE.slice(s, PE.indexOf('\n}\n', PE.indexOf('function _lbCalSlotsAfter(')));
  ok('⑥-1 設計42の処理は newTrigger を呼ばない', s > 0 && e > s && !/newTrigger/.test(block));
  ok('⑥-2 lbCalSyncTick は引数を取らない（トリガーのイベント引数を受けない）', /\nfunction lbCalSyncTick\(\) \{/.test(PE));
}

console.log(`\n${fail ? '❌' : '✅'} カレンダーの変更で枠をすぐ押し出す（設計42） 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
