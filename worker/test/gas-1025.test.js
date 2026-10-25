// 2026-10-25：固定枠の自動予約を「日付の早い順」に取り、本人の予約が既にある日は「取れている」と数える。動かして確かめる。
//   実行: node worker/test/gas-1025.test.js
//
//   ① 入口から：火・木の固定枠で回数が足りないとき、落ちるのは月末側（行の順ではなく日付順）
//   ② 入口から：本人の予約が同じ時刻にある日は予約しに行かず、「取れている」に数える（SLOT_TAKEN にしない）
//   ③ 通知：回数が足りずに取らなかった日は「別の時間を」と言わない／トレーナー向けに既存の件数を出す／各行は全角15文字以内
//   ④ 25日のお知らせが読む記録：既存の予約も取れた件数に入る（全部そろっていれば「自動でお取りしました」）
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
const pad = (n) => ('0' + n).slice(-2);
const Utilities = { formatDate: (d, tz, f) => f === 'HH:mm' ? pad(d.getHours()) + ':' + pad(d.getMinutes()) : String(d) };
const SETTINGS = { TIMEZONE: 'Asia/Tokyo', SESSION_MINUTES: 60 };
const _lbSs = () => ({ getSpreadsheetTimeZone: () => 'Asia/Tokyo' });
const RP_COL = { PATTERN_ID: 1, CUSTOMER_ID: 2, WEEKDAY: 3, TIME: 4, TRAINER_ID: 5, ACTIVE: 6, SOURCE: 7, CREATED_AT: 8, LAST_MONTH: 9, NOTE: 10 };
const RT = 'var _LB_RECUR_TZ = null;\n' + pluckFn(LB, '_lbRecurTz') + '\n' + pluckFn(LB, '_lbRecurTime');
const noRemainSrc = (LB.match(/var _LB_AUTOBOOK_NO_REMAIN = [^\n]*/) || [''])[0] + '\n' + (LB.match(/var _LB_AUTOBOOK_NEED_REVIEW = [^\n]*/) || [''])[0];

//   2026-10-25 06:00 に走らせて 11月を取る。quota＝予約できる回数（超えたら NO_REMAINING）
function run({ rows, quota, mine = [], ledgerNull = false }) {
  const calls = [], props = {}, notices = [], logs = [], enq = [];
  let left = quota;
  const ctx = { Utilities, SETTINGS, String, Number, isNaN, isFinite, Math, JSON, Object, _lbSs, RP_COL, Logger: { log: (m) => logs.push(String(m)) },
    Date: class extends Date { constructor(...a) { if (a.length === 0) super(2026, 9, 25, 6, 0, 0); else super(...a); } static now() { return new Date(2026, 9, 25, 6).getTime(); } },
    _lbTruthy: (v) => v === true, LB_AUTOBOOK_RESULT_PREFIX: 'LB_AUTOBOOK_RESULT_',
    _lbRecurSheet: () => ({ getLastRow: () => rows.length + 1, getRange: () => ({ getValues: () => rows, setValue: () => {} }) }),
    _lbResvSessions: () => ledgerNull ? null : mine.map((ms) => ({ startAt: ms })),
    _lbCustInfoById: () => ({ customerId: 'C1' }), _lbPickBalancedTrainer: () => 'B',
    _lbReserveCore: (ci, body) => { calls.push(body.startISO); if (left <= 0) return { success: false, code: 'NO_REMAINING' }; left--; return { success: true }; },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    _lbDwMarkDirty: () => {}, lbDwEnqueue: (c) => { enq.push(c); return 1; },
    _lbNotifyAutoBook: (c, b, s) => notices.push({ b, s }) };
  vm.createContext(ctx);
  vm.runInContext([RT, pluckFn(LB, '_lbDatesOfWeekdayInMonth'), pluckFn(LB, 'autoBookRecurringPatterns')].join('\n'), ctx);
  ctx.autoBookRecurringPatterns();
  return { calls, props, notice: notices[0], logs, enq };
}
const day = (d) => `${d.getMonth() + 1}/${d.getDate()}`;

