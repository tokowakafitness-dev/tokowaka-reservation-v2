// 体の記録の、GAS からの入口（設計28 3-1）・2026-11-03
//   お客様のブラウザからは呼ばせない。合言葉（X-Ingest-Secret）で守る。CORS も返さない。
//
//   /body/write  … 切替フラグが 'd1' になった後、GAS の書き込み口（LINE の体重・体脂肪率／古い画面の InBody）が転送してくる
//   /body/freeze … 凍結したシートを一度だけ写す（begin → rows を分割で → state）
//   /body/series … 突き合わせ用（凍結から写した行だけで計算した答え）と、LINE ボットの「前回」用
//
//   ★書き込みは全部か無か。二重送信は body_requests（channel＋client_req_id）を batch に入れて弾く

import { requireSecret } from './quota.js';
import { guardOf, isRealDate, readMeasureValues, MEASURE_RANGES } from './karte.js';
import { synthesizeBody, pickGoalLine } from '../lib/body-series.js';

const MAX_BYTES = 256 * 1024;   // 写しの1回分（行の束）。画面の入口とは別
const S = (sql, ...args) => ({ sql, args });
const MCOLS = Object.keys(MEASURE_RANGES);

function out(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
async function readJson(request) {
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > MAX_BYTES) return { error: 'TOO_LARGE' };
  const buf = await request.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) return { error: 'TOO_LARGE' };
  try {
    const b = JSON.parse(new TextDecoder().decode(buf));
    if (!b || typeof b !== 'object' || Array.isArray(b)) return { error: 'BAD_JSON' };
    return { body: b };
  } catch (_) { return { error: 'BAD_JSON' }; }
}
async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const GUARD_TARGET = (cid) => S(`INSERT INTO karte_guard (target) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM customers WHERE customer_id = ?)`, cid);
const GUARD_READY = () => S(`INSERT INTO karte_guard (ready) SELECT 1 WHERE NOT EXISTS (
                               SELECT 1 FROM body_freeze WHERE state IN ('frozen', 'copying', 'copied', 'verified'))`);
//   その日の d1 の行のうち「最後」（サーバー採番の id が最大・削除済みを除く・体重あり）
const LAST_D1_OF_DAY = `SELECT id FROM body_measurements WHERE customer_id = ? AND measured_date = ? AND origin = 'd1'
                          AND deleted_at IS NULL AND weight_kg IS NOT NULL ORDER BY id DESC LIMIT 1`;

