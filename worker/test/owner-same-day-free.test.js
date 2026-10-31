// オーナーだけが、当日（前日17時以降）の予約を無料で取り消す・変更できるかを確かめる（設計26）。
//   実行: node worker/test/owner-same-day-free.test.js
//
// ★なぜ要るのか（2026-10-31 オーナー指示）
//   前日17時を過ぎると、誰が操作しても取消は「当日消化＋振替権」、変更は SAME_DAY で止まっていた。
//   オーナーが事情を汲んで無料にする手段が無く、取り消してから設計24のボタンで直す二度手間だった。
//
//   ① 取消（cancelReservationLine を本物のまま・台帳とカレンダーは身代わり）
//      オーナー＋期限後＋ownerFree → cancelled・予定を消す・振替権なし・記録・通知文
//      ownerFree なし → 今までどおり当日消化／オーナー以外が ownerFree → FORBIDDEN で何も書かない
//   ② 変更（changeReservationLine を本物のまま）
//      オーナー＋期限後＋ownerFree → SAME_DAY で止まらず予約の本体へ・記録と通知は無料／なし → SAME_DAY
//   ③ 配線：専用の入口が ownerFree を付けて呼ぶ・普通の入口は付けない・D1 の後始末の一覧に載っている
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

process.env.TZ = 'Asia/Tokyo';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LB = readFileSync(join(ROOT, 'gas/LineBooking.js'), 'utf8');
const PE = readFileSync(join(ROOT, 'gas/PushToEdge.js'), 'utf8');
const HTML = readFileSync(join(ROOT, 'liff/index.html'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, why) { if (cond) pass++; else { fail++; console.log(`❌ ${name}`); if (why) console.log(`   ${why}`); } }
function pluck(src, name) {
  const m = src.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('見つからない: ' + name);
  return m[0];
}

const NOW = new Date(2026, 9, 31, 10).getTime();                 // 10/31 10:00
const TODAY_18 = new Date(2026, 9, 31, 18);                       // 当日 18:00＝期限後
const NEXT_WEEK = new Date(2026, 10, 7, 18);                      // 11/7＝期限前
class FakeDate extends Date { constructor(...a) { if (a.length === 0) super(NOW); else super(...a); } static now() { return NOW; } }

const OWNER = { trainerId: 'T0', role: 'owner', id: 'T0', name: 'オーナー' };
const TRAINER = { trainerId: 'T1', role: 'trainer', id: 'T1', name: '担当' };

function world({ actor, start, channel = 'line', maySee = true }) {
  // 台帳1行（A〜K）：日時・氏名・会員ID・LINE・担当・…・状態(G)・…・備考(I)・経路(J)
  const row = [start, '会員', 'C1', 'Ucust', 'T1', '', 'confirmed', '', 'R1', channel, ''];
  const log = { writes: {}, deleted: 0, consumed: 0, credit: 0, push: [], core: [] };
  const sheet = {
    getLastRow: () => 2, getLastColumn: () => 15,
    getRange: (r, c, nr, nc) => (nr === undefined
      ? { setValue: (v) => { log.writes[c] = v; row[c - 1] = v; }, getValue: () => row[c - 1] }
      : { getValues: () => [row.slice(0, Math.max(nc, 11))] }),
  };
  const ctx = {
    Date: FakeDate, Math, String, Number, isNaN, JSON, Logger: { log: () => {} },
    SETTINGS: { TIMEZONE: 'Asia/Tokyo', SESSION_MINUTES: 60 }, LINE_BOOKING: { RESV_SHEET: 'r' }, MAP_COL: { AUTH_STATE: 8 },
    Utilities: { formatDate: (d) => new Date(d).toISOString().slice(0, 16) },
    getCustomerByLine: () => null,
    getTrainerByLine: () => actor,
    _lbSheet: () => sheet,
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {}, tryLock: () => true, hasLock: () => true }) },
    SpreadsheetApp: { flush: () => {} },
    _lbParseResvDate: (v) => v,
    _lbTrainerById: () => TRAINER,
    _lbDeleteReservationEvents: () => { log.deleted++; },
    _lbConsumeReservationEvents: () => { log.consumed++; },
    _lbGrantTransferCredit: () => { log.credit++; },
    _lbFmtResvLabel: () => 'L', _lbMemberLang: () => 'ja', _lbSt: (lang, key) => '[' + key + ']',
    _lbPush: (to, text, kind) => { log.push.push({ to, text, kind }); },
    getTrainerLineId: () => 'Utr', _lbTrainerNameLang: () => '担当', _lbTrainerRemainText: () => '',
    _lbTrainerMaySeeCustomer: () => maySee, _lbCustOwnerOf: () => 'T1',
    _lbContractTypeOf: () => '通常',
    _lbReserveCore: (ci, body, ch) => { log.core.push({ ci, body, ch }); return { success: true, reservationId: 'R2', calendarEventId: '', trainerEventId: '' }; },
  };
  vm.createContext(ctx);
  vm.runInContext([pluck(LB, '_lbIsOwnerRole'), pluck(LB, '_lbIsFreeCancelWindow'), pluck(LB, 'cancelReservationLine'), pluck(LB, 'changeReservationLine')].join('\n'), ctx);
  return { ctx, log, row };
}

