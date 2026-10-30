// 間違えた当日キャンセルを、オーナーが無料キャンセルに直す（設計24）。入口から通して3か所が正しく戻るかを確かめる。
//   実行: node worker/test/undo-same-day-cancel.test.js
//
// ★なぜ要るのか（2026-10-30）
//   間違えて当日キャンセルした予約を手で戻したら、3か所（台帳・振替権・B1の[消化]）を直す必要があり、
//   さらに D1 の計算入力に旧行が残った（差分の送り直しは外れた行を消さない）。オーナーの1操作で正しく戻す。
//
//   ① 成功：台帳 consumed→cancelled・振替権は期限切れに（行は残す）・ID一致の [消化] だけ消す・customerId を返す
//   ② 止める：オーナー以外／2回目／普通の消化／振替権が使用済み／別の会員の振替権／先月／締めた月／重複
//   ③ カレンダー：IDが空なら時刻と名前で1件だけ／候補が2件なら消さない
//   ④ 無効にした振替権は、どの読み手からも「使えない」
//   ⑤ 一覧：オーナーのみ・対象の行だけ・顧客IDを返さない
//   ⑥ 配線：振り分け・D1の後始末の一覧・LIFF の書き込み扱い・ボタンはオーナーだけ
process.env.TZ = 'Asia/Tokyo';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LB = readFileSync(join(ROOT, 'gas/LineBooking.js'), 'utf8');
const PE = readFileSync(join(ROOT, 'gas/PushToEdge.js'), 'utf8');
const HTML = readFileSync(join(ROOT, 'liff/index.html'), 'utf8');
const R = require('../../gas/BookingRules.js');

let pass = 0, fail = 0;
function ok(name, cond, why) { if (cond) pass++; else { fail++; console.log(`❌ ${name}`); if (why) console.log(`   ${why}`); } }
function pluckFn(src, name) {
  const m = src.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('見つからない: ' + name);
  return m[0];
}
const VARS = LB.match(/var LB_SDC_TAG = [^\n]*\n/)[0] + LB.match(/var LB_SDC_MSG = \{[\s\S]*?\n\};/)[0];

const NOW = new Date(2026, 9, 30, 14, 30).getTime();   // 2026-10-30 14:30 JST
const pad = (n) => String(n).padStart(2, '0');
const Utilities = { formatDate: (d, tz, f) => {
  const y = d.getFullYear(), M = pad(d.getMonth() + 1), D = pad(d.getDate()), h = pad(d.getHours()), mi = pad(d.getMinutes());
  return f.replace('yyyy', y).replace('MM', M).replace('dd', D).replace('HH', h).replace('mm', mi);
} };

// 身代わりのシート（1行目はヘッダー）
function sheet(rows, failSetValues) {
  const data = rows.map((r) => r.slice());
  let writes = 0;
  return {
    data, writes: () => writes,
    getLastRow: () => data.length,
    getRange: (r, c, nr = 1, nc = 1) => ({
      getValues: () => data.slice(r - 1, r - 1 + nr).map((row) => { const o = []; for (let k = 0; k < nc; k++) o.push(row[c - 1 + k] === undefined ? '' : row[c - 1 + k]); return o; }),
      setValues: (vals) => { if (failSetValues && failSetValues()) throw new Error('書き込み失敗（身代わり）'); writes++; vals.forEach((vr, i) => vr.forEach((x, k) => { data[r - 1 + i][c - 1 + k] = x; })); },
      setValue: (x) => { writes++; data[r - 1][c - 1] = x; },
    }),
  };
}
// 身代わりのカレンダー
function calendar(events) {
  const evs = events.map((e) => ({ ...e, deleted: false }));
  const wrap = (e) => ({ getTitle: () => e.title, getStartTime: () => new Date(e.start), deleteEvent: () => { e.deleted = true; } });
  return { evs, api: {
    getEventById: (id) => { const e = evs.find((x) => x.id === id && !x.deleted); return e ? wrap(e) : null; },
    getEvents: (s, en) => evs.filter((x) => !x.deleted && x.start >= s.getTime() && x.start < en.getTime()).map(wrap),
  } };
}
const HEAD = ['予約日時', '顧客名', 'customer_id', 'line_user_id', 'trainer_id', 'トレーナー名', 'status', 'payment_flag', '備考', 'channel', '記録日時', '', 'calendar_event_id'];
const resv = (o) => [o.at || '2026/10/30 16:00', o.name || '山田太郎', o.cid || 'C0001', 'U1', 'T2', '沖 孟', o.status || 'consumed', o.pay || 'P', o.note, 'line', '2026/10/01 10:00', '', o.ev === undefined ? 'EV1' : o.ev];
const credit = (o) => [o.cid || 'C0001', '2026/10/30 12:17', o.exp || '2026/11/05 23:59', o.used || '', o.src];
const T1600 = new Date(2026, 9, 30, 16, 0).getTime();

