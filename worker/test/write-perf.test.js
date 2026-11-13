// 設計43 A：書き込み（予約・取消・変更）の段ごとの所要時間を、個人情報なしで残す（2026-11-13）
//   実行: node worker/test/write-perf.test.js
//
//   ① 入口から：handleLineGet → 記録器 → 段の印 → Script Properties のリング（本物の handleLineGet を走らせる）
//   ② 対象外の操作は記録しない／認証の失敗も1件／例外は記録してから同じ例外を投げ直す（認証の例外も）
//   ③ コードは許可リストに完全一致だけ（予約IDの形・例外の文を持たない）・行の形（数と固定の文字だけ）
//   ④ リングの上限（60件・8,000バイト）・壊れた記録は印を立てて作り直す・記録の失敗で結果を変えない
//   ⑤ 印を置く場所（取消・変更・予約の芯・edgeAfterWrite）と順序
//   ⑥ 作業依頼 remaining {writePerf} の窓口（新しい op を足さない）
//   ★値は架空（個人情報を書かない）
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LB = readFileSync(join(ROOT, 'gas/LineBooking.js'), 'utf8');
const PE = readFileSync(join(ROOT, 'gas/PushToEdge.js'), 'utf8');
const EJ = readFileSync(join(ROOT, 'gas/EdgeJob.js'), 'utf8');
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

function make(opt = {}) {
  let nowMs = 1795000000000;
  const props = Object.assign({}, opt.props || {});
  class FD extends Date { constructor(...a) { if (a.length === 0) super(nowMs); else super(...a); } static now() { return nowMs; } }
  const calls = [];
  const ctx = {
    String, Number, JSON, Math, Object, isFinite, Date: FD,
    Logger: { log: () => {} },
    LB_HEALTH_BUILD: '2026-11-13c テスト',
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => { if (opt.propsThrow) throw new Error('p'); return (k in props ? props[k] : null); },
      setProperty: (k, v) => { if (opt.setThrow) throw new Error('s'); props[k] = String(v); },
    }) },
    Utilities: { formatDate: (d) => new Date(d.getTime() + 9 * 3600000).toISOString().slice(5, 19).replace('T', ' ') },
    verifyLineIdToken: () => { nowMs += 300; if (opt.authThrow) throw new Error('auth boom U' + '0'.repeat(32)); return opt.authNg ? { ok: false } : { ok: true, lineUserId: 'U' + '0'.repeat(32) }; },
    _lbDispatch: (params, action) => {
      calls.push(action);
      // 取消の段の形をなぞる（pre 200 → lock 1500 → sheet 100 → cal 900 → sheet 400 → notify 700）
      nowMs += 200; ctx._lbWpMark('pre');
      nowMs += 1500; ctx._lbWpMark('lock');
      nowMs += 100; ctx._lbWpMark('sheet');
      nowMs += 900; ctx._lbWpMark('cal');
      nowMs += 400; ctx._lbWpMark('sheet');
      nowMs += 700; ctx._lbWpMark('notify');
      if (opt.dispatchThrow) throw new Error('boom 090-0000-0000');
      return opt.res || { success: true, customerId: 'C0001' };
    },
    edgeAfterWrite: () => {
      nowMs += 50; ctx._lbWpMark('edgeQ');
      nowMs += 1200; ctx._lbWpMark('edgeSend');
      if (opt.edgeThrow) throw new Error('edge');
    },
  };
  vm.createContext(ctx);
  vm.runInContext(pluckVar(LB, 'LB_WP') + pluckVar(LB, 'LB_WP_CODES') + 'var _LB_WP = null;\n'
    + ['handleLineGet', '_lbWpStart', '_lbWpMark', '_lbWpCode', '_lbWpRow', '_lbWpValidRow', '_lbWpFinish', 'writePerfText'].map((n) => pluckFn(LB, n)).join('\n'), ctx);
  return { ctx, props, calls, adv: (ms) => { nowMs += ms; } };
}
const ring = (props) => JSON.parse(props.LB_WRITE_PERF || '{"items":[]}');
const STAGES = ['auth', 'pre', 'lock', 'remain', 'calread', 'cal', 'sheet', 'notify', 'edgeQ', 'edgeSend', 'other'];
const idx = (s) => 6 + STAGES.indexOf(s);

