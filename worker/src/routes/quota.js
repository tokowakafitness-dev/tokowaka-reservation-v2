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
import { readSyncVersion, markBuiltStatement } from '../lib/sync-version.js';

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
  // ★範囲の決め方（2026-10-07・実測で分かったこと）
  //
  //   from は「予約台帳が記録を持ち始めた月」より前に広げてはいけない。
  //   計算側はその下限より前を数えない（棚卸しで引き継いでいる）ので**枠を作らない**。
  //   一方で割当器の perSession には、その月の予約が現れることがある。
  //   広げると「枠0行なのに引当1件」になり、親の無い引当として弾かれる。
  //     実測：2026-01〜08 を指定 → 枠0行・引当1件・超過4件
  //           2026-09〜12 を指定 → 枠74行・引当275件・超過2件（こちらが正しい）
  //
  //   to は「予約が入りうる先」まで。25日以降は翌月が開き、固定枠の自動予約も
  //   翌月ぶんを作るので、当月＋2か月ほど見ておく。
  //
  //   広すぎる範囲を指定しても、親の無い引当は NO_QUOTA_ROW で捕まり、
  //   その会員は書かずに報告される（黙って壊れることはない）。
  //   ただし**毎回その報告が出る**ので、範囲は根拠を持って指定すること。

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
    monthlyRows: 0, packRows: 0, allocRows: 0, overflow: 0, wrote: 0, blocked: 0, withAlloc,
    marked: 0,         // 世代を書こうとした会員の数（実際に印が残ったかは syncVersion で見る）
    skipped: [],       // 計算入力が揃っていない会員（理由つき）
    issues: [],        // 枠を作れなかった月・パック（理由つき）
  };

  for (const cid of ids) {
    // ★世代は**入力を読む前**に取る（2026-10-09・段階3-b 手順1）。
    //   読んだあと・書くまでの間に押し出しが来たら、source_version が進んで
    //   built_version が追いつかない＝「作り直しが古い」と正しく判定される。
    //   逆に読んだあとに取ると、途中で来た変更を取り込んだことにしてしまう。
    const ver0 = await readSyncVersion(env, cid);
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
    let allocIssues = [];
    if (withAlloc) {
      const al = buildAllocationsForCustomer(cid, input.rows, input.sessions, input.opening, {
        fromMonth: from, toMonth: to, nowKey: nowMonthKeyJst(now),
        targetDateMs: now, carryRate,
      });
      // ★引当の親（枠）が揃っているかを、書く前に確かめる（2026-10-07）。
      //   枠を作る条件と引当を作る条件がずれていると、親の無い引当ができて
      //   外部キー違反でバッチごと落ちる。本番で実際に起きた。
      //   落ちてから原因を探すより、**ここで名指しで止める**。
      const haveMonths = new Set(built.monthly.map((m) => m.monthKey));
      const havePacks = new Set(built.packs.map((p) => p.packId));
      for (const r of al.rows) {
        if (r.source === 'monthly' && !haveMonths.has(r.monthKey)) {
          al.issues.push({ customerId: cid, code: 'NO_QUOTA_ROW', detail: `${r.monthKey} の枠が無いのに月額の引当` });
        }
        if ((r.source === 'ticket' || r.source === 'pair') && !havePacks.has(r.packId)) {
          al.issues.push({ customerId: cid, code: 'NO_PACK_ROW', detail: `${r.packId} が無いのにチケットの引当` });
        }
      }
      //   1つでも親が無ければ、この会員は書かない（中途半端に入れない）
      if (al.issues.some((x) => x.code === 'NO_QUOTA_ROW' || x.code === 'NO_PACK_ROW')) {
        al.rows = [];
        al.computed = false;   // 消しもしない
      }

      summary.allocRows += al.rows.length;
      summary.overflow += al.skippedUnallocated;
      for (const is of al.issues) summary.issues.push({ ...is, customerId: mask(is.customerId), at: 'alloc' });
      allocIssues = al.issues;
      //   ★引当の結果（月ごとの支払い待ち件数）を枠の行へ移す（2026-10-09・設計10）。
      //     未割当の予約は引当の行が作られないので、D1の3表に現れない。
      //     顧客の画面に出す「支払い待ち」は、枠の行に持たせるしかない。
      //   ★順序が要点：枠の文を組み立てる**前**に入れる。
      //     あとから UPDATE にすると、引当を作らなかった会員（問題があって止めた人）の
      //     枠だけが更新される経路ができる。
      for (const m of built.monthly) {
        m.overage = Number((al.overageByMonth || {})[m.monthKey] || 0);
      }
      // ★「消してから入れる」。流し直したとき、消化先が変わっていれば古い引当を落とす。
      //   INSERT OR IGNORE だけだと壊れはしないが正しくもならない（枠は新しく used は古い）。
      allocStmts = allocationInsertStatements(al, now, { customerId: cid, fromMonth: from, toMonth: to });
    }

    // ★問題が1件でもあれば、この会員は何も書かない（2026-10-07・Codex関門②）。
    //   それまでは「問題として記録しつつ、そのまま書き込む」作りだった。
    //   記録しても書いてしまえば、壊れた値が本番に入る。たとえば：
    //     OPENING_PACK_UNRESOLVED → opening_used が 0 のまま入る
    //       ＝移行前に使ったチケットが復活し、**使えないチケットが使えるようになる**
    //     OPENING_OVER_TOTAL      → 買った枚数で止めた値が入る（実態と違う）
    //   問題を見つけたら止める。報告だけして書くのは、見つけていないのと変わらない。
    //   枠の問題（棚卸しが解決できない等）も、引当の問題（親が無い等）も、どちらも止める。
    if (!dry && (built.issues.length || allocIssues.length)) {
      summary.blocked = (summary.blocked || 0) + 1;
      continue;   // この会員は飛ばす（枠も引当も書かない）
    }

    if (!dry) {
      const stmts = quotaUpsertStatements(built, now).concat(allocStmts);
      // ★作り直したことを世代に書く（2026-10-09・段階3-b 手順1）。
      //   枠と引当を**同じ呼び出しで**作ったときだけ書く。
      //   枠だけ作り直した状態（withAlloc=0）は used が古いので、
      //   これを「新しい」と記録するとD1から誤った残数を答える。
      //   ★行の書き込みと同じ batch に入れる。片方だけ通ることを無くす。
      if (withAlloc) {
        const mk = markBuiltStatement(cid, ver0.sourceVersion, now);
        stmts.push({ sql: mk.sql, args: mk.args });
      }
      if (stmts.length) {
        try {
          await env.DB.batch(stmts.map((s) => env.DB.prepare(s.sql).bind(...s.args)));
          summary.wrote += stmts.length;
          //   ★書けてから数える。失敗したら何も書かれていない（batchは原子的）ので、
          //     先に数えると「作り直した会員の数」が実際より多く見える。
          if (withAlloc) summary.marked = (summary.marked || 0) + 1;

          //   ★「作り直しが取り込んだ世代」が実際に印として残ったかは、ここでは分からない。
          //     markBuiltStatement が batch の中で判定して 0 に落とすこともある
          //     （自分が書いている間に入力が来た／古い方だった場合）。
          //     残った結果は quotaStatus の syncVersion（fresh/stale）で見る。
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

  //   ★shadow の心拍はここに相乗りさせる（新しいルートを足さない）。
  //     GAS側の許可一覧は私が編集できないので、既存の窓口へ寄せる方針に合わせる。
  const u = new URL(request.url);
  const sh = u.searchParams.get('shadow');
  if (sh) {
    const { buildShadowStatus } = await import('../lib/shadow-status.js');
    return json(await buildShadowStatus(env, {
      day: u.searchParams.get('day') || undefined,
      preflightOnly: sh === 'preflight',
    }));
  }
  const [m, p, cov] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS n, SUM(used) AS used FROM monthly_quota').first(),
    env.DB.prepare('SELECT COUNT(*) AS n, SUM(used) AS used FROM ticket_packs').first(),
    // ★契約の覆い方の内訳（2026-10-07）。unlimited が1件でもあれば、
    //   「頻度欄が空の月額契約」が実在するということ。オーナーの判断の材料になる。
    //   NULL（coverage が入っていない行）も数える＝作り直しの取り残しに気づける。
    env.DB.prepare(
      `SELECT COALESCE(coverage, '(未設定)') AS c, COUNT(*) AS n
         FROM monthly_quota GROUP BY COALESCE(coverage, '(未設定)')`
    ).all(),
  ]);
  const coverage = {};
  for (const r of (cov.results || [])) coverage[String(r.c)] = Number(r.n || 0);

  //   ★3-b で足した2列が入っているかを数える（2026-10-09）。
  //     base_freq が NULL の行は「まだ作り直していない」。その行から繰越を作ると
  //     quota 全部を繰越として見せてしまう。読み取りをD1へ向ける前に0件にする。
  //     overage は「支払い待ち」。合計を出して、画面に出す前に実数を確かめられるようにする。
  const b3 = await env.DB.prepare(
    `SELECT COUNT(*) AS n,
            SUM(CASE WHEN base_freq IS NULL THEN 1 ELSE 0 END) AS noFreq,
            SUM(COALESCE(overage, 0)) AS ovSum,
            SUM(CASE WHEN COALESCE(overage, 0) > 0 THEN 1 ELSE 0 END) AS ovRows
       FROM monthly_quota`
  ).first();
  const stage3b = {
    rows: Number(b3?.n || 0),
    baseFreqMissing: Number(b3?.noFreq || 0),   // ★0でなければ作り直しが要る
    overageSessions: Number(b3?.ovSum || 0),    // 支払い待ちの件数（全月の合計）
    overageMonths: Number(b3?.ovRows || 0),     // それが出ている月の数
  };

  //   ★会員ごとの世代の入り具合（2026-10-09・段階3-b 手順1）。
  //     3-b で顧客に答えてよいかの判定に使う。表がまだ無い（migration 未適用）
  //     場合もあるので、読めなければ「無い」と返す（落とさない）。
  //       total   行がある会員の数
  //       fresh   source === built（D1から答えてよい）
  //       stale   source > built（作り直しが追いついていない＝写しへ落とす）
  //       ahead   built > source（★あってはならない。巻き戻しかバグの印）
  //       noBuilt built が 0（まだ一度も作り直していない）
  let syncVersion = { table: 'missing' };
  try {
    const sv = await env.DB.prepare(
      `SELECT COUNT(*) AS n,
              SUM(CASE WHEN source_version = built_version AND built_version > 0 THEN 1 ELSE 0 END) AS fresh,
              SUM(CASE WHEN source_version > built_version THEN 1 ELSE 0 END) AS stale,
              SUM(CASE WHEN built_version > source_version THEN 1 ELSE 0 END) AS ahead,
              SUM(CASE WHEN built_version = 0 THEN 1 ELSE 0 END) AS noBuilt
         FROM customer_sync_version`
    ).first();
    syncVersion = {
      table: 'ok',
      total: Number(sv?.n || 0),
      fresh: Number(sv?.fresh || 0),
      stale: Number(sv?.stale || 0),
      ahead: Number(sv?.ahead || 0),
      noBuilt: Number(sv?.noBuilt || 0),
    };
    if (syncVersion.stale) {
      const r = await env.DB.prepare(
        `SELECT customer_id, source_version, built_version FROM customer_sync_version
          WHERE source_version > built_version ORDER BY customer_id LIMIT 20`
      ).all();
      syncVersion.staleIds = (r.results || []).map((x) => `${x.customer_id} ${x.source_version}>${x.built_version}`);
    }
  } catch (e) {
    syncVersion = { table: 'missing', detail: String((e && e.message) || e).slice(0, 120) };
  }

  // ★旧「上限なし」の行がどれかを返す（2026-10-08）。新しくは作られない。
  //   件数だけ分かっても直せない。どの会員のどの月かが分からないと、
  //   台帳のどの行を直すのかオーナーに伝えられない。
  //   氏名は出さない（この結果は合言葉なしで読める経路に載る）。
  //   同じ理由で、覆い方が入っていない行（作り直しの取り残し）も返す。
  const detail = {};
  if (coverage.unlimited) {
    const r = await env.DB.prepare(
      `SELECT customer_id, month_key FROM monthly_quota
        WHERE coverage = 'unlimited' ORDER BY customer_id, month_key LIMIT 20`
    ).all();
    detail.unlimited = (r.results || []).map((x) => `${x.customer_id} ${x.month_key}`);
  }
  if (coverage['(未設定)']) {
    const r = await env.DB.prepare(
      `SELECT customer_id, month_key FROM monthly_quota
        WHERE coverage IS NULL ORDER BY customer_id, month_key LIMIT 20`
    ).all();
    detail.notSet = (r.results || []).map((x) => `${x.customer_id} ${x.month_key}`);
  }
  return json({
    ok: true,
    monthly: { rows: Number(m?.n || 0), used: Number(m?.used || 0) },
    packs: { rows: Number(p?.n || 0), used: Number(p?.used || 0) },
    coverage,   // { limited: n, uncovered: n, unlimited: n, '(未設定)': n }
    coverageDetail: detail,   // { unlimited: ['顧客ID 月', …], notSet: [...] }（氏名は出さない）
    stage3b,   // 3-bで足した2列の入り具合（base_freq の抜け・支払い待ちの件数）
    syncVersion,   // 会員ごとの世代（fresh/stale/ahead・3-bの鮮度の判定に使う）
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
