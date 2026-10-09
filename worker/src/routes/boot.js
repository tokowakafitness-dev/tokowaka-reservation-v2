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
// 残数として使える形か。**欠けているものを 0 に変換しない**ための関門。
//   JSONとして読めるだけでは足りない（上の readHome の★を参照）。
function _homeShapeOk(h) {
  if (!h || typeof h !== 'object' || Array.isArray(h)) return false;
  if (!('type' in h)) return false;

  // 契約が無い会員は type:null。これは**正常**（締めすぎると全員GASに落ちる）。
  if (h.type === null) return true;

  // 知らない種別は信用しない。GASが作るのは 'monthly' / 'ticket' / 'both' のどれか。
  if (h.type !== 'monthly' && h.type !== 'ticket' && h.type !== 'both') return false;

  // ★種別だけ合っていても中身が欠けていれば、既定値で 0 に落ちて「残り0回」になる
  //   （2026-10-03 Codex指摘。`{type:'monthly'}` が素通りしていた）。
  //   画面が必ず読む項目が、型として揃っていることを確かめる。
  if (typeof h.hasNormalRoute !== 'boolean') return false;
  if (!Array.isArray(h.ticketPacks)) return false;          // 月額でも [] が入る
  // 月額の経路があるなら回数のキーが要る。**値が null なのは正常**（上限なしの契約）。
  //   キーごと無いのは形が壊れている。
  if (h.type !== 'ticket' && !('monthlyRemaining' in h)) return false;
  // チケットの経路があるなら残枚数のキーが要る。
  if (h.type !== 'monthly' && !('ticketRemaining' in h)) return false;
  return true;
}

/**
 * 残数の写しを読む。**いまの振る舞いは一切変えない。**
 *   第4引数 opts に { shadow: true, ctx, entry } を渡した入口だけ、
 *   応答のあとに「D1から作った値」と比べる（段階3-b 手順3・設計12）。
 *   顧客に返すのは**いつでも写し**。
 */
export async function readHome(env, customerId, targetMs, opts) {
  const d = await readHomeDiag(env, customerId, targetMs);
  if (opts && opts.shadow === true) {
    //   ★例外を外に出さない。顧客の画面を壊してはいけない。
    try {
      const { scheduleShadow } = await import('../lib/remain-shadow.js');
      scheduleShadow(env, {
        //   ★入口の意思をそのまま渡す（2026-10-09・関門②の指摘）。
        //     ここで落とすと scheduleShadow が必ず false を返し、
        //     モードを 'shadow' にしても**一度も比べない**。
        shadow: opts.shadow,
        customerId, targetMs, entry: opts.entry, ctx: opts.ctx,
        copyDiag: d, lang: opts.lang,
      });
    } catch (_) {}
  }
  return d.value;
}

/**
 * 上と同じものを読むが、**写しが使えなかった理由**も返す（shadow が見る）。
 *   { value, status, month, computedAt, ageMs }
 *     'ok' / 'no_customer' / 'no_row' / 'bad_json' / 'month_missing'
 *     / 'bad_shape' / 'no_computed_at'
 *
 *   ★なぜ理由が要るか（2026-10-09・関門①の指摘）
 *     写しが使えない経路では、shadow が**一度も起動しない**（早期 return するため）。
 *     ところが「写しが壊れているのにD1なら答えられる」は、
 *     手順4（顧客に出す）でいちばん確かめたい場面である。
 */
export async function readHomeDiag(env, customerId, targetMs) {
  const none = (status) => ({ value: null, status, month: null, computedAt: null, ageMs: null });
  if (!customerId) return none('no_customer');
  const row = await env.DB.prepare('SELECT payload, computed_at FROM member_home WHERE customer_id = ?')
    .bind(customerId).first();
  if (!row) return none('no_row');
  let p;
  try { p = JSON.parse(row.payload); } catch (_) { return none('bad_json'); }

  let home = p.current;
  let month = p.currentMonth;
  if (targetMs) {
    const want = monthKeyJst(targetMs);
    if (want === p.currentMonth) { home = p.current; month = p.currentMonth; }
    else if (want === p.nextMonth && p.next) { home = p.next; month = p.nextMonth; }
    else return none('month_missing');     // 持っていない月＝答えない（間違った残数を返さない）
  }
  if (!home) return none('month_missing');
  // ★JSONとして読めることと、残数として使えることは別（2026-10-03・Codex指摘）。
  //   `{"current":{}}` でも JSON.parse は通り、p.current は truthy なので素通りしていた。
  //   その先で pairRemaining || 0 ・ normalTicketRemaining || 0 と既定値に落ちるため、
  //   **壊れた写しが「残り0回」として顧客に出る。** 写しが新しければ安全弁も働かない。
  //   GASが押し出す残数には必ず type が入る（契約が無い会員は type:null）。
  //   キーごと無いのは「形が壊れている」なので、読めなかったものとして扱う。
  if (!_homeShapeOk(home)) {
    const ca = Number(row.computed_at || 0);
    return { value: null, status: 'bad_shape', month,
             computedAt: ca || null, ageMs: ca ? (Date.now() - ca) : null };
  }

  // ★鮮度は「その行がいつ計算されたか」だけで見る。
  //   全体の同期時刻と大きい方を取ってはいけない。押し出しは6分で打ち切られ、
  //   計算に失敗した会員は飛ばされる。全体の時刻で見ると、届かなかった会員の
  //   古い行まで「たった今の情報」に若返り、40分の安全弁が働かなくなる
  //   （2026-09-29 に本番で見つかった穴）。
  //   代わりに、押し出しのたびに全員ぶんの computed_at を書き直している
  //   （39行なのでD1の書き込み枠には影響しない）。
  const computedAt = Number(row.computed_at || 0);
  if (!computedAt) return { value: null, status: 'no_computed_at', month, computedAt: null, ageMs: null };
  const age = Date.now() - computedAt;
  return {
    value: { ...home, month, computedAt, stale: age > HOME_TTL_WARN_MS, ageMs: age },
    status: 'ok', month, computedAt, ageMs: age,
  };
}

export async function routeBoot({ env, who, ctx }) {
  const now = Date.now();
  const trainers = await readTrainers(env);

  if (who.role === 'customer') {
    const [home, resv] = await Promise.all([
      //   ★この入口だけ shadow を有効にする（設計12 第3節の表）。
      //     ctx は index.js が全部の handler に渡しているので、
      //     「ctx があるから比べる」にはしない。**入口の意思を明示する。**
      readHome(env, who.customerId, undefined, { shadow: true, ctx, entry: 'boot' }),
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
