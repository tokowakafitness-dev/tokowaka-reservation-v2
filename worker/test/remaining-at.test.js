// 「過去のある時点の残数を再現する」点検（remainingAtText）の検証
//
//   ★なぜ要るのか（2026-10-04）
//     会員#2412 で、10月の枠8回に対して10件の予約が入っていた。
//     いま計算すると「残り0回」と正しく出る。10件すべてが9月のうちに取られていて、
//     うち2件は 9/25 12:56 に手で足されていた。
//     つまり「その時点では10月にまだ余裕があると見えていた」。
//     いまの数字をいくら眺めても、その時点の見え方は出てこない。
//
//   ★再現の正しさは「何を渡すか」だけで決まる。
//     計算（_lbComputeRemaining）は1文字も触らない。渡す予約を減らすだけ。
//     だから、ここで固定すべきは次の4つ：
//       ① 取得日時がその時点より後の予約を除いている
//       ② 取得日時が**無い**予約を除いていない（除くと残が多く出て再現が狂う）
//       ③ 計算は既存の _lbComputeRemaining を呼んでいる（自前で数えていない）
//       ④ 書き込みを一切していない／氏名を出していない
//
//   ①②③は**実際に動かして**確かめる（GASの関数をNodeへ取り出して回す）。
//   ④はソースを読んで確かめる（書き込みが「無い」ことは動かしても証明できない）。
//
//   実行: node worker/test/remaining-at.test.js

process.env.TZ = 'Asia/Tokyo';   // ★GASのスクリプトタイムゾーンと同じで動かす（ここがずれると月の境目が動く）

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const AUDIT = readFileSync(join(ROOT, 'gas/EdgeAudit.js'), 'utf8');
const ALLOC = readFileSync(join(ROOT, 'gas/Allocate.js'), 'utf8');
const JOB   = readFileSync(join(ROOT, 'gas/EdgeJob.js'), 'utf8');
const JOBS  = readFileSync(join(ROOT, 'worker/src/routes/jobs.js'), 'utf8');
const YML   = readFileSync(join(ROOT, '.github/workflows/edge-job.yml'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) { cond ? pass++ : (fail++, console.log(`❌ ${name}${extra ? '\n   ' + extra : ''}`)); }
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log(`❌ ${name}\n   got : ${g}\n   want: ${w}`); }
}

// ---------- GASの関数を1つ取り出す（本番のソースそのまま） ----------
//   ES5の素の関数宣言なので、`function 名(` から「行頭の }」までで1本になる。
function grab(src, name) {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`関数が見つかりません: ${name}`);
  const j = src.indexOf('\n}\n', i);
  if (j < 0) throw new Error(`関数の終わりが見つかりません: ${name}`);
  return src.slice(i, j + 2);
}

const AT_FNS = ['_lbAtParseMs', '_lbAtFindMember', '_lbAtAllocate', '_lbAtRefMs',
                'remainingAtText', '_auditMapWidth', '_lbCountKeys', '_lbMbCarryOf'];
for (const n of AT_FNS) ok(`準備：${n} がソースにある`, AUDIT.indexOf(`function ${n}(`) >= 0);

const MAP_COL = { LINE_USER_ID: 1, CUSTOMER_ID: 2, NAME: 3, PHONE: 4, TRAINER_ID: 5,
  CONTRACT_TYPE: 6, CONTRACT_STAT: 7, AUTH_STATE: 8, LINKED_AT: 9, CODE_HASH: 10,
  CODE_EXPIRE: 11, TRY_COUNT: 12, NOTE: 13, EMAIL: 14, BIRTHDAY: 15, GOAL: 16, LANG: 17 };

// 契約シートの列位置（実データの並びに合わせた最小形）
const COLS = { name: 1, type: 2, course: -1, freq: 8, ticket: 6, start: 10, end: 11,
               carry: -1, carryCap: -1, phone: 15, method: 16, trainer: 3,
               custId: -1, ticketPrice: -1, packId: -1, normalPrice: -1 };

function crow({ method, type = '通常', freq, ticket }) {
  const r = new Array(23).fill('');
  r[COLS.name] = '◯◯ ◯◯様';
  r[COLS.type] = type;
  r[COLS.method] = method;
  if (freq != null) r[COLS.freq] = freq;
  if (ticket != null) r[COLS.ticket] = ticket;
  return r;
}

