// 設計50 AI の振り分けの確認（1種目＝1行の文字・欄の文章・お客様の欄は既定オフ）：本番の liff/karte.js を jsdom で動かし、入口から通す・2026-11-23（設計49 の R0・R2・R10・R16 を残す）
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

// ================= T1〜T11 full（本番の値） =================
{
  const { w, sent } = boot({ src: FULL });
  await toReview(w);
  const s1 = sent.filter((x) => x.body.action === 'k_aiDraft');
  ok('T1 ★要求に client_ai_format:2 と clientReqId', s1.length === 1 && s1[0].body.client_ai_format === 2 && /^[A-Za-z0-9_-]{1,36}$/.test(s1[0].body.clientReqId));
  ok('T1 ★1種目＝1枚の1行・初期値が表どおり（一致・推測・根拠なし・健康は ?・回数不明は ×?・自重・重さ不明は ?×）', cards(w).length === 4 && lineOf(card(w, 'ベンチプレス')).value === '50×10  50×8  60×5  ?  40×?' && lineOf(card(w, 'スカルクラッシュ改')).value === '10×12' && lineOf(card(w, 'スクワット')).value === '自重×15' && lineOf(card(w, 'レッグプレス')).value === '?×8', cards(w).map((c) => lineOf(c) && lineOf(c).value).join(' | '));
  ok('T1 カード（.k-impcard）・上の帯（.k-rvhead）・1件ずつの確定ボタンが出ない', !R(w).querySelector('.k-impcard') && !R(w).querySelector('.k-rvhead') && !btn(R(w), 'この数字で確定') && !btn(R(w), '根拠なしのまま確定'));
  const bc = card(w, 'ベンチプレス');
  ok('T2 ★チップの色：一致・推測・根拠なし・入れない・入れない', JSON.stringify(chipsOf(bc)) === JSON.stringify(['match', 'inferred', 'nobasis', 'skip', 'skip']), JSON.stringify(chipsOf(bc)));
  const hhChip = bc.querySelectorAll('.k-rvchip')[3];
  ok('T2 ★健康の根拠のセットは「体の話を含むため数字を出していません」だけ（健康の語・数字を出さない）', hhChip.textContent.includes('体の話を含むため') && !/痛|kg|\d+×/.test(hhChip.textContent.replace(/^\d+\. /, '')), hhChip.textContent);
  ok('T2 根拠を見る：根拠なしは「見つかりません」・回数不明の推測は「数字が読み取れません」・健康は固定文だけ', /根拠が文字起こしに見つかりません/.test(bc.querySelector('.k-rvev').textContent) && /数字が読み取れません/.test(bc.querySelector('.k-rvev').textContent) && bc.querySelector('.k-rvev').textContent.includes('健康の情報を含む根拠だったため'));
  ok('T7 欄の初期値が AI の各リスト（1行1項目）・「お客様」を含む行も入っている', field(w, 'flow').value === 'ベンチプレスを50キロから始めた\nスクワットを自重で行った' && field(w, 'coaching').value.split('\n')[0] === 'お客様の肘を張りすぎない' && field(w, 'next').value === '次回はベンチプレスを52.5キロで' && !field(w, 'flow').hasAttribute('readonly'));
  ok('T8 ★お客様の画面に出すチェックは既定オフ', R(w).querySelector('.k-rvmemon').checked === false);
  ok('T9 体のこと・AI が分からなかった点は読むだけ（ボタン・入力が無い）', !!R(w).querySelector('.k-rvcau') && !R(w).querySelector('.k-rvcau').querySelector('button,input,textarea') && !!R(w).querySelector('.k-rvunclear') && !R(w).querySelector('.k-rvunclear').querySelector('button,input,textarea'));
  ok('N1 ★一覧に無い種目（架空のスカルクラッシュ改）があっても押せる（設計52：止めない）・部位は推定のチップ・帯に理由が出ない', !put(w).disabled && card(w, 'スカルクラッシュ改').querySelector('.k-rvpart').textContent.includes('（推定）') && !why(w).includes('一覧に無い'), why(w));
  ok('T5 下の帯の件数（推測・根拠なしを含むと出す）', foot(w).includes('セット 5') && foot(w).includes('推測 1・根拠なし 1 を含む') && foot(w).includes('「?」で入れない 3'), foot(w));
  await pickPart(w, 'スカルクラッシュ改', '腕');
  ok('T6 部位を選ぶと押せる', !put(w).disabled, why(w));
  //   T5 打つたびに描き直すのはチップと帯だけ（入力中の欄は同じ要素のまま・フォーカスが残る）
  const li = lineOf(card(w, 'ベンチプレス'));
  li.focus();
  type(w, li, '50×10  50×8  60×  ?  40×?');
  ok('T4 ★読めない書き方（60×）で押せない・場所を出す・チップが「書き方？」', put(w).disabled && why(w).includes('書き方が読めない所が1か所') && why(w).includes('ベンチプレス 3つ目') && chipsOf(card(w, 'ベンチプレス'))[2] === 'bad', why(w));
  ok('T5 ★入力中の欄は作り直されない（同じ要素・フォーカスが残る）', li.isConnected && w.document.activeElement === li);
  type(w, li, '50×10  50×8  60×6  20×10  40×?  45 kg×6');
  ok('T3 ★値を直したセットは「直した」・照合が一意なセットは元の色', JSON.stringify(chipsOf(card(w, 'ベンチプレス'))) === JSON.stringify(['match', 'inferred', 'edited', 'edited', 'skip', 'edited']), JSON.stringify(chipsOf(card(w, 'ベンチプレス'))));
  ok('T4 「45 kg×6」（空白と単位）も読める（memoSets）', !put(w).disabled && foot(w).includes('セット 7（推測 1・根拠なし 0 を含む）'), foot(w) + why(w));
  //   欄・お客様の欄
  type(w, field(w, 'hearing'), '睡眠は5時間くらい\n膝に痛みがある');
  ok('T7 ★欄に体のことの言葉の行を打つと押せない（どの欄かを出す）', put(w).disabled && why(w).includes('体のことの言葉') && why(w).includes('ヒアリング'), why(w));
  type(w, field(w, 'hearing'), '睡眠は5時間くらい\n');
  const li2 = lineOf(card(w, 'ベンチプレス')), keep = li2.value;
  type(w, li2, keep + '  ?痛み');
  ok('T7 ★セットの行に ? と一緒に体のことの言葉を書くと「読めない」・体のことの言葉として押せない（関門② 4）', put(w).disabled && why(w).includes('書き方が読めない') && why(w).includes('ベンチプレスのセットの行'), why(w));
  type(w, li2, keep);
  type(w, R(w).querySelector('.k-rvmsg'), 'オフのまま直した文');
  R(w).querySelector('.k-rvmemon').click(); await settle();
  type(w, R(w).querySelector('.k-rvmsg'), 'あ'.repeat(401));
  ok('T8 ★オンでお客様へ401字は押せない', put(w).disabled && why(w).includes('400字'), why(w));
  type(w, R(w).querySelector('.k-rvmsg'), 'フォームが安定してきました。');
  type(w, R(w).querySelector('.k-rvtodo'), 'a\nb\nc\nd');
  ok('T8 次回までに4行は押せない', put(w).disabled);
  type(w, R(w).querySelector('.k-rvtodo'), 'い'.repeat(61));
  ok('T8 次回までに61字は押せない', put(w).disabled);
  type(w, R(w).querySelector('.k-rvtodo'), 'ストレッチ 2分');
  R(w).querySelector('.k-rvmemon').click(); await settle();
  ok('T8 ★チェックを外すと押せる（中身は残るが入らない）', !put(w).disabled && R(w).querySelector('.k-rvmemon').checked === false);
  ok('T11 確かめのダイアログ・alert が増えていない', w.confirms === 0 && w.alerts.length === 0, JSON.stringify(w.alerts));
  ok('T11 押す所は44px以上（最後のボタン52・1行48・外す44）', /min-height:\s*52px/.test(put(w).style.cssText) && /min-height:\s*48px/.test(lineOf(card(w, 'ベンチプレス')).style.cssText) && /min-height:\s*44px/.test(card(w, 'ベンチプレス').querySelector('.k-rvoff').style.cssText));
  ok('T2 ★押すまで記録の下書き・保存領域に何も入らない・console に原文が無い', (!draftOf(w) || !(draftOf(w).items || []).length) && !storeText(w.localStorage).includes(SECRET) && !storeText(w.sessionStorage).includes(SECRET) && !w.logs.join('\n').includes(SECRET));
  put(w).click(); await nav();
  const D = draftOf(w);
  const sets = (n) => { const it = D && D.items.find((x) => x.exercise === n); return it ? it.sets.map((s) => [s.w, s.r, s.src || null, !!s.srcEdited]) : null; };
  ok('T3 ★記録の下書き：ベンチは直した値・元の色のセットは今と同じ出所・「直した」は根拠なしの警告（その種目の最も強い警告）を残す・? は入らない',
     JSON.stringify(sets('ベンチプレス')) === JSON.stringify([['50', '10', null, false], ['50', '8', 'inferred', false], ['60', '6', 'nobasis', true], ['20', '10', 'nobasis', true], ['45', '6', 'nobasis', true]]), JSON.stringify(sets('ベンチプレス')));
  ok('T3 自重は w が空（I61）・重さ不明だけの種目はセットなしで入る・部位を選んだ種目は regPart', JSON.stringify(sets('スクワット')) === JSON.stringify([['', '15', null, false]]) && JSON.stringify(sets('レッグプレス')) === '[]' && D.items.find((x) => x.exercise === 'スカルクラッシュ改').regPart === 'arm', JSON.stringify(D.items));
  ok('T10 ★下書きのセットの ✓ は全部 false（I57）', D.items.every((it) => it.sets.every((s) => s.done === false)));
  ok('T7 ★社内メモ：今日の流れ・種目のメモ（セットのメモをまとめた行も）・状態・指導（お客様を含む）・ヒアリング・次回やること',
     /今日の流れ：ベンチプレスを50キロから始めた スクワットを自重で行った/.test(D.memo) && /ベンチプレス：肩甲骨を寄せる/.test(D.memo) && /ベンチプレス：1セット目：フォーム良い/.test(D.memo) && /状態：睡眠不足で疲れ気味/.test(D.memo) && /\nお客様の肘を張りすぎない/.test(D.memo) && /ヒアリング：睡眠は5時間くらい/.test(D.memo) && /次回やること：次回はベンチプレスを52\.5キロで/.test(D.memo), D.memo);
  ok('T8 ★チェックがオフ＝お客様の欄は下書きに入らない（直した文も）', !(D.member && (D.member.message || (D.member.todo || []).some((t) => t))) && !storeText(w.localStorage).includes('オフのまま直した文'), JSON.stringify(D.member));
  ok('T9 ★下書き・保存領域に体のこと・分からなかった点・根拠・迷った理由が無い', !storeText(w.localStorage).includes('膝が少し痛い') && !storeText(w.localStorage).includes('予告か実施か') && !storeText(w.localStorage).includes(EVID) && !storeText(w.localStorage).includes('予告かもしれない') && !storeText(w.localStorage).includes('60キロで5回'));
  ok('T10 ★記録の画面に保存する直前まで印（推・根拠なしで確定（直した））', !!R(w).querySelector('.k-aisrc-inferred') && [...R(w).querySelectorAll('.k-aisrc-nobasis')].some((x) => x.textContent.includes('根拠なしで確定（直した）')));
  await saveAll(w);
  const add = sent.filter((x) => x.body.action === 'k_addTraining');
  ok('T10 ★保存の k_addTraining の payload に src・srcEdited・srcRenamed が無い・数字は直した値', add.length === 1 && !/src/.test(JSON.stringify(add[0].body)) && JSON.stringify(add[0].body.items.find((x) => x.exercise === 'ベンチプレス').sets.map((s) => [s.weight, s.reps])) === '[[50,10],[50,8],[60,6],[20,10],[45,6]]', JSON.stringify(add.map((x) => x.body)).slice(0, 500));
}
// ================= T8 オンにすれば入る =================
{
  const { w } = boot({ src: FULL });
  await toReview(w);
  await pickPart(w, 'スカルクラッシュ改', '腕');
  R(w).querySelector('.k-rvmemon').click(); await settle();
  put(w).click(); await nav();
  const D = draftOf(w);
  ok('T8 ★チェックをオンにしたときだけお客様へ・次回までにが入る', D.member && D.member.message === 'フォームが安定してきました。' && (D.member.todo || []).includes('ストレッチ 2分'), JSON.stringify(D.member));
}
// ================= T6 種目名（変えた・空・健康語・足した種目） =================
{
  const { w } = boot({ src: FULL });
  await toReview(w);
  await pickPart(w, 'スカルクラッシュ改', '腕');
  type(w, card(w, 'スカルクラッシュ改').querySelector('.k-rvname'), 'スカル');
  ok('N2 部位を選んだ後に名前を変えると、部位は推定に戻る（押せるまま）', !put(w).disabled && card(w, 'スカル').querySelector('.k-rvpart').textContent.includes('（推定）'), why(w));
  type(w, cards(w)[1].querySelector('.k-rvname'), 'アームカール');
  ok('T6 ★一覧の名前に変えると押せる・その種目のセットは「直した（種目名を変更）」・帯に「種目名を変えた 1」', !put(w).disabled && JSON.stringify(chipsOf(cards(w)[1])) === '["renamed"]' && foot(w).includes('種目名を変えた 1'), foot(w) + JSON.stringify(chipsOf(cards(w)[1])));
  btn(R(w), '＋ 種目を足す').click(); await settle();
  ok('T6 足して何も書かない種目は無視（押せる）', !put(w).disabled, why(w));
  type(w, lineOf(cards(w)[4]), '20×10');
  ok('T6 ★名前が空でセットがある種目は押せない', put(w).disabled && why(w).includes('種目名が空'), why(w));
  type(w, cards(w)[4].querySelector('.k-rvname'), '膝痛スクワット');
  ok('T6 ★名前に体のことの言葉で押せない', put(w).disabled && why(w).includes('種目名'), why(w));
  type(w, cards(w)[4].querySelector('.k-rvname'), 'チェストプレス');
  card(w, 'ベンチプレス').querySelector('.k-rvoff').click(); await settle();
  ok('T6 外した種目は薄く・1行が出ない・戻すボタン', !lineOf(card(w, 'ベンチプレス')) && card(w, 'ベンチプレス').querySelector('.k-rvoff').textContent === '戻す');
  put(w).click(); await nav();
  const D = draftOf(w);
  const arm = D && D.items.find((x) => x.exercise === 'アームカール');
  const chest = D && D.items.find((x) => x.exercise === 'チェストプレス');
  ok('T6 ★種目名を変えた種目のセットに srcRenamed（記録の画面まで）・足した種目のセットは出所なし・外した種目は入らない', arm && arm.sets[0].srcRenamed === true && !arm.sets[0].src && chest && JSON.stringify(chest.sets.map((s) => [s.w, s.r, s.src || null])) === '[["20","10",null]]' && !D.items.some((x) => x.exercise === 'ベンチプレス'), JSON.stringify(D && D.items));
  ok('T6 記録の画面に「種目名を変更」の印', [...R(w).querySelectorAll('.k-aisrc-renamed')].some((x) => x.textContent.includes('（種目名を変更）')));
}
// ================= T12 試用（trial）・不正な値 =================
for (const [label, src] of [['trial', SRC], ['不正な値（Full）', BOGUS]]) {
  const { w } = boot({ src });
  await toReview(w);
  ok('T12 ★' + label + '：推測・根拠なしの数字は初期値に入れない（?）・今日の流れ・状態・次回やることは readonly', lineOf(card(w, 'ベンチプレス')).value === '50×10  ?  ?  ?  ?' && ['flow', 'condition', 'next'].every((k) => field(w, k).hasAttribute('readonly')) && !field(w, 'coaching').hasAttribute('readonly'), lineOf(card(w, 'ベンチプレス')).value);
  if (label !== 'trial') continue;
  await pickPart(w, 'スカルクラッシュ改', '腕');
  put(w).click(); await nav();
  const D = draftOf(w);
  ok('T12 ★試用：社内メモに今日の流れ・状態・次回やることが入らない・指導とヒアリングは入る', D && !/今日の流れ|状態：|次回やること：/.test(D.memo) && /肘を張りすぎない/.test(D.memo) && /ヒアリング：/.test(D.memo), D && D.memo);
}
// ================= 純粋データ：1行の読み方・LCS の照合・reviewBuild の守り =================
{
  const { w } = boot({ src: FULL });
  const T = w.KarteUI._t;
  const P = (s) => T.rvParseLine(s).map((k) => k.kind === 'set' ? [k.kind, k.set.w, k.set.r, (k.set.drops || []).length, !!k.set.forced] : [k.kind]);
  const table = [
    ['20×5', [['set', '20', '5', 0, false]]], ['50x10', [['set', '50', '10', 0, false]]], ['自重×10', [['set', '', '10', 0, false]]], ['×10', [['set', '', '10', 0, false]]],
    ['50 × 10', [['set', '50', '10', 0, false]]], ['50 kg×10', [['set', '50', '10', 0, false]]], ['50 かける 10', [['set', '50', '10', 0, false]]], ['2.5×12', [['set', '2.5', '12', 0, false]]],
    ['55×5+40×8', [['set', '55', '5', 1, false]]], ['50×10(できない)', [['set', '50', '10', 0, true]]],
    ['20×?  30×5', [['skip'], ['set', '30', '5', 0, false]]], ['? × 5  30×5', [['skip'], ['set', '30', '5', 0, false]]], ['60×  ?', [['bad'], ['skip']]], ['55 × 5 + 40 × 8', [['set', '55', '5', 1, false]]], ['?', [['skip']]], ['自重×?', [['skip']]],
    ['50×10(左)', [['bad']]], ['?痛み 20×5', [['bad'], ['set', '20', '5', 0, false]]], ['?abc', [['bad']]], ['?×?', [['skip']]], ['20kg×?', [['skip']]], ['?×8', [['skip']]], ['?? 20×5', [['bad'], ['set', '20', '5', 0, false]]], ['600×5', [['bad']]], ['50×0', [['bad']]], ['50×', [['bad']]], ['abc 20×5', [['bad'], ['set', '20', '5', 0, false]]],
    ['55×5、50×5', [['set', '55', '5', 0, false], ['set', '50', '5', 0, false]]], ['10+10+10+10+10×5', [['bad']]], ['', []],
  ];
  const badP = table.filter(([s, want]) => JSON.stringify(P(s)) !== JSON.stringify(want)).map(([s, want]) => s + ' → ' + JSON.stringify(P(s)) + '（期待 ' + JSON.stringify(want) + '）');
  ok('T4 ★1行の読み方の表（memoSets・? は入れない・読めない）' + table.length + '行', badP.length === 0, badP.join('\n   '));
  //   S-H3：値の並びの照合（消す・並べ替え・途中に足す）
  const ex = (orig, line, extra) => Object.assign({ id: 'e0', name: 'ベンチプレス', name0: 'ベンチプレス', heard: '', off: false, part: null, partFor: null, orig: orig.map(([status, wv, r]) => ({ status, w: wv, r, bw: false, evidence: '', unsure: '', note: '' })), line, note: '' }, extra || {});
  const C = (e) => T.rvTokens(e, 'full').filter((k) => k.kind === 'set').map((k) => [k.st, k.src || null, !!k.srcEdited]);
  const J = JSON.stringify;
  ok('T3 ★S-H3 消す：一致と根拠なしが同じ値で1つ消すと、どちらか決まらない＝「直した」・根拠なしの警告（一致に昇格しない）', J(C(ex([['match', 50, 10], ['nobasis', 50, 10]], '50×10'))) === J([['edited', 'nobasis', true]]), J(C(ex([['match', 50, 10], ['nobasis', 50, 10]], '50×10'))));
  ok('T3 ★S-H3 並べ替え：対応が一意でない＝両方「直した」', J(C(ex([['match', 50, 10], ['nobasis', 60, 5]], '60×5  50×10'))) === J([['edited', 'nobasis', true], ['edited', 'nobasis', true]]), J(C(ex([['match', 50, 10], ['nobasis', 60, 5]], '60×5  50×10'))));
  ok('T3 ★S-H3 途中に足す：前後は元の色・足した値は「直した」（推測の警告）', J(C(ex([['match', 50, 10], ['inferred', 55, 5]], '50×10  52×5  55×5'))) === J([['match', null, false], ['edited', 'inferred', true], ['inferred', 'inferred', false]]), J(C(ex([['match', 50, 10], ['inferred', 55, 5]], '50×10  52×5  55×5'))));
  ok('T3 ★S-H3 一致を消しても根拠なしは根拠なしのまま（一意に対応）', J(C(ex([['match', 50, 10], ['nobasis', 60, 5]], '60×5'))) === J([['nobasis', 'nobasis', false]]));
  ok('T3 同じ値の繰り返し（55×5 ×2）を全部残せば両方元の色', J(C(ex([['inferred', 55, 5], ['inferred', 55, 5]], '55×5  55×5'))) === J([['inferred', 'inferred', false], ['inferred', 'inferred', false]]));
  ok('T3 ドロップを足したセットは元と照合しない＝「直した」', J(C(ex([['match', 50, 10]], '50×10+40×8'))) === J([['edited', null, false]]));
  const rn = T.rvTokens(ex([['match', 50, 10]], '50×10', { name: 'チェストプレス' }), 'full').filter((k) => k.kind === 'set')[0];
  ok('T6 ★S-H5 種目名を変えた種目は一致でも「直した（種目名を変更）」・srcRenamed', rn.st === 'renamed' && rn.srcRenamed === true && !rn.src);
  //   reviewBuild の守り
  const isAuto = (n) => ['ベンチプレス', 'チェストプレス', 'スクワット', 'レッグプレス'].indexOf(n) >= 0;
  const D0 = () => T.reviewFromDraft(DRAFT(), isAuto, 'full');
  const th = (rv) => { try { T.reviewBuild(rv, 'full', isAuto); return ''; } catch (e) { return e.message; } };
  const rvA = D0(); rvA.exercises[1].off = true;
  ok('T6 一覧に無い種目を外すと組み立てられる', th(rvA) === '', th(rvA));
  const rvB = D0(); rvB.exercises[1].off = true; rvB.exercises[0].line = '50×';
  ok('T4 ★読めない書き方を純粋データで渡すと投げる（RV_OPEN）', th(rvB) === 'RV_OPEN');
  const rvC = D0(); rvC.exercises[1].off = true; rvC.fields.coaching = '膝が痛い';
  ok('T7 ★体のことの言葉の行を純粋データで渡すと投げる（RV_HEALTH）', th(rvC) === 'RV_HEALTH');
  const rvD = D0(); rvD.exercises[1].off = true; rvD.member.on = 'yes';
  const bD = T.reviewBuild(rvD, 'full', isAuto);
  ok('T8 ★member.on が厳密に true でなければお客様の欄は入らない', bD.members.length === 0 && bD.todos.length === 0);
  const rvE = D0(); rvE.exercises[1].off = true;
  const bE = T.reviewBuild(rvE, 'full', isAuto);
  ok('T10 出力の形は設計49 と同じ（items・memos・nNote・nSet・blocked・members・todos・memoMax）', JSON.stringify(Object.keys(bE)) === JSON.stringify(['items', 'memos', 'nNote', 'nSet', 'blocked', 'members', 'todos', 'memoMax']) && bE.memoMax === 2000);
  ok('T9 組み立てた中身に根拠・迷った理由・体のこと・分からなかった点・聞こえた言葉が無い', !/60キロで5回|予告かもしれない|膝が少し痛い|予告か実施か|スカルフラッシュ/.test(JSON.stringify(bE)), JSON.stringify(bE).slice(0, 300));
  ok('T12 scope の判定は1か所：next は full だけ', T.scopeAllows('next', 'full') && !T.scopeAllows('next', 'trial'));
}
// ================= R0 本番の値 =================
ok('R0 ★liff/karte.js の AI_V2_SAVE_SCOPE は \'full\' が1行だけ（D8 の後・決定0195）', SCOPE_LINES.length === 1 && SCOPE_LINES[0].trim() === "var AI_V2_SAVE_SCOPE = 'full';", JSON.stringify(SCOPE_LINES));
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
