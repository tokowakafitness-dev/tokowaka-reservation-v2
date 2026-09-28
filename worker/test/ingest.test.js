// 取り込み口の検証。GASからの押し出しを受ける唯一の書き込み経路なので、
// 「合言葉が違えば通らない」「途中で切れても消さない」を機械で固定する。
//   実行: node worker/test/ingest.test.js
import { handleIngest, _safeEqualForTest, _TABLES_FOR_TEST } from '../src/routes/ingest.js';

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else { fail++; console.log(`❌ ${name}\n   got : ${g}\n   want: ${w}`); }
}

// ---- D1 / KV の身代わり ----
function makeEnv(secret = 'TEST-SECRET') {
  const sql = [];          // 実行されたSQLを記録する
  const kv = new Map();
  const prepare = (q) => ({
    _q: q, _args: [],
    bind(...a) { this._args = a; return this; },
    async run() { sql.push({ q: this._q, args: this._args }); return { meta: { changes: 3 } }; },
    async first() { sql.push({ q: this._q, args: this._args }); return { n: 42 }; },
    async all() { sql.push({ q: this._q, args: this._args }); return { results: [] }; },
  });
  return {
    SHARED_SECRET: secret,
    DB: {
      prepare,
      async batch(stmts) { for (const s of stmts) sql.push({ q: s._q, args: s._args }); return []; },
    },
    KV: {
      async put(k, v, o) { kv.set(k, { v, o }); },
      async get(k) { const e = kv.get(k); return e ? JSON.parse(e.v) : null; },
    },
    _sql: sql, _kv: kv,
  };
}
function req(body, secret) {
  const h = { 'Content-Type': 'application/json' };
  if (secret !== undefined) h['X-Ingest-Secret'] = secret;
  return new Request('https://x/ingest', { method: 'POST', headers: h, body: JSON.stringify(body) });
}
const json = async (res) => [res.status, await res.json()];

// ---------- 1. 合言葉 ----------
{
  const env = makeEnv();
  const [s1] = await json(await handleIngest(req({ kind: 'trainers', batchId: 1, rows: [] }), env));
  eq('★合言葉なしは通らない', s1, 403);

  const [s2] = await json(await handleIngest(req({ kind: 'trainers', batchId: 1, rows: [] }, 'WRONG'), env));
  eq('★違う合言葉は通らない', s2, 403);

  const [s3] = await json(await handleIngest(req({ kind: 'trainers', batchId: 1, rows: [] }, 'TEST-SECRET'), env));
  eq('正しい合言葉なら通る', s3, 200);
}
{
  const env = makeEnv('');   // 未設定
  const [s] = await json(await handleIngest(req({ kind: 'trainers', batchId: 1, rows: [] }, 'anything'), env));
  eq('★合言葉が未設定なら何も受けない', s, 503);
}

// ---------- 2. 比較は長さでも中身でも漏らさない ----------
eq('同じなら真', _safeEqualForTest('abc', 'abc'), true);
eq('長さ違いは偽', _safeEqualForTest('abc', 'abcd'), false);
eq('中身違いは偽', _safeEqualForTest('abc', 'abd'), false);
eq('空同士も真', _safeEqualForTest('', ''), true);

// ---------- 3. 入力の検証 ----------
{
  const env = makeEnv();
  const [s1, b1] = await json(await handleIngest(req({ kind: 'trainers', rows: [] }, 'TEST-SECRET'), env));
  eq('★batchIdが無ければ受けない', [s1, b1.code], [400, 'NO_BATCH_ID']);

  const [s2, b2] = await json(await handleIngest(req({ kind: 'evil_table', batchId: 1, rows: [] }, 'TEST-SECRET'), env));
  eq('★表に無い種類は受けない', [s2, b2.code], [400, 'UNKNOWN_KIND']);

  const many = Array.from({ length: 501 }, (_, i) => ({ trainer_id: 't' + i }));
  const [s3, b3] = await json(await handleIngest(req({ kind: 'trainers', batchId: 1, rows: many }, 'TEST-SECRET'), env));
  eq('★多すぎる行は受けない', [s3, b3.code], [413, 'TOO_MANY']);
}

