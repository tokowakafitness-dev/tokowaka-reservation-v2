// 設計62 改訂9（過去分の取り込みの決めることを名前ごとに）：本番の liff/karte.js を jsdom で動かし、トレーニングのタブの入り口から通して、送る body を値で確かめる・2026-11-27
//   実行: node worker/test/liff-karte-import-names.test.js
//   ★入力は 2026-11-27 のオーナーの実機の形（一覧に無い種目名・セットの無い種目・前の種目の続きの行・16+16×10）を架空の名前と数字で作り直したもの
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



// ---------------- 取り込みの画面の道具 ----------------
const TODAY = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const SAMPLE = [
  '⚠ 名前などが残っていました：1か所',
  '=====',
  '2025/9/20(土)',
  'ベンチプレス',
  '60×10、60×10、55×8',
  'スクワット',
  '×20、×20、×15',
  '【その日の内容】',
  '胸と脚の日',
  '【指導したこと】肩甲骨を寄せる',
  '【お客様の様子・話したこと】',
  '仕事が忙しい',
  '【体の注意】',
  '左膝に違和感',
  '=====',
  '2025/9/27',
  'レッグプレス',
  '100×10、100×10',
  '=====',
  '【これまでのまとめ（2025年3月〜2025年8月）】',
  '【目標と経緯】',
  '体重を5kg落としたい',
  '【伸びたこと】',
  'スクワット 40→60',
].join('\n');
//   Worker の答え：allDates と同意（既定は同じ日の記録なし・同意あり・体の注意は止まっている）
function wk(o) {
  const c = Object.assign({ dates: [], datesState: 'ok', consent: 'agreed', healthImport: false, write: null, exNote: false }, o || {});
  return (b) => {
    if (b.action === 'k_training' && !b.cursor && !b.older && !b.before && !b.sessionId) return { success: true, karteSchema: 33, aiDraft: false, trainingEdit: true, exNote: c.exNote, sessions: [], best: [], boundary: '2026-09-01', more: false, older: false };
    if (b.action === 'k_trainingAll') return c.datesState === 'fail' ? { success: false, code: 'UNAVAILABLE' } : { success: true, agg: { best: 'ok', series: 'ok', dates: c.datesState, months: 'ok' }, bestAll: [], seriesAll: [], seriesFrom: null, allDates: c.datesState === 'unavailable' ? null : c.dates, monthsAll: [] };
    if (b.action === 'k_safety') return c.consent === 'fail' ? { success: false, code: 'UNAVAILABLE' } : { success: true, karteSchema: 33, consent: c.consent, safety: null, healthNotes: [], healthImport: c.healthImport };
    if (b.action === 'k_importDay' || b.action === 'k_saveHistory') return c.write ? c.write(b) : { success: true, sessionId: 'S', noteId: 'N', hnoteId: null };
    return undefined;
  };
}
async function openImport(w) {
  w.KarteUI.open('C1', NAME, 'training'); await settle();
  R(w).querySelector('.k-pimp-open').click(); await settle();
}
async function paste(w, text) { const t = R(w).querySelector('.k-pimp-ta'); t.value = text; t.oninput(); R(w).querySelector('.k-pimp-read').click(); for (let i = 0; i < 60; i++) await tick(); await settle(); }
const days = (w) => [...R(w).querySelectorAll('.k-pimp-day')];
const dayOf = (w, label) => days(w).find((x) => x.querySelector('.k-pimp-row').textContent.indexOf(label) === 0);
async function openDay(w, label) { const d = dayOf(w, label); d.querySelector('.k-pimp-row').click(); await settle(); return dayOf(w, label); }
const sendBtn = (w) => R(w).querySelector('.k-pimp-send');
async function sendAll(w) { sendBtn(w).click(); for (let i = 0; i < 80; i++) await tick(); await settle(); }
const sentOf = (sent, a) => sent.filter((b) => b.action === a);
const band = (w) => (R(w).querySelector('.k-pimp-band') || {}).textContent || '';


const groups = (w) => [...R(w).querySelectorAll('.k-pimp-group')];
const groupOf = (w, label) => groups(w).find((g) => g.querySelector('span').textContent === label);
async function press(el, cls) { const b = el.querySelector(cls); if (!b) return false; b.click(); await settle(); return true; }
const bodyOf = (sent, d) => sentOf(sent, 'k_importDay').find((b) => b.sessionDate === d);
const J = (x) => JSON.stringify(x);

