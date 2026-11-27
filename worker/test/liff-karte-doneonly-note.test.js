// 数字の無い種目（実施のみ）のメモ（設計67）：本番の liff/karte.js を jsdom で動かし、入口から通して値で確かめる・2026-11-26
//   実行: node worker/test/liff-karte-doneonly-note.test.js
//   ★守ること：AI の下書き・読み取る・手で入れる記録の画面・直す画面・日別の記録で、数字の無い種目のメモはその種目に付く（社内メモに「種目名：」で回さない）
//     ・exNote が無い（古い Worker・切替が閉じている）なら今どおり社内メモ（捨てない）・メモの欄を出さない
//     ・セットを足したらメモは1セット目へ移る・「実施した」が無いと送られない＝保存前の確認で数える
//   ★身代わりは fetch（Worker）・LINE の SDK だけ。名前・ID はすべて架空（設計58 の検査の身代わりを写した）

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
async function settle() { for (let i = 0; i < 14; i++) await tick(); }
const b64u = (s) => Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (ageS) => b64u(JSON.stringify({ alg: 'ES256' })) + '.' + b64u(JSON.stringify({ iss: 'https://access.line.me', sub: 'U_TEST', iat: Math.floor(Date.now() / 1000) - ageS, exp: Math.floor(Date.now() / 1000) + 3600 })) + '.sig';
const NAME = '甲野一郎';   // 架空の会員名（端末に残らないことを確かめる）

//   新しい形の回（k_training の返し方：新しい形の回の全セットに assist_reps:null・forced:false・drops:[] が付く）
const S1 = () => ({ session_id: 'S1', session_date: '2026-11-20', created_at: 100, author_trainer_id: 'T1', rev: 1,
  exercises: [{ ord: 1, exercise: '腸腰筋ストレッチ', doneOnly: true, note: '架空の伸ばし方のメモ' }, { ord: 2, exercise: 'フロアアブ', doneOnly: false }, { ord: 3, exercise: 'ヒップリフト', doneOnly: false }, { ord: 4, exercise: 'ヒップリフト', doneOnly: false }],
  sets: [
    { session_id: 'S1', exercise: 'フロアアブ', set_no: 1, weight_kg: 0, reps: 10, note: null, ord: 2, assist_reps: null, forced: false, drops: [] },
    { session_id: 'S1', exercise: 'フロアアブ', set_no: 2, weight_kg: 10, reps: 10, note: null, ord: 2, assist_reps: null, forced: false, drops: [{ weight_kg: 0, reps: 10, assist_reps: null, forced: false }, { weight_kg: 5, reps: 8, assist_reps: 2, forced: false }] },
    { session_id: 'S1', exercise: 'ヒップリフト', set_no: 1, weight_kg: 30, reps: 10, note: '見本のメモ', ord: 3, assist_reps: null, forced: false, drops: [] },
    { session_id: 'S1', exercise: 'ヒップリフト', set_no: 2, weight_kg: 50, reps: 10, note: null, ord: 3, assist_reps: 5, forced: false, drops: [] },
    { session_id: 'S1', exercise: 'ヒップリフト', set_no: 3, weight_kg: 80, reps: 5, note: null, ord: 3, assist_reps: null, forced: true, drops: [] },
    { session_id: 'S1', exercise: 'ヒップリフト', set_no: 1, weight_kg: 40, reps: 12, note: null, ord: 4, assist_reps: null, forced: false, drops: [] }] });
//   S1 を送る中身にしたもの（buildPayload の形）
const P1 = [
  { exercise: '腸腰筋ストレッチ', sets: [], doneOnly: true },
  { exercise: 'フロアアブ', sets: [{ weight: 0, reps: 10 }, { weight: 10, reps: 10, drops: [{ weight: 0, reps: 10 }, { weight: 5, reps: 8, assist: 2 }] }] },
  { exercise: 'ヒップリフト', sets: [{ weight: 30, reps: 10, note: '見本のメモ' }, { weight: 50, reps: 10, assist: 5 }, { weight: 80, reps: 5, forced: true }] },
  { exercise: 'ヒップリフト', sets: [{ weight: 40, reps: 12 }] }];
//   新しい形だが新しい鍵を値で使っていない回
const S2 = () => ({ session_id: 'S2', session_date: '2026-11-18', created_at: 90, author_trainer_id: 'T1', rev: 3,
  exercises: [{ ord: 1, exercise: 'スクワット', doneOnly: false }],
  sets: [{ session_id: 'S2', exercise: 'スクワット', set_no: 1, weight_kg: 60, reps: 8, note: null, ord: 1, assist_reps: null, forced: false, drops: [] }] });
