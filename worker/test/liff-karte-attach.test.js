// 設計48 録音の文字起こしをファイルで添付する：本番の liff/karte.js を jsdom で動かし、入口から通す・2026-11-20
//   実行: node worker/test/liff-karte-attach.test.js
//
//   ★カルテを開く → 今日の記録 → メモから取り込む → 「ファイルを添付」→ ファイルを選ぶ（身代わりの File）→ 貼り付け欄、を通す
//   ★身代わりは fetch（Worker）・LINE の SDK・ファイルの選択だけ。FileReader・TextDecoder は jsdom の本物
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
async function readDone() { await new Promise((r) => setTimeout(r, 30)); await settle(); }
const b64u = (s) => Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (ageS) => b64u(JSON.stringify({ alg: 'ES256' })) + '.' + b64u(JSON.stringify({ iss: 'https://access.line.me', sub: 'U_TEST', iat: Math.floor(Date.now() / 1000) - ageS, exp: Math.floor(Date.now() / 1000) + 3600 })) + '.sig';

const SECRET = '架空の旅行の雑談がここにある';
const FNAME = '架空録音ファイル名X';

function boot(o = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'https://reservation.tokowaka-gym.com/liff/', pretendToBeVisual: true }); dom.window.__KARTE_REST_UI = true;   // 休憩タイマーは画面では一旦出さない（2026-11-25）。検査では動きを守り続ける
  const w = dom.window;
  const sent = [];
  w.idToken = jwt(30);
  w.EDGE_URL = 'https://edge.example';
  w.state = { trainerId: 'T1', _isOwner: false, _allTrainers: [{ id: 'T1', name: '一郎' }] };
  w.alerts = []; w.alert = (m) => w.alerts.push(String(m));
  w.confirm = () => true;
  w.__karteReload = () => {};
  w.logs = [];
  ['log', 'info', 'warn', 'error', 'debug'].forEach((k) => { w.console[k] = (...a) => w.logs.push(a.map(String).join(' ')); });
  w.liff = { getIDToken: () => w.idToken, logout: () => {} };
  if (o.noTextDecoder) delete w.TextDecoder, w.TextDecoder = undefined;
  //   FileReader を数える（読まない形式で FileReader を作らないことを確かめる）
  const RealFR = w.FileReader;
  w.frCount = 0;
  w.FileReader = function () { w.frCount++; return new RealFR(); };
  w.fetch = async (url, opt) => {
    const body = JSON.parse(opt.body);
    sent.push({ url: String(url), body });
    let r;
    if (body.action === 'k_training') r = { success: true, karteSchema: 33, aiDraft: true, aiConsent: 'agreed', sessions: [], best: [] };
    else if (body.action === 'k_exercises') r = { success: true, karteSchema: 33, exercises: [], truncated: false };
    else if (body.action === 'k_aiDraft') r = { success: false, code: 'AI_NOT_CONFIGURED' };
    else r = { success: true };
    return { json: async () => JSON.parse(JSON.stringify(r)) };
  };
  w.eval(SRC);
  return { w, sent };
}
const R = (w) => w.document.getElementById('karteRoot');
const btn = (root, t) => [...root.querySelectorAll('button')].find((x) => x.textContent.indexOf(t) === 0);
const TA = (w) => R(w).querySelector('textarea[aria-label="メモを貼る"]');
const MSG = (w) => R(w).querySelector('.k-attmsg');
const storeText = (s) => { let o = ''; for (let i = 0; i < s.length; i++) o += s.key(i) + '=' + s.getItem(s.key(i)) + '\n'; return o; };
async function openImport(w) {
  w.KarteUI.open('C1', '会員', 'training'); await settle();
  const b = btn(R(w), '＋ 今日の記録') || btn(R(w), '記録の入力（途中）を開く');
  if (b && !R(w).classList.contains('k-entry')) { b.click(); await settle(); }
  R(w).querySelector('button.k-impgo').click(); await settle();
}
const utf8 = (s) => new Uint8Array(Buffer.from(s, 'utf8'));
//   ファイルを選ぶ：ボタンを押す（入力を開く）→ 選んだファイルを入れて change
async function attach(w, bytes, name, type, opt = {}) {
  const b = btn(R(w), 'ファイルを添付');
  let clicked = 0;
  const inp = R(w).querySelector('input[type=file]');
  inp.click = () => { clicked++; };
  b.click();
  const f = new w.File([bytes], name, { type: type || '' });
  if (opt.size != null) Object.defineProperty(f, 'size', { value: opt.size });
  //   本物の file input と同じく、value = '' で選択（files）が空になる身代わり
  let sel = [f];
  Object.defineProperty(inp, 'files', { get: () => sel, configurable: true });
  Object.defineProperty(inp, 'value', { get: () => (sel.length ? 'C:\\fakepath\\' + name : ''), set: (v) => { if (v === '') sel = []; }, configurable: true });
  inp.dispatchEvent(new w.Event('change'));
  if (!opt.noWait) await readDone();
  w.__lastInp = inp;
  return clicked;
}

