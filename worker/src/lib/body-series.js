// 体の記録を「グラフの1日1点」に合成する（設計28 3-1）。純粋関数。
//
//   ★GAS の maReadBody_（gas/MealAi.js 1145〜1190）と同じ答えを返すこと。
//     切り替えの前に、凍結したシートを GAS で計算した答えと突き合わせる（/body/series）。
//
//   規則
//     ・同じ日に複数行あれば**項目ごとに後勝ち・空欄（null/0）では上書きしない**
//     ・「後」の順序：origin='sheet' を sheet_order 順 → その後に origin='d1' を id 順
//       （凍結より後の書き込みは必ずシートの行より新しい）
//     ・出所：測定元の文字列に 'inbody' を**含めば** 'i'、それ以外は 's'（MealAi.js 1166）
//     ・除脂肪が無く体重と体脂肪率があれば計算で補う（出所は体脂肪率に合わせる）
//     ・体脂肪量＝体重×体脂肪率（出所は体脂肪率に合わせる）
//     ・GAS は Number(x) が真のときだけ採る＝0 は空欄扱い。同じにする

export const BODY_FIELDS = [
  // [D1 の列, GAS の鍵]
  ['weight_kg', 'w'], ['body_fat_pct', 'pbf'], ['lean_kg', 'lean'],
  ['body_water_l', 'tbw'], ['visceral_fat', 'vis'],
  // ここから下は段1で足した項目（GAS には無い＝突き合わせの対象外）
  ['skeletal_muscle_kg', 'smm'], ['chest_cm', 'chest'], ['arm_cm', 'arm'],
  ['waist_cm', 'waist'], ['hip_cm', 'hip'], ['thigh_cm', 'thigh'],
];
export const GAS_FIELDS = ['w', 'pbf', 'lean', 'tbw', 'vis'];

const round1 = (x) => Math.round(x * 10) / 10;

/** 行の並び順（後勝ちの「後」）。sheet → d1、その中は sheet_order / id */
export function compareRows(a, b) {
  const oa = a.origin === 'sheet' ? 0 : 1, ob = b.origin === 'sheet' ? 0 : 1;
  if (oa !== ob) return oa - ob;
  if (oa === 0) return Number(a.sheet_order) - Number(b.sheet_order);
  return Number(a.id) - Number(b.id);
}

/**
 * rows: body_measurements の行（削除済みは呼ぶ側で除く）
 * 返り値：[{ d, w, pbf, lean, tbw, vis, fat, smm, chest, arm, waist, hip, thigh, s:{鍵:'i'|'s'} }]（日付の昇順）
 */
export function synthesizeBody(rows) {
  const sorted = (rows || []).slice().sort(compareRows);
  const byDate = {};
  for (const r of sorted) {
    const d = String(r.measured_date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const rec = byDate[d] || { d, s: {} };
    const tag = String(r.source_raw || '').indexOf('inbody') >= 0 ? 'i' : 's';
    for (const [col, key] of BODY_FIELDS) {
      const v = Number(r[col]);
      if (v) { rec[key] = v; rec.s[key] = tag; }
    }
    byDate[d] = rec;
  }
  const out = [];
  for (const d of Object.keys(byDate)) {
    const r = byDate[d];
    if (r.w && r.pbf && !r.lean) { r.lean = round1(r.w * (1 - r.pbf / 100)); r.s.lean = r.s.pbf; }
    if (r.w && r.pbf) { r.fat = round1(r.w * (r.pbf / 100)); r.s.fat = r.s.pbf; }
    out.push(r);
  }
  out.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  return out;
}

/**
 * 目標線（MealAi.js maReadGoal_ 1197〜1251 と同じ選び方）
 *   meal_goal：同じ会員の**最後の行**（sheet_order → d1 の id 順で最後）。
 *     開始体重・目標体重・開始日・終了日が揃えば [開始, 終了] の2点
 *   phase：状態が「無効」を除き phase_no 順（同じ番号は行の順のまま）。
 *     開始日か目標体重が無い期は飛ばす。最初の点は「線がまだ空で開始体重がある」ときだけ開始日、
 *     各期は終了日があれば [終了日, 目標体重]。2点以上できれば期の線を採る
 *   値は GAS と同じく Number(x)||null（0 は無い扱い）
 *   返り値：null か { kind:'line'|'phases', points:[{d, v}] }
 */
export function pickGoalLine(rows) {
  const n = (x) => (Number(x) || null);
  const live = (rows || []).filter((r) => !r.deleted_at).slice().sort(compareRows);
  const goals = live.filter((r) => r.kind === 'meal_goal');
  const g = goals.length ? goals[goals.length - 1] : null;
  if (!g) return null;
  let line = [];
  let kind = 'line';
  if (n(g.start_weight) && n(g.target_weight) && g.start_date && g.end_date) {
    line = [{ d: g.start_date, v: n(g.start_weight) }, { d: g.end_date, v: n(g.target_weight) }];
  }
  const phases = live.filter((r) => r.kind === 'phase' && String(r.state || '') !== '無効')
    .map((r, i) => ({ r, i }))
    .sort((a, b) => ((Number(a.r.phase_no) || 0) - (Number(b.r.phase_no) || 0)) || (a.i - b.i))
    .map((x) => x.r);
  if (phases.length) {
    const pl = [];
    for (const ph of phases) {
      if (!ph.start_date || !n(ph.target_weight)) continue;
      if (!pl.length && n(ph.start_weight)) pl.push({ d: ph.start_date, v: n(ph.start_weight) });
      if (ph.end_date) pl.push({ d: ph.end_date, v: n(ph.target_weight) });
    }
    if (pl.length >= 2) { line = pl; kind = 'phases'; }
  }
  return line.length ? { kind, points: line } : null;
}
