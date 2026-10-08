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
      async batch(stmts) { for (const s of stmts) sql.push({ q: s._q, args: s._args });
                           return stmts.map(() => ({ meta: { changes: 1 } })); },
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
  const [s1] = await json(await handleIngest(req({ kind: 'trainers', scope: 'all', batchId: 1, rows: [] }), env));
  eq('★合言葉なしは通らない', s1, 403);

  const [s2] = await json(await handleIngest(req({ kind: 'trainers', scope: 'all', batchId: 1, rows: [] }, 'WRONG'), env));
  eq('★違う合言葉は通らない', s2, 403);

  const [s3] = await json(await handleIngest(req({ kind: 'trainers', scope: 'all', batchId: 1, rows: [] }, 'TEST-SECRET'), env));
  eq('正しい合言葉なら通る', s3, 200);
}
{
  const env = makeEnv('');   // 未設定
  const [s] = await json(await handleIngest(req({ kind: 'trainers', scope: 'all', batchId: 1, rows: [] }, 'anything'), env));
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
  const [s1, b1] = await json(await handleIngest(req({ kind: 'trainers', scope: 'all', rows: [] }, 'TEST-SECRET'), env));
  eq('★batchIdが無ければ受けない', [s1, b1.code], [400, 'NO_BATCH_ID']);

  const [s2, b2] = await json(await handleIngest(req({ kind: 'evil_table', scope: 'all', batchId: 1, rows: [] }, 'TEST-SECRET'), env));
  eq('★表に無い種類は受けない', [s2, b2.code], [400, 'UNKNOWN_KIND']);

  const many = Array.from({ length: 501 }, (_, i) => ({ trainer_id: 't' + i }));
  const [s3, b3] = await json(await handleIngest(req({ kind: 'trainers', scope: 'all', batchId: 1, rows: many }, 'TEST-SECRET'), env));
  eq('★多すぎる行は受けない', [s3, b3.code], [413, 'TOO_MANY']);
}

// ---------- 4. 途中の塊では消さない（これが一番大事）----------
{
  const env = makeEnv();
  const rows = [{ trainer_id: 't1', name: '鈴木' }, { trainer_id: 't2', name: '沖' }];
  const [, b] = await json(await handleIngest(req({ kind: 'trainers', scope: 'all', batchId: 100, rows }, 'TEST-SECRET'), env));
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
    final: true, deleteStale: true, scope: 'all' }, 'TEST-SECRET'), env));
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
  await handleIngest(req({ kind: 'customers', scope: 'all', batchId: 7, rows: [{ customer_id: 'c1', name: '山田' }] }, 'TEST-SECRET'), env);
  const ins = env._sql.find((x) => /INSERT INTO customers/.test(x.q));
  eq('★主キーが同じなら入れ替える', /ON CONFLICT\(customer_id\) DO UPDATE SET/.test(ins.q), true);
  eq('★synced_atも一緒に更新する', /synced_at = excluded\.synced_at/.test(ins.q), true);
  eq('最後の値がbatchId', ins.args[ins.args.length - 1], 7);
}

