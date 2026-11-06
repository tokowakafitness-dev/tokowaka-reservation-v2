// 会員の予約画面（設計34 C1・確定した見た目への作り替え）を入口から通す検査
//   実行: node worker/test/liff-member.test.js
//
//   ★部品ではなく入口から：本番の liff/index.html のスクリプトを丸ごと jsdom で走らせる。
//     身代わりにするのは LINE の SDK（liff）と、サーバーへの通信（api・fetchBoot）の2つだけ。
//     ボタンは click で押す（on() の配線ごと通す）。
//     1. 起動の分岐（登録済み→ホーム・未登録→登録・失敗→エラー）とホームの並び
//     2. 予約の流れ（ホーム→トレーナー→週→確認→確定）で送る中身が作り替え前と同じ
//     3. 言語を切り替えても送る中身が変わらない（設計34 改訂1-2：選択が初期化されていた不具合）
//     4. 取得中・送信中・照合中に言語を切り替えても、押せないまま・二重に送らない（改訂2-1・2-3）
//     5. 取得の失敗の文は今の言語で出す（改訂2-2）
//     6. サーバーの値は文字として入れる（改訂1-4）
//     7. 4言語の辞書が新しい文言を自分で持つ（改訂1-7）
//     8. 静的なボタンを置き換えない・data-back の順を変えない（改訂1-1）・トレーナーの見た目が勝つ（改訂1-3）

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
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), 'got : ' + JSON.stringify(got) + '\n   want: ' + JSON.stringify(want)); }
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

const pad = (n) => ('0' + n).slice(-2);
const TODAY = new Date(); TODAY.setHours(0, 0, 0, 0);
const DATE = TODAY.getFullYear() + '/' + pad(TODAY.getMonth() + 1) + '/' + pad(TODAY.getDate());
const SLOT = { date: DATE, startTime: '10:00', endTime: '11:00', startISO: TODAY.getFullYear() + '-' + pad(TODAY.getMonth() + 1) + '-' + pad(TODAY.getDate()) + 'T01:00:00.000Z' };
const HOME = { success: true, verified: true, name: '山田 花子', defaultTrainerId: 'T1', isPair: false, hasNormalRoute: true, home: { type: null } };

