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
//   初回の一覧（k_training）と、別の窓口の全期間の集計（k_trainingAll）。extra.agg が無ければ集計の窓口は無い（古い Worker）として 400
const AGG_KEYS = ['agg', 'bestAll', 'seriesAll', 'seriesFrom', 'allDates'];
const first = (extra) => (b) => {
  const e = extra || {};
  if (b.action === 'k_trainingAll') return e.agg ? Object.assign({ success: true }, ...AGG_KEYS.filter((k) => k in e).map((k) => ({ [k]: e[k] }))) : { success: false, code: 'BAD_REQUEST' };
  if (b.action === 'k_training' && !b.cursor && !b.before && !b.sessionId && !b.older) {
    const base = { success: true, karteSchema: 33, aiDraft: false, trainingEdit: true, sessions: [S1(), S2(), S3()], best: [] };
    Object.keys(e).forEach((k) => { if (AGG_KEYS.indexOf(k) < 0) base[k] = e[k]; });
    return base;
  }
  return undefined;
};
async function openTab(w) { w.KarteUI.open('C1', NAME, 'training'); await settle(); }
const dayRows = (w) => [...R(w).querySelectorAll('.k-daycard .k-dayrow')].map((r) => r.textContent.split('(')[0]);
const oldRows = (w) => [...R(w).querySelectorAll('.k-oldcard .k-dayrow:not(.k-oldtoggle)')].map((r) => r.textContent.split('(')[0]);
const oldToggle = (w) => R(w).querySelector('.k-oldcard .k-oldtoggle');
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

