// 設計56 種目を探す欄の直下に候補（予測変換のような縦1列）：本番の liff/karte.js を jsdom で動かし、入口から描いて値で確かめる・2026-11-24
//   実行: node worker/test/liff-karte-suggest.test.js
//   ★下の U1〜U8 の説明は設計55 の検査から写した起動の部品の説明。この検査は G1〜G8
//
//   U1 種目が空のときの案内が、実在するボタンの名前だけを言う
//   U2 セットの × は ✎ の中へ（全部の幅で5列）
//   U3 外す・セットを消すの直後に「〇〇を外しました［元に戻す］」（確認のダイアログは増やさない・休憩の帯と下書きも戻す）
//   U4 前回の行 14px ネイビー・番号 15px・見出し 12px
//   U5 終了音は上部に1つ・種目ごとは秒数だけを「＋ セット」の行へ
//   U6 取り込みの画面：AI が使えるときは「AIで振り分ける」が塗り・「読み取る」が枠・入力欄6行（使えないときは今までどおり）
//   U7 下のタブ：上にアイコン（インライン SVG）・下にラベル1行（11px）
//   U8 記録の画面：保存は見出しの右上・下の帯は種目の欄を開いている間の［選んだ種目を足す］だけ
//   ★身代わりは fetch（Worker）・LINE の SDK だけ。名前はすべて架空

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const require = createRequire(join(homedir(), '.cache/claude-node/package.json'));
const { JSDOM } = require('jsdom');
const SRC = process.env.KARTE_SRC ? readFileSync(process.env.KARTE_SRC, 'utf8') : readFileSync(join(ROOT, 'liff/karte.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) pass++; else { fail++; console.log(`❌ ${name}${detail ? '\n   ' + detail : ''}`); } }
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 12; i++) await tick(); }
const b64u = (s) => Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (ageS) => b64u(JSON.stringify({ alg: 'ES256' })) + '.' + b64u(JSON.stringify({ iss: 'https://access.line.me', sub: 'U_TEST', iat: Math.floor(Date.now() / 1000) - ageS, exp: Math.floor(Date.now() / 1000) + 3600 })) + '.sig';

const HIST = [{ session_id: 'P1', session_date: '2026-10-25', created_at: 100, author_trainer_id: 'T1', rev: 1, sets: [
  { exercise: 'スクワット', set_no: 1, weight_kg: 50, reps: 10 }, { exercise: 'スクワット', set_no: 2, weight_kg: 50, reps: 8 }] }];

