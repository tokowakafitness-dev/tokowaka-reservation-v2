// 設計38 メモから取り込む・補助/無理やり/ドロップ/実施：本番の liff/karte.js を jsdom で動かして入口から通す（§12-3 M1〜M23）
//   実行: node worker/test/liff-karte-import.test.js
//
//   ★部品ではなく入口から：カルテを開く → 今日の記録 → メモから取り込む → 貼る → 読み取る → ✓ → 保存、をボタンの click で通す。
//     身代わりは fetch（Worker）・LINE の SDK・読み直しだけ。Worker の応答は worker/src の本物の形（sessions[].exercises・sets[].ord/assist_reps/forced/drops）
//   ★名前・メモは架空の値だけ（実在の会員の名前・会話を書かない）

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
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), 'got : ' + JSON.stringify(got) + '\n   want: ' + JSON.stringify(want)); }
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 12; i++) await tick(); }
async function nav() { await new Promise((r) => setTimeout(r, 40)); await settle(); }   // history.back → popstate → 読み直し

const b64u = (s) => Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (ageS) => b64u(JSON.stringify({ alg: 'ES256' })) + '.' + b64u(JSON.stringify({ iss: 'https://access.line.me', sub: 'U_TEST', iat: Math.floor(Date.now() / 1000) - ageS, exp: Math.floor(Date.now() / 1000) + 3600 })) + '.sig';

//   設計38 §1 の例のメモ（架空の記録）
const P1 = '9/18\n\n腸腰筋ストレッチ\nアーチスクワット\nフロアアブ\n0×10 10×10+0×10 10×10+0×10\nヒップリフト\n30×10 50×10+5  80×5(できない)60×10+5 60×10+5\nラットプルダウン\n10×10 15×10 20×10\nドンキーキック\n60×10 80×10\nルーマニアン片足\n9×10 14×10';
const SHARED = ['腸腰筋ストレッチ', 'アーチスクワット', 'フロアアブ', 'ヒップリフト', 'ドンキーキック', 'ルーマニアン片足'].map((n) => ({ name: n, part: 'legs' }));
const S_OLD = { session_id: 'SO', session_date: '2026-10-20', created_at: 100, author_trainer_id: 'T1', rev: 1, sets: [
  { exercise: 'スクワット', set_no: 1, weight_kg: 80, reps: 5, e1rm: 93.3, note: null }] };
//   新しい回（Worker の k_training の形）：同じ名前の2つの種目・無理やり・補助・ドロップ
const S_NEW = { session_id: 'SN', session_date: '2026-11-03', created_at: 300, author_trainer_id: 'T1', rev: 1,
  exercises: [{ ord: 1, exercise: 'スクワット', doneOnly: false }, { ord: 2, exercise: 'ベンチプレス', doneOnly: false }, { ord: 3, exercise: 'スクワット', doneOnly: false }, { ord: 4, exercise: 'プランク', doneOnly: true }],
  sets: [
    { exercise: 'スクワット', set_no: 1, weight_kg: 60, reps: 10, e1rm: 80, note: null, ord: 1, assist_reps: null, forced: false, drops: [] },
    { exercise: 'スクワット', set_no: 2, weight_kg: 100, reps: 3, e1rm: 110, note: null, ord: 1, assist_reps: null, forced: true, drops: [] },
    { exercise: 'ベンチプレス', set_no: 1, weight_kg: 40, reps: 10, e1rm: 53.3, note: null, ord: 2, assist_reps: 2, forced: false, drops: [] },
    { exercise: 'スクワット', set_no: 1, weight_kg: 50, reps: 8, e1rm: 63.3, note: null, ord: 3, assist_reps: null, forced: false, drops: [{ weight_kg: 30, reps: 10, assist_reps: null, forced: false }] }] };

function boot(o = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'https://reservation.tokowaka-gym.com/liff/', pretendToBeVisual: true });
  const w = dom.window;
  const sent = [];
  for (const [k, v] of Object.entries(o.ls || {})) w.localStorage.setItem(k, v);
  for (const [k, v] of Object.entries(o.ss || {})) w.sessionStorage.setItem(k, v);
  w.idToken = o.token || jwt(30);
  w.EDGE_URL = 'https://edge.example';
  w.state = { trainerId: 'T1', _isOwner: false, _allTrainers: [{ id: 'T1', name: '一郎' }] };
  w.alerts = []; w.alert = (m) => w.alerts.push(String(m));
  w.confirms = 0; w.confirm = () => { w.confirms++; return true; };
  w.reloaded = 0; w.__karteReload = () => { w.reloaded++; };
  w.logs = [];
  ['log', 'info', 'warn', 'error', 'debug'].forEach((k) => { w.console[k] = (...a) => w.logs.push(a.map(String).join(' ')); });
  w.liff = { getIDToken: () => w.idToken, logout: () => {} };
  w.cfg = Object.assign({ schema: 33, sessions: [S_OLD], shared: SHARED, add: null }, o.cfg || {});
  w.fetch = async (url, opt) => {
    const body = JSON.parse(opt.body);
    sent.push(body);
    const c = w.cfg;
    let r;
    if (body.action === 'k_training') r = { success: true, karteSchema: c.schema, sessions: c.sessions, best: [] };
    else if (body.action === 'k_exercises') r = { success: true, karteSchema: c.schema, exercises: c.shared, truncated: false };
    else if (body.action === 'k_saveExercise') r = { success: true, name: body.name, part: body.part };
    else if (body.action === 'k_addTraining') r = c.add ? c.add(body) : { success: true, sessionId: 'N1', rev: 1 };
    else r = { success: true };
    return { json: async () => JSON.parse(JSON.stringify(r)) };
  };
  w.eval(SRC);
  return { w, sent };
}
const R = (w) => w.document.getElementById('karteRoot');
const btn = (root, t) => [...root.querySelectorAll('button')].find((x) => x.textContent.indexOf(t) === 0);
const btns = (root, t) => [...root.querySelectorAll('button')].filter((x) => x.textContent.indexOf(t) === 0);
const pill = (root, t) => [...root.querySelectorAll('button.k-pill')].find((x) => x.textContent === t);
const DKEY = 'karte_tr_draft_v1:T1:C1';
const draftOf = (w) => JSON.parse(w.localStorage.getItem(DKEY) || 'null');
const storeText = (s) => { let o = ''; for (let i = 0; i < s.length; i++) o += s.key(i) + '=' + s.getItem(s.key(i)) + '\n'; return o; };
const adds = (sent) => sent.filter((x) => x.action === 'k_addTraining');
const draftLS = (items, extra) => ({ [DKEY]: JSON.stringify(Object.assign({ v: 1, tid: 'T1', cid: 'C1', sessionDate: '2026-11-05', items, reqId: 'kfixedreq0001', pending: null, at: Date.now() }, extra || {})) });