// ---------- 7. 主キーの無い行は捨てる ----------
{
  const env = makeEnv();
  const [, b] = await json(await handleIngest(req({
    kind: 'trainers', scope: 'all', batchId: 1,
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
    kind: 'kv', batchId: 5, final: true, scope: 'all',
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
    kind: 'customers', batchId: 300, rows: [], final: true, deleteStale: true, scope: 'all',
  }, 'TEST-SECRET'), env));
  eq('★0件のfinalでは削除しない', env._sql.some((x) => /DELETE/.test(x.q)), false);
  eq('理由を返す', b.skippedDelete, 'EMPTY_SOURCE');
}
{
  // 本当に0件にしたいときは、明示すれば消せる。
  //   ★ただし名乗れるのは固定枠だけ（2026-10-03・Codexの4回目の判定）。
  //     固定枠は最後の1件を消すと次の同期が0件になるため、名乗れないと永久に残る。
  //     送り手（_edgeRecurring）が「読めなければ送らない」ので名乗ってよい。
  const env = makeEnv();
  await handleIngest(req({ kind: 'recurring', batchId: 301, rows: [], final: true,
    allowEmpty: true, deleteStale: true, scope: 'all' }, 'TEST-SECRET'), env);
  eq('★固定枠は明示すれば0件でも消せる',
     env._sql.some((x) => /DELETE FROM recurring_patterns/.test(x.q)), true);
}
{
  // ★他の表では名乗っても消さない。送り手を信用して全表で許すと、
  //   どれか1つが一時的に0件になっただけで全件が消える。受け取る側でも縛る。
  const env = makeEnv();
  const [, b] = await json(await handleIngest(req({ kind: 'customers', batchId: 302, rows: [],
    final: true, allowEmpty: true, deleteStale: true, scope: 'all' }, 'TEST-SECRET'), env));
  eq('★顧客の表は名乗っても0件で消さない', env._sql.some((x) => /DELETE FROM customers/.test(x.q)), false);
  eq('理由を返す', b.skippedDelete, 'EMPTY_SOURCE');
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
    kind: 'customers', scope: 'all', batchId: 400, rows: [{ customer_id: 'c1', name: '古い' }],
  }, 'TEST-SECRET'), env));
  eq('★新しいバッチが済んでいれば古いものは断る', [s, b.code], [409, 'STALE_BATCH']);
}
{
  const env = makeEnv();
  await handleIngest(req({ kind: 'customers', scope: 'all', batchId: 600, rows: [{ customer_id: 'c1', name: 'x' }] },
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
    kind: 'home', batchId: 200, final: true, deleteStale: true, scope: 'all',
    rows: [{ customer_id: 'c1', payload: '{"quota":6}', computed_at: 200 }],
  }, 'TEST-SECRET'), env);
  eq('★残数はfinalでも削除しない', env._sql.some((x) => /DELETE/.test(x.q)), false);
  eq('同期の記録は残す', env._sql.some((x) => /INSERT INTO sync_state/.test(x.q)), true);
}
{
  const env = makeEnv();
  await handleIngest(req({ kind: 'slots', batchId: 201, final: true, deleteStale: true, scope: 'all', rows: [] }, 'TEST-SECRET'), env);
  eq('★枠もfinalで削除しない', env._sql.some((x) => /DELETE/.test(x.q)), false);
}
{
  const env = makeEnv();
  await handleIngest(req({ kind: 'body', batchId: 203, final: true, deleteStale: true, scope: 'all', rows: [] }, 'TEST-SECRET'), env);
  eq('★InBodyもfinalで削除しない（直近ぶんしか送らないため）',
     env._sql.some((x) => /DELETE/.test(x.q)), false);
}
// 一方、顧客や予約は消えたら消す（Google側が正）
{
  const env = makeEnv();
  await handleIngest(req({ kind: 'customers', batchId: 202, final: true, deleteStale: true, scope: 'all',
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
    kind: 'customers', scope: 'all', batchId: 700,
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
    kind: 'customers', scope: 'all', batchId: 701, rows: [{ ...cur[0], phone: '080' }],
  }, 'TEST-SECRET'), env));
  eq('★電話が変わったら書く', b.written, 1);
}

// ---------- 14. ふだんの押し出しでは消さない ----------
//   変わった行しか書かないので、synced_at が古いまま残る行が正常にある。
//   そこで消すと、変わっていないだけの行が全部消える。
{
  const env = makeEnv();
  await handleIngest(req({ kind: 'customers', batchId: 800, final: true, scope: 'all',
    rows: [{ customer_id: 'c1', name: 'x' }] }, 'TEST-SECRET'), env);
  eq('★ふだんの押し出しでは消さない', env._sql.some((x) => /DELETE/.test(x.q)), false);
}
{
  // 完全同期のときだけ消す。そのときは全行を書く（書かないと消えてしまうため）
  const cur = [{ customer_id: 'c1', name: '同じ' }];
  const env = makeEnv('TEST-SECRET', cur);
  const [, b] = await json(await handleIngest(req({
    kind: 'customers', batchId: 900, final: true, deleteStale: true, scope: 'all',
    rows: [{ customer_id: 'c1', name: '同じ' }],
  }, 'TEST-SECRET'), env));
  eq('★完全同期では同じ行も書く', b.written, 1);
  eq('★完全同期では読み比べをしない', b.skipped, 0);
  eq('★完全同期で古い行を消す', env._sql.some((x) => /DELETE FROM customers/.test(x.q)), true);
  eq('やり方を返す', b.mode, 'full');
}