//   オーナーの実機の形（架空）：11/13 に読めなかった行が6枚出た日・同じ名前が別の日にも出る・最後に【確認が必要な点】
const OUT = [
  '=====',
  '2025/11/13(木)',
  '腸腰筋ストレッチ',
  'クロスコネクトデッドバグ',
  'ワンレッグルーマニアンデット',
  '16+16×10',
  'ドンキーキック',
  '40×10、60×10、60×？',
  '【その日の内容】',
  '下半身の日',
  '=====',
  '2025/11/6(木)',
  '腸腰筋ストレッチ',
  'ドンキーキック',
  '40×10、40×10',
  '【指導したこと】',
  '骨盤を立てる',
  '=====',
  '2025/10/30(木)',
  'ワンレッグルーマニアンデット',
  '16+16×10',
  'スクワット',
  '×20',
  '【体の注意】',
  '腰に張り',
  '=====',
  '【これまでのまとめ（2025年3月〜2025年8月）】',
  '【目標と経緯】',
  '体力をつけたい',
  '=====',
  '【確認が必要な点】',
  '- 2025/11/13 「16+16×10」：左右の合計か片手か分からない',
  '- 2025/11/13 ドンキーキック：「60×？」の回数が読めない',
].join('\n');

// ================= N1 名前ごとに1回決めれば全部の日に効く・種目にした名前のセットがその種目に付く =================
{
  const { w, sent } = boot(wk());
  await openImport(w);
  await paste(w, OUT);
  const names = groups(w).map((g) => g.querySelector('span').textContent);
  ok('N1 ★決めることは名前ごとに1枚（4件）・前の名前の続きの行（16+16×10・60×？）は前の名前を決めるまで出さない',
     J(names) === J(['腸腰筋ストレッチ', 'クロスコネクトデッドバグ', 'ワンレッグルーマニアンデット', 'ドンキーキック']), J(names));
  ok('N1 同じ名前が出る日数を出す（腸腰筋ストレッチ 2日）', groupOf(w, '腸腰筋ストレッチ').textContent.includes('2日') && !groupOf(w, 'クロスコネクトデッドバグ').textContent.includes('日'));
  ok('N1 ★セットの無い名前・一覧に無い名前にも［種目にする］が出る', groups(w).every((g) => !!g.querySelector('.k-pimp-ex')));
  const cands = [...groupOf(w, 'ワンレッグルーマニアンデット').querySelectorAll('.k-pimp-cand')].map((b) => b.textContent);
  ok('N1 ★前置き・表記ゆれの名前は一覧の名前を候補に出す（選ぶまで入れない）', J(cands) === J(['「ルーマニアンデッドリフト」にする']), J(cands));
  ok('N1 【確認が必要な点】は一覧の上に件数と行をそのまま出す', (R(w).querySelector('.k-pimp-check') || {}).textContent === '確認が必要な点 2件- 2025/11/13 「16+16×10」：左右の合計か片手か分からない- 2025/11/13 ドンキーキック：「60×？」の回数が読めない');
  ok('N1 ★【確認が必要な点】を日として読まない（日付を直す日 0日・日は3つ）', days(w).length === 3 && band(w).includes('日付を直す日 0日'), band(w));
  const left = () => (R(w).querySelector('.k-pimp-gcount') || {}).textContent;
  ok('N1 決めるまで日は送れない（まとめだけ）', !sendBtn(w).textContent.includes('日分') && band(w).includes('決めることがある日 3日') && left() === '決めること 残り4件', band(w) + ' / ' + sendBtn(w).textContent);

  await press(groupOf(w, '腸腰筋ストレッチ'), '.k-pimp-ex');
  await press(groupOf(w, 'クロスコネクトデッドバグ'), '.k-pimp-memo');
  await press(groupOf(w, 'ワンレッグルーマニアンデット'), '.k-pimp-cand');
  await press(groupOf(w, 'ドンキーキック'), '.k-pimp-ex');
  ok('N1 一覧に無い名前を種目にすると推定の部位を出す', groupOf(w, '腸腰筋ストレッチ').textContent.includes('部位：その他（推定）') && !groupOf(w, 'ワンレッグルーマニアンデット').querySelector('.k-pimp-part'));
  const rg = groups(w).find((g) => g.querySelector('.k-pimp-set'));
  ok('N1 ★前の名前を種目にすると、続きの 16+16×10 は［セットにする（16kg×10）］で1回だけ決める（2日）', !!rg && rg.textContent.includes('16+16×10') && rg.textContent.includes('2日') && rg.querySelector('.k-pimp-set').textContent === 'セットにする（16kg×10）', rg && rg.textContent);
  ok('N1 ★60×？ は決めることに出さない（前の名前に従う）', !groups(w).some((g) => g.textContent.includes('60×？')));
  //   日の中身のカードも同じ決め方を見る（11/6 を開くと ドンキーキック は種目にする が押されている）
  const d6 = await openDay(w, '11/6');
  const p6 = [...d6.querySelectorAll('.k-pimp-pend')].find((p) => p.textContent.indexOf('ドンキーキック') === 0);
  ok('N1 ★上で1回決めた名前は、別の日の中身でも決まっている', !!p6 && p6.querySelector('.k-pimp-ex').getAttribute('aria-pressed') === 'true', d6.textContent);
  await press(rg, '.k-pimp-set');
  ok('N1 全部決まると残り0件・送れる（決めたカードは残して直せる）', left() === '決めること 残り0件' && groups(w).length === 5 && !sendBtn(w).disabled && band(w).includes('記録に入れる 3日'), band(w));
  await sendAll(w);
  const b13 = bodyOf(sent, '2025-11-13'), b6 = bodyOf(sent, '2025-11-06'), b30 = bodyOf(sent, '2025-10-30');
  ok('N1 ★11/13：セットの無い種目は実施のみ・候補の名前に寄せた種目に 16+16×10 が片手16kg（メモ「片手16kgずつ」）で付く・ドンキーキックのセット・読んだ順',
     b13 && J(b13.items) === J([{ exercise: '腸腰筋ストレッチ', sets: [], doneOnly: true }, { exercise: 'ルーマニアンデッドリフト', sets: [{ weight: 16, reps: 10, note: '片手16kgずつ' }] }, { exercise: 'ドンキーキック', sets: [{ weight: 40, reps: 10 }, { weight: 60, reps: 10 }] }]), b13 && J(b13.items));
  ok('N1 ★11/13：メモにした名前と、回数の読めない 60×？（入れないセット）は社内メモの【読めなかった行】へ（数字も捨てない）',
     b13 && b13.note && b13.note.body === '【その日の内容】\n下半身の日\n【読めなかった行】\nクロスコネクトデッドバグ\nドンキーキック:60×?', b13 && J(b13.note));
  ok('N1 ★11/6：同じ名前の決めがこの日にも効く（1回も押していない日）',
     b6 && J(b6.items) === J([{ exercise: '腸腰筋ストレッチ', sets: [], doneOnly: true }, { exercise: 'ドンキーキック', sets: [{ weight: 40, reps: 10 }, { weight: 40, reps: 10 }] }]) && b6.note.body === '【指導したこと】\n骨盤を立てる', b6 && J(b6));
  ok('N1 ★10/30：一覧の種目（スクワット）の前に読んだ位置で入る・体の注意は今どおり入れない（止めている）',
     b30 && J(b30.items) === J([{ exercise: 'ルーマニアンデッドリフト', sets: [{ weight: 16, reps: 10, note: '片手16kgずつ' }] }, { exercise: 'スクワット', sets: [{ weight: 0, reps: 20 }] }]) && !('note' in b30) && !('health' in b30), b30 && J(b30));
  ok('N1 まとめは1件・【確認が必要な点】はどこにも送らない', sentOf(sent, 'k_saveHistory').length === 1 && sentOf(sent, 'k_importDay').length === 3 && !/確認が必要/.test(J(sent)));
}