// ================= L4 直近3か月の続き（R）・3か月より前（older → O）（§4-3・§4-5） =================
{
  //   L4a：直近3か月が100回を超えたときの続き（R）。3か月より前は無い
  let failNext = false;
  const { w, sent } = boot((b) => {
    if (b.action === 'k_training' && b.cursor) return failNext ? { success: false, code: 'UNAVAILABLE' } : { success: true, karteSchema: 33, sessions: [S3(), { ...S3(), session_id: 'S3b', session_date: '2026-10-05' }], best: [], boundary: '2026-09-01', more: false, nextCursor: null };
    return first({ boundary: '2026-09-01', more: true, nextCursor: 'R|2026-09-01|2026-11-10|80|S3', older: false })(b);
  });
  await openTab(w);
  ok('L4a ★見出しは「日別の記録（直近3か月）」・3か月より前の行は出ない（older が偽）', txt(w).includes('日別の記録（直近3か月）') && !oldToggle(w));
  failNext = true;
  btn(w, '続きを見る（直近3か月）').click(); await settle();
  ok('L4a ★読めなかったら「読めませんでした」・読んだ分は残る・ボタンも残る', txt(w).includes('読めませんでした（もう一度押してください）') && dayRows(w).length === 3 && !!btn(w, '続きを見る（直近3か月）'));
  failNext = false;
  btn(w, '続きを見る（直近3か月）').click(); await settle();
  const sc = sent.filter((b) => b.cursor);
  ok('L4a ★送るのは前の応答の R のカーソルだけ・足した回が出る・同じ id は足さない・読み切ったらボタンが消える', sc.length === 2 && sc[1].cursor === 'R|2026-09-01|2026-11-10|80|S3' && !('older' in sc[1])
     && JSON.stringify(dayRows(w)) === JSON.stringify(['11/20', '11/18', '11/10', '10/5']) && !btn(w, '続きを見る（直近3か月）'), JSON.stringify(dayRows(w)));
}
{
  //   L4b：3か月より前（境界 10/1・9/20 の回と、もっと前）
  let mode = 'ok';
  const S00 = () => ({ ...S0(), session_id: 'S00', session_date: '2026-08-02' });
  const { w, sent } = boot((b) => {
    if (b.action === 'k_training' && b.older === true) return mode === 'fail' ? { success: false, code: 'UNAVAILABLE' } : { success: true, karteSchema: 33, sessions: [S0()], best: [], boundary: '2026-10-01', more: true, nextCursor: 'O|2026-10-01|2026-09-20|10|S0' };
    if (b.action === 'k_training' && b.cursor) return mode === 'moved' ? { success: false, code: 'BOUNDARY_MOVED' } : { success: true, karteSchema: 33, sessions: [S0(), S00()], best: [], boundary: '2026-10-01', more: false, nextCursor: null };
    return first({ boundary: '2026-10-01', more: false, nextCursor: null, older: true })(b);
  });
  await openTab(w);
  ok('L4b ★畳んだ「3か月より前の記録（10月より前）」が出て、開くまで読まない', !!oldToggle(w) && oldToggle(w).textContent.includes('10月より前') && sent.filter((b) => b.older).length === 0 && oldRows(w).length === 0);
  mode = 'fail';
  oldToggle(w).click(); await settle();
  ok('L4b ★読めなかったら「読めませんでした」＋もう一度読む', txt(w).includes('読めませんでした（もう一度押してください）') && !!btn(w, 'もう一度読む'));
  mode = 'ok';
  btn(w, 'もう一度読む').click(); await settle();
  const so = sent.filter((b) => b.older);
  ok('L4b ★最初は older:true だけ（cursor・before を付けない）・3か月より前の回は畳みの中に出て、直近3か月の一覧には混ざらない', so.length === 2 && so[1].older === true && !('cursor' in so[1]) && !('before' in so[1])
     && JSON.stringify(oldRows(w)) === JSON.stringify(['9/20']) && JSON.stringify(dayRows(w)) === JSON.stringify(['11/20', '11/18', '11/10']), JSON.stringify([oldRows(w), dayRows(w)]));
  btn(w, 'もっと前を見る（20回ずつ）').click(); await settle();
  const sc = sent.filter((b) => b.cursor);
  ok('L4b ★続きは O のカーソル・同じ id は足さない・読み切ったらボタンが消える', sc.length === 1 && sc[0].cursor === 'O|2026-10-01|2026-09-20|10|S0' && JSON.stringify(oldRows(w)) === JSON.stringify(['9/20', '8/2']) && !btn(w, 'もっと前を見る'), JSON.stringify(oldRows(w)));
  //   ★3か月より前を読んだ後に直近3か月の一覧を描き直しても、3か月より前の回が混ざらない（一覧の配列には足している）
  R(w).querySelector('.k-daycard .k-dayrow').click(); await settle();
  ok('L4b ★3か月より前を読んだ後に直近3か月の一覧を描き直しても混ざらない', JSON.stringify(dayRows(w)) === JSON.stringify(['11/20', '11/18', '11/10']), JSON.stringify(dayRows(w)));
  [...R(w).querySelectorAll('.k-oldcard .k-dayrow:not(.k-oldtoggle)')][1].click(); await settle();
  ok('L4b ★3か月より前の回にも［編集］が出る（作者）', !!R(w).querySelector('.k-oldcard button.k-dayedit'));
}
{
  //   L4c：月が替わった（409）→ 初回から読み直す
  const { w, sent } = boot((b) => {
    if (b.action === 'k_training' && b.older === true) return { success: false, code: 'BOUNDARY_MOVED' };
    return first({ boundary: '2026-10-01', more: false, older: true })(b);
  });
  await openTab(w);
  const n0 = sent.filter((b) => b.action === 'k_training' && !b.older && !b.cursor).length;
  oldToggle(w).click(); await settle();
  ok('L4c ★409 BOUNDARY_MOVED なら初回から読み直す', sent.filter((b) => b.action === 'k_training' && !b.older && !b.cursor).length === n0 + 1);
}
{
  //   L4d：直近3か月が0回で3か月より前がある
  const { w } = boot(first({ sessions: [], boundary: '2026-10-01', more: false, older: true }));
  await openTab(w);
  ok('L4d ★直近3か月が0回でも「まだ記録がありません」と言わず、「直近3か月の記録はありません」＋3か月より前の畳み', !txt(w).includes('まだ記録がありません') && txt(w).includes('直近3か月の記録はありません') && !!oldToggle(w));
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
  const { w: w7, sent: s7 } = boot((b) => (b.action === 'k_training' && b.before) ? { success: true, karteSchema: 33, sessions: [S0()], best: [], more: false, nextCursor: null } : first({ sessions: [], boundary: '2026-10-01', more: false, older: true })(b));
  w7.localStorage.setItem('karte_tr_draft_v1:T1:C1', JSON.stringify({ v: 1, tid: 'T1', cid: 'C1', sessionDate: '2026-10-01', items: [{ exercise: 'スクワット', sets: [{ w: '', r: '', done: false }] }], reqId: 'rq1', pending: null, at: Date.now() }));
  await openTab(w7); await settle();
  ok('L6 ★直近3か月が0回で3か月より前がある → 読み足して前回を出す（読んだ回が無いことを「全部読んだ」と取り違えない）', s7.filter((b) => b.before === '2026-10-01').length === 1 && txt(w7).includes('前回 9/20：70kg × 5'));
  const n = await formAt('2026-11-19', () => ({ success: true, sessions: [] }));
  ok('L6 日付が読んだ回の中（11/19）なら読み足さない・前回は 11/18', n.sent.filter((b) => b.before).length === 0 && txt(n.w).includes('前回 11/18：60kg × 8'));
}

