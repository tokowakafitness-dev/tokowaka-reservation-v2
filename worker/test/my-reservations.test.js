// 会員のマイ予約の検証。GASと「出し分け・並び順・文言」が一致することを固定する。
//   実行: node worker/test/my-reservations.test.js
import { compatMyReservations } from '../src/routes/compat.js';

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++;
  else { fail++; console.log(`❌ ${name}\n   got : ${g}\n   want: ${w}`); }
}
const jstMs = (y, m, d, h = 12) => Date.UTC(y, m - 1, d, h - 9);
const NOW = jstMs(2026, 10, 1, 12);

function envWith(rows) {
  return {
    DB: {
      prepare(q) {
        return {
          bind() { return this; },
          async all() {
            if (/FROM trainers/.test(q)) {
              return { results: [{ trainer_id: 't1', name: '鈴木', name_en: 'Suzuki' }] };
            }
            return { results: rows };
          },
        };
      },
    },
  };
}
const R = (o) => Object.assign({
  reservation_id: 'r', trainer_id: 't1', start_at: NOW, status: 'booked',
  channel: 'line', book_type: '通常',
}, o);

const realNow = Date.now;
Date.now = () => NOW;

// ---------- 1. 出し分け ----------
{
  const env = envWith([
    R({ reservation_id: 'up1', start_at: jstMs(2026, 10, 5) }),                     // 未来・確定
    R({ reservation_id: 'past1', start_at: jstMs(2026, 9, 20) }),                   // 過去・確定＝実施済み
    R({ reservation_id: 'con1', start_at: jstMs(2026, 9, 21), status: 'consumed' }),// 当日キャンセル
    R({ reservation_id: 'can1', start_at: jstMs(2026, 9, 22), status: 'cancelled' }),// 無料取消
    R({ reservation_id: 'chg1', start_at: jstMs(2026, 9, 23), status: 'changed' }), // 変更済み
  ]);
  const res = await compatMyReservations({ env, who: { customerId: 'c1' }, body: { lang: 'ja' } });

  eq('★今後のご予約は未来の確定だけ', res.reservations.map((r) => r.reservationId), ['up1']);
  eq('★記録は実施済みと当日キャンセルだけ', res.history.length, 2);
  eq('★無料取消と変更済みは出さない',
     JSON.stringify(res.history).indexOf('9月22日') < 0 && JSON.stringify(res.history).indexOf('9月23日') < 0, true);
}

// ---------- 2. 文言（GASと同じ）----------
{
  const env = envWith([
    R({ start_at: jstMs(2026, 9, 20) }),
    R({ start_at: jstMs(2026, 9, 21), status: 'consumed' }),
    R({ start_at: jstMs(2026, 9, 22), channel: 'transfer' }),
    R({ start_at: jstMs(2026, 9, 23), status: 'consumed', channel: 'transfer' }),
  ]);
  const res = await compatMyReservations({ env, who: { customerId: 'c1' }, body: { lang: 'ja' } });
  const labels = res.history.map((h) => h.statusLabel).sort();
  eq('★4つの文言がGASと一致', labels,
     ['実施済み', '当日キャンセル（消化）', '振替・実施済み', '振替セッション（当日キャンセル）'].sort());
}
{
  const env = envWith([R({ start_at: jstMs(2026, 9, 20) })]);
  const en = await compatMyReservations({ env, who: { customerId: 'c1' }, body: { lang: 'en' } });
  eq('英語の文言', en.history[0].statusLabel, 'Done');
  eq('★英語ではトレーナー名も英語', en.history[0].trainerName, 'Suzuki');
  const zh = await compatMyReservations({ env, who: { customerId: 'c1' }, body: { lang: 'zh' } });
  eq('中国語の文言', zh.history[0].statusLabel, '已完成');
}

// ---------- 3. 並び順 ----------
{
  const env = envWith([
    R({ reservation_id: 'b', start_at: jstMs(2026, 10, 9) }),
    R({ reservation_id: 'a', start_at: jstMs(2026, 10, 3) }),
    R({ reservation_id: 'h1', start_at: jstMs(2026, 9, 10) }),
    R({ reservation_id: 'h2', start_at: jstMs(2026, 9, 25) }),
  ]);
  const res = await compatMyReservations({ env, who: { customerId: 'c1' }, body: {} });
  eq('★今後は近い順', res.reservations.map((r) => r.reservationId), ['a', 'b']);
  eq('★記録は新しい順', res.history.map((h) => h.dateLabel), ['9月25日(金) 12:00', '9月10日(木) 12:00']);
}

// ---------- 4. 画面が使う項目 ----------
{
  const env = envWith([R({ reservation_id: 'x', start_at: jstMs(2026, 10, 5), book_type: 'チケット' })]);
  const res = await compatMyReservations({ env, who: { customerId: 'c1' }, body: {} });
  const r = res.reservations[0];
  eq('★種別を渡す（チケット表示に使う）', r.bookType, 'チケット');
  eq('★状態はGASと同じ文字', r.status, 'confirmed');
  eq('担当名', r.trainerName, '鈴木');
  eq('日時の表示', r.dateLabel, '10月5日(月) 12:00');
  eq('★変更のためのISO日時', r.startISO, new Date(jstMs(2026, 10, 5)).toISOString());
  eq('並べ替え用の項目は残さない', '_sort' in r, false);
}

// ---------- 5. キャンセル無料の境目 ----------
{
  const start = jstMs(2026, 10, 5, 19);
  const env = envWith([R({ start_at: start })]);
  Date.now = () => jstMs(2026, 10, 4, 16, 59) + 0;
  let res = await compatMyReservations({ env, who: { customerId: 'c1' }, body: {} });
  eq('★前日17時前は無料', res.reservations[0].freeCancel, true);
  Date.now = () => jstMs(2026, 10, 4, 17);
  res = await compatMyReservations({ env, who: { customerId: 'c1' }, body: {} });
  eq('★前日17時以降は無料でない', res.reservations[0].freeCancel, false);
  Date.now = () => NOW;
}

// ---------- 6. 会員でなければ答えない ----------
{
  const env = envWith([]);
  const res = await compatMyReservations({ env, who: {}, body: {} });
  eq('★顧客IDが無ければGASに任せる', res._fallback, true);
}

Date.now = realNow;
console.log(`\nマイ予約 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