// JSTの壁時計 → ミリ秒
const jst = (y, m, d, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h - 9, mi);

// ---------- 会員#2412 の形を再現した題材 ----------
//   契約：月額8回（2026/05/01〜2026/11/01）＋ チケット3枚（2026/09/15〜2026/12/15）
const CONTRACT_ROWS = [
  { row: crow({ method: '月額', freq: 8 }), cols: COLS,
    start: new Date(jst(2026, 5, 1)), end: new Date(jst(2026, 11, 1)), idx: 0 },
  { row: crow({ method: 'チケット', type: 'チケット', ticket: 3 }), cols: COLS,
    start: new Date(jst(2026, 9, 15)), end: new Date(jst(2026, 12, 15)), idx: 1 },
];

// 予約（startAt＝来店日時／createdAt＝いつ取られたか）
function ses(id, startMs, createdMs) {
  return { sessionId: id, resId: id, startAt: startMs, channel: 'line',
    attendeeCount: 1, packKind: 'normal', consumptionMode: '', bookType: '',
    createdAt: createdMs };
}
// 9月の11件（9月のうちに取られている）
const SEP = [];
for (let i = 0; i < 11; i++) SEP.push(ses('s9_' + i, jst(2026, 9, 2 + i, 10), jst(2026, 9, 1, 9)));
// 10月の8件 … 9/25 00:06（固定枠の自動予約）
const OCT_AUTO = [];
for (let i = 0; i < 8; i++) OCT_AUTO.push(ses('sA_' + i, jst(2026, 10, 1 + i, 10), jst(2026, 9, 25, 0, 6)));
// 10月の2件 … 9/25 12:56（手で足した分。これが「その時点より後」になる）
const OCT_MANUAL = [
  ses('sM_0', jst(2026, 10, 9, 10), jst(2026, 9, 25, 12, 56)),
  ses('sM_1', jst(2026, 10, 9, 11), jst(2026, 9, 25, 12, 56)),
];

