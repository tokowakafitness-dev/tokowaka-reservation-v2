// 遅れている会員の窓口を**実際に呼ぶ**（2026-10-11）
//
//   ★なぜ要るのか
//     `/quota/behind` を足したとき、応答に存在しない `jsonRes()` を呼んでいた
//     （このファイルの関数名は `json`）。実行すれば必ず ReferenceError になる。
//     それでも検査は全部通った。**ソースの文字列しか見ていなかったからである。**
//     しかも catch の中でも同じ未定義関数を呼ぶので、`READ_FAILED` すら返せない。
//
//   だからここでは**偽のD1を渡して本物の Response まで確かめる。**
//
//   実行: node worker/test/quota-behind-run.test.js

import { quotaBehind } from '../src/routes/quota.js';

let pass = 0, fail = 0;
function ok(name, cond, why) {
  if (cond) { pass++; return; }
  fail++;
  console.log(`❌ ${name}`);
  if (why) console.log(`   ${why}`);
}

const SECRET = 'test-secret';

//   偽のD1。prepare→bind→all だけを本物と同じ形で返す。
function fakeDB(rows, { throwOnAll = false } = {}) {
  const seen = { sql: null, args: null };
  return {
    seen,
    prepare(sql) {
      seen.sql = sql;
      return {
        bind(...args) {
          seen.args = args;
          return {
            async all() {
              if (throwOnAll) throw new Error('no such table: customer_sync_version');
              return { results: rows };
            },
          };
        },
      };
    },
  };
}

const req = (qs = '', { secret = SECRET, method = 'GET' } = {}) => new Request(
  `https://example.com/quota/behind${qs}`,
  { method, headers: secret == null ? {} : { 'X-Ingest-Secret': secret } },
);

// ---------- 1. 合言葉 ----------
{
  const env = { SHARED_SECRET: SECRET, DB: fakeDB([]) };
  const res = await quotaBehind(req('', { secret: null }), env);
  ok('①★合言葉なしは断る', res.status !== 200,
     '顧客IDを返す窓口。お客様のブラウザから呼ばせない');
  const res2 = await quotaBehind(req('', { secret: 'wrong' }), env);
  ok('①違う合言葉も断る', res2.status !== 200);
}

// ---------- 2. 正常に返る（★ここで jsonRes の間違いが出る） ----------
{
  const rows = [
    { customer_id: 'C001', source_version: 5, built_version: 3, source_at: 1000 },
    { customer_id: 'C003', source_version: 2, built_version: 1, source_at: 500 },
  ];
  const env = { SHARED_SECRET: SECRET, DB: fakeDB(rows) };
  let res, body;
  try {
    res = await quotaBehind(req('?limit=5'), env);
    body = await res.json();
  } catch (e) {
    ok('②★実際に呼べる（応答を作れる）', false, `例外: ${e && e.message}`);
  }
  if (body) {
    ok('②★実際に呼べる（応答を作れる）', true);
    ok('②200で返る', res.status === 200);
    ok('②会員IDを順に返す',
       JSON.stringify(body.customerIds) === JSON.stringify(['C001', 'C003']));
    ok('②栞の次の位置を返す', body.next === 'C003');
    ok('②★limit 未満なら末尾に到達（栞を戻せる）', body.done === true);
    ok('②いちばん古い時刻を返す', body.oldestSourceAt === 500);
  }
}

// ---------- 3. 問い合わせの中身（遅れている会員だけ・巡回できる） ----------
{
  const env = { SHARED_SECRET: SECRET, DB: fakeDB([]) };
  await quotaBehind(req('?limit=3&after=C002'), env);
  ok('③★遅れている会員だけを引く',
     //   2026-10-20 設計20：条件は「新しいと名乗れない」（fresh.js の否定）＋一度は入力が来た会員
     env.DB.seen.sql.indexOf('(NOT (source_version = built_version AND built_version > 0 AND built_covers_seq >= dirty_seq))') >= 0
     && /WHERE source_version > 0 AND customer_id > \?/.test(env.DB.seen.sql));
  ok('③★栞より後ろから引く（飢えない）',
     /customer_id > \?/.test(env.DB.seen.sql) && env.DB.seen.args[0] === 'C002');
  ok('③customer_id 順', /ORDER BY customer_id/.test(env.DB.seen.sql));
  //   2026-10-27 設計22：引数は（栞・今の月・件数）の順
  ok('③今の月が渡る', /^\d{4}-\d{2}$/.test(String(env.DB.seen.args[1])));
  ok('③limit が渡る', env.DB.seen.args[2] === 3);
}

