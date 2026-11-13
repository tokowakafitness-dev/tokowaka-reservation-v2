// 設計39 録音の文字起こしの AI 下書き：本番の liff/karte.js を jsdom で動かし、入口から通す・2026-11-12
//   実行: node worker/test/liff-karte-ai.test.js
//
//   ★カルテを開く → 今日の記録 → メモから取り込む → 貼る → 「AIで振り分ける」→ 計画・カード → 記録の画面 → ✓ → 保存、を click で通す
//   ★身代わりは fetch（Worker）・LINE の SDK だけ。Worker の応答は worker/src/routes/karte-ai.js の draft の形
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
const SRC = process.env.KARTE_SRC ? readFileSync(process.env.KARTE_SRC, 'utf8') : readFileSync(join(ROOT, 'liff/karte.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) pass++; else { fail++; console.log(`❌ ${name}${detail ? '\n   ' + detail : ''}`); } }
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 12; i++) await tick(); }
async function nav() { await new Promise((r) => setTimeout(r, 40)); await settle(); }
const b64u = (s) => Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (ageS) => b64u(JSON.stringify({ alg: 'ES256' })) + '.' + b64u(JSON.stringify({ iss: 'https://access.line.me', sub: 'U_TEST', iat: Math.floor(Date.now() / 1000) - ageS, exp: Math.floor(Date.now() / 1000) + 3600 })) + '.sig';

const SECRET = '架空の選挙の雑談がここにある';
const TRANSCRIPT = 'ベンチプレス 20キロで10回 次30キロで5回\nスカルフラッシュ 10キロで12回\n' + SECRET + '\n腰が少し痛い';
const DRAFT = () => ({
  exercises: [
    { name: 'ベンチプレス', heard: 'ベンチプレス', note: '', sets: [{ w: 20, r: 10, evidence: '20キロで10回', note: '' }, { w: 30, r: 5, evidence: '次30キロで5回', note: 'フォーム良い' }],
      unverified: [{ w: 60, r: 5, evidence: '次60キロ', note: '' }] },
    { name: 'スカルクラッシャー', heard: 'スカルフラッシュ', note: '', sets: [{ w: 10, r: 12, evidence: 'スカルフラッシュ 10キロで12回', note: '' }], unverified: [] }],
  coaching: ['肘を張りすぎない', '初回より安定'],
  hearing: ['睡眠は5時間くらい'],
  caution: ['腰が少し痛い'],
  member_message: 'フォームが安定してきました。',
  member_todo: ['ストレッチ 2分'],
});

