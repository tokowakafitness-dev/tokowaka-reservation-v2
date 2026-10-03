// 許可表 — このファイルだけが「誰が何を叩けるか」を決める。
//
// 設計（2026-09-28 オーナー承認）：
//   画面ごと・関数ごとに権限チェックを書く方式はやめる。書き忘れた場所が穴になるため。
//   入口(index.js)で役割を確定し、この表に載っていない組み合わせは処理に到達させない。
//   ★契約の金額を扱う操作は customer の表に載せない。載っていない＝通らない。
//
// 役割：
//   guest    … LINEログイン済みだが会員登録が済んでいない
//   customer … 会員本人
//   trainer  … トレーナー
//   owner    … オーナー（trainerの全権に加え、粗利の閲覧と承認ができる）

export const ROLES = ['guest', 'customer', 'trainer', 'owner'];

// 操作名 → 許可する役割
//   trainer に載っているものは owner も通る（isAllowed で継承する）。
const TABLE = {
  // ---- 誰でも（ログイン済みなら）----
  'whoami':            ['guest', 'customer', 'trainer', 'owner'],
  'setLang':           ['guest', 'customer', 'trainer', 'owner'],
  'selfRegister':      ['guest'],

  // ---- 会員本人 ----
  'boot':              ['customer', 'trainer', 'owner'],   // 起動時の一括取得。役割で中身が変わる
  'myHome':            ['customer'],                       // 自分の残数・契約の「回数と期限」のみ
  'mySlots':           ['customer', 'trainer', 'owner'],
  'bookingOptions':    ['customer', 'trainer', 'owner'],   // 予約する日時の残数と消化先

  // ---- GAS互換（画面の描画コードを変えずに通信先だけ差し替えるための窓口）----
  //   中身はD1から、形はGASのまま返す。役割の判定はこの表に従う。
  'c_memberStatus':        ['guest', 'customer', 'trainer', 'owner'],
  'c_trainers':            ['customer', 'trainer', 'owner'],
  'c_trainerSlots':        ['customer', 'trainer', 'owner'],
  'c_bookingOptions':      ['customer', 'trainer', 'owner'],
  'c_myReservations':      ['customer'],   // 会員本人のマイ予約
  'c_trainerReservations': ['trainer'],
  'c_customerHome':        ['trainer'],
  'c_recurringList':       ['trainer'],
  // まとめ取得。中身は上の窓口と同じものを束ねるだけなので、役割も同じにそろえる。
  //   c_boot は未登録の人も通す（起動して「会員登録へ」を出すため。c_memberStatus と同じ）。
  'c_boot':                ['guest', 'customer', 'trainer', 'owner'],
  'c_customerCard':        ['trainer'],
  'myReservations':    ['customer'],
  'book':              ['customer', 'trainer', 'owner'],
  'cancelReservation': ['customer', 'trainer', 'owner'],
  'changeReservation': ['customer', 'trainer', 'owner'],
  'myBodyRecords':     ['customer'],

  // ---- トレーナー ----
  'trainerBoard':        ['trainer'],   // 担当顧客の一覧
  'customerDetail':      ['trainer'],   // 顧客の残数・InBody・固定枠
  'customerBodyRecords': ['trainer'],
  'bookProxy':           ['trainer'],   // 代行予約
  'makeBlock':           ['trainer'],
  'listAdminSlots':      ['trainer'],
  'deleteAdminSlot':     ['trainer'],
  'listUnlinked':        ['trainer'],
  'linkUnlinked':        ['trainer'],
  'recurringList':       ['trainer'],
  'recurringAdd':        ['trainer'],
  'recurringDelete':     ['trainer'],

  // ---- 契約（金額を扱う）----
  //   ★ customer は一切載せない。顧客の端末からは到達できない。
  'contractList':     ['trainer'],   // 顧客の契約履歴（金額を含む）
  'contractDraft':    ['trainer'],   // 次の契約の下書きを作る
  'contractSubmit':   ['trainer'],   // 保存 or 承認依頼（採算次第で分岐）
  'contractApprove':  ['owner'],     // 承認はオーナーのみ
  'contractReject':   ['owner'],
  'contractEnd':      ['trainer'],

  // ---- 粗利（オーナーのみ）----
  //   ★ トレーナーにも載せない。2026-09-27 オーナー指示。
  'marginView':       ['owner'],     // 粗利率・粗利額
  'pendingApprovals': ['owner'],

  // ---- 顧客マスタ ----
  'customerCreate':   ['trainer'],
  'customerUpdate':   ['trainer'],
};

