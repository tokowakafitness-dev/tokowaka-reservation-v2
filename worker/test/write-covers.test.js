// 設計45・I79：写しが書き込みの印を含まなければ Worker は答えない（本物の SQLite に全 migration を流して入口から通す）
//   実行: node worker/test/write-covers.test.js
//
//   ① migration 0034：列は NULL（初期化しない）・閉じる判定（dirty 0 は開く／NULL・covers < dirty は閉じる）
//   ② ingest：coversSeq を写しと同じ batch で置き換え（MAX にしない）・dirty の文の後ろ（行の無い会員）・
//              予約一覧は customerId／coveredCustomers（final・行1件以上だけ）・印だけの送信は covers を触らない・壊れた値は 400
//   ③ 閉じた時刻（*_blocked_since）：立つ・消える・移行の残り（NULL のまま）
//   ④ 門：readHome（前）・後の門（値を読んだ後に印が入ったら捨てる）・予約一覧・トレーナーの一覧・boot・顧客詳細・数える
//   ⑤ 予約を読む SQL の全経路が門を通る（機械で数える）
//   ⑥ /quota/status：閉じている数・移行の残り・退会を数えない・会員IDを出さない
//   ★値は架空（個人情報を書かない）
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { handleIngest } from '../src/routes/ingest.js';
import { readHome, routeBoot } from '../src/routes/boot.js';
import { compatMyReservations, compatTrainerReservations, compatMemberStatus } from '../src/routes/compat.js';
import { routeCustomerDetail } from '../src/routes/customer.js';
import { quotaStatus } from '../src/routes/quota.js';
import { isClosed, closedSqlFor } from '../src/lib/write-covers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const W = join(HERE, '..');
const SECRET = 'S';
let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) pass++; else { fail++; console.log(`❌ ${name}${detail ? '\n   ' + detail : ''}`); } }

function makeEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(W, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(join(W, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    try { db.exec(readFileSync(join(W, 'migrations', f), 'utf8')); } catch (e) { if (!/duplicate column/.test(e.message)) throw e; }
  }
  const env = { SHARED_SECRET: SECRET, _db: db, _break: null, _hook: null, KV: { get: async () => null, put: async () => {} } };
  const exec = (q, a, how) => {
    if (env._break && env._break.test(q)) throw new Error('SIMULATED');
    //   ★割り込み：その SQL を読む直前に一度だけ別の書き込み（印だけの送信）を入れる（関門① 3周目の順序）
    if (env._hook && env._hook.re.test(q)) { const h = env._hook; env._hook = null; h.fn(); }
    const st = db.prepare(q);
    if (how === 'first') { const r = st.get(...a); return r === undefined ? null : Object.assign({}, r); }
    if (how === 'all') return { results: st.all(...a).map((r) => Object.assign({}, r)) };
    const r = st.run(...a); return { meta: { changes: Number(r.changes) } };
  };
  env.DB = {
    prepare(q) { return { _q: q, _a: [], bind(...a) { this._a = a; return this; },
      async run() { return exec(q, this._a, 'run'); }, async first() { return exec(q, this._a, 'first'); },
      async all() { return exec(q, this._a, 'all'); } }; },
    async batch(ss) { db.exec('BEGIN'); try { const o = ss.map((s) => exec(s._q, s._a, 'run')); db.exec('COMMIT'); return o; }
                      catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; } },
  };
  return env;
}
const NOW = Date.now();
const C1 = 'C4500000000001', C2 = 'C4500000000002', C3 = 'C4500000000003', CW = 'C4500000000009';
function seed(env) {
  const d = env._db;
  for (const [id, st] of [[C1, null], [C2, null], [C3, null], [CW, '退会']]) {
    d.prepare('INSERT INTO customers (customer_id, name, contract_status, default_trainer_id, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)')
      .run(id, 'テスト 太郎', st, 'T1');
  }
  d.prepare("INSERT INTO trainers (trainer_id, name, role, active) VALUES ('T1', 'テスト', 'trainer', 1)").run();
  for (const k of ['reservations', 'customers', 'trainers']) {
    d.prepare('INSERT OR REPLACE INTO sync_state (key, synced_at, rows, ok) VALUES (?, ?, 1, 1)').run(k, NOW);
  }
  const home = JSON.stringify({ current: { type: null }, currentMonth: '2026-11', transferCredits: { available: 1 } });
  for (const id of [C1, C2, C3]) d.prepare('INSERT INTO member_home (customer_id, payload, computed_at, synced_at) VALUES (?, ?, ?, 1)').run(id, home, NOW - 60000);
  d.prepare(`INSERT INTO reservations (reservation_id, customer_id, customer_name, trainer_id, start_at, end_at, kind, status, created_at, synced_at)
             VALUES ('R1', ?, 'テスト 太郎', 'T1', ?, ?, 'normal', 'booked', 1, 1)`).run(C1, NOW + 86400000, NOW + 86400000 + 3600000);
}
const sv = (env, id) => { const r = env._db.prepare('SELECT * FROM customer_sync_version WHERE customer_id = ?').get(id); return r ? Object.assign({}, r) : null; };
const setSv = (env, id, o) => {
  env._db.prepare(`INSERT INTO customer_sync_version (customer_id, source_version, built_version, updated_at, dirty_seq, built_covers_seq)
                   VALUES (?, 0, 0, 1, 0, 0) ON CONFLICT(customer_id) DO NOTHING`).run(id);
  for (const [k, v] of Object.entries(o)) env._db.prepare(`UPDATE customer_sync_version SET ${k} = ? WHERE customer_id = ?`).run(v, id);
};
let BATCH = Date.now() + 1000;   // 増え続ける（古い batch を断る作りに当たらない）
async function ingest(env, body) {
  const res = await handleIngest(new Request('https://x/ingest', { method: 'POST', headers: { 'X-Ingest-Secret': SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ batchId: ++BATCH }, body)) }), env);
  let j = {}; try { j = await res.json(); } catch (_) {}
  return { status: res.status, ...j };
}
const resvRow = (id, cid, status = 'booked') => ({ reservation_id: id, customer_id: cid, customer_name: 'テスト 太郎', trainer_id: 'T1',
  start_at: NOW + 2 * 86400000, end_at: NOW + 2 * 86400000 + 3600000, kind: 'normal', attendee_count: 1, status, created_at: 1 });
