// 録音の文字起こしの AI 下書き（設計39・k_aiDraft）の日次点検の材料・2026-11-12
//   呼ぶのは /quota/status?karteai=1（合言葉 X-Ingest-Secret）＝GAS の dailyHealthCheck が1日1回読む
//
//   返すもの：前日（JST）の結果別件数・確かめられない数字の割合・1日の回数（karte_ai_usage）と上限・上限到達・
//             切替の状態（mode・許可の人数・鍵の有無の真偽値）・トレーナーの読みの登録数（数だけ）
//   ★返さないもの：trainer_id・氏名・読み・鍵の値・中身（karte_ai_log はもともと中身を持たない・I76）
//   ★読めないときは table:'error'・数を出さない（0件と答えない＝MODEL §0）
import { aiDailyMax, AI_BUILD, isKanaName } from '../routes/karte-ai.js';

const H = 3600000;
function jstDayStart(ms) {
  const d = new Date(Number(ms) + 9 * H);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 9 * H;
}
function dayKey(startMs) {
  const d = new Date(startMs + 9 * H);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function modeOf(env) {
  const m = String((env && env.KARTE_AI_DRAFT) || '');
  return m === 'on' || m === 'allow' ? m : 'off';   // aiDraftOn と同じ厳密一致（打ち間違いは off）
}

export async function buildKarteAiHealth(env, nowMs) {
  const end = jstDayStart(nowMs);
  const start = end - 24 * H;
  const mode = modeOf(env);
  const out = {
    day: dayKey(start), mode,
    allowCount: mode === 'allow' ? String(env.KARTE_AI_DRAFT_TRAINERS || '').split(',').map((x) => x.trim()).filter(Boolean).length : 0,
    keySet: !!(env && env.ANTHROPIC_API_KEY),
    dailyMax: aiDailyMax(env),
    build: AI_BUILD,
  };
  try {
    const r = await env.DB.prepare(
      `SELECT result, COUNT(*) AS n,
              SUM(CASE WHEN result = 'ok' AND n_sets IS NOT NULL THEN n_unverified ELSE 0 END) AS unv,
              SUM(CASE WHEN result = 'ok' AND n_sets IS NOT NULL THEN n_sets ELSE 0 END) AS sets,
              SUM(CASE WHEN result = 'ok' AND n_sets IS NOT NULL THEN 1 ELSE 0 END) AS runs,
              SUM(CASE WHEN result = 'ok' AND n_sets IS NULL THEN 1 ELSE 0 END) AS runsNoSets
         FROM karte_ai_log WHERE at >= ? AND at < ? GROUP BY result`
    ).bind(start, end).all();
    const byResult = {}, unverified = { unv: 0, sets: 0, runs: 0, runsNoSets: 0 };
    let total = 0;
    for (const x of (r.results || [])) {
      const n = Number(x.n || 0);
      byResult[String(x.result)] = n; total += n;
      unverified.unv += Number(x.unv || 0); unverified.sets += Number(x.sets || 0);
      unverified.runs += Number(x.runs || 0); unverified.runsNoSets += Number(x.runsNoSets || 0);
    }
    const u = await env.DB.prepare('SELECT n FROM karte_ai_usage WHERE day = ?').bind(out.day).first();
    const usage = u ? Number(u.n || 0) : 0;
    Object.assign(out, { table: 'ok', total, byResult, unverified, usage,
      limitHit: (byResult.daily_limit || 0) > 0 || usage >= out.dailyMax });
  } catch (_) {
    out.table = 'error';
  }
  try {
    //   ★「未登録」は伏せる処理と同じ判定（isKanaName）で数える＝伏せる処理が使わない値（数字・英字・長すぎ）も未登録（関門② 2周目）。
    //     値はここで数えるだけで、外へは数しか出さない
    const k = await env.DB.prepare('SELECT kana FROM trainers WHERE active = 1').all();
    const rows = (k && k.results) || [];
    out.kana = { table: 'ok', active: rows.length, missing: rows.filter((r) => !isKanaName(r && r.kana)).length };
  } catch (_) {
    out.kana = { table: 'error' };
  }
  return { karteAi: out };
}
