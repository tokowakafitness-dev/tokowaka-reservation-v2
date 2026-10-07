// 契約から「枠」を作り、D1へ書く（段階3-a の土台）
//
//   設計：ops/design/04-booking-to-d1.md 第3版 第3節
//
//   ★何をするところか
//     monthly_quota（会員×月）と ticket_packs（買った単位）の**行を用意する**。
//     引当のINSERTはこの行を親として見るので、行が無い月は予約が作れない（fail-closed）。
//
//   ★何をしないところか
//     `used`（使った数）には触れない。動かすのはトリガーだけ、が設計の不変条件。
//     残数の計算もしない。既存の allocate.js の結果を読み替えるだけ。
//
//   ★まだ誰も使わない
//     この段階では、作った枠を読む処理は無い。GASが正本のまま動いている。
//     ここで作るのは「本番の実データで、枠が正しく作れるか」を確かめるための土台。

import { loadCalcInput } from '../calc.js';
import { buildQuotaForCustomer, quotaUpsertStatements } from '../lib/quota-build.js';
import { buildAllocationsForCustomer, allocationInsertStatements } from '../lib/alloc-build.js';

/** 'YYYY-MM' を1つ進める */
function nextMonthKey(monthKey) {
  const [y, m] = String(monthKey).split('-').map(Number);
  return m >= 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** いまの月（JST） */
function nowMonthKeyJst(ms) {
  const d = new Date(ms + 9 * 3600000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * 枠を作る（または作れるかを試す）。
 *
 *   GET/POST /quota/build?dry=1&from=2026-10&to=2026-11&customer=C123
 *
 *   dry=1（既定）… **書かない。** 何件作られるか、どこで止まるかだけを返す
 *   dry=0        … 実際に D1 へ書く
 *
 *   customer を指定しなければ、計算入力に載っている全員を対象にする。
 */
export async function buildQuota(request, env) {
  const deny = requireSecret(request, env);
  if (deny) return deny;
  const url = new URL(request.url);
  const dry = url.searchParams.get('dry') !== '0';          // ★既定は書かない
  const only = (url.searchParams.get('customer') || '').trim();
  const now = Date.now();
  const from = (url.searchParams.get('from') || nowMonthKeyJst(now)).trim();
  const to = (url.searchParams.get('to') || nextMonthKey(from)).trim();
  const carryRate = Number(url.searchParams.get('rate') || '') || 1 / 3;
  // ★一度に処理する人数を区切る（2026-10-07・Codex関門②の指摘）。
  //   会員1人につき loadCalcInput が5本のクエリを投げる。全員を一気に回すと
  //   Workerのサブリクエスト上限（50）に当たる。
  //
  //   数え方：選択1 ＋ 会員数×5（読み取り）＋ 会員数（書き込み）
  //     5名 → 1 + 25 + 5 = 31   ← 既定。余裕がある
  //     8名 → 1 + 40 + 8 = 49   ← 上限。ここを超えさせない
  //   最初は既定10・上限25にしていたが、10名で61回になり超過する。数え間違いだった。
  //
  //   ★途中で止まったら、同じ after からもう一度呼ぶ。
  //     枠の書き込みは UPSERT なので、同じ会員を二度処理しても結果は変わらない
  //     （used には触れないので、使った数も壊れない）。
  //     失敗したページは next を返さないので、呼ぶ側は**直前に渡した after** を覚えておく。
  const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 5) || 5, 8));
  const after = (url.searchParams.get('after') || '').trim();
  // 引当も作るか。枠だけ作っても used は0のままなので、移行では両方要る。
  //   ただし「枠だけ作り直したい」場面もあるので、別の指定にしておく。
  const withAlloc = url.searchParams.get('alloc') === '1';

  if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to) || from > to) {
    return json({ ok: false, reason: 'BAD_RANGE', from, to }, 400);
  }

  // 対象の会員を決める。計算入力（契約）に載っている人だけ。
  //   customer_id の順に並べ、limit 件ずつ。after より後ろから続ける。
  let ids;
  if (only) {
    ids = [only];
  } else {
    const r = await env.DB.prepare(
      `SELECT DISTINCT customer_id FROM calc_contract_rows
        WHERE customer_id > ? ORDER BY customer_id LIMIT ?`
    ).bind(after, limit).all();
    ids = (r.results || []).map((x) => String(x.customer_id)).filter(Boolean);
  }

  const summary = {
    ok: true, dry, from, to, customers: ids.length,
    // 続きがあるときだけ次の印を返す。呼ぶ側はこれが無くなるまで繰り返す。
    //   ★done になったあと、もう一周する。
    //     処理している間に customer_id が after より小さい会員が増えると取りこぼす
    //     （契約が新しく入るのは通常めったに無いが、取りこぼすと枠が無い＝予約できない）。
    //     after を空にしてもう一度流せば、UPSERT なので重複の害は無い。
    next: null, done: false,
    retryFrom: after,   // このページが失敗したら、ここからやり直す
    monthlyRows: 0, packRows: 0, allocRows: 0, overflow: 0, wrote: 0, withAlloc,
    skipped: [],       // 計算入力が揃っていない会員（理由つき）
    issues: [],        // 枠を作れなかった月・パック（理由つき）
  };

  for (const cid of ids) {
    const input = await loadCalcInput(env, cid);
    if (!input.ok) {
      // ★計算入力が揃っていなければ枠を作らない。
      //   古い契約で枠を作ると、そこから作られる引当も残数もずれる。
      summary.skipped.push({ customerId: mask(cid), reason: input.reason });
      continue;
    }

    const built = buildQuotaForCustomer(cid, input.rows, input.sessions, input.opening, {
      fromMonth: from, toMonth: to, nowKey: nowMonthKeyJst(now), carryRate,
    });

    summary.monthlyRows += built.monthly.length;
    summary.packRows += built.packs.length;
    for (const is of built.issues) summary.issues.push({ ...is, customerId: mask(is.customerId) });

    // ★引当も同じ呼び出しで作る（withAlloc=1 のときだけ）。
    //   枠だけ作って引当を作らないと、used が0のまま＝「誰も使っていない」ことになる。
    //   枠と引当は対で意味を持つので、作る順序を間違えないよう同じ場所で扱う。
    //   （枠が先・引当が後。引当のINSERTは枠の行を親として見る）
    let allocStmts = [];
    if (withAlloc) {
      const al = buildAllocationsForCustomer(cid, input.rows, input.sessions, input.opening, {
        fromMonth: from, toMonth: to, nowKey: nowMonthKeyJst(now),
        targetDateMs: now, carryRate,
      });
      summary.allocRows += al.rows.length;
      summary.overflow += al.skippedUnallocated;
      for (const is of al.issues) summary.issues.push({ ...is, customerId: mask(is.customerId), at: 'alloc' });
      // ★「消してから入れる」。流し直したとき、消化先が変わっていれば古い引当を落とす。
      //   INSERT OR IGNORE だけだと壊れはしないが正しくもならない（枠は新しく used は古い）。
      allocStmts = allocationInsertStatements(al, now, { customerId: cid, fromMonth: from, toMonth: to });
    }

    if (!dry) {
      const stmts = quotaUpsertStatements(built, now).concat(allocStmts);
      if (stmts.length) {
        try {
          await env.DB.batch(stmts.map((s) => env.DB.prepare(s.sql).bind(...s.args)));
          summary.wrote += stmts.length;
        } catch (e) {
          // ★どの会員で、何が起きたかを返す（2026-10-07）。
          //   ここで黙って500を返すと、呼ぶ側には「error code 1101」しか届かず、
          //   原因に辿り着けない。会員と理由を持って帰る。
          //   バッチは原子的なので、この会員ぶんは何も書かれていない。
          summary.ok = false;
          summary.failedAt = { customerId: mask(cid), after,
                               detail: String((e && e.message) || e).slice(0, 300) };
          summary.done = false;
          summary.next = null;
          return json(summary, 200);   // 200で返す。中身を読んでもらうため
        }
      }
    }
  }

  // 続きの印。1人指定のときは区切らない。
  if (!only) {
    summary.next = (ids.length === limit) ? ids[ids.length - 1] : null;
    summary.done = (summary.next === null);
  } else {
    summary.done = true;
  }

  // ★氏名は出さない。顧客IDも下4桁だけ。
  //   この窓口は合言葉で守るが、結果が記録に残る経路もあるため、出す側で絞る。
  return json(summary);
}

