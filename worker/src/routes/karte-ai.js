// 録音の文字起こしを AI でカルテの各項目へ振り分けた下書きにする（設計39・I76）・2026-11-12
//
//   入口（index.js）で済んでいること：本文の大きさ（このパスだけ128KB）・パスと action の組・Origin・ID トークン・iat 1時間・
//     役割の鮮度・許可表（trainer/owner）・停止スイッチ KARTE
//
//   ここで守ること（I76）
//     ① 切替（KARTE_AI_DRAFT・厳密一致・既定 off）と鍵（ANTHROPIC_API_KEY）が無ければ外へ送らない・数えない
//     ② 共有の範囲（canSeeKarteShared）③ 1日の回数を API の前に数える（changes===1 だけ成功）
//     ④ 送る前に氏名・連絡先を伏せる（known も）⑤ 出力を検証（数字は根拠の抜き出しの中に在るものだけ・健康語は caution へ）
//     ⑥ ★文字起こし・伏せた文・Anthropic の生の応答を D1・KV・console・エラー文・応答に残さない。
//        返すのは検証・再マスクした draft だけ（当該の HTTP 応答は no-store）。記録は回数・時間・文字数・結果・版の印だけ
//     ⑦ ★全ての例外をここで捕まえて固定のコードにする（index.js の共通の catch へ出さない＝e.message に本文が乗らない）
//
//   ★API は生の HTTP（Worker は依存ゼロ・デプロイのワークフローは wrangler しか入れないため SDK を入れられない）。
//     書き方は claude-api の資料どおり：POST /v1/messages・x-api-key・anthropic-version 2026-10-21・
//     構造化出力は output_config.format（json_schema）。強制の tool_choice は Sonnet 5.5 で 400 のため使わない

import { aiDraftOn, canSeeKarteShared, logAccess } from './karte.js';
import { normalizeExerciseName } from '../lib/karte-exercises.js';

export const AI_BUILD = '2026-11-12a 設計39 文字起こしの AI 下書き（関門①通過）';

export const AI_LIMITS = {
  BODY_BYTES: 128 * 1024,   // このパス（/karte/ai-draft）だけ。3万字×3バイト＋余裕
  TEXT_CHARS: 30000,
  KNOWN: 600,
  TIMEOUT_MS: 60000,
  MAX_TOKENS: 8000,
  EXERCISES: 20,
  SETS_PER_EXERCISE: 10,
  TOTAL_SETS: 60,
  TEXT: 200,
  MEMBER_MESSAGE: 400,
  LIST: 20,
  TODO: 3,
  EVIDENCE: 80,
  DAILY_DEFAULT: 30,
};
export const AI_PATH = '/karte/ai-draft';
const MODELS = ['claude-sonnet-5-5', 'claude-haiku-5-5'];

//   ★画面（liff/karte.js）の MEMO_HEALTH と同じ式（検査 karte-ai.test.js G で一致を固定）
export const AI_HEALTH = /痛|痺|しびれ|怪我|ケガ|けが|診断|薬|手術|違和感|腫|骨折|捻|ヘルニア|病院|通院|体調|血圧|めまい|熱|妊娠|アレルギー|生理|持病|リハビリ|吐き気|頭痛|不調|医師|医者|治療|炎症|つった|つる/;
const PII_WEAK = /様|さん|氏|くん|君|ちゃん|回目|初回|体験/;
const HONORIFIC = '(?:さん|様|くん|ちゃん|氏|君)';
const BODYWEIGHT = /自重|じじゅう|重りなし|ウェイトなし/;
//   区切りは空白（改行を含めない）・ハイフン・括弧を3文字まで（「090 - 1234」）。+81 の後の (0) も読む（関門② 3周目）
const PHONE_SEP = '[ \\t\\u3000\\-‐－()（）]{0,3}';
const PHONE_SP = '[ \\t\\u3000\\-]{0,2}';
export const PHONE_RE = new RegExp('(?<![\\d+])(?:\\+81' + PHONE_SP + '(?:\\(0\\)|（0）)?' + PHONE_SP + '\\d{1,4}|\\(?0\\d{1,4}\\)?)' + PHONE_SEP + '\\d{1,4}' + PHONE_SEP + '\\d{3,4}(?!\\d)', 'g');

