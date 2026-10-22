// 許可表（remain_d1_allow）の窓口と、試し読み（probe）の窓口（設計21 §2-2・§2-3・I40）
//
// ★入力を厳しく見る・応答とログには会員の下4桁だけ
//   POST 以外は 405／合言葉（未設定 503）／Content-Type は application/json／本文は 4KiB まで／
//   action は完全一致。add＝{ action, customerId: フルID }・remove＝{ action, customer: '*'+下4桁 }・list＝{ action }
// ★add は customers 表に実在する会員だけ
// ★remove は許可表の中で下4桁を解決し、判定と削除を1文で行う（数えてから消すと、その間の add で別人を消せる）

import { requireSecret, mask } from './quota.js';
import { readHome } from './boot.js';
import { VERIFY_CUSTOMER_ID } from '../lib/remain-read-on.js';

const MAX_BODY = 4096;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const SUFFIX_RE = /^\*[A-Za-z0-9]{4}$/;

function res(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function readJson(request, env) {
  if (request.method !== 'POST') return { err: res({ ok: false, code: 'METHOD' }, 405) };
  const deny = requireSecret(request, env);
  if (deny) return { err: deny };
  const ct = String(request.headers.get('content-type') || '');
  if (!/^application\/json\b/i.test(ct)) return { err: res({ ok: false, code: 'CONTENT_TYPE' }, 415) };
  let text;
  try { text = await request.text(); } catch (_) { return { err: res({ ok: false, code: 'BAD_BODY' }, 400) }; }
  if (new TextEncoder().encode(text).byteLength > MAX_BODY) return { err: res({ ok: false, code: 'TOO_LARGE' }, 413) };
  let body;
  try { body = JSON.parse(text); } catch (_) { return { err: res({ ok: false, code: 'BAD_JSON' }, 400) }; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { err: res({ ok: false, code: 'BAD_JSON' }, 400) };
  return { body };
}

const onlyKeys = (b, keys) => Object.keys(b).every((k) => keys.includes(k));

/** POST /quota/remain-allow */
export async function remainAllow(request, env) {
  const { err, body } = await readJson(request, env);
  if (err) return err;
  const action = body.action;
  try {
    if (action === 'add') {
      if (!onlyKeys(body, ['action', 'customerId'])) return res({ ok: false, code: 'BAD_INPUT' }, 400);
      const cid = String(body.customerId || '');
      if (!ID_RE.test(cid)) return res({ ok: false, code: 'BAD_INPUT' }, 400);
      const c = await env.DB.prepare('SELECT 1 AS x FROM customers WHERE customer_id = ?').bind(cid).first();
      if (!c) return res({ ok: false, code: 'NO_CUSTOMER' }, 404);
      const r = await env.DB.prepare('INSERT OR IGNORE INTO remain_d1_allow (customer_id, added_at) VALUES (?, ?)')
        .bind(cid, Date.now()).run();
      return res({ ok: true, action, customer: mask(cid), changed: Number((r.meta && r.meta.changes) || 0) });
    }
    if (action === 'remove') {
      if (!onlyKeys(body, ['action', 'customer'])) return res({ ok: false, code: 'BAD_INPUT' }, 400);
      const sfx = String(body.customer || '');
      if (!SUFFIX_RE.test(sfx)) return res({ ok: false, code: 'BAD_INPUT' }, 400);
      const four = sfx.slice(1);   // ★bind するのは * を除いた4文字
      const r = await env.DB.prepare(
        `DELETE FROM remain_d1_allow
          WHERE customer_id = (SELECT MAX(customer_id) FROM remain_d1_allow
                                WHERE substr(customer_id, -4) = ? HAVING COUNT(*) = 1)`
      ).bind(four).run();
      const changed = Number((r.meta && r.meta.changes) || 0);
      if (changed === 1) return res({ ok: true, action, customer: sfx, changed: 1 });
      let n;
      try {
        const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM remain_d1_allow WHERE substr(customer_id, -4) = ?').bind(four).first();
        n = Number((c && c.n) || 0);
      } catch (_) { return res({ ok: false, code: 'READ_FAILED' }, 503); }
      if (n === 0) return res({ ok: false, code: 'NOT_FOUND', customer: sfx }, 404);
      if (n === 1) return res({ ok: false, code: 'RETRY', customer: sfx }, 409);   // 消してはいない
      return res({ ok: false, code: 'AMBIGUOUS', customer: sfx }, 409);
    }
    if (action === 'list') {
      if (!onlyKeys(body, ['action'])) return res({ ok: false, code: 'BAD_INPUT' }, 400);
      const r = await env.DB.prepare('SELECT customer_id FROM remain_d1_allow ORDER BY customer_id').all();
      const ids = (r.results || []).map((x) => mask(x.customer_id));
      return res({ ok: true, count: ids.length, customers: ids });
    }
    return res({ ok: false, code: 'BAD_ACTION' }, 400);
  } catch (_) {
    return res({ ok: false, code: 'DB_FAILED' }, 503);   // ★例外の文（ID が入りうる）を返さない
  }
}

/** POST /quota/remain-probe（検証用の会員だけ） */
export async function remainProbe(request, env) {
  const { err, body } = await readJson(request, env);
  if (err) return err;
  if (!onlyKeys(body, ['customerId'])) return res({ ok: false, code: 'BAD_INPUT' }, 400);
  if (String(body.customerId || '') !== VERIFY_CUSTOMER_ID) return res({ ok: false, code: 'NOT_ALLOWED' }, 403);
  try {
    const diag = {};
    //   ★本番と同じ readHome を1回だけ通す。数えない（入口の統計に混ぜない）
    const home = await readHome(env, VERIFY_CUSTOMER_ID, undefined, { diag, noCount: true });
    const r = diag.result || { selected: false, source: 'copy_unchanged', status: 'mode_off', monthMatch: true };
    const tc = home && home.transferCredits;
    return res({
      ok: true, customer: mask(VERIFY_CUSTOMER_ID),
      selected: r.selected, source: r.source, status: r.status, monthMatch: r.monthMatch,
      remainSource: home ? (home.remainSource || null) : null,
      remaining: home ? (home.remaining == null ? null : home.remaining) : null,
      ticketRemaining: home ? (home.ticketRemaining == null ? null : home.ticketRemaining) : null,
      monthlyRemaining: home ? (home.monthlyRemaining == null ? null : home.monthlyRemaining) : null,
      transferAvailable: (tc && typeof tc.available === 'number') ? tc.available : null,
    });
  } catch (_) {
    return res({ ok: false, code: 'PROBE_FAILED' }, 503);
  }
}

export const _forTest = { MAX_BODY, SUFFIX_RE };
