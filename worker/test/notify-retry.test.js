// 届かなかったLINE通知を、誰も気づかないまま終わらせない（設計17）を、コードを実際に動かして確かめる。
//   実行: node worker/test/notify-retry.test.js
//
// ★なぜ要るのか
//   9/17・10/08・10/12 に、いずれも4件のLINEが届かなかった。記録は「理由と用途」だけで、
//   **誰にどの文面が届かなかったかが分からなかった。** 対処（待ちを伸ばす）を2回入れたが効かなかった。
//   いまは「積んで送り直す／駄目ならオーナーへメール」。送り直しは、間違った案内（取り消した予約に
//   「承りました」）を送る危険と隣り合わせなので、字面ではなく**動かして**守る。
//
// ★方法
//   gas/LineBooking.js の「NOTIFY_QUEUE_BEGIN〜END」の区画を丸ごと取り出し、
//   LINE・シート・ロック・メール・時計を身代わりにして vm で動かす。

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LB = readFileSync(join(ROOT, 'gas/LineBooking.js'), 'utf8');
const CODE = readFileSync(join(ROOT, 'gas/コード.js'), 'utf8');
const m = LB.match(/\/\/ ==== NOTIFY_QUEUE_BEGIN ====[\s\S]*?\/\/ ==== NOTIFY_QUEUE_END ====/);
if (!m) { console.log('❌ 区画（NOTIFY_QUEUE_BEGIN〜END）が見つからない'); process.exit(1); }
const SECTION = m[0];

let pass = 0, fail = 0;
function ok(name, cond, why) {
  if (cond) { pass++; return; }
  fail++; console.log(`❌ ${name}`); if (why) console.log(`   ${why}`);
}

const MIN = 60000;
const T0 = new Date(2026, 9, 13, 10, 0, 0).getTime();   // 2026-10-13 10:00（ローカル時刻で扱う）
const pad = (n) => String(n).padStart(2, '0');
function fmt(d, pat) {
  const map = { yyyy: d.getFullYear(), MM: pad(d.getMonth() + 1), dd: pad(d.getDate()), HH: pad(d.getHours()), mm: pad(d.getMinutes()), ss: pad(d.getSeconds()) };
  if (pat === 'M/d HH:mm') return `${d.getMonth() + 1}/${d.getDate()} ${map.HH}:${map.mm}`;
  if (pat === 'M/d HH:mm:ss') return `${d.getMonth() + 1}/${d.getDate()} ${map.HH}:${map.mm}:${map.ss}`;
  return pat.replace('yyyy', map.yyyy).replace('MM', map.MM).replace('dd', map.dd).replace('HH', map.HH).replace('mm', map.mm).replace('ss', map.ss);
}
const resvDate = (ms) => fmt(new Date(ms), 'yyyy/MM/dd HH:mm');

// ---- 身代わりのシート ----
function makeSheet(name, rows) {
  const data = rows.map((r) => r.slice());
  return {
    name, data,
    getLastRow: () => data.length,
    getLastColumn: () => data.reduce((a, r) => Math.max(a, r.length), 0),
    getRange(r, c, nr = 1, nc = 1) {
      return {
        getValues: () => { const out = []; for (let i = 0; i < nr; i++) { const row = data[r - 1 + i] || []; const o = []; for (let j = 0; j < nc; j++) o.push(row[c - 1 + j] === undefined ? '' : row[c - 1 + j]); out.push(o); } return out; },
        setValues: (v) => { for (let i = 0; i < nr; i++) { if (!data[r - 1 + i]) data[r - 1 + i] = []; for (let j = 0; j < nc; j++) data[r - 1 + i][c - 1 + j] = v[i][j]; } },
        getValue: () => (data[r - 1] || [])[c - 1],
        setValue: (x) => { data[r - 1][c - 1] = x; },
      };
    },
    appendRow: (row) => { data.push(row.slice()); },
  };
}

