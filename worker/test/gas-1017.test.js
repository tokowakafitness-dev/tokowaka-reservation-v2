// 2026-10-17 の GAS 反映分を、実際に動かして確かめる。
//   実行: node worker/test/gas-1017.test.js
//
// ① 作業依頼の結果から顧客の氏名を伏せる（決定0089 の二重の守り）。結果と例外文は最後に必ず通す
// ② 二重書きの「溢れ」：全員の照合が一致したら確かめ済みにし、毎朝の「至急」を止める。dry では書かない
// ③ 連続ルールの記録にトレーナーと時刻を足す（10/16 の dry で弾いた2件を確かめられなかった）

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LB = readFileSync(join(ROOT, 'gas/LineBooking.js'), 'utf8');
const PE = readFileSync(join(ROOT, 'gas/PushToEdge.js'), 'utf8');
const EJ = readFileSync(join(ROOT, 'gas/EdgeJob.js'), 'utf8');
let pass = 0, fail = 0;
function ok(name, cond, why) {
  if (cond) { pass++; return; }
  fail++; console.log(`❌ ${name}`); if (why) console.log(`   ${why}`);
}
function pluckFn(src, name) {
  const m = src.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('見つからない: ' + name);
  return m[0];
}

console.log('=== ① 氏名を伏せる ===');
{
  const ctx = { String };
  vm.createContext(ctx);
  vm.runInContext(pluckFn(EJ, '_ejScrub'), ctx);
  const S = (t) => ctx._ejScrub(t);
  //   実際の点検の文（10/16・10/17）の形
  const a = S('⚠️ [カレンダー] 1件 … 台帳に無い予定＝枠が売れない: 10/17 13:00 中垣宏章様（通常_沖／B1）');
  ok('①-1 ★「氏名＋様」を伏せる', a.indexOf('中垣') < 0 && a.indexOf('〇〇様（通常_沖／B1）') > 0, a);
  const b = S('担当calの残骸: 10/16 12:00 小倉 滉太様（鈴木 神海感留）');
  ok('①-2 ★空白をはさむ氏名も伏せる・トレーナー（様なし）は残す', b.indexOf('小倉') < 0 && b.indexOf('滉太') < 0 && b.indexOf('鈴木 神海感留') > 0, b);
  ok('①-3 カタカナ・英字の氏名も伏せる', S('：ヤマダタロウ様 / Smith様') === '：〇〇様 / 〇〇様', S('：ヤマダタロウ様 / Smith様'));
  ok('①-4 2回通しても変わらない', S(a) === a);
  ok('①-5 電話・メールの伏字は前のまま', S('090-1234-5678 a@b.co') === '（電話） （メール）', S('090-1234-5678 a@b.co'));
  ok('①-6 様の無い文は変えない', S('会員#1234 の残数 3') === '会員#1234 の残数 3');
  ok('①-6b ★「・」をはさむ氏名もまとめて伏せる', S('：カトウ・マリア様') === '：〇〇様', S('：カトウ・マリア様'));
  //   ★様を付けない窓口（統合の下見・移行前の点検）：名簿・台帳・契約の氏名で伏せる
  const ctx2 = { String, Number, Object, _lbNormName: (x) => x,
    LINE_BOOKING: { MAP_SHEET: 'map', RESV_SHEET: 'resv' }, MAP_COL: { NAME: 3 },
    _lbSheet: (n) => ({ getLastRow: () => 3, getRange: () => ({ getValues: () => (n === 'map' ? [['山田 太郎'], ['1234']] : [['佐藤花子様'], ['2026']]) }) }),
    _lbContractSheet: () => ({ getLastRow: () => 2, getLastColumn: () => 3,
      getRange: (r, c) => ({ getValues: () => (r === 1 ? [['x', '氏名', 'y']] : [['高橋　一郎']]) }) }),
    _lbContractCols: (h) => ({ name: h.indexOf('氏名') }) };
  vm.createContext(ctx2);
  vm.runInContext(pluckFn(EJ, '_ejScrub') + '\nvar _EJ_NAMES = null;\n' + pluckFn(EJ, '_ejNameList'), ctx2);
  const t = ctx2._ejScrub('■ 山田 太郎（2件の登録） / 山田太郎 / 佐藤花子 / - 高橋　一郎（1行） / 高橋 一郎 / 鈴木 神海感留');
  ok('①-9 ★様の無い氏名も伏せる（名簿・台帳・契約、空白の揺れも）', !/山田|太郎|佐藤|花子|高橋|一郎/.test(t) && /鈴木 神海感留/.test(t), t);
  const t2 = ctx2._ejScrub('会員#1234 2026-10-17');
  ok('①-11 数字だけの値は名前とみなさない（会員#・日付を壊さない）', t2 === '会員#1234 2026-10-17', t2);
  const ctx3 = { String, _ejNameList: () => { throw new Error('x'); } };
  vm.createContext(ctx3); vm.runInContext(pluckFn(EJ, '_ejScrub'), ctx3);
  ok('①-10 一覧が読めなくても落ちない（様の置き換えは効く）', ctx3._ejScrub('中垣宏章様') === '〇〇様');
  //   配線：報告する直前に結果も例外文も通す（窓口ごとの付け忘れをここで拾う）
  ok('①-7 ★報告の result は必ず _ejScrub を通す', /result: '\[' \+ claimed\.op \+ '\] ' \+ Math\.round\(\(Date\.now\(\) - t0\) \/ 1000\) \+ '秒\\n' \+ _ejScrub\(text\)/.test(EJ));
  ok('①-8 ★例外文も _ejScrub を通す', /err = _ejScrub\(String\(\(e && e\.message\) \|\| e\)\)\.slice\(0, 300\)/.test(EJ));
}