function env(o) {
  const R1 = sheet([HEAD, ...(o.resv || [])], o.failLedger ? () => true : null);
  let tcCalls = 0;
  const TC = sheet([['customer_id', 'granted_at', 'expires_at', 'used_at', 'source_reservation_id'], ...(o.credits || [])], o.failCreditAt ? () => (++tcCalls === o.failCreditAt) : null);
  const cal = calendar(o.events || []);
  let locked = 0;
  const ctx = {
    JSON, Math, Number, String, Array, isNaN, Object,
    Date: class extends Date { constructor(...a) { if (a.length === 0) super(NOW); else super(...a); } static now() { return NOW; } },
    Logger: { log: () => {} }, Utilities,
    SETTINGS: { TIMEZONE: 'Asia/Tokyo', SESSION_MINUTES: 60 },
    LINE_BOOKING: { RESV_SHEET: 'line_reservations' }, LB_TCREDIT_SHEET: 'transfer_credits',
    CALENDAR_IDS: { CAPACITY_B1: 'b1' },
    _lbSheet: (n) => (n === 'line_reservations' ? R1 : n === 'transfer_credits' ? TC : null),
    getTrainerByLine: () => (o.owner === false ? { role: 'trainer' } : { role: 'owner' }),
    LockService: { getScriptLock: () => ({ waitLock: () => { locked++; }, releaseLock: () => {} }) },
    CalendarApp: { getCalendarById: () => cal.api },
    _lbAllocSheet: () => ({}), _lbFindClosedManifest: (sh, mk) => ((o.closed || []).includes(mk) ? { row: 2 } : null),
    _lbFmtResvLabel: (s) => String(s),
    _lbCustOwnerOf: (cid) => (o.inMap === false ? null : 'T2'),
  };
  vm.createContext(ctx);
  const names = ['_lbIsOwnerRole', '_lbTrainerMaySeeCustomer', '_lbParseResvDate', '_lbResIdOfNote', '_lbSdcVerdict', '_lbSdcCreditRows', '_lbSdcDeleteConsumedEvent',
    'listSameDayCancels', 'undoSameDayCancel', '_lbUseTransferCredit'];
  vm.runInContext(VARS + '\n' + LB.match(/function _lbNormName\(s\) \{[^\n]*\}/)[0] + '\n' + names.map((n) => (n === '_lbIsOwnerRole' ? LB.match(/function _lbIsOwnerRole\(tr\) \{[^\n]*\}/)[0] : pluckFn(LB, n))).join('\n'), ctx);
  return { ctx, R1, TC, cal };
}
const ID = 'L20261030160000_B_dffc016d';
const SDC = ID + '|当日消化取消';

