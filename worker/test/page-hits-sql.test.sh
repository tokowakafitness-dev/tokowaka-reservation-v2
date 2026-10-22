#!/bin/bash
# 上限のSQLが意図どおりか、本物のSQLiteにmigrationを流して確かめる
#   bash worker/test/page-hits-sql.test.sh
# ★身代わりではなく本物に流す。制約や ON CONFLICT の挙動は身代わりでは再現されない。
cd "$(dirname "$0")/.." || exit 2
command -v sqlite3 >/dev/null || { echo "  skip  sqlite3 が無いので飛ばします"; exit 0; }
ng=0
ok(){ [ "$1" = "$2" ] && echo "  ok   $3（$2）" || { echo "  ★NG $3  期待=$1 実際=$2"; ng=$((ng+1)); }; }

DB="${TMPDIR:-/tmp}/page-hits-test.$$.db"; rm -f "$DB"
sqlite3 "$DB" < migrations/0021_page_hits.sql

GATE="INSERT INTO page_hits_hour (hour_key,hits) VALUES ('H',1)
      ON CONFLICT(hour_key) DO UPDATE SET hits=hits+1 WHERE page_hits_hour.hits < 3;
      SELECT changes();"
ok 1 "$(sqlite3 "$DB" "$GATE")" "門番：1回目は通る"
ok 1 "$(sqlite3 "$DB" "$GATE")" "門番：2回目も通る"
ok 1 "$(sqlite3 "$DB" "$GATE")" "門番：3回目も通る"
ok 0 "$(sqlite3 "$DB" "$GATE")" "★門番：上限に達したら止まる"
ok 3 "$(sqlite3 "$DB" "SELECT hits FROM page_hits_hour WHERE hour_key='H';")" "合計は上限で止まっている"

# 内訳：行数の上限は「新しい組み合わせ」だけを止め、既存の計測は止めない
D(){ sqlite3 "$DB" "INSERT INTO page_hits (hour_key,page,campaign,content,hits)
      SELECT 'H','$1','monitor_bulkup','$2',1
       WHERE EXISTS(SELECT 1 FROM page_hits WHERE hour_key='H' AND page='$1'
                     AND campaign='monitor_bulkup' AND content='$2')
          OR (SELECT COUNT(*) FROM page_hits WHERE hour_key='H') < 2
      ON CONFLICT(hour_key,page,campaign,content) DO UPDATE SET hits=hits+1;
      SELECT changes();"; }
ok 1 "$(D lp cr1)"      "内訳：1行目は入る"
ok 1 "$(D cta:faq cr1)" "内訳：2行目は入る"
ok 0 "$(D cta:hero cr1)" "内訳：上限を超える新しい組み合わせは作らない"
ok 1 "$(D lp cr1)"      "★内訳：上限後も、既にある組み合わせは数え続ける"
ok 2 "$(sqlite3 "$DB" "SELECT hits FROM page_hits WHERE page='lp';")" "既存行は2まで増えた"
ok 2 "$(sqlite3 "$DB" "SELECT COUNT(*) FROM page_hits;")" "行数は上限のまま"

rm -f "$DB"
echo
[ "$ng" -eq 0 ] && { echo "✅ すべて通過"; exit 0; } || { echo "🔴 $ng 件"; exit 1; }
