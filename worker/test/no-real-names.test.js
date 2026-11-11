// 公開リポジトリに実在の顧客の氏名・電話番号を書かない（2026-11-11・決定0164）
//
//   ★なぜ要るのか
//     このリポジトリは公開されている。不具合の調査の記録として、実データの「〇〇様」を
//     コメント・設計書・テストにそのまま書いていた（予約の日時・契約の状況と結びついた形で）。
//     決定0089「公開リポジトリの値は秘密ではない」を学んだ後も、**書く側の検査が無かった**から続いた。
//
//   ★何を見るか
//     作業ツリーの追跡ファイル全部について、
//       ① 「漢字・カナの並び＋様」の名前が、下の許可リストに無いこと
//       ② 携帯・IP電話の形（070/080/090/050-XXXX-XXXX）が、許可した番号（店の公開番号）か、明らかなダミーであること
//     実名そのものはこのファイルに書かない。見つかったものは「ファイル:行・種類・文字の種類」だけを出す（ハッシュも出さない＝短いハッシュは総当たりで戻せる・決定0167）。
//
//   ★ここで落ちたときの直し方
//     実在の人なら「会員A」「〇〇様」に替える（日付＋時刻＋人で特定できる書き方は時刻を落とす）。
//     テストの入力なら架空の名前（甲野一郎・乙川二郎 など）に替え、期待値も合わせる。
//     本当に架空の名前を新しく使うなら、下の ALLOW に足す（実在の人の名前を足さない）。
//
//   実行: node worker/test/no-real-names.test.js

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gloss, flaggedNames, flaggedPhones, flaggedEmails, flaggedLineIds, flaggedKeys } from './pii-detect.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');

let pass = 0, fail = 0;
function ok(name, cond, extra) { cond ? pass++ : (fail++, console.log(`❌ ${name}${extra ? '\n   ' + extra : ''}`)); }
// 検出器（許可リスト・形）は pii-detect.mjs に1つだけ置く。push 前の検査（ops/prepush-scan.mjs）と共有する。

// ---- 0. 検出器そのものが効くこと（実名は書かず、その場で組み立てる）----
{
  const fake = String.fromCharCode(0x5317, 0x6761) + '様';            // 架空の姓＋様（文字コードで組み立てる）
  const fakeFull = String.fromCharCode(0x5317, 0x6761, 0x0020, 0x6642, 0x5b97) + '様';
  ok('0-1 許可リストに無い「漢字＋様」を拾う', flaggedNames('実例：' + fake + 'の予約').length === 1);
  ok('0-2 空白をはさむフルネームを拾う', flaggedNames('（' + fakeFull + '）').length === 1);
  ok('0-3 カナの名前を拾う', flaggedNames('：' + String.fromCharCode(0x30cb, 0x30b7, 0x30e0, 0x30e9) + '様').length === 1);
  ok('0-4 一般語・ダミー・トレーナーの姓は拾わない',
    flaggedNames('お客様・仕様・模様・同様・〇〇様・山田太郎様・甲野 一郎様・鈴木様・会員A様・体験_沖_山田花子様_line').length === 0,
    JSON.stringify(flaggedNames('お客様・仕様・模様・同様・〇〇様・山田太郎様・甲野 一郎様・鈴木様・会員A様')));
  ok('0-5 ダミーでない携帯番号を拾う', flaggedPhones('📞 090-' + '3141-5926').length === 1);
  ok('0-6 ダミーの番号は拾わない', flaggedPhones('090-1111-2222 / 09012345678 / 080-0000-0000').length === 0);
  const C = (...a) => String.fromCharCode(...a);
  const pmail = 'zq' + 'x7.k' + C(0x40) + 'gmail.com';                      // 架空の個人アドレス（実行時に組み立てる）
  ok('0-7 個人のメールアドレス（フリーメール）を拾う', flaggedEmails('連絡先 ' + pmail).length === 1);
  ok('0-8 会社・サービス・カレンダーのドメインは拾わない',
    flaggedEmails('a' + C(0x40) + 'example.com x' + C(0x40) + 'group.calendar.google.com').length === 0);
  ok('0-9 LINE のユーザーID（ダミーでない）を拾う', flaggedLineIds('U' + '3f9a1c7e5b2d4f6a8c0e1b3d5f7a9c2e').length === 1);
  ok('0-10 LINE のダミー ID は拾わない', flaggedLineIds('U' + '0'.repeat(32) + ' U' + '0123456789abcdef'.repeat(2)).length === 0);
  ok('0-11 鍵の形を拾う（秘密鍵の見出し・GitHub のトークン）',
    flaggedKeys('-----BEGIN ' + 'PRIVATE KEY-----').length === 1 && flaggedKeys('gh' + 'p_' + 'A1b2'.repeat(9)).length === 1);
}

// ---- 1. 追跡ファイル全部を見る ----
function trackedFiles() {
  try {
    return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    const out = [];
    const walk = (d) => {
      for (const n of readdirSync(d)) {
        if (n === '.git' || n === 'node_modules' || n === '.wrangler') continue;
        const p = join(d, n);
        statSync(p).isDirectory() ? walk(p) : out.push(relative(ROOT, p));
      }
    };
    walk(ROOT);
    return out;
  }
}

const files = trackedFiles();
ok('1-0 ファイルを読めている（0件で素通りしない）', files.length > 100, String(files.length));

const hitsName = [], hitsPhone = [], hitsMail = [], hitsLine = [], hitsKey = [];
for (const f of files) {
  let text;
  try { text = readFileSync(join(ROOT, f), 'utf8'); } catch { continue; }
  if (text.includes('\u0000')) continue;   // バイナリ
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const n of flaggedNames(lines[i])) hitsName.push(`${f}:${i + 1} 名前 (${gloss(n)})`);
    for (const p of flaggedPhones(lines[i])) hitsPhone.push(`${f}:${i + 1} 電話`);
    for (const e of flaggedEmails(lines[i])) hitsMail.push(`${f}:${i + 1} メール`);
    for (const u of flaggedLineIds(lines[i])) hitsLine.push(`${f}:${i + 1} LINEのID`);
    for (const k of flaggedKeys(lines[i])) hitsKey.push(`${f}:${i + 1} 鍵の形 ${k.kind}`);
  }
}
ok('1-1 ★許可リストに無い「〇〇様」が無い（実名を書かない）', hitsName.length === 0, hitsName.slice(0, 30).join('\n   '));
ok('1-2 ★ダミーでも店の公開番号でもない携帯・IP電話の番号が無い', hitsPhone.length === 0, hitsPhone.slice(0, 30).join('\n   '));
ok('1-3 ★業務用でない個人のメールアドレスが無い', hitsMail.length === 0, hitsMail.slice(0, 30).join('\n   '));
ok('1-4 ★ダミーでない LINE のユーザーID が無い', hitsLine.length === 0, hitsLine.slice(0, 30).join('\n   '));
ok('1-5 ★鍵・トークンの形が無い', hitsKey.length === 0, hitsKey.slice(0, 30).join('\n   '));

console.log(`\n${fail ? '❌' : '✅'} 公開リポジトリに実名・電話・メール・LINEのID・鍵を書かない 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
