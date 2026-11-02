// shadow の食い違いに添える標本の1行（2026-11-02）。
//   実行: node worker/test/shadow-sample-detail.test.js
//
// ★なぜ要るのか
//   11/2 朝に1名1回の食い違いが出たが、誰の・いつの・どの月の計算かを読む窓口が無かった。
//   結果は作業依頼の経路で読むので、会員IDは下4桁しか出してはいけない（決定0089）。
import { sampleDetail } from '../src/lib/shadow-status.js';

let fail = 0;
function ok(c, m) { if (!c) { fail++; console.error('✗ ' + m); } else console.log('✓ ' + m); }

const row = {
  customer_id: 'C20260412345678', entry: 'sweep',
  at: Date.UTC(2026, 10, 1, 20, 5),            // JST 11/2 05:05
  copy_computed_at: Date.UTC(2026, 10, 1, 20, 3),
  requested_month: '2026-11', copy_month: '2026-11', d1_month: '2026-11',
  source_version: 12, built_version: 12, d1_status: 'ok',
};
const s = sampleDetail(row);
ok(s.includes('*5678'), '下4桁が出る');
ok(!s.includes('C2026041234'), '下4桁より前は出ない');
ok(s.includes('11/2 05:05'), '比べた時刻が JST で出る');
ok(s.includes('11/2 05:03'), '写しの計算時刻が出る');
ok(s.includes('写し=2026-11') && s.includes('D1=2026-11'), '月が出る');
ok(s.includes('12/12'), '世代が出る');
ok(s.includes('[sweep]'), '入口が出る');
ok(sampleDetail({ customer_id: '', entry: null, at: null }).includes('比べた -'), '欠けた値でも落ちない');

if (fail) { console.error(`\n${fail} 件失敗`); process.exit(1); }
console.log('\n全部通った');