//   古い回（exercises が無い）
const S3 = () => ({ session_id: 'S3', session_date: '2026-11-10', created_at: 80, author_trainer_id: 'T1', rev: 1,
  sets: [{ session_id: 'S3', exercise: 'ベンチプレス', set_no: 1, weight_kg: 30, reps: 10, note: null }, { session_id: 'S3', exercise: 'スクワット', set_no: 1, weight_kg: 40, reps: 10, note: null }] });

function boot(o = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'https://reservation.tokowaka-gym.com/liff/', pretendToBeVisual: true }); dom.window.__KARTE_REST_UI = true;   // 休憩タイマーは画面では一旦出さない（2026-11-25）。検査では動きを守り続ける
  const w = dom.window;
  const sent = [];
  w.idToken = jwt(30);
  w.EDGE_URL = 'https://edge.example';
  w.state = { trainerId: 'T1', _isOwner: false, _allTrainers: [{ id: 'T1', name: '一郎' }] };
  w.alerts = []; w.alert = (m) => w.alerts.push(String(m));
  w.confirms = []; w.confirm = (m) => { w.confirms.push(String(m)); return true; };
  w.__karteReload = () => {};
  w.liff = { getIDToken: () => w.idToken, logout: () => {} };
  w.cfg = Object.assign({ sessions: [S1(), S2(), S3()], edit: true, schema: 33, editRes: 'ok', hang: false, exNote: true, ai: false, draft: null }, o);
  w.fetch = async (url, opt) => {
    const body = JSON.parse(opt.body);
    sent.push(body);
    const c = w.cfg;
    let r;
    //   設計62：1件の読み直し（sessionId）・前回の読み足し（before）は Worker と同じ答え方（c.oneRes で上書きできる）
    if (body.action === 'k_training' && body.sessionId) {
      const x = c.sessions.find((s) => s.session_id === body.sessionId);
      r = c.oneRes ? c.oneRes(body) : (x ? { success: true, karteSchema: c.schema, aiDraft: false, trace: 'live', extra: x } : { success: true, karteSchema: c.schema, aiDraft: false, trace: 'deleted', extra: null });
      if (r && r.success && c.edit !== undefined) r.trainingEdit = c.edit;
    }
    else if (body.action === 'k_training' && body.before) { r = { success: true, karteSchema: c.schema, aiDraft: false, sessions: c.sessions.filter((s) => s.session_date < body.before), best: [], more: false, nextCursor: null }; }
    else if (body.action === 'k_training') { r = { success: true, karteSchema: c.schema, aiDraft: c.ai, aiConsent: 'agreed', sessions: c.sessions, best: [] }; if (c.edit !== undefined) r.trainingEdit = c.edit; }
    else if (body.action === 'k_aiDraft') r = { success: true, draft: c.draft, model: 'x', build: 'x' };
    else if (body.action === 'k_addTraining') r = { success: true, sessionId: 'NA', rev: 1 };
    else if (body.action === 'k_exercises') r = { success: true, karteSchema: c.schema, exercises: [], truncated: false };
    else if (body.action === 'k_summary') r = { success: true, karteSchema: c.schema, customer: { name: NAME, trainerId: 'T1' }, hearing: null, consent: { state: 'agreed' } };
    else if (body.action === 'k_editTraining') {
      if (c.hang) await new Promise((res) => { w.release = res; });
      const m = c.editRes;
      if (m === 'unknown') return { json: async () => { throw new Error('x'); } };
      r = m === 'ok' ? { success: true, sessionId: 'N' + sent.length, rev: 1, replaced: body.sessionId }
        : m === 'bad' ? { success: false, code: 'BAD_REQUEST', detail: 'SET_VALUE' }
        : { success: false, code: m };
    }
    else r = { success: true };
    if (body.action === 'k_training' && r && r.success && c.exNote !== undefined) r.exNote = c.exNote;   // 設計67
    return { json: async () => JSON.parse(JSON.stringify(r)) };
  };
  w.eval(SRC);
  return { w, sent };
}
const R = (w) => w.document.getElementById('karteRoot');
const btn = (root, t) => [...root.querySelectorAll('button')].find((x) => x.textContent.indexOf(t) === 0);
const EKEY = 'karte_tr_edit_v1:T1:C1', DKEY = 'karte_tr_draft_v1:T1:C1';
const ed = (w) => JSON.parse(w.localStorage.getItem(EKEY) || 'null');
const sortKeys = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.keys(x).sort().reduce((o, kk) => { o[kk] = x[kk]; return o; }, {}) : x));
const editsSent = (sent) => sent.filter((b) => b.action === 'k_editTraining');
const writesSent = (sent) => sent.filter((b) => /^k_(add|save|delete|edit)/.test(b.action));
async function openList(w) {
  w.KarteUI.open('C1', NAME, 'training'); await settle();
  //   今日の下書きに種目があると今日の記録の画面が自動で開く（今のまま）＝見出しの ← で一覧へ戻る
  const back = R(w).querySelector('.k-entryhead .k-back');
  if (back) { back.click(); for (let i = 0; i < 40 && R(w).querySelector('.k-entryhead'); i++) await new Promise((r) => setTimeout(r, 5)); await settle(); }
}
async function openDay(w, sid) {
  const rows = [...R(w).querySelectorAll('.k-dayrow')];
  const days = { S1: '11/20', S2: '11/18', S3: '11/10' };
  const row = rows.find((r) => r.textContent.indexOf(days[sid]) === 0);
  row.click(); await settle();
}
const editBtn = (w) => R(w).querySelector('button.k-dayedit');
async function startEdit(w, sid) { await openList(w); await openDay(w, sid || 'S1'); editBtn(w).click(); await settle(); }
const saveBtn = (w) => R(w).querySelector('.k-hsave') || btn(R(w), '保存する');
function setReps(w, label, v) { const i = R(w).querySelector('input[aria-label="' + label + '"]'); i.value = v; i.dispatchEvent(new w.Event('input')); return i; }
const frozen = (w) => !!R(w).querySelector('.k-edfrozen');
const frozenText = (w) => { const f = R(w).querySelector('.k-edfrozen'); return f ? f.textContent : ''; };
function storageEvt(w, oldV, newV) { w.dispatchEvent(new w.StorageEvent('storage', { key: EKEY, oldValue: oldV, newValue: newV })); }