console.log('=== ① 取消 ===');
{
  const w = world({ actor: OWNER, start: TODAY_18 });
  const r = w.ctx.cancelReservationLine('Uowner', 'R1', { ownerFree: true });
  ok('①-1 ★オーナー＋当日＋ownerFree → 成功・ownerFree:true・penalty:false', r.success && r.ownerFree === true && r.penalty === false, JSON.stringify(r));
  ok('①-2 ★状態は cancelled（残数が戻る）', w.row[6] === 'cancelled', w.row[6]);
  ok('①-3 ★予定を消す（[消化] にしない）', w.log.deleted === 1 && w.log.consumed === 0, JSON.stringify(w.log));
  ok('①-4 ★振替権を付けない', w.log.credit === 0);
  ok('①-5 記録は「無料取消（オーナー権限 …）」', /^R1\|無料取消（オーナー権限 .+）$/.test(w.row[8]), w.row[8]);
  ok('①-6 ★お客様へは「今回は無料」の文言（「前日17時まで」ではない）', w.log.push.some((p) => p.to === 'Ucust' && /push_cancel_owner_free/.test(p.text)) && !w.log.push.some((p) => /push_cancel_free\]|push_cancel_penalty/.test(p.text)), JSON.stringify(w.log.push));
  ok('①-7 トレーナーへは「無料取消・オーナー権限」', w.log.push.some((p) => p.to === 'Utr' && /無料取消・オーナー権限/.test(p.text)));
  ok('①-8 会員IDを返す（D1 の作り直し）', r.customerId === 'C1');

  const n = world({ actor: OWNER, start: TODAY_18 });
  const rn = n.ctx.cancelReservationLine('Uowner', 'R1');
  ok('①-9 ★オーナーでも ownerFree なし → 今までどおり当日消化＋振替権', rn.penalty === true && n.row[6] === 'consumed' && n.log.credit === 1 && n.log.consumed === 1, JSON.stringify({ rn, row: n.row[6] }));

  const t = world({ actor: TRAINER, start: TODAY_18 });
  const rt = t.ctx.cancelReservationLine('Utrainer', 'R1', { ownerFree: true });
  ok('①-10 ★担当トレーナーが ownerFree → FORBIDDEN・何も書かない', rt.code === 'FORBIDDEN' && Object.keys(t.log.writes).length === 0 && t.log.deleted + t.log.consumed === 0, JSON.stringify({ rt, w: t.log.writes }));
  const c = world({ actor: null, start: TODAY_18 });
  const rc = c.ctx.cancelReservationLine('Ucust', 'R1', { ownerFree: true });
  ok('①-11 ★本人（お客様）が ownerFree → FORBIDDEN・何も書かない', rc.code === 'FORBIDDEN' && Object.keys(c.log.writes).length === 0, JSON.stringify(rc));
  const ns = world({ actor: OWNER, start: TODAY_18, maySee: false });
  const rns = ns.ctx.cancelReservationLine('Uowner', 'R1', { ownerFree: true });
  ok('①-12 名簿に無い顧客（認可の正本が通らない）→ FORBIDDEN', rns.code === 'FORBIDDEN' && Object.keys(ns.log.writes).length === 0);

  const f = world({ actor: OWNER, start: NEXT_WEEK });
  const rf = f.ctx.cancelReservationLine('Uowner', 'R1', { ownerFree: true });
  ok('①-13 期限前＋ownerFree → 通常の無料（文言も通常・ownerFree:false）', rf.success && rf.ownerFree === false && f.row[8] === 'R1|無料取消' && f.log.push.some((p) => /push_cancel_free\]/.test(p.text)), JSON.stringify({ rf, note: f.row[8] }));
  const tr = world({ actor: OWNER, start: TODAY_18, channel: 'transfer' });
  const rtr = tr.ctx.cancelReservationLine('Uowner', 'R1', { ownerFree: true });
  ok('①-14 振替予約も無料で取り消せる（振替権は付けない）', rtr.success && tr.row[6] === 'cancelled' && tr.log.credit === 0);
}

