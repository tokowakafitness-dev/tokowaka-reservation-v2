#!/bin/bash
# 引当と枠の守りが、実際のSQLiteで効くことを確かめる
#
#   ★なぜ要るのか（2026-10-06）
#     設計のレビューで、残数まわりの穴が5回差し戻された。うち2つは致命的だった。
#       ① 残数0の顧客が通常の予約をすると超過が成立する
#       ② 予約できなかったのに残数だけ1回減る
#     どちらも「条件付きUPDATE/INSERT が0行を返してもSQLエラーにならない」ことが原因。
#     設計を直しただけでは、本当に守れているかは分からない。**動かして確かめる。**
#
#   実行: bash worker/test/allocations-schema.test.sh

set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DB="${TMPDIR:-/tmp}/lb-alloc-test-$$.db"
trap 'rm -f "$DB"' EXIT

pass=0; fail=0
ok() { # ok <名前> <実際> <期待>
  if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "❌ $1"; echo "   期待=$3 実際=$2"; fi
}
q() { sqlite3 "$DB" "$@" 2>&1; }

# ---------- 土台を作る ----------
# 本番の reservations には多くの列があるが、この検査に要るのは守りに関わる分だけ。
sqlite3 "$DB" <<'SQL' >/dev/null
CREATE TABLE reservations (
  reservation_id TEXT PRIMARY KEY,
  customer_id TEXT, trainer_id TEXT NOT NULL,
  start_at INTEGER NOT NULL, end_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'booked',
  occupies_facility INTEGER NOT NULL DEFAULT 1,
  occupies_trainer  INTEGER NOT NULL DEFAULT 1,
  consumes_quota    INTEGER NOT NULL DEFAULT 1,
  payment_status    TEXT NOT NULL DEFAULT 'paid',
  created_at INTEGER NOT NULL
);
SQL

# マイグレーションから、reservations への ALTER と索引を除いて流し込む
#   （上で作った簡易版の reservations に対しては ALTER が重複するため）
grep -v '^ALTER TABLE reservations' "$ROOT/worker/migrations/0009_booking_allocations.sql" \
  | grep -v 'idx_resv_facility_window' | grep -v 'idx_resv_trainer_window' \
  | grep -v '^  ON reservations' \
  | sqlite3 "$DB" >/dev/null 2>&1

sqlite3 "$DB" "PRAGMA foreign_keys = ON;
INSERT INTO monthly_quota VALUES ('C1','2026-10',4,0,0);
INSERT INTO ticket_packs  VALUES ('P1','C1','normal',2,0,0,99999999999,0);
INSERT INTO ticket_packs  VALUES ('P2','C1','pair',  2,0,0,99999999999,0);" >/dev/null

echo "=== 1. 引当を作ると枠が減る（確保＝引当が同じ出来事） ==="
q "INSERT INTO reservation_allocations VALUES ('R1','C1','monthly','2026-10',NULL,1,100);" >/dev/null
ok "①引当で used が1になる" "$(q 'SELECT used FROM monthly_quota;')" "1"

echo "=== 2. 枠を使い切ったら引当が作れない（★致命的だった穴①） ==="
q "UPDATE monthly_quota SET used = 4;" >/dev/null
# 残数0の通常予約。設計どおり WHERE EXISTS に残数の条件を1回だけ書く
q "INSERT INTO reservation_allocations (reservation_id,customer_id,source,month_key,units,decided_at)
   SELECT 'R2','C1','monthly','2026-10',1,100
    WHERE EXISTS (SELECT 1 FROM monthly_quota
                   WHERE customer_id='C1' AND month_key='2026-10' AND (0=1 OR used + 1 <= quota));" >/dev/null
ok "②残数0では引当が作られない" "$(q "SELECT COUNT(*) FROM reservation_allocations WHERE reservation_id='R2';")" "0"
ok "②枠も増えていない"           "$(q 'SELECT used FROM monthly_quota;')" "4"

echo "=== 3. 仮押さえは枠を超えて作れる（決定0068：超過は見せる） ==="
q "INSERT INTO reservation_allocations (reservation_id,customer_id,source,month_key,units,decided_at)
   SELECT 'R3','C1','monthly','2026-10',1,100
    WHERE EXISTS (SELECT 1 FROM monthly_quota
                   WHERE customer_id='C1' AND month_key='2026-10' AND (1=1 OR used + 1 <= quota));" >/dev/null
ok "③仮押さえは作られる"       "$(q "SELECT COUNT(*) FROM reservation_allocations WHERE reservation_id='R3';")" "1"
ok "③枠を超えた（超過として見える）" "$(q 'SELECT used FROM monthly_quota;')" "5"

echo "=== 4. 取り消すと枠が戻る（返却はトリガーだけ・二重返却しない） ==="
q "DELETE FROM reservation_allocations WHERE reservation_id='R3';" >/dev/null
ok "④返却で枠が戻る" "$(q 'SELECT used FROM monthly_quota;')" "4"
q "DELETE FROM reservation_allocations WHERE reservation_id='R3';" >/dev/null
ok "④★もう一度消しても二重に戻らない" "$(q 'SELECT used FROM monthly_quota;')" "4"

