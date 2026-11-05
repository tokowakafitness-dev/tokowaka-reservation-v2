// トレーナーの予約ページ（カルテと同じ配色・作り＝モック P1〜P6・2026-11-06）を jsdom で動かす
//   実行: node worker/test/liff-staff.test.js
//
//   ★部品ではなく入口から：本番の liff/index.html からトレーナー画面の描画部分（renderTrainerAdmin〜startProxyReservation の手前）と
//     画面の切り替え（show・代行の帯）をそのまま取り出し、通信などは身代わりにして描かせる
//     1. 見た目はトレーナーの時だけ（body.staff）。会員の画面に効く指定を足していない
//     2. 名前・日時・点検の中身は文字として入れる（HTML にしない）
//     3. 戻る（data-back＝端末の戻る・横スワイプ）は見出しの行に作り替えても効く
//     4. 消す操作はコーラル・上に「カルテを開く」「＋ 予約を代行」・チケット補充はカード
//     5. 未登録客の枠：種別はボタン→今までの選択欄に入れて送る（送る中身は変わらない）
//     6. 代行・変更の帯はトレーナーの時だけ、トレーナー選び・空き枠・確認の画面に出る
//     7. オーナーだけの操作はオーナーにだけ・絵文字の色分けをやめた

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
async function settle() { for (let i = 0; i < 6; i++) await tick(); }

const BODY = HTML.slice(HTML.indexOf('<body>') + 6, HTML.indexOf('<script'));
const STYLE = HTML.slice(HTML.indexOf('<style>') + 7, HTML.indexOf('</style>'));
const A = HTML.indexOf('  function renderTrainerAdmin(res){');
const Z = HTML.indexOf('  function startProxyReservation(');
const REGION = HTML.slice(A, Z);
const GOHOME = (HTML.match(/  function goHome\(\)\{[\s\S]*?\n  \}\n/) || [])[0] || '';
const SHOW = (HTML.match(/  var SCREENS = \[[^\]]+\];\n[\s\S]*?\n  function show\(id\)\{[\s\S]*?\n  \}\n  \/\/   代行・変更の帯[\s\S]*?\n  function _staffBanner\(id\)\{[\s\S]*?\n  \}\n/) || [])[0] || '';
ok('0-1 本番の HTML からトレーナー画面の描画と画面の切り替えを取り出せる', A > 0 && Z > A && SHOW.length > 0);

function boot(opts) {
  const o = opts || {};
  const dom = new JSDOM('<!doctype html><html><head><style>' + STYLE + '</style></head><body>' + BODY + '</body></html>', { runScripts: 'outside-only', url: 'https://reservation.tokowaka-gym.com/liff/' });
  const w = dom.window;
  w.sent = []; w.alerts = []; w.alert = (m) => w.alerts.push(String(m)); w.confirm = () => true;
  w.KarteUI = { openBoard: () => { w.boardOpened = 1; }, open: (id, n, tab) => { w.karteOpened = [id, n, tab]; } };
  w.eval(`
    var state = { trainerId:'T1', trainerName:'一郎', myTrainerId:'T1', _isOwner:${!!o.owner}, _trainerResv:${JSON.stringify(o.resv || [])}, _trainerCustomers:${JSON.stringify(o.custs || [])}, proxyMode:false, proxyCustomerName:'', changeMode:false, _fromTrainerAdmin:false };
    var _showGen = 0;
    function api(p){ window.sent.push(p); return Promise.resolve(${JSON.stringify(o.apiResp || { success: true })}); }
    function dbg(){} function showError(m){ window.lastError = m; }
    function t(k){ return ({ recur_title:'固定枠の自動予約', recur_desc:'毎月25日に翌月分を自動で予約します。' })[k] || k; }
    function fetchCustomerCard(){} function refreshCustomerHome(id, card){ card.textContent = '今月の残り 5回'; }
    function _buildRecurSection(box){ box.textContent = '固定枠の一覧'; }
    function trainerCancel(r){ window.cancelled = r.reservationId; } function startTrainerChange(r){ window.changed = r.reservationId; } function ownerFreeCancel(r){ window.freeCancelled = r.reservationId; }
    function loadTrainers(){ window.trainersLoaded = 1; }
    function loadHome(){ window.wentMemberHome = 1; }
    function loadSlots(){}
  ` + SHOW + REGION + GOHOME + `
    function startProxyReservation(id, name){ state.proxyMode = true; state.proxyCustomerName = name; window.proxyStarted = [id, name]; }
    window.__t = { state: state, show: show, renderTrainerAdmin: renderTrainerAdmin, renderCustomerList: renderCustomerList, renderCustomerDetail: renderCustomerDetail,
      renderAdminHoldForm: renderAdminHoldForm, renderBlockForm: renderBlockForm, renderHealthBoard: renderHealthBoard, renderPaceBoard: renderPaceBoard, _startTrainerChangeGo: typeof _startTrainerChangeGo === 'function' ? _startTrainerChangeGo : null };
  `);
  return w;
}
const btnT = (root, t) => [...root.querySelectorAll('button')].find((x) => x.textContent.indexOf(t) === 0);