// ================================================================ /body/write
export async function handleBodyWrite(request, env) {
  const deny = requireSecret(request, env);
  if (deny) return deny;
  const rj = await readJson(request);
  if (rj.error) return out({ ok: false, code: rj.error }, 400);
  const b = rj.body;
  const op = String(b.op || ''), channel = String(b.channel || ''), crid = String(b.clientReqId || '');
  const cid = String(b.customerId || ''), date = String(b.date || '');
  if (!['addWeight', 'addFat', 'addInBody'].includes(op)) return out({ ok: false, code: 'BAD_OP' }, 400);
  if (!['line', 'liff', 'gas_inbody'].includes(channel)) return out({ ok: false, code: 'BAD_CHANNEL' }, 400);
  if (!/^[A-Za-z0-9_:.-]{8,128}$/.test(crid)) return out({ ok: false, code: 'BAD_REQ_ID' }, 400);
  if (!cid || !isRealDate(date)) return out({ ok: false, code: 'BAD_REQUEST' }, 400);
  const enteredBy = String(b.enteredBy || '').slice(0, 50) || null;
  const now = Date.now();

  let stmts, resultSql;
  try {
    if (op === 'addWeight') {
      const v = readMeasureValues({ weight_kg: b.weightKg });
      stmts = [GUARD_TARGET(cid), GUARD_READY(),
        S(`INSERT INTO body_measurements (customer_id, measured_date, source_raw, origin, weight_kg, entered_by, client_req_id, created_at, updated_at, rev)
           VALUES (?, ?, 'self', 'd1', ?, ?, ?, ?, ?, 1)`, cid, date, v.weight_kg, enteredBy || 'line', crid, now, now)];
      resultSql = `json_object('id', last_insert_rowid())`;
    } else if (op === 'addInBody') {
      const v = readMeasureValues(b.values || {});
      stmts = [GUARD_TARGET(cid), GUARD_READY(),
        S(`INSERT INTO body_measurements (customer_id, measured_date, source_raw, origin, ${MCOLS.join(', ')}, entered_by, client_req_id, created_at, updated_at, rev)
           VALUES (?, ?, 'inbody', 'd1', ${MCOLS.map(() => '?').join(', ')}, ?, ?, ?, ?, 1)`,
          cid, date, ...MCOLS.map((k) => v[k]), enteredBy || 'trainer', crid, now, now)];
      resultSql = `json_object('id', last_insert_rowid())`;
    } else {
      //   体脂肪率（設計28 3-1）：origin='sheet' の行は書き換えない。d1 の行があれば更新、無ければ known_weight_kg で作る
      const pct = Number(b.fatPct);
      if (!Number.isFinite(pct) || pct < 3 || pct > 60) throw new RangeError('OUT_OF_RANGE');
      const p = Math.round(pct * 10) / 10;
      const known = (b.knownWeightKg == null || b.knownWeightKg === '') ? null : Number(b.knownWeightKg);
      if (known !== null && !(known >= 20 && known <= 250)) throw new RangeError('OUT_OF_RANGE');
      stmts = [GUARD_TARGET(cid), GUARD_READY(),
        //   どちらも無い＝「先に体重を」（NOT_FOUND で全体を巻き戻す）
        S(`INSERT INTO karte_guard (target) SELECT 1 WHERE ? IS NULL AND NOT EXISTS (${LAST_D1_OF_DAY})`, known, cid, date),
        //   1：d1 の行を1文で更新（除脂肪は対象行の体重から同じ文で計算）
        S(`UPDATE body_measurements SET body_fat_pct = ?, lean_kg = ROUND(weight_kg * (1 - ? / 100.0), 1), rev = rev + 1, updated_at = ?
            WHERE id = (${LAST_D1_OF_DAY})`, p, p, now, cid, date),
        //   2：d1 の行が無いときだけ、体重つきで作る（1が更新していれば NOT EXISTS が偽）
        S(`INSERT INTO body_measurements (customer_id, measured_date, source_raw, origin, weight_kg, body_fat_pct, lean_kg, entered_by, client_req_id, created_at, updated_at, rev)
           SELECT ?, ?, 'self', 'd1', ?, ?, ROUND(? * (1 - ? / 100.0), 1), ?, ?, ?, ?, 1
            WHERE ? IS NOT NULL AND NOT EXISTS (${LAST_D1_OF_DAY})`,
          cid, date, known, p, known, p, enteredBy || 'line', crid, now, now, known, cid, date)];
      resultSql = `(SELECT json_object('id', id, 'weightKg', weight_kg, 'fatPct', body_fat_pct, 'leanKg', lean_kg)
                      FROM body_measurements WHERE id = (${LAST_D1_OF_DAY.replace(/\?/g, () => '?')}))`;
    }
  } catch (e) { return out({ ok: false, code: 'BAD_VALUE', detail: e && e.message }, 400); }

  const hash = await sha256(JSON.stringify({ op, cid, date, w: b.weightKg, f: b.fatPct, v: b.values, k: b.knownWeightKg }));
  const prev = await env.DB.prepare(`SELECT payload_hash, result_json FROM body_requests WHERE channel = ? AND client_req_id = ?`).bind(channel, crid).first();
  if (prev) return prev.payload_hash === hash ? out({ ok: true, replayed: true, result: safeParse(prev.result_json) }) : out({ ok: false, code: 'REQ_REUSED' }, 409);

  //   ★body_requests は先頭に入れる（主キー違反＝同じ要求が既に完了 or 並行中 → 全体が巻き戻る）
  const reqArgs = op === 'addFat'
    ? [channel, crid, hash, now, cid, date]
    : [channel, crid, hash, now];
  const reqStmt = op === 'addFat'
    ? S(`INSERT INTO body_requests (channel, client_req_id, payload_hash, http_status, result_code, result_json, done_at)
         VALUES (?, ?, ?, 200, 'OK', NULL, ?)`, channel, crid, hash, now)
    : S(`INSERT INTO body_requests (channel, client_req_id, payload_hash, http_status, result_code, result_json, done_at)
         VALUES (?, ?, ?, 200, 'OK', NULL, ?)`, ...reqArgs);
  //   結果は本体の後で同じ batch の中で書き込む（作った id は本体の後でしか分からない）
  const fillStmt = op === 'addFat'
    ? S(`UPDATE body_requests SET result_json = ${resultSql} WHERE channel = ? AND client_req_id = ?`, cid, date, channel, crid)
    : S(`UPDATE body_requests SET result_json = ${resultSql} WHERE channel = ? AND client_req_id = ?`, channel, crid);
  try {
    await env.DB.batch([reqStmt, ...stmts, fillStmt].map((x) => env.DB.prepare(x.sql).bind(...x.args)));
  } catch (e) {
    const g = guardOf(e);
    if (g) return out({ ok: false, code: g.code === 'NOT_FOUND' && op === 'addFat' ? 'NEED_WEIGHT_FIRST' : g.code }, g.status);
    if (/body_requests/.test(String(e && e.message))) {
      const p2 = await env.DB.prepare(`SELECT payload_hash, result_json FROM body_requests WHERE channel = ? AND client_req_id = ?`).bind(channel, crid).first();
      if (p2) return p2.payload_hash === hash ? out({ ok: true, replayed: true, result: safeParse(p2.result_json) }) : out({ ok: false, code: 'REQ_REUSED' }, 409);
    }
    try { console.error('[body] write failed', op); } catch (_) {}
    return out({ ok: false, code: 'INTERNAL' }, 500);
  }
  const saved = await env.DB.prepare(`SELECT result_json FROM body_requests WHERE channel = ? AND client_req_id = ?`).bind(channel, crid).first();
  return out({ ok: true, result: safeParse(saved && saved.result_json) });
}
function safeParse(s) { try { return s ? JSON.parse(s) : {}; } catch (_) { return {}; } }

