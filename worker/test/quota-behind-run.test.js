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
     && /AND source_version > 0 AND customer_id > \?/.test(env.DB.seen.sql));
  ok('③★栞より後ろから引く（飢えない）',
     /customer_id > \?/.test(env.DB.seen.sql) && env.DB.seen.args[0] === 'C002');
  ok('③customer_id 順', /ORDER BY customer_id/.test(env.DB.seen.sql));
  ok('③limit が渡る', env.DB.seen.args[1] === 3);
}

// ---------- 4. limit の上下限（渡し間違いで全員を引かせない） ----------
for (const [qs, want] of [['?limit=0', 1], ['?limit=999', 50], ['?limit=abc', 5], ['', 5]]) {
  const env = { SHARED_SECRET: SECRET, DB: fakeDB([]) };
  await quotaBehind(req(qs), env);
  ok(`④limit ${qs || '(未指定)'} → ${want}`, env.DB.seen.args[1] === want);
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

console.log(`${fail ? '❌' : '✅'} 遅れている会員の窓口（実行） 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