// ---------- 4. 途中の塊では消さない（これが一番大事）----------
{
  const env = makeEnv();
  const rows = [{ trainer_id: 't1', name: '鈴木' }, { trainer_id: 't2', name: '沖' }];
  const [, b] = await json(await handleIngest(req({ kind: 'trainers', batchId: 100, rows }, 'TEST-SECRET'), env));
  eq('2件書いた', b.written, 2);
  eq('★finalでなければ削除しない', env._sql.some((x) => /DELETE/.test(x.q)), false);
  eq('★finalでなければ同期の記録も残さない', env._sql.some((x) => /sync_state/.test(x.q)), false);
}

// ---------- 5. final を受けたら、古い行だけを落とす ----------
{
  const env = makeEnv();
  const rows = [{ trainer_id: 't1', name: '鈴木' }];
  const [, b] = await json(await handleIngest(req({ kind: 'trainers', batchId: 100, rows, final: true }, 'TEST-SECRET'), env));
  const del = env._sql.find((x) => /DELETE/.test(x.q));
  eq('★finalで削除が走る', !!del, true);
  eq('★消すのは今回より古い行だけ', /synced_at IS NULL OR synced_at < \?/.test(del.q), true);
  eq('★その境目は今回のbatchId', del.args, [100]);
  eq('削除件数を返す', b.removed, 3);
  eq('同期の記録を残す', env._sql.some((x) => /sync_state/.test(x.q)), true);
}

// ---------- 6. 同じ押し出しを2回流しても結果が変わらない ----------
{
  const env = makeEnv();
  await handleIngest(req({ kind: 'customers', batchId: 7, rows: [{ customer_id: 'c1', name: '山田' }] }, 'TEST-SECRET'), env);
  const ins = env._sql.find((x) => /INSERT INTO customers/.test(x.q));
  eq('★主キーが同じなら入れ替える', /ON CONFLICT\(customer_id\) DO UPDATE SET/.test(ins.q), true);
  eq('★synced_atも一緒に更新する', /synced_at = excluded\.synced_at/.test(ins.q), true);
  eq('最後の値がbatchId', ins.args[ins.args.length - 1], 7);
}

// ---------- 7. 主キーの無い行は捨てる ----------
{
  const env = makeEnv();
  const [, b] = await json(await handleIngest(req({
    kind: 'trainers', batchId: 1,
    rows: [{ trainer_id: '', name: 'なし' }, { name: 'IDごとなし' }, { trainer_id: 't9', name: 'あり' }],
  }, 'TEST-SECRET'), env));
  eq('★IDの無い行は書かない', b.written, 1);
}

// ---------- 8. KVへの押し出し ----------
{
  const env = makeEnv();
  const [s, b] = await json(await handleIngest(req({
    kind: 'kv', batchId: 5, label: 'slots', final: true,
    entries: [{ key: 'slots:t1', value: { slots: [1, 2] }, ttl: 1800 }, { key: '', value: { x: 1 } }],
  }, 'TEST-SECRET'), env));
  eq('KVは通る', s, 200);
  eq('★鍵の無いものは書かない', b.written, 1);
  eq('値が入っている', await env.KV.get('slots:t1'), { slots: [1, 2] });
  eq('期限を渡している', env._kv.get('slots:t1').o, { expirationTtl: 1800 });
}

// ---------- 9. 表に載っている種類だけが書ける先を持つ ----------
{
  const allowed = Object.values(_TABLES_FOR_TEST).map((t) => t.table).sort();
  eq('★書き込み先は5つの表だけ', allowed,
     ['contracts', 'customers', 'recurring_patterns', 'reservations', 'trainers']);
  const hasKey = Object.values(_TABLES_FOR_TEST).every((t) => t.cols.includes(t.key));
  eq('★どの表も主キーを列に持つ', hasKey, true);
}

console.log(`\n取り込み口 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
