// カルテのトレーニングの記録の改修（2026-11-06 オーナー要望の5点）を、本番の liff/karte.js を jsdom で動かして入口から通す
//   実行: node worker/test/liff-karte-exercises.test.js
//
//   S. 保存できない：開いてから11分後に保存 → 送らずに退避して logout→読み直し／読み直し後に新しいトークンで送れる（印が消える）／
//      2回目も古ければ読み直さずに案内（入力は端末に残る）／401 の経路も logout してから読み直す／ログインの印が無い起動で無限ループにならない
//   P. 種目を全員で共有し部位を付ける：共有の一覧が出る・部位の鍵は Worker・表の CHECK と同じ・新しい種目は部位を選んで登録・部位を直せる
//   B. 自重：重量が空の✓は 0 で送る・回数が空は送らない・0 は「自重」と出す（記録の画面・見る側・写す画面・会員の画面）
//   T. 休憩タイマーのオン/オフ：なしなら✓で数えない・帯と秒数・終了音の行を出さない・なしにした瞬間に止める
//   ★名前・ID は架空の値だけ

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const require = createRequire(join(homedir(), '.cache/claude-node/package.json'));
const { JSDOM } = require('jsdom');
const SRC = readFileSync(join(ROOT, 'liff/karte.js'), 'utf8');
const HTML = readFileSync(join(ROOT, 'liff/index.html'), 'utf8');
const MIG = readFileSync(join(ROOT, 'worker/migrations/0028_karte_exercises.sql'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) pass++; else { fail++; console.log(`❌ ${name}${detail ? '\n   ' + detail : ''}`); } }
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 10; i++) await tick(); }

const b64u = (s) => Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
//   LINE の ID トークンの形（署名は画面では見ない）。名前に日本語を入れて、読み解きが壊れないことも見る
const jwt = (ageS) => b64u(JSON.stringify({ alg: 'ES256' })) + '.' + b64u(JSON.stringify({ iss: 'https://access.line.me', sub: 'U_TEST', name: '架空 太郎', iat: Math.floor(Date.now() / 1000) - ageS, exp: Math.floor(Date.now() / 1000) + 3600 })) + '.sig';

const TR_HIST = [{ session_id: 'S3', session_date: '2026-11-01', created_at: 300, author_trainer_id: 'T1', rev: 1, sets: [
  { exercise: 'スクワット', set_no: 1, weight_kg: 40, reps: 10, e1rm: 53.3 }, { exercise: 'スクワット', set_no: 2, weight_kg: 40, reps: 8, e1rm: 50.7 }] }];
const BW_HIST = [{ session_id: 'B1', session_date: '2026-11-01', created_at: 300, author_trainer_id: 'T1', rev: 1, sets: [
  { exercise: 'ディップス', set_no: 1, weight_kg: 0, reps: 12, e1rm: 0 }, { exercise: 'ディップス', set_no: 2, weight_kg: 0, reps: 10, e1rm: 0 },
  { exercise: 'チンニング', set_no: 1, weight_kg: 0, reps: 8, e1rm: 0 }, { exercise: 'チンニング', set_no: 2, weight_kg: 5, reps: 6, e1rm: 6 }] }];

function boot(responder, o = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'https://reservation.tokowaka-gym.com/liff/', pretendToBeVisual: true });
  const w = dom.window;
  const sent = [];
  for (const [k, v] of Object.entries(o.ls || {})) w.localStorage.setItem(k, v);
  for (const [k, v] of Object.entries(o.ss || {})) w.sessionStorage.setItem(k, v);
  w.idToken = o.token || 'TOKEN1';
  w.EDGE_URL = 'https://edge.example';
  w.state = { trainerId: 'T1', _isOwner: false, _allTrainers: [{ id: 'T1', name: '一郎' }] };
  w.alerts = []; w.alert = (m) => w.alerts.push(String(m));
  w.confirms = 0; w.confirm = () => { w.confirms++; return true; };
  w.reloaded = 0; w.__karteReload = () => { w.reloaded++; };
  w.logouts = 0;
  w.liff = Object.assign({ getIDToken: () => w.idToken, logout: () => { w.logouts++; } }, o.liff || {});
  w.fetch = async (url, opt) => {
    const body = JSON.parse(opt.body);
    sent.push(body);
    const r = await responder(body, sent);
    return { json: async () => r };
  };
  w.eval(SRC);
  return { w, sent };
}
const btn = (root, t) => [...root.querySelectorAll('button')].find((x) => x.textContent.indexOf(t) === 0);
const pill = (root, t) => [...root.querySelectorAll('button.k-pill')].find((x) => x.textContent === t);
const DKEY = 'karte_tr_draft_v1:T1:C1';
const draftOf = (w) => JSON.parse(w.localStorage.getItem(DKEY) || 'null');
const storeOf = (s) => { const o = {}; for (let i = 0; i < s.length; i++) o[s.key(i)] = s.getItem(s.key(i)); return o; };
const R = (w) => w.document.getElementById('karteRoot');

//   記録の画面を開いて「スクワット」（前回 40kg×10）を足し、1セット目に✓
async function openWithSet(w) {
  w.KarteUI.open('C1', '会員', 'training'); await settle();
  btn(R(w), '＋ 今日の記録').click(); await settle();
  btn(R(w), '＋ 種目を足す').click();
  pill(R(w), 'スクワット').click();
  btn(R(w), '選んだ 1 種目を足す').click(); await settle();
  R(w).querySelector('button[aria-label$="実施済みにする"]').click(); await settle();
}
const trResp = (extra) => async (b) => {
  if (b.action === 'k_training') return { success: true, karteSchema: 32, sessions: TR_HIST, best: [] };
  if (b.action === 'k_exercises') return { success: true, karteSchema: 32, exercises: [], truncated: false };
  return extra ? extra(b) : { success: true, sessionId: 'N1', rev: 1 };
};