// ---------- 4. limit の上下限（渡し間違いで全員を引かせない） ----------
for (const [qs, want] of [['?limit=0', 1], ['?limit=999', 50], ['?limit=abc', 5], ['', 5]]) {
  const env = { SHARED_SECRET: SECRET, DB: fakeDB([]) };
  await quotaBehind(req(qs), env);
  ok(`④limit ${qs || '(未指定)'} → ${want}`, env.DB.seen.args[2] === want);
}

// ---------- 5. 読めなかったとき（★ここも jsonRes を呼んでいた） ----------
{
  const env = { SHARED_SECRET: SECRET, DB: fakeDB([], { throwOnAll: true }) };
  let body = null;
  try {
    const res = await quotaBehind(req(), env);
    body = await res.json();
  } catch (e) {
    ok('⑤★読めなくても応答を返せる', false, `例外: ${e && e.message}`);
  }
  if (body) {
    ok('⑤★読めなくても応答を返せる', true);
    ok('⑤ok:false と理由を返す', body.ok === false && body.code === 'READ_FAILED');
    ok('⑤★会員IDを返さない（呼ぶ側が栞を進めない）', body.customerIds === undefined);
  }
}

// ---------- 6. 0件（末尾に到達） ----------
{
  const env = { SHARED_SECRET: SECRET, DB: fakeDB([]) };
  const body = await (await quotaBehind(req('?limit=5&after=C999'), env)).json();
  ok('⑥0件なら栞を空に戻せる', body.done === true && body.next === '');
  ok('⑥0件のとき最古の時刻は null', body.oldestSourceAt === null);
}

