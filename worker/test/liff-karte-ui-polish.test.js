// 設計55 カルテの画面の使いやすさ（片手で迷わず速く）：本番の liff/karte.js を jsdom で動かし、入口から描いて値で確かめる・2026-11-24
//   実行: node worker/test/liff-karte-ui-polish.test.js
//
//   U1 種目が空のときの案内が、実在するボタンの名前だけを言う
//   U2 セットの × は ✎ の中へ（全部の幅で5列）
//   U3 外す・セットを消すの直後に「〇〇を外しました［元に戻す］」（確認のダイアログは増やさない・休憩の帯と下書きも戻す）
//   U4 前回の行 14px ネイビー・番号 15px・見出し 12px
//   U5 終了音は上部に1つ・種目ごとは秒数だけを「＋ セット」の行へ
//   U6 取り込みの画面：AI が使えるときは「AIで振り分ける」が塗り・「読み取る」が枠・入力欄6行（使えないときは今までどおり）
//   U7 下のタブ：上にアイコン（インライン SVG）・下にラベル1行（11px）
//   U8 記録の画面：保存は見出しの右上・下の帯は種目の欄を開いている間の［選んだ種目を足す］だけ
//   ★身代わりは fetch（Worker）・LINE の SDK だけ。名前はすべて架空

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
const b64u = (s) => Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (ageS) => b64u(JSON.stringify({ alg: 'ES256' })) + '.' + b64u(JSON.stringify({ iss: 'https://access.line.me', sub: 'U_TEST', iat: Math.floor(Date.now() / 1000) - ageS, exp: Math.floor(Date.now() / 1000) + 3600 })) + '.sig';

const HIST = [{ session_id: 'P1', session_date: '2026-10-25', created_at: 100, author_trainer_id: 'T1', rev: 1, sets: [
  { exercise: 'スクワット', set_no: 1, weight_kg: 50, reps: 10 }, { exercise: 'スクワット', set_no: 2, weight_kg: 50, reps: 8 }] }];

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
  w.liff = { getIDToken: () => w.idToken, logout: () => {} };
  w.cfg = Object.assign({ sessions: [], aiDraft: true, aiConsent: 'agreed', hangSave: false }, o);
  w.fetch = async (url, opt) => {
    const body = JSON.parse(opt.body);
    sent.push(body);
    const c = w.cfg;
    let r;
    if (body.action === 'k_training') r = { success: true, karteSchema: 33, aiDraft: c.aiDraft, aiConsent: c.aiConsent, sessions: c.sessions, best: [] };
    else if (body.action === 'k_exercises') r = { success: true, karteSchema: 33, exercises: [{ name: 'ベンチプレス', part: 'chest' }], truncated: false };
    else if (body.action === 'k_summary') r = { success: true, karteSchema: 33, customer: { name: '会員', trainerId: 'T1' }, hearing: null, consent: { state: 'agreed' } };
    else if (body.action === 'k_addTraining') {
      if (c.hangSave) await new Promise((res) => { w.releaseSave = res; });
      r = { success: true, sessionId: 'N1', rev: 1 };
    }
    else r = { success: true };
    return { json: async () => JSON.parse(JSON.stringify(r)) };
  };
  w.eval(SRC);
  return { w, sent };
}
const R = (w) => w.document.getElementById('karteRoot');
const btn = (root, t) => [...root.querySelectorAll('button')].find((x) => x.textContent.indexOf(t) === 0);
const btns = (root, t) => [...root.querySelectorAll('button')].filter((x) => x.textContent.indexOf(t) === 0);
const DKEY = 'karte_tr_draft_v1:T1:C1';
const draftOf = (w) => JSON.parse(w.localStorage.getItem(DKEY) || 'null');
const names = (w) => (draftOf(w) || { items: [] }).items.map((x) => x.exercise);
const TODAY = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const set = (w0, r0, done, extra) => Object.assign({ w: String(w0), r: String(r0), done: done }, extra || {});
function seed(w, items, extra) { w.localStorage.setItem(DKEY, JSON.stringify(Object.assign({ v: 1, tid: 'T1', cid: 'C1', sessionDate: TODAY, items, reqId: 'kreq1', pending: null, at: Date.now(), openEi: 0 }, extra || {}))); }
async function openRecord(w) { w.KarteUI.open('C1', '会員', 'training'); await settle(); const b0 = btn(R(w), '記録の入力（途中）を開く') || btn(R(w), '＋ 今日の記録'); if (b0) { b0.click(); await settle(); } }
const ITEMS = () => [
  { exercise: 'ベンチプレス', sets: [set(50, 10, true, { note: 'メモA' }), set(50, 8, false)] },
  { exercise: 'スクワット', sets: [set(60, 8, true)] },
  { exercise: 'レッグプレス', sets: [set(100, 12, false)] }];
