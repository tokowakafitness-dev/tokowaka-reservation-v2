// 設計62 段1（記録の全期間表示）：本番の liff/karte.js を jsdom で動かし、トレーニングのタブ・日別の記録・［編集］・記録の画面から通して値で確かめる・2026-11-26
//   実行: node worker/test/liff-karte-past-paging.test.js
//   ★身代わりは fetch（Worker）・LINE の SDK だけ。名前・ID はすべて架空
//   ★Worker の答え方は worker/test/karte-past-paging.test.js が本物の SQLite で固定している。ここは画面がそれをどう使うか

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

const set = (sid, ex, no, w, r) => ({ session_id: sid, exercise: ex, set_no: no, weight_kg: w, reps: r, note: null });
const S1 = () => ({ session_id: 'S1', session_date: '2026-11-20', created_at: 100, author_trainer_id: 'T1', rev: 1, sets: [set('S1', 'ベンチプレス', 1, 50, 10)] });
const S2 = () => ({ session_id: 'S2', session_date: '2026-11-18', created_at: 90, author_trainer_id: 'T1', rev: 1, sets: [set('S2', 'スクワット', 1, 60, 8)] });
const S3 = () => ({ session_id: 'S3', session_date: '2026-11-10', created_at: 80, author_trainer_id: 'T1', rev: 1, sets: [set('S3', 'スクワット', 1, 60, 8)] });   // 同点（60×8）の早い日
const S0 = () => ({ session_id: 'S0', session_date: '2026-09-20', created_at: 10, author_trainer_id: 'T1', rev: 1, sets: [set('S0', 'スクワット', 1, 70, 5)] });

function boot(handle) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'https://reservation.tokowaka-gym.com/liff/', pretendToBeVisual: true }); dom.window.__KARTE_REST_UI = true;
  const w = dom.window;
  const sent = [];
  w.idToken = jwt(30);
  w.EDGE_URL = 'https://edge.example';
  w.state = { trainerId: 'T1', _isOwner: false, _allTrainers: [{ id: 'T1', name: '一郎' }] };
  w.alerts = []; w.alert = (m) => w.alerts.push(String(m));
  w.confirms = []; w.confirm = (m) => { w.confirms.push(String(m)); return true; };
  w.__karteReload = () => {};
  w.liff = { getIDToken: () => w.idToken, logout: () => {} };
  w.handle = handle;
  w.fetch = async (url, opt) => {
    const body = JSON.parse(opt.body);
    sent.push(body);
    let r = w.handle(body);
    if (r === undefined) {
      if (body.action === 'k_exercises') r = { success: true, karteSchema: 33, exercises: [], truncated: false };
      else if (body.action === 'k_summary') r = { success: true, karteSchema: 33, customer: { name: NAME, trainerId: 'T1' }, hearing: null, consent: { state: 'agreed' } };
      else r = { success: true };
    }
    return { json: async () => JSON.parse(JSON.stringify(r)) };
  };
  w.eval(SRC);
  return { w, sent };
}
const R = (w) => w.document.getElementById('karteRoot');
const txt = (w) => (R(w) ? R(w).textContent : '');
const btn = (w, t) => [...R(w).querySelectorAll('button')].find((x) => x.textContent.indexOf(t) === 0);
const first = (extra) => (b) => (b.action === 'k_training' && !b.cursor && !b.before && !b.sessionId)
  ? Object.assign({ success: true, karteSchema: 33, aiDraft: false, trainingEdit: true, sessions: [S1(), S2(), S3()], best: [] }, extra || {}) : undefined;
async function openTab(w) { w.KarteUI.open('C1', NAME, 'training'); await settle(); }
const dayRows = (w) => [...R(w).querySelectorAll('.k-dayrow')].map((r) => r.textContent.split('(')[0]);
async function pick(w, ex) { const b = [...R(w).querySelectorAll('.k-pill')].find((x) => x.textContent === ex); if (b) { b.click(); await settle(); } return !!b; }
const bestText = (w) => { const b = R(w).querySelector('.k-trbest'); return b ? b.textContent : ''; };

// ================= L1 古い Worker（集計・more の鍵が無い）：読んだ回の中で計算し「直近◯回の中」・同点は早い日（I66・I94） =================
{
  const { w, sent } = boot(first());
  await openTab(w);
  await pick(w, 'スクワット');
  ok('L1 ★古い Worker は読んだ回の中で計算し「直近3回の中」と書く（全期間と言わない）・同点（60×8）は早い日 11/10', bestText(w) === '自己ベスト 60kg × 8（11/10・直近3回の中）', bestText(w));
  ok('L1 もっと前のボタンは出ない（more が分からない）', !btn(w, 'もっと前の記録を見る') && sent.filter((b) => b.cursor).length === 0);
}

