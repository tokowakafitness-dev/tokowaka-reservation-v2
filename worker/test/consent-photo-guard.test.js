// 同意の撤回で「写真も消す」約束の見張り（2026-11-19 関門③ Codex 指摘）
//   実行: node worker/test/consent-photo-guard.test.js
//
//   ★なぜ要るのか
//     同意の文面（consent-docs.js）と撤回の確かめ（liff/index.html）は「撤回したら健康情報と写真をその場で消す」と約束している。
//     いまは写真を保存する仕組みが無い（設計32 は未実装・R2 も結んでいない）ので、約束は空のまま守られている。
//     危ないのは、写真の保存を足したときに撤回の削除へ入れ忘れること。そのとき文面は「消した」と言い、写真は残る。
//   ★見るもの
//     写真を入れる表（migration の CREATE TABLE の名前に photo／image／picture）か、R2 の結びつけ（wrangler.toml の r2_buckets）が
//     現れたら、会員の撤回（member-consent.js）とトレーナーの撤回（karte.js）の両方が、その表を DELETE しているかを確かめる。
//     消し方は設計32 のとおり「DELETE」か「削除の印（UPDATE … deleted_at）」のどちらでもよい。
//     R2 の実体は撤回の batch の外（日次の掃除）で消す設計なので、worker/src のどこかに env.<結びつけ>.delete( があることを求める。

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const W = join(HERE, '..');

let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) pass++; else { fail++; console.log(`❌ ${name}${detail ? '\n   ' + detail : ''}`); } }

const MIG = join(W, 'migrations');
const photoTables = new Set();
for (const f of readdirSync(MIG).filter((x) => x.endsWith('.sql'))) {
  const sql = readFileSync(join(MIG, f), 'utf8').replace(/--[^\n]*/g, '');   // 注釈は見ない（語でなく値で見る）
  for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([A-Za-z0-9_]+)/gi)) {
    if (/photo|image|picture/i.test(m[1])) photoTables.add(m[1]);
  }
}

const toml = readFileSync(join(W, 'wrangler.toml'), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const r2 = [];
for (const m of toml.matchAll(/\[\[\s*r2_buckets\s*\]\][^[]*?binding\s*=\s*"([^"]+)"/g)) r2.push(m[1]);

const strip = (s) => s.replace(/\/\/[^\n]*/g, '');
const memberSrc = strip(readFileSync(join(W, 'src/routes/member-consent.js'), 'utf8'));
const karteSrc = strip(readFileSync(join(W, 'src/routes/karte.js'), 'utf8'));

// 0. 前提：いまの撤回は健康情報の中身（karte_safety）を両方の経路で消している
ok('0-1 会員の撤回が karte_safety を消す', /DELETE FROM karte_safety/.test(memberSrc));
ok('0-2 トレーナーの撤回が karte_safety を消す', /DELETE FROM karte_safety/.test(karteSrc));

// 1. 写真の表があれば、両方の撤回が消している
for (const t of photoTables) {
  const re = new RegExp('DELETE\\s+FROM\\s+' + t + '\\b|UPDATE\\s+' + t + '\\s+SET[^;]*deleted_at');
  ok(`1 写真の表 ${t} を会員の撤回が消す（member-consent.js）`, re.test(memberSrc), '撤回の batch に DELETE を足す。文面は「写真も消す」と約束している');
  ok(`1 写真の表 ${t} をトレーナーの撤回が消す（karte.js）`, re.test(karteSrc), '撤回の batch に DELETE を足す');
}

// 2. R2 を結んだら、worker/src のどこかで R2 の写真を消している（日次の掃除・設計32）
function walk(d) { return readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : (p.endsWith('.js') ? [p] : []); }); }
const allSrc = walk(join(W, 'src')).map((f) => strip(readFileSync(f, 'utf8'))).join('\n');
for (const b of r2) {
  const re = new RegExp(`env\\.${b}\\.delete\\(`);
  ok(`2 R2 ${b} の写真を消す処理がある（撤回・3年後の掃除）`, re.test(allSrc), '撤回・削除で R2 の写真も消す（文面の約束・設計32 の日次の掃除）');
}

console.log(`consent-photo-guard: 写真の表 ${photoTables.size} 個・R2 ${r2.length} 個を見た`);
console.log(`${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
