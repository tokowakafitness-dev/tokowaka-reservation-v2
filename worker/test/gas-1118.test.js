// GAS の束 2026-11-18（1回の反映にまとめる）
//   実行: node worker/test/gas-1118.test.js
//
//   ① スイッチの切り替え関数（lbEdgeDeferSetOn/Off・lbNotifyDeferSetOn/Off）：On は '1'・Off は消す・前→後と EDGE_PUSH_ON を返す
//   ② 変更（changeReservationLine を本物のまま）の段：preTrainer／preLedger／pre／preType／remain（芯）／remainText に時間が入る
//   ③ 変更はトレーナー名簿を1回だけ読む・権限の判定は今までどおり（担当外のトレーナーは FORBIDDEN）
//   ④ 予約の通知（coreStage なし）は _lbTrainerRemainText の中で印を付けない
//   ⑤ 記録：新しい並び（段19個）と、反映の前の並び（段15個）の両方を読める
//   ★値は架空（個人情報を書かない）
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
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

// ================= ① =================
console.log('=== ① スイッチの切り替え ===');
function sw(props0) {
  const props = Object.assign({}, props0), logs = [], ops = [];
  const ctx = { String, Number, Object, Error, Logger: { log: (m) => logs.push(m) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (k in props ? props[k] : null),
      setProperty: (k, v) => { ops.push('set:' + k); props[k] = String(v); },
      deleteProperty: (k) => { ops.push('del:' + k); delete props[k]; },
    }) } };
  vm.createContext(ctx);
  const oneLine = (n) => { const m = LB.match(new RegExp('\\nfunction ' + n + '\\(\\)[^\\n]*\\}\\n')); if (!m) throw new Error('見つからない: ' + n); return m[0]; };
  vm.runInContext(['lbEdgeDeferSetOn', 'lbEdgeDeferSetOff', 'lbNotifyDeferSetOn', 'lbNotifyDeferSetOff'].map(oneLine).join('') + pluckFn(LB, '_lbDeferSwitch'), ctx);
  return { ctx, props, logs, ops };
}
{
  const a = sw({ EDGE_PUSH_ON: '1' });
  const m1 = a.ctx.lbEdgeDeferSetOn();
  ok('①-1 lbEdgeDeferSetOn：LB_EDGE_DEFER を 1 に・前→後・EDGE_PUSH_ON を返す', a.props.LB_EDGE_DEFER === '1'
     && /LB_EDGE_DEFER: （未設定＝オフ） → '1'／EDGE_PUSH_ON: '1'　✅/.test(m1), m1);
  ok('①-2 Logger にも同じ文', a.logs[a.logs.length - 1] === m1);
  const m2 = a.ctx.lbEdgeDeferSetOff();
  ok('①-3 ★Off は消す（"0" を置かない＝プロパティの数を増やさない）', !('LB_EDGE_DEFER' in a.props) && a.ops.includes('del:LB_EDGE_DEFER')
     && /'1' → （未設定＝オフ）/.test(m2), JSON.stringify({ m2, ops: a.ops }));
  const b = sw({});
  const m3 = b.ctx.lbNotifyDeferSetOn();
  ok('①-4 lbNotifyDeferSetOn：LB_NOTIFY_DEFER だけを変える（LB_EDGE_DEFER に触らない）', b.props.LB_NOTIFY_DEFER === '1' && !('LB_EDGE_DEFER' in b.props)
     && /LB_NOTIFY_DEFER: （未設定＝オフ） → '1'／EDGE_PUSH_ON: （未設定＝オフ）/.test(m3), m3);
  b.ctx.lbNotifyDeferSetOff();
  ok('①-5 lbNotifyDeferSetOff：消す', !('LB_NOTIFY_DEFER' in b.props));
  const c = sw({ EDGE_PUSH_ON: '0' });
  ok('①-6 ★写しの後ろ回しを On にしたのに EDGE_PUSH_ON が 1 でなければ、そう言う', /★EDGE_PUSH_ON が 1 ではない/.test(c.ctx.lbEdgeDeferSetOn()));
  let threw = false; try { c.ctx._lbDeferSwitch('EDGE_PUSH_ON', false); } catch (e) { threw = true; }
  ok('①-7 ほかのプロパティは切り替えられない（元栓を消さない）', threw && c.props.EDGE_PUSH_ON === '0');
  ok('①-8 引数なしで呼べる（エディタから押せる）', ['lbEdgeDeferSetOn', 'lbEdgeDeferSetOff', 'lbNotifyDeferSetOn', 'lbNotifyDeferSetOff'].every((n) => new RegExp('\\nfunction ' + n + '\\(\\)').test(LB)));
}