// ================================================================ /body/freeze
//   op: 'begin' { freezeId, counts:{sheet:n}, hashes:{sheet:h} }
//       'rows'  { freezeId, sheet, startOrder, rows:[…]、hashNow }   ★GAS が凍結用シートの行数とハッシュを毎回確かめてから送る
//       'state' { freezeId, state:'copied'|'verified'|'failed', note }
const SHEETS = ['body_log', 'meal_goals', 'goal_phases'];
const NEXT = { frozen: ['copying', 'failed'], copying: ['copying', 'copied', 'failed'], copied: ['verified', 'failed'], verified: ['failed'], failed: [] };

export async function handleBodyFreeze(request, env) {
  const deny = requireSecret(request, env);
  if (deny) return deny;
  const rj = await readJson(request);
  if (rj.error) return out({ ok: false, code: rj.error }, 400);
  const b = rj.body, op = String(b.op || ''), fz = String(b.freezeId || '');
  if (!/^[A-Za-z0-9_-]{6,40}$/.test(fz)) return out({ ok: false, code: 'BAD_FREEZE_ID' }, 400);
  const now = Date.now();
  const cur = await env.DB.prepare(`SELECT * FROM body_freeze WHERE freeze_id = ?`).bind(fz).first();

  if (op === 'begin') {
    if (cur) return out({ ok: false, code: 'EXISTS', state: cur.state }, 409);
    const counts = b.counts || {}, hashes = b.hashes || {};
    for (const s of SHEETS) if (!Number.isInteger(counts[s]) || counts[s] < 0 || typeof hashes[s] !== 'string') return out({ ok: false, code: 'BAD_COUNTS' }, 400);
    await env.DB.prepare(`INSERT INTO body_freeze (freeze_id, state, counts_json, hashes_json, copied_json, started_at) VALUES (?, 'frozen', ?, ?, '{}', ?)`)
      .bind(fz, JSON.stringify(counts), JSON.stringify(hashes), now).run();
    return out({ ok: true, state: 'frozen' });
  }
  if (!cur) return out({ ok: false, code: 'NO_FREEZE' }, 404);

  if (op === 'state') {
    const to = String(b.state || '');
    if (!(NEXT[cur.state] || []).includes(to)) return out({ ok: false, code: 'BAD_TRANSITION', from: cur.state, to }, 409);
    if (to === 'copied') {
      //   ★全シートを最後まで写したか（写した位置＝行数）を確かめてから
      const counts = safeParse(cur.counts_json), copied = safeParse(cur.copied_json);
      for (const s of SHEETS) if (Number(copied[s] || 0) !== Number(counts[s] || 0)) return out({ ok: false, code: 'NOT_COMPLETE', sheet: s }, 409);
    }
    await env.DB.prepare(`UPDATE body_freeze SET state = ?, note = ?, finished_at = ? WHERE freeze_id = ? AND state = ?`)
      .bind(to, b.note == null ? null : String(b.note).slice(0, 500), (to === 'verified' || to === 'failed') ? now : null, fz, cur.state).run();
    return out({ ok: true, state: to });
  }

  if (op === 'rows') {
    if (!['frozen', 'copying'].includes(cur.state)) return out({ ok: false, code: 'BAD_STATE', state: cur.state }, 409);
    const sheet = String(b.sheet || '');
    if (!SHEETS.includes(sheet)) return out({ ok: false, code: 'BAD_SHEET' }, 400);
    //   凍結用シートが変わっていないこと（GAS が送る今のハッシュと begin のハッシュ）
    const hashes = safeParse(cur.hashes_json);
    if (String(b.hashNow || '') !== String(hashes[sheet] || '')) {
      await env.DB.prepare(`UPDATE body_freeze SET state = 'failed', note = ?, finished_at = ? WHERE freeze_id = ?`).bind('HASH_CHANGED:' + sheet, now, fz).run();
      return out({ ok: false, code: 'HASH_CHANGED' }, 409);
    }
    const copied = safeParse(cur.copied_json);
    const start = Number(b.startOrder);
    if (start !== Number(copied[sheet] || 0)) return out({ ok: false, code: 'BAD_POSITION', expected: Number(copied[sheet] || 0) }, 409);
    const rows = Array.isArray(b.rows) ? b.rows : [];
    if (rows.length > 500) return out({ ok: false, code: 'TOO_MANY' }, 400);
    const stmts = [];
    const bad = [];
    rows.forEach((r, i) => {
      const order = start + i;
      const key = `${fz}:${sheet}:${order}`;
      const st = toStmt(sheet, r, key, order, now);
      if (st && st.bad) bad.push(order); else if (st) stmts.push(st);
    });
    if (bad.length) return out({ ok: false, code: 'OUT_OF_RANGE', orders: bad.slice(0, 20) }, 422);
    copied[sheet] = start + rows.length;
    stmts.push(S(`UPDATE body_freeze SET state = 'copying', copied_json = ? WHERE freeze_id = ? AND state IN ('frozen', 'copying')`, JSON.stringify(copied), fz));
    try {
      await env.DB.batch(stmts.map((x) => env.DB.prepare(x.sql).bind(...x.args)));
    } catch (e) {
      try { console.error('[body] freeze rows failed', sheet); } catch (_) {}
      return out({ ok: false, code: 'INTERNAL' }, 500);
    }
    return out({ ok: true, copied: copied[sheet] });
  }
  return out({ ok: false, code: 'BAD_OP' }, 400);
}

