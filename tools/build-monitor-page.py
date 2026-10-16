#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""monitor/index.html を index.html から機械で生成する（2026-10-16）

★なぜ要るのか
  モニター専用の予約ページは URL を分けるが、中身をコピーしてはいけない。
  予約の処理（空き枠CSVの取得・90分枠の判定・予約送信・「すでに予約が入りました」の
  復帰・GA4 の reservation_complete）が2つに増えると、片方だけ直して食い違う。
  実際に 2026-10-16、この画面で「空き枠CSVのHTTP状態を見ていない」不具合を直した。
  コピーが2つあったら片方だけ直して終わっていた。

  だから monitor/index.html は **生成物** とし、index.html を唯一の真実とする。
  変えるのは文言と <title>/robots/utm_medium の既定値だけ。処理は1行も触らない。

★守ること
  - 置換はすべて「ちょうど1箇所に当たること」を確かめる。0箇所でも2箇所でも落とす。
    黙って通すと、index.html の文言が変わったときに差し替えが抜けたまま出てしまう。
  - --check は「いまの monitor/index.html が生成結果と一致するか」を見る。
    違えば終了コード1（＝生成し忘れの検出）。worker/test/monitor-page.test.sh から走る。

使い方
  python3 tools/build-monitor-page.py          … 生成して書き出す
  python3 tools/build-monitor-page.py --check  … 生成し忘れを検出する（CI/テスト用）

★まだ差し替えていないもの（オーナー承認待ち・2026-10-16）
  - ヘッダーのバッジ    <div class="badge">無料カウンセリング予約</div>
  - ヒーローの英字見出し <span class="eyebrow">Free Counseling Reservation</span>
  どちらもモニターページでは実態と食い違うが、承認済みの文言が無いため勝手に書かない。
  文言が決まったら下の OPS に1件ずつ足す（assert が1箇所であることを守ってくれる）。
"""

import difflib
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "index.html")
DST = os.path.join(ROOT, "monitor", "index.html")

GENERATED_BANNER = """<!--
  ⚠️ 自動生成ファイル。手で編集しない（直してもすぐ上書きされる）。
     生成元  : index.html
     生成器  : tools/build-monitor-page.py
     作り直し: python3 tools/build-monitor-page.py
     一致確認: python3 tools/build-monitor-page.py --check
