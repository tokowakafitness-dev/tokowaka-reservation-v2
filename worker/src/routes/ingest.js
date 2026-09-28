// GASからの押し出しを受ける口。
//
// 第1段階では、契約も予約も真実はGoogle側（スプレッドシートとカレンダー）にある。
// ここはその写しを受け取って D1 と KV に置くだけ。Workerは読むのが仕事で、書くのはGASの役目。
//
// 認証：LINEのID Tokenではなく、GASと共有する合言葉（SHARED_SECRET）で確かめる。
//   お客様のブラウザからは絶対に呼ばせない。比較は時間差が出ない方法で行う。
//
// 取り込みの考え方：
//   1回の押し出しを batchId（ミリ秒）で束ねる。行は upsert し、synced_at に batchId を入れる。
//   最後の塊で final=true を受け取ったら、synced_at が古い行を消す。
//   → 途中で通信が切れても、消える前に止まる。中途半端に消えた状態を作らない。

const TABLES = {
  trainers: {
    table: 'trainers',
    key: 'trainer_id',
    cols: ['trainer_id', 'name', 'name_en', 'calendar_id', 'line_user_id', 'role', 'active', 'hidden'],
  },
  customers: {
    table: 'customers',
    key: 'customer_id',
    cols: ['customer_id', 'name', 'kana', 'phone', 'email', 'birthday', 'line_user_id',
           'default_trainer_id', 'contract_status', 'lang', 'goal', 'note', 'created_at', 'updated_at'],
  },
  contracts: {
    table: 'contracts',
    key: 'contract_id',
    cols: ['contract_id', 'customer_id', 'course', 'mode', 'freq', 'tickets', 'unit_price',
           'monthly_price', 'pair', 'rental', 'start_date', 'end_date', 'carry_cap', 'trainer_id',
           'reward_rate', 'join_fee', 'status', 'created_by', 'created_at', 'source', 'sheet_row'],
  },
  reservations: {
    table: 'reservations',
    key: 'reservation_id',
    cols: ['reservation_id', 'customer_id', 'customer_name', 'trainer_id', 'start_at', 'end_at',
           'kind', 'attendee_count', 'status', 'calendar_event_id', 'channel', 'created_by', 'created_at'],
  },
  recurring: {
    table: 'recurring_patterns',
    key: 'pattern_id',
    cols: ['pattern_id', 'customer_id', 'trainer_id', 'weekday', 'time', 'active', 'created_at'],
  },
  // 写し。GASが計算した結果をそのまま持つ（第2段階で計算をWorkerへ移したら不要になる）
  home: {
    table: 'member_home',
    key: 'customer_id',
    cols: ['customer_id', 'payload', 'computed_at'],
    keepStale: true,    // 押し出しに含まれない会員の残数を消さない（部分更新を許す）
  },
  slots: {
    table: 'slots_cache',
    key: 'trainer_id',
    cols: ['trainer_id', 'payload', 'computed_at'],
    keepStale: true,
  },
  body: {
    table: 'body_records',
    key: 'record_id',
    cols: ['record_id', 'customer_id', 'measured_at', 'weight_kg', 'body_fat_pct', 'muscle_kg', 'note', 'created_at'],
    keepStale: true,   // 直近ぶんだけを送るので、含まれない過去の記録を消してはいけない
  },
};

const MAX_ROWS = 500;          // 1回の押し出しで受ける行数の上限
const MAX_KV_ENTRIES = 200;

// 長さと中身の両方で時間差が出ない比較（合言葉の推測を助けない）
function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a || ''));
  const y = new TextEncoder().encode(String(b || ''));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