function bootWith(src, o = {}) { return boot(o, src); }
function boot(o = {}, srcOverride) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'https://reservation.tokowaka-gym.com/liff/', pretendToBeVisual: true });
  const w = dom.window;
  const sent = [];
  for (const [k, v] of Object.entries(o.ls || {})) w.localStorage.setItem(k, v);
  w.idToken = o.token || jwt(30);
  w.EDGE_URL = 'https://edge.example';
  w.state = { trainerId: 'T1', _isOwner: false, _allTrainers: [{ id: 'T1', name: '一郎' }] };
  w.alerts = []; w.alert = (m) => w.alerts.push(String(m));
  w.confirms = 0; w.confirm = () => { w.confirms++; return true; };
  w.reloaded = 0; w.__karteReload = () => { w.reloaded++; };
  w.logs = [];
  ['log', 'info', 'warn', 'error', 'debug'].forEach((k) => { w.console[k] = (...a) => w.logs.push(a.map(String).join(' ')); });
  w.liff = { getIDToken: () => w.idToken, logout: () => {} };
  w.cfg = Object.assign({ ai: true, aiConsent: 'agreed', aiReply: null, hold: null }, o.cfg || {});
  w.fetch = async (url, opt) => {
    const body = JSON.parse(opt.body);
    sent.push({ url: String(url), body });
    const c = w.cfg;
    let r;
    if (body.action === 'k_training') r = Object.assign({ success: true, karteSchema: 33, aiDraft: c.ai, sessions: [], best: [] }, c.aiConsent === undefined ? {} : { aiConsent: c.aiConsent });
    else if (body.action === 'k_summary' && c.summary) r = c.summary;
    else if (body.action === 'k_contract' && c.summary) r = { success: true, contracts: [] };
    else if (body.action === 'k_exercises') r = { success: true, karteSchema: 33, exercises: [{ name: 'ベンチプレス', part: 'chest' }], truncated: false };
    else if (body.action === 'k_aiDraft') {
      if (c.hold) await c.hold;
      r = c.aiReply ? c.aiReply(body) : { success: true, draft: DRAFT(), model: 'claude-sonnet-5-5', build: 'x' };
    }
    else if (body.action === 'k_addTraining') r = { success: true, sessionId: 'N1', rev: 1, mnoteId: body.member ? 'M1' : undefined };
    else r = { success: true };
    return { json: async () => JSON.parse(JSON.stringify(r)) };
  };
  w.eval(srcOverride || SRC);
  return { w, sent };
}
const R = (w) => w.document.getElementById('karteRoot');
const btn = (root, t) => [...root.querySelectorAll('button')].find((x) => x.textContent.indexOf(t) === 0);
const btnsIn = (el) => [...el.querySelectorAll('button')].map((b) => b.textContent);
const pill = (root, t) => [...root.querySelectorAll('button.k-pill')].find((x) => x.textContent === t);
const DKEY = 'karte_tr_draft_v1:T1:C1';
const draftOf = (w) => JSON.parse(w.localStorage.getItem(DKEY) || 'null');
const storeText = (s) => { let o = ''; for (let i = 0; i < s.length; i++) o += s.key(i) + '=' + s.getItem(s.key(i)) + '\n'; return o; };
const cards = (w) => [...R(w).querySelectorAll('.k-impcard')];
const cardBy = (w, re) => cards(w).find((c) => re.test(c.textContent));
async function openImport(w) {
  w.KarteUI.open('C1', '会員', 'training'); await settle();
  const b = btn(R(w), '＋ 今日の記録') || btn(R(w), '記録の入力（途中）を開く');
  if (b && !R(w).classList.contains('k-entry')) { b.click(); await settle(); }
  btn(R(w), 'メモから取り込む').click(); await settle();
}
function paste(w, text) { const ta = R(w).querySelector('textarea[aria-label="メモを貼る"]'); ta.value = text; ta.dispatchEvent(new w.Event('input', { bubbles: true })); return ta; }
const aiSends = (sent) => sent.filter((x) => x.body.action === 'k_aiDraft');

// ================= L1 ボタンの有無 =================
{
  const { w } = boot({ cfg: { ai: false } });
  await openImport(w);
  ok('L1-1 ★aiDraft が偽ならボタンを出さない・案内は「何も送りません」のまま', !btn(R(w), 'AIで振り分ける') && R(w).textContent.includes('この画面からは何も送りません'));
  const b = boot();
  await openImport(b.w);
  const ab = btn(R(b.w), 'AIで振り分ける');
  ok('L1-2 aiDraft が真なら「読み取る」の下にボタン・外部へ送る案内', !!ab && !!btn(R(b.w), '読み取る') && R(b.w).textContent.includes('外部（Anthropic）へ送ります') && R(b.w).textContent.includes('聞き違い・第三者の名前・トレーナーの名前のかな書きは残ることがあります'));
  //   設計44：お客様の録音・AI の同意が無い・確認できない・古い Worker（aiConsent が無い）はボタンを出さない
  for (const [label, v, want] of [['none', 'none', '同意していません'], ['unknown', 'unknown', '確認できませんでした'], ['無い（古い Worker）', undefined, '確認できませんでした']]) {
    const x = boot({ cfg: { aiConsent: v } });
    await openImport(x.w);
    ok('L1-4 ★aiConsent が' + label + 'なら AI のボタンを出さず、理由の文と「読み取る」', !btn(R(x.w), 'AIで振り分ける') && !!btn(R(x.w), '読み取る') && R(x.w).textContent.includes(want));
  }
  ab.click(); await settle();
  ok('L1-3 空なら送らない', aiSends(b.sent).length === 0 && R(b.w).textContent.includes('文字起こしを貼ってください'));
}

