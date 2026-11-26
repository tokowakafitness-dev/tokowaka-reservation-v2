// カルテの検査の共通の土台（設計62 段2・段3・2026-11-26）：本物の SQLite に schema.sql と全 migration を流し、入口（index.js）から通す
//   ★*.test.js ではない＝run-all は直接走らせない（使う検査から読む）
//   ★会員・トレーナーの名前・ID は架空の値だけ
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const W = join(HERE, '..');
export const ORIGIN = 'https://reservation.tokowaka-gym.com';
const CHANNEL = '1234567890';
const MIG_DIR = join(W, 'migrations');

export function makeDb(upto) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(W, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(MIG_DIR).filter((x) => x.endsWith('.sql')).sort()) {
    if (upto && f >= upto) continue;
    try { db.exec(readFileSync(join(MIG_DIR, f), 'utf8')); } catch (e) { if (!/duplicate column/.test(e.message)) throw e; }
  }
  return db;
}
//   env._hook(q, args) → null（そのまま）／[[q, args], …]（その文の代わりに流す。空配列＝落とす）。env._failRe：当たる文を失敗させる
export function makeEnv(upto) {
  const db = makeDb(upto);
  const env = { LINE_CHANNEL_ID: CHANNEL, _db: db, _kv: {}, _hook: null };
  const run1 = (q, args, how) => {
    const st = db.prepare(q);
    if (how === 'first') { const r = st.get(...args); return r === undefined ? null : Object.assign({}, r); }
    if (how === 'all') return { results: st.all(...args).map((r) => Object.assign({}, r)) };
    const r = st.run(...args);
    return { meta: { changes: Number(r.changes) } };
  };
  const exec = (q, args, how) => {
    if (env._hook && how === 'run') {
      const rep = env._hook(q, args);
      if (rep) { let last = { meta: { changes: 0 } }; for (const [q2, a2] of rep) last = run1(q2, a2, 'run'); return last; }
    }
    return run1(q, args, how);
  };
  env.KV = { async get(k, t) { const v = env._kv[k]; return v == null ? null : (t === 'json' ? JSON.parse(v) : v); }, async put(k, v) { env._kv[k] = v; } };
  env.DB = {
    prepare(q) {
      const boom = env._failRe && env._failRe.test(q);
      if (boom) return { _q: q, _args: [], bind() { return this; }, async run() { throw new Error('D1_ERROR'); }, async first() { throw new Error('D1_ERROR'); }, async all() { throw new Error('D1_ERROR'); } };
      return { _q: q, _args: [], bind(...a) { this._args = a; return this; },
               async run() { return exec(q, this._args, 'run'); }, async first() { return exec(q, this._args, 'first'); },
               async all() { return exec(q, this._args, 'all'); } };
    },
    async batch(stmts) {
      db.exec('BEGIN');
      try { const out = stmts.map((s) => exec(s._q, s._args, 'run')); db.exec('COMMIT'); return out; }
      catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
    },
  };
  return env;
}

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pubJwk = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'k1', alg: 'ES256' };
export async function token(sub, ageS = 0) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: 'ES256', kid: 'k1', typ: 'JWT' }));
  const pl = b64u(JSON.stringify({ iss: 'https://access.line.me', aud: CHANNEL, sub, exp: now + 3600, iat: now - ageS }));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(h + '.' + pl));
  return h + '.' + pl + '.' + b64u(sig);
}

/** 見本の会員・トレーナーを入れた env と、入口から呼ぶ call を返す */
export function setup() {
  const env = makeEnv();
  env._kv['jwks:line'] = JSON.stringify({ keys: [pubJwk] });
  const d = env._db;
  d.exec(`INSERT INTO trainers (trainer_id, name, line_user_id, role, active) VALUES
    ('t1', '見本一郎', 'U_t1', 'trainer', 1), ('t2', '見本二郎', 'U_t2', 'trainer', 1), ('OWN', '見本店主', 'U_OWN', 'owner', 1)`);
  d.exec(`INSERT INTO customers (customer_id, name, line_user_id, default_trainer_id, created_at, updated_at) VALUES
    ('C1', '見本会員一', 'U_c1', 't1', 1, 1), ('C2', '見本会員二', NULL, 't2', 1, 1), ('C3', '見本会員三', NULL, NULL, 1, 1)`);
  const fresh = () => d.exec(`INSERT INTO sync_state (key, synced_at, rows, ok) VALUES ('customers', ${Date.now()}, 3, 1), ('trainers', ${Date.now()}, 3, 1), ('reservations', ${Date.now()}, 0, 1)
    ON CONFLICT(key) DO UPDATE SET synced_at = excluded.synced_at`);
  fresh();
  let seq = 0;
  const crid = () => 'xreq-' + (++seq).toString().padStart(6, '0');
  async function call(as, action, body = {}, opt = {}) {
    const payload = JSON.stringify({ action, idToken: await token(as), ...body });
    const res = await worker.fetch(new Request('https://w.example/', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: opt.origin || ORIGIN }, body: payload }), env, { waitUntil() {} });
    let j = {};
    try { j = await res.json(); } catch (_) {}
    return { status: res.status, ...j };
  }
  const q1 = (sql, ...a) => { const r = d.prepare(sql).get(...a); return r ? Object.assign({}, r) : null; };
  const qn = (sql, ...a) => Number(q1(sql, ...a).n);
  const qa = (sql, ...a) => d.prepare(sql).all(...a).map((r) => Object.assign({}, r));
  return { env, d, call, crid, fresh, q1, qn, qa };
}
export const jstDay = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