// ================= S. 保存できない（トークンの取り直し） =================
let S1store = null;
{
  //   S1：開いてから11分後に保存する＝手元のトークンが9分を超えている → 送らずに退避して logout → 読み直し
  const { w, sent } = boot(trResp(), { token: jwt(61 * 60) });
  await openWithSet(w);
  btn(R(w), '保存する').click(); await settle();
  const d = draftOf(w);
  const ss = JSON.parse(w.sessionStorage.getItem('karte_draft_v1') || 'null');
  const mark = Number(w.sessionStorage.getItem('karte_reauth') || 0);
  ok('S1-1 ★古いトークンでは送らない（k_addTraining を1回も送らない）', !sent.some((x) => x.action === 'k_addTraining'), JSON.stringify(sent.map((x) => x.action)));
  ok('S1-2 ★LINE アプリの中では logout せず読み直すだけ（logout すると最初のページに戻る・決定0142）', w.logouts === 0 && w.reloaded === 1, `logout=${w.logouts} reload=${w.reloaded}`);
  ok('S1-3 ★入力は端末の下書きに残り、送信中（pending）にしない＝読み直し後に「結果が分からない」と出さない', d && d.items.length === 1 && d.items[0].sets[0].done === true && !d.pending, JSON.stringify(d));
  ok('S1-4 退避（sessionStorage）は記録の画面へ戻る印だけ（中身・氏名を入れない）・読み直しの印に時刻', ss && ss.tab === 'training' && ss.draft && ss.draft.kind === 'training' && !JSON.stringify(ss).includes('スクワット') && !JSON.stringify(ss).includes('会員') && mark > Date.now() - 5000);
  S1store = { ls: storeOf(w.localStorage), ss: storeOf(w.sessionStorage) };
}
{
  //   S2：読み直した後（新しいトークン）→ 入力が戻る → 保存すると新しいトークンで送れる → 読み直しの印を消す
  const { w, sent } = boot(trResp(), { token: jwt(5), ls: S1store.ls, ss: S1store.ss });
  await new Promise((r) => setTimeout(r, 30)); await settle();
  ok('S2-1 読み直した後に記録の画面と入力（✓も）が戻る・もう一度押すよう案内', !!R(w) && R(w).querySelector('button[aria-label$="実施済みにする"]').getAttribute('aria-pressed') === 'true' && w.alerts.some((a) => a.includes('もう一度')));
  ok('S2-2 戻しても読み直しの印はまだ残す（書けるまで）', !!w.sessionStorage.getItem('karte_reauth') && !w.sessionStorage.getItem('karte_draft_v1'));
  btn(R(w), '保存する').click(); await settle();
  const tr = sent.filter((x) => x.action === 'k_addTraining');
  ok('S2-3 ★新しいトークンで送れる（✓の1セット）', tr.length === 1 && tr[0].idToken === w.idToken && tr[0].items[0].sets.length === 1, JSON.stringify(tr));
  ok('S2-4 ★送れたら読み直しの印を消す・下書きも消える', !w.sessionStorage.getItem('karte_reauth') && !w.localStorage.getItem(DKEY) && w.reloaded === 0);
}
{
  //   S3：読み直してもまだ古い（Worker が 401）→ もう読み直さず「LINE から開き直して」・入力は端末に残る
  const { w, sent } = boot(trResp((b) => (b.action === 'k_addTraining' ? { success: false, code: 'UNAUTHORIZED', detail: 'STALE_TOKEN' } : { success: true })),
    { token: jwt(61 * 60), ls: S1store.ls, ss: S1store.ss });
  await new Promise((r) => setTimeout(r, 30)); await settle();
  btn(R(w), '保存する').click(); await settle();
  const d = draftOf(w);
  ok('S3-1 ★読み直した直後は画面で止めずに送る（端末の時計のずれで読み直しが止まらない形を作らない）', sent.filter((x) => x.action === 'k_addTraining').length === 1);
  ok('S3-2 ★2回目の 401 では読み直さない（無限に読み直さない）', w.reloaded === 0 && w.logouts === 0);
  ok('S3-3 ★「LINE から開き直して」と出す（「うまくいきませんでした（STALE）」にしない）', w.alerts.some((a) => a.includes('LINE から開き直して')) && !w.alerts.some((a) => a.includes('（STALE）')), JSON.stringify(w.alerts));
  ok('S3-4 入力は端末に残る（送信中を解き、編集に戻れる）', d && d.items.length === 1 && !d.pending && !!R(w).querySelector('button[aria-label$="実施済みにする"]'));
}
{
  //   S4：トークンが読めない形でも、Worker の 401 が来たら同じ取り直し（logout → 読み直し）
  const { w } = boot(trResp((b) => (b.action === 'k_addTraining' ? { success: false, code: 'UNAUTHORIZED', detail: 'STALE_TOKEN' } : { success: true })));
  await openWithSet(w);
  btn(R(w), '保存する').click(); await settle();
  const d = draftOf(w);
  ok('S4-1 ★401 の経路も同じ取り直し（アプリの中は logout しない・送った中身は下書きに固定）', w.logouts === 0 && w.reloaded === 1 && d && d.pending && d.pending.payload.items.length === 1);
}
{
  //   S5：liff.getDecodedIDToken があればそれの iat を使う（送るトークンと LIFF のトークンが同じとき）
  const { w, sent } = boot(trResp(), { token: 'OPAQUE', liff: { getDecodedIDToken: () => ({ iat: Math.floor(Date.now() / 1000) - 3600 }) } });
  await openWithSet(w);
  btn(R(w), '保存する').click(); await settle();
  ok('S5-1 getDecodedIDToken の iat で古さを見る', !sent.some((x) => x.action === 'k_addTraining') && w.reloaded === 1);
  //   S6：端末の時計が遅れていて iat が未来に見える／8分のトークンは送る
  const e2 = boot(trResp(), { token: jwt(-120) });
  await openWithSet(e2.w);
  btn(R(e2.w), '保存する').click(); await settle();
  const e3 = boot(trResp(), { token: jwt(58 * 60) });
  await openWithSet(e3.w);
  btn(R(e3.w), '保存する').click(); await settle();
  ok('S6-1 iat が未来・発行から58分のトークンはそのまま送る', e2.sent.some((x) => x.action === 'k_addTraining') && e3.sent.some((x) => x.action === 'k_addTraining') && e2.w.reloaded === 0 && e3.w.reloaded === 0);
}
{
  //   S1b：LINE アプリの外（PC 等の外部ブラウザ・isInClient()===false）では logout してから読み直す（liff.init が古いトークンを返し続けるため）
  const out = boot(trResp(), { token: jwt(61 * 60), liff: { isInClient: () => false } });
  await openWithSet(out.w);
  btn(R(out.w), '保存する').click(); await settle();
  ok('S1b-1 ★アプリの外では logout してから読み直す', out.w.logouts === 1 && out.w.reloaded === 1 && !out.sent.some((x) => x.action === 'k_addTraining'), `logout=${out.w.logouts} reload=${out.w.reloaded}`);
  const inn = boot(trResp(), { token: jwt(61 * 60), liff: { isInClient: () => true } });
  await openWithSet(inn.w);
  btn(R(inn.w), '保存する').click(); await settle();
  ok('S1b-2 ★アプリの中（isInClient()===true）では logout しない', inn.w.logouts === 0 && inn.w.reloaded === 1, `logout=${inn.w.logouts} reload=${inn.w.reloaded}`);
}
{
  //   S7：トレーニング以外の書き込み（指導メモ）も同じ：送らずに入力を退避して取り直す
  const { w, sent } = boot(async (b) => (b.action === 'k_notes' ? { success: true, karteSchema: 32, notes: [] } : { success: true }), { token: jwt(61 * 60) });
  w.KarteUI.open('C1', '会員', 'notes'); await settle();
  btn(R(w), '＋ メモを書く').click(); await settle();
  R(w).querySelectorAll('textarea')[0].value = '消したくない架空のメモ';
  btn(R(w), '保存する').click(); await settle();
  const ss = JSON.parse(w.sessionStorage.getItem('karte_draft_v1') || 'null');
  ok('S7-1 ★指導メモも送らずに退避して読み直し', !sent.some((x) => x.action === 'k_addNote') && w.logouts === 0 && w.reloaded === 1 && ss && ss.draft && ss.draft.data.body === '消したくない架空のメモ', JSON.stringify(ss));
  //   S8：種目の登録（k_saveExercise）も書き込み＝同じ守り
  const e = boot(trResp(), { token: jwt(61 * 60) });
  e.w.KarteUI.open('C1', '会員', 'training'); await settle();
  btn(R(e.w), '＋ 今日の記録').click(); await settle();
  btn(R(e.w), '＋ 種目を足す').click();
  const q = R(e.w).querySelector('input[aria-label="種目を探す"]'); q.value = 'ケーブルクロス'; q.oninput(); await settle();
  btn(R(e.w), '「ケーブルクロス」を').click(); await settle();
  ok('S8-1 種目の登録も古いトークンでは送らずに取り直す', !e.sent.some((x) => x.action === 'k_saveExercise') && e.w.reloaded === 1);
  ok('S9-1 ★Worker の上限は1時間・画面は59分で取り直す（決定0142）', /TOKEN_MAX_AGE_S: 3600,/.test(readFileSync(join(ROOT, 'worker/src/routes/karte.js'), 'utf8')) && /TOKEN_REFRESH_S = 3540/.test(SRC));
}
{
  //   S10：index.html の起動：ログインの印が無い（liff.logout の後に LINE が自動で入り直さなかった）→ liff.login を1回だけ呼ぶ。
  //        読み直し（location.reload）・エラーの画面・起動の続きに進まない＝無限ループ・白い画面にしない
  const STYLE = HTML.slice(HTML.indexOf('<style>') + 7, HTML.indexOf('</style>'));
  const BODY = HTML.slice(HTML.indexOf('<body'), HTML.indexOf('<script'));
  const S0 = HTML.indexOf('<script>\n') + 9;
  let ISRC = HTML.slice(S0, HTML.indexOf('</script>', S0));
  const BOOT_HEAD = '  function fetchBoot(){\n';
  ok('S10-0 本番のスクリプトから fetchBoot の入口が1つ見つかる', ISRC.split(BOOT_HEAD).length === 2);
  ISRC = ISRC.replace(BOOT_HEAD, '  function fetchBoot(){ window.__bootCalls++; return Promise.resolve({ success: false }); }\n  function __realBoot(){\n');
  const dom = new JSDOM('<!doctype html><html><head><style>' + STYLE + '</style></head>' + BODY + '</html>', { runScripts: 'outside-only', url: 'https://reservation.tokowaka-gym.com/liff/', pretendToBeVisual: true });
  const w = dom.window;
  const st = w.setTimeout.bind(w); w.setTimeout = (f, ms) => st(f, Math.min(ms || 0, 3));
  w.__bootCalls = 0; w.logins = 0; w.inits = 0; w.alert = () => {}; w.reloaded = 0; w.__karteReload = () => { w.reloaded++; };
  w.fetch = async () => ({ json: async () => ({ success: true }) });
  //   取り直しの途中の状態（退避と印）を置いておく
  w.sessionStorage.setItem('karte_reauth', String(Date.now()));
  w.sessionStorage.setItem('karte_draft_v1', JSON.stringify({ customerId: 'C1', name: '', tab: 'training', draft: { kind: 'training' }, at: Date.now() }));
  w.liff = { init: () => { w.inits++; return Promise.resolve(); }, isLoggedIn: () => false, login: () => { w.logins++; }, getIDToken: () => null, isInClient: () => true, getAppLanguage: () => 'ja', getLanguage: () => 'ja', closeWindow() {} };
  w.eval(ISRC);
  w.eval(SRC);
  for (let i = 0; i < 60; i++) await tick();
  await new Promise((r) => setTimeout(r, 200));
  const err = w.document.getElementById('s-error');
  ok('S10-1 ★ログインの印が無ければ liff.login を1回だけ呼び、起動の続き（fetchBoot）に進まない', w.inits === 1 && w.logins === 1 && w.__bootCalls === 0, `init=${w.inits} login=${w.logins} boot=${w.__bootCalls}`);
  ok('S10-2 ★エラーの画面を出さない・カルテは読み直さない（無限ループにしない）', (!err || err.hidden) && w.reloaded === 0 && !w.document.getElementById('karteRoot'));
  ok('S10-3 トレーナーの起動が済まないまま待ちきったら、退避と印を消す（次の取り直しを止めない）', !w.sessionStorage.getItem('karte_reauth'), w.sessionStorage.getItem('karte_reauth'));
}