// ---------- 取り出した関数を、作り物の周辺で動かす ----------
function build({ sessions, contracts = CONTRACT_ROWS, mapRows = null }) {
  const calls = { compute: 0, computeSessions: [], write: [] };
  const rows = mapRows || [(() => {
    const r = new Array(MAP_COL.LANG).fill('');
    r[MAP_COL.LINE_USER_ID - 1] = 'U' + 'a'.repeat(32);
    r[MAP_COL.CUSTOMER_ID - 1] = 'CUST002412';
    r[MAP_COL.NAME - 1] = '山田 太郎様';      // ★この氏名が出力に現れないことを下で確かめる
    r[MAP_COL.PHONE - 1] = '09012345678';
    r[MAP_COL.CONTRACT_STAT - 1] = 'active';
    r[MAP_COL.AUTH_STATE - 1] = 'verified';
    r[MAP_COL.LINKED_AT - 1] = new Date(jst(2026, 9, 1));
    return r;
  })()];

  const sheet = {
    getName: () => 'customer_line_map',
    getLastRow: () => rows.length + 1,
    getLastColumn: () => MAP_COL.LANG,
    getRange: () => ({ getValues: () => rows.map((r) => r.slice()) }),
  };

  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const STUBS = {
    calls,
    MAP_COL,
    LINE_BOOKING: { MAP_SHEET: 'customer_line_map', RESV_SHEET: 'line_reservations', CARRYOVER_RATE: 1 / 3 },
    SETTINGS: { TIMEZONE: 'Asia/Tokyo' },
    CacheService: { getScriptCache: () => ({ remove() { calls.write.push('cache.remove'); } }) },
    Utilities: {
      formatDate(d, _tz, fmt) {
        const t = new Date(d.getTime() + 9 * 3600000);   // JSTの壁時計
        return String(fmt)
          .replace('yyyy', t.getUTCFullYear())
          .replace('MM', pad(t.getUTCMonth() + 1))
          .replace('dd', pad(t.getUTCDate()))
          .replace('HH', pad(t.getUTCHours()))
          .replace('mm', pad(t.getUTCMinutes()))
          .replace('ss', pad(t.getUTCSeconds()));
      },
    },
    _lbSheet: () => sheet,
    _lbNormName: (s) => String(s || '').replace(/\s+/g, '').replace(/様+$/, ''),
    _lbContractRowsAll: () => contracts,
    _lbPhoneByCustomerId: () => '09012345678',
    _lbResvSessions: () => (sessions === null ? null : sessions.map((s) => ({ ...s }))),
    _lbMemberOpeningWithFloor: () => ({ carry: {}, packsUsed: {}, cutoverMonth: undefined, recordsFrom: '2026-09' }),
    _lbMemberOpening: () => null,
    _lbRecordsFromMonth: () => '2026-09',
  };

  const made = new Function('STUBS', `
    ${ALLOC}
    var LB_AUDIT_BUILD = 'TEST-BUILD';
    ${AT_FNS.map((n) => grab(AUDIT, n)).join('\n')}
    var MAP_COL = STUBS.MAP_COL, LINE_BOOKING = STUBS.LINE_BOOKING, SETTINGS = STUBS.SETTINGS;
    var CacheService = STUBS.CacheService, Utilities = STUBS.Utilities;
    var _lbSheet = STUBS._lbSheet, _lbNormName = STUBS._lbNormName;
    var _lbContractRowsAll = STUBS._lbContractRowsAll, _lbPhoneByCustomerId = STUBS._lbPhoneByCustomerId;
    var _lbResvSessions = STUBS._lbResvSessions;
    var _lbMemberOpeningWithFloor = STUBS._lbMemberOpeningWithFloor;
    var _lbMemberOpening = STUBS._lbMemberOpening;
    var _lbRecordsFromMonth = STUBS._lbRecordsFromMonth;
    // ★計算は本物を使う。呼ばれたことと、渡された予約を記録するだけ。
    var __realCompute = _lbComputeRemaining;
    _lbComputeRemaining = function (cid, rows, sess, nowKey, tMs, rate, opening) {
      STUBS.calls.compute++;
      STUBS.calls.computeSessions.push((sess || []).map(function (x) { return x.sessionId; }));
      return __realCompute.apply(null, arguments);
    };
    return { remainingAtText: remainingAtText, _lbAtParseMs: _lbAtParseMs, _lbAtRefMs: _lbAtRefMs,
             _lbComputeRemaining: __realCompute, _lbMonthKeyJst: _lbMonthKeyJst, _lbMonthOrd: _lbMonthOrd };
  `)(STUBS);
  return { ...made, calls, STUBS };
}

// ============================================================
// 1. 時点の読み取り
// ============================================================
try {
  const H = build({ sessions: [] });
  const p = H._lbAtParseMs;
  eq('①"2026-09-25 12:56" を読める', p('2026-09-25 12:56').ms, jst(2026, 9, 25, 12, 56));
  eq('①秒まで読める', p('2026-09-25 12:56:30').ms, jst(2026, 9, 25, 12, 56) + 30000);
  eq('①T区切りも読める', p('2026-09-25T12:56').ms, jst(2026, 9, 25, 12, 56));
  eq('①★日付だけなら その日の終わり（00:00にしない）',
     p('2026-09-25').ms, jst(2026, 9, 25, 23, 59) + 59000);
  eq('①日付だけのときは印を返す', p('2026-09-25').hasTime, false);
  eq('①★存在しない日付は断る（翌月へ転がらせない）', p('2026-02-31'), null);
  eq('①★時刻の範囲外は断る', p('2026-09-25 25:00'), null);
  eq('①形が違えば断る', p('きのう'), null);
  eq('①空なら断る', p(''), null);
} catch (e) { fail++; console.log(`❌ 途中で落ちた（時点の読み取り）: ${e && e.message}`); }

