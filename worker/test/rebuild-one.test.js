// /quota/rebuild と書き込みの通し番号を、本物の SQLite に全 migration を流して入口から通す（設計20・決定0091）。
//   実行: node worker/test/rebuild-one.test.js
//
// ★なぜ本物の SQLite か
//   新しさの判定は「同じ batch の中の1文」で決まる（markBuilt の CASE・dirty の MAX）。
//   身代わりの DB ではその順番と原子性を再現できない（2026-10-15、身代わりが CHECK を再現せず事故になった）。

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { quotaRebuild, REBUILD_LIMITS } from '../src/routes/quota-rebuild.js';
import { quotaBehind, buildQuota } from '../src/routes/quota.js';
import { handleIngest } from '../src/routes/ingest.js';
import { readSyncVersion, isFresh } from '../src/lib/sync-version.js';
import { readRemainDiag } from '../src/lib/remain-from-d1.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const W = join(HERE, '..');
const SECRET = 'TEST-SECRET';

let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) pass++; else { fail++; console.log(`❌ ${name}${detail ? '\n   ' + detail : ''}`); } }

// ---------------- D1 の身代わり（実物の SQLite・全 migration）----------------
function makeEnv(o = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(W, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(join(W, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    try { db.exec(readFileSync(join(W, 'migrations', f), 'utf8')); } catch (e) {
      if (!/duplicate column/.test(e.message)) throw e;   // schema.sql が既に持っている列だけ許す
    }
  }
  const env = { SHARED_SECRET: SECRET, LB_D1_REMAIN_MODE: 'off', _db: db, _beforeBatch: null, _failOn: null, _log: [] };
  const exec = (q, args, how) => {
    if (env._failOn && env._failOn.test(q)) throw new Error('SIMULATED_DB_FAILURE');
    const st = db.prepare(q);
    if (how === 'first') { const r = st.get(...args); return r === undefined ? null : r; }
    if (how === 'all') return { results: st.all(...args) };
    const r = st.run(...args);
    return { meta: { changes: Number(r.changes) } };
  };
  env.DB = {
    prepare(q) {
      return {
        _q: q, _args: [],
        bind(...a) { this._args = a; return this; },
        async run() { return exec(q, this._args, 'run'); },
        async first() { return exec(q, this._args, 'first'); },
        async all() { return exec(q, this._args, 'all'); },
      };
    },
    async batch(stmts) {
      if (env._beforeBatch) { const h = env._beforeBatch; env._beforeBatch = null; h(db); }
      db.exec('BEGIN');
      try { const out = stmts.map((s) => exec(s._q, s._args, 'run')); db.exec('COMMIT'); return out; }
      catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
    },
  };
  return env;
}
const q1 = (env, sql, ...a) => { const r = env._db.prepare(sql).get(...a); return r ? Object.assign({}, r) : null; };
const qa = (env, sql, ...a) => env._db.prepare(sql).all(...a).map((r) => Object.assign({}, r));

// ---------------- 見本（calc-input.test.js と同じ形）----------------
const COLS = { name: 1, type: 2, course: 5, freq: 8, ticket: 6, start: 10, end: 11,
               carry: -1, carryCap: 20, phone: 15, method: 16, trainer: 3,
               custId: -1, ticketPrice: 19, packId: -1, normalPrice: 17 };
const jst = (y, m, d, h = 12) => Date.UTC(y, m - 1, d, h - 9);
const CID = 'C20260903214526';
function crow(o) {
  const r = new Array(23).fill('');
  r[COLS.name] = '山田太郎様'; r[COLS.type] = 'チケット'; r[COLS.method] = 'チケット';
  r[COLS.ticket] = o.ticket; r[COLS.ticketPrice] = 5000;
  return r;
}
function rrow(o) {
  const r = new Array(15).fill('');
  r[0] = o.ms; r[2] = CID; r[6] = 'confirmed'; r[8] = o.resId; r[9] = 'line';
  return r;
}
const contractRow = (idx, ticket) => ({
  row_key: `${CID}#${idx}`, customer_id: CID, idx,
  row_json: JSON.stringify(crow({ ticket })), start_ms: jst(2026, 9, 1), end_ms: jst(2026, 12, 31),
});
const resvRow = (resId, ms) => ({ row_key: `${CID}#${resId}`, customer_id: CID, row_json: JSON.stringify(rrow({ resId, ms })) });

function seedMeta(env) {
  env._db.prepare("INSERT INTO calc_meta (key, payload, synced_at) VALUES ('contract_cols', ?, 1)")
    .run(JSON.stringify({ cols: COLS, headers: [] }));
}
function seedVersion(env, s, b, covers = 0, dirty = 0) {
  env._db.prepare(`INSERT INTO customer_sync_version (customer_id, source_version, built_version, built_covers_seq, dirty_seq)
                   VALUES (?, ?, ?, ?, ?)`).run(CID, s, b, covers, dirty);
}
const req = (body, secret = SECRET, raw) => new Request('https://x/quota/rebuild', {
  method: 'POST', headers: secret == null ? {} : { 'X-Ingest-Secret': secret },
  body: raw != null ? raw : JSON.stringify(body),
});
const body = (o = {}) => Object.assign({
  customerId: CID, seq: 7, from: '2026-09', to: '2026-12',
  contracts: [contractRow(0, 3)], reservations: [resvRow('r1', jst(2026, 10, 5))], opening: null,
}, o);
const call = async (env, b, secret) => { const r = await quotaRebuild(req(b, secret), env); return [r.status, await r.json()]; };

// ---------- 1. 合言葉と入力の検査 ----------
{
  const env = makeEnv(); seedMeta(env);
  ok('1-1 合言葉が無ければ断る', (await call(env, body(), null))[0] === 403);
  ok('1-2 違う合言葉も断る', (await call(env, body(), 'wrong'))[0] === 403);
  const [s3, b3] = await call(env, body({ contracts: [Object.assign(contractRow(0, 3), { customer_id: 'COTHER' })] }));
  ok('1-3 ★他の会員の行が1つでもあれば全体を断る', s3 === 400 && b3.code === 'CUSTOMER_MISMATCH');
  ok('1-4 断ったときは何も書かない', q1(env, 'SELECT COUNT(*) AS n FROM calc_contract_rows').n === 0);
  for (const bad of [0, -1, 1.5, '7', null]) {
    const [s] = await call(env, body({ seq: bad }));
    ok(`1-5 通し番号は正の整数だけ（${JSON.stringify(bad)}）`, s === 400);
  }
  const [s6] = await call(env, body({ contracts: [contractRow(0, 3), contractRow(0, 2)] }));
  ok('1-6 契約の行番号の重複は断る', s6 === 400);
  const big = Array.from({ length: REBUILD_LIMITS.RESV_ROWS + 1 }, (_, i) => resvRow('x' + i, jst(2026, 10, 5)));
  const [s7, b7] = await call(env, body({ reservations: big }));
  ok('1-7 予約が多すぎれば 413', s7 === 413 && b7.kind === 'reservations');
  //   ★文字数ではなくバイト数で測る：日本語 10万字＝約30万バイト（上限 256KiB を超える）が、文字数は上限より少ない
  const jp = JSON.stringify(body({ contracts: [Object.assign(contractRow(0, 3), { row_json: JSON.stringify(['あ'.repeat(100000)]) })] }));
  const rj = await quotaRebuild(new Request('https://x/quota/rebuild', { method: 'POST', headers: { 'X-Ingest-Secret': SECRET }, body: jp }), env);
  const bj = await rj.json();
  ok('1-7b ★本文はバイト数で測る（日本語の多い本文）', jp.length < REBUILD_LIMITS.BODY_BYTES && rj.status === 413 && bj.kind === 'body', `${jp.length} ${rj.status}`);
  const r8 = await quotaRebuild(req(null, SECRET, '{"customerId":"' + CID + '", 山田太郎様'), env);
  const t8 = await r8.text();
  ok('1-8 ★壊れた本文でも本文を返さない', r8.status === 400 && t8.indexOf('山田') < 0, t8);
  const env2 = makeEnv();   // calc_meta が無い
  const [s9, b9] = await call(env2, body());
  ok('1-9 列の並びが無ければ何も書かない（409）', s9 === 409 && b9.code === 'NO_META'
     && q1(env2, 'SELECT COUNT(*) AS n FROM calc_contract_rows').n === 0);
}

// ---------- 2. 1回の rebuild で入力・作り直し・記録がそろう ----------
{
  const env = makeEnv(); seedMeta(env); seedVersion(env, 5, 5, 0, 7);
  const [s, b] = await call(env, body({ seq: 7 }));
  ok('2-1 成功する', s === 200 && b.ok === true && b.blocked === false, JSON.stringify(b));
  const v = await readSyncVersion(env, CID);
  ok('2-2 ★世代は ver0+1 でそろう（source=built=6）', v.sourceVersion === 6 && v.builtVersion === 6, JSON.stringify(v));
  ok('2-3 ★covers は通し番号まで進む', v.coversSeq === 7);
  ok('2-4 ★新しいと名乗る', isFresh(v) === true);
  ok('2-5 契約・予約の入力が書かれている', q1(env, 'SELECT COUNT(*) AS n FROM calc_contract_rows WHERE customer_id=?', CID).n === 1
     && q1(env, 'SELECT COUNT(*) AS n FROM calc_reservation_rows WHERE customer_id=?', CID).n === 1);
  ok('2-6 パックが今の世代で書かれている', q1(env, 'SELECT COUNT(*) AS n FROM ticket_packs WHERE customer_id=? AND built_version=6', CID).n === 1);
  ok('2-7 引当が1件', q1(env, 'SELECT COUNT(*) AS n FROM reservation_allocations WHERE customer_id=?', CID).n === 1);
  ok('2-8 応答に氏名・行の中身が無い', JSON.stringify(b).indexOf('山田') < 0 && JSON.stringify(b).indexOf('row_json') < 0);
  ok('2-9 dirty_since は追いついたので NULL', v.dirtySince === null);

  // 2-10 契約を減らして作り直す（行の入れ替え）
  const [, b2] = await call(env, body({ seq: 8, contracts: [contractRow(0, 2)] }));
  ok('2-10 入れ替えた契約で作り直す', b2.ok && q1(env, 'SELECT total FROM ticket_packs WHERE customer_id=? AND built_version=7', CID).total === 2);
  const [, b3] = await call(env, body({ seq: 9, reservations: [] }));
  ok('2-11 ★予約が0件になったら入力の行も消える（取消が伝わる）', b3.ok
     && q1(env, 'SELECT COUNT(*) AS n FROM calc_reservation_rows WHERE customer_id=?', CID).n === 0
     && q1(env, 'SELECT COUNT(*) AS n FROM reservation_allocations WHERE customer_id=?', CID).n === 0);
}

// ---------- 3. ★通し番号の競合（設計20 §4）----------
{
  // ② 走っている後追い処理が古い台帳（S0=8）で作り直す。その間に書き込み（dirty=10）
  const env = makeEnv(); seedMeta(env); seedVersion(env, 5, 5, 0, 0);
  env._db.prepare('UPDATE customer_sync_version SET dirty_seq = 10, dirty_since = 123 WHERE customer_id = ?').run(CID);
  const [, b] = await call(env, body({ seq: 8 }));
  const v = await readSyncVersion(env, CID);
  ok('3-1 ★古い番号の作り直しは名乗らない（covers<dirty）', b.ok && v.coversSeq === 8 && v.dirtySeq === 10 && isFresh(v) === false, JSON.stringify(v));
  const d = await readRemainDiag(env, CID, Date.now());
  ok('3-2 ★読み取りは behind_write で答えない', d && d.status === 'behind_write', JSON.stringify(d && d.status));
  ok('3-3 dirty_since は追いつくまで残る', v.dirtySince === 123);
  const [, b2] = await call(env, body({ seq: 10 }));
  const v2 = await readSyncVersion(env, CID);
  ok('3-4 番号が届いた作り直しで名乗る', b2.ok && isFresh(v2) === true && v2.dirtySince === null);
  // ⑦ 再送：同じ番号でもう一度
  const [, b3] = await call(env, body({ seq: 10 }));
  const v3 = await readSyncVersion(env, CID);
  ok('3-5 ★再送しても名乗ったまま（source と built が一緒に進む・covers は同じ）', b3.ok && isFresh(v3) && v3.coversSeq === 10
     && v3.sourceVersion === v2.sourceVersion + 1, JSON.stringify(v3));
  // ⑱ 古い番号の再送が後から届く → covers は下がらない
  const [, b4] = await call(env, body({ seq: 9 }));
  const v4 = await readSyncVersion(env, CID);
  ok('3-6 古い番号の再送でも covers は下がらない（MAX）', b4.ok && v4.coversSeq === 10);
}
{
  // ⑭⑮ ver0 を読んだ後、batch の前に別の入力で source が進む
  const env = makeEnv(); seedMeta(env); seedVersion(env, 5, 5, 3, 3);
  env._beforeBatch = (db) => db.prepare('UPDATE customer_sync_version SET source_version = source_version + 1 WHERE customer_id = ?').run(CID);
  const [, b] = await call(env, body({ seq: 7 }));
  const v = await readSyncVersion(env, CID);
  ok('3-7 ★途中で入力が来たら built=0（名乗らない）', b.ok && v.builtVersion === 0 && isFresh(v) === false, JSON.stringify(v));
  ok('3-8 ★そのとき covers は進めない', v.coversSeq === 3);
}

// ---------- 4. batch の失敗（全部か無しか）----------
{
  const env = makeEnv(); seedMeta(env); seedVersion(env, 5, 5, 2, 2);
  env._failOn = /INSERT INTO reservation_allocations/;
  const [s, b] = await call(env, body({ seq: 7 }));
  const v = await readSyncVersion(env, CID);
  ok('4-1 書き込みに失敗したら 503・code だけ', s === 503 && b.code === 'WRITE_FAILED' && JSON.stringify(b).indexOf('SIMULATED') < 0);
  ok('4-2 ★何も変わっていない（入力・世代・covers）', v.sourceVersion === 5 && v.builtVersion === 5 && v.coversSeq === 2
     && q1(env, 'SELECT COUNT(*) AS n FROM calc_contract_rows').n === 0);
}

// ---------- 5. 写しの送信の印（ingest home + dirtySeq）----------
async function ingest(env, b) { const r = await handleIngest(new Request('https://x/ingest', {
  method: 'POST', headers: { 'X-Ingest-Secret': SECRET }, body: JSON.stringify(b) }), env); return [r.status, await r.json()]; }
{
  const env = makeEnv(); seedMeta(env); seedVersion(env, 5, 5, 7, 7);
  const homeRow = { customer_id: CID, payload: '{}', computed_at: 1 };
  const [s, b] = await ingest(env, { kind: 'home', batchId: Date.now(), scope: 'partial', rows: [homeRow], dirtySeq: 11 });
  const v = await readSyncVersion(env, CID);
  ok('5-1 写しと同じ batch で dirty が立つ', s === 200 && b.dirtied === 1 && v.dirtySeq === 11 && isFresh(v) === false, JSON.stringify(b));
  ok('5-2 dirty_since が付く', v.dirtySince != null);
  const since = v.dirtySince;
  await ingest(env, { kind: 'home', batchId: Date.now() + 1, scope: 'partial', rows: [Object.assign({}, homeRow, { computed_at: 2 })], dirtySeq: 12 });
  const v2 = await readSyncVersion(env, CID);
  ok('5-3 ★追加の書き込みで dirty_since は動かない', v2.dirtySeq === 12 && v2.dirtySince === since);
  await ingest(env, { kind: 'home', batchId: Date.now() + 2, scope: 'partial', rows: [homeRow], dirtySeq: 11 });
  ok('5-4 ★古い番号の再送で dirty は下がらない（MAX）', (await readSyncVersion(env, CID)).dirtySeq === 12);
  const [s5, b5] = await ingest(env, { kind: 'calcContracts', batchId: Date.now() + 3, scope: 'partial', rows: [], dirtySeq: 5 });
  ok('5-5 home 以外に番号を付けたら断る', s5 === 400 && b5.code === 'DIRTY_SEQ_NOT_SUPPORTED');
  const [s6] = await ingest(env, { kind: 'home', batchId: Date.now() + 4, scope: 'partial', rows: [homeRow], dirtySeq: '12' });
  ok('5-6 番号が整数でなければ断る', s6 === 400);
  //   番号の無い（定期の）写しは何も変えない
  await ingest(env, { kind: 'home', batchId: Date.now() + 5, scope: 'partial', rows: [Object.assign({}, homeRow, { computed_at: 3 })] });
  ok('5-7 定期の写しは dirty を変えない', (await readSyncVersion(env, CID)).dirtySeq === 12);
  //   行が無い会員：0/0 の行ができる（not_built で答えない）
  await ingest(env, { kind: 'home', batchId: Date.now() + 6, scope: 'partial', rows: [{ customer_id: 'CNEW', payload: '{}', computed_at: 1 }], dirtySeq: 13 });
  const vn = q1(env, 'SELECT source_version, built_version, dirty_seq FROM customer_sync_version WHERE customer_id = ?', 'CNEW');
  ok('5-8 行が無い会員には 0/0 の行（答えない）', vn && vn.source_version === 0 && vn.built_version === 0 && vn.dirty_seq === 13);
}

// ---------- 6. 修復の巡回（/quota/behind）は「名乗れない」会員を拾う ----------
{
  const env = makeEnv();
  const ins = (cid, s, b, c, d) => env._db.prepare(`INSERT INTO customer_sync_version (customer_id, source_version, built_version, built_covers_seq, dirty_seq) VALUES (?,?,?,?,?)`).run(cid, s, b, c, d);
  ins('A_fresh', 3, 3, 5, 5);
  ins('B_srcAhead', 4, 3, 0, 0);
  ins('C_writeBehind', 3, 3, 4, 6);
  ins('D_neverInput', 0, 0, 0, 9);
  ins('E_built0', 2, 0, 0, 0);
  const r = await quotaBehind(new Request('https://x/quota/behind?limit=50', { headers: { 'X-Ingest-Secret': SECRET } }), env);
  const j = await r.json();
  const ids = (j.customerIds || []).join(',');
  ok('6-1 ★書き込みに追いついていない会員を拾う', ids.indexOf('C_writeBehind') >= 0, ids);
  ok('6-2 世代が遅れている会員を拾う（前と同じ）', ids.indexOf('B_srcAhead') >= 0 && ids.indexOf('E_built0') >= 0, ids);
  ok('6-3 新しい会員は拾わない', ids.indexOf('A_fresh') < 0, ids);
  ok('6-4 ★一度も入力が来ていない会員（印だけの 0/0）は拾わない', ids.indexOf('D_neverInput') < 0, ids);
}

// ---------- 7. 通常の作り直し（/quota/build）は covers を変えない ----------
{
  const env = makeEnv(); seedMeta(env); seedVersion(env, 5, 5, 4, 6);
  //   計算入力を D1 に置く（sync_state も新しく）
  for (const k of ['calcContracts', 'calcReservations', 'opening']) {
    env._db.prepare('INSERT INTO sync_state (key, synced_at, rows, ok) VALUES (?, ?, 1, 1)').run(k, Date.now());
  }
  const c = contractRow(0, 3);
  env._db.prepare('INSERT INTO calc_contract_rows (row_key, customer_id, idx, row_json, start_ms, end_ms, synced_at) VALUES (?,?,?,?,?,?,1)')
    .run(c.row_key, CID, 0, c.row_json, c.start_ms, c.end_ms);
  const r = await buildQuota(new Request(`https://x/quota/build?dry=0&alloc=1&customer=${CID}&from=2026-09&to=2026-12`,
    { headers: { 'X-Ingest-Secret': SECRET } }), env);
  const j = await r.json();
  const v = await readSyncVersion(env, CID);
  ok('7-1 通常の作り直しは成功する', r.status === 200 && j.ok !== false, JSON.stringify(j).slice(0, 200));
  ok('7-2 ★covers は変わらない（4 のまま）＝dirty=6 に届かず名乗らない', v.coversSeq === 4 && v.builtVersion === 5 && isFresh(v) === false, JSON.stringify(v));
}

// ---------- 8. ★rebuild が書いた入力は、定期送信の same() と一致する（毎回 source を進めない）----------
{
  const env = makeEnv(); seedMeta(env); seedVersion(env, 5, 5, 0, 0);
  const b = body({ seq: 7 });
  await call(env, b);
  const before = (await readSyncVersion(env, CID)).sourceVersion;
  const [, j] = await ingest(env, { kind: 'calcContracts', batchId: Date.now() + 10, scope: 'all', rows: b.contracts });
  const [, j2] = await ingest(env, { kind: 'calcReservations', batchId: Date.now() + 11, scope: 'all', rows: b.reservations });
  const after = (await readSyncVersion(env, CID)).sourceVersion;
  ok('8-1 ★同じ中身の定期送信では世代が進まない（名乗ったまま）', after === before && j.bumped === 0 && j2.bumped === 0,
     `before=${before} after=${after} ${JSON.stringify(j)}`);
}

// ---------- 9. 重複パック（切り替えの合格条件）は、顧客に答える会員のいまの世代だけを数える ----------
{
  const { quotaStatus } = await import('../src/routes/quota.js');
  const env = makeEnv();
  const ins = (cid, s, b, c, d) => env._db.prepare(`INSERT INTO customer_sync_version (customer_id, source_version, built_version, built_covers_seq, dirty_seq) VALUES (?,?,?,?,?)`).run(cid, s, b, c, d);
  const pack = (pid, cid, bv) => env._db.prepare(`INSERT INTO ticket_packs (pack_id, customer_id, kind, total, used, valid_from, valid_to, updated_at, built_version)
                                                   VALUES (?, ?, 'normal', 2, 0, 1, 2, 1, ?)`).run(pid, cid, bv);
  ins('CFRESH0001', 3, 3, 5, 5);
  pack('CT100_200_1', 'CFRESH0001', 3); pack('CT100_200_4', 'CFRESH0001', 3);   // 同じ prefix が2行＝重複
  ins('CWRITE0002', 3, 3, 4, 9);                                                 // 書き込みに追いついていない
  pack('CT100_200_1x', 'CWRITE0002', 3);
  pack('CT300_400_1', 'CWRITE0002', 3); pack('CT300_400_2', 'CWRITE0002', 3);
  pack('CT500_600_1', 'CFRESH0001', 2);                                          // 古い世代の行
  pack('CT500_600_2', 'CFRESH0001', 3);
  const r = await quotaStatus(new Request('https://x/quota/status', { headers: { 'X-Ingest-Secret': SECRET } }), env);
  const j = await r.json();
  ok('9-1 ★重複は顧客に答える会員のいまの世代だけ（追いついていない会員・古い世代は数えない）',
     j.dupPackPrefix && j.dupPackPrefix.groups === 1 && j.dupPackPrefix.customers.join() === '*0001', JSON.stringify(j.dupPackPrefix));
  ok('9-2 生の pack_id を返さない', JSON.stringify(j.dupPackPrefix).indexOf('CT100') < 0);
  ok('9-3 書き込みに追いついていない会員を数える', j.syncVersion && j.syncVersion.writeBehind === 1, JSON.stringify(j.syncVersion));
}

console.log(`\n${fail ? '❌' : '✅'} rebuild と通し番号 検証: ${pass} passed / ${fail} failed`);
if (fail) process.exit(1);
