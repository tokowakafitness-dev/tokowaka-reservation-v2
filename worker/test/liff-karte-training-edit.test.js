// 設計58 保存した記録を直す（日別の記録の［編集］）：本番の liff/karte.js を jsdom で動かし、入口（日別の記録の［編集］）から通して値で確かめる・2026-11-25
//   実行: node worker/test/liff-karte-training-edit.test.js
//   ★身代わりは fetch（Worker）・LINE の SDK だけ。名前・ID はすべて架空
//   ★ほかのタブは storage イベントを自分で投げて身代わりにする（jsdom の窓どうしは localStorage を共有しない）

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
async function settle() { for (let i = 0; i < 14; i++) await tick(); }
const b64u = (s) => Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (ageS) => b64u(JSON.stringify({ alg: 'ES256' })) + '.' + b64u(JSON.stringify({ iss: 'https://access.line.me', sub: 'U_TEST', iat: Math.floor(Date.now() / 1000) - ageS, exp: Math.floor(Date.now() / 1000) + 3600 })) + '.sig';
const NAME = '甲野一郎';   // 架空の会員名（端末に残らないことを確かめる）

//   新しい形の回（k_training の返し方：新しい形の回の全セットに assist_reps:null・forced:false・drops:[] が付く）
const S1 = () => ({ session_id: 'S1', session_date: '2026-11-20', created_at: 100, author_trainer_id: 'T1', rev: 1,
  exercises: [{ ord: 1, exercise: '腸腰筋ストレッチ', doneOnly: true }, { ord: 2, exercise: 'フロアアブ', doneOnly: false }, { ord: 3, exercise: 'ヒップリフト', doneOnly: false }, { ord: 4, exercise: 'ヒップリフト', doneOnly: false }],
  sets: [
    { session_id: 'S1', exercise: 'フロアアブ', set_no: 1, weight_kg: 0, reps: 10, note: null, ord: 2, assist_reps: null, forced: false, drops: [] },
    { session_id: 'S1', exercise: 'フロアアブ', set_no: 2, weight_kg: 10, reps: 10, note: null, ord: 2, assist_reps: null, forced: false, drops: [{ weight_kg: 0, reps: 10, assist_reps: null, forced: false }, { weight_kg: 5, reps: 8, assist_reps: 2, forced: false }] },
    { session_id: 'S1', exercise: 'ヒップリフト', set_no: 1, weight_kg: 30, reps: 10, note: '見本のメモ', ord: 3, assist_reps: null, forced: false, drops: [] },
    { session_id: 'S1', exercise: 'ヒップリフト', set_no: 2, weight_kg: 50, reps: 10, note: null, ord: 3, assist_reps: 5, forced: false, drops: [] },
    { session_id: 'S1', exercise: 'ヒップリフト', set_no: 3, weight_kg: 80, reps: 5, note: null, ord: 3, assist_reps: null, forced: true, drops: [] },
    { session_id: 'S1', exercise: 'ヒップリフト', set_no: 1, weight_kg: 40, reps: 12, note: null, ord: 4, assist_reps: null, forced: false, drops: [] }] });
//   S1 を送る中身にしたもの（buildPayload の形）
const P1 = [
  { exercise: '腸腰筋ストレッチ', sets: [], doneOnly: true },
  { exercise: 'フロアアブ', sets: [{ weight: 0, reps: 10 }, { weight: 10, reps: 10, drops: [{ weight: 0, reps: 10 }, { weight: 5, reps: 8, assist: 2 }] }] },
  { exercise: 'ヒップリフト', sets: [{ weight: 30, reps: 10, note: '見本のメモ' }, { weight: 50, reps: 10, assist: 5 }, { weight: 80, reps: 5, forced: true }] },
  { exercise: 'ヒップリフト', sets: [{ weight: 40, reps: 12 }] }];
//   新しい形だが新しい鍵を値で使っていない回
const S2 = () => ({ session_id: 'S2', session_date: '2026-11-18', created_at: 90, author_trainer_id: 'T1', rev: 3,
  exercises: [{ ord: 1, exercise: 'スクワット', doneOnly: false }],
  sets: [{ session_id: 'S2', exercise: 'スクワット', set_no: 1, weight_kg: 60, reps: 8, note: null, ord: 1, assist_reps: null, forced: false, drops: [] }] });
//   古い回（exercises が無い）
const S3 = () => ({ session_id: 'S3', session_date: '2026-11-10', created_at: 80, author_trainer_id: 'T1', rev: 1,
  sets: [{ session_id: 'S3', exercise: 'ベンチプレス', set_no: 1, weight_kg: 30, reps: 10, note: null }, { session_id: 'S3', exercise: 'スクワット', set_no: 1, weight_kg: 40, reps: 10, note: null }] });