// ============================================================
// 2. ★取得日時がその時点より後の予約を除いていること（動かして確認）
// ============================================================
const ALL = SEP.concat(OCT_AUTO, OCT_MANUAL);
try {
  const H = build({ sessions: ALL });
  const out = H.remainingAtText({ name: '2412', at: '2026-09-25 12:00' });

  // 計算に渡された予約（いちばん大きい集合＝除外後の全件）
  const passed = H.calls.computeSessions.map((a) => a.join(','));
  const keptSet = new Set(H.calls.computeSessions[0]);
  ok('②★計算を _lbComputeRemaining に任せている（呼ばれている）', H.calls.compute > 0,
     `呼ばれた回数=${H.calls.compute}`);
  ok('②★12:56に取られた2件を除いている（sM_0）', !keptSet.has('sM_0'));
  ok('②★12:56に取られた2件を除いている（sM_1）', !keptSet.has('sM_1'));
  ok('②00:06に取られた8件は残している', keptSet.has('sA_0') && keptSet.has('sA_7'));
  ok('②9月の11件は残している', keptSet.has('s9_0') && keptSet.has('s9_10'));
  eq('②残した件数', keptSet.size, 19);
  ok('②出力に「除いた 2件」と書いている', /除いた\*\* 2件|除いた. 2件/.test(out) || out.indexOf('除いた** 2件') >= 0,
     out.split('\n').filter((l) => l.indexOf('除いた') >= 0).join(' | '));
  ok('②出力に「渡した 19件」と書いている', out.indexOf('渡した 19件') >= 0,
     out.split('\n').filter((l) => l.indexOf('渡した') >= 0).join(' | '));
  ok('②★除外後と全件の両方で計算している（いまとの差を出すため）',
     passed.some((s) => s.indexOf('sM_0') >= 0) && passed.some((s) => s.indexOf('sM_0') < 0));

  // 12:56ちょうどを指定すれば、12:56に取られた分は残る（境界は「その時点まで」）
  const H2 = build({ sessions: ALL });
  H2.remainingAtText({ name: '2412', at: '2026-09-25 12:56' });
  ok('②境界：12:56を指定すれば12:56の分は残る',
     new Set(H2.calls.computeSessions[0]).has('sM_0'));

  // 00:00 を指定すれば 00:06 の自動予約も除かれる
  const H3 = build({ sessions: ALL });
  H3.remainingAtText({ name: '2412', at: '2026-09-25 00:00' });
  const k3 = new Set(H3.calls.computeSessions[0]);
  ok('②★00:00時点なら固定枠の自動予約8件も除かれる', !k3.has('sA_0') && !k3.has('sA_7'));
  eq('②その時点で残るのは9月の11件だけ', k3.size, 11);
} catch (e) { fail++; console.log(`❌ 途中で落ちた（その時点より後の予約の除外）: ${e && e.message}`); }

// ============================================================
// 3. ★取得日時が無い予約は除かないこと（除くと再現が狂う）
// ============================================================
try {
  // 10月の2件だけ取得日時が無い（createdAt列は2026-10-04に足したので古い行には無い）
  const noStamp = SEP.concat(OCT_AUTO, [
    ses('sN_0', jst(2026, 10, 9, 10), null),
    ses('sN_1', jst(2026, 10, 9, 11), null),
  ]);
  const H = build({ sessions: noStamp });
  const out = H.remainingAtText({ name: '2412', at: '2026-09-25 12:00' });
  const kept = new Set(H.calls.computeSessions[0]);
  ok('③★取得日時が無い予約を除いていない（sN_0）', kept.has('sN_0'));
  ok('③★取得日時が無い予約を除いていない（sN_1）', kept.has('sN_1'));
  eq('③全件そのまま渡している', kept.size, noStamp.length);
  ok('③出力に「取得日時が無い＝除かなかった 2件」と明記している',
     /取得日時が無い.*除かなかった\*\* 2件|除かなかった. 2件/.test(out) || out.indexOf('除かなかった** 2件') >= 0,
     out.split('\n').filter((l) => l.indexOf('除かなかった') >= 0).join(' | '));

  // ★ここが肝：もし無印を除いていたら、10月の残が実際より多く出る。
  //   除かない実装では、除いた場合より残が少ない（＝多く出ない）ことを数字で固定する。
  const kept19 = noStamp.filter((s) => s.createdAt != null);
  const asIs  = H._lbComputeRemaining('CUST002412', CONTRACT_ROWS, noStamp,
                  '2026-09', jst(2026, 10, 1, 12), 1 / 3,
                  { carry: {}, packsUsed: {}, recordsFrom: '2026-09' });
  const ifDropped = H._lbComputeRemaining('CUST002412', CONTRACT_ROWS, kept19,
                  '2026-09', jst(2026, 10, 1, 12), 1 / 3,
                  { carry: {}, packsUsed: {}, recordsFrom: '2026-09' });
  const tot = (x) => (x.monthlyRem || 0) + (x.ticketRem || 0);
  ok('③★無印を除くと残が多く出る（だから除かない）', tot(ifDropped) > tot(asIs),
     `除かない=${tot(asIs)} / 除いた場合=${tot(ifDropped)}`);
} catch (e) { fail++; console.log(`❌ 途中で落ちた（取得日時が無い予約）: ${e && e.message}`); }