// ---------- 15. 押し出すたびに変わる時刻は、見比べの対象にしない ----------
//   ★2026-09-29 に方針を反転させた。
//     残数と枠の「計算した時刻」は毎回書き直す。書かないと、押し出しが届かなかった
//     会員の古い行と、中身が変わっていないだけの行を区別できず、
//     古い残数を「たった今の情報」として返してしまう（本番で見つかった穴）。
//     残数39行＋枠3行なので、1日10万行の枠から見れば無視できる。
{
  const cur = [{ customer_id: 'c1', payload: '{"quota":6}', computed_at: 111 }];
  const env = makeEnv('TEST-SECRET', cur);
  const [, b] = await json(await handleIngest(req({
    kind: 'home', scope: 'all', batchId: 1000,
    rows: [{ customer_id: 'c1', payload: '{"quota":6}', computed_at: 999 }],   // 時刻だけ違う
  }, 'TEST-SECRET'), env));
  eq('★残数：時刻だけ違っても書く（鮮度の判定に使うため）', [b.written, b.skipped], [1, 0]);
}
{
  const cur = [{ customer_id: 'c1', payload: '{"quota":6}', computed_at: 111 }];
  const env = makeEnv('TEST-SECRET', cur);
  const [, b] = await json(await handleIngest(req({
    kind: 'home', scope: 'all', batchId: 1001,
    rows: [{ customer_id: 'c1', payload: '{"quota":5}', computed_at: 999 }],   // 残数が変わった
  }, 'TEST-SECRET'), env));
  eq('★残数が変わったら書く', b.written, 1);
}
{
  const cur = [{ trainer_id: 't1', payload: '{"slots":[]}', computed_at: 111 }];
  const env = makeEnv('TEST-SECRET', cur);
  const [, b] = await json(await handleIngest(req({
    kind: 'slots', scope: 'all', batchId: 1002,
    rows: [{ trainer_id: 't1', payload: '{"slots":[]}', computed_at: 999 }],
  }, 'TEST-SECRET'), env));
  eq('★枠：時刻だけ違っても書く（鮮度の判定に使うため）', [b.written, b.skipped], [1, 0]);
}

// ---------- ★押し出しの走査範囲（2026-10-03・Codexの設計レビュー）----------
//   「全件を走査したか（scope）」と「古い行を消してよいか（deleteStale）」は別物。
//   以前は deleteStale ひとつで両方を表しており、全件を送っている15分同期と
//   1人ぶんの押し出しが区別できなかった。そのため1人が予約するたびに
//   全体の同期時刻が若返り、他の顧客の古い予約行まで新しい顔で使われていた。
{
  // 未指定・知らない値は**断る**。黙って partial 扱いにしない。
  const e1 = makeEnv();
  const [st1, b1] = await json(await handleIngest(
    req({ kind: 'customers', batchId: 1000, rows: [{ customer_id: 'c1', name: '山田' }], final: true }, 'TEST-SECRET'), e1));
  eq('★scope が無ければ断る', [st1, b1.code], [400, 'SCOPE_REQUIRED']);
  eq('★断ったら1行も書かない', e1._sql.some((x) => /INSERT INTO customers/.test(x.q)), false);

  const e2 = makeEnv();
  const [st2, b2] = await json(await handleIngest(
    req({ kind: 'customers', batchId: 1001, rows: [], final: true, scope: 'ALL' }, 'TEST-SECRET'), e2));
  eq('★知らない値も断る（大文字小文字も区別する）', [st2, b2.code], [400, 'SCOPE_REQUIRED']);

  // 「消してよい」は「全件を走査した」より強い宣言。矛盾したら断る。
  const e3 = makeEnv();
  const [st3, b3] = await json(await handleIngest(
    req({ kind: 'customers', batchId: 1002, rows: [], final: true,
          scope: 'partial', deleteStale: true }, 'TEST-SECRET'), e3));
  eq('★一部しか送っていないのに消す指定は断る', [st3, b3.code], [400, 'SCOPE_CONFLICT']);
  eq('★断ったら削除も走らない', e3._sql.some((x) => /DELETE/.test(x.q)), false);
}

