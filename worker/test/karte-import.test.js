// 設計62 段3（過去分の取り込み k_importDay）と改訂8（体の注意 karte_health_notes）を、本物の SQLite に全 migration を流し、入口（index.js）から通す・2026-11-26
//   実行: node worker/test/karte-import.test.js
//   ★名前・ID・本文は架空の値だけ
import { readFileSync } from 'node:fs';
import { setup, jstDay } from './karte-sqlite-env.mjs';
import { isKarteWrite, healthImportOn, KARTE_LIMITS } from '../src/routes/karte.js';
import { CONSENT_DOCS } from '../src/lib/consent-docs.js';

let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) pass++; else { fail++; console.log(`❌ ${name}${detail ? '\n   ' + detail : ''}`); } }

const { env, d, call, crid, q1, qn, qa } = setup();
env.KARTE_TRAINING_EXT = 'on';
const NOW = Date.now();
const today = jstDay(NOW), past = jstDay(NOW - 200 * 86400000), future = jstDay(NOW + 2 * 86400000);
const HB = '左膝に違和感・見本の体の注意';   // 架空
const imp = (as, body, extra = {}) => call(as, 'k_importDay', { customerId: 'C1', sessionDate: past, clientReqId: extra.crid || crid(), ...body }, extra);
const clearRate = () => d.exec('DELETE FROM karte_rate');
const agree = (cid) => d.prepare(`INSERT INTO karte_consent (customer_id, kind, state, changed_at, method, recorded_by) VALUES (?, 'health', 'agreed', 1, 'paper', 't1')
  ON CONFLICT(customer_id, kind) DO UPDATE SET state = 'agreed'`).run(cid);
const counts = () => ({ s: qn(`SELECT COUNT(*) n FROM karte_tr_sessions`), n: qn(`SELECT COUNT(*) n FROM karte_notes`), h: qn(`SELECT COUNT(*) n FROM karte_health_notes`),
  rate: qn(`SELECT COALESCE(SUM(n), 0) n FROM karte_rate`) });
const ITEMS = [{ exercise: 'ベンチプレス', sets: [{ weight: 60, reps: 10 }, { weight: 55, reps: 8 }] }, { exercise: 'スクワット', sets: [{ weight: 0, reps: 20 }] }];
//   本文がどこかの列に残っていないか（全部の表の全部の文字の列を探す）
function textFound(needle) {
  const tabs = qa(`SELECT name FROM sqlite_master WHERE type = 'table'`).map((x) => x.name);
  const hit = [];
  for (const t of tabs) {
    const cols = qa(`PRAGMA table_info(${t})`).map((x) => x.name);
    for (const c of cols) { const r = q1(`SELECT COUNT(*) n FROM ${t} WHERE CAST(${c} AS TEXT) LIKE ?`, '%' + needle + '%'); if (r && r.n > 0) hit.push(t + '.' + c); }
  }
  return hit;
}