function makeEnv(opts = {}) {
  const clock = { now: T0 };
  class FakeDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(clock.now); }
    static now() { return clock.now; }
  }
  const props = new Map(Object.entries(opts.props || { LINE_MESSAGING_TOKEN: 'tok' }));
  const sheets = new Map();
  const ss = {
    getSheetByName: (n) => sheets.get(n) || null,
    insertSheet: (n) => { const s = makeSheet(n, []); sheets.set(n, s); return s; },
  };
  const resvHead = ['予約日時', '顧客名', 'customer_id', 'line_user_id', 'trainer_id', 'トレーナー名', 'status', 'payment_flag', '備考', 'channel', '記録日時'];
  sheets.set('line_reservations', makeSheet('line_reservations', [resvHead].concat(opts.resv || [])));
  sheets.set('booking_metrics', makeSheet('booking_metrics', [['ts', 'date', 'outcome', 'channel', 'detail']].concat(opts.metrics || [])));
  if (opts.queueSheet !== false) sheets.set('notify_retry', null);   // 下で作る
  const lock = { held: false, free: true };
  const fetches = [];
  const responses = (opts.responses || []).slice();
  const mails = [];
  const logged = [];
  const ctx = {
    Date: FakeDate, Math, JSON, String, Number, isFinite, Object, Array, RegExp, Error,
    console,
    Logger: { log: () => {} },
    Utilities: {
      sleep: (ms) => { clock.now += ms; },
      getUuid: (() => { let n = 0; return () => 'uuid-' + (++n); })(),
      formatDate: (d, tz, pat) => fmt(d, pat),
    },
    UrlFetchApp: {
      fetch: (url, o) => {
        fetches.push({ url, body: JSON.parse(o.payload), lockHeld: lock.held });
        if (opts.onFetch) opts.onFetch(fetches.length);
        const r = responses.length ? responses.shift() : 200;
        if (r === 'throw') throw new Error('Address unavailable');
        return { getResponseCode: () => (typeof r === 'object' ? r.code : r), getContentText: () => (typeof r === 'object' ? r.body : '{"message":"x"}') };
      },
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (props.has(k) ? props.get(k) : null), setProperty: (k, v) => props.set(k, String(v)) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => { if (!lock.free || lock.held) return false; lock.held = true; return true; }, releaseLock: () => { lock.held = false; } }) },
    MailApp: { sendEmail: (to, subject, body) => { if (opts.mailThrows) throw new Error('mail quota'); mails.push({ to, subject, body }); } },
    SETTINGS: { TIMEZONE: 'Asia/Tokyo' },
    LINE_BOOKING: { RESV_SHEET: 'line_reservations' },
    LB_METRICS_SHEET: 'booking_metrics',
    LB_HEALTH_BUILD: 'test',
    _lbSs: () => ss,
    _lbSheet: (n) => sheets.get(n) || null,
    _lbProp: (k) => (props.has(k) ? props.get(k) : ''),
    _lbIsStaging: () => !!opts.staging,
    _lbIsFiniteNum: (x) => typeof x === 'number' && isFinite(x),
    _lbLogNotifyFail: (reason, purpose, detail) => logged.push({ reason, purpose, detail }),
    _lbAlertEmail: () => (opts.noEmail ? '' : 'owner@example.com'),
    getTrainerByLine: (id) => (id === 'Utrainer' ? { name: '鈴木' } : null),
    _lbCustInfoById: (id) => ({ customerName: id === 'C0001' ? '山田花子' : '佐藤太郎' }),
    _lbParseResvDate: (v) => {
      if (v && typeof v.getTime === 'function') return v;
      const mm = String(v || '').match(/^(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{2})/);
      return mm ? new Date(Number(mm[1]), Number(mm[2]) - 1, Number(mm[3]), Number(mm[4]), Number(mm[5])) : null;
    },
  };
  vm.createContext(ctx);
  vm.runInContext(SECTION, ctx);
  if (opts.queueSheet !== false) { sheets.delete('notify_retry'); ctx._lbNqSheet(true); } else { sheets.delete('notify_retry'); }
  const q = () => sheets.get('notify_retry');
  const col = (n) => ctx.LB_NQ.HEAD.indexOf(n);
  const qrows = () => (q() ? q().data.slice(1) : []);
  return { ctx, clock, props, sheets, lock, fetches, mails, logged, q, qrows, col, responses };
}

const START = T0 + 2 * 24 * 60 * MIN;            // 2日後のセッション
const resvRow = (resId, status, cust = 'C0001', start = START) =>
  [resvDate(start), cust === 'C0001' ? '山田花子' : '佐藤太郎', cust, 'Ucust' + cust, 'T1', '鈴木', status, '', resId, 'line', resvDate(T0)];
const CTX = { resId: 'R1', customerId: 'C0001', startMs: START };