function jsonRes(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function handleIngest(request, env) {
  try {
    return await ingest(request, env);
  } catch (e) {
    // 中身を返す。ここは合言葉を通った相手（GAS）しか到達しないので、
    // 原因が分からないまま500だけ返すより、直せるほうがよい。
    console.error('ingest', e && e.stack);
    return jsonRes({ success: false, code: 'INTERNAL', detail: String((e && e.message) || e).slice(0, 300) }, 500);
  }
}

async function ingest(request, env) {
  const secret = env.SHARED_SECRET || '';
  if (!secret) return jsonRes({ success: false, code: 'SECRET_NOT_SET' }, 503);

  const given = request.headers.get('X-Ingest-Secret') || '';
  if (!safeEqual(given, secret)) return jsonRes({ success: false, code: 'FORBIDDEN' }, 403);

  let body;
  try { body = await request.json(); } catch (_) { return jsonRes({ success: false, code: 'BAD_JSON' }, 400); }

  const kind = String(body.kind || '');
  const batchId = Number(body.batchId || 0);
  if (!batchId) return jsonRes({ success: false, code: 'NO_BATCH_ID' }, 400);

  // ---- KVへの押し出し（枠・残数・名簿） ----
  if (kind === 'kv') {
    const entries = Array.isArray(body.entries) ? body.entries : [];
    if (entries.length > MAX_KV_ENTRIES) return jsonRes({ success: false, code: 'TOO_MANY' }, 413);
    let n = 0;
    for (const e of entries) {
      const k = String(e.key || '');
      if (!k) continue;
      const opts = e.ttl ? { expirationTtl: Math.max(60, Number(e.ttl)) } : undefined;
      await env.KV.put(k, JSON.stringify(e.value), opts);
      n++;
    }
    if (body.final) await stampSync(env, 'kv:' + (body.label || 'misc'), batchId, n);
    return jsonRes({ success: true, written: n });
  }

  // ---- D1への押し出し ----
  const conf = TABLES[kind];
  if (!conf) return jsonRes({ success: false, code: 'UNKNOWN_KIND' }, 400);

  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length > MAX_ROWS) return jsonRes({ success: false, code: 'TOO_MANY' }, 413);

  const cols = conf.cols.concat(['synced_at']);
  const placeholders = cols.map(() => '?').join(', ');
  // 主キーが同じなら中身を入れ替える（同じ押し出しを2回流しても結果が変わらない）
  const updates = cols.filter((c) => c !== conf.key).map((c) => `${c} = excluded.${c}`).join(', ');
  const sql = `INSERT INTO ${conf.table} (${cols.join(', ')}) VALUES (${placeholders})
               ON CONFLICT(${conf.key}) DO UPDATE SET ${updates}`;

  const stmts = [];
  for (const r of rows) {
    const key = r[conf.key];
    if (key == null || key === '') continue;          // 主キーのない行は捨てる
    const vals = conf.cols.map((c) => (r[c] === undefined ? null : r[c])).concat([batchId]);
    stmts.push(env.DB.prepare(sql).bind(...vals));
  }

  let written = 0;
  if (stmts.length) {
    await env.DB.batch(stmts);
    written = stmts.length;
  }

  let removed = 0;
  // keepStale の表は、今回含まれなかった行を消さない。
  //   残数や枠は「会員の一部だけを更新する」使い方をするため、
  //   含まれなかった＝消えた、ではない。
  if (body.final && !conf.keepStale) {
    // この押し出しに含まれなかった＝Google側から消えた行を落とす。
    // final を受け取ったときだけ実行するので、途中で切れても消えない。
    const del = await env.DB.prepare(
      `DELETE FROM ${conf.table} WHERE synced_at IS NULL OR synced_at < ?`
    ).bind(batchId).run();
    removed = (del.meta && del.meta.changes) || 0;
    await stampSync(env, kind, batchId, null);
  } else if (body.final) {
    await stampSync(env, kind, batchId, null);
  }

  return jsonRes({ success: true, written, removed });
}

async function stampSync(env, key, batchId, rows) {
  let count = rows;
  if (count == null && TABLES[key]) {
    const c = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${TABLES[key].table}`).first();
    count = (c && c.n) || 0;
  }
  await env.DB.prepare(
    `INSERT INTO sync_state (key, synced_at, rows, ok, message) VALUES (?, ?, ?, 1, NULL)
     ON CONFLICT(key) DO UPDATE SET synced_at = excluded.synced_at, rows = excluded.rows, ok = 1, message = NULL`
  ).bind(key, batchId, count == null ? null : count).run();
}

export const _TABLES_FOR_TEST = TABLES;
export const _safeEqualForTest = safeEqual;
