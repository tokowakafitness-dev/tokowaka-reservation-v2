// 設計47 ⑥：サーバーが BUSY（ロック待ちの時間切れ・何も変わっていない）を返したときの画面（2026-11-20）
//   実行: node worker/test/liff-busy.test.js
//
//   ★本番の liff/index.html のスクリプトを丸ごと jsdom で走らせる（liff-cancel-reason.test.js と同じ作り）。
//     身代わりはサーバーへの通信（api・fetchBoot）と LINE の SDK だけ。会員の画面はボタンを click で押す。
//     トレーナー・オーナーの画面は、ボタンが呼ぶ関数（trainerCancel・ownerFreeCancel・renderSameDayCancels・_buildRecurSection）から入る
//   1. 会員の取消（旧経路 _cancelReservationLegacy＝CXL_ON が偽・いまの既定）→「混み合っています」・コードを出さない
//   2. 会員の取消（新しい経路 ?cxl=1）→ 同じ文・理由の入力が残る・押し直せる
//   3. 会員の予約・変更の確定・自己登録 → BUSY は画面の言語の busy_retry（GAS の日本語の文を出さない・関門③）・SLOT_TAKEN の封鎖をしない（押し直せる）
//   4. トレーナーの取消・オーナーの無料取消・当日取消を無料に直す・固定枠の追加/削除 → busy_retry
//   5. 4言語に busy_retry がある
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const require = createRequire(join(homedir(), '.cache/claude-node/package.json'));
const { JSDOM } = require('jsdom');
const HTML = readFileSync(process.env.LIFF_HTML || join(ROOT, 'liff/index.html'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) pass++; else { fail++; console.log(`❌ ${name}${detail ? '\n   ' + detail : ''}`); } }
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 14; i++) await tick(); }

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

const BUSY_JA = 'ただいま混み合っています。少し時間をおいてもう一度お試しください（まだ何も変更されていません）。';
const BUSY = { success: false, code: 'BUSY', message: BUSY_JA };
const HOME = { success: true, verified: true, name: '会員 見本', defaultTrainerId: 'T1', isPair: false, hasNormalRoute: true, home: { type: null } };
const R_FREE = { reservationId: 'R1', startISO: '2026-11-13T09:00:00.000Z', dateLabel: '11/13(金) 18:00〜19:00', trainerName: '一郎', trainerId: 'T1', freeCancel: true, transfer: false, bookType: '月額', customerName: '会員 見本' };

function boot(opts) {
  const o = opts || {};
  const dom = new JSDOM('<!doctype html><html><head><style>' + STYLE + '</style></head>' + BODY + '</html>', { runScripts: 'outside-only', url: o.url || 'https://reservation.tokowaka-gym.com/liff/', pretendToBeVisual: true });
  const w = dom.window;
  w.sent = []; w.confirms = []; w.alerts = [];
  w.Element.prototype.getClientRects = function () { for (let n = this; n; n = n.parentElement) { if (n.hidden || (n.style && n.style.display === 'none')) return []; } return [{}]; };
  w.confirm = (m) => { w.confirms.push(String(m)); return true; };
  w.alert = (m) => { w.alerts.push(String(m)); };
  const st = w.setTimeout.bind(w); w.setTimeout = (f, ms) => st(f, Math.min(ms || 0, 3));
  try { w.localStorage.setItem('tkw_lang', o.lang || 'ja'); if (o.lbCxl) w.localStorage.setItem('lb_cxl', o.lbCxl); } catch (e) {}
  const H = Object.assign({
    line_getMyReservations: { success: true, reservations: [R_FREE], history: [] },
    line_cancelReservation: BUSY, line_ownerFreeCancel: BUSY, line_undoSameDayCancel: BUSY,
    line_deleteRecurringPattern: BUSY, line_addRecurringPatternByTrainer: BUSY,
    line_getTrainers: { success: true, trainers: [{ id: 'T1', name: '一郎' }] },
    line_listRecurringPatternsByTrainer: { success: true, patterns: [{ patternId: 'P1', weekday: 1, time: '10:00', trainerId: 'T1' }] },
  }, o.handlers || {});
  w.__api = (p) => {
    w.sent.push(JSON.parse(JSON.stringify(p)));
    const h = H[p.action];
    if (h === undefined) return Promise.resolve({ success: true });
    return Promise.resolve(JSON.parse(JSON.stringify(typeof h === 'function' ? h(p) : h)));
  };
  w.__boot = () => Promise.resolve(HOME);
  w.liff = { init: () => Promise.resolve(), isLoggedIn: () => true, getIDToken: () => 'a'.repeat(40), getAppLanguage: () => o.lang || 'ja', getLanguage: () => o.lang || 'ja', closeWindow() {}, isInClient: () => true };
  w.eval(SRC + '\n;window.__g = { state: state, I18N: I18N, t: t, trainerCancel: trainerCancel, ownerFreeCancel: ownerFreeCancel, renderSameDayCancels: renderSameDayCancels, _buildRecurSection: _buildRecurSection, CXL_ON: CXL_ON };');
  return w;
}
const $ = (w, id) => w.document.getElementById(id);
const errText = (w) => ($(w, 'errMsg') || {}).textContent || '';
const sentOf = (w, action) => w.sent.filter((p) => p.action === action);

// ================= 1. 会員の取消（旧経路） =================
{
  const w = boot(); await settle();
  ok('1-0 既定では旧経路（CXL_ON が偽）', w.__g.CXL_ON === false);
  $(w, 'homeMyRes').click(); await settle();
  const btn = [...$(w, 'myResList').querySelectorAll('.mres-btns .btn-danger')][0];
  btn.click(); await settle();
  ok('1-1 送った（line_cancelReservation）', sentOf(w, 'line_cancelReservation').length === 1);
  ok('1-2 ★「混み合っています（まだ何も変更されていません）」・コード BUSY を出さない', errText(w) === BUSY_JA && !/BUSY/.test(errText(w)), errText(w));
}

