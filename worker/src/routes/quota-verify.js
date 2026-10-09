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
import { readSyncVersion, isFresh } from '../lib/sync-version.js';
import { buildQuotaForCustomer } from '../lib/quota-build.js';
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
  //   ★主キーの集合の照合は、**作り直しが実際に使った範囲**で行う（2026-10-09・関門②）。
  //     範囲はURLで渡さない。会員ごと・実行ごとに違うので、渡すと推測になり、
  //     正しいD1の行を「欠けている／余っている」と誤って判定する。
  //     作り直しが customer_sync_version に保存した範囲を使う。

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
    overUsedMonths: 0,  // 枠を超えて使っている月（表示では消えるので行そのものを見る）
    coverageMissing: 0, // coverage がまだ入っていない行（作り直していない＝比べられない）
    keyMismatch: 0,      // ★主キーの集合が計算と合わない会員（切り替えの合格条件）
    keyMismatchDetail: [],
    keyChecked: 0,       // ★集合の照合が走った会員の数（一致・不一致にかかわらず数える。
                         //   0なら「検査が走っていない」＝合格にしてはいけない）
    keyRangeMissing: 0,  // 作り直しの範囲が保存されていない会員（＝照合できない）
    staleCoverage: null,        // 表全体で coverage が NULL の行（最後のページで数える）
    quotaInvariantBroken: null, // 表全体で used > quota の行（最後のページで数える）
    next: null, done: false, pageVerdict: '',
  };

  for (const cid of ids) {
    //   ★世代を先に読む（2026-10-09・設計13）。
    //     読み取りをD1へ向けたあとは「いまの世代の行」だけが顧客に出る。
    //     照合も同じ条件で見なければ、消えた契約の古い行で食い違いが出続ける。
    //   ★追いついていない会員は「不一致」ではなく「飛ばした」。
    //     作り直しの途中の状態を不一致として数えると、本物の食い違いが埋もれる。
    const ver0 = await readSyncVersion(env, cid);
    if (!isFresh(ver0)) {
      out.skipped++;
      out.skippedWhy['VERSION_' + (ver0.exists ? (ver0.builtVersion > 0 ? 'BEHIND' : 'NOT_BUILT') : 'NO_ROW')]
        = (out.skippedWhy['VERSION_' + (ver0.exists ? (ver0.builtVersion > 0 ? 'BEHIND' : 'NOT_BUILT') : 'NO_ROW')] || 0) + 1;
      continue;
    }

    const input = await loadCalcInput(env, cid);
    if (!input.ok) { out.skipped++; out.skippedWhy[input.reason] = (out.skippedWhy[input.reason] || 0) + 1; continue; }

    // ---- ① 計算の答え ----
    const a = _lbComputeRemaining(cid, input.rows, input.sessions, nowMonthKeyJst(now), now,
                                  carryRate, input.opening, false, true);
    if (!a || a.ok === false) { out.skipped++; out.skippedWhy.REMAINING_NOT_OK = (out.skippedWhy.REMAINING_NOT_OK || 0) + 1; continue; }

    // ---- ② D1の行から読んだ答え ----
    const [mq, tp] = await Promise.all([
      //   ★いまの世代の行だけを見る（顧客に出るのと同じ条件）
      env.DB.prepare(
        `SELECT quota, coverage, used FROM monthly_quota
          WHERE customer_id = ? AND month_key = ? AND built_version = ?`
      ).bind(cid, month, ver0.builtVersion).first(),
      env.DB.prepare(
        `SELECT total, used, opening_used FROM ticket_packs
          WHERE customer_id = ? AND valid_from <= ? AND valid_to >= ? AND built_version = ?`
      ).bind(cid, now, now, ver0.builtVersion).all(),
    ]);

    //   月額：枠が無い月は「月額の契約が無い」とみなす（計算側の null に合わせる）
    //
    //   ★見せる残数は coverage で3つに分かれる（計算側 Allocate.js の monthlyRem と同じ規則）。
    //       uncovered  契約が覆っていない      → 0（繰越が残っていても使えない）
    //       limited    覆って頻度がある        → quota − used
    //       unlimited  覆っているが頻度未設定  → null（上限なし）
    //     quota はそのまま「割当器が引ける回数」として残す（消化の記録用）。
    //
    //   ★coverage が NULL の行は「まだ作り直していない」。一致とは数えない（0012 に詳述）。
    //     この列を足す前のコードは avail で行を作っていたので、既にある行には
    //     uncovered も unlimited も混ざっている可能性がある。既定値で埋めると、
    //     本当は0やnullを見せるべき行が数値を見せ、それが「一致」として通ってしまう。
    let d1Monthly = null, coverageMissing = false;
    if (mq) {
      const cov = mq.coverage;
      if (cov === 'limited') d1Monthly = Number(mq.quota) - Number(mq.used);
      else if (cov === 'uncovered') d1Monthly = 0;
      else if (cov === 'unlimited') d1Monthly = null;
      else coverageMissing = true;   // NULL や想定外の値
    }
    if (coverageMissing) {
      out.coverageMissing = (out.coverageMissing || 0) + 1;
      out.pageOk = false;
      out.skipped++;
      out.skippedWhy.COVERAGE_NOT_SET = (out.skippedWhy.COVERAGE_NOT_SET || 0) + 1;
      continue;   // 比べられない。作り直してから出直す
    }

    //   ★主キーの集合を照合する（2026-10-09・設計13・関門②の指摘）。
    //
    //     顧客の読み取り経路で見るのは**件数**だけ。それでは
    //       ・当月以外の月額行が欠けている／余っている
    //       ・期限切れ・開始前のパックの主キーが違う
    //       ・同じ枚数の別パックに入れ替わっている
    //     が通ってしまう（当月の残数はたまたま一致する）。
    //     **切り替えの合格条件はこちら。** 作り直しと同じ範囲で集合を突き合わせる。
    //
    //   ★範囲（from/to）を渡されたときだけ見る。渡されなければ飛ばす
    //     （違う範囲で比べると、作られていない月を「欠けている」と誤って出す）。
    //   ★範囲が保存されていなければ、**合格にしない**（飛ばして数える）。
    //     「検査が走らなかった」を「一致した」と読ませてはいけない。
    if (!/^\d{4}-\d{2}$/.test(String(ver0.fromMonth || '')) || !/^\d{4}-\d{2}$/.test(String(ver0.toMonth || ''))) {
      out.keyRangeMissing = (out.keyRangeMissing || 0) + 1;
      out.pageOk = false;
    } else {
      const b2 = buildQuotaForCustomer(cid, input.rows, input.sessions, input.opening, {
        fromMonth: ver0.fromMonth, toMonth: ver0.toMonth, nowKey: nowMonthKeyJst(now), carryRate,
      });
      //   ★計算に問題があるときは比べない（2026-10-09・関門②の2周目）。
      //     buildQuotaForCustomer は問題のある月・パックを**除いた途中までの集合**を返す。
      //     それを「作るべき集合」として比べると、意味の違うものを突き合わせることになる。
      //     作り直し側は問題が1件でもあれば何も書かないので、D1は空＝全部 missing に見える。
      if (b2.issues.length) {
        out.skipped++;
        out.skippedWhy.KEY_EXPECTATION_NOT_OK = (out.skippedWhy.KEY_EXPECTATION_NOT_OK || 0) + 1;
        out.pageOk = false;   // ★合格にはしない
        continue;
      }
      const [dq, dp] = await Promise.all([
        env.DB.prepare(
          `SELECT month_key FROM monthly_quota WHERE customer_id = ? AND built_version = ?`
        ).bind(cid, ver0.builtVersion).all(),
        env.DB.prepare(
          `SELECT pack_id FROM ticket_packs WHERE customer_id = ? AND built_version = ?`
        ).bind(cid, ver0.builtVersion).all(),
      ]);
      const diffKeys = (want, got) => {
        const W = new Set(want), G = new Set(got);
        return { missing: want.filter((x) => !G.has(x)), extra: got.filter((x) => !W.has(x)) };
      };
      //   ★D1の主キーを読み終えた時点で「走った」と数える（2026-10-09・関門②の3周目）。
      //     一致したときだけ数えていたので、**全員が不一致なら keyChecked が0**になり、
      //     「合わない」と「1人も走っていない」が同時に出て読めなかった。
      out.keyChecked = (out.keyChecked || 0) + 1;

      const mk = diffKeys(b2.monthly.map((m) => String(m.monthKey)),
                          (dq.results || []).map((x) => String(x.month_key)));
      const pk = diffKeys(b2.packs.map((p) => String(p.packId)),
                          (dp.results || []).map((x) => String(x.pack_id)));
      if (mk.missing.length || mk.extra.length || pk.missing.length || pk.extra.length) {
        //   ★「飛ばした」ではなく**不一致**にする。合わないまま切り替えてはいけない。
        out.keyMismatch = (out.keyMismatch || 0) + 1;
        out.pageOk = false;
        (out.keyMismatchDetail = out.keyMismatchDetail || []).push({
          customerId: mask(cid),
          range: `${ver0.fromMonth}..${ver0.toMonth}`,
          monthsMissing: mk.missing.slice(0, 5), monthsExtra: mk.extra.slice(0, 5),
          packsMissing: pk.missing.length, packsExtra: pk.extra.length,
        });
      }
    }

    //   ★月額の使いすぎ（used > quota）も数える（2026-10-07・Codex関門②の4回目）。
    //     見せる残数は uncovered なら0・unlimited なら null になるので、
    //     「枠1に対して2回使っている」状態が表示の上では消える。
    //     スキーマは支払い前の仮押さえのために used > quota を許している（決定0068）ので、
    //     表示に頼らず行そのものを見る必要がある。
    //     ★unlimited を除くのは「契約の上限を超えた」という意味に限るため。
    //       行そのものの異常（引当やトリガーの壊れ）は、下の全表検査で別に数える。
    if (mq && mq.coverage !== 'unlimited' && Number(mq.used) > Number(mq.quota)) {
      out.overUsedMonths = (out.overUsedMonths || 0) + 1;
      out.pageOk = false;
    }
    //   チケット：いま有効なパックの残りを足す（計算側 ticketRem と同じ数え方）
    let d1Ticket = 0;
    //   残り ＝ 買った枚数 − 移行前に使った枚数 − 引当で使った枚数
    //   opening_used を引かないと、3〜8月の消化が反映されず残りが多く見える。
    //
    //   ★既にD1に入っている壊れた値も見つける（2026-10-07・Codex関門②の3回目）。
    //     書き込みは「問題があれば止める」ようにしたが、**それより前に入ったものは残る**。
    //     読み取りをD1へ向ける前に、ここで必ず見つけて直す。
    //     判定は計算側と比べるだけで足りる（壊れていれば数が合わない）。
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

    // ★表全体を2つの目で見る（2026-10-07・Codex関門②の5回目）。
    //   上の孤児検査は「契約が消えた会員」しか見ていない。次の2つは漏れる：
    //
    //   ① coverage が入っていない行
    //      枠を作り直す処理は UPSERT だけで、**生成対象から外れた古い行を消さない**。
    //      範囲外の月や、条件が変わって作られなくなった月の行は NULL のまま残る。
    //      上の照合は「照合した月」しか見ないので、別の月に残った行は見つからない。
    //      その行をD1から読めば、誰かの残数として現れうる。
    //
    //   ② used > quota の行（coverage を問わず全部）
    //      quota は「割当器が引ける回数」。割当器とトリガーが正常なら、
    //      unlimited であっても used が quota を超えることはない。
    //      超えていたら利用の超過ではなく、**引当・トリガー・手作業の異常**。
    //      上の overUsedMonths は「契約の上限超え」に意味を絞っているので、
    //      ここで別に数えないと unlimited の異常に気づけない。
    const [noCov, broken] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) AS n FROM monthly_quota WHERE coverage IS NULL').first(),
      env.DB.prepare('SELECT COUNT(*) AS n FROM monthly_quota WHERE used > quota').first(),
    ]);
    out.staleCoverage = Number(noCov?.n || 0);          // 作り直していない／取り残された行
    out.quotaInvariantBroken = Number(broken?.n || 0);  // used が quota を超えている行
    if (out.staleCoverage || out.quotaInvariantBroken) out.pageOk = false;
  }

  //   ★「全員一致」とは言わない。「このページでは食い違いが無かった」までしか言えない。
  out.pageVerdict = out.pageOk ? 'PAGE_AGREE'
    : (out.differ ? 'DIFFER'
    : (out.skipped ? 'HAS_SKIPPED'
    : ((out.orphans && (out.orphans.quotaRows || out.orphans.packRows || out.orphans.allocRows)) ? 'HAS_ORPHANS'
    : (out.staleCoverage ? 'HAS_STALE_COVERAGE'
    : (out.quotaInvariantBroken ? 'QUOTA_INVARIANT_BROKEN' : 'INCOMPLETE')))));
  return json(out);
}