console.log('=== ② 溢れの確かめ済み ===');
{
  function run({ over, ack, verify, dry, setThrows }) {
    const props = { LB_DUALWRITE_OVERFLOW: over == null ? null : String(over), LB_DUALWRITE_OVERFLOW_ACK: ack == null ? null : String(ack) };
    const writes = [];
    const ctx = {
      String, Number, JSON, Object, Math, Date,
      LB_DW: { OVERFLOW_PROP: 'LB_DUALWRITE_OVERFLOW', OVERFLOW_ACK_PROP: 'LB_DUALWRITE_OVERFLOW_ACK', LAST_PROP: 'LB_DUALWRITE_LAST' },
      PropertiesService: { getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { if (setThrows) throw new Error('quota'); writes.push([k, v]); props[k] = v; },
      }) },
      _lbDwReadQueue: () => ({}),
      _edgeQuotaVerify: () => verify,
    };
    vm.createContext(ctx);
    vm.runInContext(pluckFn(PE, '_edgeQuotaAllGood') + '\n' + pluckFn(PE, 'lbDwDailyCheck'), ctx);
    const out = ctx.lbDwDailyCheck(dry);
    return { out, writes, item: out.filter((x) => x.key === 'dualwrite_overflow')[0] };
  }
  //   本物の照合が返す鍵を全部そろえる（足りない鍵があると「一致」と言わない作りなので）
  const GOOD = { done: true, checked: 41, differ: 0, skipped: 0, coverageMissing: 0, staleCoverage: 0,
                 overUsedPacks: 0, overUsedMonths: 0, quotaInvariantBroken: 0, keyMismatch: 0, keyRangeMissing: 0, keyChecked: 41,
                 orphans: { quotaRows: 0, packRows: 0, allocRows: 0 } };
  let r = run({ over: 1, ack: 0, verify: GOOD });
  ok('②-1 ★照合が全員一致なら確かめ済みを累計まで進める', JSON.stringify(r.writes) === '[["LB_DUALWRITE_OVERFLOW_ACK","1"]]', JSON.stringify(r.writes));
  ok('②-2 ★その日は至急にしない（info・理由つき）', r.item && r.item.severity === 'info' && /全員一致/.test(r.item.detail), JSON.stringify(r.item));
  r = run({ over: 1, ack: 1, verify: GOOD });
  ok('②-3 ★確かめ済みの翌朝からは何も出さない', !r.item && r.writes.length === 0, JSON.stringify(r.out));
  r = run({ over: 3, ack: 1, verify: Object.assign({}, GOOD, { differ: 1 }) });
  ok('②-4 ★食い違いがあれば至急のまま・確かめ済みを進めない', r.item && r.item.severity === 'high' && r.item.count === 2 && r.writes.length === 0, JSON.stringify(r));
  r = run({ over: 1, ack: 0, verify: Object.assign({}, GOOD, { done: false }) });
  ok('②-5 照合が最後まで届かなければ進めない', r.item.severity === 'high' && r.writes.length === 0);
  r = run({ over: 1, ack: 0, verify: Object.assign({}, GOOD, { skipped: 2 }) });
  ok('②-6 比べられない会員がいれば進めない', r.item.severity === 'high' && r.writes.length === 0);
  r = run({ over: 1, ack: 0, verify: Object.assign({}, GOOD, { checked: 0 }) });
  ok('②-7 誰も比べていなければ進めない', r.item.severity === 'high' && r.writes.length === 0);
  r = run({ over: 1, ack: 0, verify: Object.assign({}, GOOD, { staleCoverage: 1 }) });
  ok('②-8 覆い方の欠けがあれば進めない', r.item.severity === 'high' && r.writes.length === 0);
  r = run({ over: 1, ack: 0, verify: GOOD, dry: true });
  ok('②-9 ★dry（作業依頼の点検）では書かない', r.writes.length === 0 && r.item.severity === 'info' && /dry/.test(r.item.detail), JSON.stringify(r));
  r = run({ over: 1, ack: 0, verify: GOOD, dry: { triggerUid: 1 } });
  ok('②-10 トリガーのイベント（オブジェクト）は dry 扱いしない', r.writes.length === 1);
  r = run({ over: 2, ack: 5, verify: Object.assign({}, GOOD, { differ: 1 }) });
  ok('②-11 確かめ済みが累計より大きい（壊れた）なら 0 とみなして知らせる', r.item && r.item.count === 2 && r.item.severity === 'high', JSON.stringify(r.item));
  r = run({ over: 2, ack: 'abc', verify: Object.assign({}, GOOD, { differ: 1 }) });
  ok('②-12 確かめ済みが読めないなら 0 とみなして知らせる', r.item && r.item.count === 2);
  r = run({ over: 1, ack: 0, verify: GOOD, setThrows: true });
  ok('②-13 確かめ済みを書けなければ至急のまま', r.item.severity === 'high');
  r = run({ over: 0, ack: 0, verify: GOOD });
  ok('②-14 溢れが無ければ何も出さず書かない', !r.item && r.writes.length === 0);
  //   ★表示の「全員一致」と同じ条件（関門②：確かめ済みの側だけ条件が少なかった）
  for (const [k, val] of [['orphans', { quotaRows: 0, packRows: 0, allocRows: 1 }], ['orphans', null], ['keyMismatch', 1],
                          ['keyRangeMissing', 1], ['keyChecked', 0], ['quotaInvariantBroken', 1], ['overUsedPacks', 1],
                          ['overUsedMonths', 1], ['keyMismatch', undefined]]) {
    r = run({ over: 1, ack: 0, verify: Object.assign({}, GOOD, { [k]: val }) });
    ok('②-15 ★' + k + '=' + JSON.stringify(val) + ' なら進めない', r.item.severity === 'high' && r.writes.length === 0);
  }
  ok('②-16 ★表示と確かめ済みが同じ判定を使う（複製しない）',
     /var allGood = _edgeQuotaAllGood\(v\);/.test(PE) && /if \(fresh > 0 && _edgeQuotaAllGood\(v\)\) \{/.test(PE));
  ok('②-17 ★日次点検は dryRun を渡す', /var dw = lbDwDailyCheck\(dryRun\);/.test(LB));
}