// ================= 1. 見た目はトレーナーの時だけ =================
{
  const added = STYLE.slice(STYLE.indexOf('/* ★トレーナーで開いたときだけ'));
  const rules = added.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map((x) => x.trim()).filter(Boolean).map((x) => x.split('{')[0].trim());
  const memberClasses = /(^|[ ,])(header|\.card|\.btn|\.btn-outline|\.muted|\.big|\.sect-h|\.screen|\.trainer|\.hlabel|\.home-row|input|select|textarea|body)\b/;
  const STAFF_ONLY = /^\.(slist|srow|schip|sgrid2|sgrid3|slab|sbtns|sseg|ssave|shead|sback|stx|stt|sst|sbanner)\b/;   // トレーナー画面にしかない部品
  const leak = rules.filter((sel) => sel.split(',').some((one) => memberClasses.test(one.trim()) && !/^body\.staff\b/.test(one.trim()) && !STAFF_ONLY.test(one.trim())));
  ok('1-1b トレーナー画面だけの部品は、会員の画面の HTML に出てこない', !/class="[^"]*\b(slist|srow|schip|sgrid2|sgrid3|slab|sbtns|sseg|ssave|shead|sback|sbanner)\b/.test(BODY));
  ok('1-1 ★足した見た目の指定は、会員の画面で使う部品（header・.card・.btn など）には body.staff の時だけ効く', added.length > 0 && leak.length === 0, leak.join(' | '));
  const w = boot({ custs: [{ customerId: 'C1', name: '山田 花子' }] });
  ok('1-2 会員として開いた（目印なし）ときは何も変わらない', !w.document.body.classList.contains('staff'));
  w.__t.renderTrainerAdmin({ trainerId: 'T1', trainerName: '一郎', isOwner: false });
  ok('1-3 ★トレーナーとして開くと目印（body.staff）が付く', w.document.body.classList.contains('staff'));
}

// ================= 2. 顧客一覧（P1） =================
{
  const evil = '<img src=x onerror="window.pwned=1">';
  const w = boot({ custs: [{ customerId: 'C1', name: evil }, { customerId: 'C2', name: '佐藤 健' }], resv: [{ customerId: 'C2', customerName: '佐藤 健', reservationId: 'R1', dateLabel: '11/8(土) 10:00' }] });
  w.document.body.classList.add('staff');
  w.__t.renderCustomerList();
  const box = w.document.getElementById('tadminList');
  ok('2-1 ★名前は文字として入れる（HTML にしない）', !box.querySelector('img') && !w.pwned && box.textContent.includes('<img'));
  const rows = [...box.querySelectorAll('.slist .srow')];
  ok('2-2 お客様は1枚のリスト・予約の件数の印（予約なしはコーラル）', rows.length >= 2 && rows[1].textContent.includes('1件') && !!rows[0].querySelector('.schip.warn') && rows[0].querySelector('.schip.warn').textContent === '予約なし');
  const secs = [...box.querySelectorAll('.sect-h')].map((x) => x.textContent);
  ok('2-3 並び：担当のお客様 → 枠を作る → 管理（オーナーだけは出さない）', secs.join(',') === '担当のお客様,枠を作る,管理', secs.join(','));
  ok('2-4 枠を作るは2つのボタン（未登録客＝塗り・ブロック＝枠）', !!box.querySelector('.sgrid2 .btn:not(.btn-outline)') && !!box.querySelector('.sgrid2 .btn.btn-outline'));
  rows[1].click();
  ok('2-5 お客様を押すと顧客の詳細へ', w.document.getElementById('tadminList').textContent.includes('佐藤 健 様'));
  const wo = boot({ owner: true, custs: [{ customerId: 'C1', name: '山田' }] });
  wo.__t.renderCustomerList();
  const bo = wo.document.getElementById('tadminList');
  ok('2-6 ★オーナーにだけ「オーナーだけ」（灰色）：システム状態・当日キャンセルを取り消す', [...bo.querySelectorAll('.sect-h')].some((x) => x.textContent === 'オーナーだけ') && !!bo.querySelector('.slist.grey') && bo.querySelector('.slist.grey').textContent.includes('当日キャンセルを取り消す'));
  const we = boot({ custs: [] });
  we.__t.renderCustomerList();
  const be = we.document.getElementById('tadminList');
  ok('2-7 ★担当が0名でも「カルテの一覧」を消さない（従来は空の案内で上ごと消していた）', !!btnT(be, 'カルテの一覧') && be.textContent.includes('担当のお客様がまだ登録されていません'));
}