// ================= L7 指導の履歴：直近3か月・続き（R）・3か月より前のメモ（older → O） =================
{
  const note = (id, d, body) => ({ note_id: id, session_date: d, condition: null, body, next_plan: null, tag: 'training', reasons: [], next_check: null, author_trainer_id: 'T1', rev: 1, created_at: 1, edited_at: null });
  const { w, sent } = boot((b) => {
    if (b.action !== 'k_notes') return undefined;
    if (b.older === true) return { success: true, karteSchema: 33, notes: [note('N0', '2026-09-01', '見本の古いメモ')], boundary: '2026-10-01', more: false, nextCursor: null };
    if (b.cursor) return { success: true, karteSchema: 33, notes: [note('N2', '2026-10-03', '見本の続きのメモ')], boundary: '2026-10-01', more: false, nextCursor: null };
    return { success: true, karteSchema: 33, notes: [note('N1', '2026-11-20', '見本の新しいメモ')], boundary: '2026-10-01', more: true, nextCursor: 'R|2026-10-01|2026-11-20|1|N1', older: true };
  });
  w.KarteUI.open('C1', NAME, 'notes'); await settle();
  const toggle = () => R(w).querySelector('.k-oldnotes .k-oldtoggle');
  ok('L7 ★直近3か月のメモだけが出て、3か月より前は畳み（10月より前）・開くまで読まない', txt(w).includes('見本の新しいメモ') && !txt(w).includes('見本の古いメモ') && !!toggle() && toggle().textContent.includes('10月より前') && !sent.some((b) => b.older));
  btn(w, '続きを見る（直近3か月）').click(); await settle();
  ok('L7 ★続きは R のカーソル・足したメモが出る', sent.some((b) => b.action === 'k_notes' && b.cursor === 'R|2026-10-01|2026-11-20|1|N1') && txt(w).includes('見本の続きのメモ') && !btn(w, '続きを見る'));
  toggle().click(); await settle();
  ok('L7 ★開くと older:true で読み、3か月より前のメモが畳みの中に出る', sent.some((b) => b.action === 'k_notes' && b.older === true && !b.cursor) && R(w).querySelector('.k-oldnotes').textContent.includes('見本の古いメモ'));
  const { w: w2 } = boot((b) => (b.action === 'k_notes' ? { success: true, karteSchema: 33, notes: [{ note_id: 'X', session_date: '2026-11-01', condition: null, body: '見本', next_plan: null, tag: null, reasons: [], next_check: null, author_trainer_id: 'T1', rev: 1, created_at: 1, edited_at: null }] } : undefined));
  w2.KarteUI.open('C1', NAME, 'notes'); await settle();
  ok('L7 古い Worker（境界なし）は今までどおり（畳み・「直近3か月」の見出しなし）', !R(w2).querySelector('.k-oldnotes') && !txt(w2).includes('直近3か月'));
}

