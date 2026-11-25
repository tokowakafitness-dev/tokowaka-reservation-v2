// 設計53 種目の順番を ≡ つまみで入れ替える（記録の画面・AI の確認画面）：本番の liff/karte.js を jsdom で動かし、入口から通す・2026-11-23
//   実行: node worker/test/liff-karte-ai-review.test.js
//
//   ★カルテを開く → 今日の記録 → メモから取り込む → 貼る → 「AIで振り分ける」→ 1画面の確認 → 最後のボタン → 記録の画面 → ✓ → 保存、を click で通す
//   ★身代わりは fetch（Worker）・LINE の SDK だけ。Worker の応答は worker/src/routes/karte-ai-v2.js の draft（v:2）の形
//   ★検査は定数を置き換えて trial・full・不正値の3通りを通す（本番の値は 2026-11-21 から full＝R0 で固定）
//   ★文字起こしは架空（実在の会員・録音の内容を書かない）

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const require = createRequire(join(homedir(), '.cache/claude-node/package.json'));
const { JSDOM } = require('jsdom');
const RAW = process.env.KARTE_SRC ? readFileSync(process.env.KARTE_SRC, 'utf8') : readFileSync(join(ROOT, 'liff/karte.js'), 'utf8');
//   2026-11-21 本番は 'full'（D8＝同意の版 rec_ai-2026-11-21・決定0195）。検査は定数を置き換えて trial・full・不正値の3通りを通す
const SCOPE_RE = /^  var AI_V2_SAVE_SCOPE = '[^']*';$/m;
const SCOPE_LINES = RAW.match(new RegExp(SCOPE_RE.source, 'mg')) || [];
const withScope = (v) => RAW.replace(SCOPE_RE, "  var AI_V2_SAVE_SCOPE = '" + v + "';");
const SRC = withScope('trial');
const FULL = withScope('full');
const BOGUS = withScope('Full');

let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) pass++; else { fail++; console.log(`❌ ${name}${detail ? '\n   ' + detail : ''}`); } }
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 12; i++) await tick(); }
async function nav() { await new Promise((r) => setTimeout(r, 40)); await settle(); }
const b64u = (s) => Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (ageS) => b64u(JSON.stringify({ alg: 'ES256' })) + '.' + b64u(JSON.stringify({ iss: 'https://access.line.me', sub: 'U_TEST', iat: Math.floor(Date.now() / 1000) - ageS, exp: Math.floor(Date.now() / 1000) + 3600 })) + '.sig';

const SECRET = '架空の選挙の雑談がここにある';
const TRANSCRIPT = 'ベンチプレス 50キロで10回\n同じ重さでもう1セット 8回\nスカルフラッシュ 10キロで12回\n' + SECRET;
const EVID = '同じ重さでもう1セット 8回';
const DRAFT = () => ({
  v: 2, effort: 'medium',
  summary: ['ベンチプレスを50キロから始めた', 'スクワットを自重で行った'],
  exercises: [
    { name: 'ベンチプレス', heard: 'ベンチプレス', note: '肩甲骨を寄せる', sets: [
      { status: 'match', w: 50, r: 10, bw: false, evidence: 'ベンチプレス 50キロで10回', unsure: '', note: 'フォーム良い' },
      { status: 'inferred', w: 50, r: 8, bw: false, evidence: EVID, unsure: '予告かもしれない', note: '' },
      { status: 'nobasis', w: 60, r: 5, bw: false, evidence: '60キロで5回', unsure: '', note: '' },
      { status: 'healthHidden', w: null, r: null, bw: false, evidence: '', unsure: '', note: '' },
      { status: 'inferred', w: 40, r: null, bw: false, evidence: '40キロいきましょう', unsure: '', note: '' }] },
    { name: 'スカルクラッシュ改', heard: 'スカルフラッシュ', note: '', sets: [{ status: 'match', w: 10, r: 12, bw: false, evidence: 'スカルフラッシュ 10キロで12回', unsure: '', note: '' }] },
    { name: 'スクワット', heard: 'スクワット', note: '', sets: [{ status: 'match', w: null, r: 15, bw: true, evidence: 'スクワット 自重で15回', unsure: '', note: '' }] },
    { name: 'レッグプレス', heard: 'レッグプレス', note: '', sets: [{ status: 'inferred', w: null, r: 8, bw: false, evidence: 'レッグプレス 8回', unsure: '', note: '' }] }],
  condition: ['睡眠不足で疲れ気味'],
  caution: ['膝が少し痛い'],
  coaching: ['お客様の肘を張りすぎない', '〔人〕と一緒に来たいと話していた'],
  hearing: ['睡眠は5時間くらい'],
  next_actions: ['次回はベンチプレスを52.5キロで'],
  member_message: 'フォームが安定してきました。',
  member_todo: ['ストレッチ 2分'],
  unclear: [{ text: '2セット目が予告か実施か分からない', evidence: EVID }],
});