// ================= 3. 顧客の詳細（P2） =================
{
  const evil = '<b id="x">11/8</b>';
  const w = boot({ custs: [{ customerId: 'C1', name: '山田 花子' }], resv: [
    { customerId: 'C1', customerName: '山田 花子', reservationId: 'R1', dateLabel: evil, freeCancel: true, trainerId: 'T1' },
    { customerId: 'C1', customerName: '山田 花子', reservationId: 'R2', dateLabel: '11/15(土)', freeCancel: true, transfer: true, trainerId: 'T9' }] });
  w.document.body.classList.add('staff');
  w.__t.renderCustomerDetail('C1', '山田 花子');
  const box = w.document.getElementById('tadminList');
  const head = box.querySelector('.shead');
  ok('3-1 ★見出しの行：左に戻る（data-back のまま＝端末の戻る・横スワイプが効く）＋名前', !!head && !!head.querySelector('button.sback[data-back]') && head.textContent.includes('山田 花子 様') && w.document.getElementById('s-tadmin').classList.contains('sub'));
  head.querySelector('[data-back]').click();
  ok('3-2 戻ると顧客一覧', w.document.getElementById('tadminList').querySelector('.slist') !== null && !w.document.getElementById('s-tadmin').classList.contains('sub'));
  w.__t.renderCustomerDetail('C1', '山田 花子');
  const b2 = w.document.getElementById('tadminList');
  const top = b2.querySelector('.sgrid2');
  ok('3-3 ★上に「カルテを開く」「＋ 予約を代行」', !!top && top.textContent.includes('カルテを開く') && top.textContent.includes('＋ 予約を代行'));
  btnT(top, '＋ 予約を代行').click();
  ok('3-4 代行を始める（顧客が渡る）', JSON.stringify(w.proxyStarted) === JSON.stringify(['C1', '山田 花子']));
  ok('3-5 ★予約の日時は文字として入れる・種別の印（通常／振替）', !b2.querySelector('#x') && b2.textContent.includes('<b id="x">') && [...b2.querySelectorAll('.schip')].some((x) => x.textContent === '振替'));
  const cxl = btnT(b2, 'キャンセル');
  ok('3-6 ★キャンセルはコーラル（消す操作）', !!cxl && cxl.classList.contains('btn-danger'));
  ok('3-7 他のトレーナーの予約にはボタンを出さない（従来どおり）', b2.textContent.includes('他のトレーナーが担当する予約です'));
  const secs = [...b2.querySelectorAll('.sect-h')].map((x) => x.textContent);
  ok('3-8 見出し：残り回数 → 今後のご予約（2件）→ チケット補充 → 固定枠の自動予約', secs.join(',') === '残り回数,今後のご予約（2件）,チケット補充,固定枠の自動予約', secs.join(','));
  const card = [...b2.querySelectorAll('.card')].find((c) => c.textContent.includes('チケットを補充する'));
  ok('3-9 チケット補充はカード・欄に名前（回数・単価・有効期限）', !!card && ['回数', '単価（円）', '有効期限（任意）'].every((x) => card.textContent.includes(x)));
  card.querySelector('input[type=number]').value = '8800';
  btnT(card, 'チケットを補充する').click(); await settle();
  const rf = w.sent.find((x) => x.action === 'line_addTicketRefill');
  ok('3-10 ★補充で送る中身は従来どおり（顧客・回数4・単価）', !!rf && rf.customerId === 'C1' && String(rf.tickets) === '4' && rf.unitPrice === 8800, JSON.stringify(rf));
}
{
  //   オーナー：期限後の予約に「時間を変更（無料・オーナー）」「無料で取り消す（オーナー）」（取り消しはコーラル）
  const w = boot({ owner: true, custs: [{ customerId: 'C1', name: '山田' }], resv: [{ customerId: 'C1', customerName: '山田', reservationId: 'R1', dateLabel: '11/8', freeCancel: false, trainerId: 'T9' }] });
  w.__t.renderCustomerDetail('C1', '山田');
  const b = w.document.getElementById('tadminList');
  ok('3-11 オーナーの無料取消はコーラル・当日消化のキャンセルもコーラル', btnT(b, '無料で取り消す（オーナー）').classList.contains('btn-danger') && btnT(b, 'キャンセル（当日消化）').classList.contains('btn-danger') && !!btnT(b, '時間を変更（無料・オーナー）'));
}

