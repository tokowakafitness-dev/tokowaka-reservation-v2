// AI のセッションログを社内では重ねず、表示される場所に入れる（設計66・2026-11-26 オーナー「社内は MECE に重複なし・表示されるべき場所へ」）
//   実行: node worker/test/liff-karte-ai-mece.test.js
//   本番の liff/karte.js を jsdom で動かし、入口から click で通す。AI は身代わり（worker/src/routes/karte-ai-v2.js の draft v:2 の形・値は架空の文字起こし風）
//   ★この検査が守ること
//     ・今日の流れに種目名・重さ・回数だけの行が入らない／記録に残らない事実（ストレッチ・順番を変えた理由）は残る
//     ・種目のメモ→その種目の1セット目のメモ／「nセット目：」（AI のセットの備考）→ そのセットのメモ
//     ・社内メモに「種目名：」が入らない（入らない分＝数字の無い種目・200字超え・対応が切れたセット、だけは今どおり社内メモへ＝捨てない）
//     ・保存の payload にセットのメモが乗る

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
    (w.sent = w.sent || []).push(body);
    let r;
    if (body.action === 'k_training') r = { success: true, karteSchema: 33, aiDraft: !w.aiOff, aiConsent: 'agreed', sessions: [], best: [] };
    else if (body.action === 'k_exercises') r = { success: true, karteSchema: 33, exercises: [{ name: 'ベンチプレス', part: 'chest' }], truncated: false };
    else if (body.action === 'k_aiDraft') r = { success: true, draft: (w.draftFn || DRAFT)(), model: 'x', build: 'x' };
    else if (body.action === 'k_addTraining') r = { success: true, sessionId: 'N1', rev: 1 };
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

const MDRAFT = () => ({
  v: 2, effort: 'medium',
  summary: ['ベンチプレス→スクワット→プランク', 'ベンチプレス 50kg×10回、50kg×8回', '最初にストレッチ', '膝の向きを見るためスクワットとベンチプレスの順番を入れ替えた'],
  exercises: [
    { name: 'ベンチプレス', heard: 'ベンチプレス', note: '架空：肘を張りすぎない', sets: [
      { status: 'match', w: 50, r: 10, bw: false, evidence: 'ベンチ50キロ10回', unsure: '', note: '' },
      { status: 'match', w: 50, r: 8, bw: false, evidence: '50キロ8回', unsure: '', note: '架空：最後は補助' }] },
    { name: 'スクワット', heard: 'スクワット', note: '', sets: [{ status: 'match', w: null, r: 15, bw: true, evidence: 'スクワット自重15回', unsure: '', note: '' }] },
    { name: 'プランク', heard: 'プランク', note: '架空：体幹を意識', sets: [] }],
  condition: ['架空：少し疲れ気味'], caution: [], coaching: ['架空：呼吸を止めない'], hearing: ['架空：最近は歩く量が増えた'],
  next_actions: ['架空：脚の日にする'],
  member_message: '【今日の内容】ベンチプレスとスクワットを行いました', member_todo: ['架空の宿題'], unclear: [],
});
async function toReview(w, sel) {
  R(w).querySelector(sel).click(); await settle();
  const ta = R(w).querySelector('textarea[aria-label="メモを貼る"]'); ta.value = TRANSCRIPT; ta.dispatchEvent(new w.Event('input', { bubbles: true }));
  btn(R(w), 'AIで振り分ける').click(); await nav();
}
const flowOf = (w) => (R(w).querySelector('.k-rvfield[data-field="flow"]') || {}).value;

