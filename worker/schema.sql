-- TOKOWAKA 予約・契約 D1 スキーマ
--   第1段階：D1は「写し」。真実はスプレッドシート（契約）とGoogleカレンダー（予約）。
--             GASが押し出し、Workerは読むだけ。synced_at で鮮度を持つ。
--   第2段階以降：契約はこのD1が真実になり、スプレッドシートへ書き出す向きが逆転する。
--
-- 適用: wrangler d1 execute tokowaka --remote --file=worker/schema.sql

-- ★外部キー制約は置かない（2026-09-28）
--   第1段階のD1は写しであり、真実はスプレッドシートとカレンダーにある。
--   元データに歯抜け（担当トレーナー未設定など）があっても、それを理由に
--   顧客や予約を丸ごと落としてはいけない。整合は元データ側で正す。

-- ============================================================
-- トレーナー
-- ============================================================
CREATE TABLE IF NOT EXISTS trainers (
  trainer_id    TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  name_en       TEXT,
  calendar_id   TEXT,                       -- Googleカレンダー（第2段階で使う）
  line_user_id  TEXT UNIQUE,                -- LIFFのID Tokenで照合する相手
  role          TEXT NOT NULL DEFAULT 'trainer',   -- trainer | owner
  active        INTEGER NOT NULL DEFAULT 1,
  hidden        INTEGER NOT NULL DEFAULT 0,        -- 顧客の担当選択に出さない（オーナー等）
  synced_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_trainers_line ON trainers(line_user_id);

-- ============================================================
-- 顧客マスタ
--   ※ 個人情報を持つ。Workerは役割を確かめた上でしか返さない（perms.js）。
-- ============================================================
CREATE TABLE IF NOT EXISTS customers (
  customer_id        TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  kana               TEXT,
  phone              TEXT,
  email              TEXT,
  birthday           TEXT,                  -- YYYY-MM-DD
  line_user_id       TEXT UNIQUE,
  default_trainer_id TEXT,
  contract_status    TEXT,                  -- 在籍 / 休会 / 退会
  contract_type      TEXT,                  -- 通常 / レンタル / モニター など
  lang               TEXT DEFAULT 'ja',
  goal               TEXT,
  note               TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  synced_at          INTEGER
);
CREATE INDEX IF NOT EXISTS idx_customers_line    ON customers(line_user_id);
CREATE INDEX IF NOT EXISTS idx_customers_trainer ON customers(default_trainer_id);
CREATE INDEX IF NOT EXISTS idx_customers_name    ON customers(name);

-- ============================================================
-- 契約（積み上げ式・上書きしない）
--   1行＝1つの契約期間。更新は必ず新しい行を足す。
--   過去の予約がどの契約で消化されたかが、後から契約を直しても変わらないようにするため。
-- ============================================================
CREATE TABLE IF NOT EXISTS contracts (
  contract_id    TEXT PRIMARY KEY,
  customer_id    TEXT NOT NULL,
  course         TEXT NOT NULL,             -- フルサポート / 通常 / レンタル / モニター
  mode           TEXT NOT NULL,             -- monthly | ticket
  freq           INTEGER,                   -- mode=monthly：月あたりの回数
  tickets        INTEGER,                   -- mode=ticket：枚数
  unit_price     INTEGER NOT NULL,          -- 1回あたりの単価（円・税込）
  monthly_price  INTEGER,                   -- mode=monthly：月額（表示・請求用）
  pair           INTEGER NOT NULL DEFAULT 0,
  rental         INTEGER NOT NULL DEFAULT 0,
  start_date     TEXT NOT NULL,             -- YYYY-MM-DD
  end_date       TEXT NOT NULL,             -- YYYY-MM-DD（必ず月末日。入力画面が保証する）
  carry_cap      INTEGER,                   -- 繰越上限。NULLなら頻度テーブル（LB_CARRY_CAP_TABLE）
  trainer_id     TEXT,
  reward_rate    INTEGER NOT NULL DEFAULT 35,
  join_fee       INTEGER NOT NULL DEFAULT 0,
  -- 承認フロー：粗利率が下限を割る条件はトレーナーが出してオーナーが承認する
  status         TEXT NOT NULL DEFAULT 'active',    -- active | pending_approval | rejected | ended
  created_by     TEXT NOT NULL,             -- trainer_id
  created_at     INTEGER NOT NULL,
  approved_by    TEXT,
  approved_at    INTEGER,
  source         TEXT NOT NULL DEFAULT 'console',   -- console | sheet（第1段階はsheet＝写し）
  sheet_row      INTEGER,                   -- 写しのとき、請求ブックの行番号
  synced_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_contracts_cust   ON contracts(customer_id, start_date);
CREATE INDEX IF NOT EXISTS idx_contracts_status ON contracts(status);

-- ============================================================
-- 予約
--   第1段階：カレンダーからの写し。第2段階でここが真実になる。
--   ★ consumption_* を予約行に持たせる＝「どの契約のどの枠で消化したか」を確定させる。
--     いまのGASは毎回計算し直すため、契約を後から直すと過去の予約の消化先が遡って変わる
--     （2026-09-26 Codexレビュー指摘②）。D1へ移す最大の設計上の利得がこれ。
-- ============================================================
CREATE TABLE IF NOT EXISTS reservations (
  reservation_id     TEXT PRIMARY KEY,
  customer_id        TEXT,                  -- 未紐付け（体験の飛び込み等）はNULL
  customer_name      TEXT,                  -- 未紐付けのときの表示名
  trainer_id         TEXT NOT NULL,
  start_at           INTEGER NOT NULL,      -- epoch ms
  end_at             INTEGER NOT NULL,
  kind               TEXT NOT NULL,         -- normal | trial | transfer | block
  book_type          TEXT,                  -- 台帳の「種別」そのまま（画面のラベル表示に使う）
  attendee_count     INTEGER NOT NULL DEFAULT 1,
  status             TEXT NOT NULL DEFAULT 'booked',   -- booked | cancelled | done
  -- 消化先の確定（第2段階で書き込む）
  consumption_kind   TEXT,                  -- monthly | ticket | transfer | none
  consumption_month  TEXT,                  -- YYYY-MM（monthlyのとき、どの月の枠か）
  consumption_contract_id TEXT,             -- どの契約行から引いたか
  calendar_event_id  TEXT,                  -- Googleカレンダー側のID（双方向同期の鍵）
  channel            TEXT,                  -- line | web | admin | salonboard
  created_by         TEXT,
  created_at         INTEGER NOT NULL,
  cancelled_at       INTEGER,
  synced_at          INTEGER
);
CREATE INDEX IF NOT EXISTS idx_resv_trainer ON reservations(trainer_id, start_at);
CREATE INDEX IF NOT EXISTS idx_resv_cust    ON reservations(customer_id, start_at);
CREATE INDEX IF NOT EXISTS idx_resv_cal     ON reservations(calendar_event_id);
CREATE INDEX IF NOT EXISTS idx_resv_start   ON reservations(start_at);

-- ============================================================
-- 固定枠（毎週この曜日・この時刻）
-- ============================================================
CREATE TABLE IF NOT EXISTS recurring_patterns (
  pattern_id   TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL,
  trainer_id   TEXT NOT NULL,
  weekday      INTEGER NOT NULL,            -- 0=日 〜 6=土
  time         TEXT NOT NULL,               -- HH:MM
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  synced_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_recur_cust ON recurring_patterns(customer_id);

-- ============================================================
-- InBody・体重（カルテ）
-- ============================================================
CREATE TABLE IF NOT EXISTS body_records (
  record_id     TEXT PRIMARY KEY,
  customer_id   TEXT NOT NULL,
  measured_at   INTEGER NOT NULL,
  weight_kg     REAL,
  body_fat_pct  REAL,
  muscle_kg     REAL,
  note          TEXT,
  created_at    INTEGER NOT NULL,
  synced_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_body_cust ON body_records(customer_id, measured_at);

-- ============================================================
-- 同期の記録（どこまで取り込んだか・鮮度の監視用）
-- ============================================================
CREATE TABLE IF NOT EXISTS sync_state (
  key         TEXT PRIMARY KEY,             -- contracts | reservations | customers | trainers
  synced_at   INTEGER NOT NULL,
  rows        INTEGER,
  ok          INTEGER NOT NULL DEFAULT 1,
  message     TEXT
);

-- ============================================================
-- 写しの置き場（GASが計算した結果をそのまま持つ）
--   2026-09-28：当初KVに置く設計だったが、KVの書き込みは1日1,000回までで
--   会員40名を15分ごとに更新すると超える。D1は1日10万回まで無料。
--   加えて、このD1はAPACにあるため日本からはKVより近い。
--   「一人ひとり違うものはD1」という当初の方針にも、こちらのほうが合う。
-- ============================================================

-- 残数（Allocate.js の計算結果）。第2段階で計算そのものをWorkerへ移したら不要になる。
CREATE TABLE IF NOT EXISTS member_home (
  customer_id  TEXT PRIMARY KEY,
  payload      TEXT NOT NULL,          -- _lbBuildHome の戻りをそのままJSONで
  computed_at  INTEGER NOT NULL,
  synced_at    INTEGER
);

-- 空き枠（吸着方式でGASが作ったもの）
CREATE TABLE IF NOT EXISTS slots_cache (
  trainer_id   TEXT PRIMARY KEY,
  payload      TEXT NOT NULL,          -- { slots: [...], rules: {...} }
  computed_at  INTEGER NOT NULL,
  synced_at    INTEGER
);

-- ============================================================
-- 残数計算のための「入力の写し」（2026-09-29）
--
--   ★列に変換して持たない。契約シートの行と予約台帳の行を、そのまま写す。
--     変換すると、そのたびに意味がずれる余地ができる（終了日の空欄・繰越率の列なし・
--     pack_idの有無など）。GASとWorkerで同じ関数に同じ形を渡せば、出力は必ず一致する。
--
--   ★チケットの束の見分け方が「契約シートの行順」に依存している。
--     行順（idx）を必ず保存し、同じ順で復元する。ここがずれると
--     どのチケットを何枚使ったかが入れ替わる。
-- ============================================================

-- 契約シートの行（そのまま）
CREATE TABLE IF NOT EXISTS calc_contract_rows (
  row_key      TEXT PRIMARY KEY,       -- customer_id + '#' + idx
  customer_id  TEXT NOT NULL,
  idx          INTEGER NOT NULL,       -- 契約シートの行順（チケットの見分けに使う）
  row_json     TEXT NOT NULL,          -- 行の値をそのまま
  start_ms     INTEGER,                -- 開始日（GASが解釈した結果）
  end_ms       INTEGER,                -- 契約終了日。空欄なら NULL（＝継続契約）
  synced_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ccr_cust ON calc_contract_rows(customer_id, idx);

-- 予約台帳の行（そのまま）
CREATE TABLE IF NOT EXISTS calc_reservation_rows (
  row_key      TEXT PRIMARY KEY,       -- 予約の識別子
  customer_id  TEXT,
  row_json     TEXT NOT NULL,
  synced_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_crr_cust ON calc_reservation_rows(customer_id);

-- 棚卸し（繰越の初期値）。39名中31名がこれに依存している。
--   契約は2026年3月から、予約台帳は2026年8月から。その間の消化を埋めている。
CREATE TABLE IF NOT EXISTS member_opening (
  customer_id  TEXT PRIMARY KEY,
  payload      TEXT NOT NULL,          -- _lbMemberOpeningWithFloor の戻りをそのまま
  synced_at    INTEGER
);

-- 契約シートの列の位置と、見出しの構成。
--   見出しが変わったら計算が変わるので、構成が変わったことに気づけるようにする。
CREATE TABLE IF NOT EXISTS calc_meta (
  key          TEXT PRIMARY KEY,       -- 'contract_cols' など
  payload      TEXT NOT NULL,
  synced_at    INTEGER
);

-- ============================================================
-- 作業の受け渡し（2026-09-29）
--
--   開発中、GASの点検を実行するのにオーナーの手を借りていた（1日20往復）。
--   GASに新しい公開入口を作ると、匿名で叩かれてGASの実行枠を食い潰され、
--   お客様の予約が止まりうる。そこで「GASから聞きに行く」形にする。
--
--   登録は合言葉が要る（GitHub Actionsが行う）。
--   結果を読むのは request_id を知っていることが鍵（長い乱数＝知らなければ読めない）。
--   ★結果に個人情報を入れない。読み取りに合言葉が要らないため。
-- ============================================================
CREATE TABLE IF NOT EXISTS jobs (
  request_id   TEXT PRIMARY KEY,       -- 長い乱数。これを知っていることが結果を読む鍵
  op           TEXT NOT NULL,          -- 実行する作業の名前（許可した名前だけ）
  args         TEXT,
  status       TEXT NOT NULL,          -- pending / running / done / failed
  enqueued_at  INTEGER NOT NULL,
  claimed_at   INTEGER,
  finished_at  INTEGER,
  result       TEXT,                   -- 個人情報を含まない要約
  error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, enqueued_at);

-- ============================================================
-- ① カレンダー → D1（2026-10-02・設計 ops/design/01-calendar-to-d1.md 第4版）
--
--   GASが1分ごとにカレンダー全量を読み、分類済みの形で /calsync へ押し出す。
--   Workerはカレンダーを読まない（組織ポリシーがサービスアカウントの鍵を禁じており、
--   ①は③が終われば消える仕組みなので、捨てるものに認証を作り込まない）。
--
--   ★タイトルは持たない。予約の予定には会員の氏名が入る。分類は押し出す前に済ませ、
--     結果（effect / reason）だけを残す（設計 §4）。
--   ★「2つの時刻」を混ぜない（設計 §4）。
--       calendar_active.checked_at … 正常に確認できた時刻。中身が変わらなくても毎回更新
--       calendar_snapshot.built_at … その世代を作り終えた時刻。世代を作った時だけ
--     鮮度は checked_at で見る。built_at で見ると、2分変更が無いだけでD1が使えなくなる。
-- ============================================================

-- 世代（4カレンダーまとめて1つ）
--   ★generation は AUTOINCREMENT で採る。MAX+1 だと押し出しが重なったときに衝突する。
CREATE TABLE IF NOT EXISTS calendar_snapshot (
  generation      INTEGER PRIMARY KEY AUTOINCREMENT,
  status          TEXT NOT NULL,          -- building / ready / rejected
  horizon_start   INTEGER NOT NULL,       -- 取得した範囲（半開区間 [start, end)）
  horizon_end     INTEGER NOT NULL,
  calendars       TEXT NOT NULL,          -- idと役割の対応（JSON・calendar_id順に正規化して入れる）
                                          -- [{"calendar_id":"...","role":"trainer","trainer_id":"B"}, ...]
                                          -- ★idの配列ではなく対応を持つ。短絡判定（§5）と
                                          --   可否判定（§7）の両方で「いまの構成と同じか」を比べるため
  rule_version    INTEGER NOT NULL,       -- 分類規則の版（読み取り側が今のコードと一致するか見る）
  flag_1f         TEXT NOT NULL,          -- 取得時の LB_1F_TRAINER_BLOCK（on / off）
  content_hash    TEXT NOT NULL,          -- GASが作る中身の印（SHA-256・16進小文字）
  owner_window    TEXT,                   -- 固定枠の持ち主（hidden なトレーナー）の曜日×時間帯（JSON文字列）
                                          --   {"1":{"from":17,"to":24},"6":"all"} ／ NULL＝制限なし
                                          -- ★これが無いと、固定枠の持ち主の枠が本来出ない曜日・
                                          --   時間帯にも出る。Worker側に設定が無かったため追加（2026-10-03）。
                                          -- ★NULL と '{}' は違う。NULL＝制限なし（全シフトが枠になる）、
                                          --   '{}'＝どの曜日にもルールが無い＝1枠も出さない。
                                          --   ここを混ぜると「出すべきでない枠が出る」側へ倒れる。
  reject_reasons  TEXT,                   -- 公開を止めた理由（JSON配列）。★氏名・タイトルは入れない
                                          --   設計 §6「落ちた世代も残す」を意味のあるものにするために置く
  warnings        TEXT,                   -- 公開はしたが知らせること（JSON配列・設計 §6 の警告）
  built_at        INTEGER NOT NULL,       -- この世代を作り終えた時刻
  created_at      INTEGER NOT NULL
);
-- 「公開中以外の ready を新しい順に残す」削除判定（§8）と、直前の ready 世代を引くため
CREATE INDEX IF NOT EXISTS idx_calsnap_status ON calendar_snapshot(status, generation);
-- rejected を24時間で、放置された building を期限で掃除するため（§8）
CREATE INDEX IF NOT EXISTS idx_calsnap_created ON calendar_snapshot(status, created_at);

-- 公開中の世代（1行だけ）
--   ここを差し替えることだけが「公開」。読み取りは必ずこの行から始める（§7）。
CREATE TABLE IF NOT EXISTS calendar_active (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  generation  INTEGER,
  checked_at  INTEGER
);
-- 1行を先に置く。無いと最初の公開が「条件付き更新」にできない。
INSERT OR IGNORE INTO calendar_active (id, generation, checked_at) VALUES (1, NULL, NULL);

-- 予定（分類の結果だけ。タイトルは持たない）
CREATE TABLE IF NOT EXISTS calendar_events (
  generation   INTEGER NOT NULL,
  calendar_id  TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  role         TEXT NOT NULL,          -- trainer / capacity_b1 / capacity_1f（calclass.js の CAL_ROLE）
  trainer_id   TEXT,                   -- role=trainer のときだけ入る
  effect       TEXT NOT NULL,          -- shift / busy / room_busy / ignore（calclass.js の EV_KIND）
  reason       TEXT NOT NULL,          -- shift / reserved / break / block / consumed / room / other
  start_at     INTEGER NOT NULL,       -- epoch ms
  end_at       INTEGER NOT NULL,
  all_day      INTEGER NOT NULL,
  PRIMARY KEY (generation, calendar_id, event_id)
);
-- トレーナー別に時間順で引く（空き枠の計算・出勤の有無の検査）
CREATE INDEX IF NOT EXISTS idx_calev_trainer ON calendar_events(generation, trainer_id, start_at);
-- 効果別に時間順で引く（shiftだけ／busyだけ／部屋の埋まりだけ）
CREATE INDEX IF NOT EXISTS idx_calev_effect  ON calendar_events(generation, effect, start_at);

-- GASの答えとD1の答えの突き合わせ（設計 §12）
--   ★氏名・タイトルは残さない。時間帯とトレーナーと世代だけ。
CREATE TABLE IF NOT EXISTS compare_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  generation  INTEGER,
  trainer_id  TEXT,
  kind        TEXT,                    -- slots など
  gas_count   INTEGER,
  d1_count    INTEGER,
  diff        TEXT,                    -- 食い違った時間帯だけ
  matched     INTEGER
);
-- 世代ごとの一致率を見るため
CREATE INDEX IF NOT EXISTS idx_cmplog_gen ON compare_log(generation, at);
-- 「連続7日間一致」を数えるため（①の完了条件）
CREATE INDEX IF NOT EXISTS idx_cmplog_at  ON compare_log(at);
