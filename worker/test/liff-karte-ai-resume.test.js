// 設計51 AI の振り分けの確認を途中から続ける（端末に当日中だけ一時保存・同じ文字起こしは送り直さない）：本番の liff/karte.js を jsdom で動かし、入口から通す・2026-11-23
//   実行: node worker/test/liff-karte-ai-review.test.js
//
//   ★カルテを開く → 今日の記録 → メモから取り込む → 貼る → 「AIで振り分ける」→ 1画面の確認 → 最後のボタン → 記録の画面 → ✓ → 保存、を click で通す
//   ★身代わりは fetch（Worker）・LINE の SDK だけ。Worker の応答は worker/src/routes/karte-ai-v2.js の draft（v:2）の形
//   ★検査は定数を置き換えて trial・full・不正値の3通りを通す（本番の値は 2026-11-21 から full＝R0 で固定）
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
const RAW = process.env.KARTE_SRC ? readFileSync(process.env.KARTE_SRC, 'utf8') : readFileSync(join(ROOT, 'liff/karte.js'), 'utf8');
//   2026-11-21 本番は 'full'（D8＝同意の版 rec_ai-2026-11-21・決定0195）。検査は定数を置き換えて trial・full・不正値の3通りを通す
const SCOPE_RE = /^  var AI_V2_SAVE_SCOPE = '[^']*';$/m;
const SCOPE_LINES = RAW.match(new RegExp(SCOPE_RE.source, 'mg')) || [];
const withScope = (v) => RAW.replace(SCOPE_RE, "  var AI_V2_SAVE_SCOPE = '" + v + "';");
const SRC = withScope('trial');
const FULL = withScope('full');
const BOGUS = withScope('Full');

let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) pass++; else { fail++; console.log(`❌ ${name}${detail ? '\n   ' + detail : ''}`); } }
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 12; i++) await tick(); }
async function nav() { await new Promise((r) => setTimeout(r, 40)); await settle(); }
const b64u = (s) => Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (ageS) => b64u(JSON.stringify({ alg: 'ES256' })) + '.' + b64u(JSON.stringify({ iss: 'https://access.line.me', sub: 'U_TEST', iat: Math.floor(Date.now() / 1000) - ageS, exp: Math.floor(Date.now() / 1000) + 3600 })) + '.sig';

const SECRET = '架空の選挙の雑談がここにある';
const TRANSCRIPT = 'ベンチプレス 50キロで10回\n同じ重さでもう1セット 8回\nスカルフラッシュ 10キロで12回\n' + SECRET;
const EVID = '同じ重さでもう1セット 8回';
const DRAFT = () => ({
  v: 2, effort: 'medium',
  summary: ['ベンチプレスを50キロから始めた', 'スクワットを自重で行った'],
  exercises: [
    { name: 'ベンチプレス', heard: 'ベンチプレス', note: '肩甲骨を寄せる', sets: [
      { status: 'match', w: 50, r: 10, bw: false, evidence: 'ベンチプレス 50キロで10回', unsure: '', note: 'フォーム良い' },
      { status: 'inferred', w: 50, r: 8, bw: false, evidence: EVID, unsure: '予告かもしれない', note: '' },
      { status: 'nobasis', w: 60, r: 5, bw: false, evidence: '60キロで5回', unsure: '', note: '' },
      { status: 'healthHidden', w: null, r: null, bw: false, evidence: '', unsure: '', note: '' },
      { status: 'inferred', w: 40, r: null, bw: false, evidence: '40キロいきましょう', unsure: '', note: '' }] },
    { name: 'スカルクラッシュ改', heard: 'スカルフラッシュ', note: '', sets: [{ status: 'match', w: 10, r: 12, bw: false, evidence: 'スカルフラッシュ 10キロで12回', unsure: '', note: '' }] },
    { name: 'スクワット', heard: 'スクワット', note: '', sets: [{ status: 'match', w: null, r: 15, bw: true, evidence: 'スクワット 自重で15回', unsure: '', note: '' }] },
    { name: 'レッグプレス', heard: 'レッグプレス', note: '', sets: [{ status: 'inferred', w: null, r: 8, bw: false, evidence: 'レッグプレス 8回', unsure: '', note: '' }] }],
  condition: ['睡眠不足で疲れ気味'],
  caution: ['膝が少し痛い'],
  coaching: ['お客様の肘を張りすぎない', '〔人〕と一緒に来たいと話していた'],
  hearing: ['睡眠は5時間くらい'],
  next_actions: ['次回はベンチプレスを52.5キロで'],
  member_message: 'フォームが安定してきました。',
  member_todo: ['ストレッチ 2分'],
  unclear: [{ text: '2セット目が予告か実施か分からない', evidence: EVID }],
});

