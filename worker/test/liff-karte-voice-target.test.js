// 音声のセッションログ（AI の下書き v2）を記録の画面に入れたときの行き先：本番の liff/karte.js を jsdom で動かし、入口から click で通す・2026-11-26
//   実行: node worker/test/liff-karte-voice-target.test.js
//
//   ★オーナー報告（2026-11-26・本番 2026-11-26c）：「手動で入れる」を選んでから音声ログを足すと、その日のログ全体ではなく種目1に入るように見える
//   ★この検査が守ること（4つの始まり方で同じ）
//     ・日の単位の文章（今日の流れ・状態・指導・ヒアリング・次回やること・種目のメモ）＝その日の社内メモの末尾。既存の社内メモは消さない
//     ・お客様に見える欄（チェックしたときだけ）＝お客様へ・次回までにの末尾。既存は消さない
//     ・種目とセット＝後ろに足す（いまある種目＝種目1 には書き足さない：名前・セット・セットのメモ・✓がそのまま）
//     ・取り込みの画面の案内は「種目 1」と書かない（「1種目」）・行き先を言う／入れた後の1行で社内メモに入れたことを言う
//   ★身代わりは fetch（Worker）・LINE の SDK だけ。Worker の応答は worker/src/routes/karte-ai-v2.js の draft（v:2）の形。値は架空

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
async function nav() { await new Promise((r) => setTimeout(r, 40)); await settle(); }
const b64u = (s) => Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (ageS) => b64u(JSON.stringify({ alg: 'ES256' })) + '.' + b64u(JSON.stringify({ iss: 'https://access.line.me', sub: 'U_TEST', iat: Math.floor(Date.now() / 1000) - ageS, exp: Math.floor(Date.now() / 1000) + 3600 })) + '.sig';
const TODAY = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);

const TRANSCRIPT = 'ベンチプレス 50キロで10回\nスクワット 自重で15回\n左右差を見ておく\n次回は肩まわり';
const DRAFT = () => ({
  v: 2, effort: 'medium',
  summary: ['架空の流れ：胸から脚へ'],
  exercises: [
    { name: 'ベンチプレス', heard: 'ベンチプレス', note: '架空の種目メモ：左右差を確認する', sets: [{ status: 'match', w: 50, r: 10, bw: false, evidence: 'ベンチプレス 50キロで10回', unsure: '', note: '' }] },
    { name: 'スクワット', heard: 'スクワット', note: '', sets: [{ status: 'match', w: null, r: 15, bw: true, evidence: 'スクワット 自重で15回', unsure: '', note: '' }] }],
  condition: ['架空の状態'], caution: [], coaching: ['架空の指導'], hearing: ['架空のヒアリング'],
  next_actions: ['架空の次回：足の倒れ方を確認する'],
  member_message: '【今日の内容】架空のお客様へ', member_todo: ['架空の宿題'], unclear: [],
});
const DAY_LINES = ['今日の流れ：架空の流れ：胸から脚へ', 'ベンチプレス：架空の種目メモ：左右差を確認する', '状態：架空の状態', '架空の指導', 'ヒアリング：架空のヒアリング', '次回やること：架空の次回：足の倒れ方を確認する'];
const AI_TEXTS = ['架空の流れ', '架空の種目メモ', '架空の状態', '架空の指導', '架空のヒアリング', '架空の次回', '架空のお客様へ', '架空の宿題'];

