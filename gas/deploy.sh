#!/bin/bash
# 予約システムのGAS本体（このディレクトリ）を push＋既存Webアプリデプロイを新バージョンに更新（/exec URL不変）まで一括。
# 使い方: bash deploy.sh
set -e
CLASP=~/.cache/clasp-bin/node_modules/.bin/clasp
DEPLOY_ID="AKfycbxqrBd-M6rYTk-9LvKn6dcs7Sjma0CbDcYwSjt4iDuMZ00IdFTOZ0BEWIroD4erVm_WjQ"  # /exec URLのID（変わったら clasp deployments で確認して差し替え）
cd "$(dirname "$0")"

echo "① clasp push（HEAD更新）..."
$CLASP push

echo "② デプロイ版を更新（/exec に反映・URL不変）..."
# clasp 3.x：deploy -i は廃止 → update-deployment <deploymentId>（位置引数）
$CLASP update-deployment "$DEPLOY_ID" -d "auto"

echo "✅ 完了：push＋/exec更新済み。フロントに反映されます。"

# ─────────────────────────────────────────────
# バージョン残数の警告（2026-09-24 追加）
#   Apps Script は1プロジェクト200バージョンが上限。デプロイのたびに1本増える。
#   上限に達すると update-deployment が失敗し、本番に反映できなくなる（2026-09-24 に実際に発生）。
#   claspからバージョンは削除できない（GASエディタの「プロジェクト履歴」→ゴミ箱からのみ）ため、
#   余裕のあるうちに気づけるよう毎回残数を出す。
#   ここから先はデプロイ完了後の情報表示なので、失敗しても deploy 自体には影響させない。
# ─────────────────────────────────────────────
set +e
VOUT=$($CLASP versions 2>/dev/null)
TOTAL=$(printf '%s\n' "$VOUT" | sed -n 's/.*~[[:space:]]*\([0-9][0-9]*\)[[:space:]]*[Vv]ersions.*/\1/p' | head -1)
if [ -z "$TOTAL" ]; then
  TOTAL=$(printf '%s\n' "$VOUT" | grep -cE '^[[:space:]]*[0-9]+')   # ヘッダーが無い版：行数で代用
fi
case "$TOTAL" in
  ''|*[!0-9]*) ;;   # 数えられなかった＝黙る（clasp の出力形式が変わった場合）
  *)
    LEFT=$((200 - TOTAL))
    if [ "$LEFT" -le 20 ]; then
      echo ""
      echo "⚠️  バージョン ${TOTAL}/200（残り ${LEFT} 本）"
      echo "    上限に達するとデプロイできなくなります。いまのうちに古いバージョンを削除してください。"
      echo "    GASエディタ → 左の「プロジェクト履歴」（時計アイコン）→ 右下のゴミ箱 → 見出しのチェックで全選択 → 削除"
      echo "    https://script.google.com/home/projects/1iQyWD9ysH2zrdc6wn5j9wHUV_busRmZWOHFhigNNI9bIFuoGL9Cu3kab/edit"
    else
      echo "（バージョン ${TOTAL}/200・残り ${LEFT} 本）"
    fi
    ;;
esac