// トレーナーに許されるものは、オーナーにも許される（オーナーは上位互換）
export function isAllowed(action, role) {
  const allowed = TABLE[action];
  if (!allowed) return false;                       // 表にない操作は存在しない扱い
  if (allowed.includes(role)) return true;
  if (role === 'owner' && allowed.includes('trainer')) return true;
  return false;
}

// 応答から落とすもの。表を通った後でも、役割によって見せない項目がある。
//   粗利は「載せない」だけでなく「計算結果を応答に入れない」ことで二重に防ぐ。
const REDACT = {
  customer: [
    'unitPrice', 'monthlyPrice', 'joinFee', 'rewardRate',
    'grossMargin', 'grossAmount', 'trainerPay',
    'phone', 'email', 'note',          // 他人の連絡先は会員には返らない
  ],
  trainer: [
    'grossMargin', 'grossAmount',      // ★粗利はトレーナーに出さない
  ],
  owner: [],
  guest: ['unitPrice', 'monthlyPrice', 'joinFee', 'rewardRate', 'grossMargin', 'grossAmount', 'trainerPay'],
};

// 深い構造も辿って落とす（配列・入れ子オブジェクト）
export function redact(value, role) {
  const keys = REDACT[role] || REDACT.guest;
  if (!keys.length) return value;
  const drop = new Set(keys);
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v)) {
        if (drop.has(k)) continue;
        out[k] = walk(v[k]);
      }
      return out;
    }
    return v;
  };
  return walk(value);
}

// 自分以外の顧客に触れるか。trainer/owner だけが customerId を指定できる。
export function canActOnOther(role) {
  return role === 'trainer' || role === 'owner';
}

// 「どの顧客を見てよいか」（2026-09-29 オーナー決定）
//   トレーナー … 自分が担当の顧客＋担当が決まっていない顧客
//   オーナー   … 全員
//   担当が決まっていない顧客は指名ではないので、どのトレーナーが見てもよい。
//   逆に、他のトレーナーの担当顧客は見せない。トレーナーごとに報酬割合が異なり、
//   契約行からそれが読めてしまうため。
export function customerScopeSql(who, alias) {
  const a = alias ? alias + '.' : '';
  if (who.role === 'owner') return { where: '', args: [] };
  return {
    where: `(${a}default_trainer_id = ? OR ${a}default_trainer_id IS NULL OR ${a}default_trainer_id = '')`,
    args: [String(who.trainerId || '')],
  };
}

// 1人の顧客に触れてよいかを確かめる。触れてよくなければ false。
export async function canSeeCustomer(env, who, customerId) {
  if (!customerId) return false;
  if (who.role === 'owner') return true;
  if (who.role === 'customer') return String(customerId) === String(who.customerId);
  if (who.role !== 'trainer') return false;
  const row = await env.DB.prepare(
    'SELECT default_trainer_id FROM customers WHERE customer_id = ?'
  ).bind(String(customerId)).first();
  if (!row) return false;
  const t = String(row.default_trainer_id || '');
  return t === '' || t === String(who.trainerId || '');
}

// 契約行の報酬に関する項目を、見てよい人にだけ残す（2026-09-29 オーナー決定）。
//
//   隠すのは「**別のトレーナーの名前が入っている契約**」だけ。
//   トレーナーごとに割合が異なるため、他人の割合が読めてはいけない。
//
//   担当が入っていない契約は隠さない。担当なしの顧客の報酬割合は固定なので、
//   誰か個人の割合を表さず、読めても他人の条件は分からない。
//   逆に隠すと、その顧客を受け持つトレーナーが自分の報酬を確認できなくなる。
export function redactContractForViewer(contract, who) {
  if (who.role === 'owner') return contract;
  const owner = String(contract.trainerId || '');
  if (owner === '' || owner === String(who.trainerId || '')) return contract;
  const c = { ...contract };
  delete c.rewardRate;
  delete c.trainerPay;
  return c;
}

export const _TABLE_FOR_TEST = TABLE;
export const _REDACT_FOR_TEST = REDACT;