function boot() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'https://reservation.tokowaka-gym.com/liff/', pretendToBeVisual: true });
  const w = dom.window;
  w.idToken = jwt(30);
  w.EDGE_URL = 'https://edge.example';
  w.state = { trainerId: 'T1', _isOwner: false, _allTrainers: [{ id: 'T1', name: '一郎' }] };
  w.alerts = []; w.alert = (m) => w.alerts.push(String(m));
  w.confirm = () => true;
  w.__karteReload = () => {};
  ['log', 'info', 'warn', 'error', 'debug'].forEach((k) => { w.console[k] = () => {}; });
  w.liff = { getIDToken: () => w.idToken, logout: () => {} };
  w.fetch = async (url, opt) => {
    const body = JSON.parse(opt.body);
    let r;
    if (body.action === 'k_training') r = { success: true, karteSchema: 33, aiDraft: true, aiConsent: 'agreed', sessions: [], best: [] };
    else if (body.action === 'k_exercises') r = { success: true, karteSchema: 33, exercises: [{ name: 'ベンチプレス', part: 'chest' }], truncated: false };
    else if (body.action === 'k_aiDraft') r = { success: true, draft: (w.draftFn || DRAFT)(), model: 'x', build: 'x' };
    else r = { success: true };
    return { json: async () => JSON.parse(JSON.stringify(r)) };
  };
  w.eval(SRC);
  return w;
}
const R = (w) => w.document.getElementById('karteRoot');
const btn = (root, t) => [...root.querySelectorAll('button')].find((x) => x.textContent.indexOf(t) === 0);
const DKEY = 'karte_tr_draft_v1:T1:C1';
const draftOf = (w) => JSON.parse(w.localStorage.getItem(DKEY) || 'null');
function seed(w, items, extra) { w.localStorage.setItem(DKEY, JSON.stringify(Object.assign({ v: 1, tid: 'T1', cid: 'C1', sessionDate: TODAY, items, reqId: 'kreq1', pending: null, at: Date.now(), openEi: 0 }, extra || {}))); }
async function openRecord(w) {
  w.KarteUI.open('C1', '会員', 'training'); await settle();
  const b0 = btn(R(w), '記録の入力（途中）を開く') || btn(R(w), '＋ 今日の記録');
  if (b0) { b0.click(); await settle(); }
}
//   取り込みの画面 → 貼る → AI → （お客様の欄をチェック）→ 記録の画面に入れる →（種目があれば）後ろに足す
async function voiceAndPlace(w, entry, o = {}) {
  entry.click(); await settle();
  const addNote = R(w).querySelector('.k-addnote');
  const ta = R(w).querySelector('textarea[aria-label="メモを貼る"]'); ta.value = TRANSCRIPT; ta.dispatchEvent(new w.Event('input', { bubbles: true }));
  btn(R(w), 'AIで振り分ける').click(); await settle();
  const head = [...R(w).querySelectorAll('.k-rvfields > div')].map((x) => x.textContent)[0] || '';
  if (o.member) { const cb = R(w).querySelector('input.k-rvmemon'); cb.checked = true; cb.dispatchEvent(new w.Event('change')); await settle(); }
  R(w).querySelector('button.k-rvput').click(); await settle();
  const ask = btn(R(w), 'いまの入力の後ろに足す');
  if (ask) { ask.click(); }
  await nav();
  return { addNote: addNote ? addNote.textContent : null, head, asked: !!ask };
}
function checkPlaced(label, w, x, exp) {
  const d = draftOf(w);
  ok(label + '：種目は後ろに足す（いまある種目のあとに AI の種目）', !!d && JSON.stringify(d.items.map((i) => i.exercise)) === JSON.stringify(exp.names), d && JSON.stringify(d.items.map((i) => i.exercise)));
  ok(label + '：★いまある種目（種目1〜）は名前・セット・セットのメモ・✓がそのまま（AI の文章を書き足さない）', JSON.stringify(d.items.slice(0, exp.before.length)) === JSON.stringify(exp.before), JSON.stringify(d.items.slice(0, exp.before.length)));
  ok(label + '：★どの種目のセットにも AI の文章が入っていない', !JSON.stringify(d.items).match(/架空/));
  const add = d.items.slice(exp.before.length);
  ok(label + '：AI の種目のセットはその種目に入る（ベンチプレス 50×10・スクワット 自重×15・✓は外す）', add.length === 2 && add[0].sets.length === 1 && add[0].sets[0].w === '50' && add[0].sets[0].r === '10' && add[0].sets[0].done === false && add[1].sets[0].w === '' && add[1].sets[0].r === '15', JSON.stringify(add));
  const want = (exp.memo0 ? [exp.memo0] : []).concat(DAY_LINES).join('\n');
  ok(label + '：★日の単位の文章は、その日の社内メモの末尾（既存は消さない）', d.memo === want, JSON.stringify(d.memo));
  const ta = R(w).querySelector('textarea[aria-label="社内メモ"]');
  ok(label + '：記録の画面の「社内メモ」の欄にそのまま出ている', !!ta && ta.value === want);
  const ex0 = R(w).querySelector('[data-ei="0"]');
  ok(label + '：★記録の画面の種目1の欄に AI の文章が出ていない', !!ex0 && !AI_TEXTS.some((t) => (ex0.textContent + [...ex0.querySelectorAll('input,textarea')].map((e) => e.value).join('')).includes(t)));
  if (exp.member) {
    const m = d.member || {};
    ok(label + '：お客様に見える欄（チェックしたとき）はお客様へ・次回までにの末尾（既存は消さない）', m.message === (exp.mem0 ? exp.mem0 + '\n' : '') + '【今日の内容】架空のお客様へ' && JSON.stringify(m.todo) === JSON.stringify(exp.todo), JSON.stringify(m));
  } else {
    ok(label + '：お客様に見える欄はチェックしなければ入らない', !JSON.stringify(d.member || {}).includes('架空'));
  }
  const msg = R(w).querySelector('.k-trform > .k-sub');
  ok(label + '：入れた後の1行で「その日の社内メモ（画面の下）の末尾に入れました」と言う', !!msg && msg.textContent.includes('文章 ' + DAY_LINES.length + '行は、その日の社内メモ（画面の下）の末尾に入れました'), msg && msg.textContent);
  ok(label + '：確認画面の文章の欄の見出しは「その日の社内メモに入れる文章」', x.head.indexOf('その日の社内メモに入れる文章') === 0, x.head);
  ok(label + '：保存の警告は出ていない', w.alerts.length === 0, w.alerts.join('/'));
}

