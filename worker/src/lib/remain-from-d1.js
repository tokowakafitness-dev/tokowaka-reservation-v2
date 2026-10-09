// D1の行から残数を作る（段階3-b 手順2・2026-10-09）
//
//   設計：ops/design/10-stage-3b-read-from-d1.md（関門①の追記を含む）／11-sync-version.md
//
//   ★いまは誰も呼んでいない。顧客に出る数字は写し（member_home）のまま。
//     手順3（shadow）で、両方を読んで食い違いを数えてから繋ぐ。
//
//   ★要点は1つ：**写しとまったく同じ形で返す。**
//     呼ぶ側を変えずに差し替えられる＝戻すのも一瞬。
//     形の出どころは gas/LineBooking.js の _lbBuildHome（この1箇所だけ）。
//
//   ★GASの癖をそのまま写す（直さない）。
//     _lbBuildHome は、翌月ぶんの写しを作るときも
//       ・thisMonth（今月の予約件数）
//       ・overageCount（支払い待ち）
//     を**当月のもの**で埋めている。これを「直して」しまうと、
//     shadow の食い違いが「GASの癖」と「こちらの間違い」の2種類混ざって読めなくなる。
//     直すなら写しを読む経路を畳んだあと、別の変更として行う。

/** 月のキー（JST） */
export function monthKeyJst(ms) {
  const d = new Date(ms + 9 * 3600 * 1000);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

/** GASの _lbFmtDateOnly と同じ書式（日本語・JST） */
export function fmtDateOnlyJst(ms, lang) {
  if (ms == null || !isFinite(ms)) return '';
  const d = new Date(Number(ms) + 9 * 3600 * 1000);
  if (String(lang || '').toLowerCase().indexOf('en') === 0) {
    const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()];
    return `${mon} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  }
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

/**
 * 月額の見せる残数。coverage の3状態で分かれる（照合 quota-verify と同じ規則）。
 *   返り値 { rem, ok } … ok=false は「比べられない／答えてはいけない」
 */
export function monthlyRemainOf(row) {
  if (!row) return { rem: null, ok: true, hasRow: false };   // 枠の行が無い＝月額の契約が無い
  const cov = row.coverage;
  if (cov === 'limited') return { rem: Number(row.quota) - Number(row.used), ok: true, hasRow: true };
  if (cov === 'uncovered') return { rem: 0, ok: true, hasRow: true };
  if (cov === 'unlimited') return { rem: null, ok: true, hasRow: true };
  //   ★NULL は「まだ作り直していない」。既定値で埋めない（0012 に詳述）。
  return { rem: null, ok: false, hasRow: true };
}

/** そのパックの残り（買った枚数 − 移行前に使った枚数 − 引当で使った枚数） */
function packRest(p) {
  return Number(p.total) - Number(p.opening_used || 0) - Number(p.used);
}

/**
 * 対象日に有効なパックを集計する。
 *   ★「有効」は valid_from <= 対象日 <= valid_to（計算側 _lbComputeRemaining と同じ）。
 *   ★残りが負のパック（買った枚数を超えて使っている）は 0 に丸めるが、
 *     丸めた事実を overUse として返す。黙って隠すと異常が見えなくなる。
 */
export function ticketsAt(packs, atMs) {
  let rem = 0, pair = 0, normal = 0, pairPackMax = 0, overUse = 0;
  const list = [];
  for (const p of (packs || [])) {
    if (!(Number(p.valid_from) <= atMs && atMs <= Number(p.valid_to))) continue;
    const rest = packRest(p);
    if (rest < 0) { overUse += -rest; }
    const r = Math.max(0, rest);
    rem += r;
    if (String(p.kind) === 'pair') {
      pair += r;
      if (r > pairPackMax) pairPackMax = r;
    } else {
      normal += r;
    }
    if (r > 0) list.push({ remaining: r, expireMs: Number(p.valid_to), kind: String(p.kind || 'normal') });
  }
  list.sort((a, b) => a.expireMs - b.expireMs);   // FEFO＝先に切れる順
  return { rem, pair, normal, pairPackMax, overUse, list };
}

/**
 * 写し（member_home の current / next）と同じ形を作る。純粋関数。
 *
 *   入力はすべて呼ぶ側が読んで渡す（テストできるようにするため）。
 *     nowMs           判定の基準時刻
 *     targetMs        どの月の残数か（当月なら nowMs と同じ月）
 *     targetMonthRow  対象月の monthly_quota 行（無ければ null）
 *     curMonthRow     ★当月の行（thisMonth と overageCount は当月のものを使う＝GASの癖）
 *     nextMonthRow    翌月の行（25日以降の案内に使う・無ければ null）
 *     packs           その会員の ticket_packs 全行
 *     thisMonthCount  当月の予約件数（confirmed/consumed・transfer を除く）
 *
 *   返り値 null ＝**答えてはいけない**（写しへ落とす）。
 */
export function buildRemainFromRows(input) {
  return buildRemainDiag(input).value;
}

/**
 * 上と同じものを作るが、**作れなかった理由**も返す（shadow が見る）。
 *   { value, status }
 *     'ok'                 作れた（契約が無い会員の { type: null } も ok）
 *     'coverage_missing'   枠の行に coverage が入っていない＝まだ作り直していない
 *     'base_freq_missing'  枠の行に base_freq が入っていない＝同じ
 *
 *   ★顧客向けの関数（上）は理由を捨てて null を返す。振る舞いは変えない。
 */
export function buildRemainDiag(input) {
  const nowMs = Number(input.nowMs);
  const targetMs = Number(input.targetMs != null ? input.targetMs : nowMs);
  const packs = input.packs || [];
  const lang = input.lang;

  const tm = monthlyRemainOf(input.targetMonthRow);
  if (!tm.ok) return { value: null, status: 'coverage_missing' };
  const cm = monthlyRemainOf(input.curMonthRow);
  if (!cm.ok) return { value: null, status: 'coverage_missing' };

  //   ★契約の有無は「行があるか」で決める。
  //     月額：対象月または当月に枠の行がある（覆っていない月も uncovered の行が作られる）
  //     チケット：パックの行がある（期限切れでも「チケット契約がある」側）
  const hasMonthly = tm.hasRow || cm.hasRow;
  const hasTicket = packs.length > 0;
  //   契約が無い（写しと同じ形）。これは「作れなかった」ではない
  if (!hasMonthly && !hasTicket) return { value: { type: null }, status: 'ok' };

  const tk = ticketsAt(packs, targetMs);

  //   ★枠の行の2列（3-bで足した）から、写しと同じ2つを作る。
  //       quota     ＝ その月の頻度（base_freq）
  //       carryover ＝ 枠 − 頻度
  //     base_freq が入っていない行からは作れない。**0 で埋めない**
  //     （埋めると carryover = quota 全部になり、繰越が過大に見える）。
  let quota = 0, carryover = 0;
  if (tm.hasRow) {
    const bf = input.targetMonthRow.base_freq;
    if (bf == null) return { value: null, status: 'base_freq_missing' };
    quota = Number(bf);
    carryover = Number(input.targetMonthRow.quota) - quota;
  }

  //   ★支払い待ちは引当の行に現れない（未割当の予約は引当を作らない）。
  //     枠の行の overage 列に入れてある。当月のものを使う（GASの癖に合わせる）。
  const overageCount = input.curMonthRow ? Number(input.curMonthRow.overage || 0) : 0;

  const type = (hasMonthly && hasTicket) ? 'both' : (hasTicket ? 'ticket' : 'monthly');
  const monthlyRemaining = tm.rem;
  const remaining = (type === 'ticket') ? tk.rem : monthlyRemaining;

  //   チケットの有効期限＝いちばん遅いパックの期限（期限切れも含めて見る＝GASと同じ）
  let expireMs = null;
  for (const p of packs) {
    const v = Number(p.valid_to);
    if (expireMs === null || v > expireMs) expireMs = v;
  }
  const ticketExpire = hasTicket && expireMs != null ? fmtDateOnlyJst(expireMs, lang) : '';

  //   買った枚数の合計（写しの ticketTotal / total）。期限切れも含む。
  let ticketTotal = 0;
  for (const p of packs) ticketTotal += Number(p.total || 0);

  //   翌月の案内（25日以降だけ）。翌月に使える回数が0なら出さない。
  let nextMonth = null;
  const jstNow = new Date(nowMs + 9 * 3600 * 1000);
  if (jstNow.getUTCDate() >= 25) {
    //   翌月の中旬＝確実にその月（GASと同じ取り方）
    const nm = Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth() + 1, 15, 3, 0, 0);
    const nmRem = monthlyRemainOf(input.nextMonthRow);
    if (nmRem.ok) {
      const nTk = ticketsAt(packs, nm);
      const total = (nmRem.rem == null ? 0 : Number(nmRem.rem)) + Number(nTk.rem || 0);
      if (total > 0) {
        const d = new Date(nm);
        nextMonth = { month: d.getUTCMonth() + 1, total };
      }
    }
  }

  return { status: 'ok', value: {
    type, active: true, nextMonth,
    quota, carryover, thisMonth: Number(input.thisMonthCount || 0), monthlyRemaining,
    ticketTotal, ticketRemaining: tk.rem, ticketExpire, ticketExpireMs: expireMs,
    pairRemaining: tk.pair, pairPackMax: tk.pairPackMax, normalTicketRemaining: tk.normal,
    hasNormalRoute: ((monthlyRemaining == null) ? !!hasMonthly : (monthlyRemaining > 0)) || (tk.normal > 0),
    ticketPacks: tk.list.map((p) => ({
      remaining: p.remaining, expire: fmtDateOnlyJst(p.expireMs, lang), kind: p.kind,
    })),
    remaining,
    overageCount,
    displayRemaining: (overageCount > 0) ? -overageCount : remaining,
    paymentRequired: overageCount > 0,
    total: ticketTotal, used: (ticketTotal - tk.rem), expire: ticketExpire, expireMs,
    //   ★D1から作ったことが分かる印（shadow で出どころを見分ける）。
    //     写しには無い鍵なので、比べるときは除く。
    _src: 'd1',
    _packOverUse: tk.overUse,
  } };
}

//   当月の予約件数の数え方（GAS _lbCountReservations の 'month' と同じ意味）
//
//   ★★語彙が違う（2026-10-09・Codex関門②）。
//     台帳（GAS）           'confirmed' / 'consumed'
//     D1の写し              'booked'    / 'consumed'
//     押し出しが変換している（gas/PushToEdge.js:236 `(st === 'confirmed') ? 'booked'`）。
//     ここを台帳の語彙で書くと、**通常の予約が1件も数えられない**（consumed だけ数える）。
//     意味は同じでも、保存している言葉が違う。D1を読むなら D1 の言葉で書く。
//   ★振替（book_type='transfer'）は数えない（当日消化済み＋別請求のため残数を消化しない）。
export const THIS_MONTH_COUNT_SQL =
  `SELECT COUNT(*) AS n FROM reservations
    WHERE customer_id = ?
      AND status IN ('booked', 'consumed')
      AND COALESCE(book_type, '') <> 'transfer'
      AND start_at >= ? AND start_at < ?`;

/** その月（JST）の始まりと終わりをミリ秒で */
export function monthRangeJst(ms) {
  const d = new Date(Number(ms) + 9 * 3600 * 1000);
  const from = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0) - 9 * 3600 * 1000;
  const to = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0) - 9 * 3600 * 1000;
  return { from, to };
}

/**
 * D1の行から残数を読む（薄い入れ物）。
 *
 *   ★鮮度（世代）を先に見る。追いついていなければ**何も読まずに null を返す**。
 *     呼ぶ側は写し（member_home）へ落とす。
 *   ★targetMs を渡すと、その月の残数。写しと同じく、持っていない月は null。
 */
export async function readRemainFromD1(env, customerId, targetMs, opts) {
  const d = await readRemainDiag(env, customerId, targetMs, opts);
  return d.value;
}

/**
 * 上と同じものを読むが、**答えられなかった理由**も返す（shadow が見る）。
 *   { value, status, month, version }
 *     status  'ok' / 'no_customer' / 'out_of_range' / 'no_version_row' / 'not_built'
 *             / 'behind' / 'read_failed' / 'version_changed'
 *             / 'coverage_missing' / 'base_freq_missing'
 *
 *   ★顧客向けの readRemainFromD1 は理由を捨てて null を返す。振る舞いは変えない。
 *   ★targetMs は**そのまま使う**（月の選択とチケットの有効性の両方）。
 *     月の中旬などに置き換えてはいけない。置き換えると
 *     「10/31の写しに10/15を渡す」ことになり、10/20に買ったパックが無効になる
 *     ＝月は同じでも残数が別物になる（設計12 第4節・関門①の指摘）。
 */
export async function readRemainDiag(env, customerId, targetMs, opts) {
  if (!customerId) return { value: null, status: 'no_customer' };
  const o = opts || {};
  const nowMs = Number(o.nowMs || Date.now());
  const target = Number(targetMs || nowMs);

  //   ★当月と翌月しか答えない（写しが持っているのと同じ2か月）。
  const curKey = monthKeyJst(nowMs);
  const nextKey = monthKeyJst(monthRangeJst(nowMs).to + 86400000);
  const wantKey = monthKeyJst(target);
  if (wantKey !== curKey && wantKey !== nextKey) {
    return { value: null, status: 'out_of_range', month: wantKey };
  }

  //   鮮度の判定（手順1で入れた世代）
  const ver = await readSyncVersionForRemain(env, customerId);
  if (!ver.ok) return { value: null, status: ver.status, month: wantKey, version: ver.version };

  const cur = monthRangeJst(nowMs);
  let rows, packs, cnt;
  try {
    [rows, packs, cnt] = await Promise.all([
      env.DB.prepare(
        `SELECT month_key, quota, used, coverage, base_freq, overage
           FROM monthly_quota WHERE customer_id = ? AND month_key IN (?, ?)`
      ).bind(customerId, curKey, nextKey).all(),
      env.DB.prepare(
        `SELECT pack_id, kind, total, used, opening_used, valid_from, valid_to
           FROM ticket_packs WHERE customer_id = ?`
      ).bind(customerId).all(),
      env.DB.prepare(THIS_MONTH_COUNT_SQL).bind(customerId, cur.from, cur.to).first(),
    ]);
  } catch (_) {
    //   ★読めなかったら答えない（列が無い・表が無い等）。
    //     呼ぶ側に例外を投げると、写しへ落とす道が通らず画面が止まる。
    return { value: null, status: 'read_failed', month: wantKey, version: ver.version };
  }

  //   ★読み終わったあと、もう一度世代を見る。
  //     鮮度を確かめてから行を読むまでの間に押し出しが来ると、
  //     「新しいと確かめた世代」と「実際に読んだ行」がずれる。
  const ver2 = await readSyncVersionForRemain(env, customerId);
  if (!ver2.ok || ver2.version.sourceVersion !== ver.version.sourceVersion
               || ver2.version.builtVersion !== ver.version.builtVersion) {
    return { value: null, status: 'version_changed', month: wantKey, version: ver.version };
  }

  const byMonth = {};
  for (const r of (rows.results || [])) byMonth[String(r.month_key)] = r;

  const built = buildRemainDiag({
    nowMs, targetMs: target,
    targetMonthRow: byMonth[wantKey] || null,
    curMonthRow: byMonth[curKey] || null,
    nextMonthRow: byMonth[nextKey] || null,
    packs: packs.results || [],
    thisMonthCount: Number((cnt && cnt.n) || 0),
    lang: o.lang,
  });
  return { value: built.value, status: built.status, month: wantKey, version: ver.version };
}

//   世代の判定だけを切り出す（sync-version.js を直接使うと輪になるため、ここで薄く読む）
async function readSyncVersionForRemain(env, customerId) {
  const none = { sourceVersion: 0, builtVersion: 0 };
  try {
    const r = await env.DB.prepare(
      `SELECT source_version, built_version FROM customer_sync_version WHERE customer_id = ?`
    ).bind(String(customerId)).first();
    if (!r) return { ok: false, status: 'no_version_row', version: none };
    const s = Number(r.source_version || 0), b = Number(r.built_version || 0);
    const version = { sourceVersion: s, builtVersion: b };
    if (!(b > 0)) return { ok: false, status: 'not_built', version };
    if (s !== b) return { ok: false, status: 'behind', version };
    return { ok: true, status: 'ok', version };
  } catch (_) {
    //   ★表が無い／読めない＝答えない（写しへ落とす）
    return { ok: false, status: 'read_failed', version: none };
  }
}