export function aiModel(env) {
  const m = String((env && env.KARTE_AI_MODEL) || '');
  return MODELS.indexOf(m) >= 0 ? m : MODELS[0];
}
export function aiDailyMax(env) {
  const v = String((env && env.KARTE_AI_DAILY_MAX) || '');
  if (!/^\d{1,3}$/.test(v)) return AI_LIMITS.DAILY_DEFAULT;
  const n = Number(v);
  return n >= 1 && n <= 500 ? n : AI_LIMITS.DAILY_DEFAULT;
}
function jstDay(nowMs) {
  const d = new Date(Number(nowMs) + 9 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
const nfkc = (s) => String(s == null ? '' : s).normalize('NFKC');
const squash = (s) => nfkc(s).replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------- 氏名を伏せる（§3-5）
const kata2hira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
const hira2kata = (s) => s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
function nameForms(name) {
  const n = nfkc(name).trim();
  if (!n) return { long: [], one: [] };
  const parts = n.split(/\s+/).filter(Boolean);
  const base = [n, parts.join('')].concat(parts.filter((p) => p.length >= 2));
  const one = parts.filter((p) => p.length === 1);
  const long = [];
  for (const b of base) for (const v of [b, kata2hira(b), hira2kata(b)]) if (v && long.indexOf(v) < 0) long.push(v);
  const ones = [];
  for (const o of one) for (const v of [o, kata2hira(o), hira2kata(o)]) if (ones.indexOf(v) < 0) ones.push(v);
  return { long, one: ones };
}
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** people: [{ name, tag }]。返り値は文字列を受け取って伏せた文字列を返す関数 */
export function makeMasker(people) {
  const long = [], one = [];
  for (const p of people || []) {
    const f = nameForms(p.name);
    for (const v of f.long) long.push({ v, tag: p.tag });
    for (const v of f.one) one.push({ v, tag: p.tag });
  }
  long.sort((a, b) => b.v.length - a.v.length);
  return function mask(s) {
    let t = nfkc(s);
    for (const x of long) t = t.split(x.v).join(x.tag);
    for (const x of one) t = t.replace(new RegExp(reEsc(x.v) + HONORIFIC, 'g'), x.tag);
    //   一般の「漢字・カタカナ1〜6字＋敬称」（店の外の人・家族）
    t = t.replace(new RegExp('[一-鿿々〆ヵヶァ-ヺー]{1,6}' + HONORIFIC, 'g'), '〔人〕');
    //   ひらがなの名前＋敬称（関門② 高2）。2〜6字。「ちゃんと」は名前でない（ちゃん＋と は外す）。伏せすぎる向きに倒す
    t = t.replace(/[ぁ-ゖ]{2,6}(?:さん|様|くん|ちゃん(?!と)|氏|君)/g, '〔人〕');
    //   置換語の後ろの敬称は落とす（画面の名前の印で全部が「提案なし」にならないように）
    t = t.replace(new RegExp('(〔(?:会員|トレーナー|人)〕)' + HONORIFIC, 'g'), '$1');
    t = t.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '〔メール〕');
    //   電話：3つの数字のまとまり（市外局番か +81・中・末尾）。間は空白（改行は含めない）・ハイフン・括弧だけ。数字が10〜12桁（関門② 高2）
    //   ★まとまりの数を固定する＝電話の後ろの改行・空白の先の数字（55キロ等）を飲み込まない（2周目の指摘）
    t = t.replace(PHONE_RE, (m) => { const n = m.replace(/\(0\)|（0）/g, '').replace(/\D/g, '').length; return n >= 10 && n <= 12 ? '〔番号〕' : m; });
    return t;
  };
}

// ---------------------------------------------------------------- 出力の形（§3-6）
const STR = { type: 'string' };
export const AI_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['exercises', 'coaching', 'hearing', 'caution', 'member_message', 'member_todo'],
  properties: {
    exercises: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'heard', 'note', 'sets'], properties: {
      name: STR, heard: STR, note: STR,
      sets: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['weight_kg', 'reps', 'evidence', 'note'], properties: {
        weight_kg: { anyOf: [{ type: 'number' }, { type: 'null' }] }, reps: { type: 'integer' }, evidence: STR, note: STR } } } } } },
    coaching: { type: 'array', items: STR },
    hearing: { type: 'array', items: STR },
    caution: { type: 'array', items: STR },
    member_message: STR,
    member_todo: { type: 'array', items: STR },
  },
};
export const AI_SYSTEM = [
  'あなたはパーソナルトレーニングジムのカルテの下書きを作る係です。<transcript> はトレーナーとお客様のセッションの録音を文字に起こしたもの（話し言葉・聞き違いを含む）です。',
  '決めた項目だけを抜き出し、JSON で返してください。',
  '- exercises：行った種目。name は <exercises> の一覧の名前に寄せる（一覧に無い・自信が無いときは聞こえたままの名前）。heard は聞こえた言葉。',
  '  sets は1セットずつ。weight_kg（キロ。重りが無いと話したときだけ null）・reps（回数）。**数字は文字起こしに出てきたものだけ。推測で補わない。** 予告（いきます）か実施か分からないときは note に書く。',
  '  evidence には、そのセットの重さと回数を話した部分を文字起こしから**一字一句そのまま**80字以内で抜き出す。抜き出せないセットは出力しない。',
  '- coaching：指導の要点（フォーム・意識・次回の課題）。1件1文。',
  '- hearing：生活・食事・睡眠・仕事・目標・運動歴。',
  '- caution：痛み・怪我・診断・服薬・体調など体の状態。体の状態は caution にだけ書き、他の項目に書かない。',
  '- member_message：お客様に見せてよい今日の要点・励まし（400字以内・無ければ空文字）。member_todo：次回までにお客様にしてほしいこと（3件まで・各60字以内）。',
  '雑談・政治・宗教・思想信条・性的指向・家族の事情・第三者の話・上のどれにも入らないものは出力しないでください。',
  '人の名前は出力しないでください（〔会員〕〔トレーナー〕〔人〕などの置換語も出力に書かず「お客様」と書く）。',
].join('\n');

