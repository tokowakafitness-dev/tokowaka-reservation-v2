// 会員画面 C2（設計35）：会員が自分のカルテを読む画面と、トレーナーの「お客様に見える欄」「お客様の見え方」を入口から通す検査
//   実行: node worker/test/liff-member-karte.test.js
//
//   ★部品ではなく入口から：本番の liff/index.html のスクリプトを丸ごと jsdom で走らせ（身代わりは LINE の SDK・api・fetchBoot・fetch だけ）、
//     ボタンを click で押す。トレーナーの欄は本番の liff/karte.js を同じ窓で走らせる
//     1. memberKarte が true のときだけホームの追加部分と下のタブ（無い・false・GAS の応答＝出さない）
//     2. 各タブの値は文字として入る（<img> 等が要素にならない）・値が無いときの表示
//     3. c_myKarte は Worker にだけ・起動ごとに1回（タブ・言語を切り替えても増えない）・失敗/503 で GAS へ送らず「いまは表示できません」
//     4. 言語切替で描き直る・4言語の辞書が新しい鍵を自分で持つ
//     5. タブの切り替えで履歴が増えない・タブの画面の data-back は概要へ
//     6. トレーナー：k_addTraining に member（空なら付けない）・セット無しは k_saveMemberNote・応答に mnoteId が無ければ欄を残す・下書きの消える時点
//     7. お客様の見え方：同じ部品で描く・直す/消すは本人かオーナーだけ・編集は最上位の鍵（タグは触ったときだけ）
//     8. タグだけの枚は会員の「指導の履歴」「直近の指導」に出さない

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
const KSRC = readFileSync(join(ROOT, 'liff/karte.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) pass++; else { fail++; console.log(`❌ ${name}${detail ? '\n   ' + detail : ''}`); } }
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), 'got : ' + JSON.stringify(got) + '\n   want: ' + JSON.stringify(want)); }
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
const HOME = { success: true, verified: true, name: '会員', defaultTrainerId: 'T1', home: { type: 'monthly', quota: 8, carryover: 0, thisMonth: 3, monthlyRemaining: 5 }, transferCredits: { available: 1, nextExpireLabel: '11/30' } };
const iso = (daysAhead, h) => { const d = new Date(Date.now() + daysAhead * 86400000); d.setUTCHours(h - 9, 0, 0, 0); return d.toISOString(); };
const RESV = { success: true, reservations: [
  { reservationId: 'R1', startISO: iso(2, 10), dateLabel: 'x', trainerName: EVIL + '一郎', freeCancel: true },
  { reservationId: 'R2', startISO: iso(9, 10), dateLabel: 'y', trainerName: '一郎', freeCancel: true },
  { reservationId: 'R3', startISO: iso(16, 10), dateLabel: 'z', trainerName: '一郎', freeCancel: true }], history: [] };
const KARTE = {
  success: true,
  goal: { targetWeight: 66, deadline: '2027-03-31' },
  body: {
    latest: { date: '2026-11-01', weight: 70.3, fat: 27.8, muscle: 24.1 }, prev: { date: '2026-10-18', weight: 70.9, fat: 28.2, muscle: 24.0 },
    series: [{ date: '2026-09-15', weight: 72.4, fat: 29.5, muscle: 23.9 }, { date: '2026-10-18', weight: 70.9, fat: 28.2, muscle: 24.0 }, { date: '2026-11-01', weight: 70.3, fat: 27.8, muscle: 24.1 }],
    recent: [{ date: '2026-11-01', weight: 70.3, fat: 27.8, muscle: 24.1 }, { date: '2026-10-18', weight: 70.9, fat: 28.2, muscle: 24.0 }],
    goalLine: { startDate: '2026-09-15', endDate: '2027-03-31', startWeight: 72.4, targetWeight: 66 } },
  training: {
    sessions: [
      { date: '2026-10-25', items: [{ exercise: 'スクワット', sets: [{ setNo: 1, weight: 40, reps: 10 }] }], tags: ['下半身'] },
      { date: '2026-11-01', items: [{ exercise: EVIL + 'スクワット', sets: [{ setNo: 1, weight: 50, reps: 10 }, { setNo: 2, weight: 50, reps: 8 }] }, { exercise: 'ラットプルダウン', sets: [{ setNo: 1, weight: 30, reps: 12 }] }], tags: ['全身', EVIL + '背中'] }],
    best: [{ exercise: 'スクワット', weight: 40, reps: 10, date: '2026-10-25' }] },
  notes: [
    { date: '2026-11-02', message: null, todo: [], trainerName: '一郎' },   // タグだけの枚（会員には出さない）
    { date: '2026-11-01', message: EVIL + 'しゃがめていました', todo: ['ストレッチ 2分', EVIL + '7000歩'], trainerName: EVIL + '一郎' },
    { date: '2026-10-25', message: '背中の種目', todo: [], trainerName: '一郎' }],
  contract: { type: '月額', course: EVIL + 'フル', freq: 8, trainerName: '一郎', startDate: '2026-10-01', endDate: '2027-03-31', tickets: null },
};

function boot(opts) {
  const o = opts || {};
  const dom = new JSDOM('<!doctype html><html><head><style>' + STYLE + '</style></head>' + BODY + '</html>', { runScripts: 'outside-only', url: 'https://reservation.tokowaka-gym.com/liff/', pretendToBeVisual: true });
  const w = dom.window;
  w.sent = []; w.fetched = []; w.gasScripts = []; w.alerts = [];
  w.Element.prototype.getClientRects = function () { for (let n = this; n; n = n.parentElement) { if (n.hidden || (n.style && n.style.display === 'none')) return []; } return [{}]; };
  w.confirm = o.confirm || (() => true); w.alert = (m) => w.alerts.push(String(m));
  const st = w.setTimeout.bind(w); w.setTimeout = (f, ms) => st(f, Math.min(ms || 0, 3));
  try { w.localStorage.setItem('tkw_lang', o.lang || 'ja'); } catch (e) {}
  //   GAS へ送ると _rawApi が <script src=GAS_URL> を足す＝それを数える
  const ap = w.document.head.appendChild.bind(w.document.head);
  w.document.head.appendChild = (n) => { if (n && n.tagName === 'SCRIPT' && /script\.google\.com/.test(n.src || '')) w.gasScripts.push(n.src); return ap(n); };
  const H = Object.assign({ line_getMyReservations: RESV, line_setLang: { success: true }, line_getMemberStatus: o.bootRes || HOME }, o.handlers || {});
  w.__api = (p) => { w.sent.push(JSON.parse(JSON.stringify(p))); const h = H[p.action]; const v = typeof h === 'function' ? h(p) : (h === undefined ? { success: true } : h); return (v && typeof v.then === 'function') ? v : Promise.resolve(JSON.parse(JSON.stringify(v))); };
  w.__boot = () => Promise.resolve(JSON.parse(JSON.stringify(o.bootRes || HOME)));
  w.fetch = async (url, opt) => {
    const b = JSON.parse(opt.body); w.fetched.push(b);
    const f = o.fetch || (() => KARTE);
    const r = await f(b);
    if (r instanceof Error) throw r;
    return { json: async () => JSON.parse(JSON.stringify(r)) };
  };
  w.liff = { init: () => Promise.resolve(), isLoggedIn: () => true, getIDToken: () => 'tok', getAppLanguage: () => o.lang || 'ja', getLanguage: () => o.lang || 'ja', closeWindow() {}, isInClient: () => true };
  w.eval(SRC + '\n;window.__g = { state: state, setLang: setLang, I18N: I18N, loadHome: loadHome };');
  return w;
}
const $ = (w, id) => w.document.getElementById(id);
const cur = (w) => [...w.document.querySelectorAll('.screen')].filter((s) => !s.hidden).map((s) => s.id).join(',');
const tab = (w, k) => w.document.querySelector('#mkTabs [data-mk="' + k + '"]');
const myKarteCalls = (w) => w.fetched.filter((b) => b.action === 'c_myKarte').length;
const KON = Object.assign({}, HOME, { memberKarte: true });