function boot(o = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'https://reservation.tokowaka-gym.com/liff/', pretendToBeVisual: true });
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
  w.cfg = Object.assign({ draft: DRAFT }, o.cfg || {});
  w.fetch = async (url, opt) => {
    const body = JSON.parse(opt.body);
    sent.push({ url: String(url), body });
    const c = w.cfg;
    let r;
    if (body.action === 'k_training') r = { success: true, karteSchema: 33, aiDraft: true, aiConsent: 'agreed', sessions: [], best: [] };
    else if (body.action === 'k_exercises') r = { success: true, karteSchema: 33, exercises: [{ name: 'ベンチプレス', part: 'chest' }], truncated: false };
    else if (body.action === 'k_aiDraft') {
      if (c.hang) await new Promise((res, rej) => { if (opt.signal) opt.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }); });
      r = c.reply ? c.reply(body) : { success: true, draft: c.draft(), model: 'claude-sonnet-5-5', build: 'x' };
    }
    else if (body.action === 'k_addTraining') r = { success: true, sessionId: 'N1', rev: 1, mnoteId: body.member ? 'M1' : undefined };
    else r = { success: true };
    return { json: async () => JSON.parse(JSON.stringify(r)) };
  };
  if (o.crypto !== false) { try { Object.defineProperty(w, 'crypto', { value: globalThis.crypto, configurable: true }); } catch (e) {} w.TextEncoder = TextEncoder; }
  if (o.before) o.before(w);
  w.eval(o.src || SRC);
  return { w, sent };
}
const R = (w) => w.document.getElementById('karteRoot');
const btn = (root, t) => [...root.querySelectorAll('button')].find((x) => x.textContent.indexOf(t) === 0);
const btns = (root, t) => [...root.querySelectorAll('button')].filter((x) => x.textContent.indexOf(t) === 0);
const DKEY = 'karte_tr_draft_v1:T1:C1';
const draftOf = (w) => JSON.parse(w.localStorage.getItem(DKEY) || 'null');
const storeText = (s) => { let o = ''; for (let i = 0; i < s.length; i++) o += s.key(i) + '=' + s.getItem(s.key(i)) + '\n'; return o; };
async function openImport(w) {
  w.KarteUI.open('C1', '会員', 'training'); await settle();
  const b = btn(R(w), '＋ 今日の記録') || btn(R(w), '記録の入力（途中）を開く');
  if (b && !R(w).classList.contains('k-entry')) { b.click(); await settle(); }
  R(w).querySelector('button.k-impgo').click(); await settle();
}
function paste(w, text) { const ta = R(w).querySelector('textarea[aria-label="メモを貼る"]'); ta.value = text; ta.dispatchEvent(new w.Event('input', { bubbles: true })); return ta; }
async function toReview(w) { await openImport(w); paste(w, TRANSCRIPT); btn(R(w), 'AIで振り分ける').click(); await settle(); }
async function saveAll(w) {
  for (let i = 0; i < 4; i++) { const b = R(w).querySelector('button.k-allchk'); if (!b) break; b.click(); await settle(); }
  btn(R(w), '保存する').click(); await settle();
}