console.log('=== ③ 連続ルールの記録にトレーナーと時刻 ===');
{
  const ctx = { String, SETTINGS: { TIMEZONE: 'Asia/Tokyo' },
    Utilities: { formatDate: (d) => d.toISOString().slice(0, 16).replace('T', ' ') } };
  vm.createContext(ctx);
  vm.runInContext(pluckFn(LB, '_lbConsecWhere'), ctx);
  const w = ctx._lbConsecWhere({ name: '鈴木 神海感留' }, new Date('2026-10-17T09:00:00Z'));
  ok('③-1 トレーナーの姓と開始時刻を足す', w === ' tr=鈴木 at=2026-10-17 09:00', w);
  ok('③-2 壊れた入力でも落ちない', typeof ctx._lbConsecWhere(null, null) === 'string');
  const dry = pluckFn(LB, '_lbConsecDryRecord');
  ok('③-3 ★dry の記録に付く', /\+ _lbConsecWhere\(trainer, st\)\);/.test(dry));
  ok('③-4 ★on で弾いた記録にも付く', /\+ _lbConsecWhere\(trainer, start\)\); \} catch \(eCl\) \{\}/.test(LB));
  ok('③-5 ms= は前に残る（判定時間の集計を壊さない）', /' ms=' \+ \(Date\.now\(\) - t0\)\s*\+ _lbConsecWhere/.test(dry));
  ok('③-6 ★記録を読む窓口がある（作業依頼 args.consecLog）', /if \(args && args\.consecLog\) return _ejScrub\(consecLogText\(Number\(args\.consecLog\)\)\);/.test(EJ));
}