function boot(o = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'https://reservation.tokowaka-gym.com/liff/', pretendToBeVisual: true }); dom.window.__KARTE_REST_UI = o.restUi !== false;   // 休憩タイマーは画面では一旦出さない（2026-11-25）。検査では動きを守り続ける
  const w = dom.window;
  const sent = [];
  w.idToken = jwt(30);
  w.EDGE_URL = 'https://edge.example';
  w.state = { trainerId: 'T1', _isOwner: false, _allTrainers: [{ id: 'T1', name: '一郎' }] };
  w.alerts = []; w.alert = (m) => w.alerts.push(String(m));
  w.confirms = 0; w.confirm = () => { w.confirms++; return true; };
  w.__karteReload = () => {};
  w.liff = { getIDToken: () => w.idToken, logout: () => {} };
  if (o.vv) w.visualViewport = Object.assign({ addEventListener() {}, removeEventListener() {}, width: 390 }, o.vv);
  w.cfg = Object.assign({ sessions: [], aiDraft: true, aiConsent: 'agreed', hangSave: false }, o);
  w.fetch = async (url, opt) => {
    const body = JSON.parse(opt.body);
    sent.push(body);
    const c = w.cfg;
    let r;
    if (body.action === 'k_training') r = { success: true, karteSchema: 33, aiDraft: c.aiDraft, aiConsent: c.aiConsent, sessions: c.sessions, best: [] };
    else if (body.action === 'k_exercises') r = { success: true, karteSchema: 33, exercises: [{ name: 'ベンチプレス', part: 'chest' }], truncated: false };
    else if (body.action === 'k_summary') r = { success: true, karteSchema: 33, customer: { name: '会員', trainerId: 'T1' }, hearing: null, consent: { state: 'agreed' } };
    else if (body.action === 'k_addTraining') {
      if (c.hangSave) await new Promise((res) => { w.releaseSave = res; });
      r = { success: true, sessionId: 'N1', rev: 1 };
    }
    else r = { success: true };
    return { json: async () => JSON.parse(JSON.stringify(r)) };
  };
  w.eval(SRC);
  return { w, sent };
}
const R = (w) => w.document.getElementById('karteRoot');
const btn = (root, t) => [...root.querySelectorAll('button')].find((x) => x.textContent.indexOf(t) === 0);
const btns = (root, t) => [...root.querySelectorAll('button')].filter((x) => x.textContent.indexOf(t) === 0);
const DKEY = 'karte_tr_draft_v1:T1:C1';
const draftOf = (w) => JSON.parse(w.localStorage.getItem(DKEY) || 'null');
const names = (w) => (draftOf(w) || { items: [] }).items.map((x) => x.exercise);
const TODAY = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const set = (w0, r0, done, extra) => Object.assign({ w: String(w0), r: String(r0), done: done }, extra || {});
function seed(w, items, extra) { w.localStorage.setItem(DKEY, JSON.stringify(Object.assign({ v: 1, tid: 'T1', cid: 'C1', sessionDate: TODAY, items, reqId: 'kreq1', pending: null, at: Date.now(), openEi: 0 }, extra || {}))); }
async function openRecord(w) { w.KarteUI.open('C1', '会員', 'training'); await settle(); const b0 = btn(R(w), '記録の入力（途中）を開く') || btn(R(w), '＋ 今日の記録'); if (b0) { b0.click(); await settle(); } }
const ITEMS = () => [
  { exercise: 'ベンチプレス', sets: [set(50, 10, true, { note: 'メモA' }), set(50, 8, false)] },
  { exercise: 'スクワット', sets: [set(60, 8, true)] },
  { exercise: 'レッグプレス', sets: [set(100, 12, false)] }];
const exBlock = (w, ei) => R(w).querySelector('[data-ei="' + ei + '"]');
const undoBar = (w) => R(w).querySelector('.k-undo');
const restHost = (w) => { const b = R(w).querySelector('.k-restbar'); if (!b || !b.children.length) return null; const h = b.closest('[data-ei]'); return h ? h.getAttribute('data-ei') : 'top'; };
const shown = (w, e) => !!e && w.getComputedStyle(e).display !== 'none';
//   ✎ を押すとセットに memoOpen（画面の開閉の印）が付く＝中身の比べ合わせからは外す
const itemsOf = (w) => JSON.stringify((draftOf(w) || { items: [] }).items, (k, v) => (k === 'memoOpen' ? undefined : v));

const HIST_R = [{ session_id: 'P1', session_date: '2026-10-25', created_at: 100, author_trainer_id: 'T1', rev: 1, sets: [
  { exercise: 'レッグプレス', set_no: 1, weight_kg: 100, reps: 10 }, { exercise: 'ケーブルフライ改', set_no: 2, weight_kg: 10, reps: 12 }] }];
const Q = (w) => R(w).querySelector('input[aria-label="種目を探す"]');
const rows = (w) => [...R(w).querySelectorAll('.k-suggest button.k-sugrow')];
const nameOf = (b) => (b.querySelector('.k-sugname') || {}).textContent || '';
async function typeQ(w, v) { const q = Q(w); q.value = v; q.dispatchEvent(new w.Event('input', { bubbles: true })); await settle(); }
async function openPicker(w) { await openRecord(w); btn(R(w), '＋ 種目を足す').click(); await settle(); }