-->"""

# (ラベル, 置換前, 置換後) を上から順に適用する。各手順は必ず1箇所だけに当たること。
OPS = [
    # ── ヘッダー右上の金色のバッジ。お客様が最初に見る位置に
    #    「無料カウンセリング予約」と出ていた（2026-10-16 オーナー指示で削除）
    ("ヘッダーのバッジを消す",
     '  <div class="badge">無料カウンセリング予約</div>\n',
     ''),

    # ── 見出しの真上の英字。同じ理由で削除
    ("見出し上の英字を消す",
     '    <span class="eyebrow">Free Counseling Reservation</span>\n',
     ''),

    (
        "生成物である印",
        '<!DOCTYPE html>\n<html lang="ja">',
        '<!DOCTYPE html>\n' + GENERATED_BANNER + '\n<html lang="ja">',
    ),
    (
        "title と noindex",
        "<title>無料カウンセリング予約 | TOKOWAKA 吉祥寺</title>",
        "<title>バルクアップ モニター 体験予約 | TOKOWAKA 吉祥寺</title>\n"
        '<meta name="robots" content="noindex,nofollow">',
    ),
    (
        "ヒーローの見出し",
        "<h1>無料カウンセリング<br><em>ご予約フォーム</em></h1>",
        "<h1>バルクアッププログラム モニター 体験予約</h1>",
    ),
    (
        "ヒーローのリード文",
        "<p>希望の日時を選んでお申し込みください。初回カウンセリングは完全無料・60分です。"
        '<br><span style="font-size:.82em;opacity:.72">※時期のキャンペーンにより条件が異なります。</span></p>',
        "<p>バルクアッププログラム モニターの体験予約です。"
        "<br>当日は適正・条件を確認する為のカウンセリングと、体験トレーニングを行います。"
        "<br>ご都合のよい日時をお選びください。"
        "<br>60分を予定・費用はかかりません。</p>",
    ),
    (
        "Step02 の選択確認の所要時間",
        '<div class="sc-sub">所要時間：60分（無料）</div>',
        '<div class="sc-sub">60分を予定・費用はかかりません</div>',
    ),
    (
        "予約完了カードの所要時間",
        '<span class="dk">所要時間</span><span class="dv">60分（無料）</span>',
        '<span class="dk">所要時間</span><span class="dv">60分を予定・費用はかかりません</span>',
    ),
    (
        # URL に utm_medium が付いていれば今まで通りそれを使う（拾う処理は壊さない）。
        # 付いていない場合（ブックマーク・メールの転送でパラメータが落ちた場合）だけ
        # 'none' ではなく 'monitor' を台帳へ書く。
        "utm_medium の既定値を monitor にする",
        "utm_medium:   p.get('utm_medium')   || 'none',",
        "utm_medium:   p.get('utm_medium')   || 'monitor',",
    ),
]

# monitor/ は index.html より1階層深い。相対パスの参照があると、そこで壊れる。
# 「いま相対参照が無い」ことを機械で確かめておく（将来 index.html に足されたら落ちる）。
RELATIVE_REF = re.compile(
    r'(?:href|src|action)\s*=\s*"(?!https?://|//|#|mailto:|tel:|data:|javascript:)',
    re.IGNORECASE,
)


class BuildError(Exception):
    pass


def build(src_text):
    """index.html の中身から monitor/index.html の中身を作る。"""
    bad = RELATIVE_REF.findall(src_text)
    if bad:
        raise BuildError(
            "index.html に相対パスの参照が %d 件ある。monitor/ は1階層深いので壊れる。"
            "絶対URLに直してから生成すること。" % len(bad)
        )

    out = src_text
    for label, old, new in OPS:
        hits = out.count(old)
        if hits != 1:
            raise BuildError(
                "置換「%s」が %d 箇所に当たった（1箇所でなければならない）。\n"
                "  探した文字列: %r\n"
                "  → index.html の文言が変わった可能性がある。OPS を直すこと。"
                % (label, hits, old)
            )
        out = out.replace(old, new, 1)

    if out == src_text:
        raise BuildError("生成結果が index.html と同一。差し替えが効いていない。")
    return out


def main(argv):
    check_only = "--check" in argv[1:]
    unknown = [a for a in argv[1:] if a != "--check"]
    if unknown:
        sys.stderr.write("不明な引数: %s\n" % " ".join(unknown))
        return 2

    try:
        with open(SRC, "r", encoding="utf-8", newline="") as f:
            src_text = f.read()
    except OSError as e:
        sys.stderr.write("index.html を読めない: %s\n" % e)
        return 1

    try:
        built = build(src_text)
    except BuildError as e:
        sys.stderr.write("❌ 生成に失敗: %s\n" % e)
        return 1

    if not check_only:
        os.makedirs(os.path.dirname(DST), exist_ok=True)
        with open(DST, "w", encoding="utf-8", newline="") as f:
            f.write(built)
        sys.stdout.write("✅ monitor/index.html を生成した（%d 箇所を差し替え）\n" % len(OPS))
        return 0

    # --check: いまのファイルが生成結果と一致するか
    if not os.path.exists(DST):
        sys.stderr.write(
            "❌ monitor/index.html が無い。"
            "`python3 tools/build-monitor-page.py` を実行すること。\n"
        )
        return 1
    with open(DST, "r", encoding="utf-8", newline="") as f:
        current = f.read()
    if current == built:
        sys.stdout.write("✅ monitor/index.html は index.html から生成した結果と一致している\n")
        return 0

    sys.stderr.write(
        "❌ monitor/index.html が生成結果と一致しない（生成し忘れ、または手で編集された）。\n"
        "   `python3 tools/build-monitor-page.py` で作り直すこと。\n"
        "   差分（- いまのファイル / + 生成結果）先頭40行:\n"
    )
    diff = difflib.unified_diff(
        current.splitlines(True),
        built.splitlines(True),
        fromfile="monitor/index.html (いま)",
        tofile="monitor/index.html (生成結果)",
        n=1,
    )
    for i, line in enumerate(diff):
        if i >= 40:
            sys.stderr.write("   ...\n")
            break
        sys.stderr.write("   " + line.rstrip("\n") + "\n")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
