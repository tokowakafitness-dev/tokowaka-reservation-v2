// 予約画面の「戻る」：LIFF を閉じない・横スワイプは左右どちらでも戻る（2026-11-05 オーナー指示）
//   実行: node worker/test/liff-back-nav.test.js
//
//   ★部品ではなく入口から：本番の liff/index.html から画面の HTML と「戻る」の部分をそのまま取り出し、
//     jsdom で 端末の戻る（history.back）・画面の中の横スワイプ を起こして、どの画面に移ったかを見る
//     1. 指で触ると見張りの1段が積まれる（端末の戻るが LIFF を閉じない）
//     2. 端末の戻る → 画面の「戻る」ボタンと同じ動き ＋ 見張りを積み直す
//     3. 最初の画面（戻る先が無い）では何もしない＝留まる・見張りは残る
//     4. 横スワイプは左→右で戻る・右→左で進む（進む先は閉じた直後のカルテだけ）。縦・入力欄の上・左端・横に動く表の上では戻らない
//     5. カルテが開いている間は何もしない（カルテの履歴の上に見張りを積まない）
//     6. 送信中は戻らない・隠れている戻るボタンは飛ばす
//     8. 関門②：liff.init の直後にも見張り・入力中のフォームは確かめる・ピンチは戻らない

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
const wait = (ms) => new Promise((r) => setTimeout(r, ms || 30));

const BODY = HTML.slice(HTML.indexOf('<body>') + 6, HTML.indexOf('<script'));
const A = HTML.indexOf('  // ---------------------------------------------------------------- 戻る（2026-11-05');
const Z = HTML.indexOf('  // ---------------------------------------------------------------- 戻る ここまで');
const NAV = HTML.slice(A, Z);
const SCREENS_LINE = (HTML.match(/  var SCREENS = \[[^\]]+\];\n[\s\S]*?\n  function show\(id\)\{[\s\S]*?\n  \}/) || [])[0] || '';
ok('0-1 本番の HTML から「戻る」の部分と画面の切り替えを取り出せる', A > 0 && Z > A && SCREENS_LINE.length > 0 && BODY.includes('id="s-home"'));

function boot() {
  const dom = new JSDOM('<!doctype html><html><body>' + BODY + '</body></html>', { runScripts: 'outside-only', url: 'https://reservation.tokowaka-gym.com/liff/' });
  const w = dom.window;
  //   jsdom は配置を計算しないので、「見えているか」は hidden・display:none の祖先で判定する身代わりにする
  w.Element.prototype.getClientRects = function () {
    for (let n = this; n; n = n.parentElement) { if (n.hidden || (n.style && n.style.display === 'none')) return []; }
    return [{}];
  };
  w.eval('var _busyEl = null;\n' + SCREENS_LINE + '\n' + NAV + '\nwindow.show = show; window.setBusy = function(on){ _busyEl = on ? { hidden: false } : null; };');
  //   画面の「戻る」ボタンの行き先（本番の on(...) と同じ向き）
  const go = { toHome: 's-home', myResBack: 's-home', backToTrainer: 's-trainer', weekHome: 's-home', confirmCancel: 's-week', doneClose: 's-home' };
  Object.keys(go).forEach((id) => { w.document.getElementById(id).onclick = () => w.show(go[id]); });
  return w;
}
const cur = (w) => [...w.document.querySelectorAll('.screen')].find((s) => !s.hidden)?.id;
const tap = (w, el) => { const t = el || w.document.body; const ev = new w.Event('touchend', { bubbles: true }); ev.changedTouches = [{ clientX: 5, clientY: 5 }]; t.dispatchEvent(ev); t.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); };
function swipe(w, x0, y0, x1, y1, target) {
  const tg = target || w.document.querySelector('.screen:not([hidden])');
  const s = new w.Event('touchstart', { bubbles: true }); s.touches = [{ clientX: x0, clientY: y0 }]; tg.dispatchEvent(s);
  const e = new w.Event('touchend', { bubbles: true }); e.touches = []; e.changedTouches = [{ clientX: x1, clientY: y1 }]; tg.dispatchEvent(e);
}