// ---- G1 空欄：今までどおり「この方の最近の種目」のチップ・候補の列は出さない ----
{
  const { w } = boot({ sessions: HIST_R });
  await openPicker(w);
  const sg = R(w).querySelector('.k-suggest');
  ok('G1 ★空欄では候補の列を出さない・「この方の最近の種目」のチップのまま', (!sg || !shown(w, sg)) && R(w).querySelector('.k-picker').textContent.includes('この方の最近の種目') && [...R(w).querySelectorAll('.k-picker button.k-pill')].some((b) => b.textContent === 'レッグプレス'));
}
// ---- G2 入れると検索欄の直後が候補の列・前方一致が先・最大件数・44px・太字 ----
{
  const { w } = boot({ sessions: HIST_R });
  await openPicker(w);
  await typeQ(w, 'ベンチ');
  const sg = Q(w).nextElementSibling;
  ok('G2 ★検索欄の直後の要素が候補の列（予測変換のような縦1列）', !!sg && sg.classList.contains('k-suggest') && shown(w, sg) && rows(w).length >= 2, sg && sg.className);
  ok('G2 「部位を直す」は候補の列より後ろ', !!btn(R(w), '部位を直す') && !!(sg.compareDocumentPosition(btn(R(w), '部位を直す')) & w.Node.DOCUMENT_POSITION_FOLLOWING));
  const tiers = rows(w).map((b) => b.dataset.tier), names = rows(w).map(nameOf);
  const firstNonPrefix = tiers.findIndex((t) => t !== 'prefix');
  ok('G2 ★前方一致（ベンチ…）が先・その後に部分一致（…ベンチ…）', tiers[0] === 'prefix' && names[0].indexOf('ベンチ') === 0 && (firstNonPrefix < 0 || tiers.slice(firstNonPrefix).every((t) => t !== 'prefix')) && names.some((n) => n.indexOf('ベンチ') > 0), JSON.stringify(names));
  ok('G2 ★一致した文字を太字', rows(w)[0].querySelector('.k-sugname b') && rows(w)[0].querySelector('.k-sugname b').textContent === 'ベンチ');
  ok('G2 部位は右に小さく', rows(w)[0].querySelector('.k-sugpart').textContent.indexOf('胸') === 0);
  ok('G2 ★1行44px以上', rows(w).every((b) => w.getComputedStyle(b).minHeight === '44px'), w.getComputedStyle(rows(w)[0]).minHeight);
  await typeQ(w, 'プレス');
  ok('G2 ★候補は最大8件（一覧外の「新しい種目として足す」行は別に最後）', rows(w).filter((b) => !b.classList.contains('k-sugnew')).length === 8 && rows(w).slice(0, 8).every((b) => !b.classList.contains('k-sugnew')), String(rows(w).length));
  ok('G2 ★同じ段の中は「この方の最近の種目」（レッグプレス）が先', nameOf(rows(w).find((b) => b.dataset.tier === 'part')) === 'レッグプレス', JSON.stringify(rows(w).map(nameOf)));
  await typeQ(w, 'チンニング');
  ok('G2 別名で正式名（懸垂）が出る・別名の印', rows(w).some((b) => nameOf(b) === '懸垂' && b.dataset.tier === 'alias' && b.textContent.includes('別名')), JSON.stringify(rows(w).map((b) => nameOf(b) + ':' + b.dataset.tier)));
}
// ---- G3 タップで選ぶ → 入力欄は空・フォーカスは検索欄のまま → もう一度探すと ✓ ----
{
  const { w } = boot({ sessions: HIST_R });
  await openPicker(w);
  await typeQ(w, 'ベンチ');
  const r0 = rows(w)[0], nm = nameOf(r0);
  r0.click(); await settle();
  ok('G3 ★タップで選ぶ（選んだ数が増える）・入力欄は空・キーパッドは出したまま（検索欄にフォーカス）', btn(R(w), '選んだ 1 種目を足す') != null && Q(w).value === '' && w.document.activeElement === Q(w));
  ok('G3 空にしたので候補の列は閉じる・最近の種目のチップに戻る', !shown(w, R(w).querySelector('.k-suggest')) && R(w).querySelector('.k-picker').textContent.includes('この方の最近の種目'));
  await typeQ(w, 'ベンチ');
  const r1 = rows(w).find((b) => nameOf(b) === nm);
  ok('G3 ★選んだ候補には ✓（選択済み）', !!r1 && r1.querySelector('.k-sugchk').textContent === '✓' && r1.getAttribute('aria-pressed') === 'true' && r1.classList.contains('on'));
  btn(R(w), '選んだ 1 種目を足す').click(); await settle();
  ok('G3 ★選んだ種目が今日の記録に入る（今までの足し方のまま）', names(w).includes(nm), JSON.stringify(names(w)));
}
// ---- G4 一覧外の名前：最後の行で新しい種目として足す ----
{
  const { w, sent } = boot();
  await openPicker(w);
  await typeQ(w, 'ケーブルクロス');
  const last = rows(w)[rows(w).length - 1];
  ok('G4 ★一覧に無い名前は、列の最後に「『〇〇』を新しい種目として足す」', !!last && last.classList.contains('k-sugnew') && nameOf(last) === '「ケーブルクロス」を新しい種目として足す' && /min-height/.test('min-height') && w.getComputedStyle(last).minHeight === '44px');
  ok('G4 部位を選ぶ欄（設計52 の登録の欄）も今までどおり', !!R(w).querySelector('.k-exnew'));
  last.click(); await settle();
  const sv = sent.filter((x) => x.action === 'k_saveExercise');
  ok('G4 ★押すと名前と推定の部位で登録して選ぶ・入力欄は空', sv.length === 1 && sv[0].name === 'ケーブルクロス' && btn(R(w), '選んだ 1 種目を足す') != null && Q(w).value === '', JSON.stringify(sv));
  await typeQ(w, 'ベンチプレス');
  ok('G4 一覧にある名前（完全一致）には新しい種目の行を出さない', !R(w).querySelector('.k-sugnew'));
}
// ---- G5 部位を直すモード：候補を押すと部位を直す欄 ----
{
  const { w } = boot();
  await openPicker(w);
  btn(R(w), '部位を直す').click(); await settle();
  await typeQ(w, 'ベンチ');
  rows(w)[0].click(); await settle();
  ok('G5 部位を直すときは、候補を押すとその種目の部位を直す欄（選ばない）', !!R(w).querySelector('.k-exeditor') && !btn(R(w), '選んだ 1 種目を足す'));
}


