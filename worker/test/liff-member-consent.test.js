// 設計44 会員画面の同意：本番の liff/index.html のスクリプトを丸ごと jsdom で走らせ、入口（起動の応答）から通す・2026-11-13
//   実行: node worker/test/liff-member-consent.test.js
//
//   ★身代わりは LINE の SDK・api・fetchBoot・fetch だけ。ボタンは click で押す
//     1. memberConsent が true か 'unknown' のときだけ m_myConsent を聞く（無い・false・文字の 'true'・GAS の応答＝聞かない）
//     2. ask の kind の文面だけが出る・チェックの初期値は外れ・文面は文字として入る（HTML を解釈しない・** だけ太字）
//     3. 「あとで」は何も送らない／「送る」はチェック＝agreed・外す＝declined・版つき・Worker にだけ（GAS へ送らない）
//     4. 起動ごとに1回（言語の切り替え・ホームの描き直しで聞き直さない・勧める1枚も1回）
//     5. 失敗・503 は何も出さない／送信の失敗は文を出してチェックを残す
//     6. revoke_only：録音・AI の状態と撤回だけ（チェック・健康情報を作らない）
//     7. 4言語の辞書が新しい鍵を持つ

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const require = createRequire(join(homedir(), '.cache/claude-node/package.json'));
const { JSDOM } = require('jsdom');
const HTML = readFileSync(join(ROOT, 'liff/index.html'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) pass++; else { fail++; console.log(`❌ ${name}${detail ? '\n   ' + detail : ''}`); } }
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 14; i++) await tick(); }

const STYLE = HTML.slice(HTML.indexOf('<style>') + 7, HTML.indexOf('</style>'));
const BODY = HTML.slice(HTML.indexOf('<body'), HTML.indexOf('<script'));
const S0 = HTML.indexOf('<script>\n') + 9;
let SRC = HTML.slice(S0, HTML.indexOf('</script>', S0));
const API_HEAD = '  function api(params){\n';
const BOOT_HEAD = '  function fetchBoot(){\n';
ok('0-1 本番のスクリプトから api と fetchBoot の入口が1つずつ見つかる', SRC.split(API_HEAD).length === 2 && SRC.split(BOOT_HEAD).length === 2);
SRC = SRC.replace(API_HEAD, '  function api(params){ return window.__api(params); }\n  function __realApi(params){\n')
         .replace(BOOT_HEAD, '  function fetchBoot(){ return window.__boot(); }\n  function __realBoot(){\n');

const EVIL = '<img src=x onerror="window.pwned=1">';
const HOME = { success: true, verified: true, name: '会員', defaultTrainerId: 'A', home: { type: 'monthly', quota: 8, carryover: 0, thisMonth: 3, monthlyRemaining: 5 }, transferCredits: { available: 0 } };
const RESV = { success: true, reservations: [], history: [] };
const DOCS = [
  { kind: 'health', ver: 'health-v1', title: '【カルテ】', paragraphs: ['当店は**健康に関する情報**を管理します。' + EVIL], check: '上記に同意します' },
  { kind: 'rec_ai', ver: 'rec-v1', title: '【録音】', paragraphs: ['録音します。', '**30日以内に削除**します。'], check: '録音に同意します' },
];
const FULL = { success: true, mode: 'full', docs: DOCS, ask: ['health', 'rec_ai'],
  state: { health: { state: 'none', current: false }, rec_ai: { state: 'none', current: false } } };
const REVOKE_ONLY = { success: true, mode: 'revoke_only', docs: [DOCS[1]], ask: [],
  state: { rec_ai: { state: 'agreed', current: true, at: Date.UTC(2026, 10, 13), byMember: true } } };