// ================= J1 記録とその日の社内メモが1つの batch・鍵・日付 =================
{
  const c0 = counts();
  const r = await imp('U_t1', { items: ITEMS, note: { body: '【指導したこと】見本の指導' } });
  ok('J1 入る：session・セット・社内メモ（タグ training・その日・作者）・応答は id だけ', r.status === 200 && r.sessionId && r.noteId && r.hnoteId === null
     && counts().s === c0.s + 1 && counts().n === c0.n + 1, JSON.stringify(r));
  const n = q1(`SELECT session_date, tag, author_trainer_id, body FROM karte_notes WHERE note_id = ?`, r.noteId);
  ok('J1 社内メモはその日・training・取り込んだトレーナー', n.session_date === past && n.tag === 'training' && n.author_trainer_id === 't1' && n.body === '【指導したこと】見本の指導');
  ok('J1 セットは3つ・自重は0', qn(`SELECT COUNT(*) n FROM karte_tr_sets WHERE session_id = ?`, r.sessionId) === 3 && qn(`SELECT COUNT(*) n FROM karte_tr_sets WHERE session_id = ? AND weight_kg = 0`, r.sessionId) === 1);
  //   ★社内メモの INSERT を落とすと記録も入らない（全部か無か）：社内メモの文を壊れた文に差し替える
  const c1 = counts();
  env._hook = (q) => (/INSERT INTO karte_notes/.test(q) ? [['INSERT INTO karte_notes (note_id) VALUES (NULL)', []]] : null);
  const bad = await imp('U_t1', { items: ITEMS, note: { body: '見本' } });
  env._hook = null;
  ok('J1 ★社内メモが失敗すると記録も入らない（1つの batch）', bad.status >= 400 && counts().s === c1.s && counts().n === c1.n, JSON.stringify(bad));
  clearRate();
  const st = [];
  for (const b of [{ member: { message: 'x' }, items: ITEMS }, { items: [], note: null }, {}, { sessionDate: future, items: ITEMS }, { sessionDate: '2026-02-30', items: ITEMS },
                   { note: { body: 'あ'.repeat(2001) } }, { note: { body: '  ' } }, { note: 'x' }, { note: { body: 'x', extra: 1 } }, { health: { body: 'あ'.repeat(2001) } }])
    st.push((await imp('U_t1', b)).status);
  ok('J1 member・空・未来の日・実在しない日・2,001字・空白だけ・形違い・知らない鍵は 400', st.every((x) => x === 400), JSON.stringify(st));
  const onlyNote = await imp('U_t1', { note: { body: 'メモだけの日' } });
  ok('J1 メモだけの日も入る（session は作らない）', onlyNote.status === 200 && onlyNote.sessionId === null && onlyNote.noteId);
}

// ================= J2 isKarteWrite・Origin・古いトークン =================
{
  ok('J2 isKarteWrite(k_importDay)・(k_deleteHealthNote) が真', isKarteWrite('k_importDay') && isKarteWrite('k_deleteHealthNote'));
  const o = await imp('U_t1', { items: ITEMS }, { origin: 'https://evil.example' });
  ok('J2 Origin 違いは 403', o.status === 403);
  const cu = await imp('U_c1', { items: ITEMS });
  ok('J2 会員は呼べない', cu.status === 403 || cu.status === 401);
}

// ================= J3 再送・同じ番号で違う中身 =================
{
  clearRate();
  const k = crid(), c0 = counts();
  const a = await imp('U_t1', { items: ITEMS, note: { body: '再送の見本' } }, { crid: k });
  const b = await imp('U_t1', { items: ITEMS, note: { body: '再送の見本' } }, { crid: k });
  const x = await imp('U_t1', { items: ITEMS, note: { body: '違う中身' } }, { crid: k });
  ok('J3 ★同じ番号の再送は同じ応答・行は増えない／同じ番号で違う中身は 409', a.status === 200 && b.replayed === true && b.sessionId === a.sessionId && x.status === 409
     && counts().s === c0.s + 1 && counts().n === c0.n + 1);
}

// ================= J4 回数は通常の枠の中・429 に retryAt =================
{
  clearRate();
  for (let i = 0; i < KARTE_LIMITS.RATE_PER_WINDOW - 1; i++) d.exec(`INSERT INTO karte_rate (trainer_id, window_start, n) VALUES ('t2', ${Math.floor(Date.now() / KARTE_LIMITS.WINDOW_MS) * KARTE_LIMITS.WINDOW_MS}, ${KARTE_LIMITS.RATE_PER_WINDOW - 1}) ON CONFLICT DO NOTHING`);
  const add = await call('U_t2', 'k_addNote', { customerId: 'C2', sessionDate: past, body: '通常の書き込み', clientReqId: crid() });
  const r = await call('U_t2', 'k_importDay', { customerId: 'C2', sessionDate: past, items: ITEMS, clientReqId: crid() });
  const win = Math.floor(Date.now() / KARTE_LIMITS.WINDOW_MS) * KARTE_LIMITS.WINDOW_MS;
  ok('J4 ★通常の書き込みと合わせて60回で 429・retryAt はその10分の区切りの終わり（Worker の時計）', add.status === 200 && r.status === 429 && r.code === 'RATE_LIMITED' && r.retryAt === win + KARTE_LIMITS.WINDOW_MS, JSON.stringify(r));
  const other = await call('U_t2', 'k_importDay', { customerId: 'C2', sessionDate: 'x', clientReqId: crid() });
  ok('J4 ほかの失敗には retryAt が付かない', other.status === 400 && !('retryAt' in other));
  clearRate();
}

