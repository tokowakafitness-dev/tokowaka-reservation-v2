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
           'default_trainer_id', 'contract_status', 'contract_type', 'lang', 'goal', 'note',
           'created_at', 'updated_at'],
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
           'kind', 'book_type', 'attendee_count', 'status', 'calendar_event_id', 'channel',
           'created_by', 'created_at'],
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
    // ★computed_at は毎回書き直す（skipCompare にしない）。
    //   鮮度は「その行がいつ計算されたか」で見るため、ここを省くと
    //   押し出しが届かなかった会員の古い行と区別がつかなくなる。
    //   39行なので、D1の書き込み枠（1日10万行）から見れば無視できる量。
  },
  slots: {
    table: 'slots_cache',
    key: 'trainer_id',
    cols: ['trainer_id', 'payload', 'computed_at'],
    keepStale: true,
    // ★枠も毎回 computed_at を書き直す（3行だけ）。理由は home と同じ。
  },
  // ---- 残数計算のための「入力の写し」（列に変換せず行のまま）----
  calcContracts: {
    table: 'calc_contract_rows',
    key: 'row_key',
    cols: ['row_key', 'customer_id', 'idx', 'row_json', 'start_ms', 'end_ms'],
  },
  calcReservations: {
    table: 'calc_reservation_rows',
    key: 'row_key',
    cols: ['row_key', 'customer_id', 'row_json'],
  },
  opening: {
    table: 'member_opening',
    key: 'customer_id',
    cols: ['customer_id', 'payload'],
  },
  calcMeta: {
    table: 'calc_meta',
    key: 'key',
    cols: ['key', 'payload'],
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

  // ★KVへの取り込みは廃止した（2026-09-28）。
  //   残数も枠もD1へ移したので業務では使わない。受け口を残すと、合言葉が漏れたときに
  //   認証で使う公開鍵（jwks:line）を上書きされ、偽のIDトークンを通される恐れがある。
  //   KVはWorkerが自分で書く公開鍵の置き場としてのみ使う。
  if (kind === 'kv') return jsonRes({ success: false, code: 'KV_INGEST_DISABLED' }, 400);

  // ---- D1への押し出し ----
  const conf = TABLES[kind];
  if (!conf) return jsonRes({ success: false, code: 'UNKNOWN_KIND' }, 400);

  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length > MAX_ROWS) return jsonRes({ success: false, code: 'TOO_MANY' }, 413);

  const cols = conf.cols.concat(['synced_at']);
  const placeholders = cols.map(() => '?').join(', ');
  // 主キーが同じなら中身を入れ替える（同じ押し出しを2回流しても結果が変わらない）
  const updates = cols.filter((c) => c !== conf.key).map((c) => `${c} = excluded.${c}`).join(', ');
  // 行ごとにも世代を見る。古い内容で新しい行を上書きしない。
  const sql = `INSERT INTO ${conf.table} (${cols.join(', ')}) VALUES (${placeholders})
               ON CONFLICT(${conf.key}) DO UPDATE SET ${updates}
               WHERE ${conf.table}.synced_at IS NULL OR excluded.synced_at >= ${conf.table}.synced_at`;

  // 古いバッチが遅れて届いても、新しい内容を巻き戻さない。
  //   押し出しが重なったとき、先に走った古い方が後から完了すると、
  //   新しい行を古い内容で上書きし、消えたはずの行を復活させてしまう。
  const seen = await env.DB.prepare('SELECT synced_at FROM sync_state WHERE key = ?').bind(kind).first();
  if (seen && Number(seen.synced_at) > batchId) {
    return jsonRes({ success: false, code: 'STALE_BATCH', detail: 'newer batch already applied' }, 409);
  }

  // ★中身が変わっていない行は書かない（2026-09-29）。
  //   D1の無料枠は1日10万行の書き込み。変わっていない行まで15分ごとに書き直すと、
  //   予約299件だけで1日28,704回になり、枠を使い切って書き込みが止まる。
  //   読み取りは1日500万行まで無料なので、いまの中身を読んで見比べるほうが安い。
  //
  //   ただし deleteStale（1日1回の完全同期）のときは、全行を書く。
  //   古い行を消す判断に synced_at を使うため、書かないと消えてしまう。
  const full = body.deleteStale === true;
  let existing = {};
  if (!full) {
    try {
      const cur = await env.DB.prepare(
        `SELECT ${conf.cols.join(', ')} FROM ${conf.table}`
      ).all();
      for (const row of (cur.results || [])) existing[String(row[conf.key])] = row;
    } catch (_) { existing = {}; }   // 読めなければ全部書く（安全側）
  }
  const skipCmp = new Set(conf.skipCompare || []);
  const same = (a, b) => {
    if (!b) return false;
    for (const c of conf.cols) {
      if (skipCmp.has(c)) continue;
      const x = a[c] === undefined ? null : a[c];
      const y = b[c] === undefined ? null : b[c];
      if (x === null && y === null) continue;
      if (String(x) !== String(y)) return false;
    }
    return true;
  };

  const stmts = [];
  let skipped = 0;
  for (const r of rows) {
    const key = r[conf.key];
    if (key == null || key === '') continue;          // 主キーのない行は捨てる
    if (!full && same(r, existing[String(key)])) { skipped++; continue; }
    const vals = conf.cols.map((c) => (r[c] === undefined ? null : r[c])).concat([batchId]);
    stmts.push(env.DB.prepare(sql).bind(...vals));
  }

  let written = 0;
  if (stmts.length) {
    await env.DB.batch(stmts);
    written = stmts.length;
  }

  let removed = 0;
  // ★0件で final を受けても消さない。元のシートが一時的に読めなかっただけの可能性がある。
  //   顧客や予約がまるごと消えると、会員が「未登録」に見え、予約も全部消える。
  if (body.final && full && !conf.keepStale && rows.length === 0 && body.allowEmpty !== true) {
    await stampSync(env, kind, batchId, null);
    return jsonRes({ success: true, written: 0, removed: 0, skippedDelete: 'EMPTY_SOURCE' });
  }
  // keepStale の表は、今回含まれなかった行を消さない。
  //   残数や枠は「会員の一部だけを更新する」使い方をするため、
  //   含まれなかった＝消えた、ではない。
  // ★古い行を消すのは完全同期のときだけ。
  //   ふだんの押し出しは変わった行しか書かないので、synced_at が古いまま残る行が正常にある。
  //
  // ★全体の同期時刻（sync_state）を押すのは**完全同期のときだけ**（2026-10-03・Codex指摘）。
  //   予約の直後には対象の顧客1人ぶんだけを押し出しており、それにも final が付く。
  //   以前はそれでも sync_state を押していたため、**定期の全体同期が止まっていても、
  //   誰か1人が予約するたびに予約一覧全体が「たったいま同期した」ことになっていた。**
  //   その結果、他の顧客の古い予約行を新しいものとして返しうる。
  //   これは残数で禁止した「一部だけ届いたのに全体時刻で他の行も若返らせる」
  //   （2026-09-29の穴）とまったく同じ形。同じ過ちを別の表で繰り返していた。
  //
  //   差分で押さなくなると、全体同期が止まった時点から sync_state が古くなり、
  //   listTooOld が真になって予約一覧はGASへ落ちる。**遅くなるが正しい。**
  if (body.final && full && !conf.keepStale) {
    // この押し出しに含まれなかった＝Google側から消えた行を落とす。
    // final を受け取ったときだけ実行するので、途中で切れても消えない。
    const del = await env.DB.prepare(
      `DELETE FROM ${conf.table} WHERE synced_at IS NULL OR synced_at < ?`
    ).bind(batchId).run();
    removed = (del.meta && del.meta.changes) || 0;
    await stampSync(env, kind, batchId, null);
  } else if (body.final && full) {
    await stampSync(env, kind, batchId, null);
  }

  return jsonRes({ success: true, written, skipped, removed, mode: full ? 'full' : 'diff' });
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
