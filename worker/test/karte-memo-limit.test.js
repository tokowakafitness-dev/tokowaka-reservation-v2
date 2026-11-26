// 設計63：社内メモの字数の上限（2026-11-26 に 2,000→4,000）が画面と Worker で揃っていること・最大の社内メモが本文16KB に入ることを、
//   本物の SQLite に全 migration を流した Worker の入口（index.js）から通して確かめる
//   実行: node worker/test/karte-memo-limit.test.js
//   ★本文は架空の文字だけ
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup, jstDay } from './karte-sqlite-env.mjs';
import { KARTE_LIMITS } from '../src/routes/karte.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(process.env.KARTE_SRC || join(HERE, '../../liff/karte.js'), 'utf8');
let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) pass++; else { fail++; console.log(`❌ ${name}${detail ? '\n   ' + detail : ''}`); } }

// ---- L1 画面と Worker の値が1つ ----
const m = SRC.match(/var NOTE_MAX = (\d+);/);
ok('L1 画面の NOTE_MAX は Worker の KARTE_LIMITS.NOTE_CHARS と同じ', !!m && Number(m[1]) === KARTE_LIMITS.NOTE_CHARS && KARTE_LIMITS.NOTE_CHARS === 4000, m && m[1]);
ok('L1 画面の本文の上限は Worker の BODY_BYTES と同じ', /var BODY_BYTES = 16 \* 1024, BODY_RESERVE = 2048;/.test(SRC) && KARTE_LIMITS.BODY_BYTES === 16 * 1024);
//   ★複製を残すと黙って止まる：社内メモの欄・reviewBuild・取り込みのその日のメモに数字の直書きが残っていない
const memoAreas = SRC.match(/maxlength: [^,]+, 'aria-label': '社内メモ'/g) || [];
ok('L1 社内メモの欄（2つ）は maxlength に NOTE_MAX を使う', memoAreas.length === 2 && memoAreas.every((x) => x.includes('String(NOTE_MAX)')), JSON.stringify(memoAreas));
ok('L1 reviewBuild の memoMax は NOTE_MAX', /memoMax: NOTE_MAX \}/.test(SRC) && !/memoMax: \d/.test(SRC));
ok('L1 取り込みのその日のメモは NOTE_MAX で判定', /if \(note\.length > NOTE_MAX\)/.test(SRC) && !/note\.length > 2000/.test(SRC));

// ---- L2 最大の社内メモが本文16KB に入る（入口から通す） ----
const { call, crid, q1 } = setup();
const past = jstDay(Date.now() - 3 * 86400000);
//   本物の LINE の ID トークンは約1,300字。身代わりのトークンに加えて pad に2,048字を足し、本物より大きい要求で通す（Worker は知らない鍵を見ない）
const TOKEN_REAL = 2048;
async function worst(action, body) {
  const probe = JSON.stringify({ action, idToken: 'x'.repeat(TOKEN_REAL), ...body });
  return { r: await call('U_t1', action, { ...body, pad: 'x'.repeat(TOKEN_REAL) }), bytes: Buffer.byteLength(probe) };
}
{
  const body = 'あ'.repeat(KARTE_LIMITS.NOTE_CHARS);
  const { r, bytes } = await worst('k_addNote', { customerId: 'C1', sessionDate: past, tag: 'training', condition: 'good', body, nextPlan: 'い'.repeat(KARTE_LIMITS.TEXT_CHARS), clientReqId: crid() });
  ok('L2 ★4,000字の社内メモ＋次回やること500字（日本語1字3バイト）が入る', r.status === 200 && !!r.noteId, JSON.stringify(r));
  ok('L2 そのとき要求は（トークン2KB として）16KB 以下', bytes <= KARTE_LIMITS.BODY_BYTES, String(bytes));
  const row = r.noteId ? q1('SELECT body FROM karte_notes WHERE note_id = ?', r.noteId) : null;
  ok('L2 本文は切らずにそのまま残る', row && row.body === body);
  const over = await call('U_t1', 'k_addNote', { customerId: 'C1', sessionDate: past, body: 'あ'.repeat(KARTE_LIMITS.NOTE_CHARS + 1), clientReqId: crid() });
  ok('L2 4,001字は 400（413 ではなく字数で断る＝画面の判定と同じ所で止まる）', over.status === 400 && over.code === 'BAD_REQUEST', JSON.stringify(over));
  //   いまの記録の画面の送り方（body だけ）
  const tr = await call('U_t1', 'k_addNote', { customerId: 'C1', sessionDate: past, tag: 'training', condition: '', body, nextPlan: '', clientReqId: crid() });
  ok('L2 記録の画面の送り方（body だけ）でも入る', tr.status === 200);
}

console.log(`${fail ? '❌' : '✅'} 社内メモの上限（設計63） 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
