// 設計49 カルテの AI 下書き v2：先に「何があったか」を推論・要約させ、カルテの形へ割り振る・数字は4つの状態・2026-11-20
//
//   ★使うのは karte-ai.js の窓口から。設定 KARTE_AI_FORMAT が 'v2' かつ要求の client_ai_format が数値の 2 のときだけ（I76-1）
//   ★ここで守ること（I76）
//     ③ 文字起こし・伏せた文・Anthropic の生の応答（SSE のイベント・差分・途中の文字列）を D1・KV・console・エラー文・応答に残さない
//     ④ 数字は Worker が4つに分ける（match／inferred／nobasis／healthHidden）。AI の申告（basis）をそのまま信じない
//     ⑤ 健康語の文は元の場所から消して caution へ。根拠か unsure に健康語のセットは healthHidden（数字・根拠・理由を返さない）
//   ★人名で採用は止めない（オーナーの判断 2026-11-20）。伏せるのは今の makeMasker（登録済みの氏名・敬称つき・電話・メール）と再マスクだけ

import { AI_HEALTH, verifySet } from './karte-ai.js';
import { normalizeExerciseName } from '../lib/karte-exercises.js';

export const AI_V2_LIMITS = {
  MAX_TOKENS: 16000,
  TIMEOUT_MS: 90000,           // Worker の締切（画面は 110秒・設計49 §6-4）
  SSE_BYTES: 512 * 1024,
  SSE_EVENTS: 20000,
  SSE_EVENT_BYTES: 64 * 1024,
  SUMMARY: 12, SUMMARY_LEN: 120, SUMMARY_TOTAL: 1000,
  EXERCISES: 20, SETS_PER_EXERCISE: 10, TOTAL_SETS: 60,
  NAME: 50, NOTE: 200, EVIDENCE: 80, UNSURE: 120,
  CONDITION: 10, CAUTION_AI_MAX: 20, CAUTION_MAX: 30, LIST: 20, TEXT: 200,
  NEXT: 5, NEXT_LEN: 100, NEXT_TOTAL: 500,
  UNCLEAR: 10, UNCLEAR_LEN: 120,
  MEMBER_MESSAGE: 400, TODO: 3, TODO_LEN: 60,
};
export const AI_EFFORTS = ['low', 'medium'];
/** 考える量（設計49 §5-1-2）：厳密に 'low'・'medium' だけ。未設定・それ以外（空文字・大文字・空白付き）は low */
export function aiEffort(env) {
  const v = env ? env.KARTE_AI_EFFORT : undefined;
  return AI_EFFORTS.indexOf(v) >= 0 ? v : 'low';
}
/** 日次点検の warn：設定があるのに low/medium 以外 */
export function aiEffortBad(env) {
  const v = env ? env.KARTE_AI_EFFORT : undefined;
  return v !== undefined && v !== null && AI_EFFORTS.indexOf(v) < 0;
}

