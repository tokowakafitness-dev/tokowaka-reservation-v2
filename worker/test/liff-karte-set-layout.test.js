// セットの書き方と折り返し（2026-11-27 オーナー：前回のカードの種目の記録が崩れる・書き方が不揃い）：本番の liff/karte.js を jsdom で動かし、トレーニングのタブの入り口から通して確かめる
//   実行: node worker/test/liff-karte-set-layout.test.js
//   ★貼る文は架空（共有のプロンプトの出力の形）。名前・ID も架空
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
  try { if (!w.crypto || !w.crypto.subtle) Object.defineProperty(w, 'crypto', { value: globalThis.crypto, configurable: true }); } catch (e) {}
  if (!w.TextEncoder) w.TextEncoder = TextEncoder;
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




const T = () => R0.w.KarteUI._t;
const R0 = boot(() => undefined);
const L = (sets) => T().setLineOf(sets);
const s = (w, r, x) => Object.assign({ weight_kg: w, reps: r }, x || {});

// ================= F 書き方を1つに =================
ok('F1 同じ重さが続く＝「100kg × 15・15」', L([s(100, 15), s(100, 15)]) === '100kg × 15・15', L([s(100, 15), s(100, 15)]));
ok('F2 重さが変わったら区切って次の重さ（毎回は書かない）', L([s(70, 10), s(90, 10), s(100, 15), s(100, 15)]) === '70kg × 10・90kg × 10・100kg × 15・15', L([s(70, 10), s(90, 10), s(100, 15), s(100, 15)]));
ok('F3 自重は「自重 × 10」・自重から重さへ変わっても → を使わない', L([s(0, 10), s(10, 10), s(10, 10)]) === '自重 × 10・10kg × 10・10', L([s(0, 10), s(10, 10), s(10, 10)]));
ok('F4 補助は「+補助7」', L([s(25, 3, { assist_reps: 7 })]) === '25kg × 3+補助7');
ok('F5 できない回は「（無理）」', L([s(80, 5, { forced: true })]) === '80kg × 5（無理）');
ok('F6 ドロップは「（ドロップ 40kg × 8・20kg × 8）」', L([s(60, 10, { drops: [{ weight_kg: 40, reps: 8 }, { weight_kg: 20, reps: 8 }] })]) === '60kg × 10（ドロップ 40kg × 8・20kg × 8）', L([s(60, 10, { drops: [{ weight_kg: 40, reps: 8 }, { weight_kg: 20, reps: 8 }] })]));
ok('F7 印のあるセットは前後とまとめない（どのセットの印か分かる）', L([s(50, 10), s(50, 8, { assist_reps: 2 }), s(50, 6)]) === '50kg × 10・50kg × 8+補助2・50kg × 6', L([s(50, 10), s(50, 8, { assist_reps: 2 }), s(50, 6)]));
ok('F8 小数の重さ・1kg', L([s(1, 15), s(1, 13), s(32.5, 12)]) === '1kg × 15・13・32.5kg × 12');
ok('F9 数字の無い種目は「実施のみ」', L([]) === '実施のみ');
ok('F11 ★重さが空・数でない値は前とまとめない（別の重さを同じに見せない）', L([s(0, 10), s('', 12)]) === '自重 × 10・kg × 12' && L([s(null, 10), s(null, 12)]).split('×').length === 3, L([s(0, 10), s('', 12)]) + ' / ' + L([s(null, 10), s(null, 12)]));
const ALL = [L([s(0, 10), s(10, 10)]), L([s(60, 10, { drops: [{ weight_kg: 40, reps: 8 }] })])].join('');
ok('F10 ★→ を使わない', !/→/.test(ALL) && !/\d×|×\d/.test(ALL), ALL);

// ================= D 画面：前回のカード・日別・推移のチップ =================
const LONG = 'シングルレッグルーマニアンデッドリフトバリエーション';
const sx = (sid, ex, no, w, r, x) => Object.assign({ session_id: sid, exercise: ex, set_no: no, weight_kg: w, reps: r, note: null }, x || {});
//   新しい回の形（種目ごとに ord・set_no は種目の中で1から）
const EXS = [[LONG, [[32, 12], [32, 10]]], ['ヒップスラスト', [[70, 10], [90, 10], [100, 15], [100, 15], [100, 15], [100, 15]]],
  ['懸垂', [[25, 3, { assist_reps: 7 }], [0, 10, { forced: true }]]], ['ベンチプレス', [[60, 10, { drops: [{ weight_kg: 40, reps: 8 }, { weight_kg: 20, reps: 8 }] }]]],
  ['フロアプッシュアブダクション', [[0, 10], [10, 10, { note: '7レップまでフルレンジ' }], [10, 10]]]];
