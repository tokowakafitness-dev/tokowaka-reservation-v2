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
function makeEnv(secret = 'TEST-SECRET', current = []) {
  const sql = [];          // 実行されたSQLを記録する
  const kv = new Map();
  const currentRows = current;
  const prepare = (q) => ({
    _q: q, _args: [],
    bind(...a) { this._args = a; return this; },
    async run() { sql.push({ q: this._q, args: this._args }); return { meta: { changes: 3 } }; },
    async first() { sql.push({ q: this._q, args: this._args }); return { n: 42 }; },
    async all() {
      sql.push({ q: this._q, args: this._args });
      // いまD1に入っている中身（変更の有無を見比べるために読まれる）
      if (/^SELECT .* FROM \w+$/.test(this._q.replace(/\s+/g, ' ').trim())) return { results: currentRows };
      return { results: [] };
    },
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
    _sql: sql, _kv: kv, _current: currentRows,
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
  eq('★finalでなければ同期の記録を書かない',
     env._sql.some((x) => /INSERT INTO sync_state/.test(x.q)), false);
}

// ---------- 5. final を受けたら、古い行だけを落とす ----------
{
  const env = makeEnv();
  const rows = [{ trainer_id: 't1', name: '鈴木' }];
  const [, b] = await json(await handleIngest(req({ kind: 'trainers', batchId: 100, rows,
    final: true, deleteStale: true }, 'TEST-SECRET'), env));
  const del = env._sql.find((x) => /DELETE/.test(x.q));
  eq('★finalで削除が走る', !!del, true);
  eq('★消すのは今回より古い行だけ', /synced_at IS NULL OR synced_at < \?/.test(del.q), true);
  eq('★その境目は今回のbatchId', del.args, [100]);
  eq('削除件数を返す', b.removed, 3);
  eq('同期の記録を残す', env._sql.some((x) => /INSERT INTO sync_state/.test(x.q)), true);
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

// ---------- 8. KVへの取り込みは受け付けない ----------
//   ★合言葉が漏れたとき、認証に使う公開鍵（jwks:line）を上書きされ、
//     偽のIDトークンを通されるのを防ぐ。残数も枠もD1へ移したので業務では使わない。
{
  const env = makeEnv();
  const [s, b] = await json(await handleIngest(req({
    kind: 'kv', batchId: 5, final: true,
    entries: [{ key: 'jwks:line', value: { keys: [{ kid: 'evil' }] } }],
  }, 'TEST-SECRET'), env));
  eq('★KVへの取り込みは断る', [s, b.code], [400, 'KV_INGEST_DISABLED']);
  eq('★公開鍵は書き換えられない', env._kv.get('jwks:line'), undefined);
}

// ---------- 11. 0件でまるごと消さない ----------
//   元のシートが一時的に読めなかっただけの可能性がある。顧客や予約が全部消えると、
//   会員が「未登録」に見え、予約も全部消える。
{
  const env = makeEnv();
  const [, b] = await json(await handleIngest(req({
    kind: 'customers', batchId: 300, rows: [], final: true, deleteStale: true,
  }, 'TEST-SECRET'), env));
  eq('★0件のfinalでは削除しない', env._sql.some((x) => /DELETE/.test(x.q)), false);
  eq('理由を返す', b.skippedDelete, 'EMPTY_SOURCE');
}
{
  // 本当に0件にしたいときは、明示すれば消せる
  const env = makeEnv();
  await handleIngest(req({ kind: 'customers', batchId: 301, rows: [], final: true,
    allowEmpty: true, deleteStale: true }, 'TEST-SECRET'), env);
  eq('明示すれば消せる', env._sql.some((x) => /DELETE FROM customers/.test(x.q)), true);
}

// ---------- 12. 古いバッチの遅着で巻き戻さない ----------
{
  const env = makeEnv();
  env.DB.prepare = ((orig) => (q) => {
    const st = orig(q);
    if (/FROM sync_state/.test(q)) st.first = async () => ({ synced_at: 500 });
    return st;
  })(env.DB.prepare);

  const [s, b] = await json(await handleIngest(req({
    kind: 'customers', batchId: 400, rows: [{ customer_id: 'c1', name: '古い' }],
  }, 'TEST-SECRET'), env));
  eq('★新しいバッチが済んでいれば古いものは断る', [s, b.code], [409, 'STALE_BATCH']);
}
{
  const env = makeEnv();
  await handleIngest(req({ kind: 'customers', batchId: 600, rows: [{ customer_id: 'c1', name: 'x' }] },
    'TEST-SECRET'), env);
  const ins = env._sql.find((x) => /INSERT INTO customers/.test(x.q));
  eq('★行ごとにも世代を見る', /excluded\.synced_at >= customers\.synced_at/.test(ins.q), true);
}

// ---------- 9. 表に載っている種類だけが書ける先を持つ ----------
{
  const allowed = Object.values(_TABLES_FOR_TEST).map((t) => t.table).sort();
  eq('★書き込み先は決めた表だけ', allowed,
     ['body_records', 'calc_contract_rows', 'calc_meta', 'calc_reservation_rows',
      'contracts', 'customers', 'member_home', 'member_opening',
      'recurring_patterns', 'reservations', 'slots_cache', 'trainers']);
  const hasKey = Object.values(_TABLES_FOR_TEST).every((t) => t.cols.includes(t.key));
  eq('★どの表も主キーを列に持つ', hasKey, true);
}

// ---------- 10. 写し（残数・枠）は、含まれなかった行を消さない ----------
//   残数は会員ごとに独立していて、GASが時間切れで一部しか送れないことがある。
//   「今回含まれなかった＝辞めた」ではないので、消してはいけない。
{
  const env = makeEnv();
  await handleIngest(req({
    kind: 'home', batchId: 200, final: true, deleteStale: true,
    rows: [{ customer_id: 'c1', payload: '{"quota":6}', computed_at: 200 }],
  }, 'TEST-SECRET'), env);
  eq('★残数はfinalでも削除しない', env._sql.some((x) => /DELETE/.test(x.q)), false);
  eq('同期の記録は残す', env._sql.some((x) => /INSERT INTO sync_state/.test(x.q)), true);
}
{
  const env = makeEnv();
  await handleIngest(req({ kind: 'slots', batchId: 201, final: true, deleteStale: true, rows: [] }, 'TEST-SECRET'), env);
  eq('★枠もfinalで削除しない', env._sql.some((x) => /DELETE/.test(x.q)), false);
}
{
  const env = makeEnv();
  await handleIngest(req({ kind: 'body', batchId: 203, final: true, deleteStale: true, rows: [] }, 'TEST-SECRET'), env);
  eq('★InBodyもfinalで削除しない（直近ぶんしか送らないため）',
     env._sql.some((x) => /DELETE/.test(x.q)), false);
}
// 一方、顧客や予約は消えたら消す（Google側が正）
{
  const env = makeEnv();
  await handleIngest(req({ kind: 'customers', batchId: 202, final: true, deleteStale: true,
    rows: [{ customer_id: 'c1', name: '残る人' }] }, 'TEST-SECRET'), env);
  eq('★顧客はfinalで古い行を消す', env._sql.some((x) => /DELETE FROM customers/.test(x.q)), true);
}

// ---------- 13. 変わっていない行は書かない ----------
//   D1の書き込みは1日10万行まで。変わっていない行を15分ごとに書き直すと枠を使い切る。
{
  const cur = [{ customer_id: 'c1', name: '山田', kana: null, phone: '090', email: null,
    birthday: null, line_user_id: null, default_trainer_id: null, contract_status: '在籍',
    contract_type: null, lang: null, goal: null, note: null, created_at: 1, updated_at: 1 }];
  const env = makeEnv('TEST-SECRET', cur);
  const [, b] = await json(await handleIngest(req({
    kind: 'customers', batchId: 700,
    rows: [{ ...cur[0] }, { ...cur[0], customer_id: 'c2', name: '新しい人' }],
  }, 'TEST-SECRET'), env));
  eq('★同じ中身の行は書かない', b.skipped, 1);
  eq('★変わった行だけ書く', b.written, 1);
  eq('やり方を返す', b.mode, 'diff');
}
{
  // 1文字でも違えば書く
  const cur = [{ customer_id: 'c1', name: '山田', phone: '090', contract_status: '在籍',
    created_at: 1, updated_at: 1 }];
  const env = makeEnv('TEST-SECRET', cur);
  const [, b] = await json(await handleIngest(req({
    kind: 'customers', batchId: 701, rows: [{ ...cur[0], phone: '080' }],
  }, 'TEST-SECRET'), env));
  eq('★電話が変わったら書く', b.written, 1);
}

// ---------- 14. ふだんの押し出しでは消さない ----------
//   変わった行しか書かないので、synced_at が古いまま残る行が正常にある。
//   そこで消すと、変わっていないだけの行が全部消える。
{
  const env = makeEnv();
  await handleIngest(req({ kind: 'customers', batchId: 800, final: true,
    rows: [{ customer_id: 'c1', name: 'x' }] }, 'TEST-SECRET'), env);
  eq('★ふだんの押し出しでは消さない', env._sql.some((x) => /DELETE/.test(x.q)), false);
}
{
  // 完全同期のときだけ消す。そのときは全行を書く（書かないと消えてしまうため）
  const cur = [{ customer_id: 'c1', name: '同じ' }];
  const env = makeEnv('TEST-SECRET', cur);
  const [, b] = await json(await handleIngest(req({
    kind: 'customers', batchId: 900, final: true, deleteStale: true,
    rows: [{ customer_id: 'c1', name: '同じ' }],
  }, 'TEST-SECRET'), env));
  eq('★完全同期では同じ行も書く', b.written, 1);
  eq('★完全同期では読み比べをしない', b.skipped, 0);
  eq('★完全同期で古い行を消す', env._sql.some((x) => /DELETE FROM customers/.test(x.q)), true);
  eq('やり方を返す', b.mode, 'full');
}

// ---------- 15. 押し出すたびに変わる時刻は、見比べの対象にしない ----------
//   残数と枠は「押し出した時刻」を一緒に持つ。これを見比べに含めると、
//   中身が同じでも毎回書き直すことになり、書き込み枠を使い切る。
//   鮮度は sync_state（最後に押し出した時刻）で見るので、これで困らない。
{
  const cur = [{ customer_id: 'c1', payload: '{"quota":6}', computed_at: 111 }];
  const env = makeEnv('TEST-SECRET', cur);
  const [, b] = await json(await handleIngest(req({
    kind: 'home', batchId: 1000,
    rows: [{ customer_id: 'c1', payload: '{"quota":6}', computed_at: 999 }],   // 時刻だけ違う
  }, 'TEST-SECRET'), env));
  eq('★残数：時刻しか違わない行は書かない', [b.written, b.skipped], [0, 1]);
}
{
  const cur = [{ customer_id: 'c1', payload: '{"quota":6}', computed_at: 111 }];
  const env = makeEnv('TEST-SECRET', cur);
  const [, b] = await json(await handleIngest(req({
    kind: 'home', batchId: 1001,
    rows: [{ customer_id: 'c1', payload: '{"quota":5}', computed_at: 999 }],   // 残数が変わった
  }, 'TEST-SECRET'), env));
  eq('★残数が変わったら書く', b.written, 1);
}
{
  const cur = [{ trainer_id: 't1', payload: '{"slots":[]}', computed_at: 111 }];
  const env = makeEnv('TEST-SECRET', cur);
  const [, b] = await json(await handleIngest(req({
    kind: 'slots', batchId: 1002,
    rows: [{ trainer_id: 't1', payload: '{"slots":[]}', computed_at: 999 }],
  }, 'TEST-SECRET'), env));
  eq('★枠：時刻しか違わない行は書かない', [b.written, b.skipped], [0, 1]);
}

console.log(`\n取り込み口 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
