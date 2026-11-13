// キャンセル理由（設計36）の GAS 側を入口から通す検査
//   実行: node worker/test/gas-cancel-reason.test.js
//
// ★なぜ要るのか
//   会員のキャンセルに「理由（選択肢）＋ひとこと（100字）」を足した。理由は「おまけ」で、
//   **理由のせいでキャンセルが失敗することは一度もあってはならない**（設計36 §1）。
//   しかも台帳の備考（9列目）は予約の鍵で、送り直し（I17）・当日キャンセルの訂正（設計24）・声かけが
//   `split('|')[0]` や前方一致で読んでいる。理由を1文字でも混ぜると、それらが静かに壊れる。
//
//   身代わりにするのは、シート（台帳・cancel_notes・notify_retry・booking_metrics）・カレンダーの後始末・
//   LINE の送信（UrlFetchApp）・時計・ロックだけ。cancelReservationLine と、通知の送り直しの区画
//   （NOTIFY_QUEUE_BEGIN〜END）は本物のまま vm で動かす。
//
//   1. 備考は1文字も同じ／cancel_notes に1行（理由が無くても）
//   2. 理由の整え方（知らない鍵・長すぎる・数式・会員以外）
//   3. 同意した結果（cxlExpect）の6通り
//   4. ロックの中は「判定・台帳・振替権・cancel_notes の1行」だけ（通知・検索・掃除はロックの後）
//   5. 通知の中身（その枠・契約上の担当・会員）と送り直しの ctx
//   6. 時間の予算（429・遅い送信・積む約束）
//   7. 成立後の付け足しは単位ごとに独立（どれが落ちても success:true）
//   8. cancel_notes の見出し・保存の失敗
//   9. 掃除（1年でひとこと・2年で識別子）／日次点検／作業依頼の件数（note を読まない）
//  10. 備考を鍵として読む4か所が今どおり／送り直しの本文を30日で空にする
//  11. ひとことの整え方が画面と同じ（ランダムに突き合わせる）／配線
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