const SESS = () => ({ session_id: 'A1', session_date: '2026-11-27', created_at: 100, author_trainer_id: 'T1', rev: 1,
  exercises: EXS.map((e, i) => ({ ord: i + 1, exercise: e[0], doneOnly: false })),
  sets: EXS.flatMap((e, i) => e[1].map((x, k) => Object.assign(sx('A1', e[0], k + 1, x[0], x[1], x[2]), { ord: i + 1 }))) });
{
  const { w } = boot((b) => {
    if (b.action === 'k_training' && !b.cursor && !b.before && !b.sessionId && !b.older) return { success: true, karteSchema: 33, aiDraft: false, trainingEdit: true, sessions: [SESS()], best: [], boundary: '2026-09-01', more: false, older: false };
    if (b.action === 'k_trainingAll') return { success: false, code: 'BAD_REQUEST' };
    return undefined;
  });
  await openTab(w);
  const card = [...R(w).querySelectorAll('.k-card')].find((c) => c.textContent.indexOf('前回（11/27）') === 0);
  const blocks = card ? [...card.querySelectorAll('.k-exblock')] : [];
  ok('D1 ★前回のカード：種目ごとに名前の行（太字）とセットの行が分かれる', blocks.length === 5 && blocks.every((b) => b.children[0].classList.contains('k-exbname') && b.children[1].classList.contains('k-setline')), card && card.innerHTML.slice(0, 300));
  const nm = blocks.map((b) => b.querySelector('.k-exbname').textContent);
  ok('D2 種目名は切らずに全部', nm[0] === LONG && nm.includes('フロアプッシュアブダクション'), JSON.stringify(nm));
  const lines = blocks.map((b) => b.querySelector('.k-setline').textContent);
  ok('D3 ★セットの行は書き方を揃えた文字', JSON.stringify(lines) === JSON.stringify(['32kg × 12・10', '70kg × 10・90kg × 10・100kg × 15・15・15・15', '25kg × 3+補助7・自重 × 10（無理）', '60kg × 10（ドロップ 40kg × 8・20kg × 8）', '自重 × 10・10kg × 10・10']), JSON.stringify(lines));
  const pieces = blocks.flatMap((b) => [...b.querySelectorAll('.k-setp')]);
  const ws = pieces.map((p) => { const c = w.getComputedStyle(p); return c.display + '|' + c.maxWidth; });
  ok('D4 ★セットの小片は1つの塊（inline-block・幅は100%まで）＝塊と塊の間で折り返し、1セットの途中で割れない・横にはみ出さない', pieces.length > 10 && ws.every((x) => x === 'inline-block|100%'), JSON.stringify(ws));
  ok('D5 ★「・」は小片の尻だけ（折り返した行の頭が「・」で始まらない）・小片の中の × は1つまで', pieces.every((p) => !p.textContent.startsWith('・') && p.textContent.slice(0, -1).indexOf('・') < 0 && (p.textContent.match(/×/g) || []).length <= 1), JSON.stringify(pieces.map((p) => p.textContent)));
  ok('D6 セットのメモは今どおり種目の下に字下げ', card.textContent.includes('2セット目：7レップまでフルレンジ'));
  //   日別の記録（開くと同じ部品）
  const dr = R(w).querySelector('.k-daycard .k-dayrow'); dr.click(); await settle();
  const dblocks = [...R(w).querySelectorAll('.k-daycard .k-exblock')];
  ok('D7 ★日別の記録も同じ部品（名前の行とセットの行）', dblocks.length === 5 && dblocks[1].querySelector('.k-setline').textContent === '70kg × 10・90kg × 10・100kg × 15・15・15・15');
  //   推移のチップ
  const chips = [...R(w).querySelectorAll('.k-exchip')];
  const longChip = chips.find((c) => c.textContent === LONG), shortChip = chips.find((c) => c.textContent === 'ヒップスラスト');
  ok('D8 推移のチップ：短い名前は1行（nowrap）・とても長い名前はチップの中で折り返す（省略しない）', !!shortChip && w.getComputedStyle(shortChip).whiteSpace === 'nowrap' && !!longChip && longChip.classList.contains('long') && w.getComputedStyle(longChip).whiteSpace === 'normal' && longChip.textContent === LONG);
}

console.log(`${fail ? '❌' : '✅'} セットの書き方と折り返し 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