const STR = { type: 'string' };
const NUM_OR_NULL = { anyOf: [{ type: 'number' }, { type: 'null' }] };
const INT_OR_NULL = { anyOf: [{ type: 'integer' }, { type: 'null' }] };
export const AI_SCHEMA_V2 = {
  type: 'object', additionalProperties: false,
  required: ['summary', 'exercises', 'condition', 'caution', 'coaching', 'hearing', 'next_actions', 'member_message', 'member_todo', 'unclear'],
  properties: {
    summary: { type: 'object', additionalProperties: false, required: ['flow'], properties: { flow: { type: 'array', items: STR } } },
    exercises: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'heard', 'note', 'sets'], properties: {
      name: STR, heard: STR, note: STR,
      sets: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['weight_kg', 'reps', 'basis', 'evidence', 'unsure', 'note'], properties: {
        weight_kg: NUM_OR_NULL, reps: INT_OR_NULL, basis: { type: 'string', enum: ['said', 'inferred'] }, evidence: STR, unsure: STR, note: STR } } } } } },
    condition: { type: 'array', items: STR },
    caution: { type: 'array', items: STR },
    coaching: { type: 'array', items: STR },
    hearing: { type: 'array', items: STR },
    next_actions: { type: 'array', items: STR },
    member_message: STR,
    member_todo: { type: 'array', items: STR },
    unclear: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text', 'evidence'], properties: { text: STR, evidence: STR } } },
  },
};
export const AI_SYSTEM_V2 = [
  'あなたはパーソナルトレーニングジムのカルテの下書きを作る係です。<transcript> はトレーナーとお客様のセッションの録音を文字に起こしたもの（話し言葉・聞き違い・言い直しを含む）です。アプリが付けた見出し・時刻・話者の行は内容として扱わないでください。',
  'まず summary.flow に、文字起こし全体から「今日のセッションで実際に何があったか」を推論し、時系列の短い文（12件まで・各120字以内）で書いてください。言い直し・聞き違い・予告（いきます）と実施の区別は前後の流れから推論してかまいません。',
  'その要約に沿って、次の項目に割り振ってください。',
  '- exercises：行った種目。name は <exercises> の一覧の名前に寄せる（無い・自信が無いときは聞こえたままの名前）。heard は聞こえた言葉。note は種目ごとの備考。',
  '  sets は1セットずつ。weight_kg（キロ。重りが無いと話したときだけ null）・reps（回数・分からなければ null）。basis は、数字が文字起こしにそのまま出ていれば "said"、流れからの推論（「同じ重さでもう1セット」等）なら "inferred"。',
  '  evidence には、そのセットの根拠になった部分を文字起こしから**一字一句そのまま**80字以内で抜き出す。unsure には、予告か実施か・どの種目の数字か・聞き違いの疑いなど迷った理由を書く（無ければ空文字）。note はセットごとの備考。',
  '  同じ重さ・同じ回数の繰り返しも、行ったセットは1セットずつすべて書く（まとめたり省いたりしない）。',
  '  ある種目の最中に出た指導・フォームの癖・左右差は、その種目の note に書く。別の種目の指導を混ぜない。',
  '- condition：お客様の状態のうち医療でないもの（疲れ・可動域・フォームの癖・意欲など）で、特定の種目に結びつかないもの。',
  '- caution：痛み・違和感・怪我・診断・服薬・発熱など体の不調。体の不調は caution にだけ書き、要約・unsure を含む他の項目に書かない。睡眠の量・生活リズム・疲れは caution ではなく hearing か condition に書く。',
  '- coaching：その日全体の指導の要点（種目ごとの指導は各種目の note）。hearing：生活・食事・睡眠・仕事・目標・運動歴のうち、指導に関係するもの（趣味・旅行などの雑談は書かない）。next_actions：次回やること（トレーナー向け・5件まで・各100字以内）。',
  '- member_message：お客様に見せてよい今日の要点・励まし（400字以内・無ければ空文字）。member_todo：次回までにお客様にしてほしいこと（3件まで・各60字以内）。',
  '- unclear：項目に結びつかない、文字起こしで不明確なところ（text に理由・evidence に根拠の抜き出し）。',
  '雑談・政治・宗教・思想信条・性的指向・家族の事情・第三者の話は出力しないでください。お客様は「お客様」、トレーナーは「トレーナー」と書き、それ以外の人に触れる必要があるときは名前を書かずに「〔人〕」と書いてください。',
].join('\n');

// ---------------------------------------------------------------- SSE（設計49 §5-6-2）
export class SseError extends Error { constructor(code, detail) { super(code); this.code = code; this.detail = detail || ''; } }
const ERROR_TYPES = ['overloaded_error', 'api_error', 'rate_limit_error', 'invalid_request_error', 'authentication_error', 'permission_error', 'not_found_error', 'request_too_large'];
/**
 * Anthropic のストリームを読み、text の差分だけを足し合わせる。途中の文字列は返さない（message_stop まで来たときだけ text を返す）
 *   返り値 { text, stopReason, inTok, outTok, events, bytes }。異常は SseError（code は AI_BAD_OUTPUT／AI_HTTP）
 */
