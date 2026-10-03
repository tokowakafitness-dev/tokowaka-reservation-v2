// 「古い写しを新しいと判定していないか」を固定する。
//
//   2026-09-29 に本番で見つかった穴：
//     鮮度を Math.max(その行の時刻, 全体の同期時刻) で見ていた。
//     押し出しは6分で打ち切られ、計算に失敗した会員は飛ばされる。
//     つまり「Aさんの行は昨日のまま」でも「全体の同期時刻は今」なら
//     Aさんの残数が「数秒前の情報」と判定され、40分の安全弁が働かなかった。
//
//   鮮度は必ず「その行が最後に計算された時刻」だけで見る。
//
//   実行: node worker/test/staleness.test.js
import { readHome, HOME_TTL_HARD_MS } from '../src/routes/boot.js';
import { homePayload } from './_home-fixture.js';

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log(`❌ ${name}\n   got : ${g}\n   want: ${w}`); }
}
function ok(name, cond) { cond ? pass++ : (fail++, console.log(`❌ ${name}`)); }

const payload = homePayload({ current: { monthlyRemaining: 1 } });

function envWith({ computedAt, syncedAt }) {
  return {
    DB: {
      prepare(q) {
        const isSync = /sync_state/.test(q);
        return {
          bind() { return this; },
          async first() {
            if (isSync) return syncedAt == null ? null : { synced_at: syncedAt };
            return { payload, computed_at: computedAt };
          },
        };
      },
    },
  };
}

const MIN = 60000;
const now = Date.now();

// ---------- 1. その行が新しければ答える ----------
{
  const h = await readHome(envWith({ computedAt: now - 5 * MIN, syncedAt: now }), 'c1');
  ok('5分前の行は答える', h !== null);
  ok('経過は行の時刻から測る', Math.abs(h.ageMs - 5 * MIN) < 2000);
}

// ---------- 2. ★行が古ければ、全体の同期が新しくても古いと判定する ----------
{
  // 押し出しが時間切れでこの会員まで届かなかった状況。
  // 行は1日前、全体の同期時刻はたった今。
  const h = await readHome(envWith({ computedAt: now - 24 * 60 * MIN, syncedAt: now }), 'c1');
  ok('★全体の同期時刻で若返らせない', h.ageMs > HOME_TTL_HARD_MS);
  ok('★1日前として測る', Math.abs(h.ageMs - 24 * 60 * MIN) < 5000);
}

// ---------- 3. ★40分より古ければ readHomeSafe が返さない ----------
{
  const { default: _ } = { default: null };
  const mod = await import('../src/routes/compat.js');
  // compat 側の入口を通して、返さないことを確かめる
  const env = envWith({ computedAt: now - 41 * MIN, syncedAt: now });
  env.DB.prepare = ((orig) => (q) => {
    if (/FROM customers/.test(q)) return { bind() { return this; }, async first() { return { name: 'テスト' }; } };
    return orig(q);
  })(env.DB.prepare.bind(env.DB));
  const r = await mod.compatCustomerHome({ env, body: { customerId: 'c1' }, who: { role: 'customer', customerId: 'c1' } });
  eq('★41分前ならGASへ落とす', r._fallback, true);
}

// ---------- 4. ちょうど40分の境目 ----------
{
  const env = envWith({ computedAt: now - (HOME_TTL_HARD_MS - 5000), syncedAt: now });
  const h = await readHome(env, 'c1');
  ok('40分未満は答える', h.ageMs < HOME_TTL_HARD_MS);
}

// ---------- 5. 全体の同期時刻が無くても、行の時刻で判定できる ----------
{
  const h = await readHome(envWith({ computedAt: now - 3 * MIN, syncedAt: null }), 'c1');
  ok('★同期の記録が無くても答えられる', h !== null);
  ok('行の時刻で測る', Math.abs(h.ageMs - 3 * MIN) < 2000);
}

// ---------- 6. 行の時刻が無ければ（壊れた行）答えない ----------
{
  const h = await readHome(envWith({ computedAt: null, syncedAt: now }), 'c1');
  ok('★計算時刻の無い行は古いものとして扱う', h === null || h.ageMs > HOME_TTL_HARD_MS);
}

console.log(`\n写しの鮮度 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
