// キャンセルの確認の画面（設計36）とトレーナーのキャンセルの見え方を、本番の画面で入口から通す検査
//   実行: node worker/test/liff-cancel-reason.test.js
//
//   ★部品ではなく入口から：本番の liff/index.html のスクリプトを丸ごと jsdom で走らせる（liff-member.test.js と同じ作り）。
//     身代わりにするのは LINE の SDK（liff）と、サーバーへの通信（api・fetchBoot）の2つだけ。ボタンは click で押す。
//     1. 「あなたの予約」→「キャンセル」で確認の画面（window.confirm を使わない）・3種の文
//     2. 送る中身（action・reservationId・cxlReason・cxlNote・cxlExpect だけ）・字数（コードポイント）・URL の長さ
//     3. 言語切替で入力が消えない・別の予約で下書きが出ない・4言語の辞書
//     4. 戻る（data-back・横スワイプ・送信中は戻らない）
//     5. 二重押し・ALREADY・OUTCOME_CHANGED・BAD_EXPECTATION・通信の失敗
//     6. 完了の文（recordSaved・messageAccepted・古い GAS）
//     7. トレーナーのキャンセルの見え方（判定は変えない）

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

const HOME = { success: true, verified: true, name: '会員 見本', defaultTrainerId: 'T1', isPair: false, hasNormalRoute: true, home: { type: null } };
const R_FREE = { reservationId: 'R1', startISO: '2026-11-13T09:00:00.000Z', dateLabel: '11/13(金) 18:00〜19:00', trainerName: '一郎', trainerId: 'T1', freeCancel: true, transfer: false, bookType: '月額' };
const R_PEN = Object.assign({}, R_FREE, { reservationId: 'R2', dateLabel: '11/6(木) 18:00〜19:00', freeCancel: false });
const R_TRF = Object.assign({}, R_PEN, { reservationId: 'R3', transfer: true });
const TOKEN = 'a'.repeat(1300);   // idToken の見本（JWT 約1,000〜1,300文字）

function boot(opts) {
  const o = opts || {};
  const dom = new JSDOM('<!doctype html><html><head><style>' + STYLE + '</style></head>' + BODY + '</html>', { runScripts: 'outside-only', url: o.url || 'https://reservation.tokowaka-gym.com/liff/?cxl=1', pretendToBeVisual: true });
  const w = dom.window;
  w.sent = []; w.confirms = []; w.alerts = [];
  w.Element.prototype.getClientRects = function () { for (let n = this; n; n = n.parentElement) { if (n.hidden || (n.style && n.style.display === 'none')) return []; } return [{}]; };
  w.confirm = (m) => { w.confirms.push(String(m)); return o.confirmAnswer !== undefined ? o.confirmAnswer : true; };
  w.alert = (m) => { w.alerts.push(String(m)); };
  const st = w.setTimeout.bind(w); w.setTimeout = (f, ms) => st(f, Math.min(ms || 0, 3));
  try { w.localStorage.setItem('tkw_lang', o.lang || 'ja'); if (o.lbCxl) w.localStorage.setItem('lb_cxl', o.lbCxl); } catch (e) {}
  const H = Object.assign({
    line_getMyReservations: { success: true, reservations: o.resv || [R_FREE, R_PEN, R_TRF], history: [] },
    line_cancelReservation: { success: true, penalty: false, ownerFree: false, customerId: 'C0001', recordSaved: true, messageAccepted: false, noteDropped: '' },
    line_setLang: { success: true },
  }, o.handlers || {});
  w.__api = (p) => {
    w.sent.push(JSON.parse(JSON.stringify(p)));
    const h = H[p.action];
    if (h === undefined) return Promise.resolve({ success: true });
    const v = typeof h === 'function' ? h(p) : h;
    return (v && typeof v.then === 'function') ? v : Promise.resolve(JSON.parse(JSON.stringify(v)));
  };
  w.__boot = () => Promise.resolve(o.bootRes || HOME);
  w.liff = { init: () => Promise.resolve(), isLoggedIn: () => true, getIDToken: () => TOKEN, getAppLanguage: () => o.lang || 'ja', getLanguage: () => o.lang || 'ja', closeWindow() {}, isInClient: () => true };
  w.eval(SRC + '\n;window.__g = { state: state, setLang: setLang, I18N: I18N, t: t, rsvBack: rsvBack, _rawApi: _rawApi, _cxlSend: _cxlSend, renderCustomerDetail: renderCustomerDetail };');
  return w;
}
const $ = (w, id) => w.document.getElementById(id);
const cur = (w) => [...w.document.querySelectorAll('.screen')].filter((s) => !s.hidden).map((s) => s.id).join(',');
const sentOf = (w, action) => w.sent.filter((p) => p.action === action);
function deferred() { let res, rej; const p = new Promise((a, b) => { res = a; rej = b; }); return { p, res, rej }; }
async function openCxl(w, idx) {
  $(w, 'homeMyRes').click(); await settle();
  const btn = [...$(w, 'myResList').querySelectorAll('.mres-btns .btn-danger')][idx || 0];
  btn.click(); await settle();
}
const chip = (w, key) => [...$(w, 'cxlBody').querySelectorAll('.cxl-chip input')].find((x) => x.value === key);
function typeNote(w, v) { const ta = $(w, 'cxlNote'); ta.value = v; ta.dispatchEvent(new w.Event('input', { bubbles: true })); }
const msg = (w) => ($(w, 'cxlBody').querySelector('.cxl-msg') || {}).textContent;