// ================= N2 メモに残す・入れない（前の名前に続く行の扱い） =================
{
  const { w, sent } = boot(wk());
  await openImport(w);
  await paste(w, OUT);
  await press(groupOf(w, '腸腰筋ストレッチ'), '.k-pimp-drop');
  await press(groupOf(w, 'クロスコネクトデッドバグ'), '.k-pimp-drop');
  await press(groupOf(w, 'ドンキーキック'), '.k-pimp-memo');
  await press(groupOf(w, 'ワンレッグルーマニアンデット'), '.k-pimp-drop');
  const lg = groups(w).map((g) => g.querySelector('span').textContent), g16 = groupOf(w, '16+16×10');
  ok('N2 ★前の名前を入れないにしても、続きの数字の行（16+16×10）は黙って捨てず自分で決める（1枚・2日・未決）', lg.filter((x) => x === '16+16×10').length === 1 && g16.textContent.includes('2日') && !g16.querySelector('.k-pimp-set') && !g16.querySelector('[aria-pressed="true"]'), J(lg));
  await press(g16, '.k-pimp-memo');
  await sendAll(w);
  const b13 = bodyOf(sent, '2025-11-13'), b6 = bodyOf(sent, '2025-11-06');
  ok('N2 ★メモにした名前は続きの行ごと社内メモへ・60×？ は二重に書かない／入れない名前は入らない',
     b13 && !('items' in b13) && b13.note.body === '【その日の内容】\n下半身の日\n【読めなかった行】\n16+16×10\nドンキーキック\n40×10、60×10、60×?', b13 && J(b13));
  ok('N2 11/6 も同じ（ドンキーキックはメモ・腸腰筋ストレッチは入れない）', b6 && !('items' in b6) && b6.note.body === '【指導したこと】\n骨盤を立てる\n【読めなかった行】\nドンキーキック\n40×10、40×10', b6 && J(b6));
}

