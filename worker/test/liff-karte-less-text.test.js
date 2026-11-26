// 説明の文を削った画面（設計65・2026-11-26 オーナー「挙動の説明は不要・注意は項目ごとに?」）：本番の liff/karte.js を jsdom で動かし、入口から click で通す
//   実行: node worker/test/liff-karte-less-text.test.js
//   ★この検査が守ること
//     ・挙動の説明（後ろに足します・✓の無いセットは保存されません・何も送りません・押すと…）が画面に出ない
//     ・? はタップ領域 44px・押すと説明が開き、もう一度で閉じる（閉じている間は DOM に無い）
//     ・同意：AI のボタンの直下に「外部のAI（Anthropic）へ送ります」の1行が必ずあり、? に伏せ方・保存しないことの全文
//     ・健康（I55）：取り込みの画面に1行・カードを並べても一覧の上に1回だけ
//     ・取り込んだ直後は「n種目を入れました」の短い通知・数秒で消える・タップでも消える
//     ・押せない理由はボタンの上
//   ★身代わりは fetch（Worker）・LINE の SDK だけ。値は架空

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
    if (body.action === 'k_training') r = { success: true, karteSchema: 33, aiDraft: !w.aiOff, aiConsent: w.consent || 'agreed', sessions: [], best: [] };
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
  //   設計65（2026-11-26 オーナー「一枚目も説明不要」）：入れた後は「n種目を入れました」の短い通知だけ（行き先の説明は出さない＝社内メモの欄に出ていることは上で確かめた）
  const msg = R(w).querySelector('.k-trform > .k-toast');
  ok(label + '：入れた後は短い通知「2種目を入れました」だけ（行き先の説明なし）', !!msg && msg.textContent === '2種目を入れました' && !R(w).textContent.includes('末尾に入れました'), msg && msg.textContent);
  ok(label + '：確認画面の文章の欄の見出しは「その日の社内メモ」', x.head === 'その日の社内メモ', x.head);
  ok(label + '：保存の警告は出ていない', w.alerts.length === 0, w.alerts.join('/'));
}


const qOpen = (box) => { const q = box.querySelector('.k-q'); q.click(); return { q, body: box.querySelector('.k-qbody') }; };
const BAD = ['後ろに足します', '書き足しません', '保存されません', 'この画面からは何も送りません', '紙のメモを打つか', '押すと、上の内容', 'まだ保存', '重ねて入れ', '末尾に入れました', '保存した時点で'];
const noBad = (w) => BAD.filter((t) => R(w).textContent.includes(t));