// ================= 1. 入口と3種の文 =================
{
  const w = boot(); await settle();
  await openCxl(w, 0);
  ok('1-1 ★「あなたの予約」→「キャンセル」で確認の画面（s-cxl）が出る', cur(w) === 's-cxl', cur(w));
  ok('1-2 ★window.confirm を呼ばない', w.confirms.length === 0, JSON.stringify(w.confirms));
  ok('1-3 見出し・日時・担当が出る', $(w, 's-cxl').querySelector('.mtt').textContent === 'ご予約のキャンセル' && $(w, 'cxlBody').textContent.indexOf(R_FREE.dateLabel) >= 0 && $(w, 'cxlBody').textContent.indexOf('担当：一郎') >= 0);
  ok('1-4 ★無料の文は今の鍵（confirm_cancel_free）のまま', msg(w) === w.__g.t('confirm_cancel_free', { date: R_FREE.dateLabel }), msg(w));
  ok('1-5 選択肢4つ・ひとこと・注意書き・ボタン2つ（キャンセルする＝コーラル・戻る＝data-back）', $(w, 'cxlBody').querySelectorAll('.cxl-chip').length === 4 && !!$(w, 'cxlNote')
     && $(w, 'cxlBody').textContent.indexOf('体調の詳しい内容（痛み・診断・お薬など）') >= 0 && /btn-danger/.test($(w, 'cxlSubmit').className) && $(w, 'cxlBack2').hasAttribute('data-back'));
  ok('1-6 ★注意書きは入力欄の真下（I55 と同じ置き方）', $(w, 'cxlNote').nextElementSibling.classList.contains('cxl-health'));
  ok('1-7 ボタンは44px以上（.btn の既定と選択肢）', /\.btn \{[^}]*min-height:48px/.test(STYLE) && /\.cxl-chip \{[^}]*min-height:44px/.test(STYLE));
  const w2 = boot(); await settle(); await openCxl(w2, 1);
  ok('1-8 ★当日消化の文（confirm_cancel_penalty）', msg(w2) === w2.__g.t('confirm_cancel_penalty', { date: R_PEN.dateLabel }), msg(w2));
  const w3 = boot(); await settle(); await openCxl(w3, 2);
  ok('1-9 ★振替の文（confirm_cancel_transfer）', msg(w3) === w3.__g.t('confirm_cancel_transfer', { date: R_TRF.dateLabel }), msg(w3));
  const evil = Object.assign({}, R_FREE, { dateLabel: '<img src=x onerror="window.pwned=1">', trainerName: '<b>悪</b>' });
  const w4 = boot({ resv: [evil] }); await settle(); await openCxl(w4, 0);
  ok('1-10 ★サーバーの値（日時・担当）は文字として入る', !$(w4, 'cxlBody').querySelector('img,b') && !w4.pwned && $(w4, 'cxlBody').textContent.indexOf('<b>悪</b>') >= 0);
}

