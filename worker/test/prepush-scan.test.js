// push 前の個人情報・鍵の検査（ops/prepush-scan.mjs と worker/test/pre-push の配線）（2026-11-11・決定0167）
//
//   ★入口から通す：使い捨ての git リポジトリを作り、本物の pre-push フックに git と同じ形の標準入力を渡して、
//     終了コードと出力を確かめる。部品（scanLine）を直接呼ぶ検査は no-real-names.test.js の 0-x が持つ。
//   ★実在の値は書かない。検出させる値は実行時に組み立てる（このファイル自身が作業ツリーの検査に掛からないように）。
//
//   実行: node worker/test/prepush-scan.test.js

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');

let pass = 0, fail = 0;
function ok(name, cond, extra) { cond ? pass++ : (fail++, console.log(`❌ ${name}${extra ? '\n   ' + extra : ''}`)); }

const C = (...a) => String.fromCharCode(...a);
const FAKE = {
  name: C(0x5317, 0x6761) + '様',                                       // 許可リストに無い架空の姓＋様
  phone: '090-' + '3141' + '-5926',
  mail: 'zq' + 'x7.k' + C(0x40) + 'gmail.com',
  line: 'U' + '3f9a1c7e5b2d4f6a' + '8c0e1b3d5f7a9c2e',
  key: 'gh' + 'p_' + 'A1b2'.repeat(9),
};

const base = mkdtempSync(join(tmpdir(), 'prepush-scan-'));
const remote = join(base, 'remote.git');
const repo = join(base, 'work');
const G = (args, cwd = repo) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