// ================= 1〜3. 端末の戻る =================
{
  const w = boot();
  w.show('s-myres');
  const len0 = w.history.length;
  tap(w);
  ok('1-1 ★指で触ると見張りの1段が積まれる', w.history.length === len0 + 1 && w.history.state && w.history.state.rsvGuard === 1, JSON.stringify(w.history.state));
  tap(w);
  ok('1-2 何度触っても1段だけ', w.history.length === len0 + 1);
  w.history.back(); await wait();
  ok('2-1 ★端末の戻る → 画面の「戻る」と同じ動き（予約の確認 → ホーム）', cur(w) === 's-home', cur(w));
  ok('2-2 ★見張りを積み直す（次の戻るでも LIFF を閉じない）', w.history.state && w.history.state.rsvGuard === 1);
  w.history.back(); await wait();
  ok('3-1 ★最初の画面では何もしない＝ホームに留まる', cur(w) === 's-home');
  ok('3-2 見張りは残る', w.history.state && w.history.state.rsvGuard === 1);
  //   予約の流れを奥へ進んでから戻る
  w.show('s-confirm'); w.history.back(); await wait();
  ok('2-3 予約の確認 → 週の表', cur(w) === 's-week');
  w.history.back(); await wait();
  ok('2-4 ★週の表 → トレーナーを選び直す（見えている最初の戻る）', cur(w) === 's-trainer');
  w.history.back(); await wait();
  ok('2-5 トレーナー選び → ホーム', cur(w) === 's-home');
}

// ================= 4. 画面の中の横スワイプ =================
{
  const w = boot();
  w.show('s-confirm'); swipe(w, 60, 300, 220, 310);
  ok('4-1 ★左→右で戻る', cur(w) === 's-week', cur(w));
  w.show('s-confirm'); swipe(w, 300, 300, 120, 305);
  ok('4-2 ★右→左は戻らない（進む＝予約画面の画面には進む先が無い）', cur(w) === 's-confirm', cur(w));
  w.show('s-confirm'); swipe(w, 60, 300, 120, 420);
  ok('4-3 縦に大きく動いたもの（スクロール）は戻らない', cur(w) === 's-confirm');
  w.show('s-confirm'); swipe(w, 60, 300, 100, 305);
  ok('4-4 短い動きは戻らない', cur(w) === 's-confirm');
  w.show('s-confirm'); swipe(w, 10, 300, 220, 305);
  ok('4-5 左端から始めたものは端末の戻るに任せる（二重に戻らない）', cur(w) === 's-confirm');
  w.show('s-register'); swipe(w, 60, 300, 260, 305, w.document.getElementById('regName'));
  ok('4-6 入力欄の上では戻らない（戻る先も無い）', cur(w) === 's-register');
  w.show('s-week');
  const grid = w.document.getElementById('gridWrap');
  grid.style.overflowX = 'auto';
  Object.defineProperty(grid, 'scrollWidth', { value: 900 }); Object.defineProperty(grid, 'clientWidth', { value: 360 });
  const cell = w.document.createElement('div'); grid.appendChild(cell);
  swipe(w, 300, 300, 100, 305, cell);
  ok('4-7 ★横に動く表の上では戻らない（表を動かす操作）', cur(w) === 's-week');
  w.show('s-home'); swipe(w, 60, 300, 220, 305);
  ok('4-8 最初の画面では何もしない', cur(w) === 's-home');
}