const exBlock = (w, ei) => R(w).querySelector('[data-ei="' + ei + '"]');
const undoBar = (w) => R(w).querySelector('.k-undo');
const restHost = (w) => { const b = R(w).querySelector('.k-restbar'); if (!b || !b.children.length) return null; const h = b.closest('[data-ei]'); return h ? h.getAttribute('data-ei') : 'top'; };
const shown = (w, e) => !!e && w.getComputedStyle(e).display !== 'none';
//   ✎ を押すとセットに memoOpen（画面の開閉の印）が付く＝中身の比べ合わせからは外す
const itemsOf = (w) => JSON.stringify((draftOf(w) || { items: [] }).items, (k, v) => (k === 'memoOpen' ? undefined : v));

// ================= U1 種目が空のときの案内 =================
for (const [label, sessions] of [['過去の記録なし', []], ['過去の記録あり', HIST]]) {
  const { w } = boot({ sessions });
  await openRecord(w);
  const m = [...R(w).querySelectorAll('.k-msg')].map((x) => x.textContent).find((t) => t.includes('始めてください')) || '';
  const quoted = [...m.matchAll(/「([^」]+)」/g)].map((x) => x[1]);
  ok('U1 ★' + label + '：案内の「」の中は、画面に実在するボタンの名前だけ', quoted.length >= 1 && quoted.every((q) => !!btn(R(w), q)), m);
  ok('U1 ' + label + '：「前回の内容で始める」（存在しないボタン）を言わない', !R(w).textContent.includes('前回の内容で始める'));
}