// ============================================================
console.log('=== 1. 積む／積まない（_lbPush の失敗の出口）===');
{
  const e = makeEnv({ resv: [resvRow('R1', 'confirmed')], responses: [429, 429, 429, 429] });
  const r = e.ctx._lbPush('Ucust', 'ご予約を承りました', 'booking_customer', CTX);
  ok('1-1 429が続けば false', r === false);
  ok('1-2 ★1件の予約に紐づく通知は pending で積まれる', e.qrows().length === 1 && e.qrows()[0][e.col('state')] === 'pending');
  ok('1-3 10分後に送り直す予定', e.qrows()[0][e.col('next_at')] - e.clock.now <= 10 * MIN && e.qrows()[0][e.col('next_at')] - e.clock.now > 9 * MIN);
  ok('1-4 失敗は従来どおり booking_metrics にも残る', e.logged.length === 1 && e.logged[0].reason === 'HTTP_429');
}
{
  const e = makeEnv({ responses: [429, 429, 429, 429] });
  e.ctx._lbPush('Ucust', 'まとめ', 'batch_customer');
  ok('1-5 ★まとめ通知は送り直さず alert（オーナーへ）', e.qrows()[0][e.col('state')] === 'alert');
}
{
  const e = makeEnv({ responses: [429, 401] });
  e.ctx._lbPush('Ucust', 'x', 'booking_customer', CTX);
  ok('1-6 ★N9 429→401 は 401 として扱う（最後の試行の値）', e.qrows()[0][e.col('last_code')] === '401' && e.qrows()[0][e.col('state')] === 'alert',
     '最初の 429 を返すと、待っても通らないものを送り直してしまう');
}
{
  const e = makeEnv({ responses: ['throw'] });
  e.ctx._lbPush('Ucust', 'x', 'booking_customer', CTX);
  const row = e.qrows()[0];
  ok('1-7 ★通信例外は届いたか分からない＝送り直さず alert', row[e.col('state')] === 'alert' && /^delivery_unknown/.test(row[e.col('last_detail')]));
}
{
  const e = makeEnv({ responses: [403] });
  e.ctx._lbPush('Ucust', 'x', 'booking_customer', CTX);
  ok('1-8 403（ブロック）は送り直さず alert', e.qrows()[0][e.col('state')] === 'alert');
}
{
  const e = makeEnv({ responses: [429, 429, 429, 429] });
  e.ctx._lbPush('Ucust', 'x', 'nudge_visit_a');
  ok('1-9 ★N8 声かけは積まない', e.qrows().length === 0);
}
{
  const e = makeEnv({ responses: [429, 429, 429, 429] });
  e.ctx._lbPush('Ucust', 'x', 'booking_customer');   // ctx が無い
  ok('1-10 予約IDが無ければ送り直さず alert', e.qrows()[0][e.col('state')] === 'alert');
}
{
  const e = makeEnv({ responses: [429, 429, 429, 429] });
  e.ctx._lbPush('Ucust', 'x', 'change_customer', { resId: 'R2', customerId: 'C0001', startMs: START });   // 旧IDが無い
  ok('1-11 変更で旧IDが無ければ送り直さず alert', e.qrows()[0][e.col('state')] === 'alert');
}
{
  const e = makeEnv({ props: {}, staging: false });
  const r = e.ctx._lbPush('Ucust', 'x', 'booking_customer', CTX);
  ok('1-12 ★本番でトークンが無いのは記録する（全通知の停止）', r === false && e.logged.length === 1 && e.logged[0].reason === 'NO_TOKEN');
}
{
  const e = makeEnv({ props: {}, staging: true });
  e.ctx._lbPush('Ucust', 'x', 'booking_customer', CTX);
  ok('1-13 staging でトークンが無いのは記録しない（意図的）', e.logged.length === 0 && e.qrows().length === 0);
}
{
  const e = makeEnv({ queueSheet: false, responses: [429, 429, 429, 429] });
  let threw = false, r;
  try { r = e.ctx._lbPush('Ucust', 'x', 'booking_customer', CTX); } catch (x) { threw = true; }
  ok('1-14 ★N5 キューが無くても例外を外へ出さない（予約を止めない）', !threw && r === false);
  ok('1-15 ★N11 書けなかったことが Script Properties に残る（別の媒体）', /^1\|/.test(e.props.get('LB_NOTIFY_QUEUE_WRITE_FAIL') || ''));
  ok('1-16 ★予約の失敗経路でシートを作らない', !e.sheets.get('notify_retry'));
}
{
  const e = makeEnv({ responses: [200] });
  const r = e.ctx._lbPush('Ucust', 'x', 'booking_customer', CTX);
  ok('1-17 成功は true・何も積まない・何も書かない', r === true && e.qrows().length === 0 && e.logged.length === 0);
}

