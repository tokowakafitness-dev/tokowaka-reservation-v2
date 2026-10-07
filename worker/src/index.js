// TOKOWAKA 予約・契約 API（Cloudflare Workers）
//
// 入口はここ1本だけ。すべてのリクエストが
//   ① ID Tokenの署名検証 → ② 役割の確定 → ③ 許可表の照合 → ④ 処理 → ⑤ 応答から機密を落とす
// を必ず通る。個々の処理に権限チェックを書かないので、書き忘れによる穴ができない。
//
// 第1段階の方針：読み取りだけをここで受ける。書き込み（予約・契約）は当面GASのまま。
//   未実装の操作は NOT_IMPLEMENTED を返し、フロントはGASへ落とす。

import { verifyIdToken, resolveRole } from './auth.js';
import { isAllowed, redact, canActOnOther } from './perms.js';
import { routeBoot } from './routes/boot.js';
import { routeCustomerDetail, routeContractList } from './routes/customer.js';
import { routeSlots, routeBookingOptions } from './routes/slots.js';
import { handleIngest } from './routes/ingest.js';
import { handleCalSync } from './routes/calsync.js';
import { handleCalCompare } from './routes/calcompare.js';
import { buildQuota, quotaStatus } from './routes/quota.js';
import { handleCalc } from './routes/verify.js';
import { handleJobs, handleJobRead } from './routes/jobs.js';
import { compatMemberStatus, compatTrainers, compatTrainerReservations,
         compatCustomerHome, compatRecurringList, compatBookingOptions,
         compatBoot, compatCustomerCard, rolesTooOld,
         compatTrainerSlots, compatMyReservations } from './routes/compat.js';

// このオリジンからだけ受ける。ワイルドカードは使わない。
const ALLOWED_ORIGINS = [
  'https://reservation.tokowaka-gym.com',
  'https://tokowakafitness-dev.github.io',
];

