// 設計52 種目名で止めない（推定の部位・もしかして）＋固定の種目の一覧（85種目・別名）：本番の liff/karte.js を jsdom で動かす・2026-11-23
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
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'https://reservation.tokowaka-gym.com/liff/', pretendToBeVisual: true }); dom.window.__KARTE_REST_UI = true;   // 休憩タイマーは画面では一旦出さない（2026-11-25）。検査では動きを守り続ける
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
    else if (body.action === 'k_exercises') r = { success: true, karteSchema: 33, exercises: c.exercises || [{ name: 'ベンチプレス', part: 'chest' }], truncated: false };
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

const EXERCISE_NAMES = ["ベンチプレス", "インクラインベンチプレス", "デクラインベンチプレス", "スミスマシンベンチプレス", "ダンベルプレス", "インクラインダンベルプレス", "チェストプレス", "ダンベルフライ", "ペックフライ", "ケーブルクロスオーバー", "腕立て伏せ", "ディップス", "ラットプルダウン", "懸垂", "アシストプルアップ", "シーテッドロウ", "ケーブルロウ", "ベントオーバーロウ", "ワンハンドロウ", "Tバーロウ", "バックエクステンション", "プルオーバー", "ストレートアームプルダウン", "シュラッグ", "スクワット", "ゴブレットスクワット", "スミスマシンスクワット", "フロントスクワット", "ブルガリアンスクワット", "ランジ", "ウォーキングランジ", "ステップアップ", "レッグプレス", "レッグエクステンション", "レッグカール", "ヒップスラスト", "ヒップリフト", "デッドリフト", "ルーマニアンデッドリフト", "スティッフレッグデッドリフト", "アダクション", "アブダクション", "カーフレイズ", "ショルダープレス", "ダンベルショルダープレス", "アーノルドプレス", "サイドレイズ", "ケーブルサイドレイズ", "フロントレイズ", "リアレイズ", "リアデルトフライ", "アップライトロウ", "フェイスプル", "アームカール", "ダンベルカール", "ハンマーカール", "インクラインカール", "プリーチャーカール", "ケーブルカール", "トライセプスプレスダウン", "スカルクラッシャー", "オーバーヘッドエクステンション", "キックバック", "ナローベンチプレス", "リストカール", "プランク", "サイドプランク", "クランチ", "シットアップ", "ケーブルクランチ", "バイシクルクランチ", "レッグレイズ", "ハンギングレッグレイズ", "アブローラー", "ロシアンツイスト", "ドローイン", "デッドバグ", "バードドッグ", "マウンテンクライマー", "バーピー", "ケトルベルスイング", "エアロバイク", "トレッドミル", "ストレッチ", "縄跳び"];
const draftWith = (exs) => () => Object.assign(DRAFT(), { exercises: exs });
const one = (name, st = 'match') => ({ name, heard: name, note: '', sets: [{ status: st, w: 20, r: 10, bw: false, evidence: '20キロで10回の架空の根拠', unsure: '', note: '' }] });

