// トレーナーの「＋ 予約を代行」で、その顧客の担当を一覧の先頭に「担当」の印で出す（設計60・2026-11-25 オーナー指示 案A）
//   実行: node worker/test/liff-proxy-trainer.test.js
//
//   ★入口から：本番の liff/index.html を丸ごと jsdom で走らせ、トレーナーとして起動 → 顧客を押す → 「＋ 予約を代行」を押す。
//     身代わりは LINE の SDK とサーバーへの通信だけ。名前・ID はすべて架空。
//     1. 担当が先頭・印つき・ほかのトレーナーも並ぶ（選べる・直行しない）
//     2. 別の顧客の代行で担当が入れ替わる（前の顧客の担当を引き継がない）
//     3. 担当なし・担当が分からない（GAS の応答で鍵が無い）・担当が一覧に居ない → 印なし
//     4. 代行しても会員本人の担当（state.defaultTrainerId）を汚さない。会員本人の直行は壊れない

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const require = createRequire(join(homedir(), '.cache/claude-node/package.json'));
const { JSDOM } = require('jsdom');
const HTML = readFileSync(join(ROOT, 'liff/index.html'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) pass++; else { fail++; console.log(`❌ ${name}${detail ? '\n   ' + detail : ''}`); } }
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 12; i++) await tick(); }

const STYLE = HTML.slice(HTML.indexOf('<style>') + 7, HTML.indexOf('</style>'));
const BODY = HTML.slice(HTML.indexOf('<body'), HTML.indexOf('<script'));
const S0 = HTML.indexOf('<script>\n') + 9;
const S1 = HTML.indexOf('</script>', S0);
let SRC = HTML.slice(S0, S1);
const API_HEAD = '  function api(params){\n';
const BOOT_HEAD = '  function fetchBoot(){\n';
ok('0-1 本番のスクリプトから api と fetchBoot の入口が1つずつ見つかる', SRC.split(API_HEAD).length === 2 && SRC.split(BOOT_HEAD).length === 2);
SRC = SRC.replace(API_HEAD, '  function api(params){ return window.__api(params); }\n  function __realApi(params){\n')
         .replace(BOOT_HEAD, '  function fetchBoot(){ return window.__boot(); }\n  function __realBoot(){\n');
