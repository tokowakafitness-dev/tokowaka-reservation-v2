-- 設計44：会員画面で同意を求めて記録する（カルテの健康情報・写真／録音と AI）・2026-11-13
--   ★CREATE … IF NOT EXISTS だけ。ALTER しない（関門① 1周目 重大1）：
--     ALTER は成功した後に schema_migrations の記録だけ失敗すると、次の実行で duplicate column で止まる
--     （worker-deploy.yml は SQL と記録を別のコマンドで流す）。この形なら何度流しても同じ結果
--   ★健康情報のいまの同意は既存の karte_consent のまま（I48 の JOIN・見張りがそこを見る＝正本を移さない）

-- 録音・AI の同意の「いまの状態」（1会員1行）。karte_consent.kind は CHECK で 'health' しか入らない（0018 の教訓で作り直さない）
--   state は agreed/revoked だけ（declined＝「今回は同意しない」は回答の表にだけ置く）
CREATE TABLE IF NOT EXISTS karte_consent_rec (
  customer_id TEXT PRIMARY KEY,
  state       TEXT NOT NULL CHECK (state IN ('agreed', 'revoked')),
  changed_at  INTEGER NOT NULL,
  method      TEXT CHECK (method IN ('paper', 'line')),
  recorded_by TEXT NOT NULL,          -- '@member'（会員本人）か trainer_id
  doc_ver     TEXT                    -- 同意した文面の版（consent-docs.js の ver）。トレーナーの撤回は以前の版のまま
);

-- 会員が会員画面で答えた内容と版の履歴（追記だけ）。「誰がどの版に答えたか」の正本
--   answer：agreed（同意）・declined（今回は同意しない＝状態を変えない）・revoked（撤回）
--   ★中身（健康情報・氏名・LINE の ID）は持たない
CREATE TABLE IF NOT EXISTS karte_consent_answers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('health', 'rec_ai')),
  answer      TEXT NOT NULL CHECK (answer IN ('agreed', 'declined', 'revoked')),
  doc_ver     TEXT NOT NULL,
  at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_karte_consent_answers_cust ON karte_consent_answers (customer_id, kind, at);

-- 同意の状態の見張り（行は入らない・入ろうとしたら CHECK 違反で batch を巻き戻す）。
--   karte_guard の rev（rev 列の楽観ロック）と見分けるための専用の制約名（関門① 4周目 低1）
--   crate：会員の回答の回数の守り（直近10分の回答の行が上限を超える）を書き込みと同じ batch で判定する（関門② 中）
CREATE TABLE IF NOT EXISTS karte_consent_guard (
  cstate INTEGER CONSTRAINT KARTE_GUARD_CSTATE CHECK (cstate IS NULL),
  crate  INTEGER CONSTRAINT KARTE_GUARD_CRATE  CHECK (crate IS NULL)
);
