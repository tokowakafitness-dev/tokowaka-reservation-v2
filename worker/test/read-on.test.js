// 残数を D1 から顧客に出す（設計21・決定0092）を、本物の SQLite に全 migration を流して入口から通す。
//   実行: node worker/test/read-on.test.js
//
//   ① 6つの入口が、mode・選択・D1 の状態ごとに、どこから答えるか（状態の表＝3(b)「D1 が答えないとき写しへ落ちるか」）
//   ② mode が 'on' でない・選ばれていない会員の答えは、変更前と1文字も同じ（I37）
//   ③ 写しを土台に COMPARE_FIELDS だけ上書き・振替権は残る・_src/_packOverUse は出ない（I36）
//   ④ 数える：選ばれた会員だけ・日×入口の合計500・_dropped は1回（I39）
//   ⑤ 許可表の窓口・試し読みの窓口（I40）
//   ⑥ 予約一覧の送信の書き込みの印（予約0件でも・設計21 §2-5）
//   ⑦ 公開の場所（wrangler.toml・job.json）に会員 ID を書いていない（I38）

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { quotaRebuild } from '../src/routes/quota-rebuild.js';
import { readHome } from '../src/routes/boot.js';
import { routeBoot } from '../src/routes/boot.js';
import { compatMemberStatus, compatBookingOptions, compatCustomerHome } from '../src/routes/compat.js';
import { routeBookingOptions } from '../src/routes/slots.js';
import { routeCustomerDetail } from '../src/routes/customer.js';
import { remainAllow, remainProbe } from '../src/routes/remain-allow.js';
import { handleIngest } from '../src/routes/ingest.js';
import { readSyncVersion } from '../src/lib/sync-version.js';
import { DAILY_CAP, READ_ENTRIES, countSource } from '../src/lib/remain-read-on.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const W = join(HERE, '..');
const SECRET = 'S';
let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) pass++; else { fail++; console.log(`❌ ${name}${detail ? '\n   ' + detail : ''}`); } }

