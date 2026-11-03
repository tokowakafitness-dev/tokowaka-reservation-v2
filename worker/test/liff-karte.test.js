// 顧客カルテの画面（liff/karte.js）を jsdom で実際に動かす（設計28・段1）・2026-11-03
//   実行: node worker/test/liff-karte.test.js
//
//   ★部品ではなく入口から：KarteUI.open（画面の入口）→ 描画 → ボタンを押す → 送った中身を確かめる
//     1. 入口のボタンが予約画面にある（顧客詳細・顧客一覧）・karte.js を読み込んでいる
//     2. メモ・名前を HTML として解釈しない（textContent）
//     3. 保存1回につき clientReqId は1つ。送り直しでも同じ
//     4. トークンが古いと断られたら、入力を端末に退避して読み直す（安全面は退避しない）
//     5. 同意が無いと安全面のフォームは出ない
//     6. 呼ぶ窓口は Worker の許可表に全部ある（k_ 以外を呼ばない）

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const require = createRequire(join(homedir(), '.cache/claude-node/package.json'));
const { JSDOM } = require('jsdom');
const SRC = readFileSync(join(ROOT, 'liff/karte.js'), 'utf8');
const HTML = readFileSync(join(ROOT, 'liff/index.html'), 'utf8');
const PERMS = readFileSync(join(ROOT, 'worker/src/perms.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) pass++; else { fail++; console.log(`❌ ${name}${detail ? '\n   ' + detail : ''}`); } }
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 8; i++) await tick(); }

function boot(responder) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'https://reservation.tokowaka-gym.com/liff/' });
  const w = dom.window;
  const sent = [];
  w.idToken = 'TOKEN1';
  w.EDGE_URL = 'https://edge.example';
  w.state = { trainerId: 'T1', _isOwner: false, _allTrainers: [{ id: 'T1', name: '一郎' }] };
  w.alerts = []; w.alert = (m) => w.alerts.push(String(m));
  w.confirm = () => true;
  w.reloaded = 0;
  w.__karteReload = () => { w.reloaded++; };
  w.liff = { getIDToken: () => w.idToken };
  w.fetch = async (url, opt) => {
    const body = JSON.parse(opt.body);
    sent.push(body);
    const r = await responder(body, sent);
    return { json: async () => r };
  };
  w.eval(SRC);
  return { w, sent };
}

// ================= 1. 入口 =================
ok('1-1 予約画面が karte.js を読み込む', /<script src="karte\.js\?v=[^"]+"><\/script>/.test(HTML));
ok('1-2 顧客詳細に「カルテを開く」（InBody カードの外）', /KarteUI\.open\(customerId, name, 'summary'\)/.test(HTML)
   && HTML.indexOf("KarteUI.open(customerId, name, 'summary')") < HTML.indexOf('buildInBodyCard(customerId, name)); } catch'));
ok('1-3 顧客一覧に「カルテの一覧」', /KarteUI\.openBoard\(\)/.test(HTML));
{
  //   ★担当が0名のトレーナーにも出す＝「まだ登録されていません」の分岐より前に置く
  const fnL = HTML.slice(HTML.indexOf('function renderCustomerList'), HTML.indexOf('function renderCustomerList') + 3000);
  ok('1-4 一覧のボタンは担当0名の分岐の外', fnL.indexOf('KarteUI.openBoard()') > 0 && fnL.indexOf('KarteUI.openBoard()') < fnL.indexOf('if (!list.length)'));
}

// ================= 2. HTML として解釈しない／5. 同意が無いと安全面は出ない =================
{
  const evil = '<img src=x onerror="window.pwned=1">';
  const { w } = boot(async (b) => {
    if (b.action === 'k_summary') return { success: true, customer: { customerId: 'C1', name: evil, trainerId: 'T1' }, assigned: true,
      consent: { state: 'none' }, safetyBrief: null, profile: null,
      lastNote: { note_id: 'n1', session_date: '2026-11-01', condition: 'good', body: evil, next_plan: '', author_trainer_id: 'T1' }, nextReservation: null };
    return { success: true };
  });
  w.KarteUI.open('C1', evil, 'summary');
  await settle();
  const root = w.document.getElementById('karteRoot');
  ok('2-1 名前・メモに入った HTML は要素にならない', root && !root.querySelector('img') && !w.pwned && root.textContent.includes('<img'), root && root.innerHTML.slice(0, 200));
  ok('5-1 同意が無いと「同意待ち」と出て、安全面のボタンは出ない', root.textContent.includes('同意待ち') && !root.textContent.includes('安全面を見る・書く'));
  ok('5-2 同意を記録するボタンは出る', root.textContent.includes('同意を記録（紙）'));
}

// ================= 3. 保存1回につき clientReqId は1つ・送り直しでも同じ =================
{
  let n = 0;
  const { w, sent } = boot(async (b) => {
    if (b.action === 'k_notes') return { success: true, notes: [] };
    if (b.action === 'k_addNote') { n++; return n === 1 ? { success: false, code: 'RATE_LIMITED' } : { success: true, noteId: 'x', rev: 1 }; }
    return { success: true };
  });
  w.KarteUI.open('C1', '会員', 'notes');
  await settle();
  const ta = w.document.querySelectorAll('#karteRoot textarea');
  ta[0].value = '胸の日';
  const save = [...w.document.querySelectorAll('#karteRoot button')].find((x) => x.textContent === 'メモを保存');
  save.click(); await settle();
  save.click(); await settle();
  const notes = sent.filter((b) => b.action === 'k_addNote');
  ok('3-1 失敗の後に押し直しても clientReqId は同じ（二重にならない）', notes.length === 2 && notes[0].clientReqId && notes[0].clientReqId === notes[1].clientReqId, JSON.stringify(notes.map((x) => x.clientReqId)));
  ok('3-2 送る中身にトークンと顧客がある', notes[0].idToken === 'TOKEN1' && notes[0].customerId === 'C1' && notes[0].body === '胸の日');
  ok('3-3 失敗は理由を出す', w.alerts.some((a) => a.includes('時間をおいて')));
}