console.log('=== ① 成功 ===');
{
  const e = env({
    resv: [resv({ note: 'Lother|無料取消', status: 'cancelled', ev: 'EV0' }), resv({ note: SDC })],
    credits: [credit({ src: ID })],
    events: [{ id: 'EV1', title: '[消化] 通常_沖_山田太郎', start: T1600 }, { id: 'EV9', title: '[消化] 通常_鈴木_山田花子', start: T1600 }],
  });
  const r = e.ctx.undoSameDayCancel('U_owner', ID);
  ok('①-1 成功', r.success === true, JSON.stringify(r));
  const row = e.R1.data[2];
  ok('①-2 ★台帳 consumed→cancelled', row[6] === 'cancelled', row[6]);
  ok('①-3 備考に訂正の記録（元の予約IDで始まる）', /^L20261030160000_B_dffc016d\|当日消化取消→無料取消（オーナー訂正 2026\/10\/30 14:30）$/.test(row[8]), row[8]);
  ok('①-4 payment_flag はそのまま', row[7] === 'P');
  ok('①-5 他の行は触らない', e.R1.data[1][6] === 'cancelled' && e.R1.data[1][8] === 'Lother|無料取消');
  const cr = e.TC.data[1];
  ok('①-6 ★振替権の行は残る（消さない）', e.TC.data.length === 2 && cr[4] === ID);
  ok('①-7 ★振替権の期限が過去に', cr[2] === '2026/10/30 14:29', cr[2]);
  ok('①-8 6列目に履歴（元の期限）', /^無効化 2026\/10\/30 14:30（オーナー訂正・元の期限 2026\/11\/05 23:59）$/.test(cr[5]), cr[5]);
  ok('①-9 ★ID一致の [消化] を消す', e.cal.evs[0].deleted === true);
  ok('①-10 ★同じ時刻の別の顧客の [消化] は消さない', e.cal.evs[1].deleted === false);
  ok('①-11 ★customerId を返す（D1の後始末に必須）', r.customerId === 'C0001' && r.calendarDeleted === 1 && r.creditsRevoked === 1);

  console.log('=== ② 止める ===');
  const w0 = e.R1.writes(), t0 = e.TC.writes();
  const r2 = e.ctx.undoSameDayCancel('U_owner', ID);
  ok('②-1 ★2回目は ALREADY・何も書かない', r2.code === 'ALREADY' && e.R1.writes() === w0 && e.TC.writes() === t0, JSON.stringify(r2));
}
{
  const e = env({ owner: false, resv: [resv({ note: SDC })], credits: [credit({ src: ID })] });
  const r = e.ctx.undoSameDayCancel('U_tr', ID);
  ok('②-2 ★オーナー以外は FORBIDDEN・何も書かない', r.code === 'FORBIDDEN' && e.R1.writes() === 0 && e.TC.writes() === 0);
}
for (const [label, note, status] of [['普通に消化した行', ID, 'consumed'], ['当日消化変更', ID + '|当日消化変更', 'consumed'], ['確定のまま', ID, 'confirmed'], ['無料取消', ID + '|無料取消', 'cancelled']]) {
  const e = env({ resv: [resv({ note, status })] });
  const r = e.ctx.undoSameDayCancel('U_owner', ID);
  ok('②-3 ' + label + 'は STATE_MISMATCH', r.code === 'STATE_MISMATCH' && e.R1.writes() === 0, JSON.stringify(r));
}
{
  const e = env({ resv: [resv({ note: SDC })], credits: [credit({ src: ID, used: '2026/10/31 10:00' })] });
  const r = e.ctx.undoSameDayCancel('U_owner', ID);
  ok('②-4 ★振替権が使用済みなら TRANSFER_USED・台帳も触らない', r.code === 'TRANSFER_USED' && e.R1.writes() === 0 && e.TC.writes() === 0);
}
{
  const e = env({ resv: [resv({ note: SDC })], credits: [credit({ src: ID, cid: 'C9999' })] });
  const r = e.ctx.undoSameDayCancel('U_owner', ID);
  ok('②-5 ★同じIDで別の会員の振替権があれば CREDIT_MISMATCH', r.code === 'CREDIT_MISMATCH' && e.R1.writes() === 0 && e.TC.writes() === 0);
}
{
  const e = env({ resv: [resv({ note: SDC, at: '2026/09/30 16:00' })] });
  ok('②-6 ★先月は PAST_MONTH', e.ctx.undoSameDayCancel('U_owner', ID).code === 'PAST_MONTH' && e.R1.writes() === 0);
  const e2 = env({ resv: [resv({ note: SDC })], closed: ['2026-10'] });
  ok('②-7 ★締めた月は CLOSED_MONTH', e2.ctx.undoSameDayCancel('U_owner', ID).code === 'CLOSED_MONTH' && e2.R1.writes() === 0);
  const e3 = env({ resv: [resv({ note: SDC }), resv({ note: ID + '|無料取消', status: 'cancelled' })] });
  ok('②-8 ★同じ予約IDの行が2つなら AMBIGUOUS', e3.ctx.undoSameDayCancel('U_owner', ID).code === 'AMBIGUOUS' && e3.R1.writes() === 0);
  const e4 = env({ resv: [resv({ note: SDC })] });
  ok('②-9 存在しないIDは NOT_FOUND', e4.ctx.undoSameDayCancel('U_owner', 'Lnone').code === 'NOT_FOUND');
  ok('②-10 | を含むIDは BAD_REQUEST', e4.ctx.undoSameDayCancel('U_owner', SDC).code === 'BAD_REQUEST' && e4.R1.writes() === 0);
  const e5 = env({ inMap: false, resv: [resv({ note: SDC })] });
  ok('②-11 ★顧客が名簿に見つからない（判定できない）なら FORBIDDEN・何も書かない', e5.ctx.undoSameDayCancel('U_owner', ID).code === 'FORBIDDEN' && e5.R1.writes() === 0);
}

