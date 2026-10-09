// shadow（写しとD1を比べて食い違いを数える）— 段階3-b 手順3
//
//   ★枠の確保は**本物のSQLiteで走らせる**。この仕組みの正しさはSQLの意味にある
//     （1文で一意性と上限を同時に守れるか・2文の間で競合しないか）。
//     字面を見るだけでは分からない。
//
//   実行: node worker/test/remain-shadow.test.js

import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  dayKeyJst, timeBandJst, ageBand, normValue, fingerprint, compareHome,
  COMPARE_FIELDS, SKIP_FIELDS, SLOT_MAX_TOTAL, SLOT_MAX_VER,
  COMPARE_FRESH_MS, COPY_TOO_OLD_MS, scheduleShadow, runShadow, claimSlot,
  POST_SKIP_COUNT_MAX, SLOT_MAX_TOTAL as MAXT,
} from '../src/lib/remain-shadow.js';
import { readHome, readHomeDiag, runDeferred } from '../src/routes/boot.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const SH = readFileSync(join(ROOT, 'worker/src/lib/remain-shadow.js'), 'utf8');
const BOOT = readFileSync(join(ROOT, 'worker/src/routes/boot.js'), 'utf8');
const COMPAT = readFileSync(join(ROOT, 'worker/src/routes/compat.js'), 'utf8');
const LB = readFileSync(join(ROOT, 'gas/LineBooking.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) { cond ? pass++ : (fail++, console.log(`❌ ${name}${extra ? '\n   ' + extra : ''}`)); }

const jst = (y, m, d, h = 12) => Date.UTC(y, m - 1, d, h - 9, 0, 0);

// ---------- 1. ★比べる鍵がGASの形と1対1 ----------
//   「両方の鍵の和」で比べてはいけない。片方にしか無い鍵が増えたとき、
//   「増やしてしまった」のか「比べるべき」のか判断できない。
function gasHomeKeys() {
  const at = LB.indexOf('function _lbBuildHome(');
  const end = LB.indexOf('\n}', at);
  const body = LB.slice(at, end);
  const rs = body.indexOf('\n  return {');
  let i = rs + '\n  return '.length, depth = 0, keys = [], inStr = null, buf = '';
  for (; i < body.length; i++) {
    const c = body[i];
    if (inStr) { if (c === inStr && body[i - 1] !== '\\') inStr = null; continue; }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === '/' && body[i + 1] === '/') { while (i < body.length && body[i] !== '\n') i++; continue; }
    if (c === '{' || c === '(' || c === '[') { depth++; buf = ''; continue; }
    if (c === '}' || c === ')' || c === ']') { depth--; buf = ''; if (depth === 0) break; continue; }
    if (depth === 1) {
      if (c === ':') { const k = buf.trim(); if (/^[A-Za-z_]\w*$/.test(k)) keys.push(k); buf = ''; }
      else if (c === ',') buf = '';
      else buf += c;
    }
  }
  return keys;
}
{
  const g = gasHomeKeys();
  const missing = g.filter((k) => COMPARE_FIELDS.indexOf(k) < 0);
  const extra = COMPARE_FIELDS.filter((k) => g.indexOf(k) < 0);
  ok('①GASの形を読み取れた', g.length >= 20, `取れた鍵=${g.length}`);
  ok('①★GASの鍵を全部比べる', missing.length === 0, `比べていない: ${missing.join(', ')}`);
  ok('①★GASに無い鍵を比べない', extra.length === 0, `余計: ${extra.join(', ')}`);
}
// ★readHome が後から足しているものは比べない（毎回必ず食い違う）
{
  ok('①★付帯情報は比べない',
     SKIP_FIELDS.join(',') === 'computedAt,stale,ageMs,month'
     && SKIP_FIELDS.every((k) => COMPARE_FIELDS.indexOf(k) < 0));
  ok('①その4つを readHome が実際に足している',
     /\.\.\.home, month, computedAt, stale: age > HOME_TTL_WARN_MS, ageMs: age,/.test(BOOT),
     'ここが変わったら、比べない鍵も変える');
}

// ---------- 2. 値の比べ方 ----------
ok('②null と 0 を混同しない', normValue(null) !== normValue(0));
ok('②無い鍵と null も区別する', normValue(undefined) !== normValue(null));
ok('②オブジェクトは鍵の順を揃える',
   normValue({ a: 1, b: 2 }) === normValue({ b: 2, a: 1 }),
   '順が違うだけで「食い違い」と数えてはいけない');
ok('②配列は順を保つ', normValue([1, 2]) !== normValue([2, 1]));
ok('②指紋は値が同じなら同じ', fingerprint('a', 'b') === fingerprint('a', 'b'));
ok('②指紋は値が違えば違う', fingerprint('a', 'b') !== fingerprint('a', 'c'));
ok('②★指紋は入れ替えても違う', fingerprint('a', 'b') !== fingerprint('b', 'a'),
   '写しとD1が逆になった食い違いを同じものと見なしてはいけない');

// ---------- 3. 比べる ----------
{
  const base = {}; for (const f of COMPARE_FIELDS) base[f] = 1;
  const same = { ...base, computedAt: 111, stale: false, ageMs: 5, month: '2026-10' };
  const d1 = { ...base, _src: 'd1', _packOverUse: 0 };
  ok('③同じなら食い違い0', compareHome(same, d1).diffs.length === 0);
  const diff = { ...d1, monthlyRemaining: 2 };
  const r = compareHome(same, diff);
  ok('③違う鍵だけを出す', r.diffs.length === 1 && r.diffs[0].field === 'monthlyRemaining');
  ok('③写しとD1の値を両方持つ', r.diffs[0].copy === '1' && r.diffs[0].d1 === '2');
}
{
  ok('③★片方だけが答えた場合を別に数える',
     compareHome(null, { type: null }).diffs[0].field === '_one_sided');
  ok('③両方が答えなければ食い違いではない',
     compareHome(null, null).diffs.length === 0 && compareHome(null, null).bothNone === true);
}

// ---------- 4. 日付・時間帯・鮮度 ----------
ok('④JSTの日付', dayKeyJst(jst(2026, 10, 9, 12)) === '2026-10-09');
ok('④★日本の深夜はまだ同じ日（UTCでは前日）', dayKeyJst(jst(2026, 10, 9, 1)) === '2026-10-09');
ok('④時間帯を3つに割る',
   timeBandJst(jst(2026, 10, 9, 3)) === '00-07'
   && timeBandJst(jst(2026, 10, 9, 10)) === '08-15'
   && timeBandJst(jst(2026, 10, 9, 20)) === '16-23');
ok('④鮮度の帯', ageBand(60000) === '0-5m' && ageBand(8 * 60000) === '5-10m'
   && ageBand(12 * 60000) === '10-15m' && ageBand(30 * 60000) === '15-40m'
   && ageBand(50 * 60000) === '40m+');
//   ★線は既存のコードが持っている2つに合わせる（勝手に広げない）
ok('④★10分の線は既存の警告と同じ',
   COMPARE_FRESH_MS === 10 * 60 * 1000 && /HOME_TTL_WARN_MS = 10 \* 60 \* 1000/.test(BOOT));
ok('④★40分の線は既存の「使えない」と同じ',
   COPY_TOO_OLD_MS === 40 * 60 * 1000 && /HOME_TTL_HARD_MS = 40 \* 60 \* 1000/.test(BOOT));

// ---------- 5. ★枠の確保（本物のSQLiteで走らせる）----------
const DIR = mkdtempSync(join(tmpdir(), 'shadow-'));
const DB = join(DIR, 't.db');
const MIG = readFileSync(join(ROOT, 'worker/migrations/0015_remain_shadow.sql'), 'utf8');
function sql(text) { return execFileSync('sqlite3', [DB], { input: text, encoding: 'utf8' }); }
sql(MIG);
ok('⑤3つの表ができる',
   sql("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;").trim().split('\n')
     .filter((x) => x.indexOf('remain_shadow') === 0).length === 3);

//   SQLite を env.DB に見せる小さな土台（.run() の changes を返す）
function sqliteEnv(vars) {
  return {
    ...(vars || {}),
    DB: {
      prepare(s0) {
        let bound = [];
        const obj = {
          bind(...a) { bound = a; return obj; },
          async run() {
            //   ★changes() は**同じプロセスの中**で取らないと 0 になる。
            //     total_changes() を別プロセスで前後から挟む書き方は、
            //     sqlite3 CLI が毎回新しい接続になるので必ず 0 になり、
            //     「枠が取れなかった」と誤って読める（最初はそう書いて誤判定した）。
            const out = sql(fill(s0, bound) + '; SELECT changes();').trim();
            const last = out.split('\n').pop();
            return { meta: { changes: Number(last || 0) } };
          },
          async first() {
            const out = sql('.mode json\n' + fill(s0, bound) + ';').trim();
            if (!out) return null;
            try { return JSON.parse(out)[0] || null; } catch (_) { return null; }
          },
          async all() {
            const out = sql('.mode json\n' + fill(s0, bound) + ';').trim();
            if (!out) return { results: [] };
            try { return { results: JSON.parse(out) }; } catch (_) { return { results: [] }; }
          },
        };
        return obj;
      },
      async batch(stmts) { const r = []; for (const st of stmts) r.push(await st.run()); return r; },
    },
  };
}
function fill(s0, args) {
  let i = 0;
  return s0.replace(/\?/g, () => {
    const v = args[i++];
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  });
}
const E = sqliteEnv();
const D = '2026-10-09';
{
  ok('⑤はじめの枠は取れる', (await claimSlot(E, D, 'C1', 'boot', 'time:08-15', 1000)) === true);
  ok('⑤★同じ枠は二度取れない', (await claimSlot(E, D, 'C1', 'boot', 'time:08-15', 1100)) === false);
  ok('⑤別の時間帯は取れる', (await claimSlot(E, D, 'C1', 'boot', 'time:16-23', 1200)) === true);
  ok('⑤別の入口は別に数える', (await claimSlot(E, D, 'C1', 'compat_member', 'time:08-15', 1300)) === true,
     'boot のアクセスが compat の観測枠を食い潰してはいけない');
  ok('⑤別の会員も別', (await claimSlot(E, D, 'C2', 'boot', 'time:08-15', 1400)) === true);
}
// ★世代の枠は2つまで（これが無いと時間帯の枠が食い潰される）
{
  ok('⑤-b 世代の枠1つめ', (await claimSlot(E, D, 'C1', 'boot', 'ver:1:1', 2000)) === true);
  ok('⑤-b★2つめは取れない（世代の枠は1つ）', (await claimSlot(E, D, 'C1', 'boot', 'ver:2:2', 2100)) === false,
     '世代が何度も変わっても、時間帯の枠を食い潰してはいけない');
  ok('⑤-b★総数の上限に達したら取れない',
     Number(sql(`SELECT COUNT(*) FROM remain_shadow_slot WHERE day='${D}' AND customer_id='C1' AND entry='boot';`).trim()) === SLOT_MAX_TOTAL
     && (await claimSlot(E, D, 'C1', 'boot', 'time:00-07', 2300)) === false,
     `いまの枠=${sql(`SELECT COUNT(*) FROM remain_shadow_slot WHERE day='${D}' AND customer_id='C1' AND entry='boot';`).trim()}`);
}
// ★上限を超えないことを、連続して叩いて確かめる
{
  for (let i = 0; i < 20; i++) await claimSlot(E, D, 'C9', 'boot', `ver:${i}:${i}`, 3000 + i);
  const n = Number(sql(`SELECT COUNT(*) FROM remain_shadow_slot WHERE day='${D}' AND customer_id='C9' AND entry='boot';`).trim());
  const v = Number(sql(`SELECT COUNT(*) FROM remain_shadow_slot WHERE day='${D}' AND customer_id='C9' AND entry='boot' AND sample_key LIKE 'ver:%';`).trim());
  ok('⑤-c★20回叩いても世代の枠は上限どおり', v === SLOT_MAX_VER, `世代の枠=${v}`);
  ok('⑤-c★総数も上限を超えない', n <= SLOT_MAX_TOTAL, `総数=${n}`);
}
//   ★壊して確かめる：世代の上限の条件を外したら、本当に超えるか
{
  const broken = SH.match(/const SLOT_VER_SQL =\n([\s\S]*?)`;/);
  ok('⑤-d 世代の文に上限2の条件が入っている',
     broken && /sample_key LIKE 'ver:%'\) < \?/.test(broken[1]));
  const s2 = broken[1].replace(/\s*AND \(SELECT COUNT\(\*\) FROM remain_shadow_slot[\s\S]*?LIKE 'ver:%'\) < \?/, '');
  const noLimit = s2.replace(/^\s*`/, '').trim();
  for (let i = 0; i < 4; i++) {
    const f = fill(noLimit, [D, 'C8', 'boot', `ver:${i}:${i}`, 4000 + i, D, 'C8', 'boot', 99]);
    sql(f + ';');
  }
  const v = Number(sql(`SELECT COUNT(*) FROM remain_shadow_slot WHERE day='${D}' AND customer_id='C8' AND entry='boot' AND sample_key LIKE 'ver:%';`).trim());
  ok('⑤-d★条件を外すと実際に2を超える（＝上の検査は効いている）', v > SLOT_MAX_VER, `外した結果=${v}`);
}
//   ★入口の名前が違えば SQL エラーになる（DO NOTHING で黙らない）
{
  let threw = false;
  //   ★sqlite3 は失敗を stderr に出すので捨てる（落ちること自体が期待する結果）
  try {
    execFileSync('sqlite3', [DB], {
      input: `INSERT INTO remain_shadow_slot VALUES ('${D}','CX','bogus','time:08-15',1);`,
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch (_) { threw = true; }
  ok('⑤-e★知らない入口は弾かれる（黙って無視されない）', threw,
     'OR IGNORE だと CHECK 違反まで「上限か重複」と読み違える');
  ok('⑤-e DO NOTHING で主キーだけを無視している',
     /ON CONFLICT\(day, customer_id, entry, sample_key\) DO NOTHING/.test(SH)
     && !/INSERT OR IGNORE INTO remain_shadow_slot/.test(SH));
}

// ---------- 6. 比べて記録する（通しで） ----------
{
  const E2 = sqliteEnv();
  //   D1側の行を用意する（世代・枠・件数）
  const cid = 'CSHADOW';
  const now = jst(2026, 10, 9, 10);
  const day = dayKeyJst(now);
  const base = {}; for (const f of COMPARE_FIELDS) base[f] = 1;

  //   世代の表と枠の表を作る（0014 と 0009 の一部を模す）
  sql(readFileSync(join(ROOT, 'worker/migrations/0014_customer_sync_version.sql'), 'utf8'));
  //   0016 の customer_sync_version への ALTER も当てる（migration から読む）
  sql(readFileSync(join(ROOT, 'worker/migrations/0016_row_generation.sql'), 'utf8')
    .split('\n').filter((l) => /^ALTER TABLE customer_sync_version/.test(l)).join('\n'));
  //   ★0016 で足した built_version も持たせる（読む側が世代で絞るため）
  sql(`CREATE TABLE IF NOT EXISTS monthly_quota (customer_id TEXT, month_key TEXT, quota INT, used INT,
        coverage TEXT, base_freq INT, overage INT DEFAULT 0, built_version INT,
        PRIMARY KEY(customer_id, month_key));`);
  sql(`CREATE TABLE IF NOT EXISTS ticket_packs (pack_id TEXT PRIMARY KEY, customer_id TEXT, kind TEXT,
        total INT, used INT, opening_used INT, valid_from INT, valid_to INT, built_version INT);`);
  sql(`CREATE TABLE IF NOT EXISTS reservations (reservation_id TEXT PRIMARY KEY, customer_id TEXT,
        start_at INT, status TEXT, book_type TEXT);`);
  sql(`INSERT INTO customer_sync_version (customer_id, source_version, built_version, built_at, updated_at,
        built_quota_rows, built_pack_rows) VALUES ('${cid}', 3, 3, 1, 1, 1, 0);`);
  sql(`INSERT INTO monthly_quota VALUES ('${cid}', '2026-10', 9, 3, 'limited', 8, 0, 3);`);

  //   写し（D1と同じ値になるように作る）
  const copyValue = {
    type: 'monthly', active: true, nextMonth: null, quota: 8, carryover: 1, thisMonth: 0,
    monthlyRemaining: 6, ticketTotal: 0, ticketRemaining: 0, ticketExpire: '', ticketExpireMs: null,
    pairRemaining: 0, pairPackMax: 0, normalTicketRemaining: 0, hasNormalRoute: true,
    ticketPacks: [], remaining: 6, overageCount: 0, displayRemaining: 6, paymentRequired: false,
    total: 0, used: 0, expire: '', expireMs: null,
    month: '2026-10', computedAt: now - 60000, stale: false, ageMs: 60000,
  };
  const r = await runShadow(E2, {
    customerId: cid, entry: 'boot', nowMs: now,
    copyDiag: { value: copyValue, status: 'ok', month: '2026-10', computedAt: now - 60000, ageMs: 60000 },
  });
  ok('⑥比べ終わる', r.done === true, JSON.stringify(r));
  ok('⑥★一致すれば食い違いは書かれない', r.diffs === 0, `食い違い=${r.diffs}`);
  ok('⑥終わった回数が残る',
     Number(sql(`SELECT n FROM remain_shadow WHERE day='${day}' AND customer_id='${cid}' AND field='_completed';`).trim()) === 1);
  ok('⑥鮮度の帯が残る',
     sql(`SELECT field FROM remain_shadow WHERE day='${day}' AND customer_id='${cid}' AND field LIKE '_age:%';`).trim() === '_age:0-5m');
  ok('⑥★枠が残る（＝attempted の実体）',
     Number(sql(`SELECT COUNT(*) FROM remain_shadow_slot WHERE day='${day}' AND customer_id='${cid}';`).trim()) === 1);

  //   食い違わせる
  const r2 = await runShadow(E2, {
    customerId: cid, entry: 'compat_member', nowMs: now,
    copyDiag: { value: { ...copyValue, monthlyRemaining: 99 }, status: 'ok',
                month: '2026-10', computedAt: now - 60000, ageMs: 60000 },
  });
  ok('⑥食い違いを数える', r2.done === true && r2.diffs >= 1, JSON.stringify(r2));
  ok('⑥どの鍵かが残る',
     sql(`SELECT field FROM remain_shadow WHERE day='${day}' AND customer_id='${cid}' AND entry='compat_member' AND field='monthlyRemaining';`).trim() === 'monthlyRemaining');
  ok('⑥★写しとD1の値が両方残る',
     /写し=99 \/ D1=6/.test(sql(`SELECT last_value FROM remain_shadow WHERE day='${day}' AND customer_id='${cid}' AND entry='compat_member' AND field='monthlyRemaining';`)));
  ok('⑥標本に世代と月が残る',
     /2026-10\|2026-10\|3\|3/.test(sql(`SELECT requested_month, copy_month, source_version, built_version FROM remain_shadow_sample WHERE customer_id='${cid}' AND field='monthlyRemaining';`)),
     sql(`SELECT requested_month, copy_month, source_version, built_version FROM remain_shadow_sample WHERE customer_id='${cid}' AND field='monthlyRemaining';`).trim());

  //   同じ組は標本に二度入らない
  await runShadow(E2, {
    customerId: cid, entry: 'compat_member', nowMs: now + 1000,
    copyDiag: { value: { ...copyValue, monthlyRemaining: 99 }, status: 'ok',
                month: '2026-10', computedAt: now, ageMs: 1000 },
  });
  ok('⑥★同じ値の組は標本に重ねない（指紋）',
     Number(sql(`SELECT COUNT(*) FROM remain_shadow_sample WHERE customer_id='${cid}' AND field='monthlyRemaining';`).trim()) === 1);
}

// ---------- 7. 枠を取る前に弾くもの ----------
{
  const E3 = sqliteEnv();
  const cid = 'COLD', now = jst(2026, 10, 9, 10), day = dayKeyJst(now);
  const r = await runShadow(E3, {
    customerId: cid, entry: 'boot', nowMs: now,
    copyDiag: { value: { type: 'monthly' }, status: 'ok', month: '2026-10',
                computedAt: now - 20 * 60000, ageMs: 20 * 60000 },
  });
  ok('⑦★写しが古ければ比べない', r.done === false && r.why === 'copy_stale_for_compare', JSON.stringify(r));
  ok('⑦★そのとき枠を消費しない',
     Number(sql(`SELECT COUNT(*) FROM remain_shadow_slot WHERE day='${day}' AND customer_id='${cid}';`).trim()) === 0,
     '消費すると、あとで新鮮な写しが来ても比べられなくなる');
  ok('⑦弾いた理由は残る',
     sql(`SELECT field FROM remain_shadow WHERE customer_id='${cid}' AND field LIKE '_pre:%';`).trim() === '_pre:copy_stale_for_compare');
  ok('⑦鮮度の分布は弾いても数える',
     sql(`SELECT field FROM remain_shadow WHERE customer_id='${cid}' AND field='_age:15-40m';`).trim() === '_age:15-40m');

  const r2 = await runShadow(E3, {
    customerId: 'CMON', entry: 'boot', nowMs: now, targetMs: jst(2026, 11, 15),
    copyDiag: { value: { type: 'monthly' }, status: 'ok', month: '2026-10',
                computedAt: now, ageMs: 1000 },
  });
  ok('⑦★月が違えば比べない', r2.why === 'copy_month_mismatch', JSON.stringify(r2));
}

// ---------- 8. 写しが使えないときも比べる（★手順4でいちばん見たい場面）----------
{
  const E4 = sqliteEnv();
  const cid = 'CBROKEN', now = jst(2026, 10, 9, 10), day = dayKeyJst(now);
  sql(`INSERT INTO customer_sync_version (customer_id, source_version, built_version, built_at, updated_at,
        built_quota_rows, built_pack_rows) VALUES ('${cid}', 1, 1, 1, 1, 1, 0);`);
  sql(`INSERT INTO monthly_quota VALUES ('${cid}', '2026-10', 5, 0, 'limited', 5, 0, 1);`);
  const r = await runShadow(E4, {
    customerId: cid, entry: 'boot', nowMs: now,
    copyDiag: { value: null, status: 'bad_shape', month: '2026-10', computedAt: now, ageMs: 100 },
  });
  ok('⑧★写しが壊れていても比べる', r.done === true, JSON.stringify(r));
  ok('⑧片方だけが答えたと記録する',
     sql(`SELECT field FROM remain_shadow WHERE customer_id='${cid}' AND field='_one_sided';`).trim() === '_one_sided',
     'D1なら答えられるのに写しが壊れている＝手順4でいちばん確かめたい場面');
}

// ---------- 9. 枠を取ったあとに分かったこと ----------
{
  const E5 = sqliteEnv();
  const cid = 'CNOVER', now = jst(2026, 10, 9, 10);
  //   世代の行を作らない＝D1は答えない
  const r = await runShadow(E5, {
    customerId: cid, entry: 'boot', nowMs: now,
    copyDiag: { value: { type: 'monthly' }, status: 'ok', month: '2026-10', computedAt: now, ageMs: 100 },
  });
  ok('⑨D1が答えなければ理由を残す', r.why === 'no_version_row', JSON.stringify(r));
  ok('⑨★枠の後に弾いたものとして数える',
     sql(`SELECT field FROM remain_shadow WHERE customer_id='${cid}' AND field='_post:no_version_row';`).trim() === '_post:no_version_row');
  ok('⑨★そのときは枠を消費している（incomplete に現れないように）',
     Number(sql(`SELECT COUNT(*) FROM remain_shadow_slot WHERE customer_id='${cid}';`).trim()) === 1);
}

// ---------- 10. 入口の意思とモード ----------
{
  let scheduled = 0;
  const ctx = { waitUntil: () => { scheduled++; } };
  //   ★以下の5つは「走らないこと」を確かめる（scheduled は増えない）
  ok('⑩★モードが off なら比べない',
     scheduleShadow({ LB_D1_REMAIN_MODE: 'off' }, { shadow: true, ctx }) === false);
  ok('⑩★打ち間違いも off 側に倒れる',
     scheduleShadow({ LB_D1_REMAIN_MODE: 'Shadow' }, { shadow: true, ctx }) === false
     && scheduleShadow({ LB_D1_REMAIN_MODE: 'shadow ' }, { shadow: true, ctx }) === false);
  ok('⑩設定が無ければ比べない', scheduleShadow({}, { shadow: true, ctx }) === false);
  ok('⑩★入口の意思が無ければ比べない',
     scheduleShadow({ LB_D1_REMAIN_MODE: 'shadow' }, { ctx }) === false,
     'ctx は全部の handler に渡る。ctx の有無を入口の印にしてはいけない');
  ok('⑩★応答のあとに走らせる手段が無ければ比べない',
     scheduleShadow({ LB_D1_REMAIN_MODE: 'shadow' }, { shadow: true }) === false,
     '顧客を待たせてまで比べない');
  //   ★ここは D1 を持たない env をわざと渡す。
  //     「D1が無くても例外を外に出さず、ログに残す」ことまで確かめる
  //     （顧客の画面を壊さないための最後の砦）。
  const errs = [];
  const origErr = console.error;
  console.error = (...a) => { errs.push(a.map(String).join(' ')); };
  let p0 = null;
  const ctx2 = { waitUntil: (p) => { scheduled++; p0 = p; return p; } };
  const started = scheduleShadow({ LB_D1_REMAIN_MODE: 'shadow' },
                                 { shadow: true, ctx: ctx2, customerId: 'X', entry: 'boot' });
  let threw2 = false;
  try { await p0; } catch (_) { threw2 = true; }
  console.error = origErr;
  ok('⑩そろえば走る', started === true && scheduled === 1);
  ok('⑩★D1が無くても例外を外に出さない', threw2 === false);
  ok('⑩★そのときログに残す', errs.some((x) => /\[shadow\]/.test(x)),
     `ログ=${JSON.stringify(errs)}`);
}

// ---------- 11. どの入口から渡しているか（配線）----------
{
  //   ★defer に積む方式（関門③）。readHome の中では起動しない
  ok('⑪boot から渡している',
     /readHome\(env, who\.customerId, undefined, \{ shadow: true, ctx, entry: 'boot', defer \}\)/.test(BOOT));
  //   ★動的 import にしない（関門③の2周目）。
  //     import() の Promise は waitUntil に登録されないため、応答後に
  //     解決する前に isolate が終わりうる＝**静かに一度も動かない**。
  ok('⑪★静的 import になっている',
     /^import \{ scheduleShadow \} from '\.\.\/lib\/remain-shadow\.js';$/m.test(BOOT)
     && !/import\('\.\.\/lib\/remain-shadow\.js'\)/.test(BOOT));
  ok('⑪★早期 return でも起動する（compat）',
     /if \(!cust\) \{ runDeferred\(defer\); return \{ verified: false \}; \}/.test(COMPAT)
     && /if \(!home\) \{ runDeferred\(defer\); return \{ _fallback: true \}; \}/.test(COMPAT),
     '!home は「写しが無い／壊れた」＝D1なら答えられるか、いちばん確かめたい場面');
  ok('⑪★枠は会員×入口で3回（書き込み枠を守る）',
     MAXT === 3 && /SLOT_MAX_VER = 1;/.test(SH),
     '1比較で最大51行。D1の1日10万行は押し出しと共用');
  ok('⑪★比較は本体のD1処理のあとで起動する',
     /opts\.defer\.push\(\(\) => \{/.test(BOOT) && /export function runDeferred\(defer\)/.test(BOOT)
     && /runDeferred\(defer\);   \/\/ ★本体のD1処理が全部終わってから比較を起動する/.test(BOOT),
     'readHome の中で起動すると、handler の Promise.all がまだ終わっておらず本体と競合する');
  ok('⑪routeBoot が ctx を受け取っている', /export async function routeBoot\(\{ env, who, ctx \}\)/.test(BOOT));
  ok('⑪会員の起動（互換）から渡している',
     /readHomeSafe\(env, who\.customerId, undefined, \{ shadow: true, ctx, entry: 'compat_member', defer \}\)/.test(COMPAT));
  ok('⑪顧客カードから渡している',
     /readHomeSafe\(env, customerId, undefined, \{ shadow: true, ctx, entry: 'compat_home', defer \}\)/.test(COMPAT));
  ok('⑪★互換の2入口も本体のあとで起動する',
     (COMPAT.match(/runDeferred\(defer\)/g) || []).length >= 3,
     'compatMemberStatus と compatCustomerHome（_fallback の経路も）');
  //   ★予約の候補を選ぶ経路からは渡さない（候補を選び直すたびに呼ばれる）
  const bo = COMPAT.slice(COMPAT.indexOf('export async function compatBookingOptions'));
  ok('⑪★予約の候補の経路からは渡さない',
     !/shadow: true/.test(bo.slice(0, 2000)),
     '候補を選び直すたびに4クエリ増やすと、確定の経路が遅くなる');
  const SLOTS = readFileSync(join(ROOT, 'worker/src/routes/slots.js'), 'utf8');
  ok('⑪★空き枠の経路からも渡さない', !/shadow: true/.test(SLOTS));
}

// ---------- 11-b. ★readHome を実際に通す（正規表現では配線を確かめられない）----------
//   ★2026-10-09・関門②の指摘1
//     入口は `shadow: true` を正しく渡していたのに、readHome が
//     scheduleShadow へそれを**転送していなかった**。
//     ＝モードを 'shadow' にしても一度も比べない。
//     それでも検査は全部通っていた（scheduleShadow を直接呼び、配線は字面で見ていた）。
//     **関数を実際に通す検査でしか見つからない。**
{
  const calls = [];
  const ctx = { waitUntil: (p) => { calls.push(p); return p; } };
  //   写しの行を持つ小さな env（D1は使わない＝比較は走るが中で止まってよい）
  const fakeEnv = {
    LB_D1_REMAIN_MODE: 'shadow',
    DB: {
      prepare() {
        return {
          bind() { return this; },
          async first() {
            return {
              payload: JSON.stringify({
                currentMonth: '2026-10', nextMonth: '2026-11',
                current: { type: 'monthly', hasNormalRoute: true, ticketPacks: [],
                           monthlyRemaining: 3 },
                next: null,
              }),
              computed_at: Date.now(),
            };
          },
          async all() { return { results: [] }; },
          async run() { return { meta: { changes: 0 } }; },
        };
      },
      async batch(st) { const r = []; for (const x of st) r.push(await x.run()); return r; },
    },
  };
  //   ★defer 方式：readHome は積むだけ。runDeferred で初めて起動する
  const defer = [];
  const v = await readHome(fakeEnv, 'CWIRE', undefined, { shadow: true, ctx, entry: 'boot', defer });
  ok('⑪-b★readHome の時点では起動しない', calls.length === 0 && defer.length === 1,
     `waitUntil=${calls.length} / 積まれた数=${defer.length}。本体のD1処理と競合させない`);
  runDeferred(defer);
  await new Promise((r) => setTimeout(r, 10));   // 動的 import を待つ
  ok('⑪-b★runDeferred で比較が予約される', calls.length === 1,
     `waitUntil が呼ばれた回数=${calls.length}。0なら shadow が一度も動かない`);
  ok('⑪-b 返るのは写し', v && v.monthlyRemaining === 3 && v._src === undefined);
  //   予約した処理が外へ例外を出さないことも確かめる
  let threw = false;
  try { await calls[0]; } catch (_) { threw = true; }
  ok('⑪-b★予約した処理は例外を外に出さない', threw === false);

  //   opts を渡さない呼び出しでは積まれない
  calls.length = 0;
  const d2 = [];
  await readHome(fakeEnv, 'CWIRE', undefined);
  await readHome(fakeEnv, 'CWIRE', undefined, { shadow: true, ctx, entry: 'boot' });   // defer を渡さない
  ok('⑪-b★opts や defer が無ければ比べない', calls.length === 0);
  //   モードが off なら、積まれても起動しない
  const d3 = [];
  await readHome({ ...fakeEnv, LB_D1_REMAIN_MODE: 'off' }, 'CWIRE', undefined,
                 { shadow: true, ctx, entry: 'boot', defer: d3 });
  runDeferred(d3);
  await new Promise((r) => setTimeout(r, 10));
  ok('⑪-b モードが off なら比べない', calls.length === 0);
}

// ---------- 11-c. ★写しの読み取りの振る舞いが変わっていない ----------
{
  const row = (payload, ca) => ({
    LB_D1_REMAIN_MODE: 'off',
    DB: { prepare() { return { bind() { return this; },
      async first() { return payload === null ? null : { payload, computed_at: ca }; } }; } },
  });
  const okPayload = JSON.stringify({
    currentMonth: '2026-10', nextMonth: '2026-11',
    current: { type: 'monthly', hasNormalRoute: true, ticketPacks: [], monthlyRemaining: 3 },
    next: null,
  });
  ok('⑪-c 会員が無ければ null', (await readHome(row(okPayload, 1), '')) === null);
  ok('⑪-c 行が無ければ null', (await readHome(row(null, 0), 'C')) === null);
  ok('⑪-c 壊れたJSONは null', (await readHome(row('{壊れ', 1), 'C')) === null);
  ok('⑪-c 形が壊れていれば null',
     (await readHome(row(JSON.stringify({ currentMonth: '2026-10', current: { type: 'monthly' } }), 1), 'C')) === null,
     '{type:"monthly"} だけが素通りして「残り0回」になる穴（2026-10-03）');
  ok('⑪-c 計算時刻が無ければ null', (await readHome(row(okPayload, 0), 'C')) === null);
  ok('⑪-c 持っていない月は null',
     (await readHome(row(okPayload, Date.now()), 'C', jst(2026, 12, 15))) === null);
  //   ★理由つきの版も同じところで諦める
  const d = await readHomeDiag(row('{壊れ', 1), 'C');
  ok('⑪-c★理由を返す（shadow が見る）', d.value === null && d.status === 'bad_json');
  const d2 = await readHomeDiag(row(JSON.stringify({ currentMonth: '2026-10', current: { type: 'monthly' } }), 1), 'C');
  ok('⑪-c★形が壊れた理由も分かる', d2.status === 'bad_shape',
     'D1なら答えられるのに写しが壊れている＝手順4でいちばん確かめたい場面');
}

// ---------- 11-d. ★世代が読み取り中に動いたら比べない ----------
{
  const cid = 'CVERMOVE', now = jst(2026, 10, 9, 10), day2 = dayKeyJst(now);
  let n = 0;
  const E6 = sqliteEnv();
  sql(`INSERT INTO customer_sync_version (customer_id, source_version, built_version, built_at, updated_at,
        built_quota_rows, built_pack_rows) VALUES ('${cid}', 3, 3, 1, 1, 1, 0);`);
  sql(`INSERT INTO monthly_quota VALUES ('${cid}', '2026-10', 5, 0, 'limited', 5, 0, 3);`);
  const base2 = E6.DB.prepare.bind(E6.DB);
  E6.DB.prepare = (s0) => {
    const st = base2(s0);
    if (/customer_sync_version/.test(s0) && /SELECT source_version/.test(s0)) {
      st.first = async () => {
        n++;
        //   1回目（枠の鍵のため）は 3:3、2回目以降（readRemainDiag の中）は 4:4
        return n === 1 ? { source_version: 3, built_version: 3 }
                       : { source_version: 4, built_version: 4 };
      };
    }
    return st;
  };
  const r = await runShadow(E6, {
    customerId: cid, entry: 'boot', nowMs: now,
    copyDiag: { value: { type: 'monthly' }, status: 'ok', month: '2026-10', computedAt: now, ageMs: 100 },
  });
  ok('⑪-d★枠の世代と読んだ行の世代が違えば比べない',
     r.why === 'version_changed_during_shadow', JSON.stringify(r));
  ok('⑪-d 理由が残る',
     sql(`SELECT field FROM remain_shadow WHERE customer_id='${cid}' AND field LIKE '_post:version%';`).trim()
       === '_post:version_changed_during_shadow');
  ok('⑪-d★枠は戻さない（並行した要求が取り直すと上限管理が壊れる）',
     Number(sql(`SELECT COUNT(*) FROM remain_shadow_slot WHERE customer_id='${cid}';`).trim()) === 1);
}

// ---------- 11-e. ★枠の後に弾いた回数の上限は、枠の上限と同じ ----------
// ---------- 11-f. ★世代が動いたら、D1が答えられなくても「世代が動いた」と分類する ----------
{
  const cid = 'CVERBEHIND', now = jst(2026, 10, 9, 10);
  let n2 = 0;
  const E7 = sqliteEnv();
  sql(`INSERT INTO customer_sync_version (customer_id, source_version, built_version, built_at, updated_at,
        built_quota_rows, built_pack_rows) VALUES ('${cid}', 3, 3, 1, 1, 0, 0);`);
  const base3 = E7.DB.prepare.bind(E7.DB);
  E7.DB.prepare = (s0) => {
    const st = base3(s0);
    if (/customer_sync_version/.test(s0) && /SELECT source_version/.test(s0)) {
      st.first = async () => {
        n2++;
        //   1回目（枠の鍵）は 3:3。2回目以降は 4:3（＝追いついていない＝behind）
        return n2 === 1 ? { source_version: 3, built_version: 3 }
                        : { source_version: 4, built_version: 3 };
      };
    }
    return st;
  };
  const r = await runShadow(E7, {
    customerId: cid, entry: 'boot', nowMs: now,
    copyDiag: { value: { type: 'monthly' }, status: 'ok', month: '2026-10', computedAt: now, ageMs: 100 },
  });
  ok('⑪-f★behind でも「世代が動いた」と分類する',
     r.why === 'version_changed_during_shadow', JSON.stringify(r));
  ok('⑪-f behind として数えない',
     sql(`SELECT COUNT(*) FROM remain_shadow WHERE customer_id='${cid}' AND field='_post:behind';`).trim() === '0',
     '「世代が動いた」と「追いついていない」は別のこと。混ぜると原因が追えない');
}

// ---------- 11-g. ★持っていない月は枠を取る前に弾く ----------
{
  const cid = 'COUTR', now = jst(2026, 10, 9, 10);
  const E8 = sqliteEnv();
  const r = await runShadow(E8, {
    customerId: cid, entry: 'boot', nowMs: now, targetMs: jst(2026, 12, 15),
    copyDiag: { value: null, status: 'month_missing', month: null, computedAt: now, ageMs: 100 },
  });
  ok('⑪-g★D1が持っていない月は比べない', r.why === 'out_of_range', JSON.stringify(r));
  ok('⑪-g★枠を消費しない',
     Number(sql(`SELECT COUNT(*) FROM remain_shadow_slot WHERE customer_id='${cid}';`).trim()) === 0,
     '比べられないと分かっている要求が枠を使うと、その日の機会が減る');
  ok('⑪-g 枠の前に弾いたものとして数える',
     sql(`SELECT field FROM remain_shadow WHERE customer_id='${cid}' AND field='_pre:out_of_range';`).trim() === '_pre:out_of_range');
  ok('⑪-g 翌月は弾かない', (await runShadow(E8, {
       customerId: 'CNEXT', entry: 'boot', nowMs: now, targetMs: jst(2026, 11, 15),
       copyDiag: { value: { type: 'monthly' }, status: 'ok', month: '2026-11', computedAt: now, ageMs: 100 },
     })).why !== 'out_of_range');
}

ok('⑪-e★post の上限＝枠の上限', POST_SKIP_COUNT_MAX === MAXT,
   '3で打ち止めにすると、4回目以降が incomplete に数えられ「結末を残せなかった」と誤って出る');
{
  const ST = readFileSync(join(ROOT, 'worker/src/lib/shadow-status.js'), 'utf8');
  ok('⑪-e incomplete の式が post を引いている',
     /x\.incomplete = x\.attempted - x\.completed - x\.failed - post;/.test(ST));
  ok('⑪-e★attempted は枠の表から数える',
     /FROM remain_shadow_slot WHERE day = \? GROUP BY entry/.test(ST)
     && !/field = '_attempted'/.test(ST),
     '集計表に書くと、枠を取ってから結末を書く前に消えた処理が検知できない');
  ok('⑪-e preclaim は引かない', /preclaim は枠を使っていないので引かない/.test(ST));
}

// ---------- 11-h. ★「動いているつもり」を日次点検で潰す ----------
//   ★2026-10-09、on にした直後に「比べた回数0」が
//     「誰も画面を開いていない」のか「配線が効いていない」のか**区別できなかった**。
//     1日2回しか心拍を見られないなら、毎朝の点検に載せたほうが確実。
{
  const LB2 = readFileSync(join(ROOT, 'gas/LineBooking.js'), 'utf8');
  ok('⑪-h★一度も比べていなければ知らせる',
     /add\('shadow_idle'/.test(LB2) && /if \(!_shDone\) \{/.test(LB2),
     '一度も比べていなければ、shadow は存在しないのと同じ');
  ok('⑪-h★結末を残せなかった回も知らせる',
     /add\('shadow_incomplete'/.test(LB2) && /_shInc > 0/.test(LB2));
  ok('⑪-h 食い違いの鍵の種類も知らせる', /add\('shadow_diff'/.test(LB2));
  ok('⑪-h★モードが shadow のときだけ見る',
     /if \(_shMode === 'shadow'\) \{/.test(LB2),
     'off のときに「動いていない」と知らせても意味がない');
  ok('⑪-h★点検そのものを落とさない',
     /catch \(e2\) \{ \/\* 窓口が読めないだけ＝点検そのものは続ける \*\/ \}/.test(LB2),
     'shadow の窓口が読めなくても、他の検査は続ける');
  ok('⑪-h 版の印を上げている', /LB_HEALTH_BUILD = '2026-10-1\d[a-z]/.test(LB2),
     '日付が変わるたびに書き換えないよう、日付の形で見る');
}

// ---------- 12. 顧客の画面を壊さない ----------
ok('⑫例外を外に出さない', /} catch \(_\) \{\n    return false;   \/\/ 何があっても顧客の画面を壊さない/.test(SH));
ok('⑫記録の失敗で顧客に影響しない', /runShadow\(env, opts\)\.catch\(/.test(SH));
ok('⑫★返すのはいつでも写し',
   /return d\.value;/.test(BOOT) && !/return .*d1.*\.value/.test(BOOT));
ok('⑫1回ぶんの記録は同じ batch', /await env\.DB\.batch\(stmts\);/.test(SH),
   '_completed だけ増えて食い違いが書けないと「一致した」ように見える');
ok('⑫batch が落ちたら記録してログに出す',
   /field: '_failed', value: 'batch'/.test(SH) && /記録のbatchが落ちました/.test(SH));

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${fail ? '❌' : '✅'} shadow 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
