// 顧客の閲覧範囲の検証（2026-09-29 オーナー決定）
//   トレーナー … 自分が担当の顧客＋担当が決まっていない顧客
//   オーナー   … 全員
//   ★トレーナーごとに報酬割合が異なるため、他のトレーナーの担当顧客は見せない。
//     担当なしの顧客でも、契約行に別のトレーナーの報酬割合が入りうるので落とす。
//   実行: node worker/test/customer-scope.test.js
import { canSeeCustomer, customerScopeSql, redactContractForViewer } from '../src/perms.js';

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else { fail++; console.log(`❌ ${name}\n   got : ${g}\n   want: ${w}`); }
}

const CUSTOMERS = {
  mine:    { default_trainer_id: 't1' },
  others:  { default_trainer_id: 't2' },
  none:    { default_trainer_id: null },
  empty:   { default_trainer_id: '' },
};
const env = {
  DB: { prepare: () => ({ _id: null,
    bind(id) { this._id = String(id); return this; },
    async first() { return CUSTOMERS[this._id] || null; } }) },
};
const trainer = { role: 'trainer', trainerId: 't1' };
const owner   = { role: 'owner',   trainerId: 't9' };
const member  = { role: 'customer', customerId: 'mine' };

// ---------- 1. トレーナーが見てよい顧客 ----------
eq('自分の担当は見える', await canSeeCustomer(env, trainer, 'mine'), true);
eq('★他のトレーナーの担当は見えない', await canSeeCustomer(env, trainer, 'others'), false);
eq('★担当なし（未設定）は見える', await canSeeCustomer(env, trainer, 'none'), true);
eq('★担当なし（空欄）も見える', await canSeeCustomer(env, trainer, 'empty'), true);
eq('居ない顧客は見えない', await canSeeCustomer(env, trainer, 'nobody'), false);
eq('顧客IDが空なら見えない', await canSeeCustomer(env, trainer, ''), false);

// ---------- 2. オーナーは全員 ----------
for (const k of ['mine', 'others', 'none', 'empty']) {
  eq(`オーナーは ${k} を見られる`, await canSeeCustomer(env, owner, k), true);
}

// ---------- 3. 会員は自分だけ ----------
eq('★会員は自分だけ', await canSeeCustomer(env, member, 'mine'), true);
eq('★会員は他人を見られない', await canSeeCustomer(env, member, 'others'), false);
eq('未登録は誰も見られない', await canSeeCustomer(env, { role: 'guest' }, 'mine'), false);

// ---------- 4. 一覧の絞り込み ----------
{
  const s = customerScopeSql(trainer, 'c');
  eq('★一覧も担当＋担当なしに絞る',
     /c\.default_trainer_id = \?/.test(s.where)
     && /c\.default_trainer_id IS NULL/.test(s.where)
     && /c\.default_trainer_id = ''/.test(s.where), true);
  eq('自分のIDを渡す', s.args, ['t1']);

  const o = customerScopeSql(owner, 'c');
  eq('オーナーは絞り込まない', [o.where, o.args], ['', []]);
}

// ---------- 5. 報酬に関する項目の除去 ----------
const contract = { course: '通常', unitPrice: 15000, monthlyPrice: 90000,
                   trainerId: 't2', rewardRate: 40, trainerPay: 6000, freq: 6 };
{
  const c = redactContractForViewer(contract, trainer);
  eq('★他のトレーナーの契約から報酬割合を落とす', 'rewardRate' in c, false);   // trainerId='t2'
  eq('★他のトレーナーの契約から報酬額も落とす', 'trainerPay' in c, false);
  eq('単価や回数は残す', [c.unitPrice, c.freq], [15000, 6]);
}
{
  const mineC = { ...contract, trainerId: 't1', rewardRate: 35, trainerPay: 5250 };
  const c = redactContractForViewer(mineC, trainer);
  eq('★自分の担当ぶんは報酬が見える', [c.rewardRate, c.trainerPay], [35, 5250]);
}
{
  const c = redactContractForViewer(contract, owner);
  eq('オーナーは全部見える', [c.rewardRate, c.trainerPay], [40, 6000]);
}
{
  // ★担当が入っていない契約は隠さない（2026-09-29 オーナー決定）。
  //   担当なしの顧客の報酬割合は固定なので、誰か個人の割合を表さない。
  //   隠すと、その顧客を受け持つトレーナーが自分の報酬を確認できなくなる。
  const c = redactContractForViewer({ ...contract, trainerId: '', rewardRate: 35 }, trainer);
  eq('★担当が入っていない契約は報酬が見える', c.rewardRate, 35);
  const c2 = redactContractForViewer({ ...contract, trainerId: null, rewardRate: 35 }, trainer);
  eq('担当が未設定でも同じ', c2.rewardRate, 35);
}
{
  // 別のトレーナーの名前が入っているものだけ隠す
  const c = redactContractForViewer({ ...contract, trainerId: 't3', rewardRate: 45 }, trainer);
  eq('★別のトレーナーの割合は見せない', 'rewardRate' in c, false);
}

console.log(`\n顧客の閲覧範囲 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
