// 予約タイトルの種別プレフィックスの検証（_lbBookTypePrefix）
//
//   ★なぜここを固定するか
//     2026-10-05、顧客マスタに月額行と追加チケット行を「並列」で持つ運用に変えた（オーナー決定）。
//     contractType は _lbFindContract が返す「開始日が最も新しい有効な契約行」の種別なので、
//     チケットを買った月額会員は contractType='チケット' になる。それをそのままタイトルに出すと、
//     月額枠を消化した予約が チケット_ に化け、billing がチケット行で計上して月額売上が立たない。
//     だから「消化方式が monthly なら月額契約の種別を使う」ようにした。その再発を防ぐ。
//
//   実行: node worker/test/book-type-prefix.test.js
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const R = require('../../gas/BookingRules.js');
const P = R._lbBookTypePrefix;

let pass = 0, fail = 0;
function eq(name, got, want) {
  if (got === want) pass++; else { fail++; console.log(`❌ ${name}\n   got : ${got}\n   want: ${want}`); }
}

// ── 1. 従来の挙動（退行防止）──
eq('1a_振替',                   P('transfer', 'normal', '通常', 'monthly'), '振替_');
eq('1b_ペア',                   P('line', 'pair', '通常', 'ticket'),        'ペア_');
eq('1c_レンタルのチケット消化',  P('line', 'normal', 'レンタル', 'ticket'),  'レンタル_');
eq('1d_レンタルの月額消化',      P('line', 'normal', 'レンタル', 'monthly'), '通常_');
eq('1e_チケット消化',            P('line', 'normal', '通常', 'ticket'),      'チケット_');
eq('1f_モニターの月額消化',      P('line', 'normal', 'モニター', 'monthly'), 'モニター_');
eq('1g_通常の月額消化',          P('line', 'normal', '通常', 'monthly'),     '通常_');
eq('1h_消化不明はcontractTypeで', P('line', 'normal', 'モニター', ''),       'モニター_');

// ── 2. ★月額とチケットの並列（2026-10-05）──
eq('2a_契約がチケットでも月額消化は通常', P('line', 'normal', 'チケット', 'monthly', '通常'),     '通常_');
eq('2b_モニター会員の月額消化',           P('line', 'normal', 'チケット', 'monthly', 'モニター'),   'モニター_');
eq('2c_枠を使い切ればチケット',           P('line', 'normal', 'チケット', 'ticket', '通常'),       'チケット_');
eq('2d_モニターでも使い切ればチケット',   P('line', 'normal', 'チケット', 'ticket', 'モニター'),   'チケット_');
// 後方互換：monthlyType を渡さない旧経路・degraded は従来の判定に落ちる
eq('2e_monthlyType無しは従来通り',        P('line', 'normal', 'チケット', 'monthly'),              'チケット_');
eq('2f_monthlyTypeが空なら従来通り',      P('line', 'normal', 'チケット', 'monthly', ''),          'チケット_');

// ── 3. 優先順位が崩れていないこと ──
eq('3a_振替はすべてに勝つ',       P('transfer', 'pair', 'チケット', 'ticket', 'モニター'),        '振替_');
eq('3b_ペアは消化方式に勝つ',     P('line', 'pair', 'チケット', 'monthly', '通常'),               'ペア_');
eq('3c_レンタルの月額消化は月額', P('line', 'normal', 'レンタル', 'monthly', 'モニター'),         'モニター_');
eq('3d_レンタルのチケット消化は維持', P('line', 'normal', 'レンタル', 'ticket', '通常'),          'レンタル_');

// ── 4. 入力の揺れに落ちないこと ──
eq('4a_nullでも落ちない',       P('line', null, null, null, null), '通常_');
eq('4b_undefinedでも落ちない',   P('line'),                        '通常_');
eq('4c_種別に注記が付いても',    P('line', 'normal', 'チケット（追加8枚）', 'monthly', '通常（フルサポート）'), '通常_');
eq('4d_モニターの注記付き',      P('line', 'normal', 'チケット', 'monthly', 'モニター契約'), 'モニター_');

console.log((fail === 0 ? '✅ ' : '⚠️ ') + `予約タイトルの種別 検証: ${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
