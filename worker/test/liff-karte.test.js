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

// ================= 7. 設計31：タブ名・固定表・見立て・部位・配色 =================
{
  const H = await import('../src/lib/karte-hearing.js');
  const { w } = boot(async () => ({ success: true }));
  const T = w.KarteUI._t;
  const keys = (tbl) => JSON.stringify(Array.from(tbl, (x) => [x[0], x[1]]));
  ok('7-1 ★画面の固定表の鍵・表示名は Worker と同じ（目的・部位・痛み・タグ・理由）',
     keys(T.PURPOSES) === keys(H.PURPOSES) && keys(T.SLIM_AREAS) === keys(H.SLIM_AREAS) && keys(T.REGIONS) === keys(H.REGIONS)
     && keys(T.TAGS) === keys(H.TAGS) && JSON.stringify(Array.from(T.REASONS, (x) => [x[0], x[1], x[2]])) === JSON.stringify(H.REASONS));
  ok('7-2 ★タブは「体組成」（「からだ」を使わない）', SRC.includes("['body', '体組成']") && !/['"]からだ['"]/.test(SRC));
  ok('7-3 TOKOWAKA のネイビーを主に、モックと同じ作り（ゴシック体・角丸のカード・下のタブ）', /#1b2a47/.test(SRC) && /#f4f3ef/.test(SRC)
     && /border-radius:14px/.test(SRC) && /k-tabs\{[^}]*bottom:0/.test(SRC));
  ok('7-3b ★明朝体を使わない（スマホで線が細く読みにくい・2026-11-04 オーナー指摘「見にくさ」）', !/Shippori|Mincho|serif;/.test(SRC.replace(/sans-serif/g, '')));
  const rows = (a) => a.map(([d, wv, f, m]) => ({ d, w: wv, pbf: f, smm: m, s: {} }));
  ok('7-4 見立て：記録1件なら出さない', T.assess(rows([['2026-10-01', 60, 30, 20]]), []) === null);
  ok('7-5 見立て：体重・体脂肪率が下がり筋量を保つ → 良い方向', T.assess(rows([['2026-10-01', 60, 30, 20], ['2026-11-01', 59.2, 29.4, 20.1]]), ['diet']).kind === 'good');
  ok('7-6 ★見立て：減量が目的で両方上がる → 目的と逆', T.assess(rows([['2026-10-01', 60, 30, 20], ['2026-11-01', 61, 31, 20]]), ['diet']).kind === 'reverse');
  ok('7-7 見立て：差が小さい → ゆるやか', T.assess(rows([['2026-10-01', 60, 30, 20], ['2026-11-01', 60.2, 30.1, 20]]), ['diet']).kind === 'slow');
  ok('7-8 見立ての文は断定しない（「診断」「必ず」を使わない）', ['good', 'reverse', 'slow', 'mixed'].every(() => true)
     && !/必ず|確実に/.test(SRC.slice(SRC.indexOf('function assess'), SRC.indexOf('function lineChart'))));
  ok('7-9 ★部位：ショルダープレス＝肩・プレスダウン＝腕・レッグレイズ＝体幹・ヒップスラスト＝脚・尻・知らない種目＝その他',
     T.partOf('ショルダープレス') === '肩' && T.partOf('トライセプスプレスダウン') === '腕' && T.partOf('レッグレイズ') === '体幹'
     && T.partOf('ヒップスラスト') === '脚・尻' && T.partOf('ベンチプレス') === '胸' && T.partOf('バトルロープ') === 'その他');
  const st = T.exerciseStats([{ session_date: '2026-10-01', sets: [{ exercise: 'A', weight_kg: 40, reps: 10, e1rm: 53.3 }] },
                              { session_date: '2026-11-01', sets: [{ exercise: 'A', weight_kg: 50, reps: 8, e1rm: 63.3 }, { exercise: 'A', weight_kg: 50, reps: 10, e1rm: 66.7 }] }], 'A');
  ok('7-10 種目のまとめ：自己ベストは重量→回数の順・推定MAX・合計回数', st.best.w === 50 && st.best.r === 10 && st.maxE === 66.7 && st.reps === 28 && st.sets === 3);
}

// ================= 8. ヒアリングの保存・身体図・一覧の印 =================
{
  const evil = '<img src=x onerror="window.pwned=1">';
  const { w, sent } = boot(async (b) => {
    if (b.action === 'k_summary') return { success: true, karteSchema: 31, customer: { customerId: 'C1', name: '会員', trainerId: 'T1' }, assigned: true,
      consent: { state: 'agreed' }, profile: { rev: 3, goal_text: evil, goal_deadline: '2027-03-31', hearing: { purposes: ['diet'], slimAreas: ['belly'], motivation: 7, targetWeight: 54, exerciseNow: evil } },
      safetyBrief: { pain: [{ region: 'shoulder_r', level: 6, symptom: evil }], diagnosis: null, medication: null, restrictions: null }, lastNote: null, nextReservation: null };
    if (b.action === 'k_body') return { success: true, ready: true, rows: [{ d: '2026-10-01', w: 60, pbf: 30, s: {} }, { d: '2026-11-01', w: 58.4, pbf: 29.1, s: { w: 'i' } }], goal: null, raw: [] };
    if (b.action === 'k_saveProfile') return { success: true, rev: 4 };
    return { success: true };
  });
  w.KarteUI.open('C1', '会員', 'summary');
  await settle();
  const root = w.document.getElementById('karteRoot');
  ok('8-1 ★理想・ヒアリングの自由文・痛みの症状を HTML として解釈しない', !root.querySelector('img') && !w.pwned && root.textContent.includes('<img'));
  ok('8-2 注意すること：身体図に右肩 6 が載る（読み上げの名前にも）', !!root.querySelector('svg[aria-label*="右肩 6"]') && root.textContent.includes('右肩 6/10'));
  ok('8-3 目標の3列（現在 58.4kg → 54kg・あと 4.4kg）', root.textContent.includes('58.4kg') && root.textContent.includes('あと 4.4kg'));
  [...root.querySelectorAll('button')].find((x) => x.textContent === 'ヒアリングを編集').click();
  await settle();
  const pill = (t) => [...root.querySelectorAll('button')].find((x) => x.textContent.replace(/^\d+ /, '') === t);
  pill('筋力アップ').click(); pill('太もも').click(); pill('二の腕').click(); pill('背中').click();   // 3つまで（背中は入らない）
  [...root.querySelectorAll('button')].find((x) => x.textContent === 'ヒアリングを保存').click();
  await settle();
  const sp = sent.filter((x) => x.action === 'k_saveProfile').pop();
  ok('8-4 ★保存する中身：目的は配列・部位は押した順で3つまで・数値は数値型', sp && JSON.stringify(sp.hearing.purposes) === '["diet","strength"]'
     && JSON.stringify(sp.hearing.slimAreas) === '["belly","thigh","arm"]' && sp.hearing.motivation === 7 && sp.hearing.targetWeight === 54 && sp.rev === 3, JSON.stringify(sp && sp.hearing));
  ok('8-5 ★ヒアリングの保存に健康情報の鍵（painMap・diagnosis・medication）を載せない', sp && !('painMap' in sp) && !('diagnosis' in sp) && !('medication' in sp));
}
{
  //   安全面の保存：painMap を送り、端末に退避しない
  const { w, sent } = boot(async (b) => {
    if (b.action === 'k_summary') return { success: true, customer: { customerId: 'C1', name: '会員' }, assigned: true, consent: { state: 'agreed' }, safetyBrief: null, profile: null, lastNote: null, nextReservation: null };
    if (b.action === 'k_safety') return { success: true, karteSchema: 31, consent: 'agreed', safety: { rev: 2, pain: [{ region: 'lower_back', level: 4, symptom: '朝' }] } };
    if (b.action === 'k_saveSafety') return { success: false, code: 'UNAUTHORIZED', detail: 'STALE_TOKEN' };
    return { success: true };
  });
  w.KarteUI.open('C1', '会員', 'summary');
  await settle();
  const root = w.document.getElementById('karteRoot');
  [...root.querySelectorAll('button')].find((x) => x.textContent === '安全面を見る・書く').click();
  await settle();
  [...root.querySelectorAll('button')].find((x) => x.textContent === '右膝').click();
  [...root.querySelectorAll('button')].filter((x) => x.textContent === '7').pop().click();
  [...root.querySelectorAll('button')].find((x) => x.textContent === 'この部位を入れる').click();
  [...root.querySelectorAll('button')].find((x) => x.textContent === '保存する').click();
  await settle();
  const ss = sent.filter((x) => x.action === 'k_saveSafety').pop();
  ok('8-6 痛みの身体図を送る（既存の腰＋足した右膝・強さは数値）', ss && ss.painMap.length === 2 && ss.painMap.some((p) => p.region === 'knee_r' && p.level === 7) && ss.rev === 2, JSON.stringify(ss && ss.painMap));
  const saved = w.sessionStorage.getItem('karte_draft_v1') || '';
  ok('8-7 ★安全面（痛み）は端末に退避しない', !saved.includes('knee_r') && !saved.includes('lower_back'), saved);
}
{
  const { w } = boot(async (b) => {
    if (b.action === 'k_board') return { success: true, next: null, customers: [
      { customerId: 'C1', name: '会員一', flags: { noNextBooking: true, recordStale: false, contractEnding: false, paymentPending: false, caution: true, hearingMissing: false, consentPending: false } },
      { customerId: 'C2', name: '会員二', flags: { noNextBooking: false, recordStale: false, contractEnding: false, paymentPending: false, caution: false, hearingMissing: true, consentPending: true } }] };
    return { success: true };
  });
  w.KarteUI.openBoard();
  await settle();
  const root = w.document.getElementById('karteRoot');
  ok('8-8 一覧：声かけが要る人だけを最初に出す（注意あり・未記入は並べ替えに使わない）', root.textContent.includes('会員一') && !root.textContent.includes('会員二') && root.textContent.includes('注意あり'));
  [...root.querySelectorAll('button')].find((x) => x.textContent === 'ヒアリング未記入').click();
  ok('8-9 一覧：ヒアリング未記入で絞る・同意待ちの印', root.textContent.includes('会員二') && root.textContent.includes('同意待ち') && !root.textContent.includes('会員一'));
}

// ================= 9. 古い Worker には新しい項目を送らない（関門②） =================
{
  const K = await import('../src/routes/karte.js');
  const { w } = boot(async () => ({ success: true }));
  ok('9-1 ★画面が必要とする版と Worker の版が同じ', w.KarteUI._t.NEED_SCHEMA === K.KARTE_SCHEMA);
  const { w: w2, sent } = boot(async (b) => {
    if (b.action === 'k_summary') return { success: true, customer: { customerId: 'C1', name: '会員' }, assigned: true, consent: { state: 'agreed' },
      profile: { rev: 1, hearing: { purposes: ['diet'] } }, safetyBrief: null, lastNote: null, nextReservation: null };   // 版なし＝古い Worker
    if (b.action === 'k_safety') return { success: true, consent: 'agreed', safety: { rev: 1, pain: [] } };
    if (b.action === 'k_notes') return { success: true, notes: [] };
    return { success: true };
  });
  w2.KarteUI.open('C1', '会員', 'summary');
  await settle();
  const root = w2.document.getElementById('karteRoot');
  [...root.querySelectorAll('button')].find((x) => x.textContent === 'ヒアリングを編集').click();
  await settle();
  [...root.querySelectorAll('button')].find((x) => x.textContent === 'ヒアリングを保存').click();
  await settle();
  ok('9-2 ★版の無い Worker にはヒアリングを送らず、更新中と案内する', !sent.some((x) => x.action === 'k_saveProfile') && w2.alerts.some((a) => a.includes('更新中')));
  w2.KarteUI.open('C1', '会員', 'notes');
  await settle();
  const r2 = w2.document.getElementById('karteRoot');
  const tagPill = () => [...r2.querySelectorAll('button.k-pill')].find((x) => x.textContent === 'トレーニング');
  tagPill().click();
  r2.querySelectorAll('textarea')[0].value = 'タグ付きのメモ';
  [...r2.querySelectorAll('button')].find((x) => x.textContent === 'メモを保存').click();
  await settle();
  ok('9-3 ★版の無い Worker にはタグ付きのメモを送らない', !sent.some((x) => x.action === 'k_addNote'));
  tagPill().click();   // タグを外す
  [...r2.querySelectorAll('button')].find((x) => x.textContent === 'メモを保存').click();
  await settle();
  ok('9-4 タグなしのメモは古い Worker でも送れる（意味が変わらない）', sent.some((x) => x.action === 'k_addNote' && !x.tag));
}

{
  //   一度 31 を読んだ後、次の読み取りが失敗したら信用しない
  let n = 0;
  const { w, sent } = boot(async (b) => {
    if (b.action === 'k_notes') { n++; return n === 1 ? { success: true, karteSchema: 31, notes: [] } : { success: false, code: 'INTERNAL' }; }
    return { success: true };
  });
  w.KarteUI.open('C1', '会員', 'notes'); await settle();
  w.KarteUI.open('C1', '会員', 'notes'); await settle();
  const r = w.document.getElementById('karteRoot');
  [...r.querySelectorAll('button.k-pill')].find((x) => x.textContent === '食事').click();
  r.querySelectorAll('textarea')[0].value = 'x';
  [...r.querySelectorAll('button')].find((x) => x.textContent === 'メモを保存').click();
  await settle();
  ok('9-5 ★前に読んだ版を、今回の読み取りが失敗したときに信用しない', !sent.some((x) => x.action === 'k_addNote'));
}

console.log(`\n${fail ? '❌' : '✅'} カルテの画面 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
