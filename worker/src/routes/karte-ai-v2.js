// 設計49 カルテの AI 下書き v2：先に「何があったか」を推論・要約させ、カルテの形へ割り振る・数字は4つの状態・2026-11-20
//
//   ★使うのは karte-ai.js の窓口から。設定 KARTE_AI_FORMAT が 'v2' かつ要求の client_ai_format が数値の 2 のときだけ（I76-1）
//   ★ここで守ること（I76）
//     ③ 文字起こし・伏せた文・Anthropic の生の応答（SSE のイベント・差分・途中の文字列）を D1・KV・console・エラー文・応答に残さない
//     ④ 数字は Worker が4つに分ける（match／inferred／nobasis／healthHidden）。AI の申告（basis）をそのまま信じない
//     ⑤ 健康語の文は元の場所から消して caution へ。根拠か unsure に健康語のセットは healthHidden（数字・根拠・理由を返さない）
//   ★人名で採用は止めない（オーナーの判断 2026-11-20）。伏せるのは今の makeMasker（登録済みの氏名・敬称つき・電話・メール）と再マスクだけ

import { AI_HEALTH, BODYWEIGHT, verifySet } from './karte-ai.js';
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
      sets: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['weight_kg', 'bodyweight', 'reps', 'basis', 'evidence', 'unsure', 'note'], properties: {
        weight_kg: NUM_OR_NULL, bodyweight: { type: 'boolean' }, reps: INT_OR_NULL, basis: { type: 'string', enum: ['said', 'inferred'] }, evidence: STR, unsure: STR, note: STR } } } } } },
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
//   設計50：判断の規則だけに絞った（出力の形は JSON スキーマで固定）。★字数・件数は AI_V2_LIMITS と同じ値（超えると下書き全体が AI_BAD_OUTPUT＝検査 V2-27 で値を突き合わせる）
export const AI_SYSTEM_V2 = [
  'あなたはパーソナルトレーニングのカルテ係。<transcript>（録音の文字起こし・聞き違いを含む）から、今日実際に行ったことを指定の形で返す。アプリが付けた見出し・時刻・話者の行は内容として扱わない。',
  '1. summary.flow：トレーニングの記録に残る種目・重さ・回数・備考以外のことだけを時系列で（12件まで・各120字・合計1000字まで）。例：ストレッチ・カウンセリング・測定・計画の変更とその理由・順番を変えた理由。種目名・重さ・回数を並べて書かない。無ければ空の配列。予告と実施・言い直しは前後から判断する。',
  '2. exercises（20件まで）：name は <exercises> の名前に寄せる（無ければ聞こえたまま・50字まで）。heard＝聞こえた言葉（50字まで）。note＝その種目にだけ結びつく指導・フォーム・左右差（200字まで）。',
  '   sets：行ったセットを1つずつ全部書く（1種目10セット・全体60セットまで。同じ重さの繰り返しも省かない）。weight_kg＝重さ（分からなければ null）／bodyweight＝重りを使わない種目なら true（このとき weight_kg は null）／reps＝回数（分からなければ null）／basis＝数字が文字起こしにあれば said、推論なら inferred／evidence＝根拠の部分を文字起こしの文字のまま80字まで（聞き違い・言い間違いも直さずに写す）／unsure＝迷った理由（120字まで・無ければ空）／note＝そのセットの備考（200字まで）。そのセットだけの出来事（補助・崩れ・やり切れなかった等）を書く。',
  '3. caution（20件まで・各200字）：痛み・違和感・怪我・診断・服薬・発熱だけ。体の不調はここ以外に書かない。睡眠・生活リズム・疲れは caution に書かない。',
  '4. condition＝今日の体の調子で caution に当たらないもの・疲れや動きの硬さ（10件まで）／coaching＝種目に結びつかない全体の指導・考え方（20件まで）／hearing＝お客様から聞いた生活・食事・睡眠の習慣・仕事・目標だけ（20件まで）。この3つは各200字まで。next_actions＝次回のセッションでトレーナーがやること（5件まで・各100字・合計500字まで）。お客様への宿題は member_todo に書く。',
  '5. member_message＝今日のふり返り（400字まで）。お客様の画面にそのまま出る、トレーナーからお客様への語りかけ（です・ます調）。見出しをこの順で付けて書く：【今日の内容】今日行った主な内容 【よくできた点】よくできた点・伸びた点（トレーナーが伝えた言葉は要約して入れる。発言をかぎかっこで引用しない） 【次回に向けて】次のセッションで意識すること。各見出しは1〜2文。根拠が無い見出しは見出しごと省き、どれも書けなければ空文字にする（一般的な励ましで埋めない）。同じ要点は1回だけ書き、言い換えて繰り返さない。文字起こしに無いことは書かない。重さ・回数は文字起こしで話した数字だけ。体の状態（痛み・違和感・怪我・体調など）は書かない（caution にだけ書く）。member_todo＝次回までにしてほしいこと（3件まで・各60字）。トレーナーが頼んだ・勧めたことだけ。【次回に向けて】と同じ内容は書かない。',
  '6. unclear（10件まで）：どこにも入らない不明点（text 120字まで）とその根拠（evidence＝文字起こしの文字のまま80字まで）。',
  '7. 同じ事実は1つの欄にだけ書く（社内の欄は重ならないように・言い換えて別の欄に繰り返さない・設計64・設計66）。種目・重さ・回数・セットの備考はトレーニングの記録（exercises）にだけ書き、summary.flow に重ねない。その種目中の指導・フォーム・左右差はその種目の note にだけ書き、coaching と summary.flow に重ねない。summary.flow＝記録に残らないことだけ（指導の中身・状態・次回のことは書かない）。coaching＝種目に結びつかない全体の指導だけ。condition・hearing・next_actions・caution もほかの欄と同じことを書かない。迷ったら1つの欄に書き、ほかの欄では省く（事実そのものは省かない）。お客様の画面に出る欄（5.）は社内の欄と重なってよい。',
  '書かない：雑談（遊び・誘い・予定・趣味・旅行の話を含む）・政治・宗教・思想信条・性的指向・家族の事情・第三者の話。人名は書かず「お客様」「トレーナー」「〔人〕」と書く。',
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
//   設計61 改訂2：お客様へのふり返りの3つの見出しのうち、実際に現れた2つ目以降の前に改行を入れる（ほかの【】は触らない）。
//     改行を入れると max を超えるなら入れない（1行のまま返す＝画面が字数を出して保存を止める・切らない）
export const MEMBER_HEADS = ['今日の内容', 'よくできた点', '次回に向けて'];
const MEMBER_HEAD_RE = new RegExp(' ?【(' + MEMBER_HEADS.join('|') + ')】 ?', 'g');
export function layoutMemberMessage(t, max) {
  const s = String(t || '');
  let n = 0;
  const laid = s.replace(MEMBER_HEAD_RE, (m, h, off) => {
    n += 1;
    const head = '【' + h + '】';
    if (n === 1) return (off > 0 && m.startsWith(' ') ? ' ' : '') + head;
    return '\n' + head;
  });
  return laid.length <= max ? laid : s;
}
//   設計61 改訂2：次回までにの重複は、空白と句読点（Unicode の P）を除いた形が同じものを後ろから落とす。記号（×・+ 等）・英字の大小は区別したまま
export function dedupeTodo(arr) {
  const seen = new Set();
  return arr.filter((t) => { const k = t.replace(/[\s\p{P}]+/gu, ''); if (seen.has(k)) return false; seen.add(k); return true; });
}
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

// ---------------------------------------------------------------- 根拠の探し方（設計50 §4-4）
//   空白と句読点の違いだけを無視して位置を探す。語の置き換え（聞き違いの語⇄正しい語）は緩めない。
//   ★詰めた後 EV_MIN 字未満の根拠は数字の根拠として認めない（短い根拠が別の箇所に当たるのを防ぐ・関門① W-H2）
//   返す text は maskedSquashed の上の切り出し（照合はこの切り出しの中の数字で行う）
export const EV_MIN = 6;
export const HEALTH_WINDOW = 40;
const EV_IGNORE = /[\s、。・「」『』！？!?…]/;
const EV_BOUND = /[。！？!?\n]/;
//   繰り返しの言葉（設計50 §4-3・関門① W-H1）：根拠にこれがあれば、同じ種目の直前のセットと同じ値を根拠に在るとみなす
export const AI_REPEAT = /同じ|もう1セット|もう一セット|もう1回|もう一回|もう1本|もう一本|同様/;
//   健康語（AI_HEALTH）の選択肢。素の文字列だけでできている（検査 V2-32 で確かめる）＝位置ごとに「そこから始まる最短の当たり」を数えられる
//   ★karte-ai.js と互いに import している＝読み込みの時点では AI_HEALTH がまだ無い。使うときに作る
export function aiHealthAlts() { return AI_HEALTH.source.split('|'); }
const lowerBound = (arr, x) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; };
/**
 * 健康語を見直す下ごしらえ（関門② 2回目：1回の要求につき1回だけ）。src は lineMarked（maskedSquashed と同じ長さ）
 *   starts／ends：健康語が当たる位置（昇順）と、そこから始まる最短の当たりの終わり。bounds：文の区切り（。！？・改行）の位置（昇順）
 *   near(a, b)：windowOf(src, a, b) の中に健康語が丸ごと入るか（= AI_HEALTH.test(windowOf(...)) と同じ答え）を二分探索で返す
 */