const homeRow = (cid) => ({ customer_id: cid, payload: JSON.stringify({ current: { type: null }, currentMonth: '2026-11' }), computed_at: Date.now() });

// ================= ① =================
console.log('=== ① migration・判定 ===');
{
  const env = makeEnv(); seed(env);
  const cols = env._db.prepare('PRAGMA table_info(customer_sync_version)').all().map((c) => c.name);
  ok('①-1 列が4つ増える', ['home_covers_seq', 'resv_covers_seq', 'home_blocked_since', 'resv_blocked_since'].every((c) => cols.includes(c)), cols.join(','));
  const dflt = env._db.prepare('PRAGMA table_info(customer_sync_version)').all().filter((c) => /covers_seq$|blocked_since$/.test(c.name) && !/built/.test(c.name));
  ok('①-2 ★既定値を入れない（NULL＝閉じる）', dflt.every((c) => c.dflt_value === null), JSON.stringify(dflt));
  const cases = [
    [{ dirty_seq: 0, home_covers_seq: null }, false, 'dirty 0 は開く'],
    [{ dirty_seq: 3, home_covers_seq: null }, true, 'NULL は閉じる'],
    [{ dirty_seq: 3, home_covers_seq: 2 }, true, 'covers < dirty は閉じる'],
    [{ dirty_seq: 3, home_covers_seq: 3 }, false, 'covers = dirty は開く'],
    [{ dirty_seq: 3, home_covers_seq: 9 }, false, 'covers > dirty は開く'],
  ];
  for (const [row, want, label] of cases) {
    setSv(env, C3, row);
    const sqlSays = !!env._db.prepare(`SELECT 1 AS x FROM customer_sync_version WHERE customer_id = ? AND ${closedSqlFor('home')}`).get(C3);
    ok('①-3 ' + label + '（JS と SQL が同じ）', isClosed(row, 'home') === want && sqlSays === want, JSON.stringify({ row, js: isClosed(row, 'home'), sqlSays }));
  }
  ok('①-4 行が無い会員は開く', isClosed(null, 'home') === false);
}