// ---- L1 取り込みの画面（AI あり・同意あり・いまの記録に1種目）：案内の帯が無い・? が開閉する・同意と健康の1行 ----
{
  const w = boot();
  seed(w, [{ exercise: 'ラットプルダウン', sets: [] }], { memo: '架空の社内メモ' });
  await openRecord(w);
  R(w).querySelector('.k-start button.k-voicelog').click(); await settle();
  ok('L1-1 ★案内の帯（k-addnote）が無い・挙動の説明の文が無い', !R(w).querySelector('.k-addnote') && noBad(w).length === 0, JSON.stringify(noBad(w)));
  const qs = [...R(w).querySelectorAll('.k-q')];
  const cs = qs.map((q) => w.getComputedStyle(q));
  ok('L1-2 ★? はタップ領域 44px（幅・高さ）・説明の名前つき・閉じている', qs.length >= 2 && cs.every((c) => c.width === '44px' && c.height === '44px') && qs.every((q) => q.getAttribute('aria-label') === '説明' && q.getAttribute('aria-expanded') === 'false') && !R(w).querySelector('.k-qbody'), JSON.stringify(cs.map((c) => [c.width, c.height])));
  const help = R(w).querySelector('.k-imphelp');
  ok('L1-3 入力欄の見出し「メモ・文字起こし」に ? が付く', !!help && help.querySelector('.k-imphead').textContent === 'メモ・文字起こし');
  const o = qOpen(help);
  ok('L1-4 ★? を押すと直下に説明（入力の仕方・端末の中だけ・音声は使えない）', o.q.getAttribute('aria-expanded') === 'true' && !!o.body && o.body.textContent.includes('例：') && o.body.textContent.includes('端末の中だけで読み、どこにも送りません') && o.body.textContent.includes('音声のファイルは使えません'));
  o.q.click();
  ok('L1-5 ★もう一度押すと閉じる（DOM から消える）・ダイアログなし', o.q.getAttribute('aria-expanded') === 'false' && !help.querySelector('.k-qbody') && w.alerts.length === 0);
  const hs = [...R(w).querySelectorAll('.k-note-hint')].filter((x) => x.textContent.includes('痛み・診断・服薬'));
  const ta = R(w).querySelector('textarea[aria-label="メモを貼る"]');
  ok('L1-6 ★健康の1行は入力欄の真下に1つ（I55・MODEL の「入力欄の真下」）', hs.length === 1 && ta.nextElementSibling === hs[0], hs.length);
  const ai = btn(R(w), 'AIで振り分ける'), ex = R(w).querySelector('.k-aiexplain');
  ok('L1-7 ★同意：AI のボタンの直下に「外部のAI（Anthropic）へ送ります」の1行（? を開かなくても見える）', !!ai && !!ex && ai.nextElementSibling === ex && ex.querySelector('.k-aisendline').textContent === '外部のAI（Anthropic）へ送ります' && !ex.querySelector('.k-qbody'));
  const o2 = qOpen(ex);
  ok('L1-8 ★? に伏せ方・残ることがあるもの・保存しない・端末に当日だけ残ることの全文', !!o2.body && ['外部（Anthropic）へ送ります', '機械的に伏せます', '残ることがあります', '送った文字起こしは保存しません', '当日中だけ残ります', '同じ端末を使う人は読めます'].every((t) => o2.body.textContent.includes(t)));
}
// ---- L2 読み取る：決定待ちのカードを並べても健康の1行は一覧の上に1回・押せない理由はボタンの上 ----
{
  const w = boot();
  await openRecord(w);
  R(w).querySelector('.k-start button.k-impgo').click(); await settle();
  const ta = R(w).querySelector('textarea[aria-label="メモを貼る"]'); ta.value = '架空のなにか\n50×10\nふしぎな種目\n30×10\nもう一つの架空\n20×10'; ta.dispatchEvent(new w.Event('input', { bubbles: true }));
  btn(R(w), '読み取る').click(); await settle();
  const cards = [...R(w).querySelectorAll('.k-impcard')];
  const hl = R(w).querySelectorAll('.k-imphealth');
  ok('L2-1 ★カードが2枚以上でも健康の1行は1つ・カードの中には繰り返さない', cards.length >= 2 && hl.length === 1 && hl[0].textContent.includes('痛み・診断・服薬') && cards.every((c) => !c.textContent.includes('痛み・診断・服薬')) && !!(hl[0].compareDocumentPosition(cards[0]) & 4), cards.length + '/' + hl.length);
  const o = qOpen(hl[0]);
  ok('L2-2 健康の1行の ? に「社内メモはお客様には見えません」', !!o.body && o.body.textContent.includes('社内メモはお客様には見えません'));
  const go = btn(R(w), '記録の画面に入れる'), left = R(w).querySelector('.k-impleft');
  ok('L2-3 ★押せない理由はボタンの上（全部選ぶと押せます（n件のこり））・「何も送りません」は無い', !!go && go.disabled && !!left && !!(left.compareDocumentPosition(go) & 4) && /^全部選ぶと押せます（\d+件のこり）$/.test(left.textContent) && noBad(w).length === 0, left && left.textContent);
  cards.forEach(() => { const b = [...R(w).querySelectorAll('.k-impcard')].map((c) => btn(c, '捨てる')).find(Boolean); if (b) b.click(); });
  await settle();
  ok('L2-4 全部選ぶと押せる・理由の行は消える', btn(R(w), '記録の画面に入れる').disabled === false && !R(w).querySelector('.k-impleft'));
}
// ---- L3 AI の確認画面：押せるときの説明が無い・ボタンは「記録の画面に入れる」・書き方は ? ・お客様の欄の説明なし ----
let w3;
{
  const w = boot(); w3 = w;
  seed(w, [{ exercise: 'ラットプルダウン', sets: [] }]);
  await openRecord(w);
  R(w).querySelector('.k-start button.k-voicelog').click(); await settle();
  const ta = R(w).querySelector('textarea[aria-label="メモを貼る"]'); ta.value = TRANSCRIPT; ta.dispatchEvent(new w.Event('input', { bubbles: true }));
  btn(R(w), 'AIで振り分ける').click(); await nav();
  const go = R(w).querySelector('button.k-rvput');
  ok('L3-1 ★ボタンは「記録の画面に入れる」だけ・押せる・説明の行（k-rvwhy）を出さない', !!go && go.textContent === '記録の画面に入れる' && go.disabled === false && !R(w).querySelector('.k-rvwhy') && noBad(w).length === 0, JSON.stringify(noBad(w)));
  const how = R(w).querySelector('.k-rvhow');
  ok('L3-2 書き方は「トレーニング」の ? の中（開くまで出ない）', !!how && !R(w).textContent.includes('自重×10') && qOpen(how).body.textContent.includes('?＝入れない'));
  ok('L3-3 見出しは「その日の社内メモ」・欄ごとの「社内メモ・1行1つ」は無い', [...R(w).querySelectorAll('.k-rvfields > div')][0].textContent === 'その日の社内メモ' && !R(w).textContent.includes('1行1つ（') && !R(w).textContent.includes('社内メモ・1行1つ'));
  ok('L3-4 件数の行は 0 の項目を出さない', !/入れない 0|読めない 0/.test(R(w).querySelector('.k-rvcount').textContent), R(w).querySelector('.k-rvcount').textContent);
  go.click(); await settle();
  btn(R(w), 'いまの入力の後ろに足す').click(); await nav();
  const t = R(w).querySelector('.k-trform > .k-toast');
  ok('L4-1 ★入れた直後は短い通知「2種目を入れました」だけ・青い帯の説明が無い', !!t && t.textContent === '2種目を入れました' && t.getAttribute('role') === 'status' && noBad(w).length === 0, (t && t.textContent) + JSON.stringify(noBad(w)));
  t.click();
  ok('L4-2 通知はタップで消える', !R(w).querySelector('.k-toast'));
}
// ---- L4 通知は数秒で消える（TOAST_MS）----
{
  const w = boot();
  await openRecord(w);
  R(w).querySelector('.k-start button.k-impgo').click(); await settle();
  const ta = R(w).querySelector('textarea[aria-label="メモを貼る"]'); ta.value = 'スクワット\n50×10'; ta.dispatchEvent(new w.Event('input', { bubbles: true }));
  btn(R(w), '読み取る').click(); await nav();
  ok('L4-3 読み取る経路も「1種目を入れました」', (R(w).querySelector('.k-toast') || {}).textContent === '1種目を入れました', (R(w).querySelector('.k-toast') || {}).textContent);
  await new Promise((r) => setTimeout(r, 3700));
  ok('L4-4 ★3.5秒で消える', !R(w).querySelector('.k-toast'));
}
// ---- L5 同意なし・AI 無効：ボタンが無い理由は1行・同意の場所は ? の中 ----
{
  const w = boot(); w.consent = 'none';
  await openRecord(w);
  R(w).querySelector('.k-start button.k-impgo').click(); await settle();
  const nc = R(w).querySelector('.k-noaiconsent');
  ok('L5-1 ★同意なし：AI のボタンは無い・1行「録音・AIの同意がありません」・? に同意の場所', !btn(R(w), 'AIで振り分ける') && !!nc && nc.querySelector('.k-qrow').textContent === '録音・AIの同意がありません?' && qOpen(nc).body.textContent.includes('「同意の内容」から同意できます'), nc && nc.textContent);
  const w2 = boot(); w2.aiOff = true;
  await openRecord(w2);
  R(w2).querySelector('.k-start button.k-impgo').click(); await settle();
  ok('L5-2 AI 無効：外部へ送る1行も AI のボタンも無い・「読み取る」はある・説明の帯は無い', !R(w2).querySelector('.k-aiexplain') && !btn(R(w2), 'AIで振り分ける') && !!btn(R(w2), '読み取る') && noBad(w2).length === 0);
}
// ---- L6 記録の画面：説明の文が出ない（数字の無い種目・指導メモの括弧・お客様の欄の挙動） ----
{
  const w = boot();
  seed(w, [{ exercise: 'プランク', sets: [] }]);
  await openRecord(w);
  ok('L6-1 記録の画面に「数字の無い種目は…」「セッション中にそのまま書けます」「保存するとお客様の画面にそのまま出ます」が無い', !R(w).textContent.includes('数字の無い種目は') && !R(w).textContent.includes('セッション中にそのまま') && !R(w).textContent.includes('保存するとお客様の画面にそのまま出ます') && R(w).textContent.includes('痛み・診断・社内のことは書かない'));
}

console.log(`liff-karte-less-text: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
