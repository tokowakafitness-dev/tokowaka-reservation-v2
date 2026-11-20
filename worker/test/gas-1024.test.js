// 2026-10-24：お知らせの改行を LINE の吹き出しの幅に合わせる／固定枠の時刻が日付型でも崩れない。動かして確かめる。
//   実行: node worker/test/gas-1024.test.js
//
//   ① _lbRecurTime：シートが返す Date（1899-12-30 09:00）を "09:00" に。文字の "9:00" も "09:00" に揃える
//   ② 固定枠の時刻を読む全員が _lbRecurTime を通る（String(...) で読む箇所を残さない）。書く側は文字で残す
//   ③ 入口から：日付型のセルでも自動予約は 9:00 に入る（0時0分にならない）
//   ③b 自動予約が1件も取れないとき、通知は「お取りしました」と言わない／③c 25日のお知らせは6時の自動予約で取れた会員にだけ「自動でお取りしました」
//   ④ 入口から：本番の Nudge.js で全種類の日本語の文面を組み立て、各行が全角15文字以内（半角は0.5）
//      崩れた時刻（1899 / GMT）が文面に出ない
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LB = readFileSync(join(ROOT, 'gas/LineBooking.js'), 'utf8');
const NU = readFileSync(join(ROOT, 'gas/Nudge.js'), 'utf8');
const PE = readFileSync(join(ROOT, 'gas/PushToEdge.js'), 'utf8');
let pass = 0, fail = 0;
function ok(name, cond, why) { if (cond) pass++; else { fail++; console.log(`❌ ${name}`); if (why) console.log(`   ${why}`); } }
function pluckFn(src, name) {
  const m = src.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('見つからない: ' + name);
  return m[0];
}
const pad = (n) => ('0' + n).slice(-2);
//   GAS の Utilities.formatDate の身代わり（HH:mm だけ）。テストの機械の時刻帯で作った Date をその時刻帯で読む
const tzSeen = [];
const Utilities = { formatDate: (d, tz, f) => { tzSeen.push(tz); return f === 'HH:mm' ? pad(d.getHours()) + ':' + pad(d.getMinutes()) : String(d); } };
const _lbSs = () => ({ getSpreadsheetTimeZone: () => 'Asia/Tokyo#sheet' });
const SETTINGS = { TIMEZONE: 'Asia/Tokyo' };
const cellDate = new Date(1899, 11, 30, 9, 0, 0);   // シートの時刻型セルが返す値

console.log('=== ① _lbRecurTime ===');
const RT = 'var _LB_RECUR_TZ = null;\n' + pluckFn(LB, '_lbRecurTz') + '\n' + pluckFn(LB, '_lbRecurTime');
const ctx1 = { Utilities, SETTINGS, String, Number, isNaN, _lbSs };
vm.createContext(ctx1); vm.runInContext(RT, ctx1);
ok('①-1 ★日付型のセル → "09:00"', ctx1._lbRecurTime(cellDate) === '09:00', ctx1._lbRecurTime(cellDate));
ok('①-2 文字の "9:00" → "09:00"', ctx1._lbRecurTime('9:00') === '09:00');
ok('①-3 文字の "18:30" はそのまま', ctx1._lbRecurTime('18:30') === '18:30');
ok('①-4 空・null は空', ctx1._lbRecurTime('') === '' && ctx1._lbRecurTime(null) === '');
ok('①-6 ★シートの時刻帯で読む（スクリプトの時刻帯ではない）', tzSeen[0] === 'Asia/Tokyo#sheet', String(tzSeen[0]));
ok('①-5 壊れた Date は空（Invalid Date を文面に出さない）', ctx1._lbRecurTime(new Date('x')) === '');