// ================= S11. 入力のあるフォームは、取り直しの後に同じ画面で戻す（関門② 高1・低8） =================
const SUMMARY = (b) => ({ success: true, karteSchema: 32, customer: { customerId: b.customerId, name: '会員', trainerId: 'T1' }, assigned: true, consent: { state: 'none' }, profile: null, safetyBrief: null, lastNote: null, nextReservation: null });
const baseResp = (extra) => async (b) => {
  if (extra) { const v = extra(b); if (v !== undefined) return v; }
  if (b.action === 'k_summary') return SUMMARY(b);
  if (b.action === 'k_body') return { success: true, ready: true, rows: [], goal: null, raw: [] };
  if (b.action === 'k_contract') return { success: true, contracts: [] };
  if (b.action === 'k_training') return { success: true, karteSchema: 32, sessions: TR_HIST2, best: [] };
  if (b.action === 'k_exercises') return { success: true, karteSchema: 32, exercises: [], truncated: false };
  return { success: true };
};
const TR_HIST2 = [{ session_id: 'S5', session_date: '2026-11-01', created_at: 300, author_trainer_id: 'T1', rev: 1, sets: [
  { exercise: 'ブルガリアンスクワット', set_no: 1, weight_kg: 10, reps: 10, e1rm: 13.3 }, { exercise: 'スクワット', set_no: 1, weight_kg: 40, reps: 10, e1rm: 53.3 }] }];