export function makeHealthIndex(src) {
  const starts = [], ends = [], bounds = [];
  const ALTS = aiHealthAlts();
  const first = new Set(ALTS.map((x) => x[0]));
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (EV_BOUND.test(c)) bounds.push(i);
    if (!first.has(c)) continue;
    let best = 0;
    for (const alt of ALTS) if (src.startsWith(alt, i) && (!best || alt.length < best)) best = alt.length;
    if (best) { starts.push(i); ends.push(i + best); }
  }
  function range(a, b) {
    let s0 = Math.max(0, a - HEALTH_WINDOW), e0 = Math.min(src.length, b + HEALTH_WINDOW);
    const k = lowerBound(bounds, a) - 1;                 // a より前で一番近い区切り
    if (k >= 0 && bounds[k] >= s0) s0 = bounds[k] + 1;
    const m = lowerBound(bounds, b);                     // b 以後で一番近い区切り
    if (m < bounds.length && bounds[m] < e0) e0 = bounds[m];
    return [s0, e0];
  }
  return {
    range,
    near(a, b) {
      const [s0, e0] = range(a, b);
      //   最短の当たりが窓に収まる始まりがあるか。収まらないのは窓の終わりの直前（選択肢の長さ未満）だけ＝数回で終わる
      for (let t = lowerBound(starts, s0); t < starts.length && starts[t] < e0; t++) if (ends[t] <= e0) return true;
      return false;
    },
  };
}
/**
 * 根拠を探す（設計50 §4-4）。返すのは最初の位置の切り出しと、healthNear()＝どれか1つの位置の前後に健康語があるか（関門② 1）
 *   ★出現位置は配列に積まず indexOf で順にたどり、当たったら打ち切る。同じ根拠の答えは要求の中で使い回す（関門② 2回目：CPU の上限）
 *   ★上限で打ち切って安全側を外すことはしない（全部の位置を見るか、当たって止まるか）
 */
