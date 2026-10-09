// shadow：写しとD1を比べて食い違いを数える（段階3-b 手順3・2026-10-09）
//
//   設計：ops/design/12-shadow-compare.md（第5版・関門①を5回目で通過・累計18件・却下0）
//
//   ★顧客に返すのは写しのまま。ここは**観測だけ**。
//   ★応答のあとに走る（ctx.waitUntil）。顧客を待たせない。
//   ★何があっても例外を外に出さない。顧客の画面を壊してはいけない。

import { readRemainDiag, monthKeyJst, monthRangeJst } from './remain-from-d1.js';

export const SHADOW_MODE_ON = 'shadow';

//   1日・会員・入口ごとの上限
export const SLOT_MAX_TOTAL = 5;   // 時間帯3つ ＋ 世代2つぶん
export const SLOT_MAX_VER = 2;     // そのうち世代の枠は2つまで

//   写しの鮮度の線（既存のコードが持っている2つに合わせる）
export const COMPARE_FRESH_MS = 10 * 60 * 1000;   // これ以内なら値を比べる（HOME_TTL_WARN_MS）
export const COPY_TOO_OLD_MS = 40 * 60 * 1000;    // これより古い写しは顧客にも使えない

//   弾いた理由の数え方の上限（これを超えたら数えない＝書き込みを増やさない）
//   ★枠を取る前に弾いたもの（_pre:）は、枠を消費していないので何回でも起こりうる。
//     上限は小さくてよい（分布が分かれば足りる）。
const SKIP_COUNT_MAX = 3;
//   ★枠を取ったあとに弾いたもの（_post:）は、**枠の上限までしか起こらない**。
//     ここを3で打ち止めにすると、4回目以降が
//       incomplete = attempted − completed − failed − post
//     の post に数えられず、**正常に終わった回を「結末を残せなかった」と誤って出す**
//     （2026-10-09・関門②の指摘）。だから枠の上限と同じにする。
export const POST_SKIP_COUNT_MAX = SLOT_MAX_TOTAL;