const stashOf = (w) => ({ ls: storeOf(w.localStorage), ss: storeOf(w.sessionStorage) });
async function afterReload(st, resp) { const e = boot(resp || baseResp(), { token: jwt(5), ls: st.ls, ss: st.ss }); for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5)); await settle(); return e; }
{
  //   目標線（体組成）
  const { w, sent } = boot(baseResp(), { token: jwt(61 * 60) });
  w.KarteUI.open('C1', '会員', 'body'); await settle();
  const gcard = () => [...R(w).querySelectorAll('.k-card')].filter((c) => c.textContent.includes('体重の目標線')).pop();
  const ins = gcard().querySelectorAll('input');
  ins[1].value = '2027-03-31'; ins[2].value = '72.5'; ins[3].value = '66';
  btn(gcard(), '目標線を保存').click(); await settle();
  const ss = JSON.parse(w.sessionStorage.getItem('karte_draft_v1') || 'null');
  ok('S11-1 ★目標線：古いトークンでは送らず、入力を退避して読み直す（氏名を残さない）', !sent.some((x) => x.action === 'k_saveGoalLine') && w.reloaded === 1 && ss && ss.tab === 'body' && ss.draft.kind === 'goalLine' && ss.draft.cid === 'C1' && ss.draft.data.targetWeight === '66' && ss.name === '' && !JSON.stringify(ss).includes('会員'), JSON.stringify(ss));
  const e = await afterReload(stashOf(w));
  const g2 = [...R(e.w).querySelectorAll('.k-card')].filter((c) => c.textContent.includes('体重の目標線')).pop();
  const i2 = g2 && g2.querySelectorAll('input');
  ok('S11-2 ★読み直した後、体組成の目標線に入力が戻る', !!i2 && i2[1].value === '2027-03-31' && i2[2].value === '72.5' && i2[3].value === '66', g2 ? [...i2].map((x) => x.value).join(',') : 'none');
  btn(g2, '目標線を保存').click(); await settle();
  const sg = e.sent.filter((x) => x.action === 'k_saveGoalLine');
  ok('S11-3 戻した値と同じ送信番号で送る', sg.length === 1 && sg[0].targetWeight === '66' && sg[0].clientReqId === ss.draft.data.reqId, JSON.stringify(sg));
}
{
  //   退会・再入会の発効日（契約・会員）
  const { w, sent } = boot(baseResp(), { token: jwt(61 * 60) });
  w.KarteUI.open('C1', '会員', 'contract'); await settle();
  const di = [...R(w).querySelectorAll('input[type="date"]')].pop();
  di.value = '2026-10-31';
  btn(R(w), '退会を記録').click(); await settle();
  const ss = JSON.parse(w.sessionStorage.getItem('karte_draft_v1') || 'null');
  ok('S11-4 ★退会の記録：送らずに発効日を退避して読み直す', !sent.some((x) => x.action === 'k_recordMembership') && w.reloaded === 1 && ss.tab === 'contract' && ss.draft.kind === 'membership' && ss.draft.data.effectiveDate === '2026-10-31', JSON.stringify(ss));
  const e = await afterReload(stashOf(w));
  const d2 = [...R(e.w).querySelectorAll('input[type="date"]')].pop();
  ok('S11-5 ★読み直した後、契約・会員の発効日が戻る', d2 && d2.value === '2026-10-31', d2 && d2.value);
  //   顧客が違う退避は戻さない
  const st = stashOf(w); const bad = JSON.parse(st.ss.karte_draft_v1); bad.draft.cid = 'C2'; st.ss.karte_draft_v1 = JSON.stringify(bad);
  const e2 = await afterReload(st);
  const d3 = [...R(e2.w).querySelectorAll('input[type="date"]')].pop();
  ok('S11-6 ★退避の顧客が違えば戻さない（今日の日付のまま）', d3 && d3.value !== '2026-10-31');
}
{
  //   種目の登録（新しい名前・部位）の途中
  const { w, sent } = boot(baseResp(), { token: jwt(61 * 60) });
  w.KarteUI.open('C1', '会員', 'training'); await settle();
  btn(R(w), '＋ 今日の記録').click(); await settle();
  btn(R(w), '＋ 種目を足す').click();
  pill(R(w), 'スクワット').click();
  const q = R(w).querySelector('input[aria-label="種目を探す"]'); q.value = 'ケーブルクロス'; q.oninput(); await settle();
  R(w).querySelector('.k-exnew button[data-part="chest"]').click(); await settle();
  btn(R(w), '「ケーブルクロス」を胸で').click(); await settle();
  const ss = JSON.parse(w.sessionStorage.getItem('karte_draft_v1') || 'null');
  ok('S11-7 ★種目の登録：送らずに、検索の文字・部位・選んでいた種目・送信番号を退避（氏名なし）', !sent.some((x) => x.action === 'k_saveExercise') && w.reloaded === 1 && ss.draft.kind === 'training' && ss.draft.ex && ss.draft.ex.q === 'ケーブルクロス' && ss.draft.ex.newPart === 'chest' && ss.draft.ex.picked.includes('スクワット') && !!ss.draft.ex.reqId && ss.draft.ex.cid === 'C1' && ss.name === '', JSON.stringify(ss));
  const e = await afterReload(stashOf(w));
  const r2 = R(e.w);
  ok('S11-8 ★読み直した後、種目を選ぶ欄が開いたまま、名前・部位・選んでいた種目が戻る', r2.querySelector('input[aria-label="種目を探す"]').value === 'ケーブルクロス' && r2.querySelector('.k-exnew button[data-part="chest"]').getAttribute('aria-checked') === 'true' && r2.querySelector('.k-picker').style.display !== 'none', r2.textContent.slice(0, 300));
  btn(r2, '「ケーブルクロス」を胸で').click(); await settle();
  const sv = e.sent.filter((x) => x.action === 'k_saveExercise');
  ok('S11-9 同じ送信番号で登録できる', sv.length === 1 && sv[0].clientReqId === ss.draft.ex.reqId && sv[0].part === 'chest');
  ok('S11-9b 選んでいた種目（スクワット）も選んだまま', btn(r2, '選んだ 2 種目を足す') != null);
}
{
  //   部位を直すモードの途中
  const { w } = boot(baseResp(), { token: jwt(61 * 60) });
  w.KarteUI.open('C1', '会員', 'training'); await settle();
  btn(R(w), '＋ 今日の記録').click(); await settle();
  btn(R(w), '＋ 種目を足す').click();
  btn(R(w), '部位を直す').click(); await settle();
  [...R(w).querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === 'ベンチプレスの部位を直す').click(); await settle();
  R(w).querySelector('.k-exeditor button[data-part="arm"]').click(); await settle();
  btn(R(w).querySelector('.k-exeditor'), '保存する').click(); await settle();
  const e = await afterReload(stashOf(w));
  const ed = R(e.w).querySelector('.k-exeditor');
  ok('S11-10 ★部位を直す途中：読み直した後、同じ種目の部位を直す欄が選んだ部位のまま戻る', !!ed && ed.textContent.includes('「ベンチプレス」の部位') && ed.querySelector('button[data-part="arm"]').getAttribute('aria-checked') === 'true');
}
{
  //   中3：未来の時刻の印は無効（消して、取り直しを止めない）
  const { w, sent } = boot(trResp(), { token: jwt(61 * 60), ss: { karte_reauth: String(Date.now() + 20 * 60 * 1000) } });
  await openWithSet(w);
  btn(R(w), '保存する').click(); await settle();
  const mk = Number(w.sessionStorage.getItem('karte_reauth') || 0);
  ok('S12-1 ★未来の時刻の印は効かない（送らずに取り直し、印は今の時刻で付け直す）', !sent.some((x) => x.action === 'k_addTraining') && w.reloaded === 1 && mk <= Date.now() && mk > Date.now() - 5000, String(mk));
}