// ================= 2. 送る中身・字数・URL の長さ =================
{
  const w = boot(); await settle(); await openCxl(w, 0);
  chip(w, 'work').click(); typeNote(w, '  急な会議です  ');
  $(w, 'cxlSubmit').click(); await settle();
  const s = sentOf(w, 'line_cancelReservation');
  ok('2-1 ★送る中身は action・reservationId・cxlReason・cxlNote・cxlExpect だけ（customerId 等を足さない）', s.length === 1
     && JSON.stringify(Object.keys(s[0]).sort()) === JSON.stringify(['action', 'cxlExpect', 'cxlNote', 'cxlReason', 'reservationId']), JSON.stringify(s));
  ok('2-2 値：鍵・整えたひとこと・同意した結果 free', s[0].reservationId === 'R1' && s[0].cxlReason === 'work' && s[0].cxlNote === '急な会議です' && s[0].cxlExpect === 'free', JSON.stringify(s[0]));
  const w2 = boot(); await settle(); await openCxl(w2, 1);
  $(w2, 'cxlSubmit').click(); await settle();
  const s2 = sentOf(w2, 'line_cancelReservation')[0];
  ok('2-3 ★何も選ばず書かずに送れる（cxlReason・cxlNote は空）・当日消化は consumed', s2 && s2.cxlReason === '' && s2.cxlNote === '' && s2.cxlExpect === 'consumed', JSON.stringify(s2));
  const w3 = boot(); await settle(); await openCxl(w3, 2);
  $(w3, 'cxlSubmit').click(); await settle();
  ok('2-4 振替（当日）も consumed', sentOf(w3, 'line_cancelReservation')[0].cxlExpect === 'consumed');
  const odd = Object.assign({}, R_FREE, { freeCancel: 'false' });
  const w4 = boot({ resv: [odd] }); await settle(); await openCxl(w4, 0);
  ok('2-5 freeCancel が真偽値でなければ比べない（cxlExpect は空）・無料と読める文を出さない', msg(w4) === w4.__g.t('confirm_cancel_penalty', { date: odd.dateLabel }));
  $(w4, 'cxlSubmit').click(); await settle();
  ok('2-5b', sentOf(w4, 'line_cancelReservation')[0].cxlExpect === '');

  const w5 = boot(); await settle(); await openCxl(w5, 0);
  typeNote(w5, 'あ'.repeat(100));
  ok('2-6 ★100字ちょうどは押せる', !$(w5, 'cxlSubmit').disabled && /あと0字/.test($(w5, 'cxlCount').textContent), $(w5, 'cxlCount').textContent);
  typeNote(w5, 'あ'.repeat(101));
  ok('2-7 ★101字は押せない・「100字までです」', $(w5, 'cxlSubmit').disabled && $(w5, 'cxlCount').textContent === '100字までです');
  $(w5, 'cxlSubmit').click(); await settle();
  ok('2-7b 押しても送らない', sentOf(w5, 'line_cancelReservation').length === 0);
  typeNote(w5, '😀'.repeat(100));
  ok('2-8 ★絵文字100個は押せる（コードポイントで数える）', !$(w5, 'cxlSubmit').disabled, $(w5, 'cxlCount').textContent);
  typeNote(w5, '😀'.repeat(101));
  ok('2-8b 絵文字101個は押せない', $(w5, 'cxlSubmit').disabled);
  typeNote(w5, 'あ'.repeat(99) + '\n\n\n  ');
  ok('2-8c 前後の空白・空の行は数えない', !$(w5, 'cxlSubmit').disabled);

  //   URL の長さ（本物の _rawApi で組み立てる）。本番の GAS は 2,700／5,400／8,000 字のすべてで末尾の action まで届いた（2026-11-06 CEO 確認）
  const w6 = boot(); await settle();
  let src = '';
  const head = w6.document.head; const orig = head.appendChild.bind(head);
  head.appendChild = (el) => { if (el.tagName === 'SCRIPT') { src = el.src; return el; } return orig(el); };
  w6.__g._rawApi({ action: 'line_cancelReservation', reservationId: 'R1773000000000_abcdef', cxlReason: 'condition', cxlNote: '😀'.repeat(100), cxlExpect: 'consumed' }).catch(() => {});
  ok('2-9 ★最悪の URL（idToken 1,300字＋絵文字100個）は 5,400字（確認済みの長さ）以下', src.length > 2000 && src.length <= 5400, 'URL の長さ=' + src.length);
  console.log('   （参考）最悪の URL の長さ = ' + src.length + ' 文字');
  ok('2-10 送信は自動で送り直さない（_NO_RETRY に cancelReservation）', /'changeReservation', 'cancelReservation',/.test(HTML));
}