// ---- V1 ★報告の経路：「手動で入れる」→ 種目を1つ選んで足す → ［音声でセッションログを残す］→ AI → 記録の画面に入れる ----
{
  const w = boot();
  await openRecord(w);
  R(w).querySelector('button.k-manualgo').click(); await settle();
  const q = R(w).querySelector('input[aria-label="種目を探す"]'); q.value = 'ラットプル'; q.dispatchEvent(new w.Event('input', { bubbles: true })); await settle();
  const sg = [...R(w).querySelectorAll('.k-suggest button')].find((b) => b.textContent.indexOf('ラットプルダウン') === 0);
  ok('V1 手動：候補に「ラットプルダウン」', !!sg);
  sg.click(); await settle();
  w.document.querySelector('.k-picker-go').click(); await settle();
  const before = draftOf(w).items;
  ok('V1 手動：種目1＝ラットプルダウン（空のセット1つ）', before.length === 1 && before[0].exercise === 'ラットプルダウン');
  const vb = R(w).querySelector('button.k-voicelog');
  ok('V1 手動：上に［音声でセッションログを残す］', !!vb);
  const x = await voiceAndPlace(w, vb);
  ok('V1 ★取り込みの画面の案内は「種目 1」と書かない（「1種目」）・いまある種目には書き足さないと言う', !!x.addNote && !/種目\s*\d/.test(x.addNote) && x.addNote.indexOf('いまの記録（1種目）は消さずに、後ろに足します。いまある種目には書き足しません') === 0, x.addNote);
  ok('V1 種目があるので「後ろに足す」を聞く', x.asked);
  checkPlaced('V1', w, x, { names: ['ラットプルダウン', 'ベンチプレス', 'スクワット'], before });
}
// ---- V2 「手動で入れる」を選ばずに始める（0件から［メモ・音声から］）＋お客様に見える欄をチェック ----
{
  const w = boot();
  await openRecord(w);
  const x = await voiceAndPlace(w, R(w).querySelector('.k-start button.k-impgo'), { member: true });
  ok('V2 0件：いまの記録が無いので案内は出ない・聞かない', x.addNote === null && !x.asked);
  checkPlaced('V2', w, x, { names: ['ベンチプレス', 'スクワット'], before: [], member: true, todo: ['架空の宿題', '', ''] });
}
// ---- V3 種目・セット（✓とセットのメモ）・社内メモ・お客様へが既にある ----
{
  const w = boot();
  const before = [{ exercise: 'デッドリフト', sets: [{ w: 80, r: 5, done: true, note: '既存のセットのメモ' }, { w: 80, r: 5, done: false }] }, { exercise: 'プランク', sets: [], doneOnly: true }];
  seed(w, before, { memo: '既存の社内メモ', member: { message: '既存のお客様へ', todo: ['既存の宿題', '', ''], tags: [] } });
  await openRecord(w);
  const x = await voiceAndPlace(w, R(w).querySelector('.k-start button.k-voicelog'), { member: true });
  ok('V3 案内：「いまの記録（2種目・社内メモ・お客様に見える欄）は消さずに、後ろに足します。」', x.addNote && x.addNote.indexOf('いまの記録（2種目・社内メモ・お客様に見える欄）は消さずに、後ろに足します。') === 0, x.addNote);
  checkPlaced('V3', w, x, { names: ['デッドリフト', 'プランク', 'ベンチプレス', 'スクワット'], before, memo0: '既存の社内メモ', member: true, mem0: '既存のお客様へ', todo: ['既存の宿題', '架空の宿題', ''] });
}
// ---- V4 種目はあるがセットが空（種目を選んだだけ・数字を入れていない） ----
{
  const w = boot();
  const before = [{ exercise: 'ラットプルダウン', sets: [] }];
  seed(w, before);
  await openRecord(w);
  const x = await voiceAndPlace(w, R(w).querySelector('.k-start button.k-voicelog'));
  ok('V4 案内：「いまの記録（1種目）…」', x.addNote && x.addNote.indexOf('いまの記録（1種目）は消さずに') === 0, x.addNote);
  checkPlaced('V4', w, x, { names: ['ラットプルダウン', 'ベンチプレス', 'スクワット'], before });
}

