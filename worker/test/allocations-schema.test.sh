#!/bin/bash
# 引当と枠の守りが、本番と同じスキーマで効くことを確かめる
#
#   ★なぜ要るのか（2026-10-06）
#     設計のレビューで、残数まわりの穴が5回差し戻された。うち2つは致命的だった。
#       ① 残数0の顧客が通常の予約をすると超過が成立する
#       ② 予約できなかったのに残数だけ1回減る
#     どちらも「条件付きUPDATE/INSERT が0行を返してもSQLエラーにならない」ことが原因。
#     設計を直しただけでは、本当に守れているかは分からない。**動かして確かめる。**
#
#   ★最初に書いた版の誤り（記録として残す）
#     追加後の4列を最初から持つ簡易テーブルを作り、マイグレーションから
#     `ALTER TABLE` と部分索引を grep -v で除いて流していた。22件通ったが、
#     **本番でいちばん危ないところを一度も試していなかった**（Codex関門②）。
#     いまは schema.sql を流した本番相当のDBに、0009 を**無加工で**当てる。
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
# 外部キーは接続ごとに有効化が要る（PRAGMA はプロセスを跨がない）。
# D1 は既定で有効なので、ここでも毎回つけて本番に合わせる。
q() { sqlite3 "$DB" "PRAGMA foreign_keys=ON; $*" 2>&1; }

# ============================================================
# 0. 本番と同じ土台を作り、0009 を無加工で当てる
# ============================================================
out="$(sqlite3 "$DB" < "$ROOT/worker/schema.sql" 2>&1)"
ok "⓪schema.sql が流れる" "${out:-OK}" "OK"

# 既存の予約を1件入れておく（4列を足す前の、従来どおりの形）
sqlite3 "$DB" "INSERT INTO reservations
  (reservation_id, customer_id, trainer_id, start_at, end_at, kind, status, created_at)
  VALUES ('OLD1','C1','T1',1000,2000,'normal','booked',1);" >/dev/null 2>&1

# ★ここが本番そのもの。grep も除外もしない
out="$(sqlite3 "$DB" < "$ROOT/worker/migrations/0009_booking_allocations.sql" 2>&1)"
ok "⓪0009 を無加工で当てられる" "${out:-OK}" "OK"
out="$(sqlite3 "$DB" < "$ROOT/worker/migrations/0010_alloc_resv_month.sql" 2>&1)"
ok "⓪0010 を無加工で当てられる" "${out:-OK}" "OK"

ok "⓪4列が足された" \
  "$(q "SELECT COUNT(*) FROM pragma_table_info('reservations')
         WHERE name IN ('occupies_facility','occupies_trainer','consumes_quota','payment_status');")" "4"

echo "=== 0. 既存の予約が壊れていないこと ==="
ok "⓪既存行が残っている"   "$(q "SELECT COUNT(*) FROM reservations WHERE reservation_id='OLD1';")" "1"
ok "⓪既存行に既定値が入る" \
  "$(q "SELECT occupies_facility||'/'||occupies_trainer||'/'||consumes_quota||'/'||payment_status
          FROM reservations WHERE reservation_id='OLD1';")" "1/1/1/paid"

# 従来どおりの列指定INSERT（新しい4列を書かない）が、そのまま通ること
out="$(q "INSERT INTO reservations
  (reservation_id, customer_id, trainer_id, start_at, end_at, kind, status, created_at)
  VALUES ('OLD2','C1','T1',3000,4000,'normal','booked',1);")"
ok "⓪従来の形のINSERTが通る" "${out:-OK}" "OK"

echo "=== 0b. 索引とトリガーが作られていること ==="
ok "⓪部分索引が2本ある" \
  "$(q "SELECT COUNT(*) FROM sqlite_master WHERE type='index'
         AND name IN ('idx_resv_facility_window','idx_resv_trainer_window');")" "2"
ok "⓪トリガーが4本ある" \
  "$(q "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_alloc_%';")" "4"

echo "=== 0c. 二度当てるとどうなるか（既知の性質として固定する）==="
#   SQLite には ADD COLUMN IF NOT EXISTS が無い。既存の 0002〜0008 と同じく冪等ではない。
#   デプロイは schema_migrations で適用済みを判定して飛ばすが、
#   「DDLは通ったが記録の前に落ちた」ときは再実行で失敗する。性質として明示しておく。
out="$(sqlite3 "$DB" < "$ROOT/worker/migrations/0009_booking_allocations.sql" 2>&1)"
case "$out" in *duplicate*) ok "⓪二度目は duplicate column で止まる（冪等ではない）" "ng" "ng";;
  *) ok "⓪二度目は duplicate column で止まる（冪等ではない）" "通った:$out" "ng";; esac

