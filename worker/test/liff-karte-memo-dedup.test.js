// 設計64：同じ文を社内メモ・お客様の欄に2回書かない（消さない・削らない・1回だけ残す）。本番の liff/karte.js を jsdom で動かし、入口から click で通す・2026-11-26
//   実行: node worker/test/liff-karte-memo-dedup.test.js
//   ★再現した重複：同じ下書き（AI・読み取る）をもう一度入れると、社内メモの同じ行・お客様へ・次回までにが2回入った
//   ★守ること：行単位の完全一致（NFKC＋空白の詰め＋前後の空白だけ）だけを重ねない。片方にしか無い行は必ず残る。重ねなかった行数は入れた後の1行で言う
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
//   設計66：種目のメモ（ベンチプレス：架空の種目メモ…）は社内メモでなくベンチプレスの1セット目のメモへ入る＝社内メモの行に含めない
const DAY_LINES = ['今日の流れ：架空の流れ：胸から脚へ', '状態：架空の状態', '架空の指導', 'ヒアリング：架空のヒアリング', '次回やること：架空の次回：足の倒れ方を確認する'];
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
    if (body.action === 'k_training') r = { success: true, karteSchema: 33, aiDraft: !w.aiOff, aiConsent: 'agreed', sessions: [], best: [] };
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
const memoOf = (w) => (draftOf(w) || {}).memo || '';
const lines = (s) => String(s).split('\n');
const msgOf = (w) => { const m = R(w).querySelector('.k-trform > .k-toast'); return m ? m.textContent : ''; };   // 設計65：入れた直後の短い通知
async function readAndPlace(w, text) {
  R(w).querySelector('.k-start button.k-voicelog, .k-start button.k-impgo, button.k-voicelog').click(); await settle();
  const ta = R(w).querySelector('textarea[aria-label="メモを貼る"]'); ta.value = text; ta.dispatchEvent(new w.Event('input', { bubbles: true }));
  btn(R(w), '読み取る').click(); await settle();
  const toMemo = btn(R(w), '社内メモに足す'); if (toMemo) { toMemo.click(); await settle(); }
  const put = R(w).querySelector('button.k-impput'); if (put) { put.click(); await settle(); }
  const ask = btn(R(w), 'いまの入力の後ろに足す'); if (ask) ask.click();
  await nav();
}