console.log('=== ② 読む全員・書く側 ===');
const all = LB + NU + PE;
ok('②-1 ★時刻の列を String(...) で読む箇所が無い', !/String\(v\[i\]\[RP_COL\.TIME - 1\]/.test(all));
ok('②-2 読む箇所は4つとも _lbRecurTime（自動予約・重複判定・一覧・写し）。文面は自動予約が残した時刻を使う',
   (all.match(/_lbRecurTime\(v\[i\]\[RP_COL\.TIME - 1\]\)/g) || []).length === 4 && !/_lbNudgeRecurIndex/.test(NU));
const add = pluckFn(LB, '_lbAddRecurPattern');
ok('②-3 書く側は入力の時刻を揃えてから比べる', /time = _lbRecurTime\(time\);/.test(add));
ok('②-4 書く側は時刻のセルを文字にする', /setNumberFormat\("@"\)\.setValue\(time\)/.test(add));

console.log('=== ③ 入口から：自動予約の時刻 ===');
{
  const booked = [], props = {}, pushes = [];
  const rows = [['P-1', 'C1', 2, cellDate, 'B', true, 'customer', '', '', '']];
  const ctx = { Utilities, SETTINGS, String, Number, isNaN, Math, Logger: { log: () => {} },
    Date: class extends Date { constructor(...a) { if (a.length === 0) { super(2026, 9, 25, 6, 0, 0); } else super(...a); } static now() { return new Date(2026, 9, 25, 6).getTime(); } },
    RP_COL: { PATTERN_ID: 1, CUSTOMER_ID: 2, WEEKDAY: 3, TIME: 4, TRAINER_ID: 5, ACTIVE: 6, SOURCE: 7, CREATED_AT: 8, LAST_MONTH: 9, NOTE: 10 },
    _lbTruthy: (v) => v === true,
    _lbRecurSheet: () => ({ getLastRow: () => rows.length + 1, getRange: () => ({ getValues: () => rows, setValue: () => {} }) }),
    _lbCustInfoById: () => ({ customerId: 'C1' }),
    _lbPickBalancedTrainer: () => 'B',
    _lbReserveCore: (ci, body) => { booked.push(body.startISO); return { success: true }; },
    _lbSs, LB_AUTOBOOK_RESULT_PREFIX: 'LB_AUTOBOOK_RESULT_', JSON,
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    _lbDwMarkDirty: () => {}, lbDwEnqueue: () => 1, _lbResvSessions: () => [],
    _lbNotifyAutoBook: () => {}, LockService: { getScriptLock: () => ({ waitLock: () => {}, tryLock: () => true, releaseLock: () => {} }) } };
  vm.createContext(ctx);
  vm.runInContext([RT, pluckFn(LB, '_lbDatesOfWeekdayInMonth'), pluckFn(LB, 'autoBookRecurringPatterns')].join('\n'), ctx);
  ctx.autoBookRecurringPatterns();
  const hours = booked.map((iso) => new Date(iso).getHours());
  ok('③-1 ★11月の火曜（4回）を予約しに行く', booked.length === 4, JSON.stringify(booked));
  ok('③-2 ★すべて 9時（0時0分にならない）', hours.length > 0 && hours.every((h) => h === 9), JSON.stringify(hours));
  ok('③-3 ★取れた件数を月ごとに残す（25日のお知らせが読む）', props['LB_AUTOBOOK_RESULT_2026-11'] === JSON.stringify({ C1: { b: 4, s: 0, p: [{ w: 2, t: '09:00' }] } }), JSON.stringify(props));
}

console.log('=== ③b 自動予約の通知の見出し ===');
{
  const pushes = [];
  const ctx = { String, Number, JSON, Utilities, SETTINGS,
    _lbCustInfoById: () => ({ customerName: 'テスト', lineUserId: 'U1' }), _lbMemberLang: () => 'ja', _lbNormLang: (l) => l,
    _lbFmtResvLabel: () => '11月4日(火) 09:00', _lbPush: (to, msg, tag) => pushes.push([to, msg, tag]),
    getTrainerLineId: () => '', _lbCustTrainerId: () => '', _lbOwnerLineIds: () => [] };
  vm.createContext(ctx); vm.runInContext((LB.match(/var _LB_AUTOBOOK_NO_REMAIN = [^\n]*/) || [''])[0] + '\n' + (LB.match(/var _LB_AUTOBOOK_NEED_REVIEW = [^\n]*/) || [''])[0] + '\n' + pluckFn(LB, '_lbNotifyAutoBook'), ctx);
  const d = { start: new Date(2026, 10, 4, 9) };
  ctx._lbNotifyAutoBook('C1', [], [d]);
  const allFail = pushes.find((p) => p[2] === 'autobook_customer')[1];
  ok('③b-1 ★1件も取れないとき「お取りしました」と言わない', !/お取りしました/.test(allFail) && /お取りできませんでした/.test(allFail), allFail);
  pushes.length = 0; ctx._lbNotifyAutoBook('C1', [d], []);
  const okMsg = pushes.find((p) => p[2] === 'autobook_customer')[1];
  ok('③b-2 取れたときは「自動でお取りしました」', /自動でお取りしました/.test(okMsg));
  const w = (s) => [...s].reduce((a, ch) => a + (/[\x20-\x7e]/.test(ch) ? 0.5 : 1), 0);
  ok('③b-3 見出しの各行も全角15文字以内', [allFail, okMsg].every((m) => m.split('\n').every((l) => w(l) <= 15)), allFail + ' | ' + okMsg);
}

console.log('=== ③c 25日のお知らせは自動予約の結果を見る ===');
{
  //   本番の判定の行を取り出して、そのまま動かす（形ではなく結果を見る）
  const line = NU.match(/var ab = autoBooked\[m\.customerId\];\n\s*var pats = [^\n]*\n\s*var label = [^\n]*/);
  ok('③c-0 判定の行が見つかる', !!line);
  const ctx = { Number, String, Utilities, SETTINGS, _lbSs, isNaN, JSON, Logger: { log: () => {} }, _lbNormLang: (l) => l || 'ja',
    LB_AUTOBOOK_RESULT_PREFIX: 'LB_AUTOBOOK_RESULT_',
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => k === 'LB_AUTOBOOK_RESULT_2026-11' ? '{"C1":{"b":4,"s":0,"p":[{"w":2,"t":"09:00"}]}}' : null }) } };
  vm.createContext(ctx);
  vm.runInContext(pluckFn(NU, '_lbNudgeAutoBookedIndex') + '\n' + pluckFn(LB, '_lbRecurLabel') +
    '\nfunction pick(autoBooked, m) { ' + (line ? line[0] : '') + '; return label; }', ctx);
  const m = { customerId: 'C1', lang: 'ja' };
  const lab = (o) => ctx.pick({ C1: o }, m);
  ok('③c-1 ★全部取れた会員だけ固定枠の文面（ラベルは6時に処理した固定枠）', lab({ b: 4, s: 0, p: [{ w: 2, t: '09:00' }] }) === '毎週火曜 09:00');
  ok('③c-2 ★一部でも取れなければ言い切らない', lab({ b: 3, s: 1, p: [{ w: 2, t: '09:00' }] }) === '');
  ok('③c-3 ★1件も取れなければ言い切らない', lab({ b: 0, s: 4, p: [{ w: 2, t: '09:00' }] }) === '');
  ok('③c-4 記録が無い会員は言い切らない', ctx.pick({}, m) === '');
  ok('③c-5 古い形（数字だけ）の記録でも言い切らない', lab(4) === '');
  ok('③c-6 記録の読み出し：ある月は中身、無い月は空', ctx._lbNudgeAutoBookedIndex('2026-11').C1.b === 4 && Object.keys(ctx._lbNudgeAutoBookedIndex('2026-12')).length === 0);
}