/** JSTの日付 'YYYY-MM-DD' */
export function dayKeyJst(ms) {
  const d = new Date(Number(ms) + 9 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** JSTの時間帯（3つに割る） */
export function timeBandJst(ms) {
  const h = new Date(Number(ms) + 9 * 3600 * 1000).getUTCHours();
  if (h < 8) return '00-07';
  if (h < 16) return '08-15';
  return '16-23';
}

/** 写しの鮮度の帯（ベースラインで分布を見る） */
export function ageBand(ageMs) {
  const m = Number(ageMs) / 60000;
  if (!isFinite(m) || m < 0) return 'unknown';
  if (m < 5) return '0-5m';
  if (m < 10) return '5-10m';
  if (m < 15) return '10-15m';
  if (m < 40) return '15-40m';
  return '40m+';
}

// ============================================================
// 比べる鍵（★GASの _lbBuildHome が返す鍵の固定の一覧）
// ============================================================
//   ★「両方の鍵の和」で比べてはいけない。片方にしか無い鍵が増えたとき、
//     それが「増やしてしまった」のか「比べるべきもの」なのか判断できない。
//   ★readHome が写しに**後から足している**ものは比べない。
//     computedAt / stale / ageMs / month は毎回必ず食い違う。
export const COMPARE_FIELDS = [
  'type', 'active', 'nextMonth',
  'quota', 'carryover', 'thisMonth', 'monthlyRemaining',
  'ticketTotal', 'ticketRemaining', 'ticketExpire', 'ticketExpireMs',
  'pairRemaining', 'pairPackMax', 'normalTicketRemaining',
  'hasNormalRoute', 'ticketPacks',
  'remaining', 'overageCount', 'displayRemaining', 'paymentRequired',
  'total', 'used', 'expire', 'expireMs',
];
export const SKIP_FIELDS = ['computedAt', 'stale', 'ageMs', 'month'];

/** 値を比べられる形にする（オブジェクトは鍵の順を揃える） */
export function normValue(v) {
  if (v === undefined) return '(なし)';
  if (v === null) return '(null)';
  if (typeof v !== 'object') return String(v);
  return JSON.stringify(sortKeys(v));
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

/** 指紋（★切り詰める**前**の値から作る） */
export function fingerprint(copyNorm, d1Norm) {
  const s = `${copyNorm}\u0000${d1Norm}`;
  //   32bitのFNV-1aを2本（衝突をほぼ無くすために種を変える）
  return `${fnv(s, 0x811c9dc5)}${fnv(s, 0x01000193)}`;
}
function fnv(s, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, '0');
}

const CUT = 200;
const cut = (s) => (s.length > CUT ? s.slice(0, CUT) + '…' : s);

/**
 * 写しとD1を比べる（純粋）。
 *   → { diffs: [{ field, copy, d1, fp }], oneSided: bool }
 */
export function compareHome(copy, d1) {
  const diffs = [];
  //   片方だけが答えた
  const copyNone = (copy == null), d1None = (d1 == null);
  if (copyNone || d1None) {
    if (copyNone && d1None) return { diffs: [], oneSided: false, bothNone: true };
    const c = normValue(copyNone ? null : '(あり)');
    const d = normValue(d1None ? null : '(あり)');
    return { diffs: [{ field: '_one_sided', copy: c, d1: d, fp: fingerprint(c, d) }], oneSided: true };
  }
  for (const f of COMPARE_FIELDS) {
    const c = normValue(copy[f]);
    const d = normValue(d1[f]);
    if (c !== d) diffs.push({ field: f, copy: c, d1: d, fp: fingerprint(c, d) });
  }
  return { diffs, oneSided: false };
}

// ============================================================
// 枠の確保（★1文で・原子的に）
// ============================================================
//   書き換わった行数が 1 なら枠を取れた／0 なら比べない。
//   ★2文に分けると（数えて → 入れる）その間で競合して上限を超える。
const SLOT_TIME_SQL =
  `INSERT INTO remain_shadow_slot (day, customer_id, entry, sample_key, claimed_at)
   SELECT ?, ?, ?, ?, ?
    WHERE (SELECT COUNT(*) FROM remain_shadow_slot
            WHERE day = ? AND customer_id = ? AND entry = ?) < ?
   ON CONFLICT(day, customer_id, entry, sample_key) DO NOTHING`;

const SLOT_VER_SQL =
  `INSERT INTO remain_shadow_slot (day, customer_id, entry, sample_key, claimed_at)
   SELECT ?, ?, ?, ?, ?
    WHERE (SELECT COUNT(*) FROM remain_shadow_slot
            WHERE day = ? AND customer_id = ? AND entry = ?) < ?
      AND (SELECT COUNT(*) FROM remain_shadow_slot
            WHERE day = ? AND customer_id = ? AND entry = ?
              AND sample_key LIKE 'ver:%') < ?
   ON CONFLICT(day, customer_id, entry, sample_key) DO NOTHING`;

export async function claimSlot(env, day, cid, entry, sampleKey, nowMs) {
  const isVer = String(sampleKey).indexOf('ver:') === 0;
  const sql = isVer ? SLOT_VER_SQL : SLOT_TIME_SQL;
  const args = isVer
    ? [day, cid, entry, sampleKey, nowMs, day, cid, entry, SLOT_MAX_TOTAL, day, cid, entry, SLOT_MAX_VER]
    : [day, cid, entry, sampleKey, nowMs, day, cid, entry, SLOT_MAX_TOTAL];
  const r = await env.DB.prepare(sql).bind(...args).run();
  return ((r && r.meta && r.meta.changes) || 0) > 0;
}

// ============================================================
// 記録
// ============================================================
//   数を1つ足す文。first_value / last_value も持ち回る。
function bumpStmt(env, day, cid, entry, field, nowMs, value, limit) {
  const lim = (limit == null) ? null : Number(limit);
  const base =
    `INSERT INTO remain_shadow (day, customer_id, entry, field, first_value, last_value, n, first_at, last_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(day, customer_id, entry, field) DO UPDATE SET
       n = n + 1, last_value = excluded.last_value, last_at = excluded.last_at`;
  //   ★上限つきの更新は、条件を満たさなければ行を変えない＝書き込みを消費しない。
  const sql = (lim == null) ? base : base + ` WHERE remain_shadow.n < ${lim}`;
  const v = value == null ? null : cut(String(value));
  return env.DB.prepare(sql).bind(day, cid, entry, field, v, v, nowMs, nowMs);
}

function sampleStmt(env, row) {
  return env.DB.prepare(
    `INSERT INTO remain_shadow_sample
       (day, customer_id, entry, field, fp, requested_month, copy_month, d1_month,
        copy_computed_at, source_version, built_version, d1_status, copy_value, d1_value, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(day, customer_id, entry, field, fp) DO NOTHING`
  ).bind(row.day, row.customerId, row.entry, row.field, row.fp,
         row.requestedMonth, row.copyMonth, row.d1Month, row.copyComputedAt,
         row.sourceVersion, row.builtVersion, row.d1Status,
         cut(String(row.copyValue)), cut(String(row.d1Value)), row.at);
}

/**
 * 比べて記録する本体。
 *   ★呼ぶ側は ctx.waitUntil(...) で包む。ここでは例外を外に出さない。
 */
export async function runShadow(env, opts) {
  const nowMs = Number(opts.nowMs || Date.now());
  const cid = String(opts.customerId || '');
  const entry = String(opts.entry || '');
  const day = dayKeyJst(nowMs);
  const copyDiag = opts.copyDiag || {};
  const requestedMonth = opts.targetMs ? monthKeyJst(Number(opts.targetMs)) : monthKeyJst(nowMs);

  if (!cid || !entry) return { done: false, why: 'bad_args' };

  // ---- 1. 枠を取る前に弾くもの（★枠を消費させない）----
  //   写しの鮮度の分布は、弾いたかどうかに関わらず数える（上限つき）
  const pre = [];
  if (copyDiag.status === 'ok') {
    pre.push({ field: `_age:${ageBand(copyDiag.ageMs)}`, value: null });
  }
  let preSkip = null;
  //   ★D1が持っていない月は、枠を取る前に分かる（2026-10-09・関門②の2周目）。
  //     あとで readRemainDiag に 'out_of_range' を返させると、
  //     **比べられないと分かっている要求が枠を消費する**＝その日の機会を減らす。
  const curKey = monthKeyJst(nowMs);
  const nextKey = monthKeyJst(monthRangeJst(nowMs).to + 86400000);
  if (requestedMonth !== curKey && requestedMonth !== nextKey) preSkip = 'out_of_range';
  else if (copyDiag.status === 'ok') {
    const age = Number(copyDiag.ageMs || 0);
    if (age > COPY_TOO_OLD_MS) preSkip = 'copy_too_old';
    else if (age > COMPARE_FRESH_MS) preSkip = 'copy_stale_for_compare';
    else if (copyDiag.month && String(copyDiag.month) !== requestedMonth) preSkip = 'copy_month_mismatch';
  }
  //   ★写しが使えない（status が ok でない）場合も比べる。
  //     「写しが壊れているのにD1なら答えられる」が、手順4でいちばん確かめたい場面。

  if (preSkip) {
    await writeAll(env, pre.concat([{ field: `_pre:${preSkip}`, value: null, limit: SKIP_COUNT_MAX }]),
                   day, cid, entry, nowMs);
    return { done: false, why: preSkip };
  }

  // ---- 2. 世代を軽く読む（枠の鍵に使う）----
  let verKey = 'ver:0:0';
  let verBefore = null;
  try {
    const v = await env.DB.prepare(
      'SELECT source_version, built_version FROM customer_sync_version WHERE customer_id = ?'
    ).bind(cid).first();
    if (v) {
      verBefore = { sourceVersion: Number(v.source_version || 0), builtVersion: Number(v.built_version || 0) };
      verKey = `ver:${verBefore.sourceVersion}:${verBefore.builtVersion}`;
    }
  } catch (_) { /* 読めなければ ver:0:0 のまま（枠は取れる） */ }

  // ---- 3. 枠を取る（★時間帯 → 世代 の順）----
  let got = false, sampleKey = `time:${timeBandJst(nowMs)}`;
  try {
    got = await claimSlot(env, day, cid, entry, sampleKey, nowMs);
    if (!got) {
      sampleKey = verKey;
      got = await claimSlot(env, day, cid, entry, sampleKey, nowMs);
    }
  } catch (e) {
    try { console.error('[shadow] 枠が取れませんでした', entry, String((e && e.message) || e)); } catch (_) {}
    return { done: false, why: 'slot_failed' };
  }
  if (!got) {
    //   枠が無いのは正常（上限に達した／同じ枠がもう取られた）。何も書かない。
    if (pre.length) { try { await writeAll(env, pre, day, cid, entry, nowMs); } catch (_) {} }
    return { done: false, why: 'no_slot' };
  }

  // ---- 4. D1から読む ----
  let d1;
  try {
    d1 = await readRemainDiag(env, cid, opts.targetMs, { nowMs, lang: opts.lang });
  } catch (e) {
    await safeWrite(env, [{ field: '_failed', value: 'd1_threw', limit: null }], day, cid, entry, nowMs);
    try { console.error('[shadow] D1の読み取りで落ちました', entry, String((e && e.message) || e)); } catch (_) {}
    return { done: false, why: 'd1_threw' };
  }

  //   ★枠を取るために読んだ世代と、実際に読んだ行の世代が違えば比べない
  //     （2026-10-09・関門②の指摘）。
  //     枠は 'ver:3:3' で取ったのに 'ver:4:4' の行を比べると、
  //     **世代の枠が違う世代に使われる**＝「変更の直後を見る」という枠の意味が壊れる。
  //   ★D1が答えられたか（status）に関わらず、先に照合する（関門②の2周目）。
  //     'ver:3:3' の枠で読んだら 'ver:4:3'（behind）だった、という場合も
  //     「世代が動いた」であって「追いついていない」ではない。分類を混ぜない。
  //   ★枠は戻さない（戻すと並行した要求が取り直して上限管理が壊れる）。
  if (verBefore && d1.version
      && (d1.version.sourceVersion !== verBefore.sourceVersion
          || d1.version.builtVersion !== verBefore.builtVersion)) {
    await safeWrite(env, pre.concat([{ field: '_post:version_changed_during_shadow',
                                       value: null, limit: POST_SKIP_COUNT_MAX }]),
                    day, cid, entry, nowMs);
    return { done: false, why: 'version_changed_during_shadow' };
  }

  //   世代が読み取り中に動いた等は「枠を取ったあとに分かったこと」
  if (d1.status !== 'ok') {
    await safeWrite(env, pre.concat([{ field: `_post:${d1.status}`, value: null, limit: POST_SKIP_COUNT_MAX }]),
                    day, cid, entry, nowMs);
    return { done: false, why: d1.status };
  }

  // ---- 5. 比べる ----
  const cmp = compareHome(copyDiag.value || null, d1.value || null);

  // ---- 6. ★1回ぶんの記録を同じ batch に入れる ----
  //   _completed だけ増えて食い違いの行が書けなかった状態は、
  //   **「一致した」ように見える**（いちばん危険な壊れ方）。
  const stmts = [];
  for (const p of pre) stmts.push(bumpStmt(env, day, cid, entry, p.field, nowMs, p.value, SKIP_COUNT_MAX));
  stmts.push(bumpStmt(env, day, cid, entry, '_completed', nowMs, null, null));
  for (const d of cmp.diffs) {
    const pair = `写し=${d.copy} / D1=${d1 ? d.d1 : ''}`;
    stmts.push(bumpStmt(env, day, cid, entry, d.field, nowMs, pair, null));
    stmts.push(sampleStmt(env, {
      day, customerId: cid, entry, field: d.field, fp: d.fp,
      requestedMonth, copyMonth: copyDiag.month || null, d1Month: d1.month || null,
      copyComputedAt: copyDiag.computedAt == null ? null : Number(copyDiag.computedAt),
      sourceVersion: d1.version ? d1.version.sourceVersion : null,
      builtVersion: d1.version ? d1.version.builtVersion : null,
      d1Status: d1.status, copyValue: d.copy, d1Value: d.d1, at: nowMs,
    }));
  }
  try {
    await env.DB.batch(stmts);
  } catch (e) {
    //   ★batch が落ちたら _failed を best-effort で書き、必ずログに出す。
    await safeWrite(env, [{ field: '_failed', value: 'batch', limit: null }], day, cid, entry, nowMs);
    try { console.error('[shadow] 記録のbatchが落ちました', entry, String((e && e.message) || e)); } catch (_) {}
    return { done: false, why: 'batch_failed' };
  }
  return { done: true, diffs: cmp.diffs.length };
}

async function writeAll(env, items, day, cid, entry, nowMs) {
  if (!items.length) return;
  await env.DB.batch(items.map((x) => bumpStmt(env, day, cid, entry, x.field, nowMs, x.value, x.limit)));
}
async function safeWrite(env, items, day, cid, entry, nowMs) {
  try { await writeAll(env, items, day, cid, entry, nowMs); } catch (_) {}
}

/**
 * 顧客の経路から呼ぶ入口。**例外を外に出さない。**
 *   ctx.waitUntil で応答のあとに走らせる。
 */
export function scheduleShadow(env, opts) {
  try {
    const mode = String((env && env.LB_D1_REMAIN_MODE) || 'off');
    if (mode !== SHADOW_MODE_ON) return false;          // ★厳密に 'shadow' のときだけ
    if (!opts || opts.shadow !== true) return false;    // ★入口の意思
    const ctx = opts.ctx;
    if (!ctx || typeof ctx.waitUntil !== 'function') return false;   // ★応答のあとに走らせる手段
    ctx.waitUntil(
      runShadow(env, opts).catch((e) => {
        try { console.error('[shadow] 想定外', String((e && e.message) || e)); } catch (_) {}
      })
    );
    return true;
  } catch (_) {
    return false;   // 何があっても顧客の画面を壊さない
  }
}