// ================= N3 名前＋数字の文（プランク 30秒）・【確認が必要な点】なし・健康の言葉の名前 =================
{
  const T = ['=====', '2025/9/1', 'プランク 30秒', 'サイドプランク', '=====', '【確認が必要な点】なし'].join('\n');
  for (const exNote of [true, false]) {
    const { w, sent } = boot(wk({ exNote }));
    await openImport(w);
    await paste(w, T);
    ok('N3 【確認が必要な点】なし は出さず、日にも数えない（' + exNote + '）', !R(w).querySelector('.k-pimp-check') && days(w).length === 1);
    const g = groupOf(w, 'プランク');
    ok('N3 ★「プランク 30秒」は名前（プランク）として［種目にする］', !!g && !!g.querySelector('.k-pimp-ex'), groups(w).map((x) => x.textContent).join(' | '));
    await press(g, '.k-pimp-ex');
    await sendAll(w);
    const b = bodyOf(sent, '2025-09-01');
    if (exNote) ok('N3 ★種目のメモを受ける Worker なら、実施のみの種目に「30秒」のメモ', b && J(b.items) === J([{ exercise: 'プランク', sets: [], doneOnly: true, note: '30秒' }, { exercise: 'サイドプランク', sets: [], doneOnly: true }]) && !('note' in b), b && J(b));
    else ok('N3 ★受けない Worker なら、その行は社内メモへ（捨てない）', b && J(b.items) === J([{ exercise: 'プランク', sets: [], doneOnly: true }, { exercise: 'サイドプランク', sets: [], doneOnly: true }]) && !!b.note && b.note.body === '【読めなかった行】\nプランク 30秒', b && J(b));
  }
  {
    const { w } = boot(wk());
    await openImport(w);
    await paste(w, ['=====', '2025/9/2', '田中様', '※一部省略', '膝が痛いのでゆっくり', '体験レッスン'].join('\n'));
    const gs = groups(w);
    ok('N3 ★名前らしい行・記号で始まる行・健康の言葉の行・名前らしい印（体験）の行は［種目にする］を出さない', gs.length === 4 && gs.every((g) => !g.querySelector('.k-pimp-ex')) && !gs[2].querySelector('.k-pimp-memo'), gs.map((g) => g.textContent).join(' | '));
  }
}