const put = (w) => R(w).querySelector('button.k-rvput');
const cards = (w) => [...R(w).querySelectorAll('.k-rvex')];
const card = (w, name) => cards(w).find((c) => c.querySelector('.k-rvname') && c.querySelector('.k-rvname').value === name);
const lineOf = (c) => c.querySelector('.k-rvline');
const chipsOf = (c) => [...c.querySelectorAll('.k-rvchip')].map((x) => x.dataset.st);
const foot = (w) => (R(w).querySelector('.k-rvcount') || {}).textContent || '';
const why = (w) => (R(w).querySelector('.k-rvwhy') || {}).textContent || '';
const field = (w, k) => R(w).querySelector('.k-rvfield[data-field="' + k + '"]');
function type(w, elx, v) { elx.value = v; elx.dispatchEvent(new w.Event('input', { bubbles: true })); }
async function pickPart(w, name, part) {   // 設計52：部位はチップ（推定）を開いてから選ぶ
  const find = () => [...card(w, name).querySelectorAll('button.k-pill')].find((x) => x.textContent === part);
  if (!find()) { card(w, name).querySelector('.k-rvpart').click(); await settle(); }
  find().click(); await settle();
}

// ================= 設計51 の検査 =================
const AKEY = 'karte_ai_review_v1:T1:C1';
const saved = (w) => { const r = w.localStorage.getItem(AKEY); return r == null ? null : JSON.parse(r); };
const band = (w) => R(w).querySelector('.k-airresume');
const aiCalls = (sent) => sent.filter((x) => x.body.action === 'k_aiDraft').length;
const LONG = TRANSCRIPT + '\n' + 'トレーナーとお客様がフォームを確かめながら進めた架空の会話の続き。'.repeat(8);
async function toReviewWith(w, text) { await openImport(w); paste(w, text); btn(R(w), 'AIで振り分ける').click(); await nav(); await settle(); }
async function reopen(w) { await openImport(w); await settle(); }
const now0 = Date.now();

