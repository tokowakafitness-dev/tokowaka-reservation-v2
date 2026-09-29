// 起動時の一括取得。いまGASで5回・21秒かかっている範囲を1回にまとめる。
//   会員 → 自分のホーム（残数）・自分の予約・トレーナー名簿
//   トレーナー → 担当顧客の一覧・トレーナー名簿
//
// 残数について（第1段階）：
//   残数の計算（Allocate.js）はまだGASにある。GASが計算結果を KV の home:<customerId> に
//   押し出し、ここではそれを読むだけにする。D1が契約の真実になる第2段階で、
//   Allocate.js をWorkerへ移してD1から直接計算する。
//   stale（鮮度）を必ず返し、古ければ画面側が「更新中」を出せるようにする。

import { customerScopeSql } from '../perms.js';

const HOME_TTL_WARN_MS = 10 * 60 * 1000;   // 10分より古ければ鮮度を疑う
// ★これより古い写しは答えない（GASに聞き直す）。
//   端末の保護（書き込み後35分）は、別の端末や別の人の予約までは知らない。
//   古い残数を見せるより、遅くても正しいほうがよい。
export const HOME_TTL_HARD_MS = 40 * 60 * 1000;

export async function readTrainers(env) {
  const cached = await env.KV.get('trainers', 'json');
  if (cached) return cached;
  const r = await env.DB.prepare(
    'SELECT trainer_id AS id, name, hidden FROM trainers WHERE active = 1 ORDER BY name'
  ).all();
  return r.results || [];
}

function monthKeyJst(ms) {
  const d = new Date(ms + 9 * 3600 * 1000);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

/**
 * 残数を返す。targetMs（予約しようとしている日時）を渡すと、その月の残数を返す。
 *   25日以降は翌月の枠が開くため、9月の残数と10月の残数は別物になる。
 *   GASが「今月分」と「翌月分」の2つを押し出しているので、そこから選ぶ。
 *   どちらの月でもないとき（翌々月など）は null を返す＝画面はGASに聞き直す。
 */
export async function readHome(env, customerId, targetMs) {
  if (!customerId) return null;
  const row = await env.DB.prepare('SELECT payload, computed_at FROM member_home WHERE customer_id = ?')
    .bind(customerId).first();
  if (!row) return null;
  let p;
  try { p = JSON.parse(row.payload); } catch (_) { return null; }

  let home = p.current;
  let month = p.currentMonth;
  if (targetMs) {
    const want = monthKeyJst(targetMs);
    if (want === p.currentMonth) { home = p.current; month = p.currentMonth; }
    else if (want === p.nextMonth && p.next) { home = p.next; month = p.nextMonth; }
    else return null;                      // 持っていない月＝答えない（間違った残数を返さない）
  }
  if (!home) return null;

  // ★鮮度は「その行がいつ計算されたか」だけで見る。
  //   全体の同期時刻と大きい方を取ってはいけない。押し出しは6分で打ち切られ、
  //   計算に失敗した会員は飛ばされる。全体の時刻で見ると、届かなかった会員の
  //   古い行まで「たった今の情報」に若返り、40分の安全弁が働かなくなる
  //   （2026-09-29 に本番で見つかった穴）。
  //   代わりに、押し出しのたびに全員ぶんの computed_at を書き直している
  //   （39行なのでD1の書き込み枠には影響しない）。
  const computedAt = Number(row.computed_at || 0);
  if (!computedAt) return null;                 // 計算時刻の無い行は信用しない
  const age = Date.now() - computedAt;
  return { ...home, month, computedAt, stale: age > HOME_TTL_WARN_MS, ageMs: age };
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
        WHERE ${customerScopeSql(who, 'c').where}
          AND (c.contract_status IS NULL OR c.contract_status <> '退会')
        GROUP BY c.customer_id
        ORDER BY upcoming DESC, c.kana`;

  const stmt = owner
    ? env.DB.prepare(sql).bind(now)
    : env.DB.prepare(sql).bind(now, ...customerScopeSql(who, 'c').args);
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