// ==== 2026-11-26 16:44 オーナー実機：AI の確認画面で［記録の画面に入れる］を押しても進まない ====
//   ★入れられない理由（err）は画面の上（out の先頭）だけに出ていて、下の帯で押した人には見えなかった。社内メモの2,000字超えは押してから初めて分かった
const LONG = TRANSCRIPT + '\n' + 'あ'.repeat(260);   // 一時保存のしるしを作る長さ（AIR_HASH_MIN 以上）
const LONG_COACH = () => Object.assign(DRAFT(), { coaching: Array.from({ length: 12 }, (_, i) => '架空の長い指導' + i + 'い'.repeat(180)) });
const barOf = (w) => R(w).querySelector('.k-savebar');
const before = (a, b) => !!(a && b && (a.compareDocumentPosition(b) & 4));
async function toReview(w, entrySel, text) {
  R(w).querySelector(entrySel).click(); await settle();
  const ta = R(w).querySelector('textarea[aria-label="メモを貼る"]'); ta.value = text || LONG; ta.dispatchEvent(new w.Event('input', { bubbles: true }));
  btn(R(w), 'AIで振り分ける').click(); await nav();
}
// ---- V5 ★長い文字起こし：社内メモが2,000字を超える＝押す前に帯（ボタンの上）に理由・押せない → 文章を短くすると押せて入る ----
{
  const w = boot(); w.draftFn = LONG_COACH;
  await openRecord(w);
  await toReview(w, '.k-start button.k-impgo');
  const go = R(w).querySelector('button.k-rvput'), why = R(w).querySelector('.k-rvwhy');
  ok('V5 ★超えるなら押せない', !!go && go.disabled === true);
  ok('V5 ★理由は帯の中・ボタンの上に「社内メモが2000字を超えます（この下書き n字）」', !!why && barOf(w).contains(why) && before(why, go) && /^社内メモが2000字を超えます（この下書き \d+字）/.test(why.textContent), why && why.textContent);
  const f = R(w).querySelector('.k-rvfield[data-field="coaching"]'); f.value = '架空の短い指導'; f.dispatchEvent(new w.Event('input', { bubbles: true })); await settle();
  const go2 = R(w).querySelector('button.k-rvput');
  ok('V5 短くすると押せる・理由はボタンの下の案内に戻る', go2.disabled === false && before(go2, R(w).querySelector('.k-rvwhy')) && !R(w).querySelector('.k-rvwhy').textContent.includes('超えます'));
  go2.click(); await nav();
  ok('V5 押すと記録の画面に戻り、短くした文章が社内メモに入る', R(w).querySelector('.k-entrytitle').textContent === '今日の記録を入れる' && (draftOf(w).memo || '').includes('架空の短い指導') && (draftOf(w).memo || '').length <= 2000);
}
// ---- V6 いまの社内メモと足して超える＝内訳を出す ----
{
  const w = boot();
  seed(w, [{ exercise: 'ラットプルダウン', sets: [] }], { memo: 'う'.repeat(1950) });
  await openRecord(w);
  await toReview(w, '.k-start button.k-voicelog');
  const why = R(w).querySelector('.k-rvwhy');
  ok('V6 ★「いまの社内メモ 1950字＋この下書き n字＝m字」・押せない', R(w).querySelector('button.k-rvput').disabled === true && !!why && /いまの社内メモ 1950字＋この下書き \d+字＝\d+字/.test(why.textContent), why && why.textContent);
}
// ---- V7 ★押した後に入れられなかった理由は、押したボタンのすぐ上（帯の中・role=alert）に出す ----
{
  const w = boot();
  await openRecord(w);
  await toReview(w, '.k-start button.k-impgo');
  const T = draftOf(w) || { v: 1, tid: 'T1', cid: 'C1', sessionDate: TODAY, items: [], reqId: 'kreq1', pending: null, at: Date.now() };
  T.memoPending = { date: TODAY, body: '架空', tag: '', reqId: 'm1', withTraining: false, memberSaved: false };
  w.localStorage.setItem(DKEY, JSON.stringify(T));   // 確認の途中で別の画面の送信の結果待ちが残った（押してから初めて分かる理由）
  R(w).querySelector('button.k-rvput').click(); await nav();
  const pe = R(w).querySelector('.k-rvperr'), go = R(w).querySelector('button.k-rvput');
  ok('V7 ★理由が帯の中・ボタンの上に出る（role=alert）', !!pe && barOf(w).contains(pe) && pe.getAttribute('role') === 'alert' && before(pe, go) && pe.textContent.indexOf('前回の保存の結果を確かめるまで取り込めません') === 0, pe && pe.textContent);
  ok('V7 確認画面のまま（下書きは変えない）', R(w).querySelector('.k-entrytitle').textContent === 'メモから取り込む' && !!R(w).querySelector('.k-rvex'));
  delete T.memoPending; T.items = [{ exercise: 'ラットプルダウン', sets: [] }]; w.localStorage.setItem(DKEY, JSON.stringify(T));
  R(w).querySelector('button.k-rvput').click(); await nav();
  ok('V7 原因が解けたら押せて「後ろに足す」へ・★前の理由は残さない', !!btn(R(w), 'いまの入力の後ろに足す') && !R(w).textContent.includes('前回の保存の結果を確かめるまで'));
  btn(R(w), 'いまの入力の後ろに足す').click(); await nav();
  ok('V7 入る', R(w).querySelector('.k-entrytitle').textContent === '今日の記録を入れる' && draftOf(w).items.length === 3);
}
// ---- V8 ★一時保存から復元（記録の画面に戻って開き直す →「続ける」）→ 押すと入る（種目なし／手動の種目あり） ----
for (const pre of [false, true]) {
  const label = 'V8 ' + (pre ? '種目あり' : '種目なし');
  const w = boot();
  const sc = []; w.Element.prototype.scrollIntoView = function () { sc.push(this); };
  if (pre) seed(w, [{ exercise: 'ラットプルダウン', sets: [{ w: '', r: '', done: false }] }]);
  await openRecord(w);
  const sel = pre ? '.k-start button.k-voicelog' : '.k-start button.k-impgo';
  await toReview(w, sel);
  await openRecord(w);
  R(w).querySelector(sel).click(); await nav();
  R(w).querySelector('button.k-airgo').click(); await nav();
  ok(label + '：復元した確認画面（前回確認したときの判定です）・本文の欄は空', !!R(w).querySelector('.k-airrestored') && R(w).querySelector('textarea[aria-label="メモを貼る"]').value === '');
  ok(label + '：押せる', R(w).querySelector('button.k-rvput').disabled === false);
  R(w).querySelector('button.k-rvput').click(); await nav();
  if (pre) {
    const ak = R(w).querySelector('.k-impask');
    ok(label + '：★「後ろに足す」のカードを見える所へ動かす', !!ak && sc.includes(ak));
    btn(R(w), 'いまの入力の後ろに足す').click(); await nav();
  }
  ok(label + '：記録の画面に戻り、種目と社内メモが入る・一時保存は消える', R(w).querySelector('.k-entrytitle').textContent === '今日の記録を入れる' && JSON.stringify(draftOf(w).items.map((i) => i.exercise)) === JSON.stringify((pre ? ['ラットプルダウン'] : []).concat(['ベンチプレス', 'スクワット'])) && draftOf(w).memo === DAY_LINES.join('\n') && !Object.keys(w.localStorage).some((k) => k.indexOf('karte_ai_review_v1:') === 0));
}