export async function readSse(body, L = AI_V2_LIMITS) {
  if (!body || typeof body.getReader !== 'function') throw new SseError('AI_BAD_OUTPUT', 'NO_BODY');
  const reader = body.getReader();
  const dec = new TextDecoder('utf-8', { fatal: true });
  let buf = '', bytes = 0, events = 0, text = '';
  let started = false, stopped = false, stopReason = null, inTok = null, outTok = null;
  const open = new Map();   // index → 'text' | 'thinking' | その他
  const closed = new Set();
  const cancel = async () => { try { await reader.cancel(); } catch (_) {} };
  const badOut = async (d) => { await cancel(); throw new SseError('AI_BAD_OUTPUT', d); };
  function handle(evName, data) {
    events++;
    if (events > L.SSE_EVENTS) return 'EVENTS';
    let j;
    try { j = JSON.parse(data); } catch (_) { return 'JSON'; }
    const type = (j && j.type) || evName;
    if (type === 'ping') return null;
    if (stopped) return 'AFTER_STOP';
    if (type === 'error') { const t = j && j.error && j.error.type; throw new SseError('AI_HTTP', ERROR_TYPES.indexOf(t) >= 0 ? t : 'stream_error'); }
    if (type === 'message_start') {
      if (started) return 'DUP_START';
      started = true;
      const u = j.message && j.message.usage; if (u && Number.isFinite(Number(u.input_tokens))) inTok = Number(u.input_tokens);
      return null;
    }
    if (!started) return 'NO_START';
    if (type === 'content_block_start') {
      const i = j.index;
      if (!Number.isInteger(i) || open.has(i) || closed.has(i)) return 'DUP_BLOCK';
      open.set(i, (j.content_block && j.content_block.type) || '');
      return null;
    }
    if (type === 'content_block_delta') {
      const i = j.index;
      if (!open.has(i)) return 'DELTA_NOT_OPEN';
      const d = j.delta || {};
      if (d.type === 'text_delta') { if (open.get(i) !== 'text') return 'DELTA_TYPE'; text += String(d.text || ''); }
      return null;   // thinking 等の差分は捨てる
    }
    if (type === 'content_block_stop') {
      const i = j.index;
      if (!open.has(i)) return 'STOP_NOT_OPEN';
      open.delete(i); closed.add(i);
      return null;
    }
    if (type === 'message_delta') {
      if (j.delta && typeof j.delta.stop_reason === 'string') stopReason = j.delta.stop_reason;
      if (j.usage && Number.isFinite(Number(j.usage.output_tokens))) outTok = Number(j.usage.output_tokens);
      return null;
    }
    if (type === 'message_stop') { if (open.size) return 'OPEN_AT_STOP'; stopped = true; return null; }
    return 'UNKNOWN_TYPE';
  }
  function drain(final) {
    //   イベントは空行で区切る。最後のかたまり（final）以外は区切りが来るまで持つ
    for (;;) {
      const k = buf.search(/\r?\n\r?\n/);
      if (k < 0) {
        if (buf.length > L.SSE_EVENT_BYTES) return 'EVENT_BYTES';
        if (!final || !buf.trim()) return null;
      }
      const chunk = k < 0 ? buf : buf.slice(0, k);
      buf = k < 0 ? '' : buf.slice(k).replace(/^\r?\n\r?\n/, '');
      if (chunk.length > L.SSE_EVENT_BYTES) return 'EVENT_BYTES';
      let ev = '', data = [];
      for (const line of chunk.split(/\r?\n/)) {
        if (line.startsWith('event:')) ev = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (!data.length) { if (k < 0) return null; continue; }
      const why = handle(ev, data.join('\n'));
      if (why) return why;
      if (k < 0) return null;
    }
  }
  for (;;) {
    let r;
    try { r = await reader.read(); }
    catch (e) { if (e && e.name === 'AbortError') throw e; throw new SseError('AI_HTTP', 'STREAM_READ'); }
    if (r.done) break;
    const chunk = r.value instanceof Uint8Array ? r.value : new Uint8Array(r.value || []);
    bytes += chunk.byteLength;
    if (bytes > L.SSE_BYTES) await badOut('BYTES');
    let s;
    try { s = dec.decode(chunk, { stream: true }); } catch (_) { await badOut('UTF8'); }
    buf += s;
    let why;
    try { why = drain(false); } catch (e) { await cancel(); throw e; }
    if (why) await badOut(why);
  }
  let tail;
  try { tail = dec.decode(); } catch (_) { throw new SseError('AI_BAD_OUTPUT', 'UTF8'); }
  buf += tail;
  const why = drain(true);
  if (why) throw new SseError('AI_BAD_OUTPUT', why);
  if (!stopped) throw new SseError('AI_BAD_OUTPUT', 'NO_STOP');
  return { text, stopReason, inTok, outTok, events, bytes };
}

// ---------------------------------------------------------------- 出力の検証（設計49 §5-3〜§5-5）
class BadOutput extends Error {}
export { BadOutput as BadOutputV2 };
const bad = () => { throw new BadOutput('AI_BAD_OUTPUT'); };
const nfkc = (s) => String(s == null ? '' : s).normalize('NFKC');
const squash = (s) => nfkc(s).replace(/\s+/g, ' ').trim();
function one(v, max) { if (v == null) return ''; if (typeof v !== 'string') bad(); const t = squash(v); if (t.length > max) bad(); return t; }
function list(v, maxN, maxLen) {
  if (!Array.isArray(v)) bad();
  const out = [];
  for (const x of v) { if (typeof x !== 'string') bad(); const t = squash(x); if (!t) continue; if (t.length > maxLen) bad(); out.push(t); }
  if (out.length > maxN) bad();
  return out;
}
const tenthOk = (w) => { const x = Number(w) * 10; return Number.isFinite(x) && Math.abs(x - Math.round(x)) < 1e-6; };
const wOk = (w) => typeof w === 'number' && w > 0 && w <= 500 && tenthOk(w);
const rOk = (r) => Number.isInteger(r) && r >= 1 && r <= 100;

/** AI の JSON → 検証した v2 の draft。壊れていれば BadOutput（黙って切らない） */
export function validateDraftV2(raw, maskedSquashed, mask, effort) {
  const L = AI_V2_LIMITS;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad();
  if (!raw.summary || typeof raw.summary !== 'object') bad();
  const flow = list(raw.summary.flow, L.SUMMARY, L.SUMMARY_LEN);
  if (flow.join('').length > L.SUMMARY_TOTAL) bad();
  if (!Array.isArray(raw.exercises) || raw.exercises.length > L.EXERCISES) bad();
  let total = 0;
  const exs = raw.exercises.map((e) => {
    if (!e || typeof e !== 'object' || !Array.isArray(e.sets)) bad();
    if (e.sets.length > L.SETS_PER_EXERCISE) bad();
    total += e.sets.length;
    let name = '';
    try { name = normalizeExerciseName(typeof e.name === 'string' ? e.name.replace(/\s+/g, ' ') : ''); } catch (_) { name = ''; }
    const heard = typeof e.heard === 'string' && squash(e.heard).length <= L.NAME ? squash(e.heard) : '';
    const note = one(e.note, L.NOTE);
    const sets = e.sets.map((st) => {
      if (!st || typeof st !== 'object') bad();
      return { raw: st, note: one(st.note, L.NOTE), unsure: one(st.unsure, L.UNSURE), evidence: typeof st.evidence === 'string' ? squash(st.evidence) : '' };
    });
    return { name, heard, note, sets };
  });
  if (total > L.TOTAL_SETS) bad();
  const condition = list(raw.condition, L.CONDITION, L.TEXT);
  const caution0 = list(raw.caution, L.CAUTION_AI_MAX, L.TEXT);
  const coaching = list(raw.coaching, L.LIST, L.TEXT);
  const hearing = list(raw.hearing, L.LIST, L.TEXT);
  const next = list(raw.next_actions, L.NEXT, L.NEXT_LEN);
  if (next.join('\n').length > L.NEXT_TOTAL) bad();
  let memberMessage = one(raw.member_message, L.MEMBER_MESSAGE);
  const todo = list(raw.member_todo, L.TODO, L.TODO_LEN);
  if (!Array.isArray(raw.unclear) || raw.unclear.length > L.UNCLEAR) bad();
  const unclear = raw.unclear.map((u) => {
    if (!u || typeof u !== 'object') bad();
    return { text: one(u.text, L.UNCLEAR_LEN), evidence: typeof u.evidence === 'string' ? squash(u.evidence).slice(0, L.EVIDENCE) : '' };
  }).filter((u) => u.text);

  //   健康語：元の場所から消して caution へ（同じ文は1つ）
  const moved = [];
  const H = (t) => AI_HEALTH.test(t);
  const pick = (arr) => arr.filter((t) => { if (H(t)) { moved.push(t); return false; } return true; });
  const flow2 = pick(flow), condition2 = pick(condition), coaching2 = pick(coaching), hearing2 = pick(hearing), next2 = pick(next), todo2 = pick(todo);
  if (memberMessage && H(memberMessage)) { moved.push(memberMessage); memberMessage = ''; }
  const unclear2 = [];
  for (const u of unclear) {
    if (H(u.text)) { moved.push(u.text); continue; }
    unclear2.push({ text: u.text, evidence: H(u.evidence) ? '' : u.evidence });
  }
  for (const e of exs) {
    const label = e.name || e.heard || '種目';
    const tag = (t) => { const x = label + '：' + t; if (x.length > L.TEXT) bad(); return x; };
    if (e.note && H(e.note)) { moved.push(tag(e.note)); e.note = ''; }
    for (const s of e.sets) {
      if (s.note && H(s.note)) { moved.push(tag(s.note)); s.note = ''; }
      //   ★根拠か理由に健康語＝そのセットは healthHidden（数字・根拠・理由を返さない）。文は caution へ
      if (s.unsure && H(s.unsure)) { moved.push(tag(s.unsure)); s.healthHidden = true; }
      if (s.evidence && H(s.evidence)) { moved.push(tag(s.evidence.slice(0, L.EVIDENCE))); s.healthHidden = true; }
    }
  }
  const caution = caution0.slice();
  for (const t of moved) if (caution.indexOf(t) < 0) caution.push(t);
  if (caution.length > L.CAUTION_MAX) bad();

  //   数字の4つの状態
  let nEx = 0, nSets = 0, nInf = 0, nNob = 0, nHid = 0;
  const exercises = exs.map((e) => {
    if (e.name || e.heard) nEx++;
    const sets = e.sets.map((s) => {
      if (s.healthHidden) { nHid++; return { status: 'healthHidden', w: null, r: null, evidence: '', unsure: '', note: mask(s.note) }; }
      const st = s.raw, w = st.weight_kg, r = st.reps;
      const ev = s.evidence && s.evidence.length <= L.EVIDENCE ? s.evidence : '';
      const at = ev ? maskedSquashed.indexOf(ev) : -1;
      const evShown = at >= 0 ? maskedSquashed.slice(at, at + ev.length) : (s.evidence ? s.evidence.slice(0, L.EVIDENCE) : '');
      const v = e.name && st.basis === 'said' && !s.unsure ? verifySet({ weight_kg: w, reps: r, evidence: ev }, maskedSquashed) : null;
      if (v) { nSets++; return { status: 'match', w: v.w, r: v.r, evidence: mask(v.evidence), unsure: '', note: mask(s.note) }; }
      const wv = w === null ? null : (wOk(w) ? w : null);
      const rv = rOk(r) ? r : null;
      const inRange = rv !== null && (w === null || wv !== null);
      if (at >= 0 && inRange) { nInf++; return { status: 'inferred', w: wv, r: rv, evidence: mask(evShown), unsure: mask(s.unsure), note: mask(s.note) }; }
      nNob++;
      return { status: 'nobasis', w: wv, r: rv, evidence: mask(evShown), unsure: mask(s.unsure), note: mask(s.note) };
    });
    return { name: mask(e.name), heard: mask(e.heard), note: mask(e.note), sets };
  });
  return {
    draft: {
      v: 2, effort,
      summary: flow2.map(mask), exercises,
      condition: condition2.map(mask), caution: caution.map(mask), coaching: coaching2.map(mask), hearing: hearing2.map(mask),
      next_actions: next2.map(mask), member_message: mask(memberMessage), member_todo: todo2.map(mask),
      unclear: unclear2.map((u) => ({ text: mask(u.text), evidence: mask(u.evidence) })),
    },
    counts: { nEx, nSets, nInf, nNob, nHid, nUnclear: unclear2.length, nSummary: flow2.length },
  };
}