// ================= 4. 未登録客の枠（P3）・ブロック =================
{
  const w = boot({ apiResp: { success: true, start: '11/12 19:45' } });
  w.document.body.classList.add('staff');
  w.eval('function _ensureAdminTrainers(f){ f(); }');
  w.__t.renderAdminHoldForm();
  const box = w.document.getElementById('tadminList');
  const head = box.querySelector('.shead.entry');
  ok('4-1 ★記入画面の見出し（ネイビーの帯・戻る・題名）・作るボタンは下に固定', !!head && head.textContent.includes('未登録客の予約枠を作る') && !!head.querySelector('[data-back]') && !!box.querySelector('.ssave .btn') && w.document.getElementById('s-tadmin').classList.contains('entry'));
  const seg = [...box.querySelectorAll('#ahKindSeg button')];
  ok('4-2 種別は4つのボタン（最初は体験）', seg.map((x) => x.textContent).join(',') === '体験,通常,モニター,レンタル' && seg[0].getAttribute('aria-pressed') === 'true');
  seg[2].click();
  ok('4-3 ★押すと今までの選択欄に入る（送る処理は変えない）', w.document.getElementById('ahKind').value === 'モニター' && seg[2].getAttribute('aria-pressed') === 'true' && seg[0].getAttribute('aria-pressed') === 'false');
  w.document.getElementById('ahName').value = '田中 一郎';
  w.document.getElementById('ahDate').value = '2026-11-12';
  w.document.getElementById('ahTime').value = '19:45';
  btnT(box, 'この内容で予約枠を作る').click(); await settle();
  const mk = w.sent.find((x) => x.action === 'line_makeAdminBooking');
  ok('4-4 ★送る中身：種別モニター・名前・担当', !!mk && mk.kind === 'モニター' && mk.customerName === '田中 一郎' && !!mk.startISO, JSON.stringify(mk));
  w.__t.renderBlockForm();
  const bb = w.document.getElementById('tadminList');
  ok('4-5 ブロックも同じ記入画面の作り', !!bb.querySelector('.shead.entry') && bb.querySelector('.shead.entry').textContent.includes('ブロック（枠を塞ぐ）') && !!bb.querySelector('.ssave .btn'));
}

