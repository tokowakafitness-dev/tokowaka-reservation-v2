# ワークフローの置き場（オーナーが取り付ける）

開発者のトークンには**ワークフローを書き換える権限がありません**（意図的）。
ワークフローを書けるということは、Secretsの中身を取り出せるということだからです。
そのため、ここに置いたものを**オーナーが `.github/workflows/` へ取り付けます**。

**`draft/` の中身は未完成です。取り付けないでください。**

## 取り付け方

```
cd /Users/ryunosukennakano/龍之介会社/30_projects/personal-training/tokowaka-reservation-v2
# ★ワイルドカードを使わず、名前を指定してコピーする（既存を黙って上書きしないため）
cp ops/workflows/<ファイル名>.yml .github/workflows/
git diff -- .github/workflows/
git add .github/workflows && git commit -m "chore(ci): ワークフローを更新"
bash ~/龍之介会社/90_ops/tools/ship-reservation.sh "ワークフローを更新"
```

★2026-11-23 から main への直接の push はルールセットで拒否される（決定0202）。作業ブランチで取り付けて ship-reservation.sh で PR を通す。

**変更があったときだけで結構です。** 中身は毎回ここに置いておきます。