function boot(opts) {
  const o = opts || {};
  const dom = new JSDOM('<!doctype html><html><head><style>' + STYLE + '</style></head>' + BODY + '</html>', { runScripts: 'outside-only', url: 'https://reservation.tokowaka-gym.com/liff/', pretendToBeVisual: true });
  const w = dom.window;
  w.sent = []; w.fetched = []; w.gasScripts = []; w.confirms = [];
  w.Element.prototype.getClientRects = function () { for (let n = this; n; n = n.parentElement) { if (n.hidden || (n.style && n.style.display === 'none')) return []; } return [{}]; };
  w.confirm = (m) => { w.confirms.push(String(m)); return o.confirm === undefined ? true : o.confirm; };
  w.alert = () => {};
  const st = w.setTimeout.bind(w); w.setTimeout = (f, ms) => st(f, Math.min(ms || 0, 3));
  try { w.localStorage.setItem('tkw_lang', o.lang || 'ja'); } catch (e) {}
  const ap = w.document.head.appendChild.bind(w.document.head);
  w.document.head.appendChild = (n) => { if (n && n.tagName === 'SCRIPT' && /script\.google\.com/.test(n.src || '')) w.gasScripts.push(n.src); return ap(n); };
  const bootRes = o.bootRes || HOME;
  const H = Object.assign({ line_getMyReservations: RESV, line_setLang: { success: true }, line_getMemberStatus: bootRes }, o.handlers || {});
  w.__api = (p) => { w.sent.push(JSON.parse(JSON.stringify(p))); const h = H[p.action]; const v = typeof h === 'function' ? h(p) : (h === undefined ? { success: true } : h); return Promise.resolve(JSON.parse(JSON.stringify(v))); };
  w.__boot = () => Promise.resolve(JSON.parse(JSON.stringify(bootRes)));
  w.fetch = async (url, opt) => {
    const b = JSON.parse(opt.body); w.fetched.push({ url: String(url), body: b });
    const f = o.fetch || ((x) => (x.action === 'm_myConsent' ? FULL : { success: true, mode: 'full', state: FULL.state, ask: [] }));
    const r = await f(b);
    if (r instanceof Error) throw r;
    return { json: async () => JSON.parse(JSON.stringify(r)) };
  };
  w.liff = { init: () => Promise.resolve(), isLoggedIn: () => true, getIDToken: () => 'tok', getAppLanguage: () => o.lang || 'ja', getLanguage: () => o.lang || 'ja', closeWindow() {}, isInClient: () => true };
  w.eval(SRC + '\n;window.__g = { state: state, setLang: setLang, I18N: I18N, loadHome: loadHome };');
  return w;
}
const $ = (w, id) => w.document.getElementById(id);
const calls = (w, a) => w.fetched.filter((x) => x.body.action === a);
const sheetOpen = (w) => !$(w, 'mcSheet').hidden;
const click = (w, sel) => { const e = w.document.querySelector(sel); if (e) e.click(); return !!e; };

// ---- 1 印 ----
for (const [label, v] of [['無い', undefined], ['false', false], ['文字の "true"', 'true']]) {
  const res = Object.assign({}, HOME); if (v !== undefined) res.memberConsent = v;
  const w = boot({ bootRes: res }); await settle();
  ok('1-1 ★memberConsent が' + label + 'なら m_myConsent を聞かず・入口も1枚も出ない', calls(w, 'm_myConsent').length === 0 && $(w, 'homeConsent').hidden && !sheetOpen(w));
}