process.env.TZ = 'Asia/Tokyo';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LB = readFileSync(join(ROOT, 'gas/LineBooking.js'), 'utf8');
const CODE = readFileSync(join(ROOT, 'gas/コード.js'), 'utf8');
const NUDGE = readFileSync(join(ROOT, 'gas/Nudge.js'), 'utf8');
const JOB = readFileSync(join(ROOT, 'gas/EdgeJob.js'), 'utf8');
const HTML = readFileSync(join(ROOT, 'liff/index.html'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, why) { if (cond) pass++; else { fail++; console.log(`❌ ${name}`); if (why) console.log(`   ${why}`); } }
function pluck(src, name) {
  const m = src.match(new RegExp('\\nfunction ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('見つからない: ' + name);
  return m[0];
}
function pluckVar(src, re) { const m = src.match(re); if (!m) throw new Error('見つからない: ' + re); return m[0]; }

const SECTION = pluckVar(LB, /\/\/ ==== NOTIFY_QUEUE_BEGIN ====[\s\S]*?\/\/ ==== NOTIFY_QUEUE_END ====/);
const PARTS = [
  (LB.match(/^var LB_CXL_[A-Z_]+ = [^\n]+$/gm) || []).join('\n'),
  pluckVar(LB, /^var LB_CN = \{[\s\S]*?\n\};/m),
  'var _LB_CN_READY = null;',
  pluckVar(LB, /^var _LB_ST = \{[\s\S]*?\n\};/m),
  "var LB_SDC_TAG = '|当日消化取消';",
  ...['_lbIsOwnerRole', '_lbIsFreeCancelWindow', 'cancelReservationLine', '_lbCxlExpect', '_lbCxlNormText', '_lbCxlNormalize',
      '_lbCxlLogErr', '_lbCxlAfter', '_lbCnCol', '_lbCnReady', '_lbCnRow', 'setupCancelNotesSheet', '_lbCnMaintain', '_lbCnMark', '_lbCustOwnerMap', '_lbCustOwnerFromMap', '_lbCnHealth',
      'cancelNotesCountText', '_lbSt', '_lbNormLang', '_lbResIdOfNote', '_lbSdcVerdict'].map((n) => pluck(LB, n)),
  pluck(CODE, 'sanitizeCell'),
  pluck(NUDGE, '_lbNudgeResId'),
  SECTION,
].join('\n');

const DAY = 86400000;
const NOW = new Date(2026, 10, 6, 10, 0, 0).getTime();   // 2026-11-06 10:00
const NEXT_WEEK = new Date(2026, 10, 13, 18, 0);         // 期限前＝無料
const TODAY_18 = new Date(2026, 10, 6, 18, 0);           // 期限後＝当日消化
const pad = (n) => String(n).padStart(2, '0');
function fmt(d, pat) {
  d = new Date(d);
  return String(pat).replace('yyyy', d.getFullYear()).replace('MM', pad(d.getMonth() + 1)).replace('dd', pad(d.getDate()))
    .replace('HH', pad(d.getHours())).replace('mm', pad(d.getMinutes())).replace('ss', pad(d.getSeconds())).replace(/^M\//, (d.getMonth() + 1) + '/');
}

function makeSheet(name, rows, trace, opts = {}) {
  const data = rows.map((r) => r.slice());
  const sh = {
    name, data, reads: [], writes: 0,
    getLastRow: () => data.length,
    getLastColumn: () => (opts.lastCol != null ? opts.lastCol : data.reduce((a, r) => Math.max(a, r.length), 0)),
    getRange(r, c, nr = 1, nc = 1) {
      return {
        getValues: () => {
          if (opts.readThrows) throw new Error('read failed');
          sh.reads.push({ r, c, nr, nc }); trace.push('read:' + name);
          const out = []; for (let i = 0; i < nr; i++) { const row = data[r - 1 + i] || []; const o = []; for (let j = 0; j < nc; j++) o.push(row[c - 1 + j] === undefined ? '' : row[c - 1 + j]); out.push(o); } return out;
        },
        setValues: (v) => { sh.writes++; trace.push('write:' + name); for (let i = 0; i < nr; i++) { if (!data[r - 1 + i]) data[r - 1 + i] = []; for (let j = 0; j < nc; j++) data[r - 1 + i][c - 1 + j] = v[i][j]; } },
        getValue: () => (data[r - 1] || [])[c - 1],
        setValue: (x) => { sh.writes++; trace.push('write:' + name); if (!data[r - 1]) data[r - 1] = []; data[r - 1][c - 1] = x; },
        clearContent: () => {},
      };
    },
    appendRow: (row) => { if (opts.appendThrows) throw new Error('append failed'); trace.push('append:' + name); data.push(row.slice()); },
  };
  return sh;
}

const CN_HEAD = ['res_id', 'cancelled_at', 'start_at', 'trainer_id', 'customer_id', 'actor', 'outcome', 'transfer',
  'reason_key', 'trainer_reason', 'note', 'note_purged_at', 'notified', 'ids_purged_at'];
const NQ_HEAD_SRC = SECTION.match(/HEAD: (\[[\s\S]*?\]),/)[1];
const NQ_HEAD = vm.runInNewContext(NQ_HEAD_SRC);

// 世界を作る。o.actor: 'customer' | 'trainer' | 'owner'
function world(o = {}) {
  const trace = [];
  const clock = { now: NOW };
  class FakeDate extends Date { constructor(...a) { if (a.length) super(...a); else super(clock.now); } static now() { return clock.now; } }
  const start = o.start || NEXT_WEEK;
  const ledgerRow = [start, '会員見本', 'C0001', 'Ucust', 'T1', '担当一', 'confirmed', '', 'R1', o.channel || 'line', ''];
  const resv = makeSheet('line_reservations', [['h'], ledgerRow], trace);
  const custMap = makeSheet('customer_line_map', [['h', 'h']].concat(o.mapRows || [['C0001', 'T1']]), trace);
  const ledger = resv.data[1];   // ★書き込みはシートの中の行に入る（コピー元ではなくこちらを見る）
  const cnRows = o.cnRows || [CN_HEAD.slice()];
  const sheets = new Map();
  if (o.cnSheet !== false) sheets.set('cancel_notes', makeSheet('cancel_notes', cnRows, trace, { appendThrows: o.cnAppendThrows, lastCol: o.cnLastCol, readThrows: o.cnReadThrows }));
  sheets.set('notify_retry', makeSheet('notify_retry', [NQ_HEAD.slice()], trace, { appendThrows: o.nqAppendThrows }));
  const metrics = [];
  const logs = [];
  const props = new Map([['LINE_MESSAGING_TOKEN', 'tok']]);
  const fetches = [];
  const calls = { deleted: 0, consumed: 0, credit: 0 };
  const lineOf = Object.assign({ T1: 'Utr1', T2: 'Utr2', T0: 'Uown' }, o.lineOf || {});
  const actor = o.actor || 'customer';
  const lineUserId = actor === 'customer' ? 'Ucust' : (actor === 'owner' ? 'Uowner' : 'Utr1');
  const ctx = {
    Date: FakeDate, Math, JSON, String, Number, Object, Array, RegExp, Error, isFinite, isNaN,
    Logger: { log: (s) => logs.push(String(s)) },
    SETTINGS: { TIMEZONE: 'Asia/Tokyo', SESSION_MINUTES: 60 },
    _lbWpMark: () => {},   // 設計43 の計測の印（ここでは何もしない）
    LINE_BOOKING: { RESV_SHEET: 'line_reservations', MAP_SHEET: 'customer_line_map' }, MAP_COL: { AUTH_STATE: 8, CUSTOMER_ID: 1, TRAINER_ID: 2 },
    _lbMapWidth: () => 2,
    Utilities: { formatDate: (d, tz, pat) => fmt(d, pat), sleep: (ms) => { clock.now += ms; }, getUuid: (() => { let n = 0; return () => 'u' + (++n); })() },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (props.has(k) ? props.get(k) : null), setProperty: (k, v) => props.set(k, String(v)) }) },
    LockService: { getScriptLock: () => ({ waitLock: () => trace.push('lock'), releaseLock: () => trace.push('release'), tryLock: () => { trace.push('lock'); return true; } }) },
    UrlFetchApp: {
      fetch: (url, opt) => {
        const body = JSON.parse(opt.payload);
        trace.push('fetch:' + body.to);
        fetches.push({ to: body.to, text: body.messages[0].text, at: clock.now });
        if (o.latency) clock.now += o.latency(body.to, fetches.length);
        const code = o.code ? o.code(body.to, fetches.length) : 200;
        return { getResponseCode: () => code, getContentText: () => '{"message":"x"}' };
      },
    },
    MailApp: { sendEmail: () => {} },
    getCustomerByLine: (id) => (id === 'Ucust' ? { data: [0, 0, 0, 0, 0, 0, 0, 'verified'] } : null),
    getTrainerByLine: (id) => (trace.push('trbyline'), id === 'Utr1' ? { trainerId: 'T1', role: 'trainer' } : (id === 'Uowner' ? { trainerId: 'T0', role: 'owner' } : null)),
    _lbSheet: (n) => (n === 'line_reservations' ? resv : (n === 'customer_line_map' && o.mapRows !== null ? custMap : null)),
    _lbSs: () => ({ getSheetByName: (n) => sheets.get(n) || null, insertSheet: (n) => { const s = makeSheet(n, [], trace); sheets.set(n, s); return s; } }),
    _lbParseResvDate: (v) => (v && typeof v.getTime === 'function' ? v : null),
    _lbTrainerById: (id) => (o.noTrainer ? null : { id, name: '担当' + id, email: id + '@x' }),
    _lbDeleteReservationEvents: () => { calls.deleted++; trace.push('cal'); },
    _lbConsumeReservationEvents: () => { calls.consumed++; trace.push('cal'); },
    _lbGrantTransferCredit: () => { calls.credit++; trace.push('credit'); },
    _lbTrainerMaySeeCustomer: () => true, _lbCustOwnerOf: () => 'T1',
    _lbFmtResvLabel: (v, lang) => 'L' + (lang || ''),
    _lbMemberLang: (id) => { trace.push('lang'); if (o.langThrows) throw new Error('会員見本 Ucust'); return o.lang || 'ja'; },
    _lbTrainerNameLang: (tid, name) => name,
    getTrainerLineId: (tid) => { trace.push('trline:' + tid); if (o.slotLineThrows && tid === 'T1') throw new Error('Utr1 会員見本'); return lineOf[tid] || ''; },
    _lbCustTrainerId: (cid) => { trace.push('custtr'); if (o.custTrThrows) throw new Error('C0001 会員見本'); return o.ownerTid != null ? o.ownerTid : 'T1'; },
    _lbLogOutcome: (oc, ch, detail) => { if (o.metricsThrows) throw new Error('会員見本'); metrics.push({ oc, ch, detail: String(detail) }); trace.push('metric'); },
    _lbProp: (k) => (props.has(k) ? props.get(k) : ''),
    _lbIsStaging: () => false,
    _lbIsFiniteNum: (x) => typeof x === 'number' && isFinite(x),
    _lbLogNotifyFail: () => {},
    _lbAlertEmail: () => 'owner@example.com',
    _lbCustInfoById: () => ({ customerName: '会員見本' }),
  };
  vm.createContext(ctx);
  vm.runInContext(PARTS, ctx);
  const cn = () => sheets.get('cancel_notes');
  const cnRowsOut = () => (cn() ? cn().data.slice(1) : []);
  const nq = () => sheets.get('notify_retry').data.slice(1);
  const col = (n) => CN_HEAD.indexOf(n);
  const run = (cxl, extra) => {
    const opts = Object.assign({}, extra || {});
    if (cxl !== undefined) opts.cxl = cxl;
    clock.now = o.at != null ? o.at : NOW;
    return ctx.cancelReservationLine(lineUserId, 'R1', opts);
  };
  return { ctx, trace, clock, resv, ledgerRow: ledger, sheets, cn, cnRowsOut, nq, col, metrics, logs, props, fetches, calls, run };
}
const MARK = 'ひとこと目印ZQX';   // ひとことの本文の目印（ログ・作業依頼・会員宛に出ないことを確かめる）

// ============================================================
console.log('=== 1. 備考は1文字も同じ／cancel_notes に1行 ===');
{
  const free = world(); const rf = free.run({ reason: 'work', note: MARK, expect: 'free' });
  ok('1-1 ★無料：備考は「R1|無料取消」のまま（理由もひとことも無い）', free.ledgerRow[8] === 'R1|無料取消' && free.ledgerRow[6] === 'cancelled', free.ledgerRow[8]);
  ok('1-1b 成功の応答の形は今と同じ＋3つの鍵だけ', rf.success === true && rf.penalty === false && rf.ownerFree === false && rf.customerId === 'C0001'
     && JSON.stringify(Object.keys(rf).sort()) === JSON.stringify(['customerId', 'messageAccepted', 'noteDropped', 'ownerFree', 'penalty', 'recordSaved', 'success']), JSON.stringify(rf));
  const pen = world({ start: TODAY_18 }); const rp = pen.run({ reason: 'family', note: MARK, expect: 'consumed' });
  ok('1-2 ★当日消化：備考は「R1|当日消化取消」のまま・振替権が付く', pen.ledgerRow[8] === 'R1|当日消化取消' && pen.ledgerRow[6] === 'consumed' && pen.calls.credit === 1 && rp.penalty === true, pen.ledgerRow[8]);
  const own = world({ start: TODAY_18, actor: 'owner' }); const ro = own.run(undefined, { ownerFree: true });
  ok('1-3 ★オーナーの無料：備考は「R1|無料取消（オーナー権限 …）」のまま', /^R1\|無料取消（オーナー権限 \d{4}\/\d\d\/\d\d \d\d:\d\d）$/.test(own.ledgerRow[8]) && ro.ownerFree === true, own.ledgerRow[8]);
  ok('1-4 ★台帳の行のどこにも理由・ひとことが無い', ![free, pen].some((w) => w.ledgerRow.some((c) => /work|family|仕事|家庭|ZQX/.test(String(c)))));

  const rows = free.cnRowsOut(), c = free.col;
  ok('1-5 cancel_notes に1行（鍵・ひとこと・actor・outcome・時刻）', rows.length === 1 && rows[0][c('res_id')] === 'R1' && rows[0][c('reason_key')] === 'work'
     && rows[0][c('note')] === MARK && rows[0][c('actor')] === 'customer' && rows[0][c('outcome')] === 'free' && rows[0][c('cancelled_at')] === NOW
     && rows[0][c('start_at')] === NEXT_WEEK.getTime() && rows[0][c('trainer_id')] === 'T1' && rows[0][c('customer_id')] === 'C0001' && rows[0][c('transfer')] === false
     && rows[0][c('note_purged_at')] === '' && rows[0][c('trainer_reason')] === '', JSON.stringify(rows));
  ok('1-6 応答：recordSaved・messageAccepted が真・noteDropped は空', rf.recordSaved === true && rf.messageAccepted === true && rf.noteDropped === '', JSON.stringify(rf));
  const none = world(); const rn = none.run({ reason: '', note: '', expect: 'free' });
  ok('1-7 ★理由が無いキャンセルでも1行（ひとことの印は「-」＝空にする対象が無い）', none.cnRowsOut().length === 1 && none.cnRowsOut()[0][none.col('reason_key')] === ''
     && none.cnRowsOut()[0][none.col('note_purged_at')] === '-' && rn.recordSaved === true && rn.messageAccepted === false, JSON.stringify(none.cnRowsOut()));
  const old = world(); const rold = old.run(undefined);
  ok('1-8 古い画面（cxl なし）でも1行・今と同じ成功', rold.success && old.cnRowsOut().length === 1 && old.ledgerRow[8] === 'R1|無料取消');
  ok('1-9 オーナーの無料も1行（actor=owner・outcome=owner_free）', own.cnRowsOut().length === 1 && own.cnRowsOut()[0][own.col('actor')] === 'owner' && own.cnRowsOut()[0][own.col('outcome')] === 'owner_free');
  const tr = world({ channel: 'transfer', start: TODAY_18 }); tr.run({ expect: 'consumed' });
  ok('1-10 振替の予約は transfer=true・振替権は付けない', tr.cnRowsOut()[0][tr.col('transfer')] === true && tr.calls.credit === 0);
}

// ============================================================
console.log('=== 2. 理由の整え方 ===');
{
  const a = world(); const r = a.run({ reason: 'hack', note: '', expect: 'free' });
  ok('2-1 ★知らない鍵 → reason_key は空・キャンセルは成功', r.success && a.cnRowsOut()[0][a.col('reason_key')] === '' && a.ledgerRow[6] === 'cancelled');
  ok('2-1b 捨てた数を記録（CXL_REASON_DROPPED・本文なし）', a.metrics.some((m) => m.oc === 'CXL_REASON_DROPPED'));
  const b = world(); const rb = b.run({ reason: 'work', note: 'あ'.repeat(101), expect: 'free' });
  ok('2-2 ★101字 → 保存しない・noteDropped=too_long・キャンセルは成功・理由は残る', rb.success && b.cnRowsOut()[0][b.col('note')] === '' && rb.noteDropped === 'too_long'
     && b.cnRowsOut()[0][b.col('reason_key')] === 'work' && rb.messageAccepted === false && b.ledgerRow[6] === 'cancelled', JSON.stringify(rb));
  ok('2-2b 切り詰めていない（途中までも保存しない）', !b.cnRowsOut()[0].some((x) => /あ/.test(String(x))));
  const c100 = world(); const r100 = c100.run({ note: 'あ'.repeat(100), expect: 'free' });
  ok('2-3 100字ちょうどは保存', r100.messageAccepted === true && c100.cnRowsOut()[0][c100.col('note')].length === 100);
  const emo = world(); const re = emo.run({ note: '😀'.repeat(100), expect: 'free' });
  ok('2-4 ★絵文字100個は保存（コードポイントで数える）', re.messageAccepted === true && Array.from(emo.cnRowsOut()[0][emo.col('note')]).length === 100, JSON.stringify(re));
  const emo2 = world(); const re2 = emo2.run({ note: '😀'.repeat(101), expect: 'free' });
  ok('2-5 絵文字101個は捨てる', re2.noteDropped === 'too_long');
  for (const [v, want] of [['=SUM(A1)', "'=SUM(A1)"], ['+1', "'+1"], ['@x', "'@x"], ['-1', "'-1"]]) {
    const w = world(); w.run({ note: v, expect: 'free' });
    ok('2-6 ★数式にしない：' + v, w.cnRowsOut()[0][w.col('note')] === want, w.cnRowsOut()[0][w.col('note')]);
  }
  const t = world({ actor: 'trainer' }); const rt = t.run({ reason: 'work', note: MARK });
  ok('2-7 ★トレーナーが cxl を送っても保存しない（actor=trainer・noteDropped=not_customer）', rt.success && t.cnRowsOut()[0][t.col('reason_key')] === '' && t.cnRowsOut()[0][t.col('note')] === ''
     && t.cnRowsOut()[0][t.col('actor')] === 'trainer' && rt.noteDropped === 'not_customer' && rt.messageAccepted === false, JSON.stringify(rt));
  ok('2-7b トレーナーの文にも理由が載らない', !t.fetches.some((f) => /理由：|ひとこと：|ZQX/.test(f.text)));
  const ow = world({ actor: 'owner' }); const ro = ow.run({ reason: 'work', note: MARK });
  ok('2-8 オーナーが同じ入口で送っても保存しない', ro.success && ow.cnRowsOut()[0][ow.col('note')] === '' && ow.cnRowsOut()[0][ow.col('actor')] === 'owner' && ro.noteDropped === 'not_customer');
  const nl = world(); nl.run({ note: '  一\n\n二\r\n三\n四\n五  ', expect: 'free' });
  ok('2-9 改行は最大3行（4行目以降は1つの空白でつなぐ）・前後の空白を落とす', nl.cnRowsOut()[0][nl.col('note')] === '一\n二\n三 四 五', JSON.stringify(nl.cnRowsOut()[0][nl.col('note')]));
  const ws = world(); const rws = ws.run({ reason: '', note: '   \n  ', expect: 'free' });
  ok('2-10 空白だけのひとことは送らなかった扱い', rws.messageAccepted === false && rws.noteDropped === '' && ws.cnRowsOut()[0][ws.col('note_purged_at')] === '-');
  const ctl = world(); ctl.run({ note: 'a\u0000b\u202Ec\u200Bd', expect: 'free' });
  ok('2-11 制御文字・向きを変える文字を落とす', ctl.cnRowsOut()[0][ctl.col('note')] === 'abcd');
  const num = world(); const rnum = num.run({ reason: 5, note: { x: 1 }, expect: 'free' });
  ok('2-12 文字列でない値は捨てる（400 にしない）', rnum.success && num.cnRowsOut()[0][num.col('reason_key')] === '' && num.cnRowsOut()[0][num.col('note')] === '');
}

// ============================================================
console.log('=== 3. 同意した結果（cxlExpect）===');
{
  function noWrites(w) { return w.ledgerRow[6] === 'confirmed' && w.ledgerRow[8] === 'R1' && w.cnRowsOut().length === 0 && w.calls.deleted + w.calls.consumed + w.calls.credit === 0 && w.fetches.length === 0; }
  const a = world(); const ra = a.run({ note: MARK });
  ok('3-1 無し → 比べない（今どおり成立）', ra.success);
  const b = world(); const rb = b.run({ expect: '' });
  ok('3-2 空 → 比べない', rb.success);
  const c = world(); const rc = c.run({ expect: 'free' });
  ok('3-3 free＝判定 free → 成立', rc.success && c.ledgerRow[6] === 'cancelled');
  const d = world({ start: TODAY_18 }); const rd = d.run({ reason: 'work', note: MARK, expect: 'free' });
  ok('3-4 ★free と同意・判定は当日消化 → 何も書かず OUTCOME_CHANGED（freeCancel:false）', rd.success === false && rd.code === 'OUTCOME_CHANGED' && rd.freeCancel === false && noWrites(d), JSON.stringify({ rd, row: d.ledgerRow }));
  const e = world(); const re = e.run({ expect: 'consumed' });
  ok('3-5 consumed と同意・判定は無料 → 何も書かず OUTCOME_CHANGED（freeCancel:true）', re.code === 'OUTCOME_CHANGED' && re.freeCancel === true && noWrites(e));
  for (const bad of ['FREE', '1', 'x']) {
    const w = world(); const r = w.run({ reason: 'work', expect: bad });
    ok('3-6 ★知らない値（' + bad + '）→ 何も書かず BAD_EXPECTATION', r.success === false && r.code === 'BAD_EXPECTATION' && noWrites(w), JSON.stringify(r));
  }
  const f = world({ start: TODAY_18 }); const rf = f.run({ expect: 'consumed' });
  ok('3-7 consumed＝判定 consumed → 成立・振替権', rf.success && f.calls.credit === 1);
  const g = world({ start: TODAY_18, actor: 'owner' }); const rg = g.run(undefined, { ownerFree: true });
  ok('3-8 オーナーの無料の入口は cxlExpect を見ない（今どおり無料）', rg.success && rg.ownerFree === true);
}

// ============================================================
console.log('=== 4. ロックの中は最小（I-C7）===');
{
  const w = world({ ownerTid: 'T2' }); w.run({ reason: 'work', note: MARK, expect: 'free' });
  const iRel = w.trace.indexOf('release'), iLock = w.trace.indexOf('lock');
  const inLock = w.trace.slice(iLock + 1, iRel);
  ok('4-1 ★ロックの中は 台帳の読み書き・カレンダー・cancel_notes の1行だけ', inLock.every((x) => /^(read:line_reservations|write:line_reservations|cal|credit|append:cancel_notes)$/.test(x)), inLock.join(' '));
  const after = w.trace.slice(iRel + 1);
  ok('4-2 ★LINE の送信はすべてロックの後', w.trace.filter((x) => /^fetch:/.test(x)).length === 3 && w.trace.slice(0, iRel).every((x) => !/^fetch:/.test(x)), w.trace.join(' '));
  ok('4-3 ★担当の検索・トレーナーの LINE ID・会員の言語はロックの後', ['custtr', 'lang', 'trline:T1', 'trline:T2'].every((k) => after.indexOf(k) >= 0 && w.trace.slice(0, iRel).indexOf(k) < 0), w.trace.join(' '));
  ok('4-4 掃除（cancel_notes の読み）と記録もロックの後', w.trace.slice(0, iRel).filter((x) => x === 'read:cancel_notes').length === 1 /* 見出しの確認＝ロックの前 */
     && w.trace.indexOf('read:cancel_notes') < iLock && after.indexOf('read:cancel_notes') >= 0, w.trace.join(' '));
  ok('4-5 ロックは1回だけ取って放す', w.trace.filter((x) => x === 'lock').length === 1 && w.trace.filter((x) => x === 'release').length === 1);
}

// ============================================================
console.log('=== 5. 通知の中身と送り直しの ctx ===');
{
  const w = world(); w.run({ reason: 'work', note: MARK, expect: 'free' });
  const tr = w.fetches.find((f) => f.to === 'Utr1'), cu = w.fetches.find((f) => f.to === 'Ucust');
  ok('5-1 ★その枠のトレーナー宛に「理由：」「ひとこと：」', tr && tr.text === '【予約キャンセル】会員見本様\n日時：L\n（無料取消）\n理由：仕事・急な予定\nひとこと：' + MARK, tr && tr.text);
  const n = world(); n.run({ expect: 'free' });
  ok('5-2 ★理由が無いときは今と同じ文（1文字も足さない）', n.fetches.find((f) => f.to === 'Utr1').text === '【予約キャンセル】会員見本様\n日時：L\n（無料取消）');
  const nOld = world({ start: TODAY_18 }); nOld.run(undefined);
  ok('5-2b 当日消化も今と同じ文', nOld.fetches.find((f) => f.to === 'Utr1').text === '【予約キャンセル】会員見本様\n日時：L\n（当日消化）');
  ok('5-3 ★会員宛に「お伝えします」（ひとことを預かったとき）・ひとことの本文は無い', cu && /ひとことは担当トレーナーにお伝えします。$/.test(cu.text) && cu.text.indexOf('ZQX') < 0, cu && cu.text);
  const k = world(); k.run({ reason: 'work', expect: 'free' });
  ok('5-4 理由だけのときは会員宛に「お伝えします」を付けない', !/お伝えします/.test(k.fetches.find((f) => f.to === 'Ucust').text));
  ok('5-4b 会員宛の文は今どおり（取消＋無料）', k.fetches.find((f) => f.to === 'Ucust').text === 'ご予約を取り消しました。\n日時：Lja\n担当：担当T1\n（前日17時までのため無料です）');
  const en = world({ lang: 'en' }); en.run({ note: MARK, expect: 'free' });
  ok('5-5 会員宛は会員の言語', /We will pass your message on to your trainer\.$/.test(en.fetches.find((f) => f.to === 'Ucust').text));
  ok('5-6 トレーナー宛は日本語固定（会員が英語でも）', /理由：|ひとこと：/.test(en.fetches.find((f) => f.to === 'Utr1').text));

  //   契約上の担当（★送り直しの用途と ctx を見るため、全部 429 にして積まれた行を読む）
  const o2 = world({ ownerTid: 'T2', code: () => 429 }); const r2 = o2.run({ reason: 'work', note: MARK, expect: 'free' });
  const rows = o2.nq(), H = NQ_HEAD;
  const by = (to) => rows.filter((x) => x[H.indexOf('to')] === to);
  ok('5-7 ★担当が別 → 2通目（同じ用途 cancel_trainer）', by('Utr2').length === 1 && by('Utr2')[0][H.indexOf('purpose')] === 'cancel_trainer' && /^（担当のお客様です）\n【予約キャンセル】/.test(by('Utr2')[0][H.indexOf('text')]), JSON.stringify(rows.map((x) => x[H.indexOf('to')])));
  const ctxs = ['Utr1', 'Utr2', 'Ucust'].map((to) => (by(to)[0] || [])[H.indexOf('ctx_json')]);
  ok('5-8 ★3通とも同じ ctx（resId・customerId・startMs）＝送り直しの判定がそのまま効く', ctxs.every((c) => c === JSON.stringify({ resId: 'R1', customerId: 'C0001', startMs: NEXT_WEEK.getTime() })), JSON.stringify(ctxs));
  ok('5-9 ★429 で積まれた行は pending（10分後）', rows.length === 3 && rows.every((x) => x[H.indexOf('state')] === 'pending'), JSON.stringify(rows.map((x) => x[H.indexOf('state')])));
  ok('5-9b 成功の応答のまま', r2.success === true);
  ok('5-10 ★送り直しの本文にもひとことを含める（オーナー決定）', by('Utr1')[0][H.indexOf('text')].indexOf(MARK) >= 0 && by('Utr2')[0][H.indexOf('text')].indexOf(MARK) >= 0);
  const same = world({ ownerTid: 'T1' }); same.run({ reason: 'work', note: MARK, expect: 'free' });
  ok('5-11 担当がその枠のトレーナーと同じ → 送らない', same.fetches.length === 2 && !same.fetches.some((f) => f.to === 'Utr2'));
  const noOwn = world({ ownerTid: '' }); noOwn.run({ reason: 'work', note: MARK, expect: 'free' });
  ok('5-12 担当なし（または読めない＝空）→ 送らない', noOwn.fetches.length === 2);
  const noLine = world({ ownerTid: 'T9' }); noLine.run({ reason: 'work', note: MARK, expect: 'free' });
  ok('5-13 担当に LINE が無い → 送らない', noLine.fetches.length === 2);
  const thr = world({ ownerTid: 'T2', custTrThrows: true }); const rthr = thr.run({ reason: 'work', note: MARK, expect: 'free' });
  ok('5-14 ★担当の検索が例外 → 推測せず送らない・会員には送る・成功', rthr.success && !thr.fetches.some((f) => f.to === 'Utr2') && thr.fetches.some((f) => f.to === 'Ucust'));
  const plain = world({ ownerTid: 'T2' }); plain.run({ reason: '', note: '', expect: 'free' });
  ok('5-15 ★理由もひとことも無いキャンセルでは担当への2通目を送らない（通知を増やさない）', plain.fetches.length === 2 && !plain.trace.includes('custtr'));
  const trc = world({ ownerTid: 'T2', actor: 'trainer' }); trc.run({ reason: 'work', note: MARK });
  ok('5-16 トレーナーの操作では担当への2通目を送らない', !trc.fetches.some((f) => f.to === 'Utr2'));
  const marked = world({ ownerTid: 'T2' }); marked.run({ reason: 'work', expect: 'free' });
  ok('5-17 cancel_notes の notified：担当にも送ったら slot+owner_trainer', marked.cnRowsOut()[0][marked.col('notified')] === 'slot+owner_trainer', marked.cnRowsOut()[0][marked.col('notified')]);
  ok('5-17b 担当に送らなければ slot のまま', same.cnRowsOut()[0][same.col('notified')] === 'slot');
}

// ============================================================
console.log('=== 6. 時間の予算（改訂2-1・3-1〜3-3）===');
{
  //   全部 429：その場で粘らない（noInlineRetry）＝1宛先1回
  const a = world({ ownerTid: 'T2', code: () => 429 }); const ra = a.run({ reason: 'work', note: MARK, expect: 'free' });
  ok('6-1 ★3宛先すべて429でも粘らない（送信は3回だけ）・成功', ra.success && a.fetches.length === 3, String(a.fetches.length));
  ok('6-2 ★応答まで20秒以内（身代わりの時計）', a.clock.now - NOW < 20000, String(a.clock.now - NOW));
  //   受付の時点で12秒を過ぎていた → その枠のトレーナーは送る・残りは積む
  const b = world({ ownerTid: 'T2' });
  b.ctx._lbCxlAfter({ resId: 'R1', customerId: 'C0001', customerLineId: 'Ucust', customerName: '会員見本', slotTrainerId: 'T1', trainer: { id: 'T1', name: '担当T1' },
    start: NEXT_WEEK, rawStart: NEXT_WEEK, free: true, ownerApplied: false, actor: 'customer', key: 'work', note: MARK, saved: true, dropped: '', cnOk: true, cnWhy: '' }, NOW - 13000);
  const H = NQ_HEAD;
  ok('6-3 ★受付から12秒超：その枠のトレーナーには送る（積むと開始を過ぎて永久に届かない）', b.fetches.length === 1 && b.fetches[0].to === 'Utr1', JSON.stringify(b.fetches.map((f) => f.to)));
  ok('6-4 ★担当と会員は送らずに積む（DEFERRED・pending・attempts 0）', b.nq().length === 2 && b.nq().every((x) => x[H.indexOf('last_code')] === 'DEFERRED' && x[H.indexOf('state')] === 'pending' && x[H.indexOf('attempts')] === 0
     && x[H.indexOf('next_at')] === b.clock.now + 600000), JSON.stringify(b.nq().map((x) => [x[H.indexOf('to')], x[H.indexOf('state')], x[H.indexOf('last_code')]])));
  ok('6-4b 記録に遅れの印（CXL_NOTIFY_SLOW・本文なし）', b.metrics.some((m) => m.oc === 'CXL_NOTIFY_SLOW' && /deferred=2/.test(m.detail) && m.detail.indexOf('ZQX') < 0));
  //   1通目（その枠）が429で遅い → 通知の4秒を超える → 残り2通は積む＝合計3行・宛先ごとに1行だけ
  const c = world({ ownerTid: 'T2', code: (to) => (to === 'Utr1' ? 429 : 200), latency: (to) => (to === 'Utr1' ? 5000 : 0) });
  const rc = c.run({ reason: 'work', note: MARK, expect: 'free' });
  const tos = c.nq().map((x) => x[H.indexOf('to')]).sort();
  ok('6-5 ★1通目が429・時間超過 → 残り2通は積む：notify_retry に3行・宛先ごとに1行', rc.success && JSON.stringify(tos) === JSON.stringify(['Ucust', 'Utr1', 'Utr2']) && c.fetches.length === 1, JSON.stringify({ tos, f: c.fetches.length }));
  ok('6-5b 1通目は失敗として積まれ（429・pending）、残りは DEFERRED', c.nq().find((x) => x[H.indexOf('to')] === 'Utr1')[H.indexOf('last_code')] === '429'
     && c.nq().filter((x) => x[H.indexOf('last_code')] === 'DEFERRED').length === 2);
  //   _lbNqDefer の中で appendRow が落ちても応答は成功・非常用の記録が1件
  const d = world({ ownerTid: 'T2', nqAppendThrows: true, latency: (to) => (to === 'Utr1' ? 5000 : 0) });
  const rd = d.run({ reason: 'work', note: MARK, expect: 'free' });
  ok('6-6 ★積めなくても success:true・非常用の記録（Script Properties）', rd.success === true && /^2\|/.test(d.props.get('LB_NOTIFY_QUEUE_WRITE_FAIL') || ''), d.props.get('LB_NOTIFY_QUEUE_WRITE_FAIL'));
  //   _lbPush の他の呼び出し元は今どおり429で粘る
  const e = world({ code: () => 429 });
  e.ctx._lbPush('Ux', 'x', 'booking_customer', { resId: 'R9', customerId: 'C9', startMs: NEXT_WEEK.getTime() });
  ok('6-7 ★_lbPush の他の呼び出し元（opts なし）は今どおり粘る（4回送る）', e.fetches.length === 4, String(e.fetches.length));
  //   _lbNqDefer は宛先が無ければ積まない・例外を外へ投げない
  ok('6-8 宛先が無ければ積まない', e.ctx._lbNqDefer('', 'x', 'cancel_customer', {}) === false);
  //   ctx が揃わない積みは alert（送り直さずオーナーへ）
  const f = world(); f.ctx._lbNqDefer('Ux', 'x', 'cancel_trainer', { resId: 'R1' });
  ok('6-9 ctx が揃わなければ alert', f.nq()[0][H.indexOf('state')] === 'alert');
}

// ============================================================
console.log('=== 7. 成立後の付け足しは単位ごとに独立（改訂4-1）===');
{
  const leak = (w) => w.logs.concat(w.metrics.map((m) => m.detail)).filter((s) => /ZQX|会員見本|C0001|Ucust|Utr1/.test(s));
  const a = world({ ownerTid: 'T2', slotLineThrows: true }); const ra = a.run({ reason: 'work', note: MARK, expect: 'free' });
  ok('7-1 ★その枠のトレーナー通知の単位が例外 → 担当・会員の通知へ進み success:true', ra.success && a.fetches.some((f) => f.to === 'Utr2') && a.fetches.some((f) => f.to === 'Ucust'), JSON.stringify(a.fetches.map((f) => f.to)));
  const b = world({ ownerTid: 'T2', custTrThrows: true }); const rb = b.run({ reason: 'work', note: MARK, expect: 'free' });
  ok('7-2 ★担当の検索が例外 → success:true・会員への通知は試みる', rb.success && b.fetches.some((f) => f.to === 'Ucust'));
  const c = world({ langThrows: true }); const rc = c.run({ note: MARK, expect: 'free' });
  ok('7-3 ★会員の言語が例外 → success:true（その枠のトレーナーには届いている）', rc.success && c.fetches.some((f) => f.to === 'Utr1'));
  const d = world({ cnRows: [CN_HEAD.slice()] });
  d.sheets.get('cancel_notes').getRange = ((orig) => function (r, cc, nr, nc) { const g = orig.call(this, r, cc, nr, nc); if (r === 2) { g.getValues = () => { throw new Error('C0001 会員見本'); }; } return g; })(d.sheets.get('cancel_notes').getRange);
  const rd = d.run({ note: MARK, expect: 'free' });
  ok('7-4 ★掃除の読み取りが例外 → success:true', rd.success === true && rd.recordSaved === true, JSON.stringify(rd));
  const e = world({ metricsThrows: true }); const re = e.run({ reason: 'hack', note: MARK, expect: 'free' });
  ok('7-5 ★記録（booking_metrics）が例外 → success:true', re.success === true);
  ok('7-6 ★例外のログに理由・ひとこと・氏名・ID が出ない（単位の名前と種類だけ）', [a, b, c, d, e].every((w) => leak(w).length === 0) && a.logs.some((l) => /成立後の付け足しで例外（slot）: Error/.test(l)),
     JSON.stringify([a, b, c, d, e].map(leak)));
}

// ============================================================
console.log('=== 8. cancel_notes の見出し・保存の失敗（I-C9・改訂2-5）===');
{
  const H2 = CN_HEAD.slice(); H2[10] = 'memo';
  const H3 = CN_HEAD.slice(); [H3[9], H3[10]] = [H3[10], H3[9]];
  const cases = [
    ['シートが無い', { cnSheet: false }],
    ['列が1つ違う', { cnRows: [H2] }],
    ['順番が違う', { cnRows: [H3] }],
    ['列が1つ多い', { cnRows: [CN_HEAD.concat(['x'])] }],
    ['列が1つ少ない', { cnRows: [CN_HEAD.slice(0, -1)] }],
  ];
  for (const [label, opt] of cases) {
    const w = world(opt); const r = w.run({ reason: 'work', note: MARK, expect: 'free' });
    ok('8-1 ★' + label + ' → 行を書かずキャンセルは成功・header_mismatch', r.success && w.ledgerRow[6] === 'cancelled' && (w.cn() ? w.cnRowsOut().length === 0 : true)
       && r.recordSaved === false && r.messageAccepted === false && r.noteDropped === 'header_mismatch', JSON.stringify(r));
    ok('8-2 ' + label + '：記録 CXL_NOTE_HEADER・トレーナー宛に理由を載せない・会員に「お伝えします」と言わない', w.metrics.some((m) => m.oc === 'CXL_NOTE_HEADER')
       && !w.fetches.some((f) => /理由：|ひとこと：|お伝えします/.test(f.text)));
  }
  const s = world({ start: TODAY_18, cnAppendThrows: true });
  let rs; try { rs = s.run({ reason: 'work', note: MARK, expect: 'consumed' }); } catch (e) { rs = { threw: String(e) }; }
  ok('8-3 ★台帳を書いた後に appendRow が落ちても success:true・recordSaved:false・save_failed', rs.success === true && rs.recordSaved === false && rs.noteDropped === 'save_failed', JSON.stringify(rs));
  ok('8-4 ★そのとき台帳の値は変わらない・振替権は付く', s.ledgerRow[6] === 'consumed' && s.ledgerRow[8] === 'R1|当日消化取消' && s.calls.credit === 1);
  ok('8-5 記録 CXL_NOTE_SAVE_FAIL（本文なし）', s.metrics.some((m) => m.oc === 'CXL_NOTE_SAVE_FAIL' && m.detail.indexOf('ZQX') < 0));
  const n = world({ cnSheet: false }); const rn = n.run({ expect: 'free' });
  ok('8-6 何も入れていなければ noteDropped は空（画面は今どおり）', rn.success && rn.noteDropped === '' && rn.recordSaved === false);
  ok('8-7 ★キャンセルの経路ではシートを作らない', !n.sheets.has('cancel_notes'));
  const st = world({ cnSheet: false });
  ok('8-8 setupCancelNotesSheet が見出しを書く→以後は書ける', st.ctx.setupCancelNotesSheet() === 'created' && JSON.stringify(st.sheets.get('cancel_notes').data[0]) === JSON.stringify(CN_HEAD));
  const mm = world({ cnRows: [H2, ['R0', 1]] });
  ok('8-9 ★行があるのに見出しが違えば書き換えない', mm.ctx.setupCancelNotesSheet() === 'mismatch' && mm.sheets.get('cancel_notes').data[0][10] === 'memo');
}

// ============================================================
console.log('=== 9. 掃除・日次点検・作業依頼の件数 ===');
{
  const row = (id, at, note, extra = {}) => { const r = new Array(14).fill(''); r[0] = id; r[1] = at; r[2] = at + DAY; r[3] = 'T1'; r[4] = 'C' + id; r[5] = 'customer'; r[6] = 'free'; r[7] = false; r[8] = 'work';
    r[10] = note; r[11] = note ? '' : '-'; r[12] = 'slot'; Object.assign(r, extra); return r; };
  //   1年と1日前・ひとことあり／期限内／2年と1日前／729日／ひとこと無し
  const rows = [CN_HEAD.slice(), row('A', NOW - 366 * DAY, MARK), row('B', NOW - 364 * DAY, MARK), row('C', NOW - 731 * DAY, MARK), row('D', NOW - 729 * DAY, ''), row('E', NOW - 400 * DAY, '')];
  const w = world({ cnRows: rows });
  const sh = w.sheets.get('cancel_notes');
  const res = w.ctx._lbCnMaintain(sh, NOW, null);
  const D = sh.data;
  ok('9-1 ★1年と1日前の行のひとことが空になる・空にした時刻', D[1][10] === '' && D[1][11] === NOW, JSON.stringify(D[1]));
  ok('9-2 ★行は消えない（行の数がそのまま）', D.length === rows.length);
  ok('9-3 期限内（364日）は触らない', D[2][10] === MARK && D[2][11] === '');
  ok('9-4 ★2年と1日前：識別子（res_id・customer_id・trainer_id）が空・ids_purged_at・ひとことも同じ書き込みで空', D[3][0] === '' && D[3][3] === '' && D[3][4] === '' && D[3][13] === NOW && D[3][10] === '' && D[3][11] === NOW, JSON.stringify(D[3]));
  ok('9-5 729日の行の識別子は残る（ひとことは無い行）', D[4][0] === 'D' && D[4][4] === 'CD' && D[4][13] === '');
  ok('9-5b 400日・ひとこと無しの行は書かない', D[5][11] === '-' && D[5][13] === '');
  ok('9-6 残るのは時刻・actor・outcome・transfer・reason_key（誰のものか分からない）', D[3][1] === NOW - 731 * DAY && D[3][5] === 'customer' && D[3][8] === 'work');
  ok('9-7 ★書き込みは対象の行ごとに1回（A と C の2回）', sh.writes === 2 && res.note === 2 && res.ids === 1, JSON.stringify({ writes: sh.writes, res }));
  //   21行目以降・100行目にあっても消える／一度に20件まで
  const many = [CN_HEAD.slice()];
  for (let i = 0; i < 120; i++) many.push(row('R' + i, NOW - (i < 99 ? 10 : 400 + i) * DAY, MARK));
  const m = world({ cnRows: many }); const msh = m.sheets.get('cancel_notes');
  m.ctx._lbCnMaintain(msh, NOW, null);
  const purged = msh.data.slice(1).filter((r) => r[10] === '').length;
  ok('9-8 ★100行目以降の期限切れも消える（先頭20行だけ見る方式ではない）', msh.data[100][10] === '' || msh.data[120][10] === '', String(purged));
  ok('9-9 ★一度に20件まで（古い順＝期限切れ21行のうち最も新しい1行が残る）', purged === 20 && msh.data[120][10] === '' && msh.data[101][10] === '' && msh.data[100][10] === MARK, String(purged));
  ok('9-10 期限内の行は触らない', msh.data.slice(1, 100).every((r) => r[10] === MARK));
  //   行が動いていたら書かない（res_id で確かめる）
  const mv = world({ cnRows: [CN_HEAD.slice(), row('A', NOW - 366 * DAY, MARK)] }); const mvsh = mv.sheets.get('cancel_notes');
  const orig = mvsh.getRange.bind(mvsh);
  mvsh.getRange = (r, c, nr, nc) => { const g = orig(r, c, nr, nc); if (r === 2 && c === 1 && nc === 14) { const gv = g.getValues; g.getValues = () => { const v = gv(); v[0][0] = 'Z'; return v; }; } return g; };
  mv.ctx._lbCnMaintain(mvsh, NOW, null);
  ok('9-11 ★書く位置の res_id が違えば書かない', mvsh.data[1][10] === MARK && mvsh.writes === 0);
  //   キャンセルの経路から掃除が走る（ロックの外）
  const via = world({ cnRows: [CN_HEAD.slice(), row('A', NOW - 366 * DAY, MARK)] }); via.run({ expect: 'free' });
  ok('9-12 キャンセルのたびに掃除が走る', via.sheets.get('cancel_notes').data[1][10] === '');

  //   日次点検：note 列を読まない・日数だけ
  const h = world({ cnRows: rows.map((r) => r.slice()) }); const hsh = h.sheets.get('cancel_notes'); hsh.reads.length = 0;
  const hr = h.ctx._lbCnHealth(NOW);
  const noteCol = CN_HEAD.indexOf('note') + 1;
  const dataReads = (sh0) => sh0.reads.filter((x) => x.r >= 2);   // 1行目は見出しの確認（中身ではない）
  ok('9-13 ★日次点検は note 列を読まない（cancelled_at と note_purged_at だけ）', dataReads(hsh).every((x) => x.c > noteCol || x.c + x.nc - 1 < noteCol) && dataReads(hsh).length === 2, JSON.stringify(hsh.reads));
  ok('9-14 日次点検：ひとことが残る最も古い行の日数（731日）・悪化の閾値は400日', hr.oldestNoteDays === 731 && hr.ready === true && /HEALTH_DAYS: 400/.test(LB), JSON.stringify(hr));
  ok('9-15 日次点検の結果に本文が無い', JSON.stringify(hr).indexOf('ZQX') < 0);

  //   作業依頼の件数：note 列を読まない・件数だけ
  const j = world({ cnRows: rows.concat([row('BAD', 'x', MARK), row('F', NOW - DAY, MARK, { 5: '<b>' + MARK + '</b>', 6: MARK, 8: MARK })]) });
  const jsh = j.sheets.get('cancel_notes'); jsh.reads.length = 0;
  const txt = j.ctx.cancelNotesCountText();
  ok('9-16 ★作業依頼の件数は note 列も ID の列も読まない', dataReads(jsh).length > 0 && dataReads(jsh).every((x) => ![1, 4, 5, noteCol].some((cc) => cc >= x.c && cc <= x.c + x.nc - 1)), JSON.stringify(jsh.reads.filter((x) => x.r === 2)));
  ok('9-17 ★結果のどこにもひとこと（目印）・ID・壊れたセルの値が出ない', txt.indexOf('ZQX') < 0 && !/C[A-F]\b|<b>/.test(txt), txt);
  ok('9-18 件数が出る（行・理由・判定・ひとことが残っている行）', /行 7/.test(txt) && /work/.test(txt) && /ひとことが残っている行 \d+/.test(txt) && /時刻が読めない行 1/.test(txt), txt);
  const srcCount = pluck(LB, 'cancelNotesCountText');
  ok('9-19 ★関数のソースに note 列の名前・番号が出てこない（読む列は COUNT_COLS だけ）', !/'note'|"note"|getRange\(2, 11|\b11\b/.test(srcCount) && /LB_CN\.COUNT_COLS/.test(srcCount));
  const cc = vm.runInNewContext('(' + pluckVar(LB, /^var LB_CN = (\{[\s\S]*?\n\});/m).replace(/^var LB_CN = /, '').replace(/;$/, '') + ')').COUNT_COLS;
  ok('9-20 ★COUNT_COLS に note・res_id・customer_id・trainer_id が無い', !cc.some((x) => ['note', 'res_id', 'customer_id', 'trainer_id'].includes(x)), JSON.stringify(cc));
  ok('9-21 窓口：remaining の cancelNotes が _ejScrub を通る', /args\.cancelNotes\) return _ejScrub\(cancelNotesCountText\(\)\)/.test(JOB));
  const un = world({ cnSheet: false });
  ok('9-22 シートが無いときは使えないと答える（件数を作らない）', /使えません（no_sheet）/.test(un.ctx.cancelNotesCountText()));
}

// ============================================================
console.log('=== 10. 備考を鍵として読む場所が今どおり・送り直しの本文を30日で空に ===');
{
  const w = world({ start: TODAY_18 }); w.run({ reason: 'condition', note: MARK, expect: 'consumed' });
  ok('10-1 ★送り直し：_lbNqFindResv が理由つきの取消の行を見つける', w.ctx._lbNqFindResv([w.ledgerRow], 'R1').length === 1);
  ok('10-2 ★送り直しの判定（I17）：取消の通知は送ってよい', w.ctx._lbNqValidate('cancel_trainer', { resId: 'R1', customerId: 'C0001', startMs: TODAY_18.getTime() }, [w.ledgerRow], NOW).ok === true);
  ok('10-3 ★当日キャンセルの訂正（設計24）が直せる＝判定 OK', w.ctx._lbSdcVerdict(w.ledgerRow, NOW, () => false) === 'OK');
  ok('10-4 ★声かけの振替の判定（_lbNudgeResId）が予約IDを読む', w.ctx._lbNudgeResId(w.ledgerRow[8]) === 'R1');
  ok('10-5 備考の resId 部分（_lbResIdOfNote）', w.ctx._lbResIdOfNote(w.ledgerRow[8]) === 'R1');
  //   trainer_reason（第2段の鍵）は判定・消化・振替権に使わない（I-C10）
  for (const tr of ['trainer_convenience', 'customer_proxy', 'x']) {
    const t = world({ start: TODAY_18, actor: 'trainer' }); const r = t.run({ trainerReason: tr });
    ok('10-6 ★trainer_reason=' + tr + ' でも当日消化・振替権・備考は同じ', r.penalty === true && t.ledgerRow[6] === 'consumed' && t.ledgerRow[8] === 'R1|当日消化取消' && t.calls.credit === 1
       && t.cnRowsOut()[0][t.col('outcome')] === 'consumed' && t.cnRowsOut()[0][t.col('trainer_reason')] === (tr === 'x' ? '' : tr));
  }
  const cu = world(); cu.run({ trainerReason: 'trainer_convenience', expect: 'free' });
  ok('10-7 会員から来た trainer_reason は捨てる', cu.cnRowsOut()[0][cu.col('trainer_reason')] === '');

  //   送り直しの列：終わった行の本文を30日で空にする（lbNotifyRetryTick の取り分けに相乗り）
  const H = NQ_HEAD;
  const mk = (id, st, ageDays, extra = {}) => { const r = new Array(H.length).fill(''); r[H.indexOf('id')] = id; r[H.indexOf('created_at')] = NOW - ageDays * DAY; r[H.indexOf('state')] = st;
    r[H.indexOf('text')] = '本文 会員見本 様 ' + MARK; r[H.indexOf('purpose')] = 'cancel_trainer'; r[H.indexOf('ctx_json')] = '{}'; Object.assign(r, extra); return r; };
  const q = world();
  const qs = q.sheets.get('notify_retry');
  qs.data.push(mk('a', 'sent', 31), mk('b', 'sent', 29), mk('c', 'stale', 40), mk('d', 'closed', 40, { [H.indexOf('alerted_at')]: NOW - 10 * DAY }), mk('e', 'closed', 40, { [H.indexOf('alerted_at')]: NOW - 31 * DAY }), mk('f', 'alert', 60));
  for (let i = 0; i < 60; i++) qs.data.push(mk('z' + i, 'sent', 90));
  const out = q.ctx.lbNotifyRetryTick();
  const tx = (id) => qs.data.find((r) => r[0] === id)[H.indexOf('text')];
  ok('10-8 ★31日前に送れた行の本文は空', tx('a') === '');
  ok('10-9 29日前の行は残す', tx('b') !== '');
  ok('10-10 stale も空・closed はオーナーに知らせた時刻から30日', tx('c') === '' && tx('d') !== '' && tx('e') === '');
  ok('10-11 ★終わっていない行（alert）は空にしない（オーナーへのメールに要る）', tx('f') !== '');
  ok('10-12 ★1回で50行まで・行は消えない', out.purged === 50 && qs.data.length === 1 + 6 + 60, JSON.stringify(out));
}

// ============================================================
console.log('=== 11. ひとことの整え方が画面と同じ・ログ・配線 ===');
{
  const liffNorm = (HTML.match(/  function _cxlNorm\(s\)\{[\s\S]*?\n  \}/) || [])[0];
  ok('11-0 画面の _cxlNorm を取り出せる', !!liffNorm);
  const lctx = { String, Array }; vm.createContext(lctx); vm.runInContext(liffNorm, lctx);
  const g = world();
  const POOL = ['あ', 'a', ' ', '\n', '\r\n', '\r', '\t', '😀', '\u0000', '\u202E', '\u200B', '\uFEFF', '　', '=', '-', '\u3000'];
  let same = 0, seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 500; i++) {
    let s = ''; const L = Math.floor(rnd() * 40); for (let k = 0; k < L; k++) s += POOL[Math.floor(rnd() * POOL.length)];
    if (g.ctx._lbCxlNormText(s) === lctx._cxlNorm(s)) same++;
  }
  ok('11-1 ★ランダム500通りで GAS と画面の整え方が一致（数え方が食い違わない）', same === 500, String(same));
  ok('11-2 ★画面と GAS の上限・鍵が同じ', /var CXL_NOTE_MAX = 100;/.test(HTML) && /var LB_CXL_NOTE_MAX = 100;/.test(LB)
     && /var CXL_KEYS = \['work', 'family', 'condition', 'other'\];/.test(HTML) && /var LB_CXL_KEYS = \{ work: '[^']+', family: '[^']+', condition: '[^']+', other: '[^']+' \};/.test(LB));
  const w = world({ ownerTid: 'T2', code: () => 429 }); w.run({ reason: 'work', note: MARK, expect: 'free' });
  ok('11-3 ★ログ（Logger）にひとことの本文が1回も出ない', w.logs.every((l) => l.indexOf('ZQX') < 0), w.logs.filter((l) => l.indexOf('ZQX') >= 0).join(' | '));
  ok('11-4 記録（booking_metrics）にも出ない', w.metrics.every((m) => m.detail.indexOf('ZQX') < 0));
  ok('11-5 ★入口：普通の取消は cxl（理由・ひとこと・同意）を渡す・オーナーの無料の入口は渡さない',
     /case 'line_cancelReservation':\s*return cancelReservationLine\(lineUserId, params\.reservationId, \{ cxl: \{ reason: params\.cxlReason, note: params\.cxlNote, expect: params\.cxlExpect \} \}\);/.test(LB)
     && /case 'line_ownerFreeCancel':\s*return cancelReservationLine\(lineUserId, params\.reservationId, \{ ownerFree: true \}\);/.test(LB));
  ok('11-6 ★handleLineGet は action 名しかログに出さない（本文を出さない）', /Logger\.log\('\[perf\] verifyLineIdToken: ' \+ \(new Date\(\)\.getTime\(\) - _tv\) \+ 'ms \(' \+ action \+ '\)'\);/.test(LB));
  ok('11-7 ★cancel_notes からカルテへ写す処理が無い（I-C3）', !/cancel_notes[\s\S]{0,200}karte|karte[\s\S]{0,200}cancel_notes/.test(LB.replace(/\/\/[^\n]*/g, '')));
  ok('11-8 ★判定の関数は1文字も変えていない', /function _lbIsFreeCancelWindow\(start\) \{\n  var deadline = new Date\(start\.getFullYear\(\), start\.getMonth\(\), start\.getDate\(\) - 1, 17, 0, 0\);\n  return new Date\(\)\.getTime\(\) < deadline\.getTime\(\);\n\}/.test(LB));
  const INVIS = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;
  ok('11-10 ★ソースに見えない文字・向きを変える文字をそのまま書いていない（エスケープで書く）', !INVIS.test(LB) && !INVIS.test(HTML));
  ok('11-9 点検が cancel_notes を見る・実測ログで CXL_ を予約の成否と別に数える', /_step\('キャンセル理由'\)/.test(LB) && /add\('cancel_notes_unready'/.test(LB) && /if \(oc\.indexOf\('CXL_'\) === 0\) \{ cxl\[oc\]/.test(LB));
}

console.log('=== 13. 関門②の指摘（2026-11-06）===');
{
  //   高1：ロックの中で trainer_master・名簿を読まない（オーナーの無料取消の認可はロックの前に名簿を1回だけ読む）
  for (const [label, wo, cxl, extra] of [['会員', {}, { reason: 'work', note: MARK, expect: 'free' }, undefined],
                                         ['トレーナー', { actor: 'trainer' }, undefined, undefined],
                                         ['オーナー無料', { actor: 'owner', start: TODAY_18 }, undefined, { ownerFree: true }]]) {
    const w = world(wo); const r = w.run(cxl, extra);
    const iLock = w.trace.indexOf('lock'), iRel = w.trace.indexOf('release');
    const inLock = w.trace.slice(iLock + 1, iRel);
    ok('13-1 ★' + label + '：ロックの中で trainer_master と名簿を読まない', r.success && inLock.indexOf('trbyline') < 0 && inLock.indexOf('read:customer_line_map') < 0, inLock.join(' '));
  }
  {
    const w = world({ actor: 'owner', start: TODAY_18 }); w.run(undefined, { ownerFree: true });
    const iLock = w.trace.indexOf('lock');
    ok('13-1b オーナー無料：名簿はロックの前に1回だけ読む', w.trace.filter((x) => x === 'read:customer_line_map').length === 1 && w.trace.indexOf('read:customer_line_map') < iLock, w.trace.join(' '));
    const n = world({ start: TODAY_18 }); n.run({ expect: 'consumed' });
    ok('13-1c 会員の取消では名簿を読まない（無料取消のときだけ）', n.trace.indexOf('read:customer_line_map') < 0);
  }
  //   名簿に無い・読めない顧客はオーナーでも無料取消できない（本物の _lbTrainerMaySeeCustomer で）
  for (const [label, mapRows] of [['名簿に無い', [['C9999', 'T1']]], ['名簿が読めない', null]]) {
    const w = world({ actor: 'owner', start: TODAY_18, mapRows });
    vm.runInContext(pluck(LB, '_lbTrainerMaySeeCustomer'), w.ctx);
    const r = w.run(undefined, { ownerFree: true });
    ok('13-2 ★' + label + ' → FORBIDDEN・台帳は触らない', r.success === false && r.code === 'FORBIDDEN' && w.ledgerRow[6] === 'confirmed', JSON.stringify(r));
  }
  {
    const w = world({ actor: 'owner', start: TODAY_18 });
    vm.runInContext(pluck(LB, '_lbTrainerMaySeeCustomer'), w.ctx);
    const r = w.run(undefined, { ownerFree: true });
    ok('13-2b 名簿に在る → 無料取消は成立', r.success === true && r.ownerFree === true && w.ledgerRow[6] === 'cancelled', JSON.stringify(r));
  }
  //   高2：ひとことを誰にも送っていないのに「伝えた」と言わない
  {
    const w = world({ lineOf: { T1: '' } }); const r = w.run({ reason: 'work', note: MARK, expect: 'free' });
    ok('13-3 ★その枠のトレーナーに LINE が無く担当も同じ → messageAccepted=false', r.success && r.recordSaved === true && r.messageAccepted === false, JSON.stringify(r));
    const cust = w.fetches.find((f) => f.to === 'Ucust');
    ok('13-3b ★会員宛に「お伝えしました」を付けない', !!cust && cust.text.indexOf(w.ctx._lbSt('ja', 'push_cancel_note_relayed')) < 0, cust && cust.text);
    ok('13-3c notified は none', w.cnRowsOut()[0][w.col('notified')] === 'none', w.cnRowsOut()[0][w.col('notified')]);
  }
  {
    const w = world({ lineOf: { T1: '' }, ownerTid: 'T2' }); const r = w.run({ reason: 'work', note: MARK, expect: 'free' });
    ok('13-4 その枠に LINE が無くても担当へ送れば messageAccepted=true', r.messageAccepted === true && w.fetches.some((f) => f.to === 'Utr2'), JSON.stringify(r));
    const cust = w.fetches.find((f) => f.to === 'Ucust');
    ok('13-4b 会員宛に「お伝えしました」が付く', !!cust && cust.text.indexOf(w.ctx._lbSt('ja', 'push_cancel_note_relayed')) >= 0);
  }
  {
    const w = world({ noTrainer: true, ownerTid: '' }); const r = w.run({ reason: 'work', note: MARK, expect: 'free' });
    ok('13-5 その枠のトレーナーが分からず担当もいない → messageAccepted=false', r.success && r.messageAccepted === false, JSON.stringify(r));
  }
  {
    const w = world({ slotLineThrows: true }); const r = w.run({ reason: 'work', note: MARK, expect: 'free' });
    ok('13-6 その枠の単位が例外 → messageAccepted=false・キャンセルは成功', r.success && r.messageAccepted === false, JSON.stringify(r));
  }
  //   中3：時間予算を超えても notified は実際の結果に直す
  {
    //   通常の経路で none になることは 13-3c。ここでは受付から13秒後に後処理が走った場合
    const v = world({ lineOf: { T1: '' } });
    v.sheets.get('cancel_notes').data.push(v.ctx._lbCnRow({ resId: 'R1', cancelledAt: NOW, startAt: NEXT_WEEK.getTime(), trainerId: 'T1', customerId: 'C0001', actor: 'customer',
      outcome: 'free', transfer: false, reasonKey: 'work', trainerReason: '', note: MARK, notified: 'slot' }));
    v.ctx._lbCxlAfter({ resId: 'R1', customerId: 'C0001', customerLineId: 'Ucust', customerName: '会員見本', slotTrainerId: 'T1', trainer: { id: 'T1', name: '担当T1' },
      start: NEXT_WEEK, rawStart: NEXT_WEEK, free: true, ownerApplied: false, actor: 'customer', key: 'work', note: MARK, saved: true, dropped: '', cnOk: true, cnWhy: '' }, NOW - 13000);
    ok('13-7 ★受付から12秒超でも notified を実際の結果（none）に直す', v.cnRowsOut()[0][v.col('notified')] === 'none', v.cnRowsOut()[0][v.col('notified')]);
    const b = world({ ownerTid: 'T2' });
    b.sheets.get('cancel_notes').data.push(b.ctx._lbCnRow({ resId: 'R1', cancelledAt: NOW, startAt: NEXT_WEEK.getTime(), trainerId: 'T1', customerId: 'C0001', actor: 'customer',
      outcome: 'free', transfer: false, reasonKey: 'work', trainerReason: '', note: MARK, notified: 'slot' }));
    b.ctx._lbCxlAfter({ resId: 'R1', customerId: 'C0001', customerLineId: 'Ucust', customerName: '会員見本', slotTrainerId: 'T1', trainer: { id: 'T1', name: '担当T1' },
      start: NEXT_WEEK, rawStart: NEXT_WEEK, free: true, ownerApplied: false, actor: 'customer', key: 'work', note: MARK, saved: true, dropped: '', cnOk: true, cnWhy: '' }, NOW - 13000);
    ok('13-7b ★受付から12秒超で担当を積んだ → slot+owner_trainer に直す', b.cnRowsOut()[0][b.col('notified')] === 'slot+owner_trainer', b.cnRowsOut()[0][b.col('notified')]);
    ok('13-7c 掃除（保存期間）は12秒超なら走らない＝notified の訂正だけ', b.cnRowsOut()[0][b.col('note')] === MARK);
  }
  //   名簿の写しは元の _lbCustOwnerOf と同じ答え（同じ顧客が2行なら最初の行・空の担当は ''・無い顧客は null）
  {
    const w = world({ mapRows: [['C0001', 'T1'], ['C0001', 'T2'], ['C0002', ''], ['', 'T9']] });
    vm.runInContext(pluck(LB, '_lbCustOwnerOf'), w.ctx);
    const m = w.ctx._lbCustOwnerMap();
    const same = ['C0001', 'C0002', 'C0003', ''].every((c) => w.ctx._lbCustOwnerFromMap(m, c) === w.ctx._lbCustOwnerOf(c));
    ok('13-8 ★名簿の写しの答えが _lbCustOwnerOf と一致（重複は最初の行）', same && w.ctx._lbCustOwnerFromMap(m, 'C0001') === 'T1' && w.ctx._lbCustOwnerFromMap(null, 'C0001') === null,
       JSON.stringify(['C0001', 'C0002', 'C0003', ''].map((c) => [w.ctx._lbCustOwnerFromMap(m, c), w.ctx._lbCustOwnerOf(c)])));
  }
}

console.log('=== 12. 地図（MODEL.md §3 の I-C1〜I-C11）===');
{
  const DOC = readFileSync(join(ROOT, 'ops/MODEL.md'), 'utf8');
  const rows = DOC.split('\n').filter((l) => /^\| I-C\d+ \|/.test(l));
  const ids = rows.map((l) => l.split('|')[1].trim());
  ok('12-1 ★I-C1〜I-C11 が地図にある', JSON.stringify(ids) === JSON.stringify(Array.from({ length: 11 }, (_, i) => 'I-C' + (i + 1))), ids.join(','));
  const noTest = rows.filter((l) => { const c = l.split('|').map((x) => x.trim()); const last = c[c.length - 2] || ''; return !/`[a-z0-9-]+\.test\.js`/.test(last); });
  ok('12-2 ★どの不変条件にも守っている検査が紐付いている', noTest.length === 0, noTest.map((l) => l.split('|')[1]).join(','));
  ok('12-3 地図に cancel_notes の表がある', /`cancel_notes` \| res_id/.test(DOC));
}

console.log((fail === 0 ? '✅ ' : '⚠️ ') + `キャンセル理由（GAS・設計36） 検証: ${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
