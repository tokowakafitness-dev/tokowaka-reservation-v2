// D1の枠と引当から出した残数が、計算と一致するかを突き合わせる
//
//   ★既存の照合（routes/verify.js）とは別のことを見る
//     既存    GASの計算 vs Workerの計算   … 同じコードを回すので、合って当然
//     ここ    計算の答え vs D1の行         … **別々の仕組みが同じ答えに至るか**
//
//   ★なぜこれが要るのか
//     D1を正本にするとは「残数を計算で出す」のをやめて「行から読む」ことである。
//     行から読んだ値が計算と違えば、顧客の残数が変わる。
//     段階3-b（読み取りをD1へ向ける）に進んでよいかは、ここが一致するかで決まる。
//
//   読み取りだけ。何も書き換えない。

import { loadCalcInput } from '../calc.js';
import { _lbComputeRemaining } from '../allocate.js';

function nowMonthKeyJst(ms) {
  const d = new Date(ms + 9 * 3600000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function mask(id) {
  const s = String(id || '');
  return s ? '*' + s.slice(-4) : '';
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status, headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function requireSecret(request, env) {
  const secret = env.SHARED_SECRET || '';
  if (!secret) return json({ ok: false, reason: 'SECRET_NOT_SET' }, 503);
  const given = request.headers.get('X-Ingest-Secret') || '';
  const x = new TextEncoder().encode(given);
  const y = new TextEncoder().encode(secret);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  if (diff !== 0) return json({ ok: false, reason: 'FORBIDDEN' }, 403);
  return null;
}

/**
 * GET /quota/verify?month=2026-10&limit=5&after=...
 *
 *   会員ごとに
 *     計算の答え … _lbComputeRemaining（GASと1行ずつ揃えてある）
 *     D1の行     … monthly_quota.quota - used ／ ticket_packs の有効なぶんの残り
 *   を比べる。
 */
export async function verifyQuota(request, env) {
  const deny = requireSecret(request, env);
  if (deny) return deny;

  const url = new URL(request.url);
  const now = Date.now();
  const month = (url.searchParams.get('month') || nowMonthKeyJst(now)).trim();
  const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 5) || 5, 8));
  const after = (url.searchParams.get('after') || '').trim();
  const carryRate = Number(url.searchParams.get('rate') || '') || 1 / 3;

  if (!/^\d{4}-\d{2}$/.test(month)) return json({ ok: false, reason: 'BAD_MONTH', month }, 400);
  // ★今月しか比べられない（2026-10-07・Codex関門②）。
  //   D1側は指定された月の行を読むが、計算側は「いまの残数」を返す。
  //   別の月を指定すると、**違う月どうしを比べて、たまたま同じ値なら「一致」と出る**。
  //   過去や未来の月を比べたいなら、計算側もその時点で呼び直す作りが要る。それは別の工程。
  if (month !== nowMonthKeyJst(now)) {
    return json({ ok: false, reason: 'ONLY_CURRENT_MONTH', month, current: nowMonthKeyJst(now),
                  detail: 'D1は指定月を読み、計算はいまの残数を返すため、別の月は比べられません' }, 400);
  }

  const r = await env.DB.prepare(
    `SELECT DISTINCT customer_id FROM calc_contract_rows
      WHERE customer_id > ? ORDER BY customer_id LIMIT ?`
  ).bind(after, limit).all();
  const ids = (r.results || []).map((x) => String(x.customer_id)).filter(Boolean);

  const out = {
    // ★名前を pageOk / pageVerdict にする（2026-10-07・Codex関門②の3回目）。
    //   ok という名前にすると、**このページだけの結果を全体の合否と読んでしまう。**
    //   全体の判定は、呼ぶ側が全ページを集計して出す（gas/PushToEdge.js の allGood）。
    pageOk: true, month, customers: ids.length, checked: 0,
    agree: 0, differ: 0, skipped: 0,
    diffs: [],          // 食い違った会員（氏名は出さない）
    skippedWhy: {},     // 比べられなかった理由の内訳（黙って落とさない）
    overUsedPacks: 0,   // 買った枚数を超えて使っているチケット（0に丸めず数える）
    next: null, done: false, pageVerdict: '',
  };

  for (const cid of ids) {
    const input = await loadCalcInput(env, cid);
    if (!input.ok) { out.skipped++; out.skippedWhy[input.reason] = (out.skippedWhy[input.reason] || 0) + 1; continue; }

    // ---- ① 計算の答え ----
    const a = _lbComputeRemaining(cid, input.rows, input.sessions, nowMonthKeyJst(now), now,
                                  carryRate, input.opening, false, true);
    if (!a || a.ok === false) { out.skipped++; out.skippedWhy.REMAINING_NOT_OK = (out.skippedWhy.REMAINING_NOT_OK || 0) + 1; continue; }

    // ---- ② D1の行から読んだ答え ----
    const [mq, tp] = await Promise.all([
      env.DB.prepare('SELECT quota, used FROM monthly_quota WHERE customer_id = ? AND month_key = ?')
        .bind(cid, month).first(),
      env.DB.prepare(
        `SELECT total, used, opening_used FROM ticket_packs
          WHERE customer_id = ? AND valid_from <= ? AND valid_to >= ?`
      ).bind(cid, now, now).all(),
    ]);

    //   月額：枠が無い月は「月額の契約が無い」とみなす（計算側の null に合わせる）
    const d1Monthly = mq ? (Number(mq.quota) - Number(mq.used)) : null;
    //   チケット：いま有効なパックの残りを足す（計算側 ticketRem と同じ数え方）
    let d1Ticket = 0;
    //   残り ＝ 買った枚数 − 移行前に使った枚数 − 引当で使った枚数
    //   opening_used を引かないと、3〜8月の消化が反映されず残りが多く見える。
    //
    //   ★使いすぎ（opening_used + used > total）を 0 に丸めて隠さない（Codex関門②）。
    //     丸めると、計算側も0なので「一致」と出てしまい、異常が見えなくなる。
    //     買った枚数を超えて使っている状態は、それ自体が直すべきこと。
    let overUse = 0;
    for (const p of (tp.results || [])) {
      const rest = Number(p.total) - Number(p.opening_used || 0) - Number(p.used);
      if (rest < 0) overUse += -rest;
      d1Ticket += Math.max(0, rest);
    }
    if (overUse) {
      out.overUsedPacks = (out.overUsedPacks || 0) + 1;
      out.pageOk = false;
    }

    const calcMonthly = (a.monthlyRem == null) ? null : Number(a.monthlyRem);
    const calcTicket = Number(a.ticketRem || 0);

    out.checked++;
    const sameMonthly = (d1Monthly === null && calcMonthly === null) || (Number(d1Monthly) === Number(calcMonthly));
    const sameTicket = (d1Ticket === calcTicket);

    if (sameMonthly && sameTicket) { out.agree++; continue; }

    out.differ++;
    out.diffs.push({
      customerId: mask(cid),
      monthly: { calc: calcMonthly, d1: d1Monthly },
      ticket: { calc: calcTicket, d1: d1Ticket },
      //   ★食い違いの手がかり。枠がそもそも無いのか、使った数がずれているのか
      quotaRow: mq ? { quota: Number(mq.quota), used: Number(mq.used) } : null,
      packRows: (tp.results || []).length,
    });
  }

  out.next = (ids.length === limit) ? ids[ids.length - 1] : null;
  out.done = (out.next === null);

  // ★ここで出すのは**このページだけ**の判定（2026-10-07・Codex関門②の2回目）。
  //   呼ぶ側は全ページを集計して判断すること。最後のページだけを見て
  //   このページが「一致」でも全員一致とは限らない。前のページの食い違いを見落とす。
  //   その取り違えを防ぐため、名前を pageOk / pageVerdict にしてある。
  //
  //   ★「合格」と言えるのは、**全員を比べて全員が一致したとき**だけ（Codex関門②）。
  //   食い違い0でも、比べられていない人がいれば合格ではない。
  //   ここを緩めると「一致した」と誤認したまま段階3-bへ進み、顧客の残数が変わる。
  if (out.differ) out.pageOk = false;             // 1人でも食い違えば駄目
  if (out.skipped) out.pageOk = false;            // 比べられない人がいても駄目
  if (!out.checked) out.pageOk = false;           // 1人も比べていないのに合格にしない
  if (!out.done) out.pageOk = false;              // 途中までなら合格にしない（続きがある）
  // ★D1にだけ残っている行（孤児）を数える（最後のページでだけ・Codex関門②）。
  //   比べているのは「計算側に居る会員」だけ。契約が消えた会員の枠や引当が
  //   D1に残っていても、ここまでの検査には現れない。
  //   段階3-bでD1を直接読むなら、その行も読まれる＝誰かの残数として現れうる。
  if (out.done) {
    const [orphanQ, orphanP, orphanA] = await Promise.all([
      env.DB.prepare(
        `SELECT COUNT(*) AS n FROM monthly_quota
          WHERE customer_id NOT IN (SELECT DISTINCT customer_id FROM calc_contract_rows)`
      ).first(),
      env.DB.prepare(
        `SELECT COUNT(*) AS n FROM ticket_packs
          WHERE customer_id NOT IN (SELECT DISTINCT customer_id FROM calc_contract_rows)`
      ).first(),
      env.DB.prepare(
        `SELECT COUNT(*) AS n FROM reservation_allocations
          WHERE customer_id NOT IN (SELECT DISTINCT customer_id FROM calc_contract_rows)`
      ).first(),
    ]);
    out.orphans = { quotaRows: Number(orphanQ?.n || 0), packRows: Number(orphanP?.n || 0),
                    allocRows: Number(orphanA?.n || 0) };
    if (out.orphans.quotaRows || out.orphans.packRows || out.orphans.allocRows) out.pageOk = false;
  }

  //   ★「全員一致」とは言わない。「このページでは食い違いが無かった」までしか言えない。
  out.pageVerdict = out.pageOk ? 'PAGE_AGREE'
    : (out.differ ? 'DIFFER'
    : (out.skipped ? 'HAS_SKIPPED'
    : ((out.orphans && (out.orphans.quotaRows || out.orphans.packRows || out.orphans.allocRows)) ? 'HAS_ORPHANS' : 'INCOMPLETE')));
  return json(out);
}