// ================= 2. 会員の取消（新しい経路） =================
{
  const w = boot({ url: 'https://reservation.tokowaka-gym.com/liff/?cxl=1', lbCxl: '1' }); await settle();
  $(w, 'homeMyRes').click(); await settle();
  [...$(w, 'myResList').querySelectorAll('.mres-btns .btn-danger')][0].click(); await settle();
  const chip = [...$(w, 'cxlBody').querySelectorAll('.cxl-chip input')][0];
  if (chip) { chip.checked = true; chip.dispatchEvent(new w.Event('change', { bubbles: true })); }
  const ta = $(w, 'cxlNote'); if (ta) { ta.value = 'テストのひとこと'; ta.dispatchEvent(new w.Event('input', { bubbles: true })); }
  await settle();
  $(w, 'cxlSubmit').click(); await settle();
  const text = $(w, 'cxlBody').textContent;
  ok('2-1 送った', sentOf(w, 'line_cancelReservation').length === 1);
  ok('2-2 ★「混み合っています」が出る・コード BUSY を出さない', text.indexOf(BUSY_JA) >= 0 && !/コード：BUSY/.test(text), text.slice(0, 200));
  ok('2-3 理由の入力が残る', !ta || $(w, 'cxlNote').value === 'テストのひとこと');
  ok('2-4 押し直せる', !$(w, 'cxlSubmit').disabled);
}

// ================= 3. 予約・変更の確定 =================
{
  //   関門③（2026-11-20）：BUSY は GAS の日本語の文ではなく画面の言語の busy_retry。ほかの失敗は今までどおり res.message
  ok('3-1 確定の画面は BUSY なら busy_retry・ほかは res.message', /errEl\.textContent = \(res\.code === 'BUSY'\) \? t\('busy_retry'\) : \(res\.message \|\| t\('book_fail'\)\);/.test(HTML));
  ok('3-3 自己登録も BUSY なら busy_retry', /errEl\.textContent = \(res && res\.code === 'BUSY'\) \? t\('busy_retry'\) : \(res\.message \|\| t\('reg_fail'\)\);/.test(HTML));
  ok('3-2 ★枠の封鎖（押せなくする）は SLOT_TAKEN のときだけ＝BUSY では押し直せる', /if \(res\.code === 'SLOT_TAKEN' && !state\.proxyMode\) \{/.test(HTML) && !/code === 'BUSY'[^\n]*slotTakenKey/.test(HTML));
}

// ================= 4. トレーナー・オーナーの画面 =================
{
  const w = boot(); await settle();
  w.__g.trainerCancel(R_FREE); await settle();
  ok('4-1 トレーナーの取消 → busy_retry', errText(w) === BUSY_JA, errText(w));
  const w2 = boot(); await settle();
  w2.__g.ownerFreeCancel(R_FREE); await settle();
  ok('4-2 オーナーの無料取消 → busy_retry', errText(w2) === BUSY_JA, errText(w2));
  const w3 = boot(); await settle();
  w3.__g.renderSameDayCancels([{ reservationId: 'R1', dateLabel: '11/13', customerName: '会員 見本', trainerName: '一郎', transferUsed: false }]); await settle();
  const b3 = [...$(w3, 'tadminList').querySelectorAll('button')].find((b) => b.textContent === '無料キャンセルに直す');
  b3.click(); await settle();
  ok('4-3 当日取消を無料に直す → busy_retry を alert・ボタンは押し直せる', w3.alerts[w3.alerts.length - 1] === BUSY_JA && !b3.disabled, JSON.stringify(w3.alerts));
  const w4 = boot(); await settle();
  const box = w4.document.createElement('div'); w4.document.body.appendChild(box);
  w4.__g._buildRecurSection(box, 'trainer', 'C1', 'T1'); await settle();
  const del = [...box.querySelectorAll('button')].find((b) => b.textContent === w4.__g.t('recur_delete'));
  del.click(); await settle();
  ok('4-4 固定枠の削除 → busy_retry', errText(w4) === BUSY_JA, errText(w4));
  const w5 = boot(); await settle();
  const box5 = w5.document.createElement('div'); w5.document.body.appendChild(box5);
  w5.__g._buildRecurSection(box5, 'trainer', 'C1', 'T1'); await settle();
  const sels = box5.querySelectorAll('select');
  sels[0].value = '1'; sels[1].value = '10:00'; sels[2].value = 'T1';
  [...box5.querySelectorAll('button')].find((b) => b.textContent === w5.__g.t('recur_add')).click(); await settle();
  ok('4-5 固定枠の追加 → busy_retry', sentOf(w5, 'line_addRecurringPatternByTrainer').length === 1 && errText(w5) === BUSY_JA, errText(w5));
}

// ================= 5. 4言語 =================
{
  const w = boot(); await settle();
  const L = w.__g.I18N;
  const langs = Object.keys(L);
  ok('5-1 ★すべての言語に busy_retry がある', langs.length >= 4 && langs.every((k) => typeof L[k].busy_retry === 'string' && L[k].busy_retry.length > 5), langs.join(','));
  const we = boot({ lang: 'en' }); await settle();
  $(we, 'homeMyRes').click(); await settle();
  [...$(we, 'myResList').querySelectorAll('.mres-btns .btn-danger')][0].click(); await settle();
  ok('5-2 英語の画面では英語の文', errText(we) === we.__g.I18N.en.busy_retry, errText(we));
}

console.log(`\n${fail ? '❌' : '✅'} 設計47 BUSY の画面 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