const DKEY2 = DKEY;
const draftOf = (w) => JSON.parse(w.localStorage.getItem(DKEY2) || 'null');
const TODAY = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
function seed(w, items, extra) { w.localStorage.setItem(DKEY2, JSON.stringify(Object.assign({ v: 1, tid: 'T1', cid: 'C1', sessionDate: TODAY, items, reqId: 'kreq1', pending: null, at: Date.now(), openEi: 0 }, extra || {}))); }
async function openRecord(w) {
  w.KarteUI.open('C1', NAME, 'training'); await settle();
  const b0 = btn(R(w), '記録の入力（途中）を開く') || btn(R(w), '＋ 今日の記録');
  if (b0) { b0.click(); await settle(); }
}
const nav = async () => { await new Promise((r) => setTimeout(r, 40)); await settle(); };
const adds = (sent) => sent.filter((b) => b.action === 'k_addTraining');
const DRAFT = () => ({ v: 2, effort: 'medium', summary: [], exercises: [
  { name: 'スクワット', heard: 'スクワット', note: '', sets: [{ status: 'match', w: 40, r: 10, bw: false, evidence: 'スクワット40キロ10回', unsure: '', note: '' }] },
  { name: 'プランク', heard: 'プランク', note: '架空：体幹を意識', sets: [] }],
  condition: [], caution: [], coaching: [], hearing: [], next_actions: [], member_message: '', member_todo: [], unclear: [] });
async function viaAi(w) {
  R(w).querySelector('.k-start button.k-impgo').click(); await settle();
  const ta = R(w).querySelector('textarea[aria-label="メモを貼る"]'); ta.value = '架空の文字起こし スクワット プランク'; ta.dispatchEvent(new w.Event('input', { bubbles: true }));
  btn(R(w), 'AIで振り分ける').click(); await nav();
  R(w).querySelector('button.k-rvput').click(); await nav();
}
async function openEx(w, n) { const b = R(w).querySelector('button.k-excol[aria-label="' + n + 'を開く"]'); if (b) { b.click(); await settle(); } }
const itemOf = (w, n) => (draftOf(w) || { items: [] }).items.find((i) => i.exercise === n);

