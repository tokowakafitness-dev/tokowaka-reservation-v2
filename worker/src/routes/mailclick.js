/**
 * メールのリンクが踏まれたことを、1人ずつ記録する（2026-10-16）
 *
 * ★いちばん大事な決まり：**記録のために予約を止めない。**
 *   記録に失敗しても 204 を返す。呼ぶ側（/r/ の中継ページ）は応答を待たずに
 *   予約サイトへ進む。ここが落ちても、お客様は予約できる。
 *
 * ★二番目に大事な決まり：**この口から予約系を道連れにしない。**（関門② 指摘1）
 *   /r は認証なしで公開する。同じD1を予約系が使っているため、
 *   ここで行を無制限に増やされると書き込み上限を使い切られ、予約が止まる。
 *   対策は3つ。(a) 1 token = 1行（増えるのは「踏んだ人の数」まで）
 *             (b) 1日に新しく作れる行数に上限（DAILY_NEW_CAP）
 *             (c) 本文の大きさに上限（巨大なJSONを読ませない）
 *   上限に当たったら**記録をやめるだけ**。お客様の遷移には一切影響しない。
 */
import { safeEqual } from '../lib/safe-equal.js';

const TOKEN_RE = /^[0-9a-f]{8,32}$/;
/** 種類は許可一覧で縛る。文字種だけだと攻撃者が無限に分類を作れる（指摘3） */
const KINDS = ['monitor_pass'];
/** 1日に新しく作れる行数。普通の運用では1日数件。桁で余裕を見ている */
const DAILY_NEW_CAP = 500;
/** 本文の上限。{"t":32文字,"k":32文字} でも100バイト未満（指摘2） */
const MAX_BODY = 512;
/** まとめ問い合わせの本文の上限。印200件でも 8KB には遠く届かない */
const MAX_LOOKUP_BODY = 8192;

function noContent(origin) {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin || '*',
      'Cache-Control': 'no-store'
    }
  });
}

/**
 * POST /r   body: {"t":"<token>","k":"<kind>"}
 * 中継ページから sendBeacon で呼ばれる。text/plain なので事前確認（preflight）は無い。
 */
export async function handleMailClick(request, env, origin) {
  // 何があっても 204。記録の失敗を呼び出し側に伝えない（伝えても使い道がない）
  try {
    const len = Number(request.headers.get('Content-Length') || 0);
    if (len > MAX_BODY) return noContent(origin);

    const body = await request.text();
    if (body.length > MAX_BODY) return noContent(origin);

    const d = JSON.parse(body || '{}');
    const token = String(d.t || '').toLowerCase();
    const kind = String(d.k || 'monitor_pass');

    if (!TOKEN_RE.test(token) || KINDS.indexOf(kind) < 0) return noContent(origin);

    const now = Date.now();

    // 既にある token なら、行は増えない。回数と最終時刻だけ更新する
    const upd = await env.DB.prepare(
      'UPDATE mail_clicks SET last_at = ?, times = times + 1 WHERE token = ?'
    ).bind(now, token).run();
    if (upd.meta && upd.meta.changes > 0) return noContent(origin);

    // ここから先は「新しい行を作る」経路。1日の上限を見てから作る。
    // 読み取りは1日500万行まで許されるので、読んで止めるほうが安全。
    const since = now - 24 * 3600 * 1000;
    const c = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM mail_clicks WHERE first_at > ?'
    ).bind(since).first();
    if (c && Number(c.n) >= DAILY_NEW_CAP) return noContent(origin);

    await env.DB.prepare(
      'INSERT OR IGNORE INTO mail_clicks (token, kind, first_at, last_at, times) VALUES (?, ?, ?, ?, 1)'
    ).bind(token, kind, now, now).run();
  } catch (_) {
    // 握りつぶす。記録は best-effort
  }
  return noContent(origin);
}

/**
 * POST /r/lookup   body: {"t":["<token>", ...]}
 * 「この印は踏まれたか」を引く。台帳（GAS）が自分の持つ印をまとめて問い合わせる。
 *
 * ★合言葉が要る（関門② 2026-10-16）。
 *   当初は「印を知っていることが条件」で公開する設計にしたが、
 *   印は16進8桁＝約43億通りで、登録が500件あれば**4万回ほどの総当たりで1件当たる**。
 *   さらに、認証なしだと**予約系と同じD1を無制限に読ませる**ことになり、
 *   読み取り枠を使い切られれば予約が止まる。合言葉で閉じる。
 */
export async function handleMailClickLookup(request, env) {
  const secret = env.SHARED_SECRET || '';
  if (!secret) {
    return new Response(JSON.stringify({ ok: false, code: 'SECRET_NOT_SET' }), {
      status: 503, headers: { 'Content-Type': 'application/json' }
    });
  }
  if (!safeEqual(request.headers.get('X-Ingest-Secret') || '', secret)) {
    return new Response(JSON.stringify({ ok: false, code: 'FORBIDDEN' }), {
      status: 403, headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    /* ★Content-Length は chunked で付けずに送れる。本文を読んでから長さで縛る
       （関門② 指摘2）。先に Content-Length で弾けるものは弾いておく。 */
    const declared = Number(request.headers.get('Content-Length') || 0);
    if (declared > MAX_LOOKUP_BODY) return new Response('{"ok":false}', { status: 413 });

    const text = await request.text();
    if (text.length > MAX_LOOKUP_BODY) return new Response('{"ok":false}', { status: 413 });

    const d = JSON.parse(text || '{}');
    const list = Array.isArray(d.t) ? d.t : [];
    const tokens = [];
    for (let i = 0; i < list.length && tokens.length < 200; i++) {
      const t = String(list[i] || '').toLowerCase();
      if (TOKEN_RE.test(t) && tokens.indexOf(t) < 0) tokens.push(t);
    }
    if (!tokens.length) return new Response(JSON.stringify({ ok: true, rows: [] }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });

    const marks = tokens.map(function () { return '?'; }).join(',');
    const q = await env.DB.prepare(
      'SELECT token, first_at, last_at, times FROM mail_clicks WHERE token IN (' + marks + ')'
    ).bind(...tokens).all();

    return new Response(JSON.stringify({ ok: true, rows: q.results || [] }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  } catch (_) {
    return new Response(JSON.stringify({ ok: false }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * GET /r/list?kind=monitor_pass
 * 合言葉が要る。token ごとの初回・最終クリック時刻と回数を返す。
 * 氏名は返さない（持っていない）。台帳側で token を突き合わせる。
 */
export async function handleMailClickList(request, env) {
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  const secret = env.SHARED_SECRET || '';
  if (!secret) {
    return new Response(JSON.stringify({ ok: false, code: 'SECRET_NOT_SET' }), {
      status: 503, headers: { 'Content-Type': 'application/json' }
    });
  }
  if (!safeEqual(request.headers.get('X-Ingest-Secret') || '', secret)) {
    return new Response(JSON.stringify({ ok: false, code: 'FORBIDDEN' }), {
      status: 403, headers: { 'Content-Type': 'application/json' }
    });
  }

  const url = new URL(request.url);
  const kind = String(url.searchParams.get('kind') || 'monitor_pass');
  if (KINDS.indexOf(kind) < 0) {
    return new Response(JSON.stringify({ ok: false, code: 'BAD_KIND' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  const r = await env.DB.prepare(
    'SELECT token, first_at, last_at, times FROM mail_clicks WHERE kind = ? ORDER BY first_at'
  ).bind(kind).all();

  return new Response(JSON.stringify({ ok: true, kind, rows: r.results || [] }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}