// ================= T1 入口の形 =================
{
  const { w } = boot();
  await openImport(w);
  const b = btn(R(w), 'ファイルを添付（文字起こしの .txt）');
  const inp = R(w).querySelector('input[type=file]');
  ok('T1-1 貼り付け欄の直後に添付のボタン（高さ48px・幅いっぱいの k-btn）', !!b && TA(w).nextElementSibling === b && /min-height:\s*48px/.test(b.getAttribute('style')) && b.classList.contains('k-btn'));
  ok('T1-2 ファイルの入力は隠し、受け付けは .txt/.srt/.vtt/text/plain だけ（音声を出さない）', !!inp && inp.style.display === 'none' && inp.getAttribute('accept') === '.txt,.srt,.vtt,text/plain');
  ok('T1-3 ★注記：端末の中で読むだけ・どこにも送らない・音声は使えない（「AIで振り分ける」は外部へ、の既存注記も残る）', R(w).textContent.includes('添付したファイルは端末の中で読んで上の欄に入れるだけで、どこにも送りません。音声のファイルは使えません。') && R(w).textContent.includes('外部（Anthropic）へ送ります'));
  const clicked = await attach(w, utf8('スクワット\n30×10'), 'a.txt', 'text/plain');
  ok('T1-4 ボタンがファイルの選択を開く', clicked === 1);
}

// ================= T2 .txt：時刻・話者の行を落とし、記録の形は残す =================
{
  const { w, sent } = boot();
  await openImport(w);
  const n0 = sent.length;
  const body = [
    'Speaker 1  00:00:01',
    'スクワット 30キロで10回いきます',
    '話者 2 00:00:15',
    '[00:00:20] ' + SECRET,
    '話者 1：プランク',
    '1:30',
    '30',
    '00:01:02',
    'スピーカー 2',
    '次は ベンチプレス',
  ].join('\r\n');
  await attach(w, utf8(body), FNAME + '.txt', 'text/plain');
  const v = TA(w).value;
  ok('T2-1 ★本文が貼り付け欄に入る', v.includes('スクワット 30キロで10回いきます') && v.includes(SECRET) && v.includes('次は ベンチプレス'), v);
  ok('T2-2 ★時:分:秒だけの行・話者の見出しの行は落ちる／行頭の話者・[時刻] は外す', !/Speaker|話者|スピーカー|00:00|00:01:02/.test(v), v);
  ok('T2-3 ★.txt では分:秒だけの行（1:30）・数字だけの行（30）は残す（記録そのもの）', v.split('\n').includes('1:30') && v.split('\n').includes('30') && v.split('\n').includes('プランク'), v);
  ok('T2-4 落とした行数と「まだどこにも送っていません」を知らせる', /字を入れました（時刻・話者の行を 6行落としました）。まだどこにも送っていません。/.test(MSG(w).textContent), MSG(w).textContent);
  ok('T2-5 ★添付だけでは何も送らない（fetch を呼ばない）', sent.length === n0, JSON.stringify(sent.slice(n0).map((x) => x.body.action)));
  //   I63：中身もファイル名も保存領域・console に出さない
  const all = storeText(w.localStorage) + storeText(w.sessionStorage) + w.logs.join('\n');
  ok('T2-6 ★I63：中身・ファイル名が localStorage／sessionStorage／console に無い', !all.includes(SECRET) && !all.includes(FNAME) && !all.includes('スクワット 30キロ'), all.slice(0, 300));
  ok('T2-7 ファイル名は画面にも出さない', !R(w).textContent.includes(FNAME));
  ok('T2-9 ★読み終えたら隠しの file input に選択が残らない（ファイル名・中身への参照を残さない・関門②）', w.__lastInp.files.length === 0 && w.__lastInp.value === '', String(w.__lastInp.files.length));
  //   以後は貼り付けと同じ：「AIで振り分ける」で1回だけ、整えた字が送られる
  btn(R(w), 'AIで振り分ける').click(); await settle();
  const ai = sent.filter((x) => x.body.action === 'k_aiDraft');
  ok('T2-8 ★押したときだけ k_aiDraft が1回・本文は整えた字（時刻・話者の行なし）', ai.length === 1 && ai[0].body.text === v.trim(), JSON.stringify(ai.map((x) => x.body.text.slice(0, 20))));
}

