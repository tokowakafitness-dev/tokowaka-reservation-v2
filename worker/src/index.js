// TOKOWAKA 予約・契約 API（Cloudflare Workers）
//
// 入口はここ1本だけ。すべてのリクエストが
//   ① ID Tokenの署名検証 → ② 役割の確定 → ③ 許可表の照合 → ④ 処理 → ⑤ 応答から機密を落とす
// を必ず通る。個々の処理に権限チェックを書かないので、書き忘れによる穴ができない。
//
// 第1段階の方針：読み取りだけをここで受ける。書き込み（予約・契約）は当面GASのまま。
//   未実装の操作は NOT_IMPLEMENTED を返し、フロントはGASへ落とす。

import { verifyIdToken, resolveRole } from './auth.js';
import { handlePageHit, handlePageHitList } from './routes/pagehits.js';
import { isAllowed, redact, canActOnOther } from './perms.js';
import { routeBoot } from './routes/boot.js';
import { routeCustomerDetail, routeContractList } from './routes/customer.js';
import { routeSlots, routeBookingOptions } from './routes/slots.js';
import { handleIngest } from './routes/ingest.js';
import { handleMailClick, handleMailClickList, handleMailClickLookup } from './routes/mailclick.js';
import { handleCalSync } from './routes/calsync.js';
import { handleCalCompare } from './routes/calcompare.js';
import { buildQuota, quotaStatus, quotaBehind } from './routes/quota.js';
import { quotaRebuild } from './routes/quota-rebuild.js';
import { remainAllow, remainProbe } from './routes/remain-allow.js';
import { verifyQuota } from './routes/quota-verify.js';
import { handleCalc } from './routes/verify.js';
import { handleJobs, handleJobRead } from './routes/jobs.js';
import { KARTE_HANDLERS, isKarteWrite, KARTE_LIMITS } from './routes/karte.js';
import { KARTE_AI_HANDLERS, AI_LIMITS, AI_PATH } from './routes/karte-ai.js';
import { handleBodyWrite, handleBodyFreeze, handleBodySeries } from './routes/body.js';
import { compatMyKarte, memberKarteOn } from './routes/member-karte.js';
import { compatMemberStatus, compatTrainers, compatTrainerReservations,
         compatCustomerHome, compatRecurringList, compatBookingOptions,
         compatBoot, compatCustomerCard, rolesTooOld,
         compatTrainerSlots, compatMyReservations } from './routes/compat.js';

// 版の印（/health に載せる・認証不要・個人情報なし）。★Worker を変えて出すたびに上げる。
//   無いと「反映したつもりで入っていない」を外から見分けられない（2026-11-07・設計38 の設置で気づいた）
export const WORKER_BUILD = '2026-11-12a 設計39 文字起こしの AI 下書きの窓口（KARTE_AI_DRAFT 既定 off）';

