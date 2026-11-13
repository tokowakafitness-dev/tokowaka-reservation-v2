// 会員画面で同意を求めて記録する（設計44）・2026-11-13
//
//   窓口：m_myConsent（読み取り）・m_saveConsent（書き込み）。customer だけ（perms.js）。
//   入口（index.js）で済んでいること：ID トークン・役割の確定・役割の鮮度（m_ は古ければ 503・FALLBACK にしない）・
//     許可表・m_saveConsent は Origin の完全一致と iat 1時間
//
//   ここで守ること
//     ・本人は who.customerId だけ。**body から顧客を指す値を読まない**（I-M1 と同じ）
//     ・切替 MEMBER_CONSENT は「勧誘と新しい同意」にだけ効く。録音・AI に同意している本人は、切替が閉じていても状態を読み、撤回できる（改訂2 高2・改訂3）
//     ・健康情報のいまの状態は karte_consent（I48 の正本）に書く。録音・AI は karte_consent_rec。回答と版は karte_consent_answers。状態の変化は karte_consent_log
//     ・declined（今回は同意しない）は回答の表にだけ＝いまの状態を変えない（誤って外しても撤回にならない）
//     ・会員画面から健康情報の撤回は受けない（撤回は I48 で健康情報を同じ batch で消す＝会員の操作で走らせるかはオーナーの未決・設計44 §9-1）
//     ・再送（同じ状態・同じ版）は状態・log・回答に何も書かない（最初の時刻が残る）。監査（access_log）だけは書く
//     ・全ての例外を固定のコードにする（message・ID を console に出さない）

import { CONSENT_DOCS, CONSENT_KINDS, CONSENT_VALID_REC, MEMBER_ACTOR } from '../lib/consent-docs.js';

export const CONSENT_LIMITS = { WINDOW_MS: 10 * 60 * 1000, ANSWERS_PER_WINDOW: 20 };

/** 切替のモード（厳密一致・それ以外は off） */
export function memberConsentMode(env) {
  const m = String((env && env.MEMBER_CONSENT) || '');
  return m === 'on' || m === 'allow' ? m : 'off';
}
/** 勧誘・新しい同意を出してよいか（担当 default_trainer_id で allow を判定）。同意の有効性には関係しない */
export function memberConsentOpen(env, defaultTrainerId) {
  const mode = memberConsentMode(env);
  if (mode === 'on') return true;
  if (mode !== 'allow') return false;
  const t = String(defaultTrainerId || '');
  if (!t) return false;
  const list = String((env && env.MEMBER_CONSENT_TRAINERS) || '').split(',').map((x) => x.trim()).filter((x) => x !== '');
  return list.indexOf(t) >= 0;
}
/** 録音・AI の同意が AI の関門で有効か */
export function recConsentValid(row) {
  return !!(row && row.state === 'agreed' && CONSENT_VALID_REC.indexOf(String(row.doc_ver || '')) >= 0);
}

/**
 * 起動の印（compat の memberStatus が使う）。true／false／'unknown'
 *   開いている → true。閉じている → 録音・AI に agreed の行があれば true（撤回の入口のため）・無ければ false・読めなければ 'unknown'
 *   ★'unknown' は画面が m_myConsent に聞き直す印。起動そのものは同意の表の失敗で GAS へ落とさない（関門① 3周目 高2）
 *   recP：呼び出し側が顧客・残数と並べて先に読み始めた startRecRead() の結果（関門① 4周目 中4）
 */
export async function memberConsentFlag(env, defaultTrainerId, recP) {
  if (memberConsentOpen(env, defaultTrainerId)) return true;
  const x = recP ? await recP : { err: true };
  if (x.err) return 'unknown';
  return !!(x.row && x.row.state === 'agreed');
}
/** 起動で先に読み始める（失敗しても投げない＝未処理の reject を作らない）。on のときは読まない */
export function startRecRead(env, customerId) {
  if (memberConsentMode(env) === 'on') return null;
  try {
    return readRecRow(env, customerId).then((row) => ({ row }), () => ({ err: true }));
  } catch (_) { return Promise.resolve({ err: true }); }
}
export function readRecRow(env, customerId) {
  return env.DB.prepare('SELECT state, changed_at, method, recorded_by, doc_ver FROM karte_consent_rec WHERE customer_id = ?')
    .bind(String(customerId)).first();
}