// ================= L2 全期間の集計がある：20回の外にしか無い種目も選べる・自己ベストは集計から・推移の打ち切りの注記 =================
{
  const agg = { agg: { best: 'ok', series: 'truncated', dates: 'ok' }, seriesFrom: '2025-03-01',
    bestAll: [{ exercise: 'スクワット', w: 100, r: 5, d: '2025-04-01' }, { exercise: 'ベンチプレス', w: 50, r: 10, d: '2026-11-20' }, { exercise: 'レッグプレス', w: 140, r: 8, d: '2025-03-01' }],
    seriesAll: [{ d: '2025-03-01', exercise: 'レッグプレス', e1rm: 177.3 }, { d: '2025-04-01', exercise: 'スクワット', e1rm: 116.7 }], allDates: [] };
  const { w } = boot(first(agg));
  await openTab(w);
  const has = await pick(w, 'レッグプレス');
  ok('L2 ★20回の外にしか無い種目（レッグプレス）が推移の種目に出て、自己ベストは全期間の値（注記なし）', has && bestText(w) === '自己ベスト 140kg × 8（3/1）', bestText(w));
  ok('L2 推移を打ち切ったときは「推移は 3/1 から」', txt(w).includes('推移は 3/1 から'));
  await pick(w, 'スクワット');
  ok('L2 ★読んだ回の中（60×8）ではなく全期間の自己ベスト（100×5）', bestText(w) === '自己ベスト 100kg × 5（4/1）', bestText(w));
}

// ================= L3 集計の一部が unavailable（null）：その集計だけ読んだ回の中に戻る =================
{
  const { w } = boot(first({ agg: { best: 'unavailable', series: 'ok', dates: 'ok' }, bestAll: null, seriesAll: [], seriesFrom: null, allDates: [] }));
  await openTab(w);
  await pick(w, 'スクワット');
  ok('L3 ★bestAll が null（unavailable）なら「直近3回の中」で出す（空＝記録なしと扱わない）', bestText(w) === '自己ベスト 60kg × 8（11/10・直近3回の中）', bestText(w));
}

// ================= L4 もっと前の記録を見る（§4-4） =================
{
  let failNext = false;
  const { w, sent } = boot((b) => {
    if (b.action === 'k_training' && b.cursor) return failNext ? { success: false, code: 'UNAVAILABLE' } : { success: true, karteSchema: 33, sessions: [S3(), S0()], best: [], more: false, nextCursor: null };
    return first({ more: true, nextCursor: '2026-11-10|80|S3' })(b);
  });
  await openTab(w);
  const before = dayRows(w);
  failNext = true;
  btn(w, 'もっと前の記録を見る').click(); await settle();
  ok('L4 ★読めなかったら「読めませんでした」・読んだ分は残る・ボタンも残る', txt(w).includes('読めませんでした（もう一度押してください）') && JSON.stringify(dayRows(w)) === JSON.stringify(before) && !!btn(w, 'もっと前の記録を見る'));
  failNext = false;
  btn(w, 'もっと前の記録を見る').click(); await settle();
  const sc = sent.filter((b) => b.cursor);
  ok('L4 ★送るのは前の応答の nextCursor（cursor だけ）', sc.length === 2 && sc[1].cursor === '2026-11-10|80|S3' && !('before' in sc[1]) && !('sessionId' in sc[1]));
  ok('L4 ★足した回が日別の記録に出る・同じ session_id は足さない・最後まで読んだらボタンは消える', JSON.stringify(dayRows(w)) === JSON.stringify(['11/20', '11/18', '11/10', '9/20']) && !btn(w, 'もっと前の記録を見る'), JSON.stringify(dayRows(w)));
  const mb = before.length === 3;
  ok('L4 最初は3回', mb);
}