// ================= 3. 言語切替・下書き・辞書 =================
{
  const w = boot(); await settle(); await openCxl(w, 0);
  chip(w, 'family').click(); typeNote(w, '子どもの発熱');
  const lists0 = sentOf(w, 'line_getMyReservations').length;
  w.__g.setLang('en'); await settle();
  ok('3-1 ★言語を切り替えても選んだ鍵とひとことが消えない', chip(w, 'family').checked && $(w, 'cxlNote').value === '子どもの発熱' && cur(w) === 's-cxl');
  ok('3-2 今の言語で描き直す（選択肢・ボタン）', $(w, 'cxlBody').textContent.indexOf('Family reasons') >= 0 && $(w, 'cxlSubmit').textContent === 'Cancel booking');
  ok('3-3 言語を切り替えても通信しない', sentOf(w, 'line_cancelReservation').length === 0 && sentOf(w, 'line_getMyReservations').length === lists0);
  //   戻って別の予約を開く → 前の下書きは出ない
  $(w, 'cxlBack').click(); await settle();
  [...$(w, 'myResList').querySelectorAll('.mres-btns .btn-danger')][1].click(); await settle();
  ok('3-4 ★別の予約を開いたら前の下書きが出ない', !chip(w, 'family').checked && $(w, 'cxlNote').value === '');
  //   1つだけ選べる・選び直せる・もう一度押すと外れる
  chip(w, 'work').click(); chip(w, 'other').click();
  ok('3-5 1つだけ選べる・選び直せる', !chip(w, 'work').checked && chip(w, 'other').checked && $(w, 'cxlBody').querySelectorAll('.cxl-chip.on').length === 1);
  chip(w, 'other').click();
  ok('3-6 もう一度押すと外れる', $(w, 'cxlBody').querySelectorAll('.cxl-chip.on').length === 0 && !chip(w, 'other').checked);
  $(w, 'cxlSubmit').click(); await settle();
  ok('3-7 外したら空で送る', sentOf(w, 'line_cancelReservation')[0].cxlReason === '');

  const I = w.__g.I18N;
  const KEYS = ['cxl_title', 'cxl_reason_h', 'cxl_r_work', 'cxl_r_family', 'cxl_r_condition', 'cxl_r_other', 'cxl_note_ph', 'cxl_note_count', 'cxl_note_over', 'cxl_health_note',
    'cxl_submit', 'cxl_retry', 'cxl_outcome_changed', 'cxl_outcome_changed_other', 'cxl_done_thanks', 'cxl_done_relayed', 'cxl_done_unsent'];
  const miss = [];
  ['ja', 'en', 'zh', 'zh-Hant'].forEach((l) => KEYS.forEach((k) => { if (!Object.prototype.hasOwnProperty.call(I[l], k) || !String(I[l][k]).trim()) miss.push(l + ':' + k); }));
  ok('3-8 ★4言語の辞書に選択肢・注意書き・完了の文の鍵が全部ある', miss.length === 0, miss.join(' '));
  ok('3-9 選択肢の訳は設計の表のとおり（下書き）', I.en.cxl_r_work === 'Work / sudden plans' && I.zh.cxl_r_condition === '身体状况' && I['zh-Hant'].cxl_r_work === '工作・臨時安排');
  ok('3-10 確認の文の鍵（3種）は変えていない', ['confirm_cancel_free', 'confirm_cancel_transfer', 'confirm_cancel_penalty'].every((k) => ['ja', 'en', 'zh', 'zh-Hant'].every((l) => I[l][k])));
}

// ================= 4. 戻る =================
{
  const w = boot(); await settle(); await openCxl(w, 0);
  ok('4-1 見出しの「←」は data-back', $(w, 'cxlBack').hasAttribute('data-back') && $(w, 'cxlBack').parentNode.className === 'mhead');
  w.__g.rsvBack(); await settle();
  ok('4-2 ★入力が無ければ横スワイプ（rsvBack）で確かめずに戻る', cur(w) === 's-myres' && w.confirms.length === 0, cur(w));
  [...$(w, 'myResList').querySelectorAll('.mres-btns .btn-danger')][0].click(); await settle();
  typeNote(w, 'x');
  const wNo = w; wNo.confirm = (m) => { wNo.confirms.push(String(m)); return false; };
  w.__g.rsvBack(); await settle();
  ok('4-3 ★入力があれば「入力中の内容は消えます」を出す（いいえ→留まる）', w.confirms.length === 1 && /入力中の内容は消えます/.test(w.confirms[0]) && cur(w) === 's-cxl');
  chip(w, 'work').click();
  w.__g.setLang('zh'); await settle();
  w.__g.rsvBack(); await settle();
  ok('4-4 ★言語を切り替えて描き直した後も「入力あり」を覚えている', w.confirms.length === 2 && cur(w) === 's-cxl');
  wNo.confirm = (m) => { wNo.confirms.push(String(m)); return true; };
  w.__g.rsvBack(); await settle();
  ok('4-5 はい → 戻る・下書きを捨てる', cur(w) === 's-myres' && w.__g.state.cxlDraft === null);
  //   チップだけ選んだ場合も「入力あり」
  [...$(w, 'myResList').querySelectorAll('.mres-btns .btn-danger')][0].click(); await settle();
  chip(w, 'other').click(); const n0 = w.confirms.length;
  wNo.confirm = (m) => { wNo.confirms.push(String(m)); return false; };
  w.__g.rsvBack(); await settle();
  ok('4-6 選択肢を選んだだけでも確かめる', w.confirms.length === n0 + 1 && cur(w) === 's-cxl');
  //   送信中は戻らない
  const d = deferred();
  const w2 = boot({ handlers: { line_cancelReservation: () => d.p } }); await settle(); await openCxl(w2, 0);
  typeNote(w2, 'y'); $(w2, 'cxlSubmit').click(); await settle();
  w2.__g.rsvBack(); await settle();
  $(w2, 'cxlBack').click(); $(w2, 'cxlBack2').click(); await settle();
  ok('4-7 ★送信中は戻らない（横スワイプ・「←」・「戻る」）', cur(w2) === 's-cxl' && $(w2, 'cxlBack').disabled && $(w2, 'cxlBack2').disabled);
  d.res({ success: false, code: 'SERVER_ERROR' }); await settle();
  ok('4-8 失敗したら戻れるようになる', !$(w2, 'cxlBack').disabled && !$(w2, 'cxlBack2').disabled);
}