// ================= 1. 出す条件 =================
for (const [label, res] of [['無い', HOME], ['false', Object.assign({}, HOME, { memberKarte: false })], ['"true"（文字）', Object.assign({}, HOME, { memberKarte: 'true' })]]) {
  const w = boot({ bootRes: res }); await settle();
  ok('1-1 ★memberKarte が' + label + 'ならタブも追加部分も出さず、c_myKarte も呼ばない', cur(w) === 's-home' && $(w, 'mkTabs').hidden && $(w, 'homeKarte').hidden && myKarteCalls(w) === 0 && !w.document.body.classList.contains('mk-on'), cur(w) + ' calls=' + myKarteCalls(w));
  ok('1-2 次回のご予約は memberKarte に関係なく出る（' + label + '）', !$(w, 'homeNext').hidden && $(w, 'homeNext').textContent.includes('次回のご予約'));
}
{
  const w = boot({ bootRes: KON }); await settle();
  ok('1-3 ★memberKarte:true でタブとホームの追加部分が出る', !$(w, 'mkTabs').hidden && !$(w, 'homeKarte').hidden && w.document.body.classList.contains('mk-on'));
  const hk = $(w, 'homeKarte').textContent;
  ok('1-4 目標と進み具合（いま・目標・期日・％）', hk.includes('目標と進み具合') && hk.includes('70.3') && hk.includes('66.0') && hk.includes('3/31') && hk.includes('体組成へ ›') && !!$(w, 'homeKarte').querySelector('svg[aria-label^="目標まで"]'), hk.slice(0, 200));
  ok('1-5 ★直近の指導はタグだけの枚を飛ばし、お客様へのある最新の枚（11/1）・次回までに 2つ', hk.includes('直近の指導（11/1）') && hk.includes(EVIL + 'しゃがめていました') && hk.includes('次回までに 2つ') && !hk.includes('直近の指導（11/2）'), hk);
  ok('1-6 ★ホームの値は文字として（img が作られない）', !$(w, 's-home').querySelector('img') && !w.pwned);
  const nx = $(w, 'homeNext').textContent;
  ok('1-7 次回のご予約：先頭の日時・担当・このあとの2日', nx.includes('担当 ' + EVIL + '一郎') && nx.includes('このあと') && nx.includes('にもご予約があります') && /\d+\/\d+\(.\) 10:00/.test(nx), nx);
  ok('1-8 タブの「概要」に印', tab(w, 'home').classList.contains('on') && tab(w, 'home').getAttribute('aria-current') === 'page');
  ok('1-9 c_myKarte は Worker に1回（GAS へは送らない）', myKarteCalls(w) === 1 && !w.sent.some((p) => /karte/i.test(p.action)) && w.gasScripts.length === 0);
  eq('1-10 送る中身は action・idToken・lang だけ（顧客を指す値を送らない）', Object.keys(w.fetched.find((b) => b.action === 'c_myKarte')).sort(), ['action', 'idToken', 'lang']);

  // ================= 2. タブ =================
  tab(w, 'body').click(); await settle();
  const len0 = w.history.length;
  ok('2-1 体組成のタブ', cur(w) === 's-mk' && $(w, 'mkTitle').textContent === '体組成' && tab(w, 'body').classList.contains('on'), cur(w));
  const bt = $(w, 'mkBody').textContent;
  ok('2-2 体組成：目標体重と期日・いま・あと・入会から・前回比・推移・最近の記録', ['目標までの進み具合', '体重 66.0kg（3/31まで）', 'いま 70.3kg ／ あと 4.3kg', '入会から −2.1kg', '▼ 0.6 前回比', '▲ 0.1 前回比', '推移', '入会 9/15 から', '最近の記録', '測定日', '10/18'].every((x) => bt.includes(x)), bt);
  ok('2-3 骨格筋量が増えたら良い向きの色（体重・体脂肪率は下がって良い向き）', [...$(w, 'mkBody').querySelectorAll('.mk-stat .mk-good')].length === 3);
  ok('2-4 推移の線は SVG（目標の線つき）', !!$(w, 'mkBody').querySelector('svg.mk-chart polyline') && $(w, 'mkBody').querySelector('svg.mk-chart').textContent.includes('目標 66'));
  [...$(w, 'mkBody').querySelectorAll('.mk-pill')].find((b) => b.textContent === '体脂肪率').click(); await settle();
  ok('2-5 推移を体脂肪率に切り替え（目標の線は出さない）', $(w, 'mkBody').querySelector('.mk-pill.on').textContent === '体脂肪率' && !$(w, 'mkBody').querySelector('svg.mk-chart').textContent.includes('目標'));
  tab(w, 'training').click(); await settle();
  const tt = $(w, 'mkBody').textContent;
  ok('2-6 トレーニング：前回（新しい日）・種目数とセット数・重さ×回数・種目ごとの推移・日別', tt.includes('前回（11/1）') && tt.includes('2種目・3セット') && tt.includes('50kg × 10・8') && tt.includes('種目ごとの推移') && tt.includes('日別の記録'), tt);
  [...$(w, 'mkBody').querySelectorAll('.mk-pill')].find((b) => b.textContent === 'スクワット').click(); await settle();
  ok('2-6b 種目を選ぶと推移と自己ベスト（その種目の）', $(w, 'mkBody').querySelector('.mk-pill.on').textContent === 'スクワット' && $(w, 'mkBody').textContent.includes('自己ベスト40kg × 10（10/25）') && !!$(w, 'mkBody').querySelector('svg.mk-chart'), $(w, 'mkBody').textContent);
  ok('2-7 ★種目名・タグは文字として', !$(w, 'mkBody').querySelector('img') && tt.includes(EVIL + 'スクワット') && tt.includes(EVIL + '背中') && !w.pwned);
  const day = $(w, 'mkBody').querySelectorAll('.mk-day');
  ok('2-8 日別の行は押すと開く（最初は閉じている・44px）', day.length === 2 && day[0].getAttribute('aria-expanded') === 'false' && /\.mk-day \{[^}]*min-height:44px/.test(STYLE));
  day[1].click(); await settle();
  ok('2-9 押した日の中身が出る', $(w, 'mkBody').querySelectorAll('.mk-day')[1].getAttribute('aria-expanded') === 'true' && $(w, 'mkBody').textContent.includes('40kg × 10'));
  tab(w, 'notes').click(); await settle();
  const nt = $(w, 'mkBody').textContent;
  ok('2-10 指導の履歴：次回までに（最新の枚の todo・✓なし）・痛みの案内・履歴', nt.includes('次回までに') && nt.includes('ストレッチ 2分') && nt.includes(EVIL + '7000歩') && nt.includes('痛みが出たら無理をせず') && !$(w, 'mkBody').querySelector('input[type=checkbox]'), nt);
  ok('2-11 ★タグだけの枚（11/2）は指導の履歴に出さない', !nt.includes('11/2(') && $(w, 'mkBody').querySelectorAll('.mk-text').length === 2, nt);
  tab(w, 'contract').click(); await settle();
  const ct = $(w, 'mkBody').textContent;
  ok('2-12 契約：残り回数（今のホームの情報）・振替・契約・規定・相談', ct.includes('残り回数') && ct.includes('今月の残り') && ct.includes('振替可能') && ct.includes('月額・' + EVIL + 'フル') && ct.includes('2026/10/1 〜 2027/3/31') && ct.includes('月8回') && ct.includes('前日17時まで無料') && ct.includes('担当トレーナーへ'), ct);
  ok('2-13 ★タブの値はどれも要素にならない', !w.document.querySelector('#app img') && !w.pwned);
  ok('2-14 ★タブを何度切り替えても履歴は増えない', w.history.length === len0, w.history.length + ' vs ' + len0);
  ok('2-15 ★タブを何度切り替えても c_myKarte は1回', myKarteCalls(w) === 1);

  // ================= 4. 言語 =================
  w.__g.setLang('en'); await settle();
  ok('4-1 ★言語を切り替えると、いまのタブを今の言語で描き直す（再通信しない）', cur(w) === 's-mk' && $(w, 'mkTitle').textContent === 'Plan' && $(w, 'mkBody').textContent.includes('Sessions left') && tab(w, 'body').textContent === 'Body' && myKarteCalls(w) === 1);
  w.__g.setLang('ja'); await settle();

  // ================= 5. 戻る =================
  ok('5-1 タブの画面の「←」は data-back で帯の中', $(w, 'mkBack').hasAttribute('data-back') && $(w, 'mkBack').parentNode.className === 'mhead');
  w.rsvBack(); await settle();
  ok('5-2 ★端末の戻る・横スワイプ（rsvBack）＝概要へ', cur(w) === 's-home' && tab(w, 'home').classList.contains('on'), cur(w));
  w.rsvBack(); await settle();
  ok('5-3 概要では何もしない（LIFF を閉じない・C1 のまま）', cur(w) === 's-home');
  w.__g.setLang('en'); await settle();
  ok('5-4 ★概要に戻った後の言語切替は概要を描き直す（別の画面へ飛ばない）', cur(w) === 's-home' && $(w, 'homeKarte').textContent.includes('Goal & progress') && myKarteCalls(w) === 1);
  ok('5-5 予約の流れに入るとタブは隠れる', (() => { w.__g.state._repaint = null; w.show('s-trainer'); return $(w, 'mkTabs').hidden; })());
}
{
  //   ★Worker の約束（3）：memberKarte の無い応答（GAS・写しの無い起動）＝false。予約の後のホームでも同じ
  let res2 = HOME;
  const w = boot({ bootRes: KON, handlers: { line_getMemberStatus: () => res2 } }); await settle();
  w.__g.loadHome(); await settle();
  ok('1-11 ★後から memberKarte の無い応答が来たら出さない（無い＝false）', $(w, 'mkTabs').hidden && $(w, 'homeKarte').hidden);
  ok('1-12 予約の後のホームでは次回のご予約を取り直す', w.sent.filter((p) => p.action === 'line_getMyReservations').length === 2);
}

