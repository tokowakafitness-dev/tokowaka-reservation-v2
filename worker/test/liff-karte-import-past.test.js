// 設計62 段3（過去分の取り込み）と改訂8（体の注意）：本番の liff/karte.js を jsdom で動かし、トレーニングのタブの入り口から通して、送る body を値で確かめる・2026-11-26
//   実行: node worker/test/liff-karte-import-past.test.js
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
  const c = Object.assign({ dates: [], datesState: 'ok', consent: 'agreed', healthImport: false, write: null }, o || {});
  return (b) => {
    if (b.action === 'k_training' && !b.cursor && !b.older && !b.before && !b.sessionId) return { success: true, karteSchema: 33, aiDraft: false, trainingEdit: true, sessions: [], best: [], boundary: '2026-09-01', more: false, older: false };
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

// ================= S8 共有のプロンプトの出力を丸ごと通す（日数・セット・メモ・まとめ・前置き） =================
{
  const { w, sent } = boot(wk());
  await openImport(w);
  ok('S8 入り口：トレーニングのタブの［過去分の取り込み］で専用の画面・押しただけでは何も送らない', !!R(w).querySelector('.k-pimp-ta') && !sent.some((b) => b.action === 'k_importDay'));
  await paste(w, SAMPLE);
  ok('S8 ★2日とまとめ1件・前置きの警告（赤い帯）', days(w).length === 2 && R(w).querySelectorAll('.k-pimp-digest').length === 1 && !!R(w).querySelector('.k-pimp-pii'), String(days(w).length));
  ok('S8 帯：記録に入れる2日（3か月より前2日）・まとめ1件（期間）・体の注意1日（止めている）', band(w).includes('記録に入れる 2日（直近3か月 0日・3か月より前 2日）') && band(w).includes('まとめ 1件（2025年3月〜2025年8月）')
     && band(w).includes('体の注意 1日（いまは止めています・入れません）'), band(w));
  await sendAll(w);
  const im = sentOf(sent, 'k_importDay');
  ok('S8 ★古い日から1日ずつ送る', im.length === 2 && im[0].sessionDate === '2025-09-20' && im[1].sessionDate === '2025-09-27', JSON.stringify(im.map((x) => x.sessionDate)));
  const d1 = im[0];
  ok('S8 ★数字：ベンチプレス 60×10・60×10・55×8／スクワット 自重×20・20・15（✓済みで送る）', JSON.stringify(d1.items) === JSON.stringify([
    { exercise: 'ベンチプレス', sets: [{ weight: 60, reps: 10 }, { weight: 60, reps: 10 }, { weight: 55, reps: 8 }] },
    { exercise: 'スクワット', sets: [{ weight: 0, reps: 20 }, { weight: 0, reps: 20 }, { weight: 0, reps: 15 }] }]), JSON.stringify(d1.items));
  ok('S8 ★その日のメモは見出しつき・体の注意は入らない・health の鍵なし（止めている）', d1.note && d1.note.body === '【その日の内容】\n胸と脚の日\n【指導したこと】肩甲骨を寄せる\n【お客様の様子・話したこと】\n仕事が忙しい'
     && !JSON.stringify(d1).includes('左膝') && !('health' in d1), JSON.stringify(d1.note));
  ok('S8 2日目はメモなし（note の鍵なし）', !('note' in im[1]) && im[1].items[0].exercise === 'レッグプレス');
  const hs = sentOf(sent, 'k_saveHistory');
  ok('S8 ★まとめ：rev 0・origin import・期間・本文（見出しつき）', hs.length === 1 && hs[0].rev === 0 && hs[0].origin === 'import' && hs[0].periodFrom === '2025-03' && hs[0].periodTo === '2025-08'
     && hs[0].body === '【目標と経緯】\n体重を5kg落としたい\n【伸びたこと】\nスクワット 40→60', JSON.stringify(hs[0]));
  ok('S8 番号は中身から（imp-・imh- と16進40字）・member の鍵は無い', /^imp-[0-9a-f]{40}$/.test(d1.clientReqId) && /^imh-[0-9a-f]{40}$/.test(hs[0].clientReqId) && im.every((b) => !('member' in b)));
  ok('S8 全部済になり、送るボタンは「入れるものはありません」', days(w).every((d) => d.textContent.includes('済')) && sendBtn(w).disabled && sendBtn(w).textContent.includes('入れるものはありません'));
}

// ================= S1 切り方 =================
{
  const { w } = boot(wk());
  await openImport(w);
  await paste(w, '前置きの文\n2025/1/10\nベンチプレス\n50×10\n2025/1/17\nベンチプレス\n50×10\n2025/1/17\nスクワット\n×10');
  ok('S1 =====が無くても日付の行で切る・同じ日付の塊は別々の行・前置きは出す', days(w).length === 3 && R(w).querySelector('.k-pimp-pre').textContent.includes('前置きの文'));
  await paste(w, '=====\n2025/2/1\nベンチプレス\n50×10\n=====\n=====\n2025/2/8\nスクワット\n×10');
  ok('S1 =====の連続・空の塊は日にならない', days(w).length === 2);
  await paste(w, 'ただのメモ\n何も日付がない');
  ok('S1 日付の行が無ければ「見つかりませんでした」', R(w).querySelector('.k-pimp-info').textContent.includes('日付の行（年/月/日）が見つかりませんでした') && !sendBtn(w));
}

// ================= S2・S5b 年の無い日・実在しない日・未来の日は「日付を直す」・年の無い塊は読まない =================
{
  const fut = (Number(TODAY.slice(0, 4)) + 1) + '/1/1';
  const { w, sent } = boot(wk());
  await openImport(w);
  await paste(w, ['=====', '年？/9/20', 'ベンチプレス', '60×10', '=====', '2025/2/30', 'スクワット', '×10', '=====', fut, 'スクワット', '×10', '=====', '9/21', 'スクワット', '×10'].join('\n'));
  ok('S2 ★4日とも「日付を直す」・帯に4日', days(w).length === 4 && days(w).every((d) => d.textContent.includes('日付を直す')) && band(w).includes('日付を直す日 4日'), band(w));
  ok('S2 送るものが無い（ボタンは押せない）', sendBtn(w).disabled);
  const d = await openDay(w, '年？/9/20');
  ok('S5b ★年の無い塊は読まない（セットが出ない＝parseMemo に渡していない）', !d.querySelector('.k-pimp-detail').textContent.includes('60kg') && !!d.querySelector('.k-pimp-date'));
  d.querySelector('.k-pimp-date').value = '2025-09-20';
  d.querySelector('.k-pimp-dateok').click(); await settle();
  const d2 = dayOf(w, '9/20');
  ok('S2 日付を選ぶと読み直してセットが出る・送れる', d2 && d2.querySelector('.k-pimp-detail').textContent.includes('60kg') && !sendBtn(w).disabled);
  await sendAll(w);
  ok('S2 送るのは日付を直した1日だけ', sentOf(sent, 'k_importDay').length === 1 && sentOf(sent, 'k_importDay')[0].sessionDate === '2025-09-20');
}

// ================= S3 健康の言葉の行（見出しの外・知らない見出し）・書き直す・入れない・数字の行 =================
{
  const T = ['=====', '2025/3/1', 'ベンチプレス', '60×10', '【指導したこと】', '肩の痛みに注意して軽め', 'フォームは良い', '【知らない見出し】', '病院に通っている', '=====', '2025/3/8', 'スクワット', '60×10 膝が痛い', '【指導したこと】', '深くしゃがむ'].join('\n');
  const { w, sent } = boot(wk());
  await openImport(w);
  await paste(w, T);
  ok('S3 ★健康の言葉の行がある日は「選んでください」で送らない', dayOf(w, '3/1').textContent.includes('体のことが書かれた行を選んでください') && band(w).includes('記録に入れる 0日') && band(w).includes('決めることがある日 2日'), band(w));
  let d = await openDay(w, '3/1');
  const hl = () => [...dayOf(w, '3/1').querySelectorAll('.k-pimp-hline')];
  ok('S3 当たる行は2行（見出しの中・知らない見出しの中）・体の注意へ移すは出ない（止めている）', hl().length === 2 && !dayOf(w, '3/1').querySelector('.k-pimp-hmove'));
  hl()[0].querySelector('.k-pimp-rw').click(); await settle();
  let inp = hl()[0].querySelector('.k-pimp-rwin');
  inp.value = '肩は痛いので軽め'; inp.onchange(); await settle();
  hl()[1].querySelector('.k-pimp-hdrop').click(); await settle();
  ok('S3 ★書き直しても健康の言葉が残れば送らない', dayOf(w, '3/1').textContent.includes('書き直した行に体のことが残っています'));
  inp = hl()[0].querySelector('.k-pimp-rwin');
  inp.value = '軽めの重さで'; inp.onchange(); await settle();
  ok('S3 書き直して言葉が消えれば送れる', !dayOf(w, '3/1').textContent.includes('選んでください') && !dayOf(w, '3/1').textContent.includes('残っています'));
  await sendAll(w);
  const b1 = sentOf(sent, 'k_importDay').find((b) => b.sessionDate === '2025-03-01');
  ok('S3 ★送るメモは書き直した行・入れないを選んだ行は無い・健康の言葉は無い', b1 && b1.note.body === '【指導したこと】\n軽めの重さで\nフォームは良い\n【知らない見出し】' && !/痛|病院/.test(JSON.stringify(b1)), b1 && JSON.stringify(b1.note));
  const b2 = sentOf(sent, 'k_importDay').find((b) => b.sessionDate === '2025-03-08');
  ok('S3 数字の行の健康の言葉は今の読み取りのとおり＝重さと回数は失わない（その日は決めることあり）', !b2 && dayOf(w, '3/8').textContent.includes('決めることがあります'));
  d = await openDay(w, '3/8');
  ok('S3 数字の行の残り（膝が痛い）は［メモに残す］を出さない（健康の言葉）・［入れない］で決める', !!d.querySelector('.k-pimp-pend') && !d.querySelector('.k-pimp-pend .k-pimp-memo') && !!d.querySelector('.k-pimp-pend .k-pimp-drop'));
  d.querySelector('.k-pimp-pend .k-pimp-drop').click(); await settle();
  await sendAll(w);
  const b3 = sentOf(sent, 'k_importDay').find((b) => b.sessionDate === '2025-03-08');
  ok('S3 ★入れないを選ぶと送れて、重さと回数（60×10）は残る・健康の言葉は無い', b3 && JSON.stringify(b3.items) === JSON.stringify([{ exercise: 'スクワット', sets: [{ weight: 60, reps: 10 }] }]) && !/痛/.test(JSON.stringify(b3)), b3 && JSON.stringify(b3));
}

// ================= S3b まとめの体の注意の節・健康の言葉の行 =================
{
  const { w, sent } = boot(wk());
  await openImport(w);
  await paste(w, ['=====', '【これまでのまとめ（2025年1月〜2025年2月）】', '【目標と経緯】', '体力をつけたい', '【体の注意】', '腰痛あり', '【指導の要点】', '膝の痛みに配慮'].join('\n'));
  const g = R(w).querySelector('.k-pimp-digest');
  ok('S3b ★体の注意の節は入れない（件数を出す）・健康の言葉の行は選ぶまで送らない', g.textContent.includes('体の注意の節 1行は入れません') && g.textContent.includes('体のことが書かれた行を選んでください') && sendBtn(w).disabled);
  g.querySelector('.k-pimp-hdrop').click(); await settle();
  await sendAll(w);
  const h = sentOf(sent, 'k_saveHistory')[0];
  ok('S3b ★まとめの本文に体の注意も健康の言葉の行も無い', h && h.body === '【目標と経緯】\n体力をつけたい\n【指導の要点】' && !/腰痛|痛み/.test(h.body), h && h.body);
}

// ================= S4 決定待ち：種目にする・候補・メモに残す・入れない =================
{
  const T = ['=====', '2025/4/5', 'ベンチプレス', '50×10', '見本の新しい種目', '20×10、20×8', 'プランク 30秒', '※一部省略'].join('\n');
  const { w, sent } = boot(wk());
  await openImport(w);
  await paste(w, T);
  ok('S4 決定待ちが残る日は送らない', dayOf(w, '4/5').textContent.includes('決めることがあります') && sendBtn(w).disabled);
  const d = await openDay(w, '4/5');
  const pends = () => [...dayOf(w, '4/5').querySelectorAll('.k-pimp-pend')];
  ok('S4 知らない種目名（下にセット）は［種目にする］が出る', pends().some((p) => !!p.querySelector('.k-pimp-ex')), pends().map((p) => p.textContent).join(' | '));
  pends().find((p) => p.querySelector('.k-pimp-ex')).querySelector('.k-pimp-ex').click(); await settle();
  pends().filter((p) => !p.querySelector('.k-pimp-ex')).forEach((p) => p.querySelector('.k-pimp-memo').click());
  await settle();
  for (const p of pends()) { if (!p.querySelector('[aria-pressed="true"]')) p.querySelector('.k-pimp-memo').click(); }
  await settle();
  await sendAll(w);
  const b = sentOf(sent, 'k_importDay')[0];
  ok('S4 ★種目にした種目は読んだ位置に入る（ベンチプレスの後）・セットは✓済み', b && JSON.stringify(b.items) === JSON.stringify([{ exercise: 'ベンチプレス', sets: [{ weight: 50, reps: 10 }] }, { exercise: '見本の新しい種目', sets: [{ weight: 20, reps: 10 }, { weight: 20, reps: 8 }] }]), b && JSON.stringify(b.items));
  ok('S4 ★メモに残した行は【読めなかった行】の下に原文のまま（数字も文も捨てない）', b && b.note && b.note.body === '【読めなかった行】\nプランク 30秒\n※一部省略', b && JSON.stringify(b.note));
}

{
  //   ★関門② 段3 重大：健康の言葉を含む名前の決定待ちは［種目にする］を出さない（種目名へ健康の言葉を入れない）
  const { w, sent } = boot(wk({ healthImport: true }));
  await openImport(w);
  await paste(w, ['=====', '2025/4/12', '膝が痛いのでゆっくり', '20×10、20×8'].join('\n'));
  const d = await openDay(w, '4/12');
  const pc = d.querySelector('.k-pimp-pend');
  ok('S4 ★健康の言葉を含む行は［種目にする］も［メモに残す］も出さない（体の注意へ移す・入れないだけ）', !!pc && !pc.querySelector('.k-pimp-ex') && !pc.querySelector('.k-pimp-cand') && !pc.querySelector('.k-pimp-memo') && !!pc.querySelector('.k-pimp-move'), pc && pc.textContent);
}

// ================= S5 同じ日の記録・allDates が ok でない =================
{
  const T = ['=====', '2025/5/1', 'スクワット', '×10', '=====', '2025/5/8', 'スクワット', '×10'].join('\n');
  const { w, sent } = boot(wk({ dates: [{ d: '2025-05-01', n: 2 }] }));
  await openImport(w);
  await paste(w, T);
  ok('S5 ★同じ日に記録がある日は印・既定で入れない／ない日は入れる', dayOf(w, '5/1').textContent.includes('記録あり 2件') && dayOf(w, '5/1').querySelector('.k-pimp-inc').getAttribute('aria-pressed') === 'false'
     && dayOf(w, '5/8').querySelector('.k-pimp-inc').getAttribute('aria-pressed') === 'true' && band(w).includes('同じ日に記録がある日 1日'));
  dayOf(w, '5/1').querySelector('.k-pimp-inc').click(); await settle();
  await sendAll(w);
  ok('S5 1日ずつ「入れる」にできる', sentOf(sent, 'k_importDay').length === 2);
  for (const st of ['truncated', 'unavailable', 'fail']) {
    const x = boot(wk({ datesState: st }));
    await openImport(x.w);
    await paste(x.w, T);
    ok('S5 ★allDates が ' + st + ' なら全部の日を既定で入れない', days(x.w).every((d) => d.querySelector('.k-pimp-inc').getAttribute('aria-pressed') === 'false') && band(x.w).includes('同じ日の記録を確かめられません') && sendBtn(x.w).disabled);
  }
}

// ================= J3 画面：改行・行末の空白・全角でも番号と body が同じ／中身を直すと別 =================
{
  const A = '=====\n2025/6/1\nスクワット\n×10\n【指導したこと】\n深く１０回\n';
  const B = A.replace(/\n/g, '\r\n').replace('深く１０回', '深く10回  ');
  const run = async (text) => { const { w, sent } = boot(wk()); await openImport(w); await paste(w, text); await sendAll(w); return sentOf(sent, 'k_importDay')[0]; };
  const a = await run(A), b = await run(B), c = await run(A.replace('深く', '浅く'));
  const strip = (x) => { const y = { ...x }; delete y.idToken; return JSON.stringify(y); };
  ok('J3 ★CRLF・行末の空白・全角の数字でも番号も送る body も同じ（NFKC）', a.clientReqId === b.clientReqId && strip(a) === strip(b) && a.note.body === '【指導したこと】\n深く10回', JSON.stringify([a.note, b.note]));
  ok('J3 中身を直すと別の番号', c.clientReqId !== a.clientReqId);
}

// ================= S6 途中の失敗・回数の上限・通信の切れ・続きから =================
{
  const T = ['=====', '2025/7/1', 'スクワット', '×10', '=====', '2025/7/2', 'スクワット', '×11', '=====', '2025/7/3', 'スクワット', '×12'].join('\n');
  let mode = 'rate';
  const retryAt = Date.UTC(2026, 10, 26, 5, 40);   // JST 14:40
  const { w, sent } = boot(wk({ write: (b) => {
    if (b.sessionDate === '2025-07-02' && mode === 'rate') return { success: false, code: 'RATE_LIMITED', retryAt };
    if (b.sessionDate === '2025-07-02' && mode === 'net') throw new Error('net');
    if (b.sessionDate === '2025-07-02' && mode === 'replay') return { success: true, sessionId: 'S', replayed: true };
    return { success: true, sessionId: 'S' };
  } }));
  const f0 = w.fetch;
  w.fetch = async (u, o) => { const b = JSON.parse(o.body); if (b.sessionDate === '2025-07-02' && mode === 'net') { sent.push(b); throw new Error('net'); } return f0(u, o); };
  await openImport(w);
  await paste(w, T);
  await sendAll(w);
  ok('S6 ★回数の上限で止まり、Worker の時刻（14時40分）を出す・1日目は済・3日目は送らない', R(w).querySelector('.k-pimp-bar').textContent.includes('14時40分から［続きから］') && dayOf(w, '7/1').textContent.includes('済')
     && !sentOf(sent, 'k_importDay').some((b) => b.sessionDate === '2025-07-03'), R(w).querySelector('.k-pimp-bar').textContent);
  ok('S6 ボタンは「続きから（2日分を入れる）」', sendBtn(w).textContent === '続きから（2日分を入れる）', sendBtn(w).textContent);
  mode = 'net';
  await sendAll(w);
  const tries = sentOf(sent, 'k_importDay').filter((b) => b.sessionDate === '2025-07-02');
  ok('S6 ★続きからは送っていない日から（済の日は送り直さない）・通信の切れは「結果を確かめています」', sentOf(sent, 'k_importDay').filter((b) => b.sessionDate === '2025-07-01').length === 1 && dayOf(w, '7/2').textContent.includes('結果を確かめています'));
  mode = 'replay';
  await sendAll(w);
  const tries2 = sentOf(sent, 'k_importDay').filter((b) => b.sessionDate === '2025-07-02');
  ok('S6 ★送り直しは同じ番号・前に入っていれば「二重にしていません」・残りも送る', tries2.length === 3 && new Set(tries2.map((b) => b.clientReqId)).size === 1 && dayOf(w, '7/2').textContent.includes('二重にしていません')
     && sentOf(sent, 'k_importDay').some((b) => b.sessionDate === '2025-07-03'));
}

// ================= HN6 体の注意：同意あり・on は既定で入れる／同意なし・off・読めないは入れない／NO_CONSENT で止めて外す =================
{
  const T = ['=====', '2025/8/1', 'スクワット', '×10', '【指導したこと】', '腰の痛みに配慮', '【体の注意】', '腰に違和感', '=====', '2025/8/2', 'スクワット', '×10', '【体の注意】', '通院中'].join('\n');
  const { w, sent } = boot(wk({ healthImport: true }));
  await openImport(w);
  await paste(w, T);
  ok('HN6 ★同意あり・on：帯は「注意することへ入れます」', band(w).includes('体の注意 2日（注意することへ入れます）'));
  const d = await openDay(w, '8/1');
  ok('HN6 健康の言葉の行に［体の注意へ移す］が出る', !!d.querySelector('.k-pimp-hmove'));
  d.querySelector('.k-pimp-hmove').click(); await settle();
  await sendAll(w);
  const b = sentOf(sent, 'k_importDay');
  ok('HN6 ★体の注意は health で送る（移した行も足す）・社内メモに入らない', b.length === 2 && b[0].health.body === '腰に違和感\n腰の痛みに配慮' && b[0].note.body === '【指導したこと】' && b[1].health.body === '通院中' && !('note' in b[1]), JSON.stringify(b.map((x) => [x.note, x.health])));
  for (const [cs, hi, label] of [['none', true, '同意が無いため入れません'], ['agreed', false, 'いまは止めています・入れません'], ['fail', true, '同意を確かめられないため入れません']]) {
    const x = boot(wk({ consent: cs, healthImport: hi }));
    await openImport(x.w);
    await paste(x.w, T.replace('腰の痛みに配慮', '丁寧に'));
    ok('HN6 ★' + cs + '/' + hi + '：帯は「' + label + '」・送る body に health が無い・体の注意の本文も無い', band(x.w).includes('体の注意 2日（' + label + '）'), band(x.w));
    await sendAll(x.w);
    const xs = sentOf(x.sent, 'k_importDay');
    ok('HN6 ' + cs + '/' + hi + '：2日とも数字とメモだけ送る（health の鍵も体の注意の本文も無い）', xs.length === 2 && xs.every((q) => !('health' in q)) && !/違和感|通院/.test(JSON.stringify(xs)), JSON.stringify(xs));
    const x2 = boot(wk({ consent: cs, healthImport: hi }));
    await openImport(x2.w);
    await paste(x2.w, '=====\n2025/8/9\n【体の注意】\n通院中');
    ok('HN6 ' + cs + '/' + hi + '：体の注意だけの日は「入れられる中身がありません」で送らない', dayOf(x2.w, '8/9').textContent.includes('入れられる中身がありません') && sendBtn(x2.w).disabled);
  }
  let first = true;
  const y = boot(wk({ healthImport: true, write: (b) => (b.health && first ? (first = false, { success: false, code: 'NO_CONSENT' }) : { success: true, sessionId: 'S' }) }));
  await openImport(y.w);
  await paste(y.w, T.replace('腰の痛みに配慮', '丁寧に'));
  await sendAll(y.w);
  ok('HN6 ★NO_CONSENT で止まり、同意を「なし」に倒して体の注意を外す', R(y.w).querySelector('.k-pimp-bar').textContent.includes('同意が記録されていないため止めました') && band(y.w).includes('同意が無いため入れません'));
  await sendAll(y.w);
  const ys = sentOf(y.sent, 'k_importDay');
  ok('HN6 ★続きからは health なし（別の番号）で送る・残りの日も health なし', ys.length === 3 && 'health' in ys[0] && !('health' in ys[1]) && ys[1].sessionDate === ys[0].sessionDate && ys[1].clientReqId !== ys[0].clientReqId && !('health' in ys[2]), JSON.stringify(ys.map((b) => [b.sessionDate, !!b.health])));
}

// ================= S7・HN8 原文を残さない・外へ送らない・ログインし直す =================
{
  const logs = [];
  const { w, sent } = boot(wk());
  w.console.log = (...a) => logs.push(a.join(' ')); w.console.error = (...a) => logs.push(a.join(' ')); w.console.warn = (...a) => logs.push(a.join(' '));
  await openImport(w);
  await paste(w, SAMPLE);
  const dump = () => { const out = []; for (const st of [w.localStorage, w.sessionStorage]) for (let i = 0; i < st.length; i++) out.push(st.key(i) + '=' + st.getItem(st.key(i))); return out.join('\n'); };
  ok('S7 ★貼った文・日の塊が localStorage・sessionStorage・console・履歴の state に無い', !/肩甲骨|左膝|ベンチプレス/.test(dump()) && !logs.some((l) => /肩甲骨|左膝/.test(l)) && !/肩甲骨|左膝/.test(JSON.stringify(w.history.state || {})));
  ok('S7 ★送る先は Worker だけ・窓口は読み（k_training・k_trainingAll・k_safety・k_exercises・k_summary）だけ（まだ入れていない）', sent.every((b) => ['k_training', 'k_trainingAll', 'k_safety', 'k_exercises', 'k_summary'].includes(b.action)), JSON.stringify([...new Set(sent.map((b) => b.action))]));
  w.idToken = jwt(4000);
  let reloaded = 0; w.__karteReload = () => { reloaded++; };
  await sendAll(w);
  ok('HN8 ★トークンが古いと送らずに止まり［ログインし直す］を出す（自動で読み直さない）', !sent.some((b) => b.action === 'k_importDay') && !!R(w).querySelector('.k-pimp-reauth') && reloaded === 0);
  R(w).querySelector('.k-pimp-reauth').click(); await settle();
  ok('HN8 ★押すと貼った文と一覧を消してから読み直す・保存領域に原文が無い', reloaded === 1 && (!R(w).querySelector('.k-pimp-ta') || R(w).querySelector('.k-pimp-ta').value === '') && !R(w).querySelector('.k-pimp-day') && !/肩甲骨|左膝|ベンチプレス/.test(dump()), dump());
}

{
  //   ★関門② 段3 中：bfcache で戻ったら、貼った文だけでなく日の配列・送る帯も消える（見えないまま送れない）
  const { w, sent } = boot(wk());
  await openImport(w);
  await paste(w, SAMPLE);
  const ev = new w.Event('pageshow'); Object.defineProperty(ev, 'persisted', { value: true });
  w.dispatchEvent(ev); await settle();
  ok('HN8 ★bfcache（pageshow の persisted）で貼った文・一覧・送る帯が消える', R(w).querySelector('.k-pimp-ta').value === '' && !R(w).querySelector('.k-pimp-day') && !R(w).querySelector('.k-pimp-send'));
  ok('HN8 消した後に何も送っていない', !sent.some((b) => b.action === 'k_importDay'));
}
{
  //   ★関門② 段3 2周目：送信中に bfcache で消したら、古い送信の失敗・成功が画面に戻ってこない（新しい送信の印を倒さない）
  let rel = null;
  const { w, sent } = boot(wk());
  const f0 = w.fetch;
  w.fetch = (u, o) => { const b = JSON.parse(o.body); if (b.action !== 'k_importDay') return f0(u, o); sent.push(b); return new Promise((res, rej) => { rel = { res: (v) => res({ json: async () => v }), rej }; }); };
  await openImport(w);
  await paste(w, SAMPLE);
  sendBtn(w).click(); for (let i = 0; i < 20; i++) await tick();
  ok('HN8 前提：1日目を送っている途中', !!rel && sentOf(sent, 'k_importDay').length === 1);
  const ev = new w.Event('pageshow'); Object.defineProperty(ev, 'persisted', { value: true });
  w.dispatchEvent(ev); await settle();
  await paste(w, '=====\n2025/10/1\nスクワット\n×10');
  const r0 = rel; rel = null;
  sendBtn(w).click(); for (let i = 0; i < 20; i++) await tick();
  r0.rej(new Error('old')); for (let i = 0; i < 20; i++) await tick(); await settle();
  ok('HN8 ★古い送信の失敗は表示されず、新しい送信は送信中のまま（［続きから］を重ねて押せない）', !R(w).querySelector('.k-pimp-bar').textContent.includes('通信が切れました') && sendBtn(w).disabled && sendBtn(w).textContent.includes('入れています'), R(w).querySelector('.k-pimp-bar').textContent);
  rel.res({ success: true, sessionId: 'S' }); for (let i = 0; i < 30; i++) await tick(); await settle();
  ok('HN8 新しい送信は最後まで進む', dayOf(w, '10/1').textContent.includes('済'));
}

// ================= S10 上限と段階の読み =================
{
  const { w } = boot(wk());
  await openImport(w);
  await paste(w, '2025/1/1\n' + 'あ'.repeat(100001));
  ok('S10 10万字を超えたら読まない', R(w).querySelector('.k-pimp-info').textContent.includes('10万字まで') && !days(w).length);
  const many = (n) => Array.from({ length: n }, (_, i) => { const t = new Date(Date.UTC(2024, 0, 1) + i * 86400000).toISOString().slice(0, 10).split('-'); return '=====\n' + (+t[0]) + '/' + (+t[1]) + '/' + (+t[2]) + '\nスクワット\n×10'; }).join('\n');
  await paste(w, many(401));
  ok('S10 400日を超えたら読まない', R(w).querySelector('.k-pimp-info').textContent.includes('400日まで') && !days(w).length);
  const t0 = Date.now();
  await paste(w, many(400));
  for (let i = 0; i < 200 && R(w).querySelector('.k-pimp-info').textContent.includes('読んでいます'); i++) await tick();
  await settle();
  const ms = Date.now() - t0;
  ok('S10 ★400日を段階で読み、一覧は50日ずつ（［続きを表示］）', days(w).length === 50 && !!R(w).querySelector('.k-pimp-more') && band(w).includes('記録に入れる 400日'), `${days(w).length} ${ms}ms`);
  console.log(`   S10 400日の読み取り（jsdom）：${ms}ms`);
  const lim = ['=====', '2025/1/1'].concat(Array.from({ length: 200 }, () => 'x')).join('\n');
  await paste(w, lim);
  ok('S10 1日200行を超える日は入れない（理由を出す）', dayOf(w, '1/1').textContent.includes('長すぎます（1日200行まで）'));
}

// ================= S11 設計63：その日のメモは 4,000字まで・1日分が本文16KB を超えるなら押す前に止める =================
{
  const { w, sent } = boot(wk({ healthImport: true }));
  await openImport(w);
  const day = (d, memo, health) => ['=====', d, '【その日の内容】', memo].concat(health ? ['【体の注意】', health] : []).join('\n');
  await paste(w, [day('2025/3/1', 'か'.repeat(3980)), day('2025/3/2', 'き'.repeat(4001)), day('2025/3/3', 'く'.repeat(3900), 'け'.repeat(1900))].join('\n'));
  ok('S11 ★3,980字のメモは入れられる（以前の2,000字で止まらない）', !dayOf(w, '3/1').textContent.includes('長すぎ'), dayOf(w, '3/1').textContent);
  ok('S11 4,000字を超えるメモは「メモが長すぎます（4,000字まで）」', dayOf(w, '3/2').textContent.includes('メモが長すぎます（4,000字まで）'), dayOf(w, '3/2').textContent);
  ok('S11 ★メモと体の注意を合わせて16KB を超える日は押す前に理由（送らない）', dayOf(w, '3/3').textContent.includes('この日は長すぎて1回で送れません'), dayOf(w, '3/3').textContent);
  sendBtn(w).click(); for (let i = 0; i < 40; i++) await tick(); await settle();
  const b = sentOf(sent, 'k_importDay');
  ok('S11 送ったのは 3/1 だけ・本文は16KB 以下・メモは切らずにそのまま', b.length === 1 && b[0].sessionDate === '2025-03-01' && b[0].note.body === '【その日の内容】\n' + 'か'.repeat(3980) && Buffer.byteLength(JSON.stringify(b[0])) <= 16 * 1024, JSON.stringify(b.map((x) => [x.sessionDate, x.note && x.note.body.length, Buffer.byteLength(JSON.stringify(x))])));
}

// ================= S12 設計64：Worker が「同じ社内メモがその日に既にあった」と答えたら、その日に言う =================
{
  const { w } = boot(wk({ write: (b) => (b.sessionDate === '2025-04-01' ? { success: true, sessionId: null, noteId: null, hnoteId: null, noteSame: true } : { success: true, sessionId: null, noteId: 'N', hnoteId: null }) }));
  await openImport(w);
  await paste(w, ['=====', '2025/4/1', '【その日の内容】', '架空の同じメモ', '=====', '2025/4/2', '【その日の内容】', '架空の別のメモ'].join('\n'));
  sendBtn(w).click(); for (let i = 0; i < 40; i++) await tick(); await settle();
  ok('S12 ★同じ社内メモがあった日は「済（同じ社内メモがその日に既にあったため、メモは重ねていません）」', dayOf(w, '4/1').textContent.includes('済（同じ社内メモがその日に既にあったため、メモは重ねていません）'), dayOf(w, '4/1').textContent);
  ok('S12 ほかの日はただの「済」', dayOf(w, '4/2').textContent.includes('済') && !dayOf(w, '4/2').textContent.includes('重ねていません'), dayOf(w, '4/2').textContent);
}

// ================= HN 注意することの画面：取り込んだ体の注意（日付つき）・削除 =================
{
  const notes = [{ id: 'H1', date: '2025-09-20', body: '見本の体の注意', by: 'T1', at: 1 }, { id: 'H2', date: '2025-09-01', body: '見本のほかの人の', by: 'T2', at: 1 }];
  const { w, sent } = boot((b) => (b.action === 'k_safety' ? { success: true, karteSchema: 33, consent: 'agreed', safety: null, healthNotes: notes, healthImport: false } : (b.action === 'k_deleteHealthNote' ? { success: true } : undefined)));
  w.KarteUI.open('C1', NAME, 'summary', { kind: 'sub', sub: 'safety' }); await settle();
  let c = R(w).querySelector('.k-hnotes');
  if (!c) { const b2 = [...R(w).querySelectorAll('button')].find((x) => /注意すること|安全/.test(x.textContent)); if (b2) { b2.click(); await settle(); } c = R(w).querySelector('.k-hnotes'); }
  ok('HN ★注意することの画面に取り込んだ体の注意（日付つき）', !!c && c.textContent.includes('見本の体の注意') && c.textContent.includes('2025'), c ? c.textContent : txt(w).slice(0, 200));
  if (c) {
    const dels = c.querySelectorAll('.k-hndel');
    ok('HN 削除は本人の行だけ（44px）', dels.length === 1 && /min-height:\s*44px/.test(dels[0].getAttribute('style')));
    dels[0].click(); await settle();
    ok('HN 削除は確かめてから k_deleteHealthNote', w.confirms.some((m) => m.includes('体の注意を削除')) && sentOf(sent, 'k_deleteHealthNote').length === 1 && sentOf(sent, 'k_deleteHealthNote')[0].hnoteId === 'H1');
  }
}

console.log(`${fail ? '❌' : '✅'} 過去分の取り込み（設計62 段3・画面） 検証: ${pass} passed / ${fail} failed`);
if (fail) process.exit(1);
