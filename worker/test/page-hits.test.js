/* 到達の計測が、予約を止めず・個人情報を入れず・行を増やしすぎないこと
 *   node test/page-hits.test.js
 */
import { jstHourKey, normCampaign, normContent, normSource } from '../src/routes/pagehits.js';
let ng = 0;
const ok = (c, m) => { console.log((c ? '  ok   ' : '  ★NG ') + m); if (!c) ng++; };

/* ── JSTの時間の境目 ── */
ok(jstHourKey(Date.UTC(2026, 9, 22, 14, 59, 59, 999)) === '2026-10-22T23',
   'UTC 14:59:59.999 → JST 23時台：' + jstHourKey(Date.UTC(2026, 9, 22, 14, 59, 59, 999)));
ok(jstHourKey(Date.UTC(2026, 9, 22, 15, 0, 0, 0)) === '2026-10-23T00',
   'UTC 15:00:00.000 → 翌日0時台：' + jstHourKey(Date.UTC(2026, 9, 22, 15, 0, 0, 0)));
ok(jstHourKey(Date.UTC(2026, 9, 22, 3, 0)) === '2026-10-22T12', 'UTC 3時 → JST 12時台');

/* ── 個人情報が入らないこと（関門② 2026-10-22・実測で漏れていた） ──
   前の規則（文字種と桁数だけ）では、下の5つが**そのまま保存された**。
   決まった名前だけを通す形に変えたので、構造的に入らない。 */
const pii = [
  '090-1234-5678', '03-1234-5678', '123-4567', '09012345678',
  'taro-yamada', 'ryunosuke_nakano', 'c123456', 'araki@example.com',
];
for (const v of pii) {
  ok(normContent(v) === 'other', '"' + v + '" は other に落ちる：' + normContent(v));
  ok(normCampaign(v) === 'other', '（キャンペーン側も）"' + v + '"：' + normCampaign(v));
}

/* ── 使う値は通ること（見たいものが見えなくならない） ── */
for (const v of ['cr1', 'cr3', 'cr12', 'cr999', 'profile', 'story', 'post', 'mail']) {
  ok(normContent(v) === v, '"' + v + '" はそのまま残る：' + normContent(v));
}
ok(normContent('CR3') === 'cr3', '大文字は小文字にそろえる');
ok(normContent('cr1234') === 'other', 'cr+4桁は通さない（番号の混入を防ぐ）');
ok(normContent('') === 'none', '空は none');
ok(normContent(null) === 'none', '無いものは none');
for (const v of ['monitor_bulkup', 'monitor', 'bulkup']) {
  ok(normCampaign(v) === v, 'キャンペーン "' + v + '" は通る');
}
ok(normCampaign('new_campaign_2026') === 'other',
   '★未知のキャンペーンは other にまとめる（other が増えたら一覧に足す合図）');

/* ── 獲得元（2026-10-24）。紹介はトレーナーを識別する ── */
for (const v of ['tr_suzuki', 'instagram', 'facebook', 'google', 'line', 'mail', 'direct']) {
  ok(normSource(v) === v, '獲得元 "' + v + '" は通る：' + normSource(v));
}
ok(normSource('TR_Suzuki') === 'tr_suzuki', '大文字は小文字にそろえる');
ok(normSource('') === 'none', '空は none');
for (const v of ['090-1234-5678', 'taro-yamada', 'a@b.com', 'tr_', 'tr_'+'x'.repeat(13)]) {
  ok(normSource(v) === 'other', '★"' + v + '" は other に落ちる（個人が入らない）');
}
/* 新しいキャンペーンと貼り先（2026-10-24 オーナーのUTM設計） */
ok(normCampaign('monitor_bulkup_202610') === 'monitor_bulkup_202610', '新しいキャンペーンが通る');
ok(normContent('ig_bio') === 'ig_bio', 'ig_bio が通る');

console.log('');
console.log(ng === 0 ? '✅ すべて通過' : '🔴 ' + ng + '件');
process.exit(ng === 0 ? 0 : 1);