// ================= P. 種目を全員で共有し、部位を付ける =================
{
  const H = await import('../src/lib/karte-exercises.js');
  const { w } = boot(async () => ({ success: true }));
  const T = w.KarteUI._t;
  const m = /part IN \(([^)]*)\)/.exec(MIG);
  const sqlKeys = m ? m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')) : [];
  ok('P0-1 ★部位の鍵と表示名：画面（PART_KEYS）＝ Worker（EXERCISE_PARTS）＝ 表の CHECK', JSON.stringify(Array.from(T.PART_KEYS, (x) => [x[0], x[1]])) === JSON.stringify(H.EXERCISE_PARTS)
     && JSON.stringify(sqlKeys) === JSON.stringify(Array.from(T.PART_KEYS, (x) => x[0])), JSON.stringify(T.PART_KEYS));
  ok('P0-2 一覧に部位が無ければ名前から推定（従来どおり）', T.partOf('ショルダープレス') === '肩' && T.partOf('バトルロープ') === 'その他' && T.partKeyOf('スクワット') === 'legs');
}
{
  //   共有の一覧：別のトレーナー・別のお客様が登録した種目が、登録した部位の段に出る（部位なしは推定）
  let saveResp = { success: true, name: 'ケーブルクロス', part: 'chest' };
  const { w, sent } = boot(async (b) => {
    if (b.action === 'k_training') return { success: true, karteSchema: 32, sessions: TR_HIST, best: [] };
    if (b.action === 'k_exercises') return { success: true, karteSchema: 32, truncated: false, exercises: [{ name: 'バトルロープ', part: 'core' }, { name: 'ケトルベルスイング', part: null }, { name: 'レッグプレス', part: 'legs' }] };
    if (b.action === 'k_saveExercise') return typeof saveResp === 'function' ? saveResp(b) : saveResp;
    return { success: true };
  }, { token: jwt(30) });
  w.KarteUI.open('C1', '会員', 'training'); await settle();
  ok('P1-0 トレーニングのタブを開くと共有の一覧を読む', sent.some((x) => x.action === 'k_exercises'));
  btn(R(w), '＋ 今日の記録').click(); await settle();
  btn(R(w), '＋ 種目を足す').click();
  const groupOf = (name) => { const b = pill(R(w), name); const g = b && b.parentNode.previousElementSibling; return g ? g.textContent : ''; };
  ok('P1-1 ★共有の一覧の種目が出る・部位は一覧の部位（バトルロープ＝体幹）', groupOf('バトルロープ') === '体幹', groupOf('バトルロープ'));
  ok('P1-2 部位なしの種目は「その他」・固定の種目も出る・この方の最近の種目は上の段のまま', groupOf('ケトルベルスイング') === 'その他' && groupOf('ベンチプレス') === '胸' && groupOf('スクワット') === 'この方の最近の種目');
  //   新しい種目：名前を入れる → 部位を選ぶ → 登録して選ぶ
  const q = R(w).querySelector('input[aria-label="種目を探す"]');
  q.value = 'ケーブルクロス'; q.oninput(); await settle();
  const nw = R(w).querySelector('.k-exnew');
  ok('P2-1 新しい名前には部位を選ぶ段（固定の7つ）と、健康の言葉を書かない注記', !!nw && nw.querySelectorAll('button[data-part]').length === 7 && nw.textContent.includes('痛み・診断・服薬は「注意すること」へ') && nw.querySelector('button[data-part="other"]').getAttribute('aria-checked') === 'true');
  nw.querySelector('button[data-part="chest"]').click(); await settle();
  btn(R(w), '「ケーブルクロス」を胸で登録して選ぶ').click(); await settle();
  const sv = sent.filter((x) => x.action === 'k_saveExercise');
  ok('P2-2 ★k_saveExercise に名前と部位だけ・送信番号つき', sv.length === 1 && sv[0].name === 'ケーブルクロス' && sv[0].part === 'chest' && /^[A-Za-z0-9_-]{8,64}$/.test(sv[0].clientReqId) && Object.keys(sv[0]).sort().join(',') === 'action,clientReqId,idToken,name,part', JSON.stringify(sv[0]));
  btn(R(w), '選んだ 1 種目を足す').click(); await settle();
  const it = draftOf(w).items;
  ok('P2-3 登録した種目が今日の記録に入り、部位の印は「胸」', it.length === 1 && it[0].exercise === 'ケーブルクロス' && R(w).querySelector('.k-tag').textContent === '胸');
  //   部位を直す：「部位を直す」→ 種目を押す → 部位 → 保存（選ぶ操作とは別）
  btn(R(w), '＋ 種目を足す').click();
  btn(R(w), '部位を直す').click(); await settle();
  [...R(w).querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === 'スクワットの部位を直す').click(); await settle();
  const ed = R(w).querySelector('.k-exeditor');
  ok('P3-1 ★部位を直す画面：いまの部位（推定）と7つの部位・保存・やめる（ダイアログを出さない）', !!ed && ed.textContent.includes('いま：脚・尻（種目名からの推定）') && ed.querySelectorAll('button[data-part]').length === 7 && w.confirms === 0);
  saveResp = (b) => ({ success: true, name: b.name, part: b.part });
  ed.querySelector('button[data-part="back"]').click(); await settle();
  btn(R(w).querySelector('.k-exeditor'), '保存する').click(); await settle();
  const sv2 = sent.filter((x) => x.action === 'k_saveExercise').pop();
  ok('P3-2 部位の変更を送る', sv2.name === 'スクワット' && sv2.part === 'back');
  btn(R(w), '部位を直すのをやめる').click(); await settle();
  ok('P3-3 ★変えた部位が画面の部位に効く（スクワット＝背中）・部位を直している間は選べない', w.KarteUI._t.partOf('スクワット') === '背中' && !R(w).querySelector('.k-exeditor'));
  //   登録に失敗しても、今日の記録には足せる（記録を止めない）
  saveResp = { success: false, code: 'FORBIDDEN' };
  q.value = 'サンドバッグ'; q.oninput(); await settle();
  btn(R(w), '「サンドバッグ」を').click(); await settle();
  btn(R(w), '選んだ 1 種目を足す').click(); await settle();
  ok('P4-1 ★登録できなくても今日の記録には足す（理由を出す）', draftOf(w).items.some((x) => x.exercise === 'サンドバッグ') && w.alerts.some((a) => a.includes('部位を保存できませんでした') && a.includes('今日の記録用に選びました')), JSON.stringify(w.alerts));
  //   結果が分からない → 同じ名前・部位なら同じ送信番号
  saveResp = { success: false, code: 'BAD_RESPONSE' };
  btn(R(w), '＋ 種目を足す').click();
  q.value = 'メディシンボール'; q.oninput(); await settle();
  btn(R(w), '「メディシンボール」を').click(); await settle();
  ok('P4-2a 結果が分からなくても今日の記録用に選ぶ・「部位を直す」から送り直すよう案内', w.alerts.some((a) => a.includes('結果を確かめられませんでした') && a.includes('部位を直す')));
  btn(R(w), '部位を直す').click(); await settle();
  [...R(w).querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === 'メディシンボールの部位を直す').click(); await settle();
  btn(R(w).querySelector('.k-exeditor'), '保存する').click(); await settle();
  const mb = sent.filter((x) => x.action === 'k_saveExercise' && x.name === 'メディシンボール');
  ok('P4-2 ★結果が分からないときの送り直しは同じ送信番号（二重にならない）', mb.length === 2 && mb[0].clientReqId === mb[1].clientReqId);
  ok('P5-1 押すものは44px以上（部位を直す・休憩の切り替え）', /k-btn\.small\{[^}]*min-height:44px/.test(SRC) && /\.k-rtg\{min-height:44px/.test(SRC));
}
{
  //   古い Worker（k_exercises が無い＝403）でも記録の画面は今までどおり動く
  const { w } = boot(async (b) => {
    if (b.action === 'k_training') return { success: true, karteSchema: 32, sessions: TR_HIST, best: [] };
    if (b.action === 'k_exercises') return { success: false, code: 'FORBIDDEN' };
    return { success: true };
  });
  w.KarteUI.open('C1', '会員', 'training'); await settle();
  btn(R(w), '＋ 今日の記録').click(); await settle();
  btn(R(w), '＋ 種目を足す').click();
  ok('P6-1 共有の一覧が読めなくても、固定の種目と最近の種目で選べる', !!pill(R(w), 'ベンチプレス') && !!pill(R(w), 'スクワット'));
}

{
  //   中4・中6：最近の種目から選んだ名前が共有の一覧に無い → その場で部位を選んで登録できる（ダイアログなし・登録しなくても足せる）
  const { w, sent } = boot(baseResp((b) => (b.action === 'k_saveExercise' ? { success: true, name: b.name, part: b.part } : undefined)), { token: jwt(30) });
  w.KarteUI.open('C1', '会員', 'training'); await settle();
  btn(R(w), '＋ 今日の記録').click(); await settle();
  btn(R(w), '＋ 種目を足す').click();
  ok('P7-0 選ぶ前は登録の欄を出さない', !R(w).querySelector('.k-exunreg'));
  pill(R(w), 'スクワット').click(); await settle();
  ok('P7-1 固定の種目（スクワット）を選んでも登録の欄は出ない', !R(w).querySelector('.k-exunreg'));
  pill(R(w), 'ブルガリアンスクワット').click(); await settle();
  const card = R(w).querySelector('.k-exunreg');
  ok('P7-2 ★最近の種目で共有の一覧に無い名前を選ぶと、その下に部位（推定＝脚・尻）と登録のボタン・健康の言葉の注記', !!card && card.dataset.name === 'ブルガリアンスクワット' && card.querySelector('button[data-part="legs"]').getAttribute('aria-checked') === 'true' && card.textContent.includes('痛み・診断・服薬') && w.confirms === 0);
  card.querySelector('button[data-part="core"]').click(); await settle();
  btn(R(w).querySelector('.k-exunreg'), '体幹で登録する').click(); await settle();
  const sv = sent.filter((x) => x.action === 'k_saveExercise');
  ok('P7-3 ★登録すると名前と部位を送り、欄が消え、部位が効く・選んだまま', sv.length === 1 && sv[0].name === 'ブルガリアンスクワット' && sv[0].part === 'core' && !R(w).querySelector('.k-exunreg') && w.KarteUI._t.partOf('ブルガリアンスクワット') === '体幹' && pill(R(w), 'ブルガリアンスクワット').getAttribute('aria-pressed') === 'true');
}
{
  //   中5：一覧が上限で切れていたら、一部だけ表示している旨と「見つからなければ名前を入力」
  const { w } = boot(baseResp((b) => (b.action === 'k_exercises' ? { success: true, exercises: [{ name: 'バトルロープ', part: 'core' }], truncated: true } : undefined)));
  w.KarteUI.open('C1', '会員', 'training'); await settle();
  btn(R(w), '＋ 今日の記録').click(); await settle();
  btn(R(w), '＋ 種目を足す').click();
  const tr = R(w).querySelector('.k-extrunc');
  ok('P8-1 ★truncated なら「一部だけ表示・見つからなければ名前を入力」を出す', !!tr && tr.textContent.includes('一部だけ') && tr.textContent.includes('名前を入力'));
  const { w: w2 } = boot(baseResp());
  w2.KarteUI.open('C1', '会員', 'training'); await settle();
  btn(R(w2), '＋ 今日の記録').click(); await settle();
  btn(R(w2), '＋ 種目を足す').click();
  ok('P8-2 切れていなければ出さない', !R(w2).querySelector('.k-extrunc'));
}

// ================= B. 自重 =================
{
  const { w } = boot(async () => ({ success: true }));
  const T = w.KarteUI._t;
  ok('B1-1 ★重量が空の✓は 0（自重）で送る・回数が空のセットは送らない', JSON.stringify(T.buildPayload([{ exercise: 'ディップス', sets: [{ w: '', r: '12', done: true }, { w: '', r: '', done: true }, { w: '10', r: '', done: true }, { w: '', r: '8', done: false }] }]))
     === JSON.stringify([{ exercise: 'ディップス', sets: [{ weight: 0, reps: 12 }] }]));
  ok('B1-2 「記録されない入力」に重量の空は数えない（回数の空・✓なしは数える）', T.uncheckedCount([{ exercise: 'x', sets: [{ w: '', r: '12', done: true }, { w: '10', r: '', done: true }, { w: '', r: '8', done: false }] }]) === 2);
  ok('B1-3 0 は「自重」', T.wLabel(0) === '自重' && T.wLabel(40) === '40kg');
}
{
  //   入口から：前回が自重の種目を足す → 重量の欄は空（「自重なら空のまま」）→ ✓ → 保存で 0 を送る・確かめのダイアログを出さない
  const { w, sent } = boot(async (b) => {
    if (b.action === 'k_training') return { success: true, karteSchema: 32, sessions: BW_HIST, best: [] };
    if (b.action === 'k_exercises') return { success: true, exercises: [] };
    return { success: true, sessionId: 'N1', rev: 1 };
  });
  w.KarteUI.open('C1', '会員', 'training'); await settle();
  const t0 = R(w).textContent;
  ok('B2-1 ★見る側：前回・日別・自己ベストで 0 は「自重」', t0.includes('自重 × 12・10') && t0.includes('自重×8・5kg×6') && !t0.includes('0kg'), t0.slice(0, 400));
  btn(R(w), '＋ 今日の記録').click(); await settle();
  btn(R(w), '＋ 種目を足す').click();
  pill(R(w), 'ディップス').click();
  btn(R(w), '選んだ 1 種目を足す').click(); await settle();
  const win = R(w).querySelector('input[aria-label="1セット目の重量"]');
  ok('B2-2 ★記録の画面：前回が自重なら重量は空・placeholder「自重なら空のまま」・前回の表示は「自重」', win.value === '' && win.getAttribute('placeholder') === '自重なら空のまま' && R(w).textContent.includes('前回 11/1：自重 × 12・10'), win.value + ' / ' + R(w).textContent.slice(0, 300));
  R(w).querySelector('button[aria-label$="実施済みにする"]').click(); await settle();
  ok('B2-3 ★重量が空でも✓があれば赤枠（未実施）にしない', !R(w).querySelector('div[style*="#fff7f4"]'));
  btn(R(w), '保存する').click(); await settle();
  const tr = sent.filter((x) => x.action === 'k_addTraining');
  ok('B2-4 ★保存で weight 0 を送る・「記録されない入力」の確かめを出さない', tr.length === 1 && tr[0].items[0].sets[0].weight === 0 && tr[0].items[0].sets[0].reps === 12 && w.confirms === 0, JSON.stringify(tr[0] && tr[0].items));
}
{
  //   写す画面も「自重」
  const { w } = boot(async (b) => (b.action === 'k_training' ? { success: true, karteSchema: 32, sessions: BW_HIST, best: [] } : { success: true, exercises: [] }));
  w.KarteUI.open('C1', '会員', 'training'); await settle();
  btn(R(w), '＋ 今日の記録').click(); await settle();
  btn(R(w), '過去の記録から写す').click(); await settle();
  ok('B3-1 写す画面の中身も 0 は「自重」', R(w).textContent.includes('ディップス') && R(w).textContent.includes('自重 × 12・10'), R(w).textContent.slice(0, 300));
  btn(R(w), '重量・回数ごと写す').click(); await new Promise((r) => setTimeout(r, 40)); await settle();
  const d = draftOf(w);
  ok('B3-2 写すと自重のセットは重量が空・回数はそのまま（✓は外す）', d && d.items[0].sets.every((s) => s.w === '' && s.done === false) && d.items[0].sets[0].r === 12, JSON.stringify(d && d.items));
}

// ================= T. 休憩タイマーのオン/オフ =================
{
  const { w } = boot(trResp());
  w.KarteUI.open('C1', '会員', 'training'); await settle();
  btn(R(w), '＋ 今日の記録').click(); await settle();
  btn(R(w), '＋ 種目を足す').click();
  pill(R(w), 'スクワット').click();
  btn(R(w), '選んだ 1 種目を足す').click(); await settle();
  btn(R(w), '＋ セット').click(); await settle();
  const tg = () => R(w).querySelector('button.k-rtg');
  ok('T1-1 既定は「あり」（今までの動き）・秒数と終了音の行がある', tg() && tg().textContent === '休憩タイマー：あり' && tg().getAttribute('aria-pressed') === 'true' && !!R(w).querySelector('select[aria-label$="休憩の秒数"]'));
  R(w).querySelector('button[aria-label="1セット目を実施済みにする"]').click(); await settle();
  ok('T1-2 ありなら✓で数える', /休憩 \d:\d\d/.test(R(w).querySelector('.k-restbar').textContent));
  tg().click(); await settle();
  ok('T2-1 ★なしにした瞬間に帯を消す', !R(w).querySelector('.k-restbar') || R(w).querySelector('.k-restbar').children.length === 0, R(w).querySelector('.k-restbar') && R(w).querySelector('.k-restbar').textContent);
  tg().click(); await settle();   // すぐありに戻す＝止めていなければ数え続けた帯が戻ってしまう
  const rb0 = R(w).querySelector('.k-restbar');
  ok('T2-1b ★なしにした瞬間に動いているタイマーを止めている（すぐありに戻しても数えていない）', !rb0 || rb0.children.length === 0, rb0 && rb0.textContent);
  tg().click(); await settle();
  ok('T2-2 ★なしなら秒数・終了音の行を出さない・端末に覚える', !R(w).querySelector('select[aria-label$="休憩の秒数"]') && !R(w).textContent.includes('終了音') && w.localStorage.getItem('karte_rest_on') === 'off' && tg().textContent === '休憩タイマー：なし');
  R(w).querySelector('button[aria-label="2セット目を実施済みにする"]').click(); await settle();
  const rb = R(w).querySelector('.k-restbar');
  ok('T2-3 ★なしなら✓で数えない（帯が出ない）・✓そのものは付く', (!rb || (rb.children.length === 0 && w.getComputedStyle(rb).display === 'none')) && R(w).querySelector('button[aria-label="2セット目を実施済みにする"]').getAttribute('aria-pressed') === 'true');
  tg().click(); await new Promise((r) => setTimeout(r, 20)); await settle();   // ありに戻す＝なしの間に✓で数え始めていれば、ここで帯に出てしまう
  const rb2 = R(w).querySelector('.k-restbar');
  ok('T2-3b ★なしの間の✓では内部でも数え始めていない（ありに戻しても帯は空）', !rb2 || rb2.children.length === 0, rb2 && rb2.textContent);
  tg().click(); await settle();
  //   開き直しても「なし」のまま
  w.KarteUI.open('C1', '会員', 'training'); await settle();
  ok('T2-4 開き直しても「なし」のまま', R(w).querySelector('button.k-rtg').textContent === '休憩タイマー：なし' && !R(w).querySelector('select[aria-label$="休憩の秒数"]'));
  R(w).querySelector('button.k-rtg').click(); await settle();
  ok('T3-1 ありに戻すと行が戻る', !!R(w).querySelector('select[aria-label$="休憩の秒数"]') && w.localStorage.getItem('karte_rest_on') === 'on');
}

console.log(`\n${fail ? '❌' : '✅'} カルテ：取り直し・共有の種目・自重・休憩の切り替え 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
