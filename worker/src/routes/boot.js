// 起動時の一括取得。いまGASで5回・21秒かかっている範囲を1回にまとめる。
//   会員 → 自分のホーム（残数）・自分の予約・トレーナー名簿
//   トレーナー → 担当顧客の一覧・トレーナー名簿
//
// 残数について（第1段階）：
//   残数の計算（Allocate.js）はまだGASにある。GASが計算結果を KV の home:<customerId> に
//   押し出し、ここではそれを読むだけにする。D1が契約の真実になる第2段階で、
//   Allocate.js をWorkerへ移してD1から直接計算する。
//   stale（鮮度）を必ず返し、古ければ画面側が「更新中」を出せるようにする。

const HOME_TTL_WARN_MS = 10 * 60 * 1000;   // 10分より古ければ鮮度を疑う

export async function readTrainers(env) {
  const cached = await env.KV.get('trainers', 'json');
  if (cached) return cached;
  const r = await env.DB.prepare(
    'SELECT trainer_id AS id, name, hidden FROM trainers WHERE active = 1 ORDER BY name'
  ).all();
  return r.results || [];
}

export async function readHome(env, customerId) {
  if (!customerId) return null;
  const home = await env.KV.get('home:' + customerId, 'json');
  if (!home) return null;
  const age = Date.now() - (home.computedAt || 0);
  return { ...home, stale: age > HOME_TTL_WARN_MS, ageMs: age };
}

export async function routeBoot({ env, who }) {
  const now = Date.now();
  const trainers = await readTrainers(env);

  if (who.role === 'customer') {
    const [home, resv] = await Promise.all([
      readHome(env, who.customerId),
      env.DB.prepare(
        `SELECT reservation_id, trainer_id, start_at, end_at, kind, attendee_count, status
           FROM reservations
          WHERE customer_id = ? AND start_at >= ? AND status = 'booked'
          ORDER BY start_at LIMIT 50`
      ).bind(who.customerId, now).all(),
    ]);
    return {
      role: 'customer',
      name: who.name,
      customerId: who.customerId,
      defaultTrainerId: who.trainerId,
      trainers: trainers.filter((t) => !t.hidden || String(t.id) === String(who.trainerId)),
      home,
      reservations: resv.results || [],
    };
  }

  // トレーナー／オーナー：担当顧客と、それぞれの今後の予約件数を1往復で取る
  const owner = who.role === 'owner';
  const sql = owner
    ? `SELECT c.customer_id, c.name, c.kana, c.default_trainer_id,
              COUNT(r.reservation_id) AS upcoming
         FROM customers c
         LEFT JOIN reservations r
           ON r.customer_id = c.customer_id AND r.start_at >= ? AND r.status = 'booked'
        WHERE c.contract_status IS NULL OR c.contract_status <> '退会'
        GROUP BY c.customer_id
        ORDER BY upcoming DESC, c.kana`
    : `SELECT c.customer_id, c.name, c.kana, c.default_trainer_id,
              COUNT(r.reservation_id) AS upcoming
         FROM customers c
         LEFT JOIN reservations r
           ON r.customer_id = c.customer_id AND r.start_at >= ? AND r.status = 'booked'
        WHERE c.default_trainer_id = ?
          AND (c.contract_status IS NULL OR c.contract_status <> '退会')
        GROUP BY c.customer_id
        ORDER BY upcoming DESC, c.kana`;

  const stmt = owner
    ? env.DB.prepare(sql).bind(now)
    : env.DB.prepare(sql).bind(now, who.trainerId);
  const customers = await stmt.all();

  let pending = 0;
  if (owner) {
    const p = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM contracts WHERE status = 'pending_approval'"
    ).first();
    pending = (p && p.n) || 0;
  }

  return {
    role: who.role,
    name: who.name,
    trainerId: who.trainerId,
    trainers,
    customers: customers.results || [],
    pendingApprovals: pending,   // オーナーだけ意味を持つ（承認待ちの契約件数）
  };
}