// ---------------------------------------------------------------- 出力の検証（§3-7）
//   ★丸めない：0.1 刻みであることを整数化して確かめ、数値で完全一致させる
const tenthOf = (w) => { const x = Number(w) * 10; const r = Math.round(x); return Number.isFinite(x) && Math.abs(x - r) < 1e-6 ? r : null; };
function tokensOf(ev) {
  const out = [];
  for (const m of ev.matchAll(/(?<![0-9.])(\d+(?:\.\d+)?)(?![0-9.])/g)) out.push(m[1]);
  return out;
}
/** 1セットの根拠を確かめる。通れば { w, r, evidence }（evidence は伏せた文字起こしから切り出したもの）、通らなければ null */
export function verifySet(st, maskedSquashed) {
  const w = st.weight_kg, r = st.reps;
  if (!(Number.isInteger(r) && r >= 1 && r <= 100)) return null;
  let wt = null;
  if (w !== null) {
    if (typeof w !== 'number' || !(w > 0 && w <= 500)) return null;
    wt = tenthOf(w);
    if (wt == null) return null;
  }
  const ev = squash(st.evidence);
  if (!ev || ev.length > AI_LIMITS.EVIDENCE) return null;
  const at = maskedSquashed.indexOf(ev);
  if (at < 0) return null;
  const evidence = maskedSquashed.slice(at, at + ev.length);   // 照合したもの＝表示するもの
  const toks = tokensOf(evidence);
  const repsHits = toks.filter((t) => /^\d+$/.test(t) && Number(t) === r).length;
  if (wt === null) {
    if (!BODYWEIGHT.test(evidence) || repsHits < 1) return null;
    return { w: null, r, evidence };
  }
  const wHits = toks.filter((t) => /^\d+(?:\.\d)?$/.test(t) && Math.round(Number(t) * 10) === wt).length;
  if (wt === r * 10) { if (wHits < 2) return null; }   // 重さと回数が同じ値＝その値のトークンが2つ以上
  else if (wHits < 1 || repsHits < 1) return null;
  return { w: wt / 10, r, evidence };
}