async function openForm(w) {
  w.KarteUI.open('C1', '会員', 'training'); await settle();
  const b = btn(R(w), '＋ 今日の記録') || btn(R(w), '記録の入力（途中）を開く');
  if (b && !R(w).classList.contains('k-entry')) { b.click(); await settle(); }
}
async function openImport(w) {
  await openForm(w);
  btn(R(w), 'メモから取り込む').click(); await settle();
}
function paste(w, text) { const ta = R(w).querySelector('textarea[aria-label="メモを貼る"]'); ta.value = text; ta.dispatchEvent(new w.Event('input', { bubbles: true })); return ta; }
const card = (w, kind, i = 0) => [...R(w).querySelectorAll('.k-impcard')].filter((c) => c.dataset.kind === kind)[i];

// ================= M1（I63）例のメモを入口から通す・原文がどこにも残らない・操作数 =================
{
  const { w, sent } = boot();
  let ops = 0;
  await openForm(w);
  btn(R(w), 'メモから取り込む').click(); ops++; await settle();
  ok('M1-0 取り込みの画面（専用の画面・履歴は trimport）', R(w).querySelector('.k-entrytitle').textContent === 'メモから取り込む' && w.history.state.sub === 'trimport');
  paste(w, P1); ops++;
  btn(R(w), '読み取る').click(); ops++; await nav();
  ok('M1-1 決定待ちが無ければそのまま記録の画面へ戻る・7種目', R(w).querySelector('.k-entrytitle').textContent === '今日の記録を入れる' && draftOf(w).items.length === 7, R(w).textContent.slice(0, 200));
  {
    //   取り込んだ直後（保存して下書きが消える前）の保存領域にも原文が無い
    const st0 = storeText(w.localStorage) + storeText(w.sessionStorage);
    ok('M1-1b ★取り込んだ直後の下書き・退避に原文（行・全体）が無い（I63）', ['30×10 50×10+5', '0×10 10×10+0×10', '80×5(できない)', 'ルーマニアン片足\n9×10'].every((x) => !st0.includes(x)) && /karte_tr_draft_v1/.test(st0));
  }
  ok('M1-2 上に「メモから 7種目・15セット…✓を付けて保存」の1行・日付はメモの日付', R(w).textContent.includes('メモから 7種目・15セット（ドロップ2）を入れました') && R(w).textContent.includes('✓の無いセットは保存されません') && draftOf(w).sessionDate === '2026-09-18');
  //   全部✓（5種目）・実施した（2種目）を畳んだ行から押す
  for (let i = 0; i < 5; i++) { const b = R(w).querySelector('button.k-allchk'); if (!b) break; b.click(); ops++; await settle(); }
  for (let i = 0; i < 2; i++) { const b = R(w).querySelector('button.k-donechk[aria-pressed="false"]'); if (!b) break; b.click(); ops++; await settle(); }
  ok('M1-3 全部✓・実施したを押し切った（残りなし）', !R(w).querySelector('button.k-allchk') && !R(w).querySelector('button.k-donechk[aria-pressed="false"]'));
  btn(R(w), '保存する').click(); ops++; await settle();
  const tr = adds(sent);
  ok('M1-4 ★§5-5 の例：11操作・確かめのダイアログなし', ops === 11 && w.confirms === 0, `ops=${ops} confirms=${w.confirms}`);
  eq('M1-5 ★送られた本文が §3-3 の形で P1 の構造（印の無い鍵は送らない）', tr.length === 1 ? { d: tr[0].sessionDate, items: tr[0].items } : null, { d: '2026-09-18', items: [
    { exercise: '腸腰筋ストレッチ', sets: [], doneOnly: true }, { exercise: 'アーチスクワット', sets: [], doneOnly: true },
    { exercise: 'フロアアブ', sets: [{ weight: 0, reps: 10 }, { weight: 10, reps: 10, drops: [{ weight: 0, reps: 10 }] }, { weight: 10, reps: 10, drops: [{ weight: 0, reps: 10 }] }] },
    { exercise: 'ヒップリフト', sets: [{ weight: 30, reps: 10 }, { weight: 50, reps: 10, assist: 5 }, { weight: 80, reps: 5, forced: true }, { weight: 60, reps: 10, assist: 5 }, { weight: 60, reps: 10, assist: 5 }] },
    { exercise: 'ラットプルダウン', sets: [{ weight: 10, reps: 10 }, { weight: 15, reps: 10 }, { weight: 20, reps: 10 }] },
    { exercise: 'ドンキーキック', sets: [{ weight: 60, reps: 10 }, { weight: 80, reps: 10 }] },
    { exercise: 'ルーマニアン片足', sets: [{ weight: 9, reps: 10 }, { weight: 14, reps: 10 }] }] });
  const raw = ['30×10 50×10+5', '0×10 10×10+0×10', '80×5(できない)', P1];
  const sentText = JSON.stringify(sent), lsT = storeText(w.localStorage), ssT = storeText(w.sessionStorage), logT = w.logs.join('\n');
  ok('M1-6 ★原文（行・全体）が送信・localStorage・sessionStorage・console のどこにも無い（I63）', raw.every((x) => !sentText.includes(x) && !lsT.includes(x) && !ssT.includes(x) && !logT.includes(x)));
  ok('M1-7 取り込みの画面からは何も送っていない（読む k_training・k_exercises と保存の1回だけ）', sent.every((x) => ['k_training', 'k_exercises', 'k_addTraining'].includes(x.action)));
}
{
  //   M1b 読み取った直後（記録の画面へ戻る前）も、下書きに原文が無い
  const { w } = boot();
  await openImport(w);
  paste(w, 'ヒップリフト\n30×10 50×10+5\n架空の謎の行だけ');
  btn(R(w), '読み取る').click(); await settle();
  const lsT = storeText(w.localStorage) + storeText(w.sessionStorage);
  ok('M1b ★決定待ちを出している間も、原文・決定待ちの文字は保存領域に無い', !lsT.includes('架空の謎の行だけ') && !lsT.includes('30×10 50×10+5') && w.logs.length === 0);
}

