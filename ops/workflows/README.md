# ワークフローの置き場（オーナーが取り付ける）

開発者のトークンには**ワークフローを書き換える権限がありません**（意図的）。
ワークフローを書けるということは、Secretsの中身を取り出せるということだからです。
そのため、ここに置いたものを**オーナーが `.github/workflows/` へ取り付けます**。

## 取り付け方

```
cd /Users/ryunosukennakano/龍之介会社/30_projects/personal-training/tokowaka-reservation-v2
cp ops/workflows/*.yml .github/workflows/
git add .github/workflows && git commit -m "chore(ci): ワークフローを更新" && git push origin main
```

**変更があったときだけで結構です。** 中身は毎回ここに置いておきます。
