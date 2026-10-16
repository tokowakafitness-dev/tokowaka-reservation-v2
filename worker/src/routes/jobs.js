// 作業の受け渡し（2026-09-29）
//
//   GASに新しい公開入口を作らずに、点検を実行してもらうための仕組み。
//   GASが1分ごとに「やることある？」と聞きに来る。こちらからGASは呼ばない。
//
//   登録・受け取り・報告 … 合言葉が要る（GASとGitHub Actionsだけ）
//   結果を読む            … ★読み取りの鍵（ヘッダ X-Job-Read-Key）が要る（2026-10-16）
//     それまでは「request_id を知っていること」が鍵だった。だが request_id を書く ops/job.json は
//     **一般公開のリポジトリ**にあり、誰でも番号が分かる。日次点検の結果には顧客の氏名が入る回があった。
//     いまは依頼のたびに CEO が手元で鍵を作り、公開するのは SHA-256（args._rk）だけ。
//     鍵の無い依頼の結果は返さない（状態だけ返す）。

const OPS = new Set(['audit', 'verify', 'previewMerge', 'testConnection', 'pushAll', 'remaining', 'remainingAt', 'nudgePreview', 'quotaBuild']);
// 写しを書き換える作業は点検と分ける（Codexの指摘）。二重起動も防ぐ。
// 書き込みを伴う作業。承認や記録の扱いが読み取り専用と変わる。
//   ★quotaBuild は args.write を付けたときだけ書く。付けなければ試すだけ。
//     「書くかもしれない」ものはここに入れておく（安全側）。
const WRITE_OPS = new Set(['pushAll', 'quotaBuild']);

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

async function sha256hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** GET /jobs/<request_id>（ヘッダ X-Job-Read-Key: <読み取りの鍵>）… 結果を読む
 *   ★鍵は URL に載せない（アクセスの記録・シェルの履歴に残る）。鍵は乱数24バイトの16進＝48桁だけ受け付ける */
export async function handleJobRead(request, env, requestId) {
  if (!/^[A-Za-z0-9_-]{24,64}$/.test(requestId)) return json({ success: false, code: 'BAD_ID' }, 400);
  const row = await env.DB.prepare(
    'SELECT request_id, op, status, enqueued_at, claimed_at, finished_at, result, error, read_key_hash FROM jobs WHERE request_id = ?'
  ).bind(requestId).first();
  if (!row) return json({ success: false, code: 'NOT_FOUND' }, 404);
  //   ★鍵が合うときだけ結果を返す。鍵の無い依頼（古い形）・鍵が違う・鍵が無いは、状態だけ（結果と理由は返さない）
  const k = request.headers.get('X-Job-Read-Key') || '';
  const okKey = !!row.read_key_hash && /^[0-9a-f]{64}$/.test(row.read_key_hash) && /^[0-9a-f]{48}$/.test(k)
    && safeEqual(await sha256hex(k), row.read_key_hash);
  const job = { request_id: row.request_id, op: row.op, status: row.status, enqueued_at: row.enqueued_at,
                claimed_at: row.claimed_at, finished_at: row.finished_at,
                result: okKey ? row.result : null, error: okKey ? row.error : null };
  if (!okKey) job.withheld = row.read_key_hash ? 'BAD_KEY' : 'NO_READ_KEY';
  return json({ success: true, job });
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
      //   ★読み取りの鍵のハッシュ（args._rk）を取り出して別の列に置き、GAS に渡す args からは外す
      //   ★鍵の無い依頼は受け付けない（関門②・Codex）。受け付けると実行はされるのに結果を誰も読めず、
      //     依頼した側は「結果は読めます」の表示のまま待つ＝黙って失敗する。断れば Actions が赤くなる
      let a0 = body.args;
      const rk = (a0 && typeof a0 === 'object' && !Array.isArray(a0) && typeof a0._rk === 'string'
                  && /^[0-9a-f]{64}$/.test(a0._rk)) ? a0._rk : null;
      if (!rk) return json({ success: false, code: 'NO_READ_KEY' }, 400);
      a0 = Object.assign({}, a0); delete a0._rk;
      const args = a0 == null ? null : JSON.stringify(a0).slice(0, 2000);

      // 同じ作業が待機中なら増やさない（押し過ぎで詰まらせない）
      const pending = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM jobs WHERE op = ? AND status IN ('pending','running')"
      ).bind(op).first();
      if (pending && pending.n >= 2) return json({ success: false, code: 'TOO_MANY_PENDING' }, 429);

      await env.DB.prepare(
        `INSERT INTO jobs (request_id, op, args, status, enqueued_at, read_key_hash) VALUES (?, ?, ?, 'pending', ?, ?)
         ON CONFLICT(request_id) DO NOTHING`
      ).bind(id, op, args, Date.now(), rk).run();
      return json({ success: true, requestId: id, op });
    }

    // ---- 疎通の確認だけ（仕事は取らない）----
    //   設定が正しいかを確かめるために使う。claim を使うと仕事を1つ取って
    //   捨ててしまう（2026-09-29 実際にやってしまった）。
    if (action === 'ping') return json({ success: true, pong: true });

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