// ================= 3. 失敗・503 =================
for (const [label, f] of [['503（MEMBER_KARTE_OFF）', () => ({ success: false, code: 'MEMBER_KARTE_OFF' })], ['通信できない', () => new Error('net')], ['FALLBACK', () => ({ success: false, code: 'FALLBACK' })]]) {
  const w = boot({ bootRes: KON, fetch: f }); await settle();
  ok('3-1 ★' + label + '：ホームに「いまは表示できません」', $(w, 'homeKarte').textContent.includes('いまは表示できません'), $(w, 'homeKarte').textContent);
  tab(w, 'notes').click(); await settle();
  tab(w, 'body').click(); await settle();
  ok('3-2 ★' + label + '：タブも「いまは表示できません」で空のまま', $(w, 'mkBody').textContent.includes('いまは表示できません') && !$(w, 'mkBody').querySelector('svg'));
  ok('3-3 ★' + label + '：GAS へ送らない・取り直さない（c_myKarte は1回）', w.gasScripts.length === 0 && !w.sent.some((p) => /karte/i.test(p.action)) && myKarteCalls(w) === 1, JSON.stringify(w.sent.map((p) => p.action)) + ' gas=' + w.gasScripts.length + ' calls=' + myKarteCalls(w));
}

// ================= 2b. 値が無いとき =================
{
  const EMPTY = { success: true, goal: { targetWeight: null, deadline: null }, body: { latest: null, prev: null, series: [], recent: [], goalLine: null }, training: { sessions: [], best: [] }, notes: [{ date: '2026-11-02', message: null, todo: [], trainerName: 'x' }], contract: null };
  const w = boot({ bootRes: KON, fetch: () => EMPTY, handlers: { line_getMyReservations: { success: true, reservations: [], history: [] } } }); await settle();
  ok('2b-1 予約が無ければ次回のご予約は出さない', $(w, 'homeNext').hidden);
  ok('2b-2 ホーム：目標は未設定・指導の記録はまだ（タグだけの枚は数えない）', $(w, 'homeKarte').textContent.includes('目標はまだ決まっていません') && $(w, 'homeKarte').textContent.includes('指導の記録はまだありません'));
  tab(w, 'body').click(); await settle();
  ok('2b-3 体組成：記録なし', $(w, 'mkBody').textContent.includes('体組成の記録はまだありません'));
  tab(w, 'training').click(); await settle();
  ok('2b-4 トレーニング：記録なし', $(w, 'mkBody').textContent.includes('トレーニングの記録はまだありません'));
  tab(w, 'notes').click(); await settle();
  ok('2b-5 指導の履歴：次回までのことは無い・記録なし', $(w, 'mkBody').textContent.includes('次回までのことは、まだありません') && $(w, 'mkBody').textContent.includes('指導の記録はまだありません'));
  tab(w, 'contract').click(); await settle();
  ok('2b-6 ★契約が null なら「担当トレーナーにお尋ねください」', $(w, 'mkBody').textContent.includes('契約の内容は担当トレーナーにお尋ねください'));
}

// ================= 4b. 辞書・見た目 =================
{
  const w = boot(); await settle();
  const I = w.__g.I18N;
  const keys = Object.keys(I.ja).filter((k) => /^mk_/.test(k));
  const miss = [];
  ['en', 'zh', 'zh-Hant'].forEach((l) => keys.forEach((k) => { if (!Object.prototype.hasOwnProperty.call(I[l], k) || !String(I[l][k]).trim()) miss.push(l + ':' + k); }));
  ok('4b-1 ★4言語の辞書が新しい鍵を自分で持つ', keys.length >= 60 && miss.length === 0, keys.length + ' ' + miss.join(' '));
  const usedT = [...new Set([...HTML.matchAll(/t\('(mk_[a-z_]+)'[,)]/g)].map((m) => m[1]))];
  const missT = usedT.filter((k) => !keys.includes(k));
  ok('4b-2 画面で使う mk_ の鍵はすべて辞書にある', missT.length === 0, missT.join(' '));
  ok('4b-3 下のタブは56px・14px', /\.mk-tab \{[^}]*min-height:56px;[^}]*font-size:14px;/.test(STYLE));
  ok('4b-4 選ぶボタン・見出しのリンクは44px以上', /\.mk-pill \{[^}]*min-height:44px/.test(STYLE) && /\.mk-link \{[^}]*min-height:44px/.test(STYLE));
  ok('4b-5 会員の既定に important を足していない', !/\.mk-[^{]*\{[^}]*!important/.test(STYLE));
  ok('4b-6 予約ページの viewport は変えていない', HTML.includes('<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">'));
  //   ★画面の版は後の変更でも上がる（設計36 で 2026-11-06g）。設計35 の版以降であることだけを見る
  ok('4b-7 版の印を上げた', /var LIFF_BUILD = '2026-11-(06[f-z]|0[7-9]|[1-3]\d)/.test(HTML) && /karte\.js\?v=2026-11-(06[b-z]|0[7-9]|[1-3]\d)/.test(HTML) && /KARTE_BUILD = '2026-11-(06[b-z]|0[7-9]|[1-3]\d)/.test(KSRC));
}