// ================= ② ingest =================
console.log('=== ② ingest ===');
{
  const env = makeEnv(); seed(env);
  //   行の無い会員：dirty と covers を同じ送信で（スイッチがオフの書き込み直後と同じ形）→ 開いたまま
  let r = await ingest(env, { kind: 'home', rows: [homeRow(C2)], final: true, scope: 'partial', dirtySeq: 7, coversSeq: 7 });
  let v = sv(env, C2);
  ok('②-1 ★行の無い会員：dirty の文が行を作ってから covers が入る（閉じない）', r.status === 200 && v && v.dirty_seq === 7 && v.home_covers_seq === 7 && !isClosed(v, 'home') && v.home_blocked_since === null, JSON.stringify({ r, v }));
  ok('②-1b 予約一覧の covers は触らない（home の送信）', v.resv_covers_seq === null);
  //   印だけ（応答の前の送信）
  r = await ingest(env, { kind: 'reservations', rows: [], final: true, scope: 'partial', customerId: C2, dirtySeq: 8 });
  v = sv(env, C2);
  ok('②-2 ★印だけの送信は covers を触らない＝閉じる', r.status === 200 && v.dirty_seq === 8 && v.home_covers_seq === 7 && isClosed(v, 'home') && isClosed(v, 'resv'), JSON.stringify(v));
  ok('②-3 ★閉じた時刻：home は印が covers を追い越したので立つ・resv は行を作ったときから閉じている（作った時刻のまま）', typeof v.home_blocked_since === 'number' && typeof v.resv_blocked_since === 'number', JSON.stringify(v));
  //   ★移行の残り：migration の前からある行（covers も since も NULL）に印が来ても since は立てない（見張りが別に数える）
  setSv(env, C3, { dirty_seq: 2 });
  await ingest(env, { kind: 'reservations', rows: [], final: true, scope: 'partial', customerId: C3, dirtySeq: 3 });
  ok('②-3b 移行の残り（covers NULL の既存の行）は since を立てない・閉じている', sv(env, C3).home_blocked_since === null && sv(env, C3).resv_blocked_since === null && isClosed(sv(env, C3), 'home'), JSON.stringify(sv(env, C3)));
  //   後ろへ回した写し（番号つき）
  r = await ingest(env, { kind: 'home', rows: [homeRow(C2)], final: true, scope: 'partial', dirtySeq: 8, coversSeq: 8 });
  r = await ingest(env, { kind: 'reservations', rows: [resvRow('R2', C2)], final: true, scope: 'partial', customerId: C2, dirtySeq: 8, coversSeq: 8 });
  v = sv(env, C2);
  ok('②-4 写しと予約一覧が届けば開き、閉じた時刻を消す', !isClosed(v, 'home') && !isClosed(v, 'resv') && v.home_blocked_since === null && v.resv_blocked_since === null, JSON.stringify(v));
  //   ★MAX にしない：古い番号の写しが後から届いたら covers も下がる
  r = await ingest(env, { kind: 'home', rows: [homeRow(C2)], final: true, scope: 'partial', coversSeq: 6 });
  v = sv(env, C2);
  ok('②-5 ★古い番号で書いた写しが後から届けば covers も下がる（閉じる・古い値は出ない）', v.home_covers_seq === 6 && isClosed(v, 'home') && typeof v.home_blocked_since === 'number', JSON.stringify(v));
  //   全体の予約一覧（定期）
  setSv(env, C3, { dirty_seq: 4, resv_covers_seq: null });
  r = await ingest(env, { kind: 'reservations', rows: [resvRow('R3', C1)], final: false, scope: 'all', coversSeq: 9, coveredCustomers: [C1, C2, C3] });
  ok('②-6 ★途中の batch（final でない）では covers を立てない', sv(env, C3).resv_covers_seq === null, JSON.stringify(sv(env, C3)));
  r = await ingest(env, { kind: 'reservations', rows: [], final: true, scope: 'all', coversSeq: 9, coveredCustomers: [C1, C2, C3] });
  ok('②-7 ★0件の全体送信（取り込み側が削除を止める）では covers を立てない', sv(env, C3).resv_covers_seq === null);
  r = await ingest(env, { kind: 'reservations', rows: [resvRow('R3', C1)], final: true, scope: 'all', coversSeq: 9, coveredCustomers: [C1, C2, C3] });
  ok('②-8 ★final の batch で、予約0件の会員（C3）を含む走査した全員の covers を立てる', sv(env, C3).resv_covers_seq === 9 && !isClosed(sv(env, C3), 'resv') && r.covered === 3, JSON.stringify({ r, v: sv(env, C3) }));
  ok('②-8b coveredCustomers の無い全体送信は covers を触らない', (await ingest(env, { kind: 'reservations', rows: [resvRow('R3', C1)], final: true, scope: 'all', coversSeq: 10 })).covered === 0);
  //   壊れた値
  ok('②-9 coversSeq が小数・0・文字は 400', (await ingest(env, { kind: 'home', rows: [homeRow(C2)], final: true, scope: 'partial', coversSeq: 1.5 })).status === 400
     && (await ingest(env, { kind: 'home', rows: [homeRow(C2)], final: true, scope: 'partial', coversSeq: 0 })).status === 400
     && (await ingest(env, { kind: 'home', rows: [homeRow(C2)], final: true, scope: 'partial', coversSeq: '3' })).status === 400);
  ok('②-10 home・reservations 以外は 400', (await ingest(env, { kind: 'trainers', rows: [], final: true, scope: 'all', coversSeq: 3 })).code === 'COVERS_NOT_SUPPORTED');
  const many = Array.from({ length: 2001 }, (_, i) => 'C' + String(i).padStart(13, '0'));
  ok('②-11 ★coveredCustomers 2,000件超えは送信ごと断る（行も covers も書かない）', (await ingest(env, { kind: 'reservations', rows: [resvRow('R9', C1)], final: true, scope: 'all', coversSeq: 3, coveredCustomers: many })).code === 'COVERED_TOO_MANY'
     && !env._db.prepare("SELECT 1 FROM reservations WHERE reservation_id = 'R9'").get());
  ok('②-12 形の外れた会員IDは断る', (await ingest(env, { kind: 'reservations', rows: [resvRow('R9', C1)], final: true, scope: 'all', coversSeq: 3, coveredCustomers: ['テスト'] })).code === 'BAD_COVERED');
  ok('②-13 一部の送信で customerId と行の会員が違えば断る', (await ingest(env, { kind: 'reservations', rows: [resvRow('R9', C1)], final: true, scope: 'partial', customerId: C2, coversSeq: 3 })).code === 'CUSTOMER_MISMATCH');
  //   dirty の文が covers を追い越したとき（covers が有る会員）に閉じた時刻を立てる・既にあれば動かさない
  setSv(env, C1, { dirty_seq: 5, home_covers_seq: 5, home_blocked_since: null });
  await ingest(env, { kind: 'reservations', rows: [], final: true, scope: 'partial', customerId: C1, dirtySeq: 6 });
  const t1 = sv(env, C1).home_blocked_since;
  await ingest(env, { kind: 'reservations', rows: [], final: true, scope: 'partial', customerId: C1, dirtySeq: 7 });
  ok('②-14 閉じた時刻は最初の1回だけ（追加の書き込みで動かさない）', typeof t1 === 'number' && sv(env, C1).home_blocked_since === t1);
}