// ================= T3 .srt =================
{
  const { w } = boot();
  await openImport(w);
  const srt = '1\n00:00:01,000 --> 00:00:04,000\nスクワット 30キロで\n10回\n\n2\n00:00:05,000 --> 00:00:08,500\n<i>' + SECRET + '</i>\n\n10\n00:00:09,000 --> 00:00:10,000\n12\n';
  await attach(w, utf8(srt), 'x.srt', 'application/x-subrip');
  const v = TA(w).value;
  ok('T3-1 ★.srt：通し番号・時刻の行・タグ・空行を落として本文だけ', v === 'スクワット 30キロで\n10回\n' + SECRET + '\n12', JSON.stringify(v));
}

// ================= T4 .vtt =================
{
  const { w } = boot();
  await openImport(w);
  const vtt = '﻿WEBVTT\nKind: captions\n\nNOTE 架空のメモ\n続き\n\nc1\n00:01.000 --> 00:04.000 align:start\n<v 話者1>ベンチプレス 40キロで8回</v>\n\n00:00:05.000 --> 00:00:06.000\n' + SECRET + '\n';
  await attach(w, utf8(vtt), 'x.vtt', 'text/vtt');
  const v = TA(w).value;
  ok('T4-1 ★.vtt：見出し・NOTE のかたまり・名前つきの頭・時刻・<v> を落とす', v === 'ベンチプレス 40キロで8回\n' + SECRET, JSON.stringify(v));
}