// ---- D1 AI の下書き：数字の無い種目（プランク）の種目のメモ → その種目に付く・社内メモに回らない → ✓ 実施した → 保存で送る ----
{
  const { w, sent } = boot({ sessions: [], ai: true, draft: DRAFT() });
  await openRecord(w);
  await viaAi(w);
  const pl = itemOf(w, 'プランク');
  ok('D1-1 ★AI：プランクの種目のメモはプランクに付く', !!pl && pl.note === '架空：体幹を意識' && pl.sets.length === 0, JSON.stringify(pl));
  ok('D1-2 ★社内メモに「プランク：」が入らない', !/プランク：/.test((draftOf(w) || {}).memo || ''), JSON.stringify((draftOf(w) || {}).memo));
  await openEx(w, 'プランク');
  const inp = R(w).querySelector('input.k-exnote');
  ok('D1-3 記録の画面：プランクの ✎ の欄が開いていてメモが出る・真下に健康の1行（I55）', !!inp && inp.value === '架空：体幹を意識' && /痛み・診断・服薬/.test((inp.nextElementSibling || {}).textContent || ''));
  const done = R(w).querySelector('button.k-donechk[aria-label^="プランク"]'); done.click(); await settle();
  const ac = R(w).querySelector('button.k-allchk'); if (ac) { ac.click(); await settle(); }
  btn(R(w), '保存する').click(); await nav();
  const a = adds(sent).pop(), p = a && a.items.find((i) => i.exercise === 'プランク');
  ok('D1-4 ★保存の payload：プランク { doneOnly: true, note }', !!p && p.doneOnly === true && p.note === '架空：体幹を意識' && p.sets.length === 0, a && JSON.stringify(a.items));
}
// ---- D2 exNote が無い（古い Worker・切替が閉じている）＝今どおり社内メモ・欄を出さない ----
{
  const { w, sent } = boot({ sessions: [], ai: true, draft: DRAFT(), exNote: false });
  await openRecord(w);
  await viaAi(w);
  ok('D2-1 ★exNote が偽：プランクのメモは社内メモ「プランク：…」（捨てない）・種目には付けない', /^プランク：架空：体幹を意識$/m.test((draftOf(w) || {}).memo || '') && !itemOf(w, 'プランク').note, JSON.stringify(draftOf(w)));
  ok('D2-2 メモの ✎ を出さない', !R(w).querySelector('button.k-exnotebtn'));
}
// ---- D3 手で入れる：✎ で開いて書く → 保存で送る／空にしたら送らない ----
{
  const { w, sent } = boot({ sessions: [] });
  seed(w, [{ exercise: '腸腰筋ストレッチ', sets: [], doneOnly: true }]);
  await openRecord(w);
  const b = R(w).querySelector('button.k-exnotebtn');
  ok('D3-1 数字の無い種目の行に ✎（44px・閉じている）', !!b && /min-height:\s*44px/.test(b.style.cssText) && b.getAttribute('aria-expanded') === 'false' && !R(w).querySelector('input.k-exnote'));
  b.click(); await settle();
  const inp = R(w).querySelector('input.k-exnote');
  ok('D3-2 ✎ を押すと欄が開く（200字まで）', !!inp && inp.getAttribute('maxlength') === '200');
  inp.value = '架空の手で書いたメモ'; inp.dispatchEvent(new w.Event('input'));
  ok('D3-3 下書きに入る', itemOf(w, '腸腰筋ストレッチ').note === '架空の手で書いたメモ');
  btn(R(w), '保存する').click(); await nav();
  const p = adds(sent).pop().items[0];
  ok('D3-4 ★保存の payload に note', p.doneOnly === true && p.note === '架空の手で書いたメモ', JSON.stringify(p));
}
// ---- D4 セットを足したらメモは1セット目へ移る（数字のある種目は種目のメモを持たない） ----
{
  const { w } = boot({ sessions: [] });
  seed(w, [{ exercise: '腸腰筋ストレッチ', sets: [], doneOnly: false, note: '架空の移るメモ' }]);
  await openRecord(w);
  btn(R(w), '＋ セット').click(); await settle();
  const it = itemOf(w, '腸腰筋ストレッチ');
  ok('D4-1 ★セットを足すと種目のメモは1セット目のメモへ・種目のメモは消える', it.sets.length === 1 && it.sets[0].note === '架空の移るメモ' && !('note' in it), JSON.stringify(it));
}
// ---- D5 「実施した」を付けずにメモだけ＝送られない → 保存前の確認で数える ----
{
  const { w, sent } = boot({ sessions: [] });
  seed(w, [{ exercise: 'スクワット', sets: [{ w: '40', r: '10', done: true }] }, { exercise: '腸腰筋ストレッチ', sets: [], doneOnly: false, note: '架空の送られないメモ' }]);
  await openRecord(w);
  btn(R(w), '保存する').click(); await nav();
  ok('D5-1 ★保存前の確認に「記録されない入力が 1 セット」（メモだけの数字の無い種目を数える）', w.confirms.some((c) => c.includes('記録されない入力が 1 セット')), JSON.stringify(w.confirms));
}
// ---- D6 読み取る：種目の下のメモを「直前の種目「プランク」のメモにする」→ プランクに付く ----
{
  const { w } = boot({ sessions: [] });
  await openRecord(w);
  R(w).querySelector('.k-start button.k-impgo').click(); await settle();
  const ta = R(w).querySelector('textarea[aria-label="メモを貼る"]'); ta.value = 'プランク\n体幹がぶれないように'; ta.dispatchEvent(new w.Event('input', { bubbles: true }));
  btn(R(w), '読み取る').click(); await settle();
  const b = [...R(w).querySelectorAll('button')].find((x) => x.textContent.indexOf('直前の種目「プランク」のメモにする') === 0);
  ok('D6-1 決め方の文言は「直前の種目「プランク」のメモにする」', !!b);
  if (b) { b.click(); await settle(); }
  const go = btn(R(w), '記録の画面に入れる'); if (go && !go.disabled) { go.click(); await nav(); }
  ok('D6-2 ★読み取る：プランクに種目のメモ・社内メモに回らない', (itemOf(w, 'プランク') || {}).note === '体幹がぶれないように' && !/プランク：/.test((draftOf(w) || {}).memo || ''), JSON.stringify(draftOf(w)));
}
// ---- D7 日別の記録：実施のみの下に「メモ：…」／直す画面：メモが欄に戻り、変えずに保存すると送らない・直すと送る ----
{
  const { w, sent } = boot();
  await openList(w); await openDay(w, 'S1');
  ok('D7-1 ★日別の記録：腸腰筋ストレッチの下に「メモ：架空の伸ばし方のメモ」', [...R(w).querySelectorAll('.k-exnoteview')].some((x) => x.textContent === 'メモ：架空の伸ばし方のメモ'));
  editBtn(w).click(); await settle();
  await openEx(w, '腸腰筋ストレッチ');
  const inp = R(w).querySelector('input.k-exnote');
  ok('D7-2 ★直す画面：数字の無い種目のメモが欄に戻る', !!inp && inp.value === '架空の伸ばし方のメモ', inp && inp.value);
  saveBtn(w).click(); await settle();
  ok('D7-3 変えずに保存＝送らない（メモが往復で変わらない）', editsSent(sent).length === 0, JSON.stringify(editsSent(sent)));
}
{
  const { w, sent } = boot();
  await startEdit(w, 'S1');
  await openEx(w, '腸腰筋ストレッチ');
  const inp = R(w).querySelector('input.k-exnote'); inp.value = '架空の直したメモ'; inp.dispatchEvent(new w.Event('input'));
  saveBtn(w).click(); await settle();
  const e = editsSent(sent).pop(), p = e && e.items[0];
  ok('D7-4 ★直す画面でメモを直すと k_editTraining に新しいメモ', !!p && p.exercise === '腸腰筋ストレッチ' && p.doneOnly === true && p.note === '架空の直したメモ', e && JSON.stringify(e.items[0]));
}