// ================= ②③④ =================
const STAGES = ['auth', 'pre', 'lock', 'remain', 'calread', 'cal', 'sheet', 'notify', 'edgeQ', 'edgeSend', 'other', 'member', 'edgeMark', 'notifyCalc', 'notifyQ', 'preTrainer', 'preLedger', 'preType', 'remainText'];
const T0 = new Date(2026, 9, 31, 10).getTime();
function world({ actor, assigned = 'T1' } = {}) {
  let nowMs = T0;
  class FD extends Date { constructor(...a) { if (a.length === 0) super(nowMs); else super(...a); } static now() { return nowMs; } }
  const start = new Date(2026, 10, 7, 18);   // 期限前＝無料の変更
  const row = [start, '会員', 'C1', 'Ucust', assigned, '', 'confirmed', '', 'R1', 'line', ''];
  const log = { trByLine: 0, push: [], core: 0, home: 0 };
  const sheet = {
    getLastRow: () => 2, getLastColumn: () => 15,
    getRange: (r, c, nr, nc) => (nr === undefined
      ? { setValue: (v) => { row[c - 1] = v; }, getValue: () => row[c - 1] }
      : { getValues: () => { nowMs += 200; return [row.slice(0, Math.max(nc, 11))]; } }),
  };
  const ctx = {
    Date: FD, Math, String, Number, isNaN, isFinite, JSON, Array, Object, Logger: { log: () => {} },
    LB_HEALTH_BUILD: '2026-11-18a テスト',
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {} }) },
    SETTINGS: { TIMEZONE: 'Asia/Tokyo', SESSION_MINUTES: 60 }, LINE_BOOKING: { RESV_SHEET: 'r' }, MAP_COL: { AUTH_STATE: 8 },
    Utilities: { formatDate: (d) => new Date(d).toISOString().slice(0, 16) },
    getCustomerByLine: () => { nowMs += 50; return null; },
    getTrainerByLine: () => { nowMs += 100; log.trByLine++; return actor; },
    _lbSheet: () => sheet,
    LockService: { getScriptLock: () => ({ waitLock: () => { nowMs += 10; }, releaseLock: () => {}, hasLock: () => true }) },
    SpreadsheetApp: { flush: () => {} },
    _lbParseResvDate: (v) => v,
    _lbTrainerById: () => ({ id: 'T1', name: '担当' }),
    _lbDeleteReservationEvents: () => {},
    _lbFmtResvLabel: () => 'L', _lbMemberLang: () => 'ja', _lbSt: (lang, key) => '[' + key + ']',
    _lbPush: (to, text, kind) => { log.push.push({ to, text, kind }); },
    _lbNotifyDeferFlushRes: () => {},
    getTrainerLineId: () => 'Utr', _lbTrainerNameLang: () => '担当',
    _lbTrainerMaySeeCustomer: () => true, _lbCustOwnerOf: () => 'T1',
    _lbContractTypeOf: () => { nowMs += 300; return '通常'; },
    _lbBuildHome: () => { nowMs += 700; log.home++; return { type: 'ticket', remaining: 3, expire: '' }; },
    _lbReserveCore: () => { log.core++; return { success: true, reservationId: 'R2', calendarEventId: '', trainerEventId: '' }; },
  };
  vm.createContext(ctx);
  vm.runInContext(pluckVar(LB, 'LB_WP') + pluckVar(LB, 'LB_WP_CODES') + 'var _LB_WP = null;\n'
    + ['_lbWpStart', '_lbWpMark', '_lbWpCode', '_lbWpRow', '_lbWpStagesOf', '_lbWpValidRow', '_lbIsOwnerRole', '_lbIsFreeCancelWindow',
       'changeReservationLine', '_lbTrainerRemainText'].map((n) => pluckFn(LB, n)).join('\n'), ctx);
  return { ctx, log, row, adv: (ms) => { nowMs += ms; } };
}
console.log('=== ② 変更の段 ===');
{
  const w = world({ actor: { trainerId: 'T1', role: 'trainer' } });
  w.ctx._lbWpStart('line_changeReservation');
  const r = w.ctx.changeReservationLine('Utrainer', 'R1', new Date(2026, 10, 8, 18).toISOString());
  const ms = w.ctx._LB_WP.ms;
  ok('②-0 変更は成功する', r.success === true && w.log.core === 1, JSON.stringify(r));
  ok('②-1 ★トレーナー名簿の読み → preTrainer（100ms）', ms.preTrainer === 100, JSON.stringify(ms));
  ok('②-2 ★台帳の読み → preLedger（200ms）', ms.preLedger === 200, JSON.stringify(ms));
  ok('②-3 ★契約種別 → preType（300ms）・pre は認可直前の名簿の読み直し（100ms）だけ', ms.preType === 300 && ms.pre === 100, JSON.stringify(ms));
  ok('②-4 ★残数の芯（_lbBuildHome）→ remain（700ms）・文を組む残り → remainText', ms.remain === 700 && 'remainText' in ms && ms.remainText === 0 && w.log.home === 1, JSON.stringify(ms));
  ok('②-5 会員名簿 → member（50ms）・ロック → lock（10ms）', ms.member === 50 && ms.lock === 10, JSON.stringify(ms));
  ok('②-6 トレーナー宛の文の中身は今までどおり', w.log.push.some((p) => p.kind === 'change_trainer' && /【顧客の残り】\n(11月分　)?チケット：残3枚/.test(p.text)), JSON.stringify(w.log.push));
  const row = w.ctx._lbWpRow(w.ctx._LB_WP, r, null, Date.now());
  ok('②-7 行は段19個の並び・形の検査を通る', row.length === 6 + STAGES.length + 1 && w.ctx._lbWpValidRow(row) === true && row[6 + STAGES.indexOf('preType')] === 300, JSON.stringify(row));
}
console.log('=== ③ トレーナー名簿は認可の直前に読み直す ===');
{
  const w = world({ actor: { trainerId: 'T1', role: 'trainer' } });
  w.ctx.changeReservationLine('Utrainer', 'R1', new Date(2026, 10, 8, 18).toISOString());
  ok('③-1 ★getTrainerByLine は認可の直前にも読み直す（2回）', w.log.trByLine === 2, String(w.log.trByLine));
  const x = world({ actor: { trainerId: 'T9', role: 'trainer' } });
  const rx = x.ctx.changeReservationLine('Uother', 'R1', new Date(2026, 10, 8, 18).toISOString());
  ok('③-2 担当外のトレーナーは今までどおり FORBIDDEN・予約の本体へ行かない', rx.code === 'FORBIDDEN' && x.log.core === 0 && x.log.trByLine === 2, JSON.stringify(rx));
  const o = world({ actor: { trainerId: 'T0', role: 'owner' } });
  ok('③-3 オーナーは担当外でも変更できる（今までどおり）', o.ctx.changeReservationLine('Uowner', 'R1', new Date(2026, 10, 8, 18).toISOString()).success === true && o.log.trByLine === 2);
  const m = world({ actor: null });
  ok('③-4 会員（未登録・トレーナーでない）は NOT_VERIFIED（今までどおり）', m.ctx.changeReservationLine('Ucust', 'R1', new Date(2026, 10, 8, 18).toISOString()).code === 'NOT_VERIFIED');
  ok('③-5 ★コード上も getTrainerByLine の呼び出しは2か所（認可の直前で読み直す）', (pluckFn(LB, 'changeReservationLine').match(/getTrainerByLine\(/g) || []).length === 2);
}
console.log('=== ④ 予約の通知は印を付けない ===');
{
  const w = world({ actor: null });
  w.ctx._lbWpStart('line_makeReservationLine');
  w.ctx._lbTrainerRemainText('C1', '会員', new Date(2026, 10, 8, 18));
  ok('④-1 coreStage なしなら段の印を付けない（呼び出し側の notifyCalc に全部入る）', Object.keys(w.ctx._LB_WP.ms).length === 0, JSON.stringify(w.ctx._LB_WP.ms));
  const w2 = world({ actor: null });
  w2.ctx._lbBuildHome = () => { w2.adv(500); throw new Error('x'); };
  w2.ctx._lbWpStart('line_changeReservation');
  const txt = w2.ctx._lbTrainerRemainText('C1', '会員', new Date(2026, 10, 8, 18), 'remain');
  ok('④-2 芯が例外でも remain に数え、文は空（今までどおり握りつぶす）', txt === '' && w2.ctx._LB_WP.ms.remain === 500, JSON.stringify(w2.ctx._LB_WP.ms));
  ok('④-3 予約の通知（_lbNotifyReservation）は coreStage を渡さない', /_lbTrainerRemainText\(customerId, customerName, start\);/.test(pluckFn(LB, '_lbNotifyReservation')));
}
console.log('=== ⑤ 記録の並び ===');
{
  const w = world({});
  const old15 = [1795000000000, 'changeReservation', 1, 'OK', '2026-11-16b', 'notify'].concat(Array(15).fill(0)).concat([10]);
  const new19 = [1795000000000, 'changeReservation', 1, 'OK', '2026-11-18a', 'remainText'].concat(Array(19).fill(0)).concat([10]);
  ok('⑤-1 反映の前の行（段15個）を読める', w.ctx._lbWpValidRow(old15) === true && w.ctx._lbWpStagesOf(old15).length === 15);
  ok('⑤-2 新しい行（段19個・最後の印 remainText）を読める', w.ctx._lbWpValidRow(new19) === true && w.ctx._lbWpStagesOf(new19).length === 19);
  ok('⑤-3 古い並びの位置を動かしていない（新しい段は後ろ）', JSON.stringify(w.ctx.LB_WP.STAGES.slice(0, 15)) === JSON.stringify(w.ctx.LB_WP.STAGES_V3) && JSON.stringify(w.ctx.LB_WP.STAGES) === JSON.stringify(STAGES));
}

console.log(`\n${fail ? '❌' : '✅'} gas-1118: ${pass} 通過 / ${fail} 失敗`);
process.exit(fail ? 1 : 0);