function boot(o = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'https://reservation.tokowaka-gym.com/liff/', pretendToBeVisual: true }); dom.window.__KARTE_REST_UI = true;   // 休憩タイマーは画面では一旦出さない（2026-11-25）。検査では動きを守り続ける
  const w = dom.window;
  const sent = [];
  w.idToken = jwt(30);
  w.EDGE_URL = 'https://edge.example';
  w.state = { trainerId: 'T1', _isOwner: false, _allTrainers: [{ id: 'T1', name: '一郎' }] };
  w.alerts = []; w.alert = (m) => w.alerts.push(String(m));
  w.confirms = 0; w.confirm = () => { w.confirms++; return true; };
  w.__karteReload = () => {};
  w.logs = [];
  ['log', 'info', 'warn', 'error', 'debug'].forEach((k) => { w.console[k] = (...a) => w.logs.push(a.map(String).join(' ')); });
  w.liff = { getIDToken: () => w.idToken, logout: () => {} };
  w.cfg = Object.assign({ draft: DRAFT }, o.cfg || {});
  w.fetch = async (url, opt) => {
    const body = JSON.parse(opt.body);
    sent.push({ url: String(url), body });
    const c = w.cfg;
    let r;
    if (body.action === 'k_training') r = { success: true, karteSchema: 33, aiDraft: true, aiConsent: 'agreed', sessions: [], best: [] };
    else if (body.action === 'k_exercises') r = { success: true, karteSchema: 33, exercises: [{ name: 'ベンチプレス', part: 'chest' }], truncated: false };
    else if (body.action === 'k_aiDraft') {
      if (c.hang) await new Promise((res, rej) => { if (opt.signal) opt.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }); });
      r = c.reply ? c.reply(body) : { success: true, draft: c.draft(), model: 'claude-sonnet-5-5', build: 'x' };
    }
    else if (body.action === 'k_addTraining') r = { success: true, sessionId: 'N1', rev: 1, mnoteId: body.member ? 'M1' : undefined };
    else r = { success: true };
    return { json: async () => JSON.parse(JSON.stringify(r)) };
  };
  w.eval(o.src || SRC);
  return { w, sent };
}
const R = (w) => w.document.getElementById('karteRoot');
const btn = (root, t) => [...root.querySelectorAll('button')].find((x) => x.textContent.indexOf(t) === 0);
const btns = (root, t) => [...root.querySelectorAll('button')].filter((x) => x.textContent.indexOf(t) === 0);
const DKEY = 'karte_tr_draft_v1:T1:C1';
const draftOf = (w) => JSON.parse(w.localStorage.getItem(DKEY) || 'null');
const storeText = (s) => { let o = ''; for (let i = 0; i < s.length; i++) o += s.key(i) + '=' + s.getItem(s.key(i)) + '\n'; return o; };
async function openImport(w) {
  w.KarteUI.open('C1', '会員', 'training'); await settle();
  const b = btn(R(w), '＋ 今日の記録') || btn(R(w), '記録の入力（途中）を開く');
  if (b && !R(w).classList.contains('k-entry')) { b.click(); await settle(); }
  R(w).querySelector('button.k-impgo').click(); await settle();
}
function paste(w, text) { const ta = R(w).querySelector('textarea[aria-label="メモを貼る"]'); ta.value = text; ta.dispatchEvent(new w.Event('input', { bubbles: true })); return ta; }
async function toReview(w) { await openImport(w); paste(w, TRANSCRIPT); btn(R(w), 'AIで振り分ける').click(); await settle(); }
async function saveAll(w) {
  for (let i = 0; i < 4; i++) { const b = R(w).querySelector('button.k-allchk'); if (!b) break; b.click(); await settle(); }
  btn(R(w), '保存する').click(); await settle();
}