class BadOutput extends Error {}
const bad = () => { throw new BadOutput('AI_BAD_OUTPUT'); };
function strList(v, maxN, maxLen) {
  if (!Array.isArray(v)) bad();
  const out = [];
  for (const x of v) {
    if (typeof x !== 'string') bad();
    const t = squash(x);
    if (!t) continue;
    if (t.length > maxLen) bad();
    out.push(t);
  }
  if (out.length > maxN) bad();
  return out;
}
function strOne(v, maxLen) {
  if (typeof v !== 'string') bad();
  const t = squash(v);
  if (t.length > maxLen) bad();
  return t;
}

/** AI の JSON → 検証した draft。壊れていれば BadOutput を投げる（黙って切らない） */
export function validateDraft(raw, maskedSquashed, mask) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad();
  const L = AI_LIMITS;
  //   ① 型と件数
  if (!Array.isArray(raw.exercises) || raw.exercises.length > L.EXERCISES) bad();
  let total = 0;
  const exs = raw.exercises.map((e) => {
    if (!e || typeof e !== 'object' || !Array.isArray(e.sets)) bad();
    if (e.sets.length > L.SETS_PER_EXERCISE) bad();
    total += e.sets.length;
    let name = '';
    //   ★種目名は NFKC しない（画面の autoKnown との完全一致を崩さない）。空白だけそろえる
    try { name = normalizeExerciseName(typeof e.name === 'string' ? e.name.replace(/\s+/g, ' ') : ''); } catch (_) { name = ''; }
    const heard = typeof e.heard === 'string' && squash(e.heard).length <= 50 ? squash(e.heard) : '';
    const note = strOne(e.note == null ? '' : e.note, L.TEXT);
    const sets = e.sets.map((st) => {
      if (!st || typeof st !== 'object') bad();
      return { raw: st, note: strOne(st.note == null ? '' : st.note, L.TEXT) };
    });
    return { name, heard, note, sets };
  });
  if (total > L.TOTAL_SETS) bad();
  const coaching = strList(raw.coaching, L.LIST, L.TEXT);
  const hearing = strList(raw.hearing, L.LIST, L.TEXT);
  let caution = strList(raw.caution, L.LIST, L.TEXT);
  let memberMessage = strOne(raw.member_message, L.MEMBER_MESSAGE);
  let todo = strList(raw.member_todo, L.TODO, L.TEXT);

  //   ②〜⑤ 健康語：元の場所から消して caution へ（note は「種目名：note」）・同じ文は1つ
  const moved = [];
  const pick = (arr) => arr.filter((t) => { if (AI_HEALTH.test(t)) { moved.push(t); return false; } return true; });
  const coaching2 = pick(coaching), hearing2 = pick(hearing);
  todo = pick(todo);
  if (memberMessage && AI_HEALTH.test(memberMessage)) { moved.push(memberMessage); memberMessage = ''; }
  for (const e of exs) {
    const label = e.name || e.heard || '種目';
    if (e.note && AI_HEALTH.test(e.note)) { moved.push(label + '：' + e.note); e.note = ''; }
    for (const s of e.sets) if (s.note && AI_HEALTH.test(s.note)) { moved.push(label + '：' + s.note); s.note = ''; }
  }
  //   ★根拠の抜き出し（evidence）に健康語がある＝その文は caution へ移し、セットは根拠を出せないので確かめられないセットにする（関門② 高1）
  for (const e of exs) {
    const label = e.name || e.heard || '種目';
    for (const s of e.sets) {
      const ev = typeof s.raw.evidence === 'string' ? squash(s.raw.evidence) : '';
      if (ev && AI_HEALTH.test(ev)) { moved.push(label + '：' + ev.slice(0, L.EVIDENCE)); s.healthEv = true; }
    }
  }
  for (const t of moved) if (caution.indexOf(t) < 0) caution.push(t);
  //   ⑥ 移した後の上限（切らない）
  if (caution.length > L.LIST) bad();

  //   数字の根拠
  let nEx = 0, nUnv = 0;
  const exercises = exs.map((e) => {
    const sets = [], unverified = [];
    for (const s of e.sets) {
      const v = e.name && !s.healthEv ? verifySet(s.raw, maskedSquashed) : null;
      if (v) sets.push({ w: v.w, r: v.r, evidence: mask(v.evidence), note: mask(s.note) });
      else {
        const w = s.raw.weight_kg, r = s.raw.reps;
        unverified.push({
          w: typeof w === 'number' && Number.isFinite(w) ? w : null,
          r: Number.isInteger(r) ? r : null,
          evidence: !s.healthEv && typeof s.raw.evidence === 'string' ? mask(squash(s.raw.evidence)).slice(0, L.EVIDENCE) : '',
          note: mask(s.note),
        });
      }
    }
    if (e.name || e.heard) nEx++;
    nUnv += unverified.length;
    return { name: mask(e.name), heard: mask(e.heard), note: mask(e.note), sets, unverified };
  });
  return {
    draft: {
      exercises,
      coaching: coaching2.map(mask), hearing: hearing2.map(mask), caution: caution.map(mask),
      member_message: mask(memberMessage), member_todo: todo.map(mask),
    },
    nEx, nUnv,
  };
}