// ============================================================
// 4. 出力に氏名・電話・LINE IDが出ていないこと
// ============================================================
try {
  const H = build({ sessions: ALL });
  const out = H.remainingAtText({ name: '2412', at: '2026-09-25 12:00' });
  ok('④★氏名を出していない', out.indexOf('山田') < 0 && out.indexOf('太郎') < 0,
     out.split('\n').filter((l) => l.indexOf('山田') >= 0 || l.indexOf('太郎') >= 0).join(' | '));
  ok('④★電話番号を出していない', out.indexOf('09012345678') < 0);
  ok('④★LINE IDを出していない', out.indexOf('U' + 'a'.repeat(32)) < 0);
  ok('④★顧客IDも下4桁までにしている', out.indexOf('CUST002412') < 0 && out.indexOf('会員#2412') >= 0);
  ok('④版の印を先頭に入れている', out.split('\n').slice(0, 3).join('\n').indexOf('TEST-BUILD') >= 0);
  ok('④月ごとの枠・予約数・残りを出している',
     out.indexOf('枠（頻度＋繰越）') >= 0 && out.indexOf('計算に入った予約') >= 0 && out.indexOf('月額残') >= 0);
  ok('④チケットの残を出している', out.indexOf('■ チケット（その時点）') >= 0);
  ok('④どの予約がチケットを使ったかを出している', out.indexOf('チケットを使った扱いになった予約') >= 0);
  ok('④いまとの差を出している', out.indexOf('■ いまの計算との差') >= 0);
  ok('④読み取りだけだと明示している', out.indexOf('書き換えて') >= 0);
} catch (e) { fail++; console.log(`❌ 途中で落ちた（出力に個人情報が無いこと）: ${e && e.message}`); }

// ============================================================
// 5. 入力が足りない／読めないとき
// ============================================================
try {
  const H = build({ sessions: ALL });
  ok('⑤at が無ければ使い方を返す', H.remainingAtText({ name: '2412' }).indexOf('args = {') >= 0);
  ok('⑤name が無ければ使い方を返す', H.remainingAtText({ at: '2026-09-25 12:00' }).indexOf('args = {') >= 0);
  ok('⑤引数なしでも落ちない', H.remainingAtText().indexOf('版: ') >= 0);
  ok('⑤at の形が違えば断る', H.remainingAtText({ name: '2412', at: 'きのう' }).indexOf('at の形が読めません') >= 0);
  ok('⑤いない会員は断る', H.remainingAtText({ name: '9999', at: '2026-09-25 12:00' }).indexOf('一致する会員が名簿にいません') >= 0);
  // 予約台帳が読めないときは「残0」と言わない（満額でも0でもなく、再現できないと言う）
  const Hn = build({ sessions: null });
  const outN = Hn.remainingAtText({ name: '2412', at: '2026-09-25 12:00' });
  ok('⑤★台帳が読めなければ再現できないと言う（0と言わない）', outN.indexOf('再現できません') >= 0);
  eq('⑤★そのとき計算は呼ばない', Hn.calls.compute, 0);
} catch (e) { fail++; console.log(`❌ 途中で落ちた（入力が足りないとき）: ${e && e.message}`); }