const put = (w) => R(w).querySelector('button.k-rvput');
const cards = (w) => [...R(w).querySelectorAll('.k-rvex')];
const card = (w, name) => cards(w).find((c) => c.querySelector('.k-rvname') && c.querySelector('.k-rvname').value === name);
const lineOf = (c) => c.querySelector('.k-rvline');
const chipsOf = (c) => [...c.querySelectorAll('.k-rvchip')].map((x) => x.dataset.st);
const foot = (w) => (R(w).querySelector('.k-rvcount') || {}).textContent || '';
const why = (w) => (R(w).querySelector('.k-rvwhy') || {}).textContent || '';
const field = (w, k) => R(w).querySelector('.k-rvfield[data-field="' + k + '"]');
function type(w, elx, v) { elx.value = v; elx.dispatchEvent(new w.Event('input', { bubbles: true })); }
async function pickPart(w, name, part) {   // 設計52：部位はチップ（推定）を開いてから選ぶ
  const find = () => [...card(w, name).querySelectorAll('button.k-pill')].find((x) => x.textContent === part);
  if (!find()) { card(w, name).querySelector('.k-rvpart').click(); await settle(); }
  find().click(); await settle();
}

const TODAY = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const set = (w0, r0, done, extra) => Object.assign({ w: String(w0), r: String(r0), done: done }, extra || {});
function seed(w, items, extra) { w.localStorage.setItem(DKEY, JSON.stringify(Object.assign({ v: 1, tid: 'T1', cid: 'C1', sessionDate: TODAY, items, reqId: 'kreq1', pending: null, at: Date.now(), openEi: 0 }, extra || {}))); }
async function openRecord(w) { w.KarteUI.open('C1', '会員', 'training'); await settle(); const b0 = btn(R(w), '記録の入力（途中）を開く') || btn(R(w), '＋ 今日の記録'); if (b0) { b0.click(); await settle(); } }
const grips = (w) => [...R(w).querySelectorAll('.k-grip')];
const grip = (w, i) => R(w).querySelector('.k-grip[data-idx="' + i + '"]');
const names = (w) => (draftOf(w) || { items: [] }).items.map((x) => x.exercise);
const pe = (w, el0, type, y) => el0.dispatchEvent(new w.MouseEvent(type, { bubbles: true, cancelable: true, clientY: y, button: 0 }));
async function tap(w, el0) { pe(w, el0, 'pointerdown', 10); pe(w, el0, 'pointerup', 11); await settle(); }
function stubRows(w) { [...R(w).querySelectorAll('[data-ei]')].forEach((r) => { const i = Number(r.getAttribute('data-ei')); r.getBoundingClientRect = () => ({ top: i * 60, bottom: i * 60 + 50, height: 50, left: 0, right: 300, width: 300 }); }); }
const ITEMS = () => [
  { exercise: 'ベンチプレス', sets: [set(50, 10, true, { note: 'メモA', src: 'inferred' })] },
  { exercise: 'スクワット', sets: [set(60, 8, true)] },
  { exercise: 'レッグプレス', sets: [set(100, 12, true)] }];