# ---------- ここから、守りそのものの検査 ----------
q "INSERT INTO monthly_quota VALUES ('C1','2026-10',4,0,0);
   INSERT INTO ticket_packs  VALUES ('P1','C1','normal',2,0,0,99999999999,0);
   INSERT INTO ticket_packs  VALUES ('P2','C1','pair',  2,0,0,99999999999,0);" >/dev/null

echo "=== 1. 引当を作ると枠が減る（確保＝引当が同じ出来事） ==="
q "INSERT INTO reservation_allocations (reservation_id,customer_id,source,month_key,pack_id,units,decided_at) VALUES ('R1','C1','monthly','2026-10',NULL,1,100);" >/dev/null
ok "①引当で used が1になる" "$(q 'SELECT used FROM monthly_quota;')" "1"

echo "=== 2. 枠を使い切ったら引当が作れない（★致命的だった穴①） ==="
q "UPDATE monthly_quota SET used = 4;" >/dev/null
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
ok "③仮押さえは作られる"             "$(q "SELECT COUNT(*) FROM reservation_allocations WHERE reservation_id='R3';")" "1"
ok "③枠を超えた（超過として見える）" "$(q 'SELECT used FROM monthly_quota;')" "5"

echo "=== 4. 取り消すと枠が戻る（返却はトリガーだけ・二重返却しない） ==="
q "DELETE FROM reservation_allocations WHERE reservation_id='R3';" >/dev/null
ok "④返却で枠が戻る" "$(q 'SELECT used FROM monthly_quota;')" "4"
q "DELETE FROM reservation_allocations WHERE reservation_id='R3';" >/dev/null
ok "④★もう一度消しても二重に戻らない" "$(q 'SELECT used FROM monthly_quota;')" "4"

echo "=== 5. units の制約（★負数だと予約のたびに残数が増える） ==="
r=$(q "INSERT INTO reservation_allocations (reservation_id,customer_id,source,month_key,pack_id,units,decided_at) VALUES ('R9','C1','monthly','2026-10',NULL,-1,100);")
case "$r" in *CHECK*) ok "⑤負の units は弾かれる" "ng" "ng";; *) ok "⑤負の units は弾かれる" "通った:$r" "ng";; esac
r=$(q "INSERT INTO reservation_allocations (reservation_id,customer_id,source,month_key,pack_id,units,decided_at) VALUES ('R9','C1','monthly','2026-10',NULL,2,100);")
case "$r" in *CHECK*) ok "⑤月額に units=2 は弾かれる" "ng" "ng";; *) ok "⑤月額に units=2 は弾かれる" "通った:$r" "ng";; esac

echo "=== 6. ペアは1名来店（units=1）も正当 ==="
q "INSERT INTO reservation_allocations (reservation_id,customer_id,source,month_key,pack_id,units,decided_at) VALUES ('R4','C1','pair',NULL,'P2',1,100);" >/dev/null
ok "⑥ペア1名が作れる"   "$(q "SELECT COUNT(*) FROM reservation_allocations WHERE reservation_id='R4';")" "1"
ok "⑥ペアpackが1枚減る" "$(q "SELECT used FROM ticket_packs WHERE pack_id='P2';")" "1"
q "INSERT INTO reservation_allocations (reservation_id,customer_id,source,month_key,pack_id,units,decided_at) VALUES ('R5','C1','pair',NULL,'P2',2,100);" >/dev/null
ok "⑥★ペア2名は2枚減る（pairがトリガーから漏れていない）" "$(q "SELECT used FROM ticket_packs WHERE pack_id='P2';")" "3"

echo "=== 7. source と親の対応が固定されている ==="
r=$(q "INSERT INTO reservation_allocations (reservation_id,customer_id,source,month_key,pack_id,units,decided_at) VALUES ('R9','C1','monthly',NULL,'P1',1,100);")
case "$r" in *CHECK*) ok "⑦月額なのに pack を指すのは弾かれる" "ng" "ng";; *) ok "⑦月額なのに pack を指すのは弾かれる" "通った:$r" "ng";; esac
r=$(q "INSERT INTO reservation_allocations (reservation_id,customer_id,source,month_key,pack_id,units,decided_at) VALUES ('R9','C1','ticket','2026-10',NULL,1,100);")
case "$r" in *CHECK*) ok "⑦チケットなのに月を指すのは弾かれる" "ng" "ng";; *) ok "⑦チケットなのに月を指すのは弾かれる" "通った:$r" "ng";; esac

