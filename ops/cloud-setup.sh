#!/usr/bin/env bash
# クラウドの作業環境（claude.ai/code）でテストを走らせられる状態にする（2026-11-11）
#
# 使い方
#   ・claude.ai の環境設定「初期化スクリプト（setup script）」に ops/CLOUD-SETUP.md の短い版を貼る
#   ・リポジトリの中からなら:  bash ops/cloud-setup.sh
#   ・Mac で走らせても壊さない（足りないものを足すだけ。既にあれば何もしない）
#
# 何をするか
#   1. Node が 22.13 以上か確かめる（node:sqlite と jsdom 29 の下限）
#   2. sqlite3 と python3 があるか確かめ、無ければ apt で入れる
#   3. jsdom を ~/.cache/claude-node に固定版で入れる（worker/test/deps の lockfile）
#      ★テストは createRequire(~/.cache/claude-node/package.json) で jsdom を探す
#   4. pre-push フックをつなぐ（push の前に全テストが走る）
#
# ★失敗したら終了コード 1。黙って通さない。

set -euo pipefail

say() { printf '▶ %s\n' "$*"; }
die() { printf '❌ %s\n' "$*" >&2; exit 1; }

SUDO=""
if [ "$(id -u)" != "0" ] && command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi

# ---- 1. Node ----------------------------------------------------------------
node_ok() {
  command -v node >/dev/null 2>&1 &&
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'
}
if ! node_ok; then
  if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
    say "Node が古いか無いので nvm で 22 を入れます"
    # shellcheck disable=SC1091
    . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
    nvm install 22 >/dev/null && nvm alias default 22 >/dev/null
  fi
fi
node_ok || die "Node 22.13 以上が要ります（いま: $(node -v 2>/dev/null || echo 無し)）"
say "Node $(node -v)"

# ---- 2. sqlite3 / python3 ---------------------------------------------------
missing=()
command -v sqlite3 >/dev/null 2>&1 || missing+=(sqlite3)
command -v python3 >/dev/null 2>&1 || missing+=(python3)
if [ "${#missing[@]}" -gt 0 ]; then
  command -v apt-get >/dev/null 2>&1 || die "${missing[*]} が無く、apt-get も無い"
  say "${missing[*]} を入れます"
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq "${missing[@]}" >/dev/null
fi
say "sqlite3 $(sqlite3 --version | cut -d' ' -f1) / $(python3 --version)"

# ---- 3. jsdom（固定版）------------------------------------------------------
DEST="$HOME/.cache/claude-node"
REPO="$(git rev-parse --show-toplevel 2>/dev/null || true)"
DEPS=""
if [ -n "$REPO" ] && [ -f "$REPO/worker/test/deps/package-lock.json" ]; then DEPS="$REPO/worker/test/deps"; fi

if node -e "require('$DEST/node_modules/jsdom/package.json')" >/dev/null 2>&1; then
  say "jsdom は入っています（$(node -p "require('$DEST/node_modules/jsdom/package.json').version")）"
else
  mkdir -p "$DEST"
  if [ -n "$DEPS" ]; then
    say "jsdom を lockfile どおりに入れます"
    cp "$DEPS/package.json" "$DEPS/package-lock.json" "$DEST/"
    # ★--prefix 付きの npm ci は lockfile と食い違うと誤判定する（2026-11-11 実測）。中へ移って走らせる
    (cd "$DEST" && npm ci --no-fund --no-audit --loglevel=error)
  else
    # リポジトリがまだ無い時点で走った場合の予備（版は同じ。下位の版は lockfile ほど固くない）
    say "リポジトリが見つからないので jsdom@29.1.1 を直接入れます"
    printf '{"private":true}\n' > "$DEST/package.json"
    (cd "$DEST" && npm install --no-fund --no-audit --loglevel=error jsdom@29.1.1)
  fi
fi
node -e "require('$DEST/node_modules/jsdom')" || die "jsdom を読み込めない"

# ---- 4. pre-push ------------------------------------------------------------
if [ -n "$REPO" ] && [ -d "$REPO/.git/hooks" ]; then
  if [ "$(readlink "$REPO/.git/hooks/pre-push" 2>/dev/null)" = "../../worker/test/pre-push" ]; then
    say "pre-push はつながっています"
  elif ln -sf ../../worker/test/pre-push "$REPO/.git/hooks/pre-push" 2>/dev/null; then
    say "pre-push をつなぎました（push の前に worker/test/run-all.sh が走ります）"
  else
    # Mac の作業環境では .git/hooks が書けない設定がある。テストの準備とは別なので止めない
    say "⚠ pre-push をつなげませんでした（push の前に bash worker/test/run-all.sh を手で走らせる）"
  fi
else
  say "リポジトリが見つからないため pre-push は未接続（作業の最初に bash ops/cloud-setup.sh を走らせる）"
fi

say "準備完了。テストは: bash worker/test/run-all.sh"
