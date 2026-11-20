// 設計49 AI の下書き v2 を1画面で確認する：本番の liff/karte.js を jsdom で動かし、入口から通す・2026-11-20
//   実行: node worker/test/liff-karte-ai-review.test.js
//
//   ★カルテを開く → 今日の記録 → メモから取り込む → 貼る → 「AIで振り分ける」→ 1画面の確認 → 最後のボタン → 記録の画面 → ✓ → 保存、を click で通す
//   ★身代わりは fetch（Worker）・LINE の SDK だけ。Worker の応答は worker/src/routes/karte-ai-v2.js の draft（v:2）の形
//   ★試用（AI_V2_SAVE_SCOPE='trial'・既定）と full（同じ JS の定数を置き換えて）の両方を通す
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
const SCOPE_LINE = "var AI_V2_SAVE_SCOPE = 'trial';";
const FULL = SRC.replace(SCOPE_LINE, "var AI_V2_SAVE_SCOPE = 'full';");
const BOGUS = SRC.replace(SCOPE_LINE, "var AI_V2_SAVE_SCOPE = 'Full';");

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
  v: 2, effort: 'low',
  summary: ['ベンチプレスを50キロで2セット行った', '初回のスカルクラッシャーを試した'],
  exercises: [
    { name: 'ベンチプレス', heard: 'ベンチプレス', note: '肩甲骨を寄せる', sets: [
      { status: 'match', w: 50, r: 10, evidence: 'ベンチプレス 50キロで10回', unsure: '', note: 'フォーム良い' },
      { status: 'inferred', w: 50, r: 8, evidence: EVID, unsure: '予告かもしれない', note: '' },
      { status: 'nobasis', w: 60, r: 5, evidence: '60キロで5回', unsure: '', note: '' },
      { status: 'healthHidden', w: null, r: null, evidence: '', unsure: '', note: '' }] },
    { name: 'スカルクラッシャー', heard: 'スカルフラッシュ', note: '', sets: [{ status: 'match', w: 10, r: 12, evidence: 'スカルフラッシュ 10キロで12回', unsure: '', note: '' }] }],
  condition: ['睡眠不足で疲れ気味'],
  caution: ['膝が少し痛い'],
  coaching: ['肘を張りすぎない', '〔人〕と一緒に来たいと話していた'],
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
  w.eval(o.src || SRC);
  return { w, sent };
}
const R = (w) => w.document.getElementById('karteRoot');
const btn = (root, t) => [...root.querySelectorAll('button')].find((x) => x.textContent.indexOf(t) === 0);
const btns = (root, t) => [...root.querySelectorAll('button')].filter((x) => x.textContent.indexOf(t) === 0);
const DKEY = 'karte_tr_draft_v1:T1:C1';
const draftOf = (w) => JSON.parse(w.localStorage.getItem(DKEY) || 'null');
const storeText = (s) => { let o = ''; for (let i = 0; i < s.length; i++) o += s.key(i) + '=' + s.getItem(s.key(i)) + '\n'; return o; };
const sec = (w, cls) => R(w).querySelector('.' + cls);
const rows = (w, kind) => [...R(w).querySelectorAll('.k-rvrow[data-kind="' + kind + '"]')];
const setRows = (w) => [...R(w).querySelectorAll('.k-rvset')];
const put = (w) => R(w).querySelector('button.k-rvput');
async function openImport(w) {
  w.KarteUI.open('C1', '会員', 'training'); await settle();
  const b = btn(R(w), '＋ 今日の記録') || btn(R(w), '記録の入力（途中）を開く');
  if (b && !R(w).classList.contains('k-entry')) { b.click(); await settle(); }
  btn(R(w), 'メモから取り込む').click(); await settle();
}
function paste(w, text) { const ta = R(w).querySelector('textarea[aria-label="メモを貼る"]'); ta.value = text; ta.dispatchEvent(new w.Event('input', { bubbles: true })); return ta; }
async function toReview(w) { await openImport(w); paste(w, TRANSCRIPT); btn(R(w), 'AIで振り分ける').click(); await settle(); }
const exCard = (w, name) => [...R(w).querySelectorAll('.k-rvex')].find((c) => c.textContent.indexOf(name) === 0);
async function nameSkull(w) {
  const c = exCard(w, 'スカルクラッシャー');
  btn(c, '種目にする').click(); await settle();
  [...R(w).querySelectorAll('button.k-pill')].find((x) => x.textContent === '腕').click(); await settle();
}
async function saveAll(w) {
  for (let i = 0; i < 4; i++) { const b = R(w).querySelector('button.k-allchk'); if (!b) break; b.click(); await settle(); }
  btn(R(w), '保存する').click(); await settle();
}

