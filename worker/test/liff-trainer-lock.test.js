// 会員の予約は担当トレーナーだけ（設計59・2026-11-25 オーナー要望）を入口から通す検査
//   実行: node worker/test/liff-trainer-lock.test.js
//
//   ★部品ではなく入口から：本番の liff/index.html のスクリプトを丸ごと jsdom で走らせる（liff-member.test.js と同じ作り）。
//     身代わりは LINE の SDK とサーバーへの通信（api・fetchBoot）だけ。ボタンは click で押す。
//     ただし振替（取消の後の確認）・代行・トレーナーの変更（トレーナー画面）は入口の関数を直接呼ぶ（その配線は今回変えていない・関門② 軽）。
//     端末の戻る・横スワイプが backToTrainer を押す配線は liff-back-nav.test.js が守る。
//     1. 担当がいて一覧に居る → 「予約する」で担当の週の表へ直行・担当の名前・案内文
//     2. 直行の戻る → ホーム（空のトレーナー選びを出さない）
//     3. 担当なし・一覧に居ない → 今までどおり全員・案内文・戻るはトレーナー選び
//     4. 型の違い（数値の id と文字の担当）でも直行
//     5. 会員の変更 → 案内文なし・戻るは予約の一覧（再通信しない）。直行の後の変更でも同じ
//     6. 振替 → 案内文なし・戻るはホーム
//     7. 代行・トレーナーの変更 → 直行しない・案内文なし
//     8. 読み込み中の言語切替で前の画面を描き直さない
//     9. 4言語の案内文・言語切替で描き直す
//    10. ［公式LINEで相談する］：LINE の中は閉じてトークへ・外は lin.ee を開く・閉じられなければ開く
//    11. 表示中の週に枠が0：案内とボタンを表の上に強調（素の予約・変更・振替）。代行・トレーナーの変更は出さない
//   名前はすべて架空。

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
  w.__boot = () => Promise.resolve(home);
  w.liff = { init: () => Promise.resolve(), isLoggedIn: () => true, getIDToken: () => 'tok', getAppLanguage: () => o.lang || 'ja', getLanguage: () => o.lang || 'ja', closeWindow() {}, isInClient: () => true };
  w.eval(SRC + '\n;window.__g = { state: state, setLang: setLang, I18N: I18N, startTransfer: startTransfer, startProxyReservation: startProxyReservation, startTrainerChange: startTrainerChange };');
  return w;
}
const $ = (w, id) => w.document.getElementById(id);
const cur = (w) => [...w.document.querySelectorAll('.screen')].filter((s) => !s.hidden).map((s) => s.id).join(',');
const vis = (w, id) => { for (let n = w.document.getElementById(id); n; n = n.parentElement) { if (n.hidden) return false; } return true; };
const sentOf = (w, action) => w.sent.filter((p) => p.action === action);
const lastSlotsTrainer = (w) => { const s = sentOf(w, 'line_getTrainerSlots'); return s.length ? s[s.length - 1].trainerId : null; };
function deferred() { let res; const p = new Promise((a) => { res = a; }); return { p, res }; }
const NOTE_JA = '担当以外のトレーナーでのご予約や、ご希望の日時が見つからない場合は、公式LINEのトークでご相談ください。';