// ================= T5 読まない形式 =================
for (const [label, name, type, want] of [
  ['音声 .m4a', 'rec.m4a', 'audio/mp4', '音声は送れません'],
  ['音声 .wav（MIME 空）', 'rec.wav', '', '音声は送れません'],
  ['音声（拡張子なし・MIME audio）', 'rec', 'audio/mpeg', '音声は送れません'],
  ['動画 .mp4', 'rec.mp4', 'video/mp4', '音声は送れません'],
  ['.docx', 'rec.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '（.txt）を選んでください'],
  ['.pdf', 'rec.pdf', 'application/pdf', '（.txt）を選んでください'],
  ['拡張子なし・MIME 空', 'rec 2026.11.20', '', '（.txt）を選んでください'],
]) {
  const { w, sent } = boot();
  await openImport(w);
  const n0 = sent.length;
  TA(w).value = '前からある字';
  await attach(w, utf8('スクワット\n30×10'), name, type);
  ok('T5-0 ' + label + '：拒否しても file input に選択が残らない', w.__lastInp.files.length === 0);
  ok('T5 ★' + label + '：読まずに知らせる（FileReader を作らない・欄は変えない・送らない）', w.frCount === 0 && TA(w).value === '前からある字' && MSG(w).textContent.includes(want) && sent.length === n0, MSG(w).textContent + ' fr=' + w.frCount);
}
{
  const { w } = boot();
  await openImport(w);
  await attach(w, utf8('スクワット\n30×10'), 'rec', 'text/plain');
  ok('T5-2 拡張子なしでも MIME が text/plain なら読む', TA(w).value === 'スクワット\n30×10');
}

// ================= T6 大きさの上限（切らずに知らせる） =================
{
  const { w } = boot();
  await openImport(w);
  await attach(w, utf8('a'), 'big.txt', 'text/plain', { size: 1024 * 1024 + 1 });
  ok('T6-1 ★1MB を超えたら読まない', w.frCount === 0 && TA(w).value === '' && MSG(w).textContent.includes('1MBまで'), MSG(w).textContent);
  const long = 'あ'.repeat(30001);
  await attach(w, utf8(long), 'long.txt', 'text/plain');
  ok('T6-2 ★3万字を超えたら欄に入れない（切らない）', TA(w).value === '' && MSG(w).textContent.includes('3万字まで') && MSG(w).textContent.includes('30001字'), MSG(w).textContent);
  TA(w).value = 'い'.repeat(20000);
  await attach(w, utf8('う'.repeat(10000)), 'mid.txt', 'text/plain');
  ok('T6-3 ★いまの欄と合わせて3万字を超えても入れない', TA(w).value === 'い'.repeat(20000) && MSG(w).textContent.includes('いまの欄と合わせて30001字'), MSG(w).textContent);
  TA(w).value = '';
  await attach(w, utf8('え'.repeat(30000)), 'ok.txt', 'text/plain');
  ok('T6-4 ちょうど3万字は入る', TA(w).value.length === 30000);
}

// ================= T7 文字コード =================
{
  const cases = [
    ['UTF-8 BOM', new Uint8Array([0xEF, 0xBB, 0xBF, ...Buffer.from('スクワット', 'utf8')]), 'スクワット'],
    ['UTF-16LE BOM', new Uint8Array([0xFF, 0xFE, ...Buffer.from('スクワット', 'utf16le')]), 'スクワット'],
    ['UTF-16BE BOM', new Uint8Array([0xFE, 0xFF, ...Buffer.from('スクワット', 'utf16le').swap16()]), 'スクワット'],
    ['Shift_JIS', new Uint8Array([0x83, 0x58, 0x83, 0x4E, 0x83, 0x8F, 0x83, 0x62, 0x83, 0x67]), 'スクワット'],
  ];
  for (const [label, bytes, want] of cases) {
    const { w } = boot();
    await openImport(w);
    await attach(w, bytes, 'e.txt', 'text/plain');
    ok('T7 ' + label + ' を読む', TA(w).value === want, JSON.stringify(TA(w).value));
  }
  const { w } = boot();
  await openImport(w);
  await attach(w, new Uint8Array([0x50, 0x4B, 0x03, 0x04, 0x00, 0x00, 0x08, 0x00]), 'zip.txt', 'text/plain');
  ok('T7-2 ★中身がバイナリ（.docx を .txt にしたもの等）は欄に入れない', TA(w).value === '' && MSG(w).textContent.includes('文字を読めませんでした'), MSG(w).textContent);
  const n = boot({ noTextDecoder: true });
  await openImport(n.w);
  await attach(n.w, utf8('スクワット'), 'e.txt', 'text/plain');
  ok('T7-3 TextDecoder が無い端末は入れない（答えない側）', TA(n.w).value === '' && MSG(n.w).textContent.includes('文字を読めませんでした'));
}

// ================= T8 前からある字の後ろに足す・読み取りの流れ・前の結果を捨てる =================
{
  const { w } = boot();
  await openImport(w);
  TA(w).value = '9/18\n';
  btn(R(w), '読み取る').click(); await settle();
  const hadErr = R(w).textContent.includes('読み取れる行がありませんでした');
  await attach(w, utf8('スクワット\n30×10 50×10'), 'm.txt', 'text/plain');
  ok('T8-1 ★貼ってあった字を消さずに後ろへ足す', TA(w).value === '9/18\nスクワット\n30×10 50×10' && MSG(w).textContent.includes('貼ってあった文字の後ろに'), JSON.stringify(TA(w).value));
  ok('T8-2 入れたら前の読み取り結果を捨てる（貼ったときと同じ）', hadErr && !R(w).textContent.includes('読み取れる行がありませんでした'));
  btn(R(w), '読み取る').click(); await settle();
  ok('T8-3 以後は「読み取る」がそのまま使える（記録の画面へ入る）', !R(w).querySelector('textarea[aria-label="メモを貼る"]') && R(w).textContent.includes('スクワット'));
}

// ================= T9 選び直したら古い読み取りを捨てる =================
{
  const { w } = boot();
  await openImport(w);
  await attach(w, utf8('古いファイル'), 'a.txt', 'text/plain', { noWait: true });
  await attach(w, utf8('新しいファイル'), 'b.txt', 'text/plain');
  ok('T9-1 ★読んでいる途中に選び直したら、後のファイルだけが入る', TA(w).value === '新しいファイル', JSON.stringify(TA(w).value));
}

// ================= T10 読んでいる途中に別の顧客を開いたら捨てる =================
{
  const { w } = boot();
  await openImport(w);
  const ta = TA(w);
  await attach(w, utf8(SECRET), 'a.txt', 'text/plain', { noWait: true });
  w.KarteUI.open('C2', '別の会員', 'training');
  await readDone();
  ok('T10-1 ★画面を離れた・別の顧客なら、読んだ字をどこにも入れない', ta.value === '' && !R(w).textContent.includes(SECRET));
}

console.log(`liff-karte-attach: ${pass} 通過 / ${fail} 失敗`);
if (fail) process.exit(1);