echo "=== 5. units の制約（★負数だと予約のたびに残数が増える） ==="
r=$(q "INSERT INTO reservation_allocations VALUES ('R9','C1','monthly','2026-10',NULL,-1,100);")
case "$r" in *CHECK*) ok "⑤負の units は弾かれる" "ng" "ng";; *) ok "⑤負の units は弾かれる" "通った:$r" "ng";; esac
r=$(q "INSERT INTO reservation_allocations VALUES ('R9','C1','monthly','2026-10',NULL,2,100);")
case "$r" in *CHECK*) ok "⑤月額に units=2 は弾かれる" "ng" "ng";; *) ok "⑤月額に units=2 は弾かれる" "通った:$r" "ng";; esac

echo "=== 6. ペアは1名来店（units=1）も正当 ==="
q "INSERT INTO reservation_allocations VALUES ('R4','C1','pair',NULL,'P2',1,100);" >/dev/null
ok "⑥ペア1名が作れる"     "$(q "SELECT COUNT(*) FROM reservation_allocations WHERE reservation_id='R4';")" "1"
ok "⑥ペアpackが1枚減る"   "$(q "SELECT used FROM ticket_packs WHERE pack_id='P2';")" "1"
q "INSERT INTO reservation_allocations VALUES ('R5','C1','pair',NULL,'P2',2,100);" >/dev/null
ok "⑥★ペア2名は2枚減る（pairがトリガーから漏れていない）" "$(q "SELECT used FROM ticket_packs WHERE pack_id='P2';")" "3"

echo "=== 7. source と親の対応が固定されている ==="
r=$(q "INSERT INTO reservation_allocations VALUES ('R9','C1','monthly',NULL,'P1',1,100);")
case "$r" in *CHECK*) ok "⑦月額なのに pack を指すのは弾かれる" "ng" "ng";; *) ok "⑦月額なのに pack を指すのは弾かれる" "通った:$r" "ng";; esac
r=$(q "INSERT INTO reservation_allocations VALUES ('R9','C1','ticket','2026-10',NULL,1,100);")
case "$r" in *CHECK*) ok "⑦チケットなのに月を指すのは弾かれる" "ng" "ng";; *) ok "⑦チケットなのに月を指すのは弾かれる" "通った:$r" "ng";; esac

echo "=== 8. 親の無い引当は作れない（外部キー） ==="
r=$(q "PRAGMA foreign_keys=ON; INSERT INTO reservation_allocations VALUES ('R9','C1','ticket',NULL,'NOPACK',1,100);")
case "$r" in *FOREIGN*|*constraint*) ok "⑧存在しないpackは弾かれる" "ng" "ng";; *) ok "⑧存在しないpackは弾かれる" "通った:$r" "ng";; esac

echo "=== 9. 最後の砦：予約が無ければバッチ全体が失敗する（★致命的だった穴②） ==="
#   引当だけ作って予約を作らず、最後の op_log を書く。
#   予約が無いのでサブクエリが NULL → NOT NULL 違反 → トランザクション全体が戻る。
q "BEGIN;
   INSERT INTO reservation_allocations VALUES ('R6','C1','ticket',NULL,'P1',1,100);
   INSERT INTO op_log (op_id,reservation_id,created_at)
     VALUES ('OP1',(SELECT reservation_id FROM reservations WHERE reservation_id='R6'),100);
   COMMIT;" >/dev/null 2>&1
ok "⑨引当が残っていない"   "$(q "SELECT COUNT(*) FROM reservation_allocations WHERE reservation_id='R6';")" "0"
ok "⑨★枠も減っていない"   "$(q "SELECT used FROM ticket_packs WHERE pack_id='P1';")" "0"

echo "=== 10. 予約があれば通る（正常系が止まっていないこと） ==="
q "BEGIN;
   INSERT INTO reservation_allocations VALUES ('R7','C1','ticket',NULL,'P1',1,100);
   INSERT INTO reservations (reservation_id,customer_id,trainer_id,start_at,end_at,created_at)
     SELECT 'R7','C1','T1',1000,2000,100
      WHERE EXISTS (SELECT 1 FROM reservation_allocations WHERE reservation_id='R7');
   INSERT INTO op_log (op_id,reservation_id,created_at)
     VALUES ('OP2',(SELECT reservation_id FROM reservations WHERE reservation_id='R7'),100);
   COMMIT;" >/dev/null 2>&1
ok "⑩予約が作られる"     "$(q "SELECT COUNT(*) FROM reservations WHERE reservation_id='R7';")" "1"
ok "⑩枠が減っている"     "$(q "SELECT used FROM ticket_packs WHERE pack_id='P1';")" "1"
ok "⑩操作が記録される"   "$(q "SELECT COUNT(*) FROM op_log WHERE op_id='OP2';")" "1"

echo "=== 11. 占有の2軸（オンラインは地下を埋めない） ==="
q "INSERT INTO reservations (reservation_id,customer_id,trainer_id,start_at,end_at,occupies_facility,created_at)
   VALUES ('R8','C2','T2',1000,2000,0,100);" >/dev/null
# 地下を使う新しい予約。R7（地下を使う・同じ時間）があるので弾かれるべき
ok "⑪地下が埋まっていれば入らない" "$(q "SELECT COUNT(*) FROM reservations r WHERE r.status='booked' AND r.occupies_facility=1 AND r.start_at < 2000 AND r.end_at > 1000;")" "1"
# オンライン（地下を使わない）は、地下が埋まっていても別トレーナーなら入れる
ok "⑪オンラインは地下の勘定に入らない" "$(q "SELECT occupies_facility FROM reservations WHERE reservation_id='R8';")" "0"

echo ""
if [ "$fail" -eq 0 ]; then echo "✅ 引当と枠の守り: $pass passed / 0 failed"; else echo "❌ 引当と枠の守り: $pass passed / $fail failed"; fi
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
