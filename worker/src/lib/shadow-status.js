// shadow の心拍（動いていることを確かめる）・2026-10-09
//
//   設計：ops/design/12-shadow-compare.md 第8節
//
//   ★なぜ要るのか
//     「食い違い0件」は、次の**全部**で同じ0件になる。
//       人が来なかった／モードが off／opts の渡し忘れ／
//       waitUntil より前に return／D1の読み取りが落ちた／表が無い／
//       書き込み直後35分の迂回でWorkerに来ていない
//     だから「比べた回数」と「結末を記録できなかった回数」を**入口ごとに**出す。

const ENTRIES = ['boot', 'compat_member', 'compat_home'];

/** 表があるか（無くても落とさない） */
async function tableOk(env, name) {
  try {
    await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${name}`).first();
    return true;
  } catch (_) { return false; }
}

export async function buildShadowStatus(env, opts) {
  const o = opts || {};
  const day = String(o.day || dayKeyJstNow());
  const mode = String((env && env.LB_D1_REMAIN_MODE) || 'off');

  // ---- preflight（表と世代）----
  const [slotOk, aggOk, sampleOk, verOk] = await Promise.all([
    tableOk(env, 'remain_shadow_slot'),
    tableOk(env, 'remain_shadow'),
    tableOk(env, 'remain_shadow_sample'),
    tableOk(env, 'customer_sync_version'),
  ]);
  const preflight = {
    mode,
    tables: { remain_shadow_slot: slotOk, remain_shadow: aggOk, remain_shadow_sample: sampleOk,
              customer_sync_version: verOk },
    ready: slotOk && aggOk && sampleOk && verOk && mode === 'shadow',
  };
  if (verOk) {
    const f = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM customer_sync_version
        WHERE source_version = built_version AND built_version > 0`
    ).first();
    preflight.freshCustomers = Number((f && f.n) || 0);
    //   ★0名なら、shadow は全部 'not_built' になる。先に作り直しが要る
    if (!preflight.freshCustomers) preflight.ready = false;
  }
  if (o.preflightOnly) return { ok: true, day, preflight };
  if (!(slotOk && aggOk)) return { ok: true, day, preflight, note: 'まだ表が入っていません' };

  // ---- 入口ごとの心拍 ----
  //   ★attempted は**枠の表の COUNT**（集計表に _attempted を書かない）。
  //     枠を取ってから結果を書く前に処理が消えると、集計表には何も残らない。
  //     枠の表から数えれば、枠を取った瞬間が必ず残る＝incomplete に現れる。
  //   ★「何人を比べたか」も数える（2026-10-10）。
  //     回数だけでは合格を判定できない。200回比べても、全部が同じ3名なら
  //     残り37名は一度も比べていない＝「全員で一致」とは言えない。
  //     食い違いは**特定の会員・特定の契約の形**で起きる
  //     （期限の差も1名だった）。だから**比べられた会員の数**が条件に要る。
  const [slots, aggs, members] = await Promise.all([
    env.DB.prepare(
      `SELECT entry, COUNT(*) AS n, MAX(claimed_at) AS last_at,
              SUM(CASE WHEN sample_key LIKE 'ver:%' THEN 1 ELSE 0 END) AS verSlots,
              COUNT(DISTINCT customer_id) AS members
         FROM remain_shadow_slot WHERE day = ? GROUP BY entry`
    ).bind(day).all(),
    env.DB.prepare(
      `SELECT entry, field, SUM(n) AS n, COUNT(DISTINCT customer_id) AS members,
              MAX(last_at) AS last_at, MAX(last_value) AS sample
         FROM remain_shadow WHERE day = ? GROUP BY entry, field`
    ).bind(day).all(),
    //   ★比べ終わった会員の数（入口をまたいだ実数）と、契約がある会員の数
    env.DB.prepare(
      `SELECT
         (SELECT COUNT(DISTINCT customer_id) FROM remain_shadow
           WHERE day = ? AND field = '_completed') AS comparedMembers,
         (SELECT COUNT(DISTINCT customer_id) FROM remain_shadow_slot
           WHERE day = ?) AS slotMembers,
         (SELECT COUNT(DISTINCT customer_id) FROM calc_contract_rows) AS targetMembers`
    ).bind(day, day).first(),
  ]);

  const byEntry = {};
  const ent = (e) => (byEntry[e] = byEntry[e] || {
    attempted: 0, lastAttemptedAt: null, verSlots: 0,
    completed: 0, failed: 0, lastCompletedAt: null, lastFailedAt: null,
    preSkipped: {}, postSkipped: {}, ageBands: {}, diffs: {}, oneSided: 0,
  });
  for (const e of ENTRIES) ent(e);

  for (const r of (slots.results || [])) {
    const x = ent(String(r.entry));
    x.attempted = Number(r.n || 0);
    x.lastAttemptedAt = r.last_at == null ? null : Number(r.last_at);
    x.verSlots = Number(r.verSlots || 0);
    x.members = Number(r.members || 0);   // この入口で枠を取れた会員の数
  }
  for (const r of (aggs.results || [])) {
    const x = ent(String(r.entry));
    const f = String(r.field), n = Number(r.n || 0);
    if (f === '_completed') { x.completed = n; x.lastCompletedAt = Number(r.last_at || 0) || null; }
    else if (f === '_failed') { x.failed = n; x.lastFailedAt = Number(r.last_at || 0) || null; }
    else if (f === '_one_sided') { x.oneSided = n; }
    else if (f.indexOf('_pre:') === 0) { x.preSkipped[f.slice(5)] = n; }
    else if (f.indexOf('_post:') === 0) { x.postSkipped[f.slice(6)] = n; }
    else if (f.indexOf('_age:') === 0) { x.ageBands[f.slice(5)] = n; }
    else { x.diffs[f] = { n, members: Number(r.members || 0), sample: r.sample || null }; }
  }

  //   ★incomplete ＝ 結末を記録できなかった回数（いちばん見たいもの）
  //     preclaim は枠を使っていないので引かない。
  for (const e of Object.keys(byEntry)) {
    const x = byEntry[e];
    let post = 0;
    for (const k of Object.keys(x.postSkipped)) post += x.postSkipped[k];
    x.postSkippedTotal = post;
    x.incomplete = x.attempted - x.completed - x.failed - post;
  }

  //   全体の要約（オーナーや私が最初に見る3行ぶん）
  let attempted = 0, completed = 0, failed = 0, incomplete = 0, diffKinds = {};
  for (const e of Object.keys(byEntry)) {
    const x = byEntry[e];
    attempted += x.attempted; completed += x.completed; failed += x.failed; incomplete += x.incomplete;
    for (const f of Object.keys(x.diffs)) {
      diffKinds[f] = diffKinds[f] || { n: 0, members: 0, sample: null };
      diffKinds[f].n += x.diffs[f].n;
      diffKinds[f].members += x.diffs[f].members;
      if (!diffKinds[f].sample) diffKinds[f].sample = x.diffs[f].sample;
    }
  }

  //   ★合格の判定に要る3つ（回数・人数・対象の人数）
  const comparedMembers = Number((members && members.comparedMembers) || 0);
  const targetMembers = Number((members && members.targetMembers) || 0);

  return {
    ok: true, day, preflight,
    total: { attempted, completed, failed, incomplete, diffFields: Object.keys(diffKinds).length,
             //   ★比べ終わった会員の数 ／ 枠を取れた会員の数 ／ 契約がある会員の数
             comparedMembers, slotMembers: Number((members && members.slotMembers) || 0),
             targetMembers },
    diffFields: diffKinds,
    entries: byEntry,
  };
}

function dayKeyJstNow() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