// ---- G6 開いた種目の見出しを押すと閉じる（同じ場所で開閉）----
{
  const { w } = boot();
  seed(w, ITEMS(), { openEi: 0 });
  await openRecord(w);
  const head = () => exBlock(w, 0) && exBlock(w, 0).querySelector('button.k-exhead');
  ok('G6 開いた種目の見出しは押せるボタン（aria-expanded=true・⌄・44px）', !!head() && head().getAttribute('aria-expanded') === 'true' && head().textContent.includes('⌄') && w.getComputedStyle(head()).minHeight === '44px');
  ok('G6 ★［外す］［≡］は見出しのボタンの外（押しても開閉しない）', !head().querySelector('button') && !!btn(exBlock(w, 0), '外す') && !head().contains(btn(exBlock(w, 0), '外す')) && !head().contains(exBlock(w, 0).querySelector('.k-grip')));
  const wIn = exBlock(w, 0).querySelector('input[aria-label="2セット目の重量"]'); wIn.value = '52.5'; wIn.dispatchEvent(new w.Event('input', { bubbles: true }));
  exBlock(w, 0).querySelector('button[aria-label="2セット目を実施済みにする"]').click(); await settle();   // 休憩を数え始める
  exBlock(w, 0).querySelector('.k-grip').dispatchEvent(new w.MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientY: 10, button: 0 }));
  exBlock(w, 0).querySelector('.k-grip').dispatchEvent(new w.MouseEvent('pointerup', { bubbles: true, cancelable: true, clientY: 11, button: 0 })); await settle();
  ok('G6 ★≡ を押しても閉じない（上へ／下へが出るだけ）', !!head() && draftOf(w).openEi === 0 && !!R(w).querySelector('.k-gripud'));
  head().click(); await settle();
  ok('G6 ★同じ見出しを押すと閉じる＝どの種目も開いていない', R(w).querySelectorAll('.k-trform button.k-excol').length === 3 && !R(w).querySelector('button.k-exhead') && draftOf(w).openEi === -1 && !R(w).querySelector('input[aria-label="1セット目の重量"]'));
  ok('G6 ★閉じても入力中の値・✓・下書きは残る', draftOf(w).items[0].sets[1].w === '52.5' && draftOf(w).items[0].sets[1].done === true);
  ok('G6 閉じても休憩は数え続ける（帯は一覧の上）', /休憩 \d:\d\d/.test((R(w).querySelector('.k-restbar') || {}).textContent || ''));
  const col = R(w).querySelector('.k-trform button.k-excol');
  ok('G6 畳んだ行は aria-expanded=false・› の印', col.getAttribute('aria-expanded') === 'false' && col.textContent.includes('›'));
  col.click(); await settle();
  ok('G6 畳んだ行を押すと開く（今どおり）', draftOf(w).openEi === 0 && !!head());
}
// ---- G7 下書きの日付が今日でない → 1行の案内［今日にする］----
{
  const YEST = new Date(Date.now() + 9 * 3600000 - 86400000).toISOString().slice(0, 10);
  const { w } = boot();
  seed(w, ITEMS(), { sessionDate: YEST });
  await openRecord(w);
  const wn = () => R(w).querySelector('.k-datewarn');
  ok('G7 ★前の日の下書き：「日付が 〇/〇(曜) のままです［今日にする］」（44px・ダイアログなし）', !!wn() && shown(w, wn()) && /日付が \d+\/\d+\(.\) のままです/.test(wn().textContent) && !!btn(wn(), '今日にする') && /min-height:\s*44px/.test(btn(wn(), '今日にする').style.cssText) && w.confirms === 0);
  ok('G7 自動では変えない（下書きの日付は前の日のまま）', draftOf(w).sessionDate === YEST);
  btn(wn(), '今日にする').click(); await settle();
  ok('G7 ★押すと記録の日付が今日になり、案内が消える・見出しの日付も今日', draftOf(w).sessionDate === TODAY && !shown(w, wn()) && R(w).querySelector('.k-dateover').value === TODAY);
}
{
  const { w } = boot();
  seed(w, ITEMS());
  await openRecord(w);
  const wn = R(w).querySelector('.k-datewarn');
  ok('G7 ★今日の下書きでは案内を出さない', !wn || !shown(w, wn));
}
// ---- G8 過去の記録から写す：同じ日の記録は1枚・写すと全部 ----
{
  const H = [
    { session_id: 'S1', session_date: '2026-11-20', created_at: 100, author_trainer_id: 'T1', rev: 1, sets: [{ exercise: 'スクワット', set_no: 1, weight_kg: 50, reps: 10 }] },
    { session_id: 'S2', session_date: '2026-11-20', created_at: 200, author_trainer_id: 'T1', rev: 1, sets: [{ exercise: 'ベンチプレス', set_no: 1, weight_kg: 40, reps: 8 }] },
    { session_id: 'S0', session_date: '2026-11-10', created_at: 50, author_trainer_id: 'T1', rev: 1, sets: [{ exercise: 'デッドリフト', set_no: 1, weight_kg: 60, reps: 5 }] }];
  const { w } = boot({ sessions: H });
  await openRecord(w);
  R(w).querySelector('button.k-pickgo').click(); await settle();
  const cards = [...R(w).querySelectorAll('button.k-pick')];
  ok('G8 ★同じ日（11/20）の記録2件は1枚にまとまる', cards.length === 2 && cards[0].textContent.includes('11/20') && !cards[1].textContent.includes('11/20'), String(cards.length));
  const t0 = cards[0].textContent;
  ok('G8 種目は保存した順（スクワット → ベンチプレス）・部位は両方', t0.indexOf('スクワット') >= 0 && t0.indexOf('ベンチプレス') > t0.indexOf('スクワット') && cards[0].querySelectorAll('.k-tag').length >= 2, t0);
  btn(R(w), '重量・回数ごと写す').click(); await new Promise((r) => setTimeout(r, 40)); await settle();
  ok('G8 ★写すとその日の種目が全部入る', JSON.stringify(names(w)) === '["スクワット","ベンチプレス"]', JSON.stringify(names(w)));
}
// ---- G8b 関門②：同じ日の別の記録に同じ名前の種目（旧形式）→ 記録ごとに別の種目として保存順に足す（結合しない・10セット超で落とさない） ----
{
  const sx = (n, w0) => Array.from({ length: n }, (_, i) => ({ exercise: 'スクワット', set_no: i + 1, weight_kg: w0, reps: 10 }));
  const H = [
    { session_id: 'S1', session_date: '2026-11-20', created_at: 100, author_trainer_id: 'T1', rev: 1, sets: sx(6, 50).concat([{ exercise: 'ベンチプレス', set_no: 7, weight_kg: 40, reps: 8 }]) },
    { session_id: 'S2', session_date: '2026-11-20', created_at: 200, author_trainer_id: 'T1', rev: 1, sets: sx(6, 60) }];
  const { w } = boot({ sessions: H });
  await openRecord(w);
  R(w).querySelector('button.k-pickgo').click(); await settle();
  const card = R(w).querySelector('button.k-pick');
  const shownNames = [...card.querySelectorAll('span')].map((x) => x.textContent).filter((t) => t === 'スクワット' || t === 'ベンチプレス');
  btn(R(w), '重量・回数ごと写す').click(); await new Promise((r) => setTimeout(r, 40)); await settle();
  const it = draftOf(w).items;
  ok('G8b ★写した順はカードの表示と同じ（スクワット → ベンチプレス → スクワット・同名でも結合しない）', JSON.stringify(it.map((x) => x.exercise)) === '["スクワット","ベンチプレス","スクワット"]' && JSON.stringify(shownNames) === JSON.stringify(it.map((x) => x.exercise)), JSON.stringify(it.map((x) => x.exercise)) + ' / ' + JSON.stringify(shownNames));
  ok('G8b ★セットが混ざらない・10セットを超えても落とさない（6・1・6）', it.length === 3 && it[0].sets.length === 6 && it[0].sets.every((x) => x.w === 50) && it[1].sets.length === 1 && it[2].sets.length === 6 && it[2].sets.every((x) => x.w === 60) && !w.alerts.some((m) => m.includes('上限')), JSON.stringify(it.map((x) => x.sets.length)) + ' ' + w.alerts.join('|'));
}
// ---- G8c は入口を外した（2026-11-25 オーナー：1件以上のときは前回から写すを出さない）
{
  const { w } = boot({ sessions: [{ session_id: 'S9', session_date: TODAY, created_at: 1, author_trainer_id: 'T1', rev: 1, sets: [{ exercise: 'スクワット', set_no: 1, weight_kg: 50, reps: 10 }] }] });
  await openRecord(w);
  R(w).querySelector('button.k-pickgo').click(); await settle();
  ok('G8 一覧が空のときは「記録の日付（〇/〇）より前の記録だけが出ます」', R(w).textContent.includes('より前の記録だけが出ます') && /記録の日付（\d+\/\d+）/.test(R(w).textContent));
}