// ================= 1〜2. 担当がいて一覧に居る =================
{
  const w = boot(); await settle();
  ok('1-0 登録済みの会員はホーム', cur(w) === 's-home', cur(w));
  $(w, 'homeReserve').click(); await settle();
  ok('1-1 ★「予約する」で担当の週の表へ直行（トレーナー選びを出さない）', cur(w) === 's-week', cur(w));
  ok('1-2 ★枠は担当のものを取る', lastSlotsTrainer(w) === 'T1', lastSlotsTrainer(w));
  ok('1-3 トレーナーの一覧は描かない（担当以外を押す場所が無い）', w.document.querySelectorAll('#trainerList .trainer').length === 0);
  ok('1-4 担当の名前を出す', !$(w, 'weekTrainer').hidden && $(w, 'weekTrainer').textContent === '担当：架空一郎', $(w, 'weekTrainer').textContent);
  ok('1-5 ★案内文が週の表に出る', !!vis(w, 'weekLineNote') && $(w, 'weekLineNote').textContent === NOTE_JA, $(w, 'weekLineNote').textContent);
  ok('1-6 戻るの読み上げ名は「戻る」（選び直すではない）', $(w, 'backToTrainer').getAttribute('aria-label') === '戻る', $(w, 'backToTrainer').getAttribute('aria-label'));
  //   確認画面へ進んで戻っても担当のまま
  $(w, 'gridWrap').querySelector('.cell-open').click(); await settle();
  ok('1-7 確認画面の担当は担当のトレーナー', cur(w) === 's-confirm' && $(w, 'cfTrainer').textContent === '架空一郎', cur(w) + ' ' + $(w, 'cfTrainer').textContent);
  $(w, 'confirmCancel').click(); await settle();
  ok('1-8 確認画面の戻る → 週の表（担当のまま・案内文あり）', cur(w) === 's-week' && !!vis(w, 'weekLineNote'));
  const ms0 = sentOf(w, 'line_getMemberStatus').length;
  $(w, 'backToTrainer').click(); await settle();
  ok('2-1 ★直行の戻る → ホーム（空のトレーナー選びを出さない）', cur(w) === 's-home', cur(w));
  ok('2-2 ホームは取り直す（loadHome）', sentOf(w, 'line_getMemberStatus').length === ms0 + 1);
  //   2回目の「予約する」も直行
  $(w, 'homeReserve').click(); await settle();
  ok('2-3 もう一度「予約する」も直行', cur(w) === 's-week' && lastSlotsTrainer(w) === 'T1');
  $(w, 'weekHome').click(); await settle();
  ok('2-4 「ホームに戻る」は今のまま', cur(w) === 's-home', cur(w));
}

// ================= 3. 担当なし・一覧に居ない =================
for (const [label, def] of [['担当なし', ''], ['担当が一覧に居ない', 'T9']]) {
  const w = boot({ home: HOME(def) }); await settle();
  $(w, 'homeReserve').click(); await settle();
  ok(`3-1 ★${label} → 今までどおりトレーナー選び（全員）`, cur(w) === 's-trainer' && w.document.querySelectorAll('#trainerList .trainer').length === 2, cur(w));
  ok(`3-2 ${label}：トレーナー選びにも案内文`, !!vis(w, 'trainerLineNote') && $(w, 'trainerLineNote').textContent === NOTE_JA);
  w.document.querySelectorAll('#trainerList .trainer')[1].click(); await settle();
  ok(`3-3 ${label}：選んだトレーナーの週の表`, cur(w) === 's-week' && lastSlotsTrainer(w) === 'T2');
  ok(`3-4 ${label}：週の表に案内文・担当の名前は出さない`, !!vis(w, 'weekLineNote') && $(w, 'weekTrainer').hidden);
  ok(`3-5 ${label}：戻るの読み上げ名は今のまま「トレーナーを選び直す」`, $(w, 'backToTrainer').getAttribute('aria-label') === 'トレーナーを選び直す');
  $(w, 'backToTrainer').click(); await settle();
  ok(`3-6 ${label}：戻る → トレーナー選び（今のまま）`, cur(w) === 's-trainer', cur(w));
}

// ================= 4. 型の違い =================
{
  const w = boot({ home: HOME('7'), handlers: { line_getTrainers: { success: true, trainers: [{ id: 3, name: '架空三郎' }, { id: 7, name: '架空七子' }] } } }); await settle();
  $(w, 'homeReserve').click(); await settle();
  ok('4-1 ★数値の id と文字の担当でも直行', cur(w) === 's-week' && String(lastSlotsTrainer(w)) === '7', cur(w) + ' ' + lastSlotsTrainer(w));
}