//   シートの1行 → D1 の文。空の行（customer_id が無い）は写さないが、順番は進める（null を返す）
function toStmt(sheet, r, key, order, now) {
  const a = Array.isArray(r) ? r : [];
  const cid = String(a[0] == null ? '' : a[0]).trim();
  if (!cid) return null;
  const n = (x) => (Number(x) || null);   // GAS の Number(x)||null と同じ（0 は無い扱い）
  const d = (x) => (isRealDate(String(x || '')) ? String(x) : null);
  if (sheet === 'body_log') {
    //   [customer_id, 日付(YYYY-MM-DD), 体重, 体脂肪率, 除脂肪, 体水分, 内臓脂肪, 測定元, 入力者, 記録日時, 備考]
    const date = d(a[1]);
    if (!date) return null;
    const v = { weight_kg: n(a[2]), body_fat_pct: n(a[3]), lean_kg: n(a[4]), body_water_l: n(a[5]), visceral_fat: n(a[6]) };
    for (const k of Object.keys(v)) {
      if (v[k] == null) continue;
      const [mn, mx] = MEASURE_RANGES[k];
      if (v[k] < mn || v[k] > mx) return { bad: true };
    }
    return S(`INSERT INTO body_measurements (customer_id, measured_date, source_raw, origin, origin_key, sheet_order,
                weight_kg, body_fat_pct, lean_kg, body_water_l, visceral_fat, entered_by, created_at, updated_at, rev)
              VALUES (?, ?, ?, 'sheet', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
              ON CONFLICT(origin_key) DO NOTHING`,
      cid, date, String(a[7] == null ? '' : a[7]).slice(0, 50), key, order,
      v.weight_kg, v.body_fat_pct, v.lean_kg, v.body_water_l, v.visceral_fat, String(a[8] == null ? '' : a[8]).slice(0, 50), now, now);
  }
  if (sheet === 'meal_goals') {
    //   [customer_id, 氏名, 開始, 終了, 性別, 生年月日, 身長, 活動, 開始体重, 開始除脂肪, 目標体重, …]  ★氏名は写さない
    return S(`INSERT INTO body_goals (customer_id, kind, start_date, end_date, start_weight, target_weight, origin, origin_key, sheet_order, rev, updated_at)
              VALUES (?, 'meal_goal', ?, ?, ?, ?, 'sheet', ?, ?, 1, ?) ON CONFLICT(origin_key) DO NOTHING`,
      cid, d(a[2]), d(a[3]), n(a[8]), n(a[10]), key, order, now);
  }
  //   goal_phases：[customer_id, phase_no, 種別, 開始, 終了, 日数, 開始体重, 目標体重, …, 状態(13)]
  return S(`INSERT INTO body_goals (customer_id, kind, phase_no, state, start_date, end_date, start_weight, target_weight, origin, origin_key, sheet_order, rev, updated_at)
            VALUES (?, 'phase', ?, ?, ?, ?, ?, ?, 'sheet', ?, ?, 1, ?) ON CONFLICT(origin_key) DO NOTHING`,
    cid, Number(a[1]) || 0, String(a[13] == null ? '' : a[13]).slice(0, 20), d(a[3]), d(a[4]), n(a[6]), n(a[7]), key, order, now);
}

