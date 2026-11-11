# クラウドの作業環境の準備（claude.ai/code）

> 2026-11-11・CTO。CEO が claude.ai の環境設定画面を埋めるときの資料。
> 作業ルールは根の `CLAUDE.md`。ここは「環境を用意する」ことだけを書く。

## 1. 何が要るか（2026-11-11 に調べた事実）

| 要るもの | 理由 | 確かめ方 |
|---|---|---|
| **Node 22.13 以上** | テストが `node:sqlite` を使う（16本）。jsdom 29 の下限も 22.13 | Mac は v26.0.0 で通過。CI（`worker-deploy.yml`）は Node 22 |
| **jsdom 29.1.1** | LIFF 画面のテスト9本が `~/.cache/claude-node` から読む（`createRequire`）。リポジトリの外にある | 無い状態で `liff-staff.test.js` を走らせ、終了コード1を確認 |
| **sqlite3（コマンド）** | スキーマ・移行・同期の版のテスト6本（`allocations-schema.test.sh`・`sync-version.test.js` 等）が CLI を呼ぶ | 無いと落ちる（`page-hits-sql` だけは飛ばす作り） |
| **python3** | `monitor-page.test.sh` が `tools/build-monitor-page.py --check` を呼ぶ | 標準ライブラリだけ |
| `npm ci` が要るディレクトリ | **無し**。`worker/package.json` に依存は無い（wrangler は CI が入れる）。jsdom だけを `worker/test/deps/` の lockfile で入れる | |
| 通信 | **テスト自体は通信しない**（外部 API は全部身代わり） | Mac のサンドボックス内で通信の遮断無しに113本通過 |

テストの一括実行は `bash worker/test/run-all.sh`（どこから呼んでもよい・落ちたら終了コード1・約50秒）。

## 2. 初期化スクリプト（claude.ai の環境設定「setup script」に貼る）

本体は `ops/cloud-setup.sh`（リポジトリに入っている）。設定画面には次を貼る。
リポジトリがまだ取り込まれていない時点で走っても、jsdom は同じ版で入る作りにしてある。

```bash
#!/bin/bash
set -euo pipefail
# TOKOWAKA 予約システム：テストに要るもの（Node>=22.13・sqlite3・python3・jsdom 29.1.1）
for d in "$PWD" /home/user/tokowaka-reservation-v2 "$HOME/tokowaka-reservation-v2"; do
  if [ -f "$d/ops/cloud-setup.sh" ]; then exec bash "$d/ops/cloud-setup.sh"; fi
done
# リポジトリがまだ無い時点：同じ準備をその場で行う（版は ops/cloud-setup.sh と同じ）
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' \
  || { echo "Node 22.13 以上が要ります（いま: $(node -v 2>/dev/null || echo 無し)）" >&2; exit 1; }
S=""; [ "$(id -u)" = "0" ] || S="sudo"
command -v sqlite3 >/dev/null && command -v python3 >/dev/null \
  || { $S apt-get update -qq && $S apt-get install -y -qq sqlite3 python3; }
mkdir -p "$HOME/.cache/claude-node" && cd "$HOME/.cache/claude-node"
[ -f package.json ] || printf '{"private":true}\n' > package.json
node -e "require('./node_modules/jsdom')" 2>/dev/null || npm install --no-fund --no-audit --loglevel=error jsdom@29.1.1
echo "準備完了。リポジトリの中で bash ops/cloud-setup.sh を走らせると pre-push もつながります"
```

- `CLAUDE.md` §0-3 で「作業の最初に `bash ops/cloud-setup.sh`」と書いてあるので、上が途中で何かを取りこぼしても作業の最初に補われる
- **未確認**：setup script が走る時点でリポジトリが取り込まれているか・作業ディレクトリの場所（上のスクリプトは両方に耐える）／既定のイメージに Node 22.13 以上と sqlite3 が入っているか。最初のセッションの出力の `▶ Node` `▶ sqlite3` の行で確かめる

## 3. 通信の許可（最小のリスト）

「信頼できる既定」ではなく**独自の許可リスト**にする場合の最小。

| ドメイン | 何のため | 要らなくなる条件 |
|---|---|---|
| `registry.npmjs.org` | jsdom と依存39個（lockfile の `resolved` は全部ここ） | 環境に jsdom を焼き込めるなら不要 |
| `archive.ubuntu.com`・`security.ubuntu.com` | sqlite3 / python3 が既定のイメージに無いときの apt | 既定のイメージに入っていれば不要（最初のセッションで確かめる） |
| `nodejs.org` | Node が 22.13 未満で nvm を使うとき | 既定の Node が 22.13 以上なら不要 |

- GitHub（clone・push・PR）は Anthropic 側のプロキシが扱う。許可リストに足す必要があるかは**未確認**（足すなら `github.com` だけ。`api.github.com` は PR 操作がプロキシ経由なら不要）
- **足さないもの**：`*.workers.dev`・独自ドメイン（本番の Worker）・`script.google.com`・`api.line.me`。テストは通信しないので、本番に触れる経路を最初から閉じておく
- Cloudflare・Google・LINE の鍵はクラウドに置かない（反映は main へのマージ後の GitHub Actions と、オーナーの GAS 反映だけ）

## 4. リポジトリの `.claude/`（2026-11-11 確認）

- 根の `.claude/` と `worker/.claude/` には、空の `.cc-writes/` しか無い。**git にも入っていない**（クラウドには届かない）
- フック・`settings.json` は**無い**。だからクラウド（Linux・Mac のパス無し）で壊れるものは無い
- 裏返すと、**Mac の会社の作業環境にある守り（危ないコマンドの遮断・機密の読み取り封鎖・出力のマスク）はクラウドには無い**。
  クラウドでの守りは「鍵を置かない」「main に直接入れない（オーナーのマージ）」「ワークフローを変えない」の3つで持つ。
  フックを足すかどうかはセキュリティの判断なので CEO が決める（CTO は足さない）

## 5. Mac 固有のものの洗い出し（2026-11-11）

- テストとツールに `/Users/`・BSD の `sed -i ''`・`date -j`・`stat -f` 等は**無い**
- 時刻：`TZ=UTC LANG=C LC_ALL=C` で全部通過（クラウドの既定に近い条件）
- 偽の HOME（jsdom 無し）から `ops/cloud-setup.sh` で入れ直し、113本全部通過
- 依存の置き場所 `~/.cache/claude-node` はリポジトリの外。これが唯一の「Mac にしか無い」ものだった → `worker/test/deps/` に lockfile を置いて再現できるようにした
- `.git/hooks/pre-push` は git に入らない → `ops/cloud-setup.sh` がつなぐ
- `worker/.wrangler/cache/wrangler-account.json` が git に入っている（Cloudflare のアカウントIDと事業用のアカウント名）。テストには使われない。公開リポジトリなので消すかは CEO が判断（値は秘密ではないが要らないもの）