// ================= 4. トークンが古い → 入力を退避して読み直す =================
{
  const { w } = boot(async (b) => {
    if (b.action === 'k_notes') return { success: true, notes: [] };
    if (b.action === 'k_addNote') return { success: false, code: 'UNAUTHORIZED', detail: 'STALE_TOKEN' };
    return { success: true };
  });
  w.KarteUI.open('C1', '会員', 'notes');
  await settle();
  w.document.querySelectorAll('#karteRoot textarea')[0].value = '消したくないメモ';
  [...w.document.querySelectorAll('#karteRoot button')].find((x) => x.textContent === 'メモを保存').click();
  await settle();
  const saved = JSON.parse(w.sessionStorage.getItem('karte_draft_v1') || 'null');
  ok('4-1 入力を端末に退避して読み直す', w.reloaded === 1 && saved && saved.draft && saved.draft.data.body === '消したくないメモ', JSON.stringify(saved));
}
{
  //   読み直した後：退避した入力が戻る
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'https://reservation.tokowaka-gym.com/liff/' });
  const w = dom.window;
  w.sessionStorage.setItem('karte_draft_v1', JSON.stringify({ customerId: 'C1', name: '会員', tab: 'notes', draft: { kind: 'note', data: { sessionDate: '2026-11-03', condition: 'good', body: '戻ってきたメモ', nextPlan: '' } }, at: Date.now() }));
  w.sessionStorage.setItem('karte_reauth', '1');
  w.idToken = 'TOKEN2'; w.EDGE_URL = 'https://edge.example'; w.state = { trainerId: 'T1' };
  w.alerts = []; w.alert = (m) => w.alerts.push(m);
  w.fetch = async () => ({ json: async () => ({ success: true, notes: [] }) });
  w.eval(SRC);
  await new Promise((r) => setTimeout(r, 30)); await settle();
  const ta = w.document.querySelectorAll('#karteRoot textarea');
  ok('4-2 読み直した後に入力が戻る・もう一度押すよう案内', ta.length && ta[0].value === '戻ってきたメモ' && w.alerts.some((a) => String(a).includes('もう一度')), ta.length ? ta[0].value : 'no textarea');
  ok('4-3 戻したら退避を消す', !w.sessionStorage.getItem('karte_draft_v1') && !w.sessionStorage.getItem('karte_reauth'));
}
{
  //   安全面は退避しない（健康情報を端末に残さない）
  const { w } = boot(async (b) => {
    if (b.action === 'k_summary') return { success: true, customer: { customerId: 'C1', name: '会員' }, assigned: true, consent: { state: 'agreed' }, safetyBrief: null, profile: null, lastNote: null, nextReservation: null };
    if (b.action === 'k_safety') return { success: true, consent: 'agreed', safety: null };
    if (b.action === 'k_saveSafety') return { success: false, code: 'UNAUTHORIZED', detail: 'STALE_TOKEN' };
    return { success: true };
  });
  w.KarteUI.open('C1', '会員', 'summary');
  await settle();
  [...w.document.querySelectorAll('#karteRoot button')].find((x) => x.textContent === '安全面を見る・書く').click();
  await settle();
  w.document.querySelectorAll('#karteRoot textarea')[1].value = '右膝の手術歴';
  [...w.document.querySelectorAll('#karteRoot button')].find((x) => x.textContent === '保存する').click();
  await settle();
  const saved = w.sessionStorage.getItem('karte_draft_v1') || '';
  ok('4-4 ★安全面は端末に退避しない', !saved.includes('右膝'), saved);
}

{
  //   期限切れの退避は戻さず、読み直し済みの印も消す（残ると次の読み直しが永久に止まる）
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'https://reservation.tokowaka-gym.com/liff/' });
  const w = dom.window;
  w.sessionStorage.setItem('karte_draft_v1', JSON.stringify({ customerId: 'C1', name: '会員', tab: 'notes', draft: null, at: Date.now() - 31 * 60 * 1000 }));
  w.sessionStorage.setItem('karte_reauth', '1');
  w.state = { trainerId: 'T1' }; w.alert = () => {}; w.fetch = async () => ({ json: async () => ({ success: true }) });
  w.eval(SRC);
  await settle();
  ok('4-5 期限切れの退避は戻さず、読み直し済みの印も消す', !w.document.getElementById('karteRoot') && !w.sessionStorage.getItem('karte_reauth'));
}

// ================= 6. 呼ぶ窓口は許可表に全部ある =================
{
  const used = [...new Set((SRC.match(/'k_[A-Za-z]+'/g) || []).map((x) => x.slice(1, -1)))];
  const missing = used.filter((a) => !new RegExp(`'${a}':\\s*\\['trainer'\\]`).test(PERMS));
  ok('6-1 画面が呼ぶ k_ はすべて許可表にある（trainer だけ）', used.length >= 15 && !missing.length, `使用 ${used.length}・無い ${missing.join(',')}`);
  ok('6-2 GAS の api() を呼ばない（カルテの正本は D1）', !/\bapi\(/.test(SRC));
}

console.log(`\n${fail ? '❌' : '✅'} カルテの画面 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
