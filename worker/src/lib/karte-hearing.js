// カルテのヒアリング・痛みの身体図・変化の理由の固定表と検査（設計31）・2026-11-04
//
//   ★正本はここ。画面（liff/karte.js）の表示名はこの鍵に合わせる（検査で一致を確かめる）
//   ★知らない鍵・重複・型違いは 400（黙って捨てない）。保存するのは正規化した JSON（受け取った文字列をそのまま入れない）
//   ★変化の理由（REASONS）に健康の選択肢（服薬・むくみ・生理周期など）を入れない＝同意の無い場所（karte_notes）に健康情報を置かない

export const PURPOSES = [
  ['diet', 'ダイエット'], ['bodymake', 'ボディメイク'], ['strength', '筋力アップ'], ['posture', '姿勢改善'],
  ['condition', 'コンディショニング'], ['stamina', '体力づくり'], ['health', '健康維持'], ['sports', '競技・大会'],
];
export const SLIM_AREAS = [
  ['face', '顔・首'], ['arm', '二の腕'], ['chest', '胸'], ['belly', 'お腹'], ['waist', 'くびれ'],
  ['back', '背中'], ['hip', 'お尻'], ['thigh', '太もも'], ['calf', 'ふくらはぎ'],
];
//   痛みの部位（健康情報・karte_safety にだけ入る）
export const REGIONS = [
  ['neck', '首'], ['shoulder_r', '右肩'], ['shoulder_l', '左肩'], ['upper_back', '背中'], ['lower_back', '腰'],
  ['elbow_r', '右肘'], ['elbow_l', '左肘'], ['wrist_r', '右手首'], ['wrist_l', '左手首'],
  ['hip_r', '右股関節'], ['hip_l', '左股関節'], ['knee_r', '右膝'], ['knee_l', '左膝'],
  ['ankle_r', '右足首'], ['ankle_l', '左足首'], ['other', 'その他'],
];
export const TAGS = [['training', 'トレーニング'], ['meal', '食事'], ['life', '生活'], ['body', '体組成の変化']];
export const REASONS = [
  ['snack_down', '間食が減った', 'meal'], ['protein_low', 'タンパク質が少ない', 'meal'], ['eating_out', '外食が多い', 'meal'],
  ['cut_too_much', '量を減らしすぎ', 'meal'], ['meal_irregular', '食事の時間が不規則', 'meal'],
  ['self_training_up', '自主トレが増えた', 'exercise'], ['cardio_up', '有酸素運動が増えた', 'exercise'],
  ['visit_gap', '来店の間隔が空いた', 'exercise'], ['steps_down', '日常の歩数が減った', 'exercise'],
  ['sleep_short', '睡眠が短い', 'life'], ['busy', '仕事が忙しい', 'life'], ['tired', '疲れが抜けない', 'life'],
];

export const HEARING_LIMITS = { TEXT: 100, SLIM_MAX: 3, PAIN_MAX: 12, SYMPTOM: 80, REASONS_MAX: 12 };
const HEARING_KEYS = ['purposes', 'slimAreas', 'motivation', 'targetWeight', 'targetFat', 'exerciseNow', 'exercisePast', 'sleep', 'meals'];
const HEARING_TEXT = ['exerciseNow', 'exercisePast', 'sleep', 'meals'];

const bad = (code) => { throw new RangeError(code); };
const isPlain = (x) => x != null && typeof x === 'object' && !Array.isArray(x);
const keysOf = (tbl) => tbl.map((t) => t[0]);

function cleanText(v, max, code) {
  if (v == null) return null;
  if (typeof v !== 'string') bad(code);
  const t = v.normalize('NFC').trim();
  if (!t) return null;
  if (t.length > max) bad(code);
  return t;
}
/** 固定表の鍵の配列。重複は 400。keepOrder なら受け取った順、そうでなければ固定表の順 */
function keyList(v, tbl, max, keepOrder, code) {
  if (v == null) return [];
  if (!Array.isArray(v)) bad(code);
  const allowed = keysOf(tbl);
  const seen = new Set();
  for (const k of v) {
    if (typeof k !== 'string' || allowed.indexOf(k) < 0 || seen.has(k)) bad(code);
    seen.add(k);
  }
  if (v.length > max) bad(code);
  return keepOrder ? v.slice() : allowed.filter((k) => seen.has(k));
}
function intIn(v, min, max, code) {
  if (v == null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) bad(code);
  return v;
}
function dec1In(v, min, max, code) {
  if (v == null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) bad(code);
  return Math.round(v * 10) / 10;
}