console.log('=== ② 変更 ===');
{
  const NEW = new Date(2026, 10, 3, 18).toISOString();
  const w = world({ actor: OWNER, start: TODAY_18 });
  const r = w.ctx.changeReservationLine('Uowner', 'R1', NEW, { ownerFree: true });
  ok('②-1 ★オーナー＋当日＋ownerFree → SAME_DAY で止まらず予約の本体へ', r.success && w.log.core.length === 1 && w.log.core[0].ch === 'change', JSON.stringify(r));
  ok('②-2 ★戻り値 penalty:false・ownerFree:true', r.penalty === false && r.ownerFree === true);
  ok('②-3 ★記録は「無料変更（オーナー権限 …）」', /^R1\|→R2\|無料変更（オーナー権限 .+）$/.test(w.row[8]), w.row[8]);
  ok('②-4 ★お客様へは「今回は無料」・当日消化の文言は出さない', w.log.push.some((p) => p.to === 'Ucust' && /push_change_owner_free/.test(p.text)) && !w.log.push.some((p) => /push_change_penalty/.test(p.text)), JSON.stringify(w.log.push));
  ok('②-5 トレーナーへ「当日の無料変更・オーナー権限」', w.log.push.some((p) => p.to === 'Utr' && /当日の無料変更・オーナー権限/.test(p.text)));
  ok('②-6 旧行は changed（新しい予約へ）', w.row[6] === 'changed');

  const n = world({ actor: OWNER, start: TODAY_18 });
  const rn = n.ctx.changeReservationLine('Uowner', 'R1', NEW);
  ok('②-7 ★ownerFree なし → SAME_DAY（何も書かない）', rn.code === 'SAME_DAY' && n.log.core.length === 0 && Object.keys(n.log.writes).length === 0, JSON.stringify(rn));
  const t = world({ actor: TRAINER, start: TODAY_18 });
  const rt = t.ctx.changeReservationLine('Utrainer', 'R1', NEW, { ownerFree: true });
  ok('②-8 ★担当トレーナーが ownerFree → FORBIDDEN・何も書かない', rt.code === 'FORBIDDEN' && t.log.core.length === 0 && Object.keys(t.log.writes).length === 0);
  const tr = world({ actor: OWNER, start: TODAY_18, channel: 'transfer' });
  ok('②-9 振替予約の変更は今までどおり不可', tr.ctx.changeReservationLine('Uowner', 'R1', NEW, { ownerFree: true }).code === 'NO_TRANSFER_CHANGE');
}