// ================= 5. 二重押し・失敗の扱い =================
{
  const d = deferred();
  const w = boot({ handlers: { line_cancelReservation: () => d.p } }); await settle(); await openCxl(w, 0);
  const lists1 = sentOf(w, 'line_getMyReservations').length;
  const b = $(w, 'cxlSubmit'); b.click(); b.click(); b.click();
  ok('5-1 ★同じ瞬間に3回押しても送るのは1回・押した直後に押せなくなる', sentOf(w, 'line_cancelReservation').length === 1 && b.disabled);
  d.res({ success: true, penalty: false, recordSaved: true, messageAccepted: false, noteDropped: '' }); await settle();
  ok('5-1b 成功 → 一覧を取り直す', sentOf(w, 'line_getMyReservations').length === lists1 + 1);

  //   1本目が遅れて成功・2本目（人工的に送った場合）が先に ALREADY → 失敗の案内を出さず、完了の文
  const d1 = deferred(), d2 = deferred();
  let n = 0;
  const w2 = boot({ handlers: { line_cancelReservation: () => (++n === 1 ? d1.p : d2.p) } }); await settle(); await openCxl(w2, 0);
  chip(w2, 'work').click();
  $(w2, 'cxlSubmit').click();
  w2.__g._cxlSend(w2.__g.state.cxlR, { key: 'work', note: '' });
  d2.res({ success: false, code: 'ALREADY' }); await settle();
  ok('5-2 ★2本目の ALREADY は捨てる（1本目が飛んでいる間）', w2.alerts.length === 0 && cur(w2) === 's-cxl' && $(w2, 'cxlErr').hidden);
  d1.res({ success: true, penalty: false, recordSaved: true, messageAccepted: false, noteDropped: '' }); await settle();
  ok('5-3 ★1本目の成功で完了の文が出る', w2.alerts.length === 1 && w2.alerts[0] === w2.__g.t('cxl_done_thanks'), JSON.stringify(w2.alerts));

  const w3 = boot({ handlers: { line_cancelReservation: { success: false, code: 'ALREADY' } } }); await settle(); await openCxl(w3, 0);
  const lists3 = sentOf(w3, 'line_getMyReservations').length;
  $(w3, 'cxlSubmit').click(); await settle();
  ok('5-4 ★ALREADY（1本だけ）は失敗扱いにしない＝「すでに取り消されています」で一覧を取り直す', w3.alerts[0] === w3.__g.t('already_gone') && sentOf(w3, 'line_getMyReservations').length === lists3 + 1 && !/キャンセルに失敗/.test($(w3, 'cxlBody').textContent));

  //   OUTCOME_CHANGED：何も書かれていない → 文を選び直す・入力は残す・もう一度押すと新しい同意で送る
  let calls = 0;
  const w4 = boot({ handlers: { line_cancelReservation: () => (++calls === 1 ? { success: false, code: 'OUTCOME_CHANGED', freeCancel: false } : { success: true, penalty: true, recordSaved: true, messageAccepted: true, noteDropped: '' }) } });
  await settle(); await openCxl(w4, 0);
  chip(w4, 'work').click(); typeNote(w4, '残業');
  $(w4, 'cxlSubmit').click(); await settle();
  ok('5-5 ★前日17時をまたいだ：当日消化の文に選び直す・お知らせ・入力は残る', msg(w4) === w4.__g.t('confirm_cancel_penalty', { date: R_FREE.dateLabel }) && $(w4, 'cxlBody').textContent.indexOf('前日17時を過ぎたため') >= 0
     && chip(w4, 'work').checked && $(w4, 'cxlNote').value === '残業' && !$(w4, 'cxlSubmit').disabled, msg(w4));
  $(w4, 'cxlSubmit').click(); await settle();
  const s4 = sentOf(w4, 'line_cancelReservation');
  ok('5-6 ★もう一度押すと consumed で送る', s4.length === 2 && s4[0].cxlExpect === 'free' && s4[1].cxlExpect === 'consumed' && s4[1].cxlNote === '残業');
  ok('5-6b 当日消化の成功 → 完了の文＋振替の案内を1つの確認で', w4.confirms.length === 1 && w4.confirms[0].indexOf(w4.__g.t('cxl_done_relayed')) === 0 && w4.confirms[0].indexOf(w4.__g.t('confirm_transfer_offer')) > 0, JSON.stringify(w4.confirms));
  const trf = Object.assign({}, R_TRF, { freeCancel: true });
  const w5 = boot({ resv: [trf], handlers: { line_cancelReservation: { success: false, code: 'OUTCOME_CHANGED', freeCancel: false } } }); await settle(); await openCxl(w5, 0);
  $(w5, 'cxlSubmit').click(); await settle();
  ok('5-7 ★振替の予約は振替の文（confirm_cancel_transfer）に選び直す', msg(w5) === w5.__g.t('confirm_cancel_transfer', { date: trf.dateLabel }), msg(w5));
  const w6 = boot({ handlers: { line_cancelReservation: { success: false, code: 'BAD_EXPECTATION' } } }); await settle(); await openCxl(w6, 0);
  typeNote(w6, 'z'); $(w6, 'cxlSubmit').click(); await settle();
  ok('5-8 BAD_EXPECTATION → 「もう一度お試しください」・下書きは残る・押せる', !$(w6, 'cxlErr').hidden && $(w6, 'cxlErr').textContent === w6.__g.t('cxl_retry') && $(w6, 'cxlNote').value === 'z' && !$(w6, 'cxlSubmit').disabled);
  const w7 = boot({ handlers: { line_cancelReservation: () => Promise.reject('サーバー応答がタイムアウトしました') } }); await settle(); await openCxl(w7, 0);
  typeNote(w7, 'q'); $(w7, 'cxlSubmit').click(); await settle();
  ok('5-9 ★通信の失敗 → 画面に留まり、下書きを残して押し直せる（自動で送り直さない）', cur(w7) === 's-cxl' && /通信に失敗しました/.test($(w7, 'cxlErr').textContent) && $(w7, 'cxlNote').value === 'q' && !$(w7, 'cxlSubmit').disabled && sentOf(w7, 'line_cancelReservation').length === 1);
  const w8 = boot({ handlers: { line_cancelReservation: { success: false, code: 'NO_SHEET', message: '<b>x</b>' } } }); await settle(); await openCxl(w8, 0);
  $(w8, 'cxlSubmit').click(); await settle();
  ok('5-10 その他の失敗はコードを文字で出す', $(w8, 'cxlErr').textContent === w8.__g.t('err_cancel', { code: 'NO_SHEET' }) && !$(w8, 'cxlErr').querySelector('b'));
}