console.log('=== ① 入口から ===');
{
  const t = make();
  const res = t.ctx.handleLineGet({ action: 'line_cancelReservation', idToken: 'x', reservationId: 'R-SECRET-1' });
  const r = ring(t.props);
  const row = r.items[0];
  ok('①-1 ★取消を1回通すと1件残る', r.items.length === 1 && res.success === true, JSON.stringify(r));
  ok('①-2 操作名・成否・コード・版・最後の印', row[1] === 'cancelReservation' && row[2] === 1 && row[3] === 'OK' && row[4] === '2026-11-13c' && row[5] === 'edgeSend', JSON.stringify(row));
  ok('①-3 ★段の時間（auth 300・lock 1500・sheet 100+400・cal 900・notify 700・edgeQ 50・edgeSend 1200）',
     row[idx('auth')] === 300 && row[idx('pre')] === 200 && row[idx('lock')] === 1500 && row[idx('sheet')] === 500 && row[idx('cal')] === 900
     && row[idx('notify')] === 700 && row[idx('edgeQ')] === 50 && row[idx('edgeSend')] === 1200, JSON.stringify(row));
  ok('①-4 合計＝段の和', row[row.length - 1] === 5350 && row.slice(6, 6 + STAGES.length).reduce((a, b) => a + b, 0) === 5350, JSON.stringify(row));
  ok('①-5 段の名前の並びを記録に持つ', JSON.stringify(r.stages) === JSON.stringify(STAGES));
  ok('①-6 ★予約ID・LINE ID は記録に入らない', !/R-SECRET|U0000/.test(t.props.LB_WRITE_PERF));
  t.ctx.handleLineGet({ action: 'line_changeReservation', idToken: 'x' });
  ok('①-7 新しい回が先頭', ring(t.props).items.length === 2 && ring(t.props).items[0][1] === 'changeReservation');
}

console.log('=== ② 対象外・失敗・例外 ===');
{
  const t = make();
  t.ctx.handleLineGet({ action: 'line_getMyReservations', idToken: 'x' });
  ok('②-1 読み取りは記録しない', !t.props.LB_WRITE_PERF && t.calls.length === 1);
  const a = make({ authNg: true });
  const ra = a.ctx.handleLineGet({ action: 'line_cancelReservation', idToken: 'x' });
  ok('②-2 認証の失敗も1件（UNAUTHORIZED）・振り分けない', ra.code === 'UNAUTHORIZED' && (ring(a.props).items[0] || [])[3] === 'UNAUTHORIZED' && (ring(a.props).items[0] || [])[2] === 0 && a.calls.length === 0);
  const d = make({ dispatchThrow: true });
  let thrown = null;
  try { d.ctx.handleLineGet({ action: 'line_makeReservationLine', idToken: 'x' }); } catch (e) { thrown = e; }
  ok('②-3 ★振り分けの例外は同じ例外を投げ直す', thrown && /boom/.test(thrown.message));
  ok('②-4 ★その回も THROW で記録・例外の文（電話の形）は持たない', (ring(d.props).items[0] || [])[3] === 'THROW' && !/090|boom/.test(d.props.LB_WRITE_PERF), d.props.LB_WRITE_PERF);
  const au = make({ authThrow: true });
  let th2 = null;
  try { au.ctx.handleLineGet({ action: 'line_cancelReservation', idToken: 'x' }); } catch (e) { th2 = e; }
  ok('②-5 ★認証の例外も記録してから投げ直す（関門① 2周目）', th2 && (ring(au.props).items[0] || [])[3] === 'THROW' && (ring(au.props).items[0] || [])[5] === 'start');
  const e = make({ edgeThrow: true });
  const re = e.ctx.handleLineGet({ action: 'line_cancelReservation', idToken: 'x' });
  ok('②-6 edgeAfterWrite の例外は外へ出さない（今と同じ）・記録は残る', re.success === true && ring(e.props).items.length === 1);
}

