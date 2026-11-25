// 設計49 段階0：「読み取る」に長い文字起こしを入れたときの案内（止めない）・AI のボタンが出ない理由・見出しの行を自動で消さない・2026-11-20
//   実行: node worker/test/liff-karte-transcript-guide.test.js
//
//   ★本番の liff/karte.js を jsdom で動かし、カルテを開く → 今日の記録 → メモから取り込む → 貼る → 読み取る、を click で通す
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
const SRC = process.env.KARTE_SRC ? readFileSync(process.env.KARTE_SRC, 'utf8') : readFileSync(join(ROOT, 'liff/karte.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) pass++; else { fail++; console.log(`❌ ${name}${detail ? '\n   ' + detail : ''}`); } }
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 12; i++) await tick(); }
async function readDone() { await new Promise((r) => setTimeout(r, 30)); await settle(); }
const b64u = (s) => Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (ageS) => b64u(JSON.stringify({ alg: 'ES256' })) + '.' + b64u(JSON.stringify({ iss: 'https://access.line.me', sub: 'U_TEST', iat: Math.floor(Date.now() / 1000) - ageS, exp: Math.floor(Date.now() / 1000) + 3600 })) + '.sig';

function boot(cfg = {}) {
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
  const c = Object.assign({ ai: true, aiConsent: 'agreed' }, cfg);
  w.fetch = async (url, opt) => {
    const body = JSON.parse(opt.body);
    sent.push({ url: String(url), body });
    let r;
    if (body.action === 'k_training') r = Object.assign({ success: true, karteSchema: 33, aiDraft: c.ai, sessions: [], best: [] }, c.aiConsent === undefined ? {} : { aiConsent: c.aiConsent });
    else if (body.action === 'k_exercises') r = { success: true, karteSchema: 33, exercises: [], truncated: false };
    else if (body.action === 'k_aiDraft') r = { success: false, code: 'AI_NOT_CONFIGURED' };
    else r = { success: true };
    return { json: async () => JSON.parse(JSON.stringify(r)) };
  };
  w.eval(SRC);
  return { w, sent };
}
const R = (w) => w.document.getElementById('karteRoot');
const btn = (root, t) => [...root.querySelectorAll('button')].find((x) => x.textContent.indexOf(t) === 0);
const TA = (w) => R(w).querySelector('textarea[aria-label="メモを貼る"]');
const cards = (w) => [...R(w).querySelectorAll('.k-impcard')];
const guide = (w) => R(w).querySelector('.k-imptguide');
async function openImport(w) {
  w.KarteUI.open('C1', '会員', 'training'); await settle();
  const b = btn(R(w), '＋ 今日の記録') || btn(R(w), '記録の入力（途中）を開く');
  if (b && !R(w).classList.contains('k-entry')) { b.click(); await settle(); }
  R(w).querySelector('button.k-impgo').click(); await settle();
}
function paste(w, text) { const ta = TA(w); ta.value = text; ta.dispatchEvent(new w.Event('input', { bubbles: true })); }

//   架空の文字起こし（Galaxy 風の見出し1行＋話し言葉300行・数字の行はわずか）
const HEAD = 'このコンテンツは架空のアプリが生成しました';
const SPEECH = ['じゃあ今日もよろしくお願いします', 'はい、お願いします', '最近どうですか、仕事のほうは', 'ちょっと忙しくて寝不足気味ですね', 'じゃあまず軽く体を温めていきましょう',
  'そうそう、その姿勢のままゆっくり下ろして', 'あと何回ですか', 'もうちょっと頑張りましょう', 'いい感じです、背中が丸まらないように', '休憩しましょうか'];
const LINES = [HEAD];
for (let i = 0; i < 300; i++) LINES.push(SPEECH[i % SPEECH.length] + (i % 7 === 0 ? 'ね' : ''));
LINES[50] = 'スクワット';
LINES[51] = '30×10';
const TRANSCRIPT = LINES.join('\n');