// ---- D1 ★同じ AI の下書きを2回入れる：社内メモの行・お客様へ・次回までには1回だけ（種目とセットは今どおり後ろに足す） ----
{
  const w = boot();
  await openRecord(w);
  await voiceAndPlace(w, R(w).querySelector('.k-start button.k-impgo'), { member: true });
  const m1 = memoOf(w), mem1 = JSON.stringify(draftOf(w).member);
  ok('D1 前提：1回目で社内メモに5行・お客様へ・次回までにが入る', JSON.stringify(lines(m1)) === JSON.stringify(DAY_LINES) && draftOf(w).member.message === '【今日の内容】架空のお客様へ', JSON.stringify([m1, mem1]));
  await voiceAndPlace(w, R(w).querySelector('button.k-voicelog'), { member: true });
  const d = draftOf(w);
  ok('D1 ★2回目：社内メモの同じ行は重ねない（5行のまま）', d.memo === m1, JSON.stringify(d.memo));
  ok('D1 ★2回目：お客様へ・次回までにも重ねない', JSON.stringify(d.member) === mem1, JSON.stringify(d.member));
  ok('D1 種目とセットは今どおり後ろに足す（重ねるかはトレーナーが「後ろに足す」で選んだ）', JSON.stringify(d.items.map((i) => i.exercise)) === JSON.stringify(['ベンチプレス', 'スクワット', 'ベンチプレス', 'スクワット']));
  //   設計65（2026-11-26 オーナー「説明は不要」）：重ねなかった数の説明は出さない（重ねなかった行は社内メモに既にある＝消えていない）。通知は種目の数だけ
  ok('D1 ★設計65：入れた後は「n種目を入れました」の短い通知だけ（重ねなかった説明は出さない）', msgOf(w) === '2種目を入れました' && !/重ねて入れ/.test(R(w).textContent), msgOf(w));
}
// ---- D2 ★一部だけ同じ：片方にしか無い行は必ず残る（既存の行・新しい行とも）・順番は既存→新しい行 ----
{
  const w = boot();
  seed(w, [{ exercise: 'ラットプルダウン', sets: [] }], { memo: '既存だけの行\n架空の指導\nヒアリング：架空のヒアリング', member: { message: '既存のお客様へ', todo: ['架空の宿題', '', ''], tags: [] } });
  await openRecord(w);
  await voiceAndPlace(w, R(w).querySelector('.k-start button.k-voicelog'), { member: true });
  const d = draftOf(w);
  const want = ['既存だけの行', '架空の指導', 'ヒアリング：架空のヒアリング'].concat(DAY_LINES.filter((l) => l !== '架空の指導' && l !== 'ヒアリング：架空のヒアリング'));
  ok('D2 ★社内メモ：既存の3行はそのまま・新しい3行だけ足す（同じ2行は1回）', JSON.stringify(lines(d.memo)) === JSON.stringify(want), JSON.stringify(lines(d.memo)));
  ok('D2 ★お客様へは違う文なので足す・同じ宿題は重ねない', d.member.message === '既存のお客様へ\n【今日の内容】架空のお客様へ' && JSON.stringify(d.member.todo) === JSON.stringify(['架空の宿題', '', '']), JSON.stringify(d.member));
  ok('D2 ★設計65：通知に行き先・重ねなかった行数を書かない', /^\d+種目を入れました$/.test(msgOf(w)) && !/重ねて入れ|文章 \d+行/.test(R(w).textContent), msgOf(w));
}
// ---- D3 同じとみなすのは NFKC・空白の違いだけ（意味の近さでは判定しない＝消し過ぎない） ----
{
  const w = boot();
  seed(w, [], { memo: '　架空の指導　\nヒアリング：架空のヒアリング\t\n架空の指導です\n状態：架空の状態です' });   // 全角空白・前後の空白・タブは同じ／「です」が付けば別の行
  await openRecord(w);
  await voiceAndPlace(w, R(w).querySelector('.k-start button.k-impgo'));
  const ls = lines(draftOf(w).memo);
  ok('D3 ★全角の空白・前後の空白の違いは同じ行として重ねない', ls.filter((l) => l.trim() === '架空の指導').length === 1 && ls.filter((l) => l.trim() === 'ヒアリング：架空のヒアリング').length === 1, JSON.stringify(ls));
  ok('D3 ★少しでも文が違えば別の行として残す（「架空の指導です」・「状態：架空の状態です」と「状態：架空の状態」は両方）', ls.includes('架空の指導です') && ls.includes('状態：架空の状態です') && ls.includes('状態：架空の状態'), JSON.stringify(ls));
}
// ---- D3b 全角の英数字（NFKC で同じ字）は同じ行 ----
{
  const w = boot(); w.draftFn = () => Object.assign(DRAFT(), { coaching: ['架空のＡＢ１０指導'] });
  seed(w, [], { memo: '架空のAB10指導' });
  await openRecord(w);
  await voiceAndPlace(w, R(w).querySelector('.k-start button.k-impgo'));
  const ls = lines(memoOf(w));
  ok('D3b ★「架空のＡＢ１０指導」は既存の「架空のAB10指導」と同じ＝重ねない（既存の書き方のまま残る）', ls[0] === '架空のAB10指導' && !ls.some((l) => l.includes('ＡＢ')), JSON.stringify(ls));
}
// ---- D3c 関門② 中1：Object の名前（constructor・toString・__proto__）の行も消えない ----
{
  const w = boot(); w.draftFn = () => Object.assign(DRAFT(), { coaching: ['constructor', 'toString', '__proto__', 'hasOwnProperty'], member_todo: ['constructor', '__proto__'] });
  await openRecord(w);
  await voiceAndPlace(w, R(w).querySelector('.k-start button.k-impgo'), { member: true });
  const ls = lines(memoOf(w)), td = draftOf(w).member.todo;
  ok('D3c ★constructor・toString・__proto__・hasOwnProperty の行は社内メモに入る', ['constructor', 'toString', '__proto__', 'hasOwnProperty'].every((x) => ls.includes(x)), JSON.stringify(ls));
  ok('D3c ★次回までにの constructor・__proto__ も入る', td[0] === 'constructor' && td[1] === '__proto__', JSON.stringify(td));
}
// ---- D4 1つの下書きの中で同じ行が2回（AI が同じ指導を2件返した） ----
{
  const w = boot(); w.draftFn = () => Object.assign(DRAFT(), { coaching: ['架空の指導', '架空の指導', '架空の別の指導'] });
  await openRecord(w);
  await voiceAndPlace(w, R(w).querySelector('.k-start button.k-impgo'));
  const ls = lines(memoOf(w));
  ok('D4 ★同じ下書きの中の同じ行も1回・違う行は残る', ls.filter((l) => l === '架空の指導').length === 1 && ls.includes('架空の別の指導'), JSON.stringify(ls));
}
// ---- D5 ★上限の判定も重ねない後の長さで見る（同じ行しか無いなら押せる・下書きの社内メモは変わらない） ----
{
  const w = boot();
  const pad = 'う'.repeat(4000 - DAY_LINES.join('\n').length - 1);
  seed(w, [], { memo: pad + '\n' + DAY_LINES.join('\n') });
  await openRecord(w);
  R(w).querySelector('.k-start button.k-impgo').click(); await settle();
  const ta = R(w).querySelector('textarea[aria-label="メモを貼る"]'); ta.value = TRANSCRIPT; ta.dispatchEvent(new w.Event('input', { bubbles: true }));
  btn(R(w), 'AIで振り分ける').click(); await settle();
  const go = R(w).querySelector('button.k-rvput');
  ok('D5 ★全部が既にある行なら上限（4,000字）ちょうどでも押せる', !!go && go.disabled === false, R(w).querySelector('.k-rvwhy') && R(w).querySelector('.k-rvwhy').textContent);
  go.click(); await nav();
  ok('D5 社内メモは変わらない（4,000字のまま）', memoOf(w) === pad + '\n' + DAY_LINES.join('\n') && memoOf(w).length === 4000);
}
// ---- D6 ★読み取る（AI なし）経路でも同じ：同じメモを2回貼って入れても社内メモの行は1回 ----
{
  const w = boot(); w.aiOff = true;
  seed(w, [{ exercise: 'ラットプルダウン', sets: [] }]);
  await openRecord(w);
  const T = 'スクワット\n60×8\n架空の自由文：膝の向きをそろえる';
  await readAndPlace(w, T);
  const m1 = memoOf(w);
  await readAndPlace(w, T);
  ok('D6 前提：1回目で社内メモに入る行がある', m1.length > 0, JSON.stringify(m1));
  ok('D6 ★2回目：同じ行は重ねない', memoOf(w) === m1, JSON.stringify(memoOf(w)));
}

console.log(`liff-karte-memo-dedup: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
