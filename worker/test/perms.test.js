// 許可表の検証。「顧客に契約の金額が届かない」「トレーナーに粗利が届かない」を機械で固定する。
//   実行: node worker/test/perms.test.js
import { isAllowed, redact, canActOnOther, _TABLE_FOR_TEST } from '../src/perms.js';

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else { fail++; console.log(`❌ ${name}\n   got : ${g}\n   want: ${w}`); }
}

// ---------- 1. 契約の金額を扱う操作に顧客は到達できない ----------
const MONEY = ['contractList', 'contractDraft', 'contractSubmit', 'contractApprove', 'contractReject', 'contractEnd'];
for (const a of MONEY) {
  eq(`★顧客は ${a} に到達しない`, isAllowed(a, 'customer'), false);
  eq(`★未登録も ${a} に到達しない`, isAllowed(a, 'guest'), false);
}

// ---------- 2. 粗利はオーナーだけ ----------
eq('★粗利はトレーナーに出さない', isAllowed('marginView', 'trainer'), false);
eq('★粗利は顧客に出さない', isAllowed('marginView', 'customer'), false);
eq('粗利はオーナーに出す', isAllowed('marginView', 'owner'), true);

// ---------- 3. 承認はオーナーだけ ----------
eq('★承認はトレーナーにできない', isAllowed('contractApprove', 'trainer'), false);
eq('承認はオーナーができる', isAllowed('contractApprove', 'owner'), true);

// ---------- 4. オーナーはトレーナーの上位互換 ----------
const trainerOnly = Object.keys(_TABLE_FOR_TEST).filter((k) => _TABLE_FOR_TEST[k].includes('trainer'));
eq('★トレーナーにできることはオーナーにもできる',
   trainerOnly.every((a) => isAllowed(a, 'owner')), true);

// ---------- 5. 表に無い操作は通らない（書き忘れが穴にならない）----------
eq('★表に無い操作は全役割で不許可',
   ['guest', 'customer', 'trainer', 'owner'].some((r) => isAllowed('deleteEverything', r)), false);
eq('★綴り違いも通らない', isAllowed('contractlist', 'owner'), false);

// ---------- 6. 他人の顧客IDを指定できるのは trainer / owner だけ ----------
eq('顧客は他人を指定できない', canActOnOther('customer'), false);
eq('未登録は他人を指定できない', canActOnOther('guest'), false);
eq('トレーナーは指定できる', canActOnOther('trainer'), true);
eq('オーナーは指定できる', canActOnOther('owner'), true);

// ---------- 7. 応答からの除去（表を通った後の二重の防御）----------
const payload = {
  customer: { name: '山田 太郎', phone: '090-0000-0000', email: 'x@example.com' },
  contracts: [
    { course: '通常', unitPrice: 15000, monthlyPrice: 90000, rewardRate: 35,
      trainerPay: 5250, grossAmount: 9750, grossMargin: 65, freq: 6 },
  ],
};
const forTrainer = redact(payload, 'trainer');
eq('★トレーナーの応答に粗利額が無い', 'grossAmount' in forTrainer.contracts[0], false);
eq('★トレーナーの応答に粗利率が無い', 'grossMargin' in forTrainer.contracts[0], false);
eq('トレーナーには単価が届く', forTrainer.contracts[0].unitPrice, 15000);
eq('トレーナーには自分の報酬が届く', forTrainer.contracts[0].trainerPay, 5250);
eq('トレーナーには連絡先が届く', forTrainer.customer.phone, '090-0000-0000');

const forCustomer = redact(payload, 'customer');
eq('★顧客の応答に単価が無い', 'unitPrice' in forCustomer.contracts[0], false);
eq('★顧客の応答に月額が無い', 'monthlyPrice' in forCustomer.contracts[0], false);
eq('★顧客の応答に報酬割合が無い', 'rewardRate' in forCustomer.contracts[0], false);
eq('★顧客の応答にトレーナー報酬が無い', 'trainerPay' in forCustomer.contracts[0], false);
eq('★顧客の応答に粗利が無い', 'grossMargin' in forCustomer.contracts[0], false);
eq('★顧客の応答に他人の連絡先が無い', 'phone' in forCustomer.customer, false);
eq('顧客にも回数は届く（予約に必要）', forCustomer.contracts[0].freq, 6);

const forOwner = redact(payload, 'owner');
eq('オーナーには粗利率が届く', forOwner.contracts[0].grossMargin, 65);

// ---------- 8. 入れ子・配列の奥まで落ちる ----------
const nested = { a: { b: [{ c: { grossMargin: 50, keep: 1 } }] } };
eq('★入れ子の奥の粗利も落ちる', redact(nested, 'trainer').a.b[0].c, { keep: 1 });

console.log(`\n許可表 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