console.log('=== ③ カレンダー ===');
{
  const e = env({ resv: [resv({ note: SDC, ev: '' })], events: [{ id: 'X', title: '[消化] 通常_沖_山田太郎', start: T1600 }, { id: 'Y', title: '[RESERVED] 通常_沖_佐藤', start: T1600 }] });
  const r = e.ctx.undoSameDayCancel('U_owner', ID);
  ok('③-1 IDが空なら時刻と名前で1件だけ消す', r.success && r.calendarDeleted === 1 && e.cal.evs[0].deleted && !e.cal.evs[1].deleted);
  const e2 = env({ resv: [resv({ note: SDC, ev: '' })], events: [{ id: 'X', title: '[消化] 通常_沖_山田太郎', start: T1600 }, { id: 'Z', title: '[消化] 振替_沖_山田太郎', start: T1600 }] });
  const r2 = e2.ctx.undoSameDayCancel('U_owner', ID);
  ok('③-2 ★候補が2件なら消さない（台帳は直す・0を返す）', r2.success && r2.calendarDeleted === 0 && !e2.cal.evs[0].deleted && !e2.cal.evs[1].deleted && e2.R1.data[1][6] === 'cancelled');
  const e3 = env({ resv: [resv({ note: SDC, ev: 'EV1' })], events: [{ id: 'EV1', title: '[消化] 通常_沖_山田太郎', start: T1600 + 3600000 }] });
  ok('③-3 IDが一致しても時刻が違えば消さない', e3.ctx.undoSameDayCancel('U_owner', ID).calendarDeleted === 0 && !e3.cal.evs[0].deleted);
  const e4 = env({ resv: [resv({ note: SDC })], credits: [] });
  const r4 = e4.ctx.undoSameDayCancel('U_owner', ID);
  ok('③-4 振替権が無い（振替予約の当日キャンセル）でも直せる', r4.success && r4.creditsRevoked === 0);
}