const fail = (code, status, detail) => ({ _error: code, _status: status, detail });
const docOut = (k) => ({ kind: k, ver: CONSENT_DOCS[k].ver, title: CONSENT_DOCS[k].title,
                          paragraphs: CONSENT_DOCS[k].paragraphs.slice(), check: CONSENT_DOCS[k].check });

async function logAccessMember(env, customerId, action, result) {
  try {
    await env.DB.prepare(
      `INSERT INTO karte_access_log (at, trainer_id, role, customer_id, section, action, result, req_id)
       VALUES (?, NULL, 'customer', ?, 'consent', ?, ?, NULL)`
    ).bind(Date.now(), String(customerId), action, result).run();
  } catch (_) {
    try { console.error('[member-consent] access_log write failed'); } catch (_) {}
  }
}

/** 本人の状態を読む（例外はそのまま投げる＝呼び出し側で固定コードに） */
async function readState(env, cid) {
  //   ★回答は件数で切らずに、必要な事実だけを個別の SQL で引く（関門② 中：200件で切ると古い版を「紙」と取り違えた）
  const [h, r, hAns, curAns] = await Promise.all([
    env.DB.prepare(`SELECT state, changed_at, method, recorded_by FROM karte_consent WHERE customer_id = ? AND kind = 'health'`).bind(cid).first(),
    readRecRow(env, cid),
    //   健康情報のいまの同意の版：health の agreed の最新の回答
    env.DB.prepare(`SELECT doc_ver FROM karte_consent_answers WHERE customer_id = ? AND kind = 'health' AND answer = 'agreed' ORDER BY at DESC, id DESC LIMIT 1`).bind(cid).first(),
    //   現行の版に答えた kind
    env.DB.prepare(`SELECT DISTINCT kind FROM karte_consent_answers WHERE customer_id = ? AND ((kind = 'health' AND doc_ver = ?) OR (kind = 'rec_ai' AND doc_ver = ?))`)
      .bind(cid, CONSENT_DOCS.health.ver, CONSENT_DOCS.rec_ai.ver).all(),
  ]);
  const answeredKinds = ((curAns && curAns.results) || []).map((x) => x.kind);
  const answeredCur = (k) => answeredKinds.indexOf(k) >= 0;
  //   紙・トレーナーの記録（版なし）は有効。会員の記録は、対応する回答の版が現行のときだけ「最新」（回答が見つからなければ最新とみなさない）
  const hMember = !!(h && h.recorded_by === MEMBER_ACTOR);
  const hCurrent = !!(h && h.state === 'agreed' && (!hMember || (hAns && hAns.doc_ver === CONSENT_DOCS.health.ver)));
  const st = {
    health: h ? { state: h.state, at: h.changed_at, byMember: hMember, current: hCurrent }
              : { state: 'none', at: null, byMember: false, current: false },
    rec_ai: r ? { state: r.state, at: r.changed_at, byMember: r.recorded_by === MEMBER_ACTOR, current: recConsentValid(r) }
              : { state: 'none', at: null, byMember: false, current: false },
  };
  //   ask：記録が無い、または会員が古い版に同意している、かつ この版にまだ答えていない（revoked・紙の agreed は出さない）
  const needs = (k) => {
    const s = st[k];
    if (s.state === 'none') return !answeredCur(k);
    if (s.state === 'agreed' && !s.current) return !answeredCur(k);
    return false;
  };
  return { st, ask: CONSENT_KINDS.filter(needs), recRow: r, healthRow: h, answeredCur };
}

async function custTrainer(env, cid) {
  const c = await env.DB.prepare('SELECT default_trainer_id FROM customers WHERE customer_id = ?').bind(cid).first();
  return c ? String(c.default_trainer_id || '') : null;
}

