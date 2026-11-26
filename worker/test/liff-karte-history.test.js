// 設計62 段2（過去のまとめ・まとめ待ち・月ごとの1行）：本番の liff/karte.js を jsdom で動かし、指導の履歴とトレーニングのタブから通して値で確かめる・2026-11-26
//   実行: node worker/test/liff-karte-history.test.js
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


const note = (id, d, body) => ({ note_id: id, session_date: d, condition: null, body, next_plan: null, tag: null, reasons: [], next_check: null, author_trainer_id: 'T1', rev: 1, created_at: 1, edited_at: null });
const HIST = [{ id: 'D1', from: '2025-03', to: '2025-08', body: '一行目\n二行目\n三行目\n四行目の見本', origin: 'import', rev: 2, updatedBy: 'T1', updatedAt: 1 }];
const notesFirst = (extra) => ({ success: true, karteSchema: 33, notes: [note('N1', '2026-11-20', '見本の最近のメモ')], boundary: '2026-09-01', more: false, nextCursor: null, older: true,
  history: HIST, pendingMonths: [{ month: '2026-08', n: 2 }], agg: { history: 'ok', pending: 'ok' }, ...(extra || {}) });
async function openNotes(w) { w.KarteUI.open('C1', NAME, 'notes'); await settle(); }
const hcard = (w) => R(w).querySelector('.k-history');

// ================= HU1 指導の履歴に「過去のまとめ」とまとめ待ち・読めない・古い Worker =================
{
  const { w } = boot((b) => (b.action === 'k_notes' && !b.month && !b.cursor && !b.older ? notesFirst() : undefined));
  await openNotes(w);
  const c = hcard(w);
  ok('HU1 ★過去のまとめ：期間の見出し（取り込み）・本文・まとめ待ち（メモ件数）・［＋ まとめを書く］', !!c && c.textContent.includes('2025年3月〜2025年8月（取り込み）') && c.textContent.includes('四行目の見本')
     && c.textContent.includes('まとめ待ち：2026年8月') && c.textContent.includes('メモ 2件') && !!c.querySelector('.k-hnew'), c && c.textContent);
  const hb = c.querySelector('.k-hbody');
  ok('HU1 本文は3行で畳み、［全文］で開く', hb.classList.contains('k-hclamp'));
  c.querySelector('.k-hfull').click(); await settle();
  ok('HU1 全文を押すと畳みが外れる', !hcard(w).querySelector('.k-hbody').classList.contains('k-hclamp'));
  const btns = [...c.querySelectorAll('.k-hfull,.k-hedit,.k-hpending,.k-hnew')].map((x) => x.getAttribute('style') || '');
  ok('HU1 押すところは全部 44px 以上', btns.length === 4 && btns.every((s2) => /min-height:\s*44px/.test(s2)), JSON.stringify(btns));
  const pos = (sel) => [...R(w).querySelectorAll('.k-tl > *')].findIndex((x) => x.matches(sel));
  ok('HU1 並び：直近3か月のメモ → 過去のまとめ → 3か月より前のメモ', pos('.k-history') > 0 && pos('.k-oldnotes') > pos('.k-history'));
}
{
  const { w } = boot((b) => (b.action === 'k_notes' ? notesFirst({ history: null, pendingMonths: null, agg: { history: 'unavailable', pending: 'unavailable' } }) : undefined));
  await openNotes(w);
  ok('HU1 ★読めない（null）は「まとめを読めませんでした」・「まだありません」と言わない', hcard(w).textContent.includes('まとめを読めませんでした') && !hcard(w).textContent.includes('まだありません'));
  const { w: w2 } = boot((b) => (b.action === 'k_notes' ? notesFirst({ history: [], pendingMonths: [] }) : undefined));
  await openNotes(w2);
  ok('HU1 0件は「まだありません（原本は…）」', hcard(w2).textContent.includes('まだありません（原本は「3か月より前のメモ」から見られます）'));
  const old = notesFirst(); delete old.history; delete old.pendingMonths; delete old.agg;
  const { w: w3 } = boot((b) => (b.action === 'k_notes' ? old : undefined));
  await openNotes(w3);
  ok('HU1 古い Worker（鍵が無い）は出さない', !hcard(w3));
}