// ---- V9 （16:48 のスクショ）有効なセットが0の種目（全部「?」）があっても止めない：設計50 §5-10 の2どおり数字なしの種目（doneOnly:false）として入り、種目のメモは社内メモへ。復元の有無の両方 ----
for (const restore of [false, true]) {
  const label = 'V9 ' + (restore ? '復元' : '復元なし');
  const w = boot();
  w.draftFn = () => { const d = DRAFT(); d.exercises.unshift({ name: 'デッドバグ', heard: 'デッドバグ', note: '架空の体幹のメモ', sets: [{ status: 'inferred', w: null, r: 6, bw: false, evidence: 'デッドバグ6回', unsure: '', note: '' }] }); return d; };
  seed(w, [{ exercise: 'ラットプルダウン', sets: [] }]);
  await openRecord(w);
  await toReview(w, '.k-start button.k-voicelog');
  if (restore) { await openRecord(w); R(w).querySelector('.k-start button.k-voicelog').click(); await nav(); R(w).querySelector('button.k-airgo').click(); await nav(); }
  const c0 = R(w).querySelector('.k-rvex');
  ok(label + '：1つ目は「?×6」だけ（入れない）・押せる', c0.querySelector('.k-rvline').value === '?×6' && [...c0.querySelectorAll('.k-rvchip')].every((c) => c.dataset.st === 'skip') && R(w).querySelector('button.k-rvput').disabled === false);
  R(w).querySelector('button.k-rvput').click(); await nav();
  btn(R(w), 'いまの入力の後ろに足す').click(); await nav();
  const d = draftOf(w);
  ok(label + '：★記録の画面に入る・デッドバグは数字なしの種目・メモは社内メモ', R(w).querySelector('.k-entrytitle').textContent === '今日の記録を入れる' && JSON.stringify(d.items[1]) === JSON.stringify({ exercise: 'デッドバグ', sets: [], fromMemo: true, doneOnly: false }) && d.memo.includes('デッドバグ：架空の体幹のメモ'), JSON.stringify(d.items[1]));
}

console.log(`liff-karte-voice-target: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