echo "=== 8. 親の無い引当は作れない（外部キー・D1は既定で有効） ==="
r=$(q "INSERT INTO reservation_allocations (reservation_id,customer_id,source,month_key,pack_id,units,decided_at) VALUES ('R9','C1','ticket',NULL,'NOPACK',1,100);")
case "$r" in *FOREIGN*|*constraint*) ok "⑧存在しないpackは弾かれる" "ng" "ng";; *) ok "⑧存在しないpackは弾かれる" "通った:$r" "ng";; esac
r=$(q "INSERT INTO reservation_allocations (reservation_id,customer_id,source,month_key,pack_id,units,decided_at) VALUES ('R9','C9','monthly','2099-01',NULL,1,100);")
case "$r" in *FOREIGN*|*constraint*) ok "⑧存在しない月額の枠も弾かれる" "ng" "ng";; *) ok "⑧存在しない月額の枠も弾かれる" "通った:$r" "ng";; esac

echo "=== 9. 最後の砦：予約が無ければバッチ全体が失敗する（★致命的だった穴②） ==="
q "BEGIN;
   INSERT INTO reservation_allocations (reservation_id,customer_id,source,month_key,pack_id,units,decided_at) VALUES ('R6','C1','ticket',NULL,'P1',1,100);
   INSERT INTO op_log (op_id,reservation_id,created_at)
     VALUES ('OP1',(SELECT reservation_id FROM reservations WHERE reservation_id='R6'),100);
   COMMIT;" >/dev/null 2>&1
ok "⑨引当が残っていない" "$(q "SELECT COUNT(*) FROM reservation_allocations WHERE reservation_id='R6';")" "0"
ok "⑨★枠も減っていない" "$(q "SELECT used FROM ticket_packs WHERE pack_id='P1';")" "0"

echo "=== 10. 予約があれば通る（正常系が止まっていないこと） ==="
q "BEGIN;
   INSERT INTO reservation_allocations (reservation_id,customer_id,source,month_key,pack_id,units,decided_at) VALUES ('R7','C1','ticket',NULL,'P1',1,100);
   INSERT INTO reservations (reservation_id,customer_id,trainer_id,start_at,end_at,kind,status,created_at)
     SELECT 'R7','C1','T1',5000,6000,'normal','booked',100
      WHERE EXISTS (SELECT 1 FROM reservation_allocations WHERE reservation_id='R7');
   INSERT INTO op_log (op_id,reservation_id,created_at)
     VALUES ('OP2',(SELECT reservation_id FROM reservations WHERE reservation_id='R7'),100);
   COMMIT;" >/dev/null 2>&1
ok "⑩予約が作られる"   "$(q "SELECT COUNT(*) FROM reservations WHERE reservation_id='R7';")" "1"
ok "⑩枠が減っている"   "$(q "SELECT used FROM ticket_packs WHERE pack_id='P1';")" "1"
ok "⑩操作が記録される" "$(q "SELECT COUNT(*) FROM op_log WHERE op_id='OP2';")" "1"

echo "=== 11. 占有の2軸（オンラインは地下を埋めない） ==="
q "INSERT INTO reservations (reservation_id,customer_id,trainer_id,start_at,end_at,kind,status,occupies_facility,created_at)
   VALUES ('R8','C2','T2',5000,6000,'normal','booked',0,100);" >/dev/null
ok "⑪同じ時間に地下を使う予約は1件だけ" \
  "$(q "SELECT COUNT(*) FROM reservations WHERE status='booked' AND occupies_facility=1 AND start_at < 6000 AND end_at > 5000;")" "1"
ok "⑪オンラインは地下の勘定に入らない" "$(q "SELECT occupies_facility FROM reservations WHERE reservation_id='R8';")" "0"
ok "⑪オンラインでもトレーナーは埋まる" "$(q "SELECT occupies_trainer FROM reservations WHERE reservation_id='R8';")" "1"