// ================= M2（I64）決定待ち：カード・押せない・1つずつ選ぶ・選んだ先にだけ入る =================
{
  const { w, sent } = boot();
  await openImport(w);
  paste(w, '50×10\nヒップリフト\n30×10 80×5(片足)\n45度レッグプレス\n50×10');
  btn(R(w), '読み取る').click(); await settle();
  const go = () => btn(R(w), '記録の画面に入れる');
  ok('M2-1 カードが3枚（種目の無い数値・括弧書き・名前）・「記録の画面に入れる」は押せない・ダイアログなし', R(w).querySelectorAll('.k-impcard').length === 3 && go() && go().disabled === true && w.confirms === 0 && w.alerts.length === 0);
  ok('M2-2 読めた分の要約（日付の行なし・1種目）', R(w).querySelector('.k-impsum').textContent.includes('1種目') && R(w).querySelector('.k-impsum').textContent.includes('確かめが必要 3件'));
  btn(card(w, 'no_exercise'), '社内メモに足す').click(); await settle();
  ok('M2-3 1つ選んでもまだ押せない', go().disabled === true);
  btn(card(w, 'paren'), '括弧を除いてセットにする').click(); await settle();
  btn(card(w, 'name'), '種目にする').click(); await settle();
  ok('M2-4 「種目にする」で部位の欄が開く（まだ決まっていない）', card(w, 'name').querySelectorAll('button[data-part]').length === 7 && go().disabled === true);
  card(w, 'name').querySelector('button[data-part="legs"]').click(); await settle();
  ok('M2-5 全部選ぶと押せる', go().disabled === false);
  go().click(); await nav();
  const d = draftOf(w);
  eq('M2-6 ★選んだ先にだけ入る：種目の並びはメモの行の順・括弧を除いたセット・名前の下の数値・社内メモ', d && { items: d.items.map((x) => [x.exercise, x.sets.map((s) => [s.w, s.r, s.note || '']), x.regPart || '']), memo: d.memo },
    { items: [['ヒップリフト', [['30', '10', ''], ['80', '5', '']], ''], ['45度レッグプレス', [['50', '10', '']], 'legs']], memo: '50×10' });
  ok('M2-7 取り込みの画面からは何も送らない', !sent.some((x) => !['k_training', 'k_exercises'].includes(x.action)));
}

// ================= M3 2つ目の日付：1日分だけ・案内・貼った欄は残る =================
{
  const { w } = boot();
  await openImport(w);
  const ta = paste(w, '9/18\nスクワット\n50×10\n9/20\nベンチプレス\n40×10');
  btn(R(w), '読み取る').click(); await settle();
  const c = card(w, 'second_date');
  ok('M3-1 2つ目の日付から後ろは1枚のカード・「1日分だけ」「保存した後にもう一度」・選べるのは捨てるだけ', !!c && c.textContent.includes('1回の記録に1日分だけ') && c.textContent.includes('保存した後にもう一度') && !btn(c, '社内メモに足す') && !!btn(c, '捨てる'));
  ok('M3-2 貼った欄の文字は消さない', ta.value.includes('9/20'));
  btn(c, '捨てる').click(); await settle();
  btn(R(w), '記録の画面に入れる').click(); await nav();
  const d = draftOf(w);
  ok('M3-3 9/18 の1種目だけ入る', d.sessionDate === '2026-09-18' && d.items.length === 1 && d.items[0].exercise === 'スクワット', JSON.stringify(d.items));
}

// ================= M4 下書きと日付が違う→入れない／日付の行が無い→2択→後ろに足す =================
{
  const { w } = boot({ ls: draftLS([{ exercise: 'ベンチプレス', sets: [{ w: '40', r: '10', done: false }] }], { sessionDate: '2026-11-01' }) });
  await openImport(w);
  paste(w, '9/18\nスクワット\n50×10');
  btn(R(w), '読み取る').click(); await settle();
  ok('M4-1 ★日付が違えば入れない（入力中の記録は 11/1）', R(w).textContent.includes('入力中の記録は 11/1 です') && draftOf(w).items.length === 1 && draftOf(w).sessionDate === '2026-11-01');
  paste(w, 'スクワット\n60×8');
  btn(R(w), '読み取る').click(); await settle();
  ok('M4-2 日付の行が無い→画面の中で2択（後ろに足す／やめる）・ダイアログなし', !!btn(R(w), 'いまの入力の後ろに足す') && !!btn(R(w), 'やめる') && w.confirms === 0 && draftOf(w).items.length === 1);
  btn(R(w), 'いまの入力の後ろに足す').click(); await nav();
  const d = draftOf(w);
  ok('M4-3 後ろに足す（置き換えない・日付はそのまま）', d.items.length === 2 && d.items[0].exercise === 'ベンチプレス' && d.items[1].exercise === 'スクワット' && d.sessionDate === '2026-11-01', JSON.stringify(d));
}

// ================= M5（I57）取り込んだ✓は全部 false・そのまま保存→送られない =================
{
  const { w, sent } = boot();
  await openImport(w);
  paste(w, P1);
  btn(R(w), '読み取る').click(); await nav();
  const d = draftOf(w);
  ok('M5-1 ★取り込んだセットの✓は全部 false・数字の無い種目の「実施した」も false・「メモから」の印', d.items.every((it) => it.sets.every((s) => s.done === false) && it.doneOnly !== true && it.fromMemo === true) && R(w).querySelectorAll('.k-frommemo').length === 7);
  btn(R(w), '保存する').click(); await settle();
  ok('M5-2 ★そのまま保存しても送らない', adds(sent).length === 0 && w.alerts.some((a) => a.includes('✓を付けるか')), JSON.stringify(w.alerts));
}