console.log('=== ③-b 顧客名は完全一致・書き込みの失敗は元に戻す ===');
{
  const e = env({ resv: [resv({ note: SDC, name: '山田', ev: '' })], events: [{ id: 'X', title: '[消化] 通常_沖_山田太郎様_line', start: T1600 }] });
  const r = e.ctx.undoSameDayCancel('U_owner', ID);
  ok('③-b1 ★「山田」の訂正で「山田太郎」の [消化] を消さない', r.success && r.calendarDeleted === 0 && !e.cal.evs[0].deleted);
  const e2 = env({ resv: [resv({ note: SDC, name: '山田 太郎', ev: '' })], events: [{ id: 'X', title: '[消化] 通常_沖_山田太郎様_line', start: T1600 }] });
  ok('③-b2 空白・「様」の違いは同じ名前として消す', e2.ctx.undoSameDayCancel('U_owner', ID).calendarDeleted === 1 && e2.cal.evs[0].deleted);
  const e5 = env({ resv: [resv({ note: SDC, name: '山田_太郎', ev: '' })], events: [{ id: 'X', title: '[消化] 通常_沖_山田_太郎様_line', start: T1600 }] });
  ok('③-b2b 顧客名に _ があっても消す（BookingRules の解析と同じ）', e5.ctx.undoSameDayCancel('U_owner', ID).calendarDeleted === 1 && e5.cal.evs[0].deleted);
  const e3 = env({ failLedger: true, resv: [resv({ note: SDC })], credits: [credit({ src: ID })] });
  const r3 = e3.ctx.undoSameDayCancel('U_owner', ID);
  ok('③-b3 ★台帳の書き込みに失敗したら失敗を返す', r3.success === false && r3.code === 'WRITE_FAILED', JSON.stringify(r3));
  ok('③-b4 ★振替権を元の期限に戻す（無料キャンセルなのに振替権が消えた、を残さない）', e3.TC.data[1][2] === '2026/11/05 23:59' && !e3.TC.data[1][5], JSON.stringify(e3.TC.data[1]));
  ok('③-b5 台帳は consumed のまま', e3.R1.data[1][6] === 'consumed');
  const e4 = env({ failCreditAt: 2, resv: [resv({ note: SDC })], credits: [credit({ src: ID }), credit({ src: ID, exp: '2026/11/06 23:59' })] });
  const r4 = e4.ctx.undoSameDayCancel('U_owner', ID);
  ok('③-b6 ★振替権の2行目で失敗したら1行目を戻し、台帳は触らない', r4.code === 'WRITE_FAILED' && e4.TC.data[1][2] === '2026/11/05 23:59' && e4.R1.data[1][6] === 'consumed' && e4.R1.writes() === 0, JSON.stringify(r4) + JSON.stringify(e4.TC.data));
}

console.log('=== ④ 無効にした振替権は使えない ===');
{
  const e = env({ resv: [resv({ note: SDC })], credits: [credit({ src: ID })] });
  ok('④-0 直す前は使える', e.ctx._lbUseTransferCredit('C0001').ok === true);
  const e2 = env({ resv: [resv({ note: SDC })], credits: [credit({ src: ID })] });
  e2.ctx.undoSameDayCancel('U_owner', ID);
  ok('④-1 ★予約の入口（_lbUseTransferCredit）から使えない', e2.ctx._lbUseTransferCredit('C0001').ok === false);
  const c = e2.TC.data[1];
  const st = R._lbTransferCreditState([{ grantedMs: 0, expiresMs: e2.ctx._lbParseResvDate(c[2]).getTime(), usedMs: 0 }], NOW);
  ok('④-2 ★残数の写し・声かけが使う判定（_lbTransferCreditState）でも 0', st.available === 0, JSON.stringify(st));
}