echo "=== 12. 引当を二度入れても used が二重に増えない（移行のやり直しに耐える） ==="
#   ★移行は何度も流し直す。INSERT OR IGNORE でなければ、流すたびに used が増えて残数が減る。
q "INSERT INTO monthly_quota VALUES ('C2','2026-11',4,0,0);" >/dev/null
q "INSERT OR IGNORE INTO reservation_allocations (reservation_id,customer_id,source,month_key,pack_id,units,decided_at) VALUES ('M1','C2','monthly','2026-11',NULL,1,100);" >/dev/null
ok "⑫1回目で used が1" "$(q "SELECT used FROM monthly_quota WHERE customer_id='C2';")" "1"
q "INSERT OR IGNORE INTO reservation_allocations (reservation_id,customer_id,source,month_key,pack_id,units,decided_at) VALUES ('M1','C2','monthly','2026-11',NULL,1,200);" >/dev/null
ok "⑫★2回目は何も起きない" "$(q "SELECT used FROM monthly_quota WHERE customer_id='C2';")" "1"
ok "⑫行も1件のまま" "$(q "SELECT COUNT(*) FROM reservation_allocations WHERE reservation_id='M1';")" "1"

echo "=== 13. 作り直すときは、消してから入れる（返却が正しく戻す） ==="
q "DELETE FROM reservation_allocations WHERE reservation_id='M1';" >/dev/null
ok "⑬消すと used が戻る" "$(q "SELECT used FROM monthly_quota WHERE customer_id='C2';")" "0"
q "INSERT OR IGNORE INTO reservation_allocations (reservation_id,customer_id,source,month_key,pack_id,units,decided_at) VALUES ('M1','C2','monthly','2026-11',NULL,1,300);" >/dev/null
ok "⑬入れ直すと used が1" "$(q "SELECT used FROM monthly_quota WHERE customer_id='C2';")" "1"

echo "=== 14. 振替は枠を減らさない ==="
q "INSERT OR IGNORE INTO reservation_allocations (reservation_id,customer_id,source,month_key,pack_id,units,decided_at) VALUES ('T1','C2','transfer',NULL,NULL,1,100);" >/dev/null
ok "⑭振替の引当は作れる" "$(q "SELECT COUNT(*) FROM reservation_allocations WHERE reservation_id='T1';")" "1"
ok "⑭★月額の枠は減らない" "$(q "SELECT used FROM monthly_quota WHERE customer_id='C2';")" "1"

echo "=== 15. ★流し直すと「正しくなる」こと（消してから入れる） ==="
#   INSERT OR IGNORE だけだと壊れはしないが正しくもならない。
#   契約を直して流し直したとき、消化先が月額→チケットに変わっても古い引当が残り、
#   枠は新しく used は古い、というちぐはぐな状態になる（Codex関門②の指摘）。
q "INSERT INTO monthly_quota VALUES ('C3','2026-12',2,0,0);
   INSERT INTO ticket_packs  VALUES ('P3','C3','normal',2,0,0,99999999999,0);" >/dev/null
# 1回目：月額から引く
q "DELETE FROM reservation_allocations WHERE customer_id='C3' AND reservation_id IN ('D1');
   INSERT OR IGNORE INTO reservation_allocations (reservation_id,customer_id,source,month_key,pack_id,units,decided_at) VALUES ('D1','C3','monthly','2026-12',NULL,1,100);" >/dev/null
ok "⑮1回目は月額が1" "$(q "SELECT used FROM monthly_quota WHERE customer_id='C3';")" "1"
ok "⑮チケットは0"    "$(q "SELECT used FROM ticket_packs WHERE pack_id='P3';")" "0"
# 2回目：同じ予約がチケットから引かれるように変わった（契約を直した等）
q "DELETE FROM reservation_allocations WHERE customer_id='C3' AND reservation_id IN ('D1');
   INSERT OR IGNORE INTO reservation_allocations (reservation_id,customer_id,source,month_key,pack_id,units,decided_at) VALUES ('D1','C3','ticket',NULL,'P3',1,200);" >/dev/null
ok "⑮★月額が0に戻る"      "$(q "SELECT used FROM monthly_quota WHERE customer_id='C3';")" "0"
ok "⑮★チケットが1になる"  "$(q "SELECT used FROM ticket_packs WHERE pack_id='P3';")" "1"
ok "⑮行は1件のまま"        "$(q "SELECT COUNT(*) FROM reservation_allocations WHERE reservation_id='D1';")" "1"