// ================= 6. トレーナー：お客様に見える欄（karte.js だけで動かす） =================
function kboot(responder) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'https://reservation.tokowaka-gym.com/liff/' });
  const w = dom.window; const sent = [];
  w.idToken = 'TOKEN1'; w.EDGE_URL = 'https://edge.example';
  w.state = { trainerId: 'T1', _isOwner: false, _allTrainers: [{ id: 'T1', name: '一郎' }] };
  w.alerts = []; w.alert = (m) => w.alerts.push(String(m)); w.confirm = () => true;
  w.__karteReload = () => {}; w.liff = { getIDToken: () => w.idToken };
  w.fetch = async (url, opt) => { const b = JSON.parse(opt.body); sent.push(b); const r = await responder(b); return { json: async () => r }; };
  w.eval(KSRC);
  return { w, sent };
}
const TR_HIST = [{ session_id: 'S3', session_date: '2026-11-01', created_at: 300, author_trainer_id: 'T1', rev: 1, sets: [{ exercise: 'スクワット', set_no: 1, weight_kg: 40, reps: 10 }] }];
const kbtn = (root, t) => [...root.querySelectorAll('button')].find((x) => x.textContent.indexOf(t) === 0);
const draftOf = (w) => JSON.parse(w.localStorage.getItem('karte_tr_draft_v1:T1:C1') || 'null');
const pop = () => new Promise((r) => setTimeout(r, 40));
async function openForm(w) {
  w.KarteUI.open('C1', '会員', 'training'); await settle();
  const root = w.document.getElementById('karteRoot');
  kbtn(root, '＋ 今日の記録').click(); await settle();
  return root;
}
async function withSet(w, root) {
  kbtn(root, '過去の記録から写す').click(); await settle();
  kbtn(root, '重量・回数ごと写す').click(); await pop(); await settle();
  root.querySelector('button[aria-label="1セット目を実施済みにする"]').click(); await settle();
}
function fillMember(w, root, msg, todo, tags) {
  const ta = root.querySelector('textarea[aria-label="お客様へ"]'); ta.value = msg; ta.dispatchEvent(new w.Event('input', { bubbles: true }));
  (todo || []).forEach((v, i) => { const x = root.querySelector('input[aria-label="次回までに ' + (i + 1) + 'つ目"]'); x.value = v; x.dispatchEvent(new w.Event('input', { bubbles: true })); });
  (tags || []).forEach((tg) => [...root.querySelectorAll('.k-member .k-pill')].find((b) => b.textContent === tg).click());
}
{
  //   ★古い Worker（版 31）には、トレーニングもお客様の欄も1回も送らない（Codex 関門②：版を上げても保存の経路が見ていなかった）
  const { w, sent } = kboot(async (b) => (b.action === 'k_training' ? { success: true, karteSchema: 31, sessions: TR_HIST, best: [] } : { success: true, sessionId: 'N1', rev: 1 }));
  let root = await openForm(w);
  await withSet(w, root);
  fillMember(w, root, '古い版', ['歩く'], []);
  kbtn(root, '保存する').click(); await settle();
  ok('6-0a ★版31：セット＋お客様の欄を保存しても k_addTraining を送らない・案内を出す', !sent.some((x) => x.action === 'k_addTraining') && w.alerts.some((m) => m.includes('システムの更新中')), JSON.stringify(w.alerts));
}
{
  const { w, sent } = kboot(async (b) => (b.action === 'k_training' ? { success: true, karteSchema: 31, sessions: TR_HIST, best: [] } : { success: true, mnoteId: 'M9', rev: 1 }));
  const root = await openForm(w);
  fillMember(w, root, '欄だけ', [], []);
  kbtn(root, '保存する').click(); await settle();
  ok('6-0b ★版31：お客様の欄だけでも k_saveMemberNote を送らない', !sent.some((x) => x.action === 'k_saveMemberNote' || x.action === 'k_addTraining') && w.alerts.some((m) => m.includes('システムの更新中')));
}
{
  let addResp = { success: true, sessionId: 'N1', rev: 1, mnoteId: 'M1', mnoteRev: 1 };
  const { w, sent } = kboot(async (b) => {
    if (b.action === 'k_training') return { success: true, karteSchema: 32, sessions: TR_HIST, best: [] };
    if (b.action === 'k_addTraining') return addResp;
    return { success: true };
  });
  let root = await openForm(w);
  const mc = root.querySelector('.k-member'), ic = root.querySelector('.k-internal');
  ok('6-1 ★お客様に見える欄：見出しに「お客様に見えます」・ネイビーの淡・社内メモは灰で分ける', !!mc && mc.textContent.includes('お客様に見える欄') && mc.textContent.includes('お客様に見えます') && /#edf2fb|237, 242, 251/.test(mc.style.background) && !!ic && /#f0f3f7|240, 243, 247/.test(ic.style.background));
  ok('6-2 お客様へ（400字）・次回までに3行・日のタグ12個', root.querySelector('textarea[aria-label="お客様へ"]').maxLength === 400 && root.querySelectorAll('input[aria-label^="次回までに"]').length === 3 && mc.querySelectorAll('.k-pill').length === 12);
  ok('6-3 押す場所は44px（入力・タグ）', /min-height: ?44px/.test(root.querySelector('input[aria-label^="次回までに"]').style.cssText) && /\.k-pill\{min-height:44px/.test(KSRC));
  //   セットだけ＝member を付けない
  await withSet(w, root);
  kbtn(root, '保存する').click(); await settle();
  let p = sent.filter((x) => x.action === 'k_addTraining').pop();
  ok('6-4 ★お客様の欄が空なら member を送らない（今までと同じ形）', !!p && !('member' in p) && !draftOf(w), JSON.stringify(p));
  //   セット＋お客様の欄
  root = await openForm(w);
  await withSet(w, root);
  fillMember(w, root, '  深くしゃがめていました  ', ['ストレッチ', '', '7000歩'], ['全身', '脚']);
  ok('6-5 書きかけのお客様の欄は下書きに残る', draftOf(w).member.message.includes('深くしゃがめて') && draftOf(w).member.tags.join() === '全身,脚');
  kbtn(root, '保存する').click(); await settle();
  p = sent.filter((x) => x.action === 'k_addTraining').pop();
  eq('6-6 ★k_addTraining の member（前後の空白を落とす・空の行を落とす）', p.member, { message: '深くしゃがめていました', todo: ['ストレッチ', '7000歩'], tags: ['全身', '脚'] });
  ok('6-7 ★成功（mnoteId あり）でセットとお客様の欄を下書きから消す・完了に「お客様に見える欄も保存しました」', !draftOf(w) && root.textContent.includes('お客様に見える欄も保存しました'));
  //   ★Worker の約束（2）：古い Worker は member を黙って捨てる＝mnoteId が無い
  addResp = { success: true, sessionId: 'N2', rev: 1 };
  root = await openForm(w);
  await withSet(w, root);
  fillMember(w, root, '残したい', [], []);
  kbtn(root, '保存する').click(); await settle();
  const d = draftOf(w);
  ok('6-8 ★応答に mnoteId が無い＝「お客様の欄は保存されていません」・欄は下書きに残す・セットは保存済み', w.alerts.some((a) => a.includes('お客様の欄は保存されていません')) && !!d && d.member && d.member.message === '残したい' && d.items.length === 0 && !d.pending && !root.textContent.includes('お客様に見える欄も保存しました'), JSON.stringify(d));
  //   日のタグは6つまで
  root = await openForm(w);
  const pills = [...root.querySelectorAll('.k-member .k-pill')];
  pills.slice(0, 7).forEach((b) => b.click());
  ok('6-9 日のタグは6つまで（7つ目は知らせて選ばない）', root.querySelectorAll('.k-member .k-pill.on').length === 6 && w.alerts.some((a) => a.includes('6つまで')));
  w.KarteUI.close && w.KarteUI.close();
}
{
  //   セット無し・お客様の欄だけ＝k_saveMemberNote（新規・トレーニングなし）。結果が分からなければ同じ送信番号で送り直す
  let resp = { success: false, code: 'BAD_RESPONSE' };
  const { w, sent } = kboot(async (b) => {
    if (b.action === 'k_training') return { success: true, karteSchema: 32, sessions: TR_HIST, best: [] };
    if (b.action === 'k_saveMemberNote') return resp;
    if (b.action === 'k_addNote') return { success: true, noteId: 'n1', rev: 1 };
    return { success: true };
  });
  try { w.localStorage.removeItem('karte_tr_draft_v1:T1:C1'); } catch (e) {}
  let root = await openForm(w);
  fillMember(w, root, 'お客様だけ', ['歩く'], ['有酸素']);
  const memo = root.querySelector('textarea[aria-label="社内メモ"]'); memo.value = '社内のこと'; memo.dispatchEvent(new w.Event('input', { bubbles: true }));
  kbtn(root, '保存する').click(); await settle(); await pop(); await settle();
  const s1 = sent.filter((x) => x.action === 'k_saveMemberNote');
  ok('6-10 ★セット無しでお客様の欄だけ＝k_saveMemberNote（k_addTraining は送らない）', s1.length === 1 && !sent.some((x) => x.action === 'k_addTraining'));
  const b1 = Object.assign({}, s1[0]); delete b1.idToken; delete b1.clientReqId;
  eq('6-11 ★新規・トレーニングなしの形（最上位に置く・sessionId と mnoteId は送らない）', b1, { action: 'k_saveMemberNote', rev: 0, customerId: 'C1', sessionDate: b1.sessionDate, message: 'お客様だけ', todo: ['歩く'], tags: ['有酸素'] });
  ok('6-12 ★結果が分からない＝送り直しの画面（編集させない・社内メモは下書きに残る）', !!kbtn(root, '同じ内容で送り直す') && root.textContent.includes('お客様に見える欄の保存の結果を確かめられませんでした') && !root.querySelector('textarea[aria-label="お客様へ"]') && draftOf(w).mpending && draftOf(w).memo === '社内のこと');
  resp = { success: true, mnoteId: 'M9', rev: 1 };
  kbtn(root, '同じ内容で送り直す').click(); await settle(); await pop(); await settle();
  const s2 = sent.filter((x) => x.action === 'k_saveMemberNote');
  ok('6-13 ★送り直しは同じ送信番号・同じ中身', s2.length === 2 && s2[0].clientReqId === s2[1].clientReqId && s2[1].message === 'お客様だけ');
  ok('6-14 成功したらお客様の欄を消し、社内メモを続けて送る（成功で下書きを消す）', sent.filter((x) => x.action === 'k_addNote').length === 1 && sent.find((x) => x.action === 'k_addNote').body === '社内のこと' && !draftOf(w) && root.textContent.includes('お客様に見える欄も保存しました') && root.textContent.includes('指導メモも保存しました'), root.textContent.slice(0, 200));
  w.KarteUI.close && w.KarteUI.close();
}
{
  //   トレーニングの結果が分からない：member も控えに入り、送り直しで同じ中身
  let n = 0;
  const { w, sent } = kboot(async (b) => {
    if (b.action === 'k_training') return { success: true, karteSchema: 32, sessions: TR_HIST, best: [] };
    if (b.action === 'k_addTraining') return ++n === 1 ? { success: false, code: 'BAD_RESPONSE' } : { success: true, sessionId: 'N1', mnoteId: 'M1', mnoteRev: 1 };
    return { success: true };
  });
  try { w.localStorage.removeItem('karte_tr_draft_v1:T1:C1'); } catch (e) {}
  let root = await openForm(w);
  await withSet(w, root);
  fillMember(w, root, 'いっしょに', [], []);
  kbtn(root, '保存する').click(); await settle(); await pop(); await settle();
  root = w.document.getElementById('karteRoot');
  ok('6-15 ★結果が分からないときもお客様の欄は控えに残り、画面に「一緒に送ります」', draftOf(w).pending.payload.member.message === 'いっしょに' && root.textContent.includes('お客様に見える欄も一緒に送ります'));
  kbtn(root, '同じ内容で送り直す').click(); await settle();
  const s = sent.filter((x) => x.action === 'k_addTraining');
  ok('6-16 送り直しは同じ送信番号・同じ member', s.length === 2 && s[0].clientReqId === s[1].clientReqId && JSON.stringify(s[0].member) === JSON.stringify(s[1].member) && !draftOf(w));
  w.KarteUI.close && w.KarteUI.close();
}

// ================= 7. お客様の見え方（予約ページ＋karte.js を同じ窓で） =================
async function previewEnv(owner, kresp) {
  const w = boot({ bootRes: HOME, fetch: kresp });
  await settle();
  w.__g.state.trainerId = 'T1'; w.__g.state._isOwner = owner; w.__g.state._allTrainers = [{ id: 'T1', name: '一郎' }];
  w.eval(KSRC);
  w.KarteUI.open('C1', '会員', 'summary'); await settle();
  const root = w.document.getElementById('karteRoot');
  kbtn(root, 'お客様の見え方').click(); await settle();
  return { w, root };
}
const PREV = Object.assign({}, KARTE, { notes: [
  { date: '2026-11-02', message: null, todo: [], trainerName: '一郎', mnoteId: 'M0', rev: 1, sessionId: 'S9', authorIsMe: true },
  { date: '2026-11-01', message: 'わたしの枚', todo: ['歩く'], trainerName: '一郎', mnoteId: 'M1', rev: 3, sessionId: 'S1', authorIsMe: true, tags: ['全身'] },
  { date: '2026-10-25', message: 'ほかの人の枚', todo: [], trainerName: '二郎', mnoteId: 'M2', rev: 1, sessionId: null, authorIsMe: false }] });
{
  const kfetch = (b) => {
    if (b.action === 'k_summary') return { success: true, customer: { customerId: 'C1', name: '会員', trainerId: 'T1' }, assigned: true, consent: { state: 'none' }, profile: null, lastNote: null, nextReservation: null };
    if (b.action === 'k_body') return { success: true, ready: true, rows: [] };
    if (b.action === 'k_memberPreview') return PREV;
    if (b.action === 'k_saveMemberNote') return { success: true, mnoteId: 'M1', rev: 4 };
    if (b.action === 'k_deleteMemberNote') return { success: true, mnoteId: 'M1', deleted: true };
    return { success: true };
  };
  const { w, root } = await previewEnv(false, kfetch);
  const pv = w.fetched.filter((b) => b.action === 'k_memberPreview');
  ok('7-1 ★「お客様の見え方」で k_memberPreview を顧客を指定して読む', pv.length === 1 && pv[0].customerId === 'C1' && root.querySelector('.k-entrytitle').textContent === 'お客様の見え方');
  ok('7-2 ★会員の画面と同じ部品で描く（概要の2枚・同じ class）', !!root.querySelector('.k-mpreview .card.mk-card') && root.textContent.includes('目標と進み具合') && root.textContent.includes('直近の指導（11/1）'));
  kbtn(root, '指導の履歴').click(); await settle();
  const cards = [...root.querySelectorAll('.k-mpreview .card')];
  const mine = cards.find((c) => c.textContent.includes('わたしの枚')), other = cards.find((c) => c.textContent.includes('ほかの人の枚'));
  ok('7-3 ★直す・消すは書いた本人の枚だけ（トレーナー）', !!kbtn(mine, '直す') && !!kbtn(mine, '消す') && !kbtn(other, '直す') && !kbtn(other, '消す'));
  ok('7-4 タグだけの枚は見え方の画面では出し、お客様には出ないと書く', root.textContent.includes('日のタグだけの枚・お客様の指導の履歴には出ません'));
  ok('7-5 直す・消すは44px・離して置く（消すは右端）', /\.k-btn\.small\{[^}]*min-height:44px/.test(KSRC) && kbtn(mine, '消す').style.marginLeft === 'auto');
  //   消す：確かめてやめたら送らない
  w.confirm = () => false;
  kbtn(mine, '消す').click(); await settle();
  ok('7-6 ★消すは確認を挟む（やめたら送らない）', !w.fetched.some((b) => b.action === 'k_deleteMemberNote'));
  w.confirm = () => true;
  kbtn(mine, '消す').click(); await settle();
  const del = w.fetched.filter((b) => b.action === 'k_deleteMemberNote');
  ok('7-7 消す＝k_deleteMemberNote {mnoteId, rev}', del.length === 1 && del[0].mnoteId === 'M1' && del[0].rev === 3 && !!del[0].clientReqId && w.fetched.filter((b) => b.action === 'k_memberPreview').length === 2);
  //   直す
  kbtn(root, '指導の履歴').click(); await settle();
  const mine2 = [...root.querySelectorAll('.k-mpreview .card')].find((c) => c.textContent.includes('わたしの枚'));
  kbtn(mine2, '直す').click(); await settle();
  const ta = root.querySelector('.k-mpreview textarea[aria-label="お客様へ"]');
  ok('7-8 直すと今の文と次回までにが入った欄になる', !!ta && ta.value === 'わたしの枚' && root.querySelector('.k-mpreview input[aria-label="次回までに 1つ目"]').value === '歩く');
  ta.value = '直した枚'; ta.dispatchEvent(new w.Event('input', { bubbles: true }));
  kbtn(root, '保存する').click(); await settle();
  const sv = w.fetched.filter((b) => b.action === 'k_saveMemberNote').pop();
  const b2 = Object.assign({}, sv); delete b2.idToken; delete b2.clientReqId;
  eq('7-9 ★編集＝最上位に mnoteId・rev・message・todo（member で包まない・タグは触っていないので送らない）', b2, { action: 'k_saveMemberNote', mnoteId: 'M1', rev: 3, message: '直した枚', todo: ['歩く'] });
  //   全部を空にする編集は画面で止める
  kbtn(root, '指導の履歴').click(); await settle();
  const mine3 = [...root.querySelectorAll('.k-mpreview .card')].find((c) => c.textContent.includes('わたしの枚'));
  kbtn(mine3, '直す').click(); await settle();
  const ta3 = root.querySelector('.k-mpreview textarea[aria-label="お客様へ"]'); ta3.value = ''; ta3.dispatchEvent(new w.Event('input', { bubbles: true }));
  const t3 = root.querySelector('.k-mpreview input[aria-label="次回までに 1つ目"]'); t3.value = ''; t3.dispatchEvent(new w.Event('input', { bubbles: true }));
  ok('7-9b 直す画面は、その枚のタグ（tags）を選んだ状態で出す', [...root.querySelectorAll('.k-mpreview .k-pill.on')].map((b) => b.textContent).includes('全身'));
  [...root.querySelectorAll('.k-mpreview .k-pill.on')].filter((b) => !['概要', '体組成', 'トレーニング', '指導の履歴', '契約'].includes(b.textContent)).forEach((b) => b.click());
  const nSave = w.fetched.filter((b) => b.action === 'k_saveMemberNote').length;
  kbtn(root, '保存する').click(); await settle();
  ok('7-10 ★全部を空にする編集は送らず「消す」を案内', w.fetched.filter((b) => b.action === 'k_saveMemberNote').length === nSave && w.alerts.some((a) => a.includes('「消す」')));
  ok('7-11 ★見え方の画面でも値は文字として', !root.querySelector('img') && !w.pwned);
  w.KarteUI.close && w.KarteUI.close();
}
{
  const { root } = await previewEnv(true, (b) => (b.action === 'k_memberPreview' ? PREV : (b.action === 'k_summary' ? { success: true, customer: { customerId: 'C1', name: '会員' }, consent: { state: 'none' }, profile: null } : { success: true, ready: true, rows: [] })));
  kbtn(root, '指導の履歴').click(); await settle();
  const other = [...root.querySelectorAll('.k-mpreview .card')].find((c) => c.textContent.includes('ほかの人の枚'));
  ok('7-12 ★オーナーは他の人の枚も直す・消すが出る', !!kbtn(other, '直す') && !!kbtn(other, '消す'));
}
{
  //   ★同じ日に2回トレーニングした枚は、それぞれ自分のタグだけ（日付から推測しない・Codex 関門②）
  const D0 = '2026-11-02';
  const nt = (id, msg, sid, tags) => Object.assign({ date: D0, message: msg, todo: [], trainerName: '一郎', mnoteId: id, rev: 1, sessionId: sid, authorIsMe: true }, tags ? { tags } : {});
  const P2 = Object.assign({}, PREV, { notes: [nt('MA', '朝の枚', 'S1', ['脚']), nt('MB', '夜の枚', 'S2', ['背中']), nt('MC', 'トレーニングなしの枚', null, ['胸']), nt('MD', 'タグ不明の枚', 'S3', null)] });
  const { w, root } = await previewEnv(false, (b) => (b.action === 'k_memberPreview' ? P2 : (b.action === 'k_summary' ? { success: true, customer: { customerId: 'C1', name: '会員' }, consent: { state: 'none' }, profile: null } : (b.action === 'k_saveMemberNote' ? { success: true, mnoteId: b.mnoteId, rev: 2 } : { success: true, ready: true, rows: [] }))));
  const DAYS = ['全身', '上半身', '下半身', '脚', '尻', '背中', '胸', '肩', '腕', '体幹', '有酸素', 'ストレッチ'];
  const pills = () => [...root.querySelectorAll('.k-mpreview .k-pill')].filter((b) => DAYS.includes(b.textContent));
  const onTags = () => pills().filter((b) => b.classList.contains('on')).map((b) => b.textContent);
  async function openEdit(text) { kbtn(root, '指導の履歴').click(); await settle(); const cd = [...root.querySelectorAll('.k-mpreview .card')].find((c) => c.textContent.includes(text)); kbtn(cd, '直す').click(); await settle(); }
  await openEdit('朝の枚');
  eq('7-12b ★同じ日の1回目の枚は自分のタグだけ', onTags(), ['脚']);
  //   本文だけ直す＝タグは送らない
  const ta = root.querySelector('.k-mpreview textarea[aria-label="お客様へ"]'); ta.value = '朝の枚（直した）'; ta.dispatchEvent(new w.Event('input', { bubbles: true }));
  kbtn(root, '保存する').click(); await settle();
  const s1 = w.fetched.filter((b) => b.action === 'k_saveMemberNote').pop();
  ok('7-12c 本文だけ直したらタグは送らない', s1 && s1.mnoteId === 'MA' && !('tags' in s1), JSON.stringify(s1));
  await openEdit('夜の枚');
  eq('7-12d ★同じ日の2回目の枚は自分のタグだけ', onTags(), ['背中']);
  pills().find((b) => b.textContent === '胸').click();
  kbtn(root, '保存する').click(); await settle();
  const s2 = w.fetched.filter((b) => b.action === 'k_saveMemberNote').pop();
  eq('7-12e タグを1つ足すと、その枚のタグだけ送る', { id: s2.mnoteId, tags: s2.tags }, { id: 'MB', tags: ['背中', '胸'] });
  await openEdit('トレーニングなしの枚');
  ok('7-12f トレーニングの無い枚はタグを直させない（会員に出ないため）', pills().length === 0);
  await openEdit('タグ不明の枚');
  ok('7-12g ★タグが載っていない枚はタグを直させない（空から作って上書きしない）', pills().length === 0);
  w.KarteUI.close && w.KarteUI.close();
}
{
  //   Worker が全部空の編集を 409（BAD_STATE）で断ったら「消す」を案内（Worker の約束 1）
  const { w, root } = await previewEnv(false, (b) => (b.action === 'k_memberPreview' ? PREV : (b.action === 'k_saveMemberNote' ? { success: false, code: 'BAD_STATE' } : (b.action === 'k_summary' ? { success: true, customer: { customerId: 'C1', name: '会員' }, consent: { state: 'none' }, profile: null } : { success: true, ready: true, rows: [] }))));
  kbtn(root, '指導の履歴').click(); await settle();
  const mine = [...root.querySelectorAll('.k-mpreview .card')].find((c) => c.textContent.includes('わたしの枚'));
  kbtn(mine, '直す').click(); await settle();
  kbtn(root, '保存する').click(); await settle();
  ok('7-13 ★BAD_STATE（全部空）は「消す」を使うよう案内し、画面は編集のまま', w.alerts.some((a) => a.includes('全部を空にするときは「消す」')) && !!root.querySelector('.k-mpreview textarea[aria-label="お客様へ"]'));
}

// ================= 8b. お客様の見え方の編集中にトークンを取り直しても、同じカードで入力が戻る（2026-11-06 関門② 高1） =================
{
  const b64u = (x) => Buffer.from(x).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const jwt = (ageS) => b64u('{"alg":"ES256"}') + '.' + b64u(JSON.stringify({ sub: 'U_TEST', iat: Math.floor(Date.now() / 1000) - ageS })) + '.sig';
  const kfetch = (b) => {
    if (b.action === 'k_summary') return { success: true, customer: { customerId: 'C1', name: '会員', trainerId: 'T1' }, assigned: true, consent: { state: 'none' }, profile: null, lastNote: null, nextReservation: null };
    if (b.action === 'k_memberPreview') return PREV;
    if (b.action === 'k_saveMemberNote') return { success: true, mnoteId: 'M1', rev: 4 };
    return { success: true, ready: true, rows: [] };
  };
  const { w, root } = await previewEnv(false, kfetch);
  w.reloaded = 0; w.__karteReload = () => { w.reloaded++; }; w.logouts = 0; w.liff.logout = () => { w.logouts++; };
  const old = jwt(61 * 60); w.liff.getIDToken = () => old;
  kbtn(root, '指導の履歴').click(); await settle();
  kbtn([...root.querySelectorAll('.k-mpreview .card')].find((c) => c.textContent.includes('わたしの枚')), '直す').click(); await settle();
  const ta = root.querySelector('.k-mpreview textarea[aria-label="お客様へ"]'); ta.value = '読み直しの前に直した文'; ta.dispatchEvent(new w.Event('input', { bubbles: true }));
  const t2 = root.querySelector('.k-mpreview input[aria-label="次回までに 2つ目"]'); t2.value = '水を飲む'; t2.dispatchEvent(new w.Event('input', { bubbles: true }));
  [...root.querySelectorAll('.k-mpreview .k-pill')].find((b) => b.textContent === '脚').click(); await settle();
  const nSave = w.fetched.filter((b) => b.action === 'k_saveMemberNote').length;
  kbtn(root, '保存する').click(); await settle();
  const ss = JSON.parse(w.sessionStorage.getItem('karte_draft_v1') || 'null');
  ok('8b-1 ★古いトークンでは送らず、直していた入力（文・次回までに・触ったタグ・送信番号）を退避して読み直し（アプリの中は logout しない）', w.fetched.filter((b) => b.action === 'k_saveMemberNote').length === nSave && w.reloaded === 1 && w.logouts === 0
     && ss && ss.draft && ss.draft.sub === 'mpreview' && ss.draft.cid === 'C1' && ss.draft.edit.mnoteId === 'M1' && ss.draft.edit.message === '読み直しの前に直した文' && ss.draft.edit.todo[1] === '水を飲む' && ss.draft.edit.tagsTouched === true && !!ss.draft.edit.reqId, JSON.stringify(ss));
  ok('8b-2 ★退避に氏名を残さない', ss && ss.name === '' && !JSON.stringify(ss).includes('会員'), JSON.stringify(ss));
  //   読み直した後（新しいトークン）
  async function after(stash, fetchFn) {
    const w2 = boot({ bootRes: HOME, fetch: fetchFn || kfetch }); await settle();
    for (const [k, v] of Object.entries(stash)) w2.sessionStorage.setItem(k, v);
    w2.__g.state.trainerId = 'T1'; w2.__g.state._isOwner = false; w2.__g.state._allTrainers = [{ id: 'T1', name: '一郎' }];
    w2.eval(KSRC);
    for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 5));
    return w2;
  }
  const stash = { karte_draft_v1: w.sessionStorage.getItem('karte_draft_v1'), karte_reauth: w.sessionStorage.getItem('karte_reauth') };
  const w2 = await after(stash);
  const r2 = w2.document.getElementById('karteRoot');
  const ta2 = r2 && r2.querySelector('.k-mpreview textarea[aria-label="お客様へ"]');
  ok('8b-3 ★読み直した後、お客様の見え方の同じ枚の編集が開き、入力が戻る', !!ta2 && ta2.value === '読み直しの前に直した文' && r2.querySelector('.k-mpreview input[aria-label="次回までに 2つ目"]').value === '水を飲む'
     && [...r2.querySelectorAll('.k-mpreview .k-pill.on')].map((b) => b.textContent).includes('脚'), r2 ? r2.textContent.slice(0, 200) : 'no root');
  kbtn(r2, '保存する').click(); await settle();
  const sv = w2.fetched.filter((b) => b.action === 'k_saveMemberNote').pop();
  ok('8b-4 保存すると同じ送信番号・戻した中身で送る（タグも）・書けたら印を消す', sv && sv.clientReqId === ss.draft.edit.reqId && sv.message === '読み直しの前に直した文' && Array.isArray(sv.tags) && sv.tags.includes('脚') && !w2.sessionStorage.getItem('karte_reauth'), JSON.stringify(sv));
  //   枚がその間に更新されていた（rev が違う）→ 戻さずに知らせる
  const PREV2 = Object.assign({}, PREV, { notes: PREV.notes.map((n) => (n.mnoteId === 'M1' ? Object.assign({}, n, { rev: 4 }) : n)) });
  const w3 = await after(stash, (b) => (b.action === 'k_memberPreview' ? PREV2 : kfetch(b)));
  const r3 = w3.document.getElementById('karteRoot');
  const ta3 = r3 && r3.querySelector('.k-mpreview textarea[aria-label="お客様へ"]');
  ok('8b-5 ★その間に枚が更新されていたら（rev 違い）古い入力で上書きしない・知らせる', !!ta3 && ta3.value === 'わたしの枚' && w3.alerts.some((a) => a.includes('戻せませんでした')));
  //   顧客が違う退避は戻さない
  const bad = JSON.parse(stash.karte_draft_v1); bad.draft.cid = 'C2';
  const w4 = await after({ karte_draft_v1: JSON.stringify(bad), karte_reauth: stash.karte_reauth });
  const r4 = w4.document.getElementById('karteRoot');
  ok('8b-6 ★退避の顧客と開く顧客が違えば、入力を戻さない', !!r4 && !r4.querySelector('.k-mpreview textarea[aria-label="お客様へ"]'));
}

