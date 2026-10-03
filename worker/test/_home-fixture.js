// テストで使う「残数の写し」の形を1か所に置く。
//
//   ★なぜ1か所に寄せるか
//     2026-10-03、`_homeShapeOk` を本番の形に合わせて厳しくしたところ、
//     5つのテストが一斉に落ちた。どのモックも本番より項目が少なく、
//     「テストは通るのに本番のデータが弾かれる／その逆」が起きる状態だった。
//     同じ形が5か所にあって1つも本物と合っていない ―― 今日何度も踏んだ形そのもの。
//
//   ★ここの項目は gas/LineBooking.js の _lbBuildHome の返り値から取っている。
//     本番の形が変わったら、**ここだけ**直せば全テストが追従する。
//     逆に、ここを本番より緩く作ると検査の意味が消える。

export const HOME_MONTHLY = {
  type: 'monthly', active: true,
  quota: 6, carryover: 0, thisMonth: 2, monthlyRemaining: 3,
  ticketTotal: 0, ticketRemaining: 0, ticketExpire: '', ticketExpireMs: 0,
  pairRemaining: 0, pairPackMax: 0, normalTicketRemaining: 0,
  hasNormalRoute: true, ticketPacks: [], remaining: 3,
};

export const HOME_TICKET = {
  ...HOME_MONTHLY,
  type: 'ticket', monthlyRemaining: null, quota: 0,
  ticketTotal: 10, ticketRemaining: 5, normalTicketRemaining: 5,
  ticketPacks: [{ remaining: 5, expire: '2026-12-31', kind: 'normal' }], remaining: 5,
};

// 1人ぶんの写し（member_home.payload に入る形）
export function homePayload(opts = {}) {
  const cur = { ...HOME_MONTHLY, ...(opts.current || {}) };
  const nxt = opts.next === null ? null : { ...HOME_MONTHLY, monthlyRemaining: 6, ...(opts.next || {}) };
  return JSON.stringify({
    currentMonth: opts.currentMonth || '2026-09',
    nextMonth: opts.nextMonth || '2026-10',
    current: cur,
    next: nxt,
  });
}