// 読み取り操作 → 実装
const HANDLERS = {
  boot:           routeBoot,
  customerDetail: routeCustomerDetail,
  contractList:   routeContractList,
  slots:          routeSlots,
  mySlots:        routeSlots,
  bookingOptions: routeBookingOptions,

  // GAS互換の窓口（画面はこれを呼ぶ）
  c_memberStatus:        compatMemberStatus,
  c_trainers:            compatTrainers,
  c_trainerSlots:        compatTrainerSlots,
  c_bookingOptions:      compatBookingOptions,
  c_myReservations:      compatMyReservations,
  c_trainerReservations: compatTrainerReservations,
  c_customerHome:        compatCustomerHome,
  c_recurringList:       compatRecurringList,

  // まとめ取得（画面の _fetchBoot / _fetchCustomerCard が呼ぶ）。
  //   2026-10-03 の実測で、通信の86%がGASのこの2つだった。
  c_boot:                compatBoot,
  c_customerCard:        compatCustomerCard,
};

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(body, origin, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(origin),
      ...extra,
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const t0 = Date.now();

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    if (url.pathname === '/health') {
      // 同期の鮮度だけ返す。認証不要・個人情報なし。
      let sync = [];
      try {
        const r = await env.DB.prepare('SELECT key, synced_at, rows, ok FROM sync_state').all();
        sync = r.results || [];
      } catch (_) {}
      return json({ ok: true, now: Date.now(), sync }, origin);
    }

    // GASからの押し出し。LINEのID Tokenではなく合言葉で確かめる別経路。
    //   お客様のブラウザからは呼ばせないので、CORSも許さない（Originを返さない）。
    if (url.pathname === '/ingest') {
      if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
      return handleIngest(request, env);
    }

    // ① カレンダー → D1。GASが分類済みの形で押し出す（2026-10-02）。
    //   お客様のブラウザからは呼ばせないので、CORSも許さない（Originを返さない）。
    //   Workerはカレンダーを読まない。ここは受け取って検査して公開するだけ。
    if (url.pathname === '/calsync') {
      if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
      return handleCalSync(request, env);
    }

    // ①の突き合わせ（GASとD1の空き枠を本番で比べて compare_log に記録する）。読み取りのみ。
    if (url.pathname === '/calcompare' || url.pathname === '/calcompare/status'
        || url.pathname === '/calcompare/direct') return handleCalCompare(request, env);

    // 照合専用の入口。GASの計算結果と突き合わせるためだけに使う。
    //   ID Tokenではなく合言葉で確かめる（お客様のブラウザからは呼ばせない）。
    //   nowKey・繰越率・時点はすべてGASから受け取る。こちらで決めると、
    //   時計のずれや既定値の違いが「実装の差」に見えてしまう。
    // 作業の受け渡し。結果を読むのは request_id を知っていることが鍵（合言葉は不要）。
    if (url.pathname.startsWith('/jobs/')) {
      if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
      return handleJobRead(request, env, url.pathname.slice('/jobs/'.length));
    }
    if (url.pathname === '/jobs') {
      if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
      return handleJobs(request, env);
    }

    // 契約から「枠」を作る（段階3-a の土台・2026-10-07）。
    //   既定は dry＝書かない。dry=0 のときだけ D1 へ書く。
    //   合言葉で守る。お客様のブラウザからは呼ばせない（CORSも許さない）。
    if (url.pathname === '/quota/build') return buildQuota(request, env);
    if (url.pathname === '/quota/status') return quotaStatus(request, env);

    if (url.pathname === '/calc') {
      if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
      return handleCalc(request, env);
    }

    if (request.method !== 'POST') {
      return json({ success: false, code: 'METHOD_NOT_ALLOWED' }, origin, 405);
    }

    let body;
    try {
      body = await request.json();
    } catch (_) {
      return json({ success: false, code: 'BAD_JSON' }, origin, 400);
    }

    const action = String(body.action || '');
    if (!action) return json({ success: false, code: 'NO_ACTION' }, origin, 400);

    // ① 署名検証
    const auth = await verifyIdToken(body.idToken, env);
    if (!auth.ok) {
      // 期限切れはフロントが取り直せるよう、他の失敗と区別して返す
      const status = auth.code === 'EXPIRED' ? 401 : 401;
      return json({ success: false, code: auth.code === 'EXPIRED' ? 'UNAUTHORIZED' : 'FORBIDDEN', detail: auth.code }, origin, status);
    }

    // ② 役割の確定
    let who;
    try {
      who = await resolveRole(auth.lineUserId, env);
    } catch (_) {
      return json({ success: false, code: 'DB_UNAVAILABLE' }, origin, 503);
    }

    // ②-2 ★役割と担当の写しが古ければ、何も答えない（2026-10-03・Codexの最終判定）
    //
    //   Workerは「誰がトレーナーか」「誰が誰の担当か」をD1だけで決めている。
    //   その写しが古いまま答えると、
    //     ・会員登録した直後、別の端末では「未登録のお客様」になる
    //     ・担当を変えた直後、前の担当トレーナーがまだその顧客を見られる
    //     ・**同期が止まると、古い権限が無期限に残る**
    //   残数や予約一覧には鮮度の判定があるのに、権限そのものには無かった。
    //   古い権限のうえで正しい残数を返しても意味がない。ここが一番外側の関門。
    //
    //   ★guest も落とす。「まだ登録していない」も役割の判定だから。
    if (/^c_/.test(action) && await rolesTooOld(env)) {
      return json({ success: false, code: 'FALLBACK', detail: 'ROLES_STALE' }, origin, 200,
                  { 'X-Worker-Ms': String(Date.now() - t0) });
    }

    // ③ 許可表の照合（表に無い組み合わせはここで終わる）
    if (!isAllowed(action, who.role)) {
      return json({ success: false, code: 'FORBIDDEN' }, origin, 403);
    }

    // 他人の顧客IDを指定できるのは trainer / owner だけ
    if (body.customerId && !canActOnOther(who.role) && body.customerId !== who.customerId) {
      return json({ success: false, code: 'FORBIDDEN' }, origin, 403);
    }

    // ④-0 ★読み取りの肩代わりを全部止めるための一行（2026-10-03）
    //
    //   EDGE_READS = "off" を wrangler.toml に足して deploy すれば、
    //   画面に一切触れずに**全員がGASへ戻る**。1分ほどで効く。
    //
    //   ★なぜ画面側の既定（EDGE_ON）だけでは足りないか
    //     1. 画面は端末のキャッシュに載っている。push しても即座には届かない。
    //     2. 既定を false にしても、鍵の読み方（`!== '0'`）が対で直っていないと
    //        鍵の無い端末は式のほうで true に戻る。**2026-09-29に実際に起きた。**
    //        「止めたつもりで止まっていなかった」事故は、止める手段を画面に置いたことが原因。
    //     止める手段は、画面を経由しない1か所に置く。ここがその1か所。
    //
    //   ★対象は画面が呼ぶ窓口（c_ で始まるもの）。
    //     画面の EDGE_MAP の値がすべて c_ で始まることを機械で検査している
    //     （worker/test/edge-killswitch.test.js）。新しい窓口の付け忘れで
    //     「止めたのに一部だけ残る」が起きないようにするため。
    if (String((env && env.EDGE_READS) || '') === 'off' && /^c_/.test(action)) {
      return json({ success: false, code: 'FALLBACK', detail: 'EDGE_READS_OFF' }, origin, 200,
                  { 'X-Worker-Ms': String(Date.now() - t0) });
    }

    // ④ 処理
    const handler = HANDLERS[action];
    if (!handler) {
      // 表には載っているが、まだWorkerに移していない操作。フロントはGASへ落とす。
      return json({ success: false, code: 'NOT_IMPLEMENTED' }, origin, 501);
    }

    let result;
    try {
      result = await handler({ body, env, ctx, who, lineUserId: auth.lineUserId });
    } catch (e) {
      console.error(action, e && e.message);
      return json({ success: false, code: 'INTERNAL' }, origin, 500);
    }

    // 写しを持っていない／古すぎる場合は「答えない」。画面はGASに聞き直す。
    //   間違った残数や古い枠を返すより、遅いほうがよい。
    if (result && result._forbidden) {
      return json({ success: false, code: 'FORBIDDEN' }, origin, 403);
    }
    if (result && result._fallback) {
      return json({ success: false, code: 'FALLBACK' }, origin, 200,
                  { 'X-Worker-Ms': String(Date.now() - t0) });
    }

    // ⑤ 役割に応じて応答から落とす（粗利・他人の連絡先など）
    const safe = redact(result, who.role);
    return json({ success: true, ...safe }, origin, 200, { 'X-Worker-Ms': String(Date.now() - t0) });
  },
};
