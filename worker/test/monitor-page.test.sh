#!/usr/bin/env bash
# monitor/index.html が index.html から生成した結果と一致するかを見る（2026-10-16）
#
# ★なぜ worker/test に置くのか
#   このリポジトリで実際に一括で走るのは worker/test/run-all.sh だけだからである。
#   置き場所としては不自然だが、走らない検査は飾りになる（2026-10-10 に同じ失敗をした）。
#   run-all.sh は worker/test/*.test.sh を拾うので、ここに置けば自動で走る。
#
# ★何を防ぐのか
#   index.html を直したのに monitor/index.html を作り直し忘れること。
#   モニターページは生成物であり、手で書き写してはいけない。
#
# 単体で走らせる: bash worker/test/monitor-page.test.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1

if ! command -v python3 >/dev/null 2>&1; then
  echo "❌ python3 が無いため monitor/index.html の一致を確かめられない" >&2
  exit 1
fi

python3 tools/build-monitor-page.py --check || exit 1