// ---------- 9. ★本物の SQLite で：今の月の時点で作られていない月額行の会員も返す（2026-10-27・設計22） ----------
{
  const { DatabaseSync } = await import('node:sqlite');
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT9 = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(ROOT9, 'worker/migrations/0014_customer_sync_version.sql'), 'utf8'));
  db.exec(readFileSync(join(ROOT9, 'worker/migrations/0020_write_seq.sql'), 'utf8'));
  db.exec(`CREATE TABLE monthly_quota (customer_id TEXT, month_key TEXT, quota INT, used INT, coverage TEXT,
           base_freq INT, overage INT DEFAULT 0, built_version INT, PRIMARY KEY(customer_id, month_key));`);
  db.exec(readFileSync(join(ROOT9, 'worker/migrations/0023_quota_lent_asof.sql'), 'utf8'));
  const d = new Date(Date.now() + 9 * 3600000);
  const NOW = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
  const sv = (cid, src, built) => db.prepare(`INSERT INTO customer_sync_version (customer_id, source_version, built_version, built_at, updated_at)
                                              VALUES (?, ?, ?, 1, 1)`).run(cid, src, built);
  const mq = (cid, ver, asOf) => db.prepare(`INSERT INTO monthly_quota (customer_id, month_key, quota, used, coverage, base_freq, built_version, lent, as_of_month)
                                             VALUES (?, ?, 4, 0, 'limited', 4, ?, 0, ?)`).run(cid, NOW, ver, asOf);
  sv('C01', 3, 3); mq('C01', 3, NOW);                 // 新しい・今の月 → 返さない
  sv('C02', 4, 3); mq('C02', 3, NOW);                 // 遅れている → 返す
  sv('C03', 3, 3); mq('C03', 3, '2000-01');           // ★新しいが別の月の時点 → 返す
  sv('C04', 4, 3); mq('C04', 3, '2000-01');           // 両方 → 1回だけ返す
  sv('C05', 3, 3); mq('C05', 3, null);                // ★時点が未設定（反映直後）→ 返す
  sv('C06', 3, 3);                                    // チケットだけ（月額行なし）・新しい → 返さない
  sv('C07', 3, 3); mq('C07', 2, '2000-01');           // 古い世代の行だけが別の月 → 返さない（読まれない行）
  sv('C08', 0, 0); mq('C08', 0, null);                // 一度も入力が来ていない → 返さない
  const wrap = { prepare(q) { const st = db.prepare(q); return { bind(...a) { return { async all() { return { results: st.all(...a) }; } }; } }; } };
  const call = async (qs) => (await (await quotaBehind(req(qs), { SHARED_SECRET: SECRET, DB: wrap })).json());
  const b1 = await call('?limit=50');
  ok('⑨★返すのは 遅れ・別の月・両方・未設定 の4名だけ（重複なし）', JSON.stringify(b1.customerIds) === JSON.stringify(['C02', 'C03', 'C04', 'C05']), JSON.stringify(b1.customerIds));
  const b2 = await call('?limit=50&after=C03');
  ok('⑨★栞より前は返さない（OR が栞を迂回しない）', JSON.stringify(b2.customerIds) === JSON.stringify(['C04', 'C05']), JSON.stringify(b2.customerIds));
  const b3 = await call('?limit=2');
  ok('⑨件数の上限と終端の印が従来どおり', b3.customerIds.length === 2 && b3.done === false && b3.next === 'C03');
  db.prepare('UPDATE monthly_quota SET as_of_month = ? WHERE customer_id = ?').run(NOW, 'C03');
  const b4 = await call('?limit=50');
  ok('⑨★作り直して今の月になれば対象から消える', !b4.customerIds.includes('C03'), JSON.stringify(b4.customerIds));

  //   ★状態表示の監視（LENT_ASOF_SQL）も本物の SQLite で（関門②）
  const { LENT_ASOF_SQL } = await import('../src/routes/quota.js');
  const st = () => db.prepare(LENT_ASOF_SQL).get(NOW);
  db.exec('DELETE FROM monthly_quota; DELETE FROM customer_sync_version;');
  sv('S1', 3, 3); db.prepare(`INSERT INTO monthly_quota (customer_id, month_key, quota, used, coverage, base_freq, built_version, lent, as_of_month) VALUES ('S1', ?, 4, 3, 'limited', 4, 3, 1, ?)`).run(NOW, NOW);   // 3+1=4 正常
  sv('S2', 3, 3); db.prepare(`INSERT INTO monthly_quota (customer_id, month_key, quota, used, coverage, base_freq, built_version, lent, as_of_month) VALUES ('S2', ?, 4, 4, 'limited', 4, 3, 1, ?)`).run(NOW, NOW);   // 4+1>4 異常
  sv('S3', 3, 3); db.prepare(`INSERT INTO monthly_quota (customer_id, month_key, quota, used, coverage, base_freq, built_version, lent, as_of_month) VALUES ('S3', ?, 4, 0, 'limited', 4, 3, NULL, ?)`).run(NOW, NOW); // lent 未設定
  sv('S4', 4, 3); db.prepare(`INSERT INTO monthly_quota (customer_id, month_key, quota, used, coverage, base_freq, built_version, lent, as_of_month) VALUES ('S4', ?, 4, 9, 'limited', 4, 3, 9, NULL)`).run(NOW);   // 遅れている会員＝数えない
  sv('S5', 3, 3); db.prepare(`INSERT INTO monthly_quota (customer_id, month_key, quota, used, coverage, base_freq, built_version, lent, as_of_month) VALUES ('S5', ?, 4, 9, 'limited', 4, 2, 9, NULL)`).run(NOW);   // 古い世代の行＝数えない
  const r = st();
  ok('⑨★使った数＋前借りが枠を超える行を1件数える（正常な 3+1=4 は数えない）', Number(r.invariantBroken) === 1, JSON.stringify(r));
  ok('⑨前借り未設定は算術の異常と分けて数える', Number(r.lentMissing) === 1);
  ok('⑨★遅れている会員・古い世代の行は数えない', Number(r.n) === 3 && Number(r.asOfStale) === 0, JSON.stringify(r));
}

console.log(`${fail ? '❌' : '✅'} 遅れている会員の窓口（実行） 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