console.log('=== ① 日付の早い順 ===');
{
  //   ★木曜の行を先に置く（行の順に取ると木曜4回→火曜が先に尽きる）。11月は火曜4回・木曜4回。回数は7回
  const rows = [['P-T', 'C1', 4, '09:00', 'B', true, '', '', '', ''], ['P-U', 'C1', 2, '09:00', 'B', true, '', '', '', '']];
  const r = run({ rows, quota: 7 });
  const booked = r.notice.b.map((x) => day(x.start)), skipped = r.notice.s.map((x) => day(x.start));
  ok('①-1 ★取った7回は日付の早い順', JSON.stringify(booked) === JSON.stringify(['11/3', '11/5', '11/10', '11/12', '11/17', '11/19', '11/24']), JSON.stringify(booked));
  ok('①-2 ★落ちるのは月末の1回（11/26）', JSON.stringify(skipped) === JSON.stringify(['11/26']), JSON.stringify(skipped));
  ok('①-3 落ちた理由は回数切れ', r.notice.s[0].code === 'NO_REMAINING');
}

console.log('=== ② 本人の予約が既にある日 ===');
{
  const rows = [['P-U', 'C1', 2, '09:00', 'B', true, '', '', '', '']];   // 火曜：11/3 10 17 24
  const mine = [new Date(2026, 10, 3, 9).getTime(), new Date(2026, 10, 17, 9).getTime()];
  const r = run({ rows, quota: 10, mine });
  ok('②-1 ★既にある日（11/3・11/17）は予約しに行かない', r.calls.length === 2 && r.calls.every((iso) => ![3, 17].includes(new Date(iso).getDate())), JSON.stringify(r.calls));
  ok('②-2 ★既にある日は「取れている」に数える（取れず0件）', r.notice.b.length === 4 && r.notice.s.length === 0);
  ok('②-3 既にある日には印が付く', r.notice.b.filter((x) => x.already).length === 2);
  const rec = JSON.parse(r.props['LB_AUTOBOOK_RESULT_2026-11']).C1;
  ok('④-1 ★25日のお知らせが読む記録：全部そろっている（b=4・s=0）', rec.b === 4 && rec.s === 0, JSON.stringify(rec));
  //   手入力で全部入っていた片山様の形（10/25）
  const all = [3, 10, 17, 24].map((d) => new Date(2026, 10, d, 9).getTime());
  const r2 = run({ rows, quota: 0, mine: all });
  ok('②-4 ★全部手入力済みなら1件も予約しに行かず、取れず0件', r2.calls.length === 0 && r2.notice.s.length === 0 && r2.notice.b.length === 4);
  ok('②-5 既存の予約しか無い会員は D1 への同期に積まない', r2.enq.length === 0 && r.enq.length === 1);
  //   9:15 の手入力・秒のずれ（Date 型の 09:00:01）も「取れている」。通知には実際の時刻
  const r3 = run({ rows, quota: 10, mine: [new Date(2026, 10, 3, 9, 15).getTime(), new Date(2026, 10, 10, 9, 0, 1).getTime()] });
  ok('②-6 ★9:15 の手入力も「取れている」（9:00 を取りに行かない）', !r3.calls.some((iso) => new Date(iso).getDate() === 3), JSON.stringify(r3.calls));
  ok('②-7 ★秒のずれ（09:00:01）も「取れている」', !r3.calls.some((iso) => new Date(iso).getDate() === 10));
  const a3 = r3.notice.b.find((x) => x.already && x.start.getDate() === 3);
  ok('②-8 通知には実際の時刻（9:15）を出す', a3 && a3.start.getMinutes() === 15);
  //   1時間ずれた予約（10:00）は別の予約＝9:00 は取りに行く
  const r4 = run({ rows, quota: 10, mine: [new Date(2026, 10, 3, 10, 0).getTime()] });
  ok('②-9 1時間ずれた本人の予約は別物（9:00 を取りに行く）', r4.calls.some((iso) => new Date(iso).getDate() === 3));
  //   担当だけ違う同じ日時の行が2つ → 1つにまとめる
  const dup = [['P-1', 'C1', 2, '09:00', 'B', true, '', '', '', ''], ['P-2', 'C1', 2, '09:00', 'C', true, '', '', '', '']];
  const r5 = run({ rows: dup, quota: 10, mine: [new Date(2026, 10, 3, 9).getTime()] });
  ok('②-10 ★同じ日時の行が2つでも二重に数えない', r5.notice.b.length === 4 && r5.calls.length === 3, r5.notice.b.length + ' / ' + r5.calls.length);
  //   ★1件の予約を複数の候補に使い回さない（Codex関門②）。同じ日に 9:00 と 9:30 の固定枠
  const two = [['P-1', 'C1', 2, '09:00', 'B', true, '', '', '', ''], ['P-2', 'C1', 2, '09:30', 'B', true, '', '', '', '']];
  const r7 = run({ rows: two, quota: 20, mine: [new Date(2026, 10, 3, 9, 15).getTime()] });
  const d3 = r7.notice.b.filter((x) => x.start.getDate() === 3);
  ok('②-12 ★9:15 の1件は片方にだけ使う（もう片方は取りに行く）', d3.filter((x) => x.already).length === 1 && r7.calls.filter((iso) => new Date(iso).getDate() === 3).length === 1, JSON.stringify(r7.calls.filter((iso) => new Date(iso).getDate() === 3)));
  const r8 = run({ rows: two, quota: 20, mine: [new Date(2026, 10, 3, 9, 30).getTime()] });
  const call3 = r8.calls.filter((iso) => new Date(iso).getDate() === 3).map((iso) => new Date(iso).getMinutes());
  ok('②-13 ★本人の予約 9:30 は 9:30 の候補に当てる（9:00 は取りに行く）', JSON.stringify(call3) === '[0]', JSON.stringify(call3));
  const r9 = run({ rows: [['P-1', 'C1', 1, '00:00', 'B', true, '', '', '', '']], quota: 20, mine: [new Date(2026, 10, 1, 23, 30).getTime()] });
  ok('②-14 前日 23:30 の予約を翌日 0:00 の固定枠に当てない', r9.calls.some((iso) => { const x = new Date(iso); return x.getDate() === 2 && x.getHours() === 0; }), JSON.stringify(r9.calls.slice(0, 2)));
  //   ★近い組から決めると取りこぼす形（Codex関門②）：固定枠 9:00・10:00／本人の予約 8:10・9:20 → 2件とも既存
  const t910 = [['P-1', 'C1', 2, '09:00', 'B', true, '', '', '', ''], ['P-2', 'C1', 2, '10:00', 'B', true, '', '', '', '']];
  const r10 = run({ rows: t910, quota: 20, mine: [new Date(2026, 10, 3, 8, 10).getTime(), new Date(2026, 10, 3, 9, 20).getTime()] });
  ok('②-15 ★割り当てる件数を最大に（8:10↔9:00・9:20↔10:00 で2件とも既存）', !r10.calls.some((iso) => new Date(iso).getDate() === 3)
     && r10.notice.b.filter((x) => x.already && x.start.getDate() === 3).length === 2, JSON.stringify(r10.calls.filter((iso) => new Date(iso).getDate() === 3)));
  //   ★答えが「全部試した場合」と同じか（乱数で300通り）。11/3（火）だけに候補と本人の予約を置く
  {
    let seed = 7; const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const brute = (cs, ms) => {   // 件数の最大を全部試して求める
      let best = 0; const used = new Array(ms.length).fill(false);
      (function rec(i, n) { if (i === cs.length) { best = Math.max(best, n); return; } rec(i + 1, n);
        for (let q = 0; q < ms.length; q++) if (!used[q] && Math.abs(ms[q] - cs[i]) < 3600000) { used[q] = true; rec(i + 1, n + 1); used[q] = false; } })(0, 0);
      return best;
    };
    let bad = '';
    for (let t = 0; t < 1500 && !bad; t++) {
      const nc = 1 + rnd(5), nm = 1 + rnd(5), times = new Set();
      while (times.size < nc) times.add(9 * 60 + 15 * rnd(12));
      const rws = [...times].map((m, i) => ['P' + i, 'C1', 2, pad(Math.floor(m / 60)) + ':' + pad(m % 60), 'B', true, '', '', '', '']);
      const ms = Array.from({ length: nm }, () => new Date(2026, 10, 3, 0, 8 * 60 + 10 * rnd(30)).getTime());
      const cs = [...times].map((m) => new Date(2026, 10, 3, 0, m).getTime());
      const r = run({ rows: rws, quota: 99, mine: ms });
      const got = r.notice.b.filter((x) => x.already && x.start.getDate() === 3).length;
      const want = brute(cs, ms);
      if (got !== want) bad = `候補 ${[...times]} / 予約 ${ms.map((x) => new Date(x).toTimeString().slice(0, 5))} → ${got}（正しくは ${want}）`;
    }
    ok('②-16 ★割り当てる件数は全部試した場合と同じ（1500通り）', !bad, bad);
  }
  //   異常データ：同じ日に候補40・予約40でも一瞬で終わる（全部試すと終わらない大きさ）
  {
    const many = Array.from({ length: 40 }, (_, i) => ['P' + i, 'C1', 2, pad(7 + Math.floor(i / 4)) + ':' + pad((i % 4) * 15), 'B', true, '', '', '', '']);
    const ms = Array.from({ length: 40 }, (_, i) => new Date(2026, 10, 3, 7, i * 15 + 5).getTime());
    const t0 = Date.now(); run({ rows: many, quota: 999, mine: ms }); const el = Date.now() - t0;
    ok('②-17 ★同じ日に候補40・予約40でも 1秒未満', el < 1000, el + 'ms');
  }
  const r6 = run({ rows, quota: 10, ledgerNull: true });
  ok('②-11 台帳が読めないことをログに残す（予約は従来どおり進む）', r6.logs.some((l) => /予約台帳が読めません/.test(l)) && r6.calls.length === 4);
}