// ================= 5. 会員の変更 =================
{
  const w = boot(); await settle();
  $(w, 'homeMyRes').click(); await settle();
  ok('5-0 予約の確認', cur(w) === 's-myres', cur(w));
  const chg = [...$(w, 'myResList').querySelectorAll('button')].find((b) => b.textContent === w.__g.I18N.ja.change_time);
  chg.click(); await settle();
  ok('5-1 変更は今のまま、その予約のトレーナーの週の表', cur(w) === 's-week' && lastSlotsTrainer(w) === 'T2');
  ok('5-2 ★変更では案内文・担当の名前を出さない', !vis(w, 'weekLineNote') && $(w, 'weekTrainer').hidden);
  const n0 = sentOf(w, 'line_getMyReservations').length;
  $(w, 'backToTrainer').click(); await settle();
  ok('5-3 ★変更の戻る → 予約の一覧（空のトレーナー選びに落ちない）', cur(w) === 's-myres', cur(w));
  ok('5-4 戻りは再通信しない（失敗で戻れない画面に落とさない）', sentOf(w, 'line_getMyReservations').length === n0);
}
{
  //   直行 → 戻る（ホーム）→ 予約の確認 → 変更 → 戻る：前の直行の印が残っていても予約の一覧へ
  const w = boot(); await settle();
  $(w, 'homeReserve').click(); await settle();
  $(w, 'backToTrainer').click(); await settle();
  $(w, 'homeMyRes').click(); await settle();
  [...$(w, 'myResList').querySelectorAll('button')].find((b) => b.textContent === w.__g.I18N.ja.change_time).click(); await settle();
  ok('5-5 直行の後の変更でも案内文なし', cur(w) === 's-week' && !vis(w, 'weekLineNote'));
  $(w, 'backToTrainer').click(); await settle();
  ok('5-6 ★直行の後の変更の戻る → 予約の一覧', cur(w) === 's-myres', cur(w));
}

// ================= 6. 振替 =================
{
  const w = boot(); await settle();
  w.__g.startTransfer(RESV); await settle();
  ok('6-1 振替は今のまま、その予約のトレーナーの週の表', cur(w) === 's-week' && lastSlotsTrainer(w) === 'T2');
  ok('6-2 ★振替では案内文を出さない', !vis(w, 'weekLineNote') && $(w, 'weekTrainer').hidden);
  $(w, 'backToTrainer').click(); await settle();
  ok('6-3 ★振替の戻る → ホーム（空のトレーナー選びに落ちない）', cur(w) === 's-home', cur(w));
}

// ================= 7. 代行・トレーナーの変更 =================
{
  const w = boot(); await settle();
  w.__g.startProxyReservation('C-TEST', '架空客', 'T1'); await settle();
  ok('7-1 ★代行は直行しない（今のまま一覧・担当以外も選べる）', cur(w) === 's-trainer' && w.document.querySelectorAll('#trainerList .trainer').length === 2, cur(w));
  ok('7-2 代行のトレーナー選びに案内文を出さない', !vis(w, 'trainerLineNote'));
  w.document.querySelectorAll('#trainerList .trainer')[1].click(); await settle();
  ok('7-3 代行の週の表に案内文・担当の名前を出さない', cur(w) === 's-week' && !vis(w, 'weekLineNote') && $(w, 'weekTrainer').hidden && lastSlotsTrainer(w) === 'T2');
  ok('7-4 代行の戻るの読み上げ名は今のまま', $(w, 'backToTrainer').getAttribute('aria-label') === 'トレーナーを選び直す');
}
{
  const w = boot(); await settle();
  w.__g.state.trainerId = 'T2';
  w.__g.startTrainerChange({ reservationId: 'R1', trainerId: 'T2', customerId: 'C-TEST', customerName: '架空客', startISO: SLOT.startISO }, false); await settle();
  ok('7-5 トレーナーの変更：週の表・案内文なし', cur(w) === 's-week' && !vis(w, 'weekLineNote') && $(w, 'weekTrainer').hidden, cur(w));
}

