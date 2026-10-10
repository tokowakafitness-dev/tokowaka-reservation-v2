#!/usr/bin/env bash
# 全部のテストを1回で走らせる（2026-10-10）
#
# ★なぜ要るのか
#   テストは60本あるが、個別に `node worker/test/<名前>.test.js` で走らせる作りだった。
#   そのため **ドキュメントを直してテストを壊したのに気づけなかった**
#   （2026-10-10、ops/ROADMAP.md に危険の説明を書き足して trigger-safety が落ちた）。
#   「走らせる気になったものだけ走る」仕組みは、走らないのと同じである。
#
# ★守ること
#   落ちたら必ず終了コード 1 を返す。echo だけで素通りさせない
#   （2026-10-08 に同じ失敗をした）。
#
# 使い方
#   bash worker/test/run-all.sh          … 全部
#   bash worker/test/run-all.sh quota    … 名前に quota を含むものだけ
#
# 実行する場所はどこでもよい（中でリポジトリの根に移る）。
# テストはリポジトリの根からの相対パス（ops/MODEL.md 等）を読むため。

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1

FILTER="${1:-}"

pass=0
fail=0
failed=()

run_one() {
  local f="$1" runner="$2"
  if [ -n "$FILTER" ] && [[ "$f" != *"$FILTER"* ]]; then return 0; fi
  local out
  if out="$("$runner" "$f" 2>&1)"; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    failed+=("$f")
    printf '\n----- ❌ %s -----\n%s\n' "$f" "$(printf '%s' "$out" | tail -20)"
  fi
}

for f in worker/test/*.test.js; do
  [ -e "$f" ] || continue
  run_one "$f" node
done

for f in worker/test/*.test.sh; do
  [ -e "$f" ] || continue
  run_one "$f" bash
done

echo
echo "================================"
if [ "$fail" -eq 0 ]; then
  echo "✅ 全部通った（$pass 本）"
  echo "================================"
  exit 0
fi

echo "❌ 落ちた $fail 本 / 通った $pass 本"
for f in "${failed[@]}"; do echo "   $f"; done
echo "================================"
exit 1