// ---------- U1・U2・U3・U10 振り分け → 直す → 離れる → 戻る → 同じ編集 → 入れたら消える ----------
{
  const { w, sent } = boot({ src: FULL });
  await toReviewWith(w, TRANSCRIPT);
  type(w, lineOf(card(w, 'ベンチプレス')), '50×10  50×8  60×6  ?  40×?');
  type(w, field(w, 'coaching'), 'お客様の肘を張りすぎない\n架空の追加の指導');
  type(w, field(w, 'hearing'), '睡眠は5時間くらい\n膝に痛みがある');
  type(w, card(w, 'レッグプレス').querySelector('.k-rvname'), '膝痛プレス');
  R(w).querySelector('.k-rvmemon').click(); await settle();
  const S = saved(w);
  ok('U1 ★編集のたびに一時保存される（1行・欄・チェック）', S && S.v === 1 && S.tid === 'T1' && S.cid === 'C1' && S.rv.member.on === true && S.rv.exercises.find((e) => e.name === 'ベンチプレス').line === '50×10  50×8  60×6  ?  40×?', JSON.stringify(S).slice(0, 300));
  const all = w.localStorage.getItem(AKEY);
  ok('U3 ★保存に根拠・迷った理由・聞こえた言葉・体のこと・分からなかった点・原文が無い', !all.includes('60キロで5回') && !all.includes(EVID) && !all.includes('予告かもしれない') && !all.includes('スカルフラッシュ') && !all.includes('膝が少し痛い') && !all.includes('予告か実施か') && !all.includes(SECRET) && !all.includes('evidence') && !all.includes('unsure') && !all.includes('caution') && !all.includes('unclear'), all.slice(0, 300));
  ok('U3 ★体のことの言葉の行・名前に体のことの言葉の種目は保存しない（件数も保存しない）', !/痛/.test(all) && !S.rv.exercises.some((e) => /膝痛/.test(e.name)) && S.rv.fields.hearing === '睡眠は5時間くらい' && !('dropped' in S), JSON.stringify(S.rv.fields));
  ok('U3 ★健康由来のセット（healthHidden）は状態も保存しない', JSON.stringify(S.rv.exercises.find((e) => e.name === 'ベンチプレス').orig.map((o) => o.status)) === JSON.stringify(['match', 'inferred', 'nobasis', 'inferred']), JSON.stringify(S.rv.exercises[0].orig));
  type(w, card(w, '膝痛プレス').querySelector('.k-rvname'), 'レッグプレス');
  type(w, field(w, 'hearing'), '睡眠は5時間くらい');
  w.KarteUI.open('C1', '会員', 'training'); await settle();
  { const b0 = btn(R(w), '＋ 今日の記録') || btn(R(w), '記録の入力（途中）を開く'); if (b0 && !R(w).classList.contains('k-entry')) { b0.click(); await settle(); } }
  ok('U10 ★記録の画面の取り込みのボタンに「（振り分けの途中あり）」（設計56：0件は「メモ・音声から」・1件以上は「＋ 音声・メモを追加で取り込む」）', !!R(w).querySelector('button.k-impgo') && /^(メモ・音声から|＋ 音声・メモを追加で取り込む)（振り分けの途中あり）$/.test(R(w).querySelector('button.k-impgo').textContent), (R(w).querySelector('button.k-impgo') || {}).textContent);
  R(w).querySelector('button.k-impgo').click(); await settle();
  ok('U1 ★取り込み画面に帯（時刻・件数）・続ける／捨てて最初から（44px）・保存しない項目の一般の文だけ', !!band(w) && /前回の振り分けが途中です（\d\d:\d\d・種目4・セット/.test(band(w).textContent) && band(w).textContent.includes('保存しない項目があります') && !/体のことの言葉/.test(band(w).textContent) && /min-height:\s*44px/.test(band(w).querySelector('.k-airgo').style.cssText) && /min-height:\s*44px/.test(band(w).querySelector('.k-airdrop').style.cssText), band(w) && band(w).textContent);
  band(w).querySelector('.k-airgo').click(); await settle();
  ok('U1 ★続ける：同じ1行・同じ欄・同じチェック・AI は1回だけ', lineOf(card(w, 'ベンチプレス')).value === '50×10  50×8  60×6  ?  40×?' && field(w, 'coaching').value === 'お客様の肘を張りすぎない\n架空の追加の指導' && R(w).querySelector('.k-rvmemon').checked === true && aiCalls(sent) === 1);
  ok('U1 ★続けた後も色（出所）は同じ（一致・推測・直した・入れない・入れない）', JSON.stringify(chipsOf(card(w, 'ベンチプレス'))) === JSON.stringify(['match', 'inferred', 'edited', 'skip', 'skip']), JSON.stringify(chipsOf(card(w, 'ベンチプレス'))));
  ok('U12 ★復元した状態では根拠を見る自体を出さない・前回の判定と出す（関門① 5）', !R(w).querySelector('.k-rvev') && !!R(w).querySelector('.k-airrestored') && card(w, 'ベンチプレス').querySelector('.k-rvchip').textContent.includes('（前回の判定）') && !R(w).querySelector('.k-rvcau') && !R(w).querySelector('.k-rvunclear'));
  await pickPart(w, 'スカルクラッシュ改', '腕');
  put(w).click(); await nav();
  const D = draftOf(w);
  const bs = D && D.items.find((x) => x.exercise === 'ベンチプレス').sets.map((s) => [s.w, s.r, s.src || null, !!s.srcEdited]);
  ok('U2 ★続けて入れた下書きが続けずに入れたときと同じ（src も同じ）', JSON.stringify(bs) === JSON.stringify([['50', '10', null, false], ['50', '8', 'inferred', false], ['60', '6', 'nobasis', true]]), JSON.stringify(bs));
  ok('U2 ★記録の画面に入れたら一時保存が消える', saved(w) === null);
  await reopen(w);
  ok('U2 もう一度開いても帯が出ない', !band(w));
}
// ---------- U4 期限（24時間・日付・未来の時刻）・起動と保存の時に物理削除 ----------
for (const [label, mut] of [['24時間を超えた', (v) => { v.at = now0 - 25 * 3600000; }], ['日付が違う', (v) => { v.day = '2000-01-01'; }], ['未来の時刻', (v) => { v.at = now0 + 3600000; }], ['時刻が数でない', (v) => { v.at = 'x'; }]]) {
  const { w } = boot({ src: FULL });
  await toReviewWith(w, TRANSCRIPT);
  const v = saved(w); mut(v); w.localStorage.setItem(AKEY, JSON.stringify(v));
  w.localStorage.setItem('karte_ai_review_v1:T9:C9', JSON.stringify(Object.assign({}, v, { tid: 'T9', cid: 'C9' })));
  await reopen(w);
  ok('U4 ★' + label + '：帯が出ず消える（ほかの人の期限切れも物理削除）', !band(w) && saved(w) === null && w.localStorage.getItem('karte_ai_review_v1:T9:C9') === null && !R(w).querySelector('.k-airnote'));
}
{
  //   起動の時（カルテの読み込み）にも物理削除する
  const { w } = boot({ src: FULL, before: (w0) => { w0.localStorage.setItem('karte_ai_review_v1:T9:C9', JSON.stringify({ v: 1, tid: 'T9', cid: 'C9', day: '2000-01-01', at: 1 })); w0.localStorage.setItem('karte_ai_review_v1:T8:C8', '{壊れ'); } });
  ok('U4 ★起動の時に期限切れ・壊れた一時保存を物理削除する', w.localStorage.getItem('karte_ai_review_v1:T9:C9') === null && w.localStorage.getItem('karte_ai_review_v1:T8:C8') === null);
}
// ---------- U5 壊れた保存は使わずに消して1行で知らせる ----------
{
  const base = await (async () => { const { w } = boot({ src: FULL }); await toReviewWith(w, TRANSCRIPT); return saved(w); })();
  const cases = [
    ['JSON でない', null, '{壊れた'], ['status が健康由来', (v) => { v.rv.exercises[0].orig[0].status = 'healthHidden'; }], ['status が知らない値', (v) => { v.rv.exercises[0].orig[0].status = 'ok'; }],
    ['セット11', (v) => { v.rv.exercises[0].orig = Array.from({ length: 11 }, () => ({ status: 'match', w: 50, r: 10, bw: false })); }], ['tid 違い', (v) => { v.tid = 'T2'; }], ['cid 違い', (v) => { v.cid = 'C2'; }],
    ['v 違い', (v) => { v.v = 2; }], ['rv.v 違い', (v) => { v.rv.v = 2; }], ['scope 違い', (v) => { v.scope = 'trial'; }], ['欄に体のことの言葉', (v) => { v.rv.fields.coaching = '膝が痛い'; }],
    ['しるしの形が違う', (v) => { v.hash = 'abc'; }], ['数字が範囲外', (v) => { v.rv.exercises[0].orig[0].w = 900; }],
  ];
  for (const [label, mut, raw] of cases) {
    const { w } = boot({ src: FULL });
    let txt = raw;
    if (!txt) { const v = JSON.parse(JSON.stringify(base)); v.at = Date.now(); mut(v); txt = JSON.stringify(v); }
    w.localStorage.setItem(AKEY, txt);
    await reopen(w);
    ok('U5 ★' + label + '：帯が出ず消える・1行の知らせ・壊れた状態を出さない', !band(w) && saved(w) === null && (R(w).querySelector('.k-airnote') || {}).textContent === '前回の途中の内容は読めなかったため捨てました。' && !R(w).querySelector('.k-rvex'), String(w.localStorage.getItem(AKEY)));
  }
  //   関門① 4：trial の画面では範囲外の欄（今日の流れ等）が空でない保存は捨てる・trial で保存するときは範囲外の欄を保存しない
  const { w } = boot({ src: SRC });
  await toReviewWith(w, TRANSCRIPT);
  const st = saved(w);
  ok('U13 ★trial で保存すると範囲外の欄（今日の流れ・状態・次回やること）は空', st && st.scope === 'trial' && st.rv.fields.flow === '' && st.rv.fields.condition === '' && st.rv.fields.next === '' && st.rv.fields.coaching !== '', JSON.stringify(st && st.rv.fields));
  st.rv.fields.flow = '範囲外の架空の文'; w.localStorage.setItem(AKEY, JSON.stringify(st));
  await reopen(w);
  ok('U13 ★trial の画面で範囲外の欄に文がある保存は捨てる', !band(w) && saved(w) === null);
}
// ---------- U6 しるしの照合 ----------
{
  const { w, sent } = boot({ src: FULL });
  await toReviewWith(w, LONG);
  ok('U6 しるしは長い文字起こしのときだけ保存（64桁）・原文は保存しない', /^[0-9a-f]{64}$/.test(saved(w).hash) && !w.localStorage.getItem(AKEY).includes('架空の会話'));
  type(w, lineOf(card(w, 'ベンチプレス')), '50×10  50×8  60×7  ?  40×?');
  await reopen(w);
  paste(w, LONG); btn(R(w), 'AIで振り分ける').click(); await nav(); await settle();
  ok('U6 ★同じ文字起こし → 送らずに保存から出す（直した1行も残る）・知らせ', aiCalls(sent) === 1 && lineOf(card(w, 'ベンチプレス')).value === '50×10  50×8  60×7  ?  40×?' && !!R(w).querySelector('.k-airreused'), String(aiCalls(sent)));
  R(w).querySelector('.k-airredo').click(); await nav(); await settle();
  ok('U6 ★振り分け直すを押したときだけ送る（回数1）', aiCalls(sent) === 2 && lineOf(card(w, 'ベンチプレス')).value === '50×10  50×8  60×5  ?  40×?');
  await reopen(w);
  paste(w, LONG + '。'); btn(R(w), 'AIで振り分ける').click(); await nav(); await settle();
  ok('U6 ★1字違えば送る', aiCalls(sent) === 3);
}
{
  const { w, sent } = boot({ src: FULL });
  await toReviewWith(w, TRANSCRIPT);
  ok('U6 ★短い文字起こし（' + TRANSCRIPT.length + '字＜200）はしるしを保存しない', saved(w).hash === '');
  await reopen(w);
  paste(w, TRANSCRIPT); btn(R(w), 'AIで振り分ける').click(); await nav(); await settle();
  ok('U6 ★短い文字起こしは照合せず今どおり送る', aiCalls(sent) === 2);
}
{
  const { w, sent } = boot({ src: FULL, crypto: false, before: (w0) => { try { Object.defineProperty(w0, 'crypto', { value: undefined, configurable: true }); } catch (e) {} } });
  await toReviewWith(w, LONG);
  await reopen(w);
  paste(w, LONG); btn(R(w), 'AIで振り分ける').click(); await nav(); await settle();
  ok('U6 しるしを作れない端末は照合せず送る（帯での続きは使える）', saved(w).hash === '' && aiCalls(sent) === 2);
}
{
  //   ★しるしにトレーナー・お客様の前置きがある：別のお客様の同じ文字起こしと一致しない
  const { w } = boot({ src: FULL });
  await toReviewWith(w, LONG);
  const h1 = saved(w).hash;
  const enc = new TextEncoder();
  const hex = async (s) => Buffer.from(await globalThis.crypto.subtle.digest('SHA-256', enc.encode(s))).toString('hex');
  ok('U6 ★しるし＝SHA-256(前置き＋トレーナー＋お客様＋原文)・原文だけのしるしとは違う', h1 === await hex('karte-ai-v1:T1:C1:' + LONG.trim()) && h1 !== await hex(LONG.trim()) && h1 !== await hex('karte-ai-v1:T1:C2:' + LONG.trim()));
}
// ---------- U7 捨てて最初から・元に戻す ----------
{
  const { w } = boot({ src: FULL });
  await toReviewWith(w, TRANSCRIPT);
  await reopen(w);
  band(w).querySelector('.k-airdrop').click(); await settle();
  ok('U7 ★捨てる：保存が消え「元に戻す」（ダイアログなし）', saved(w) === null && !!R(w).querySelector('.k-airundo') && w.confirms === 0);
  R(w).querySelector('.k-airback').click(); await settle();
  ok('U7 元に戻す：保存と帯が戻る', saved(w) !== null && !!band(w));
  band(w).querySelector('.k-airdrop').click(); await settle();
  paste(w, '架空の別のメモ'); await settle();
  ok('U7 貼り付け欄に入れたら元に戻すは消える', !R(w).querySelector('.k-airundo') && saved(w) === null);
}
// ---------- U8 localStorage に書けない端末 ----------
{
  const { w } = boot({ src: FULL, before: (w0) => { const orig = w0.Storage.prototype.setItem; w0.Storage.prototype.setItem = function (k, v) { if (String(k).indexOf('karte_ai_review_v1:') === 0) throw new Error('quota'); return orig.call(this, k, v); }; } });
  await toReviewWith(w, TRANSCRIPT);
  ok('U8 ★書けなくても確認画面は動く・下の帯に「残せません」', !!card(w, 'ベンチプレス') && (R(w).querySelector('.k-airfail') || {}).textContent === 'この端末には途中の内容を残せません（画面を離れると最初からになります）');
}
// ---------- U9 別のトレーナー ----------
{
  const { w } = boot({ src: FULL });
  await toReviewWith(w, TRANSCRIPT);
  w.state.trainerId = 'T2';
  await reopen(w);
  ok('U9 ★別のトレーナーには帯が出ない・相手の保存は消さない', !band(w) && saved(w) !== null);
}
// ---------- U11 貼り付け欄を変えても保存は消えない ----------
{
  const { w } = boot({ src: FULL });
  await toReviewWith(w, TRANSCRIPT);
  paste(w, TRANSCRIPT + '\n追記'); await settle();
  ok('U11 ★貼り付け欄を変えると確認は閉じるが保存は残り、帯が出る', !card(w, 'ベンチプレス') && saved(w) !== null && !!band(w));
}
// ---------- U14 関門② 1：処理中にトレーナーが替わったら捨てる（保存もしない） ----------
{
  //   しるしの計算の後の復帰点（長い文字起こし）
  const { w, sent } = boot({ src: FULL });
  await openImport(w);
  paste(w, LONG); btn(R(w), 'AIで振り分ける').click();
  w.state.trainerId = 'T2';
  await nav(); await settle();
  ok('U14 ★しるしの計算中にトレーナーが替わった → 送らない・画面に出さない・どちらの鍵にも保存しない', aiCalls(sent) === 0 && !card(w, 'ベンチプレス') && saved(w) === null && w.localStorage.getItem('karte_ai_review_v1:T2:C1') === null, String(aiCalls(sent)));
}
{
  //   AI の応答の後の復帰点（短い文字起こし＝しるしを作らずすぐ送る）
  const { w, sent } = boot({ src: FULL });
  const f0 = w.fetch;
  w.fetch = async (u, o) => { if (JSON.parse(o.body).action === 'k_aiDraft') await new Promise((r) => setTimeout(r, 30)); return f0(u, o); };
  await openImport(w);
  paste(w, TRANSCRIPT); btn(R(w), 'AIで振り分ける').click();
  await settle();
  w.state.trainerId = 'T2';
  await nav(); await nav(); await settle();
  ok('U14 ★AI の応答を待つ間にトレーナーが替わった → 応答を捨てる・前の人の鍵にも今の人の鍵にも保存しない', aiCalls(sent) === 1 && !card(w, 'ベンチプレス') && saved(w) === null && w.localStorage.getItem('karte_ai_review_v1:T2:C1') === null, String(aiCalls(sent)));
}
{
  //   確認の途中でトレーナーが替わったら、前の人の鍵へ書かない
  const { w } = boot({ src: FULL });
  await toReviewWith(w, TRANSCRIPT);
  const before = w.localStorage.getItem(AKEY);
  w.state.trainerId = 'T2';
  type(w, lineOf(card(w, 'ベンチプレス')), '50×10');
  ok('U14 ★確認の途中でトレーナーが替わった画面の編集は、前の人の鍵へ書かない', w.localStorage.getItem(AKEY) === before && w.localStorage.getItem('karte_ai_review_v1:T2:C1') === null);
}
// ---------- U15 関門② 2：取り込み画面の説明が実装と合う ----------
{
  const { w } = boot({ src: FULL });
  await openImport(w);
  const tx = (R(w).querySelector('.k-aiexplain') || {}).textContent || '';
  ok('U15 ★取り込み画面の説明の文（画面に出る文で固定）', tx === '「読み取る」は端末の中だけで読みます。「AIで振り分ける」は外部（Anthropic）へ送ります。登録済みの氏名などは機械的に伏せますが、聞き違い・第三者の名前・トレーナーの名前のかな書きは残ることがあります。送った文字起こしは保存しません。振り分けた内容は、この端末に当日中だけ残ります（記録の画面に入れると消えます。根拠・体のことは残しません。同じ端末を使う人は読めます）。', tx);
  ok('U15 ★「保存はしません」（一時保存と逆の説明）が画面に無い', !R(w).textContent.includes('保存はしません。'));
}
// ---------- 純粋データ ----------
{
  const { w } = boot({ src: FULL });
  const T = w.KarteUI._t;
  const isAuto = (n) => ['ベンチプレス', 'スクワット', 'レッグプレス'].indexOf(n) >= 0;
  const rv = T.reviewFromDraft(DRAFT(), isAuto, 'full');
  const fs = T.rvForSave(rv, 'full');
  ok('P1 ★保存する形に根拠・迷い・聞こえた言葉・体のこと・分からなかった点の鍵が無い', !/"(evidence|unsure|heard|caution|unclear|note)":/.test(JSON.stringify(fs.exercises.map((e) => e.orig))) && !('heard' in fs.exercises[0]) && !('caution' in fs) && !('unclear' in fs), JSON.stringify(fs).slice(0, 300));
  const ft = T.rvForSave(rv, 'trial');
  ok('P1 trial の保存は範囲外の欄が空', ft.fields.flow === '' && ft.fields.next === '' && ft.fields.coaching !== '');
  const sv = { v: 1, tid: 'T1', cid: 'C1', day: new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10), at: Date.now(), scope: 'full', hash: '', rv: fs };
  const r1 = T.rvRestore(sv, { tid: 'T1', cid: 'C1', scope: 'full', now: Date.now() });
  ok('P2 ★保存→復元で restored・根拠は空・体のことは空', r1.ok && r1.rv.restored === true && r1.rv.exercises[0].orig.every((o) => o.evidence === '' && o.unsure === '') && r1.rv.caution.length === 0);
  ok('P2 復元は期限切れを stale として区別する', T.rvRestore(Object.assign({}, sv, { at: Date.now() - 25 * 3600000 }), { tid: 'T1', cid: 'C1', scope: 'full', now: Date.now() }).stale === true);
}

console.log(`liff-karte-ai-resume: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