// ================= 6. 完了の文 =================
{
  async function done(input, res, idx) {
    const w = boot({ handlers: { line_cancelReservation: res } }); await settle(); await openCxl(w, idx || 0);
    if (input.key) chip(w, input.key).click();
    if (input.note) typeNote(w, input.note);
    w.lists0 = sentOf(w, 'line_getMyReservations').length;
    $(w, 'cxlSubmit').click(); await settle();
    return w;
  }
  const a = await done({}, { success: true, penalty: false, recordSaved: true, messageAccepted: false, noteDropped: '' });
  ok('6-1 ★何も入れていなければ文を足さない', a.alerts.length === 0 && sentOf(a, 'line_getMyReservations').length === a.lists0 + 1);
  const b = await done({ key: 'work' }, { success: true, penalty: false, recordSaved: true, messageAccepted: false, noteDropped: '' });
  ok('6-2 理由だけ・recordSaved → ありがとうございます', b.alerts[0] === b.__g.t('cxl_done_thanks'));
  const c = await done({ note: 'よろしく' }, { success: true, penalty: false, recordSaved: true, messageAccepted: true, noteDropped: '' });
  ok('6-3 ★ひとことあり・messageAccepted のときだけ「お伝えします」', c.alerts[0] === c.__g.t('cxl_done_relayed'));
  const d = await done({ note: 'よろしく' }, { success: true, penalty: false, recordSaved: false, messageAccepted: false, noteDropped: 'save_failed' });
  ok('6-4 ★保存できなかった → 「理由・ひとことはお送りできませんでした」', d.alerts[0] === d.__g.t('cxl_done_unsent'));
  const e = await done({ key: 'work', note: 'x' }, { success: true, penalty: false, customerId: 'C0001' });
  ok('6-5 ★古い GAS（recordSaved の鍵が無い）→ 「お送りできませんでした」（黙って消さない）', e.alerts[0] === e.__g.t('cxl_done_unsent'), JSON.stringify(e.alerts));
  const e2 = await done({ key: 'work' }, { success: true, penalty: false, customerId: 'C0001' });
  ok('6-5b ★古い GAS で理由だけ → 「お送りできませんでした」（「ありがとうございます」と言わない）', e2.alerts[0] === e2.__g.t('cxl_done_unsent'), JSON.stringify(e2.alerts));
  const f = await done({ key: 'work' }, { success: true, penalty: false, recordSaved: true, messageAccepted: false, noteDropped: 'not_customer' });
  ok('6-6 理由を捨てた印（noteDropped）→ お送りできませんでした', f.alerts[0] === f.__g.t('cxl_done_unsent'));
  const g = await done({}, { success: true, penalty: false, customerId: 'C0001' });
  ok('6-7 古い GAS でも何も入れていなければ今どおり（文なし）', g.alerts.length === 0);
  const h = await done({ note: 'n' }, { success: true, penalty: true, recordSaved: true, messageAccepted: true, noteDropped: '' }, 2);
  ok('6-8 振替の予約の当日消化は振替の案内を出さない（再振替を防ぐ・今どおり）', h.confirms.length === 0 && h.alerts[0] === h.__g.t('cxl_done_relayed'));
  const i = await done({}, { success: true, penalty: true, recordSaved: true, messageAccepted: false, noteDropped: '' }, 1);
  ok('6-9 何も入れていない当日消化は今どおりの振替の案内だけ', i.confirms.length === 1 && i.confirms[0] === i.__g.t('confirm_transfer_offer'));
  const en = boot({ lang: 'en', handlers: { line_cancelReservation: { success: true, penalty: false, recordSaved: true, messageAccepted: true, noteDropped: '' } } }); await settle(); await openCxl(en, 0);
  typeNote(en, 'hi'); $(en, 'cxlSubmit').click(); await settle();
  ok('6-10 完了の文は今の言語', en.alerts[0] === en.__g.I18N.en.cxl_done_relayed);
}