// ================= 8. 読み込み中の言語切替 =================
{
  const d = deferred();
  const w = boot({ handlers: { line_getTrainerSlots: () => d.p } }); await settle();
  $(w, 'homeMyRes').click(); await settle();
  [...$(w, 'myResList').querySelectorAll('button')].find((b) => b.textContent === w.__g.I18N.ja.change_time).click(); await settle();
  ok('8-0 枠の読み込み中', cur(w) === 's-loading', cur(w));
  w.__g.setLang('en'); await settle();
  ok('8-1 ★読み込み中に言語を切り替えても、予約の一覧を描き直さない（別の予約を押せない）', cur(w) === 's-loading', cur(w));
  d.res({ success: true, slots: [SLOT] }); await settle();
  ok('8-2 応答が来たら週の表', cur(w) === 's-week', cur(w));
}
{
  const d = deferred();
  const w = boot({ handlers: { line_getTrainers: () => d.p } }); await settle();
  $(w, 'homeReserve').click(); await settle();
  w.__g.setLang('en'); await settle();
  ok('8-3 トレーナーの読み込み中に言語を切り替えてもホームを描き直さない', cur(w) === 's-loading', cur(w));
  d.res(TRAINERS); await settle();
  ok('8-4 応答が来たら担当の週の表', cur(w) === 's-week' && lastSlotsTrainer(w) === 'T1', cur(w));
}

// ================= 9. 4言語 =================
{
  const I = boot().__g.I18N;
  const langs = ['ja', 'en', 'zh', 'zh-Hant'];
  ok('9-1 ★案内文を4言語が自分で持つ（日本語に落ちない）', langs.every((l) => typeof I[l].lock_note === 'string' && I[l].lock_note.length > 10) && new Set(langs.map((l) => I[l].lock_note)).size === 4);
  ok('9-2 英語・中国語は公式LINEに触れる', /LINE/.test(I.en.lock_note) && /LINE/.test(I.zh.lock_note) && /LINE/.test(I['zh-Hant'].lock_note));
  const w = boot(); await settle();
  $(w, 'homeReserve').click(); await settle();
  w.__g.setLang('en'); await settle();
  ok('9-3 ★週の表で言語を切り替えると案内文・担当の名前・戻るの読み上げ名が英語になる', $(w, 'weekLineNote').textContent === I.en.lock_note && !!vis(w, 'weekLineNote') && $(w, 'weekTrainer').textContent === I.en.cf_trainer_label + '架空一郎' && $(w, 'backToTrainer').getAttribute('aria-label') === 'Back', $(w, 'weekTrainer').textContent + ' / ' + $(w, 'backToTrainer').getAttribute('aria-label'));
  const w2 = boot({ lang: 'zh-Hant', home: HOME('') }); await settle();
  $(w2, 'homeReserve').click(); await settle();
  ok('9-4 繁体字でトレーナー選びの案内文', $(w2, 'trainerLineNote').textContent === I['zh-Hant'].lock_note && !!vis(w2, 'trainerLineNote'));
}