// ---------------------------------------------------------------- m_myConsent
export async function myConsent({ env, who }) {
  if (!who || who.role !== 'customer' || !who.customerId) return fail('FORBIDDEN', 403);
  const cid = String(who.customerId);
  try {
    const t = await custTrainer(env, cid);
    if (t === null) return fail('FORBIDDEN', 403);
    const open = memberConsentOpen(env, t);
    const s = await readState(env, cid);
    if (open) return { mode: 'full', docs: CONSENT_KINDS.map(docOut), state: s.st, ask: s.ask };
    //   閉じている：録音・AI に同意している本人にだけ、撤回のための rec_ai の文面と状態（勧誘しない）
    if (s.st.rec_ai.state === 'agreed') return { mode: 'revoke_only', docs: [docOut('rec_ai')], state: { rec_ai: s.st.rec_ai }, ask: [] };
    return fail('MEMBER_CONSENT_OFF', 503);
  } catch (_) {
    try { console.error('[member-consent] read failed'); } catch (_) {}
    return fail('CONSENT_UNAVAILABLE', 503);
  }
}

// ---------------------------------------------------------------- m_saveConsent
const KEYS = ['action', 'idToken', 'lang', 'answers', 'vers'];
const ANSWERS_OK = { health: ['agreed', 'declined'], rec_ai: ['agreed', 'declined', 'revoked'] };
const S = (sql, ...args) => ({ sql, args });

/** 本文を検査して [[kind, answer, ver]] を返す。だめなら null */
function parseBody(body) {
  for (const k of Object.keys(body)) if (KEYS.indexOf(k) < 0) return null;
  const a = body.answers, v = body.vers;
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = [];
  for (const k of Object.keys(a)) {
    if (!ANSWERS_OK[k] || ANSWERS_OK[k].indexOf(a[k]) < 0) return null;
    if (typeof v[k] !== 'string' || !v[k]) return null;
    out.push([k, a[k], v[k]]);
  }
  for (const k of Object.keys(v)) if (!ANSWERS_OK[k] || !(k in a)) return null;
  return out.length ? out : null;
}

export async function saveConsent({ env, who, body }) {
  if (!who || who.role !== 'customer' || !who.customerId) return fail('FORBIDDEN', 403);
  const cid = String(who.customerId);
  const items = parseBody(body || {});
  if (!items) { await logAccessMember(env, cid, 'm_saveConsent', 'denied'); return fail('BAD_REQUEST', 400); }
  //   ★会員画面から健康情報の撤回は受けない（parseBody の ANSWERS_OK に無い＝400）
  for (const [k, , ver] of items) {
    if (ver !== CONSENT_DOCS[k].ver) { await logAccessMember(env, cid, 'm_saveConsent', 'conflict'); return fail('DOC_CHANGED', 409); }
  }
  let res;
  try {
    res = await saveInner(env, cid, items);
  } catch (e) {
    const m = String((e && e.message) || '');
    if (m.indexOf('KARTE_GUARD_CSTATE') >= 0) { await logAccessMember(env, cid, 'm_saveConsent', 'conflict'); return fail('CONFLICT', 409); }
    if (m.indexOf('KARTE_GUARD_CRATE') >= 0) { await logAccessMember(env, cid, 'm_saveConsent', 'rate_limited'); return fail('RATE_LIMITED', 429); }
    try { console.error('[member-consent] save failed'); } catch (_) {}
    await logAccessMember(env, cid, 'm_saveConsent', 'error');
    return fail('CONSENT_UNAVAILABLE', 503);
  }
  await logAccessMember(env, cid, 'm_saveConsent', res._error ? (res._status === 429 ? 'rate_limited' : 'denied') : 'ok');
  return res;
}