console.log('=== ③ 通知 ===');
{
  const pushes = [];
  const ctx = { String, Number, JSON, Utilities, SETTINGS,
    _lbCustInfoById: () => ({ customerName: 'テスト', lineUserId: 'U1' }), _lbMemberLang: () => 'ja', _lbNormLang: (l) => l,
    _lbFmtResvLabel: (iso) => new Date(iso).getDate() + '日', _lbPush: (to, msg, tag) => pushes.push([to, msg, tag]),
    getTrainerLineId: () => 'T1', _lbCustTrainerId: () => 'B', _lbOwnerLineIds: () => [] };
  vm.createContext(ctx); vm.runInContext(noRemainSrc + '\n' + pluckFn(LB, '_lbNotifyAutoBook'), ctx);
  const b = [{ start: new Date(2026, 10, 3, 9), already: true }, { start: new Date(2026, 10, 5, 9) }];
  const s = [{ start: new Date(2026, 10, 26, 9), code: 'NO_REMAINING' }, { start: new Date(2026, 10, 12, 9), code: 'SLOT_TAKEN' },
             { start: new Date(2026, 10, 19, 9), code: 'NO_CONTRACT' }];
  ctx._lbNotifyAutoBook('C1', b, s);
  const cust = pushes.find((p) => p[2] === 'autobook_customer')[1];
  const tr = pushes.find((p) => p[2] === 'autobook_trainer')[1];
  const blocks = cust.split('\n\n');
  const other = blocks.find((x) => x.startsWith('【お取りできませんでした】')) || '';
  const rem = blocks.find((x) => x.startsWith('【ご契約の回数を超えるため')) || '';
  ok('③-1 ★回数切れの日は「別の時間を」の段に入れない', !/26日/.test(other) && /26日/.test(rem), cust);
  ok('③-2 枠が埋まっていた日は今までどおり「別の時間を」', /12日/.test(other));
  const rev = blocks.find((x) => x.startsWith('【ご契約情報の確認が必要なため')) || '';
  ok('③-2b ★契約が確認できない日は「回数」でも「別の時間を」でもない段', /19日/.test(rev) && !/19日/.test(rem) && !/19日/.test(other), cust);
  ok('③-3 既存の予約も【ご予約】に載る', /【ご予約】\n・3日\n・5日/.test(cust), cust);
  ok('③-4 トレーナー向けに既存の件数を出す', /予約2件（うち既に予約済み1件） \/ 取れず3件/.test(tr), tr);
  const w = (x) => [...x].reduce((a, ch) => a + (/[\x20-\x7e]/.test(ch) ? 0.5 : 1), 0);
  ok('③-5 会員向けの各行は全角15文字以内', cust.split('\n').every((l) => w(l) <= 15), cust);
}

console.log(`\n${fail ? '❌' : '✅'} 10/25 固定枠の自動予約 検証: ${pass} passed / ${fail} failed`);
if (fail) process.exit(1);