/** ヒアリング → 正規化した JSON 文字列（全部空なら null） */
export function normalizeHearing(h) {
  if (h == null) return null;
  if (!isPlain(h)) bad('HEARING');
  for (const k of Object.keys(h)) if (HEARING_KEYS.indexOf(k) < 0) bad('HEARING_KEY');
  const o = {
    purposes: keyList(h.purposes, PURPOSES, PURPOSES.length, false, 'PURPOSES'),
    slimAreas: keyList(h.slimAreas, SLIM_AREAS, HEARING_LIMITS.SLIM_MAX, true, 'SLIM_AREAS'),
    motivation: intIn(h.motivation, 1, 10, 'MOTIVATION'),
    targetWeight: dec1In(h.targetWeight, 20, 250, 'TARGET_WEIGHT'),
    targetFat: dec1In(h.targetFat, 3, 60, 'TARGET_FAT'),
  };
  for (const k of HEARING_TEXT) o[k] = cleanText(h[k], HEARING_LIMITS.TEXT, 'HEARING_TEXT');
  const empty = !o.purposes.length && !o.slimAreas.length && HEARING_KEYS.every((k) => k === 'purposes' || k === 'slimAreas' || o[k] == null);
  if (empty) return null;
  //   鍵の順を固定して文字列にする（同じ内容は同じ文字列）
  const out = {};
  for (const k of HEARING_KEYS) out[k] = o[k];
  return JSON.stringify(out);
}

/** 改訂の控えに残すもの：選択肢と数値だけ（自由文は残さない＝健康情報を恒久化しない・関門①4） */
export const HEARING_REVISION_SQL = `CASE WHEN hearing_json IS NULL THEN NULL ELSE json_object(
  'purposes', json_extract(hearing_json, '$.purposes'), 'slimAreas', json_extract(hearing_json, '$.slimAreas'),
  'motivation', json_extract(hearing_json, '$.motivation'), 'targetWeight', json_extract(hearing_json, '$.targetWeight'),
  'targetFat', json_extract(hearing_json, '$.targetFat')) END`;

/** 痛みの身体図 → 正規化した JSON 文字列（空なら null） */
export function normalizePainMap(v) {
  if (v == null) return null;
  if (!Array.isArray(v)) bad('PAIN');
  if (v.length > HEARING_LIMITS.PAIN_MAX) bad('PAIN');
  const allowed = keysOf(REGIONS);
  const by = {};
  for (const it of v) {
    if (!isPlain(it)) bad('PAIN');
    for (const k of Object.keys(it)) if (k !== 'region' && k !== 'level' && k !== 'symptom') bad('PAIN_KEY');
    if (typeof it.region !== 'string' || allowed.indexOf(it.region) < 0 || by[it.region]) bad('PAIN_REGION');
    by[it.region] = { region: it.region, level: intIn(it.level, 1, 10, 'PAIN_LEVEL'), symptom: cleanText(it.symptom, HEARING_LIMITS.SYMPTOM, 'PAIN_SYMPTOM') };
    if (by[it.region].level == null) bad('PAIN_LEVEL');
  }
  const out = allowed.filter((k) => by[k]).map((k) => by[k]);
  return out.length ? JSON.stringify(out) : null;
}

/** 変化の理由 → 正規化した JSON 文字列（空なら null） */
export function normalizeReasons(v) {
  const list = keyList(v, REASONS, HEARING_LIMITS.REASONS_MAX, false, 'REASONS');
  return list.length ? JSON.stringify(list) : null;
}

export function normalizeTag(v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || keysOf(TAGS).indexOf(v) < 0) bad('TAG');
  return v;
}

/** 保存した JSON を読む（壊れていれば null。読む側は落とさない） */
export function parseJsonCol(s) {
  if (s == null) return null;
  try { return JSON.parse(String(s)); } catch (_) { return null; }
}

export const has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
