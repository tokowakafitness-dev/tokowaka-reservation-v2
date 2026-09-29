// 作業の受け渡し（2026-09-29）
//
//   GASに新しい公開入口を作らずに、点検を実行してもらうための仕組み。
//   GASが1分ごとに「やることある？」と聞きに来る。こちらからGASは呼ばない。
//
//   登録・受け取り・報告 … 合言葉が要る（GASとGitHub Actionsだけ）
//   結果を読む            … request_id を知っていることが鍵
//   ★結果に個人情報を入れない。読み取りに合言葉が要らないため。

const OPS = new Set(['audit', 'verify', 'previewMerge', 'testConnection', 'pushAll']);
// 写しを書き換える作業は点検と分ける（Codexの指摘）。二重起動も防ぐ。
const WRITE_OPS = new Set(['pushAll']);

const MAX_RESULT = 60000;      // 返す文字数の上限。途中で切れたことが分かるようにする
const JOB_TTL_MS = 24 * 3600000;
const CLAIM_TIMEOUT_MS = 10 * 60000;   // 受け取ったまま10分報告が無ければ、落ちたとみなす

function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a || ''));
  const y = new TextEncoder().encode(String(b || ''));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}
const json = (b, s = 200) => new Response(JSON.stringify(b), {
  status: s, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});
const authed = (request, env) =>
  !!env.SHARED_SECRET && safeEqual(request.headers.get('X-Ingest-Secret') || '', env.SHARED_SECRET);

/** GET /jobs/<request_id> … 結果を読む。合言葉は不要（IDを知っていることが鍵） */
export async function handleJobRead(request, env, requestId) {
  if (!/^[A-Za-z0-9_-]{24,64}$/.test(requestId)) return json({ success: false, code: 'BAD_ID' }, 400);
  const row = await env.DB.prepare(
    'SELECT request_id, op, status, enqueued_at, claimed_at, finished_at, result, error FROM jobs WHERE request_id = ?'
  ).bind(requestId).first();
  if (!row) return json({ success: false, code: 'NOT_FOUND' }, 404);
  return json({ success: true, job: row });
}

/** POST /jobs … 合言葉が要る。登録・受け取り・報告 */
export async function handleJobs(request, env) {
  try {
    if (!env.SHARED_SECRET) return json({ success: false, code: 'SECRET_NOT_SET' }, 503);
    if (!authed(request, env)) return json({ success: false, code: 'FORBIDDEN' }, 403);

    let body;
    try { body = await request.json(); } catch (_) { return json({ success: false, code: 'BAD_JSON' }, 400); }
    const action = String(body.action || '');

    // ---- 登録（GitHub Actions が行う）----
    if (action === 'enqueue') {
      const id = String(body.requestId || '');
      if (!/^[A-Za-z0-9_-]{24,64}$/.test(id)) return json({ success: false, code: 'BAD_ID' }, 400);
      const op = String(body.op || '');
      if (!OPS.has(op)) return json({ success: false, code: 'UNKNOWN_OP' }, 400);
      const args = body.args == null ? null : JSON.stringify(body.args).slice(0, 2000);

      // 同じ作業が待機中なら増やさない（押し過ぎで詰まらせない）
      const pending = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM jobs WHERE op = ? AND status IN ('pending','running')"
      ).bind(op).first();
      if (pending && pending.n >= 2) return json({ success: false, code: 'TOO_MANY_PENDING' }, 429);

      await env.DB.prepare(
        `INSERT INTO jobs (request_id, op, args, status, enqueued_at) VALUES (?, ?, ?, 'pending', ?)
         ON CONFLICT(request_id) DO NOTHING`
      ).bind(id, op, args, Date.now()).run();
      return json({ success: true, requestId: id, op });
    }

    // ---- 受け取り（GASが1分ごとに聞きに来る）----
    if (action === 'claim') {
      const now = Date.now();
      // 受け取ったまま落ちた作業を戻す
      await env.DB.prepare(
        "UPDATE jobs SET status = 'pending', claimed_at = NULL WHERE status = 'running' AND claimed_at < ?"
      ).bind(now - CLAIM_TIMEOUT_MS).run();

      const row = await env.DB.prepare(
        "SELECT request_id, op, args FROM jobs WHERE status = 'pending' ORDER BY enqueued_at LIMIT 1"
      ).first();
      if (!row) return json({ success: true, job: null });

      // 取り合いにならないよう、pendingのままのものだけを running にする
      const upd = await env.DB.prepare(
        "UPDATE jobs SET status = 'running', claimed_at = ? WHERE request_id = ? AND status = 'pending'"
      ).bind(now, row.request_id).run();
      if (!upd.meta || upd.meta.changes !== 1) return json({ success: true, job: null });

      return json({ success: true, job: {
        requestId: row.request_id, op: row.op,
        args: row.args ? JSON.parse(row.args) : null,
        isWrite: WRITE_OPS.has(row.op),
      } });
    }

    // ---- 報告（GASが結果を返す）----
    if (action === 'report') {
      const id = String(body.requestId || '');
      if (!/^[A-Za-z0-9_-]{24,64}$/.test(id)) return json({ success: false, code: 'BAD_ID' }, 400);
      const okFlag = body.ok === true;
      let result = String(body.result == null ? '' : body.result);
      let truncated = false;
      if (result.length > MAX_RESULT) { result = result.slice(0, MAX_RESULT); truncated = true; }
      const err = body.error == null ? null : String(body.error).slice(0, 1000);

      await env.DB.prepare(
        `UPDATE jobs SET status = ?, finished_at = ?, result = ?, error = ?
          WHERE request_id = ? AND status = 'running'`
      ).bind(okFlag ? 'done' : 'failed', Date.now(),
             result + (truncated ? '\n…（長すぎるため途中で切りました）' : ''), err, id).run();
      return json({ success: true, truncated });
    }

    // ---- 片付け ----
    if (action === 'cleanup') {
      const del = await env.DB.prepare('DELETE FROM jobs WHERE enqueued_at < ?')
        .bind(Date.now() - JOB_TTL_MS).run();
      return json({ success: true, removed: (del.meta && del.meta.changes) || 0 });
    }

    return json({ success: false, code: 'UNKNOWN_ACTION' }, 400);
  } catch (e) {
    return json({ success: false, code: 'INTERNAL', detail: String((e && e.message) || e).slice(0, 300) }, 500);
  }
}

export const _forTest = { OPS, WRITE_OPS, MAX_RESULT };