function makeEnv(vars = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(W, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(join(W, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    try { db.exec(readFileSync(join(W, 'migrations', f), 'utf8')); } catch (e) { if (!/duplicate column/.test(e.message)) throw e; }
  }
  const env = Object.assign({ SHARED_SECRET: SECRET, LB_D1_REMAIN_MODE: 'shadow', _db: db, _break: null,
    KV: { get: async () => null, put: async () => {} } }, vars);
  const exec = (q, a, how) => {
    if (env._break && env._break.test(q)) throw new Error('SIMULATED');
    const st = db.prepare(q);
    if (how === 'first') { const r = st.get(...a); return r === undefined ? null : r; }
    if (how === 'all') return { results: st.all(...a) };
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
const ctxOf = () => { const p = []; return { waitUntil: (x) => p.push(Promise.resolve(x)), _wait: () => Promise.all(p) }; };

// ---------------- 見本 ----------------
const COLS = { name: 1, type: 2, course: 5, freq: 8, ticket: 6, start: 10, end: 11, carry: -1, carryCap: 20, phone: 15,
               method: 16, trainer: 3, custId: -1, ticketPrice: 19, packId: -1, normalPrice: 17 };
const jst = (y, m, d, h = 12) => Date.UTC(y, m - 1, d, h - 9);
const CID = 'C20260101000001';
const VER = 'CVERIFY0000001';
const NOW = Date.now();
const monthKey = (ms) => { const d = new Date(ms + 9 * 3600000); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); };

async function seed(env, cid, o = {}) {
  const db = env._db;
  if (!db.prepare("SELECT 1 FROM calc_meta WHERE key='contract_cols'").get()) {
    db.prepare("INSERT INTO calc_meta (key, payload, synced_at) VALUES ('contract_cols', ?, 1)").run(JSON.stringify({ cols: COLS, headers: [] }));
  }
  db.prepare('INSERT OR REPLACE INTO customers (customer_id, name, contract_status, created_at, updated_at) VALUES (?, ?, ?, 1, 1)').run(cid, '山田太郎', 'active');
  const r = new Array(23).fill(''); r[1] = '山田太郎様'; r[2] = '通常'; r[16] = '月額'; r[8] = 4;
  const row = { row_key: cid + '#0', customer_id: cid, idx: 0, row_json: JSON.stringify(r), start_ms: jst(2026, 9, 1), end_ms: null };
  const res = await quotaRebuild(new Request('https://x', { method: 'POST', headers: { 'X-Ingest-Secret': SECRET },
    body: JSON.stringify({ customerId: cid, seq: 1, from: '2026-09', to: '2027-03', contracts: [row], reservations: [], opening: null }) }), env);
  if (res.status !== 200) throw new Error('seed rebuild ' + res.status);
  //   写し：D1 とは**違う残数**（3）にして、どちらから答えたか分かるようにする
  const cur = { type: 'monthly', active: true, nextMonth: null, quota: 4, carryover: 0, thisMonth: 1, monthlyRemaining: 3,
    ticketTotal: 0, ticketRemaining: 0, ticketExpire: '', ticketExpireMs: null, pairRemaining: 0, pairPackMax: 0,
    normalTicketRemaining: 0, hasNormalRoute: true, ticketPacks: [], remaining: 3, overageCount: 0, displayRemaining: 3,
    paymentRequired: false, total: 0, used: 0, expire: '', expireMs: null, copyOnlyKey: 'keep-me' };
  if (o.reviewRequired) cur.reviewRequired = true;
  const payload = { current: cur, currentMonth: o.month || monthKey(NOW), transferCredits: { available: 2 } };
  db.prepare('INSERT OR REPLACE INTO member_home (customer_id, payload, computed_at, synced_at) VALUES (?, ?, ?, 1)')
    .run(cid, JSON.stringify(payload), NOW - 60000);
}
const allow = (env, cid) => env._db.prepare('INSERT OR IGNORE INTO remain_d1_allow (customer_id, added_at) VALUES (?, 1)').run(cid);
const counts = (env) => env._db.prepare('SELECT entry, source, n FROM remain_source_daily ORDER BY entry, source').all().map((x) => Object.assign({}, x));

// ---------- ② 変更前と1文字も同じ ----------
{
  for (const mode of ['shadow', 'off', '', 'ON', 'true']) {
    const env = makeEnv({ LB_D1_REMAIN_MODE: mode }); await seed(env, CID); allow(env, CID);
    const h = await readHome(env, CID, undefined, { readEntry: 'compat_member' });
    ok(`②-1 mode '${mode}' は写しのまま・remainSource を付けない`, h.remaining === 3 && !('remainSource' in h));
  }
  const env = makeEnv({ LB_D1_REMAIN_MODE: 'on' }); await seed(env, CID);
  const h = await readHome(env, CID, undefined, { readEntry: 'compat_member' });
  ok('②-2 ★mode on でも選ばれていない会員は写しのまま・remainSource を付けない', h.remaining === 3 && !('remainSource' in h), JSON.stringify(h).slice(0, 120));
  //   ★「1文字も同じ」を本当に全体で比べる（computedAt・ageMs・stale は時刻で動くので除いて比べる）
  const { readHomeDiag } = await import('../src/routes/boot.js');
  const strip = (o) => { const c = Object.assign({}, o); delete c.ageMs; delete c.stale; return JSON.stringify(c); };
  const base = (await readHomeDiag(env, CID)).value;
  ok('②-2b ★非選択の応答は写しの読み取りと JSON で同じ', strip(h) === strip(base));
  const envS = makeEnv({ LB_D1_REMAIN_MODE: 'shadow' }); await seed(envS, CID); allow(envS, CID);
  ok('②-2c ★mode shadow の応答は写しの読み取りと JSON で同じ', strip(await readHome(envS, CID)) === strip((await readHomeDiag(envS, CID)).value));
  ok('②-3 選ばれていない会員は数えない', counts(env).length === 0);
  env._break = /remain_d1_allow/;
  const h2 = await readHome(env, CID, undefined, { readEntry: 'compat_member' });
  ok('②-4 ★許可表が読めなければ選ばれていない＝写しのまま（形も変えない）', h2.remaining === 3 && !('remainSource' in h2));
  const dg = {};
  await readHome(env, CID, undefined, { diag: dg });
  ok('②-4b 理由は診断に allow_read_failed として残る（顧客の応答には出ない）', dg.result && dg.result.status === 'allow_read_failed', JSON.stringify(dg));
  const env3 = makeEnv({ LB_D1_REMAIN_MODE: 'on', LB_D1_REMAIN_ALL: 'true' }); await seed(env3, CID);
  ok('②-5 LB_D1_REMAIN_ALL は "1" の完全一致だけ', !('remainSource' in (await readHome(env3, CID))));
}

// ---------- ①③ D1 で答える／写しに落ちる ----------
{
  const env = makeEnv({ LB_D1_REMAIN_MODE: 'on' }); await seed(env, CID); allow(env, CID);
  const ctx = ctxOf();
  const h = await readHome(env, CID, undefined, { ctx, readEntry: 'compat_member' });
  await ctx._wait();
  ok('①-1 ★選ばれた会員は D1 で答える', h.remainSource === 'd1' && h.remaining !== 3, JSON.stringify({ r: h.remaining, s: h.remainSource }));
  ok('③-1 ★写しにしか無い鍵が残る（振替権・その他）', h.transferCredits && h.transferCredits.available === 2 && h.copyOnlyKey === 'keep-me');
  ok('③-2 ★D1 にしか無い鍵は出ない', !('_src' in h) && !('_packOverUse' in h));
  ok('③-3 月・計算時刻は写しのもの', h.month === monthKey(NOW) && typeof h.computedAt === 'number');
  ok('①-2 作り直し時刻を付ける', typeof h.remainBuiltAt === 'number');
  ok('④-1 選ばれた会員は入口と出どころで数える', JSON.stringify(counts(env)) === JSON.stringify([{ entry: 'compat_member', source: 'd1', n: 1 }]), JSON.stringify(counts(env)));

  //   書き込みの直後（dirty > covers）→ 写し
  env._db.prepare('UPDATE customer_sync_version SET dirty_seq = 9 WHERE customer_id = ?').run(CID);
  const h2 = await readHome(env, CID, undefined, { readEntry: 'compat_member' });
  ok('①-3 ★書き込みに追いついていなければ写し（copy:behind_write）', h2.remaining === 3 && h2.remainSource === 'copy');
  env._db.prepare('UPDATE customer_sync_version SET dirty_seq = 0, source_version = source_version + 1 WHERE customer_id = ?').run(CID);
  ok('①-4 世代が遅れていれば写し（behind）', (await readHome(env, CID)).remainSource === 'copy');
  env._db.prepare('UPDATE customer_sync_version SET source_version = built_version WHERE customer_id = ?').run(CID);
  ok('①-5 戻れば D1', (await readHome(env, CID)).remainSource === 'd1');
  env._break = /FROM monthly_quota/;
  ok('①-6 ★D1 の読み取りが失敗したら写し', (await readHome(env, CID)).remainSource === 'copy');
  env._break = null;
  const far = jst(2027, 6, 10);
  ok('①-7 D1 が持っていない月（out_of_range）は写しの判断どおり（写しも無ければ null）', (await readHome(env, CID, far)) === null);
  const diag = {};
  await readHome(env, CID, undefined, { diag });
  ok('①-8 診断は固定の形', JSON.stringify(Object.keys(diag.result).sort()) === JSON.stringify(['monthMatch', 'selected', 'source', 'status']));

  //   写しが「出せない」と言う会員
  const env2 = makeEnv({ LB_D1_REMAIN_MODE: 'on' }); await seed(env2, CID, { reviewRequired: true }); allow(env2, CID);
  const h3 = await readHome(env2, CID);
  ok('①-9 ★reviewRequired の会員は D1 でも出さない', h3.remainSource === 'copy' && h3.remaining === 3);
  //   月の不一致
  const env4 = makeEnv({ LB_D1_REMAIN_MODE: 'on' }); await seed(env4, CID, { month: '2026-01' }); allow(env4, CID);
  const h4 = await readHome(env4, CID);
  ok('①-10 写しと D1 の月が違えば写し', h4 && h4.remainSource === 'copy', JSON.stringify(h4 && h4.remainSource));
  //   写しが無い
  const env5 = makeEnv({ LB_D1_REMAIN_MODE: 'on' }); await seed(env5, CID); allow(env5, CID);
  env5._db.prepare('DELETE FROM member_home WHERE customer_id = ?').run(CID);
  ok('①-11 ★写しが無ければ D1 があっても null（GAS へ・いまと同じ）', (await readHome(env5, CID)) === null);
  //   検証用の会員は完全一致で選ばれる・似た ID は選ばれない
  const env6 = makeEnv({ LB_D1_REMAIN_MODE: 'on' }); await seed(env6, VER); await seed(env6, 'CVERIFY00000012');
  ok('①-12 検証用の会員は許可表が無くても選ばれる', (await readHome(env6, VER)).remainSource === 'd1');
  ok('①-13 ★前方一致では選ばない', !('remainSource' in (await readHome(env6, 'CVERIFY00000012'))));
  const env7 = makeEnv({ LB_D1_REMAIN_MODE: 'on', LB_D1_REMAIN_ALL: '1' }); await seed(env7, CID);
  ok('①-14 LB_D1_REMAIN_ALL="1" なら全員', (await readHome(env7, CID)).remainSource === 'd1');
}

// ---------- ①-s mode 'on' でも shadow（写しと D1 の比較）は起動する ----------
{
  const { runDeferred } = await import('../src/routes/boot.js');
  for (const [mode, want] of [['on', true], ['shadow', true], ['off', false]]) {
    const env = makeEnv({ LB_D1_REMAIN_MODE: mode }); await seed(env, CID);
    const defer = [], ctx = ctxOf();
    let registered = 0; const wu = ctx.waitUntil; ctx.waitUntil = (x) => { registered++; return wu(x); };
    await readHome(env, CID, undefined, { shadow: true, ctx, entry: 'compat_member', defer, readEntry: 'compat_member' });
    runDeferred(defer);
    await ctx._wait();
    const n = env._db.prepare('SELECT COUNT(*) AS n FROM remain_shadow_slot2').get().n;
    ok(`①-s ★mode '${mode}' で比較が${want ? '起動する' : '起動しない'}（非選択の会員でも）`, want ? (registered >= 1 && n >= 1) : (registered === 0 && n === 0), `registered=${registered} slot=${n}`);
  }
}

// ---------- ① 6つの入口を通す ----------
{
  const env = makeEnv({ LB_D1_REMAIN_MODE: 'on' }); await seed(env, CID); allow(env, CID);
  for (const k of ['customers', 'reservations', 'recurring', 'trainers']) {
    env._db.prepare('INSERT OR REPLACE INTO sync_state (key, synced_at, rows, ok) VALUES (?, ?, 1, 1)').run(k, Date.now());
  }
  const cust = { role: 'customer', customerId: CID, name: '山田太郎' };
  const owner = { role: 'owner', trainerId: 'T1', name: 'オーナー' };
  const ctx = ctxOf();
  const m = await compatMemberStatus({ env, who: cust, ctx });
  ok('①-e1 compat_member：D1 で答える', m.home && m.home.remainSource === 'd1', JSON.stringify(m).slice(0, 160));
  const ctx2 = ctxOf();
  const ch = await compatCustomerHome({ env, body: { customerId: CID }, who: owner, ctx: ctx2 });
  ok('①-e2 compat_home：D1 で答える', ch && !ch._fallback && JSON.stringify(ch).indexOf('"remainSource":"d1"') >= 0, JSON.stringify(ch).slice(0, 160));
  const bo = await compatBookingOptions({ env, who: cust, body: { customerId: CID, startMs: NOW + 3600000 }, ctx: ctxOf() });
  ok('①-e3 booking_options：答える（D1 の残りから）', bo && !bo._fallback, JSON.stringify(bo).slice(0, 120));
  const rb = await routeBookingOptions({ env, who: cust, body: { customerId: CID, startMs: NOW + 3600000 }, ctx: ctxOf() });
  ok('①-e4 route_booking_options：答える', rb && !rb.fallback, JSON.stringify(rb).slice(0, 120));
  const cd = await routeCustomerDetail({ env, who: owner, body: { customerId: CID }, ctx: ctxOf() });
  ok('①-e5 customer_detail：D1 で答える', JSON.stringify(cd).indexOf('"remainSource":"d1"') >= 0, JSON.stringify(cd).slice(0, 160));
  const bt = await routeBoot({ env, who: cust, ctx: ctxOf() });
  ok('①-e6 boot：D1 で答える', bt && bt.home && bt.home.remainSource === 'd1', JSON.stringify(bt).slice(0, 160));
  await new Promise((r) => setTimeout(r, 20));
  const ents = new Set(counts(env).map((x) => x.entry));
  ok('④-2 ★6つの入口がそれぞれの名前で数えられる（unknown が無い）', READ_ENTRIES.every((e) => ents.has(e)) && !ents.has('unknown'), [...ents].join(','));
}

// ---------- ④ 数える上限 ----------
{
  const env = makeEnv();
  const now = Date.now();
  for (let i = 0; i < DAILY_CAP - 1; i++) await countSource(env, 'compat_member', 'd1', now);
  const a = await countSource(env, 'compat_member', 'copy:behind', now);   // 500回目
  const b = await countSource(env, 'compat_member', 'd1', now);            // 501回目
  const c = await countSource(env, 'compat_member', 'd1', now);            // 502回目
  const rows = counts(env);
  const sum = rows.filter((x) => !x.source.startsWith('_')).reduce((s, x) => s + x.n, 0);
  const dropped = rows.filter((x) => x.source === '_dropped');
  ok('④-3 ★500回目は数え、501回目から数えない（合計500）', a === true && b === false && c === false && sum === DAILY_CAP, `sum=${sum}`);
  ok('④-4 ★_dropped は日×入口で1回だけ', dropped.length === 1 && dropped[0].n === 1, JSON.stringify(dropped));
  await countSource(env, 'compat_home', 'd1', now);
  ok('④-5 入口が違えば別に数える', counts(env).some((x) => x.entry === 'compat_home' && x.n === 1));
  await countSource(env, 'xxx', 'd1', now);
  ok('④-6 知らない入口は unknown', counts(env).some((x) => x.entry === 'unknown'));
}

// ---------- ⑤ 許可表・試し読みの窓口 ----------
async function call(fn, env, body, o = {}) {
  const headers = o.noSecret ? {} : { 'X-Ingest-Secret': SECRET };
  if (o.ct !== false) headers['content-type'] = o.ct || 'application/json';
  const r = await fn(new Request('https://x', { method: o.method || 'POST', headers, body: o.method === 'GET' ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) }), env);
  return [r.status, await r.json()];
}
{
  const env = makeEnv({ LB_D1_REMAIN_MODE: 'on' }); await seed(env, CID);
  ok('⑤-1 GET は 405', (await call(remainAllow, env, null, { method: 'GET' }))[0] === 405);
  ok('⑤-2 合言葉が無ければ 403', (await call(remainAllow, env, { action: 'list' }, { noSecret: true }))[0] === 403);
  ok('⑤-3 Content-Type が違えば 415', (await call(remainAllow, env, { action: 'list' }, { ct: 'text/plain' }))[0] === 415);
  ok('⑤-4 本文が大きすぎれば 413', (await call(remainAllow, env, JSON.stringify({ action: 'list', x: 'a'.repeat(5000) })))[0] === 413);
  ok('⑤-5 知らない action は 400', (await call(remainAllow, env, { action: 'drop' }))[0] === 400);
  ok('⑤-6 list に会員を付けたら 400', (await call(remainAllow, env, { action: 'list', customer: '*0001' }))[0] === 400);
  const [s7, b7] = await call(remainAllow, env, { action: 'add', customerId: 'CNOTEXIST01' });
  ok('⑤-7 ★実在しない会員は足さない（404・書き込みなし）', s7 === 404 && env._db.prepare('SELECT COUNT(*) AS n FROM remain_d1_allow').get().n === 0);
  const [s8, b8] = await call(remainAllow, env, { action: 'add', customerId: CID });
  ok('⑤-8 足せる・応答は下4桁だけ', s8 === 200 && b8.customer === '*0001' && JSON.stringify(b8).indexOf(CID) < 0, JSON.stringify(b8));
  const [, b9] = await call(remainAllow, env, { action: 'list' });
  ok('⑤-9 list は下4桁と人数だけ', b9.count === 1 && b9.customers[0] === '*0001' && JSON.stringify(b9).indexOf(CID) < 0);
  //   同じ下4桁の会員が2人いる → 消さない
  env._db.prepare('INSERT OR REPLACE INTO customers (customer_id, name, created_at, updated_at) VALUES (?, ?, 1, 1)').run('C99990000001', 'X');
  await call(remainAllow, env, { action: 'add', customerId: 'C99990000001' });
  const [s10, b10] = await call(remainAllow, env, { action: 'remove', customer: '*0001' });
  ok('⑤-10 ★許可表で下4桁が2人なら消さない（409 AMBIGUOUS）', s10 === 409 && b10.code === 'AMBIGUOUS'
     && env._db.prepare('SELECT COUNT(*) AS n FROM remain_d1_allow').get().n === 2);
  env._db.prepare('DELETE FROM remain_d1_allow WHERE customer_id = ?').run('C99990000001');
  const [s11] = await call(remainAllow, env, { action: 'remove', customer: '*0001' });
  ok('⑤-11 1人なら消す', s11 === 200 && env._db.prepare('SELECT COUNT(*) AS n FROM remain_d1_allow').get().n === 0);
  ok('⑤-12 いなければ 404', (await call(remainAllow, env, { action: 'remove', customer: '*0001' }))[0] === 404);
  ok('⑤-13 remove の形が違えば 400', (await call(remainAllow, env, { action: 'remove', customer: '0001' }))[0] === 400
     && (await call(remainAllow, env, { action: 'remove', customerId: CID }))[0] === 400);
  //   試し読み
  await seed(env, VER);
  const [s14, b14] = await call(remainProbe, env, { customerId: VER });
  ok('⑤-14 ★試し読みは本番と同じ経路で D1 を答える', s14 === 200 && b14.source === 'd1' && b14.remainSource === 'd1' && b14.transferAvailable === 2, JSON.stringify(b14));
  ok('⑤-15 試し読みは固定の一覧だけ', JSON.stringify(Object.keys(b14).sort()) === JSON.stringify(['customer', 'monthMatch', 'monthlyRemaining', 'ok', 'remainSource', 'remaining', 'selected', 'source', 'status', 'ticketRemaining', 'transferAvailable']));
  ok('⑤-16 ★検証用の会員以外は断る', (await call(remainProbe, env, { customerId: CID }))[0] === 403);
  ok('⑤-17 試し読みは数えない', !counts(env).some((x) => x.entry === 'unknown'));
}

// ---------- ⑥ 予約一覧の送信の書き込みの印 ----------
async function ingest(env, b) { const r = await handleIngest(new Request('https://x', { method: 'POST', headers: { 'X-Ingest-Secret': SECRET }, body: JSON.stringify(b) }), env); return [r.status, await r.json()]; }
{
  const env = makeEnv(); await seed(env, CID);
  const v0 = await readSyncVersion(env, CID);
  const [s1, b1] = await ingest(env, { kind: 'reservations', batchId: Date.now(), scope: 'partial', customerId: CID, rows: [], dirtySeq: 7, final: true });
  const v1 = await readSyncVersion(env, CID);
  ok('⑥-1 ★予約0件でも書き込みの印が立つ', s1 === 200 && v1.dirtySeq === 7 && v0.dirtySeq === 0, JSON.stringify(b1));
  const [s2] = await ingest(env, { kind: 'reservations', batchId: Date.now() + 1, scope: 'partial', customerId: CID, dirtySeq: 8,
    rows: [{ reservation_id: 'R1', customer_id: 'COTHER', start_at: 1 }] });
  ok('⑥-2 ★別の会員の行があれば何も書かない', s2 === 400 && (await readSyncVersion(env, CID)).dirtySeq === 7);
  const [s3] = await ingest(env, { kind: 'reservations', batchId: Date.now() + 2, scope: 'partial', customerId: 'CNONE0001', rows: [], dirtySeq: 9 });
  ok('⑥-3 実在しない会員は 404・何も書かない', s3 === 404);
  const [s4] = await ingest(env, { kind: 'reservations', batchId: Date.now() + 3, scope: 'partial', rows: [], dirtySeq: 9 });
  ok('⑥-4 customerId が無ければ断る', s4 === 400);
  await ingest(env, { kind: 'reservations', batchId: Date.now() + 4, scope: 'partial', customerId: CID, rows: [], dirtySeq: 5 });
  ok('⑥-5 同じか古い番号で下がらない', (await readSyncVersion(env, CID)).dirtySeq === 7);
  const [s6] = await ingest(env, { kind: 'trainers', batchId: Date.now() + 5, scope: 'partial', rows: [], dirtySeq: 9 });
  ok('⑥-6 他の種類に印を付けたら断る', s6 === 400);
}

// ---------- ⑦ 公開の場所に会員 ID を書いていない ----------
{
  const toml = readFileSync(join(W, 'wrangler.toml'), 'utf8');
  ok('⑦-1 ★wrangler.toml に会員 ID（C+数字）が無い', !/\bC\d{8,}\b/.test(toml));
  ok('⑦-2 LB_D1_REMAIN_MODE は shadow か on だけ（段階0から on）', /LB_D1_REMAIN_MODE\s*=\s*"(shadow|on)"/.test(toml));
  ok('⑦-3 全員（LB_D1_REMAIN_ALL）はまだ入れていない（段階2はオーナー承認）', !/LB_D1_REMAIN_ALL\s*=\s*"1"/.test(toml));
}

console.log(`\n${fail ? '❌' : '✅'} D1 から出す（設計21） 検証: ${pass} passed / ${fail} failed`);
if (fail) process.exit(1);
