// 設計62 段2（過去のまとめ・まとめ待ち・1か月の読み・月ごとの1行）を、本物の SQLite に全 migration を流し、入口（index.js）から通す・2026-11-26
//   実行: node worker/test/karte-history.test.js
//   ★名前・ID・本文は架空の値だけ
import { readFileSync } from 'node:fs';
import { setup, jstDay } from './karte-sqlite-env.mjs';
import { windowStart, monthsAllRead, PAST_LIMITS } from '../src/routes/karte.js';

let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) pass++; else { fail++; console.log(`❌ ${name}${detail ? '\n   ' + detail : ''}`); } }

const { env, d, call, crid, q1, qn, qa } = setup();
const NOW = Date.now();
const B = windowStart(NOW);
const thisMonth = jstDay(NOW).slice(0, 7);
const addM = (m, k) => { let y = +m.slice(0, 4), mo = +m.slice(5, 7) + k; while (mo <= 0) { mo += 12; y--; } while (mo > 12) { mo -= 12; y++; } return `${y}-${String(mo).padStart(2, '0')}`; };
const bm = B.slice(0, 7);
const old1 = addM(bm, -1), old2 = addM(bm, -2), old3 = addM(bm, -3), old5 = addM(bm, -5);
const save = (as, body, extra = {}) => call(as, 'k_saveHistory', { customerId: 'C1', clientReqId: extra.crid || crid(), ...body }, extra);
const clearRate = () => d.exec('DELETE FROM karte_rate');
let nseq = 0;
function insNote(cid, date, del) {
  const id = 'N' + (++nseq);
  d.prepare(`INSERT INTO karte_notes (note_id, customer_id, session_date, body, author_trainer_id, rev, created_at, deleted_at) VALUES (?, ?, ?, '見本のメモ', 't1', 1, ?, ?)`).run(id, cid, date, nseq, del ? 5 : null);
  return id;
}