// ---- G9 種目が0件：上に「どう始めますか？」の3つ ----
{
  const { w } = boot({ sessions: HIST_R });
  await openRecord(w);
  const sb = R(w).querySelector('.k-start');
  const b3 = sb ? [...sb.querySelectorAll('button.k-startbtn')] : [];
  ok('G9 ★0件：「どう始めますか？」と3つ（前回の記録から／メモ・音声から／手動で入れる）を縦に・44px 以上', !!sb && sb.textContent.includes('どう始めますか？') && JSON.stringify(b3.map((b) => b.textContent)) === '["前回の記録から","メモ・音声から","手動で入れる"]' && b3.every((b) => parseInt(b.style.minHeight, 10) >= 44), JSON.stringify(b3.map((b) => b.textContent)));
  ok('G9 0件のときは下の「追加で取り込む」「前回から写す」を出さない・「＋ 種目を足す」も隠す', !R(w).querySelector('.k-more button') && !shown(w, btn(R(w), '＋ 種目を足す')));
  btn(sb, '手動で入れる').click(); await settle();
  ok('G9 ★「手動で入れる」で種目の欄が開き、検索欄にフォーカス', shown(w, R(w).querySelector('.k-picker')) && w.document.activeElement === Q(w) && shown(w, btn(R(w), '＋ 種目を足す')));
  btn(R(w), '＋ 種目を足す').click(); await settle();
  btn(R(w).querySelector('.k-start'), '前回の記録から').click(); await settle();
  ok('G9 ★「前回の記録から」で過去の記録から写す画面へ', R(w).querySelector('.k-entrytitle').textContent === '過去の記録から写す');
}
{
  const { w } = boot();
  await openRecord(w);
  const pb = R(w).querySelector('.k-start button.k-pickgo');
  ok('G9 過去の記録が無ければ「前回の記録から」は押せない（理由つき）', !!pb && pb.disabled === true && pb.textContent.includes('過去の記録がありません'));
  R(w).querySelector('.k-start button.k-impgo').click(); await settle();
  ok('G9 ★「メモ・音声から」で取り込みの画面へ', R(w).querySelector('.k-entrytitle').textContent === 'メモから取り込む');
}
// ---- G10 種目が1件以上（2026-11-25 オーナー）：下は「＋ 種目を足す」だけ・上に［音声でセッションログを残す］1つ・休憩タイマーの行は出さない ----
{
  const { w } = boot({ sessions: HIST_R, restUi: false });   // 本番と同じ（休憩タイマーを出さない）
  seed(w, ITEMS());
  await openRecord(w);
  const vb = [...R(w).querySelectorAll('button.k-voicelog')];
  ok('G10 ★1件以上：始め方の3つは出さない・上に［音声でセッションログを残す］が1つ（48px）', !R(w).querySelector('.k-start button.k-startbtn') && vb.length === 1 && vb[0].textContent.indexOf('音声でセッションログを残す') === 0 && parseInt(vb[0].style.minHeight, 10) >= 48 && !!(vb[0].compareDocumentPosition(R(w).querySelector('[data-ei="0"]')) & w.Node.DOCUMENT_POSITION_FOLLOWING));
  ok('G10 ★下に「＋ 音声・メモを追加で取り込む」「前回から写す」が無い', !R(w).querySelector('.k-more button') && !R(w).querySelector('button.k-pickgo') && !!btn(R(w), '＋ 種目を足す'));
  ok('G10 ★休憩タイマー・終了音の切り替えは出さない', ![...R(w).querySelectorAll('button')].some((b) => /^(休憩タイマー|終了音)/.test(b.textContent)) && !R(w).querySelector('select[aria-label$="の休憩の秒数"]'));
  vb[0].click(); await settle();
  ok('G10 音声のボタンで取り込みの画面へ', !!R(w).querySelector('.k-entrytitle') && R(w).querySelector('.k-entrytitle').textContent !== '今日の記録を入れる');
}
// ---- G11 既存の種目・メモ・お客様へがある状態で追加の取り込み → 既存は残り、後ろに足される・記録の画面に戻る ----
for (const [label, o] of [['AI 無効', { aiDraft: false }], ['同意なし', { aiDraft: true, aiConsent: 'none' }]]) {
  const { w } = boot(Object.assign({ sessions: HIST_R }, o));
  seed(w, [{ exercise: 'ベンチプレス', sets: [set(40, 10, false)] }], { memo: '既存の社内メモ', member: { message: '既存のお客様へ', todo: ['既存の宿題', '', ''], tags: [] } });
  await openRecord(w);
  R(w).querySelector('.k-start button.k-voicelog').click(); await settle();
  const an = R(w).querySelector('.k-addnote');
  //   2026-11-26 オーナー：「種目 1」が「種目1に足される」と読めた＝数は「1種目」・行き先を言う（liff-karte-voice-target.test.js でも固定）
  //   設計65（2026-11-26 オーナー「挙動の説明は不要」）：「いまの記録は消さずに後ろに足します…」の案内は出さない（足されることは下の検査で入れた結果を見る）
  ok('G11 ' + label + '：取り込みの画面に「後ろに足します」の案内を出さない', !an && !R(w).textContent.includes('後ろに足します') && !R(w).textContent.includes('書き足しません'));
  ok('G11 ' + label + '：AI のボタンは出ず「読み取る」（従来どおり）', !btn(R(w), 'AIで振り分ける') && !!btn(R(w), '読み取る'));
  const ta = R(w).querySelector('textarea[aria-label="メモを貼る"]'); ta.value = 'スクワット\n60×8'; ta.dispatchEvent(new w.Event('input', { bubbles: true }));
  btn(R(w), '読み取る').click(); await settle();
  btn(R(w), 'いまの入力の後ろに足す').click(); await new Promise((r) => setTimeout(r, 40)); await settle();
  const d = draftOf(w);
  ok('G11 ★' + label + '：既存の種目は残り、後ろに足される・社内メモとお客様に見える欄はそのまま', JSON.stringify(d.items.map((x) => x.exercise)) === '["ベンチプレス","スクワット"]' && d.items[0].sets[0].w === '40' && d.memo === '既存の社内メモ' && d.member.message === '既存のお客様へ' && d.member.todo[0] === '既存の宿題', JSON.stringify(d));
  ok('G11 ' + label + '：取り込みの後は記録の画面に戻る', R(w).querySelector('.k-entrytitle').textContent === '今日の記録を入れる');
}

console.log(`liff-karte-suggest: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