// ================= L2 入口から保存まで =================
{
  const { w, sent } = boot();
  await openImport(w);
  paste(w, TRANSCRIPT);
  btn(R(w), 'AIで振り分ける').click(); await settle();
  const s1 = aiSends(sent);
  ok('L2-1 ★送ったのは k_aiDraft の1回だけ・/karte/ai-draft へ・文字起こし・顧客・known', s1.length === 1 && s1[0].url === 'https://edge.example/karte/ai-draft' && s1[0].body.text === TRANSCRIPT.trim() && s1[0].body.customerId === 'C1' && s1[0].body.known.includes('ベンチプレス'), JSON.stringify(s1.map((x) => x.url)));
  ok('L2-2 要約は「AIの下書き」', R(w).querySelector('.k-impsum').textContent.indexOf('AIの下書き') === 0);
  const planBtn = btn(R(w), '提案どおりに決める');
  //   計画に入るもの：ベンチプレスのセット（一覧にある）・指導のメモ1（「初回」を含む文は名前の印＝提案なし）・ヒアリング
  ok('L2-3 ★計画は3件（ベンチのセット・指導のメモ・ヒアリング）＝お客様へ・次回までに・体の状態・一覧に無い種目・確かめられない数字は入らない', planBtn && /（3件）/.test(planBtn.textContent), planBtn && planBtn.textContent);
  planBtn.click(); await settle();
  const box = R(w).querySelector('.k-impplanbox');
  ok('L2-4 ★計画の一覧に根拠（文字起こしの抜き出し）と行き先が出る', box && box.textContent.includes('ベンチプレス：「20キロで10回」／「次30キロで5回」') && box.textContent.includes('「ベンチプレス」に 20kg×10・30kg×5 を足す') && box.textContent.includes('ヒアリング：睡眠は5時間くらい'), box && box.textContent);
  btn(R(w), 'この内容で決める').click(); await settle();
  //   体の状態：捨てるだけ
  const cc = cardBy(w, /AI：体の状態/);
  ok('L2-5 ★体の状態のカードは「捨てる」だけ（社内メモにも入れない）', cc && JSON.stringify(btnsIn(cc)) === JSON.stringify(['捨てる']) && cc.textContent.includes('「注意すること」の画面で入れてください'), cc && JSON.stringify(btnsIn(cc)));
  btn(cc, '捨てる').click(); await settle();
  //   一覧に無い種目：先に名前 → セットの足すボタンはまだ出ない
  const rc0 = cardBy(w, /スカルクラッシャー：「/);
  ok('L2-6 ★一覧に無い種目のセットは、名前を決める前は「足す」が出ない', rc0 && !btnsIn(rc0).some((t) => t.includes('を足す')) && rc0.textContent.includes('先に「スカルクラッシャー」の種目名を決めてください'), rc0 && rc0.textContent);
  const nc = cardBy(w, /聞こえた言葉：スカルフラッシュ/);
  btn(nc, '種目にする').click(); await settle();
  pill(R(w), '腕').click(); await settle();
  const rc = cardBy(w, /スカルクラッシャー：「/);
  ok('L2-7 名前を種目にした後は「スカルクラッシャー」に足すボタン', rc && btnsIn(rc).some((t) => t.indexOf('「スカルクラッシャー」に 10kg×12 を足す') === 0), rc && JSON.stringify(btnsIn(rc)));
  btn(rc, '「スカルクラッシャー」に').click(); await settle();
  //   選び直し：名前を選び直すとセットの決定も外れる
  btn(cardBy(w, /聞こえた言葉：スカルフラッシュ/), '選び直す').click(); await settle();
  const rc2 = cardBy(w, /スカルクラッシャー：「/);
  ok('L2-8 ★名前を選び直すと、その下のセットの「足す」も外れる', rc2 && !rc2.querySelector('.k-impdone') && !btnsIn(rc2).some((t) => t.includes('を足す')));
  btn(cardBy(w, /聞こえた言葉：スカルフラッシュ/), '種目にする').click(); await settle();
  pill(R(w), '腕').click(); await settle();
  btn(cardBy(w, /スカルクラッシャー：「/), '「スカルクラッシャー」に').click(); await settle();
  //   確かめられない数字・名前の印のある指導のメモ
  btn(cardBy(w, /数字を確かめられません/), '捨てる').click(); await settle();
  btn(cardBy(w, /初回より安定/), '社内メモに足す').click(); await settle();
  //   お客様に見える欄：1件ずつ
  const mc = cardBy(w, /AI：お客様へ/);
  ok('L2-9 ★お客様へは「お客様にそのまま見えます」を出し1件ずつ', mc && mc.textContent.includes('お客様にそのまま見えます') && btnsIn(mc)[0] === 'お客様へに入れる');
  btn(mc, 'お客様へに入れる').click(); await settle();
  btn(cardBy(w, /AI：次回までに/), '次回までにに入れる').click(); await settle();
  const put = btn(R(w), '記録の画面に入れる');
  ok('L2-10 全部決めると押せる', put && !put.disabled, R(w).textContent.slice(-200));
  put.click(); await nav();
  const D = draftOf(w);
  ok('L2-11 ★下書き：ベンチ 20×10・30×5（メモ「フォーム良い」）・スカルクラッシャー 10×12（部位 arm）・✓は全部 false',
     D && D.items.length === 2 && D.items[0].exercise === 'ベンチプレス' && JSON.stringify(D.items[0].sets.map((s) => [s.w, s.r, s.done])) === '[["20","10",false],["30","5",false]]' && D.items[0].sets[1].note === 'フォーム良い'
     && D.items[1].exercise === 'スカルクラッシャー' && D.items[1].regPart === 'arm' && D.items[1].sets[0].done === false, JSON.stringify(D && D.items));
  ok('L2-12 ★お客様へ・次回までには下書きの member に入る（保存するまでお客様には出ない）', D.member && D.member.message === 'フォームが安定してきました。' && D.member.todo[0] === 'ストレッチ 2分');
  ok('L2-13 社内メモに指導のメモとヒアリング（体の状態・雑談は無い）', /肘を張りすぎない/.test(D.memo) && /ヒアリング：睡眠は5時間くらい/.test(D.memo) && /初回より安定/.test(D.memo) && !/腰が少し痛い/.test(D.memo));
  const st = storeText(w.localStorage) + storeText(w.sessionStorage), logT = w.logs.join('\n');
  ok('L2-14 ★保存領域・console に文字起こしの全文・雑談が無い（I63）', !st.includes(SECRET) && !st.includes(TRANSCRIPT) && !logT.includes(SECRET) && !st.includes('20キロで10回'));
  //   ✓して保存
  for (let i = 0; i < 3; i++) { const b = R(w).querySelector('button.k-allchk'); if (!b) break; b.click(); await settle(); }
  btn(R(w), '保存する').click(); await settle();
  const add = sent.filter((x) => x.body.action === 'k_addTraining');
  ok('L2-15 ★保存は既存の k_addTraining の1回・お客様に見える欄も同梱・AI の送信は1回のまま', add.length === 1 && add[0].body.items.length === 2 && add[0].body.member && add[0].body.member.message === 'フォームが安定してきました。' && aiSends(sent).length === 1, JSON.stringify(add.map((x) => x.body)).slice(0, 400));
  ok('L2-16 確かめのダイアログを増やしていない', w.confirms === 0 && w.alerts.length === 0, JSON.stringify(w.alerts));
}