// ================= HU2 まとめ待ち → その月のメモを上に並べた書く画面 → k_saveHistory =================
{
  let failSave = true;
  const { w, sent } = boot((b) => {
    if (b.action === 'k_notes' && b.month) return { success: true, karteSchema: 33, notes: [note('M1', '2026-08-03', '見本の八月のメモ')], more: true, nextCursor: 'M|2026-08|2026-08-03|1|M1', month: '2026-08' };
    if (b.action === 'k_notes' && b.cursor) return { success: true, karteSchema: 33, notes: [note('M2', '2026-08-01', '見本の八月の続き')], more: false, nextCursor: null };
    if (b.action === 'k_notes') return notesFirst();
    if (b.action === 'k_saveHistory') return failSave ? { success: false, code: 'RATE_LIMITED' } : { success: true, digestId: 'NEW', rev: 1 };
    return undefined;
  });
  await openNotes(w);
  hcard(w).querySelector('.k-hpending').click(); await settle();
  ok('HU2 ★その月の指導メモを month で読み、上に並べる・期間は その月〜その月', sent.some((b) => b.action === 'k_notes' && b.month === '2026-08' && !b.cursor) && txt(w).includes('見本の八月のメモ')
     && R(w).querySelector('.k-hfrom').value === '2026-08' && R(w).querySelector('.k-hto').value === '2026-08' && txt(w).includes('痛み・診断・服薬はここに書かず'));
  btn(w, '続きを見る（20件ずつ）').click(); await settle();
  ok('HU2 続きは M のカーソル', sent.some((b) => b.action === 'k_notes' && b.cursor === 'M|2026-08|2026-08-03|1|M1') && txt(w).includes('見本の八月の続き'));
  R(w).querySelector('.k-hsave').click(); await settle();
  ok('HU2 本文が空なら送らない', !sent.some((b) => b.action === 'k_saveHistory') && R(w).querySelector('.k-herr').textContent.includes('まとめを入れてください'));
  R(w).querySelector('.k-hta').value = '  見本の八月のまとめ  ';
  R(w).querySelector('.k-hsave').click(); await settle();
  const s1 = sent.filter((b) => b.action === 'k_saveHistory');
  ok('HU2 ★送る：作るのは rev 0・digestId なし・期間・前後の空白を落とした本文・origin trainer', s1.length === 1 && s1[0].rev === 0 && !('digestId' in s1[0]) && s1[0].periodFrom === '2026-08' && s1[0].periodTo === '2026-08'
     && s1[0].body === '見本の八月のまとめ' && s1[0].origin === 'trainer' && s1[0].customerId === 'C1', JSON.stringify(s1[0]));
  ok('HU2 失敗は画面に残り理由を出す', R(w).querySelector('.k-hsub') && R(w).querySelector('.k-herr').style.display !== 'none' && R(w).querySelector('.k-hta').value.includes('見本の八月のまとめ'));
  failSave = false;
  R(w).querySelector('.k-hsave').click(); await settle();
  const s2 = sent.filter((b) => b.action === 'k_saveHistory');
  ok('HU2 ★同じ中身の送り直しは同じ clientReqId（二重にならない）・成功で指導の履歴に戻る', s2.length === 2 && s2[1].clientReqId === s2[0].clientReqId && !R(w).querySelector('.k-hsub'));
}

// ================= HU3 直す・消す・中身を変えたら別の番号 =================
{
  const { w, sent } = boot((b) => {
    if (b.action === 'k_notes') return notesFirst();
    if (b.action === 'k_saveHistory') return { success: false, code: 'CONFLICT' };
    return undefined;
  });
  await openNotes(w);
  hcard(w).querySelector('.k-hedit').click(); await settle();
  ok('HU3 直す画面は今の期間と本文で開く・その月のメモは読まない', R(w).querySelector('.k-hfrom').value === '2025-03' && R(w).querySelector('.k-hto').value === '2025-08' && R(w).querySelector('.k-hta').value === HIST[0].body
     && !sent.some((b) => b.month));
  R(w).querySelector('.k-hta').value = '直した見本';
  R(w).querySelector('.k-hsave').click(); await settle();
  R(w).querySelector('.k-hta').value = '直した見本その2';
  R(w).querySelector('.k-hsave').click(); await settle();
  const s = sent.filter((b) => b.action === 'k_saveHistory');
  ok('HU3 ★直す：digestId と今の rev・中身を変えたら別の番号', s.length === 2 && s[0].digestId === 'D1' && s[0].rev === 2 && s[1].clientReqId !== s[0].clientReqId, JSON.stringify(s));
  ok('HU3 409 は「ほかの人が先に更新しました」', R(w).querySelector('.k-herr').textContent.includes('ほかの人が先に更新しました'));
  R(w).querySelector('.k-hdel').click(); await settle();
  const del = sent.filter((b) => b.action === 'k_saveHistory').pop();
  ok('HU3 消す：確かめてから body 空・期間は送らない', w.confirms.some((m) => m.includes('元のメモと記録は消えません')) && del.body === '' && del.digestId === 'D1' && !('periodFrom' in del));
}

// ================= HU4 トレーニング：3か月より前の上に月ごとの1行 =================
{
  const agg = { agg: { best: 'ok', series: 'ok', dates: 'ok', months: 'ok' }, bestAll: [], seriesAll: [], seriesFrom: null, allDates: [],
    monthsAll: [{ month: '2026-08', sessions: 8, top: ['ベンチプレス', 'スクワット'], best: { exercise: 'スクワット', w: 80, r: 5, d: '2026-08-03' } }, { month: '2026-07', sessions: 1, top: ['ストレッチ'], best: null }] };
  const withMonths = (a) => (b) => (b.action === 'k_trainingAll' ? Object.assign({ success: true }, a) : first({ boundary: '2026-09-01', more: false, nextCursor: null, older: true })(b));
  const { w } = boot(withMonths(agg));
  await openTab(w);
  const rows = [...R(w).querySelectorAll('.k-oldcard .k-trmonth')].map((x) => x.textContent);
  ok('HU4 ★月ごとの1行：回数・主な種目・最高（種目）／最高が無い月は書かない', JSON.stringify(rows) === JSON.stringify(['2026年8月：8回・主な種目 ベンチプレス／スクワット・最高 80kg×5（スクワット）', '2026年7月：1回・主な種目 ストレッチ']), JSON.stringify(rows));
  const kids = [...R(w).querySelector('.k-oldcard').children];
  ok('HU4 月ごとの行は畳みの行の上', kids.findIndex((x) => x.classList.contains('k-trmonth')) < kids.findIndex((x) => x.classList.contains('k-oldtoggle')));
  const { w: w2 } = boot(withMonths({ agg: { best: 'ok', series: 'ok', dates: 'ok', months: 'unavailable' }, bestAll: [], seriesAll: [], seriesFrom: null, allDates: [], monthsAll: null }));
  await openTab(w2);
  ok('HU4 読めないときは月ごとの行を出さない（畳みの行は出る）', !R(w2).querySelector('.k-trmonth') && !!oldToggle(w2));
}

console.log(`${fail ? '❌' : '✅'} 過去のまとめ（設計62 段2・画面） 検証: ${pass} passed / ${fail} failed`);
if (fail) process.exit(1);