// ================= 10. 公式LINEで相談する（設計59 改訂2・関門③） =================
const clickEv = (w) => new w.MouseEvent('click', { bubbles: true, cancelable: true });
{
  const w = boot(); await settle();
  let closed = 0; w.liff.closeWindow = () => { closed++; };
  $(w, 'homeReserve').click(); await settle();
  const a = $(w, 'weekLineBtn');
  ok('10-0 素の予約の週の表にボタンが見える', vis(w, 'weekLineBtn') && a.tagName === 'A');
  const ev = clickEv(w); a.dispatchEvent(ev);
  ok('10-1 ★LINE の中 → ミニアプリを閉じてトークへ戻す（closeWindow）・リンクは開かない', closed === 1 && ev.defaultPrevented === true, `closed=${closed} prevented=${ev.defaultPrevented}`);
  const u = new w.URL(a.href);
  ok('10-2 ★リンクの値は公式LINE（lin.ee/U8oLJPT）・別タブ', u.protocol === 'https:' && u.hostname === 'lin.ee' && u.pathname === '/U8oLJPT' && a.getAttribute('target') === '_blank' && /noopener/.test(a.getAttribute('rel') || ''), a.href);
  const ev1b = clickEv(w); a.dispatchEvent(ev1b);
  ok('10-3b ★閉じなかった（例外なしで静かに失敗）→ 2回目はリンクのまま開く', closed === 1 && ev1b.defaultPrevented === false, `closed=${closed} prevented=${ev1b.defaultPrevented}`);
}
{
  const w = boot(); await settle();
  let closed = 0; w.liff.closeWindow = () => { closed++; };
  w.liff.isInClient = () => false;
  $(w, 'homeReserve').click(); await settle();
  const ev2 = clickEv(w); $(w, 'weekLineBtn').dispatchEvent(ev2);
  ok('10-3 ★LINE の外 → 閉じずにリンクのまま開く（既定の動きを止めない）', closed === 0 && ev2.defaultPrevented === false);
  w.liff.isInClient = () => { throw new Error('x'); };
  const ev3 = clickEv(w); $(w, 'weekLineBtn').dispatchEvent(ev3);
  ok('10-3c isInClient が例外 → リンクのまま開く', ev3.defaultPrevented === false);
}
{
  const w = boot(); await settle();
  $(w, 'homeReserve').click(); await settle();
  w.liff.closeWindow = () => { throw new Error('x'); };
  let opened = null; w.open = (url, tgt) => { opened = [url, tgt]; return {}; };
  const ev = clickEv(w); $(w, 'weekLineBtn').dispatchEvent(ev);
  ok('10-4 ★閉じられない（例外）→ 公式LINE を別タブで開く', ev.defaultPrevented && opened && new w.URL(opened[0]).hostname === 'lin.ee' && new w.URL(opened[0]).pathname === '/U8oLJPT' && opened[1] === '_blank' && w.__g.state._lineOpenedBy === 'open', JSON.stringify(opened));
}
{
  const w = boot(); await settle();
  $(w, 'homeReserve').click(); await settle();
  w.liff.closeWindow = () => { throw new Error('x'); };
  w.open = () => null;
  $(w, 'weekLineBtn').dispatchEvent(clickEv(w));
  ok('10-4b ★別タブを止められた（null）→ この画面で公式LINE（lin.ee/U8oLJPT）を開く', w.__nav && new w.URL(w.__nav).hostname === 'lin.ee' && new w.URL(w.__nav).pathname === '/U8oLJPT', String(w.__nav));
  const a = $(w, 'weekLineBtn');
  ok('10-5 押せる大きさ（.btn・最小48px）', a.classList.contains('btn') && /\.btn \{[^}]*min-height:48px/.test(STYLE) && /a\.lock-line-btn \{[^}]*text-align:center/.test(STYLE));
  ok('10-6 空きのある週は強調しない（文言なし・表の下）', !vis(w, 'weekNoSlots') && !$(w, 'weekLineBox').classList.contains('lock-strong') && $(w, 'weekHint').nextElementSibling === $(w, 'weekLineBox'));
}
{
  //   担当なしの会員：トレーナー選びにもボタン
  const w = boot({ home: HOME('') }); await settle();
  let closed = 0; w.liff.closeWindow = () => { closed++; };
  $(w, 'homeReserve').click(); await settle();
  $(w, 'trainerLineBtn').dispatchEvent(clickEv(w));
  ok('10-7 担当なし：トレーナー選びのボタンも閉じてトークへ', vis(w, 'trainerLineBtn') && closed === 1);
}
const EMPTY = { line_getTrainerSlots: { success: true, slots: [] } };
{
  const w = boot({ handlers: EMPTY }); await settle();
  $(w, 'homeReserve').click(); await settle();
  ok('11-1 ★担当の空きが0の週：案内とボタンを表の上に枠つきで出す', cur(w) === 's-week' && vis(w, 'weekLineBox') && vis(w, 'weekLineBtn') && vis(w, 'weekNoSlots') && $(w, 'weekLineBox').classList.contains('lock-strong') && $(w, 'weekLineBox').nextElementSibling === $(w, 'gridWrap'), $(w, 'weekNoSlots').textContent);
  ok('11-2 文言は「この週はご予約いただける枠がありません。」', $(w, 'weekNoSlots').textContent === 'この週はご予約いただける枠がありません。');
  ok('11-3 週の移動は今のまま押せる', !$(w, 'nextWeek').disabled && vis(w, 'nextWeek'));
}
{
  //   空きのある週 → 次の週（空きなし）→ 前の週：強調を毎回付け外しする
  const w = boot(); await settle();
  $(w, 'homeReserve').click(); await settle();
  const strong = () => vis(w, 'weekNoSlots') && $(w, 'weekLineBox').classList.contains('lock-strong') && $(w, 'weekLineBox').nextElementSibling === $(w, 'gridWrap');
  ok('11-3a 空きのある週は強調しない', !strong() && vis(w, 'weekLineBox'));
  $(w, 'nextWeek').click(); await settle();
  ok('11-3b ★次の週（空きなし）へ進むと強調して表の上へ', strong());
  $(w, 'prevWeek').click(); await settle();
  ok('11-3c ★前の週（空きあり）へ戻ると強調を外し表の下へ', !vis(w, 'weekNoSlots') && !$(w, 'weekLineBox').classList.contains('lock-strong') && vis(w, 'weekLineBox') && $(w, 'weekHint').nextElementSibling === $(w, 'weekLineBox'));
}
for (const [label, go] of [['変更', async (w) => { $(w, 'homeMyRes').click(); await settle(); [...$(w, 'myResList').querySelectorAll('button')].find((b) => b.textContent === w.__g.I18N.ja.change_time).click(); await settle(); }],
                          ['振替', async (w) => { w.__g.startTransfer(RESV); await settle(); }]]) {
  const w = boot({ handlers: EMPTY }); await settle();
  await go(w);
  ok(`11-4 ★${label}：空きが0の週だけ案内とボタンを強調して出す`, cur(w) === 's-week' && vis(w, 'weekLineBtn') && vis(w, 'weekNoSlots') && $(w, 'weekLineBox').classList.contains('lock-strong'), cur(w));
  const w2 = boot(); await settle();
  await go(w2);
  ok(`11-5 ★${label}：空きがあれば今のまま出さない`, cur(w2) === 's-week' && !vis(w2, 'weekLineBox'));
}
{
  const w = boot({ handlers: EMPTY }); await settle();
  w.__g.startProxyReservation('C-TEST', '架空客', 'T1'); await settle();
  w.document.querySelectorAll('#trainerList .trainer')[0].click(); await settle();
  ok('11-6 代行は空きが0でも出さない（トレーナーの画面は今のまま）', cur(w) === 's-week' && !vis(w, 'weekLineBox'));
  const w3 = boot({ handlers: EMPTY }); await settle();
  w3.__g.state.trainerId = 'T2';
  w3.__g.startTrainerChange({ reservationId: 'R1', trainerId: 'T2', customerId: 'C-TEST', customerName: '架空客', startISO: SLOT.startISO }, false); await settle();
  ok('11-7 トレーナーの変更も空きが0で出さない', cur(w3) === 's-week' && !vis(w3, 'weekLineBox'));
}
{
  const I = boot().__g.I18N; const langs = ['ja', 'en', 'zh', 'zh-Hant'];
  ok('11-8 ボタンと空きなしの文を4言語が自分で持つ', ['lock_line_btn', 'lock_noslots'].every((k) => langs.every((l) => typeof I[l][k] === 'string' && I[l][k].length > 3) && new Set(langs.map((l) => I[l][k])).size === 4));
  const w = boot({ handlers: EMPTY }); await settle();
  $(w, 'homeReserve').click(); await settle();
  w.__g.setLang('en'); await settle();
  ok('11-9 言語を切り替えるとボタン・空きなしの文も英語・強調は保つ', $(w, 'weekLineBtn').textContent === I.en.lock_line_btn && $(w, 'weekNoSlots').textContent === I.en.lock_noslots && vis(w, 'weekNoSlots'));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