// ================= 5〜6. カルテ・送信中・隠れたボタン =================
{
  const w = boot();
  //   karte.js の身代わり（後から登録＝予約画面の処理の後に動く）：カルテの履歴なら開く・それ以外なら閉じる
  w.addEventListener('popstate', (e) => { w.document.documentElement.classList.toggle('karte-open', !!(e.state && e.state.karte)); });
  w.show('s-confirm');
  tap(w);   // 見張りを積んでからカルテを開く（本番もカルテを開くボタンの押下で先に積む）
  w.document.documentElement.classList.add('karte-open');
  swipe(w, 60, 300, 220, 305);
  ok('5-1 ★カルテが開いている間は予約画面を動かさない', cur(w) === 's-confirm');
  w.history.pushState({ karte: 1, i: 1 }, '');
  const len = w.history.length;
  tap(w);
  ok('5-2 ★カルテの履歴の上に見張りを積まない', w.history.length === len && w.history.state.karte === 1);
  w.history.back(); await wait();   // カルテを閉じた（見張りの段へ戻る）
  ok('5-3 カルテから予約画面へ戻っただけのときは画面を動かさない', cur(w) === 's-confirm', cur(w));
  swipe(w, 300, 300, 120, 305); await wait();
  ok('5-3b ★閉じた直後に右→左で進む＝カルテの履歴へ（端末の進むと同じ）', w.history.state && w.history.state.karte === 1 && cur(w) === 's-confirm', JSON.stringify(w.history.state));
  w.history.back(); await wait();   // もう一度閉じる（見張りの段へ）
  w.setBusy(true); swipe(w, 300, 300, 120, 305); await wait(); w.setBusy(false);
  ok('5-3d ★送信中は右→左でも進まない', w.history.state && w.history.state.rsvGuard === 1, JSON.stringify(w.history.state));
  w.show('s-week');   // 閉じたあと予約画面を進めた（別の顧客・代行など）
  swipe(w, 300, 300, 120, 305); await wait();
  ok('5-3c ★閉じたあと画面が切り替わっていたら進まない（前の顧客のカルテを出さない）', w.history.state && w.history.state.rsvGuard === 1 && cur(w) === 's-week', JSON.stringify(w.history.state));
  //   見張りより前にカルテを開いていた（読み直しの後の復元）：閉じる途中の戻りでは画面を動かさず、閉じた後に見張りを積む
}
{
  const w = boot();   // 見張りを積む前（指で触る前）にカルテが開いた
  w.show('s-confirm');
  w.history.pushState({ karte: 1, i: 1 }, '');
  w.document.documentElement.classList.add('karte-open');
  w.addEventListener('popstate', () => w.document.documentElement.classList.remove('karte-open'));   // karte.js の close の身代わり（後から登録＝後に動く・その場で閉じる）
  w.history.back(); await wait();
  ok('5-4 ★カルテが閉じる途中の戻りでは予約画面を動かさない', cur(w) === 's-confirm', cur(w));
  ok('5-5 ★カルテが閉じた後に見張りを積む', w.history.state && w.history.state.rsvGuard === 1, JSON.stringify(w.history.state));
}
{
  const w = boot();
  w.show('s-confirm');
  w.setBusy(true); swipe(w, 60, 300, 220, 305);
  ok('6-1 ★送信中は戻らない', cur(w) === 's-confirm');
  w.setBusy(false);
  w.show('s-week'); w.document.getElementById('backToTrainer').style.display = 'none';
  swipe(w, 60, 300, 220, 305);
  ok('6-2 ★隠れている戻るは飛ばして、次の戻る（ホーム）へ', cur(w) === 's-home', cur(w));
}