// ================= 9. 自重（重量0）は「自重」と出す（2026-11-06） =================
{
  const BW = JSON.parse(JSON.stringify(KARTE));
  BW.training = { sessions: [{ date: '2026-11-01', items: [{ exercise: 'ディップス', sets: [{ setNo: 1, weight: 0, reps: 12 }, { setNo: 2, weight: 0, reps: 10 }] }, { exercise: 'チンニング', sets: [{ setNo: 1, weight: 0, reps: 8 }, { setNo: 2, weight: 5, reps: 6 }] }], tags: [] }],
    best: [{ exercise: 'ディップス', weight: 0, reps: 12, date: '2026-11-01' }] };
  for (const [lang, word] of [['ja', '自重'], ['en', 'Bodyweight']]) {
    const w = boot({ bootRes: KON, lang, fetch: () => BW }); await settle();
    tab(w, 'training').click(); await settle();
    const tt = $(w, 'mkBody').textContent;
    ok('9-1 ★会員のトレーニング：重量0は「' + word + '」（前回・混ざるときも）・0kg と出さない（' + lang + '）', tt.includes(word + ' × 12・10') && tt.includes(word + '×8・5kg×6') && !tt.includes('0kg'), tt.slice(0, 300));
    ok('9-2 自己ベストも「' + word + '」・自重だけの種目は推移の線を出さない（' + lang + '）', tt.includes(word + ' × 12') && !$(w, 'mkBody').querySelector('svg.mk-chart'), tt.slice(0, 300));
  }
}