// ================= J5 最大の形の1日 =================
{
  const big = [];
  for (let i = 0; i < 20; i++) big.push({ exercise: '見本種目' + i, sets: Array.from({ length: i < 10 ? 4 : 2 }, (_, k) => ({ weight: 10 + k, reps: 10 })) });
  const total = big.reduce((a, x) => a + x.sets.length, 0);
  const r = await imp('U_t1', { items: big, note: { body: 'あ'.repeat(2000) } });
  ok('J5 20種目・60セット・2,000字のメモを1つの batch で入れられる', total === 60 && r.status === 200 && qn(`SELECT COUNT(*) n FROM karte_tr_sets WHERE session_id = ?`, r.sessionId) === 60, JSON.stringify(r));
}

// ================= HN1 スイッチ =================
{
  clearRate();
  ok('HN1 既定は止まる（未設定・off・allow・On は偽／on だけ真）', !healthImportOn({}) && !healthImportOn({ KARTE_HEALTH_IMPORT: 'off' }) && !healthImportOn({ KARTE_HEALTH_IMPORT: 'allow' })
     && !healthImportOn({ KARTE_HEALTH_IMPORT: 'On' }) && healthImportOn({ KARTE_HEALTH_IMPORT: 'on' }));
  agree('C1');
  const c0 = counts();
  const r = await imp('U_t1', { items: ITEMS, note: { body: '止まっている日' }, health: { body: HB } });
  ok('HN1 ★止まっているとき health つきは 409 HEALTH_IMPORT_OFF・記録も社内メモも入らない・回数も数えない', r.status === 409 && r.code === 'HEALTH_IMPORT_OFF' && JSON.stringify(counts()) === JSON.stringify(c0), JSON.stringify([r, counts(), c0]));
  const r2 = await imp('U_t1', { items: ITEMS });
  ok('HN1 health なしは止まらない', r2.status === 200);
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  // ★2026-11-26 オーナー決定で on。on は「この1行だけ」で、値の揺れ（allow 等）を許さない。開くなら同意の画面（MEMBER_CONSENT）を広げないことと組み
  ok('HN1 ★wrangler.toml の KARTE_HEALTH_IMPORT は無いか、厳密に "on" の1行だけ（2026-11-26 オーナー決定）',
     (!/^KARTE_HEALTH_IMPORT\s*=/m.test(toml))
     || ((toml.match(/^KARTE_HEALTH_IMPORT\s*=.*$/mg) || []).length === 1 && /^KARTE_HEALTH_IMPORT = "on"$/m.test(toml)));
}