// ================= L3 失敗・古いトークン・応答の前に文字を変えた =================
{
  const { w, sent } = boot({ cfg: { aiReply: () => ({ success: false, code: 'AI_NOT_CONFIGURED' }) } });
  await openImport(w);
  const ta = paste(w, TRANSCRIPT);
  btn(R(w), 'AIで振り分ける').click(); await settle();
  ok('L3-1 ★失敗は画面の1行で知らせ・貼った文字は残り・「読み取る」が使える', R(w).textContent.includes('AIの振り分けはいま使えません') && ta.value === TRANSCRIPT && !!btn(R(w), '読み取る') && w.alerts.length === 0);
  w.cfg.aiReply = () => ({ success: false, code: 'AI_TIMEOUT' });
  btn(R(w), 'AIで振り分ける').click(); await settle();
  ok('L3-2 時間切れは「もう一度押すと1日の回数を1回使います」', R(w).textContent.includes('もう一度押すと1日の回数を1回使います') && aiSends(sent).length === 2);
}
{
  const { w, sent } = boot({ token: jwt(3600) });
  await openImport(w);
  paste(w, TRANSCRIPT);
  btn(R(w), 'AIで振り分ける').click(); await settle();
  ok('L3-3 ★トークンが59分を超えていたら送らず読み直さない（原文を退避しない）', aiSends(sent).length === 0 && w.reloaded === 0 && R(w).textContent.includes('ログインの更新が必要です') && !storeText(w.sessionStorage).includes(SECRET));
}
{
  let release; const hold = new Promise((r) => { release = r; });
  const { w, sent } = boot({ cfg: { hold } });
  await openImport(w);
  paste(w, TRANSCRIPT);
  btn(R(w), 'AIで振り分ける').click(); await settle();
  const busy = btn(R(w), '振り分けています');
  ok('L3-4 送信中はボタンを押せない', busy && busy.disabled);
  paste(w, TRANSCRIPT + '\n追記');
  release(); await settle();
  ok('L3-5 ★応答の前に文字を変えたら古い応答を捨てる（カードを出さない）', cards(w).length === 0 && aiSends(sent).length === 1);
}
{
  //   お客様へが入りきらない：取り込み全体を止め、下書きは変えない
  const long = 'あ'.repeat(395);
  const ls = { [DKEY]: JSON.stringify({ v: 1, tid: 'T1', cid: 'C1', sessionDate: '2026-11-05', items: [], reqId: 'kfixedreq0001', pending: null, at: Date.now(), member: { message: long, todo: ['', '', ''], tags: [] } }) };
  const { w } = boot({ ls, cfg: { aiReply: () => ({ success: true, draft: { exercises: [], coaching: [], hearing: [], caution: [], member_message: 'もう少し長い文です', member_todo: [] } }) } });
  await openImport(w);
  paste(w, TRANSCRIPT);
  const before = w.localStorage.getItem(DKEY);
  btn(R(w), 'AIで振り分ける').click(); await settle();
  btn(cardBy(w, /AI：お客様へ/), 'お客様へに入れる').click(); await settle();
  btn(R(w), '記録の画面に入れる').click(); await settle();
  ok('L3-6 ★お客様へが400字を超えるなら取り込み全体を止め、下書きを変えない', w.localStorage.getItem(DKEY) === before && R(w).textContent.includes('お客様に見える欄に入りきりません'));
}
{
  //   健康語・名前の印のある「お客様へ」には入れるボタンを出さない
  const { w } = boot({ cfg: { aiReply: () => ({ success: true, draft: { exercises: [], coaching: [], hearing: [], caution: [], member_message: '〔人〕さんにもよろしく', member_todo: ['x'.repeat(61)] } }) } });
  await openImport(w);
  paste(w, TRANSCRIPT);
  btn(R(w), 'AIで振り分ける').click(); await settle();
  ok('L3-7 名前の印のあるお客様へ・60字を超える次回までには「入れる」を出さない（社内メモ／捨てるだけ）',
     JSON.stringify(btnsIn(cardBy(w, /AI：お客様へ/))) === JSON.stringify(['社内メモに足す', '捨てる']) && JSON.stringify(btnsIn(cardBy(w, /AI：次回までに/))) === JSON.stringify(['社内メモに足す', '捨てる']));
  ok('L3-8 ★計画のボタンが無い（お客様に見える文は計画に入らない）', !btn(R(w), '提案どおりに決める'));
}
{
  //   「読み取る」は今どおり何も送らない
  const { w, sent } = boot();
  await openImport(w);
  paste(w, 'ベンチプレス\n30×10');
  btn(R(w), '読み取る').click(); await nav();
  ok('L3-9 「読み取る」は AI を呼ばない（今どおり端末の中）', aiSends(sent).length === 0 && draftOf(w) && draftOf(w).items.length === 1);
}