// ================= L5 ［編集］は押すたびに1件読み直す（§4-5・I95・P15） =================
async function editVia(oneRes) {
  const { w, sent } = boot((b) => (b.action === 'k_training' && b.sessionId) ? oneRes(b) : first()(b));
  await openTab(w);
  [...R(w).querySelectorAll('.k-dayrow')].find((r) => r.textContent.indexOf('11/20') === 0).click(); await settle();
  R(w).querySelector('button.k-dayedit').click(); await settle();
  return { w, sent };
}
{
  const n = { ...S1(), session_id: 'S1n', rev: 1, sets: [set('S1n', 'ベンチプレス', 1, 55, 10)] };
  const a = await editVia(() => ({ success: true, karteSchema: 33, trainingEdit: true, trace: 'replaced', extra: n, replacedFrom: 'S1' }));
  const ed = JSON.parse(a.w.localStorage.getItem('karte_tr_edit_v1:T1:C1') || 'null');
  ok('L5 ★古い一覧の行の［編集］は sessionId で読み直す', a.sent.some((b) => b.action === 'k_training' && b.sessionId === 'S1' && !b.cursor && !b.before));
  ok('L5 ★置き換わっていれば新しい版（S1n・55kg）で開き、知らせを1行出す', txt(a.w).includes('ほかで直された新しい版を開きました') && ed && ed.editOf === 'S1n' && txt(a.w).includes('11/20') , JSON.stringify(ed && ed.editOf));
  const d = await editVia(() => ({ success: true, karteSchema: 33, trace: 'deleted', extra: null }));
  ok('L5 deleted だけ「この記録はもうありません」', txt(d.w).includes('この記録はもうありません'));
  const b = await editVia(() => ({ success: true, karteSchema: 33, trace: 'broken', extra: null }));
  ok('L5 ★broken は「新しい版を確かめられませんでした」（もうありませんと言わない）', txt(b.w).includes('新しい版を確かめられませんでした') && !txt(b.w).includes('もうありません'));
  const e = await editVia(() => ({ success: false, code: 'UNAVAILABLE' }));
  ok('L5 ★読み直しの失敗は「読めませんでした」＋もう一度読む（もうありませんと言わない）', txt(e.w).includes('読めませんでした') && !txt(e.w).includes('もうありません') && !!btn(e.w, 'もう一度読む'));
  const o = await editVia(() => ({ success: true, karteSchema: 33, sessions: [S1()], best: [] }));
  ok('L5 ★trace の鍵が無い（古い Worker）も「読めませんでした」', txt(o.w).includes('読めませんでした') && !txt(o.w).includes('もうありません'));
}

// ================= L6 記録の画面：日付が読んだ回より古いと、その日より前を読み足して「前回」を出す（§4-6・I59） =================
async function formAt(date, beforeRes) {
  const { w, sent } = boot((b) => (b.action === 'k_training' && b.before) ? beforeRes(b) : first({ more: true, nextCursor: '2026-11-10|80|S3' })(b));
  w.localStorage.setItem('karte_tr_draft_v1:T1:C1', JSON.stringify({ v: 1, tid: 'T1', cid: 'C1', sessionDate: date, items: [{ exercise: 'スクワット', sets: [{ w: '', r: '', done: false }] }], reqId: 'rq1', pending: null, at: Date.now() }));
  await openTab(w); await settle();
  return { w, sent };
}
{
  const a = await formAt('2026-10-01', () => ({ success: true, karteSchema: 33, sessions: [S0()], best: [], more: false, nextCursor: null }));
  const sb = a.sent.filter((b) => b.before);
  ok('L6 ★日付（10/1）が読んだ回の最も古い日（11/10）以前 → before:10/1 で読み足す（cursor ではない）', sb.length === 1 && sb[0].before === '2026-10-01' && !('cursor' in sb[0]));
  ok('L6 ★読み足した回から前回（9/20 の 70kg×5）を出す', txt(a.w).includes('前回 9/20：70kg × 5'), txt(a.w).slice(0, 400));
  const f = await formAt('2026-10-01', () => ({ success: false, code: 'UNAVAILABLE' }));
  ok('L6 ★読み足しの失敗は「前回：読み込めていません」（前回なしと言わない）', txt(f.w).includes('前回：読み込めていません') && !txt(f.w).includes('前回の記録なし'));
  const n = await formAt('2026-11-19', () => ({ success: true, sessions: [] }));
  ok('L6 日付が読んだ回の中（11/19）なら読み足さない・前回は 11/18', n.sent.filter((b) => b.before).length === 0 && txt(n.w).includes('前回 11/18：60kg × 8'));
}

console.log(`${fail ? '❌' : '✅'} 記録の全期間表示（設計62 段1・画面） 検証: ${pass} passed / ${fail} failed`);
if (fail) process.exit(1);