console.log('=== ④ 入口から：文面の幅 ===');
{
  const ctx = { String, Number, Math, Date, JSON, Utilities, SETTINGS, _lbSs, isNaN, Logger: { log: () => {} },
    _lbProp: () => '', _lbNormLang: (l) => l || 'ja', PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) } };
  vm.createContext(ctx);
  vm.runInContext(NU, ctx);
  vm.runInContext(RT + '\n' + pluckFn(LB, '_lbRecurLabel'), ctx);
  const K = vm.runInContext('LB_NUDGE_KIND', ctx);
  const width = (s) => [...s].reduce((w, ch) => w + (/[\x20-\x7e]/.test(ch) ? 0.5 : 1), 0);
  const LIMIT = 15;
  const label = ctx._lbRecurLabel(2, ctx._lbRecurTime(cellDate), 'ja');
  const f = (kind, days, carry, carried) => ctx._lbNudgeFactsText('ja', { remain: 12, days, carry }, carried, kind);
  const cases = [];
  for (const days of [7, 20]) {
    for (const kind of [K.TRANSFER, K.MONTH_OPEN, K.VISIT_B, K.VISIT_A]) {
      for (const catchUp of [false, true]) {
        const base = { monthLabel: '11月', remain: 12, carry: 1, days, quota: 12, next: '12月30日(水) 19:00', expire: '12月24日', facts: f(kind, days, 1, 2) };
        cases.push([`${kind}/${days}日/${catchUp ? '追いかけ' : '通常'}`, ctx._lbNudgeText(kind, 'ja', base, catchUp)]);
        if (kind === K.MONTH_OPEN) cases.push([`${kind}/固定枠/${days}日`, ctx._lbNudgeText(kind, 'ja', Object.assign({}, base, { pattern: label }), catchUp)]);
      }
    }
  }
  let over = [];
  for (const [name, text] of cases) {
    for (const line of text.split('\n')) {
      if (/^https?:\/\//.test(line)) continue;   // 予約画面のURLは折り返しても押せる
      if (/（毎週/.test(line)) continue;           // 固定枠の並びは件数で長さが変わる（下で別に見る）
      if (width(line) > LIMIT) over.push(`${name}: 「${line}」 ${width(line)}`);
    }
  }
  ok('④-1 ★全種類の日本語の文面で、各行が全角15文字以内', over.length === 0, over.slice(0, 8).join('\n   '));
  ok('④-2 文面を組み立てた数（取りこぼしていない）', cases.length === 20, String(cases.length));
  const fixed = cases.filter(([n]) => n.includes('固定枠')).map(([, t]) => t).join('\n');
  ok('④-3 ★固定枠の文面に崩れた時刻が出ない', !/1899|GMT/.test(fixed) && /毎週火曜 09:00/.test(fixed), fixed.split('\n').slice(3, 6).join(' / '));
  ok('④-4 差し込み忘れ（{...}）が残らない', cases.every(([, t]) => !/\{\w+\}/.test(t)));
}

console.log(`\n${fail ? '❌' : '✅'} 10/24 改行と固定枠の時刻 検証: ${pass} passed / ${fail} failed`);
if (fail) process.exit(1);