export function makeLocator(hay, lines) {
  let h = '';
  const idx = [];
  for (let i = 0; i < hay.length; i++) { const c = hay[i]; if (!EV_IGNORE.test(c)) { h += c; idx.push(i); } }
  let hx = null;
  const memo = new Map();
  const span = (k, n) => { const a = idx[k], b = idx[k + n - 1] + 1; return b - a <= AI_V2_LIMITS.EVIDENCE ? [a, b] : null; };
  return function locate(ev) {
    let e = '';
    for (const c of String(ev || '')) if (!EV_IGNORE.test(c)) e += c;
    if (e.length < EV_MIN) return null;
    let k = h.indexOf(e), sp = null;
    for (; k >= 0; k = h.indexOf(e, k + 1)) { sp = span(k, e.length); if (sp) break; }
    if (!sp) return null;
    const k0 = k;
    return {
      at: sp[0], end: sp[1], text: hay.slice(sp[0], sp[1]),
      healthNear() {
        if (memo.has(e)) return memo.get(e);
        if (!hx) hx = makeHealthIndex(typeof lines === 'string' && lines.length === hay.length ? lines : hay);
        let hit = false;
        for (let q = k0; q >= 0 && !hit; q = h.indexOf(e, q + 1)) { const p = span(q, e.length); if (p && hx.near(p[0], p[1])) hit = true; }
        memo.set(e, hit);
        return hit;
      },
    };
  };
}
/** 見つかった位置の前後（±HEALTH_WINDOW・文の区切り〔。！？・改行〕で止める）。健康語を見直すために使う（W-H2）。★判定は makeHealthIndex の near（同じ窓） */
export function windowOf(src, a, b) {
  let s0 = Math.max(0, a - HEALTH_WINDOW), e0 = Math.min(src.length, b + HEALTH_WINDOW);
  for (let i = a - 1; i >= s0; i--) if (EV_BOUND.test(src[i])) { s0 = i + 1; break; }
  for (let i = b; i < e0; i++) if (EV_BOUND.test(src[i])) { e0 = i; break; }
  return src.slice(s0, e0);
}
function numTokens(ev) {
  const out = [];
  for (const m of String(ev).matchAll(/(?<![0-9.])(\d+(?:\.\d+)?)(?![0-9.])/g)) out.push(m[1]);
  return out;
}