function boot(o = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'https://reservation.tokowaka-gym.com/liff/', pretendToBeVisual: true }); dom.window.__KARTE_REST_UI = true;   // 休憩タイマーは画面では一旦出さない（2026-11-25）。検査では動きを守り続ける
  const w = dom.window;
  const sent = [];
  w.idToken = jwt(30);
  w.EDGE_URL = 'https://edge.example';
  w.state = { trainerId: 'T1', _isOwner: false, _allTrainers: [{ id: 'T1', name: '一郎' }] };
  w.alerts = []; w.alert = (m) => w.alerts.push(String(m));
  w.confirms = []; w.confirm = (m) => { w.confirms.push(String(m)); return true; };
  w.__karteReload = () => {};
  w.liff = { getIDToken: () => w.idToken, logout: () => {} };
  w.cfg = Object.assign({ sessions: [S1(), S2(), S3()], edit: true, schema: 33, editRes: 'ok', hang: false }, o);
  w.fetch = async (url, opt) => {
    const body = JSON.parse(opt.body);
    sent.push(body);
    const c = w.cfg;
    let r;
    //   設計62：1件の読み直し（sessionId）・前回の読み足し（before）は Worker と同じ答え方（c.oneRes で上書きできる）
    if (body.action === 'k_training' && body.sessionId) {
      const x = c.sessions.find((s) => s.session_id === body.sessionId);
      r = c.oneRes ? c.oneRes(body) : (x ? { success: true, karteSchema: c.schema, aiDraft: false, trace: 'live', extra: x } : { success: true, karteSchema: c.schema, aiDraft: false, trace: 'deleted', extra: null });
      if (r && r.success && c.edit !== undefined) r.trainingEdit = c.edit;
    }
    else if (body.action === 'k_training' && body.before) { r = { success: true, karteSchema: c.schema, aiDraft: false, sessions: c.sessions.filter((s) => s.session_date < body.before), best: [], more: false, nextCursor: null }; }
    else if (body.action === 'k_training') { r = { success: true, karteSchema: c.schema, aiDraft: false, sessions: c.sessions, best: [] }; if (c.edit !== undefined) r.trainingEdit = c.edit; }
    else if (body.action === 'k_exercises') r = { success: true, karteSchema: c.schema, exercises: [], truncated: false };
    else if (body.action === 'k_summary') r = { success: true, karteSchema: c.schema, customer: { name: NAME, trainerId: 'T1' }, hearing: null, consent: { state: 'agreed' } };
    else if (body.action === 'k_editTraining') {
      if (c.hang) await new Promise((res) => { w.release = res; });
      const m = c.editRes;
      if (m === 'unknown') return { json: async () => { throw new Error('x'); } };
      r = m === 'ok' ? { success: true, sessionId: 'N' + sent.length, rev: 1, replaced: body.sessionId }
        : m === 'bad' ? { success: false, code: 'BAD_REQUEST', detail: 'SET_VALUE' }
        : { success: false, code: m };
    }
    else r = { success: true };
    return { json: async () => JSON.parse(JSON.stringify(r)) };
  };
  w.eval(SRC);
  return { w, sent };
}
const R = (w) => w.document.getElementById('karteRoot');
const btn = (root, t) => [...root.querySelectorAll('button')].find((x) => x.textContent.indexOf(t) === 0);
const EKEY = 'karte_tr_edit_v1:T1:C1', DKEY = 'karte_tr_draft_v1:T1:C1';
const ed = (w) => JSON.parse(w.localStorage.getItem(EKEY) || 'null');
const sortKeys = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.keys(x).sort().reduce((o, kk) => { o[kk] = x[kk]; return o; }, {}) : x));
const editsSent = (sent) => sent.filter((b) => b.action === 'k_editTraining');
const writesSent = (sent) => sent.filter((b) => /^k_(add|save|delete|edit)/.test(b.action));
async function openList(w) {
  w.KarteUI.open('C1', NAME, 'training'); await settle();
  //   今日の下書きに種目があると今日の記録の画面が自動で開く（今のまま）＝見出しの ← で一覧へ戻る
  const back = R(w).querySelector('.k-entryhead .k-back');
  if (back) { back.click(); for (let i = 0; i < 40 && R(w).querySelector('.k-entryhead'); i++) await new Promise((r) => setTimeout(r, 5)); await settle(); }
}
async function openDay(w, sid) {
  const rows = [...R(w).querySelectorAll('.k-dayrow')];
  const days = { S1: '11/20', S2: '11/18', S3: '11/10' };
  const row = rows.find((r) => r.textContent.indexOf(days[sid]) === 0);
  row.click(); await settle();
}
const editBtn = (w) => R(w).querySelector('button.k-dayedit');
async function startEdit(w, sid) { await openList(w); await openDay(w, sid || 'S1'); editBtn(w).click(); await settle(); }
const saveBtn = (w) => R(w).querySelector('.k-hsave') || btn(R(w), '保存する');
function setReps(w, label, v) { const i = R(w).querySelector('input[aria-label="' + label + '"]'); i.value = v; i.dispatchEvent(new w.Event('input')); return i; }
const frozen = (w) => !!R(w).querySelector('.k-edfrozen');
const frozenText = (w) => { const f = R(w).querySelector('.k-edfrozen'); return f ? f.textContent : ''; };
function storageEvt(w, oldV, newV) { w.dispatchEvent(new w.StorageEvent('storage', { key: EKEY, oldValue: oldV, newValue: newV })); }

