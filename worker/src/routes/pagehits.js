/**
 * LP到達とCTAクリックを1時間ごとに数える（2026-10-22）
 *
 * ★いちばん大事な決まり：**計測のために予約を止めない。**
 *   この口は認証なしで公開する。同じD1を予約系が使っているため、
 *   読み書きを使い切られると予約が止まる。
 *
 * 関門①（10/21）と関門②（10/22）の指摘を入れた形：
 *  (1) 上限の門番を **1行の表（page_hits_hour）** にした。
 *      判定が主キー1行の読みで済むので、上限に当たったあとに
 *      何度叩かれても読み取り枠をほとんど消費しない。
 *      （合計を毎回計算する形だと、1回につき最大60行を読んでいた）
 *  (2) 止める理由を2つに分けた。**合計の上限に当たったときだけ**
 *      その時間を打ち切る。行数の上限は「新しい組み合わせを作らない」だけで、
 *      既にある組み合わせの計測は止めない。
 *      （両方を同じ扱いにすると、未知の広告1件で全部の計測が止まる）
 *  (3) 落とした回数をD1に書かない。書くと上限そのものが無効になる。
 *  (4) campaign / content は許可一覧と決まった形だけ。
 *      文字種だけの規則では `090-1234-5678` がそのまま保存された（実測）。
 */
import { safeEqual } from '../lib/safe-equal.js';

/** 1時間に数える上限。実トラフィックは1日300〜800の見込みで、桁で余裕がある */
const HOUR_HIT_CAP = 300;
/** 1時間に作れる行数の上限。普通は数行 */
const HOUR_NEW_ROWS = 60;
const MAX_BODY = 256;

/** 許可するページ名。これ以外は数えない */
const PAGES = new Set([
  'lp',
  /* ★応募フォームに着いた数（2026-10-24）。CTAのクリック数とは別物。
     押しても着かない（戻る・読み込み失敗）ぶんがあるので、こちらが実数に近い。 */
  'apply',
  'cta:hero', 'cta:hope', 'cta:trainer', 'cta:flow',
  'cta:faq', 'cta:footer', 'cta:sticky', 'cta:trainer_modal', 'cta:other'
]);

/** 送り元。ブラウザの sendBeacon は Origin を付ける。curl では偽装できる＝部分的な防御 */
const ORIGINS = new Set([
  'https://tokowaka-gym.com',
  'https://www.tokowaka-gym.com'
]);

/* ★合計の上限に当たった時間を覚えておく。この isolate が生きている間だけ有効。
   共有はされないので完全な防御ではないが、当たったあとのD1アクセスを減らせる。
   残る分も、門番の読みは主キー1行だけなので枠をほとんど食わない。 */
let capped = { hour: '', hit: false };

/** JSTの 'YYYY-MM-DDTHH'。クライアントの時刻は使わない */
export function jstHourKey(ms) {
  return new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 13);
}

/* ★キャンペーン名は運用で増える（meta_20261020_cr4 など）。
   固定の一覧にすると、新しい広告が黙って 'other' に落ち、
   **台帳側の生の値と突き合わない**（2026-10-24 実データで判明）。
   決まった頭文字で始まる形だけを通す。これなら
   電話番号（数字始まり）も氏名（頭文字が一致しない）も入らない。 */
const CAMPAIGN_RE =
  /^((meta|google|line|ig|tr|mail|monitor|bulkup)[a-z0-9_]{0,30}|none)$/;

/** 獲得元。紹介は tr_<トレーナー>。運用で増えたらここに足す */
const SOURCE_RE = /^(tr_[a-z]{2,12}|instagram|facebook|google|line|mail|direct|none)$/;

/** 広告CR・貼り先。cr1〜cr999 と、こちらで決めた名前だけ通す */
const CONTENT_RE = /^(cr\d{1,3}|profile|story|post|highlight|bio|ig_bio|ig_story|ig_post|mail|none)$/;

/**
 * ★電話番号・氏名がD1に入らないようにする（関門② 2026-10-22）。
 *   前の実装は「7桁以上続く数字を落とす」だけだったので、
 *   `090-1234-5678` `03-1234-5678` `taro-yamada` が**そのまま保存された**（実測）。
 *   決まった名前だけを通す形にすれば、個人を示す値は構造的に入らない。
 *
 *   未知の値は 'other' にまとめる。'other' が増えていたら、
 *   新しい広告名が許可一覧に無いということなので、そこで足す。
 */
export function normCampaign(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return 'none';
  return CAMPAIGN_RE.test(s) ? s : 'other';
}
export function normContent(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return 'none';
  return CONTENT_RE.test(s) ? s : 'other';
}
export function normSource(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return 'none';
  return SOURCE_RE.test(s) ? s : 'other';
}

function noContent(origin) {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': ORIGINS.has(origin) ? origin : '*',
      'Cache-Control': 'no-store'
    }
  });
}

/**
 * POST /h   body: {"p":"lp","c":"monitor_bulkup","t":"cr3"}
 * LPから sendBeacon で呼ばれる。text/plain なので事前確認（preflight）は無い。
 */