echo "=== 16. ★契約が減って超過に転じたら、古い引当が消えること ==="
#   前回は引当済み・今回は超過（unallocated）になった予約を消さないと、
#   used が過大なまま残り、残数が実際より少なく見えて予約できなくなる（Codex関門②）。
q "INSERT INTO monthly_quota VALUES ('C4','2026-12',2,0,0);" >/dev/null
q "INSERT OR IGNORE INTO reservation_allocations (reservation_id,customer_id,source,month_key,pack_id,units,decided_at) VALUES ('E1','C4','monthly','2026-12',NULL,1,100);
   INSERT OR IGNORE INTO reservation_allocations (reservation_id,customer_id,source,month_key,pack_id,units,decided_at) VALUES ('E2','C4','monthly','2026-12',NULL,1,100);" >/dev/null
ok "⑯2件ぶん使っている" "$(q "SELECT used FROM monthly_quota WHERE customer_id='C4';")" "2"
# 契約が減って枠が1になり、E2 が超過に転じた。見た予約は E1・E2 の両方。
q "UPDATE monthly_quota SET quota = 1 WHERE customer_id='C4';" >/dev/null
q "DELETE FROM reservation_allocations WHERE customer_id='C4' AND reservation_id IN ('E1','E2');
   INSERT OR IGNORE INTO reservation_allocations (reservation_id,customer_id,source,month_key,pack_id,units,decided_at) VALUES ('E1','C4','monthly','2026-12',NULL,1,200);" >/dev/null
ok "⑯★超過に転じた E2 の引当が消える" "$(q "SELECT COUNT(*) FROM reservation_allocations WHERE reservation_id='E2';")" "0"
ok "⑯★used が1に戻る（過大なまま残らない）" "$(q "SELECT used FROM monthly_quota WHERE customer_id='C4';")" "1"
ok "⑯E1 の引当は残る" "$(q "SELECT COUNT(*) FROM reservation_allocations WHERE reservation_id='E1';")" "1"

echo "=== 17. ★予約が消えた／期間外へ移ったときも used が戻ること（差分で消す） ==="
#   予約そのものが消えると、その予約IDは「今回見た」に現れない。
#   「見た予約を消す」方式だと古い引当が残り、used が過大なまま＝予約できなくなる。
#   期間で絞って、今回見なかったものを落とす（差分）。
q "INSERT INTO monthly_quota VALUES ('C5','2026-12',4,0,0);" >/dev/null
q "INSERT OR IGNORE INTO reservation_allocations
     (reservation_id,customer_id,source,month_key,pack_id,units,resv_month,decided_at)
   VALUES ('F1','C5','monthly','2026-12',NULL,1,'2026-12',100),
          ('F2','C5','monthly','2026-12',NULL,1,'2026-12',100);" >/dev/null
ok "⑰2件ぶん使っている" "$(q "SELECT used FROM monthly_quota WHERE customer_id='C5';")" "2"
# F2 の予約が削除された。今回見たのは F1 だけ。
q "DELETE FROM reservation_allocations
    WHERE customer_id='C5' AND resv_month >= '2026-12' AND resv_month <= '2026-12'
      AND reservation_id NOT IN ('F1');" >/dev/null
ok "⑰★消えた予約の引当が落ちる" "$(q "SELECT COUNT(*) FROM reservation_allocations WHERE reservation_id='F2';")" "0"
ok "⑰★used が1に戻る"           "$(q "SELECT used FROM monthly_quota WHERE customer_id='C5';")" "1"
ok "⑰残る予約の引当は保たれる"   "$(q "SELECT COUNT(*) FROM reservation_allocations WHERE reservation_id='F1';")" "1"

echo "=== 18. 期間の外の引当には触れないこと ==="
q "INSERT INTO monthly_quota VALUES ('C5','2026-09',4,0,0);" >/dev/null
q "INSERT OR IGNORE INTO reservation_allocations
     (reservation_id,customer_id,source,month_key,pack_id,units,resv_month,decided_at)
   VALUES ('G1','C5','monthly','2026-09',NULL,1,'2026-09',100);" >/dev/null
q "DELETE FROM reservation_allocations
    WHERE customer_id='C5' AND resv_month >= '2026-12' AND resv_month <= '2026-12'
      AND reservation_id NOT IN ('F1');" >/dev/null
ok "⑱★9月の引当は残る"       "$(q "SELECT COUNT(*) FROM reservation_allocations WHERE reservation_id='G1';")" "1"
ok "⑱9月の枠も減ったまま"     "$(q "SELECT used FROM monthly_quota WHERE customer_id='C5' AND month_key='2026-09';")" "1"

echo ""
if [ "$fail" -eq 0 ]; then echo "✅ 引当と枠の守り: $pass passed / 0 failed"; else echo "❌ 引当と枠の守り: $pass passed / $fail failed"; fi
exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
