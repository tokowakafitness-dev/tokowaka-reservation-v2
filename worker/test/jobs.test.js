// 作業の受け渡しの検証。
//   ★結果を読むのに合言葉が要らない（IDを知っていることが鍵）ので、
//     許可した作業以外を実行させない・登録を無制限に増やさないことが要。
//   実行: node worker/test/jobs.test.js
import { handleJobs, handleJobRead, _forTest } from '../src/routes/jobs.js';

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else { fail++; console.log(`❌ ${name}\n   got : ${g}\n   want: ${w}`); }
}

const ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';      // 24文字
function makeEnv(rows = [], pendingCount = 0) {
  const sql = [];
  let store = rows.slice();
  return {
    SHARED_SECRET: 'S',
    _sql: sql, _store: store,
    DB: { prepare(q) { return {
      _a: [],
      bind(...a) { this._a = a; return this; },
      async run() { sql.push({ q, a: this._a }); return { meta: { changes: 1 } }; },
      async first() {
        sql.push({ q, a: this._a });
        if (/COUNT\(\*\) AS n/.test(q)) return { n: pendingCount };
        if (/WHERE request_id = \?/.test(q)) return store.filter((r) => r.request_id === this._a[0])[0] || null;
        if (/status = 'pending' ORDER BY/.test(q)) return store.filter((r) => r.status === 'pending')[0] || null;
        return null;
      },
      async all() { sql.push({ q, a: this._a }); return { results: [] }; },
    }; } },
  };
}
const post = (body, secret) => new Request('https://x/jobs', {
  method: 'POST',
  headers: secret === undefined ? { 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json', 'X-Ingest-Secret': secret },
  body: JSON.stringify(body),
});
const j = async (r) => [r.status, await r.json()];

// ---------- 1. 合言葉 ----------
eq('★合言葉なしでは登録できない',
   (await j(await handleJobs(post({ action: 'enqueue', requestId: ID, op: 'audit' }), makeEnv())))[0], 403);
eq('★違う合言葉でも登録できない',
   (await j(await handleJobs(post({ action: 'enqueue', requestId: ID, op: 'audit' }, 'X'), makeEnv())))[0], 403);
eq('正しければ登録できる',
   (await j(await handleJobs(post({ action: 'enqueue', requestId: ID, op: 'audit' }, 'S'), makeEnv())))[0], 200);

// ---------- 2. 許可した作業だけ ----------
{
  for (const op of ['audit', 'verify', 'previewMerge', 'testConnection', 'pushAll']) {
    const [, b] = await j(await handleJobs(post({ action: 'enqueue', requestId: ID, op }, 'S'), makeEnv()));
    eq(`許可された作業 ${op}`, b.success, true);
  }
  for (const op of ['mergeMembers', 'setupEdgeTrigger', 'eval', 'constructor', '__proto__', 'toString', '']) {
    const [, b] = await j(await handleJobs(post({ action: 'enqueue', requestId: ID, op }, 'S'), makeEnv()));
    eq(`★許可していない作業は断る（${op || '空'}）`, b.code, 'UNKNOWN_OP');
  }
}

// ---------- 3. 作業番号の形 ----------
{
  for (const bad of ['short', 'a'.repeat(100), 'has space!!!!!!!!!!!!!!!!', '../../etc/passwd!!!!!!!!']) {
    const [, b] = await j(await handleJobs(post({ action: 'enqueue', requestId: bad, op: 'audit' }, 'S'), makeEnv()));
    eq('★おかしな作業番号は断る', b.code, 'BAD_ID');
  }
}

// ---------- 4. 溜め込ませない ----------
{
  const [s, b] = await j(await handleJobs(post({ action: 'enqueue', requestId: ID, op: 'audit' }, 'S'), makeEnv([], 2)));
  eq('★同じ作業が2つ待っていれば断る', [s, b.code], [429, 'TOO_MANY_PENDING']);
}

// ---------- 4b. 疎通の確認は仕事を取らない ----------
//   設定を確かめるつもりで claim を使うと、仕事を1つ取って捨ててしまう。
{
  const env = makeEnv([{ request_id: ID, op: 'audit', args: null, status: 'pending' }]);
  const [s, b] = await j(await handleJobs(post({ action: 'ping' }, 'S'), env));
  eq('疎通の確認は通る', [s, b.pong], [200, true]);
  eq('★疎通の確認では仕事を取らない',
     env._sql.some((x) => /UPDATE jobs SET status = 'running'/.test(x.q)), false);
  eq('★合言葉は必要', (await j(await handleJobs(post({ action: 'ping' }), env)))[0], 403);
}

// ---------- 5. 受け取りは1つだけ（取り合いにならない）----------
{
  const env = makeEnv([{ request_id: ID, op: 'audit', args: null, status: 'pending' }]);
  const [, b] = await j(await handleJobs(post({ action: 'claim' }, 'S'), env));
  eq('作業を受け取れる', b.job.requestId, ID);
  eq('★書き換える作業かどうかを伝える', b.job.isWrite, false);
  // pending のままのものだけを running にする条件が入っているか
  const upd = env._sql.filter((x) => /UPDATE jobs SET status = 'running'/.test(x.q))[0];
  eq('★取り合いを防ぐ条件がある', /AND status = 'pending'/.test(upd.q), true);
}
{
  const env = makeEnv([]);
  const [, b] = await j(await handleJobs(post({ action: 'claim' }, 'S'), env));
  eq('作業が無ければ null を返す（GASは即終了できる）', b.job, null);
  const back = env._sql.filter((x) => /UPDATE jobs SET status = 'pending'/.test(x.q))[0];
  eq('★受け取ったまま落ちた作業は戻す', !!back, true);
}

// ---------- 6. 書き換える作業は区別する ----------
{
  const env = makeEnv([{ request_id: ID, op: 'pushAll', args: null, status: 'pending' }]);
  const [, b] = await j(await handleJobs(post({ action: 'claim' }, 'S'), env));
  eq('★写しを書き換える作業は印を付けて渡す', b.job.isWrite, true);
  // ★書き込みを伴う作業はここに並べる。読み取り専用と扱いが変わるので、
  //   新しく足したら必ずこの表も直す（足し忘れると、書く作業が読み取り扱いになる）。
  //   quotaBuild は args.write を付けたときだけ書くが、「書くかもしれない」ものは
  //   ここに入れておく（安全側）。
  eq('書き換え扱いの作業がこの表と一致する', [..._forTest.WRITE_OPS].sort(), ['pushAll', 'quotaBuild'].sort());
}

// ---------- 7. 結果は長すぎれば切る ----------
{
  const env = makeEnv([]);
  const big = 'あ'.repeat(_forTest.MAX_RESULT + 100);
  const [, b] = await j(await handleJobs(post({ action: 'report', requestId: ID, ok: true, result: big }, 'S'), env));
  eq('★長すぎる結果は切る', b.truncated, true);
  const upd = env._sql.filter((x) => /UPDATE jobs SET status = \?/.test(x.q))[0];
  eq('★切ったことが分かるようにする', /途中で切りました/.test(upd.a[2]), true);
  eq('★実行中のものだけ更新する', /AND status = 'running'/.test(upd.q), true);
}

// ---------- 8. 結果の読み出し（IDが鍵）----------
{
  const env = makeEnv([{ request_id: ID, op: 'audit', status: 'done', result: 'ok', error: null,
                         enqueued_at: 1, claimed_at: 2, finished_at: 3 }]);
  const [s, b] = await j(await handleJobRead(new Request('https://x'), env, ID));
  eq('IDを知っていれば読める', [s, b.job.result], [200, 'ok']);
  const [s2] = await j(await handleJobRead(new Request('https://x'), env, 'bbbbbbbbbbbbbbbbbbbbbbbb'));
  eq('★違うIDでは読めない', s2, 404);
  const [s3, b3] = await j(await handleJobRead(new Request('https://x'), env, 'short'));
  eq('★短いIDは受け付けない（総当たり対策）', [s3, b3.code], [400, 'BAD_ID']);
}

console.log(`\n作業の受け渡し 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