console.log('=== ③ コードの許可リスト ===');
{
  const t = make();
  ok('③-1 既知のコード', t.ctx._lbWpCode({ success: false, code: 'SLOT_TAKEN' }) === 'SLOT_TAKEN');
  ok('③-2 ★予約IDの形・知らない大文字は OTHER', ['R20261113ABC', 'C20260101000001', 'ABC', 'slot_taken', ''].every((c) => t.ctx._lbWpCode({ success: false, code: c }) === 'OTHER'));
  ok('③-3 文字列でない code は OTHER', t.ctx._lbWpCode({ success: false, code: { x: 1 } }) === 'OTHER');
  ok('③-4 成功は OK・例外は THROW', t.ctx._lbWpCode({ success: true, code: 'X' }) === 'OK' && t.ctx._lbWpCode(null, new Error('x')) === 'THROW');
  //   取消・変更・予約の芯・ゲートの return 文のコードが許可リストに全部ある（足し忘れたら OTHER に寄って原因が読めなくなる）
  const body = ['cancelReservationLine', 'changeReservationLine', '_lbReserveCoreImpl', 'makeReservationLine', '_lbBookingGate', '_lbHorizonGate'].map((n) => pluckFn(LB, n)).join('\n');
  const codes = [...new Set([...body.matchAll(/code: *'([A-Z_]+)'/g)].map((m) => m[1]))];
  const missing = codes.filter((c) => !t.ctx.LB_WP_CODES[c]);
  ok('③-5 ★取消・変更・予約の芯・ゲートが返すコードが全部許可リストにある', codes.length > 10 && missing.length === 0, missing.join(','));
  const g = make({ res: { success: false, code: 'R20261113ABC', message: '会員 見本様' } });
  g.ctx.handleLineGet({ action: 'line_cancelReservation', idToken: 'x' });
  const row = ring(g.props).items[0];
  ok('③-6 ★行は数と固定の文字だけ（応答の message・知らないコードを持たない）', row[3] === 'OTHER' && !/見本|R2026/.test(g.props.LB_WRITE_PERF)
     && row.every((v, i) => (i === 1 || i === 3 || i === 4 || i === 5) ? typeof v === 'string' : typeof v === 'number'), JSON.stringify(row));
}