// ★一部だけの押し出しでは、全体の同期時刻を押さない（これが今回の本丸）
{
  const env = makeEnv();
  await handleIngest(req({ kind: 'reservations', batchId: 1100, final: true, scope: 'partial',
    rows: [{ reservation_id: 'r1', customer_id: 'c1', trainer_id: 't1', start_at: 1, status: 'booked' }] }, 'TEST-SECRET'), env);
  eq('★1人ぶんの押し出しで全体の同期時刻を押さない',
     env._sql.some((x) => /INSERT INTO sync_state/.test(x.q)), false);
  eq('行そのものは書く', env._sql.some((x) => /INSERT INTO reservations/.test(x.q)), true);
}

// ★全件を走査し終えたなら、消す指定が無くても同期時刻を押す（15分ごとの同期）
{
  const env = makeEnv();
  await handleIngest(req({ kind: 'reservations', batchId: 1101, final: true, scope: 'all',
    rows: [{ reservation_id: 'r1', customer_id: 'c1', trainer_id: 't1', start_at: 1, status: 'booked' }] }, 'TEST-SECRET'), env);
  eq('★15分ごとの全件同期では同期時刻を押す',
     env._sql.some((x) => /INSERT INTO sync_state/.test(x.q)), true);
  eq('消す指定が無ければ削除は走らない', env._sql.some((x) => /DELETE/.test(x.q)), false);
}

// ★途中のチャンク（final でない）では押さない
{
  const env = makeEnv();
  await handleIngest(req({ kind: 'reservations', batchId: 1102, final: false, scope: 'all',
    rows: [{ reservation_id: 'r1', customer_id: 'c1', trainer_id: 't1', start_at: 1, status: 'booked' }] }, 'TEST-SECRET'), env);
  eq('★途中のチャンクでは同期時刻を押さない',
     env._sql.some((x) => /INSERT INTO sync_state/.test(x.q)), false);
}

// ★元データが読めなかった疑いのある空の完全同期では、同期時刻も押さない
//   削除を止めた理由（元が読めていないかもしれない）と矛盾するため。
{
  const env = makeEnv();
  const [, b] = await json(await handleIngest(
    req({ kind: 'customers', batchId: 1103, rows: [], final: true, scope: 'all', deleteStale: true }, 'TEST-SECRET'), env));
  eq('空なら削除を止める', b.skippedDelete, 'EMPTY_SOURCE');
  eq('★★そのとき同期時刻も押さない（古い行を新しい顔にしない）',
     env._sql.some((x) => /INSERT INTO sync_state/.test(x.q)), false);
}

