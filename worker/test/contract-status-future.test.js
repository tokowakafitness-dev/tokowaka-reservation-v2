// 開始日がこれから先の契約しか無い会員を、毎朝3時の契約同期が expired にしないかを確かめる。
//   実行: node worker/test/contract-status-future.test.js
//
// ★なぜ要るのか（2026-10-29）
//   11月開始の新規会員が、10月中に11月の予約をしようとして「現在ご予約いただけない契約状態です」で止まった。
//   登録は開始前の契約でも通す（10/23）が、syncContractStatus（毎日3時）は「期間内の行」だけを active と数えていた
//   → 開始前の会員は expired と書かれ、makeReservationLine が CONTRACT_INACTIVE で止めた。
//   残数の判定（割当器）は開始前の会員にも11月分を許していた＝そちらだけ確かめて「予約できる」と答えてしまった。
//
//   ① 入口から：syncContractStatus（本物）→ G列。開始前だけの会員は active
//   ② 終わった契約だけの会員は expired のまま（退会・失効の降格は壊さない）
//   ③ 期限なし・期間内・終了済み＋次の契約あり
//   ④ 予約の入口：G列 active なら makeReservationLine が CONTRACT_INACTIVE で止めない（expired なら止める）
//   ⑤ 終了日の当日は終わりまで active（割当器と同じ・最終日の3時に expired にしない）
//   ⑥ 振替の入口：振替先がどの契約期間にも入らなければ権利を使わずに止める（契約の切れ目・Codex 関門②）
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LB = readFileSync(join(ROOT, 'gas/LineBooking.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, why) { if (cond) pass++; else { fail++; console.log(`❌ ${name}`); if (why) console.log(`   ${why}`); } }
function pluckFn(src, name) {
  const m = src.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('見つからない: ' + name);
  return m[0];
}
const MAP_COL_SRC = LB.match(/var MAP_COL = \{[\s\S]*?\n\};/)[0];

const NOW = Date.UTC(2026, 9, 29, 1, 0, 0);   // 2026-10-29 10:00 JST
const d = (y, m, dd) => new Date(Date.UTC(y, m - 1, dd, -9));

// 名簿の1行（A〜H）
const mapRow = (cid, name, stat) => ['U' + cid, cid, name, '', '', '通常', stat, 'verified'];

function run(members, contractsByCid) {
  const writes = [];
  const sheet = {
    getLastRow: () => members.length + 1,
    getRange: (r, c, nr, nc) => (nr === undefined
      ? { setValue: (v) => { writes.push({ row: r, col: c, v }); members[r - 2][c - 1] = v; } }
      : { getValues: () => members.map((m) => m.slice(0, nc)) }),
  };
  const ctx = {
    JSON, Math, Number, String, Array,
    Date: class extends Date { constructor(...a) { if (a.length === 0) super(NOW); else super(...a); } static now() { return NOW; } },
    Logger: { log: () => {} }, LINE_BOOKING: { MAP_SHEET: 'customer_line_map' },
    _lbSheet: () => sheet, _lbContractSheet: () => ({ getLastRow: () => 10 }),
    _lbPhoneByCustomerId: () => '',
    _lbContractRowsAll: (name, phone, fresh, cid) => contractsByCid[cid] || [],
  };
  vm.createContext(ctx);
  vm.runInContext(MAP_COL_SRC + '\n' + pluckFn(LB, '_lbContractEndOfDayMs') + '\n' + pluckFn(LB, 'syncContractStatus'), ctx);
  const res = ctx.syncContractStatus();
  return { res, writes, members };
}
const row = (start, end) => ({ start, end });

console.log('=== ① 開始前だけの会員 ===');
{
  //   開始前の新規会員の形：11/1開始の月額だけ。3時に expired にされていた → 次の同期で active に戻る
  const r = run([mapRow('C1', '新規', 'expired')], { C1: [row(d(2026, 11, 1), null)] });
  ok('①-1 ★11/1開始の契約だけ → active', r.members[0][6] === 'active', r.members[0][6]);
  const r2 = run([mapRow('C1', '新規', '')], { C1: [row(d(2026, 11, 1), d(2027, 1, 31))] });
  ok('①-2 ★期限つきの開始前（チケット等）→ active', r2.members[0][6] === 'active', r2.members[0][6]);
  const r3 = run([mapRow('C1', '新規', 'active')], { C1: [row(d(2026, 11, 1), null)] });
  ok('①-3 ★既に active なら書かない（expired に落とさない）', r3.members[0][6] === 'active' && r3.writes.length === 0, JSON.stringify(r3.writes));
}

console.log('=== ② 終わった契約だけ ===');
{
  const r = run([mapRow('C2', '退会', 'active')], { C2: [row(d(2026, 9, 1), d(2026, 10, 28))] });
  ok('②-1 ★10/28で終わった契約だけ → expired（降格は壊さない）', r.members[0][6] === 'expired', r.members[0][6]);
  const r2 = run([mapRow('C2', '退会', 'active')], { C2: [] });
  ok('②-2 契約行が無い → expired', r2.members[0][6] === 'expired');
}

console.log('=== ③ その他の形 ===');
{
  ok('③-1 期限なし（開始済み）→ active', run([mapRow('C3', 'x', '')], { C3: [row(d(2026, 9, 1), null)] }).members[0][6] === 'active');
  ok('③-2 期間内 → active', run([mapRow('C3', 'x', '')], { C3: [row(d(2026, 9, 1), d(2026, 10, 31))] }).members[0][6] === 'active');
  ok('③-3 ★終わった契約＋11月からの次の契約 → active',
    run([mapRow('C3', 'x', 'expired')], { C3: [row(d(2026, 8, 1), d(2026, 9, 30)), row(d(2026, 11, 1), null)] }).members[0][6] === 'active');
  ok('③-4 開始日なし・期限切れ → expired', run([mapRow('C3', 'x', 'active')], { C3: [row(null, d(2026, 10, 1))] }).members[0][6] === 'expired');
  //   移行ギャップは判定保留（従来どおり）
  const gap = []; gap.migrationGap = true;
  const rg = run([mapRow('C4', 'x', 'active')], { C4: gap });
  const gap2 = [row(d(2026, 11, 1), null)]; gap2.migrationGap = true;
  const rg2 = run([mapRow('C5', 'x', 'expired')], { C5: gap2 });
  ok('③-6 移行ギャップは開始前の行があっても変更しない', rg2.members[0][6] === 'expired' && rg2.writes.length === 0);
  ok('③-5 移行ギャップは変更しない', rg.members[0][6] === 'active' && rg.writes.length === 0);
}

console.log('=== ④ 予約の入口 ===');
{
  function reserve(stat) {
    let called = false;
    const ctx = {
      String, MAP_COL: null,
      getCustomerByLine: () => ({ data: mapRow('C1', '新規', stat) }),
      _lbContractTypeOf: () => '通常',
      _lbReserveCore: () => { called = true; return { success: true }; },
    };
    vm.createContext(ctx);
    vm.runInContext(MAP_COL_SRC + '\n' + pluckFn(LB, 'makeReservationLine'), ctx);
    const r = ctx.makeReservationLine('U1', {});
    return { r, called };
  }
  const a = reserve('active');
  ok('④-1 ★active なら予約の本体へ進む', a.called === true && a.r.code !== 'CONTRACT_INACTIVE');
  const e = reserve('expired');
  ok('④-2 expired なら止める', e.called === false && e.r.code === 'CONTRACT_INACTIVE');
  //   ★配線：3時の同期が書いた値を、予約の入口が同じ列から読む
  const fixed = run([mapRow('C1', '新規', 'expired')], { C1: [row(d(2026, 11, 1), null)] }).members[0][6];
  const after = reserve(fixed);
  ok('④-3 ★同期の後、開始前の新規会員は予約の本体へ進む', after.called === true, fixed);
}

console.log('=== ⑤ 終了日の当日 ===');
{
  //   NOW は 10/29 10:00。10/29 終了の行（セルは0時）→ その日の終わりまで有効
  ok('⑤-1 ★終了日の当日（0時のセル）は active', run([mapRow('C6', 'x', 'active')], { C6: [row(d(2026, 9, 1), d(2026, 10, 29))] }).members[0][6] === 'active');
  ok('⑤-2 終了日の翌日は expired', run([mapRow('C6', 'x', 'active')], { C6: [row(d(2026, 9, 1), d(2026, 10, 28))] }).members[0][6] === 'expired');
}

console.log('=== ⑥ 振替の入口 ===');
{
  function transfer(rows, startISO) {
    let used = false, reserved = false; const freshSeen = [];
    const ctx = {
      String, Number, Math, isNaN, Date: class extends Date { constructor(...a) { if (a.length === 0) super(NOW); else super(...a); } },
      getCustomerByLine: () => ({ data: mapRow('C7', 'x', 'active') }),
      _lbContractRowsAll: (n, p, fresh) => { freshSeen.push(fresh); return rows; }, _lbPhoneByCustomerId: () => '', _lbContractTypeOf: () => '通常',
      LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
      _lbUseTransferCredit: () => { used = true; return { ok: true, rowIndex: 2 }; },
      _lbRevertTransferCredit: () => {},
      _lbReserveCore: () => { reserved = true; return { success: true }; },
      _lbHorizonGate: () => null,   // 予約できる最終日の関門は booking-horizon-gate.test.js で見る（ここは契約期間だけ）
    };
    vm.createContext(ctx);
    vm.runInContext(MAP_COL_SRC + '\n' + pluckFn(LB, '_lbContractEndOfDayMs') + '\n' + pluckFn(LB, '_lbInSomeContractPeriod') + '\n' + pluckFn(LB, 'makeTransferReservationLine'), ctx);
    const r = ctx.makeTransferReservationLine('U7', { startISO });
    return { r, used, reserved, freshSeen };
  }
  const gapRows = [row(d(2026, 9, 1), d(2026, 11, 30)), row(d(2027, 1, 1), null)];
  const a = transfer(gapRows, '2026-12-03T10:00:00+09:00');
  ok('⑥-1 ★契約の切れ目（12月）への振替は止める', a.r.code === 'OUT_OF_CONTRACT' && !a.reserved, JSON.stringify(a.r));
  ok('⑥-2 ★止めるときは振替権を使わない', a.used === false);
  ok('⑥-2b ★最新の契約を読む（fresh=true・キャッシュを使わない）', a.freshSeen.length > 0 && a.freshSeen.every((f) => f === true), JSON.stringify(a.freshSeen));
  ok('⑥-3 契約期間内（11月）は通す', transfer(gapRows, '2026-11-05T10:00:00+09:00').reserved === true);
  ok('⑥-4 ★終了日の当日の夜も通す', transfer(gapRows, '2026-11-30T20:00:00+09:00').reserved === true);
  ok('⑥-5 次の契約の初日は通す', transfer(gapRows, '2027-01-01T10:00:00+09:00').reserved === true);
  const mg = [row(d(2026, 9, 1), d(2026, 11, 30))]; mg.migrationGap = true;
  ok('⑥-6 移行ギャップは判定を保留（従来どおり通す）', transfer(mg, '2026-12-03T10:00:00+09:00').reserved === true);
}

console.log((fail === 0 ? '✅ ' : '⚠️ ') + `開始前の契約と契約状態 検証: ${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