/**
 * AI の JSON → 検証した v2 の draft。壊れていれば BadOutput（黙って切らない）
 *   lineMarked：maskedSquashed と同じ長さで、改行から来た空白だけを '\n' にしたもの（健康語を見直す窓を文の区切りで止めるため）。無ければ maskedSquashed
 */
export function validateDraftV2(raw, maskedSquashed, mask, effort, lineMarked) {
  const L = AI_V2_LIMITS;
  const lines = typeof lineMarked === 'string' && lineMarked.length === maskedSquashed.length ? lineMarked : maskedSquashed;
  const locate = makeLocator(maskedSquashed, lines);
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
  const todo = dedupeTodo(list(raw.member_todo, L.TODO, L.TODO_LEN));   // 設計61 改訂2：同じ形は後ろを落とす（健康語の移動の前）
  if (!Array.isArray(raw.unclear) || raw.unclear.length > L.UNCLEAR) bad();
  const unclear = raw.unclear.map((u) => {
    if (!u || typeof u !== 'object') bad();
    //   ★根拠は文字起こしに（句読点を無視した探し方で）見つかったときだけ、その切り出しを返す。無ければ空（関門② 3）
    const uloc = typeof u.evidence === 'string' && squash(u.evidence).length <= L.EVIDENCE ? locate(squash(u.evidence)) : null;
    return { text: one(u.text, L.UNCLEAR_LEN), evidence: uloc ? uloc.text : '' };
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

  //   数字の4つの状態（設計50 §4-3）
  //     match＝根拠が在り・said・unsure なし・verifySet が通る／inferred＝根拠が在る（数字が欠けても inferred・返す数字は根拠の中に在るものだけ）
  //     nobasis＝根拠が見つからない（数字は範囲内なら返す）／healthHidden＝根拠・unsure・根拠の前後に健康語
  //     bw＝自重（形の bodyweight が true のときだけ）。w が null で bw が偽＝重さが分からない
  let nEx = 0, nSets = 0, nInf = 0, nNob = 0, nHid = 0;
  const HID = (s) => ({ status: 'healthHidden', w: null, r: null, bw: false, evidence: '', unsure: '', note: mask(s.note) });
  const exercises = exs.map((e) => {
    if (e.name || e.heard) nEx++;
    const sets = [];
    for (const s of e.sets) {
      if (s.healthHidden) { nHid++; sets.push(HID(s)); continue; }
      const st = s.raw, r = st.reps;
      const bw = st.bodyweight === true;
      const w = bw ? null : st.weight_kg;
      const loc = s.evidence && s.evidence.length <= L.EVIDENCE ? locate(s.evidence) : null;
      //   ★根拠の前後に健康語＝healthHidden（短い根拠で健康の文脈を迂回しない・W-H2）
      if (loc && loc.healthNear()) { nHid++; sets.push(HID(s)); continue; }
      let v = null;
      if (loc && e.name && st.basis === 'said' && !s.unsure && (bw || typeof w === 'number')) v = verifySet({ weight_kg: bw ? null : w, reps: r, evidence: loc.text }, maskedSquashed);
      if (v) { nSets++; sets.push({ status: 'match', w: v.w, r: v.r, bw: v.w === null, evidence: mask(v.evidence), unsure: '', note: mask(s.note) }); continue; }
      const wv = bw ? null : (wOk(w) ? w : null);
      const rv = rOk(r) ? r : null;
      if (loc) {
        //   ★返す数字は根拠の中に数字として在るものだけ。例外：繰り返しの言葉があり、同じ種目の直前のセットと同じ値（W-H1）
        const toks = numTokens(loc.text), rep = AI_REPEAT.test(loc.text);
        const prev = sets.length ? sets[sets.length - 1] : null;
        const wIn = wv !== null && (toks.some((t) => /^\d+(?:\.\d)?$/.test(t) && Math.round(Number(t) * 10) === Math.round(wv * 10)) || (rep && !!prev && prev.w === wv));
        const rIn = rv !== null && (toks.some((t) => /^\d+$/.test(t) && Number(t) === rv) || (rep && !!prev && prev.r === rv));
        //   ★自重も、根拠に自重の言葉（verifySet と同じ BODYWEIGHT）があるか、繰り返し＋直前のセットが自重のときだけ（関門② 2）
        const bwIn = bw && (BODYWEIGHT.test(loc.text) || (rep && !!prev && prev.bw === true));
        nInf++;
        sets.push({ status: 'inferred', w: wIn ? wv : null, r: rIn ? rv : null, bw: bwIn, evidence: mask(loc.text), unsure: mask(s.unsure), note: mask(s.note) });
        continue;
      }
      nNob++;
      sets.push({ status: 'nobasis', w: wv, r: rv, bw, evidence: mask(s.evidence ? s.evidence.slice(0, L.EVIDENCE) : ''), unsure: mask(s.unsure), note: mask(s.note) });
    }
    return { name: mask(e.name), heard: mask(e.heard), note: mask(e.note), sets };
  });
  return {
    draft: {
      v: 2, effort,
      summary: flow2.map(mask), exercises,
      condition: condition2.map(mask), caution: caution.map(mask), coaching: coaching2.map(mask), hearing: hearing2.map(mask),
      next_actions: next2.map(mask), member_message: layoutMemberMessage(mask(memberMessage), L.MEMBER_MESSAGE), member_todo: todo2.map(mask),   // 設計61 改訂2：改行は mask の後・最後の文字数で決める
      unclear: unclear2.map((u) => ({ text: mask(u.text), evidence: mask(u.evidence) })),
    },
    counts: { nEx, nSets, nInf, nNob, nHid, nUnclear: unclear2.length, nSummary: flow2.length },
  };
}