// ============================================================
console.log('=== 2. 送り直し（lbNotifyRetryTick）===');
function enqueue(e, purpose, ctx) {
  e.responses.push(429, 429, 429, 429);
  e.ctx._lbPush('Ucust', '本文：山田花子 様', purpose, ctx);
}
{
  const e = makeEnv({ resv: [resvRow('R1', 'confirmed')] });
  enqueue(e, 'booking_customer', CTX);
  const n0 = e.fetches.length;
  e.clock.now += 5 * MIN;
  e.ctx.lbNotifyRetryTick(e.clock.now);
  ok('2-1 10分経つまでは送らない', e.fetches.length === n0);
  e.clock.now += 6 * MIN;
  e.responses.push(200);
  const out = e.ctx.lbNotifyRetryTick(e.clock.now);
  ok('2-2 10分後に送り直して届けば sent', out.sent === 1 && e.qrows()[0][e.col('state')] === 'sent');
  ok('2-3 ★N6 LINEへ送っているあいだ ScriptLock を持っていない', e.fetches[e.fetches.length - 1].lockHeld === false,
     '予約・取消・変更は同じロックを10秒待つ。送信中に握ると予約が失敗する');
  ok('2-4 送り直しは1回だけ（429の短い粘りを使わない）', e.fetches.length === n0 + 1);
  ok('2-5 見張りの記録（最後に終えた時刻）が残る', Number(e.props.get('LB_NOTIFY_RETRY_COMPLETED')) === e.clock.now);
}
{
  const e = makeEnv({ resv: [resvRow('R1', 'cancelled')] });
  enqueue(e, 'booking_customer', CTX);
  const n0 = e.fetches.length;
  e.clock.now += 11 * MIN;
  e.ctx.lbNotifyRetryTick(e.clock.now);
  ok('2-6 ★N2 取り消した予約に「承りました」を送らない（stale）', e.fetches.length === n0 && e.qrows()[0][e.col('state')] === 'stale');
}
{
  const e = makeEnv({ resv: [resvRow('R1', 'confirmed')] });
  enqueue(e, 'booking_customer', { resId: 'R1', customerId: 'C0001', startMs: T0 + 5 * MIN });
  const n0 = e.fetches.length;
  e.clock.now += 11 * MIN;
  e.ctx.lbNotifyRetryTick(e.clock.now);
  ok('2-7 ★N3 開始時刻を過ぎた通知は送らない', e.fetches.length === n0 && e.qrows()[0][e.col('state')] === 'stale');
}
{
  const e = makeEnv({ resv: [resvRow('R1', 'confirmed'), resvRow('R1', 'confirmed')] });
  enqueue(e, 'booking_customer', CTX);
  const n0 = e.fetches.length;
  e.clock.now += 11 * MIN;
  e.ctx.lbNotifyRetryTick(e.clock.now);
  ok('2-8 予約IDが2行にある＝判定できない→送らず alert', e.fetches.length === n0 && e.qrows()[0][e.col('state')] === 'alert');
}
{
  // 変更：新が confirmed・旧が changed のときだけ
  const okEnv = makeEnv({ resv: [resvRow('R2', 'confirmed'), resvRow('R1|→R2|無料変更', 'changed', 'C0001', START - 60 * MIN)] });
  enqueue(okEnv, 'change_customer', { resId: 'R2', oldResId: 'R1', customerId: 'C0001', startMs: START });
  okEnv.clock.now += 11 * MIN; okEnv.responses.push(200);
  okEnv.ctx.lbNotifyRetryTick(okEnv.clock.now);
  ok('2-9 変更：新が confirmed・旧が changed なら送る（I列は「|」の前で比べる）', okEnv.qrows()[0][okEnv.col('state')] === 'sent');
  const ngEnv = makeEnv({ resv: [resvRow('R2|無料取消', 'cancelled'), resvRow('R1|→R2|無料変更', 'changed', 'C0001', START - 60 * MIN)] });
  enqueue(ngEnv, 'change_customer', { resId: 'R2', oldResId: 'R1', customerId: 'C0001', startMs: START });
  ngEnv.clock.now += 11 * MIN;
  ngEnv.ctx.lbNotifyRetryTick(ngEnv.clock.now);
  ok('2-10 変更後の予約を取り消していたら送らない', ngEnv.qrows()[0][ngEnv.col('state')] === 'stale');
}
{
  // 取消：同じ会員が同じ時刻を取り直していたら送らない
  const e = makeEnv({ resv: [resvRow('R1|無料取消', 'cancelled'), resvRow('R9', 'confirmed')] });
  enqueue(e, 'cancel_customer', CTX);
  const n0 = e.fetches.length;
  e.clock.now += 11 * MIN;
  e.ctx.lbNotifyRetryTick(e.clock.now);
  ok('2-11 ★取り直した予約があるとき、遅れた「キャンセル」を送らない', e.fetches.length === n0 && e.qrows()[0][e.col('state')] === 'stale');
  const e2 = makeEnv({ resv: [resvRow('R1|無料取消', 'cancelled')] });
  enqueue(e2, 'cancel_customer', CTX);
  e2.clock.now += 11 * MIN; e2.responses.push(200);
  e2.ctx.lbNotifyRetryTick(e2.clock.now);
  ok('2-12 取消のままなら送る', e2.qrows()[0][e2.col('state')] === 'sent');
}
{
  // 10分 → 30分 → 2時間 → 3回で駄目ならオーナーへ
  const e = makeEnv({ resv: [resvRow('R1', 'confirmed')] });
  enqueue(e, 'booking_customer', CTX);
  const n0 = e.qrows().length;
  e.clock.now += 11 * MIN; e.responses.push(429); e.ctx.lbNotifyRetryTick(e.clock.now);
  const row1 = e.qrows()[0];
  ok('2-13 1回目が駄目なら30分後', row1[e.col('state')] === 'pending' && Math.round((row1[e.col('next_at')] - e.clock.now) / MIN) === 30);
  e.clock.now += 31 * MIN; e.responses.push(500); e.ctx.lbNotifyRetryTick(e.clock.now);
  ok('2-14 2回目が駄目なら2時間後', Math.round((e.qrows()[0][e.col('next_at')] - e.clock.now) / MIN) === 120);
  e.clock.now += 121 * MIN; e.responses.push(429); e.ctx.lbNotifyRetryTick(e.clock.now);
  ok('2-15 3回目で駄目なら alert', e.qrows()[0][e.col('state')] === 'alert');
  ok('2-16 ★N1 送り直しの失敗は新しく積まれない', e.qrows().length === n0, `行数 ${n0} → ${e.qrows().length}`);
  e.clock.now += 10 * MIN; e.ctx.lbNotifyRetryTick(e.clock.now);
  ok('2-17 次の回でオーナーへメール→closed', e.mails.length === 1 && e.qrows()[0][e.col('state')] === 'closed');
  ok('2-18 メールに宛先の氏名と本文が載る（オーナーだけが読む）', /山田花子/.test(e.mails[0].body) && /本文：/.test(e.mails[0].body));
}
{
  const e = makeEnv({});
  e.lock.free = false;
  enqueue(e, 'batch_customer');
  const n0 = e.fetches.length;
  e.clock.now += 11 * MIN;
  const out = e.ctx.lbNotifyRetryTick(e.clock.now);
  ok('2-19 ロックが取れなければ何もしない（予約を待たせない）', out.code === 'LOCK_MISS' && e.fetches.length === n0 && e.mails.length === 0);
  ok('2-20 ★取れなかったときは「終えた」を記録しない（見張りが気づける）', !e.props.has('LB_NOTIFY_RETRY_COMPLETED'));
}
{
  const e = makeEnv({});
  enqueue(e, 'batch_customer');
  e.clock.now += 11 * MIN;
  const out = e.ctx.lbNotifyRetryTick(e.clock.now - 4 * MIN);   // warmupCache が4分かかった
  ok('2-21 warmupCache に3分以上かかったら送り直さない（6分の制限）', out.code === 'LATE' && e.mails.length === 0);
}
{
  const e = makeEnv({ mailThrows: true });
  enqueue(e, 'batch_customer');
  e.clock.now += 11 * MIN;
  e.ctx.lbNotifyRetryTick(e.clock.now);
  const row = e.qrows()[0];
  ok('2-22 メールが送れなければ alert に戻し、失敗を数える', row[e.col('state')] === 'alert' && row[e.col('email_attempts')] === 1 && /mail quota/.test(row[e.col('last_email_error')]));
  const st = e.ctx._lbNqStatus(e.clock.now);
  ok('2-23 点検が「メールが送れていない」を数える', st.emailFailing === 1);
}
{
  // ★N10 送っている最中に別の実行が来ても、同じ行を2回送らない
  const e = makeEnv({ resv: [resvRow('R1', 'confirmed')] });
  enqueue(e, 'booking_customer', CTX);
  const n0 = e.fetches.length;
  let nested = null;
  e.clock.now += 11 * MIN;
  e.responses.push(200, 200);
  const origFetch = e.ctx.UrlFetchApp.fetch;
  e.ctx.UrlFetchApp.fetch = (u, o) => { const r = origFetch(u, o); if (!nested) nested = e.ctx.lbNotifyRetryTick(e.clock.now); return r; };
  e.ctx.lbNotifyRetryTick(e.clock.now);
  ok('2-24 ★N10 並行した実行は取り分け済みの行を送らない', e.fetches.length === n0 + 1 && nested && nested.sent === 0,
     `送信 ${e.fetches.length - n0} 回`);
}
{
  // 途中で止まった実行の後始末：期限切れの sending を pending に戻す
  const e = makeEnv({ resv: [resvRow('R1', 'confirmed')] });
  enqueue(e, 'booking_customer', CTX);
  const row = e.q().data[1];
  row[e.col('state')] = 'sending'; row[e.col('lease_id')] = 'dead'; row[e.col('lease_until')] = e.clock.now - 1;
  e.clock.now += 11 * MIN; e.responses.push(200);
  const out = e.ctx.lbNotifyRetryTick(e.clock.now);
  ok('2-25 期限切れの取り分けは回収して送り直す', out.recovered === 1 && e.q().data[1][e.col('state')] === 'sent');
}
{
  const e = makeEnv({ resv: [resvRow('R1', 'confirmed')] });
  enqueue(e, 'booking_customer', CTX);
  e.clock.now += 11 * MIN;
  e.sheets.set('line_reservations', null);
  e.ctx._lbSheet = () => { throw new Error('boom'); };
  let threw = false;
  try { e.ctx.lbNotifyRetryTick(e.clock.now); } catch (x) { threw = true; }
  ok('2-26 ★N5 台帳が読めなくても例外を出さず、送らずに alert', !threw && e.qrows()[0][e.col('state')] !== 'sent' && e.qrows()[0][e.col('state')] !== 'pending');
}