// ================= HN2 同意 =================
{
  clearRate();
  env.KARTE_HEALTH_IMPORT = 'on';
  const c0 = counts();
  const no = await call('U_t1', 'k_importDay', { customerId: 'C3', sessionDate: past, items: ITEMS, note: { body: '同意なし' }, health: { body: HB }, clientReqId: crid() });
  ok('HN2 ★同意なし（none）は 403 NO_CONSENT・その日の記録も社内メモも入らない', no.status === 403 && no.code === 'NO_CONSENT' && counts().s === c0.s && counts().n === c0.n && counts().h === c0.h, JSON.stringify(no));
  d.prepare(`INSERT INTO karte_consent (customer_id, kind, state, changed_at, method, recorded_by) VALUES ('C3', 'health', 'revoked', 1, NULL, 't1')`).run();
  const rv = await call('U_t1', 'k_importDay', { customerId: 'C3', sessionDate: past, items: ITEMS, health: { body: HB }, clientReqId: crid() });
  ok('HN2 撤回済み（revoked）も 403', rv.status === 403 && counts().h === c0.h);
  const yes = await imp('U_t1', { items: ITEMS, note: { body: '同意ありの日' }, health: { body: '  ' + HB + '  ' } });
  const h = q1(`SELECT * FROM karte_health_notes WHERE hnote_id = ?`, yes.hnoteId);
  ok('HN2 ★同意あり・on：3つが1つの batch で入る・体の注意は前後の空白を落としてその日・取り込みの印', yes.status === 200 && yes.sessionId && yes.noteId && h && h.body === HB && h.note_date === past && h.origin === 'import' && h.created_by === 't1');
  ok('HN2 社内メモに体の注意の本文は入らない', !q1(`SELECT body FROM karte_notes WHERE note_id = ?`, yes.noteId).body.includes(HB));
  //   ★見張り（G.consent）を外しても書く文の条件で入らない：書く文だけが残ると0行＝記録・メモは入るが体の注意は入らない…ではなく、見張りが本命。見張りを落としたときの挙動を固定する
  env._hook = (q) => (/INSERT INTO karte_guard \(consent\)/.test(q) ? [] : null);
  const c1 = counts();
  const leak = await call('U_t1', 'k_importDay', { customerId: 'C2', sessionDate: past, health: { body: HB }, note: { body: '見張りなし' }, clientReqId: crid() });
  env._hook = null;
  ok('HN2 ★見張りが無くても書く文の条件で同意の無い会員に体の注意は入らない（I48 の二重）', counts().h === c1.h, JSON.stringify(leak));
  d.exec(`DELETE FROM karte_tr_sessions WHERE customer_id = 'C2'; DELETE FROM karte_notes WHERE body = '見張りなし'`);
}

// ================= HN3 撤回で消える（トレーナー・会員）・再同意で戻らない =================
{
  clearRate();
  ok('HN3 前提：C1 に体の注意がある', qn(`SELECT COUNT(*) n FROM karte_health_notes WHERE customer_id = 'C1'`) >= 1);
  const r = await call('U_t1', 'k_saveConsent', { customerId: 'C1', state: 'revoked', clientReqId: crid() });
  ok('HN3 ★トレーナーの撤回で同じ batch に消える', r.status === 200 && qn(`SELECT COUNT(*) n FROM karte_health_notes WHERE customer_id = 'C1'`) === 0, JSON.stringify(r));
  agree('C1');
  ok('HN3 再同意しても戻らない', qn(`SELECT COUNT(*) n FROM karte_health_notes WHERE customer_id = 'C1'`) === 0);
  await imp('U_t1', { health: { body: HB } });
  env.MEMBER_CONSENT = 'on'; env.MEMBER_CONSENT_TRAINERS = '';
  const m = await call('U_c1', 'm_saveConsent', { answers: { health: 'revoked' }, vers: { health: CONSENT_DOCS.health.ver } });
  ok('HN3 ★会員の撤回（m_saveConsent）でも同じ batch に消える', m.status === 200 && qn(`SELECT COUNT(*) n FROM karte_health_notes WHERE customer_id = 'C1'`) === 0, JSON.stringify(m));
  env.MEMBER_CONSENT = 'off';
}