// ================= H1 作る・直す・消す・戻す：rev は単調・控え・形の 400 =================
{
  const c0 = await save('U_t1', { rev: 0, periodFrom: old5, periodTo: old2, body: '見本のまとめ一', origin: 'import' });
  ok('H1 作る：rev 0 → 1・digestId を返す', c0.status === 200 && c0.rev === 1 && /^[0-9a-f-]{36}$/.test(c0.digestId), JSON.stringify(c0));
  const id = c0.digestId;
  const row = q1(`SELECT * FROM karte_history_digest WHERE digest_id = ?`, id);
  ok('H1 表は rev 1・origin import・作者と更新者は送った人', row && row.rev === 1 && row.origin === 'import' && row.created_by === 't1' && row.updated_by === 't1' && row.period_from === old5 && row.period_to === old2);
  const e1 = await save('U_t2', { digestId: id, rev: 1, periodFrom: old5, periodTo: old1, body: '見本のまとめ一（直した）' });
  ok('H1 直す：rev 1 → 2・更新者は直した人・origin は trainer', e1.status === 200 && e1.rev === 2 && q1(`SELECT rev, updated_by, origin, body FROM karte_history_digest WHERE digest_id = ?`, id).updated_by === 't2', JSON.stringify(e1));
  const stale = await save('U_t1', { digestId: id, rev: 1, periodFrom: old5, periodTo: old1, body: '古い版から' });
  ok('H1 古い rev は 409 CONFLICT・何も変わらない', stale.status === 409 && stale.code === 'CONFLICT' && q1(`SELECT rev FROM karte_history_digest WHERE digest_id = ?`, id).rev === 2);
  const del = await save('U_t1', { digestId: id, rev: 2, body: '' });
  ok('H1 消す（本文が空）：rev 3・deleted_at・行は残る', del.status === 200 && del.rev === 3 && del.deleted === true && q1(`SELECT deleted_at FROM karte_history_digest WHERE digest_id = ?`, id).deleted_at > 0);
  const del2 = await save('U_t1', { digestId: id, rev: 3, body: '' });
  ok('H1 消した行を消し直すのは 404（rev を進めない）', del2.status === 404 && q1(`SELECT rev FROM karte_history_digest WHERE digest_id = ?`, id).rev === 3);
  const back = await save('U_t1', { digestId: id, rev: 3, periodFrom: old5, periodTo: old1, body: '戻した本文' });
  ok('H1 戻す：rev 4・deleted_at が空', back.status === 200 && back.rev === 4 && q1(`SELECT deleted_at FROM karte_history_digest WHERE digest_id = ?`, id).deleted_at === null);
  const rv = qa(`SELECT rev, before_json, reason FROM karte_revisions WHERE table_name = 'karte_history_digest' AND row_id = ? ORDER BY id`, id);
  ok('H1 控え：直す・消す・戻すの3回、直前の rev と本文・期間・origin・deleted_at', rv.length === 3 && rv.map((x) => x.rev).join() === '1,2,3' && JSON.parse(rv[0].before_json).body === '見本のまとめ一'
     && JSON.parse(rv[0].before_json).origin === 'import' && JSON.parse(rv[2].before_json).deleted_at > 0 && rv[1].reason === 'delete', JSON.stringify(rv));
  clearRate();
  const bad = [];
  for (const b of [
    { rev: 0, periodFrom: old2, periodTo: addM(thisMonth, 1), body: 'x' },      // 未来の月
    { rev: 0, periodFrom: old1, periodTo: old2, body: 'x' },                    // from > to
    { rev: 0, periodFrom: '2026-13', periodTo: '2026-13', body: 'x' },          // 実在しない月
    { rev: 0, periodFrom: old2, periodTo: old1, body: 'あ'.repeat(4001) },       // 4,001字
    { rev: 0, periodFrom: old2, periodTo: old1, body: '   ' },                  // 作るのに空
    { rev: 1, periodFrom: old2, periodTo: old1, body: 'x' },                    // 作るのに rev 1
    { rev: 0, periodFrom: old2, periodTo: old1, body: 'x', origin: 'ai' },      // origin
    { digestId: 'a b', rev: 1, periodFrom: old2, periodTo: old1, body: 'x' },   // id の形
    { digestId: id, rev: 0, periodFrom: old2, periodTo: old1, body: 'x' },      // 直すのに rev 0
  ]) bad.push((await save('U_t1', b)).status);
  ok('H1 未来の月・from>to・実在しない月・4,001字・空・作るのに rev 1・origin・id の形・直すのに rev 0 は 400', bad.every((x) => x === 400), JSON.stringify(bad));
  const ok4000 = await save('U_t1', { rev: 0, periodFrom: thisMonth, periodTo: thisMonth, body: 'あ'.repeat(4000) });
  ok('H1 4,000字・今月（境界の月以後）でも受ける', ok4000.status === 200);
  const noReq = await call('U_t1', 'k_saveHistory', { customerId: 'C1', rev: 0, periodFrom: old2, periodTo: old1, body: 'x' });
  ok('H1 clientReqId なしは 400', noReq.status === 400);
  const k = crid();
  const r1 = await save('U_t1', { rev: 0, periodFrom: old3, periodTo: old3, body: '重なる期間' }, { crid: k });
  const r2 = await save('U_t1', { rev: 0, periodFrom: old3, periodTo: old3, body: '重なる期間' }, { crid: k });
  const r3 = await save('U_t1', { rev: 0, periodFrom: old3, periodTo: old3, body: '違う中身' }, { crid: k });
  ok('H1 同じ番号の再送は同じ応答（行は増えない）・同じ番号で違う中身は 409・期間の重なりは止めない', r1.status === 200 && r2.replayed === true && r2.digestId === r1.digestId && r3.status === 409
     && qn(`SELECT COUNT(*) n FROM karte_history_digest WHERE body = '重なる期間'`) === 1);
  const c2 = await call('U_t2', 'k_saveHistory', { customerId: 'C2', rev: 0, periodFrom: old2, periodTo: old2, body: '別の会員', clientReqId: crid() });
  const cross = await call('U_t1', 'k_saveHistory', { customerId: 'C1', digestId: c2.digestId, rev: 1, periodFrom: old2, periodTo: old2, body: '奪う', clientReqId: crid() });
  ok('H1 ★別の会員のブロックの id を C1 として直すのは 404・中身は変わらない', cross.status === 404 && q1(`SELECT body FROM karte_history_digest WHERE digest_id = ?`, c2.digestId).body === '別の会員');
}

// ================= H2 守り：Origin・許可表 =================
{
  clearRate();
  const o = await save('U_t1', { rev: 0, periodFrom: old2, periodTo: old2, body: 'x' }, { origin: 'https://evil.example' });
  ok('H2 isKarteWrite に当たる（Origin 違いは 403）', o.status === 403, JSON.stringify(o));
  const cu = await save('U_c1', { rev: 0, periodFrom: old2, periodTo: old2, body: 'x' });
  ok('H2 会員は呼べない（許可表は trainer／owner）', cu.status === 403 || cu.status === 401, JSON.stringify(cu));
  const ow = await save('U_OWN', { rev: 0, periodFrom: old2, periodTo: old2, body: 'オーナーのまとめ' });
  ok('H2 オーナーは書ける', ow.status === 200);
}