// ================= ④ 門 =================
console.log('=== ④ 門 ===');
{
  const env = makeEnv(); seed(env);
  const ctxOf = () => { const p = []; return { waitUntil: (x) => p.push(Promise.resolve(x)), _wait: () => Promise.all(p) }; };
  ok('④-0 印の無い会員（行なし）は今と同じに答える', (await readHome(env, C1)) !== null);
  setSv(env, C1, { dirty_seq: 3, home_covers_seq: 3, resv_covers_seq: 3 });
  ok('④-1 開いていれば答える', (await readHome(env, C1)) !== null);
  setSv(env, C1, { home_covers_seq: 2 });
  ok('④-2 ★閉じていれば readHome は null（写しも振替権も出ない）', (await readHome(env, C1)) === null);
  setSv(env, C1, { home_covers_seq: null });
  ok('④-3 ★NULL も null', (await readHome(env, C1)) === null);
  //   前の門は写しを読む前（閉じていれば member_home を読まない）
  let readHomeRow = false;
  env._hook = { re: /FROM member_home/, fn: () => { readHomeRow = true; } };
  await readHome(env, C1);
  ok('④-4 前の門で閉じていれば写しを読まない（readHomeDiag より前）', readHomeRow === false);
  env._hook = null;
  //   ★後の門：開いていると判定した後・写しを読む直前に印が入る → 捨てる
  setSv(env, C1, { home_covers_seq: 3 });
  env._hook = { re: /FROM member_home/, fn: () => env._db.prepare('UPDATE customer_sync_version SET dirty_seq = 4 WHERE customer_id = ?').run(C1) };
  ok('④-5 ★後の門：値を読む間に印が入ったら捨てる（readHome）', (await readHome(env, C1)) === null);
  setSv(env, C1, { dirty_seq: 3 });
  //   読めなければ全員閉じる
  env._break = /FROM customer_sync_version/;
  ok('④-6 ★門が読めなければ答えない', (await readHome(env, C1)) === null);
  env._break = null;

  //   会員の予約一覧
  const who1 = { role: 'customer', customerId: C1, name: 'x' };
  ok('④-7 開いていれば予約一覧を返す', ((await compatMyReservations({ env, who: who1, body: {} })).reservations || []).length === 1);
  setSv(env, C1, { resv_covers_seq: 2 });
  ok('④-8 ★閉じていれば予約一覧は FALLBACK', (await compatMyReservations({ env, who: who1, body: {} }))._fallback === true);
  setSv(env, C1, { resv_covers_seq: 3 });
  env._hook = { re: /FROM reservations WHERE customer_id/, fn: () => env._db.prepare('UPDATE customer_sync_version SET dirty_seq = 4 WHERE customer_id = ?').run(C1) };
  ok('④-9 ★後の門：予約を読む間に印が入ったら捨てる（会員の予約一覧）', (await compatMyReservations({ env, who: who1, body: {} }))._fallback === true);
  setSv(env, C1, { dirty_seq: 3 });

  //   トレーナー・オーナーの一覧：誰か1人でも閉じていれば
  const own = { role: 'owner', name: 'x', trainerId: 'T1' };
  ok('④-10 全員開いていればトレーナーの一覧を返す', Array.isArray((await compatTrainerReservations({ env, who: own, body: {} })).reservations));
  setSv(env, C2, { dirty_seq: 5 });   // C2 は resv の covers が NULL
  ok('④-11 ★誰か1人でも閉じていればトレーナーの一覧は FALLBACK（閲覧範囲の外の会員も見る）', (await compatTrainerReservations({ env, who: own, body: {} }))._fallback === true);
  setSv(env, C2, { resv_covers_seq: 5 });
  env._hook = { re: /FROM reservations WHERE start_at/, fn: () => env._db.prepare('UPDATE customer_sync_version SET dirty_seq = 6 WHERE customer_id = ?').run(C2) };
  ok('④-12 ★後の門：読む間に別の会員の印が入ったら捨てる（トレーナーの一覧）', (await compatTrainerReservations({ env, who: own, body: {} }))._fallback === true);
  setSv(env, C2, { resv_covers_seq: 6 });
  //   ★顧客表に無い会員の古い行は全体の門を閉じない（covers は二度と進まないので、閉じると一覧が永久に GAS）
  setSv(env, 'C4599999999999', { dirty_seq: 9 });
  ok('④-12b 顧客表に無い会員の閉じた行では一覧を止めない', Array.isArray((await compatTrainerReservations({ env, who: own, body: {} })).reservations));

  //   boot（会員・トレーナー）・顧客詳細
  ok('④-13 開いていれば会員の boot を返す', !(await routeBoot({ env, who: who1, ctx: ctxOf() }))._fallback);
  setSv(env, C1, { resv_covers_seq: 2 });
  ok('④-14 ★会員の boot：予約一覧が閉じていれば全体 FALLBACK', (await routeBoot({ env, who: who1, ctx: ctxOf() }))._fallback === true);
  ok('④-15 ★トレーナーの boot（今後の件数）：誰か閉じていれば FALLBACK', (await routeBoot({ env, who: own, ctx: ctxOf() }))._fallback === true);
  ok('④-16 ★顧客詳細：予約一覧が閉じていれば FALLBACK', (await routeCustomerDetail({ env, body: { customerId: C1 }, who: who1 }))._fallback === true);
  setSv(env, C1, { resv_covers_seq: 3, home_covers_seq: 2 });
  ok('④-17 会員状態：home が閉じていれば FALLBACK', (await compatMemberStatus({ env, who: who1, ctx: ctxOf() }))._fallback === true);
  setSv(env, C1, { home_covers_seq: 3 });

  //   数える
  const n = env._db.prepare("SELECT source, n FROM remain_source_daily WHERE entry = 'covers' ORDER BY source").all().map((x) => x.source + ':' + x.n).join(',');
  ok('④-18 門で答えなかった回を entry covers に数える（home／resv）', /home:\d+/.test(n) && /resv:\d+/.test(n), n);
}