{
  // ★ロックの中のシート往復は、行数によらず「取り分け 読み1・書き1」「書き戻し 読み1・書き1」×2まで
  const e = makeEnv({ resv: [resvRow('R1', 'confirmed'), resvRow('R2', 'confirmed', 'C0002'), resvRow('R3', 'confirmed', 'C0003')] });
  enqueue(e, 'booking_customer', CTX);
  enqueue(e, 'booking_customer', { resId: 'R2', customerId: 'C0002', startMs: START });
  enqueue(e, 'booking_customer', { resId: 'R3', customerId: 'C0003', startMs: START });
  enqueue(e, 'batch_customer'); enqueue(e, 'autobook_customer');
  e.clock.now += 11 * MIN; e.responses.push(200, 200, 200);
  const sh = e.q(); const orig = sh.getRange.bind(sh); let inLock = 0;
  sh.getRange = (...a) => { const r = orig(...a); if (!e.lock.held) return r;
    return { getValues: () => { inLock++; return r.getValues(); }, setValues: (v) => { inLock++; return r.setValues(v); } }; };
  const out = e.ctx.lbNotifyRetryTick(e.clock.now);
  ok('2-27 ★ロック内のシート往復が行数に比例しない（5行で6回以内）', out.sent === 3 && out.mailed === 2 && inLock <= 6,
     `ロック内の往復 ${inLock} 回（予約は同じロックを10秒しか待たない）`);
}