// ================= L8 ［編集］の二重押し・応答の逆転（関門② 中1） =================
{
  const pend = [];
  const { w, sent } = boot((b) => {
    if (b.action === 'k_training' && b.sessionId) return new Promise((res) => pend.push({ b, res }));
    return first()(b);
  });
  //   身代わりの fetch は Promise の応答も待つ
  const f0 = w.fetch;
  w.fetch = async (url, opt) => { const body = JSON.parse(opt.body); const r0 = w.handle(body); if (r0 && typeof r0.then === 'function') { sent.push(body); const v = await r0; return { json: async () => JSON.parse(JSON.stringify(v)) }; } return f0(url, opt); };
  await openTab(w);
  [...R(w).querySelectorAll('.k-daycard .k-dayrow')].find((r) => r.textContent.indexOf('11/20') === 0).click(); await settle();
  const eb = R(w).querySelector('button.k-dayedit');
  eb.click(); eb.click(); await settle();
  ok('L8 ★同じ記録の［編集］を素早く2回押しても、読み直しは1本だけ', sent.filter((b) => b.action === 'k_training' && b.sessionId).length === 1, String(sent.filter((b) => b.sessionId).length));
  pend[0].res({ success: true, karteSchema: 33, trainingEdit: true, trace: 'live', extra: S1() }); await settle();
  ok('L8 応答のあと直す画面が1つだけ開く', R(w).querySelectorAll('.k-trform').length === 1, String(R(w).querySelectorAll('.k-trform').length));
}
{
  //   別の記録を続けて押す → 後から押した方だけで画面を作る（前の応答が遅れて来ても捨てる）
  const pend = [];
  const { w, sent } = boot((b) => (b.action === 'k_training' && b.sessionId) ? new Promise((res) => pend.push({ b, res })) : first()(b));
  const f0 = w.fetch;
  w.fetch = async (url, opt) => { const body = JSON.parse(opt.body); const r0 = w.handle(body); if (r0 && typeof r0.then === 'function') { sent.push(body); const v = await r0; return { json: async () => JSON.parse(JSON.stringify(v)) }; } return f0(url, opt); };
  await openTab(w);
  const box = R(w).querySelector('.k-daycard').closest('#karteRoot');
  [...R(w).querySelectorAll('.k-daycard .k-dayrow')].find((r) => r.textContent.indexOf('11/20') === 0).click(); await settle();
  R(w).querySelector('button.k-dayedit').click(); await settle();
  //   読み込み中の画面から戻って別の日の［編集］を押す身代わり：openEditFresh を直接2回目として呼ぶ代わりに、一覧を開き直して別の日を押す
  w.KarteUI.open('C1', NAME, 'training'); await settle();
  [...R(w).querySelectorAll('.k-daycard .k-dayrow')].find((r) => r.textContent.indexOf('11/18') === 0).click(); await settle();
  R(w).querySelector('button.k-dayedit').click(); await settle();
  const s2 = pend.find((p) => p.b.sessionId === 'S2'), s1 = pend.find((p) => p.b.sessionId === 'S1');
  s2.res({ success: true, karteSchema: 33, trainingEdit: true, trace: 'live', extra: S2() }); await settle();
  s1.res({ success: true, karteSchema: 33, trainingEdit: true, trace: 'live', extra: S1() }); await settle();
  const ed = JSON.parse(w.localStorage.getItem('karte_tr_edit_v1:T1:C1') || 'null');
  ok('L8 ★応答が逆転しても、後から押した記録（11/18）で画面ができ、遅れた前の応答で作り直さない', txt(w).includes('11/18') && ed && ed.editOf === 'S2' && R(w).querySelectorAll('.k-trform').length === 1, JSON.stringify([ed && ed.editOf, txt(w).includes('11/18'), R(w).querySelectorAll('.k-trform').length, txt(w).slice(0, 120)]));
}