/** いま入っている枠を数えるだけ（確かめ用） */
export async function quotaStatus(request, env) {
  const deny = requireSecret(request, env);
  if (deny) return deny;
  const [m, p] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS n, SUM(used) AS used FROM monthly_quota').first(),
    env.DB.prepare('SELECT COUNT(*) AS n, SUM(used) AS used FROM ticket_packs').first(),
  ]);
  return json({
    ok: true,
    monthly: { rows: Number(m?.n || 0), used: Number(m?.used || 0) },
    packs: { rows: Number(p?.n || 0), used: Number(p?.used || 0) },
  });
}

// ★合言葉で守る（ingest と同じ鍵・同じヘッダ）。
//   お客様のブラウザからは呼ばせない。枠はすべての残数の土台なので、
//   作り直しが外から叩けると、残数そのものを壊せてしまう。
function requireSecret(request, env) {
  const secret = env.SHARED_SECRET || '';
  if (!secret) return json({ ok: false, reason: 'SECRET_NOT_SET' }, 503);
  const given = request.headers.get('X-Ingest-Secret') || '';
  // 長さと中身の両方で時間差が出ない比較（合言葉の推測を助けない）
  const x = new TextEncoder().encode(given);
  const y = new TextEncoder().encode(secret);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  if (diff !== 0) return json({ ok: false, reason: 'FORBIDDEN' }, 403);
  return null;
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
