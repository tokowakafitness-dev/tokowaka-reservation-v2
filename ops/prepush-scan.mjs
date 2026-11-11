#!/usr/bin/env node
// push しようとしているコミットに、個人情報・鍵の形が入っていないかを見る（2026-11-11・決定0167）
//
//   ★なぜ作業ツリーの検査（no-real-names.test.js）だけでは足りないのか
//     push で外に出るのは「作業ツリー」ではなく「コミットの履歴」。
//     実名を書いたコミット → 次のコミットで消した、を push すると、作業ツリーは綺麗でも履歴に残る
//     （公開リポジトリなら誰でも読める・決定0164）。コミットの説明文も同じく外に出る。
//     だから push する**コミット1つずつの「足した行」と説明文**を見る。
//
//   ★何を見るか（検出器は worker/test/pii-detect.mjs。作業ツリーの検査と同じ許可リスト）
//     「〇〇様」の名前・携帯/IP電話・個人のメールアドレス・LINE のユーザーID・鍵/トークンの形
//
//   ★見つけたら push を止める（終了コード1）。値もハッシュも出さない（ファイル:行・種類だけ。短いハッシュは総当たりで戻せる）
//   ★判定できないとき（git が失敗した等）も止める（倒れる向き＝出さない側）
//
//   使い方（.git/hooks/pre-push から呼ばれる。標準入力は git の pre-push の形式）
//     <local ref> <local sha> <remote ref> <remote sha>
//   手で全部を確かめる:  node ops/prepush-scan.mjs --range origin/main..HEAD

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const { scanLine } = await import(pathToFileURL(join(ROOT, 'worker/test/pii-detect.mjs')).href);

const ZERO = /^0+$/;
const git = (args) => execFileSync('git', ['-c', 'core.quotePath=false', ...args],
  { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

function die(msg) {
  console.error(`⛔ 個人情報・鍵の検査を実行できませんでした：${msg}`);
  console.error('   判定できないので push を止めます（出さない側に倒す）。');
  process.exit(1);
}

// ---- 1. 見るコミットを決める ----
let commits = [];
const refHits = [];
try {
  const ri = process.argv.indexOf('--range');
  if (ri > 0) {
    commits = git(['rev-list', '--reverse', process.argv[ri + 1]]).split('\n').filter(Boolean);
  } else {
    const input = readFileSync(0, 'utf8');
    for (const line of input.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) continue;
      const [localRef, localSha, remoteRef, remoteSha] = parts;
      if (ZERO.test(localSha)) continue;                         // 削除の push：外に出る中身は無い
      for (const h of scanLine(remoteRef)) refHits.push(`ブランチ名 ${h}`);   // ブランチ名・タグ名も外に出る
      const range = ZERO.test(remoteSha)
        ? [localSha, '--not', '--remotes']                       // 新しいブランチ：どのリモートにも無いコミット
        : [`${remoteSha}..${localSha}`];
      commits.push(...git(['rev-list', '--reverse', ...range]).split('\n').filter(Boolean));
    }
  }
} catch (e) {
  die(`コミットの一覧を取れない（${String(e.message || e).split('\n')[0]}）`);
}
commits = [...new Set(commits)];

// ---- 2. コミットごとに「足した行」と説明文を見る ----
const hits = [...refHits];
for (const c of commits) {
  const short = c.slice(0, 7);
  let msg, diff;
  try {
    msg = git(['log', '-1', '--format=%B', c]);
    // --root：最初のコミットも見る／-m --first-parent：マージは1つ目の親との差
    diff = git(['diff-tree', '-p', '-r', '--root', '-m', '--first-parent', '--no-commit-id',
      '-U0', '--no-color', '--no-ext-diff', '--no-renames', c]);
  } catch (e) {
    die(`${short} を読めない（${String(e.message || e).split('\n')[0]}）`);
  }
  msg.split('\n').forEach((l, i) => { for (const h of scanLine(l)) hits.push(`${short} コミットの説明:${i + 1} ${h}`); });

  let file = '?', ln = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) { file = l.slice(4).replace(/^b\//, ''); continue; }
    if (l.startsWith('--- ')) continue;
    const m = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (m) { ln = Number(m[1]); continue; }
    if (l.startsWith('+')) {
      for (const h of scanLine(l.slice(1))) hits.push(`${short} ${file}:${ln} ${h}`);
      ln++;
    }
  }
}

if (hits.length) {
  console.error(`⛔ push しようとしているコミットに、個人情報・鍵の形が ${hits.length} 件あります（値は表示しません）`);
  for (const h of hits.slice(0, 40)) console.error('   ' + h);
  if (hits.length > 40) console.error(`   … ほか ${hits.length - 40} 件`);
  console.error('');
  console.error('   直し方：実在の人は「会員A」等に、テストは架空の値に替える。');
  console.error('   ★作業ツリーで消すだけでは足りない（履歴に残る）。push 前のコミットを作り直す：');
  console.error('     git reset --soft <push 済みの位置（例：origin/main）> → 直す → コミットし直す');
  console.error('   本当に架空の名前なら worker/test/pii-detect.mjs の許可リストに足す（実在の人を足さない）。');
  process.exit(1);
}
console.log(`✅ 個人情報・鍵の検査：コミット ${commits.length} 件を見て、0件`);
process.exit(0);