//   この画面で開く（location.href）は jsdom で移動できない＝本番の1行を、行き先を記録する身代わりに置き換える（1か所だけ・値ごと）
const NAV_LINE = "try { location.href = LINE_OA_URL; } catch (_) {}";
ok('0-2 本番のスクリプトに「この画面で公式LINEを開く」行が1つだけある', SRC.split(NAV_LINE).length === 2);
SRC = SRC.replace(NAV_LINE, 'window.__nav = LINE_OA_URL;');
//   ★置き換えた後の相談ボタンの2関数に、ほかの移動（location・open の別表記）が残っていない（関門② 3回目）
{
  const body = (name) => { const i = SRC.indexOf('  function ' + name + '('); const j = SRC.indexOf('\n  }\n', i); return i >= 0 && j > i ? SRC.slice(i, j) : null; };
  const b1 = body('_lineConsult'), b2 = body('_openLineOA');
  ok('0-3 ★相談ボタンの処理に、置き換えた1行のほかに location への移動が無い', b1 !== null && b2 !== null && !/\blocation\s*[.\[]|\.assign\s*\(|\.replace\s*\(/.test(b1 + b2), (b1 || '') + (b2 || ''));
  ok('0-4 別タブで開くのは window.open(LINE_OA_URL, \'_blank\') の1か所だけ', b2 !== null && (b2.match(/open\s*\(/g) || []).length === 1 && /window\.open\(LINE_OA_URL, '_blank'\)/.test(b2) && !/open\s*\(/.test(b1));
}

const pad = (n) => ('0' + n).slice(-2);
const TODAY = new Date(); TODAY.setHours(0, 0, 0, 0);
const DATE = TODAY.getFullYear() + '/' + pad(TODAY.getMonth() + 1) + '/' + pad(TODAY.getDate());
const SLOT = { date: DATE, startTime: '10:00', endTime: '11:00', startISO: TODAY.getFullYear() + '-' + pad(TODAY.getMonth() + 1) + '-' + pad(TODAY.getDate()) + 'T01:00:00.000Z' };
const HOME = (def) => ({ success: true, verified: true, name: 'テスト 太郎', defaultTrainerId: def, isPair: false, hasNormalRoute: true, home: { type: null } });
const TRAINERS = { success: true, trainers: [{ id: 'T1', name: '架空一郎' }, { id: 'T2', name: '架空次郎' }] };
const RESV = { reservationId: 'R1', startISO: SLOT.startISO, dateLabel: '11/30', trainerId: 'T2', trainerName: '架空次郎', freeCancel: true, bookType: '月額' };

function boot(opts) {
  const o = opts || {};
  const dom = new JSDOM('<!doctype html><html><head><style>' + STYLE + '</style></head>' + BODY + '</html>', { runScripts: 'outside-only', url: 'https://reservation.tokowaka-gym.com/liff/', pretendToBeVisual: true });
  const w = dom.window;
  w.sent = [];
  w.Element.prototype.getClientRects = function () { for (let n = this; n; n = n.parentElement) { if (n.hidden || (n.style && n.style.display === 'none')) return []; } return [{}]; };
  w.confirm = () => true; w.alert = () => {};
  const st = w.setTimeout.bind(w); w.setTimeout = (f, ms) => st(f, Math.min(ms || 0, 3));
  try { w.localStorage.setItem('tkw_lang', o.lang || 'ja'); } catch (e) {}
  const home = o.home || HOME('T1');
  const H = Object.assign({
    line_getTrainers: TRAINERS,
    line_getTrainerSlots: { success: true, slots: [SLOT] },
    line_getMemberStatus: home,
    line_getMyReservations: { success: true, reservations: [RESV], history: [] },
    line_setLang: { success: true },
  }, o.handlers || {});
  w.__api = (p) => {
    w.sent.push(JSON.parse(JSON.stringify(p)));
    const h = H[p.action];
    if (h === undefined) return Promise.resolve({ success: true });
    const v = typeof h === 'function' ? h(p) : h;
    return (v && typeof v.then === 'function') ? v : Promise.resolve(JSON.parse(JSON.stringify(v)));
  };
  w.__boot = () => Promise.resolve(o.bootRes || home);
  w.liff = { init: () => Promise.resolve(), isLoggedIn: () => true, getIDToken: () => 'tok', getAppLanguage: () => o.lang || 'ja', getLanguage: () => o.lang || 'ja', closeWindow() {}, isInClient: () => true };
  w.eval(SRC + '\n;window.__g = { state: state };');
  return w;
}
const $ = (w, id) => w.document.getElementById(id);
const cur = (w) => [...w.document.querySelectorAll('.screen')].filter((s) => !s.hidden).map((s) => s.id).join(',');
const vis = (w, id) => { for (let n = w.document.getElementById(id); n; n = n.parentElement) { if (n.hidden) return false; } return true; };
const sentOf = (w, action) => w.sent.filter((p) => p.action === action);
const lastSlotsTrainer = (w) => { const s = sentOf(w, 'line_getTrainerSlots'); return s.length ? s[s.length - 1].trainerId : null; };
function deferred() { let res; const p = new Promise((a) => { res = a; }); return { p, res }; }
const NOTE_JA = '担当以外のトレーナーでのご予約や、ご希望の日時が見つからない場合は、公式LINEのトークでご相談ください。';


const TR3 = { success: true, trainers: [{ id: 'T1', name: '架空一郎' }, { id: 'T2', name: '架空次郎' }, { id: 'T3', name: '架空三郎' }] };
const CUSTS = [
  { customerId: 'C1', name: '架空客A', defaultTrainerId: 'T3' },
  { customerId: 'C2', name: '架空客B', defaultTrainerId: 'T2' },
  { customerId: 'C3', name: '架空客C', defaultTrainerId: '' },
  { customerId: 'C4', name: '架空客D' },
  { customerId: 'C5', name: '架空客E', defaultTrainerId: 'T9' },
];
const TBOOT = { success: true, role: 'trainer', trainerId: 'T1', trainerName: '架空一郎', isOwner: false };
function bootT(custs) {
  return boot({ bootRes: TBOOT, handlers: { line_getTrainers: TR3, line_getTrainerReservations: { success: true, reservations: [], customers: custs || CUSTS } } });
}
async function proxyFor(w, name) {
  const row = [...w.document.querySelectorAll('#s-tadmin .srow')].find((b) => (b.querySelector('.nm') || {}).textContent === name + ' 様');
  if (!row) return false;
  row.click(); await settle();
  const add = [...w.document.querySelectorAll('#s-tadmin button')].find((b) => b.textContent === '＋ 予約を代行');
  if (!add) return false;
  add.click(); await settle();
  return true;
}
const names = (w) => [...w.document.querySelectorAll('#trainerList .trainer .tnm')].map((e) => e.textContent);
const badges = (w) => [...w.document.querySelectorAll('#trainerList .trainer')].filter((d) => d.querySelector('.tbadge')).map((d) => d.querySelector('.tnm').textContent);

// ================= 1. 担当が先頭・印つき・ほかも並ぶ =================
{
  const w = bootT(); await settle();
  ok('1-0 トレーナーとして起動し顧客の一覧', cur(w) === 's-tadmin', cur(w));
  ok('1-1 顧客を押して「＋ 予約を代行」を押せる', await proxyFor(w, '架空客A'));
  ok('1-2 ★直行せずトレーナー選び（選べるまま）', cur(w) === 's-trainer', cur(w));
  ok('1-3 ★その顧客の担当（架空三郎）が先頭・ほかは元の順で下に並ぶ', JSON.stringify(names(w)) === JSON.stringify(['架空三郎', '架空一郎', '架空次郎']), names(w).join('|'));
  ok('1-4 ★「担当」の印は担当にだけ', JSON.stringify(badges(w)) === JSON.stringify(['架空三郎']), badges(w).join('|'));
  w.document.querySelectorAll('#trainerList .trainer')[2].click(); await settle();
  ok('1-5 担当以外も選んで代行できる（今のまま）', cur(w) === 's-week' && lastSlotsTrainer(w) === 'T2', cur(w) + ' ' + lastSlotsTrainer(w));
}

// ================= 2. 別の顧客で入れ替わる =================
{
  const w = bootT(); await settle();
  await proxyFor(w, '架空客A');
  $(w, 'toHome').click(); await settle();   // 代行中の戻る → 顧客の一覧
  ok('2-0 代行の戻る → 顧客の一覧', cur(w) === 's-tadmin', cur(w));
  ok('2-1 別の顧客（担当 架空次郎）の代行', await proxyFor(w, '架空客B'));
  ok('2-2 ★担当が入れ替わる（先頭・印とも 架空次郎）', names(w)[0] === '架空次郎' && JSON.stringify(badges(w)) === JSON.stringify(['架空次郎']), names(w).join('|') + ' / ' + badges(w).join('|'));
  $(w, 'toHome').click(); await settle();
  await proxyFor(w, '架空客C');
  ok('2-3 ★担当なしの顧客：前の顧客の担当を引き継がず印なし・元の順', badges(w).length === 0 && JSON.stringify(names(w)) === JSON.stringify(['架空一郎', '架空次郎', '架空三郎']), names(w).join('|') + ' / ' + badges(w).join('|'));
}

// ================= 3. 分からない・一覧に居ない =================
{
  const w = bootT(); await settle();
  await proxyFor(w, '架空客A');
  $(w, 'toHome').click(); await settle();
  await proxyFor(w, '架空客D');
  ok('3-1 ★担当の鍵が無い（GAS の応答・写しが古い）→ 印なし（前の顧客の担当も出さない）', badges(w).length === 0 && names(w)[0] === '架空一郎', badges(w).join('|'));
  $(w, 'toHome').click(); await settle();
  await proxyFor(w, '架空客E');
  ok('3-2 担当が一覧に居ない → 印なし・全員並ぶ', badges(w).length === 0 && names(w).length === 3);
}
{
  //   GAS の応答（customers に担当が無い形）でも印を出さない
  const w = bootT([{ customerId: 'C1', name: '架空客A' }]); await settle();
  await proxyFor(w, '架空客A');
  ok('3-3 ★GAS の形（担当なし）→ 印なし', cur(w) === 's-trainer' && badges(w).length === 0, cur(w));
}
{
  //   数値の id と文字の担当でも先頭・印
  const w = boot({ bootRes: TBOOT, handlers: { line_getTrainers: { success: true, trainers: [{ id: 1, name: '架空一郎' }, { id: 7, name: '架空七子' }] }, line_getTrainerReservations: { success: true, reservations: [], customers: [{ customerId: 'C1', name: '架空客A', defaultTrainerId: '7' }] } } }); await settle();
  await proxyFor(w, '架空客A');
  ok('3-4 型の違いでも担当が先頭・印つき', names(w)[0] === '架空七子' && JSON.stringify(badges(w)) === JSON.stringify(['架空七子']), names(w).join('|'));
}

// ================= 4. 会員本人の担当を汚さない =================
{
  const w = bootT(); await settle();
  w.__g.state.defaultTrainerId = 'T-MEMBER';
  await proxyFor(w, '架空客A');
  ok('4-1 ★代行しても state.defaultTrainerId（会員本人の担当）は変わらない', w.__g.state.defaultTrainerId === 'T-MEMBER', w.__g.state.defaultTrainerId);
}
{
  const w = boot(); await settle();
  $(w, 'homeReserve').click(); await settle();
  ok('4-2 ★会員本人は今までどおり担当の週の表へ直行（設計59）', cur(w) === 's-week' && lastSlotsTrainer(w) === 'T1', cur(w) + ' ' + lastSlotsTrainer(w));
}
{
  //   担当なしの会員の一覧は今のまま（印なし・元の順）
  const w = boot({ home: HOME(''), handlers: { line_getTrainers: TR3 } }); await settle();
  $(w, 'homeReserve').click(); await settle();
  ok('4-3 担当なしの会員の一覧は今のまま（印なし）', cur(w) === 's-trainer' && badges(w).length === 0 && names(w)[0] === '架空一郎');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