// ================= N4 関門② 改訂9：健康の言葉を種目のメモへ入れない・体の注意へ移した前の行の続き =================
{
  const { w, sent } = boot(wk({ exNote: true, healthImport: true }));
  await openImport(w);
  await paste(w, ['=====', '2025/9/3', 'プランク 30秒 膝痛い', 'プランク 30秒', '=====', '2025/9/4', '膝が痛いのでゆっくり', '16+16×10', 'スクワット', '×10'].join('\n'));
  const gs = groups(w), lbl = gs.map((g) => g.querySelector('span').textContent);
  const gh = groupOf(w, 'プランク 30秒 膝痛い'), gp = groupOf(w, 'プランク');
  ok('N4 ★名前＋数字の行に健康の言葉があれば分けない（種目にしない・メモにも出さない）', !!gh && !gh.querySelector('.k-pimp-ex') && !gh.querySelector('.k-pimp-memo') && !!gp && !!gp.querySelector('.k-pimp-ex'), lbl.join(' | '));
  await press(gp, '.k-pimp-ex');
  await press(gh, '.k-pimp-drop');
  await press(groupOf(w, '膝が痛いのでゆっくり'), '.k-pimp-move');
  const g16 = groupOf(w, '16+16×10');
  ok('N4 ★前を体の注意へ移しても、続きの数字の行は自分で決める（体の注意へ自動で送らない）', !!g16 && !g16.querySelector('[aria-pressed="true"]') && !!g16.querySelector('.k-pimp-memo'), groups(w).map((g) => g.textContent).join(' | '));
  await press(g16, '.k-pimp-memo');
  await sendAll(w);
  const b3 = bodyOf(sent, '2025-09-03'), b4 = bodyOf(sent, '2025-09-04');
  ok('N4 9/3：健康の言葉の行は入らず、もう1つの行は実施のみ＋メモ「30秒」', b3 && J(b3.items) === J([{ exercise: 'プランク', sets: [], doneOnly: true, note: '30秒' }]) && !/痛/.test(J(b3)), b3 && J(b3));
  ok('N4 9/4：体の注意は前の行だけ・数字の行は社内メモ', b4 && b4.health && b4.health.body === '膝が痛いのでゆっくり' && b4.note && b4.note.body === '【読めなかった行】\n16+16×10' && J(b4.items) === J([{ exercise: 'スクワット', sets: [{ weight: 0, reps: 10 }] }]), b4 && J(b4));
}

// ================= N5 関門② 改訂9 第2周：名前らしい印のある候補は出さない =================
{
  const base = wk();
  const { w } = boot((b) => (b.action === 'k_exercises' ? { success: true, karteSchema: 33, exercises: [{ name: '見本様カール', part: 'arm' }, { name: 'ワイドスクワット', part: 'legs' }], truncated: false } : base(b)));
  await openImport(w);
  await paste(w, ['=====', '2025/9/5', '見本カール', 'ワンレッグワイドスクワット'].join('\n'));
  const g1 = groupOf(w, '見本カール'), g2 = groupOf(w, 'ワンレッグワイドスクワット');
  ok('N5 ★共有の一覧の名前らしい印の名前は候補に出さない／印の無い共有の名前は候補に出す', !!g1 && !!g1.querySelector('.k-pimp-ex') && !g1.querySelector('.k-pimp-cand') && !!g2 && J([...g2.querySelectorAll('.k-pimp-cand')].map((b) => b.textContent)) === J(['「ワイドスクワット」にする']),
     groups(w).map((g) => g.textContent).join(' | '));
}

// ================= N6 関門② 改訂9 第3周：お客様の名前らしい行は〇〇にしてからメモへ =================
{
  const { w, sent } = boot(wk());
  await openImport(w);
  await paste(w, ['=====', '2025/9/6', '見本様 本日も来店', 'スクワット', '×10'].join('\n'));
  const g = groups(w)[0];
  ok('N6 ★名前らしい行の［メモに残す］は〇〇にした文で見せる', !!g && !g.querySelector('.k-pimp-ex') && g.querySelector('.k-pimp-memo').textContent === '「〇〇様 本日も来店」をメモに残す', g && g.textContent);
  await press(g, '.k-pimp-memo');
  await sendAll(w);
  const b = bodyOf(sent, '2025-09-06');
  ok('N6 ★社内メモには〇〇にした文だけ（名前の部分は送らない）', b && b.note && b.note.body === '【読めなかった行】\n〇〇様 本日も来店' && !/見本/.test(J(b)), b && J(b));
}

console.log(`${fail ? '❌' : '✅'} 過去分の取り込み（設計62 改訂9・名前ごとの決め） 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
