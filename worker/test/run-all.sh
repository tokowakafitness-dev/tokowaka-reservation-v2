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
#   RUN_ALL_JOBS=1 bash worker/test/run-all.sh … 1本ずつ（直列）に戻す
#
# ★同時に走らせる（2026-11-28 オーナー決定：push 前の待ちを短くする）
#   既定は CPU の数だけ同時に走らせる（RUN_ALL_JOBS で変えられる）。
#   ぶつからないように、テストごとに TMPDIR を別のフォルダにして渡す
#   （一時の DB・一時の repo は全部 TMPDIR の下に作る作り。2026-11-28 に grep で確かめた）。
#   ★リポジトリの中のファイルを書き換えるテストを足すなら、同時に走らせてはいけない。
#     SERIAL に名前を足すと、他が終わった後に1本ずつ走る。
#   出力は走らせた順でなくファイル名の順に並べる（毎回同じ表示になる）。
#
# 実行する場所はどこでもよい（中でリポジトリの根に移る）。
# テストはリポジトリの根からの相対パス（ops/MODEL.md 等）を読むため。

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1

FILTER="${1:-}"

JOBS="${RUN_ALL_JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)}"
case "$JOBS" in ''|*[!0-9]*|0) JOBS=4 ;; esac

# 同時に走らせてはいけないもの（リポジトリの中を書き換える等）。いまは無い。
SERIAL=()

WORK="$(mktemp -d "${TMPDIR:-/tmp}/run-all.XXXXXX")" || exit 1
trap 'rm -rf "$WORK"' EXIT

files=()
runners=()
add() {
  local f="$1" runner="$2"
  if [ -n "$FILTER" ] && [[ "$f" != *"$FILTER"* ]]; then return 0; fi
  files+=("$f"); runners+=("$runner")
}
for f in worker/test/*.test.js; do [ -e "$f" ] && add "$f" node; done
for f in worker/test/*.test.sh; do [ -e "$f" ] && add "$f" bash; done

is_serial() {
  local s
  for s in ${SERIAL[@]+"${SERIAL[@]}"}; do [ "$1" = "$s" ] && return 0; done
  return 1
}

# 1本を走らせ、出力を <番号>.out、結果を <番号>.rc に書く。TMPDIR はテストごとに別。
RUN_ONE='i=$1; r=$2; f=$3; t="$WORK/$i.tmp"; mkdir -p "$t"
if TMPDIR="$t" "$r" "$f" >"$WORK/$i.out" 2>&1; then echo 0 >"$WORK/$i.rc"; else echo 1 >"$WORK/$i.rc"; fi
rm -rf "$t"'
export WORK

par=()
ser=()
for i in "${!files[@]}"; do
  if is_serial "${files[$i]}"; then ser+=("$i ${runners[$i]} ${files[$i]}"); else par+=("$i ${runners[$i]} ${files[$i]}"); fi
done

echo "▶ テスト ${#files[@]} 本を、同時に $JOBS 本ずつ走らせます（RUN_ALL_JOBS=1 で1本ずつ）"
if [ "${#par[@]}" -gt 0 ]; then
  printf '%s\n' "${par[@]}" | xargs -P "$JOBS" -n 3 sh -c "$RUN_ONE" _
fi
if [ "${#ser[@]}" -gt 0 ]; then
  printf '%s\n' "${ser[@]}" | xargs -P 1 -n 3 sh -c "$RUN_ONE" _
fi

pass=0
fail=0
failed=()
for i in "${!files[@]}"; do
  f="${files[$i]}"
  # 結果の印が無い（途中で止まった等）も落ちた側に数える
  if [ "$(cat "$WORK/$i.rc" 2>/dev/null)" = "0" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    failed+=("$f")
    printf '\n----- ❌ %s -----\n%s\n' "$f" "$(tail -20 "$WORK/$i.out" 2>/dev/null)"
  fi
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