// ---------- S1 純粋な関数 ----------
{
  const { w } = boot({ src: FULL });
  const T = w.KarteUI._t, J = JSON.stringify;
  ok('S1 ★moveIndex：前へ・後ろへ・端・同じ位置・範囲外', J(T.moveIndex(['a', 'b', 'c'], 2, 0)) === '["c","a","b"]' && J(T.moveIndex(['a', 'b', 'c'], 0, 2)) === '["b","c","a"]' && J(T.moveIndex(['a', 'b', 'c'], 1, 1)) === '["a","b","c"]' && J(T.moveIndex(['a', 'b', 'c'], 3, 0)) === '["a","b","c"]' && J(T.moveIndex(['a', 'b', 'c'], 0, -1)) === '["a","b","c"]');
  ok('S1 movedIndex：動かした要素・間の要素・外の要素', T.movedIndex(0, 0, 2) === 2 && T.movedIndex(1, 0, 2) === 0 && T.movedIndex(2, 0, 2) === 1 && T.movedIndex(0, 2, 0) === 1 && T.movedIndex(3, 0, 2) === 3);
}
// ---------- S2・S9 記録の画面：軽く押す → 上へ・開いている種目と中身が付いて動く ----------
{
  const { w } = boot({ src: FULL });
  seed(w, ITEMS());
  await openRecord(w);
  ok('S9 ★つまみは種目の数だけ・44px 以上・touch-action:none はつまみだけ', grips(w).length === 3 && grips(w).every((g) => /min-width:\s*44px/.test(g.style.cssText) && /min-height:\s*44px/.test(g.style.cssText) && /touch-action:\s*none/.test(g.style.cssText)) && [...R(w).querySelectorAll('[data-ei]')].every((r) => !/touch-action/.test(r.style.cssText)) && !/touch-action/.test(R(w).style.cssText));
  //   2026-11-25 オーナー：つまみは左端・全部✓は右端（畳んだ行も開いた種目の見出しも）
  ok('S10 ★畳んだ行はつまみが先頭・全部✓が末尾', [...R(w).querySelectorAll('.k-exline')].length >= 1 && [...R(w).querySelectorAll('.k-exline')].every((ln) => ln.firstElementChild.classList.contains('k-grip') && (!ln.querySelector('.k-allchk') || ln.lastElementChild.classList.contains('k-allchk'))));
  ok('S10 ★開いた種目の見出しもつまみが先頭', [...R(w).querySelectorAll('.k-exhead')].every((h) => h.parentElement.firstElementChild.classList.contains('k-grip')));
  ok('S10 ★行は縦に伸ばさない（align-items:center）・全部✓は小さいが44px', /\.k-exline\{[^}]*align-items:center/.test(FULL) && /\.k-allchk\{[^}]*min-width:44px;min-height:44px/.test(FULL));
  await tap(w, grip(w, 1));
  ok('S2 軽く押すと「上へ／下へ」が出る', !!R(w).querySelector('.k-gripud'));
  btn(R(w).querySelector('.k-gripud'), '上へ').click(); await settle();
  const D = draftOf(w);
  ok('S2 ★上へで下書きの順が入れ替わる（スクワット・ベンチプレス・レッグプレス）', JSON.stringify(names(w)) === '["スクワット","ベンチプレス","レッグプレス"]', JSON.stringify(names(w)));
  ok('S2 ★開いていた種目（ベンチプレス）が開いたまま・セット・✓・メモ・出所の印が付いて動く', D.openEi === 1 && D.items[1].sets[0].note === 'メモA' && D.items[1].sets[0].src === 'inferred' && D.items[1].sets[0].done === true);
  ok('S7 動かした結果を読み上げる1行', (R(w).querySelector('.k-movemsg') || {}).textContent === 'スクワットを1番目に動かしました');
  const up0 = R(w).querySelector('.k-gripud') && btn(R(w).querySelector('.k-gripud'), '上へ');
  ok('S7 一番上では「上へ」を押せない', !!up0 && up0.disabled === true);
  ok('S9 確認のダイアログ・alert が増えていない', w.confirms === 0 && w.alerts.length === 0);
}
// ---------- S3 休憩の帯は同じ種目に付いたまま ----------
{
  const { w } = boot({ src: FULL });
  const it = ITEMS(); it[0].sets[0].done = false;
  seed(w, it);
  await openRecord(w);
  R(w).querySelector('[data-ei="0"] button[aria-label="1セット目を実施済みにする"]').click(); await settle();
  const before = R(w).querySelector('.k-restbar');
  ok('S3 前提：✓で休憩の帯がベンチプレスのセットの下に出る', !!before && before.closest('[data-ei]') && before.closest('[data-ei]').getAttribute('data-ei') === '0');
  const g = grip(w, 0);
  g.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); await settle();
  const bar = R(w).querySelector('.k-restbar');
  ok('S7 ★矢印キーで1つ動く・フォーカスは動いた先のつまみ', JSON.stringify(names(w)) === '["スクワット","ベンチプレス","レッグプレス"]' && w.document.activeElement === grip(w, 1));
  ok('S3 ★休憩の帯は動いた後もベンチプレスのセットの下（添字を付け替える）', !!bar && bar.closest('[data-ei]') && bar.closest('[data-ei]').getAttribute('data-ei') === '1' && bar.closest('[data-ei]').textContent.includes('ベンチプレス'), bar && bar.closest('[data-ei]') && bar.closest('[data-ei]').getAttribute('data-ei'));
}
// ---------- S4 並べ替えてから保存 → payload の items が並べ替えた順 ----------
{
  const { w, sent } = boot({ src: FULL });
  seed(w, ITEMS());
  await openRecord(w);
  await tap(w, grip(w, 2)); btn(R(w).querySelector('.k-gripud'), '上へ').click(); await settle();
  ok('S4 動かした後も「上へ／下へ」はその種目に出たまま（続けて押せる）', !!R(w).querySelector('[data-ei="1"] .k-gripud, [data-ei="1"] + .k-gripud'));
  btn(R(w).querySelector('.k-gripud'), '上へ').click(); await settle();
  btn(R(w), '保存する').click(); await settle();
  const add = sent.filter((x) => x.body.action === 'k_addTraining');
  ok('S4 ★保存の items が並べ替えた順（レッグプレス・ベンチプレス・スクワット）＝Worker が ord 1〜3 を付ける順', add.length === 1 && JSON.stringify(add[0].body.items.map((x) => x.exercise)) === '["レッグプレス","ベンチプレス","スクワット"]', JSON.stringify(add.map((x) => x.body.items.map((y) => y.exercise))));
}
// ---------- S11 関門① 2：ドラッグの途中（pointerdown の後・pointerup の前）に保存 ----------
{
  const { w, sent } = boot({ src: FULL });
  seed(w, ITEMS());
  await openRecord(w);
  stubRows(w);
  const g = grip(w, 0);
  pe(w, g, 'pointerdown', 10); pe(w, g, 'pointermove', 150);
  btn(R(w), '保存する').click(); await settle();
  pe(w, g, 'pointerup', 150); await settle();
  const add = sent.filter((x) => x.body.action === 'k_addTraining');
  ok('S11 ★ドラッグの途中で保存：送る中身は元の順・指を離しても下書きの順は変わらない（食い違わない）', add.length === 1 && JSON.stringify(add[0].body.items.map((x) => x.exercise)) === '["ベンチプレス","スクワット","レッグプレス"]' && (!draftOf(w) || !draftOf(w).items.length || JSON.stringify(names(w)) === '["ベンチプレス","スクワット","レッグプレス"]'), JSON.stringify([add.map((x) => x.body.items.map((y) => y.exercise)), names(w)]));
}
{
  //   送信の返事が来ない間（送信中・結果待ち）：ドラッグは保存の入口で捨てられ、指を離しても・矢印キーでも配列は変わらない
  const { w, sent } = boot({ src: FULL });
  const f0 = w.fetch;
  w.fetch = (u, o) => (JSON.parse(o.body).action === 'k_addTraining' ? (sent.push({ url: String(u), body: JSON.parse(o.body) }), new Promise(() => {})) : f0(u, o));
  seed(w, ITEMS());
  await openRecord(w);
  stubRows(w);
  const g = grip(w, 0), row0 = R(w).querySelector('[data-ei="0"]');
  pe(w, g, 'pointerdown', 10); pe(w, g, 'pointermove', 150);
  ok('S11 前提：ドラッグ中は行が浮いている', /translateY/.test(row0.style.transform));
  btn(R(w), '保存する').click(); await settle();
  ok('S11 ★保存を押した時点でドラッグは捨てられる（行の浮きが戻る）', row0.style.transform === '');
  pe(w, g, 'pointerup', 150); await settle();
  const D = draftOf(w);
  ok('S11 ★送信中は指を離しても下書きの順・送った控え（pending）の順が変わらない', JSON.stringify(D.items.map((x) => x.exercise)) === '["ベンチプレス","スクワット","レッグプレス"]' && D.pending && JSON.stringify(D.pending.payload.items.map((x) => x.exercise)) === '["ベンチプレス","スクワット","レッグプレス"]', JSON.stringify(D.items.map((x) => x.exercise)));
  const g2 = R(w).querySelector('.k-grip[data-idx="0"]');
  if (g2) g2.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  await settle();
  ok('S11 ★送信中は矢印キーでも動かない', JSON.stringify(draftOf(w).items.map((x) => x.exercise)) === '["ベンチプレス","スクワット","レッグプレス"]');
}
// ---------- S12 関門② 1：ドラッグ中に画面を離れたら捨てる（リスナーも捕捉も残さない） ----------
function spyDoc(w) {
  //   document に付いているポインタのリスナーの数を数える（付けたら足し、外したら引く）
  const a0 = w.document.addEventListener.bind(w.document), r0 = w.document.removeEventListener.bind(w.document);
  const keys = new Map();
  w.document.addEventListener = (t, f, o) => { if (/^pointer/.test(t)) keys.set(t + '#' + (keys.size), f); return a0(t, f, o); };
  w.document.removeEventListener = (t, f, o) => { for (const [k, v] of keys) if (v === f && k.startsWith(t + '#')) { keys.delete(k); break; } return r0(t, f, o); };
  return () => keys.size;
}
function peId(w, el0, type, y) { const ev = new w.MouseEvent(type, { bubbles: true, cancelable: true, clientY: y, button: 0 }); Object.defineProperty(ev, 'pointerId', { value: 7 }); el0.dispatchEvent(ev); }
{
  const { w } = boot({ src: FULL });
  seed(w, ITEMS());
  await openRecord(w);
  const live = spyDoc(w);
  stubRows(w);
  const g = grip(w, 0);
  let released = 0; g.setPointerCapture = () => {}; g.releasePointerCapture = (id) => { if (id === 7) released++; };
  peId(w, g, 'pointerdown', 10); peId(w, g, 'pointermove', 150);
  ok('S12 前提：ドラッグ中は document にポインタのリスナーがある', live() > 0, String(live()));
  R(w).querySelector('.k-back').click(); await nav();
  ok('S12 ★戻ると document のポインタのリスナーが残らない・捕捉を外す', live() === 0 && released === 1, String([live(), released]));
  peId(w, g, 'pointerup', 150); await settle();
  ok('S12 ★戻った後の pointerup で配列も下書きも変わらない', JSON.stringify(names(w)) === '["ベンチプレス","スクワット","レッグプレス"]', JSON.stringify(names(w)));
}
{
  //   二重の守り：行が消えた（描き直し・画面を離れた）後の pointerup では確定しない
  const { w } = boot({ src: FULL });
  seed(w, ITEMS());
  await openRecord(w);
  stubRows(w);
  const g = grip(w, 0);
  pe(w, g, 'pointerdown', 10); pe(w, g, 'pointermove', 150);
  const row = R(w).querySelector('[data-ei="0"]'); row.parentNode.removeChild(row);
  pe(w, g, 'pointerup', 150); await settle();
  ok('S12 ★つまみが画面から消えた後の pointerup では並べ替えを確定しない', JSON.stringify(names(w)) === '["ベンチプレス","スクワット","レッグプレス"]', JSON.stringify(names(w)));
}
{
  //   別のお客様を開く（open）でも捨てる
  const { w } = boot({ src: FULL });
  seed(w, ITEMS());
  await openRecord(w);
  const live = spyDoc(w);
  stubRows(w);
  const g = grip(w, 0);
  pe(w, g, 'pointerdown', 10); pe(w, g, 'pointermove', 150);
  w.KarteUI.open('C2', '別の会員', 'summary'); await settle();
  const n1 = live();
  pe(w, g, 'pointerup', 150); await settle();
  ok('S12 ★別のお客様を開いた時点でリスナーが残らず、後の pointerup でも前のお客様の下書きの順が変わらない', n1 === 0 && JSON.stringify(names(w)) === '["ベンチプレス","スクワット","レッグプレス"]', String(n1));
}
// ---------- S13 関門② 2：上へ／下へを出している種目は、別の種目を動かしても付いたまま ----------
{
  const { w } = boot({ src: FULL });
  seed(w, ITEMS());
  await openRecord(w);
  await tap(w, grip(w, 2));
  ok('S13 前提：レッグプレス（3番目）に上へ／下へ', !!R(w).querySelector('.k-gripud'));
  grip(w, 0).dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); await settle();
  const ud = R(w).querySelector('.k-gripud');
  const owner = ud && (ud.closest('[data-ei]') || ud.previousElementSibling);
  ok('S13 ★別の種目（ベンチプレス）を動かしても、上へ／下へはレッグプレスに付いたまま', !!owner && owner.getAttribute('data-ei') === '2' && owner.textContent.includes('レッグプレス'), owner && owner.getAttribute('data-ei'));
}
// ---------- S10 ドラッグ（行の位置を身代わり） ----------
{
  const { w } = boot({ src: FULL });
  seed(w, ITEMS());
  await openRecord(w);
  stubRows(w);
  let g = grip(w, 0);
  pe(w, g, 'pointerdown', 10); pe(w, g, 'pointermove', 150); pe(w, g, 'pointerup', 150); await settle();
  ok('S10 ★つまみを持って3番目の下まで動かすと順が入れ替わる', JSON.stringify(names(w)) === '["スクワット","レッグプレス","ベンチプレス"]', JSON.stringify(names(w)));
  stubRows(w); g = grip(w, 0);
  pe(w, g, 'pointerdown', 10); pe(w, g, 'pointermove', 14); pe(w, g, 'pointerup', 14); await settle();
  ok('S10 ★6px 未満なら動かさず「上へ／下へ」を出す', JSON.stringify(names(w)) === '["スクワット","レッグプレス","ベンチプレス"]' && !!R(w).querySelector('.k-gripud'));
  stubRows(w); g = grip(w, 0);
  pe(w, g, 'pointerdown', 10); pe(w, g, 'pointermove', 150); pe(w, g, 'pointercancel', 150); await settle();
  ok('S10 取り消し（pointercancel）なら元の順', JSON.stringify(names(w)) === '["スクワット","レッグプレス","ベンチプレス"]');
}
// ---------- S8 送った結果待ち・種目が1つ ----------
{
  const { w } = boot({ src: FULL });
  seed(w, ITEMS(), { pending: { payload: { customerId: 'C1', sessionDate: TODAY, items: [{ exercise: 'ベンチプレス', sets: [{ weight: 50, reps: 10 }] }] }, reqId: 'kreq1' } });
  await openRecord(w);
  ok('S8 ★送った結果待ちの画面につまみが無い', grips(w).length === 0 && R(w).textContent.includes('前回の保存の結果を確かめられませんでした'));
  const { w: w2 } = boot({ src: FULL });
  seed(w2, [ITEMS()[0]]);
  await openRecord(w2);
  ok('S8 種目が1つならつまみが無い', grips(w2).length === 0);
}
// ---------- S6 AI の確認画面：並べ替え → 色はそのまま・一時保存の順・下書きの順 ----------
{
  const { w } = boot({ src: FULL });
  await toReview(w);
  const before = cards(w).map((c) => [c.querySelector('.k-rvname').value, chipsOf(c).join(',')]);
  const g0 = cards(w)[0].querySelector('.k-grip');
  await tap(w, g0);
  btn(cards(w)[0].querySelector('.k-gripud'), '下へ').click(); await settle();
  const after = cards(w).map((c) => [c.querySelector('.k-rvname').value, chipsOf(c).join(',')]);
  ok('S6 ★下へで順が入れ替わり、色（チップ）は種目ごとに同じ', after[0][0] === before[1][0] && after[1][0] === before[0][0] && after[1][1] === before[0][1] && after[0][1] === before[1][1], JSON.stringify([before, after]));
  const sv = JSON.parse(w.localStorage.getItem('karte_ai_review_v1:T1:C1') || 'null');
  ok('S6 ★並べ替えた直後に一時保存の配列も同じ順（設計51・関門① 3）', !!sv && JSON.stringify(sv.rv.exercises.map((e) => e.name)) === JSON.stringify(after.map((x) => x[0])), JSON.stringify(sv && sv.rv.exercises.map((e) => e.name)));
  put(w).click(); await nav();
  ok('S6 ★記録の画面に入れた下書きも並べ替えた順', JSON.stringify(names(w).slice(0, 2)) === JSON.stringify([after[0][0], after[1][0]]), JSON.stringify(names(w)));
}
{
  //   一時保存から戻しても同じ順
  const { w } = boot({ src: FULL });
  await toReview(w);
  const g0 = cards(w)[0].querySelector('.k-grip');
  g0.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); await settle();
  const order = cards(w).map((c) => c.querySelector('.k-rvname').value);
  await openImport(w);
  const bd = R(w).querySelector('.k-airresume'); if (bd) { bd.querySelector('.k-airgo').click(); await settle(); }
  ok('S6 ★一時保存から続けても並べ替えた順', !!bd && JSON.stringify(cards(w).map((c) => c.querySelector('.k-rvname').value)) === JSON.stringify(order));
}

console.log(`liff-karte-reorder: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