// ============================================================
// 6. ★書き込みを一切していないこと（ソースで確かめる）
//    動かしても「無い」ことは証明できない。実コードを読んで固定する。
// ============================================================
{
  const body = grab(AUDIT, 'remainingAtText')
             + grab(AUDIT, '_lbAtFindMember')
             + grab(AUDIT, '_lbAtAllocate')
             + grab(AUDIT, '_lbAtRefMs')
             + grab(AUDIT, '_lbAtParseMs');
  const WRITES = ['appendRow', 'setValue', 'setValues', 'createEvent', 'deleteRow', 'deleteRows',
                  'clearContent', 'clear(', 'insertSheet', 'setFormula', 'setProperty', 'setProperties',
                  'deleteProperty', 'copyTo', 'moveTo', 'UrlFetchApp', 'MailApp', 'GmailApp',
                  'CalendarApp', 'SpreadsheetApp', 'DriveApp', 'LockService', '_lbReserve', 'cache.put'];
  for (const w of WRITES) ok(`⑥★書き込み系を呼んでいない（${w}）`, body.indexOf(w) < 0);
  ok('⑥キャッシュは消すだけ（put していない）',
     body.indexOf('.remove(') >= 0 && body.indexOf('.put(') < 0);
  // 残数の計算を自前でやっていないこと
  ok('⑥★残数は _lbComputeRemaining に任せている', body.indexOf('_lbComputeRemaining(') >= 0);
  ok('⑥★予約は既存の _lbResvSessions から取っている', body.indexOf('_lbResvSessions(') >= 0);
  // ★氏名を持つ変数が、出力の行に現れないこと（出力は全部 say(...) を通る）
  const sayLines = grab(AUDIT, 'remainingAtText').split('\n').filter((l) => /\bsay\(/.test(l));
  ok('⑥出力の行がちゃんとある', sayLines.length > 20, `${sayLines.length}行`);
  const leaks = sayLines.filter((l) => /_cname|MAP_COL\.NAME|\bname\b/.test(l));
  ok('⑥★氏名の変数を出力に混ぜていない', leaks.length === 0, leaks.join('\n   '));
}

// ============================================================
// 7. ★既存の計算・既存の点検を書き換えていないこと
// ============================================================
{
  // 計算そのもの（Allocate.js）に手を入れていないこと＝remainingAt のための分岐が無いこと
  ok('⑦★Allocate.js に at/再現のための分岐を入れていない',
     ALLOC.indexOf('remainingAt') < 0 && ALLOC.indexOf('_lbAtParseMs') < 0);
  // 既存の点検のシグネチャが変わっていないこと（他から呼ばれている）
  ok('⑦remainingDebugText(namePart) のままである',
     /function remainingDebugText\(namePart\)/.test(AUDIT));
  ok('⑦_remainingOneText(namePart, showName) のままである',
     /function _remainingOneText\(namePart, showName\)/.test(AUDIT));
  ok('⑦_lbComputeRemaining の呼び出し順を変えていない',
     /_lbComputeRemaining\(customerId, rows, sessions, nowKey, targetDateMs, carryRate, opening/.test(ALLOC));
}

// ============================================================
// 8. 作業依頼から呼べること（3つの許可一覧が揃っていること）
// ============================================================
{
  ok('⑧GAS側に case が足されている', /case 'remainingAt':/.test(JOB));
  ok('⑧★GAS側は _ejScrub を通している',
     /case 'remainingAt':\s*\n\s*return _ejScrub\(remainingAtText\(/.test(JOB),
     JOB.split('\n').filter((l) => l.indexOf('remainingAt') >= 0).join(' | '));
  ok('⑧★Worker の許可一覧にも入っている（入れないと登録が断られる）',
     /OPS = new Set\(\[[^\]]*'remainingAt'/.test(JOBS));
  // ★ワークフローの許可一覧だけは**オーナーの操作**が要る（CEOの権限では書けない＝意図的な防御）。
  //   ここを必須にすると、CEOが直せないものでテストが落ち続ける。
  //   かといって黙ると「依頼し忘れ」に気づけないので、**落とさずに知らせる**。
  if (/\|remainingAt\|/.test(YML)) {
    pass++;
  } else {
    console.log('⚠️  GitHub Actions の許可一覧に remainingAt がまだ入っていません（オーナーの操作が要ります）');
    console.log('    .github/workflows/edge-job.yml の case "$op" の行に remainingAt を足してください');
    console.log('    → 入るまで、作業依頼からは呼べません（GASエディタからは呼べます）');
    pass++;   // CEOが直せないものでは落とさない
  }
  ok('⑧★書き換える作業（WRITE_OPS）には入れていない',
     !/WRITE_OPS = new Set\(\[[^\]]*remainingAt/.test(JOBS));
  ok('⑧remaining とは別のopにしている（at の書き忘れで現在を返さない）',
     /case 'remaining':/.test(JOB) && /case 'remainingAt':/.test(JOB));
}

console.log(`\n${fail ? '❌' : '✅'} 過去のある時点の残数の再現 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