{
  // スイッチ：自動の送り直しだけを止める。止めたら「送らずにオーナーへ」
  const e = makeEnv({ resv: [resvRow('R1', 'confirmed')] });
  enqueue(e, 'booking_customer', CTX);
  e.props.set('LB_NOTIFY_RETRY_ON', '0');
  const n0 = e.fetches.length;
  e.clock.now += 11 * MIN;
  e.ctx.lbNotifyRetryTick(e.clock.now);
  ok('2-28 ★送り直しを止めたら送らない', e.fetches.length === n0);
  ok('2-29 ★止めても待たせたままにせず、オーナーへメール', e.mails.length === 1 && e.qrows()[0][e.col('state')] === 'closed' && /RETRY_OFF/.test(e.qrows()[0][e.col('last_detail')]));
}

// ============================================================
console.log('=== 3. 公開窓口に個人情報を出さない（N7）===');
{
  const failTs = fmt(new Date(T0 - 60 * MIN), 'yyyy/MM/dd HH:mm:ss');
  const e = makeEnv({
    resv: [[resvDate(START), '山田花子', 'C0001', 'U0123456789abcdef0123456789abcdef', 'T1', '鈴木', 'confirmed', '', 'R1', 'line', resvDate(T0 - 61 * MIN)]],
    metrics: [[failTs, fmt(new Date(T0 - 60 * MIN), 'yyyy-MM-dd'), 'NOTIFY_FAIL_HTTP_429', 'booking_customer', '{"message":"山田花子 John Smith limit"}'],
              [failTs, fmt(new Date(T0 - 60 * MIN), 'yyyy-MM-dd'), 'NOTIFY_FAIL_HTTP_429', 'booking_customer', '{"message":"You have reached your monthly limit."}'],
              [failTs, fmt(new Date(T0 - 60 * MIN), 'yyyy-MM-dd'), 'NOTIFY_FAIL_EXCEPTION', 'reminder_customer John Smith', 'Exception: ご予約を承りました Jane Doe']],
  });
  enqueue(e, 'batch_customer');
  const txt = e.ctx.notifyFailsText(14);
  ok('3-1 失敗の行が出る', /HTTP_429/.test(txt) && /booking_customer/.test(txt));
  ok('3-2 候補の予約が出る（記録日時が近い）', /候補（台帳の記録日時が近い予約）: 1件/.test(txt) && /会員#0001/.test(txt));
  ok('3-3 ★氏名を出さない', !/山田花子/.test(txt), '公開URLに出る');
  ok('3-4 ★LINEのIDを出さない', !/U0123456789abcdef/.test(txt));
  ok('3-5 ★本文を出さない', !/本文：/.test(txt) && !/ご予約を承りました/.test(txt));
  ok('3-5b ★英字の氏名も出さない（応答・用途に混ざっていても）', !/John|Smith|Jane|Doe/.test(txt),
     '英数字だけに絞る方式では英字の氏名が素通りする（関門②）');
  ok('3-5c 応答は固定の語彙で出る（原因の切り分けには十分）', /MONTHLY_LIMIT/.test(txt) && /OTHER（未知の応答/.test(txt));
  {
    const rem = makeEnv({
      resv: [resvRow('R1', 'confirmed', 'C0001', T0 + 24 * 60 * MIN), resvRow('R2|無料取消', 'cancelled', 'C0002', T0 + 25 * 60 * MIN)],
      metrics: [[fmt(new Date(T0), 'yyyy/MM/dd HH:mm:ss'), fmt(new Date(T0), 'yyyy-MM-dd'), 'NOTIFY_FAIL_HTTP_429', 'reminder_customer', '']],
    });
    const t2 = rem.ctx.notifyFailsText(14);
    ok('3-7 ★リマインドの候補は状態で絞らない（送った後に取り消された予約も対象だった）', /翌日の予約・リマインドの対象）: 2件/.test(t2) && /status=cancelled/.test(t2));
  }
  {
    // ★日付セルが日付型で返っても、直近N日の絞り込みが効く（2026-10-13 本番で効いていなかった）
    const old = new Date(T0 - 28 * 24 * 60 * MIN);   // 9/15 相当
    const d1 = makeEnv({ metrics: [
      [old, old, 'NOTIFY_FAIL_HTTP_429', 'push', ''],                                             // 日付型で返るセル
      [fmt(new Date(T0), 'yyyy/MM/dd HH:mm:ss'), fmt(new Date(T0), 'yyyy-MM-dd'), 'NOTIFY_FAIL_HTTP_429', 'booking_customer', ''],
    ] });
    const t3 = d1.ctx.notifyFailsText(1);
    ok('3-8 ★日付型のセルも「直近1日」で正しく外れる', /失敗の行: 1件/.test(t3) && !/用途=push/.test(t3),
       'String(Date) は曜日の英字で始まり、数字の日付より常に大きいと判定されていた');
  }
  ok('3-6 送り直しの状態が出る', /送り直しの状態: 待ち 0件 ／ オーナー未通知 1件/.test(txt));
}

// ============================================================
console.log('=== 4. 配線（ソース）===');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((ln) => ln.replace(/\/\/.*$/, '')).join('\n');
const S = strip(LB), C = strip(CODE);
ok('4-1 ★N8 予約変更は「承りました」を送らない（suppressNotify）',
   /contractType: _chType, suppressNotify: true \}/.test(S),
   'それまで1回の変更で4通（承りました＋変更しました×顧客・トレーナー）');
