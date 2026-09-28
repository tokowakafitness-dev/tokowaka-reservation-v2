// LINEのID Tokenを、Worker内で署名検証する。
//
// なぜ自前で検証するか：
//   LINEの verify エンドポイントを叩くと、1リクエストごとに外部通信が1往復（50〜150ms）増える。
//   毎回それを払うと「コンマ単位」に届かない。公開鍵(JWKS)をKVに寝かせて
//   WebCryptoで検証すれば、通信ゼロ・1ms未満で済む。
//
// 検証する項目（どれか欠けたら通さない）：
//   署名 / iss / aud（自分のチャネル） / exp（期限） / sub（LINEのユーザーID）

const ISSUER = 'https://access.line.me';
const JWKS_URL = 'https://api.line.me/oauth2/v2.1/certs';
const JWKS_KV_KEY = 'jwks:line';
const JWKS_TTL_SEC = 60 * 60 * 12;   // 12時間。鍵の入れ替えは頻繁ではない

function b64urlToBytes(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlToJson(s) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

async function loadJwks(env) {
  try {
    const cached = await env.KV.get(JWKS_KV_KEY, 'json');
    if (cached && Array.isArray(cached.keys)) return cached;
  } catch (_) { /* KVが読めなくても取りに行けばよい */ }
  const res = await fetch(JWKS_URL, { cf: { cacheTtl: JWKS_TTL_SEC, cacheEverything: true } });
  if (!res.ok) throw new Error('JWKS_FETCH_FAILED');
  const jwks = await res.json();
  try { await env.KV.put(JWKS_KV_KEY, JSON.stringify(jwks), { expirationTtl: JWKS_TTL_SEC }); } catch (_) {}
  return jwks;
}

async function importKey(jwk, alg) {
  if (alg === 'ES256') {
    return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  }
  if (alg === 'RS256') {
    return crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  }
  throw new Error('UNSUPPORTED_ALG');
}

function verifyParams(alg) {
  return alg === 'ES256'
    ? { name: 'ECDSA', hash: 'SHA-256' }
    : { name: 'RSASSA-PKCS1-v1_5' };
}

/**
 * @returns {Promise<{ok:true, lineUserId:string, name:string, claims:object}|{ok:false, code:string}>}
 */
export async function verifyIdToken(idToken, env) {
  if (!idToken || typeof idToken !== 'string') return { ok: false, code: 'NO_TOKEN' };
  const parts = idToken.split('.');
  if (parts.length !== 3) return { ok: false, code: 'MALFORMED' };

  let header, payload;
  try {
    header = b64urlToJson(parts[0]);
    payload = b64urlToJson(parts[1]);
  } catch (_) { return { ok: false, code: 'MALFORMED' }; }

  const alg = String(header.alg || '');
  if (alg !== 'ES256' && alg !== 'RS256') return { ok: false, code: 'UNSUPPORTED_ALG' };

  // 署名の検証
  let jwks;
  try { jwks = await loadJwks(env); } catch (_) { return { ok: false, code: 'JWKS_UNAVAILABLE' }; }
  const jwk = (jwks.keys || []).find((k) => k.kid === header.kid && (!k.alg || k.alg === alg));
  if (!jwk) return { ok: false, code: 'KEY_NOT_FOUND' };

  let valid = false;
  try {
    const key = await importKey(jwk, alg);
    const data = new TextEncoder().encode(parts[0] + '.' + parts[1]);
    valid = await crypto.subtle.verify(verifyParams(alg), key, b64urlToBytes(parts[2]), data);
  } catch (_) { return { ok: false, code: 'VERIFY_ERROR' }; }
  if (!valid) return { ok: false, code: 'BAD_SIGNATURE' };

  // 中身の検証
  if (payload.iss !== ISSUER) return { ok: false, code: 'BAD_ISSUER' };

  const expectedAud = String(env.LINE_CHANNEL_ID || '');
  if (!expectedAud) return { ok: false, code: 'CHANNEL_ID_NOT_SET' };
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.map(String).includes(expectedAud)) return { ok: false, code: 'BAD_AUDIENCE' };

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= now) return { ok: false, code: 'EXPIRED' };
  // 発行時刻が未来すぎるものは弾く（時計ずれを60秒だけ許容）
  if (typeof payload.iat === 'number' && payload.iat > now + 60) return { ok: false, code: 'BAD_IAT' };

  const sub = String(payload.sub || '');
  if (!sub) return { ok: false, code: 'NO_SUBJECT' };

  return { ok: true, lineUserId: sub, name: String(payload.name || ''), claims: payload };
}

/**
 * LINEのユーザーIDから役割を確定する。ここだけが役割を決める。
 *   trainers に載っていれば trainer / owner、customers に載っていれば customer、
 *   どちらでもなければ guest（会員登録前）。
 */
export async function resolveRole(lineUserId, env) {
  const tr = await env.DB.prepare(
    'SELECT trainer_id, name, role FROM trainers WHERE line_user_id = ? AND active = 1'
  ).bind(lineUserId).first();
  if (tr) {
    const role = tr.role === 'owner' ? 'owner' : 'trainer';
    return { role, trainerId: tr.trainer_id, name: tr.name, customerId: null };
  }
  const cu = await env.DB.prepare(
    'SELECT customer_id, name, default_trainer_id FROM customers WHERE line_user_id = ?'
  ).bind(lineUserId).first();
  if (cu) {
    return { role: 'customer', trainerId: cu.default_trainer_id || null, name: cu.name, customerId: cu.customer_id };
  }
  return { role: 'guest', trainerId: null, name: '', customerId: null };
}