console.log('=== ④ リングの上限・壊れた記録・記録の失敗 ===');
{
  const t = make();
  for (let i = 0; i < 75; i++) t.ctx.handleLineGet({ action: 'line_makeReservationLine', idToken: 'x' });
  const r = ring(t.props);
  ok('④-1 60件まで', r.items.length === 60, r.items.length);
  ok('④-2 8,000バイト以内', t.props.LB_WRITE_PERF.length <= 8000, t.props.LB_WRITE_PERF.length);
  const b = make({ props: { LB_WRITE_PERF: '{壊れ' } });
  b.ctx.handleLineGet({ action: 'line_cancelReservation', idToken: 'x' });
  ok('④-3 壊れた記録は印（時刻だけ）を立てて作り直す', /^\d+$/.test(b.props.LB_WRITE_PERF_BAD || '') && ring(b.props).items.length === 1);
  const s = make({ setThrow: true });
  const rs = s.ctx.handleLineGet({ action: 'line_cancelReservation', idToken: 'x' });
  ok('④-4 ★記録が書けなくても結果は変えない', rs.success === true);
  const p = make({ propsThrow: true });
  ok('④-5 読めなくても結果は変えない', p.ctx.handleLineGet({ action: 'line_cancelReservation', idToken: 'x' }).success === true);
  //   ★JSON としては読めるが中身が外れた記録（手で直した・古い版）：書き戻さず作り直す（関門② 中3）
  const goodRow = [1795000000000, 'cancelReservation', 1, 'OK', '2026-11-13c', 'edgeSend', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10];
  const badRows = [
    ['op が9つの外', Object.assign([...goodRow], { 1: 'テスト 太郎' })],
    ['コードが許可リストの外', Object.assign([...goodRow], { 3: 'R20261113ABC' })],
    ['版の形が外れ', Object.assign([...goodRow], { 4: '090-0000-0000' })],
    ['最後の印が段の外', Object.assign([...goodRow], { 5: 'U' + '0'.repeat(32) })],
    ['時間が負', Object.assign([...goodRow], { 8: -1 })],
    ['時間が文字', Object.assign([...goodRow], { 8: '1' })],
    ['長さが違う', goodRow.slice(0, 10)],
  ];
  for (const [label, row] of badRows) {
    const x = make({ props: { LB_WRITE_PERF: JSON.stringify({ v: 1, stages: ['任意の文字'], items: [goodRow, row] }) } });
    ok('④-7 ' + label + '：形の外れた行を読み出しに出さない', !/テスト|R2026|090-|U0000|任意の文字/.test(x.ctx.writePerfText()) && /形の外れた行 1 件/.test(x.ctx.writePerfText()), x.ctx.writePerfText());
    x.ctx.handleLineGet({ action: 'line_cancelReservation', idToken: 'x' });
    ok('④-8 ' + label + '：書くときは印を立てて作り直す（外れた行を書き戻さない）', /^\d+$/.test(x.props.LB_WRITE_PERF_BAD || '') && ring(x.props).items.length === 1 && JSON.stringify(ring(x.props).stages) === JSON.stringify(STAGES));
  }
  ok('④-9 正しい行は形の検査を通る', make().ctx._lbWpValidRow(goodRow) === true);
  const n = make();
  n.ctx._lbWpMark('lock');
  ok('④-6 記録器が無いときの印は何もしない（裏の処理から呼ばれても無害）', !n.props.LB_WRITE_PERF && n.ctx._LB_WP === null);
}

