// 「どの入口でも閲覧範囲を確かめているか」を固定する。
//
//   2026-09-29 に本番で見つかった穴：
//     getCustomerHome と固定枠一覧には確認が入っていたのに、
//     getBookingOptions にだけ入っていなかった。
//     トレーナーが顧客IDを指定すれば、担当外の顧客の
//     チケット残数・期限・ペア残数を取得できた。
//   隣の入口が守られていても、抜けた1つがあれば守られていないのと同じ。
//   ここでは「顧客IDを受け取る入口」を列挙して、全部を機械で確かめる。
//
//   実行: node worker/test/entry-perms.test.js
import * as compat from '../src/routes/compat.js';
import { homePayload } from './_home-fixture.js';

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log(`❌ ${name}\n   got : ${g}\n   want: ${w}`); }
}

const now = Date.now();
const HOME = homePayload({ current: { pairRemaining: 2 } });
// 担当：mine=t1 ／ others=t2 ／ none=担当なし
const OWNER_OF = { mine: 't1', others: 't2', none: null };

function makeEnv() {
  return {
    DB: {
      prepare(q) {
        const self = {
          _args: [],
          bind(...a) { this._args = a.map(String); return this; },
          async first() {
            if (/FROM customers WHERE customer_id/.test(q) && /default_trainer_id/.test(q)) {
              const id = this._args[0];
              return (id in OWNER_OF) ? { default_trainer_id: OWNER_OF[id] } : null;
            }
            if (/SELECT name FROM customers/.test(q)) return { name: 'テスト' };
            if (/member_home/.test(q)) return { payload: HOME, computed_at: now - 60000 };
            if (/slots_cache/.test(q)) return { payload: '{"slots":[]}', computed_at: now - 60000 };
            if (/sync_state/.test(q)) return { synced_at: now };
            return null;
          },
          async all() { return { results: [] }; },
        };
        return self;
      },
    },
  };
}

const trainer = { role: 'trainer', trainerId: 't1' };
const owner   = { role: 'owner',   trainerId: 't9' };

// 顧客IDを受け取り、その顧客の情報を返す入口はすべてここに並べる。
// ★新しい入口を足したらここにも足すこと。足し忘れが今回の穴だった。
const ENTRIES = [
  { name: 'getCustomerHome',   fn: 'compatCustomerHome',   body: (cid) => ({ customerId: cid }) },
  { name: 'getBookingOptions', fn: 'compatBookingOptions',
    body: (cid) => ({ customerId: cid, startISO: new Date(now + 86400000).toISOString() }) },
  { name: 'listRecurring',     fn: 'compatRecurringList',  body: (cid) => ({ customerId: cid }) },
  // まとめ取得（2026-10-03）。中の2つも各自で確かめるが、束ねた側でも確かめる。
  { name: 'customerCard',      fn: 'compatCustomerCard',   body: (cid) => ({ customerId: cid }) },
];

// ---------- 1. ★担当外の顧客は、どの入口からも取れない ----------
for (const e of ENTRIES) {
  const r = await compat[e.fn]({ env: makeEnv(), who: trainer, body: e.body('others') });
  eq(`★${e.name}：担当外は拒む`, r._forbidden === true || r._fallback === true, true);
  // 中身が漏れていないこと（拒んだのに数字が入っている、を防ぐ）
  eq(`★${e.name}：担当外に中身を返さない`,
     Object.keys(r).filter((k) => !k.startsWith('_')).length, 0);
}

// ---------- 2. 担当と担当なしは取れる（締めすぎていないこと） ----------
for (const e of ENTRIES) {
  for (const cid of ['mine', 'none']) {
    const r = await compat[e.fn]({ env: makeEnv(), who: trainer, body: e.body(cid) });
    eq(`${e.name}：${cid} は拒まない`, r._forbidden === true, false);
  }
}

// ---------- 3. オーナーは全員取れる ----------
for (const e of ENTRIES) {
  for (const cid of ['mine', 'others', 'none']) {
    const r = await compat[e.fn]({ env: makeEnv(), who: owner, body: e.body(cid) });
    eq(`${e.name}：オーナーは ${cid} を拒まない`, r._forbidden === true, false);
  }
}

// ---------- 4. ★会員は自分以外を指定できない ----------
for (const e of ENTRIES) {
  const member = { role: 'customer', customerId: 'mine' };
  const r = await compat[e.fn]({ env: makeEnv(), who: member, body: e.body('others') });
  eq(`★${e.name}：会員が他人を指定しても拒む`, r._forbidden === true || r._fallback === true, true);
}

// ---------- 5. 入口の数え漏れを防ぐ（コードとこの表を突き合わせる） ----------
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/routes/compat.js', import.meta.url), 'utf8');
  // body.customerId を読む export 関数を数える
  const names = [...src.matchAll(/export async function (compat\w+)\(/g)].map((m) => m[1]);
  const takesCustomerId = names.filter((n) => {
    const i = src.indexOf(`export async function ${n}(`);
    const j = src.indexOf('\nexport async function', i + 1);
    const body = src.slice(i, j < 0 ? src.length : j);
    return /body\.customerId/.test(body);
  });
  const listed = ENTRIES.map((e) => e.fn).sort();
  eq('★顧客IDを受け取る入口がこの表と一致する', takesCustomerId.sort(), listed);
}

console.log(`\n入口ごとの閲覧範囲 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
