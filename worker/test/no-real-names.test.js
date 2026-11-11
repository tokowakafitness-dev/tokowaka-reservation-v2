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
//     実名そのものはこのファイルに書かない。見つかったものは「ファイル:行・ハッシュ・文字の種類」だけを出す。
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
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');

let pass = 0, fail = 0;
function ok(name, cond, extra) { cond ? pass++ : (fail++, console.log(`❌ ${name}${extra ? '\n   ' + extra : ''}`)); }
const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 8);
const gloss = (s) => [...s].map((c) => (/[一-龥々〆]/.test(c) ? 'K' : /[ァ-ヴー]/.test(c) ? 'k' : /[ 　・]/.test(c) ? '_' : '?')).join('');

// ---- 許可リスト（ダミー・架空の名前・トレーナーの姓・一般語）----
const ALLOW = new Set((
  '〇〇 ○○ ●● 様 体験 顧客 会員 名前 顧客名 本文 見本 ' +
  // 昔からのダミー
  '山田 山田太郎 山田花子 田中 田中太郎 田中花子 佐藤 佐藤花子 太郎 花子 一郎 二郎 健 ' +
  // テストで使う架空の名前（2026-11-11 に実名から置き換えたもの）
  '甲野 乙川 丙田 丁原 戊井 己島 甲野一郎 乙川二郎 戊井三郎 丁原四郎 丙田五郎 甲野花子 コウノ ハナコ コウノハナコ ' +
  '会員二 会員見本 新規花子 未来太郎 残骸花子 消化漏子 ' +
  // トレーナーの姓（LP で公開している業務上の名前。フルネームは書かない）
  '中野 鈴木 沖'
).split(/\s+/).filter(Boolean));
// 「仕様」「模様」「お客様」「同様」… の「様」は名前ではない（直前の1文字で判定）
const GEN_TAIL = new Set([...'仕模客同多異王神皆奥貴外両各左有今斯如']);

const RUN = '[一-龥々〆ァ-ヴー]';
const NAME_RE = new RegExp(`(?:(${RUN}+)([ 　・]))?(${RUN}+)[ 　]?様(?![式子相態])`, 'g');

function flaggedNames(line) {
  const out = [];
  for (const m of line.matchAll(NAME_RE)) {
    const r0 = m[1], r1 = m[3];
    const full = r0 ? r0 + m[2] + r1 : r1;
    if (ALLOW.has(r1) && (!r0 || ALLOW.has(r0))) continue;
    if (GEN_TAIL.has(r1[r1.length - 1])) continue;
    out.push(full);
  }
  return out;
}

// ---- 電話番号：店の公開番号（ハッシュで持つ）とダミーだけ許す ----
const PHONE_ALLOW_HASH = new Set(['f9d1a4ba']);   // 店の公開番号（LP に掲載）
const PHONE_RE = /(?<![\d.])0[5789]0-?\d{4}-?\d{4}(?!\d)/g;
function isDummyPhone(p) {
  const d = p.replace(/\D/g, '');
  return new Set(d.slice(3)).size <= 2 || /(0000|1111|2222|3333|4444|5555|6666|7777|8888|9999|1234|5678|9876)/.test(d);
}
function flaggedPhones(line) {
  const out = [];
  for (const m of line.matchAll(PHONE_RE)) {
    if (isDummyPhone(m[0])) continue;
    if (PHONE_ALLOW_HASH.has(hash(m[0]))) continue;
    out.push(m[0]);
  }
  return out;
}

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

const hitsName = [], hitsPhone = [];
for (const f of files) {
  let text;
  try { text = readFileSync(join(ROOT, f), 'utf8'); } catch { continue; }
  if (text.includes('\u0000')) continue;   // バイナリ
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const n of flaggedNames(lines[i])) hitsName.push(`${f}:${i + 1} 名前 ${hash(n)} (${gloss(n)})`);
    for (const p of flaggedPhones(lines[i])) hitsPhone.push(`${f}:${i + 1} 電話 ${hash(p)}`);
  }
}
ok('1-1 ★許可リストに無い「〇〇様」が無い（実名を書かない）', hitsName.length === 0, hitsName.slice(0, 30).join('\n   '));
ok('1-2 ★ダミーでも店の公開番号でもない携帯・IP電話の番号が無い', hitsPhone.length === 0, hitsPhone.slice(0, 30).join('\n   '));

console.log(`\n${fail ? '❌' : '✅'} 公開リポジトリに実名・電話を書かない 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