// ================= 7. トレーナーのキャンセルの見え方 =================
{
  async function trainer(r, owner) {
    const w = boot(); await settle();
    const s = w.__g.state;
    s._isOwner = !!owner; s.myTrainerId = 'T1'; s.trainerId = 'T1';
    s._trainerResv = [Object.assign({ customerId: 'C1', customerName: '見本 花子', reservationId: 'RT', dateLabel: '11/6(木) 18:00', trainerId: 'T1' }, r)];
    w.document.body.classList.add('staff');
    w.__g.renderCustomerDetail('C1', '見本 花子'); await settle();
    return w;
  }
  const btn = (w, text) => [...$(w, 'tadminList').querySelectorAll('button')].find((b) => b.textContent === text);
  const a = await trainer({ freeCancel: false });
  ok('7-1 ★オーナーでないトレーナーにも、前日17時以降は「キャンセル（当日消化）」', !!btn(a, 'キャンセル（当日消化）') && !btn(a, 'キャンセル'));
  btn(a, 'キャンセル（当日消化）').click(); await settle();
  ok('7-2 ★確認の文：消化される・無料はオーナーに依頼', a.confirms[0] === '見本 花子様の予約（11/6(木) 18:00）を取り消します。\nお客様の1回分が消化されます。\nトレーナー都合で無料にする場合は、オーナーに依頼してください。\nよろしいですか？', a.confirms[0]);
  ok('7-3 ★送る中身は今と同じ（判定を変えない・理由の欄は第2段）', JSON.stringify(sentOf(a, 'line_cancelReservation')) === JSON.stringify([{ action: 'line_cancelReservation', reservationId: 'RT' }]));
  ok('7-3b オーナーの無料のボタンは出ない', !btn(a, '無料で取り消す（オーナー）'));
  const b = await trainer({ freeCancel: true });
  ok('7-4 前日17時より前は「キャンセル」・今どおりの文', !!btn(b, 'キャンセル'));
  btn(b, 'キャンセル').click(); await settle();
  ok('7-4b', b.confirms[0] === '見本 花子様の予約（11/6(木) 18:00）を取り消します。よろしいですか？', b.confirms[0]);
  const c = await trainer({});
  ok('7-5 ★freeCancel が無い → 「当日消化」と言い切らない', !!btn(c, 'キャンセル'));
  btn(c, 'キャンセル').click(); await settle();
  ok('7-5b ★「消化されるかもしれない」側の文（無料と読める文を出さない）', /前日17時を過ぎている場合、お客様の1回分が消化されます。/.test(c.confirms[0]), c.confirms[0]);
  const d = await trainer({ freeCancel: 'false' });
  btn(d, 'キャンセル').click(); await settle();
  ok('7-6 ★文字列の \'false\' も判定できない扱い（false と同じにしない）', /前日17時を過ぎている場合/.test(d.confirms[0]), d.confirms[0]);
  const o = await trainer({ freeCancel: false }, true);
  ok('7-7 ★オーナーの画面は今と同じボタン（キャンセル（当日消化）と無料で取り消す（オーナー））', !!btn(o, 'キャンセル（当日消化）') && !!btn(o, '無料で取り消す（オーナー）') && !!btn(o, '時間を変更（無料・オーナー）'));
  btn(o, 'キャンセル（当日消化）').click(); await settle();
  ok('7-8 オーナーの確認の文は今どおり', o.confirms[0] === '見本 花子様の予約（11/6(木) 18:00）を取り消します。よろしいですか？', o.confirms[0]);
  const o2 = await trainer({ freeCancel: false }, true);
  btn(o2, '無料で取り消す（オーナー）').click(); await settle();
  ok('7-9 ★無料はオーナーの専用の入口だけ', sentOf(o2, 'line_ownerFreeCancel').length === 1 && sentOf(o2, 'line_cancelReservation').length === 0 && !sentOf(o, 'line_cancelReservation').some((p) => 'ownerFree' in p));
}