// ================= M6 ドロップは本セットの✓に従う・数字の無い種目は「実施した」が無いと送られない =================
{
  const { w, sent } = boot();
  await openImport(w);
  paste(w, 'フロアアブ\n10×10+0×10 20×10+5×10\n腸腰筋ストレッチ');
  btn(R(w), '読み取る').click(); await nav();
  ok('M6-a 取り込んだ最初の種目が開いている', !R(w).querySelector('button.k-excol[aria-label="フロアアブを開く"]') && !!R(w).querySelector('button.k-excol[aria-label="腸腰筋ストレッチを開く"]'));
  R(w).querySelector('button[aria-label="1セット目を実施済みにする"]').click(); await settle();
  ok('M6-0 印はセットの行の真下（✎ を閉じていても見える）', [...R(w).querySelectorAll('.k-marks')].map((x) => x.textContent).join('|') === '→ 自重×10|→ 5kg×10');
  btn(R(w), '保存する').click(); await settle();
  const tr = adds(sent);
  eq('M6-1 ★✓の本セットのドロップだけ送る・✓の無い本セットのドロップは送らない・「実施した」の無い数字の無い種目は送らない', tr.length === 1 && tr[0].items, [{ exercise: 'フロアアブ', sets: [{ weight: 10, reps: 10, drops: [{ weight: 0, reps: 10 }] }] }]);
}

// ================= M7 pending の間は取り込めない =================
{
  const pend = { payload: { customerId: 'C1', sessionDate: '2026-11-05', items: [{ exercise: 'スクワット', sets: [{ weight: 40, reps: 10 }] }] }, reqId: 'kpend0001' };
  const { w } = boot({ ls: draftLS([], { pending: pend }) });
  await openForm(w);
  ok('M7-1 ★送った結果待ち（pending）の画面に「メモから取り込む」は出ない', R(w).textContent.includes('前回の保存の結果を確かめられませんでした') && !btn(R(w), 'メモから取り込む'));
  w.KarteUI.open('C1', '会員', 'training', { kind: 'sub', sub: 'trimport' }); await settle();
  ok('M7-2 取り込みの画面を直接開いても取り込めない（案内だけ）', R(w).textContent.includes('前回の保存の結果を確かめるまで取り込めません') && !R(w).querySelector('textarea[aria-label="メモを貼る"]'));
}

// ================= M8 「種目にする」で部位→記録の画面の登録の欄に初期値・取り込みの画面からは送らない =================
{
  const { w, sent } = boot();
  await openImport(w);
  paste(w, 'ゴブレットスクワット\n20×10');
  btn(R(w), '読み取る').click(); await settle();
  btn(card(w, 'name'), '種目にする').click(); await settle();
  card(w, 'name').querySelector('button[data-part="legs"]').click(); await settle();
  btn(R(w), '記録の画面に入れる').click(); await nav();
  const reg = R(w).querySelector('.k-exunreg[data-name="ゴブレットスクワット"]');
  ok('M8-1 ★記録の画面の種目カードに「共有の一覧にありません」・選んだ部位（脚・尻）が初期値', !!reg && reg.querySelector('button[data-part="legs"]').getAttribute('aria-checked') === 'true' && reg.textContent.includes('痛み・診断・服薬'));
  ok('M8-2 ★取り込みの画面からは k_saveExercise を送っていない', !sent.some((x) => x.action === 'k_saveExercise'));
  btn(reg, '脚・尻で登録する').click(); await settle();
  const sv = sent.filter((x) => x.action === 'k_saveExercise');
  ok('M8-3 登録するかは記録の画面でトレーナーが選ぶ（押せば名前と部位を送る・欄が消える）', sv.length === 1 && sv[0].name === 'ゴブレットスクワット' && sv[0].part === 'legs' && !R(w).querySelector('.k-exunreg'));
}

// ================= M9 手入力：✎ → 補助・無理やり・ドロップ → 印 → 送られる鍵 =================
{
  const { w, sent } = boot();
  await openForm(w);
  btn(R(w), '＋ 種目を足す').click();
  pill(R(w), 'スクワット').click();
  btn(R(w), '選んだ 1 種目を足す').click(); await settle();
  R(w).querySelector('button[aria-label="1セット目のメモ"]').click(); await settle();
  const chips = [...R(w).querySelectorAll('.k-memochips button')].map((x) => x.textContent);
  ok('M9-0 よく使うメモから「補助あり」「フォーム崩れ」を外す（33 のとき）', !chips.includes('補助あり') && !chips.includes('フォーム崩れ') && chips.includes('余裕あり'), chips.join(','));
  const ai = R(w).querySelector('input[aria-label="1セット目の補助の回数"]'); ai.value = '3'; ai.oninput(); ai.onchange(); await settle();
  R(w).querySelector('button[aria-label="1セット目を無理やりにする"]').click(); await settle();
  btn(R(w), 'ドロップを足す').click(); await settle();
  const dw = R(w).querySelector('input[aria-label="1セット目のドロップ1段目の重量"]'); dw.value = '20'; dw.oninput(); dw.onchange(); await settle();
  const dr = R(w).querySelector('input[aria-label="1セット目のドロップ1段目の回数"]'); dr.value = '8'; dr.oninput(); dr.onchange(); await settle();
  ok('M9-1 印：＋補助3　→ 20kg×8　無理（ダイアログなし）', R(w).querySelector('.k-marks').textContent === '＋補助3　→ 20kg×8　無理' && w.confirms === 0, R(w).querySelector('.k-marks') && R(w).querySelector('.k-marks').textContent);
  ok('M9-2 無理やりは切り替え（aria-pressed）', R(w).querySelector('button[aria-label="1セット目を無理やりにする"]').getAttribute('aria-pressed') === 'true');
  R(w).querySelector('button[aria-label="1セット目を実施済みにする"]').click(); await settle();
  btn(R(w), '保存する').click(); await settle();
  const tr = adds(sent);
  eq('M9-3 ★送られる鍵：assist・forced・drops（印の無い鍵は送らない）', tr.length === 1 && tr[0].items, [{ exercise: 'スクワット', sets: [{ weight: 80, reps: 5, assist: 3, forced: true, drops: [{ weight: 20, reps: 8 }] }] }]);
}