console.log('=== ⑤ 一覧 ===');
{
  const e = env({
    resv: [resv({ note: SDC }), resv({ note: 'Lb|当日消化取消', at: '2026/11/03 10:00', cid: 'C0002', name: '佐藤' }),
           resv({ note: 'Lc', status: 'consumed' }), resv({ note: 'Ld|当日消化取消', at: '2026/09/20 10:00' }),
           resv({ note: 'Le|当日消化取消', status: 'cancelled' })],
    credits: [credit({ src: 'Lb', cid: 'C0002', used: '2026/11/01 10:00' })],
  });
  const r = e.ctx.listSameDayCancels('U_owner');
  ok('⑤-1 対象の行だけ（今月以降・consumed・当日消化取消）', r.success && r.items.length === 2, JSON.stringify(r.items));
  ok('⑤-2 新しい順', r.items[0].reservationId === 'Lb' && r.items[1].reservationId === ID);
  ok('⑤-3 振替権の使用を返す', r.items[0].transferUsed === true && r.items[1].transferUsed === false);
  ok('⑤-4 ★顧客IDを返さない', r.items.every((x) => !('customerId' in x)));
  const e2 = env({ owner: false, resv: [resv({ note: SDC })] });
  ok('⑤-5 ★オーナー以外は FORBIDDEN', e2.ctx.listSameDayCancels('U_tr').code === 'FORBIDDEN');
}

console.log('=== ⑥ 配線 ===');
{
  ok('⑥-1 振り分けに2つの case', /case 'line_listSameDayCancels':\s*return listSameDayCancels\(lineUserId\);/.test(LB)
     && /case 'line_undoSameDayCancel':\s*return undoSameDayCancel\(lineUserId, params\.reservationId\);/.test(LB));
  const aw = PE.match(/var EDGE_AFTER_WRITE = \{([\s\S]*?)\};/)[1], cs = PE.match(/var EDGE_CALSYNC_AFTER = \{([\s\S]*?)\};/)[1];
  ok('⑥-2 ★D1の後始末（EDGE_AFTER_WRITE）に入っている', /line_undoSameDayCancel: 1/.test(aw));
  ok('⑥-3 カレンダー同期（EDGE_CALSYNC_AFTER）に入っている', /line_undoSameDayCancel: 1/.test(cs));
  ok('⑥-4 一覧（読み取り）は後始末に入れない', !/line_listSameDayCancels/.test(aw) && !/line_listSameDayCancels/.test(cs));
  const wa = HTML.match(/var\s+EDGE_WRITE_ACTIONS\s*=\s*(\/\^[^\n]+?\/)\s*;/)[1];
  ok('⑥-5 LIFF：書き込みとして扱う（写しを信用しない印）', new Function('return ' + wa)().test('undoSameDayCancel'));
  ok('⑥-6 LIFF：再試行しない', /var _NO_RETRY = \[[\s\S]*?'undoSameDayCancel'[\s\S]*?\];/.test(HTML));
  const owner = HTML.match(/if \(state\._isOwner\) \{   \/\/ 全体の不備[\s\S]*?\n    \}/);
  ok('⑥-7 ★ボタンはオーナーの枠の中だけ', owner && /loadSameDayCancels\(\)/.test(owner[0]) && (HTML.match(/loadSameDayCancels\(\)/g) || []).length === 3,
     '呼び出しが枠の外に増えていないか（定義1・ボタン1・再読込1）');
  ok('⑥-8 GAS の関数自身がオーナーを確かめる（画面の出し分けは権限ではない）',
     /function undoSameDayCancel\(lineUserId, reservationId\) \{\n  var _tr = getTrainerByLine\(lineUserId\);\n  if \(!_lbIsOwnerRole\(_tr\)\)/.test(LB)
     && /function listSameDayCancels\(lineUserId\) \{\n  if \(!_lbIsOwnerRole\(getTrainerByLine\(lineUserId\)\)\)/.test(LB));
}

console.log((fail === 0 ? '✅ ' : '⚠️ ') + `当日キャンセルの取り消し 検証: ${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