// ---- 2・3 勧める1枚 ----
{
  const w = boot({ bootRes: Object.assign({}, HOME, { memberConsent: true }) }); await settle();
  ok('2-1 memberConsent:true で m_myConsent を Worker に1回・GAS へは送らない', calls(w, 'm_myConsent').length === 1 && /workers\.dev/.test(calls(w, 'm_myConsent')[0].url) && w.gasScripts.length === 0 && !w.sent.some((p) => /Consent/.test(p.action)));
  ok('2-2 ask があれば1枚が開く・文面2つ・チェックは外れたまま', sheetOpen(w) && w.document.querySelectorAll('.mc-doc').length === 2 && [...w.document.querySelectorAll('.mc-check input')].every((c) => c.checked === false));
  ok('2-3 ★文面は文字として入る（<img> が要素にならない）・** だけ太字', !w.document.querySelector('#mcSheet img') && !w.pwned && w.document.querySelector('#mcSheet .mc-doc b').textContent === '健康に関する情報' && $(w, 'mcSheet').textContent.includes('<img src=x'));
  ok('2-4 入口「同意の内容」が出る', !$(w, 'homeConsent').hidden);
  ok('2-5 チェックの行は 48px 以上（行全体を押せる）', /\.mc-check \{[^}]*min-height:48px/.test(STYLE));
  click(w, '.mc-later'); await settle();
  ok('3-1 ★「あとで」は何も送らずに閉じる', !sheetOpen(w) && calls(w, 'm_saveConsent').length === 0);
  //   言語の切り替え・ホームの描き直しでは聞き直さない・勧める1枚も出し直さない
  w.__g.setLang('en'); await settle();
  w.__g.loadHome(); await settle();
  ok('4-1 ★起動ごとに1回：言語の切り替え・ホームの描き直しで m_myConsent を聞き直さず、1枚も出し直さない', calls(w, 'm_myConsent').length === 1 && !sheetOpen(w));
  //   入口から開いて送る
  w.__g.setLang('ja'); await settle();
  $(w, 'homeConsent').click(); await settle();
  ok('3-2 入口から開くと両方の文面と「まだ同意していません」', sheetOpen(w) && w.document.querySelectorAll('.mc-doc').length === 2 && $(w, 'mcSheet').textContent.includes('まだ同意していません'));
  click(w, '.mc-later'); await settle();
}
{
  const w = boot({ bootRes: Object.assign({}, HOME, { memberConsent: true }) }); await settle();
  w.document.querySelector('.mc-doc[data-kind="health"] .mc-check').click();   // 行（label）を押す
  click(w, '.mc-send'); await settle();
  const s = calls(w, 'm_saveConsent');
  ok('3-3 ★送る：チェック＝agreed・外したまま＝declined・版つき・Worker にだけ', s.length === 1 && JSON.stringify(s[0].body.answers) === JSON.stringify({ health: 'agreed', rec_ai: 'declined' })
     && JSON.stringify(s[0].body.vers) === JSON.stringify({ health: 'health-v1', rec_ai: 'rec-v1' }) && !('customerId' in s[0].body) && w.gasScripts.length === 0, JSON.stringify(s.map((x) => x.body)));
  ok('3-4 送れたら閉じる', !sheetOpen(w));
}
// ---- 5 失敗 ----
{
  const w = boot({ bootRes: Object.assign({}, HOME, { memberConsent: 'unknown' }), fetch: (b) => ({ success: false, code: 'MEMBER_CONSENT_OFF' }) }); await settle();
  ok('5-1 ★"unknown" は聞く・503 なら何も出さない（入口も1枚も）', calls(w, 'm_myConsent').length === 1 && $(w, 'homeConsent').hidden && !sheetOpen(w));
}
{
  const w = boot({ bootRes: Object.assign({}, HOME, { memberConsent: true }), fetch: (b) => (b.action === 'm_myConsent' ? new Error('net') : FULL) }); await settle();
  ok('5-2 通信できなければ何も出さない', $(w, 'homeConsent').hidden && !sheetOpen(w));
}
{
  const w = boot({ bootRes: Object.assign({}, HOME, { memberConsent: true }), fetch: (b) => (b.action === 'm_myConsent' ? FULL : { success: false, code: 'CONSENT_UNAVAILABLE' }) }); await settle();
  w.document.querySelector('.mc-doc[data-kind="rec_ai"] .mc-check input').click();
  click(w, '.mc-send'); await settle();
  const msg = w.document.querySelector('.mc-msg');
  ok('5-3 送れなければ文を出し、1枚とチェックを残す', sheetOpen(w) && msg && !msg.hidden && msg.textContent.includes('送れませんでした') && w.document.querySelector('.mc-doc[data-kind="rec_ai"] .mc-check input').checked === true);
}
// ---- 6 revoke_only ----
{
  const w = boot({ bootRes: Object.assign({}, HOME, { memberConsent: true }), fetch: (b) => (b.action === 'm_myConsent' ? REVOKE_ONLY : { success: true, mode: 'revoke_only', state: { rec_ai: { state: 'revoked', current: false } }, ask: [] }) }); await settle();
  ok('6-1 revoke_only は勧める1枚を出さない・入口は出る', !sheetOpen(w) && !$(w, 'homeConsent').hidden);
  $(w, 'homeConsent').click(); await settle();
  ok('6-2 ★revoke_only：録音・AI の文面と状態と撤回だけ（チェック・健康情報・送るを作らない）', w.document.querySelectorAll('.mc-doc').length === 1 && !w.document.querySelector('.mc-check') && !w.document.querySelector('.mc-send')
     && !$(w, 'mcSheet').textContent.includes('【カルテ】') && !!w.document.querySelector('.mc-revoke') && $(w, 'mcSheet').textContent.includes('同意済み'));
  click(w, '.mc-revoke'); await settle();
  const s = calls(w, 'm_saveConsent');
  ok('6-3 撤回は確かめてから rec_ai:revoked だけを送る', w.confirms.length === 1 && s.length === 1 && JSON.stringify(s[0].body.answers) === JSON.stringify({ rec_ai: 'revoked' }) && s[0].body.vers.rec_ai === 'rec-v1');
}
{
  const w = boot({ confirm: false, bootRes: Object.assign({}, HOME, { memberConsent: true }), fetch: () => REVOKE_ONLY }); await settle();
  $(w, 'homeConsent').click(); await settle(); click(w, '.mc-revoke'); await settle();
  ok('6-4 確かめで「キャンセル」なら送らない', calls(w, 'm_saveConsent').length === 0);
}
{
  //   ★旧版の録音・AI の同意（current:false）でも撤回できる（関門② 高）
  const OLD = Object.assign({}, REVOKE_ONLY, { state: { rec_ai: { state: 'agreed', current: false, at: 1, byMember: true } } });
  const w = boot({ bootRes: Object.assign({}, HOME, { memberConsent: true }), fetch: (b) => (b.action === 'm_myConsent' ? OLD : { success: true, mode: 'revoke_only', state: { rec_ai: { state: 'revoked' } }, ask: [] }) }); await settle();
  $(w, 'homeConsent').click(); await settle();
  click(w, '.mc-revoke'); await settle();
  ok('6-6 ★revoke_only で旧版の同意（current:false）でも撤回のボタンが出て送れる', calls(w, 'm_saveConsent').length === 1 && JSON.stringify(calls(w, 'm_saveConsent')[0].body.answers) === JSON.stringify({ rec_ai: 'revoked' }));
}
{
  //   full で旧版に同意済み：撤回も、新しい版への同意のチェックも出る
  const st = { health: { state: 'none', current: false }, rec_ai: { state: 'agreed', current: false, at: 1 } };
  const w = boot({ bootRes: Object.assign({}, HOME, { memberConsent: true }), fetch: () => Object.assign({}, FULL, { ask: [], state: st }) }); await settle();
  $(w, 'homeConsent').click(); await settle();
  const rec = w.document.querySelector('.mc-doc[data-kind="rec_ai"]');
  ok('6-7 full・旧版に同意済み：「以前の内容に同意済み」と、撤回のボタン・同意し直すチェックが出る', !!rec.querySelector('.mc-revoke') && !!rec.querySelector('.mc-check') && rec.textContent.includes('以前の内容に同意済み') && rec.textContent.includes('同意し直す') && !rec.querySelector('.mc-state.ok'));
}
{
  //   文面が変わった（DOC_CHANGED）→ 最新の文面で開き直す（1回だけ）
  let n = 0;
  const w = boot({ bootRes: Object.assign({}, HOME, { memberConsent: true }), fetch: (b) => {
    if (b.action === 'm_myConsent') { n++; return n === 1 ? FULL : Object.assign({}, FULL, { docs: [DOCS[0], Object.assign({}, DOCS[1], { ver: 'rec-v2', title: '【録音・新】' })] }); }
    return { success: false, code: 'DOC_CHANGED' };
  } }); await settle();
  w.document.querySelector('.mc-doc[data-kind="rec_ai"] .mc-check input').click();
  click(w, '.mc-send'); await settle();
  ok('6-8 文面が変わったら読み直して、最新の文面の1枚を開き直す', n === 2 && sheetOpen(w) && $(w, 'mcSheet').textContent.includes('【録音・新】'), 'n=' + n);
}
// ---- 健康情報が同意済みのとき（入口）----
{
  const st = { health: { state: 'agreed', current: true, at: Date.UTC(2026, 10, 1) }, rec_ai: { state: 'agreed', current: true, at: Date.UTC(2026, 10, 1) } };
  const w = boot({ bootRes: Object.assign({}, HOME, { memberConsent: true }), fetch: () => Object.assign({}, FULL, { ask: [], state: st }) }); await settle();
  $(w, 'homeConsent').click(); await settle();
  ok('6-5 健康情報が同意済みなら撤回のボタンは出さず「店舗までお申し出ください」（会員画面から健康情報を消さない）',
     w.document.querySelectorAll('.mc-revoke').length === 1 && w.document.querySelector('.mc-doc[data-kind="health"]').textContent.includes('店舗までお申し出ください') && !w.document.querySelector('.mc-doc[data-kind="health"] .mc-revoke'));
}
// ---- 7 辞書 ----
{
  const w = boot({}); await settle();
  const I = w.__g.I18N;
  const keys = Object.keys(I.ja).filter((k) => /^mc_/.test(k));
  const miss = [];
  for (const l of ['en', 'zh', 'zh-Hant']) for (const k of keys) if (I[l][k] == null || (k !== 'mc_ja_only' && I[l][k] === '')) miss.push(l + ':' + k);
  ok('7-1 4言語の辞書が mc_ の鍵を全部持つ', keys.length >= 15 && miss.length === 0, miss.join(','));
  ok('7-2 日本語以外は「文面は日本語です」を添える', I.en.mc_ja_only && I.zh.mc_ja_only && I['zh-Hant'].mc_ja_only && I.ja.mc_ja_only === '');
}

console.log(`liff-member-consent: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