console.log('=== ③ 配線 ===');
{
  ok('③-1 ★専用の入口：取消は ownerFree を付けて呼ぶ', /case 'line_ownerFreeCancel':\s*return cancelReservationLine\(lineUserId, params\.reservationId, \{ ownerFree: true \}\);/.test(LB));
  ok('③-2 ★専用の入口：変更も同じ', /case 'line_ownerFreeChange':\s*return changeReservationLine\(lineUserId, params\.reservationId, params\.newStartISO, \{ ownerFree: true \}\);/.test(LB));
  ok('③-3 ★普通の入口は ownerFree を付けない（クライアントの値で無料にならない）',
    /case 'line_cancelReservation':\s*return cancelReservationLine\(lineUserId, params\.reservationId\);/.test(LB)
    && /case 'line_changeReservation':\s*return changeReservationLine\(lineUserId, params\.reservationId, params\.newStartISO\);/.test(LB));
  const ew = (PE.match(/var EDGE_AFTER_WRITE = \{([\s\S]*?)\};/) || [])[1] || '';
  const ec = (PE.match(/var EDGE_CALSYNC_AFTER = \{([\s\S]*?)\};/) || [])[1] || '';
  ok('③-4 D1 の後始末（EDGE_AFTER_WRITE）に2つとも', /line_ownerFreeCancel: 1/.test(ew) && /line_ownerFreeChange: 1/.test(ew));
  ok('③-5 カレンダーの送り直し（EDGE_CALSYNC_AFTER）に2つとも', /line_ownerFreeCancel: 1/.test(ec) && /line_ownerFreeChange: 1/.test(ec));
  ok('③-6 画面：書き込みの印（写しを信用しない）', /EDGE_WRITE_ACTIONS = \/\^\([^)]*ownerFreeCancel\|ownerFreeChange/.test(HTML));
  ok('③-7 画面：再試行しない', /'ownerFreeCancel', 'ownerFreeChange'/.test(HTML));
  ok('③-8 ★画面：オーナーのボタンは _isOwner かつ期限後の内側だけ', /if \(state\._isOwner && !r\.freeCancel && !r\.transfer\) \{\s*var ochg/.test(HTML) && /if \(state\._isOwner && !r\.freeCancel\) \{\s*var ocxl/.test(HTML));
  ok('③-9 ★画面：専用の入口へ送るのは、オーナーが始めたその予約の変更だけ', /action: \(state\._ownerFreeResId && state\._ownerFreeResId === state\.changeReservationId\) \? 'line_ownerFreeChange' : 'line_changeReservation'/.test(HTML));
  ok('③-10 画面：お客様の変更開始でオーナー権限の印を消す', /function startChange\(r\)\{[\s\S]{0,300}state\._ownerFreeResId = '';/.test(HTML));
  const offs = (HTML.match(/state\.changeMode ?= ?false;(?! state\._ownerFreeResId='';)/g) || []).length;
  ok('③-12 ★画面：変更モードを解く所ではすべて印も消す', offs === 0 && (HTML.match(/state\.changeMode ?= ?false; state\._ownerFreeResId='';/g) || []).length >= 8, `消していない所 ${offs}`);
  ok('③-13 ★画面：管理一覧に戻ると本人の担当・名前へ戻し、印も消す', /function loadTrainerReservations\(\)\{[\s\S]{0,400}if \(state\._adminTrainerId\) \{ state\.trainerId = state\._adminTrainerId; state\.trainerName = state\._adminTrainerName \|\| ''; \}\s*state\._ownerFreeResId = '';/.test(HTML));
  ok('③-14 画面：本人の担当・名前は管理画面を開いたときに覚える', /state\._adminTrainerId = state\.trainerId; state\._adminTrainerName = state\.trainerName;/.test(HTML));
  ok('③-11 画面：変更の空き枠はその予約の担当で出す', /function startTrainerChange\(r, ownerFree\)\{[\s\S]{0,1400}state\.trainerId = r\.trainerId;/.test(HTML));
}

console.log('=== ④ 時間切れのあとの成立確認（_verifyBooked を本物のまま）===');
{
  const src = (HTML.match(/function _verifyBooked\(req\)\{[\s\S]*?\n  \}\n/) || [])[0];
  ok('④-0 取り出し', !!src);
  async function verify(state, lists) {
    const asked = [];
    const ctx = {
      String, Promise, state, VERIFY_RETRY_MS: 0,
      _delay: () => Promise.resolve(),
      _sameStart: (a, b) => String(a) === String(b),
      api: (q) => { asked.push(q.action); return Promise.resolve({ success: true, reservations: lists[q.action] || [] }); },
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    const r = await ctx._verifyBooked({ action: 'line_ownerFreeChange', reservationId: 'R1', newStartISO: 'T1930' });
    return { r, asked };
  }
  const TR = { line_getTrainerReservations: [{ startISO: 'T1930', customerId: 'C9', trainerId: 'T1' }, { startISO: 'T1930', customerId: 'C1', trainerId: 'T1', reservationId: 'R2' }] };
  const a = await verify({ changeMode: true, _fromTrainerAdmin: true, changeCustomerId: 'C1', trainerId: 'T1' }, TR);
  ok('④-1 ★管理画面からの変更：トレーナーの予約表をその会員で見て「入っていた」', a.r === true && a.asked[0] === 'line_getTrainerReservations', JSON.stringify(a));
  const b = await verify({ changeMode: true, _fromTrainerAdmin: true, changeCustomerId: 'C1' }, { line_getTrainerReservations: [{ startISO: 'T1930', customerId: 'C9' }] });
  ok('④-2 ★同じ時刻の別の会員の予約では「入っていた」にしない', b.r === null, JSON.stringify(b));
  const c = await verify({ changeMode: true, _fromTrainerAdmin: false, changeCustomerId: '' }, { line_getMyReservations: [{ startISO: 'T1930' }] });
  const d = await verify({ changeMode: true, _fromTrainerAdmin: true, changeCustomerId: 'C1', trainerId: 'T1' }, { line_getTrainerReservations: [{ startISO: 'T1930', customerId: 'C1', trainerId: 'T2' }] });
  ok('④-2b 同じ会員・同じ時刻でも担当が違えば「入っていた」にしない', d.r === null, JSON.stringify(d));
  const d2 = await verify({ changeMode: true, _fromTrainerAdmin: true, changeCustomerId: 'C1', trainerId: 'T1' }, { line_getTrainerReservations: [{ startISO: 'T1930', customerId: 'C1', trainerId: '' }] });
  ok('④-2d 担当が欠けた予約は「入っていた」にしない', d2.r === null, JSON.stringify(d2));
  const ok1 = await verify({ changeMode: true, _fromTrainerAdmin: true, changeCustomerId: 'C1', trainerId: 'T1' }, { line_getTrainerReservations: [{ startISO: 'T1930', customerId: 'C1', trainerId: 'T1', reservationId: 'R2' }] });
  ok('④-2e 会員・担当・時刻が一致し別の予約ID → 入っていた', ok1.r === true, JSON.stringify(ok1));
  const e = await verify({ changeMode: true, _fromTrainerAdmin: true, changeCustomerId: 'C1', trainerId: 'T1' }, { line_getTrainerReservations: [{ startISO: 'T1930', customerId: 'C1', trainerId: 'T1', reservationId: 'R1' }] });
  ok('④-2c 変更元の予約そのものは「入っていた」にしない', e.r === null, JSON.stringify(e));
  ok('④-3 お客様の変更は今までどおり自分の予約表', c.r === true && c.asked[0] === 'line_getMyReservations', JSON.stringify(c));
  ok('④-4 画面：変更の開始で会員を覚える', /state\.changeCustomerId = String\(r\.customerId \|\| ''\);/.test(HTML));
  ok('④-5 ★画面：担当の名前はトレーナー一覧を読んでから決める・古い読み込みは捨てる', /_ensureAdminTrainers\(function\(\)\{\s*if \(_tok !== state\._chgTok\) return;[\s\S]{0,250}state\.trainerId = r\.trainerId;\s*state\.trainerName = _tn \? _tn\.name : '';/.test(HTML));
  ok('④-6 画面：一覧の読み直しで会員の印も消す', /state\._ownerFreeResId = ''; state\.changeCustomerId = '';/.test(HTML));
}

console.log((fail === 0 ? '✅ ' : '⚠️ ') + `オーナーの当日無料取消・変更 検証: ${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