// ================= L5 関門② 高1：健康語を含む AI の文は捨てるだけ（Worker を抜けてきても画面で止める）=================
{
  const { w } = boot({ cfg: { aiReply: () => ({ success: true, draft: { exercises: [{ name: 'ベンチプレス', heard: '', note: '', sets: [], unverified: [{ w: 50, r: 5, evidence: '膝が痛い', note: '' }] }], coaching: ['肩に違和感'], hearing: [], caution: [], member_message: '', member_todo: [] } }) } });
  await openImport(w);
  paste(w, TRANSCRIPT);
  btn(R(w), 'AIで振り分ける').click(); await settle();
  ok('L5-1 ★健康語を含む指導のメモ・確かめられないセットは「捨てる」だけ', JSON.stringify(btnsIn(cardBy(w, /肩に違和感/))) === JSON.stringify(['捨てる']) && JSON.stringify(btnsIn(cardBy(w, /膝が痛い/))) === JSON.stringify(['捨てる']), JSON.stringify([btnsIn(cardBy(w, /肩に違和感/)), btnsIn(cardBy(w, /膝が痛い/))]));
}

// ================= L4 ★許可の表（aiActOk）だけで止まること =================
//   画面からは許可外の決定を作れない（選び直しで依存を外すため）。そこで「依存を外す1行」を抜いた版の画面を作り、
//   名前を捨てた後に「足す」が残る＝許可外の状態で、取り込み全体が止まり下書きが変わらないことを確かめる
{
  const line = "      res.pending.forEach(function (q, k) { if (k > j && q.ai && q.pendItem === j && dec[k] && dec[k].act === 'addset') dec[k] = null; });";
  ok('L4-0 抜く1行が本番のコードにある', SRC.split(line).length === 2);
  const prev = process.env.KARTE_SRC;
  const { w } = (() => { const saved = SRC; return bootWith(saved.replace(line, '')); })();
  await openImport(w);
  paste(w, TRANSCRIPT);
  const before = w.localStorage.getItem(DKEY);
  btn(R(w), 'AIで振り分ける').click(); await settle();
  btn(cardBy(w, /聞こえた言葉：スカルフラッシュ/), '種目にする').click(); await settle();
  pill(R(w), '腕').click(); await settle();
  btn(cardBy(w, /スカルクラッシャー：「/), '「スカルクラッシャー」に').click(); await settle();
  btn(cardBy(w, /聞こえた言葉：スカルフラッシュ/), '選び直す').click(); await settle();
  btn(cardBy(w, /聞こえた言葉：スカルフラッシュ/), '捨てる').click(); await settle();
  for (const c of cards(w)) { if (!c.querySelector('.k-impdone')) { const b = btn(c, '捨てる'); if (b) { b.click(); await settle(); } } }
  const put = btn(R(w), '記録の画面に入れる');
  put && put.click(); await settle();
  ok('L4-1 ★許可外の決定（宛先の無い「足す」）が残ると取り込み全体を止め、下書きを変えない', w.localStorage.getItem(DKEY) === before && R(w).textContent.includes('この選び方では入れられません'), R(w).textContent.slice(0, 300));
  ok('L4-2 console に本文を出さない', !w.logs.join('\n').includes(SECRET) && !w.logs.join('\n').includes('スカル'));
  void prev;
}