// ================= M10〜M12（I66）自己ベスト・前回の印と ord ごと・1セット目 =================
{
  const { w } = boot({ cfg: { sessions: [S_OLD, S_NEW] } });
  w.KarteUI.open('C1', '会員', 'training'); await settle();
  const t0 = R(w).textContent;
  ok('M10-1 ★自己ベストに無理やり（100kg×3）を入れない（種目名ごと・全 ord）', t0.includes('自己ベスト 80kg × 5（10/20）') && !t0.includes('自己ベスト 100kg'), t0.slice(0, 500));
  ok('M10-2 ★前回のカード：新しい回は ord ごと（スクワットが2行）・数字の無い種目は「実施のみ」・印は1セットずつ', t0.includes('前回（11/3）') && t0.includes('4種目・4セット') && t0.includes('60kg×10・100kg×3（無理）') && t0.includes('40kg×10+補助2') && t0.includes('50kg×8→30kg×10') && t0.includes('実施のみ'));
  const T = w.KarteUI._t;
  const st = T.exerciseStats([S_OLD, S_NEW], 'スクワット');
  ok('M10-3 exerciseStats：無理やりを除く（セット数・推定の最大）', st.sets === 3 && st.maxE === 93.3 && st.best.w === 80, JSON.stringify(st));
  ok('M10-4 古い回は今までどおり（名前でまとめる・まとめ書き）', T.setLineOf(S_OLD.sets) === '80kg × 5' && T.exOrder(S_OLD).groups.length === 1);
  btn(R(w), '＋ 今日の記録').click(); await settle();
  btn(R(w), '＋ 種目を足す').click();
  pill(R(w), 'スクワット').click();
  btn(R(w), '選んだ 1 種目を足す').click(); await settle();
  ok('M11-1 ★前回の値：同じ名前の ord を「 ／ 」でつなぐ・無理やりも印つき', R(w).textContent.includes('前回 11/3：60kg×10・100kg×3（無理） ／ 50kg×8→30kg×10'), R(w).textContent.slice(0, 400));
  const wIn = R(w).querySelector('input[aria-label="1セット目の重量"]'), rIn = R(w).querySelector('input[aria-label="1セット目の回数"]');
  ok('M12-1 ★1セット目は前回の全 ord の本セットのうち無理やりでない最大（60×10・100×3 ではない）', wIn.value === '60' && rIn.value === '10', wIn.value + '×' + rIn.value);
}

// ================= M13〜M19（I68）karteSchema 32 のとき新しい鍵を送らない（send の入口1か所） =================
const S32 = { schema: 32 };
{
  const { w } = boot({ cfg: S32 });
  await openForm(w);
  ok('M13 ★32 なら「メモから取り込む」を出さない・補助などの欄も出さない', !btn(R(w), 'メモから取り込む') && !R(w).textContent.includes('メモ・補助'));
}
{
  const { w, sent } = boot({ cfg: S32, ls: draftLS([{ exercise: 'スクワット', sets: [{ w: '40', r: '10', done: true, assist: '3' }] }]) });
  await openForm(w);
  ok('M14-0 32 でも印が入っていれば見える・外せる（✎ の欄に補助）', R(w).querySelector('.k-marks').textContent === '＋補助3');
  btn(R(w), '保存する').click(); await settle();
  ok('M14 ★補助つきの通常の保存は送らない・下書きに残る', adds(sent).length === 0 && w.alerts.some((a) => a.includes('いまは使えません')) && draftOf(w).items[0].sets[0].assist === '3' && !draftOf(w).pending);
}
{
  const { w, sent } = boot({ cfg: S32, ls: draftLS([{ exercise: 'スクワット', sets: [{ w: '40', r: '10', done: true }] }]) });
  await openForm(w);
  btn(R(w), '保存する').click(); await settle();
  ok('M15 ★補助なしの保存は 32 で送る（全体を止めない）', adds(sent).length === 1 && JSON.stringify(adds(sent)[0].items) === JSON.stringify([{ exercise: 'スクワット', sets: [{ weight: 40, reps: 10 }] }]));
}
const pendOf = (items) => ({ pending: { payload: { customerId: 'C1', sessionDate: '2026-11-05', items }, reqId: 'kpend0002' } });
{
  const items = [{ exercise: 'スクワット', sets: [{ weight: 40, reps: 10, assist: 3 }] }];
  const { w, sent } = boot({ cfg: S32, ls: draftLS([], pendOf(items)) });
  await openForm(w);
  btn(R(w), '同じ内容で送り直す').click(); await settle();
  ok('M16-1 ★pending の固定 payload（新しい鍵つき）の送り直しは 32 で送らない（固定した中身を毎回判定）', adds(sent).length === 0 && w.alerts.some((a) => a.includes('いまは使えません')) && !!draftOf(w).pending);
  const e = boot({ ls: draftLS([], pendOf(items)) });
  await openForm(e.w);
  btn(R(e.w), '同じ内容で送り直す').click(); await settle();
  ok('M16-2 33 なら同じ送信番号で送り直せる（経路は send を通っている）', adds(e.sent).length === 1 && adds(e.sent)[0].clientReqId === 'kpend0002');
}
{
  //   M17：下書きの復元（読み直しの後に戻す）後の保存
  const ls = draftLS([{ exercise: 'スクワット', sets: [{ w: '40', r: '10', done: true, forced: true }] }]);
  const ss = { karte_draft_v1: JSON.stringify({ customerId: 'C1', name: '', tab: 'training', draft: { kind: 'training' }, at: Date.now() }), karte_reauth: String(Date.now()) };
  const { w, sent } = boot({ cfg: S32, ls, ss });
  await new Promise((r) => setTimeout(r, 30)); await settle();
  btn(R(w), '保存する').click(); await settle();
  ok('M17-1 ★読み直して戻した後の保存も 32 では送らない', adds(sent).length === 0 && w.alerts.some((a) => a.includes('いまは使えません')) && draftOf(w).items[0].sets[0].forced === true);
  //   取り込みの画面はトークンが古くても取り直しを起こさない（何も送らない＝原文が退避に乗らない）
  const e = boot({ token: jwt(61 * 60) });
  await openImport(e.w);
  paste(e.w, 'ヒップリフト\n30×10\n架空の謎の行');
  btn(R(e.w), '読み取る').click(); await settle();
  btn(card(e.w, 'name'), '捨てる').click(); await settle();
  btn(R(e.w), '記録の画面に入れる').click(); await nav();
  ok('M17-2 ★取り込みの画面ではトークンの取り直しが起きない・退避（sessionStorage）に何も乗らない', e.w.reloaded === 0 && !e.w.sessionStorage.getItem('karte_draft_v1') && !e.sent.some((x) => !['k_training', 'k_exercises'].includes(x.action)));
}
{
  const { w, sent } = boot({ cfg: S32, ls: draftLS([{ exercise: 'プランク', sets: [], doneOnly: true }]) });
  await openForm(w);
  btn(R(w), '保存する').click(); await settle();
  const e = boot({ cfg: S32, ls: draftLS([{ exercise: 'スクワット', sets: [{ w: '40', r: '10', done: true, drops: [{ w: '20', r: '8' }] }] }]) });
  await openForm(e.w);
  btn(R(e.w), '保存する').click(); await settle();
  ok('M18 ★doneOnly だけ・drops だけの payload も 32 では送らない', adds(sent).length === 0 && adds(e.sent).length === 0 && w.alerts.some((a) => a.includes('いまは使えません')) && e.w.alerts.some((a) => a.includes('いまは使えません')));
}
{
  const items = [{ exercise: 'スクワット', sets: [{ weight: 40, reps: 10, drops: [{ weight: 20, reps: 8, assist: 2 }] }] }];
  const { w, sent } = boot({ cfg: S32, ls: draftLS([], pendOf(items)) });
  await openForm(w);
  btn(R(w), '同じ内容で送り直す').click(); await settle();
  const T = w.KarteUI._t;
  ok('M19 ★ドロップの中の assist／forced だけの payload も 32 では送らない・判定は鍵があるか（値ではない）', adds(sent).length === 0
     && T.usesExt({ items: [{ exercise: 'a', sets: [{ weight: 1, reps: 1, drops: [{ weight: 1, reps: 1, forced: true }] }] }] })
     && T.usesExt({ items: [{ exercise: 'a', sets: [{ weight: 1, reps: 1, drops: [] }] }] })
     && T.usesExt({ items: [{ exercise: 'a', sets: [], doneOnly: true }] })
     && !T.usesExt({ items: [{ exercise: 'a', sets: [{ weight: 1, reps: 1, note: 'x' }] }] }) && T.NEED_SCHEMA === 32 && T.NEED_SCHEMA_EXT === 33);
}