// ================= 8. 配線（版の印・画面の一覧）=================
{
  ok('8-1 版の印を上げた', /var LIFF_BUILD = '2026-11-06g /.test(HTML));
  ok('8-2 画面の一覧に s-cxl（戻るの決まりに乗る）・会員の画面としてトレーナーの見た目を外す', /var SCREENS = \[[^\]]*'s-cxl'/.test(HTML) && /\['s-home', 's-register', 's-myres', 's-cxl', 's-mk'\]/.test(HTML));
  ok('8-3 ★予約ページのグローバルな viewport は変えていない', HTML.includes('<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">'));
  ok('8-4 ひとことの欄は16px（iPhone で拡大されない）', /#s-cxl textarea \{[^}]*font-size:16px/.test(STYLE));
  ok('8-5 ★サーバーの値を innerHTML に入れていない（キャンセルの画面の描画）', !/innerHTML = [^'"]/.test((HTML.match(/  function renderCxl\(\)\{[\s\S]*?\n  \}/) || [''])[0]));
}

// ================= 9. 切替（関門③：全員に出す前はオーナーの端末だけ）=================
{
  const PLAIN = 'https://reservation.tokowaka-gym.com/liff/';
  const go = async (o) => { const w = boot(o); await settle(); await openCxl(w, 0); await settle(); return w; };
  const w1 = await go({ url: PLAIN });
  const c1 = sentOf(w1, 'line_cancelReservation');
  ok('9-1 ★印なし＝設計36 以前の流れ（確認の窓1つ・理由の画面を出さない・cxl を送らない）', w1.confirms.length === 1 && $(w1, 's-cxl').hidden === true
     && c1.length === 1 && !('cxlReason' in c1[0]) && !('cxlNote' in c1[0]) && !('cxlExpect' in c1[0]), JSON.stringify({ confirms: w1.confirms.length, sent: c1 }));
  ok('9-1b 既定は偽（CXL_DEFAULT_ON = false）', /var CXL_DEFAULT_ON = false;/.test(HTML));
  const w2 = await go({ url: PLAIN + '?cxl=1' });
  ok('9-2 ?cxl=1 → 理由の画面・端末に印が残る', cur(w2) === 's-cxl' && w2.confirms.length === 0 && w2.localStorage.getItem('lb_cxl') === '1', cur(w2));
  const w3 = await go({ url: PLAIN, lbCxl: '1' });
  ok('9-3 端末に印があれば URL に無くても理由の画面', cur(w3) === 's-cxl', cur(w3));
  const w4 = await go({ url: PLAIN + '?cxl=0', lbCxl: '1' });
  ok('9-4 ?cxl=0 → 印を消して以前の流れ', $(w4, 's-cxl').hidden === true && w4.localStorage.getItem('lb_cxl') === null && w4.confirms.length === 1);
}

console.log((fail === 0 ? '✅ ' : '⚠️ ') + `キャンセルの確認の画面（設計36） 検証: ${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