// ================= R1・R2・R3・R7・R17・R9 試用（既定） =================
{
  const { w, sent } = await (async () => { const b = boot(); await toReview(b.w); return b; })();
  const s1 = sent.filter((x) => x.body.action === 'k_aiDraft');
  ok('R1 ★要求に client_ai_format:2（数値）と clientReqId（形が合う番号）', s1.length === 1 && s1[0].body.client_ai_format === 2 && /^[A-Za-z0-9_-]{1,36}$/.test(s1[0].body.clientReqId), JSON.stringify(s1.map((x) => x.body.client_ai_format)));
  ok('R1 ★1画面に要約・種目・状態・次回・指導・ヒアリング・体のこと・お客様の欄・要確認の点・カードは出ない', !!sec(w, 'k-rvsum') && !!sec(w, 'k-rvexs') && rows(w, 'condition').length === 1 && rows(w, 'next').length === 1 && rows(w, 'coaching').length === 2 && rows(w, 'hearing').length === 1 && !!sec(w, 'k-rvcau') && !!sec(w, 'k-rvmem') && rows(w, 'unclear').length === 1 && R(w).querySelectorAll('.k-impcard').length === 0);
  ok('R1 要約は畳まずに全文が出る', sec(w, 'k-rvsum').textContent.includes('ベンチプレスを50キロで2セット行った') && sec(w, 'k-rvsum').textContent.includes('初回のスカルクラッシャーを試した') && !sec(w, 'k-rvsum').querySelector('details'));
  ok('R2 ★押すまで記録の下書き・保存領域に何も入らない・console に原文が無い', (!draftOf(w) || !(draftOf(w).items || []).length) && !storeText(w.localStorage).includes(SECRET) && !storeText(w.sessionStorage).includes(SECRET) && !storeText(w.localStorage).includes('予告かもしれない') && !w.logs.join('\n').includes(SECRET));
  ok('R17 ★試用：要約・状態・次回・要確認の点は「見るだけ」（入れる操作が無い）', ['summary', 'condition', 'next', 'unclear'].every((k) => rows(w, k).every((r) => r.querySelector('.k-rvview') && !r.querySelector('button.k-rvtog'))));
  const st = setRows(w);
  ok('R17 ★試用：推論・根拠なし・健康の根拠のセットは見るだけ（確定・欄の編集・外すが無い）・印と根拠は出る', ['inferred', 'nobasis', 'healthHidden'].every((k) => { const r = st.find((x) => x.dataset.status === k); return r && r.querySelector('.k-rvview') && !r.querySelector('input') && !btn(r, 'この数字で確定') && !btn(r, '根拠なしのまま確定') && !btn(r, '外す'); }) && st.find((x) => x.dataset.status === 'inferred').textContent.includes('推 50kg') && st.find((x) => x.dataset.status === 'nobasis').textContent.includes('！ 60kg'));
  const hh = st.find((x) => x.dataset.status === 'healthHidden');
  ok('R18 ★健康の根拠のセットは固定文だけ（健康の語・数字を出さない）', hh.textContent.includes('健康の情報を含む根拠だったため、そのままは使えません') && !/痛|kg/.test(hh.textContent), hh.textContent);
  ok('R7 体のことは入れる操作が無い・〔人〕を含む指導の文は入れられる（初期値で入る）', !sec(w, 'k-rvcau').querySelector('button') && rows(w, 'coaching')[1].querySelector('button.k-rvtog').getAttribute('aria-pressed') === 'true');
  ok('R7 名前の印（初回）を含む要約の文は初期値で外れる（試用では見るだけ）', rows(w, 'summary')[1].textContent.includes('初回'));
  ok('R6 お客様に見える欄は初期値で入らない（押せば入る）', rows(w, 'member')[0].querySelector('button.k-rvtog').getAttribute('aria-pressed') === 'false');
  ok('R3 ★一覧に無い種目が未決＝要確認あと1件・最後のボタンは押せない', R(w).querySelector('.k-rvhead').textContent.includes('要確認 あと1件') && put(w).disabled, R(w).querySelector('.k-rvhead').textContent);
  ok('R1 区分ごとの採用件数がボタンの直上に出る', R(w).querySelector('.k-rvcount').textContent.includes('採用：セット 1') && R(w).querySelector('.k-rvcount').nextElementSibling === put(w), R(w).querySelector('.k-rvcount').textContent);
  await nameSkull(w);
  ok('R8 種目名を決めると要確認なし・押せる・件数にスカルのセットが入る', !put(w).disabled && R(w).querySelector('.k-rvhead').textContent.includes('要確認なし') && R(w).querySelector('.k-rvcount').textContent.includes('採用：セット 2'));
  btn(rows(w, 'member')[0], 'お客様へに入れない').click(); await settle();
  put(w).click(); await nav();
  const D = draftOf(w);
  ok('R17 ★試用：下書きに入るのは match のセットだけ（ベンチ 50×10・スカル 10×12）・✓は全部 false（I57）・src は無い',
     D && D.items.length === 2 && JSON.stringify(D.items[0].sets.map((s) => [s.w, s.r, s.done])) === '[["50","10",false]]' && D.items[0].sets[0].note === 'フォーム良い' && D.items[1].exercise === 'スカルクラッシャー' && D.items[1].regPart === 'arm' && !JSON.stringify(D.items).includes('"src"'), JSON.stringify(D && D.items));
  ok('R17 ★試用：社内メモに指導・ヒアリング・種目のメモ・〔人〕の文／要約・状態・次回・要確認の点・体のことは無い', /肘を張りすぎない/.test(D.memo) && /ヒアリング：睡眠は5時間くらい/.test(D.memo) && /ベンチプレス：肩甲骨を寄せる/.test(D.memo) && /〔人〕と一緒/.test(D.memo) && !/今日の流れ/.test(D.memo) && !/状態：/.test(D.memo) && !/52\.5/.test(D.memo) && !/要確認：/.test(D.memo) && !/膝/.test(D.memo), D.memo);
  ok('R6 お客様へは押したので入る・次回までには押していないので入らない', D.member && D.member.message === 'フォームが安定してきました。' && !(D.member.todo || []).some((t) => t));
  ok('R13 ★下書きのどこにも根拠（evidence）の文字列が無い・保存領域に雑談が無い', !storeText(w.localStorage).includes(EVID) && !storeText(w.localStorage).includes('予告かもしれない') && !storeText(w.localStorage).includes(SECRET));
  ok('R2 確かめのダイアログを増やしていない', w.confirms === 0 && w.alerts.length === 0, JSON.stringify(w.alerts));
}
// ================= R17 不正な scope は trial に倒れる =================
{
  const { w } = boot({ src: BOGUS });
  await toReview(w);
  ok('R17 ★AI_V2_SAVE_SCOPE が不正な値（Full）なら trial（推論の確定ボタンが無い）', !btn(R(w), 'この数字で確定') && setRows(w).find((x) => x.dataset.status === 'inferred').querySelector('.k-rvview'));
}
// ================= R13 純粋データの表（4×4×scope） =================
{
  const { w } = boot();
  const T = w.KarteUI._t;
  const isAuto = (n) => n === 'ベンチプレス';
  const one = (status) => ({ v: 2, summary: [], exercises: [{ name: 'ベンチプレス', heard: '', note: '', sets: [{ status, w: status === 'healthHidden' ? null : 50, r: status === 'healthHidden' ? null : 10, evidence: 'e', unsure: '', note: '' }] }], condition: [], caution: [], coaching: [], hearing: [], next_actions: [], member_message: '', member_todo: [], unclear: [] });
  const WANT = { match: ['confirmed', 'edited'], inferred: ['confirmed', 'edited'], nobasis: ['confirmed', 'edited'], healthHidden: ['edited'] };
  const bad = [];
  for (const scope of ['trial', 'full']) for (const st of ['match', 'inferred', 'nobasis', 'healthHidden']) for (const res of ['unresolved', 'confirmed', 'edited', 'excluded']) {
    const rv = T.reviewFromDraft(one(st), isAuto, scope);
    const s = rv.exercises[0].sets[0];
    s.resolution = res;
    if (st === 'healthHidden') { s.w = '40'; s.r = '8'; }
    let out, threw = false;
    try { out = T.reviewBuild(rv, scope); } catch (e) { threw = String(e.message); }
    const allowed = T.scopeAllows('set:' + st, scope);
    const want = allowed ? WANT[st].indexOf(res) >= 0 : false;
    //   要確認が残る（unresolved で移せる行）・scope の外の採用・healthHidden の confirmed は投げる
    const wantThrow = (allowed && res === 'unresolved') || (!allowed && st !== 'match' && (res === 'confirmed' || res === 'edited')) || (st === 'healthHidden' && res === 'confirmed');
    const got = !threw && out.items.length && out.items[0].sets.length === 1;
    if (wantThrow ? !threw : (!!got !== want || threw)) bad.push([scope, st, res, threw, got]);
    if (got && st !== 'match' && out.items[0].sets[0].src !== st) bad.push(['src', scope, st, res]);
  }
  ok('R13 ★sourceStatus×resolution×scope の全組み合わせが §7-4 の表どおり（投げるもの・入るもの・src）', bad.length === 0, JSON.stringify(bad));
  //   種目名を選び直すと配下は match も含めて unresolved
  const rv = T.reviewFromDraft(Object.assign(one('match'), { exercises: [{ name: '未知の種目', heard: '', note: '', sets: [{ status: 'match', w: 50, r: 10, evidence: 'e', unsure: '', note: '' }] }] }), isAuto);
  ok('R13 一覧に無い種目は未決（要確認1）', rv.exercises[0].nameStatus === 'unresolved' && T.reviewOpen(rv, 'trial') === 1);
  ok('R13 scope の判定は1か所（trial は match・種目・備考・指導・ヒアリング・お客様の欄だけ）', ['set:match', 'exercise', 'exnote', 'setnote', 'coaching', 'hearing', 'member', 'todo'].every((k) => T.scopeAllows(k, 'trial')) && !['set:inferred', 'set:nobasis', 'set:healthHidden', 'summary', 'condition', 'next', 'unclear'].some((k) => T.scopeAllows(k, 'trial')) && T.aiScope() === 'trial');
  const rvT = T.reviewFromDraft(Object.assign(one('match'), { summary: ['架空の要約の文'] }), isAuto, 'trial');
  ok('R17 試用では要約の include は初期値で立たない', rvT.summary[0].include === false);
  rvT.summary[0].include = true;
  let thT = ''; try { T.reviewBuild(rvT, 'trial'); } catch (e) { thT = e.message; }
  ok('R17 ★試用で範囲外の項目（要約）の include を立てて渡すと投げる', thT === 'RV_SCOPE');
  const rvH = T.reviewFromDraft(Object.assign(one('match'), { coaching: ['膝が痛い'] }), isAuto, 'full');
  rvH.coaching[0].include = true;
  let th = ''; try { T.reviewBuild(rvH, 'full'); } catch (e) { th = e.message; }
  ok('R7 健康語の文を純粋データで入れようとすると投げる', th === 'RV_HEALTH');
}
// ================= full：確定・直す・出所の印・保存の payload =================
{
  const { w, sent } = boot({ src: FULL });
  await toReview(w);
  ok('R17 full：要約は初期値で入る（名前の印の文は外れる）・状態は入る・次回やることはまだ見るだけ（next_plan の線は次の段）', rows(w, 'summary')[0].querySelector('button.k-rvtog').getAttribute('aria-pressed') === 'true' && rows(w, 'summary')[1].querySelector('button.k-rvtog').getAttribute('aria-pressed') === 'false' && rows(w, 'condition')[0].querySelector('button.k-rvtog').getAttribute('aria-pressed') === 'true' && rows(w, 'next')[0].querySelector('.k-rvview'));
  const inf = () => setRows(w).find((x) => x.dataset.status === 'inferred');
  const nob = () => setRows(w).find((x) => x.dataset.status === 'nobasis');
  const hh = () => setRows(w).find((x) => x.dataset.status === 'healthHidden');
  ok('R5 ★根拠なしは数字が欄に入り、推論と文言・印・確定ボタンの文言で見分けられる', nob().querySelector('input').value === '60' && nob().textContent.includes('根拠なし（文字起こしに見つかりません）') && !!btn(nob(), '根拠なしのまま確定') && !!btn(inf(), 'この数字で確定') && inf().textContent.includes('要確認：推論'));
  ok('R18 healthHidden：欄が空・確定ボタンが無い', [...hh().querySelectorAll('input')].every((i) => i.value === '') && !btn(hh(), 'この数字で確定') && !btn(hh(), '根拠なしのまま確定'));
  await nameSkull(w);
  ok('R4 ★要確認が残る間は押せない（推論・根拠なし・健康の根拠の3件）', put(w).disabled && R(w).querySelector('.k-rvhead').textContent.includes('あと3件'), R(w).querySelector('.k-rvhead').textContent);
  btn(inf(), 'この数字で確定').click(); await settle();
  const ni = nob().querySelectorAll('input'); ni[1].value = '6'; ni[1].dispatchEvent(new w.Event('change')); await settle();
  const hi = hh().querySelectorAll('input'); hi[0].value = '40'; hi[0].dispatchEvent(new w.Event('change')); await settle();
  ok('R18 healthHidden は重さだけでは入らない（回数が要る）', put(w).disabled && hh().dataset.res === 'unresolved');
  const hi2 = hh().querySelectorAll('input'); hi2[1].value = '8'; hi2[1].dispatchEvent(new w.Event('change')); await settle();
  ok('R4 確定・直す・打つで要確認なし・押せる', !put(w).disabled && R(w).querySelector('.k-rvcount').textContent.includes('うち要確認から確定 3'), R(w).querySelector('.k-rvcount').textContent);
  put(w).click(); await nav();
  const D = draftOf(w);
  const b = D && D.items[0].sets;
  ok('R13 ★commit の後も記録の下書きのセットに出所の印が残る（推論の確定・根拠なしを直した・健康の根拠を打った）',
     b && JSON.stringify(b.map((s) => [s.w, s.r, s.src || null, !!s.srcEdited])) === '[["50","10",null,false],["50","8","inferred",false],["60","6","nobasis",true],["40","8","healthHidden",true]]', JSON.stringify(b));
  ok('R9 full：社内メモに要約（名前の印の文は除く）・状態', /今日の流れ：ベンチプレスを50キロで2セット行った/.test(D.memo) && !/初回の/.test(D.memo) && /状態：睡眠不足で疲れ気味/.test(D.memo), D.memo);
  ok('R19 ★記録の画面に保存する直前まで印が出る', R(w).querySelector('.k-aisrc-inferred') && R(w).querySelector('.k-aisrc-nobasis') && R(w).querySelector('.k-aisrc-healthHidden') && R(w).querySelector('.k-aisrc-nobasis').textContent.includes('根拠なしで確定（直した）'));
  //   セットを足す（直前のセットを複製）は印を持ち越さない
  const benchBlk = [...R(w).querySelectorAll('button.k-addset')][0];
  benchBlk.click(); await settle();
  const D2 = draftOf(w);
  ok('R19 ★「＋ セット」で足したセットは src を持ち越さない', D2.items[0].sets.length === 5 && !('src' in D2.items[0].sets[4]) && !('srcEdited' in D2.items[0].sets[4]), JSON.stringify(D2.items[0].sets[4]));
  ok('R19 buildPayload は src を送らない（純粋な部分）', JSON.stringify(w.KarteUI._t.buildPayload([{ exercise: 'ベンチプレス', sets: [{ w: '50', r: '8', done: true, src: 'inferred', srcEdited: true }] }])).indexOf('src') < 0);
  await saveAll(w);
  const add = sent.filter((x) => x.body.action === 'k_addTraining');
  ok('R19 ★保存の k_addTraining の payload に src・srcEdited が無い・数字は直した値', add.length === 1 && !JSON.stringify(add[0].body).includes('src') && JSON.stringify(add[0].body.items[0].sets.slice(0, 4).map((s) => [s.weight, s.reps])) === '[[50,10],[50,8],[60,6],[40,8]]', JSON.stringify(add.map((x) => x.body)).slice(0, 400));
}
// ================= R13 選び直し（DOM） =================
{
  const { w } = boot({ src: FULL });
  await toReview(w);
  await nameSkull(w);
  const c = exCard(w, 'スカルクラッシャー');
  btn(c, '種目名を選び直す').click(); await settle();
  const sk = exCard(w, 'スカルクラッシャー').querySelector('.k-rvset');
  ok('R13 ★種目名を選び直すと配下のセット（match も）が未確定に戻る', sk.dataset.res === 'unresolved' && put(w).disabled);
}
// ================= R16 画面の締切 =================
{
  const SHORT = SRC.replace('var AI_UI_TIMEOUT_MS = 110000;', 'var AI_UI_TIMEOUT_MS = 30;');
  const { w } = boot({ src: SHORT, cfg: { hang: true } });
  await openImport(w);
  const ta = paste(w, TRANSCRIPT);
  btn(R(w), 'AIで振り分ける').click();
  await new Promise((r) => setTimeout(r, 80)); await settle();
  ok('R16 ★画面の締切で1行の知らせ（番号の末尾4字つき）・貼った文字は残る・下書きは変わらない', R(w).textContent.includes('時間がかかりすぎました') && /番号 [A-Za-z0-9_-]{4}）/.test(R(w).textContent) && ta.value === TRANSCRIPT && (!draftOf(w) || !(draftOf(w).items || []).length), R(w).textContent.slice(0, 300));
  ok('R16 画面の締切（110秒）は Worker の締切（90秒）より長い', /var AI_UI_TIMEOUT_MS = 110000;/.test(SRC));
}
// ================= R10 v1 の応答は今の流れ =================
{
  const { w } = boot({ cfg: { draft: () => ({ v: 1, exercises: [{ name: 'ベンチプレス', heard: 'ベンチプレス', note: '', sets: [{ w: 20, r: 10, evidence: '20キロで10回', note: '' }], unverified: [] }], coaching: [], hearing: [], caution: [], member_message: '', member_todo: [] }) } });
  await toReview(w);
  ok('R10 v1 の応答は今のカード／計画の流れ（1画面の確認は出ない）', !R(w).querySelector('.k-rvhead') && (R(w).querySelector('.k-impsum') || {}).textContent.indexOf('AIの下書き') === 0);
}

console.log(`liff-karte-ai-review: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