// ================= M20（高5）copyInto：新しい回は ord ごと・古い回は今までどおり名前で足す =================
{
  const { w } = boot({ cfg: { sessions: [S_NEW] }, ls: draftLS([{ exercise: 'スクワット', sets: [{ w: '10', r: '1', done: false }] }]) });
  await openForm(w);
  btn(R(w), '過去の記録から写す').click(); await settle();
  btn(R(w), '重量・回数ごと写す').click(); await nav();
  const d = draftOf(w);
  eq('M20-1 ★新しい回：同じ名前の2つの ord は2つの種目（下書きの同じ名前にも混ぜない）・ドロップの形は写す・補助/無理やりは写さない・数字の無い種目はそのまま', d.items.map((x) => [x.exercise, x.sets.map((s) => [String(s.w), String(s.r), s.done, s.assist || null, s.forced || null, (s.drops || []).map((q) => q.w + 'x' + q.r).join()]), x.doneOnly === undefined ? null : x.doneOnly]),
    [['スクワット', [['10', '1', false, null, null, '']], null], ['スクワット', [['60', '10', false, null, null, ''], ['100', '3', false, null, null, '']], null], ['ベンチプレス', [['40', '10', false, null, null, '']], null], ['スクワット', [['50', '8', false, null, null, '30x10']], null], ['プランク', [], false]]);
  const e = boot({ cfg: { sessions: [S_OLD] }, ls: draftLS([{ exercise: 'スクワット', sets: [{ w: '10', r: '1', done: false }] }]) });
  await openForm(e.w);
  btn(R(e.w), '過去の記録から写す').click(); await settle();
  btn(R(e.w), '重量・回数ごと写す').click(); await nav();
  const d2 = draftOf(e.w);
  ok('M20-2 ★古い回：今までどおり下書きの同じ名前に足す', d2.items.length === 1 && d2.items[0].sets.length === 2 && String(d2.items[0].sets[1].w) === '80', JSON.stringify(d2.items));
}

// ================= M21（I71）健康の文・括弧書き・最近の種目の候補 =================
{
  const HEALTH = { session_id: 'SH', session_date: '2026-10-01', created_at: 50, author_trainer_id: 'T1', rev: 1, sets: [{ exercise: '腰が痛い', set_no: 1, weight_kg: 0, reps: 10, e1rm: 0 }] };
  const { w, sent } = boot({ cfg: { sessions: [HEALTH] } });
  await openImport(w);
  paste(w, '腰が痛い\nヒップリフト\n50×10(右膝痛)\nｽｸﾜｯﾄ\n40×10');
  btn(R(w), '読み取る').click(); await settle();
  const go = () => btn(R(w), '記録の画面に入れる');
  const cH = () => [...R(w).querySelectorAll('.k-impcard[data-kind="name"]')].find((c) => c.querySelector('.k-imptext').textContent === '腰が痛い');
  const cS = () => [...R(w).querySelectorAll('.k-impcard[data-kind="name"]')].find((c) => c.querySelector('.k-imptext').textContent.startsWith('ｽｸﾜｯﾄ'));
  ok('M21-1 ★最近の種目に同じ健康の文があっても決定待ち・候補（もしかして）に出るだけ・候補の真下に注記', !!cH() && cH().querySelector('button.k-impcand[data-source="suggest"]') && cH().textContent.includes('痛み・診断・服薬') && go().disabled);
  cH().querySelector('button.k-impcand[data-source="suggest"]').click(); await settle();
  ok('M21-2 ★suggest の候補を押すと名前の欄に入るだけ（決まらない・押せない・下書きに入らない）', !!cH().querySelector('input[aria-label="種目名"]') && cH().querySelector('input[aria-label="種目名"]').value === '腰が痛い' && go().disabled && !cH().querySelector('.k-impdone') && !storeText(w.localStorage).includes('腰が痛い'));
  btn(cH(), '種目にする').click(); await settle();
  ok('M21-3 ★「種目にする」を押しても部位を選ぶまで押せない', go().disabled && cH().querySelectorAll('button[data-part]').length === 7);
  btn(cH(), '捨てる').click(); await settle();
  cS().querySelector('button.k-impcand[data-source="auto"]').click(); await settle();
  ok('M21-4 autoKnown の候補（ｽｸﾜｯﾄ→スクワット）は一押しで種目になる', cS().textContent.includes('種目「スクワット」にする'));
  const cP = card(w, 'paren');
  ok('M21-5 括弧書き：「括弧の中をセットのメモに入れる」の真下に注記・選ぶまで押せない', cP.textContent.includes('痛み・診断・服薬') && go().disabled);
  btn(cP, '括弧の中をセットのメモに入れてセットにする').click(); await settle();
  go().click(); await nav();
  const d = draftOf(w);
  eq('M21-6 ★選んだ先にだけ入る（健康の文は捨てた・括弧の中は選んだのでメモに）', d.items.map((x) => [x.exercise, x.sets.map((s) => s.w + 'x' + s.r + (s.note ? ':' + s.note : ''))]), [['ヒップリフト', ['50x10:右膝痛']], ['スクワット', ['40x10']]]);
  ok('M21-7 健康の文は下書き・送信のどこにも無い', !storeText(w.localStorage).includes('腰が痛い') && !JSON.stringify(sent).includes('腰が痛い'));
}