ok('4-2 予約確定に予約IDを渡す', /custInfo\.customerName, channel, custInfo\.customerId, resId\)/.test(S));
ok('4-3 変更に新旧の予約IDを渡す', /var _chCtx = \{ resId: String\(made\.reservationId \|\| ''\), oldResId: String\(reservationId\)/.test(S)
   && /'change_customer', _chCtx\)/.test(S) && /'change_trainer', _chCtx\)/.test(S));
ok('4-4 取消に予約IDを渡す', (S.match(/'cancel_(customer|trainer)', \{ resId: String\(reservationId\)/g) || []).length === 2);
ok('4-5 前日リマインドに予約ID（I列の「|」の前）を渡す', /'reminder_customer',\s*\{ resId: String\(r\[8\] \|\| ''\)\.split\('\|'\)\[0\]/.test(S));
ok('4-6 手動紐付けに予約IDを渡す', /'booking_customer', \{ resId: String\(resId\), customerId: String\(customerId\), startMs: start\.getTime\(\) \}/.test(S));
ok('4-7 ★warmupCache が必ず（finally で）送り直しを呼ぶ', /function warmupCache\(\) \{\s*var _wcStart = Date\.now\(\);\s*try \{ _warmupCacheBody\(\); \}\s*finally \{\s*try \{ lbNotifyRetryTick\(_wcStart\); \}/.test(C),
   '作りたてで早期 return する回でも送り直す');
ok('4-8 体験予約のスタッフ通知が結果を見て、駄目ならオーナーへ', /_lbNqRecordAlert\('trial_staff', 'legacy'/.test(C) && /if \(_code === 200\) \{ Logger\.log\('LINE通知送信完了'\); return; \}/.test(C));
ok('4-9 ★tick がシートを作り、_lbPush の失敗経路では作らない', /function _lbNqAppendRow\(row\) \{\s*var sh = _lbSs\(\)\.getSheetByName\(LB_NQ\.SHEET\);\s*if \(!sh\) throw/.test(S));
ok('4-10 点検が「送り直しが止まっている」を high で出す', /add\('notify_retry_stalled', '通知', 'high'/.test(S));
ok('4-12 ★書き戻しは全行まとめて1回のロック（行ごとに待たない）',
   (S.match(/_lbNqWriteBack\(sh, leaseId, (claimed|alerts)\)/g) || []).length === 2 && !/_lbNqWriteBack\(sh, claimed\[k\]/.test(S));
ok('4-13 ★変更の通知だけで足りる：お客様へ終了時刻・場所・無料キャンセル',
   /new: _lbFmtResvLabel\(_newStart, _cl\) \+ '〜' \+ _newEndHm/.test(S)
   && /_lbSt\(_cl, 'rem_place'\) \+ _lbSt\(_cl, 'gym_name'\) \+ '\\n' \+ _lbSt\(_cl, 'rem_free_cancel'\)/.test(S),
   '「承りました」を止めたとき、これらはそちらにしか無かった（関門③）');
ok('4-14 ★変更の通知だけで足りる：トレーナーへ変更後の残数',
   /_lbTrainerRemainText\(String\(r\[2\]\), customerName, _newStart\), 'change_trainer', _chCtx\)/.test(S));
ok('4-15 予約確定の残数も同じ関数で作る（文面が分かれない）',
   /var _remTxt = isTransfer \? '' : _lbTrainerRemainText\(customerId, customerName, start\);/.test(S));
ok('4-11 窓口 notifyFails が繋がっている', /args\.notifyFails\) return _ejScrub\(notifyFailsText\(Number\(args\.notifyFails\)\)\)/.test(readFileSync(join(ROOT, 'gas/EdgeJob.js'), 'utf8')));

console.log('');
console.log(`${fail ? '❌' : '✅'} 通知の送り直し 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