// ================= 5. 代行・変更の帯（P4） =================
{
  const w = boot({});
  const st = w.__t.state;
  st.proxyMode = true; st.proxyCustomerName = '<i>山田</i>'; st.proxyCustomerId = 'C1'; st._fromTrainerAdmin = true; st.batchMode = true; st.batchSel = {}; st.excludeStartISO = 'x';
  w.__t.show('s-week');
  ok('5-1 ★会員として開いた（目印なし）ときは帯を出さない', !w.document.getElementById('staffBanner'));
  w.document.body.classList.add('staff');
  w.__t.show('s-week');
  const b = w.document.getElementById('staffBanner');
  ok('5-2 ★トレーナーの代行中は空き枠の画面の一番上に「代行中：〇〇様」（名前は文字として）', !!b && b.parentNode.id === 's-week' && b.textContent.includes('代行中：<i>山田</i> 様') && !b.querySelector('i'));
  w.__t.show('s-confirm');
  ok('5-3 確認の画面にも出る（帯は1つだけ）', w.document.querySelectorAll('#staffBanner').length === 1 && w.document.getElementById('staffBanner').parentNode.id === 's-confirm');
  w.__t.show('s-done');
  ok('5-4 完了・一覧などほかの画面には出さない', !w.document.getElementById('staffBanner'));
  w.__t.show('s-week');
  btnT(w.document.getElementById('staffBanner'), 'やめる').click();
  ok('5-5 ★「やめる ×」＝本番の goHome：代行の状態を全部解いて顧客一覧を読み直す（会員ホームへ行かない）', st.proxyMode === false && st.proxyCustomerId === '' && st.proxyCustomerName === '' && st._fromTrainerAdmin === false && st.batchMode === false && st.excludeStartISO === '' && w.sent.some((x) => x.action === 'line_getTrainerReservations') && !w.wentMemberHome, JSON.stringify(st));
  ok('5-5b 代行中の「← ホームに戻る」も顧客一覧へ（会員ホームに落ちない）', /on\('toHome', function\(\)\{ if \(state\._fromTrainerAdmin \|\| state\.proxyMode\) \{ goHome\(\); return; \} show\('s-home'\); \}\);/.test(HTML));
  w.document.body.classList.add('staff');
  st.changeMode = true; st._fromTrainerAdmin = true;
  st._changeCustName = '佐藤 健';   // 変更を始める処理（取り出した範囲の外）が控える名前
  ok('5-6a 変更を始めるときにお客様の名前を控える', /function _startTrainerChangeGo\(r\)\{\n    state\._changeCustName = r\.customerName \|\| '';/.test(HTML));
  w.__t.show('s-week');
  ok('5-6 予約の変更中も「予約の変更中：〇〇様」', !!w.document.getElementById('staffBanner') && w.document.getElementById('staffBanner').textContent.includes('予約の変更中：佐藤 健 様'));
}

// ================= 6. 消化ペース・システム状態（P5・P6） =================
{
  const w = boot({ owner: true });
  w.document.body.classList.add('staff');
  w.__t.renderHealthBoard({ stamp: '11/6 7:00', counts: { high: 1, warn: 1, info: 0 }, issues: [{ severity: 'high', area: '<b>リマインド</b>', count: 1, detail: '<img src=x onerror="window.pwned=2">' }, { severity: 'warn', area: '契約', count: 2, detail: '確認' }] });
  const box = w.document.getElementById('tadminList');
  ok('6-1 ★システム状態：絵文字をやめ配色の役割（至急＝コーラル・要確認＝ゴールド）', !/[🔴⚠️✅ℹ️]/u.test(box.textContent) && box.textContent.includes('至急の対応が 1件') && !!box.querySelector('.schip.warn') && !!box.querySelector('.schip.gold'));
  ok('6-2 ★点検の項目・中身は文字として入れる', !box.querySelector('img') && !w.pwned && box.textContent.includes('<b>リマインド</b>'));
  ok('6-3 見出しの行（戻る＋システム状態）', !!box.querySelector('.shead [data-back]') && box.querySelector('.shead').textContent.includes('システム状態'));
}
ok('6-4 ★消化ペースも絵文字の印をやめた（遅れ＝コーラル・注意＝ゴールド・予定どおり＝ネイビー）', /function _paceIcon\(level\)\{ return ''; \}/.test(HTML) && /function _paceChip\(level\)\{ return level === 'alert' \? 'warn' : \(level === 'warn' \? 'gold' : ''\); \}/.test(HTML));

// ================= 7. 関門②：素通し・会員の画面に見た目を持ち込まない =================
{
  const evil = '<img src=x onerror="window.pwned=3">';
  const w = boot({ owner: true });
  w.document.body.classList.add('staff');
  w.__t.state._allTrainers = [{ id: 'T1', name: evil }];
  w.__t.renderAdminHoldForm();
  ok('7-1 ★担当の選択欄の名前は文字として', !w.document.querySelector('#ahTrainer img') && !w.pwned && w.document.getElementById('ahTrainer').textContent.includes('<img'));
  ok('7-2 ★作成した枠・未紐付け・集計の名前も文字として（_sEsc）', /'<b>' \+ _sEsc\(sl\.when\) \+ '<\/b>'/.test(HTML) && /_sEsc\(sl\.title\)/.test(HTML) && /_sEsc\(u\.customerName\)/.test(HTML) && /_sEsc\(m\.name\)/.test(HTML) && /st\.brokenNames\.map\(_sEsc\)/.test(HTML));
  w.__t.show('s-home');
  ok('7-3 ★会員の画面に入ったらトレーナーの見た目を外す', !w.document.body.classList.contains('staff'));
  w.__t.renderCustomerList();
  ok('7-4 一覧に戻ったら付け直す', w.document.body.classList.contains('staff'));
}

console.log(`\n${fail ? '❌' : '✅'} トレーナーの予約ページ 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