// ---- D8 関門②（重大）：exNote が偽の間は、種目のメモのある記録を直さない（置き換えで現行版からメモが消えるため） ----
{
  const { w, sent } = boot({ exNote: false });
  await startEdit(w, 'S1');
  setReps(w, '1セット目の回数', '12');
  saveBtn(w).click(); await settle();
  ok('D8-1 ★exNote が偽：メモのある記録は保存せず理由を出す（k_editTraining を送らない）', editsSent(sent).length === 0 && w.alerts.some((a) => a.includes('種目のメモがあるため、いまは直せません')), JSON.stringify([w.alerts, editsSent(sent).length]));
}
// ---- D9 前回から写す：種目のメモは写さない（セットのメモと同じ＝その日の出来事） ----
{
  const { w } = boot();
  w.KarteUI.open('C1', NAME, 'training'); await settle();
  const b0 = btn(R(w), '＋ 今日の記録'); if (b0) { b0.click(); await settle(); }
  const pick = R(w).querySelector('button.k-pickgo'); if (pick) { pick.click(); await settle(); }
  const cp = btn(R(w), '種目だけ写す') || btn(R(w), '重量・回数ごと写す'); if (cp) { cp.click(); await nav(); }
  const it = itemOf(w, '腸腰筋ストレッチ');
  ok('D9-1 前回から写す：数字の無い種目は写るがメモは写さない', !!it && !('note' in it), JSON.stringify((draftOf(w) || {}).items));
}

console.log(`liff-karte-doneonly-note: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