// ---------- N1・N2 一覧に無い名前でも止めない（推定の部位・その他） ----------
{
  const { w } = boot({ src: FULL, cfg: { draft: draftWith([one('スカルクラッシュ改'), one('ピストルスクワット'), one('ベンチプレス')]) } });
  await toReview(w);
  ok('N1 ★一覧に無い名前が2つあっても押せる・帯に「一覧に無い」の理由が無い', !put(w).disabled && !why(w).includes('一覧に無い'), why(w));
  const pc = (n) => card(w, n).querySelector('.k-rvpart');
  ok('N1 部位のチップは推定（ピストルスクワット＝脚・尻・推定）／推定が other でも「その他（推定）」で止めない', pc('ピストルスクワット').textContent.startsWith('脚・尻（推定）') && pc('スカルクラッシュ改').textContent.startsWith('その他（推定）') && /min-height:\s*44px/.test(pc('スカルクラッシュ改').style.cssText));
  ok('N1 7つの部位はタップしたときだけ並ぶ（画面を長くしない）', card(w, 'スカルクラッシュ改').querySelectorAll('button.k-pill[role="radio"]').length === 0);
  pc('スカルクラッシュ改').click(); await settle();
  [...card(w, 'スカルクラッシュ改').querySelectorAll('button.k-pill[role="radio"]')].find((x) => x.textContent === '腕').click(); await settle();
  ok('N2 部位を選ぶと推定が外れる', pc('スカルクラッシュ改').textContent.startsWith('腕 '), pc('スカルクラッシュ改').textContent);
  put(w).click(); await nav();
  const D = draftOf(w);
  const rp = (n) => (D.items.find((x) => x.exercise === n) || {}).regPart;
  ok('N1 ★入れた下書き：選んだ部位（腕）・推定の部位（脚・尻）を regPart に・一覧の種目には無い', rp('スカルクラッシュ改') === 'arm' && rp('ピストルスクワット') === 'legs' && rp('ベンチプレス') === undefined, JSON.stringify(D.items.map((x) => [x.exercise, x.regPart])));
  ok('N1 記録の画面に登録の欄（任意・開いている種目の分）が出る', R(w).querySelectorAll('.k-exunreg').length >= 1, String(R(w).querySelectorAll('.k-exunreg').length));
}
// ---------- N11 名前らしい印の名前は登録の欄を出さない（関門① 4） ----------
{
  const { w } = boot({ src: FULL, cfg: { draft: draftWith([one('初回メニュー'), one('ベンチプレス')]) } });
  await toReview(w);
  ok('N11 名前らしい印（初回）の名前でも記録は止めない', !put(w).disabled);
  put(w).click(); await nav();
  const D = draftOf(w);
  const it = D.items.find((x) => x.exercise === '初回メニュー');
  ok('N11 ★名前らしい印の名前は regPart を付けない・記録の画面に登録の欄が出ない', it && it.regPart === undefined && !R(w).querySelector('.k-exunreg'), JSON.stringify(it));
}
{
  //   記録の画面の守り：下書きに regPart があっても名前らしい印なら欄を出さない
  const { w } = boot({ src: FULL });
  w.localStorage.setItem(DKEY, JSON.stringify({ v: 1, tid: 'T1', cid: 'C1', sessionDate: new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10), items: [{ exercise: '〇〇さんの種目', sets: [{ w: '20', r: '10', done: false }], regPart: 'other' }], reqId: 'kx1', pending: null, at: Date.now() }));
  w.KarteUI.open('C1', '会員', 'training'); await settle();
  const b0 = btn(R(w), '記録の入力（途中）を開く') || btn(R(w), '＋ 今日の記録'); if (b0) { b0.click(); await settle(); }
  ok('N11 ★記録の画面：名前らしい印の名前は regPart があっても登録の欄を出さない', R(w).textContent.includes('〇〇さんの種目') && !R(w).querySelector('.k-exunreg'));
}
// ---------- N3 別名は完全一致だけ正式名へ（印は付かない＝S-H5 の明示の例外） ----------
{
  const { w, sent } = boot({ src: FULL, cfg: { draft: draftWith([one('ラットプル'), one('ラットプルX'), one('ベンチ')]) } });
  await toReview(w);
  ok('N3 ★別名「ラットプル」は正式名「ラットプルダウン」に置き換わり、チップは元の色（種目名を変えた印なし）', !!card(w, 'ラットプルダウン') && JSON.stringify(chipsOf(card(w, 'ラットプルダウン'))) === '["match"]' && !card(w, 'ラットプルダウン').querySelector('.k-rvrenamed'));
  ok('N3 ★別名でない似た名前（ラットプルX）・広い語（ベンチ）は置き換わらない（もしかしてだけ）', !!card(w, 'ラットプルX') && !!card(w, 'ベンチ') && !!card(w, 'ベンチ').querySelector('.k-rvsugg'));
  const kn = sent.find((x) => x.body.action === 'k_aiDraft').body.known;
  ok('N8 ★AI に送る一覧に表の正式名（85）が入り、別名・広い語は入らない', EXERCISE_NAMES.every((n) => kn.includes(n)) && !kn.includes('ラットプル') && !kn.includes('ベンチ') && !kn.includes('フライ'), String(kn.length));
}
// ---------- N4 もしかして（入力した名前 → 正式名・最大2件・初期選択なし・置き換えたら印） ----------
{
  const { w } = boot({ src: FULL, cfg: { draft: draftWith([one('サイトレイズ'), one('フライ')]) } });
  await toReview(w);
  const sg = (n) => [...card(w, n).querySelectorAll('.k-rvsugg')];
  ok('N4 ★「サイトレイズ → サイドレイズ」（1件・畳んだ鍵の段・当たった語が見える）', sg('サイトレイズ').length === 1 && sg('サイトレイズ')[0].textContent === 'サイトレイズ → サイドレイズ' && sg('サイトレイズ')[0].dataset.via === 'サイドレイズ' && sg('サイトレイズ')[0].dataset.tier === '2' && /min-height:\s*44px/.test(sg('サイトレイズ')[0].style.cssText));
  ok('N4 ★広い語「フライ」は2件が同じ強さで並ぶ・初期選択なし', JSON.stringify(sg('フライ').map((b) => b.dataset.name)) === '["ダンベルフライ","ペックフライ"]' && sg('フライ').every((b) => b.className.includes('out') && !b.className.includes(' on')));
  sg('サイトレイズ')[0].click(); await settle();
  ok('N4 ★1タップで置き換え・置き換えた種目は「直した（種目名を変更）」（S-H5 を弱めない）', !!card(w, 'サイドレイズ') && JSON.stringify(chipsOf(card(w, 'サイドレイズ'))) === '["renamed"]' && !card(w, 'サイドレイズ').querySelector('.k-rvsugg'));
}
// ---------- N5 もしかしての出し方を固定（付録の85種目の全体・スナップショット） ----------
{
  const { w } = boot({ src: FULL });
  const T = w.KarteUI._t;
  const SNAP = [
    ['ベンチ', [['ベンチプレス', 'ベンチ', 1]]], ['フライ', [['ダンベルフライ', 'フライ', 1], ['ペックフライ', 'フライ', 1]]], ['腹筋', [['シットアップ', '腹筋', 1], ['クランチ', '腹筋', 1]]],
    ['サイトレイズ', [['サイドレイズ', 'サイドレイズ', 2]]], ['らっとぷるだうん', [['ラットプルダウン', 'ラットプルダウン', 1]]], ['ベンチプレス', []], ['レッグプレツ', [['レッグプレス', 'レッグプレス', 3]]],
    ['スクワツト', [['スクワット', 'スクワット', 2]]], ['カール', []], ['プレス', []], ['スカルクラッシュ改', []], ['ケトルベル', [['ケトルベルスイング', 'ケトルベル', 1]]], ['バイク', [['エアロバイク', 'バイク', 1]]],
    ['ラットプルX', [['ラットプルダウン', 'ラットプル', 3]]], ['ショルダープレツ', [['ショルダープレス', 'ショルダープレス', 3]]], ['アームカー', []], ['チンニンク', [['懸垂', 'チンニング', 2]]],
    ['リアデルト', [['リアデルトフライ', 'リアデルト', 1], ['リアレイズ', 'リアデルト', 1]]], ['', []],
  ];
  const badS = SNAP.filter(([n, want]) => JSON.stringify(T.exSuggest(n, []).map((c) => [c.name, c.via, c.tier])) !== JSON.stringify(want)).map(([n]) => n + ' → ' + JSON.stringify(T.exSuggest(n, []).map((c) => [c.name, c.via, c.tier])));
  ok('N5 ★もしかしての候補の集まりが固定どおり（' + SNAP.length + '件）', badS.length === 0, badS.join('\n   '));
  ok('N5 ★同じ段で正式名が3つ以上なら出さない（迷わせない）', JSON.stringify(T.exSuggest('テストA', ['テストa', 'てすとA', 'テスト Ａ'])) === '[]', JSON.stringify(T.exSuggest('テストA', ['テストa', 'てすとA', 'テスト Ａ'])));
  ok('N5 同じ段で2つまでなら出す', T.exSuggest('テストA', ['テストa', 'てすとA']).length === 2);
  ok('N5 共有の一覧の名前も候補の元になる', JSON.stringify(T.exSuggest('ケーブルスカルクラッシュ', ['ケーブルスカルクラッシャ']).map((c) => c.name)) === '["ケーブルスカルクラッシャ"]');
  //   N6 表
  const TB = T.EXERCISE_TABLE, names = TB.map((r) => r[0]), aliases = TB.flatMap((r) => r[2]);
  const OLD12 = ['ベンチプレス', 'チェストプレス', 'スクワット', 'レッグプレス', 'ヒップスラスト', 'デッドリフト', 'ラットプルダウン', 'シーテッドロウ', 'ショルダープレス', 'サイドレイズ', 'アームカール', 'プランク'];
  const FORBID = ['ベンチ', 'フライ', '腹筋', 'ケトルベル', 'バイク', '背筋', '内転', '外転', 'リアデルト', 'プレス', 'カール', 'ロウ', 'ロー', 'レイズ', 'スクワット', 'ランジ', 'マシン', 'ダンベル', 'バーベル', 'ケーブル', 'エクステンション', 'プルダウン', 'プレスダウン', 'インクラインダンベル', 'ブルガリアン', 'ルーマニアン', 'ゴブレット', 'スティッフレッグ', 'ストレートアーム', 'ストレッチ', '筋トレ', '有酸素'];
  const PII = /様|さん|氏|くん|君|ちゃん|回目|初回|体験/;
  const HEALTH = /痛|痺|しびれ|怪我|ケガ|けが|診断|薬|手術|違和感|腫|骨折|捻|ヘルニア|病院|通院|体調|血圧|めまい|熱|妊娠|アレルギー|生理|持病|リハビリ|吐き気|頭痛|不調|医師|医者|治療|炎症|つった|つる/;
  ok('N6 ★表は85種目・今の12種目の名前が1字も変わらず全部ある', TB.length === 85 && OLD12.every((n) => names.includes(n)));
  ok('N6 ★正式名・別名は重ならない（正式名どうし・別名どうし・正式名と別名）', new Set(names).size === names.length && new Set(aliases).size === aliases.length && !aliases.some((a) => names.includes(a)));
  ok('N10 ★表の別名に広い語（禁止リスト）が無い', !aliases.some((a) => FORBID.includes(a)), aliases.filter((a) => FORBID.includes(a)).join(','));
  ok('N10 広い語はもしかしての候補止まり（EX_HINTS の行き先は表の正式名・別名と重ならない）', Object.keys(T.EX_HINTS).every((h) => !aliases.includes(h) && !names.includes(h) && T.EX_HINTS[h].every((c) => names.includes(c))));
  ok('N6 部位の鍵は PART_KEYS にある・名前の印も健康の言葉も含まない・50字以内', TB.every((r) => T.PART_KEYS.some((p) => p[0] === r[1]) && [r[0]].concat(r[2]).every((x) => !PII.test(x) && !HEALTH.test(x) && x.length <= 50)));
  //   N7 部位の順と、過去の記録の部位がさかのぼって変わること（関門① 3）
  ok('N7 ★表に入った名前は表の部位（ナローベンチプレス＝腕・スカルクラッシャー＝腕）・表に無い名前は推定', T.partKeyOf('ナローベンチプレス') === 'arm' && T.partKeyOf('スカルクラッシャー') === 'arm' && T.partKeyOf('ピストルスクワット') === 'legs' && T.partKeyOf('スカルクラッシュ改') === 'other');
  const sess = [{ session_id: 'S1', session_date: '2026-11-01', created_at: 1, sets: [{ exercise: 'スカルクラッシャー', set_no: 1, weight: 10, reps: 12 }, { exercise: 'ナローベンチプレス', set_no: 1, weight: 40, reps: 8 }] },
    { session_id: 'S2', session_date: '2026-11-10', created_at: 2, sets: [{ exercise: 'ベンチプレス', set_no: 1, weight: 50, reps: 10 }] }];
  ok('N7 ★既存の記録の部位（partsOf）：スカルクラッシャー・ナローベンチプレスは腕（推定ではその他・胸だった）', JSON.stringify(T.partsOf(sess[0])) === '["腕"]', JSON.stringify(T.partsOf(sess[0])));
  const ps = T.partsSince(sess, '2026-11-20');
  ok('N7 ★部位ごとの何日ぶり（partsSince）：腕 19日ぶり・胸 10日ぶり（ナローベンチプレスは胸に数えない）', JSON.stringify(ps.map((x) => x.text)) === JSON.stringify(['腕 19日ぶり', '胸 10日ぶり']), JSON.stringify(ps));
}
{
  //   N7 共有の一覧の部位は表より強い
  const { w } = boot({ src: FULL, cfg: { exercises: [{ name: 'ナローベンチプレス', part: 'chest' }] } });
  w.KarteUI.open('C1', '会員', 'training'); await settle();
  ok('N7 ★共有の一覧に別の部位で登録があればそちら（ナローベンチプレス＝胸）', w.KarteUI._t.partKeyOf('ナローベンチプレス') === 'chest');
}
// ---------- N12 関門②：AI の名前を切り詰めずに判定する（51字・51字目以降の体のことの言葉） ----------
{
  const L51 = 'あ'.repeat(51), LH = 'い'.repeat(50) + '痛';
  const { w } = boot({ src: FULL, cfg: { draft: draftWith([one(L51), one('ベンチプレス')]) } });
  await toReview(w);
  ok('N12 ★51字の名前は切り詰めずに出し（51字のまま）、押せない（50字まで）', !!card(w, L51) && put(w).disabled && why(w).includes('長すぎます'), why(w));
  const { w: w2 } = boot({ src: FULL, cfg: { draft: draftWith([one(LH), one('ベンチプレス')]) } });
  await toReview(w2);
  ok('N12 ★51字目に体のことの言葉がある名前は押せない（全体で見る）', !!card(w2, LH) && put(w2).disabled && why(w2).includes('体のこと'), why(w2));
  //   一時保存（設計51）でも切らずに戻し、押せないまま
  const { w: w3 } = boot({ src: FULL, cfg: { draft: draftWith([one(L51), one('ベンチプレス')]) } });
  await toReview(w3);
  const sv = JSON.parse(w3.localStorage.getItem('karte_ai_review_v1:T1:C1') || 'null');
  ok('N12 一時保存にも51字のまま入る', !!sv && sv.rv.exercises[0].name === L51);
  await openImport(w3);
  const bd = R(w3).querySelector('.k-airresume');
  if (bd) { bd.querySelector('.k-airgo').click(); await settle(); }
  ok('N12 ★一時保存から戻しても51字のまま・押せない（保存ごと捨てない）', !!bd && !!card(w3, L51) && put(w3).disabled);
  //   v1 のカード（KARTE_AI_FORMAT 未設定の戻り先）でも切り詰めた名前で種目にできない
  const { w: w4 } = boot({ src: FULL, cfg: { draft: () => ({ v: 1, exercises: [{ name: LH, heard: LH, note: '', sets: [{ w: 20, r: 10, evidence: '20キロで10回', note: '' }] }], coaching: [], hearing: [], caution: [], member_message: '', member_todo: [] }) } });
  await toReview(w4);
  const short50 = [...R(w4).querySelectorAll('input[aria-label="種目名"]')].filter((i) => i.value.length === 50);
  ok('N12 ★v1 のカードでも50字に切り詰めた名前の入力欄を作らない', short50.length === 0 && R(w4).textContent.includes(LH), String(short50.length));
}
// ---------- N9 手入力の種目選びの検索で別名から正式名が出る ----------
{
  const { w } = boot({ src: FULL });
  w.KarteUI.open('C1', '会員', 'training'); await settle();
  btn(R(w), '＋ 今日の記録').click(); await settle();
  btn(R(w), '＋ 種目を足す').click(); await settle();
  const q = R(w).querySelector('input[aria-label="種目を探す"]');
  q.value = 'ラットプル'; q.dispatchEvent(new w.Event('input', { bubbles: true })); await settle();
  const pills = [...R(w).querySelectorAll('.k-picker button')].map((b) => b.textContent);
  q.value = 'チンニング'; q.dispatchEvent(new w.Event('input', { bubbles: true })); await settle();
  const pills2 = [...R(w).querySelectorAll('.k-picker button')].map((b) => b.textContent);
  ok('N9 ★検索「チンニング」（別名）で正式名「懸垂」が出る', pills2.some((t) => t.indexOf('懸垂') === 0), pills2.slice(0, 12).join('|'));
  ok('N9 検索「ラットプル」で「ラットプルダウン」が出る', pills.some((t) => t.indexOf('ラットプルダウン') === 0));
}

console.log(`liff-karte-exercise-names: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