// ================= M22 使いやすさ =================
{
  const { w } = boot();
  await openImport(w);
  const ta = R(w).querySelector('textarea[aria-label="メモを貼る"]');
  ok('M22-1 貼る欄：16px・10行・自動補完/大文字/綴りの確認を切る・クリップボードの API を使わない', /k-memo\{[^}]*font-size:16px/.test(SRC) && ta.getAttribute('rows') === '10' && ta.getAttribute('autocomplete') === 'off' && ta.getAttribute('autocapitalize') === 'off' && ta.getAttribute('spellcheck') === 'false' && !/navigator\.clipboard/.test(SRC));
  ok('M22-2 ★新しいボタンは44px以上・「実施した」の✓は48px', /\.k-allchk\{[^}]*min-height:44px/.test(SRC) && /\.k-donechk\{[^}]*min-width:48px;min-height:48px/.test(SRC) && /\.k-dropadd\{[^}]*min-height:44px/.test(SRC) && /\.k-btn\{[^}]*min-height:44px/.test(SRC) && /\.k-rtg\{min-height:44px/.test(SRC));
  ok('M22-3 「読み取る」は下に固定・決定待ちのボタンは縦に並べ間を8px', btn(R(w), '読み取る').parentNode.classList.contains('k-savebar') && /\.k-impbtns\{display:flex;flex-direction:column;gap:8px;\}/.test(SRC));
  ok('M22-4 「全部✓」は見出しの「外す」と別の行（押し間違えない）', /前回の行の右に置く/.test(SRC));
}

// ================= M23（I72）サーバーの切替が off：409 TRAINING_EXT_OFF =================
{
  let first = true;
  const { w, sent } = boot({ cfg: { add: () => ({ success: false, code: 'TRAINING_EXT_OFF' }) }, ls: draftLS([{ exercise: 'スクワット', sets: [{ w: '40', r: '10', done: true, assist: '3' }] }]) });
  await openForm(w);
  btn(R(w), '保存する').click(); await settle();
  const d = draftOf(w);
  ok('M23-1 ★409 は黙らずに知らせる（この形の保存はまだ使えません・印を外せば保存できます）', w.alerts.some((a) => a.includes('この形の保存はまだ使えません') && a.includes('印を外せば')), JSON.stringify(w.alerts));
  ok('M23-2 ★pending を解く・下書き（種目・セット・補助の印）を残す・次は新しい送信番号', d && !d.pending && d.items.length === 1 && d.items[0].sets[0].assist === '3' && d.reqId !== 'kfixedreq0001');
  w.cfg.schema = 32;
  w.KarteUI.open('C1', '会員', 'training'); await settle();
  ok('M23-3 その後 karteSchema 32 で読み直すと取り込みのボタンが消える', !btn(R(w), 'メモから取り込む') && !!R(w).querySelector('.k-marks'));
  w.cfg.schema = 33; w.cfg.add = null;
  w.KarteUI.open('C1', '会員', 'training'); await settle();
  btn(R(w), '保存する').click(); await settle();
  const tr = adds(sent);
  ok('M23-4 次の保存は新しい送信番号で送る', tr.length === 2 && tr[0].clientReqId === 'kfixedreq0001' && tr[1].clientReqId !== tr[0].clientReqId && first);
}

// ================= M24 種目の下に書いたメモを、その種目のメモにする（2026-11-08 オーナー指摘：社内メモか種目かしか選べなかった） =================
{
  const { w, sent } = boot();
  await openImport(w);
  paste(w, 'ベンチプレス\n肘を上げる意識\n40×10 50×10\n胸を張る\nプランク\n体幹を意識\nヒップリフト\n30×10\n50キロ10回');
  btn(R(w), '読み取る').click(); await settle();
  const names = [...R(w).querySelectorAll('.k-impcard')];
  ok('M24-1 種目の直下の名前の決定待ち：直前の種目「ベンチプレス」の1セット目のメモにする が出る・プランクの下はプランク', !!btn(card(w, 'name', 0), '直前の種目「ベンチプレス」の1セット目のメモにする') && !!btn(card(w, 'name', 2), '直前の種目「プランク」'), names.map((c) => c.textContent).join(' | '));
  ok('M24-1b ★直前が決まっていない名前の決定待ちの下には出さない（どの種目か決まらない）', !btn(card(w, 'name', 1), '直前の種目'));
  ok('M24-2 種目の下の読めない数値の行：直前の種目「ヒップリフト」が出る', !!btn(card(w, 'line', 0), '直前の種目「ヒップリフト」'));
  btn(card(w, 'name', 0), '直前の種目').click(); await settle();
  ok('M24-2b 前を「種目のメモ」にすると、続く名前にも同じ宛先が出る', !!btn(card(w, 'name', 1), '直前の種目「ベンチプレス」'));
  for (const c of [card(w, 'name', 1), card(w, 'name', 2), card(w, 'line', 0)]) { btn(c, '直前の種目').click(); await settle(); }
  ok('M24-3 選んだ後の表示：1セット目のメモ・お客様には見えない・下の数値もその種目のセットにする', card(w, 'name', 0).textContent.includes('「ベンチプレス」の1セット目のメモにする（お客様には見えません）') && card(w, 'name', 0).textContent.includes('下の数値も「ベンチプレス」のセットにする'));
  btn(R(w), '記録の画面に入れる').click(); await nav();
  const d = draftOf(w);
  eq('M24-4 ★1セット目のメモに入る・名前の下の数値はその種目のセット・セットの無い種目は種目名を付けて社内メモへ（黙って捨てない）', d && { items: d.items.map((x) => [x.exercise, x.sets.map((s) => [s.w, s.r, s.note || '']), x.doneOnly]), memo: d.memo },
    { items: [['ベンチプレス', [['40', '10', '肘を上げる意識・胸を張る'], ['50', '10', '']], undefined], ['プランク', [], false], ['ヒップリフト', [['30', '10', '50キロ10回']], undefined]], memo: 'プランク：体幹を意識' });
  ok('M24-5 案内の1行に件数（種目のメモ 3件）', R(w).textContent.includes('種目のメモ 3件は、その種目の1セット目のメモに入れました'));
  ok('M24-6 記録の画面で1セット目のメモが開いて見える', [...R(w).querySelectorAll('input,textarea')].some((x) => x.value === '肘を上げる意識・胸を張る'));
  for (let i = 0; i < 3; i++) { const b = R(w).querySelector('button.k-allchk'); if (!b) break; b.click(); await settle(); }
  for (let i = 0; i < 2; i++) { const b = R(w).querySelector('button.k-donechk[aria-pressed="false"]'); if (!b) break; b.click(); await settle(); }
  btn(R(w), '保存する').click(); await settle();
  const tr = adds(sent);
  eq('M24-7 ★保存の本文：メモはセットの note で送る（新しい鍵は使わない）', tr.length === 1 ? tr[0].items : null, [
    { exercise: 'ベンチプレス', sets: [{ weight: 40, reps: 10, note: '肘を上げる意識・胸を張る' }, { weight: 50, reps: 10 }] },
    { exercise: 'プランク', sets: [], doneOnly: true },
    { exercise: 'ヒップリフト', sets: [{ weight: 30, reps: 10, note: '50キロ10回' }] }]);
}
{
  //   直前に種目が無い名前・数値と同じ行の名前には出さない（どの種目のメモか分からない）
  const { w } = boot();
  await openImport(w);
  paste(w, '謎の行\nベンチプレス\n40×10\n架空の種目 50×10');
  btn(R(w), '読み取る').click(); await settle();
  ok('M24-8 先頭の名前・「名前 数値」の行には「〜のメモにする」を出さない', !btn(card(w, 'name', 0), '直前の種目') && !btn(card(w, 'name', 1), '直前の種目'), [...R(w).querySelectorAll('.k-impcard')].map((c) => c.textContent).join(' | '));
}
{
  //   200字を超えるなら1セット目に入れず、種目名を付けて社内メモへ
  const { w } = boot();
  await openImport(w);
  const long = 'あ'.repeat(199);
  paste(w, 'ベンチプレス\n40×10\n' + long + '\n' + 'い'.repeat(5));
  btn(R(w), '読み取る').click(); await settle();
  for (let i = 0; i < 2; i++) { const c = card(w, 'name', i); if (c) { btn(c, '直前の種目').click(); await settle(); } }
  btn(R(w), '記録の画面に入れる').click(); await nav();
  const d = draftOf(w);
  ok('M24-9 ★200字を超える分は社内メモへ（切らない）', d && d.items[0].sets[0].note === long && d.memo === 'ベンチプレス：' + 'い'.repeat(5), JSON.stringify(d && { n: d.items[0].sets[0].note.length, m: d.memo }));
}

{
  //   ★Codex 関門② 高：知らない名前を「種目にする」と、その下のメモはその種目へ（一つ前の種目へ入れない）・選び直すと外れる
  const { w } = boot();
  await openImport(w);
  paste(w, 'ベンチプレス\n架空の新種目\n肘を上げる意識\n40×10');
  btn(R(w), '読み取る').click(); await settle();
  ok('M24-10 前の名前が決まるまで、下のメモには宛先を出さない', !btn(card(w, 'name', 1), '直前の種目'));
  btn(card(w, 'name', 0), '種目にする').click(); await settle();
  card(w, 'name', 0).querySelector('button[data-part="chest"]').click(); await settle();
  ok('M24-11 ★前を種目にしたら、宛先はその種目（ベンチプレスではない）', !!btn(card(w, 'name', 1), '直前の種目「架空の新種目」') && !btn(card(w, 'name', 1), '直前の種目「ベンチプレス」'));
  btn(card(w, 'name', 1), '直前の種目').click(); await settle();
  btn(card(w, 'name', 0), '選び直す').click(); await settle();
  ok('M24-12 ★前を選び直すと、それを宛先にしていたメモの決定も外れる（押せない）', !card(w, 'name', 1).querySelector('.k-impdone') && btn(R(w), '記録の画面に入れる').disabled === true);
  btn(card(w, 'name', 0), '種目にする').click(); await settle();
  card(w, 'name', 0).querySelector('button[data-part="chest"]').click(); await settle();
  btn(card(w, 'name', 1), '直前の種目').click(); await settle();
  btn(R(w), '記録の画面に入れる').click(); await nav();
  const d = draftOf(w);
  eq('M24-13 ★メモと下の数値は「架空の新種目」へ・ベンチプレスは触らない', d && d.items.map((x) => [x.exercise, x.sets.map((s) => [s.w, s.r, s.note || '']), x.regPart || '']),
    [['ベンチプレス', [], ''], ['架空の新種目', [['40', '10', '肘を上げる意識']], 'chest']]);
}

console.log(`\n${fail ? '❌' : '✅'} 設計38 メモから取り込む（画面） 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