// handlers: action → 応答（関数なら params を受けて Promise か値を返す）
function boot(opts) {
  const o = opts || {};
  const dom = new JSDOM('<!doctype html><html><head><style>' + STYLE + '</style></head>' + BODY + '</html>', { runScripts: 'outside-only', url: 'https://reservation.tokowaka-gym.com/liff/', pretendToBeVisual: true });
  const w = dom.window;
  w.sent = [];
  //   jsdom は配置を計算しない＝「見えているか」は hidden・display:none の祖先で判定する身代わり（liff-back-nav と同じ）
  w.Element.prototype.getClientRects = function () { for (let n = this; n; n = n.parentElement) { if (n.hidden || (n.style && n.style.display === 'none')) return []; } return [{}]; };
  w.confirm = () => true; w.alert = () => {};
  const st = w.setTimeout.bind(w); w.setTimeout = (f, ms) => st(f, Math.min(ms || 0, 3));   // 照合の待ち時間を詰める
  try { w.localStorage.setItem('tkw_lang', o.lang || 'ja'); } catch (e) {}
  const H = Object.assign({
    line_getTrainers: { success: true, trainers: [{ id: 'T1', name: '一郎' }, { id: 'T2', name: '<img src=x onerror=alert(1)>次郎' }] },
    line_getTrainerSlots: { success: true, slots: [SLOT] },
    line_getBookingOptions: { success: true, pairRemaining: 0, pairPackMax: 0, hasNormalRoute: true },
    line_makeReservationLine: { success: true },
    line_makeTransferReservation: { success: true },
    line_getMyReservations: { success: true, reservations: [], history: [] },
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
  w.liff = { init: () => Promise.resolve(), isLoggedIn: () => true, getIDToken: () => 'tok', getAppLanguage: () => o.lang || 'ja', getLanguage: () => o.lang || 'ja', closeWindow() {}, isInClient: () => true };
  w.eval(SRC + '\n;window.__g = { state: state, setLang: setLang, I18N: I18N, t: t, openConfirm: openConfirm };');
  return w;
}
const $ = (w, id) => w.document.getElementById(id);
const cur = (w) => [...w.document.querySelectorAll('.screen')].filter((s) => !s.hidden).map((s) => s.id).join(',');
const sentOf = (w, action) => w.sent.filter((p) => p.action === action);
function deferred() { let res, rej; const p = new Promise((a, b) => { res = a; rej = b; }); return { p, res, rej }; }

// 予約の流れを確認画面まで進める
async function toConfirm(w) {
  $(w, 'homeReserve').click(); await settle();
  const tr = w.document.querySelector('#trainerList .trainer'); tr.click(); await settle();
  const cell = w.document.querySelector('#gridWrap .cell-open'); cell.click(); await settle();
}

// ================= 1. 起動の分岐とホーム =================
{
  const w = boot(); await settle();
  ok('1-1 登録済みの会員はホームに入る', cur(w) === 's-home', cur(w));
  ok('1-2 会員の時はトレーナーの見た目（body.staff）が付かない・読み込み中の印が外れる', !w.document.body.classList.contains('staff') && !w.document.body.classList.contains('booting'));
  const kids = [...$(w, 's-home').children].map((e) => e.id || e.className);
  eq('1-3 ホームの並び：名前の帯 → ＋予約する → 予約の確認・変更 → ご利用状況 → 残り回数のカード', kids, ['mtop', 'homeReserve', 'homeMyRes', 'sect-h', 'homeInfo']);
  ok('1-4 お名前は文字として入る', $(w, 'homeName').textContent === '山田 花子 様');
  ok('1-5 「予約の確認・変更」の文言が出る（ボタンの中の文字）', $(w, 'homeMyRes').textContent.indexOf('予約の確認・変更') === 0);
}
{
  const w = boot({ bootRes: { success: true, verified: false } }); await settle();
  ok('1-6 未登録はご登録の画面に入る', cur(w) === 's-register', cur(w));
}
{
  const w = boot({ bootRes: { success: false, code: 'X', message: 'サーバーの文' } }); await settle();
  ok('1-7 失敗はエラーの画面に入る', cur(w) === 's-error' && $(w, 'errMsg').textContent.indexOf('サーバーの文') >= 0, cur(w));
}
{
  const w = boot({ bootRes: Object.assign({}, HOME, { name: '<b>x</b>', transferCredits: { available: 1, nextExpireLabel: '<img src=x>11/30' }, home: { type: 'ticket', packs: [{ remaining: 3, total: 4, expire: '<img src=y>12/31' }] } }) }); await settle();
  ok('1-8 ★名前・振替の期限・チケットの期限は HTML にならない', !$(w, 's-home').querySelector('b#x, img') && $(w, 'homeName').textContent.indexOf('<b>x</b>') === 0, $(w, 'homeInfo').innerHTML.slice(0, 200));
  ok('1-9 振替の行が出る（期限は文字のまま）', $(w, 'homeInfo').textContent.indexOf('<img src=x>11/30') >= 0, $(w, 'homeInfo').textContent.slice(0, 200));
}

// ================= 2. 予約の流れと送る中身 =================
{
  const w = boot(); await settle();
  const btnRefs = ['homeReserve', 'homeMyRes', 'confirmBtn', 'confirmCancel', 'confirmHome', 'toHome', 'backToTrainer', 'weekHome', 'myResBack', 'doneClose', 'batchToggle'].map((id) => [id, $(w, id)]);
  await toConfirm(w);
  ok('2-1 ホーム→トレーナー→週→確認をボタンで通れる', cur(w) === 's-confirm', cur(w));
  const names = [...w.document.querySelectorAll('#trainerList .tnm')].map((e) => e.textContent);
  ok('2-2 ★トレーナー名は文字として入る（img が作られない）', !w.document.querySelector('#trainerList img') && names[1] === '<img src=x onerror=alert(1)>次郎', names.join('|'));
  ok('2-3 担当の印は担当のトレーナーだけ', w.document.querySelectorAll('#trainerList .tbadge').length === 1);
  ok('2-4 選択肢の取得は1回', sentOf(w, 'line_getBookingOptions').length === 1);
  ok('2-5 確認に担当と日時が出る', $(w, 'cfTrainer').textContent === '一郎' && $(w, 'cfDatetime').textContent.length > 0);
  ok('2-6 取得が済めば確定を押せる', !$(w, 'confirmBtn').disabled);
  $(w, 'confirmBtn').click(); await settle();
  eq('2-7 ★通常の予約で送る中身（packKind は選んでいなければ空）', sentOf(w, 'line_makeReservationLine'), [{ action: 'line_makeReservationLine', trainerId: 'T1', startISO: SLOT.startISO, attendeeCount: 1, packKind: '' }]);
  ok('2-8 完了の画面に移り、日時が出る', cur(w) === 's-done' && $(w, 'doneDetail').textContent.indexOf('10:00') >= 0, $(w, 'doneDetail').textContent);
  ok('2-9 完了の印は線画（絵文字ではない）', !!w.document.querySelector('#s-done .done-icon svg') && $(w, 's-done').querySelector('.done-icon').textContent.trim() === '');
  w.__g.setLang('en'); await settle();
  ok('2-10 ★完了の詳細も言語を切り替えると今の言語になる', $(w, 'doneDetail').textContent.indexOf('一郎') >= 0 && $(w, 'doneDetail').textContent !== '' && !/様|：/.test($(w, 'doneDetail').textContent.replace('一郎', '')), $(w, 'doneDetail').textContent);
  ok('2-11 ★静的なボタンは置き換わっていない（on() の配線が生きている）', btnRefs.every(([id, el]) => $(w, id) === el), btnRefs.filter(([id, el]) => $(w, id) !== el).map((x) => x[0]).join(','));
}
{
  // ペアのみ（pairRemaining>0・通常なし）＝2名が既定・packKind は送らない（サーバーが対象日で判定）
  const w = boot({ handlers: { line_getBookingOptions: { success: true, pairRemaining: 4, pairPackMax: 4, hasNormalRoute: false, pairExpire: '12/31' } } }); await settle();
  await toConfirm(w);
  $(w, 'confirmBtn').click(); await settle();
  eq('2-12 ★ペアのみの会員で送る中身', sentOf(w, 'line_makeReservationLine')[0], { action: 'line_makeReservationLine', trainerId: 'T1', startISO: SLOT.startISO, attendeeCount: 2, packKind: '' });
}
{
  // ペアと通常の両方：使うチケットを「ペア」に選ぶ
  const w = boot({ handlers: { line_getBookingOptions: { success: true, pairRemaining: 4, pairPackMax: 4, hasNormalRoute: true } } }); await settle();
  await toConfirm(w);
  const kind = $(w, 'cfOptions').querySelector('input[name=cfKind][value=pair]');
  ok('2-13 ペアと通常の両方なら、使うチケットの選択肢が確認画面の中に出る', !!kind);
  if (kind) { kind.click(); kind.dispatchEvent(new w.Event('change', { bubbles: true })); }
  await settle();
  const att2 = $(w, 'cfOptions').querySelector('input[name=cfAtt][value="2"]');
  if (att2) { att2.click(); att2.dispatchEvent(new w.Event('change', { bubbles: true })); }
  const before = JSON.stringify({ a: w.__g.state.attendeeCount, k: w.__g.state.packKind, e: w.__g.state.packKindExplicit });
  w.__g.setLang('en'); await settle();
  w.__g.setLang('zh'); await settle();
  const after = JSON.stringify({ a: w.__g.state.attendeeCount, k: w.__g.state.packKind, e: w.__g.state.packKindExplicit });
  ok('2-14 ★選択を変えて言語を切り替えても、選択は変わらない', before === after, before + ' → ' + after);
  ok('2-15 ★言語を切り替えても選択肢を取り直さない', sentOf(w, 'line_getBookingOptions').length === 1, String(sentOf(w, 'line_getBookingOptions').length));
  const kind2 = $(w, 'cfOptions').querySelector('input[name=cfKind][value=pair]');
  ok('2-16 描き直した選択肢も、選んだものに印が付いている', !!kind2 && kind2.checked);
  $(w, 'confirmBtn').click(); await settle();
  eq('2-17 ★言語を切り替えた後に送る中身＝選んだまま', sentOf(w, 'line_makeReservationLine')[0], { action: 'line_makeReservationLine', trainerId: 'T1', startISO: SLOT.startISO, attendeeCount: 2, packKind: 'pair' });
}
{
  // 振替を確認画面で選ぶ→言語を切り替える→振替のまま送る（不具合の再発防止）
  const w = boot({ bootRes: Object.assign({}, HOME, { transferCredits: { available: 1, nextExpireLabel: '11/30' } }) }); await settle();
  await toConfirm(w);
  const pay = $(w, 'cfOptions').querySelector('input[name=cfPay][value=transfer]');
  ok('2-18 振替がある会員は、お支払い方法の選択肢が確認画面の中に出る', !!pay);
  if (pay) { pay.click(); pay.dispatchEvent(new w.Event('change', { bubbles: true })); }
  ok('2-19 振替を選ぶと state に入る', w.__g.state.useTransfer === true);
  w.__g.setLang('en'); await settle();
  ok('2-20 ★言語を切り替えても振替の選択が残る', w.__g.state.useTransfer === true && $(w, 'cfOptions').querySelector('input[name=cfPay][value=transfer]').checked);
  $(w, 'confirmBtn').click(); await settle();
  eq('2-21 ★言語を切り替えた後も振替で送る', w.sent.filter((p) => /^line_make/.test(p.action)), [{ action: 'line_makeTransferReservation', trainerId: 'T1', startISO: SLOT.startISO }]);
}

// ================= 3. 取得中・送信中・照合中の言語切替 =================
{
  const d = deferred();
  const w = boot({ handlers: { line_getBookingOptions: () => d.p } }); await settle();
  await toConfirm(w);
  ok('3-1 取得中は確定を押せない', $(w, 'confirmBtn').disabled);
  w.__g.setLang('en'); await settle(); w.__g.setLang('ja'); await settle(); w.__g.setLang('en'); await settle();
  ok('3-2 ★取得中に言語を何度切り替えても、選択肢の取得は1回', sentOf(w, 'line_getBookingOptions').length === 1, String(sentOf(w, 'line_getBookingOptions').length));
  ok('3-3 ★取得中は言語を切り替えても押せないまま', $(w, 'confirmBtn').disabled);
  d.res({ success: true, pairRemaining: 0, pairPackMax: 0, hasNormalRoute: true }); await settle();
  ok('3-4 元の応答が届けば押せる（今の言語の文言）', !$(w, 'confirmBtn').disabled && $(w, 'confirmBtn').textContent === w.__g.I18N.en.cf_submit, $(w, 'confirmBtn').textContent);
}
{
  const d = deferred();
  const w = boot({ handlers: { line_makeReservationLine: () => d.p } }); await settle();
  await toConfirm(w);
  $(w, 'confirmBtn').click(); await settle();
  ok('3-5 送信中は押せない', $(w, 'confirmBtn').disabled);
  w.__g.setLang('en'); await settle();
  ok('3-6 ★送信中に言語を切り替えても押せないまま・文言は今の言語の「処理中」', $(w, 'confirmBtn').disabled && $(w, 'confirmBtn').textContent === w.__g.I18N.en.cf_submitting, $(w, 'confirmBtn').textContent);
  $(w, 'confirmBtn').disabled = false; $(w, 'confirmBtn').click(); await settle();   // 万一押せる状態にされても
  ok('3-7 ★送信中は処理の先頭でも止める（予約の送信は1回）', sentOf(w, 'line_makeReservationLine').length === 1, String(sentOf(w, 'line_makeReservationLine').length));
  d.res({ success: true }); await settle();
  ok('3-8 結果が出れば完了へ', cur(w) === 's-done', cur(w));
}
{
  // タイムアウト→照合できない（不明）→言語切替でも押せないまま
  const w = boot({ handlers: { line_makeReservationLine: () => Promise.reject(new Error('timeout')), line_getMyReservations: { success: false } } }); await settle();
  await toConfirm(w);
  $(w, 'confirmBtn').click(); for (let i = 0; i < 6; i++) await settle();
  ok('3-9 照合できなければ押せないまま', $(w, 'confirmBtn').disabled && $(w, 'confirmErr').textContent === w.__g.I18N.ja.cf_verify_unknown, $(w, 'confirmErr').textContent);
  w.__g.setLang('en'); await settle();
  ok('3-10 ★照合できなかった後に言語を切り替えても押せないまま・案内は今の言語', $(w, 'confirmBtn').disabled && $(w, 'confirmErr').textContent === w.__g.I18N.en.cf_verify_unknown, $(w, 'confirmErr').textContent);
  ok('3-11 ★再送しない（予約の送信は1回）', sentOf(w, 'line_makeReservationLine').length === 1);
}
{
  // タイムアウト→照合の1回目と再試行の間に言語切替
  let n = 0; const d2 = deferred();
  const w = boot({ handlers: { line_makeReservationLine: () => Promise.reject(new Error('timeout')), line_getMyReservations: () => (++n === 1 ? { success: true, reservations: [] } : d2.p) } }); await settle();
  await toConfirm(w);
  $(w, 'confirmBtn').click(); for (let i = 0; i < 6; i++) await settle();
  w.__g.setLang('en'); await settle();
  ok('3-12 ★照合の途中で言語を切り替えても押せないまま・文言は今の言語の「確認しています」', $(w, 'confirmBtn').disabled && $(w, 'confirmBtn').textContent === w.__g.I18N.en.cf_verifying, $(w, 'confirmBtn').textContent);
  d2.res({ success: true, reservations: [{ startISO: SLOT.startISO }] }); for (let i = 0; i < 4; i++) await settle();
  ok('3-13 入っていたら完了へ（送信は1回のまま）', cur(w) === 's-done' && sentOf(w, 'line_makeReservationLine').length === 1, cur(w));
}

{
  // ★応答が無い（null）＝成立したか分からない → 照合へ・押せないまま（Codex 関門② 重大1）
  const d2 = deferred();
  const w = boot({ handlers: { line_makeReservationLine: () => Promise.resolve(null), line_getMyReservations: () => d2.p } }); await settle();
  await toConfirm(w);
  $(w, 'confirmBtn').click(); for (let i = 0; i < 4; i++) await settle();
  ok('3-14 ★応答が null なら照合に回り、押せないまま', $(w, 'confirmBtn').disabled && w.__g.state.confirmBusy === true && $(w, 'confirmBtn').textContent === w.__g.I18N.ja.cf_verifying, $(w, 'confirmBtn').textContent);
  $(w, 'confirmBtn').disabled = false; $(w, 'confirmBtn').click(); await settle();
  ok('3-15 ★照合中に押しても再送しない', sentOf(w, 'line_makeReservationLine').length === 1);
  // ★照合中は画面を移さない（Codex 関門② 重大2）
  $(w, 'confirmCancel').click(); await settle();
  ok('3-16 ★照合中は「←」で週の画面へ戻らない', cur(w) === 's-confirm', cur(w));
  $(w, 'confirmHome').click(); await settle();
  ok('3-17 ★照合中は「ホームに戻る」も効かない', cur(w) === 's-confirm', cur(w));
  const cc = $(w, 'confirmCancel'), cc0 = cc.onclick; let pressed = 0; cc.onclick = function(){ pressed++; return cc0.apply(this, arguments); };
  w.rsvBack(); await settle();
  cc.onclick = cc0;
  ok('3-18 ★照合中は端末の戻る・横スワイプ（rsvBack）が戻るボタンを押しに行かない', pressed === 0 && cur(w) === 's-confirm', 'pressed=' + pressed + ' ' + cur(w));
  const other = Object.assign({}, SLOT, { startTime: '11:00', endTime: '12:00', startISO: SLOT.startISO.replace('T01:', 'T02:') });
  w.__g.openConfirm(other); await settle();
  ok('3-19 ★照合中は別の枠の確認を開かない（古い送信の印を外さない）', w.__g.state.confirmBusy === true && w.__g.state.selected.startTime === '10:00' && $(w, 'confirmBtn').disabled, JSON.stringify({ b: w.__g.state.confirmBusy, k: w.__g.state.confirmBusyKey, t: w.__g.state.selected && w.__g.state.selected.startTime, d: $(w, 'confirmBtn').disabled }));
  d2.res({ success: true, reservations: [] }); for (let i = 0; i < 6; i++) await settle();
  ok('3-20 照合が「不明」で終わった後は、戻って選び直せる（閉じ込めない）', (() => { $(w, 'confirmCancel').click(); return cur(w) === 's-week'; })(), cur(w));
  ok('3-21 照合の catch の入口で結果待ちに戻す（描画の途中の例外でも押せなくする）', /\/\/ ★ボタンをここで戻さない。[^\n]*\n[^\n]*\n\s*state\.confirmBusy = true; btn\.disabled = true;/.test(HTML));
}
{
  // ★トレーナーの代行の帯「やめる」も照合中は効かない
  const w = boot({ handlers: { line_makeReservationLineProxy: () => Promise.reject(new Error('timeout')), line_getTrainerReservations: () => new Promise(() => {}) } }); await settle();
  await toConfirm(w);
  w.document.body.classList.add('staff'); w.__g.state.proxyMode = true; w.__g.state.proxyCustomerName = 'テスト';
  w.show('s-confirm');
  $(w, 'confirmBtn').click(); for (let i = 0; i < 4; i++) await settle();
  const x = w.document.querySelector('#staffBanner button');
  if (x) x.click(); await settle();
  ok('3-22 ★照合中は代行の帯の「やめる」も効かない', !!x && cur(w) === 's-confirm', cur(w));
}
{
  // ★確認画面の期限も文字として（Codex 関門② 高3）
  const w = boot({ bootRes: Object.assign({}, HOME, { transferCredits: { available: 1, nextExpireLabel: '<img id=xt>11/30' } }), handlers: { line_getBookingOptions: { success: true, pairRemaining: 4, pairPackMax: 4, hasNormalRoute: true, pairExpire: '<img id=xp>12/31' } } }); await settle();
  await toConfirm(w);
  ok('3-23 ★確認画面のペアの期限・振替の期限は HTML にならない', !$(w, 'cfOptions').querySelector('img') && $(w, 'cfOptions').textContent.indexOf('<img id=xp>12/31') >= 0 && $(w, 'cfOptions').textContent.indexOf('<img id=xt>11/30') >= 0, $(w, 'cfOptions').innerHTML.slice(0, 300));
}

// ================= 4. 取得の失敗の文 =================
{
  const w = boot({ handlers: { line_getBookingOptions: { success: false } } }); await settle();
  await toConfirm(w);
  const msg = () => ($(w, 'cfOptions').querySelector('.err') || {}).textContent;
  ok('4-1 取得に失敗したら確定を押せない・日本語の文', $(w, 'confirmBtn').disabled && msg() === w.__g.t('opt_fail', { msg: '' }), msg());
  w.__g.setLang('en'); await settle();
  ok('4-2 ★言語を切り替えると英語の文になる', msg() === w.__g.I18N.en.opt_fail.replace(/\{\w+\}/g, ''), msg());
}
{
  const w = boot({ handlers: { line_getBookingOptions: { success: false, message: '<img src=x>サーバーの文' } } }); await settle();
  await toConfirm(w);
  ok('4-3 ★サーバーの文は訳さず、文字として出す', !$(w, 'cfOptions').querySelector('img') && $(w, 'cfOptions').querySelector('.err').textContent === '<img src=x>サーバーの文');
}

// ================= 5. 自分の予約 =================
{
  const w = boot({ handlers: { line_getMyReservations: { success: true, reservations: [{ reservationId: 'R1', startISO: SLOT.startISO, dateLabel: '<b>11/7</b>', trainerName: '<i>一郎</i>', freeCancel: true, bookType: '月額' }], history: [{ dateLabel: '10/1', trainerName: '<u>二郎</u>', statusLabel: '<s>実施</s>' }] } } }); await settle();
  $(w, 'homeMyRes').click(); await settle();
  ok('5-1 予約の確認に入る', cur(w) === 's-myres', cur(w));
  ok('5-2 ★日時・担当・履歴の状態は文字として入る', !$(w, 'myResList').querySelector('b,i,u,s') && $(w, 'myResList').textContent.indexOf('<i>一郎</i>') >= 0);
  const btns = [...$(w, 'myResList').querySelectorAll('.mres-btns .btn')];
  ok('5-3 時間を変更＝枠のボタン・キャンセル＝コーラル', btns.length === 2 && btns[0].className === 'btn btn-outline' && /btn-danger/.test(btns[1].className));
  const n0 = sentOf(w, 'line_getMyReservations').length;
  w.__g.setLang('en'); await settle();
  ok('5-4 ★言語を切り替えても取り直さず、今の言語で描き直す', sentOf(w, 'line_getMyReservations').length === n0 && $(w, 'myResList').textContent.indexOf(w.__g.I18N.en.sect_upcoming) >= 0);
  ok('5-5 見出しの戻る（data-back）が帯の中にある', $(w, 'myResBack').parentNode.className === 'mhead' && $(w, 'myResBack').hasAttribute('data-back'));
  ok('5-6 戻るの読み上げ名は今の言語', $(w, 'myResBack').getAttribute('aria-label') === w.__g.I18N.en.back.replace(/^←\s*/, ''), $(w, 'myResBack').getAttribute('aria-label'));
}

// ================= 6. 辞書と並び =================
{
  const w = boot(); await settle();
  const I = w.__g.I18N;
  const KEYS = ['home_myres', 'home_greet', 'home_balance', 'step_trainer', 'step_datetime', 'step_confirm', 'trainer_choose', 'trainer_badge', 'home_reserve'];
  const miss = [];
  ['ja', 'en', 'zh', 'zh-Hant'].forEach((l) => KEYS.forEach((k) => { if (!Object.prototype.hasOwnProperty.call(I[l], k) || !String(I[l][k]).trim()) miss.push(l + ':' + k); }));
  ok('6-1 ★4言語の辞書が新しい文言を自分で持つ（日本語への置き換えで隠れない）', miss.length === 0, miss.join(' '));
  const used = [...HTML.matchAll(/data-i18n(?:-aria)?="([\w-]+)"/g)].map((m) => m[1]);
  const missUsed = [...new Set(used)].filter((k) => !Object.prototype.hasOwnProperty.call(I.ja, k));
  ok('6-2 HTML で使う文言の鍵はすべて日本語の辞書にある', missUsed.length === 0, missUsed.join(' '));
  w.__g.setLang('en'); await settle();
  const steps = [...w.document.querySelectorAll('#s-week .msteps span[data-i18n]')].map((e) => e.textContent);
  eq('6-3 進み具合は今の言語', steps, [I.en.step_trainer, I.en.step_datetime, I.en.step_confirm]);
  const backs = [...$(w, 's-week').querySelectorAll('[data-back]')].map((e) => e.id);
  eq('6-4 ★週の画面の data-back の順は「トレーナーを選び直す」→「ホームに戻る」のまま', backs, ['backToTrainer', 'weekHome']);
  const on = [...w.document.querySelectorAll('.msteps')].map((m) => [...m.children].findIndex((c) => c.classList.contains('on')));
  eq('6-5 進み具合の現在地：トレーナー1・日時2・確認3', on, [0, 1, 2]);
}

// ================= 7. 見た目（会員の既定・トレーナーが勝つ） =================
{
  const w = boot(); await settle();
  const css = (el, p) => w.getComputedStyle(el)[p];
  ok('7-1 会員の画面に明朝体を使わない', !/Shippori/.test(STYLE) && !/Shippori/.test(HTML));
  ok('7-2 会員の既定の指定に !important を足していない（トレーナー用より前の部分）', (() => { const m = STYLE.slice(0, STYLE.indexOf('/* ★トレーナーで開いたときだけ')); return (m.match(/!important/g) || []).length <= 3; })(), '既存の3つ（.cell-sel×2・[hidden]）より増やさない');
  //   jsdom は CSS 変数を解決しない＝記述で確かめる
  ok('7-3 主の色はネイビー #243b66・地は #fafbfc・主ボタンは主の色で塗る', /--pri:#243b66;/.test(STYLE) && /--bg:#fafbfc;/.test(STYLE) && /\.btn \{[^}]*background:var\(--pri\)/.test(STYLE));
  w.document.body.classList.add('staff');
  ok('7-4 ★トレーナーの見た目（body.staff）の時は進み具合を出さない', css(w.document.querySelector('#s-confirm .msteps'), 'display') === 'none');
  ok('7-5 入力欄の会員の指定は会員登録の画面だけ（カルテ・トレーナーの入力欄に効かせない）', !/(^|[\s}])input:not\(\[type=checkbox\]\)/.test(STYLE.slice(0, STYLE.indexOf('/* ★トレーナーで開いたときだけ')).replace(/#s-register input/g, '')));
}

console.log('');
console.log(`${fail ? '❌' : '✅'} 会員の予約画面（設計34 C1） 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