// ================= G1 長い文字起こしで「読み取る」→ 案内（止めない） =================
{
  const { w, sent } = boot();
  await openImport(w);
  paste(w, TRANSCRIPT);
  ok('G1-0 架空の文字起こしは3,000字以上・300行', TRANSCRIPT.length >= 3000 && LINES.length === 301, String(TRANSCRIPT.length));
  btn(R(w), '読み取る').click(); await settle();
  const g = guide(w);
  ok('G1-1 ★カードの代わりに案内が出る（確かめが必要な行の件数つき）', !!g && cards(w).length === 0 && /確かめが必要な行が\d+件/.test(g.textContent), g ? g.textContent : R(w).textContent.slice(0, 200));
  ok('G1-2 ★AI が使えるときは「下の『AIで振り分ける』を押してください」・ボタンが帯にある', g && g.textContent.includes('「AIで振り分ける」を押してください') && !!btn(R(w), 'AIで振り分ける'));
  ok('G1-3 ★止めない：「それでも1件ずつ確認する」があり、押すと今のカードが出る', !!btn(g, 'それでも1件ずつ確認する'));
  btn(g, 'それでも1件ずつ確認する').click(); await settle();
  ok('G1-4 押すと案内が消え、1件ずつのカードと「記録の画面に入れる」が出る（今の経路のまま）', !guide(w) && cards(w).length > 40 && !!btn(R(w), '記録の画面に入れる'), String(cards(w).length));
  ok('G1-5 何も送っていない（読み取るは端末の中だけ）・ダイアログなし', !sent.some((x) => x.body.action === 'k_aiDraft') && w.confirms === 0 && w.alerts.length === 0);
  paste(w, TRANSCRIPT + '\nまた来週');
  ok('G1-6 文字を変えると読み取りの結果と案内が消える', !guide(w) && cards(w).length === 0);
}
// ================= G2 AI のボタンが出ない理由 =================
for (const [label, cfg, want] of [
  ['切替が閉じている', { ai: false }, '切替が閉じています'],
  ['同意なし', { aiConsent: 'none' }, '同意していないため'],
  ['同意を確認できない', { aiConsent: 'unknown' }, '同意を確認できなかった'],
]) {
  const { w } = boot(cfg);
  await openImport(w);
  paste(w, TRANSCRIPT);
  btn(R(w), '読み取る').click(); await settle();
  const g = guide(w);
  ok('G2 ★' + label + '：案内に理由が出る・AI のボタンは無い・「それでも1件ずつ確認する」はある', g && g.textContent.includes(want) && !btn(R(w), 'AIで振り分ける') && !!btn(g, 'それでも1件ずつ確認する'), g ? g.textContent : '');
}
// ================= G3 件数だけで決めない =================
{
  //   短いメモ（3,000字未満）は決定待ちが多くても案内しない
  const { w } = boot();
  await openImport(w);
  paste(w, SPEECH.concat(SPEECH, SPEECH, SPEECH, SPEECH).join('\n'));
  btn(R(w), '読み取る').click(); await settle();
  ok('G3-1 3,000字未満は案内しない（今どおりカード）', !guide(w) && cards(w).length > 0);
  //   長くても構造になる行が多い（紙のメモを長く貼った）なら案内しない
  const EX = ['ベンチプレス', 'スクワット', 'レッグプレス', 'デッドリフト', 'ラットプルダウン', 'ショルダープレス', 'サイドレイズ', 'アームカール'];
  const memo = [];
  for (const e of EX) { memo.push(e); for (let k = 0; k < 5; k++) memo.push((30 + k * 5) + '×10'); }
  for (let i = 0; i < 45; i++) memo.push('今日の様子のメモで少し長めに書いた行がここにある' + i + '番目の行として残しておくための文です。セッションの最後に話した内容を少し詳しく書いておく');
  paste(w, memo.join('\n'));
  btn(R(w), '読み取る').click(); await settle();
  const pend = cards(w).length;
  ok('G3-2 構造になる行が1割以上なら案内しない（字数3,000以上・決定待ち40件超でも）', !guide(w) && pend > 40 && memo.join('\n').length >= 3000, guide(w) ? guide(w).textContent : 'pend=' + pend + ' len=' + memo.join('\n').length);
}
// ================= G4 見出しの行は自動で消さない（許可リストは空） =================
{
  const { w } = boot();
  await openImport(w);
  const inp = R(w).querySelector('input[type=file]');
  inp.click = () => {};
  btn(R(w), 'ファイルを添付').click();
  const f = new w.File([new Uint8Array(Buffer.from(HEAD + '\nスクワット 30キロで10回', 'utf8'))], 'a.txt', { type: 'text/plain' });
  let sel = [f];
  Object.defineProperty(inp, 'files', { get: () => sel, configurable: true });
  Object.defineProperty(inp, 'value', { get: () => (sel.length ? 'x' : ''), set: (v) => { if (v === '') sel = []; }, configurable: true });
  inp.dispatchEvent(new w.Event('change'));
  await readDone();
  ok('G4-1 ★見出しらしい1行目も欄に残る（実物の文言を確かめるまで消さない）', TA(w).value.split('\n')[0] === HEAD, TA(w).value.slice(0, 60));
  ok('G4-2 画面の許可リスト ATT_HEADER_LINES は空', /var ATT_HEADER_LINES = \[\];/.test(SRC));
  //   許可リストに入れた完全一致の行だけ、先頭3行の中で落ちる（同じ JS の許可リストを置き換えて確かめる）
  const SRC2 = SRC.replace('var ATT_HEADER_LINES = [];', 'var ATT_HEADER_LINES = [' + JSON.stringify(HEAD) + '];');
  const w2 = (() => { const b = bootSrc(SRC2); return b.w; })();
  await openImport(w2);
  const inp2 = R(w2).querySelector('input[type=file]');
  inp2.click = () => {};
  btn(R(w2), 'ファイルを添付').click();
  const f2 = new w2.File([new Uint8Array(Buffer.from(HEAD + '\nスクワット 30キロで10回\na\nb\n' + HEAD, 'utf8'))], 'a.txt', { type: 'text/plain' });
  let sel2 = [f2];
  Object.defineProperty(inp2, 'files', { get: () => sel2, configurable: true });
  Object.defineProperty(inp2, 'value', { get: () => (sel2.length ? 'x' : ''), set: (v) => { if (v === '') sel2 = []; }, configurable: true });
  inp2.dispatchEvent(new w2.Event('change'));
  await readDone();
  ok('G4-3 許可リストの完全一致の行は先頭3行の中だけ落ち（5行目は残る）、落とした行数が出る', TA(w2).value.split('\n')[0] === 'スクワット 30キロで10回' && TA(w2).value.split('\n')[3] === HEAD && R(w2).querySelector('.k-attmsg').textContent.includes('1行落としました'), TA(w2).value + ' / ' + R(w2).querySelector('.k-attmsg').textContent);
}
function bootSrc(src) {
  const save = process.env.KARTE_SRC;
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'https://reservation.tokowaka-gym.com/liff/', pretendToBeVisual: true }); dom.window.__KARTE_REST_UI = true;   // 休憩タイマーは画面では一旦出さない（2026-11-25）。検査では動きを守り続ける
  const w = dom.window;
  w.idToken = jwt(30); w.EDGE_URL = 'https://edge.example';
  w.state = { trainerId: 'T1', _isOwner: false, _allTrainers: [{ id: 'T1', name: '一郎' }] };
  w.alert = () => {}; w.confirm = () => true; w.__karteReload = () => {};
  ['log', 'info', 'warn', 'error', 'debug'].forEach((k) => { w.console[k] = () => {}; });
  w.liff = { getIDToken: () => w.idToken, logout: () => {} };
  w.fetch = async (url, opt) => {
    const body = JSON.parse(opt.body);
    let r = { success: true };
    if (body.action === 'k_training') r = { success: true, karteSchema: 33, aiDraft: true, aiConsent: 'agreed', sessions: [], best: [] };
    else if (body.action === 'k_exercises') r = { success: true, karteSchema: 33, exercises: [], truncated: false };
    return { json: async () => JSON.parse(JSON.stringify(r)) };
  };
  w.eval(src);
  void save;
  return { w };
}

console.log(`liff-karte-transcript-guide: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