// ================= L00 端末が新しい karte.js を読む（index.html の ?v= と KARTE_BUILD の先頭が同じ） =================
{
  const html = readFileSync(join(ROOT, 'liff/index.html'), 'utf8');
  const v = (html.match(/<script src="karte\.js\?v=([^"]+)"><\/script>/) || [])[1];
  const b = (SRC.match(/var KARTE_BUILD = '(\S+)/) || [])[1];
  ok('L00 ★index.html の karte.js?v= が KARTE_BUILD の先頭と同じ（揃っていないと端末に古い karte.js が残る）', !!v && v === b, v + ' / ' + b);
}

// ================= L26 ［編集］を出す条件 =================
{
  const { w } = boot({ edit: false });
  await openList(w); await openDay(w, 'S1');
  ok('L26 ★trainingEdit が false なら［編集］を出さない（［削除］は出る）', !editBtn(w) && !!btn(R(w), '削除'));
}
{
  const { w } = boot({ edit: undefined });
  await openList(w); await openDay(w, 'S1');
  ok('L26 古い Worker（trainingEdit の鍵が無い）でも出さない', !editBtn(w));
}
{
  const { w } = boot();
  await openList(w); await openDay(w, 'S1');
  const b = editBtn(w);
  ok('L26 ★trainingEdit が true で作者本人なら［編集］が出る（44px 以上・［削除］の左）', !!b && /min-height:\s*44px/.test(b.style.cssText) && b.nextSibling && b.nextSibling.textContent === '削除');
}
{
  const { w } = boot({ schema: 32 });
  await openList(w); await openDay(w, 'S1');
  const a = !editBtn(w);
  await openDay(w, 'S2');
  ok('L26b ★新しい鍵を値で使う回は 33 未満なら出さない／新しい形でも値を使っていない回（null・false・[]）は出す', a && !!editBtn(w));
}
{
  const { w } = boot();
  w.state.trainerId = 'T9';
  await openList(w); await openDay(w, 'S1');
  ok('L26 作者でもオーナーでもなければ出さない', !editBtn(w));
}

// ================= L20c 変更なしで閉じる：ほかのタブが持ち主を取った直後（イベントがまだ届いていない）＝凍結・ほかの下書きを消さない（関門②） =================
{
  const { w, sent } = boot();
  await startEdit(w, 'S1');
  const B = Object.assign({}, ed(w), { owner: 'other-form', ver: Number(ed(w).ver) + 1 });
  w.localStorage.setItem(EKEY, JSON.stringify(B));   // storage イベントは送らない＝古い画面はまだ知らない
  saveBtn(w).click(); await settle();
  ok('L20c ★変更なしの保存でも持ち主が違えば凍結（「更新しました」を出さない）', frozen(w) && frozenText(w).includes('ほかの画面で変わりました') && !R(w).querySelector('.k-ednochange') && editsSent(sent).length === 0);
  ok('L20c ★ほかの画面の直しかけは消さない', w.localStorage.getItem(EKEY) === JSON.stringify(B));
}
// ================= L20・L22 中身の写し（値を落とさない・✓ 済みで開く） =================
{
  const { w, sent } = boot();
  w.localStorage.setItem(DKEY, JSON.stringify({ v: 1, tid: 'T1', cid: 'C1', sessionDate: '2026-11-25', items: [{ exercise: '今日の種目', sets: [{ w: '20', r: '5', done: true }] }], reqId: 'kreqTODAY1', pending: null, at: Date.now() }));
  const today0 = w.localStorage.getItem(DKEY);
  await startEdit(w, 'S1');
  const E = ed(w);
  ok('L20 ★直す画面が開き、見出しは「11/20(金) の記録を直す」', R(w).textContent.includes('11/20(金) の記録を直す') && !!E && E.editOf === 'S1' && E.editRev === 1);
  ok('L22 ★記録済みのセットは全部 ✓ 済み（I88）', E.items.every((it) => it.sets.every((s) => s.done === true)) && E.items.reduce((n, it) => n + it.sets.length, 0) === 6);
  ok('L20 ★写した中身を送る形にすると元の記録と同じ（メモ・補助・無理やり・ドロップ・実施のみ・同名2種目・自重）', sortKeys(w.KarteUI._t.buildPayload(E.items)) === sortKeys(P1), JSON.stringify(w.KarteUI._t.buildPayload(E.items)));
  ok('L20 印の無い鍵を作らない（assist:null・forced:false・drops:[] を下書きに入れない）', !JSON.stringify(E.items).includes('"assist":null') && !JSON.stringify(E.items).includes('"forced":false') && !JSON.stringify(E.items).includes('"drops":[]'));
  ok('L20 直す画面には写す・取り込み・社内メモ・お客様に見える欄・休憩タイマー・日付の［今日にする］を出さない', !R(w).querySelector('.k-pickgo') && !R(w).querySelector('.k-impgo') && !R(w).querySelector('.k-memo') && !R(w).querySelector('.k-member') && !R(w).querySelector('.k-rtg') && !R(w).querySelector('.k-datetoday'));
  const dIn = R(w).querySelector('input[type="date"]');
  dIn.value = '2026-11-19'; dIn.dispatchEvent(new w.Event('change')); await settle();
  ok('L20 日付を変えても［今日にする］を出さない・下書きの日付が変わる', !R(w).querySelector('.k-datetoday') && ed(w).sessionDate === '2026-11-19');
  dIn.value = '2026-11-20'; dIn.dispatchEvent(new w.Event('change')); await settle();
  ok('L20 お客様の画面も変わることを1行で知らせる（ダイアログは出さない）', !!R(w).querySelector('.k-edhint') && R(w).querySelector('.k-edhint').textContent.includes('お客様の画面の数字も変わります') && w.confirms.length === 0);
  saveBtn(w).click(); await settle();
  //   2026-11-25 オーナー指示：変更が無くても保存で閉じる（送らない・直す下書きだけ消す・今日の下書きは触らない）
  ok('L20 ★何も変えずに保存＝送らずに「更新しました（変更はありませんでした）」で閉じる', editsSent(sent).length === 0 && writesSent(sent).length === 0 && !!R(w).querySelector('.k-ednochange') && R(w).textContent.includes('変更はありませんでした') && !w.alerts.includes('変更はありません。') && !R(w).querySelector('.k-hsave'), R(w).textContent.slice(0, 200));
  ok('L20 ★変更なしで閉じたら直す下書きは消え・今日の下書きはそのまま', !w.localStorage.getItem(EKEY) && w.localStorage.getItem(DKEY) === today0);
  const back = btn(R(w), '記録の一覧を見る');
  ok('L20 閉じた画面に［記録の一覧を見る］', !!back);
  await startEdit(w, 'S1');
  setReps(w, '1セット目の回数', '11');   // 開いている種目＝最後のヒップリフト
  saveBtn(w).click(); await settle();
  const s = editsSent(sent);
  const exp = JSON.parse(JSON.stringify(P1)); exp[3].sets[0].reps = 11;
  ok('L20 ★1か所だけ変えて保存＝送った items は元＋その1か所', s.length === 1 && sortKeys(s[0].items) === sortKeys(exp), JSON.stringify(s[0] && s[0].items));
  ok('L25 ★送ったのは k_editTraining だけ・中身は sessionId・rev・sessionDate・items（customerId・member なし）', writesSent(sent).length === 1 && s[0].sessionId === 'S1' && s[0].rev === 1 && s[0].sessionDate === '2026-11-20' && !('customerId' in s[0]) && !('member' in s[0]));
  ok('L29 ★成功で直す下書きが消え「直しました」', !w.localStorage.getItem(EKEY) && !!R(w).querySelector('.k-eddone'));
  ok('L24 ★今日の下書きは1文字も変わらない', w.localStorage.getItem(DKEY) === today0);
  const allStore = [...Array(w.localStorage.length).keys()].map((i) => w.localStorage.getItem(w.localStorage.key(i))).join('') + [...Array(w.sessionStorage.length).keys()].map((i) => w.sessionStorage.getItem(w.sessionStorage.key(i))).join('');
  ok('L31b 端末（localStorage・sessionStorage）に会員の名前が残らない', !allStore.includes(NAME));
}

// ================= L33 直す画面でも種目の行の形は今日の記録の画面と同じ（つまみ左・全部✓右・開いた見出しのつまみは左端） =================
{
  const { w } = boot();
  await startEdit(w, 'S1');
  const lines = [...R(w).querySelectorAll('.k-exline')];
  const okLines = lines.length === 3 && lines.every((l) => l.firstElementChild && l.firstElementChild.classList.contains('k-grip') && l.children[1].classList.contains('k-excol'));
  const withChk = lines.filter((l) => l.querySelector('.k-allchk,.k-donechk'));
  const head = R(w).querySelector('.k-exhead');
  ok('L33 ★直す画面の畳んだ行：つまみが左端・その右に種目（全部✓／実施は右端）', okLines && withChk.every((l) => l.lastElementChild.matches('.k-allchk,.k-donechk')), lines.map((l) => [...l.children].map((c) => c.className).join('|')).join(' / '));
  ok('L33 ★直す画面の開いた種目の見出し：つまみが左端・その右に見出し・外すは右', !!head && head.parentNode.firstElementChild.classList.contains('k-grip') && head.parentNode.lastElementChild.textContent === '外す');
}

// ================= L23 全部の ✓ を外すと送らない =================
{
  const { w, sent } = boot();
  await startEdit(w, 'S2');
  const chk = [...R(w).querySelectorAll('button')].find((b) => b.textContent === '✓');
  chk.click(); await settle();
  saveBtn(w).click(); await settle();
  ok('L23 ★全部の ✓ を外して保存＝削除の案内で送らない', w.alerts.some((a) => a.includes('［削除］')) && editsSent(sent).length === 0);
}

// ================= L21b 古い回を直す（種目名順で開き、並べた順で送る） =================
{
  const { w, sent } = boot();
  await startEdit(w, 'S3');
  const E = ed(w);
  ok('L21b 古い回は種目名順（k_training の並び＝exOrder）で開く', E.items.map((x) => x.exercise).join(',') === 'ベンチプレス,スクワット', JSON.stringify(E.items.map((x) => x.exercise)));
  setReps(w, '1セット目の回数', '9');
  saveBtn(w).click(); await settle();
  ok('L21b 送る順は画面の順', editsSent(sent).length === 1 && editsSent(sent)[0].items.map((x) => x.exercise).join(',') === 'ベンチプレス,スクワット');
}

// ================= L27 結果が分からない → 同じ番号・同じ中身で送り直す／L29 送り直さずに破棄 =================
{
  const { w, sent } = boot({ editRes: 'unknown' });
  await startEdit(w, 'S2');
  setReps(w, '1セット目の回数', '9');
  saveBtn(w).click(); await settle();
  const first = editsSent(sent)[0];
  ok('L27 結果が分からない＝送り直しの画面（pending が下書きに残る）', !!ed(w).pending && R(w).textContent.includes('記録を直した結果を確かめられませんでした'));
  w.cfg.editRes = 'ok';
  btn(R(w), '同じ内容で送り直す').click(); await settle();
  const second = editsSent(sent)[1];
  ok('L27 ★送り直しは同じ番号・同じ中身', second && second.clientReqId === first.clientReqId && sortKeys(second.items) === sortKeys(first.items) && !w.localStorage.getItem(EKEY), JSON.stringify([first && first.clientReqId, second && second.clientReqId]));
}
{
  const { w, sent } = boot({ editRes: 'unknown' });
  await startEdit(w, 'S2');
  setReps(w, '1セット目の回数', '9');
  saveBtn(w).click(); await settle();
  btn(R(w), '送り直さずに破棄').click(); await settle();
  ok('L29 ★送り直さずに破棄＝直す下書きが消える（送らない）', !w.localStorage.getItem(EKEY) && editsSent(sent).length === 1);
}

// ================= L29 期限切れ（24時間）で消える・今日の下書きは新しければ残る =================
{
  const { w } = boot();
  w.localStorage.setItem(EKEY, JSON.stringify({ v: 1, tid: 'T1', cid: 'C1', editOf: 'S2', editRev: 3, sessionDate: '2026-11-18', items: [], reqId: 'kreqOLD001', pending: null, at: Date.now() - 25 * 3600 * 1000, owner: 'x', ver: 1 }));
  w.localStorage.setItem(DKEY, JSON.stringify({ v: 1, tid: 'T1', cid: 'C1', sessionDate: '2026-11-25', items: [], reqId: 'kreqTODAY2', pending: null, at: Date.now() }));
  await openList(w);
  ok('L29 ★24時間を過ぎた直す下書きは開くときに消える・新しい今日の下書きは残る', !w.localStorage.getItem(EKEY) && !!w.localStorage.getItem(DKEY));
}

// ================= L28 一覧に無い回（置き換え済み）に戻る・進むで来た =================
{
  const { w, sent } = boot();
  w.KarteUI.open('C1', NAME, 'training', { kind: 'sub', sub: 'tredit', sid: 'GONE', navMode: 'none' }); await settle();
  ok('L28 ★一覧に無い sid＝「この記録はもうありません」・送らない・下書きを作らない', R(w).textContent.includes('この記録はもうありません') && writesSent(sent).length === 0 && !w.localStorage.getItem(EKEY));
}

// ================= L30 2つの画面（§4-8） =================
{
  //   L30a ほかのタブが持ち主を取った → こちらは凍結・書かない
  const { w } = boot();
  await startEdit(w, 'S2');
  const E = ed(w), oldRaw = w.localStorage.getItem(EKEY);
  const B = Object.assign({}, E, { owner: 'FORM-B', ver: E.ver + 1 });
  w.localStorage.setItem(EKEY, JSON.stringify(B)); storageEvt(w, oldRaw, JSON.stringify(B)); await settle();
  ok('L30a ★ほかのタブが持ち主を取った瞬間に凍結の表示（storage イベント）', frozen(w) && frozenText(w).includes('ほかの画面で変わりました'));
  ok('L30a 凍結の後は下書きを書かない（ほかのタブの中身のまま）', ed(w).owner === 'FORM-B' && !R(w).querySelector('input[aria-label="1セット目の回数"]'));
}
{
  //   L30b 1つのフォームで入力10回＋確定した失敗で reqId を作り直しても凍結しない
  const { w, sent } = boot({ editRes: 'bad' });
  await startEdit(w, 'S2');
  const v0 = ed(w).ver;
  for (let i = 0; i < 10; i++) setReps(w, '1セット目の回数', String(10 + i));
  ok('L30b ★入力10回（自分の書き込みの通知が10回）でも凍結しない・世代は10進む', !frozen(w) && ed(w).ver === v0 + 10, String(ed(w).ver - v0));
  const r0 = ed(w).reqId;
  saveBtn(w).click(); await settle();
  const E = ed(w);
  ok('L30b ★確定した失敗：pending が解け、送信番号が新しく、画面は直す画面のまま（凍結しない）', E && !E.pending && E.reqId !== r0 && !frozen(w) && !!R(w).querySelector('input[aria-label="1セット目の回数"]') && editsSent(sent).length === 1);
  setReps(w, '1セット目の回数', '8');
  ok('L30b 失敗の後も入力できる（凍結しない・書ける）', !frozen(w) && ed(w).items[0].sets[0].r === '8');
}
{
  //   L30c ほかのタブで保存成功（鍵が消えた・pending なし）→ こちらは凍結・鍵を生き返らせない
  const { w } = boot();
  await startEdit(w, 'S2');
  const oldRaw = w.localStorage.getItem(EKEY);
  w.localStorage.removeItem(EKEY); storageEvt(w, oldRaw, null); await settle();
  ok('L30c ★鍵が消えた＝凍結（ほかの画面で変わりました）', frozen(w) && frozenText(w).includes('ほかの画面で変わりました'));
  ok('L30c 凍結の後に鍵が生き返らない', !w.localStorage.getItem(EKEY));
}
{
  //   L30c2 通知を受け取れなかった（鍵だけが消えた）→ 次の入力で気づいて凍結・鍵を生き返らせない
  const { w } = boot();
  await startEdit(w, 'S2');
  w.localStorage.removeItem(EKEY);   // 通知なし
  setReps(w, '1セット目の回数', '5');
  ok('L30c2 ★通知が無くても、次の入力で鍵が無いことに気づいて凍結・鍵を作り直さない', frozen(w) && !w.localStorage.getItem(EKEY));
}
{
  //   L30d・L30f（別のタブ）送り直しの画面で、ほかのタブが同じ pending を片づけた → 成功と言い切らない・送らない
  const { w, sent } = boot({ editRes: 'unknown' });
  await startEdit(w, 'S2');
  setReps(w, '1セット目の回数', '9');
  saveBtn(w).click(); await settle();
  const oldRaw = w.localStorage.getItem(EKEY);
  w.localStorage.removeItem(EKEY); storageEvt(w, oldRaw, null); await settle();
  ok('L30f ★同じ pending が別の画面で片づいた＝「片づきました（保存または破棄）」・「保存されました」と言わない', frozen(w) && frozenText(w).includes('片づきました（保存または破棄）') && !frozenText(w).includes('保存されました'));
  ok('L30d 片づいた後は送り直さない', editsSent(sent).length === 1 && !btn(R(w), '同じ内容で送り直す'));
}
{
  //   L30i 送り直しの画面で、owner・ver だけが変わった → 作り直さない・書かない
  const { w } = boot({ editRes: 'unknown' });
  await startEdit(w, 'S2');
  setReps(w, '1セット目の回数', '9');
  saveBtn(w).click(); await settle();
  const E = ed(w), oldRaw = w.localStorage.getItem(EKEY);
  let writes = 0; const orig = w.localStorage.setItem.bind(w.localStorage);
  w.Storage.prototype.setItem = function (k, v) { if (k === EKEY) writes++; return orig(k, v); };
  const node0 = R(w).querySelector('.k-caution');
  const B = Object.assign({}, E, { owner: 'FORM-B', ver: (E.ver || 0) + 5 });
  orig(EKEY, JSON.stringify(B)); storageEvt(w, oldRaw, JSON.stringify(B)); await settle();
  storageEvt(w, JSON.stringify(B), JSON.stringify(B)); await settle();
  ok('L30i ★送り直しの画面は owner・ver の変化で作り直さず（同じ画面のまま）、書き込みも0回（連鎖しない）', writes === 0 && R(w).querySelector('.k-caution') === node0 && !!node0 && node0.isConnected && !frozen(w), String(writes));
}
{
  //   L30f（同じタブ）・L30k：送信中に戻る→直す画面を開き直す（送り直しの画面）→ 元の送信が成功 → 鍵は消え、新しい画面は「片づきました」
  const { w } = boot({ hang: true });
  await startEdit(w, 'S2');
  setReps(w, '1セット目の回数', '9');
  saveBtn(w).click(); await settle();
  w.KarteUI.open('C1', NAME, 'training', { kind: 'trainingEdit', customerId: 'C1', sid: 'S2' }); await settle();
  ok('L30k 開き直した画面は送り直しの画面（読むだけ）', R(w).textContent.includes('記録を直した結果を確かめられませんでした'));
  const html0 = R(w).innerHTML.length;
  w.release(); await settle();
  ok('L30f ★同じタブ：元の送信の成功で鍵が消え、新しい画面は通知で「片づきました」（storage は同じ窓に届かない）', !w.localStorage.getItem(EKEY) && frozen(w) && frozenText(w).includes('片づきました'), frozenText(w));
  ok('L30k ★後始末した元のフォームは画面を描かない（「直しました」を出さない）', !R(w).querySelector('.k-eddone'));
}
{
  //   L30h（同じタブ）：送信中に開き直す → 元の送信が確定した失敗 → 新しい画面は入力の画面に作り直され、入力できる・中身が残る
  const { w } = boot({ hang: true, editRes: 'bad' });
  await startEdit(w, 'S2');
  setReps(w, '1セット目の回数', '9');
  saveBtn(w).click(); await settle();
  w.KarteUI.open('C1', NAME, 'training', { kind: 'trainingEdit', customerId: 'C1', sid: 'S2' }); await settle();
  const al0 = w.alerts.length;
  w.release(); await settle();
  const E = ed(w);
  ok('L30k ★後始末した元のフォームは、確定した失敗でも案内（alert）を出さない・画面を作り直さない', w.alerts.length === al0, JSON.stringify(w.alerts.slice(al0)));
  ok('L30h ★同じタブ：確定した失敗の後、新しい画面は入力の画面になり、中身（9回）が残る', E && !E.pending && !frozen(w) && !!R(w).querySelector('input[aria-label="1セット目の回数"]') && E.items[0].sets[0].r === '9', JSON.stringify(E && E.items));
  setReps(w, '1セット目の回数', '7');
  ok('L30h 作り直した画面で入力しても凍結しない', !frozen(w) && ed(w).items[0].sets[0].r === '7');
}
{
  //   L30k リスナーが増え続けない（開き直し10回）
  const { w } = boot();
  let add = 0, rem = 0;
  const a0 = w.document.addEventListener.bind(w.document), r0 = w.document.removeEventListener.bind(w.document);
  w.document.addEventListener = function (t, f, o) { if (t === 'karte-edit-draft') add++; return a0(t, f, o); };
  w.document.removeEventListener = function (t, f, o) { if (t === 'karte-edit-draft') rem++; return r0(t, f, o); };
  await startEdit(w, 'S2');
  for (let i = 0; i < 10; i++) { w.KarteUI.open('C1', NAME, 'training', { kind: 'trainingEdit', customerId: 'C1', sid: 'S2' }); await settle(); }
  ok('L30k ★開き直しを10回しても、生きている購読は1つ', add - rem === 1 && add === 11, add + '/' + rem);
  w.KarteUI.open('C1', NAME, 'summary'); await settle();
  ok('L30k 別の画面へ移ると購読は0', add - rem === 0);
}

// ================= L31 ログインの取り直し：直す画面に戻る =================
{
  const { w, sent } = boot();
  await startEdit(w, 'S2');
  setReps(w, '1セット目の回数', '9');
  w.idToken = jwt(3600 * 2);   // 古いトークン（送らずに取り直す）
  saveBtn(w).click(); await settle();
  const sd = JSON.parse(w.sessionStorage.getItem('karte_draft_v1') || 'null');
  ok('L31 ★送る前の取り直しの退避は kind:trainingEdit・直す元の sid（今日の記録の画面に戻らない）・送っていない', sd && sd.draft && sd.draft.kind === 'trainingEdit' && sd.draft.sid === 'S2' && editsSent(sent).length === 0, JSON.stringify(sd));
  ok('L31 退避に会員の名前を入れない', !JSON.stringify(sd).includes(NAME));
  w.idToken = jwt(30);
  w.KarteUI.open(sd.customerId, '', sd.tab, sd.draft); await settle();
  ok('L31 退避から開き直すと直す画面・入力（9回）が残っている', R(w).textContent.includes('の記録を直す') && ed(w).items[0].sets[0].r === '9');
}
{
  //   L31c 直す画面で種目の欄から新しい種目を登録しようとしてログインの取り直し → 退避は直す画面の形・戻ると直す画面で種目の欄が開いたまま
  const { w, sent } = boot();
  w.localStorage.setItem(DKEY, JSON.stringify({ v: 1, tid: 'T1', cid: 'C1', sessionDate: '2026-11-25', items: [], reqId: 'kreqTODAY3', pending: null, at: Date.now() }));
  const today0 = w.localStorage.getItem(DKEY);
  await startEdit(w, 'S2');
  btn(R(w), '＋ 種目を足す').click(); await settle();
  const q = R(w).querySelector('input[aria-label="種目を探す"]');
  q.value = '見本の新種目'; q.dispatchEvent(new w.Event('input')); await settle();
  w.idToken = jwt(3600 * 2);   // 古いトークン＝k_saveExercise を送らずに取り直す
  R(w).querySelector('.k-sugnew').click(); await settle();
  const sd = JSON.parse(w.sessionStorage.getItem('karte_draft_v1') || 'null');
  ok('L31c ★種目の登録の取り直しの退避は kind:trainingEdit・sid・種目の欄の途中（ex）つき・送っていない', sd && sd.draft && sd.draft.kind === 'trainingEdit' && sd.draft.sid === 'S2' && sd.draft.ex && sd.draft.ex.cid === 'C1'
     && sent.filter((b) => b.action === 'k_saveExercise').length === 0, JSON.stringify(sd && sd.draft));
  w.idToken = jwt(30);
  w.KarteUI.open(sd.customerId, '', sd.tab, sd.draft); await settle();
  const pk = R(w).querySelector('input[aria-label="種目を探す"]');
  ok('L31c ★戻ると直す画面で、種目の欄が開いたまま（検索の文字も戻る）・今日の下書きは変わらない', R(w).textContent.includes('の記録を直す') && !!pk && pk.value === '見本の新種目' && w.getComputedStyle(pk.closest('.k-picker') || pk.parentNode).display !== 'none'
     && w.localStorage.getItem(DKEY) === today0 && ed(w).editOf === 'S2', JSON.stringify([!!pk, pk && pk.value]));
}
{
}

// ================= L32 別の日の直しかけがあるとき =================
{
  const { w } = boot();
  await startEdit(w, 'S2');
  await openList(w); await openDay(w, 'S1');
  ok('L32 一覧に「直している途中です」の1行が出る（自動では開かない）', !!R(w).querySelector('.k-edresume') && !R(w).textContent.includes('の記録を直す'));
  editBtn(w).click(); await settle();
  ok('L32 別の日の［編集］＝破棄の確認を1回出してから開く', w.confirms.some((c) => c.includes('直しかけを破棄')) && ed(w).editOf === 'S1');
}

console.log(`${fail ? '❌' : '✅'} 保存した記録を直す（設計58・画面） 検証: ${pass} passed / ${fail} failed`);
if (fail) process.exit(1);