// ================= L9 契約・会員タブの「録音と AI の記録作成の同意」（設計44）=================
{
  const SUM = (rc, hc) => ({ success: true, karteSchema: 33, customer: { customerId: 'C1', name: '会員', trainerId: 'T1' }, assigned: false, profile: null,
    consent: hc || { state: 'agreed', changedAt: Date.UTC(2026, 10, 13), method: 'line', byMember: true }, recConsent: rc, safetyBrief: null, lastNote: null, nextReservation: null });
  const a = boot({ cfg: { summary: SUM({ state: 'agreed', changedAt: Date.UTC(2026, 10, 13), byMember: true }) } });
  a.w.KarteUI.open('C1', '会員', 'contract'); await settle();
  const row = R(a.w).querySelector('.k-reccons');
  ok('L9-1 録音と AI の同意の行：同意済み（会員画面）・健康情報も（会員画面）', !!row && row.textContent.includes('同意済み') && row.textContent.includes('（会員画面）') && R(a.w).textContent.includes('健康情報の取り扱いの同意'), row && row.textContent);
  const rb = [...row.querySelectorAll('button')].find((b) => b.textContent.indexOf('撤回を記録') === 0);
  rb.click(); await settle();
  const sv = a.sent.filter((x) => x.body.action === 'k_saveConsent');
  ok('L9-2 ★撤回を記録：確かめてから k_saveConsent に kind:rec_ai・state:revoked だけ（同意は送らない）', a.w.confirms >= 1 && sv.length === 1 && sv[0].body.kind === 'rec_ai' && sv[0].body.state === 'revoked' && !('method' in sv[0].body), JSON.stringify(sv.map((x) => x.body)));
  for (const [label, rc, want] of [['未回答', { state: 'none' }, '未回答'], ['撤回済み', { state: 'revoked', changedAt: 1 }, '撤回済み'], ['読めない', { state: 'unknown' }, '確認できませんでした']]) {
    const b = boot({ cfg: { summary: SUM(rc) } });
    b.w.KarteUI.open('C1', '会員', 'contract'); await settle();
    const r2 = R(b.w).querySelector('.k-reccons');
    ok('L9-3 ' + label + 'なら「' + want + '」・撤回のボタンも同意のボタンも出さない', !!r2 && r2.textContent.includes(want) && r2.querySelectorAll('button').length === 0);
  }
}

console.log(`liff-karte-ai: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