// ================= U2 セットの × は ✎ の中へ =================
{
  const { w } = boot();
  seed(w, ITEMS());
  await openRecord(w);
  const rows = [...exBlock(w, 0).querySelectorAll('.k-setrow')].filter((r) => r.querySelector('input'));
  ok('U2 ★セットの行に × のボタンが無い（✎ の右に消すボタンを置かない）', rows.length === 2 && rows.every((r) => !r.querySelector('.k-setdel') && ![...r.querySelectorAll('button')].some((b) => /消す/.test(b.getAttribute('aria-label') || ''))));
  ok('U2 セットの行は5列（番号・重量・回数・✓・✎）', rows.every((r) => r.children.length === 5), rows.map((r) => r.children.length).join(','));
  ok('U2 ★5列の幅の指定（22px 1fr 1fr 44px 44px）が既定', /#karteRoot \.k-setrow\{display:grid;grid-template-columns:22px minmax\(0,1fr\) minmax\(0,1fr\) 44px 44px;/.test(SRC));
  ok('U2 行のボタンは44px以上', rows.every((r) => [...r.querySelectorAll('button')].every((b) => /min-width:\s*44px/.test(b.style.cssText) && /min-height:\s*44px/.test(b.style.cssText))));
  exBlock(w, 0).querySelector('button[aria-label="2セット目のメモ"]').click(); await settle();
  const del = btn(exBlock(w, 0), 'このセットを消す');
  ok('U2 ★✎ を開くと「このセットを消す」が見える（どの幅でも）', shown(w, del), del && w.getComputedStyle(del).display);
}

// ================= U3 外す → 元に戻す（種目） =================
{
  const { w } = boot();
  seed(w, ITEMS(), { openEi: 1 });
  await openRecord(w);
  //   レッグプレスに✓ → 休憩の帯はレッグプレス（2番）に付く。ただし開いている種目しかセットが出ないので、開いてから押す
  btn(R(w), 'レッグプレス').click(); await settle();
  exBlock(w, 2).querySelector('button[aria-label="1セット目を実施済みにする"]').click(); await settle();
  ok('U3 前提：休憩の帯はレッグプレス（2番）', restHost(w) === '2', restHost(w));
  btn(R(w), 'スクワット').click(); await settle();   // スクワットを開く
  const before = JSON.stringify(draftOf(w).items);
  const openBefore = draftOf(w).openEi;
  btn(exBlock(w, 1), '外す').click(); await settle();
  ok('U3 外すとすぐ消える（確認のダイアログを出さない）', JSON.stringify(names(w)) === '["ベンチプレス","レッグプレス"]' && w.confirms === 0 && w.alerts.length === 0, JSON.stringify(names(w)));
  ok('U3 休憩の帯は外した後も同じ種目（レッグプレス＝1番）', restHost(w) === '1', restHost(w));
  const ub = undoBar(w);
  const ubtn = ub && btn(ub, '元に戻す');
  ok('U3 ★直後に「スクワットを外しました［元に戻す］」・44px 以上・読み上げ', !!ub && ub.textContent.indexOf('スクワットを外しました') === 0 && !!ubtn && /min-height:\s*44px/.test(ubtn.style.cssText) && ub.getAttribute('role') === 'status');
  ubtn.click(); await settle();
  ok('U3 ★元に戻すと、同じ位置に・セット・✓・メモごと戻る（下書きも）', JSON.stringify(draftOf(w).items) === before, JSON.stringify(draftOf(w).items));
  ok('U3 開いていた種目も戻る', draftOf(w).openEi === openBefore, String(draftOf(w).openEi));
  ok('U3 元に戻した後は案内が消える', !undoBar(w));
  btn(R(w), 'レッグプレス').click(); await settle();   // 帯は開いている種目の中にだけ出る
  ok('U3 ★休憩の帯も元の種目（レッグプレス＝2番）に戻る', restHost(w) === '2', restHost(w));
}
// ---- 休憩の帯を持っていた種目を外す → 止まる → 元に戻すと続きから ----
{
  const { w } = boot();
  seed(w, ITEMS(), { openEi: 2 });
  await openRecord(w);
  exBlock(w, 2).querySelector('button[aria-label="1セット目を実施済みにする"]').click(); await settle();
  ok('U3b 前提：休憩を数えている', restHost(w) === '2' && /休憩 \d:\d\d/.test(R(w).querySelector('.k-restbar').textContent));
  btn(exBlock(w, 2), '外す').click(); await settle();
  ok('U3b 帯を持つ種目を外すと休憩は止まる（今までどおり）', restHost(w) === null);
  btn(undoBar(w), '元に戻す').click(); await settle();
  ok('U3b ★元に戻すと休憩の帯が戻り、数え続ける', restHost(w) === '2' && /休憩 \d:\d\d/.test(R(w).querySelector('.k-restbar').textContent), restHost(w));
}
// ---- セットを消す → 元に戻す・次の操作で案内は消える ----
{
  const { w } = boot();
  seed(w, ITEMS());
  await openRecord(w);
  const before = itemsOf(w);
  exBlock(w, 0).querySelector('button[aria-label="1セット目のメモ"]').click(); await settle();
  btn(exBlock(w, 0), 'このセットを消す').click(); await settle();
  ok('U3c セットを消すとすぐ消える', draftOf(w).items[0].sets.length === 1 && w.confirms === 0);
  ok('U3c ★「ベンチプレスの1セット目を消しました［元に戻す］」', !!undoBar(w) && undoBar(w).textContent.indexOf('ベンチプレスの1セット目を消しました') === 0, undoBar(w) && undoBar(w).textContent);
  btn(undoBar(w), '元に戻す').click(); await settle();
  ok('U3c ★元に戻すと同じ位置に・メモごと戻る', itemsOf(w) === before, itemsOf(w));
  exBlock(w, 0).querySelector('button[aria-label="1セット目のメモ"]');   // 開いたまま
  btn(exBlock(w, 0), 'このセットを消す').click(); await settle();
  exBlock(w, 0).querySelector('button[aria-label="1セット目を実施済みにする"]').click(); await settle();
  ok('U3c ★次の操作（✓）をしたら案内は消える＝古い「元に戻す」を後から押せない', !undoBar(w));
}
// ---- セットが1つの種目でセットを消す＝種目が消える → 元に戻す ----
{
  const { w } = boot();
  seed(w, ITEMS(), { openEi: 1 });
  await openRecord(w);
  const before = itemsOf(w);
  exBlock(w, 1).querySelector('button[aria-label="1セット目のメモ"]').click(); await settle();
  btn(exBlock(w, 1), 'このセットを消す').click(); await settle();
  ok('U3d 最後のセットを消すと種目ごと消える（今までどおり）', JSON.stringify(names(w)) === '["ベンチプレス","レッグプレス"]');
  btn(undoBar(w), '元に戻す').click(); await settle();
  ok('U3d ★元に戻すと種目ごと戻る', itemsOf(w) === before, itemsOf(w));
}

// ================= U4 文字の大きさ =================
{
  const { w } = boot({ sessions: HIST });
  seed(w, [{ exercise: 'スクワット', sets: [set(50, 10, false)] }]);
  await openRecord(w);
  const pv = R(w).querySelector('.k-prev');
  ok('U4 ★前回の行は14px・ネイビー', !!pv && pv.textContent.indexOf('前回 10/25') === 0 && /font-size:\s*14px/.test(pv.style.cssText) && /color:\s*var\(--k-acc\)/.test(pv.style.cssText), pv && pv.style.cssText);
  const no = R(w).querySelector('.k-setno');
  ok('U4 セットの番号は15px', !!no && no.textContent === '1' && /font-size:\s*15px/.test(no.style.cssText));
  const hd = R(w).querySelector('.k-sethead');
  ok('U4 セットの見出しは12px', !!hd && /font-size:\s*12px/.test(hd.style.cssText) && hd.textContent.includes('重量 kg'));
}

// ================= U5 終了音は上部に1つ・秒数は「＋ セット」の行 =================
{
  const { w } = boot();
  seed(w, ITEMS());
  await openRecord(w);
  const snd = btns(R(w), '終了音');
  ok('U5 ★終了音の切り替えは画面に1つ・種目の中に無い', snd.length === 1 && !snd[0].closest('[data-ei]'), String(snd.length));
  const sel = R(w).querySelector('select[aria-label="ベンチプレスの休憩の秒数"]');
  const add = btn(exBlock(w, 0), '＋ セット');
  ok('U5 ★種目ごとの秒数は「＋ セット」と同じ行', !!sel && !!add && sel.parentNode === add.parentNode && /min-height:\s*44px/.test(sel.style.cssText));
  ok('U5 種目の中に終了音・説明の行が無い', !exBlock(w, 0).textContent.includes('終了音') && !exBlock(w, 0).querySelector('.k-restrow'));
  snd[0].click(); await settle();
  ok('U5 終了音を切り替えると端末に覚える', w.localStorage.getItem('karte_rest_sound') === 'off' && btn(R(w), '終了音').textContent === '終了音：なし' && btn(R(w), '終了音').getAttribute('aria-pressed') === 'false');
  btn(R(w), '休憩タイマー').click(); await settle();
  ok('U5 休憩タイマーなしなら終了音も秒数も出さない', !btn(R(w), '終了音') && !R(w).querySelector('select[aria-label$="休憩の秒数"]'));
}

// ================= U6 取り込みの画面のボタンの強弱 =================
async function openImport(w) { await openRecord(w); btn(R(w), 'メモから取り込む').click(); await settle(); }
{
  const { w } = boot({ aiDraft: true, aiConsent: 'agreed' });
  await openImport(w);
  const ai = btn(R(w), 'AIで振り分ける'), rd = btn(R(w), '読み取る');
  ok('U6 ★AI が使えて同意あり：「AIで振り分ける」が塗り・「読み取る」が枠', !!ai && !!rd && !ai.classList.contains('out') && ai.classList.contains('k-btn') && rd.classList.contains('out'), (ai && ai.className) + ' / ' + (rd && rd.className));
  const ta = R(w).querySelector('textarea[aria-label="メモを貼る"]');
  ok('U6 ★入力欄は6行', !!ta && ta.getAttribute('rows') === '6');
}
for (const [label, o] of [['同意なし', { aiDraft: true, aiConsent: 'none' }], ['同意を確かめられない', { aiDraft: true, aiConsent: 'unknown' }], ['AI 無効', { aiDraft: false, aiConsent: 'agreed' }]]) {
  const { w } = boot(o);
  await openImport(w);
  const rd = btn(R(w), '読み取る');
  ok('U6 ★' + label + '：AI のボタンは出ない・「読み取る」は塗り（今までどおり）', !btn(R(w), 'AIで振り分ける') && !!rd && !rd.classList.contains('out'), rd && rd.className);
}

// ================= U7 下のタブ：アイコン＋ラベル1行 =================
{
  const { w } = boot();
  w.KarteUI.open('C1', '会員', 'summary'); await settle();
  const tabs = [...R(w).querySelectorAll('.k-tab')];
  const LABELS = ['概要', '体組成', 'トレーニング', '指導の履歴', '契約・会員'];
  ok('U7 ★タブは5つ・ラベルは今の文言のまま', tabs.length === 5 && JSON.stringify(tabs.map((t) => t.textContent)) === JSON.stringify(LABELS), JSON.stringify(tabs.map((t) => t.textContent)));
  ok('U7 ★各タブに SVG のアイコン（24px・線＝currentColor・外部読み込みなし）とラベル', tabs.every((t) => { const s = t.querySelector('svg'); const l = t.querySelector('.k-tab-l'); return !!s && s.namespaceURI === 'http://www.w3.org/2000/svg' && s.getAttribute('width') === '24' && s.getAttribute('stroke') === 'currentColor' && s.getAttribute('fill') === 'none' && s.getAttribute('aria-hidden') === 'true' && s.children.length >= 2 && !s.querySelector('image,use') && !!l; }));
  ok('U7 ラベルは11px・折り返さない・タブは56px以上', /#karteRoot \.k-tab\{min-height:56px;[^}]*font-size:11px;[^}]*white-space:nowrap;/.test(SRC) && !/@media \(min-width:400px\)\{#karteRoot \.k-tab\{/.test(SRC));
  //   390px 幅の5等分＝78px。左右の余白（タブの帯 4px・タブ 2px）を除いて 11px×文字数が収まるか（全角を1字 11px とする）
  const col = (390 - 8) / 5 - 4;
  ok('U7 ★390px 幅で一番長いラベル（トレーニング）も1行に収まる計算', LABELS.every((s) => s.length * 11 <= col), String(col));
  ok('U7 選んだタブだけ on・aria-selected', tabs[0].classList.contains('on') && tabs[0].getAttribute('aria-selected') === 'true' && tabs.slice(1).every((t) => !t.classList.contains('on') && t.getAttribute('aria-selected') === 'false'));
  tabs[3].click(); await settle();
  const on = R(w).querySelector('.k-tab.on');
  ok('U7 ★押すと切り替わる（指導の履歴）', !!on && on.textContent === '指導の履歴' && on.getAttribute('aria-selected') === 'true');
}

// ================= U8 記録の画面：保存は見出し・下の帯は種目の欄だけ =================
{
  const { w, sent } = boot({ sessions: HIST });
  seed(w, ITEMS());
  await openRecord(w);
  const head = R(w).querySelector('.k-entryhead');
  const hs = head && head.querySelector('button.k-hsave');
  ok('U8 ★保存は見出しの右上（44px 以上）', !!hs && hs.textContent === '保存する' && head.lastElementChild === hs && /#karteRoot \.k-hsave\{[^}]*min-height:44px;/.test(SRC));
  const bars = () => [...R(w).querySelectorAll('.k-trform .k-savebar')];
  ok('U8 ★何も開いていないときは下の帯を出さない・帯に保存のボタンが無い', bars().every((b) => !shown(w, b)) && !bars().some((b) => btn(b, '保存する')));
  ok('U8 決まった説明文（まとめて保存し…）を出さない', !R(w).textContent.includes('まとめて保存し'));
  //   見出しの日付：透明な日付の入力欄は日付の文字の部分だけ（保存・タイトルを覆わない）
  const ov = head.querySelector('.k-dateover');
  ok('U8 ★日付の入力欄は日付の文字の部分の中だけ（保存のボタン・タイトルを覆わない）', !!ov && !!ov.closest('.k-datehit') && !ov.closest('.k-datehit').contains(hs) && !ov.closest('.k-datehit').contains(head.querySelector('.k-entrytitle')) && /\d+\/\d+\(.\) ▾/.test(ov.closest('.k-datehit').textContent));
  ok('U8 見出しの名前と日付は今までどおり', / 様 ／ \d+\/\d+\(.\)/.test(head.querySelector('.k-entrydate').textContent));
  btn(R(w), '＋ 種目を足す').click(); await settle();
  const pb = bars().find((b) => shown(w, b));
  const go = pb && btn(pb, '選んだ');
  ok('U8 ★種目の欄を開くと下の帯に［選んだ種目を足す］（選ぶまで押せない）', !!pb && !!go && go.disabled === true && !btn(pb, '保存する'));
  ok('U8 「＋ 種目を足す」は開いていることを読み上げる', btn(R(w), '＋ 種目を足す').getAttribute('aria-expanded') === 'true');
  ok('U8 キーパッドが出ている間も種目の欄の帯は下に止まる（ほかの帯は今までどおり static）', /#karteRoot\.k-kb \.k-savebar\{position:static;\}',\n    '#karteRoot\.k-kb \.k-pickbar\{position:sticky;\}/.test(SRC));
  ok('U8 下の帯は前に出る（z-index 3）・種目の欄の決定ボタンは帯の中で止まる（76px に浮かせない）', /#karteRoot \.k-savebar\{position:sticky;bottom:0;z-index:3;/.test(SRC) && !/\.k-picker-go\{position:sticky;bottom:76px/.test(SRC) && w.getComputedStyle(go).position !== 'sticky');
  [...R(w).querySelectorAll('button.k-pill')].find((x) => x.textContent === 'ベンチプレス').click(); await settle();
  ok('U8 選ぶと押せる・数が出る', go.disabled === false && go.textContent === '選んだ 1 種目を足す', go.textContent);
  go.click(); await settle();
  ok('U8 ★足すと種目の欄が閉じ、下の帯も消える', bars().every((b) => !shown(w, b)) && names(w).length === 4);
  btn(R(w), '＋ 種目を足す').click(); await settle();
  ok('U8 もう一度開くと帯が出る', bars().some((b) => shown(w, b)));
  btn(R(w), '＋ 種目を足す').click(); await settle();
  ok('U8 ★閉じると帯が消える', bars().every((b) => !shown(w, b)) && btn(R(w), '＋ 種目を足す').getAttribute('aria-expanded') === 'false');
  //   見出しの保存 → 今までの保存の経路（buildPayload の中身・未✓の確認）
  const expect = JSON.stringify(w.KarteUI._t.buildPayload(draftOf(w).items));
  w.cfg.hangSave = true;
  R(w).querySelector('.k-entryhead button.k-hsave').click(); await settle();
  const add = sent.filter((x) => x.action === 'k_addTraining');
  ok('U8 ★見出しの保存で今までの経路が動く（未✓の確認が1回・送る items は buildPayload のまま）', w.confirms === 1 && add.length === 1 && JSON.stringify(add[0].items) === expect, JSON.stringify(add.map((x) => x.items)));
  const hs2 = R(w).querySelector('.k-entryhead button.k-hsave');
  ok('U8 ★送信中は見出しの保存も押せない（送信中…）', !!hs2 && hs2.disabled === true && hs2.textContent === '送信中…');
  hs2.disabled = false; hs2.click(); await settle();   // 押せたとしても二重には送らない
  ok('U8 ★送信中にもう一度押しても二重に送らない', sent.filter((x) => x.action === 'k_addTraining').length === 1);
  w.releaseSave(); await settle();
  ok('U8 保存後の画面（記録しました）では見出しの保存を出さない', R(w).textContent.includes('記録しました') && !R(w).querySelector('.k-entryhead button.k-hsave'));
}

console.log(`liff-karte-ui-polish: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