// ---- M1 架空の下書き：入口から確認画面 → 記録の画面 → 保存 ----
{
  const w = boot(); w.draftFn = MDRAFT;
  await openRecord(w);
  await toReview(w, '.k-start button.k-impgo');
  ok('M1-1 ★確認画面の今日の流れ：種目名・数字だけの2行は出ない・記録に残らない2行は残る', flowOf(w) === '最初にストレッチ\n膝の向きを見るためスクワットとベンチプレスの順番を入れ替えた', JSON.stringify(flowOf(w)));
  R(w).querySelector('button.k-rvput').click(); await nav();
  const d = draftOf(w);
  const bp = d.items.find((i) => i.exercise === 'ベンチプレス'), sq = d.items.find((i) => i.exercise === 'スクワット');
  ok('M1-2 ★種目のメモはその種目の1セット目のメモ', bp && bp.sets[0].note === '架空：肘を張りすぎない', bp && JSON.stringify(bp.sets));
  ok('M1-3 ★AI のセットの備考（2セット目）はその2セット目のメモ', bp && bp.sets[1].note === '架空：最後は補助');
  ok('M1-4 メモの無い種目のセットにはメモを付けない', sq && sq.sets.every((x) => !x.note));
  const memo = d.memo || '';
  ok('M1-5 ★社内メモに「種目名：」の行が入らない（ベンチプレス・スクワット）', !/^ベンチプレス：/m.test(memo) && !/^スクワット：/m.test(memo) && !memo.includes('肘を張りすぎない') && !memo.includes('最後は補助'), JSON.stringify(memo));
  ok('M1-6 ★今日の流れは記録に残らない事実だけ（種目の並び・数字の行は入らない）', memo.includes('今日の流れ：最初にストレッチ 膝の向きを見るため') && !memo.includes('→') && !memo.includes('50kg'), JSON.stringify(memo));
  ok('M1-7 ★置く先のセットが無い種目（プランク）のメモは捨てずに社内メモへ「種目名：」', memo.split('\n').includes('プランク：架空：体幹を意識'));
  ok('M1-8 片方にしか無い社内の欄の事実は残る（状態・指導・ヒアリング・次回）', ['状態：架空：少し疲れ気味', '架空：呼吸を止めない', 'ヒアリング：架空：最近は歩く量が増えた', '次回やること：架空：脚の日にする'].every((x) => memo.split('\n').includes(x)), JSON.stringify(memo));
  const mi = R(w).querySelector('input[data-memo="0:0"]');
  ok('M1-9 記録の画面のベンチプレス1セット目の ✎ の欄にメモが出ている', !!mi && mi.value === '架空：肘を張りすぎない');
  //   全部✓ → 保存：セットのメモが payload に乗る
  for (let i = 0; i < 4; i++) { const b = R(w).querySelector('button.k-allchk'); if (!b) break; b.click(); await settle(); }
  btn(R(w), '保存する').click(); await nav();
  const add = (w.sent || []).filter((x) => x.action === 'k_addTraining').pop();
  const pb = add && add.items.find((i) => i.exercise === 'ベンチプレス');
  ok('M1-10 ★保存の payload：ベンチプレスの1・2セット目にメモ', !!pb && pb.sets[0].note === '架空：肘を張りすぎない' && pb.sets[1].note === '架空：最後は補助', add && JSON.stringify(add.items));
}
// ---- M2 200字を超える・対応が切れた（確認画面で行を書き直した）・種目名を変えた ----
{
  const w = boot();
  w.draftFn = () => { const d = MDRAFT(); d.exercises[0].sets[0].note = 'あ'.repeat(150); d.exercises[0].note = 'い'.repeat(120); return d; };
  await openRecord(w);
  await toReview(w, '.k-start button.k-impgo');
  //   ベンチプレスの行を「60×5」1つに書き直す（元のセットとの対応が切れる）
  const card0 = [...R(w).querySelectorAll('.k-rvex')].find((c) => c.querySelector('.k-rvname').value === 'ベンチプレス');
  const li = card0.querySelector('.k-rvline'); li.value = '60×5'; li.dispatchEvent(new w.Event('input', { bubbles: true })); await settle();
  R(w).querySelector('button.k-rvput').click(); await nav();
  const d = draftOf(w), bp = d.items.find((i) => i.exercise === 'ベンチプレス'), memo = d.memo || '';
  ok('M2-1 種目のメモ（120字）は書き直した後の1セット目へ', bp.sets.length === 1 && bp.sets[0].note === 'い'.repeat(120), JSON.stringify(bp.sets));
  ok('M2-2 ★対応が切れたセットの備考は捨てずに社内メモへ「種目名：nセット目：」', memo.split('\n').includes('ベンチプレス：1セット目：' + 'あ'.repeat(150)) && memo.split('\n').includes('ベンチプレス：2セット目：架空：最後は補助'), JSON.stringify(memo).slice(0, 300));
}
{
  const w = boot();
  w.draftFn = () => { const d = MDRAFT(); d.exercises[0].note = 'う'.repeat(120); d.exercises[0].sets[0].note = 'え'.repeat(100); return d; };
  await openRecord(w);
  await toReview(w, '.k-start button.k-impgo');
  R(w).querySelector('button.k-rvput').click(); await nav();
  const d = draftOf(w), bp = d.items.find((i) => i.exercise === 'ベンチプレス'), memo = d.memo || '';
  ok('M2-3 ★1セット目のメモが200字を超える分は社内メモへ（切らない・捨てない）', bp.sets[0].note === 'う'.repeat(120) && memo.split('\n').includes('ベンチプレス：1セット目：' + 'え'.repeat(100)), JSON.stringify([bp.sets[0].note.length, memo.slice(0, 80)]));
}
{
  const w = boot(); w.draftFn = MDRAFT;
  await openRecord(w);
  await toReview(w, '.k-start button.k-impgo');
  const card0 = [...R(w).querySelectorAll('.k-rvex')].find((c) => c.querySelector('.k-rvname').value === 'ベンチプレス');
  const ni = card0.querySelector('.k-rvname'); ni.value = 'インクラインベンチプレス'; ni.dispatchEvent(new w.Event('input', { bubbles: true })); await settle();
  R(w).querySelector('button.k-rvput').click(); await nav();
  const d = draftOf(w), it = d.items.find((i) => i.exercise === 'インクラインベンチプレス');
  ok('M2-4 種目名を変えても数字が同じならセットの備考はそのセットへ', !!it && it.sets[0].note === '架空：肘を張りすぎない' && it.sets[1].note === '架空：最後は補助', it && JSON.stringify(it.sets));
}
// ---- M3 今日の流れの網は保守的（名前を含んでも事実がある行は残す・空の配列なら空） ----
{
  const w = boot(); w.draftFn = () => Object.assign(MDRAFT(), { summary: ['ベンチプレスでフォームを確認', 'スクワット 自重×15'] });
  await openRecord(w);
  await toReview(w, '.k-start button.k-impgo');
  ok('M3-1 名前を含んでも事実のある行は残す・数字だけの行は外す', flowOf(w) === 'ベンチプレスでフォームを確認', JSON.stringify(flowOf(w)));
  const w2 = boot(); w2.draftFn = () => Object.assign(MDRAFT(), { summary: [] });
  await openRecord(w2);
  await toReview(w2, '.k-start button.k-impgo');
  R(w2).querySelector('button.k-rvput').click(); await nav();
  ok('M3-2 今日の流れが空なら社内メモに「今日の流れ：」を入れない', !(draftOf(w2).memo || '').includes('今日の流れ：'));
}

console.log(`liff-karte-ai-mece: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