// ================================================================ /body/series
//   mode 'sheet' { freezeId, customerId }：その凍結から写した行だけで計算（突き合わせ用）
//   mode 'live'  { customerId, days }：今の答え（いちばん新しい verified の凍結＋d1）。LINE ボットの「前回」用
export async function handleBodySeries(request, env) {
  const deny = requireSecret(request, env);
  if (deny) return deny;
  const rj = await readJson(request);
  if (rj.error) return out({ ok: false, code: rj.error }, 400);
  const b = rj.body, cid = String(b.customerId || ''), mode = String(b.mode || '');
  if (!cid) return out({ ok: false, code: 'BAD_REQUEST' }, 400);
  let fz = String(b.freezeId || '');
  if (mode === 'live') {
    //   ★verified の凍結だけ（未確認の写しを LINE ボットに返さない）。無ければ d1 の行だけ
    const r = await env.DB.prepare(`SELECT freeze_id FROM body_freeze WHERE state = 'verified' ORDER BY started_at DESC LIMIT 1`).first();
    fz = r ? String(r.freeze_id) : '';
  } else if (mode !== 'sheet' || !fz) return out({ ok: false, code: 'BAD_MODE' }, 400);
  const like = fz ? fz + ':%' : '__none__';
  const originCond = mode === 'sheet' ? `origin = 'sheet' AND origin_key LIKE ?` : `(origin = 'd1' OR (origin = 'sheet' AND origin_key LIKE ?))`;
  const [m, g] = await Promise.all([
    env.DB.prepare(`SELECT * FROM body_measurements WHERE customer_id = ? AND deleted_at IS NULL AND ${originCond}`).bind(cid, like).all(),
    env.DB.prepare(`SELECT * FROM body_goals WHERE customer_id = ? AND deleted_at IS NULL AND ${originCond}`).bind(cid, like).all(),
  ]);
  let rows = synthesizeBody(m.results || []);
  if (mode === 'live' && Number(b.days) > 0) rows = rows.slice(-Math.min(400, Number(b.days)));
  return out({ ok: true, freezeId: fz || null, rows, goal: pickGoalLine(g.results || []) });
}