console.log('=== ⑤ 印を置く場所 ===');
{
  const cx = pluckFn(LB, 'cancelReservationLine');
  ok('⑤-1 ★取消：pre → waitLock → lock の順', /_lbWpMark\('pre'\);\s*var lock = LockService\.getScriptLock\(\);\s*lock\.waitLock\(10000\);\s*_lbWpMark\('lock'\);/.test(cx));
  ok('⑤-2 取消：カレンダーの後に cal・ロックを離した後に sheet・通知の後に notify',
     /_lbConsumeReservationEvents\(customerName, trainer, start\);\s*_lbWpMark\('cal'\);/.test(cx) && /lock\.releaseLock\(\);\s*_lbWpMark\('sheet'\);/.test(cx) && /_lbCxlAfter\(done, _cxT0\);[^\n]*\n\s*_lbWpMark\('notify'\);/.test(cx));
  const ch = pluckFn(LB, 'changeReservationLine');
  ok('⑤-3 ★変更：pre → waitLock → lock の順', /_lbWpMark\('pre'\);\s*var lock = LockService\.getScriptLock\(\);\s*lock\.waitLock\(10000\);\s*_lbWpMark\('lock'\);/.test(ch));
  ok('⑤-4 ★変更：トレーナー宛の残数の文は trId があるときだけ作る（以前と同じ評価の条件）・remain に数える',
     /if \(trId\) \{\s*\/\/[^\n]*\n\s*var _chRemainText = _lbTrainerRemainText\(String\(r\[2\]\), customerName, _newStart\);\s*_lbWpMark\('remain'\);/.test(ch) && !/\+ _lbTrainerRemainText\(/.test(ch));
  const co = pluckFn(LB, '_lbReserveCoreImpl');
  ok('⑤-5 予約の芯：ロックの前後に pre・lock', /_lbWpMark\('pre'\);\s*var lock = LockService\.getScriptLock\(\);\s*var _lbOwnedLock = false;\s*if \(!lock\.hasLock\(\)\) \{ lock\.waitLock\(10000\); _lbOwnedLock = true; \}\s*_lbWpMark\('lock'\);/.test(co));
  const laps = [...co.matchAll(/_lap\('([^']+)'\)/g)].map((m) => m[1]);
  const table = (co.match(/var _LAP_STAGE = \{([\s\S]*?)\};/) || [])[1] || '';
  ok('⑤-6 ★既存の _lap の名前が全部、段の表にある（無ければ other に寄る）', laps.length >= 7 && laps.every((n) => table.includes("'" + n + "'")), laps.join(','));
  ok('⑤-7 _lap が印を付ける', /function _lap\(n\)\{[^}]*_lbWpMark\(_LAP_STAGE\[n\] \|\| 'other'\);/.test(co));
  const ew = pluckFn(PE, 'edgeAfterWrite');
  ok('⑤-8 edgeAfterWrite：積んだ後に edgeQ・送った後に edgeSend（関数が無くても落ちない）',
     /lbDwEnqueue\(cid\);[^\n]*\n\s*if \(typeof _lbWpMark === 'function'\) _lbWpMark\('edgeQ'\);/.test(ew) && /_sent\.reservations;[^\n]*\n\s*if \(typeof _lbWpMark === 'function'\) _lbWpMark\('edgeSend'\);/.test(ew));
  const br = pluckFn(LB, '_lbBatchReserve');
  ok('⑤-10 ★まとめて予約：ロック待ちを lock に数える（芯の中ではもう持っている・関門② 低1）',
     /_lbWpMark\('pre'\);[^\n]*\n\s*var lock = LockService\.getScriptLock\(\);\s*if \(!lock\.tryLock\(20000\)\) \{ _lbWpMark\('lock'\); return/.test(br) && /\}\s*_lbWpMark\('lock'\);\s*var _ci = \{\};/.test(br));
  ok('⑤-9 計測の操作は書き込みの許可された集合（EDGE_SLOTS_ONLY_LAG と同じ9つ）',
     JSON.stringify(Object.keys(make().ctx.LB_WP.OPS).sort()) === JSON.stringify((PE.match(/var EDGE_SLOTS_ONLY_LAG = \{([\s\S]*?)\};/)[1].match(/line_\w+/g)).sort()));
}

console.log('=== ⑥ 作業依頼の窓口 ===');
{
  ok('⑥-1 remaining の args.writePerf → writePerfText（_ejScrub を通す）', /if \(args && args\.writePerf\) return _ejScrub\(writePerfText\(\)\);/.test(EJ));
  ok('⑥-2 新しい op を足していない（case は remaining の中）', !/case 'writePerf'/.test(EJ));
  const t = make();
  ok('⑥-3 記録が無ければ「まだありません」（0件と言わない）', /まだ記録がありません/.test(t.ctx.writePerfText()));
  for (let i = 0; i < 3; i++) t.ctx.handleLineGet({ action: 'line_cancelReservation', idToken: 'x' });
  const txt = t.ctx.writePerfText();
  ok('⑥-4 ★操作ごとの件数と段の分布・直近の行', /■ cancelReservation：3件（成功 3）/.test(txt) && /lock：中央 1500ms/.test(txt) && /total：中央 5350ms/.test(txt) && /直近10件/.test(txt), txt);
  const b = make({ props: { LB_WRITE_PERF: '{x' } });
  ok('⑥-5 壊れていれば読めないと言う', /読めません/.test(b.ctx.writePerfText()));
}

console.log(`\n${pass} 通過 / ${fail} 失敗`);
if (fail) process.exit(1);