// ================= HN4 読み：同意の JOIN・失敗は null・会員の応答に出ない =================
{
  clearRate();
  agree('C1');
  const a = await imp('U_t1', { sessionDate: past, health: { body: HB + '一' } });
  const b = await imp('U_t2', { sessionDate: today, health: { body: HB + '二' } });
  let r = await call('U_t2', 'k_safety', { customerId: 'C1' });
  ok('HN4 k_safety：healthNotes（新しい順・日付・本文・取り込んだ人）・healthImport', r.status === 200 && r.healthNotes.length === 2 && r.healthNotes[0].id === b.hnoteId && r.healthNotes[0].date === today
     && r.healthNotes[1].body === HB + '一' && r.healthNotes[1].by === 't1' && r.healthImport === true && r.healthNotesTruncated === false, JSON.stringify(r.healthNotes));
  d.exec(`UPDATE karte_consent SET state = 'revoked' WHERE customer_id = 'C1'`);
  r = await call('U_t2', 'k_safety', { customerId: 'C1' });
  ok('HN4 ★同意が無ければ（行が残っていても）読まない＝空', Array.isArray(r.healthNotes) && r.healthNotes.length === 0);
  agree('C1');
  env._failRe = /FROM karte_health_notes h/;
  r = await call('U_t2', 'k_safety', { customerId: 'C1' });
  env._failRe = null;
  ok('HN4 読めなければ healthNotes は null（空配列にしない）・他は返る', r.status === 200 && r.healthNotes === null && r.consent === 'agreed');
  const sm = await call('U_t1', 'k_summary', { customerId: 'C1' });
  ok('HN4 k_summary に体の注意の本文が出ない', sm.status === 200 && !JSON.stringify(sm).includes(HB));
  const src = readFileSync(new URL('../src/lib/member-karte.js', import.meta.url), 'utf8') + readFileSync(new URL('../src/routes/member-karte.js', import.meta.url), 'utf8');
  ok('HN4 会員のカルテのコードは karte_health_notes を読まない', !/karte_health_notes/.test(src));
  env.KARTE_HEALTH_IMPORT = undefined;
  r = await call('U_t2', 'k_safety', { customerId: 'C1' });
  ok('HN4 スイッチが止まっていれば healthImport は偽（入れた行は見えるまま）', r.healthImport === false && r.healthNotes.length === 2);
  env.KARTE_HEALTH_IMPORT = 'on';
}

// ================= HN5 消す =================
{
  clearRate();
  const r = await call('U_t1', 'k_safety', { customerId: 'C1' });
  const mine = r.healthNotes.find((x) => x.by === 't1'), other = r.healthNotes.find((x) => x.by === 't2');
  const deny = await call('U_t1', 'k_deleteHealthNote', { hnoteId: other.id, clientReqId: crid() });
  ok('HN5 ほかの人が入れた行は消せない（403）', deny.status === 403 && qn(`SELECT COUNT(*) n FROM karte_health_notes WHERE hnote_id = ?`, other.id) === 1);
  const del = await call('U_t1', 'k_deleteHealthNote', { hnoteId: mine.id, clientReqId: crid() });
  ok('HN5 本人は消せる・行ごと消える', del.status === 200 && qn(`SELECT COUNT(*) n FROM karte_health_notes WHERE hnote_id = ?`, mine.id) === 0);
  const own = await call('U_OWN', 'k_deleteHealthNote', { hnoteId: other.id, clientReqId: crid() });
  ok('HN5 オーナーは消せる', own.status === 200 && qn(`SELECT COUNT(*) n FROM karte_health_notes WHERE hnote_id = ?`, other.id) === 0);
  const again = await call('U_OWN', 'k_deleteHealthNote', { hnoteId: other.id, clientReqId: crid() });
  ok('HN5 無い行は 404', again.status === 404);
}

// ================= HN7 本文が控え・記録に残らない =================
{
  ok('HN7 ★取り込み・消す・撤回の後、体の注意の本文はどの表のどの列にも残っていない（karte_requests・access_log・revisions を含む）', textFound(HB).length === 0, JSON.stringify(textFound(HB)));
}

console.log(`${fail ? '❌' : '✅'} 過去分の取り込み・体の注意（設計62 段3・Worker） 検証: ${pass} passed / ${fail} failed`);
if (fail) process.exit(1);