async function saveInner(env, cid, items) {
  const t = await custTrainer(env, cid);
  if (t === null) return fail('FORBIDDEN', 403);
  const open = memberConsentOpen(env, t);
  //   切替が閉じているときは rec_ai の撤回だけ（勧誘・新しい同意を止める）
  if (!open && items.some(([k, a]) => !(k === 'rec_ai' && a === 'revoked'))) return fail('MEMBER_CONSENT_OFF', 503);
  const s = await readState(env, cid);
  const now = Date.now();
  const stmts = [];
  let nAns = 0;
  for (const [k, a, ver] of items) {
    if (k === 'health') {
      if (a === 'agreed') {
        //   再送：会員が同じ版で同意済みなら何も書かない。紙（版なし）の同意済みは、版つきの会員の記録に置き換える
        if (s.st.health.state === 'agreed' && s.st.health.byMember && s.st.health.current) continue;
        stmts.push(S(`INSERT INTO karte_consent (customer_id, kind, state, changed_at, method, recorded_by)
                      VALUES (?, 'health', 'agreed', ?, 'line', ?)
                      ON CONFLICT(customer_id, kind) DO UPDATE SET state = excluded.state, changed_at = excluded.changed_at,
                        method = excluded.method, recorded_by = excluded.recorded_by`, cid, now, MEMBER_ACTOR));
        stmts.push(S(`INSERT INTO karte_consent_log (customer_id, kind, state, at, method, recorded_by) VALUES (?, 'health', 'agreed', ?, 'line', ?)`, cid, now, MEMBER_ACTOR));
      } else if (s.answeredCur(k)) continue;   // declined の再送
    } else {
      if (a === 'agreed') {
        if (s.recRow && s.recRow.state === 'agreed' && s.recRow.doc_ver === ver) continue;
        stmts.push(S(`INSERT INTO karte_consent_rec (customer_id, state, changed_at, method, recorded_by, doc_ver)
                      VALUES (?, 'agreed', ?, 'line', ?, ?)
                      ON CONFLICT(customer_id) DO UPDATE SET state = excluded.state, changed_at = excluded.changed_at,
                        method = excluded.method, recorded_by = excluded.recorded_by, doc_ver = excluded.doc_ver`, cid, now, MEMBER_ACTOR, ver));
        stmts.push(S(`INSERT INTO karte_consent_log (customer_id, kind, state, at, method, recorded_by) VALUES (?, 'rec_ai', 'agreed', ?, 'line', ?)`, cid, now, MEMBER_ACTOR));
      } else if (a === 'revoked') {
        if (s.recRow && s.recRow.state === 'revoked') continue;   // 再送
        //   ★同意の行が agreed でなければ CONFLICT（同意したことのない人の「撤回」を作らない・関門① 3周目 中2）
        stmts.push(S(`INSERT INTO karte_consent_guard (cstate) SELECT 1 WHERE NOT EXISTS (
                        SELECT 1 FROM karte_consent_rec WHERE customer_id = ? AND state = 'agreed')`, cid));
        stmts.push(S(`UPDATE karte_consent_rec SET state = 'revoked', changed_at = ?, method = 'line', recorded_by = ? WHERE customer_id = ?`, now, MEMBER_ACTOR, cid));
        stmts.push(S(`INSERT INTO karte_consent_log (customer_id, kind, state, at, method, recorded_by) VALUES (?, 'rec_ai', 'revoked', ?, 'line', ?)`, cid, now, MEMBER_ACTOR));
      } else if (s.answeredCur(k)) continue;   // declined の再送
    }
    stmts.push(S(`INSERT INTO karte_consent_answers (customer_id, kind, answer, doc_ver, at) VALUES (?, ?, ?, ?, ?)`, cid, k, a, ver, now));
    nAns++;
  }
  if (nAns) {
    //   回数の守り：直近10分の回答の行（書く予定を含む）が上限を超えるなら書かない。★判定を書き込みと同じ batch の先頭に置く（並行した送信でもすり抜けない・関門② 中）
    stmts.unshift(S(`INSERT INTO karte_consent_guard (crate) SELECT 1 WHERE
                       (SELECT COUNT(*) FROM karte_consent_answers WHERE customer_id = ? AND at >= ?) + ? > ?`,
                    cid, now - CONSENT_LIMITS.WINDOW_MS, nAns, CONSENT_LIMITS.ANSWERS_PER_WINDOW));
    await env.DB.batch(stmts.map((x) => env.DB.prepare(x.sql).bind(...x.args)));
  }
  const s2 = await readState(env, cid);
  return open ? { mode: 'full', state: s2.st, ask: s2.ask } : { mode: 'revoke_only', state: { rec_ai: s2.st.rec_ai }, ask: [] };
}

export const MEMBER_CONSENT_HANDLERS = { m_myConsent: myConsent, m_saveConsent: saveConsent };
export const isMemberAction = (action) => /^m_/.test(String(action || ''));
export const isMemberWrite = (action) => String(action || '') === 'm_saveConsent';