// ============================================================
// scope:'customer' ── その会員ぶんを世代で入れ替える（2026-10-08・段階3-a）
//   これが無いと、取り消された予約の計算入力が D1 に残り続け、
//   作り直してもその予約を「生きている」として引当を作る＝取消が永遠に伝わらない。
// ============================================================
console.log('=== scope:customer（会員ぶんの入れ替え）===');
{
  const env = makeEnv();
  const row = { row_key: 'k1', customer_id: 'C1', row_json: '{}' };
  const [s, b] = await json(await handleIngest(
    req({ kind: 'calcReservations', scope: 'customer', customerId: 'C1', batchId: 9, rows: [row] }, 'TEST-SECRET'), env));
  eq('①通る', s, 200);
  const del = env._sql.filter((x) => /DELETE FROM calc_reservation_rows/.test(x.q));
  eq('①★削除は1文', del.length, 1);
  eq('①★会員で閉じている', /customer_id = \?/.test(del[0].q), true);
  eq('①★この世代より古い行だけ消す', /synced_at IS NULL OR synced_at < \?/.test(del[0].q), true);
  eq('①削除の引数は会員IDと世代', del[0].args, ['C1', 9]);
  eq('①★同期時刻は押さない', env._sql.some((x) => /INSERT INTO sync_state/.test(x.q)), false);
  eq('①入れた数と消した数を返す', [b.written, b.removed], [1, 1]);
}
{
  //   ★中身が同じ行も必ず書く。書かないと世代が古いまま残り、削除で消える。
  const same = { row_key: 'k1', customer_id: 'C1', row_json: '{}' };
  const env = makeEnv('TEST-SECRET', [same]);
  const [, b] = await json(await handleIngest(
    req({ kind: 'calcReservations', scope: 'customer', customerId: 'C1', batchId: 9, rows: [same] }, 'TEST-SECRET'), env));
  eq('②★同じ行でも飛ばさない', b.skipped, 0);
  eq('②書いている', b.written, 1);
}
{
  //   会員が指定されていなければ断る（削除の範囲が決まらない）
  const env = makeEnv();
  const [s, b] = await json(await handleIngest(
    req({ kind: 'calcReservations', scope: 'customer', batchId: 9, rows: [] }, 'TEST-SECRET'), env));
  eq('③★会員の指定が無ければ断る', [s, b.code], [400, 'CUSTOMER_REQUIRED']);
  eq('③何も消していない', env._sql.some((x) => /DELETE/.test(x.q)), false);
}
{
  //   他人の行が混ざっていたら断る。混ざったぶんだけ捨てると気づけない
  const env = makeEnv();
  const [s, b] = await json(await handleIngest(
    req({ kind: 'calcReservations', scope: 'customer', customerId: 'C1', batchId: 9,
          rows: [{ row_key: 'k1', customer_id: 'C1', row_json: '{}' },
                 { row_key: 'k2', customer_id: 'C2', row_json: '{}' }] }, 'TEST-SECRET'), env));
  eq('④★他人が混ざれば断る', [s, b.code], [400, 'CUSTOMER_MISMATCH']);
  eq('④何も書いていない', env._sql.some((x) => /INSERT INTO calc_reservation_rows/.test(x.q)), false);
}
{
  //   customer_id を持たない表では使えない（会員で閉じた削除ができない）
  const env = makeEnv();
  const [s, b] = await json(await handleIngest(
    req({ kind: 'trainers', scope: 'customer', customerId: 'C1', batchId: 9, rows: [] }, 'TEST-SECRET'), env));
  eq('⑤★customer_id の無い表は断る', [s, b.code], [400, 'SCOPE_NOT_SUPPORTED']);
}
{
  //   ★rows が0件でも消す。その会員の予約が全部取り消された状態は正常。
  //     「読めなかった」は送り手が送らない（_edgeCalcReservations は null を返す）。
  const env = makeEnv();
  const [s, b] = await json(await handleIngest(
    req({ kind: 'calcReservations', scope: 'customer', customerId: 'C1', batchId: 9, rows: [] }, 'TEST-SECRET'), env));
  eq('⑥★0件でも消す（最後の1件の取消が伝わる）', [s, b.removed], [200, 1]);
  eq('⑥書いた行は0', b.written, 0);
}
{
  //   deleteStale（表全体から消す）とは別物。混ぜたら断る
  const env = makeEnv();
  const [s, b] = await json(await handleIngest(
    req({ kind: 'calcReservations', scope: 'customer', customerId: 'C1', batchId: 9,
          deleteStale: true, rows: [] }, 'TEST-SECRET'), env));
  eq('⑦★deleteStale と混ぜたら断る', [s, b.code], [400, 'SCOPE_CONFLICT']);
}

console.log(`\n取り込み口 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