// ================= H3 k_notes の初回だけ history・pendingMonths・覆われた月は待ちに入らない =================
{
  d.exec(`DELETE FROM karte_history_digest; DELETE FROM karte_notes;`);
  insNote('C1', `${old1}-10`); insNote('C1', `${old1}-11`); insNote('C1', `${old2}-03`); insNote('C1', `${old3}-03`);
  insNote('C1', `${old5}-01`, true);   // 消したメモの月は入らない
  insNote('C1', `${bm}-02`);           // 境界の月は入らない
  insNote('C2', `${old1}-01`);         // 別の会員
  let r = await call('U_t2', 'k_notes', { customerId: 'C1' });
  ok('H3 初回：history は空配列・pendingMonths は境界より前で生きたメモの月（新しい順・件数）', r.status === 200 && Array.isArray(r.history) && r.history.length === 0
     && JSON.stringify(r.pendingMonths) === JSON.stringify([{ month: old1, n: 2 }, { month: old2, n: 1 }, { month: old3, n: 1 }]) && r.agg.history === 'ok' && r.agg.pending === 'ok', JSON.stringify(r.pendingMonths));
  clearRate();
  const blk = await save('U_t1', { rev: 0, periodFrom: old3, periodTo: old2, body: '見本のまとめ' });
  r = await call('U_t2', 'k_notes', { customerId: 'C1' });
  ok('H3 ブロックが覆う月（old3〜old2）は待ちから外れる・history に出る', JSON.stringify(r.pendingMonths) === JSON.stringify([{ month: old1, n: 2 }])
     && r.history.length === 1 && r.history[0].from === old3 && r.history[0].to === old2 && r.history[0].rev === 1 && r.history[0].updatedBy === 't1');
  await save('U_t1', { digestId: blk.digestId, rev: 1, body: '' });
  r = await call('U_t2', 'k_notes', { customerId: 'C1' });
  ok('H3 消したブロックの月は待ちに戻る・history から消える', r.pendingMonths.length === 3 && r.history.length === 0);
  const pg = await call('U_t2', 'k_notes', { customerId: 'C1', older: true });
  ok('H3 初回以外（older）には history・pendingMonths が付かない', pg.status === 200 && !('history' in pg) && !('pendingMonths' in pg));
}

// ================= H4 会員の応答・k_summary に出ない =================
{
  clearRate();
  await save('U_t1', { rev: 0, periodFrom: old2, periodTo: old2, body: '見本の内側のまとめ' });
  const sm = await call('U_t1', 'k_summary', { customerId: 'C1' });
  ok('H4 k_summary に history の鍵も本文も無い', sm.status === 200 && !JSON.stringify(sm).includes('見本の内側のまとめ') && !('history' in sm));
  const src = readFileSync(new URL('../src/lib/member-karte.js', import.meta.url), 'utf8') + readFileSync(new URL('../src/routes/member-karte.js', import.meta.url), 'utf8');
  ok('H4 会員のカルテのコードは karte_history_digest を読まない', !/karte_history_digest/.test(src));
}

// ================= H5 読みの失敗は null・CHECK =================
{
  env._failRe = /FROM karte_history_digest/;
  const r = await call('U_t2', 'k_notes', { customerId: 'C1' });
  env._failRe = null;
  ok('H5 ★まとめが読めなければ history も pendingMonths も null・状態は unavailable（メモの一覧は返る）', r.status === 200 && r.history === null && r.pendingMonths === null
     && r.agg.history === 'unavailable' && r.agg.pending === 'unavailable' && Array.isArray(r.notes), JSON.stringify(r.agg));
  const chk = (sql) => { try { d.exec(sql); return false; } catch (_) { return true; } };
  const base = (f, t, rev = 1) => `INSERT INTO karte_history_digest (digest_id, customer_id, period_from, period_to, body, origin, rev, created_by, created_at, updated_by, updated_at) VALUES ('z${Math.random()}', 'C1', '${f}', '${t}', 'x', 'trainer', ${rev}, 't1', 1, 't1', 1)`;
  ok('H5 CHECK：月 13・from > to・rev 0・空の本文は表が拒む', chk(base('2026-13', '2026-13')) && chk(base('2026-05', '2026-04')) && chk(base('2026-04', '2026-04', 0))
     && chk(`INSERT INTO karte_history_digest (digest_id, customer_id, period_from, period_to, body, origin, rev, created_by, created_at, updated_by, updated_at) VALUES ('zz', 'C1', '2026-04', '2026-04', '', 'trainer', 1, 't1', 1, 't1', 1)`));
}