try {
  execFileSync('git', ['init', '-q', '--bare', remote]);
  mkdirSync(join(repo, 'ops'), { recursive: true });
  mkdirSync(join(repo, 'worker/test'), { recursive: true });
  G(['init', '-q', '-b', 'main'], repo);
  copyFileSync(join(ROOT, 'ops/prepush-scan.mjs'), join(repo, 'ops/prepush-scan.mjs'));
  copyFileSync(join(ROOT, 'worker/test/pii-detect.mjs'), join(repo, 'worker/test/pii-detect.mjs'));
  copyFileSync(join(ROOT, 'worker/test/pre-push'), join(repo, 'worker/test/pre-push'));
  // テスト一式の身代わり（配線だけを見る。本物の run-all は使い捨てリポジトリでは走らない）
  writeFileSync(join(repo, 'worker/test/run-all.sh'), '#!/usr/bin/env bash\necho RUNALL_RAN\nexit 0\n');
  chmodSync(join(repo, 'worker/test/pre-push'), 0o755);
  writeFileSync(join(repo, 'README.md'), 'clean\n');
  G(['add', '-A']); G(['commit', '-q', '-m', 'init']);
  G(['remote', 'add', 'origin', remote]);
  G(['push', '-q', '--no-verify', 'origin', 'main']);

  // 本物の pre-push フックを、git と同じ形の標準入力で呼ぶ
  const hook = (stdin) => spawnSync('bash', [join(repo, 'worker/test/pre-push')], { cwd: repo, input: stdin, encoding: 'utf8' });
  const pushLine = (local = 'HEAD') => {
    const l = G(['rev-parse', local]);
    const r = G(['rev-parse', 'origin/main']);
    return `refs/heads/main ${l} refs/heads/main ${r}\n`;
  };
  const commit = (file, text, msg = 'change') => { writeFileSync(join(repo, file), text); G(['add', '-A']); G(['commit', '-q', '-m', msg]); };
  const resetToRemote = () => G(['reset', '-q', '--hard', 'origin/main']);
  const h8 = (v) => createHash('sha256').update(v).digest('hex').slice(0, 8);
  // 値そのものも、短いハッシュも出さない（短いハッシュは総当たりで戻せる・決定0167）
  const noRaw = (out) => !Object.values(FAKE).some((v) => out.includes(v) || out.includes(h8(v)) || out.includes(h8(v.toLowerCase())));

  // 1. 綺麗なコミットは通り、テストまで進む
  commit('a.txt', '普通の変更\n');
  let r = hook(pushLine());
  ok('1-1 綺麗なコミットは通る（終了コード0）', r.status === 0, r.stdout + r.stderr);
  ok('1-2 検査のあとにテスト（run-all）まで進む＝配線がつながっている', r.stdout.includes('RUNALL_RAN'), r.stdout);
  resetToRemote();

  // 2. 種類ごとに止まる・値を出さない
  for (const [kind, v] of Object.entries(FAKE)) {
    commit('b.txt', `記録：${v} の件\n`);
    r = hook(pushLine());
    const out = r.stdout + r.stderr;
    ok(`2-${kind} 足した行の ${kind} で止まる`, r.status === 1, out);
    ok(`2-${kind} 止めたときテストへ進まない`, !out.includes('RUNALL_RAN'));
    ok(`2-${kind} 出力に値そのものを出さない`, noRaw(out), out);
    resetToRemote();
  }

  // 3. 足してから消した（作業ツリーは綺麗）でも、履歴に残るので止まる
  commit('c.txt', `${FAKE.name}\n`); commit('c.txt', '消した\n');
  r = hook(pushLine());
  ok('3-1 足して消したコミットの組でも止まる（履歴を見ている）', r.status === 1, r.stdout + r.stderr);
  resetToRemote();

  // 4. コミットの説明文も見る
  commit('d.txt', '普通\n', `fix: ${FAKE.name}の予約`);
  r = hook(pushLine());
  ok('4-1 コミットの説明文の名前で止まる', r.status === 1 && /コミットの説明/.test(r.stderr), r.stdout + r.stderr);
  resetToRemote();

  // 5. 新しいブランチ（リモート側が 0000…）：どのリモートにも無いコミットだけを見る
  G(['checkout', '-q', '-b', 'claude/x']);
  commit('e.txt', `${FAKE.phone}\n`);
  const zero = '0'.repeat(40);
  r = hook(`refs/heads/claude/x ${G(['rev-parse', 'HEAD'])} refs/heads/claude/x ${zero}\n`);
  ok('5-1 新しいブランチの push でも止まる', r.status === 1, r.stdout + r.stderr);
  G(['checkout', '-q', 'main']); G(['branch', '-q', '-D', 'claude/x']);
  commit('f.txt', '普通\n');
  G(['checkout', '-q', '-b', 'claude/y']);
  r = hook(`refs/heads/claude/y ${G(['rev-parse', 'HEAD'])} refs/heads/claude/y ${zero}\n`);
  ok('5-2 新しいブランチでも、リモートに既にある古いコミットは見ず、綺麗なら通る', r.status === 0, r.stdout + r.stderr);
  G(['checkout', '-q', 'main']); G(['branch', '-q', '-D', 'claude/y']); resetToRemote();

  // 5-3. ブランチ名も外に出るので見る
  r = hook(`refs/heads/main ${G(['rev-parse', 'HEAD'])} refs/heads/fix-${FAKE.mail} ${zero}\n`);
  ok('5-3 ブランチ名に入った個人情報で止まる', r.status === 1 && /ブランチ名/.test(r.stderr), r.stdout + r.stderr);

  // 5-4. 全角で書いた電話番号も拾う
  commit('h.txt', [...FAKE.phone].map((ch) => /\d/.test(ch) ? String.fromCharCode(ch.charCodeAt(0) + 0xFEE0) : ch).join('') + '\n');
  r = hook(pushLine());
  ok('5-4 全角数字の電話番号でも止まる（NFKC で揃える）', r.status === 1, r.stdout + r.stderr);
  resetToRemote();

  // 6. 削除の push は中身が出ないので通る
  r = hook(`(delete) ${zero} refs/heads/old ${G(['rev-parse', 'origin/main'])}\n`);
  ok('6-1 ブランチの削除の push は通る', r.status === 0, r.stdout + r.stderr);

  // 7. 判定できないとき（存在しないコミット）は止める
  r = hook(`refs/heads/main ${'1'.repeat(40)} refs/heads/main ${G(['rev-parse', 'origin/main'])}\n`);
  ok('7-1 git が読めないときは止める（出さない側に倒す）', r.status === 1, r.stdout + r.stderr);

  // 8. 業務用として許可したもの・ダミーは止めない
  commit('g.txt', 'テスト 090-0000-0000 U' + '0'.repeat(32) + ' 甲野一郎様 x' + C(0x40) + 'group.calendar.google.com\n');
  r = hook(pushLine());
  ok('8-1 ダミー・架空の名前・カレンダーのドメインは止めない', r.status === 0, r.stdout + r.stderr);
  resetToRemote();
} finally {
  rmSync(base, { recursive: true, force: true });
}

// 9. クラウドで配線がつながる・PR の検査が base の版で走る（文字ではなく形の確認）
{
  const setup = readFileSync(join(ROOT, 'ops/cloud-setup.sh'), 'utf8');
  ok('9-1 cloud-setup.sh が pre-push をつなぐ', /ln -sf \.\.\/\.\.\/worker\/test\/pre-push/.test(setup));
  const wf = readFileSync(join(ROOT, 'ops/workflows/pii-scan.yml'), 'utf8');
  ok('9-2 PR の検査は検出器を base から取り出して走らせる（PR 側で書き換えても素通りしない）',
    /git show "\$BASE:worker\/test\/pii-detect\.mjs"/.test(wf) && /git show "\$BASE:ops\/prepush-scan\.mjs"/.test(wf));
  ok('9-3 PR の検査は Secrets を使わず読むだけ（pull_request_target を使わない）',
    /permissions:\s*\n\s*contents: read/.test(wf) && !/^\s*pull_request_target\s*:/m.test(wf) && !/secrets\./.test(wf));
}

console.log(`\n${fail ? '❌' : '✅'} push 前の個人情報・鍵の検査 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
