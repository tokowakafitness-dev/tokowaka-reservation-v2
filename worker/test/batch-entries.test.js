// まとめ取得（c_boot / c_customerCard）の検証
//
//   2026-10-03、本番の計測で通信15回のうち**86%がGASの3回**だった。
//     boot 6,168ms ／ customerCard 5,565ms ／ customerCard 8,312ms ＝ 20,045ms
//     （Workerの3回は 1,255 + 805 + 321 ＝ 2,381ms）
//   画面の _fetchBoot / _fetchCustomerCard は _apiGas を直接呼んでおり、
//   ?edge=1 を入れてもこの2回だけはGASのままだった。ここを塞ぐための窓口。
//
//   ★中身は新規実装ではなく既存の compat* を束ねただけ。だから検査するのは
//     「束ね方」であって、各パートの中身ではない（それは各自のテストが見ている）。
//
//   ★いちばん危ないのは「答えられなかったものを、空の成功に化かすこと」。
//     残数が読めないのに success:true を返せば、画面は「残り0回」と出す。
//     予約一覧が読めないのに success:true なら「ご予約はありません」と出る。
//     遅いより悪い。ここを徹底的に固定する。
//
//   実行: node worker/test/batch-entries.test.js

import * as compat from '../src/routes/compat.js';
import { homePayload } from './_home-fixture.js';
import { redact } from '../src/perms.js';

// 「わざと転ばせる」検査が warn を出すので、テストの出力は静かにしておく
console.warn = () => {};

let pass = 0, fail = 0;
function eq(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log(`❌ ${name}\n   got : ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`); }
}
function ok(name, cond, extra) { cond ? pass++ : (fail++, console.log(`❌ ${name}${extra ? '\n   ' + extra : ''}`)); }

const now = Date.now();
const HOME = homePayload({ current: { pairRemaining: 1 } });

// opts で「どれが読めないか」を切り替えられるようにする（部分的な故障を作るため）
function env(opts = {}) {
  return {
    DB: {
      prepare(q) {
        return {
          _a: [],
          bind(...a) { this._a = a.map(String); return this; },
          async first() {
            if (/sync_state/.test(q)) {
              return opts.listsOld ? { synced_at: now - 10 * 60 * 60 * 1000 } : { synced_at: now - 60000 };
            }
            if (/FROM customers WHERE customer_id/.test(q) && /default_trainer_id/.test(q)) {
              // 顧客ごとに返し分ける。担当外を拒むかを確かめるために要る。
              const cid = this._a[0];
              if (cid === 'nobody') return null;
              return { customer_id: cid, name: '山田 太郎', contract_status: '有効',
                       contract_type: '月額',
                       default_trainer_id: cid === 'others' ? 't2' : 't1' };
            }
            if (/SELECT name FROM customers/.test(q)) return { name: '山田 太郎' };
            if (/member_home/.test(q)) {
              if (opts.noHome) return null;
              return { payload: HOME, computed_at: now - (opts.homeOld ? 60 * 60 * 1000 : 60000) };
            }
            return null;
          },
          async all() {
            if (/FROM trainers/.test(q)) {
              if (opts.trainersFail) throw new Error('trainers 故障');
              return { results: [{ trainer_id: 't1', name: '鈴木', active: 1, hidden: 0, id: 't1' }] };
            }
            if (/FROM reservations/.test(q)) return { results: [{
              reservation_id: 'r1', customer_id: 'c1', customer_name: '山田 太郎', trainer_id: 't1',
              start_at: now + 86400000, status: 'booked', channel: 'line', book_type: '通常',
            }] };
            if (/FROM customers/.test(q)) return { results: [{ customer_id: 'c1', name: '山田 太郎' }] };
            if (/recurring_patterns/.test(q)) return { results: [{ pattern_id: 'p1', customer_id: 'c1', trainer_id: 't1', weekday: 1, time: '10:00' }] };
            return { results: [] };
          },
        };
      },
    },
  };
}

const member  = { role: 'customer', customerId: 'c1', lineUserId: 'U1' };
const trainer = { role: 'trainer',  trainerId: 't1', name: '鈴木' };
const owner   = { role: 'owner',    trainerId: 't9', name: '中野' };

// ---------- 1. GASの lbBoot と同じ形で返すこと ----------
//   画面は res.parts.<名前> をそのまま読む。名前が1つ違えば、その部分が
//   「取れなかった」扱いになって個別にGASへ行く（＝遅くなる）。
{
  const r = await compat.compatBoot({ env: env(), who: member, body: {} });
  ok('①会員：parts を返す', !!(r && r.parts), JSON.stringify(r).slice(0, 120));
  eq('①会員：parts の顔ぶれがGASと同じ', Object.keys(r.parts).sort(), ['memberStatus', 'myReservations', 'trainers']);
  ok('①会員：memberStatus に success が付く', r.parts.memberStatus.success === true);
  ok('①会員：memberStatus の中身がある', r.parts.memberStatus.verified === true);

  const t = await compat.compatBoot({ env: env(), who: trainer, body: {} });
  eq('①トレーナー：parts の顔ぶれがGASと同じ', Object.keys(t.parts).sort(), ['memberStatus', 'trainerReservations', 'trainers']);
  ok('①トレーナー：役割が trainer', t.parts.memberStatus.role === 'trainer');
  ok('①トレーナー：マイ予約は入れない', !('myReservations' in t.parts));

  const o = await compat.compatBoot({ env: env(), who: owner, body: {} });
  ok('①オーナーもトレーナーと同じ顔ぶれ', 'trainerReservations' in o.parts && !('myReservations' in o.parts));
  ok('①オーナーの印が立つ', o.parts.memberStatus.isOwner === true);
}