// ---------------------------------------------------------------- 記録（中身なし・best effort）
const ACCESS_OF = { ok: 'ok', off: 'denied', no_key: 'denied', daily_limit: 'denied', too_long: 'denied', bad_request: 'denied', not_found: 'not_found' };
async function record(env, who, cid, row) {
  try {
    await env.DB.prepare(
      `INSERT INTO karte_ai_log (at, trainer_id, model, chars_in, ms, result, in_tokens, out_tokens, n_ex, n_unverified, build)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(Date.now(), String((who && who.trainerId) || ''), row.model || null, row.chars == null ? null : row.chars, row.ms == null ? null : row.ms,
           row.result, row.inTok == null ? null : row.inTok, row.outTok == null ? null : row.outTok,
           row.nEx == null ? null : row.nEx, row.nUnv == null ? null : row.nUnv, AI_BUILD).run();
  } catch (_) {
    try { console.error('[karte-ai] log write failed', row.result); } catch (_) {}
  }
  await logAccess(env, who, cid || null, 'ai_draft', 'k_aiDraft', ACCESS_OF[row.result] || 'error');
}
const fail = (code, status, detail) => ({ _error: code, _status: status, detail });

// ---------------------------------------------------------------- 窓口
const KEYS = ['action', 'idToken', 'clientReqId', 'customerId', 'text', 'known'];
async function inner(c, st) {
  const { env, who, body } = c;
  st.model = aiModel(env);
  //   ① 切替・鍵（外へ送らない・数えない）
  if (!aiDraftOn(env, who)) { st.result = 'off'; return fail('AI_NOT_CONFIGURED', 503, 'OFF'); }
  if (!env.ANTHROPIC_API_KEY) { st.result = 'no_key'; return fail('AI_NOT_CONFIGURED', 503, 'NO_KEY'); }
  //   入力の検査
  for (const k of Object.keys(body)) if (KEYS.indexOf(k) < 0) { st.result = 'bad_request'; return fail('BAD_REQUEST', 400, 'UNKNOWN_KEY'); }
  const cid = String(body.customerId || '');
  st.cid = cid;
  if (typeof body.text !== 'string') { st.result = 'bad_request'; return fail('BAD_REQUEST', 400, 'text'); }
  const text = body.text.trim();
  st.chars = text.length;
  if (!text) { st.result = 'bad_request'; return fail('BAD_REQUEST', 400, 'text'); }
  if (text.length > AI_LIMITS.TEXT_CHARS) { st.result = 'too_long'; return fail('AI_TOO_LONG', 413); }
  if (!Array.isArray(body.known) || body.known.length > AI_LIMITS.KNOWN) { st.result = 'bad_request'; return fail('BAD_REQUEST', 400, 'known'); }
  let known;
  try { known = body.known.map((x) => normalizeExerciseName(typeof x === 'string' ? x : null)); }
  catch (_) { st.result = 'bad_request'; return fail('BAD_REQUEST', 400, 'known'); }
  //   ② 共有の範囲
  if (!cid || !(await canSeeKarteShared(env, who, cid))) { st.result = 'not_found'; return fail('NOT_FOUND', 404); }
  //   ③ 1日の回数（API の前・失敗しても戻さない）。changes===1 だけが成功
  let changes = null;
  try {
    const r = await env.DB.prepare(
      `INSERT INTO karte_ai_usage (day, n) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET n = n + 1 WHERE n < ?`
    ).bind(jstDay(Date.now()), aiDailyMax(env)).run();
    changes = r && r.meta ? r.meta.changes : null;
  } catch (_) { changes = null; }
  if (changes === 0) { st.result = 'daily_limit'; return fail('AI_DAILY_LIMIT', 429); }
  if (changes !== 1) { st.result = 'unavailable'; return fail('AI_UNAVAILABLE', 503); }
  //   ④ 氏名を伏せる
  const people = [];
  const cu = await env.DB.prepare('SELECT name, kana FROM customers WHERE customer_id = ?').bind(cid).first();
  if (cu) { people.push({ name: cu.name, tag: '〔会員〕' }); if (cu.kana) people.push({ name: cu.kana, tag: '〔会員〕' }); }
  const tr = await env.DB.prepare('SELECT name, name_en FROM trainers').all();
  for (const t of (tr.results || [])) {
    if (t && t.name) people.push({ name: t.name, tag: '〔トレーナー〕' });
    if (t && t.name_en) people.push({ name: t.name_en, tag: '〔トレーナー〕' });   // ★トレーナーの読み（かな）は表に無い＝残る危険（設計39 §3-5）
  }
  const mask = makeMasker(people);
  const masked = mask(text);
  const maskedSquashed = squash(masked);
  const knownSafe = known.filter((n) => !PII_WEAK.test(n) && mask(n) === nfkc(n));
  //   ⑤ API（60秒で打ち切り・再試行なし）
  const req = {
    model: st.model,
    max_tokens: AI_LIMITS.MAX_TOKENS,
    system: AI_SYSTEM,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: AI_SCHEMA } },
    messages: [{ role: 'user', content: '<exercises>\n' + knownSafe.join('\n') + '\n</exercises>\n\n<transcript>\n' + masked + '\n</transcript>' }],
  };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), AI_LIMITS.TIMEOUT_MS);
  const t0 = Date.now();
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': String(env.ANTHROPIC_API_KEY), 'anthropic-version': '2026-10-21' },
      body: JSON.stringify(req),
      signal: ac.signal,
    });
  } catch (e) {
    st.ms = Date.now() - t0;
    if (e && e.name === 'AbortError') { st.result = 'timeout'; return fail('AI_TIMEOUT', 504); }
    st.result = 'http_error'; return fail('AI_HTTP', 502, 'NETWORK');
  } finally { clearTimeout(timer); }
  let j = null;
  try { j = await res.json(); } catch (_) { j = null; }
  st.ms = Date.now() - t0;
  if (res.status !== 200) { st.result = 'http_error'; return fail('AI_HTTP', 502, String(res.status)); }
  if (!j || typeof j !== 'object') { st.result = 'bad_output'; return fail('AI_BAD_OUTPUT', 502); }
  if (j.usage) { st.inTok = Number(j.usage.input_tokens) || null; st.outTok = Number(j.usage.output_tokens) || null; }
  if (j.stop_reason === 'refusal') { st.result = 'refused'; return fail('AI_REFUSED', 502); }
  if (j.stop_reason === 'max_tokens') { st.result = 'truncated'; return fail('AI_TRUNCATED', 502); }
  let parsed;
  try {
    const txt = (Array.isArray(j.content) ? j.content : []).filter((b) => b && b.type === 'text').map((b) => String(b.text || '')).join('');
    parsed = JSON.parse(txt);
  } catch (_) { st.result = 'bad_output'; return fail('AI_BAD_OUTPUT', 502); }
  //   ⑥ 検証
  let v;
  try { v = validateDraft(parsed, maskedSquashed, mask); }
  catch (e) { if (e instanceof BadOutput) { st.result = 'bad_output'; return fail('AI_BAD_OUTPUT', 502); } throw e; }
  st.result = 'ok'; st.nEx = v.nEx; st.nUnv = v.nUnv;
  return { draft: v.draft, model: st.model, build: AI_BUILD };
}

async function aiDraft(c) {
  const st = { result: 'error' };
  let out;
  try {
    out = await inner(c, st);
  } catch (_) {
    //   ★例外の message は出さない（本文が乗り得る）。固定のコードだけ
    st.result = 'error';
    out = fail('AI_ERROR', 500);
  }
  try { await record(c.env, c.who, st.cid, st); } catch (_) {}
  return out;
}

export const KARTE_AI_HANDLERS = { k_aiDraft: aiDraft };