console.log('=== ④ 進行中のセッションを「台帳に無い」と誤報しない ===');
{
  //   台帳は開始が now 以降・カレンダーは進行中も返す。範囲をそろえる。実際に動かして確かめる
  const now = new Date('2026-10-17T04:05:00Z');   // 13:05 JST
  const mkEv = (iso, title, desc) => ({ getStartTime: () => new Date(iso), getTitle: () => title, getDescription: () => desc || 'channel：line' });
  //   進行中の正しい予約（中垣）・進行中の残骸（変更済みなのに予定が残った：残骸花子）・未来の予約（未来太郎）
  const calEvs = [mkEv('2026-10-17T04:00:00Z', '中垣宏章様（通常_沖）'), mkEv('2026-10-17T03:30:00Z', '残骸花子様（通常_沖）'),
                  mkEv('2026-10-17T06:00:00Z', '未来太郎様（通常_沖）'), mkEv('2026-10-17T03:45:00Z', '消化漏子様（通常_沖）')];
  const trEvs = [mkEv('2026-10-17T04:00:00Z', '✅ 中垣宏章様｜_line'), mkEv('2026-10-17T03:30:00Z', '✅ 残骸花子様｜_line'),
                 mkEv('2026-10-17T06:00:00Z', '✅ 未来太郎様｜_line'), mkEv('2026-10-17T03:45:00Z', '✅ 消化漏子様｜_line')];
  const RealDate = Date;
  class FakeDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(now.getTime()); } static now() { return now.getTime(); } }
  const fmt = (d, tz, f) => {
    const j = new RealDate(d.getTime() + 9 * 3600000).toISOString();
    if (f === 'yyyyMMddHHmm') return j.slice(0, 4) + j.slice(5, 7) + j.slice(8, 10) + j.slice(11, 13) + j.slice(14, 16);
    if (f === 'M/d HH:mm') return Number(j.slice(5, 7)) + '/' + Number(j.slice(8, 10)) + ' ' + j.slice(11, 16);
    return j.slice(0, 16);
  };
  const ctx = {
    String, Number, JSON, Object, Math, Array, Date: FakeDate, Logger: { log: () => {} },
    SETTINGS: { TIMEZONE: 'Asia/Tokyo' }, Utilities: { formatDate: fmt },
    LINE_BOOKING: { RESV_SHEET: 'r' },
    CALENDAR_IDS: { CAPACITY_B1: 'b1', CAPACITY_1F: 'f1', TRAINERS: [{ id: 't2', name: '沖 孟', email: 'oki' }] },
    _lbBookingHorizonEnd: () => new RealDate('2026-10-31T00:00:00Z'),
    _lbParseResvDate: (x) => new RealDate(x),
    _lbNormTok: (x) => x,
    _lbSheet: () => ({ getLastRow: () => 5, getRange: () => ({ getValues: () => [
      ['2026-10-17T03:45:00Z', '消化漏子', '', '', 't2', '沖 孟', 'consumed', '', '', 'line', ''],
      ['2026-10-17T04:00:00Z', '中垣宏章', '', '', 't2', '沖 孟', 'confirmed', '', '', 'line', ''],
      ['2026-10-17T03:30:00Z', '残骸花子', '', '', 't2', '沖 孟', 'changed', '', '', 'line', ''],
      ['2026-10-17T06:00:00Z', '未来太郎', '', '', 't2', '沖 孟', 'confirmed', '', '', 'line', ''],
    ] }) }),
    CalendarApp: { getCalendarById: (id) => ({ getEvents: () => (id === 'oki' ? trEvs : (id === 'b1' ? calEvs : [])) }) },
    _lbClassifyBooking: (t) => { const m = t.match(/^(.+?)様（通常_(.+?)）/); return m ? { parsed: true, mode: 'session', cname: m[1], kind: '通常', sur: m[2] } : { parsed: false }; },
  };
  vm.createContext(ctx);
  vm.runInContext(pluckFn(LB, 'debugOrphanEvents'), ctx);
  let r = null, err = '';
  try { r = ctx.debugOrphanEvents(); } catch (e) { err = e.message; }
  ok('④-1 突合が最後まで動く', r && Array.isArray(r.orphanB1), err);
  const all = r ? JSON.stringify([r.orphanB1, r.orphanTrainer, r.missingB1, r.missingTrainer, r.manual]) : '';
  ok('④-2 ★進行中のセッションを出さない（施設cal・トレーナーcalとも）', r && all.indexOf('中垣') < 0, all);
  ok('④-3 未来の予約は台帳と一致する（誤って全部落としていない）', r && all.indexOf('未来太郎') < 0 && r.missingB1.length === 0, all);
  ok('④-4 ★開始済みでも、台帳が changed の残骸は施設cal・トレーナーcalの両方で出す（関門②）',
     r && JSON.stringify(r.orphanB1).indexOf('残骸花子') > 0 && JSON.stringify(r.orphanTrainer).indexOf('残骸花子') > 0, all);
  ok('④-4b ★当日キャンセル（consumed）なのに改名・削除に失敗して残った予定は出す（関門②）',
     r && JSON.stringify(r.orphanB1).indexOf('消化漏子') > 0 && JSON.stringify(r.orphanTrainer).indexOf('消化漏子') > 0, all);
  ok('④-5 開始済みは「台帳にあるのにカレンダーに無い」の対象にしない（[消化]に変わるのが正常）',
     /if \(!started\) ledgerList\.push\(k\);/.test(pluckFn(LB, 'debugOrphanEvents')));
}

console.log(`\n${fail ? '❌' : '✅'} 10/17 の GAS 反映分 検証: ${pass} passed / ${fail} failed`);
if (fail) process.exit(1);