// ================= M k_notes の1か月の読み（month）と M のカーソル =================
{
  d.exec(`DELETE FROM karte_notes;`);
  for (let i = 1; i <= 25; i++) insNote('C1', `${old2}-${String((i % 28) + 1).padStart(2, '0')}`);
  insNote('C1', `${old1}-01`); insNote('C1', `${old3}-28`);
  const seen = [];
  let r = await call('U_t2', 'k_notes', { customerId: 'C1', month: old2 }), n = 0;
  const first = r;
  for (;;) { seen.push(...r.notes.map((x) => x.session_date)); if (!r.more || ++n > 5) break; r = await call('U_t2', 'k_notes', { customerId: 'C1', cursor: r.nextCursor }); }
  ok('M1 その月の25件だけを20件＋5件で読み切る（月の外は出ない）・カーソルは M の系列', first.notes.length === 20 && /^M\|/.test(first.nextCursor) && seen.length === 25 && seen.every((x) => x.slice(0, 7) === old2) && first.month === old2, `${seen.length}`);
  const bads = [];
  for (const b of [{ month: bm }, { month: thisMonth }, { cursor: `M|${bm}|${bm}-01|1|a` }, { cursor: `M|${old2}|${old1}-01|1|a` }]) bads.push((await call('U_t2', 'k_notes', { customerId: 'C1', ...b })).status);
  ok('M2 境界の月以後の month・境界の月の M カーソル・月の外の日付のカーソルは 400', bads.every((x) => x === 400), JSON.stringify(bads));
  const tr = await call('U_t2', 'k_training', { customerId: 'C1', cursor: first.nextCursor });
  ok('M3 k_training は M のカーソルを受けない（400）', tr.status === 400);
}

// ================= H6 monthsAll（月ごとの1行） =================
{
  let s = 0;
  const ins = (date, sets, opt = {}) => {
    const sid = 'MS' + (++s);
    d.prepare(`INSERT INTO karte_tr_sessions (session_id, customer_id, session_date, author_trainer_id, rev, created_at, deleted_at) VALUES (?, 'C3', ?, 't1', 1, ?, ?)`).run(sid, date, s, opt.del ? 1 : null);
    sets.forEach((x, i) => {
      const r = d.prepare(`INSERT INTO karte_tr_sets (session_id, exercise, set_no, weight_kg, reps) VALUES (?, ?, ?, ?, ?)`).run(sid, x[0], i + 1, x[1], x[2]);
      if (x[3]) d.prepare(`INSERT INTO karte_tr_set_ext (set_id, session_id, ord, forced) VALUES (?, ?, 1, 1)`).run(Number(r.lastInsertRowid), sid);
    });
    if (opt.doneOnly) d.prepare(`INSERT INTO karte_tr_exercises (session_id, ord, exercise, done_only) VALUES (?, 1, ?, 1)`).run(sid, opt.doneOnly);
    return sid;
  };
  ins(`${old1}-03`, [['スクワット', 80, 5], ['ベンチプレス', 60, 10]]);
  ins(`${old1}-10`, [['スクワット', 80, 5]]);                // 同点（80×5）は早い日
  ins(`${old1}-12`, [['スクワット', 120, 3, true]]);         // 無理やりは数えない
  ins(`${old1}-15`, [], { doneOnly: 'ストレッチ' });          // 数字の無い種目だけの回も数える
  ins(`${old1}-20`, [['デッドリフト', 200, 1]], { del: true }); // 消した回は数えない
  ins(`${old2}-05`, [], { doneOnly: 'ストレッチ' });
  ins(`${bm}-05`, [['スクワット', 300, 1]]);                  // 境界の月は入らない
  const ma = await monthsAllRead(env, 'C3', B);
  ok('H6 ★回数（数字の無い回を含む・消した回を除く）・主な種目（出た回の数→名前）・最高（無理やりを除く・同点は早い日）', ma.length === 2
     && ma[0].month === old1 && ma[0].sessions === 4 && JSON.stringify(ma[0].top) === JSON.stringify(['スクワット', 'ストレッチ', 'ベンチプレス'])
     && JSON.stringify(ma[0].best) === JSON.stringify({ exercise: 'スクワット', w: 80, r: 5, d: `${old1}-03` }), JSON.stringify(ma));
  ok('H6 数字の行が無い月は best が null', ma[1].month === old2 && ma[1].sessions === 1 && ma[1].best === null && ma[1].top[0] === 'ストレッチ');
  const all = await call('U_t2', 'k_trainingAll', { customerId: 'C3' });
  ok('H6 k_trainingAll に monthsAll と agg.months', all.status === 200 && Array.isArray(all.monthsAll) && all.monthsAll.length === 2 && all.agg.months === 'ok');
  env._failRe = /substr\(session_date, 1, 7\) AS month, COUNT/;
  const f = await call('U_t2', 'k_trainingAll', { customerId: 'C3' });
  env._failRe = null;
  ok('H6 失敗は monthsAll null・unavailable（ほかの集計は返る）', f.monthsAll === null && f.agg.months === 'unavailable' && f.agg.best === 'ok');
  ok('H6 上限は36か月', PAST_LIMITS.MONTHS === 36);
}

console.log(`${fail ? '❌' : '✅'} 過去のまとめ（設計62 段2・Worker） 検証: ${pass} passed / ${fail} failed`);
if (fail) process.exit(1);