{
  //   L8c：読み込み中に別のタブへ移る／一覧を開き直す → 遅れた応答で直す画面を作らない（関門② 第2周 中）
  for (const how of ['tab', 'reopen']) {
    const pend = [];
    const { w, sent } = boot((b) => (b.action === 'k_training' && b.sessionId) ? new Promise((res) => pend.push({ b, res })) : (b.action === 'k_notes' ? { success: true, karteSchema: 33, notes: [] } : first()(b)));
    const f0 = w.fetch;
    w.fetch = async (url, opt) => { const body = JSON.parse(opt.body); const r0 = w.handle(body); if (r0 && typeof r0.then === 'function') { sent.push(body); const v = await r0; return { json: async () => JSON.parse(JSON.stringify(v)) }; } return f0(url, opt); };
    await openTab(w);
    [...R(w).querySelectorAll('.k-daycard .k-dayrow')].find((r) => r.textContent.indexOf('11/20') === 0).click(); await settle();
    R(w).querySelector('button.k-dayedit').click(); await settle();
    w.KarteUI.open('C1', NAME, how === 'tab' ? 'notes' : 'training'); await settle();
    pend[0].res({ success: true, karteSchema: 33, trainingEdit: true, trace: 'live', extra: S1() }); await settle();
    ok('L8c ★読み込み中に' + (how === 'tab' ? '別のタブへ移った' : '一覧を開き直した') + '後の遅れた応答で直す画面を作らない', R(w).querySelectorAll('.k-trform').length === 0 && !txt(w).includes('の記録を直す'), String(R(w).querySelectorAll('.k-trform').length));
  }
}

{
  //   L8d：別のタブへ移り、トレーニングへ戻った一覧の応答が来る前に、離れる前の［編集］の応答が来ても作らない（関門② 第3周 中）
  const pend = [], lists = [];
  let hold = false;
  const { w, sent } = boot((b) => {
    if (b.action === 'k_training' && b.sessionId) return new Promise((res) => pend.push({ b, res }));
    if (b.action === 'k_training' && !b.cursor && !b.before && !b.older && hold) return new Promise((res) => lists.push(res));
    if (b.action === 'k_notes') return { success: true, karteSchema: 33, notes: [] };
    return first()(b);
  });
  const f0 = w.fetch;
  w.fetch = async (url, opt) => { const body = JSON.parse(opt.body); const r0 = w.handle(body); if (r0 && typeof r0.then === 'function') { sent.push(body); const v = await r0; return { json: async () => JSON.parse(JSON.stringify(v)) }; } return f0(url, opt); };
  await openTab(w);
  [...R(w).querySelectorAll('.k-daycard .k-dayrow')].find((r) => r.textContent.indexOf('11/20') === 0).click(); await settle();
  R(w).querySelector('button.k-dayedit').click(); await settle();
  w.KarteUI.open('C1', NAME, 'notes'); await settle();
  hold = true;
  w.KarteUI.open('C1', NAME, 'training'); await settle();   // 一覧の応答はまだ（lists に待たせる）
  hold = false;
  pend[0].res({ success: true, karteSchema: 33, trainingEdit: true, trace: 'live', extra: S1() }); await settle();
  ok('L8d ★戻った一覧の応答の前に届いた、離れる前の［編集］の応答で直す画面を作らない', R(w).querySelectorAll('.k-trform').length === 0 && !txt(w).includes('の記録を直す'), String(R(w).querySelectorAll('.k-trform').length));
  lists.forEach((res) => res({ success: true, karteSchema: 33, aiDraft: false, trainingEdit: true, sessions: [S1(), S2(), S3()], best: [] })); await settle();
  ok('L8d 一覧はその後ふつうに出る', dayRows(w).length === 3);
}

console.log(`${fail ? '❌' : '✅'} 記録の全期間表示（設計62 段1・画面） 検証: ${pass} passed / ${fail} failed`);
if (fail) process.exit(1);