export async function handlePageHit(request, env, origin) {
  // 何があっても 204。計測の失敗を客側に伝えない（伝えても使い道がない）
  try {
    if (!ORIGINS.has(origin)) return noContent(origin);

    /* ★長さの申告を必須にする（関門② 2026-10-22）。
       申告が無ければ本文を全部読んでからでないと拒否できず、
       大きな本文を送りつけられると Worker の CPU とメモリを使う。
       ブラウザの sendBeacon / fetch は必ず付けるので、正常な経路は落ちない。 */
    const len = Number(request.headers.get('Content-Length') || 0);
    if (!len || len > MAX_BODY) return noContent(origin);
    const text = await request.text();
    if (text.length > MAX_BODY) return noContent(origin);

    const d = JSON.parse(text || '{}');
    const page = String(d.p || '');
    if (!PAGES.has(page)) return noContent(origin);

    const now = Date.now();
    const hour = jstHourKey(now);

    if (capped.hour !== hour) capped = { hour, hit: false };
    /* ★合計の上限に当たった時間は、D1に一切触らない */
    if (capped.hit) return noContent(origin);

    /* ① 門番。主キー1行だけを読む。上限に達していれば何も書かれない */
    const gate = await env.DB.prepare(
      'INSERT INTO page_hits_hour (hour_key, hits) VALUES (?1, 1)' +
      ' ON CONFLICT(hour_key) DO UPDATE SET hits = hits + 1' +
      '   WHERE page_hits_hour.hits < ?2'
    ).bind(hour, HOUR_HIT_CAP).run();

    if (gate.meta && gate.meta.changes === 0) {
      capped = { hour, hit: true };     // ここだけが打ち切りの理由
      return noContent(origin);
    }

    /* ② 内訳。行数の上限は「新しい組み合わせを作らない」だけ。
          既にある組み合わせの計測は止めない（関門② 指摘3） */
    await env.DB.prepare(
      'INSERT INTO page_hits (hour_key, page, source, campaign, content, hits)\n' +
      ' SELECT ?1, ?2, ?3, ?4, ?5, 1\n' +
      '  WHERE EXISTS(SELECT 1 FROM page_hits WHERE hour_key = ?1 AND page = ?2\n' +
      '                 AND source = ?3 AND campaign = ?4 AND content = ?5)\n' +
      '     OR (SELECT COUNT(*) FROM page_hits WHERE hour_key = ?1) < ?6\n' +
      ' ON CONFLICT(hour_key, page, source, campaign, content)\n' +
      '   DO UPDATE SET hits = hits + 1'
    ).bind(hour, page, normSource(d.s), normCampaign(d.c), normContent(d.t), HOUR_NEW_ROWS).run();
  } catch (_) {
    // 握りつぶす。計測は best-effort
  }
  return noContent(origin);
}

/**
 * GET /h/list?from=YYYY-MM-DDTHH&to=YYYY-MM-DDTHH
 * 合言葉が必要。件数だけを返す（個人情報は持っていないので返せない）。
 * ★数字の読み方（関門② 2026-10-22。ここを誤ると判断を誤る）
 *   gate  … **上限の目盛りであって、来訪者数ではない。**
 *            LP表示とCTAクリックを合わせたイベント数が入る。
 *            内訳の書き込みに失敗したぶんも含む。判断には使わない。
 *   rows  … 内訳。**判断にはこちらを使う。** page='lp' はページが開かれた回数
 *            （人数ではない。再読み込み・別タブは別に数える）。
 *            page='cta:*' はクリック回数（フォーム到達人数ではない）。
 *   missed… gate − rows の合計。行数の上限で落ちたぶんと、書き込みに失敗したぶん。
 *            **0でない時間があることを隠さない。** 欠測を知らずに率を出すと嘘になる。
 */
export async function handlePageHitList(request, env) {
  if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });

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
  const re = /^\d{4}-\d{2}-\d{2}T\d{2}$/;
  const now = Date.now();
  let from = String(url.searchParams.get('from') || '');
  let to = String(url.searchParams.get('to') || '');
  if (!re.test(from)) from = jstHourKey(now - 13 * 24 * 3600 * 1000).slice(0, 11) + '00';
  if (!re.test(to)) to = jstHourKey(now);
  if (from > to) { const t = from; from = to; to = t; }

  const rows = await env.DB.prepare(
    'SELECT hour_key, page, source, campaign, content, hits FROM page_hits' +
    ' WHERE hour_key >= ? AND hour_key <= ? ORDER BY hour_key LIMIT 20160'
  ).bind(from, to).all();
  const totals = await env.DB.prepare(
    'SELECT hour_key, hits FROM page_hits_hour' +
    ' WHERE hour_key >= ? AND hour_key <= ? ORDER BY hour_key LIMIT 336'
  ).bind(from, to).all();

  /* 欠測を自分で数えて返す。見る側が気づけるようにする */
  const sum = {};
  for (const r of (rows.results || [])) sum[r.hour_key] = (sum[r.hour_key] || 0) + r.hits;
  const missed = (totals.results || [])
    .map(t => ({ hour_key: t.hour_key, n: t.hits - (sum[t.hour_key] || 0) }))
    .filter(x => x.n > 0);

  return new Response(JSON.stringify({
    ok: true, from, to,
    gate: totals.results || [],   // 上限の目盛り。来訪数ではない
    rows: rows.results || [],     // 判断に使うのはこちら
    missed,                       // 内訳に入らなかった件数。0でなければ率は割り引いて読む
    cap: HOUR_HIT_CAP
  }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