// ---------- 2. ★会員状態が答えられないなら、まとめ全体を諦めること ----------
//   ここを「空の会員状態」で返すと、画面はそれを信じて起動できなくなる。
{
  const r = await compat.compatBoot({ env: env({ noHome: true }), who: member, body: {} });
  eq('②★残数が読めないなら全体をGASへ落とす', r._fallback, true);
  ok('②★中身を一切返さない', !r.parts);

  const old = await compat.compatBoot({ env: env({ homeOld: true }), who: member, body: {} });
  eq('②★残数が古いなら全体をGASへ落とす', old._fallback, true);
}

// ---------- 3. ★1つ転んでも残りは返す。ただし空の成功に化かさない ----------
{
  const r = await compat.compatBoot({ env: env({ trainersFail: true }), who: member, body: {} });
  ok('③転んでも parts は返る', !!(r && r.parts));
  ok('③★転んだパートは PART_FAILED', r.parts.trainers.code === 'PART_FAILED');
  ok('③★転んだパートは success:false', r.parts.trainers.success === false);
  ok('③★転んだパートに中身を入れない', !('trainers' in r.parts.trainers) && !r.parts.trainers.list);
  ok('③転んでいないパートは生きている', r.parts.memberStatus.success === true);
}

// ---------- 4. ★答えられないものを「0件」に化かさないこと ----------
//   予約一覧が古いとき、compatMyReservations は _fallback を返す。
//   それを success:true + 空配列にすると、画面は「ご予約はありません」と出す。
{
  const r = await compat.compatBoot({ env: env({ listsOld: true }), who: member, body: {} });
  ok('④★一覧が古ければ PART_FAILED（0件にしない）', r.parts.myReservations.code === 'PART_FAILED');
  ok('④★0件の配列を作っていない', !Array.isArray(r.parts.myReservations.reservations));
}

// ---------- 5. 顧客カード：GASの lbCustomerCard と同じ形 ----------
{
  const r = await compat.compatCustomerCard({ env: env(), who: trainer, body: { customerId: 'c1' } });
  ok('⑤parts を返す', !!(r && r.parts), JSON.stringify(r).slice(0, 120));
  eq('⑤parts の顔ぶれがGASと同じ', Object.keys(r.parts).sort(), ['customerHome', 'inBody', 'recurring']);

  // InBody はWorkerに写しが無い。**空の成功を作らず**、画面にGASから取らせる。
  ok('⑤★InBody は必ず PART_FAILED', r.parts.inBody.code === 'PART_FAILED');
  ok('⑤★InBody に「実測なし」を装わせない', r.parts.inBody.success === false && !('records' in r.parts.inBody));
}

// ---------- 6. ★顧客カードは閲覧範囲を確かめること ----------
{
  const r = await compat.compatCustomerCard({ env: env(), who: trainer, body: { customerId: 'others' } });
  ok('⑥★担当外は拒む', r._forbidden === true);
  eq('⑥★拒んだら中身を返さない', Object.keys(r).filter((k) => !k.startsWith('_')).length, 0);

  const noId = await compat.compatCustomerCard({ env: env(), who: trainer, body: {} });
  eq('⑥顧客IDが無ければGASへ落とす', noId._fallback, true);
}

// ---------- 7. ★削り落とし（redact）が parts の中まで効くこと ----------
//   束ねたことで、トレーナーに見せてはいけない項目が parts 経由で漏れないか。
//   redact は入れ子を辿る作りだが、「辿る作りである」ことに頼らず結果で確かめる。
{
  const fake = { parts: {
    memberStatus: { success: true, verified: true },
    customerHome: { success: true, contracts: [
      { unitPrice: 15000, rewardRate: 35, trainerPay: 5250, grossMargin: 60, freq: 6 },
    ] },
  } };
  const forTrainer = redact(fake, 'trainer');
  const c = forTrainer.parts.customerHome.contracts[0];
  ok('⑦★粗利は parts の奥でも落ちる', !('grossMargin' in c));
  ok('⑦残る項目は残る', c.freq === 6 && c.unitPrice === 15000);

  const forGuest = redact(fake, 'guest');
  const g = forGuest.parts.customerHome.contracts[0];
  ok('⑦★未登録には金額を見せない', !('unitPrice' in g) && !('rewardRate' in g) && !('trainerPay' in g));
}

// ---------- 8. 未登録の人でも起動できること ----------
//   c_boot は guest も通す（「会員登録へ」を出すため）。ここで転ぶと誰も入口に立てない。
{
  const r = await compat.compatBoot({ env: env(), who: { role: 'guest' }, body: {} });
  ok('⑧未登録でも parts が返る', !!(r && r.parts));
  ok('⑧未登録は verified:false', r.parts.memberStatus.verified === false);
  eq('⑧未登録に余計なパートを付けない', Object.keys(r.parts), ['memberStatus']);
}

console.log(`\n${fail ? '❌' : '✅'} まとめ取得 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