// ================= ⑤ 予約を読む SQL の全経路 =================
console.log('=== ⑤ 全経路 ===');
{
  const SRC = join(W, 'src');
  const files = [];
  (function walk(d) { for (const f of readdirSync(d, { withFileTypes: true })) { const p = join(d, f.name); if (f.isDirectory()) walk(p); else if (f.name.endsWith('.js')) files.push(p); } })(SRC);
  const found = {};
  for (const f of files) {
    const s = readFileSync(f, 'utf8');
    const n = (s.match(/\b(FROM|JOIN)\s+reservations\b/gi) || []).length;
    if (n) found[f.slice(SRC.length + 1)] = n;
  }
  //   ★ここに無いファイル・数が変わったら落とす（新しい経路は門を通してから数を足す）。remain-from-d1 は I31 が先に守る（関門① 低1）
  const EXPECT = { 'routes/boot.js': 3, 'routes/compat.js': 3, 'routes/customer.js': 1, 'routes/karte.js': 2, 'lib/remain-from-d1.js': 1 };
  ok('⑤-1 ★予約を読む SQL は既知の経路だけ（数まで一致）', JSON.stringify(Object.keys(found).sort().reduce((o, k) => (o[k] = found[k], o), {})) === JSON.stringify(Object.keys(EXPECT).sort().reduce((o, k) => (o[k] = EXPECT[k], o), {})), JSON.stringify(found));
  for (const f of Object.keys(EXPECT).filter((x) => x !== 'lib/remain-from-d1.js')) {
    const s = readFileSync(join(SRC, f), 'utf8');
    ok('⑤-2 ' + f + ' は門を使う', /from '\.\.\/lib\/write-covers\.js'/.test(s) && /(oneClosed|anyResvClosed|coversGate)\(/.test(s));
  }
}

// ================= ⑥ /quota/status =================
console.log('=== ⑥ 見張り ===');
{
  const env = makeEnv(); seed(env);
  setSv(env, C1, { dirty_seq: 5, home_covers_seq: 4, home_blocked_since: NOW - 15 * 60000, resv_covers_seq: 5 });
  setSv(env, C2, { dirty_seq: 5 });                          // 移行の残り（covers も since も NULL）
  setSv(env, CW, { dirty_seq: 5 });                          // 退会：数えない
  setSv(env, C3, { dirty_seq: 0 });                          // 書き込みの印なし：開いている
  setSv(env, 'C4599999999999', { dirty_seq: 5 });             // 顧客表に無い：数えない
  const res = await quotaStatus(new Request('https://x/quota/status', { headers: { 'X-Ingest-Secret': SECRET } }), env);
  const j = await res.json();
  const w = j.syncVersion && j.syncVersion.writeCovers;
  ok('⑥-1 閉じている数（退会を除く）・移行の残り・最も古い時刻', w && w.table === 'ok' && w.homeClosed === 2 && w.resvClosed === 1 && w.homeRemnant === 1 && w.resvRemnant === 1
     && w.homeOldestSince === NOW - 15 * 60000, JSON.stringify(w));
  ok('⑥-2 ★会員IDを出さない', !JSON.stringify(w).includes('C45'));
}

console.log(`\n${fail ? '❌' : '✅'} 設計45 I79 写しが書き込みの印を含むか 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