// このオリジンからだけ受ける。ワイルドカードは使わない。
const ALLOWED_ORIGINS = [
  'https://reservation.tokowaka-gym.com',
  'https://tokowakafitness-dev.github.io',
  /* ★tokowaka-gym.com（LP）はここに足さない（2026-10-22）。
     足すと予約APIの全経路がLPドメインからのCORSを受け入れることになる。
     計測のために予約の口を緩めるのは逆。/h は自分で許可オリジンを持ち、
     自分で CORS ヘッダを返すので、この一覧に入れる必要がない。 */
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

  // 会員が自分のカルテを読む（設計35）。GAS へ送り直さない（画面の EDGE_MAP に載せない）
  c_myKarte:             compatMyKarte,

  // 顧客カルテ（設計28）。k_ は入口で鮮度・停止・Origin・トークンの新しさを通ってから届く
  ...KARTE_HANDLERS,
  // 録音の文字起こしの AI 下書き（設計39）。本文はパス /karte/ai-draft だけ128KB。何も保存しない
  ...KARTE_AI_HANDLERS,
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
      //   ★事前確認には本文が無く action が分からない（設計28 4-5）。許可外の Origin には CORS を返さず403
      if (!ALLOWED_ORIGINS.includes(origin)) return new Response(null, { status: 403 });
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
      return json({ ok: true, now: Date.now(), build: WORKER_BUILD, sync }, origin);
    }

    // メールのリンクが踏まれたことの記録（2026-10-16）。
    //   ★記録のために予約を止めない。何があっても 204 を返し、
    //     呼び出し側（/r/ の中継ページ）は応答を待たずに予約サイトへ進む。
    if (url.pathname === '/r') {
      if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
      return handleMailClick(request, env, origin);
    }
    if (url.pathname === '/r/list') return handleMailClickList(request, env);

    /* LP到達とCTAクリックの件数（2026-10-22）。
       ★完全一致で見る。startsWith('/h') にすると /health を飲み込む。
       ★一般のPOST処理より前に置く（あちらは body.action を読む別の口）。 */
    if (url.pathname === '/h') {
      if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
      return handlePageHit(request, env, origin);
    }
    if (url.pathname === '/h/list') return handlePageHitList(request, env);
    /* 台帳が「この印は踏まれたか」を引く口。**合言葉が要る**（2026-10-16 関門②）。
       当初は「印を知っていることが条件」で公開する設計だったが、
       印は16進8桁で総当たりが現実的なうえ、認証なしだと予約系と同じD1を
       無制限に読ませることになるため、合言葉で閉じた。 */
    if (url.pathname === '/r/lookup') {
      if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
      return handleMailClickLookup(request, env);
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
    // 作業の受け渡し。結果を読むには読み取りの鍵（ヘッダ X-Job-Read-Key）が要る（2026-10-16）。
    //   request_id は公開リポジトリの ops/job.json に載る＝秘密ではない。
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
    //   ★D1 から読ませる会員の許可表と、検証用の会員の試し読み（設計21）。合言葉・POST・本文で ID を受け取る
    if (url.pathname === '/quota/remain-allow') return remainAllow(request, env);
    if (url.pathname === '/quota/remain-probe') return remainProbe(request, env);
    //   ★1名の計算入力を受け取り、入れ替え・作り直し・記録を1つの batch で行う（設計20・決定0091）。
    //     二重書きの後追い処理だけが呼ぶ。合言葉で守る。書き込みなので POST に限る
    if (url.pathname === '/quota/rebuild') {
      if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
      return quotaRebuild(request, env);
    }
    if (url.pathname === '/quota/status') return quotaStatus(request, env);
    //   ★体の記録（設計28 3-1）。GAS からの転送・凍結の写し・突き合わせ用の読み取り。合言葉・POST
    if (url.pathname === '/body/write' || url.pathname === '/body/freeze' || url.pathname === '/body/series') {
      if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
      if (url.pathname === '/body/write') return handleBodyWrite(request, env);
      if (url.pathname === '/body/freeze') return handleBodyFreeze(request, env);
      return handleBodySeries(request, env);
    }
    //   作り直しが追いついていない会員のID（読み取りだけ・設計16）。
    //   呼ぶ側は積むだけ。ここでは作り直さない（古い入力に印を付ける窓を作らないため）。
    if (url.pathname === '/quota/behind') {
      //   読み取りだけなので GET に限る（書き換えの入口と見間違えないため）
      if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
      return quotaBehind(request, env);
    }
    // D1の枠と引当から出した残数が、計算と一致するか（読み取りだけ）。
    //   ★既存の /verify とは別物。あちらは「GASの計算 vs Workerの計算」で、
    //     同じコードを回すので合って当然。こちらは「計算 vs D1の行」を比べる。
    if (url.pathname === '/quota/verify') return verifyQuota(request, env);

    if (url.pathname === '/calc') {
      if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
      return handleCalc(request, env);
    }

    if (request.method !== 'POST') {
      return json({ success: false, code: 'METHOD_NOT_ALLOWED' }, origin, 405);
    }

    // ★本文の大きさを JSON を読む前に縛る（設計28 4-5）。action は本文の中なので全 action に掛ける。
    //   画面からの要求は小さい（最大のまとめて予約12件でも数KB）。/ingest など別の道は上で分かれている
    //   ★設計39：パスが /karte/ai-draft のときだけ128KB（文字起こし）。action との組は読んだ後に両方向で確かめる
    const aiPath = url.pathname === AI_PATH;
    const bodyMax = aiPath ? AI_LIMITS.BODY_BYTES : KARTE_LIMITS.BODY_BYTES;
    const declared = Number(request.headers.get('Content-Length') || 0);
    if (declared > bodyMax) return json({ success: false, code: 'TOO_LARGE' }, origin, 413);
    let body;
    try {
      const buf = await request.arrayBuffer();
      if (buf.byteLength > bodyMax) return json({ success: false, code: 'TOO_LARGE' }, origin, 413);
      body = JSON.parse(new TextDecoder().decode(buf));
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not object');
    } catch (_) {
      return json({ success: false, code: 'BAD_JSON' }, origin, 400);
    }

    const action = String(body.action || '');
    if (!action) return json({ success: false, code: 'NO_ACTION' }, origin, 400);
    //   ★大きい枠を他の窓口へ流用させない／k_aiDraft は専用のパスだけ（設計39 改訂1 高8）
    if (aiPath !== (action === 'k_aiDraft')) return json({ success: false, code: 'BAD_PATH' }, origin, 400);

    //   ★会員のカルテの停止スイッチ（wrangler.toml の MEMBER_KARTE）。**'on' でなければ必ず 503**（設計35 改訂1-4）
    //     古い画面が直接呼んでも止まる。認可や D1 より前に止める（窓口の中でも同じ判定をもう一度する）
    if (action === 'c_myKarte' && !memberKarteOn(env)) {
      return json({ success: false, code: 'MEMBER_KARTE_OFF' }, origin, 503);
    }

    //   ★カルテの停止スイッチ（wrangler.toml の KARTE = "off"）。認可や D1 より前に止める
    const isKarte = /^k_/.test(action);
    if (isKarte && String((env && env.KARTE) || '') === 'off') {
      return json({ success: false, code: 'KARTE_OFF' }, origin, 503);
    }
    //   ★カルテの書き込みは Origin が許可の1つと完全一致のときだけ（欠けていても403）
    if (isKarte && isKarteWrite(action) && !ALLOWED_ORIGINS.includes(origin)) {
      return json({ success: false, code: 'FORBIDDEN', detail: 'ORIGIN' }, origin, 403);
    }

    // ① 署名検証
    const auth = await verifyIdToken(body.idToken, env);
    if (!auth.ok) {
      // 期限切れはフロントが取り直せるよう、他の失敗と区別して返す
      const status = auth.code === 'EXPIRED' ? 401 : 401;
      return json({ success: false, code: auth.code === 'EXPIRED' ? 'UNAUTHORIZED' : 'FORBIDDEN', detail: auth.code }, origin, status);
    }
    //   ★カルテの書き込みは ID トークンの発行時刻が新しいものだけ（盗まれたトークンの使い回しを狭める・設計28 4-5）
    //     iat がある・未来60秒以内・発行から10分以内。画面は保存の直前に取り直す
    if (isKarte && isKarteWrite(action)) {
      const iat = auth.claims && auth.claims.iat;
      const nowS = Math.floor(Date.now() / 1000);
      if (typeof iat !== 'number' || iat > nowS + 60 || nowS - iat > KARTE_LIMITS.TOKEN_MAX_AGE_S) {
        return json({ success: false, code: 'UNAUTHORIZED', detail: 'STALE_TOKEN' }, origin, 401);
      }
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
    //   ★カルテ（k_）にも掛ける（設計28 4-1）。k_ には GAS へ落とす道が無いので、古ければ何も返さず403
    if (/^(c_|k_)/.test(action) && await rolesTooOld(env)) {
      if (isKarte) return json({ success: false, code: 'FORBIDDEN', detail: 'ROLES_STALE' }, origin, 403);
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
      //   ★k_aiDraft は message を出さない（文字起こし・AI の文が乗り得る・設計39 改訂1 重大3）
      if (action === 'k_aiDraft') console.error('k_aiDraft', 'INTERNAL');
      else console.error(action, e && e.message);
      return json({ success: false, code: 'INTERNAL' }, origin, 500);
    }

    // 写しを持っていない／古すぎる場合は「答えない」。画面はGASに聞き直す。
    //   間違った残数や古い枠を返すより、遅いほうがよい。
    if (result && result._forbidden) {
      return json({ success: false, code: 'FORBIDDEN' }, origin, 403);
    }
    //   カルテの失敗は code と HTTP の状態をそのまま返す（429・409・404 等）
    if (result && result._error) {
      return json({ success: false, code: result._error, detail: result.detail || undefined }, origin,
                  result._status || 400);
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