// ================= 14. 補助・ドロップ・数字の無い種目（設計38 §6-2）。無理やりのセットは応答に無い（Worker の SQL で外す＝I67） =================
{
  //   Worker（lib/member-karte.js）の本物の形：セットは assist を必ず持つ（印なしは null）・drops は見せる段があるときだけ・数字の無い種目は { sets: [], done: true }
  const X = JSON.parse(JSON.stringify(KARTE));
  X.training = { sessions: [
    { date: '2026-10-25', items: [{ exercise: 'スクワット', sets: [{ setNo: 1, weight: 55, reps: 10, assist: null }] }], tags: [] },
    { date: '2026-11-03', items: [
      { exercise: 'ヒップリフト', sets: [{ setNo: 1, weight: 50, reps: 10, assist: 5 }] },
      { exercise: 'フロアアブ', sets: [{ setNo: 1, weight: 10, reps: 10, assist: null, drops: [{ weight: 0, reps: 10, assist: null }] }] },
      { exercise: '腸腰筋ストレッチ', sets: [], done: true },
      { exercise: 'スクワット', sets: [{ setNo: 1, weight: 60, reps: 10, assist: null }] },
      { exercise: 'スクワット', sets: [{ setNo: 1, weight: 50, reps: 8, assist: null }] }], tags: [] }],
    best: [{ exercise: 'スクワット', weight: 60, reps: 10, date: '2026-11-03' }] };
  const L = { ja: ['+補助5回', 'ドロップ', '実施', '5種目・4セット'], en: ['+5 assisted', 'Drop set', 'Done', '5 exercises · 4 sets'], zh: ['+辅助5次', '递减组', '已完成', '5个动作・4组'], 'zh-Hant': ['+輔助5次', '遞減組', '已完成', '5個動作・4組'] };
  for (const [lang, [as, dr, dn, cnt]] of Object.entries(L)) {
    const w = boot({ bootRes: KON, lang, fetch: () => X }); await settle();
    tab(w, 'training').click(); await settle();
    const body = $(w, 'mkBody');
    const lastCard = body.querySelector('.mk-card');
    const rows = [...lastCard.querySelectorAll('.mk-exrow')];
    const rowOf = (n) => rows.filter((r) => r.firstChild.firstChild.textContent === n);
    const bw = lang === 'en' ? 'Bodyweight' : '自重';
    ok('14-1 ★補助：「50kg×10 ' + as + '」（' + lang + '）', rowOf('ヒップリフト')[0] && rowOf('ヒップリフト')[0].lastChild.textContent === '50kg×10 ' + as, rows.map((r) => r.textContent).join(' | '));
    ok('14-2 ★ドロップ：「10kg×10 → ' + bw + '×10」・その行にだけ「' + dr + '」のチップ（' + lang + '）', rowOf('フロアアブ')[0] && rowOf('フロアアブ')[0].lastChild.textContent === '10kg×10 → ' + bw + '×10' && rowOf('フロアアブ')[0].querySelector('.mk-dropchip').textContent === dr && lastCard.querySelectorAll('.mk-dropchip').length === 1);
    ok('14-3 ★数字の無い種目は名前の右に「' + dn + '」（' + lang + '）', rowOf('腸腰筋ストレッチ')[0] && rowOf('腸腰筋ストレッチ')[0].lastChild.textContent === dn);
    ok('14-4 ★同じ名前の2つの種目は2行（応答の items の順）・mk_counts は種目5（数字の無い種目を含む）・セット4（ドロップは数えない）（' + lang + '）', rowOf('スクワット').length === 2 && rowOf('スクワット')[0].lastChild.textContent === '60kg × 10' && rowOf('スクワット')[1].lastChild.textContent === '50kg × 8' && lastCard.textContent.includes(cnt), lastCard.textContent);
    ok('14-5 値は文字として（要素を作らない）（' + lang + '）', !body.querySelector('img') && !w.pwned);
  }
  //   日別・自己ベスト・推移が同じ集合から作られて一致する（スクワット：日別の最大 60・自己ベスト 60×10・推移 55→60）
  const w = boot({ bootRes: KON, lang: 'ja', fetch: () => X }); await settle();
  tab(w, 'training').click(); await settle();
  const body = $(w, 'mkBody');
  ok('14-6 数字の無い種目（推移が無い）は推移の選ぶ欄に出さない', ![...body.querySelectorAll('.mk-pill')].some((b) => b.textContent === '腸腰筋ストレッチ'));
  [...body.querySelectorAll('.mk-pill')].find((b) => b.textContent === 'スクワット').click(); await settle();
  const svg = body.querySelector('svg.mk-chart');
  ok('14-7 ★日別・自己ベスト・推移が一致（推移の最後＝60kg・自己ベスト 60kg × 10・日別の最大 60kg）', !!svg && /60kg/.test(svg.getAttribute('aria-label')) && /55kg/.test(svg.getAttribute('aria-label')) && body.textContent.includes('60kg × 10（11/3）') && body.textContent.includes('60kg × 10'), svg && svg.getAttribute('aria-label'));
}

console.log('');
console.log(`${fail ? '❌' : '✅'} 会員画面 C2（設計35） 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