// ================= 8. 関門②の指摘（一度も触らない・入力中のフォーム・ピンチ） =================
ok('8-1 ★liff.init の直後に見張りを積む', /_perfAdd\('liff\.init', _nowMs\(\) - _tInit\);\n\s*_navArm\(\);/.test(HTML));
{
  const w = boot();
  w.show('s-myres');
  w._navArm();   // liff.init の直後（指で触っていない）
  ok('8-2 ★触らなくても見張りがある', w.history.state && w.history.state.rsvGuard === 1);
  w.history.back(); await wait();
  ok('8-3 ★触らずに端末の戻る → 画面の戻る（LIFF を閉じない）', cur(w) === 's-home' && w.history.state && w.history.state.rsvGuard === 1);
}
{
  const w = boot();
  const asked = []; let answer = false;
  w.confirm = (m) => { asked.push(m); return answer; };
  const box = w.document.getElementById('tadminList');
  let backs = 0;
  function form() {
    box.innerHTML = '<div class="card"><input id="fName" value=""><input id="fDate" type="date"></div>';
    const b = w.document.createElement('button'); b.textContent = '← 戻る'; b.setAttribute('data-back', ''); b.onclick = () => { backs++; }; box.appendChild(b);
    w.show('s-tadmin');
  }
  form(); swipe(w, 60, 300, 220, 305, box.querySelector('.card'));
  ok('8-4 入力が無ければ確かめずに戻る', backs === 1 && asked.length === 0);
  form();
  box.insertAdjacentHTML('afterbegin', '<select id="fKind"><option>体験</option><option>通常</option></select>');
  swipe(w, 60, 300, 220, 305, box.querySelector('.card'));
  ok('8-4b ★先頭が自動で選ばれた選択欄だけなら確かめない（触っていない）', backs === 2 && asked.length === 0);
  form(); const fn = w.document.getElementById('fName'); fn.value = '山田'; fn.dispatchEvent(new w.Event('input', { bubbles: true }));
  swipe(w, 60, 300, 220, 305, box.querySelector('.card'));
  ok('8-5 ★入力があれば確かめる。やめたら戻らない（入力は残る）', backs === 2 && asked.length === 1 && w.document.getElementById('fName').value === '山田');
  answer = true; swipe(w, 60, 300, 220, 305, box.querySelector('.card'));
  ok('8-6 確かめて「はい」なら戻る', backs === 3 && asked.length === 2);
}
{
  const w = boot();
  w.show('s-confirm');
  const tg = w.document.getElementById('s-confirm');
  const st = new w.Event('touchstart', { bubbles: true }); st.touches = [{ clientX: 60, clientY: 300 }]; tg.dispatchEvent(st);
  const mv = new w.Event('touchmove', { bubbles: true }); mv.touches = [{ clientX: 100, clientY: 300 }, { clientX: 200, clientY: 320 }]; tg.dispatchEvent(mv);
  const en = new w.Event('touchend', { bubbles: true }); en.touches = []; en.changedTouches = [{ clientX: 220, clientY: 305 }]; tg.dispatchEvent(en);
  ok('8-7 ★途中で指が増えた（ピンチ）ものは戻らない', cur(w) === 's-confirm');
  const st2 = new w.Event('touchstart', { bubbles: true }); st2.touches = [{ clientX: 60, clientY: 300 }]; tg.dispatchEvent(st2);
  const en2 = new w.Event('touchend', { bubbles: true }); en2.touches = [{ clientX: 200, clientY: 320 }]; en2.changedTouches = [{ clientX: 220, clientY: 305 }]; tg.dispatchEvent(en2);
  ok('8-8 まだ別の指が触れているときは戻らない', cur(w) === 's-confirm');
}

// ================= 7. 書き方の約束 =================
ok('7-1 管理画面の「← 戻る」ボタンは全部 data-back を持つ', (HTML.match(/back\.textContent ?= ?'← [^']*';/g) || []).length === (HTML.match(/back\.textContent ?= ?'← [^']*'; back\.setAttribute\('data-back', ''\);/g) || []).length
   && (HTML.match(/back\.setAttribute\('data-back', ''\)/g) || []).length >= 8);
ok('7-2 予約の流れの戻るボタン6つが data-back を持つ', ['toHome', 'myResBack', 'backToTrainer', 'weekHome', 'confirmCancel', 'doneClose'].every((id) => new RegExp('<button id="' + id + '" data-back ').test(HTML)));
ok('7-3 ★確定・取消など戻る以外のボタンに data-back を付けない', !/id="(confirmBtn|homeReserve|homeMyRes|registerBtn|batchGo)"[^>]*data-back/.test(HTML));
ok('7-4 予約ページ全体の viewport は変えない', !/interactive-widget/.test(HTML));

console.log(`liff-back-nav: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
